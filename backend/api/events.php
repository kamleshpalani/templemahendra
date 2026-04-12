<?php
// backend/api/events.php

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

$limit    = min(intParam('limit', 20), 100);
$upcoming = boolParam('upcoming');

$sql = 'SELECT id, title_ta, title_en, description, event_date
          FROM events
         WHERE is_active = 1';

if ($upcoming) {
    $sql .= ' AND event_date >= CURRENT_DATE';
}

$sql .= ' ORDER BY event_date ASC LIMIT :limit';

$db   = getDB();
$stmt = $db->prepare($sql);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$stmt->execute();

sendJson($stmt->fetchAll());
