<?php
/**
 * backend/includes/contact_notify.php — telling the temple office about a
 * contact-form enquiry (brief §20 "contact form admin notification", §21
 * "email notification"; test case E2E-040).
 *
 * The office address comes from CONTACT_NOTIFY_EMAIL — one address, or several
 * separated by commas. Each one gets its own notification through the
 * Notification Service (includes/notify.php), as the event `contact.received`
 * under the transactional `office` category (migration 019), so no
 * devotee-consent rule applies: the recipient is the temple itself, not a
 * family. The worker (bin/notify_worker.php) sends it like every other email.
 *
 * When the variable is unset the enquiry is still saved to Admin → Messages
 * and one line is logged, so a forgotten setting never loses a message and
 * never fails the visitor's request.
 */

require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/devotee_notify.php';

/** The office addresses, validated and deduplicated; [] when none is configured. */
function contactNotifyEmails(): array
{
    $out = [];
    foreach (explode(',', envValue('CONTACT_NOTIFY_EMAIL', '')) as $raw) {
        $e = trim($raw);
        if ($e === '' || !filter_var($e, FILTER_VALIDATE_EMAIL)) continue;
        $out[mb_strtolower($e)] = $e;
    }
    return array_values($out);
}

/** The language the office alert is written in: CONTACT_NOTIFY_LANG, 'en' unless it says 'ta'. */
function contactNotifyLang(): string
{
    return envValue('CONTACT_NOTIFY_LANG', 'en') === 'ta' ? 'ta' : 'en';
}

/** A stored E.164 number ("919876543210") as the office reads it: "+91 98765 43210" for India, "+…" elsewhere. */
function contactDisplayPhone(string $digits): string
{
    $d = preg_replace('/\D+/', '', $digits) ?? '';
    if ($d === '') return '';
    if (strlen($d) === 12 && str_starts_with($d, '91')) {
        return '+91 ' . substr($d, 2, 5) . ' ' . substr($d, 7);
    }
    return '+' . $d;
}

/** "22 Sep 2026, 9:40 pm IST" — the moment the enquiry arrived, on the temple's clock. */
function contactReceivedAtLabel(): string
{
    return (new DateTime('now', new DateTimeZone('Asia/Kolkata')))->format('j M Y, g:i a') . ' IST';
}

/**
 * Queue the office alert for one saved enquiry. $m holds the stored row
 * (name, phone, email, subject, message). Never throws. Returns the number
 * of addresses a notification was created for.
 */
function contactNotifyReceived(int $messageId, array $m): int
{
    $to = contactNotifyEmails();
    if ($to === []) {
        error_log("[contact] enquiry #{$messageId} was saved; CONTACT_NOTIFY_EMAIL is not set, so nobody was emailed");
        return 0;
    }
    $lang    = contactNotifyLang();
    $subject = trim((string) ($m['subject'] ?? ''));
    $email   = trim((string) ($m['email'] ?? ''));
    $vars = [
        'senderName'  => trim((string) ($m['name'] ?? '')),
        'senderPhone' => contactDisplayPhone((string) ($m['phone'] ?? '')),
        'senderEmail' => $email !== '' ? $email : ($lang === 'ta' ? 'தரப்படவில்லை' : 'not given'),
        'subject'     => $subject !== '' ? $subject : ($lang === 'ta' ? 'இணையதள விசாரணை' : 'Website enquiry'),
        'message'     => (string) ($m['message'] ?? ''),
        'receivedAt'  => contactReceivedAtLabel(),
    ];

    $created = 0;
    foreach ($to as $address) {
        $r = devoteeNotifyEvent('contact.received', [
            'to_email'  => $address,
            'lang'      => $lang,
            'entity_id' => $messageId,
            'vars'      => $vars,
        ]);
        if (is_array($r) && !empty($r['id'])) $created++;
    }
    if ($created === 0) {
        error_log("[contact] enquiry #{$messageId} was saved but the office alert was not queued (notification service unavailable or every address skipped)");
    }
    return $created;
}
