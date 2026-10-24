# Database

MySQL 8, `utf8mb4` / `utf8mb4_unicode_ci`, InnoDB throughout. The app is
MySQL-only (no SQLite fallback; see `.gitignore`). This page is the map; the
column-level truth is `database/schema.sql` plus `database/migrations/*.sql`,
each of which is commented at the top.

The separate [Node.js/Supabase staging foundation](NODE-SUPABASE.md) has its
own PostgreSQL migrations under `database/postgres/`, currently covering only
five public content tables. They are not replacements for the MySQL baseline
or migrations below, and they do not import existing data.

## Creating and upgrading

```bash
mysql -u root -p < database/schema.sql                                   # baseline (creates the database)
for f in database/migrations/*.sql; do mysql --default-character-set=utf8mb4 -u root -p templemahendra < "$f"; done
```

- A **fresh install applies every migration**, in numeric order, after the
  baseline. `schema.sql` is the original Phase-1 site; everything since
  (accounts, devotees, notifications, payments, live, roles, sponsors, videos,
  calendar, bilingual content, gallery albums, stream links, pooja
  sponsorships, the homepage engine, site settings and pages) lives only in
  migrations. The admin pages check for their tables and say "apply migration
  NNN" instead of crashing when one is missing.
- Apply every migration with **`--default-character-set=utf8mb4`** (phpMyAdmin
  does this by itself). A `latin1` client transcodes the Tamil literals on the
  way in and stores every Tamil seed row as `?`: `007` / `013` / `019`
  (notification categories), `010` / `023` (donation categories), `011`
  (`temples`, `deities`), `017` (video categories), `021` (album titles),
  `025` (page titles), plus a Tamil column comment in `020`. Locally it was
  `011` that arrived as `?` (D-036) — the schema is fine, the data is wrong
  and has to be re-seeded.
- Migrations are **idempotent and forward-only**: `CREATE TABLE IF NOT
  EXISTS`, `INSERT IGNORE` for seeds, `ALTER … MODIFY` for widened enums, and
  guarded column additions, so re-running one is harmless and there are no
  down-migrations. A code rollback never needs a schema rollback (old code
  ignores columns it does not know).
- There is no migration table; the "version" of a database is the highest
  numbered file that has been imported. Keep that number with the release log
  (`DEPLOYMENT.md`).
- On Hostinger import through phpMyAdmin (one file at a time, in order) or
  `mysql` over SSH. The database user needs `CREATE`, `ALTER`, `INDEX`,
  `REFERENCES` for migrations and the ordinary DML privileges plus `LOCK
  TABLES`-free dumps (`--single-transaction`) for backups. The test skill
  (`.agents/skills/testing-mysql-cms/SKILL.md`) records what a limited user
  needs.

Adding a migration: next number, one purpose, header comment with the `mysql`
line, idempotent statements, then a row in the migration table in `README.md`
→ *Step 3 — Database* and a check in the admin page that uses it.

## Migration index

| File | Adds |
| --- | --- |
| `schema.sql` | `announcements`, `sevas`, `poojas`, `events`, `gallery`, `donations`, `sponsors`, `contact_messages`, `homepage_widgets`, `homepage_settings`, `rate_limits` + seed content |
| `001_admin_users.sql` | `admin_users` (committee accounts), `admin_activity` (the audit log) |
| `002_contact_messages_index.sql` | index for the contact inbox |
| `003_devotee_accounts.sql` | `devotees`, `devotee_tokens`, `mail_log`; devotee sign-up/sign-in |
| `004`–`006` | devotee phone (E.164), location, address columns |
| `007_notifications.sql` | the notification service: categories, templates, segments, campaigns (+translations), `notifications`, deliveries (+events), devotee prefs, devices, OTPs, `notification_audit`, worker runs, `notification_kv` |
| `008_donation_public_name.sql` | donor display-name consent |
| `009_family_registration.sql` | `devotee_family_members`, duplicate-account linking (`devotees.duplicate_of`) |
| `010_payments.sql` | CCAvenue: `payment_transactions`, `payment_refunds`, `payment_audit_log`, `payment_counters` (gap-free receipt sequences), `payment_settings` (encrypted credentials), `donation_categories`, `seva_bookings` payment columns |
| `011_live_streams.sql` | `temples`, `deities` (seeded), `live_streams` |
| `012_live_automation.sql` | `live_settings` (encrypted YouTube credentials, mode) and the `sync_*` / provider columns on `live_streams` the poller and health verdicts use |
| `013_live_subscriptions.sql` | `live_stream_subscriptions` + the live-reminder notification category |
| `014_live_donations.sql` | `donations.live_stream_id` |
| `015_admin_roles.sql` | five roles in `admin_users.role`; wider `admin_activity.action` |
| `016_sponsors_consent.sql` | sponsor family name, email, event, amount, payment status, `publish_consent` |
| `017_videos.sql` | `video_categories` (seeded), `videos` |
| `018_calendar_entries.sql` | `calendar_entries` (add/hide observances) |
| `019_contact_email_subject.sql` | `contact_messages.email`, `subject`, `updated_at`; the transactional `office` notification category |
| `020_bilingual_content_events.sql` | bilingual `announcements` (+ publish window), `events` (+ type, featured, span, times, venue, picture), `sevas` (+ timing, `is_bookable`); `created_at`/`updated_at` |
| `021_gallery_albums.sql` | `gallery_albums` (seeded), album / alt-text / image-variant columns on `gallery` |
| `022_live_links.sql` | `live_streams.pooja_id` / `event_id` (FKs `ON DELETE SET NULL`, indexed) |
| `023_payments_pooja_sponsor.sql` | `donations.pooja_id`; `sponsors.transaction_id`, `sponsors.donation_id` (unique); category `pournami_pooja` |
| `024_homepage_engine_poojas.sql` | widget types/links/image/order; typed pooja times, price, flags, recurrence |
| `025_cms_pages_settings.sql` | `site_settings` (one row per key), `pages` (`mission` and `history` seeded), `seo_settings` |

51 tables after `025` (47 after `018`; `021` added `gallery_albums`, `025`
added `site_settings`, `pages` and `seo_settings`). The brief's §25 names
(`users`, `roles`, `audit_logs`, `payment_events`, `receipts`, …) map onto:
`admin_users` + `roles.php` (roles/permissions are code, `ADMIN_ROLE_GRANTS`,
not tables — five roles do not justify three join tables; System → Roles shows
the matrix), `admin_activity` (audit), `payment_audit_log` (payment events),
`receipt_number` / `donation_number` / `order_number` on the paid `donations`
and `seva_bookings` rows with `payment_counters` for the gap-free sequences,
`homepage_widgets` (homepage blocks), `pages` and `seo_settings` (their own
tables since `025`), `site_settings` (the brief's `settings`; `live_settings`
/ `payment_settings` / `homepage_settings` keep the per-module switches and
encrypted credentials), `gallery_albums` + `gallery` (albums / images),
`notifications`.

`gallery` rows belong to an optional `gallery_albums` album (`album_id`, `ON
DELETE SET NULL`), carry bilingual `alt_ta` / `alt_en` (the single-language
`caption` stays the visible label and the alt fallback), the original's
`width` / `height`, and the names of the GD-made `thumb_filename` (~480 px) /
`medium_filename` (~1280 px) copies written beside the original in
`uploads/` (WebP when GD can write it, JPEG otherwise). An album's cover points back at a photo (`cover_image_id`, `ON
DELETE SET NULL`) and optionally at an event. Deleting a photo removes all
three files; deleting an album unfiles its photos.

`site_settings` (`025`) is one row per key — `key_name` is the primary key —
with `value_ta` / `value_en` for bilingual text and `value` for a URL, phone,
e-mail, number or JSON (the opening hours, the daily schedule, today's special
and Nalla Neram are JSON). The catalogue of keys, their kinds and defaults is
`siteSettingCatalogue()` in `backend/includes/site_settings.php`; a NULL cell
means "not edited", so the code's default applies and an upgraded site looks
as it did. `pages` holds the CMS pages: unique `slug`, bilingual `title`,
plain-text `body` (blank lines separate paragraphs), bilingual `meta_title` /
`meta_description`, `sort_order`, `is_active`, `updated_by`; `mission` and
`history` are seeded with empty bodies. `seo_settings` holds one override per
unique `path` (the address without a query string): bilingual `title` /
`description`, `og_image`, `noindex`, `is_active`. All three carry
`updated_at`; `pages` and `seo_settings` carry `created_at` too.

## Conventions

- **Bilingual columns**: `*_ta` / `*_en` pairs (`name_ta`, `title_en`,
  `description_ta`, …). Tamil is stored as `utf8mb4` and the PDO DSN carries
  `charset=utf8mb4`, so the React → API → PHP → MySQL → React round trip is
  byte-exact; `tests/brief-e2e.mjs`, `tests/public-e2e.mjs` and
  `tests/admin-hostile-input.mjs` prove it
  and the backup rehearsal in `DEPLOYMENT.md` re-checks it after a restore.
  Since `020`, the single-language `title` / `body` / `description` columns
  hold the English text (Tamil when there is none) and are kept only for one
  release.
- **Timestamps**: `created_at` (and `updated_at ON UPDATE` where rows change)
  on every table. Live-stream times are stored in **UTC** with the committee's
  zone (`live_streams.timezone`) alongside; payments report in IST at the query layer.
- **Soft state, not deletes**: content has `is_active`; streams, payments and
  bookings have status enums and a history (`admin_activity`,
  `payment_audit_log`). Hard deletes are limited to drafts, contact messages
  and gallery rows whose file is removed with them.
- **Statuses are enums** checked in PHP before they reach SQL; the allowed
  transitions live in code (`backend/includes/live/validate.php`,
  `backend/includes/payments/*`).
- **Money**: `DECIMAL(10,2)` plus a `currency` column; never floats.
- **Uploads**: only the file name / path is stored (`gallery.filename`,
  `gallery.thumb_filename`, `gallery.medium_filename`,
  `live_streams.thumbnail_url`); binaries live in `public_html/uploads/`.
- **Secrets at rest**: `payment_settings` and `live_settings` hold credentials
  encrypted with libsodium `crypto_secretbox` (`sbx1:` prefix) under
  `PAYMENTS_SETTINGS_KEY` / `LIVE_SETTINGS_KEY`. Losing those keys makes the
  rows unreadable — they are part of every backup (`DEPLOYMENT.md` → *What to
  back up*).
- **Idempotency keys**: `payment_transactions.order_id` and `tracking_id` are
  unique, so a duplicate CCAvenue callback updates nothing and creates nothing
  (`CCAvenue-INTEGRATION.md`); `receipt_number`, `donation_number` and
  `order_number` are unique; `videos.youtube_id` and `live_streams.slug` are
  unique; `sponsors.donation_id` is unique (`uniq_sponsor_donation` — one
  sponsor per paid pooja donation, however often CCAvenue repeats itself);
  `gallery_albums.slug`, `pages.slug` and `seo_settings.path` are unique; the
  payable row is locked `FOR UPDATE` inside the callback transaction so two
  callbacks cannot both assign a receipt.
- **Locks**: the three cron jobs take `GET_LOCK('temple_payments_cron' |
  'temple_notify_worker' | 'temple_live_cron', 0)` so overlapping runs exit.

## Foreign keys

`ON DELETE` rule in brackets. `SET NULL` is the default choice: removing a
pooja or event must not erase who sponsored it or what was donated.

| Child → parent | Rule | Why |
| --- | --- | --- |
| `deities.temple_id → temples` | CASCADE | a deity belongs to exactly one temple |
| `live_streams.temple_id → temples` | RESTRICT | the temple row is seeded and must stay |
| `live_streams.deity_id → deities` | SET NULL | |
| `live_stream_subscriptions.live_stream_id → live_streams` | CASCADE | consent is for one broadcast |
| `donations.live_stream_id / category_id / devotee_id` | SET NULL | money records outlive what they were for |
| `videos.category_id / live_stream_id` | SET NULL | |
| `calendar_entries.pooja_id / event_id`, `sponsors.pooja_id / event_id`, `homepage_widgets.linked_pooja_id / linked_sponsor_id`, `seva_bookings.seva_id / devotee_id` | SET NULL | |
| `gallery.album_id → gallery_albums`, `gallery_albums.cover_image_id → gallery`, `gallery_albums.event_id → events` | SET NULL | migration 021: deleting an album unfiles its photos; deleting a photo clears the cover |
| `live_streams.pooja_id → poojas`, `live_streams.event_id → events` | SET NULL | migration 022 (`idx_stream_pooja` / `idx_stream_event`). The public credit joins the pooja's first active sponsor with `publish_consent = 1` (`created_at` order) and exposes name (family name over name) and note only |
| `donations.pooja_id → poojas`, `sponsors.transaction_id → payment_transactions`, `sponsors.donation_id → donations` | SET NULL | migration 023. `donations.pooja_id` is the pooja an online donation sponsors (NULL for a general donation). `sponsors.donation_id` / `sponsors.transaction_id` are set only on rows the payment module created from a paid pooja donation; `uniq_sponsor_donation` guarantees one sponsor per donation. Deleting a pooja nulls both `donations.pooja_id` and `sponsors.pooja_id`; deleting a donation or attempt nulls the sponsor's links and keeps the sponsor |
| `homepage_widgets.linked_event_id → events`, `homepage_widgets.linked_stream_id → live_streams` | SET NULL | migration 024 |
| `payment_refunds.transaction_id → payment_transactions` | RESTRICT | a paid transaction can never be deleted |
| `devotee_* → devotees` (tokens, devices, prefs, OTPs, tags, family members, notifications) | CASCADE | a devotee's data goes with the account |
| `devotees.duplicate_of → devotees` | SET NULL | |
| `notification_deliveries → notifications`, `delivery_events → deliveries`, `campaign_translations → campaigns` | CASCADE | |
| `notifications.campaign_id`, `notification_audit.campaign_id → campaigns` | SET NULL | |

Tables from `schema.sql` (`announcements`, `sevas`, `events`,
`contact_messages`) have no parents; `gallery` gained its album parent in
`021`, and `site_settings`, `pages` and `seo_settings` (`025`) stand alone.

## Indexes

Each migration adds the indexes its queries need; the ones that matter for
the public site are: `live_streams` `idx_status_start (status,
scheduled_start_at)`, `idx_public (deleted_at, status, scheduled_start_at)`,
`idx_home`, `uniq_slug`; `homepage_widgets idx_active_priority (is_active,
priority)`, `idx_widget_order (is_active, is_pinned, priority, display_order)`
(024); `poojas idx_active_date (is_active, pooja_date)` for next-Pournami
selection, `idx_pooja_type_date (pooja_type, pooja_date)` (024, the `?type=`
filter); `events idx_active_date (is_active, event_date)`; `videos
idx_video_public (is_active, category_id, sort_order, published_on)`,
`uniq_video_youtube`; `calendar_entries idx_calendar_entry_active_dates
(is_active, entry_date, end_date)`; `payment_transactions idx_status_created`,
`uniq_order_id`, `uniq_tracking_id`, `idx_review`; `admin_activity
idx_created`, `idx_actor (actor, created_at)`; `notifications idx_claim
(status, next_attempt_at, priority_rank)` for the worker; `announcements
idx_announcement_window (is_active, start_date, end_date)`; `events
idx_event_featured (is_active, is_featured, event_date)`, `idx_event_type
(is_active, event_type, event_date)`; `gallery idx_gallery_album (album_id,
is_active, created_at)`, `gallery_albums uniq_gallery_album_slug`,
`idx_gallery_album_active_sort (is_active, sort_order)`, `idx_gallery_album_event
(event_id)`, `idx_gallery_album_cover (cover_image_id)`; `live_streams
idx_stream_pooja`, `idx_stream_event`; `donations idx_donation_pooja`;
`sponsors uniq_sponsor_donation`, `idx_sponsor_transaction`; `pages
uniq_page_slug`, `idx_page_active_order (is_active, sort_order)`;
`seo_settings uniq_seo_path`. The poller selects
due rows by `sync_enabled` / `next_sync_at` on the small `live_streams` table
without a dedicated index. `EXPLAIN` a new query before adding a table scan to
a public endpoint.

## Backup and restore

See `DEPLOYMENT.md` → *Backups and restore*: `deploy/backup.sh` takes a
`--single-transaction` `mysqldump` (consistent snapshot without locking the
site), `deploy/restore.sh` verifies checksums and imports it. The rehearsal
compared `CHECKSUM TABLE` for all 47 tables before and after.

## Local database for development and tests

```bash
docker run -d --name temple-mysql -e MYSQL_ROOT_PASSWORD=rootpass \
  -e MYSQL_DATABASE=templemahendra -e MYSQL_USER=temple -e MYSQL_PASSWORD=templepass \
  -p 3307:3306 mysql:8 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
docker exec -i temple-mysql mysql -uroot -prootpass < database/schema.sql
for f in database/migrations/*.sql; do docker exec -i temple-mysql mysql -uroot -prootpass templemahendra < "$f"; done
```

The test suites (`TESTING.md`) create their own fixtures with a recognisable
prefix and delete them afterwards; they must never be pointed at production.
