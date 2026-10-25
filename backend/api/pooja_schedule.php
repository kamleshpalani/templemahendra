<?php
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_content.php';
$today = (new DateTimeImmutable('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
$stmt = getDB()->prepare('SELECT id,name_ta,name_en,description_ta,description_en,pooja_date,pooja_time,pooja_type
    FROM poojas WHERE is_active=1 AND pooja_date>=? ORDER BY pooja_date,pooja_time,id LIMIT 100');
$stmt->execute([$today]);
sendJson(publicContentVisible($stmt->fetchAll()));
