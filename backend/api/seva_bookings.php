<?php
// backend/api/seva_bookings.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_notify.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/booking_details.php';

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
// The language the site was showing, so the acknowledgement reads the same way.
$lang           = devoteeLangFromInput($body['lang'] ?? null);

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
    $zone = new DateTimeZone('Asia/Kolkata');
    $d = DateTime::createFromFormat('!Y-m-d', $preferred_date, $zone);
    if ($d && $d->format('Y-m-d') === $preferred_date) {
        // Must not be in the past
        if ($d >= new DateTime('today', $zone)) {
            $dateValue = $preferred_date;
        }
    }
    if ($dateValue === null) sendJson(['error'=>'Choose today or a future date.', 'fields'=>['preferred_date'=>'Choose today or a future date.']], 422);
}

// A valid booking reaches the office and costs a message to the devotee, so
// saved bookings have their own, tighter limit.
if (!bookingDetailsReady()) sendError('Booking updates are not installed. Please contact the temple office.', 503);
$db = getDB();
$serviceQuery = $db->prepare('SELECT * FROM sevas WHERE id=? AND is_active=1');
$serviceQuery->execute([$seva_id]);
$service = $serviceQuery->fetch();
if (!$service) sendError('Choose an available seva.', 422);
$details = bookingValidateDetails($body, $service);
if ($details['fields']) sendJson(['error'=>'Please correct the booking details.', 'fields'=>$details['fields']], 422);
$seva_name = $lang === 'ta' ? $service['name_ta'] : $service['name_en'];
publicGuardLimit('seva-booking-saved');

// ── Insert ────────────────────────────────────────────────────────────────────
$db       = getDB();
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
// Migration 009 stores the language, so the office's confirmation and the
// reminder the evening before are written in it too.
if (publicGuardHasColumn('seva_bookings', 'lang')) {
    $columns[]      = 'lang';
    $params[':lang'] = $lang;
}
$stmt = $db->prepare(
    'INSERT INTO seva_bookings (' . implode(', ', $columns) . ')'
    . ' VALUES (' . implode(', ', array_keys($params)) . ')'
);
$db->beginTransaction();
try {
    $stmt->execute($params);
    $bookingId = (int) $db->lastInsertId();
    bookingStoreDetails($db, $bookingId, $details['values']);
    $db->prepare('UPDATE seva_bookings SET amount=? WHERE id=?')->execute([
        (float)$service['amount'] > 0 ? number_format((float)$service['amount'] + (float)$details['values']['delivery_fee'], 2, '.', '') : null, $bookingId,
    ]);
    $db->commit();
} catch (Throwable $e) {
    if ($db->inTransaction()) $db->rollBack();
    throw $e;
}

// ── Acknowledge it ───────────────────────────────────────────────────────────
// booking.received, to the phone number the devotee gave, in the language the
// site was in. It is queued, not sent here, and nothing about it can change
// this response — the booking is already saved, and a devotee must never be
// told it failed because a message did.
try {
    if (devoteeNotifyReady()) {
        $l         = devoteeCopyLang($lang);
        $sevaLabel = $seva_name;
        if ($seva_id !== null) {
            $s = $db->prepare('SELECT name_ta, name_en FROM sevas WHERE id = :id');
            $s->execute([':id' => $seva_id]);
            if ($seva = $s->fetch()) {
                $sevaLabel = trim((string) ($l === 'ta' ? $seva['name_ta'] : $seva['name_en'])) ?: $seva_name;
            }
        }
        devoteeNotifyEvent('booking.received', [
            'entity_id' => $bookingId,
            'to_phone'  => devoteeIntlPhone($phone, $ph['country']),
            'name'      => $devotee_name,
            'lang'      => $lang,
            'vars'      => [
                'bookingNumber' => devoteeBookingNumber($bookingId),
                'sevaName'      => $sevaLabel,
                'bookingDate'   => devoteeBookingDateLabel($dateValue, $l),
            ],
        ]);
    }
} catch (Throwable $e) {
    error_log('[notify] booking.received for booking ' . $bookingId . ' failed: ' . $e->getMessage());
}

sendJson(['success' => true, 'id' => $bookingId, 'booking_number' => devoteeBookingNumber($bookingId),
    'payment_status' => 'UNPAID', 'status' => 'pending'], 201);
