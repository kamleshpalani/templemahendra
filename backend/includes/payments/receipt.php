<?php
/**
 * backend/includes/payments/receipt.php — what a donor's own links show
 * (docs/payments/SPEC.md §5.5).
 *
 * The status, receipt and verify endpoints return these shapes. A number alone
 * reveals nothing: status and receipt need the access token, verify needs the
 * receipt's own short token, and verify shows only masked facts.
 */

/** "k•••@gmail.com", or null. */
function payMaskEmail(?string $email): ?string
{
    $email = trim((string) $email);
    if ($email === '' || !str_contains($email, '@')) return null;
    [$local, $domain] = explode('@', $email, 2);
    return mb_substr($local, 0, 1) . '•••@' . $domain;
}

/** "ABCDE••••F", or null. */
function payMaskPan(?string $pan): ?string
{
    $pan = strtoupper(trim((string) $pan));
    if ($pan === '') return null;
    return strlen($pan) === 10 ? substr($pan, 0, 5) . '••••' . substr($pan, -1) : '••••';
}

/** "S•••• K••••": the first letter of each word. */
function payMaskName(string $name): string
{
    $words = preg_split('/\s+/u', trim($name), -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $out = array_map(static fn(string $w): string => mb_substr($w, 0, 1) . '••••', array_slice($words, 0, 4));
    return $out ? implode(' ', $out) : 'Devotee';
}

/**
 * Whether the donor may start a new attempt (§2.4): fewer than 5 attempts, the
 * payable not paid or refunded, the booking (for a seva) not cancelled by the
 * office — a cancellation that was only the payment hold expiring still allows
 * paying — and the latest attempt FAILED, CANCELLED, INITIATED for at least
 * 2 minutes or PENDING for at least 15 minutes.
 */
function payCanRetry(array $payable, ?int $nowTs = null): bool
{
    $attempts = $payable['attempts'] ?? [];
    if (count($attempts) >= PAY_MAX_ATTEMPTS) return false;
    $status = (string) ($payable['status'] ?? '');
    if (in_array($status, PAY_PAID_STATUSES, true)) return false;
    foreach ($attempts as $a) {
        if ($a['status'] === 'SUCCESS') return false;
    }
    if (($payable['type'] ?? '') === 'seva_booking' && ($payable['booking_status'] ?? '') === 'cancelled' && empty($payable['cancelled_by_hold'])) {
        return false; // the office cancelled the booking: there is nothing left to pay for
    }
    $latest = payLatestAttempt($payable);
    if ($latest === null) return false;
    $age = ($nowTs ?? time()) - (int) strtotime($latest['created_at'] . ' UTC');
    return match ($latest['status']) {
        'FAILED', 'CANCELLED' => true,
        'INITIATED'           => $age >= 120,
        'PENDING'             => $age >= 900,
        default               => false,
    };
}

/**
 * GET /api/payments/status (and, with $forReceipt, /receipt). $payable is the
 * payLoadPayable() shape. Timestamps are ISO-8601 UTC.
 */
function payPublicView(PDO $db, array $payable, bool $forReceipt = false): array
{
    $attempts = $payable['attempts'] ?? [];
    $success = paySuccessAttempt($payable);
    $latest = payLatestAttempt($payable);
    $ref = $success ?? $latest;
    $isDonation = $payable['type'] === 'donation';
    // Which gateway the money (did not) go through: the paid attempt's environment,
    // else the latest attempt's. Both flags drive the "no real money" banner.
    $environment = (string) ($ref['environment'] ?? '');
    $simulator = $environment === 'simulator' || (payTablesExist() && payConfig()['mode'] === 'simulator');
    $testMode = $environment === 'test';
    $view = [
        'kind'           => $payable['type'],
        'number'         => $payable['number'],
        'status'         => $payable['status'],
        'amount'         => payNumberOut($payable['amount']),
        'currency'       => $payable['currency'],
        'amountRefunded' => payNumberOut($payable['amount_refunded']),
        'createdAt'      => payIsoUtc($attempts[0]['created_at'] ?? null),
        'paidAt'         => payIsoUtc($payable['paid_at']),
        'receiptNumber'  => $payable['receipt_number'],
        'donorName'      => $payable['name'],
        'purpose'        => $isDonation && $payable['category'] ? ['ta' => $payable['category']['ta'], 'en' => $payable['category']['en']] : null,
        'seva'           => !$isDonation && $payable['seva'] ? ['ta' => $payable['seva']['ta'], 'en' => $payable['seva']['en']] : null,
        'preferredDate'  => $payable['preferred_date'],
        'trackingId'     => $ref['tracking_id'] ?? null,
        'bankRefNo'      => $ref['bank_ref_no'] ?? null,
        'paymentMode'    => $ref['payment_mode'] ?? null,
        'failureMessage' => $latest !== null && $latest['status'] === 'FAILED' ? $latest['failure_message'] : null,
        'canRetry'       => payCanRetry($payable),
        'attempts'       => count($attempts),
        'simulator'      => $simulator,
        'testMode'       => $testMode,
        'email'          => payMaskEmail($payable['email']),
    ];
    if ($forReceipt) {
        $receipt = (string) $payable['receipt_number'];
        $view['receiptNumber'] = $receipt;
        $view['verifyUrl'] = siteUrl('/payment/verify?r=' . rawurlencode($receipt) . '&v=' . rawurlencode(payVerifyToken($receipt)));
        $view['pan'] = payMaskPan($payable['pan']);
        $view['address'] = [
            'line'     => $payable['address']['line'] ?? null,
            'city'     => $payable['address']['city'] ?? null,
            'state'    => $payable['address']['state'] ?? null,
            'postcode' => $payable['address']['postcode'] ?? null,
            'country'  => $payable['country'],
        ];
        $view['message'] = $payable['message'];
    }
    return $view;
}

/**
 * GET /api/payments/verify?r=&v=. Always an array: {valid:false} for anything
 * that is not a genuine receipt, so a prober learns nothing from the answer.
 */
function payVerifyLookup(PDO $db, mixed $receipt, mixed $token): array
{
    if (!is_string($receipt) || !preg_match(PAY_RECEIPT_PATTERN, $receipt) || !payVerifyTokenValid($receipt, $token)) {
        return ['valid' => false];
    }
    foreach (['donation' => ['donations', "source = 'online'"], 'seva_booking' => ['seva_bookings', "payment_mode = 'online'"]] as $type => [$table, $where]) {
        $stmt = $db->prepare("SELECT id FROM {$table} WHERE receipt_number = :r AND {$where}");
        $stmt->execute([':r' => $receipt]);
        $id = $stmt->fetchColumn();
        if ($id === false) continue;
        $p = payLoadPayableById($db, $type, (int) $id);
        if ($p === null) break;
        $out = [
            'valid'         => true,
            'receiptNumber' => $receipt,
            'date'          => $p['paid_at'] ? payIstDate($p['paid_at'], 'Y-m-d') : null,
            'amount'        => payNumberOut($p['amount']),
            'currency'      => $p['currency'],
            'status'        => $p['status'],
        ];
        if ($type === 'donation') {
            $out['purpose'] = $p['category'] ? ['ta' => $p['category']['ta'], 'en' => $p['category']['en']] : null;
        } else {
            $out['seva'] = $p['seva'] ? ['ta' => $p['seva']['ta'], 'en' => $p['seva']['en']] : null;
        }
        $out['donor'] = $p['show_name_publicly'] ? payMaskName($p['name']) : 'Anonymous devotee';
        return $out;
    }
    return ['valid' => false];
}
