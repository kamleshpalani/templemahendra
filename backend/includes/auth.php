<?php
// backend/includes/auth.php — Simple session-based admin authentication.

session_start();

function requireAdminAuth(): void
{
    if (empty($_SESSION['admin_logged_in'])) {
        header('Location: /admin/login.php');
        exit;
    }
}

/**
 * Read an env var from getenv(), $_ENV, or $_SERVER — whichever has it.
 * Apache + Docker sometimes only exposes vars via $_SERVER.
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
