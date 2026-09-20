<?php
// backend/api/deities.php — GET /api/deities: the shown deities of the active
// temple in display order, for the About page. Answers [] until migration 011
// is applied so the page can fall back to its built-in list.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/live/config.php';

if (!liveTablesExist()) sendJson([]);

$stmt = getDB()->query(
    'SELECT d.id, d.slug, d.name_ta, d.name_en, d.description_ta, d.description_en, d.image_url, d.sort_order
       FROM deities d
       JOIN temples t ON t.id = d.temple_id AND t.is_active = 1
      WHERE d.is_active = 1
      ORDER BY t.sort_order ASC, t.id ASC, d.sort_order ASC, d.id ASC
      LIMIT 100'
);

$rows = [];
foreach ($stmt->fetchAll() as $r) {
    $rows[] = [
        'id'             => (int) $r['id'],
        'slug'           => (string) $r['slug'],
        'name_ta'        => (string) $r['name_ta'],
        'name_en'        => (string) $r['name_en'],
        'description_ta' => $r['description_ta'] !== null && $r['description_ta'] !== '' ? (string) $r['description_ta'] : null,
        'description_en' => $r['description_en'] !== null && $r['description_en'] !== '' ? (string) $r['description_en'] : null,
        'image_url'      => $r['image_url'] !== null && $r['image_url'] !== '' ? (string) $r['image_url'] : null,
        'sort_order'     => (int) $r['sort_order'],
    ];
}

header('Cache-Control: public, max-age=300');
sendJson($rows);
