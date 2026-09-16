<?php
/**
 * backend/includes/payments/refunds.php — giving money back
 * (docs/payments/SPEC.md §8).
 *
 * A refund is its own row in payment_refunds and never touches the payment row
 * or the attempt: only the payable's derived status and amount_refunded change
 * (payDerivePayable). The request is committed before CCAvenue is asked, so a
 * crash in between leaves a REQUESTED refund the admin can check again, never an
 * unrecorded one. Capability checks (payments.refund) are the admin page's job.
 */

/** Payable statuses a refund may be made from. */
const PAY_REFUNDABLE_STATUSES = ['SUCCESS', 'PARTIALLY_REFUNDED', 'REFUND_INITIATED'];

/** One refund row, amounts normalised. */
function payRefundLoad(PDO $db, int $id, bool $lock = false): ?array
{
    $stmt = $db->prepare('SELECT * FROM payment_refunds WHERE id = :id' . ($lock ? ' FOR UPDATE' : ''));
    $stmt->execute([':id' => $id]);
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$r) return null;
    $r['id'] = (int) $r['id'];
    $r['transaction_id'] = (int) $r['transaction_id'];
    $r['amount'] = payAmountFormat((string) $r['amount'], 'INR');
    return $r;
}

/** Every refund of a payable, newest first. */
function payRefundsFor(PDO $db, string $type, int $payableId): array
{
    $stmt = $db->prepare(
        'SELECT r.*, t.order_id FROM payment_refunds r
           JOIN payment_transactions t ON t.id = r.transaction_id
          WHERE t.payable_type = :t AND t.payable_id = :id
          ORDER BY r.created_at DESC, r.id DESC'
    );
    $stmt->execute([':t' => $type, ':id' => $payableId]);
    return array_map(static function (array $r): array {
        $r['id'] = (int) $r['id'];
        $r['transaction_id'] = (int) $r['transaction_id'];
        $r['amount'] = payAmountFormat((string) $r['amount'], 'INR');
        return $r;
    }, $stmt->fetchAll(PDO::FETCH_ASSOC));
}

/**
 * How much of a SUCCESS attempt can still be refunded: its amount minus the
 * refunds against it that are REQUESTED, PROCESSING or SUCCESS. "0.00" when the
 * attempt is not SUCCESS, or when the payable is not in a refundable status —
 * for the receipt attempt that is SUCCESS / PARTIALLY_REFUNDED /
 * REFUND_INITIATED; a duplicate SUCCESS attempt (a double payment, §2.4) only
 * needs the payable to have been paid, because its own refund never moves the
 * payable's status (payDerivePayable).
 */
function payRefundableAmount(PDO $db, array $payable, array $attempt): string
{
    if (($attempt['status'] ?? '') !== 'SUCCESS') return '0.00';
    $receiptAttempt = paySuccessAttempt($payable);
    $isReceiptAttempt = $receiptAttempt === null || (int) $receiptAttempt['id'] === (int) ($attempt['id'] ?? 0);
    if (!in_array($payable['status'] ?? '', $isReceiptAttempt ? PAY_REFUNDABLE_STATUSES : PAY_PAID_STATUSES, true)) {
        return '0.00';
    }
    $stmt = $db->prepare(
        "SELECT COALESCE(SUM(amount), 0) FROM payment_refunds
          WHERE transaction_id = :id AND status IN ('REQUESTED','PROCESSING','SUCCESS')"
    );
    $stmt->execute([':id' => (int) $attempt['id']]);
    $left = payAmountCents((string) $attempt['amount']) - payAmountCents((string) $stmt->fetchColumn());
    return payCentsToAmount(max(0, $left));
}

/**
 * Create a refund and carry it as far as it can go now.
 *
 * $kind full | partial, $method gateway_api | manual, $reason 5–500 characters,
 * $gatewayRef an optional reference for a manual refund. With $kind full,
 * $amount must be blank or equal to the refundable amount: an amount typed
 * next to "Full" is a contradiction, refused rather than guessed at.
 * Steps: (1) transaction — lock the attempt, then the payable (the same order
 * as a gateway callback, so the two never deadlock), recompute, insert
 * REQUESTED, payable REFUND_INITIATED, audit refund_requested; (2) gateway_api: refundOrder outside
 * the transaction — accepted → SUCCESS, refused → FAILED, no answer → stays
 * REQUESTED ("CCAvenue did not answer"); manual → SUCCESS at once; (3) re-derive
 * the payable and send payment.refunded for a SUCCESS refund.
 *
 * @return array{ok:bool, refund:?array, message:string}
 */
function payRefundCreate(PDO $db, array $payable, array $attempt, string $kind, string $amount, string $reason, string $method, ?string $gatewayRef, string $actor): array
{
    $fail = static fn(string $m): array => ['ok' => false, 'refund' => null, 'message' => $m];
    if (!in_array($kind, ['full', 'partial'], true)) return $fail('Choose a full or a partial refund.');
    if (!in_array($method, ['gateway_api', 'manual'], true)) return $fail('Choose how the refund is made.');
    $reason = trim($reason);
    if (mb_strlen($reason) < 5 || mb_strlen($reason) > 500) return $fail('Give a reason of 5 to 500 characters.');
    $gatewayRef = $gatewayRef !== null ? mb_substr(trim($gatewayRef), 0, 60) : null;
    if ($gatewayRef === '') $gatewayRef = null;
    if ((int) ($attempt['payable_id'] ?? 0) !== (int) $payable['id'] || ($attempt['payable_type'] ?? '') !== $payable['type']) {
        return $fail('That attempt does not belong to this payment.');
    }
    if ($method === 'gateway_api' && (!ccavApiConfigured((string) $attempt['environment']) || empty($attempt['tracking_id']))) {
        return $fail('This refund cannot be sent to CCAvenue automatically (the API is not configured, or the payment has no CCAvenue reference). Record a refund made in the CCAvenue dashboard instead.');
    }

    try {
        $created = payTransaction($db, function (PDO $db) use ($payable, $attempt, $kind, $amount, $reason, $method, $gatewayRef, $actor): array {
            // Attempt first, then the payable: the order payApplyGatewayResponse → payDerivePayable takes them in.
            $lockedAttempt = payLoadAttempt($db, (int) $attempt['id'], true);
            $lockedPayable = $lockedAttempt !== null ? payLoadPayableById($db, $payable['type'], (int) $payable['id'], true) : null;
            if ($lockedPayable === null || $lockedAttempt === null) return ['error' => 'The payment could not be found.'];
            $refundable = payRefundableAmount($db, $lockedPayable, $lockedAttempt);
            $refundableCents = payAmountCents($refundable);
            if ($refundableCents <= 0) return ['error' => 'Nothing is left to refund on this payment.'];

            if ($kind === 'full') {
                $typed = trim($amount);
                $typedValue = $typed !== '' ? payAmountParse($typed) : null;
                if ($typed !== '' && ($typedValue === null || payAmountCents($typedValue) !== $refundableCents)) {
                    return ['error' => 'An amount was typed but “Full” is selected. Choose “Part of it” to refund ' . ($typedValue !== null ? payMoneyLabel($typedValue, $lockedAttempt['currency']) : 'that amount')
                        . ', or clear the amount to refund the whole ' . payMoneyLabel($refundable, $lockedAttempt['currency']) . '. Nothing was refunded.'];
                }
                $value = $refundable;
            } else {
                $value = payAmountParse($amount);
                if ($value === null || payAmountCents($value) <= 0) return ['error' => 'Enter the refund amount, for example 250 or 250.50.'];
                if (payAmountCents($value) > $refundableCents) {
                    return ['error' => 'The refund cannot be more than ' . payMoneyLabel($refundable, $lockedAttempt['currency']) . '.'];
                }
                if (payCurrencyDecimals($lockedAttempt['currency']) === 0 && payAmountCents($value) % 100 !== 0) {
                    return ['error' => 'Refunds in ' . $lockedAttempt['currency'] . ' must be whole numbers.'];
                }
            }

            $refundRef = '';
            for ($i = 0; $i < 5; $i++) {
                $candidate = 'RF' . $lockedAttempt['id'] . 'T' . (time() + $i);
                $s = $db->prepare('SELECT 1 FROM payment_refunds WHERE refund_reference = :r');
                $s->execute([':r' => $candidate]);
                if ($s->fetchColumn() === false) {
                    $refundRef = $candidate;
                    break;
                }
            }
            if ($refundRef === '') return ['error' => 'Please try the refund again in a few seconds.'];

            $db->prepare(
                "INSERT INTO payment_refunds
                    (transaction_id, refund_reference, amount, currency, kind, reason, method, status, gateway_reference, requested_by, created_at, updated_at)
                 VALUES (:t, :ref, :amount, :cur, :kind, :reason, :method, 'REQUESTED', :gref, :actor, UTC_TIMESTAMP(), UTC_TIMESTAMP())"
            )->execute([
                ':t' => $lockedAttempt['id'], ':ref' => $refundRef, ':amount' => $value, ':cur' => $lockedAttempt['currency'],
                ':kind' => $kind, ':reason' => $reason, ':method' => $method, ':gref' => $method === 'manual' ? $gatewayRef : null,
                ':actor' => mb_substr($actor, 0, 60),
            ]);
            $refundId = (int) $db->lastInsertId();
            payDerivePayable($db, $lockedPayable['type'], (int) $lockedPayable['id'], $actor);
            payAudit($db, 'refund_requested', payAuditCtx($lockedAttempt, [
                'actor'  => $actor,
                'detail' => ucfirst($kind) . ' refund ' . $refundRef . ' of ' . payMoneyLabel($value, $lockedAttempt['currency'])
                    . " requested for {$lockedPayable['number']} (" . ($method === 'manual' ? 'recorded as made in the CCAvenue dashboard' : 'sent to CCAvenue') . ").",
                'data'   => ['refund_id' => $refundId, 'refund_reference' => $refundRef, 'amount' => $value, 'kind' => $kind, 'method' => $method],
            ]));
            return ['refund_id' => $refundId];
        });
    } catch (Throwable $e) {
        error_log('[payments] refund request failed: ' . get_class($e) . ': ' . $e->getMessage());
        return $fail('The refund could not be recorded. Nothing was changed.');
    }
    if (isset($created['error'])) return $fail($created['error']);
    $refundId = (int) $created['refund_id'];
    if (function_exists('adminAudit')) {
        adminAudit('payment_refund', $payable['number'], mb_substr("refund {$refundId} requested ({$kind}, {$method}): {$reason}", 0, 500));
    }

    if ($method === 'manual') {
        $settled = payRefundSettle($db, $refundId, 'SUCCESS', $gatewayRef !== null ? 'Recorded as refunded in the CCAvenue dashboard (' . $gatewayRef . ')' : 'Recorded as refunded in the CCAvenue dashboard', $actor, 'refund_manual_recorded');
        return ['ok' => true, 'refund' => $settled, 'message' => 'The refund was recorded.'];
    }
    return payRefundSend($db, $refundId, $actor);
}

/**
 * Send (or re-send, with the same refund_ref_no) a REQUESTED gateway refund to
 * CCAvenue and settle it from the answer.
 *
 * @return array{ok:bool, refund:?array, message:string}
 */
function payRefundSend(PDO $db, int $refundId, string $actor): array
{
    $refund = payRefundLoad($db, $refundId);
    if ($refund === null) return ['ok' => false, 'refund' => null, 'message' => 'That refund does not exist.'];
    if ($refund['method'] !== 'gateway_api' || !in_array($refund['status'], ['REQUESTED', 'PROCESSING'], true)) {
        return ['ok' => false, 'refund' => $refund, 'message' => 'Only a refund still waiting for CCAvenue can be checked again.'];
    }
    $attempt = payLoadAttempt($db, $refund['transaction_id']);
    if ($attempt === null || empty($attempt['tracking_id'])) {
        return ['ok' => false, 'refund' => $refund, 'message' => 'The payment has no CCAvenue reference to refund against.'];
    }
    $answer = ccavRefund(
        (string) $attempt['tracking_id'],
        payAmountFormat($refund['amount'], $refund['currency']),
        (string) $refund['refund_reference'],
        payEnvConfig(payConfig(), (string) $attempt['environment'])
    );
    if (!$answer['ok']) {
        $db->prepare("UPDATE payment_refunds SET gateway_message = 'CCAvenue did not answer', updated_at = UTC_TIMESTAMP() WHERE id = :id AND status IN ('REQUESTED','PROCESSING')")
           ->execute([':id' => $refundId]);
        return ['ok' => false, 'refund' => payRefundLoad($db, $refundId), 'message' => 'CCAvenue did not answer. The refund is still requested; use Check again later.'];
    }
    if ($answer['accepted']) {
        payAudit($db, 'refund_accepted', payAuditCtx($attempt, [
            'actor'  => $actor,
            'detail' => "CCAvenue accepted refund {$refund['refund_reference']}.",
            'data'   => ['refund_id' => $refundId, 'refund_reference' => $refund['refund_reference']],
        ]));
        $settled = payRefundSettle($db, $refundId, 'SUCCESS', 'Accepted by CCAvenue', $actor, 'refund_succeeded');
        return ['ok' => true, 'refund' => $settled, 'message' => 'CCAvenue accepted the refund.'];
    }
    payAudit($db, 'refund_refused', payAuditCtx($attempt, [
        'actor'  => $actor,
        'detail' => "CCAvenue refused refund {$refund['refund_reference']}: {$answer['reason']}",
        'data'   => ['refund_id' => $refundId, 'reason' => $answer['reason'], 'error_code' => $answer['error_code']],
    ]));
    $settled = payRefundSettle($db, $refundId, 'FAILED', mb_substr($answer['reason'], 0, 255), $actor, 'refund_failed');
    return ['ok' => false, 'refund' => $settled, 'message' => 'CCAvenue refused the refund: ' . $answer['reason']];
}

/** Admin "Check again": re-send a REQUESTED gateway refund with its original reference. */
function payRefundCheckAgain(PDO $db, int $refundId, string $actor): array
{
    return payRefundSend($db, $refundId, $actor);
}

/** Admin "Mark as failed" (owner, reason required) for a refund still waiting for CCAvenue. */
function payRefundMarkFailed(PDO $db, int $refundId, string $reason, string $actor): array
{
    $reason = trim($reason);
    if (mb_strlen($reason) < 5 || mb_strlen($reason) > 255) {
        return ['ok' => false, 'refund' => null, 'message' => 'Give a reason of 5 to 255 characters.'];
    }
    $refund = payRefundLoad($db, $refundId);
    if ($refund === null || !in_array($refund['status'], ['REQUESTED', 'PROCESSING'], true)) {
        return ['ok' => false, 'refund' => $refund, 'message' => 'Only a refund that is still requested can be marked as failed.'];
    }
    $settled = payRefundSettle($db, $refundId, 'FAILED', 'Marked as failed: ' . $reason, $actor, 'refund_failed');
    return ['ok' => true, 'refund' => $settled, 'message' => 'The refund was marked as failed.'];
}

/**
 * Move a REQUESTED/PROCESSING refund to SUCCESS or FAILED, re-derive the payable
 * in the same transaction, audit, and after commit send payment.refunded for a
 * SUCCESS. A refund already settled is returned unchanged.
 */
function payRefundSettle(PDO $db, int $refundId, string $status, string $message, string $actor, string $auditEvent): ?array
{
    if (!in_array($status, ['SUCCESS', 'FAILED'], true)) throw new InvalidArgumentException("A refund settles as SUCCESS or FAILED, not {$status}.");
    $changed = payTransaction($db, function (PDO $db) use ($refundId, $status, $message, $actor, $auditEvent): ?array {
        $refund = payRefundLoad($db, $refundId, true);
        if ($refund === null || !in_array($refund['status'], ['REQUESTED', 'PROCESSING'], true)) return null;
        $db->prepare('UPDATE payment_refunds SET status = :s, gateway_message = :m, processed_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = :id')
           ->execute([':s' => $status, ':m' => mb_substr($message, 0, 255), ':id' => $refundId]);
        $attempt = payLoadAttempt($db, $refund['transaction_id']);
        $derived = payDerivePayable($db, (string) $attempt['payable_type'], (int) $attempt['payable_id'], $actor);
        payAudit($db, $auditEvent, payAuditCtx($attempt, [
            'actor'  => $actor,
            'detail' => 'Refund ' . $refund['refund_reference'] . ' of ' . payMoneyLabel($refund['amount'], $refund['currency'])
                . ($status === 'SUCCESS' ? ' succeeded' : ' failed') . ($message !== '' ? ": {$message}" : '') . '.',
            'data'   => ['refund_id' => $refundId, 'status' => $status, 'payable_from' => $derived['from'], 'payable_to' => $derived['to']],
        ]));
        return ['attempt' => $attempt];
    });
    $refund = payRefundLoad($db, $refundId);
    if ($changed !== null && $status === 'SUCCESS' && $refund !== null) {
        $payable = payLoadPayableById($db, (string) $changed['attempt']['payable_type'], (int) $changed['attempt']['payable_id']);
        if ($payable !== null) payNotifyRefund($db, $payable, $refund);
    }
    if ($changed !== null && function_exists('adminAudit') && $refund !== null) {
        adminAudit('payment_refund', (string) $refund['refund_reference'], mb_substr("refund {$refundId} {$status}: {$message}", 0, 500));
    }
    return $refund;
}
