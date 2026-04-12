-- ============================================================
-- Sri Mahendra Temple — MySQL 8 Schema
-- Run once on Hostinger MySQL via phpMyAdmin or CLI
-- ============================================================

CREATE DATABASE IF NOT EXISTS `templemahendra`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `templemahendra`;

-- ── Announcements ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `announcements` (
  `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `title`      VARCHAR(300)    NOT NULL,
  `body`       TEXT            NULL,
  `is_active`  TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_active_date` (`is_active`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Sevas ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `sevas` (
  `id`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `name_ta`     VARCHAR(200)    NOT NULL,
  `name_en`     VARCHAR(200)    NOT NULL,
  `description` TEXT            NULL,
  `amount`      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `sort_order`  INT             NOT NULL DEFAULT 0,
  `is_featured` TINYINT(1)      NOT NULL DEFAULT 0,
  `is_active`   TINYINT(1)      NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `events` (
  `id`          INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `title_ta`    VARCHAR(300)    NOT NULL,
  `title_en`    VARCHAR(300)    NOT NULL,
  `description` TEXT            NULL,
  `event_date`  DATE            NOT NULL,
  `is_active`   TINYINT(1)      NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `idx_active_date` (`is_active`, `event_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Gallery ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `gallery` (
  `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `filename`   VARCHAR(255)    NOT NULL,
  `caption`    VARCHAR(500)    NULL,
  `is_active`  TINYINT(1)      NOT NULL DEFAULT 1,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_active_date` (`is_active`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Donations ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `donations` (
  `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)    NOT NULL,
  `phone`      VARCHAR(20)     NOT NULL,
  `amount`     DECIMAL(12,2)   NOT NULL,
  `purpose`    VARCHAR(100)    NULL,
  `message`    TEXT            NULL,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_date` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Contact Messages ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS `contact_messages` (
  `id`         INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)    NOT NULL,
  `phone`      VARCHAR(20)     NOT NULL,
  `message`    TEXT            NOT NULL,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seva Bookings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `seva_bookings` (
  `id`           INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  `devotee_name` VARCHAR(200)    NOT NULL,
  `phone`        VARCHAR(20)     NOT NULL,
  `seva_id`      INT UNSIGNED    NULL,
  `seva_name`    VARCHAR(200)    NOT NULL,
  `preferred_date` DATE          NULL,
  `message`      TEXT            NULL,
  `status`       ENUM('pending','confirmed','completed','cancelled')
                                 NOT NULL DEFAULT 'pending',
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_status_date` (`status`, `created_at`),
  CONSTRAINT `fk_booking_seva`
    FOREIGN KEY (`seva_id`) REFERENCES `sevas` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Poojas ────────────────────────────────────────────────
-- Monthly/special poojas (Pournami, Amavasai, etc.)
CREATE TABLE IF NOT EXISTS `poojas` (
  `id`              INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `name_ta`         VARCHAR(200)   NOT NULL,
  `name_en`         VARCHAR(200)   NOT NULL,
  `description_ta`  TEXT           NULL,
  `description_en`  TEXT           NULL,
  `pooja_date`      DATE           NOT NULL,
  `pooja_time`      VARCHAR(20)    NULL COMMENT '07:00 AM',
  `pooja_type`      ENUM('pournami','amavasai','ekadasi','sashti','special','monthly','daily')
                                   NOT NULL DEFAULT 'special',
  `is_active`       TINYINT(1)     NOT NULL DEFAULT 1,
  `created_at`      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_active_date` (`is_active`, `pooja_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Sponsors ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `sponsors` (
  `id`         INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(200)   NOT NULL,
  `phone`      VARCHAR(30)    NULL,
  `note`       TEXT           NULL,
  `pooja_id`   INT UNSIGNED   NULL COMMENT 'optional link to a specific pooja',
  `is_active`  TINYINT(1)     NOT NULL DEFAULT 1,
  `created_at` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pooja` (`pooja_id`),
  CONSTRAINT `fk_sponsor_pooja`
    FOREIGN KEY (`pooja_id`) REFERENCES `poojas` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Homepage Widgets ──────────────────────────────────────
-- Flexible homepage content blocks (announcement, coming_soon, upcoming_pooja, etc.)
CREATE TABLE IF NOT EXISTS `homepage_widgets` (
  `id`                 INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `content_type`       ENUM('announcement','coming_soon','upcoming_pooja',
                             'calendar_pooja','nalla_neram','sponsor')
                                      NOT NULL DEFAULT 'announcement',
  `title_ta`           VARCHAR(300)   NULL,
  `title_en`           VARCHAR(300)   NULL,
  `description_ta`     TEXT           NULL,
  `description_en`     TEXT           NULL,
  `source_type`        ENUM('manual','calendar') NOT NULL DEFAULT 'manual',
  `linked_pooja_id`    INT UNSIGNED   NULL,
  `linked_sponsor_id`  INT UNSIGNED   NULL,
  `show_sponsor`       TINYINT(1)     NOT NULL DEFAULT 0,
  `show_nalla_neram`   TINYINT(1)     NOT NULL DEFAULT 0,
  `start_date`         DATE           NULL,
  `end_date`           DATE           NULL,
  `priority`           INT            NOT NULL DEFAULT 10,
  `is_pinned`          TINYINT(1)     NOT NULL DEFAULT 0,
  `is_active`          TINYINT(1)     NOT NULL DEFAULT 1,
  `created_at`         DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_active_priority` (`is_active`, `priority`),
  CONSTRAINT `fk_widget_pooja`
    FOREIGN KEY (`linked_pooja_id`)   REFERENCES `poojas`   (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_widget_sponsor`
    FOREIGN KEY (`linked_sponsor_id`) REFERENCES `sponsors` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed Data (sample) ────────────────────────────────────
INSERT INTO `announcements` (title, body, is_active) VALUES
('கோயில் திறக்கும் நேரம் மாற்றம்', 'இனி காலை 6 மணிக்கு திறக்கும். Morning opening time changed to 6 AM.', 1),
('Special Abhishekam on New Moon Day', 'Grand Abhishekam every Amavasai at 7 AM. All are welcome.', 1);

INSERT INTO `sevas` (name_ta, name_en, description, amount, sort_order, is_featured, is_active) VALUES
('அபிஷேகம்',    'Abhishekam',      'Sacred bathing of the deity.',          251,   1, 1, 1),
('அர்ச்சனை',     'Archana',         'Flower offering with chanting.',        51,    2, 1, 1),
('தீபாராதனை',    'Deepa Aradhana',  'Sacred lamp waving.',                   101,   3, 1, 1),
('சகஸ்ர நாமம்', 'Sahasranama',     'Recitation of 1000 names.',             501,   4, 0, 1),
('அன்னதானம்',   'Annadanam',       'Sponsoring free meal for devotees.',    2001,  5, 1, 1),
('வாகன பூஜை',   'Vahana Pooja',    'Ceremonial procession of the vehicle.', 1001,  6, 0, 1);

INSERT INTO `events` (title_ta, title_en, description, event_date, is_active) VALUES
('தைப்பூசம்',        'Thai Poosam',       'Grand kavadi festival.',              '2026-01-24', 1),
('மகா சிவராத்திரி', 'Maha Shivaratri',   'All-night vigil and abhishekam.',      '2026-02-26', 1),
('பங்குனி உத்திரம்', 'Panguni Uthiram',  'Festival of divine celestial unions.', '2026-03-31', 1),
('ஆடி பூரம்',        'Aadi Pooram',       'Celebration of Goddess Andal.',       '2026-07-28', 1),
('கார்த்திகை',       'Karthigai Deepam',  'Festival of lights.',                 '2026-11-27', 1);

-- \u2500\u2500 Homepage Settings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n-- Key/value switches for homepage section visibility\nCREATE TABLE IF NOT EXISTS \homepage_settings\ (\n  \key_name\  VARCHAR(80)    NOT NULL,\n  \al\       VARCHAR(10)    NOT NULL DEFAULT '1',\n  \label\     VARCHAR(300)   NULL,\n  PRIMARY KEY (\key_name\)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;\n\nINSERT IGNORE INTO \homepage_settings\ (key_name, val, label) VALUES\n('show_pournami_section', '1', 'Show Pournami Poojai section on homepage'),\n('show_nalla_strip',      '1', 'Show Nalla Neram strip on homepage'),\n('show_donor_ticker',     '1', 'Show donor scroll ticker');
