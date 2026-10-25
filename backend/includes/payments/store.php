<?php
/**
 * backend/includes/payments/store.php — payables, attempts and the one place
 * statuses change (docs/payments/SPEC.md §2, §5.3).
 *
 * Every status change goes through payStateApply(), which enforces the
 * transition table on an attempt row the caller has locked, then re-derives the
 * payable (payDerivePayable) in the same transaction: one SUCCESS, one receipt
 * number, however many times CCAvenue or the donor's browser repeats itself.
 * Nothing here sends a message; callers notify after commit.
 */

/** Thrown when a payable has used all its attempts. */
class PayLimitException extends RuntimeException
{
}

/**
 * Allowed attempt transitions (§2.4). FAILED/CANCELLED → SUCCESS additionally
 * needs verification = status_api (a late success confirmed by CCAvenue).
 */
const PAY_ATTEMPT_TRANSITIONS = [
    'INITIATED' => ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'],
    'PENDING'   => ['SUCCESS', 'FAILED', 'CANCELLED'],
    'FAILED'    => ['SUCCESS'],
    'CANCELLED' => ['SUCCESS'],
    'SUCCESS'   => [],
];

/** Strength order of verification evidence. */
const PAY_VERIFICATION_RANK = ['none' => 0, 'callback' => 1, 'status_api' => 2, 'manual' => 3];

/**
 * Run $work($db) in a transaction, nested-safe: inside an existing transaction
 * it just runs (the outer owner commits); otherwise it begins, commits, and rolls
 * back and rethrows on any exception.
 */
function payTransaction(PDO $db, callable $work): mixed
{
    $own = !$db->inTransaction();
    if ($own) $db->beginTransaction();
    try {
        $result = $work($db);
        if ($own) $db->commit();
        return $result;
    } catch (Throwable $e) {
        if ($own && $db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

/** 'donations' or 'seva_bookings'. */
function payTableFor(string $type): string
{
    return match ($type) {
        'donation'     => 'donations',
        'seva_booking' => 'seva_bookings',
        default        => throw new InvalidArgumentException("Unknown payable type: {$type}"),
    };
}

/** True when an attempt may move from $from to $to with this evidence. */
function payTransitionAllowed(string $from, string $to, string $verification = ''): bool
{
    if ($from === $to || !in_array($to, PAY_ATTEMPT_TRANSITIONS[$from] ?? [], true)) return false;
    if ($from === 'FAILED' || $from === 'CANCELLED') return $verification === 'status_api';
    return true;
}

/**
 * Create an online donation and its first attempt in one transaction. $values
 * comes from payValidateDonation(); $cfg is payConfig() (its mode becomes the
 * attempt's environment).
 *
 * @return array{payable:array, attempt:array}
 */
function payCreateDonation(PDO $db, array $values, array $cfg, string $ip): array
{
    return payTransaction($db, function (PDO $db) use ($values, $cfg, $ip): array {
        $streamId = null;
        if (($values['stream'] ?? '') !== '') {
            if (!liveDonationsExist($db)) throw new LiveDonationsNotReady('Apply live donations migration 014.');
            $streamId = liveDonationStreamId($db, $values['stream'], true);
            if ($streamId === null) throw new LiveDonationUnavailable();
        }
        $db->prepare(
            "INSERT INTO donations
                (source, name, phone, phone_country, email, country, address_line, city, state, postcode, pan,
                 amount, currency, purpose, category_id, message, notes, lang, show_name_publicly,
                 status, amount_refunded, created_at, updated_at)
             VALUES
                ('online', :name, :phone, :pc, :email, :country, :addr, :city, :state, :postcode, :pan,
                 :amount, :currency, :purpose, :cat, :message, :notes, :lang, :show,
                 'INITIATED', 0, NOW(), UTC_TIMESTAMP())"
        )->execute([
            ':name'     => mb_substr((string) $values['name'], 0, 200),
            ':phone'    => (string) $values['phone'],
            ':pc'       => $values['phone_country'],
            ':email'    => $values['email'],
            ':country'  => $values['country'],
            ':addr'     => $values['address'],
            ':city'     => $values['city'],
            ':state'    => $values['state'],
            ':postcode' => $values['postcode'],
            ':pan'      => $values['pan'],
            ':amount'   => $values['amount'],
            ':currency' => $values['currency'],
            ':purpose'  => $values['category'],
            ':cat'      => $values['category_id'],
            ':message'  => $values['message'],
            ':notes'    => $values['notes'],
            ':lang'     => $values['lang'],
            ':show'     => $values['show_name_publicly'] ? 1 : 0,
        ]);
        $id = (int) $db->lastInsertId();
        if ($streamId !== null) {
            $db->prepare('UPDATE donations SET live_stream_id = :stream WHERE id = :id')
               ->execute([':stream' => $streamId, ':id' => $id]);
        }
        // The pooja this donation sponsors (validated by payValidateDonation; the
        // column exists once migration 023 is in, which that validation checked).
        $poojaId = isset($values['pooja_id']) && (int) $values['pooja_id'] > 0 ? (int) $values['pooja_id'] : null;
        if ($poojaId !== null) {
            $db->prepare('UPDATE donations SET pooja_id = :pooja WHERE id = :id')->execute([':pooja' => $poojaId, ':id' => $id]);
        }
        $number = payNumberFor('donation', $id, payIstDate());
        $db->prepare('UPDATE donations SET donation_number = :n WHERE id = :id')->execute([':n' => $number, ':id' => $id]);

        payAudit($db, 'payable_created', [
            'payable_type' => 'donation',
            'payable_id'   => $id,
            'actor'        => 'donor',
            'ip'           => $ip,
            'detail'       => "Online donation {$number} created for " . payMoneyLabel((string) $values['amount'], (string) $values['currency'])
                . ($poojaId !== null ? ' (sponsoring ' . (string) ($values['pooja_name']['en'] ?? "pooja #{$poojaId}") . ')' : '') . '.',
            'data'         => ['number' => $number, 'amount' => $values['amount'], 'currency' => $values['currency'], 'category' => $values['category'], 'pooja_id' => $poojaId],
        ]);
        $payable = payLoadPayableById($db, 'donation', $id);
        $attempt = payCreateAttempt($db, 'donation', $payable, $cfg['mode'], (string) $values['lang'], $ip);
        return ['payable' => payLoadPayableById($db, 'donation', $id), 'attempt' => $attempt];
    });
}

/**
 * Create an online seva booking (status 'pending', payment INITIATED, price from
 * the database, a hold of hold_minutes) and its first attempt. $values comes
 * from payValidateSevaBooking().
 *
 * @return array{payable:array, attempt:array}
 */
function payCreateSevaBooking(PDO $db, array $values, array $cfg, string $ip): array
{
    return payTransaction($db, function (PDO $db) use ($values, $cfg, $ip): array {
        $db->prepare(
            "INSERT INTO seva_bookings
                (devotee_name, phone, phone_country, seva_id, seva_name, preferred_date, message, lang, status,
                 payment_mode, email, amount, currency, payment_status, amount_refunded, hold_expires_at, created_at, updated_at)
             VALUES
                (:name, :phone, :pc, :seva, :seva_name, :date, :message, :lang, 'pending',
                 'online', :email, :amount, 'INR', 'INITIATED', 0, UTC_TIMESTAMP() + INTERVAL :hold MINUTE, NOW(), UTC_TIMESTAMP())"
        )->execute([
            ':name'      => mb_substr((string) $values['devotee_name'], 0, 200),
            ':phone'     => (string) $values['phone'],
            ':pc'        => $values['phone_country'],
            ':seva'      => $values['seva_id'],
            ':seva_name' => mb_substr((string) $values['seva_name'], 0, 200),
            ':date'      => $values['preferred_date'],
            ':message'   => $values['message'],
            ':lang'      => $values['lang'],
            ':email'     => $values['email'],
            ':amount'    => $values['amount'],
            ':hold'      => (int) $cfg['hold_minutes'],
        ]);
        $id = (int) $db->lastInsertId();
        $number = payNumberFor('seva_booking', $id, payIstDate());
        bookingStoreDetails($db, $id, $values);
        $db->prepare('UPDATE seva_bookings SET order_number = :n WHERE id = :id')->execute([':n' => $number, ':id' => $id]);

        payAudit($db, 'payable_created', [
            'payable_type' => 'seva_booking',
            'payable_id'   => $id,
            'actor'        => 'donor',
            'ip'           => $ip,
            'detail'       => "Online seva booking {$number} created for " . payMoneyLabel((string) $values['amount'], 'INR') . " ({$values['seva_name']}).",
            'data'         => ['number' => $number, 'amount' => $values['amount'], 'currency' => 'INR', 'seva_id' => $values['seva_id']],
        ]);
        $payable = payLoadPayableById($db, 'seva_booking', $id);
        $attempt = payCreateAttempt($db, 'seva_booking', $payable, $cfg['mode'], (string) $values['lang'], $ip);
        return ['payable' => payLoadPayableById($db, 'seva_booking', $id), 'attempt' => $attempt];
    });
}

/**
 * A new attempt for a payable: attempt = max + 1 (throws PayLimitException past
 * 5), order_id per §1, amount and currency copied from the stored payable. A
 * retry puts the payable back to INITIATED and gives a seva booking a fresh hold.
 * Whether a retry is allowed at all is payCanRetry()'s question, asked first.
 */
function payCreateAttempt(PDO $db, string $type, array $payable, string $environment, string $lang, string $ip): array
{
    if (!in_array($environment, PAY_MODES, true)) throw new InvalidArgumentException("Unknown gateway environment: {$environment}");
    $table = payTableFor($type);
    return payTransaction($db, function (PDO $db) use ($type, $table, $payable, $environment, $lang, $ip): array {
        $lock = $db->prepare("SELECT id FROM {$table} WHERE id = :id FOR UPDATE");
        $lock->execute([':id' => (int) $payable['id']]);
        if ($lock->fetchColumn() === false) throw new RuntimeException('The payment record no longer exists.');

        $stmt = $db->prepare('SELECT COALESCE(MAX(attempt), 0) FROM payment_transactions WHERE payable_type = :t AND payable_id = :id');
        $stmt->execute([':t' => $type, ':id' => (int) $payable['id']]);
        $next = (int) $stmt->fetchColumn() + 1;
        if ($next > PAY_MAX_ATTEMPTS) {
            throw new PayLimitException('This payment has already been tried ' . PAY_MAX_ATTEMPTS . ' times.');
        }
        $orderId = payOrderIdFor((string) $payable['number'], $next);
        $db->prepare(
            "INSERT INTO payment_transactions
                (payable_type, payable_id, attempt, order_id, gateway, environment, amount, currency, status, lang, client_ip, created_at, updated_at)
             VALUES (:t, :pid, :n, :o, 'ccavenue', :env, :amount, :cur, 'INITIATED', :lang, :ip, UTC_TIMESTAMP(), UTC_TIMESTAMP())"
        )->execute([
            ':t'      => $type,
            ':pid'    => (int) $payable['id'],
            ':n'      => $next,
            ':o'      => $orderId,
            ':env'    => $environment,
            ':amount' => payAmountFormat((string) $payable['amount'], 'INR'),
            ':cur'    => (string) $payable['currency'],
            ':lang'   => $lang === 'en' ? 'en' : 'ta',
            ':ip'     => $ip !== '' ? mb_substr($ip, 0, 45) : null,
        ]);
        $attempt = payLoadAttempt($db, (int) $db->lastInsertId());
        payAudit($db, 'attempt_created', payAuditCtx($attempt, [
            'actor'  => 'donor',
            'ip'     => $ip,
            'detail' => "Attempt {$next} ({$orderId}) created in " . strtoupper($environment) . ' mode for ' . payMoneyLabel($attempt['amount'], $attempt['currency']) . '.',
            'data'   => ['order_id' => $orderId, 'attempt' => $next, 'environment' => $environment],
        ]));
        if ($next > 1) {
            if ($type === 'seva_booking') {
                $db->prepare('UPDATE seva_bookings SET hold_expires_at = UTC_TIMESTAMP() + INTERVAL :m MINUTE WHERE id = :id')
                   ->execute([':m' => (int) payConfig()['hold_minutes'], ':id' => (int) $payable['id']]);
            }
            payDerivePayable($db, $type, (int) $payable['id'], 'donor');
        }
        return $attempt;
    });
}

/** An attempt row with typed values (gateway_response decoded). */
function payAttemptShape(array $row): array
{
    $row['id'] = (int) $row['id'];
    $row['payable_id'] = (int) $row['payable_id'];
    $row['attempt'] = (int) $row['attempt'];
    $row['amount'] = payAmountFormat((string) $row['amount'], 'INR');
    $row['response_count'] = (int) $row['response_count'];
    $row['needs_review'] = (int) $row['needs_review'] === 1;
    $decoded = is_string($row['gateway_response'] ?? null) ? json_decode($row['gateway_response'], true) : null;
    $row['gateway_response'] = is_array($decoded) ? $decoded : null;
    return $row;
}

/** One attempt by id (optionally locked FOR UPDATE — only inside a transaction). */
function payLoadAttempt(PDO $db, int $id, bool $lock = false): ?array
{
    $stmt = $db->prepare('SELECT * FROM payment_transactions WHERE id = :id' . ($lock ? ' FOR UPDATE' : ''));
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? payAttemptShape($row) : null;
}

/** The attempt for an order id, locked FOR UPDATE. Must be called inside a transaction. Null when unknown or malformed. */
function payLoadAttemptForUpdate(PDO $db, string $orderId): ?array
{
    if (payParseNumber($orderId) === null) return null;
    if (!$db->inTransaction()) throw new LogicException('payLoadAttemptForUpdate() needs a transaction.');
    $stmt = $db->prepare('SELECT * FROM payment_transactions WHERE order_id = :o FOR UPDATE');
    $stmt->execute([':o' => $orderId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? payAttemptShape($row) : null;
}

/** Every attempt of a payable, oldest first. */
function payAttemptsFor(PDO $db, string $type, int $id): array
{
    $stmt = $db->prepare('SELECT * FROM payment_transactions WHERE payable_type = :t AND payable_id = :id ORDER BY attempt ASC');
    $stmt->execute([':t' => $type, ':id' => $id]);
    return array_map('payAttemptShape', $stmt->fetchAll(PDO::FETCH_ASSOC));
}

/**
 * A payable by its number (DON-… / SEV-…, or an order id of one of its attempts),
 * in the normalised shape; null when the number is malformed or unknown. $lock
 * takes a row lock on the donation/booking (inside a transaction).
 *
 * Shape: type, id, number, status, amount, currency, amount_refunded,
 * receipt_number, paid_at, created_at, updated_at, name, phone, phone_country,
 * email, lang, country, category {slug, ta, en}|null, seva {id, ta, en}|null,
 * preferred_date, show_name_publicly, address {line, city, state, postcode},
 * pan, message, notes, purpose, booking_status, hold_expires_at,
 * cancelled_by_hold (seva bookings only), receipt_attempt_id (the SUCCESS
 * attempt the receipt belongs to, payReceiptAttemptOf(); null unpaid), attempts [].
 */
function payLoadPayable(PDO $db, string $number, bool $lock = false): ?array
{
    $parsed = payParseNumber($number);
    if ($parsed === null) return null;
    $table = payTableFor($parsed['type']);
    $col = $parsed['type'] === 'donation' ? 'donation_number' : 'order_number';
    $stmt = $db->prepare("SELECT id FROM {$table} WHERE {$col} = :n");
    $stmt->execute([':n' => $parsed['number']]);
    $id = $stmt->fetchColumn();
    if ($id === false) return null;
    return payLoadPayableById($db, $parsed['type'], (int) $id, $lock);
}

/** A payable by type and row id, in the payLoadPayable() shape. Only online rows. */
function payLoadPayableById(PDO $db, string $type, int $id, bool $lock = false): ?array
{
    $table = payTableFor($type);
    if ($lock) {
        $l = $db->prepare("SELECT id FROM {$table} WHERE id = :id FOR UPDATE");
        $l->execute([':id' => $id]);
        if ($l->fetchColumn() === false) return null;
    }
    if ($type === 'donation') {
        // The pooja join only once migration 023 is in; without it the payable
        // simply carries no pooja.
        $withPooja = payPoojaLinksReady();
        $stmt = $db->prepare(
            'SELECT d.*, c.slug AS cat_slug, c.name_ta AS cat_ta, c.name_en AS cat_en'
            . ($withPooja ? ', p.id AS pooja_row_id, p.name_ta AS pooja_ta, p.name_en AS pooja_en, p.pooja_date AS pooja_date, p.pooja_time AS pooja_time, p.pooja_type AS pooja_type, p.is_active AS pooja_active' : '')
            . ' FROM donations d
               LEFT JOIN donation_categories c ON c.id = d.category_id'
            . ($withPooja ? ' LEFT JOIN poojas p ON p.id = d.pooja_id' : '')
            . " WHERE d.id = :id AND d.source = 'online'"
        );
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$r || $r['donation_number'] === null) return null;
        $category = $r['cat_slug'] !== null ? ['slug' => $r['cat_slug'], 'ta' => $r['cat_ta'], 'en' => $r['cat_en']] : null;
        $pooja = null;
        if ($withPooja && $r['pooja_row_id'] !== null) {
            $pooja = payPoojaShape([
                'id' => $r['pooja_row_id'], 'name_ta' => $r['pooja_ta'], 'name_en' => $r['pooja_en'], 'pooja_date' => $r['pooja_date'],
                'pooja_time' => $r['pooja_time'], 'pooja_type' => $r['pooja_type'], 'is_active' => $r['pooja_active'],
            ]);
        }
        $attempts = payAttemptsFor($db, 'donation', (int) $r['id']);
        return [
            'type'               => 'donation',
            'live_stream_id'      => isset($r['live_stream_id']) ? (int) $r['live_stream_id'] : null,
            'pooja_id'           => isset($r['pooja_id']) ? (int) $r['pooja_id'] : null,
            'pooja'              => $pooja,
            'id'                 => (int) $r['id'],
            'number'             => (string) $r['donation_number'],
            'status'             => $r['status'],
            'amount'             => payAmountFormat((string) $r['amount'], 'INR'),
            'currency'           => (string) $r['currency'],
            'amount_refunded'    => payAmountFormat((string) $r['amount_refunded'], 'INR'),
            'receipt_number'     => $r['receipt_number'],
            'paid_at'            => $r['paid_at'],
            'created_at'         => $r['created_at'],
            'updated_at'         => $r['updated_at'],
            'name'               => (string) $r['name'],
            'phone'              => (string) $r['phone'],
            'phone_country'      => $r['phone_country'],
            'email'              => $r['email'],
            'lang'               => $r['lang'] === 'en' ? 'en' : 'ta',
            'country'            => $r['country'],
            'category'           => $category,
            'seva'               => null,
            'preferred_date'     => null,
            'show_name_publicly' => (int) $r['show_name_publicly'] === 1,
            'address'            => ['line' => $r['address_line'], 'city' => $r['city'], 'state' => $r['state'], 'postcode' => $r['postcode']],
            'pan'                => $r['pan'],
            'message'            => $r['message'],
            'notes'              => $r['notes'],
            'purpose'            => $r['purpose'],
            'booking_status'     => null,
            'hold_expires_at'    => null,
            'receipt_attempt_id' => payReceiptAttemptOf($db, 'donation', (int) $r['id'], $attempts)['id'] ?? null,
            'attempts'           => $attempts,
        ];
    }
    $stmt = $db->prepare(
        "SELECT b.*, s.name_ta AS seva_ta, s.name_en AS seva_en
           FROM seva_bookings b
           LEFT JOIN sevas s ON s.id = b.seva_id
          WHERE b.id = :id AND b.payment_mode = 'online'"
    );
    $stmt->execute([':id' => $id]);
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$r || $r['order_number'] === null) return null;
    $attempts = payAttemptsFor($db, 'seva_booking', (int) $r['id']);
    return [
        'type'               => 'seva_booking',
        'pooja_id'           => null,
        'pooja'              => null,
        'id'                 => (int) $r['id'],
        'number'             => (string) $r['order_number'],
        'status'             => $r['payment_status'],
        'amount'             => payAmountFormat((string) $r['amount'], 'INR'),
        'currency'           => (string) ($r['currency'] ?? 'INR'),
        'amount_refunded'    => payAmountFormat((string) $r['amount_refunded'], 'INR'),
        'receipt_number'     => $r['receipt_number'],
        'paid_at'            => $r['paid_at'],
        'created_at'         => $r['created_at'],
        'updated_at'         => $r['updated_at'],
        'name'               => (string) $r['devotee_name'],
        'phone'              => (string) $r['phone'],
        'phone_country'      => $r['phone_country'],
        'email'              => $r['email'],
        'lang'               => $r['lang'] === 'en' ? 'en' : 'ta',
        'country'            => null,
        'category'           => null,
        'seva'               => [
            'id' => $r['seva_id'] !== null ? (int) $r['seva_id'] : null,
            'ta' => (string) ($r['seva_ta'] ?? $r['seva_name']),
            'en' => (string) ($r['seva_en'] ?? $r['seva_name']),
        ],
        'preferred_date'     => $r['preferred_date'],
        'show_name_publicly' => false,
        'address'            => ['line' => null, 'city' => null, 'state' => null, 'postcode' => null],
        'pan'                => null,
        'message'            => $r['message'],
        'notes'              => null,
        'purpose'            => null,
        'seva_name'          => (string) $r['seva_name'],
        'participants'       => json_decode($r['participants'] ?? 'null', true, 512, JSON_THROW_ON_ERROR),
        'delivery_address'   => json_decode($r['delivery_address'] ?? 'null', true, 512, JSON_THROW_ON_ERROR),
        'delivery_fee'       => (string) ($r['delivery_fee'] ?? '0.00'),
        'dispatch_status'    => $r['dispatch_status'] ?? 'not_required',
        'tracking_reference' => $r['tracking_reference'] ?? null,
        'booking_status'     => (string) $r['status'],
        'hold_expires_at'    => $r['hold_expires_at'],
        // A 'cancelled' booking may still be paid for (and is restored) only when the
        // cancellation was the hold expiring, never when the office cancelled it.
        'cancelled_by_hold'  => (string) $r['status'] === 'cancelled' && payBookingCancelledByHold($db, (int) $r['id']),
        'receipt_attempt_id' => payReceiptAttemptOf($db, 'seva_booking', (int) $r['id'], $attempts)['id'] ?? null,
        'attempts'           => $attempts,
    ];
}

/**
 * Apply a status to an attempt the caller has locked (payLoadAttemptForUpdate)
 * inside its transaction, enforce §2.4, record the facts, re-derive the payable,
 * and audit. Pure database work: notifications are the caller's job after
 * commit (firstSuccess → payNotifySuccess; to FAILED → payNotifyFailed).
 *
 * $facts (all optional):
 *   responded bool       a gateway response arrived: response_count + 1, responded_at
 *   checked bool         a reconciliation check: last_checked_at
 *   needs_review bool    set needs_review = 1 (never cleared here)
 *   verification string  callback | status_api | manual — upgrades, never downgrades
 *   verified bool        with status_api: verified_at
 *   tracking_id, bank_ref_no, payment_mode, card_name, failure_message,
 *   status_code, status_message, gateway_status (raw), gateway_response (array)
 *   channel string       response | cancel | notify (for audit wording)
 *   via string           appended to the status_changed sentence
 *   detail string        replaces the status_changed sentence
 *
 * A repeated status is a no-op apart from counters, review flag, verification
 * upgrade and blanks being filled; with responded it audits response_duplicate.
 * A transition the table refuses changes no status; a callback success on a
 * FAILED/CANCELLED attempt is flagged for review so a late payment is not lost.
 *
 * @return array{changed:bool, from:string, to:string, payableFrom:?string, payableTo:?string,
 *               firstSuccess:bool, receiptNumber:?string, doublePayment:bool}
 */
function payStateApply(PDO $db, array $attempt, string $newStatus, array $facts, string $actor): array
{
    if (!in_array($newStatus, PAY_ATTEMPT_STATUSES, true)) throw new InvalidArgumentException("Unknown attempt status: {$newStatus}");
    if (!$db->inTransaction()) throw new LogicException('payStateApply() must run inside the caller\'s transaction, on a locked attempt.');

    $from = (string) $attempt['status'];
    $verification = (string) ($facts['verification'] ?? '');
    $same = $from === $newStatus;
    $allowed = !$same && payTransitionAllowed($from, $newStatus, $verification);
    $needsReview = !empty($facts['needs_review']);
    if (!$same && !$allowed && $newStatus === 'SUCCESS' && in_array($from, ['FAILED', 'CANCELLED'], true)) {
        $needsReview = true; // money may have been taken after all; a person must look
    }

    $set = ['updated_at = UTC_TIMESTAMP()'];
    $params = [':id' => (int) $attempt['id']];
    if (!empty($facts['responded'])) {
        $set[] = 'response_count = response_count + 1';
        $set[] = 'responded_at = UTC_TIMESTAMP()';
    }
    if (!empty($facts['checked'])) $set[] = 'last_checked_at = UTC_TIMESTAMP()';
    if ($needsReview) $set[] = 'needs_review = 1';

    $columns = ['bank_ref_no' => 100, 'payment_mode' => 40, 'card_name' => 60, 'failure_message' => 255, 'status_code' => 10, 'status_message' => 255];
    if ($allowed || $same) {
        // The raw order_status last seen — but a response the transition table
        // refuses (a late "Failure" for a paid attempt) must not relabel what
        // the attempt is; it is audited as ignored below and nothing else.
        if (isset($facts['gateway_status']) && $facts['gateway_status'] !== '') {
            $set[] = 'gateway_status = :gs';
            $params[':gs'] = mb_substr((string) $facts['gateway_status'], 0, 40);
        }
        foreach ($columns as $col => $max) {
            if (!array_key_exists($col, $facts) || $facts[$col] === null || $facts[$col] === '') continue;
            // A change of status records what the gateway said; a repeat only fills blanks.
            $set[] = $allowed ? "{$col} = :{$col}" : "{$col} = COALESCE({$col}, :{$col})";
            $params[":{$col}"] = mb_substr((string) $facts[$col], 0, $max);
        }
        if (isset($facts['gateway_response']) && is_array($facts['gateway_response'])) {
            $set[] = $allowed ? 'gateway_response = :gr' : 'gateway_response = COALESCE(gateway_response, :gr)';
            $params[':gr'] = json_encode(payRedact($facts['gateway_response']), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        }
        if (!empty($facts['tracking_id']) && $attempt['tracking_id'] === null) {
            $set[] = 'tracking_id = :tid';
            $params[':tid'] = mb_substr((string) $facts['tracking_id'], 0, 40);
        }
        $rankNow = PAY_VERIFICATION_RANK[$attempt['verification']] ?? 0;
        if (isset(PAY_VERIFICATION_RANK[$verification]) && PAY_VERIFICATION_RANK[$verification] > $rankNow) {
            $set[] = 'verification = :ver';
            $params[':ver'] = $verification;
        }
        if ($verification === 'status_api' && !empty($facts['verified'])) $set[] = 'verified_at = UTC_TIMESTAMP()';
    }
    if ($allowed) {
        $set[] = 'status = :status';
        $params[':status'] = $newStatus;
    }
    $db->prepare('UPDATE payment_transactions SET ' . implode(', ', $set) . ' WHERE id = :id')->execute($params);

    $ctx = payAuditCtx($attempt, ['actor' => $actor]);
    $orderId = (string) $attempt['order_id'];
    $doublePayment = false;
    if ($allowed && $newStatus === 'SUCCESS') {
        $stmt = $db->prepare("SELECT COUNT(*) FROM payment_transactions WHERE payable_type = :t AND payable_id = :p AND status = 'SUCCESS' AND id <> :id");
        $stmt->execute([':t' => $attempt['payable_type'], ':p' => (int) $attempt['payable_id'], ':id' => (int) $attempt['id']]);
        if ((int) $stmt->fetchColumn() > 0) {
            $doublePayment = true;
            $db->prepare('UPDATE payment_transactions SET needs_review = 1 WHERE id = :id')->execute([':id' => (int) $attempt['id']]);
            payAudit($db, 'double_payment', $ctx + [
                'detail' => "{$orderId} succeeded although this payment was already paid by another attempt. Refund one of them.",
                'data'   => ['order_id' => $orderId],
            ]);
        }
    }

    if ($same && !empty($facts['responded'])) {
        payAudit($db, 'response_duplicate', $ctx + [
            'detail' => 'A repeated ' . ($facts['channel'] ?? 'gateway') . " response for {$orderId} ({$from}) changed nothing.",
            'data'   => ['order_id' => $orderId, 'status' => $from, 'channel' => $facts['channel'] ?? null],
        ]);
    } elseif (!$same && !$allowed && !empty($facts['responded'])) {
        payAudit($db, 'response_received', $ctx + [
            'detail' => "A response saying {$newStatus} for {$orderId} was not applied: the attempt is already {$from}" . ($needsReview ? ' (flagged for review)' : '') . '.',
            'data'   => ['order_id' => $orderId, 'from' => $from, 'ignored' => $newStatus],
        ]);
    }

    $derived = payDerivePayable($db, (string) $attempt['payable_type'], (int) $attempt['payable_id'], $actor);

    if ($allowed) {
        $sentence = $facts['detail'] ?? ("Status of {$orderId} changed from {$from} to {$newStatus}" . (isset($facts['via']) ? " ({$facts['via']})" : '') . '.');
        payAudit($db, 'status_changed', $ctx + [
            'detail' => $sentence,
            'data'   => [
                'order_id' => $orderId, 'from' => $from, 'to' => $newStatus,
                'payable_from' => $derived['from'], 'payable_to' => $derived['to'],
                'verification' => $verification !== '' ? $verification : null,
            ],
        ]);
    }

    return [
        'changed'       => $allowed,
        'from'          => $from,
        'to'            => $allowed ? $newStatus : $from,
        'payableFrom'   => $derived['from'],
        'payableTo'     => $derived['to'],
        'firstSuccess'  => $derived['firstSuccess'],
        'receiptNumber' => $derived['receipt_number'],
        'doublePayment' => $doublePayment,
    ];
}

/**
 * True when an online seva booking's 'cancelled' status came from its payment
 * hold expiring (§9.1) rather than from the office: the newest of its
 * hold_expired / booking_restored audit rows is hold_expired. After a restore,
 * a cancellation is the office's decision and is never undone by the module.
 */
function payBookingCancelledByHold(PDO $db, int $bookingId): bool
{
    $stmt = $db->prepare(
        "SELECT event FROM payment_audit_log
          WHERE payable_type = 'seva_booking' AND payable_id = :id AND event IN ('hold_expired', 'booking_restored')
          ORDER BY id DESC LIMIT 1"
    );
    $stmt->execute([':id' => $bookingId]);
    return $stmt->fetchColumn() === 'hold_expired';
}

/**
 * The attempt a payable's receipt was (or is about to be) issued for, from its
 * attempt rows (each with id and status, oldest first): the SUCCESS attempt the
 * receipt_assigned audit row names — the one that was SUCCESS when the receipt
 * was assigned, which is not always the lowest attempt number (a declined
 * attempt 1 that CCAvenue later reports paid comes after the retry that paid) —
 * else the earliest SUCCESS attempt. Null when none is SUCCESS.
 */
function payReceiptAttemptOf(PDO $db, string $type, int $id, array $attempts): ?array
{
    $successes = array_values(array_filter($attempts, static fn(array $a): bool => ($a['status'] ?? '') === 'SUCCESS'));
    if (!$successes) return null;
    if (count($successes) > 1) {
        $stmt = $db->prepare(
            "SELECT transaction_id FROM payment_audit_log
              WHERE payable_type = :t AND payable_id = :id AND event = 'receipt_assigned' AND transaction_id IS NOT NULL
              ORDER BY id ASC LIMIT 1"
        );
        $stmt->execute([':t' => $type, ':id' => $id]);
        $named = (int) $stmt->fetchColumn();
        foreach ($successes as $a) {
            if ((int) $a['id'] === $named) return $a;
        }
    }
    return $successes[0];
}

/**
 * SQL derived table (payable_type, payable_id, receipt_id) naming each paid
 * payable's receipt attempt, the same way payReceiptAttemptOf() does: the
 * receipt_assigned audit row's transaction, else the lowest SUCCESS attempt id
 * (ids grow with the attempt number).
 */
function payReceiptAttemptSql(): string
{
    return "(SELECT s.payable_type, s.payable_id,
                    COALESCE((SELECT a.transaction_id FROM payment_audit_log a
                               WHERE a.payable_type = s.payable_type AND a.payable_id = s.payable_id
                                 AND a.event = 'receipt_assigned' AND a.transaction_id IS NOT NULL
                               ORDER BY a.id ASC LIMIT 1), MIN(s.id)) AS receipt_id
               FROM payment_transactions s WHERE s.status = 'SUCCESS'
              GROUP BY s.payable_type, s.payable_id)";
}

/**
 * Re-derive a payable's status and refunded amount from its attempts and refunds
 * (§2.4, §8), locking the payable row. On the first SUCCESS: receipt number and
 * paid_at (TEST and SIMULATOR attempts draw from their own receipt sequences,
 * §1). An online seva booking cancelled only because its hold expired is
 * restored to 'pending' when payment arrives. Inside a transaction.
 *
 * Refunds move the payable only when they are against the receipt attempt —
 * the first SUCCESS attempt, the one the receipt was issued for. A duplicate
 * SUCCESS attempt (a donor who paid twice, §2.4) is refunded against itself:
 * that refund gives back the extra money, the receipt's money is still there,
 * so the payable's status and amount_refunded are untouched by it.
 *
 * @return array{from:?string, to:?string, changed:bool, firstSuccess:bool, receipt_number:?string}
 */
function payDerivePayable(PDO $db, string $type, int $id, string $actor): array
{
    if (!$db->inTransaction()) throw new LogicException('payDerivePayable() must run inside a transaction.');
    $table = payTableFor($type);
    $statusCol = $type === 'donation' ? 'status' : 'payment_status';
    $extra = $type === 'seva_booking' ? ', status AS booking_status' : '';
    $stmt = $db->prepare("SELECT id, {$statusCol} AS pay_status, receipt_number, amount, amount_refunded{$extra} FROM {$table} WHERE id = :id FOR UPDATE");
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return ['from' => null, 'to' => null, 'changed' => false, 'firstSuccess' => false, 'receipt_number' => null];

    $stmt = $db->prepare('SELECT id, status, environment FROM payment_transactions WHERE payable_type = :t AND payable_id = :id ORDER BY attempt ASC');
    $stmt->execute([':t' => $type, ':id' => $id]);
    $attempts = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $receiptAttempt = payReceiptAttemptOf($db, $type, $id, $attempts); // the attempt the receipt is (or will be) issued for
    $latestStatus = $attempts ? (string) $attempts[count($attempts) - 1]['status'] : null;

    $refundedCents = 0;
    $openRefund = false;
    if ($receiptAttempt !== null) {
        $stmt = $db->prepare('SELECT status, amount FROM payment_refunds WHERE transaction_id = :id');
        $stmt->execute([':id' => (int) $receiptAttempt['id']]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            if ($r['status'] === 'SUCCESS') $refundedCents += payAmountCents((string) $r['amount']);
            if ($r['status'] === 'REQUESTED' || $r['status'] === 'PROCESSING') $openRefund = true;
        }
    }

    $from = $row['pay_status'];
    if ($receiptAttempt !== null) {
        $paidCents = payAmountCents((string) $row['amount']);
        $to = match (true) {
            $openRefund                                        => 'REFUND_INITIATED',
            $refundedCents > 0 && $refundedCents >= $paidCents => 'REFUNDED',
            $refundedCents > 0                                 => 'PARTIALLY_REFUNDED',
            default                                            => 'SUCCESS',
        };
    } else {
        $to = $latestStatus ?? ($from ?? 'INITIATED');
    }

    $set = [];
    $params = [':id' => $id];
    if ($to !== $from) {
        $set[] = "{$statusCol} = :s";
        $params[':s'] = $to;
    }
    if (payAmountCents((string) $row['amount_refunded']) !== $refundedCents) {
        $set[] = 'amount_refunded = :r';
        $params[':r'] = payCentsToAmount($refundedCents);
    }
    $firstSuccess = $receiptAttempt !== null && $row['receipt_number'] === null;
    $receipt = $row['receipt_number'];
    if ($firstSuccess) {
        $receipt = payNextReceiptNumber($db, payConfig()['receipt_prefix'], null, (string) $receiptAttempt['environment']);
        $set[] = 'receipt_number = :rn';
        $set[] = 'paid_at = UTC_TIMESTAMP()';
        $params[':rn'] = $receipt;
    }
    $restore = false;
    if ($type === 'seva_booking' && $receiptAttempt !== null && ($row['booking_status'] ?? '') === 'cancelled' && payBookingCancelledByHold($db, $id)) {
        $restore = true;
        $set[] = "status = 'pending'";
    }
    if ($set) {
        $set[] = 'updated_at = UTC_TIMESTAMP()';
        $db->prepare("UPDATE {$table} SET " . implode(', ', $set) . ' WHERE id = :id')->execute($params);
    }

    $ctx = ['payable_type' => $type, 'payable_id' => $id, 'actor' => $actor];
    if ($firstSuccess) {
        // Named with its attempt: this row is how the receipt attempt is told apart from a later duplicate SUCCESS.
        payAudit($db, 'receipt_assigned', $ctx + [
            'transaction_id' => (int) $receiptAttempt['id'],
            'detail'         => "Receipt {$receipt} assigned.",
            'data'           => ['receipt_number' => $receipt, 'order_id' => null],
        ]);
    }
    if ($restore) {
        payAudit($db, 'booking_restored', $ctx + [
            'detail' => 'The booking had been cancelled when its payment hold expired; payment arrived, so it is pending again.',
        ]);
    }
    // A donation made for a pooja becomes its sponsor record on the first
    // SUCCESS — here, in the transaction that assigned the receipt, so the two
    // can never disagree — and is marked REFUNDED when the money all goes back.
    if ($type === 'donation' && $firstSuccess) {
        paySponsorAssign($db, $id, (string) $receipt, (int) $receiptAttempt['id'], $actor);
    }
    if ($type === 'donation' && $to === 'REFUNDED' && $to !== $from) {
        paySponsorRefunded($db, $id, $actor);
    }
    return ['from' => $from, 'to' => $to, 'changed' => $to !== $from, 'firstSuccess' => $firstSuccess, 'receipt_number' => $receipt];
}

/* ── Sponsor records from paid pooja donations (brief §13, migration 023) ── */

/** True once migration 023 has linked sponsors to donations and payment attempts. */
function paySponsorLinksReady(): bool
{
    return payPoojaLinksReady() && publicGuardHasColumn('sponsors', 'donation_id') && publicGuardHasColumn('sponsors', 'transaction_id');
}

/**
 * The sponsor row a paid donation created — id, name, pooja_id, amount,
 * payment_status, payment_ref, transaction_id, donation_id, publish_consent,
 * is_active — or null. $lock takes the row lock (inside a transaction).
 */
function paySponsorForDonation(PDO $db, int $donationId, bool $lock = false): ?array
{
    if ($donationId <= 0 || !paySponsorLinksReady()) return null;
    $stmt = $db->prepare(
        'SELECT id, name, pooja_id, amount, payment_status, payment_ref, transaction_id, donation_id, publish_consent, is_active
           FROM sponsors WHERE donation_id = :d' . ($lock ? ' FOR UPDATE' : '')
    );
    $stmt->execute([':d' => $donationId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    foreach (['id', 'pooja_id', 'transaction_id', 'donation_id'] as $k) $row[$k] = $row[$k] !== null ? (int) $row[$k] : null;
    $row['amount'] = $row['amount'] !== null ? payAmountFormat((string) $row['amount'], 'INR') : null;
    $row['publish_consent'] = (int) $row['publish_consent'] === 1;
    $row['is_active'] = (int) $row['is_active'] === 1;
    return $row;
}

/**
 * The one sponsor row for a donation made for a pooja, written on the
 * donation's first SUCCESS inside the transaction that assigned its receipt.
 * Keyed on donations.id: a replayed callback, a duplicate DEN notification or
 * a re-run sweep never reaches a first SUCCESS twice (the receipt is already
 * assigned), an existing row is only brought up to date, and the UNIQUE key on
 * sponsors.donation_id is the last guard. A donation without a pooja, or whose
 * pooja has since been deleted, creates nothing. Never throws: a sponsor row
 * that cannot be written is logged and audited, and the payment stays paid.
 *
 * Fields: name, phone (dialable, +CC…), email from the donation; pooja_id;
 * amount when the donation is in rupees (a foreign amount goes in the note);
 * payment_status PAID; payment_ref = the receipt number; transaction_id,
 * donation_id; publish_consent = the donor's thank-you-list consent; active;
 * no family name; note "Online donation <number>".
 */
function paySponsorAssign(PDO $db, int $donationId, string $receipt, int $transactionId, string $actor): ?int
{
    if (!paySponsorLinksReady()) return null;
    $ctx = ['payable_type' => 'donation', 'payable_id' => $donationId, 'transaction_id' => $transactionId, 'actor' => $actor];
    try {
        $stmt = $db->prepare(
            'SELECT d.donation_number, d.name, d.phone, d.phone_country, d.email, d.amount, d.currency, d.show_name_publicly, d.pooja_id, d.lang,
                    p.name_en AS pooja_en, p.pooja_date
               FROM donations d JOIN poojas p ON p.id = d.pooja_id
              WHERE d.id = :id'
        );
        $stmt->execute([':id' => $donationId]);
        $d = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$d) return null; // a general donation, or the pooja is gone (FK set the link to NULL)

        $ref = mb_substr($receipt, 0, 100);
        $existing = paySponsorForDonation($db, $donationId, true);
        if ($existing !== null) {
            $db->prepare("UPDATE sponsors SET payment_status = 'PAID', payment_ref = :ref, transaction_id = :t WHERE id = :id")
               ->execute([':ref' => $ref, ':t' => $transactionId, ':id' => $existing['id']]);
            payAudit($db, 'sponsor_assigned', $ctx + [
                'detail' => "Sponsor #{$existing['id']} already exists for {$d['donation_number']}; no second sponsorship was created.",
                'data'   => ['sponsor_id' => $existing['id'], 'pooja_id' => (int) $d['pooja_id'], 'receipt_number' => $receipt, 'duplicate' => true],
            ]);
            return $existing['id'];
        }

        $inr = strtoupper((string) $d['currency']) === 'INR';
        $money = payMoneyLabel((string) $d['amount'], (string) $d['currency']);
        $consent = (int) $d['show_name_publicly'] === 1 ? 1 : 0;
        $db->prepare(
            "INSERT INTO sponsors
                (name, family_name, phone, email, note, pooja_id, event_id, amount, payment_ref, payment_status,
                 transaction_id, donation_id, publish_consent, is_active, created_at)
             VALUES (:name, NULL, :phone, :email, :note, :pooja, NULL, :amount, :ref, 'PAID', :t, :d, :consent, 1, NOW())"
        )->execute([
            ':name'    => mb_substr((string) $d['name'], 0, 200),
            ':phone'   => mb_substr('+' . devoteeIntlPhone((string) $d['phone'], $d['phone_country']), 0, 30),
            ':email'   => $d['email'] !== null && $d['email'] !== '' ? mb_substr((string) $d['email'], 0, 190) : null,
            ':note'    => "Online donation {$d['donation_number']}" . ($inr ? '' : " ({$money})"),
            ':pooja'   => (int) $d['pooja_id'],
            ':amount'  => $inr ? payAmountFormat((string) $d['amount'], 'INR') : null,
            ':ref'     => $ref,
            ':t'       => $transactionId,
            ':d'       => $donationId,
            ':consent' => $consent,
        ]);
        $sponsorId = (int) $db->lastInsertId();
        payAudit($db, 'sponsor_assigned', $ctx + [
            'detail' => "Sponsor #{$sponsorId} recorded for {$d['pooja_en']} ({$d['pooja_date']}) from {$d['donation_number']}, receipt {$receipt}, {$money}"
                . ($consent ? ', may be named on the website.' : ', not to be named on the website.'),
            'data'   => ['sponsor_id' => $sponsorId, 'pooja_id' => (int) $d['pooja_id'], 'receipt_number' => $receipt, 'publish_consent' => $consent === 1],
        ]);
        // Brief §20: the sponsor's confirmation, in the donor's language, on
        // this transaction's connection so it commits with the sponsorship.
        // Its dedupe key (sponsor:{id}:confirmed) makes a replay a no-op.
        require_once __DIR__ . '/../sponsor_notify.php';
        sponsorNotifyConfirmed($sponsorId, (string) ($d['lang'] ?? 'ta'), $db);
        return $sponsorId;
    } catch (Throwable $e) {
        error_log("[payments] sponsor for donation {$donationId} could not be recorded: " . get_class($e) . ': ' . $e->getMessage());
        payAudit($db, 'sponsor_assigned', $ctx + [
            'detail' => 'The sponsor record for this pooja donation could not be written; add it by hand in Admin → Sponsors.',
            'data'   => ['error' => get_class($e)],
        ]);
        return null;
    }
}

/**
 * When a pooja donation is refunded in full, its sponsor is marked REFUNDED —
 * never deleted: whether the pooja still goes ahead is the office's call, and
 * the row keeps the donor's details for that conversation. Never throws.
 */
function paySponsorRefunded(PDO $db, int $donationId, string $actor): void
{
    if (!paySponsorLinksReady()) return;
    try {
        $stmt = $db->prepare("UPDATE sponsors SET payment_status = 'REFUNDED' WHERE donation_id = :d AND payment_status = 'PAID'");
        $stmt->execute([':d' => $donationId]);
        if ($stmt->rowCount() === 0) return;
        $sponsor = paySponsorForDonation($db, $donationId);
        payAudit($db, 'sponsor_refunded', [
            'payable_type' => 'donation',
            'payable_id'   => $donationId,
            'actor'        => $actor,
            'detail'       => 'Sponsor #' . (int) ($sponsor['id'] ?? 0) . ' marked REFUNDED: the donation was refunded in full. The record is kept for the office.',
            'data'         => ['sponsor_id' => $sponsor['id'] ?? null],
        ]);
    } catch (Throwable $e) {
        error_log("[payments] sponsor for donation {$donationId} could not be marked refunded: " . get_class($e) . ': ' . $e->getMessage());
    }
}
