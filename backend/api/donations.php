<?php
// backend/api/donations.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

$body = getJsonBody();

$name    = sanitizeText($body['name']    ?? '');
$phone   = sanitizeText($body['phone']   ?? '', 15);
$amount  = filter_var($body['amount']  ?? 0, FILTER_VALIDATE_FLOAT);
$purpose = sanitizeText($body['purpose'] ?? '', 100);
$message = sanitizeText($body['message'] ?? '', 1000);

if ($name === '' || $phone === '') {
    sendError('Name and phone are required');
}

if ($amount === false || $amount <= 0) {
    sendError('A valid positive amount is required');
}

// Basic phone validation — digits only, 7–15 chars
if (!preg_match('/^\d{7,15}$/', $phone)) {
    sendError('Invalid phone number');
}

// A signed-in devotee's pledge carries their account id so it appears in their
// own history. An anonymous pledge is recorded exactly as before.
$db      = getDB();
$linkId  = devoteeLinkId('donations');
$columns = ['name', 'phone', 'amount', 'purpose', 'message'];
$params  = [
    ':name'    => $name,
    ':phone'   => $phone,
    ':amount'  => $amount,
    ':purpose' => $purpose,
    ':message' => $message,
];
if ($linkId !== null) {
    $columns[]             = 'devotee_id';
    $params[':devotee_id'] = $linkId;
}
$stmt = $db->prepare(
    'INSERT INTO donations (' . implode(', ', $columns) . ', created_at)'
    . ' VALUES (' . implode(', ', array_keys($params)) . ', CURRENT_TIMESTAMP)'
);
$stmt->execute($params);

sendJson(['success' => true, 'id' => (int) $db->lastInsertId()], 201);
