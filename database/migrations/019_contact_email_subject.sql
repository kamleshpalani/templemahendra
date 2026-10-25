-- ============================================================
-- 019_contact_email_subject.sql — contact form: email, subject, office alerts
--
-- Brief §21 asks the contact form for name, email, phone, subject and message;
-- until now only name, phone and message were stored. §20 asks that the
-- committee is told about every enquiry (test case E2E-040). This adds:
--
--   contact_messages.email       the visitor's address, optional. The admin
--                                inbox offers a mailto: link and the office
--                                alert quotes it.
--   contact_messages.subject     optional; shown as the enquiry's title.
--   contact_messages.updated_at  maintained by MySQL (brief §25).
--   notification_categories 'office'
--                                a transactional category for messages sent to
--                                the temple office itself (contact-form
--                                alerts). Transactional, so no devotee-consent
--                                rule can hold them back: the recipient is the
--                                temple, not a family. Only inserted when the
--                                notification tables (migration 007) exist.
--
-- The office address is CONTACT_NOTIFY_EMAIL in the environment (one address
-- or a comma-separated list); see backend/.env.example.
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/019_contact_email_subject.sql
-- ============================================================

-- The connection's character set, whatever client applies this file: without
-- it a latin1 client (the Windows mysql default) stores Tamil text as '?'.
SET NAMES utf8mb4;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contact_messages' AND COLUMN_NAME = 'email');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contact_messages` ADD COLUMN `email` VARCHAR(190) NULL DEFAULT NULL
     COMMENT ''optional; the visitor''''s address for a reply'' AFTER `phone`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contact_messages' AND COLUMN_NAME = 'subject');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contact_messages` ADD COLUMN `subject` VARCHAR(200) NULL DEFAULT NULL AFTER `email`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contact_messages' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `contact_messages` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The office category, only where the notification service is installed.
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notification_categories');
SET @sql := IF(@tbl = 1,
  'INSERT IGNORE INTO `notification_categories` (`key`, `label_ta`, `label_en`, `icon`, `kind`, `default_on`, `sort_order`)
   VALUES (''office'', ''கோயில் அலுவலகம்'', ''Temple office'', ''inbox'', ''transactional'', 1, 125)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
