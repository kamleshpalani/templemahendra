# Sri Mahendra Temple Website

**Stack:** React 18 + Vite · PHP 8 · MySQL 8 · Custom PHP Admin CMS  
**Hosting:** Hostinger India — Standard Web Hosting

**Node.js + Supabase migration:** An isolated, staging-only Node foundation is
available at the repository root. It does not replace the PHP application or
migrate production data. See [Node staging setup and migration gates](docs/NODE-SUPABASE.md)
before using it on Hostinger Web Apps.

**Documentation:** [DEPLOYMENT.md](docs/DEPLOYMENT.md) (environments, Hostinger
release steps, cron, backups and restore) · [DATABASE.md](docs/DATABASE.md)
(schema, migrations, conventions) · [TESTING.md](docs/TESTING.md) (suites and
the E2E-001…055 matrix) · [CCAvenue-INTEGRATION.md](docs/CCAvenue-INTEGRATION.md) ·
[LIVE-STREAMING.md](docs/LIVE-STREAMING.md) · [DEFECTS.md](docs/DEFECTS.md) ·
[GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md). Detailed specifications live under
`docs/live/`, `docs/payments/`, `docs/notifications/` and `docs/registration/`.

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
extension=gd
```

Then run `php.exe -c php.ini -S 127.0.0.1:8000 router.php` from `backend/`.
Check the driver loaded before blaming the app for a 500:
`php -m | findstr pdo_mysql`.

The gallery's thumbnails need the GD extension (`php -m | grep gd`; every
Hostinger PHP 8 build has it): the copies are WebP when GD can write it
(`imagewebp`), JPEG otherwise. Without GD photos still upload and the site
uses the original file.

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
loopback, so the IPv4 address refuses the connection. The Playwright suites
dial `127.0.0.1`, so before running them start Vite with
`npm run dev -- --host 127.0.0.1` (on Node 24 `--host localhost` binds `::1`
only; see `tests/README.md`).

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
| `backend/bin/*`               | `public_html/bin/` (the cron scripts; they refuse to run over HTTP) |
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

1. Create the database and its user in Hostinger hPanel → Databases → MySQL.
2. For a fresh installation, select that database in phpMyAdmin and import
   `database/schema.sql`. Remove the complete `CREATE DATABASE ...;` and
   `USE templemahendra;` statements from the import copy first: Hostinger uses
   the database name assigned in hPanel, which must also be your `DB_NAME`.
   Skip the schema import when upgrading an existing installation.
3. Run **every** migration in `database/migrations/`, in filename order, against
   the same database. This is required for both fresh installations and
   upgrades: `schema.sql` provides the baseline and does not include all later
   migrations.

| Migration | What it adds |
| --------- | ------------ |
| `001_admin_users.sql` | `admin_users` + `admin_activity` — committee accounts, roles and the audit trail. Skip it and the admin keeps working with the single environment-variable login. |
| `002_contact_messages_index.sql` | An index on `contact_messages.created_at` so the inbox sorts and paginates without a full scan. |
| `003_devotee_accounts.sql` | `devotees`, `devotee_tokens`, `mail_log` and `rate_limits` — public accounts, email confirmation and password reset. It also adds a nullable `devotee_id` to `seva_bookings` and `donations` so a signed-in devotee's records appear in their own history. Skip it and the site simply hides every account entry point; nothing else changes. |
| `004_international_phone.sql` | Phone numbers stored in E.164 form with the country they belong to, on `devotees`, `seva_bookings`, `donations` and `contact_messages`. Devotees live in many countries; the forms no longer assume ten digits. Existing rows are untouched — a number with no country is read as Indian, which is what they always were. |
| `005_devotee_location.sql` | `country`, `state` and `city` on `devotees`. Registration asks for them so the committee can post a receipt; the profile page fills them in for older accounts. |
| `006_devotee_address.sql` | `address1`, `address2` and `postcode` on `devotees` — the postal address an 80G receipt is sent to. The street lines and the PIN are optional and registration does not ask for them; devotees fill them in on their account page and the committee can correct them in the admin. State, city and country are required on both forms, so an account created today always has somewhere a receipt can go. |
| `007_notifications.sql` | The notification service (`docs/notifications/SPEC.md`): `notifications` queue, categories, per-devotee preferences, templates, delivery attempts, tracked links and the unsubscribe keys. Every email, SMS and WhatsApp message the site sends goes through it. |
| `008_donation_public_name.sql` | `donations.show_name_publicly` — the public thank-you list shows a donor's name only when they ticked the box. |
| `009_family_registration.sql` | Family registration replaces devotee sign-in (`docs/registration/SPEC.md`): optional non-unique email, address, language, consent and `family_members`; `duplicate_of` marks a repeated phone number for the committee to merge. |
| `010_payments.sql` | Online payments through CCAvenue (`docs/payments/SPEC.md`): `donation_categories`, `payment_transactions`, `payment_refunds`, `payment_audit_log`, `payment_settings` and `payment_counters`, plus the online-payment columns on `donations` and `seva_bookings`. Pledges and request-only bookings are untouched (`source='pledge'`, `payment_mode='offline'`). |
| `011_live_streams.sql` | Live Darshan, phase 1 (`docs/live/SPEC-PHASE1.md`): seeded `temples` and `deities` tables and `live_streams`, the YouTube Live broadcasts the committee schedules in Admin → Live Streaming and the public sees at `/live-darshan`. |
| `012_live_automation.sql` | YouTube automation settings and stream synchronization fields for the scheduled poller. |
| `013_live_subscriptions.sql` | Per-stream email subscriptions and the live-reminder notification category. |
| `014_live_donations.sql` | `donations.live_stream_id` and its index and foreign key for stream-linked checkout and totals. |
| `015_admin_roles.sql` | Five committee roles (brief §17): widens `admin_users.role` to `owner` / `admin` / `editor` / `finance` / `viewer` and `admin_activity.action` to 60 characters for `session_expired` / `account_locked`. Existing rows keep their values. |
| `016_sponsors_consent.sql` | Sponsor management (brief §11): `family_name`, `email`, `event_id` (FK, `ON DELETE SET NULL`), `amount`, `payment_ref`, `payment_status`, `publish_consent` (defaults to 0 — existing sponsors stay private until an admin grants consent) and `updated_at`. Public APIs only ever show `is_active = 1 AND publish_consent = 1` rows, under the family name when one is set. |
| `017_videos.sql` | Videos module (brief §6): `video_categories` (bilingual names, slug, order, visibility; seeded Poojas / Festivals / Discourses / Darshan recordings) and `videos` (unique 11-character `youtube_id`, bilingual titles and descriptions, `category_id` FK `ON DELETE SET NULL`, optional `live_stream_id` FK to a completed broadcast `ON DELETE SET NULL`, `published_on`, `sort_order`, `is_featured`, `is_active`). Public: `GET /api/videos`, `/videos`. |
| `018_calendar_entries.sql` | Temple Calendar entries (brief §6): `calendar_entries` (`mode` add/hide, `entry_type`, `entry_date`/`end_date` span, bilingual title and description, optional `pooja_id`/`event_id` FKs `ON DELETE SET NULL`, `sort_order`, `is_active`). Merged into `GET /api/calendar`: add-entries join a day's `special[]`, hide-entries remove a computed observance (Pournami, Pradosham, …) the temple does not follow that day. Admin: Temple → Temple Calendar. |
| `019_contact_email_subject.sql` | Contact form (brief §20, §21): `contact_messages.email` and `subject` (both optional — the inbox offers a mailto: link and the office alert quotes them), `updated_at`, and the transactional `office` notification category (inserted only when migration 007's tables exist) through which `contact.received` reaches `CONTACT_NOTIFY_EMAIL`. `POST /api/contact` accepts the two fields. Admin: Communication → Messages shows them. |
| `020_bilingual_content_events.sql` | Bilingual content (brief §6, §7, §25): `announcements.title_ta/title_en`, `body_ta/body_en`, a publish window `start_date/end_date` (only current notices are served) and `updated_at`; `events.description_ta/en`, `event_type` (festival / pooja / special / other), `is_featured`, `end_date`, `start_time/end_time`, `venue_ta/en`, `image_url`, `created_at/updated_at`; `sevas.description_ta/en`, `timing_ta/en`, `is_bookable` (0 = listed, not bookable online), `created_at/updated_at`. The old `title`/`body`/`description` columns are backfilled into both languages, kept in step by the admin pages (English, else Tamil) and still emitted by the APIs for one release. Public: `GET /api/events?past=1\|featured=1\|type=`, `GET /api/events/{id}`, `/events/<id>` (og.php preview, spa.php status, sitemap). Admin: the Announcements, Events and Sevas pages need this migration. |
| `021_gallery_albums.sql` | Photo gallery albums (brief §6, §22, §34): `gallery_albums` (slug, bilingual title and description, optional `event_id` FK `ON DELETE SET NULL`, `cover_image_id` FK to `gallery` `ON DELETE SET NULL`, `sort_order`, `is_active`; seeded Pournami Pooja / Navaratri / Temple Festival / Kumbabhishekam / Annadhanam, listed publicly once they hold a shown photo) and on `gallery`: `album_id` FK `ON DELETE SET NULL`, `alt_ta` / `alt_en`, `thumb_filename` / `medium_filename` (GD-made ~480 px / ~1280 px copies beside the original — WebP when GD can write it, else JPEG), `width` / `height`, `updated_at`. Rows uploaded before the migration keep working (the API falls back to the original file). Public: `GET /api/gallery?album=&limit=`, `GET /api/gallery/albums`, `/gallery?album=<slug>`. Admin: Media → Gallery needs this migration for albums, alt text and thumbnails. |
| `022_live_links.sql` | Live streams that belong to worship (brief §12, §6): `live_streams.pooja_id` / `event_id` (FKs to `poojas` / `events`, `ON DELETE SET NULL`, indexed) — a broadcast belongs to a pooja or an event; the public API adds `pooja`, `event` and the pooja's consenting sponsor (`sponsor {name, note}`). Admin: Media → Live Streaming (the Pooja / Event selects) needs this migration. |
| `023_payments_pooja_sponsor.sql` | Online donations for a pooja (brief §13, §6): `donations.pooja_id` (FK `poojas` `ON DELETE SET NULL`) chosen from `/donate?pooja=<id>` and validated as an active pooja on today or a later date; `sponsors.transaction_id` (FK `payment_transactions`) and `sponsors.donation_id` (FK `donations`, **UNIQUE** — one paid donation can create at most one sponsor, however often CCAvenue repeats itself; both `ON DELETE SET NULL`); donation category `pournami_pooja` ("பௌர்ணமி பூஜை" / "Pournami Pooja"). On a pooja donation's first `SUCCESS` the receipt transaction also writes the sponsor row (name, phone, email, amount, `PAID`, `payment_ref` = receipt number, publish consent = the donor's thank-you-list tick); a full refund marks it `REFUNDED`, nothing deletes it. Admin → Online Payments links the pooja and the sponsor; Admin → Sponsors links the payment. |
| `024_homepage_engine_poojas.sql` | Homepage engine and pooja model (brief §8–§10): `homepage_widgets.content_type` gains `upcoming_event`, `livestream`, `custom`; `source_type` gains `system`; `linked_event_id` / `linked_stream_id` (FKs `ON DELETE SET NULL`), `image_url`, `display_order`. `poojas` gains `start_time` / `end_time` (the free-text `pooja_time` is parsed into `start_time` where it reads as a clock time), `pooja_type` values `pradosham`, `chaturthi` (Sankatahara), `abhishekam`, `archana`, `festival`, `recurrence_type`, `sponsorship_amount`, `sponsorship_available`, `banner_url`, `is_featured`, `live_stream_enabled`, `updated_at`. Public: `GET /api/poojas`. Admin: Content → Homepage (the Upcoming Event and Live Stream cards) and Temple → Poojas ("Generate from Panchangam") need this migration. |
| `025_cms_pages_settings.sql` | The committee edits the site's own facts (brief §3, §15, §25): `site_settings` — one row per key (temple name and descriptor, postal address, phones, e-mail, map search text, opening hours, the daily pooja schedule, today's special by weekday, Nalla Neram, Pournami timing, hero title and lead, introduction, the "coming soon" threshold, social links, the office-alert address and language, the languages offered and the default), `value_ta` / `value_en` for bilingual text and `value` for the rest; a NULL cell means "not edited yet" and the built-in default applies, so an upgraded site looks exactly as it did until someone edits. `pages` — CMS pages (slug, bilingual title, plain-text body, bilingual meta title and description, order, shown/hidden); `mission` and `history` are seeded with empty bodies so the About page keeps its built-in text until the committee writes. `seo_settings` — per-address overrides of the title, description, preview image and `noindex`. Public: `GET /api/pages`, `GET /api/pages/{slug}`, `GET /api/settings` (`site`, `seo`, `languages`); `og.php` and the sitemap honour the overrides, `/api/pulse`, the Panchangam's Nalla Neram and the contact-form alerts read the settings. Admin: Content → Pages, Temple → Nalla Neram, System → Settings / Languages / SEO need this migration and say so until it is applied. |

```bash
for f in database/migrations/*.sql; do mysql --default-character-set=utf8mb4 -u <user> -p <db> < "$f"; done
```

Always pass `--default-character-set=utf8mb4` (or run through phpMyAdmin,
which does): a `latin1` client stores every Tamil seed row as `?` — migrations
007, 010, 011, 013, 017, 019, 021, 023 and 025 all insert Tamil literals
(D-036).

### Live recordings archive (Phase 8)

`/live-darshan/archive` lists completed recordings, with event-type and
temple-local completion-month filters. In the stream editor, enable archive and
save a YouTube recording URL (or let the scheduled poller fill it on completion).
An ended stream without a recording stays off the archive. Clear the recording
or disable archive to remove it and its detail-page playback. The existing
recording column is in migration 011; automatic completion uses migration 012.
No additional worker or migration is needed. See `docs/live/SPEC-PHASE8.md`.

### Step 4 — Environment variables

Set via Hostinger hPanel → Advanced → PHP Config → Environment Variables. That
is the only mechanism the public API reads in production; the repo-root
`.env.local` file is a local-development convenience loaded by
`backend/includes/auth.php` and is not read by the public endpoints. Never
place a file with real credentials under `public_html`.

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
| `ADMIN_IDLE_MINUTES` | Optional. Admin sessions end after this many idle minutes (default 30, max 1440) |
| `ADMIN_IP_LOGIN_ATTEMPTS` | Optional. Failed sign-ins from one client address in 15 minutes, across every username, before that address is refused (default 30) |
| `CORS_ORIGIN`     | Allowed origin, e.g. `https://www.templemahendra.in`     |
| `APP_ENV`         | `production` (the default when unset), `staging` or `development`. Outside development no error detail is shown; errors go to the host's PHP log, else `backend/logs/php-error.log`. `APP_DEBUG=1` only works in development. |

Admin sign-in locks an account for 15 minutes after 10 failed attempts (any
IP, case-insensitive username). A Super Admin issuing a new password from
Committee accounts clears the lock. Thirty failed sign-ins from one client
address in 15 minutes — whatever usernames they try — refuse that address
(`ADMIN_IP_LOGIN_ATTEMPTS`), and the `ADMIN_USERNAME` recovery account's lock
is keyed on the address as well as the name, so a stranger can only ever lock
it for themselves. Roles: `owner` = Super Admin, `admin` =
Temple Admin, `editor` = Content Editor, `finance` = Finance Admin, `viewer` =
read-only; the capability matrix lives in `backend/includes/roles.php`.

Devotee accounts need a few more. They are only read once migration 003 has
been applied; see `backend/.env.example` for the annotated version.

| Variable          | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `SITE_URL`        | Public address of the React site. Confirmation and reset links point here, so it must be exact, including `https`. |
| `MAIL_TRANSPORT`  | `smtp` on Hostinger. `mail` hands off to PHP's `mail()`. Left blank, messages are written to `backend/logs/mail.log` and the site tells the caller that email is unavailable — fine locally, never in production. |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_SECURE` | Mailbox for outgoing mail. `SMTP_SECURE` is `tls` on port 587 or `ssl` on 465. |
| `MAIL_FROM` `MAIL_FROM_NAME` | Sender address and display name. Use a mailbox on your own domain, or the messages will be filed as spam. |
| `CONTACT_NOTIFY_EMAIL` `CONTACT_NOTIFY_LANG` | Where contact-form enquiries are emailed (one address or a comma-separated list) and in which language (`en` default, `ta`). Every enquiry is saved to Admin → Messages regardless; without an address nobody is emailed. Sent through the notification worker like every other email. Since migration 025 both can also be set under Admin → System → Settings → *Office alerts*; an environment value wins over the stored one. |

### Paths that belong to PHP, not to React

`/api`, `/admin` and `/uploads` are served by PHP. Every other path is the React
app. **Three places encode that split, and all three must agree** — miss one and
`/admin/` silently serves the React 404 page on a correctly configured server:

| Where | What it does |
| ----- | ------------ |
| `deploy/htaccess_public_html` | `RewriteRule ^(api\|admin\|uploads)(/.*)?$ - [L]` before the SPA fallback; the fallback itself goes through `api/spa.php`, not straight to `index.html` |
| `frontend/vite.config.js` → `server.proxy` | The same three paths proxied to the PHP dev server |
| `frontend/vite.config.js` → `workbox.navigateFallbackDenylist` | Stops the service worker answering those navigations from the cached `index.html` |

The service-worker entry is the easy one to forget and the hardest to diagnose:
without it the server is right, the `.htaccess` is right, and the committee still
gets the React app at `/admin/`, because the request never leaves the browser.
`tests/public-e2e.mjs` checks the behaviour end to end.

### Crawlers: robots.txt, sitemap.xml and honest 404s

`/robots.txt` and `/sitemap.xml` are generated by `api/robots.php` and
`api/sitemap.php` (the `.htaccess` and `backend/router.php` both route them
there). The sitemap lists every public page in `site_pages.php` except `/search`,
plus one `/live-darshan/<slug>` entry per broadcast that is scheduled, starting,
live or completed and one `/events/<id>` entry per shown event that has not
ended, and leaves out any address the committee marked `noindex` under Admin →
System → SEO; robots disallows `/admin/`, `/api/`, `/search` and the
`/payment/*` pages. Both use `SITE_URL` for the origin.

The SPA fallback (`api/spa.php`) serves the built `index.html` unchanged, but
with the status a crawler should see: `200` for a known page or public broadcast,
`404 Not Found` + `X-Robots-Tag: noindex, nofollow` for anything else — so an
unknown URL is no longer a "soft 404" that search engines index. Browsers still
get the React app and its not-found page either way. `tests/seo-crawl.mjs`
covers all three files against MySQL.

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
| `backend/api/og.php` | Renders a real preview per path — title, description, image, canonical. Reads one seva, photograph, event or public live broadcast for `?seva=`, `?photo=`, `/events/<id>` or `/live-darshan/<slug>` links. |
| `backend/includes/site_pages.php` | The per-page copy og.php uses. The same sentences the React pages pass to `<Seo>`. |
| `deploy/htaccess_public_html` | Sends unfurler user agents to `og.php`. Search engines are deliberately excluded — they run JavaScript and should index the real page. |
| `backend/router.php` | The same diversion locally, so previews can be checked before shipping: `curl -A "WhatsApp/2.23" http://127.0.0.1:8000/sevas?seva=1` |
| `frontend/index.html` | The site-level floor. Every share tag there carries `data-rh="true"` so react-helmet-async **replaces** them instead of appending a second copy — remove the attribute and platforms start showing the generic site blurb on every page. |

`site_pages.php` holds a second copy of each page's title and lead, which is
exactly the kind of thing that drifts. `tests/og.mjs` loads every route in a real
browser, reads the tags React wrote, and fails if they disagree with what
`og.php` returns for the same path — so changing a page's lead tells you to
update the table.

Two things the committee changes without a deploy. **SEO overrides** (Admin →
System → SEO, migration 025) set a per-address title, description, preview
image and robots directive: `og.php` applies them to the preview for that
exact path (in the requested language, falling back to the other), the sitemap
leaves a `noindex` address out, and the React `<Seo>` reads the same rows from
`GET /api/settings`, so the browser tab and the shared card agree; switched
off or deleted, the built-in words from `site_pages.php` return. And every
event has its own address, **`/events/<id>`** (migration 020): `og.php`
previews it with the event's bilingual title, description, dates and picture —
a hidden or unknown id is a 404 / `noindex` preview, never the events list
under a wrong address — `spa.php` answers it with a 200, and the sitemap lists
each event that has not ended.

Live broadcast previews use the saved title, description and thumbnail with
Tamil/English fallback. Draft and deleted broadcasts return 404/noindex;
canonical links omit tracking queries and resolve numeric IDs to the saved
slug. Stream previews cache for 60 seconds and make no YouTube API calls.
Set backend `SITE_URL` and frontend `VITE_SITE_URL` to the same public origin
when overriding the host. See `docs/live/SPEC-PHASE5.md`.

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

### Step 7 — Take the first backup

```bash
DB_HOST=localhost DB_NAME=u123_temple DB_USER=u123_temple DB_PASS='…' \
  deploy/backup.sh --site-root ~/public_html --keep 14
```

That writes a dated folder next to `public_html` (never inside it) holding the
MySQL dump, the uploads folder, the configuration file when one was given with
`--env-file`, and the release commit, with a checksum manifest that `deploy/restore.sh` verifies before it
touches anything. Schedule it nightly and rehearse a restore into an empty
database before handing the site over — the full procedure, and what to do when
the host has no SSH, is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#backups-and-restore).

---

## Online payments (CCAvenue)

Donors can give online at `/donate`, and a devotee can pay for a seva while
booking it, through CCAvenue's hosted checkout (UPI, cards, net banking,
wallets). The pledge form on `/donations` and the "request a booking" path on
`/sevas` keep working exactly as before; online payment sits beside them. Card
and bank details are typed on CCAvenue's page and never reach this server. The
server sends an encrypted order whose amount and currency come from the
database, never from the browser; CCAvenue posts an encrypted result back; the
server decrypts it, checks it against the stored order, confirms it with
CCAvenue's status API when that is configured, and only then marks the payment
SUCCESS and assigns a gap-free receipt number (`TMR-2026-000042`; a payment made
in TEST or SIMULATOR mode is numbered `TEST-…` / `SIM-…` from a sequence of its
own, so the real one never moves and the paper says no money changed hands). The receipt
is a printable page with a QR verification link (`/payment/receipt`), and the
notification worker sends it by email, SMS or WhatsApp. Every rule is in
`docs/payments/SPEC.md`.

Needs migrations `007_notifications.sql` and `010_payments.sql`; pooja
sponsorships also need `023_payments_pooja_sponsor.sql`. Payments stay
**off** until an owner turns them on.

A donor who opens `/donate?pooja=<id>` (the Sponsor button on a pooja) gives
for that pooja: the id is validated as an active pooja on today or a later
date, the purpose is preselected (`pournami_pooja`, else `pooja_seva`), the
review step and the receipt say what the gift is for, and on the first
`SUCCESS` the same transaction that assigns the receipt also writes **one**
sponsor row (`sponsors.donation_id` is unique, so a replayed callback can
never write a second). A full refund marks that sponsor `REFUNDED` — it is
never deleted — and `GET /api/donors` names the pooja rather than the receipt
note and leaves refunded sponsorships out.

### Turning on TEST mode

1. Ask CCAvenue for TEST credentials (Merchant ID, Access Code, Working Key).
   Set `PAYMENTS_SETTINGS_KEY` in the hosting panel so the admin can store them
   encrypted, or put them straight in the environment (`CCAVENUE_TEST_*`) — an
   environment value always wins and the admin shows it as "Set in the server
   environment".
2. Admin → **Payment Gateway** (owner only): paste the TEST credentials, tick
   *Enable online payments*, choose **TEST**, Save. *Test connection* checks the
   keys and the server's IP against CCAvenue's API without taking money.
3. Register the three URLs below in the CCAvenue dashboard for the TEST account.
4. Walk the whole lifecycle with CCAvenue's test instruments (the checklist in
   `docs/payments/SPEC.md` §14). Only then add the production credentials
   (`CCAVENUE_MERCHANT_ID` … or the PRODUCTION block of the same page), set
   `PAYMENTS_SECRET`, and switch the mode to **PRODUCTION**. The page refuses
   the switch until the credentials and the secret are present, the return URLs
   are `https`, and the "lifecycle passed testing" box is ticked.

### Environment variables

Annotated copies of all of these are in `backend/.env.example`.

| Variable | Description |
| --- | --- |
| `CCAVENUE_MERCHANT_ID` `CCAVENUE_ACCESS_CODE` `CCAVENUE_WORKING_KEY` | PRODUCTION checkout credentials. Optional here: an owner can store them from the admin instead (needs `PAYMENTS_SETTINGS_KEY`). |
| `CCAVENUE_TEST_MERCHANT_ID` `CCAVENUE_TEST_ACCESS_CODE` `CCAVENUE_TEST_WORKING_KEY` | TEST credentials, same rule. |
| `CCAVENUE_API_ACCESS_CODE` `CCAVENUE_API_WORKING_KEY` (and `CCAVENUE_TEST_API_ACCESS_CODE` `CCAVENUE_TEST_API_WORKING_KEY`) | Only if CCAvenue issued a separate pair for the server-to-server API (status checks and refunds). Blank = the checkout pair. |
| `CCAVENUE_REDIRECT_URL` `CCAVENUE_CANCEL_URL` `CCAVENUE_NOTIFY_URL` | Overrides of the three return URLs. Leave blank: they are built from `SITE_URL`. |
| `PAYMENTS_SECRET` | At least 32 random characters; signs the links in result pages, receipts and QR codes. Required for PRODUCTION. `php -r "echo bin2hex(random_bytes(24));"` |
| `PAYMENTS_SETTINGS_KEY` | base64 of 32 random bytes; encrypts credentials stored from the admin. Without it the admin cannot store keys. `php -r "echo base64_encode(random_bytes(32));"` |
| `PAYMENTS_CRON_KEY` | At least 24 characters; switches on `/api/payments-cron` for hosts without CLI cron. |
| `NOTIFY_CRON_KEY` | The same for `/api/notify-cron`, the notification worker over HTTP. |
| `PAYMENTS_ALLOW_SIMULATOR` | `1` allows SIMULATOR mode (below). **Never** in production. |
| `CCAVENUE_TRANSACTION_URL` `CCAVENUE_API_URL` `PAYMENTS_SIMULATOR_KEY` `PAYMENTS_SETTINGS_OVERLAY` | Hooks for the test suites: a mock gateway for TEST mode, the simulator's key, and per-process settings. Ignored in PRODUCTION. |

### URLs to register in the CCAvenue dashboard

Admin → Payment Gateway → *CCAvenue dashboard values* shows them ready to copy.

| CCAvenue setting | Address |
| --- | --- |
| Redirect URL | `https://<your-domain>/api/payments/ccavenue/response` |
| Cancel URL | `https://<your-domain>/api/payments/ccavenue/cancel` |
| Dynamic Event Notification (DEN) URL | `https://<your-domain>/api/payments/ccavenue/notify` |

All three are built from `SITE_URL`, must be `https` in PRODUCTION and at most
100 characters. The first two are where the donor's browser lands; the third is
the server-to-server copy CCAvenue sends whether or not the browser comes back.

### API IP whitelisting

Status checks (`orderStatusTracker`) and refunds (`refundOrder`) go from this
server to CCAvenue's API, which only answers whitelisted IP addresses — for TEST
and PRODUCTION separately. Ask CCAvenue to whitelist the site's outbound public
IP. Until then a payment is still recorded on the gateway's callback alone
(`verification = callback`, re-checked by the cron until the API answers),
*Test connection* reports "CCAvenue refused the access code, or this server's
public IP is not whitelisted for API access" (their error 51407), and a refund
sent through the API fails with "ask CCAvenue to whitelist this server's public
IP" — record it as a manual refund after making it in the CCAvenue dashboard.

### Cron jobs (Hostinger: hPanel → Advanced → Cron Jobs, "Custom")

```
*/10 * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/payments_cron.php
*    * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/notify_worker.php
*    * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php
```

The first re-checks open and unverified payments with CCAvenue, closes attempts
that never reached the gateway and expires unpaid seva holds. The second sends
the receipts and payment messages — without it nothing is emailed. The third
follows the temple's YouTube broadcasts (see *Live Darshan → The scheduled
job*). A host without CLI cron can call `GET /api/payments-cron` every 10
minutes, and `GET /api/notify-cron` and `GET /api/live-cron` every minute,
with the key in an `X-Cron-Key` header; each endpoint answers 404 until its
`*_CRON_KEY` is set.

### Local development: the simulator

Start the dev PHP server with `PAYMENTS_ALLOW_SIMULATOR=1` and choose the mode
**SIMULATOR** in Admin → Payment Gateway (or, for one process only,
`PAYMENTS_SETTINGS_OVERLAY='{"enabled":"1","mode":"simulator"}'`). Checkout then
lands on a local page with Pay (UPI) / Pay (Credit Card) / Decline / Cancel /
Awaited / Tamper amount / Wrong currency buttons that answer exactly as
CCAvenue would, the status API is answered locally, and a red "SIMULATOR — no
real money" banner sits on the public result and receipt pages and in the
admin. Without the variable the mode is refused and its routes answer 404, so
it can never be switched on by mistake in production.

### In the admin

- **Online Payments** (`/admin/payments.php`; viewers read and export): Overview
  KPIs (today / this month / this year in IST, domestic and international), the
  Transactions list with filters and a CSV export, a detail view per payment
  (attempts, gateway references, the audit trail, *Resend receipt*, *Check with
  CCAvenue now*, *Mark reviewed*, and for a pooja donation the pooja and the
  sponsor row it created), the Refunds tab and the Reconciliation tab.
  Finance → Sponsors links a payment-made sponsor back to its payment.
- **Refunds** (owners): full or partial, with a reason and a confirmation
  sentence; sent through CCAvenue's `refundOrder` when the API is configured,
  otherwise recorded as a refund already made in the CCAvenue dashboard. The
  payment row is never altered, and the donor gets a refund message.
- **Reconciliation**: paid at CCAvenue but not here, paid here without
  confirmation, needs review, duplicate callbacks, double payments, refund
  mismatches and stale attempts, plus *Run checks now* and an upload of the
  dashboard's CSV order report compared line by line with our records.
- **Donation Categories** (editors): the purposes a donor chooses from, each
  with an optional suggested amount.
- **Payment Gateway** (owners): mode, credentials, currencies, limits, receipt
  prefix, message channels, seva payments and the hold time.

Public endpoints (all under `/api/payments/`): `config`, `donations`,
`seva-bookings`, `retry`, `status`, `receipt`, `receipt-email`, `verify`, the
three `ccavenue/*` return URLs and, in SIMULATOR mode, `simulator` and
`simulator/api`. `GET /api/donors` now lists only pledges and paid online
donations. Before going live, work through `docs/payments/SPEC.md` §14.

---

## Live Darshan (YouTube Live)

Devotees who cannot come to the temple watch its poojas and festivals live at
`/live-darshan`, without signing in. Phase 1 is deliberately small: the
committee schedules a broadcast that it streams from the temple's own YouTube
account (YouTube Studio, a phone, or OBS), pastes the video's link into the
admin, and presses **Go live** when the pooja starts. The website embeds that
video (the privacy-enhanced `youtube-nocookie.com` player), shows the next
scheduled darshan as a poster with its date and time in the temple's own zone,
and lists the upcoming ones. Phase 2 adds the schedule page
(`/live-darshan/schedule`), the countdown to the next darshan and the
homepage block. There are no YouTube API calls in either phase — no keys to
configure, and nothing that can expire. Every rule is in
`docs/live/SPEC-PHASE1.md` and `docs/live/SPEC-PHASE2.md`.

Email reminders additionally require `013_live_subscriptions.sql`, configured
notification email, and `bin/notify_worker.php` running every minute (the
existing notification cron). “Notify me” records consent for one broadcast
without an account. It queues a reminder near the scheduled start, with a
signed unsubscribe link. Unsubscribing is final for that broadcast; reposting
an email cannot undo it. See `docs/live/SPEC-PHASE6.md`.

Needs migration `011_live_streams.sql` (it seeds the temple and its three
deities). Until it is applied the admin page says so and the public page
shows that nothing is scheduled.

### In the admin

Admin → **Live Streaming** (group *Media*; the sidebar's "New live stream"
quick action goes straight to the form). Viewers can read the page, editors
can create, edit, delete, restore and publish.

- **Video** — paste anything YouTube gives you into *Provider video ID*: the
  11-character id itself, a `youtube.com/watch?v=…`, `youtu.be/…`,
  `youtube.com/live/…`, `/embed/…` or `/shorts/…` link. The id is parsed and
  shown back with a "Preview on YouTube" link. The player, the "Watch on
  YouTube" button and the default thumbnail are all built from that id; a
  thumbnail or banner of your own can be uploaded or linked.
- **Schedule** — date, start time and an optional end time (with an end date
  for an overnight stream), in the zone you choose (Asia/Kolkata by default).
  Times are stored in UTC and shown back as the wall clock you typed.
- **Statuses** — `DRAFT` (private; may be saved without a video or a time) →
  `SCHEDULED` (public: the poster and the "upcoming" list) → `STARTING` /
  `LIVE` (the player is mounted) → `COMPLETED` (final). `OFFLINE` and `ERROR`
  mark a broadcast that is on air with trouble; `CANCELLED` is announced as
  such. The row menu offers exactly the changes allowed from the current
  status: **Publish**, **Starting soon**, **Go live**, **Mark offline**,
  **Back live**, **End stream**, **Cancel**, **Reschedule** and **Restore to
  draft**, each with a confirmation. Publish, Starting soon and Go live are
  only offered — and only accepted — once the stream has a video id and a
  start time, so a bare draft cannot reach the public page by accident.
  Going live stamps the actual start, ending stamps the actual end, and every
  change is in the audit log.
- **Address** — the page address (`/live-darshan/<slug>`) is made from the
  English title and can be edited while the stream is a draft; once published
  it is locked, so a link the committee has already shared keeps working.
- **Belongs to** (migration 022) — pick the pooja or the event the broadcast
  is part of (the latest 50 active ones, newest first; a linked one is always
  offered). The public page links to it, and the pooja's sponsor is credited
  by name when the family agreed to be named — never phone, email or amount.
- **Options** — *featured* lists the broadcast first with a gold badge; *show
  on homepage* (off by default) decides whether it fills the homepage block
  and the hero row — a stream with the switch off stays on `/live-darshan` and
  the schedule; *donations*, *notifications*, *sharing* and *archive* switch
  on the Donate button, the Notify-me form, the share button and the
  recording (see the phases below).

A scheduled darshan whose start time has passed stays on the public page for
three hours (or until its end time) with "Starting shortly", so a committee
member who is late pressing Go live does not leave devotees looking at an
empty page.

### The public page and API

`/live-darshan` shows the live broadcast if there is one, else the one that is
starting, else the next scheduled one as a poster **with a "Next Live Darshan"
card and a countdown** under it, else a quiet "nothing scheduled" card that
points at the temple's YouTube channel. `/live-darshan/<slug>` is one broadcast
in any public status (drafts and deleted streams are a 404). The page asks the
server again every 30 seconds while a broadcast is live (60 while it is
scheduled), so it notices the stream begin without a reload; it is in Tamil by
default and English after the toggle, like the rest of the site.

| Method | Path | Answers |
| ------ | ---- | ------- |
| GET | `/api/live-streams` | `{ live: [...], upcoming: [...], now, next, server_time }` — what the page and the homepage need in one call (`no-store`). `now` is the featured live broadcast and `next` the first upcoming one, or `null` |
| GET | `/api/live-streams/live` | The LIVE and STARTING broadcasts, most recently started first |
| GET | `/api/live-streams/upcoming?limit=` | SCHEDULED broadcasts that have not ended, soonest first (default 10, max 50; cached for a minute) |
| GET | `/api/live-streams/schedule?filter=&limit=` | The schedule for one filter — `today`, `tomorrow`, `week`, `festivals` or `all` (the default) — as `{ streams, filter, window, counts, server_time }`; default 50 items, max 100; cached for 30 seconds. See *The schedule page* |
| GET | `/api/live-streams/<id>` or `/<slug>` | One broadcast; digits are an id, so a slug is never digits only |

### The schedule page, the countdown and the homepage (phase 2)

`/live-darshan/schedule` lists every planned broadcast under five filters —
**Today · Tomorrow · This week · Festivals · All** — each with its count. The
windows are worked out on the server, on the temple's own clock
(Asia/Kolkata), so a devotee abroad sees the same "today" as one in
Pudupatti: a day runs from midnight to midnight IST, *This week* is today
through the coming Sunday, *Festivals* is the festival, procession and
special-event programmes of the next 90 days, and *All* is everything from
today for 90 days plus anything on air. A broadcast that ended today stays
on today's list marked *Ended*, a cancelled one leaves the schedule, and one
that is live now leads every list it belongs to. Cards are grouped by day ("Live now", "Today · …", "Tomorrow · …",
then the weekday and date) and show the title, temple, deity, programme,
date, time, thumbnail and status; a card within the next day counts down in
minutes. On a phone the five filters wrap into two rows, so the chosen one is
never off the edge. The chosen filter is in the address (`?filter=week`), and
the Share button hands out that same address, so a link to a particular list
can be shared; switching a filter keeps the list that is on screen (dimmed)
until the new one arrives, rather than blanking it. Each empty filter offers
the next wider one ("No live darshan today — see this week's schedule"), except
on a Sunday, when "this week" is that one day and both Today and Tomorrow offer
every upcoming broadcast instead. The page keeps asking while a listed
broadcast is on air (every 30 seconds) or within a quarter of an hour of its
start (every minute), so a *Starting shortly* pill becomes the *Live now* group
without a reload.

The countdown ("Live darshan starts in HH : MM : SS") counts from the
**server's** time, never the phone's clock alone: every answer carries
`server_time`, and the page keeps the difference to its own clock. A broadcast
a day or more away gains a days unit ("07 : 23 : 38 : 52"), so the hour count
never runs into three digits. The digits are decoration for sighted visitors; a
screen reader gets one plain sentence ("Starts in about 1 hour 35 minutes") that
changes once a minute, not once a second. When the instant passes the clock
gives way to "Starting shortly" — the committee is about to press Go live — and
the poster, the hero and the homepage's hero row say it at that same instant,
not at the next poll. Nothing pulses, so a reduced-motion preference has
nothing to still.

The homepage carries the broadcast without ever showing an empty band: while
one is on air, a red **LIVE NOW** card with the title and a *Watch live*
button (which opens the broadcast's page, where the player is); while one is
scheduled, the *Next Live Darshan* card with the day, the time, the countdown
and a *View schedule* button; and nothing at all when neither exists. The
glass panel in the hero gains a matching "Live darshan" row ("LIVE now", or
"Next at 6:30 pm IST") that is hidden when there is nothing to say.

The `provider` seam now has named placeholders — `VimeoProvider` (a numeric
id or a `vimeo.com/…` link) and `AwsIvsProvider` (a channel ARN or an https
`.m3u8` address) — that recognise their reference and are otherwise inert:
neither is configured, neither can be chosen in the admin yet, and neither
plays anything. They are the slots a later phase fills.

Each item carries both titles and descriptions, the temple and deity names in
both languages, the schedule as UTC instants and as the wall clock in its zone,
the thumbnail, and a `playback` descriptor (`kind`, `embedUrl`, `watchUrl`) the
page uses as it is — nothing on the frontend parses YouTube links.

### The admin JSON API

The same operations are available as JSON for scripts and a future mobile
admin, on the admin's own session: sign in through `/admin/login.php`, then
`GET /api/admin/live-streams` — its answer includes a `csrf` token — and send
that token as the `X-CSRF-Token` header (or a `_csrf` field of the body) on
every write.

```
GET    /api/admin/live-streams?f=&q=&sort=&dir=&page=   { streams, total, pages, page, csrf }
GET    /api/admin/live-streams/<id>                      { stream }
POST   /api/admin/live-streams                           201 { stream } | 422 { error, fields }
PUT    /api/admin/live-streams/<id>                      200 { stream } | 422 | 409 (illegal status change) | 404
DELETE /api/admin/live-streams/<id>                      { success: true }  (soft delete)
```

The body uses the form's field names (`title_ta`, `title_en`, `temple_id`,
`provider_reference`, `scheduled_date`, `start_time`, `end_time`, `timezone`,
`status`, the six flags …). A missing field on `PUT` means "unchanged". Refusals
are JSON — `401` without a session, `403` with `code` `csrf`, `forbidden` or
`password_change` — never a redirect, and the same permissions apply as on the
page (`live.view` to read, `live.manage` to write, `live.publish` to change a
status). Uploads go through the page only; the API takes URL fields.

### Before the first broadcast

`frontend/src/data/temple.js` carries the temple's YouTube channel link
(`TEMPLE.youtube.channelUrl`), used by the "YouTube channel" buttons on the
empty page and the homepage tile. The handle in it (`@TempleMahendra`) is a
**placeholder that must be confirmed** with the committee — it is one line to
change.

### The scheduled job (phase 3: YouTube automation)

With migration `012_live_automation.sql` applied, a YouTube Data API key (or
OAuth client) saved on **Admin → YouTube Automation** and its mode set to
*Live*, the site follows YouTube by itself: a stream whose video is about to
start becomes **Starting soon**, one that is broadcasting becomes **Live**
(with `actual_start_at`), and one whose broadcast has ended becomes
**Completed** (with `actual_end_at` and, when the row keeps its archive, the
watch link in `recording_url`). Each of the three moves has its own switch on
that page; a status set by hand is never undone (a backwards move pauses the
row's automation instead), and a video that does not match the row's date is
left alone with a warning. The rules are in `docs/live/SPEC-PHASE3.md` §5–6.

```
*  * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php
```

Run it **every minute**: the job itself decides which rows are due (a live
broadcast is checked about every minute, an upcoming one every few minutes,
nothing at all when no stream is scheduled), so an idle run costs no API
quota. Runs never overlap — the job takes the MySQL advisory lock
`temple_live_cron` and a second copy exits at once with `locked: true`. It
reads `--limit=N` (rows per run, 1–200, default 50), `--max-seconds=N`
(1–300, default 50), `--stream-ids=1,2`, `--dry-run` (calls YouTube, changes
nothing) and `--json`; it exits 0 when there is nothing to do, automation is
off or another run holds the lock, and 1 only for a real error (migration
011 missing, the database down, the run itself failing).

A host without CLI cron calls `GET /api/live-cron` every minute with the key in
an `X-Cron-Key` header (`?key=` also works, but headers stay out of access
logs). Set `LIVE_CRON_KEY` to at least 24 random characters — until then the
route answers 404; a wrong key answers 403 and thirty wrong keys an hour lock
the route for that address. The HTTP answer carries only the counts
(`checked`, `changed`, `started`, `ended`, `errors`, `skipped`, `locked`); the
per-stream detail is on the CLI and on the admin pages (**Run a check now** on
YouTube Automation, **Check now** on a stream). Neither the CLI, the endpoint
nor the error log ever prints a key, a token or a provider URL with one in it.

Later phases add reminders through the notification service, an archive of
past broadcasts, per-stream share previews and other providers (the
`provider` field, the Vimeo and AWS IVS placeholders and the
`StreamingProvider` interface are already in place for that).

---

## API Endpoints

| Method | Path                 | Description            |
| ------ | -------------------- | ---------------------- |
| GET    | `/api/announcements` | Current announcements (inside their publish window) in both languages; the old `title` / `body` keys are still emitted for one release. |
| GET    | `/api/sevas`         | List sevas: bilingual description and timing, `is_bookable` (a seva with `is_bookable = 0` refuses bookings with 422). |
| GET    | `/api/events`        | Shown events, soonest first — without a parameter every one, past included: `?upcoming=1` (last day today or later), `?past=1` (newest first), `?featured=1`, `?type=festival\|pooja\|special\|other` (422 for junk); bilingual description and venue, `event_type`, `end_date`, `start_time` / `end_time`, `image_url`, `is_featured`. |
| GET    | `/api/events/{id}`   | One shown event, or 404 when hidden or unknown. Its page is `/events/<id>`, with its own share preview, SPA status and sitemap entry. |
| GET    | `/api/poojas`        | Active poojas: `?upcoming=1` (default), `?past=1`, `?all=1`, `?type=`, `?featured=1`, `?sponsorship=1` (open for sponsorship — the /sponsorship page), `?limit=`, `?page=`; both languages, `start_time`/`end_time` + display `time`, `sponsorship_amount`, `sponsorship_available`, `banner_url`, `is_featured`, `live_stream_enabled`, the consented sponsor only. |
| GET    | `/api/homepage_widgets` | The homepage cards (§8/§10): every card carries `source_type` (manual / calendar / system), `image_url`, `display_order`; Upcoming Event cards carry `event {...}`, Live Stream cards `stream {...}` with `is_live`; expired poojas are never published; falls back to the next pooja, then the newest announcement, then events. |
| GET    | `/api/gallery`       | Shown photos, newest first. Each carries `caption`, `alt_ta` / `alt_en`, `album_id` / `album_slug`, `url`, `thumb_url` (~480 px), `medium_url` (~1280 px), `width` / `height`, `thumb_width` / `medium_width`. `?album=<slug\|id>` filters, `?limit=1..200` caps (the homepage strip). Photos in hidden albums are not listed. |
| GET    | `/api/gallery/albums` | Shown albums holding at least one shown photo, in display order: `slug`, `title_ta` / `title_en`, `description_ta` / `description_en`, `event_id`, `count`, `cover` (`{id, thumb_url, alt_ta, alt_en, caption, width, height}` — the chosen cover, else the newest photo). |
| GET    | `/api/pages`         | Shown CMS pages in display order (migration 025): `slug`, `title_ta` / `title_en`, meta title and description, `has_body`, `updated_at`. Cached for a minute; an empty list on a database without the migration. |
| GET    | `/api/pages/{slug}`  | One shown page with `body_ta` / `body_en` (plain text; blank lines separate paragraphs), or 404 when hidden or unknown. |
| GET    | `/api/settings`      | The homepage section switches (`show_pournami_section`, `show_nalla_strip`, `show_donor_ticker`) plus, since migration 025, `site` (the public site settings — temple name, address, phones, e-mail, hours, daily schedule, today's special, Nalla Neram, hero copy, social links, …; the office-alert address never leaves the server), `seo` (per-path overrides) and `languages` (`enabled`, `default`). Cached for a minute. |
| GET    | `/api/pulse`         | Live temple status: open / closed, the next pooja of the day, today's special, upcoming events. Since migration 025 the opening hours, the daily pooja schedule and the weekday specials come from the site settings (Admin → System → Settings), with the former built-in figures as defaults. |
| POST   | `/api/donations`     | Submit donation record |
| POST   | `/api/contact`       | Submit a contact message: name, phone and message, optional email and subject. The office is emailed (`CONTACT_NOTIFY_EMAIL`). |
| GET    | `/api/search`        | Site search in Tamil and English: sevas (description, timing), events (description, venue), poojas, current announcements (inside their publish window), gallery captions and alt text, CMS pages and the static pages. `?q=` and an optional `?limit=`. Each hit carries `title_ta` / `title_en`, `snippet_ta` / `snippet_en` (and `snippet`), and its page: `/events/<id>`, `/sevas?seva=<id>` for a bookable seva, `/gallery?photo=<id>`, `/about#mission`. |
| GET    | `/api/og.php`        | The share preview for a path: `?path=/sevas&seva=3`. Returns HTML, not JSON — it is what link unfurlers read. See *Shared links and rich previews*. |
| GET    | `/api/live-streams`  | Live and upcoming YouTube Live broadcasts (`/live`, `/upcoming`, `/schedule?filter=`, `/<id>`, `/<slug>`). See *Live Darshan (YouTube Live)*. |

### Versioned API: `/api/v1` (brief §26)

Every route above is also served under `/api/v1/…` (`/api/v1/events`,
`/api/v1/poojas?upcoming=1`, …), wrapped in the brief's envelope:

```json
{ "success": true,  "data": <the payload above>, "message": "" }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "fields": { "email": "…" } } }
```

Error codes: `VALIDATION_ERROR` (400/409/413/422), `UNAUTHORIZED` (401),
`FORBIDDEN` (403), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405),
`RATE_LIMITED` (429), `SERVER_ERROR` (5xx). Under v1 only, the brief's
resource names are aliases: `/api/v1/home` → `homepage_widgets`,
`/api/v1/streams…` → `live-streams…`, `/api/v1/sponsors` → `poojas`. The
unversioned `/api/*` the React app calls is unchanged byte for byte, and
answers meant for a browser or a provider (CCAvenue return/cancel/notify, the
payment simulator, notification webhooks, tracked links, og.php, sitemap,
robots) are never wrapped. `tests/api-v1.mjs` checks every GET route against
its unversioned twin.

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

The sidebar is grouped the way the brief's §15 lists the CMS
(`adminNavGroups()` in `backend/admin/includes/admin_layout.php`):

| Group | Pages |
| ----- | ----- |
| Overview | Dashboard |
| Content | Homepage (the cards on the public homepage) · **Pages** · Announcements |
| Temple | Deities · Poojas · Sevas · Events · Temple Calendar · **Nalla Neram** |
| Media | Gallery · Videos · Live Streaming · YouTube Automation |
| Finance | Donations · Online Payments · **Receipts** · Sponsors · Donation Categories · Payment Gateway |
| Communication | Notifications · Message Templates · Audiences · Delivery Analytics · Messages |
| Devotees | Family Registrations · Seva Bookings · Bulk Upload |
| System | Users · **Roles** · **Settings** · **Languages** · **SEO** · Audit Logs · My Profile |

The pages in bold arrived with migration 025 (`site_settings`, `pages`,
`seo_settings`); each says so until the migration is applied.

- **Pages** (Content; editors) — the written pages the public site reads:
  slug, Tamil and English title, a plain-text body whose blank lines become
  paragraphs, meta title and description, order, shown / hidden. `mission`
  and `history` are seeded for the About page, which keeps its built-in text
  while their bodies are empty; every page is served by `GET /api/pages` and
  `/api/pages/{slug}`.
- **Nalla Neram** (Temple; editors) — the two auspicious windows per weekday
  that the Panchangam page, the homepage strip and the Nalla Neram cards show,
  with a *Reset to the built-in table* action. A window that ends before it
  starts is refused.
- **Roles** (System; every role can read it) — the capability matrix
  (`ADMIN_ROLE_GRANTS`) as a table, so nobody has to read PHP to know who may
  do what. It is read-only; roles are changed in code.
- **Languages** (System; admins) — which of Tamil and English the site
  offers and which one a first visit opens in. At least one language stays on
  and the default must be among them; the React app reads the answer from
  `GET /api/settings`.
- **SEO** (System; admins) — per-address overrides of the title, description,
  preview image and robots directive (`noindex`) for `og.php`, the sitemap and
  the React `<Seo>`; a duplicate path is refused, and switching an override
  off restores the built-in words.
- **Settings → temple details** (System; admins) — the temple name and
  descriptor, postal address, phones, e-mail and map search text; opening
  hours and the daily pooja schedule typed one line each; today's special by
  weekday; the hero title and lead, the introduction and the "coming soon"
  threshold; social links; and the office-alert address and language. Each
  value is Tamil and English where it is text, blank means "back to the
  built-in default", and the audit row lists only the keys that changed. The
  homepage section switches and the administrator's own account stay on the
  same page.

- **Receipts** (Finance; every role that may read payments) — each receipt
  issued for an online donation or seva booking: receipt and payment numbers,
  donor, purpose in both languages, amount, issue date (IST), tracking id,
  bank reference and mode, status. Search, month / type / status filters,
  totals of the filtered set, a formula-safe CSV (`export`, audited), open
  the printable receipt, open the payment, and **Resend receipt**
  (`payments.manage`, audited) through the payments module.
- **Announce to devotees** (a row action in Live Streaming and Events, for
  roles that may compose notifications) — opens the notification composer
  pre-filled for a scheduled or live broadcast (start time in IST, link to
  its page) or an upcoming event (date, venue, description, link to
  /events/<id>), under an announcement category devotees can switch off. The
  committee chooses the audience and submits, so consent, unsubscribe links
  and the approval threshold apply as to any campaign.
- **Sponsors** — marking a sponsorship PAID (or recording a paid one) sends
  the sponsor one confirmation (`sponsor.confirmed`, e-mail + WhatsApp,
  saying whether the family will be named); a paid online pooja donation does
  the same automatically.

The dashboard adds four cards for the brief's §16: **Next poojas**, **Online
payments · 7 days**, **Latest donations** and **Recent CMS activity**, beside
the existing KPIs, the Live Darshan health card and the bookings list.

Press <kbd>Ctrl</kbd>+<kbd>K</kbd> anywhere in the admin to jump to a page or run
a quick action.

### Accounts and roles

Two kinds of sign-in exist, deliberately:

1. **The environment account** (`ADMIN_USERNAME` / `ADMIN_PASS_HASH`). Always
   works, always an owner, cannot be edited or deleted from the UI. It is the
   recovery login — the site can never lock the committee out.
2. **Committee accounts** in the `admin_users` table (see the migration above),
   created under *Committee Accounts*. Each has a role:

| Role      | Called          | Can do                                                                 |
| --------- | --------------- | ---------------------------------------------------------------------- |
| `viewer`  | Viewer          | Read dashboards, lists and reports; download CSV exports. No changes.   |
| `finance` | Finance Admin   | Donations, sponsors, payments, refunds and receipts. |
| `editor`  | Content Editor  | Content, poojas, bookings, imports, live streams and small notifications. |
| `admin`   | Temple Admin    | Everything above plus settings, notification approval and the audit log — but not accounts or provider/merchant credentials. |
| `owner`   | Super Admin     | Everything, including committee accounts, payment and YouTube credentials. |

The capability matrix is `ADMIN_ROLE_GRANTS` in `backend/includes/roles.php`;
there is no implied hierarchy, a role holds exactly the capabilities listed.

Permissions are enforced centrally in `requireAdminAuth()` (`backend/includes/auth.php`),
which checks the capability needed to *open* a page and, on POST, the capability
needed to *change* it. A page cannot forget to opt in.

There is no self-service password reset: the site sends no email, so a reset
link could not be delivered. Instead an owner issues a new password from
*Committee Accounts*, and the person is forced to choose their own at next
sign-in. If nobody can sign in, update `ADMIN_PASS_HASH` in the hosting panel.

---

## Stream-linked donations

Apply `database/migrations/014_live_donations.sql` after the preceding
migrations. The Live Darshan Donate button carries the stream into checkout.
Admin payment details link back to that stream. Public totals include only
successful production payments, once per donation, less completed refunds;
test/simulator payments are excluded and currencies are shown separately.
See `docs/live/SPEC-PHASE7.md`.

## Security Notes

- Admin is protected by PHP session auth with `password_verify()` (bcrypt)
- Role-based access is enforced in one place (`requireAdminAuth()`), for both
  reading a page and posting to it, so `viewer` accounts are genuinely read-only
- Every admin form carries a per-session CSRF token, checked by `adminCsrfGuard()`
- Sign-ins, failures and account changes are written to `admin_activity`
- Sign-in locks the account for 15 minutes after 10 failures, and refuses a client
  address after 30 failures in 15 minutes across any usernames (the recovery
  account's lock is per address, so it cannot be locked remotely); sessions end
  after `ADMIN_IDLE_MINUTES` idle; `?next=` redirects are restricted to `/admin/`
- All user input is sanitised with `strip_tags` + length limits before DB inserts
- All DB queries use PDO prepared statements — no SQL injection risk
- `config/` and `includes/` folders have `.htaccess` denying direct HTTP access
- Image uploads are verified by **decoding the file** (`getimagesize()`), never by
  the client-supplied `Content-Type`; the stored name and extension are generated
  by the server (`random_bytes` + the detected JPEG/PNG/WebP type), so an
  attacker-chosen filename or extension can never reach `uploads/`
- `deploy/htaccess_uploads` additionally turns the PHP handler off inside
  `public_html/uploads/`, so nothing in that folder can execute
- CORS origin is configurable per environment (set `CORS_ORIGIN` to the site's own origin in production)
- `deploy/htaccess_public_html`, `htaccess_api` and `htaccess_uploads` force
  HTTPS (308 for the API so a POST stays a POST), send HSTS over TLS, a strict
  Content-Security-Policy for the React site (a relaxed one only for `/admin`
  and og.php), `nosniff`, frame, referrer and permissions headers, and deny
  `includes/ config/ bin/ logs/ database/ tests/` and dotfiles, dumps, logs and
  `.env` files; `tests/deploy-config.mjs` checks every rule
- `APP_ENV` keeps error detail off the page outside development
- Public outputs never publish a sponsor's private data: `sponsorPublicSql()`
  requires consent, drops refunded sponsorships and never exposes the payment
  module's bookkeeping note
- The full OWASP Top 10 review, with evidence and the production checklist, is
  in `docs/SECURITY-REVIEW.md`
