<?php
/**
 * backend/includes/live/time.php — UTC instants and the wall clock the
 * committee schedules in (docs/live/SPEC-PHASE1.md §4.1).
 *
 * Every live_streams DATETIME is UTC. The admin types a date and time in the
 * stream's own zone (Asia/Kolkata unless chosen otherwise); these helpers turn
 * that into the stored instant and back, and produce the ISO-8601 "Z" form the
 * public API answers with. They wrap the notification service's clock
 * (notify/time.php) so a test clock set there is honoured here too.
 */

/** Now, in UTC, as MySQL stores it: 'Y-m-d H:i:s'. */
function liveUtcNow(): string
{
    return notifyNow();
}

/** True for an IANA zone name PHP knows ("Asia/Kolkata"); false for anything else. */
function liveIsTimezone(mixed $tz): bool
{
    return notifyIsTimezone($tz);
}

/**
 * A wall-clock time in a zone → the UTC instant 'Y-m-d H:i:s', or null.
 *
 * Accepts 'Y-m-d H:i', 'Y-m-d H:i:s' and the 'Y-m-dTH:i' form a datetime-local
 * input submits. Anything else — a date alone, "9999-99-99", an unknown zone —
 * is null: the caller reports a field error rather than storing a guess.
 */
function liveToUtc(string $local, string $tz): ?string
{
    if (!liveIsTimezone($tz)) return null;
    $s = trim(str_replace('T', ' ', $local));
    if ($s === '' || strlen($s) > 32) return null;
    foreach (['Y-m-d H:i:s', 'Y-m-d H:i'] as $format) {
        $parts = date_parse_from_format($format, $s);
        if ($parts['error_count'] > 0 || $parts['warning_count'] > 0) continue;
        if (!checkdate((int) $parts['month'], (int) $parts['day'], (int) $parts['year'])) return null;
        try {
            $d = DateTimeImmutable::createFromFormat('!' . $format, $s, new DateTimeZone($tz));
        } catch (Throwable) {
            return null;
        }
        if ($d === false) continue;
        return $d->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }
    return null;
}

/**
 * A stored UTC instant → the wall clock in a zone. An unknown zone means the
 * temple's; an unreadable instant gives ''.
 */
function liveFromUtc(string $utc, string $tz, string $fmt = 'Y-m-d H:i'): string
{
    $zone = liveIsTimezone($tz) ? $tz : liveTempleTz();
    $s = trim($utc);
    if ($s === '' || str_starts_with($s, '0000-00-00')) return '';
    try {
        return (new DateTimeImmutable($s, new DateTimeZone('UTC')))->setTimezone(new DateTimeZone($zone))->format($fmt);
    } catch (Throwable) {
        return '';
    }
}

/** A stored UTC time as ISO-8601 with a Z ('2026-09-14T12:30:00Z'), or null. */
function liveIso(?string $utc): ?string
{
    return notifyIso($utc);
}

/** True when a stored UTC time parses and is no more than $seconds before now. */
function liveFresh(?string $utc, int $seconds): bool
{
    if ($utc === null || trim($utc) === '') return false;
    $ts = strtotime($utc . ' UTC');
    if ($ts === false) return false;
    $age = strtotime(liveUtcNow() . ' UTC') - $ts;
    return $age >= 0 && $age <= $seconds;
}

/**
 * The wall-clock date and time of a UTC instant in a zone, as the admin form
 * shows them: ['date' => 'Y-m-d', 'time' => 'H:i'], both null for a null instant.
 *
 * @return array{date: ?string, time: ?string}
 */
function liveLocalParts(?string $utc, string $tz): array
{
    if ($utc === null || trim($utc) === '') return ['date' => null, 'time' => null];
    $s = liveFromUtc($utc, $tz, 'Y-m-d|H:i');
    if ($s === '' || !str_contains($s, '|')) return ['date' => null, 'time' => null];
    [$date, $time] = explode('|', $s, 2);
    return ['date' => $date, 'time' => $time];
}

/* ── Schedule windows (docs/live/SPEC-PHASE2.md §1.2) ──────────────────── */

/**
 * Today's date ('Y-m-d') on the wall clock of a zone, by the module's own
 * clock (a test clock set in notify/time.php moves the schedule with it). An
 * unknown zone means the temple's.
 */
function liveTodayLocal(string $tz): string
{
    $d = liveFromUtc(liveUtcNow(), $tz, 'Y-m-d');
    return $d !== '' ? $d : gmdate('Y-m-d');
}

/**
 * A local date moved by whole days: '2026-09-30' + 1 → '2026-10-01',
 * '2026-12-31' + 1 → '2027-01-01'. Null when the date is not a real one.
 */
function liveShiftDateLocal(string $ymd, int $days, string $tz): ?string
{
    $zone = new DateTimeZone(liveIsTimezone($tz) ? $tz : liveTempleTz());
    $parts = date_parse_from_format('Y-m-d', trim($ymd));
    if ($parts['error_count'] > 0 || $parts['warning_count'] > 0) return null;
    if (!checkdate((int) $parts['month'], (int) $parts['day'], (int) $parts['year'])) return null;
    $d = DateTimeImmutable::createFromFormat('!Y-m-d', trim($ymd), $zone);
    if ($d === false) return null;
    return $d->modify(($days >= 0 ? '+' : '') . $days . ' days')->format('Y-m-d');
}

/**
 * One local calendar day as a UTC window: ['from' => that day's 00:00:00,
 * 'to' => the next day's 00:00:00] (both 'Y-m-d H:i:s' UTC; `to` is
 * exclusive, so 23:59:59 local is inside and the next midnight is not). In
 * Asia/Kolkata, '2026-09-15' → from '2026-09-14 18:30:00' to
 * '2026-09-15 18:30:00'. Null for a date that is not real or a zone PHP does
 * not know.
 *
 * @return ?array{from: string, to: string}
 */
function liveDayRangeUtc(string $ymd, string $tz): ?array
{
    if (!liveIsTimezone($tz)) return null;
    $next = liveShiftDateLocal($ymd, 1, $tz);
    if ($next === null) return null;
    $from = liveToUtc(trim($ymd) . ' 00:00', $tz);
    $to   = liveToUtc($next . ' 00:00', $tz);
    return $from !== null && $to !== null ? ['from' => $from, 'to' => $to] : null;
}

/**
 * The week from a local date through the coming Sunday inclusive, as a UTC
 * window ('to' exclusive, like liveDayRangeUtc). A Sunday is a week of one
 * day; a Monday runs seven. The window follows the calendar across month and
 * year ends ('2026-12-30' ends on Sunday 2027-01-03).
 *
 * @return ?array{from: string, to: string, sunday: string}
 */
function liveWeekRangeUtc(string $ymd, string $tz): ?array
{
    if (!liveIsTimezone($tz)) return null;
    $start = liveDayRangeUtc($ymd, $tz);
    if ($start === null) return null;
    $weekday = (int) (new DateTimeImmutable(trim($ymd), new DateTimeZone($tz)))->format('w'); // 0 = Sunday … 6 = Saturday
    $sunday  = liveShiftDateLocal($ymd, (7 - $weekday) % 7, $tz);
    $end     = $sunday !== null ? liveDayRangeUtc($sunday, $tz) : null;
    if ($end === null) return null;
    return ['from' => $start['from'], 'to' => $end['to'], 'sunday' => $sunday];
}

/**
 * A short label for a zone as people say it: "IST" for Asia/Kolkata, else the
 * zone's abbreviation when it is letters ("GMT", "BST", "EDT"), else the city
 * part of the IANA name ("Dubai").
 */
function liveZoneLabel(string $tz, ?string $utc = null): string
{
    if ($tz === 'Asia/Kolkata') return 'IST';
    if (!liveIsTimezone($tz)) return $tz;
    try {
        $at = new DateTimeImmutable($utc !== null && trim($utc) !== '' ? trim($utc) : 'now', new DateTimeZone('UTC'));
        $abbr = $at->setTimezone(new DateTimeZone($tz))->format('T');
        if (preg_match('/^[A-Z]{2,5}$/', $abbr)) return $abbr;
    } catch (Throwable) {
        // fall through to the city name
    }
    $city = substr($tz, (int) strrpos($tz, '/') + 1);
    return str_replace('_', ' ', $city);
}
