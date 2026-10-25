# Testing

How the suites run is in `tests/README.md` (MySQL 8 only, real PHP + Vite
stack, owned fixtures, cleanup). This page is the traceability matrix for the
brief's §30 cases E2E-001…050, the §31 payment cases added as E2E-051…055 and
the §22 / §32 / §34 checks that have no number: for each one, the suite and
the check (by its printed label or by its section) that exercises it, or an
honest "gap".

Legend — **Covered**: an assertion states the case in its own words.
**Partial**: the behaviour is exercised but a stronger or more direct check is
missing; what is missing is written down. **Gap**: not tested (and, where
noted, not built).

Provider note: every payment, email, SMS, WhatsApp and YouTube check below runs
against the local simulators (`ccavenue` mock, `mail_log`, provider stubs,
YouTube fixture data). They prove the application's side of each flow; they do
not prove settlement, delivery or real playback. Those are G-14 (staging) work.

## Prerequisites and layers

PHP 8.1+ with `pdo_mysql`, `mbstring`, `sodium`, `openssl`; MySQL 8 (the
`docker run` in `tests/README.md`; `utf8mb4_unicode_ci`); Node 18+; for the
browser suites `npm i playwright axe-core && npx playwright install chromium`
at the repo root. `.agents/skills/testing-mysql-cms/SKILL.md` records the
local quirks (container on :3307, `ADMIN_PASS_HASH`, restart recovery).

| Layer | What | Command |
| --- | --- | --- |
| Syntax | every PHP file, both shell scripts | `find backend -name '*.php' -exec php -l {} \; \| grep -v 'No syntax'`; `bash -n deploy/backup.sh deploy/restore.sh` |
| Unit | pure PHP: state machines, crypto vectors, templates, health verdicts | `php tests/payments-unit.php`, `php tests/live-unit.php`, `php tests/notify-unit.php`, `php tests/notify-templates-unit.php` |
| API / integration | Node scripts against a PHP server they start (or `:8000`) and MySQL; each owns its fixtures and cleans them in `finally` | `node tests/<suite>.mjs` — the §30 list below, plus `admin-*.mjs`, `live-*.mjs`, `payments-api.mjs`, `notifications-*.mjs`, `notify-*.mjs` |
| Browser | Playwright + axe at 360/390/768/1024/1366/1920 against Vite `:5173` + PHP `:8000` | `node tests/public-e2e.mjs http://localhost:5173`, `live-ui.mjs`, `payments-ui.mjs`, `notifications-ui.mjs`, the recorded testing-agent runs linked from each PR |
| Frontend | production build (no linter is configured; the browser suites assert zero console errors) + design-token audit | `cd frontend && npm run build && npm run audit` |
| Database / backup | schema, foreign keys, Tamil round trip, backup → fresh-database restore, tamper rejection | `docs/DATABASE.md`; the rehearsal in `docs/DEPLOYMENT.md` → *Backups and restore* (`deploy/backup.sh`, `deploy/restore.sh`) |

The brief's §31 payment cases map to `payments-api.mjs` / `payments-ui.mjs`
(success, failure, cancel, invalid and tampered `encResp`, duplicate callback,
refresh and back after payment, wrong amount, record mismatch, receipt, and
since migration 023 a pooja donation creating exactly one sponsor —
E2E-051…055 below); §32 live cases to `live-api.mjs`, `live-sync.mjs`,
`live-health.mjs`, `live-links.mjs` (pooja / event-linked streams, the
unavailable-video flag), `live-ui.mjs`; §22 alt text and §34 image loading to
`gallery.mjs`; §33 database cases to `docs/DATABASE.md` and the restore
rehearsal. Full detail per gateway: `docs/CCAvenue-INTEGRATION.md`,
`docs/LIVE-STREAMING.md`.

## Matrix

| Case | Requirement | Status | Where |
| --- | --- | --- | --- |
| E2E-001 | Homepage loads successfully | Covered | `public-e2e.mjs` — `/ @390/768/1024/1440: exactly one h1`, `no horizontal overflow`, `no console errors`, axe |
| E2E-002 | English renders correctly | Covered | `public-e2e.mjs` — `language toggle re-renders navigation in English`, `language: English survives a reload / a full navigation / an in-app navigation` |
| E2E-003 | Tamil renders correctly | Covered | `public-e2e.mjs` — `language: a first visit opens in Tamil`, `a fresh browser context starts in Tamil`; Tamil round-trips in `brief-e2e.mjs` (`pooja row stored with Tamil name intact`, `the event is public with Tamil intact`), `registration-api.mjs`, `live-api.mjs` |
| E2E-004 | Language switching works | Covered | `public-e2e.mjs` — `language toggle switches <html lang>`, `the choice is stored as temple:lang`, `switching in one tab updates the other` |
| E2E-005 | Announcement displays | Covered | `brief-e2e.mjs` — `E2E-020 the announcement is in the public feed` (`/api/announcements`); `public-content-ui.mjs` — `E2E-020 (en)` / `(ta): today's notice is in the home page's notice band by its title`, the band labelled for screen readers, its scrolling copy hidden from them |
| E2E-006 | Upcoming pooja displays | Covered | `brief-e2e.mjs` — `E2E-006 an upcoming pooja is shown and every date is today or later` (`/api/homepage_widgets`) |
| E2E-007 | Expired pooja is excluded | Covered | `brief-e2e.mjs` — `E2E-007 the expired Pournami is not shown as upcoming` (a calendar card still linked to a past pooja); since migration 024 also `a manual card linked to a past pooja never publishes it` (D-027) |
| E2E-008 | Next pooja automatically selected | Covered | `brief-e2e.mjs` — `E2E-008 the stale calendar card was re-pointed at the next valid Pournami-first pooja` (compared with the ordering rule in `api/homepage_widgets.php`); `a second stale calendar card is re-pointed as well` |
| E2E-009 | Sponsor shown when consent enabled | Covered | `sponsors.mjs` — `/api/donors shows the sponsor under the family name`, `manually linked card shows the family name`, `zero-widget fallback attaches the consented sponsor`; `public-hardening.mjs` — `the linked sponsor card shows the sponsor's name`, `the sponsor object holds only name and note`, `donors lists the pledge with consent` |
| E2E-010 | Sponsor hidden without consent | Covered | `sponsors.mjs` — `/api/donors omits an active sponsor without consent`, `hidden sponsor with consent leaves /api/donors`, `withdrawn consent removes the sponsor from /api/donors`, `phone, email, amount, reference and status never reach /api/donors`; `public-hardening.mjs` — `donors does not list the pledge with <consent off>`, `does not list a row that never gave consent`, `no phone digits or phone key anywhere in the body` |
| E2E-011 | Admin login succeeds | Covered | `admin-auth.mjs`, `admin-roles.mjs`, `admin-smoke.mjs` (sign-in → dashboard); `brief-e2e.mjs` `admin signed in` |
| E2E-012 | Invalid admin login rejected | Covered | `admin-auth.mjs` — `E2E-012 wrong password is rejected`, lockout after ten failures (`10th failure reports the account is locked`, `correct password is refused while locked`) |
| E2E-013 | Unauthorized role rejected | Covered | `admin-auth.mjs` — `E2E-013 <page> → admin/editor/finance/viewer 200/403…` for every admin page; `admin-roles.mjs` — `editor is refused the users page with an explanation`; `audit-log.mjs` — `E2E-013 <role> gets 403 on the audit page`, `E2E-046 <role> cannot export the CSV`; `cms-settings.mjs` — Pages and Nalla Neram open for editors, SEO and Languages for admins, Roles for everyone, 403 otherwise |
| E2E-014 | Admin creates pooja | Covered | `brief-e2e.mjs` — `E2E-014 …` (validation of missing fields and impossible dates, create, list in both languages) |
| E2E-015 | Admin edits pooja | Covered | `brief-e2e.mjs` — `E2E-015 edit persisted; other columns kept`, `edit did not create a duplicate` |
| E2E-016 | Admin archives pooja | Covered | `brief-e2e.mjs` — `E2E-016 toggle hides the pooja`, `a hidden pooja leaves the public feed`, `the list marks it Hidden` (the product archives by hiding: `is_active = 0`) |
| E2E-017 | Admin creates event | Covered | `brief-e2e.mjs` — `E2E-017 admin created an event`, `an event without a date is refused`; `content-bilingual.mjs` — event create with type, featured, last day, times, venue, picture and bilingual description, eight validation refusals |
| E2E-018 | Event displays publicly | Covered | `brief-e2e.mjs` — `E2E-018 the event is public with Tamil intact` (`/api/events?upcoming=1`); `public-e2e.mjs` events filtering; `content-bilingual.mjs` — `?upcoming` / `?past` / `?featured` / `?type`, `GET /api/events/{id}` 200 / 404, the `/events/<id>` preview, status and sitemap entry |
| E2E-019 | Admin creates announcement | Covered | `brief-e2e.mjs` — `E2E-019 admin created an announcement`, `an announcement without a title is refused`; `content-bilingual.mjs` — create / edit / hide / delete in both languages with a publish window |
| E2E-020 | Announcement appears on homepage | Covered | `public-content-ui.mjs` — a notice published today reaches the home page through the real `/api/announcements?limit=3`: `E2E-020 (en): today's notice is in the home page's notice band by its title`, the same in Tamil, and `the hidden, future and expired notices are not on the page`; the feed itself in `brief-e2e.mjs` (E2E-020) and `content-bilingual.mjs` (future, expired and hidden notices stay out) |
| E2E-021 | Gallery image upload | Covered | `brief-e2e.mjs` — `E2E-021 stored under a random name with the decoded type's extension`, `file is on disk`, `the stored name never comes from the upload`; `gallery.mjs` — uploads of a GD-drawn PNG and JPEG stored under a random name with 480 px thumb and 1280 px medium copies (WebP where GD can write it, else JPEG; never upscaled) |
| E2E-022 | Gallery image displays | Covered | `brief-e2e.mjs` — `E2E-022 the photo is in the public gallery feed`, `the photo is served as an image`; `public-e2e.mjs` `/gallery` route checks; `gallery.mjs` — `/api/gallery` and `/api/gallery/albums` shapes, `?album=`, `?limit=`, hidden photos / albums left out |
| E2E-023 | Invalid gallery upload rejected | Covered | `brief-e2e.mjs` — `E2E-023 a PHP file with an image name and MIME is refused`, `an unsupported image type is refused`, `refused uploads created no rows`; `uploads never execute PHP`; `gallery.mjs` — disguised PHP and GIF refused, junk parameters 422 |
| E2E-024 | Admin creates livestream | Covered | `admin-live.mjs` — `create → 303 with the flash Created.`, `status, provider and the parsed video id…`, timezone/schedule checks, the Pooja / Event selects; `live-links.mjs` — a stream created with `pooja_id` and `event_id` stores both |
| E2E-025 | Upcoming livestream appears | Covered | `live-ui.mjs` — `the upcoming grid…` card links to the scheduled broadcast `…with its Scheduled` label; `live-api.mjs` — `exactly live, upcoming, now, next, server_time` |
| E2E-026 | LIVE indicator appears | Covered | `live-ui.mjs` — `Home LIVE @<w>: LIVE NOW badge…`, `Watch live → the broadcast`; `the hero badge carries the live dot` |
| E2E-027 | YouTube embed displays | Covered (simulated) | `live-ui.mjs` — `/live-darshan @<w>: … .live-player__iframe`, `iframe host is www.youtube-nocookie.com`, `the player box is 16:9`; playback itself is not proven (fixture IDs, no real YouTube) |
| E2E-028 | Ended livestream archives correctly | Covered | `live-archive.mjs` — `saved completed recording appears automatically`, `completed player uses recording rather than live video`, `deleted recordings are hidden`; `live-sync.mjs` LIVE→COMPLETED transitions; `live-links.mjs` — End stream by hand keeps the broadcast's own video as the recording and the archive lists it (D-030) |
| E2E-029 | Donation form validates required fields | Covered | `payments-ui.mjs` — `details, empty Next: name and mobile number are required`, `Proceed without the tick: the terms are required`; `payments-api.mjs` — `a body that is <label> → 422 naming category/amount/name` |
| E2E-030 | Donation transaction is created | Covered | `payments-api.mjs` — attempt `INITIATED`, `attempt_created`/`redirect_issued` audits, `payable_created` |
| E2E-031 | CCAvenue test redirect works | Covered (simulated) | `payments-api.mjs` — gateway URL + `encRequest, access_code` fields, decrypted request field order, redirect/cancel URLs, `the amount sent is the amount stored`; `payments-ui.mjs` — `Redirecting securely to CCAvenue…` |
| E2E-032 | Successful CCAvenue response handled | Covered (simulated) | `payments-api.mjs` — `the donation is SUCCESS with receipt…`, `response_received / verification_ok / status_changed / notification_queued`; `payments-ui.mjs` success screen fields |
| E2E-033 | Failed transaction handled | Covered (simulated) | `payments-api.mjs` — `FAILED` donation/transaction with `gateway_status Failure`, `payment.failed` notification, retry attempts, `the sixth attempt → 409 not_retryable` |
| E2E-034 | Cancelled transaction handled | Covered (simulated) | `payments-api.mjs` — `donation and attempt are CANCELLED`, `no message on CANCELLED`; `payments-ui.mjs` — `Back from the gateway: no 'Redirecting' card` |
| E2E-035 | Duplicate response does not duplicate donation | Covered | `payments-api.mjs` — `a replayed response answers the same 303`, one `donation.paid` row with dedupe key, receipt counter advanced once; `payments-unit.php` idempotency |
| E2E-036 | Successful payment generates receipt | Covered | `payments-api.mjs` — receipt number format, `payment_counters` advanced, receipt endpoint keys/masking; `payments-ui.mjs` — `success: Receipt number…` |
| E2E-037 | Payment confirmation email triggered | Covered (simulated) | `payments-api.mjs` — `donation.paid` notification queued with `to_email`, `its channels follow the settings: email and whatsapp`; delivery through `notify-worker.mjs` / `notify-providers.mjs` to the local stubs only |
| E2E-038 | Contact form succeeds | Covered | `public-e2e.mjs` — `contact: success feedback`, `contact: no console errors`; `brief-e2e.mjs` — `E2E-038 contact form accepts name, email, phone, subject and message`, `E2E-038 email and Tamil subject are stored intact` |
| E2E-039 | Invalid contact form rejected | Covered | `public-e2e.mjs` — `contact: validation errors on empty submit`, `429: contact form shows the friendly message`; `public-hardening.mjs` honeypot and flood limits; `brief-e2e.mjs` — `E2E-039 an invalid email is refused and nothing is stored` |
| E2E-040 | Contact notification generated | Covered (simulated) | `brief-e2e.mjs` — `E2E-040 exactly one office notification is created for the enquiry`, `its email delivery is queued for the worker`, `the alert carries the subject and the message` (server started with `CONTACT_NOTIFY_EMAIL` and the test email driver); wording in `notify-templates-unit.php` (`contact_received …`). Delivery itself goes through `bin/notify_worker.php` like every other email |
| E2E-041 | Mobile navigation works | Covered | `public-e2e.mjs` — `drawer opens (aria-hidden=false)`, `drawer moves focus inside`, `Escape closes drawer`, `focus returns to hamburger after close`; every route @390 |
| E2E-042 | Tablet layout works | Covered | `public-e2e.mjs` — every route `@768` and `@1024`: one h1, no overflow, no console errors, axe; header fit guard; `live-ui.mjs` `/live-darshan @768/@1024`; `payments-ui.mjs`, `notifications-ui.mjs` at 768 |
| E2E-043 | Desktop layout works | Covered | `public-e2e.mjs` — every route `@1440`, header fit at 1920; `live-ui.mjs` @1440 |
| E2E-044 | Invalid URL returns correct 404 | Covered | `seo-crawl.mjs` — unknown SPA route → HTTP 404 + React shell + `X-Robots-Tag: noindex, nofollow`, `an unfurler still gets the 404 preview`, `API 404 stays JSON`; `public-e2e.mjs` — `/admin/ does not render the SPA shell` |
| E2E-045 | Protected API rejects unauthenticated user | Covered | `brief-e2e.mjs` — `E2E-045 admin API answers 401 without a session`, `admin page redirects to sign-in`; `audit-log.mjs` — `E2E-045 audit page redirects to sign-in`, `anonymous CSV export is refused`; `live-api.mjs` 401 paths; `notify-triggers.mjs` / `notifications-api.mjs` — the retired account and inbox routes answer 404 and start no session; `cms-settings.mjs` — every migration-025 page needs a session |
| E2E-046 | RBAC endpoint rejects unauthorized role | Covered | `admin-auth.mjs` — `E2E-046 finance POST to a content page is refused`, `editor POST to settings is refused`, `viewer POST to payments is refused`; `admin-roles.mjs`; `cms-settings.mjs` — the wrong roles are refused on Pages, Nalla Neram, SEO and Languages |
| E2E-047 | SQL injection payload does not execute | Covered | `brief-e2e.mjs` — `E2E-047 …` (search, contact, admin save; payload stored verbatim, `the poojas table is intact`); `search-api.mjs` — `an injection attempt is just a search term`; `admin-hostile-input.mjs`; `cms-settings.mjs` — hostile input on a page stored as text |
| E2E-048 | XSS payload does not execute | Covered | `brief-e2e.mjs` — `E2E-048 admin inbox renders the payload inert`, `admin list escapes it`, `edit form escapes it`, public responses stay JSON; `admin-hostile-input.mjs` reflected-script checks; `og.mjs` / `live-og.mjs` escaped metadata; `cms-settings.mjs` — a script payload on a page is escaped in the list, the form and the API |
| E2E-049 | CSRF protection rejects invalid request | Covered | `brief-e2e.mjs` — `E2E-049 forged token is refused with a message`, `…and nothing was written`, `a missing token is refused too`; `admin-payments.mjs`, `admin-live.mjs`, `admin-notifications.mjs` CSRF cases; `cms-settings.mjs` — a forged token writes nothing on the migration-025 pages |
| E2E-050 | Session logout invalidates admin session | Covered | `admin-auth.mjs` — `E2E-050 old session cookie no longer works after logout`; idle expiry and revocation on disable/delete in the same suite |
| E2E-051 | Result page refresh after payment | Covered (simulated) | `payments-ui.mjs` — reload: same paid state and receipt number; no retry control; one receipt, one gateway response |
| E2E-052 | Gateway timeout handled | Covered (simulated) | `payments-api.mjs` §4n — gateway_status Timeout → FAILED, one payment.failed email, donor may try again |
| E2E-053 | Stale attempt closed by the sweep | Covered | `payments-api.mjs` §5c — INITIATED older than 3 h → CANCELLED with audit; younger untouched |
| E2E-054 | Stale or invalid result link | Covered | `payments-api.mjs` (token under another secret → 404); `payments-ui.mjs` ("could not read" card, no retry, contact the office) |
| E2E-055 | Pooja donation creates one sponsor (brief §13) | Covered (simulated) | `payments-unit.php` §8/§9d; `payments-api.mjs` §4m; `admin-payments.mjs` §9b; `payments-ui.mjs` Pooja sponsorship scenario |
| §32 | Stream linked to a pooja / event | Covered | `live-links.mjs` — the public shape carries `pooja {id, name_ta, name_en, date, time}` and `event {id, title_ta, title_en, date}` with Tamil intact; the sponsor credit names only a consenting, active sponsor (family name over name, never phone, email or amount); deleting the pooja or the event nulls the link and the stream stays; `admin-live.mjs` the Pooja / Event selects; `live-ui.mjs` the links scenario |
| §32 | Unavailable video | Covered (simulated) | `live-links.mjs` — a LIVE / STARTING YouTube row whose last check found the video deleted / private / not embeddable answers `playback.unavailable` with `playback.reason` (`missing` / `restricted`), driven by the simulator's own answers (a video id ending `0404` is missing, `NOEM` not embeddable); `live-health.mjs` deleted / private verdicts |
| §22 | Alt text on gallery images | Covered | `gallery.mjs` — `alt_ta` / `alt_en` on every photo and on an album's cover, per-photo edit of caption / alt text / album / shown; the single-language caption stays the fallback |
| §34 | Image loading (thumbnails) | Covered | `gallery.mjs` — 480 px thumb and 1280 px medium copies made with GD (WebP, or JPEG on a GD without it; never upscaled), `thumb_url` / `medium_url` / `width` / `height` in `/api/gallery`, `?limit=` for the homepage strip, delete removes all three files |

Totals: all 55 numbered cases covered (10 of them against local
simulators), 0 partial, 0 gaps; the four unnumbered §22 / §32 / §34 rows are
covered (one simulated). `node tests/coverage-audit.mjs` holds this: it fails
when a case here is not Covered, and when an API route, an admin page or a
page of the site (read from `backend/api/index.php`, `backend/admin/` and
`frontend/src/App.jsx`) is requested by no suite.

## Running the §30 set

```bash
export DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=templemahendra DB_USER=root DB_PASS=root
node tests/brief-e2e.mjs            # starts its own PHP server; E2E-006…023, 045, 047…049
node tests/admin-auth.mjs  http://127.0.0.1:8000   # E2E-011…013, 046, 050
node tests/public-hardening.mjs http://127.0.0.1:8000   # E2E-009/010, 039
node tests/sponsors.mjs             # starts its own PHP server; sponsors CMS, consent, migration 016, bulk import, RBAC
node tests/videos.mjs               # starts its own PHP server; videos CMS, categories, /api/videos, search, migration 017, RBAC
node tests/calendar-entries.mjs     # starts its own PHP server; Temple Calendar CMS, merge into /api/calendar (add + suppress), migration 018, RBAC
node tests/audit-log.mjs            # starts its own PHP server; Audit Logs page (§28), coverage across modules, filters, CSV, RBAC, proxy IP
node tests/live-health.mjs          # starts its own PHP servers; live health verdicts (deleted/private video, quota, auth, overdue checks), dashboard Live Darshan card (§16, §32), RBAC
node tests/content-bilingual.mjs   # starts its own PHP server; bilingual announcements / events / sevas CMS, publish window, /api/events filters and /api/events/{id}, /events/<id> preview + status + sitemap, migration 020, RBAC
node tests/gallery.mjs               # starts its own PHP server; gallery albums, alt text, GD thumbnails, /api/gallery + /albums, migration 021, RBAC
node tests/live-links.mjs            # starts its own PHP server (:8093) with the YouTube simulator; pooja/event-linked streams, sponsor credit, recording after a manual end, Featured / Show on homepage, unavailable video (§32), migration 022
node tests/cms-settings.mjs          # starts its own PHP server; site settings, Pages CMS, SEO overrides, Nalla Neram, Languages, sidebar groups and dashboard cards, migration 025; E2E-013, 045…049 on the new pages
node tests/seo-crawl.mjs   http://127.0.0.1:8000   # E2E-044
node tests/public-e2e.mjs  http://127.0.0.1:5173   # E2E-001…004, 038/039, 041…043 (PHP + Vite started with --host 127.0.0.1)
node tests/live-ui.mjs && node tests/live-archive.mjs && node tests/admin-live.mjs   # E2E-024…028
node tests/payments-api.mjs && node tests/payments-ui.mjs   # E2E-029…037, 051…055
```

`brief-e2e.mjs` needs the admin account `admin` / `Admin@Test123` (override
with `ADMIN_USERNAME` / `ADMIN_PASSWORD`; it derives `ADMIN_PASS_HASH` for the
server it starts) and cleans every `E2E-BRIEF-<run>` row and upload it wrote.

## Known failures (pre-existing, tracked in `docs/DEFECTS.md`)

- D-014 — resolved: `admin-live.mjs` 240/240 (the column-drift assertion
  waited for a same-second `updated_at`; the axe failure no longer reproduces;
  the oversize upload fixture is now 5 MB + 1 KB). See `docs/DEFECTS.md`.
- D-015 / G-18 — `admin-notifications.mjs`: retired `inapp`/`push` channels; 39/47. Still open (next phase).
- D-017 — `public-e2e.mjs`: 5 header checks expect the retired sign-in/sign-up links. Still open.

None of these change the verdict of a §30 row above; the affected assertions
are not the ones cited.

## Not testable locally (staging / production only)

- Real CCAvenue TEST instruments, settlement, refunds and the dashboard export
  (`CCAvenue-INTEGRATION.md` → *Going live*).
- Real SMTP, SMS DLT and WhatsApp template delivery (only the local stubs and
  `mail.log`).
- Real YouTube Data API answers, OAuth consent, live playback.
- Hostinger: `.htaccess` behaviour under Apache, hPanel environment variables,
  cron, upload permissions, TLS and security headers from the deployed URL.
- Production backup rehearsal on the live database (the procedure was
  rehearsed locally on MySQL 8 with the 47-table schema).

`docs/DEPLOYMENT.md` → *Staging validation* is the checklist for that run;
its result and the production smoke test are recorded there before handover.
