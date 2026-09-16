<?php
/**
 * backend/includes/payments/response.php — what CCAvenue sends back
 * (docs/payments/SPEC.md §4.4).
 *
 * Three routes share one handler: the browser return (redirect_url), the
 * browser cancel (cancel_url) and the server notification (DEN). None needs a
 * session or CSRF token — they are cross-site posts — and none trusts anything
 * but a response that decrypts under a configured key, names an order we issued,
 * matches its stored amount and currency, and (when the status API is
 * configured) is confirmed by CCAvenue server to server. The row lock plus the
 * transition table make every repeat harmless.
 */

const PAY_RESPONSE_MAX_BYTES = 65536;

/** Environments whose keys may decrypt a response: the current mode first, then the others that have a key. */
function payResponseEnvironments(array $cfg): array
{
    $order = [$cfg['mode']];
    foreach (['test', 'production', 'simulator'] as $e) {
        if (!in_array($e, $order, true)) $order[] = $e;
    }
    return array_values(array_filter($order, static function (string $e) use ($cfg): bool {
        if ($e === 'simulator' && !$cfg['simulator_allowed']) return false;
        return ($cfg['env'][$e]['working_key'] ?? '') !== '';
    }));
}

/**
 * Handle one gateway response. $channel is response | cancel | notify; $post is
 * $_POST; $bodyBytes the request's Content-Length when known. Never throws.
 *
 * @return array{status:string, number:?string, token:?string, state:?string, http:int}
 *   status  the attempt's status afterwards, or 'unknown'
 *   state   'unknown' | 'cancelled' when there is no payable to show, else null
 *   http    for the notify channel: 200, 400 (undecryptable), 413, 500, 503
 */
function payHandleGatewayResponse(string $channel, array $post, ?int $bodyBytes = null): array
{
    $result = ['status' => 'unknown', 'number' => null, 'token' => null, 'state' => 'unknown', 'http' => 200];
    if (!in_array($channel, ['response', 'cancel', 'notify'], true)) {
        $result['http'] = 404;
        return $result;
    }
    $db = null;
    $orderId = null;
    try {
        if (!payTablesExist()) {
            $result['http'] = 503;
            return $result;
        }
        $db = getDB();
        $ip = clientIp();
        $enc = $post['encResp'] ?? null;
        $length = is_string($enc) ? strlen($enc) : 0;

        if (($bodyBytes !== null && $bodyBytes > PAY_RESPONSE_MAX_BYTES) || $length > PAY_RESPONSE_MAX_BYTES) {
            payAudit($db, 'response_undecryptable', [
                'actor'  => 'gateway',
                'ip'     => $ip,
                'detail' => "A {$channel} response was refused because it is larger than 64 KB.",
                'data'   => ['channel' => $channel, 'length' => max($length, (int) $bodyBytes), 'reason' => 'too_large'],
            ]);
            $result['http'] = 413;
            return $result;
        }
        if (!is_string($enc) || trim($enc) === '') {
            if ($channel === 'cancel') {
                // Nothing names an order: show "cancelled"; the cron closes the INITIATED attempt later.
                $result['status'] = 'CANCELLED';
                $result['state'] = 'cancelled';
                return $result;
            }
            payAudit($db, 'response_undecryptable', [
                'actor'  => 'gateway',
                'ip'     => $ip,
                'detail' => "A {$channel} response arrived without encResp.",
                'data'   => ['channel' => $channel, 'length' => 0, 'reason' => 'missing'],
            ]);
            $result['http'] = 400;
            return $result;
        }

        $cfg = payConfig();
        $decoded = null;
        foreach (payResponseEnvironments($cfg) as $environment) {
            $plain = ccavDecrypt($enc, (string) $cfg['env'][$environment]['working_key']);
            if ($plain === null) continue;
            $fields = ccavParseResponse($plain);
            if (!isset($fields['order_id'])) continue;
            $decoded = ['environment' => $environment, 'fields' => $fields];
            break;
        }
        if ($decoded === null) {
            payAudit($db, 'response_undecryptable', [
                'actor'  => 'gateway',
                'ip'     => $ip,
                'detail' => "A {$channel} response could not be decrypted with any configured key.",
                'data'   => ['channel' => $channel, 'length' => $length],
            ]);
            $result['http'] = 400;
            return $result;
        }

        $orderId = trim((string) $decoded['fields']['order_id']);
        if (payParseNumber($orderId) === null) {
            payAudit($db, 'response_unknown_order', [
                'actor'  => 'gateway',
                'ip'     => $ip,
                'detail' => "A {$channel} response named an order this site never issued.",
                'data'   => ['order_id' => mb_substr($orderId, 0, 30), 'channel' => $channel],
            ]);
            return $result;
        }

        $outcome = payTransaction($db, static fn(PDO $db): array => payApplyGatewayResponse(
            $db, $channel, $enc, $decoded['environment'], $decoded['fields'], $orderId, $cfg, $ip
        ));
        if ($outcome['unknown']) {
            // Nothing to show the browser (state=unknown); the notify channel answers what the handler decided.
            $result['http'] = (int) ($outcome['http'] ?? $result['http']);
            return $result;
        }

        $number = (string) $outcome['number'];
        $applied = $outcome['applied'];
        $attemptNow = payLoadAttempt($db, (int) $outcome['attempt']['id']);
        if ($applied !== null) {
            $payable = payLoadPayableById($db, (string) $outcome['attempt']['payable_type'], (int) $outcome['attempt']['payable_id']);
            if ($payable !== null && $applied['firstSuccess']) payNotifySuccess($db, $payable);
            if ($payable !== null && $applied['changed'] && $applied['to'] === 'FAILED' && $attemptNow !== null) {
                payNotifyFailed($db, $payable, $attemptNow);
            }
        }
        return [
            'status' => (string) ($attemptNow['status'] ?? $outcome['attempt']['status']),
            'number' => $number,
            'token'  => payAccessToken($number),
            'state'  => null,
            'http'   => 200,
        ];
    } catch (Throwable $e) {
        $ref = strtoupper(bin2hex(random_bytes(4)));
        error_log(sprintf('[payments %s] %s response failed: %s: %s in %s:%d', $ref, $channel, get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
        if ($db !== null) {
            payAudit($db, 'response_error', [
                'actor'  => 'gateway',
                'detail' => "A {$channel} response could not be processed (reference {$ref}). Nothing was changed.",
                'data'   => ['channel' => $channel, 'reference' => $ref, 'order_id' => $orderId !== null ? mb_substr($orderId, 0, 30) : null],
            ]);
        }
        return ['status' => 'unknown', 'number' => null, 'token' => null, 'state' => 'unknown', 'http' => 500];
    }
}

/**
 * The part of response handling that runs inside the transaction, on the locked
 * attempt: environment check, validation, optional status-API confirmation
 * (before commit, 12-second budget) and payStateApply().
 *
 * @return array{unknown:bool, http?:int, attempt?:array, number?:string, applied?:?array}
 *   unknown  true when there is nothing to show the donor: the order is not ours,
 *            or the response was not encrypted with the attempt's own key (then
 *            http 400 for the notify channel, like any undecryptable response)
 */
function payApplyGatewayResponse(PDO $db, string $channel, string $enc, string $decryptedWith, array $fields, string $orderId, array $cfg, string $ip): array
{
    $attempt = payLoadAttemptForUpdate($db, $orderId);
    if ($attempt === null) {
        payAudit($db, 'response_unknown_order', [
            'actor'  => 'gateway',
            'ip'     => $ip,
            'detail' => "A {$channel} response named an order this site does not have.",
            'data'   => ['order_id' => mb_substr($orderId, 0, 30), 'channel' => $channel],
        ]);
        return ['unknown' => true];
    }
    $number = payParseNumber($orderId)['number'];
    $ctx = payAuditCtx($attempt, ['actor' => 'gateway', 'ip' => $ip]);

    // The key that decrypted it must belong to the attempt's own environment.
    if ($decryptedWith !== $attempt['environment']) {
        $key = (string) ($cfg['env'][$attempt['environment']]['working_key'] ?? '');
        $again = $key !== '' ? ccavDecrypt($enc, $key) : null;
        $againFields = $again !== null ? ccavParseResponse($again) : [];
        if (trim((string) ($againFields['order_id'] ?? '')) === $orderId) {
            $fields = $againFields;
        } else {
            $db->prepare('UPDATE payment_transactions SET needs_review = 1, updated_at = UTC_TIMESTAMP() WHERE id = :id')->execute([':id' => $attempt['id']]);
            payAudit($db, 'response_wrong_environment', $ctx + [
                'detail' => "A {$channel} response for {$orderId} was encrypted with the " . strtoupper($decryptedWith) . ' key, but the attempt was made in '
                    . strtoupper((string) $attempt['environment']) . ' mode. Nothing was changed.',
                'data'   => ['order_id' => $orderId, 'channel' => $channel, 'key_environment' => $decryptedWith, 'attempt_environment' => $attempt['environment']],
            ]);
            // Under the wrong key this is not a response for that attempt at all (§4.4 step 5):
            // treated as undecryptable — no number, no access token, notify gets a 400.
            return ['unknown' => true, 'http' => 400];
        }
    }

    $gatewayStatus = mb_substr(trim((string) ($fields['order_status'] ?? '')), 0, 40);
    $mapped = ccavMapRedirectStatus($gatewayStatus);
    payAudit($db, 'response_received', $ctx + [
        'detail' => "CCAvenue {$channel} response for {$orderId}: " . ($gatewayStatus !== '' ? $gatewayStatus : 'no status') . '.',
        'data'   => ['order_id' => $orderId, 'channel' => $channel, 'order_status' => $gatewayStatus, 'fields' => count($fields)],
    ]);

    // Does it describe the order we stored?
    $mismatch = [];
    $receivedCurrency = strtoupper(trim((string) ($fields['currency'] ?? '')));
    if ($receivedCurrency !== '' || $mapped === 'SUCCESS') {
        if ($receivedCurrency !== strtoupper((string) $attempt['currency'])) {
            $mismatch['currency'] = ['expected' => $attempt['currency'], 'received' => mb_substr($receivedCurrency, 0, 10)];
        }
    }
    $receivedAmount = trim((string) ($fields['amount'] ?? ''));
    if ($receivedAmount !== '' || $mapped === 'SUCCESS') {
        $parsed = payAmountParse($receivedAmount);
        if ($parsed === null || payAmountCents($parsed) !== payAmountCents($attempt['amount'])) {
            $m = ['expected' => $attempt['amount'], 'received' => mb_substr($receivedAmount, 0, 20)];
            $mer = payAmountParse(trim((string) ($fields['mer_amount'] ?? '')));
            if ($mer !== null && payAmountCents($mer) === payAmountCents($attempt['amount'])) $m['mer_amount_matches'] = true;
            $mismatch['amount'] = $m;
        }
    }
    $param2 = trim((string) ($fields['merchant_param2'] ?? ''));
    if ($param2 !== '' && $param2 !== $number) {
        $mismatch['merchant_param2'] = ['expected' => $number, 'received' => mb_substr($param2, 0, 30)];
    }

    $text = static fn(string $k): ?string => isset($fields[$k]) && trim((string) $fields[$k]) !== '' ? trim((string) $fields[$k]) : null;
    $facts = [
        'responded'        => true,
        'channel'          => $channel,
        'gateway_status'   => $gatewayStatus,
        'bank_ref_no'      => $text('bank_ref_no'),
        'payment_mode'     => $text('payment_mode'),
        'card_name'        => $text('card_name'),
        'failure_message'  => $text('failure_message'),
        'status_code'      => $text('status_code'),
        'status_message'   => $text('status_message'),
        'gateway_response' => ccavResponseAllowList($fields),
        'verification'     => 'callback',
    ];

    $trackingId = mb_substr(trim((string) ($fields['tracking_id'] ?? '')), 0, 40);
    if ($trackingId !== '') {
        $conflictWith = null;
        if ($attempt['tracking_id'] !== null && $attempt['tracking_id'] !== $trackingId) {
            $conflictWith = 'this attempt';
        } elseif ($attempt['tracking_id'] === null) {
            $s = $db->prepare('SELECT order_id FROM payment_transactions WHERE tracking_id = :t AND id <> :id');
            $s->execute([':t' => $trackingId, ':id' => $attempt['id']]);
            $other = $s->fetchColumn();
            if ($other !== false) {
                $conflictWith = (string) $other;
            } else {
                $facts['tracking_id'] = $trackingId;
            }
        }
        if ($conflictWith !== null) {
            $facts['needs_review'] = true;
            payAudit($db, 'tracking_conflict', $ctx + [
                'detail' => "CCAvenue reference {$trackingId} for {$orderId} conflicts with the reference already recorded on {$conflictWith}.",
                'data'   => ['order_id' => $orderId, 'stored' => $attempt['tracking_id'], 'received' => $trackingId, 'other_order' => $conflictWith],
            ]);
        }
    }

    $newStatus = $mapped;
    if ($mismatch) {
        $newStatus = 'PENDING';
        $facts['needs_review'] = true;
        payAudit($db, 'response_mismatch', $ctx + [
            'detail' => "The {$channel} response for {$orderId} does not match the order (" . implode(', ', array_keys($mismatch)) . '), so it was not accepted as paid.',
            'data'   => ['order_id' => $orderId, 'order_status' => $gatewayStatus, 'mismatch' => $mismatch],
        ]);
    } elseif ($mapped === 'SUCCESS' && $attempt['status'] !== 'SUCCESS') {
        if (ccavApiConfigured((string) $attempt['environment'])) {
            $envCfg = array_merge(payEnvConfig($cfg, (string) $attempt['environment']), ['timeout' => 12]);
            $api = ccavOrderStatus($facts['tracking_id'] ?? ($attempt['tracking_id'] ?? ($trackingId !== '' ? $trackingId : null)), $orderId, $envCfg);
            $noRecord = !$api['ok'] && in_array($api['error_code'], CCAV_NO_RECORD_CODES, true);
            if ($api['ok'] || $noRecord) {
                $apiMapped = $api['ok'] ? ccavMapApiStatus($api['status']) : null;
                $amountOk = $api['amount'] !== null && payAmountCents($api['amount']) === payAmountCents($attempt['amount']);
                $currencyOk = $api['currency'] === null || $api['currency'] === '' || $api['currency'] === strtoupper((string) $attempt['currency']);
                if ($apiMapped === 'SUCCESS' && $amountOk && $currencyOk) {
                    $facts['verification'] = 'status_api';
                    $facts['verified'] = true;
                    $facts['via'] = 'verified with CCAvenue';
                    if ($facts['bank_ref_no'] === null && $api['bank_ref_no']) $facts['bank_ref_no'] = $api['bank_ref_no'];
                    payAudit($db, 'verification_ok', $ctx + [
                        'detail' => "CCAvenue's status check confirms {$orderId} is paid.",
                        'data'   => ['order_id' => $orderId, 'api_status' => $api['status'], 'api_amount' => $api['amount'], 'api_currency' => $api['currency']],
                    ]);
                } else {
                    $newStatus = 'PENDING';
                    $facts['needs_review'] = true;
                    payAudit($db, 'verification_disagrees', $ctx + [
                        'detail' => "The {$channel} response says {$orderId} was paid, but CCAvenue's status check says "
                            . ($noRecord ? 'it has no such order' : ($api['status'] ?? 'something else'))
                            . (!$noRecord && $apiMapped === 'SUCCESS' ? ' with a different amount or currency' : '') . '. Not accepted as paid until reviewed.',
                        'data'   => [
                            'order_id' => $orderId, 'api_status' => $api['status'], 'api_amount' => $api['amount'],
                            'api_currency' => $api['currency'], 'error_code' => $api['error_code'],
                        ],
                    ]);
                }
            } else {
                $facts['via'] = 'not yet confirmed with CCAvenue';
                payAudit($db, 'verification_unavailable', $ctx + [
                    'detail' => "CCAvenue's status check could not be reached for {$orderId}; the payment is accepted on the gateway response and will be checked again.",
                    'data'   => ['order_id' => $orderId, 'error' => $api['error'], 'error_code' => $api['error_code'], 'http' => $api['http']],
                ]);
            }
        } else {
            $facts['via'] = 'on the gateway response; the status API is not configured';
        }
    }

    $applied = payStateApply($db, $attempt, $newStatus, $facts, 'gateway');
    return ['unknown' => false, 'attempt' => $attempt, 'number' => $number, 'applied' => $applied];
}

/** Headers every gateway return and public payment answer carries. */
function payNoStoreHeaders(): void
{
    if (headers_sent()) return;
    header('Cache-Control: no-store, private');
    header('X-Robots-Tag: noindex, nofollow');
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
}

/** 303 See Other to a site path, with the no-store headers. */
function payRedirect303(string $path): never
{
    payNoStoreHeaders();
    http_response_code(303);
    header('Location: ' . siteUrl($path));
    header('Content-Type: text/plain; charset=utf-8');
    echo "See Other\n";
    exit;
}

/**
 * Send the donor's browser on after a response: /payment/result?ref=…&t=…, or
 * ?state=cancelled / ?state=unknown when there is no payable to show.
 */
function payRespondBrowser(array $result): never
{
    if (!empty($result['number']) && !empty($result['token'])) {
        payRedirect303('/payment/result?ref=' . rawurlencode((string) $result['number']) . '&t=' . rawurlencode((string) $result['token']));
    }
    payRedirect303('/payment/result?state=' . (($result['state'] ?? '') === 'cancelled' ? 'cancelled' : 'unknown'));
}

/** Answer CCAvenue's server notification: plain text, 200 "OK" or the error status. */
function payRespondNotify(array $result): never
{
    $status = (int) ($result['http'] ?? 200);
    payNoStoreHeaders();
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo match (true) {
        $status === 200 => 'OK',
        $status === 400 => 'Bad Request',
        $status === 413 => 'Payload Too Large',
        $status === 503 => 'Service Unavailable',
        default         => 'Error',
    };
    exit;
}
