<?php
// backend/api/homepage_widgets.php
// Returns the active homepage widget content with auto-selection logic.
// Priority rules:
//   1. is_pinned DESC (pinned items always first)
//   2. content_type = 'announcement' items next
//   3. calendar_pooja / upcoming_pooja items
//   4. nalla_neram / sponsor items last
//   5. Expired content (end_date < today) is excluded
//   6. Future content (start_date > today) is excluded
//   7. Calendar-driven widgets auto-pick the next upcoming Pournami/special pooja
//   8. If no widgets exist at all, fall back to auto-selected upcoming pooja

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

$tz    = new DateTimeZone('Asia/Kolkata');
$now   = new DateTime('now', $tz);
$today = $now->format('Y-m-d');
$wd    = (int) $now->format('w'); // 0=Sun … 6=Sat

// ── Nalla Neram lookup (by weekday) ─────────────────────────────────────────
const NALLA_NERAM = [
    [['07:30', '09:00'], ['22:30', '24:00']], // Sun
    [['06:00', '07:30'], ['15:00', '16:30']], // Mon
    [['07:30', '09:00'], ['22:30', '24:00']], // Tue
    [['07:30', '09:00'], ['12:00', '13:30']], // Wed
    [['10:30', '12:00'], ['19:30', '21:00']], // Thu
    [['10:30', '12:00'], ['16:30', '18:00']], // Fri
    [['06:00', '07:30'], ['19:30', '21:00']], // Sat
];

$db = getDB();

// ── Step 1: Fetch active widgets within their date window ───────────────────
$stmt = $db->prepare("
    SELECT
        w.id, w.content_type, w.title_ta, w.title_en,
        w.description_ta, w.description_en,
        w.source_type, w.linked_pooja_id, w.linked_sponsor_id,
        w.show_sponsor, w.show_nalla_neram,
        w.start_date, w.end_date, w.priority, w.is_pinned,
        p.name_ta  AS pooja_name_ta,
        p.name_en  AS pooja_name_en,
        p.description_ta AS pooja_desc_ta,
        p.description_en AS pooja_desc_en,
        p.pooja_date, p.pooja_time, p.pooja_type,
        s.name  AS sponsor_name,
        s.phone AS sponsor_phone,
        s.note  AS sponsor_note
    FROM   homepage_widgets w
    LEFT   JOIN poojas   p ON p.id = w.linked_pooja_id
    LEFT   JOIN sponsors s ON s.id = w.linked_sponsor_id
    WHERE  w.is_active = 1
      AND  (w.start_date IS NULL OR w.start_date <= :today)
      AND  (w.end_date   IS NULL OR w.end_date   >= :today)
    ORDER  BY w.is_pinned DESC, w.priority ASC
    LIMIT  15
");
$stmt->execute([':today' => $today]);
$rows = $stmt->fetchAll();

// ── Step 2: Determine if any calendar-driven widget needs auto-pooja ────────
// A calendar widget is considered "stale" when its linked pooja date has passed.
$needAutoPooja = false;
foreach ($rows as $row) {
    if ($row['source_type'] === 'calendar') {
        if (empty($row['pooja_date']) || $row['pooja_date'] < $today) {
            $needAutoPooja = true;
        }
        break;
    }
}

// ── Helper: driver-safe ORDER BY for pooja type priority ────────────────────
$isSQLite      = $db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite';
$typeOrderExpr = $isSQLite
    ? "CASE p.pooja_type
           WHEN 'pournami'  THEN 1
           WHEN 'amavasai'  THEN 2
           WHEN 'ekadasi'   THEN 3
           WHEN 'special'   THEN 4
           WHEN 'monthly'   THEN 5
           WHEN 'sashti'    THEN 6
           ELSE 7
       END"
    : "FIELD(p.pooja_type,'pournami','amavasai','ekadasi','special','monthly','sashti','daily')";

// ── Step 3: Auto-select the next upcoming pooja (Pournami first, then any) ──
$autoPooja = null;
if ($needAutoPooja) {
    // Prefer Pournami first, then any upcoming active pooja
    $stmtAuto = $db->prepare("
        SELECT p.*,
               s.name  AS sponsor_name,
               s.phone AS sponsor_phone,
               s.note  AS sponsor_note
        FROM   poojas p
        LEFT   JOIN sponsors s ON s.pooja_id = p.id AND s.is_active = 1
        WHERE  p.is_active = 1
          AND  p.pooja_date >= :today
        ORDER  BY $typeOrderExpr ASC, p.pooja_date ASC
        LIMIT  1
    ");
    $stmtAuto->execute([':today' => $today]);
    $autoPooja = $stmtAuto->fetch() ?: null;
}

// ── Step 4: Build response widgets ──────────────────────────────────────────
function buildPoojaBlock(array $row): array
{
    return [
        'id'      => (int) $row['id'],
        'name_ta' => $row['name_ta'],
        'name_en' => $row['name_en'],
        'desc_ta' => $row['description_ta'] ?? null,
        'desc_en' => $row['description_en'] ?? null,
        'date'    => $row['pooja_date'],
        'time'    => $row['pooja_time'] ?? null,
        'type'    => $row['pooja_type'],
    ];
}

$widgets = [];

foreach ($rows as $row) {
    $w = [
        'id'             => (int) $row['id'],
        'content_type'   => $row['content_type'],
        'title_ta'       => $row['title_ta'],
        'title_en'       => $row['title_en'],
        'description_ta' => $row['description_ta'],
        'description_en' => $row['description_en'],
        'is_pinned'      => (bool) $row['is_pinned'],
        'priority'       => (int) $row['priority'],
    ];

    // Attach pooja info
    if ($row['source_type'] === 'calendar') {
        // If linked pooja is still upcoming, use it; else use auto-selected
        if (!empty($row['pooja_date']) && $row['pooja_date'] >= $today) {
            $w['pooja'] = [
                'id'      => (int) $row['linked_pooja_id'],
                'name_ta' => $row['pooja_name_ta'],
                'name_en' => $row['pooja_name_en'],
                'desc_ta' => $row['pooja_desc_ta'],
                'desc_en' => $row['pooja_desc_en'],
                'date'    => $row['pooja_date'],
                'time'    => $row['pooja_time'] ?? null,
                'type'    => $row['pooja_type'],
            ];
        } elseif ($autoPooja) {
            $w['pooja']        = buildPoojaBlock($autoPooja);
            // override widget title with auto-selected pooja name
            $w['title_ta'] = $w['title_ta'] ?: $autoPooja['name_ta'];
            $w['title_en'] = $w['title_en'] ?: $autoPooja['name_en'];
            // auto-attach sponsor from the auto-pooja
            if ($autoPooja['sponsor_name']) {
                $w['sponsor'] = [
                    'name'  => $autoPooja['sponsor_name'],
                    'phone' => $autoPooja['sponsor_phone'],
                    'note'  => $autoPooja['sponsor_note'],
                ];
            }
        }
    } elseif (!empty($row['linked_pooja_id'])) {
        $w['pooja'] = [
            'id'      => (int) $row['linked_pooja_id'],
            'name_ta' => $row['pooja_name_ta'],
            'name_en' => $row['pooja_name_en'],
            'desc_ta' => $row['pooja_desc_ta'],
            'desc_en' => $row['pooja_desc_en'],
            'date'    => $row['pooja_date'],
            'time'    => $row['pooja_time'] ?? null,
            'type'    => $row['pooja_type'],
        ];
    }

    // Attach sponsor (manually linked)
    if ($row['show_sponsor'] && !empty($row['sponsor_name']) && !isset($w['sponsor'])) {
        $w['sponsor'] = [
            'name'  => $row['sponsor_name'],
            'phone' => $row['sponsor_phone'],
            'note'  => $row['sponsor_note'],
        ];
    }

    // Attach today's nalla neram
    if ($row['show_nalla_neram']) {
        $w['nalla_neram'] = NALLA_NERAM[$wd];
    }

    $widgets[] = $w;
}

// ── Step 5: Zero-widget fallback — synthesize from next pooja ───────────────
if (empty($widgets)) {
    // Try auto-pooja even if no calendar widgets exist
    if (!$autoPooja) {
        $stmtFb = $db->prepare("
            SELECT p.*,
                   s.name  AS sponsor_name,
                   s.phone AS sponsor_phone,
                   s.note  AS sponsor_note
            FROM   poojas p
            LEFT   JOIN sponsors s ON s.pooja_id = p.id AND s.is_active = 1
            WHERE  p.is_active = 1
              AND  p.pooja_date >= :today
            ORDER  BY $typeOrderExpr ASC, p.pooja_date ASC
            LIMIT  1
        ");
        $stmtFb->execute([':today' => $today]);
        $autoPooja = $stmtFb->fetch() ?: null;
    }

    if ($autoPooja) {
        $daysUntil = (int) round(
            (strtotime($autoPooja['pooja_date']) - strtotime($today)) / 86400
        );
        // If pooja is more than 3 days away, show as "Coming Soon";
        // if within 3 days or today, show as "Upcoming Pooja"
        $ctype = ($daysUntil > 3) ? 'coming_soon' : 'upcoming_pooja';

        $fb = [
            'id'             => 0,
            'content_type'   => $ctype,
            'title_ta'       => $autoPooja['name_ta'],
            'title_en'       => $autoPooja['name_en'],
            'description_ta' => $autoPooja['description_ta'],
            'description_en' => $autoPooja['description_en'],
            'is_pinned'      => false,
            'priority'       => 99,
            'pooja'          => buildPoojaBlock($autoPooja),
        ];
        if ($autoPooja['sponsor_name']) {
            $fb['sponsor'] = [
                'name'  => $autoPooja['sponsor_name'],
                'phone' => $autoPooja['sponsor_phone'],
                'note'  => $autoPooja['sponsor_note'],
            ];
        }
        $widgets[] = $fb;
    }
}

sendJson($widgets);
