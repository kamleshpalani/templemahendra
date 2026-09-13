<?php
/**
 * backend/includes/public_guard.php — protection for the forms anyone can post.
 *
 * The seva booking, donation and contact forms and the chat need no account, so
 * nothing but these checks stands between them and a script that posts in a
 * loop. Each saved row lands in the committee's admin and can trigger an SMS or
 * WhatsApp message that costs the temple money, and each chat message can cost
 * an AI call.
 *
 *   • Honeypot. The forms carry a hidden field people never see. A bot that fills
 *     every input gives itself away, and is told it succeeded so it has no reason
 *     to adapt.
 *   • Flood limits. Two buckets per form and client address: attempts (every
 *     POST, before validation, so hammering with junk is limited too) and saved
 *     (only posts that passed validation, just before the insert, so a devotee
 *     who mistypes a phone number a few times is not locked out of booking).
 *
 * Both use the rate_limits table from migration 003 through rateLimitAllow(),
 * and like it they fail open: a missing table never stops a devotee.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/devotee_auth.php';

/**
 * Limits per client address: [max, window seconds]. Kept together so the
 * numbers can be read, compared and changed in one place.
 */
const PUBLIC_GUARD_LIMITS = [
    'seva-booking-attempt' => [20, 3600],
    'seva-booking-saved'   => [8, 3600],
    'donation-attempt'     => [20, 3600],
    'donation-saved'       => [8, 3600],
    'contact-attempt'      => [15, 3600],
    'contact-saved'        => [5, 3600],
    'chat-window'          => [30, 600],
    'chat-day'             => [150, 86400],
];

/**
 * Spend one hit from a named bucket for this client, and answer 429 when the
 * bucket is over its limit. Returns normally when the request may continue.
 */
function publicGuardLimit(string $action): void
{
    if (!isset(PUBLIC_GUARD_LIMITS[$action])) {
        throw new InvalidArgumentException("Unknown public limit: $action");
    }
    [$max, $window] = PUBLIC_GUARD_LIMITS[$action];
    if (rateLimitAllow($action, $max, $window)) return;

    publicGuardTooMany(publicGuardRetryAfter($action, $window));
}

/**
 * Seconds until the bucket's fixed window resets. At least 1, so a client that
 * honours Retry-After never retries in a tight loop at the window's edge.
 */
function publicGuardRetryAfter(string $action, int $windowSeconds, ?string $who = null): int
{
    $w = max(1, $windowSeconds);
    try {
        $stmt = getDB()->prepare(
            "SELECT TIMESTAMPDIFF(SECOND, NOW(), window_start + INTERVAL $w SECOND) FROM rate_limits WHERE bucket = :b"
        );
        $stmt->execute([':b' => mb_substr($action . ':' . ($who ?? clientIp()), 0, 190)]);
        $left = $stmt->fetchColumn();
        return $left === false ? $w : max(1, min($w, (int) $left));
    } catch (Throwable $e) {
        error_log('[public-guard] ' . $e->getMessage());
        return $w;
    }
}

/** The one shape every flood-limited endpoint answers with. */
function publicGuardTooMany(int $retryAfter): never
{
    $retryAfter = max(1, $retryAfter);
    header('Retry-After: ' . $retryAfter);
    sendJson([
        'error'      => 'Too many requests. Please try again later.',
        'code'       => 'rate_limited',
        'retryAfter' => $retryAfter,
    ], 429);
}

/**
 * True when the hidden honeypot field came back filled in. A person never sees
 * the field, so any value at all (after trimming) is a form-filling script.
 */
function publicGuardIsHoneypot(array $body): bool
{
    if (!array_key_exists('hp_token', $body)) return false;
    $v = $body['hp_token'];
    if (is_array($v)) return $v !== [];
    if ($v === null || is_bool($v)) return $v === true;
    return trim((string) $v) !== '';
}

/**
 * Answer a honeypot hit exactly as a real submission would look to a naive bot:
 * 201 and success, with no id because nothing was saved.
 */
function publicGuardHoneypotOrContinue(array $body): void
{
    if (publicGuardIsHoneypot($body)) {
        sendJson(['success' => true], 201);
    }
}

/**
 * True when a JSON value means "yes, I agree". Only an explicit yes counts:
 * consent that arrives as anything ambiguous is not consent.
 */
function publicGuardConsent(mixed $value): bool
{
    return $value === true || $value === 1 || $value === '1' || $value === 'true';
}

/**
 * True when $table has $column. Used so that code written for a migration keeps
 * working on a database where that migration has not been applied yet.
 */
function publicGuardHasColumn(string $table, string $column): bool
{
    static $cache = [];
    $key = $table . '.' . $column;
    if (isset($cache[$key])) return $cache[$key];
    try {
        $stmt = getDB()->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c'
        );
        $stmt->execute([':t' => $table, ':c' => $column]);
        return $cache[$key] = (int) $stmt->fetchColumn() > 0;
    } catch (Throwable $e) {
        error_log('[public-guard] column check failed: ' . $e->getMessage());
        return $cache[$key] = false;
    }
}
