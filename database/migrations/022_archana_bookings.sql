SET @sql = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sevas' AND COLUMN_NAME='service_kind'), 'DO 0',
  'ALTER TABLE sevas ADD service_kind ENUM(''general'',''archana'',''archana_prasadam'',''archana_pooja'') NOT NULL DEFAULT ''general'', ADD delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql = IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seva_bookings' AND COLUMN_NAME='participants'), 'DO 0',
  'ALTER TABLE seva_bookings ADD participants JSON NULL, ADD delivery_address JSON NULL, ADD delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0, ADD dispatch_status ENUM(''not_required'',''pending'',''dispatched'',''delivered'') NOT NULL DEFAULT ''not_required'', ADD tracking_reference VARCHAR(200) NULL');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

UPDATE sevas SET service_kind='archana' WHERE name_en='Archana' AND service_kind='general';
INSERT INTO sevas (name_ta,name_en,description,amount,service_kind,sort_order,is_featured,is_active)
SELECT 'பிரசாதத்துடன் அர்ச்சனை','Archana with Prasadam','Archana with Prasadam delivered to your home. Contact the office until charges are configured.',0,'archana_prasadam',2,0,1
WHERE NOT EXISTS (SELECT 1 FROM sevas WHERE service_kind='archana_prasadam');
INSERT INTO sevas (name_ta,name_en,description,amount,service_kind,sort_order,is_featured,is_active)
SELECT 'பூஜையுடன் அர்ச்சனை','Archana with Pooja','Special Archana and Pooja with Prasadam delivered to your home. Contact the office until charges are configured.',0,'archana_pooja',3,0,1
WHERE NOT EXISTS (SELECT 1 FROM sevas WHERE service_kind='archana_pooja');
INSERT INTO sevas (name_ta,name_en,description,amount,sort_order,is_featured,is_active)
SELECT 'பௌர்ணமி பூஜை அன்னதானம்','Pournami Pooja Annadhanam','Sponsor Annadhanam during Pournami Pooja.',15000,4,1,1
WHERE NOT EXISTS (SELECT 1 FROM sevas WHERE name_en='Pournami Pooja Annadhanam');
UPDATE sevas SET name_en='Normal Annadhanam',amount=100000,is_featured=1
WHERE name_en IN ('Annadanam','Annadhanam');
INSERT INTO sevas (name_ta,name_en,description,amount,sort_order,is_featured,is_active)
SELECT 'பொது அன்னதானம்','Normal Annadhanam','Recommended: general Annadhanam sponsorship.',100000,5,1,1
WHERE NOT EXISTS (SELECT 1 FROM sevas WHERE name_en='Normal Annadhanam');
