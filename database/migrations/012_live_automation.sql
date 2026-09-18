-- 012_live_automation.sql
--
-- Live Darshan, Phase 3 — YouTube API automation (docs/live/SPEC-PHASE3.md §2).
-- A scheduled job (backend/bin/live_cron.php, or the keyed GET /api/live-cron)
-- asks YouTube what each broadcast the committee pasted a video id for is
-- doing, and moves the row through the same liveSetStatus() the admin buttons
-- use. This migration adds the settings the job reads and the columns it
-- writes; it changes no existing column, no row and no behaviour. With the
-- seeded mode = 'off' nothing polls until an owner turns automation on in
-- Admin -> YouTube Automation.
--
-- Every new DATETIME column is UTC, written by the application with
-- UTC_TIMESTAMP() or liveUtcNow(). No column carries ON UPDATE
-- CURRENT_TIMESTAMP (tests/admin-live.mjs compares every column of a row
-- before and after an admin edit).
--
-- live_settings              the module's own settings, the shape of
--                            payment_settings (010). Plain rows are seeded
--                            below; secrets (youtube_api_key,
--                            youtube_client_secret, youtube_refresh_token,
--                            oauth_access_token) are never seeded and are
--                            stored only as "sbx1:" + base64(nonce ‖
--                            secretbox) under LIVE_SETTINGS_KEY, by the admin
--                            page or a token refresh. Never public.
--
-- live_streams (extended; twelve columns, all never public)
--   sync_enabled             0 = the cron leaves this broadcast to the
--                            committee; Check now still reads it
--   sync_state               what YouTube last said, LIVE_PROVIDER_STATES:
--                            upcoming starting live ended not_broadcast
--                            restricted missing revoked unknown
--   synced_status            the status the job's last committed pass left
--                            the row in; NULL = no baseline yet
--   last_synced_at           UTC; every check made, a failed one included
--   last_sync_ok_at          UTC; the last answer that carried this row's own
--                            broadcast; informational only
--   next_sync_at             UTC; the earliest the job may ask again; NULL =
--                            due now
--   sync_attempts            consecutive row failures (never call failures)
--   sync_error               class + committee sentence, redacted, clipped;
--                            NULL when nothing needs a person
--   provider_thumbnail_url   YouTube's thumbnail; stored, displayed nowhere
--   provider_scheduled_start_at,
--   provider_scheduled_end_at
--                            YouTube's own schedule, UTC; never copied into
--                            scheduled_start_at / scheduled_end_at, which the
--                            committee owns
--   viewer_count             YouTube concurrentViewers as at last_sync_ok_at;
--                            stored, displayed nowhere in Phase 3
--   idx_sync_due             (sync_enabled, status, next_sync_at): the job's
--                            working set
--
-- No backfill: next_sync_at IS NULL already means "due now" and sync_enabled
-- defaults to 1, so every published stream joins the rotation on the first
-- pass after mode leaves 'off' — and nothing happens before that.
--
-- Requires 001 to 011. Safe to re-run: the table uses IF NOT EXISTS, every
-- column and the index are checked in information_schema first, and the
-- seeds use INSERT IGNORE, so a re-run never overwrites what the committee
-- changed and changes nothing.
--
-- Apply with a utf8mb4 client, for example:
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/012_live_automation.sql

-- ── live_settings ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `live_settings` (
  `k`          VARCHAR(64) NOT NULL,
  `v`          TEXT        NOT NULL COMMENT 'plain for a setting; sbx1:base64(nonce+secretbox) for a secret',
  `is_secret`  TINYINT(1)  NOT NULL DEFAULT 0,
  `updated_by` VARCHAR(60) NULL DEFAULT NULL COMMENT 'admin username',
  `updated_at` DATETIME    NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Automation starts OFF, with auto_starting (the one inferred move) off too.
-- Plain rows only: no credential is ever seeded. A re-run never overwrites
-- what the committee or the job has changed.
INSERT IGNORE INTO `live_settings` (`k`, `v`, `is_secret`, `updated_by`, `updated_at`) VALUES
  ('mode',                          'off',  0, 'migration', UTC_TIMESTAMP()),
  ('auto_starting',                 '0',    0, 'migration', UTC_TIMESTAMP()),
  ('auto_start',                    '1',    0, 'migration', UTC_TIMESTAMP()),
  ('auto_end',                      '1',    0, 'migration', UTC_TIMESTAMP()),
  ('starting_lead_minutes',         '10',   0, 'migration', UTC_TIMESTAMP()),
  ('lead_minutes',                  '30',   0, 'migration', UTC_TIMESTAMP()),
  ('stale_hours',                   '6',    0, 'migration', UTC_TIMESTAMP()),
  ('catchup_hours',                 '48',   0, 'migration', UTC_TIMESTAMP()),
  ('complete_grace_seconds',        '120',  0, 'migration', UTC_TIMESTAMP()),
  ('poll_seconds_live',             '60',   0, 'migration', UTC_TIMESTAMP()),
  ('poll_seconds_soon',             '300',  0, 'migration', UTC_TIMESTAMP()),
  ('backoff_max_seconds',           '3600', 0, 'migration', UTC_TIMESTAMP()),
  ('daily_quota_units',             '5000', 0, 'migration', UTC_TIMESTAMP()),
  ('quota_day',                     '',     0, 'migration', UTC_TIMESTAMP()),
  ('quota_units',                   '0',    0, 'migration', UTC_TIMESTAMP()),
  ('quota_blocked_until',           '',     0, 'migration', UTC_TIMESTAMP()),
  ('provider_fail_streak',          '0',    0, 'migration', UTC_TIMESTAMP()),
  ('provider_notice',               '',     0, 'migration', UTC_TIMESTAMP()),
  ('oauth_revoked_at',              '',     0, 'migration', UTC_TIMESTAMP()),
  ('oauth_revoked_reason',          '',     0, 'migration', UTC_TIMESTAMP()),
  ('oauth_access_token_expires_at', '',     0, 'migration', UTC_TIMESTAMP()),
  ('youtube_client_id',             '',     0, 'migration', UTC_TIMESTAMP()),
  ('youtube_channel_id',            '',     0, 'migration', UTC_TIMESTAMP());

-- ── live_streams: sync columns ──────────────────────────────────────────────
-- One guarded block per column, in this order, because each AFTER names the
-- column added just before it.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'sync_enabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `sync_enabled` TINYINT(1) NOT NULL DEFAULT 1
       COMMENT ''0 = the cron leaves this broadcast to the committee; Check now still reads it''
       AFTER `status`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'sync_state'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `sync_state` VARCHAR(20) NULL DEFAULT NULL
       COMMENT ''LIVE_PROVIDER_STATES: what YouTube last said (upcoming starting live ended not_broadcast restricted missing revoked unknown); never public''
       AFTER `sync_enabled`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'synced_status'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `synced_status` VARCHAR(20) NULL DEFAULT NULL
       COMMENT ''the status the job''''s last committed pass left the row in; NULL = no baseline yet; never public''
       AFTER `sync_state`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'last_synced_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `last_synced_at` DATETIME NULL DEFAULT NULL
       COMMENT ''UTC; stamped by every check made, a failed one included, except a failed check of a row whose sync_enabled is 0; never public''
       AFTER `synced_status`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'last_sync_ok_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `last_sync_ok_at` DATETIME NULL DEFAULT NULL
       COMMENT ''the last answer that returned this row''''s own broadcast; a failed or empty check never advances it; informational only''
       AFTER `last_synced_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'next_sync_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `next_sync_at` DATETIME NULL DEFAULT NULL
       COMMENT ''UTC; the earliest the job may ask again; NULL = due now; never public''
       AFTER `last_sync_ok_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'sync_attempts'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `sync_attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0
       COMMENT ''consecutive row failures (LIVE_SYNC_ROW_FAILURES); a call-level failure never counts; never public''
       AFTER `next_sync_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'sync_error'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `sync_error` VARCHAR(300) NULL DEFAULT NULL
       COMMENT ''class + committee sentence, redacted and clipped; NULL when nothing needs a person; never public''
       AFTER `sync_attempts`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'provider_thumbnail_url'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `provider_thumbnail_url` VARCHAR(500) NULL DEFAULT NULL
       COMMENT ''the best thumbnail YouTube reports; stored, read by nothing in phase 3; never public''
       AFTER `thumbnail_url`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'provider_scheduled_start_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `provider_scheduled_start_at` DATETIME NULL DEFAULT NULL
       COMMENT ''what YouTube says the start is; the committee owns scheduled_start_at; never public''
       AFTER `scheduled_end_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'provider_scheduled_end_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `provider_scheduled_end_at` DATETIME NULL DEFAULT NULL
       COMMENT ''what YouTube says the end is; the committee owns scheduled_end_at; never public''
       AFTER `provider_scheduled_start_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'viewer_count'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `viewer_count` INT UNSIGNED NULL DEFAULT NULL
       COMMENT ''YouTube concurrentViewers as at last_sync_ok_at; approximate; absent means unknown, never zero; never shown in phase 3''
       AFTER `actual_end_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── live_streams: the job's working-set index ───────────────────────────────
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND INDEX_NAME = 'idx_sync_due'
);
SET @sql := IF(@idx = 0,
  'ALTER TABLE `live_streams` ADD INDEX `idx_sync_due` (`sync_enabled`, `status`, `next_sync_at`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
