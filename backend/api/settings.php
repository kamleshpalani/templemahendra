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

// Ensure table exists (safety net if database/schema.sql was not imported)
try {
    $db->exec("CREATE TABLE IF NOT EXISTS `homepage_settings` (
      `key_name` VARCHAR(80)  NOT NULL,
      `val`      VARCHAR(10)  NOT NULL DEFAULT '1',
      `label`    VARCHAR(300) NULL,
      PRIMARY KEY (`key_name`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
} catch (PDOException $e) {
    // Table already exists or DB user lacks CREATE privilege — schema.sql is the source of truth
}

// Seed defaults if missing
$defaults = [
    ['show_pournami_section', '1', 'Show Pournami Poojai section on homepage'],
    ['show_nalla_strip',      '1', 'Show Nalla Neram strip on homepage'],
    ['show_donor_ticker',     '1', 'Show donor scroll ticker'],
];
$ins = $db->prepare(
    "INSERT IGNORE INTO homepage_settings (key_name, val, label) VALUES (?,?,?)"
);
foreach ($defaults as $d) {
    try { $ins->execute($d); } catch (Exception $e) { /* already seeded */ }
}

$rows = $db->query("SELECT key_name, val FROM homepage_settings")->fetchAll(PDO::FETCH_KEY_PAIR);

// Cast to booleans for frontend
$out = [];
foreach ($rows as $k => $v) {
    $out[$k] = (bool)(int)$v;
}

sendJson($out);

