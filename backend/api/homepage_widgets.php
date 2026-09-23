<?php
// backend/api/homepage_widgets.php — GET /api/homepage_widgets
//
// The cards on the public homepage (brief §8, §10). Rules, in order:
//   1. Active widgets inside their start/end window, pinned first, then by
//      priority (1 = highest), then display_order, then id — at most 15.
//   2. A calendar-source widget follows its linked pooja while that pooja is
//      still upcoming; the moment the date has passed it is re-pointed at the
//      next valid pooja (Pournami first, then the other observances, then the
//      rest, soonest first). Every calendar widget is checked, not only the first.
//   3. A manual widget linked to a pooja that has passed never publishes that
//      pooja: a pooja-type card is re-pointed like a calendar one, any other
//      card simply loses the pooja block. Expired poojas are never "upcoming".
//   4. A calendar widget that ends up with no pooja at all is dropped rather
//      than shown empty; when nothing is left the engine falls back to the
//      next pooja, and when there is no upcoming pooja either, to the newest
//      active announcement (source_type 'system' on the synthesised card).
//   5. Upcoming Event cards read the linked events row; Live Stream cards read
//      the linked live_streams row and vanish once it is over or cancelled.
//   6. Fewer than four cards are topped up with upcoming events.
//
// Privacy: this is a public endpoint, so a sponsor appears by name and
// dedication note only, and only when active and they agreed to be named
// (sponsors.publish_consent, migration 016). Phone, email, amount and payment
// details are for the committee and are never selected here, so no card type
// or fallback path can leak them.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/panchangam.php';

setCorsHeaders();

$tz    = new DateTimeZone('Asia/Kolkata');
$now   = new DateTime('now', $tz);
$today = $now->format('Y-m-d');
$wd    = (int) $now->format('w'); // 0=Sun … 6=Sat

$db = getDB();
$sp = sponsorPublicSql('s');

// Which migrations this database has: the engine degrades gracefully.
$wV2   = publicGuardHasColumn('homepage_widgets', 'image_url');      // 024: types, links, image, order
$pV2   = publicGuardHasColumn('poojas', 'start_time');               // 024: typed times, price, flags
$evBi  = publicGuardHasColumn('events', 'description_ta');           // 020: bilingual events
$anBi  = publicGuardHasColumn('announcements', 'title_ta');          // 020: bilingual announcements
$liveOk = false;
if ($wV2) {
    try { $db->query('SELECT 1 FROM live_streams LIMIT 0')->closeCursor(); $liveOk = true; } catch (Throwable) { $liveOk = false; }
}

// Pooja type preference for the auto-selection: Pournami first (brief §10),
// then the other lunar observances, then everything else, soonest first.
const POOJA_TYPE_ORDER = "FIELD(p.pooja_type,'pournami','amavasai','pradosham','chaturthi','ekadasi','sashti','abhishekam','archana','festival','special','monthly','daily')";

$poojaCols = 'p.name_ta AS pooja_name_ta, p.name_en AS pooja_name_en, p.description_ta AS pooja_desc_ta, p.description_en AS pooja_desc_en,
              p.pooja_date, p.pooja_time, p.pooja_type'
    . ($pV2 ? ', p.start_time, p.end_time, p.sponsorship_amount, p.sponsorship_available, p.banner_url, p.is_featured AS pooja_featured, p.live_stream_enabled' : '');

/** The public shape of a pooja, from a row whose columns are prefixed the way the widget query aliases them. */
function poojaBlockFromWidgetRow(array $row, bool $pV2): array
{
    return [
        'id'      => (int) $row['linked_pooja_id'],
        'name_ta' => $row['pooja_name_ta'],
        'name_en' => $row['pooja_name_en'],
        'desc_ta' => $row['pooja_desc_ta'],
        'desc_en' => $row['pooja_desc_en'],
        'date'    => $row['pooja_date'],
        'time'    => panchTimeLabel($pV2 ? $row['start_time'] : null, $pV2 ? $row['end_time'] : null, $row['pooja_time']) ?: null,
        'start_time' => $pV2 && $row['start_time'] !== null ? substr((string) $row['start_time'], 0, 5) : null,
        'end_time'   => $pV2 && $row['end_time'] !== null ? substr((string) $row['end_time'], 0, 5) : null,
        'type'    => $row['pooja_type'],
        'sponsorship_amount'    => $pV2 && $row['sponsorship_amount'] !== null ? (float) $row['sponsorship_amount'] : null,
        'sponsorship_available' => $pV2 ? (bool) $row['sponsorship_available'] : true,
        'banner_url'            => $pV2 ? $row['banner_url'] : null,
        'is_featured'           => $pV2 ? (bool) $row['pooja_featured'] : false,
        'live_stream_enabled'   => $pV2 ? (bool) $row['live_stream_enabled'] : false,
    ];
}

/** The public shape of a pooja from a plain poojas row (p.*). */
function poojaBlock(array $row, bool $pV2): array
{
    $row['linked_pooja_id'] = $row['id'];
    $row['pooja_name_ta'] = $row['name_ta'];
    $row['pooja_name_en'] = $row['name_en'];
    $row['pooja_desc_ta'] = $row['description_ta'] ?? null;
    $row['pooja_desc_en'] = $row['description_en'] ?? null;
    $row['pooja_featured'] = $row['is_featured'] ?? 0;
    return poojaBlockFromWidgetRow($row, $pV2);
}

// ── Step 1: active widgets inside their date window ─────────────────────────
$widgetCols = 'w.id, w.content_type, w.title_ta, w.title_en, w.description_ta, w.description_en,
               w.source_type, w.linked_pooja_id, w.linked_sponsor_id, w.show_sponsor, w.show_nalla_neram,
               w.start_date, w.end_date, w.priority, w.is_pinned'
    . ($wV2 ? ', w.linked_event_id, w.linked_stream_id, w.image_url, w.display_order' : ', NULL AS linked_event_id, NULL AS linked_stream_id, NULL AS image_url, 0 AS display_order');
$stmt = $db->prepare("
    SELECT {$widgetCols},
           {$poojaCols},
           {$sp['name']} AS sponsor_name,
           s.note AS sponsor_note
    FROM   homepage_widgets w
    LEFT   JOIN poojas   p ON p.id = w.linked_pooja_id AND p.is_active = 1
    LEFT   JOIN sponsors s ON s.id = w.linked_sponsor_id AND {$sp['where']}
    WHERE  w.is_active = 1
      AND  (w.start_date IS NULL OR w.start_date <= :today_start)
      AND  (w.end_date   IS NULL OR w.end_date   >= :today_end)
    ORDER  BY w.is_pinned DESC, w.priority ASC" . ($wV2 ? ', w.display_order ASC' : '') . ", w.id ASC
    LIMIT  15
");
$stmt->execute([':today_start' => $today, ':today_end' => $today]);
$rows = $stmt->fetchAll();

// ── Step 2: does any card need the auto-selected next pooja? ────────────────
// A linked pooja that has passed (or was hidden) is stale for a calendar
// widget, and for a manual pooja-type widget too (rule 3).
$poojaTypes = ['calendar_pooja', 'upcoming_pooja', 'coming_soon'];
$needAutoPooja = false;
foreach ($rows as $row) {
    $stale = empty($row['pooja_date']) || $row['pooja_date'] < $today;
    if ($row['source_type'] === 'calendar' && $stale) { $needAutoPooja = true; break; }
    if (in_array($row['content_type'], $poojaTypes, true) && !empty($row['linked_pooja_id']) && $stale) { $needAutoPooja = true; break; }
}

/** The next upcoming active pooja (Pournami first), with its consented sponsor, or null. */
function nextPooja(PDO $db, array $sp, string $today, bool $pV2): ?array
{
    $stmt = $db->prepare("
        SELECT p.*, {$sp['name']} AS sponsor_name, s.note AS sponsor_note
        FROM   poojas p
        LEFT   JOIN sponsors s ON s.pooja_id = p.id AND {$sp['where']}
        WHERE  p.is_active = 1 AND p.pooja_date >= :today
        ORDER  BY " . POOJA_TYPE_ORDER . " ASC, p.pooja_date ASC, p.id ASC
        LIMIT  1
    ");
    $stmt->execute([':today' => $today]);
    return $stmt->fetch() ?: null;
}

$autoPooja = $needAutoPooja ? nextPooja($db, $sp, $today, $pV2) : null;

// ── Step 3: linked events and streams (migration 024) ───────────────────────
$eventById  = [];
$streamById = [];
if ($wV2) {
    $eventIds = array_values(array_unique(array_filter(array_map(static fn($r) => (int) ($r['linked_event_id'] ?? 0), $rows))));
    if ($eventIds) {
        $in = implode(',', array_fill(0, count($eventIds), '?'));
        $cols = 'id, title_ta, title_en, event_date, description' . ($evBi ? ', description_ta, description_en, end_date, start_time, venue_ta, venue_en, image_url, event_type, is_featured' : '');
        $es = $db->prepare("SELECT {$cols} FROM events WHERE is_active = 1 AND id IN ({$in})");
        $es->execute($eventIds);
        foreach ($es->fetchAll() as $e) $eventById[(int) $e['id']] = $e;
    }
    $streamIds = array_values(array_unique(array_filter(array_map(static fn($r) => (int) ($r['linked_stream_id'] ?? 0), $rows))));
    if ($streamIds && $liveOk) {
        $in = implode(',', array_fill(0, count($streamIds), '?'));
        $ss = $db->prepare("SELECT id, slug, status, title_ta, title_en, scheduled_start_at, scheduled_end_at, thumbnail_url
                              FROM live_streams WHERE deleted_at IS NULL AND id IN ({$in})");
        try {
            $ss->execute($streamIds);
            foreach ($ss->fetchAll() as $s) $streamById[(int) $s['id']] = $s;
        } catch (Throwable $e) {
            error_log('[homepage_widgets] live_streams lookup: ' . $e->getMessage());
        }
    }
}

/** An event's public block, or null when it is over. */
function eventBlock(array $e, string $today, bool $evBi): ?array
{
    $ends = $evBi && !empty($e['end_date']) ? $e['end_date'] : $e['event_date'];
    if ($ends < $today) return null;
    return [
        'id'       => (int) $e['id'],
        'title_ta' => $e['title_ta'],
        'title_en' => $e['title_en'],
        'date'     => $e['event_date'],
        'end_date' => $evBi ? ($e['end_date'] ?? null) : null,
        'time'     => $evBi && !empty($e['start_time']) ? panchClock($e['start_time']) : null,
        'desc_ta'  => $evBi ? ($e['description_ta'] ?? $e['description']) : $e['description'],
        'desc_en'  => $evBi ? ($e['description_en'] ?? $e['description']) : $e['description'],
        'venue_ta' => $evBi ? ($e['venue_ta'] ?? null) : null,
        'venue_en' => $evBi ? ($e['venue_en'] ?? null) : null,
        'image_url'=> $evBi ? ($e['image_url'] ?? null) : null,
        'type'     => $evBi ? ($e['event_type'] ?? null) : null,
    ];
}

/** A broadcast's public block while it is scheduled, starting or live; null once it is over. */
function streamBlock(array $s): ?array
{
    if (!in_array($s['status'], ['SCHEDULED', 'STARTING', 'LIVE'], true)) return null;
    return [
        'id'        => (int) $s['id'],
        'slug'      => $s['slug'],
        'status'    => $s['status'],
        'is_live'   => in_array($s['status'], ['STARTING', 'LIVE'], true),
        'title_ta'  => $s['title_ta'],
        'title_en'  => $s['title_en'],
        'scheduled_start_at' => $s['scheduled_start_at'] !== null ? str_replace(' ', 'T', (string) $s['scheduled_start_at']) . 'Z' : null,
        'thumbnail_url'      => $s['thumbnail_url'] ?? null,
        'url'       => '/live-darshan/' . $s['slug'],
    ];
}

// ── Step 4: build the cards ─────────────────────────────────────────────────
$widgets = [];
foreach ($rows as $row) {
    $ct = $row['content_type'];
    $w = [
        'id'             => (int) $row['id'],
        'content_type'   => $ct,
        'source_type'    => $row['source_type'],
        'title_ta'       => $row['title_ta'],
        'title_en'       => $row['title_en'],
        'description_ta' => $row['description_ta'],
        'description_en' => $row['description_en'],
        'image_url'      => $row['image_url'] ?? null,
        'is_pinned'      => (bool) $row['is_pinned'],
        'priority'       => (int) $row['priority'],
        'display_order'  => (int) ($row['display_order'] ?? 0),
        'event_date'     => $row['start_date'] ?? null, // an Upcoming Event card typed by hand
    ];

    $poojaUpcoming = !empty($row['pooja_date']) && $row['pooja_date'] >= $today;
    $hasText = trim((string) $row['title_ta'] . (string) $row['title_en']) !== '';

    // Pooja block (rules 2–4)
    if ($row['source_type'] === 'calendar') {
        if ($poojaUpcoming) {
            $w['pooja'] = poojaBlockFromWidgetRow($row, $pV2);
        } elseif ($autoPooja) {
            $w['pooja']    = poojaBlock($autoPooja, $pV2);
            $w['title_ta'] = $w['title_ta'] ?: $autoPooja['name_ta'];
            $w['title_en'] = $w['title_en'] ?: $autoPooja['name_en'];
            if ($autoPooja['sponsor_name']) $w['sponsor'] = ['name' => $autoPooja['sponsor_name'], 'note' => $autoPooja['sponsor_note']];
        } else {
            continue; // nothing upcoming: an empty "next pooja" card helps nobody
        }
    } elseif (!empty($row['linked_pooja_id'])) {
        if ($poojaUpcoming) {
            $w['pooja'] = poojaBlockFromWidgetRow($row, $pV2);
        } elseif (in_array($ct, $poojaTypes, true)) {
            if ($autoPooja) {
                $w['pooja']    = poojaBlock($autoPooja, $pV2);
                $w['title_ta'] = $w['title_ta'] ?: $autoPooja['name_ta'];
                $w['title_en'] = $w['title_en'] ?: $autoPooja['name_en'];
                if ($autoPooja['sponsor_name']) $w['sponsor'] = ['name' => $autoPooja['sponsor_name'], 'note' => $autoPooja['sponsor_note']];
            } elseif (!$hasText) {
                continue;
            }
        }
        // any other type: the past pooja is simply not published
    }

    // Linked event (rule 5)
    if (!empty($row['linked_event_id'])) {
        $e = $eventById[(int) $row['linked_event_id']] ?? null;
        $block = $e ? eventBlock($e, $today, $evBi) : null;
        if ($block) {
            $w['event']      = $block;
            $w['event_date'] = $block['date'];
            $w['title_ta']   = $w['title_ta'] ?: $block['title_ta'];
            $w['title_en']   = $w['title_en'] ?: $block['title_en'];
            if ($w['image_url'] === null && !empty($block['image_url'])) $w['image_url'] = $block['image_url'];
        } elseif ($ct === 'upcoming_event' && empty($row['start_date'])) {
            continue; // the event is over or hidden and the card has no date of its own
        }
    }

    // Linked live stream (rule 5)
    if (!empty($row['linked_stream_id'])) {
        $s = $streamById[(int) $row['linked_stream_id']] ?? null;
        $block = $s ? streamBlock($s) : null;
        if ($block) {
            $w['stream']   = $block;
            $w['title_ta'] = $w['title_ta'] ?: $block['title_ta'];
            $w['title_en'] = $w['title_en'] ?: $block['title_en'];
            if ($w['image_url'] === null && !empty($block['thumbnail_url'])) $w['image_url'] = $block['thumbnail_url'];
        } elseif ($ct === 'livestream') {
            continue; // over, cancelled, still a draft, or gone
        }
    } elseif ($ct === 'livestream') {
        continue; // a Live Stream card follows a broadcast; plain text belongs in a custom card
    }

    // Manually linked sponsor (consent already applied in the JOIN)
    if ($row['show_sponsor'] && !empty($row['sponsor_name']) && !isset($w['sponsor'])) {
        $w['sponsor'] = ['name' => $row['sponsor_name'], 'note' => $row['sponsor_note']];
    }

    // Today's Nalla Neram
    if ($row['show_nalla_neram']) {
        $w['nalla_neram'] = panchNallaNeram($wd);
    }

    $widgets[] = $w;
}

// ── Step 5: nothing to show → the next pooja, else the newest announcement ──
if (empty($widgets)) {
    if (!$autoPooja) $autoPooja = nextPooja($db, $sp, $today, $pV2);

    if ($autoPooja) {
        $daysUntil = (int) round((strtotime($autoPooja['pooja_date']) - strtotime($today)) / 86400);
        $fb = [
            'id'             => 0,
            'content_type'   => $daysUntil > 3 ? 'coming_soon' : 'upcoming_pooja',
            'source_type'    => 'system',
            'title_ta'       => $autoPooja['name_ta'],
            'title_en'       => $autoPooja['name_en'],
            'description_ta' => $autoPooja['description_ta'],
            'description_en' => $autoPooja['description_en'],
            'image_url'      => $pV2 ? ($autoPooja['banner_url'] ?? null) : null,
            'is_pinned'      => false,
            'priority'       => 99,
            'display_order'  => 0,
            'pooja'          => poojaBlock($autoPooja, $pV2),
        ];
        if ($autoPooja['sponsor_name']) $fb['sponsor'] = ['name' => $autoPooja['sponsor_name'], 'note' => $autoPooja['sponsor_note']];
        $widgets[] = $fb;
    } else {
        // Brief §10: no upcoming pooja → an active manual announcement.
        $cols = 'id, title, body' . ($anBi ? ', title_ta, title_en, body_ta, body_en' : '');
        $win  = $anBi ? ' AND (start_date IS NULL OR start_date <= :d1) AND (end_date IS NULL OR end_date >= :d2)' : '';
        $as = $db->prepare("SELECT {$cols} FROM announcements WHERE is_active = 1{$win} ORDER BY created_at DESC, id DESC LIMIT 1");
        $as->execute($anBi ? [':d1' => $today, ':d2' => $today] : []);
        if ($a = $as->fetch()) {
            $widgets[] = [
                'id'             => 0,
                'content_type'   => 'announcement',
                'source_type'    => 'system',
                'announcement_id'=> (int) $a['id'],
                'title_ta'       => $anBi ? ($a['title_ta'] ?: $a['title']) : $a['title'],
                'title_en'       => $anBi ? ($a['title_en'] ?: $a['title']) : $a['title'],
                'description_ta' => $anBi ? ($a['body_ta'] ?: $a['body']) : $a['body'],
                'description_en' => $anBi ? ($a['body_en'] ?: $a['body']) : $a['body'],
                'image_url'      => null,
                'is_pinned'      => false,
                'priority'       => 99,
                'display_order'  => 0,
            ];
        }
    }
}

// ── Step 6: fewer than four cards → top up with upcoming events ─────────────
if (count($widgets) < 4) {
    $coveredDates = [];
    $coveredEvents = [];
    foreach ($widgets as $w) {
        if (!empty($w['event_date']))    $coveredDates[]  = $w['event_date'];
        if (!empty($w['pooja']['date'])) $coveredDates[]  = $w['pooja']['date'];
        if (!empty($w['event']['id']))   $coveredEvents[] = $w['event']['id'];
    }
    $cols = 'id, title_ta, title_en, description, event_date' . ($evBi ? ', description_ta, description_en, end_date, start_time, venue_ta, venue_en, image_url, event_type, is_featured' : '');
    $stmtEv = $db->prepare("SELECT {$cols} FROM events WHERE is_active = 1 AND event_date >= :today ORDER BY " . ($evBi ? 'is_featured DESC, ' : '') . "event_date ASC LIMIT 6");
    $stmtEv->execute([':today' => $today]);
    foreach ($stmtEv->fetchAll() as $ev) {
        if (count($widgets) >= 4) break;
        if (in_array((int) $ev['id'], $coveredEvents, true) || in_array($ev['event_date'], $coveredDates, true)) continue;
        $block = eventBlock($ev, $today, $evBi);
        if (!$block) continue;
        $widgets[] = [
            'id'             => 0,
            'content_type'   => 'upcoming_event',
            'source_type'    => 'system',
            'title_ta'       => $ev['title_ta'],
            'title_en'       => $ev['title_en'],
            'description_ta' => $block['desc_ta'],
            'description_en' => $block['desc_en'],
            'image_url'      => $block['image_url'],
            'is_pinned'      => false,
            'priority'       => 99,
            'display_order'  => 0,
            'event_date'     => $ev['event_date'],
            'event'          => $block,
        ];
        $coveredDates[] = $ev['event_date'];
    }
}

sendJson($widgets);
