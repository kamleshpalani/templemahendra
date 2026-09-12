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
    // X-CSRF-Token is the double-submit header every devotee state change sends.
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-CSRF-Token');
    // Session cookies only cross origins when credentials are allowed, and the
    // browser forbids that against a wildcard origin. In production the site and
    // the API share an origin, so this matters only for a split deployment where
    // CORS_ORIGIN names the site explicitly.
    if ($origin !== '*') {
        header('Access-Control-Allow-Credentials: true');
        header('Vary: Origin');
    }
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

/**
 * Shared password policy for every account on the site, admin or devotee.
 * Returns a sentence explaining the problem, or '' when acceptable.
 * Deliberately simple, so the message can always say what to do next.
 */
function passwordProblem(string $password, string $identity = ''): string
{
    if (mb_strlen($password) < 10)         return 'Use at least 10 characters.';
    if (mb_strlen($password) > 200)        return 'That password is too long.';
    if (!preg_match('/[a-z]/', $password)) return 'Include at least one lowercase letter.';
    if (!preg_match('/[A-Z]/', $password)) return 'Include at least one uppercase letter.';
    if (!preg_match('/\d/', $password))    return 'Include at least one number.';
    if ($identity !== '') {
        $stem = explode('@', $identity)[0];
        if ($stem !== '' && mb_strlen($stem) >= 3 && stripos($password, $stem) !== false) {
            return 'Do not put your name or email in the password.';
        }
    }
    foreach (['password', 'temple', '12345678', 'qwerty', 'admin123', 'letmein', 'welcome'] as $bad) {
        if (stripos($password, $bad) !== false) return 'That password is too easy to guess.';
    }
    return '';
}

/**
 * True when $value is a real calendar date in YYYY-MM-DD form.
 * A regex alone is not enough: "9999-99-99" matches the shape but MySQL
 * rejects it, which would surface as an uncaught PDOException.
 */
function isValidDate(string $value): bool
{
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $value, $m)) return false;
    return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
}

function intParam(string $key, int $default = 0): int
{
    return isset($_GET[$key]) ? (int) $_GET[$key] : $default;
}

function boolParam(string $key): bool
{
    return isset($_GET[$key]) && $_GET[$key] !== '0' && $_GET[$key] !== 'false';
}
