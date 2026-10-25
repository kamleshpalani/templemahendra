<?php

// Weekday ordering adapted from ag-sanjjeev/nalla-neram-js (MIT).
// See docs/licenses/nalla-neram-js.txt. Scale the ordering to local daylight.
function panchangamGowri(int $weekday, string $sunrise, string $sunset): array
{
    $orders = [
        ['uthi','amirtham','rogam','labam','dhanam','sugam','visham','soram'],
        ['amirtham','visham','rogam','labam','dhanam','sugam','soram','uthi'],
        ['rogam','labam','dhanam','sugam','visham','uthi','soram','amirtham'],
        ['labam','dhanam','sugam','visham','soram','amirtham','uthi','rogam'],
        ['dhanam','sugam','soram','amirtham','uthi','visham','rogam','labam'],
        ['sugam','soram','uthi','visham','amirtham','dhanam','labam','rogam'],
        ['soram','uthi','visham','amirtham','rogam','labam','sugam','dhanam'],
    ];
    $names = [
        'uthi' => ['உத்தி', 'Uthi'], 'amirtham' => ['அமிர்தம்', 'Amirtham'],
        'labam' => ['லாபம்', 'Labam'], 'dhanam' => ['தனம்', 'Dhanam'], 'sugam' => ['சுகம்', 'Sugam'],
    ];
    $minutes = static function (string $time): int {
        if (!preg_match('/^(?:[01]\d|2[0-3]):[0-5]\d$/', $time)) throw new InvalidArgumentException('Invalid solar time');
        [$h, $m] = array_map('intval', explode(':', $time));
        return $h * 60 + $m;
    };
    $start = $minutes($sunrise);
    $finish = $minutes($sunset);
    if ($weekday < 0 || $weekday > 6 || $finish <= $start) throw new InvalidArgumentException('Invalid Gowri calculation inputs');
    $clock = static fn(int $n): string => sprintf('%02d:%02d', intdiv($n, 60), $n % 60);
    $periods = [];
    foreach ($orders[$weekday] as $i => $name) {
        if (!isset($names[$name])) continue;
        $periods[] = [
            'start' => $clock((int)round($start + ($finish - $start) * $i / 8)),
            'end' => $clock((int)round($start + ($finish - $start) * ($i + 1) / 8)),
            'name_ta' => $names[$name][0], 'name_en' => $names[$name][1],
        ];
    }
    return $periods;
}
