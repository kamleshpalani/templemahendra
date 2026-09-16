<?php
/**
 * tests/payments-unit.php — the payment module's rules, one at a time, against
 * the real code and the real database (docs/payments/SPEC.md §12, suite 1).
 *
 *   PHP_BIN=/path/to/php.sh; $PHP_BIN tests/payments-unit.php
 *
 * What it proves:
 *   • CCAvenue's crypto: the pinned vector, the round trip, and every way a
 *     response can be rubbish (bad hex, odd length, wrong key, truncation, text
 *     that is not UTF-8) answering null instead of half a payment (§4.3);
 *   • money: the amount grammar, paise arithmetic, the gateway's format, JPY,
 *     and the words a message carries (§5.2, §6);
 *   • numbers, order ids, receipt numbers and the two signed tokens (§1) —
 *     including a receipt sequence with no gaps while two PHP processes race for
 *     the counter;
 *   • credential storage: the secretbox round trip, a missing or short key and a
 *     tampered ciphertext all counting as absent (§4.1);
 *   • responses: parsing, the allow-list, both status-mapping tables (§2.3), and
 *     the checkout payload's exact field order and cleaning (§4.3);
 *   • the transition table (§2.4) on real rows: one SUCCESS, one receipt, a
 *     repeat that changes nothing, a late success only with the status API,
 *     double payment, the five-attempt limit and the retry clock;
 *   • refund arithmetic and the payable statuses refunds derive (§8);
 *   • the validation contracts (§5.2) for donations and seva bookings, including
 *     arrays, objects, numbers and null where text is expected.
 *
 * Creates "E2E-PAY-UNIT <run> …" donations and bookings with their attempts,
 * refunds and audit rows, and deletes them before exiting. The receipt counter
 * it advances is put back; the race uses a counter of its own (year 1999).
 * payment_settings is never written: the settings come from an overlay in this
 * process's environment.
 */

if (PHP_SAPI !== 'cli') exit(1);

// This suite's own settings and fake credentials: nothing here is a secret, and
// nothing is written to payment_settings.
putenv('PAYMENTS_ALLOW_SIMULATOR=1');
putenv('PAYMENTS_SETTINGS_OVERLAY={"enabled":"1","mode":"test","seva_online_enabled":"1","international_enabled":"1","currencies":"INR,USD,JPY","default_currency":"INR"}');
putenv('PAYMENTS_SECRET=e2e-pay-unit-fake-secret-0123456789abcdef');
putenv('PAYMENTS_SETTINGS_KEY=' . base64_encode('e2e-pay-unit-fake-settings-key!!'));
putenv('CCAVENUE_TEST_MERCHANT_ID=1234567');
putenv('CCAVENUE_TEST_ACCESS_CODE=E2EUNITACCESS');
putenv('CCAVENUE_TEST_WORKING_KEY=e2e-unit-working-key-not-secret');
putenv('CCAVENUE_TRANSACTION_URL=http://127.0.0.1:8079/transaction/transaction.do');
putenv('CCAVENUE_API_URL=http://127.0.0.1:8079/apis/servlet/DoWebTrans');
putenv('SITE_URL=http://localhost:8061');
putenv('NOTIFY_ALLOW_TEST_DRIVER=1');
foreach (['EMAIL', 'WHATSAPP', 'SMS'] as $channel) putenv("NOTIFY_{$channel}_DRIVER=test");

require_once __DIR__ . '/../backend/includes/payments.php';

$passed = 0;
$failures = [];

function ok(bool $condition, string $label, string $detail = ''): bool
{
    global $passed, $failures;
    if ($condition) {
        $passed++;
        echo "  ok   {$label}\n";
    } else {
        $failures[] = $label;
        echo "  FAIL {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
    }
    return $condition;
}

function eq(mixed $actual, mixed $expected, string $label): bool
{
    return ok(
        $actual === $expected,
        $label,
        'expected ' . json_encode($expected, JSON_UNESCAPED_UNICODE) . ', got ' . json_encode($actual, JSON_UNESCAPED_UNICODE)
    );
}

function section(string $title): void
{
    echo "\n── {$title}\n";
}

/** The exception class and message a callable throws, or null. */
function threw(callable $fn): ?string
{
    try {
        $fn();
    } catch (Throwable $e) {
        return get_class($e) . ': ' . $e->getMessage();
    }
    return null;
}

if (!payTablesExist()) {
    echo "The payment tables are missing; apply database/migrations/010_payments.sql first.\n";
    exit(2);
}

$run    = base_convert((string) time(), 10, 36) . bin2hex(random_bytes(2));
$PREFIX = 'E2E-PAY-UNIT';
$NAME   = "{$PREFIX} {$run}";
$db     = getDB();
$cfg    = payConfig(true);
$ready  = payReady();

echo "payments-unit — run {$run}, mode {$cfg['mode']}\n";
if (!$ready['ok']) {
    echo "payReady() says no: {$ready['reason']}\n";
    exit(2);
}

$istYear = payIstDate(null, 'Y');
// This suite pays in TEST mode, so its receipts come from the TEST sequence (§1), never the temple's.
$counterName = payReceiptCounterName('test', $istYear);
$counterBefore = $db->prepare('SELECT value FROM payment_counters WHERE name = :n');
$counterBefore->execute([':n' => $counterName]);
$counterBefore = $counterBefore->fetchColumn();
$counterBefore = $counterBefore === false ? null : (int) $counterBefore;
$receiptsIssued = 0;

/** Remove every row this run created, by name. */
function unitCleanup(PDO $db, string $like): array
{
    $ids = static function (string $sql, array $p) use ($db): string {
        $stmt = $db->prepare($sql);
        $stmt->execute($p);
        $rows = array_filter(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)));
        return $rows ? implode(',', $rows) : '0';
    };
    $dids = $ids('SELECT id FROM donations WHERE name LIKE ?', [$like]);
    $sids = $ids('SELECT id FROM seva_bookings WHERE devotee_name LIKE ?', [$like]);
    $tids = $ids("SELECT id FROM payment_transactions WHERE (payable_type = 'donation' AND payable_id IN ({$dids})) OR (payable_type = 'seva_booking' AND payable_id IN ({$sids}))", []);
    $rids = $ids("SELECT id FROM payment_refunds WHERE transaction_id IN ({$tids})", []);
    $out = [];
    $has = $db->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications'")->fetchColumn();
    if ((int) $has > 0) {
        $out['notifications'] = $db->exec(
            "DELETE FROM notifications WHERE (entity_type = 'donation' AND entity_id IN ({$dids}))
              OR (entity_type = 'seva_booking' AND entity_id IN ({$sids}))
              OR (entity_type = 'payment' AND entity_id IN ({$tids}))
              OR (entity_type = 'payment_refund' AND entity_id IN ({$rids}))"
        );
    }
    $out['audit'] = $db->exec(
        "DELETE FROM payment_audit_log WHERE transaction_id IN ({$tids})
          OR (payable_type = 'donation' AND payable_id IN ({$dids}))
          OR (payable_type = 'seva_booking' AND payable_id IN ({$sids}))"
    );
    $out['refunds'] = $db->exec("DELETE FROM payment_refunds WHERE transaction_id IN ({$tids})");
    $out['attempts'] = $db->exec("DELETE FROM payment_transactions WHERE id IN ({$tids})");
    $stmt = $db->prepare('DELETE FROM donations WHERE name LIKE ?');
    $stmt->execute([$like]);
    $out['donations'] = $stmt->rowCount();
    $stmt = $db->prepare('DELETE FROM seva_bookings WHERE devotee_name LIKE ?');
    $stmt->execute([$like]);
    $out['bookings'] = $stmt->rowCount();
    return $out;
}

unitCleanup($db, "{$PREFIX} %");

try {
    /* ── 1. Crypto ───────────────────────────────────────────────────────── */
    section('1. CCAvenue crypto (§4.3)');
    $vector = ccavEncrypt('merchant_id=1&order_id=A', 'TESTKEY');
    eq($vector, '9d13862a187313a737da15831e7a4a6bbf774a44c3e267524d82cd9847045fb2', 'the pinned vector (also pinned in tests/support/ccavenue_crypto.mjs)');
    eq(ccavDecrypt($vector, 'TESTKEY'), 'merchant_id=1&order_id=A', 'the round trip');
    eq(ccavDecrypt(strtoupper($vector), 'TESTKEY'), 'merchant_id=1&order_id=A', 'upper-case hex is accepted');
    $long = str_repeat('billing_name=கணேஷ் குமார்&', 40);
    eq(ccavDecrypt(ccavEncrypt($long, 'a-working-key'), 'a-working-key'), $long, 'a long Tamil payload survives the round trip');
    foreach ([
        'the wrong key'                 => fn() => ccavDecrypt($vector, 'WRONGKEY'),
        'hex that is not hex'           => fn() => ccavDecrypt('zz11', 'TESTKEY'),
        'an odd number of hex digits'   => fn() => ccavDecrypt(substr($vector, 0, -1), 'TESTKEY'),
        'an empty string'               => fn() => ccavDecrypt('', 'TESTKEY'),
        'only whitespace'               => fn() => ccavDecrypt("  \n", 'TESTKEY'),
        'a truncated block'             => fn() => ccavDecrypt(substr($vector, 0, 30), 'TESTKEY'),
        'more than 200 000 characters'  => fn() => ccavDecrypt(str_repeat('ab', 100001), 'TESTKEY'),
        'a flipped byte'                => fn() => ccavDecrypt(substr($vector, 0, 8) . (($vector[8] === 'a') ? 'b' : 'a') . substr($vector, 9), 'TESTKEY'),
    ] as $label => $fn) {
        eq($fn(), null, "{$label} decrypts to null");
    }
    $binary = ccavEncrypt("\xC3\x28 not utf-8", 'TESTKEY');
    eq(ccavDecrypt($binary, 'TESTKEY'), null, 'a payload that is not valid UTF-8 is refused');
    ok(threw(fn() => ccavEncrypt(str_repeat('x', 10), '')) === null, 'an empty working key still encrypts (payReady refuses the mode instead)');

    /* ── 2. Money ────────────────────────────────────────────────────────── */
    section('2. Amounts (§5.2, §4.3, §6)');
    foreach (['1' => '1.00', '1.5' => '1.50', '1.50' => '1.50', '0' => '0.00', '0010' => '10.00', '1234567890' => '1234567890.00', ' 25 ' => '25.00'] as $in => $expected) {
        eq(payAmountParse((string) $in), $expected, "payAmountParse('{$in}')");
    }
    foreach (['-1', '1e3', '1E3', '1,000', '１２', '12345678901', '1.555', '', 'abc', '1.', '.5', '+1', ' 1 000', "1\n"] as $in) {
        eq(payAmountParse($in), null, "payAmountParse refuses '{$in}'");
    }
    eq(payAmountParse([1]), null, 'payAmountParse refuses an array');
    eq(payAmountParse(['a' => 1]), null, 'payAmountParse refuses an object');
    eq(payAmountParse(true), null, 'payAmountParse refuses true');
    eq(payAmountParse(null), null, 'payAmountParse refuses null');
    eq(payAmountParse(1000), '1000.00', 'payAmountParse accepts the integer 1000');
    eq(payAmountParse(1.5), '1.50', 'payAmountParse accepts the float 1.5');
    eq(payAmountParse(1e30), null, 'payAmountParse refuses 1e30');
    eq(payAmountParse(-5), null, 'payAmountParse refuses a negative integer');
    eq(payAmountCents('1001.00'), 100100, 'payAmountCents 1001.00');
    eq(payAmountCents('0.1'), 10, 'payAmountCents 0.1 is ten paise');
    eq(payAmountCents('1.999'), 199, 'payAmountCents cuts, never rounds');
    eq(payCentsToAmount(100100), '1001.00', 'payCentsToAmount');
    eq(payCentsToAmount(5), '0.05', 'payCentsToAmount five paise');
    eq(payAmountFormat('1001', 'INR'), '1001.00', 'the gateway amount for INR');
    eq(payAmountFormat('3000.00', 'JPY'), '3000.00', 'the gateway amount for JPY is whole units with .00');
    eq(payAmountFormat('3000.75', 'JPY'), '3000.00', 'a JPY amount with paise is cut to whole units');
    eq(payCurrencyDecimals('JPY'), 0, 'JPY has no decimals');
    eq(payCurrencyDecimals('usd'), 2, 'USD has two');
    eq(payMoneyLabel('1001.00', 'INR'), 'Rs. 1,001', 'payMoneyLabel INR whole');
    eq(payMoneyLabel('501.50', 'INR'), 'Rs. 501.50', 'payMoneyLabel INR with paise');
    eq(payMoneyLabel('25', 'USD'), 'USD 25.00', 'payMoneyLabel USD');
    eq(payMoneyLabel('3000.00', 'JPY'), 'JPY 3000', 'payMoneyLabel JPY');
    ok(!str_contains(payMoneyLabel('1001.00', 'INR'), '₹'), 'no rupee sign in a message label (SMS stays GSM-7)');
    eq(payNumberOut('500.00'), 500, 'payNumberOut gives an int for a whole amount');
    eq(payNumberOut('1.50'), 1.5, 'payNumberOut gives a float for paise');

    /* ── 3. Numbers, order ids and tokens ────────────────────────────────── */
    section('3. Numbers, order ids and tokens (§1)');
    eq(payNumberFor('donation', 1234, '20260914'), 'DON-20260914-00001234', 'a donation number');
    eq(payNumberFor('seva_booking', 7, '20260914'), 'SEV-20260914-00000007', 'a seva booking number');
    eq(strlen(payNumberFor('donation', 99999999, '20260914')), 21, 'a number is 21 characters');
    ok(threw(fn() => payNumberFor('devotee', 1, '20260914')) !== null, 'an unknown payable type throws');
    ok(threw(fn() => payNumberFor('donation', 0, '20260914')) !== null, 'row id 0 throws');
    ok(threw(fn() => payNumberFor('donation', 100000000, '20260914')) !== null, 'a row id of nine digits throws');
    ok(threw(fn() => payNumberFor('donation', 1, '2026-09-14')) !== null, 'a date that is not YYYYMMDD throws');
    eq(payOrderIdFor('DON-20260914-00001234', 1), 'DON-20260914-00001234', 'attempt 1 uses the number itself');
    eq(payOrderIdFor('DON-20260914-00001234', 5), 'DON-20260914-00001234-R5', 'attempt 5 is -R5');
    ok(threw(fn() => payOrderIdFor('DON-20260914-00001234', 6)) !== null, 'attempt 6 throws');
    ok(strlen(payOrderIdFor('DON-20260914-00001234', 5)) <= 30, 'an order id fits CCAvenue 30 characters');
    $parsed = payParseNumber('DON-20260914-00001234-R2');
    ok($parsed !== null && $parsed['type'] === 'donation' && $parsed['attempt'] === 2 && $parsed['number'] === 'DON-20260914-00001234' && $parsed['id'] === 1234, 'payParseNumber takes an order id apart', json_encode($parsed));
    eq(payParseNumber('SEV-20260914-00000007')['type'] ?? null, 'seva_booking', 'SEV parses as a seva booking');
    foreach ([
        'DON-20260914-00001234-R1', 'DON-20260914-00001234-R6', 'DON-20260914-0001234', 'don-20260914-00001234',
        'DON-20260914-00000000', "DON-20260914-00001234\n", ' DON-20260914-00001234', 'DON-20260914-00001234;DROP',
        'ORD-20260914-00001234', 'DON-20260914-00001234-R2-R3',
    ] as $bad) {
        eq(payParseNumber($bad), null, 'payParseNumber refuses ' . json_encode($bad));
    }
    eq(payParseNumber(['DON-20260914-00001234']), null, 'payParseNumber refuses an array');
    eq(payParseNumber(12345678), null, 'payParseNumber refuses a number');

    $number = 'DON-20260914-00001234';
    $token = payAccessToken($number);
    eq(strlen($token), 22, 'an access token is 22 characters');
    ok(preg_match('/^[A-Za-z0-9_-]{22}$/D', $token) === 1, 'it is base64url', $token);
    ok(payAccessTokenValid($number, $token), 'the access token is valid for its own number');
    ok(!payAccessTokenValid('DON-20260914-00001235', $token), "another number's token is refused");
    ok(!payAccessTokenValid($number, substr($token, 0, 21) . ($token[21] === 'a' ? 'b' : 'a')), 'a tampered token is refused');
    ok(!payAccessTokenValid($number, substr($token, 0, 21)), 'a short token is refused');
    ok(!payAccessTokenValid($number, null) && !payAccessTokenValid($number, ['x']) && !payAccessTokenValid($number, 12), 'null, an array and a number are refused');
    ok(payAccessToken($number) === $token, 'the token is stable for the same number');
    $verify = payVerifyToken('TMR-2026-000042');
    eq(strlen($verify), 10, 'a verify token is 10 characters');
    ok(payVerifyTokenValid('TMR-2026-000042', $verify), 'the verify token is valid for its receipt');
    ok(!payVerifyTokenValid('TMR-2026-000043', $verify), "another receipt's verify token is refused");
    ok(!payVerifyTokenValid('NOTARECEIPT', $verify), 'a receipt number of the wrong shape is refused');
    ok(payAccessToken($number) !== substr(payVerifyToken($number), 0, 22), 'access and verify tokens are different keys of the same secret');

    section('3b. The IST calendar (§0.14)');
    $range = payIstRangeUtc('2026-09-30');
    ok($range['from'] === '2026-09-29 18:30:00' && $range['to'] === '2026-09-30 18:30:00', 'one IST day is a half-open UTC range', json_encode($range));
    eq(payIstDate('2026-09-14 18:31:00'), '20260915', 'an IST date rolls over at 18:30 UTC');
    eq(payIsoUtc('2026-09-14 03:30:00'), '2026-09-14T03:30:00Z', 'payIsoUtc');
    eq(payIsoUtc(null), null, 'payIsoUtc of null');
    ok(threw(fn() => payIstRangeUtc('2026-02-30')) !== null, 'a date that is not a real day throws');
    $month = payIstPeriodUtc('month', '2026-09-30 20:00:00');
    ok($month['fromYmd'] === '2026-10-01' && $month['toYmd'] === '2026-10-31', 'a payment at 01:30 IST on 1 October belongs to October', json_encode($month));

    /* ── 4. The receipt counter under two processes ──────────────────────── */
    section('4. Receipt numbers with no gaps (§1)');
    ok(str_contains((string) threw(fn() => payNextReceiptNumber($db, 'TMR', '1999')), 'LogicException'), 'a receipt number outside a transaction throws');

    // Two PHP processes are made to arrive at the counter at the same instant:
    // this suite holds the row itself while both start, then lets go. Their
    // counter is a year of its own, so the temple's receipt sequence is untouched.
    $db->exec("DELETE FROM payment_counters WHERE name = 'receipt:1999'");
    $db->exec("INSERT INTO payment_counters (name, value, updated_at) VALUES ('receipt:1999', 0, UTC_TIMESTAMP())");
    $ini = php_ini_loaded_file();
    $child = escapeshellarg(PHP_BINARY) . ($ini ? ' -c ' . escapeshellarg($ini) : '') . ' ' . escapeshellarg(__DIR__ . '/support/payments_fixtures.php') . ' receipt-race -';
    $payload = json_encode(['prefix' => 'ZPU', 'year' => '1999', 'count' => 2, 'sleep_ms' => 150]);
    $db->beginTransaction();
    $held = $db->query("SELECT value FROM payment_counters WHERE name = 'receipt:1999' FOR UPDATE");
    $held->fetchColumn();
    $procs = [];
    for ($i = 0; $i < 2; $i++) {
        $pipes = [];
        $p = proc_open($child, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, dirname(__DIR__), getenv());
        if (is_resource($p)) {
            fwrite($pipes[0], $payload);
            fclose($pipes[0]);
            $procs[] = [$p, $pipes];
        }
    }
    usleep(700000);
    $db->commit();
    $races = [];
    foreach ($procs as [$p, $pipes]) {
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($p);
        $lines = array_values(array_filter(explode("\n", trim($out))));
        $json = json_decode((string) end($lines), true);
        $races[] = is_array($json) ? $json : ['error' => trim($out . ' ' . $err)];
    }
    $finished = array_values(array_filter($races, static fn(array $r): bool => isset($r['numbers'])));
    ok(count($procs) === 2 && count($finished) === 2, 'two payments reaching the receipt counter at the same instant both get a number', json_encode($races));
    $all = [];
    foreach ($finished as $race) $all = array_merge($all, $race['numbers']);
    sort($all);
    $expected = array_map(static fn(int $n): string => sprintf('ZPU-1999-%06d', $n), range(1, count($all)));
    ok($all !== [] && $all === $expected, 'the receipt numbers that were issued are all different and in sequence with no gaps', json_encode($all));
    $blocks = array_map(static fn(array $r): string => implode(',', $r['numbers']), $finished);
    $contiguous = array_filter($blocks, static function (string $b): bool {
        $ns = array_map(static fn(string $n): int => (int) substr($n, -6), explode(',', $b));
        for ($i = 1; $i < count($ns); $i++) if ($ns[$i] !== $ns[$i - 1] + 1) return false;
        return true;
    });
    ok($blocks !== [] && count($contiguous) === count($blocks), 'each process held the counter for its whole transaction, so no two payments shared a number', json_encode($blocks));
    $db->exec("DELETE FROM payment_counters WHERE name = 'receipt:1999'");
    ok((int) $db->query("SELECT COUNT(*) FROM payment_counters WHERE name = 'receipt:1999'")->fetchColumn() === 0, "the race's own counter was removed");

    // One sequence per environment (§1): a TEST or SIMULATOR payment never takes a number from the temple's receipts.
    eq([payReceiptCounterName('production', '1999'), payReceiptCounterName('test', '1999'), payReceiptCounterName('simulator', '1999')],
        ['receipt:1999', 'receipt:test:1999', 'receipt:simulator:1999'], 'each environment has its own counter row');
    eq([payReceiptPrefixFor('production', 'ABC'), payReceiptPrefixFor('production', 'bad!'), payReceiptPrefixFor('test', 'ABC'), payReceiptPrefixFor('simulator', 'ABC')],
        ['ABC', 'TMR', 'TEST', 'SIM'], 'the configured prefix is for production only; TEST and SIM say what they are');
    $db->beginTransaction();
    $envNumbers = [
        payNextReceiptNumber($db, 'ZPU', '1999', 'production'),
        payNextReceiptNumber($db, 'ZPU', '1999', 'test'),
        payNextReceiptNumber($db, 'ZPU', '1999', 'simulator'),
        payNextReceiptNumber($db, 'ZPU', '1999', 'test'),
        payNextReceiptNumber($db, 'ZPU', '1999', 'production'),
    ];
    $db->rollBack();
    eq($envNumbers, ['ZPU-1999-000001', 'TEST-1999-000001', 'SIM-1999-000001', 'TEST-1999-000002', 'ZPU-1999-000002'],
        'TEST and SIMULATOR receipts count on their own; the real sequence is untouched by them');
    $db->exec("DELETE FROM payment_counters WHERE name IN ('receipt:1999', 'receipt:test:1999', 'receipt:simulator:1999')");
    ok((int) $db->query("SELECT COUNT(*) FROM payment_counters WHERE name IN ('receipt:1999', 'receipt:test:1999', 'receipt:simulator:1999')")->fetchColumn() === 0, 'a rolled-back transaction leaves no counter row behind');

    /* ── 5. Stored credentials ───────────────────────────────────────────── */
    section('5. Credentials at rest (§4.1)');
    $enc = paySecretEncrypt('working-key-1234');
    ok(str_starts_with($enc, 'sbx1:'), 'a stored secret starts with sbx1:', substr($enc, 0, 12));
    ok(!str_contains($enc, 'working-key-1234'), 'the plain text is not in the stored value');
    eq(paySecretDecrypt($enc), 'working-key-1234', 'the round trip');
    ok(paySecretEncrypt('working-key-1234') !== $enc, 'a fresh nonce every time');
    $raw = base64_decode(substr($enc, 5), true);
    $raw[30] = chr(ord($raw[30]) ^ 1);
    eq(paySecretDecrypt('sbx1:' . base64_encode($raw)), null, 'a tampered ciphertext counts as absent');
    eq(paySecretDecrypt('plain-text'), null, 'a value that is not sbx1 counts as absent');
    eq(paySecretDecrypt('sbx1:not-base64!!'), null, 'a value that is not base64 counts as absent');
    $goodKey = getenv('PAYMENTS_SETTINGS_KEY');
    putenv('PAYMENTS_SETTINGS_KEY=' . base64_encode('too-short'));
    eq(paySettingsKey(), null, 'a key that is not 32 bytes counts as missing');
    eq(paySecretDecrypt($enc), null, 'nothing decrypts without the right key');
    ok(str_contains((string) threw(fn() => paySecretEncrypt('x')), 'PAYMENTS_SETTINGS_KEY'), 'storing a credential without the key throws, naming the variable');
    putenv('PAYMENTS_SETTINGS_KEY=' . base64_encode(str_repeat('k', 31)));
    eq(paySettingsKey(), null, 'a key one byte short counts as missing');
    putenv('PAYMENTS_SETTINGS_KEY=not base64 at all!!');
    eq(paySettingsKey(), null, 'a key that is not base64 counts as missing');
    putenv('PAYMENTS_SETTINGS_KEY=' . $goodKey);
    eq(paySecretDecrypt($enc), 'working-key-1234', 'the key is back');
    eq(payCredential('test', 'working_key'), 'e2e-unit-working-key-not-secret', 'the environment wins for a credential');
    eq(payCredentialStatus('test')['working_key']['source'], 'env', 'the admin is told that key comes from the environment');
    ok(payCredentialStatus('test')['working_key']['last4'] === null, 'and it never returns the value');

    /* ── 6. Responses ────────────────────────────────────────────────────── */
    section('6. Reading a response (§4.4, §2.3)');
    $fields = ccavParseResponse('a=1&b=x=y&a=2&c=%41%42&d=100%&=skip&e&f=%E0%AE%85');
    eq($fields['a'], '2', 'a duplicate key: the last one wins');
    eq($fields['b'], 'x=y', 'an = inside a value is kept');
    eq($fields['c'], 'AB', 'a percent-encoded value is decoded');
    eq($fields['d'], '100%', 'a bare % is left alone');
    eq($fields['f'], 'அ', 'percent-encoded Tamil is decoded');
    ok(!array_key_exists('', $fields), 'an empty key is skipped');
    eq($fields['e'], '', 'a key with no = is an empty value');
    eq(ccavParseResponse(''), [], 'an empty payload parses to nothing');
    $allowed = ccavResponseAllowList(['order_id' => 'DON-1', 'card_number' => '4111111111111111', 'amount' => '10.00', 'secret' => 'x', 'tracking_id' => str_repeat('t', 300)]);
    eq(array_keys($allowed), ['order_id', 'tracking_id', 'amount'], 'only allow-listed keys are stored');
    eq(mb_strlen($allowed['tracking_id']), 255, 'a long value is cut to 255 characters');
    foreach (['Success' => 'SUCCESS', 'Failure' => 'FAILED', 'Invalid' => 'FAILED', 'Timeout' => 'FAILED', 'Aborted' => 'CANCELLED', 'Awaited' => 'PENDING', '' => 'PENDING', 'anything' => 'PENDING'] as $in => $expected) {
        eq(ccavMapRedirectStatus($in), $expected, "order_status '{$in}' maps to {$expected}");
    }
    eq(ccavMapRedirectStatus('success'), 'PENDING', 'only the exact "Success" is a success');
    eq(ccavMapRedirectStatus(null), 'PENDING', 'a missing order_status is PENDING');
    foreach (['Successful' => 'SUCCESS', 'Shipped' => 'SUCCESS', 'Unsuccessful' => 'FAILED', 'Invalid' => 'FAILED', 'Fraud' => 'FAILED', 'Auto-Cancelled' => 'FAILED', 'Auto-Reversed' => 'FAILED', 'Cancelled' => 'FAILED', 'Aborted' => 'CANCELLED', 'Initiated' => 'PENDING', 'Awaited' => 'PENDING'] as $in => $expected) {
        eq(ccavMapApiStatus($in), $expected, "the status API's '{$in}' maps to {$expected}");
    }
    foreach (['Refunded', 'System refund', 'Chargeback'] as $in) {
        eq(ccavMapApiStatus($in), null, "the status API's '{$in}' leaves the attempt alone");
    }
    eq(payRedact(['working_key' => 'x', 'a' => ['access_code' => 'y', 'ok' => str_repeat('z', 300), 'n' => 4]]), ['a' => ['ok' => str_repeat('z', 255), 'n' => 4]], 'payRedact drops credentials at every level and cuts strings');
    eq(payRedact(['card_number' => '4111', 'cvv' => '123', 'expiry' => '12/28', 'TOKEN' => 't', 'password' => 'p', 'secret' => 's']), [], 'payRedact drops card data and every credential-looking key');
    eq(payRedact([new stdClass()]), [null], 'payRedact turns an object into null');

    /* ── 7. The checkout payload ─────────────────────────────────────────── */
    section('7. The checkout payload (§4.3)');
    eq(ccavClean("A&B=C'D\"E<F>G\\H\u{1F600} I\x01J", 100), 'ABCDEFGH I J', 'ccavClean removes & = quotes < > backslash, emoji and control characters');
    eq(ccavClean('கணேஷ் குமார்', 60), 'கணேஷ் குமார்', 'Tamil letters are kept');
    eq(ccavClean('+91 98765-43210', 20, '0-9'), '919876543210', 'a pattern keeps only the digits');
    eq(mb_strlen(ccavClean(str_repeat('a', 100), 60)), 60, 'a long value is cut to its maximum');
    eq(ccavClean("two\n\nlines  here", 60), 'two lines here', 'whitespace is collapsed');
    eq(ccavCountryName('IN'), 'India', 'ISO-2 IN is India');
    eq(ccavCountryName('gb'), 'United Kingdom', 'lower case works');
    eq(ccavCountryName('ZZ'), 'India', 'an unknown country falls back to India');
    eq(ccavCountryName(null), 'India', 'so does none at all');

    /* ── 8. Validation ───────────────────────────────────────────────────── */
    section('8. payValidateDonation (§5.2)');
    $donation = static fn(array $over = []): array => array_merge([
        'category' => 'general', 'amount' => '1000', 'currency' => 'INR', 'name' => 'E2E-PAY-UNIT Donor',
        'phone' => '919876543210', 'phoneCountry' => 'IN', 'country' => 'IN', 'acceptTerms' => true, 'lang' => 'en',
    ], $over);
    $v = payValidateDonation($donation(), $cfg);
    eq($v['fields'], [], 'a complete donation has no field errors');
    eq($v['values']['amount'], '1000.00', 'the amount is normalised');
    eq($v['values']['category'], 'general', 'the category slug is kept');
    ok(($v['values']['category_id'] ?? 0) > 0, 'the category id is resolved');
    $v = payValidateDonation($donation(['pan' => ' abcde1234f ', 'email' => 'E2E-Pay@Example.TEST', 'postcode' => '627719', 'showNamePublicly' => '1']), $cfg);
    ok($v['fields'] === [] && $v['values']['pan'] === 'ABCDE1234F' && $v['values']['email'] === 'e2e-pay@example.test' && $v['values']['show_name_publicly'] === true, 'PAN and email are normalised, consent is read', json_encode($v['fields']));
    foreach ([
        ['no category', ['category' => ''], 'category'],
        ['an unknown category', ['category' => 'not-a-purpose'], 'category'],
        ['a category as an array', ['category' => ['general']], 'category'],
        ['no amount', ['amount' => ''], 'amount'],
        ['an amount below the minimum', ['amount' => '0'], 'amount'],
        ['an amount above the maximum', ['amount' => '500001'], 'amount'],
        ['an amount with three decimals', ['amount' => '10.005'], 'amount'],
        ['an amount as an array', ['amount' => ['10']], 'amount'],
        ['an amount as an object', ['amount' => ['a' => 1]], 'amount'],
        ['a negative amount', ['amount' => '-10'], 'amount'],
        ['a name of one character', ['name' => 'A'], 'name'],
        ['a name of 101 characters', ['name' => str_repeat('அ', 101)], 'name'],
        ['a name as a number', ['name' => ['x']], 'name'],
        ['no phone', ['phone' => ''], 'phone'],
        ['a phone as an array', ['phone' => ['919876543210']], 'phone'],
        ['an Indian number of nine digits', ['phone' => '91987654321'], 'phone'],
        ['an Indian number with a leading zero', ['phone' => '910987654321'], 'phone'],
        ['a number that is not in its country code', ['phone' => '449876543210'], 'phone'],
        ['no country', ['country' => ''], 'country'],
        ['a country written out', ['country' => 'India'], 'country'],
        ['a country as an array', ['country' => ['IN']], 'country'],
        ['an email that is not an address', ['email' => 'not-an-email'], 'email'],
        ['an email as an array', ['email' => ['a@b.test']], 'email'],
        ['an Indian PIN of five digits', ['postcode' => '62771'], 'postcode'],
        ['a postcode as an array', ['postcode' => ['627719']], 'postcode'],
        ['a PAN of the wrong shape', ['pan' => 'ABCD1234F'], 'pan'],
        ['an address of 251 characters', ['address' => str_repeat('a', 251)], 'address'],
        ['a message of 501 characters', ['message' => str_repeat('m', 501)], 'message'],
        ['a note of 501 characters', ['notes' => str_repeat('n', 501)], 'notes'],
        ['terms not accepted', ['acceptTerms' => false], 'acceptTerms'],
        ['terms accepted with "yes"', ['acceptTerms' => 'yes'], 'acceptTerms'],
        ['an unsupported currency', ['currency' => 'ZWL'], 'currency'],
        ['a currency as an array', ['currency' => ['USD']], 'currency'],
    ] as [$label, $over, $key]) {
        $result = payValidateDonation($donation($over), $cfg);
        ok(isset($result['fields'][$key]) && $result['fields'][$key] !== '', "{$label} → a field error on \"{$key}\"", json_encode($result['fields']));
    }
    $hostile = payValidateDonation(['category' => ['x'], 'amount' => ['1'], 'name' => ['n'], 'phone' => [], 'phoneCountry' => ['IN'], 'country' => 5, 'email' => ['e'], 'pan' => [], 'message' => ['m'], 'notes' => ['n'], 'acceptTerms' => ['1']], $cfg);
    ok(count($hostile['fields']) >= 8, 'a body of arrays and objects answers with field errors, never an exception', implode(',', array_keys($hostile['fields'])));
    eq(payValidateDonation([], $cfg)['fields']['amount'] ?? null, 'Enter the amount you would like to give.', 'an empty body names the amount');
    $usd = payValidateDonation($donation(['currency' => 'USD', 'amount' => '10000', 'country' => 'US', 'phone' => '12025550123', 'phoneCountry' => 'US']), $cfg);
    eq($usd['fields'], [], 'USD 10000 is inside the foreign maximum');
    $usdOver = payValidateDonation($donation(['currency' => 'USD', 'amount' => '10001', 'country' => 'US', 'phone' => '12025550123', 'phoneCountry' => 'US']), $cfg);
    ok(isset($usdOver['fields']['amount']) && str_contains($usdOver['fields']['amount'], 'USD'), 'USD 10001 is over it, and the message says so', json_encode($usdOver['fields']));
    $usdSmall = payValidateDonation($donation(['currency' => 'USD', 'amount' => '0.50', 'country' => 'US', 'phone' => '12025550123', 'phoneCountry' => 'US']), $cfg);
    ok(isset($usdSmall['fields']['amount']), 'less than one unit of a foreign currency is refused');
    $jpy = payValidateDonation($donation(['currency' => 'JPY', 'amount' => '3000']), $cfg);
    eq($jpy['fields'], [], 'JPY 3000 is accepted');
    $jpyPaise = payValidateDonation($donation(['currency' => 'JPY', 'amount' => '3000.50']), $cfg);
    ok(isset($jpyPaise['fields']['amount']) && str_contains($jpyPaise['fields']['amount'], 'whole'), 'JPY with decimals is refused', json_encode($jpyPaise['fields']));
    $domestic = array_merge($cfg, ['international' => false, 'currencies' => ['INR']]);
    $refused = payValidateDonation($donation(['currency' => 'USD']), $domestic);
    ok(isset($refused['fields']['currency']) && str_contains($refused['fields']['currency'], 'INR'), 'with international off, only INR is accepted', json_encode($refused['fields']));
    eq(payValidateDonation($donation(), $domestic)['fields'], [], 'INR still works with international off');

    section('8b. payValidateSevaBooking (§5.2)');
    $sevaRow = $db->query('SELECT id, amount FROM sevas WHERE is_active = 1 AND amount > 0 ORDER BY id LIMIT 1')->fetch(PDO::FETCH_ASSOC);
    if ($sevaRow === false) {
        ok(false, 'the sevas table has an active seva with a price to test against');
    } else {
        $sevaId = (int) $sevaRow['id'];
        $price = payAmountFormat((string) $sevaRow['amount'], 'INR');
        $booking = static fn(array $over = []): array => array_merge([
            'seva_id' => $sevaId, 'devotee_name' => 'E2E-PAY-UNIT Devotee', 'phone' => '919876543210',
            'phoneCountry' => 'IN', 'acceptTerms' => true, 'lang' => 'ta',
        ], $over);
        $b = payValidateSevaBooking($booking(), $cfg);
        eq($b['fields'], [], 'a complete seva booking has no field errors');
        eq($b['values']['amount'], $price, 'the price comes from the database');
        eq($b['values']['currency'], 'INR', 'a seva is paid in INR');
        $tampered = payValidateSevaBooking($booking(['amount' => '1', 'currency' => 'USD']), $cfg);
        ok($tampered['values']['amount'] === $price && $tampered['values']['currency'] === 'INR', 'an amount and currency posted with the booking are ignored');
        foreach ([
            ['no seva', ['seva_id' => null], 'seva_id'],
            ['an unknown seva', ['seva_id' => 99999999], 'seva_id'],
            ['a seva id as an array', ['seva_id' => [1]], 'seva_id'],
            ['a name of one character', ['devotee_name' => 'A'], 'devotee_name'],
            ['a date in the past', ['preferred_date' => '2020-01-01'], 'preferred_date'],
            ['a date that is not a date', ['preferred_date' => '14-09-2026'], 'preferred_date'],
            ['a date more than a year ahead', ['preferred_date' => (new DateTimeImmutable(payIstDate(null, 'Y-m-d')))->modify('+366 days')->format('Y-m-d')], 'preferred_date'],
            ['a date as an array', ['preferred_date' => ['2026-09-20']], 'preferred_date'],
            ['terms not accepted', ['acceptTerms' => null], 'acceptTerms'],
        ] as [$label, $over, $key]) {
            $result = payValidateSevaBooking($booking($over), $cfg);
            ok(isset($result['fields'][$key]), "seva: {$label} → a field error on \"{$key}\"", json_encode($result['fields']));
        }
        $today = payValidateSevaBooking($booking(['preferred_date' => payIstDate(null, 'Y-m-d')]), $cfg);
        eq($today['fields'], [], 'today is an acceptable preferred date');
        $sevaOff = array_merge($cfg, ['seva_online' => false]);
        ok(isset(payValidateSevaBooking($booking(), $sevaOff)['fields']['seva_id']), 'with seva payments off, the seva field says so');
    }

    /* ── 9. The transition table on real rows ────────────────────────────── */
    section('9. Attempt transitions (§2.4)');
    foreach ([
        ['INITIATED', 'PENDING', '', true],
        ['INITIATED', 'SUCCESS', '', true],
        ['INITIATED', 'FAILED', '', true],
        ['INITIATED', 'CANCELLED', '', true],
        ['PENDING', 'SUCCESS', '', true],
        ['PENDING', 'FAILED', '', true],
        ['PENDING', 'CANCELLED', '', true],
        ['PENDING', 'INITIATED', '', false],
        ['SUCCESS', 'FAILED', 'status_api', false],
        ['SUCCESS', 'PENDING', '', false],
        ['SUCCESS', 'SUCCESS', '', false],
        ['FAILED', 'SUCCESS', '', false],
        ['FAILED', 'SUCCESS', 'callback', false],
        ['FAILED', 'SUCCESS', 'status_api', true],
        ['CANCELLED', 'SUCCESS', 'status_api', true],
        ['FAILED', 'CANCELLED', '', false],
        ['CANCELLED', 'PENDING', '', false],
    ] as [$from, $to, $verification, $expected]) {
        eq(payTransitionAllowed($from, $to, $verification), $expected, "{$from} → {$to}" . ($verification !== '' ? " with {$verification}" : '') . ' is ' . ($expected ? 'allowed' : 'refused'));
    }

    $makeDonation = static function (string $label, string $amount = '1001') use ($db, $cfg, $NAME): array {
        $checked = payValidateDonation([
            'category' => 'general', 'amount' => $amount, 'currency' => 'INR', 'name' => "{$NAME} {$label}",
            'phone' => '919876543210', 'phoneCountry' => 'IN', 'country' => 'IN', 'acceptTerms' => true, 'lang' => 'en',
        ], $cfg);
        if ($checked['fields']) throw new RuntimeException('fixture donation refused: ' . json_encode($checked['fields']));
        return payCreateDonation($db, $checked['values'], $cfg, '10.83.0.9');
    };
    $applyTo = static function (string $orderId, string $status, array $facts = []) use ($db): array {
        return payTransaction($db, static function (PDO $db) use ($orderId, $status, $facts): array {
            $attempt = payLoadAttemptForUpdate($db, $orderId);
            return payStateApply($db, $attempt, $status, $facts, 'gateway');
        });
    };
    $attemptRow = static function (string $orderId) use ($db): array {
        $stmt = $db->prepare('SELECT * FROM payment_transactions WHERE order_id = :o');
        $stmt->execute([':o' => $orderId]);
        return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
    };

    $created = $makeDonation('paid');
    $paidNumber = $created['payable']['number'];
    $paidOrder = $created['attempt']['order_id'];
    eq($created['payable']['status'], 'INITIATED', 'a new payable is INITIATED');
    eq($created['attempt']['status'], 'INITIATED', 'so is its first attempt');
    eq($created['attempt']['environment'], 'test', "the attempt records the mode it was made in");
    eq($created['attempt']['amount'], '1001.00', 'the attempt copies the amount');
    $applied = $applyTo($paidOrder, 'SUCCESS', ['responded' => true, 'verification' => 'callback', 'channel' => 'response', 'tracking_id' => '100000000001', 'payment_mode' => 'UPI', 'gateway_status' => 'Success']);
    $receiptsIssued++;
    ok($applied['changed'] && $applied['firstSuccess'] && preg_match(PAY_RECEIPT_PATTERN, (string) $applied['receiptNumber']) === 1, 'the first SUCCESS assigns a receipt number', json_encode($applied));
    ok(str_starts_with((string) $applied['receiptNumber'], 'TEST-' . $istYear . '-'), "a TEST-mode payment's receipt is numbered TEST-…, off the temple's sequence", (string) $applied['receiptNumber']);
    $paid = payLoadPayable($db, $paidNumber);
    ok($paid['status'] === 'SUCCESS' && $paid['receipt_number'] === $applied['receiptNumber'] && $paid['paid_at'] !== null, 'the payable is SUCCESS with paid_at', json_encode([$paid['status'], $paid['receipt_number'], $paid['paid_at']]));
    $again = $applyTo($paidOrder, 'SUCCESS', ['responded' => true, 'verification' => 'callback', 'channel' => 'response']);
    ok(!$again['changed'] && !$again['firstSuccess'], 'a repeated SUCCESS changes nothing');
    $row = $attemptRow($paidOrder);
    eq((int) $row['response_count'], 2, 'but it counts as a second response');
    eq(payLoadPayable($db, $paidNumber)['receipt_number'], $applied['receiptNumber'], 'and the receipt number is unchanged');
    $events = $db->query("SELECT event FROM payment_audit_log WHERE transaction_id = {$row['id']} ORDER BY id")->fetchAll(PDO::FETCH_COLUMN);
    ok(in_array('response_duplicate', $events, true), 'the repeat is audited as response_duplicate', implode(',', $events));
    ok(in_array('receipt_assigned', $db->query("SELECT event FROM payment_audit_log WHERE payable_type = 'donation' AND payable_id = {$paid['id']}")->fetchAll(PDO::FETCH_COLUMN), true), 'the receipt is audited');
    $late = $applyTo($paidOrder, 'FAILED', ['responded' => true, 'gateway_status' => 'Failure', 'failure_message' => 'Late decline']);
    ok(!$late['changed'] && payLoadPayable($db, $paidNumber)['status'] === 'SUCCESS', 'a later FAILED response cannot undo a SUCCESS');
    $lateRow = $attemptRow($paidOrder);
    ok($lateRow['gateway_status'] === 'Success' && $lateRow['failure_message'] === null, 'and the refused response relabels nothing: gateway_status still says Success', json_encode([$lateRow['gateway_status'], $lateRow['failure_message']]));

    $failed = $makeDonation('late', '750.50');
    $failedOrder = $failed['attempt']['order_id'];
    $applyTo($failedOrder, 'FAILED', ['responded' => true, 'failure_message' => 'Simulated decline']);
    eq(payLoadPayable($db, $failed['payable']['number'])['status'], 'FAILED', 'a FAILED attempt makes the payable FAILED');
    $notApplied = $applyTo($failedOrder, 'SUCCESS', ['responded' => true, 'verification' => 'callback']);
    ok(!$notApplied['changed'], 'a callback success on a FAILED attempt is not applied');
    ok((int) $attemptRow($failedOrder)['needs_review'] === 1, 'but it is flagged for review, so late money is visible');
    eq(payLoadPayable($db, $failed['payable']['number'])['status'], 'FAILED', 'and the payable stays FAILED');
    $verified = $applyTo($failedOrder, 'SUCCESS', ['verification' => 'status_api', 'verified' => true, 'checked' => true]);
    $receiptsIssued++;
    ok($verified['changed'] && $verified['firstSuccess'], 'the same success, confirmed by the status API, is applied');
    eq($attemptRow($failedOrder)['verification'], 'status_api', 'and the evidence is recorded');

    $double = $makeDonation('double');
    $doubleNumber = $double['payable']['number'];
    $applyTo($double['attempt']['order_id'], 'FAILED', ['responded' => true]);
    $second = payCreateAttempt($db, 'donation', payLoadPayable($db, $doubleNumber), 'test', 'en', '10.83.0.9');
    eq($second['order_id'], $doubleNumber . '-R2', 'a retry gets the -R2 order id');
    eq(payLoadPayable($db, $doubleNumber)['status'], 'INITIATED', 'and puts the payable back to INITIATED');
    $applyTo($double['attempt']['order_id'], 'SUCCESS', ['verification' => 'status_api', 'verified' => true]);
    $receiptsIssued++;
    $twice = $applyTo($second['order_id'], 'SUCCESS', ['responded' => true, 'verification' => 'status_api', 'verified' => true]);
    ok($twice['changed'] && $twice['doublePayment'] && !$twice['firstSuccess'], 'a second SUCCESS attempt is a double payment', json_encode($twice));
    $doublePayable = payLoadPayable($db, $doubleNumber);
    eq($doublePayable['status'], 'SUCCESS', 'the payable stays SUCCESS once');
    ok((int) $attemptRow($second['order_id'])['needs_review'] === 1, 'the second attempt is flagged for review');
    $doubleEvents = $db->query("SELECT event FROM payment_audit_log WHERE transaction_id = {$attemptRow($second['order_id'])['id']}")->fetchAll(PDO::FETCH_COLUMN);
    ok(in_array('double_payment', $doubleEvents, true), 'and audited as double_payment', implode(',', $doubleEvents));
    eq((int) $db->query("SELECT COUNT(DISTINCT receipt_number) FROM donations WHERE id = {$doublePayable['id']}")->fetchColumn(), 1, 'never a second receipt');

    section('9b. Attempt limits and the retry clock (§2.4)');
    $limited = $makeDonation('limit');
    $limitNumber = $limited['payable']['number'];
    for ($i = 2; $i <= PAY_MAX_ATTEMPTS; $i++) {
        payCreateAttempt($db, 'donation', payLoadPayable($db, $limitNumber), 'test', 'en', '10.83.0.9');
    }
    eq(count(payLoadPayable($db, $limitNumber)['attempts']), PAY_MAX_ATTEMPTS, 'five attempts can be made');
    ok(str_contains((string) threw(fn() => payCreateAttempt($db, 'donation', payLoadPayable($db, $limitNumber), 'test', 'en', '10.83.0.9')), 'PayLimitException'), 'the sixth throws PayLimitException');
    ok(!payCanRetry(payLoadPayable($db, $limitNumber)), 'and the donor is not offered a retry');
    $clock = $makeDonation('clock');
    $clockPayable = payLoadPayable($db, $clock['payable']['number']);
    ok(!payCanRetry($clockPayable), 'a payment started a moment ago cannot be retried yet');
    ok(payCanRetry($clockPayable, time() + 121), 'after two minutes an INITIATED attempt can be retried');
    $applyTo($clock['attempt']['order_id'], 'PENDING', ['responded' => true]);
    $pendingPayable = payLoadPayable($db, $clock['payable']['number']);
    ok(!payCanRetry($pendingPayable, time() + 121), 'a PENDING attempt waits fifteen minutes');
    ok(payCanRetry($pendingPayable, time() + 901), 'and can be retried after them');
    $applyTo($clock['attempt']['order_id'], 'CANCELLED', ['responded' => true]);
    ok(payCanRetry(payLoadPayable($db, $clock['payable']['number'])), 'a cancelled payment can be retried at once');
    ok(!payCanRetry(payLoadPayable($db, $paidNumber)), 'a paid one never can');

    section('9c. A seva booking the office cancelled cannot be paid for (§2.4, §9.1)');
    if ($sevaRow === false) {
        ok(false, 'an active priced seva is needed for the booking checks');
    } else {
        $makeBooking = static function (string $label) use ($db, $cfg, $NAME, $sevaId): array {
            $checked = payValidateSevaBooking([
                'seva_id' => $sevaId, 'devotee_name' => "{$NAME} {$label}", 'phone' => '919876543210',
                'phoneCountry' => 'IN', 'acceptTerms' => true, 'lang' => 'en',
            ], $cfg);
            if ($checked['fields']) throw new RuntimeException('fixture booking refused: ' . json_encode($checked['fields']));
            return payCreateSevaBooking($db, $checked['values'], $cfg, '10.83.0.9');
        };
        $setBooking = static function (int $id, string $status) use ($db): void {
            $db->prepare('UPDATE seva_bookings SET status = :s WHERE id = :id')->execute([':s' => $status, ':id' => $id]);
        };
        $office = $makeBooking('office cancel');
        $officeNumber = $office['payable']['number'];
        $applyTo($office['attempt']['order_id'], 'FAILED', ['responded' => true]);
        ok(payCanRetry(payLoadPayable($db, $officeNumber)), 'a declined booking payment can be tried again');
        $setBooking($office['payable']['id'], 'cancelled');
        $officePayable = payLoadPayable($db, $officeNumber);
        ok($officePayable['booking_status'] === 'cancelled' && $officePayable['cancelled_by_hold'] === false && !payCanRetry($officePayable), 'not once the office has cancelled the booking');

        $held = $makeBooking('hold expiry');
        $heldNumber = $held['payable']['number'];
        $applyTo($held['attempt']['order_id'], 'FAILED', ['responded' => true]);
        $setBooking($held['payable']['id'], 'cancelled');
        payAudit($db, 'hold_expired', ['payable_type' => 'seva_booking', 'payable_id' => $held['payable']['id'], 'actor' => 'cron', 'ip' => null, 'detail' => 'unit fixture: hold expired']);
        $heldPayable = payLoadPayable($db, $heldNumber);
        ok($heldPayable['cancelled_by_hold'] === true && payCanRetry($heldPayable), 'a booking cancelled only because its payment hold expired can still be paid');
        $applyTo($held['attempt']['order_id'], 'SUCCESS', ['verification' => 'status_api', 'verified' => true, 'checked' => true]);
        $receiptsIssued++;
        $restored = payLoadPayable($db, $heldNumber);
        ok($restored['status'] === 'SUCCESS' && $restored['booking_status'] === 'pending', 'and paying it puts the booking back to pending');
        $setBooking($held['payable']['id'], 'cancelled'); // the office cancels the restored booking
        payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'seva_booking', $held['payable']['id'], 'e2e'));
        eq(payLoadPayable($db, $heldNumber)['booking_status'], 'cancelled', "an office cancellation after the restore is the office's decision: re-deriving the payable does not undo it");
    }

    /* ── 10. Refunds ─────────────────────────────────────────────────────── */
    section('10. Refund arithmetic (§8)');
    $refundPayable = payLoadPayable($db, $paidNumber);
    $successAttempt = paySuccessAttempt($refundPayable);
    eq(payRefundableAmount($db, $refundPayable, $successAttempt), '1001.00', 'the whole amount can be refunded at first');
    $refundInsert = $db->prepare(
        "INSERT INTO payment_refunds (transaction_id, refund_reference, amount, currency, kind, reason, method, status, requested_by, created_at, updated_at)
         VALUES (:t, :ref, :a, 'INR', :k, 'E2E-PAY-UNIT refund', 'manual', :s, 'e2e', UTC_TIMESTAMP(), UTC_TIMESTAMP())"
    );
    $refundInsert->execute([':t' => $successAttempt['id'], ':ref' => "RFU{$run}A", ':a' => '200.00', ':k' => 'partial', ':s' => 'SUCCESS']);
    payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'donation', $refundPayable['id'], 'e2e'));
    $after = payLoadPayable($db, $paidNumber);
    eq($after['amount_refunded'], '200.00', 'amount_refunded follows the SUCCESS refunds');
    eq($after['status'], 'PARTIALLY_REFUNDED', 'and the payable is PARTIALLY_REFUNDED');
    eq(payRefundableAmount($db, $after, paySuccessAttempt($after)), '801.00', 'what is left can still be refunded');
    $refundInsert->execute([':t' => $successAttempt['id'], ':ref' => "RFU{$run}B", ':a' => '100.00', ':k' => 'partial', ':s' => 'REQUESTED']);
    payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'donation', $refundPayable['id'], 'e2e'));
    $waiting = payLoadPayable($db, $paidNumber);
    eq($waiting['status'], 'REFUND_INITIATED', 'a refund still waiting makes the payable REFUND_INITIATED');
    eq(payRefundableAmount($db, $waiting, paySuccessAttempt($waiting)), '701.00', 'a requested refund is already held back');
    $db->prepare('UPDATE payment_refunds SET status = :s WHERE refund_reference = :r')->execute([':s' => 'FAILED', ':r' => "RFU{$run}B"]);
    payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'donation', $refundPayable['id'], 'e2e'));
    eq(payLoadPayable($db, $paidNumber)['status'], 'PARTIALLY_REFUNDED', 'a failed refund gives the payable its paid state back');
    eq(payRefundableAmount($db, payLoadPayable($db, $paidNumber), paySuccessAttempt(payLoadPayable($db, $paidNumber))), '801.00', 'and releases the amount it held');
    $refundInsert->execute([':t' => $successAttempt['id'], ':ref' => "RFU{$run}C", ':a' => '801.00', ':k' => 'partial', ':s' => 'SUCCESS']);
    payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'donation', $refundPayable['id'], 'e2e'));
    $full = payLoadPayable($db, $paidNumber);
    eq($full['status'], 'REFUNDED', 'refunding the rest makes it REFUNDED');
    eq($full['amount_refunded'], '1001.00', 'with the whole amount recorded');
    eq(payRefundableAmount($db, $full, paySuccessAttempt($full)), '0.00', 'and nothing left to refund');
    $notPaid = payLoadPayable($db, $clock['payable']['number']);
    eq(payRefundableAmount($db, $notPaid, $notPaid['attempts'][0]), '0.00', 'an unpaid attempt can never be refunded');

    section('10b. A double payment is refunded against its extra attempt (§2.4, §8)');
    // Attempt 1 is declined, the retry pays and earns the receipt, then CCAvenue reports attempt 1 paid after all.
    $ld = $makeDonation('late double', '600');
    $ldNumber = $ld['payable']['number'];
    $applyTo($ld['attempt']['order_id'], 'FAILED', ['responded' => true]);
    $ldR2 = payCreateAttempt($db, 'donation', payLoadPayable($db, $ldNumber), 'test', 'en', '10.83.0.9');
    $ldFirst = $applyTo($ldR2['order_id'], 'SUCCESS', ['responded' => true, 'verification' => 'status_api', 'verified' => true]);
    $receiptsIssued++;
    $ldLate = $applyTo($ld['attempt']['order_id'], 'SUCCESS', ['verification' => 'status_api', 'verified' => true, 'checked' => true]);
    ok($ldFirst['firstSuccess'] && $ldLate['doublePayment'] && !$ldLate['firstSuccess'], 'the retry paid first; attempt 1 turned out paid too', json_encode([$ldFirst, $ldLate]));
    $ldPayable = payLoadPayable($db, $ldNumber);
    eq($ldPayable['receipt_attempt_id'], (int) $ldR2['id'], 'the receipt attempt is the one that earned the receipt (the retry), not the lowest attempt number');
    eq(paySuccessAttempt($ldPayable)['order_id'], $ldR2['order_id'], 'paySuccessAttempt() returns that attempt');
    $ldExtra = $ldPayable['attempts'][0];
    eq(payRefundableAmount($db, $ldPayable, $ldExtra), '600.00', 'the extra attempt can be refunded in full');
    $kpiBefore = payAdminKpis($db, ['kind' => 'donation'])['received']['total']['inr'];
    $refundInsert->execute([':t' => $ldExtra['id'], ':ref' => "RFU{$run}D", ':a' => '600.00', ':k' => 'full', ':s' => 'SUCCESS']);
    payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'donation', $ldPayable['id'], 'e2e'));
    $ldAfter = payLoadPayable($db, $ldNumber);
    eq([$ldAfter['status'], $ldAfter['amount_refunded']], ['SUCCESS', '0.00'], 'refunding the extra attempt leaves the payable SUCCESS with nothing refunded against the receipt');
    eq(payRefundableAmount($db, $ldAfter, $ldExtra), '0.00', 'the extra attempt has nothing left to refund');
    eq(payRefundableAmount($db, $ldAfter, paySuccessAttempt($ldAfter)), '600.00', 'the receipt attempt is still refundable in full');
    $kpiAfterExtra = payAdminKpis($db, ['kind' => 'donation'])['received']['total']['inr'];
    eq(payAmountCents($kpiBefore) - payAmountCents($kpiAfterExtra), 60000, 'the Received KPI drops by the extra payment only: it counted both payments and now counts the kept one');
    $report = payReconcileReport($db, ['kind' => 'donation']);
    $dp = array_values(array_filter($report['sections']['double_payments']['rows'], static fn(array $r): bool => ($r['number'] ?? '') === $ldNumber));
    ok(count($dp) === 2 && (int) $dp[0]['is_receipt'] === 0 && str_contains($dp[0]['detail'], 'refunded in full') && (int) $dp[1]['is_receipt'] === 1 && str_contains($dp[1]['detail'], 'keep it'),
        'reconciliation lists both attempts: the extra one as refunded in full, the receipt one to keep', json_encode(array_map(static fn(array $r): array => [$r['order_id'], $r['is_receipt'], $r['detail']], $dp)));
    eq(array_values(array_filter($report['sections']['refund_mismatches']['rows'], static fn(array $r): bool => ($r['number'] ?? '') === $ldNumber)), [], 'and reports no refund mismatch for it');
    $refundInsert->execute([':t' => $ldR2['id'], ':ref' => "RFU{$run}E", ':a' => '600.00', ':k' => 'full', ':s' => 'SUCCESS']);
    payTransaction($db, static fn(PDO $db) => payDerivePayable($db, 'donation', $ldPayable['id'], 'e2e'));
    $ldDone = payLoadPayable($db, $ldNumber);
    eq([$ldDone['status'], $ldDone['amount_refunded']], ['REFUNDED', '600.00'], 'refunding the receipt attempt is what makes the payable REFUNDED');
    $kpiAfterAll = payAdminKpis($db, ['kind' => 'donation'])['received']['total']['inr'];
    eq(payAmountCents($kpiBefore) - payAmountCents($kpiAfterAll), 120000, 'and the KPI no longer counts the payment at all');

    /* ── 11. Masks and the donor's view ──────────────────────────────────── */
    section('11. What a donor sees (§5.5)');
    eq(payMaskEmail('kavitha@gmail.com'), 'k•••@gmail.com', 'an email is masked');
    eq(payMaskEmail(''), null, 'no email masks to null');
    eq(payMaskEmail('not-an-email'), null, 'text that is not an address masks to null');
    eq(payMaskPan('ABCDE1234F'), 'ABCDE••••F', 'a PAN keeps its first five and last character');
    eq(payMaskPan(null), null, 'no PAN masks to null');
    eq(payMaskName('Sundar Kumar'), 'S•••• K••••', 'a donor name is masked to initials');
    eq(payMaskName('   '), 'Devotee', 'an empty name masks to Devotee');
    $view = payPublicView($db, payLoadPayable($db, $paidNumber), true);
    ok(!str_contains(json_encode($view), 'working-key') && !str_contains(json_encode($view), 'E2EUNITACCESS'), 'the receipt view carries no credential');
    ok(str_contains((string) $view['verifyUrl'], '/payment/verify?r='), 'the receipt carries its verification link', (string) $view['verifyUrl']);
    $verifyQuery = [];
    parse_str((string) parse_url((string) $view['verifyUrl'], PHP_URL_QUERY), $verifyQuery);
    ok(payVerifyTokenValid((string) $verifyQuery['r'], $verifyQuery['v'] ?? null), 'and its token verifies');
    eq(payVerifyLookup($db, $verifyQuery['r'], 'AAAAAAAAAA')['valid'], false, 'a wrong verify token answers valid:false');
    eq(payVerifyLookup($db, 'NOT-A-RECEIPT', $verifyQuery['v'])['valid'], false, 'so does a receipt number of the wrong shape');
    $lookup = payVerifyLookup($db, $verifyQuery['r'], $verifyQuery['v']);
    ok(($lookup['valid'] ?? false) === true && $lookup['donor'] === 'Anonymous devotee', 'a donor who did not tick the list is anonymous on the QR check', json_encode($lookup));
} catch (Throwable $e) {
    ok(false, 'the suite ran to the end', get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
} finally {
    section('Cleanup');
    try {
        $removed = unitCleanup($db, "{$PREFIX} %");
        echo '  removed ' . json_encode($removed) . "\n";
        $left = (int) $db->query("SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE '{$PREFIX} %') + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE '{$PREFIX} %')")->fetchColumn();
        ok($left === 0, 'cleanup removed every row this run created', "{$left} left");
        // Give the receipt numbers back, but only if no one else issued one meanwhile.
        $nowStmt = $db->prepare('SELECT value FROM payment_counters WHERE name = :n');
        $nowStmt->execute([':n' => $counterName]);
        $now = $nowStmt->fetchColumn();
        $now = $now === false ? null : (int) $now;
        if ($now !== null && $now === ($counterBefore ?? 0) + $receiptsIssued) {
            if ($counterBefore === null) $db->prepare('DELETE FROM payment_counters WHERE name = :n')->execute([':n' => $counterName]);
            else $db->prepare('UPDATE payment_counters SET value = :v WHERE name = :n')->execute([':v' => $counterBefore, ':n' => $counterName]);
            echo "  {$counterName} put back to " . ($counterBefore ?? '(absent)') . " (this run issued {$receiptsIssued})\n";
        } else {
            echo "  {$counterName} left at " . var_export($now, true) . " (before " . var_export($counterBefore, true) . ", this run issued {$receiptsIssued})\n";
        }
    } catch (Throwable $e) {
        ok(false, 'cleanup ran', $e->getMessage());
    }
}

echo "\n{$passed} passed, " . count($failures) . " failed\n";
if ($failures) {
    echo "\nFailures:\n";
    foreach ($failures as $f) echo "  - {$f}\n";
}
exit($failures ? 1 : 0);
