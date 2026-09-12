-- ============================================================
-- 002_contact_messages_index.sql — index contact_messages.created_at
--
-- The admin inbox (backend/admin/contact_messages.php) sorts, date-filters
-- and paginates on `created_at`, which previously forced a full scan plus a
-- filesort on every request. `donations` already carries the equivalent
-- `idx_date`; this brings the two tables in line.
--
-- Safe to run on an existing database: it only ADDS an index. It is already
-- part of database/schema.sql, so fresh installs do not need it.
--
--   mysql -u <user> -p <db> < database/migrations/002_contact_messages_index.sql
-- ============================================================

-- MySQL has no "ADD KEY IF NOT EXISTS", so add it only when it is missing.
SET @sql = (
  SELECT IF(
    EXISTS(
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = 'contact_messages'
        AND INDEX_NAME   = 'idx_created'
    ),
    'DO 0',
    'ALTER TABLE `contact_messages` ADD KEY `idx_created` (`created_at`)'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
