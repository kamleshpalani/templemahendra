# Online payments (CCAvenue) — build contract

Status: build contract, 2026-09-14. Every builder follows this file. Where it and the code disagree, this file wins; where it is silent, follow the existing conventions described in docs/registration/SPEC.md and the code.

Sources this contract rests on (read them only when a section below points you there):
- The client requirement "CCAvenue Payment Gateway Integration Requirements" (30 sections), summarised in §0.
- Research notes in the session scratchpad `pay/` folder: `research-ccavenue.md` (gateway facts with confidence levels), `map-donations.md`, `map-sevas.md` (seva bookings), `map-platform.md`, `map-notify.md`, `map-frontend.md`, `map-tests.md`. Path: `C:/Users/nithp/AppData/Local/Temp/claude/c--Users-nithp-templemahendra-templemahendra/6b4dc17d-a9ce-4bd1-b45e-e90337405c9a/scratchpad/pay/`.

---

## 0. Decisions (settled — do not reopen)

1. **Scope:** online payment for **donations and seva bookings**. One reusable payments module serves both ("payables").
2. **The pledge form stays.** `/donations` keeps the "I will donate" pledge form, bank / cheque details (`#bank-details`) and every current test selector. Online giving is added next to it, not instead of it. Pledges keep `POST /api/donations` unchanged.
3. **The seva "request a booking" path stays.** `POST /api/seva-bookings` is unchanged (tests pin its response keys). Paying online is a second, separate endpoint.
4. **Receipts are a printable page**, not a server PDF. "Download receipt" and "Print receipt" both call `window.print()` on an A4 print stylesheet (the browser's Save as PDF gives correct Tamil). Email/SMS carry a link to that page.
5. **Donor names are private by default.** The public donors list stays opt-in (`show_name_publicly`). The requirement's "Donate anonymously" is presented as the existing opt-in: an unticked "Show my name on the temple's thank-you list" box. Anonymous is the default; nothing is ever shown without the tick. Only **SUCCESS** online donations may appear on the list.
6. **Gateway:** CCAvenue non-seamless **redirect** integration (full-page POST to CCAvenue; no iframe). Crypto, fields and URLs in §4.
7. **No payment is ever trusted from the browser.** Amounts come from the server (seva price from `sevas.amount`; donation amount validated against settings, stored, then sent). The browser return is only a trigger; status is decided from the decrypted response, validated against our stored order, and (when the status API is configured) confirmed server-to-server.
8. **Payments are OFF until an owner turns them on** in Admin → Payment Gateway, and production mode cannot be selected until production credentials are present. A local **simulator** mode exists for development and tests only (§4.7); it is refused unless the server env allows it.
9. **International:** off by default. When off, only INR is offered and only Indian billing is assumed for currency. Donors from any country may still give in INR. Foreign currencies are offered only when international is on **and** the currency is in the admin's allow-list of currencies CCAvenue has activated (CCAvenue offers no API to list them — research §6 — so the admin copies them from the merchant dashboard).
10. **Seva payments are INR only**, at the seva's current price. A seva with price 0 cannot be paid online.
11. **A paid seva booking keeps booking `status` = `pending`** (the office still confirms the date by phone) and gets `payment_status` = `SUCCESS`. The office's existing Confirm/Complete/Cancel flow is untouched. Unpaid online bookings are hidden from the office's default list.
12. **Refunds** are initiated by an **owner** from the admin with a confirmation step, sent through CCAvenue's `refundOrder` API when configured; otherwise recorded as a manual refund the office processed in the CCAvenue dashboard. Refund rows never overwrite the payment.
13. **Reconciliation** = (a) server-to-server status checks of our open/suspicious attempts, and (b) upload of a CSV order report exported from the CCAvenue dashboard, compared with our records. `orderLookup` by date is not coded (unverified command, research §5).
14. **Times:** every new column is UTC, written with `UTC_TIMESTAMP()`. "Today / this month / this year" are computed for Asia/Kolkata in PHP and turned into UTC ranges. Order and receipt numbers use the IST date.
15. **Nothing is committed to git** by any builder.

## 1. Glossary

| Term | Meaning |
|---|---|
| payable | The thing being paid for: a `donations` row with `source='online'`, or a `seva_bookings` row with `payment_mode='online'`. |
| number | The payable's public id. Donation: `DON-YYYYMMDD-NNNNNNNN`; seva booking: `SEV-YYYYMMDD-NNNNNNNN`. Date = IST date the payable was created; `N` = the row id zero-padded to 8 digits. Unique by construction; 21 characters. |
| attempt / transaction | One trip to CCAvenue: a `payment_transactions` row. |
| order_id | The id sent to CCAvenue for one attempt. Attempt 1 = the number. Attempt n ≥ 2 = `number-Rn` (e.g. `DON-20260914-00001234-R2`). Always matches `^[A-Z0-9-]{1,30}$`, unique in the table. CCAvenue does not enforce uniqueness, so we do. |
| tracking_id | CCAvenue's reference for an attempt (`tracking_id` in the response, `reference_no` in the API). |
| receipt number | Assigned once, when a payable first becomes SUCCESS: `{prefix}-{YYYY}-{NNNNNN}` (e.g. `TMR-2026-000042`), sequential per IST year with no gaps, from `payment_counters`. Prefix from settings (default `TMR`, `^[A-Z]{2,8}$`) for PRODUCTION attempts, counter `receipt:{YYYY}`. A payment made in TEST or SIMULATOR mode never consumes the real sequence: a TEST attempt's receipt is `TEST-{YYYY}-{NNNNNN}` from `receipt:test:{YYYY}`, a SIMULATOR attempt's `SIM-{YYYY}-{NNNNNN}` from `receipt:simulator:{YYYY}` (the environment is the receipt attempt's, §2.4). |
| receipt attempt | The SUCCESS attempt the receipt was issued for: the attempt named by the `receipt_assigned` audit row (`transaction_id`), else the earliest SUCCESS attempt. `payReceiptAttemptOf()` / `payReceiptAttemptSql()`; `paySuccessAttempt()` returns it. Any other SUCCESS attempt of the same payable is an extra payment (§2.4). |
| access token | `t` in result/receipt links: base64url(HMAC-SHA256(secret, "pay:" . number)) cut to 22 chars. Proves the link came from us; ids alone never reveal anything. |
| verify token | `v` in the QR verification link: the first 10 chars of base64url(HMAC-SHA256(secret, "verify:" . receipt_number)). |

## 2. Statuses

### 2.1 Payable status (`donations.status`, `seva_bookings.payment_status`)

`INITIATED`, `PENDING`, `SUCCESS`, `FAILED`, `CANCELLED`, `REFUND_INITIATED`, `PARTIALLY_REFUNDED`, `REFUNDED`. Stored as `VARCHAR(20)`, validated in PHP (no ENUM, so the list can grow). Pledge donations and request-only bookings keep `NULL`.

### 2.2 Attempt status (`payment_transactions.status`)

`INITIATED` (row created, form not yet posted back), `PENDING` (gateway said Awaited/unknown, or a response failed validation and needs review), `SUCCESS`, `FAILED`, `CANCELLED`. Refund states live on the payable and on `payment_refunds`, never on the attempt.

### 2.3 Gateway status mapping

| Source | Value | Attempt status |
|---|---|---|
| redirect/cancel/notify `order_status` | `Success` | SUCCESS (only if every check in §4.4 passes; otherwise PENDING + `needs_review=1`) |
| | `Failure`, `Invalid`, `Timeout` | FAILED |
| | `Aborted` | CANCELLED |
| | anything else / missing | PENDING |
| cancel_url with no decryptable `encResp` | — | CANCELLED only if the attempt is still INITIATED |
| status API `order_status` | `Successful`, `Shipped` | SUCCESS (with the same amount/currency checks) |
| | `Unsuccessful`, `Invalid`, `Fraud`, `Auto-Cancelled`, `Auto-Reversed`, `Cancelled` | FAILED |
| | `Aborted` | CANCELLED |
| | `Initiated`, `Awaited` | PENDING |
| | `Refunded`, `System refund`, `Chargeback` | leave attempt as is; flag for reconciliation |

### 2.4 Transitions (enforced in one function, `payStateApply()`, §5.3)

Attempt: `INITIATED → PENDING | SUCCESS | FAILED | CANCELLED`; `PENDING → SUCCESS | FAILED | CANCELLED`; `FAILED | CANCELLED → SUCCESS` **only** from a verified status-API answer (a late success must not be lost). `SUCCESS` is terminal for the attempt. A repeated response that maps to the current status is a no-op except for `response_count + 1` and an audit line `response_duplicate`.

Payable (derived after every attempt change, inside the same DB transaction):
- any attempt SUCCESS → payable SUCCESS (first time: assign receipt number, set `paid_at`, raise `payment.succeeded`).
- else latest attempt's status (INITIATED/PENDING/FAILED/CANCELLED).
- refunds (§8): only refunds against the **receipt attempt** (§1) move the payable: SUCCESS → REFUND_INITIATED while such a refund is REQUESTED/PROCESSING → PARTIALLY_REFUNDED (sum of its SUCCESS refunds < the payable's amount) or REFUNDED (sum = amount); `amount_refunded` = the sum of SUCCESS refunds against the receipt attempt. A FAILED refund returns the payable to its previous paid state.
- Two SUCCESS attempts on one payable (a donor paid twice): the payable stays SUCCESS once, the extra attempt is SUCCESS with `needs_review=1` and audit `double_payment`, and it appears in reconciliation for a refund. Never a second receipt. The extra attempt is refunded **against itself**: that refund gives the extra money back and leaves the payable's status and `amount_refunded` untouched (the receipt's money is still there); the detail view and the reconciliation "Double payments" section show the extra attempt as refunded.
- A new attempt (retry) is allowed only when the payable is INITIATED (older than 2 minutes), PENDING (older than 15 minutes), FAILED or CANCELLED. Never for SUCCESS or refund states, and never for a seva booking the office cancelled (`status='cancelled'` not caused by a hold expiry — the newest of its `hold_expired` / `booking_restored` audit rows is not `hold_expired`; `payBookingCancelledByHold()`): the retry route answers 409 `not_retryable`. Maximum 5 attempts per payable.

## 3. Data model — `database/migrations/010_payments.sql`

Style: exactly as 008/009 (header comment explaining every column, "Requires 001–009", "Safe to re-run", apply command with `--default-character-set=utf8mb4`, `CREATE TABLE IF NOT EXISTS … ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, information_schema-guarded `ALTER`s via PREPARE, `INSERT IGNORE` seeds, column COMMENTs). Every new DATETIME is UTC.

### 3.1 `donation_categories` (new)

| Column | Type | Notes |
|---|---|---|
| id | INT UNSIGNED PK AI | |
| slug | VARCHAR(40) NOT NULL UNIQUE | `^[a-z0-9_]{2,40}$`; stored in `donations.purpose` for compatibility |
| name_ta, name_en | VARCHAR(120) NOT NULL | |
| description_ta, description_en | VARCHAR(500) NULL | |
| suggested_amount | DECIMAL(12,2) NULL | pre-fills the amount when the category is picked (INR) |
| sort_order | INT NOT NULL DEFAULT 0 | |
| is_active | TINYINT(1) NOT NULL DEFAULT 1 | inactive = hidden from donors, still labels old rows |
| created_at, updated_at | DATETIME NOT NULL | UTC |

Seed (INSERT IGNORE, Tamil + English, this order): `general` General Donation, `temple_development` Temple Development, `kumbabhishekam` Kumbabhishekam, `annadanam` Annadhanam, `annadanam_hall` Annadanam Hall construction, `pooja_seva` Pooja / Seva, `abhishekam` Abhishekam, `education` Education Support, `medical` Medical Assistance, `festival` Festival Contribution, `building_fund` Building Fund, `maintenance` Maintenance Fund, `other` Other. The legacy keys (kumbabhishekam, annadanam_hall, annadanam, abhishekam, festival, maintenance, other) keep their current meaning so old pledges still label. Take Tamil labels for the legacy keys from `frontend/src/pages/Donations.jsx` (the purpose `<option>`s) and write sensible Tamil for the new ones.

### 3.2 `donations` (extend; pledges unaffected)

Add, each guarded, all NULL or defaulted:

| Column | Type | Notes |
|---|---|---|
| source | ENUM('pledge','online') NOT NULL DEFAULT 'pledge' | AFTER id |
| donation_number | VARCHAR(30) NULL UNIQUE | online only |
| category_id | INT UNSIGNED NULL | FK → donation_categories(id) ON DELETE SET NULL |
| currency | CHAR(3) NOT NULL DEFAULT 'INR' | |
| email | VARCHAR(190) NULL | |
| country | CHAR(2) NULL | donor's country (ISO-2) |
| address_line | VARCHAR(250) NULL | |
| city | VARCHAR(120) NULL | |
| state | VARCHAR(120) NULL | |
| postcode | VARCHAR(15) NULL | |
| pan | VARCHAR(10) NULL | uppercase `^[A-Z]{5}[0-9]{4}[A-Z]$` |
| notes | VARCHAR(500) NULL | donor's internal note (requirement "Notes"); `message` stays the public-facing message |
| status | VARCHAR(20) NULL | §2.1; NULL for pledges |
| receipt_number | VARCHAR(40) NULL UNIQUE | |
| paid_at | DATETIME NULL | UTC, first SUCCESS |
| amount_refunded | DECIMAL(12,2) NOT NULL DEFAULT 0.00 | sum of SUCCESS refunds |
| updated_at | DATETIME NULL | UTC |

Indexes: `idx_source_status (source, status)`, `idx_paid_at (paid_at)`. Backfill: `purpose` values that match a category slug get `category_id` (only in the run that created the column). Also bring `database/schema.sql` up to date? **No** — leave schema.sql alone (install = schema.sql + all migrations, as today).

### 3.3 `seva_bookings` (extend; request-only bookings unaffected)

| Column | Type | Notes |
|---|---|---|
| payment_mode | ENUM('offline','online') NOT NULL DEFAULT 'offline' | |
| order_number | VARCHAR(30) NULL UNIQUE | `SEV-…` |
| email | VARCHAR(190) NULL | |
| amount | DECIMAL(10,2) NULL | copied from `sevas.amount` at booking time |
| currency | CHAR(3) NULL | 'INR' for online |
| payment_status | VARCHAR(20) NULL | §2.1 |
| receipt_number | VARCHAR(40) NULL UNIQUE | |
| paid_at | DATETIME NULL | UTC |
| amount_refunded | DECIMAL(10,2) NOT NULL DEFAULT 0.00 | |
| hold_expires_at | DATETIME NULL | UTC; unpaid online bookings expire after it (§9.2) |
| updated_at | DATETIME NULL | UTC |

Index `idx_payment (payment_mode, payment_status)`.

### 3.4 `payment_transactions` (new)

| Column | Type | Notes |
|---|---|---|
| id | INT UNSIGNED PK AI | |
| payable_type | ENUM('donation','seva_booking') NOT NULL | |
| payable_id | INT UNSIGNED NOT NULL | no FK (two parents); KEY `idx_payable (payable_type, payable_id)` |
| attempt | TINYINT UNSIGNED NOT NULL | 1… |
| order_id | VARCHAR(30) NOT NULL UNIQUE | |
| gateway | VARCHAR(20) NOT NULL DEFAULT 'ccavenue' | |
| environment | ENUM('test','production','simulator') NOT NULL | mode at creation; responses are decrypted with this environment's key |
| amount | DECIMAL(12,2) NOT NULL | |
| currency | CHAR(3) NOT NULL | |
| status | VARCHAR(20) NOT NULL DEFAULT 'INITIATED' | §2.2 |
| gateway_status | VARCHAR(40) NULL | raw `order_status` last seen |
| tracking_id | VARCHAR(40) NULL UNIQUE | |
| bank_ref_no | VARCHAR(100) NULL | |
| payment_mode | VARCHAR(40) NULL | e.g. "UPI", "Credit Card" |
| card_name | VARCHAR(60) NULL | |
| failure_message | VARCHAR(255) NULL | |
| status_code | VARCHAR(10) NULL | |
| status_message | VARCHAR(255) NULL | |
| gateway_response | JSON NULL | the last decrypted response, **allow-listed keys only** (§4.4) |
| response_count | INT UNSIGNED NOT NULL DEFAULT 0 | callbacks received |
| verification | ENUM('none','callback','status_api','manual') NOT NULL DEFAULT 'none' | strongest evidence so far |
| needs_review | TINYINT(1) NOT NULL DEFAULT 0 | mismatch, double payment, unverified success |
| lang | CHAR(2) NOT NULL DEFAULT 'ta' | |
| client_ip | VARCHAR(45) NULL | |
| redirected_at, responded_at, verified_at, last_checked_at | DATETIME NULL | UTC |
| created_at, updated_at | DATETIME NOT NULL | UTC |

Indexes: `idx_status_created (status, created_at)`, `idx_review (needs_review)`.

### 3.5 `payment_refunds` (new)

| Column | Type | Notes |
|---|---|---|
| id | INT UNSIGNED PK AI | |
| transaction_id | INT UNSIGNED NOT NULL | FK → payment_transactions(id) ON DELETE RESTRICT |
| refund_reference | VARCHAR(30) NOT NULL UNIQUE | ours, sent as `refund_ref_no`: `RF` + transaction id + `T` + unix time, alphanumeric only |
| amount | DECIMAL(12,2) NOT NULL | |
| currency | CHAR(3) NOT NULL | |
| kind | ENUM('full','partial') NOT NULL | |
| reason | VARCHAR(500) NOT NULL | |
| method | ENUM('gateway_api','manual') NOT NULL | |
| status | ENUM('REQUESTED','PROCESSING','SUCCESS','FAILED') NOT NULL | |
| gateway_reference | VARCHAR(60) NULL | |
| gateway_message | VARCHAR(255) NULL | |
| requested_by | VARCHAR(60) NOT NULL | admin username |
| created_at, updated_at, processed_at | DATETIME | UTC |

### 3.6 `payment_audit_log` (new)

| Column | Type | Notes |
|---|---|---|
| id | BIGINT UNSIGNED PK AI | |
| transaction_id | INT UNSIGNED NULL | KEY |
| payable_type | ENUM('donation','seva_booking') NULL | KEY with payable_id |
| payable_id | INT UNSIGNED NULL | |
| event | VARCHAR(48) NOT NULL | vocabulary in §5.4 |
| detail | VARCHAR(1000) NULL | human sentence, redacted |
| data | JSON NULL | small structured facts, redacted; never credentials, never full card/billing data |
| actor | VARCHAR(60) NOT NULL | `system`, `gateway`, `donor`, `cron`, or the admin username |
| ip | VARCHAR(45) NULL | |
| created_at | DATETIME(3) NOT NULL | UTC, millisecond order |

Rows are never updated or deleted by the application.

### 3.7 `payment_settings` (new)

| Column | Type | Notes |
|---|---|---|
| k | VARCHAR(64) PK | keys in §4.1 |
| v | TEXT NOT NULL | plain for non-secrets; `sbx1:` + base64(nonce ‖ secretbox) for secrets |
| is_secret | TINYINT(1) NOT NULL DEFAULT 0 | |
| updated_by | VARCHAR(60) NULL | |
| updated_at | DATETIME NOT NULL | UTC |

Seeds (INSERT IGNORE): `enabled=0`, `mode=test`, `default_currency=INR`, `currencies=INR`, `international_enabled=0`, `receipt_prefix=TMR`, `donation_min=1`, `donation_max=500000`, `donation_max_foreign=10000`, `preset_amounts=500,1000,2500,5000,10000`, `notify_email=1`, `notify_sms=0`, `notify_whatsapp=1`, `seva_online_enabled=0`, `hold_minutes=30`.

### 3.8 `payment_counters` (new)

`name VARCHAR(40) PK` (`receipt:2026`, `receipt:test:2026`, `receipt:simulator:2026` — one sequence per environment, §1; `sim:<order_id>` for the simulator's outcomes), `value INT UNSIGNED NOT NULL`, `updated_at DATETIME`. Incremented with `SELECT … FOR UPDATE` inside the SUCCESS transaction.

### 3.9 Notification category

No new category: `payment` and `donation` are already transactional (007 seed). The migration adds nothing to `notification_categories`.

## 4. Gateway configuration and CCAvenue integration

### 4.1 Settings and credentials

**Environment variables** (read with `envValue()`, never raw `getenv`). Env always wins over the admin-stored value for the same credential, and the admin page shows "Set in the server environment" (read-only) for any credential supplied by env.

| Variable | Purpose |
|---|---|
| `CCAVENUE_MERCHANT_ID`, `CCAVENUE_ACCESS_CODE`, `CCAVENUE_WORKING_KEY` | PRODUCTION checkout credentials (names from the requirement) |
| `CCAVENUE_TEST_MERCHANT_ID`, `CCAVENUE_TEST_ACCESS_CODE`, `CCAVENUE_TEST_WORKING_KEY` | TEST credentials |
| `CCAVENUE_API_ACCESS_CODE`, `CCAVENUE_API_WORKING_KEY`, and `CCAVENUE_TEST_API_…` | Optional: a separate pair for the server-to-server API (research §5 says it may differ). Default to the checkout pair. |
| `CCAVENUE_REDIRECT_URL`, `CCAVENUE_CANCEL_URL`, `CCAVENUE_NOTIFY_URL` | Optional overrides. Defaults: `siteUrl('/api/payments/ccavenue/response')`, `siteUrl('/api/payments/ccavenue/cancel')`, `siteUrl('/api/payments/ccavenue/notify')`. Must be https in production mode (http allowed only for test/simulator on localhost). Max 100 chars. |
| `CCAVENUE_TRANSACTION_URL`, `CCAVENUE_API_URL` | Test-only overrides for mocks. Honoured only when mode ≠ production. Defaults in §4.2. |
| `PAYMENTS_SECRET` | ≥ 32 chars. HMAC key for access/verify tokens. Required for mode=production (payments refuse to start without it). In test/simulator mode, falls back to `notifySecret()` with an `error_log` warning once per request. |
| `PAYMENTS_SETTINGS_KEY` | base64 of 32 random bytes. Encrypts credentials stored from the admin. Without it the admin cannot store credentials (the fields show "Set PAYMENTS_SETTINGS_KEY to store keys here, or put them in the environment") and env is the only source. |
| `PAYMENTS_ALLOW_SIMULATOR` | `1` allows mode=simulator. Never set in production. |
| `PAYMENTS_CRON_KEY` | ≥ 24 chars; enables `/api/payments-cron` (§9). |

**Admin-stored settings** (`payment_settings`, §3.7). Keys:
- `enabled` 0/1; `mode` test|production|simulator.
- Secrets (is_secret=1, encrypted): `test_merchant_id`, `test_access_code`, `test_working_key`, `test_api_access_code`, `test_api_working_key`, `prod_merchant_id`, `prod_access_code`, `prod_working_key`, `prod_api_access_code`, `prod_api_working_key`. (Merchant id is not secret in the cryptographic sense but is masked with the rest.)
- `default_currency` (must be in `currencies`); `currencies` CSV of ISO-4217 codes, always containing INR, from this fixed supported list: INR USD GBP EUR CAD AUD SGD AED SAR MYR JPY NZD CHF (JPY: whole amounts only).
- `international_enabled` 0/1; `receipt_prefix`; `donation_min` (INR, ≥1); `donation_max` (INR); `donation_max_foreign` (any non-INR currency, whole units); `preset_amounts` CSV of INR integers (max 6, each within min/max).
- `notify_email`, `notify_sms`, `notify_whatsapp` 0/1 — channels used for payment messages.
- `seva_online_enabled` 0/1; `hold_minutes` 10–1440.

**Encryption at rest:** `sodium_crypto_secretbox` with a fresh 24-byte nonce, key = `base64_decode(PAYMENTS_SETTINGS_KEY)` (must be exactly 32 bytes, else treated as absent). Stored as `sbx1:` + base64(nonce ‖ ciphertext). A value that fails to decrypt is treated as absent and logged once (`[payments] stored credential could not be decrypted`), never shown. Secrets are **never** returned by any API, never rendered into HTML (the admin shows `•••• last 4` only), never written to logs or `payment_audit_log`, and an empty submitted field keeps the stored value ("Leave blank to keep").

**Ready check** — `payConfig()` returns the effective configuration; `payReady(): array{ok:bool, reason:string}` answers false with a reason when: tables missing; `enabled=0`; mode=simulator without `PAYMENTS_ALLOW_SIMULATOR=1`; mode credentials incomplete (merchant id numeric, access code and working key non-empty); mode=production without `PAYMENTS_SECRET`; production with non-https redirect URL; openssl missing. Public endpoints answer 503 `{"error":…,"code":"payments_unavailable"}` when not ready.

### 4.2 URLs (research §1, §5 — high confidence)

| Mode | Checkout (browser POST) | Server API |
|---|---|---|
| test | `https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction` | `https://apitest.ccavenue.com/apis/servlet/DoWebTrans` |
| production | `https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction` | `https://api.ccavenue.com/apis/servlet/DoWebTrans` |
| simulator | `siteUrl('/api/payments/simulator')` | `siteUrl('/api/payments/simulator/api')` |

### 4.3 Crypto and the checkout request

```php
// backend/includes/payments/ccavenue.php
function ccavEncrypt(string $plain, string $workingKey): string   // bin2hex(openssl_encrypt($plain, 'aes-128-cbc', md5($workingKey, true), OPENSSL_RAW_DATA, hex2bin('000102030405060708090a0b0c0d0e0f')))
function ccavDecrypt(string $hex, string $workingKey): ?string     // trim; reject '' / odd length / non-hex / > 200000 chars; openssl_decrypt; false → null; also reject results that are not valid UTF-8
```
Case-insensitive hex input. Pin one known vector in the unit test (encrypt "merchant_id=1&order_id=A" with key "TESTKEY" and assert decrypt(encrypt(x)) === x plus the exact hex produced by an independent Node implementation).

**Checkout payload** — built by `ccavCheckoutFields(array $txn, array $payable, array $cfg): array{url:string, fields:array{encRequest:string, access_code:string}}`. Plaintext = `key=value` pairs joined with `&`, **not URL-encoded** (kit behaviour), in this order:
`merchant_id, order_id, currency, amount, redirect_url, cancel_url, language=EN, billing_name, billing_address, billing_city, billing_state, billing_zip, billing_country, billing_tel, billing_email, merchant_param1, merchant_param2, merchant_param3`.

Field rules (research §3):
- `amount` = `number_format($amount, 2, '.', '')` (JPY: `number_format($amount, 0, '.', '') . '.00'`).
- `order_id` = attempt order_id. `merchant_param1` = payable type (`donation`/`seva_booking`), `merchant_param2` = the number, `merchant_param3` = attempt number.
- Every value passes `ccavClean(string $v, int $max, string $allowedPattern)`: strip `& = ' " < > \` and control characters and emoji (anything outside the Basic Multilingual Plane and all non-printing chars), collapse whitespace, trim, cut to max. Tamil letters are allowed in names/addresses (CCAvenue's documented charset is ASCII — if the gateway rejects them in test, the fallback is to send the English transliteration-free value `Devotee`; record this as a must-confirm item).
- `billing_name` ≤ 60; `billing_address` ≤ 150 (address_line; seva bookings send ""); `billing_city`, `billing_state` ≤ 30; `billing_zip` ≤ 15; `billing_country` = **full English country name** from a PHP copy of the ISO-2 → name map (India when unknown); `billing_tel` = digits only ≤ 20 (full international digits); `billing_email` ≤ 70 or "".
- The working key and access code never leave PHP except `access_code` inside the form fields (it is designed to be public).

The browser receives `{url, fields}` and auto-submits a hidden `<form method="post" action=url>` (§7.4). `redirected_at` is set when the fields are issued.

### 4.4 Response handling — redirect_url, cancel_url, notify URL

One function: `payHandleGatewayResponse(string $channel, array $post): array{status:string, number:?string, token:?string}` where channel ∈ `response|cancel|notify`.

1. Read `$_POST['encResp']` (form-encoded; `getJsonBody()` is not used). Reject bodies > 64 KB (413 on notify; result page "unknown" on browser channels). Log nothing but lengths.
2. Decrypt with **each environment key that could apply**: the environments of open attempts are known only after the order id is known, so try the current mode's key first, then the other configured mode's key. Nothing decrypts → audit `response_undecryptable` (no transaction id, data: channel, length, ip) and: browser channels 303 to `/payment/result?state=unknown`; notify 400.
3. Parse: split on `&`, each pair on the first `=`; keys trimmed; values `urldecode`d **only if** they contain `%` followed by two hex digits (research could not confirm encoding — must-confirm item). Duplicate keys: last wins.
4. Look up the attempt by `order_id` (`SELECT … FOR UPDATE` in a transaction). Unknown → audit `response_unknown_order` (data: order_id truncated to 30, channel) → result page `state=unknown`.
5. The decrypting key's environment must equal the attempt's `environment`; else treat as undecryptable for that attempt (audit `response_wrong_environment`, needs_review): no number and no access token are issued — browser channels 303 to `/payment/result?state=unknown`, notify answers 400.
6. Validate: `currency` equals the attempt's currency (case-insensitive); `amount` parsed as a decimal string equals the attempt amount to the paisa (compare `number_format(...,2)` strings; also accept `mer_amount` equal when `amount` differs only by a gateway discount — any difference sets `needs_review=1`, never SUCCESS); `merchant_param2` (if present) equals the number. Any mismatch → attempt `PENDING`, `needs_review=1`, audit `response_mismatch` with the expected/received values → the payable follows (§2.4).
7. Map `order_status` (§2.3). Store allow-listed response keys only in `gateway_response`: `order_id, tracking_id, bank_ref_no, order_status, failure_message, payment_mode, card_name, status_code, status_message, currency, amount, mer_amount, trans_date, bin_country, eci_value, retry, response_code, merchant_param1, merchant_param2, merchant_param3`. Set `tracking_id` (only if currently NULL; a different tracking id for the same order → needs_review + audit `tracking_conflict`), `bank_ref_no`, `payment_mode`, `card_name`, `failure_message`, `status_code`, `status_message`, `gateway_status`, `responded_at`, `response_count+1`, `verification='callback'` if it was `none`.
8. **Server confirmation:** if the mapped status is SUCCESS and the API is configured for that environment (§4.5), call `ccavOrderStatus(reference_no=tracking_id, order_no=order_id)` **before committing**, with a 12-second budget. Confirmed (Successful/Shipped with matching amount and currency) → SUCCESS, `verification='status_api'`, `verified_at`. API says otherwise → attempt PENDING + needs_review + audit `verification_disagrees`. API unreachable/error → SUCCESS stands on the callback alone, `verification='callback'`, audit `verification_unavailable`, and the cron re-verifies it (§9.1). The simulator's API always answers.
9. Apply the state (§2.4), commit, then (outside the transaction) raise notifications (§6) and audit `status_changed` (from → to).
10. cancel_url with no `encResp`: find nothing to update (no order id) → result page `state=cancelled` with no number; the stale INITIATED attempt is closed later by the cron (§9.1). Never trust a plain `orderNo` field to change state.
11. Idempotency: the row lock + transition table guarantee one SUCCESS, one receipt number, one `payment.succeeded` (its dedupe key is the order id, §6). A replayed identical response only increments `response_count` and writes `response_duplicate`.
12. Browser channels answer `303 See Other` → `siteUrl('/payment/result?ref=' . number . '&t=' . accessToken)` with headers `Cache-Control: no-store, private`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Notify channel answers `200 text/plain "OK"`. Any exception is caught inside the handler: logged with a reference, audit `response_error`, browser → `/payment/result?state=unknown`; notify → 500 text. The global JSON exception handler must never answer these routes.
13. GET/HEAD/other methods on the three routes → 303 to `/donations` (browser) — never an error page, because a donor may refresh the gateway return URL.

### 4.5 Server-to-server API

```php
function ccavApi(string $command, array $payload, array $cfg): array
// → ['ok'=>bool, 'data'=>?array (decrypted JSON), 'error'=>string, 'error_code'=>string, 'http'=>int]
```
- POST `application/x-www-form-urlencoded` via `notifyHttp()` (require `notify/contracts.php`; it never throws) with `enc_request=ccavEncrypt(json_encode($payload), apiWorkingKey)`, `access_code=apiAccessCode`, `command`, `request_type=JSON`, `response_type=JSON`, `version=1.2`. Timeout 15 s (12 s inside a callback).
- Parse the body as a query string. `status=1` → error; `enc_response` is plain text, `enc_error_code` the code. `status=0` → trim `\r\n` from `enc_response`, decrypt, `json_decode`; unwrap a single top-level wrapper key (`Order_Status_Result`, `Refund_Order_Result`, `Order_Result`) if present; inner `status` = 1 or non-empty `error_code` → error.
- HTTP 0/5xx/429 → `ok=false`, `error='unreachable'` (callers change no state).
- `ccavOrderStatus(?string $trackingId, string $orderId, array $cfg): array{ok, status:?string, amount:?string, currency:?string, tracking_id:?string, bank_ref_no:?string, raw:?array, error:string}` — accepts `order_curr` or `order_currncy`, `order_amt` (compare with attempt amount), `order_bank_ref_no`, `reference_no`.
- `ccavRefund(string $trackingId, string $amount, string $refundRef, array $cfg): array{ok, accepted:bool, reason:string, error_code:string}` — `refundOrder` `{reference_no, refund_amount, refund_ref_no}`; `refund_status` 0 = accepted.
- `ccavApiConfigured(string $environment): bool` — API credentials resolvable for that environment. (Production also needs CCAvenue to whitelist the server IP; error 51407 is reported to the admin as "CCAvenue refused the API call — ask CCAvenue to whitelist this server's public IP".)
- `getRefundDetails` and `orderLookup` are **not** coded.

### 4.6 Security rules (all builders)

- Credentials only in PHP memory. Grep the rendered HTML, JSON responses, logs, audit rows and notification rows in tests for the working key and access codes.
- `payment_transactions.gateway_response` and audit `data` go through `payRedact()` (drop keys matching /key|secret|password|token|access_code|card_number|cvv|expiry/i; truncate strings to 255).
- Public endpoints set no cookies, send `Cache-Control: no-store` and never return another payable's data: every read by number requires a valid access token (`hash_equals`).
- Numbers and order ids are validated with `^(DON|SEV)-\d{8}-\d{8}(-R[2-5])?$` before any query.
- The amount used for a new attempt always comes from the stored payable, never from the request.
- Honeypot, flood limits and 405s on every public POST (§5.5).
- The Vite PWA must never cache `/api/payments/*` (§7.8).
- Gateway return handlers need no CSRF or session: they are cross-site POSTs; authenticity comes from decryption + order lookup + amount/currency validation + API confirmation.

### 4.7 Simulator (development and automated tests only)

- Allowed only when `PAYMENTS_ALLOW_SIMULATOR=1` **and** mode=simulator. Otherwise its routes answer 404.
- Credentials: merchant id `9999999`, access code `SIMULATORACCESS`, working key from env `PAYMENTS_SIMULATOR_KEY` or the fixed dev value `simulator-working-key-not-secret`.
- `POST /api/payments/simulator` (the "checkout URL"): decrypts `encRequest`, checks `access_code`, renders a self-contained HTML page (inline CSS, its own CSP like `api/n.php` `nPage`) titled "CCAvenue simulator — test payments only", showing merchant id, order id, amount, currency, billing name, and buttons: **Pay (UPI)**, **Pay (Credit Card)**, **Decline**, **Cancel**, **Awaited**, **Tamper amount**, **Wrong currency**. Each button POSTs a freshly encrypted `encResp` (with `tracking_id` = 12 random digits, `bank_ref_no`, `trans_date` dd/MM/yyyy HH:mm:ss, the matching `order_status`) to the redirect_url (cancel → cancel_url). It records the attempt's simulated outcome in `payment_counters` under `sim:<order_id>` → `1`=success, `2`=failure, `3`=aborted, `4`=awaited so the simulator API answers consistently.
- `POST /api/payments/simulator/api`: implements `orderStatusTracker` (from the recorded outcome; unknown → `Initiated`) and `refundOrder` (accepts when amount ≤ paid − refunded; refund_amount ending in `.13` → refused with reason "Simulated refusal").
- A red banner "SIMULATOR — no real money" appears on the public result/receipt pages and in the admin when mode=simulator. The result and receipt pages show the banner from the payment's own attempt environment (`simulator` / `testMode` in `payPublicView()`, §5.5): a TEST-mode payment shows "Test mode — no real money was taken. This is not a receipt for a real donation." whatever the current mode is.

## 5. Backend module

### 5.1 Files

All logic lives in `backend/includes/payments/` (web access already denied by `backend/includes/.htaccess`). API files in `backend/api/` only parse the request, call the library and answer; each must be safe to hit directly (own method check, own try/catch where non-JSON).

| File | Contents |
|---|---|
| `backend/includes/payments.php` | Loader: requires db.php, helpers.php, public_guard.php, rate_limit.php, `notify/contracts.php` (for `notifyHttp`, `notifyRedact`) and every file below. |
| `payments/config.php` | `payTablesExist()`, `paySettingsAll()`, `paySetting()`, `paySettingSave()`, `paySecretEncrypt()`, `paySecretDecrypt()`, `payConfig()`, `payReady()`, `payPublicConfig()`, `paySupportedCurrencies()` |
| `payments/ccavenue.php` | §4.3–4.5 functions, `ccavClean()`, `ccavCountryName()` |
| `payments/money.php` | `payAmountParse()`, `payAmountFormat()`, `payMoneyLabel()` (notification-safe "Rs. 1,001" / "USD 25.00"), `payCurrencyDecimals()` |
| `payments/numbers.php` | `payNumberFor()`, `payOrderIdFor()`, `payParseNumber()`, `payNextReceiptNumber()`, `payAccessToken()`, `payAccessTokenValid()`, `payVerifyToken()`, `payIstDate()`, `payIstRangeUtc()` |
| `payments/validate.php` | `payValidateDonation()`, `payValidateSevaBooking()` (§5.2) |
| `payments/store.php` | `payCreateDonation()`, `payCreateSevaBooking()`, `payCreateAttempt()`, `payLoadPayable()`, `payLoadAttemptForUpdate()`, `payStateApply()`, `payDerivePayable()`, `payTransaction()` |
| `payments/response.php` | `payHandleGatewayResponse()` (§4.4), `payRespondBrowser()` |
| `payments/audit.php` | `payAudit()`, `payRedact()` |
| `payments/notify.php` | `payNotifySuccess()`, `payNotifyFailed()`, `payNotifyRefund()`, `payNotifyReceiptResend()`, `payChannels()` (§6) |
| `payments/refunds.php` | `payRefundCreate()`, `payRefundableAmount()` (§8) |
| `payments/reconcile.php` | `payReconcileSweep()`, `payVerifyAttempt()`, `payExpireHolds()`, `payReconcileReport()`, `payReconcileCsv()` (§9) |
| `payments/categories.php` | `payCategoriesActive()`, `payCategoryBySlug()`, `payCategoryLabel()` |
| `payments/simulator.php` | §4.7 |
| `payments/receipt.php` | `payPublicView()` (the status/receipt JSON shape, §5.5) |

Every function has a PHP-doc line; strict types in signatures; no global state except per-request static caches.

### 5.2 Validation contracts

`payValidateDonation(array $body, array $cfg): array{values:array, fields:array<string,string>}` — fields keys and rules (errors are English sentences; the frontend shows its own bilingual copy):

| Key | Rule |
|---|---|
| `category` | slug of an **active** category; required |
| `amount` | string or number; `payAmountParse()` accepts `^\d{1,10}(\.\d{1,2})?$` only (no exponent, no sign, no commas); ≥ `donation_min` and ≤ `donation_max` for INR; for foreign currencies ≥ 1 and ≤ `donation_max_foreign`; JPY must be whole |
| `currency` | in the allow-list; non-INR requires `international_enabled=1`; default = `default_currency` |
| `name` | 2–100 code points after trim, no control chars |
| `phone`, `phoneCountry` | `normalizePhone($phone, $country, true)` plus the per-country length table ported from `frontend/src/data/countries.js` (min/max national digits) into `payments/validate.php` (generated array, not hand-typed guesses) |
| `country` | ISO-2 in the country map; required |
| `email` | optional; `FILTER_VALIDATE_EMAIL`, ≤ 190 |
| `address`, `city`, `state`, `postcode` | optional; ≤ 250 / 120 / 120 / 15; postcode for IN must be 6 digits when given |
| `pan` | optional; uppercase-normalised; `^[A-Z]{5}[0-9]{4}[A-Z]$` |
| `message` | optional; ≤ 500 |
| `notes` | optional; ≤ 500 |
| `showNamePublicly` | `publicGuardConsent()` |
| `lang` | `devoteeLangFromInput()` |
| `hp_token` | honeypot |
| `acceptTerms` | must be true ("Please accept the terms and refund policy") |

Non-object bodies, arrays where strings are expected, and oversized input → a field error, never a 500.

`payValidateSevaBooking(array $body, array $cfg)` — `seva_id` (int, active seva, `amount > 0`, requires `seva_online_enabled=1`), `devotee_name` (2–100), `phone`/`phoneCountry`, `email` optional, `preferred_date` optional (`Y-m-d`, today or later in IST, ≤ 365 days ahead; invalid → field error, not silently null), `message` optional ≤ 500, `lang`, `acceptTerms`, `hp_token`. The price, seva name and currency (INR) come from the database.

### 5.3 Storage contracts

- `payTransaction(PDO $db, callable $work): mixed` — nested-safe begin/commit/rollback (copy the `notify/service.php` `$ownTx` pattern).
- `payCreateDonation(PDO $db, array $values, array $cfg, string $ip): array{payable:array, attempt:array}` — one transaction: insert the donation (`source='online'`, `status='INITIATED'`, `purpose` = category slug, `category_id`, all fields, `created_at=NOW()` for compatibility with legacy reports **and** `updated_at=UTC_TIMESTAMP()`), then set `donation_number` from the new id (`payNumberFor('donation', id, istDate)`), then `payCreateAttempt()`. Audit `payable_created` and `attempt_created`.
- `payCreateSevaBooking(...)` — same for `seva_bookings` (`payment_mode='online'`, `payment_status='INITIATED'`, `status='pending'`, `amount`, `currency='INR'`, `seva_name` from the DB in the booking language, `hold_expires_at = UTC + hold_minutes`).
- `payCreateAttempt(PDO $db, string $type, array $payable, string $environment, string $lang, string $ip): array` — attempt = max+1 (≤ 5, else throws `PayLimitException`), order_id per §1, amount/currency copied from the payable.
- `payStateApply(PDO $db, array $attempt, string $newStatus, array $facts, string $actor): array{changed:bool, from:string, to:string, payableFrom:?string, payableTo:?string, firstSuccess:bool}` — enforces §2.4 using the attempt row already locked by the caller, updates attempt columns from `$facts`, re-derives the payable with `payDerivePayable()` (locks the payable row), assigns the receipt number and `paid_at` on first success, writes audit rows. Pure DB; notifications are the caller's job after commit.
- A payable is loaded by number only through `payLoadPayable(PDO $db, string $number): ?array` which returns a normalised shape: `{type, id, number, status, amount, currency, amount_refunded, receipt_number, paid_at, created_at, name, phone, phone_country, email, lang, country, category:{slug,ta,en}|null, seva:{id,ta,en}|null, preferred_date, show_name_publicly, attempts:[…]}`.

### 5.4 Audit vocabulary (`payAudit(PDO $db, string $event, array $ctx)`)

`payable_created`, `attempt_created`, `redirect_issued`, `response_received`, `response_duplicate`, `response_undecryptable`, `response_unknown_order`, `response_wrong_environment`, `response_mismatch`, `tracking_conflict`, `response_error`, `verification_ok`, `verification_disagrees`, `verification_unavailable`, `status_changed`, `double_payment`, `receipt_assigned` (carries the receipt attempt's `transaction_id`, §1), `notification_queued`, `notification_skipped`, `receipt_emailed`, `retry_requested`, `hold_expired`, `refund_requested`, `refund_accepted`, `refund_refused`, `refund_succeeded`, `refund_failed`, `refund_manual_recorded`, `reconcile_checked`, `reconcile_csv_mismatch`, `admin_marked_reviewed`, `settings_changed` (no values, only key names). Each writes `detail` as a readable sentence, e.g. "Status changed from INITIATED to SUCCESS (verified with CCAvenue)". Admin actions also call `adminAudit()` (≤40-char action names prefixed `payment_`).

### 5.5 Public API

Routing in `backend/api/index.php`: one block **before** `$routes`:
```php
if (preg_match('#^/payments/(config|donations|seva-bookings|retry|status|receipt|receipt-email|verify|ccavenue/response|ccavenue/cancel|ccavenue/notify|simulator|simulator/api)$#', $path, $payMatch)) {
    $payRoute = $payMatch[1];
    require __DIR__ . '/payments.php';
    exit;
}
if (str_starts_with($path, '/payments/')) sendError('Not found', 404);
if ($path === '/payments-cron') { require __DIR__ . '/payments_cron.php'; exit; }
```
`backend/api/payments.php` dispatches on `$payRoute` (and, when hit directly without it, answers 404). Rate-limit buckets added to `PUBLIC_GUARD_LIMITS`: `payment-attempt` [20, 3600], `payment-created` [8, 3600], `payment-retry` [10, 3600], `payment-receipt-email` [5, 3600], `payment-lookup` [120, 3600]. All JSON answers use `sendJson` plus `Cache-Control: no-store, private`.

| Method + path | Behaviour |
|---|---|
| `GET /api/payments/config` | 200 `payPublicConfig()`: `{enabled:bool, ready:bool, simulator:bool, testMode:bool, currencies:[{code,decimals}], defaultCurrency, international:bool, min, max, maxForeign, presets:[int], categories:[{slug, name:{ta,en}, description:{ta,en}, suggestedAmount:?number}], sevaOnline:bool, holdMinutes}`. Never credentials, never the merchant id. When tables are missing: `{enabled:false, ready:false, …defaults}` with 200. |
| `POST /api/payments/donations` | Order: 405 unless POST → spend `payment-attempt` → `getJsonBody()` → honeypot (201 `{"success":true}`) → `payReady()` else 503 `payments_unavailable` → validate → 422 `{error:"Please check the highlighted fields.", fields}` → spend `payment-created` → create → 201 `{success:true, number, token, gateway:{url, fields:{encRequest, access_code}}, simulator:bool}` and audit `redirect_issued`. |
| `POST /api/payments/seva-bookings` | Same order; 201 same shape. |
| `POST /api/payments/retry` | Body `{number, token}`; 405/`payment-attempt`/token check (403 `{error, code:"bad_token"}`)/ready → allowed per §2.4 else 409 `{error, code:"not_retryable", status}` → spend `payment-retry` → new attempt → 201 same shape as create. |
| `GET /api/payments/status?ref=&t=` | spend `payment-lookup`; bad/unknown → 404 `{error:"Not found", code:"not_found"}` (same answer for both); 200 `payPublicView()`: `{kind:"donation"|"seva_booking", number, status, amount, currency, amountRefunded, createdAt, paidAt, receiptNumber, donorName, purpose:{ta,en}|null, seva:{ta,en}|null, preferredDate, trackingId, bankRefNo, paymentMode, failureMessage, canRetry, attempts, simulator, testMode, email:(masked "k•••@gmail.com" or null)}` (ISO-8601 UTC timestamps; `simulator` / `testMode` say which gateway the receipt attempt — else the latest attempt — went through, `simulator` also true while mode=simulator). |
| `GET /api/payments/receipt?ref=&t=` | Same guard; 404 unless status ∈ SUCCESS/REFUND_INITIATED/PARTIALLY_REFUNDED/REFUNDED; 200 `payPublicView()` + `{receiptNumber, verifyUrl, pan:(masked "ABCDE••••F" or null), address:{line,city,state,postcode,country}, message}`. |
| `POST /api/payments/receipt-email` | Body `{ref, t, email?}`; spend `payment-receipt-email`; guard; receipt statuses only; if the payable has no email, `email` is required, validated and **saved** to the payable; queues `payment.receipt` to email only (§6); 202 `{success:true, email:(masked)}`; 409 when email notifications are off (`code:"email_off"`). |
| `GET /api/payments/verify?r=&v=` | spend `payment-lookup`; `r` matches `^[A-Z]{2,8}-\d{4}-\d{6}$`, `v` valid → 200 `{valid:true, receiptNumber, date (IST date), amount, currency, status, purpose|seva {ta,en}, donor:"S•••• K••••" or "Anonymous devotee" when show_name_publicly=0}`; otherwise 200 `{valid:false}` (never 404, to avoid probing differences). |
| `POST /api/payments/ccavenue/response`, `/cancel`, `/notify` | §4.4. Not rate-limited by IP (CCAvenue's servers may share addresses) but bodies are capped. |
| `* /api/payments/simulator`, `/simulator/api` | §4.7. |
| `GET|POST /api/payments-cron` | §9.1. |

The existing `POST /api/donations`, `POST /api/seva-bookings`, `GET /api/donors` keep their exact contracts, with one change: `GET /api/donors` must list only pledges and SUCCESS/PARTIALLY_REFUNDED online donations (`source='pledge' OR status IN ('SUCCESS','PARTIALLY_REFUNDED')`), still consent-only and 30 days, still `{name,label,type}`; `label` becomes the category's English name when the purpose matches a category (the frontend already prints it raw).

## 6. Notifications

Use the existing service unchanged (`devoteeNotifyEvent()`), always **after** the DB transaction commits, never letting a notification failure change a payment. Recipient is a guest: `to_phone` = `devoteeIntlPhone(phone, phone_country)`, `to_email` when present, `name`, `lang`, `entity_id`. `channels` is always passed explicitly from `payChannels()`:
- success / refund / admin resend: `email` if `notify_email=1`; `whatsapp` if `notify_whatsapp=1`; `sms` if `notify_sms=1`.
- failure: `['email']` only, and only if `notify_email=1` and an email exists. No message on CANCELLED, on hold expiry, or on INITIATED.
- donor "Email receipt" button: `['email']` only.

`details` rows (email table): Receipt number, Donation ID / Booking ID, Purpose or Seva, Amount, Payment date (IST), Payment mode, CCAvenue reference. `cta_url` = `/payment/receipt?ref=<number>&t=<token>` (site path; the service turns it into a tracked absolute link).

### 6.1 Catalogue changes (`backend/includes/notify/events.php`)

| Event | Template | Priority | Channels (default) | Dedupe | Entity | Raised |
|---|---|---|---|---|---|---|
| `donation.paid` **new** | `donation_paid` | important | email, whatsapp, sms | `donation:{vars.paymentReference}:paid` | donation | first SUCCESS of an online donation |
| `payment.succeeded` (exists) | `payment_success` (rewrite) | important | email, whatsapp, sms | `payment:{vars.paymentReference}:success` (unchanged) | payment | first SUCCESS of an online seva booking |
| `payment.failed` (exists) | `payment_failed` (update) | **important** (was urgent) | email | `payment:{vars.paymentReference}:failed` (unchanged) | payment | an attempt becomes FAILED; `paymentReference` = that attempt's order_id |
| `payment.refunded` **new** | `payment_refund` | important | email, whatsapp, sms | `refund:{entity_id}:processed` | payment_refund | a refund becomes SUCCESS; entity_id = refund id |

`paymentReference` = the payable **number** for success events, so a double payment or a replayed callback can never send twice. Admin/donor receipt resends re-raise `donation.paid` / `payment.succeeded` with `dedupe_key` overridden to `receipt:{number}:resend:{sequence}` (sequence = count of earlier resends + 1, from `notifications` rows with that key prefix) and the resend channels. Update the header comment at events.php (the "no payment gateway" note) and the catalogue count assertion in `tests/notify-unit.php` (15 → 17).

### 6.2 Templates (`backend/includes/notify/defaults.php`, built-in; Tamil + English; `any`, `sms`, `whatsapp` variants)

- `donation_paid` (category `donation`). Variables: `devoteeName, receiptNumber, paymentReference, paymentAmount, paymentFor, paymentDate, paymentMode, trustName, taxNote, ctaUrl`. English title "Thank you for your donation" (requirement §17). English SMS: `Thank you for your contribution of {{paymentAmount}}. Your Donation ID is {{paymentReference}}. Receipt: {{ctaUrl}}` — must stay one GSM-7 segment with the sample values (shorten the sample link or drop "Receipt:" if needed; the unit test decides). CTA label "View receipt".
- `payment_success` (category `payment`) — rewrite for seva bookings. Variables: `devoteeName, receiptNumber, paymentReference, paymentAmount, paymentFor (seva name), bookingDate, paymentDate, paymentMode, ctaUrl`. Body says the payment is received and the temple office will call to confirm the date. Remove "No payment gateway exists yet" from the description.
- `payment_failed` (category `payment`). Variables: `devoteeName, paymentReference, paymentAmount, paymentFor, reason, ctaUrl` (cta = the result page, which offers Try again). Reassuring: no money was taken; if money left the account, it is returned by the bank automatically. **Do not use the word "account" / "கணக்கு"** (notify-unit rule) — say "if your bank shows a debit".
- `payment_refund` (category `payment`). Variables: `devoteeName, refundAmount, paymentReference, receiptNumber, refundReference, paymentFor, ctaUrl`. Says the refund has been sent to CCAvenue and usually reaches the original payment method in 5–7 working days.
- Rules enforced by tests: no "account" wording; English SMS ≤ 160 GSM-7 chars with samples (use "Rs."/"INR", no ₹, no curly quotes or dashes); rendered titles ≤ 60 chars; Tamil SMS ≤ 2 UCS-2 segments. Add sample values for every new variable to `notifyTemplateSample()` in `backend/includes/notify/templates.php` (receiptNumber `TMR-2026-000042`, paymentReference `DON-20260914-00001234`, paymentDate, paymentMode `UPI`, refundAmount, refundReference `RF12T1789300000`, bookingDate).
- Update `tests/notify-templates-unit.php` `$spec` for these four keys only if that suite is being repaired anyway; otherwise record it as stale (it already fails for unrelated reasons).
- The `donation.received` pledge event and `booking.received` request event stay exactly as they are and are **not** raised for online payables.

`payMoneyLabel(string $amount, string $currency): string` → `Rs. 1,001` / `Rs. 501.50` for INR (Indian digit grouping is not required; match `devoteeMoneyLabel`), `USD 25.00`, `JPY 3000`.

## 7. Frontend

Conventions (from `map-frontend.md`; all mandatory): bilingual inline `t(ta, en)` for every visible string and aria-label; one `<h1>` per page (PageHero); tokens only, no raw colours, no visual inline styles (custom properties allowed); icons from `react-icons/lu`; touch targets ≥ 44px; `npm run audit` stays at 0; no horizontal overflow at 390/768/1024/1440; no console errors (so payment calls use `fetch`, not the axios client that logs non-2xx); axe clean (no serious/critical); reduced motion respected.

### 7.1 Routes (`frontend/src/App.jsx`, lazy, inside `PageTransition`)

| Path | Component | Indexed |
|---|---|---|
| `/donate` | `pages/Donate.jsx` | yes — add to `site_pages.php`, `search.php $PAGES`, `tests/og.mjs` ROUTES, `tests/public-e2e.mjs` ROUTES |
| `/payment/result` | `pages/PaymentResult.jsx` | no (`<Seo robots="noindex, nofollow">`; not in site_pages, so og.php answers 404 noindex) |
| `/payment/receipt` | `pages/PaymentReceipt.jsx` | no |
| `/payment/verify` | `pages/ReceiptVerify.jsx` | no |
| `/privacy-policy`, `/terms-and-conditions`, `/refund-cancellation-policy`, `/shipping-delivery-policy` | `pages/Policy.jsx` with `slug` prop (`privacy`, `terms`, `refunds`, `shipping`) | yes (same four registrations as /donate) |

### 7.2 Shared code

- `lib/payments.js`
  - `usePaymentsConfig()` → `{ config, loading, error }`; one `fetch('/api/payments/config')` per page load (module-level promise cache); on failure `config = { enabled:false, ready:false }`.
  - `submitToGateway({ url, fields })` — builds a hidden `<form method="post" action={url}>` with one hidden input per field, appends to `document.body`, submits.
  - `readLastPayment()` / `writeLastPayment({ number, token, kind })` / `clearLastPayment()` — sessionStorage `temple:payment-last`, try/catch.
  - `STATUS_META` — per status: `label:[ta,en]`, `tone` (SUCCESS success · FAILED danger · CANCELLED muted · INITIATED/PENDING warning · REFUND_INITIATED info · PARTIALLY_REFUNDED gold · REFUNDED muted). Never moon or sage.
  - `postJson(path, body)` → `{ ok, status, body, retryAfterHeader }` without throwing.
- `lib/money.js` — `formatMoney(amount, currency, lang)` via `Intl.NumberFormat(lang === 'ta' ? 'ta-IN' : 'en-IN', { style:'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals })` where decimals = 0 for JPY else 0 when the value is whole and 2 otherwise; `parseAmountInput(str)` using the server's regex `^\d{1,10}(\.\d{1,2})?$`; `amountInWordsINR(amount)` → "Rupees Five Thousand and Fifty Paise Only" (Indian system: thousand, lakh, crore), English only, used on the receipt.
- `lib/donation.js` — `DONATE_STEPS` = `[{key:'purpose', label:[…], heading:[…]}, {key:'details', …}, {key:'review', …}]`; `initialDonationForm(lang, config)`; `validateDonationStep(step, form, t, config)` and `validateDonationAll` mirroring §5.2 exactly (reuse `phoneProblem(…, {required:true, t})`, `charCount`, PIN rule for India, `PAN_RE`); `fieldIdFor(key)` (ids prefixed `don-`); `fieldLabel(key, t)`; `toDonationPayload(form)`; `mapServerFields(fields, form, t)`.
- `components/ui/FormStepper.jsx` — generic copy of `RegistrationStepper` taking `steps` and `ariaLabel` props; CSS in `styles/components.css` under `.form-stepper*` with a `--steps` custom property (not `.stepper`, which is taken). `components/ui/FormErrorSummary.jsx` — generic ErrorSummary with a `titleId` prop. **Do not modify the Registration components** (no churn in a finished flow).
- `components/Payments/`: `PaymentRedirect.jsx` (full-card overlay: spinner, "Redirecting securely to CCAvenue…" / "CCAvenue பாதுகாப்பான பக்கத்திற்கு அழைத்துச் செல்கிறோம்…", role="status", calls `submitToGateway` on mount, shows a "Continue to CCAvenue" button after 4 s and a `<noscript>` note); `StatusBadge.jsx`; `ReceiptDocument.jsx` (pure presentation, §7.6); `EmailReceiptForm.jsx`; `SimulatorBanner.jsx` (danger alert "Simulator — no real money is taken", also used for test mode with text "Test mode — use CCAvenue test cards only" on the Donate page and, with the `outcome` prop on the result and receipt pages, "Test mode — no real money was taken. This is not a receipt for a real donation."); `Payments.css` (`pay-` prefix).

### 7.3 `/donate` — the Donate page

Layout: `PageHero` (variant `donations`, eyebrow 80G note, title "Donate online" / "இணையவழி நன்கொடை", crumbs Donations › Donate online). Below, a `container container--narrow` with the stepper, the step card and the actions — the same visual language as `/register` (card, stepper, mobile dock portalled to `document.body`, sessionStorage draft, `?step=` in the URL with the reachability guard, focus + announcement on step change, error summary). Copy the Register.jsx engine patterns; do not import registration modules other than `charCount`/`templeToday`/`countryName` from `lib/familyRegistration.js`.

When `config` is loading: skeleton. When `!config.enabled || !config.ready`: a card "Online donations will open soon" with buttons "Bank transfer details" (`/donations#bank-details`) and "Tell us you will donate" (`/donations#pledge`) — no stepper.

**Step 1 — Purpose & amount** (`purpose`)
- Category radio cards (`fieldset` + `legend`), each with name, description, and suggested amount; required. Picking a category with a suggested amount fills the amount **unless** the donor has typed their own.
- Amount: preset radio chips from `config.presets` (formatted with `formatMoney`), plus "Other amount" (`IconInput`, `inputMode="decimal"`, currency symbol icon or code), required; errors: "Enter an amount of at least ₹1" etc. using config min/max.
- Currency: shown only when `config.international && config.currencies.length > 1`; a `<select id="don-currency">` listing code + English/Tamil name; changing it clears presets (presets are INR) and shows "Amounts are in {code}".
- Live summary line (aria-live polite): "You are giving ₹5,000 (INR) for Temple Development".

**Step 2 — Your details** (`details`) — ids `don-name`, `don-phone`, `don-country`, `don-email`, `don-address`, `don-city`, `don-state`, `don-postcode`, `don-pan`, `don-message`, `don-notes`, `don-show-name`.
- Required: Full name, Mobile number (`PhoneInput`), Country (`CountrySelect`, default IN; the phone country follows it until a number is typed, as in Register).
- Optional: Email ("for your receipt"), Address, City, State (`StateSelect`), Postal/PIN code (6 digits for India), PAN ("needed only for an 80G tax receipt"; uppercase as typed; not saved in the draft), Message ("shown to the temple office"), Notes ("private note for the office").
- Consent: unticked checkbox "Show my name on the temple's thank-you list" with hint "Leave it unticked to donate anonymously. Only your name and purpose are shown — never the amount or your phone."
- The honeypot `hp_token` sits between two real fields (same markup as Register).

**Step 3 — Review** (`review`)
- Two review sections with Edit buttons (Purpose & amount; Your details). The amount and currency are shown large at the top: "₹5,000 · INR", with the purpose under it.
- Required checkbox `don-accept-terms`: "I have read the Terms & Conditions and the Refund & Cancellation Policy" (links open in a new tab with `rel="noopener"`).
- Secure-payment note: "You will pay on CCAvenue's secure page by UPI, card, net banking or wallet. We never see your card details."
- Test mode / simulator banner when applicable.
- Primary button "Proceed to payment" (`LuLock`). On press: set `sending` synchronously (button disabled + `aria-busy`, repeated presses ignored), POST `/api/payments/donations`, then on 201 `writeLastPayment`, set `redirecting` and render `PaymentRedirect`. Keep the draft (cleared only on a SUCCESS result). Errors: 422 → `mapServerFields` → open the first bad step; 429 → limited message via `rateLimitMessage`; 503 → "Online donations are paused right now…" with offline links; network → "Check your connection and try again"; all keep the data.
- `pageshow` with `event.persisted` (back button from CCAvenue) → leave `redirecting`, return to the review step idle.

Mobile dock (≤768px): Back / primary, and above the buttons a one-line amount summary "₹5,000 · Temple Development" once an amount is chosen.

Draft key `temple:donation-draft` `{v:1, furthest, form}` without `pan` and `hp_token`.

### 7.4 `/payment/result`

Query: `ref`, `t`, optional `state` (`unknown`, `cancelled` when the server had no order). Always `noindex`.
- No `ref`: `state=cancelled` → "Payment cancelled" card; otherwise "We could not read the payment result" + "If money was taken from your bank, it will be confirmed or returned automatically. Call the temple office if you need help." Buttons: Try again (only if `readLastPayment()` exists → retry flow below), Return to the donation page (`/donate?step=review`), Contact (`/contact`).
- With `ref` + `t`: `GET /api/payments/status`; skeleton while loading; 404 → the "could not read" card.
- **SUCCESS / refund states**: check icon, h2 (focused) "Thank you for your contribution" (donation) or "Payment received for your seva" (seva), sentence "Your donation has been successfully received." / seva equivalent + "The temple office will call you to confirm the date." A `<dl>`: Donation ID or Booking ID (`number`), CCAvenue reference (`trackingId`), Date (IST, `paidAt`), Donor name, Purpose or Seva, Amount (`formatMoney`), Currency, Payment status (`StatusBadge`), Payment mode, Receipt number. Actions: **Download receipt** (→ `/payment/receipt?ref&t`), **Print receipt** (→ same with `&print=1`), **Email receipt** (`EmailReceiptForm`: button "Email it to k•••@gmail.com" when an email is on file, else an email field; POST `/api/payments/receipt-email`; success/limited/error messages), **Return home**. Clears `temple:donation-draft` and the last-payment entry.
- **FAILED**: h2 "Payment unsuccessful", "We were unable to complete your payment." plus `failureMessage` when present; actions **Try again**, **Choose another payment method** (both POST `/api/payments/retry` with `{number, token}` then `PaymentRedirect`; the second label explains that CCAvenue's page lets them pick UPI, card or net banking), **Contact support** (`/contact`) and the temple phone.
- **CANCELLED**: h2 "Payment cancelled", "You cancelled the payment. No money was taken." Actions **Try again** (retry) and **Return to donation page** (`/donate?step=review`, draft still there; seva → `/sevas`).
- **INITIATED / PENDING**: h2 "Confirming your payment…" with a spinner; poll status every 3 s for 30 s, then every 10 s up to 3 minutes; then "This is taking longer than usual. We will send you a message as soon as CCAvenue confirms. You can safely close this page." Retry is offered only when `canRetry` is true. Announce status changes through a polite live region.
- Retry 409 (`not_retryable`) → reload status. 429/503/network handled as on the Donate page.

### 7.5 Sevas booking dialog (`frontend/src/pages/Sevas.jsx`)

When `config.enabled && config.ready && config.sevaOnline` and the seva comes from the live list (not `FALLBACK_SEVAS`) and `amount > 0`:
- Add a radio group at the top of the form: "Pay ₹{amount} online now" (default) / "Send a booking request — pay at the temple". Keep exactly **one** submit button; its label follows the choice ("Pay ₹251 securely" / current label).
- Online choice adds optional Email and a required terms checkbox (same links), posts `/api/payments/seva-bookings` with `{seva_id, devotee_name, phone, phoneCountry, email, preferred_date, message, lang, acceptTerms, hp_token}`, then `writeLastPayment` + `PaymentRedirect` inside the dialog.
- Request choice posts to `/api/seva-bookings` exactly as today (and now also sends `lang`).
- Otherwise the dialog is unchanged, so every existing test selector keeps working.

### 7.6 `/payment/receipt` and the receipt document

`GET /api/payments/receipt?ref&t` → `ReceiptDocument`. If `print=1`, call `window.print()` once after the document has rendered.
- Header: logo (`/logo.svg`), temple name (Tamil and English), Trust name, address (`ADDRESS.printed`), phone (`PRIMARY_CONTACT`), email (move `info@dhabbalavaartemple.in` from `Footer.jsx` into `temple.js` as `TEMPLE_EMAIL` and use it in both), Trust registration number + PAN + 80G line from `TRUST`.
- Title "Donation receipt / நன்கொடை ரசீது" (or "Seva payment receipt").
- Body (definition list, two columns on A4): Receipt number, Receipt date (IST), Donation/Booking ID, Payment reference (CCAvenue), Bank reference, Donor name, Address (when given), PAN (masked), Purpose or Seva (+ preferred date), Amount (figures via `formatMoney`, and for INR `amountInWordsINR`), Currency, Payment mode, Payment date & time (IST), Payment status (and refunded amount when any).
- Footer: "This is a computer-generated receipt and does not need a signature." + QR code (`QRCodeSVG` from the existing `qrcode.react` dependency) of `verifyUrl`, with the URL printed under it as text.
- Screen-only toolbar: **Download PDF** (`window.print()` with a visible hint "Choose 'Save as PDF' in the print window"), **Print**, **Email receipt** (`EmailReceiptForm`), **Home**.
- Print stylesheet (in `PaymentReceipt.css`): `@page { size: A4; margin: 14mm; }`; hide `.skip-link, .pulse-strip, .navbar, .drawer, .drawer-backdrop, .footer, .bottom-nav, .fab-group, .toast-region, .page-hero, .chatbot__window`, the chatbot launcher, the receipt toolbar and the simulator banner's close button; white background, `--text-1` text, no shadows; the document fits one page.

### 7.7 `/payment/verify`

`GET /api/payments/verify?r&v`. Valid → card with a check icon "This receipt is genuine", receipt number, date, amount, purpose/seva, status, donor (masked or "Anonymous devotee"). Invalid → "We could not verify this receipt" + contact. `noindex`.

### 7.8 Other frontend changes

- `frontend/vite.config.js` — add a `runtimeCaching` entry **before** the generic `/api` rule: `urlPattern: ({url}) => url.pathname.startsWith('/api/payments')`, `handler: 'NetworkOnly'`.
- `/donations` (`pages/Donations.jsx`) — when payments are enabled and ready, add a prominent "Donate online" card at the top of the left column and a hero action "Donate online" (→ `/donate`); keep the pledge form, bank details, anchors and every test selector unchanged; pass `t` to `phoneProblem` and send `lang` with the pledge (fixes noted in the research).
- Home "Online Donation" tile (`pages/Home.jsx`) — button goes to `/donate` when payments are enabled, else stays `/donations#bank-details`; its text stops claiming "bank transfer" when online giving is on.
- Footer (`components/Layout/Footer.jsx` + `Footer.css`) — a small legal-links `nav` in the bottom bar: Privacy Policy · Terms & Conditions · Refund & Cancellation · Shipping & Delivery.
- `pages/Policy.jsx` + `data/policies.js` + `pages/Policy.css` — one component, four pages; `PageHero` (no variant needed, or add `.page-hero--legal` in `layout.css`), a "Last updated 14 September 2026" line, chip table of contents like About, `container container--narrow page-prose`; add `ul/ol/li` rules to `.page-prose` in `PageCommon.css`. Content (Tamil + English), factual and specific to the Trust (name, registration 9/2023, PAN, address, phone, email from `temple.js`):
  - **Privacy**: what we collect for donations and bookings (name, phone, country, optional email/address/PAN, message); why (processing the payment, receipts, 80G, contacting about bookings); card/UPI/bank details are entered only on CCAvenue's PCI-DSS page and never reach us; shared only with CCAvenue and our message providers (email/SMS/WhatsApp) to deliver receipts; names on the thank-you list only with consent; retention (payment records kept as the law requires for accounts and audit, at least 8 years); donors can ask for correction or removal of non-mandatory data via the contact details; no sale of data; cookies: the site sets none for payments.
  - **Terms**: voluntary contributions to the Trust; accurate details; amounts in the chosen currency; payment processed by CCAvenue; receipts issued electronically after confirmation; 80G eligibility subject to the Trust's registration and applicable law; seva bookings subject to temple schedules; misuse and fraudulent payments refused; governing law India, courts of Tenkasi district, Tamil Nadu.
  - **Refunds & cancellation**: donations are voluntary and generally not refundable; refunds for duplicate payments, a wrong amount charged by error or an unauthorised transaction if reported within 7 days with the Donation ID; seva bookings: full refund if the temple cannot perform the seva, refund if the devotee cancels at least 48 hours before the confirmed date; refunds go back to the original payment method through CCAvenue, usually in 5–7 working days; how to ask (phone, email, Donation ID).
  - **Shipping & delivery**: the Trust sells and ships no physical goods; donations are acknowledged by an electronic receipt shown immediately and sent by email/SMS/WhatsApp; sevas are performed at the temple on the confirmed date; any prasadam is collected at the temple and is not posted.
- `backend/includes/site_pages.php` — entries for `/donate` and the four policy paths with exactly the titles/descriptions the pages pass to `<Seo>`; `backend/api/search.php` `$PAGES` entries (keywords: donate online upi card net banking ccavenue receipt; privacy policy; terms; refund cancellation; shipping delivery); `backend/api/chat.php` system facts — remove "bank transfer or cheque ONLY / no other payment method" and say online donation by UPI/card/net banking is available at `/donate` when enabled (keep "no UPI ID — never invent one").

## 8. Refunds

- Who: capability `payments.refund` (owner). Where: the payment detail view in `admin/payments.php`.
- Refundable amount = SUCCESS attempt amount − sum of refunds in `REQUESTED|PROCESSING|SUCCESS` **against that attempt**. The receipt attempt (§1) can be refunded only while the payable is in `SUCCESS|PARTIALLY_REFUNDED` (and `REFUND_INITIATED` for a further partial once the first settles); an extra attempt of a double payment is refunded against itself and only needs the payable to be paid (any of the four paid statuses), because its refund never moves the payable (§2.4).
- Form: kind (full = the whole refundable amount; partial = amount field, > 0, ≤ refundable, 2 decimals, whole for JPY), reason (required, 5–500 chars), and method shown as fact: "Sent to CCAvenue automatically" when `ccavApiConfigured(attempt.environment)`, else "Record a refund you have already made in the CCAvenue dashboard" with an optional gateway reference field and a required tick "I have already refunded this in the CCAvenue dashboard". When more than one attempt is refundable (a double payment) a "Which payment" select names each attempt with its remaining amount, the receipt attempt first. Typing an amount selects "Part of it"; the server refuses `kind=full` posted together with an amount that is not the refundable amount ("An amount was typed but “Full” is selected…"), so a typed figure is never silently replaced by a full refund.
- Confirmation: the submit button uses `data-confirm` with the exact sentence "Refund ₹1,000.00 of DON-20260914-00001234 to S. Kumar? This cannot be undone." (amount formatted with currency). The sentence is rebuilt from the form as it stands when the button is pressed — the chosen attempt's remaining amount for "Full", the typed amount for "Part of it" — and `admin.js` reads `data-confirm` at press time.
- `payRefundCreate(PDO $db, array $payable, array $attempt, string $kind, string $amount, string $reason, string $method, ?string $gatewayRef, string $actor): array{ok, refund:array, message}`:
  1. Transaction: lock the attempt, then the payable (the same order as a gateway callback, `payApplyGatewayResponse` → `payDerivePayable`, so a refund and a late callback never deadlock); recompute refundable; insert `REQUESTED`; payable → `REFUND_INITIATED` (receipt attempt only); audit `refund_requested`; commit.
  2. `gateway_api`: call `ccavRefund()` outside the transaction. Accepted → refund `SUCCESS` (`processed_at`, gateway message), audit `refund_accepted` + `refund_succeeded`. Refused → `FAILED` with the reason, audit `refund_refused`. Unreachable → stays `REQUESTED` with message "CCAvenue did not answer"; the detail view offers **Check again** (re-sends with the same `refund_ref_no`, which CCAvenue treats as the same refund) and **Mark as failed** (owner, reason required).
  3. `manual`: refund `SUCCESS` immediately, audit `refund_manual_recorded`.
  4. After any refund status change, transaction (`payDerivePayable`): `amount_refunded` = sum of SUCCESS refunds against the receipt attempt; payable status = `REFUNDED` if equal to the amount, `PARTIALLY_REFUNDED` if > 0, `REFUND_INITIATED` while any refund against the receipt attempt is REQUESTED/PROCESSING, else back to `SUCCESS`. Refunds of an extra (double-payment) attempt change none of these. Then `payment.refunded` for each newly SUCCESS refund. `adminAudit('payment_refund', number, "…")`.
- The original payment row and attempt are never modified by a refund (only the payable's derived `status` and `amount_refunded`).
- A fully refunded seva booking is **not** auto-cancelled; the detail view shows "Also cancel the booking?" linking to the booking in `seva_bookings.php`.
- Refunded donations leave the public donors list (§5.5 filter).

## 9. Reconciliation, verification and scheduled work

### 9.1 Sweep (`payReconcileSweep(PDO $db, array $opts): array`)

Selects, oldest first, up to `limit` (default 40) attempts whose `last_checked_at` is NULL or older than 10 minutes:
- `INITIATED` older than 20 minutes; `PENDING` older than 10 minutes;
- `SUCCESS` with `verification IN ('none','callback')` (created in the last 30 days);
- optional `orderIds` filter (tests and the admin "Check now" button).

For each: `payVerifyAttempt()` = `ccavOrderStatus()` → map (§2.3) → `payStateApply()` with `verification='status_api'` when it agrees; amount/currency disagreement → `needs_review=1` + `verification_disagrees`; API refunds/chargebacks → `needs_review=1` + audit. `last_checked_at` is always updated; an unreachable API changes nothing else (audit `verification_unavailable` at most once per attempt per hour).

Abandonment: an `INITIATED` attempt older than 3 hours whose status API answer is "no record" (error codes 51419/51308/51313) or `Initiated` becomes `CANCELLED` (audit detail "Closed: no payment reached CCAvenue within 3 hours"). If the API is not configured for that environment, the same attempt becomes `CANCELLED` after 3 hours with detail "Closed: not verifiable, no response within 3 hours" and `needs_review=0`. A later SUCCESS response still revives it (§2.4).

`payExpireHolds(PDO $db): int` — online seva bookings whose `hold_expires_at` has passed and whose payable status is `INITIATED|PENDING|FAILED|CANCELLED` (after the sweep has had a chance to verify them): set booking `status='cancelled'` and audit `hold_expired`. No notification. If a SUCCESS later arrives for such a booking, `payStateApply` restores `status='pending'` and audits `booking_restored` — only while the cancellation is the hold's (`payBookingCancelledByHold()`: the newest `hold_expired` / `booking_restored` row is `hold_expired`); a booking the office cancelled, before or after a restore, is neither retried (§2.4) nor restored.

Entry points:
- CLI `backend/bin/payments_cron.php [--limit=40] [--max-seconds=50] [--order-ids=A,B] [--json]` (CLI-only guard like `notify_worker.php`; MySQL `GET_LOCK('temple_payments_cron', 0)` to avoid overlap).
- HTTP `GET|POST /api/payments-cron` (`backend/api/payments_cron.php`) — copy `notify_cron.php`: 404 unless `PAYMENTS_CRON_KEY` ≥ 24 chars; key in `X-Cron-Key` or `?key=`; `hash_equals`; wrong keys rate-limited (`rateLimitPeek`/`rateLimitAllow`, 30/hour); `ignore_user_abort(true)`; 503 when tables are missing; JSON summary `{checked, changed, cancelled, expired, errors}`.
- Admin **Run checks now** button (reconciliation tab; `payments.manage`), limit 20, same function.

Deployment note (README + `.env.example`): run the CLI every 10 minutes (Hostinger cron) or call the HTTP endpoint; the notification worker must also run for receipts to be sent.

### 9.2 Reconciliation report (`admin/payments.php?view=reconcile`)

Filters: IST date range (default last 30 days), kind. Sections, each a table with counts and "Open" links to the detail view:
1. **Paid at CCAvenue, not paid here** — attempts where the latest status-API answer (stored in audit data of `verification_disagrees`/`reconcile_checked`) is Successful/Shipped but our attempt is not SUCCESS, plus CSV rows (below) with a success status whose order is not SUCCESS here.
2. **Paid here without CCAvenue confirmation** — SUCCESS attempts with `verification IN ('none','callback')`.
3. **Needs review** — `needs_review=1` (mismatches, tracking conflicts, double payments, disagreements), with "Mark reviewed" (note required).
4. **Duplicate callbacks** — `response_count > 1` (informational).
5. **Double payments** — payables with more than one SUCCESS attempt, one row per SUCCESS attempt: the receipt attempt is marked as the one to keep; each extra attempt says whether it is unrefunded, partly refunded, waiting for CCAvenue, or refunded in full.
6. **Missing transactions** — CSV orders not found here; our SUCCESS attempts inside the CSV's date span that are absent from the CSV.
7. **Refund mismatches** — `amount_refunded` ≠ sum of SUCCESS refunds against the receipt attempt; payable status inconsistent with the refunds against the receipt attempt; refunds (against any attempt) `REQUESTED` for more than 24 hours; CSV rows marked refunded with no refund here.
8. **Stale open attempts** — INITIATED/PENDING older than 3 hours that the sweep could not settle.

**CSV comparison** (`payReconcileCsv(PDO $db, string $path): array`): the admin uploads the order/transaction report exported from the CCAvenue dashboard (≤ 5 MB, `.csv`). Header detection by case-insensitive aliases — order: `Order No`, `Order Number`, `Order Id`, `order_no`, `order_id`; reference: `Reference No`, `Reference Number`, `Tracking Id`, `reference_no`, `tracking_id`; amount: `Amount`, `Order Amount`, `Order Amt`, `order_amt`; currency: `Currency`, `order_currency`; status: `Order Status`, `Status`, `order_status`; date: `Order Date`, `Date`, `Order Date Time`. Missing order/amount/status columns → a clear error listing the aliases. Rows are compared in memory (order id → attempt): status class, amount, currency, reference. The file is not stored; each mismatch writes `reconcile_csv_mismatch` (data: order id, field, ours, theirs). CSRF + `payments.manage`. The exact CCAvenue export headers are a must-confirm item (§14).

## 10. Admin

### 10.1 Capabilities (`backend/includes/auth.php`)

Add to `ADMIN_CAPABILITIES`: `payments.view` → viewer, `payments.manage` → editor, `payments.refund` → owner, `payments.settings` → owner.
`adminPageCapability`: `payments.php` → `payments.view`; `payment_settings.php` → `payments.settings`; `donation_categories.php` → `content.edit`.
`adminPageWriteCapability`: `payments.php` → `payments.manage` (the refund actions additionally call `requireAdminCan('payments.refund')`); `payment_settings.php` → `payments.settings`; `donation_categories.php` → `content.edit`.
Viewers can read and export payments (export includes phone and email, as the donations export already does).

### 10.2 Navigation (`admin/includes/admin_layout.php`)

- Group "Devotees": after donations.php add `payments.php` → `['landmark', 'Online Payments', 'Donation and seva payments, refunds, reconciliation']`.
- Group "Worship" (or "Content" if that is where the donation copy lives): `donation_categories.php` → `['heart-hands', 'Donation Categories', 'Purposes donors can give to']`.
- Group "Data & System": `payment_settings.php` → `['shield', 'Payment Gateway', 'CCAvenue mode, keys, currencies and limits']`.
- Palette/quick action: "Export payments CSV" (`/admin/payments.php?export=csv`, can `export`). Add any new icon names to the palette sprite if used there.
- When mode=simulator or test, `adminHeader` shows a small badge in the topbar ("Payments: TEST" / "Payments: SIMULATOR") on payment pages only.

### 10.3 `admin/payments.php` — Online Payments

Tabs (`?view=`): **Overview** (default), **Transactions**, **Refunds**, **Reconciliation**; detail via `?number=`.

Overview KPIs (IST boundaries, by `paid_at`; money sums in INR only, other currencies listed as "also USD 120.00, GBP 40.00"; a kind switch All / Donations / Seva). Money = what came in and stayed, from the transaction and refund tables: Σ amounts of the payable's SUCCESS attempts (a double payment counts twice until its extra attempt is refunded) − Σ SUCCESS refunds against any of its attempts (`gross_paid − refunded_success` in `payAdminPayablesSql()`), never `amount − amount_refunded`. KPI values are whole rupees (`adminFmtMoney()`, as the dashboard shows money); the tables and the CSV keep the paise:
- Total received (over SUCCESS + PARTIALLY_REFUNDED payables; count), Today, This month, This year;
- Successful payments (count), Failed (count of FAILED payables in range), Pending (INITIATED + PENDING payables; links to the Transactions tab with `status=open`, the filter meaning INITIATED|PENDING), Refunded (count and amount of SUCCESS refunds);
- Domestic (country IN or NULL) vs International (any other country): count and INR amount;
- a 12-month bar chart of received amounts (`adminBars`) and a purpose share list (`adminShares`);
- a "Needs attention" card: needs_review count, stale open attempts, refunds waiting — each linking to Reconciliation.

Transactions table — one row per payable, columns exactly: **Donation ID** (number; links to detail), **Transaction ID** (CCAvenue tracking id of the SUCCESS attempt, else the latest), **Donor**, **Country** (the English country name, `payAdminCountryName()`, with the ISO-2 code in the cell's `title`), **Purpose** (category name, or "Seva: {name}"), **Amount**, **Currency**, **Payment Status** (badge + "Review" badge when needs_review), **Payment Method**, **Date** (created, and paid when different). Filters (GET, whitelisted like donations.php): `q` (number, order id, tracking id, name, phone digits, email — LIKE with escaped wildcards), `country` (select of countries present: ISO-2 codes as values, "Name (CODE)" as labels), `from`/`to` (IST dates on created_at), `status` (a payable status, or `open` = INITIATED|PENDING), `purpose` (category slug, or `seva`), `currency`, `kind`, `review=1`; sort by date/amount/name; 25 per page; CSV export of the filtered set with columns `number, kind, order_id, tracking_id, bank_ref_no, name, phone, email, country, purpose, amount, currency, status, payment_mode, receipt_number, amount_refunded, created_at_ist, paid_at_ist` (country stays the ISO-2 code); every cell starting with `= + - @` or a tab/CR is prefixed with `'`.

Detail view: donor facts (all fields; country as its English name with the code beside it; PAN masked with a "Show" button for editors and owners — a POST that logs `adminAudit('payment_pan_viewed')`, sets a one-shot session flag and redirects to the plain detail URL, whose next render shows the PAN once and clears the flag, so a reload or a shared URL shows the mask again), payable status and receipt number with "Open receipt" (tokenised public link) and "Resend receipt" (`payments.manage`; channels from settings; flash lists queued/skipped channels as donations.php does), attempts table (order id, environment, amount, status, gateway status, tracking id, bank ref, mode, verification, responses, times, needs_review; the receipt attempt is marked "the receipt", any other SUCCESS attempt "extra payment", and each attempt shows what has been refunded against it), **Check with CCAvenue now** (`payments.manage`, calls `payVerifyAttempt` for open/unverified attempts), **Mark reviewed** (note required), refunds table + refund form (§8), and the full audit timeline (newest first, actor, event, detail, IST time). Seva payables link to the booking in `seva_bookings.php`.

All POST actions: `adminCsrfGuard()`, capability check, Post/Redirect/Get (303) with a page flash, `adminAudit('payment_…')`.

### 10.4 `admin/payment_settings.php` — Payment Gateway (owner)

Sections:
1. **Status** — `payReady()` result in words ("Online payments are live in PRODUCTION", "Off", or the reasons they cannot start), current mode badge, the environment's checkout URL, and whether the status API is configured.
2. **Mode** — Enable online payments (switch); mode radios TEST / PRODUCTION (SIMULATOR only listed when `PAYMENTS_ALLOW_SIMULATOR=1`). Switching to PRODUCTION requires production credentials and `PAYMENTS_SECRET`, plus a required tick "The full payment lifecycle has passed testing in TEST mode" (requirement §30) — refused with a message otherwise. The tick is required only for the change to PRODUCTION: a save made while the stored mode is already PRODUCTION keeps PRODUCTION whether or not the box is ticked (the credentials, secret and https checks still apply on every save).
3. **Credentials** — TEST and PRODUCTION blocks: Merchant ID, Access Code, Working Key, and optional API Access Code / API Working Key. Inputs `type="password"` with `data-toggle-password`, `autocomplete="off"`, placeholder "•••• 1A2B (stored)" / "Not set" / "Set in the server environment" (disabled). Blank keeps the stored value; a "Remove" checkbox per field clears it. Without `PAYMENTS_SETTINGS_KEY` the inputs are disabled with the explanation.
4. **CCAvenue dashboard values** — read-only copyable Redirect URL, Cancel URL, Notification (DEN) URL, and the server's outbound IP note ("Ask CCAvenue to whitelist this server's public IP for API access").
5. **Currencies** — checkboxes of the supported list (INR fixed), default currency select, "Accept international payments" switch with the warning "Turn on only after CCAvenue has activated international cards and these currencies for your merchant account."
6. **Amounts** — minimum (INR), maximum (INR), maximum for foreign currencies, preset amounts (CSV input, validated).
7. **Receipts & messages** — receipt prefix; Email / SMS / WhatsApp switches, each with the provider readiness line from the notification service (e.g. "SMS provider: not configured — messages will be skipped").
8. **Seva payments** — "Allow paying for sevas online" switch; hold minutes.
9. **Test connection** — button (POST) that calls `ccavApi('orderStatusTracker', {"order_no":"CONNECTIONTEST"})` for the selected environment and reports: "Connected — CCAvenue answered (no such order)" for 51419/51308/51313; "CCAvenue refused the access code or this server's IP is not whitelisted" for 51407; "The working key does not match" for -1; "Could not reach CCAvenue" for unreachable. Never shows raw responses.

Save validates everything server-side, writes changed keys only, audits `settings_changed` (key names only) and `adminAudit('payment_settings', …)`.

### 10.5 `admin/donation_categories.php` — Donation Categories (editor)

Modelled on `admin/sevas.php`: two-column form + list. Fields: slug (on create only, `^[a-z0-9_]{2,40}$`, unique; read-only afterwards), name Tamil/English (required, ≤120), description Tamil/English (≤500), suggested amount (optional, 1–99,99,99,999.99), sort order, active switch. List with filters (all/active/hidden), search, usage count (online + pledge donations using it). Delete only when unused; otherwise the menu offers "Hide" (deactivate) with an explanation. `adminAudit('donation_category_…')`.

### 10.6 Existing admin pages

- `admin/donations.php` — add a "Source" filter (`source=pledge|online`) and a "Payment" column (Pledge badge, or Online + status badge); KPIs and the purpose shares count pledges plus online `SUCCESS|PARTIALLY_REFUNDED` rows only (net of `amount_refunded`); purpose labels come from `donation_categories` with the old map as fallback; online rows get "Open payment" (→ payments.php detail) instead of "Send receipt"; the CSV appends `source, status, donation_number, currency, category` after the existing columns (existing column order unchanged). Everything else (filters, actions, flash texts, tests) unchanged. Guard every new column use with `publicGuardHasColumn()`.
- `admin/seva_bookings.php` — default list and status chips exclude `payment_mode='online' AND COALESCE(payment_status,'') NOT IN ('SUCCESS','REFUND_INITIATED','PARTIALLY_REFUNDED','REFUNDED')`; a new chip "Unpaid online" shows exactly those; paid online rows show a "Paid online ₹251 · TMR-2026-000042" badge linking to the payment detail; CSV appends `payment_mode, amount, payment_status, order_number, receipt_number, paid_at`. Existing actions unchanged. Guarded by column checks.
- `admin/index.php` — donation totals, chart, purpose shares and the activity feed exclude online donations that are not `SUCCESS|PARTIALLY_REFUNDED` (and use the net amount); add an "Online payments this month" KPI guarded by `payTablesExist()` in the existing try/catch style.
- `admin/bulk_upload.php` — donations import unchanged (rows are pledges by default); seva CSV import validates `amount` ≥ 0 and ≤ 99,999,999.99 (fixes the negative-amount hole).

## 11. Configuration files and docs

- `backend/.env.example` — a "Online payments (CCAvenue)" block documenting every variable in §4.1 with placeholder values and one-line explanations (how to generate `PAYMENTS_SETTINGS_KEY`: `php -r "echo base64_encode(random_bytes(32));"`), plus the notification worker/cron variables the payments flow depends on (`NOTIFY_CRON_KEY`, `PAYMENTS_CRON_KEY`). Replace the stale "Devotee accounts" comment while there.
- `README.md` — migration 010 in the migration table; a "Payments" section: enabling TEST mode, the three URLs to register in the CCAvenue dashboard, IP whitelisting for the API, the cron lines (payments every 10 minutes, notifications every minute), the simulator for local development (`PAYMENTS_ALLOW_SIMULATOR=1`), and the go-live checklist link (§14).
- `tests/README.md` — the new suites, their ports and how to run them.
- `frontend/vite.config.js` — besides §7.8, the dev proxy target becomes `process.env.VITE_PROXY_TARGET || "http://localhost:8000"` so a test Vite can point at a test PHP server.
- **Test-only settings overlay:** `PAYMENTS_SETTINGS_OVERLAY` (JSON object of non-secret setting keys, e.g. `{"enabled":"1","mode":"simulator","seva_online_enabled":"1"}`) overlays `payment_settings` for that PHP process **only when `PAYMENTS_ALLOW_SIMULATOR=1`**, so API/UI suites never mutate the shared settings rows. Secret keys in the overlay are ignored.

## 12. Tests

Conventions: PHP test servers on ports **8060–8069**, Node mocks **8070–8079**, test Vite on **5190** (`VITE_PROXY_TARGET=http://127.0.0.1:8063 npx vite --port 5190 --strictPort`; port map: 8061 payments-api, 8062 admin-payments, 8063 payments-ui, mocks 8071/8072/8073 respectively); X-Forwarded-For block `10.83.0.<n>`; names `E2E-PAY-<run>`, emails `e2e-pay-<run>-…@example.test`; clean up at start and in `finally` by name prefix (never by number/order-id prefix), including `payment_audit_log`, `payment_refunds`, `payment_transactions`, notifications about those entities, `admin_activity` rows and own `rate_limits` buckets; output style A (`✓`/`✗`, `N passed, M failed`, exit code); preflight `/api/pulse` and a port-in-use check (exit 2). The user's own dev servers (PHP :8000, Vite :5173/:5174) must not be stopped, restarted or reconfigured, and shared `payment_settings` rows must not be changed except by `admin-payments.mjs`, which snapshots and restores them. Never report a check as passed without running it.

Support:
- `tests/support/payments_fixtures.php` (CLI only, one JSON line): `encrypt`/`decrypt` (real `ccavEncrypt`/`ccavDecrypt`), `create-donation` / `create-seva-payable` (through `payCreate*`, with backdating), `apply` (drive `payStateApply` for unit-style setups), `token` (access/verify tokens), `sweep` (`payReconcileSweep` with order ids), `sql`, `cleanup {name_prefix}`.
- `tests/support/ccavenue_crypto.mjs` — independent Node AES-128-CBC/MD5/fixed-IV implementation; cross-checked with the PHP fixture both ways on a pinned vector.
- `tests/support/ccavenue_mock.mjs` — `startCcavenueMock({port, workingKey, accessCode})`: `POST /transaction/transaction.do` (decrypts, records, renders Success/Failure/Abort/Awaited/Tamper-amount/Wrong-currency buttons posting `encResp` back) and `POST /apis/servlet/DoWebTrans` (orderStatusTracker/refundOrder with scenarios by order suffix or amount: success, awaited, aborted, failure, refunded, refund refused, `status=1` error, 51407, 5xx, 429, garbage `enc_response`); `requests[]` for assertions; a closed port (8079) for network failure. The PHP server under test gets `CCAVENUE_TRANSACTION_URL`/`CCAVENUE_API_URL` pointing at it with mode `test` and TEST credentials from env.

Suites (all new):
1. `tests/payments-unit.php` — crypto vector and round trip, bad hex/wrong key/truncation → null; amount parsing matrix (`1`, `1.5`, `1.50`, `0`, `-1`, `1e3`, `1,000`, `１２`, 11 digits, arrays); min/max/foreign/JPY; number/order-id format and parsing; receipt counter sequence without gaps under two concurrent PHP processes; access/verify tokens (valid, tampered, other number); secretbox round trip, missing/short key, tampered ciphertext → absent; response parsing (duplicate keys, `=` inside values, percent-encoding rule); status mapping tables §2.3; transition table §2.4 including FAILED→SUCCESS only via status_api, double payment, retry limits; refund arithmetic; `payRedact`; `payMoneyLabel`; validation contracts §5.2 incl. hostile types; `ccavClean` (strips `& = ' " < >`, emoji, control chars; lengths).
2. `tests/payments-api.mjs` — against a PHP server it starts on 8061 with the mock on 8071: config shape and secrecy (no merchant id/keys anywhere in any JSON); create donation matrix (422 fields), honeypot, 405, flood limits (`payment-attempt`, `payment-created`), no cookies, 503 when not ready; INITIATED rows + audit before redirect; encRequest decrypts to the §4.3 fields/order with server-side amount (tampering the posted amount/currency/category is impossible — the payload has only validated values); callback success → SUCCESS, receipt number, one `donation.paid` notification, status API confirmation recorded; replay → idempotent (`response_count` 2, one notification, one receipt); failure → FAILED + email-only failure message when email given; abort/cancel_url → CANCELLED, no message; awaited → PENDING then sweep → SUCCESS; amount/currency/merchant_param mismatch → never SUCCESS, needs_review, audit; unknown order / undecryptable / oversize / GET → correct redirects, never 500; status API unreachable during callback → SUCCESS with `verification=callback`, later sweep upgrades to `status_api`; retry rules (409 for SUCCESS, new `-R2` order id, max 5); status/receipt endpoints require the token (other number's token → 404); receipt-email saves a missing email and queues email only, rate limited; verify endpoint valid/invalid/masked/anonymous; seva payable: price from DB (tampered `amount` ignored), inactive/zero-price seva refused, hold expiry sweep cancels booking, late success restores `pending`; `/api/donors` excludes non-SUCCESS online donations; existing `/api/donations` and `/api/seva-bookings` contracts unchanged; the working key and access code never appear in HTML, JSON, `payment_transactions`, `payment_audit_log`, `notifications` or `backend/logs/*`.
3. `tests/admin-payments.mjs` — HTTP + Playwright against a PHP server on 8062: roles (viewer read/export, POST 403 everywhere and nothing changed; editor manage but refund/settings 403; owner all); CSRF missing/forged changes nothing; transactions filters/sort/pagination/CSV (formula neutralisation); KPIs computed independently in SQL for a fixed backdated fixture set (IST boundaries: a payment at 23:50 IST on the last day of a month counts in that month); detail view shows attempts/refunds/audit; Check now; Mark reviewed; refunds (full via mock API, two partials, over-refund refused, refused by gateway, unreachable then Check again, manual method) — payment rows unchanged before/after; settings page (masked, blank keeps, remove clears, env-provided read-only, DB value is ciphertext, production refused without credentials/tick, test connection messages via mock scenarios, audit has key names only) with snapshot/restore of `payment_settings`; donation categories CRUD, slug immutable, delete refused when used; donations.php and seva_bookings.php additions and unchanged existing behaviour; reconciliation sections and CSV upload (alias headers, missing columns error, mismatches); no horizontal overflow and axe clean at 390 and 1440 on the three new pages.
4. `tests/payments-ui.mjs` — Playwright through the test Vite (5190 → PHP 8063, started by the suite, with the simulator overlay and `SITE_URL=http://localhost:5190`): `/donate` at 390/768/1024/1440 (one h1, overflow, console, axe); disabled state; category cards + suggested amount; presets and Other amount; currency select only with international; per-step validation, error summary focus, Back/Next, browser back, draft restore without PAN; review shows amount+currency; double-click Proceed sends one POST; "Redirecting securely to CCAvenue…" visible; simulator page → Pay → success page fields → receipt page (print stylesheet hides chrome: check computed `display` under `page.emulateMedia({media:'print'})`), QR present, verify page; Decline → failed page → Try again → new order id `-R2` → success; Cancel → cancelled page → Return to donation page keeps the draft; Awaited → pending page polls to success after the suite runs the sweep; bfcache back from the gateway resets the button; Tamil mode strings; Sevas dialog online path (one submit button, price from server) and request path unchanged; policy pages (one h1, TOC, footer links); `/donations` Donate online card only when enabled.

Existing suites to extend (only the lists named here; do not rewrite them): `admin-smoke.mjs` PAGES (+3 pages), `admin-roles.mjs` (payments pages per role), `admin-hostile-input.mjs` (payments write actions and settings), `public-hardening.mjs` forms table (`/api/payments/donations` with its buckets, only when run against a server with the overlay), `og.mjs` ROUTES (+`/donate` and 4 policies), `public-e2e.mjs` ROUTES (+ the same), `search-api.mjs` (a term that finds `/donate`). `tests/notify-unit.php` catalogue count 15 → 17. The already-stale suites listed in `map-tests.md` §4 stay out of scope.

Always also run: `cd frontend && npm run audit` (0 findings), `php -l` on every new/changed PHP file, and `node tests/registration-api.mjs` + `tests/public-hardening.mjs` + `tests/admin-smoke.mjs` against a test server to prove nothing regressed.

## 13. Build plan and ownership

Phases (each builder owns only its files; anything outside needs a note in its report, not an edit):

| Phase | Workstream | Owns |
|---|---|---|
| 1 | **Core** | `database/migrations/010_payments.sql`, `backend/includes/payments.php`, `backend/includes/payments/*`, `backend/api/payments.php`, `backend/api/payments_cron.php`, `backend/bin/payments_cron.php`, routing block in `backend/api/index.php`, new buckets in `backend/includes/public_guard.php`, `backend/api/donors.php` filter, `backend/.env.example` block. Applies migration 010 to the local Docker DB (`--default-character-set=utf8mb4`). |
| 1 | **Messages** | `backend/includes/notify/events.php`, `defaults.php`, `templates.php` (§6), `tests/notify-unit.php` count and new-template checks. |
| 1 | **Policies** | `frontend/src/pages/Policy.jsx`, `Policy.css`, `frontend/src/data/policies.js`, `PageCommon.css` list rules, `Footer.jsx`/`Footer.css` legal links, `TEMPLE_EMAIL` in `temple.js` (+ Footer uses it), App.jsx policy routes, `site_pages.php` + `search.php` entries for the 4 policies **and** `/donate`, `og.mjs`/`public-e2e.mjs`/`search-api.mjs` route lists. |
| 1 | **Test harness** | `tests/support/payments_fixtures.php`, `ccavenue_crypto.mjs`, `ccavenue_mock.mjs`, `tests/payments-unit.php` (written against this SPEC; run once Core lands). |
| 2 | **Admin** | `backend/admin/payments.php`, `payment_settings.php`, `donation_categories.php`, `auth.php` capabilities, `admin_layout.php` nav, `admin.css` additions (section "Payments"), `admin/donations.php`, `admin/seva_bookings.php`, `admin/index.php`, `admin/bulk_upload.php` seva amount check, `tests/admin-payments.mjs`, `admin-smoke.mjs`/`admin-roles.mjs`/`admin-hostile-input.mjs` list additions. |
| 2 | **Donate UI** | `frontend/src/lib/payments.js`, `money.js`, `donation.js`, `components/ui/FormStepper.jsx`, `FormErrorSummary.jsx` (+ `.form-stepper*` CSS in components.css), `components/Payments/*`, `pages/Donate.jsx/.css`, `PaymentResult.jsx/.css`, `PaymentReceipt.jsx/.css`, `ReceiptVerify.jsx`, App.jsx payment routes, `vite.config.js`, `Donations.jsx` card + fixes, `Home.jsx` tile, `Sevas.jsx` dialog, `backend/api/chat.php` facts, `tests/payments-ui.mjs`. |
| 2 | **API tests** | `tests/payments-api.mjs`, `public-hardening.mjs` addition. |
| 3 | **Integration** | Runs every suite in §12 in order, fixes defects in the owning files, reports exact pass/fail counts. |
| 4 | **Review** | Independent adversarial review (security of the gateway flow and secrets, money correctness and idempotency, admin permissions, frontend UX/accessibility against the requirement) → verified findings → fixes → re-run of affected suites. |
| 5 | **Docs** | `README.md`, `tests/README.md`, final `.env.example` check. |

`App.jsx` is shared by Policies (phase 1) and Donate UI (phase 2): phase 2 adds its routes after phase 1 has finished.

## 14. Go-live checklist (for the committee — not code)

Must be confirmed against the merchant's own CCAvenue kit, account and API guide before PRODUCTION (research §"Must confirm"):
1. The kit still uses AES-128-CBC, MD5 key, IV 0x00–0x0f, hex output.
2. TEST credentials were issued; which domains/URLs are registered for TEST and PRODUCTION (the site's HTTPS domain; the three URLs from Admin → Payment Gateway).
3. Whether the API uses the checkout access code/working key or a separate pair; the server's public IP is whitelisted for the API in both environments.
4. API host and `version` (1.2), and the JSON response shape (flat or wrapped).
5. `refundOrder` behaviour, refund window and error codes; whether `getRefundDetails` should be added.
6. Whether `encResp` arrives at `cancel_url` on abort; whether response values are URL-encoded (log one raw TEST response length/keys — never the values — to check).
7. Dynamic Event Notification configured to `/api/payments/ccavenue/notify`.
8. Enabled currencies, settlement currency, international card activation; zero-decimal (JPY) handling — keep JPY unticked until confirmed.
9. Whether orders auto-confirm or need `confirmOrder` (12-day auto-cancel).
10. Whether CCAvenue accepts Tamil characters in `billing_name`/`billing_address`.
11. The column headers of the CCAvenue dashboard order export used for reconciliation.
12. The Trust's auditor approves the receipt wording, the 80G line and whether PAN must be printed in full on 80G receipts (the receipt currently masks it).
13. The committee approves the four policy pages' text (refund window 7 days, seva cancellation 48 hours, jurisdiction Tenkasi) — they are drafts written from the site's facts.
14. `PAYMENTS_SECRET`, `PAYMENTS_SETTINGS_KEY`, `PAYMENTS_CRON_KEY`, `NOTIFY_CRON_KEY` set in Hostinger; both cron jobs running; SMS DLT template ids and WhatsApp approved templates entered for the payment templates; `MAIL_TRANSPORT=smtp` working.
15. The whole lifecycle in requirement §30 passes in TEST mode with real CCAvenue test instruments (UPI, debit, credit, net banking, international card, foreign currency if used, success, failure, cancel, refresh, back, double click, duplicate callback, invalid callback, wrong amount, session expiry, network interruption, receipt, email, SMS, refund, partial refund, reports, reconciliation) — only then tick the production box.
