-- ============================================================
-- 021_gallery_albums.sql — Photo gallery albums, alt text and image variants
-- (brief §6 Gallery, §19 accessibility, §22 alt text, §34 image loading)
--
-- The gallery used to be a flat list of files with one caption. The brief
-- asks for albums per event or festival, bilingual alternative text on every
-- photograph, and small images for the grid so the page does not load a
-- 4 MB original for every 220-pixel tile. This adds:
--
--   gallery_albums     one row per album
--     slug             URL key ("pournami-pooja"); /gallery?album=<slug>
--     title_ta/en      shown as the album chip and heading
--     description_ta/en optional, shown under the heading when the album is open
--     cover_image_id   the photo whose thumbnail stands for the album; NULL
--                      means "the newest shown photo in the album"
--     event_id         optional link to events.id (ON DELETE SET NULL)
--     sort_order       smaller first
--     is_active        0 hides the album and every photo in it from the site
--     created_at / updated_at (brief §25)
--
--   gallery            gains
--     album_id         FK gallery_albums.id ON DELETE SET NULL (a deleted
--                      album leaves its photos unfiled, never deletes them)
--     alt_ta / alt_en  alternative text, bilingual; the caption stays the
--                      visible label and remains the fallback alt text, so
--                      every existing row keeps working unchanged
--     thumb_filename   ~480 px wide variant for the grid (WebP when the
--                      server's GD can write it, else JPEG); NULL for rows
--                      uploaded before this migration — the API then falls
--                      back to the original file
--     medium_filename  ~1280 px wide variant for the lightbox; same rule
--     width / height   pixel size of the original, for srcset and layout
--     updated_at       maintained by MySQL
--
-- Seeded albums: the brief's examples (Pournami Pooja, Navaratri, Temple
-- Festival, Kumbabhishekam, Annadhanam) are inserted shown (is_active = 1),
-- but the public API lists an album only once it holds at least one shown
-- photo, so the seeds are invisible to visitors until the committee uploads
-- into them. The committee can rename, reorder, hide or (while empty) delete
-- them from Content → Gallery.
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/021_gallery_albums.sql
-- ============================================================

-- The connection's character set, whatever client applies this file: without
-- it a latin1 client (the Windows mysql default) stores Tamil text as '?'.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `gallery_albums` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`           VARCHAR(60)  NOT NULL COMMENT 'URL key: /gallery?album=<slug>',
  `title_ta`       VARCHAR(200) NOT NULL,
  `title_en`       VARCHAR(200) NOT NULL,
  `description_ta` TEXT         NULL,
  `description_en` TEXT         NULL,
  `cover_image_id` INT UNSIGNED NULL DEFAULT NULL COMMENT 'gallery.id shown as the album cover; NULL = newest shown photo',
  `event_id`       INT UNSIGNED NULL DEFAULT NULL COMMENT 'optional link to events.id',
  `sort_order`     INT          NOT NULL DEFAULT 0 COMMENT 'smaller first',
  `is_active`      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0 = hidden with its photos',
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_gallery_album_slug` (`slug`),
  KEY `idx_gallery_album_active_sort` (`is_active`, `sort_order`),
  KEY `idx_gallery_album_event` (`event_id`),
  KEY `idx_gallery_album_cover` (`cover_image_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── gallery: new columns, each guarded ──────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'album_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `album_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''gallery_albums.id; NULL = unfiled'' AFTER `id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'alt_ta');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `alt_ta` VARCHAR(300) NULL DEFAULT NULL
     COMMENT ''alternative text, Tamil; caption is the fallback'' AFTER `caption`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'alt_en');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `alt_en` VARCHAR(300) NULL DEFAULT NULL
     COMMENT ''alternative text, English; caption is the fallback'' AFTER `alt_ta`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'thumb_filename');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `thumb_filename` VARCHAR(255) NULL DEFAULT NULL
     COMMENT ''~480px wide variant in uploads/; NULL = use filename'' AFTER `filename`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'medium_filename');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `medium_filename` VARCHAR(255) NULL DEFAULT NULL
     COMMENT ''~1280px wide variant in uploads/; NULL = use filename'' AFTER `thumb_filename`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'width');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `width` INT NULL DEFAULT NULL
     COMMENT ''pixel width of the original'' AFTER `medium_filename`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'height');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `height` INT NULL DEFAULT NULL
     COMMENT ''pixel height of the original'' AFTER `width`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `gallery` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Indexes and foreign keys, each guarded so the file can be re-run ────────
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND INDEX_NAME = 'idx_gallery_album');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `gallery` ADD KEY `idx_gallery_album` (`album_id`, `is_active`, `created_at`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery' AND CONSTRAINT_NAME = 'fk_gallery_album');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `gallery` ADD CONSTRAINT `fk_gallery_album`
     FOREIGN KEY (`album_id`) REFERENCES `gallery_albums` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The album's cover points back at a photo; deleting the photo clears the cover.
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery_albums' AND CONSTRAINT_NAME = 'fk_gallery_album_cover');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `gallery_albums` ADD CONSTRAINT `fk_gallery_album_cover`
     FOREIGN KEY (`cover_image_id`) REFERENCES `gallery` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- events comes from schema.sql; guarded all the same, as 017 guards live_streams.
SET @has_events := (SELECT COUNT(*) FROM information_schema.TABLES
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events');
SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery_albums' AND CONSTRAINT_NAME = 'fk_gallery_album_event');
SET @sql := IF(@has_events = 1 AND @fk = 0,
  'ALTER TABLE `gallery_albums` ADD CONSTRAINT `fk_gallery_album_event`
     FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Starter albums (brief §6). Shown, but listed publicly only once they hold a photo. ──
INSERT IGNORE INTO `gallery_albums` (`slug`, `title_ta`, `title_en`, `sort_order`) VALUES
  ('pournami-pooja',  'பௌர்ணமி பூஜை',     'Pournami Pooja',  10),
  ('navaratri',       'நவராத்திரி',        'Navaratri',       20),
  ('temple-festival', 'கோயில் திருவிழா',   'Temple Festival', 30),
  ('kumbabhishekam',  'கும்பாபிஷேகம்',     'Kumbabhishekam',  40),
  ('annadhanam',      'அன்னதானம்',         'Annadhanam',      50);
