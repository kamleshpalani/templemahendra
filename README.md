# Sri Mahendra Temple Website

**Stack:** React 18 + Vite · PHP 8 · MySQL 8 · Custom PHP Admin CMS  
**Hosting:** Hostinger India — Standard Web Hosting

---

## Project Structure

```
TempleMahendra/
├── frontend/              # React + Vite public website
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/Layout/   # Navbar, Footer
│   │   ├── pages/               # Home, About, Sevas, Events, Gallery, Donations, Contact
│   │   └── services/api.js      # Axios client
│   ├── index.html
│   ├── vite.config.js
│   └── package.json
│
├── backend/               # PHP 8 API + Admin CMS
│   ├── api/               # Public REST endpoints
│   │   ├── index.php      # Front-controller router
│   │   ├── announcements.php
│   │   ├── sevas.php
│   │   ├── events.php
│   │   ├── gallery.php
│   │   ├── donations.php
│   │   └── contact.php
│   ├── admin/             # Protected admin panel
│   │   ├── index.php
│   │   ├── login.php / logout.php
│   │   ├── announcements.php
│   │   ├── sevas.php
│   │   ├── events.php
│   │   ├── gallery.php
│   │   ├── donations.php
│   │   ├── contact_messages.php
│   │   ├── assets/admin.css
│   │   └── includes/admin_layout.php
│   ├── config/
│   │   ├── database.php
│   │   └── config.php
│   ├── includes/
│   │   ├── db.php         # PDO singleton
│   │   ├── helpers.php    # sendJson, sanitize, CORS
│   │   └── auth.php       # Session auth
│   ├── uploads/           # Uploaded gallery images (writable)
│   └── .env.example
│
├── database/
│   └── schema.sql         # Full MySQL schema + seed data
│
└── deploy/
    ├── htaccess_public_html   # Rename to .htaccess in public_html/
    └── htaccess_api           # Rename to .htaccess in public_html/api/
```

---

## Local Development

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173  (proxies /api → localhost:8000)
npm run audit        # design-system check: undefined tokens, orphan classes,
                     # raw colours, stray inline styles
```

The design system lives in `frontend/src/styles/` — read
[`frontend/src/styles/README.md`](frontend/src/styles/README.md) before adding UI.
`npm run sync-tokens` (automatic before `dev` and `build`) copies those
stylesheets to `backend/admin/assets/ds/` so the PHP admin renders from exactly
the same tokens and components.

### Backend (PHP dev server)

```bash
cd backend
php -S 127.0.0.1:8000 router.php
```

**Use `router.php`.** `php -S ... -t api` looks right and is not: it serves only
the `api` folder, so `/admin/` 404s and the API's own front controller never
runs. `router.php` reproduces what `.htaccess` does on Hostinger — `/api/*` to
the front controller, `/admin/*` to the PHP panel, everything else static — and
it refuses `includes/`, `config/` and `logs/` exactly as the server does.

On Windows there is often no `php` on PATH. Download the **Thread Safe** VS16
x64 zip from [windows.php.net/download](https://windows.php.net/download/),
unzip it anywhere, copy `php.ini-development` to `php.ini`, and enable these:

```ini
extension_dir = "ext"
extension=pdo_mysql
extension=mbstring
extension=openssl
extension=curl
extension=fileinfo
extension=zip
```

Then run `php.exe -c php.ini -S 127.0.0.1:8000 router.php` from `backend/`.
Check the driver loaded before blaming the app for a 500:
`php -m | findstr pdo_mysql`.

### Database

```bash
mysql -u root -p < database/schema.sql
for f in database/migrations/*.sql; do mysql -u root -p templemahendra < "$f"; done
```

Or with Docker, which needs nothing installed:

```bash
docker run -d --name temple-mysql -p 3307:3306 \
  -e MYSQL_ROOT_PASSWORD=rootpass -e MYSQL_DATABASE=templemahendra \
  -e MYSQL_USER=temple -e MYSQL_PASSWORD=templepass \
  mysql:8 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
```

Configuration comes from the environment. For local work put it in `.env.local`
at the repo root (git-ignored) and export it before starting PHP, or set the
variables in your shell:

```
DB_HOST=127.0.0.1
DB_PORT=3307
DB_NAME=templemahendra
DB_USER=temple
DB_PASS=templepass
CORS_ORIGIN=*
SITE_URL=http://localhost:5173
ADMIN_USERNAME=admin
ADMIN_PASS_HASH=<php -r "echo password_hash('YourPassword', PASSWORD_BCRYPT);">
```

### Three things that catch people out

**Use `http://localhost:5173`, not `127.0.0.1:5173`.** Vite binds the IPv6
loopback, so the IPv4 address refuses the connection.

**Email is not configured locally, and that is fine.** With `MAIL_TRANSPORT`
unset, confirmation and password-reset messages are written to
`backend/logs/mail.log` instead of being sent, and the site says so rather than
pretending. To confirm an address or reset a password while testing, open that
file and follow the link in the newest entry. The folder is denied over HTTP
because those links are credentials.

**The admin panel is at `/admin/` on the Vite server too** — the dev proxy
passes `/api`, `/admin` and `/uploads` through to PHP, matching production. Sign
in with the `ADMIN_USERNAME` / password above; that account is the fallback that
cannot be deleted, and real committee accounts are created inside the panel.

---

## Hostinger Deployment

### Step 1 — Build React

```bash
cd frontend
npm run build      # outputs to frontend/dist/
```

### Step 2 — Upload files

Upload via Hostinger File Manager or FTP:

| Local path                    | Upload to                   |
| ----------------------------- | --------------------------- |
| `frontend/dist/*`             | `public_html/`              |
| `backend/api/*`               | `public_html/api/`          |
| `backend/admin/*`             | `public_html/admin/`        |
| `backend/config/*`            | `public_html/config/`       |
| `backend/includes/*`          | `public_html/includes/`     |
| `backend/uploads/`            | `public_html/uploads/`      |
| `deploy/htaccess_public_html` | `public_html/.htaccess`         |
| `deploy/htaccess_api`         | `public_html/api/.htaccess`     |
| `deploy/htaccess_uploads`     | `public_html/uploads/.htaccess` |

> `deploy/htaccess_uploads` is **not optional**: it stops Apache executing
> anything inside the visitor-facing uploads folder. Upload it every time you
> recreate `public_html/uploads/`.

> `backend/admin/assets/ds/*.css` is **generated** from `frontend/src/styles/` by
> `npm run sync-tokens` (which `npm run build` runs for you). Always build the
> frontend before uploading the admin so both surfaces ship the same design system.

### Step 3 — Database

1. Create database in Hostinger hPanel → Databases → MySQL
2. Import `database/schema.sql` via phpMyAdmin
3. Run the migrations in `database/migrations/` in order. Each is additive and
   safe to re-run on an existing database; a fresh `schema.sql` install already
   contains them.

| Migration | What it adds |
| --------- | ------------ |
| `001_admin_users.sql` | `admin_users` + `admin_activity` — committee accounts, roles and the audit trail. Skip it and the admin keeps working with the single environment-variable login. |
| `002_contact_messages_index.sql` | An index on `contact_messages.created_at` so the inbox sorts and paginates without a full scan. |
| `003_devotee_accounts.sql` | `devotees`, `devotee_tokens`, `mail_log` and `rate_limits` — public accounts, email confirmation and password reset. It also adds a nullable `devotee_id` to `seva_bookings` and `donations` so a signed-in devotee's records appear in their own history. Skip it and the site simply hides every account entry point; nothing else changes. |
| `004_international_phone.sql` | Phone numbers stored in E.164 form with the country they belong to, on `devotees`, `seva_bookings`, `donations` and `contact_messages`. Devotees live in many countries; the forms no longer assume ten digits. Existing rows are untouched — a number with no country is read as Indian, which is what they always were. |
| `005_devotee_location.sql` | `country`, `state` and `city` on `devotees`. Registration asks for them so the committee can post a receipt; the profile page fills them in for older accounts. |
| `006_devotee_address.sql` | `address1`, `address2` and `postcode` on `devotees` — the postal address an 80G receipt is sent to. The street lines and the PIN are optional and registration does not ask for them; devotees fill them in on their account page and the committee can correct them in the admin. State, city and country are required on both forms, so an account created today always has somewhere a receipt can go. |

```bash
for f in database/migrations/*.sql; do mysql -u <user> -p <db> < "$f"; done
```

### Step 4 — Environment variables

Set via Hostinger hPanel → Advanced → PHP Config → Environment Variables,
OR create `public_html/includes/.env` (outside public reach) and load with `putenv()`.

Values needed:

| Variable          | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `DB_HOST`         | MySQL host from hPanel (usually `localhost`)             |
| `DB_PORT`         | MySQL port (default `3306`)                              |
| `DB_NAME`         | Database name created in hPanel                          |
| `DB_USER`         | Database user                                            |
| `DB_PASS`         | Database password                                        |
| `ADMIN_USERNAME`  | Admin panel login                                        |
| `ADMIN_PASS_HASH` | bcrypt hash of the admin password (see Step 5)           |
| `CORS_ORIGIN`     | Allowed origin, e.g. `https://www.templemahendra.in`     |

Devotee accounts need a few more. They are only read once migration 003 has
been applied; see `backend/.env.example` for the annotated version.

| Variable          | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `SITE_URL`        | Public address of the React site. Confirmation and reset links point here, so it must be exact, including `https`. |
| `MAIL_TRANSPORT`  | `smtp` on Hostinger. `mail` hands off to PHP's `mail()`. Left blank, messages are written to `backend/logs/mail.log` and the site tells the caller that email is unavailable — fine locally, never in production. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_SECURE` | Mailbox for outgoing mail. `SMTP_SECURE` is `tls` on port 587 or `ssl` on 465. |
| `MAIL_FROM` `MAIL_FROM_NAME` | Sender address and display name. Use a mailbox on your own domain, or the messages will be filed as spam. |

### Paths that belong to PHP, not to React

`/api`, `/admin` and `/uploads` are served by PHP. Every other path is the React
app. **Three places encode that split, and all three must agree** — miss one and
`/admin/` silently serves the React 404 page on a correctly configured server:

| Where | What it does |
| ----- | ------------ |
| `deploy/htaccess_public_html` | `RewriteRule ^(api\|admin\|uploads)(/.*)?$ - [L]` before the SPA fallback |
| `frontend/vite.config.js` → `server.proxy` | The same three paths proxied to the PHP dev server |
| `frontend/vite.config.js` → `workbox.navigateFallbackDenylist` | Stops the service worker answering those navigations from the cached `index.html` |

The service-worker entry is the easy one to forget and the hardest to diagnose:
without it the server is right, the `.htaccess` is right, and the committee still
gets the React app at `/admin/`, because the request never leaves the browser.
`tests/public-e2e.mjs` checks the behaviour end to end.

### Shared links and rich previews

Visitors share pages from a `<ShareButton>` — one component, dropped anywhere,
offering WhatsApp, Facebook, LinkedIn, X, email, copy-link and the device's own
share sheet where the browser has one. It takes the page's own title, lead and
URL, so nothing about the site's address or copy is written twice. Each page's
meta tags come from `<Seo>`, the single writer of the document head.

The preview a link shows is a separate problem. WhatsApp, Facebook, LinkedIn and
X fetch the HTML once and **never run JavaScript**, so the React app's own Open
Graph tags are invisible to them: without a server-side answer, every shared link
previews as the same generic page. So:

| Piece | Role |
| ----- | ---- |
| `backend/api/og.php` | Renders a real preview per path — title, description, image, canonical. Reads one seva or one photograph straight from the database for `?seva=` / `?photo=` links. |
| `backend/includes/site_pages.php` | The per-page copy og.php uses. The same sentences the React pages pass to `<Seo>`. |
| `deploy/htaccess_public_html` | Sends unfurler user agents to `og.php`. Search engines are deliberately excluded — they run JavaScript and should index the real page. |
| `backend/router.php` | The same diversion locally, so previews can be checked before shipping: `curl -A "WhatsApp/2.23" http://127.0.0.1:8000/sevas?seva=1` |
| `frontend/index.html` | The site-level floor. Every share tag there carries `data-rh="true"` so react-helmet-async **replaces** them instead of appending a second copy — remove the attribute and platforms start showing the generic site blurb on every page. |

`site_pages.php` holds a second copy of each page's title and lead, which is
exactly the kind of thing that drifts. `tests/og.mjs` loads every route in a real
browser, reads the tags React wrote, and fails if they disagree with what
`og.php` returns for the same path — so changing a page's lead tells you to
update the table.

Set `VITE_SITE_URL` at build time only if the browser cannot see the public
origin (behind a proxy, or a preview build that should advertise the real
domain). Left unset, links use the origin the page was served from, which is
correct everywhere else, local development included.

Two security notes for the shared-hosting upload. `backend/logs/` holds
password-reset links in plain text when email is not configured, and
`backend/includes/` and `backend/config/` are not web entry points. Each has a
`.htaccess` that denies all HTTP access, so **upload the dot-files too** — many
FTP clients hide them by default. `backend/uploads/.htaccess` additionally
turns off script execution in the uploads folder.

The backend is **MySQL-only**. There is no SQLite, MongoDB or Render/Docker
fallback: `backend/includes/db.php` always connects to MySQL using the
variables above. Do not upload `*.sqlite`, `Dockerfile`, `render.yaml` or
`docker-entrypoint.sh` to Hostinger (they are git-ignored).

### Step 5 — Generate admin password hash

```php
php -r "echo password_hash('YourSecurePassword123', PASSWORD_BCRYPT);"
```

Put the output as `ADMIN_PASS_HASH`.

### Step 6 — Set uploads folder permissions

```bash
chmod 755 public_html/uploads
```

---

## API Endpoints

| Method | Path                 | Description            |
| ------ | -------------------- | ---------------------- |
| GET    | `/api/announcements` | List announcements     |
| GET    | `/api/sevas`         | List sevas             |
| GET    | `/api/events`        | List events            |
| GET    | `/api/gallery`       | List gallery images    |
| POST   | `/api/donations`     | Submit donation record |
| POST   | `/api/contact`       | Submit contact message |
| GET    | `/api/search`        | Search sevas, events, poojas, announcements, gallery captions and the static pages. `?q=` and an optional `?limit=`. Answers in both languages. |
| GET    | `/api/og.php`        | The share preview for a path: `?path=/sevas&seva=3`. Returns HTML, not JSON — it is what link unfurlers read. See *Shared links and rich previews*. |

### Devotee accounts

Available once migration 003 is applied. Sessions are an httpOnly cookie; every
state change carries the CSRF token from `/api/auth/me` in an `X-CSRF-Token`
header. Register, forgot-password and resend answer identically whether or not
the address is known, so none of them can be used to find out who has an
account.

| Method | Path                     | Description                                  |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/api/auth/me`           | The signed-in devotee (or `null`), a CSRF token, and whether accounts are switched on |
| POST   | `/api/auth/register`     | Create an account and send a confirmation email |
| POST   | `/api/auth/login`        | Start a session                              |
| POST   | `/api/auth/logout`       | End it                                       |
| POST   | `/api/auth/verify`       | Consume a confirmation token                 |
| POST   | `/api/auth/resend`       | Send the confirmation email again            |
| POST   | `/api/auth/forgot`       | Send a reset link                            |
| POST   | `/api/auth/reset`        | Consume a reset token and set a new password |
| GET    | `/api/account/summary`   | Counts and totals for the dashboard          |
| GET    | `/api/account/bookings`  | The devotee's own seva bookings              |
| GET    | `/api/account/donations` | The devotee's own offerings                  |
| POST   | `/api/account/profile`   | Update name and phone                        |
| POST   | `/api/account/password`  | Change password; the current one is required |

A devotee's history is matched on the account id stamped on a record when it
was created, and never on a phone number. There is no SMS verification here, so
a phone number proves nothing: matching on it would let anyone register with a
neighbour's number and read their donation history.

---

## Admin Panel

Access: `https://yourdomain.in/admin/`

Pages: Dashboard · Homepage Widgets · Announcements · Gallery · Poojas · Sevas ·
Events · Sponsors · Seva Bookings · Donations · Messages · Bulk Upload ·
Settings · Committee Accounts · My Profile

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> anywhere in the admin to jump to a page or run
a quick action.

### Accounts and roles

Two kinds of sign-in exist, deliberately:

1. **The environment account** (`ADMIN_USERNAME` / `ADMIN_PASS_HASH`). Always
   works, always an owner, cannot be edited or deleted from the UI. It is the
   recovery login — the site can never lock the committee out.
2. **Committee accounts** in the `admin_users` table (see the migration above),
   created under *Committee Accounts*. Each has a role:

| Role     | Can do                                                                 |
| -------- | ---------------------------------------------------------------------- |
| `viewer` | Read dashboards, lists and reports; download CSV exports. No changes.   |
| `editor` | Everything a viewer can, plus content, poojas, bookings, donations, bulk imports. |
| `owner`  | Everything, plus committee accounts and system settings.                |

Permissions are enforced centrally in `requireAdminAuth()` (`backend/includes/auth.php`),
which checks the capability needed to *open* a page and, on POST, the capability
needed to *change* it. A page cannot forget to opt in.

There is no self-service password reset: the site sends no email, so a reset
link could not be delivered. Instead an owner issues a new password from
*Committee Accounts*, and the person is forced to choose their own at next
sign-in. If nobody can sign in, update `ADMIN_PASS_HASH` in the hosting panel.

---

## Security Notes

- Admin is protected by PHP session auth with `password_verify()` (bcrypt)
- Role-based access is enforced in one place (`requireAdminAuth()`), for both
  reading a page and posting to it, so `viewer` accounts are genuinely read-only
- Every admin form carries a per-session CSRF token, checked by `adminCsrfGuard()`
- Sign-ins, failures and account changes are written to `admin_activity`
- Sign-in throttles after 5 failures; `?next=` redirects are restricted to `/admin/`
- All user input is sanitised with `strip_tags` + length limits before DB inserts
- All DB queries use PDO prepared statements — no SQL injection risk
- `config/` and `includes/` folders have `.htaccess` denying direct HTTP access
- Image uploads are verified by **decoding the file** (`getimagesize()`), never by
  the client-supplied `Content-Type`; the stored name and extension are generated
  by the server (`random_bytes` + the detected JPEG/PNG/WebP type), so an
  attacker-chosen filename or extension can never reach `uploads/`
- `deploy/htaccess_uploads` additionally turns the PHP handler off inside
  `public_html/uploads/`, so nothing in that folder can execute
- CORS origin is configurable per environment
