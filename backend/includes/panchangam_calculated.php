<?php
require_once __DIR__ . '/gowri.php';

function panchangamCalculatedMonth(int $year, int $month): array
{
    if ($year < 2020 || $year > 2035 || $month < 1 || $month > 12) {
        throw new InvalidArgumentException('Calendar date outside supported range');
    }
    $path = __DIR__ . '/../data/panchangam/' . $year . '.json';
    if (!is_readable($path)) throw new RuntimeException('Missing offline ephemeris year ' . $year);
    try {
        $data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $e) {
        throw new RuntimeException('Invalid offline ephemeris year ' . $year, 0, $e);
    }
    $ta = ['பிரதிபதை','துவிதியை','திருதியை','சதுர்த்தி','பஞ்சமி','சஷ்டி','சப்தமி','அஷ்டமி','நவமி','தசமி','ஏகாதசி','துவாதசி','திரயோதசி','சதுர்தசி','பௌர்ணமி'];
    $en = ['Pratipada','Dvitiya','Tritiya','Chaturthi','Panchami','Sashti','Saptami','Ashtami','Navami','Dasami','Ekadasi','Dvadasi','Trayodasi','Chaturdasi','Pournami (Full Moon)'];
    $weekTa = ['ஞாயிறு','திங்கள்','செவ்வாய்','புதன்','வியாழன்','வெள்ளி','சனி'];
    $days = [];
    for ($d = 1; $d <= cal_days_in_month(CAL_GREGORIAN, $month, $year); $d++) {
        $date = sprintf('%04d-%02d-%02d', $year, $month, $d);
        $row = $data['days'][$date] ?? null;
        if (!is_array($row) || !isset($row['tithi'], $row['sunrise'], $row['sunset'], $row['timings'], $row['tithi_end'])) {
            throw new RuntimeException('Incomplete offline ephemeris for ' . $date);
        }
        $local = new DateTimeImmutable($date, new DateTimeZone('Asia/Kolkata'));
        $wd = (int)$local->format('w');
        $tithi = $row['tithi'];
        $special = [];
        // These are sunrise lunar-day markers, not priest-approved festival or pooja dates.
        if ($tithi === 14) $special[] = ['type' => 'pournami', 'ta' => 'பௌர்ணமி', 'en' => 'Pournami'];
        if ($tithi === 29) $special[] = ['type' => 'amavasai', 'ta' => 'அமாவாசை', 'en' => 'Amavasai'];
        if ($tithi === 10 || $tithi === 25) $special[] = ['type' => 'ekadasi', 'ta' => 'ஏகாதசி திதி', 'en' => 'Ekadasi tithi'];
        $days[] = [
            'date' => $date, 'day' => $d, 'weekday' => $wd,
            'weekday_ta' => $weekTa[$wd], 'weekday_en' => $local->format('l'),
            'tithi' => $tithi, 'tithi_ta' => $tithi === 29 ? 'அமாவாசை' : $ta[$tithi % 15],
            'tithi_en' => $tithi === 29 ? 'Amavasai (New Moon)' : $en[$tithi % 15],
            'paksha' => $tithi < 15 ? 'shukla' : 'krishna',
            'tithi_end' => $row['tithi_end'], 'tamil_month' => null,
            'nakshatram_ta' => null, 'nakshatram_en' => null,
            'sunrise' => $row['sunrise'], 'sunset' => $row['sunset'],
            'verified' => false, 'calculated' => true,
            'source' => $data['engine'] . '; sunrise tithi and daylight-eighth timings; not priest verified',
            'location' => $data['location']['name'], 'timezone' => $data['location']['timezone'],
            'coordinates' => [$data['location']['latitude'], $data['location']['longitude']],
            'gowri_periods' => panchangamGowri($wd, $row['sunrise'], $row['sunset']),
            'temple_pin_confirmed' => $data['location']['temple_pin_confirmed'],
            'special' => $special, 'timings' => $row['timings'],
        ];
    }
    return ['days' => $days, 'calculation' => [
        'engine' => $data['engine'], 'convention' => $data['convention'], 'location' => $data['location'],
    ]];
}
