<?php
// backend/api/donations.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_auth.php';
require_once __DIR__ . '/../includes/public_guard.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

// Every post spends an attempt before anything else is looked at, so neither a
// flood of junk nor a bot tripping the honeypot is free.
publicGuardLimit('donation-attempt');

$body = getJsonBody();
publicGuardHoneypotOrContinue($body);

$name    = sanitizeText(is_string($body['name'] ?? null) ? $body['name'] : '');
$ph      = normalizePhone(is_scalar($body['phone'] ?? null) ? $body['phone'] : '', is_string($body['phoneCountry'] ?? null) ? $body['phoneCountry'] : null, true);
$phone   = $ph['phone'];
$amount  = filter_var($body['amount']  ?? 0, FILTER_VALIDATE_FLOAT);
$purpose = sanitizeText(is_string($body['purpose'] ?? null) ? $body['purpose'] : '', 100);
$message = sanitizeText(is_string($body['message'] ?? null) ? $body['message'] : '', 1000);
// Only an explicit yes puts a donor's name on the public thank-you list.
$showNamePublicly = publicGuardConsent($body['showNamePublicly'] ?? null);

if ($name === '' || $phone === '') {
    sendError('Name and phone are required');
}

if ($amount === false || $amount <= 0) {
    sendError('A valid positive amount is required');
}

if ($ph['error'] !== '') {
    sendError($ph['error']);
}

// A valid pledge still costs a message to the donor, so saved pledges have
// their own, tighter limit.
publicGuardLimit('donation-saved');

// A signed-in devotee's pledge carries their account id so it appears in their
// own history. An anonymous pledge is recorded exactly as before.
$db      = getDB();
$linkId  = devoteeLinkId('donations');
$columns = ['name', 'phone', 'phone_country', 'amount', 'purpose', 'message'];
$params  = [
    ':name'    => $name,
    ':phone'   => $phone,
    ':phone_country' => $ph['country'],
    ':amount'  => $amount,
    ':purpose' => $purpose,
    ':message' => $message,
];
if ($linkId !== null) {
    $columns[]             = 'devotee_id';
    $params[':devotee_id'] = $linkId;
}
// Migration 008 adds the consent column; before it, pledges save as they always did.
if (publicGuardHasColumn('donations', 'show_name_publicly')) {
    $columns[]                     = 'show_name_publicly';
    $params[':show_name_publicly'] = $showNamePublicly ? 1 : 0;
}
$stmt = $db->prepare(
    'INSERT INTO donations (' . implode(', ', $columns) . ', created_at)'
    . ' VALUES (' . implode(', ', array_keys($params)) . ', CURRENT_TIMESTAMP)'
);
$stmt->execute($params);
$donationId = (int) $db->lastInsertId();

// ── Thank them ───────────────────────────────────────────────────────────────
// donation.received, to the account when signed in or to the guest's phone.
// The formal receipt is a separate message the committee sends from the admin
// once the money has actually arrived. Queued, and it never changes this
// response: the pledge is recorded whatever happens to the message.
try {
    if (devoteeNotifyReady()) {
        $lang = $linkId !== null ? devoteeNotifyLang($linkId) : 'ta';
        $ctx  = [
            'entity_id' => $donationId,
            'vars'      => [
                'receiptNumber'   => devoteeReceiptNumber($donationId),
                'donationAmount'  => devoteeMoneyLabel((float) $amount),
                'donationPurpose' => devoteeDonationPurposeLabel($purpose, $lang),
            ],
        ];
        if ($linkId !== null) {
            $ctx['devotee_id'] = $linkId;
        } else {
            $ctx['to_phone'] = devoteeIntlPhone($phone, $ph['country']);
            $ctx['name']     = $name;
            $ctx['lang']     = 'ta';
        }
        devoteeNotifyEvent('donation.received', $ctx);
    }
} catch (Throwable $e) {
    error_log('[notify] donation.received for donation ' . $donationId . ' failed: ' . $e->getMessage());
}

sendJson(['success' => true, 'id' => $donationId], 201);
