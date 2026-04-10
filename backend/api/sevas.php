<?php
// backend/api/sevas.php

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

$limit    = min(intParam('limit', 50), 100);
$featured = boolParam('featured');

$sql  = 'SELECT id, name_ta, name_en, description, amount, is_featured
           FROM sevas
          WHERE is_active = 1';
$params = [];

if ($featured) {
    $sql .= ' AND is_featured = 1';
}

$sql .= ' ORDER BY sort_order ASC LIMIT :limit';

$db   = getDB();
$stmt = $db->prepare($sql);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$stmt->execute();

sendJson($stmt->fetchAll());
