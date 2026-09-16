-- 010_payments.sql
--
-- Online payments through CCAvenue for donations and seva bookings
-- (docs/payments/SPEC.md §3). One payments module serves both: the thing being
-- paid for is a "payable" (an online donation or an online seva booking), and
-- every trip to CCAvenue is one row in payment_transactions.
--
-- Pledges ("I will donate") and request-only seva bookings keep working exactly
-- as before: every new column on donations and seva_bookings is NULL or has a
-- default that describes them (source = 'pledge', payment_mode = 'offline').
--
-- Every new DATETIME column is UTC, written by the application with
-- UTC_TIMESTAMP(). ("Today / this month" are worked out for Asia/Kolkata in PHP.)
--
-- donation_categories        the purposes donors can give to, managed by the
--                            committee. slug is what donations.purpose stores,
--                            so the old pledge purposes (kumbabhishekam,
--                            annadanam_hall, annadanam, abhishekam, festival,
--                            maintenance, other) keep their meaning.
--   slug                     ^[a-z0-9_]{2,40}$, never changes once created
--   name_ta, name_en         the label in Tamil and English
--   description_ta/_en       one line shown under the label on the Donate page
--   suggested_amount         INR amount filled in when the category is picked
--   sort_order               smaller first
--   is_active                0 hides it from donors; old rows still label
--
-- donations (extended)
--   source                   'pledge' (the pledge form, bulk import) or 'online'
--   donation_number          DON-YYYYMMDD-NNNNNNNN, online only (IST date, row id)
--   category_id              donation_categories.id; NULL for free-text purposes
--   currency                 ISO 4217; pledges are INR
--   email                    optional, for the receipt
--   country                  the donor's country, ISO 3166-1 alpha-2
--   address_line, city,
--   state, postcode          optional billing address
--   pan                      optional, for an 80G receipt: ABCDE1234F
--   notes                    the donor's private note to the office ("message"
--                            stays the message the donor wrote)
--   status                   INITIATED, PENDING, SUCCESS, FAILED, CANCELLED,
--                            REFUND_INITIATED, PARTIALLY_REFUNDED, REFUNDED;
--                            NULL for pledges. VARCHAR so the list can grow.
--   receipt_number           TMR-2026-000042, assigned once on the first SUCCESS
--   paid_at                  UTC time of the first SUCCESS
--   amount_refunded          sum of the successful refunds
--   updated_at               UTC
--
-- seva_bookings (extended)
--   payment_mode             'offline' (a booking request) or 'online'
--   order_number             SEV-YYYYMMDD-NNNNNNNN, online only
--   email                    optional, for the receipt
--   amount, currency         the seva's price copied at booking time, INR
--   payment_status           same list as donations.status; NULL for requests
--   receipt_number, paid_at, amount_refunded, updated_at   as for donations
--   hold_expires_at          UTC; an unpaid online booking is cancelled after it
--
-- payment_transactions       one row per attempt to pay at CCAvenue. order_id is
--                            the number for attempt 1 and number-Rn after that.
--                            environment is the gateway mode the attempt was
--                            created in; its response is decrypted with that
--                            environment's key. gateway_response keeps only an
--                            allow-list of response fields, never card data.
--                            verification is the strongest evidence so far:
--                            none, callback (the browser return or notification),
--                            status_api (confirmed server to server) or manual.
-- payment_refunds            one row per refund; never overwrites the payment.
-- payment_audit_log          append-only history of every payment event. detail
--                            and data are redacted; never credentials.
-- payment_settings           gateway settings from Admin → Payment Gateway.
--                            Secrets are stored encrypted ("sbx1:…") with the
--                            key in PAYMENTS_SETTINGS_KEY, never in plain text.
-- payment_counters           gap-free sequences (receipt:2026) and the local
--                            simulator's recorded outcomes (sim:<order id>).
--
-- No notification category is added: 'payment' and 'donation' already exist
-- and are transactional (007).
--
-- Requires 001 to 009. Safe to re-run: tables use IF NOT EXISTS, columns and
-- indexes are checked in information_schema first, seeds use INSERT IGNORE, and
-- the category backfill runs only in the run that creates the column.
--
-- Apply with a utf8mb4 client, for example:
--   mysql --default-character-set=utf8mb4 -u <user> -p <db> < database/migrations/010_payments.sql
-- A latin1 client stores the Tamil category names garbled.

-- ── donation_categories ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `donation_categories` (
  `id`               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `slug`             VARCHAR(40)   NOT NULL COMMENT '^[a-z0-9_]{2,40}$; stored in donations.purpose',
  `name_ta`          VARCHAR(120)  NOT NULL,
  `name_en`          VARCHAR(120)  NOT NULL,
  `description_ta`   VARCHAR(500)  NULL DEFAULT NULL,
  `description_en`   VARCHAR(500)  NULL DEFAULT NULL,
  `suggested_amount` DECIMAL(12,2) NULL DEFAULT NULL COMMENT 'INR; pre-fills the amount on the Donate page',
  `sort_order`       INT           NOT NULL DEFAULT 0,
  `is_active`        TINYINT(1)    NOT NULL DEFAULT 1 COMMENT '0 = hidden from donors, still labels old rows',
  `created_at`       DATETIME      NOT NULL COMMENT 'UTC',
  `updated_at`       DATETIME      NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_slug` (`slug`),
  KEY `idx_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `donation_categories`
  (`slug`, `name_ta`, `name_en`, `description_ta`, `description_en`, `suggested_amount`, `sort_order`, `is_active`, `created_at`, `updated_at`)
VALUES
  ('general',            'பொது நன்கொடை',              'General Donation',             'கோயிலுக்கு மிகத் தேவையான இடத்தில் அறக்கட்டளை பயன்படுத்தும்.', 'Used by the Trust wherever the temple needs it most.', NULL, 10, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('temple_development', 'கோயில் மேம்பாடு',            'Temple Development',           'கோயில் மற்றும் வளாக மேம்பாட்டுப் பணிகளுக்கு.',               'Improvements to the temple and its grounds.',           NULL, 20, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('kumbabhishekam',     'கும்பாபிஷேகம்',              'Kumbabhishekam',               'கோயில் கும்பாபிஷேகத் திருப்பணிகளுக்கு.',                     'Towards the temple''s Kumbabhishekam renovation.',      NULL, 30, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('annadanam',          'அன்னதானம்',                  'Annadhanam',                   'பக்தர்களுக்கு அன்னதானம் வழங்க.',                               'Free meals served to devotees.',                        NULL, 40, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('annadanam_hall',     'அன்னதான கூடம் கட்டுமானம்',   'Annadanam Hall construction',  'அன்னதான கூடம் கட்டுவதற்கு.',                                   'Building the hall where meals are served.',             NULL, 50, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('pooja_seva',         'பூஜை / சேவை',                'Pooja / Seva',                 'கோயிலின் தினசரி பூஜைகள் மற்றும் சேவைகளுக்கு.',                'Daily poojas and sevas at the temple.',                 NULL, 60, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('abhishekam',         'அபிஷேகம்',                   'Abhishekam',                   'அபிஷேகச் செலவுகளுக்கு.',                                       'Towards abhishekam offerings.',                         NULL, 70, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('education',          'கல்வி உதவி',                 'Education Support',            'மாணவர்களின் கல்விக்கு உதவ.',                                   'Helping students with their education.',                NULL, 80, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('medical',            'மருத்துவ உதவி',              'Medical Assistance',           'தேவைப்படுவோரின் மருத்துவச் செலவுகளுக்கு உதவ.',                'Help with medical expenses for those in need.',         NULL, 90, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('festival',           'திருவிழா நிதி',              'Festival Contribution',        'கோயில் திருவிழாக்களுக்கு.',                                     'Towards the temple''s festivals.',                      NULL, 100, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('building_fund',      'கட்டிட நிதி',                'Building Fund',                'கோயில் கட்டிடப் பணிகளுக்கு.',                                   'Construction work at the temple.',                      NULL, 110, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('maintenance',        'கோயில் பராமரிப்பு',          'Maintenance Fund',             'கோயிலின் அன்றாடப் பராமரிப்புக்கு.',                             'Upkeep and maintenance of the temple.',                 NULL, 120, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP()),
  ('other',              'மற்றவை',                     'Other',                        'மேலே இல்லாத தேவைகளுக்கு; செய்தியில் குறிப்பிடுங்கள்.',          'Any other purpose; tell us in the message.',            NULL, 130, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP());

-- ── donations: online payment columns ───────────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'source'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `source` ENUM(''pledge'',''online'') NOT NULL DEFAULT ''pledge''
       COMMENT ''pledge = the pledge form or an import; online = paid through CCAvenue''
       AFTER `id`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'donation_number'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `donation_number` VARCHAR(30) NULL DEFAULT NULL
       COMMENT ''DON-YYYYMMDD-NNNNNNNN; online donations only''
       AFTER `source`,
     ADD UNIQUE KEY `uniq_donation_number` (`donation_number`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @had := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'category_id'
);
SET @sql := IF(@had = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `category_id` INT UNSIGNED NULL DEFAULT NULL
       COMMENT ''donation_categories.id; NULL for a purpose that is not a category''
       AFTER `purpose`,
     ADD KEY `idx_category` (`category_id`),
     ADD CONSTRAINT `fk_donation_category`
       FOREIGN KEY (`category_id`) REFERENCES `donation_categories` (`id`) ON DELETE SET NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Old pledges whose purpose is a category slug get the link, only in the run
-- that created the column.
SET @sql := IF(@had = 0,
  'UPDATE `donations` d
     JOIN `donation_categories` c ON c.`slug` = d.`purpose`
      SET d.`category_id` = c.`id`
    WHERE d.`category_id` IS NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'currency'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `currency` CHAR(3) NOT NULL DEFAULT ''INR''
       COMMENT ''ISO 4217; pledges are INR''
       AFTER `amount`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'email'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `email` VARCHAR(190) NULL DEFAULT NULL
       COMMENT ''optional; where the receipt is emailed''
       AFTER `phone_country`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'country'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `country` CHAR(2) NULL DEFAULT NULL
       COMMENT ''the donor''''s country, ISO 3166-1 alpha-2''
       AFTER `email`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'address_line'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `address_line` VARCHAR(250) NULL DEFAULT NULL COMMENT ''optional billing address'' AFTER `country`,
     ADD COLUMN `city`         VARCHAR(120) NULL DEFAULT NULL AFTER `address_line`,
     ADD COLUMN `state`        VARCHAR(120) NULL DEFAULT NULL AFTER `city`,
     ADD COLUMN `postcode`     VARCHAR(15)  NULL DEFAULT NULL AFTER `state`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- city/state/postcode normally arrive with address_line above; each is also
-- checked on its own so a partly applied database is completed.
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'city'
);
SET @sql := IF(@col = 0, 'ALTER TABLE `donations` ADD COLUMN `city` VARCHAR(120) NULL DEFAULT NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'state'
);
SET @sql := IF(@col = 0, 'ALTER TABLE `donations` ADD COLUMN `state` VARCHAR(120) NULL DEFAULT NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'postcode'
);
SET @sql := IF(@col = 0, 'ALTER TABLE `donations` ADD COLUMN `postcode` VARCHAR(15) NULL DEFAULT NULL', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'pan'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `pan` VARCHAR(10) NULL DEFAULT NULL
       COMMENT ''optional, uppercase ABCDE1234F, for an 80G receipt''
       AFTER `postcode`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'notes'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `notes` VARCHAR(500) NULL DEFAULT NULL
       COMMENT ''the donor''''s private note to the office''
       AFTER `message`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'status'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `status` VARCHAR(20) NULL DEFAULT NULL
       COMMENT ''online payment status (docs/payments/SPEC.md §2.1); NULL for pledges''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'receipt_number'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `receipt_number` VARCHAR(40) NULL DEFAULT NULL
       COMMENT ''PREFIX-YYYY-NNNNNN, assigned once on the first SUCCESS'',
     ADD UNIQUE KEY `uniq_receipt_number` (`receipt_number`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'paid_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `paid_at` DATETIME NULL DEFAULT NULL COMMENT ''UTC; first SUCCESS''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'amount_refunded'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `amount_refunded` DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT ''sum of SUCCESS refunds''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'updated_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `donations`
     ADD COLUMN `updated_at` DATETIME NULL DEFAULT NULL COMMENT ''UTC''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND INDEX_NAME = 'idx_source_status'
);
SET @sql := IF(@idx = 0, 'ALTER TABLE `donations` ADD INDEX `idx_source_status` (`source`, `status`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND INDEX_NAME = 'idx_paid_at'
);
SET @sql := IF(@idx = 0, 'ALTER TABLE `donations` ADD INDEX `idx_paid_at` (`paid_at`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── seva_bookings: online payment columns ───────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'payment_mode'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `payment_mode` ENUM(''offline'',''online'') NOT NULL DEFAULT ''offline''
       COMMENT ''offline = a booking request paid at the temple; online = paid through CCAvenue''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'order_number'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `order_number` VARCHAR(30) NULL DEFAULT NULL
       COMMENT ''SEV-YYYYMMDD-NNNNNNNN; online bookings only'',
     ADD UNIQUE KEY `uniq_order_number` (`order_number`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'email'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `email` VARCHAR(190) NULL DEFAULT NULL COMMENT ''optional; where the receipt is emailed''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'amount'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `amount` DECIMAL(10,2) NULL DEFAULT NULL COMMENT ''sevas.amount copied at booking time''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'currency'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `currency` CHAR(3) NULL DEFAULT NULL COMMENT ''INR for online bookings''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'payment_status'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `payment_status` VARCHAR(20) NULL DEFAULT NULL
       COMMENT ''online payment status (docs/payments/SPEC.md §2.1); NULL for requests''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'receipt_number'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `receipt_number` VARCHAR(40) NULL DEFAULT NULL
       COMMENT ''PREFIX-YYYY-NNNNNN, assigned once on the first SUCCESS'',
     ADD UNIQUE KEY `uniq_receipt_number` (`receipt_number`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'paid_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `paid_at` DATETIME NULL DEFAULT NULL COMMENT ''UTC; first SUCCESS''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'amount_refunded'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `amount_refunded` DECIMAL(10,2) NOT NULL DEFAULT 0.00 COMMENT ''sum of SUCCESS refunds''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'hold_expires_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `hold_expires_at` DATETIME NULL DEFAULT NULL
       COMMENT ''UTC; an unpaid online booking is cancelled after this''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND COLUMN_NAME = 'updated_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `seva_bookings`
     ADD COLUMN `updated_at` DATETIME NULL DEFAULT NULL COMMENT ''UTC''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'seva_bookings' AND INDEX_NAME = 'idx_payment'
);
SET @sql := IF(@idx = 0, 'ALTER TABLE `seva_bookings` ADD INDEX `idx_payment` (`payment_mode`, `payment_status`)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ── payment_transactions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `payment_transactions` (
  `id`               INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  `payable_type`     ENUM('donation','seva_booking') NOT NULL,
  `payable_id`       INT UNSIGNED     NOT NULL COMMENT 'donations.id or seva_bookings.id (no FK: two parents)',
  `attempt`          TINYINT UNSIGNED NOT NULL COMMENT '1 for the first trip to CCAvenue, then 2 to 5',
  `order_id`         VARCHAR(30)      NOT NULL COMMENT 'sent to CCAvenue: the number, or number-Rn',
  `gateway`          VARCHAR(20)      NOT NULL DEFAULT 'ccavenue',
  `environment`      ENUM('test','production','simulator') NOT NULL COMMENT 'gateway mode when the attempt was created',
  `amount`           DECIMAL(12,2)    NOT NULL,
  `currency`         CHAR(3)          NOT NULL,
  `status`           VARCHAR(20)      NOT NULL DEFAULT 'INITIATED' COMMENT 'INITIATED, PENDING, SUCCESS, FAILED, CANCELLED',
  `gateway_status`   VARCHAR(40)      NULL DEFAULT NULL COMMENT 'raw order_status last seen',
  `tracking_id`      VARCHAR(40)      NULL DEFAULT NULL COMMENT 'CCAvenue reference (reference_no in the API)',
  `bank_ref_no`      VARCHAR(100)     NULL DEFAULT NULL,
  `payment_mode`     VARCHAR(40)      NULL DEFAULT NULL COMMENT 'e.g. UPI, Credit Card',
  `card_name`        VARCHAR(60)      NULL DEFAULT NULL,
  `failure_message`  VARCHAR(255)     NULL DEFAULT NULL,
  `status_code`      VARCHAR(10)      NULL DEFAULT NULL,
  `status_message`   VARCHAR(255)     NULL DEFAULT NULL,
  `gateway_response` JSON             NULL DEFAULT NULL COMMENT 'last decrypted response, allow-listed keys only',
  `response_count`   INT UNSIGNED     NOT NULL DEFAULT 0 COMMENT 'callbacks received',
  `verification`     ENUM('none','callback','status_api','manual') NOT NULL DEFAULT 'none' COMMENT 'strongest evidence so far',
  `needs_review`     TINYINT(1)       NOT NULL DEFAULT 0 COMMENT 'mismatch, double payment, unverified success',
  `lang`             CHAR(2)          NOT NULL DEFAULT 'ta',
  `client_ip`        VARCHAR(45)      NULL DEFAULT NULL,
  `redirected_at`    DATETIME         NULL DEFAULT NULL COMMENT 'UTC; checkout fields issued',
  `responded_at`     DATETIME         NULL DEFAULT NULL COMMENT 'UTC; last gateway response',
  `verified_at`      DATETIME         NULL DEFAULT NULL COMMENT 'UTC; confirmed with the status API',
  `last_checked_at`  DATETIME         NULL DEFAULT NULL COMMENT 'UTC; last reconciliation check',
  `created_at`       DATETIME         NOT NULL COMMENT 'UTC',
  `updated_at`       DATETIME         NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_order_id` (`order_id`),
  UNIQUE KEY `uniq_tracking_id` (`tracking_id`),
  KEY `idx_payable` (`payable_type`, `payable_id`),
  KEY `idx_status_created` (`status`, `created_at`),
  KEY `idx_review` (`needs_review`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── payment_refunds ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `payment_refunds` (
  `id`                INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `transaction_id`    INT UNSIGNED  NOT NULL COMMENT 'the SUCCESS attempt refunded',
  `refund_reference`  VARCHAR(30)   NOT NULL COMMENT 'ours, sent as refund_ref_no: RF<transaction id>T<unix time>',
  `amount`            DECIMAL(12,2) NOT NULL,
  `currency`          CHAR(3)       NOT NULL,
  `kind`              ENUM('full','partial') NOT NULL,
  `reason`            VARCHAR(500)  NOT NULL,
  `method`            ENUM('gateway_api','manual') NOT NULL,
  `status`            ENUM('REQUESTED','PROCESSING','SUCCESS','FAILED') NOT NULL,
  `gateway_reference` VARCHAR(60)   NULL DEFAULT NULL,
  `gateway_message`   VARCHAR(255)  NULL DEFAULT NULL,
  `requested_by`      VARCHAR(60)   NOT NULL COMMENT 'admin username',
  `created_at`        DATETIME      NOT NULL COMMENT 'UTC',
  `updated_at`        DATETIME      NOT NULL COMMENT 'UTC',
  `processed_at`      DATETIME      NULL DEFAULT NULL COMMENT 'UTC; became SUCCESS or FAILED',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_refund_reference` (`refund_reference`),
  KEY `idx_transaction` (`transaction_id`),
  KEY `idx_status` (`status`, `created_at`),
  CONSTRAINT `fk_refund_transaction`
    FOREIGN KEY (`transaction_id`) REFERENCES `payment_transactions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── payment_audit_log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `payment_audit_log` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `transaction_id` INT UNSIGNED    NULL DEFAULT NULL,
  `payable_type`   ENUM('donation','seva_booking') NULL DEFAULT NULL,
  `payable_id`     INT UNSIGNED    NULL DEFAULT NULL,
  `event`          VARCHAR(48)     NOT NULL COMMENT 'vocabulary in docs/payments/SPEC.md §5.4',
  `detail`         VARCHAR(1000)   NULL DEFAULT NULL COMMENT 'a readable sentence, redacted',
  `data`           JSON            NULL DEFAULT NULL COMMENT 'small structured facts, redacted; never credentials',
  `actor`          VARCHAR(60)     NOT NULL COMMENT 'system, gateway, donor, cron, or the admin username',
  `ip`             VARCHAR(45)     NULL DEFAULT NULL,
  `created_at`     DATETIME(3)     NOT NULL COMMENT 'UTC, millisecond order',
  PRIMARY KEY (`id`),
  KEY `idx_transaction` (`transaction_id`),
  KEY `idx_payable` (`payable_type`, `payable_id`),
  KEY `idx_event_created` (`event`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── payment_settings ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `payment_settings` (
  `k`          VARCHAR(64) NOT NULL,
  `v`          TEXT        NOT NULL COMMENT 'plain for settings; sbx1:base64(nonce+secretbox) for secrets',
  `is_secret`  TINYINT(1)  NOT NULL DEFAULT 0,
  `updated_by` VARCHAR(60) NULL DEFAULT NULL,
  `updated_at` DATETIME    NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Payments start OFF, in TEST mode, INR only. A re-run never overwrites what
-- the committee has changed.
INSERT IGNORE INTO `payment_settings` (`k`, `v`, `is_secret`, `updated_by`, `updated_at`) VALUES
  ('enabled',               '0',                      0, 'migration', UTC_TIMESTAMP()),
  ('mode',                  'test',                   0, 'migration', UTC_TIMESTAMP()),
  ('default_currency',      'INR',                    0, 'migration', UTC_TIMESTAMP()),
  ('currencies',            'INR',                    0, 'migration', UTC_TIMESTAMP()),
  ('international_enabled', '0',                      0, 'migration', UTC_TIMESTAMP()),
  ('receipt_prefix',        'TMR',                    0, 'migration', UTC_TIMESTAMP()),
  ('donation_min',          '1',                      0, 'migration', UTC_TIMESTAMP()),
  ('donation_max',          '500000',                 0, 'migration', UTC_TIMESTAMP()),
  ('donation_max_foreign',  '10000',                  0, 'migration', UTC_TIMESTAMP()),
  ('preset_amounts',        '500,1000,2500,5000,10000', 0, 'migration', UTC_TIMESTAMP()),
  ('notify_email',          '1',                      0, 'migration', UTC_TIMESTAMP()),
  ('notify_sms',            '0',                      0, 'migration', UTC_TIMESTAMP()),
  ('notify_whatsapp',       '1',                      0, 'migration', UTC_TIMESTAMP()),
  ('seva_online_enabled',   '0',                      0, 'migration', UTC_TIMESTAMP()),
  ('hold_minutes',          '30',                     0, 'migration', UTC_TIMESTAMP());

-- ── payment_counters ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `payment_counters` (
  `name`       VARCHAR(40)  NOT NULL COMMENT 'receipt:<IST year>, or sim:<order id> for the local simulator',
  `value`      INT UNSIGNED NOT NULL,
  `updated_at` DATETIME     NULL DEFAULT NULL COMMENT 'UTC',
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
