-- ============================================================
-- 001_admin_users.sql — committee accounts with roles
--
-- Safe to run on an existing database: it only ADDS a table.
-- The environment-variable admin (ADMIN_USERNAME / ADMIN_PASS_HASH)
-- keeps working afterwards as a built-in "owner" bootstrap account,
-- so a deployment can never lock itself out.
--
--   mysql -u <user> -p <db> < database/migrations/001_admin_users.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS `admin_users` (
  `id`            INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(60)   NOT NULL,
  `display_name`  VARCHAR(120)  NOT NULL,
  `email`         VARCHAR(190)  NULL,
  `phone`         VARCHAR(20)   NULL,
  `pass_hash`     VARCHAR(255)  NOT NULL,
  `role`          ENUM('owner','editor','viewer') NOT NULL DEFAULT 'editor',
  `is_active`     TINYINT(1)    NOT NULL DEFAULT 1,
  `must_change`   TINYINT(1)    NOT NULL DEFAULT 0 COMMENT 'force a password change at next sign-in',
  `last_login_at` DATETIME      NULL,
  `created_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_username` (`username`),
  KEY `idx_active_role` (`is_active`, `role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit trail for sign-ins and account changes.
CREATE TABLE IF NOT EXISTS `admin_activity` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor`      VARCHAR(60)  NOT NULL COMMENT 'username of who did it',
  `action`     VARCHAR(40)  NOT NULL COMMENT 'login|login_failed|logout|user_create|user_update|user_disable|password_change',
  `subject`    VARCHAR(190) NULL     COMMENT 'affected record, e.g. another username',
  `detail`     VARCHAR(500) NULL,
  `ip`         VARCHAR(45)  NULL,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_created` (`created_at`),
  KEY `idx_actor` (`actor`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
