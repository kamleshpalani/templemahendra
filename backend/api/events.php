<?php
// backend/api/events.php — GET /api/events and GET /api/events/{id}
//
//   GET /api/events                 active events, soonest first (limit 20, max 100)
//   GET /api/events?upcoming=1      only those whose last day is today or later
//   GET /api/events?past=1[&limit=] only those already over, newest first
//   GET /api/events?featured=1      only featured events
//   GET /api/events?type=festival   only one type: festival | pooja | special | other
//   GET /api/events/{id}            one active event; 404 when hidden or absent
//
// Every event carries both languages (migration 020): title_ta/en,
// description_ta/en, venue_ta/en, plus event_type, is_featured, event_date,
// end_date, start_time / end_time (HH:MM) and image_url. The old
// `description` key is kept for one release so pages that still read it keep
// working. Before migration 020 the old column stands in for both languages
// and every event is an unfeatured 'other'.
//
// The router sets $eventId for the single-event route.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_content.php';
require_once __DIR__ . '/../includes/public_guard.php';

const EVENT_PUBLIC_TYPES = ['festival', 'pooja', 'special', 'other'];

/** True when this database has migration 020's event columns. */
function eventsBilingual(): bool
{
    static $yes = null;
    return $yes ??= publicGuardHasColumn('events', 'description_ta') && publicGuardHasColumn('events', 'event_type')
        && publicGuardHasColumn('events', 'end_date') && publicGuardHasColumn('events', 'image_url');
}

/** The columns the public shape needs, on either side of the migration. */
function eventsSelect(): string
{
    return eventsBilingual()
        ? 'id, title_ta, title_en, description, COALESCE(description_ta, description) AS description_ta,
           COALESCE(description_en, description) AS description_en, event_type, is_featured, event_date, end_date,
           start_time, end_time, venue_ta, venue_en, image_url'
        : 'id, title_ta, title_en, description, description AS description_ta, description AS description_en,
           \'other\' AS event_type, 0 AS is_featured, event_date, NULL AS end_date, NULL AS start_time, NULL AS end_time,
           NULL AS venue_ta, NULL AS venue_en, NULL AS image_url';
}

/** One event as the public site receives it. */
function eventPublicRow(array $r): array
{
    $hhmm = static fn(?string $t): ?string => $t === null || $t === '' ? null : substr((string) $t, 0, 5);
    return [
        'id'             => (int) $r['id'],
        'title_ta'       => (string) $r['title_ta'],
        'title_en'       => (string) $r['title_en'],
        'description_ta' => $r['description_ta'],
        'description_en' => $r['description_en'],
        'description'    => $r['description'],
        'event_type'     => in_array($r['event_type'], EVENT_PUBLIC_TYPES, true) ? $r['event_type'] : 'other',
        'is_featured'    => (bool) $r['is_featured'],
        'event_date'     => $r['event_date'],
        'end_date'       => $r['end_date'],
        'start_time'     => $hhmm($r['start_time']),
        'end_time'       => $hhmm($r['end_time']),
        'venue_ta'       => $r['venue_ta'],
        'venue_en'       => $r['venue_en'],
        'image_url'      => $r['image_url'],
    ];
}

$db = getDB();

// ── One event ───────────────────────────────────────────────────────────────
if (isset($eventId)) {
    $stmt = $db->prepare('SELECT ' . eventsSelect() . ' FROM events WHERE id = :id AND is_active = 1');
    $stmt->execute([':id' => (int) $eventId]);
    $row = $stmt->fetch();
    if (!$row) {
        header('Cache-Control: no-store');
        sendError('Not found', 404);
    }
    header('Cache-Control: public, max-age=120');
    sendJson(eventPublicRow($row));
}

// ── The list ────────────────────────────────────────────────────────────────
$limit    = max(1, min(intParam('limit', 20), 100));
$upcoming = boolParam('upcoming');
$past     = boolParam('past');
$featured = boolParam('featured');
$type     = $_GET['type'] ?? '';
if (!is_string($type) || ($type !== '' && !in_array($type, EVENT_PUBLIC_TYPES, true))) {
    header('Cache-Control: no-store');
    sendError('Choose a valid event type: festival, pooja, special or other.', 422);
}

$lastDay = eventsBilingual() ? 'COALESCE(end_date, event_date)' : 'event_date';
$sql     = 'SELECT ' . eventsSelect() . ' FROM events WHERE is_active = 1';
$params  = [];
if ($upcoming && !$past) $sql .= " AND $lastDay >= CURRENT_DATE";
if ($past && !$upcoming) $sql .= " AND $lastDay < CURRENT_DATE";
if ($featured && eventsBilingual()) $sql .= ' AND is_featured = 1';
if ($featured && !eventsBilingual()) $sql .= ' AND 0';
if ($type !== '') {
    if (eventsBilingual()) { $sql .= ' AND event_type = :type'; $params[':type'] = $type; }
    elseif ($type !== 'other') { $sql .= ' AND 0'; }
}
// The archive reads newest first; everything else in date order.
$sql .= $past && !$upcoming ? ' ORDER BY event_date DESC, id DESC' : ' ORDER BY event_date ASC, id ASC';
$sql .= ' LIMIT :limit';

$stmt = $db->prepare($sql);
foreach ($params as $k => $v) $stmt->bindValue($k, $v);
$stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
$stmt->execute();

header('Cache-Control: public, max-age=120');
sendJson(publicContentVisible(array_map('eventPublicRow', $stmt->fetchAll())));
