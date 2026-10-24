-- ============================================================
-- 015_admin_roles.sql — four committee roles plus read-only
--
--   owner    Super Admin      everything
--   admin    Temple Admin     content, finance, notifications, live streams
--   editor   Content Editor   content, bookings, imports, live streams
--   finance  Finance Admin    donations, payments, refunds, sponsors
--   viewer   Viewer           read-only with CSV exports
--
-- Safe to run on an existing database: it only widens the ENUM; every
-- existing row keeps its value. See backend/includes/roles.php for what
-- each role may do.
--
--   mysql -u <user> -p <db> < database/migrations/015_admin_roles.sql
-- ============================================================

ALTER TABLE `admin_users`
  MODIFY `role` ENUM('owner','admin','editor','finance','viewer') NOT NULL DEFAULT 'editor';

-- Audit rows now also record idle expiry and lockouts; widen `action` so
-- longer names such as `session_expired` and `account_locked` fit comfortably.
ALTER TABLE `admin_activity`
  MODIFY `action` VARCHAR(60) NOT NULL
    COMMENT 'login|login_failed|logout|session_expired|session_revoked|account_locked|user_*|password_change|<module>_<verb>';
