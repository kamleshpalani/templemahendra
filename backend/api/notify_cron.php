<?php
/**
 * api/notify_cron.php — the notification worker over HTTP, for hosts without
 * CLI cron (routed at /api/notify-cron, GET or POST).
 *
 * Off unless NOTIFY_CRON_KEY is set to at least 24 characters: until then the
 * endpoint answers 404 and says nothing about itself. With a key, a caller must
 * send it — preferably as the X-Cron-Key header, because a ?key= query string
 * ends up in access logs — and it is compared in constant time.
 *
 * An external scheduler (cron-job.org, a monitoring service) calls it every
 * minute. Each call runs the worker for at most 25 seconds; the worker's MySQL
 * lock makes overlapping calls harmless.
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/notify.php';
require_once __DIR__ . '/../includes/devotee_auth.php';

header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

$configured = envValue('NOTIFY_CRON_KEY');
if (strlen($configured) < 24) {
    if ($configured !== '') error_log('[notify-cron] NOTIFY_CRON_KEY is shorter than 24 characters, so the endpoint stays off');
    sendJson(['error' => 'Not found'], 404);
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'POST') {
    header('Allow: GET, POST');
    sendJson(['error' => 'Method not allowed'], 405);
}

// Wrong keys are counted per address, so a scanner is slowed long before a
// 24-character key could be guessed, and the log is not flooded.
if (!rateLimitPeek('notify-cron-denied', 30, 3600)) {
    sendJson(['error' => 'Too many attempts'], 429);
}
$sent = $_SERVER['HTTP_X_CRON_KEY'] ?? ($_GET['key'] ?? '');
if (!is_string($sent) || $sent === '' || !hash_equals($configured, $sent)) {
    rateLimitAllow('notify-cron-denied', 30, 3600);
    error_log('[notify-cron] refused a request with a missing or wrong key from ' . clientIp());
    sendJson(['error' => 'Forbidden'], 403);
}

if (!notifyTablesExist()) {
    sendJson(['error' => 'Notifications are not enabled on this site yet.', 'code' => 'notifications_disabled'], 503);
}

// The scheduler may hang up early; the run should still finish and release its lock.
ignore_user_abort(true);
@set_time_limit(60);

try {
    $result = notifyWorkerRun(['trigger' => 'http', 'max_seconds' => 25]);
} catch (Throwable $e) {
    error_log('[notify-cron] ' . get_class($e) . ': ' . $e->getMessage());
    sendJson(['error' => 'The notification worker could not run.', 'code' => 'worker_failed'], 500);
}
sendJson($result);
