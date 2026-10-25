# Test suites

Plain Node scripts — no test framework, no build step. They drive the **real**
stack (PHP + MySQL + the Vite dev server), so a green run means the feature
actually works, not that a mock agreed with itself.

## Prerequisites

The free offline astronomical calendar also has a database-independent test:
`php tests/panchangam-calculated.php`. See [calculation methods and limits](../docs/PANCHANGAM.md).

```bash
# 1. MySQL with the schema + migrations
docker run -d --name temple-mysql -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=templemahendra -e MYSQL_USER=temple -e MYSQL_PASSWORD=templepass \
  -p 3307:3306 mysql:8 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
docker exec -i temple-mysql mysql -uroot -prootpass < database/schema.sql
for f in database/migrations/*.sql; do docker exec -i temple-mysql mysql -uroot -prootpass templemahendra < "$f"; done

# 2. Backend on :8000 (see .env.local, or export the DB_* / ADMIN_* vars)
cd backend && php -S 127.0.0.1:8000 router.php

# 3. Frontend on :5173 (proxies /api to :8000) — bind the IPv4 loopback for the suites
cd frontend && npm run dev -- --host 127.0.0.1

# 4. Browser driver, for the public suite only
npm i playwright axe-core && npx playwright install chromium
```

Start Vite with `--host 127.0.0.1`: on Node 24 Vite's default `--host
localhost` binds `::1` only, while every browser suite dials `127.0.0.1` and
fails with `ERR_CONNECTION_REFUSED` (D-033). On Node 22/24 also keep the
harness preload in `NODE_OPTIONS` (`--import` of
`tests/support/buffered_fetch.mjs`, D-025), which reads every fetch body
before returning it.

The admin suites sign in as `admin` / `Admin@Test123`; set `ADMIN_USERNAME`
and `ADMIN_PASS_HASH` to match, or edit the credentials at the top of each file.

## Website enhancement regression

`node tests/website-enhancements.mjs` requires the frontend on localhost:5173,
PHP on 127.0.0.1:8000 and a disposable MySQL schema migrated through 023.
Export `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASS` for that same schema.
Set `ADMIN_USERNAME` and `TEST_ADMIN_PASSWORD` to match the PHP server's
`ADMIN_USERNAME` / `ADMIN_PASS_HASH`; suite defaults are the local-only
`enhancement-qa` / `Enhancement@Test123`. `TEST_API` and `TEST_WEB` override URLs.
Playwright and axe-core are resolved from the existing frontend dependencies.

All seva bookings require participant names, Rasi and Nakshatram, for both office
requests and online payments. Run `php tests/booking-details.php` to check these
shared validation rules for every service kind.

This suite verifies prices, multi-person Archana/delivery persistence, family
dates/astrology, Matrimony privacy/key management/moderation, admin-verified
Panchangam, dispatch, CSVs and public forms. It checks mobile/tablet/desktop
layout, Chromium accessibility and WebKit iPhone viewports. If WebKit is not
installed it reports an explicit skip. Neither emulation nor local gateway
mocks constitute physical Android/iOS or real settlement testing.

`node tests/payments-api.mjs` also exercises Archana with Prasadam through the
local CCAvenue mock, asserting server-authoritative service/delivery totals,
participant storage, successful payment and private receipt breakdown.

## Live recordings archive (Phase 8)

After the MySQL 8 schema and sorted migrations are installed:

```bash
DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=templemahendra DB_USER=root DB_PASS=root node tests/live-archive.mjs
```

The suite starts PHP on 8089 (`LIVE_ARCHIVE_PORT` overrides it), creates uniquely
prefixed streams and removes only those rows in `finally`. It covers the public
archive, pagination, month boundaries, safe recording edits/playback, manual
completion and the poller's completion transaction with synthetic provider facts.
It does not call YouTube. `live-sync.mjs` separately exercises the HTTP stand-in.

## The suites

| Script | What it proves |
| ------ | -------------- |
| `admin-smoke.mjs` | Every admin page — 48 addresses covering each list, filter, edit and unknown-id view, including the migration-025 Pages, SEO, Nalla Neram, Roles and Languages pages — returns 200 with no PHP notice, warning or fatal |
| `admin-roles.mjs` | Sign-in, forced password change, per-role page **and** POST permissions, weak-password rejection, open-redirect protection, audit log — 25 cases |
| `admin-hostile-input.mjs` | Every write handler survives over-length strings, out-of-range numbers, impossible dates and script payloads without a 500 or a leaked stack trace; search terms are escaped |
| `admin-bulk-import.mjs` | Bulk upload (brief §15): CSV **and** a hand-built `.xlsx` go through upload → column mapping → validation preview → chunked import for every entity, with the migration 020/024 columns (event type, times, venue, picture, featured; seva description, timing, `is_bookable`; pooja times, sponsorship, banner, featured, live stream), the old single `description` filling both languages, impossible dates and out-of-range numbers refused with a reason, Tamil intact, duplicates skipped on request, the `bulk_import` audit row. Starts its own PHP server; rows `E2E-BULK-<run>` — 103 checks |
| `public-e2e.mjs` | Every public route at the brief's six widths (360, 390, 768, 1024, 1366, 1920): one `h1`, no horizontal overflow, no console errors, axe serious/critical at 360 and 1366; language switching, the mobile drawer and keyboard, the header's entry points, the seva booking dialog, contact and donation forms, events, panchangam, chatbot, 404, sharing, admin routing and the launch fixes. `BROWSER=chromium` (default), `firefox`, `webkit` or `msedge`; `MOBILE=1` runs the routes and the core scenarios as a Pixel 5 and an iPhone 13 (device descriptors, taps). Needs PHP on :8000 and the site on :5173 (`vite preview` of a build, or the dev server, started with `--host 127.0.0.1`); third-party hosts are stubbed. Resets its own flood-limit buckets; contexts that stub API answers block the service worker (WebKit would bypass the stubs, D-051); deletes the booking, message and donation it really submits — 639 checks in Chromium and Firefox |
| `brief-e2e.mjs` | The brief's §30 cases no other suite states in its own words (`docs/TESTING.md`): next-pooja auto-selection with an expired Pournami excluded, admin create / edit / hide of a pooja, an event and an announcement reaching their public feeds, gallery upload (random stored name, disguised PHP and GIF refused, served as an image, `/uploads` never executes PHP), 401 and the sign-in redirect without a session, SQL payloads stored as text with the table intact, script payloads inert in the admin inbox, list and edit form, forged and missing CSRF tokens writing nothing; since migration 024 the homepage engine's rules (a manual card linked to a past pooja never publishes it, a second stale calendar card is re-pointed as well) and the contact form's email, subject and office alert (E2E-038…040). Starts its own PHP server (`TRUSTED_PROXIES=127.0.0.1`); rows prefixed `E2E-BRIEF-<run>` — 79 checks |
| `deities.mjs` | Deities (brief §6): `/api/deities` lists only shown deities of the active temple in display order with Tamil intact and a 5-minute public cache; the admin page redirects without a session, opens for owner and editor, answers 403 to finance and viewer (page and POST), refuses forged and missing CSRF tokens, validates names / order / stored image address, creates with Tamil and English names and descriptions, derives a unique slug from the English name (`-2`, `-3` …) that never changes on edit, hides / shows, orders, keeps the image on a text-only edit, stores uploads under a random 24-hex name (disguised PHP and GIF refused, served back as an image), strips tags from hostile input and escapes the rest in the table and the JSON, refuses to delete a deity a live stream is dedicated to (hide instead) while deleting an unlinked one, and writes `deity_created` / `deity_updated` / `deity_toggled` / `deity_deleted` audit rows. Starts its own PHP server; rows prefixed `E2E-DEITY-<run>` — 67 checks |
| `videos.mjs` | Videos (brief §6): migration 017 shape (utf8mb4 InnoDB, unique `youtube_id`, FKs to `video_categories` and `live_streams`); `/api/videos` lists only shown videos of shown categories with Tamil intact, the featured video, category counts, filter and pagination, public fields only, a clean 422 for junk parameters; the admin page redirects without a session, opens for owner and editor, answers 403 to finance and viewer (page, video and category POSTs), refuses forged and missing CSRF tokens, accepts bare ids and watch / youtu.be / shorts / live / embed URLs while refusing other hosts, `javascript:`, short ids and markup, refuses a duplicate id (naming the existing row) on create and edit, validates titles / date / order / category / stream, creates with Tamil titles and descriptions, edits, features, hides / shows, deletes and relists a freed id; categories create (unique slug) / edit / hide (hides their videos publicly) / delete (refused while videos remain); a blank link inherits a completed stream's recording id and deleting the stream clears the link; hostile input is stored as text and escaped everywhere; the videos search group and sitemap entry; `video_*` / `video_category_*` audit rows. Starts its own PHP server; rows prefixed `E2E-VIDEO-<run>` — 118 checks |
| `calendar-entries.mjs` | Temple Calendar entries (brief §6, gap G-09): migration 018 shape (utf8mb4 InnoDB, date-range/pooja/event indexes, FKs `ON DELETE SET NULL`); `/api/calendar` computed baseline for March 2033, then a created entry appears on its day with `id`, `custom`, Tamil title/description and links while every other computed value stays byte-identical, a multi-day span marks each day across the month boundary, entries on one day follow `sort_order`, edits and hide/show/delete follow through publicly, a `hide` entry removes the computed Pournami (and `upcoming[]` follows) but keeps the committee's own entry, `all` clears every computed observance, hiding the suppression restores them; the admin page redirects without a session, opens for owner and editor, answers 403 to finance and viewer (page, toggle and delete POSTs), refuses forged and missing CSRF tokens, validates dates (2020–2035, impossible dates, end ≥ start), titles, type (`all` only for suppressions), order and pooja/event ids; deleting a linked pooja/event nulls the link; hostile input is stored as text and escaped everywhere; `calendar_entry_*` audit rows. Starts its own PHP server; rows prefixed `E2E-CAL-<run>` in 2033 — 90 checks |
| `audit-log.mjs` | Audit Logs (brief §28/§15/§16, gap G-10): `admin_activity` shape (InnoDB utf8mb4, column widths, indexes); failed and successful sign-ins, sign-out, account creation and password changes are audited with actor and the proxy-resolved IP (D-020); announcement / event / pooja / seva / homepage-widget create, update, toggle and delete each leave a row (deletes carry the name of what was removed; deleting an already-deleted pooja is not audited twice); settings saves list only the changed keys or `no changes`; the page redirects without a session, opens for owner and admin, answers 403 to editor, finance and viewer (page and CSV), hides its links from them, has no write path (a forged POST deletes nothing); filters by who, module, one action, search (wildcards literal), date range (reversed dates swapped, impossible dates flagged) and sort direction; 50/page with clamped out-of-range pages; CSV honours the filters, keeps Tamil intact and is itself audited; SQL and script payloads in audited data and in every filter are stored/echoed as text. Starts its own PHP server with `TRUSTED_PROXIES=127.0.0.1`; rows prefixed `E2E-AUD-<run>` — 72 checks |
| `content-bilingual.mjs` | Bilingual content (brief §6, §7, §25): migration 020 shape (types, defaults, indexes, backfill); the three admin pages redirect without a session, open for owner and editor, answer 403 to finance and viewer (page and POST), refuse forged and missing CSRF tokens; announcement create / edit / hide / delete in both languages with a publish window (future, expired and hidden notices stay out of `/api/announcements`), the old `title`/`body` fields still accepted; event create with type, featured, last day, times, venue, picture and bilingual description, eight validation refusals, `?upcoming` / `?past` (newest first) / `?featured` / `?type` (422 for junk), `GET /api/events/{id}` 200 / 404, the og.php preview (English and Tamil), spa.php status and sitemap entry for `/events/<id>`; seva bilingual description and timing, `is_bookable`, the bookable / feature / hide actions; hostile input stored as text and escaped in lists, forms, API and preview; `announcement_*` / `event_*` / `seva_*` audit rows. Starts its own PHP server; rows prefixed `E2E-BILING-<run>` — 145 checks |
| `gallery.mjs` | Photo gallery (brief §6, §22, §34): migration 021 shape, `/api/gallery` and `/api/gallery/albums` shapes, `?album=`, `?limit=`, hidden photos/albums left out, junk 422; admin RBAC (owner/editor 200, finance/viewer 403 on page and POSTs), CSRF; albums create/edit/hide/delete/cover; uploads of a GD-drawn PNG and JPEG stored under a random name with 480 px thumb and 1280 px medium copies (WebP where GD can write it, else JPEG; never upscaled), disguised PHP and GIF refused; per-photo edit of caption / alt text / album / shown; delete removes all three files; hostile input escaped; search group; `gallery_*` / `gallery_album_*` audit rows. Own PHP server; rows `E2E-GAL-<run>` — 139 checks |
| `cms-settings.mjs` | The admin CMS structure and the settings behind it (brief §15, migration 025): `site_settings`, `pages` (mission and history seeded) and `seo_settings` shape (utf8mb4, the unique keys); `GET /api/pages`, `GET /api/pages/{slug}` (hidden → 404), `GET /api/settings` (`site`, `seo`, `languages`; the private office keys never leave the server), `GET /api/pulse` hours and schedule from the settings, `GET /api/calendar` Nalla Neram from the committee's table; every new page needs a session (E2E-045), Pages and Nalla Neram open for editors, SEO and Languages for admins, Roles for everyone (E2E-013 / E2E-046), a forged CSRF token writes nothing (E2E-049); Pages create / edit / hide / delete in both languages, slug rules, duplicate slug refused, hostile input stored as text (E2E-047 / 048); Settings: temple details in both languages, each validation, opening hours and the daily schedule as typed lines, back to the default; SEO: an override changes the server preview (`og.php`) and drops the page from `sitemap.xml` when marked noindex, switched off the built-in words return, duplicate path refused; Nalla Neram: the table the committee saves is what the calendar shows, a window that ends before it starts is refused, reset; Languages: at least one language, the default among them; the sidebar groups (Content / Temple / Media / Finance / Communication / Devotees / System) and the four dashboard cards; audit rows for pages, settings, SEO, Nalla Neram and languages. Starts its own PHP server; needs migrations 015, 024 and 025; rows prefixed `E2E-CMS-<run>`, the `site_settings` rows it touches restored in `finally` — 124 checks |
| `public-content-ui.mjs` | Sevas, Events and Home in a browser (brief §6, §7, D-026): the upcoming special poojas with Featured/Live badges and the Sponsor link, office-only sevas without a Book control or deep link, the IST day on /events with featured events first and links to /events/<id>, Tamil months, the gallery strip (pinned to this run's photos), the Home live row naming the pooja and consented sponsor in both languages, /donate?pooja=<id> naming the pooja, E2E-005/020: a notice published today in the home page's notice band by its title in both languages while hidden, future and expired ones never show, no console errors, axe at 360 and 1366. Own PHP :8101 and Vite :5181; rows `E2E-PUBUI-<run>` — 144 checks |
| `public-pages.mjs` | /sponsorship and /deities (brief §6, §11, §22): `GET /api/poojas?sponsorship=1` and consent gating, og.php previews in both languages, sitemap and SPA status, both pages in Tamil and English at 360 and 1366, the Sponsor link, the thank-you list never showing an unconsented sponsor, axe. Own PHP :8102 and Vite :5182 — 296 checks |
| `admin-receipts.mjs` | Finance → Receipts (brief §14, §15): every issued receipt with its columns in both scripts, search, month/type/status filters, pagination, totals, CSV (formula-safe), open the printable receipt, resend (audited), RBAC for all five roles on GET and POST, CSRF, hostile input. Own PHP server; payment fixtures under its prefix — 104 checks |
| `api-v1.mjs` | `/api/v1` (brief §26): every GET route compared with its unversioned twin, the success and error envelopes (404/405/422/429/401), field errors, the `/home`, `/streams`, `/sponsors` aliases, non-JSON answers (og, sitemap, robots) untouched, the unversioned API byte-for-byte unchanged. Own PHP server — 162 checks |
| `structured-data.mjs` | JSON-LD and gallery previews (brief §22): the HinduTemple record on "/" in both languages, an Event with a hostile title that cannot close its script tag, a VideoObject/BroadcastEvent for a broadcast, album and photo previews with alt text, sitemap album entries only while a shown photo exists. Own PHP server — 41 checks |
| `deploy-config.mjs` | The production configuration (brief §27, §39): every HTTPS, HSTS, header, CSP, private-folder and caching rule in `deploy/htaccess_*`, the logs guard, no inline script in the built `index.html`, `APP_ENV` behaviour, and every migration setting utf8mb4 before its first statement (D-050). Reads files only — 46 checks |
| `backup-restore.mjs` | The backup rehearsal (brief §33, §40): `deploy/backup.sh`, a damaged copy refused by `restore.sh`, a restore into a scratch database with the same tables, row counts and foreign keys and Tamil byte-for-byte, uploads restored by checksum, everything removed. Needs bash, mysqldump, mysql, tar, gzip, sha256sum — 20 checks |
| `lighthouse.mjs` | Lighthouse (brief §34) on a production build in `.lighthouse-dist` served by `vite preview` on :4173: six routes at the mobile and desktop presets; gates Accessibility ≥ 90, SEO ≥ 90, Best Practices ≥ 80 (Performance reported; `LH_MIN_PERF` to gate it); scores and top findings in `tests/reports/lighthouse/summary.md` |
| `pwa.mjs` | The installable app on a production build (`.pwa-dist`, `vite preview` :4181 → its own PHP :8106): exactly one manifest link (D-049), the manifest's names, start URL, scope, display and served icons; `/sw.js` registers with scope `/`, activates and controls the page; the precache holds `index.html` and every script and stylesheet it loads; `/api` GETs kept network-first while `/api/payments/*` and `/api/live-streams/*` are never cached; offline, visited and unvisited pages open from the app shell in the chosen language; `/admin/`, `/api/` and `/uploads/` never answered with the React app (online from PHP, offline a network error) — 29 checks |
| `coverage-audit.mjs` | Traceability, read from the source so nothing new slips past: every route in `backend/api/index.php` (the table, the payments actions, the live-streams sub-routes, tracked links, webhooks, crons, the `/api/v1` aliases, the files Apache calls), every `backend/admin/*.php` and every `<Route>` in `frontend/src/App.jsx` (in a browser suite) is requested by at least one suite, every `backend/api` file is routed, and every brief case E2E-001…055 is Covered in `docs/TESTING.md`. Static — 217 checks |
| `screenshot.mjs` | Utility: `node screenshot.mjs <url> <out.png> [w] [h] [--login] [--full]` |

```bash
node tests/admin-smoke.mjs http://127.0.0.1:8000
node tests/admin-roles.mjs
node tests/admin-hostile-input.mjs
node tests/admin-bulk-import.mjs
node tests/public-e2e.mjs   http://localhost:5173
```

**Clear `rate_limits` before a repeated run by hand.** Registration, the forms
and the admin sign-in are rate limited per address, which is correct in
production and will stop a repeated test run part-way through (the suites
reset their own buckets; this clears everything):

```sql
DELETE FROM rate_limits;
```

Start Vite with `--host 127.0.0.1` (prerequisites above) and give the browser
suites `http://127.0.0.1:5173`: with Vite's default `--host localhost`, Node 24
binds the IPv6 loopback only and `127.0.0.1` refuses the connection.

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
| `payments-unit.php` | — (CLI, database only) | The module's rules against the real code and database: CCAvenue's crypto on a pinned vector, the amount grammar, numbers and tokens, a gap-free receipt sequence while two PHP processes race for the counter, response parsing and both status-mapping tables, the transition table, refund arithmetic, redaction, validation with hostile input, and (§8/§9d) one sponsor per paid pooja donation — 357 checks |
| `payments-api.mjs` | PHP 8061, mock 8071 | The public API in TEST mode against a stand-in gateway: config secrecy, the 422 matrix, honeypot and flood limits, the encrypted order's exact fields, success / replay / failure / cancel / awaited callbacks, tampered responses never becoming SUCCESS, the status API unreachable, retries, tokenised status and receipt pages, seva price from the database, hold expiry, a pooja donation's sponsor row (§4m) and a gateway timeout (§4n), the stale-attempt sweep (§5c), and that no key ever appears in JSON, HTML, tables or logs — 311 checks |
| `admin-payments.mjs` | PHP 8062, mock 8072 | Admin → Online Payments, Payment Gateway and Donation Categories: roles and CSRF, filters and CSV, KPIs recomputed in SQL across an IST month boundary, the detail view (with the pooja and sponsor of a pooja donation, §9b), refunds (full, partial, refused, unreachable, manual), the settings page with snapshot/restore of `payment_settings`, reconciliation and the CSV upload, axe at 390/1440 — 242 checks |
| `payments-ui.mjs` | PHP 8063 (simulator), Vite 5190 | The donor's side in a real browser: `/donate` at four widths, the three steps and their validation, the redirect to the simulator, success / declined / cancelled / pending results, a reload of the result page, the receipt on screen and under print media, QR verification, the seva dialog's pay-now and request paths, the Pooja sponsorship scenario from `/donate?pooja=<id>`, the policy pages — 277 checks |

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
create payables, drive state changes, sweep, `refund`, cleanup), `support/ccavenue_crypto.mjs`
and `support/ccavenue_mock.mjs` (the stand-in checkout page and status/refund API).

Since migration 023 all four suites need it (`donations.pooja_id`,
`sponsors.donation_id`): `payments-ui.mjs` inserts a pooja and a homepage
widget under its prefix for the *Pooja sponsorship* scenario, and the
fixtures' cleanup removes the sponsor rows a paid pooja donation created.

`public-hardening.mjs` adds a flood-limit row for `/api/payments/donations` only
when the server it is given has payments enabled (start it with
`PAYMENTS_ALLOW_SIMULATOR=1`, a settings overlay and fake TEST credentials);
`admin-smoke.mjs`, `admin-roles.mjs`, `admin-hostile-input.mjs`, `og.mjs`,
`public-e2e.mjs` and `search-api.mjs` include the payment pages and routes.

## Live Darshan (YouTube Live)

`node tests/live-og.mjs` checks per-stream crawler previews using disposable
MySQL fixtures (migration 011 required). Pass the usual DB environment variables;
it owns its PHP server and cleans up its own streams. Browser/metadata agreement
for public routes remains covered by `og.mjs`.

Six suites cover `docs/live/SPEC-PHASE1.md` §6, `docs/live/SPEC-PHASE2.md`
§3, `docs/live/SPEC-PHASE3.md` §11.3 and migration 022's links. Like the
payments suites they start and stop their own servers — PHP on ports
**8081–8085** and **8093**, the YouTube stand-in on **8091** / **8092** and,
for the browser suite, a throwaway Vite on **5195** whose `/api` proxy points
at the suite's PHP. Ports in use → exit 2.
Migration `011_live_streams.sql` must be applied. The API and UI suites also
check for `012_live_automation.sql`, needed by the Phase 4 viewer tests.
The public application still works without 012, with no viewer count.
`live-links.mjs` needs `022_live_links.sql` (its sponsor credit reads the
consent columns of `016_sponsors_consent.sql`).
`live-sync.mjs` needs both migrations and the right to `CREATE`/`DROP` a scratch
database for its missing-migration scenarios. YouTube's hosts are answered by a stub inside
the browser, so nothing leaves the machine and no real video plays.

| Script | Ports | What it proves |
| ------ | ----- | -------------- |
| `live-unit.php` | — (CLI, database only) | The module's rules against the real code and database: every accepted and refused form of a YouTube reference, the embed/watch/thumbnail builders, slugs (uniqueness across deleted rows, `-2` suffixes, digits-only titles, the lock after publishing), UTC round trips and DST, the whole `liveValidate` matrix with hostile input, the store (lists, ordering, the 3-hour grace for a late broadcast, soft delete and restore), every legal and illegal transition, readiness for Publish / Go live, uploads with a real PNG, a text file and an oversize blob; phase 2: the day / week / festival windows in Asia/Kolkata (23:59 IST inside, the next midnight outside, the week ending Sunday, month and year rollovers), `day_bucket` and `starts_in_seconds`, the schedule list's membership (cancelled rows out, ended ones in), order (live first, undated last, ended last within a day) and counts, the reserved slug `schedule`, and the Vimeo / AWS IVS placeholders — 732 checks |
| `live-api.mjs` | PHP 8081, mock 8091 | The public routes (index, live, upcoming, by id and by slug: shapes, ordering, caching headers, 404s, 405s, escaping, no cookies) and the admin JSON API (401/403 as JSON, the CSRF token, create / edit / transition / delete, 422 for hostile fields and unready drafts, 409 for illegal jumps, the locked slug, viewer and editor roles, audit rows), plus that `/api/events`, `/api/homepage_widgets` and `/api/search` still answer; phase 2: `/api/live-streams/schedule` with rows across today / tomorrow / this week / next week / past / festival / live / ended-today / cancelled / draft / deleted — every filter's membership and order, the counts, the ISO window, the limit cap, `filter=bogus`, the 30-second cache header, the item shape, `now` / `next` on the index, and that the browser's copies of the event-type and filter labels (`frontend/src/lib/live.js`) still mirror `backend/includes/live/config.php` word for word — 372 checks |
| `live-sync.mjs` | PHP 8084–8085, mock 8092 | The phase 3 poller through its three doors — `bin/live_cron.php`, `/api/live-cron` and the fixture's `sync` (`liveCronRun()`) — against the YouTube stand-in with `LIVE_ALLOW_SIMULATOR=1` and a fake key: the CLI's `--help`, refused and clamped options, `--stream-ids=` (empty) touching nothing, `--dry-run` leaving the row byte-identical, mode off, cadence (a checked row is not due again at once), exit codes without migration 012 (0) and 011 (1); the flow — four rows in one `videos.list` request, `SCHEDULED→STARTING`, `→LIVE` with `actual_start_at`, `LIVE→COMPLETED` with `actual_end_at` and `recording_url`, the one-sweep catch-up to COMPLETED with two `live_stream_status` audit rows, the provider's own schedule stored while `scheduled_start_at` stays; the guards — grace and notices for missing / restricted / not-a-broadcast videos, a forward human move adopted and a backwards one pausing the row, paused rows skipped unscoped and reported when scoped, `auto_end = 0` holding, DRAFT / CANCELLED / deleted / non-YouTube rows never selected, a video from another time or channel refused as a mismatch, the stuck-STARTING pause (G22), a long live broadcast left alone; failures — `Retry-After`, back-off steps and the 300 s ceiling, the twelve-failure pause (G15), one bad row not spoiling the batch, a wrong key read as `auth`, the quota breaker stopping every call and the next sweep making none, the simulated failure after LIVE rolling both steps back; HTTP — 404 without a key or with a short one, 403 and the thirty-an-hour lock, the seven-key answer and nothing more, `Allow: GET, POST`; the advisory lock (`hold-lock` then a run answers `locked: true`); and no key, token or provider URL in any output or log — 103 checks |
| `admin-live.mjs` | PHP 8082 | Admin → Live Streaming over HTTP and in a browser: create with an exact Tamil round-trip, the edit view, an update that changes only what was edited, the validation matrix, the status buttons (a bare draft cannot be published; Go live re-checks the row), delete and restore, thumbnail uploads (the oversize fixture is 5 MB + 1 KB, over the product's limit), the Pooja / Event selects, filters / search / sort / pagination, hostile query strings, viewer and editor roles, forged CSRF, overflow and axe at 390 and 1440 — 240 checks |
| `live-links.mjs` | PHP 8093, YouTube simulator | A stream's pooja / event links and the public shape (`pooja {id, name_ta, name_en, date, time}`, `event {id, title_ta, title_en, date}` with Tamil intact; the admin JSON API accepts, refuses a vanished pooja with 422, and clears them), the sponsor credit gated on consent (family name over name, with the note — never phone, email or amount; unconsented, inactive and withdrawn sponsors never named), `ON DELETE SET NULL` when the pooja or event goes, End stream by hand keeping the broadcast's own video as the recording (archive on, YouTube; not with archive off, not for a custom provider, never over a recording already set) and the archive listing it, Featured ordering and badge, Show on homepage, and `playback.unavailable` for a video the simulator reports missing or not embeddable (brief §12, §6, §32) — 53 checks |
| `live-ui.mjs` | PHP 8083, Vite 5195 | The devotee's side in a real browser: `/live-darshan` at four widths, the broadcast's facts, the `youtube-nocookie.com` iframe and its attributes in Tamil then English, the 16:9 box, slug routes (not found, draft, offline, completed, error), the header / drawer / footer / Home entry points, the header fit at 36 widths in both languages, polling (a STARTING broadcast goes LIVE under the visitor and is announced; nothing polls after leaving the page), the scheduled poster, a broadcast running late ("Starting shortly"), the empty state; phase 2: `/live-darshan/schedule` at four widths (axe with iframes off), the five filters with their counts, switching that updates the address and the list, `?filter=` on a direct load, the day groups, the compact countdown on a card, the per-filter empty state and its switch button, Tamil; the countdown on `/live-darshan` (HH:MM:SS from a fixture starting in 90 s, two samples 5 s apart, the sr-only sentence, "Starting shortly" at T+0) and a `server_time` skewed by ±10 minutes shifting it; the homepage's LIVE NOW, next-darshan and nothing states with the hero row; and the review fixes — the filter strip at 390 in both languages (every chip inside the viewport, 44 px, the selected one in view), the days unit on a countdown eight days out and its absence under a day, the 44 px targets of the homepage's live section, the poster, the hero and the homepage's hero row flipping to "Starting shortly" at T+0, the Tamil weekday-first day label, a filter switch that keeps its list while a delayed answer is awaited, a broadcast going live under the schedule page without a reload, the Today / Tomorrow empty state's way out on a Sunday and on a Monday, and the shared address carrying `?filter=`; the links scenario (a broadcast that belongs to a pooja / event) — 431 checks |

```bash
PHP_BIN=/path/to/php.sh
$PHP_BIN tests/live-unit.php
PHP_BIN=$PHP_BIN node tests/live-api.mjs
PHP_BIN=$PHP_BIN node tests/admin-live.mjs
PHP_BIN=$PHP_BIN node tests/live-sync.mjs
PHP_BIN=$PHP_BIN node tests/live-links.mjs   # LIVE_LINKS_PORT overrides 8093
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
change its status, run SQL, `sync` — one `liveCronRun()` with the given ids,
`dry_run` and `actor` —, `due` and `hold-lock`, clean up) and
`support/youtube_mock.mjs` (the oEmbed / Data API stand-in for phase 3).

`admin-smoke.mjs`, `admin-roles.mjs`, `admin-hostile-input.mjs`, `og.mjs`,
`public-e2e.mjs` and `search-api.mjs` include the Live Streaming page, the
`/live-darshan` route and `/live-darshan/schedule`. Run `og.mjs` before
creating any live fixture: its `/live-darshan` comparison holds only while no
broadcast is live or upcoming (the schedule page's strings are static).

## Notifications and family registration

Devotee sign-in, the in-app bell and web push were retired (`docs/registration/SPEC.md`
§1, §6; `NOTIFY_RETIRED_CHANNELS`): the suites below prove those surfaces are
gone (404, no delivery rows, unknown events) and cover what ships — email,
WhatsApp and SMS, consent from registration, the unsubscribe link.

| Script | Ports | What it proves |
| ------ | ----- | -------------- |
| `notify-unit.php` | — (CLI, database only) | Policy rules in order, audiences, the 19-event catalogue (with `contact.received` and `sponsor.confirmed`), templates in both languages, no retired event, template or channel — 492 checks |
| `notify-templates-unit.php` | — | Every built-in template renders in Tamil and English for each channel with its sample data — 131 checks |
| `notify-worker.mjs` | PHP 8011–8012 | The queue and worker through the CLI: email/WhatsApp/SMS queue then send while in-app and push never become deliveries; retries, backoff, dead, requeue; flaky and rejected; throttle; stale claims; dedupe; secrets sent synchronously and never stored (D-052); consent (none, unsubscribed — also after queueing — archived; booking messages always go); campaigns to 600 consenting families, time zones, recurrence, cancellation; reminders waiting for approval; provider status updates; clicks and opens; `/api/notify-cron` keys — 188 checks |
| `notify-triggers.mjs` | the given server (:8050) | The account endpoints answer 404 under `/api` and `/api/v1` and do nothing; `registration.received` for a consenting family only (email + WhatsApp, its language, family count, deduped); bookings and donations told to the phone on the form; admin status changes and bulk cancel notify once; numbered receipts; the announcement's email + WhatsApp draft campaign — 63 checks |
| `notify-providers.mjs` | 8020–8029 | Every provider against stand-ins over real HTTP and SMTP (mailer, Meta, Twilio, MSG91), push and FCM proved retired, the webhook endpoint's signatures and the test driver on email, verified updates applied, `notify_keys.php check` — 137 checks |
| `notifications-api.mjs` | the given server (:8050) + 8030 | The retired inbox, preference and device routes answer 404; tracked clicks, the open pixel, unsubscribe (masked email or phone, RFC 8058 one-click, consent withdrawn once, booking messages still go), webhook and cron routes, an unconfigured driver skipped — 73 checks |
| `registration-api.mjs` | the given server (:8050) | `POST /api/registrations`: validation, storage, honeypot, limits, no cookies, and the queued `registration.received` (asserted by default; `NOTIFY_ASSERT_MESSAGES=0` opts out) — 210 checks |
| `admin-registrations.mjs` | the given server (:8050) | Devotees → registrations in the admin: list, edit, family members, duplicates, validation with a focused error summary, axe (after the summary's fade-in) and overflow at 390 and 1440 — 123 checks |

The regression script starts the notification test-driver server on :8045 (not
:8025, which `notify-providers.mjs` uses for its push stand-in).

## Live email reminders

After migration 013, run `node tests/live-subscriptions.mjs` with the MySQL
environment. It starts PHP on 8086 (`LIVE_SUBS_PORT` overrides it), uses the
notification test driver, and removes only its uniquely named fixtures.
It covers public validation, duplicate/privacy behavior, consent, unsubscribe,
queue/delivery eligibility, rescheduling and flood buckets. Test-driver
acceptance does not prove real email delivery.

## Stream-linked donations

After migration 014, run `node tests/live-donations.mjs` with the MySQL
environment. It starts PHP on 8088 (`LIVE_DONATIONS_PORT` overrides it).
Owned fixtures cover stream validation, checkout attribution, retry and
validation/write races, separate-currency totals, production/test separation,
callback replay, partial/full refunds and public privacy. The fixture state
transitions are local only; no real money moves.

## Design-system check

Not in this folder because it needs no running server:

```bash
cd frontend && npm run audit
```

Reports undefined CSS custom properties, class names with no rule, opaque raw
colours outside `tokens.css`, and inline styles that are not dynamic values.
# Family member Gothram

After applying migration 029, run `php tests/registration-gothram.php` with the
local test MySQL environment configured. Checks cover optional/Tamil values,
length and type validation, public persistence, admin edits and clearing.
Only its own fixtures are created and cleaned; use an authorized test database.
