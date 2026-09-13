<?php
/**
 * tests/support/notify_cron_router.php — a router for PHP's built-in server
 * that serves only /api/notify-cron, so tests/notify-worker.mjs can check the
 * endpoint's key handling before the API agent adds the route to api/index.php.
 *
 *   cd backend && php -S 127.0.0.1:8012 ../tests/support/notify_cron_router.php
 *
 * NOTIFY_CRON_TEST_HOLD_LOCK=1 makes the router take the worker's MySQL lock on
 * a second connection before the endpoint runs. The endpoint then answers 200
 * with "locked": true — proving the key was accepted and the worker was called —
 * without draining a queue that other test suites share. When the lock cannot be
 * taken (a real run holds it), the router answers 409 rather than let an
 * unscoped run loose.
 */

if (PHP_SAPI !== 'cli-server') {
    http_response_code(404);
    exit;
}

$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if ($path !== '/api/notify-cron') {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Not found']);
    return true;
}

$GLOBALS['notifyCronTestLockHolder'] = null;
if (getenv('NOTIFY_CRON_TEST_HOLD_LOCK') === '1' && strlen((string) getenv('NOTIFY_CRON_KEY')) >= 24) {
    $cfg = require __DIR__ . '/../../backend/config/database.php';
    $holder = new PDO(
        sprintf('mysql:host=%s;port=%s;dbname=%s;charset=%s', $cfg['host'], $cfg['port'], $cfg['name'], $cfg['charset']),
        $cfg['user'],
        $cfg['pass'],
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    if ((int) $holder->query("SELECT GET_LOCK('temple_notify_worker', 5)")->fetchColumn() !== 1) {
        http_response_code(409);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'the worker lock is busy; try again']);
        return true;
    }
    // Held until this request's PHP process ends, which releases the lock.
    $GLOBALS['notifyCronTestLockHolder'] = $holder;
}

require __DIR__ . '/../../backend/api/notify_cron.php';
return true;
