<?php
// router.php — PHP built-in server router for local development.
// Usage: php -S localhost:8000 router.php

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Route all /api/* requests through the front-controller
if (str_starts_with($uri, '/api')) {
    require __DIR__ . '/api/index.php';
    return true;
}

// Not found for everything else (no static files needed here)
http_response_code(404);
echo json_encode(['error' => 'Not found']);
