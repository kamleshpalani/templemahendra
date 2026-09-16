<?php
/**
 * tests/support/payments_fixtures.php — shared setup for the payment test
 * suites (docs/payments/SPEC.md §12). CLI only; refuses to run from a web server.
 *
 *   php tests/support/payments_fixtures.php <command> '<json>'
 *   php tests/support/payments_fixtures.php <command> -        (JSON on stdin)
 *
 * Commands (each prints exactly one JSON object on the last line of stdout):
 *
 *   encrypt   {plain, key}                     ccavEncrypt()
 *   decrypt   {hex, key}                       ccavDecrypt() — plain is null when it fails
 *   token     {number?, receipt?}              access and verify tokens
 *   config    {}                               the effective settings, never a credential
 *   create-donation      {name, amount, …, age_minutes?}   through payValidateDonation + payCreateDonation
 *   create-seva-payable  {devotee_name, seva_id, …}        through payValidateSevaBooking + payCreateSevaBooking
 *   payable   {number}                         payLoadPayable() as JSON
 *   apply     {order_id, status, facts?, actor?}           drive payStateApply() on a locked attempt
 *   backdate  {order_ids?, number?, minutes?, hold_minutes?, clear_checked?}
 *   sweep     {order_ids?, limit?, expire_holds?}          payReconcileSweep()
 *   expire-holds {order_ids?}                  payExpireHolds()
 *   receipt-race {prefix, year, count?, sleep_ms?}         two processes racing for receipt numbers
 *   sql       {query, params}                  one statement, rows back
 *   cleanup   {name_prefix, ips?}              every row a suite's names created
 *
 * The database and gateway environment comes from the caller (the suite exports
 * PAYMENTS_* and CCAVENUE_* before spawning this), so a fixture sees exactly the
 * settings the server under test sees.
 *
 * Rows are only ever removed by a name prefix, never by number or order id, so a
 * cleanup can never reach a real donation.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../backend/includes/payments.php';

function payFixtureOut(array $data, int $code = 0): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";
    exit($code);
}

/** A cleanup prefix long and plain enough that it can only match test rows. */
function payFixtureSafePrefix(string $prefix): bool
{
    return strlen($prefix) >= 8 && preg_match('/^[A-Za-z0-9._ -]+$/', $prefix) === 1;
}

/** True when a table exists in this database (the notification tables are optional). */
function payFixtureHasTable(PDO $db, string $table): bool
{
    $stmt = $db->prepare('SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t');
    $stmt->execute([':t' => $table]);
    return (int) $stmt->fetchColumn() > 0;
}

/** "a,b,c" as a list of ints for an IN clause, never empty. */
function payFixtureIn(array $ids): string
{
    $ids = array_values(array_filter(array_map('intval', $ids), static fn(int $i): bool => $i > 0));
    return $ids ? implode(',', $ids) : '0';
}

$cmd = $argv[1] ?? '';
$raw = $argv[2] ?? '{}';
if ($raw === '-' || $raw === '') $raw = stream_get_contents(STDIN) ?: '{}';
$args = json_decode($raw, true);
if (!is_array($args)) payFixtureOut(['error' => 'the argument must be a JSON object'], 1);

try {
    $db = getDB();
    switch ($cmd) {
        case 'encrypt':
            payFixtureOut(['hex' => ccavEncrypt((string) ($args['plain'] ?? ''), (string) ($args['key'] ?? ''))]);

        case 'decrypt':
            payFixtureOut(['plain' => ccavDecrypt((string) ($args['hex'] ?? ''), (string) ($args['key'] ?? ''))]);

        case 'token': {
            $out = [];
            if (isset($args['number'])) {
                $out['number'] = (string) $args['number'];
                $out['token'] = payAccessToken((string) $args['number']);
            }
            if (isset($args['receipt'])) {
                $out['receipt'] = (string) $args['receipt'];
                $out['verify'] = payVerifyToken((string) $args['receipt']);
            }
            payFixtureOut($out);
        }

        case 'config': {
            $cfg = payConfig(true);
            $env = payEnvConfig($cfg);
            $ready = payReady();
            payFixtureOut([
                'tables'          => $cfg['tables'],
                'enabled'         => $cfg['enabled'],
                'mode'            => $cfg['mode'],
                'ready'           => $ready['ok'],
                'reason'          => $ready['reason'],
                'currencies'      => $cfg['currencies'],
                'international'   => $cfg['international'],
                'donation_min'    => $cfg['donation_min'],
                'donation_max'    => $cfg['donation_max'],
                'max_foreign'     => $cfg['donation_max_foreign'],
                'presets'         => $cfg['presets'],
                'receipt_prefix'  => $cfg['receipt_prefix'],
                'seva_online'     => $cfg['seva_online'],
                'hold_minutes'    => $cfg['hold_minutes'],
                'notify'          => ['email' => $cfg['notify_email'], 'sms' => $cfg['notify_sms'], 'whatsapp' => $cfg['notify_whatsapp']],
                'transaction_url' => $env['transaction_url'],
                'api_url'         => $env['api_url'],
                'redirect_url'    => $env['redirect_url'],
                'api_configured'  => ccavApiConfigured($cfg['mode']),
                'simulator'       => $cfg['simulator_allowed'],
            ]);
        }

        case 'create-donation':
        case 'create-seva-payable': {
            $cfg = payConfig(true);
            $ready = payReady();
            if (!$ready['ok']) payFixtureOut(['error' => 'payments are not ready: ' . $ready['reason']], 1);
            $isDonation = $cmd === 'create-donation';
            $body = $isDonation
                ? array_merge([
                    'category'     => 'general',
                    'amount'       => '1001',
                    'currency'     => 'INR',
                    'name'         => 'E2E-PAY-FIXTURE Donor',
                    'phone'        => '919876543210',
                    'phoneCountry' => 'IN',
                    'country'      => 'IN',
                    'acceptTerms'  => true,
                    'lang'         => 'en',
                ], $args)
                : array_merge([
                    'devotee_name' => 'E2E-PAY-FIXTURE Devotee',
                    'phone'        => '919876543210',
                    'phoneCountry' => 'IN',
                    'acceptTerms'  => true,
                    'lang'         => 'en',
                ], $args);
            $checked = $isDonation ? payValidateDonation($body, $cfg) : payValidateSevaBooking($body, $cfg);
            if ($checked['fields']) payFixtureOut(['error' => 'validation refused the fixture', 'fields' => $checked['fields']], 1);
            $created = $isDonation
                ? payCreateDonation($db, $checked['values'], $cfg, (string) ($args['ip'] ?? '10.83.0.1'))
                : payCreateSevaBooking($db, $checked['values'], $cfg, (string) ($args['ip'] ?? '10.83.0.1'));
            $payable = $created['payable'];
            $attempt = $created['attempt'];
            $checkout = ccavCheckoutFields($attempt, $payable, payEnvConfig($cfg, (string) $attempt['environment']));
            if ((int) ($args['age_minutes'] ?? 0) > 0) {
                $m = (int) $args['age_minutes'];
                // Two distinct placeholders: with native prepares PDO refuses a name bound twice (HY093).
                $db->prepare('UPDATE payment_transactions SET created_at = DATE_SUB(created_at, INTERVAL :m1 MINUTE), updated_at = DATE_SUB(updated_at, INTERVAL :m2 MINUTE) WHERE id = :id')
                   ->execute([':m1' => $m, ':m2' => $m, ':id' => $attempt['id']]);
            }
            payFixtureOut([
                'type'           => $payable['type'],
                'number'         => $payable['number'],
                'token'          => payAccessToken($payable['number']),
                'payable_id'     => $payable['id'],
                'transaction_id' => $attempt['id'],
                'order_id'       => $attempt['order_id'],
                'attempt'        => $attempt['attempt'],
                'amount'         => $payable['amount'],
                'currency'       => $payable['currency'],
                'environment'    => $attempt['environment'],
                'checkout'       => $checkout,
            ]);
        }

        case 'payable': {
            $payable = payLoadPayable($db, (string) ($args['number'] ?? ''));
            if ($payable === null) payFixtureOut(['error' => 'no such payable'], 1);
            payFixtureOut(['payable' => $payable, 'public' => payPublicView($db, $payable)]);
        }

        case 'apply': {
            $orderId = (string) ($args['order_id'] ?? '');
            $status = (string) ($args['status'] ?? '');
            $facts = is_array($args['facts'] ?? null) ? $args['facts'] : [];
            $actor = (string) ($args['actor'] ?? 'system');
            $result = payTransaction($db, function (PDO $db) use ($orderId, $status, $facts, $actor): array {
                $attempt = payLoadAttemptForUpdate($db, $orderId);
                if ($attempt === null) return ['error' => 'no such attempt'];
                return payStateApply($db, $attempt, $status, $facts, $actor);
            });
            if (isset($result['error'])) payFixtureOut($result, 1);
            payFixtureOut(['applied' => $result]);
        }

        case 'backdate': {
            $minutes = (int) ($args['minutes'] ?? 0);
            $orderIds = [];
            foreach ((array) ($args['order_ids'] ?? []) as $o) {
                if (payParseNumber((string) $o) !== null) $orderIds[] = (string) $o;
            }
            $moved = 0;
            if ($orderIds && $minutes > 0) {
                $in = implode(',', array_fill(0, count($orderIds), '?'));
                $stmt = $db->prepare(
                    "UPDATE payment_transactions
                        SET created_at = DATE_SUB(created_at, INTERVAL ? MINUTE),
                            updated_at = DATE_SUB(updated_at, INTERVAL ? MINUTE),
                            responded_at = CASE WHEN responded_at IS NULL THEN NULL ELSE DATE_SUB(responded_at, INTERVAL ? MINUTE) END,
                            last_checked_at = CASE WHEN ? = 1 THEN NULL ELSE last_checked_at END
                      WHERE order_id IN ({$in})"
                );
                $stmt->execute(array_merge([$minutes, $minutes, $minutes, ($args['clear_checked'] ?? true) ? 1 : 0], $orderIds));
                $moved = $stmt->rowCount();
            }
            $held = 0;
            $number = (string) ($args['number'] ?? '');
            if ($number !== '' && isset($args['hold_minutes'])) {
                $stmt = $db->prepare('UPDATE seva_bookings SET hold_expires_at = UTC_TIMESTAMP() - INTERVAL :m MINUTE WHERE order_number = :n');
                $stmt->execute([':m' => (int) $args['hold_minutes'], ':n' => $number]);
                $held = $stmt->rowCount();
            }
            payFixtureOut(['attempts' => $moved, 'bookings' => $held]);
        }

        case 'sweep': {
            $opts = ['limit' => (int) ($args['limit'] ?? 40), 'actor' => (string) ($args['actor'] ?? 'cron')];
            if (isset($args['order_ids'])) $opts['order_ids'] = (array) $args['order_ids'];
            if (isset($args['expire_holds'])) $opts['expire_holds'] = (bool) $args['expire_holds'];
            payFixtureOut(['sweep' => payReconcileSweep($db, $opts)]);
        }

        case 'expire-holds':
            payFixtureOut(['expired' => payExpireHolds($db, isset($args['order_ids']) ? (array) $args['order_ids'] : null)]);

        case 'receipt-race': {
            // Take $count receipt numbers inside one transaction, holding the
            // counter lock for $sleep_ms between them: a second process running
            // this at the same time must wait, not share a number.
            $prefix = (string) ($args['prefix'] ?? 'ZTE');
            $year = (string) ($args['year'] ?? '1999');
            $count = max(1, min(20, (int) ($args['count'] ?? 3)));
            $sleep = max(0, min(5000, (int) ($args['sleep_ms'] ?? 200)));
            $numbers = [];
            $started = microtime(true);
            payTransaction($db, function (PDO $db) use ($prefix, $year, $count, $sleep, &$numbers): void {
                for ($i = 0; $i < $count; $i++) {
                    $numbers[] = payNextReceiptNumber($db, $prefix, $year);
                    if ($sleep > 0) usleep($sleep * 1000);
                }
            });
            payFixtureOut(['numbers' => $numbers, 'ms' => (int) ((microtime(true) - $started) * 1000)]);
        }

        case 'sql': {
            $stmt = $db->prepare((string) ($args['query'] ?? ''));
            $stmt->execute((array) ($args['params'] ?? []));
            $rows = $stmt->columnCount() > 0 ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            payFixtureOut(['rows' => $rows, 'affected' => $stmt->rowCount()]);
        }

        case 'cleanup': {
            $prefix = (string) ($args['name_prefix'] ?? '');
            if (!payFixtureSafePrefix($prefix)) {
                payFixtureOut(['error' => 'name_prefix must be at least eight plain characters'], 1);
            }
            $like = addcslashes($prefix, '%_') . '%';
            $counts = ['donations' => 0, 'bookings' => 0, 'attempts' => 0, 'refunds' => 0, 'audit' => 0, 'notifications' => 0, 'counters' => 0, 'buckets' => 0];

            $donationIds = $db->prepare('SELECT id FROM donations WHERE name LIKE :p');
            $donationIds->execute([':p' => $like]);
            $dids = $donationIds->fetchAll(PDO::FETCH_COLUMN);
            $bookingIds = $db->prepare('SELECT id FROM seva_bookings WHERE devotee_name LIKE :p');
            $bookingIds->execute([':p' => $like]);
            $sids = $bookingIds->fetchAll(PDO::FETCH_COLUMN);
            $din = payFixtureIn($dids);
            $sin = payFixtureIn($sids);

            $tids = $db->query(
                "SELECT id FROM payment_transactions
                  WHERE (payable_type = 'donation' AND payable_id IN ({$din}))
                     OR (payable_type = 'seva_booking' AND payable_id IN ({$sin}))"
            )->fetchAll(PDO::FETCH_COLUMN);
            $tin = payFixtureIn($tids);
            $orderIds = $db->query("SELECT order_id FROM payment_transactions WHERE id IN ({$tin})")->fetchAll(PDO::FETCH_COLUMN);
            $rids = $db->query("SELECT id FROM payment_refunds WHERE transaction_id IN ({$tin})")->fetchAll(PDO::FETCH_COLUMN);
            $rin = payFixtureIn($rids);

            if (payFixtureHasTable($db, 'notifications')) {
                $stmt = $db->query(
                    "DELETE FROM notifications
                      WHERE (entity_type = 'donation' AND entity_id IN ({$din}))
                         OR (entity_type = 'seva_booking' AND entity_id IN ({$sin}))
                         OR (entity_type = 'payment' AND entity_id IN ({$tin}))
                         OR (entity_type = 'payment_refund' AND entity_id IN ({$rin}))"
                );
                $counts['notifications'] = $stmt->rowCount();
            }
            $counts['audit'] = $db->exec(
                "DELETE FROM payment_audit_log
                  WHERE transaction_id IN ({$tin})
                     OR (payable_type = 'donation' AND payable_id IN ({$din}))
                     OR (payable_type = 'seva_booking' AND payable_id IN ({$sin}))"
            );
            $counts['refunds'] = $db->exec("DELETE FROM payment_refunds WHERE transaction_id IN ({$tin})");
            $counts['attempts'] = $db->exec("DELETE FROM payment_transactions WHERE id IN ({$tin})");
            foreach ($orderIds as $orderId) {
                $stmt = $db->prepare('DELETE FROM payment_counters WHERE name = :n');
                $stmt->execute([':n' => 'sim:' . $orderId]);
                $counts['counters'] += $stmt->rowCount();
            }
            $stmt = $db->prepare('DELETE FROM donations WHERE name LIKE :p');
            $stmt->execute([':p' => $like]);
            $counts['donations'] = $stmt->rowCount();
            $stmt = $db->prepare('DELETE FROM seva_bookings WHERE devotee_name LIKE :p');
            $stmt->execute([':p' => $like]);
            $counts['bookings'] = $stmt->rowCount();

            // Audit rows a hostile response wrote name no payable at all; they
            // are recognised only by the address the suite sent them from.
            foreach ((array) ($args['ips'] ?? []) as $ip) {
                if (!is_string($ip) || !preg_match('/^[0-9a-fA-F.:]{3,45}$/D', $ip)) continue;
                $stmt = $db->prepare('DELETE FROM payment_audit_log WHERE ip = :ip AND transaction_id IS NULL AND payable_id IS NULL');
                $stmt->execute([':ip' => $ip]);
                $counts['audit'] += $stmt->rowCount();
                $stmt = $db->prepare('DELETE FROM rate_limits WHERE bucket LIKE :b');
                $stmt->execute([':b' => '%:' . $ip]);
                $counts['buckets'] += $stmt->rowCount();
            }
            payFixtureOut($counts);
        }
    }
    payFixtureOut(['error' => "unknown command \"{$cmd}\""], 1);
} catch (Throwable $e) {
    payFixtureOut(['error' => get_class($e) . ': ' . $e->getMessage()], 1);
}
