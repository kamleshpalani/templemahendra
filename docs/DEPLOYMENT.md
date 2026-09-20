# Deployment

How the site is built, released to Hostinger, kept running, backed up and
restored. `README.md` → *Hostinger Deployment* has the annotated first-install
walk-through and every environment variable; this page is the operational
checklist that sits on top of it. Payments and live streaming have their own
pages: `CCAvenue-INTEGRATION.md`, `LIVE-STREAMING.md`.

## Environments

| Environment | Where | Database | Payments mode | YouTube automation | Purpose |
| --- | --- | --- | --- | --- | --- |
| Local | `php -S 127.0.0.1:8000 router.php` + `npm run dev` | Docker `mysql:8` on 3307 | SIMULATOR (`PAYMENTS_ALLOW_SIMULATOR=1`) | simulator (`LIVE_ALLOW_SIMULATOR=1`) | development, the automated suites |
| Development / Staging | a Hostinger subdomain (`staging.<domain>`) with its own database, the same layout as production | its own MySQL database | TEST credentials from CCAvenue | a real API key against a test channel, or *Off* | rehearsing releases, restores and the brief §38 staging checklist from the deployed URL |
| Production | `www.<domain>` | production database | PRODUCTION (only after the TEST lifecycle passed) | *Live* | the temple's site |

Rules that hold across all of them:

- Configuration is read from **hosting-panel environment variables**
  (hPanel → Advanced → PHP Config → Environment Variables). The repo-root
  `.env.local` is loaded only by `backend/includes/auth.php` for local work and
  is git-ignored; the public API never reads it. Nothing with a real credential
  is ever committed or placed under `public_html`.
- Simulator modes are fenced by `PAYMENTS_ALLOW_SIMULATOR` / `LIVE_ALLOW_SIMULATOR`.
  Neither variable exists on staging or production; without it the mode is
  refused and its routes answer 404.
- Destructive checks (refunds, cancelling streams, restores) are rehearsed on
  staging, never first on production.
- A release is a git tag or commit hash written down in the release log
  (`deploy/backup.sh` records the deployed commit in `release.txt`).

## What is deployed

```
public_html/
├── index.html, assets/, manifest, icons…   ← frontend/dist (npm run build)
├── .htaccess                               ← deploy/htaccess_public_html
├── api/            .htaccess ← deploy/htaccess_api        backend/api/
├── admin/                                                  backend/admin/
├── includes/       .htaccess denies HTTP                   backend/includes/
├── config/         .htaccess denies HTTP                   backend/config/
├── bin/            cron entry points                       backend/bin/
├── logs/           .htaccess denies HTTP, writable         backend/logs/
├── uploads/        .htaccess ← deploy/htaccess_uploads, writable, PHP handler off
└── router.php      dev-server only; harmless if uploaded
```

`api/`, `admin/` and `uploads/` are served by PHP; everything else is the React
app, whose fallback runs through `api/spa.php` so unknown addresses return a
true 404 (README → *Paths that belong to PHP, not to React*).

## Release procedure

Do this on staging first, then repeat on production.

1. **Freeze**: note the commit to release (`git rev-parse --short HEAD`) and
   read `docs/DEFECTS.md` — no open S1/S2.
2. **Back up production** (below). Do not skip this because "it is only
   frontend".
3. **Build**: `cd frontend && npm ci && npm run build`. `npm run build` also
   runs `sync-tokens`, which copies the design-system CSS into
   `backend/admin/assets/ds/`, so build *before* uploading the admin folder.
4. **Migrations**: if `database/migrations/` gained files since the last
   release, import them in numeric order through phpMyAdmin (or `mysql <`)
   into the *production* database *before* uploading the PHP that needs them
   — every migration is idempotent (`CREATE TABLE IF NOT EXISTS`, guarded
   `ALTER`s), and the app tells the admin which one is missing rather than
   crashing. See `DATABASE.md` → *Migrations*.
5. **Upload** in this order so a half-finished upload degrades gracefully:
   `includes/`, `config/`, `bin/`, `api/`, `admin/`, then the contents of
   `frontend/dist/`. Never upload `uploads/` from a machine — it is the site's
   data, not the release's. Keep the four `.htaccess` files if the FTP client
   hides dotfiles.
6. **Environment variables**: add any new variable the release introduced
   (`backend/.env.example` is the annotated list; the PR description names
   them). Changing a variable in hPanel takes effect on the next PHP request.
7. **Cron**: confirm the three jobs are still scheduled (below).
8. **Smoke test** from the deployed URL, not localhost:
   - `/` loads in both languages; `/about`, `/events`, `/live-darshan`, `/donate`
     open directly *and* survive a browser refresh; a typo URL returns HTTP 404.
   - `/api/announcements` and `/api/home` return JSON; `/robots.txt` and
     `/sitemap.xml` carry the real origin.
   - `/admin/` sign-in works; the dashboard's *Live Darshan* card and
     *Online Payments* KPIs render (they fail loudly if a migration is missing).
   - Upload one gallery image, view it publicly, then delete it.
   - `curl -I https://<domain>/` shows `X-Content-Type-Options`, `X-Frame-Options`,
     `Referrer-Policy`; `http://` redirects to `https://` (Hostinger's *Force
     HTTPS* switch; the app itself does not redirect).
   - Payments: `/donate` in TEST mode on staging completes one CCAvenue test
     transaction; on production only *Test connection* on Admin → Payment
     Gateway (no money moves).
   - Send yourself a test email from Admin → Notifications; check it arrives.
9. **Record** the release: commit hash, date, migrations applied, who did it.

### Rollback

Frontend and PHP: re-upload the previous build/commit (keep the last two
`frontend/dist` zips). Database: migrations only add tables and columns and
old code ignores unknown columns, so a code rollback does not need a schema
rollback. If data was damaged, restore the pre-release backup (below) — that
is why step 2 is not optional.

## Cron jobs

hPanel → Advanced → Cron Jobs, *Custom*:

```
*/10 * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/payments_cron.php
*    * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/notify_worker.php
*    * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php
```

Without CLI cron, an external scheduler calls `GET /api/payments-cron`,
`/api/notify-cron` and `/api/live-cron` with the key in `X-Cron-Key`
(`PAYMENTS_CRON_KEY`, `NOTIFY_CRON_KEY`, `LIVE_CRON_KEY`; 404 until set). Each
job takes a MySQL advisory lock so overlapping runs exit immediately. Add the
nightly backup (next section) as a fourth job.

## Security headers and TLS

`deploy/htaccess_public_html` sets `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN` and `Referrer-Policy: strict-origin-when-cross-origin`,
disables directory listings and turns on gzip and long-lived caching for
images. TLS and the HTTP→HTTPS redirect come from Hostinger (free Let's Encrypt
certificate + *Force HTTPS*); the admin session cookie is `Secure` whenever the
request arrived over HTTPS or `X-Forwarded-Proto: https`, `HttpOnly` and
`SameSite=Lax`. HSTS is left to the hosting panel so a certificate mishap
cannot lock devotees out.

## Backups and restore

Brief §40: database, uploaded media, configuration and release reference, with
restore verified before handover.

### What to back up

| Item | Where it lives | Why |
| --- | --- | --- |
| MySQL database | hPanel database | all content, accounts, bookings, payments, receipts, audit log, live schedule |
| `public_html/uploads/` | disk | gallery images, banners, thumbnails — referenced by path from the database, so a database restore without them shows broken images |
| Configuration | hPanel environment variables (or your `--env-file`) | database, admin hash, SMTP, CCAvenue, YouTube and the encryption keys `PAYMENTS_SETTINGS_KEY` / `LIVE_SETTINGS_KEY` — **without those two keys the credentials stored from the admin cannot be decrypted after a restore** |
| Release reference | git commit / tag | so the restored database is paired with the code that wrote it |

### The script

`deploy/backup.sh` does all four in one run and is what the rehearsal below
used. It needs `bash`, `mysqldump`, `tar`, `gzip`, `sha256sum` — all present on
Hostinger's SSH (Business plans and above) and on any Linux/macOS machine.

```bash
# on the host, from the account's home directory (never inside public_html):
DB_HOST=localhost DB_NAME=u123_temple DB_USER=u123_temple DB_PASS='…' \
  ~/repo/deploy/backup.sh --site-root ~/public_html --out ~/backups --keep 14
```

Options: `--env-file PATH` reads `DB_*` from a `KEY=value` file (and archives
that file as `config.tar.gz`, mode 600); `--site-root` is the folder holding
`uploads/`; `--out` defaults to a `backups/` folder *next to* the site root;
`--keep N` prunes to the newest N.

Each run writes `backups/<YYYYmmdd-HHMMSS>/`:

```
db.sql.gz         mysqldump --single-transaction (consistent snapshot, no table locks), utf8mb4
uploads.tar.gz    the uploads folder
config.tar.gz     the env file, if one was given/found
release.txt       git commit + branch, host, PHP and mysqldump versions, database name
MANIFEST.sha256   checksums; restore.sh refuses a folder that fails them
```

The password reaches `mysqldump` through a temporary defaults file, never the
command line. Schedule it nightly as a cron job and copy the folder off the
server (hPanel *File Manager* download, `rsync`, or Hostinger's own daily/weekly
backups as a second copy — they are a good safety net but are not a substitute
for one you have restored yourself).

**Shared plan without SSH:** phpMyAdmin → *Export* → Custom → *SQL*,
*Add DROP TABLE*, *utf8mb4*, gzip — saves `db.sql.gz`; File Manager →
right-click `uploads` → *Compress* → download; copy the environment-variable
screen into your password manager; note the deployed commit. That is the same
four items by hand.

### Restore

Always rehearse into an **empty** database first (staging, or a second
database on the same host) — `deploy/restore.sh` replaces every table in the
target.

```bash
# 1. create an empty utf8mb4 database in hPanel (or reuse staging's)
# 2. restore
DB_HOST=localhost DB_NAME=u123_staging DB_USER=u123_staging DB_PASS='…' \
  ~/repo/deploy/restore.sh ~/backups/20260920-141132 --site-root ~/staging/public_html
```

It verifies `MANIFEST.sha256` (exit 3 on mismatch), prints `release.txt`,
asks you to type the database name (skip with `--yes`), imports the dump,
reports the table count, extracts `uploads/` over the site root (restoring
`uploads/.htaccess` from `deploy/htaccess_uploads` if the archive lacks it),
and tells you where `config.tar.gz` is without extracting it — the target
normally has its own variables; compare them by hand and make sure
`PAYMENTS_SETTINGS_KEY` and `LIVE_SETTINGS_KEY` are the ones the backup was
taken with. `--db-only` / `--uploads-only` restore one half.

Then deploy the commit named in `release.txt` (or newer — migrations are
forward-only), set the environment variables, and run the smoke test above.
Without SSH: phpMyAdmin → *Import* the `.sql.gz`; File Manager → upload and
*Extract* the uploads archive.

### Verifying a restore (rehearsal record)

What "verified" means here, and what was done on 2026-09-20 against the local
MySQL 8 database that runs the full test suites (47 tables, migrations
001–018, Tamil content, 760 audit rows):

1. `deploy/backup.sh` → 47 KB folder with all five files.
2. `deploy/restore.sh … --yes` into a freshly created `tm_restore` database.
3. `information_schema.tables`: 47 tables in both databases.
4. `CHECKSUM TABLE` for every one of the 47 tables: identical in source and
   restored database (byte-for-byte content, including Tamil `name_ta`
   values — checked with `--default-character-set=utf8mb4`).
5. PHP dev server pointed at the restored database: `/api/announcements` 200,
   `/api/sevas` returns the Tamil names, `/admin/login.php` 200, nothing in
   the PHP log.
6. Tampering `release.txt` in the backup folder made `restore.sh` refuse with
   exit 3; `--keep 1` pruned the older folder; `--env-file` archived the file
   as `config.tar.gz` with mode 600.

Repeat the same six steps on the Hostinger staging database before the
production handover and write the date next to the release in the release log.
A backup that has never been restored is a hope, not a backup.

## Staging validation (brief §38)

Run from the staging URL after each release candidate, before production:

- [ ] React routing: direct open + refresh of every top-level route; unknown route → 404
- [ ] `/api/*` JSON; `/api/v1/*` not expected (see `GAP-ANALYSIS.md` G-12)
- [ ] MySQL: dashboard KPIs load; `SHOW VARIABLES LIKE 'character_set_database'` = `utf8mb4`
- [ ] Admin login, idle expiry, lockout after 10 failures, logout invalidates the session
- [ ] Gallery upload (JPEG/PNG/WebP accepted, `.php`/`.svg`/oversize rejected), image served from `/uploads/`, PHP disabled there (`/uploads/x.php` must not execute)
- [ ] Email: a notification reaches a real inbox via SMTP
- [ ] CCAvenue TEST: one success, one failure, one cancel, a duplicate callback (`CCAvenue-INTEGRATION.md` → *Testing*)
- [ ] YouTube: paste a real live/upcoming video, player renders, poller moves the status (`LIVE-STREAMING.md`)
- [ ] SSL valid, `http://` → `https://`, security headers present
- [ ] 360 / 390 / 768 / 1024 / 1366 / 1920 px layouts, Chrome + Firefox + Safari/iOS
- [ ] The automated suites (`TESTING.md`) start their own PHP server and write fixtures, so they run on a machine with SSH access to the **staging database** (`DB_*` pointed at it), never against production; the browser checks above are done by hand from the staging URL
