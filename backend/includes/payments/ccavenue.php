<?php
/**
 * backend/includes/payments/ccavenue.php — the CCAvenue wire format
 * (docs/payments/SPEC.md §4.3–4.5; research-ccavenue.md §2–§5).
 *
 *   crypto      AES-128-CBC, key = md5(working key) raw, IV 00..0f, hex text
 *   checkout    key=value pairs joined with & (not URL-encoded), encrypted, and
 *               posted by the browser with the public access_code
 *   responses   encResp decrypted to key=value pairs
 *   server API  enc_request / enc_response over form posts, JSON inside
 *
 * The working key and access code never leave PHP except the access_code form
 * field, which CCAvenue designed to be public.
 */

const CCAV_IV_HEX = '000102030405060708090a0b0c0d0e0f';

/** Response keys kept in payment_transactions.gateway_response (SPEC §4.4 step 7). */
const CCAV_RESPONSE_KEYS = [
    'order_id', 'tracking_id', 'bank_ref_no', 'order_status', 'failure_message', 'payment_mode', 'card_name',
    'status_code', 'status_message', 'currency', 'amount', 'mer_amount', 'trans_date', 'bin_country', 'eci_value',
    'retry', 'response_code', 'merchant_param1', 'merchant_param2', 'merchant_param3',
];

/** Status API error codes that mean "CCAvenue has no such order". */
const CCAV_NO_RECORD_CODES = ['51419', '51308', '51313'];

/** Hex ciphertext of $plain under a CCAvenue working key. */
function ccavEncrypt(string $plain, string $workingKey): string
{
    $out = openssl_encrypt($plain, 'aes-128-cbc', md5($workingKey, true), OPENSSL_RAW_DATA, hex2bin(CCAV_IV_HEX));
    if ($out === false) throw new RuntimeException('The payment request could not be encrypted.');
    return bin2hex($out);
}

/**
 * The plain text of hex ciphertext, or null when it is empty, not hex, of odd
 * length, longer than 200 000 characters, does not decrypt under this key, or is
 * not valid UTF-8. Upper and lower case hex are both accepted.
 */
function ccavDecrypt(string $hex, string $workingKey): ?string
{
    $hex = trim($hex);
    $len = strlen($hex);
    if ($len === 0 || $len > 200000 || $len % 2 !== 0 || !ctype_xdigit($hex)) return null;
    $bin = hex2bin($hex);
    if ($bin === false || strlen($bin) % 16 !== 0) return null;
    $out = @openssl_decrypt($bin, 'aes-128-cbc', md5($workingKey, true), OPENSSL_RAW_DATA, hex2bin(CCAV_IV_HEX));
    if ($out === false) {
        while (openssl_error_string() !== false) {
            // drain openssl's error queue so the next call starts clean
        }
        return null;
    }
    return mb_check_encoding($out, 'UTF-8') ? $out : null;
}

/**
 * A decrypted response as key => value. Pairs split on &, each on its first =;
 * keys trimmed; a value is URL-decoded only when it contains %XX (whether
 * CCAvenue encodes values is unconfirmed — SPEC §14 item 6). Last duplicate
 * wins. At most 300 pairs are read.
 */
function ccavParseResponse(string $plain): array
{
    $out = [];
    foreach (array_slice(explode('&', $plain), 0, 300) as $pair) {
        if ($pair === '') continue;
        $p = strpos($pair, '=');
        $key = trim($p === false ? $pair : substr($pair, 0, $p));
        $value = $p === false ? '' : substr($pair, $p + 1);
        if ($key === '') continue;
        if (preg_match('/%[0-9A-Fa-f]{2}/', $value)) $value = urldecode($value);
        $out[$key] = $value;
    }
    return $out;
}

/** Only the allow-listed response keys, each cut to 255 characters, for storage. */
function ccavResponseAllowList(array $fields): array
{
    $out = [];
    foreach (CCAV_RESPONSE_KEYS as $k) {
        if (array_key_exists($k, $fields)) $out[$k] = mb_substr(mb_scrub((string) $fields[$k], 'UTF-8'), 0, 255);
    }
    return $out;
}

/** Attempt status for a redirect / cancel / notify order_status (SPEC §2.3). */
function ccavMapRedirectStatus(?string $orderStatus): string
{
    $s = trim((string) $orderStatus);
    if ($s === 'Success') return 'SUCCESS';
    return match (strtolower($s)) {
        'failure', 'invalid', 'timeout' => 'FAILED',
        'aborted'                       => 'CANCELLED',
        default                         => 'PENDING',
    };
}

/**
 * Attempt status for a status-API order_status (SPEC §2.3), or null for
 * Refunded / System refund / Chargeback, which leave the attempt as it is and
 * flag it for reconciliation. An unknown value is PENDING.
 */
function ccavMapApiStatus(?string $orderStatus): ?string
{
    $s = trim((string) $orderStatus);
    if ($s === 'Successful' || $s === 'Shipped') return 'SUCCESS';
    return match (strtolower($s)) {
        'unsuccessful', 'invalid', 'fraud', 'auto-cancelled', 'auto-reversed', 'cancelled' => 'FAILED',
        'aborted'                                                                         => 'CANCELLED',
        'initiated', 'awaited'                                                            => 'PENDING',
        'refunded', 'system refund', 'chargeback'                                         => null,
        default                                                                           => 'PENDING',
    };
}

/**
 * A value made safe for the unencoded checkout payload: removes & = ' " < > \,
 * control and format characters, emoji (everything outside the Basic
 * Multilingual Plane, plus the BMP symbol and dingbat blocks and variation
 * selectors), collapses whitespace, trims and cuts to $max characters.
 *
 * $allowedPattern, when given, is the body of a regex character class of the
 * only characters to keep, e.g. '0-9' or 'A-Za-z0-9@._+\-'. Tamil letters are
 * kept by default (whether CCAvenue accepts them is SPEC §14 item 10).
 */
function ccavClean(string $v, int $max, string $allowedPattern = ''): string
{
    $v = mb_scrub($v, 'UTF-8');
    $v = preg_replace('/\p{Cc}+/u', ' ', $v) ?? '';
    $v = preg_replace('/[&=\'"<>\\\\]|[\x{10000}-\x{10FFFF}]|[\p{Cf}\p{Co}\p{Cn}\p{Cs}]|[\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{FE00}-\x{FE0F}\x{20E3}]/u', '', $v) ?? '';
    if ($allowedPattern !== '') {
        $v = preg_replace('/[^' . $allowedPattern . ']+/u', '', $v) ?? '';
    }
    $v = trim(preg_replace('/\s+/u', ' ', $v) ?? '');
    return trim(mb_substr($v, 0, max(0, $max)));
}

/** The full English country name for an ISO-2 code ("India" when unknown), for billing_country. */
function ccavCountryName(?string $iso2): string
{
    $iso2 = strtoupper(trim((string) $iso2));
    return payCountryTable()[$iso2][0] ?? 'India';
}

/** An environment block from either a payEnvConfig() block or the full payConfig(). */
function ccavEnv(array $cfg, ?string $environment = null): array
{
    if (isset($cfg['environment'], $cfg['working_key']) && ($environment === null || $cfg['environment'] === $environment)) {
        return $cfg;
    }
    if (!isset($cfg['env'])) $cfg = payConfig();
    return payEnvConfig($cfg, $environment);
}

/**
 * The browser form for one attempt: the environment's checkout URL and the two
 * fields to post, encRequest and access_code. $txn is the attempt row, $payable
 * the payLoadPayable() shape, $cfg payConfig() or the attempt environment's
 * payEnvConfig() block. The amount and currency come from the stored attempt.
 *
 * @return array{url:string, fields:array{encRequest:string, access_code:string}}
 */
function ccavCheckoutFields(array $txn, array $payable, array $cfg): array
{
    $env = ccavEnv($cfg, (string) $txn['environment']);
    $isDonation = ($payable['type'] ?? '') === 'donation';
    $address = $payable['address'] ?? [];
    $email = trim((string) ($payable['email'] ?? ''));
    $pairs = [
        'merchant_id'      => ccavClean((string) $env['merchant_id'], 20, '0-9'),
        'order_id'         => (string) $txn['order_id'],
        'currency'         => strtoupper((string) $txn['currency']),
        'amount'           => payAmountFormat((string) $txn['amount'], (string) $txn['currency']),
        'redirect_url'     => (string) $env['redirect_url'],
        'cancel_url'       => (string) $env['cancel_url'],
        'language'         => 'EN',
        'billing_name'     => ccavClean((string) ($payable['name'] ?? ''), 60),
        'billing_address'  => $isDonation ? ccavClean((string) ($address['line'] ?? ''), 150) : '',
        'billing_city'     => $isDonation ? ccavClean((string) ($address['city'] ?? ''), 30) : '',
        'billing_state'    => $isDonation ? ccavClean((string) ($address['state'] ?? ''), 30) : '',
        'billing_zip'      => $isDonation ? ccavClean((string) ($address['postcode'] ?? ''), 15, 'A-Za-z0-9 \-') : '',
        // A seva booking records no billing country; the phone's country is the best evidence.
        'billing_country'  => ccavCountryName($isDonation ? ($payable['country'] ?? null) : ($payable['phone_country'] ?? null)),
        'billing_tel'      => substr(preg_replace('/\D+/', '', (string) ($payable['phone'] ?? '')) ?? '', 0, 20),
        'billing_email'    => $email !== '' ? ccavClean($email, 70, 'A-Za-z0-9@._+\-') : '',
        'merchant_param1'  => (string) $payable['type'],
        'merchant_param2'  => (string) $payable['number'],
        'merchant_param3'  => (string) (int) $txn['attempt'],
    ];
    $plain = [];
    foreach ($pairs as $k => $v) $plain[] = $k . '=' . $v;
    return [
        'url'    => (string) $env['transaction_url'],
        'fields' => [
            'encRequest'  => ccavEncrypt(implode('&', $plain), (string) $env['working_key']),
            'access_code' => (string) $env['access_code'],
        ],
    ];
}

/** True when server-to-server API credentials are available for an environment. */
function ccavApiConfigured(string $environment): bool
{
    if (!payTablesExist()) return false;
    $cfg = payConfig();
    if ($environment === 'simulator') return $cfg['simulator_allowed'];
    if (!isset($cfg['env'][$environment])) return false;
    $env = $cfg['env'][$environment];
    return $env['api_access_code'] !== '' && $env['api_working_key'] !== '' && function_exists('curl_init');
}

/** Parse a form-encoded response body into key => value (URL-decoded). */
function ccavParseForm(string $body): array
{
    $out = [];
    foreach (array_slice(explode('&', trim($body)), 0, 50) as $pair) {
        if ($pair === '') continue;
        $p = strpos($pair, '=');
        $key = trim(urldecode($p === false ? $pair : substr($pair, 0, $p)));
        if ($key === '') continue;
        $out[$key] = $p === false ? '' : urldecode(substr($pair, $p + 1));
    }
    return $out;
}

/**
 * One server-to-server API call. $cfg is payEnvConfig() for the environment
 * (or payConfig() for the current mode); $cfg['timeout'] overrides the 15 s
 * default. Simulator calls are answered in-process (the PHP built-in server
 * cannot call itself over HTTP), through exactly the same encryption and parsing.
 * Never throws.
 *
 * @return array{ok:bool, data:?array, error:string, error_code:string, http:int}
 *   error: '' | not_configured | unreachable | http_error | bad_response |
 *   undecryptable | bad_json | the gateway's own message. data is the decrypted
 *   JSON (one wrapper key such as Order_Status_Result removed) whenever it could
 *   be read, even when it reports an error.
 */
function ccavApi(string $command, array $payload, array $cfg): array
{
    $result = ['ok' => false, 'data' => null, 'error' => '', 'error_code' => '', 'http' => 0];
    try {
        $env = ccavEnv($cfg);
        $timeout = max(1, (int) ($cfg['timeout'] ?? $env['timeout'] ?? 15));
        if (($env['api_access_code'] ?? '') === '' || ($env['api_working_key'] ?? '') === '') {
            $result['error'] = 'not_configured';
            return $result;
        }
        $fields = [
            'enc_request'   => ccavEncrypt((string) json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), $env['api_working_key']),
            'access_code'   => $env['api_access_code'],
            'command'       => $command,
            'request_type'  => 'JSON',
            'response_type' => 'JSON',
            'version'       => '1.2',
        ];
        if ($env['environment'] === 'simulator') {
            $status = 200;
            $body = paySimulatorApiRespond($fields);
        } else {
            $r = notifyHttp('POST', (string) $env['api_url'], ['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => '*/*'], $fields, $timeout);
            $status = (int) $r['status'];
            $body = (string) $r['body'];
        }
        $result['http'] = $status;
        if ($status === 0 || $status === 429 || $status >= 500) {
            $result['error'] = 'unreachable';
            return $result;
        }
        if ($status >= 400) {
            $result['error'] = 'http_error';
            return $result;
        }

        $q = ccavParseForm($body);
        $outer = trim((string) ($q['status'] ?? ''));
        if ($outer === '1') {
            $result['error'] = mb_substr(trim((string) ($q['enc_response'] ?? '')), 0, 255) ?: 'refused';
            $result['error_code'] = mb_substr(trim((string) ($q['enc_error_code'] ?? '')), 0, 20);
            return $result;
        }
        if ($outer !== '0') {
            $result['error'] = 'bad_response';
            return $result;
        }
        $plain = ccavDecrypt(trim((string) ($q['enc_response'] ?? ''), " \r\n"), $env['api_working_key']);
        if ($plain === null) {
            $result['error'] = 'undecryptable';
            return $result;
        }
        $data = json_decode($plain, true);
        if (!is_array($data)) {
            $result['error'] = 'bad_json';
            return $result;
        }
        if (count($data) === 1) {
            $only = array_key_first($data);
            if (in_array($only, ['Order_Status_Result', 'Refund_Order_Result', 'Order_Result'], true) && is_array($data[$only])) {
                $data = $data[$only];
            }
        }
        $result['data'] = $data;
        $innerStatus = isset($data['status']) ? trim((string) $data['status']) : '0';
        $innerCode = isset($data['error_code']) ? trim((string) $data['error_code']) : '';
        if ($innerStatus === '1' || $innerCode !== '') {
            $result['error'] = mb_substr(trim((string) ($data['error_desc'] ?? $data['reason'] ?? 'error')), 0, 255) ?: 'error';
            $result['error_code'] = mb_substr($innerCode, 0, 20);
            return $result;
        }
        $result['ok'] = true;
        return $result;
    } catch (Throwable $e) {
        error_log('[payments] CCAvenue API call ' . $command . ' failed: ' . get_class($e) . ': ' . $e->getMessage());
        $result['error'] = 'unreachable';
        return $result;
    }
}

/**
 * orderStatusTracker for one attempt.
 *
 * @return array{ok:bool, status:?string, amount:?string, currency:?string, tracking_id:?string,
 *               bank_ref_no:?string, raw:?array, error:string, error_code:string, http:int}
 *   ok is true only when CCAvenue answered with an order. A "no record" answer
 *   is ok=false with error_code 51419/51308/51313 (CCAV_NO_RECORD_CODES).
 */
function ccavOrderStatus(?string $trackingId, string $orderId, array $cfg): array
{
    $payload = [];
    if ($trackingId !== null && trim($trackingId) !== '') $payload['reference_no'] = trim($trackingId);
    $payload['order_no'] = $orderId;
    $r = ccavApi('orderStatusTracker', $payload, $cfg);
    $d = $r['data'];
    $amount = null;
    if (is_array($d) && array_key_exists('order_amt', $d)) {
        $amount = payAmountParse(is_string($d['order_amt']) ? trim($d['order_amt']) : $d['order_amt']);
    }
    $currency = is_array($d) ? ($d['order_curr'] ?? $d['order_currncy'] ?? $d['order_currency'] ?? null) : null;
    return [
        'ok'          => $r['ok'] && is_array($d) && isset($d['order_status']),
        'status'      => is_array($d) && isset($d['order_status']) ? mb_substr(trim((string) $d['order_status']), 0, 40) : null,
        'amount'      => $amount,
        'currency'    => $currency !== null ? strtoupper(trim((string) $currency)) : null,
        'tracking_id' => is_array($d) && isset($d['reference_no']) ? mb_substr(trim((string) $d['reference_no']), 0, 40) : null,
        'bank_ref_no' => is_array($d) && isset($d['order_bank_ref_no']) ? mb_substr(trim((string) $d['order_bank_ref_no']), 0, 100) : null,
        'raw'         => is_array($d) ? payRedact($d) : null,
        'error'       => $r['ok'] && !(is_array($d) && isset($d['order_status'])) ? 'bad_response' : $r['error'],
        'error_code'  => $r['error_code'],
        'http'        => $r['http'],
    ];
}

/**
 * refundOrder. ok=false means CCAvenue could not be asked (callers change
 * nothing and may try again with the same refund reference); ok=true with
 * accepted=false is a refusal, with CCAvenue's reason.
 *
 * @return array{ok:bool, accepted:bool, reason:string, error_code:string, error:string}
 */
function ccavRefund(string $trackingId, string $amount, string $refundRef, array $cfg): array
{
    $r = ccavApi('refundOrder', ['reference_no' => $trackingId, 'refund_amount' => $amount, 'refund_ref_no' => $refundRef], $cfg);
    $out = ['ok' => false, 'accepted' => false, 'reason' => '', 'error_code' => $r['error_code'], 'error' => $r['error']];
    if ($r['ok'] || $r['data'] !== null) {
        $d = $r['data'] ?? [];
        $out['ok'] = true;
        $out['accepted'] = $r['ok'] && trim((string) ($d['refund_status'] ?? '1')) === '0';
        $out['reason'] = $out['accepted'] ? '' : (mb_substr(trim((string) ($d['reason'] ?? $d['error_desc'] ?? $r['error'])), 0, 255) ?: 'Refused by CCAvenue');
        $out['error_code'] = trim((string) ($d['error_code'] ?? $r['error_code']));
        return $out;
    }
    if ($r['error_code'] !== '' && !in_array($r['error'], ['unreachable', 'http_error', 'bad_response', 'undecryptable', 'bad_json', 'not_configured'], true)) {
        // status=1: CCAvenue answered and refused the call itself.
        $out['ok'] = true;
        $out['reason'] = ccavErrorMessage($r['error_code'], $r['error']);
    }
    return $out;
}

/** A committee-readable sentence for an API error code. */
function ccavErrorMessage(string $code, string $fallback = ''): string
{
    return match ($code) {
        '51407'                   => 'CCAvenue refused the API call — ask CCAvenue to whitelist this server\'s public IP.',
        '-1'                      => 'CCAvenue could not read the request — the working key does not match.',
        '51419', '51308', '51313' => 'CCAvenue has no record of this order.',
        '52018'                   => 'CCAvenue does not allow a refund for this order.',
        '52019'                   => 'CCAvenue does not allow more than one refund for this order.',
        '52020'                   => 'The refund is more than CCAvenue allows for this order.',
        '52021'                   => 'The order is disputed at CCAvenue.',
        '52022'                   => 'The refund period for this order has passed.',
        default                   => $fallback !== '' ? $fallback : 'CCAvenue refused the request' . ($code !== '' ? " (code {$code})" : '') . '.',
    };
}
