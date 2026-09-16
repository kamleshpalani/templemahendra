-- 011_live_streams.sql
--
-- Live Darshan, Phase 1 (docs/live/SPEC-PHASE1.md §3): the temple and its
-- deities become small seeded tables, and every live broadcast the committee
-- schedules is one row in live_streams. The public page /live-darshan and the
-- admin page Admin → Live Streaming read and write these three tables only.
--
-- Every DATETIME column is UTC, written by the application (or UTC_TIMESTAMP()
-- in the seeds). The zone the committee scheduled a stream in is kept beside
-- the instant (live_streams.timezone), so the wall clock can always be shown
-- back exactly as it was typed.
--
-- temples                    the temple(s) a stream belongs to. Every other
--                            module still treats the temple as a constant
--                            (frontend/src/data/temple.js); this row is seeded
--                            from that file and is the first place the temple
--                            has an id.
--   slug                     'pudupatti'; ^[a-z0-9-]{1,40}$, never changes
--   name_ta, name_en         the full printed name (TEMPLE.fullName)
--   short_name_ta/_en        the site-wide display name (TEMPLE.name)
--   address_ta/_en           one line (ADDRESS.oneLine)
--   timezone                 IANA zone new streams default to
--   logo_url                 optional /uploads/… or https URL
--   is_active, sort_order    0 hides the temple from the admin selects
--
-- deities                    the deities a stream can be dedicated to.
--   temple_id                temples.id (rows go with their temple)
--   slug                     unique per temple: lingammal, renukadevi, chinnammal
--   name_ta, name_en         from TEMPLE.deities, in temple-name order
--   description_ta/_en       optional, for later phases
--   image_url                optional
--   sort_order, is_active    display order; 0 hides from the selects
--
-- live_streams               one row per broadcast (PHASE0-ANALYSIS §4).
--   temple_id                temples.id; a temple with streams cannot be deleted
--   deity_id                 deities.id, optional; cleared if the deity goes
--   title_ta, title_en       required, 2–300 characters (mirrors events)
--   slug                     ^[a-z0-9][a-z0-9-]{1,118}$; unique among live and
--                            deleted rows; never live|upcoming|schedule|archive;
--                            made from title_en, editable until published
--   description_ta/_en       optional, up to 5000 characters
--   event_type               live_darshan (default), daily_pooja, abhishekam,
--                            deeparadhana, festival, bhajan, discourse,
--                            procession, special_event, other (LIVE_EVENT_TYPES)
--   provider                 youtube (implemented), vimeo, aws_ivs, custom
--                            (LIVE_PROVIDERS; VARCHAR so the list can grow)
--   provider_broadcast_id    YouTube: the 11-character video id the admin pasted
--   provider_stream_id       YouTube liveStream id (Phase 3); never public
--   playback_url             site path or https; for YouTube an optional
--                            override of the "Watch on YouTube" link
--   recording_url            Phase 8 (archive); unused in Phase 1
--   thumbnail_url            /uploads/live-… or https; blank = the provider's
--   banner_url               /uploads/live-… or https, optional
--   scheduled_start_at       UTC; required once the stream leaves DRAFT
--   scheduled_end_at         UTC, optional, after the start
--   actual_start_at          UTC; stamped on the first entry into LIVE
--   actual_end_at            UTC; stamped on COMPLETED
--   timezone                 IANA zone the schedule was entered in
--   status                   DRAFT SCHEDULED STARTING LIVE COMPLETED CANCELLED
--                            OFFLINE ERROR (LIVE_STATUSES; transitions in
--                            LIVE_TRANSITIONS, enforced by liveSetStatus())
--   is_featured              highlighted in later phases
--   show_on_homepage         homepage placement (Phase 2)
--   donations_enabled,       what the public page offers around the player
--   notifications_enabled,
--   sharing_enabled,
--   archive_enabled
--   created_by, updated_by   admin username (the environment owner has no
--                            admin_users row, so no FK — as admin_activity)
--   created_at, updated_at   UTC
--   deleted_at               UTC; soft delete. Every public and admin query
--                            filters deleted_at IS NULL unless it asks for the
--                            bin. Nothing hard-deletes a stream.
--
-- No stream is seeded. Requires 001 to 010. Safe to re-run: tables use IF NOT
-- EXISTS and every seed uses INSERT IGNORE against a unique key.
--
-- Apply with a utf8mb4 client, for example:
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/011_live_streams.sql
-- A latin1 client stores the Tamil names garbled.

-- ── temples ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `temples` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(40)  NOT NULL COMMENT '^[a-z0-9-]{1,40}$; never changes',
  `name_ta`       VARCHAR(300) NOT NULL COMMENT 'full printed name (TEMPLE.fullName)',
  `name_en`       VARCHAR(300) NOT NULL,
  `short_name_ta` VARCHAR(120) NOT NULL COMMENT 'site-wide display name (TEMPLE.name)',
  `short_name_en` VARCHAR(120) NOT NULL,
  `address_ta`    VARCHAR(500) NULL DEFAULT NULL COMMENT 'one line (ADDRESS.oneLine)',
  `address_en`    VARCHAR(500) NULL DEFAULT NULL,
  `timezone`      VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata' COMMENT 'IANA zone new streams default to',
  `logo_url`      VARCHAR(500) NULL DEFAULT NULL COMMENT '/uploads/… or https',
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0 = hidden from the admin selects',
  `sort_order`    INT          NOT NULL DEFAULT 0 COMMENT 'smaller first',
  `created_at`    DATETIME     NOT NULL COMMENT 'UTC',
  `updated_at`    DATETIME     NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_temple_slug` (`slug`),
  KEY `idx_temple_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TEMPLE.fullName, TEMPLE.name and ADDRESS.oneLine from frontend/src/data/temple.js.
INSERT IGNORE INTO `temples`
  (`slug`, `name_ta`, `name_en`, `short_name_ta`, `short_name_en`, `address_ta`, `address_en`, `timezone`, `is_active`, `sort_order`, `created_at`, `updated_at`)
VALUES
  ('pudupatti',
   'தப்பலவார் குலதெய்வம் அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்',
   'Dhabbalavaar Kula Deivam — Arulmigu Sri Lingammal, Sri Renukadevi, Sri Chinnammal Temple',
   'அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்',
   'Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple',
   'நடு தெரு, புதுப்பட்டி, திருவேங்கடம் தாலுகா, தென்காசி மாவட்டம், தமிழ்நாடு - 627719',
   'Middle Street, Pudupatti, Thiruvengadam Taluk, Tenkasi District, Tamil Nadu – 627719',
   'Asia/Kolkata', 1, 0, UTC_TIMESTAMP(), UTC_TIMESTAMP());

-- ── deities ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `deities` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `temple_id`      INT UNSIGNED NOT NULL COMMENT 'temples.id',
  `slug`           VARCHAR(40)  NOT NULL COMMENT 'unique per temple: lingammal, renukadevi, chinnammal',
  `name_ta`        VARCHAR(200) NOT NULL COMMENT 'TEMPLE.deities, temple-name order',
  `name_en`        VARCHAR(200) NOT NULL,
  `description_ta` TEXT         NULL COMMENT 'optional, later phases',
  `description_en` TEXT         NULL,
  `image_url`      VARCHAR(500) NULL DEFAULT NULL COMMENT '/uploads/… or https',
  `sort_order`     INT          NOT NULL DEFAULT 0 COMMENT 'smaller first',
  `is_active`      TINYINT(1)   NOT NULL DEFAULT 1 COMMENT '0 = hidden from the admin selects',
  `created_at`     DATETIME     NOT NULL COMMENT 'UTC',
  `updated_at`     DATETIME     NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_temple_slug` (`temple_id`, `slug`),
  KEY `idx_deity_active_sort` (`temple_id`, `is_active`, `sort_order`),
  CONSTRAINT `fk_deity_temple` FOREIGN KEY (`temple_id`) REFERENCES `temples` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- TEMPLE.deities in temple-name order: Lingammal → Renukadevi → Chinnammal.
INSERT IGNORE INTO `deities` (`temple_id`, `slug`, `name_ta`, `name_en`, `sort_order`, `is_active`, `created_at`, `updated_at`)
SELECT t.`id`, 'lingammal', 'ஸ்ரீ லிங்கம்மாள்', 'Sri Lingammal', 10, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()
  FROM `temples` t WHERE t.`slug` = 'pudupatti';
INSERT IGNORE INTO `deities` (`temple_id`, `slug`, `name_ta`, `name_en`, `sort_order`, `is_active`, `created_at`, `updated_at`)
SELECT t.`id`, 'renukadevi', 'ஸ்ரீ ரேணுகாதேவி', 'Sri Renukadevi', 20, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()
  FROM `temples` t WHERE t.`slug` = 'pudupatti';
INSERT IGNORE INTO `deities` (`temple_id`, `slug`, `name_ta`, `name_en`, `sort_order`, `is_active`, `created_at`, `updated_at`)
SELECT t.`id`, 'chinnammal', 'ஸ்ரீ சின்னம்மாள்', 'Sri Chinnammal', 30, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()
  FROM `temples` t WHERE t.`slug` = 'pudupatti';

-- ── live_streams ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `live_streams` (
  `id`                    INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `temple_id`             INT UNSIGNED NOT NULL COMMENT 'temples.id',
  `deity_id`              INT UNSIGNED NULL DEFAULT NULL COMMENT 'deities.id, optional',
  `title_ta`              VARCHAR(300) NOT NULL,
  `title_en`              VARCHAR(300) NOT NULL,
  `slug`                  VARCHAR(120) NOT NULL COMMENT '^[a-z0-9][a-z0-9-]{1,118}$; unique incl. deleted rows; never live|upcoming|schedule|archive',
  `description_ta`        TEXT         NULL,
  `description_en`        TEXT         NULL,
  `event_type`            VARCHAR(40)  NOT NULL DEFAULT 'live_darshan' COMMENT 'LIVE_EVENT_TYPES: live_darshan daily_pooja abhishekam deeparadhana festival bhajan discourse procession special_event other',
  `provider`              VARCHAR(20)  NOT NULL DEFAULT 'youtube' COMMENT 'LIVE_PROVIDERS: youtube vimeo aws_ivs custom (only youtube implemented)',
  `provider_broadcast_id` VARCHAR(100) NULL DEFAULT NULL COMMENT 'YouTube: the video id the admin pastes',
  `provider_stream_id`    VARCHAR(100) NULL DEFAULT NULL COMMENT 'YouTube liveStream id (Phase 3); never public',
  `playback_url`          VARCHAR(500) NULL DEFAULT NULL COMMENT 'site path or https; YouTube: optional watch-link override',
  `recording_url`         VARCHAR(500) NULL DEFAULT NULL COMMENT 'Phase 8',
  `thumbnail_url`         VARCHAR(500) NULL DEFAULT NULL COMMENT '/uploads/live-… or https; blank = provider default',
  `banner_url`            VARCHAR(500) NULL DEFAULT NULL COMMENT '/uploads/live-… or https',
  `scheduled_start_at`    DATETIME     NULL DEFAULT NULL COMMENT 'UTC',
  `scheduled_end_at`      DATETIME     NULL DEFAULT NULL COMMENT 'UTC',
  `actual_start_at`       DATETIME     NULL DEFAULT NULL COMMENT 'UTC; first entry into LIVE',
  `actual_end_at`         DATETIME     NULL DEFAULT NULL COMMENT 'UTC; set on COMPLETED',
  `timezone`              VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata' COMMENT 'zone the schedule was entered in',
  `status`                VARCHAR(20)  NOT NULL DEFAULT 'DRAFT' COMMENT 'LIVE_STATUSES: DRAFT SCHEDULED STARTING LIVE COMPLETED CANCELLED OFFLINE ERROR',
  `is_featured`           TINYINT(1)   NOT NULL DEFAULT 0,
  `show_on_homepage`      TINYINT(1)   NOT NULL DEFAULT 0,
  `donations_enabled`     TINYINT(1)   NOT NULL DEFAULT 1,
  `notifications_enabled` TINYINT(1)   NOT NULL DEFAULT 1,
  `sharing_enabled`       TINYINT(1)   NOT NULL DEFAULT 1,
  `archive_enabled`       TINYINT(1)   NOT NULL DEFAULT 1,
  `created_by`            VARCHAR(60)  NULL DEFAULT NULL COMMENT 'admin username',
  `updated_by`            VARCHAR(60)  NULL DEFAULT NULL COMMENT 'admin username',
  `created_at`            DATETIME     NOT NULL COMMENT 'UTC',
  `updated_at`            DATETIME     NOT NULL COMMENT 'UTC',
  `deleted_at`            DATETIME     NULL DEFAULT NULL COMMENT 'UTC; soft delete',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_slug` (`slug`),
  KEY `idx_status_start` (`status`, `scheduled_start_at`),
  KEY `idx_public` (`deleted_at`, `status`, `scheduled_start_at`),
  KEY `idx_home` (`show_on_homepage`, `deleted_at`),
  KEY `idx_temple` (`temple_id`),
  KEY `idx_deity` (`deity_id`),
  KEY `idx_provider_ref` (`provider`, `provider_broadcast_id`),
  CONSTRAINT `fk_stream_temple` FOREIGN KEY (`temple_id`) REFERENCES `temples` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_stream_deity`  FOREIGN KEY (`deity_id`)  REFERENCES `deities` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
