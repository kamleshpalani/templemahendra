<?php
// backend/api/reviews.php
// Fetches Google Place reviews and caches them for 1 hour.
// Requires env vars:
//   GOOGLE_PLACES_API_KEY  — your Google Places API key
//   GOOGLE_PLACE_ID        — the Place ID for the temple (e.g. ChIJ...)

require_once __DIR__ . '/../includes/helpers.php';

setCorsHeaders();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    sendError('Method not allowed', 405);
}

$apiKey  = getenv('GOOGLE_PLACES_API_KEY');
$placeId = getenv('GOOGLE_PLACE_ID') ?: 'ChIJC7fy3Gexbzs...'; // placeholder

// ── Serve from cache if fresh (1 hour) ──────────────────────
$cacheFile = sys_get_temp_dir() . '/temple_reviews_cache.json';
if (file_exists($cacheFile) && (time() - filemtime($cacheFile)) < 3600) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Cache: HIT');
    readfile($cacheFile);
    exit;
}

// ── If no API key configured, return empty gracefully ────────
if (!$apiKey || str_starts_with($apiKey, 'YOUR_')) {
    sendJson(['reviews' => [], 'rating' => null, 'total_ratings' => 0, 'configured' => false]);
}

// ── Fetch from Google Places API ────────────────────────────
$url = 'https://maps.googleapis.com/maps/api/place/details/json'
     . '?place_id=' . urlencode($placeId)
     . '&fields=name,rating,user_ratings_total,reviews'
     . '&reviews_sort=newest'
     . '&language=en'
     . '&key=' . urlencode($apiKey);

$ctx = stream_context_create(['http' => [
    'timeout'           => 8,
    'follow_location'   => 1,
    'user_agent'        => 'TempleSite/1.0',
]]);

$raw = @file_get_contents($url, false, $ctx);

if ($raw === false) {
    sendError('Could not reach Google Places API', 502);
}

$data = json_decode($raw, true);

if (($data['status'] ?? '') !== 'OK') {
    sendError('Google Places error: ' . ($data['status'] ?? 'unknown'), 502);
}

$place   = $data['result'] ?? [];
$reviews = $place['reviews'] ?? [];

// Sanitise — only expose what the frontend needs
$out = [
    'configured'    => true,
    'rating'        => $place['rating'] ?? null,
    'total_ratings' => $place['user_ratings_total'] ?? 0,
    'reviews'       => array_map(fn($r) => [
        'author'      => $r['author_name'] ?? '',
        'avatar'      => $r['profile_photo_url'] ?? '',
        'rating'      => $r['rating'] ?? 5,
        'text'        => $r['text'] ?? '',
        'time'        => $r['relative_time_description'] ?? '',
        'timestamp'   => $r['time'] ?? 0,
    ], $reviews),
];

// Cache the result
file_put_contents($cacheFile, json_encode($out, JSON_UNESCAPED_UNICODE));

sendJson($out);
