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
| `devotee-auth.mjs` | Devotee accounts and search against the real API: CSRF enforcement, the server-side password policy, single-use tokens, enumeration protection on register/forgot, rate limits, records scoped to their owner, one devotee unable to read another's history, hostile input, and the search endpoint including Tamil queries and LIKE metacharacters — 97 assertions. Reads `backend/logs/mail.log` for the real confirmation and reset links |
| `accounts-ui.mjs` | The account screens in a browser: every new route at 4 widths (h1, overflow, console, axe), the live password checklist, registration, the route guard, the account dashboard and its tabs, profile save, the navbar account menu, sign out, the Ctrl+K palette with keyboard navigation, and the `/search` page — 144 assertions |
| `screenshot.mjs` | Utility: `node screenshot.mjs <url> <out.png> [w] [h] [--login] [--full]` |

```bash
node tests/admin-smoke.mjs http://127.0.0.1:8000
node tests/admin-roles.mjs
node tests/admin-hostile-input.mjs
node tests/admin-bulk-import.mjs
node tests/public-e2e.mjs   http://localhost:5173
node tests/devotee-auth.mjs http://127.0.0.1:8000
node tests/accounts-ui.mjs  http://localhost:5173
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

## Design-system check

Not in this folder because it needs no running server:

```bash
cd frontend && npm run audit
```

Reports undefined CSS custom properties, class names with no rule, opaque raw
colours outside `tokens.css`, and inline styles that are not dynamic values.
