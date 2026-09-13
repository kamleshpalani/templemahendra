<?php
/**
 * backend/includes/notify/devices.php — push subscriptions and the VAPID key
 * that lets the site send Web Push.
 *
 * There is no native app: "mobile push" is Web Push to the installed PWA
 * (Android, desktop, and iOS 16.4+ home-screen apps). A browser's subscription
 * is an endpoint URL plus two public keys; it identifies a browser, not a
 * person, so registering an endpoint that another devotee used moves it to the
 * devotee signed in now (a shared family tablet).
 */

require_once __DIR__ . '/time.php';

const NOTIFY_MAX_DEVICES = 20;

/**
 * Upsert a push subscription.
 *
 * web:          ['endpoint' => https URL ≤ 2000, 'keys' => ['p256dh' => base64url 87 chars, 'auth' => base64url 22 chars]]
 * android/ios:  ['endpoint' => the FCM registration token] (provider fcm, no keys)
 *
 * Returns ['ok' => bool, 'id' => ?int, 'error' => ?string].
 */
function notifyRegisterDevice(int $devoteeId, array $subscription, string $platform = 'web', ?string $userAgent = null): array
{
    $fail = static fn(string $why): array => ['ok' => false, 'id' => null, 'error' => $why];
    if (!notifyTablesExist()) return $fail('Notifications are not available on this site yet.');
    if (!in_array($platform, ['web', 'android', 'ios'], true)) return $fail('This kind of device is not supported.');

    $endpoint = is_string($subscription['endpoint'] ?? null) ? trim($subscription['endpoint']) : '';
    $keysJson = null;
    if ($platform === 'web') {
        $host = parse_url($endpoint, PHP_URL_HOST);
        if ($endpoint === '' || strlen($endpoint) > 2000 || stripos($endpoint, 'https://') !== 0
            || !is_string($host) || $host === '' || preg_match('/[\x00-\x20\x7F]/', $endpoint)) {
            return $fail('This browser gave an address push messages cannot use. Turn notifications off and on again.');
        }
        $keys = is_array($subscription['keys'] ?? null) ? $subscription['keys'] : [];
        $p256 = is_string($keys['p256dh'] ?? null) ? $keys['p256dh'] : '';
        $auth = is_string($keys['auth'] ?? null) ? $keys['auth'] : '';
        // An uncompressed P-256 point is 65 bytes starting 0x04; the auth secret is 16 bytes.
        if (!preg_match('/^[A-Za-z0-9_-]{87}$/', $p256) || !preg_match('/^[A-Za-z0-9_-]{22}$/', $auth)
            || strlen(notifyB64uDecode($p256)) !== 65 || notifyB64uDecode($p256)[0] !== "\x04" || strlen(notifyB64uDecode($auth)) !== 16) {
            return $fail('This browser gave encryption keys push messages cannot use. Turn notifications off and on again.');
        }
        $provider = 'webpush';
        $keysJson = json_encode(['p256dh' => $p256, 'auth' => $auth]);
    } else {
        if (!preg_match('/^[A-Za-z0-9:_.\-]{20,2000}$/', $endpoint)) return $fail('This device gave a push token that cannot be used.');
        $provider = 'fcm';
    }

    try {
        $db = getDB();
        $stmt = $db->prepare('SELECT id FROM devotees WHERE id = :d AND is_active = 1');
        $stmt->execute([':d' => $devoteeId]);
        if (!$stmt->fetch()) return $fail('Please sign in again.');

        $now  = notifyNow();
        $hash = hash('sha256', $endpoint);
        $ua   = $userAgent !== null ? mb_substr(trim((string) preg_replace('/[\x00-\x1F\x7F]+/', ' ', $userAgent)), 0, 255) : null;
        $db->prepare(
            'INSERT INTO devotee_devices
                (devotee_id, platform, provider, endpoint, endpoint_hash, keys_json, user_agent, is_active, failures, last_seen_at, created_at)
             VALUES (:d, :pl, :pr, :e, :h, :k, :ua, 1, 0, :seen, :now)
             ON DUPLICATE KEY UPDATE
                devotee_id = VALUES(devotee_id), platform = VALUES(platform), provider = VALUES(provider),
                endpoint = VALUES(endpoint), keys_json = VALUES(keys_json), user_agent = VALUES(user_agent),
                is_active = 1, failures = 0, last_seen_at = VALUES(last_seen_at)'
        )->execute([
            ':d' => $devoteeId, ':pl' => $platform, ':pr' => $provider, ':e' => $endpoint, ':h' => $hash,
            ':k' => $keysJson, ':ua' => $ua, ':seen' => $now, ':now' => $now,
        ]);
        $stmt = $db->prepare('SELECT id FROM devotee_devices WHERE endpoint_hash = :h');
        $stmt->execute([':h' => $hash]);
        $id = (int) $stmt->fetchColumn();

        // Browsers re-subscribe on their own after clearing data; without a cap an
        // account collects dead endpoints that are each tried on every push.
        $db->prepare(
            'UPDATE devotee_devices SET is_active = 0
              WHERE devotee_id = :d AND is_active = 1 AND id NOT IN (
                SELECT id FROM (
                  SELECT id FROM devotee_devices WHERE devotee_id = :d2 AND is_active = 1
                   ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC LIMIT ' . NOTIFY_MAX_DEVICES . '
                ) AS keep_newest
              )'
        )->execute([':d' => $devoteeId, ':d2' => $devoteeId]);

        return ['ok' => true, 'id' => $id, 'error' => null];
    } catch (Throwable $e) {
        error_log('[notify] registering a device failed: ' . $e->getMessage());
        return $fail('This device could not be registered. Please try again.');
    }
}

/** Forget one of this devotee's subscriptions. True when there was one to forget. */
function notifyRemoveDevice(int $devoteeId, string $endpoint): bool
{
    if (!notifyTablesExist() || trim($endpoint) === '') return false;
    try {
        $stmt = getDB()->prepare('DELETE FROM devotee_devices WHERE devotee_id = :d AND endpoint_hash = :h');
        $stmt->execute([':d' => $devoteeId, ':h' => hash('sha256', trim($endpoint))]);
        return $stmt->rowCount() > 0;
    } catch (Throwable $e) {
        error_log('[notify] removing a device failed: ' . $e->getMessage());
        return false;
    }
}

/**
 * The application server key the browser subscribes with (base64url, 65 raw
 * bytes). VAPID_PUBLIC_KEY when set. Otherwise — only while the push driver is
 * webpush or log and no VAPID keys are in the environment — a development pair
 * generated once into notification_kv, so push works on a fresh install. Null
 * when push cannot use a key (the test or fcm driver, or half-configured env).
 */
function notifyVapidPublicKey(): ?string
{
    $env = notifyEnv('VAPID_PUBLIC_KEY');
    if ($env !== '') return $env;
    try {
        return notifyVapidKeys()['public'] ?? null;
    } catch (Throwable $e) {
        error_log('[notify] no VAPID key: ' . $e->getMessage());
        return null;
    }
}

/**
 * ['public' => b64url 65 bytes, 'private' => b64url 32 bytes, 'source' => 'env'|'generated'] or null.
 * For the Web Push provider, which needs the private half as well.
 */
function notifyVapidKeys(): ?array
{
    $pub  = notifyEnv('VAPID_PUBLIC_KEY');
    $priv = notifyEnv('VAPID_PRIVATE_KEY');
    if ($pub !== '' || $priv !== '') {
        return $pub !== '' && $priv !== '' ? ['public' => $pub, 'private' => $priv, 'source' => 'env'] : null;
    }
    if (!in_array(notifyDriverName('push'), ['webpush', 'log'], true) || !notifyTablesExist()) return null;

    $public  = notifyKvGet('vapid_public');
    $private = notifyKvGet('vapid_private');
    if ($public !== null && $private !== null) return ['public' => $public, 'private' => $private, 'source' => 'generated'];

    // Two first visitors must not each write half of a different pair.
    $db = getDB();
    if ((int) $db->query("SELECT GET_LOCK('temple_notify_vapid', 5)")->fetchColumn() !== 1) {
        throw new RuntimeException('another request is generating the VAPID keys');
    }
    try {
        $public  = notifyKvGet('vapid_public');
        $private = notifyKvGet('vapid_private');
        if ($public === null || $private === null) {
            $pair = notifyGenerateP256KeyPair();
            notifyKvSet('vapid_private', $pair['private']);
            notifyKvSet('vapid_public', $pair['public']);
            [$public, $private] = [$pair['public'], $pair['private']];
            error_log('[notify] generated a development VAPID key pair; set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in production');
        }
    } finally {
        $db->query("SELECT RELEASE_LOCK('temple_notify_vapid')")->closeCursor();
    }
    return ['public' => $public, 'private' => $private, 'source' => 'generated'];
}

/**
 * A fresh P-256 key pair as base64url raw bytes: public 65 (0x04 ‖ X ‖ Y),
 * private 32 (d).
 *
 * OpenSSL wants a configuration file even to make an EC key, and PHP builds for
 * Windows often cannot find one ("configuration file routines::no such file").
 * So the default is tried first, then OPENSSL_CONF, the openssl.cnf shipped
 * beside php.exe, and finally a minimal file written to the temp directory.
 *
 * @throws RuntimeException when no attempt succeeds
 */
function notifyGenerateP256KeyPair(): array
{
    $args = ['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC];
    $key  = @openssl_pkey_new($args);
    if ($key === false) {
        foreach (notifyOpensslConfigCandidates() as $cnf) {
            $key = @openssl_pkey_new($args + ['config' => $cnf]);
            if ($key !== false) break;
        }
    }
    while (openssl_error_string() !== false) {
        // Drain OpenSSL's error queue so a later, unrelated call does not report these.
    }
    if ($key === false) throw new RuntimeException('OpenSSL could not generate a P-256 key pair.');

    $ec = openssl_pkey_get_details($key)['ec'] ?? null;
    if (!is_array($ec) || !isset($ec['x'], $ec['y'], $ec['d'])) throw new RuntimeException('OpenSSL returned an unexpected key.');
    $pad = static fn(string $b): string => str_pad($b, 32, "\0", STR_PAD_LEFT);
    return [
        'public'  => notifyB64u("\x04" . $pad($ec['x']) . $pad($ec['y'])),
        'private' => notifyB64u($pad($ec['d'])),
    ];
}

/** openssl.cnf files worth trying, existing ones only. */
function notifyOpensslConfigCandidates(): array
{
    $candidates = [];
    $env = getenv('OPENSSL_CONF');
    if (is_string($env) && $env !== '') $candidates[] = $env;
    $candidates[] = dirname(PHP_BINARY) . '/extras/ssl/openssl.cnf';
    $candidates[] = dirname(PHP_BINARY) . '/extras/openssl/openssl.cnf';

    // The smallest file OpenSSL 3 accepts for key generation: without the
    // openssl_conf line and a default digest it still refuses.
    $tmp = rtrim(sys_get_temp_dir(), '/\\') . '/temple-notify-openssl-v2.cnf';
    if (!is_file($tmp)) {
        @file_put_contents($tmp, "# Minimal configuration for generating keys from PHP.\nopenssl_conf = openssl_init\n[ openssl_init ]\n"
            . "[ req ]\ndefault_bits = 2048\ndefault_md = sha256\ndistinguished_name = req_dn\n[ req_dn ]\n");
    }
    $candidates[] = $tmp;
    return array_values(array_filter(array_unique($candidates), 'is_file'));
}
