<?php
// backend/api/seva_bookings.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

$body = getJsonBody();

$devotee_name   = sanitizeText($body['devotee_name']    ?? '');
$phone          = sanitizeText($body['phone']           ?? '', 15);
$seva_name      = sanitizeText($body['seva_name']       ?? '');
$seva_id        = isset($body['seva_id']) && is_numeric($body['seva_id'])
                    ? (int) $body['seva_id'] : null;
$preferred_date = $body['preferred_date'] ?? null;
$message        = sanitizeText($body['message']         ?? '', 1000);

// ── Validation ───────────────────────────────────────────────────────────────
if ($devotee_name === '' || strlen($devotee_name) < 2) {
    sendError('Please enter your name');
}
if (!preg_match('/^\d{7,15}$/', $phone)) {
    sendError('Please enter a valid phone number (digits only)');
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

// ── Insert ────────────────────────────────────────────────────────────────────
$db   = getDB();
$stmt = $db->prepare(
    'INSERT INTO seva_bookings
           (devotee_name, phone, seva_id, seva_name, preferred_date, message)
     VALUES (:devotee_name, :phone, :seva_id, :seva_name, :preferred_date, :message)'
);
$stmt->execute([
    ':devotee_name'   => $devotee_name,
    ':phone'          => $phone,
    ':seva_id'        => $seva_id,
    ':seva_name'      => $seva_name,
    ':preferred_date' => $dateValue,
    ':message'        => $message !== '' ? $message : null,
]);

sendJson(['success' => true, 'id' => (int) $db->lastInsertId()], 201);
