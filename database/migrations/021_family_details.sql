SET @sql = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devotees' AND COLUMN_NAME='marriage_date'), 'DO 0',
  'ALTER TABLE devotees ADD marriage_date DATE NULL, ADD rasi VARCHAR(100) NULL, ADD nakshatram VARCHAR(100) NULL');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='devotee_family_members' AND COLUMN_NAME='date_of_birth'), 'DO 0',
  'ALTER TABLE devotee_family_members ADD date_of_birth DATE NULL, ADD marriage_date DATE NULL, ADD rasi VARCHAR(100) NULL, ADD nakshatram VARCHAR(100) NULL');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
