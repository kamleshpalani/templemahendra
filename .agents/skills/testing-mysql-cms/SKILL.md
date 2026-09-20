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

## Devin Secrets Needed
No external secrets are needed for a disposable local setup. Obtain authorized local database credentials and choose a test admin password; deployed testing requires the deployment's DB and admin credentials.
