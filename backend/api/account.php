<?php
/**
 * backend/api/account.php — the signed-in devotee's own records.
 *
 * Dispatched by api/index.php for every /api/account/* path. Actions:
 *   GET  summary   counts and totals for the dashboard
 *   GET  bookings  their seva bookings
 *   GET  donations their pledges
 *   POST profile   update name / phone
 *   POST password  change password, current one required
 *
 * Everything is scoped to devotee_id. A devotee can only ever read rows the
 * site attached to their account when those rows were created.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';

$action = $accountAction ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// Unknown actions are a 404 before anything else runs, so a typo never comes
// back as 405 (which would imply the action exists) or as an auth challenge.
const ACCOUNT_GET_ACTIONS  = ['summary', 'bookings', 'donations'];
const ACCOUNT_POST_ACTIONS = ['profile', 'password'];
if (!in_array($action, ACCOUNT_GET_ACTIONS, true) && !in_array($action, ACCOUNT_POST_ACTIONS, true)) {
    sendError('Not found', 404);
}

devoteeRequireTables();
$me = devoteeRequireAuth();
$db = getDB();

if ($method === 'GET') {
    switch ($action) {

        case 'summary': {
            $stmt = $db->prepare(
                'SELECT
                   (SELECT COUNT(*) FROM seva_bookings WHERE devotee_id = :d1)                         AS bookings,
                   (SELECT COUNT(*) FROM seva_bookings WHERE devotee_id = :d2 AND status = "pending")  AS pending,
                   (SELECT COUNT(*) FROM donations     WHERE devotee_id = :d3)                         AS donations,
                   (SELECT COALESCE(SUM(amount),0) FROM donations WHERE devotee_id = :d4)              AS donated'
            );
            $stmt->execute([':d1' => $me['id'], ':d2' => $me['id'], ':d3' => $me['id'], ':d4' => $me['id']]);
            $s = $stmt->fetch();

            $next = $db->prepare(
                'SELECT seva_name, preferred_date, status
                   FROM seva_bookings
                  WHERE devotee_id = :d AND preferred_date IS NOT NULL AND preferred_date >= CURDATE()
                    AND status IN ("pending","confirmed")
                  ORDER BY preferred_date ASC LIMIT 1'
            );
            $next->execute([':d' => $me['id']]);

            sendJson([
                'user'      => devoteePublic($me),
                'bookings'  => (int) $s['bookings'],
                'pending'   => (int) $s['pending'],
                'donations' => (int) $s['donations'],
                'donated'   => (float) $s['donated'],
                'nextBooking' => $next->fetch() ?: null,
            ]);
        }

        case 'bookings': {
            $stmt = $db->prepare(
                'SELECT id, seva_name, preferred_date, message, status, created_at
                   FROM seva_bookings WHERE devotee_id = :d
                  ORDER BY created_at DESC LIMIT 100'
            );
            $stmt->execute([':d' => $me['id']]);
            sendJson($stmt->fetchAll());
        }

        case 'donations': {
            $stmt = $db->prepare(
                'SELECT id, amount, purpose, message, created_at
                   FROM donations WHERE devotee_id = :d
                  ORDER BY created_at DESC LIMIT 100'
            );
            $stmt->execute([':d' => $me['id']]);
            sendJson($stmt->fetchAll());
        }
    }
    sendError('Not found', 404);
}

if ($method !== 'POST') {
    sendError('Method not allowed', 405);
}
devoteeRequireCsrf();
$body = getJsonBody();

switch ($action) {

    case 'profile': {
        $name  = sanitizeText($body['name'] ?? '', 200);
        $phone = preg_replace('/\D+/', '', (string) ($body['phone'] ?? ''));
        $errors = [];
        if (mb_strlen($name) < 2)                                 $errors['name']  = 'Please enter your name.';
        if ($phone !== '' && !preg_match('/^\d{7,15}$/', $phone))  $errors['phone'] = 'Enter a phone number of 7 to 15 digits, or leave it blank.';
        if ($errors) sendJson(['error' => 'Please correct the highlighted fields.', 'fields' => $errors], 422);

        $db->prepare('UPDATE devotees SET name = :n, phone = :p WHERE id = :id')
           ->execute([':n' => $name, ':p' => $phone !== '' ? $phone : null, ':id' => $me['id']]);
        $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
        $stmt->execute([':id' => $me['id']]);
        sendJson(['ok' => true, 'user' => devoteePublic($stmt->fetch()), 'message' => 'Your details are saved.']);
    }

    case 'password': {
        rateLimitOrFail('pwchange', 10, 900, 'Too many attempts. Please wait a few minutes.');
        $current = (string) ($body['currentPassword'] ?? '');
        $next    = (string) ($body['newPassword'] ?? '');

        if (!password_verify($current, $me['pass_hash'])) {
            sendJson(['error' => 'That is not your current password.', 'fields' => ['currentPassword' => 'That is not your current password.']], 422);
        }
        $pp = passwordProblem($next, $me['email']);
        if ($pp !== '')      sendJson(['error' => $pp, 'fields' => ['newPassword' => $pp]], 422);
        if ($next === $current) {
            sendJson(['error' => 'Choose a password you have not used here before.', 'fields' => ['newPassword' => 'Choose a password you have not used here before.']], 422);
        }

        $db->prepare('UPDATE devotees SET pass_hash = :h WHERE id = :id')
           ->execute([':h' => password_hash($next, PASSWORD_BCRYPT), ':id' => $me['id']]);
        // Any outstanding reset links are now meaningless.
        $db->prepare('UPDATE devotee_tokens SET used_at = NOW() WHERE devotee_id = :d AND kind = "reset" AND used_at IS NULL')
           ->execute([':d' => $me['id']]);
        sendJson(['ok' => true, 'message' => 'Your password has been changed.']);
    }
}

sendError('Not found', 404);
