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
 *   POST phone-verify-start    text a one-time code to the saved phone number
 *   POST phone-verify-confirm  check that code; marks the number verified
 *
 * Everything is scoped to devotee_id. A devotee can only ever read rows the
 * site attached to their account when those rows were created.
 *
 * Notifications (SPEC §5.5, §6.5), once migration 007 is in: a profile change
 * sends account.profile_updated naming the fields that changed (never their new
 * values), a password change sends security.password_changed, and a verified
 * number sends phone.verified. Saving a different phone number clears its
 * verification, because the proof was for the old number.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';

$action = $accountAction ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// Unknown actions are a 404 before anything else runs, so a typo never comes
// back as 405 (which would imply the action exists) or as an auth challenge.
const ACCOUNT_GET_ACTIONS  = ['summary', 'bookings', 'donations'];
const ACCOUNT_POST_ACTIONS = ['profile', 'password', 'phone-verify-start', 'phone-verify-confirm'];
if (!in_array($action, ACCOUNT_GET_ACTIONS, true) && !in_array($action, ACCOUNT_POST_ACTIONS, true)) {
    sendError('Not found', 404);
}

/**
 * The changed profile fields as a short readable list in the devotee's language
 * ("name, mobile number"). Names only: the email this goes into may be read by
 * whoever changed them, and must not hand them the old or new values.
 */
function accountChangedFieldsLabel(array $keys, string $lang): string
{
    $labels = [
        'name'    => ['ta' => 'பெயர்', 'en' => 'name'],
        'phone'   => ['ta' => 'தொலைபேசி எண்', 'en' => 'mobile number'],
        'address' => ['ta' => 'அஞ்சல் முகவரி', 'en' => 'postal address'],
        'city'    => ['ta' => 'ஊர்', 'en' => 'city or town'],
        'state'   => ['ta' => 'மாநிலம்', 'en' => 'state'],
        'country' => ['ta' => 'நாடு', 'en' => 'country'],
    ];
    $l = devoteeCopyLang($lang);
    return implode(', ', array_map(static fn(string $k): string => $labels[$k][$l] ?? $k, $keys));
}

/** The one refusal both phone actions give when notifications are not installed. */
function accountOtpUnavailable(string $message = 'Mobile number verification is not available on this site yet.'): never
{
    sendJson(['error' => $message, 'code' => 'otp_unavailable'], 503);
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
        $ph      = normalizePhone($body['phone'] ?? '', $body['phoneCountry'] ?? null);
        $phone   = $ph['phone'];
        $country  = normalizeCountry($body['country'] ?? null);
        $state    = sanitizeText($body['state'] ?? '', 120);
        $city     = sanitizeText($body['city'] ?? '', 120);
        $address1 = sanitizeText($body['address1'] ?? '', 180);
        $address2 = sanitizeText($body['address2'] ?? '', 180);
        $postcode = sanitizeText($body['postcode'] ?? '', 20);
        $errors = [];
        if (mb_strlen($name) < 2)  $errors['name']  = 'Please enter your name.';
        if ($ph['error'] !== '')   $errors['phone'] = $ph['error'];
        // Same rules registration applies: the committee needs a country and a
        // town for every devotee. The state is left to the client, which knows
        // which countries the site actually has a list of subdivisions for.
        if ($country === null)     $errors['country'] = 'Please choose your country.';
        if (mb_strlen($city) < 2)  $errors['city']    = 'Please enter your city or town.';
        if ($errors) sendJson(['error' => 'Please correct the highlighted fields.', 'fields' => $errors], 422);

        // What actually changed, by name, compared with the saved row. Empty and
        // NULL are the same thing here: the form sends '' for a field left blank.
        $same    = static fn($old, string $new): bool => trim((string) ($old ?? '')) === $new;
        $changed = [];
        if (!$same($me['name'], $name))   $changed[] = 'name';
        if (!$same($me['phone'], $phone)) $changed[] = 'phone';
        if (!$same($me['address1'] ?? null, $address1) || !$same($me['address2'] ?? null, $address2)
            || !$same($me['postcode'] ?? null, $postcode)) {
            $changed[] = 'address';
        }
        if (!$same($me['city'] ?? null, $city))           $changed[] = 'city';
        if (!$same($me['state'] ?? null, $state))         $changed[] = 'state';
        if (!$same($me['country'] ?? null, (string) $country)) $changed[] = 'country';

        // A code proved the OLD number. Only a different number loses that proof;
        // re-saving the same digits (or only its country) keeps it. The column
        // exists only after migration 007, and SELECT * tells us whether it does.
        $clearPhoneProof = in_array('phone', $changed, true) && array_key_exists('phone_verified_at', $me);

        $db->prepare(
            'UPDATE devotees
                SET name = :n, phone = :p, phone_country = :pc,
                    address1 = :a1, address2 = :a2,
                    country = :co, state = :st, city = :ci, postcode = :pz'
            . ($clearPhoneProof ? ', phone_verified_at = NULL' : '')
            . ' WHERE id = :id'
        )->execute([
            ':n'  => $name,
            ':p'  => $phone !== '' ? $phone : null,
            ':pc' => $phone !== '' ? $ph['country'] : null,
            ':a1' => $address1 !== '' ? $address1 : null,
            ':a2' => $address2 !== '' ? $address2 : null,
            ':co' => $country,
            ':st' => $state !== '' ? $state : null,
            ':ci' => $city !== '' ? $city : null,
            ':pz' => $postcode !== '' ? $postcode : null,
            ':id' => $me['id'],
        ]);
        $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
        $stmt->execute([':id' => $me['id']]);
        $fresh = $stmt->fetch();

        // A security notice when something really changed. changedKeys is the
        // same list as stable names, for the admin and for tests; neither holds
        // a value the devotee typed.
        if ($changed) {
            devoteeNotifyEvent('account.profile_updated', [
                'devotee_id' => (int) $me['id'],
                'vars'       => [
                    'changedFields' => accountChangedFieldsLabel($changed, devoteeNotifyLang((int) $me['id'])),
                    'changedKeys'   => implode(',', $changed),
                ],
            ]);
        }
        sendJson(['ok' => true, 'user' => devoteePublic($fresh), 'message' => 'Your details are saved.']);
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
        devoteeNotifyPasswordChanged($me);
        sendJson(['ok' => true, 'message' => 'Your password has been changed.']);
    }

    /* ── Verify the saved phone number with a one-time code ─────────────── */
    case 'phone-verify-start': {
        if (!devoteeNotifyReady()) accountOtpUnavailable();
        $phone = (string) ($me['phone'] ?? '');
        if ((preg_replace('/\D+/', '', $phone) ?? '') === '') {
            $m = 'Add your mobile number to your profile and save it first, then ask for a code.';
            sendJson(['error' => $m, 'fields' => ['phone' => $m]], 422);
        }
        // Nothing to prove twice, and every code costs the temple an SMS.
        if (!empty($me['phone_verified_at'])) {
            sendJson([
                'ok' => true, 'alreadyVerified' => true, 'channel' => null, 'expiresIn' => 0,
                'message' => 'Your mobile number is already verified.', 'user' => devoteePublic($me),
            ]);
        }

        // notifyOtpIssue() holds the limits (3 codes per 15 minutes, 10 a day,
        // per devotee) and expires the code at once if nothing reached the phone.
        $issue = notifyOtpIssue((int) $me['id'], $phone);
        if ($issue['ok']) {
            $via     = $issue['channel'] === 'whatsapp' ? 'on WhatsApp' : 'by text message';
            $minutes = max(1, (int) ceil(((int) $issue['expiresIn']) / 60));
            sendJson([
                'ok'        => true,
                'channel'   => $issue['channel'],
                'expiresIn' => (int) $issue['expiresIn'],
                'message'   => "We have sent a 6-digit code {$via} to " . devoteeMaskPhone($phone) . ". It works for {$minutes} minutes.",
            ]);
        }
        if ($issue['code'] === 'rate_limited') {
            $retry = max(1, (int) $issue['retryAfter']);
            header('Retry-After: ' . $retry);
            sendJson(['error' => $issue['error'], 'code' => 'rate_limited', 'retryAfter' => $retry], 429);
        }
        if ($issue['code'] === 'unavailable') {
            accountOtpUnavailable((string) ($issue['error'] ?? 'We could not send a code just now. Please try again later.'));
        }
        // No code: the saved number is not one a code can be sent to.
        $m = (string) ($issue['error'] ?? 'Add a valid mobile number to your profile first.');
        sendJson(['error' => $m, 'fields' => ['phone' => $m]], 422);
    }

    case 'phone-verify-confirm': {
        if (!devoteeNotifyReady()) accountOtpUnavailable();
        // A backstop across codes; each code already allows only five tries.
        if (!rateLimitAllow('otp-confirm', 30, 900, 'd' . (int) $me['id'])) {
            sendJson(['error' => 'Too many attempts. Please wait a few minutes, then ask for a new code.', 'code' => 'rate_limited', 'retryAfter' => 900], 429);
        }
        $code = preg_replace('/\s+/', '', (string) ($body['code'] ?? '')) ?? '';
        // A typo in the shape of the code does not spend one of the five tries.
        if (!preg_match('/^\d{6}$/', $code)) {
            $m = 'Enter the 6-digit code from the message.';
            sendJson(['error' => $m, 'fields' => ['code' => $m], 'attemptsLeft' => null], 422);
        }
        $phone = (string) ($me['phone'] ?? '');
        if ($phone === '') {
            $m = 'Add your mobile number to your profile first.';
            sendJson(['error' => $m, 'fields' => ['phone' => $m], 'attemptsLeft' => null], 422);
        }

        $check = notifyOtpVerify((int) $me['id'], $phone, $code);
        if (!$check['ok']) {
            $m = (string) ($check['error'] ?? 'That code is not right. Check the message and try again.');
            sendJson(['error' => $m, 'fields' => ['code' => $m], 'attemptsLeft' => $check['attemptsLeft']], 422);
        }

        $stmt = $db->prepare('SELECT * FROM devotees WHERE id = :id');
        $stmt->execute([':id' => $me['id']]);
        $fresh = $stmt->fetch();
        devoteeNotifyEvent('phone.verified', [
            'devotee_id' => (int) $me['id'],
            'vars'       => ['phoneMasked' => devoteeMaskPhone((string) $fresh['phone'])],
        ]);
        sendJson(['ok' => true, 'user' => devoteePublic($fresh), 'message' => 'Your mobile number is verified.']);
    }
}

sendError('Not found', 404);
