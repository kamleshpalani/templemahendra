<?php
/**
 * backend/includes/panchangam.php — the temple's lunar arithmetic in one place.
 *
 * The same mean-synodic-month tithi that api/calendar.php and api/pournamis.php
 * compute (tithi read at about 06:00 IST), so the Poojas admin's "Generate from
 * Panchangam" action, the homepage engine and the calendar agree on which day
 * is Pournami. Function names carry a panch prefix so this file can be loaded
 * next to either endpoint without a redeclaration.
 *
 * Observances, by tithi index (0 = Shukla Pratipada … 14 = Pournami … 29 = Amavasai):
 *   pournami   14            amavasai   29
 *   ekadasi    10, 25        sashti      5, 20
 *   pradosham  12, 27        chaturthi  18  (Sankatahara — Krishna paksha; the
 *                                            brief's observance. Vinayagar
 *                                            Chaturthi, tithi 3, is a festival,
 *                                            not a monthly pooja.)
 *
 * Nalla Neram lives here too, until the committee can edit it (brief §15 lists
 * it as a Temple CMS item): one table read by the calendar and the homepage
 * instead of three copies drifting apart.
 */

/** Julian Day Number for a Gregorian date at noon; fractional days allowed. */
function panchJdn(int $y, int $m, float $d): float
{
    if ($m <= 2) { $y--; $m += 12; }
    $A = (int) ($y / 100);
    $B = 2 - $A + (int) ($A / 4);
    return (int) (365.25 * ($y + 4716)) + (int) (30.6001 * ($m + 1)) + $d + $B - 1524.5;
}

/** The tithi (0–29) in force at about 06:00 IST on a Gregorian date. */
function panchTithi(int $y, int $m, int $d): int
{
    $refJDE       = 2451549.260;   // a reference new moon (2000-01-06 18:14 UT)
    $synodicMonth = 29.530588853;
    $jde          = panchJdn($y, $m, $d + 0.0208);
    $phase        = fmod(($jde - $refJDE) / $synodicMonth, 1.0);
    if ($phase < 0) $phase += 1.0;
    return (int) floor($phase * 30) % 30;
}

/** The observances a pooja can be generated for: key => [tithis, Tamil, English]. */
const PANCH_OBSERVANCES = [
    'pournami'  => ['tithis' => [14],     'ta' => 'பௌர்ணமி',              'en' => 'Pournami'],
    'amavasai'  => ['tithis' => [29],     'ta' => 'அமாவாசை',              'en' => 'Amavasai'],
    'ekadasi'   => ['tithis' => [10, 25], 'ta' => 'ஏகாதசி',               'en' => 'Ekadasi'],
    'sashti'    => ['tithis' => [5, 20],  'ta' => 'சஷ்டி',                'en' => 'Sashti'],
    'pradosham' => ['tithis' => [12, 27], 'ta' => 'பிரதோஷம்',             'en' => 'Pradosham'],
    'chaturthi' => ['tithis' => [18],     'ta' => 'சங்கடஹர சதுர்த்தி',    'en' => 'Sankatahara Chaturthi'],
];

/**
 * Every date (Y-m-d) on which the observance falls, from $fromYmd (inclusive)
 * for $months calendar months. Consecutive days with the same tithi (a tithi
 * can straddle two sunrises) count once — the first day.
 */
function panchObservanceDates(string $type, string $fromYmd, int $months): array
{
    $spec = PANCH_OBSERVANCES[$type] ?? null;
    if ($spec === null || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $fromYmd, $m)) return [];
    $months = max(1, min(24, $months));
    $start  = new DateTimeImmutable($fromYmd);
    $end    = $start->modify('first day of this month')->modify('+' . $months . ' months');
    $out    = [];
    $prevHit = false;
    for ($day = $start; $day < $end; $day = $day->modify('+1 day')) {
        $hit = in_array(panchTithi((int) $day->format('Y'), (int) $day->format('n'), (int) $day->format('j')), $spec['tithis'], true);
        if ($hit && !$prevHit) $out[] = $day->format('Y-m-d');
        $prevHit = $hit;
    }
    return $out;
}

/** Nalla Neram (auspicious periods) by weekday, 0 = Sunday: two [from, to] windows. */
function panchNallaNeram(int $wd): array
{
    $wd = (($wd % 7) + 7) % 7;
    // The committee's table (Admin → Temple → Nalla Neram, migration 025) when
    // it is complete; the built-in one otherwise.
    if (!function_exists('siteSettingJson')) require_once __DIR__ . '/site_settings.php';
    try {
        $own = siteSettingJson('nalla_neram');
        $ok  = count($own) === 7;
        for ($d = 0; $ok && $d < 7; $d++) {
            $ok = isset($own[$d]) && is_array($own[$d]) && count($own[$d]) === 2
               && is_array($own[$d][0]) && is_array($own[$d][1])
               && isset($own[$d][0][0], $own[$d][0][1], $own[$d][1][0], $own[$d][1][1]);
        }
        if ($ok) return [[(string) $own[$wd][0][0], (string) $own[$wd][0][1]], [(string) $own[$wd][1][0], (string) $own[$wd][1][1]]];
    } catch (Throwable) {
        // fall through to the built-in table
    }
    static $table = [
        [['07:30', '09:00'], ['22:30', '24:00']], // Sun
        [['06:00', '07:30'], ['15:00', '16:30']], // Mon
        [['07:30', '09:00'], ['22:30', '24:00']], // Tue
        [['07:30', '09:00'], ['12:00', '13:30']], // Wed
        [['10:30', '12:00'], ['19:30', '21:00']], // Thu
        [['10:30', '12:00'], ['16:30', '18:00']], // Fri
        [['06:00', '07:30'], ['19:30', '21:00']], // Sat
    ];
    return $table[$wd];
}

/** "18:30:00" → "6:30 PM"; null/blank → ''. */
function panchClock(?string $time): string
{
    if ($time === null || !preg_match('/^(\d{1,2}):(\d{2})/', $time, $m)) return '';
    $h = (int) $m[1] % 24;
    $suffix = $h >= 12 ? 'PM' : 'AM';
    $h12 = $h % 12 === 0 ? 12 : $h % 12;
    return $h12 . ':' . $m[2] . ' ' . $suffix;
}

/** A display string for a pooja's timing: the typed range, else the free-text column. */
function panchTimeLabel(?string $start, ?string $end, ?string $legacy): string
{
    $s = panchClock($start);
    $e = panchClock($end);
    if ($s !== '' && $e !== '') return $s . ' – ' . $e;
    if ($s !== '') return $s;
    return trim((string) $legacy);
}
