---
name: testing-mysql-cms
description: Run templemahendra React/PHP CMS end-to-end tests against MySQL, including limited database privileges and Tamil input.
---

## Local setup
- Use MySQL 8 with `database/schema.sql`; verify container/port and import only into an authorized test database. Do not substitute SQLite.
- PHP needs pdo_mysql and mbstring. From `backend`, run `php -S localhost:8000 router.php` with DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, ADMIN_USERNAME and ADMIN_PASS_HASH. Generate a bcrypt hash of the chosen local test password rather than storing a plaintext admin password.
- Run `npm install` and `npm run dev` from `frontend`. Vite defaults to :5173 and proxies `/api` to :8000.
- Log in at :8000/admin/login.php; admin sidebar exposes Homepage Widgets, Announcements, Settings, Messages and Seva Bookings.

## Runtime checks
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
