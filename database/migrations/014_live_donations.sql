SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND COLUMN_NAME = 'live_stream_id'
);
SET @sql := IF(@col = 0, 'ALTER TABLE donations ADD COLUMN live_stream_id INT UNSIGNED NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND INDEX_NAME = 'idx_donation_stream'
);
SET @sql := IF(@idx = 0, 'ALTER TABLE donations ADD INDEX idx_donation_stream (live_stream_id, status)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'donations' AND CONSTRAINT_NAME = 'fk_donation_stream'
);
SET @sql := IF(@fk = 0, 'ALTER TABLE donations ADD CONSTRAINT fk_donation_stream FOREIGN KEY (live_stream_id) REFERENCES live_streams (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
