-- ============================================================
-- 023_payments_pooja_sponsor.sql — online donations for a pooja, and the
-- sponsor record a paid one creates
--
-- Brief §13 asks an online donation to remember which pooja it sponsors and
-- which sponsor record it produced, and that a replayed gateway callback or a
-- repeated notification never assigns the sponsorship twice. §6 adds the
-- "Pournami Pooja" donation purpose. This adds:
--
--   donations.pooja_id         optional link to poojas.id — the pooja the donor
--                              chose to sponsor from /donate?pooja=<id>. Set at
--                              checkout, validated as an active pooja on today
--                              or a later date. ON DELETE SET NULL: deleting the
--                              pooja keeps the payment record.
--   sponsors.transaction_id    payment_transactions.id of the attempt the
--                              receipt was issued for. Lets Admin → Sponsors
--                              link straight to the online payment.
--   sponsors.donation_id       donations.id of the paid donation that created
--                              the row. UNIQUE: one donation can create at most
--                              one sponsor, however many times CCAvenue repeats
--                              itself (the application checks first; this is the
--                              last guard). Both FKs ON DELETE SET NULL, so a
--                              deleted payment never deletes a sponsor.
--   donation_categories 'pournami_pooja'
--                              "பௌர்ணமி பூஜை" / "Pournami Pooja", seeded with
--                              INSERT IGNORE after the pooja_seva purpose; only
--                              where migration 010 (the categories table) is in.
--
-- The sponsor row itself is written by backend/includes/payments/store.php in
-- the same transaction that assigns the receipt number (name, phone, email,
-- amount, PAID, payment_ref = receipt, publish_consent mirrors the donation's
-- thank-you-list consent). A full refund marks it REFUNDED; nothing deletes it.
--
-- Additive, idempotent and safe to re-run on a live database. Plain
-- PREPARE/EXECUTE only (no stored routines) so it runs under the limited
-- privileges of shared hosting. Needs 010_payments.sql for the sponsor
-- transaction link and the category; without it those two steps are skipped
-- and can be re-run later.
--
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/023_payments_pooja_sponsor.sql
-- ============================================================

-- ── donations.pooja_id ────────────────────────────────────────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'pooja_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations` ADD COLUMN `pooja_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''poojas.id this online donation sponsors; NULL for a general donation'' AFTER `category_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND INDEX_NAME = 'idx_donation_pooja');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `donations` ADD KEY `idx_donation_pooja` (`pooja_id`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND CONSTRAINT_NAME = 'fk_donation_pooja');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `donations` ADD CONSTRAINT `fk_donation_pooja`
     FOREIGN KEY (`pooja_id`) REFERENCES `poojas` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── sponsors.transaction_id (needs payment_transactions from migration 010) ──
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_transactions');
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'transaction_id');
SET @sql := IF(@tbl = 1 AND @col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `transaction_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''payment_transactions.id of the online payment that created this sponsor'' AFTER `payment_status`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'transaction_id');
SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND INDEX_NAME = 'idx_sponsor_transaction');
SET @sql := IF(@col = 1 AND @idx = 0,
  'ALTER TABLE `sponsors` ADD KEY `idx_sponsor_transaction` (`transaction_id`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND CONSTRAINT_NAME = 'fk_sponsor_transaction');
SET @sql := IF(@col = 1 AND @fk = 0,
  'ALTER TABLE `sponsors` ADD CONSTRAINT `fk_sponsor_transaction`
     FOREIGN KEY (`transaction_id`) REFERENCES `payment_transactions` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── sponsors.donation_id: one sponsor per paid donation ──────────────────────
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND COLUMN_NAME = 'donation_id');
SET @sql := IF(@col = 0,
  'ALTER TABLE `sponsors` ADD COLUMN `donation_id` INT UNSIGNED NULL DEFAULT NULL
     COMMENT ''donations.id of the paid online donation that created this sponsor'' AFTER `transaction_id`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND INDEX_NAME = 'uniq_sponsor_donation');
SET @sql := IF(@idx = 0,
  'ALTER TABLE `sponsors` ADD UNIQUE KEY `uniq_sponsor_donation` (`donation_id`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @fk := (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND CONSTRAINT_NAME = 'fk_sponsor_donation');
SET @sql := IF(@fk = 0,
  'ALTER TABLE `sponsors` ADD CONSTRAINT `fk_sponsor_donation`
     FOREIGN KEY (`donation_id`) REFERENCES `donations` (`id`) ON DELETE SET NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── The Pournami Pooja purpose (brief §6), only where migration 010 is in ────
SET @tbl := (SELECT COUNT(*) FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donation_categories');
SET @sql := IF(@tbl = 1,
  'INSERT IGNORE INTO `donation_categories`
     (`slug`, `name_ta`, `name_en`, `description_ta`, `description_en`, `suggested_amount`, `sort_order`, `is_active`, `created_at`, `updated_at`)
   VALUES
     (''pournami_pooja'', ''பௌர்ணமி பூஜை'', ''Pournami Pooja'',
      ''மாதாந்திர பௌர்ணமி பூஜையை ஸ்பான்சர் செய்ய.'', ''Sponsor a monthly full-moon (Pournami) pooja.'',
      NULL, 65, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
