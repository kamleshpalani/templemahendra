-- 006_devotee_address.sql
--
-- The postal address a devotee wants a receipt sent to.
--
-- Migration 005 added country, state and city, which answer "where is this
-- devotee". This adds the rest of a postal address, which answers "where do we
-- post the 80G receipt" — the reason the committee asked for it.
--
--   address1   house or flat, street
--   address2   area, landmark — optional everywhere, and the line most of the
--              world leaves blank
--   postcode   PIN, ZIP, postal code. Free text: formats differ wildly and a
--              few countries have none at all.
--
-- Every column is nullable. Registration does not ask for an address, because
-- a longer sign-up form turns people away and the temple only needs it when
-- there is something to post. Devotees fill it in on their account page, and
-- the committee can fill it in or correct it from the admin.
--
-- Additive and safe to re-run. Requires 003_devotee_accounts.sql.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'address1'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `address1` VARCHAR(180) NULL DEFAULT NULL
       COMMENT ''House or flat and street''
       AFTER `phone_country`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'address2'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `address2` VARCHAR(180) NULL DEFAULT NULL
       COMMENT ''Area or landmark, optional''
       AFTER `address1`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'postcode'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `postcode` VARCHAR(20) NULL DEFAULT NULL
       COMMENT ''PIN / ZIP / postal code, free text''
       AFTER `city`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
