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
```

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
| `deploy/htaccess_public_html` | `public_html/.htaccess`     |
| `deploy/htaccess_api`         | `public_html/api/.htaccess` |

### Step 3 — Database

1. Create database in Hostinger hPanel → Databases → MySQL
2. Import `database/schema.sql` via phpMyAdmin

### Step 4 — Environment variables

Set via Hostinger hPanel → Advanced → PHP Config → Environment Variables,
OR create `public_html/includes/.env` (outside public reach) and load with `putenv()`.

Values needed:

- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`
- `ADMIN_USERNAME`, `ADMIN_PASS_HASH`
- `CORS_ORIGIN` (e.g. `https://www.templemahendra.in`)

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
Login with the credentials set via environment variables.

Pages: Dashboard · Announcements · Sevas · Events · Gallery · Donations · Contact Messages

---

## Security Notes

- Admin is protected by PHP session auth with `password_verify()` (bcrypt)
- All user input is sanitised with `strip_tags` + length limits before DB inserts
- All DB queries use PDO prepared statements — no SQL injection risk
- `config/` and `includes/` folders have `.htaccess` denying direct HTTP access
- File uploads are validated by MIME type, size, and stored with random filenames
- CORS origin is configurable per environment
