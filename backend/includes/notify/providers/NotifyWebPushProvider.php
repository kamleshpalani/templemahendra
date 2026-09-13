<?php
/**
 * backend/includes/notify/providers/NotifyWebPushProvider.php — Web Push to the
 * installed PWA (Android, desktop browsers, iOS 16.4+ home-screen apps), in
 * plain PHP with the openssl extension and nothing else.
 *
 * Three standards do the work:
 *   RFC 8030  the push protocol: one POST per subscription endpoint.
 *   RFC 8292  VAPID: an ES256 JWT that proves the request comes from the server
 *             whose public key the browser subscribed with.
 *   RFC 8291  message encryption: ECDH with the browser's key, the Web Push key
 *             schedule, and one AES-128-GCM record in the RFC 8188 "aes128gcm"
 *             format. Push services (Google, Mozilla, Apple, Microsoft) only
 *             ever see ciphertext.
 *
 * Keys: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, base64url of the raw P-256 key
 * (`php backend/bin/notify_keys.php vapid` prints a fresh pair). Without them the
 * development pair in notification_kv is used, so push works locally with no
 * setup. Changing keys orphans every existing subscription — push services
 * answer 403 — which is why production sets them once and keeps them.
 *
 * VAPID_SUBJECT is the contact a push service writes to about abuse; it must be
 * mailto: or https:. Default: mailto:MAIL_FROM, else the site URL.
 */

require_once __DIR__ . '/../../db.php';

final class NotifyWebPushProvider implements NotifyProvider
{
    /** Push services accept 4096 bytes; the 86-byte header and 17 bytes of tag and padding leave ~3990. */
    private const PAYLOAD_MAX_BYTES = 3800;
    private const RECORD_SIZE       = 4096;

    private ?array $vapidKeys = null;
    private bool $vapidLoaded = false;

    public function name(): string { return 'webpush'; }
    public function channel(): string { return 'push'; }

    public function isConfigured(): bool
    {
        return $this->vapid() !== null;
    }

    public function send(NotifyMessage $m): NotifyResult
    {
        return NotifyProviderSupport::guard('webpush', function () use ($m): NotifyResult {
            $vapid = $this->vapid();
            if ($vapid === null) return NotifyResult::skipped('not configured: no usable VAPID keys');

            // A devotee may also own FCM devices; those belong to the fcm driver.
            $devices = array_values(array_filter(
                $m->devices,
                static fn($d) => is_array($d) && ($d['provider'] ?? 'webpush') === 'webpush'
            ));
            if ($devices === []) return NotifyResult::skipped('no web push device');

            $payload = $this->payload($m);
            $high    = in_array($m->priority, ['urgent', 'emergency'], true);
            $headers = [
                // An urgent message that arrives a day late is no longer urgent; an
                // ordinary one is still worth reading when a phone comes back online.
                'TTL'              => (string) ($high ? 86400 : 2419200),
                // Urgency lets a phone on battery saver hold low-priority messages.
                'Urgency'          => $high ? 'high' : ($m->priority === 'important' ? 'normal' : 'low'),
                'Content-Encoding' => 'aes128gcm',
                'Content-Type'     => 'application/octet-stream',
            ];
            // Topic: a newer message with the same topic replaces an undelivered older one.
            $topic = self::topic((string) $payload['tag']);
            if ($topic !== '') $headers['Topic'] = $topic;
            $json = self::fit($payload);

            $results = [];
            $log = [];
            $retryAfter = null;
            $jwts = [];
            foreach ($devices as $device) {
                $id = (int) ($device['id'] ?? 0);
                [$outcome, $line, $wait] = $this->deliver($device, $json, $headers, $vapid, $jwts);
                $results[$id] = $outcome;
                $log[] = 'device #' . $id . ': ' . $line;
                if ($wait !== null) $retryAfter = max($retryAfter ?? 0, $wait);
            }
            return NotifyProviderSupport::pushOutcome($results, null, implode("\n", $log), $retryAfter, 'web push');
        });
    }

    /** Web Push has no delivery callbacks: a push service only answers the POST. */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return ['ok' => false, 'status' => 404, 'error' => 'web push has no status callbacks'];
    }

    /**
     * One subscription. Returns [device outcome, log line, retry-after seconds|null].
     */
    private function deliver(array $device, string $json, array $headers, array $vapid, array &$jwts): array
    {
        $endpoint = trim((string) ($device['endpoint'] ?? ''));
        $parts = parse_url($endpoint);
        if (!self::endpointAllowed($parts)) {
            // Retired rather than retried: no later attempt makes a bad endpoint usable.
            return [self::outcome(false, true, false, 'the subscription endpoint is not a usable https URL'), 'not sent: unusable endpoint', null];
        }

        $keys     = is_array($device['keys'] ?? null) ? $device['keys'] : [];
        $uaPublic = notifyB64uDecode((string) ($keys['p256dh'] ?? ''));
        $auth     = notifyB64uDecode((string) ($keys['auth'] ?? ''));
        if (strlen($auth) !== 16 || NotifyEcKeys::publicKey($uaPublic) === null) {
            return [self::outcome(false, true, false, 'the subscription keys are malformed'), 'not sent: malformed keys', null];
        }

        $body = self::encrypt($json, $uaPublic, $auth);
        if ($body === null) {
            return [self::outcome(false, false, true, 'could not encrypt the message (openssl)'), 'not sent: encryption failed', null];
        }

        $audience = strtolower((string) $parts['scheme']) . '://' . strtolower((string) $parts['host'])
                  . (isset($parts['port']) ? ':' . (int) $parts['port'] : '');
        if (!array_key_exists($audience, $jwts)) $jwts[$audience] = $this->jwt($audience, $vapid);
        if ($jwts[$audience] === null) {
            return [self::outcome(false, false, true, 'could not sign the VAPID token (openssl)'), 'not sent: signing failed', null];
        }

        $res = notifyHttp('POST', $endpoint, $headers + [
            'Authorization' => 'vapid t=' . $jwts[$audience] . ', k=' . $vapid['publicB64'],
        ], $body, 15);

        $status = (int) $res['status'];
        $line   = NotifyProviderSupport::describe($res) . ($res['body'] !== '' ? ' ' . mb_substr(trim($res['body']), 0, 200) : '');

        if ($status >= 200 && $status < 300) {
            return [self::outcome(true, false, false, 'accepted'), $line, null];
        }
        if ($status === 404 || $status === 410) {
            return [self::outcome(false, true, false, "the subscription has expired or was removed (HTTP $status)"), $line, null];
        }
        if ($status === 413) {
            return [self::outcome(false, false, false, 'the message is too large for the push service (HTTP 413)'), $line, null];
        }
        if ($status === 400) {
            return [self::outcome(false, false, false, 'the push service refused the request as malformed (HTTP 400)'), $line, null];
        }
        if ($status === 403) {
            return [self::outcome(false, false, false, 'the push service refused the VAPID credentials (HTTP 403): the subscription was made with a different key'), $line, null];
        }
        if ($status === 401) {
            // Our own token was refused; that is configuration, so give someone time to fix it.
            return [self::outcome(false, false, true, 'the push service refused the VAPID token (HTTP 401): check VAPID_PRIVATE_KEY and VAPID_SUBJECT'), $line, 3600];
        }
        if ($status === 429) {
            return [self::outcome(false, false, true, 'the push service is rate limiting (HTTP 429)'), $line, NotifyProviderSupport::retryAfter($res['headers'])];
        }
        if ($status === 0 || $status >= 500) {
            return [self::outcome(false, false, true, 'the push service is unavailable (' . NotifyProviderSupport::describe($res) . ')'), $line, NotifyProviderSupport::retryAfter($res['headers'])];
        }
        return [self::outcome(false, false, false, "the push service refused the message (HTTP $status)"), $line, null];
    }

    /**
     * The payload the service worker reads (SPEC §7.4), as an array so the tag
     * can also feed the Topic header before it is encoded and fitted.
     */
    private function payload(NotifyMessage $m): array
    {
        $d = $m->data;
        return [
            'title'          => $m->title,
            'body'           => $m->body,
            'url'            => self::text($d['url'] ?? null) ?? NotifyProviderSupport::absoluteUrl($m->ctaUrl) ?? siteUrl('/notifications'),
            'trackUrl'       => self::text($d['trackUrl'] ?? null),
            'notificationId' => (int) (self::text($d['notificationId'] ?? null) ?? $m->notificationId),
            'category'       => self::text($d['category'] ?? null) ?? $m->category,
            'priority'       => self::text($d['priority'] ?? null) ?? $m->priority,
            'tag'            => self::text($d['tag'] ?? null) ?? 'notification-' . $m->notificationId,
            'image'          => self::text($d['image'] ?? null) ?? NotifyProviderSupport::absoluteUrl($m->imageUrl),
            'icon'           => '/icons/icon-192x192.png',
        ];
    }

    /**
     * Encode the payload within PAYLOAD_MAX_BYTES. The body gives way first —
     * the title and the link are what a devotee acts on, and the full text is
     * one tap away in the app — then the title, then the image and tracking link.
     */
    private static function fit(array $p): string
    {
        $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE;
        $json  = (string) json_encode($p, $flags);

        foreach (['body', 'title'] as $field) {
            $rounds = 0;
            while (strlen($json) > self::PAYLOAD_MAX_BYTES && $p[$field] !== '' && $rounds++ < 24) {
                $excess = strlen($json) - self::PAYLOAD_MAX_BYTES;
                // Bytes, not characters: Tamil is three bytes a character. mb_strcut
                // never splits one. The slack covers the ellipsis and JSON escaping.
                $keep = strlen($p[$field]) - $excess - 8;
                $p[$field] = $keep > 0 ? rtrim(mb_strcut($p[$field], 0, $keep, 'UTF-8')) . '…' : '';
                $json = (string) json_encode($p, $flags);
            }
        }
        foreach (['image', 'trackUrl'] as $field) {
            if (strlen($json) <= self::PAYLOAD_MAX_BYTES) break;
            $p[$field] = null;
            $json = (string) json_encode($p, $flags);
        }
        return $json;
    }

    /**
     * RFC 8291 + RFC 8188: encrypt one message for one subscription.
     *
     *   ecdh_secret = ECDH(as_private, ua_public)
     *   PRK_key     = HMAC-SHA-256(auth_secret, ecdh_secret)
     *   IKM         = HMAC-SHA-256(PRK_key, "WebPush: info" 0x00 ua_public as_public 0x01)
     *   PRK         = HMAC-SHA-256(salt, IKM)
     *   CEK         = HMAC-SHA-256(PRK, "Content-Encoding: aes128gcm" 0x00 0x01)[0..16]
     *   NONCE       = HMAC-SHA-256(PRK, "Content-Encoding: nonce" 0x00 0x01)[0..12]
     *
     * Each HKDF-Expand here needs one output block, which is exactly one HMAC
     * over info || 0x01. The body is a single record: the plaintext, then the
     * 0x02 last-record delimiter, encrypted with AES-128-GCM; the header is
     * salt(16) || record size (uint32 BE) || key id length (65) || as_public.
     * A fresh key pair and salt per message, as RFC 8291 requires.
     */
    private static function encrypt(string $plaintext, string $uaPublic, string $authSecret): ?string
    {
        $ephemeral = NotifyEcKeys::generate();
        if ($ephemeral === null) return null;
        $secret = NotifyEcKeys::sharedSecret($ephemeral['key'], $uaPublic);
        if ($secret === null) return null;
        $asPublic = $ephemeral['public'];

        $prkKey = hash_hmac('sha256', $secret, $authSecret, true);
        $ikm    = hash_hmac('sha256', "WebPush: info\x00" . $uaPublic . $asPublic . "\x01", $prkKey, true);
        $salt   = random_bytes(16);
        $prk    = hash_hmac('sha256', $ikm, $salt, true);
        $cek    = substr(hash_hmac('sha256', "Content-Encoding: aes128gcm\x00\x01", $prk, true), 0, 16);
        $nonce  = substr(hash_hmac('sha256', "Content-Encoding: nonce\x00\x01", $prk, true), 0, 12);

        $tag = '';
        $ciphertext = openssl_encrypt($plaintext . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
        if ($ciphertext === false || strlen($tag) !== 16) return null;

        return $salt . pack('N', self::RECORD_SIZE) . chr(strlen($asPublic)) . $asPublic . $ciphertext . $tag;
    }

    /** RFC 8292 JWT: aud is the push service origin, exp at most 24 h ahead (12 h here). */
    private function jwt(string $audience, array $vapid): ?string
    {
        $header = notifyB64u((string) json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
        $claims = notifyB64u((string) json_encode([
            'aud' => $audience,
            'exp' => time() + 43200,
            'sub' => self::subject(),
        ], JSON_UNESCAPED_SLASHES));
        $signature = NotifyEcKeys::signEs256($header . '.' . $claims, $vapid['key']);
        return $signature === null ? null : $header . '.' . $claims . '.' . notifyB64u($signature);
    }

    private static function subject(): string
    {
        $subject = trim(notifyEnv('VAPID_SUBJECT'));
        if (preg_match('~^(mailto:[^\s@]+@\S+|https://\S+)$~i', $subject)) return $subject;
        $from = trim(notifyEnv('MAIL_FROM'));
        if (filter_var($from, FILTER_VALIDATE_EMAIL)) return 'mailto:' . $from;
        return siteUrl();
    }

    /**
     * The VAPID key pair: ['key' => private OpenSSLAsymmetricKey, 'public' => raw 65, 'publicB64' => string],
     * or null when there is none or it does not hold together.
     */
    private function vapid(): ?array
    {
        if ($this->vapidLoaded) return $this->vapidKeys;
        $this->vapidLoaded = true;

        [$public, $private] = self::rawKeys();
        if ($public === null || $private === null) return null;

        $pub = self::decodeKey($public, 'public');
        $priv = self::decodeKey($private, 'private');
        if ($pub === null || $priv === null || !NotifyEcKeys::isPublicPoint($pub) || strlen($priv) !== 32) {
            error_log('[notify] webpush: VAPID keys are malformed; expected base64url of a 65-byte public point and a 32-byte private key');
            return null;
        }
        // A mismatched pair signs tokens no push service will accept, for every
        // subscription at once. Better to say "not configured" than to fail each send.
        if (NotifyEcKeys::publicFromPrivate($priv) !== $pub) {
            error_log('[notify] webpush: VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY');
            return null;
        }
        $key = NotifyEcKeys::privateKey($priv, $pub);
        if ($key === null) return null;
        return $this->vapidKeys = ['key' => $key, 'public' => $pub, 'publicB64' => notifyB64u($pub)];
    }

    /** [public, private] as configured: the environment, else the development pair in notification_kv. */
    private static function rawKeys(): array
    {
        $envPublic  = trim(notifyEnv('VAPID_PUBLIC_KEY'));
        $envPrivate = trim(notifyEnv('VAPID_PRIVATE_KEY'));
        if ($envPublic !== '' || $envPrivate !== '') {
            if ($envPublic === '' || $envPrivate === '') {
                error_log('[notify] webpush: set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
                return [null, null];
            }
            return [$envPublic, $envPrivate];
        }

        try {
            // The service owns generating the development pair (SPEC §5.12); asking
            // it for the public key first means a pair exists before we read one.
            if (function_exists('notifyVapidPublicKey')) notifyVapidPublicKey();
            $stmt = getDB()->prepare('SELECT k, v FROM notification_kv WHERE k IN (:pub, :priv)');
            $stmt->execute([':pub' => 'vapid_public', ':priv' => 'vapid_private']);
            $rows = $stmt->fetchAll(PDO::FETCH_KEY_PAIR);
        } catch (Throwable $e) {
            error_log('[notify] webpush: could not read the development VAPID keys: ' . notifyRedact($e->getMessage(), 200));
            return [null, null];
        }
        $public  = trim((string) ($rows['vapid_public'] ?? ''));
        $private = trim((string) ($rows['vapid_private'] ?? ''));
        return $public !== '' && $private !== '' ? [$public, $private] : [null, null];
    }

    /**
     * Raw key bytes from base64url (the documented format) or PEM. PEM is
     * accepted too because a development pair stored by another part of the
     * system, or pasted from another tool, may arrive that way.
     */
    private static function decodeKey(string $value, string $half): ?string
    {
        if (!str_contains($value, '-----BEGIN')) {
            $raw = notifyB64uDecode($value);
            return $raw === '' ? null : $raw;
        }
        $key = $half === 'private' ? openssl_pkey_get_private($value) : openssl_pkey_get_public($value);
        while (openssl_error_string() !== false) {
            // drain
        }
        if ($key === false) return null;
        $d = openssl_pkey_get_details($key);
        if (!is_array($d) || !isset($d['ec'])) return null;
        $pad = static fn(string $b): string => str_pad($b, 32, "\x00", STR_PAD_LEFT);
        if ($half === 'private') return isset($d['ec']['d']) ? $pad($d['ec']['d']) : null;
        return isset($d['ec']['x'], $d['ec']['y']) ? "\x04" . $pad($d['ec']['x']) . $pad($d['ec']['y']) : null;
    }

    /**
     * Only https endpoints: every real push service is https, and an endpoint
     * is devotee-supplied data that must not become a way to make this server
     * call arbitrary addresses. Plain http is allowed for a loopback receiver
     * in a test environment only.
     */
    private static function endpointAllowed(array|false $parts): bool
    {
        if (!is_array($parts) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])) return false;
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        if ($scheme === 'https') return true;
        return $scheme === 'http'
            && notifyEnv('NOTIFY_ALLOW_TEST_DRIVER') === '1'
            && in_array(strtolower(trim((string) $parts['host'], '[]')), ['127.0.0.1', 'localhost', '::1'], true);
    }

    /** Topic must be at most 32 characters of the base64url alphabet; anything else is hashed into that shape. */
    private static function topic(string $tag): string
    {
        $tag = trim($tag);
        if ($tag === '') return '';
        return preg_match('/^[A-Za-z0-9_-]{1,32}$/', $tag) ? $tag : notifyB64u(substr(hash('sha256', $tag, true), 0, 24));
    }

    private static function text(mixed $value): ?string
    {
        return is_scalar($value) && trim((string) $value) !== '' ? (string) $value : null;
    }

    private static function outcome(bool $ok, bool $gone, bool $retry, string $reason): array
    {
        return ['ok' => $ok, 'gone' => $gone, 'retry' => $retry, 'reason' => $reason];
    }
}
