<?php
// backend/api/announcements.php — GET /api/announcements[?limit=10]
//
// The active notices, newest first, in both languages (migration 020):
//   title_ta, title_en, body_ta, body_en, start_date, end_date, created_at
// plus the old `title` and `body` keys, kept for one release so pages that
// still read them keep working. A notice with a publish window is served only
// between start_date and end_date inclusive, by temple time (Asia/Kolkata),
// the same clock the homepage cards use. Before migration 020 the old columns
// stand in for both languages and every active notice is current.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';

$limit = max(1, min(intParam('limit', 10), 50));
$db    = getDB();

$bilingual = publicGuardHasColumn('announcements', 'title_ta') && publicGuardHasColumn('announcements', 'body_ta');
$windowed  = publicGuardHasColumn('announcements', 'start_date') && publicGuardHasColumn('announcements', 'end_date');

// The old column when the new one was never filled (a row written by an
// older client), so no notice is ever served with an empty title.
$select = $bilingual
    ? 'id, title, body, COALESCE(NULLIF(title_ta, \'\'), title) AS title_ta, COALESCE(NULLIF(title_en, \'\'), title) AS title_en,
       COALESCE(body_ta, body) AS body_ta, COALESCE(body_en, body) AS body_en'
    : 'id, title, body, title AS title_ta, title AS title_en, body AS body_ta, body AS body_en';
$select .= $windowed ? ', start_date, end_date' : ', NULL AS start_date, NULL AS end_date';

$sql    = 'SELECT ' . $select . ', created_at FROM announcements WHERE is_active = 1';
$params = [];
if ($windowed) {
    $today = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
    $sql .= ' AND (start_date IS NULL OR start_date <= :from) AND (end_date IS NULL OR end_date >= :until)';
    $params = [':from' => $today, ':until' => $today];
}
$sql .= ' ORDER BY created_at DESC, id DESC LIMIT :limit';

$stmt = $db->prepare($sql);
foreach ($params as $k => $v) $stmt->bindValue($k, $v);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$stmt->execute();

$rows = [];
foreach ($stmt->fetchAll() as $r) {
    $rows[] = [
        'id'         => (int) $r['id'],
        'title_ta'   => (string) $r['title_ta'],
        'title_en'   => (string) $r['title_en'],
        'body_ta'    => $r['body_ta'],
        'body_en'    => $r['body_en'],
        'title'      => (string) $r['title'],
        'body'       => $r['body'],
        'start_date' => $r['start_date'],
        'end_date'   => $r['end_date'],
        'created_at' => $r['created_at'],
    ];
}

sendJson($rows);
