<?php
// backend/api/settings.php — GET /api/settings
//
// What the public site needs to know about itself, in one call:
//   the homepage section switches (top-level booleans, as they always were),
//   `site`      the committee's own facts and copy (site_settings, migration 025;
//               only public keys — the office address never leaves the server),
//   `seo`       per-address title / description / image / robots overrides,
//   `languages` the languages offered and the default for a first visit.
// A database without migration 025 answers the switches and the built-in
// defaults, so nothing on the site changes until the committee edits.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_settings.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$out = ['show_pournami_section' => true, 'show_nalla_strip' => true, 'show_donor_ticker' => true];
try {
    foreach (getDB()->query('SELECT key_name, val FROM homepage_settings')->fetchAll(PDO::FETCH_KEY_PAIR) as $k => $v) {
        $out[$k] = (bool) (int) $v;
    }
} catch (Throwable $e) {
    // homepage_settings comes with schema.sql; without it the defaults above stand
    error_log('[settings] homepage_settings unavailable: ' . $e->getMessage());
}

$out['site']      = siteSettingsPublic();
$out['seo']       = siteSeoOverrides();
$out['languages'] = siteLanguages();

header('Cache-Control: public, max-age=60');
sendJson($out);
