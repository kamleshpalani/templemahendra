<?php
// backend/api/contact.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/devotee_notify.php';

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
$messageId = (int) $db->lastInsertId();

contactNotifyOffice($messageId, $name, $phone, $ph['country'], $message);

sendJson(['success' => true], 201);

/**
 * The temple office hears about every message (brief §20, docs/GAP-ANALYSIS.md
 * G-19): one contact.received notification per address in CONTACT_NOTIFY_EMAIL
 * (comma-separated), through the Notification Service, so it is queued,
 * retried and visible in the admin like every other message. The office's
 * copy is written in CONTACT_NOTIFY_LANG (ta or en; English by default, the
 * admin's language). With no address configured nothing is sent, and nothing
 * here can fail the request the visitor is waiting on.
 */
function contactNotifyOffice(int $messageId, string $name, string $phone, ?string $country, string $message): void
{
    $addresses = array_values(array_unique(array_filter(
        array_map(static fn(string $a): string => mb_strtolower(trim($a)), explode(',', envValue('CONTACT_NOTIFY_EMAIL', ''))),
        static fn(string $a): bool => $a !== '' && filter_var($a, FILTER_VALIDATE_EMAIL) !== false
    )));
    if ($messageId < 1 || !$addresses || !devoteeNotifyReady()) return;

    $lang = envValue('CONTACT_NOTIFY_LANG', 'en') === 'ta' ? 'ta' : 'en';
    try {
        $tz   = new DateTimeZone(function_exists('notifyTempleTz') ? notifyTempleTz() : 'Asia/Kolkata');
        $when = (new DateTimeImmutable('now', $tz))->format('j M Y, H:i') . ' ' . ($tz->getName() === 'Asia/Kolkata' ? 'IST' : $tz->getName());
    } catch (Throwable) {
        $when = gmdate('j M Y, H:i') . ' UTC';
    }

    foreach ($addresses as $to) {
        devoteeNotifyEvent('contact.received', [
            'entity_id' => $messageId,
            'to_email'  => $to,
            'name'      => $lang === 'ta' ? 'கோயில் அலுவலகம்' : 'Temple office',
            'lang'      => $lang,
            'vars'      => [
                'senderName'  => $name,
                'senderPhone' => '+' . devoteeIntlPhone($phone, $country),
                'message'     => $message,
                'receivedAt'  => $when,
            ],
        ]);
    }
}
