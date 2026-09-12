<?php
/**
 * backend/api/auth.php — devotee sign-up and sign-in.
 *
 * Dispatched by api/index.php for every /api/auth/* path. Actions:
 *   GET  csrf      token the client echoes back in X-CSRF-Token
 *   GET  me        the signed-in devotee, or null
 *   POST register  create an account and send a confirmation email
 *   POST login     start a session
 *   POST logout    end it
 *   POST verify    consume a confirmation token
 *   POST resend    send the confirmation email again (signed in only)
 *   POST forgot    send a reset link
 *   POST reset     consume a reset token and set a new password
 *
 * Register, forgot and reset answer identically whether or not the address is
 * known, so none of them can be used to find out who has an account.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';

$action = $authAction ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$body   = $method === 'POST' ? getJsonBody() : [];

// An action nobody implements is a 404, whatever the verb. Deciding this up
// front means a typo cannot come back as "Method not allowed", which would
// wrongly suggest the action exists.
const AUTH_GET_ACTIONS  = ['csrf', 'me'];
const AUTH_POST_ACTIONS = ['register', 'login', 'logout', 'verify', 'resend', 'forgot', 'reset'];
if (!in_array($action, AUTH_GET_ACTIONS, true) && !in_array($action, AUTH_POST_ACTIONS, true)) {
    sendError('Not found', 404);
}

/** Same wording whatever actually happened, so nothing is revealed. */
const VAGUE_SENT = 'If that email address has an account, we have sent a message to it. Please check your inbox, and your spam folder.';

devoteeSessionStart();

if ($action === 'csrf' && $method === 'GET') {
    sendJson(['csrf' => devoteeCsrfToken()]);
}

if ($action === 'me' && $method === 'GET') {
    // Every page load calls this, so a 500 here makes the whole site look
    // broken. If anything at all goes wrong the honest answer is "you are a
    // guest and accounts are unavailable" — a state the UI already renders,
    // hiding the account entry points instead of offering doors that fail.
    try {
        $me = currentDevotee();
        sendJson([
            'user'            => $me ? devoteePublic($me) : null,
            'csrf'            => devoteeCsrfToken(),
            'accountsEnabled' => devoteeTablesExist(),
        ]);
    } catch (Throwable $e) {
        error_log('[auth/me] ' . $e->getMessage());
        sendJson(['user' => null, 'csrf' => '', 'accountsEnabled' => false]);
    }
}

devoteeRequireTables();

if ($method !== 'POST') {
    sendError('Method not allowed', 405);
}
devoteeRequireCsrf();

$db = getDB();

switch ($action) {

    /* ── Register ───────────────────────────────────────────────────────── */
    case 'register': {
        // Two budgets, because they answer different questions. The wide one
        // stops a script hammering the endpoint. The narrow one limits how many
        // accounts a single connection can actually create. Counting rejected
        // attempts against the narrow budget would lock out an ordinary person
        // who mistyped their email twice and then chose two weak passwords.
        rateLimitOrFail('register-try', 25, 3600, 'Too many sign-up attempts from this connection. Please try again in an hour.');

        $name  = sanitizeText($body['name'] ?? '', 200);
        $email = mb_strtolower(trim((string) ($body['email'] ?? '')));
        $phone = preg_replace('/\D+/', '', (string) ($body['phone'] ?? ''));
        $pass  = (string) ($body['password'] ?? '');

        $errors = [];
        if (mb_strlen($name) < 2)                                  $errors['name']  = 'Please enter your name.';
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 190) {
            $errors['email'] = 'Please enter a valid email address.';
        }
        if ($phone !== '' && !preg_match('/^\d{7,15}$/', $phone))   $errors['phone'] = 'Enter a phone number of 7 to 15 digits, or leave it blank.';
        $pp = passwordProblem($pass, $email);
        if ($pp !== '')                                            $errors['password'] = $pp;
        if ($errors) sendJson(['error' => 'Please correct the highlighted fields.', 'fields' => $errors], 422);

        // The request is well formed, so it now counts against the narrow budget.
        // The message stays the same as the wide one: a caller must not be able
        // to tell which limit it hit, or it learns that its input was valid.
        rateLimitOrFail('register', 5, 3600, 'Too many sign-up attempts from this connection. Please try again in an hour.');

        $stmt = $db->prepare('SELECT * FROM devotees WHERE email = :e LIMIT 1');
        $stmt->execute([':e' => $email]);
        $existing = $stmt->fetch();

        if ($existing) {
            // Tell the real owner, answer the caller exactly as for a new account.
            $mail = devoteeSendAlreadyRegistered($existing);
        } else {
            $db->prepare('INSERT INTO devotees (name, email, phone, pass_hash) VALUES (:n,:e,:p,:h)')
               ->execute([
                   ':n' => $name,
                   ':e' => $email,
                   ':p' => $phone !== '' ? $phone : null,
                   ':h' => password_hash($pass, PASSWORD_BCRYPT),
               ]);
            $id   = (int) $db->lastInsertId();
            $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
            $stmt->execute([':id' => $id]);
            $mail = devoteeSendVerification($stmt->fetch());
        }

        sendJson([
            'ok'      => true,
            'message' => 'Account created. Check your email for a confirmation link, then sign in. '
                       . 'You can sign in straight away if the email has not arrived.',
            // A property of the server, not of any account, so this leaks nothing.
            'emailDelivery' => $mail['status'] === 'sent' ? 'sent' : 'unavailable',
        ], 201);
    }

    /* ── Sign in ────────────────────────────────────────────────────────── */
    case 'login': {
        $email = mb_strtolower(trim((string) ($body['email'] ?? '')));
        $pass  = (string) ($body['password'] ?? '');

        rateLimitOrFail('login-ip', 20, 900, 'Too many sign-in attempts. Please wait fifteen minutes and try again.');
        if ($email !== '' && !rateLimitAllow('login-acct', 6, 900, $email)) {
            sendJson(['error' => 'Too many attempts for that account. Please wait fifteen minutes, or reset your password.', 'code' => 'rate_limited'], 429);
        }
        if ($email === '' || $pass === '') {
            sendJson(['error' => 'Enter your email address and password.'], 422);
        }

        $stmt = $db->prepare('SELECT * FROM devotees WHERE email = :e LIMIT 1');
        $stmt->execute([':e' => $email]);
        $row = $stmt->fetch();

        if (!$row || !password_verify($pass, $row['pass_hash'])) {
            sendJson(['error' => 'That email address and password do not match.'], 401);
        }
        if (!$row['is_active']) {
            sendJson(['error' => 'This account has been closed. Please contact the temple office.'], 403);
        }
        if (password_needs_rehash($row['pass_hash'], PASSWORD_BCRYPT)) {
            $db->prepare('UPDATE devotees SET pass_hash = :h WHERE id = :id')
               ->execute([':h' => password_hash($pass, PASSWORD_BCRYPT), ':id' => $row['id']]);
        }
        devoteeLogIn($row);
        sendJson(['ok' => true, 'user' => devoteePublic($row), 'csrf' => devoteeCsrfToken()]);
    }

    /* ── Sign out ───────────────────────────────────────────────────────── */
    case 'logout': {
        devoteeLogOut();
        sendJson(['ok' => true]);
    }

    /* ── Confirm an email address ───────────────────────────────────────── */
    case 'verify': {
        rateLimitOrFail('verify', 30, 900, 'Too many attempts. Please wait a few minutes.');
        $token = (string) ($body['token'] ?? '');
        $row   = devoteeConsumeToken($token, 'verify');
        if (!$row) {
            sendJson([
                'error' => 'That confirmation link has expired or has already been used. Sign in and ask for a new one.',
                'code'  => 'token_invalid',
            ], 400);
        }
        $db->prepare('UPDATE devotees SET email_verified_at = NOW() WHERE id = :id')
           ->execute([':id' => (int) $row['id']]);
        $row['email_verified_at'] = date('Y-m-d H:i:s');
        devoteeSendWelcome($row);
        devoteeLogIn($row);
        sendJson(['ok' => true, 'user' => devoteePublic($row), 'csrf' => devoteeCsrfToken(),
                  'message' => 'Your email address is confirmed.']);
    }

    /* ── Send the confirmation again ────────────────────────────────────── */
    case 'resend': {
        $me = devoteeRequireAuth();
        if ($me['email_verified_at'] !== null) {
            sendJson(['ok' => true, 'message' => 'Your email address is already confirmed.']);
        }
        if (!rateLimitAllow('resend', 3, 3600, (string) $me['id'])) {
            sendJson(['error' => 'We have already sent a few of these. Please check your spam folder, then try again later.', 'code' => 'rate_limited'], 429);
        }
        $mail = devoteeSendVerification($me);
        sendJson([
            'ok'      => $mail['ok'],
            'message' => $mail['ok']
                ? 'Confirmation email sent. Please check your inbox.'
                : 'We could not send the email just now. Please contact the temple office.',
            'emailDelivery' => $mail['status'] === 'sent' ? 'sent' : 'unavailable',
        ], $mail['ok'] ? 200 : 503);
    }

    /* ── Forgot password ────────────────────────────────────────────────── */
    case 'forgot': {
        rateLimitOrFail('forgot', 5, 3600, 'Too many reset requests from this connection. Please try again in an hour.');
        $email = mb_strtolower(trim((string) ($body['email'] ?? '')));
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
            sendJson(['error' => 'Please enter a valid email address.', 'fields' => ['email' => 'Please enter a valid email address.']], 422);
        }
        $stmt = $db->prepare('SELECT * FROM devotees WHERE email = :e AND is_active = 1 LIMIT 1');
        $stmt->execute([':e' => $email]);
        $row = $stmt->fetch();
        $delivery = 'sent';
        if ($row) {
            $mail = devoteeSendReset($row);
            $delivery = $mail['status'] === 'sent' ? 'sent' : 'unavailable';
        }
        sendJson(['ok' => true, 'message' => VAGUE_SENT, 'emailDelivery' => $delivery]);
    }

    /* ── Set a new password from a reset link ───────────────────────────── */
    case 'reset': {
        rateLimitOrFail('reset', 20, 900, 'Too many attempts. Please wait a few minutes.');
        $token = (string) ($body['token'] ?? '');
        $pass  = (string) ($body['password'] ?? '');

        $row = devoteeConsumeToken($token, 'reset');
        if (!$row) {
            sendJson([
                'error' => 'That reset link has expired or has already been used. Please request a new one.',
                'code'  => 'token_invalid',
            ], 400);
        }
        $pp = passwordProblem($pass, $row['email']);
        if ($pp !== '') {
            // The token was spent; say so plainly rather than looping silently.
            sendJson([
                'error'  => $pp,
                'fields' => ['password' => $pp],
                'code'   => 'weak_password',
                'hint'   => 'That reset link has now been used. If this message stays, request a new link.',
            ], 422);
        }
        $db->prepare('UPDATE devotees SET pass_hash = :h, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = :id')
           ->execute([':h' => password_hash($pass, PASSWORD_BCRYPT), ':id' => (int) $row['id']]);
        $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
        $stmt->execute([':id' => (int) $row['id']]);
        $fresh = $stmt->fetch();
        devoteeLogIn($fresh);
        sendJson(['ok' => true, 'user' => devoteePublic($fresh), 'csrf' => devoteeCsrfToken(),
                  'message' => 'Your password has been changed and you are signed in.']);
    }
}

sendError('Not found', 404);
