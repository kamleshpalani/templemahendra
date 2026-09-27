<?php
/**
 * backend/includes/sponsor_notify.php — the sponsor's confirmation (brief §20).
 *
 * One message per sponsorship, when it becomes PAID: an online pooja
 * donation's first success (payments/store.php paySponsorAssign()) or the
 * committee recording a paid sponsorship in Admin → Sponsors. The event's
 * dedupe key (sponsor:{id}:confirmed) makes a second call a no-op, so a
 * replayed gateway response or a re-save of the form never sends it twice.
 *
 * It goes to the sponsor's e-mail and phone (WhatsApp, SMS as fallback) in
 * Tamil or English, names the pooja, its date, the amount and the payment
 * reference, and says whether the family will be named on the website — the
 * consent they gave, never more.
 *
 * Never throws; returns whether a notification was queued.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/devotee_notify.php';

/** "Rs. 2,001" for rupees (₹ would double an SMS's length), "USD 50.00" otherwise; '' when unknown. */
function sponsorNotifyMoney(?string $amount, ?string $currency): string
{
    if ($amount === null || $amount === '' || !is_numeric($amount)) return '';
    $currency = strtoupper(trim((string) $currency)) ?: 'INR';
    if ($currency === 'INR') {
        $whole = (float) $amount === floor((float) $amount);
        return 'Rs. ' . number_format((float) $amount, $whole ? 0 : 2);
    }
    return $currency . ' ' . number_format((float) $amount, 2);
}

/** "7 Oct 2026" / Tamil month names when the notification helpers are loaded; the ISO date otherwise. */
function sponsorNotifyDate(?string $ymd, string $lang): string
{
    if ($ymd === null || $ymd === '') return '';
    if (!function_exists('notifyFormatDate') && is_file(__DIR__ . '/notify/reminders.php')) {
        require_once __DIR__ . '/notify/reminders.php';
    }
    return function_exists('notifyFormatDate') ? notifyFormatDate($ymd, $lang) : $ymd;
}

/**
 * Queue the confirmation for one sponsor. $lang: the language the sponsor
 * used (an online donation's), else Tamil, the site's default. $db: pass the
 * payment transaction's connection so the message commits (or rolls back)
 * with the sponsorship itself.
 */
function sponsorNotifyConfirmed(int $sponsorId, ?string $lang = null, ?PDO $db = null): bool
{
    try {
        if (!devoteeNotifyReady()) return false;
        $db ??= getDB();
        $hasDonation = function_exists('publicGuardHasColumn') ? publicGuardHasColumn('sponsors', 'donation_id') : true;
        $stmt = $db->prepare(
            'SELECT s.id, s.name, s.family_name, s.email, s.phone, s.amount, s.payment_ref, s.payment_status, s.publish_consent,
                    p.name_ta AS pooja_ta, p.name_en AS pooja_en, p.pooja_date'
            . ($hasDonation ? ', d.amount AS donation_amount, d.currency AS donation_currency' : ', NULL AS donation_amount, NULL AS donation_currency')
            . ' FROM sponsors s
               LEFT JOIN poojas p ON p.id = s.pooja_id'
            . ($hasDonation ? ' LEFT JOIN donations d ON d.id = s.donation_id' : '')
            . ' WHERE s.id = :id'
        );
        $stmt->execute([':id' => $sponsorId]);
        $s = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$s || $s['payment_status'] !== 'PAID') return false;

        $email = trim((string) ($s['email'] ?? ''));
        $phone = preg_replace('/\D+/', '', (string) ($s['phone'] ?? '')) ?? '';
        if ($email === '' && $phone === '') return false; // nobody to tell

        $l = devoteeCopyLang($lang ?? 'ta');
        $other = $l === 'ta' ? 'en' : 'ta';
        $pooja = trim((string) ($s['pooja_' . $l] ?? '')) ?: trim((string) ($s['pooja_' . $other] ?? ''));
        if ($pooja === '') $pooja = $l === 'ta' ? 'பூஜை' : 'pooja';
        $money = sponsorNotifyMoney($s['amount'] !== null ? (string) $s['amount'] : null, 'INR')
            ?: sponsorNotifyMoney($s['donation_amount'] !== null ? (string) $s['donation_amount'] : null, (string) ($s['donation_currency'] ?? 'INR'));
        $shown = trim((string) ($s['family_name'] ?? '')) ?: trim((string) $s['name']);
        $credit = (int) $s['publish_consent'] === 1
            ? ($l === 'ta'
                ? "நீங்கள் ஒப்புக்கொண்டபடி, \"{$shown}\" என்ற பெயர் கோயில் இணையதளத்தில் உபயதாரராகக் குறிப்பிடப்படும்."
                : "As you agreed, \"{$shown}\" will be shown as the sponsor on the temple website.")
            : ($l === 'ta'
                ? 'நீங்கள் கேட்டபடி, உங்கள் பெயர் இணையதளத்தில் குறிப்பிடப்படாது.'
                : 'As you asked, your name will not be shown on the website.');

        $ctx = [
            'entity_id' => $sponsorId,
            'name'      => (string) $s['name'],
            'lang'      => $l,
            'vars'      => [
                'devoteeName'      => (string) $s['name'],
                'poojaName'        => $pooja,
                'poojaDate'        => sponsorNotifyDate($s['pooja_date'] !== null ? (string) $s['pooja_date'] : null, $l) ?: ($l === 'ta' ? 'அறிவிக்கப்படும் நாள்' : 'the announced date'),
                'sponsorAmount'    => $money !== '' ? $money : ($l === 'ta' ? 'அலுவலகப் பதிவின்படி' : 'as recorded by the office'),
                'paymentReference' => trim((string) ($s['payment_ref'] ?? '')) ?: ($l === 'ta' ? 'அலுவலகப் பதிவு' : 'office record'),
                'creditLine'       => $credit,
            ],
        ];
        if ($email !== '' && filter_var($email, FILTER_VALIDATE_EMAIL)) $ctx['to_email'] = $email;
        if (strlen($phone) >= 10) $ctx['to_phone'] = strlen($phone) === 10 ? '91' . $phone : $phone;
        if (!isset($ctx['to_email']) && !isset($ctx['to_phone'])) return false;

        $r = devoteeNotifyEvent('sponsor.confirmed', $ctx);
        return is_array($r) && !empty($r['id']);
    } catch (Throwable $e) {
        error_log("[sponsor] confirmation for sponsor #{$sponsorId} was not queued: " . get_class($e) . ': ' . $e->getMessage());
        return false;
    }
}
