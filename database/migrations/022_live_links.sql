-- ============================================================
-- 022_live_links.sql — a live stream may belong to a pooja or an event
--
-- Brief §12 (Live Temple) and §6: a broadcast is usually the darshan of one
-- pooja (an abhishekam, a pournami pooja) or one temple event (a festival day),
-- and the public page should say so — and, through the pooja, credit the
-- family that sponsored it, exactly as the Poojas and Donors pages already do
-- (sponsorPublicSql(): active AND publish_consent = 1, name and note only).
-- Until now live_streams knew only its temple and deity. This adds:
--
--   live_streams.pooja_id   poojas.id, optional. The pooja this broadcast
--                           shows. Deleting the pooja clears the link
--                           (ON DELETE SET NULL); the stream itself is kept.
--                           The public API answers it as `pooja {id, name_ta,
--                           name_en, date, time}` and the sponsor credit as
--                           `sponsor {name, note}` (null without a consenting
--                           sponsor).
--   live_streams.event_id   events.id, optional. The temple event this
--                           broadcast is part of; cleared the same way.
--                           Answered as `event {id, title_ta, title_en, date}`.
--
-- Both are chosen from a select on Admin → Live Streaming (latest active
-- poojas / events first) and validated against the table before the write,
-- so the foreign keys never raise. Without this migration the module keeps
-- working: the selects are not shown, the two keys answer null and nothing
-- is written to the columns (liveLinksInstalled()).
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting. Requires 011 (live_streams) and the base
-- schema's poojas and events tables.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/022_live_links.sql
-- ============================================================

-- The connection's character set, whatever client applies this file: without
-- it a latin1 client (the Windows mysql default) stores Tamil text as '?'.
SET NAMES utf8mb4;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'pooja_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams` ADD COLUMN `pooja_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''poojas.id, optional; cleared when the pooja is deleted'' AFTER `deity_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'event_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams` ADD COLUMN `event_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''events.id, optional; cleared when the event is deleted'' AFTER `pooja_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Indexes and the two foreign keys, each guarded so the file can be re-run.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND INDEX_NAME = 'idx_stream_pooja');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `live_streams` ADD KEY `idx_stream_pooja` (`pooja_id`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND INDEX_NAME = 'idx_stream_event');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `live_streams` ADD KEY `idx_stream_event` (`event_id`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND CONSTRAINT_NAME = 'fk_stream_pooja');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `live_streams` ADD CONSTRAINT `fk_stream_pooja`
     FOREIGN KEY (`pooja_id`) REFERENCES `poojas` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND CONSTRAINT_NAME = 'fk_stream_event');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `live_streams` ADD CONSTRAINT `fk_stream_event`
     FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
