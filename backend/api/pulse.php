<?php
// backend/api/pulse.php
// Provides live temple status data: open/closed, next pooja, today's special, upcoming events.

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_settings.php';

setCorsHeaders();

// The committee's values (Admin → System → Settings, migration 025); the
// catalogue defaults are the figures that were once typed here.
$pulseMins = static fn(string $t): ?int => preg_match('/^(\d{2}):(\d{2})$/', $t, $m) ? (int) $m[1] * 60 + (int) $m[2] : null;

// ── Timezone: use IST regardless of server timezone ─────────────────────────
$tz  = new DateTimeZone('Asia/Kolkata');
$now = new DateTime('now', $tz);
$h   = (int) $now->format('G');
$m   = (int) $now->format('i');
$s   = (int) $now->format('s');

// ── Temple hours (default: morning 6:00–12:30 | evening 16:00–21:00) ─────────
$nowMins = $h * 60 + $m;
$hours   = [];
foreach (siteSettingJson('temple_hours') as $w) {
    $o = is_array($w) ? $pulseMins((string) ($w['open'] ?? '')) : null;
    $c = is_array($w) ? $pulseMins((string) ($w['close'] ?? '')) : null;
    if ($o !== null && $c !== null && $c > $o) $hours[] = ['open' => $w['open'], 'close' => $w['close'], 'o' => $o, 'c' => $c];
}
if ($hours === []) $hours = [['open' => '06:00', 'close' => '12:30', 'o' => 360, 'c' => 750], ['open' => '16:00', 'close' => '21:00', 'o' => 960, 'c' => 1260]];
$open = false;
foreach ($hours as $w) if ($nowMins >= $w['o'] && $nowMins < $w['c']) { $open = true; break; }

// ── Pooja schedule ───────────────────────────────────────────────────────────
$schedule = [];
foreach (siteSettingJson('pooja_schedule') as $p) {
    $t = is_array($p) ? $pulseMins((string) ($p['time'] ?? '')) : null;
    if ($t === null) continue;
    $schedule[] = ['name_ta' => (string) ($p['ta'] ?? ''), 'name_en' => (string) ($p['en'] ?? ''), 'h' => intdiv($t, 60), 'm' => $t % 60];
}
usort($schedule, static fn($a, $b) => ($a['h'] * 60 + $a['m']) <=> ($b['h'] * 60 + $b['m']));
if ($schedule === []) {
    $schedule = [
        ['name_ta' => 'திருவனந்தல்',      'name_en' => 'Thiruvanandal',    'h' => 6,  'm' => 0],
        ['name_ta' => 'காலசந்தி',          'name_en' => 'Kalasanthi',       'h' => 8,  'm' => 0],
        ['name_ta' => 'உச்சிக்கால பூஜை', 'name_en' => 'Uchikala Pooja',   'h' => 12, 'm' => 0],
        ['name_ta' => 'சாயரட்சை',          'name_en' => 'Sayaratchai',      'h' => 16, 'm' => 30],
        ['name_ta' => 'இரண்டாம்கால',      'name_en' => 'Irandamkaalai',    'h' => 18, 'm' => 30],
        ['name_ta' => 'அர்த்த ஜாமம்',    'name_en' => 'Ardha Jamam',      'h' => 20, 'm' => 30],
    ];
}

// Find the next pooja after current time
$nextPooja  = null;
$countdownSec = 0;
foreach ($schedule as $p) {
    if ($p['h'] * 60 + $p['m'] > $nowMins) {
        $nextPooja    = $p;
        $countdownSec = ($p['h'] * 3600 + $p['m'] * 60) - ($h * 3600 + $m * 60 + $s);
        break;
    }
}
// If all poojas have passed today, return tomorrow's first pooja
if ($nextPooja === null) {
    $first        = $schedule[0];
    $secsToMidnight = (24 * 3600) - ($h * 3600 + $m * 60 + $s);
    $nextPooja    = $first;
    $countdownSec = $secsToMidnight + $first['h'] * 3600 + $first['m'] * 60;
}

// Format pooja time as "HH:MM AM/PM"
$poojaTime = (new DateTime(
    sprintf('%02d:%02d', $nextPooja['h'], $nextPooja['m']),
    $tz
))->format('g:i A');

// ── Daily special alankaram (by weekday: 0=Sun … 6=Sat) ─────────────────────
$weekday = (int) $now->format('w');
$specials = [];
foreach (siteSettingJson('daily_special') as $i => $d) {
    if (is_array($d)) $specials[(int) $i] = ['ta' => (string) ($d['ta'] ?? ''), 'en' => (string) ($d['en'] ?? '')];
}
if (count($specials) !== 7) {
    $specials = [
        ['ta' => 'ஆதிமூலம் அலங்காரம்',   'en' => 'Spl Alankaram'],          // Sun
        ['ta' => 'வெள்ளி அலங்காரம்',       'en' => 'Silver Alankaram'],       // Mon
        ['ta' => 'பால் அபிஷேகம்',          'en' => 'Milk Abhishekam'],        // Tue
        ['ta' => 'குங்குமார்ச்சனை',         'en' => 'Kumkum Archana'],         // Wed
        ['ta' => 'பன்னீர் அபிஷேகம்',       'en' => 'Rosewater Abhishekam'],   // Thu
        ['ta' => 'நவதானிய அர்ப்பணம்',      'en' => 'Navadhanya Offering'],    // Fri
        ['ta' => 'விளக்கு பூஜை',           'en' => 'Deepa Pooja'],            // Sat
    ];
}
$todaySpecial = $specials[$weekday];

// ── Upcoming events (next 3 from DB) ────────────────────────────────────────
$upcomingEvents = [];
try {
    $db   = getDB();
    $stmt = $db->prepare(
        'SELECT title_ta, title_en, event_date
           FROM events
          WHERE is_active = 1
            AND event_date >= CURRENT_DATE
          ORDER BY event_date ASC
          LIMIT 3'
    );
    $stmt->execute();
    $upcomingEvents = $stmt->fetchAll();
} catch (Exception $e) {
    // Non-fatal: pulse data still useful without events
    $upcomingEvents = [];
}

sendJson([
    'open'         => $open,
    'serverTime'   => $now->format('H:i:s'),
    'nextPooja'    => [
        'name_ta'      => $nextPooja['name_ta'],
        'name_en'      => $nextPooja['name_en'],
        'time'         => $poojaTime,
        'countdownSec' => $countdownSec,
    ],
    'todaySpecial' => $todaySpecial,
    'hours'        => array_map(static fn($w) => ['open' => $w['open'], 'close' => $w['close']], $hours),
    'schedule'     => array_map(static fn($p) => ['name_ta' => $p['name_ta'], 'name_en' => $p['name_en'], 'time' => sprintf('%02d:%02d', $p['h'], $p['m'])], $schedule),
    'events'       => $upcomingEvents,
]);
