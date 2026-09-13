<?php
// backend/api/contact.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

// Every post spends an attempt before anything else is looked at, so neither a
// flood of junk nor a bot tripping the honeypot is free.
publicGuardLimit('contact-attempt');

$body = getJsonBody();
publicGuardHoneypotOrContinue($body);

$name    = sanitizeText(is_string($body['name'] ?? null) ? $body['name'] : '');
$ph      = normalizePhone(is_scalar($body['phone'] ?? null) ? $body['phone'] : '', is_string($body['phoneCountry'] ?? null) ? $body['phoneCountry'] : null, true);
$phone   = $ph['phone'];
$message = sanitizeText(is_string($body['message'] ?? null) ? $body['message'] : '', 2000);

if ($name === '' || $phone === '' || $message === '') {
    sendError('Name, phone, and message are required');
}

if ($ph['error'] !== '') {
    sendError($ph['error']);
}

// Messages land in the committee's inbox; a handful an hour is more than any
// one devotee needs.
publicGuardLimit('contact-saved');

$db   = getDB();
$stmt = $db->prepare(
    'INSERT INTO contact_messages (name, phone, phone_country, message, created_at)
          VALUES (:name, :phone, :phone_country, :message, CURRENT_TIMESTAMP)'
);
$stmt->execute([':name' => $name, ':phone' => $phone, ':phone_country' => $ph['country'], ':message' => $message]);

sendJson(['success' => true], 201);
