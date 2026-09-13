# Family registration without devotee sign-in — build contract

Status: agreed 2026-09-13, revised the same day for the multi-step registration
flow (Personal → Family → Address → Review), optional family members, an
optional date of birth, the Indian PIN rule, no gender question, and a
"Spouse" relationship. This document is the contract for the change. Where it
disagrees with `docs/notifications/SPEC.md`, this document wins, and that spec
is rewritten to match (§9).

## 1. What changed, and why

The client removed devotee accounts. A devotee registers their family **once**,
with no password, and never signs in.

| Decision | Detail |
|---|---|
| Devotee sign-in | Removed completely: no passwords, sessions, email confirmation, forgot/reset password, "My Account". **Committee sign-in to `/admin` is unchanged.** |
| Registration experience | A **multi-step form**: **Personal → Family → Address → Review**, with a stepper, Next/Back, per-step validation, data kept while moving between steps, and a review page where any section can be edited before submitting (§7). |
| Personal details | **Name** and **phone** are required. **Email** and **date of birth** are optional. **Gender is not asked**, for the registrant or for family members. Preferred language (Tamil/English) is asked here too. |
| Family members | **Optional.** A family can register with no members, or add up to 20. The registrant is *not* a member row. Each member added needs a **name** and a **relationship** (Spouse, Son, Daughter… — fixed list §4); **age** is optional (0–120). |
| House/residential address | **Required**: house number and street (address line 1), city, country, and state/province when the country has a list. **Postal code is required for India** (6-digit PIN) and optional elsewhere (many countries have none). Area/landmark optional. |
| Duplicate phone | Accepted and saved. Flagged "possible duplicate" in the admin for the committee to merge, delete or clear. The person registering is never told a number is already registered. |
| Notifications | The bell, notification history, web push and devotees' own notification settings are removed. The committee keeps sending **email, WhatsApp and SMS**, governed by the **language** and the **consent tick box** (on the Review step), with an unsubscribe link in every update. |
| Updating details later | Through the temple office (admin). There is no self-service update. |

## 2. Data model (migration 009, applied)

`database/migrations/009_family_registration.sql` is the source of truth. Summary:

| Table.column | Meaning |
|---|---|
| `devotees` | One row per registered family (the registrant). Existing columns: `name`, `phone`, `phone_country`, `address1`, `address2`, `city`, `state`, `country`, `postcode`, `is_active` (0 = archived by the committee), `created_at`. |
| `devotees.date_of_birth` | DATE NULL. Optional. |
| `devotees.email` | Now NULL-able and **not unique** (index `idx_email`). |
| `devotees.pass_hash` | Now NULL-able; legacy only. Never written. |
| `devotees.duplicate_of` | Id of the earliest registration with the same phone, or NULL. FK SET NULL. |
| `devotees.lang` | `ta` or `en`, NOT NULL default `ta`. The language the temple writes in. |
| `devotees.updates_consent_at` | UTC time consent to temple updates was recorded, or NULL. |
| `devotees.updates_consent_by` | NULL = the registration form; otherwise the admin username who recorded it. |
| `devotees.unsubscribed_at` | UTC time consent was withdrawn from a message link. Wins over consent. Cleared when consent is recorded again. |
| `devotee_family_members` | `id`, `devotee_id` (FK CASCADE), `name` VARCHAR(120), `relationship` VARCHAR(32) key, `age` TINYINT NULL, `sort_order`, timestamps. |
| `seva_bookings.lang`, `donations.lang` | Site language when the form was sent (`ta`/`en`). Messages about that booking/pledge use it. |
| Legacy, still present, **never read by new code** | `devotee_tokens`, `devotee_devices`, `devotee_otps`, `devotee_notification_prefs`, `devotees.email_verified_at`, `last_login_at`, `phone_verified_at`, `seva_bookings.devotee_id`, `donations.devotee_id` (old links are kept; no new links are made). |

There is no gender column. Migration 009 also retired in-app/push data: waiting
in-app/push deliveries cancelled, open campaigns stripped of those channels,
their templates and the 8 account-only template overrides deleted, `security`
and `promotional` categories deactivated, VAPID/FCM kv rows deleted.

Always apply SQL with `--default-character-set=utf8mb4`.

## 3. Shared backend includes (already in place)

| File | Provides |
|---|---|
| `backend/includes/rate_limit.php` | `clientIp()`, `ipInAnyRange()`, `rateLimitTableExists()`, `rateLimitAllow()`, `rateLimitPeek()` |
| `backend/includes/devotee_notify.php` | `devoteeNotifyReady()`, `devoteeNotifyEvent()`, `devoteeLangFromInput()`, `devoteeNotifyLang(int $devoteeId)` (reads `devotees.lang`), `devoteeCopyLang()`, `devoteeBookingNumber()`, `devoteeReceiptNumber()`, `devoteeMoneyLabel()`, `devoteeDonationPurposeLabel()`, `devoteeBookingDateLabel()`, `devoteeIntlPhone()` |
| `backend/includes/public_guard.php` | Honeypot (`hp_token`), flood limits `PUBLIC_GUARD_LIMITS`, `publicGuardConsent()`, `publicGuardHasColumn()`. Requires `rate_limit.php`. |
| `backend/includes/notify/time.php` | `notifyTablesExist()` probes `devotees.lang, updates_consent_at, unsubscribed_at`. |

Deleted: `backend/includes/devotee_auth.php`, `backend/api/auth.php`,
`backend/api/account.php`, `backend/api/notifications.php`; the `/auth/`,
`/account/` and `/notifications/` route groups (they now answer JSON 404).

`POST /api/seva-bookings` and `POST /api/donations` accept an optional `"lang"`
(`"en"` or anything else = `"ta"`), store it, and always message the phone
number given, in that language. Nothing is linked to a registration.

## 4. Relationship list

Stored value = key. PHP constant `REG_RELATIONSHIPS` in
`backend/includes/registration.php` and JS `RELATIONSHIPS` in
`frontend/src/lib/familyRegistration.js` list exactly these, in this order.

| key | Tamil | English |
|---|---|---|
| spouse | வாழ்க்கைத் துணை (மனைவி / கணவர்) | Spouse (wife / husband) |
| son | மகன் | Son |
| daughter | மகள் | Daughter |
| father | தந்தை | Father |
| mother | தாய் | Mother |
| brother | சகோதரர் | Brother |
| sister | சகோதரி | Sister |
| grandfather | தாத்தா | Grandfather |
| grandmother | பாட்டி | Grandmother |
| grandson | பேரன் | Grandson |
| granddaughter | பேத்தி | Granddaughter |
| son_in_law | மருமகன் | Son-in-law |
| daughter_in_law | மருமகள் | Daughter-in-law |
| father_in_law | மாமனார் | Father-in-law |
| mother_in_law | மாமியார் | Mother-in-law |
| other_relative | பிற உறவினர் | Other relative |
| other | மற்றவர் | Other |

## 5. `POST /api/registrations`

File `backend/api/registrations.php`, route in `backend/api/index.php`. Shared
rules live in `backend/includes/registration.php` so the admin applies the same
validation. The multi-step form still sends **one** request, from the Review
step.

**Order:** 405 unless POST → `publicGuardLimit('registration-attempt')` →
`getJsonBody()` → honeypot → 503 if `devotee_family_members`,
`devotees.updates_consent_at` or `devotees.date_of_birth` is missing → validate
(422) → `publicGuardLimit('registration-saved')` → save in one transaction →
optional confirmation message → 201.

Limits in `PUBLIC_GUARD_LIMITS`: `registration-attempt` 15/hour,
`registration-saved` 10/hour.

**Request:**
```json
{
  "name": "S. Kumar",
  "dateOfBirth": "1978-04-21",
  "phone": "9876543210", "phoneCountry": "IN",
  "email": "",
  "lang": "ta",
  "members": [ { "name": "K. Meena", "relationship": "spouse", "age": 41 },
               { "name": "K. Arun", "relationship": "son", "age": null } ],
  "address1": "12 North Street", "address2": "",
  "city": "Pudupatti", "state": "TN", "country": "IN", "postcode": "627719",
  "consent": true,
  "hp_token": ""
}
```

**Validation.** Every read is type-guarded (a hostile array or number never
causes a 500). Lengths are counted in characters (`mb_strlen`) after trimming
and stripping tags, *before* any truncation, so an over-long value is an error,
never silently cut. A `gender` key, if sent, is ignored. The 422 key tells the
frontend which step to return to (Personal: name, dateOfBirth, phone, email,
lang; Family: members*; Address: address1, address2, city, state, country,
postcode).

| Field | Rule | 422 key |
|---|---|---|
| name | required, 2–200 | `name` |
| dateOfBirth | **optional**: missing, null or `""` → NULL. Otherwise a real `YYYY-MM-DD` date, not after today in the temple's time zone (Asia/Kolkata), not more than 120 years ago | `dateOfBirth` |
| phone, phoneCountry | `normalizePhone(phone, phoneCountry, true)`; error text from it | `phone` |
| email | optional. Blank → NULL. Else lowercase, `FILTER_VALIDATE_EMAIL`, ≤190 | `email` |
| lang | `ta` or `en` (anything else is an error) | `lang` |
| members | a list of **0–20** objects (missing or `null` = empty list) | `members` |
| members[i].name | required, 2–120 | `members.{i}.name` |
| members[i].relationship | a key from §4 | `members.{i}.relationship` |
| members[i].age | null, `""`, or an integer 0–120 (a numeric string like `"12"` is accepted) | `members.{i}.age` |
| address1 | required, 2–180 | `address1` |
| address2 | optional, ≤180 | `address2` |
| city | required, 2–120 | `city` |
| country | required, `normalizeCountry()` | `country` |
| state | ≤120. **Required when the country is one of the 49 with a list** (`REG_SUBDIVISION_COUNTRIES`, mirroring the keys of `frontend/src/data/subdivisions.js`); free text otherwise | `state` |
| postcode | **India: required**, spaces removed, `/^[1-9][0-9]{5}$/`. **Elsewhere: optional**, ≤20, `/^[A-Za-z0-9][A-Za-z0-9 -]*$/` | `postcode` |
| consent | `publicGuardConsent()`: only an explicit yes | — |

**Responses**

| Status | When | Body |
|---|---|---|
| 201 | Saved — including a flagged duplicate — **and** a honeypot hit | exactly `{"success": true}` |
| 422 | Validation | `{"error": "Please correct the highlighted fields.", "fields": {"name": "...", "members.0.relationship": "..."}}` (English messages; the frontend shows its own Tamil/English wording per key and falls back to the server text) |
| 429 | Over a limit | the `publicGuardTooMany` shape + `Retry-After` |
| 503 | Migration 009 missing | `{"error": "Registration is not available on this site yet.", "code": "registration_disabled"}` |
| 405 | Not POST | `{"error": "Method not allowed"}` |

**Saving.** Duplicate lookup before insert: the lowest `id` of an existing
registration whose `phone` equals the new E.164 digits, or (when those are
`91` + 10 digits) the bare 10 digits a pre-004 row holds. Insert the `devotees`
row (`date_of_birth` or NULL, `duplicate_of` = that id or NULL, `email` NULL
when blank, `updates_consent_at` = `UTC_TIMESTAMP()` when consent else NULL,
`updates_consent_by` NULL, `is_active` 1), then any members with `sort_order`.
The duplicate path runs the same queries as the normal path.

**Confirmation message.** Only when `consent` is true:
`devoteeNotifyEvent('registration.received', ['devotee_id' => $id, 'entity_id' => $id, 'vars' => ['familyCount' => count($members) + 1]])`
after the commit. `familyCount` can be 1 (no members added); the template must
read naturally then. Never on a honeypot hit. Never changes the response.

## 6. Notification service rules

Channels are **email, whatsapp, sms**. `inapp` and `push` are retired: kept only
as labels for historic rows (`NOTIFY_RETIRED_CHANNELS`), never offered, sent or
counted as live channels. Removed: `prefs.php`, `otp.php`, `devices.php`,
`NotifyWebPushProvider`, `NotifyFcmProvider` (and `NotifyEcKeys` if nothing else
uses it), their registry entries, `notify_keys.php` push/VAPID/FCM commands and
checks, and every call site. `notifyBool()` moves to `time.php`.

**Recipient** (from a registration): `devotee_id`, `name`, `email` (may be
null), `phone`, `country`, `lang` (`devotees.lang`), `timezone`
(`notifyTimezoneFor(null, country)`), `active` (`is_active`), `consent`
(`updates_consent_at IS NOT NULL AND unsubscribed_at IS NULL`),
`unsubscribed` (`unsubscribed_at IS NOT NULL`). A **guest** (booking/donation by
phone) has no consent.

**Channel policy** (first rule that applies wins):
1. Only email/whatsapp/sms. Anything else is dropped before policy.
2. Contact: email needs a valid email ("no email"); WhatsApp/SMS need a phone
   ("no phone").
3. Provider not configured → "not configured", with the event's fallback.
4. By category kind:
   - **transactional** (booking, donation, payment, membership): no consent
     needed; unsubscribe does not stop it.
   - **informational** and **critical**: needs `consent` ("no consent"); an
     unsubscribed recipient is skipped ("unsubscribed").
   - **promotional**, **security**: categories are inactive; if reached anyway,
     treat promotional as informational and security as transactional.
   - An admin test send to a typed address bypasses consent (as today).
5. The existing SMS restraint for non-important informational messages stays.
6. Otherwise queued. The send-time recheck stays, with reasons
   `no consent`, `unsubscribed`, and an archived (`is_active = 0`) registration
   (transactional messages still go to an archived registration's own booking).

**Unsubscribe.** The existing `u` token and `/api/n/u/<token>` page stay (links
already sent keep working). Confirming sets `devotees.unsubscribed_at` (first
time kept). It stops informational/critical updates on **all channels**;
booking and donation messages continue. The page shows the masked email, or the
masked phone when there is no email, says which messages stop, and offers the
temple office's phone instead of any settings link. Every informational or
critical message to a registration carries the unsubscribe URL: email via body
link plus List-Unsubscribe headers; WhatsApp/SMS via a short "stop updates" line
(for Meta-approved templates the line must be part of the template —
documented, not appended). `notifyPreferencesUrl()` is removed.

**Event catalogue.** Remove `account.registered`, `account.email_verification`,
`account.email_verified`, `account.profile_updated`, `security.password_reset`,
`security.password_changed`, `phone.otp`, `phone.verified` and the ad hoc
`account.already_registered`. Add **`registration.received`**: template
`registration_received` (category `general`), channels email + whatsapp
(fallback sms), dedupe `devotee:{id}:registered`, not sync, CTA `/`.
Every other event drops `inapp`/`push`; `booking.completed` becomes email +
whatsapp. No template `cta_path` or body mentions `/account` or an account.

**Reminders.** Booking reminders use the booking's `lang` and phone.
Event/pooja reminder campaigns use channels `email,whatsapp`, the audience
"consenting registrations", and are created needing approval.

**Audience builder.** Remove `email_verified`, `phone_verified`,
`last_login_days`, `channel_enabled`, `category_not_muted`. Add `consent`
(bool), `has_email` (bool), `has_phone` (bool), `family_size` (gte/lte:
1 + member count). `lang` reads `devotees.lang`. Informational and critical
campaign audiences are automatically limited to active, consenting,
not-unsubscribed registrations, so estimates and "reached" counts are honest.
Saved segments/campaigns using a removed field are listed and flagged, not
crashed on.

**Admin notification pages.** No in-app/push channels, previews, KPIs
("Read in the bell", "Push engagement") or image field. Composer default
channel `email`. Announcements' "also notify devotees" creates an
`email,whatsapp` draft. Booking/donation admin messages use the row's `lang`.

## 7. Frontend

**Routes.** `/register` (public, indexable, WhatsApp preview). `/login`,
`/account`, `/notifications`, `/forgot-password`, `/reset-password`,
`/verify-email` → `<Navigate to="/register" replace />`. Deleted: `AuthProvider`,
`NotificationProvider`, `RequireAuth`, Login, ForgotPassword, ResetPassword,
VerifyEmail, Account, Notifications pages, `components/Auth/*`,
`components/Notifications/*`, `context/AuthContext.jsx`,
`context/NotificationContext.jsx`, `hooks/usePushSubscription.js`,
`lib/notifications.js`, `frontend/public/push-sw.js` and the workbox
`importScripts`. No page calls `/api/auth/*` or `/api/notifications/*`.

**Entry points.** Header: one `Register family` / `குடும்பப் பதிவு` button
(icon-only on narrow widths, accessible name starts with the visible word)
replacing Login/Sign Up/account menu/bell; drawer row; Home hero primary CTA
`Register your family` / `குடும்பத்தைப் பதிவு செய்ய` (the "Already have an
account? Sign in" line goes); footer quick link `Family registration` /
`குடும்பப் பதிவு`; search suggestion. The header must still fit at every width
`tests/public-e2e.mjs` checks.

**Sevas and Donations** drop the signed-in prefill and send `"lang"`.

**SEO text** (identical in `Register.jsx` `<Seo>` and `site_pages.php`):
title ta `குடும்பப் பதிவு`, en `Family registration`; description ta
`கோயில் உங்கள் குடும்பத்தை அறிந்து கொள்ள, ஒரு முறை மட்டும் இந்தப் படிவத்தை நிரப்புங்கள். கணக்கோ கடவுச்சொல்லோ தேவையில்லை.`,
en `Fill this in once so the temple knows your family. No account or password is needed.`

### 7.1 The multi-step registration

Files: `pages/Register.jsx` (the flow and its state), `pages/Register.css`
(`reg-` classes), components under `components/Registration/`
(`RegistrationStepper.jsx`, one component per step, `ReviewSection.jsx`, and
whatever else keeps files readable), and `lib/familyRegistration.js`
(`STEPS`, `RELATIONSHIPS`, `LIMITS`, `validateStep(step, form, t)`,
`validateAll(form, t)`, `toPayload(form)`, `mapServerFields(fields, memberKeys)`
returning errors grouped by step).

**Steps**

| # | Key | Stepper label (ta / en) | Heading (ta / en) |
|---|---|---|---|
| 1 | personal | தனிப்பட்ட விவரம் / Personal | உங்கள் விவரங்கள் / Your details |
| 2 | family | குடும்பம் / Family | குடும்ப உறுப்பினர்கள் / Family members |
| 3 | address | முகவரி / Address | வீட்டு முகவரி / Home address |
| 4 | review | சரிபார்த்தல் / Review | சரிபார்த்துச் சமர்ப்பிக்கவும் / Review and submit |

Page frame: PageHero (eyebrow `ஒரு முறை பதிவு` / `One-time registration`; h1
`உங்கள் குடும்பத்தைப் பதிவு செய்யுங்கள்` / `Register your family`; lead = SEO
description), then the stepper, then one step card at a time.

**Stepper.**
- An `<ol>` of the four steps. Each shows its number, or a check once
  completed; the current step has `aria-current="step"` and the brand's gold
  accent; a connecting track fills as steps complete (animated, still when
  `prefers-reduced-motion`).
- Completed steps, and any step whose earlier steps are all valid, are buttons
  that jump there; later steps are disabled until reachable. Each button's
  accessible name includes its state, e.g. "Step 2, Family, completed".
- Below 640 px it becomes compact: "படி 2 / 4 · குடும்பம்" / "Step 2 of 4 ·
  Family", a slim progress bar and four dots, without horizontal scrolling.

**Moving between steps.**
- Each step card has an h2 (`tabIndex={-1}`), a one-line description, its
  fields, and an action bar: **Back** (`பின்செல்` / `Back`, not on step 1) and
  **Next** (`அடுத்து` / `Next`); on Review, **Submit registration**
  (`பதிவைச் சமர்ப்பி` / `Submit registration`). On phones the action bar sticks
  to the bottom of the viewport above the site's bottom tab bar and floating
  buttons.
- **Next validates only the current step.** If anything is wrong, the step's
  error summary appears at the top of the card, receives focus and links to
  each field; per-field errors show under the fields (`Field announce={false}`);
  the step does not change. Errors clear as the fields are fixed.
- **Back never validates and never loses anything.** All data lives in one form
  state shared by every step.
- On every step change focus moves to the new heading, a polite status region
  announces "படி 2 / 4: குடும்ப உறுப்பினர்கள்" / "Step 2 of 4: Family members",
  and the page scrolls so the stepper is in view. Steps change with a short
  slide/fade that is skipped under `prefers-reduced-motion`.
- The current step is kept in the URL as `?step=personal|family|address|review`.
  Next/Back push a history entry so the browser and phone Back button move one
  step; opening a later step whose earlier steps are incomplete replaces the URL
  with the first incomplete step.
- Pressing Enter in a text field on steps 1–3 acts as Next; nothing submits
  before Review.
- **Draft.** The form state and step are kept in `sessionStorage` (key following
  the codebase's `temple:` naming, e.g. `temple:registration-draft`), restored on
  reload, wrapped in try/catch, and removed after a successful submit or
  "Register another family". Never `localStorage`.

**Step 1 — Personal.** Full name* (`முழுப் பெயர்` / `Full name`); phone*
(`PhoneInput`); email (optional, hint: only if you would like receipts or
notices by email); date of birth (optional, `பிறந்த தேதி` / `Date of birth`,
native date input with `max` = today, showing the calculated age as a hint once
valid: `வயது 42` / `Age 42`); preferred language as two radio cards
(தமிழ் / English), defaulting to the current site language. **No gender field.**

**Step 2 — Family (optional).** Description:
`உங்கள் குடும்ப உறுப்பினர்களைச் சேர்க்கவும். இந்தப் படியைத் தவிர்க்கலாம்.` /
`Add the members of your family. You can skip this step.`
- No members yet: a friendly empty state (an icon, one sentence) with
  **Add family member** (`குடும்ப உறுப்பினரைச் சேர்` / `Add family member`);
  Next reads **Skip for now** (`இப்போதைக்குத் தவிர்` / `Skip for now`).
- Each member is a card (`fieldset`, legend `உறுப்பினர் N` / `Member N`, stable
  keys, never the index) with name*, relationship* (`<select>` with an empty
  first option, options from §4 — Spouse, Son, Daughter…), age (optional,
  numeric) and a Remove button whose accessible name includes the member. A
  running count ("3 உறுப்பினர்கள்" / "3 members"). **Add another family member**
  below the list, hidden at 20.
- Adding focuses the new name field; removing focuses the neighbouring card (or
  the Add button when none remain); both are announced through the status region.
- On Next, a card left completely empty is dropped silently; a partly filled
  card is validated.

**Step 3 — Address.** Address line 1* (`வீட்டு எண், தெரு` / `House number and
street`); area or landmark (optional); city* (`நகரம் / ஊர்` / `City or town`);
country* (`CountrySelect`, defaulting to India) and state/province
(`StateSelect`, required where a list exists, label from `subdivisionLabel`);
postal code — labelled `PIN குறியீடு` / `PIN code` and required for India,
`அஞ்சல் குறியீடு` / `Postal code` and optional elsewhere. Changing the country
clears the state; the phone number's country follows the residence country until
a number has been typed.

**Step 4 — Review.** Three summary cards — Personal, Family, Address — each a
tidy definition list with an **Edit** button (`திருத்து` / `Edit`, accessible
name "Edit personal details" etc.) that jumps to that step; after an edit
reached from Review, that step's primary button reads **Save and return to
review** (`சேமித்துச் சரிபார்ப்புக்குத் திரும்பு` / `Save and return to review`)
and validates before returning. Optional fields left blank show "Not given".
Family shows each member (name, relationship, age) or "No family members added"
with an Add link. Then the consent checkbox, unticked by default:
`திருவிழா, பூஜை மற்றும் கோயில் அறிவிப்புகளை வாட்ஸ்அப், குறுஞ்செய்தி அல்லது மின்னஞ்சல் மூலம் எனக்கு அனுப்பவும்` /
`Send me festival, pooja and temple updates by WhatsApp, SMS or email`, hint
`விருப்பம். ஒவ்வொரு செய்தியிலும் நிறுத்துவதற்கான இணைப்பு இருக்கும்.` /
`Optional. Every update has a link to stop them.`; the hidden `hp_token`; and
Submit. Before posting, `validateAll` runs; any invalid step is opened with its
errors.

**Submitting.** Busy state on Submit. 201 → the thank-you view. 422 →
`mapServerFields`, open the first step with an error, show the errors there
(client wording for known keys, server text otherwise). 429 → the existing
friendly rate-limit message on Review. Network failure and other errors have
their own bilingual text on Review; the data stays.

**Thank-you view.** Replaces stepper and card: a celebratory but calm confirmation
(check icon, heading receiving focus `நன்றி! உங்கள் குடும்பம் பதிவு செய்யப்பட்டது` /
`Thank you — your family is registered`), a summary with the member count,
"to change these details later, contact the temple office" with a link to
/contact, a note that updates will follow when consent was ticked, and actions
Home, Book a seva, Register another family (clears the draft and starts at step 1).

**Validation mirrors §5 exactly**, counting characters with
`Array.from(value.trim()).length`; date of birth compared with today in IST.
Payload: E.164 phone via `toE164` plus `phoneCountry`, `email` null when blank,
`dateOfBirth` as `YYYY-MM-DD` or null, member `age` integer or null, members in
order (empty cards removed), `consent` boolean, `lang`, `hp_token` "". No
`gender`. Phone errors become bilingual (`phoneProblem` gains an optional `t`).
Autocomplete: `name`, `bday`, `tel-national`, `email`, `address-line1`,
`address-line2`, `address-level2`, `postal-code`; member names
`autocomplete="off"`; numeric `inputMode` for age and PIN.

**Look and feel.** Uses the "Sacred Light" tokens and existing primitives:
glass step cards, gold active step, maroon primary actions, generous spacing,
large touch targets (≥44 px), radio cards instead of tiny radios. Mobile-first
from 320 px to 1920 px; on wide screens the card is centred at a comfortable
reading width. No inline styles or raw colours; axe clean; no horizontal scroll.

## 8. Admin: Family Registrations (`backend/admin/devotees.php`)

Same URL and permissions (`view` to read/export, `devotees.edit` to change).
Nav label `Family Registrations`; palette entries "Possible duplicate
registrations" (`?status=duplicates`) and "Export families CSV" replace
"Devotees awaiting confirmation".
- **KPIs:** Families, Family members, Possible duplicates, Agreed to updates,
  Registered in the last 30 days.
- **Filters:** All, Possible duplicates, Agreed to updates, No consent,
  Archived; country filter; search on name, email, phone digits, city,
  address, PIN **and member names**. Sort by name or date.
- **List row:** registrant (with age when a date of birth is on file), phone,
  email if any, address, family (count and first names, or "No members
  added"), language, consent, duplicate badge, registered date, row menu.
- **Edit:** the registrant's fields with the §5 rules (email and date of birth
  optional, address required, PIN required for India), language, consent tick
  box (recording the admin in `updates_consent_by`, clearing `unsubscribed_at`
  when ticked, showing when and how consent was given or withdrawn), the family
  members table (add, edit, remove; zero members is allowed), tags (kept). No
  gender anywhere.
- **Duplicates panel:** other registrations with the same phone; actions "Merge
  into #N" (one transaction: move members, tags, legacy booking/donation links
  and notification history to the target; fill the target's empty fields only
  when ticked; repoint other `duplicate_of`; delete the source), "Not a
  duplicate" (clears `duplicate_of`), "Delete registration" (confirm).
- **Archive / restore** (`is_active`) replaces close/reopen.
- **Exports:** families CSV (no password, verification or last-login columns;
  adds date_of_birth, lang, consent, duplicate_of, member count, members
  flattened) and a members CSV (one row per member). Cells beginning
  `= + - @` are neutralised.
- Every change writes the activity log. No password or email-confirmation text
  anywhere.
- Dashboard gains "Registered families" and "Possible duplicates" KPIs.

## 9. Ownership, ports and hand-off

| Owner | Files | Ports / client IP |
|---|---|---|
| **registration** (backend + admin) | `backend/includes/registration.php`, `backend/api/registrations.php`, `backend/api/index.php`, `backend/includes/public_guard.php`, `backend/includes/site_pages.php`, `backend/api/og.php`, `backend/api/search.php`, `backend/api/chat.php`, `backend/admin/devotees.php`, `backend/admin/index.php`, `backend/admin/includes/admin_layout.php`, `backend/admin/assets/admin.css`, `backend/admin/assets/admin.js`; tests `tests/registration-api.mjs`, `tests/search-api.mjs`, `tests/admin-registrations.mjs`, `tests/admin-smoke.mjs`, `tests/admin-hostile-input.mjs`, `tests/public-hardening.mjs`; deletes `tests/devotee-auth.mjs` | PHP 8050–8059; X-Forwarded-For `10.80.0.<n>` |
| **notifications** | `backend/includes/notify.php`, `backend/includes/notify/**`, `backend/api/n.php`, `backend/api/notify_cron.php`, `backend/api/notify_webhook.php`, `backend/bin/notify_worker.php`, `backend/bin/notify_keys.php`, `backend/admin/notifications.php`, `notification_templates.php`, `notification_analytics.php`, `notification_segments.php`, `backend/admin/includes/notify_audience_form.php`, `backend/admin/announcements.php`, `backend/admin/seva_bookings.php`, `backend/admin/donations.php`, `backend/admin/assets/notify-*.css/js`; `docs/notifications/SPEC.md`; tests `tests/notify-*.php|mjs`, `tests/notifications-api.mjs` (becomes `tests/notify-links.mjs`), `tests/admin-notifications.mjs`, `tests/admin-notify-content.mjs`, `tests/support/notify_*` (keeping `notify_fixtures.php` commands compatible); deletes `tests/notifications-ui.mjs`, `tests/notify-prefs-ui.mjs` | PHP 8010–8029 and the CLI; X-Forwarded-For `10.81.0.<n>` |
| **frontend** | `frontend/src/**`, `frontend/public/push-sw.js` (delete), `frontend/vite.config.js`; tests `tests/public-e2e.mjs`, `tests/og.mjs`, `tests/family-registration-ui.mjs`, `tests/search-ui.mjs`; deletes `tests/accounts-ui.mjs` | Vite `http://localhost:5173` → PHP 8000; Playwright X-Forwarded-For `10.82.<n>.<n>` |
| **docs** (after the three) | `README.md`, `tests/README.md`, `frontend/src/styles/README.md`, `backend/.env.example` | — |

Hand-off markers (files in `C:/Users/nithp/AppData/Local/Temp/claude/`):
- `registration-api-ready.txt` — written by **registration** once
  `POST /api/registrations` saves, validates and answers per this revision of
  §5. **frontend** waits for it before tests that submit the form.
- `notify-registration-ready.txt` — written by **notifications** once
  `registration.received` and its template exist and the policy follows §6.
  **registration** waits for it before asserting the confirmation message.

Test data prefixes: registration `E2E-REG-`, notifications `E2E-NOTIFY-` /
`e2e-notify-`, frontend `E2E-UI-`. Delete only your own rows and your own
`rate_limits` buckets.
