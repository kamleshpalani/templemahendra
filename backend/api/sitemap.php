<?php
/**
 * api/sitemap.php — /sitemap.xml.
 *
 * Every indexable page from includes/site_pages.php, plus one entry per public
 * broadcast page (scheduled, live or recorded). Cancelled and failed broadcasts
 * are real pages but not worth a crawler's visit, and one donor's payment pages
 * are never listed. The origin comes from SITE_URL, else the requested host.
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/site_pages.php';
require_once __DIR__ . '/../includes/live.php';

const SITEMAP_STREAM_STATUSES = ['SCHEDULED', 'STARTING', 'LIVE', 'COMPLETED'];

$entries = [];
foreach (siteIndexablePaths() as $p) {
    $entries[] = ['loc' => siteUrl($p), 'lastmod' => null, 'changefreq' => $p === '/' ? 'daily' : 'weekly'];
}

try {
    if (liveTablesExist()) {
        $in   = implode(',', array_fill(0, count(SITEMAP_STREAM_STATUSES), '?'));
        $stmt = getDB()->prepare(
            "SELECT slug, updated_at FROM live_streams
              WHERE deleted_at IS NULL AND slug <> '' AND status IN ($in)
              ORDER BY scheduled_start_at DESC LIMIT 500"
        );
        $stmt->execute(SITEMAP_STREAM_STATUSES);
        foreach ($stmt->fetchAll() as $row) {
            $entries[] = [
                'loc'        => siteUrl('/live-darshan/' . $row['slug']),
                'lastmod'    => $row['updated_at'] ? gmdate('Y-m-d', strtotime((string) $row['updated_at'])) : null,
                'changefreq' => 'weekly',
            ];
        }
    }
} catch (Throwable $e) {
    // The static pages are still worth listing when the database is down.
    error_log('[sitemap] ' . get_class($e) . ': ' . $e->getMessage());
}

header('Content-Type: application/xml; charset=utf-8');
header('Cache-Control: public, max-age=3600');

$h = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE | ENT_XML1, 'UTF-8');

echo '<?xml version="1.0" encoding="UTF-8"?>', "\n";
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', "\n";
foreach ($entries as $e) {
    echo "  <url>\n    <loc>", $h($e['loc']), "</loc>\n";
    if ($e['lastmod']) echo "    <lastmod>", $h($e['lastmod']), "</lastmod>\n";
    echo "    <changefreq>", $e['changefreq'], "</changefreq>\n  </url>\n";
}
echo "</urlset>\n";
