-- 005_devotee_location.sql
--
-- Where a devotee lives. The temple posts 80G receipts and festival notices,
-- and its devotees are spread across many countries, so "which town" is the
-- one question that could not be answered from the rest of the record.
--
--   country  ISO 3166-1 alpha-2, the same codes the phone field uses
--   city     free text, because a list of every town on earth is not a thing
--            worth maintaining and people know what to write
--
-- Both are NULL for accounts created before this migration. Registration asks
-- for them from now on; the profile page lets anyone fill them in later. The
-- application never assumes they are present.
--
-- Additive and safe to re-run. Requires 003_devotee_accounts.sql.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'country'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `country` CHAR(2) NULL DEFAULT NULL
       COMMENT ''ISO 3166-1 alpha-2 of where the devotee lives''
       AFTER `phone_country`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'city'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `city` VARCHAR(120) NULL DEFAULT NULL
       COMMENT ''City or town, free text''
       AFTER `country`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- The committee will want to see where its devotees are; one index makes the
-- admin's country filter and any future count cheap.
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND INDEX_NAME = 'idx_country'
);
SET @sql := IF(@idx = 0,
  'ALTER TABLE `devotees` ADD INDEX `idx_country` (`country`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- State, province or region. Free text rather than a foreign key: the site
-- offers a list for the countries its devotees live in and a text box
-- everywhere else, and a column that accepts both is the honest shape. It
-- stores the ISO 3166-2 code where one was picked ("TN"), or what the devotee
-- typed where no list exists.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'state'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `state` VARCHAR(120) NULL DEFAULT NULL
       COMMENT ''ISO 3166-2 subdivision code where a list exists, else free text''
       AFTER `country`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
