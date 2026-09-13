<?php
/**
 * backend/includes/notify/contracts.php — the seam between the Notification
 * Service and whatever actually delivers a message.
 *
 * The service decides WHAT to send, to WHOM, on WHICH channels, and WHEN. A
 * provider only knows HOW to hand one already-rendered message to one outside
 * system — SMTP, Meta's WhatsApp Cloud API, Twilio, MSG91, a Web Push endpoint,
 * Firebase. Swapping Twilio for MSG91 is a change to one environment variable,
 * because nothing outside a provider class ever names a provider.
 *
 *   NOTIFY_EMAIL_DRIVER     mailer (default) | log | test
 *   NOTIFY_WHATSAPP_DRIVER  log (default) | meta | twilio | test
 *   NOTIFY_SMS_DRIVER       log (default) | twilio | msg91 | test
 *   NOTIFY_PUSH_DRIVER      log (default) | webpush | fcm | test
 *
 * `log` records the message in backend/logs/notify.log instead of sending it,
 * and says so: its results carry recordedOnly = true, and the delivery is
 * stored against provider "log" so no report counts it as delivered to a
 * person. `test` is a deterministic fake for the test suites and refuses to
 * load unless NOTIFY_ALLOW_TEST_DRIVER=1.
 *
 * Provider classes live one per file in notify/providers/<ClassName>.php and are
 * loaded on first use. docs/notifications/SPEC.md §5 is the full contract.
 */

require_once __DIR__ . '/../helpers.php';

const NOTIFY_CHANNELS          = ['inapp', 'email', 'whatsapp', 'sms', 'push'];
const NOTIFY_EXTERNAL_CHANNELS = ['email', 'whatsapp', 'sms', 'push'];
const NOTIFY_PRIORITIES        = ['normal', 'important', 'urgent', 'emergency'];
const NOTIFY_PRIORITY_RANK     = ['emergency' => 0, 'urgent' => 1, 'important' => 2, 'normal' => 3];

/* ── The provider interface ─────────────────────────────────────────────── */

interface NotifyProvider
{
    /** The driver name as configured: log, test, mailer, meta, twilio, msg91, webpush, fcm. */
    public function name(): string;

    /** The channel this instance delivers: email, whatsapp, sms or push. */
    public function channel(): string;

    /**
     * True when every setting the driver needs is present. The service does not
     * attempt a channel whose provider is not configured: it records the
     * delivery as skipped ("not configured") rather than failed, because nothing
     * went wrong with the message.
     */
    public function isConfigured(): bool;

    /**
     * Deliver one message. MUST NOT throw — an unexpected error is a
     * NotifyResult::retry(), so the queue can try again later.
     */
    public function send(NotifyMessage $message): NotifyResult;

    /**
     * Turn a provider's status callback into delivery updates.
     *
     * Verify the request's signature FIRST; an unverifiable request returns
     *   ['ok' => false, 'status' => 403, 'error' => 'signature mismatch']
     * On success:
     *   ['ok' => true, 'status' => 200, 'response' => ?string body to echo
     *    (Meta's hub.challenge, Twilio's empty TwiML),
     *    'updates' => [['message_id' => string,
     *                   'status' => 'sent'|'delivered'|'read'|'failed'|'rejected',
     *                   'error' => ?string, 'at' => ?string UTC 'Y-m-d H:i:s'], …]]
     *
     * $headers keys are lowercased. $requestUrl is the absolute URL the provider
     * called, which Twilio's signature covers.
     */
    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array;
}

/* ── What a provider is handed ──────────────────────────────────────────── */

/**
 * One message, already rendered for one channel and one recipient. Providers
 * never render templates or read the database; everything they need is here.
 */
final class NotifyMessage
{
    /**
     * @param array $devices  push only: [['id' => int, 'provider' => 'webpush'|'fcm'|'apns',
     *                          'endpoint' => string, 'keys' => ['p256dh' => string, 'auth' => string]|null]]
     * @param array $templateParams  ordered string values for an approved provider template
     * @param array $buttons  [['type' => 'url'|'call'|'quick_reply', 'text' => string, 'value' => string]]
     *                        url: absolute https URL; call: E.164 with plus; quick_reply: payload id
     * @param array $headers  email only: extra headers, e.g. ['List-Unsubscribe' => '<https://…>',
     *                        'List-Unsubscribe-Post' => 'List-Unsubscribe=One-Click']
     * @param array $data     push only: ['url' => absolute deep link, 'trackUrl' => ?string,
     *                        'notificationId' => int, 'category' => string, 'priority' => string,
     *                        'tag' => string, 'image' => ?string]
     */
    public function __construct(
        public readonly int $deliveryId,
        public readonly int $notificationId,
        public readonly string $channel,
        public readonly string $lang,
        public readonly string $category,
        public readonly string $priority,
        public readonly string $title,
        public readonly string $body,
        public readonly int $attempt = 1,
        public readonly ?string $html = null,
        public readonly ?string $ctaUrl = null,
        public readonly ?string $ctaLabel = null,
        public readonly ?string $imageUrl = null,
        public readonly ?string $toEmail = null,
        public readonly ?string $toPhone = null,
        public readonly array $devices = [],
        public readonly ?string $providerTemplate = null,
        public readonly array $templateParams = [],
        public readonly array $buttons = [],
        public readonly array $headers = [],
        public readonly array $data = [],
        public readonly string $idempotencyKey = '',
    ) {
    }

    /** The recipient's number with its plus, as most APIs want it: "+919876543210". */
    public function phoneE164(): ?string
    {
        $d = preg_replace('/\D+/', '', (string) $this->toPhone) ?? '';
        return $d === '' ? null : '+' . $d;
    }
}

/* ── What a provider returns ────────────────────────────────────────────── */

/**
 * The outcome of one send.
 *
 *   sent      the provider accepted it. Delivery and read receipts, where the
 *             provider has them, arrive later through handleWebhook().
 *   retry     a transient failure: the queue tries again with backoff until the
 *             channel's attempt limit, then marks the delivery dead.
 *   rejected  a permanent failure (bad number, template not approved, endpoint
 *             gone). Never retried.
 *   skipped   nothing was attempted (not configured, no device).
 *
 * Responses are redacted and trimmed on construction, so a provider cannot
 * accidentally store a phone number or an access token in the delivery log.
 */
final class NotifyResult
{
    public const SENT     = 'sent';
    public const RETRY    = 'retry';
    public const REJECTED = 'rejected';
    public const SKIPPED  = 'skipped';

    /**
     * @param array $deviceResults push only: [deviceId => ['ok' => bool, 'gone' => bool, 'reason' => string]]
     *                             A device reported gone (HTTP 404/410, UNREGISTERED) is retired.
     */
    private function __construct(
        public readonly string $status,
        public readonly ?string $messageId,
        public readonly string $reason,
        public readonly string $response,
        public readonly ?int $retryAfter,
        public readonly array $deviceResults,
        public readonly bool $recordedOnly,
    ) {
    }

    public static function sent(?string $messageId, string $response = '', array $deviceResults = [], bool $recordedOnly = false): self
    {
        return new self(self::SENT, $messageId, '', notifyRedact($response), null, $deviceResults, $recordedOnly);
    }

    public static function retry(string $reason, string $response = '', ?int $retryAfterSeconds = null, array $deviceResults = []): self
    {
        return new self(self::RETRY, null, mb_substr($reason, 0, 300), notifyRedact($response), $retryAfterSeconds, $deviceResults, false);
    }

    public static function rejected(string $reason, string $response = '', array $deviceResults = []): self
    {
        return new self(self::REJECTED, null, mb_substr($reason, 0, 300), notifyRedact($response), null, $deviceResults, false);
    }

    public static function skipped(string $reason): self
    {
        return new self(self::SKIPPED, null, mb_substr($reason, 0, 120), '', null, [], false);
    }

    public function ok(): bool
    {
        return $this->status === self::SENT;
    }
}

/* ── Shared helpers for providers ───────────────────────────────────────── */

/** An environment value; see envValue() in helpers.php. */
function notifyEnv(string $key, string $default = ''): string
{
    return envValue($key, $default);
}

/**
 * Remove what must never reach a log: email addresses, phone numbers, bearer
 * and access tokens, API keys, OTP-looking codes after "code". Keeps enough of
 * each (domain, last four digits) to tell two failures apart.
 */
function notifyRedact(string $text, int $max = 2000): string
{
    if ($text === '') return '';
    $s = $text;
    // Authorization headers and token-shaped fields, in JSON or form encoding.
    $s = preg_replace('/(authorization\s*[:=]\s*)(bearer|basic)?\s*[A-Za-z0-9._~+\/=-]+/i', '$1[redacted]', $s) ?? $s;
    $s = preg_replace('/("?(?:access_token|token|auth_token|api_key|apikey|authkey|secret|password|client_secret|private_key)"?\s*[:=]\s*"?)[^"&,\s}]+/i', '$1[redacted]', $s) ?? $s;
    // Email addresses: keep the first character and the domain.
    $s = preg_replace_callback('/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/', fn($m) => $m[1] . '***@' . $m[2], $s) ?? $s;
    // Phone-like digit runs of 8–15 (optionally with plus or whatsapp: prefix): keep the last four.
    $s = preg_replace_callback('/(\+?)(\d{4,11})(\d{4})(?!\d)/', fn($m) => $m[1] . str_repeat('•', strlen($m[2])) . $m[3], $s) ?? $s;
    return mb_substr($s, 0, $max);
}

/**
 * One HTTP request with curl, for providers. Never throws.
 *
 * @param array             $headers ['Name' => 'value']
 * @param string|array|null $body    a string is sent as-is; an array is form-encoded
 * @return array{status:int, headers:array, body:string, error:string}
 *         status is 0 when the request never completed (DNS, TLS, timeout);
 *         response header names are lowercased.
 */
function notifyHttp(string $method, string $url, array $headers = [], string|array|null $body = null, int $timeoutSeconds = 15): array
{
    if (!function_exists('curl_init')) {
        return ['status' => 0, 'headers' => [], 'body' => '', 'error' => 'The PHP curl extension is not available.'];
    }
    $ch = curl_init($url);
    $lines = [];
    foreach ($headers as $k => $v) $lines[] = $k . ': ' . $v;
    $respHeaders = [];
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => strtoupper($method),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $lines,
        CURLOPT_TIMEOUT        => max(1, $timeoutSeconds),
        CURLOPT_CONNECTTIMEOUT => min(10, max(1, $timeoutSeconds)),
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$respHeaders): int {
            $p = strpos($line, ':');
            if ($p !== false) $respHeaders[strtolower(trim(substr($line, 0, $p)))] = trim(substr($line, $p + 1));
            return strlen($line);
        },
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_array($body) ? http_build_query($body) : $body);
    }
    $out    = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error  = $out === false ? (curl_error($ch) ?: 'request failed') : '';
    curl_close($ch);
    return ['status' => $out === false ? 0 : $status, 'headers' => $respHeaders, 'body' => $out === false ? '' : (string) $out, 'error' => $error];
}

/** Base64url without padding, as Web Push, VAPID and JWTs use. */
function notifyB64u(string $raw): string
{
    return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

function notifyB64uDecode(string $text): string
{
    $t = strtr($text, '-_', '+/');
    return (string) base64_decode($t . str_repeat('=', (4 - strlen($t) % 4) % 4), true);
}

/**
 * Append one line to a file in backend/logs/, creating the directory with the
 * deny-all guard the mailer uses — these logs can hold one-time codes.
 */
function notifyLogWrite(string $file, string $text): void
{
    $dir = __DIR__ . '/../../logs';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $guard = $dir . '/.htaccess';
    if (is_dir($dir) && !file_exists($guard)) {
        @file_put_contents(
            $guard,
            "# Contains verification links and one-time codes. Never serve this.\n"
            . "<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n"
            . "<IfModule !mod_authz_core.c>\n  Order Allow,Deny\n  Deny from all\n</IfModule>\n"
        );
    }
    @file_put_contents($dir . '/' . basename($file), $text . "\n", FILE_APPEND | LOCK_EX);
}

/* ── Registry ───────────────────────────────────────────────────────────── */

/**
 * channel => [driver name => class name]. The one place provider classes are
 * named. A driver whose class file does not exist resolves to "unavailable".
 */
function notifyProviderRegistry(): array
{
    return [
        'email'    => ['log' => 'NotifyLogProvider', 'test' => 'NotifyTestProvider', 'mailer' => 'NotifyMailerProvider'],
        'whatsapp' => ['log' => 'NotifyLogProvider', 'test' => 'NotifyTestProvider', 'meta' => 'NotifyMetaWhatsAppProvider', 'twilio' => 'NotifyTwilioWhatsAppProvider'],
        'sms'      => ['log' => 'NotifyLogProvider', 'test' => 'NotifyTestProvider', 'twilio' => 'NotifyTwilioSmsProvider', 'msg91' => 'NotifyMsg91SmsProvider'],
        'push'     => ['log' => 'NotifyLogProvider', 'test' => 'NotifyTestProvider', 'webpush' => 'NotifyWebPushProvider', 'fcm' => 'NotifyFcmProvider'],
    ];
}

/** The driver configured for a channel. Email defaults to the existing mailer, the rest to log. */
function notifyDriverName(string $channel): string
{
    $defaults = ['email' => 'mailer', 'whatsapp' => 'log', 'sms' => 'log', 'push' => 'log'];
    $value = strtolower(trim(notifyEnv('NOTIFY_' . strtoupper($channel) . '_DRIVER', $defaults[$channel] ?? 'log')));
    return $value === '' ? ($defaults[$channel] ?? 'log') : $value;
}

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'Notify') || !preg_match('/^[A-Za-z0-9]+$/', $class)) return;
    $file = __DIR__ . '/providers/' . $class . '.php';
    if (is_file($file)) require_once $file;
});

/**
 * The provider for a channel. Cached per request; pass $fresh = true in tests
 * that change the environment between calls.
 */
function notifyProviderFor(string $channel, bool $fresh = false): NotifyProvider
{
    static $cache = [];
    if (!$fresh && isset($cache[$channel])) return $cache[$channel];

    $registry = notifyProviderRegistry();
    if (!isset($registry[$channel])) {
        return $cache[$channel] = new NotifyUnavailableProvider($channel, 'unknown channel');
    }
    $driver = notifyDriverName($channel);
    if ($driver === 'test' && notifyEnv('NOTIFY_ALLOW_TEST_DRIVER') !== '1') {
        error_log("[notify] NOTIFY_{$channel}_DRIVER=test refused: set NOTIFY_ALLOW_TEST_DRIVER=1 (test environments only).");
        return $cache[$channel] = new NotifyUnavailableProvider($channel, 'test driver not allowed here');
    }
    $class = $registry[$channel][$driver] ?? null;
    if ($class === null || !class_exists($class)) {
        error_log("[notify] no provider class for {$channel} driver \"{$driver}\"");
        return $cache[$channel] = new NotifyUnavailableProvider($channel, "unknown driver \"{$driver}\"");
    }
    $provider = in_array($class, ['NotifyLogProvider', 'NotifyTestProvider'], true)
        ? new $class($channel)
        : new $class();
    return $cache[$channel] = $provider;
}

/* ── Built-in providers ─────────────────────────────────────────────────── */

/** A channel with no working provider. Every send is skipped, never failed. */
final class NotifyUnavailableProvider implements NotifyProvider
{
    public function __construct(private string $channelName, private string $why = 'not configured')
    {
    }

    public function name(): string { return 'unavailable'; }
    public function channel(): string { return $this->channelName; }
    public function isConfigured(): bool { return false; }

    public function send(NotifyMessage $message): NotifyResult
    {
        return NotifyResult::skipped('not configured: ' . $this->why);
    }

    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return ['ok' => false, 'status' => 404, 'error' => 'no provider'];
    }
}

/**
 * Records messages in backend/logs/notify.log instead of sending them. The
 * default for WhatsApp, SMS and push until a provider is configured — and the
 * way a developer reads a one-time code locally.
 */
final class NotifyLogProvider implements NotifyProvider
{
    public function __construct(private string $channelName)
    {
    }

    public function name(): string { return 'log'; }
    public function channel(): string { return $this->channelName; }
    public function isConfigured(): bool { return true; }

    public function send(NotifyMessage $m): NotifyResult
    {
        $to = match ($m->channel) {
            'email'   => (string) $m->toEmail,
            'push'    => count($m->devices) . ' device(s)',
            default   => (string) $m->phoneE164(),
        };
        $id = 'log-' . bin2hex(random_bytes(6));
        notifyLogWrite('notify.log', sprintf(
            "===== %s  %s  delivery #%d  attempt %d  %s\nTo: %s\nTitle: %s\n%s%s%s\n",
            gmdate('c'), strtoupper($m->channel), $m->deliveryId, $m->attempt, $id, $to, $m->title, $m->body,
            $m->ctaUrl ? "\nLink: " . $m->ctaUrl : '',
            $m->providerTemplate ? "\nProvider template: " . $m->providerTemplate . ' ' . json_encode($m->templateParams, JSON_UNESCAPED_UNICODE) : ''
        ));
        $devices = [];
        foreach ($m->devices as $d) $devices[(int) $d['id']] = ['ok' => true, 'gone' => false, 'reason' => 'recorded'];
        return NotifyResult::sent($id, 'recorded in backend/logs/notify.log; no provider is configured', $devices, true);
    }

    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        return ['ok' => false, 'status' => 404, 'error' => 'the log driver receives no callbacks'];
    }
}

/**
 * A deterministic fake for the test suites. Refuses to load unless
 * NOTIFY_ALLOW_TEST_DRIVER=1.
 *
 * Behaviour is chosen by the recipient, so a test can provoke each outcome:
 *   email local part, phone number or device endpoint containing / ending in
 *     "retry"  or digits ending 0001  → retry (retryAfter 1 second)
 *     "reject" or digits ending 0002  → rejected
 *     "flaky"  or digits ending 0003  → retry on attempt 1, sent afterwards
 *     "gone"   (device endpoint)      → sent, with that device reported gone
 *   anything else                      → sent, message id "test-<deliveryId>"
 *
 * Every call appends one JSON line to backend/logs/notify-test.log with the
 * whole message, so a test can assert exactly what would have gone out.
 *
 * Webhooks: POST JSON {"updates":[{message_id,status,error?,at?}]} with header
 * X-Test-Signature = hex HMAC-SHA256 of the raw body keyed with
 * NOTIFY_TEST_WEBHOOK_SECRET (default "test-webhook-secret").
 */
final class NotifyTestProvider implements NotifyProvider
{
    public function __construct(private string $channelName)
    {
    }

    public function name(): string { return 'test'; }
    public function channel(): string { return $this->channelName; }
    public function isConfigured(): bool { return true; }

    public function send(NotifyMessage $m): NotifyResult
    {
        notifyLogWrite('notify-test.log', json_encode([
            'at' => gmdate('c'), 'channel' => $m->channel, 'deliveryId' => $m->deliveryId,
            'notificationId' => $m->notificationId, 'attempt' => $m->attempt, 'lang' => $m->lang,
            'category' => $m->category, 'priority' => $m->priority, 'title' => $m->title, 'body' => $m->body,
            'html' => $m->html !== null, 'ctaUrl' => $m->ctaUrl, 'ctaLabel' => $m->ctaLabel, 'imageUrl' => $m->imageUrl,
            'toEmail' => $m->toEmail, 'toPhone' => $m->toPhone, 'devices' => array_map(fn($d) => $d['endpoint'] ?? '', $m->devices),
            'providerTemplate' => $m->providerTemplate, 'templateParams' => $m->templateParams, 'buttons' => $m->buttons,
            'headers' => $m->headers, 'data' => $m->data, 'idempotencyKey' => $m->idempotencyKey,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

        $key = strtolower((string) ($m->toEmail ?? '')) . ' ' . preg_replace('/\D+/', '', (string) $m->toPhone);
        foreach ($m->devices as $d) $key .= ' ' . strtolower((string) ($d['endpoint'] ?? ''));

        if (str_contains($key, 'reject') || preg_match('/0002(\s|$)/', $key)) {
            return NotifyResult::rejected('simulated permanent rejection', '{"error":"rejected by test driver"}');
        }
        if (str_contains($key, 'retry') || preg_match('/0001(\s|$)/', $key)) {
            return NotifyResult::retry('simulated transient failure', '{"error":"try again"}', 1);
        }
        if ((str_contains($key, 'flaky') || preg_match('/0003(\s|$)/', $key)) && $m->attempt <= 1) {
            return NotifyResult::retry('simulated first-attempt failure', '{"error":"flaky"}', 1);
        }
        $devices = [];
        foreach ($m->devices as $d) {
            $gone = str_contains(strtolower((string) ($d['endpoint'] ?? '')), 'gone');
            $devices[(int) $d['id']] = ['ok' => !$gone, 'gone' => $gone, 'reason' => $gone ? 'simulated 410 Gone' : 'accepted'];
        }
        return NotifyResult::sent('test-' . $m->deliveryId, '{"ok":true}', $devices);
    }

    public function handleWebhook(string $method, array $headers, string $rawBody, array $query, string $requestUrl): array
    {
        $secret = notifyEnv('NOTIFY_TEST_WEBHOOK_SECRET', 'test-webhook-secret');
        $sent   = (string) ($headers['x-test-signature'] ?? '');
        if ($sent === '' || !hash_equals(hash_hmac('sha256', $rawBody, $secret), $sent)) {
            return ['ok' => false, 'status' => 403, 'error' => 'signature mismatch'];
        }
        $json = json_decode($rawBody, true);
        $updates = [];
        foreach ((array) ($json['updates'] ?? []) as $u) {
            if (!is_array($u) || empty($u['message_id']) || empty($u['status'])) continue;
            $updates[] = [
                'message_id' => (string) $u['message_id'],
                'status'     => (string) $u['status'],
                'error'      => isset($u['error']) ? (string) $u['error'] : null,
                'at'         => isset($u['at']) ? (string) $u['at'] : null,
            ];
        }
        return ['ok' => true, 'status' => 200, 'response' => '{"ok":true}', 'updates' => $updates];
    }
}
