<?php
// backend/api/settings.php
// Returns public homepage display settings (section visibility toggles).
// Only boolean-like values (0/1) are exposed — no sensitive data.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$db = getDB();

// Ensure table exists (graceful for fresh SQLite installs)
$db->exec("CREATE TABLE IF NOT EXISTS homepage_settings (
  key_name TEXT PRIMARY KEY,
  val      TEXT NOT NULL DEFAULT '1',
  label    TEXT
)");

// Seed defaults if missing
$defaults = [
    ['show_pournami_section', '1', 'Show Pournami Poojai section on homepage'],
    ['show_nalla_strip',      '1', 'Show Nalla Neram strip on homepage'],
    ['show_donor_ticker',     '1', 'Show donor scroll ticker'],
];
$ins = $db->prepare("INSERT OR IGNORE INTO homepage_settings (key_name, val, label) VALUES (?,?,?)");
foreach ($defaults as $d) {
    try { $ins->execute($d); } catch (Exception $e) { /* MySQL uses INSERT IGNORE too */ }
}

$rows = $db->query("SELECT key_name, val FROM homepage_settings")->fetchAll(PDO::FETCH_KEY_PAIR);

// Cast to booleans for frontend
$out = [];
foreach ($rows as $k => $v) {
    $out[$k] = (bool)(int)$v;
}

sendJson($out);

