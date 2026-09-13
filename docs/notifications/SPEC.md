# Notification System — Design and Build Contract

This document is the single source of truth for the devotee notification
system. It is written for the people (and agents) building it in parallel: every
shared name, shape and rule is fixed here so that independently written pieces
fit together. If you find a contract here that cannot work, implement the
closest safe behaviour, keep the public shape, and **report the deviation** in
your final summary. Do not silently rename things.

- Data model: `database/migrations/007_notifications.sql` (applied locally)
- Provider contract: `backend/includes/notify/contracts.php` (written, tested — do not change the interface)
- Test fixtures CLI: `tests/support/notify_fixtures.php`

---

## 1. Local environment (read before running anything)

| Thing | Where / how |
| --- | --- |
| MySQL 8.4 | Docker container `temple-mysql`, host port **3307**, db `templemahendra`, app user `temple/templepass`, root `root/rootpass`. Query: `docker exec temple-mysql mysql -uroot -prootpass templemahendra -e "…"` |
| PHP 8.3 CLI | `/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh` — exports the DB environment, passes other env through. Use it as `PHP_BIN` for test suites. |
| PHP dev server | `/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/serve.sh <port>` (run in the background). Inherits exported env, sets `TRUSTED_PROXIES=127.0.0.1,::1`, `SITE_URL=http://localhost:5173`. The built-in server is **single-threaded**; that is why each agent gets its own port. Code changes need no restart. |
| Vite | Already running on `http://localhost:5173` (IPv6 loopback — never use 127.0.0.1:5173). Proxies `/api`, `/admin`, `/uploads` to PHP on 8000. |
| Playwright + axe | `frontend/node_modules`; tests resolve them with `createRequire("../frontend/node_modules/playwright/index.js")` exactly as `tests/public-e2e.mjs` does. |
| Admin login | `admin` / `Admin@Test123` (owner, environment account). Create editor/viewer accounts for role tests via `/admin/users.php` or SQL into `admin_users` (bcrypt). |
| Design audit | `cd frontend && npm run audit` must report **0 actionable findings**. Every literal `className`/`class` needs a CSS rule; no opaque raw colours outside `styles/tokens.css`; no inline `style=` except custom properties. It scans `frontend/src` and `backend/admin`. |
| PHP lint | `php.sh -l <file>` on every PHP file you touch. |

### Ports (one owner each)

| Port | Owner |
| --- | --- |
| 8000 | shared by Vite (UI agents) — already running, default env |
| 8001 | API agent |
| 8002 | triggers agent |
| 8003 | admin campaigns agent |
| 8004 | admin content agent |
| 8010–8019 | core service agent (start your own with the env you need) |
| 8020–8029 | providers agent (PHP webhook server and Node mock provider servers) |
| 8030–8039 | API agent's extra servers (cron key, etc.) |

Start any server you need with `serve.sh`; stop what you started when you are
done (`Get-NetTCPConnection -LocalPort <p> -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`).
Never stop 8000.

### Shared-machine rules

- **Rate limits are per IP.** Every test HTTP request must send a unique
  `X-Forwarded-For` for your suite (e.g. `10.21.0.1` for providers, `10.31.x.y`
  for API). Servers trust it because of `TRUSTED_PROXIES`. For Playwright use
  `browser.newContext({ extraHTTPHeaders: { "X-Forwarded-For": "…" } })`.
  Never run `DELETE FROM rate_limits` without a `WHERE bucket LIKE '%<your ip>%'`.
- **Create test devotees with the fixtures CLI**, not `/api/auth/register`
  (sign-up is capped at five per hour per IP). Sign in through `/api/auth/login`.
- **Test data prefixes**: emails `e2e-<suite>-<run>-…@example.test`; campaign
  names `E2E-<SUITE>-…`; dedupe keys `e2e:<suite>:…`. Every suite must be
  re-runnable and clean up after itself (fixtures `cleanup` removes devotees by
  email prefix and everything that cascades from them).
- **Scope worker runs to your own rows**: `notify_worker.php --notification-ids=1,2`
  or `--campaign-id=9`. Another suite's queue is not yours to drain.
- **Do not run `npm run build`** (other agents' dev servers read `frontend/`).
  To prove a production build compiles, use
  `npx vite build --outDir C:/Users/nithp/AppData/Local/Temp/claude/build-<you> --emptyOutDir`.
- Do not commit to git. Do not edit files you do not own (§9).

---

## 2. Architecture

```
 module (auth, bookings, donations, admin)          admin campaign composer
            │  notifyEvent('booking.confirmed', …)            │ notifyCampaignTransition()
            ▼                                                  ▼
   ┌─────────────────────────── Notification Service (backend/includes/notify/) ──────────┐
   │ events catalogue → template render (lang × channel) → recipient + preferences →      │
   │ channel policy → notifications row (+dedupe) → notification_deliveries rows (queue)   │
   │  sync=true: dispatch now inside the request (security emails, OTP)                    │
   └─────────────────────────────────────────────┬─────────────────────────────────────────┘
                                                 │ cron: php backend/bin/notify_worker.php (every minute)
                                                 ▼
   worker: lock → recover stale claims → expand due campaigns (batches) → reminders →
           claim due deliveries (priority order, per-channel throttle) → dispatch
                                                 │  NotifyProvider::send(NotifyMessage)
                    ┌──────────────┬─────────────┼──────────────┬───────────────┐
                  email         whatsapp        sms           push           inapp
               (mailer.php)   (meta|twilio)  (twilio|msg91) (webpush|fcm)  (the row itself)
                                                 │
        provider status callbacks → /api/notify-webhook/<driver> → notifyApplyProviderUpdate()
        email opens / link clicks → /api/n/o|c/<token> ;  unsubscribe → /api/n/u/<token>
        devotee UI → /api/notifications/* (bell polls /unread every 30 s, instant on push)
```

Hosting constraints that shaped this (Hostinger shared hosting):

- No daemons, no Redis, no WebSocket server. The queue is MySQL; the worker is a
  cron job (`* * * * *`), with an HTTP trigger (`/api/notify-cron`) for hosts
  without CLI cron. Each run has a time budget (default 50 s) so runs never
  overlap; a MySQL `GET_LOCK` makes overlap harmless anyway.
- Real-time in-app updates are a cheap poll (one indexed `COUNT`) every 30 s
  while the tab is visible, plus an immediate refresh when a Web Push arrives,
  plus cross-tab sync with `BroadcastChannel`. SSE would hold one PHP worker per
  open tab, which shared hosting cannot afford.
- No native mobile app exists. "Mobile push" is Web Push to the installed PWA
  (Android, desktop, iOS 16.4+ home-screen apps). FCM for a future native app
  sits behind the same interface.

---

## 3. Conventions

- **UTC everywhere.** All notification `DATETIME`s are UTC, written explicitly
  with `UTC_TIMESTAMP()` or `notifyNow()`. APIs return ISO-8601 with `Z`
  (`notifyIso()`). The admin displays the temple timezone
  (`NOTIFY_TEMPLE_TZ`, default `Asia/Kolkata`, label it "IST" when it is);
  the devotee UI formats in the browser's zone.
- **Code style follows the codebase**: plain PHP functions with a `notify`
  prefix (no framework, no Composer), PDO prepared statements, early returns,
  comments that explain *why*. React function components, `useLang()` `t(ta, en)`
  for every visible string, existing UI primitives (`Button`, `Badge`, `Chip`,
  `Switch`, `Field`, `EmptyState`, `ErrorState`, `SkeletonText`, `Modal`,
  `useDialogBehaviour`), design tokens only.
- **Never break a user flow.** `notify()`/`notifyEvent()` must not throw into
  their callers: wrap, `error_log('[notify] …')`, and return a result that says
  what happened. A booking must save even if the notification tables are
  missing (`notifyTablesExist()` false → return `['id' => null, 'skipped' => 'tables missing']`).
- **Never store secrets in notifications.** OTP codes, verification and reset
  links go in `secret_vars`, are rendered only at dispatch, and require
  `sync => true` (§5.3). Provider responses are redacted (`notifyRedact`).
- **No PII in URLs.** Tracking and unsubscribe links carry opaque signed tokens
  (§5.10). The devotee API takes ids in POST bodies, never emails or phones in
  query strings.
- **Bilingual.** Tamil is the site default. Every built-in template ships `ta`
  and `en`; the architecture accepts any language code in `NOTIFY_LANGUAGES`.

---

## 4. Statuses and their meaning

`notification_deliveries.status`:

| status | meaning | terminal |
| --- | --- | --- |
| queued | waiting for the worker (or for `next_attempt_at`) | no |
| sending | claimed by a worker run (`claim_token`, `claimed_at`) | no |
| sent | the provider accepted it (or in-app: visible to the devotee) | no |
| delivered | provider confirmed delivery (webhook) | no |
| read | opened / read (email pixel, WhatsApp read receipt, in-app read) | yes |
| failed | a retry is scheduled — **only while attempts < max_attempts** | no |
| rejected | permanent provider refusal | yes |
| dead | retries exhausted; kept for the admin to requeue | yes |
| skipped | never attempted: opted out, no contact, not configured (`skip_reason`) | yes |
| cancelled | the campaign was cancelled before this was sent | yes |

Progression is monotonic: `queued < sending < sent < delivered < read`. A webhook
may only move a delivery forward; a late "failed" after "delivered" is recorded
as a delivery event but does not change the status.

In-app deliveries are created `sent` (or `queued` with `next_attempt_at` =
`deliver_after` when scheduled) and become `read` when the devotee reads the
notification.

Campaign statuses: `draft → review → approved → scheduled → sending → completed`,
plus `cancelled` and `failed`. See §5.8.

---

## 5. The service (backend/includes/notify/)

`backend/includes/notify.php` is the one file every caller requires. It loads
`notify/contracts.php` and every service file. Requiring it must have no side
effects beyond defining functions (no session start, no output, no DB query).

### 5.1 Time, secrets, languages, categories

```php
function notifyTablesExist(): bool;                       // cached per request; false before migration 007
function notifyNow(): string;                             // UTC 'Y-m-d H:i:s'
function notifyIso(?string $utc): ?string;                // 'Y-m-d\TH:i:s\Z' or null
function notifyTempleTz(): string;                        // NOTIFY_TEMPLE_TZ, default 'Asia/Kolkata'
function notifyToUtc(string $localWallClock, string $tz): string;
function notifyFromUtc(string $utc, string $tz, string $format = 'Y-m-d H:i:s'): string;
function notifyTimezoneFor(?array $prefs, ?string $countryIso2): string; // prefs.timezone → country map → temple tz
function notifySecret(): string;                          // NOTIFY_SECRET (≥32 chars) else generated once into notification_kv('secret')
function notifyLanguages(): array;                        // code => native label, from NOTIFY_LANGUAGES (default "ta,en,hi,te,ml,kn")
function notifyCategories(bool $activeOnly = true): array; // key => row + ['mutable' => bool]
function notifyCategory(string $key): ?array;
```

Country → timezone map must cover at least IN, LK, SG, MY, AE, SA, QA, KW, OM,
BH, GB, IE, DE, FR, NL, CH, US (America/New_York), CA (America/Toronto),
AU (Australia/Sydney), NZ, ZA, MU, FJ, JP, HK. Unknown → temple tz.

`mutable` = kind is `informational` or `promotional`.

### 5.2 Templates

Built-in defaults live in `notify/defaults.php`:

```php
function notifyTemplateDefaults(): array;
// template_key => [
//   'category'    => 'booking',
//   'description' => 'Sent when the committee confirms a seva booking',
//   'variables'   => ['devoteeName', 'sevaName', 'bookingNumber', 'bookingDate', 'ctaUrl'],
//   'cta_path'    => '/account?tab=bookings',          // default CTA; may use {{vars}}
//   'langs' => [
//     'ta' => ['any' => ['title' => …, 'body' => …, 'cta_label' => …],
//              'sms' => ['title' => '', 'body' => …],   // optional channel overrides
//              'whatsapp' => ['title' => '', 'body' => …]],
//     'en' => [ … ],
//   ],
// ]

function notifyTemplate(string $key, string $lang, string $channel): ?array;
// Resolution order: DB (key, lang, channel) → DB (key, lang, 'any') → default (lang, channel) →
// default (lang, 'any') → same four steps for 'ta' → then 'en'. Returns
// ['title','body','cta_label','provider_template','provider_params'(names),'source'=>'db'|'default',
//  'lang'=>used, 'channel'=>used] or null for an unknown key.

function notifyInterpolate(string $text, array $vars, bool $html = false): string;
// {{name}} → value. Unknown names render as ''. $html escapes values (never the template).
// Values that are arrays are ignored. No other syntax.

function notifyRender(string $key, string $lang, string $channel, array $vars): array;
// ['title','body','cta_label','provider_template','provider_params'(ordered VALUES),
//  'missing'=>[names used by the template but absent from $vars], 'lang'=>used, 'source']

function notifyEmailHtml(array $p): string;
// Branded, responsive, table-layout email with inline styles (extends the look of
// mailTemplate() in mailer.php). $p keys: title, body (plain text; blank lines are
// paragraphs, single newlines <br>), lang, preheader, category_label, priority,
// cta_url, cta_label, details ([[label, value], …]), logo_url (absolute /logo.png
// or /icons/icon-192x192.png), contact (['phone' => …, 'email' => …, 'address' => …]),
// preferences_url, unsubscribe_url, open_pixel_url. Emergency/urgent priorities get a
// visible banner. Must render in Gmail, Outlook and Apple Mail (no <style> reliance,
// max-width 600, 16px min body text, dark-mode-safe colours).
```

Template keys (all must exist in defaults, ta and en, with an `sms` override
≤ 160 GSM-7 characters in English and a concise Tamil variant, and a `whatsapp`
override where WhatsApp formatting helps):

| key | category | variables (beyond devoteeName, templeName, ctaUrl) |
| --- | --- | --- |
| welcome | general | — |
| email_verification | security | verifyUrl, expiresHours |
| email_verified | security | — |
| password_reset | security | resetUrl, expiresMinutes |
| password_changed | security | changedAt |
| profile_updated | security | changedFields |
| phone_otp | security | otpCode, expiresMinutes |
| phone_verified | security | phoneMasked |
| booking_received | booking | bookingNumber, sevaName, bookingDate |
| booking_confirmed | booking | bookingNumber, sevaName, bookingDate |
| booking_modified | booking | bookingNumber, sevaName, bookingDate, changes |
| booking_cancelled | booking | bookingNumber, sevaName, bookingDate, reason |
| booking_completed | booking | bookingNumber, sevaName |
| booking_reminder | booking | bookingNumber, sevaName, bookingDate, templeAddress, mapsUrl |
| donation_received | donation | receiptNumber, donationAmount, donationPurpose |
| donation_receipt | donation | receiptNumber, donationAmount, donationPurpose, donationDate, trustName, taxNote |
| payment_success | payment | paymentReference, paymentAmount, paymentFor |
| payment_failed | payment | paymentReference, paymentAmount, paymentFor, reason |
| event_registered | event | eventName, eventDate, eventLocation |
| event_cancelled | event | eventName, eventDate, reason |
| event_reminder | event | eventName, eventDate, eventLocation |
| festival_reminder | festival | eventName, eventDate, eventLocation |
| pooja_reminder | pooja | poojaName, poojaDate, poojaTime |
| volunteer_registered | volunteer | opportunityName |
| volunteer_opportunity | volunteer | opportunityName, eventDate |
| membership_renewal | membership | membershipName, renewalDate |
| special_darshan | special_darshan | eventName, eventDate, eventLocation |
| announcement | announcement | headline, message |
| emergency | emergency | headline, message |
| campaign_generic | (campaign's) | title, message — the wrapper for free-text campaigns |

`templeName`, `templeAddress`, `mapsUrl`, `supportPhone` are filled automatically
(from `data/temple.js` facts copied into PHP once, in `defaults.php`).

### 5.3 Creating a notification

```php
function notify(array $n): array;
```

Input (all keys optional unless stated):

| key | type | notes |
| --- | --- | --- |
| event | string | the automated event name, stored in `notifications.event` |
| template | string | template key; required unless `title`+`body` given |
| vars | array | template variables; stored in `notifications.vars` |
| secret_vars | array | rendered only at dispatch, never stored; forces `sync` |
| title, body, cta_label | string or `['ta' => …, 'en' => …]` | free text (campaigns); per-language maps pick the recipient language with the §5.2 fallback order |
| devotee_id | int | recipient account; its email, phone, language, timezone and preferences are loaded |
| to_email, to_phone, name, lang | string | a guest, or an override for this send |
| category | string | default: the template's category, else `general` |
| priority | string | `normal` (default), `important`, `urgent`, `emergency` |
| channels | string[] | subset of `NOTIFY_CHANNELS`; default: the event catalogue's, else `['inapp']` |
| cta_url | string | passed through `notifySafeCtaUrl()`; default: template `cta_path` |
| image_url | string | site path or https URL |
| details | `[[label, value], …]` | email details table; stored in vars as `_details` |
| entity_type, entity_id | string, int | what it is about |
| dedupe_key | string | **required for automated events**; ≤190 chars |
| campaign_id, run_no | int | set by campaign expansion |
| deliver_after | UTC string | hold in-app visibility and all deliveries until then |
| sync | bool | dispatch external channels now, inside this request |
| actor | string | admin username, default `system` |

Returns:

```php
[
  'id'         => ?int,        // null when deduped, suppressed or the tables are missing
  'deduped'    => bool,        // a notification with this dedupe_key already exists
  'skipped'    => ?string,     // why nothing was created, when id is null and not deduped
  'deliveries' => [ 'email' => ['id' => int, 'status' => 'queued'|'sent'|'skipped'|…,
                                'reason' => ?string, 'recordedOnly' => bool], … ],
]
```

Behaviour, in order:

1. Tables missing → `['id' => null, 'deduped' => false, 'skipped' => 'tables missing', 'deliveries' => []]`.
2. Resolve the recipient (`notifyRecipientFromDevotee` or the guest fields).
   A closed account (`is_active = 0`) receives nothing (`skipped: account closed`),
   except `security` category sends to its own email.
3. Dedupe: `INSERT` with the unique `dedupe_key`; on duplicate return
   `deduped => true` with the existing id. Never a second row.
4. Render title/body/cta in the recipient language for channel `any` (what the
   bell shows). With `secret_vars`, the stored copy renders secrets as `••••`.
5. Channel policy (§5.4) decides each channel: create one delivery per channel
   with status `queued`, `sent` (in-app) or `skipped` + `skip_reason`.
   `show_in_app` = in-app delivery not skipped.
6. `sync` (or `secret_vars` present): dispatch each queued external delivery now
   via `notifyDispatchDelivery()`. A retryable failure of a send carrying
   `secret_vars` becomes `dead` with reason "security message not retried" —
   the secret was never stored, so a later retry could not reproduce it.

```php
function notifyRecipientFromDevotee(array|int $devotee): array;
// ['devotee_id','name','email','email_verified'(bool),'phone','phone_verified'(bool),
//  'country','lang','timezone','prefs'(notifyPrefs), 'active'(bool)]
```

### 5.4 Channel policy

```php
function notifyAllowedChannels(array $requested, string $category, string $priority, array $recipient, bool $isCampaign): array;
// channel => ['status' => 'queued'|'sent'|'skipped', 'reason' => ?string]
```

For each requested channel, the first rule that applies wins:

1. **inapp**: no `devotee_id` → skipped `no account`. `inapp_on` off, category
   mutable and priority below urgent → skipped `turned off`. Otherwise `sent`
   (or `queued` when `deliver_after` is in the future).
2. **Contact**: email needs a valid address; whatsapp/sms need a phone; push
   needs ≥1 active device → skipped `no email` / `no phone` / `no device`.
3. **Provider**: `notifyProviderFor($channel)->isConfigured()` false → skipped
   `not configured`, then apply the event's fallback (e.g. whatsapp → sms) if any.
4. **Consent for the kind**:
   - `promotional`: requires `promotional_opt_in_at`; whatsapp/sms additionally
     require `phone_verified`; email requires `email_verified`.
   - `informational` campaigns: email requires `email_verified`.
   - `unsubscribed_at` set → email skipped `unsubscribed` for informational and
     promotional kinds.
5. **Channel toggle** off (`<channel>_on = 0`) → skipped `turned off`, except:
   `security` kind always allows email; `critical` kind (emergency) ignores every
   toggle except `whatsapp_on` (WhatsApp opt-in is a Meta policy requirement).
6. **Muted category** (mutable kinds only) → skipped `muted`, unless priority is
   `urgent` or `emergency`.
7. **SMS restraint**: priority `normal` with an `informational` or `promotional`
   kind → skipped `sms reserved for important messages`.
8. Otherwise `queued`.

Guests have no preferences: every toggle counts as on, no category is muted,
promotional is never allowed.

### 5.5 Automated events

```php
function notifyEventCatalogue(): array;
function notifyEvent(string $event, array $ctx): array;   // returns notify()'s result
```

`$ctx` carries the recipient (`devotee_id`, or `to_phone`/`to_email`/`name`/`lang`
for guests), `vars`, optional `secret_vars`, `entity_id`, and any extras the
catalogue entry names. `notifyEvent` fills template, category, priority,
channels, fallbacks, cta and `dedupe_key` from the catalogue; `$ctx` may override
`channels`, `priority` and `dedupe_key`.

| event | template | priority | channels | fallbacks | sync | dedupe_key |
| --- | --- | --- | --- | --- | --- | --- |
| account.registered | welcome | normal | inapp | — | no | `devotee:{id}:welcome` |
| account.email_verification | email_verification | urgent | email | — | yes | none (every resend is new) |
| account.email_verified | email_verified | normal | inapp, email | — | no | `devotee:{id}:email_verified` |
| account.profile_updated | profile_updated | important | inapp, email | — | no | none |
| security.password_reset | password_reset | urgent | email | — | yes | none |
| security.password_changed | password_changed | important | inapp, email | — | yes | none |
| phone.otp | phone_otp | urgent | sms | sms→whatsapp | yes | none |
| phone.verified | phone_verified | normal | inapp | — | no | `devotee:{id}:phone:{phoneHash8}` |
| booking.received | booking_received | normal | inapp, email, whatsapp | — | no | `booking:{entity_id}:received` |
| booking.confirmed | booking_confirmed | important | inapp, email, whatsapp, push | whatsapp→sms | no | `booking:{entity_id}:confirmed` |
| booking.modified | booking_modified | important | inapp, email, whatsapp, push | — | no | `booking:{entity_id}:modified:{vars.bookingDate}` |
| booking.cancelled | booking_cancelled | important | inapp, email, whatsapp, sms, push | — | no | `booking:{entity_id}:cancelled` |
| booking.completed | booking_completed | normal | inapp | — | no | `booking:{entity_id}:completed` |
| booking.reminder | booking_reminder | important | inapp, whatsapp, push, email | whatsapp→sms | no | `booking:{entity_id}:reminder:{vars.bookingDate}` |
| donation.received | donation_received | normal | inapp, email, whatsapp | — | no | `donation:{entity_id}:received` |
| donation.receipt | donation_receipt | important | inapp, email, whatsapp | — | no | `donation:{entity_id}:receipt:{ctx.sequence}` |
| payment.succeeded | payment_success | important | inapp, email, whatsapp, sms | — | no | `payment:{vars.paymentReference}:success` |
| payment.failed | payment_failed | urgent | inapp, email, whatsapp, sms | — | no | `payment:{vars.paymentReference}:failed` |
| event.registered | event_registered | normal | inapp, email, whatsapp | — | no | `event:{entity_id}:registered:{recipient}` |
| event.cancelled | event_cancelled | important | inapp, email, whatsapp, sms, push | — | no | `event:{entity_id}:cancelled:{recipient}` |
| volunteer.registered | volunteer_registered | normal | inapp, email | — | no | `volunteer:{entity_id}:{recipient}` |
| membership.renewal_due | membership_renewal | important | inapp, email, whatsapp | — | no | `membership:{entity_id}:renewal:{vars.renewalDate}` |

`{recipient}` is `d{devotee_id}` or `p{sha1(phone) first 12}` for a guest.
`payment.*`, `event.registered`, `event.cancelled`, `volunteer.registered` and
`membership.renewal_due` have **no caller yet** — the site has no payment
gateway, event registration, volunteer or membership module. They are complete
and tested so the day such a module lands it calls one function.

Broadcast reminders (events, poojas) are not per-devotee events: the worker
creates an automatic campaign for them (§5.9).

### 5.6 Preferences

```php
function notifyPrefs(int $devoteeId): array;
// ['lang' => 'ta', 'timezone' => ?string, 'effectiveTimezone' => string,
//  'channels' => ['inapp' => bool, 'email' => bool, 'whatsapp' => bool, 'sms' => bool, 'push' => bool],
//  'muted' => [category keys], 'promotional' => bool, 'unsubscribed' => bool, 'updatedAt' => ?iso]

function notifySavePrefs(int $devoteeId, array $input): array;
// Input keys as above (partial allowed). Validates lang against notifyLanguages(),
// timezone against timezone_identifiers_list(). Silently drops unmutable and unknown
// categories from `muted`. promotional true sets promotional_opt_in_at (keeps the
// first consent time), false clears it. Turning email back on clears unsubscribed_at.
// Returns notifyPrefs(). Throws InvalidArgumentException(message) on an invalid lang/timezone.
```

### 5.7 Queue, worker, dispatch

```php
function notifyDispatchDelivery(int $deliveryId, array $secretVars = []): array;
// Loads the delivery + notification + recipient + devices, re-renders the channel
// variant from template_key + vars (+ secretVars), builds NotifyMessage, calls the
// provider, applies the result. Returns ['status' => new status, 'reason' => ?string,
// 'recordedOnly' => bool, 'providerMessageId' => ?string].

function notifyWorkerRun(array $opts = []): array;
// opts: max_seconds (50), batch (100), channels (all external), notification_ids (int[]),
//       campaign_id (?int), skip_campaigns (bool), skip_reminders (bool), trigger ('cli'|'http'),
//       now (UTC string — tests only, honoured only when NOTIFY_ALLOW_TEST_DRIVER=1)
// Returns ['run_id','claimed','sent','failed','dead','rejected','skipped',
//          'campaigns_expanded','reminders_created','duration_ms','locked'(bool: another run held the lock)]

function notifyRequeue(int $deliveryId, string $actor): bool;   // dead|failed|rejected → queued, attempts 0, audited
function notifyApplyProviderUpdate(string $provider, string $messageId, string $status, ?string $error = null, ?string $at = null): int;
function notifyRecordClick(int $deliveryId): void;              // clicked_at once; in-app also marks read
function notifyRecordOpen(int $deliveryId): void;               // email read_at once
```

Worker run, in order:

1. `GET_LOCK('temple_notify_worker', 0)`; if not obtained return `locked => true`.
2. Insert a `notification_worker_runs` row.
3. Recover stale claims: `sending` with `claimed_at` older than 10 minutes →
   `queued`, delivery event `requeued` ("worker interrupted").
4. Expand due campaigns (§5.8) unless `skip_campaigns`.
5. Reminders (§5.9) unless `skip_reminders`; at most once every 15 minutes
   (`notification_kv('reminders_last_run')`).
6. Claim loop until the time budget ends. Per channel not over its throttle:
   ```sql
   UPDATE notification_deliveries
      SET status='sending', claim_token=:t, claimed_at=UTC_TIMESTAMP(), attempts=attempts+1
    WHERE status IN ('queued','failed') AND channel=:c
      AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP())
      [AND notification_id IN (…)]
    ORDER BY priority_rank, id LIMIT :batch
   ```
   then read rows by `claim_token` and dispatch each.
7. Finish the run row (counters, duration, last error).

Retries: `retry` result → status `failed`, `next_attempt_at` = now + max(provider
`retryAfter`, backoff[attempts]) with backoff `[60, 300, 1800, 7200, 21600]`
seconds and ±10% jitter. When `attempts >= max_attempts` → `dead`.
`max_attempts`: email 5, whatsapp 5, sms 3, push 3 (set at delivery creation).
`rejected` → `rejected`. `skipped` → `skipped`.

Push results: devices reported `gone` get `is_active = 0`; any `ok` device makes
the delivery `sent`; all failed-retryable → retry; all gone → `rejected`.

Throttle per channel per minute (`NOTIFY_RATE_<CHANNEL>_PER_MIN`, defaults email
60, whatsapp 80, sms 30, push 600): count deliveries of that channel with
`sent_at` in the last 60 s; stop claiming that channel for this run when reached.

Every state change writes a `notification_delivery_events` row.

`backend/bin/notify_worker.php` (CLI only):

```
php backend/bin/notify_worker.php [--max-seconds=50] [--batch=100]
        [--channels=email,sms] [--notification-ids=1,2] [--campaign-id=9]
        [--skip-campaigns] [--skip-reminders] [--now="2026-09-13 12:00:00"] [--json]
```

Prints a one-line summary, or the result as JSON with `--json`. Exit 0 on a
completed run (including `locked`), 1 on an exception.

HTTP trigger: `backend/api/notify_cron.php`, routed at `/api/notify-cron`
(GET or POST). Requires `NOTIFY_CRON_KEY` (≥24 chars) sent as header
`X-Cron-Key` or `?key=`; compares with `hash_equals`. When the variable is unset
the endpoint answers 404. Runs `notifyWorkerRun(['trigger' => 'http', 'max_seconds' => 25])`
and returns the counters as JSON.

### 5.8 Campaigns

```php
function notifyCampaignSave(array $input, array $actor, ?int $id = null): array;
// actor: ['username' => …, 'role' => 'owner'|'editor'|'viewer']
// input: name, category, priority, channels[], cta_url, image_url, template_key, template_vars,
//        segment_id, audience (rules array), translations => ['ta' => ['title','body','cta_label'], 'en' => …],
//        schedule_tz ('temple'|'recipient'), scheduled_local ('Y-m-d H:i' or null), recurrence, recur_until
// Validates everything; at least one translation with title and body; channels non-empty.
// Saving a campaign in review/approved/scheduled returns it to draft (approval is void) — audited.
// Only draft/review/approved/scheduled campaigns are editable.
// Returns ['ok' => bool, 'id' => ?int, 'errors' => [field => message]]

function notifyCampaignGet(int $id): ?array;
// row + 'translations' => [lang => …] + 'rules' (resolved: segment's or own) + 'channelsList' + 'stats'

function notifyCampaignNeedsApproval(array $campaign, int $estimate): ?string;
// Returns the reason, or null when no second approval is needed:
//   estimate > NOTIFY_APPROVAL_THRESHOLD (default 50) → "Reaches N devotees"
//   priority urgent or emergency                      → "Urgent/emergency priority"
//   channels include whatsapp or sms and estimate > 10 → "Paid channels to N devotees"
//   category kind promotional                         → "Promotional message"

function notifyCampaignTransition(int $id, string $action, array $actor, array $opts = []): array;
// Returns ['ok' => bool, 'status' => new status, 'message' => human text, 'id' => ?int (duplicate)]
```

| action | from | to | who (capability) | notes |
| --- | --- | --- | --- | --- |
| submit | draft | review, or approved when no approval is needed | notifications.compose | estimates now; stores estimated_count, requires_approval, approval_reason. Auto-approval is audited as approved by `system` with the reason "below approval threshold". |
| approve | review | approved | notifications.approve | approver ≠ created_by, unless `NOTIFY_ALLOW_SELF_APPROVAL=1` or no other active owner exists |
| reject | review | draft | notifications.approve | `opts['reason']` required |
| schedule | approved | scheduled | notifications.compose | needs scheduled_local in the future; sets scheduled_at / next_run_at |
| send_now | approved | sending | notifications.compose | next_run_at = now |
| emergency_send | draft, review, approved | sending | notifications.approve | priority must be emergency; `opts['reason']` required; audited `emergency_override` |
| cancel | draft, review, approved, scheduled, sending | cancelled | compose (own drafts) / approve (others') | queued deliveries of this campaign → cancelled |
| duplicate | any | new draft | notifications.compose | copies translations/audience/channels; name + " (copy)"; no schedule |

Every transition writes `notification_audit` with the campaign snapshot.

Expansion (worker): a campaign is due when status is `approved`/`scheduled`
with `next_run_at <= now` (recipient-timezone campaigns: `next_run_at - 14h`),
or `sending` with expansion unfinished. Mark `sending`, set `started_at` on the
first batch, then for devotees in the audience with `id > expand_cursor` in
batches of 500 (within the time budget): render per recipient language and call
`notify()` with `campaign_id`, `run_no = run_count + 1`,
`dedupe_key = "campaign:{id}:{run}:{devotee_id}"`, and for recipient mode
`deliver_after` = the scheduled local time in that devotee's timezone converted
to UTC. Advance `expand_cursor`. When no devotees remain: `run_count++`,
`recipient_count +=`, `expand_cursor = 0`; if recurrence and the next occurrence
≤ `recur_until` → status `scheduled` with the next `next_run_at`, else mark
`completed` once no delivery of the campaign is `queued`/`sending`/`failed`
(checked on later runs).

Recurrence: daily +1 day, weekly +7 days, monthly same day next month (clamped
to the month's last day), computed on the wall-clock time in the schedule's
timezone.

```php
function notifyCampaignPreview(array $campaign, string $channel, string $lang, ?int $sampleDevoteeId = null): array;
// ['title','body','html'(email only),'cta_label','cta_url','provider_template','params',
//  'sms' => ['chars' => int, 'segments' => int, 'encoding' => 'GSM-7'|'UCS-2'] (sms only),
//  'missing' => []]
// $campaign is a notifyCampaignGet() row or unsaved input in the same shape.

function notifyCampaignTestSend(int $id, array $actor, array $to): array;
// to: ['email' => ?, 'phone' => ?, 'devotee_id' => ?]. Sends the campaign as it stands to that one
// recipient immediately (sync), ignoring the audience and the approval state, with the title
// prefixed "[TEST] ". dedupe_key "test:{campaign}:{sha1(to)}:{minute}". Audited test_sent.

function notifyCampaignStats(int $id): array;
// ['recipients','byChannel' => [channel => [status => count]], 'opened','clicked','read','failed','dead']

function notifyAudit(?int $campaignId, string $action, array $actor, array $detail = []): void;  // never throws
```

### 5.9 Reminders (worker)

- **Booking reminders**: `seva_bookings` with `status = 'confirmed'` and
  `preferred_date` = tomorrow in the temple timezone, once the temple-time clock
  is past 17:00 → `notifyEvent('booking.reminder', …)` for the booking's account,
  or for the guest phone when it has no account.
- **Event and pooja reminders**: `events` (`is_active = 1`, `event_date` =
  tomorrow) and `poojas` (`is_active = 1`, `pooja_date` = tomorrow), after 17:00
  temple time → one automatic campaign each: name
  `Reminder: <title> (automatic)`, `created_by = 'system'`, status `approved`,
  `requires_approval = 0`, channels `inapp,push`, priority `normal`, category
  `event` / `pooja`, template `event_reminder` / `pooja_reminder`, audience
  `{"mode":"rules","match":"all","rules":[{"field":"category_not_muted","op":"is","value":"event"}]}`,
  `template_vars` including `"reminderKey": "event:<id>:<date>"`. Before
  creating, check no campaign has that `reminderKey`
  (`JSON_UNQUOTE(JSON_EXTRACT(template_vars, '$.reminderKey'))`). Expansion then
  handles scale exactly as for an admin campaign.

### 5.10 Tracking, unsubscribe, CTA safety

```php
function notifyToken(string $kind, int $id): string;       // kind: 'c' click (delivery id), 'o' open (delivery id), 'u' unsubscribe (devotee id)
function notifyTokenVerify(string $token): ?array;         // ['kind' => …, 'id' => int] or null
function notifyTrackedUrl(int $deliveryId, ?string $target): ?string;   // siteUrl('/api/n/c/<token>'), or null when no target
function notifyOpenPixelUrl(int $deliveryId): string;      // siteUrl('/api/n/o/<token>')
function notifyUnsubscribeUrl(int $devoteeId): string;     // siteUrl('/api/n/u/<token>')
function notifyPreferencesUrl(): string;                   // siteUrl('/account?tab=notifications')
function notifySafeCtaUrl(?string $url): ?string;          // '/path…' (not '//') or 'https://…'; anything else null
```

Token format: `<kind><id>.<sig>` where `sig` = base64url of the first 12 bytes
of `HMAC-SHA256(kind . id, notifySecret())`. Regex:
`^[cou][0-9]{1,10}\.[A-Za-z0-9_-]{16}$`. Tokens do not expire; rotating
`NOTIFY_SECRET` invalidates them all.

Email deliveries to devotees in informational/promotional categories carry
`List-Unsubscribe: <unsubscribe_url>` and
`List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Security and transactional
emails carry the preferences link only.

### 5.11 Audience

```php
function notifyAudienceFields(): array;                    // for UI builders, see below
function notifyAudienceNormalize(array $rules): array;     // throws InvalidArgumentException(message)
function notifyAudienceQuery(array $rules): array;         // ['sql' => 'SELECT d.id FROM devotees d … ORDER BY d.id', 'params' => [...]]
function notifyAudienceCount(array $rules): int;
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

Every query excludes `is_active = 0`. `selected` is capped at 5000 ids.

| field | ops | value |
| --- | --- | --- |
| country | in, not_in | ISO2[] |
| state | in, not_in | string[] (as stored, e.g. "TN") |
| city | contains, equals | string (case-insensitive) |
| lang | in | language codes (from prefs; no prefs row counts as 'ta') |
| email_verified | is | bool |
| phone_verified | is | bool |
| registered_days | lte, gte | int (days since created_at) |
| last_login_days | lte, gte | int |
| has_booking | is | bool |
| booked_seva | in | seva ids |
| booking_status | in | pending, confirmed, completed, cancelled |
| booking_days | lte | int (a booking created within N days) |
| has_donated | is | bool |
| donated_total | gte, lte | number (sum of donations.amount) |
| donated_days | lte | int |
| tag | in, not_in | tag strings |
| channel_enabled | in | channel names (pref on; no row = on) |
| category_not_muted | is | category key |

`notifyAudienceFields()` returns `field => ['label' => …, 'ops' => […], 'type' => 'iso2list'|'strlist'|'string'|'bool'|'int'|'number'|'idlist'|'enum', 'options' => [...]|null]`
where `options` are filled for `lang`, `booking_status`, `booked_seva` (from `sevas`),
`channel_enabled`, `category_not_muted`, `tag` (distinct tags in use).

Groups named in the brief map onto this: all devotees → `all_devotees`;
individual/selected → `selected`; donors → `has_donated`; booking customers →
`has_booking`; registered users → `email_verified`; volunteers, members,
interests, devotee categories, event participants → `tag` (committee applies
tags in the admin); geography → country/state/city; language → lang;
preferences → channel_enabled / category_not_muted.

### 5.12 Devices, OTP

```php
function notifyRegisterDevice(int $devoteeId, array $subscription, string $platform = 'web', ?string $userAgent = null): array;
// subscription: ['endpoint' => https URL ≤2000, 'keys' => ['p256dh' => b64url 87 chars, 'auth' => b64url 22 chars]]
// Upserts by sha256(endpoint); re-assigns an endpoint to the current devotee (a shared browser).
// Returns ['ok' => bool, 'id' => ?int, 'error' => ?string]
function notifyRemoveDevice(int $devoteeId, string $endpoint): bool;
function notifyVapidPublicKey(): ?string;
// VAPID_PUBLIC_KEY env; else, only when NOTIFY_PUSH_DRIVER is webpush|log and no env keys exist,
// a development key pair generated once into notification_kv (vapid_public, vapid_private).

function notifyOtpIssue(int $devoteeId, string $phone, string $purpose = 'phone_verify'): array;
// 6-digit code from random_int, HMAC-SHA256 with notifySecret(), 10-minute expiry, retires earlier
// unconsumed codes. Limits: 3 issues per 15 minutes and 10 per day per devotee.
// Sends notifyEvent('phone.otp', ['devotee_id' => …, 'to_phone' => $phone,
//   'secret_vars' => ['otpCode' => …], 'vars' => ['expiresMinutes' => 10]]).
// Returns ['ok' => bool, 'channel' => 'sms'|'whatsapp'|null, 'expiresIn' => 600,
//          'error' => ?string, 'code' => ?'rate_limited'|'unavailable', 'retryAfter' => ?int]
function notifyOtpVerify(int $devoteeId, string $phone, string $code, string $purpose = 'phone_verify'): array;
// Constant-time compare; 5 attempts per code; on success consumes it and sets devotees.phone_verified_at.
// Returns ['ok' => bool, 'error' => ?string, 'attemptsLeft' => ?int]
```

---

## 6. HTTP API

All JSON unless stated. Devotee endpoints need the devotee session
(401 `{"error","code":"unauthenticated"}`); every POST needs `X-CSRF-Token`
(419 `code: csrf`). Tables missing → 503 `{"code":"notifications_disabled"}`.
Unknown action → 404 before auth.

### 6.1 `backend/api/notifications.php` — `/api/notifications/<action>`

Dispatched by `api/index.php` with `$notificationsAction`.

**Item shape** (every list and panel):

```json
{
  "id": 12, "title": "…", "body": "…",
  "category": "booking", "categoryLabel": { "ta": "சேவை பதிவு", "en": "Booking" },
  "icon": "calendar-check", "priority": "important",
  "ctaUrl": "/account?tab=bookings", "ctaLabel": "View booking", "imageUrl": null,
  "createdAt": "2026-09-13T04:05:06Z", "readAt": null, "archivedAt": null,
  "isRead": false, "isArchived": false,
  "entity": { "type": "seva_booking", "id": 91 }
}
```

Only the signed-in devotee's rows with `show_in_app = 1`, `deleted_at IS NULL`
and `deliver_after` null or past.

| method | action | request | response |
| --- | --- | --- | --- |
| GET | list | `?status=all\|unread\|read\|archived` (all = not archived), `category=a,b`, `q` (≤100, title+body), `from`/`to` (`YYYY-MM-DD` in the devotee's effective timezone), `cursor`, `limit` (1–50, default 20) | `{ "items": [Item], "nextCursor": ?string, "unread": int }` — newest first; cursor is opaque base64url of `createdAt\|id` |
| GET | unread | — | `{ "unread": int, "latestId": ?int, "latestAt": ?iso }`, `Cache-Control: no-store` |
| GET | categories | — | `[{ "key", "label": {ta,en}, "icon", "kind", "mutable", "defaultOn" }]` |
| GET | prefs | — | see below |
| POST | prefs | `{ lang?, timezone?, channels?: {…}, muted?: [], promotional?: bool }` | `{ "ok": true, "prefs": …, "message": "Your notification settings are saved." }`; 422 `{error, fields}` |
| POST | read | `{ "ids": [int] }` (≤200) | `{ "ok", "updated", "unread" }` |
| POST | unread | `{ "ids" }` | same |
| POST | read-all | `{}` | same |
| POST | archive | `{ "ids" }` | same |
| POST | unarchive | `{ "ids" }` | same |
| POST | delete | `{ "ids" }` (soft: sets deleted_at) | same |
| POST | click | `{ "id" }` | `{ "ok", "url": ?string, "unread" }` — marks read and records the in-app click |
| POST | devices | `{ "subscription": {endpoint, keys}, "platform": "web" }` | `{ "ok", "deviceId" }` / 422 |
| POST | devices-remove | `{ "endpoint" }` | `{ "ok" }` |

`GET prefs` response:

```json
{
  "prefs": { "lang": "ta", "timezone": null, "effectiveTimezone": "Asia/Kolkata",
             "channels": { "inapp": true, "email": true, "whatsapp": true, "sms": true, "push": true },
             "muted": [], "promotional": false, "unsubscribed": false },
  "categories": [ { "key", "label", "icon", "kind", "mutable", "defaultOn" } ],
  "channels": {
    "inapp":    { "available": true },
    "email":    { "available": true,  "reason": null },
    "whatsapp": { "available": false, "reason": "no phone" | "not configured" | null },
    "sms":      { "available": true,  "reason": null },
    "push":     { "available": true,  "reason": null, "publicKey": "BF…", "devices": 1 }
  },
  "languages": [ { "code": "ta", "label": "தமிழ்" } ],
  "phone": { "number": "+919876543210", "verified": false }
}
```

POST rate limit: 120 per minute per devotee (`rateLimitAllow('notif-post', 120, 60, 'd'.$id)`).

### 6.2 `backend/api/n.php` — tracking and unsubscribe

Routed by `api/index.php` for `/api/n/<kind>/<token>` with `$trackKind` and
`$trackToken` (kind `c|o|u`, token per §5.10; anything else 404).

- `GET /api/n/c/<token>` → `notifyRecordClick`, `302` to the notification's CTA
  (relative paths via `siteUrl()`); invalid token or no CTA → `302 siteUrl('/')`.
- `GET /api/n/o/<token>` → `notifyRecordOpen`, `200 image/gif` 1×1,
  `Cache-Control: no-store, private`. Invalid tokens still get the GIF.
- `GET /api/n/u/<token>` → a small bilingual HTML page (site colours, no JS)
  explaining what unsubscribing does, with a POST button. **GET never changes
  anything** (mail scanners follow links).
- `POST /api/n/u/<token>` (form button, or RFC 8058 one-click body
  `List-Unsubscribe=One-Click`) → sets `unsubscribed_at`, mutes every mutable
  category for email, answers a confirmation page with a link to the
  preferences page. Idempotent.

### 6.3 `backend/api/notify_webhook.php` — `/api/notify-webhook/<driver>`

Routed with `$webhookDriver` (`meta|twilio|msg91|fcm|test`, any method). Finds
the channel(s) whose configured driver matches, calls `handleWebhook()`, applies
each update with `notifyApplyProviderUpdate()`, answers the provider's expected
body and status. Signature failures → 403 and an `error_log` line (no body
detail). Always fast: no sending from inside a webhook.

### 6.4 `/api/notify-cron` — see §5.7.

### 6.5 Account additions (triggers agent, `backend/api/account.php`)

| method | action | request | response |
| --- | --- | --- | --- |
| POST | phone-verify-start | `{}` (uses the saved profile phone) | `{ ok, channel, expiresIn, message }`; 422 no phone; 429 `code rate_limited` + `retryAfter`; 503 `code otp_unavailable` |
| POST | phone-verify-confirm | `{ "code": "123456" }` | `{ ok, user, message }`; 422 `{ error, fields: { code }, attemptsLeft }` |

`devoteePublic()` gains `"phoneVerified": bool`. Saving a different phone number
on the profile clears `phone_verified_at`.

### 6.6 Routing (`backend/api/index.php`, API agent)

Add, without disturbing existing routes:

- group `'/notifications/' => ['file' => 'notifications.php', 'var' => 'notificationsAction']`
- `/n/<c|o|u>/<token>` → `n.php` (before the generic groups; exact regex)
- `/notify-webhook/<driver>` → `notify_webhook.php` (`$webhookDriver`, `^[a-z0-9]{2,16}$`)
- `/notify-cron` (GET, POST) → `notify_cron.php`

`n.php` and `notify_webhook.php` answer HTML/GIF/provider bodies, so they set
their own `Content-Type` and must not rely on the JSON exception handler for
normal responses.

---

## 7. Frontend

### 7.1 NotificationContext (`frontend/src/context/NotificationContext.jsx`)

Mounted in `main.jsx` inside `AuthProvider`, around `App`.

```js
const {
  enabled,        // signed in, accounts enabled, and the API did not answer 503
  unread,         // number
  latest,         // Item[] — newest 10, for the panel
  status,         // 'idle' | 'loading' | 'ready' | 'error'
  error,          // AuthError | null
  refresh,        // () => Promise — unread + latest
  markRead,       // (ids) => Promise
  markUnread,     // (ids) => Promise
  markAllRead,    // () => Promise
  archive,        // (ids) => Promise
  unarchive,      // (ids) => Promise
  remove,         // (ids) => Promise  (soft delete)
  open,           // (item) => Promise<url|null> — POST click, then the caller navigates
} = useNotifications();
```

- Poll `GET /notifications/unread` every 30 s while `document.visibilityState === 'visible'`;
  when `latestId` changes, fetch `list?limit=10`. Refresh on window focus and on
  `online`. Stop entirely when signed out.
- Optimistic updates for read/unread/archive/delete with rollback + toast on failure.
- Cross-tab: `BroadcastChannel('temple-notifications')` posting `{ type: 'changed' }`
  after every mutation; other tabs refresh.
- Service worker messages: `{ type: 'notification-received', notificationId }`
  → refresh immediately.
- Uses `useAuth().get/post` so CSRF and error shapes match the rest of the site.

### 7.2 Helpers (`frontend/src/lib/notifications.js`)

```js
export const CATEGORY_ICONS;                 // category key → lucide-react-icons component (react-icons/lu)
export function iconFor(item);               // by item.icon then category, fallback LuBell
export function groupByTime(items, now = new Date()); // [{ key: 'today'|'yesterday'|'week'|'earlier', items }]
export function relativeTime(iso, lang, now = new Date());
export function isInternalPath(url);         // '/…' but not '//'
```

### 7.3 Bell, panel, page

- `components/Notifications/NotificationBell.jsx` — rendered by `Layout.jsx`
  immediately before the account avatar, **signed-in devotees only**. A
  `navbar__icon-btn`-sized round button (`.notif-bell`) with an unread count
  badge (`.notif-bell__count`, "9+" above nine; hidden at zero; announced via
  the button's accessible name "Notifications, 3 unread"). Subtle ring animation
  when the count increases (disabled under `prefers-reduced-motion`).
- `components/Notifications/NotificationPanel.jsx` — opens from the bell. ≥640 px:
  a popover anchored under the bell (`role="dialog"`, `aria-label`, focus moves
  in, Escape and outside click close, focus returns to the bell). <640 px: a
  bottom sheet via the existing `Modal`. Header with "Mark all as read"; list of
  latest 10 (`NotificationItem`); footer "View all notifications" → `/notifications`.
  Loading skeleton, empty state ("You're all caught up"), error state with retry.
- `components/Notifications/NotificationItem.jsx` — shared by panel and page:
  category icon tile, title, 2-line body, relative time (`<time dateTime>` with
  full date in `title`), category chip, priority badge for important+, unread
  dot + bold title, actions menu (mark read/unread, archive/unarchive, delete).
  Clicking the item calls `open(item)` then navigates: internal paths with
  `useNavigate`, https URLs in a new tab with `rel="noopener noreferrer"`.
- `pages/Notifications.jsx` at `/notifications` (inside `RequireAuth`, lazy):
  `<Seo title robots="noindex, nofollow" />`, a compact header, toolbar with
  search (debounced 300 ms), status segmented control (All / Unread / Read /
  Archived), category chips (multi-select), date range (from/to), bulk select
  with "Mark read", "Archive", "Delete" (with confirm), grouped sections
  Today / Yesterday / This week / Earlier, infinite scroll
  (`IntersectionObserver` sentinel) with a "Load more" button fallback, and
  loading / empty / filtered-empty / error states. Filters live in the URL query.
- Mobile drawer (`Layout.jsx` → `DrawerAccount`): a "Notifications" row with the
  count, for signed-in devotees.

### 7.4 Preferences and push

- `components/Notifications/NotificationPreferences.jsx` — the "Notifications"
  tab of `/account` (`?tab=notifications` opens it; `Account.jsx` reads the
  query param for every tab). Sections: channels (switches with availability
  reasons — "Add a phone number", "Not available yet" for unconfigured
  providers), categories (mutable ones as switches; transactional/security shown
  as locked "Always on" with a short explanation), language, timezone,
  promotional consent, and push on this device. Save with toast; unsaved-change
  guard.
- `hooks/usePushSubscription.js` → `{ supported, reason, permission, subscribed, busy, error, subscribe, unsubscribe }`.
  Supported needs `serviceWorker`, `PushManager`, `Notification` and an active
  registration (the PWA registers one in production; in `vite dev` there is
  none, so `supported = false, reason = 'service-worker-inactive'`). iOS outside
  an installed home-screen app → `reason = 'ios-install-required'` with guidance.
  Denied permission → explain how to re-enable in browser settings.
- `frontend/public/push-sw.js`, loaded by the generated service worker through
  `workbox.importScripts: ["push-sw.js"]` in `vite.config.js`:
  - `push`: payload JSON `{ title, body, url, trackUrl, notificationId, category, priority, tag, image, icon }`
    → `showNotification(title, { body, icon: '/icons/icon-192x192.png', badge: '/icons/icon-192x192.png', image, tag, renotify: true, requireInteraction: priority is urgent|emergency, data: { url, trackUrl, notificationId } })`,
    then `postMessage({ type: 'notification-received', notificationId })` to every client.
  - `notificationclick`: close, then focus an open same-origin client and
    navigate it to `url`, else `openWindow(trackUrl || url)`.

### 7.5 Styling

Glass surfaces, maroon/gold tokens, `--radius-*`, `--space-*`, `--shadow-*`,
existing `.btn`, `.chip`, `.badge`, `.menu`, `.card`, `.skeleton` classes.
Component CSS files next to their components. Touch targets ≥ 44 px on mobile.
Test at 390, 768, 1024, 1440 px: no horizontal overflow; the signed-in header
must still fit at every width `tests/public-e2e.mjs` checks (390–1920).

---

## 8. Admin

### 8.1 Capabilities (`backend/includes/auth.php`, admin campaigns agent)

Add to `ADMIN_CAPABILITIES`:

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

### 8.2 Navigation (`admin_layout.php`, admin campaigns agent)

New group `'Communication'` after `'Devotees'`:

```php
'notifications.php'          => ['bell',     'Notifications',     'Campaigns, broadcasts and scheduling'],
'notification_templates.php' => ['mail',     'Message Templates', 'Wording of every automated message'],
'notification_segments.php'  => ['users',    'Audiences',         'Saved devotee segments'],
'notification_analytics.php' => ['activity', 'Delivery Analytics','Sends, opens, clicks and failures'],
```

and in `<head>` after `admin.css`:
`<link rel="stylesheet" href="/admin/assets/notify-campaigns.css" />` and
`<link rel="stylesheet" href="/admin/assets/notify-content.css" />`.
Quick actions: "New notification" (compose) and "Delivery analytics" (view).

### 8.3 Pages

**notifications.php** (campaigns agent) — list with status chips and counts,
search, per-row stats (recipients, sent, failed), row menu (edit, duplicate,
cancel, audit). Composer: name, category, priority, channels (checkbox cards
with provider configured/not configured), translations (Tamil and English tabs,
"Add language" for any `notifyLanguages()` code), CTA URL + label, image URL,
audience (saved segment select, or rules builder from
`admin/includes/notify_audience_form.php`, or selected devotees with search),
live recipient estimate, schedule (send on approval / at a time, temple or
recipient timezone, recurrence + until), multi-channel preview (in-app card,
email in a sandboxed `iframe srcdoc`, WhatsApp bubble with template name and
params, SMS text with character and segment count, push card), test send to
yourself, save draft, submit, approve/reject (owner), schedule, send now,
emergency send (owner, reason required), cancel, duplicate. Approval banner
showing the reason and who can approve. Audit timeline and per-channel delivery
stats on the campaign view. JSON sub-endpoints on the same page:
`POST action=estimate` → `{ "count" }`, `POST action=preview` → `notifyCampaignPreview()`
(both CSRF-checked). Behaviour in `assets/notify-campaigns.js`, styles in
`assets/notify-campaigns.css`.

**notification_segments.php** (campaigns agent) — saved segments CRUD with the
same rules builder, estimate, "used by N campaigns", delete blocked while a
scheduled/sending campaign uses it.

**notification_templates.php** (content agent) — every template key from
defaults merged with DB rows; filter by category, language, channel,
customised/default; editor for (key, lang, channel): title, body, CTA label,
provider template name + ordered params, variable chips that insert at the
cursor, warnings for unknown or missing variables, live preview (email iframe,
SMS count, WhatsApp bubble) with sample variables, "Reset to built-in". Owner
only for writes (`notifications.templates`), audited `template_saved`.
Categories section: edit labels, icon, sort, active, default-on; add a new
informational or promotional category; built-in kinds read-only. Audited
`category_saved`. Assets: `notify-content.js/.css`.

**notification_analytics.php** (content agent) — filters: date range (temple
timezone), channel, campaign, category, source (automated / campaign / segment
id), status. KPIs: notifications created, deliveries sent, delivered, failed
(failed+rejected+dead), email open rate, in-app read rate, click-through rate,
WhatsApp delivery rate, SMS delivery rate, push engagement. Daily sends
(`adminBars`), channel shares (`adminShares`), channel performance table,
campaign performance table (sent/delivered/opened/clicked/failed per campaign),
worker health card (last run, ago, last error, queue depth by channel, dead
count; warning when the last run is older than 5 minutes), failed/dead
deliveries table with provider response (already redacted) and **Requeue**
(`notifyRequeue`, CSRF, `notifications.compose`), CSV export of the filtered
deliveries. Rates show "—" when the denominator is zero, never NaN.

**devotees.php tags** (content agent) — tag editor in the existing edit panel
(add/remove, lowercase `[a-z0-9:_-]{1,40}`, suggestions from tags in use), a
tag filter on the list, tags column. Audited through `adminAudit`.

**Announcements hook** (triggers agent, `announcements.php`) — a checkbox
"Also notify devotees" on create; when ticked, after saving, create a draft
campaign (category `announcement`, template `announcement`, translations from
the title/body in both languages, channels `inapp,push`) and flash a link to it.
Nothing is sent without going through the campaign flow.

**Bookings and donations** (triggers agent) — `admin/seva_bookings.php`
single and bulk status changes fire `booking.confirmed` / `booking.cancelled` /
`booking.completed` (deduped, so re-applying a status is harmless);
`admin/donations.php` gains a "Send receipt" row action firing `donation.receipt`
with `sequence` = the number of receipts already sent + 1.

---

## 9. File ownership (build phase)

Each file has exactly one owner. Anything not listed is read-only for everyone.

| agent | owns |
| --- | --- |
| **core** | `backend/includes/notify.php`; `backend/includes/notify/*.php` except `contracts.php`, `providers/` and the three content files below (suggested split: `time.php`, `events.php`, `prefs.php`, `service.php`, `queue.php`, `campaigns.php`, `audience.php`, `reminders.php`, `tracking.php`, `devices.php`, `otp.php`, `categories.php`); `backend/bin/notify_worker.php`; `backend/api/notify_cron.php`; `tests/notify-unit.php`; `tests/notify-worker.mjs`; `tests/support/notify_core_harness.php`; any `tests/support/notify_cron_router.php` |
| **core-content** | `backend/includes/notify/templates.php` (`notifyTemplate`, `notifyInterpolate`, `notifyRender`, `notifySmsInfo`, `notifyTemplateSample`); `backend/includes/notify/defaults.php` (`notifyTemplateDefaults`, `notifyTempleFacts`); `backend/includes/notify/email.php` (`notifyEmailHtml`, `notifyEmailText`); `tests/notify-templates-unit.php` |
| **providers** | `backend/includes/notify/providers/*.php`; the registry map in `contracts.php` **only if a class name must change** (report it); `backend/includes/mailer.php` (extra headers support for `sendMail`, backward compatible); `backend/api/notify_webhook.php`; `backend/bin/notify_keys.php` (VAPID and FCM helpers); `tests/support/notify_provider_harness.php`; `tests/notify-providers.mjs` |
| **api** | `backend/api/notifications.php`; `backend/api/n.php`; `backend/api/index.php` (routes in §6.6 only); `tests/notifications-api.mjs` |
| **triggers** | `backend/api/auth.php`; `backend/api/account.php`; `backend/api/seva_bookings.php`; `backend/api/donations.php`; `backend/includes/devotee_auth.php`; `backend/admin/seva_bookings.php`; `backend/admin/donations.php`; `backend/admin/announcements.php`; `tests/notify-triggers.mjs`; keeps `tests/devotee-auth.mjs` and `tests/accounts-ui.mjs` passing (may update their assertions only where behaviour intentionally changed, and must say so) |
| **bell** | `frontend/src/context/NotificationContext.jsx`; `frontend/src/lib/notifications.js`; `frontend/src/components/Notifications/NotificationBell.jsx`, `NotificationPanel.jsx`, `NotificationItem.jsx`, `Notifications.css`; `frontend/src/pages/Notifications.jsx`, `Notifications.css`; `frontend/src/main.jsx`; `frontend/src/App.jsx`; `frontend/src/components/Layout/Layout.jsx`, `Layout.css`; `tests/support/notify_seed.mjs` (optional); `tests/notifications-ui.mjs` |
| **prefs** | `frontend/src/components/Notifications/NotificationPreferences.jsx`, `NotificationPreferences.css`; `frontend/src/hooks/usePushSubscription.js`; `frontend/public/push-sw.js`; `frontend/vite.config.js` (`workbox.importScripts` only); `frontend/src/pages/Account.jsx`, `Account.css` (the tab, `?tab=` support, phone verification UI in Profile); `tests/notify-prefs-ui.mjs` |
| **admin-campaigns** | `backend/admin/notifications.php`; `backend/admin/notification_segments.php`; `backend/admin/includes/notify_audience_form.php`; `backend/admin/includes/admin_layout.php` (§8.2); `backend/admin/includes/admin_ui.php` (new icons only); `backend/includes/auth.php` (§8.1); `backend/admin/assets/notify-campaigns.css`, `notify-campaigns.js`; `tests/admin-smoke.mjs` (add the four pages); `tests/admin-notifications.mjs` |
| **admin-content** | `backend/admin/notification_templates.php`; `backend/admin/notification_analytics.php`; `backend/admin/devotees.php` (tags); `backend/admin/assets/notify-content.css`, `notify-content.js`; `tests/admin-notify-content.mjs` |

Phase 1 (core, core-content, providers) runs first. Phase 2 (api, triggers,
admin-campaigns, admin-content) starts when phase 1 is finished. Phase 3 (bell,
prefs) starts when api and triggers are finished, because the devotee UI calls
their endpoints. Every later phase builds on the real code — read it, do not
re-implement it.

### Definition of done (every agent)

1. Every public name and shape in this document that you own exists and matches.
2. `php.sh -l` clean for every PHP file you touched; `npm run audit` 0 actionable
   if you touched `frontend/src` or `backend/admin`.
3. Your test suite exists, passes, is re-runnable twice in a row, sends a unique
   `X-Forwarded-For`, scopes worker runs to its own rows, and cleans up.
4. Existing suites that exercise files you touched still pass (name them and
   give the counts).
5. Your final report lists: files created/changed, test commands with pass/fail
   counts, every deviation from this spec, and anything left undone and why.

---

## 10. Environment variables

| variable | default | used by |
| --- | --- | --- |
| NOTIFY_SECRET | generated into notification_kv | token signing, OTP hashing (set ≥32 random chars in production) |
| NOTIFY_TEMPLE_TZ | Asia/Kolkata | reminders, admin display, temple-time schedules |
| NOTIFY_LANGUAGES | ta,en,hi,te,ml,kn | template and campaign languages |
| NOTIFY_APPROVAL_THRESHOLD | 50 | campaign approval rule |
| NOTIFY_ALLOW_SELF_APPROVAL | 0 | single-committee deployments |
| NOTIFY_CRON_KEY | unset (endpoint 404) | HTTP worker trigger |
| NOTIFY_RATE_EMAIL_PER_MIN / _WHATSAPP_ / _SMS_ / _PUSH_ | 60 / 80 / 30 / 600 | worker throttle |
| NOTIFY_EMAIL_DRIVER | mailer | mailer · log · test |
| NOTIFY_WHATSAPP_DRIVER | log | meta · twilio · log · test |
| NOTIFY_SMS_DRIVER | log | twilio · msg91 · log · test |
| NOTIFY_PUSH_DRIVER | log | webpush · fcm · log · test |
| NOTIFY_ALLOW_TEST_DRIVER | 0 | enables the test driver (never in production) |
| NOTIFY_TEST_WEBHOOK_SECRET | test-webhook-secret | test driver webhooks |
| MAIL_TRANSPORT, SMTP_*, MAIL_FROM, MAIL_FROM_NAME | existing | email via mailer.php |
| WHATSAPP_META_TOKEN, WHATSAPP_META_PHONE_NUMBER_ID, WHATSAPP_META_APP_SECRET, WHATSAPP_META_VERIFY_TOKEN, WHATSAPP_META_API_VERSION (v21.0), WHATSAPP_META_BASE_URL (https://graph.facebook.com) | — | Meta WhatsApp Cloud API; base URL overridable for tests |
| TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (whatsapp:+…), TWILIO_SMS_FROM or TWILIO_MESSAGING_SERVICE_SID, TWILIO_BASE_URL (https://api.twilio.com), TWILIO_STATUS_CALLBACK_URL (default siteUrl('/api/notify-webhook/twilio')) | — | Twilio WhatsApp and SMS |
| MSG91_AUTH_KEY, MSG91_SENDER_ID, MSG91_ROUTE (4), MSG91_DLT_ENTITY_ID, MSG91_BASE_URL (https://control.msg91.com), MSG91_WEBHOOK_TOKEN | — | MSG91 SMS (India, DLT template ids in `provider_template`) |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url raw P-256), VAPID_SUBJECT (mailto: or https:) | dev keys in notification_kv | Web Push |
| FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_JSON (path or inline JSON), FCM_BASE_URL (https://fcm.googleapis.com), FCM_TOKEN_URL (https://oauth2.googleapis.com/token) | — | Firebase Cloud Messaging HTTP v1 |
