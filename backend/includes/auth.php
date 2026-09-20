<?php
// backend/includes/auth.php — session auth, roles and CSRF for the admin.
//
// Two kinds of account exist, deliberately:
//
//  1. The ENVIRONMENT admin (ADMIN_USERNAME / ADMIN_PASS_HASH). It always
//     works, always has the `owner` role, and cannot be disabled or deleted
//     from the UI. It is the bootstrap/recovery account: a deployment can
//     never lock itself out of its own control centre.
//  2. DATABASE accounts in `admin_users` (see database/migrations/001_admin_users.sql).
//     These are the committee's day-to-day logins and carry a role.
//
// Roles and the capabilities each one holds live in includes/roles.php.
//
// If the `admin_users` table has not been created yet the site behaves
// exactly as it did before: env admin only, full access.

require_once __DIR__ . '/roles.php';

// Session cookie: never readable from JavaScript, never sent cross-site, and
// only over HTTPS when the request itself arrived over HTTPS (Hostinger
// terminates TLS in front of Apache, so the forwarded header counts too).
if (session_status() === PHP_SESSION_NONE) {
    $_https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
           || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
           || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'secure'   => $_https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    ini_set('session.use_strict_mode', '1');
    unset($_https);
}
session_start();

/** Minutes of inactivity after which an admin must sign in again (ADMIN_IDLE_MINUTES, default 30). */
function adminIdleMinutes(): int
{
    $v = (int) readEnv('ADMIN_IDLE_MINUTES', '30');
    return $v > 0 ? min($v, 24 * 60) : 30;
}

/** Failed sign-ins per account before it is locked, and for how long. */
const ADMIN_LOCKOUT_ATTEMPTS = 10;
const ADMIN_LOCKOUT_MINUTES  = 15;

// One safety net for every admin page: errors are logged, never printed.
require_once __DIR__ . '/errors.php';

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


/**
 * Capability needed to OPEN each admin page. Unlisted pages need only 'view',
 * so a new page is readable by everyone signed in until it says otherwise.
 */
function adminPageCapability(string $file): string
{
    return [
        'homepage_widgets.php' => 'content.edit',
        'announcements.php'    => 'content.edit',
        'gallery.php'          => 'content.edit',
        'videos.php'           => 'content.edit',
        'poojas.php'           => 'content.edit',
        'deities.php'          => 'content.edit',
        'sevas.php'            => 'content.edit',
        'events.php'           => 'content.edit',
        'calendar_entries.php' => 'content.edit',
        'sponsors.php'         => 'finance.edit',
        'bulk_upload.php'      => 'import',
        'settings.php'         => 'settings.edit',
        'users.php'            => 'users.manage',
        'audit_log.php'        => 'audit.view',
        'notifications.php'          => 'notifications.view',
        'notification_segments.php'  => 'notifications.view',
        'notification_templates.php' => 'notifications.view',
        'notification_analytics.php' => 'notifications.view',
        'payments.php'               => 'payments.view',
        'payment_settings.php'       => 'payments.settings',
        'donation_categories.php'    => 'finance.edit',
        'live_streams.php'           => 'live.view',
        'live_settings.php'          => 'live.provider',
    ][$file] ?? 'view';
}

/**
 * Capability needed to POST to each admin page. This is the safety net that
 * makes `viewer` genuinely read-only: a page can be readable by everyone while
 * still refusing writes, and a new page cannot accidentally allow them.
 */
function adminPageWriteCapability(string $file): string
{
    $explicit = [
        'profile.php'          => 'view',          // anyone may change their own password
        'settings.php'         => 'settings.edit',
        'users.php'            => 'users.manage',
        'bulk_upload.php'      => 'import',
        'seva_bookings.php'    => 'devotees.edit',
        'donations.php'        => 'finance.edit',
        'sponsors.php'         => 'finance.edit',
        'contact_messages.php' => 'devotees.edit',
        // Notification pages make finer checks per action (approve, emergency
        // send) on top of these, and the service re-checks the actor's role.
        'notifications.php'          => 'notifications.compose',
        'notification_segments.php'  => 'notifications.compose',
        'notification_templates.php' => 'notifications.templates',
        'notification_analytics.php' => 'notifications.compose', // requeue
        // The refund actions on payments.php additionally require payments.refund.
        'payments.php'               => 'payments.manage',
        'payment_settings.php'       => 'payments.settings',
        'donation_categories.php'    => 'finance.edit',
        // The status buttons on live_streams.php additionally require live.publish.
        'live_streams.php'           => 'live.manage',
        'live_settings.php'          => 'live.provider',
    ];
    if (isset($explicit[$file])) return $explicit[$file];
    $read = adminPageCapability($file);
    // Readable-by-all pages still need an editor to change anything.
    return $read === 'view' ? 'devotees.edit' : $read;
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

/** True once the accounts table exists (cached per request). */
function adminUsersTableExists(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    if (!function_exists('getDB')) {
        $db = __DIR__ . '/db.php';
        if (!file_exists($db)) return $exists = false;
        require_once $db;
    }
    try {
        getDB()->query('SELECT 1 FROM admin_users LIMIT 1');
        return $exists = true;
    } catch (Throwable) {
        return $exists = false;
    }
}

/** Record an auditable admin action. Never throws — logging must not break a flow. */
function adminAudit(string $action, ?string $subject = null, ?string $detail = null, ?string $actor = null): void
{
    try {
        if (!adminUsersTableExists()) return;
        $stmt = getDB()->prepare(
            'INSERT INTO admin_activity (actor, action, subject, detail, ip) VALUES (:a,:ac,:s,:d,:ip)'
        );
        $stmt->execute([
            ':a'  => $actor ?? (string) ($_SESSION['admin_user'] ?? 'anonymous'),
            ':ac' => $action,
            ':s'  => $subject,
            ':d'  => $detail !== null ? mb_substr($detail, 0, 500) : null,
            ':ip' => $_SERVER['REMOTE_ADDR'] ?? null,
        ]);
    } catch (Throwable) {
        // auditing is best-effort
    }
}

/**
 * Verify credentials. Checks database accounts first, then falls back to the
 * environment admin. Returns the signed-in user array or null.
 */
function adminLogin(string $username, string $password): ?array
{
    if (adminAccountLockedFor($username) > 0) {
        adminAudit('login_failed', $username, 'account locked', $username);
        return null;
    }
    $user = adminVerifyCredentials($username, $password);
    if ($user === null) {
        adminRecordFailedLogin($username);
        return null;
    }
    adminClearFailedLogins($username);
    return $user;
}

/**
 * Seconds remaining on an account lock, or 0. Lockout is per account name so
 * a guessing run against one login cannot be dodged by changing IP, and it
 * cannot lock out other committee members; the per-IP throttle in login.php
 * still applies on top. Counted in `rate_limits`, so the environment admin is
 * covered too and nothing is needed in `admin_users`.
 */
function adminAccountLockedFor(string $username): int
{
    require_once __DIR__ . '/rate_limit.php';
    if (!rateLimitTableExists()) return 0;
    try {
        $stmt = getDB()->prepare(
            'SELECT hits, TIMESTAMPDIFF(SECOND, NOW(), window_start + INTERVAL ' . ADMIN_LOCKOUT_MINUTES . ' MINUTE) AS remaining
               FROM rate_limits WHERE bucket = :b'
        );
        $stmt->execute([':b' => adminLockBucket($username)]);
        $row = $stmt->fetch();
        if (!$row || (int) $row['hits'] < ADMIN_LOCKOUT_ATTEMPTS) return 0;
        return max(0, (int) $row['remaining']);
    } catch (Throwable $e) {
        error_log('[auth] lockout check: ' . $e->getMessage());
        return 0;
    }
}

function adminLockBucket(string $username): string
{
    return mb_substr('admin-login:' . mb_strtolower(trim($username)), 0, 190);
}

function adminRecordFailedLogin(string $username): void
{
    require_once __DIR__ . '/rate_limit.php';
    // The window is the lockout period: the counter resets once it has passed.
    $allowed = rateLimitAllow('admin-login', ADMIN_LOCKOUT_ATTEMPTS - 1, ADMIN_LOCKOUT_MINUTES * 60, mb_strtolower(trim($username)));
    if (!$allowed) adminAudit('account_locked', $username, ADMIN_LOCKOUT_ATTEMPTS . ' failed sign-ins', $username);
}

function adminClearFailedLogins(string $username): void
{
    require_once __DIR__ . '/rate_limit.php';
    if (!rateLimitTableExists()) return;
    try {
        getDB()->prepare('DELETE FROM rate_limits WHERE bucket = :b')->execute([':b' => adminLockBucket($username)]);
    } catch (Throwable) {
        // best-effort
    }
}

/** Check a username/password pair without touching the lockout counters. */
function adminVerifyCredentials(string $username, string $password): ?array
{
    // 1. Database account
    if (adminUsersTableExists()) {
        try {
            $stmt = getDB()->prepare('SELECT * FROM admin_users WHERE username = :u LIMIT 1');
            $stmt->execute([':u' => $username]);
            $row = $stmt->fetch();
            if ($row) {
                if (!$row['is_active']) {
                    adminAudit('login_failed', $username, 'account disabled', $username);
                    return null;
                }
                if (password_verify($password, $row['pass_hash'])) {
                    // Transparently upgrade legacy hashes
                    if (password_needs_rehash($row['pass_hash'], PASSWORD_BCRYPT)) {
                        $up = getDB()->prepare('UPDATE admin_users SET pass_hash = :h WHERE id = :id');
                        $up->execute([':h' => password_hash($password, PASSWORD_BCRYPT), ':id' => $row['id']]);
                    }
                    getDB()->prepare('UPDATE admin_users SET last_login_at = NOW() WHERE id = :id')
                           ->execute([':id' => $row['id']]);
                    return [
                        'id'           => (int) $row['id'],
                        'username'     => $row['username'],
                        'display_name' => $row['display_name'],
                        'email'        => $row['email'],
                        'role'         => adminNormalizeRole($row['role']),
                        'must_change'  => (bool) $row['must_change'],
                        'is_env'       => false,
                    ];
                }
                adminAudit('login_failed', $username, 'wrong password', $username);
                return null;
            }
        } catch (Throwable) {
            // fall through to the environment admin
        }
    }

    // 2. Environment admin (bootstrap / recovery)
    $storedHash = readEnv('ADMIN_PASS_HASH');
    $storedUser = readEnv('ADMIN_USERNAME', 'admin');
    if ($storedHash !== '' && hash_equals($storedUser, $username) && password_verify($password, $storedHash)) {
        return [
            'id'           => 0,
            'username'     => $storedUser,
            'display_name' => $storedUser,
            'email'        => null,
            'role'         => 'owner',
            'must_change'  => false,
            'is_env'       => true,
        ];
    }
    adminAudit('login_failed', $username, 'no such account', $username);
    return null;
}

/** Persist a successful sign-in into the session. */
function adminStartSession(array $user): void
{
    session_regenerate_id(true);
    $_SESSION['admin_logged_in'] = true;
    $_SESSION['admin_user']      = $user['username'];
    $_SESSION['admin_user_id']   = $user['id'];
    $_SESSION['admin_name']      = $user['display_name'];
    $_SESSION['admin_email']     = $user['email'];
    $_SESSION['admin_role']      = $user['role'];
    $_SESSION['admin_is_env']    = $user['is_env'];
    $_SESSION['admin_must_change'] = $user['must_change'];
    $_SESSION['admin_login_at']  = time();
    $_SESSION['admin_last_seen'] = time();
    adminAudit('login', $user['username'], $user['is_env'] ? 'environment account' : 'database account');
}

/** The signed-in user, or null. */
function currentAdmin(): ?array
{
    if (empty($_SESSION['admin_logged_in'])) return null;
    return [
        'id'           => (int) ($_SESSION['admin_user_id'] ?? 0),
        'username'     => (string) ($_SESSION['admin_user'] ?? 'admin'),
        'display_name' => (string) ($_SESSION['admin_name'] ?? $_SESSION['admin_user'] ?? 'admin'),
        'email'        => $_SESSION['admin_email'] ?? null,
        'role'         => (string) ($_SESSION['admin_role'] ?? 'owner'),
        'is_env'       => (bool) ($_SESSION['admin_is_env'] ?? true),
        'must_change'  => (bool) ($_SESSION['admin_must_change'] ?? false),
    ];
}

function adminRole(): string
{
    return currentAdmin()['role'] ?? 'owner';
}

/** Does the signed-in user hold this capability? */
function adminCan(string $capability): bool
{
    return adminRoleCan(adminRole(), $capability);
}

/**
 * Idle expiry: a session untouched for ADMIN_IDLE_MINUTES is ended. Called by
 * adminRevalidateSession(), so pages and the JSON endpoints share one clock.
 * Returns false after signing the user out.
 */
function adminSessionStillFresh(): bool
{
    if (empty($_SESSION['admin_logged_in'])) return false;
    $last = (int) ($_SESSION['admin_last_seen'] ?? $_SESSION['admin_login_at'] ?? 0);
    if ($last > 0 && time() - $last > adminIdleMinutes() * 60) {
        adminAudit('session_expired', null, 'idle for more than ' . adminIdleMinutes() . ' minutes');
        adminLogout();
        return false;
    }
    $_SESSION['admin_last_seen'] = time();
    return true;
}

/**
 * Authenticate, then enforce this page's role policy. Every admin page calls
 * this as its first statement, before any POST handling, so permission is
 * checked before anything can be written. A page cannot forget to opt in:
 * the policy lives in adminPageCapability() / adminPageWriteCapability().
 */
function requireAdminAuth(): void
{
    if (empty($_SESSION['admin_logged_in'])) {
        $to = rawurlencode($_SERVER['REQUEST_URI'] ?? '/admin/');
        header('Location: /admin/login.php?reason=expired&next=' . $to);
        exit;
    }
    if (!adminRevalidateSession()) {
        $to = rawurlencode($_SERVER['REQUEST_URI'] ?? '/admin/');
        header('Location: /admin/login.php?reason=' . (empty($_SESSION['admin_expired_idle']) ? 'revoked' : 'expired') . '&next=' . $to);
        exit;
    }
    $file = basename($_SERVER['PHP_SELF']);

    // A forced password change blocks everything except the profile page itself.
    if (!empty($_SESSION['admin_must_change']) && $file !== 'profile.php') {
        header('Location: /admin/profile.php?must_change=1');
        exit;
    }

    // Reading the page
    $needed = adminPageCapability($file);
    if (!adminCan($needed)) adminDeny($needed);

    // Changing anything on it
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
        $write = adminPageWriteCapability($file);
        if (!adminCan($write)) adminDeny($write, true);
    }
}

/**
 * Re-check a database account against admin_users on every request so that
 * disabling, deleting or re-roling a committee member takes effect on their
 * existing sessions, not only at their next sign-in. Returns false after
 * clearing the session when the account is gone or disabled; the caller
 * chooses the response (a redirect for pages, JSON for the AJAX endpoints).
 * Otherwise refreshes the session's role and must_change from the row.
 */
function adminRevalidateSession(): bool
{
    if (empty($_SESSION['admin_logged_in'])) return false;
    if (!adminSessionStillFresh()) {
        $_SESSION['admin_expired_idle'] = true;
        return false;
    }
    if (!empty($_SESSION['admin_is_env']) || (int) ($_SESSION['admin_user_id'] ?? 0) < 1) return true;
    if (!adminUsersTableExists()) return true;
    try {
        $stmt = getDB()->prepare('SELECT is_active, role, must_change FROM admin_users WHERE id = :id LIMIT 1');
        $stmt->execute([':id' => (int) $_SESSION['admin_user_id']]);
        $row = $stmt->fetch();
    } catch (Throwable) {
        return true;
    }
    if (!$row || !$row['is_active']) {
        adminAudit('session_revoked', null, $row ? 'account disabled' : 'account deleted');
        adminLogout();
        return false;
    }
    $_SESSION['admin_role']        = adminNormalizeRole($row['role']);
    $_SESSION['admin_must_change'] = (bool) $row['must_change'];
    return true;
}

/** Explicit per-block gate, for pages that mix capabilities. */
function requireAdminCan(string $capability): void
{
    if (!adminCan($capability)) adminDeny($capability);
}

/**
 * Render a self-contained, styled 403 and stop. Self-contained because this
 * can fire before admin_layout.php has been required.
 */
function adminDeny(string $capability, bool $wasWrite = false): void
{
    http_response_code(403);
    $role = htmlspecialchars(adminRoleLabel(adminRole()), ENT_QUOTES, 'UTF-8');
    $what = htmlspecialchars(str_replace(['.', '_'], [' ', ' '], $capability), ENT_QUOTES, 'UTF-8');
    $verb = $wasWrite ? 'make changes here' : 'open this page';
    header('Content-Type: text/html; charset=utf-8');
    echo <<<HTML
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" /><title>Not permitted — Temple Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="stylesheet" href="/admin/assets/ds/tokens.css" />
<link rel="stylesheet" href="/admin/assets/ds/base.css" />
<link rel="stylesheet" href="/admin/assets/ds/layout.css" />
<link rel="stylesheet" href="/admin/assets/ds/components.css" />
<link rel="stylesheet" href="/admin/assets/ds/utilities.css" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head><body style="display:block">
<main class="container container--narrow section">
  <div class="empty-state" role="alert">
    <span class="empty-state__icon" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
    </span>
    <h1 class="empty-state__title">You do not have access</h1>
    <p>Your account has the <strong>{$role}</strong> role, so you cannot {$verb}. This page needs the
       <strong>{$what}</strong> permission.</p>
    <p>Ask a committee owner to change your role if you need it.</p>
    <div class="empty-state__actions">
      <a class="btn btn-primary" href="/admin/">Back to dashboard</a>
      <a class="btn btn-outline" href="/admin/profile.php">My profile</a>
    </div>
  </div>
</main>
</body></html>
HTML;
    exit;
}

function adminLogout(): void
{
    adminAudit('logout');
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
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
    return '<input type="hidden" name="_csrf" value="' . htmlspecialchars(csrfToken(), ENT_QUOTES, 'UTF-8') . '" />';
}

function csrfValid(): bool
{
    $sent = (string) ($_POST['_csrf'] ?? '');
    return $sent !== '' && hash_equals(csrfToken(), $sent);
}

/** Admin passwords use the one site-wide policy in includes/helpers.php. */
function adminPasswordProblem(string $password, string $username = ''): string
{
    require_once __DIR__ . '/helpers.php';
    return passwordProblem($password, $username);
}
