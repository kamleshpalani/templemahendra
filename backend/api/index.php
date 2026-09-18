<?php
// backend/api/index.php — Simple front-controller router for the public API.

require_once __DIR__ . '/../includes/helpers.php';

// The API must answer with JSON even when something breaks: a PHP stack trace
// would leak server paths and would not parse on the client. Logged for us,
// generic for the caller.
if (!function_exists('appDebug')) {
    function appDebug(): bool
    {
        $v = getenv('APP_DEBUG') ?: ($_ENV['APP_DEBUG'] ?? $_SERVER['APP_DEBUG'] ?? '');
        return $v === '1' || strtolower((string) $v) === 'true';
    }
}
if (!appDebug()) {
    ini_set('display_errors', '0');
}
ini_set('log_errors', '1');
set_exception_handler(function (Throwable $e): void {
    $ref = strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
    error_log(sprintf('[api %s] %s: %s in %s:%d', $ref, get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
    }
    echo json_encode([
        'error'     => 'The server could not complete that request. Please try again.',
        'reference' => $ref,
    ] + (appDebug() ? ['debug' => $e->getMessage()] : []), JSON_UNESCAPED_UNICODE);
    exit;
});
register_shutdown_function(function (): void {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        $ref = strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
        error_log(sprintf('[api %s] fatal: %s in %s:%d', $ref, $e['message'], $e['file'], $e['line']));
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'The server could not complete that request.', 'reference' => $ref]);
        }
    }
});

setCorsHeaders();

$uri    = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = $_SERVER['REQUEST_METHOD'];

// Strip /api prefix if present
$path = preg_replace('#^/api#', '', $uri);
$path = rtrim($path, '/') ?: '/';

// Signed links from inside a notification: tracked clicks, the email open
// pixel and unsubscribe. They answer a redirect, a GIF or an HTML page rather
// than JSON, so they are matched first and exactly; the token's signature is
// checked in n.php. Any other shape under /n/ is simply not a route.
if (preg_match('#^/n/([cou])/([cou][0-9]{1,10}\.[A-Za-z0-9_-]{16})$#', $path, $trackMatch)) {
    $trackKind  = $trackMatch[1];
    $trackToken = $trackMatch[2];
    require __DIR__ . '/n.php';
    exit;
}
if (str_starts_with($path, '/n/')) {
    sendError('Not found', 404);
}

// Delivery status callbacks from WhatsApp, SMS and push providers, any method.
// notify_webhook.php verifies the provider's signature and answers the body
// and Content-Type that provider expects.
if (preg_match('#^/notify-webhook/([a-z0-9]{2,16})$#', $path, $webhookMatch)) {
    $webhookDriver = $webhookMatch[1];
    require __DIR__ . '/notify_webhook.php';
    exit;
}
if (str_starts_with($path, '/notify-webhook/')) {
    sendError('Not found', 404);
}

// The notification worker over HTTP, for hosts without CLI cron. The endpoint
// itself answers 404 until NOTIFY_CRON_KEY is set, and 405 for anything but
// GET or POST once it is.
if ($path === '/notify-cron') {
    require __DIR__ . '/notify_cron.php';
    exit;
}

// The family registration form. Matched for every method, not only POST, so a
// GET is told 405 "Method not allowed" rather than a 404 that suggests the form
// is not there (docs/registration/SPEC.md §5).
if ($path === '/registrations') {
    require __DIR__ . '/registrations.php';
    exit;
}

// Online payments (docs/payments/SPEC.md §5.5). Matched for every method:
// payments.php answers 405s itself, and the CCAvenue return routes answer a
// redirect or plain text rather than JSON, catching their own errors.
if (preg_match('#^/payments/(config|donations|seva-bookings|retry|status|receipt|receipt-email|verify|ccavenue/response|ccavenue/cancel|ccavenue/notify|simulator|simulator/api)$#', $path, $payMatch)) {
    $payRoute = $payMatch[1];
    require __DIR__ . '/payments.php';
    exit;
}
if (str_starts_with($path, '/payments/')) sendError('Not found', 404);
if ($path === '/payments-cron') { require __DIR__ . '/payments_cron.php'; exit; }
if ($path === '/live-cron') { require __DIR__ . '/live_cron.php'; exit; }

// Live darshan (docs/live/SPEC-PHASE1.md §4.3, SPEC-PHASE2.md §1.1). Public
// reads go to live_streams.php with $liveRoute ('index', 'live', 'upcoming',
// 'schedule', an id or a slug — the named routes are listed before the slug
// branch and are reserved slugs, so a stream can never shadow one); it answers
// 405 for anything but GET/HEAD. The committee's JSON API under /admin/ uses
// the admin session and answers 401/403 as JSON, never a redirect. Anything
// else under either prefix is not a route.
if (preg_match('#^/live-streams(?:/(live|upcoming|schedule|[0-9]{1,10}|[a-z0-9][a-z0-9-]{1,118}))?$#', $path, $liveMatch)) { $liveRoute = $liveMatch[1] ?? 'index'; require __DIR__ . '/live_streams.php'; exit; }
if (str_starts_with($path, '/live-streams/')) sendError('Not found', 404);
if ($path === '/live-subscriptions' || $path === '/live-subscriptions/unsubscribe') {
    $liveSubscriptionAction = str_ends_with($path, '/unsubscribe') ? 'unsubscribe' : 'subscribe';
    require __DIR__ . '/live_subscriptions.php';
    exit;
}
if (preg_match('#^/admin/live-streams(?:/([0-9]{1,10}))?$#', $path, $liveAdminMatch)) { $liveAdminId = isset($liveAdminMatch[1]) ? (int) $liveAdminMatch[1] : null; require __DIR__ . '/admin_live_streams.php'; exit; }
if (str_starts_with($path, '/admin/')) sendError('Not found', 404);

$routes = [
    'GET'  => [
        '/announcements'   => 'announcements.php',
        '/search'          => 'search.php',
        '/sevas'           => 'sevas.php',
        '/events'          => 'events.php',
        '/gallery'         => 'gallery.php',
        '/pulse'           => 'pulse.php',
        '/donors'          => 'donors.php',
        '/reviews'         => 'reviews.php',
        '/calendar'        => 'calendar.php',
        '/pournamis'       => 'pournamis.php',
        '/homepage_widgets'=> 'homepage_widgets.php',
        '/settings'        => 'settings.php',
    ],
    'POST' => [
        '/donations'      => 'donations.php',
        '/contact'        => 'contact.php',
        '/seva-bookings'  => 'seva_bookings.php',
        '/chat'           => 'chat.php',
    ],
];

$handler = $routes[$method][$path] ?? null;

if ($handler === null) {
    sendError('Not found', 404);
}

require __DIR__ . '/' . $handler;
