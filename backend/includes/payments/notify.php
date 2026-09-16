<?php
/**
 * backend/includes/payments/notify.php — messages about payments
 * (docs/payments/SPEC.md §6).
 *
 * Always called after the payment's transaction has committed, and never able
 * to change a payment: every function catches its own failures. The recipient
 * is a guest (phone, optional email, name, language). Channels are always
 * passed explicitly from payChannels(), which follows Admin → Payment Gateway.
 *
 *   donation.paid       first SUCCESS of an online donation   entity donation  = donations.id
 *   payment.succeeded   first SUCCESS of an online seva        entity payment   = payment_transactions.id
 *   payment.failed      an attempt becomes FAILED (email only) entity payment   = payment_transactions.id
 *   payment.refunded    a refund becomes SUCCESS               entity payment_refund = payment_refunds.id
 *
 * Success and refund dedupe keys come from the catalogue (paymentReference =
 * the payable number), so a double payment or a replayed callback never sends
 * twice. Receipt resends override the dedupe key with
 * receipt:{number}:resend:{sequence}.
 */

/**
 * Channels for a kind of payment message: success | refund | resend follow the
 * notify_email / notify_whatsapp / notify_sms settings; failure is ['email']
 * only when email is on and the payable has an email; receipt_email (the donor's
 * button) is ['email'] when email is on.
 */
function payChannels(string $kind, array $payable = [], ?array $cfg = null): array
{
    $cfg ??= payConfig();
    $hasEmail = trim((string) ($payable['email'] ?? '')) !== '';
    switch ($kind) {
        case 'success':
        case 'refund':
        case 'resend':
            $out = [];
            if ($cfg['notify_email']) $out[] = 'email';
            if ($cfg['notify_whatsapp']) $out[] = 'whatsapp';
            if ($cfg['notify_sms']) $out[] = 'sms';
            return $out;
        case 'failure':
            return $cfg['notify_email'] && $hasEmail ? ['email'] : [];
        case 'receipt_email':
            return $cfg['notify_email'] ? ['email'] : [];
        default:
            return [];
    }
}

/**
 * The receipt attempt of a payable (the SUCCESS attempt receipts, messages and
 * the payable's own refunds refer to): receipt_attempt_id from payLoadPayable(),
 * else the first SUCCESS attempt. Null when nothing is paid.
 */
function paySuccessAttempt(array $payable): ?array
{
    $wanted = isset($payable['receipt_attempt_id']) ? (int) $payable['receipt_attempt_id'] : 0;
    foreach ($payable['attempts'] ?? [] as $a) {
        if ($wanted > 0 && (int) $a['id'] === $wanted && $a['status'] === 'SUCCESS') return $a;
    }
    foreach ($payable['attempts'] ?? [] as $a) {
        if ($a['status'] === 'SUCCESS') return $a;
    }
    return null;
}

/** The newest attempt of a payable, or null. */
function payLatestAttempt(array $payable): ?array
{
    $attempts = $payable['attempts'] ?? [];
    return $attempts ? $attempts[count($attempts) - 1] : null;
}

/** What the payment was for, in 'ta' or 'en': the category name or the seva name. */
function payNotifyPurpose(array $payable, string $lang): string
{
    $l = $lang === 'ta' ? 'ta' : 'en';
    if (($payable['type'] ?? '') === 'donation') {
        return (string) ($payable['category'][$l] ?? $payable['purpose'] ?? '');
    }
    return (string) ($payable['seva'][$l] ?? $payable['seva_name'] ?? '');
}

/** Site path of a payable's receipt page, with its access token. */
function payReceiptPath(string $number): string
{
    return '/payment/receipt?ref=' . rawurlencode($number) . '&t=' . rawurlencode(payAccessToken($number));
}

/** Site path of a payable's result page, with its access token. */
function payResultPath(string $number): string
{
    return '/payment/result?ref=' . rawurlencode($number) . '&t=' . rawurlencode(payAccessToken($number));
}

/** The email details table rows (label, value) for a paid payable, in the recipient's language. */
function payNotifyDetails(array $payable, ?array $attempt, string $lang): array
{
    $ta = $lang === 'ta';
    $isDonation = $payable['type'] === 'donation';
    $rows = [
        [$ta ? 'ரசீது எண்' : 'Receipt number', (string) ($payable['receipt_number'] ?? '')],
        [$isDonation ? ($ta ? 'நன்கொடை எண்' : 'Donation ID') : ($ta ? 'முன்பதிவு எண்' : 'Booking ID'), (string) $payable['number']],
        [$isDonation ? ($ta ? 'நோக்கம்' : 'Purpose') : ($ta ? 'சேவை' : 'Seva'), payNotifyPurpose($payable, $lang)],
        [$ta ? 'தொகை' : 'Amount', payMoneyLabel($payable['amount'], $payable['currency'])],
        [$ta ? 'செலுத்திய நேரம் (IST)' : 'Payment date (IST)', $payable['paid_at'] ? payIstDate($payable['paid_at'], 'd-m-Y H:i') : ''],
        [$ta ? 'செலுத்தும் முறை' : 'Payment mode', (string) ($attempt['payment_mode'] ?? '')],
        [$ta ? 'CCAvenue குறிப்பு எண்' : 'CCAvenue reference', (string) ($attempt['tracking_id'] ?? '')],
    ];
    return array_values(array_filter($rows, static fn(array $r): bool => trim($r[1]) !== ''));
}

/** Variables every success-style template gets. */
function payNotifyVars(array $payable, ?array $attempt, string $lang): array
{
    $l = devoteeCopyLang($lang);
    $vars = [
        'devoteeName'      => (string) $payable['name'],
        'receiptNumber'    => (string) ($payable['receipt_number'] ?? ''),
        'paymentReference' => (string) $payable['number'],
        'paymentAmount'    => payMoneyLabel($payable['amount'], $payable['currency']),
        'paymentFor'       => payNotifyPurpose($payable, $l),
        'paymentDate'      => $payable['paid_at'] ? notifyFormatDate(payIstDate($payable['paid_at'], 'Y-m-d'), $l) : '',
        'paymentMode'      => (string) ($attempt['payment_mode'] ?? ''),
    ];
    if ($payable['type'] === 'seva_booking') {
        $vars['bookingDate'] = devoteeBookingDateLabel($payable['preferred_date'] ?? null, $l);
    }
    return $vars;
}

/**
 * Raise one notification event for a payable and audit what happened
 * (notification_queued with per-channel statuses, or notification_skipped).
 * Returns notifyEvent()'s result, or null when nothing was attempted.
 */
function payNotifyRaise(PDO $db, string $event, array $payable, array $ctx, string $actor, ?int $transactionId = null): ?array
{
    $audit = [
        'transaction_id' => $transactionId,
        'payable_type'   => $payable['type'],
        'payable_id'     => $payable['id'],
        'actor'          => $actor,
    ];
    if (empty($ctx['channels'])) {
        payAudit($db, 'notification_skipped', $audit + [
            'detail' => "No {$event} message: no channel is switched on for it.",
            'data'   => ['event' => $event, 'reason' => 'no channels'],
        ]);
        return null;
    }
    if (!devoteeNotifyReady()) {
        payAudit($db, 'notification_skipped', $audit + [
            'detail' => "No {$event} message: the notification service is not available.",
            'data'   => ['event' => $event, 'reason' => 'service unavailable'],
        ]);
        return null;
    }
    $ctx += [
        'to_phone' => devoteeIntlPhone($payable['phone'], $payable['phone_country']),
        'name'     => $payable['name'],
        'lang'     => $payable['lang'],
        'actor'    => $actor,
    ];
    if (trim((string) ($payable['email'] ?? '')) !== '' && !isset($ctx['to_email'])) $ctx['to_email'] = $payable['email'];

    $res = devoteeNotifyEvent($event, $ctx);
    if ($res === null || !empty($res['skipped']) || empty($res['id'])) {
        $reason = $res === null ? 'service error' : (string) ($res['skipped'] ?? 'not created');
        payAudit($db, 'notification_skipped', $audit + [
            'detail' => "The {$event} message was not created ({$reason}).",
            'data'   => ['event' => $event, 'reason' => $reason],
        ]);
        return $res;
    }
    $channels = [];
    foreach ($res['deliveries'] ?? [] as $channel => $d) {
        $channels[$channel] = $d['status'] . (!empty($d['reason']) ? ' (' . $d['reason'] . ')' : '');
    }
    payAudit($db, 'notification_queued', $audit + [
        'detail' => "{$event} " . (!empty($res['deduped']) ? 'was already sent (deduplicated)' : 'queued') . ($channels ? ': ' . implode(', ', array_map(static fn($c, $s) => "{$c} {$s}", array_keys($channels), $channels)) : '') . '.',
        'data'   => ['event' => $event, 'notification_id' => $res['id'], 'deduped' => !empty($res['deduped']), 'channels' => $channels],
    ]);
    return $res;
}

/** donation.paid or payment.succeeded for a payable that has just become paid. Never throws. */
function payNotifySuccess(PDO $db, array $payable): ?array
{
    try {
        if (!in_array($payable['status'], PAY_PAID_STATUSES, true)) return null;
        $attempt = paySuccessAttempt($payable);
        if ($attempt === null) return null;
        $isDonation = $payable['type'] === 'donation';
        $l = devoteeCopyLang($payable['lang']);
        $ctx = [
            'entity_id' => $isDonation ? (int) $payable['id'] : (int) $attempt['id'],
            'channels'  => payChannels('success', $payable),
            'cta_url'   => payReceiptPath($payable['number']),
        ];
        if (devoteeNotifyReady()) {
            $ctx['vars'] = payNotifyVars($payable, $attempt, $l);
            $ctx['details'] = payNotifyDetails($payable, $attempt, $l);
        }
        return payNotifyRaise($db, $isDonation ? 'donation.paid' : 'payment.succeeded', $payable, $ctx, 'system', (int) $attempt['id']);
    } catch (Throwable $e) {
        error_log('[payments] success message for ' . ($payable['number'] ?? '?') . ' failed: ' . $e->getMessage());
        return null;
    }
}

/** payment.failed (email only) when an attempt has become FAILED. No message without an email. Never throws. */
function payNotifyFailed(PDO $db, array $payable, array $attempt): ?array
{
    try {
        $channels = payChannels('failure', $payable);
        if (!$channels) return null;
        $l = devoteeCopyLang($payable['lang']);
        $ctx = [
            'entity_id' => (int) $attempt['id'],
            'channels'  => $channels,
            'cta_url'   => payResultPath($payable['number']),
            'vars'      => [
                'devoteeName'      => (string) $payable['name'],
                'paymentReference' => (string) $attempt['order_id'],
                'paymentAmount'    => payMoneyLabel($attempt['amount'], $attempt['currency']),
                'paymentFor'       => payNotifyPurpose($payable, $l),
                'reason'           => trim((string) ($attempt['failure_message'] ?? '')) !== ''
                    ? mb_substr(trim((string) $attempt['failure_message']), 0, 200)
                    : ($l === 'ta' ? 'பரிவர்த்தனை நிறைவடையவில்லை.' : 'The payment was not completed.'),
            ],
        ];
        return payNotifyRaise($db, 'payment.failed', $payable, $ctx, 'system', (int) $attempt['id']);
    } catch (Throwable $e) {
        error_log('[payments] failure message for ' . ($attempt['order_id'] ?? '?') . ' failed: ' . $e->getMessage());
        return null;
    }
}

/** payment.refunded for a refund that has become SUCCESS. Never throws. */
function payNotifyRefund(PDO $db, array $payable, array $refund): ?array
{
    try {
        $l = devoteeCopyLang($payable['lang']);
        $ctx = [
            'entity_id' => (int) $refund['id'],
            'channels'  => payChannels('refund', $payable),
            'cta_url'   => payReceiptPath($payable['number']),
            'vars'      => [
                'devoteeName'      => (string) $payable['name'],
                'refundAmount'     => payMoneyLabel((string) $refund['amount'], (string) $refund['currency']),
                'paymentReference' => (string) $payable['number'],
                'receiptNumber'    => (string) ($payable['receipt_number'] ?? ''),
                'refundReference'  => (string) $refund['refund_reference'],
                'paymentFor'       => payNotifyPurpose($payable, $l),
            ],
        ];
        return payNotifyRaise($db, 'payment.refunded', $payable, $ctx, 'system', (int) $refund['transaction_id']);
    } catch (Throwable $e) {
        error_log('[payments] refund message for refund ' . ($refund['id'] ?? '?') . ' failed: ' . $e->getMessage());
        return null;
    }
}

/**
 * Send a paid payable's receipt again (admin "Resend receipt", or the donor's
 * "Email receipt" with $channels = ['email']). Re-raises donation.paid /
 * payment.succeeded with dedupe key receipt:{number}:resend:{sequence}.
 *
 * @return array{ok:bool, message:string, sequence:int, channels:array, result:?array}
 */
function payNotifyReceiptResend(PDO $db, array $payable, string $actor, ?array $channels = null): array
{
    $out = ['ok' => false, 'message' => '', 'sequence' => 0, 'channels' => [], 'result' => null];
    try {
        if (!in_array($payable['status'], PAY_PAID_STATUSES, true)) {
            $out['message'] = 'Only a paid payment has a receipt to send.';
            return $out;
        }
        $channels ??= payChannels('resend', $payable);
        $out['channels'] = $channels;
        if (!$channels) {
            $out['message'] = 'No message channel is switched on for payment messages.';
            return $out;
        }
        if (!devoteeNotifyReady()) {
            $out['message'] = 'The notification service is not available.';
            return $out;
        }
        $attempt = paySuccessAttempt($payable);
        $stmt = $db->prepare('SELECT COUNT(*) FROM notifications WHERE dedupe_key LIKE :p');
        $stmt->execute([':p' => 'receipt:' . $payable['number'] . ':resend:%']);
        $sequence = (int) $stmt->fetchColumn() + 1;
        $out['sequence'] = $sequence;
        $isDonation = $payable['type'] === 'donation';
        $l = devoteeCopyLang($payable['lang']);
        $ctx = [
            'entity_id'  => $isDonation ? (int) $payable['id'] : (int) ($attempt['id'] ?? 0),
            'channels'   => $channels,
            'dedupe_key' => 'receipt:' . $payable['number'] . ':resend:' . $sequence,
            'cta_url'    => payReceiptPath($payable['number']),
            'vars'       => payNotifyVars($payable, $attempt, $l),
            'details'    => payNotifyDetails($payable, $attempt, $l),
        ];
        $res = payNotifyRaise($db, $isDonation ? 'donation.paid' : 'payment.succeeded', $payable, $ctx, $actor, isset($attempt['id']) ? (int) $attempt['id'] : null);
        $out['result'] = $res;
        $out['ok'] = $res !== null && !empty($res['id']);
        $out['message'] = $out['ok'] ? 'Receipt queued.' : 'The receipt message could not be created.';
        if ($out['ok'] && $channels === ['email']) {
            payAudit($db, 'receipt_emailed', [
                'transaction_id' => isset($attempt['id']) ? (int) $attempt['id'] : null,
                'payable_type'   => $payable['type'],
                'payable_id'     => $payable['id'],
                'actor'          => $actor,
                'detail'         => "Receipt for {$payable['number']} emailed to " . payMaskEmail($payable['email']) . " (resend {$sequence}).",
                'data'           => ['sequence' => $sequence],
            ]);
        }
        return $out;
    } catch (Throwable $e) {
        error_log('[payments] receipt resend for ' . ($payable['number'] ?? '?') . ' failed: ' . $e->getMessage());
        $out['message'] = 'The receipt message could not be created.';
        return $out;
    }
}
