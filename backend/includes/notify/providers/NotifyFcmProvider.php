<?php
/**
 * backend/includes/notify/providers/NotifyFcmProvider.php — Firebase Cloud
 * Messaging, HTTP v1 API.
 *
 * The site has no native app today; Web Push reaches the installed PWA. This
 * driver exists so that the day an Android or iOS app registers FCM tokens
 * (devotee_devices.provider = 'fcm'), switching NOTIFY_PUSH_DRIVER=fcm is the
 * whole change.
 *
 *   FCM_PROJECT_ID            the Firebase project id
 *   FCM_SERVICE_ACCOUNT_JSON  path to the service account key file, or the JSON itself
 *   FCM_BASE_URL              https://fcm.googleapis.com (overridable for tests)
 *   FCM_TOKEN_URL             https://oauth2.googleapis.com/token
 *
 * Authentication follows Google's server-to-server OAuth flow: a JWT signed
 * RS256 with the service account's key is exchanged for an access token that
 * lives an hour. Minting one costs a round trip to Google, so it is cached in
 * notification_kv ("fcm_token") and reused by every worker run until five
 * minutes before it expires. That row holds a short-lived token derived from
 * the credential, never the credential itself, and it is fingerprinted with
 * the account so rotating the key file cannot reuse a stale token. If Google
 * still answers 401 (a revoked token), it is refreshed once and the send retried.
 *
 * Reference: firebase.google.com/docs/cloud-messaging/send/v1-api and
 * /docs/reference/fcm/rest/v1/ErrorCode (as of 2026).
 */

require_once __DIR__ . '/../../db.php';

final class NotifyFcmProvider implements NotifyProvider
{
    private const SCOPE         = 'https://www.googleapis.com/auth/firebase.messaging';
    private const KV_KEY        = 'fcm_token';
    private const REFRESH_EARLY = 300;

    /** The token for this process, so one worker run does not reread the row per send. */
    private static ?array $memo = null;

    private ?array $account = null;
    private bool $accountLoaded = false;

    public function name(): string { return 'fcm'; }
    public function channel(): string { return 'push'; }

    public function isConfigured(): bool
    {
        return trim(notifyEnv('FCM_PROJECT_ID')) !== '' && $this->account() !== null;
    }

    public function send(NotifyMessage $m): NotifyResult
    {
        return NotifyProviderSupport::guard('fcm', function () use ($m): NotifyResult {
            $account = $this->account();
            $project = trim(notifyEnv('FCM_PROJECT_ID'));
            if ($account === null || $project === '') {
                return NotifyResult::skipped('not configured: FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON are required');
            }

            $devices = array_values(array_filter(
                $m->devices,
                static fn($d) => is_array($d) && ($d['provider'] ?? '') === 'fcm' && trim((string) ($d['endpoint'] ?? '')) !== ''
            ));
            if ($devices === []) return NotifyResult::skipped('no FCM device');

            $token = $this->accessToken($account, false);
            if (isset($token['error'])) return NotifyResult::retry($token['error'], '', $token['retryAfter'] ?? null);

            $url = rtrim(notifyEnv('FCM_BASE_URL', 'https://fcm.googleapis.com'), '/')
                 . '/v1/projects/' . rawurlencode($project) . '/messages:send';

            $results = [];
            $log = [];
            $retryAfter = null;
            $firstName = null;
            $refreshed = false;
            foreach ($devices as $device) {
                $id   = (int) ($device['id'] ?? 0);
                $body = (string) json_encode(['message' => $this->message($m, trim((string) $device['endpoint']))], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
                $res  = self::post($url, $token['token'], $body);

                if ((int) $res['status'] === 401 && !$refreshed) {
                    // A cached token Google no longer honours: mint one, try once more.
                    $refreshed = true;
                    $fresh = $this->accessToken($account, true);
                    if (isset($fresh['error'])) {
                        $results[$id] = self::outcome(false, false, true, $fresh['error']);
                        $log[] = 'device #' . $id . ': token refresh failed';
                        $retryAfter = max($retryAfter ?? 0, (int) ($fresh['retryAfter'] ?? 3600));
                        continue;
                    }
                    $token = $fresh;
                    $res = self::post($url, $token['token'], $body);
                }

                [$outcome, $wait, $name] = self::classify($res);
                $results[$id] = $outcome;
                $firstName ??= $name;
                if ($wait !== null) $retryAfter = max($retryAfter ?? 0, $wait);
                $log[] = 'device #' . $id . ': ' . NotifyProviderSupport::describe($res) . ' ' . mb_substr(trim($res['body']), 0, 300);
            }
            return NotifyProviderSupport::pushOutcome($results, $firstName, implode("\n", $log), $retryAfter, 'FCM');
        });
    }

    /** FCM reports nothing back by callback; delivery data lives in Firebase's own reporting. */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return ['ok' => false, 'status' => 404, 'error' => 'FCM has no status callbacks'];
    }

    /**
     * The v1 message for one registration token.
     * Data values must all be strings: FCM rejects the whole message otherwise.
     */
    private function message(NotifyMessage $m, string $token): array
    {
        $d    = $m->data;
        $link = NotifyProviderSupport::absoluteUrl(self::text($d['url'] ?? null) ?? $m->ctaUrl) ?? siteUrl('/notifications');
        $high = in_array($m->priority, ['urgent', 'emergency'], true);

        $notification = ['title' => $m->title, 'body' => $m->body];
        // FCM fetches the image itself and refuses anything but https.
        $image = NotifyProviderSupport::httpsUrl(self::text($d['image'] ?? null) ?? $m->imageUrl);
        if ($image !== null) $notification['image'] = $image;

        $message = [
            'token'        => $token,
            'notification' => $notification,
            'data'         => [
                'url'            => $link,
                'notificationId' => self::text($d['notificationId'] ?? null) ?? (string) $m->notificationId,
                'category'       => self::text($d['category'] ?? null) ?? $m->category,
                'priority'       => self::text($d['priority'] ?? null) ?? $m->priority,
                'tag'            => self::text($d['tag'] ?? null) ?? 'notification-' . $m->notificationId,
            ],
            // High priority wakes a dozing Android phone; FCM throttles apps that
            // use it for messages the devotee does not act on, so only urgent ones.
            'android'      => ['priority' => $high ? 'high' : 'normal'],
            'apns'         => [
                'headers' => ['apns-priority' => $high ? '10' : '5'],
                'payload' => ['aps' => ['sound' => 'default']],
            ],
        ];
        $https = NotifyProviderSupport::httpsUrl($link);
        if ($https !== null) $message['webpush'] = ['fcm_options' => ['link' => $https]];
        return $message;
    }

    /**
     * One response → [device outcome, retry-after|null, message name|null].
     * Error codes: UNREGISTERED (404) the app was uninstalled or the token rotated;
     * INVALID_ARGUMENT (400) a malformed message or token; QUOTA_EXCEEDED (429),
     * UNAVAILABLE (503) and INTERNAL (500) are transient.
     */
    private static function classify(array $res): array
    {
        $status = (int) $res['status'];
        $json   = NotifyProviderSupport::json($res['body']);
        if ($status === 200 && is_string($json['name'] ?? null)) {
            return [self::outcome(true, false, false, 'accepted'), null, $json['name']];
        }

        $error = is_array($json['error'] ?? null) ? $json['error'] : [];
        $code  = '';
        foreach ((array) ($error['details'] ?? []) as $detail) {
            if (is_array($detail) && is_string($detail['errorCode'] ?? null)) { $code = $detail['errorCode']; break; }
        }
        $state   = is_string($error['status'] ?? null) ? $error['status'] : '';
        $message = notifyRedact(is_string($error['message'] ?? null) ? $error['message'] : '', 200);
        $wait    = NotifyProviderSupport::retryAfter($res['headers']);

        if ($code === 'UNREGISTERED' || $status === 404) {
            return [self::outcome(false, true, false, 'the FCM registration token is no longer valid (UNREGISTERED)'), null, null];
        }
        if ($code === 'THIRD_PARTY_AUTH_ERROR') {
            return [self::outcome(false, false, true, 'FCM could not authenticate with APNs or the web push service: check the Firebase project credentials'), 3600, null];
        }
        if ($status === 401) {
            return [self::outcome(false, false, true, 'FCM refused the access token: check that the service account may send Firebase messages'), 3600, null];
        }
        if (in_array($code, ['QUOTA_EXCEEDED', 'UNAVAILABLE', 'INTERNAL'], true)
            || in_array($state, ['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL'], true)
            || $status === 429 || $status === 0 || $status >= 500) {
            $why = $code !== '' ? $code : ($state !== '' ? $state : NotifyProviderSupport::describe($res));
            return [self::outcome(false, false, true, 'FCM is temporarily unavailable (' . $why . ')'), $wait, null];
        }
        if ($code === 'SENDER_ID_MISMATCH') {
            return [self::outcome(false, false, false, 'the FCM token belongs to a different Firebase project (SENDER_ID_MISMATCH)'), null, null];
        }
        if ($code === 'INVALID_ARGUMENT' || $state === 'INVALID_ARGUMENT' || $status === 400) {
            return [self::outcome(false, false, false, 'FCM refused the message as invalid' . ($message !== '' ? ': ' . $message : '')), null, null];
        }
        if ($status === 403) {
            return [self::outcome(false, false, true, 'FCM denied permission: check FCM_PROJECT_ID and the service account role'), 3600, null];
        }
        return [self::outcome(false, false, false, 'FCM refused the message (' . NotifyProviderSupport::describe($res) . ')'), null, null];
    }

    private static function post(string $url, string $token, string $body): array
    {
        return notifyHttp('POST', $url, [
            'Authorization' => 'Bearer ' . $token,
            'Content-Type'  => 'application/json; charset=utf-8',
            'Accept'        => 'application/json',
        ], $body, 15);
    }

    /**
     * ['token' => string] or ['error' => reason, 'retryAfter' => ?int].
     * $refresh skips both caches, for the 401 path.
     */
    private function accessToken(array $account, bool $refresh): array
    {
        $now = time();
        if (!$refresh) {
            foreach ([self::$memo, $this->kvRead()] as $cached) {
                if (is_array($cached)
                    && ($cached['fingerprint'] ?? '') === $account['fingerprint']
                    && is_string($cached['token'] ?? null) && $cached['token'] !== ''
                    && (int) ($cached['expires_at'] ?? 0) - self::REFRESH_EARLY > $now) {
                    self::$memo = $cached;
                    return ['token' => $cached['token']];
                }
            }
        }

        $assertion = $this->assertion($account, $now);
        if ($assertion === null) {
            return ['error' => 'could not sign the FCM service account assertion (openssl)', 'retryAfter' => 3600];
        }
        $res = notifyHttp('POST', self::tokenUrl(), [
            'Content-Type' => 'application/x-www-form-urlencoded',
            'Accept'       => 'application/json',
        ], [
            'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion'  => $assertion,
        ], 15);

        $json = NotifyProviderSupport::json($res['body']);
        if ((int) $res['status'] === 200 && is_string($json['access_token'] ?? null) && $json['access_token'] !== '') {
            $entry = [
                'token'       => $json['access_token'],
                'expires_at'  => $now + max(60, (int) ($json['expires_in'] ?? 3600)),
                'fingerprint' => $account['fingerprint'],
            ];
            self::$memo = $entry;
            $this->kvWrite($entry);
            return ['token' => $entry['token']];
        }

        $status = (int) $res['status'];
        if ($status === 0 || $status === 429 || $status >= 500) {
            return ['error' => 'could not get an FCM access token (' . NotifyProviderSupport::describe($res) . ')', 'retryAfter' => NotifyProviderSupport::retryAfter($res['headers'])];
        }
        // invalid_grant is nearly always a revoked key or a server clock that has drifted.
        $why = is_string($json['error'] ?? null) ? $json['error'] : NotifyProviderSupport::describe($res);
        return ['error' => 'Google refused the FCM service account (' . $why . '): check FCM_SERVICE_ACCOUNT_JSON and the server clock', 'retryAfter' => 3600];
    }

    /** The RS256 JWT Google exchanges for an access token. aud is the token URL itself. */
    private function assertion(array $account, int $now): ?string
    {
        $header = ['alg' => 'RS256', 'typ' => 'JWT'];
        if ($account['private_key_id'] !== '') $header['kid'] = $account['private_key_id'];
        $input = notifyB64u((string) json_encode($header)) . '.' . notifyB64u((string) json_encode([
            'iss'   => $account['client_email'],
            'scope' => self::SCOPE,
            'aud'   => self::tokenUrl(),
            'iat'   => $now,
            'exp'   => $now + 3600,
        ], JSON_UNESCAPED_SLASHES));
        $signature = '';
        $ok = openssl_sign($input, $signature, $account['key'], OPENSSL_ALGO_SHA256);
        while (openssl_error_string() !== false) {
            // drain
        }
        return $ok ? $input . '.' . notifyB64u($signature) : null;
    }

    /**
     * The service account, parsed once: ['client_email', 'private_key_id', 'key', 'fingerprint'], or null.
     * FCM_SERVICE_ACCOUNT_JSON is the JSON itself when it starts with "{", otherwise a file path.
     */
    private function account(): ?array
    {
        if ($this->accountLoaded) return $this->account;
        $this->accountLoaded = true;

        $raw = trim(notifyEnv('FCM_SERVICE_ACCOUNT_JSON'));
        if ($raw === '') return null;
        if (!str_starts_with($raw, '{')) {
            if (!is_file($raw) || !is_readable($raw)) {
                error_log('[notify] fcm: FCM_SERVICE_ACCOUNT_JSON names a file that cannot be read');
                return null;
            }
            $raw = (string) file_get_contents($raw);
        }
        $json = json_decode($raw, true);
        if (!is_array($json) || !is_string($json['client_email'] ?? null) || $json['client_email'] === ''
            || !is_string($json['private_key'] ?? null) || $json['private_key'] === '') {
            error_log('[notify] fcm: the service account JSON does not parse or lacks client_email and private_key');
            return null;
        }
        $key = openssl_pkey_get_private($json['private_key']);
        while (openssl_error_string() !== false) {
            // drain
        }
        if ($key === false) {
            error_log('[notify] fcm: the service account private_key could not be loaded');
            return null;
        }
        $keyId = is_string($json['private_key_id'] ?? null) ? $json['private_key_id'] : '';
        return $this->account = [
            'client_email'   => $json['client_email'],
            'private_key_id' => $keyId,
            'key'            => $key,
            'fingerprint'    => substr(hash('sha256', implode("\n", [$json['client_email'], $keyId, hash('sha256', $json['private_key']), self::tokenUrl()])), 0, 32),
        ];
    }

    private static function tokenUrl(): string
    {
        return notifyEnv('FCM_TOKEN_URL', 'https://oauth2.googleapis.com/token');
    }

    private function kvRead(): ?array
    {
        try {
            $stmt = getDB()->prepare('SELECT v FROM notification_kv WHERE k = :k');
            $stmt->execute([':k' => self::KV_KEY]);
            $value = $stmt->fetchColumn();
        } catch (Throwable $e) {
            // No cache is slower, not broken: every send mints a token.
            return null;
        }
        $decoded = is_string($value) ? json_decode($value, true) : null;
        return is_array($decoded) ? $decoded : null;
    }

    private function kvWrite(array $entry): void
    {
        try {
            $json = (string) json_encode($entry);
            getDB()->prepare(
                'INSERT INTO notification_kv (k, v, updated_at) VALUES (:k, :v, UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE v = :v2, updated_at = UTC_TIMESTAMP()'
            )->execute([':k' => self::KV_KEY, ':v' => $json, ':v2' => $json]);
        } catch (Throwable $e) {
            error_log('[notify] fcm: could not cache the access token: ' . notifyRedact($e->getMessage(), 200));
        }
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
