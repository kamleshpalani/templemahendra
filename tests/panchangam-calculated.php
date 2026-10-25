<?php
require_once __DIR__ . '/../backend/includes/panchangam_calculated.php';
$checks = 0;
function checkPanchangam(bool $ok, string $message): void {
    global $checks;
    $checks++;
    if (!$ok) throw new RuntimeException($message);
}
foreach (range(2020, 2035) as $year) {
    foreach (range(1, 12) as $month) {
        $result = panchangamCalculatedMonth($year, $month);
        checkPanchangam(count($result['days']) === cal_days_in_month(CAL_GREGORIAN, $month, $year), 'Month length');
        foreach ($result['days'] as $day) {
            checkPanchangam($day['tithi'] >= 0 && $day['tithi'] <= 29, 'Tithi range');
            checkPanchangam(!$day['verified'] && $day['calculated'], 'Provenance');
            checkPanchangam($day['timings']['nalla_neram'] === [] && $day['nakshatram_en'] === null, 'No invented auspicious data');
            checkPanchangam($day['sunrise'] < $day['sunset'], 'Solar ordering');
            checkPanchangam(count($day['gowri_periods']) === 5, 'Five auspicious daytime Gowri slots');
            $previousEnd = $day['sunrise'];
            foreach ($day['gowri_periods'] as $period) {
                checkPanchangam($period['start'] >= $previousEnd && $period['end'] > $period['start']
                    && $period['end'] <= $day['sunset'], 'Ordered daytime Gowri bounds');
                checkPanchangam(in_array($period['name_en'], ['Uthi', 'Amirtham', 'Labam', 'Dhanam', 'Sugam'], true)
                    && $period['name_ta'] !== '', 'Bilingual auspicious Gowri names');
                $previousEnd = $period['end'];
            }
            $sunrise = strtotime($day['date'] . 'T' . $day['sunrise'] . ':00+05:30');
            $sunset = strtotime($day['date'] . 'T' . $day['sunset'] . ':00+05:30');
            $end = strtotime($day['tithi_end']);
            checkPanchangam($end > $sunrise - 30 && $end < $sunrise + 30 * 3600, 'Next tithi boundary (sunrise rounded to minute)');
            foreach (['rahu_kalam', 'yamagandam', 'gulika_kalam'] as $key) {
                [$start, $finish] = $day['timings'][$key];
                $a = strtotime($day['date'] . 'T' . $start . ':00+05:30');
                $b = strtotime($day['date'] . 'T' . $finish . ':00+05:30');
                checkPanchangam($a >= $sunrise && $b <= $sunset && abs(($b - $a) - ($sunset - $sunrise) / 8) <= 90, 'Daylight eighth');
            }
        }
    }
}
$fixture = panchangamGowri(0, '06:00', '18:00');
checkPanchangam(array_column($fixture, 'start') === ['06:00', '07:30', '10:30', '12:00', '13:30'], 'Sunday equal-day reference');
checkPanchangam(array_column($fixture, 'end') === ['07:30', '09:00', '12:00', '13:30', '15:00'], 'Sunday reference ends');
checkPanchangam(array_column($fixture, 'name_en') === ['Uthi', 'Amirtham', 'Labam', 'Dhanam', 'Sugam'], 'Sunday reference labels');
checkPanchangam(panchangamGowri(0, '07:00', '17:00')[1]['start'] === '08:15', 'Gowri scales to actual daylight');
foreach ([[-1, '06:00', '18:00'], [7, '06:00', '18:00'], [0, '18:00', '06:00'], [0, '06:xx', '18:00']] as $invalid) {
    $rejected = false;
    try {
        panchangamGowri(...$invalid);
    } catch (InvalidArgumentException $e) {
        $rejected = true;
    }
    checkPanchangam($rejected, 'Invalid Gowri input rejected explicitly');
}
// Published 2024 phase times (UTC), rounded to the minute:
// https://aa.usno.navy.mil/calculated/moon/phases?date=2024-01-01&nump=50&format=p
foreach ([['2024-03-25', 14, '2024-03-25T07:00:00Z'], ['2024-04-08', 29, '2024-04-08T18:21:00Z']] as [$date, $tithi, $phase]) {
    $days = panchangamCalculatedMonth(2024, (int)substr($date, 5, 2))['days'];
    $day = $days[(int)substr($date, 8, 2) - 1];
    checkPanchangam($day['tithi'] === $tithi, 'Reference lunar day ' . $date);
    checkPanchangam(abs(strtotime($day['tithi_end']) - strtotime($phase)) <= 180, 'Reference phase within three minutes ' . $date);
}
echo "$checks checks passed\n";
