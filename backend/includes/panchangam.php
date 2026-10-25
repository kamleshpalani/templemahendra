<?php
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/public_guard.php';

const PANCHANGAM_LOCATION = 'Pudupatti, Thiruvengadam Taluk, Tenkasi District';
const PANCHANGAM_TIMINGS = [
    'nalla_neram' => 'Nalla Neram',
    'gulika_kalam' => 'Gulikai',
    'yamagandam' => 'Yamagandam',
    'rahu_kalam' => 'Rahu Kalam',
    'brahma_muhurtham' => 'Brahma Muhurtham',
];

function panchangamReady(): bool
{
    return publicGuardHasColumn('panchangam_days', 'calendar_date');
}

/** Parse explicitly entered local time windows, never calculate auspicious times. */
function panchangamParseTimes(string $value): ?array
{
    $pairs = [];
    foreach (explode(',', $value) as $part) {
        if (!preg_match('/^\s*((?:[01]\d|2[0-3]):[0-5]\d)\s*-\s*((?:[01]\d|2[0-3]):[0-5]\d|24:00)\s*$/', $part, $m)
            || $m[1] >= $m[2]) return null;
        $pairs[] = [$m[1], $m[2]];
    }
    return count($pairs) <= 4 ? $pairs : null;
}

function panchangamApplyVerified(array $days): array
{
    if (!panchangamReady()) return $days;
    $stmt = getDB()->prepare('SELECT * FROM panchangam_days WHERE calendar_date BETWEEN ? AND ?');
    $stmt->execute([$days[0]['date'], $days[count($days) - 1]['date']]);
    $rows = [];
    foreach ($stmt->fetchAll() as $row) $rows[$row['calendar_date']] = $row;
    foreach ($days as &$day) {
        if (!isset($rows[$day['date']])) continue;
        $row = $rows[$day['date']];
        // Verified text must never inherit conflicting computed lunar highlights.
        $day['estimated_tithi'] = $day['tithi'];
        $day['tithi'] = null;
        $day['calculated'] = false;
        $day['tithi_end'] = null;
        $day['paksha'] = null;
        $day['sunrise'] = null;
        $day['sunset'] = null;
        $day['gowri_periods'] = [];
        $day['tamil_month'] = null;
        $day['special'] = [];
        $day['tithi_ta'] = $row['tithi_ta'];
        $day['tithi_en'] = $row['tithi_en'];
        $day['nakshatram_ta'] = $row['nakshatram_ta'];
        $day['nakshatram_en'] = $row['nakshatram_en'];
        $day['timings'] = json_decode($row['timings'], true, 512, JSON_THROW_ON_ERROR);
        $day['verified'] = true;
        $day['source'] = $row['source'];
        $day['location'] = $row['location'];
        $day['timezone'] = $row['timezone'];
    }
    unset($day);
    return $days;
}

/**
 * Shared Panchangam records and observance helpers.
 *
 * Generated pooja dates use the same local sunrise ephemeris as api/calendar.php.
 * Function names carry a panch prefix so this file can be loaded next to the
 * public calendar without a redeclaration.
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

/** Sunrise tithi from the same location-specific ephemeris as the public calendar. */
function panchTithi(int $y, int $m, int $d): int
{
    require_once __DIR__ . '/panchangam_calculated.php';
    static $months = [];
    $key = sprintf('%04d-%02d', $y, $m);
    $months[$key] ??= panchangamCalculatedMonth($y, $m)['days'];
    if (!isset($months[$key][$d - 1])) {
        throw new InvalidArgumentException('Invalid Panchangam day');
    }
    return $months[$key][$d - 1]['tithi'];
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
