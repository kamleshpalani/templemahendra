<?php
// backend/api/gallery.php

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

$db   = getDB();
$stmt = $db->query(
    'SELECT id, filename, caption, created_at
       FROM gallery
      WHERE is_active = 1
      ORDER BY created_at DESC'
);

sendJson($stmt->fetchAll());
