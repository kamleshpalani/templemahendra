-- 004_international_phone.sql
--
-- Devotees live all over the world, so a phone number is no longer assumed to
-- be a ten-digit Indian one. Numbers are stored in E.164 form without the plus:
-- the country calling code followed by the national significant number, digits
-- only. "+91 98765 43210" is stored as 919876543210.
--
-- The country is kept alongside it because E.164 cannot always be reversed.
-- Calling code +1 covers the United States, Canada and most of the Caribbean,
-- so a Canadian devotee's own number would come back labelled American if the
-- country had to be guessed from the digits. Two bytes avoids that.
--
-- Existing rows are left exactly as they are. A ten-digit number with no
-- country stored still works everywhere it did before: the application treats a
-- missing phone_country as India, which is what those rows have always meant.
-- Nothing is rewritten, so this migration cannot corrupt historic data.
--
-- Additive and safe to re-run. Requires 003_devotee_accounts.sql.

-- ── devotees ────────────────────────────────────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'phone_country'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `phone_country` CHAR(2) NULL DEFAULT NULL
       COMMENT ''ISO 3166-1 alpha-2 of the phone number; NULL means India, as all pre-004 rows were''
       AFTER `phone`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- `phone` held up to 20 characters, which fits E.164's 15 digits with room to
-- spare, so no width change is needed. This only widens it where an older
-- schema created it narrower.
SET @len := (
  SELECT COALESCE(CHARACTER_MAXIMUM_LENGTH, 0) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'phone'
);
SET @sql := IF(@len > 0 AND @len < 20,
  'ALTER TABLE `devotees` MODIFY COLUMN `phone` VARCHAR(20) NULL COMMENT ''E.164 digits, no plus''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── seva_bookings ───────────────────────────────────────────────────────────
-- The public booking form takes a phone number from anyone, signed in or not,
-- so it needs the same room. These tables predate the devotee accounts.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'phone_country'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `phone_country` CHAR(2) NULL DEFAULT NULL AFTER `phone`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @len := (
  SELECT COALESCE(CHARACTER_MAXIMUM_LENGTH, 0) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'phone'
);
SET @sql := IF(@len > 0 AND @len < 20,
  'ALTER TABLE `seva_bookings` MODIFY COLUMN `phone` VARCHAR(20) NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── donations ───────────────────────────────────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'phone_country'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `phone_country` CHAR(2) NULL DEFAULT NULL AFTER `phone`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @len := (
  SELECT COALESCE(CHARACTER_MAXIMUM_LENGTH, 0) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'phone'
);
SET @sql := IF(@len > 0 AND @len < 20,
  'ALTER TABLE `donations` MODIFY COLUMN `phone` VARCHAR(20) NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── contact_messages ────────────────────────────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contact_messages' AND COLUMN_NAME = 'phone_country'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `contact_messages`
     ADD COLUMN `phone_country` CHAR(2) NULL DEFAULT NULL AFTER `phone`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @len := (
  SELECT COALESCE(CHARACTER_MAXIMUM_LENGTH, 0) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contact_messages' AND COLUMN_NAME = 'phone'
);
SET @sql := IF(@len > 0 AND @len < 20,
  'ALTER TABLE `contact_messages` MODIFY COLUMN `phone` VARCHAR(20) NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
