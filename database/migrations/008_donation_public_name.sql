-- 008_donation_public_name.sql
--
-- Whether a donor agreed to have their name shown on the public thank-you list.
--
-- The homepage used to list the name of everyone who pledged in the last 30
-- days. Nobody was asked. A pledge is a private act for many families, and a
-- name next to a temple fund can say more than the donor wants said, so the
-- list now shows a donation only when this flag is set.
--
--   show_name_publicly   1 when the donor ticked "show my name on the
--                        thank-you list" on the Donations page, or when the
--                        committee set it from the admin with the donor's
--                        permission. 0 otherwise.
--
-- Every row that exists when this runs stays 0: those donors were never asked,
-- so they never agreed. The committee can show individual names from the admin
-- once a donor says yes.
--
-- Additive and safe to re-run.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'show_name_publicly'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `show_name_publicly` TINYINT(1) NOT NULL DEFAULT 0
       COMMENT ''1 when the donor agreed to appear on the public thank-you list''
       AFTER `message`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
