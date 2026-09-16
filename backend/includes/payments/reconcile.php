<?php
/**
 * backend/includes/payments/reconcile.php — checking our records against
 * CCAvenue (docs/payments/SPEC.md §9).
 *
 *   payReconcileSweep()   the scheduled check of open and unverified attempts
 *   payVerifyAttempt()    one attempt against the status API
 *   payExpireHolds()      unpaid online seva bookings past their hold
 *   payCronRun()          the sweep under a MySQL lock, for the CLI and HTTP cron
 *   payReconcileReport()  the admin's reconciliation sections
 *   payReconcileCsv()     compare an order report exported from CCAvenue
 *   payMarkReviewed()     clear needs_review with a note
 *
 * The status API is asked outside any transaction (no row is locked while a
 * remote server thinks); the answer is applied inside one, on a freshly locked
 * attempt, through payStateApply(). An unreachable API changes nothing but
 * last_checked_at.
 */

/** An INITIATED attempt older than this with no payment at CCAvenue is closed. */
const PAY_ABANDON_SECONDS = 10800;

/** Seconds since a UTC database time. */
function payAgeSeconds(?string $utc, ?int $nowTs = null): int
{
    if ($utc === null || $utc === '') return 0;
    $ts = strtotime($utc . ' UTC');
    return $ts === false ? 0 : ($nowTs ?? time()) - $ts;
}

/**
 * Check open and unverified attempts, oldest first (§9.1).
 *
 * $opts: limit (default 40), max_seconds (default 50), actor (default 'cron'),
 * order_ids (string[]: only these attempts, whatever their age — tests and the
 * admin; an empty list checks nothing), expire_holds (default true; scoped to
 * order_ids when given).
 *
 * @return array{checked:int, changed:int, cancelled:int, expired:int, errors:int, items:array}
 */
function payReconcileSweep(PDO $db, array $opts = []): array
{
    $summary = ['checked' => 0, 'changed' => 0, 'cancelled' => 0, 'expired' => 0, 'errors' => 0, 'items' => []];
    if (!payTablesExist()) {
        $summary['errors'] = 1;
        return $summary;
    }
    $limit = max(1, min(500, (int) ($opts['limit'] ?? 40)));
    $maxSeconds = max(1, (int) ($opts['max_seconds'] ?? 50));
    $actor = mb_substr((string) ($opts['actor'] ?? 'cron'), 0, 60) ?: 'cron';
    $scoped = array_key_exists('order_ids', $opts) && $opts['order_ids'] !== null;
    $orderIds = [];
    foreach ((array) ($opts['order_ids'] ?? []) as $o) {
        if (is_string($o) && payParseNumber(trim($o)) !== null) $orderIds[] = trim($o);
    }
    $orderIds = array_values(array_unique($orderIds));
    $started = microtime(true);

    if ($scoped) {
        if (!$orderIds) return $summary; // a scoped run never widens to everything
        $in = implode(',', array_fill(0, count($orderIds), '?'));
        $stmt = $db->prepare(
            "SELECT id FROM payment_transactions
              WHERE order_id IN ({$in}) AND NOT (status = 'SUCCESS' AND verification IN ('status_api','manual'))
              ORDER BY created_at ASC, id ASC LIMIT {$limit}"
        );
        $stmt->execute($orderIds);
    } else {
        $stmt = $db->query(
            "SELECT id FROM payment_transactions
              WHERE (last_checked_at IS NULL OR last_checked_at < UTC_TIMESTAMP() - INTERVAL 10 MINUTE)
                AND (   (status = 'INITIATED' AND created_at < UTC_TIMESTAMP() - INTERVAL 20 MINUTE)
                     OR (status = 'PENDING' AND COALESCE(responded_at, created_at) < UTC_TIMESTAMP() - INTERVAL 10 MINUTE)
                     OR (status = 'SUCCESS' AND verification IN ('none','callback') AND created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY))
              ORDER BY created_at ASC, id ASC LIMIT {$limit}"
        );
    }
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
        if (microtime(true) - $started > $maxSeconds) break;
        $attempt = payLoadAttempt($db, (int) $id);
        if ($attempt === null) continue;
        $r = payVerifyAttempt($db, $attempt, $actor);
        $summary['checked']++;
        if ($r['changed']) $summary['changed']++;
        if ($r['changed'] && $r['to'] === 'CANCELLED') $summary['cancelled']++;
        if ($r['outcome'] === 'error') $summary['errors']++;
        $summary['items'][] = ['order_id' => $attempt['order_id'], 'outcome' => $r['outcome'], 'from' => $r['from'], 'to' => $r['to']];
    }
    if (($opts['expire_holds'] ?? true) !== false) {
        $summary['expired'] = payExpireHolds($db, $scoped ? $orderIds : null);
    }
    return $summary;
}

/**
 * Ask CCAvenue about one attempt and apply the answer (§9.1).
 *
 * outcome: verified (SUCCESS confirmed) | paid (became SUCCESS) | changed |
 * abandoned (INITIATED closed after 3 hours) | disagrees | flagged (refund or
 * chargeback at CCAvenue) | no_record | unavailable | not_configured |
 * unchanged | missing | error. Notifications for a first success or a new
 * failure are sent after commit. Never throws.
 *
 * @return array{outcome:string, changed:bool, from:string, to:string, error:string}
 */
function payVerifyAttempt(PDO $db, array $attempt, string $actor = 'cron', array $opts = []): array
{
    $out = ['outcome' => 'unchanged', 'changed' => false, 'from' => (string) $attempt['status'], 'to' => (string) $attempt['status'], 'error' => ''];
    try {
        $cfg = payConfig();
        $environment = (string) $attempt['environment'];
        $age = payAgeSeconds((string) $attempt['created_at']);
        $api = null;
        if (ccavApiConfigured($environment)) {
            $api = ccavOrderStatus($attempt['tracking_id'], (string) $attempt['order_id'], payEnvConfig($cfg, $environment));
        }

        $applied = payTransaction($db, function (PDO $db) use ($attempt, $api, $age, $actor, &$out): ?array {
            $locked = payLoadAttemptForUpdate($db, (string) $attempt['order_id']);
            if ($locked === null) {
                $out['outcome'] = 'missing';
                return null;
            }
            $ctx = payAuditCtx($locked, ['actor' => $actor, 'ip' => null]);
            $orderId = (string) $locked['order_id'];
            $status = (string) $locked['status'];
            $facts = ['checked' => true];
            $flag = static function (string $sentence, array $data) use ($db, $ctx, &$facts, &$out): void {
                $facts['needs_review'] = true;
                $out['outcome'] = 'disagrees';
                payAudit($db, 'verification_disagrees', $ctx + ['detail' => $sentence, 'data' => $data]);
            };

            if ($api === null) {
                if ($status === 'INITIATED' && $age >= PAY_ABANDON_SECONDS) {
                    $out['outcome'] = 'abandoned';
                    return payStateApply($db, $locked, 'CANCELLED', $facts + ['detail' => "Closed: not verifiable, no response within 3 hours ({$orderId})."], $actor);
                }
                $out['outcome'] = 'not_configured';
                return payStateApply($db, $locked, $status, $facts, $actor);
            }

            if (!$api['ok']) {
                if (in_array($api['error_code'], CCAV_NO_RECORD_CODES, true)) {
                    payAudit($db, 'reconcile_checked', $ctx + [
                        'detail' => "CCAvenue has no record of {$orderId}.",
                        'data'   => ['order_id' => $orderId, 'api_status' => null, 'error_code' => $api['error_code'], 'our_status' => $status],
                    ]);
                    if ($status === 'INITIATED' && $age >= PAY_ABANDON_SECONDS) {
                        $out['outcome'] = 'abandoned';
                        return payStateApply($db, $locked, 'CANCELLED', $facts + [
                            'verification' => 'status_api',
                            'detail'       => "Closed: no payment reached CCAvenue within 3 hours ({$orderId}).",
                        ], $actor);
                    }
                    $out['outcome'] = 'no_record';
                    if ($status === 'SUCCESS') {
                        $flag("{$orderId} is paid here, but CCAvenue has no record of it.", ['order_id' => $orderId, 'error_code' => $api['error_code']]);
                    }
                    return payStateApply($db, $locked, $status, $facts, $actor);
                }
                $recent = $db->prepare("SELECT 1 FROM payment_audit_log WHERE transaction_id = :t AND event = 'verification_unavailable' AND created_at >= UTC_TIMESTAMP(3) - INTERVAL 1 HOUR LIMIT 1");
                $recent->execute([':t' => $locked['id']]);
                if ($recent->fetchColumn() === false) {
                    payAudit($db, 'verification_unavailable', $ctx + [
                        'detail' => "CCAvenue's status check could not be completed for {$orderId}; it will be tried again.",
                        'data'   => ['order_id' => $orderId, 'error' => $api['error'], 'error_code' => $api['error_code'], 'http' => $api['http']],
                    ]);
                }
                $out['outcome'] = 'unavailable';
                $out['error'] = $api['error'];
                return payStateApply($db, $locked, $status, $facts, $actor);
            }

            $apiStatus = (string) $api['status'];
            $mapped = ccavMapApiStatus($apiStatus);
            $amountOk = $api['amount'] !== null && payAmountCents($api['amount']) === payAmountCents($locked['amount']);
            $currencyOk = $api['currency'] === null || $api['currency'] === '' || $api['currency'] === strtoupper((string) $locked['currency']);
            payAudit($db, 'reconcile_checked', $ctx + [
                'detail' => "CCAvenue reports {$orderId} as {$apiStatus}.",
                'data'   => [
                    'order_id' => $orderId, 'api_status' => $apiStatus, 'api_amount' => $api['amount'], 'api_currency' => $api['currency'],
                    'amount_ok' => $amountOk, 'currency_ok' => $currencyOk, 'our_status' => $status,
                ],
            ]);
            if ($api['tracking_id'] && $locked['tracking_id'] === null) {
                $s = $db->prepare('SELECT 1 FROM payment_transactions WHERE tracking_id = :t AND id <> :id');
                $s->execute([':t' => $api['tracking_id'], ':id' => $locked['id']]);
                if ($s->fetchColumn() === false) $facts['tracking_id'] = $api['tracking_id'];
            }
            if ($api['bank_ref_no']) $facts['bank_ref_no'] = $api['bank_ref_no'];
            $data = ['order_id' => $orderId, 'api_status' => $apiStatus, 'api_amount' => $api['amount'], 'api_currency' => $api['currency'], 'our_status' => $status];

            if ($mapped === null) {
                $flag("CCAvenue reports {$orderId} as {$apiStatus}. Check it in reconciliation.", $data);
                $out['outcome'] = 'flagged';
                return payStateApply($db, $locked, $status, $facts, $actor);
            }
            if ($mapped === 'SUCCESS') {
                if (!$amountOk || !$currencyOk) {
                    $flag("CCAvenue reports {$orderId} as {$apiStatus} but with a different amount or currency. Not accepted as paid until reviewed.", $data);
                    return payStateApply($db, $locked, $status, $facts, $actor);
                }
                $facts += ['verification' => 'status_api', 'verified' => true, 'via' => 'confirmed by CCAvenue\'s status check'];
                $out['outcome'] = $status === 'SUCCESS' ? 'verified' : 'paid';
                payAudit($db, 'verification_ok', $ctx + ['detail' => "CCAvenue's status check confirms {$orderId} is paid.", 'data' => $data]);
                return payStateApply($db, $locked, 'SUCCESS', $facts, $actor);
            }
            if ($status === 'SUCCESS') {
                $flag("{$orderId} is paid here, but CCAvenue reports {$apiStatus}.", $data);
                return payStateApply($db, $locked, $status, $facts, $actor);
            }
            if ($mapped === 'PENDING') {
                if ($status === 'INITIATED' && strcasecmp($apiStatus, 'Initiated') === 0 && $age >= PAY_ABANDON_SECONDS) {
                    $out['outcome'] = 'abandoned';
                    return payStateApply($db, $locked, 'CANCELLED', $facts + [
                        'verification' => 'status_api',
                        'detail'       => "Closed: no payment reached CCAvenue within 3 hours ({$orderId}).",
                    ], $actor);
                }
                if ($status === 'INITIATED' && strcasecmp($apiStatus, 'Awaited') === 0) {
                    $out['outcome'] = 'changed';
                    return payStateApply($db, $locked, 'PENDING', $facts + ['verification' => 'status_api', 'via' => 'CCAvenue is awaiting the bank'], $actor);
                }
                return payStateApply($db, $locked, $status, $facts, $actor);
            }
            $out['outcome'] = 'changed';
            return payStateApply($db, $locked, $mapped, $facts + ['verification' => 'status_api', 'via' => 'reported by CCAvenue\'s status check'], $actor);
        });

        if ($applied !== null) {
            $out['changed'] = $applied['changed'];
            $out['from'] = $applied['from'];
            $out['to'] = $applied['to'];
            if (!$applied['changed'] && $out['outcome'] === 'changed') $out['outcome'] = 'unchanged';
            if ($applied['firstSuccess'] || ($applied['changed'] && $applied['to'] === 'FAILED')) {
                $payable = payLoadPayableById($db, (string) $attempt['payable_type'], (int) $attempt['payable_id']);
                if ($payable !== null && $applied['firstSuccess']) payNotifySuccess($db, $payable);
                if ($payable !== null && $applied['changed'] && $applied['to'] === 'FAILED') {
                    $now = payLoadAttempt($db, (int) $attempt['id']);
                    if ($now !== null) payNotifyFailed($db, $payable, $now);
                }
            }
        }
        return $out;
    } catch (Throwable $e) {
        error_log('[payments] verify ' . ($attempt['order_id'] ?? '?') . ' failed: ' . get_class($e) . ': ' . $e->getMessage());
        $out['outcome'] = 'error';
        $out['error'] = 'The check could not run.';
        return $out;
    }
}

/**
 * Cancel online seva bookings whose hold has expired while unpaid (booking
 * status 'pending', payment INITIATED/PENDING/FAILED/CANCELLED): status becomes
 * 'cancelled', audit hold_expired, no message. $orderIds limits it to those
 * bookings (null = all). Returns how many were cancelled.
 */
function payExpireHolds(PDO $db, ?array $orderIds = null): int
{
    if (!payTablesExist()) return 0;
    $where = "payment_mode = 'online' AND status = 'pending' AND hold_expires_at IS NOT NULL
              AND hold_expires_at < UTC_TIMESTAMP()
              AND COALESCE(payment_status, '') IN ('INITIATED','PENDING','FAILED','CANCELLED')";
    $params = [];
    if ($orderIds !== null) {
        $numbers = [];
        foreach ($orderIds as $o) {
            $p = payParseNumber((string) $o);
            if ($p !== null && $p['type'] === 'seva_booking') $numbers[$p['number']] = true;
        }
        if (!$numbers) return 0;
        $params = array_keys($numbers);
        $where .= ' AND order_number IN (' . implode(',', array_fill(0, count($params), '?')) . ')';
    }
    $stmt = $db->prepare("SELECT id FROM seva_bookings WHERE {$where} ORDER BY hold_expires_at ASC LIMIT 500");
    $stmt->execute($params);
    $count = 0;
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
        try {
            $done = payTransaction($db, function (PDO $db) use ($id, $where, $params): bool {
                $s = $db->prepare("SELECT id, order_number FROM seva_bookings WHERE id = ? AND {$where} FOR UPDATE");
                $s->execute(array_merge([(int) $id], $params));
                $row = $s->fetch(PDO::FETCH_ASSOC);
                if (!$row) return false;
                $db->prepare("UPDATE seva_bookings SET status = 'cancelled', updated_at = UTC_TIMESTAMP() WHERE id = :id")->execute([':id' => (int) $id]);
                payAudit($db, 'hold_expired', [
                    'payable_type' => 'seva_booking',
                    'payable_id'   => (int) $id,
                    'actor'        => 'cron',
                    'ip'           => null,
                    'detail'       => "The payment hold on {$row['order_number']} expired without payment, so the booking was cancelled.",
                    'data'         => ['number' => $row['order_number']],
                ]);
                return true;
            });
            if ($done) $count++;
        } catch (Throwable $e) {
            error_log('[payments] hold expiry for booking ' . $id . ' failed: ' . $e->getMessage());
        }
    }
    return $count;
}

/**
 * The scheduled run: payReconcileSweep() under MySQL GET_LOCK so two runs never
 * overlap. $opts as payReconcileSweep plus trigger (cli|http|admin).
 *
 * @return array{checked:int, changed:int, cancelled:int, expired:int, errors:int, locked:bool, duration_ms:int, items:array}
 */
function payCronRun(array $opts = []): array
{
    $started = microtime(true);
    $empty = ['checked' => 0, 'changed' => 0, 'cancelled' => 0, 'expired' => 0, 'errors' => 0, 'locked' => false, 'duration_ms' => 0, 'items' => []];
    $db = getDB();
    $got = (int) $db->query("SELECT GET_LOCK('temple_payments_cron', 0)")->fetchColumn();
    if ($got !== 1) {
        return ['locked' => true] + $empty;
    }
    try {
        $summary = payReconcileSweep($db, $opts);
    } finally {
        try {
            $db->query("SELECT RELEASE_LOCK('temple_payments_cron')")->closeCursor();
        } catch (Throwable) {
            // the lock is released with the connection anyway
        }
    }
    return $summary + ['locked' => false, 'duration_ms' => (int) round((microtime(true) - $started) * 1000)];
}

/**
 * Clear needs_review on an attempt, with the reviewer's note (3–500 characters).
 *
 * @return array{ok:bool, message:string}
 */
function payMarkReviewed(PDO $db, int $transactionId, string $note, string $actor): array
{
    $note = trim($note);
    if (mb_strlen($note) < 3 || mb_strlen($note) > 500) return ['ok' => false, 'message' => 'Write a note of 3 to 500 characters saying what was checked.'];
    $res = payTransaction($db, function (PDO $db) use ($transactionId, $note, $actor): array {
        $a = payLoadAttempt($db, $transactionId, true);
        if ($a === null) return ['ok' => false, 'message' => 'That attempt does not exist.'];
        if (!$a['needs_review']) return ['ok' => false, 'message' => 'That attempt is not flagged for review.'];
        $db->prepare('UPDATE payment_transactions SET needs_review = 0, updated_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $transactionId]);
        payAudit($db, 'admin_marked_reviewed', payAuditCtx($a, [
            'actor'  => $actor,
            'detail' => "{$a['order_id']} marked as reviewed: {$note}",
            'data'   => ['order_id' => $a['order_id']],
        ]));
        return ['ok' => true, 'message' => 'Marked as reviewed.', 'order_id' => $a['order_id']];
    });
    if ($res['ok'] && function_exists('adminAudit')) adminAudit('payment_reviewed', (string) $res['order_id'], mb_substr($note, 0, 500));
    unset($res['order_id']);
    return $res;
}

/** SQL fragment: payable columns joined onto payment_transactions t. */
function payReconcileJoin(): string
{
    return "LEFT JOIN donations d ON t.payable_type = 'donation' AND d.id = t.payable_id
            LEFT JOIN seva_bookings b ON t.payable_type = 'seva_booking' AND b.id = t.payable_id";
}

/** SQL select list for a reconciliation row. */
function payReconcileColumns(): string
{
    return "t.id AS transaction_id, t.order_id, t.payable_type AS kind, t.attempt, t.environment, t.amount, t.currency, t.status,
            t.gateway_status, t.tracking_id, t.verification, t.needs_review, t.response_count, t.created_at, t.responded_at,
            COALESCE(d.donation_number, b.order_number) AS number, COALESCE(d.name, b.devotee_name) AS name,
            COALESCE(d.status, b.payment_status) AS payable_status";
}

/**
 * The reconciliation view (§9.2). $filters: from, to (IST Y-m-d; default the
 * last 30 days), kind (donation | seva_booking | ''), csv (a payReconcileCsv()
 * result to fold in). The date range applies to sections built from attempts
 * created in it; needs_review, stale open attempts and waiting refunds are
 * always shown in full because each is something to act on.
 *
 * Sections, each ['title', 'rows' => [...]]: paid_at_gateway, unverified_success,
 * needs_review, duplicate_callbacks, double_payments, missing, refund_mismatches,
 * stale_open. Rows carry transaction_id, order_id, number, kind, name, amount,
 * currency, status, payable_status, gateway_status, tracking_id, verification,
 * needs_review, response_count, created_at and a detail sentence.
 */
function payReconcileReport(PDO $db, array $filters = []): array
{
    $today = payIstDate(null, 'Y-m-d');
    $from = is_string($filters['from'] ?? null) && isValidDate($filters['from']) ? $filters['from'] : (new DateTimeImmutable($today))->modify('-29 days')->format('Y-m-d');
    $to = is_string($filters['to'] ?? null) && isValidDate($filters['to']) ? $filters['to'] : $today;
    $range = payIstRangeUtc($from, $to);
    $kind = in_array($filters['kind'] ?? '', ['donation', 'seva_booking'], true) ? $filters['kind'] : '';
    $kindSql = $kind !== '' ? ' AND t.payable_type = :kind' : '';
    $base = ['from' => $range['from'], 'to' => $range['to']];
    if ($kind !== '') $base['kind'] = $kind;
    $cols = payReconcileColumns();
    $join = payReconcileJoin();
    $run = static function (string $sql, array $params) use ($db): array {
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    };
    $withDetail = static function (array $rows, callable $detail): array {
        foreach ($rows as &$r) {
            $r['needs_review'] = (int) $r['needs_review'] === 1;
            $r['detail'] = $detail($r);
        }
        return $rows;
    };
    $kindOnly = $kind !== '' ? ['kind' => $kind] : [];

    $sections = [];
    $sections['paid_at_gateway'] = [
        'title' => 'Paid at CCAvenue, not paid here',
        'rows'  => $withDetail($run(
            "SELECT {$cols}, JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.api_status')) AS api_status
               FROM payment_transactions t
               JOIN (SELECT transaction_id, MAX(id) AS last_id FROM payment_audit_log
                      WHERE event IN ('reconcile_checked','verification_disagrees') AND transaction_id IS NOT NULL
                      GROUP BY transaction_id) la ON la.transaction_id = t.id
               JOIN payment_audit_log a ON a.id = la.last_id
               {$join}
              WHERE t.status <> 'SUCCESS'
                AND JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.api_status')) IN ('Successful','Shipped')
                AND t.created_at >= :from AND t.created_at < :to{$kindSql}
              ORDER BY t.created_at DESC LIMIT 200",
            $base
        ), static fn(array $r): string => "CCAvenue last reported {$r['api_status']}; here the attempt is {$r['status']}."),
    ];
    $sections['unverified_success'] = [
        'title' => 'Paid here without CCAvenue confirmation',
        'rows'  => $withDetail($run(
            "SELECT {$cols} FROM payment_transactions t {$join}
              WHERE t.status = 'SUCCESS' AND t.verification IN ('none','callback')
                AND t.created_at >= :from AND t.created_at < :to{$kindSql}
              ORDER BY t.created_at DESC LIMIT 200",
            $base
        ), static fn(array $r): string => 'Accepted on the gateway response only; the status check has not confirmed it yet.'),
    ];
    $sections['needs_review'] = [
        'title' => 'Needs review',
        'rows'  => $withDetail($run(
            "SELECT {$cols},
                    (SELECT a.detail FROM payment_audit_log a WHERE a.transaction_id = t.id
                        AND a.event IN ('response_mismatch','tracking_conflict','double_payment','verification_disagrees','response_wrong_environment','response_received')
                      ORDER BY a.id DESC LIMIT 1) AS why
               FROM payment_transactions t {$join}
              WHERE t.needs_review = 1" . ($kind !== '' ? ' AND t.payable_type = :kind' : '') . "
              ORDER BY t.created_at DESC LIMIT 200",
            $kindOnly
        ), static fn(array $r): string => (string) ($r['why'] ?? 'Flagged for review.')),
    ];
    $sections['duplicate_callbacks'] = [
        'title' => 'Duplicate callbacks',
        'rows'  => $withDetail($run(
            "SELECT {$cols} FROM payment_transactions t {$join}
              WHERE t.response_count > 1 AND t.created_at >= :from AND t.created_at < :to{$kindSql}
              ORDER BY t.created_at DESC LIMIT 200",
            $base
        ), static fn(array $r): string => "CCAvenue responded {$r['response_count']} times; only the first could change anything."),
    ];
    // The receipt attempt (payReceiptAttemptSql: the one the receipt was issued
    // for) is kept; every other SUCCESS attempt is an extra payment, refunded
    // against itself.
    $receiptSql = payReceiptAttemptSql();
    $sections['double_payments'] = [
        'title' => 'Double payments',
        'rows'  => $withDetail($run(
            "SELECT {$cols}, (t.id = rc.receipt_id) AS is_receipt,
                    (SELECT COALESCE(SUM(r.amount), 0) FROM payment_refunds r WHERE r.transaction_id = t.id AND r.status = 'SUCCESS') AS attempt_refunded,
                    (SELECT COUNT(*) FROM payment_refunds r WHERE r.transaction_id = t.id AND r.status IN ('REQUESTED','PROCESSING')) AS attempt_refund_open
               FROM payment_transactions t {$join}
               JOIN (SELECT payable_type, payable_id FROM payment_transactions WHERE status = 'SUCCESS'
                      GROUP BY payable_type, payable_id HAVING COUNT(*) > 1) dp
                 ON dp.payable_type = t.payable_type AND dp.payable_id = t.payable_id
               JOIN {$receiptSql} rc ON rc.payable_type = t.payable_type AND rc.payable_id = t.payable_id
              WHERE t.status = 'SUCCESS' AND t.created_at >= :from AND t.created_at < :to{$kindSql}
              ORDER BY t.payable_type, t.payable_id, t.attempt LIMIT 200",
            $base
        ), static function (array $r): string {
            if ((int) $r['is_receipt'] === 1) return 'Paid more than once. This is the attempt the receipt was issued for; keep it.';
            $refunded = payAmountCents((string) $r['attempt_refunded']);
            if ($refunded >= payAmountCents((string) $r['amount'])) return 'The extra payment: refunded in full.';
            if ((int) $r['attempt_refund_open'] > 0) return 'The extra payment: a refund is waiting for CCAvenue.';
            if ($refunded > 0) return 'The extra payment: ' . payMoneyLabel(payCentsToAmount($refunded), (string) $r['currency']) . ' refunded so far; refund the rest.';
            return 'The extra payment: refund this attempt.';
        }),
    ];

    $missing = [];
    $csv = is_array($filters['csv'] ?? null) ? $filters['csv'] : null;
    if ($csv !== null && !empty($csv['ok'])) {
        foreach ($csv['missing_here'] ?? [] as $o) {
            $missing[] = ['order_id' => $o, 'number' => payParseNumber($o)['number'] ?? null, 'detail' => 'In the CCAvenue report, but not found here.'];
        }
        foreach ($csv['missing_there'] ?? [] as $o) {
            $missing[] = ['order_id' => $o, 'number' => payParseNumber($o)['number'] ?? null, 'detail' => 'Paid here, but absent from the CCAvenue report for those dates.'];
        }
        foreach ($csv['paid_there_not_here'] ?? [] as $o) {
            $sections['paid_at_gateway']['rows'][] = ['order_id' => $o, 'number' => payParseNumber($o)['number'] ?? null, 'detail' => 'The CCAvenue report shows it paid; here it is not SUCCESS.'];
        }
    }
    $sections['missing'] = ['title' => 'Missing transactions', 'rows' => $missing];

    // The payable's status and amount_refunded follow the refunds against its
    // receipt attempt only (payDerivePayable); a refund of a duplicate attempt
    // is that attempt's own business. Stale refunds are checked on every attempt.
    $refundRows = $run(
        "SELECT p.kind, p.id, p.number, p.name, p.amount, p.currency, p.status AS payable_status, p.amount_refunded,
                COALESCE(SUM(CASE WHEN r.status = 'SUCCESS' AND t.id = rc.receipt_id THEN r.amount END), 0) AS refunds_success,
                SUM(CASE WHEN r.status IN ('REQUESTED','PROCESSING') AND t.id = rc.receipt_id THEN 1 ELSE 0 END) AS refunds_open,
                SUM(CASE WHEN r.status IN ('REQUESTED','PROCESSING') AND r.created_at < UTC_TIMESTAMP() - INTERVAL 24 HOUR THEN 1 ELSE 0 END) AS refunds_stale
           FROM (SELECT _utf8mb4'donation' COLLATE utf8mb4_unicode_ci AS kind, id, donation_number AS number, name, amount, currency, status, amount_refunded
                   FROM donations WHERE source = 'online' AND donation_number IS NOT NULL
                 UNION ALL
                 SELECT _utf8mb4'seva_booking' COLLATE utf8mb4_unicode_ci, id, order_number, devotee_name, amount, currency, payment_status, amount_refunded
                   FROM seva_bookings WHERE payment_mode = 'online' AND order_number IS NOT NULL) p
           JOIN payment_transactions t ON t.payable_type = p.kind AND t.payable_id = p.id
           LEFT JOIN {$receiptSql} rc ON rc.payable_type = p.kind AND rc.payable_id = p.id
           LEFT JOIN payment_refunds r ON r.transaction_id = t.id
          " . ($kind !== '' ? 'WHERE p.kind = :kind' : '') . "
          GROUP BY p.kind, p.id, p.number, p.name, p.amount, p.currency, p.status, p.amount_refunded
         HAVING COUNT(r.id) > 0 OR p.amount_refunded > 0 OR p.status IN ('REFUND_INITIATED','PARTIALLY_REFUNDED','REFUNDED')
          LIMIT 1000",
        $kindOnly
    );
    $refundMismatches = [];
    foreach ($refundRows as $r) {
        $problems = [];
        $sum = payAmountCents((string) $r['refunds_success']);
        if (payAmountCents((string) $r['amount_refunded']) !== $sum) {
            $problems[] = 'amount refunded ' . payMoneyLabel((string) $r['amount_refunded'], $r['currency']) . ' differs from successful refunds ' . payMoneyLabel(payCentsToAmount($sum), $r['currency']);
        }
        $open = (int) $r['refunds_open'] > 0;
        $expected = $open ? 'REFUND_INITIATED' : ($sum > 0 ? ($sum >= payAmountCents((string) $r['amount']) ? 'REFUNDED' : 'PARTIALLY_REFUNDED') : null);
        if ($expected !== null && $r['payable_status'] !== $expected && !($expected === 'PARTIALLY_REFUNDED' && $r['payable_status'] === 'REFUNDED')) {
            $problems[] = "status is {$r['payable_status']} but the refunds say {$expected}";
        }
        if ($expected === null && in_array($r['payable_status'], ['REFUND_INITIATED', 'PARTIALLY_REFUNDED', 'REFUNDED'], true)) {
            $problems[] = "status is {$r['payable_status']} but there is no refund in progress or completed";
        }
        if ((int) $r['refunds_stale'] > 0) $problems[] = 'a refund has been waiting for more than 24 hours';
        if ($problems) {
            $refundMismatches[] = [
                'kind' => $r['kind'], 'number' => $r['number'], 'name' => $r['name'], 'amount' => payAmountFormat((string) $r['amount'], 'INR'),
                'currency' => $r['currency'], 'payable_status' => $r['payable_status'], 'detail' => ucfirst(implode('; ', $problems)) . '.',
            ];
        }
    }
    if ($csv !== null && !empty($csv['ok'])) {
        foreach ($csv['refunded_there'] ?? [] as $o) {
            $refundMismatches[] = ['order_id' => $o, 'number' => payParseNumber($o)['number'] ?? null, 'detail' => 'The CCAvenue report shows a refund that is not recorded here.'];
        }
    }
    $sections['refund_mismatches'] = ['title' => 'Refund mismatches', 'rows' => $refundMismatches];

    $sections['stale_open'] = [
        'title' => 'Stale open attempts',
        'rows'  => $withDetail($run(
            "SELECT {$cols} FROM payment_transactions t {$join}
              WHERE t.status IN ('INITIATED','PENDING') AND t.created_at < UTC_TIMESTAMP() - INTERVAL 3 HOUR" . ($kind !== '' ? ' AND t.payable_type = :kind' : '') . "
              ORDER BY t.created_at ASC LIMIT 200",
            $kindOnly
        ), static fn(array $r): string => "Still {$r['status']} after more than 3 hours."),
    ];

    $counts = [];
    foreach ($sections as $k => $s) $counts[$k] = count($s['rows']);
    return ['range' => $range, 'kind' => $kind, 'sections' => $sections, 'counts' => $counts];
}

/** A CCAvenue report status as success | refunded | failed | cancelled | pending | unknown. */
function payCsvStatusClass(string $status): string
{
    $s = strtolower(trim($status));
    return match (true) {
        in_array($s, ['successful', 'success', 'shipped', 'captured'], true)                                                         => 'success',
        in_array($s, ['refunded', 'system refund', 'chargeback', 'partially refunded', 'refund'], true)                              => 'refunded',
        in_array($s, ['unsuccessful', 'failure', 'failed', 'invalid', 'fraud', 'auto-cancelled', 'auto-reversed', 'cancelled', 'timeout'], true) => 'failed',
        $s === 'aborted'                                                                                                              => 'cancelled',
        in_array($s, ['initiated', 'awaited', 'pending'], true)                                                                       => 'pending',
        default                                                                                                                       => 'unknown',
    };
}

/** An attempt status as the same classes. */
function payAttemptStatusClass(string $status): string
{
    return match ($status) {
        'SUCCESS'   => 'success',
        'FAILED'    => 'failed',
        'CANCELLED' => 'cancelled',
        default     => 'pending',
    };
}

/** A report date (IST) as UTC "Y-m-d H:i:s", or null. */
function payCsvDateUtc(string $value): ?string
{
    $value = trim($value);
    if ($value === '') return null;
    foreach (['d/m/Y H:i:s', 'd/m/Y H:i', 'd-m-Y H:i:s', 'd-m-Y H:i', 'Y-m-d H:i:s', 'Y-m-d H:i:s.v', 'Y-m-d H:i', 'd/m/Y', 'd-m-Y', 'Y-m-d', 'd-M-Y H:i:s', 'd-M-Y', 'd M Y H:i:s', 'd M Y'] as $format) {
        $dt = DateTimeImmutable::createFromFormat('!' . $format, $value, payIstZone());
        if ($dt !== false && $dt->format($format) === $value) {
            return $dt->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
        }
    }
    return null;
}

/**
 * Compare an order report exported from the CCAvenue dashboard with our records
 * (§9.2). The file is read, not kept. At most 5 MB and 50 000 rows. Headers are
 * matched case-insensitively by alias; order, amount and status columns are
 * required. Each mismatch is audited (reconcile_csv_mismatch).
 *
 * @return array{ok:bool, error:?string, rows:int, matched:int, mismatches:array, missing_here:array,
 *               missing_there:array, refunded_there:array, paid_there_not_here:array, span:?array}
 */
function payReconcileCsv(PDO $db, string $path, string $actor = 'system'): array
{
    $out = ['ok' => false, 'error' => null, 'rows' => 0, 'matched' => 0, 'mismatches' => [], 'missing_here' => [], 'missing_there' => [], 'refunded_there' => [], 'paid_there_not_here' => [], 'span' => null];
    $aliases = [
        'order'     => ['order no', 'order number', 'order id', 'order_no', 'order_id'],
        'reference' => ['reference no', 'reference number', 'tracking id', 'reference_no', 'tracking_id'],
        'amount'    => ['amount', 'order amount', 'order amt', 'order_amt'],
        'currency'  => ['currency', 'order_currency'],
        'status'    => ['order status', 'status', 'order_status'],
        'date'      => ['order date', 'date', 'order date time'],
    ];
    if (!is_file($path) || !is_readable($path)) {
        $out['error'] = 'The uploaded file could not be read.';
        return $out;
    }
    if (filesize($path) > 5 * 1024 * 1024) {
        $out['error'] = 'The file is larger than 5 MB.';
        return $out;
    }
    $fh = fopen($path, 'rb');
    if ($fh === false) {
        $out['error'] = 'The uploaded file could not be read.';
        return $out;
    }
    try {
        $first = fgets($fh);
        if ($first === false) {
            $out['error'] = 'The file is empty.';
            return $out;
        }
        $first = preg_replace('/^\xEF\xBB\xBF/', '', $first) ?? $first;
        $delimiter = substr_count($first, ';') > substr_count($first, ',') ? ';' : (substr_count($first, "\t") > substr_count($first, ',') ? "\t" : ',');
        $header = str_getcsv(rtrim($first, "\r\n"), $delimiter, '"', '');
        $index = [];
        foreach ($header as $i => $name) {
            $norm = strtolower(trim(preg_replace('/\s+/', ' ', (string) $name) ?? ''));
            foreach ($aliases as $field => $list) {
                if (!isset($index[$field]) && in_array($norm, $list, true)) $index[$field] = $i;
            }
        }
        $missingCols = array_diff(['order', 'amount', 'status'], array_keys($index));
        if ($missingCols) {
            $parts = [];
            foreach ($missingCols as $f) $parts[] = ucfirst($f) . ' (' . implode(', ', array_map(static fn($a) => '"' . ucwords($a) . '"', $aliases[$f])) . ')';
            $out['error'] = 'The file has no column for: ' . implode('; ', $parts) . '.';
            return $out;
        }

        $report = [];
        $minDate = null;
        $maxDate = null;
        while (($row = fgetcsv($fh, 0, $delimiter, '"', '')) !== false) {
            if ($row === [null] || $row === []) continue;
            if (count($report) >= 50000) break;
            $orderId = trim((string) ($row[$index['order']] ?? ''));
            if ($orderId === '') continue;
            $out['rows']++;
            $entry = [
                'amount'    => trim((string) ($row[$index['amount']] ?? '')),
                'status'    => trim((string) ($row[$index['status']] ?? '')),
                'currency'  => isset($index['currency']) ? strtoupper(trim((string) ($row[$index['currency']] ?? ''))) : '',
                'reference' => isset($index['reference']) ? trim((string) ($row[$index['reference']] ?? '')) : '',
            ];
            if (isset($index['date'])) {
                $utc = payCsvDateUtc((string) ($row[$index['date']] ?? ''));
                if ($utc !== null) {
                    $minDate = $minDate === null || $utc < $minDate ? $utc : $minDate;
                    $maxDate = $maxDate === null || $utc > $maxDate ? $utc : $maxDate;
                }
            }
            $report[$orderId] = $entry;
        }
        $out['span'] = $minDate !== null ? ['from' => $minDate, 'to' => $maxDate] : null;

        $ours = [];
        $valid = array_values(array_filter(array_keys($report), static fn($o) => payParseNumber((string) $o) !== null));
        foreach (array_chunk($valid, 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            $stmt = $db->prepare(
                "SELECT t.*, COALESCE(d.status, b.payment_status) AS payable_status
                   FROM payment_transactions t " . payReconcileJoin() . "
                  WHERE t.order_id IN ({$in})"
            );
            $stmt->execute($chunk);
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $ours[$r['order_id']] = $r;
        }

        $mismatch = static function (?array $attempt, string $orderId, string $field, string $oursValue, string $theirs) use ($db, $actor, &$out): void {
            $out['mismatches'][] = ['order_id' => $orderId, 'field' => $field, 'ours' => $oursValue, 'theirs' => $theirs];
            payAudit($db, 'reconcile_csv_mismatch', [
                'transaction_id' => $attempt['id'] ?? null,
                'payable_type'   => $attempt['payable_type'] ?? null,
                'payable_id'     => $attempt['payable_id'] ?? null,
                'actor'          => $actor,
                'detail'         => "CCAvenue report and our records differ for {$orderId}: {$field} is \"{$oursValue}\" here and \"{$theirs}\" in the report.",
                'data'           => ['order_id' => mb_substr($orderId, 0, 30), 'field' => $field, 'ours' => $oursValue, 'theirs' => mb_substr($theirs, 0, 60)],
            ]);
        };

        foreach ($report as $orderId => $entry) {
            $orderId = (string) $orderId;
            $attempt = $ours[$orderId] ?? null;
            $theirClass = payCsvStatusClass($entry['status']);
            if ($attempt === null) {
                $out['missing_here'][] = mb_substr($orderId, 0, 40);
                $mismatch(null, $orderId, 'order', 'not found', $entry['status']);
                continue;
            }
            $out['matched']++;
            $ourClass = payAttemptStatusClass((string) $attempt['status']);
            if ($theirClass === 'refunded') {
                if (!in_array($attempt['payable_status'], ['PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_INITIATED'], true)) {
                    $out['refunded_there'][] = $orderId;
                    $mismatch($attempt, $orderId, 'refund', (string) $attempt['payable_status'], $entry['status']);
                }
            } elseif ($theirClass !== 'unknown' && $theirClass !== $ourClass) {
                if ($theirClass === 'success') $out['paid_there_not_here'][] = $orderId;
                $mismatch($attempt, $orderId, 'status', (string) $attempt['status'], $entry['status']);
            }
            $amount = payAmountParse(str_replace(',', '', $entry['amount']));
            if ($amount === null || payAmountCents($amount) !== payAmountCents((string) $attempt['amount'])) {
                $mismatch($attempt, $orderId, 'amount', payAmountFormat((string) $attempt['amount'], 'INR'), $entry['amount']);
            }
            if ($entry['currency'] !== '' && $entry['currency'] !== strtoupper((string) $attempt['currency'])) {
                $mismatch($attempt, $orderId, 'currency', (string) $attempt['currency'], $entry['currency']);
            }
            if ($entry['reference'] !== '' && $attempt['tracking_id'] !== null && $entry['reference'] !== $attempt['tracking_id']) {
                $mismatch($attempt, $orderId, 'reference', (string) $attempt['tracking_id'], $entry['reference']);
            }
        }

        if ($out['span'] !== null) {
            $stmt = $db->prepare("SELECT order_id FROM payment_transactions WHERE status = 'SUCCESS' AND environment <> 'simulator' AND created_at >= :f AND created_at <= :t");
            $stmt->execute([':f' => $out['span']['from'], ':t' => $out['span']['to']]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $o) {
                if (!isset($report[$o])) $out['missing_there'][] = $o;
            }
        }
        $out['ok'] = true;
        return $out;
    } finally {
        fclose($fh);
    }
}
