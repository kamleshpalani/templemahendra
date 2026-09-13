<?php
/**
 * backend/includes/notify/consent.php — whether a registered family has agreed
 * to temple updates, and the unsubscribe link that withdraws it.
 *
 * Consent is recorded on the registration itself (migration 009):
 *
 *   devotees.updates_consent_at  when the family agreed — ticked on the
 *                                registration form, or recorded by the committee
 *   devotees.unsubscribed_at     when they withdrew it from a link in a message.
 *                                It wins over the consent until the committee
 *                                records consent again (which clears it).
 *
 * One consent covers festival, pooja and temple announcements on every channel
 * the temple uses (email, WhatsApp, SMS). Messages about a family's own seva
 * booking or donation are not "updates": they need no consent, and an
 * unsubscribe does not stop them.
 *
 * Both are timestamps rather than flags, because a consent record has to be
 * able to say WHEN the family agreed or said no.
 */

require_once __DIR__ . '/categories.php';

/**
 * ['consent' => bool, 'unsubscribed' => bool, 'consentAt' => ?iso, 'unsubscribedAt' => ?iso,
 *  'email' => ?string, 'phone' => ?string, 'active' => bool]
 * or null when there is no such registration.
 */
function notifyConsentState(int $devoteeId): ?array
{
    if ($devoteeId < 1 || !notifyTablesExist()) return null;
    $stmt = getDB()->prepare(
        'SELECT email, phone, is_active, updates_consent_at, unsubscribed_at FROM devotees WHERE id = :id'
    );
    $stmt->execute([':id' => $devoteeId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return [
        'consent'        => $row['updates_consent_at'] !== null && $row['unsubscribed_at'] === null,
        'unsubscribed'   => $row['unsubscribed_at'] !== null,
        'consentAt'      => notifyIso($row['updates_consent_at']),
        'unsubscribedAt' => notifyIso($row['unsubscribed_at']),
        'email'          => $row['email'] !== null && $row['email'] !== '' ? (string) $row['email'] : null,
        'phone'          => $row['phone'] !== null && $row['phone'] !== '' ? (string) $row['phone'] : null,
        'active'         => (int) $row['is_active'] === 1,
    ];
}

/**
 * Withdraw a family's consent to temple updates, as an unsubscribe link does.
 *
 * Idempotent: the FIRST unsubscribe time is kept, so a mail provider retrying
 * an RFC 8058 one-click post, or a devotee pressing the button twice, changes
 * nothing. Returns false only when there is no such registration.
 *
 * @throws RuntimeException when the notification tables are missing
 */
function notifyUnsubscribe(int $devoteeId): bool
{
    if (!notifyTablesExist()) throw new RuntimeException('Notifications are not available on this site yet.');
    if ($devoteeId < 1) return false;
    $db = getDB();
    $db->prepare('UPDATE devotees SET unsubscribed_at = COALESCE(unsubscribed_at, :now) WHERE id = :id')
       ->execute([':now' => notifyNow(), ':id' => $devoteeId]);
    $check = $db->prepare('SELECT 1 FROM devotees WHERE id = :id');
    $check->execute([':id' => $devoteeId]);
    return $check->fetchColumn() !== false;
}

/**
 * A phone number with all but the last four digits hidden, grouped the way it
 * is dialled: "+91 ••••••3210". Enough for a family sharing one inbox or phone
 * to tell whose registration a link belongs to, and no more.
 */
function notifyMaskPhone(?string $phone): string
{
    $digits = preg_replace('/\D+/', '', (string) $phone) ?? '';
    if (strlen($digits) < 7) return '';
    if (strlen($digits) === 12 && str_starts_with($digits, '91')) {
        return '+91 ' . str_repeat('•', 6) . substr($digits, -4);
    }
    return '+' . str_repeat('•', strlen($digits) - 4) . substr($digits, -4);
}
