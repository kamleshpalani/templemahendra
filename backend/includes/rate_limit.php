<?php
/**
 * backend/includes/rate_limit.php — who is asking, and how often.
 *
 * Every endpoint anyone can reach counts requests here: the public forms and the
 * family registration form (through public_guard.php), the chat, and the
 * notification cron and webhook endpoints. Counters live in the rate_limits table
 * from migration 003, and every limiter fails open without it: a missing table
 * or a broken query never stops a devotee.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

/**
 * The caller's address, for rate limiting.
 *
 * REMOTE_ADDR is the only value a client cannot choose, so it is the default.
 * X-Forwarded-For and CF-Connecting-IP are request headers: anyone can send
 * them, and trusting them unconditionally meant every per-IP limit could be
 * stepped around by changing one header on each attempt — which is to say
 * there was no per-IP limit at all.
 *
 * Behind a real proxy the forwarded header is the only way to see the visitor,
 * so it is honoured when the connection itself arrives from an address listed
 * in TRUSTED_PROXIES (comma-separated, CIDR or plain addresses). On Hostinger
 * there is no such proxy and the variable stays unset, which is correct.
 */
function clientIp(): string
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');

    $trusted = array_filter(array_map('trim', explode(',', (string) (getenv('TRUSTED_PROXIES') ?: ''))));
    if ($remote !== '' && $trusted && ipInAnyRange($remote, $trusted)) {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR'] as $k) {
            if (empty($_SERVER[$k])) continue;
            // Left-most entry is the original client; the rest is the proxy chain.
            $candidate = trim(explode(',', (string) $_SERVER[$k])[0]);
            if (filter_var($candidate, FILTER_VALIDATE_IP)) return $candidate;
        }
    }

    return $remote !== '' ? $remote : 'unknown';
}

/** True when $ip falls inside any of the given addresses or CIDR ranges. */
function ipInAnyRange(string $ip, array $ranges): bool
{
    $packed = @inet_pton($ip);
    if ($packed === false) return false;

    foreach ($ranges as $range) {
        if (!str_contains($range, '/')) {
            if ($range === $ip) return true;
            continue;
        }
        [$subnet, $bitsRaw] = explode('/', $range, 2);
        $subnetPacked = @inet_pton($subnet);
        $bits = (int) $bitsRaw;
        if ($subnetPacked === false || strlen($subnetPacked) !== strlen($packed) || $bits < 0) continue;
        if ($bits > strlen($packed) * 8) continue;

        $whole = intdiv($bits, 8);
        $rest  = $bits % 8;
        if ($whole > 0 && strncmp($packed, $subnetPacked, $whole) !== 0) continue;
        if ($rest === 0) return true;

        $mask = chr(0xFF << (8 - $rest) & 0xFF);
        if ((($packed[$whole] ?? "\0") & $mask) === (($subnetPacked[$whole] ?? "\0") & $mask)) return true;
    }
    return false;
}

/** True when the rate_limits table is there to count in. */
function rateLimitTableExists(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        getDB()->query('SELECT 1 FROM rate_limits LIMIT 0')->closeCursor();
        return $exists = true;
    } catch (Throwable) {
        return $exists = false;
    }
}

/**
 * Returns true when the caller may proceed. Counts per action+IP in a fixed
 * window; the window resets rather than sliding, which is plenty here and
 * costs one statement.
 */
function rateLimitAllow(string $action, int $max, int $windowSeconds, ?string $who = null): bool
{
    if (!rateLimitTableExists()) return true;
    $bucket = mb_substr($action . ':' . ($who ?? clientIp()), 0, 190);
    $w      = max(1, $windowSeconds);
    try {
        $db = getDB();
        $db->prepare(
            "INSERT INTO rate_limits (bucket, hits, window_start) VALUES (:b, 1, NOW())
             ON DUPLICATE KEY UPDATE
               hits         = IF(window_start < (NOW() - INTERVAL $w SECOND), 1, hits + 1),
               window_start = IF(window_start < (NOW() - INTERVAL $w SECOND), NOW(), window_start)"
        )->execute([':b' => $bucket]);
        $stmt = $db->prepare('SELECT hits FROM rate_limits WHERE bucket = :b');
        $stmt->execute([':b' => $bucket]);
        $hits = (int) $stmt->fetchColumn();
        // opportunistic cleanup, roughly one request in fifty
        if (random_int(1, 50) === 1) {
            $db->exec('DELETE FROM rate_limits WHERE window_start < (NOW() - INTERVAL 1 DAY)');
        }
        return $hits <= $max;
    } catch (Throwable $e) {
        error_log('[rate-limit] ' . $e->getMessage());
        return true; // never lock people out because the limiter broke
    }
}

/**
 * Read a bucket without spending from it, for limits that should count only
 * failures: the cron endpoint checks first and spends only when a key is wrong,
 * so the real scheduler calling it every minute never locks itself out.
 */
function rateLimitPeek(string $action, int $max, int $windowSeconds, ?string $who = null): bool
{
    if (!rateLimitTableExists()) return true;
    $bucket = mb_substr($action . ':' . ($who ?? clientIp()), 0, 190);
    try {
        $stmt = getDB()->prepare(
            'SELECT hits FROM rate_limits WHERE bucket = :b AND window_start >= (NOW() - INTERVAL ' . max(1, $windowSeconds) . ' SECOND)'
        );
        $stmt->execute([':b' => $bucket]);
        $hits = $stmt->fetchColumn();
        return $hits === false || (int) $hits < $max;
    } catch (Throwable $e) {
        error_log('[rate-limit peek] ' . $e->getMessage());
        return true;
    }
}
