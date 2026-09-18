# Test suites

Plain Node scripts — no test framework, no build step. They drive the **real**
stack (PHP + MySQL + the Vite dev server), so a green run means the feature
actually works, not that a mock agreed with itself.

## Prerequisites

```bash
# 1. MySQL with the schema + migrations
docker run -d --name temple-mysql -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=templemahendra -e MYSQL_USER=temple -e MYSQL_PASSWORD=templepass \
  -p 3307:3306 mysql:8 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
docker exec -i temple-mysql mysql -uroot -prootpass < database/schema.sql
for f in database/migrations/*.sql; do docker exec -i temple-mysql mysql -uroot -prootpass templemahendra < "$f"; done

# 2. Backend on :8000 (see .env.local, or export the DB_* / ADMIN_* vars)
cd backend && php -S 127.0.0.1:8000 router.php

# 3. Frontend on :5173 (proxies /api to :8000)
cd frontend && npm run dev

# 4. Browser driver, for the public suite only
npm i playwright axe-core && npx playwright install chromium
```

The admin suites sign in as `admin` / `Admin@Test123`; set `ADMIN_USERNAME`
and `ADMIN_PASS_HASH` to match, or edit the credentials at the top of each file.

## The suites

| Script | What it proves |
| ------ | -------------- |
| `admin-smoke.mjs` | All 16 admin pages return 200 with no PHP notice, warning or fatal |
| `admin-roles.mjs` | Sign-in, forced password change, per-role page **and** POST permissions, weak-password rejection, open-redirect protection, audit log — 25 cases |
| `admin-hostile-input.mjs` | Every write handler survives over-length strings, out-of-range numbers, impossible dates and script payloads without a 500 or a leaked stack trace; search terms are escaped |
| `admin-bulk-import.mjs` | CSV **and** a hand-built `.xlsx` go through upload → column mapping → validation preview → chunked import → results, with rows actually landing in the database |
| `public-e2e.mjs` | Every public route at 390/768/1024/1440: one `h1`, no horizontal overflow, no console errors, and zero serious/critical axe violations. Plus language toggle, mobile drawer focus handling, the seva booking modal (focus trap → validation → real API submit), contact and donation forms, events filtering, panchangam navigation, the chatbot, and the header fit guard (the navbar row must sit inside its own container at 30 widths from 320 to 2560, with Login and Sign Up reachable) — 140 assertions |
| `screenshot.mjs` | Utility: `node screenshot.mjs <url> <out.png> [w] [h] [--login] [--full]` |

```bash
node tests/admin-smoke.mjs http://127.0.0.1:8000
node tests/admin-roles.mjs
node tests/admin-hostile-input.mjs
node tests/admin-bulk-import.mjs
node tests/public-e2e.mjs   http://localhost:5173
```

**Clear `rate_limits` before each run of the two account suites.** Sign-up is
capped at five completed registrations per hour per IP address and sign-in at
twenty attempts per fifteen minutes, which is correct in production and will
stop a repeated test run part-way through:

```sql
DELETE FROM rate_limits;
```

On Windows, use `http://localhost:5173` rather than `127.0.0.1`: Vite binds to
the IPv6 loopback, and `127.0.0.1` will not connect.

Each script prints `N passed, M failed` and exits non-zero on failure. They
create clearly-prefixed rows (`E2E-`, `e2e_`, `BULKTEST`, `DUPTEST`) and print a
cleanup line; run it against a **disposable** database, never production:

```sql
DELETE FROM admin_users     WHERE username LIKE 'e2e_%';
DELETE FROM sponsors        WHERE name LIKE 'BULKTEST%' OR name LIKE 'DUPTEST%';
DELETE FROM seva_bookings   WHERE devotee_name LIKE 'E2E%';
DELETE FROM contact_messages WHERE name LIKE 'E2E-%';
DELETE FROM donations       WHERE name LIKE 'E2E%';
DELETE FROM devotees        WHERE email LIKE 'e2e-%';
DELETE FROM rate_limits;
```

## Online payments (CCAvenue)

Four suites cover `docs/payments/SPEC.md` §12. They need no running server of
your own: each starts its own PHP (ports **8060–8069**), CCAvenue stand-in
(**8070–8079**) and, for the browser suite, a throwaway Vite on **5190** — and
stops them at the end, whatever happens. Ports in use → exit 2. `PHP_BIN` is a
PHP 8 binary or a `.sh` wrapper that exports the `DB_*` variables; the browser
suite also needs Playwright from the prerequisites above.

| Script | Ports | What it proves |
| ------ | ----- | -------------- |
| `payments-unit.php` | — (CLI, database only) | The module's rules against the real code and database: CCAvenue's crypto on a pinned vector, the amount grammar, numbers and tokens, a gap-free receipt sequence while two PHP processes race for the counter, response parsing and both status-mapping tables, the transition table, refund arithmetic, redaction, validation with hostile input — 310 checks |
| `payments-api.mjs` | PHP 8061, mock 8071 | The public API in TEST mode against a stand-in gateway: config secrecy, the 422 matrix, honeypot and flood limits, the encrypted order's exact fields, success / replay / failure / cancel / awaited callbacks, tampered responses never becoming SUCCESS, the status API unreachable, retries, tokenised status and receipt pages, seva price from the database, hold expiry, and that no key ever appears in JSON, HTML, tables or logs — 267 checks |
| `admin-payments.mjs` | PHP 8062, mock 8072 | Admin → Online Payments, Payment Gateway and Donation Categories: roles and CSRF, filters and CSV, KPIs recomputed in SQL across an IST month boundary, the detail view, refunds (full, partial, refused, unreachable, manual), the settings page with snapshot/restore of `payment_settings`, reconciliation and the CSV upload, axe at 390/1440 — 216 checks |
| `payments-ui.mjs` | PHP 8063 (simulator), Vite 5190 | The donor's side in a real browser: `/donate` at four widths, the three steps and their validation, the redirect to the simulator, success / declined / cancelled / pending results, the receipt on screen and under print media, QR verification, the seva dialog's pay-now and request paths, the policy pages — 258 checks |

```bash
PHP_BIN=/path/to/php.sh
$PHP_BIN tests/payments-unit.php
PHP_BIN=$PHP_BIN node tests/payments-api.mjs
PHP_BIN=$PHP_BIN node tests/admin-payments.mjs
PHP_BIN=$PHP_BIN node tests/payments-ui.mjs
node tests/support/ccavenue_crypto.mjs      # the Node copy of CCAvenue's crypto checks itself
```

**Run them one at a time.** The receipt counter (`payment_counters`) is one row
shared by every process on the database; two suites running together reset it
under each other and fail with duplicate receipt numbers. Each suite removes its
own rows (`E2E-PAY-…` names) and puts the counter back.

Support files: `support/payments_fixtures.php` (CLI fixture: encrypt, decrypt,
create payables, drive state changes, sweep, cleanup), `support/ccavenue_crypto.mjs`
and `support/ccavenue_mock.mjs` (the stand-in checkout page and status/refund API).

`public-hardening.mjs` adds a flood-limit row for `/api/payments/donations` only
when the server it is given has payments enabled (start it with
`PAYMENTS_ALLOW_SIMULATOR=1`, a settings overlay and fake TEST credentials);
`admin-smoke.mjs`, `admin-roles.mjs`, `admin-hostile-input.mjs`, `og.mjs`,
`public-e2e.mjs` and `search-api.mjs` include the payment pages and routes.

## Live Darshan (YouTube Live)

Four suites cover `docs/live/SPEC-PHASE1.md` §6 and `docs/live/SPEC-PHASE2.md`
§3. Like the payments suites they start and stop their own servers — PHP on
ports **8081–8083**, the YouTube stand-in on **8091** (built for phase 3 and
only smoke-started here) and, for the browser suite, a throwaway Vite on
**5195** whose `/api` proxy points at the suite's PHP. Ports in use → exit 2.
Migration `011_live_streams.sql` must be applied (each suite checks and says
so; phase 2 needs no migration). YouTube's hosts are answered by a stub inside
the browser, so nothing leaves the machine and no real video plays.

| Script | Ports | What it proves |
| ------ | ----- | -------------- |
| `live-unit.php` | — (CLI, database only) | The module's rules against the real code and database: every accepted and refused form of a YouTube reference, the embed/watch/thumbnail builders, slugs (uniqueness across deleted rows, `-2` suffixes, digits-only titles, the lock after publishing), UTC round trips and DST, the whole `liveValidate` matrix with hostile input, the store (lists, ordering, the 3-hour grace for a late broadcast, soft delete and restore), every legal and illegal transition, readiness for Publish / Go live, uploads with a real PNG, a text file and an oversize blob; phase 2: the day / week / festival windows in Asia/Kolkata (23:59 IST inside, the next midnight outside, the week ending Sunday, month and year rollovers), `day_bucket` and `starts_in_seconds`, the schedule list's membership (cancelled rows out, ended ones in), order (live first, undated last, ended last within a day) and counts, the reserved slug `schedule`, and the Vimeo / AWS IVS placeholders — 720 checks |
| `live-api.mjs` | PHP 8081, mock 8091 | The public routes (index, live, upcoming, by id and by slug: shapes, ordering, caching headers, 404s, 405s, escaping, no cookies) and the admin JSON API (401/403 as JSON, the CSRF token, create / edit / transition / delete, 422 for hostile fields and unready drafts, 409 for illegal jumps, the locked slug, viewer and editor roles, audit rows), plus that `/api/events`, `/api/homepage_widgets` and `/api/search` still answer; phase 2: `/api/live-streams/schedule` with rows across today / tomorrow / this week / next week / past / festival / live / ended-today / cancelled / draft / deleted — every filter's membership and order, the counts, the ISO window, the limit cap, `filter=bogus`, the 30-second cache header, the item shape, `now` / `next` on the index, and that the browser's copies of the event-type and filter labels (`frontend/src/lib/live.js`) still mirror `backend/includes/live/config.php` word for word — 365 checks |
| `admin-live.mjs` | PHP 8082 | Admin → Live Streaming over HTTP and in a browser: create with an exact Tamil round-trip, the edit view, an update that changes only what was edited, the validation matrix, the status buttons (a bare draft cannot be published; Go live re-checks the row), delete and restore, thumbnail uploads, filters / search / sort / pagination, hostile query strings, viewer and editor roles, forged CSRF, overflow and axe at 390 and 1440 — 235 checks |
| `live-ui.mjs` | PHP 8083, Vite 5195 | The devotee's side in a real browser: `/live-darshan` at four widths, the broadcast's facts, the `youtube-nocookie.com` iframe and its attributes in Tamil then English, the 16:9 box, slug routes (not found, draft, offline, completed, error), the header / drawer / footer / Home entry points, the header fit at 36 widths in both languages, polling (a STARTING broadcast goes LIVE under the visitor and is announced; nothing polls after leaving the page), the scheduled poster, a broadcast running late ("Starting shortly"), the empty state; phase 2: `/live-darshan/schedule` at four widths (axe with iframes off), the five filters with their counts, switching that updates the address and the list, `?filter=` on a direct load, the day groups, the compact countdown on a card, the per-filter empty state and its switch button, Tamil; the countdown on `/live-darshan` (HH:MM:SS from a fixture starting in 90 s, two samples 5 s apart, the sr-only sentence, "Starting shortly" at T+0) and a `server_time` skewed by ±10 minutes shifting it; the homepage's LIVE NOW, next-darshan and nothing states with the hero row; and the review fixes — the filter strip at 390 in both languages (every chip inside the viewport, 44 px, the selected one in view), the days unit on a countdown eight days out and its absence under a day, the 44 px targets of the homepage's live section, the poster, the hero and the homepage's hero row flipping to "Starting shortly" at T+0, the Tamil weekday-first day label, a filter switch that keeps its list while a delayed answer is awaited, a broadcast going live under the schedule page without a reload, the Today / Tomorrow empty state's way out on a Sunday and on a Monday, and the shared address carrying `?filter=` — 356 checks |

```bash
PHP_BIN=/path/to/php.sh
$PHP_BIN tests/live-unit.php
PHP_BIN=$PHP_BIN node tests/live-api.mjs
PHP_BIN=$PHP_BIN node tests/admin-live.mjs
LIVE_SHOTS=/tmp/live-shots PHP_BIN=$PHP_BIN node tests/live-ui.mjs   # screenshots land in LIVE_SHOTS (default shots/live)
```

Run `admin-live.mjs` and `live-ui.mjs` one at a time: both read the public
lists, and a LIVE row one suite creates would be the broadcast the other
expects to see first. Each suite removes its own rows (`E2E-LIVE-…` titles,
their audit rows, uploaded `/uploads/live-*` files and rate-limit buckets) at
the start and at the end. `LIVE_ONLY=widths,facts` runs a subset of the
browser suite's scenarios while a failure is chased.

Support files: `support/live_fixtures.php` (CLI fixture: create a stream in any
status through the module's own write path — `starts_in_seconds` places its
start that many seconds from now, to the second, for the countdown checks —
change its status, run SQL, clean up) and `support/youtube_mock.mjs` (the
oEmbed / Data API stand-in for phase 3).

`admin-smoke.mjs`, `admin-roles.mjs`, `admin-hostile-input.mjs`, `og.mjs`,
`public-e2e.mjs` and `search-api.mjs` include the Live Streaming page, the
`/live-darshan` route and `/live-darshan/schedule`. Run `og.mjs` before
creating any live fixture: its `/live-darshan` comparison holds only while no
broadcast is live or upcoming (the schedule page's strings are static).

## Design-system check

Not in this folder because it needs no running server:

```bash
cd frontend && npm run audit
```

Reports undefined CSS custom properties, class names with no rule, opaque raw
colours outside `tokens.css`, and inline styles that are not dynamic values.
