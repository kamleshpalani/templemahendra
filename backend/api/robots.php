<?php
/**
 * api/robots.php — /robots.txt, generated so the Sitemap line carries the real
 * origin (SITE_URL, else the requested host) instead of a hard-coded domain.
 *
 * /admin and /api are not content. /uploads stays crawlable: gallery photos
 * are meant to be found. The three /payment/* pages belong to one donor.
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_pages.php';

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: public, max-age=3600');

$lines = ['User-agent: *', 'Disallow: /admin/', 'Disallow: /api/', 'Disallow: /search'];
foreach (SITE_PRIVATE_PATHS as $p) $lines[] = 'Disallow: ' . $p;
$lines[] = '';
$lines[] = 'Sitemap: ' . siteUrl('/sitemap.xml');

echo implode("\n", $lines), "\n";
