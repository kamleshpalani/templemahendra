<?php
/**
 * backend/includes/payments/config.php — gateway settings, stored credentials
 * and whether payments can start (docs/payments/SPEC.md §4.1, §4.2, §11).
 *
 * Three sources, in this order of strength:
 *   1. Environment variables. A credential in the environment always wins over
 *      one stored from the admin (the admin shows it as read-only).
 *   2. payment_settings rows. Secrets are stored encrypted with
 *      sodium_crypto_secretbox under PAYMENTS_SETTINGS_KEY ("sbx1:" + base64 of
 *      nonce ‖ ciphertext); without that key nothing secret can be stored and a
 *      value that fails to decrypt counts as absent.
 *   3. Built-in defaults, identical to the migration's seeds.
 *
 * PAYMENTS_SETTINGS_OVERLAY (a JSON object of non-secret keys) overlays the
 * table for one PHP process, and only when PAYMENTS_ALLOW_SIMULATOR=1, so test
 * suites never change the shared rows.
 *
 * Credentials live only in PHP memory: nothing here returns them to a browser,
 * a log or the audit table. payPublicConfig() is the only shape that leaves.
 */

const PAY_MODES = ['test', 'production', 'simulator'];
const PAY_ATTEMPT_STATUSES = ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'];
const PAY_PAYABLE_STATUSES = ['INITIATED', 'PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUND_INITIATED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
/** Payable statuses that mean "money was received" (receipts, reports). */
const PAY_PAID_STATUSES = ['SUCCESS', 'REFUND_INITIATED', 'PARTIALLY_REFUNDED', 'REFUNDED'];

/** Non-secret settings and their defaults (the migration seeds the same values). */
const PAY_SETTING_DEFAULTS = [
    'enabled'               => '0',
    'mode'                  => 'test',
    'default_currency'      => 'INR',
    'currencies'            => 'INR',
    'international_enabled' => '0',
    'receipt_prefix'        => 'TMR',
    'donation_min'          => '1',
    'donation_max'          => '500000',
    'donation_max_foreign'  => '10000',
    'preset_amounts'        => '500,1000,2500,5000,10000',
    'notify_email'          => '1',
    'notify_sms'            => '0',
    'notify_whatsapp'       => '1',
    'seva_online_enabled'   => '0',
    'hold_minutes'          => '30',
];

/** Setting keys stored encrypted. */
const PAY_SECRET_KEYS = [
    'test_merchant_id', 'test_access_code', 'test_working_key', 'test_api_access_code', 'test_api_working_key',
    'prod_merchant_id', 'prod_access_code', 'prod_working_key', 'prod_api_access_code', 'prod_api_working_key',
];

/** The credential fields of one gateway environment. */
const PAY_CREDENTIAL_FIELDS = ['merchant_id', 'access_code', 'working_key', 'api_access_code', 'api_working_key'];

/** Environment variable per environment and field. */
const PAY_CREDENTIAL_ENV = [
    'test' => [
        'merchant_id'     => 'CCAVENUE_TEST_MERCHANT_ID',
        'access_code'     => 'CCAVENUE_TEST_ACCESS_CODE',
        'working_key'     => 'CCAVENUE_TEST_WORKING_KEY',
        'api_access_code' => 'CCAVENUE_TEST_API_ACCESS_CODE',
        'api_working_key' => 'CCAVENUE_TEST_API_WORKING_KEY',
    ],
    'production' => [
        'merchant_id'     => 'CCAVENUE_MERCHANT_ID',
        'access_code'     => 'CCAVENUE_ACCESS_CODE',
        'working_key'     => 'CCAVENUE_WORKING_KEY',
        'api_access_code' => 'CCAVENUE_API_ACCESS_CODE',
        'api_working_key' => 'CCAVENUE_API_WORKING_KEY',
    ],
];

/** payment_settings key prefix per environment ("test_working_key", "prod_working_key"). */
const PAY_CREDENTIAL_PREFIX = ['test' => 'test_', 'production' => 'prod_'];

/** The currencies the site can offer, ISO 4217. INR is always on. */
const PAY_SUPPORTED_CURRENCIES = [
    'INR' => ['decimals' => 2, 'name' => 'Indian Rupee'],
    'USD' => ['decimals' => 2, 'name' => 'US Dollar'],
    'GBP' => ['decimals' => 2, 'name' => 'British Pound'],
    'EUR' => ['decimals' => 2, 'name' => 'Euro'],
    'CAD' => ['decimals' => 2, 'name' => 'Canadian Dollar'],
    'AUD' => ['decimals' => 2, 'name' => 'Australian Dollar'],
    'SGD' => ['decimals' => 2, 'name' => 'Singapore Dollar'],
    'AED' => ['decimals' => 2, 'name' => 'UAE Dirham'],
    'SAR' => ['decimals' => 2, 'name' => 'Saudi Riyal'],
    'MYR' => ['decimals' => 2, 'name' => 'Malaysian Ringgit'],
    'JPY' => ['decimals' => 0, 'name' => 'Japanese Yen'],
    'NZD' => ['decimals' => 2, 'name' => 'New Zealand Dollar'],
    'CHF' => ['decimals' => 2, 'name' => 'Swiss Franc'],
];

/** CCAvenue's addresses (research §1, §5). The simulator's are built from siteUrl(). */
const PAY_GATEWAY_URLS = [
    'test' => [
        'transaction' => 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
        'api'         => 'https://apitest.ccavenue.com/apis/servlet/DoWebTrans',
    ],
    'production' => [
        'transaction' => 'https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
        'api'         => 'https://api.ccavenue.com/apis/servlet/DoWebTrans',
    ],
];

const PAY_SIMULATOR_MERCHANT_ID = '9999999';
const PAY_SIMULATOR_ACCESS_CODE = 'SIMULATORACCESS';
const PAY_SIMULATOR_DEV_KEY     = 'simulator-working-key-not-secret';

/**
 * True when migration 010 is applied: every payment table plus the new
 * donations and seva_bookings columns. Cached per request.
 */
function payTablesExist(bool $refresh = false): bool
{
    static $exists = null;
    if ($refresh) $exists = null;
    if ($exists !== null) return $exists;
    try {
        $db = getDB();
        foreach ([
            'SELECT 1 FROM payment_settings LIMIT 0',
            'SELECT 1 FROM payment_transactions LIMIT 0',
            'SELECT 1 FROM payment_refunds LIMIT 0',
            'SELECT 1 FROM payment_audit_log LIMIT 0',
            'SELECT 1 FROM payment_counters LIMIT 0',
            'SELECT 1 FROM donation_categories LIMIT 0',
            'SELECT source, donation_number, status, receipt_number FROM donations LIMIT 0',
            'SELECT payment_mode, order_number, payment_status, hold_expires_at FROM seva_bookings LIMIT 0',
        ] as $sql) {
            $db->query($sql)->closeCursor();
        }
        return $exists = true;
    } catch (Throwable $e) {
        error_log('[payments] payment tables unavailable (apply database/migrations/010_payments.sql): ' . $e->getMessage());
        return $exists = false;
    }
}

/** True when PAYMENTS_ALLOW_SIMULATOR=1 on this server. */
function paySimulatorAllowed(): bool
{
    return envValue('PAYMENTS_ALLOW_SIMULATOR') === '1';
}

/**
 * Every payment_settings row, k => [v, is_secret, updated_by, updated_at], as
 * stored (secrets still encrypted). [] before the migration. Cached per request.
 */
function paySettingsRows(bool $refresh = false): array
{
    static $rows = null;
    if ($refresh) $rows = null;
    if ($rows !== null) return $rows;
    if (!payTablesExist()) return $rows = [];
    try {
        $rows = [];
        foreach (getDB()->query('SELECT k, v, is_secret, updated_by, updated_at FROM payment_settings')->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $rows[(string) $r['k']] = [
                'v'          => (string) $r['v'],
                'is_secret'  => (int) $r['is_secret'] === 1,
                'updated_by' => $r['updated_by'],
                'updated_at' => $r['updated_at'],
            ];
        }
        return $rows;
    } catch (Throwable $e) {
        error_log('[payments] payment settings could not be read: ' . $e->getMessage());
        return $rows = [];
    }
}

/**
 * The test-only overlay: PAYMENTS_SETTINGS_OVERLAY as k => string, honoured only
 * with PAYMENTS_ALLOW_SIMULATOR=1. Unknown and secret keys are ignored.
 */
function paySettingsOverlay(): array
{
    static $overlay = null;
    if ($overlay !== null) return $overlay;
    $overlay = [];
    $raw = envValue('PAYMENTS_SETTINGS_OVERLAY');
    if ($raw === '' || !paySimulatorAllowed()) return $overlay;
    $data = json_decode($raw, true);
    if (!is_array($data) || ($data !== [] && array_is_list($data))) {
        error_log('[payments] PAYMENTS_SETTINGS_OVERLAY is not a JSON object and was ignored');
        return $overlay;
    }
    foreach ($data as $k => $v) {
        if (!is_string($k) || !array_key_exists($k, PAY_SETTING_DEFAULTS)) continue;
        if (is_bool($v)) $v = $v ? '1' : '0';
        if (!is_scalar($v)) continue;
        $overlay[$k] = (string) $v;
    }
    return $overlay;
}

/** Every non-secret setting as its raw effective string: defaults ← table ← overlay. */
function paySettingsAll(bool $refresh = false): array
{
    $out = PAY_SETTING_DEFAULTS;
    foreach (paySettingsRows($refresh) as $k => $row) {
        if (!$row['is_secret'] && array_key_exists($k, PAY_SETTING_DEFAULTS)) $out[$k] = $row['v'];
    }
    return array_merge($out, paySettingsOverlay());
}

/**
 * One setting's effective raw value. For a secret key, the decrypted stored
 * value ('' when absent or unreadable) — the environment is not consulted here;
 * use payConfig() for the credential actually in force. Never send a secret to
 * a browser.
 */
function paySetting(string $key, string $default = ''): string
{
    if (in_array($key, PAY_SECRET_KEYS, true)) return payStoredSecret($key) ?? '';
    return paySettingsAll()[$key] ?? $default;
}

/** The 32-byte key from PAYMENTS_SETTINGS_KEY, or null when it is missing, not base64 or the wrong length. */
function paySettingsKey(): ?string
{
    $raw = trim(envValue('PAYMENTS_SETTINGS_KEY'));
    if ($raw === '' || !function_exists('sodium_crypto_secretbox')) return null;
    $bin = base64_decode($raw, true);
    return ($bin !== false && strlen($bin) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) ? $bin : null;
}

/** "sbx1:" + base64(nonce ‖ secretbox). Throws RuntimeException without a usable PAYMENTS_SETTINGS_KEY. */
function paySecretEncrypt(string $plain): string
{
    $key = paySettingsKey();
    if ($key === null) {
        throw new RuntimeException('Set PAYMENTS_SETTINGS_KEY (base64 of 32 random bytes) to store gateway keys in the admin, or put them in the server environment.');
    }
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return 'sbx1:' . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $key));
}

/** The plain text of a stored secret, or null when it cannot be decrypted (wrong/missing key, tampered, not sbx1). */
function paySecretDecrypt(string $stored): ?string
{
    if (!str_starts_with($stored, 'sbx1:')) return null;
    $key = paySettingsKey();
    if ($key === null) return null;
    $bin = base64_decode(substr($stored, 5), true);
    if ($bin === false || strlen($bin) < SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES) return null;
    $plain = sodium_crypto_secretbox_open(
        substr($bin, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
        substr($bin, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
        $key
    );
    return $plain === false ? null : $plain;
}

/** A stored secret decrypted, or null when there is none. An unreadable one is logged once per request. */
function payStoredSecret(string $key): ?string
{
    static $warned = false;
    $row = paySettingsRows()[$key] ?? null;
    if ($row === null || $row['v'] === '') return null;
    $plain = paySecretDecrypt($row['v']);
    if ($plain === null && !$warned) {
        $warned = true;
        error_log('[payments] stored credential could not be decrypted');
    }
    return $plain;
}

/** The credential in force for one environment and field: environment variable first, then the stored value. */
function payCredential(string $environment, string $field): string
{
    if (!isset(PAY_CREDENTIAL_ENV[$environment][$field])) return '';
    $env = trim(envValue(PAY_CREDENTIAL_ENV[$environment][$field]));
    if ($env !== '') return $env;
    return trim(payStoredSecret(PAY_CREDENTIAL_PREFIX[$environment] . $field) ?? '');
}

/**
 * Where each credential of an environment comes from, for the admin form. Never
 * the value: source is env | stored | unreadable | none, and last4 (stored only)
 * is enough to recognise which key is on file.
 *
 * @return array<string, array{source:string, env:string, setting:string, last4:?string}>
 */
function payCredentialStatus(string $environment): array
{
    $out = [];
    foreach (PAY_CREDENTIAL_FIELDS as $field) {
        $envName = PAY_CREDENTIAL_ENV[$environment][$field] ?? '';
        $setting = (PAY_CREDENTIAL_PREFIX[$environment] ?? '') . $field;
        $item = ['source' => 'none', 'env' => $envName, 'setting' => $setting, 'last4' => null];
        if ($envName !== '' && trim(envValue($envName)) !== '') {
            $item['source'] = 'env';
        } elseif (($row = paySettingsRows()[$setting] ?? null) !== null && $row['v'] !== '') {
            $plain = paySecretDecrypt($row['v']);
            if ($plain === null) {
                $item['source'] = 'unreadable';
            } else {
                $item['source'] = 'stored';
                $item['last4'] = mb_substr($plain, -4);
            }
        }
        $out[$field] = $item;
    }
    return $out;
}

/**
 * Save one setting. A secret is encrypted (throws without PAYMENTS_SETTINGS_KEY);
 * null or '' for a secret removes it, so callers that mean "leave blank to keep"
 * must simply not call this for blank fields. null for a plain setting restores
 * its default. Unknown keys throw InvalidArgumentException. Values are not
 * range-checked here; the admin validates before saving.
 */
function paySettingSave(PDO $db, string $key, ?string $value, string $actor): void
{
    $actor = mb_substr($actor, 0, 60);
    if (in_array($key, PAY_SECRET_KEYS, true)) {
        if ($value === null || $value === '') {
            $db->prepare('DELETE FROM payment_settings WHERE k = :k')->execute([':k' => $key]);
        } else {
            $db->prepare(
                'INSERT INTO payment_settings (k, v, is_secret, updated_by, updated_at) VALUES (:k, :v, 1, :a, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE v = VALUES(v), is_secret = 1, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)'
            )->execute([':k' => $key, ':v' => paySecretEncrypt($value), ':a' => $actor]);
        }
    } elseif (array_key_exists($key, PAY_SETTING_DEFAULTS)) {
        $db->prepare(
            'INSERT INTO payment_settings (k, v, is_secret, updated_by, updated_at) VALUES (:k, :v, 0, :a, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE v = VALUES(v), is_secret = 0, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)'
        )->execute([':k' => $key, ':v' => $value ?? PAY_SETTING_DEFAULTS[$key], ':a' => $actor]);
    } else {
        throw new InvalidArgumentException("Unknown payment setting: {$key}");
    }
    payConfigReset();
}

/**
 * Save several settings in one transaction, writing only values that differ
 * from what is stored (a secret provided is always written), and audit
 * settings_changed with the key names only. Returns the changed key names.
 *
 * @param array<string, ?string> $changes key => value (null removes a secret / restores a default)
 */
function paySettingsSaveMany(PDO $db, array $changes, string $actor): array
{
    $rows = paySettingsRows(true);
    $changed = [];
    payTransaction($db, function (PDO $db) use ($changes, $actor, $rows, &$changed): void {
        foreach ($changes as $key => $value) {
            $key = (string) $key;
            if (in_array($key, PAY_SECRET_KEYS, true)) {
                if (($value === null || $value === '') && !isset($rows[$key])) continue;
            } elseif (array_key_exists($key, PAY_SETTING_DEFAULTS)) {
                $current = isset($rows[$key]) ? $rows[$key]['v'] : null;
                if ($current !== null && $value !== null && $current === $value) continue;
            }
            paySettingSave($db, $key, $value, $actor);
            $changed[] = $key;
        }
        if ($changed) {
            payAudit($db, 'settings_changed', [
                'actor'  => $actor,
                'detail' => 'Payment settings changed: ' . implode(', ', $changed),
                'data'   => ['settings' => $changed],
            ]);
        }
    });
    payConfigReset();
    return $changed;
}

/** Forget the per-request caches after settings change. */
function payConfigReset(): void
{
    paySettingsRows(true);
    payConfig(true);
}

/** An absolute gateway return URL: the environment override, else siteUrl($path). */
function payUrlSetting(string $envName, string $path): string
{
    $v = trim(envValue($envName));
    return $v !== '' ? $v : siteUrl($path);
}

/**
 * The effective configuration: every setting validated and typed, plus one
 * credential block per environment. Cached per request; payConfigReset() clears.
 *
 * Keys: tables, enabled, mode, simulator_allowed, currencies (effective list:
 * only INR unless international is on), currencies_setting (the admin's list),
 * default_currency, international, receipt_prefix, donation_min, donation_max,
 * donation_max_foreign (decimal strings), presets (int[]), notify_email,
 * notify_sms, notify_whatsapp, seva_online, hold_minutes, redirect_url,
 * cancel_url, notify_url, secret_ok, settings_key_ok, and env =>
 * [test|production|simulator => payEnvConfig() block].
 *
 * The env blocks hold credentials: never serialise payConfig() to a response.
 */
function payConfig(bool $refresh = false): array
{
    static $cfg = null;
    if ($refresh) $cfg = null;
    if ($cfg !== null) return $cfg;

    $s = paySettingsAll();
    $mode = in_array($s['mode'], PAY_MODES, true) ? $s['mode'] : 'test';

    $listed = ['INR'];
    foreach (explode(',', strtoupper($s['currencies'])) as $code) {
        $code = trim($code);
        if (isset(PAY_SUPPORTED_CURRENCIES[$code]) && !in_array($code, $listed, true)) $listed[] = $code;
    }
    $international = $s['international_enabled'] === '1';
    $currencies = $international ? $listed : ['INR'];
    $default = strtoupper(trim($s['default_currency']));
    if (!in_array($default, $currencies, true)) $default = 'INR';

    $min = payAmountParse($s['donation_min']);
    if ($min === null || payAmountCents($min) < 100) $min = '1.00';
    $max = payAmountParse($s['donation_max']);
    if ($max === null || payAmountCents($max) < payAmountCents($min)) {
        $max = payAmountCents($min) <= 50000000 ? '500000.00' : $min;
    }
    $maxForeign = payAmountParse($s['donation_max_foreign']);
    $maxForeign = $maxForeign === null || payAmountCents($maxForeign) < 100
        ? '10000.00'
        : payCentsToAmount(intdiv(payAmountCents($maxForeign), 100) * 100);

    $presets = [];
    foreach (explode(',', $s['preset_amounts']) as $p) {
        $p = trim($p);
        if (!ctype_digit($p) || strlen($p) > 10) continue;
        $cents = (int) $p * 100;
        if ($cents < payAmountCents($min) || $cents > payAmountCents($max) || in_array((int) $p, $presets, true)) continue;
        $presets[] = (int) $p;
        if (count($presets) === 6) break;
    }

    $hold = ctype_digit(trim($s['hold_minutes'])) ? (int) trim($s['hold_minutes']) : 30;
    if ($hold < 10 || $hold > 1440) $hold = 30;
    $prefix = preg_match('/^[A-Z]{2,8}$/D', $s['receipt_prefix']) ? $s['receipt_prefix'] : 'TMR';

    $urls = [
        'redirect_url' => payUrlSetting('CCAVENUE_REDIRECT_URL', '/api/payments/ccavenue/response'),
        'cancel_url'   => payUrlSetting('CCAVENUE_CANCEL_URL', '/api/payments/ccavenue/cancel'),
        'notify_url'   => payUrlSetting('CCAVENUE_NOTIFY_URL', '/api/payments/ccavenue/notify'),
    ];

    $env = [];
    foreach (['test', 'production'] as $name) {
        $block = ['environment' => $name];
        foreach (PAY_CREDENTIAL_FIELDS as $field) $block[$field] = payCredential($name, $field);
        // The server API may use its own pair (research §5); by default it is the checkout pair.
        if ($block['api_access_code'] === '') $block['api_access_code'] = $block['access_code'];
        if ($block['api_working_key'] === '') $block['api_working_key'] = $block['working_key'];
        $block['transaction_url'] = PAY_GATEWAY_URLS[$name]['transaction'];
        $block['api_url'] = PAY_GATEWAY_URLS[$name]['api'];
        // Mock servers for automated tests; never honoured while PRODUCTION is the mode.
        if ($name === 'test' && $mode !== 'production') {
            $tx = trim(envValue('CCAVENUE_TRANSACTION_URL'));
            $api = trim(envValue('CCAVENUE_API_URL'));
            if ($tx !== '') $block['transaction_url'] = $tx;
            if ($api !== '') $block['api_url'] = $api;
        }
        $env[$name] = $block + $urls + ['timeout' => 15];
    }
    $simKey = envValue('PAYMENTS_SIMULATOR_KEY', PAY_SIMULATOR_DEV_KEY);
    $env['simulator'] = [
        'environment'     => 'simulator',
        'merchant_id'     => PAY_SIMULATOR_MERCHANT_ID,
        'access_code'     => PAY_SIMULATOR_ACCESS_CODE,
        'working_key'     => $simKey,
        'api_access_code' => PAY_SIMULATOR_ACCESS_CODE,
        'api_working_key' => $simKey,
        'transaction_url' => siteUrl('/api/payments/simulator'),
        'api_url'         => siteUrl('/api/payments/simulator/api'),
    ] + $urls + ['timeout' => 15];

    return $cfg = [
        'tables'               => payTablesExist(),
        'enabled'              => $s['enabled'] === '1',
        'mode'                 => $mode,
        'simulator_allowed'    => paySimulatorAllowed(),
        'currencies'           => $currencies,
        'currencies_setting'   => $listed,
        'default_currency'     => $default,
        'international'        => $international,
        'receipt_prefix'       => $prefix,
        'donation_min'         => $min,
        'donation_max'         => $max,
        'donation_max_foreign' => $maxForeign,
        'presets'              => $presets,
        'notify_email'         => $s['notify_email'] === '1',
        'notify_sms'           => $s['notify_sms'] === '1',
        'notify_whatsapp'      => $s['notify_whatsapp'] === '1',
        'seva_online'          => $s['seva_online_enabled'] === '1',
        'hold_minutes'         => $hold,
        'redirect_url'         => $urls['redirect_url'],
        'cancel_url'           => $urls['cancel_url'],
        'notify_url'           => $urls['notify_url'],
        'secret_ok'            => strlen(envValue('PAYMENTS_SECRET')) >= 32,
        'settings_key_ok'      => paySettingsKey() !== null,
        'env'                  => $env,
    ];
}

/**
 * The credential and URL block of one environment (default: the current mode):
 * environment, merchant_id, access_code, working_key, api_access_code,
 * api_working_key, transaction_url, api_url, redirect_url, cancel_url,
 * notify_url, timeout. This is the $cfg the ccav* functions take.
 */
function payEnvConfig(array $cfg, ?string $environment = null): array
{
    $environment ??= $cfg['mode'] ?? 'test';
    if (!isset($cfg['env'][$environment])) {
        throw new InvalidArgumentException("Unknown gateway environment: {$environment}");
    }
    return $cfg['env'][$environment];
}

/** A sentence when a return URL cannot be used in this mode, else ''. */
function payUrlProblem(string $url, string $mode): string
{
    if (strlen($url) > 100) return 'A gateway return URL is longer than the 100 characters CCAvenue accepts.';
    if (preg_match('/[&="\'<>\s\\\\]/', $url)) return 'A gateway return URL contains a character CCAvenue cannot carry (& = quotes or spaces).';
    $parts = parse_url($url);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) return 'A gateway return URL is not a complete address. Check SITE_URL.';
    $scheme = strtolower($parts['scheme']);
    if ($scheme === 'https') return '';
    $host = strtolower(trim($parts['host'], '[]'));
    if ($scheme === 'http' && $mode !== 'production' && in_array($host, ['localhost', '127.0.0.1', '::1'], true)) return '';
    return $mode === 'production'
        ? 'PRODUCTION needs https return URLs. Set SITE_URL to the https address of the site.'
        : 'The gateway return URLs must use https (plain http is allowed only on localhost for testing).';
}

/**
 * Whether payments can take money right now, and if not, why (in words for the
 * committee). Public endpoints answer 503 payments_unavailable when not ok.
 *
 * @return array{ok:bool, reason:string}
 */
function payReady(): array
{
    if (!payTablesExist()) {
        return ['ok' => false, 'reason' => 'The payments database migration (010_payments.sql) has not been applied.'];
    }
    $cfg = payConfig();
    if (!$cfg['enabled']) return ['ok' => false, 'reason' => 'Online payments are turned off.'];
    if ($cfg['mode'] === 'simulator' && !$cfg['simulator_allowed']) {
        return ['ok' => false, 'reason' => 'SIMULATOR mode is selected, but this server does not allow the simulator (PAYMENTS_ALLOW_SIMULATOR is not 1).'];
    }
    $env = $cfg['env'][$cfg['mode']];
    if (!ctype_digit($env['merchant_id']) || $env['access_code'] === '' || $env['working_key'] === '') {
        return ['ok' => false, 'reason' => 'The ' . strtoupper($cfg['mode']) . ' credentials are incomplete: a numeric merchant ID, an access code and a working key are needed.'];
    }
    if ($cfg['mode'] === 'production' && !$cfg['secret_ok']) {
        return ['ok' => false, 'reason' => 'PAYMENTS_SECRET (at least 32 characters) must be set before payments can run in PRODUCTION.'];
    }
    foreach (['redirect_url', 'cancel_url'] as $k) {
        $problem = payUrlProblem($env[$k], $cfg['mode']);
        if ($problem !== '') return ['ok' => false, 'reason' => $problem];
    }
    if (!function_exists('openssl_encrypt')) {
        return ['ok' => false, 'reason' => 'The PHP openssl extension is not available on this server.'];
    }
    return ['ok' => true, 'reason' => ''];
}

/** The supported currency list: code => [decimals, name]. */
function paySupportedCurrencies(): array
{
    return PAY_SUPPORTED_CURRENCIES;
}

/**
 * GET /api/payments/config. Never a credential or the merchant id. Before the
 * migration: enabled and ready false with the default limits.
 */
function payPublicConfig(): array
{
    $out = [
        'enabled'         => false,
        'ready'           => false,
        'simulator'       => false,
        'testMode'        => false,
        'currencies'      => [['code' => 'INR', 'decimals' => 2]],
        'defaultCurrency' => 'INR',
        'international'   => false,
        'min'             => 1,
        'max'             => 500000,
        'maxForeign'      => 10000,
        'presets'         => [500, 1000, 2500, 5000, 10000],
        'categories'      => [],
        'sevaOnline'      => false,
        'holdMinutes'     => 30,
    ];
    if (!payTablesExist()) return $out;

    $cfg = payConfig();
    $out['enabled']         = $cfg['enabled'];
    $out['ready']           = payReady()['ok'];
    $out['simulator']       = $cfg['mode'] === 'simulator';
    $out['testMode']        = $cfg['mode'] === 'test';
    $out['currencies']      = array_map(static fn(string $c): array => ['code' => $c, 'decimals' => payCurrencyDecimals($c)], $cfg['currencies']);
    $out['defaultCurrency'] = $cfg['default_currency'];
    $out['international']   = $cfg['international'];
    $out['min']             = payNumberOut($cfg['donation_min']);
    $out['max']             = payNumberOut($cfg['donation_max']);
    $out['maxForeign']      = payNumberOut($cfg['donation_max_foreign']);
    $out['presets']         = $cfg['presets'];
    $out['categories']      = array_map('payCategoryPublic', payCategoriesActive(getDB()));
    $out['sevaOnline']      = $cfg['seva_online'];
    $out['holdMinutes']     = $cfg['hold_minutes'];
    return $out;
}
