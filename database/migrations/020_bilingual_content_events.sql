-- ============================================================
-- 020_bilingual_content_events.sql — bilingual announcements, events and sevas
--
-- Brief §7 asks for every piece of visitor-facing content in Tamil and
-- English; §6 asks events to carry a type, a featured flag, a span of dates,
-- times, a venue and a picture, and sevas to say when they are performed and
-- whether they can be booked online; §25 asks for created_at / updated_at.
-- The three content tables from schema.sql had one language column each and
-- none of that. This adds:
--
--   announcements.title_ta / title_en   the notice in each language (VARCHAR 300).
--                                       Backfilled from `title`, which stays and
--                                       keeps holding the English text (Tamil
--                                       when there is no English) for one release.
--   announcements.body_ta / body_en     the detail in each language; backfilled
--                                       from `body`, which stays likewise.
--   announcements.start_date / end_date the window in which the notice is public
--                                       (both optional, inclusive). Outside it the
--                                       notice stays saved but is not served.
--   announcements.updated_at            maintained by MySQL.
--
--   events.description_ta / _en         backfilled from `description`, which stays.
--   events.event_type                   festival | pooja | special | other.
--   events.is_featured                  1 highlights the event on the Events page.
--   events.end_date                     last day of a multi-day event (optional).
--   events.start_time / end_time        optional programme times.
--   events.venue_ta / venue_en          where it takes place (optional).
--   events.image_url                    an https URL or a site path (/uploads/…).
--   events.created_at / updated_at      existing rows get the migration time.
--
--   sevas.description_ta / _en          backfilled from `description`, which stays.
--   sevas.timing_ta / timing_en         "Daily 7–9 am" in each language (optional).
--   sevas.is_bookable                   0 hides the Book button on the public
--                                       site (the seva is still listed). Every
--                                       existing seva stays bookable.
--   sevas.created_at / updated_at       existing rows get the migration time.
--
-- The public APIs keep emitting `title`, `body` and `description` next to the
-- `_ta` / `_en` keys, and read the old column when the new ones are empty, so
-- untouched pages and bulk imports keep working.
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting. The backfills only touch rows whose new
-- columns are still empty, so re-running never overwrites an edit.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/020_bilingual_content_events.sql
-- ============================================================

-- ── announcements ───────────────────────────────────────────────────────────

-- The connection's character set, whatever client applies this file: without
-- it a latin1 client (the Windows mysql default) stores Tamil text as '?'.
SET NAMES utf8mb4;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'title_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `title_ta` VARCHAR(300) NOT NULL DEFAULT ''''
     COMMENT ''the notice in Tamil'' AFTER `title`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'title_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `title_en` VARCHAR(300) NOT NULL DEFAULT ''''
     COMMENT ''the notice in English'' AFTER `title_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'body_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `body_ta` TEXT NULL COMMENT ''detail in Tamil'' AFTER `body`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'body_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `body_en` TEXT NULL COMMENT ''detail in English'' AFTER `body_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'start_date');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `start_date` DATE NULL DEFAULT NULL
     COMMENT ''first day the notice is public; NULL = at once'' AFTER `body_en`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'end_date');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `end_date` DATE NULL DEFAULT NULL
     COMMENT ''last day the notice is public; NULL = no end'' AFTER `start_date`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `announcements` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill: the one language the committee wrote in becomes both. Only rows
-- whose new columns are still empty are touched, so a re-run changes nothing.
UPDATE `announcements` SET `title_ta` = `title` WHERE `title_ta` = '';
UPDATE `announcements` SET `title_en` = `title` WHERE `title_en` = '';
UPDATE `announcements` SET `body_ta` = `body`, `body_en` = `body`
 WHERE `body` IS NOT NULL AND `body` <> '' AND `body_ta` IS NULL AND `body_en` IS NULL;

-- The public feed filters by status and window; the existing
-- idx_active_date (is_active, created_at) already serves the ORDER BY.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcements' AND INDEX_NAME = 'idx_announcement_window');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `announcements` ADD KEY `idx_announcement_window` (`is_active`, `start_date`, `end_date`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── events ──────────────────────────────────────────────────────────────────

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'description_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `description_ta` TEXT NULL COMMENT ''programme in Tamil'' AFTER `description`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'description_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `description_en` TEXT NULL COMMENT ''programme in English'' AFTER `description_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'event_type');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `event_type` ENUM(''festival'',''pooja'',''special'',''other'') NOT NULL DEFAULT ''other''
     AFTER `description_en`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'is_featured');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `is_featured` TINYINT(1) NOT NULL DEFAULT 0
     COMMENT ''1 = highlighted at the top of the Events page'' AFTER `event_type`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'end_date');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `end_date` DATE NULL DEFAULT NULL
     COMMENT ''last day of a multi-day event; NULL = one day'' AFTER `event_date`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'start_time');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `start_time` TIME NULL DEFAULT NULL AFTER `end_date`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'end_time');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `end_time` TIME NULL DEFAULT NULL AFTER `start_time`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'venue_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `venue_ta` VARCHAR(300) NULL DEFAULT NULL COMMENT ''venue in Tamil'' AFTER `end_time`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'venue_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `venue_en` VARCHAR(300) NULL DEFAULT NULL COMMENT ''venue in English'' AFTER `venue_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'image_url');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `image_url` VARCHAR(500) NULL DEFAULT NULL
     COMMENT ''https URL or site path (/uploads/…) of the event picture'' AFTER `venue_en`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'created_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `is_active`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `events` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE `events` SET `description_ta` = `description`, `description_en` = `description`
 WHERE `description` IS NOT NULL AND `description` <> '' AND `description_ta` IS NULL AND `description_en` IS NULL;

-- Featured and typed listings on the public Events page.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND INDEX_NAME = 'idx_event_featured');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `events` ADD KEY `idx_event_featured` (`is_active`, `is_featured`, `event_date`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND INDEX_NAME = 'idx_event_type');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `events` ADD KEY `idx_event_type` (`is_active`, `event_type`, `event_date`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── sevas ───────────────────────────────────────────────────────────────────

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'description_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `description_ta` TEXT NULL COMMENT ''description in Tamil'' AFTER `description`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'description_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `description_en` TEXT NULL COMMENT ''description in English'' AFTER `description_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'timing_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `timing_ta` VARCHAR(200) NULL DEFAULT NULL
     COMMENT ''when it is performed, in Tamil (e.g. தினமும் காலை 7–9)'' AFTER `description_en`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'timing_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `timing_en` VARCHAR(200) NULL DEFAULT NULL
     COMMENT ''when it is performed, in English (e.g. Daily 7–9 am)'' AFTER `timing_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'is_bookable');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `is_bookable` TINYINT(1) NOT NULL DEFAULT 1
     COMMENT ''0 = listed but cannot be booked online'' AFTER `is_featured`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'created_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `is_active`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sevas' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sevas` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE `sevas` SET `description_ta` = `description`, `description_en` = `description`
 WHERE `description` IS NOT NULL AND `description` <> '' AND `description_ta` IS NULL AND `description_en` IS NULL;
