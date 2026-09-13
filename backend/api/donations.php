<?php
// backend/api/donations.php — POST only

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/devotee_notify.php';
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
// The language the site was showing, so the thank-you and receipt read the same way.
$lang    = devoteeLangFromInput($body['lang'] ?? null);

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

$db      = getDB();
$columns = ['name', 'phone', 'phone_country', 'amount', 'purpose', 'message'];
$params  = [
    ':name'    => $name,
    ':phone'   => $phone,
    ':phone_country' => $ph['country'],
    ':amount'  => $amount,
    ':purpose' => $purpose,
    ':message' => $message,
];
// Migration 008 adds the consent column; before it, pledges save as they always did.
if (publicGuardHasColumn('donations', 'show_name_publicly')) {
    $columns[]                     = 'show_name_publicly';
    $params[':show_name_publicly'] = $showNamePublicly ? 1 : 0;
}
// Migration 009 stores the language, for the receipt the committee sends later.
if (publicGuardHasColumn('donations', 'lang')) {
    $columns[]       = 'lang';
    $params[':lang'] = $lang;
}
$stmt = $db->prepare(
    'INSERT INTO donations (' . implode(', ', $columns) . ', created_at)'
    . ' VALUES (' . implode(', ', array_keys($params)) . ', CURRENT_TIMESTAMP)'
);
$stmt->execute($params);
$donationId = (int) $db->lastInsertId();

// ── Thank them ───────────────────────────────────────────────────────────────
// donation.received, to the phone number the donor gave, in the language the
// site was in. The formal receipt is a separate message the committee sends
// from the admin once the money has actually arrived. Queued, and it never
// changes this response: the pledge is recorded whatever happens to the message.
try {
    if (devoteeNotifyReady()) {
        devoteeNotifyEvent('donation.received', [
            'entity_id' => $donationId,
            'to_phone'  => devoteeIntlPhone($phone, $ph['country']),
            'name'      => $name,
            'lang'      => $lang,
            'vars'      => [
                'receiptNumber'   => devoteeReceiptNumber($donationId),
                'donationAmount'  => devoteeMoneyLabel((float) $amount),
                'donationPurpose' => devoteeDonationPurposeLabel($purpose, $lang),
            ],
        ]);
    }
} catch (Throwable $e) {
    error_log('[notify] donation.received for donation ' . $donationId . ' failed: ' . $e->getMessage());
}

sendJson(['success' => true, 'id' => $donationId], 201);
