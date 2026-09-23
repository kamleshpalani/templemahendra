<?php
// backend/api/gallery.php — GET /api/gallery and GET /api/gallery/albums
//
//   GET /api/gallery                 every shown photo, newest first (a flat
//                                    array, as the first release answered)
//       ?album=<slug|id>             only that album's photos; an unknown or
//                                    hidden album answers an empty list
//       ?limit=1..200                at most that many (the homepage strip)
//   GET /api/gallery/albums          shown albums that hold at least one shown
//                                    photo, in display order, each with its
//                                    photo count and cover thumbnail
//
// Each photo keeps id, filename, caption and created_at for old clients and
// gains album_id, album_slug, alt_ta, alt_en, url, thumb_url, medium_url,
// width, height, thumb_width, medium_width (backend/includes/gallery_images.php).
// Photos in a hidden album are not listed. Before migration 021 the photo
// list still answers (with the new keys null and the thumb / medium URLs
// pointing at the original) and the album list is empty.

require_once __DIR__ . '/../includes/gallery_images.php';

const GALLERY_LIMIT_MAX = 200;

$requestPath = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
$galleryRoute = preg_match('#/gallery/albums/?$#', $requestPath) ? 'albums' : 'index';

$album = $_GET['album'] ?? '';
$limit = $_GET['limit'] ?? '';
if (!is_string($album) || ($album !== '' && !preg_match('/^[0-9]{1,10}$/D', $album) && !preg_match(GALLERY_SLUG_RE, $album))
    || !is_string($limit) || ($limit !== '' && (!preg_match('/^[1-9][0-9]{0,2}$/D', $limit) || (int) $limit > GALLERY_LIMIT_MAX))) {
    header('Cache-Control: no-store');
    sendError('Choose a valid album and a limit between 1 and ' . GALLERY_LIMIT_MAX . '.', 422);
}
$limit = $limit === '' ? 0 : (int) $limit;

$db    = getDB();
$ready = galleryAlbumsReady();

if ($galleryRoute === 'albums') {
    header('Cache-Control: public, max-age=120');
    if (!$ready) sendJson([]);

    // The cover is the committee's pick when it is a shown photo of this
    // album, else the newest shown photo. Albums without a shown photo are
    // left out: an empty chip on the public page helps nobody.
    $albums = $db->query(
        'SELECT a.*,
                (SELECT COUNT(*) FROM gallery g WHERE g.album_id = a.id AND g.is_active = 1) AS n,
                COALESCE(
                  (SELECT c.id FROM gallery c WHERE c.id = a.cover_image_id AND c.album_id = a.id AND c.is_active = 1),
                  (SELECT c.id FROM gallery c WHERE c.album_id = a.id AND c.is_active = 1 ORDER BY c.created_at DESC, c.id DESC LIMIT 1)
                ) AS cover_pick
           FROM gallery_albums a
          WHERE a.is_active = 1
          ORDER BY a.sort_order ASC, a.id ASC
          LIMIT 200'
    )->fetchAll();
    $albums = array_values(array_filter($albums, static fn(array $a): bool => (int) $a['n'] > 0));

    $coverIds = array_values(array_unique(array_filter(array_map(static fn(array $a) => $a['cover_pick'] !== null ? (int) $a['cover_pick'] : null, $albums))));
    $covers   = [];
    if ($coverIds) {
        $stmt = $db->prepare('SELECT id, filename, thumb_filename, alt_ta, alt_en, caption, width, height
                                FROM gallery WHERE id IN (' . implode(',', array_fill(0, count($coverIds), '?')) . ')');
        $stmt->execute($coverIds);
        foreach ($stmt->fetchAll() as $c) $covers[(int) $c['id']] = $c;
    }

    $out = [];
    foreach ($albums as $a) {
        $c = $covers[(int) ($a['cover_pick'] ?? 0)] ?? null;
        if ($c) {
            $a += [
                'cover_id' => $c['id'], 'cover_filename' => $c['filename'], 'cover_thumb' => $c['thumb_filename'],
                'cover_alt_ta' => $c['alt_ta'], 'cover_alt_en' => $c['alt_en'], 'cover_caption' => $c['caption'],
                'cover_width' => $c['width'], 'cover_height' => $c['height'],
            ];
        }
        $out[] = galleryAlbumPublicRow($a);
    }
    sendJson($out);
}

// ── The photo list ───────────────────────────────────────────────────────────
header('Cache-Control: public, max-age=120');

if (!$ready) {
    // No albums exist, so an album filter can only match nothing.
    if ($album !== '') sendJson([]);
    $rows = $db->query('SELECT id, filename, caption, created_at FROM gallery WHERE is_active = 1
                         ORDER BY created_at DESC, id DESC' . ($limit ? ' LIMIT ' . $limit : ''))->fetchAll();
    sendJson(array_map('galleryPublicRow', $rows));
}

$sql = 'SELECT g.*, a.slug AS album_slug
          FROM gallery g
          LEFT JOIN gallery_albums a ON a.id = g.album_id
         WHERE g.is_active = 1 AND (g.album_id IS NULL OR a.is_active = 1)';
$params = [];
if ($album !== '') {
    if (preg_match('/^[0-9]+$/D', $album)) {
        $sql .= ' AND g.album_id = :album_id';
        $params[':album_id'] = (int) $album;
    } else {
        $sql .= ' AND a.slug = :album_slug';
        $params[':album_slug'] = $album;
    }
}
$sql .= ' ORDER BY g.created_at DESC, g.id DESC' . ($limit ? ' LIMIT ' . $limit : '');

$stmt = $db->prepare($sql);
$stmt->execute($params);
sendJson(array_map('galleryPublicRow', $stmt->fetchAll()));
