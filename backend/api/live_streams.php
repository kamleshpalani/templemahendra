<?php
/**
 * backend/api/live_streams.php — the public Live Darshan API
 * (docs/live/SPEC-PHASE1.md §4.3).
 *
 * api/index.php routes /api/live-streams[/<route>] here with $liveRoute set
 * ('index', 'live', 'upcoming', a numeric id or a slug); hit directly
 * (production serves existing files under /api) it answers 404. GET and HEAD
 * only. No session, no cookie, no rate limit: it is read-only like /api/events.
 *
 *   GET /api/live-streams            { live: [...], upcoming: [...], now, next, server_time }
 *   GET /api/live-streams/live       { streams: [...], server_time }   LIVE first, then STARTING
 *   GET /api/live-streams/upcoming   { streams: [...], server_time }   ?limit= 1–50, default 10
 *   GET /api/live-streams/schedule   { streams: [...], filter, window, counts, server_time }
 *                                    ?filter= today|tomorrow|week|festivals|all (default all), ?limit= 1–100 (default 50)
 *   GET /api/live-streams/<id>       { stream: {...}, server_time }
 *   GET /api/live-streams/<slug>     { stream: {...}, server_time }
 *
 * `now` is the featured live broadcast and `next` the first upcoming one (or
 * null), so the homepage and the main page need one call; both, and every
 * schedule item, carry `day_bucket` and `starts_in_seconds` on top of the
 * public shape (docs/live/SPEC-PHASE2.md §1.1).
 *
 * A DRAFT, deleted or unknown stream is a 404 {"error":"Not found"}. Before
 * migration 011 the lists are empty and the lookups 404 — never a 500.
 */

require_once __DIR__ . '/../includes/live.php';
require_once __DIR__ . '/../includes/payments.php';

ini_set('display_errors', '0');
ini_set('log_errors', '1');

$liveRouteName = isset($liveRoute) && is_string($liveRoute) ? $liveRoute : '';
$liveMethod    = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

if ($liveRouteName === '') {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"Not found"}';
    exit;
}

header('X-Content-Type-Options: nosniff');

if ($liveMethod !== 'GET' && $liveMethod !== 'HEAD') {
    header('Allow: GET, HEAD');
    header('Cache-Control: no-store, private');
    sendError('Method not allowed', 405);
}

// What is live changes by the minute and is polled; the schedule (with its
// countdown seconds) may be shared for half a minute, and the rest for a
// minute (the service worker treats /api/live-streams as network-only
// regardless).
$liveIsVolatile = $liveRouteName === 'index' || $liveRouteName === 'live';
header('Cache-Control: ' . ($liveIsVolatile ? 'no-store, private' : ($liveRouteName === 'schedule' ? 'public, max-age=30' : 'public, max-age=60')));

$liveServerTime = liveIso(liveUtcNow());
if ($liveRouteName === 'archive') {
    $type = $_GET['event_type'] ?? '';
    $month = $_GET['month'] ?? '';
    $page = $_GET['page'] ?? '1';
    if (!is_string($type) || ($type !== '' && !isset(LIVE_EVENT_TYPES[$type]))
        || !is_string($month) || ($month !== '' && !preg_match('/^(?:19|[2-9][0-9])[0-9]{2}-(?:0[1-9]|1[0-2])$/D', $month))
        || substr($month, 0, 4) === '9999'
        || !is_string($page) || !preg_match('/^[1-9][0-9]{0,4}$/D', $page) || (int) $page > 10000) {
        header('Cache-Control: no-store');
        sendError('Choose a valid event type, month and page (1–10000).', 422);
    }
    try {
        $db = getDB();
        $tz = liveTempleTz();
        $from = $to = null;
        if ($month !== '') {
            $start = new DateTimeImmutable($month . '-01 00:00:00', new DateTimeZone($tz));
            $from = $start->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
            $to = $start->modify('+1 month')->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
        }
        $archive = liveTablesExist()
            ? liveListArchive($db, $type, $from, $to, (int) $page)
            : ['streams' => [], 'has_more' => false];
        sendJson($archive + ['page' => (int) $page, 'event_types' => LIVE_EVENT_TYPES, 'timezone' => $tz, 'server_time' => $liveServerTime]);
    } catch (Throwable $e) {
        error_log('[live archive] ' . liveRedact($e->getMessage(), 300));
        header('Cache-Control: no-store');
        sendError('Recordings are temporarily unavailable.', 503);
    }
}
$liveDb = liveTablesExist() ? getDB() : null;
$liveTz = liveTempleTz();

/** The 404 every miss answers with. */
function liveApiNotFound(): never
{
    sendJson(['error' => 'Not found'], 404);
}

/** ?limit= as an int within [1, $max], or $default when absent or not digits. */
function liveApiLimit(int $default, int $max): int
{
    $raw = $_GET['limit'] ?? null;
    $limit = is_scalar($raw) && preg_match('/^\d{1,4}$/', (string) $raw) ? (int) $raw : $default;
    return max(1, min($max, $limit));
}

if ($liveRouteName === 'index') {
    if ($liveDb === null) sendJson(['live' => [], 'upcoming' => [], 'now' => null, 'next' => null, 'server_time' => $liveServerTime]);
    $liveNow  = liveFeatured($liveDb);
    $liveNext = liveNextUpcoming($liveDb);
    sendJson([
        'live'        => array_map('liveShapePublic', liveListLive($liveDb)),
        'upcoming'    => array_map('liveShapePublic', liveListUpcoming($liveDb, 10)),
        'now'         => $liveNow !== null ? liveShapeSchedule($liveNow, $liveTz) : null,
        'next'        => $liveNext !== null ? liveShapeSchedule($liveNext, $liveTz) : null,
        'server_time' => $liveServerTime,
    ]);
}

if ($liveRouteName === 'schedule') {
    $filterRaw = $_GET['filter'] ?? 'all';
    $filter = is_scalar($filterRaw) && isset(LIVE_SCHEDULE_FILTERS[strtolower(trim((string) $filterRaw))]) ? strtolower(trim((string) $filterRaw)) : 'all';
    $limit  = liveApiLimit(50, 100);
    $shapeWindow = static fn(array $w): array => [
        'from'     => liveIso($w['from']),
        'to'       => liveIso($w['to']),
        'today'    => $w['today'],
        'timezone' => $w['timezone'],
        'label_ta' => $w['label_ta'],
        'label_en' => $w['label_en'],
    ];
    if ($liveDb === null) {
        sendJson([
            'streams'     => [],
            'filter'      => $filter,
            'window'      => $shapeWindow(liveScheduleWindow($filter, $liveTz)),
            'counts'      => array_fill_keys(array_keys(LIVE_SCHEDULE_FILTERS), 0),
            'server_time' => $liveServerTime,
        ]);
    }
    $schedule = liveListSchedule($liveDb, $filter, $limit, $liveTz);
    $today    = $schedule['window']['today'];
    sendJson([
        'streams'     => array_map(static fn(array $r): array => liveShapeSchedule($r, $liveTz, $today), $schedule['rows']),
        'filter'      => $filter,
        'window'      => $shapeWindow($schedule['window']),
        'counts'      => $schedule['counts'],
        'server_time' => $liveServerTime,
    ]);
}

if ($liveRouteName === 'live') {
    if ($liveDb === null) sendJson(['streams' => [], 'server_time' => $liveServerTime]);
    sendJson(['streams' => array_map('liveShapePublic', liveListLive($liveDb)), 'server_time' => $liveServerTime]);
}

if ($liveRouteName === 'upcoming') {
    $limit = liveApiLimit(10, 50);
    if ($liveDb === null) sendJson(['streams' => [], 'server_time' => $liveServerTime]);
    sendJson(['streams' => array_map('liveShapePublic', liveListUpcoming($liveDb, $limit)), 'server_time' => $liveServerTime]);
}

// One stream: digits are an id, anything else a slug.
if ($liveDb === null) liveApiNotFound();
$liveRow = preg_match('/^[0-9]{1,10}$/', $liveRouteName)
    ? liveLoad($liveDb, (int) $liveRouteName)
    : liveLoadBySlug($liveDb, $liveRouteName);
if ($liveRow === null || !in_array((string) $liveRow['status'], LIVE_PUBLIC_STATUSES, true) || $liveRow['deleted_at'] !== null) {
    liveApiNotFound();
}
if (!empty($liveDonations)) {
    header('Cache-Control: no-store');
    if (liveDonationStreamId($liveDb, $liveRow['slug']) === null) liveApiNotFound();
    if (!liveDonationsExist($liveDb)) sendError('Donations are unavailable.', 503);
    sendJson(['totals' => liveDonationTotals($liveDb, (int) $liveRow['id']), 'server_time' => $liveServerTime]);
}
sendJson(['stream' => liveShapePublic($liveRow), 'server_time' => $liveServerTime]);
