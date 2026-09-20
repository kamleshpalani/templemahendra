-- ============================================================
-- 016_sponsors_consent.sql — full sponsor record + publish consent
--
-- A sponsor used to be a name, a phone number, a note and an optional pooja.
-- The committee also needs to know who the family is, how to reach them, what
-- they pledged, whether it was paid, and — before anything reaches the website —
-- whether they agreed to be named. This adds:
--
--   family_name      "Murugan Family", "Kandasamy & sons" — shown publicly
--                    instead of `name` when set and consent is given
--   email            private, admin only
--   event_id         optional link to a temple event (in addition to pooja_id)
--   amount           sponsorship amount in INR, NULL when not recorded
--   payment_ref      receipt number, UPI / bank reference or CCAvenue order id
--   payment_status   PENDING | PAID | FAILED | REFUNDED | WAIVED
--   publish_consent  1 only when the sponsor agreed to be named on the website.
--                    Every existing row stays 0: nobody was asked, so nobody
--                    has agreed. The public API and homepage cards show a
--                    sponsor only when is_active = 1 AND publish_consent = 1.
--   updated_at       maintained by MySQL
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/016_sponsors_consent.sql
-- ============================================================

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'family_name');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `family_name` VARCHAR(200) NULL DEFAULT NULL
     COMMENT ''public display name when consent is given'' AFTER `name`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'email');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `email` VARCHAR(190) NULL DEFAULT NULL
     COMMENT ''private; never published'' AFTER `phone`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'event_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `event_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''optional link to events.id'' AFTER `pooja_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'amount');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `amount` DECIMAL(12,2) NULL DEFAULT NULL
     COMMENT ''sponsorship amount in INR'' AFTER `event_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'payment_ref');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `payment_ref` VARCHAR(100) NULL DEFAULT NULL
     COMMENT ''receipt no, UPI/bank reference or CCAvenue order id'' AFTER `amount`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'payment_status');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `payment_status`
     ENUM(''PENDING'',''PAID'',''FAILED'',''REFUNDED'',''WAIVED'') NOT NULL DEFAULT ''PENDING''
     AFTER `payment_ref`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'publish_consent');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `publish_consent` TINYINT(1) NOT NULL DEFAULT 0
     COMMENT ''1 when the sponsor agreed to be named on the website'' AFTER `payment_status`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'updated_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `updated_at` DATETIME NOT NULL
     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Indexes and the event foreign key, each guarded so the file can be re-run.
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND INDEX_NAME = 'idx_sponsor_public');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `sponsors` ADD KEY `idx_sponsor_public` (`is_active`, `publish_consent`, `created_at`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND INDEX_NAME = 'idx_sponsor_event');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `sponsors` ADD KEY `idx_sponsor_event` (`event_id`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND CONSTRAINT_NAME = 'fk_sponsor_event');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `sponsors` ADD CONSTRAINT `fk_sponsor_event`
     FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
