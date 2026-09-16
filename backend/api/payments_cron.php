<?php
/**
 * api/payments_cron.php — the payments check over HTTP, for hosts without CLI
 * cron (routed at /api/payments-cron, GET or POST; docs/payments/SPEC.md §9.1).
 *
 * Off unless PAYMENTS_CRON_KEY is set to at least 24 characters: until then the
 * endpoint answers 404 and says nothing about itself. With a key, a caller must
 * send it — preferably as the X-Cron-Key header, because a ?key= query string
 * ends up in access logs — and it is compared in constant time. Wrong keys are
 * counted per address (30 an hour).
 *
 * Call it every 10 minutes. Each call checks at most 40 attempts for at most 25
 * seconds; a MySQL lock makes overlapping calls harmless.
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/payments.php';
require_once __DIR__ . '/../includes/rate_limit.php';

ini_set('display_errors', '0');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

$configured = envValue('PAYMENTS_CRON_KEY');
if (strlen($configured) < 24) {
    if ($configured !== '') error_log('[payments-cron] PAYMENTS_CRON_KEY is shorter than 24 characters, so the endpoint stays off');
    sendJson(['error' => 'Not found'], 404);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    sendJson(['error' => 'Method not allowed'], 405);
}

if (!rateLimitPeek('payments-cron-denied', 30, 3600)) {
    sendJson(['error' => 'Too many attempts'], 429);
}
$sent = $_SERVER['HTTP_X_CRON_KEY'] ?? ($_GET['key'] ?? '');
if (!is_string($sent) || $sent === '' || !hash_equals($configured, $sent)) {
    rateLimitAllow('payments-cron-denied', 30, 3600);
    error_log('[payments-cron] refused a request with a missing or wrong key from ' . clientIp());
    sendJson(['error' => 'Forbidden'], 403);
}

if (!payTablesExist()) {
    sendJson(['error' => 'Online payments are not installed on this site yet.', 'code' => 'payments_disabled'], 503);
}

// The scheduler may hang up early; the run should still finish and release its lock.
ignore_user_abort(true);
@set_time_limit(60);

try {
    $result = payCronRun(['trigger' => 'http', 'limit' => 40, 'max_seconds' => 25, 'actor' => 'cron']);
} catch (Throwable $e) {
    error_log('[payments-cron] ' . get_class($e) . ': ' . $e->getMessage());
    sendJson(['error' => 'The payments check could not run.', 'code' => 'cron_failed'], 500);
}
sendJson([
    'checked'   => $result['checked'],
    'changed'   => $result['changed'],
    'cancelled' => $result['cancelled'],
    'expired'   => $result['expired'],
    'errors'    => $result['errors'],
]);
