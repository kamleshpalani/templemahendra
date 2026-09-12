<?php
// router.php — PHP built-in server router for local development.
// Usage: php -S localhost:8000 router.php

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// Route all /api/* requests through the front-controller
if (str_starts_with($uri, '/api')) {
    require __DIR__ . '/api/index.php';
    return true;
}

// Resolve the file path
$file = __DIR__ . $uri;

// If it's a directory, look for index.php inside it
if (is_dir($file)) {
    $indexFile = rtrim($file, '/') . '/index.php';
    if (file_exists($indexFile)) {
        require $indexFile;
        return true;
    }
}

// Serve existing .php files directly
if (file_exists($file) && str_ends_with($file, '.php')) {
    require $file;
    return true;
}

// Let built-in server handle static files (css, js, images, etc.)
if (file_exists($file) && !is_dir($file)) {
    return false;
}

// Dev convenience: serve public frontend assets (logo.svg, favicon.svg, icons/)
// that live in public_html/ on Hostinger but in frontend/public/ locally.
$publicAsset = realpath(__DIR__ . '/../frontend/public' . $uri);
$publicRoot  = realpath(__DIR__ . '/../frontend/public');
if ($publicAsset && $publicRoot && str_starts_with($publicAsset, $publicRoot) && is_file($publicAsset)) {
    $types = ['svg' => 'image/svg+xml', 'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'webp' => 'image/webp', 'ico' => 'image/x-icon', 'webmanifest' => 'application/manifest+json', 'json' => 'application/json'];
    $ext = strtolower(pathinfo($publicAsset, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
    readfile($publicAsset);
    return true;
}

http_response_code(404);
echo json_encode(['error' => 'Not found']);
