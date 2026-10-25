SET @sql = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devotee_family_members' AND COLUMN_NAME='gothram'), 'DO 0',
  'ALTER TABLE devotee_family_members ADD gothram VARCHAR(100) NULL');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
