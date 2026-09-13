<?php
/**
 * backend/api/notify_webhook.php — /api/notify-webhook/<driver>
 *
 * Where WhatsApp, SMS and push providers report what happened to a message
 * after they accepted it: delivered, read, failed. api/index.php routes here
 * with $webhookDriver (meta, twilio, msg91, fcm, test).
 *
 * Every provider proves who it is differently — Meta signs the body with the
 * app secret, Twilio signs the URL and form fields with the auth token, MSG91
 * signs nothing and relies on a token in the URL — so this file verifies
 * nothing itself. It finds the channel(s) configured with that driver, hands
 * the raw request to the provider's handleWebhook(), and applies only updates
 * the provider has verified. One Twilio account can serve WhatsApp and SMS
 * from the same URL, so each configured channel is tried in turn and the
 * first that verifies the request handles it.
 *
 * Rules this file keeps:
 *   • A request that does not verify gets 403 and an empty body. Why it failed
 *     goes to the error log for us, never to the caller.
 *   • Fast: nothing is sent from here. Providers time out slow webhooks and
 *     then deliver the same callback again.
 *   • Providers expect their own bodies (Meta's challenge, Twilio's TwiML), so
 *     this answers plain text or XML and sets its own Content-Type rather than
 *     relying on the API's JSON error handler.
 *   • An internal failure answers 500 with an empty body so the provider
 *     redelivers later; its detail goes only to the error log.
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php'; // clientIp(), for the log line on a refusal

// notify.php brings notifyApplyProviderUpdate(). Without it (a partial deploy)
// callbacks are still verified and acknowledged, and the log says what was lost.
if (is_file(__DIR__ . '/../includes/notify.php')) {
    require_once __DIR__ . '/../includes/notify.php';
} else {
    require_once __DIR__ . '/../includes/notify/contracts.php';
}

try {
    $driver = strtolower(isset($webhookDriver) && is_string($webhookDriver) ? $webhookDriver : '');
    if (!preg_match('/^[a-z0-9]{2,16}$/', $driver)) {
        notifyWebhookRespond(404, '{"error":"Not found"}', 'application/json; charset=utf-8');
    }

    $channels = [];
    foreach (NOTIFY_EXTERNAL_CHANNELS as $channel) {
        if (notifyDriverName($channel) === $driver) $channels[] = $channel;
    }
    // Nothing configured with this driver: the URL is not an endpoint on this site.
    if ($channels === []) {
        notifyWebhookRespond(404, '{"error":"Not found"}', 'application/json; charset=utf-8');
    }

    // Status callbacks are a few kilobytes. A megabyte is generous and still
    // stops a hostile caller from making the server hash an arbitrary upload.
    $maxBytes = 1048576;
    $raw = (string) file_get_contents('php://input', false, null, 0, $maxBytes + 1);
    if (strlen($raw) > $maxBytes) {
        notifyWebhookRespond(413, '', 'text/plain; charset=utf-8');
    }

    $method  = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $headers = notifyWebhookHeaders();
    $query   = notifyWebhookQuery((string) ($_SERVER['QUERY_STRING'] ?? ''));
    $url     = notifyWebhookRequestUrl();

    $accepted = null;
    $last = ['ok' => false, 'status' => 403, 'error' => 'unverified'];
    foreach ($channels as $channel) {
        $provider = notifyProviderFor($channel);
        try {
            $result = $provider->handleWebhook($method, $headers, $raw, $query, $url);
        } catch (Throwable $e) {
            error_log(sprintf('[notify-webhook] %s/%s handler error: %s', $driver, $channel, notifyRedact($e->getMessage(), 300)));
            $result = ['ok' => false, 'status' => 500, 'error' => 'handler error'];
        }
        if (is_array($result) && !empty($result['ok'])) {
            $accepted = [$provider, $result];
            break;
        }
        if (is_array($result)) $last = $result;
    }

    if ($accepted === null) {
        $status = (int) ($last['status'] ?? 403);
        $status = in_array($status, [400, 403, 404, 405, 500], true) ? $status : 403;
        // 404 and 405 are ordinary (a driver with no callbacks, a stray GET);
        // anything else is someone failing to prove they are the provider.
        if ($status !== 404 && $status !== 405) {
            error_log(sprintf(
                '[notify-webhook] %s %s refused with %d (%s) from %s',
                $driver, $method, $status, preg_replace('/[^\w .-]/', '', (string) ($last['error'] ?? 'unverified')), clientIp()
            ));
        }
        notifyWebhookRespond($status, '', 'text/plain; charset=utf-8');
    }

    [$provider, $result] = $accepted;
    notifyWebhookApply($driver, $provider->name(), is_array($result['updates'] ?? null) ? $result['updates'] : []);

    $body = is_string($result['response'] ?? null) ? $result['response'] : '';
    notifyWebhookRespond(
        (int) ($result['status'] ?? 200),
        $body,
        is_string($result['content_type'] ?? null) ? $result['content_type'] : notifyWebhookGuessType($body)
    );
} catch (Throwable $e) {
    error_log(sprintf('[notify-webhook] internal error: %s: %s', get_class($e), notifyRedact($e->getMessage(), 300)));
    notifyWebhookRespond(500, '', 'text/plain; charset=utf-8');
}

/**
 * Hand verified updates to the service. One bad update must not lose the
 * rest, and a failure is logged rather than answered: the provider did its
 * part, and redelivering the same callback would not fix our side.
 */
function notifyWebhookApply(string $driver, string $providerName, array $updates): void
{
    if ($updates === []) return;
    if (!function_exists('notifyApplyProviderUpdate')) {
        error_log(sprintf('[notify-webhook] %s: %d verified status update(s) not applied: notifyApplyProviderUpdate() is not available', $driver, count($updates)));
        return;
    }
    foreach ($updates as $update) {
        if (!is_array($update)) continue;
        $id     = is_scalar($update['message_id'] ?? null) ? trim((string) $update['message_id']) : '';
        $status = is_string($update['status'] ?? null) ? $update['status'] : '';
        if ($id === '' || !in_array($status, ['sent', 'delivered', 'read', 'failed', 'rejected'], true)) continue;
        $error = is_scalar($update['error'] ?? null) ? mb_substr((string) $update['error'], 0, 300) : null;
        $at    = is_string($update['at'] ?? null) && preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $update['at']) ? $update['at'] : null;
        try {
            notifyApplyProviderUpdate($providerName, mb_substr($id, 0, 190), $status, $error, $at);
        } catch (Throwable $e) {
            error_log(sprintf('[notify-webhook] %s: could not apply a status update: %s', $driver, notifyRedact($e->getMessage(), 300)));
        }
    }
}

/** Request headers with lowercase names, as handleWebhook() expects. */
function notifyWebhookHeaders(): array
{
    $headers = [];
    foreach ($_SERVER as $key => $value) {
        if (is_string($key) && is_string($value) && str_starts_with($key, 'HTTP_')) {
            $headers[strtolower(str_replace('_', '-', substr($key, 5)))] = $value;
        }
    }
    foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $key => $name) {
        if (isset($_SERVER[$key]) && is_string($_SERVER[$key])) $headers[$name] = $_SERVER[$key];
    }
    // getallheaders() keeps names exactly as sent where the server offers it.
    if (function_exists('getallheaders')) {
        foreach ((array) getallheaders() as $name => $value) {
            if (is_string($value)) $headers[strtolower((string) $name)] = $value;
        }
    }
    return $headers;
}

/**
 * The query string as name => value, parsed by hand: PHP's $_GET turns
 * "hub.verify_token" into "hub_verify_token", and Meta's names have dots.
 */
function notifyWebhookQuery(string $queryString): array
{
    $query = [];
    foreach (NotifyProviderSupport::parseForm($queryString) as $name => $values) {
        $query[(string) $name] = (string) end($values);
    }
    return $query;
}

/**
 * The absolute URL the provider called. Scheme and host come from SITE_URL,
 * the published address, because behind Hostinger's proxy the server may see
 * plain http on an internal name while Twilio signed https://the-temple-domain.
 */
function notifyWebhookRequestUrl(): string
{
    $site   = parse_url(siteUrl());
    $scheme = is_array($site) && !empty($site['scheme']) ? strtolower((string) $site['scheme']) : 'https';
    $host   = is_array($site) && !empty($site['host']) ? (string) $site['host'] : 'localhost';
    $port   = is_array($site) && isset($site['port']) ? ':' . (int) $site['port'] : '';
    $uri    = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    return $scheme . '://' . $host . $port . (str_starts_with($uri, '/') ? $uri : '/' . $uri);
}

function notifyWebhookGuessType(string $body): string
{
    $first = ltrim($body)[0] ?? '';
    return match ($first) {
        '{', '[' => 'application/json; charset=utf-8',
        '<'      => 'text/xml; charset=utf-8',
        default  => 'text/plain; charset=utf-8',
    };
}

function notifyWebhookRespond(int $status, string $body, string $contentType): never
{
    if (!headers_sent()) {
        http_response_code($status >= 200 && $status <= 599 ? $status : 200);
        header('Content-Type: ' . $contentType);
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
    }
    echo $body;
    exit;
}
