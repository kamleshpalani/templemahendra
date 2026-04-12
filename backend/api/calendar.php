<?php
// backend/api/calendar.php
// Hindu Panchangam Calendar API
// Returns daily tithi, special days (Amavasai, Pournami, Ekadasi, etc.)
// and auspicious/inauspicious timings for a given month.

require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

$year  = (int)($_GET['year']  ?? date('Y'));
$month = (int)($_GET['month'] ?? date('n'));

// Clamp to a safe range
if ($year  < 2020 || $year  > 2035) $year  = (int)date('Y');
if ($month < 1    || $month > 12)   $month = (int)date('n');

// ── Astronomical helpers ──────────────────────────────────────────────────────

/**
 * Julian Day Number for a Gregorian date (at noon).
 */
function jdn(int $y, int $m, float $d): float
{
    if ($m <= 2) { $y--; $m += 12; }
    $A = (int)($y / 100);
    $B = 2 - $A + (int)($A / 4);
    return (int)(365.25 * ($y + 4716))
         + (int)(30.6001 * ($m + 1))
         + $d + $B - 1524.5;
}

/**
 * Moon tithi (0–29) for a given date at ~06:00 IST.
 * Tithi 14 = Pournami, Tithi 29 = Amavasai.
 *
 * Reference new moon: 2000-01-06 18:14 UTC → JDE 2451549.260
 * Synodic month: 29.530588853 days
 */
function moonTithi(int $y, int $m, int $d): array
{
    $refJDE       = 2451549.260;          // known new moon JDE
    $synodicMonth = 29.530588853;

    // 06:00 IST = 00:30 UTC → fractional day 0.5 + 0.5/24 ≈ 0.5208
    $jde      = jdn($y, $m, $d + 0.0208);
    $elapsed  = $jde - $refJDE;
    $phase    = fmod($elapsed / $synodicMonth, 1.0);
    if ($phase < 0) $phase += 1.0;

    $tithi = (int)floor($phase * 30) % 30;
    return ['tithi' => $tithi, 'phase' => round($phase, 4)];
}

// ── Tamil weekday names ───────────────────────────────────────────────────────

const WEEKDAY_TA = ['ஞாயிறு','திங்கள்','செவ்வாய்','புதன்','வியாழன்','வெள்ளி','சனி'];
const WEEKDAY_EN = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// ── Tithi names ───────────────────────────────────────────────────────────────

const TITHI_TA = [
    'பிரதிபதை','துவிதியை','திருதியை','சதுர்த்தி','பஞ்சமி',
    'சஷ்டி','சப்தமி','அஷ்டமி','நவமி','தசமி',
    'ஏகாதசி','துவாதசி','திரயோதசி','சதுர்தசி','பௌர்ணமி',
    'பிரதிபதை','துவிதியை','திருதியை','சதுர்த்தி','பஞ்சமி',
    'சஷ்டி','சப்தமி','அஷ்டமி','நவமி','தசமி',
    'ஏகாதசி','துவாதசி','திரயோதசி','சதுர்தசி','அமாவாசை',
];
const TITHI_EN = [
    'Pratipada','Dvitiya','Tritiya','Chaturthi','Panchami',
    'Sashti','Saptami','Ashtami','Navami','Dasami',
    'Ekadasi','Dvadasi','Trayodasi','Chaturdasi','Pournami (Full Moon)',
    'Pratipada','Dvitiya','Tritiya','Chaturthi','Panchami',
    'Sashti','Saptami','Ashtami','Navami','Dasami',
    'Ekadasi','Dvadasi','Trayodasi','Chaturdasi','Amavasai (New Moon)',
];

// ── Tamil month ───────────────────────────────────────────────────────────────
// Tamil solar months start around the 14th of each Gregorian month.
// Chithirai (1st Tamil month) starts ~Apr 14.

const TAMIL_MONTHS = [
    ['ta' => 'சித்திரை',  'en' => 'Chithirai'],
    ['ta' => 'வைகாசி',   'en' => 'Vaikasi'],
    ['ta' => 'ஆனி',      'en' => 'Aani'],
    ['ta' => 'ஆடி',      'en' => 'Aadi'],
    ['ta' => 'ஆவணி',    'en' => 'Aavani'],
    ['ta' => 'புரட்டாசி', 'en' => 'Purattasi'],
    ['ta' => 'ஐப்பசி',   'en' => 'Aippasi'],
    ['ta' => 'கார்த்திகை','en' => 'Karthigai'],
    ['ta' => 'மார்கழி',  'en' => 'Margazhi'],
    ['ta' => 'தை',       'en' => 'Thai'],
    ['ta' => 'மாசி',     'en' => 'Maasi'],
    ['ta' => 'பங்குனி',  'en' => 'Panguni'],
];

function tamilMonth(int $m, int $d): array
{
    // If day < 14 we are still in the previous Tamil month
    $idx = ($m - 4 - ($d < 14 ? 1 : 0));
    $idx = (($idx % 12) + 12) % 12;
    return TAMIL_MONTHS[$idx];
}

// ── Inauspicious / auspicious timings ────────────────────────────────────────
// Traditional South-Indian timings (6 AM sunrise base, 1.5-hr segments).

const RAHU_KALAM = [
    ['16:30','18:00'], // Sunday
    ['07:30','09:00'], // Monday
    ['15:00','16:30'], // Tuesday
    ['12:00','13:30'], // Wednesday
    ['13:30','15:00'], // Thursday
    ['10:30','12:00'], // Friday
    ['09:00','10:30'], // Saturday
];
const YAMAGANDAM = [
    ['12:00','13:30'], // Sunday
    ['10:30','12:00'], // Monday
    ['09:00','10:30'], // Tuesday
    ['07:30','09:00'], // Wednesday
    ['06:00','07:30'], // Thursday
    ['15:00','16:30'], // Friday
    ['13:30','15:00'], // Saturday
];
const GULIKA_KALAM = [
    ['15:00','16:30'], // Sunday
    ['13:30','15:00'], // Monday
    ['12:00','13:30'], // Tuesday
    ['10:30','12:00'], // Wednesday
    ['09:00','10:30'], // Thursday
    ['07:30','09:00'], // Friday
    ['06:00','07:30'], // Saturday
];
// Nalla Neram (auspicious periods) by weekday — two windows per day
const NALLA_NERAM = [
    [['07:30','09:00'],['22:30','24:00']], // Sunday
    [['06:00','07:30'],['15:00','16:30']], // Monday
    [['07:30','09:00'],['22:30','24:00']], // Tuesday
    [['07:30','09:00'],['12:00','13:30']], // Wednesday
    [['10:30','12:00'],['19:30','21:00']], // Thursday
    [['10:30','12:00'],['16:30','18:00']], // Friday
    [['06:00','07:30'],['19:30','21:00']], // Saturday
];

// ── Special-day classifier ────────────────────────────────────────────────────

function specialDays(int $tithi, int $wd, int $m, int $d): array
{
    $out = [];

    if ($tithi === 14) {
        $out[] = ['type'=>'pournami',  'ta'=>'பௌர்ணமி',    'en'=>'Pournami'];
    }
    if ($tithi === 29) {
        $out[] = ['type'=>'amavasai',  'ta'=>'அமாவாசை',    'en'=>'Amavasai'];
    }
    if ($tithi === 10 || $tithi === 25) {
        $out[] = ['type'=>'ekadasi',   'ta'=>'ஏகாதசி',     'en'=>'Ekadasi'];
    }
    if ($tithi === 5  || $tithi === 20) {
        $out[] = ['type'=>'sashti',    'ta'=>'சஷ்டி',      'en'=>'Sashti'];
    }
    if ($tithi === 12 || $tithi === 27) {
        $out[] = ['type'=>'pradosham', 'ta'=>'பிரதோஷம்',   'en'=>'Pradosham'];
    }
    if ($tithi === 3) {
        $out[] = ['type'=>'chaturthi', 'ta'=>'சதுர்த்தி',  'en'=>'Vinayagar Chaturthi'];
    }
    if ($tithi === 0 || $tithi === 15) {
        $out[] = ['type'=>'pratipada', 'ta'=>'பிரதிபதை',   'en'=>'Pratipada'];
    }

    // Fixed Tamil/Hindu festival dates (MM-DD)
    $md = sprintf('%02d-%02d', $m, $d);
    $festivals = [
        '01-14' => ['type'=>'festival','ta'=>'பொங்கல்',           'en'=>'Pongal'],
        '01-15' => ['type'=>'festival','ta'=>'மாட்டுப் பொங்கல்',  'en'=>'Mattu Pongal'],
        '01-16' => ['type'=>'festival','ta'=>'காணும் பொங்கல்',    'en'=>'Kaanum Pongal'],
        '04-14' => ['type'=>'festival','ta'=>'தமிழ் புத்தாண்டு',  'en'=>'Tamil New Year'],
        '04-15' => ['type'=>'festival','ta'=>'விஷு',              'en'=>'Vishu'],
        '10-02' => ['type'=>'festival','ta'=>'கடல் விழா',         'en'=>'Navratri Begin'],
        '11-01' => ['type'=>'festival','ta'=>'தீபாவளி',           'en'=>'Deepavali'],
    ];
    if (isset($festivals[$md])) {
        $out[] = $festivals[$md];
    }

    return $out;
}

// ── Build response ────────────────────────────────────────────────────────────

$daysInMonth = cal_days_in_month(CAL_GREGORIAN, $month, $year);
$days        = [];

for ($d = 1; $d <= $daysInMonth; $d++) {
    $ts  = mktime(0, 0, 0, $month, $d, $year);
    $wd  = (int)date('w', $ts);
    $moon = moonTithi($year, $month, $d);
    $tithi = $moon['tithi'];

    $days[] = [
        'date'        => sprintf('%04d-%02d-%02d', $year, $month, $d),
        'day'         => $d,
        'weekday'     => $wd,
        'weekday_ta'  => WEEKDAY_TA[$wd],
        'weekday_en'  => WEEKDAY_EN[$wd],
        'tithi'       => $tithi,
        'tithi_ta'    => TITHI_TA[$tithi],
        'tithi_en'    => TITHI_EN[$tithi],
        'tamil_month' => tamilMonth($month, $d),
        'special'     => specialDays($tithi, $wd, $month, $d),
        'timings'     => [
            'abhijit_muhurtham' => ['06:00','07:30'],  // ~ sunrise muhurtham slot
            'brahma_muhurtham'  => ['04:30','06:00'],
            'nalla_neram'       => NALLA_NERAM[$wd],
            'rahu_kalam'        => RAHU_KALAM[$wd],
            'yamagandam'        => YAMAGANDAM[$wd],
            'gulika_kalam'      => GULIKA_KALAM[$wd],
        ],
    ];
}

$todayStr  = date('Y-m-d');
$todayData = null;
foreach ($days as $day) {
    if ($day['date'] === $todayStr) { $todayData = $day; break; }
}

// Collect upcoming special days within this month (or today onward)
$upcoming = array_filter($days, fn($day) =>
    $day['date'] >= $todayStr && !empty($day['special'])
);

sendJson([
    'year'           => $year,
    'month'          => $month,
    'month_name_en'  => date('F', mktime(0, 0, 0, $month, 1, $year)),
    'month_name_ta'  => ['','ஜனவரி','பிப்ரவரி','மார்ச்','ஏப்ரல்',
                          'மே','ஜூன்','ஜூலை','ஆகஸ்ட்',
                          'செப்டம்பர்','அக்டோபர்','நவம்பர்','டிசம்பர்'][$month],
    'days'           => $days,
    'today'          => $todayData,
    'upcoming'       => array_values($upcoming),
]);
