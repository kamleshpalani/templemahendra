-- ============================================================
-- 024_homepage_engine_poojas.sql — homepage content engine (brief §8, §10)
--                                  and the pooja record (brief §9)
--
-- homepage_widgets
--   content_type      gains the brief's missing types: upcoming_event (the
--                     admin already offered it but no migration ever added it
--                     to the column), livestream and custom.
--   source_type       gains 'system' — the value the public API stamps on the
--                     cards it synthesises itself (next Pournami, fallback
--                     announcement, upcoming events), so a client can tell a
--                     committee card from a generated one.
--   linked_event_id   an Upcoming Event card reads its title, date and
--                     description from the events row instead of a retyped copy.
--   linked_stream_id  a Live Stream card follows a live_streams row (LIVE badge,
--                     schedule, link to the broadcast page).
--   image_url         an optional picture for a card (poster, deity photo):
--                     a site path (/uploads/…) or an https URL.
--   display_order     the brief's separate ordering field; ties in priority are
--                     broken by it (then by id). 0 for every existing row.
--
-- poojas
--   start_time / end_time   typed times (the old free-text pooja_time stays as
--                           a display fallback; it is parsed into start_time
--                           where it reads as a clock time).
--   pooja_type              gains pradosham, chaturthi (Sankatahara), abhishekam,
--                           archana and festival (brief §9).
--   recurrence_type         which observance a row was generated from by
--                           "Generate from Panchangam" (none for hand-made rows).
--   sponsorship_amount      the advertised sponsorship price, INR.
--   sponsorship_available   0 once the pooja is fully sponsored / not bookable.
--   banner_url              optional banner picture.
--   is_featured             highlighted on the Pooja page and API.
--   live_stream_enabled     the committee intends to stream it (§9, §12).
--   updated_at              maintained by MySQL (§25).
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/024_homepage_engine_poojas.sql
-- ============================================================

-- ── homepage_widgets.content_type ────────────────────────────────────────────
SET @ct := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND COLUMN_NAME = 'content_type');
SET @sql := IF(@ct IS NOT NULL AND @ct NOT LIKE '%''custom''%',
  'ALTER TABLE `homepage_widgets` MODIFY COLUMN `content_type`
     ENUM(''announcement'',''coming_soon'',''upcoming_pooja'',''calendar_pooja'',''nalla_neram'',''sponsor'',
          ''upcoming_event'',''livestream'',''custom'') NOT NULL DEFAULT ''announcement''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── homepage_widgets.source_type ─────────────────────────────────────────────
SET @st := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND COLUMN_NAME = 'source_type');
SET @sql := IF(@st IS NOT NULL AND @st NOT LIKE '%''system''%',
  'ALTER TABLE `homepage_widgets` MODIFY COLUMN `source_type`
     ENUM(''manual'',''calendar'',''system'') NOT NULL DEFAULT ''manual''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── homepage_widgets: new columns ────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND COLUMN_NAME = 'linked_event_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `homepage_widgets` ADD COLUMN `linked_event_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''events.id an Upcoming Event card follows'' AFTER `linked_sponsor_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND COLUMN_NAME = 'linked_stream_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `homepage_widgets` ADD COLUMN `linked_stream_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''live_streams.id a Live Stream card follows'' AFTER `linked_event_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND COLUMN_NAME = 'image_url');
SET @sql := IF(@col = 0,
  'ALTER TABLE `homepage_widgets` ADD COLUMN `image_url` VARCHAR(500) NULL DEFAULT NULL
     COMMENT ''/uploads/… path or https URL shown on the card'' AFTER `description_en`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND COLUMN_NAME = 'display_order');
SET @sql := IF(@col = 0,
  'ALTER TABLE `homepage_widgets` ADD COLUMN `display_order` INT NOT NULL DEFAULT 0
     COMMENT ''tie-break after priority; lower first'' AFTER `priority`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND INDEX_NAME = 'idx_widget_order');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `homepage_widgets` ADD INDEX `idx_widget_order` (`is_active`, `is_pinned`, `priority`, `display_order`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND CONSTRAINT_NAME = 'fk_widget_event');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `homepage_widgets` ADD CONSTRAINT `fk_widget_event`
     FOREIGN KEY (`linked_event_id`) REFERENCES `events` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- live_streams exists only once migration 011 has run; the link is optional.
SET @live := (SELECT COUNT(*) FROM information_schema.TABLES
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams');
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'homepage_widgets' AND CONSTRAINT_NAME = 'fk_widget_stream');
SET @sql := IF(@live = 1 AND @fk = 0,
  'ALTER TABLE `homepage_widgets` ADD CONSTRAINT `fk_widget_stream`
     FOREIGN KEY (`linked_stream_id`) REFERENCES `live_streams` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── poojas.pooja_type ────────────────────────────────────────────────────────
SET @pt := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'pooja_type');
SET @sql := IF(@pt IS NOT NULL AND @pt NOT LIKE '%''pradosham''%',
  'ALTER TABLE `poojas` MODIFY COLUMN `pooja_type`
     ENUM(''pournami'',''amavasai'',''ekadasi'',''sashti'',''pradosham'',''chaturthi'',''abhishekam'',''archana'',
          ''festival'',''special'',''monthly'',''daily'') NOT NULL DEFAULT ''special''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── poojas: new columns ──────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'start_time');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `start_time` TIME NULL DEFAULT NULL AFTER `pooja_time`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'end_time');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `end_time` TIME NULL DEFAULT NULL AFTER `start_time`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'recurrence_type');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `recurrence_type`
     ENUM(''none'',''pournami'',''amavasai'',''ekadasi'',''sashti'',''pradosham'',''chaturthi'',''daily'',''weekly'',''monthly'')
     NOT NULL DEFAULT ''none'' COMMENT ''observance this row was generated from'' AFTER `pooja_type`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'sponsorship_amount');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `sponsorship_amount` DECIMAL(10,2) NULL DEFAULT NULL
     COMMENT ''advertised sponsorship price, INR'' AFTER `recurrence_type`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'sponsorship_available');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `sponsorship_available` TINYINT(1) NOT NULL DEFAULT 1
     COMMENT ''0 once fully sponsored / not bookable'' AFTER `sponsorship_amount`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'banner_url');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `banner_url` VARCHAR(500) NULL DEFAULT NULL AFTER `sponsorship_available`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'is_featured');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `is_featured` TINYINT(1) NOT NULL DEFAULT 0 AFTER `banner_url`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'live_stream_enabled');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `live_stream_enabled` TINYINT(1) NOT NULL DEFAULT 0
     COMMENT ''the committee intends to stream it'' AFTER `is_featured`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `poojas` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'poojas' AND INDEX_NAME = 'idx_pooja_type_date');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `poojas` ADD INDEX `idx_pooja_type_date` (`pooja_type`, `pooja_date`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill typed start times from the free-text column where it reads as a
-- clock time ("07:00 AM", "6:30 pm", "18:30"); anything else is left for the
-- committee to set by hand.
UPDATE `poojas` SET `start_time` = STR_TO_DATE(`pooja_time`, '%h:%i %p')
 WHERE `start_time` IS NULL AND `pooja_time` REGEXP '^[0-9]{1,2}:[0-9]{2} [AaPp][Mm]$';
UPDATE `poojas` SET `start_time` = STR_TO_DATE(`pooja_time`, '%H:%i')
 WHERE `start_time` IS NULL AND `pooja_time` REGEXP '^[0-9]{1,2}:[0-9]{2}$';
