<?php
// backend/api/poojas.php — GET /api/poojas
//
// The dated poojas the committee schedules in Admin → Poojas (brief §6 Pooja /
// Seva, §9): Pournami, Amavasai, Pradosham, Sankatahara Chaturthi, abhishekams,
// festival poojas. Upcoming and active by default.
//
//   ?upcoming=1  (default) date today or later, soonest first
//   ?past=1      dates before today, newest first
//   ?all=1       everything, newest first
//   ?type=       one pooja_type
//   ?featured=1  featured only
//   ?limit=      1–200 (default 50)   ?page=  1-based
//
// Every item carries both languages, the typed start/end times (migration 024)
// with a ready-made display string, the sponsorship price and availability, and
// the consented sponsor's name only (sponsorPublicSql, migration 016).

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/panchangam.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$today = (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d');
$db    = getDB();
$sp    = sponsorPublicSql('s');
$v2    = publicGuardHasColumn('poojas', 'start_time');   // migration 024

$types = ['pournami', 'amavasai', 'ekadasi', 'sashti', 'pradosham', 'chaturthi', 'abhishekam', 'archana', 'festival', 'special', 'monthly', 'daily'];
$type  = is_string($_GET['type'] ?? null) && in_array($_GET['type'], $types, true) ? $_GET['type'] : '';
$limit = max(1, min(200, intParam('limit', 50)));
$page  = max(1, intParam('page', 1));

$where  = ['p.is_active = 1'];
$params = [];
if (boolParam('all')) {
    $order = 'p.pooja_date DESC';
} elseif (boolParam('past')) {
    $where[] = 'p.pooja_date < :today';
    $params[':today'] = $today;
    $order = 'p.pooja_date DESC';
} else {
    $where[] = 'p.pooja_date >= :today';
    $params[':today'] = $today;
    $order = 'p.pooja_date ASC';
}
if ($type !== '') {
    $where[] = 'p.pooja_type = :type';
    $params[':type'] = $type;
}
if (boolParam('featured') && $v2) {
    $where[] = 'p.is_featured = 1';
}

$extra = $v2
    ? ', p.start_time, p.end_time, p.recurrence_type, p.sponsorship_amount, p.sponsorship_available, p.banner_url, p.is_featured, p.live_stream_enabled'
    : '';
// One consented sponsor per pooja (the earliest), as correlated subqueries so
// the row stays one-per-pooja under ONLY_FULL_GROUP_BY.
$sponsorName = "(SELECT {$sp['name']} FROM sponsors s WHERE s.pooja_id = p.id AND {$sp['where']} ORDER BY s.id ASC LIMIT 1)";
$sponsorNote = "(SELECT s.note FROM sponsors s WHERE s.pooja_id = p.id AND {$sp['where']} ORDER BY s.id ASC LIMIT 1)";
$sql = "SELECT p.id, p.name_ta, p.name_en, p.description_ta, p.description_en, p.pooja_date, p.pooja_time, p.pooja_type{$extra},
               {$sponsorName} AS sponsor_name, {$sponsorNote} AS sponsor_note
          FROM poojas p
         WHERE " . implode(' AND ', $where) . "
      ORDER BY {$order}, p.id ASC
         LIMIT " . ($limit + 1) . ' OFFSET ' . (($page - 1) * $limit);
$stmt = $db->prepare($sql);
$stmt->execute($params);
$rows = $stmt->fetchAll();

$hasMore = count($rows) > $limit;
if ($hasMore) array_pop($rows);

$out = [];
foreach ($rows as $r) {
    $item = [
        'id'             => (int) $r['id'],
        'name_ta'        => $r['name_ta'],
        'name_en'        => $r['name_en'],
        'description_ta' => $r['description_ta'],
        'description_en' => $r['description_en'],
        'date'           => $r['pooja_date'],
        'type'           => $r['pooja_type'],
        'start_time'     => $v2 ? ($r['start_time'] !== null ? substr((string) $r['start_time'], 0, 5) : null) : null,
        'end_time'       => $v2 ? ($r['end_time'] !== null ? substr((string) $r['end_time'], 0, 5) : null) : null,
        'time'           => panchTimeLabel($v2 ? $r['start_time'] : null, $v2 ? $r['end_time'] : null, $r['pooja_time']),
        'recurrence_type'       => $v2 ? $r['recurrence_type'] : 'none',
        'sponsorship_amount'    => $v2 && $r['sponsorship_amount'] !== null ? (float) $r['sponsorship_amount'] : null,
        'sponsorship_available' => $v2 ? (bool) $r['sponsorship_available'] : true,
        'banner_url'            => $v2 ? $r['banner_url'] : null,
        'is_featured'           => $v2 ? (bool) $r['is_featured'] : false,
        'live_stream_enabled'   => $v2 ? (bool) $r['live_stream_enabled'] : false,
        'is_past'               => $r['pooja_date'] < $today,
    ];
    if (!empty($r['sponsor_name'])) {
        $item['sponsor'] = ['name' => $r['sponsor_name'], 'note' => $r['sponsor_note']];
    }
    $out[] = $item;
}

header('Cache-Control: public, max-age=60');
header('X-Has-More: ' . ($hasMore ? '1' : '0'));
sendJson($out);
