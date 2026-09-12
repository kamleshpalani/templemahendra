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

$routes = [
    'GET'  => [
        '/announcements'   => 'announcements.php',
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
