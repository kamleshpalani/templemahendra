<?php
/**
 * backend/includes/payments/audit.php — the payment history (SPEC §3.6, §5.4).
 *
 * payment_audit_log is append-only: the application inserts and never updates
 * or deletes. Every row says what happened in a sentence a committee member can
 * read, plus small structured facts. Neither ever carries a credential, a token
 * or card data: `data` goes through payRedact(), and callers pass only facts.
 */

/** The audit vocabulary. An event outside it is still written, with a log line. */
const PAY_AUDIT_EVENTS = [
    'payable_created', 'attempt_created', 'redirect_issued', 'response_received', 'response_duplicate',
    'response_undecryptable', 'response_unknown_order', 'response_wrong_environment', 'response_mismatch',
    'tracking_conflict', 'response_error', 'verification_ok', 'verification_disagrees', 'verification_unavailable',
    'status_changed', 'double_payment', 'receipt_assigned', 'notification_queued', 'notification_skipped',
    'receipt_emailed', 'retry_requested', 'hold_expired', 'refund_requested', 'refund_accepted', 'refund_refused',
    'refund_succeeded', 'refund_failed', 'refund_manual_recorded', 'reconcile_checked', 'reconcile_csv_mismatch',
    'admin_marked_reviewed', 'settings_changed', 'booking_restored',
];

/**
 * A copy of $value safe to store: keys that look like credentials or card data
 * (key, secret, password, token, access_code, card_number, cvv, expiry) are
 * dropped at every level, strings are cut to 255 characters, objects and
 * resources become null.
 */
function payRedact(mixed $value, int $depth = 0): mixed
{
    if (is_array($value)) {
        if ($depth > 6) return null;
        $out = [];
        foreach ($value as $k => $v) {
            if (is_string($k) && preg_match('/key|secret|password|token|access_code|card_number|cvv|expiry/i', $k)) continue;
            $out[$k] = payRedact($v, $depth + 1);
        }
        return $out;
    }
    if (is_string($value)) return mb_substr(mb_scrub($value, 'UTF-8'), 0, 255);
    if (is_int($value) || is_float($value) || is_bool($value) || $value === null) return $value;
    return null;
}

/**
 * Write one audit row. $ctx: transaction_id, payable_type, payable_id, detail
 * (a sentence), data (array), actor (system|gateway|donor|cron|admin username),
 * ip (defaults to the client address on a web request). Never throws: a failed
 * audit line is logged and the payment carries on.
 *
 * Inside a transaction the row belongs to that transaction, so a rolled-back
 * change leaves no history claiming it happened.
 */
function payAudit(PDO $db, string $event, array $ctx): void
{
    try {
        if (!in_array($event, PAY_AUDIT_EVENTS, true)) {
            error_log("[payments] audit event \"{$event}\" is not in the vocabulary");
        }
        $type = in_array($ctx['payable_type'] ?? null, ['donation', 'seva_booking'], true) ? $ctx['payable_type'] : null;
        $ip = array_key_exists('ip', $ctx) ? $ctx['ip'] : (PHP_SAPI === 'cli' ? null : clientIp());
        $data = isset($ctx['data']) && is_array($ctx['data'])
            ? json_encode(payRedact($ctx['data']), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)
            : null;
        $db->prepare(
            'INSERT INTO payment_audit_log (transaction_id, payable_type, payable_id, event, detail, data, actor, ip, created_at)
             VALUES (:t, :pt, :pid, :e, :d, :data, :a, :ip, UTC_TIMESTAMP(3))'
        )->execute([
            ':t'    => isset($ctx['transaction_id']) && (int) $ctx['transaction_id'] > 0 ? (int) $ctx['transaction_id'] : null,
            ':pt'   => $type,
            ':pid'  => $type !== null && (int) ($ctx['payable_id'] ?? 0) > 0 ? (int) $ctx['payable_id'] : null,
            ':e'    => mb_substr($event, 0, 48),
            ':d'    => isset($ctx['detail']) ? mb_substr(mb_scrub((string) $ctx['detail'], 'UTF-8'), 0, 1000) : null,
            ':data' => $data === false ? null : $data,
            ':a'    => mb_substr(trim((string) ($ctx['actor'] ?? 'system')) ?: 'system', 0, 60),
            ':ip'   => is_string($ip) && $ip !== '' ? mb_substr($ip, 0, 45) : null,
        ]);
    } catch (Throwable $e) {
        error_log('[payments] audit "' . $event . '" could not be written: ' . $e->getMessage());
    }
}

/** Audit context for an attempt row: its id and payable. */
function payAuditCtx(array $attempt, array $extra = []): array
{
    return [
        'transaction_id' => (int) ($attempt['id'] ?? 0),
        'payable_type'   => $attempt['payable_type'] ?? null,
        'payable_id'     => (int) ($attempt['payable_id'] ?? 0),
    ] + $extra;
}
