<?php
// backend/api/pournamis.php
// Returns all upcoming Pournami (Full Moon) dates for the next N months.
// Uses the same astronomical calculation as calendar.php.
// Single efficient call — avoids N separate /calendar requests on the client.

require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

$tz           = new DateTimeZone('Asia/Kolkata');
$now          = new DateTime('now', $tz);
$today        = $now->format('Y-m-d');
$months_ahead = min(24, max(1, (int)($_GET['months'] ?? 13)));

// ── Astronomical helpers (duplicated from calendar.php) ──────────────────────

function jdn(int $y, int $m, float $d): float
{
    if ($m <= 2) { $y--; $m += 12; }
    $A = (int)($y / 100);
    $B = 2 - $A + (int)($A / 4);
    return (int)(365.25 * ($y + 4716))
         + (int)(30.6001 * ($m + 1))
         + $d + $B - 1524.5;
}

function moonTithi(int $y, int $m, int $d): int
{
    $refJDE       = 2451549.260;
    $synodicMonth = 29.530588853;
    $jde          = jdn($y, $m, $d + 0.0208); // ~06:00 IST
    $elapsed      = $jde - $refJDE;
    $phase        = fmod($elapsed / $synodicMonth, 1.0);
    if ($phase < 0) $phase += 1.0;
    return (int)floor($phase * 30) % 30;
}

// ── Lookup tables ─────────────────────────────────────────────────────────────

const WEEKDAY_TA = ['ஞாயிறு','திங்கள்','செவ்வாய்','புதன்','வியாழன்','வெள்ளி','சனி'];
const WEEKDAY_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const TAMIL_MONTHS = [
    ['ta'=>'சித்திரை', 'en'=>'Chithirai'],
    ['ta'=>'வைகாசி',  'en'=>'Vaikasi'],
    ['ta'=>'ஆனி',     'en'=>'Aani'],
    ['ta'=>'ஆடி',     'en'=>'Aadi'],
    ['ta'=>'ஆவணி',   'en'=>'Aavani'],
    ['ta'=>'புரட்டாசி','en'=>'Purattasi'],
    ['ta'=>'ஐப்பசி',  'en'=>'Aippasi'],
    ['ta'=>'கார்த்திகை','en'=>'Karthigai'],
    ['ta'=>'மார்கழி', 'en'=>'Margazhi'],
    ['ta'=>'தை',      'en'=>'Thai'],
    ['ta'=>'மாசி',    'en'=>'Maasi'],
    ['ta'=>'பங்குனி', 'en'=>'Panguni'],
];

function tamilMonth(int $m, int $d): array
{
    $idx = ($m - 4 - ($d < 14 ? 1 : 0));
    $idx = (($idx % 12) + 12) % 12;
    return TAMIL_MONTHS[$idx];
}

// ── Collect pournami dates ────────────────────────────────────────────────────

$pournamis = [];

for ($offset = 0; $offset < $months_ahead; $offset++) {
    $dt          = (clone $now)->modify("first day of this month +{$offset} months");
    $y           = (int)$dt->format('Y');
    $m           = (int)$dt->format('n');
    $daysInMonth = cal_days_in_month(CAL_GREGORIAN, $m, $y);

    for ($d = 1; $d <= $daysInMonth; $d++) {
        $dateStr = sprintf('%04d-%02d-%02d', $y, $m, $d);
        if ($dateStr < $today) continue;

        if (moonTithi($y, $m, $d) === 14) { // tithi 14 = Pournami
            $ts       = mktime(0, 0, 0, $m, $d, $y);
            $wd       = (int)date('w', $ts);
            $tamMonth = tamilMonth($m, $d);

            $pournamis[] = [
                'date'        => $dateStr,
                'weekday_ta'  => WEEKDAY_TA[$wd],
                'weekday_en'  => WEEKDAY_EN[$wd],
                'tamil_month' => $tamMonth,
                'title_ta'    => 'பௌர்ணமி பூஜை — ' . $tamMonth['ta'],
                'title_en'    => 'Pournami Poojai — ' . $tamMonth['en'],
                'desc_ta'     => $tamMonth['ta'] . ' மாத பௌர்ணமி | ' . WEEKDAY_TA[$wd] . ' | மாலை 4 மணி முதல் 9 மணி வரை',
                'desc_en'     => $tamMonth['en'] . ' month Pournami | ' . WEEKDAY_EN[$wd] . ' | 4:00 PM – 9:00 PM',
                'time'        => '4:00 PM – 9:00 PM',
            ];
        }
    }
}

sendJson($pournamis);
