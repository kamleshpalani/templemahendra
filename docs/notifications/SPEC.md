# Notification System — Design and Build Contract

> **Change history.** Rewritten 2026-09-28 to describe the system as the code
> is today. Devotee accounts, the in-app bell, web push, OTP, devotee
> notification preferences and the devotee-facing `/api/notifications` API were
> retired with family registration (docs/registration/SPEC.md §1, §6;
> migration 009). The channels are now exactly **email, WhatsApp and SMS**,
> governed by the consent tick box on the registration form and an unsubscribe
> link in every update. This revision also adds the `contact.received` office
> event (migration 019) and the online-payment events, and lists the test
> suites that exist now. Where this document and the code disagree, the code
> wins; report the difference rather than silently renaming anything.

This document is the source of truth for the notification system: every shared
name, shape and rule is fixed here so that independently written pieces fit
together. If you find a contract here that cannot work, implement the closest
safe behaviour, keep the public shape, and **report the deviation** in your
final summary. Do not silently rename things.

- Data model: `database/migrations/007_notifications.sql` (tables),
  `009_family_registration.sql` (consent columns; retires in-app/push),
  `013_live_subscriptions.sql` (`live_reminders` category),
  `019_contact_notifications.sql` (`office` category)
- Provider contract: `backend/includes/notify/contracts.php`
- Family-registration rules the service follows: `docs/registration/SPEC.md` §6
- Test fixtures CLI: `tests/support/notify_fixtures.php`

---

## 1. Local environment (read before running anything)

| Thing | Where / how |
| --- | --- |
| MySQL 8.4 | Docker container `temple-mysql`, host port **3307**, db `templemahendra`, app user `temple/templepass`, root `root/rootpass`. Query: `docker exec temple-mysql mysql -uroot -prootpass templemahendra -e "…"`. Apply SQL with `--default-character-set=utf8mb4`. |
| PHP 8.3 CLI | `/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh` — exports the DB environment, passes other env through. Use it as `PHP_BIN` for test suites. |
| PHP dev server | `/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/serve.sh <port>` (run in the background). Inherits exported env, sets `TRUSTED_PROXIES=127.0.0.1,::1`, `SITE_URL=http://localhost:5173`. The built-in server is **single-threaded**; that is why each suite gets its own port. Code changes need no restart. |
| Vite | `http://localhost:5173` (IPv6 loopback — never use 127.0.0.1:5173). Proxies `/api`, `/admin`, `/uploads` to PHP on 8000. |
| Playwright + axe | `frontend/node_modules`; tests resolve them with `createRequire("../frontend/node_modules/playwright/index.js")` exactly as `tests/public-e2e.mjs` does. |
| Admin login | `admin` / `Admin@Test123` (owner, environment account). Create editor/viewer accounts for role tests via `/admin/users.php` or SQL into `admin_users` (bcrypt). |
| Design audit | `cd frontend && npm run audit` must report **0 actionable findings** if you touch `frontend/src` or `backend/admin`. |
| PHP lint | `php.sh -l <file>` on every PHP file you touch. |

### Ports

The notification suites use PHP 8010–8029 and the CLI (docs/registration/SPEC.md
§9): `notify-providers.mjs` takes 8020–8029 (8020 and 8028 PHP webhook servers,
8021 Meta, 8022 Twilio, 8023 MSG91, 8024 SMTP, 8029 deliberately closed);
`admin-notify-content.mjs` runs against 8025; `admin-notifications.mjs` against
8003; `notify-triggers.mjs` against 8002. Never stop 8000 (Vite's backend).

### Shared-machine rules

- **Rate limits are per IP.** Every test HTTP request sends a unique
  `X-Forwarded-For` for its suite (notifications use `10.81.0.<n>`; older
  suites keep their own ranges). Servers trust it because of `TRUSTED_PROXIES`.
  For Playwright use `browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": "…" } })`.
  Never run `DELETE FROM rate_limits` without a `WHERE bucket LIKE '%<your ip>%'`.
- **Create test registrations with the fixtures CLI**
  (`tests/support/notify_fixtures.php create-devotee`), not `/api/registrations`
  (the form is flood-limited per connection). `create-devotee` accepts
  `consent`, `unsubscribed`, `active` and `members`.
- **Test data prefixes**: emails `e2e-<suite>-<run>-…@example.test`; names and
  campaign names `E2E-<SUITE>-…`; dedupe keys `e2e:<suite>:…`. Every suite must
  be re-runnable and clean up after itself (`cleanup` removes registrations by
  name or email prefix and everything that cascades from them).
- **Scope worker runs to your own rows**: `notify_worker.php --notification-ids=1,2`
  or `--campaign-id=9`. Another suite's queue is not yours to drain.
- **Do not run `npm run build`** (dev servers read `frontend/`). To prove a
  production build compiles, use
  `npx vite build --outDir C:/Users/nithp/AppData/Local/Temp/claude/build-<you> --emptyOutDir`.
- Do not commit to git from an agent session.

---

## 2. Architecture

```
 module (registration, bookings, donations, payments, contact, admin)   admin campaign composer
            │  notifyEvent('booking.confirmed', …)                              │ notifyCampaignTransition()
            ▼                                                                    ▼
   ┌─────────────────────────── Notification Service (backend/includes/notify/) ───────────────┐
   │ events catalogue → template render (lang × channel) → recipient (registration or guest) → │
   │ channel policy (contact, provider, consent, SMS restraint) → notifications row (+dedupe)  │
   │ → notification_deliveries rows (queue);  sync=true: dispatch now inside the request        │
   └─────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                                 │ cron: php backend/bin/notify_worker.php (every minute)
                                                 ▼
   worker: lock → recover stale claims → expand due campaigns (batches) → reminders (bookings,
           event/pooja campaigns, live darshan) → claim due deliveries (priority order,
           per-channel throttle) → re-check consent → dispatch
                                                 │  NotifyProvider::send(NotifyMessage)
                              ┌──────────────────┼──────────────────┐
                            email             whatsapp             sms
                         (mailer.php)       (meta|twilio)     (twilio|msg91)
                                                 │
        provider status callbacks → /api/notify-webhook/<driver> → notifyApplyProviderUpdate()
        email opens / link clicks → /api/n/o|c/<token> ;  unsubscribe → /api/n/u/<token>
```

Hosting constraints that shaped this (Hostinger shared hosting):

- No daemons, no Redis, no WebSocket server. The queue is MySQL; the worker is a
  cron job (`* * * * *`), with an HTTP trigger (`/api/notify-cron`) for hosts
  without CLI cron. Each run has a time budget (default 50 s) so runs never
  overlap; a MySQL `GET_LOCK` makes overlap harmless anyway.
- Devotees do not sign in, so there is nothing to push to and no page to poll.
  The bell, web push and per-devotee settings were removed by migration 009:
  `inapp` and `push` survive only as enum values and history rows
  (`NOTIFY_RETIRED_CHANNELS`), labelled "In-app (retired)" / "Push (retired)"
  in the admin and never offered, sent or counted as live channels.
- Consent is one tick box on the registration form (`devotees.updates_consent_at`)
  that covers festival, pooja and temple announcements on every channel, and one
  unsubscribe link (`devotees.unsubscribed_at`) that withdraws it on every
  channel. Messages about a family's own booking or donation need no consent.

---

## 3. Conventions

- **UTC everywhere.** All notification `DATETIME`s are UTC, written explicitly
  with `UTC_TIMESTAMP()` or `notifyNow()`. APIs return ISO-8601 with `Z`
  (`notifyIso()`). The admin displays the temple timezone
  (`NOTIFY_TEMPLE_TZ`, default `Asia/Kolkata`, label it "IST" when it is).
- **Code style follows the codebase**: plain PHP functions with a `notify`
  prefix (no framework, no Composer), PDO prepared statements, early returns,
  comments that explain *why*. Admin pages use the shared `admin_layout.php`
  primitives and design tokens only.
- **Never break a user flow.** `notify()`/`notifyEvent()` must not throw into
  their callers: wrap, `error_log('[notify] …')`, and return a result that says
  what happened. A booking must save even if the notification tables are
  missing (`notifyTablesExist()` false → `['id' => null, 'skipped' => 'tables missing']`).
  Form and admin callers go through `devoteeNotifyEvent()` in
  `backend/includes/devotee_notify.php`, which loads the service lazily and
  returns `null` when it is unavailable.
- **Never store secrets in notifications.** A value that must never be stored
  goes in `secret_vars`, is rendered only at dispatch, and forces `sync => true`
  (§5.3). No built-in message uses one since sign-in was retired; the rule
  stays for any module that does. Provider responses are redacted (`notifyRedact`).
- **No PII in URLs.** Tracking and unsubscribe links carry opaque signed tokens
  (§5.10). The unsubscribe page shows a masked email or phone, never the full one.
- **Bilingual.** Tamil is the site default. Every built-in template ships `ta`
  and `en`; a registration's `devotees.lang` is `ta` or `en`; the architecture
  accepts any language code in `NOTIFY_LANGUAGES` for campaign translations.
- **No message points at an account.** Every `cta_path` and body links to a
  public page (`/`, `/contact`, `/sevas`, `/events`, `/panchangam`, a payment
  receipt or result page) or tells the family to call the temple office.

---

## 4. Statuses and their meaning

`notification_deliveries.status`:

| status | meaning | terminal |
| --- | --- | --- |
| queued | waiting for the worker (or for `next_attempt_at`) | no |
| sending | claimed by a worker run (`claim_token`, `claimed_at`) | no |
| sent | the provider accepted it | no |
| delivered | provider confirmed delivery (webhook) | no |
| read | opened / read (email pixel or tracked click, WhatsApp read receipt) | yes |
| failed | a retry is scheduled — **only while attempts < max_attempts** | no |
| rejected | permanent provider refusal, or a failure reported by webhook | yes |
| dead | retries exhausted (or interrupted on the last attempt); kept for the admin to requeue | yes |
| skipped | never attempted: no contact, not configured, no consent, unsubscribed, archived (`skip_reason`) | yes |
| cancelled | the campaign was cancelled before this was sent; also what migration 009 did to waiting in-app/push rows | yes |

Progression is monotonic: `queued < sending < sent < delivered < read`. A webhook
may only move a delivery forward; a late "failed" after "delivered" is recorded
as a delivery event but does not change the status. A webhook "failed" on a
`queued`/`sending`/`sent` delivery becomes `rejected`, not a retry: the
provider has already tried, and sending again could reach the devotee twice.

Every state change writes a `notification_delivery_events` row (`event` ≤ 24
chars: queued, skipped, claimed, sent, failed, dead, rejected, requeued, read,
clicked, webhook, cancelled).

Campaign statuses: `draft → review → approved → scheduled → sending → completed`,
plus `cancelled` and `failed`. See §5.8.

---

## 5. The service (backend/includes/notify/)

`backend/includes/notify.php` is the one file every caller requires. It loads
`notify/contracts.php` and every service file (and `includes/live.php`, whose
reminder step the worker runs). Requiring it must have no side effects beyond
defining functions (no session start, no output, no DB query).

| file | provides |
| --- | --- |
| `contracts.php` | `NOTIFY_CHANNELS`, `NOTIFY_RETIRED_CHANNELS`, priorities, `NotifyProvider`, `NotifyMessage`, `NotifyResult`, the driver registry, `notifyRedact`, `notifyHttp`, the log and test drivers |
| `defaults.php` | built-in wording (`notifyTemplateDefaults`), `notifyTempleFacts`, `notifyTemplateRegister` |
| `templates.php` | `notifyTemplate`, `notifyInterpolate`, `notifyRender`, `notifySmsInfo`, `notifyTemplateSample`, `notifyTemplateCacheClear` |
| `email.php` | `notifyEmailHtml`, `notifyEmailText` |
| `time.php` | `notifyTablesExist`, `notifyBool`, the UTC clock and test clock, time zones, `notifySecret`, `notifyLanguages`, `notifyPickLang`, `notification_kv` |
| `categories.php` | categories and their kinds, `notifyCategoryNeedsConsent` |
| `consent.php` | `notifyConsentState`, `notifyUnsubscribe`, `notifyMaskPhone` |
| `policy.php` | `notifyAllowedChannels`, `notifyChannelDecision`, `NOTIFY_CONSENT_REASONS` |
| `tracking.php` | signed tokens, `notifySafeCtaUrl`, `notifyAbsoluteUrl`, opens and clicks |
| `service.php` | `notify()`, `notifyCreate()`, recipient shapes |
| `events.php` | the event catalogue, `notifyEvent()` |
| `queue.php` | `notifyDispatchDelivery`, the worker, `notifyRequeue`, `notifyApplyProviderUpdate` |
| `audience.php` | campaign audiences as SQL |
| `campaigns.php` | campaigns, approval, expansion, previews, test sends, audit |
| `reminders.php` | evening-before reminders |
| `providers/*.php` | one class per driver, loaded on first use |

### 5.1 Time, secrets, languages, categories, consent

```php
function notifyTablesExist(): bool;   // cached per request; probes notification_categories, notification_kv
                                      // and devotees.lang/updates_consent_at/unsubscribed_at → false before 007 + 009
function notifyBool(mixed $v): ?bool; // true/false, 1/0, "1"/"0", "true"/"false", "on"/"off", "yes"/"no"; else null
function notifyNow(): string;                             // UTC 'Y-m-d H:i:s' (honours the worker's test clock)
function notifyNowPlus(int $seconds): string;
function notifyIso(?string $utc): ?string;                // 'Y-m-d\TH:i:s\Z' or null
function notifyIsTimezone(mixed $tz): bool;
function notifyTempleTz(): string;                        // NOTIFY_TEMPLE_TZ, default 'Asia/Kolkata'
function notifyToUtc(string $localWallClock, string $tz): string;   // throws InvalidArgumentException
function notifyFromUtc(string $utc, string $tz, string $format = 'Y-m-d H:i:s'): string;
function notifyCountryTimezones(): array;                 // ISO2 => zone
function notifyTimezoneFor(?array $prefs, ?string $countryIso2): string; // $prefs['timezone'] → country map → temple tz
                                                          // (registrations have no prefs: callers pass null)
function notifyKvGet(string $key): ?string;  function notifyKvSet(string $key, string $value): void;
function notifyKvAdd(string $key, string $value): string; // insert-if-absent, returns the winner
function notifySecret(): string;                          // NOTIFY_SECRET (≥32 chars) else generated once into notification_kv('secret')
function notifyLanguages(): array;                        // code => native label, from NOTIFY_LANGUAGES; ta and en always present
function notifyLangOrDefault(mixed $lang): string;        // an offered code, else 'ta'
function notifyPickLang(mixed $value, string $lang): ?string; // string, or per-language map → $lang, ta, en, then any

const NOTIFY_KINDS         = ['transactional', 'security', 'critical', 'informational', 'promotional'];
const NOTIFY_CONSENT_KINDS = ['informational', 'critical', 'promotional'];
function notifyCategories(bool $activeOnly = true): array; // key => row + ['consent' => bool], committee order
function notifyCategory(string $key): ?array;              // active or not (history still needs it)
function notifyCategoryKind(string $key): string;          // unknown key → 'informational' (needs consent: a mistake sends less)
function notifyCategoryNeedsConsent(string $key): bool;
function notifyCategoryLabel(string $key, string $lang): string;
function notifyCategoriesForget(): void;                   // the admin category editor calls it after a save

function notifyConsentState(int $devoteeId): ?array;
// ['consent','unsubscribed','consentAt','unsubscribedAt','email','phone','active'] or null
function notifyUnsubscribe(int $devoteeId): bool;          // sets unsubscribed_at = COALESCE(unsubscribed_at, now); idempotent
function notifyMaskPhone(?string $phone): string;          // "+91 ••••••3210"
```

Country → timezone map covers IN, LK, SG, MY, AE, SA, QA, KW, OM, BH, GB, IE,
DE, FR, NL, CH, US (America/New_York), CA (America/Toronto), AU
(Australia/Sydney), NZ, ZA, MU, FJ, JP, HK, NP, BD, PK, MV, MM, TH, ID, PH, CN,
KR, RE, SC, KE, TZ, IT, ES, BE, SE, NO, DK, GY, TT. Unknown → temple tz.

**Category kinds** decide whether consent is needed (docs/registration/SPEC.md §6):

| kind | consent | categories seeded |
| --- | --- | --- |
| transactional | none; an unsubscribe does not stop it | booking, donation, payment, membership, **office** (019) |
| informational | needs `updates_consent_at`, stopped by `unsubscribed_at` | general, announcement, festival, pooja, event, special_darshan, volunteer, administrative, **live_reminders** (013, `default_on` 0) |
| critical | same rule as informational | emergency |
| promotional | inactive since 009; reached anyway, treated as informational | promotional |
| security | inactive since 009; reached anyway, treated as transactional | security |

The committee edits labels, icon, order, `default_on` and `is_active` in the
admin (§8.3) and may add informational or promotional categories; kinds of
built-in categories are read-only.

### 5.2 Templates

Built-in defaults live in `notify/defaults.php`:

```php
function notifyTemplateDefaults(): array;     // built-in + runtime-registered
function notifyTemplateBuiltIn(): array;
function notifyTemplateRegister(string $key, array $definition): bool; // a module adds its own key; built-in keys cannot be replaced
// template_key => [
//   'category'    => 'booking',
//   'description' => 'Sent when the committee confirms a seva booking.',   // shown in the admin
//   'variables'   => ['devoteeName', 'bookingNumber', 'sevaName', 'bookingDate', 'ctaUrl'],
//   'cta_path'    => '/contact',                          // default CTA; may use {{vars}}
//   'langs' => [
//     'ta' => ['any' => ['title' => …, 'body' => …, 'cta_label' => …],
//              'sms' => ['title' => '', 'body' => …],      // channel overrides
//              'whatsapp' => ['title' => '', 'body' => …]],
//     'en' => [ … ],
//   ],
// ]

function notifyTempleFacts(): array;
// name, shortName, descriptor, address (ta/en), mapsUrl, phones, supportPhone(+Display), trust, taxNote,
// taxShort, registrationNo — copied from frontend/src/data/temple.js (PHP cannot read the JS module)

function notifyTemplate(string $key, string $lang, string $channel): ?array;
// Resolution order: DB (key, lang, channel) → DB (key, lang, 'any') → default (lang, channel) →
// default (lang, 'any') → the same four steps for 'ta' → then 'en'. A regional code (en-IN) tries
// its base language first. Returns ['title','body','cta_label','provider_template',
// 'provider_params'(names),'source'=>'db'|'default','lang'=>used,'channel'=>used] or null for an
// unknown key. A channel row without a cta_label borrows the shared version's label.

function notifyInterpolate(string $text, array $vars, bool $html = false): string;
// {{name}} → value. Unknown names render as ''. $html escapes values (never the template).
// Array/object values are ignored. No other syntax.

function notifyRender(string $key, string $lang, string $channel, array $vars): array;
// ['title'(≤200, one line),'body','cta_label'(≤80),'provider_template','provider_params'(ordered VALUES),
//  'missing'=>[names used by the template but absent from $vars],'lang','channel','source']
// Unknown key → every text '' and source null (a caller that forgot to check still sends nothing).

const NOTIFY_TEMPLATE_AUTO_VARS = ['templeName','templeShortName','templeAddress','mapsUrl','supportPhone','trustName','taxNote'];
// filled from notifyTempleFacts() in the template's language when absent; never reported missing.
// devoteeName, when absent, renders as "அன்பர்" / "devotee" but IS reported missing.

function notifyTemplateVarsUsed(string ...$texts): array;
function notifyTemplateCacheClear(): void;    // the admin editor and tests call it after writing rows
function notifySmsInfo(string $text): array;  // ['chars','segments','encoding' => 'GSM-7'|'UCS-2'] (160/153 or 70/67 per part)
function notifyTemplateSample(string $key, string $lang): array;  // realistic values for previews and tests

function notifyEmailHtml(array $p): string;
function notifyEmailText(array $p): string;
// $p keys: title, body (plain text; blank lines are paragraphs, single newlines <br>, URLs become links),
// lang, preheader, category_label, priority (urgent/emergency show a banner), cta_url, cta_label,
// details ([[label, value], …]), logo_url (default the site icon), contact (['phone','email','address'];
// default the temple office), unsubscribe_url (the "stop temple updates" link appears only when given),
// open_pixel_url, kind / category (choose the footer's "why you received this"), footer_note (replaces it).
// Table layout, inline styles, max-width 600, 16px body text, dark-mode-safe; renders in Gmail, Outlook, Apple Mail.
```

Template keys (all exist in defaults, `ta` and `en`, each with an `sms` override
that fits one GSM-7 segment in English with realistic values and a `whatsapp`
override with *bold* labels; `tests/notify-templates-unit.php` checks this):

| key | category | variables (beyond devoteeName, ctaUrl) | cta_path |
| --- | --- | --- | --- |
| registration_received | general | familyCount | / |
| booking_received | booking | bookingNumber, sevaName, bookingDate | /contact |
| booking_confirmed | booking | bookingNumber, sevaName, bookingDate | /contact |
| booking_modified | booking | bookingNumber, sevaName, bookingDate, changes | /contact |
| booking_cancelled | booking | bookingNumber, sevaName, bookingDate, reason | /sevas |
| booking_completed | booking | bookingNumber, sevaName | /sevas |
| booking_reminder | booking | bookingNumber, sevaName, bookingDate, templeAddress, mapsUrl | /contact |
| donation_received | donation | receiptNumber, donationAmount, donationPurpose | /contact |
| donation_receipt | donation | receiptNumber, donationAmount, donationPurpose, donationDate, trustName, taxNote | /contact |
| donation_paid | donation | receiptNumber, paymentReference, paymentAmount, paymentFor, paymentDate, paymentMode, trustName, taxNote | /payment/receipt |
| payment_success | payment | receiptNumber, paymentReference, paymentAmount, paymentFor, bookingDate, paymentDate, paymentMode | /payment/receipt |
| payment_failed | payment | paymentReference, paymentAmount, paymentFor, reason | /payment/result |
| payment_refund | payment | refundAmount, paymentReference, receiptNumber, refundReference, paymentFor | /payment/receipt |
| event_registered | event | eventName, eventDate, eventLocation | /events |
| event_cancelled | event | eventName, eventDate, reason | /events |
| event_reminder | event | eventName, eventDate, eventLocation | /events |
| festival_reminder | festival | eventName, eventDate, eventLocation | /events |
| pooja_reminder | pooja | poojaName, poojaDate, poojaTime | /panchangam |
| special_darshan | special_darshan | eventName, eventDate, eventLocation | /events |
| volunteer_registered | volunteer | opportunityName | /contact |
| volunteer_opportunity | volunteer | opportunityName, eventDate | /contact |
| membership_renewal | membership | membershipName, renewalDate | /contact |
| contact_received | office | senderName, senderPhone, message, receivedAt | /admin/contact_messages.php |
| announcement | announcement | headline, message | / |
| emergency | emergency | headline, message | /contact |
| campaign_generic | general (the campaign's wins) | title, message — the wrapper for free-text campaigns | / |

Amounts are written "Rs. 1,001", never "₹" (outside GSM-7). `templeName`,
`templeShortName`, `templeAddress`, `mapsUrl`, `supportPhone` ("+91 94430 02296"),
`trustName` and `taxNote` are filled automatically. The "stop updates" line on
WhatsApp/SMS and the email unsubscribe link are added at dispatch (§5.7), never
written into a template. The eight account-only keys (`welcome`,
`email_verification`, `email_verified`, `password_reset`, `password_changed`,
`profile_updated`, `phone_otp`, `phone_verified`) no longer exist; migration
009 deleted their DB overrides.

### 5.3 Creating a notification

```php
function notify(array $n): array;        // never throws
function notifyCreate(array $n): array;  // the same, throwing (used by the live module inside its own transaction)
```

Input (all keys optional unless stated):

| key | type | notes |
| --- | --- | --- |
| event | string | the automated event name, stored in `notifications.event` |
| template | string | template key; required unless `title`+`body` given; unknown → `skipped: unknown template` |
| vars | array | template variables (scalars; strings cut to 2000 chars); stored in `notifications.vars` |
| secret_vars | array | rendered only at dispatch, never stored (`vars._secret` lists the names); forces `sync` |
| title, body, cta_label | string or `['ta' => …, 'en' => …]` | free text (campaigns, live reminders); per-language maps pick the recipient language with `notifyPickLang` |
| devotee_id | int | a family registration; its email, phone, country, `lang`, consent and `is_active` are loaded |
| to_email, to_phone, name, lang | string | a guest, or an override for this send (a different email/phone than the registration's is stored on the row) |
| category | string | default: the template's category, else `general`; unknown → `general` |
| priority | string | `normal` (default), `important`, `urgent`, `emergency` |
| channels | string[] or CSV | subset of `NOTIFY_CHANNELS`; retired/unknown names are dropped; default `['email']`; none left → `skipped: no channels` |
| fallbacks | `['whatsapp' => 'sms']` | applied when a channel's provider is not configured (§5.4) |
| cta_url | string | passed through `notifySafeCtaUrl()`; default: template `cta_path` interpolated |
| image_url | string | site path or https URL (kept for campaigns; email only shows it) |
| details | `[[label, value], …]` | email details table (≤20 rows); stored in vars as `_details` |
| entity_type, entity_id | string `[a-z_]{1,32}`, int | what it is about |
| dedupe_key | string | **required for automated events**; >190 chars → head + sha1 |
| campaign_id, run_no | int | set by campaign expansion |
| deliver_after | UTC string | hold every delivery until then (`next_attempt_at`); ignored when in the past |
| sync | bool | dispatch now, inside this request (not when `deliver_after` is set) |
| actor | string | admin username, default `system` |
| title_prefix | string ≤20 | prepended on every channel ("[TEST] " for test sends) |
| `_recipient`, `_test`, `_campaign` | internal | a preloaded recipient row (expansion); an admin's typed address (§5.4); campaign flag |

Returns:

```php
[
  'id'         => ?int,        // null when deduped, skipped or the tables are missing
  'deduped'    => bool,        // a notification with this dedupe_key already exists (id = the existing one)
  'skipped'    => ?string,     // tables missing · unknown template · nothing to send · no channels · no such devotee ·
                               // registration archived · no recipient · invalid live reminder · live subscription unavailable · error
  'deliveries' => [ 'email' => ['id' => int, 'status' => 'queued'|'sent'|'skipped'|…,
                                'reason' => ?string, 'recordedOnly' => bool], … ],
]
```

Behaviour, in order:

1. Tables missing → `skipped: tables missing`. Unknown template, or neither a
   template nor a title+body → skipped.
2. Resolve the recipient. `devotee_id` → `notifyRecipientFromDevotee()`; a
   registration that does not exist → `no such devotee`; an **archived**
   registration (`is_active = 0`) receives nothing in a category that needs
   consent → `registration archived` (its own booking or donation message
   still goes). Otherwise the guest fields; neither an email nor a phone →
   `no recipient`. `name` and `lang` override what was loaded.
3. Sanitise vars, secrets, details; resolve the CTA (`cta_url`, else the
   template's `cta_path`).
4. Render the stored copy (title, body, cta label) in the recipient language for
   channel `any`; secrets render as `••••`. An empty title falls back to the
   category label.
5. Channel policy (§5.4) decides each requested channel (and fallbacks): one
   delivery per channel with status `queued` (`next_attempt_at` =
   `deliver_after`) or `skipped` + `skip_reason`; `max_attempts` email 5,
   whatsapp 5, sms 3; a delivery event is written for each.
6. Insert the notification and its deliveries in one transaction
   (`show_in_app` is always 0: the column belonged to the retired bell). A
   duplicate `dedupe_key` (MySQL 1062 on `uniq_dedupe`) returns
   `deduped => true` with the existing id and its deliveries. Never a second row.
7. `sync` (or `secret_vars` present) and no `deliver_after`: dispatch each
   queued delivery now via `notifyDispatchDelivery()`. A retryable failure of a
   send carrying secrets becomes `dead` ("security message not retried").

**Recipient shapes** (what the policy reads):

```php
function notifyRecipientFromDevotee(array|int $devotee): array;
// ['devotee_id','name','email' (may be null),'phone','country','lang' ('ta'|'en'),'timezone'
//  (notifyTimezoneFor(null, country)),'active' (is_active = 1),
//  'consent' (updates_consent_at IS NOT NULL AND unsubscribed_at IS NULL),'unsubscribed' (unsubscribed_at IS NOT NULL)]
// Accepts an id or a devotees row with those columns (campaign expansion passes rows for a whole batch).
// A missing registration comes back with devotee_id null and active false.

function notifyGuestRecipient(?string $email, ?string $phone, string $lang = 'ta'): array;
// devotee_id null, name '', timezone = temple tz, active true, consent false, unsubscribed false
// (+ 'test' => true when an admin typed the address for a test send)
```

### 5.4 Channel policy

```php
const NOTIFY_CONSENT_REASONS = ['no consent', 'unsubscribed'];   // re-checked at dispatch
function notifyAllowedChannels(array $requested, string $category, string $priority, array $recipient, bool $isCampaign, array $fallbacks = []): array;
// channel => ['status' => 'queued'|'skipped', 'reason' => ?string, 'fallbackFor' => channel (only on a fallback)]
function notifyChannelDecision(string $channel, string $category, string $priority, array $recipient, bool $isCampaign): array;
```

For each requested channel, the first rule that applies wins
(`$isCampaign` is passed by every caller but no rule depends on it: consent is
the same for an automated update and a committee broadcast):

1. **Only email, whatsapp, sms.** A retired or unknown channel is dropped
   before any rule is asked, so it never becomes a delivery row.
2. **Contact**: email needs a valid address → `no email`; whatsapp/sms need a
   phone of ≥7 digits → `no phone`.
3. **Provider**: `notifyProviderFor($channel)->isConfigured()` false →
   `not configured`. Then the event's fallback (e.g. `whatsapp → sms`) is
   decided by the same rules and added with `fallbackFor`, unless the fallback
   channel was requested in its own right (its own decision stands). The mailer
   provider is always configured (it logs when no transport is set), so in
   practice only WhatsApp and SMS fall back.
4. **Consent by category kind** (`notifyCategoryNeedsConsent`): transactional
   (booking, donation, payment, membership, office) needs none. Informational,
   critical and promotional need the recipient's `consent`; `unsubscribed` is
   checked first (`unsubscribed`), then missing consent (`no consent`). A guest
   never gave consent, so a guest never receives an update. The one exception:
   `recipient.test` (an admin's test send to an address they typed) bypasses
   this rule — they asked for it.
5. **SMS restraint**: `sms` with priority `normal` in an informational or
   promotional category → `sms reserved for important messages`.
6. Otherwise `queued`.

At dispatch (§5.7) the consent rules are applied again for a registered
recipient, so a family that unsubscribed while a campaign waited in the queue
is skipped with the consent reason; an archived registration is skipped for
updates; changed contact details are used as they are now.

### 5.5 Automated events

```php
function notifyEventCatalogue(): array;
// event => ['template','priority','channels','fallbacks','sync','dedupe' (pattern|null),'entity_type','description']
function notifyEventDedupeKey(string $pattern, array $ctx): ?string;   // null when a placeholder has no value
function notifyEvent(string $event, array $ctx): array;                // returns notify()'s result; never throws
```

`$ctx` carries the recipient (`devotee_id`, or `to_phone`/`to_email`/`name`/`lang`
for a booking, donation or office mailbox), `vars`, optional `secret_vars`,
`entity_id`, and any extras the dedupe pattern names (`donation.receipt`:
`sequence`). `notifyEvent` fills template, category (the template's), priority,
channels, fallbacks, sync, `entity_type` and `dedupe_key` from the catalogue;
`$ctx` may override `channels`, `priority` and `dedupe_key`, and passes
`cta_url`, `image_url`, `details`, `deliver_after` and `actor` through. A
dedupe pattern whose placeholder is missing from `$ctx` → `skipped: missing dedupe context`
(logged), never an un-deduplicated send. Unknown event → `skipped: unknown event`.

Dedupe placeholders: `{id}` devotee id · `{entity_id}` · `{vars.name}` ·
`{ctx.name}` · `{recipient}` = `d<devotee id>`, or `p<first 12 of sha1(phone digits)>`
/ `e<first 12 of sha1(email)>` for a guest.

| event | template | priority | channels | fallbacks | sync | dedupe_key | raised by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| registration.received | registration_received | important | email, whatsapp | whatsapp→sms | no | `devotee:{id}:registered` | `api/registrations.php`, only when consent was ticked |
| booking.received | booking_received | normal | email, whatsapp | — | no | `booking:{entity_id}:received` | `api/seva_bookings.php` |
| booking.confirmed | booking_confirmed | important | email, whatsapp | whatsapp→sms | no | `booking:{entity_id}:confirmed` | `admin/seva_bookings.php` (single and bulk) |
| booking.modified | booking_modified | important | email, whatsapp | — | no | `booking:{entity_id}:modified:{vars.bookingDate}` | **no caller yet** |
| booking.cancelled | booking_cancelled | important | email, whatsapp, sms | — | no | `booking:{entity_id}:cancelled` | `admin/seva_bookings.php` |
| booking.completed | booking_completed | normal | email, whatsapp | — | no | `booking:{entity_id}:completed` | `admin/seva_bookings.php` |
| booking.reminder | booking_reminder | important | whatsapp, email | whatsapp→sms | no | `booking:{entity_id}:reminder:{vars.bookingDate}` (the worker passes the ISO date) | `notify/reminders.php` |
| donation.received | donation_received | normal | email, whatsapp | — | no | `donation:{entity_id}:received` | `api/donations.php` |
| donation.receipt | donation_receipt | important | email, whatsapp | — | no | `donation:{entity_id}:receipt:{ctx.sequence}` | `admin/donations.php` "Send receipt" |
| donation.paid | donation_paid | important | email, whatsapp, sms | — | no | `donation:{vars.paymentReference}:paid` | `includes/payments/notify.php` (channels from Admin → Payment Gateway) |
| payment.succeeded | payment_success | important | email, whatsapp, sms | — | no | `payment:{vars.paymentReference}:success` | `includes/payments/notify.php` |
| payment.failed | payment_failed | important | email | — | no | `payment:{vars.paymentReference}:failed` | `includes/payments/notify.php` |
| payment.refunded | payment_refund | important | email, whatsapp, sms | — | no | `refund:{entity_id}:processed` | `includes/payments/notify.php` |
| event.registered | event_registered | normal | email, whatsapp | — | no | `event:{entity_id}:registered:{recipient}` | **no caller yet** |
| event.cancelled | event_cancelled | important | email, whatsapp, sms | — | no | `event:{entity_id}:cancelled:{recipient}` | **no caller yet** |
| volunteer.registered | volunteer_registered | normal | email | — | no | `volunteer:{entity_id}:{recipient}` | **no caller yet** |
| membership.renewal_due | membership_renewal | important | email, whatsapp | — | no | `membership:{entity_id}:renewal:{vars.renewalDate}` | **no caller yet** |
| contact.received | contact_received | important | email | — | no | `contact:{entity_id}:received:{recipient}` | `api/contact.php`, once per address in `CONTACT_NOTIFY_EMAIL` |

Notes:

- No event is `sync` and none carries `secret_vars` any more; both mechanisms
  remain in `notify()` for a future module.
- `registration.received` is `important` rather than `normal` so its SMS
  fallback is not held back by the SMS restraint. Its category, `general`, needs
  consent, which is why the caller raises it only when the box was ticked.
- The payment events are always raised for a guest recipient after the payments
  module's transaction commits, with the channels chosen in Admin → Payment
  Gateway (`docs/payments/SPEC.md` §6). `paymentReference` is the Donation or
  Booking ID, so a replayed gateway callback never sends twice; a receipt
  resend re-raises `donation.paid` / `payment.succeeded` with its own dedupe key.
- `contact.received` is the temple office's own copy of a website contact
  message: category `office` (transactional), so no consent is asked of the
  committee mailbox; written in `CONTACT_NOTIFY_LANG` (`ta`|`en`, default `en`);
  `senderPhone` is the international number with its plus; `receivedAt` is the
  temple-time stamp; the CTA is the admin Messages page.
- The retired account events (`account.*`, `security.*`, `phone.*`) are gone
  from the catalogue; a call with one of those names logs "unknown event" and
  sends nothing.
- Broadcast reminders (events, poojas) are not per-devotee events: the worker
  creates an automatic campaign for them (§5.9). Live darshan reminders are
  free-text notifications created by the live module (§5.9).

### 5.6 Consent (devotee preferences are retired)

There are no per-devotee preferences, muted categories, channel toggles,
languages or time zones any more (`devotee_notification_prefs` is legacy and
never read; `notifyPrefs`/`notifySavePrefs` do not exist). What a family can
decide is recorded on the registration itself (migration 009):

| column | meaning |
| --- | --- |
| `devotees.lang` | `ta` or `en`: the language every message to this family is written in |
| `devotees.updates_consent_at` | when the family agreed to temple updates (the tick box, or the committee recording it: `updates_consent_by`) |
| `devotees.unsubscribed_at` | when they withdrew it from a message link; wins over consent until the committee records consent again (which clears it) |

`notifyConsentState()`, `notifyUnsubscribe()` and the unsubscribe endpoint
(§6.1) are the whole API. One consent covers festival, pooja and temple
announcements on every channel; unsubscribing stops them on every channel;
booking and donation messages continue either way.

### 5.7 Queue, worker, dispatch

```php
function notifyDispatchDelivery(int $deliveryId, array $secretVars = []): array;
// Claims a queued|failed delivery (attempt counted), loads the notification and the recipient as they are
// NOW, re-checks consent, re-renders the channel variant, builds NotifyMessage, calls the provider, records
// the result. Returns ['status' => new status, 'reason' => ?string, 'recordedOnly' => bool,
// 'providerMessageId' => ?string]. A delivery already 'sending' → ['status' => 'sending', 'reason' => 'already being sent'].

function notifyWorkerRun(array $opts = []): array;
// opts: max_seconds (50, ≤600), batch (100, ≤1000), channels (default all three; [] processes none),
//       notification_ids (int[]; confines recovery and claims, skips campaigns and reminders; an empty
//       scope matches nothing), campaign_id (confines claims and expands only that campaign; skips reminders),
//       skip_campaigns, skip_reminders, expand_limit (devotees per campaign per run; 0 = budget),
//       trigger ('cli'|'http'), now (UTC string — tests only, honoured only when NOTIFY_ALLOW_TEST_DRIVER=1)
// Returns ['run_id','claimed','sent','failed','dead','rejected','skipped','campaigns_expanded',
//          'reminders_created','duration_ms','locked' (another run held the lock),'error' (?string)]
// Throws RuntimeException when the tables are missing.

function notifyRequeue(int $deliveryId, string $actor): bool;   // dead|failed|rejected → queued, attempts 0; refused for a secret-carrying message; audited
function notifyApplyProviderUpdate(string $provider, string $messageId, string $status, ?string $error = null, ?string $at = null): int;
function notifyRecordClick(int $deliveryId): void;              // clicked_at once; an email click also marks it read
function notifyRecordOpen(int $deliveryId): void;               // email only; read_at once (from sent|delivered)
function notifyBackoffSeconds(int $attempts, ?int $retryAfter = null): int;
function notifyRatePerMinute(string $channel): int;
function notifyStopUpdatesLine(string $lang, string $unsubscribeUrl): string;   // "To stop temple updates: <url>"
```

Worker run, in order:

1. `GET_LOCK('temple_notify_worker', 0)`; not obtained → `locked => true`.
2. Insert a `notification_worker_runs` row (`trigger` cli|http).
3. Recover stale claims: `sending` with `claimed_at` older than 10 minutes →
   `queued` (event `requeued`, "worker interrupted"), or `dead` when it was the
   last attempt.
4. Expand due campaigns (§5.8) unless `skip_campaigns` or id-scoped.
5. Reminders (§5.9) unless `skip_reminders` or scoped: at most once every 15
   minutes (`notification_kv('reminders_last_run')`; a test clock always runs
   them), then live darshan reminders (`liveQueueReminders()`).
6. Claim loop until the time budget ends. Per channel not over its throttle:
   ```sql
   UPDATE notification_deliveries
      SET status='sending', claim_token=:t, claimed_at=:now, attempts=attempts+1
    WHERE status IN ('queued','failed') AND channel=:c
      AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
      [AND notification_id IN (…)] [AND notification_id IN (SELECT id FROM notifications WHERE campaign_id = :c)]
    ORDER BY priority_rank, id LIMIT min(batch, room)
   ```
   then read rows by `claim_token` and dispatch each. Rows still unsent when
   the deadline arrives are handed back (`queued`/`failed`, attempt uncounted)
   rather than left `sending`. One row that throws goes through the normal retry path.
7. Finish the run row (counters, duration, last error). Each step's failure is
   recorded in `error` and does not stop the others.

Retries: a `retry` result → status `failed`, `next_attempt_at` = now +
max(provider `retryAfter`, backoff[attempts]) with backoff `[60, 300, 1800, 7200, 21600]`
seconds and ±10% jitter. When `attempts >= max_attempts` → `dead`.
`rejected` → `rejected`. `skipped` → `skipped`. A success is always recorded
even by a run whose claim was recovered (the message did go out).

Throttle per channel per minute (`NOTIFY_RATE_<CHANNEL>_PER_MIN`, defaults
email 60, whatsapp 80, sms 30): count deliveries of that channel with `sent_at`
in the last 60 s; stop claiming that channel for this run when reached.

**What dispatch adds to a message** (`notifyBuildMessage`):

- The CTA is the stored `cta_url` made absolute and **tracked**
  (`/api/n/c/<token>`); a link built from a secret is rebuilt from the template's
  `cta_path` and sent untracked.
- **Unsubscribe**: every message to a registered family in a kind that needs
  consent carries `notifyUnsubscribeUrl(devotee_id)`. Email: the footer link
  plus `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers (RFC 8058). SMS: the CTA link is added when the template did not
  include one and it does not push the message past two parts, then the
  stop-updates line. WhatsApp: a free-form message gets the stop-updates line;
  an approved provider template (sent by name with parameters) cannot have text
  appended, so **its registered wording must include the unsubscribe link**
  (the same for an MSG91 DLT template). Booking, donation and payment messages
  carry no unsubscribe (it would not stop them); guests have nothing to
  unsubscribe. Live reminders carry the live module's own unsubscribe link.
- **WhatsApp buttons**: a `url` button for an https CTA (label ≤20 chars,
  default "View details"), and a `call` button to the temple office for
  transactional and critical kinds.
- Email carries the open pixel, the category label, the priority banner and the
  footer's "why you received this" (an update: because the family agreed at
  registration; a booking/donation: about your own booking; live: you asked for it).

`backend/bin/notify_worker.php` (CLI only):

```
php backend/bin/notify_worker.php [--max-seconds=50] [--batch=100]
        [--channels=email,sms|none] [--notification-ids=1,2] [--campaign-id=9]
        [--skip-campaigns] [--skip-reminders] [--expand-limit=500]
        [--now="2026-09-13 12:00:00"] [--json]
```

Prints a one-line summary, or the result as JSON with `--json`. Exit 0 on a
completed run (including `locked`), 1 on an exception or a bad option.
Hostinger: hPanel → Advanced → Cron Jobs, "Custom", every minute,
`/usr/bin/php /home/<account>/domains/<site>/public_html/bin/notify_worker.php`.

HTTP trigger: `backend/api/notify_cron.php`, routed at `/api/notify-cron`
(GET or POST; 405 otherwise). Requires `NOTIFY_CRON_KEY` (≥24 chars) sent as
header `X-Cron-Key` (preferred) or `?key=`; compared with `hash_equals`. When
the variable is unset or too short the endpoint answers 404. Wrong keys are
rate-limited per address (30 per hour → 429) and logged; a wrong key → 403;
tables missing → 503 `notifications_disabled`. Runs
`notifyWorkerRun(['trigger' => 'http', 'max_seconds' => 25])` with
`ignore_user_abort` and returns the counters as JSON (500 `worker_failed` on an exception).

### 5.8 Campaigns

```php
function notifyCampaignSave(array $input, array $actor, ?int $id = null): array;
// actor: ['username' => …, 'role' => 'owner'|'editor'|'viewer']
// input: name (≤160), category, priority, channels[] (email|whatsapp|sms), cta_url, image_url, template_key,
//        template_vars, segment_id or audience (rules array/JSON), translations => [lang => ['title' ≤200,
//        'body' ≤20000, 'cta_label' ≤80]], schedule_tz ('temple'|'recipient'), scheduled_local ('Y-m-d H:i' or null),
//        recurrence (none|daily|weekly|monthly), recur_until
// Validates everything; at least one translation with title and body; channels non-empty; the category
// must exist and be active (or be the one already saved). The service accepts any kind; it is the admin
// composer that offers only active informational, promotional and critical categories and refuses
// transactional and security ones (§8.3). Saving a campaign in review/approved/scheduled returns it
// to draft (approval is void) — audited. Only draft/review/approved/scheduled campaigns are editable.
// Returns ['ok' => bool, 'id' => ?int, 'errors' => [field => message]]

function notifyCampaignLoad(int $id): ?array;   // row + 'translations' + 'rules' (segment's or own) + 'segment' + 'channelsList' + 'templateVars'
function notifyCampaignGet(int $id): ?array;    // notifyCampaignLoad() + 'stats'
function notifyCampaignStats(int $id): array;
// ['recipients','byChannel' => [channel => [status => count]],'opened','clicked','failed','dead',
//  'skippedConsent' (skipped for "no consent" or "unsubscribed")]

function notifyCampaignNeedsApproval(array $campaign, int $estimate): ?string;
// Returns the reason, or null when no second approval is needed:
//   estimate > NOTIFY_APPROVAL_THRESHOLD (default 50)  → "Reaches N families"
//   priority urgent or emergency                       → "Urgent/emergency priority"
//   channels include whatsapp or sms and estimate > 10 → "Paid channels to N families"
//   category kind promotional                          → "Promotional message"

function notifyCampaignReach(array $c): array;     // [estimate, ?"nobody" sentence] — counts consenting families for an update
function notifyCampaignProblem(array $c): ?string; // what stops it being sent (no words, no channel, lost segment, bad rules, lost category)
function notifyCampaignTransition(int $id, string $action, array $actor, array $opts = []): array;
// Returns ['ok' => bool, 'status' => new status, 'message' => human text, 'id' => ?int (duplicate)]
function notifyAudit(?int $campaignId, string $action, array $actor, array $detail = []): void;  // never throws
```

| action | from | to | who (capability) | notes |
| --- | --- | --- | --- | --- |
| submit | draft | review, or approved when no approval is needed | notifications.compose | estimates now (consenting families only for an update; "nobody" refuses); stores estimated_count, requires_approval, approval_reason. Auto-approval is audited as approved by `system` with the reason "below approval threshold". |
| approve | review | approved | notifications.approve | approver ≠ created_by, unless `NOTIFY_ALLOW_SELF_APPROVAL=1` or no other active owner exists |
| reject | review | draft | notifications.approve | `opts['reason']` required |
| schedule | approved | scheduled | notifications.compose | `opts['scheduled_local']`/`schedule_tz` or the saved ones; must be in the future (recipient mode: the earliest zone, 14 h before the wall clock); sets scheduled_at / next_run_at |
| send_now | approved | sending | notifications.compose | next_run_at = now; refused for a repeating campaign (use schedule) |
| emergency_send | draft, review, approved | sending | notifications.approve | priority must be emergency; `opts['reason']` required; drops recurrence; audited `emergency_override` |
| cancel | draft, review, approved, scheduled, sending | cancelled | compose (own drafts) / approve (others') | queued/failed deliveries of this campaign → cancelled (with an event each) |
| duplicate | any | new draft | notifications.compose | copies translations/audience/channels/image; name + " (copy)"; no schedule; drops `reminderKey` |

Every transition writes `notification_audit` with the campaign snapshot.

Expansion (worker): a campaign is due when status is `approved`/`scheduled`
with `next_run_at <= now` (recipient-timezone campaigns: `next_run_at - 14h`),
or `sending`. Mark `sending`, set `started_at` on the first batch; an
**automatic reminder** whose `reminderKey` date is today or earlier is
cancelled instead ("approved on or after the day it is about"); rules that no
longer validate or a category that no longer exists → status `failed` with
`last_error`. Then for families in the audience with `id > expand_cursor`, in
batches of 500 within the time budget (and `expand_limit`): resolve the
translation per recipient language and call `notify()` with `campaign_id`,
`run_no = run_count + 1`, `dedupe_key = "campaign:{id}:{run}:{devotee_id}"`,
and for recipient mode `deliver_after` = the scheduled wall-clock time in that
family's timezone converted to UTC. Advance `expand_cursor` (saved every 100
rows); a cancellation between batches stops at once. When no family remains:
`run_count++`, `recipient_count`, `expand_cursor = 0`; if recurrence and the
next occurrence ≤ `recur_until` → status `scheduled` with the next
`next_run_at` (occurrences missed while the worker was down are skipped, not
sent in a burst), else mark `completed` once no delivery of the campaign is
`queued`/`sending`/`failed` (checked on later runs).

Recurrence (`notifyNextOccurrence`): daily +1 day, weekly +7 days, monthly the
same day next month clamped to the month's last day and anchored to the
original day (31 Jan → 28 Feb → 31 Mar), computed on the wall clock in the
schedule's timezone.

```php
function notifyCampaignPreview(array $campaign, string $channel, string $lang, ?int $sampleDevoteeId = null): array;
// ['title','body','html'(email only),'cta_label','cta_url','provider_template','params',
//  'sms' => ['chars','segments','encoding'] (sms only),'missing' => []]
// $campaign is a notifyCampaignGet() row or unsaved input in the same shape. An update shows the
// unsubscribe link / stop-updates line exactly where dispatch puts it, using notifyPreviewUnsubscribeUrl()
// (a token that verifies for nobody).

function notifyCampaignTestSend(int $id, array $actor, array $to): array;
// to: ['email' => ?, 'phone' => ?, 'devotee_id' => ?, 'lang' => ?]. Sends the campaign as it stands to that one
// recipient now (sync), whatever its state and audience, with the title prefixed "[TEST] ". Channel rules
// still apply, except that an address the admin typed counts as consenting ('_test'); a devotee_id keeps
// that family's real consent. dedupe_key "test:{campaign}:{sha1(to+lang)}:{minute}". Audited test_sent
// with the address masked. Returns ['ok','message','id','deduped','deliveries'].
```

### 5.9 Reminders (worker)

- **Booking reminders**: `seva_bookings` with `status = 'confirmed'` and
  `preferred_date` = tomorrow in the temple timezone, once the temple-time clock
  is past 17:00 → `notifyEvent('booking.reminder', …)` to the **phone on the
  booking** (ten Indian digits from before migration 004 get `91`), in the
  booking's own `lang`, with `bookingNumber` (`B-000091`, identical to
  `devoteeBookingNumber()`), the seva name in that language, the worded date,
  and `dedupe_key = booking:<id>:reminder:<ISO date>`. Bookings are not linked
  to registrations, so no consent is involved (transactional).
- **Event and pooja reminders**: `events` (`is_active = 1`, `event_date` =
  tomorrow) and `poojas` (`is_active = 1`, `pooja_date` = tomorrow), after 17:00
  temple time → one automatic campaign each: name
  `Reminder: <title> (automatic)`, `created_by = 'system'`, **status `review`**
  with `requires_approval = 1` and the reason "Automatic reminder by email and
  WhatsApp: approve it this evening so it goes out before <date>", channels
  `email,whatsapp`, priority `normal`, category `event` / `pooja`, template
  `event_reminder` / `pooja_reminder`, `cta_url` `/events`, audience
  `{"mode":"rules","match":"all","rules":[{"field":"consent","op":"is","value":true}]}`,
  `template_vars` with per-language `eventName`/`eventDate`/`eventLocation` (or
  `poojaName`/`poojaDate`/`poojaTime`) and `"reminderKey": "event:<id>:<date>"`.
  Before creating, check no campaign has that `reminderKey`
  (`JSON_UNQUOTE(JSON_EXTRACT(template_vars, '$.reminderKey'))`). Once approved,
  expansion handles scale exactly as for a committee campaign; approved on or
  after the day itself, it is cancelled (§5.8).
- **Live darshan reminders** (`backend/includes/live/subscriptions.php`,
  `liveQueueReminders()`): for each `live_stream_subscriptions` row whose stream
  starts within −15/+10 minutes, not yet reminded for that start, one free-text
  `notifyCreate()` with `event = 'live.reminder'`, category `live_reminders`,
  channel `email`, `entity_type = 'live_subscription'`, dedupe
  `live-reminder:<subscription>:<start>`. `notify()` and dispatch resolve the
  recipient through `liveSubscriptionRecipient()` (consent = the "Notify me"
  tick box on the stream page; null once the stream is cancelled, deleted or
  unsubscribed) and use the live module's own unsubscribe URL
  (`/api/live-subscriptions/unsubscribe?token=…`). See `docs/live/`.

### 5.10 Tracking, unsubscribe, CTA safety

```php
const NOTIFY_TOKEN_KINDS = ['c', 'o', 'u'];
function notifyToken(string $kind, int $id): string;       // 'c' click (delivery id), 'o' open (delivery id), 'u' unsubscribe (devotee id)
function notifyTokenVerify(string $token): ?array;         // ['kind' => …, 'id' => int] or null (only the canonical form verifies)
function notifyTrackedUrl(int $deliveryId, ?string $target): ?string;   // siteUrl('/api/n/c/<token>'), or null when no target
function notifyOpenPixelUrl(int $deliveryId): string;      // siteUrl('/api/n/o/<token>')
function notifyUnsubscribeUrl(int $devoteeId): string;     // siteUrl('/api/n/u/<token>')
function notifySafeCtaUrl(?string $url): ?string;          // '/path…' (not '//') or 'https://host…' without credentials; anything else null, never "repaired"
function notifyAbsoluteUrl(?string $url): ?string;         // a safe link made absolute with siteUrl()
function notifyMarkDeliveryRead(int $deliveryId, string $at, string $detail): bool;  // sent|delivered → read, once
```

`notifyPreferencesUrl()` no longer exists: there is no settings page to link to.

Token format: `<kind><id>.<sig>` where `sig` = base64url of the first 12 bytes
of `HMAC-SHA256(kind . id, notifySecret())`. Regex:
`^[cou][0-9]{1,10}\.[A-Za-z0-9_-]{16}$`. Tokens do not expire; rotating
`NOTIFY_SECRET` invalidates them all.

Email deliveries to registered families in categories that need consent carry
the unsubscribe link and the `List-Unsubscribe` / `List-Unsubscribe-Post`
headers; WhatsApp and SMS carry the stop-updates line (§5.7). Transactional
messages carry neither.

### 5.11 Audience

```php
const NOTIFY_AUDIENCE_MAX_SELECTED = 5000;  const NOTIFY_AUDIENCE_MAX_RULES = 50;
const NOTIFY_AUDIENCE_CONSENT_SQL  = 'd.updates_consent_at IS NOT NULL AND d.unsubscribed_at IS NULL';
const NOTIFY_AUDIENCE_RETIRED_FIELDS = ['email_verified','phone_verified','last_login_days','channel_enabled','category_not_muted'] (with labels);

function notifyAudienceFields(): array;                    // for UI builders, see below
function notifyAudienceFieldOps(): array;
function notifyAudienceRetiredFieldsIn(mixed $rules): array;   // field => label; never throws. Meant for the admin to flag
                                                               // stored rules; nothing calls it yet — normalisation refuses
                                                               // such rules with a sentence naming the field instead
function notifyAudienceNormalize(array|string $rules): array;  // throws InvalidArgumentException(sentence); a retired field names itself
function notifyAudienceNeedsConsent(?string $category): bool;
function notifyAudienceWhere(array|string $rules, ?string $category = null): array;   // ['sql','params']
function notifyAudienceQuery(array|string $rules, ?string $category = null): array;   // ['sql' => 'SELECT d.id FROM devotees d … ORDER BY d.id', 'params']
function notifyAudienceCount(array|string $rules, ?string $category = null): int;
function notifyAudienceBreakdown(array|string $rules): array;  // ['all' => active matches, 'consenting' => of those, agreed and not unsubscribed]
function notifyAudienceBatch(array|string $rules, int $afterId, int $limit, ?string $category = null): array;  // ids
```

Rules JSON:

```json
{
  "mode": "all_devotees" | "selected" | "rules",
  "devotee_ids": [12, 40],
  "match": "all" | "any",
  "rules": [ { "field": "country", "op": "in", "value": ["IN", "SG"] } ]
}
```

Every query excludes `is_active = 0`. When `$category` needs consent
(informational, critical, promotional) the query also requires
`NOTIFY_AUDIENCE_CONSENT_SQL`, so estimates, the approval threshold and
"families reached" are honest and no skipped notification is written for a
family that never said yes. `selected` is capped at 5000 ids.

| field | ops | value |
| --- | --- | --- |
| country | in, not_in | ISO2[] |
| state | in, not_in | string[] (as stored, e.g. "TN") |
| city | contains, equals | string (case-insensitive) |
| lang | in | `ta`, `en` (from `devotees.lang`) |
| consent | is | bool (agreed and not unsubscribed) |
| has_email | is | bool |
| has_phone | is | bool |
| family_size | gte, lte | int (1 + member count, ≤100) |
| registered_days | lte, gte | int (days since created_at) |
| has_booking | is | bool |
| booked_seva | in | seva ids |
| booking_status | in | pending, confirmed, completed, cancelled |
| booking_days | lte | int (a booking created within N days) |
| has_donated | is | bool |
| donated_total | gte, lte | number (sum of donations.amount) |
| donated_days | lte | int |
| tag | in, not_in | tag strings |

`notifyAudienceFields()` returns `field => ['label' => …, 'ops' => […], 'type' => 'iso2list'|'strlist'|'string'|'bool'|'int'|'number'|'idlist'|'enum', 'options' => [...]|null]`
where `options` are filled for `lang`, `booking_status`, `booked_seva` (from
`sevas`) and `tag` (distinct tags in use).

Groups named in the brief map onto this: all families → `all_devotees`;
individual/selected → `selected`; donors → `has_donated`; booking customers →
`has_booking`; volunteers, members, interests, devotee categories, event
participants → `tag` (committee applies tags in the admin); geography →
country/state/city; language → lang; agreed to updates → `consent`.

### 5.12 Retired: devices, OTP, push, preferences

Removed with devotee sign-in (docs/registration/SPEC.md §6): `prefs.php`,
`otp.php`, `devices.php`, `NotifyWebPushProvider`, `NotifyFcmProvider`,
`NotifyEcKeys`, their registry entries, and `notify_keys.php`'s
`vapid`/`fcm` commands. `notifyRegisterDevice`, `notifyRemoveDevice`,
`notifyVapidPublicKey`, `notifyOtpIssue`, `notifyOtpVerify`, `notifyPrefs`
and `notifySavePrefs` do not exist. The tables `devotee_devices`,
`devotee_otps`, `devotee_notification_prefs` and `devotee_tokens` remain in
the schema, unread, until a later migration drops them; migration 009 deleted
the `vapid_public`, `vapid_private` and `fcm_token` rows from `notification_kv`.

---

## 6. HTTP API

The devotee-facing `/api/notifications/*` API (list, unread, prefs, read,
archive, devices, …) and the `/api/account/phone-verify-*` additions were
removed with devotee accounts; no page calls them. What remains are the links
inside messages, the provider callbacks and the cron trigger. `n.php` and
`notify_webhook.php` answer HTML/GIF/provider bodies, so they set their own
`Content-Type` and do not rely on the JSON exception handler.

### 6.1 `backend/api/n.php` — tracking and unsubscribe

Routed by `api/index.php` for `/api/n/<kind>/<token>` with `$trackKind` and
`$trackToken` (kind `c|o|u`, token per §5.10 — the route regex checks the
shape; anything else under `/n/` is 404). Every response sends
`X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and
`X-Content-Type-Options: nosniff`. A token is accepted only for the kind it was
issued for.

- `GET /api/n/c/<token>` → `notifyRecordClick`, `302` to the notification's CTA
  (re-checked with `notifySafeCtaUrl`; relative paths via `siteUrl()`); invalid
  token or no CTA → `302 siteUrl('/')`. `HEAD` redirects without recording
  (link checkers). Other methods → 405.
- `GET /api/n/o/<token>` → `notifyRecordOpen`, `200 image/gif` 1×1,
  `Cache-Control: no-store, private, max-age=0`. Invalid tokens still get the
  GIF (a different answer would tell a prober which tokens are real).
- `GET /api/n/u/<token>` → a small bilingual HTML page (site colours, inline
  CSS, no JS, strict CSP) showing the registration's masked email (or masked
  phone when it has no email), what stops and what continues, a POST button,
  and the temple office's phone instead of any settings link. **GET never
  changes anything** (mail scanners follow links). Already unsubscribed →
  the "already stopped" page; invalid token or a deleted/merged registration →
  404 page; tables missing → 503 page.
- `POST /api/n/u/<token>` (the form button, or an RFC 8058 one-click body
  `List-Unsubscribe=One-Click`) → `notifyUnsubscribe()`: sets
  `devotees.unsubscribed_at` (first time kept), answers the "stopped" page.
  Idempotent; no session, no CSRF — the signed token is the proof.

### 6.2 `backend/api/notify_webhook.php` — `/api/notify-webhook/<driver>`

Routed with `$webhookDriver` (`^[a-z0-9]{2,16}$`: `meta|twilio|msg91|test`,
any method). Finds the channel(s) whose configured driver matches (404 when
none), reads at most 1 MB of body (413 beyond), and calls each provider's
`handleWebhook()` in turn until one verifies the request; applies its
`updates` with `notifyApplyProviderUpdate()` (status `sent|delivered|read|failed|rejected`,
`at` as `Y-m-d H:i:s` UTC) and answers the provider's expected body and
status (Meta's `hub.challenge`, Twilio's empty TwiML). Unverified → 403 with
an empty body and one `error_log` line naming the driver, method and client
IP; a handler exception → 500 with an empty body so the provider redelivers.
Always fast: nothing is sent from inside a webhook.

### 6.3 `/api/notify-cron` — see §5.7.

### 6.4 Routing (`backend/api/index.php`)

- `/n/<c|o|u>/<token>` → `n.php` (matched first, exact regex); any other
  `/n/…` → 404
- `/notify-webhook/<driver>` → `notify_webhook.php` (`$webhookDriver`)
- `/notify-cron` → `notify_cron.php`
- `/live-subscriptions/*` (subscribe, unsubscribe) belongs to the live module
  (`docs/live/`), not to this service.

---

## 7. Frontend

There is no notification UI on the public site: no bell, panel, history page,
preferences tab, push subscription hook or `push-sw.js`, and no
`NotificationContext`. `/notifications`, `/account`, `/login` and the other
account routes redirect to `/register`. What the site still has that touches
this service:

- **Consent tick box** on the Review step of family registration
  (`components/Registration/ReviewStep.jsx`, `#reg-consent`, unticked by
  default): "Send me festival, pooja and temple updates by WhatsApp, SMS or
  email", with the hint that every update has a link to stop them. It becomes
  `devotees.updates_consent_at`; the preferred language on step 1 becomes
  `devotees.lang`. Ticked, the API raises `registration.received`.
- **Booking and donation forms** send `lang`, which `seva_bookings.lang` /
  `donations.lang` keep so every message about that booking or pledge is
  written in it.
- **"Notify me" on a live darshan page** (`components/Live/NotifyForm.jsx`):
  an email and a consent box per stream, stored in `live_stream_subscriptions`,
  reminded by email through this service's queue (§5.9) with the live module's
  own unsubscribe link.
- **The unsubscribe landing** is served by the API itself (`/api/n/u/<token>`,
  §6.1), not by the SPA, so it works without JavaScript from any mail client.

---

## 8. Admin

### 8.1 Capabilities (`backend/includes/auth.php`)

| capability | minimum role |
| --- | --- |
| notifications.view | viewer |
| notifications.compose | editor |
| notifications.approve | owner |
| notifications.templates | owner |

Page policy (`adminPageCapability` / `adminPageWriteCapability`):

| page | read | write |
| --- | --- | --- |
| notifications.php | notifications.view | notifications.compose (finer checks per action) |
| notification_segments.php | notifications.view | notifications.compose |
| notification_templates.php | notifications.view | notifications.templates |
| notification_analytics.php | notifications.view | notifications.compose (requeue) |

### 8.2 Navigation (`admin_layout.php`)

Group `'Communication'` after `'Devotees'`:

```php
'notifications.php'          => ['bell',     'Notifications',      'Campaigns, broadcasts and scheduling'],
'notification_templates.php' => ['mail',     'Message Templates',  'Wording of every automated message'],
'notification_segments.php'  => ['users',    'Audiences',          'Saved devotee segments'],
'notification_analytics.php' => ['activity', 'Delivery Analytics', 'Sends, opens, clicks and failures'],
```

with `assets/notify-campaigns.css` and `assets/notify-content.css` in `<head>`
after `admin.css`. Quick actions: "New notification" (compose) and "Delivery
analytics" (view).

### 8.3 Pages

**notifications.php** — list with status chips and counts, search, per-row
stats (recipients, sent, failed), row menu (edit, duplicate, cancel, audit).
Composer: name, category (transactional categories are refused), priority,
channels (checkbox cards for email, WhatsApp and SMS with provider
configured/not configured; default email), translations (Tamil and English
tabs, "Add language" for any `notifyLanguages()` code), CTA URL + label, image
URL, audience (saved segment select, rules builder from
`admin/includes/notify_audience_form.php`, or selected families with search),
live estimate showing all matches and consenting families, schedule (send on
approval / at a time, temple or recipient timezone, recurrence + until),
per-channel preview (email in a sandboxed `iframe srcdoc`, WhatsApp bubble with
template name and params, SMS text with character and segment count, each
including the unsubscribe link or stop-updates line an update will carry), test
send, save draft, submit, approve/reject (owner), schedule, send now, emergency
send (owner, reason required), cancel, duplicate. Approval banner showing the
reason and who can approve. Audit timeline and per-channel delivery stats
(including "skipped for consent") on the campaign view. JSON sub-endpoints on
the same page: `POST action=estimate` → `{ "count", "approvalReason" }`,
`POST action=preview` → `notifyCampaignPreview()`, `GET ?devotee_search=<q>`
→ `{ "items": [{id, name, email, city}] }` (≤20); all CSRF/role-checked and
answered in JSON even when refused. Behaviour in `assets/notify-campaigns.js`.

**notification_segments.php** — saved audiences CRUD with the same rules
builder, estimate (all / consenting), "used by N campaigns", rules locked and
delete blocked while an approved/scheduled/sending campaign uses it; a segment
using a retired field (§5.11) is refused with a sentence naming the rule, not
crashed on.

**notification_templates.php** — every template key from defaults merged with
DB rows; filter by category, language, channel (Shared / Email / WhatsApp /
SMS), customised/default; editor for (key, lang, channel): title, body, CTA
label, provider template name + ordered params, variable chips, warnings for
unknown or missing variables (never blocking), live preview (email iframe, SMS
count, WhatsApp bubble) with sample variables and the dispatch-time unsubscribe
line, "Reset to built-in". Owner only for writes (`notifications.templates`),
audited `template_saved`. Categories section: edit labels, icon, sort, active,
default-on; add a new informational or promotional category; built-in kinds
read-only. Audited `category_saved`. Assets: `notify-content.js/.css`.

**notification_analytics.php** — filters: date range (temple timezone,
≤366 days), channel, campaign, category, source (automated / campaign /
segment), status. KPIs: notifications created, deliveries sent, delivered,
failed (failed+rejected+dead), email open rate, click-through rate, WhatsApp
delivery rate, SMS delivery rate, skipped for consent. Daily sends, channel
shares, channel performance table, campaign performance table, worker health
card (last run, ago, last error, queue depth by channel, dead count; warning
when the last run is older than 5 minutes), failed/dead deliveries table with
the (redacted) provider response and **Requeue** (`notifyRequeue`, CSRF,
`notifications.compose`), CSV export of the filtered deliveries (no addresses
or phone numbers). Historic `inapp`/`push` rows in the range are shown as
"In-app (retired)" / "Push (retired)", never offered as filters for new sends
and never requeued. Rates show "—" when the denominator is zero, never NaN.

**devotees.php tags** — tag editor in the registration edit panel (add/remove,
lowercase `[a-z0-9:_-]{1,40}`, suggestions from tags in use), a tag filter on
the list, tags column. The same page records consent on behalf of a family
(`updates_consent_by` = the admin, clears `unsubscribed_at`).

**Announcements hook** (`announcements.php`) — "Also notify devotees" on
create; when ticked, after saving, creates a **draft** campaign (category
`announcement`, template `announcement`, channels `email,whatsapp`, audience
`all_devotees`, the same words as both translations) and flashes a link to it.
Nothing is sent without going through the campaign flow.

**Bookings and donations** — `admin/seva_bookings.php` single and bulk status
changes fire `booking.confirmed` / `booking.cancelled` / `booking.completed`
to the booking's phone in the booking's language (deduped, so re-applying a
status is harmless); `admin/donations.php` "Send receipt" fires
`donation.receipt` to the pledge's phone with `sequence` = receipts already
sent + 1 (an online donation's receipt is resent from Online Payments instead).

---

## 9. Files and test suites

Code:

| area | files |
| --- | --- |
| service | `backend/includes/notify.php`, `backend/includes/notify/*.php`, `backend/includes/notify/providers/*.php` |
| callers' wrapper | `backend/includes/devotee_notify.php` (`devoteeNotifyReady`, `devoteeNotifyEvent`, numbers, amounts, dates, phones) |
| endpoints | `backend/api/n.php`, `backend/api/notify_webhook.php`, `backend/api/notify_cron.php`, routes in `backend/api/index.php` |
| CLI | `backend/bin/notify_worker.php`, `backend/bin/notify_keys.php check` (reports which channels are configured, never prints a secret, exit 1 on a broken setting) |
| admin | `backend/admin/notifications.php`, `notification_segments.php`, `notification_templates.php`, `notification_analytics.php`, `includes/notify_audience_form.php`, `assets/notify-campaigns.css/.js`, `assets/notify-content.css/.js` |
| triggers | `backend/api/registrations.php`, `seva_bookings.php`, `donations.php`, `contact.php`, `backend/includes/payments/notify.php`, `backend/admin/seva_bookings.php`, `donations.php`, `announcements.php` |
| live | `backend/includes/live/subscriptions.php` (live reminders through this queue) |
| migrations | 007, 009, 013, 019 |

Test suites (run with `PHP_BIN` set to the wrapper in §1; each is re-runnable,
sends its own `X-Forwarded-For`, scopes worker runs to its own rows and cleans up):

| suite | what it proves |
| --- | --- |
| `tests/notify-unit.php` | the policy matrix for registered families (with/without consent, unsubscribed, archived) and guests incl. fallbacks; recipient shapes; tokens, CTA safety, time zones, recurrence, backoff; audience rules, retired fields and the automatic consent filter; the event catalogue and `registration_received`; the payment events and templates; end to end with the test drivers that updates stop on every channel after an unsubscribe while a booking confirmation still goes, and that every update carries its unsubscribe link |
| `tests/notify-templates-unit.php` | every §5.2 key exists in ta and en with SMS and WhatsApp variants using only declared or automatic variables; English SMS fit one GSM-7 segment; interpolation and escaping; DB-over-default resolution order; SMS segment counting; the email wrapper's safety, unsubscribe link, pixel and banner |
| `tests/notify-worker.mjs` | queue, worker, retries, throttle, stale-claim recovery, dedupe, campaigns (approval, 600-family expansion across runs, recipient-time delivery, recurrence, cancel), reminders, provider status updates, `/api/notify-cron` key handling (harness: `tests/support/notify_core_harness.php`, `notify_cron_router.php`) |
| `tests/notify-triggers.mjs` | the places the site tells a family something: registration, bookings and donations (public and admin), receipts, announcements → draft campaign, contact → office copy (against PHP on 8002 with the default drivers, reading `backend/logs/mail.log` and `notify.log`) |
| `tests/notify-providers.mjs` | every provider against Node mocks of Meta, Twilio, MSG91 and an SMTP server; each answer class → `NotifyResult`; the webhook endpoint's verification per driver; `notify_keys.php check` (harness: `notify_provider_harness.php`, `notify_webhook_router.php`) |
| `tests/notify-links.mjs` (renamed from `notifications-api.mjs`) | tracked clicks redirect and count once, the open pixel is a real GIF, unsubscribe GET changes nothing and POST / RFC 8058 one-click does, and the webhook and cron routes reach their endpoints through `api/index.php` |
| `tests/admin-notifications.mjs` | the campaigns and audiences admin over HTTP and in a browser: roles, estimate, preview, send now + scoped worker run, cancel, duplicate, emergency send, test send, CSRF, segment locking, axe and overflow at 390/1440 (server env: `NOTIFY_ALLOW_TEST_DRIVER=1 NOTIFY_EMAIL_DRIVER=test NOTIFY_APPROVAL_THRESHOLD=2`) |
| `tests/admin-notify-content.mjs` | Message Templates (wording, preview, reset, categories) and Delivery Analytics (KPIs against independently computed numbers, filters, retired channels labelled, CSV, requeue, worker health) |

`tests/notifications-ui.mjs`, `tests/notify-prefs-ui.mjs` and
`tests/accounts-ui.mjs` are deleted with the UI they tested. Some of the
`.mjs` suites above still carry scenarios written for the retired in-app/push
channels and account events (see their file headers); the two PHP unit suites
encode the current rules and are the cross-check for this document.

### Definition of done (any change to this system)

1. Every public name and shape in this document that you touch still exists and matches.
2. `php.sh -l` clean for every PHP file you touched; `npm run audit` 0 actionable
   if you touched `frontend/src` or `backend/admin`.
3. The suites that exercise what you touched pass, twice in a row.
4. Your final report lists: files changed, test commands with pass/fail counts,
   every deviation from this document, and anything left undone and why.

---

## 10. Environment variables

| variable | default | used by |
| --- | --- | --- |
| NOTIFY_SECRET | generated into notification_kv | token signing (set ≥32 random chars in production; shorter values are ignored with a log line) |
| NOTIFY_TEMPLE_TZ | Asia/Kolkata | reminders, admin display, temple-time schedules |
| NOTIFY_LANGUAGES | ta,en,hi,te,ml,kn | campaign translation languages (ta and en are always offered) |
| NOTIFY_APPROVAL_THRESHOLD | 50 | campaign approval rule "Reaches N families" |
| NOTIFY_ALLOW_SELF_APPROVAL | 0 | single-committee deployments |
| NOTIFY_CRON_KEY | unset (endpoint 404) | HTTP worker trigger, ≥24 chars |
| NOTIFY_RATE_EMAIL_PER_MIN / NOTIFY_RATE_WHATSAPP_PER_MIN / NOTIFY_RATE_SMS_PER_MIN | 60 / 80 / 30 | worker throttle |
| NOTIFY_EMAIL_DRIVER | mailer | mailer · log · test |
| NOTIFY_WHATSAPP_DRIVER | log | meta · twilio · log · test |
| NOTIFY_SMS_DRIVER | log | twilio · msg91 · log · test |
| NOTIFY_ALLOW_TEST_DRIVER | 0 | enables the `test` driver and the worker's `--now` clock (never in production) |
| NOTIFY_TEST_WEBHOOK_SECRET | test-webhook-secret | test driver webhooks (`X-Test-Signature` = hex HMAC-SHA256 of the body) |
| CONTACT_NOTIFY_EMAIL | unset (nothing sent) | office mailbox(es), comma-separated, that receive `contact.received` |
| CONTACT_NOTIFY_LANG | en | `ta` or `en`: the language of the office's copy |
| SITE_URL | — | the public https address every tracking, unsubscribe and callback link is built on |
| MAIL_TRANSPORT (smtp · mail · unset = log), SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (tls · ssl · none), SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_FROM_NAME | existing | email via mailer.php (`notify_keys.php check` reports them) |
| WHATSAPP_META_TOKEN, WHATSAPP_META_PHONE_NUMBER_ID (numeric id), WHATSAPP_META_APP_SECRET (signs callbacks), WHATSAPP_META_VERIFY_TOKEN (≥16 chars), WHATSAPP_META_API_VERSION (v21.0), WHATSAPP_META_BASE_URL (https://graph.facebook.com) | — | Meta WhatsApp Cloud API; base URL overridable for tests |
| TWILIO_ACCOUNT_SID (AC…), TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (whatsapp:+…), TWILIO_SMS_FROM or TWILIO_MESSAGING_SERVICE_SID (MG…), TWILIO_BASE_URL (https://api.twilio.com), TWILIO_STATUS_CALLBACK_URL (default siteUrl('/api/notify-webhook/twilio')) | — | Twilio WhatsApp and SMS |
| MSG91_AUTH_KEY, MSG91_WEBHOOK_TOKEN (≥24 chars), MSG91_BASE_URL (https://control.msg91.com) | — | MSG91 SMS (India; sender id, route and DLT entity belong to each flow template in the MSG91 panel; DLT template ids go in `provider_template` in the admin) |

`VAPID_*` and `FCM_*` are no longer read: there is no push channel.
