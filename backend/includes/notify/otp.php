<?php
/**
 * backend/includes/notify/otp.php — proving a devotee holds the phone number
 * on their profile.
 *
 * Until now a phone number proved nothing on this site (devotee_auth.php says
 * so, and matches no history on it). A one-time code sent to the number and
 * typed back changes that: phone_verified_at is set, and paid channels and
 * promotional WhatsApp may then use the number.
 *
 * Only a keyed hash of the code is stored — HMAC with the service secret, bound
 * to the devotee, the purpose and the number, so a leaked table row cannot be
 * replayed and a code for one number cannot verify another. The code itself
 * reaches the provider through secret_vars and nowhere else.
 */

require_once __DIR__ . '/events.php';

const NOTIFY_OTP_TTL_SECONDS = 600;
const NOTIFY_OTP_MAX_TRIES   = 5;

function notifyOtpHash(int $devoteeId, string $purpose, string $phone, string $code): string
{
    return hash_hmac('sha256', $purpose . ':' . $devoteeId . ':' . $phone . ':' . $code, notifySecret());
}

/** Seconds until a rate-limit bucket's window reopens. */
function notifyOtpRetryAfter(string $bucket, int $window): int
{
    try {
        $stmt = getDB()->prepare('SELECT TIMESTAMPDIFF(SECOND, window_start, NOW()) FROM rate_limits WHERE bucket = :b');
        $stmt->execute([':b' => $bucket]);
        $elapsed = $stmt->fetchColumn();
        return $elapsed === false ? $window : max(1, $window - (int) $elapsed);
    } catch (Throwable) {
        return $window;
    }
}

/**
 * Send a verification code to $phone. Limits: 3 codes per 15 minutes and 10 per
 * day for each devotee. Issuing a code retires any earlier unused one.
 *
 * Returns ['ok','channel' => 'sms'|'whatsapp'|null,'expiresIn' => 600,'error' => ?string,
 *          'code' => ?'rate_limited'|'unavailable','retryAfter' => ?int]
 */
function notifyOtpIssue(int $devoteeId, string $phone, string $purpose = 'phone_verify'): array
{
    $out = static fn(bool $ok, ?string $channel = null, ?string $error = null, ?string $code = null, ?int $retry = null): array => [
        'ok' => $ok, 'channel' => $channel, 'expiresIn' => NOTIFY_OTP_TTL_SECONDS, 'error' => $error, 'code' => $code, 'retryAfter' => $retry,
    ];
    if (!notifyTablesExist()) return $out(false, null, 'Phone verification is not available right now.', 'unavailable');
    if ($purpose !== 'phone_verify') return $out(false, null, 'That kind of code is not supported.', 'unavailable');

    $normal = normalizePhone($phone);
    if ($normal['error'] !== '' || $normal['phone'] === '') return $out(false, null, 'Add a valid mobile number to your profile first.');
    $digits = $normal['phone'];

    require_once __DIR__ . '/../devotee_auth.php';
    try {
        $db = getDB();
        $stmt = $db->prepare('SELECT id FROM devotees WHERE id = :d AND is_active = 1');
        $stmt->execute([':d' => $devoteeId]);
        if (!$stmt->fetch()) return $out(false, null, 'Please sign in again.', 'unavailable');

        // Peek before spending, so a devotee held back by the 15-minute limit does
        // not also burn their daily allowance with each retry.
        $who = 'd' . $devoteeId;
        foreach ([['otp-issue-15m', 3, 900], ['otp-issue-day', 10, 86400]] as [$action, $max, $window]) {
            if (!rateLimitPeek($action, $max, $window, $who)) {
                $retry = notifyOtpRetryAfter($action . ':' . $who, $window);
                $wait  = $retry >= 3600 ? 'tomorrow' : 'in ' . max(1, (int) ceil($retry / 60)) . ' minute' . ($retry > 60 ? 's' : '');
                return $out(false, null, "Too many codes requested. You can ask for another {$wait}.", 'rate_limited', $retry);
            }
        }
        rateLimitAllow('otp-issue-15m', 3, 900, $who);
        rateLimitAllow('otp-issue-day', 10, 86400, $who);

        $now  = notifyNow();
        $code = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        $db->prepare(
            'UPDATE devotee_otps SET expires_at = LEAST(expires_at, :now)
              WHERE devotee_id = :d AND purpose = :p AND consumed_at IS NULL AND expires_at > :now2'
        )->execute([':now' => $now, ':d' => $devoteeId, ':p' => $purpose, ':now2' => $now]);
        $db->prepare(
            'INSERT INTO devotee_otps (devotee_id, purpose, phone, code_hash, attempts, expires_at, created_at)
             VALUES (:d, :p, :phone, :h, 0, :exp, :now)'
        )->execute([
            ':d' => $devoteeId, ':p' => $purpose, ':phone' => $digits,
            ':h' => notifyOtpHash($devoteeId, $purpose, $digits, $code),
            ':exp' => notifyNowPlus(NOTIFY_OTP_TTL_SECONDS), ':now' => $now,
        ]);
        $otpId = (int) $db->lastInsertId();

        $sent = notifyEvent('phone.otp', [
            'devotee_id'  => $devoteeId,
            'to_phone'    => $digits,
            'secret_vars' => ['otpCode' => $code],
            'vars'        => ['expiresMinutes' => (int) (NOTIFY_OTP_TTL_SECONDS / 60)],
        ]);

        $channel = null;
        foreach (['sms', 'whatsapp'] as $c) {
            if (($sent['deliveries'][$c]['status'] ?? null) === 'sent') {
                $channel = $c;
                break;
            }
        }
        if ($channel === null) {
            // Nothing reached the phone: the code must not stay usable.
            $db->prepare('UPDATE devotee_otps SET expires_at = :now WHERE id = :id')->execute([':now' => $now, ':id' => $otpId]);
            return $out(false, null, 'We could not send a code to that number just now. Please try again later.', 'unavailable');
        }
        $db->prepare('UPDATE devotee_otps SET channel = :c WHERE id = :id')->execute([':c' => $channel, ':id' => $otpId]);
        return $out(true, $channel);
    } catch (Throwable $e) {
        error_log('[notify] issuing a one-time code failed: ' . get_class($e) . ': ' . $e->getMessage());
        return $out(false, null, 'We could not send a code just now. Please try again later.', 'unavailable');
    }
}

/**
 * Check a code. Five tries per code, compared in constant time. On success the
 * code is spent and the devotee's phone_verified_at is set — but only while the
 * number is still the one on their profile.
 *
 * Returns ['ok' => bool, 'error' => ?string, 'attemptsLeft' => ?int]
 */
function notifyOtpVerify(int $devoteeId, string $phone, string $code, string $purpose = 'phone_verify'): array
{
    $out = static fn(bool $ok, ?string $error = null, ?int $left = null): array => ['ok' => $ok, 'error' => $error, 'attemptsLeft' => $left];
    if (!notifyTablesExist()) return $out(false, 'Phone verification is not available right now.');

    $digits = normalizePhone($phone)['phone'];
    $code   = preg_replace('/\s+/', '', $code) ?? '';
    try {
        $db  = getDB();
        $now = notifyNow();
        $stmt = $db->prepare(
            'SELECT id, code_hash, attempts FROM devotee_otps
              WHERE devotee_id = :d AND purpose = :p AND phone = :phone AND consumed_at IS NULL AND expires_at > :now
              ORDER BY id DESC LIMIT 1'
        );
        $stmt->execute([':d' => $devoteeId, ':p' => $purpose, ':phone' => $digits, ':now' => $now]);
        $otp = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$otp) return $out(false, 'That code has expired. Ask for a new one.');

        $spend = $db->prepare('UPDATE devotee_otps SET attempts = attempts + 1 WHERE id = :id AND attempts < :max');
        $spend->execute([':id' => (int) $otp['id'], ':max' => NOTIFY_OTP_MAX_TRIES]);
        if ($spend->rowCount() === 0) return $out(false, 'Too many wrong codes. Ask for a new one.', 0);
        $left = NOTIFY_OTP_MAX_TRIES - ((int) $otp['attempts'] + 1);

        $expected = (string) $otp['code_hash'];
        $given    = preg_match('/^\d{6}$/', $code) ? notifyOtpHash($devoteeId, $purpose, $digits, $code) : str_repeat('0', 64);
        if (!hash_equals($expected, $given)) {
            return $out(false, $left > 0 ? 'That code is not right. Check the message and try again.' : 'Too many wrong codes. Ask for a new one.', $left);
        }

        $consume = $db->prepare('UPDATE devotee_otps SET consumed_at = :now WHERE id = :id AND consumed_at IS NULL');
        $consume->execute([':now' => $now, ':id' => (int) $otp['id']]);
        if ($consume->rowCount() === 0) return $out(false, 'That code has already been used. Ask for a new one.');

        $mark = $db->prepare('UPDATE devotees SET phone_verified_at = :now WHERE id = :d AND phone = :phone AND is_active = 1');
        $mark->execute([':now' => $now, ':d' => $devoteeId, ':phone' => $digits]);
        if ($mark->rowCount() === 0) {
            $check = $db->prepare('SELECT phone, phone_verified_at FROM devotees WHERE id = :d');
            $check->execute([':d' => $devoteeId]);
            $row = $check->fetch(PDO::FETCH_ASSOC);
            // rowCount is 0 both when the number changed and when it was already verified this second.
            if (!$row || (string) $row['phone'] !== $digits) return $out(false, 'Your mobile number changed. Ask for a new code.');
        }
        return $out(true, null, $left);
    } catch (Throwable $e) {
        error_log('[notify] verifying a one-time code failed: ' . get_class($e) . ': ' . $e->getMessage());
        return $out(false, 'We could not check that code just now. Please try again.');
    }
}
