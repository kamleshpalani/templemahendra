<?php
// backend/includes/helpers.php

require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/temple_identity.php';

/*
 * API_ENVELOPE — the one flag behind the /api/v1 response envelope (brief §26).
 *
 * api/index.php defines it as true when the request carried the version
 * prefix (/api/v1/…), and sendJson() — so sendError() too — then wraps what it
 * is given in the brief's shape:
 *
 *   success  {"success":true,"data":<today's payload>,"message":""}
 *   error    {"success":false,"error":{"code":"VALIDATION_ERROR|NOT_FOUND|
 *             UNAUTHORIZED|FORBIDDEN|RATE_LIMITED|METHOD_NOT_ALLOWED|SERVER_ERROR",
 *             "message":"…","fields":{…}}}   (fields only when the endpoint has them)
 *
 * Left undefined — every unversioned /api/* request, og.php, sitemap.php,
 * robots.php, spa.php and the admin — both functions answer exactly what they
 * always have, byte for byte: the React app and every suite depend on it.
 */

/**
 * The /api/v1 envelope around one of today's payloads, for the given HTTP
 * status. Below 400 the payload becomes `data` untouched. From 400 up the
 * status picks the code; the endpoint's `error` sentence is the message, its
 * `fields` map is carried as `fields` (an empty one as {}), its own machine
 * code (`code`, e.g. "bad_token") as `reason`, and anything else it reported
 * (a 500's `reference`, `retryAfter`, a payment's `status`) is kept under
 * `error` as well, so nothing an unversioned caller can read is lost.
 */
function apiEnvelope(mixed $payload, int $status): array
{
    if ($status < 400) {
        return ['success' => true, 'data' => $payload, 'message' => ''];
    }
    [$code, $fallback] = match (true) {
        $status === 401 => ['UNAUTHORIZED', 'Sign in first'],
        $status === 403 => ['FORBIDDEN', 'Forbidden'],
        $status === 404 => ['NOT_FOUND', 'Not found'],
        $status === 405 => ['METHOD_NOT_ALLOWED', 'Method not allowed'],
        $status === 429 => ['RATE_LIMITED', 'Too many requests. Please try again later.'],
        $status >= 500  => ['SERVER_ERROR', 'The server could not complete that request. Please try again.'],
        default         => ['VALIDATION_ERROR', 'Please check the request.'],   // 400, 409, 413, 422, …
    };
    $given   = is_array($payload) ? $payload : [];
    $message = is_string($given['error'] ?? null) && $given['error'] !== '' ? $given['error']
             : (is_string($payload) && $payload !== '' ? $payload : $fallback);
    $error = ['code' => $code, 'message' => $message];
    if (is_string($given['code'] ?? null) && $given['code'] !== '') {
        $error['reason'] = $given['code'];
    }
    if (is_array($given['fields'] ?? null)) {
        $error['fields'] = $given['fields'] === [] ? new stdClass() : $given['fields'];
    }
    foreach ($given as $key => $value) {
        if (!in_array($key, ['error', 'code', 'fields'], true) && !array_key_exists($key, $error)) {
            $error[$key] = $value;
        }
    }
    return ['success' => false, 'error' => $error];
}

function sendJson(mixed $data, int $status = 200): never
{
    if (defined('API_ENVELOPE') && API_ENVELOPE) {
        $data = apiEnvelope($data, $status);
    }
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
 * Normalise a submitted phone number to the one form the database keeps:
 * E.164 without the plus, that is the country calling code followed by the
 * national significant number, digits only.
 *
 * Devotees live all over the world, so there is no ten-digit assumption here.
 * The client sends the already-joined number plus the ISO country it chose;
 * this only has to agree that the result is dialable. Per-country length rules
 * live in the browser, where they can explain themselves as someone types — the
 * server's job is the invariant that cannot be argued with: digits only, at
 * least 7 of them because no national number is shorter, and at most 15 because
 * that is E.164's ceiling.
 *
 * Returns ['phone' => string, 'country' => ?string, 'error' => string].
 * An empty submission is not an error when $required is false; it comes back as
 * an empty phone, which the caller stores as NULL.
 */
function normalizePhone(mixed $phone, mixed $country = null, bool $required = false): array
{
    $digits = preg_replace('/\D+/', '', (string) $phone);
    $iso    = strtoupper(trim((string) ($country ?? '')));
    $iso    = preg_match('/^[A-Z]{2}$/', $iso) ? $iso : null;

    if ($digits === '') {
        return ['phone' => '', 'country' => null, 'error' => $required ? 'Please enter a phone number.' : ''];
    }
    if (strlen($digits) < 7) {
        return ['phone' => '', 'country' => $iso, 'error' => 'That phone number is too short.'];
    }
    if (strlen($digits) > 15) {
        return ['phone' => '', 'country' => $iso, 'error' => 'That phone number is too long to dial internationally.'];
    }
    return ['phone' => $digits, 'country' => $iso, 'error' => ''];
}

/**
 * An ISO 3166-1 alpha-2 country code, or null when the value is not one.
 *
 * Shape only. The list of which codes the site offers lives in the browser
 * (frontend/src/data/countries.js), and there is nothing to gain here by
 * keeping a second copy in step with it: a two-letter code that is not on the
 * list is stored, shown back as itself, and harms nothing.
 */
function normalizeCountry(mixed $value): ?string
{
    $iso = strtoupper(trim((string) ($value ?? '')));
    return preg_match('/^[A-Z]{2}$/', $iso) ? $iso : null;
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

/*
 * Environment and public address.
 *
 * Both are guarded: mailer.php has defined siteUrl() since the first release and
 * either file can be the one loaded first in a given request.
 */
if (!function_exists('envValue')) {
    /** An environment value, from wherever the host exposes it. '' counts as unset. */
    function envValue(string $key, string $default = ''): string
    {
        $v = getenv($key);
        if ($v !== false && $v !== '') return $v;
        if (!empty($_ENV[$key]))    return (string) $_ENV[$key];
        if (!empty($_SERVER[$key])) return (string) $_SERVER[$key];
        return $default;
    }
}

if (!function_exists('siteUrl')) {
    /**
     * Absolute site URL with no trailing slash, for links that leave the server:
     * confirmation emails, canonical tags, Open Graph.
     *
     * SITE_URL wins because it is the address the temple publishes. Falling back
     * to the requested host keeps local development working, where there is no
     * canonical domain to know.
     */
    function siteUrl(string $path = ''): string
    {
        $base = rtrim(envValue('SITE_URL', ''), '/');
        if ($base === '') {
            $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
            $base   = $scheme . '://' . $host;
        }
        return $base . ($path === '' ? '' : '/' . ltrim($path, '/'));
    }
}
