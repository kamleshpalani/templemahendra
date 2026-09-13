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

/**
 * The caller's address, for rate limiting.
 *
 * REMOTE_ADDR is the only value a client cannot choose, so it is the default.
 * X-Forwarded-For and CF-Connecting-IP are request headers: anyone can send
 * them, and trusting them unconditionally meant every per-IP limit could be
 * stepped around by changing one header on each attempt — which is to say
 * there was no per-IP limit at all.
 *
 * Behind a real proxy the forwarded header is the only way to see the visitor,
 * so it is honoured when the connection itself arrives from an address listed
 * in TRUSTED_PROXIES (comma-separated, CIDR or plain addresses). On Hostinger
 * there is no such proxy and the variable stays unset, which is correct.
 */
function clientIp(): string
{
    $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '');

    $trusted = array_filter(array_map('trim', explode(',', (string) (getenv('TRUSTED_PROXIES') ?: ''))));
    if ($remote !== '' && $trusted && ipInAnyRange($remote, $trusted)) {
        foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR'] as $k) {
            if (empty($_SERVER[$k])) continue;
            // Left-most entry is the original client; the rest is the proxy chain.
            $candidate = trim(explode(',', (string) $_SERVER[$k])[0]);
            if (filter_var($candidate, FILTER_VALIDATE_IP)) return $candidate;
        }
    }

    return $remote !== '' ? $remote : 'unknown';
}

/** True when $ip falls inside any of the given addresses or CIDR ranges. */
function ipInAnyRange(string $ip, array $ranges): bool
{
    $packed = @inet_pton($ip);
    if ($packed === false) return false;

    foreach ($ranges as $range) {
        if (!str_contains($range, '/')) {
            if ($range === $ip) return true;
            continue;
        }
        [$subnet, $bitsRaw] = explode('/', $range, 2);
        $subnetPacked = @inet_pton($subnet);
        $bits = (int) $bitsRaw;
        if ($subnetPacked === false || strlen($subnetPacked) !== strlen($packed) || $bits < 0) continue;
        if ($bits > strlen($packed) * 8) continue;

        $whole = intdiv($bits, 8);
        $rest  = $bits % 8;
        if ($whole > 0 && strncmp($packed, $subnetPacked, $whole) !== 0) continue;
        if ($rest === 0) return true;

        $mask = chr(0xFF << (8 - $rest) & 0xFF);
        if ((($packed[$whole] ?? "\0") & $mask) === (($subnetPacked[$whole] ?? "\0") & $mask)) return true;
    }
    return false;
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

/**
 * Read a bucket without spending from it.
 *
 * Sign-in uses this so only *failed* attempts count: incrementing on every
 * attempt meant a devotee who signed in normally six times was then locked out
 * of their own account.
 */
function rateLimitPeek(string $action, int $max, int $windowSeconds, ?string $who = null): bool
{
    if (!devoteeTablesExist()) return true;
    $bucket = mb_substr($action . ':' . ($who ?? clientIp()), 0, 190);
    try {
        $stmt = getDB()->prepare(
            'SELECT hits FROM rate_limits WHERE bucket = :b AND window_start >= (NOW() - INTERVAL ' . max(1, $windowSeconds) . ' SECOND)'
        );
        $stmt->execute([':b' => $bucket]);
        $hits = $stmt->fetchColumn();
        return $hits === false || (int) $hits < $max;
    } catch (Throwable $e) {
        error_log('[rate-limit peek] ' . $e->getMessage());
        return true;
    }
}

/** Forget a bucket entirely — used after a successful sign-in. */
function rateLimitClear(string $action, ?string $who = null): void
{
    if (!devoteeTablesExist()) return;
    try {
        getDB()->prepare('DELETE FROM rate_limits WHERE bucket = :b')
               ->execute([':b' => mb_substr($action . ':' . ($who ?? clientIp()), 0, 190)]);
    } catch (Throwable) {
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
        // Which country the number belongs to, because E.164 cannot always say:
        // +1 covers the United States, Canada and much of the Caribbean. Rows
        // written before migration 004 have none, and those were all Indian.
        'phoneCountry' => $row['phone_country'] ?? null,
        // The postal address, for receipts. Absent before migration 006.
        'address1'  => $row['address1'] ?? null,
        'address2'  => $row['address2'] ?? null,
        'country'   => $row['country'] ?? null,
        'state'     => $row['state'] ?? null,
        'city'      => $row['city'] ?? null,
        'postcode'  => $row['postcode'] ?? null,
        'verified'  => $row['email_verified_at'] !== null,
        // Set once a one-time code sent to the number is typed back (migration
        // 007). Saving a different number clears it, so it always describes the
        // number shown above rather than one the devotee used to have.
        'phoneVerified' => !empty($row['phone_verified_at'] ?? null),
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

/* ── Notifications ──────────────────────────────────────────────────────── */

/**
 * True when the Notification Service can be used: its code loads and migration
 * 007 has been applied. Loaded lazily, because most requests that include this
 * file (a search, a sign-in) never notify anyone.
 *
 * When this is false every function below takes the path the site used before
 * notifications existed, so an install that has not run 007 keeps working.
 */
function devoteeNotifyReady(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;
    try {
        require_once __DIR__ . '/notify.php';
        return $ready = notifyTablesExist();
    } catch (Throwable $e) {
        error_log('[notify] the notification service could not be loaded: ' . $e->getMessage());
        return $ready = false;
    }
}

/**
 * notifyEvent(), or null when the service is not available. Never throws: a
 * notification is never a reason for a sign-up, booking or donation to fail.
 */
function devoteeNotifyEvent(string $event, array $ctx): ?array
{
    if (!devoteeNotifyReady()) return null;
    try {
        return notifyEvent($event, $ctx);
    } catch (Throwable $e) {
        error_log("[notify] {$event} failed: " . $e->getMessage());
        return null;
    }
}

/**
 * The sendMail()-shaped answer ['ok','status','error'] for a notification's
 * email delivery, so the endpoints can keep telling the truth on screen
 * ("emailDelivery": sent | unavailable) exactly as before.
 *
 *   sent by a real transport        → ok true,  status sent
 *   sent but only written to a log  → ok false, status logged
 *   waiting for the worker          → ok true,  status queued
 *   skipped, failed, dead, rejected → ok false, status failed
 *
 * Returns null when no notification was created at all (the service errored),
 * which tells the caller to fall back to the mailer so the devotee still gets
 * their link.
 */
function devoteeMailFromNotify(?array $result): ?array
{
    if ($result === null || ($result['id'] === null && empty($result['deduped']))) return null;
    $d = $result['deliveries']['email'] ?? null;
    if ($d === null) return ['ok' => false, 'status' => 'failed', 'error' => 'No email was attempted.'];
    $status = (string) $d['status'];
    if (in_array($status, ['sent', 'delivered', 'read'], true)) {
        return !empty($d['recordedOnly'])
            ? ['ok' => false, 'status' => 'logged', 'error' => 'Email is not configured on this server.']
            : ['ok' => true, 'status' => 'sent', 'error' => ''];
    }
    if (in_array($status, ['queued', 'sending'], true)) {
        return ['ok' => true, 'status' => 'queued', 'error' => ''];
    }
    return ['ok' => false, 'status' => 'failed', 'error' => (string) ($d['reason'] ?? 'The email could not be sent.')];
}

/** The language a devotee reads notifications in ('ta' until they choose). */
function devoteeNotifyLang(int $devoteeId): string
{
    if ($devoteeId < 1 || !devoteeNotifyReady()) return 'ta';
    try {
        return (string) (notifyPrefs($devoteeId)['lang'] ?? 'ta');
    } catch (Throwable) {
        return 'ta';
    }
}

/** 'ta' or 'en' — the two languages the site's own wording (dates, labels) exists in. */
function devoteeCopyLang(string $lang): string
{
    return $lang === 'ta' ? 'ta' : 'en';
}

/** "13 செப்டம்பர் 2026, மாலை 4:05 IST" / "13 Sep 2026, 4:05 pm IST" — now, on the temple's clock. */
function devoteeNowLabel(string $lang): string
{
    $l     = devoteeCopyLang($lang);
    $tz    = notifyTempleTz();
    $local = notifyFromUtc(notifyNow(), $tz);
    return notifyFormatDate(substr($local, 0, 10), $l) . ', ' . notifyFormatClock(substr($local, 11, 5), $l)
        . ' ' . ($tz === 'Asia/Kolkata' ? 'IST' : $tz);
}

/**
 * The booking number devotees and the office both quote: "B-000091". Padded so
 * it reads as a reference rather than a count, and sorts correctly in a list.
 */
function devoteeBookingNumber(int $bookingId): string
{
    return 'B-' . str_pad((string) $bookingId, 6, '0', STR_PAD_LEFT);
}

/** The donation reference printed on acknowledgements and receipts: "D-000012". */
function devoteeReceiptNumber(int $donationId): string
{
    return 'D-' . str_pad((string) $donationId, 6, '0', STR_PAD_LEFT);
}

/**
 * "Rs. 1,001" or "Rs. 501.50". Written out rather than ₹ because the rupee sign
 * turns an SMS into a Unicode message with half the room.
 */
function devoteeMoneyLabel(float $amount): string
{
    $decimals = abs($amount - round($amount)) >= 0.005 ? 2 : 0;
    return 'Rs. ' . number_format($amount, $decimals);
}

/**
 * A donation purpose as the devotee chose it on the Donations page, in their
 * language. The keys and wording mirror the <select> in pages/Donations.jsx.
 * A purpose the form does not offer (a bulk import, say) is shown as stored.
 */
function devoteeDonationPurposeLabel(?string $purpose, string $lang): string
{
    $l = devoteeCopyLang($lang);
    $labels = [
        'kumbabhishekam' => ['ta' => 'கும்பாபிஷேகம்', 'en' => 'Kumbabhishekam'],
        'annadanam_hall' => ['ta' => 'அன்னதான கூடம் கட்டுமானம்', 'en' => 'Annadanam Hall construction'],
        'annadanam'      => ['ta' => 'அன்னதானம்', 'en' => 'Annadanam'],
        'abhishekam'     => ['ta' => 'அபிஷேகம்', 'en' => 'Abhishekam'],
        'festival'       => ['ta' => 'திருவிழா நிதி', 'en' => 'the Festival Fund'],
        'maintenance'    => ['ta' => 'கோயில் பராமரிப்பு', 'en' => 'Temple Maintenance'],
        'other'          => ['ta' => 'கோயிலின் பிற தேவைகள்', 'en' => 'the temple\'s other needs'],
        ''               => ['ta' => 'கோயில் பொது நிதி', 'en' => 'the temple\'s general fund'],
    ];
    $key = trim((string) $purpose);
    return $labels[$key][$l] ?? $key;
}

/** "20 செப்டம்பர் 2026" / "20 Sep 2026", or a polite placeholder when no date was chosen. */
function devoteeBookingDateLabel(?string $ymd, string $lang): string
{
    $l = devoteeCopyLang($lang);
    if ($ymd === null || !isValidDate((string) $ymd)) {
        return $l === 'ta' ? 'தேதி உறுதி செய்யப்பட வேண்டும்' : 'a date to be confirmed';
    }
    return notifyFormatDate((string) $ymd, $l);
}

/**
 * A phone number as international digits for WhatsApp and SMS. Numbers saved
 * before the site asked for a country were ten Indian digits with no code; the
 * reminder worker treats them the same way.
 */
function devoteeIntlPhone(?string $phone, ?string $country): string
{
    $digits = preg_replace('/\D+/', '', (string) $phone) ?? '';
    if (strlen($digits) === 11 && $digits[0] === '0' && in_array($country, [null, '', 'IN'], true)) $digits = substr($digits, 1);
    if (strlen($digits) === 10 && in_array($country, [null, '', 'IN'], true)) $digits = '91' . $digits;
    return $digits;
}

/** "+91 ******3210" — enough for the devotee to recognise the number, not enough to use it. */
function devoteeMaskPhone(?string $phone): string
{
    $digits = preg_replace('/\D+/', '', (string) $phone) ?? '';
    if (strlen($digits) < 7) return '';
    $last = substr($digits, -4);
    if (strlen($digits) > 10) {
        return '+' . substr($digits, 0, strlen($digits) - 10) . ' ******' . $last;
    }
    return '******' . $last;
}

/**
 * Tell the devotee their password changed — after a reset link or from the
 * account page — so whoever really owns the address can act if it was not them.
 * The email goes inside the request (the catalogue marks it sync).
 */
function devoteeNotifyPasswordChanged(array $devotee): ?array
{
    if (!devoteeNotifyReady()) return null;
    $id = (int) $devotee['id'];
    return devoteeNotifyEvent('security.password_changed', [
        'devotee_id' => $id,
        'vars'       => ['changedAt' => devoteeNowLabel(devoteeNotifyLang($id))],
    ]);
}

/* ── Emails ─────────────────────────────────────────────────────────────── */

/**
 * The confirmation link. With the Notification Service it is an
 * account.email_verification event: the link travels in secret_vars, so it is
 * rendered only into the email that leaves in this request and is never stored.
 * The plain-text email keeps the link on a line of its own.
 */
function devoteeSendVerification(array $devotee): array
{
    $raw  = devoteeIssueToken((int) $devotee['id'], 'verify');
    $link = siteUrl('/verify-email?token=' . $raw);

    if (devoteeNotifyReady()) {
        $mail = devoteeMailFromNotify(devoteeNotifyEvent('account.email_verification', [
            'devotee_id'  => (int) $devotee['id'],
            'secret_vars' => ['verifyUrl' => $link],
            'vars'        => ['expiresHours' => VERIFY_TTL_HOURS],
        ]));
        if ($mail !== null) return $mail;
    }
    return devoteeMailVerification($devotee, $link);
}

/** The pre-notification confirmation email, sent straight through the mailer. */
function devoteeMailVerification(array $devotee, string $link): array
{
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

/** The reset link: a security.password_reset event, the link in secret_vars like the confirmation. */
function devoteeSendReset(array $devotee): array
{
    $raw  = devoteeIssueToken((int) $devotee['id'], 'reset');
    $link = siteUrl('/reset-password?token=' . $raw);

    if (devoteeNotifyReady()) {
        $mail = devoteeMailFromNotify(devoteeNotifyEvent('security.password_reset', [
            'devotee_id'  => (int) $devotee['id'],
            'secret_vars' => ['resetUrl' => $link],
            'vars'        => ['expiresMinutes' => RESET_TTL_MINUTES],
        ]));
        if ($mail !== null) return $mail;
    }
    return devoteeMailReset($devotee, $link);
}

/** The pre-notification reset email, sent straight through the mailer. */
function devoteeMailReset(array $devotee, string $link): array
{
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
 *
 * The event catalogue has no entry for this (it is not something a module
 * announces; it is the sign-up form protecting an address), so it is a plain
 * notify(): a security email only, sent now, with no in-app notification —
 * the bell must not light up because a stranger typed someone's address.
 */
function devoteeSendAlreadyRegistered(array $devotee): array
{
    if (devoteeNotifyReady()) {
        $login  = siteUrl('/login');
        $forgot = siteUrl('/forgot-password');
        try {
            $result = notify([
                'event'       => 'account.already_registered',
                'category'    => 'security',
                'priority'    => 'important',
                'channels'    => ['email'],
                'sync'        => true,
                'devotee_id'  => (int) $devotee['id'],
                'entity_type' => 'devotee',
                'entity_id'   => (int) $devotee['id'],
                'cta_url'     => '/login',
                'title'       => ['ta' => 'உங்களுக்கு ஏற்கெனவே கணக்கு உள்ளது', 'en' => 'You already have an account'],
                'cta_label'   => ['ta' => 'உள்நுழைய', 'en' => 'Go to sign in'],
                'body'        => [
                    'ta' => "இந்த மின்னஞ்சல் முகவரியைக் கொண்டு யாரோ இப்போது புதிய கணக்கு தொடங்க முயன்றார்கள். ஆனால் இந்த முகவரிக்கு ஏற்கெனவே கணக்கு உள்ளது. புதிய கணக்கு எதுவும் உருவாக்கப்படவில்லை; எதுவும் மாறவில்லை.\n\n"
                            . "அது நீங்கள்தான் என்றால், உள்நுழையுங்கள்:\n{$login}\n\nகடவுச்சொல் மறந்துவிட்டால்:\n{$forgot}\n\n"
                            . 'இது நீங்கள் இல்லை என்றால், இந்தச் செய்தியைப் பாதுகாப்பாகப் புறக்கணிக்கலாம்.',
                    'en' => "Someone just tried to create an account with this email address, but one already exists. No new account was made and nothing has changed.\n\n"
                            . "If that was you, sign in instead:\n{$login}\n\nForgotten your password? Choose a new one:\n{$forgot}\n\n"
                            . 'If this was not you, you can safely ignore this message.',
                ],
            ]);
        } catch (Throwable $e) {
            error_log('[notify] account.already_registered failed: ' . $e->getMessage());
            $result = null;
        }
        $mail = devoteeMailFromNotify($result);
        if ($mail !== null) return $mail;
    }
    return devoteeMailAlreadyRegistered($devotee);
}

/** The pre-notification "you already have an account" email, sent straight through the mailer. */
function devoteeMailAlreadyRegistered(array $devotee): array
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

/**
 * Sent once the address is confirmed. With the Notification Service this is
 * account.email_verified — one in-app notification and one email, deduped per
 * devotee, so confirming never sends a second "welcome" email on top of it. The
 * email is queued for the worker: nothing in it is secret or urgent.
 */
function devoteeSendWelcome(array $devotee): array
{
    if (devoteeNotifyReady()) {
        $mail = devoteeMailFromNotify(devoteeNotifyEvent('account.email_verified', [
            'devotee_id' => (int) $devotee['id'],
        ]));
        if ($mail !== null) return $mail;
    }
    return devoteeMailWelcome($devotee);
}

/** The pre-notification "email confirmed" message, sent straight through the mailer. */
function devoteeMailWelcome(array $devotee): array
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
