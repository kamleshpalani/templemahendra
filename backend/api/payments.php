<?php
/**
 * backend/api/payments.php — the public payments API (docs/payments/SPEC.md §5.5).
 *
 * api/index.php routes /api/payments/<route> here with $payRoute set; hit
 * directly (production serves existing files under /api) it answers 404. This
 * file only reads the request, calls the library and answers.
 *
 *   GET  config              what the Donate page needs; never credentials
 *   POST donations           create an online donation → checkout form
 *   POST seva-bookings       create an online seva booking → checkout form
 *   POST retry               a new attempt for a failed/cancelled payment
 *   GET  status, receipt     a donor's own payment (number + access token)
 *   POST receipt-email       email the receipt to the donor
 *   GET  verify              the receipt QR check (masked)
 *   POST ccavenue/response   CCAvenue browser return  → 303 /payment/result
 *   POST ccavenue/cancel     CCAvenue browser cancel  → 303 /payment/result
 *   POST ccavenue/notify     CCAvenue server notification → 200 text "OK"
 *   POST simulator, simulator/api   the local simulator (PAYMENTS_ALLOW_SIMULATOR=1 only)
 */

require_once __DIR__ . '/../includes/payments.php';

ini_set('display_errors', '0');
ini_set('log_errors', '1');

$payRouteName = isset($payRoute) && is_string($payRoute) ? $payRoute : '';
$payMethod = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

if ($payRouteName === '') {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"Not found"}';
    exit;
}

// ── Gateway returns: never JSON, never an error page ────────────────────────
if (in_array($payRouteName, ['ccavenue/response', 'ccavenue/cancel', 'ccavenue/notify'], true)) {
    $channel = substr($payRouteName, strlen('ccavenue/'));
    if ($payMethod !== 'POST') {
        // A donor refreshing the return URL, or a link checker: back to the donations page.
        payRedirect303('/donations');
    }
    try {
        $length = isset($_SERVER['CONTENT_LENGTH']) && ctype_digit((string) $_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : null;
        $result = payHandleGatewayResponse($channel, $_POST, $length);
    } catch (Throwable $e) {
        error_log('[payments] gateway return failed outside the handler: ' . $e->getMessage());
        $result = ['status' => 'unknown', 'number' => null, 'token' => null, 'state' => 'unknown', 'http' => 500];
    }
    if ($channel === 'notify') payRespondNotify($result);
    payRespondBrowser($result);
}

// ── Simulator ───────────────────────────────────────────────────────────────
if ($payRouteName === 'simulator' || $payRouteName === 'simulator/api') {
    try {
        if (!paySimulatorEnabled()) paySimulatorNotFound();
        if ($payMethod !== 'POST') {
            http_response_code(405);
            header('Allow: POST');
            header('Content-Type: text/plain; charset=utf-8');
            header('Cache-Control: no-store');
            echo 'Method not allowed';
            exit;
        }
        if ($payRouteName === 'simulator') paySimulatorCheckout($_POST);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
        echo paySimulatorApiRespond($_POST);
        exit;
    } catch (Throwable $e) {
        error_log('[payments] simulator failed: ' . get_class($e) . ': ' . $e->getMessage());
        http_response_code(500);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Simulator error';
        exit;
    }
}

// ── JSON routes ─────────────────────────────────────────────────────────────
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');

/** 405 unless the request uses $allowed. */
function payApiMethod(string $method, string $allowed): void
{
    if ($method === $allowed || ($allowed === 'GET' && $method === 'HEAD')) return;
    header('Allow: ' . $allowed);
    sendError('Method not allowed', 405);
}

/** The 404 every lookup answers for a bad number, a bad token or an unknown payable alike. */
function payApiNotFound(): never
{
    sendJson(['error' => 'Not found', 'code' => 'not_found'], 404);
}

/** 503 when payments cannot take money. */
function payApiRequireReady(): void
{
    if (!payReady()['ok']) {
        sendJson(['error' => 'Online payments are not available right now. Please try again later, or use the bank transfer details.', 'code' => 'payments_unavailable'], 503);
    }
}

/** A payable from ?ref=&t= (or body ref/t) after the token check, or the 404. */
function payApiGuardedPayable(PDO $db, mixed $ref, mixed $token): array
{
    if (!is_string($ref) || !payTablesExist()) payApiNotFound();
    $parsed = payParseNumber($ref);
    if ($parsed === null || $parsed['number'] !== $ref || !payAccessTokenValid($ref, $token)) payApiNotFound();
    $payable = payLoadPayable($db, $ref);
    if ($payable === null) payApiNotFound();
    return $payable;
}

/** The 201 body after creating a payable or an attempt: the checkout form to post. */
function payApiCheckoutAnswer(PDO $db, array $payable, array $attempt, array $cfg, string $actor): never
{
    $checkout = ccavCheckoutFields($attempt, $payable, payEnvConfig($cfg, (string) $attempt['environment']));
    $db->prepare('UPDATE payment_transactions SET redirected_at = UTC_TIMESTAMP(), updated_at = UTC_TIMESTAMP() WHERE id = :id')
       ->execute([':id' => $attempt['id']]);
    payAudit($db, 'redirect_issued', payAuditCtx($attempt, [
        'actor'  => $actor,
        'detail' => "Checkout form for {$attempt['order_id']} issued (" . strtoupper((string) $attempt['environment']) . ').',
        'data'   => ['order_id' => $attempt['order_id'], 'environment' => $attempt['environment']],
    ]));
    sendJson([
        'success'   => true,
        'number'    => $payable['number'],
        'token'     => payAccessToken($payable['number']),
        'gateway'   => ['url' => $checkout['url'], 'fields' => $checkout['fields']],
        'simulator' => $attempt['environment'] === 'simulator',
    ], 201);
}

try {
    switch ($payRouteName) {
        case 'config':
            payApiMethod($payMethod, 'GET');
            sendJson(payPublicConfig());

        case 'donations':
        case 'seva-bookings':
            payApiMethod($payMethod, 'POST');
            publicGuardLimit('payment-attempt');
            $body = getJsonBody();
            publicGuardHoneypotOrContinue($body);
            payApiRequireReady();
            $cfg = payConfig();
            $isDonation = $payRouteName === 'donations';
            $checked = $isDonation ? payValidateDonation($body, $cfg) : payValidateSevaBooking($body, $cfg);
            if ($checked['fields']) {
                sendJson(['error' => 'Please check the highlighted fields.', 'fields' => $checked['fields']], 422);
            }
            publicGuardLimit('payment-created');
            $db = getDB();
            $created = $isDonation
                ? payCreateDonation($db, $checked['values'], $cfg, clientIp())
                : payCreateSevaBooking($db, $checked['values'], $cfg, clientIp());
            payApiCheckoutAnswer($db, $created['payable'], $created['attempt'], $cfg, 'donor');

        case 'retry':
            payApiMethod($payMethod, 'POST');
            publicGuardLimit('payment-attempt');
            $body = getJsonBody();
            publicGuardHoneypotOrContinue($body);
            $number = $body['number'] ?? null;
            $parsed = is_string($number) ? payParseNumber($number) : null;
            if ($parsed === null || $parsed['number'] !== $number || !payTablesExist() || !payAccessTokenValid($number, $body['token'] ?? null)) {
                sendJson(['error' => 'This payment link is not valid.', 'code' => 'bad_token'], 403);
            }
            payApiRequireReady();
            $cfg = payConfig();
            $db = getDB();
            $payable = payLoadPayable($db, $number);
            if ($payable === null) payApiNotFound();
            $sevaOff = $payable['type'] === 'seva_booking' && !$cfg['seva_online'];
            if ($sevaOff || !payCanRetry($payable)) {
                sendJson(['error' => 'This payment cannot be tried again.', 'code' => 'not_retryable', 'status' => $payable['status']], 409);
            }
            publicGuardLimit('payment-retry');
            $ip = clientIp();
            $attempt = payTransaction($db, function (PDO $db) use ($payable, $cfg, $ip): ?array {
                $locked = payLoadPayableById($db, $payable['type'], $payable['id'], true);
                if ($locked === null || !payCanRetry($locked)) return null;
                try {
                    $attempt = payCreateAttempt($db, $locked['type'], $locked, $cfg['mode'], $locked['lang'], $ip);
                } catch (PayLimitException) {
                    return null;
                }
                payAudit($db, 'retry_requested', payAuditCtx($attempt, [
                    'actor'  => 'donor',
                    'ip'     => $ip,
                    'detail' => "The donor asked to try {$locked['number']} again (attempt {$attempt['attempt']}).",
                    'data'   => ['order_id' => $attempt['order_id'], 'previous_status' => $locked['status']],
                ]));
                return $attempt;
            });
            if ($attempt === null) {
                $now = payLoadPayable($db, $number);
                sendJson(['error' => 'This payment cannot be tried again.', 'code' => 'not_retryable', 'status' => $now['status'] ?? $payable['status']], 409);
            }
            payApiCheckoutAnswer($db, payLoadPayable($db, $number), $attempt, $cfg, 'donor');

        case 'status':
        case 'receipt':
            payApiMethod($payMethod, 'GET');
            publicGuardLimit('payment-lookup');
            $db = getDB();
            $payable = payApiGuardedPayable($db, $_GET['ref'] ?? null, $_GET['t'] ?? null);
            $isReceipt = $payRouteName === 'receipt';
            if ($isReceipt && !in_array($payable['status'], PAY_PAID_STATUSES, true)) payApiNotFound();
            sendJson(payPublicView($db, $payable, $isReceipt));

        case 'receipt-email':
            payApiMethod($payMethod, 'POST');
            publicGuardLimit('payment-receipt-email');
            $body = getJsonBody();
            publicGuardHoneypotOrContinue($body);
            $db = getDB();
            $payable = payApiGuardedPayable($db, $body['ref'] ?? null, $body['t'] ?? null);
            if (!in_array($payable['status'], PAY_PAID_STATUSES, true)) payApiNotFound();
            if (!payConfig()['notify_email']) {
                sendJson(['error' => 'Email receipts are not available right now.', 'code' => 'email_off'], 409);
            }
            if (trim((string) ($payable['email'] ?? '')) === '') {
                [$email, $problem] = payEmailCheck($body);
                if ($email === null) {
                    sendJson(['error' => 'Please check the highlighted fields.', 'fields' => ['email' => $problem !== '' ? $problem : 'Enter the email address to send the receipt to.']], 422);
                }
                $table = payTableFor($payable['type']);
                $db->prepare("UPDATE {$table} SET email = :e, updated_at = UTC_TIMESTAMP() WHERE id = :id")->execute([':e' => $email, ':id' => $payable['id']]);
                $payable = payLoadPayableById($db, $payable['type'], $payable['id']);
            }
            $sent = payNotifyReceiptResend($db, $payable, 'donor', ['email']);
            if (!$sent['ok']) {
                sendJson(['error' => 'The receipt could not be sent right now. Please try again later.', 'code' => 'receipt_failed'], 503);
            }
            sendJson(['success' => true, 'email' => payMaskEmail($payable['email'])], 202);

        case 'verify':
            payApiMethod($payMethod, 'GET');
            publicGuardLimit('payment-lookup');
            if (!payTablesExist()) sendJson(['valid' => false]);
            sendJson(payVerifyLookup(getDB(), $_GET['r'] ?? null, $_GET['v'] ?? null));

        default:
            sendError('Not found', 404);
    }
} catch (LiveDonationUnavailable $e) {
    sendJson(['error' => 'This broadcast is not accepting donations.', 'fields' => ['stream' => 'Unavailable']], 422);
} catch (LiveDonationsNotReady $e) {
    sendJson(['error' => 'Stream donations are unavailable.', 'code' => 'unavailable'], 503);
} catch (Throwable $e) {
    $ref = strtoupper(bin2hex(random_bytes(4)));
    error_log(sprintf('[payments %s] %s %s: %s: %s in %s:%d', $ref, $payMethod, $payRouteName, get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    sendJson(['error' => 'The server could not complete that request. Please try again.', 'reference' => $ref], 500);
}
