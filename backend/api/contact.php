<?php
// backend/api/contact.php — POST only.
//
// Brief §21: name, email, phone, subject and message. Name, phone and message
// are required; email and subject are optional (migration 019 adds their
// columns — an older database still stores the enquiry without them). Every
// post spends an attempt before anything is looked at, the honeypot answers
// bots with a fake success, and once saved the temple office is told through
// the Notification Service (includes/contact_notify.php, brief §20, E2E-040).

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/contact_notify.php';

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
$email   = mb_substr(trim(is_string($body['email'] ?? null) ? $body['email'] : ''), 0, 190);
$subject = sanitizeText(is_string($body['subject'] ?? null) ? $body['subject'] : '', 200);
$message = sanitizeText(is_string($body['message'] ?? null) ? $body['message'] : '', 2000);

if ($name === '' || $phone === '' || $message === '') {
    sendError('Name, phone, and message are required');
}

if ($ph['error'] !== '') {
    sendError($ph['error']);
}

// Optional, but when given it has to be an address the office can reply to.
if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    sendError('Please enter a valid email address, or leave it blank.');
}

// Messages land in the committee's inbox; a handful an hour is more than any
// one devotee needs.
publicGuardLimit('contact-saved');

$db = getDB();
$hasExtra = publicGuardHasColumn('contact_messages', 'email') && publicGuardHasColumn('contact_messages', 'subject');
if ($hasExtra) {
    $stmt = $db->prepare(
        'INSERT INTO contact_messages (name, phone, phone_country, email, subject, message, created_at)
              VALUES (:name, :phone, :phone_country, :email, :subject, :message, CURRENT_TIMESTAMP)'
    );
    $stmt->execute([
        ':name' => $name, ':phone' => $phone, ':phone_country' => $ph['country'],
        ':email' => $email !== '' ? $email : null, ':subject' => $subject !== '' ? $subject : null,
        ':message' => $message,
    ]);
} else {
    $stmt = $db->prepare(
        'INSERT INTO contact_messages (name, phone, phone_country, message, created_at)
              VALUES (:name, :phone, :phone_country, :message, CURRENT_TIMESTAMP)'
    );
    $stmt->execute([':name' => $name, ':phone' => $phone, ':phone_country' => $ph['country'], ':message' => $message]);
}
$messageId = (int) $db->lastInsertId();

// The office alert never fails the visitor's request (contact_notify.php).
contactNotifyReceived($messageId, [
    'name' => $name, 'phone' => $phone, 'email' => $email, 'subject' => $subject, 'message' => $message,
]);

sendJson(['success' => true], 201);
