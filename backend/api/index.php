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

/**
 * The safety net behind API_ENVELOPE (includes/helpers.php): an output buffer
 * over the whole /api/v1 request that wraps a JSON answer printed without
 * sendJson() — admin_live_streams.php's liveAdminJson() and its raw 401,
 * reviews.php's cache file, a handler's own '{"error":"Not found"}', the 500
 * handlers below — and leaves every other Content-Type alone: HTML, XML, text,
 * a GIF or a redirect go out exactly as printed. An answer sendJson() already
 * wrapped is recognised by its shape and never wrapped twice. Only the final
 * flush is looked at; a clean (the 500 handlers) empties the buffer.
 */
function apiEnvelopeBuffer(string $buffer, int $phase): string
{
    if (!($phase & PHP_OUTPUT_HANDLER_FINAL)) {
        return ($phase & PHP_OUTPUT_HANDLER_CLEAN) ? '' : $buffer;
    }
    $type = '';
    foreach (headers_list() as $h) {
        if (stripos($h, 'Content-Type:') === 0) $type = strtolower(trim(substr($h, 13)));
    }
    if (!str_starts_with($type, 'application/json')) return $buffer;
    $raw = trim($buffer);
    if ($raw === '') return $buffer;
    $status  = (int) http_response_code();
    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        // Called JSON but not JSON (a notice printed ahead of the body): a
        // well-formed 500 is more use to a client than a broken page.
        if ($status < 400) { $status = 500; http_response_code(500); }
        return json_encode(apiEnvelope(['error' => 'The server could not complete that request. Please try again.'], $status), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    if (is_array($decoded) && isset($decoded['success']) && is_bool($decoded['success']) && (
        $decoded['success']
            ? array_key_exists('data', $decoded) && array_key_exists('message', $decoded) && count($decoded) === 3
            : is_array($decoded['error'] ?? null) && isset($decoded['error']['code'], $decoded['error']['message']) && count($decoded) === 2
    )) {
        return $buffer;   // sendJson() wrapped it already
    }
    if ($status < 400) {
        return '{"success":true,"data":' . $raw . ',"message":""}';   // the handler's own bytes, untouched
    }
    return json_encode(apiEnvelope($decoded, $status), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** Under API_ENVELOPE, drop whatever the buffer holds so a 500 is the whole answer. */
function apiEnvelopeDiscard(): void
{
    if (!defined('API_ENVELOPE_LEVEL')) return;
    while (ob_get_level() > API_ENVELOPE_LEVEL) ob_end_clean();
    if (ob_get_level() === API_ENVELOPE_LEVEL) ob_clean();
}

set_exception_handler(function (Throwable $e): void {
    $ref = strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
    error_log(sprintf('[api %s] %s: %s in %s:%d', $ref, get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    apiEnvelopeDiscard();
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
        apiEnvelopeDiscard();
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

// ── /api/v1 (brief §26) ─────────────────────────────────────────────────────
// /api/v1/<anything> is an alias of /api/<anything>: the version is stripped
// here, before any route is looked at, so both prefixes share the one route
// table and the same handlers. Under the prefix every JSON answer carries the
// brief's envelope — API_ENVELOPE, applied by sendJson() and, for the few
// handlers that print JSON themselves, by apiEnvelopeBuffer() above — while
// the unversioned /api/* keeps today's shapes byte for byte. The brief's
// resource names that differ from the routes below are aliased, under v1 only;
// no unversioned route is renamed or changed:
//   /api/v1/home        → /api/homepage_widgets   the homepage cards
//   /api/v1/streams[/…] → /api/live-streams[/…]   live, upcoming, schedule, archive, <id|slug>[/donations]
//   /api/v1/sponsors    → /api/poojas             sponsorship amount, availability, the consented sponsor
// /pages, /deities, /poojas, /events, /calendar, /announcements, /gallery,
// /donations, /payments/ccavenue/*, /contact and /settings already carry the
// brief's name. There is no /auth resource: admin sign-in is the HTML form at
// /admin/login.php, and the devotee account API was retired.
$apiVersioned = preg_match('#^/v1(?=/|$)#', $path) === 1;
if ($apiVersioned) {
    $path = substr($path, 3);
}
$path = rtrim($path, '/') ?: '/';
if ($apiVersioned) {
    $apiAliases = ['/home' => '/homepage_widgets', '/sponsors' => '/poojas'];
    if (isset($apiAliases[$path])) {
        $path = $apiAliases[$path];
    } elseif (preg_match('#^/streams(/.*)?$#', $path, $streamAlias)) {
        $path = '/live-streams' . ($streamAlias[1] ?? '');
    }
}
// The envelope is for API consumers. Answers a browser or a provider reads —
// the CCAvenue return, cancel and server notification, the local simulator,
// the notification providers' webhooks and the tracked links inside a
// notification — keep the body those readers expect, versioned or not.
$apiPassThrough = preg_match('#^/(payments/ccavenue/|payments/simulator|notify-webhook/|n/)#', $path) === 1;
define('API_ENVELOPE', $apiVersioned && !$apiPassThrough);
if (API_ENVELOPE) {
    ob_start('apiEnvelopeBuffer');
    define('API_ENVELOPE_LEVEL', ob_get_level());
}

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
if (preg_match('#^/live-streams/([0-9]{1,10}|[a-z0-9][a-z0-9-]{1,118})/donations$#', $path, $liveMatch)) { $liveRoute = $liveMatch[1]; $liveDonations = true; require __DIR__ . '/live_streams.php'; exit; }
if (preg_match('#^/live-streams(?:/(live|upcoming|schedule|archive|[0-9]{1,10}|[a-z0-9][a-z0-9-]{1,118}))?$#', $path, $liveMatch)) { $liveRoute = $liveMatch[1] ?? 'index'; require __DIR__ . '/live_streams.php'; exit; }
if (str_starts_with($path, '/live-streams/')) sendError('Not found', 404);
if ($path === '/live-subscriptions' || $path === '/live-subscriptions/unsubscribe') {
    $liveSubscriptionAction = str_ends_with($path, '/unsubscribe') ? 'unsubscribe' : 'subscribe';
    require __DIR__ . '/live_subscriptions.php';
    exit;
}
if (preg_match('#^/admin/live-streams(?:/([0-9]{1,10}))?$#', $path, $liveAdminMatch)) { $liveAdminId = isset($liveAdminMatch[1]) ? (int) $liveAdminMatch[1] : null; require __DIR__ . '/admin_live_streams.php'; exit; }
if (str_starts_with($path, '/admin/')) sendError('Not found', 404);

// One event by id (brief §6): events.php answers the row, or 404 when it is hidden or absent.
if ($method === 'GET' && preg_match('#^/events/([0-9]{1,10})$#', $path, $eventMatch)) { $eventId = (int) $eventMatch[1]; require __DIR__ . '/events.php'; exit; }
// One CMS page by slug (brief §6, §15): pages.php answers the row, or 404 when it is hidden or absent.
if ($method === 'GET' && preg_match('#^/pages/([a-z0-9][a-z0-9-]{0,118})$#', $path, $pageMatch)) { $pageSlug = $pageMatch[1]; require __DIR__ . '/pages.php'; exit; }

$routes = [
    'GET'  => [
        '/announcements'   => 'announcements.php',
        '/deities'         => 'deities.php',
        '/videos'          => 'videos.php',
        '/search'          => 'search.php',
        '/sevas'           => 'sevas.php',
        '/events'          => 'events.php',
        '/gallery'         => 'gallery.php',
        '/gallery/albums'  => 'gallery.php',
        '/pulse'           => 'pulse.php',
        '/donors'          => 'donors.php',
        '/reviews'         => 'reviews.php',
        '/calendar'        => 'calendar.php',
        '/pournamis'       => 'pournamis.php',
        '/poojas'          => 'poojas.php',
        '/homepage_widgets'=> 'homepage_widgets.php',
        '/settings'        => 'settings.php',
        '/pages'           => 'pages.php',
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
