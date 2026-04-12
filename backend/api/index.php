<?php
// backend/api/index.php — Simple front-controller router for the public API.

require_once __DIR__ . '/../includes/helpers.php';

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
