<?php
/**
 * tests/support/public_hardening_widgets.php — runs api/homepage_widgets.php
 * against a database state the test controls, without changing anyone's data.
 *
 *   php tests/support/public_hardening_widgets.php <manual|calendar|fallback> '{"prefix":"PHT-x","phone":"9812345678"}'
 *
 * The endpoint has three ways to put a sponsor on a card: a widget linked to a
 * sponsor by hand, a calendar widget whose pooja has passed (the next pooja and
 * its sponsor are picked automatically), and the zero-widget fallback. The last
 * two depend on what else is in the table, which a shared database cannot
 * guarantee. So everything happens inside one transaction that is never
 * committed: other widgets and poojas are switched off, a sponsor with a phone
 * number is created, the endpoint runs in this same connection, and the
 * transaction is rolled back when the script ends. Nobody else ever sees it.
 *
 * Prints {"scenario": "...", "raw": "<the endpoint's JSON body>"} on stdout.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../backend/includes/db.php';
require_once __DIR__ . '/../../backend/includes/helpers.php';

$scenario = $argv[1] ?? '';
$args     = json_decode($argv[2] ?? '{}', true);
if (!in_array($scenario, ['manual', 'calendar', 'fallback'], true) || !is_array($args)) {
    fwrite(STDERR, "usage: public_hardening_widgets.php <manual|calendar|fallback> '{\"prefix\":\"…\",\"phone\":\"…\"}'\n");
    exit(1);
}
$prefix = (string) ($args['prefix'] ?? '');
$phone  = (string) ($args['phone'] ?? '');
if (strlen($prefix) < 6 || $phone === '') {
    fwrite(STDERR, "prefix (6+ characters) and phone are required\n");
    exit(1);
}

$db = getDB();
$db->beginTransaction();

// Whatever happens below, the endpoint ends with exit(); roll back then and hand
// the captured body to the test in one JSON line.
ob_start();
register_shutdown_function(static function () use ($db, $scenario): void {
    $raw = ob_get_clean();
    if ($db->inTransaction()) $db->rollBack();
    echo json_encode(['scenario' => $scenario, 'raw' => $raw], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
});

$today = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');

// The pooja the automatic paths should pick: the only active one, today.
if ($scenario !== 'manual') {
    $db->exec('UPDATE poojas SET is_active = 0');
    $db->exec('UPDATE homepage_widgets SET is_active = 0');
}
$db->prepare(
    "INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_time, pooja_type, is_active)
     VALUES (:ta, :en, :d, '06:00 PM', 'pournami', 1)"
)->execute([':ta' => "$prefix பௌர்ணமி", ':en' => "$prefix Pournami", ':d' => $today]);
$poojaId = (int) $db->lastInsertId();

// Consent is given so the card carries the sponsor at all (migration 016); the
// point of this harness is that the phone still never reaches the body.
$db->prepare('INSERT INTO sponsors (name, phone, note, pooja_id, is_active, publish_consent) VALUES (:n, :p, :note, :pid, 1, 1)')
   ->execute([':n' => "$prefix Sponsor", ':p' => $phone, ':note' => "$prefix note", ':pid' => $poojaId]);
$sponsorId = (int) $db->lastInsertId();

if ($scenario === 'manual') {
    $db->prepare(
        "INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_pooja_id, linked_sponsor_id, show_sponsor, priority, is_pinned, is_active)
         VALUES ('sponsor', :ta, :en, 'manual', :pid, :sid, 1, -100000, 1, 1)"
    )->execute([':ta' => "$prefix கார்டு", ':en' => "$prefix card", ':pid' => $poojaId, ':sid' => $sponsorId]);
} elseif ($scenario === 'calendar') {
    // No linked pooja, so the widget is stale and the next pooja is auto-picked.
    $db->prepare(
        "INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, show_sponsor, priority, is_pinned, is_active)
         VALUES ('calendar_pooja', NULL, NULL, 'calendar', 1, -100000, 1, 1)"
    )->execute();
}
// fallback: no active widget at all.

$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../../backend/api/homepage_widgets.php';
