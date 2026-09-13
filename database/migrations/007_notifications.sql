-- ============================================================
-- 007_notifications.sql — the notification system
--
-- One service, many channels. Every module that wants to reach a devotee calls
-- the Notification Service (backend/includes/notify.php) instead of talking to
-- an email, WhatsApp, SMS or push provider itself. docs/notifications/SPEC.md
-- describes the whole design; this file is its data model.
--
-- TIME. Every DATETIME in these tables is UTC, written explicitly with
-- UTC_TIMESTAMP() by the service. Column defaults exist only as a floor. The
-- admin shows times in the temple's timezone and the devotee's browser shows
-- them in the devotee's own, both converting from UTC.
--
-- The tables, and why each exists:
--
--   notification_categories     What a notification is about. Configurable in
--                               the admin. `kind` decides whether a devotee may
--                               opt out: transactional, security and critical
--                               messages cannot be muted; informational and
--                               promotional ones can. Promotional is off until
--                               the devotee opts in.
--
--   notification_templates      The words, per template key × language ×
--                               channel. `channel` = 'any' is the shared
--                               version; a row for a specific channel overrides
--                               it (a 160-character SMS and a full email can
--                               share one key). Built-in defaults ship in PHP,
--                               so the system works before anyone edits a row.
--
--   notification_campaigns      An admin-composed send: audience, channels,
--   notification_campaign_translations   schedule, recurrence and the approval
--                               state (draft → review → approved → scheduled →
--                               sending → completed). Words live in the
--                               translations table so a language is a row, not a
--                               column — Hindi or Telugu needs no migration.
--
--   notification_segments       Saved audiences ("Donors in Tamil Nadu").
--   devotee_tags                Free-form labels the committee applies to
--                               devotees (volunteer, member, interest:annadanam).
--                               The site holds no volunteer or membership data of
--                               its own, so tags are how those groups exist.
--
--   notifications               One row per recipient per notification. It IS
--                               the in-app record the bell reads and the
--                               canonical copy every channel delivers.
--                               `dedupe_key` is unique: the same booking
--                               confirmed twice cannot notify twice.
--
--   notification_deliveries     One row per (notification, channel). This is the
--                               queue. A cron worker claims due rows atomically
--                               (claim_token), sends, records what the provider
--                               said, and retries with backoff until
--                               max_attempts, after which the row is 'dead' and
--                               kept for the admin to see and requeue.
--
--   notification_delivery_events  Timeline per delivery (queued, sent, webhook
--                               delivered, read, clicked, failed, retried) for
--                               troubleshooting and analytics.
--
--   devotee_notification_prefs  Per devotee: channels, muted categories,
--                               language, timezone, promotional consent. An
--                               absent row means every default applies.
--
--   devotee_devices             Push subscriptions (Web Push now, FCM/APNs for a
--                               native app later). One devotee, many devices.
--
--   devotee_otps                One-time codes for mobile verification. Only a
--                               keyed hash of the code is stored.
--
--   notification_audit          Who created, edited, submitted, approved,
--                               scheduled, sent, cancelled or retried what, with
--                               the message as it stood at that moment.
--
--   notification_worker_runs    One row per worker run, so the admin can see the
--                               cron is alive — on shared hosting a silently
--                               stopped cron is the most likely failure.
--
--   notification_kv             Small internal settings the service generates
--                               for itself when the environment does not supply
--                               them (a signing secret, development VAPID keys).
--                               Never provider credentials: those live only in
--                               the environment.
--
-- Also adds devotees.phone_verified_at.
--
-- Requires 003_devotee_accounts.sql. Safe to run on an existing database and
-- safe to re-run.
--
--   mysql -u <user> -p <db> < database/migrations/007_notifications.sql
-- ============================================================

-- ── Categories ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_categories` (
  `key`         VARCHAR(32)  NOT NULL,
  `label_ta`    VARCHAR(120) NOT NULL,
  `label_en`    VARCHAR(120) NOT NULL,
  `icon`        VARCHAR(32)  NOT NULL DEFAULT 'bell' COMMENT 'Lucide icon name',
  `kind`        ENUM('transactional','security','critical','informational','promotional') NOT NULL DEFAULT 'informational',
  `default_on`  TINYINT(1)   NOT NULL DEFAULT 1 COMMENT 'for mutable kinds: on unless the devotee opts out',
  `is_active`   TINYINT(1)   NOT NULL DEFAULT 1,
  `sort_order`  SMALLINT     NOT NULL DEFAULT 100,
  `updated_by`  VARCHAR(120) NULL,
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`),
  KEY `idx_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- INSERT IGNORE: re-running never overwrites labels the committee has edited.
INSERT IGNORE INTO `notification_categories` (`key`, `label_ta`, `label_en`, `icon`, `kind`, `default_on`, `sort_order`) VALUES
  ('general',          'பொது',                 'General',              'bell',            'informational', 1, 10),
  ('announcement',     'கோயில் அறிவிப்பு',      'Temple announcement',  'megaphone',       'informational', 1, 20),
  ('festival',         'திருவிழா',              'Festival',             'party-popper',    'informational', 1, 30),
  ('pooja',            'பூஜை',                  'Pooja',                'flame',           'informational', 1, 40),
  ('event',            'நிகழ்வு',               'Event',                'calendar-days',   'informational', 1, 50),
  ('special_darshan',  'சிறப்பு தரிசனம்',       'Special darshan',      'sparkles',        'informational', 1, 60),
  ('booking',          'சேவை பதிவு',            'Booking',              'calendar-check',  'transactional', 1, 70),
  ('donation',         'நன்கொடை',              'Donation',             'heart-handshake', 'transactional', 1, 80),
  ('payment',          'கட்டணம்',               'Payment',              'credit-card',     'transactional', 1, 90),
  ('volunteer',        'தன்னார்வலர்',          'Volunteer',            'hand-heart',      'informational', 1, 100),
  ('membership',       'உறுப்பினர்',           'Membership',           'badge-check',     'transactional', 1, 110),
  ('administrative',   'நிர்வாகம்',             'Administrative',       'landmark',        'informational', 1, 120),
  ('emergency',        'அவசரம்',               'Emergency',            'siren',           'critical',      1, 130),
  ('security',         'பாதுகாப்பு',            'Security',             'shield-check',    'security',      1, 140),
  ('promotional',      'சிறப்புச் சலுகைகள்',     'Promotional',          'gift',            'promotional',   0, 150);

-- ── Templates ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_templates` (
  `id`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_key`      VARCHAR(64)  NOT NULL COMMENT 'booking_confirmed, donation_receipt, …',
  `lang`              VARCHAR(8)   NOT NULL DEFAULT 'ta' COMMENT 'ta, en, hi, te, ml, kn, …',
  `channel`           ENUM('any','inapp','email','whatsapp','sms','push') NOT NULL DEFAULT 'any',
  `title`             VARCHAR(200) NOT NULL COMMENT 'subject / push title / in-app title; {{variables}}',
  `body`              TEXT         NOT NULL COMMENT 'plain text with {{variables}}; blank line = paragraph',
  `cta_label`         VARCHAR(80)  NULL,
  `provider_template` VARCHAR(160) NULL COMMENT 'approved WhatsApp template name, or SMS DLT template id',
  `provider_params`   JSON         NULL COMMENT 'ordered variable names for the provider template',
  `is_active`         TINYINT(1)   NOT NULL DEFAULT 1,
  `updated_by`        VARCHAR(120) NULL,
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_template` (`template_key`, `lang`, `channel`),
  KEY `idx_key_active` (`template_key`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Segments and tags ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_segments` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(120) NOT NULL,
  `description` VARCHAR(300) NULL,
  `rules`       JSON         NOT NULL COMMENT 'audience rules, see SPEC.md §Audience',
  `created_by`  VARCHAR(120) NULL,
  `updated_by`  VARCHAR(120) NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `devotee_tags` (
  `devotee_id` INT UNSIGNED NOT NULL,
  `tag`        VARCHAR(40)  NOT NULL COMMENT 'lowercase: volunteer, member, interest:annadanam',
  `created_by` VARCHAR(120) NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`devotee_id`, `tag`),
  KEY `idx_tag` (`tag`),
  CONSTRAINT `fk_tag_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Campaigns ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_campaigns` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`             VARCHAR(160) NOT NULL COMMENT 'internal label, never shown to a devotee',
  `category`         VARCHAR(32)  NOT NULL DEFAULT 'announcement',
  `priority`         ENUM('normal','important','urgent','emergency') NOT NULL DEFAULT 'normal',
  `channels`         VARCHAR(80)  NOT NULL DEFAULT 'inapp' COMMENT 'comma list of inapp,email,whatsapp,push,sms',
  `cta_url`          VARCHAR(500) NULL COMMENT 'site path (/sevas) or https URL',
  `image_url`        VARCHAR(500) NULL,
  `template_key`     VARCHAR(64)  NULL COMMENT 'set when composed from a template instead of free text',
  `template_vars`    JSON         NULL,
  `segment_id`       INT UNSIGNED NULL,
  `audience`         JSON         NULL COMMENT 'audience rules when not a saved segment',
  `estimated_count`  INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'at the last estimate, for the approver',
  `recipient_count`  INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'as actually materialised, across runs',
  `status`           ENUM('draft','review','approved','scheduled','sending','completed','cancelled','failed') NOT NULL DEFAULT 'draft',
  `requires_approval` TINYINT(1)  NOT NULL DEFAULT 0,
  `approval_reason`  VARCHAR(200) NULL COMMENT 'why this campaign needs a second pair of eyes',
  `schedule_tz`      ENUM('temple','recipient') NOT NULL DEFAULT 'temple',
  `scheduled_local`  DATETIME     NULL COMMENT 'wall-clock time as the admin entered it',
  `scheduled_at`     DATETIME     NULL COMMENT 'UTC; for recipient mode the earliest possible instant',
  `recurrence`       ENUM('none','daily','weekly','monthly') NOT NULL DEFAULT 'none',
  `recur_until`      DATE         NULL,
  `next_run_at`      DATETIME     NULL COMMENT 'UTC instant the worker next expands this campaign',
  `run_count`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `expand_cursor`    INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'last devotee id expanded in the current run',
  `last_error`       VARCHAR(500) NULL,
  `created_by`       VARCHAR(120) NULL,
  `updated_by`       VARCHAR(120) NULL,
  `submitted_by`     VARCHAR(120) NULL,
  `submitted_at`     DATETIME     NULL,
  `approved_by`      VARCHAR(120) NULL,
  `approved_at`      DATETIME     NULL,
  `sent_by`          VARCHAR(120) NULL,
  `cancelled_by`     VARCHAR(120) NULL,
  `cancelled_at`     DATETIME     NULL,
  `started_at`       DATETIME     NULL,
  `completed_at`     DATETIME     NULL,
  `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_status_next` (`status`, `next_run_at`),
  KEY `idx_created` (`created_at`),
  KEY `idx_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notification_campaign_translations` (
  `campaign_id` INT UNSIGNED NOT NULL,
  `lang`        VARCHAR(8)   NOT NULL,
  `title`       VARCHAR(200) NOT NULL,
  `body`        TEXT         NOT NULL,
  `cta_label`   VARCHAR(80)  NULL,
  PRIMARY KEY (`campaign_id`, `lang`),
  CONSTRAINT `fk_ctr_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `notification_campaigns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Notifications ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id`    INT UNSIGNED NULL,
  `run_no`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `devotee_id`     INT UNSIGNED NULL COMMENT 'NULL for a guest reached only by phone or email',
  `recipient_type` ENUM('devotee','guest') NOT NULL DEFAULT 'devotee',
  `to_email`       VARCHAR(190) NULL,
  `to_phone`       VARCHAR(20)  NULL COMMENT 'E.164 digits, no plus',
  `lang`           VARCHAR(8)   NOT NULL DEFAULT 'ta',
  `template_key`   VARCHAR(64)  NULL,
  `event`          VARCHAR(64)  NULL COMMENT 'the automated event that caused it, e.g. booking.confirmed',
  `category`       VARCHAR(32)  NOT NULL DEFAULT 'general',
  `priority`       ENUM('normal','important','urgent','emergency') NOT NULL DEFAULT 'normal',
  `title`          VARCHAR(200) NOT NULL,
  `body`           TEXT         NOT NULL,
  `cta_url`        VARCHAR(500) NULL,
  `cta_label`      VARCHAR(80)  NULL,
  `image_url`      VARCHAR(500) NULL,
  `entity_type`    VARCHAR(32)  NULL COMMENT 'seva_booking, donation, event, pooja, devotee, campaign',
  `entity_id`      INT UNSIGNED NULL,
  `vars`           JSON         NULL COMMENT 'variables it was rendered from; secrets (OTP codes, links) are never stored here',
  `dedupe_key`     VARCHAR(190) NULL,
  `show_in_app`    TINYINT(1)   NOT NULL DEFAULT 1,
  `deliver_after`  DATETIME     NULL COMMENT 'UTC; hidden from the bell and held in the queue until then',
  `read_at`        DATETIME     NULL,
  `archived_at`    DATETIME     NULL,
  `deleted_at`     DATETIME     NULL COMMENT 'removed by the devotee; kept for the audit trail',
  `created_by`     VARCHAR(120) NULL COMMENT 'admin username, or system',
  `created_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_dedupe` (`dedupe_key`),
  KEY `idx_feed` (`devotee_id`, `deleted_at`, `archived_at`, `created_at`),
  KEY `idx_unread` (`devotee_id`, `read_at`, `deleted_at`, `archived_at`),
  KEY `idx_campaign` (`campaign_id`, `run_no`),
  KEY `idx_category_created` (`category`, `created_at`),
  KEY `idx_entity` (`entity_type`, `entity_id`),
  CONSTRAINT `fk_notif_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notif_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `notification_campaigns` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Deliveries (the queue) ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_deliveries` (
  `id`                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `notification_id`     INT UNSIGNED NOT NULL,
  `channel`             ENUM('inapp','email','whatsapp','sms','push') NOT NULL,
  `status`              ENUM('queued','sending','sent','delivered','read','failed','rejected','skipped','dead','cancelled') NOT NULL DEFAULT 'queued',
  `priority_rank`       TINYINT UNSIGNED NOT NULL DEFAULT 3 COMMENT '0 emergency, 1 urgent, 2 important, 3 normal',
  `provider`            VARCHAR(32)  NULL,
  `provider_message_id` VARCHAR(190) NULL,
  `provider_response`   TEXT         NULL COMMENT 'redacted and trimmed',
  `attempts`            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts`        TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `next_attempt_at`     DATETIME     NULL COMMENT 'UTC; NULL = ready now',
  `claim_token`         CHAR(32)     NULL,
  `claimed_at`          DATETIME     NULL,
  `failure_reason`      VARCHAR(300) NULL,
  `skip_reason`         VARCHAR(120) NULL COMMENT 'why a channel was not attempted: opted out, no phone, not configured',
  `sent_at`             DATETIME     NULL,
  `delivered_at`        DATETIME     NULL,
  `read_at`             DATETIME     NULL COMMENT 'email open, WhatsApp read, in-app read',
  `clicked_at`          DATETIME     NULL,
  `created_at`          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_notif_channel` (`notification_id`, `channel`),
  KEY `idx_claim` (`status`, `next_attempt_at`, `priority_rank`),
  KEY `idx_claim_token` (`claim_token`),
  KEY `idx_channel_status` (`channel`, `status`, `created_at`),
  KEY `idx_provider_msg` (`provider`, `provider_message_id`),
  CONSTRAINT `fk_delivery_notif` FOREIGN KEY (`notification_id`) REFERENCES `notifications` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `notification_delivery_events` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `delivery_id` INT UNSIGNED NOT NULL,
  `event`       VARCHAR(24)  NOT NULL COMMENT 'queued, claimed, sent, delivered, read, clicked, failed, retry, rejected, dead, skipped, requeued, webhook',
  `detail`      VARCHAR(500) NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_delivery` (`delivery_id`, `created_at`),
  CONSTRAINT `fk_devent_delivery` FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Devotee preferences ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `devotee_notification_prefs` (
  `devotee_id`           INT UNSIGNED NOT NULL,
  `lang`                 VARCHAR(8)   NOT NULL DEFAULT 'ta',
  `timezone`             VARCHAR(64)  NULL COMMENT 'IANA name; NULL = derived from country',
  `email_on`             TINYINT(1)   NOT NULL DEFAULT 1,
  `whatsapp_on`          TINYINT(1)   NOT NULL DEFAULT 1,
  `push_on`              TINYINT(1)   NOT NULL DEFAULT 1,
  `sms_on`               TINYINT(1)   NOT NULL DEFAULT 1,
  `inapp_on`             TINYINT(1)   NOT NULL DEFAULT 1,
  `muted_categories`     VARCHAR(500) NOT NULL DEFAULT '' COMMENT 'comma list of mutable category keys opted out of',
  `promotional_opt_in_at` DATETIME    NULL COMMENT 'consent to promotional messages',
  `unsubscribed_at`      DATETIME     NULL COMMENT 'one-click email unsubscribe: optional email off',
  `updated_at`           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`devotee_id`),
  CONSTRAINT `fk_prefs_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Devices for push ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `devotee_devices` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `devotee_id`    INT UNSIGNED NOT NULL,
  `platform`      ENUM('web','android','ios') NOT NULL DEFAULT 'web',
  `provider`      ENUM('webpush','fcm','apns') NOT NULL DEFAULT 'webpush',
  `endpoint`      TEXT         NOT NULL COMMENT 'Web Push endpoint URL, or a native token',
  `endpoint_hash` CHAR(64)     NOT NULL,
  `keys_json`     TEXT         NULL COMMENT 'Web Push p256dh and auth',
  `user_agent`    VARCHAR(255) NULL,
  `is_active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `failures`      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `last_seen_at`  DATETIME     NULL,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_endpoint` (`endpoint_hash`),
  KEY `idx_devotee_active` (`devotee_id`, `is_active`),
  CONSTRAINT `fk_device_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── One-time codes ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `devotee_otps` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `devotee_id`  INT UNSIGNED NOT NULL,
  `purpose`     ENUM('phone_verify') NOT NULL DEFAULT 'phone_verify',
  `phone`       VARCHAR(20)  NOT NULL COMMENT 'the number the code proves',
  `code_hash`   CHAR(64)     NOT NULL COMMENT 'HMAC-SHA256 of the code with the service secret',
  `attempts`    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `channel`     VARCHAR(16)  NULL COMMENT 'sms or whatsapp, whichever carried it',
  `expires_at`  DATETIME     NOT NULL,
  `consumed_at` DATETIME     NULL,
  `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_devotee_purpose` (`devotee_id`, `purpose`, `consumed_at`),
  CONSTRAINT `fk_otp_devotee` FOREIGN KEY (`devotee_id`) REFERENCES `devotees` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Audit trail ─────────────────────────────────────────────────────────────
-- SET NULL, not CASCADE: the history of a bulk send must outlive the campaign.
CREATE TABLE IF NOT EXISTS `notification_audit` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `campaign_id`   INT UNSIGNED NULL,
  `campaign_name` VARCHAR(160) NULL COMMENT 'snapshot, readable after the campaign is gone',
  `action`        VARCHAR(32)  NOT NULL COMMENT 'created, edited, submitted, approved, rejected, scheduled, sent, cancelled, duplicated, completed, failed, requeued, test_sent, template_saved, category_saved, segment_saved, emergency_override',
  `actor`         VARCHAR(120) NULL COMMENT 'admin username, or system',
  `actor_role`    VARCHAR(20)  NULL,
  `detail`        JSON         NULL COMMENT 'what changed, and the message as it stood',
  `ip`            VARCHAR(45)  NULL,
  `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_campaign` (`campaign_id`, `created_at`),
  KEY `idx_created` (`created_at`),
  CONSTRAINT `fk_audit_campaign` FOREIGN KEY (`campaign_id`) REFERENCES `notification_campaigns` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Worker heartbeat ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_worker_runs` (
  `id`                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `started_at`         DATETIME     NOT NULL,
  `finished_at`        DATETIME     NULL,
  `trigger`            VARCHAR(12)  NOT NULL DEFAULT 'cli' COMMENT 'cli or http',
  `claimed`            INT UNSIGNED NOT NULL DEFAULT 0,
  `sent`               INT UNSIGNED NOT NULL DEFAULT 0,
  `failed`             INT UNSIGNED NOT NULL DEFAULT 0,
  `dead`               INT UNSIGNED NOT NULL DEFAULT 0,
  `campaigns_expanded` INT UNSIGNED NOT NULL DEFAULT 0,
  `reminders_created`  INT UNSIGNED NOT NULL DEFAULT 0,
  `duration_ms`        INT UNSIGNED NOT NULL DEFAULT 0,
  `error`              VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_started` (`started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Internal settings ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_kv` (
  `k`          VARCHAR(64) NOT NULL,
  `v`          TEXT        NOT NULL,
  `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── devotees.phone_verified_at ──────────────────────────────────────────────
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devotees' AND COLUMN_NAME = 'phone_verified_at'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `devotees`
     ADD COLUMN `phone_verified_at` DATETIME NULL DEFAULT NULL
       COMMENT ''UTC; set when a one-time code sent to the number is confirmed''
       AFTER `phone_country`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
