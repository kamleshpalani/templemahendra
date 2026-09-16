<?php
/**
 * backend/includes/payments/numbers.php — public ids, receipt numbers, signed
 * links and the IST calendar (SPEC §1, §0.14).
 *
 *   number          DON-YYYYMMDD-NNNNNNNN / SEV-YYYYMMDD-NNNNNNNN (IST date, row id)
 *   order_id        the number for attempt 1, number-R2 … number-R5 after that
 *   receipt number  TMR-2026-000042, gap-free per IST year (payment_counters)
 *   access token    22 chars of base64url(HMAC(secret, "pay:" . number))
 *   verify token    10 chars of base64url(HMAC(secret, "verify:" . receipt))
 *
 * Database times are UTC. Dates people read ("today", the date in a number, the
 * receipt year) are Asia/Kolkata.
 */

const PAY_NUMBER_PATTERN  = '/^(DON|SEV)-(\d{8})-(\d{8})(?:-R([2-5]))?$/D';
const PAY_RECEIPT_PATTERN = '/^[A-Z]{2,8}-\d{4}-\d{6}$/D';
const PAY_MAX_ATTEMPTS    = 5;

/** Asia/Kolkata. */
function payIstZone(): DateTimeZone
{
    static $zone = null;
    return $zone ??= new DateTimeZone('Asia/Kolkata');
}

/** UTC now as "Y-m-d H:i:s", the form every new DATETIME column holds. */
function payUtcNow(): string
{
    return gmdate('Y-m-d H:i:s');
}

/**
 * A UTC database time (or now) formatted in IST. Default format "Ymd", the date
 * part of a number. An unreadable input is treated as now.
 */
function payIstDate(?string $utcDateTime = null, string $format = 'Ymd'): string
{
    $utc = new DateTimeZone('UTC');
    try {
        $dt = new DateTimeImmutable($utcDateTime ?? 'now', $utc);
    } catch (Throwable) {
        $dt = new DateTimeImmutable('now', $utc);
    }
    return $dt->setTimezone(payIstZone())->format($format);
}

/** "2026-09-14T03:30:00Z" from a UTC database time, or null. */
function payIsoUtc(?string $utcDateTime): ?string
{
    if ($utcDateTime === null || $utcDateTime === '') return null;
    try {
        return (new DateTimeImmutable($utcDateTime, new DateTimeZone('UTC')))->format('Y-m-d\TH:i:s\Z');
    } catch (Throwable) {
        return null;
    }
}

/**
 * IST calendar dates as a half-open UTC range for SQL:
 * `col >= from AND col < to`. $toYmd defaults to $fromYmd; reversed dates are
 * swapped. Throws InvalidArgumentException for anything but YYYY-MM-DD.
 *
 * @return array{from:string, to:string, fromYmd:string, toYmd:string}
 */
function payIstRangeUtc(string $fromYmd, ?string $toYmd = null): array
{
    $toYmd ??= $fromYmd;
    if (!isValidDate($fromYmd) || !isValidDate($toYmd)) {
        throw new InvalidArgumentException('Dates must be real calendar dates in YYYY-MM-DD form.');
    }
    if ($toYmd < $fromYmd) [$fromYmd, $toYmd] = [$toYmd, $fromYmd];
    $utc  = new DateTimeZone('UTC');
    $from = new DateTimeImmutable($fromYmd . ' 00:00:00', payIstZone());
    $to   = (new DateTimeImmutable($toYmd . ' 00:00:00', payIstZone()))->modify('+1 day');
    return [
        'from'    => $from->setTimezone($utc)->format('Y-m-d H:i:s'),
        'to'      => $to->setTimezone($utc)->format('Y-m-d H:i:s'),
        'fromYmd' => $fromYmd,
        'toYmd'   => $toYmd,
    ];
}

/**
 * "today", "month", "year" or "last30" (the 30 IST days ending today) as a
 * half-open UTC range. $nowUtc moves the clock for tests.
 *
 * @return array{from:string, to:string, fromYmd:string, toYmd:string}
 */
function payIstPeriodUtc(string $period, ?string $nowUtc = null): array
{
    $now = (new DateTimeImmutable($nowUtc ?? 'now', new DateTimeZone('UTC')))->setTimezone(payIstZone());
    return match ($period) {
        'today'  => payIstRangeUtc($now->format('Y-m-d')),
        'month'  => payIstRangeUtc($now->format('Y-m-01'), $now->format('Y-m-t')),
        'year'   => payIstRangeUtc($now->format('Y-01-01'), $now->format('Y-12-31')),
        'last30' => payIstRangeUtc($now->modify('-29 days')->format('Y-m-d'), $now->format('Y-m-d')),
        default  => throw new InvalidArgumentException("Unknown period: {$period}"),
    };
}

/** The public number of a payable: payNumberFor('donation', 1234, '20260914') → "DON-20260914-00001234". */
function payNumberFor(string $type, int $id, string $istYmd): string
{
    $prefix = match ($type) {
        'donation'     => 'DON',
        'seva_booking' => 'SEV',
        default        => throw new InvalidArgumentException("Unknown payable type: {$type}"),
    };
    if (!preg_match('/^\d{8}$/D', $istYmd)) throw new InvalidArgumentException('The number date must be YYYYMMDD.');
    if ($id < 1 || $id > 99999999) throw new InvalidArgumentException('The payable id does not fit an 8-digit number.');
    return sprintf('%s-%s-%08d', $prefix, $istYmd, $id);
}

/** The order_id for attempt n: the number itself for 1, "number-Rn" for 2 to 5. */
function payOrderIdFor(string $number, int $attempt): string
{
    if ($attempt < 1 || $attempt > PAY_MAX_ATTEMPTS) {
        throw new InvalidArgumentException('An attempt number must be between 1 and ' . PAY_MAX_ATTEMPTS . '.');
    }
    return $attempt === 1 ? $number : $number . '-R' . $attempt;
}

/**
 * A number or order id taken apart, or null when it does not have exactly the
 * shape we issue. Checked before any query that uses it (SPEC §4.6).
 *
 * @return array{type:string, number:string, order_id:string, attempt:int, date:string, id:int}|null
 */
function payParseNumber(mixed $value): ?array
{
    if (!is_string($value) || strlen($value) > 30 || !preg_match(PAY_NUMBER_PATTERN, $value, $m)) return null;
    $id = (int) $m[3];
    if ($id < 1) return null;
    $number = $m[1] . '-' . $m[2] . '-' . $m[3];
    return [
        'type'     => $m[1] === 'DON' ? 'donation' : 'seva_booking',
        'number'   => $number,
        'order_id' => $value,
        'attempt'  => isset($m[4]) && $m[4] !== '' ? (int) $m[4] : 1,
        'date'     => $m[2],
        'id'       => $id,
    ];
}

/** Receipt prefixes reserved for payments that moved no real money (§1): TEST and SIMULATOR attempts. */
const PAY_RECEIPT_PREFIX_TEST      = 'TEST';
const PAY_RECEIPT_PREFIX_SIMULATOR = 'SIM';

/**
 * The counter row a receipt sequence lives in: "receipt:2026" for production,
 * "receipt:test:2026" and "receipt:simulator:2026" for the other environments,
 * so a test payment never consumes a number of the real sequence.
 */
function payReceiptCounterName(string $environment, string $istYear): string
{
    return match ($environment) {
        'test'      => 'receipt:test:' . $istYear,
        'simulator' => 'receipt:simulator:' . $istYear,
        default     => 'receipt:' . $istYear,
    };
}

/** The prefix a receipt carries: the configured one in production, TEST / SIM otherwise, so the paper itself says no real money moved. */
function payReceiptPrefixFor(string $environment, string $configuredPrefix): string
{
    return match ($environment) {
        'test'      => PAY_RECEIPT_PREFIX_TEST,
        'simulator' => PAY_RECEIPT_PREFIX_SIMULATOR,
        default     => preg_match('/^[A-Z]{2,8}$/D', $configuredPrefix) ? $configuredPrefix : 'TMR',
    };
}

/**
 * The next receipt number, "TMR-2026-000042" (or "TEST-2026-000003" /
 * "SIM-2026-000003" for a TEST / SIMULATOR attempt, from their own counters).
 * Must run inside the transaction that makes the payable SUCCESS: the counter
 * row is locked with SELECT … FOR UPDATE, so two payments never share a number,
 * and a rollback gives the number back, so the sequence has no gaps.
 */
function payNextReceiptNumber(PDO $db, string $prefix, ?string $istYear = null, string $environment = 'production'): string
{
    if (!$db->inTransaction()) {
        throw new LogicException('payNextReceiptNumber() must run inside the transaction that records the payment.');
    }
    $year = $istYear ?? payIstDate(null, 'Y');
    $prefix = payReceiptPrefixFor($environment, $prefix);
    $name = payReceiptCounterName($environment, $year);
    // Not INSERT IGNORE: on an existing row that takes a shared lock, and two
    // SUCCESS transactions arriving together then both wait to upgrade it to the
    // exclusive lock the SELECT … FOR UPDATE needs — a deadlock, and one payment
    // rolls back. ON DUPLICATE KEY UPDATE takes the exclusive lock at once, so
    // the second transaction simply queues behind the first.
    $db->prepare('INSERT INTO payment_counters (name, value, updated_at) VALUES (:n, 0, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE value = value')
       ->execute([':n' => $name]);
    $stmt = $db->prepare('SELECT value FROM payment_counters WHERE name = :n FOR UPDATE');
    $stmt->execute([':n' => $name]);
    $next = (int) $stmt->fetchColumn() + 1;
    $db->prepare('UPDATE payment_counters SET value = :v, updated_at = UTC_TIMESTAMP() WHERE name = :n')
       ->execute([':v' => $next, ':n' => $name]);
    return sprintf('%s-%s-%06d', $prefix, $year, $next);
}

/**
 * The key that signs access and verify tokens. PAYMENTS_SECRET when it has at
 * least 32 characters. In TEST and SIMULATOR mode a missing secret falls back to
 * one derived from the notification secret, with a warning in the log once per
 * request; in PRODUCTION it throws (payReady() refuses to start first).
 */
function paySecret(): string
{
    static $secret = null;
    if ($secret !== null) return $secret;

    $env = envValue('PAYMENTS_SECRET');
    if (strlen($env) >= 32) return $secret = $env;

    $mode = payTablesExist() ? payConfig()['mode'] : 'test';
    if ($mode === 'production') {
        throw new RuntimeException('PAYMENTS_SECRET (at least 32 characters) is required in PRODUCTION mode.');
    }
    if (!devoteeNotifyReady()) {
        throw new RuntimeException('PAYMENTS_SECRET is not set and the notification secret is not available.');
    }
    error_log('[payments] PAYMENTS_SECRET is not set (or shorter than 32 characters); payment links are signed with a key derived from the notification secret. Set PAYMENTS_SECRET before going live.');
    return $secret = hash_hmac('sha256', 'temple-payments-links', notifySecret());
}

/** The token that lets a donor open their own result and receipt pages. */
function payAccessToken(string $number): string
{
    return substr(notifyB64u(hash_hmac('sha256', 'pay:' . $number, paySecret(), true)), 0, 22);
}

/** True when $token is the access token for $number (constant time). */
function payAccessTokenValid(string $number, mixed $token): bool
{
    if (!is_string($token) || strlen($token) !== 22 || payParseNumber($number) === null) return false;
    return hash_equals(payAccessToken($number), $token);
}

/** The short token printed in a receipt's QR verification link. */
function payVerifyToken(string $receiptNumber): string
{
    return substr(notifyB64u(hash_hmac('sha256', 'verify:' . $receiptNumber, paySecret(), true)), 0, 10);
}

/** True when $token is the verify token for $receiptNumber (constant time). */
function payVerifyTokenValid(string $receiptNumber, mixed $token): bool
{
    if (!is_string($token) || strlen($token) !== 10 || !preg_match(PAY_RECEIPT_PATTERN, $receiptNumber)) return false;
    return hash_equals(payVerifyToken($receiptNumber), $token);
}
