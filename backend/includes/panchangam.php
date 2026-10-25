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
