# Database

MySQL 8, `utf8mb4` / `utf8mb4_unicode_ci`, InnoDB throughout. The app is
MySQL-only (no SQLite fallback; see `.gitignore`). This page is the map; the
column-level truth is `database/schema.sql` plus `database/migrations/*.sql`,
each of which is commented at the top.

## Creating and upgrading

```bash
mysql -u root -p < database/schema.sql                                   # baseline (creates the database)
for f in database/migrations/*.sql; do mysql -u root -p templemahendra < "$f"; done
```

- A **fresh install applies every migration**, in numeric order, after the
  baseline. `schema.sql` is the original Phase-1 site; everything since
  (accounts, devotees, notifications, payments, live, roles, sponsors, videos,
  calendar) lives only in migrations. The admin pages check for their tables
  and say "apply migration NNN" instead of crashing when one is missing.
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

47 tables after `018`. The brief's §25 names (`users`, `roles`, `audit_logs`,
`payment_events`, `receipts`, …) map onto: `admin_users` + `roles.php`
(roles/permissions are code, `ADMIN_ROLE_GRANTS`, not tables — five roles do
not justify three join tables), `admin_activity` (audit), `payment_audit_log`
(payment events), `receipt_number` / `donation_number` / `order_number` on the
paid `donations` and `seva_bookings` rows with `payment_counters` for the
gap-free sequences, `homepage_widgets` (homepage blocks), `live_settings` /
`payment_settings` / `homepage_settings` (settings), `notifications`.
`gallery` is a flat list (`filename`, `caption`) — the brief's albums are not
modelled; see `GAP-ANALYSIS.md`.

## Conventions

- **Bilingual columns**: `*_ta` / `*_en` pairs (`name_ta`, `title_en`,
  `description_ta`, …). Tamil is stored as `utf8mb4` and the PDO DSN carries
  `charset=utf8mb4`, so the React → API → PHP → MySQL → React round trip is
  byte-exact; `tests/brief-e2e.mjs`, `tests/public-e2e.mjs` and
  `tests/admin-hostile-input.mjs` prove it
  and the backup rehearsal in `DEPLOYMENT.md` re-checks it after a restore.
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
  unique; the payable row is locked `FOR UPDATE` inside the callback
  transaction so two callbacks cannot both assign a receipt.
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
| `payment_refunds.transaction_id → payment_transactions` | RESTRICT | a paid transaction can never be deleted |
| `devotee_* → devotees` (tokens, devices, prefs, OTPs, tags, family members, notifications) | CASCADE | a devotee's data goes with the account |
| `devotees.duplicate_of → devotees` | SET NULL | |
| `notification_deliveries → notifications`, `delivery_events → deliveries`, `campaign_translations → campaigns` | CASCADE | |
| `notifications.campaign_id`, `notification_audit.campaign_id → campaigns` | SET NULL | |

Tables from `schema.sql` (`announcements`, `sevas`, `events`, `gallery`,
`contact_messages`) have no parents.

## Indexes

Each migration adds the indexes its queries need; the ones that matter for
the public site are: `live_streams` `idx_status_start (status,
scheduled_start_at)`, `idx_public (deleted_at, status, scheduled_start_at)`,
`idx_home`, `uniq_slug`; `homepage_widgets idx_active_priority (is_active,
priority)`; `poojas idx_active_date (is_active, pooja_date)` for next-Pournami
selection; `events idx_active_date (is_active, event_date)`; `videos
idx_video_public (is_active, category_id, sort_order, published_on)`,
`uniq_video_youtube`; `calendar_entries idx_calendar_entry_active_dates
(is_active, entry_date, end_date)`; `payment_transactions idx_status_created`,
`uniq_order_id`, `uniq_tracking_id`, `idx_review`; `admin_activity
idx_created`, `idx_actor (actor, created_at)`; `notifications idx_claim
(status, next_attempt_at, priority_rank)` for the worker. The poller selects
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
