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

function adminLogin(string $username, string $password): bool
{
    $storedHash = getenv('ADMIN_PASS_HASH') ?: '';
    $storedUser = getenv('ADMIN_USERNAME')  ?: 'admin';

    if ($username !== $storedUser) {
        return false;
    }
    return password_verify($password, $storedHash);
}

function adminLogout(): void
{
    $_SESSION = [];
    session_destroy();
}
