<?php
/**
 * tests/support/notify_webhook_router.php — a PHP built-in server router that
 * serves only the provider webhook endpoint, for tests/notify-providers.mjs.
 *
 *   php -S 127.0.0.1:8020 tests/support/notify_webhook_router.php
 *
 * backend/api/index.php gains the /notify-webhook/<driver> route in phase 2
 * (SPEC §6.6). Until then this stands in for it, routing exactly as that route
 * will — same path, same driver pattern, same $webhookDriver variable — so the
 * endpoint is exercised over real HTTP with the headers, raw body and query
 * string a provider sends. Each test server is started with the provider
 * secrets it needs exported in its environment.
 */

if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}

$path = parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';

if (preg_match('#^/api/notify-webhook/([a-z0-9]{2,16})$#', rtrim($path, '/'), $match)) {
    $webhookDriver = $match[1];
    require __DIR__ . '/../../backend/api/notify_webhook.php';
    return true;
}

// Readiness probe for the suite: answers once the server is accepting requests.
if ($path === '/__health') {
    header('Content-Type: text/plain; charset=utf-8');
    echo 'ok';
    return true;
}

http_response_code(404);
header('Content-Type: application/json; charset=utf-8');
echo '{"error":"Not found"}';
return true;
