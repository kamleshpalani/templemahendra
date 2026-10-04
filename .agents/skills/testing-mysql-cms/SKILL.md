---
name: testing-mysql-cms
description: Run templemahendra React/PHP CMS end-to-end tests against MySQL, including limited database privileges and Tamil input.
---

## Local setup
- Use MySQL 8 with `database/schema.sql`; verify container/port and import only into an authorized test database. Do not substitute SQLite.
- PHP needs pdo_mysql and mbstring. From `backend`, run `php -S localhost:8000 router.php` with DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, ADMIN_USERNAME and ADMIN_PASS_HASH. Generate a bcrypt hash of the chosen local test password rather than storing a plaintext admin password.
- Run `npm install` and `npm run dev` from `frontend`. Vite defaults to :5173 and proxies `/api` to :8000.
- Log in at :8000/admin/login.php; admin sidebar exposes Homepage Widgets, Announcements, Settings, Messages and Seva Bookings.
- The environment blueprint creates a MySQL 8 container named `my8` on host port 3307 (root/root); if it is missing, run `docker ps -a` to find the existing container or `docker run -d --name my8 -e MYSQL_ROOT_PASSWORD=root -p 3307:3306 mysql:8`. After a machine restart, `docker start my8` and inspect tables before importing. Avoid re-importing seed content into preserved fixtures.
- `database/schema.sql` contains `CREATE DATABASE`/`USE templemahendra`, so it always lands in `templemahendra` regardless of the database passed to `mysql`. Import it as-is, then apply every `database/migrations/*.sql` in sorted order to that same database: `for f in database/migrations/*.sql; do mysql --default-character-set=utf8mb4 templemahendra < "$f"; done`. Set `DB_NAME=templemahendra` for the PHP server. To use another test database name, strip the `CREATE DATABASE`/`USE` lines first and pass that name to every import and to DB_NAME.
- Payment and bulk-upload runtime paths also need PHP curl, zip and xml (SimpleXML for .xlsx; `sudo apt-get install -y php8.1-xml`). Restart PHP with the full environment (including ADMIN variables); an existing server might have different credentials.
- Put recordings/logs and important helpers under `/home/ubuntu` when they must survive restarts; `/tmp` may be wiped.

## Expanded application regression
- Admin row actions use `role=menuitem` and often open a second confirmation dialog. Click the confirmation button before checking persistence (for example Go live, End stream, Delete photo, Disable). A menu click alone has not changed anything.
- Committee accounts require a first-sign-in password change. Test a viewer on an allowed data list such as Seva Bookings, not a CMS editing page; deny Users, Settings and Payment Gateway by direct navigation.
- Family registration is passwordless in the current design. Check the registration documentation before planning devotee login/session tests; retired account URLs may redirect to `/register`.
- Compare Pournami's actual pinned content card before/after toggling; the hero's informational "Next Pournami" text is a separate display.
- Use `NOTIFY_ALLOW_TEST_DRIVER=1` and test channel drivers for local sends. Campaign recipients need update consent; an audience count alone does not mean it can receive a campaign. Use only your own QA registrations for consent fixtures.
- Run notification workers scoped to a campaign or explicit notification IDs (`--campaign-id=N` or `--notification-ids=N,M`, with `--skip-reminders`) rather than draining unrelated queues. A subsequent scoped run may finalize a campaign from Sending to Sent. Check both the campaign detail and analytics pages after sending.
- CCAvenue and YouTube stand-ins live in `tests/support/ccavenue_mock.mjs` and `tests/support/youtube_mock.mjs`; use invented test credentials and distinguish mock acceptance from real settlement/playback. Test-driver acceptance is not provider delivery confirmation.

## Runtime checks
- For auth/RBAC testing, use uniquely named committee accounts per role and complete their first-sign-in password change through My Profile. At desktop widths the New account form is already visible; the New account drawer-toggle button may be hidden. Role labels in the sidebar are visually uppercased by CSS.
- Test viewer write refusal on an owned Seva Bookings row: choose a different status and click Save, check the POST is403 and the row's stored status is unchanged. Profile/password updates are intentionally available to every role.
- Login has two independent limits: five failures in one session cause a short cooldown; ten failures for the lowercased account name cause the longer account lock. To isolate the account-wide threshold, submit through fresh anonymous browser contexts in groups smaller than five, without altering backend counters. Verify correct-password and uppercase-name refusal, a different account signing in, the activity feed, and owner reset followed by mandatory password change.
- For a short idle test, start a second otherwise-identical PHP server with `ADMIN_IDLE_MINUTES=1` and a separate log. Use an isolated browser context: cookies are host-scoped, not port-scoped. After login, wait over60 seconds without authenticated requests, then click a protected link and verify the expired notice and audit event. A local read-only elapsed-time observer can make the recording interpretable without server traffic.
- Inspect actual login Set-Cookie headers or the browser cookie store without saving cookie values. Expect HttpOnly and SameSite=Lax; Secure is conditional on HTTPS, so local HTTP alone cannot prove the production TLS configuration.
- Existing servers can be reused after verifying their idle setting, DB target and log path. Capture log offsets before testing rather than attributing historical warnings to the current run. Delete only owned accounts via UI confirmations and clean only their named activity/rate-limit rows and owned booking fixtures; preserve unrelated users and services.
- For sponsor privacy, create an owned active sponsor with publish consent off, then grant consent through its list action. Link it to an owned manual Sponsor homepage widget with "Show sponsor details" enabled for a stable bilingual visual check even when the donor ticker is disabled. The link dropdown marks unconsented sponsors; the public card must omit their name until consent is granted.
- Sponsors publish under family name when set and own name otherwise; hiding and consent are independent gates. Verify both public endpoints: donors uses the ticker envelope (`name`, `label`, `pooja`, `type`), while a homepage widget's sponsor contains only `name` and `note`. Check private keys and unique private values, not just rendered text. Derive role expectations from the current capability matrix rather than assuming Content Editor lacks finance access.
- Inline validation may duplicate the same message in a toast. Scope browser assertions to field-error IDs (for example `#s-email-err`, `#s-amount-err`). A malformed email with a dotless domain can exercise PHP's inline validation while passing the browser's basic email-format check. For screenshot evidence after scrolling the React homepage, let its reveal animation settle and inspect the actual captured pixels.
- Verify unique CMS content on the refreshed public homepage after create/update/delete, not merely a successful admin toast. Toggle language via EN to verify English widget fields.
- Settings JSON at `/api/settings` returns booleans. Compare both API state and visible sections after refresh; a successful save alone does not prove frontend visibility.
- To test CREATE-denial tolerance, use a separate PHP server with a MySQL account granted SELECT/INSERT/UPDATE/DELETE only on the test schema. Confirm CREATE TABLE IF NOT EXISTS is actually denied before claiming the exception path was exercised.
- Pournami and Nalla Neram are calendar-derived frontend content, whereas CMS widgets and sponsor/announcement records are database-backed. Do not describe every homepage value as MySQL data.
- Public contact submission should yield a success banner and a matching row in admin Messages. Confirm an actual public booking control exists before promising booking coverage; do not use an API bypass to claim UI end-to-end success.
- Capture PHP output to a log and check warnings/fatals/SQLSTATE after browser flows. Clean up only uniquely identified fixtures; restore settings.

## Tamil input
If native GUI typing drops Tamil characters before save, use UTF-8 clipboard paste (`printf '%s' '...' | xclip -selection clipboard`, then Ctrl+V). Verify the populated input visibly before submitting; tool input loss is not evidence of backend encoding corruption.

- Live health monitoring (dashboard `#live-health` card, `GET /api/admin/live-streams?include=health`, `tests/live-health.mjs`): start PHP with `LIVE_ALLOW_SIMULATOR=1`, a generated base64 32-byte `LIVE_SETTINGS_KEY`, a clearly fake `YOUTUBE_API_KEY` and `LIVE_SETTINGS_OVERLAY='{"mode":"live"}'` (or `{"mode":"off"}` to test the Automation off state; keep the same key). Generate the admin bcrypt hash freshly from the chosen test password rather than trusting a saved hash. Verdicts derive from the migration-012 sync columns, so seed them with `tests/support/live_fixtures.php create-stream -` then `sql` (`{"query":"UPDATE live_streams SET ... WHERE id=?","params":[id]}`); refresh recent timestamps just before checking so a Healthy fixture does not turn stale. The 24 h error counter comes from `admin_activity` `live_sync_error` rows, not from streams with a sync_error.
- The public stream route is `/live-darshan/:slug`; language buttons are in `.lang-toggle` and the OFFLINE/ERROR retry button is Try again / மீண்டும் முயற்சி. Narrow admin tables stack into cards and may keep a small internal horizontal scroll — check descendant text bounds, not only the document width.

## Devin Secrets Needed
No external secrets are needed for a disposable local setup. Obtain authorized local database credentials and choose a test admin password; deployed testing requires the deployment's DB and admin credentials.

## Audit Logs (People → Audit Logs)

- Audit Logs is at People → Audit Logs, with a capability-gated dashboard “CMS audit log” shortcut. The sidebar logo and navigation link can both have the accessible name Dashboard; scope the latter to `.sidebar__link[href="/admin/"]`.
- Verify real CMS mutations before checking their audit rows. Announcement deletion preserves the deleted title in Detail. Pooja visibility changes store `hidden`/`shown`, so search the exact `pooja:<id>` subject to find toggles rather than searching its display name.
- Clicking an actor retains other filters. Clicking an action badge replaces the module filter with an exact action filter; removing that action chip does not restore the prior module. Re-select a module when needed.
- Audit pagination is 50 rows per page. Compare structured timestamp/action/subject/detail values across navigation, not the relative “just now” text.
- Submit filters with native keyboard input and await the resulting document URL/navigation before reading row counts; a pre-existing DOMContentLoaded state alone can still refer to the old page.
- A filtered export downloads `audit-log-YYYY-MM-DD.csv` with a UTF-8 BOM and `id,when,actor,action,subject,detail,ip` headers. Verify downloaded contents and then the newly recorded `Audit exported` action. Check Tamil, exact active filters and sort order.
- At narrow admin breakpoints, tables may become labeled stacked cards rather than staying horizontally scrollable columns. Inspect actual screenshots and all six audit fields; assert bounded document width and usable controls rather than requiring a particular overflow mechanism.
- Viewer denial of the page and CSV generates expected browser403 resource messages. Separate those intentional RBAC responses from unexpected console/page/PHP errors.
- For scoped cleanup, retain the initial audit maximum ID, record exact newly owned subjects/IDs, delete fixtures through their CMS confirmations, then remove only those owned audit IDs. Preserve unrelated audit history and compare original account/content hashes.
- Sign in as the env owner by exporting ADMIN_USERNAME and ADMIN_PASS_HASH to the PHP server; do not assume that account also exists in `admin_users`. `tests/audit-log.mjs` shows the exact server invocation (it also sets TRUSTED_PROXIES=127.0.0.1 so `X-Forwarded-For` becomes the audited IP).

## Full-cycle browser testing notes

## Browser harness isolation
- If trusted-proxy test IPs isolate contact/payment/login limits, add X-Forwarded-For only to local application requests. A context-wide extra header also reaches Google Fonts and third-party players and can manufacture CORS failures. Separate harness noise from product errors and rerun affected checks after correcting instrumentation.
- Record response status for permission checks: a valid HTTP 403 page may say "You do not have access" without the literal number 403.
- Inspect actual row menu labels: Committee Accounts uses "Delete account", unlike generic "Delete". The confirmation overlay is `[role=alertdialog]` with `[data-act=ok]`.
- Pooja list filters use `when=all`, not the generic `f=all`; include past rows before fixture cleanup.
- Video pages can contain only a featured card and no grid. Target the visible owned title instead of assuming `.videos__grid` exists.

## Full-cycle scope
- Confirm canonical routes from the current router; `/live-darshan` and `/panchangam` are not `/live` and `/calendar`.
- Distinguish unsupported Pages CMS, album editing and recurrence controls from defects in implemented single-photo/widget workflows.
- For linked calendar widgets test both configured and empty widget titles, linked CMS dates/times, synthesized calendar cards and both languages. Widget fallback fields can hide bugs that the explicit-title case misses.
- Check ordinary reload/navigation after CMS edits; a hard refresh can conceal public API cache staleness. Clear an old long-lived cache entry once after a cache-header fix, then use normal navigation for retesting.

## Exact scoped cleanup
- Capture created IDs, original homepage switches, payment references, contact IDs and isolated IP/time windows incrementally in a durable evidence ledger.
- Delete through CMS first. Some stream deletion is soft deletion; distinguish disappearance from physical cleanup.
- Where no UI deletion exists, inspect current foreign keys and use transactional exact-ID cleanup with ownership guards. Payment audit/transaction rows precede their donation; notification delivery/event dependencies may cascade. Never reset receipt counters or truncate shared tables.
- Do not remove concurrent automated-suite E2E fixtures. A separate browser prefix makes ownership unambiguous. Avoid global baseline-count claims while concurrent writers run.
- After a restart use saved evidence to resume remaining work, not recreate already-tested fixtures. Stop/finalize recordings; explicitly disclose any recording recovered from interrupted raw segments.

## Devin Secrets Needed
- No new secret names are required. Use the session-authorized local test owner/database credentials; never write production credentials into the skill or commit temporary login helpers.

## Defect-hunt notes (chatbot, media selectors, Back races)

## Chat and search are separate
- Ctrl+K opens site search. The floating “Open temple assistant” control opens chat.
- Exercise built-in responses without an AI key separately from provider-backed responses. Tamil-script input takes precedence over the language selector. Acronyms, phone numbers and URLs do not alone constitute a second-language translation.
- Do not claim `.env.local` loading was verified when the file is absent. Coordinate isolated configuration fixtures before changing configuration used by concurrent suites.

## Media and list controls
- Completed live recordings keep their poster until “Watch the recording” is clicked; absence of an iframe before that click is expected.
- Distinguish iframe mounting/bounds from provider playback. An unavailable YouTube video does not prove an application player defect.
- Admin Online Payments lives at `/admin/payments.php`. Click its **Transactions** tab to get the searchable transaction list; the default view is Overview.
- Admin pagination links have accessible names **Next page** and **Previous page**.
- Videos can contain separate main and category tables; scope row assertions to the intended table.
- `tests/videos.mjs` asserts `sort_order 1 lists first` against the shared `videos` table; a video created by a concurrent browser run (any `sort_order <= 1`) makes it fail. Run it when no other client is creating videos — it passes 118/118 in isolation.
- At 360 px the gallery lightbox opens from `.gallery-grid img`, the video player from the `/videos` card button, and archive recordings from the **Watch the recording** button; mobile live/archive filter controls stay in the DOM, not behind a drawer.
- Gallery upload validation is shown as field errors and a toast, not necessarily `.alert--error`.

## Browser Back during payment initiation
- With Playwright, use `page.goBack()` for actual browser-history navigation. Page keyboard events for Alt+ArrowLeft may not activate the browser's shortcut.
- To make the in-flight race observable, temporarily use CDP Network latency (for example 1.8 seconds), without mocking the backend response. Record the request, Back start/return, response and final-navigation timestamps.
- Restore latency/throughput and detach the CDP session afterward.
- Count creation requests and exact owned database rows. Back may change the form step while an already initiated payment still proceeds to the gateway; report that behavior explicitly rather than claiming that Back cancels a payment.

## Devin Secrets Needed
- None for rules-only chat and simulator payments.
- A valid provider credential is required for real AI integration testing; use an approved secret binding and never record or print its value.
