<?php
/**
 * backend/includes/devotee_notify.php — telling a devotee something from a form
 * or the admin.
 *
 * The family registration, seva booking and donation forms and the admin's
 * booking and donation pages send messages through the Notification Service
 * (backend/includes/notify.php). This file holds what they share: whether the
 * service is available, sending an event without ever failing the request, and
 * the pieces every message is worded from (booking and receipt numbers,
 * amounts, dates, purposes, phone numbers, the language to write in).
 *
 * Including it costs nothing: the service itself loads only when a message is
 * about to be sent.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';

/**
 * True when the Notification Service can be used: its code loads and its
 * migrations have been applied. Loaded lazily, because most requests that
 * include this file never notify anyone.
 *
 * When this is false the callers simply send nothing, so an install that has
 * not run the notification migrations keeps working.
 */
function devoteeNotifyReady(): bool
{
    static $ready = null;
    if ($ready !== null) return $ready;
    try {
        require_once __DIR__ . '/notify.php';
        return $ready = notifyTablesExist();
    } catch (Throwable $e) {
        error_log('[notify] the notification service could not be loaded: ' . $e->getMessage());
        return $ready = false;
    }
}

/**
 * notifyEvent(), or null when the service is not available. Never throws: a
 * message is never a reason for a registration, booking or donation to fail.
 */
function devoteeNotifyEvent(string $event, array $ctx): ?array
{
    if (!devoteeNotifyReady()) return null;
    try {
        return notifyEvent($event, $ctx);
    } catch (Throwable $e) {
        error_log("[notify] {$event} failed: " . $e->getMessage());
        return null;
    }
}

/**
 * The language a form was sent in. The site has two; anything that is not
 * exactly 'en' is Tamil, the site's default.
 */
function devoteeLangFromInput(mixed $value): string
{
    return $value === 'en' ? 'en' : 'ta';
}

/** The language the temple writes to a registered family in ('ta' until they chose). */
function devoteeNotifyLang(int $devoteeId): string
{
    if ($devoteeId < 1) return 'ta';
    try {
        $stmt = getDB()->prepare('SELECT lang FROM devotees WHERE id = :id');
        $stmt->execute([':id' => $devoteeId]);
        return devoteeLangFromInput($stmt->fetchColumn());
    } catch (Throwable) {
        // Before migration 009 there is no lang column; Tamil is the default.
        return 'ta';
    }
}

/** 'ta' or 'en' — the two languages the site's own wording (dates, labels) exists in. */
function devoteeCopyLang(string $lang): string
{
    return $lang === 'ta' ? 'ta' : 'en';
}

/**
 * The booking number devotees and the office both quote: "B-000091". Padded so
 * it reads as a reference rather than a count, and sorts correctly in a list.
 * notifyBookingNumber() in notify/reminders.php must read exactly the same.
 */
function devoteeBookingNumber(int $bookingId): string
{
    return 'B-' . str_pad((string) $bookingId, 6, '0', STR_PAD_LEFT);
}

/** The donation reference printed on acknowledgements and receipts: "D-000012". */
function devoteeReceiptNumber(int $donationId): string
{
    return 'D-' . str_pad((string) $donationId, 6, '0', STR_PAD_LEFT);
}

/**
 * "Rs. 1,001" or "Rs. 501.50". Written out rather than ₹ because the rupee sign
 * turns an SMS into a Unicode message with half the room.
 */
function devoteeMoneyLabel(float $amount): string
{
    $decimals = abs($amount - round($amount)) >= 0.005 ? 2 : 0;
    return 'Rs. ' . number_format($amount, $decimals);
}

/**
 * A donation purpose as the devotee chose it on the Donations page, in their
 * language. The keys and wording mirror the <select> in pages/Donations.jsx.
 * A purpose the form does not offer (a bulk import, say) is shown as stored.
 */
function devoteeDonationPurposeLabel(?string $purpose, string $lang): string
{
    $l = devoteeCopyLang($lang);
    $labels = [
        'kumbabhishekam' => ['ta' => 'கும்பாபிஷேகம்', 'en' => 'Kumbabhishekam'],
        'annadanam_hall' => ['ta' => 'அன்னதான கூடம் கட்டுமானம்', 'en' => 'Annadanam Hall construction'],
        'annadanam'      => ['ta' => 'அன்னதானம்', 'en' => 'Annadanam'],
        'abhishekam'     => ['ta' => 'அபிஷேகம்', 'en' => 'Abhishekam'],
        'festival'       => ['ta' => 'திருவிழா நிதி', 'en' => 'the Festival Fund'],
        'maintenance'    => ['ta' => 'கோயில் பராமரிப்பு', 'en' => 'Temple Maintenance'],
        'other'          => ['ta' => 'கோயிலின் பிற தேவைகள்', 'en' => 'the temple\'s other needs'],
        ''               => ['ta' => 'கோயில் பொது நிதி', 'en' => 'the temple\'s general fund'],
    ];
    $key = trim((string) $purpose);
    return $labels[$key][$l] ?? $key;
}

/**
 * "20 செப்டம்பர் 2026" / "20 Sep 2026", or a polite placeholder when no date was
 * chosen. Call it only once devoteeNotifyReady() is true: the date wording
 * comes from the Notification Service.
 */
function devoteeBookingDateLabel(?string $ymd, string $lang): string
{
    $l = devoteeCopyLang($lang);
    if ($ymd === null || !isValidDate((string) $ymd)) {
        return $l === 'ta' ? 'தேதி உறுதி செய்யப்பட வேண்டும்' : 'a date to be confirmed';
    }
    return notifyFormatDate((string) $ymd, $l);
}

/**
 * A phone number as international digits for WhatsApp and SMS. Numbers saved
 * before the site asked for a country were ten Indian digits with no code; the
 * reminder worker treats them the same way.
 */
function devoteeIntlPhone(?string $phone, ?string $country): string
{
    $digits = preg_replace('/\D+/', '', (string) $phone) ?? '';
    if (strlen($digits) === 11 && $digits[0] === '0' && in_array($country, [null, '', 'IN'], true)) $digits = substr($digits, 1);
    if (strlen($digits) === 10 && in_array($country, [null, '', 'IN'], true)) $digits = '91' . $digits;
    return $digits;
}
