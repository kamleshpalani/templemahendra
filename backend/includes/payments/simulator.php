<?php
/**
 * backend/includes/payments/simulator.php — a stand-in for CCAvenue for local
 * development and automated tests only (docs/payments/SPEC.md §4.7).
 *
 * It exists only when PAYMENTS_ALLOW_SIMULATOR=1 and the mode is SIMULATOR;
 * otherwise its routes answer 404. It speaks exactly the same wire format as
 * CCAvenue (encrypted request in, encrypted response out, the same server API),
 * with its own public, fake credentials: merchant 9999999, access code
 * SIMULATORACCESS, working key PAYMENTS_SIMULATOR_KEY or a fixed dev value.
 *
 * The checkout page shows one form per outcome. Each form carries a response
 * already encrypted for that outcome; pressing it posts back here, which
 * records the outcome (payment_counters "sim:<order id>", so the status API
 * answers consistently) and 307-redirects the same POST body to the return URL.
 */

/** Button → recorded outcome: 1 success, 2 failure, 3 aborted, 4 awaited, 5 success with a tampered amount, 6 success in the wrong currency. */
const PAY_SIM_OUTCOMES = ['upi' => 1, 'card' => 1, 'decline' => 2, 'cancel' => 3, 'awaited' => 4, 'tamper' => 5, 'currency' => 6];

/** True when the simulator routes may answer. */
function paySimulatorEnabled(): bool
{
    if (!payTablesExist()) return false;
    $cfg = payConfig();
    return $cfg['simulator_allowed'] && $cfg['mode'] === 'simulator';
}

/** 404 JSON, as if the route did not exist. */
function paySimulatorNotFound(): never
{
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo '{"error":"Not found"}';
    exit;
}

/** A tampered amount the simulator reports: one unit less (or more, for amounts of 1 or less). */
function paySimTamperAmount(string $amount): string
{
    $cents = payAmountCents($amount);
    return payCentsToAmount($cents > 100 ? $cents - 100 : $cents + 100);
}

/** The signature that ties a simulator button to its order and response. */
function paySimSignature(string $action, string $orderId, string $encResp): string
{
    $key = (string) payConfig()['env']['simulator']['working_key'];
    return hash_hmac('sha256', $action . '|' . $orderId . '|' . hash('sha256', $encResp), 'sim-button:' . $key);
}

/** The response fields CCAvenue would send for $action, from the decrypted request. */
function paySimulatorResponseFields(array $req, string $action): array
{
    $amount = (string) ($req['amount'] ?? '0.00');
    $currency = strtoupper((string) ($req['currency'] ?? 'INR'));
    $status = match ($action) {
        'decline' => 'Failure',
        'cancel'  => 'Aborted',
        'awaited' => 'Awaited',
        default   => 'Success',
    };
    $paid = in_array($action, ['upi', 'card', 'tamper', 'currency'], true);
    return [
        'order_id'        => (string) ($req['order_id'] ?? ''),
        'tracking_id'     => (string) random_int(100000000000, 999999999999),
        'bank_ref_no'     => $action === 'cancel' ? '' : 'SIM' . random_int(1000000000, 9999999999),
        'order_status'    => $status,
        'failure_message' => $action === 'decline' ? 'Simulated decline by the bank' : '',
        'payment_mode'    => match ($action) { 'upi' => 'UPI', 'cancel' => '', 'awaited' => 'Net Banking', default => 'Credit Card' },
        'card_name'       => match ($action) { 'upi' => 'UPI', 'cancel' => '', 'awaited' => 'Simulated Bank', default => 'Visa' },
        'status_code'     => $paid ? '0' : ($action === 'decline' ? '1' : ''),
        'status_message'  => match ($action) {
            'decline' => 'Declined (simulated)',
            'cancel'  => 'Cancelled by the customer (simulated)',
            'awaited' => 'Awaiting the bank (simulated)',
            default   => 'Approved (simulated)',
        },
        'currency'        => $action === 'currency' ? ($currency === 'INR' ? 'USD' : 'INR') : $currency,
        'amount'          => $action === 'tamper' ? paySimTamperAmount($amount) : $amount,
        'billing_name'    => (string) ($req['billing_name'] ?? ''),
        'billing_country' => (string) ($req['billing_country'] ?? ''),
        'billing_tel'     => (string) ($req['billing_tel'] ?? ''),
        'billing_email'   => (string) ($req['billing_email'] ?? ''),
        'merchant_param1' => (string) ($req['merchant_param1'] ?? ''),
        'merchant_param2' => (string) ($req['merchant_param2'] ?? ''),
        'merchant_param3' => (string) ($req['merchant_param3'] ?? ''),
        'retry'           => 'N',
        'response_code'   => $paid ? '0' : '',
        'trans_date'      => payIstDate(null, 'd/m/Y H:i:s'),
        'mer_amount'      => $amount,
        'bin_country'     => 'INDIA',
        'eci_value'       => '',
    ];
}

/**
 * POST /api/payments/simulator — the "checkout URL". Decrypts encRequest,
 * checks the access code and renders the outcome buttons; a button press (a
 * post with sim_action) records the outcome and 307-redirects to the return URL.
 */
function paySimulatorCheckout(array $post): never
{
    if (!paySimulatorEnabled()) paySimulatorNotFound();
    $cfg = payConfig();
    if (isset($post['sim_action'])) paySimulatorAct($post, $cfg);

    $access = is_string($post['access_code'] ?? null) ? $post['access_code'] : '';
    $enc = is_string($post['encRequest'] ?? null) ? $post['encRequest'] : '';
    if ($access === '' || !hash_equals(PAY_SIMULATOR_ACCESS_CODE, $access)) {
        paySimulatorPage(403, 'Merchant authentication failed (10002): the access code is not the simulator\'s.', null, $cfg);
    }
    $plain = ccavDecrypt($enc, (string) $cfg['env']['simulator']['working_key']);
    if ($plain === null) {
        paySimulatorPage(400, 'Invalid request (10001): encRequest could not be decrypted with the simulator key.', null, $cfg);
    }
    $req = ccavParseResponse($plain);
    $orderId = trim((string) ($req['order_id'] ?? ''));
    $errors = [];
    if (($req['merchant_id'] ?? '') !== PAY_SIMULATOR_MERCHANT_ID) $errors[] = 'merchant_id is not the simulator merchant (10002).';
    if (payParseNumber($orderId) === null) $errors[] = 'order_id is missing or not an order this site issues (31001).';
    if (!preg_match('/^\d{1,10}\.\d{2}$/D', (string) ($req['amount'] ?? ''))) $errors[] = 'amount is not a two-decimal number (31003).';
    if (!preg_match('/^[A-Z]{3}$/D', (string) ($req['currency'] ?? ''))) $errors[] = 'currency is not a three-letter code (31002).';
    if (($req['redirect_url'] ?? '') === '' || ($req['cancel_url'] ?? '') === '') $errors[] = 'redirect_url or cancel_url is missing.';
    if (!$errors) {
        $s = getDB()->prepare("SELECT id FROM payment_transactions WHERE order_id = :o AND environment = 'simulator'");
        $s->execute([':o' => $orderId]);
        if ($s->fetchColumn() === false) $errors[] = 'This site has no simulator attempt with that order_id.';
    }
    if ($errors) paySimulatorPage(400, implode(' ', $errors), null, $cfg);
    paySimulatorPage(200, '', $req, $cfg);
}

/** A button press: verify it, record the outcome, 307 to the return URL with the same body. */
function paySimulatorAct(array $post, array $cfg): never
{
    $action = is_string($post['sim_action'] ?? null) ? $post['sim_action'] : '';
    $orderId = is_string($post['sim_order'] ?? null) ? $post['sim_order'] : '';
    $sig = is_string($post['sim_sig'] ?? null) ? $post['sim_sig'] : '';
    $enc = is_string($post['encResp'] ?? null) ? $post['encResp'] : '';
    if (!isset(PAY_SIM_OUTCOMES[$action]) || payParseNumber($orderId) === null || $enc === '') {
        paySimulatorPage(400, 'That simulator button is not valid.', null, $cfg);
    }
    if ($sig === '' || !hash_equals(paySimSignature($action, $orderId, $enc), $sig)) {
        paySimulatorPage(403, 'That simulator button was not issued by this simulator.', null, $cfg);
    }
    getDB()->prepare(
        'INSERT INTO payment_counters (name, value, updated_at) VALUES (:n, :v, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)'
    )->execute([':n' => 'sim:' . $orderId, ':v' => PAY_SIM_OUTCOMES[$action]]);

    $target = $action === 'cancel' ? $cfg['cancel_url'] : $cfg['redirect_url'];
    http_response_code(307);
    header('Location: ' . $target);
    header('Cache-Control: no-store, private');
    header('X-Robots-Tag: noindex, nofollow');
    header('Content-Type: text/plain; charset=utf-8');
    echo "Temporary Redirect\n";
    exit;
}

/** The simulator's self-contained HTML page: an error, or the order and its outcome buttons. */
function paySimulatorPage(int $status, string $error, ?array $req, array $cfg): never
{
    $h = static fn(string $v): string => htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $origins = ["'self'"];
    foreach ([$cfg['redirect_url'], $cfg['cancel_url'], $cfg['env']['simulator']['transaction_url']] as $u) {
        $p = parse_url((string) $u);
        if (!empty($p['scheme']) && !empty($p['host'])) {
            $o = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
            if (!in_array($o, $origins, true)) $origins[] = $o;
        }
    }
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('X-Robots-Tag: noindex, nofollow');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action " . implode(' ', $origins) . "; base-uri 'none'; frame-ancestors 'none'");

    $buttons = [
        'upi'      => ['Pay (UPI)', 'ok'],
        'card'     => ['Pay (Credit Card)', 'ok'],
        'decline'  => ['Decline', 'bad'],
        'cancel'   => ['Cancel', 'plain'],
        'awaited'  => ['Awaited', 'plain'],
        'tamper'   => ['Tamper amount', 'warn'],
        'currency' => ['Wrong currency', 'warn'],
    ];
    $action = (string) $cfg['env']['simulator']['transaction_url'];
    $key = (string) $cfg['env']['simulator']['working_key'];
    ?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CCAvenue simulator — test payments only</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: #f4f4f5; color: #18181b; font: 16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #d4d4d8; border-radius: 12px; overflow: hidden; }
  .banner { background: #b91c1c; color: #fff; font-weight: 700; padding: 12px 20px; letter-spacing: .02em; }
  .content { padding: 20px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0 0 20px; }
  dt { color: #52525b; }
  dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
  .error { background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; padding: 12px; border-radius: 8px; }
  .buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  form { margin: 0; }
  button { width: 100%; min-height: 48px; border: 0; border-radius: 8px; font: inherit; font-weight: 700; cursor: pointer; color: #fff; background: #3f3f46; }
  button.ok { background: #15803d; } button.bad { background: #b91c1c; } button.warn { background: #b45309; }
  button:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
  .note { color: #52525b; font-size: 14px; margin-top: 16px; }
</style>
</head>
<body>
<main>
  <div class="banner" role="note">SIMULATOR — no real money</div>
  <div class="content">
    <h1>CCAvenue simulator — test payments only</h1>
<?php if ($error !== '' || $req === null): ?>
    <p class="error" role="alert"><?= $h($error !== '' ? $error : 'Nothing to show.') ?></p>
<?php else: ?>
    <dl>
      <dt>Merchant ID</dt><dd><?= $h((string) ($req['merchant_id'] ?? '')) ?></dd>
      <dt>Order ID</dt><dd><?= $h((string) ($req['order_id'] ?? '')) ?></dd>
      <dt>Amount</dt><dd><?= $h((string) ($req['amount'] ?? '')) ?></dd>
      <dt>Currency</dt><dd><?= $h((string) ($req['currency'] ?? '')) ?></dd>
      <dt>Billing name</dt><dd><?= $h((string) ($req['billing_name'] ?? '')) ?></dd>
    </dl>
    <div class="buttons">
<?php foreach ($buttons as $name => [$label, $tone]):
        $plain = [];
        foreach (paySimulatorResponseFields($req, $name) as $k => $v) $plain[] = $k . '=' . $v;
        $enc = ccavEncrypt(implode('&', $plain), $key);
        $orderId = (string) $req['order_id']; ?>
      <form method="post" action="<?= $h($action) ?>">
        <input type="hidden" name="sim_action" value="<?= $h($name) ?>">
        <input type="hidden" name="sim_order" value="<?= $h($orderId) ?>">
        <input type="hidden" name="sim_sig" value="<?= $h(paySimSignature($name, $orderId, $enc)) ?>">
        <input type="hidden" name="encResp" value="<?= $h($enc) ?>">
        <button type="submit" class="<?= $h($tone) ?>" data-sim="<?= $h($name) ?>"><?= $h($label) ?></button>
      </form>
<?php endforeach; ?>
    </div>
    <p class="note">Each button sends CCAvenue's encrypted response for that outcome back to the site. Cancel goes to the cancel URL.</p>
<?php endif; ?>
  </div>
</main>
</body>
</html>
<?php
    exit;
}

/**
 * The simulator's server API, as a response body string
 * ("status=0&enc_response=…&enc_error_code="). Called in-process by ccavApi()
 * and over HTTP by POST /api/payments/simulator/api. Implements
 * orderStatusTracker (from the recorded outcome; no outcome → Initiated;
 * unknown order → 51419) and refundOrder (accepted when the amount is within
 * paid − refunded; an amount ending in .13 is refused with "Simulated refusal").
 */
function paySimulatorApiRespond(array $post): string
{
    $key = (string) payConfig()['env']['simulator']['working_key'];
    $access = is_string($post['access_code'] ?? null) ? $post['access_code'] : '';
    if ($access === '' || !hash_equals(PAY_SIMULATOR_ACCESS_CODE, $access)) {
        return 'status=1&enc_response=' . rawurlencode('Access_code: Invalid Parameter') . '&enc_error_code=51407';
    }
    $plain = ccavDecrypt(is_string($post['enc_request'] ?? null) ? $post['enc_request'] : '', $key);
    $payload = $plain !== null ? json_decode($plain, true) : null;
    if (!is_array($payload)) {
        return 'status=1&enc_response=' . rawurlencode('Invalid Request') . '&enc_error_code=-1';
    }
    $command = is_string($post['command'] ?? null) ? $post['command'] : '';
    $db = getDB();

    if ($command === 'orderStatusTracker') {
        $orderNo = trim((string) ($payload['order_no'] ?? ''));
        $ref = trim((string) ($payload['reference_no'] ?? ''));
        $row = null;
        if (payParseNumber($orderNo) !== null) {
            $s = $db->prepare("SELECT * FROM payment_transactions WHERE order_id = :o AND environment = 'simulator'");
            $s->execute([':o' => $orderNo]);
            $row = $s->fetch(PDO::FETCH_ASSOC) ?: null;
        } elseif ($ref !== '') {
            $s = $db->prepare("SELECT * FROM payment_transactions WHERE tracking_id = :t AND environment = 'simulator'");
            $s->execute([':t' => $ref]);
            $row = $s->fetch(PDO::FETCH_ASSOC) ?: null;
        }
        if ($row === null) {
            $answer = ['status' => 1, 'error_code' => '51419', 'error_desc' => 'No records found'];
        } else {
            $c = $db->prepare('SELECT value FROM payment_counters WHERE name = :n');
            $c->execute([':n' => 'sim:' . $row['order_id']]);
            $outcome = (int) $c->fetchColumn();
            $amount = payAmountFormat((string) $row['amount'], 'INR');
            $currency = (string) $row['currency'];
            if ($outcome === 5) $amount = paySimTamperAmount($amount);
            if ($outcome === 6) $currency = $currency === 'INR' ? 'USD' : 'INR';
            $answer = [
                'status'                 => 0,
                'error_code'             => '',
                'error_desc'             => '',
                'order_no'               => (string) $row['order_id'],
                'reference_no'           => (string) ($row['tracking_id'] ?? $ref),
                'order_status'           => match ($outcome) { 1, 5, 6 => 'Successful', 2 => 'Unsuccessful', 3 => 'Aborted', 4 => 'Awaited', default => 'Initiated' },
                'order_amt'              => payAmountCents($amount) / 100,
                'order_currncy'          => $currency,
                'order_bank_ref_no'      => (string) ($row['bank_ref_no'] ?? ''),
                'order_status_date_time' => payIstDate(null, 'Y-m-d H:i:s.000'),
            ];
        }
    } elseif ($command === 'refundOrder') {
        $ref = trim((string) ($payload['reference_no'] ?? ''));
        $amount = payAmountParse(is_string($payload['refund_amount'] ?? null) ? trim($payload['refund_amount']) : ($payload['refund_amount'] ?? null));
        $refundRef = trim((string) ($payload['refund_ref_no'] ?? ''));
        $s = $db->prepare("SELECT * FROM payment_transactions WHERE tracking_id = :t AND environment = 'simulator' AND status = 'SUCCESS'");
        $s->execute([':t' => $ref]);
        $row = $ref !== '' ? ($s->fetch(PDO::FETCH_ASSOC) ?: null) : null;
        if ($row === null) {
            $result = ['refund_status' => 1, 'reason' => 'No such paid order', 'error_code' => '51419'];
        } elseif ($amount === null || payAmountCents($amount) <= 0) {
            $result = ['refund_status' => 1, 'reason' => 'Invalid refund amount', 'error_code' => '51015'];
        } elseif (str_ends_with($amount, '.13')) {
            $result = ['refund_status' => 1, 'reason' => 'Simulated refusal', 'error_code' => ''];
        } else {
            $sum = $db->prepare(
                "SELECT COALESCE(SUM(amount), 0) FROM payment_refunds
                  WHERE transaction_id = :id AND status IN ('REQUESTED','PROCESSING','SUCCESS') AND refund_reference <> :r"
            );
            $sum->execute([':id' => (int) $row['id'], ':r' => $refundRef]);
            $left = payAmountCents((string) $row['amount']) - payAmountCents((string) $sum->fetchColumn());
            $result = payAmountCents($amount) <= $left
                ? ['refund_status' => 0, 'reason' => '', 'error_code' => '']
                : ['refund_status' => 1, 'reason' => 'Refund amount exceeds the refundable amount', 'error_code' => '52020'];
        }
        $answer = ['Refund_Order_Result' => $result];
    } else {
        return 'status=1&enc_response=' . rawurlencode('Command: Invalid Parameter') . '&enc_error_code=51410';
    }
    $json = (string) json_encode($answer, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    return 'status=0&enc_response=' . ccavEncrypt($json, $key) . '&enc_error_code=';
}
