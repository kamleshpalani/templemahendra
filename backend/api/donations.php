<?php
// backend/api/donations.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

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

$db   = getDB();
$stmt = $db->prepare(
    'INSERT INTO donations (name, phone, amount, purpose, message, created_at)
          VALUES (:name, :phone, :amount, :purpose, :message, CURRENT_TIMESTAMP)'
);
$stmt->execute([
    ':name'    => $name,
    ':phone'   => $phone,
    ':amount'  => $amount,
    ':purpose' => $purpose,
    ':message' => $message,
]);

sendJson(['success' => true, 'id' => (int) $db->lastInsertId()], 201);
