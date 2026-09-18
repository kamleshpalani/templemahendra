<?php
/**
 * backend/includes/live/settings.php — YouTube automation settings, stored
 * credentials, the quota breaker and whether the scheduled job may run
 * (docs/live/SPEC-PHASE3.md §2.1, §3).
 *
 * A copy of the settings half of backend/includes/payments/config.php, never
 * a shared dependency: paySettingSave() refuses every non-payment key, and
 * rotating one module's key must never brick the other module's credentials.
 *
 * Three sources, in this order of strength:
 *   1. Environment variables. A credential in the environment always wins over
 *      one stored from the admin (the admin shows it as read-only).
 *   2. live_settings rows. Secrets are stored encrypted with
 *      sodium_crypto_secretbox under LIVE_SETTINGS_KEY ("sbx1:" + base64 of
 *      nonce ‖ ciphertext); without that key nothing secret can be stored, and
 *      a value that fails to decrypt counts as absent.
 *   3. Built-in defaults, identical to migration 012's seeds (plain settings
 *      only).
 *
 * LIVE_SETTINGS_OVERLAY (a JSON object of plain settings) overlays the table
 * for one PHP process, and only when LIVE_ALLOW_SIMULATOR=1 (§10.1, §10.3), so
 * the test suites never have to change the shared rows. It never supplies a
 * credential.
 *
 * Credentials live only in PHP memory: nothing here returns one to a browser,
 * a log or the audit table. liveCredentialStatus()'s last4 is the only
 * fragment of a secret that ever leaves this file, and every text that might
 * carry one is passed through liveRedact() before it is stored or logged.
 *
 * The admin save path is liveSettingsSaveMany() (audited, key names only).
 * The job's own writes to the operational rows — the quota counter and
 * breaker, the call-level failure streak and provider_notice — go through
 * liveQuotaSpend(), liveQuotaBlock(), liveProviderFailStreak() and
 * liveProviderNoticeSet(), which never audit.
 */

/** The master switch. There is deliberately no separate "enabled" key: mode = off is off. */
const LIVE_MODES = ['off', 'simulator', 'live'];

/** k => seed, exactly the plain rows migration 012 seeds (§2.1). */
const LIVE_SETTING_DEFAULTS = [
    'mode'                          => 'off',
    'auto_starting'                 => '0',
    'auto_start'                    => '1',
    'auto_end'                      => '1',
    'starting_lead_minutes'         => '10',
    'lead_minutes'                  => '30',
    'stale_hours'                   => '6',
    'catchup_hours'                 => '48',
    'complete_grace_seconds'        => '120',
    'poll_seconds_live'             => '60',
    'poll_seconds_soon'             => '300',
    'backoff_max_seconds'           => '3600',
    'daily_quota_units'             => '5000',
    'quota_day'                     => '',
    'quota_units'                   => '0',
    'quota_blocked_until'           => '',
    'provider_fail_streak'          => '0',
    'provider_notice'               => '',
    'oauth_revoked_at'              => '',
    'oauth_revoked_reason'          => '',
    'oauth_access_token_expires_at' => '',
    'youtube_client_id'             => '',
    'youtube_channel_id'            => '',
];

/** Setting keys stored encrypted. Never seeded; rows are created only by the settings page or a token refresh. */
const LIVE_SECRET_KEYS = ['youtube_api_key', 'youtube_client_secret', 'youtube_refresh_token', 'oauth_access_token'];

/** The credentials the settings page edits, in form order. */
const LIVE_CREDENTIAL_FIELDS = ['api_key', 'client_id', 'client_secret', 'refresh_token', 'channel_id'];

/** field => the environment variable that supplies it (and always wins). */
const LIVE_CREDENTIAL_ENV = [
    'api_key'       => 'YOUTUBE_API_KEY',
    'client_id'     => 'YOUTUBE_CLIENT_ID',
    'client_secret' => 'YOUTUBE_CLIENT_SECRET',
    'refresh_token' => 'YOUTUBE_REFRESH_TOKEN',
    'channel_id'    => 'YOUTUBE_CHANNEL_ID',
];

/** field => the live_settings key it is stored under. client_id and channel_id are plain rows; the rest are secrets. */
const LIVE_CREDENTIAL_SETTING = [
    'api_key'       => 'youtube_api_key',
    'client_id'     => 'youtube_client_id',
    'client_secret' => 'youtube_client_secret',
    'refresh_token' => 'youtube_refresh_token',
    'channel_id'    => 'youtube_channel_id',
];

/**
 * key => [min, max] for the numeric settings: the ranges the settings form
 * accepts (§8.3) and the clamp liveAutomationConfig() applies however a value
 * was written (a hand-edited row, the overlay). poll_seconds_* never go below
 * LIVE_POLL_MIN_SECONDS; backoff_max_seconds' floor of 300 is the one
 * liveBackoffSeconds() also applies (§5.5).
 */
const LIVE_SETTING_RANGES = [
    'starting_lead_minutes'  => [1, 120],
    'lead_minutes'           => [5, 180],
    'stale_hours'            => [1, 48],
    'catchup_hours'          => [1, 168],
    'complete_grace_seconds' => [30, 1800],
    'poll_seconds_live'      => [LIVE_POLL_MIN_SECONDS, 900],
    'poll_seconds_soon'      => [LIVE_POLL_MIN_SECONDS, 900],
    'backoff_max_seconds'    => [300, 86400],
    'daily_quota_units'      => [100, 10000],
];

/** The two token-endpoint answers that switch Tier 2 off (§3.3), the only values oauth_revoked_reason holds. */
const LIVE_OAUTH_REVOKED_REASONS = ['invalid_grant', 'invalid_client'];

/* ── Fence ───────────────────────────────────────────────────────────────── */

/**
 * True when LIVE_ALLOW_SIMULATOR=1 on this server: the one fence of §10.1.
 * Every test-only door in the module — mode = simulator, the two base-URL
 * overrides, LIVE_SETTINGS_OVERLAY, LIVE_SYNC_ONLY_TITLE_PREFIX and
 * LIVE_SIM_FAIL_AFTER_LIVE — is honoured only behind it. Read on every call,
 * never cached.
 */
function liveSimulatorAllowed(): bool
{
    return envValue('LIVE_ALLOW_SIMULATOR') === '1';
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

/**
 * Every live_settings row, k => ['v', 'is_secret' (bool), 'updated_by',
 * 'updated_at'], as stored (secrets still encrypted). [] when migration 012 is
 * not applied or the table cannot be read. Cached per request; $refresh (and
 * liveConfigReset()) re-reads.
 */
function liveSettingsRows(bool $refresh = false): array
{
    static $rows = null;
    if ($refresh) $rows = null;
    if ($rows !== null) return $rows;
    if (!liveAutomationInstalled()) return $rows = [];
    try {
        $rows = [];
        foreach (getDB()->query('SELECT k, v, is_secret, updated_by, updated_at FROM live_settings')->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $rows[(string) $r['k']] = [
                'v'          => (string) $r['v'],
                'is_secret'  => (int) $r['is_secret'] === 1,
                'updated_by' => $r['updated_by'],
                'updated_at' => $r['updated_at'],
            ];
        }
        return $rows;
    } catch (Throwable $e) {
        error_log('[live] live settings could not be read: ' . $e->getMessage());
        return $rows = [];
    }
}

/**
 * Internal (not part of the §3.1 surface): the test-only overlay,
 * LIVE_SETTINGS_OVERLAY as k => string, honoured only when
 * liveSimulatorAllowed(). Keys outside LIVE_SETTING_DEFAULTS are ignored, and
 * so are the secret keys and the two plain credential keys
 * (youtube_client_id, youtube_channel_id): the overlay never supplies a
 * credential. Re-parsed whenever the variable or the fence changes, so a
 * suite's putenv() takes effect even before its liveConfigReset().
 */
function liveSettingsOverlay(bool $refresh = false): array
{
    static $source = null, $overlay = [];
    if ($refresh) {
        $source = null;
        $overlay = [];
    }
    $raw = liveSimulatorAllowed() ? envValue('LIVE_SETTINGS_OVERLAY') : '';
    if ($source === $raw) return $overlay;
    $source = $raw;
    $overlay = [];
    if ($raw === '') return $overlay;
    $data = json_decode($raw, true);
    if (!is_array($data) || ($data !== [] && array_is_list($data))) {
        error_log('[live] LIVE_SETTINGS_OVERLAY is not a JSON object and was ignored');
        return $overlay;
    }
    foreach ($data as $k => $v) {
        if (!is_string($k) || !array_key_exists($k, LIVE_SETTING_DEFAULTS)) continue;
        if (in_array($k, LIVE_SECRET_KEYS, true) || in_array($k, LIVE_CREDENTIAL_SETTING, true)) continue;
        if (is_bool($v)) $v = $v ? '1' : '0';
        if (!is_scalar($v)) continue;
        $overlay[$k] = (string) $v;
    }
    return $overlay;
}

/** Every plain setting as its raw effective string: defaults ← table ← overlay (§10.3). */
function liveSettingsAll(): array
{
    $out = LIVE_SETTING_DEFAULTS;
    foreach (liveSettingsRows() as $k => $row) {
        if (!$row['is_secret'] && array_key_exists($k, LIVE_SETTING_DEFAULTS)) $out[$k] = $row['v'];
    }
    return array_merge($out, liveSettingsOverlay());
}

/**
 * One setting's effective raw value. For a secret key, the decrypted stored
 * value ('' when absent or unreadable) — the environment is not consulted
 * here; liveCredential() is the credential actually in force. Never send a
 * secret to a browser.
 */
function liveSetting(string $key, string $default = ''): string
{
    if (in_array($key, LIVE_SECRET_KEYS, true)) return liveStoredSecret($key) ?? '';
    return liveSettingsAll()[$key] ?? $default;
}

/* ── Encryption ──────────────────────────────────────────────────────────── */

/**
 * The 32-byte key from LIVE_SETTINGS_KEY, or null when it is missing, not
 * base64, the wrong length, or sodium is unavailable. Read on every call.
 */
function liveSettingsKey(): ?string
{
    $raw = trim(envValue('LIVE_SETTINGS_KEY'));
    if ($raw === '' || !function_exists('sodium_crypto_secretbox')) return null;
    $bin = base64_decode($raw, true);
    return ($bin !== false && strlen($bin) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) ? $bin : null;
}

/** "sbx1:" + base64(nonce ‖ secretbox). Throws RuntimeException naming LIVE_SETTINGS_KEY without a usable key. */
function liveSecretEncrypt(string $plain): string
{
    $key = liveSettingsKey();
    if ($key === null) {
        throw new RuntimeException('Set LIVE_SETTINGS_KEY (base64 of 32 random bytes) to store YouTube keys in the admin, or put them in the server environment.');
    }
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return 'sbx1:' . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $key));
}

/** The plain text of a stored secret, or null for a wrong prefix, a missing key, a truncated value or a failed open. */
function liveSecretDecrypt(string $stored): ?string
{
    if (!str_starts_with($stored, 'sbx1:')) return null;
    $key = liveSettingsKey();
    if ($key === null) return null;
    $bin = base64_decode(substr($stored, 5), true);
    if ($bin === false || strlen($bin) < SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES) return null;
    try {
        $plain = sodium_crypto_secretbox_open(
            substr($bin, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
            substr($bin, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES),
            $key
        );
    } catch (Throwable) {
        return null;
    }
    return $plain === false ? null : $plain;
}

/** A stored secret decrypted, or null when there is none. An unreadable one is logged once per request. */
function liveStoredSecret(string $key): ?string
{
    static $warned = false;
    $row = liveSettingsRows()[$key] ?? null;
    if ($row === null || $row['v'] === '') return null;
    $plain = liveSecretDecrypt($row['v']);
    if ($plain === null && !$warned) {
        $warned = true;
        error_log('[live] stored credential could not be decrypted');
    }
    return $plain;
}

/* ── Credentials ─────────────────────────────────────────────────────────── */

/**
 * The credential in force for one field of LIVE_CREDENTIAL_FIELDS: the
 * environment variable first, then the stored row (decrypted for a secret),
 * else ''. Unknown fields answer ''. Never from LIVE_SETTINGS_OVERLAY.
 */
function liveCredential(string $field): string
{
    if (!isset(LIVE_CREDENTIAL_ENV[$field], LIVE_CREDENTIAL_SETTING[$field])) return '';
    $env = trim(envValue(LIVE_CREDENTIAL_ENV[$field]));
    if ($env !== '') return $env;
    $setting = LIVE_CREDENTIAL_SETTING[$field];
    if (in_array($setting, LIVE_SECRET_KEYS, true)) return trim(liveStoredSecret($setting) ?? '');
    $row = liveSettingsRows()[$setting] ?? null;
    return ($row === null || $row['is_secret']) ? '' : trim($row['v']);
}

/**
 * Where each credential comes from, for the admin form. Never the value:
 * source is env | stored | unreadable | none, and last4 (stored only) is
 * enough to recognise which value is on file.
 *
 * @return array<string, array{source:string, env:string, setting:string, last4:?string}>
 */
function liveCredentialStatus(): array
{
    $out = [];
    foreach (LIVE_CREDENTIAL_FIELDS as $field) {
        $envName = LIVE_CREDENTIAL_ENV[$field];
        $setting = LIVE_CREDENTIAL_SETTING[$field];
        $item = ['source' => 'none', 'env' => $envName, 'setting' => $setting, 'last4' => null];
        if (trim(envValue($envName)) !== '') {
            $item['source'] = 'env';
        } elseif (($row = liveSettingsRows()[$setting] ?? null) !== null && $row['v'] !== '') {
            if (in_array($setting, LIVE_SECRET_KEYS, true)) {
                $plain = liveSecretDecrypt($row['v']);
                if ($plain === null) {
                    $item['source'] = 'unreadable';
                } else {
                    $item['source'] = 'stored';
                    $item['last4'] = mb_substr($plain, -4);
                }
            } elseif (!$row['is_secret'] && trim($row['v']) !== '') {
                $item['source'] = 'stored';
                $item['last4'] = mb_substr(trim($row['v']), -4);
            }
        }
        $out[$field] = $item;
    }
    return $out;
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

/**
 * Internal (not part of the §3.1 surface): upsert one plain row exactly as
 * given, with updated_by $actor (NULL for the job's own operational writes).
 * No validation, no audit, no cache reset — the callers in this file do that.
 */
function liveSettingWrite(PDO $db, string $key, string $value, ?string $actor): void
{
    $db->prepare(
        'INSERT INTO live_settings (k, v, is_secret, updated_by, updated_at) VALUES (:k, :v, 0, :a, UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE v = VALUES(v), is_secret = 0, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)'
    )->execute([':k' => $key, ':v' => $value, ':a' => $actor === null ? null : mb_substr($actor, 0, 60)]);
}

/**
 * Internal (not part of the §3.1 surface): the named rows read straight from
 * the database, bypassing the per-request cache — for the counters another
 * process may have moved since this request loaded its settings.
 *
 * @param string[] $keys
 * @return array<string, array{v:string, is_secret:bool, updated_by:?string}>
 */
function liveSettingsFresh(PDO $db, array $keys): array
{
    if (!$keys) return [];
    $marks = [];
    $params = [];
    foreach (array_values($keys) as $i => $k) {
        $marks[] = ':k' . $i;
        $params[':k' . $i] = (string) $k;
    }
    $stmt = $db->prepare('SELECT k, v, is_secret, updated_by FROM live_settings WHERE k IN (' . implode(', ', $marks) . ')');
    $stmt->execute($params);
    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $out[(string) $r['k']] = [
            'v'          => (string) $r['v'],
            'is_secret'  => (int) $r['is_secret'] === 1,
            'updated_by' => $r['updated_by'],
        ];
    }
    return $out;
}

/**
 * Save one setting. A secret is encrypted (throws RuntimeException without
 * LIVE_SETTINGS_KEY); null or '' for a secret removes it, so callers that mean
 * "leave blank to keep" must simply not call this for blank fields. null for a
 * plain setting restores its default. Unknown keys throw
 * InvalidArgumentException. Values are not range-checked here; the admin
 * validates before saving and liveAutomationConfig() clamps on read.
 */
function liveSettingSave(PDO $db, string $key, ?string $value, string $actor): void
{
    $actor = mb_substr($actor, 0, 60);
    if (in_array($key, LIVE_SECRET_KEYS, true)) {
        if ($value === null || $value === '') {
            $db->prepare('DELETE FROM live_settings WHERE k = :k')->execute([':k' => $key]);
        } else {
            $db->prepare(
                'INSERT INTO live_settings (k, v, is_secret, updated_by, updated_at) VALUES (:k, :v, 1, :a, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE v = VALUES(v), is_secret = 1, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)'
            )->execute([':k' => $key, ':v' => liveSecretEncrypt($value), ':a' => $actor]);
        }
    } elseif (array_key_exists($key, LIVE_SETTING_DEFAULTS)) {
        liveSettingWrite($db, $key, $value ?? LIVE_SETTING_DEFAULTS[$key], $actor);
    } else {
        throw new InvalidArgumentException("Unknown live setting: {$key}");
    }
    liveConfigReset();
}

/**
 * The one admin save path. Saves several settings in one liveTransaction(),
 * writing only values that differ from what is stored (a secret provided is
 * always written), and audits live_provider_settings with the key NAMES only.
 * Returns the changed key names.
 *
 * When any credential key (a value of LIVE_CREDENTIAL_SETTING) changed, the
 * same transaction also — in every mode (§3.1):
 *   - deletes the cached bearer (oauth_access_token) and blanks
 *     oauth_access_token_expires_at, so a rotated secret cannot keep working
 *     from a cached bearer;
 *   - clears oauth_revoked_at and oauth_revoked_reason when client_id,
 *     client_secret or refresh_token changed, so the next run tries the token
 *     once more (§3.3);
 *   - sets next_sync_at = NULL on every row liveSyncEligibleWhere() selects,
 *     so no row waits out a back-off earned by the old credential (and a
 *     suite's save touches only that suite's rows);
 *   - calls liveProviderFailStreak($db, null).
 * Then liveConfigReset().
 *
 * @param array<string, ?string> $changes key => value (null removes a secret / restores a default)
 * @return string[]
 */
function liveSettingsSaveMany(PDO $db, array $changes, string $actor): array
{
    $rows = liveSettingsRows(true);
    $changed = [];
    liveTransaction($db, function (PDO $db) use ($changes, $actor, $rows, &$changed): void {
        foreach ($changes as $key => $value) {
            $key = (string) $key;
            if (is_bool($value)) $value = $value ? '1' : '0';
            if ($value !== null && !is_scalar($value)) throw new InvalidArgumentException("Setting {$key} must be a string.");
            $value = $value === null ? null : (string) $value;
            if (in_array($key, LIVE_SECRET_KEYS, true)) {
                if (($value === null || $value === '') && !isset($rows[$key])) continue;
            } elseif (array_key_exists($key, LIVE_SETTING_DEFAULTS)) {
                $current = isset($rows[$key]) ? $rows[$key]['v'] : null;
                if ($current !== null && $current === ($value ?? LIVE_SETTING_DEFAULTS[$key])) continue;
            }
            liveSettingSave($db, $key, $value, $actor);
            $changed[] = $key;
        }
        if (!$changed) return;

        if (array_intersect($changed, array_values(LIVE_CREDENTIAL_SETTING))) {
            $db->prepare('DELETE FROM live_settings WHERE k = :k')->execute([':k' => 'oauth_access_token']);
            liveSettingWrite($db, 'oauth_access_token_expires_at', '', $actor);
            if (array_intersect($changed, ['youtube_client_id', 'youtube_client_secret', 'youtube_refresh_token'])) {
                liveSettingWrite($db, 'oauth_revoked_at', '', $actor);
                liveSettingWrite($db, 'oauth_revoked_reason', '', $actor);
            }
            [$where, $params] = liveSyncEligibleWhere();
            $db->prepare("UPDATE live_streams s SET s.next_sync_at = NULL WHERE {$where}")->execute($params);
            liveProviderFailStreak($db, null);
        }

        liveAudit('live_provider_settings', 'YouTube automation', 'YouTube automation settings changed: ' . implode(', ', $changed), $actor);
    });
    liveConfigReset();
    return $changed;
}

/**
 * Forget the per-request caches (the settings rows, the overlay, the values
 * liveRedact() removes) after settings change or a suite switches its
 * overlay. Never writes or deletes a row.
 */
function liveConfigReset(): void
{
    liveSettingsRows(true);
    liveSettingsOverlay(true);
    liveRedactValues(true);
}

/* ── Effective configuration ─────────────────────────────────────────────── */

/** Internal: a raw setting as an integer clamped to [$min, $max]; $default (clamped too) when it is not an integer. */
function liveSettingClampInt(string $raw, int $default, int $min, int $max): int
{
    $t = trim($raw);
    $n = preg_match('/^-?\d{1,12}$/D', $t) ? (int) $t : $default;
    return max($min, min($max, $n));
}

/** Internal: a raw setting as a UTC 'Y-m-d H:i:s' instant, or null when blank or not a real instant in exactly that form. */
function liveSettingInstant(string $raw): ?string
{
    $t = trim($raw);
    if ($t === '') return null;
    $d = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $t, new DateTimeZone('UTC'));
    return ($d !== false && $d->format('Y-m-d H:i:s') === $t) ? $t : null;
}

/**
 * Every setting as a typed value, clamped to its range however it was
 * written, plus 'tier', 'mode', 'simulator_allowed' and 'channel_id'. Holds
 * no credential but the (non-secret, never public) channel id, so it is safe
 * to pass around the poller; still never serialise it to a response.
 *
 * Keys: mode ('off'|'simulator'|'live'; anything else reads as 'off'),
 * simulator_allowed, tier, channel_id, auto_starting, auto_start, auto_end
 * (bool), the LIVE_SETTING_RANGES keys (int, clamped), quota_day ('Y-m-d' or
 * ''), quota_units, provider_fail_streak (int ≥ 0), quota_blocked_until,
 * oauth_revoked_at, oauth_access_token_expires_at (UTC instant or null),
 * oauth_revoked_reason ('invalid_grant'|'invalid_client'|''), provider_notice.
 */
function liveAutomationConfig(): array
{
    $s = liveSettingsAll();
    $mode = trim($s['mode']);
    $cfg = [
        'mode'              => in_array($mode, LIVE_MODES, true) ? $mode : 'off',
        'simulator_allowed' => liveSimulatorAllowed(),
        'tier'              => liveAutomationTier(),
        'channel_id'        => liveCredential('channel_id'),
    ];
    foreach (['auto_starting', 'auto_start', 'auto_end'] as $k) {
        $cfg[$k] = trim($s[$k]) === '1';
    }
    foreach (LIVE_SETTING_RANGES as $k => [$min, $max]) {
        $cfg[$k] = liveSettingClampInt($s[$k], (int) LIVE_SETTING_DEFAULTS[$k], $min, $max);
    }
    $day = trim($s['quota_day']);
    $reason = trim($s['oauth_revoked_reason']);
    return $cfg + [
        'quota_day'                     => preg_match('/^\d{4}-\d{2}-\d{2}$/D', $day) ? $day : '',
        'quota_units'                   => liveSettingClampInt($s['quota_units'], 0, 0, PHP_INT_MAX),
        'quota_blocked_until'           => liveSettingInstant($s['quota_blocked_until']),
        'provider_fail_streak'          => liveSettingClampInt($s['provider_fail_streak'], 0, 0, PHP_INT_MAX),
        'provider_notice'               => $s['provider_notice'],
        'oauth_revoked_at'              => liveSettingInstant($s['oauth_revoked_at']),
        'oauth_revoked_reason'          => in_array($reason, LIVE_OAUTH_REVOKED_REASONS, true) ? $reason : '',
        'oauth_access_token_expires_at' => liveSettingInstant($s['oauth_access_token_expires_at']),
    ];
}

/**
 * 2 when client_id, client_secret and refresh_token are all present and
 * oauth_revoked_at is empty — whether the trio comes from the environment or
 * the database (§3.3); else 1 when an API key is present; otherwise 0.
 */
function liveAutomationTier(): int
{
    $trio = liveCredential('client_id') !== ''
        && liveCredential('client_secret') !== ''
        && liveCredential('refresh_token') !== '';
    if ($trio && trim(liveSetting('oauth_revoked_at')) === '') return 2;
    return liveCredential('api_key') !== '' ? 1 : 0;
}

/**
 * Whether the scheduled job may call YouTube now — the shape of payReady(),
 * plus the tier. ok only when migrations 011 and 012 are applied, mode is not
 * off (and simulator only behind the fence), the tier is at least 1 (waived
 * in simulator mode), curl is available and the quota breaker is closed.
 * reason is a sentence a committee member can act on; '' when ok.
 *
 * @return array{ok: bool, reason: string, tier: int}
 */
function liveAutomationReady(): array
{
    $tier = liveAutomationTier();
    $no = static fn(string $reason): array => ['ok' => false, 'reason' => $reason, 'tier' => $tier];
    if (!liveTablesExist()) return $no('Apply database migrations 011_live_streams.sql and 012_live_automation.sql.');
    if (!liveAutomationInstalled()) return $no('Apply database migration 012_live_automation.sql.');
    $mode = trim(liveSetting('mode'));
    if (!in_array($mode, LIVE_MODES, true) || $mode === 'off') {
        return $no('YouTube automation is switched off — turn it on in Admin → YouTube Automation.');
    }
    if ($mode === 'simulator' && !liveSimulatorAllowed()) {
        return $no('The YouTube stand-in (Simulator) is selected, but this server does not allow it. Choose Off or Live in Admin → YouTube Automation.');
    }
    if ($tier < 1 && $mode !== 'simulator') return $no('No YouTube API key is set.');
    if (!function_exists('curl_init')) return $no('The PHP curl extension is not available on this server.');
    if (liveQuotaBlockedUntil() !== null) return $no("The day's YouTube quota is used up; it resets at midnight US Pacific time.");
    return ['ok' => true, 'reason' => '', 'tier' => $tier];
}

/* ── Redaction ───────────────────────────────────────────────────────────── */

/**
 * Internal (not part of the §3.1 surface): every configured credential value
 * liveRedact() removes verbatim, longest first, with its URL-encoded forms.
 * The stored values (every secret row decrypted, and the plain client and
 * channel ids) are read once per request and cached until liveConfigReset()
 * ($refresh clears the cache and answers []); the environment values are read
 * on every call. Values shorter than 6 characters are skipped, so a stray
 * one-letter setting cannot shred every sentence. May throw; liveRedact()
 * catches.
 *
 * @return string[]
 */
function liveRedactValues(bool $refresh = false): array
{
    static $stored = null;
    if ($refresh) {
        $stored = null;
        return [];
    }
    if ($stored === null) {
        $found = [];
        foreach (LIVE_SECRET_KEYS as $k) {
            $plain = liveStoredSecret($k);
            if ($plain !== null) $found[] = $plain;
        }
        $rows = liveSettingsRows();
        foreach (LIVE_CREDENTIAL_SETTING as $setting) {
            if (in_array($setting, LIVE_SECRET_KEYS, true)) continue;
            if (isset($rows[$setting]) && !$rows[$setting]['is_secret']) $found[] = $rows[$setting]['v'];
        }
        $stored = $found;
    }
    $values = $stored;
    foreach (LIVE_CREDENTIAL_ENV as $var) $values[] = envValue($var);
    $values[] = envValue('LIVE_SETTINGS_KEY');
    $values[] = envValue('LIVE_CRON_KEY');

    $out = [];
    foreach ($values as $v) {
        $v = trim((string) $v);
        if (strlen($v) < 6) continue;
        foreach ([$v, rawurlencode($v), urlencode($v)] as $form) $out[] = $form;
    }
    $out = array_values(array_unique($out));
    usort($out, static fn(string $a, string $b): int => strlen($b) <=> strlen($a));
    return $out;
}

/**
 * Text safe to store or log: notifyRedact() (bearer and token-shaped fields,
 * emails, phone numbers — it already catches refresh_token through the
 * substring "token"), then every configured credential value removed
 * verbatim, then any key=… query parameter (at Tier 1 the API key travels as
 * key=<api key>, and a Google error body can quote that URL), then clipped to
 * $max characters. The credential values are also removed once before
 * notifyRedact(), which could otherwise mask part of a value and leave the
 * rest unmatched.
 *
 * Never throws: it is often called while handling a database error, so if
 * reading the credentials fails it falls back to notifyRedact() plus the key=
 * rule, and if even that fails it answers ''.
 */
function liveRedact(string $text, int $max = 280): string
{
    $keyParam = '/(?<![A-Za-z0-9_])key=[^&\s#"\'<>]*/i';
    try {
        if ($text === '') return '';
        try {
            $values = liveRedactValues();
        } catch (Throwable) {
            $values = [];
        }
        $s = $values ? str_replace($values, '[redacted]', $text) : $text;
        $s = notifyRedact($s, max(2000, strlen($s)));
        if ($values) $s = str_replace($values, '[redacted]', $s);
        $s = preg_replace($keyParam, 'key=[redacted]', $s) ?? $s;
        return mb_substr(mb_scrub($s, 'UTF-8'), 0, max(0, $max));
    } catch (Throwable) {
        try {
            $s = notifyRedact($text, max(2000, strlen($text)));
            $s = preg_replace($keyParam, 'key=[redacted]', $s) ?? '';
            return mb_substr(mb_scrub($s, 'UTF-8'), 0, max(0, $max));
        } catch (Throwable) {
            return '';
        }
    }
}

/* ── Quota ───────────────────────────────────────────────────────────────── */

/** Today's date in America/Los_Angeles, 'Y-m-d': Google resets the Data API pool at midnight Pacific. Follows the test clock. */
function livePacificDay(): string
{
    return (new DateTimeImmutable(liveUtcNow(), new DateTimeZone('UTC')))
        ->setTimezone(new DateTimeZone('America/Los_Angeles'))
        ->format('Y-m-d');
}

/** The next midnight America/Los_Angeles as a UTC 'Y-m-d H:i:s' (07:00 or 08:00 UTC, by daylight saving). */
function liveQuotaResetAtUtc(): string
{
    $pt = new DateTimeZone('America/Los_Angeles');
    return (new DateTimeImmutable(livePacificDay() . ' 00:00:00', $pt))
        ->modify('+1 day')
        ->setTimezone(new DateTimeZone('UTC'))
        ->format('Y-m-d H:i:s');
}

/** quota_blocked_until while it is in the future (UTC 'Y-m-d H:i:s'), else null. */
function liveQuotaBlockedUntil(): ?string
{
    $until = liveSettingInstant(liveSetting('quota_blocked_until'));
    return ($until !== null && $until > liveUtcNow()) ? $until : null;
}

/**
 * Open the quota breaker: quota_blocked_until = liveQuotaResetAtUtc(). The
 * sweep makes no call while it is in the future (G14). Logged once, when it
 * opens, with $reason redacted. Writes no audit row.
 */
function liveQuotaBlock(PDO $db, string $reason): void
{
    static $logged = false;
    $wasBlocked = liveQuotaBlockedUntil() !== null;
    $until = liveQuotaResetAtUtc();
    liveSettingWrite($db, 'quota_blocked_until', $until, null);
    liveConfigReset();
    if (!$wasBlocked && !$logged) {
        $logged = true;
        error_log('[live] YouTube quota breaker open until ' . $until . ' UTC: ' . liveRedact($reason, 200));
    }
}

/**
 * Count $units against today's quota before a call is made — in a dry run
 * too, because Google charges it. quota_units counts only for quota_day: when
 * quota_day is not today's Pacific date the count restarts at 0 and quota_day
 * becomes today. When the spend would take quota_units past
 * daily_quota_units (clamped 100–10000) nothing is counted,
 * liveQuotaBlock() opens the breaker and the answer is false: do not make the
 * call. Otherwise the units are added and the answer is true.
 */
function liveQuotaSpend(PDO $db, int $units): bool
{
    if ($units <= 0) return true;
    $today = livePacificDay();
    [$min, $max] = LIVE_SETTING_RANGES['daily_quota_units'];
    $cap = liveSettingClampInt(liveSetting('daily_quota_units'), (int) LIVE_SETTING_DEFAULTS['daily_quota_units'], $min, $max);
    $used = 0;
    for ($attempt = 0; $attempt < 5; $attempt++) {
        $fresh = liveSettingsFresh($db, ['quota_day', 'quota_units']);
        if (trim($fresh['quota_day']['v'] ?? '') !== $today || !isset($fresh['quota_units'])) {
            liveSettingWrite($db, 'quota_units', '0', null);
            liveSettingWrite($db, 'quota_day', $today, null);
            continue;
        }
        $old = $fresh['quota_units']['v'];
        $used = ctype_digit(trim($old)) ? (int) trim($old) : 0;
        if ($used + $units > $cap) {
            liveConfigReset();
            liveQuotaBlock($db, "daily_quota_units ({$cap}) reached");
            return false;
        }
        // Compare-and-set, so an overlapping writer (the settings page's
        // connection test) cannot make two spends count as one.
        $stmt = $db->prepare("UPDATE live_settings SET v = :new, updated_by = NULL, updated_at = UTC_TIMESTAMP() WHERE k = 'quota_units' AND v = :old");
        $stmt->execute([':new' => (string) ($used + $units), ':old' => $old]);
        if ($stmt->rowCount() === 1) {
            liveConfigReset();
            return true;
        }
    }
    // Five lost races in a row: count the call anyway rather than lose Google's charge.
    liveSettingWrite($db, 'quota_units', (string) ($used + $units), null);
    liveConfigReset();
    return true;
}

/* ── Provider-wide state ─────────────────────────────────────────────────── */

/**
 * Record what the last whole call did, and answer the streak that follows.
 * $class null means "the call answered": the streak goes to 0 and
 * provider_notice becomes $notice — the run's standing Tier 2 sentence
 * (§4.2), or '' to clear it. Otherwise the streak is incremented and, when it
 * changes from 0 to 1 or the class changes, $notice is written once.
 * $notice is a sentence from liveProviderConnectionMessage()'s vocabulary.
 * Every notice write goes through liveProviderNoticeSet().
 * Never touches a live_streams row. §5.3 step 9.
 *
 * The class of the running streak is kept in the provider_fail_streak row's
 * updated_by column (NULL while the streak is 0): the contract's table has no
 * key of its own for it, and it must survive from one cron process to the
 * next. Nothing here audits; callers skip it in a dry run (G18).
 */
function liveProviderFailStreak(PDO $db, ?string $class, string $notice = ''): int
{
    $fresh = liveSettingsFresh($db, ['provider_fail_streak', 'provider_notice']);
    $row = $fresh['provider_fail_streak'] ?? null;
    $streak = ($row !== null && ctype_digit(trim($row['v']))) ? (int) trim($row['v']) : 0;
    $prevClass = $row['updated_by'] ?? null;

    if ($class === null) {
        if ($row === null || $streak !== 0 || $prevClass !== null || trim($row['v']) !== '0') {
            liveSettingWrite($db, 'provider_fail_streak', '0', null);
        }
        $want = $notice === '' ? '' : liveRedact($notice);
        if (!isset($fresh['provider_notice']) || $fresh['provider_notice']['v'] !== $want) {
            liveProviderNoticeSet($db, $notice === '' ? null : $notice);
        }
        liveConfigReset();
        return 0;
    }

    $class = mb_substr(trim($class), 0, 60);
    if ($class === '') $class = 'transient';
    $next = $streak + 1;
    liveSettingWrite($db, 'provider_fail_streak', (string) $next, $class);
    if ($next === 1 || $prevClass !== $class) {
        liveProviderNoticeSet($db, $notice === '' ? null : $notice);
    }
    liveConfigReset();
    return $next;
}

/**
 * The only writer of provider_notice: stores liveRedact($text), or '' for
 * null, with updated_by NULL. Writes no audit row: liveSettingsSaveMany()
 * stays the admin save path and keeps its audit, and a per-sweep audit row
 * is forbidden (§6.5). The redaction is never skipped: at Tier 1 the
 * credential travels as key=<api key>, and a Google error body can quote
 * that URL. Its callers skip it in a dry run (G18).
 */
function liveProviderNoticeSet(PDO $db, ?string $text): void
{
    liveSettingWrite($db, 'provider_notice', $text === null ? '' : liveRedact($text), null);
    liveConfigReset();
}

/* ── Eligibility ─────────────────────────────────────────────────────────── */

/**
 * The one eligibility predicate for every bulk statement over sync rows
 * (G2, G3): [SQL over the table alias `s`, its params]. The SQL is
 *   s.deleted_at IS NULL AND s.provider = 'youtube'
 *   AND s.provider_broadcast_id IS NOT NULL AND s.provider_broadcast_id <> ''
 *   AND s.status IN ('SCHEDULED','STARTING','LIVE')
 * plus, when liveSimulatorAllowed() and envValue('LIVE_SYNC_ONLY_TITLE_PREFIX')
 * is non-empty, " AND s.title_en LIKE :sync_prefix" bound to that value,
 * %/_-escaped, plus '%' (§10.1). sync_enabled is deliberately not in it: a
 * scoped run reads a paused row (G4), so the unscoped working set adds that
 * clause itself (§5.3 step 6). No statement spells its own copy of this.
 *
 * @return array{0: string, 1: array<string, string>}
 */
function liveSyncEligibleWhere(): array
{
    $sql = "s.deleted_at IS NULL AND s.provider = 'youtube'"
         . " AND s.provider_broadcast_id IS NOT NULL AND s.provider_broadcast_id <> ''"
         . " AND s.status IN ('SCHEDULED','STARTING','LIVE')";
    $params = [];
    if (liveSimulatorAllowed()) {
        $prefix = envValue('LIVE_SYNC_ONLY_TITLE_PREFIX');
        if ($prefix !== '') {
            $sql .= ' AND s.title_en LIKE :sync_prefix';
            $params[':sync_prefix'] = addcslashes($prefix, '%_\\') . '%';
        }
    }
    return [$sql, $params];
}
