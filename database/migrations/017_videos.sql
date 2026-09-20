-- ============================================================
-- 017_videos.sql — Videos module (brief §6 "Videos", §15 Media → Videos)
--
-- The temple's YouTube videos, grouped into categories the committee manages:
-- pooja recordings, festival highlights, discourses, and so on. Previous live
-- darshan broadcasts already have their own archive (live_streams.recording_url,
-- /live-darshan/archive); a video here may point at one of those broadcasts
-- so the two lists stay in step, but any public YouTube video can be listed.
--
--   video_categories  slug, Tamil/English name, display order, shown/hidden
--   videos            11-character YouTube id (unique), Tamil/English title and
--                     description, optional category, optional live_stream,
--                     published date, featured flag, display order, shown/hidden
--
-- Additive, idempotent and safe to re-run. No stored routines, so it runs
-- under the limited privileges of shared hosting.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/017_videos.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS `video_categories` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(60)  NOT NULL COMMENT 'URL key: poojas, festivals, discourses',
  `name_ta`    VARCHAR(200) NOT NULL,
  `name_en`    VARCHAR(200) NOT NULL,
  `sort_order` INT          NOT NULL DEFAULT 0 COMMENT 'smaller first',
  `is_active`  TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0 = hidden with its videos',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_video_category_slug` (`slug`),
  KEY `idx_video_category_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `videos` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id`    INT UNSIGNED NULL DEFAULT NULL,
  `live_stream_id` INT UNSIGNED NULL DEFAULT NULL COMMENT 'the broadcast this recording came from, when it did',
  `youtube_id`     VARCHAR(20)  NOT NULL COMMENT '11-character YouTube video id',
  `title_ta`       VARCHAR(300) NOT NULL,
  `title_en`       VARCHAR(300) NOT NULL,
  `description_ta` TEXT         NULL,
  `description_en` TEXT         NULL,
  `published_on`   DATE         NULL DEFAULT NULL COMMENT 'when the pooja / event took place',
  `is_featured`    TINYINT(1)   NOT NULL DEFAULT 0,
  `sort_order`     INT          NOT NULL DEFAULT 0 COMMENT 'smaller first, then newest published',
  `is_active`      TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_video_youtube` (`youtube_id`),
  KEY `idx_video_public` (`is_active`, `category_id`, `sort_order`, `published_on`),
  KEY `idx_video_featured` (`is_active`, `is_featured`),
  KEY `idx_video_stream` (`live_stream_id`),
  CONSTRAINT `fk_video_category` FOREIGN KEY (`category_id`) REFERENCES `video_categories` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- live_streams may not exist (migration 011 is optional on a site without
-- live darshan), so the foreign key is added only when it does.
SET @has_streams := (SELECT COUNT(*) FROM information_schema.TABLES
                      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams');
SET @has_fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos' AND CONSTRAINT_NAME = 'fk_video_stream');
SET @sql := IF(@has_streams = 1 AND @has_fk = 0,
  'ALTER TABLE `videos` ADD CONSTRAINT `fk_video_stream` FOREIGN KEY (`live_stream_id`) REFERENCES `live_streams` (`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Starter categories; the committee can rename, reorder or hide them.
INSERT IGNORE INTO `video_categories` (`slug`, `name_ta`, `name_en`, `sort_order`) VALUES
  ('poojas',      'பூஜைகள்',          'Poojas',            10),
  ('festivals',   'திருவிழாக்கள்',     'Festivals',         20),
  ('darshan',     'தரிசனப் பதிவுகள்',  'Darshan recordings', 30),
  ('discourses',  'சொற்பொழிவுகள்',     'Discourses',        40),
  ('temple-life', 'கோயில் வாழ்க்கை',   'Temple life',       50);
