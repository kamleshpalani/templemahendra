<?php
// backend/api/donors.php
// Returns a combined list of donors (from donations table) and
// sponsors (from sponsors table linked to poojas) for display on homepage.
// Sensitive data (phone, amount, message) is never exposed.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$db = getDB();

// ── Recent donors who agreed to be thanked by name (last 30 days) ────────────
// A donor's name appears only with their consent (migration 008). Without the
// column nobody has agreed to anything, so no donation is listed at all.
$donations = [];
if (publicGuardHasColumn('donations', 'show_name_publicly')) {
    // Online donations (migration 010) appear only once paid, and leave the list
    // when fully refunded or while a refund is in progress: pledges, plus online
    // donations that are SUCCESS or PARTIALLY_REFUNDED (docs/payments/SPEC.md §5.5).
    $paidOnly = publicGuardHasColumn('donations', 'source') && publicGuardHasColumn('donations', 'status')
        ? " AND (source = 'pledge' OR status IN ('SUCCESS','PARTIALLY_REFUNDED'))"
        : '';
    $donations = $db->query(
        "SELECT name, purpose, created_at
           FROM donations
          WHERE show_name_publicly = 1
            AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY){$paidOnly}
          ORDER BY created_at DESC
          LIMIT 50"
    )->fetchAll(PDO::FETCH_ASSOC);
}

// A purpose that is a donation category is shown by its English name.
$categoryNames = [];
if ($donations && publicGuardHasColumn('donations', 'category_id')) {
    try {
        $categoryNames = $db->query('SELECT slug, name_en FROM donation_categories')->fetchAll(PDO::FETCH_KEY_PAIR);
    } catch (Throwable $e) {
        error_log('[donors] donation categories unavailable: ' . $e->getMessage());
    }
}

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
    if ($purpose !== null && isset($categoryNames[$purpose])) $purpose = $categoryNames[$purpose];
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
