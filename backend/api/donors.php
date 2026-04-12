<?php
// backend/api/donors.php
// Returns a combined list of donors (from donations table) and
// sponsors (from sponsors table linked to poojas) for display on homepage.
// Sensitive data (phone) is never exposed.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$db = getDB();

// ── Recent donors from the donations table (last 30 days, approved) ──────────
$isSQLite   = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
$dateFilter = $isSQLite
    ? "datetime('now', '-30 days')"
    : "DATE_SUB(NOW(), INTERVAL 30 DAY)";
$donations = $db->query(
    "SELECT name, purpose, created_at
       FROM donations
      WHERE created_at >= $dateFilter
      ORDER BY created_at DESC
      LIMIT 50"
)->fetchAll(PDO::FETCH_ASSOC);

// ── Active sponsors linked to poojas ─────────────────────────────────────────
$sponsors = $db->query(
    "SELECT s.name, s.note,
            p.name_ta AS pooja_ta, p.name_en AS pooja_en, p.pooja_type
       FROM sponsors s
       LEFT JOIN poojas p ON p.id = s.pooja_id
      WHERE s.is_active = 1
      ORDER BY s.created_at DESC
      LIMIT 50"
)->fetchAll(PDO::FETCH_ASSOC);

// ── Merge into a single scroll list ──────────────────────────────────────────
$items = [];

foreach ($donations as $d) {
    $purpose = $d['purpose'] !== '' ? $d['purpose'] : null;
    $items[] = [
        'name'  => $d['name'],
        'label' => $purpose,
        'type'  => 'donor',
    ];
}

foreach ($sponsors as $s) {
    $poojaLabel = $s['pooja_ta'] ?? null;
    $label      = $s['note'] !== '' && $s['note'] !== null
                    ? $s['note']
                    : ($poojaLabel ?? null);
    $items[] = [
        'name'  => $s['name'],
        'label' => $label,
        'pooja' => [
            'ta' => $s['pooja_ta'],
            'en' => $s['pooja_en'],
        ],
        'type'  => 'sponsor',
    ];
}

sendJson($items);
