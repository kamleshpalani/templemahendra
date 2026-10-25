-- ============================================================
-- 025_cms_pages_settings.sql — the committee edits the site's own facts
--
-- Brief §3 says every important piece of business content must be
-- configurable through the CMS; §15 lists Content → Pages, Temple → Nalla
-- Neram and System → Settings / Languages / SEO; §25 expects `pages`,
-- `settings` and `seo_settings`. Until now the temple's name, contact
-- details, opening hours, daily pooja schedule, Nalla Neram, hero copy and
-- every page title lived in code.
--
-- site_settings   one row per key (backend/includes/site_settings.php lists
--                 them): value_ta / value_en for bilingual text, value for
--                 language-neutral text (a URL, a phone, JSON). A NULL cell
--                 means "not edited yet" and the code's default applies, so an
--                 upgraded site looks exactly as it did until someone edits.
-- pages           CMS pages (About history, mission, …): slug, bilingual title
--                 and body (plain paragraphs), bilingual meta title and
--                 description, shown/hidden, order.
-- seo_settings    per-address overrides of the title, description, preview
--                 image and robots directive the site otherwise derives from
--                 site_pages.php; read by og.php, spa.php, sitemap.php and the
--                 React <Seo> through GET /api/settings.
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- CREATE TABLE IF NOT EXISTS / INSERT IGNORE only.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/025_cms_pages_settings.sql
-- ============================================================

-- The connection's character set, whatever client applies this file: without
-- it a latin1 client (the Windows mysql default) stores Tamil text as '?'.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `site_settings` (
  `key_name`   VARCHAR(80)  NOT NULL,
  `value_ta`   TEXT         NULL,
  `value_en`   TEXT         NULL,
  `value`      TEXT         NULL COMMENT 'language-neutral: URL, phone, e-mail, number, JSON',
  `updated_by` VARCHAR(60)  NULL,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `pages` (
  `id`                  INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`                VARCHAR(80)   NOT NULL COMMENT '^[a-z0-9][a-z0-9-]{0,78}$',
  `title_ta`            VARCHAR(300)  NOT NULL,
  `title_en`            VARCHAR(300)  NOT NULL,
  `body_ta`             MEDIUMTEXT    NULL COMMENT 'plain text; blank lines separate paragraphs',
  `body_en`             MEDIUMTEXT    NULL,
  `meta_title_ta`       VARCHAR(200)  NULL,
  `meta_title_en`       VARCHAR(200)  NULL,
  `meta_description_ta` VARCHAR(500)  NULL,
  `meta_description_en` VARCHAR(500)  NULL,
  `sort_order`          INT           NOT NULL DEFAULT 0,
  `is_active`           TINYINT(1)    NOT NULL DEFAULT 1,
  `updated_by`          VARCHAR(60)   NULL,
  `created_at`          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_page_slug` (`slug`),
  KEY `idx_page_active_order` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `seo_settings` (
  `id`             INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `path`           VARCHAR(160)  NOT NULL COMMENT 'the address without a query string, e.g. /about',
  `title_ta`       VARCHAR(200)  NULL,
  `title_en`       VARCHAR(200)  NULL,
  `description_ta` VARCHAR(500)  NULL,
  `description_en` VARCHAR(500)  NULL,
  `og_image`       VARCHAR(500)  NULL COMMENT '/uploads/… or https URL',
  `noindex`        TINYINT(1)    NOT NULL DEFAULT 0,
  `is_active`      TINYINT(1)    NOT NULL DEFAULT 1,
  `updated_by`     VARCHAR(60)   NULL,
  `created_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_seo_path` (`path`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The two pages the About page reads first; empty bodies fall back to the
-- built-in text, so nothing changes until the committee writes something.
INSERT IGNORE INTO `pages` (`slug`, `title_ta`, `title_en`, `body_ta`, `body_en`, `sort_order`, `is_active`) VALUES
  ('mission', 'நோக்கம்', 'Our mission', NULL, NULL, 10, 1),
  ('history', 'கோயில் வரலாறு', 'Temple history', NULL, NULL, 20, 1);
