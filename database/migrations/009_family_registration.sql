-- 009_family_registration.sql
--
-- Devotee sign-in is gone. A devotee now fills in one family registration form
-- (docs/registration/SPEC.md): name, phone, an optional email, the house
-- address, the language to be contacted in, one tick box agreeing to temple
-- updates, and the members of the family.
--
--   devotees.email               optional, and no longer unique: many devotees
--                                have no email and families share one
--   devotees.pass_hash           optional; only accounts made before 009 have one
--   devotees.date_of_birth       the registrant's date of birth, when given
--   devotees.duplicate_of        the earlier registration with the same phone
--                                number, for the committee to merge, delete or
--                                clear. The person registering is never told.
--   devotees.lang                'ta' or 'en': the language the temple writes in
--   devotees.updates_consent_at  UTC time consent to temple updates (festivals,
--   devotees.updates_consent_by  poojas, announcements) was recorded, and who
--                                recorded it: NULL for the registration form,
--                                otherwise the committee member
--   devotees.unsubscribed_at     UTC time the devotee withdrew that consent from
--                                a link in a message. It wins over the consent.
--   devotee_family_members       one row per family member
--   seva_bookings.lang,          the site language the form was sent in, so the
--   donations.lang               confirmation and receipt are written in it
--
-- The notification bell, notification history, web push and devotees' own
-- notification settings went with sign-in, so this also retires what only they
-- used: waiting in-app and push deliveries are cancelled, open campaigns lose
-- those channels, their templates and the push keys are deleted, and the
-- account-only message templates and the security and promotional categories
-- are switched off. Delivery history keeps its rows.
--
-- Nothing is dropped. devotee_tokens, devotee_devices, devotee_otps,
-- devotee_notification_prefs, email_verified_at, last_login_at and
-- phone_verified_at stay until a later migration, once no code reads them.
--
-- Requires 003 to 008. Safe to re-run: every change checks first, and the
-- one-off copies run only in the run that creates their column.
--
-- Apply with a utf8mb4 client (for example mysql --default-character-set=utf8mb4);
-- a latin1 client stores Tamil text garbled.

-- ── devotees.email: optional, not unique ────────────────────────────────────
SET @nul := (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'email'
);
SET @sql := IF(@nul = 'NO',
  'ALTER TABLE `devotees`
     MODIFY COLUMN `email` VARCHAR(190) NULL DEFAULT NULL
       COMMENT ''Optional since 009, and not unique''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND INDEX_NAME = 'uniq_email'
);
SET @sql := IF(@idx > 0, 'ALTER TABLE `devotees` DROP INDEX `uniq_email`', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND INDEX_NAME = 'idx_email'
);
SET @sql := IF(@idx = 0, 'ALTER TABLE `devotees` ADD INDEX `idx_email` (`email`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── devotees.pass_hash: optional ────────────────────────────────────────────
SET @nul := (
  SELECT IS_NULLABLE FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'pass_hash'
);
SET @sql := IF(@nul = 'NO',
  'ALTER TABLE `devotees`
     MODIFY COLUMN `pass_hash` VARCHAR(255) NULL DEFAULT NULL
       COMMENT ''Legacy: only accounts made before 009 have one''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Phone lookup for duplicate detection ────────────────────────────────────
-- 003 already creates idx_phone; this only covers a database where it is missing.
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND INDEX_NAME = 'idx_phone'
);
SET @sql := IF(@idx = 0, 'ALTER TABLE `devotees` ADD INDEX `idx_phone` (`phone`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── devotees.duplicate_of ───────────────────────────────────────────────────
SET @had := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'duplicate_of'
);
SET @sql := IF(@had = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `duplicate_of` INT UNSIGNED NULL DEFAULT NULL
       COMMENT ''Earlier registration with the same phone; NULL when none, or cleared by the committee''
       AFTER `phone_country`,
     ADD INDEX `idx_duplicate_of` (`duplicate_of`),
     ADD CONSTRAINT `fk_devotee_duplicate_of`
       FOREIGN KEY (`duplicate_of`) REFERENCES `devotees` (`id`) ON DELETE SET NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Flag duplicates already on file, only in the run that created the column, so a
-- record the committee has marked "not a duplicate" is never flagged again.
SET @sql := IF(@had = 0,
  'UPDATE `devotees` d
     JOIN (SELECT `phone`, MIN(`id`) AS first_id
             FROM `devotees`
            WHERE `phone` IS NOT NULL AND `phone` <> ''''
            GROUP BY `phone`
           HAVING COUNT(*) > 1) g ON g.`phone` = d.`phone`
      SET d.`duplicate_of` = g.first_id
    WHERE d.`id` <> g.first_id',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── devotees.date_of_birth ──────────────────────────────────────────────────
-- Optional on the registration form. (Gender is deliberately not asked.)
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'date_of_birth'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `date_of_birth` DATE NULL DEFAULT NULL
       COMMENT ''optional''
       AFTER `name`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── devotees.lang ───────────────────────────────────────────────────────────
SET @had := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'lang'
);
SET @sql := IF(@had = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `lang` CHAR(2) NOT NULL DEFAULT ''ta''
       COMMENT ''ta or en: the language the temple writes to this family in''
       AFTER `postcode`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Keep the language an account holder had already chosen in their settings.
SET @sql := IF(@had = 0,
  'UPDATE `devotees` d
     JOIN `devotee_notification_prefs` p ON p.`devotee_id` = d.`id`
      SET d.`lang` = p.`lang`
    WHERE p.`lang` IN (''ta'', ''en'')',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── devotees.updates_consent_at / updates_consent_by ────────────────────────
-- Nobody is given consent here. Earlier accounts agreed to different wording (or
-- to nothing), so they receive only messages about their own bookings and
-- donations until they, or the committee with their permission, say yes.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'updates_consent_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `updates_consent_at` DATETIME NULL DEFAULT NULL
       COMMENT ''UTC; consent to temple updates by WhatsApp, SMS and email''
       AFTER `lang`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'updates_consent_by'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `updates_consent_by` VARCHAR(120) NULL DEFAULT NULL
       COMMENT ''NULL = the registration form; otherwise the committee member who recorded it''
       AFTER `updates_consent_at`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── devotees.unsubscribed_at ────────────────────────────────────────────────
SET @had := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'unsubscribed_at'
);
SET @sql := IF(@had = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `unsubscribed_at` DATETIME NULL DEFAULT NULL
       COMMENT ''UTC; withdrew consent to temple updates from a link in a message''
       AFTER `updates_consent_by`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- An unsubscribe already on file keeps counting.
SET @sql := IF(@had = 0,
  'UPDATE `devotees` d
     JOIN `devotee_notification_prefs` p ON p.`devotee_id` = d.`id`
      SET d.`unsubscribed_at` = p.`unsubscribed_at`
    WHERE p.`unsubscribed_at` IS NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Family members ──────────────────────────────────────────────────────────
-- relationship holds a key from the list in backend/includes/registration.php
-- (wife, son, daughter, ...). VARCHAR rather than ENUM so a new relationship
-- needs no migration. The registrant is not a row here.
CREATE TABLE IF NOT EXISTS `devotee_family_members` (
  `id`           INT UNSIGNED      NOT NULL AUTO_INCREMENT,
  `devotee_id`   INT UNSIGNED      NOT NULL COMMENT 'the registration this member belongs to',
  `name`         VARCHAR(120)      NOT NULL,
  `relationship` VARCHAR(32)       NOT NULL COMMENT 'relationship to the registrant, as a key',
  `age`          TINYINT UNSIGNED  NULL DEFAULT NULL COMMENT '0 to 120, optional',
  `sort_order`   SMALLINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'the order entered on the form',
  `created_at`   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_devotee_order` (`devotee_id`, `sort_order`),
  CONSTRAINT `chk_member_age` CHECK (`age` IS NULL OR `age` <= 120),
  CONSTRAINT `fk_member_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── seva_bookings.lang / donations.lang ─────────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'lang'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `lang` CHAR(2) NOT NULL DEFAULT ''ta''
       COMMENT ''ta or en: the site language the booking was sent in''
       AFTER `message`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'lang'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `lang` CHAR(2) NOT NULL DEFAULT ''ta''
       COMMENT ''ta or en: the site language the pledge was sent in''
       AFTER `message`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── Retire what only devotee sign-in used ───────────────────────────────────
-- In-app and push deliveries still waiting to go out would be sent to a bell
-- and to devices nobody can reach any more.
UPDATE `notification_deliveries`
   SET `status` = 'cancelled', `next_attempt_at` = NULL, `claim_token` = NULL
 WHERE `channel` IN ('inapp', 'push')
   AND `status` IN ('queued', 'sending', 'failed');

-- Automatic reminder campaigns that had no other channel are cancelled; the
-- reminders now create their own campaigns on the remaining channels.
UPDATE `notification_campaigns`
   SET `status` = 'cancelled'
 WHERE `created_by` = 'system'
   AND `status` IN ('draft', 'review', 'approved', 'scheduled', 'sending')
   AND TRIM(BOTH ',' FROM REPLACE(REPLACE(CONCAT(',', `channels`, ','), ',inapp,', ','), ',push,', ',')) = '';

-- Campaigns that are still open lose the two channels. Finished campaigns keep
-- theirs, so their history still says how they were sent.
UPDATE `notification_campaigns`
   SET `channels` = TRIM(BOTH ',' FROM REPLACE(REPLACE(CONCAT(',', `channels`, ','), ',inapp,', ','), ',push,', ','))
 WHERE `status` IN ('draft', 'review', 'approved', 'scheduled', 'sending')
   AND (FIND_IN_SET('inapp', `channels`) > 0 OR FIND_IN_SET('push', `channels`) > 0);

-- An open campaign left with no channel becomes an email draft for the
-- committee to look at again: whatever was approved was approved for other
-- channels.
UPDATE `notification_campaigns`
   SET `channels` = 'email',
       `status`   = IF(`status` IN ('approved', 'scheduled', 'sending'), 'draft', `status`)
 WHERE `status` IN ('draft', 'review', 'approved', 'scheduled', 'sending')
   AND `channels` = '';

-- Committee edits to wording nobody can receive any more.
DELETE FROM `notification_templates` WHERE `channel` IN ('inapp', 'push');
DELETE FROM `notification_templates`
 WHERE `template_key` IN ('welcome', 'email_verification', 'email_verified', 'password_reset',
                          'password_changed', 'profile_updated', 'phone_otp', 'phone_verified');

-- Security messages were about accounts. Promotional messages were never part
-- of what devotees agree to on the registration form.
UPDATE `notification_categories` SET `is_active` = 0 WHERE `key` IN ('security', 'promotional');

-- The web push key pair and the cached FCM access token.
DELETE FROM `notification_kv` WHERE `k` IN ('vapid_public', 'vapid_private', 'fcm_token');
