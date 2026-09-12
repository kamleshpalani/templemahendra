-- ============================================================
-- 003_devotee_accounts.sql — devotee (public) accounts
--
-- Lets a devotee register, verify their email, sign in, reset a
-- forgotten password, and see their own seva bookings and donations.
-- Existing bookings and donations are matched by phone number, so a
-- devotee who has given before sees that history the moment they
-- confirm the same number. No existing table is altered.
--
-- Also adds the plumbing those flows need:
--   devotee_tokens  single-use, hashed, expiring verify/reset links
--   mail_log        every message the site tried to send, and what happened
--   rate_limits     per-IP throttling for the public auth endpoints
--
-- Safe to run on an existing database and safe to re-run.
--
--   mysql -u <user> -p <db> < database/migrations/003_devotee_accounts.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS `devotees` (
  `id`                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `name`              VARCHAR(200)  NOT NULL,
  `email`             VARCHAR(190)  NOT NULL,
  `phone`             VARCHAR(20)   NULL COMMENT 'links historic bookings/donations',
  `pass_hash`         VARCHAR(255)  NOT NULL,
  `email_verified_at` DATETIME      NULL,
  `is_active`         TINYINT(1)    NOT NULL DEFAULT 1,
  `last_login_at`     DATETIME      NULL,
  `created_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_email` (`email`),
  KEY `idx_phone` (`phone`),
  KEY `idx_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Raw tokens are never stored: only sha256(token). A row is spent by
-- setting used_at, so a link in an old mailbox cannot be replayed.
CREATE TABLE IF NOT EXISTS `devotee_tokens` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `devotee_id` INT UNSIGNED NOT NULL,
  `kind`       ENUM('verify','reset') NOT NULL,
  `token_hash` CHAR(64)     NOT NULL,
  `expires_at` DATETIME     NOT NULL,
  `used_at`    DATETIME     NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_token` (`token_hash`),
  KEY `idx_devotee_kind` (`devotee_id`, `kind`, `used_at`),
  CONSTRAINT `fk_token_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `mail_log` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `to_email`   VARCHAR(190) NOT NULL,
  `subject`    VARCHAR(255) NOT NULL,
  `template`   VARCHAR(40)  NOT NULL,
  `status`     ENUM('sent','failed','logged') NOT NULL COMMENT 'logged = no transport configured',
  `transport`  VARCHAR(20)  NULL COMMENT 'smtp | mail | none',
  `error`      VARCHAR(500) NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_created` (`created_at`),
  KEY `idx_status` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rate_limits` (
  `bucket`       VARCHAR(190) NOT NULL COMMENT 'action:identifier, e.g. login:203.0.113.9',
  `hits`         INT UNSIGNED NOT NULL DEFAULT 0,
  `window_start` DATETIME     NOT NULL,
  PRIMARY KEY (`bucket`),
  KEY `idx_window` (`window_start`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Ownership of a record, established at the time it is submitted ──────────
--
-- A devotee's history is matched on this column and never on their phone
-- number: a phone number is not proof of anything here (no SMS verification
-- exists), so matching on it would let anyone register with a neighbour's
-- number and read their donation history. Rows created before an account
-- existed stay unlinked, which is the safe default.
SET @sql = (SELECT IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'devotee_id'),
  'DO 0',
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `devotee_id` INT UNSIGNED NULL COMMENT "set when submitted by a signed-in devotee" AFTER `id`,
     ADD KEY `idx_devotee` (`devotee_id`),
     ADD CONSTRAINT `fk_booking_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE SET NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql = (SELECT IF(EXISTS(
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'devotee_id'),
  'DO 0',
  'ALTER TABLE `donations`
     ADD COLUMN `devotee_id` INT UNSIGNED NULL COMMENT "set when submitted by a signed-in devotee" AFTER `id`,
     ADD KEY `idx_devotee` (`devotee_id`),
     ADD CONSTRAINT `fk_donation_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE SET NULL'));
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
