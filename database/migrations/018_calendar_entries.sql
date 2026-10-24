-- ============================================================
-- 018_calendar_entries.sql — Temple calendar entries (brief §6 "Temple Calendar")
--
-- The public Panchangam calendar (/api/calendar) computes Pournami, Amavasai,
-- Ekadasi, Sashti, Pradosham and Chaturthi from the moon and lists a few fixed
-- festivals. The committee needs two things on top of that:
--
--   mode = 'add'   a custom entry on a date (or a span of dates): a festival,
--                  an abhishekam, a temple holiday, anything, with a Tamil and
--                  an English title and an optional description
--   mode = 'hide'  suppress a computed observance on one date (or all of them)
--                  when the temple's own panchangam differs from the formula —
--                  e.g. the Pournami pooja is observed the day before
--
-- Entries are shown or hidden with is_active; a hidden entry stays saved.
-- Optional links to a pooja or an event let the calendar point visitors at
-- the page that has the timing and sponsorship details.
--
-- Additive, idempotent and safe to re-run. No stored routines, so it runs
-- under the limited privileges of shared hosting.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/018_calendar_entries.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS `calendar_entries` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `mode`           ENUM('add','hide') NOT NULL DEFAULT 'add',
  `entry_type`     ENUM('festival','pooja','pournami','amavasai','ekadasi','sashti','pradosham','chaturthi','pratipada','holiday','custom','all')
                   NOT NULL DEFAULT 'custom' COMMENT 'add: how the day is marked; hide: which computed observance to suppress (all = every one)',
  `entry_date`     DATE         NOT NULL,
  `end_date`       DATE         NULL DEFAULT NULL COMMENT 'last day of a multi-day entry; NULL = single day',
  `title_ta`       VARCHAR(300) NOT NULL DEFAULT '',
  `title_en`       VARCHAR(300) NOT NULL DEFAULT '',
  `description_ta` TEXT         NULL,
  `description_en` TEXT         NULL,
  `pooja_id`       INT UNSIGNED NULL DEFAULT NULL,
  `event_id`       INT UNSIGNED NULL DEFAULT NULL,
  `sort_order`     INT          NOT NULL DEFAULT 0 COMMENT 'smaller first within a day',
  `is_active`      TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_calendar_entry_active_dates` (`is_active`, `entry_date`, `end_date`),
  KEY `idx_calendar_entry_pooja` (`pooja_id`),
  KEY `idx_calendar_entry_event` (`event_id`),
  CONSTRAINT `fk_calendar_entry_pooja` FOREIGN KEY (`pooja_id`) REFERENCES `poojas` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_calendar_entry_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
