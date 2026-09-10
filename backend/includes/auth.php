<?php
// backend/includes/auth.php — Simple session-based admin authentication.

session_start();

// Load .env.local for local development if it exists
$_envFile = __DIR__ . '/../../.env.local';
if (file_exists($_envFile)) {
    foreach (file($_envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $_line) {
        if (str_starts_with(trim($_line), '#') || !str_contains($_line, '=')) continue;
        [$_k, $_v] = explode('=', $_line, 2);
        putenv(trim($_k) . '=' . trim($_v));
    }
}
unset($_envFile, $_line, $_k, $_v);

function requireAdminAuth(): void
{
    if (empty($_SESSION['admin_logged_in'])) {
        header('Location: /admin/login.php');
        exit;
    }
}

/**
 * Read an env var from getenv(), $_ENV, or $_SERVER — whichever has it.
 * Hostinger's PHP config sometimes only exposes vars via $_SERVER.
 */
function readEnv(string $key, string $default = ''): string
{
    $val = getenv($key);
    if ($val !== false && $val !== '') return $val;
    if (!empty($_ENV[$key]))    return (string) $_ENV[$key];
    if (!empty($_SERVER[$key])) return (string) $_SERVER[$key];
    return $default;
}

function adminLogin(string $username, string $password): bool
{
    $storedHash = readEnv('ADMIN_PASS_HASH');
    $storedUser = readEnv('ADMIN_USERNAME', 'admin');

    if ($storedHash === '' || $username !== $storedUser) {
        return false;
    }
    return password_verify($password, $storedHash);
}

function adminLogout(): void
{
    $_SESSION = [];
    session_destroy();
}

/** Per-session CSRF token for admin forms. */
function csrfToken(): string
{
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function csrfField(): string
{
    return '<input type="hidden" name="_csrf" value="' . htmlspecialchars(csrfToken()) . '" />';
}

function csrfValid(): bool
{
    $sent = (string) ($_POST['_csrf'] ?? '');
    return $sent !== '' && hash_equals(csrfToken(), $sent);
}
