<?php
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/calendar_entries.php';
require_once __DIR__ . '/../includes/panchangam.php';
require_once __DIR__ . '/../includes/panchangam_calculated.php';
require_once __DIR__ . '/../includes/public_content.php';

setCorsHeaders();
$todayIST = new DateTimeImmutable('now', new DateTimeZone('Asia/Kolkata'));
$year = filter_var($_GET['year'] ?? $todayIST->format('Y'), FILTER_VALIDATE_INT);
$month = filter_var($_GET['month'] ?? $todayIST->format('n'), FILTER_VALIDATE_INT);
if ($year === false || $month === false || $year < 2020 || $year > 2035 || $month < 1 || $month > 12) {
    sendJson(['error' => 'Calendar supports valid months from 2020 through 2035.'], 422);
    exit;
}
try {
    $calendar = panchangamCalculatedMonth($year, $month);
} catch (RuntimeException $e) {
    error_log('Panchangam calculation data: ' . $e->getMessage());
    sendJson(['error' => 'Calendar calculation data is unavailable. Please contact the temple office.'], 503);
    exit;
}
$days = panchangamApplyVerified($calendar['days']);
$days = calendarApplyEntries($days, calendarEntriesBetween($days[0]['date'], $days[count($days) - 1]['date']));
foreach ($days as &$day) {
    $day['special'] = publicContentVisible($day['special']);
    if (publicContentIsHidden(['ta' => $day['tithi_ta'], 'en' => $day['tithi_en']])) {
        $day['tithi_ta'] = null;
        $day['tithi_en'] = null;
        $day['tithi_end'] = null;
    }
}
unset($day);
$today = $todayIST->format('Y-m-d');
$todayData = null;
foreach ($days as $day) {
    if ($day['date'] === $today) $todayData = $day;
}
sendJson([
    'year' => $year,
    'month' => $month,
    'month_name_en' => $todayIST->setDate($year, $month, 1)->format('F'),
    'month_name_ta' => ['','ஜனவரி','பிப்ரவரி','மார்ச்','ஏப்ரல்','மே','ஜூன்','ஜூலை','ஆகஸ்ட்','செப்டம்பர்','அக்டோபர்','நவம்பர்','டிசம்பர்'][$month],
    'calculation' => $calendar['calculation'],
    'days' => $days,
    'today' => $todayData,
    'upcoming' => array_values(array_filter($days, fn($day) => $day['date'] >= $today && !empty($day['special']))),
]);
