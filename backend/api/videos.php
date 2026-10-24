<?php
// backend/api/videos.php — GET /api/videos
//
//   ?category=<slug>   only that (shown) category
//   ?page=1..10000     24 videos a page
//
// Answers { categories, videos, featured, page, has_more }. Only shown videos in
// shown categories (or with no category) are listed. Before migration 017 the
// lists are empty so the page can render its "no videos yet" state.

require_once __DIR__ . '/../includes/videos.php';

const VIDEOS_PAGE_SIZE = 24;

$category = $_GET['category'] ?? '';
$page     = $_GET['page'] ?? '1';
if (!is_string($category) || ($category !== '' && !preg_match('/^[a-z0-9][a-z0-9-]{1,59}$/D', $category))
    || !is_string($page) || !preg_match('/^[1-9][0-9]{0,4}$/D', $page) || (int) $page > 10000) {
    header('Cache-Control: no-store');
    sendError('Choose a valid category and page (1–10000).', 422);
}
$page = (int) $page;

if (!videoTablesExist()) {
    header('Cache-Control: public, max-age=60');
    sendJson(['categories' => [], 'videos' => [], 'featured' => null, 'page' => 1, 'has_more' => false]);
}

$db = getDB();

$categories = [];
foreach ($db->query('SELECT c.slug, c.name_ta, c.name_en,
                            (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id AND v.is_active = 1) AS n
                       FROM video_categories c WHERE c.is_active = 1
                      ORDER BY c.sort_order ASC, c.id ASC LIMIT 100')->fetchAll() as $c) {
    if ((int) $c['n'] === 0) continue;
    $categories[] = ['slug' => (string) $c['slug'], 'name_ta' => (string) $c['name_ta'], 'name_en' => (string) $c['name_en'], 'count' => (int) $c['n']];
}

$select = 'SELECT v.*, c.slug AS category_slug, c.name_ta AS category_name_ta, c.name_en AS category_name_en,
                  ' . (videoStreamsTableExists() ? 's.slug' : 'NULL') . ' AS live_stream_slug
             FROM videos v
             LEFT JOIN video_categories c ON c.id = v.category_id
             ' . (videoStreamsTableExists() ? 'LEFT JOIN live_streams s ON s.id = v.live_stream_id AND s.deleted_at IS NULL' : '') . '
            WHERE v.is_active = 1 AND (v.category_id IS NULL OR c.is_active = 1)';
$params = [];
if ($category !== '') {
    $select  .= ' AND c.slug = :slug';
    $params[':slug'] = $category;
}
$order = ' ORDER BY v.sort_order ASC, v.published_on IS NULL, v.published_on DESC, v.id DESC';

$stmt = $db->prepare($select . $order . ' LIMIT ' . (VIDEOS_PAGE_SIZE + 1) . ' OFFSET ' . (($page - 1) * VIDEOS_PAGE_SIZE));
$stmt->execute($params);
$rows    = $stmt->fetchAll();
$hasMore = count($rows) > VIDEOS_PAGE_SIZE;
if ($hasMore) array_pop($rows);

$featured = null;
if ($page === 1 && $category === '') {
    $f = $db->query($select . ' AND v.is_featured = 1' . $order . ' LIMIT 1')->fetch();
    if ($f) $featured = videoPublicRow($f);
}

header('Cache-Control: public, max-age=120');
sendJson([
    'categories' => $categories,
    'videos'     => array_map('videoPublicRow', $rows),
    'featured'   => $featured,
    'page'       => $page,
    'has_more'   => $hasMore,
]);
