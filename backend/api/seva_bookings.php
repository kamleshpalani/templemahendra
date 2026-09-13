<?php
// backend/api/seva_bookings.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';
require_once __DIR__ . '/../includes/public_guard.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

// Every post spends an attempt before anything else is looked at, so neither a
// flood of junk nor a bot tripping the honeypot is free.
publicGuardLimit('seva-booking-attempt');

$body = getJsonBody();
publicGuardHoneypotOrContinue($body);

$devotee_name   = sanitizeText(is_string($body['devotee_name'] ?? null) ? $body['devotee_name'] : '');
$ph             = normalizePhone(is_scalar($body['phone'] ?? null) ? $body['phone'] : '', is_string($body['phoneCountry'] ?? null) ? $body['phoneCountry'] : null, true);
$phone          = $ph['phone'];
$seva_name      = sanitizeText(is_string($body['seva_name'] ?? null) ? $body['seva_name'] : '');
$seva_id        = isset($body['seva_id']) && is_numeric($body['seva_id'])
                    ? (int) $body['seva_id'] : null;
$preferred_date = is_string($body['preferred_date'] ?? null) ? $body['preferred_date'] : null;
$message        = sanitizeText(is_string($body['message'] ?? null) ? $body['message'] : '', 1000);

// ── Validation ───────────────────────────────────────────────────────────────
if ($devotee_name === '' || strlen($devotee_name) < 2) {
    sendError('Please enter your name');
}
if ($ph['error'] !== '') {
    sendError($ph['error']);
}
if ($seva_name === '') {
    sendError('Please select a seva');
}

// Validate and normalise preferred_date
$dateValue = null;
if (!empty($preferred_date)) {
    $d = DateTime::createFromFormat('Y-m-d', $preferred_date);
    if ($d && $d->format('Y-m-d') === $preferred_date) {
        // Must not be in the past
        if ($d >= new DateTime('today')) {
            $dateValue = $preferred_date;
        }
    }
}

// A valid booking reaches the office and costs a message to the devotee, so
// saved bookings have their own, tighter limit.
publicGuardLimit('seva-booking-saved');

// ── Insert ────────────────────────────────────────────────────────────────────
// A signed-in devotee's booking is stamped with their account id so it shows up
// in their own history. Anonymous bookings keep working exactly as before.
$db       = getDB();
$linkId   = devoteeLinkId('seva_bookings');
$columns  = ['devotee_name', 'phone', 'phone_country', 'seva_id', 'seva_name', 'preferred_date', 'message'];
$params   = [
    ':devotee_name'   => $devotee_name,
    ':phone'          => $phone,
    ':phone_country'  => $ph['country'],
    ':seva_id'        => $seva_id,
    ':seva_name'      => $seva_name,
    ':preferred_date' => $dateValue,
    ':message'        => $message !== '' ? $message : null,
];
if ($linkId !== null) {
    $columns[]           = 'devotee_id';
    $params[':devotee_id'] = $linkId;
}
$stmt = $db->prepare(
    'INSERT INTO seva_bookings (' . implode(', ', $columns) . ')'
    . ' VALUES (' . implode(', ', array_keys($params)) . ')'
);
$stmt->execute($params);
$bookingId = (int) $db->lastInsertId();

// ── Acknowledge it ───────────────────────────────────────────────────────────
// booking.received: the account when signed in, otherwise the phone number the
// guest gave (in Tamil, the site's language). It is queued, not sent here, and
// nothing about it can change this response — the booking is already saved,
// and a devotee must never be told it failed because a message did.
try {
    if (devoteeNotifyReady()) {
        $lang = $linkId !== null ? devoteeNotifyLang($linkId) : 'ta';
        $l    = devoteeCopyLang($lang);
        $sevaLabel = $seva_name;
        if ($seva_id !== null) {
            $s = $db->prepare('SELECT name_ta, name_en FROM sevas WHERE id = :id');
            $s->execute([':id' => $seva_id]);
            if ($seva = $s->fetch()) {
                $sevaLabel = trim((string) ($l === 'ta' ? $seva['name_ta'] : $seva['name_en'])) ?: $seva_name;
            }
        }
        $ctx = [
            'entity_id' => $bookingId,
            'vars'      => [
                'bookingNumber' => devoteeBookingNumber($bookingId),
                'sevaName'      => $sevaLabel,
                'bookingDate'   => devoteeBookingDateLabel($dateValue, $l),
            ],
        ];
        if ($linkId !== null) {
            $ctx['devotee_id'] = $linkId;
        } else {
            $ctx['to_phone'] = devoteeIntlPhone($phone, $ph['country']);
            $ctx['name']     = $devotee_name;
            $ctx['lang']     = 'ta';
        }
        devoteeNotifyEvent('booking.received', $ctx);
    }
} catch (Throwable $e) {
    error_log('[notify] booking.received for booking ' . $bookingId . ' failed: ' . $e->getMessage());
}

sendJson(['success' => true, 'id' => $bookingId], 201);
