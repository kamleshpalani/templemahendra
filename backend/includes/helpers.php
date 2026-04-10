<?php
// backend/includes/helpers.php

require_once __DIR__ . '/../config/config.php';

function sendJson(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function sendError(string $message, int $status = 400): never
{
    sendJson(['error' => $message], $status);
}

function setCorsHeaders(): void
{
    $origin = CORS_ORIGIN;
    header("Access-Control-Allow-Origin: $origin");
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function getJsonBody(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

/**
 * Sanitise a plain text input — strip tags and limit length.
 */
function sanitizeText(string $value, int $maxLen = 500): string
{
    return mb_substr(strip_tags(trim($value)), 0, $maxLen);
}

function intParam(string $key, int $default = 0): int
{
    return isset($_GET[$key]) ? (int) $_GET[$key] : $default;
}

function boolParam(string $key): bool
{
    return isset($_GET[$key]) && $_GET[$key] !== '0' && $_GET[$key] !== 'false';
}
