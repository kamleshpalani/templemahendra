<?php
/**
 * backend/api/registrations.php — POST /api/registrations, the public family
 * registration form (docs/registration/SPEC.md §5).
 *
 * A family registers once, with no password and no sign-in. The rules live in
 * includes/registration.php so the committee's admin applies the same ones.
 *
 * Every successful answer is exactly {"success": true} with 201: a new family, a
 * phone number that is already registered (saved and flagged for the committee,
 * never revealed to the person typing) and a bot that filled the honeypot all
 * look the same, so the form cannot be used to find out who is registered.
 */

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/public_guard.php';
require_once __DIR__ . '/../includes/devotee_notify.php';
require_once __DIR__ . '/../includes/registration.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    sendError('Method not allowed', 405);
}

// Every post spends an attempt before anything else is looked at, so neither a
// flood of junk nor a bot tripping the honeypot is free.
publicGuardLimit('registration-attempt');

$body = getJsonBody();
publicGuardHoneypotOrContinue($body);

// Without migration 009 there is nowhere to keep the family or the consent, and
// saving the rest would quietly lose what the devotee agreed to.
if (!registrationReady()) {
    sendJson(['error' => 'Registration is not available on this site yet.', 'code' => 'registration_disabled'], 503);
}

$checked = registrationValidate($body);
if ($checked['errors']) {
    sendJson(['error' => REG_FIELDS_ERROR, 'fields' => $checked['errors']], 422);
}
$v = $checked['values'];

// A registration reaches the committee and may send a confirmation, so saved
// registrations have their own, tighter limit than attempts.
publicGuardLimit('registration-saved');

$db = getDB();
$id = registrationCreate($db, $v);

// ── Confirm it ───────────────────────────────────────────────────────────────
// Only to a family that agreed to hear from the temple, and only after the
// registration is committed. Queued, not sent here, and nothing about it can
// change this response: the family is already registered. The output buffer
// keeps a warning printed while the notification service loads (on a host with
// display_errors on) from landing in front of the JSON the form is waiting for.
// familyCount counts the registrant, so a family that added nobody is 1.
if ($v['consent']) {
    ob_start();
    try {
        devoteeNotifyEvent('registration.received', [
            'devotee_id' => $id,
            'entity_id'  => $id,
            'vars'       => ['familyCount' => count($v['members']) + 1],
        ]);
    } catch (Throwable $e) {
        error_log('[notify] registration.received for registration ' . $id . ' failed: ' . $e->getMessage());
    } finally {
        ob_end_clean();
    }
}

sendJson(['success' => true], 201);
