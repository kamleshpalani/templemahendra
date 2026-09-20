# Testing

How the suites run is in `tests/README.md` (MySQL 8 only, real PHP + Vite
stack, owned fixtures, cleanup). This page is the traceability matrix for the
brief's §30 cases E2E-001…050: for each one, the suite and the check (by its
printed label or by its section) that exercises it, or an honest "gap".

Legend — **Covered**: an assertion states the case in its own words.
**Partial**: the behaviour is exercised but a stronger or more direct check is
missing; what is missing is written down. **Gap**: not tested (and, where
noted, not built).

Provider note: every payment, email, SMS, WhatsApp and YouTube check below runs
against the local simulators (`ccavenue` mock, `mail_log`, provider stubs,
YouTube fixture data). They prove the application's side of each flow; they do
not prove settlement, delivery or real playback. Those are G-14 (staging) work.

## Matrix

| Case | Requirement | Status | Where |
| --- | --- | --- | --- |
| E2E-001 | Homepage loads successfully | Covered | `public-e2e.mjs` — `/ @390/768/1024/1440: exactly one h1`, `no horizontal overflow`, `no console errors`, axe |
| E2E-002 | English renders correctly | Covered | `public-e2e.mjs` — `language toggle re-renders navigation in English`, `language: English survives a reload / a full navigation / an in-app navigation` |
| E2E-003 | Tamil renders correctly | Covered | `public-e2e.mjs` — `language: a first visit opens in Tamil`, `a fresh browser context starts in Tamil`; Tamil round-trips in `brief-e2e.mjs` (`pooja row stored with Tamil name intact`, `the event is public with Tamil intact`), `registration-api.mjs`, `live-api.mjs` |
| E2E-004 | Language switching works | Covered | `public-e2e.mjs` — `language toggle switches <html lang>`, `the choice is stored as temple:lang`, `switching in one tab updates the other` |
| E2E-005 | Announcement displays | Covered | `brief-e2e.mjs` — `E2E-020 the announcement is in the public feed` (`/api/announcements`); rendering: `public-e2e.mjs` Home route checks |
| E2E-006 | Upcoming pooja displays | Covered | `brief-e2e.mjs` — `E2E-006 an upcoming pooja is shown and every date is today or later` (`/api/homepage_widgets`) |
| E2E-007 | Expired pooja is excluded | Covered | `brief-e2e.mjs` — `E2E-007 the expired Pournami is not shown as upcoming` (a calendar card still linked to a past pooja) |
| E2E-008 | Next pooja automatically selected | Covered | `brief-e2e.mjs` — `E2E-008 the stale calendar card was re-pointed at the next valid Pournami-first pooja` (compared with the ordering rule in `api/homepage_widgets.php`) |
| E2E-009 | Sponsor shown when consent enabled | Covered | `sponsors.mjs` — `/api/donors shows the sponsor under the family name`, `manually linked card shows the family name`, `zero-widget fallback attaches the consented sponsor`; `public-hardening.mjs` — `the linked sponsor card shows the sponsor's name`, `the sponsor object holds only name and note`, `donors lists the pledge with consent` |
| E2E-010 | Sponsor hidden without consent | Covered | `sponsors.mjs` — `/api/donors omits an active sponsor without consent`, `hidden sponsor with consent leaves /api/donors`, `withdrawn consent removes the sponsor from /api/donors`, `phone, email, amount, reference and status never reach /api/donors`; `public-hardening.mjs` — `donors does not list the pledge with <consent off>`, `does not list a row that never gave consent`, `no phone digits or phone key anywhere in the body` |
| E2E-011 | Admin login succeeds | Covered | `admin-auth.mjs`, `admin-roles.mjs`, `admin-smoke.mjs` (sign-in → dashboard); `brief-e2e.mjs` `admin signed in` |
| E2E-012 | Invalid admin login rejected | Covered | `admin-auth.mjs` — `E2E-012 wrong password is rejected`, lockout after ten failures (`10th failure reports the account is locked`, `correct password is refused while locked`) |
| E2E-013 | Unauthorized role rejected | Covered | `admin-auth.mjs` — `E2E-013 <page> → admin/editor/finance/viewer 200/403…` for every admin page; `admin-roles.mjs` — `editor is refused the users page with an explanation` |
| E2E-014 | Admin creates pooja | Covered | `brief-e2e.mjs` — `E2E-014 …` (validation of missing fields and impossible dates, create, list in both languages) |
| E2E-015 | Admin edits pooja | Covered | `brief-e2e.mjs` — `E2E-015 edit persisted; other columns kept`, `edit did not create a duplicate` |
| E2E-016 | Admin archives pooja | Covered | `brief-e2e.mjs` — `E2E-016 toggle hides the pooja`, `a hidden pooja leaves the public feed`, `the list marks it Hidden` (the product archives by hiding: `is_active = 0`) |
| E2E-017 | Admin creates event | Covered | `brief-e2e.mjs` — `E2E-017 admin created an event`, `an event without a date is refused` |
| E2E-018 | Event displays publicly | Covered | `brief-e2e.mjs` — `E2E-018 the event is public with Tamil intact` (`/api/events?upcoming=1`); `public-e2e.mjs` events filtering |
| E2E-019 | Admin creates announcement | Covered | `brief-e2e.mjs` — `E2E-019 admin created an announcement`, `an announcement without a title is refused` |
| E2E-020 | Announcement appears on homepage | Partial | API feed asserted (`brief-e2e.mjs` E2E-020); the homepage's rendering of a specific new announcement in the browser is not asserted by title (Home is checked structurally in `public-e2e.mjs`) |
| E2E-021 | Gallery image upload | Covered | `brief-e2e.mjs` — `E2E-021 stored under a random name with the decoded type's extension`, `file is on disk`, `the stored name never comes from the upload` |
| E2E-022 | Gallery image displays | Covered | `brief-e2e.mjs` — `E2E-022 the photo is in the public gallery feed`, `the photo is served as an image`; `public-e2e.mjs` `/gallery` route checks |
| E2E-023 | Invalid gallery upload rejected | Covered | `brief-e2e.mjs` — `E2E-023 a PHP file with an image name and MIME is refused`, `an unsupported image type is refused`, `refused uploads created no rows`; `uploads never execute PHP` |
| E2E-024 | Admin creates livestream | Covered | `admin-live.mjs` — `create → 303 with the flash Created.`, `status, provider and the parsed video id…`, timezone/schedule checks |
| E2E-025 | Upcoming livestream appears | Covered | `live-ui.mjs` — `the upcoming grid…` card links to the scheduled broadcast `…with its Scheduled` label; `live-api.mjs` — `exactly live, upcoming, now, next, server_time` |
| E2E-026 | LIVE indicator appears | Covered | `live-ui.mjs` — `Home LIVE @<w>: LIVE NOW badge…`, `Watch live → the broadcast`; `the hero badge carries the live dot` |
| E2E-027 | YouTube embed displays | Covered (simulated) | `live-ui.mjs` — `/live-darshan @<w>: … .live-player__iframe`, `iframe host is www.youtube-nocookie.com`, `the player box is 16:9`; playback itself is not proven (fixture IDs, no real YouTube) |
| E2E-028 | Ended livestream archives correctly | Covered | `live-archive.mjs` — `saved completed recording appears automatically`, `completed player uses recording rather than live video`, `deleted recordings are hidden`; `live-sync.mjs` LIVE→COMPLETED transitions |
| E2E-029 | Donation form validates required fields | Covered | `payments-ui.mjs` — `details, empty Next: name and mobile number are required`, `Proceed without the tick: the terms are required`; `payments-api.mjs` — `a body that is <label> → 422 naming category/amount/name` |
| E2E-030 | Donation transaction is created | Covered | `payments-api.mjs` — attempt `INITIATED`, `attempt_created`/`redirect_issued` audits, `payable_created` |
| E2E-031 | CCAvenue test redirect works | Covered (simulated) | `payments-api.mjs` — gateway URL + `encRequest, access_code` fields, decrypted request field order, redirect/cancel URLs, `the amount sent is the amount stored`; `payments-ui.mjs` — `Redirecting securely to CCAvenue…` |
| E2E-032 | Successful CCAvenue response handled | Covered (simulated) | `payments-api.mjs` — `the donation is SUCCESS with receipt…`, `response_received / verification_ok / status_changed / notification_queued`; `payments-ui.mjs` success screen fields |
| E2E-033 | Failed transaction handled | Covered (simulated) | `payments-api.mjs` — `FAILED` donation/transaction with `gateway_status Failure`, `payment.failed` notification, retry attempts, `the sixth attempt → 409 not_retryable` |
| E2E-034 | Cancelled transaction handled | Covered (simulated) | `payments-api.mjs` — `donation and attempt are CANCELLED`, `no message on CANCELLED`; `payments-ui.mjs` — `Back from the gateway: no 'Redirecting' card` |
| E2E-035 | Duplicate response does not duplicate donation | Covered | `payments-api.mjs` — `a replayed response answers the same 303`, one `donation.paid` row with dedupe key, receipt counter advanced once; `payments-unit.php` idempotency |
| E2E-036 | Successful payment generates receipt | Covered | `payments-api.mjs` — receipt number format, `payment_counters` advanced, receipt endpoint keys/masking; `payments-ui.mjs` — `success: Receipt number…` |
| E2E-037 | Payment confirmation email triggered | Covered (simulated) | `payments-api.mjs` — `donation.paid` notification queued with `to_email`, `its channels follow the settings: email and whatsapp`; delivery through `notify-worker.mjs` / `notify-providers.mjs` to the local stubs only |
| E2E-038 | Contact form succeeds | Covered | `public-e2e.mjs` — `contact: success feedback`, `contact: no console errors`; `brief-e2e.mjs` — `/api/contact` 201 |
| E2E-039 | Invalid contact form rejected | Covered | `public-e2e.mjs` — `contact: validation errors on empty submit`; `public-hardening.mjs` honeypot and `429: contact form shows the friendly message` |
| E2E-040 | Contact notification generated | **Gap (not built)** | `api/contact.php` stores the message; no notification event exists for it (`includes/notify/events.php` has no contact trigger). Tracked as G-19 in `docs/GAP-ANALYSIS.md` |
| E2E-041 | Mobile navigation works | Covered | `public-e2e.mjs` — `drawer opens (aria-hidden=false)`, `drawer moves focus inside`, `Escape closes drawer`, `focus returns to hamburger after close`; every route @390 |
| E2E-042 | Tablet layout works | Covered | `public-e2e.mjs` — every route `@768` and `@1024`: one h1, no overflow, no console errors, axe; header fit guard; `live-ui.mjs` `/live-darshan @768/@1024`; `payments-ui.mjs`, `notifications-ui.mjs` at 768 |
| E2E-043 | Desktop layout works | Covered | `public-e2e.mjs` — every route `@1440`, header fit at 1920; `live-ui.mjs` @1440 |
| E2E-044 | Invalid URL returns correct 404 | Covered | `seo-crawl.mjs` — unknown SPA route → HTTP 404 + React shell + `X-Robots-Tag: noindex, nofollow`, `an unfurler still gets the 404 preview`, `API 404 stays JSON`; `public-e2e.mjs` — `/admin/ does not render the SPA shell` |
| E2E-045 | Protected API rejects unauthenticated user | Covered | `brief-e2e.mjs` — `E2E-045 admin API answers 401 without a session`, `admin page redirects to sign-in`; `live-api.mjs`, `notifications-api.mjs` 401 paths |
| E2E-046 | RBAC endpoint rejects unauthorized role | Covered | `admin-auth.mjs` — `E2E-046 finance POST to a content page is refused`, `editor POST to settings is refused`, `viewer POST to payments is refused`; `admin-roles.mjs` |
| E2E-047 | SQL injection payload does not execute | Covered | `brief-e2e.mjs` — `E2E-047 …` (search, contact, admin save; payload stored verbatim, `the poojas table is intact`); `search-api.mjs` — `an injection attempt is just a search term`; `admin-hostile-input.mjs` |
| E2E-048 | XSS payload does not execute | Covered | `brief-e2e.mjs` — `E2E-048 admin inbox renders the payload inert`, `admin list escapes it`, `edit form escapes it`, public responses stay JSON; `admin-hostile-input.mjs` reflected-script checks; `og.mjs` / `live-og.mjs` escaped metadata |
| E2E-049 | CSRF protection rejects invalid request | Covered | `brief-e2e.mjs` — `E2E-049 forged token is refused with a message`, `…and nothing was written`, `a missing token is refused too`; `admin-payments.mjs`, `admin-live.mjs`, `notifications-api.mjs` CSRF cases |
| E2E-050 | Session logout invalidates admin session | Covered | `admin-auth.mjs` — `E2E-050 old session cookie no longer works after logout`; idle expiry and revocation on disable/delete in the same suite |

Totals: 48 covered (7 of them against local simulators), 1 partial (E2E-020),
1 gap (E2E-040, feature not built).

## Running the §30 set

```bash
export DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=templemahendra DB_USER=root DB_PASS=root
node tests/brief-e2e.mjs            # starts its own PHP server; E2E-006…023, 045, 047…049
node tests/admin-auth.mjs  http://127.0.0.1:8000   # E2E-011…013, 046, 050
node tests/public-hardening.mjs http://127.0.0.1:8000   # E2E-009/010, 039
node tests/sponsors.mjs             # starts its own PHP server; sponsors CMS, consent, migration 016, bulk import, RBAC
node tests/videos.mjs               # starts its own PHP server; videos CMS, categories, /api/videos, search, migration 017, RBAC
node tests/calendar-entries.mjs     # starts its own PHP server; Temple Calendar CMS, merge into /api/calendar (add + suppress), migration 018, RBAC
node tests/seo-crawl.mjs   http://127.0.0.1:8000   # E2E-044
node tests/public-e2e.mjs  http://localhost:5173   # E2E-001…004, 038/039, 041…043 (Vite + PHP)
node tests/live-ui.mjs && node tests/live-archive.mjs && node tests/admin-live.mjs   # E2E-024…028
node tests/payments-api.mjs && node tests/payments-ui.mjs   # E2E-029…037
```

`brief-e2e.mjs` needs the admin account `admin` / `Admin@Test123` (override
with `ADMIN_USERNAME` / `ADMIN_PASSWORD`; it derives `ADMIN_PASS_HASH` for the
server it starts) and cleans every `E2E-BRIEF-<run>` row and upload it wrote.

## Known failures (pre-existing, tracked in `docs/DEFECTS.md`)

- D-014 — `admin-live.mjs`: 2 of 235 checks (column-drift assertion; form-drawer axe @1440).
- D-015 / G-18 — `admin-notifications.mjs`: retired `inapp`/`push` channels; 39/47.
- D-017 — `public-e2e.mjs`: 5 header checks expect the retired sign-in/sign-up links.

None of these change the verdict of a §30 row above; the affected assertions
are not the ones cited.
