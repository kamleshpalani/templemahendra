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
php -S localhost:8000 -t api   # serves /api/*
```

### Database

```bash
mysql -u root -p < database/schema.sql
```

Copy `backend/.env.example` → `backend/.env` and fill in credentials.

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
3. Import `database/migrations/001_admin_users.sql` to enable committee
   accounts, roles and the admin activity log. This is additive and safe to run
   on an existing database. Skip it and the admin keeps working with the single
   environment-variable login.

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
