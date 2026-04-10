<?php
// backend/api/announcements.php

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

$limit = min(intParam('limit', 10), 50);

$db   = getDB();
$stmt = $db->prepare(
    'SELECT id, title, body, created_at
       FROM announcements
      WHERE is_active = 1
      ORDER BY created_at DESC
      LIMIT :limit'
);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$stmt->execute();

sendJson($stmt->fetchAll());
