<?php
// backend/api/contact.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

$body = getJsonBody();

$name    = sanitizeText($body['name']    ?? '');
$phone   = sanitizeText($body['phone']   ?? '', 15);
$message = sanitizeText($body['message'] ?? '', 2000);

if ($name === '' || $phone === '' || $message === '') {
    sendError('Name, phone, and message are required');
}

if (!preg_match('/^\d{7,15}$/', $phone)) {
    sendError('Invalid phone number');
}

$db   = getDB();
$stmt = $db->prepare(
    'INSERT INTO contact_messages (name, phone, message, created_at)
          VALUES (:name, :phone, :message, NOW())'
);
$stmt->execute([':name' => $name, ':phone' => $phone, ':message' => $message]);

sendJson(['success' => true], 201);
