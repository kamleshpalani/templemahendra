<?php
/**
 * backend/includes/devotee_auth.php — accounts for devotees (the public site).
 *
 * Separate from the admin entirely: different table, different session keys,
 * different rules. A devotee can never reach the admin and an admin session
 * grants nothing here. Both may coexist in one browser.
 *
 * Deliberate choices worth knowing:
 *   • Enumeration. Register, forgot-password and resend always answer the same
 *     way whether or not the address is known, so the endpoints cannot be used
 *     to discover who has an account.
 *   • Tokens. Only sha256(token) is stored, tokens are single-use and expiring,
 *     and issuing a new one of a kind retires the outstanding ones.
 *   • History. A devotee sees records carrying their account id. Nothing is
 *     matched on a phone number, which here proves nothing.
 *   • CSRF. Session cookies plus a double-submit token on every state change.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/mailer.php';

const DEVOTEE_SESSION_KEY = 'devotee_id';
const VERIFY_TTL_HOURS    = 48;
const RESET_TTL_MINUTES   = 60;

/** Start the session once, with cookie flags that suit a public site. */
function devoteeSessionStart(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    session_set_cookie_params([
        'lifetime' => 0,
        'path'     => '/',
        'httponly' => true,
        'secure'   => $https,
        'samesite' => 'Lax',
    ]);
    session_start();
}

/** True when the devotee tables have been migrated in. */
function devoteeTablesExist(): bool
{
    static $exists = null;
    if ($exists !== null) return $exists;
    try {
        getDB()->query('SELECT 1 FROM devotees LIMIT 1');
        return $exists = true;
    } catch (Throwable) {
        return $exists = false;
    }
}

function devoteeRequireTables(): void
{
    if (!devoteeTablesExist()) {
        sendJson([
            'error' => 'Devotee accounts are not enabled on this site yet.',
            'code'  => 'accounts_disabled',
        ], 503);
    }
}

/* ── CSRF ───────────────────────────────────────────────────────────────── */

function devoteeCsrfToken(): string
{
    devoteeSessionStart();
    if (empty($_SESSION['pub_csrf'])) {
        $_SESSION['pub_csrf'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['pub_csrf'];
}

/** Every state-changing public endpoint calls this first. */
function devoteeRequireCsrf(): void
{
    devoteeSessionStart();
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['_csrf'] ?? '');
    $have = $_SESSION['pub_csrf'] ?? '';
    if ($have === '' || !is_string($sent) || $sent === '' || !hash_equals($have, $sent)) {
        sendJson(['error' => 'Your session expired. Reload the page and try again.', 'code' => 'csrf'], 419);
    }
}

/* ── Rate limiting ──────────────────────────────────────────────────────── */

function clientIp(): string
{
    foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
        if (!empty($_SERVER[$k])) {
            $v = explode(',', (string) $_SERVER[$k])[0];
            return trim($v);
        }
    }
    return 'unknown';
}

/**
 * Returns true when the caller may proceed. Counts per action+IP in a fixed
 * window; the window resets rather than sliding, which is plenty here and
 * costs one statement.
 */
function rateLimitAllow(string $action, int $max, int $windowSeconds, ?string $who = null): bool
{
    if (!devoteeTablesExist()) return true;
    $bucket = mb_substr($action . ':' . ($who ?? clientIp()), 0, 190);
    $w      = max(1, $windowSeconds);
    try {
        $db = getDB();
        $db->prepare(
            "INSERT INTO rate_limits (bucket, hits, window_start) VALUES (:b, 1, NOW())
             ON DUPLICATE KEY UPDATE
               hits         = IF(window_start < (NOW() - INTERVAL $w SECOND), 1, hits + 1),
               window_start = IF(window_start < (NOW() - INTERVAL $w SECOND), NOW(), window_start)"
        )->execute([':b' => $bucket]);
        $stmt = $db->prepare('SELECT hits FROM rate_limits WHERE bucket = :b');
        $stmt->execute([':b' => $bucket]);
        $hits = (int) $stmt->fetchColumn();
        // opportunistic cleanup, roughly one request in fifty
        if (random_int(1, 50) === 1) {
            $db->exec('DELETE FROM rate_limits WHERE window_start < (NOW() - INTERVAL 1 DAY)');
        }
        return $hits <= $max;
    } catch (Throwable $e) {
        error_log('[rate-limit] ' . $e->getMessage());
        return true; // never lock people out because the limiter broke
    }
}

function rateLimitOrFail(string $action, int $max, int $windowSeconds, string $message): void
{
    if (!rateLimitAllow($action, $max, $windowSeconds)) {
        sendJson(['error' => $message, 'code' => 'rate_limited'], 429);
    }
}

/* ── Session ────────────────────────────────────────────────────────────── */

function devoteeLogIn(array $row): void
{
    devoteeSessionStart();
    session_regenerate_id(true);
    $_SESSION[DEVOTEE_SESSION_KEY] = (int) $row['id'];
    $_SESSION['devotee_since']     = time();
    try {
        getDB()->prepare('UPDATE devotees SET last_login_at = NOW() WHERE id = :id')
               ->execute([':id' => (int) $row['id']]);
    } catch (Throwable) {
    }
}

function devoteeLogOut(): void
{
    devoteeSessionStart();
    unset($_SESSION[DEVOTEE_SESSION_KEY], $_SESSION['devotee_since']);
    // Admin sessions share the cookie, so only clear the whole session when
    // nothing else is using it.
    if (empty($_SESSION['admin_logged_in'])) {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
        }
        session_destroy();
    }
}

/** The signed-in devotee's row, or null. */
function currentDevotee(): ?array
{
    devoteeSessionStart();
    $id = (int) ($_SESSION[DEVOTEE_SESSION_KEY] ?? 0);
    if ($id <= 0 || !devoteeTablesExist()) return null;
    static $cache = null;
    if ($cache !== null && (int) $cache['id'] === $id) return $cache;
    try {
        $stmt = getDB()->prepare('SELECT * FROM devotees WHERE id = :id AND is_active = 1');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        if (!$row) { unset($_SESSION[DEVOTEE_SESSION_KEY]); return null; }
        return $cache = $row;
    } catch (Throwable) {
        return null;
    }
}

function devoteeRequireAuth(): array
{
    $me = currentDevotee();
    if (!$me) {
        sendJson(['error' => 'Please sign in to continue.', 'code' => 'unauthenticated'], 401);
    }
    return $me;
}

/** The shape the frontend receives. Never includes the password hash. */
function devoteePublic(array $row): array
{
    return [
        'id'        => (int) $row['id'],
        'name'      => $row['name'],
        'email'     => $row['email'],
        'phone'     => $row['phone'],
        'verified'  => $row['email_verified_at'] !== null,
        'createdAt' => $row['created_at'],
    ];
}

/**
 * The signed-in devotee's id, but only if the given table can actually store
 * it — migration 003 adds the column, and the public forms must keep working
 * on a database where it has not been applied yet. Returns null for a guest.
 */
function devoteeLinkId(string $table): ?int
{
    static $hasColumn = [];
    // A guest arrives with no session cookie. Don't start a session (and set a
    // cookie) just to discover that — an anonymous booking stays anonymous.
    if (session_status() !== PHP_SESSION_ACTIVE && !isset($_COOKIE[session_name()])) {
        return null;
    }
    $me = currentDevotee();
    if (!$me) return null;
    if (!isset($hasColumn[$table])) {
        try {
            // Table name is ours, never user input; still constrained here.
            if (!preg_match('/^[a-z_]+$/', $table)) return null;
            $stmt = getDB()->query("SHOW COLUMNS FROM `$table` LIKE 'devotee_id'");
            $hasColumn[$table] = (bool) $stmt->fetch();
        } catch (Throwable) {
            $hasColumn[$table] = false;
        }
    }
    return $hasColumn[$table] ? (int) $me['id'] : null;
}

/* ── Tokens ─────────────────────────────────────────────────────────────── */

/**
 * Issue a single-use token, retiring any outstanding one of the same kind.
 * Returns the raw token — the only time it exists outside the recipient's inbox.
 */
function devoteeIssueToken(int $devoteeId, string $kind): string
{
    $db = getDB();
    $db->prepare('UPDATE devotee_tokens SET used_at = NOW() WHERE devotee_id = :d AND kind = :k AND used_at IS NULL')
       ->execute([':d' => $devoteeId, ':k' => $kind]);
    $raw     = bin2hex(random_bytes(32));
    $minutes = $kind === 'verify' ? VERIFY_TTL_HOURS * 60 : RESET_TTL_MINUTES;
    $db->prepare(
        'INSERT INTO devotee_tokens (devotee_id, kind, token_hash, expires_at)
         VALUES (:d, :k, :h, DATE_ADD(NOW(), INTERVAL ' . (int) $minutes . ' MINUTE))'
    )->execute([':d' => $devoteeId, ':k' => $kind, ':h' => hash('sha256', $raw)]);
    return $raw;
}

/** Consume a token. Returns the devotee row, or null when it is not usable. */
function devoteeConsumeToken(string $raw, string $kind): ?array
{
    if (!preg_match('/^[a-f0-9]{64}$/', $raw)) return null;
    $db   = getDB();
    $stmt = $db->prepare(
        'SELECT t.id AS token_id, d.*
           FROM devotee_tokens t
           JOIN devotees d ON d.id = t.devotee_id
          WHERE t.token_hash = :h AND t.kind = :k
            AND t.used_at IS NULL AND t.expires_at > NOW()
            AND d.is_active = 1
          LIMIT 1'
    );
    $stmt->execute([':h' => hash('sha256', $raw), ':k' => $kind]);
    $row = $stmt->fetch();
    if (!$row) return null;
    $db->prepare('UPDATE devotee_tokens SET used_at = NOW() WHERE id = :id')
       ->execute([':id' => (int) $row['token_id']]);
    return $row;
}

/* ── Emails ─────────────────────────────────────────────────────────────── */

function devoteeSendVerification(array $devotee): array
{
    $raw  = devoteeIssueToken((int) $devotee['id'], 'verify');
    $link = siteUrl('/verify-email?token=' . $raw);
    $name = htmlspecialchars($devotee['name'], ENT_QUOTES, 'UTF-8');
    $html = mailTemplate(
        'வணக்கம்',
        'Confirm your email address',
        "<p style=\"margin:0 0 14px\">Vanakkam {$name},</p>"
        . '<p style="margin:0 0 14px">Thank you for creating an account with the temple. '
        . 'Confirm this address so we can send you booking confirmations and receipts.</p>',
        'Confirm my email',
        $link,
        'This link works for ' . VERIFY_TTL_HOURS . ' hours. If you did not create an account, ignore this message and nothing will happen.'
    );
    $text = "Vanakkam {$devotee['name']},\n\nConfirm your email address for the temple website:\n$link\n\n"
        . 'This link works for ' . VERIFY_TTL_HOURS . " hours.\nIf you did not create an account, ignore this message.";
    return sendMail($devotee['email'], 'Confirm your email — Temple', $html, $text, 'verify');
}

function devoteeSendReset(array $devotee): array
{
    $raw  = devoteeIssueToken((int) $devotee['id'], 'reset');
    $link = siteUrl('/reset-password?token=' . $raw);
    $name = htmlspecialchars($devotee['name'], ENT_QUOTES, 'UTF-8');
    $html = mailTemplate(
        'கடவுச்சொல் மீட்பு',
        'Set a new password',
        "<p style=\"margin:0 0 14px\">Vanakkam {$name},</p>"
        . '<p style="margin:0 0 14px">Someone asked to reset the password for this account. '
        . 'If that was you, choose a new one now.</p>',
        'Set a new password',
        $link,
        'This link works for ' . RESET_TTL_MINUTES . ' minutes and can be used once. If it was not you, your password has not changed and you can ignore this.'
    );
    $text = "Vanakkam {$devotee['name']},\n\nSet a new password for the temple website:\n$link\n\n"
        . 'This link works for ' . RESET_TTL_MINUTES . " minutes and can be used once.\nIf it was not you, your password has not changed.";
    return sendMail($devotee['email'], 'Set a new password — Temple', $html, $text, 'reset');
}

/**
 * Sent when someone registers with an address that already has an account.
 * The registration endpoint answers identically either way, so this is what
 * tells the real owner something happened.
 */
function devoteeSendAlreadyRegistered(array $devotee): array
{
    $html = mailTemplate(
        'உங்கள் கணக்கு',
        'You already have an account',
        '<p style="margin:0 0 14px">Someone just tried to create an account with this email address, '
        . 'but one already exists. No new account was made and nothing has changed.</p>'
        . '<p style="margin:0 0 14px">If that was you, sign in instead — or reset your password if you have forgotten it.</p>',
        'Go to sign in',
        siteUrl('/login'),
        'If this was not you, you can safely ignore this message.'
    );
    $text = "Someone tried to create an account with this email address, but one already exists.\n\n"
        . 'Sign in: ' . siteUrl('/login') . "\nForgot your password: " . siteUrl('/forgot-password');
    return sendMail($devotee['email'], 'You already have an account — Temple', $html, $text, 'already_registered');
}

function devoteeSendWelcome(array $devotee): array
{
    $name = htmlspecialchars($devotee['name'], ENT_QUOTES, 'UTF-8');
    $html = mailTemplate(
        'நன்றி',
        'Your email is confirmed',
        "<p style=\"margin:0 0 14px\">Vanakkam {$name},</p>"
        . '<p style="margin:0 0 14px">Your email address is confirmed. You can now book a seva in a couple of taps, '
        . 'and see everything you have booked or given in one place.</p>',
        'Open my account',
        siteUrl('/account'),
        null
    );
    $text = "Vanakkam {$devotee['name']},\n\nYour email address is confirmed.\n\nYour account: " . siteUrl('/account');
    return sendMail($devotee['email'], 'Your email is confirmed — Temple', $html, $text, 'welcome');
}
