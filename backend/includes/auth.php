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
// Roles, least to most: viewer → editor → owner.
//   viewer  read-only: dashboard, lists, reports, CSV exports
//   editor  everything a viewer can do plus create/update/delete content,
//           bookings, donations and bulk imports
//   owner   everything, plus managing accounts and system settings
//
// If the `admin_users` table has not been created yet the site behaves
// exactly as it did before: env admin only, full access.

session_start();

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

const ADMIN_ROLES = ['viewer', 'editor', 'owner'];

/** Capability → minimum role. Anything unlisted requires `owner`. */
const ADMIN_CAPABILITIES = [
    'view'          => 'viewer',   // read dashboards, lists, reports
    'export'        => 'viewer',   // download CSV
    'content.edit'  => 'editor',   // sevas, events, announcements, poojas, sponsors, gallery, widgets
    'devotees.edit' => 'editor',   // booking status, delete messages
    'import'        => 'editor',   // bulk upload
    'settings.edit' => 'owner',    // homepage settings
    'users.manage'  => 'owner',    // committee accounts
];

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
        'poojas.php'           => 'content.edit',
        'sevas.php'            => 'content.edit',
        'events.php'           => 'content.edit',
        'sponsors.php'         => 'content.edit',
        'bulk_upload.php'      => 'import',
        'settings.php'         => 'settings.edit',
        'users.php'            => 'users.manage',
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
        'donations.php'        => 'devotees.edit',
        'contact_messages.php' => 'devotees.edit',
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
                        'role'         => $row['role'],
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
    $needed = ADMIN_CAPABILITIES[$capability] ?? 'owner';
    $have   = array_search(adminRole(), ADMIN_ROLES, true);
    $want   = array_search($needed, ADMIN_ROLES, true);
    return $have !== false && $want !== false && $have >= $want;
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
    $role = htmlspecialchars(ucfirst(adminRole()), ENT_QUOTES, 'UTF-8');
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

/**
 * Shared password policy. Returns an error string, or '' when acceptable.
 * Deliberately simple and explainable to a committee member.
 */
function adminPasswordProblem(string $password, string $username = ''): string
{
    if (mb_strlen($password) < 10)            return 'Use at least 10 characters.';
    if (!preg_match('/[a-z]/', $password))    return 'Include at least one lowercase letter.';
    if (!preg_match('/[A-Z]/', $password))    return 'Include at least one uppercase letter.';
    if (!preg_match('/\d/', $password))       return 'Include at least one number.';
    if ($username !== '' && stripos($password, $username) !== false) return 'Do not put your username in the password.';
    $common = ['password', 'temple', '12345678', 'qwerty', 'admin123', 'letmein'];
    foreach ($common as $bad) {
        if (stripos($password, $bad) !== false) return 'That password is too easy to guess.';
    }
    return '';
}
