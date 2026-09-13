<?php
/**
 * backend/includes/notify/time.php — clocks, secrets, languages and the small
 * key-value store the Notification Service keeps for itself.
 *
 * TIME. Every notification DATETIME is UTC. The service never relies on the
 * MySQL session time zone or on PHP's default zone: it writes notifyNow() (or
 * UTC_TIMESTAMP()) and converts wall-clock times explicitly with notifyToUtc()
 * and notifyFromUtc(). A committee member in Pudupatti types "6:00 pm" and a
 * devotee in Leicester sees "1:30 pm" — both are the same instant, stored once.
 *
 * TEST CLOCK. The worker accepts --now so a test can jump an hour or a day
 * ahead instead of sleeping. That is only honoured when NOTIFY_ALLOW_TEST_DRIVER
 * is 1 (see notifyWorkerRun), and it is stored as an offset rather than a frozen
 * instant so time still moves forward during a run.
 */

require_once __DIR__ . '/contracts.php';
require_once __DIR__ . '/../db.php';

/**
 * True once migration 007 has been applied. Cached for the request: every
 * public entry point asks, and the answer cannot change mid-request.
 *
 * Probes the first and last tables the migration creates plus the column it
 * adds, so a migration that stopped half-way reads as "not installed" instead
 * of failing one query at a time inside a devotee's booking.
 */
function notifyTablesExist(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        $db = getDB();
        $db->query('SELECT 1 FROM notification_categories LIMIT 0')->closeCursor();
        $db->query('SELECT 1 FROM notification_kv LIMIT 0')->closeCursor();
        $db->query('SELECT phone_verified_at FROM devotees LIMIT 0')->closeCursor();
        return $exists = true;
    } catch (Throwable $e) {
        error_log('[notify] notification tables unavailable: ' . $e->getMessage());
        return $exists = false;
    }
}

/* ── Clock ──────────────────────────────────────────────────────────────── */

/**
 * The test clock's offset from real time, in seconds. Pass $utc to set it (the
 * worker does, for the length of one run) or $clear to go back to real time.
 */
function notifyClockOffset(?string $utc = null, bool $clear = false): int
{
    static $offset = 0;
    if ($clear) {
        $offset = 0;
    } elseif ($utc !== null) {
        $t = strtotime($utc . ' UTC');
        if ($t === false) throw new InvalidArgumentException('The test clock needs a "Y-m-d H:i:s" UTC time.');
        $offset = $t - time();
    }
    return $offset;
}

/** Now, in UTC, as MySQL stores it: 'Y-m-d H:i:s'. */
function notifyNow(): string
{
    return gmdate('Y-m-d H:i:s', time() + notifyClockOffset());
}

/** Now plus (or minus) some seconds, in the same form. */
function notifyNowPlus(int $seconds): string
{
    return gmdate('Y-m-d H:i:s', time() + notifyClockOffset() + $seconds);
}

/** A stored UTC time as ISO-8601 with a Z, the only form the APIs return. */
function notifyIso(?string $utc): ?string
{
    if ($utc === null) return null;
    $s = trim($utc);
    if ($s === '' || str_starts_with($s, '0000-00-00')) return null;
    try {
        return (new DateTimeImmutable($s, new DateTimeZone('UTC')))
            ->setTimezone(new DateTimeZone('UTC'))
            ->format('Y-m-d\TH:i:s\Z');
    } catch (Throwable) {
        return null;
    }
}

/** True for an IANA zone name PHP knows ("Asia/Kolkata"), false for anything else. */
function notifyIsTimezone(mixed $tz): bool
{
    static $known = null;
    if (!is_string($tz) || $tz === '' || strlen($tz) > 64) return false;
    $known ??= array_flip(timezone_identifiers_list());
    return isset($known[$tz]);
}

/** The temple's own zone. Reminders, the admin and temple-time schedules use it. */
function notifyTempleTz(): string
{
    $tz = trim(notifyEnv('NOTIFY_TEMPLE_TZ', 'Asia/Kolkata'));
    return notifyIsTimezone($tz) ? $tz : 'Asia/Kolkata';
}

/**
 * A wall-clock time in a zone → the UTC instant.
 *
 * Accepts 'Y-m-d H:i:s', 'Y-m-d H:i' (what an admin types) and the 'T' form a
 * datetime-local input submits. An unknown zone means the temple's.
 *
 * Daylight saving: a time that does not exist (01:30 on the morning London
 * springs forward) moves forward by the gap, and a time that happens twice
 * (01:30 when it falls back) is the first of the two — PHP's rules, and the
 * least surprising ones for a notification.
 *
 * @throws InvalidArgumentException when the text is not a real date and time
 */
function notifyToUtc(string $localWallClock, string $tz): string
{
    $zone = new DateTimeZone(notifyIsTimezone($tz) ? $tz : notifyTempleTz());
    $s    = trim(str_replace('T', ' ', $localWallClock));
    foreach (['Y-m-d H:i:s', 'Y-m-d H:i', 'Y-m-d'] as $format) {
        $parts = date_parse_from_format($format, $s);
        if ($parts['error_count'] > 0 || $parts['warning_count'] > 0) continue;
        $d = DateTimeImmutable::createFromFormat('!' . $format, $s, $zone);
        if ($d === false) continue;
        return $d->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    }
    throw new InvalidArgumentException('That is not a date and time: ' . mb_substr($localWallClock, 0, 40));
}

/** A UTC instant → the wall clock in a zone. An unknown zone means the temple's. */
function notifyFromUtc(string $utc, string $tz, string $format = 'Y-m-d H:i:s'): string
{
    $zone = new DateTimeZone(notifyIsTimezone($tz) ? $tz : notifyTempleTz());
    return (new DateTimeImmutable(trim($utc), new DateTimeZone('UTC')))->setTimezone($zone)->format($format);
}

/**
 * Where most devotees in a country keep their clocks. Countries spanning several
 * zones get the one most of the temple's devotees there would live in (the US
 * east coast, Sydney); a devotee elsewhere sets their own zone in preferences.
 */
function notifyCountryTimezones(): array
{
    return [
        'IN' => 'Asia/Kolkata',     'LK' => 'Asia/Colombo',       'SG' => 'Asia/Singapore',
        'MY' => 'Asia/Kuala_Lumpur', 'AE' => 'Asia/Dubai',        'SA' => 'Asia/Riyadh',
        'QA' => 'Asia/Qatar',       'KW' => 'Asia/Kuwait',        'OM' => 'Asia/Muscat',
        'BH' => 'Asia/Bahrain',     'GB' => 'Europe/London',      'IE' => 'Europe/Dublin',
        'DE' => 'Europe/Berlin',    'FR' => 'Europe/Paris',       'NL' => 'Europe/Amsterdam',
        'CH' => 'Europe/Zurich',    'US' => 'America/New_York',   'CA' => 'America/Toronto',
        'AU' => 'Australia/Sydney', 'NZ' => 'Pacific/Auckland',   'ZA' => 'Africa/Johannesburg',
        'MU' => 'Indian/Mauritius', 'FJ' => 'Pacific/Fiji',       'JP' => 'Asia/Tokyo',
        'HK' => 'Asia/Hong_Kong',   'NP' => 'Asia/Kathmandu',     'BD' => 'Asia/Dhaka',
        'PK' => 'Asia/Karachi',     'MV' => 'Indian/Maldives',    'MM' => 'Asia/Yangon',
        'TH' => 'Asia/Bangkok',     'ID' => 'Asia/Jakarta',       'PH' => 'Asia/Manila',
        'CN' => 'Asia/Shanghai',    'KR' => 'Asia/Seoul',         'RE' => 'Indian/Reunion',
        'SC' => 'Indian/Mahe',      'KE' => 'Africa/Nairobi',     'TZ' => 'Africa/Dar_es_Salaam',
        'IT' => 'Europe/Rome',      'ES' => 'Europe/Madrid',      'BE' => 'Europe/Brussels',
        'SE' => 'Europe/Stockholm', 'NO' => 'Europe/Oslo',        'DK' => 'Europe/Copenhagen',
        'GY' => 'America/Guyana',   'TT' => 'America/Port_of_Spain',
    ];
}

/** The zone to schedule for a devotee: their chosen one, else their country's, else the temple's. */
function notifyTimezoneFor(?array $prefs, ?string $countryIso2): string
{
    $chosen = $prefs['timezone'] ?? null;
    if (notifyIsTimezone($chosen)) return $chosen;
    $iso = strtoupper(trim((string) $countryIso2));
    $map = notifyCountryTimezones();
    return isset($map[$iso]) && notifyIsTimezone($map[$iso]) ? $map[$iso] : notifyTempleTz();
}

/* ── Internal settings ──────────────────────────────────────────────────── */

function notifyKvGet(string $key): ?string
{
    if (!notifyTablesExist()) return null;
    $stmt = getDB()->prepare('SELECT v FROM notification_kv WHERE k = :k');
    $stmt->execute([':k' => $key]);
    $v = $stmt->fetchColumn();
    return $v === false ? null : (string) $v;
}

function notifyKvSet(string $key, string $value): void
{
    getDB()->prepare(
        'INSERT INTO notification_kv (k, v, updated_at) VALUES (:k, :v, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)'
    )->execute([':k' => $key, ':v' => $value]);
}

/**
 * Store a value only if the key has none yet, and return whichever value won.
 * Two requests generating a secret at the same moment must end up agreeing on
 * one, or tokens signed by the loser would never verify.
 */
function notifyKvAdd(string $key, string $value): string
{
    $db = getDB();
    $db->prepare('INSERT IGNORE INTO notification_kv (k, v, updated_at) VALUES (:k, :v, UTC_TIMESTAMP())')
       ->execute([':k' => $key, ':v' => $value]);
    return notifyKvGet($key) ?? $value;
}

/**
 * The key that signs tracking and unsubscribe tokens and hashes one-time codes.
 *
 * NOTIFY_SECRET when it is long enough to be one. Otherwise a random secret is
 * generated once into notification_kv, so a fresh install works without anyone
 * inventing a password — but a production site should set the variable, because
 * a database dump then no longer carries the key that forges its links.
 *
 * @throws RuntimeException when there is neither a variable nor a table to keep one in
 */
function notifySecret(): string
{
    static $secret = null;
    if ($secret !== null) return $secret;

    $env = notifyEnv('NOTIFY_SECRET');
    if (strlen($env) >= 32) return $secret = $env;
    if ($env !== '') {
        error_log('[notify] NOTIFY_SECRET is shorter than 32 characters and was ignored; using the generated secret.');
    }
    if (!notifyTablesExist()) {
        throw new RuntimeException('NOTIFY_SECRET is not set and the notification tables are missing.');
    }
    return $secret = notifyKvAdd('secret', notifyB64u(random_bytes(32)));
}

/* ── Languages ──────────────────────────────────────────────────────────── */

/**
 * code => the language's name in itself, from NOTIFY_LANGUAGES.
 *
 * Tamil and English are always offered, whatever the variable says: every
 * built-in template ships in both and every fallback ends in them, so removing
 * either would leave messages with nothing to fall back to.
 */
function notifyLanguages(): array
{
    $native = [
        'ta' => 'தமிழ்',   'en' => 'English',  'hi' => 'हिन्दी',   'te' => 'తెలుగు',
        'ml' => 'മലയാളം', 'kn' => 'ಕನ್ನಡ',    'mr' => 'मराठी',   'gu' => 'ગુજરાતી',
        'bn' => 'বাংলা',   'pa' => 'ਪੰਜਾਬੀ',   'or' => 'ଓଡ଼ିଆ',    'si' => 'සිංහල',
        'ur' => 'اردو',    'ms' => 'Bahasa Melayu', 'fr' => 'Français', 'de' => 'Deutsch',
    ];
    $out = [];
    foreach (explode(',', notifyEnv('NOTIFY_LANGUAGES', 'ta,en,hi,te,ml,kn')) as $code) {
        $c = strtolower(trim($code));
        if (!preg_match('/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/', $c)) continue;
        $out[$c] = $native[$c] ?? strtoupper($c);
    }
    if (!isset($out['en'])) $out = ['en' => 'English'] + $out;
    if (!isset($out['ta'])) $out = ['ta' => 'தமிழ்'] + $out;
    return $out;
}

/** A language code the site offers, or Tamil. */
function notifyLangOrDefault(mixed $lang): string
{
    $l = is_string($lang) ? strtolower(trim($lang)) : '';
    return isset(notifyLanguages()[$l]) ? $l : 'ta';
}

/**
 * Pick one language's text from a per-language map, with the template
 * fallback order: the language asked for, then Tamil, then English, then
 * whatever exists. A plain string is returned as it is.
 */
function notifyPickLang(mixed $value, string $lang): ?string
{
    if ($value === null) return null;
    if (!is_array($value)) return is_scalar($value) ? (string) $value : null;
    foreach (array_unique([$lang, 'ta', 'en']) as $l) {
        if (isset($value[$l]) && is_scalar($value[$l]) && trim((string) $value[$l]) !== '') return (string) $value[$l];
    }
    foreach ($value as $v) {
        if (is_scalar($v) && trim((string) $v) !== '') return (string) $v;
    }
    return null;
}
