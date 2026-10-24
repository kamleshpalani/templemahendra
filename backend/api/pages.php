<?php
// backend/api/pages.php — GET /api/pages and GET /api/pages/{slug}
//
// CMS pages written in Admin → Content → Pages (migration 025): the About
// page's mission and history, and any page the committee adds. Bodies are
// plain text; blank lines separate paragraphs, which the React page renders.
// $pageSlug is set by api/index.php for the single-page route.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$db = getDB();
try {
    $db->query('SELECT 1 FROM pages LIMIT 0')->closeCursor();
} catch (Throwable) {
    // Migration 025 not applied: no pages yet, never an error for the visitor.
    if (isset($pageSlug)) sendError('Not found', 404);
    sendJson([]);
}

$shape = static fn(array $r, bool $full): array => [
    'id'       => (int) $r['id'],
    'slug'     => $r['slug'],
    'title_ta' => $r['title_ta'],
    'title_en' => $r['title_en'],
    'meta_title_ta'       => $r['meta_title_ta'],
    'meta_title_en'       => $r['meta_title_en'],
    'meta_description_ta' => $r['meta_description_ta'],
    'meta_description_en' => $r['meta_description_en'],
    'updated_at' => $r['updated_at'],
] + ($full ? ['body_ta' => $r['body_ta'], 'body_en' => $r['body_en']] : ['has_body' => trim((string) $r['body_ta'] . (string) $r['body_en']) !== '']);

if (isset($pageSlug)) {
    $stmt = $db->prepare('SELECT * FROM pages WHERE slug = :s AND is_active = 1');
    $stmt->execute([':s' => $pageSlug]);
    $row = $stmt->fetch();
    if (!$row) sendError('Not found', 404);
    header('Cache-Control: public, max-age=60');
    sendJson($shape($row, true));
}

$rows = $db->query('SELECT * FROM pages WHERE is_active = 1 ORDER BY sort_order ASC, id ASC')->fetchAll();
header('Cache-Control: public, max-age=60');
sendJson(array_map(static fn($r) => $shape($r, false), $rows));
