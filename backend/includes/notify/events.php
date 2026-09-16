<?php
/**
 * backend/includes/notify/events.php — the automated events (SPEC §5.5).
 *
 * A module that wants to tell a family something calls one function with the
 * event's name and what it knows:
 *
 *   notifyEvent('booking.confirmed', ['to_phone' => '919876543210', 'lang' => 'en', 'entity_id' => 91,
 *       'vars' => ['bookingNumber' => 'B-000091', 'sevaName' => 'Abhishekam', 'bookingDate' => '20 Sep 2026']]);
 *
 * The catalogue below decides the template, priority, channels, fallbacks,
 * whether it goes out inside the request, and the dedupe key that makes the
 * same booking confirmed twice notify once. A module never picks channels.
 *
 * Every channel is email, WhatsApp or SMS. Whether a family's consent is needed
 * follows from the template's category (categories.php), not from the event:
 * registration.received is filed under "general", so it reaches only a family
 * that ticked the consent box, and its caller sends it only then.
 *
 * donation.paid, payment.succeeded, payment.failed and payment.refunded belong
 * to online payments (docs/payments/SPEC.md §6): the payments module raises
 * them after its database transaction commits, always for a guest recipient and
 * always with the channels chosen in Admin → Payment Gateway. paymentReference
 * is the Donation or Booking ID for the success events, so a replayed gateway
 * callback or a double payment never sends twice; for payment.failed it is the
 * failed attempt's order id. A receipt resend re-raises donation.paid or
 * payment.succeeded with its own dedupe_key.
 *
 * event.registered, event.cancelled, volunteer.registered and
 * membership.renewal_due have no caller yet — the site has no event
 * registration, volunteer or membership module. They are complete, so the day
 * such a module lands it calls one function.
 */

require_once __DIR__ . '/service.php';

/**
 * event => ['template','priority','channels','fallbacks','sync','dedupe' (pattern or null),
 *           'entity_type','description']
 *
 * Dedupe placeholders: {id} devotee id · {entity_id} · {vars.name} · {ctx.name} ·
 * {recipient} "d<devotee id>", or "p<first 12 of sha1(phone)>" / "e<…(email)>" for a guest.
 */
function notifyEventCatalogue(): array
{
    $e = static fn(string $template, string $priority, array $channels, ?string $dedupe, string $entity, string $description, array $fallbacks = [], bool $sync = false): array => [
        'template' => $template, 'priority' => $priority, 'channels' => $channels, 'fallbacks' => $fallbacks,
        'sync' => $sync, 'dedupe' => $dedupe, 'entity_type' => $entity, 'description' => $description,
    ];
    return [
        // Important rather than normal so the SMS fallback is not held back by the
        // SMS restraint: it is the family's own receipt of what they registered.
        'registration.received'  => $e('registration_received', 'important', ['email', 'whatsapp'], 'devotee:{id}:registered', 'devotee', 'A family registers and agrees to temple updates', ['whatsapp' => 'sms']),
        'booking.received'       => $e('booking_received', 'normal', ['email', 'whatsapp'], 'booking:{entity_id}:received', 'seva_booking', 'The temple receives a seva booking'),
        'booking.confirmed'      => $e('booking_confirmed', 'important', ['email', 'whatsapp'], 'booking:{entity_id}:confirmed', 'seva_booking', 'The committee confirms a seva booking', ['whatsapp' => 'sms']),
        'booking.modified'       => $e('booking_modified', 'important', ['email', 'whatsapp'], 'booking:{entity_id}:modified:{vars.bookingDate}', 'seva_booking', 'A confirmed booking moves to another date'),
        'booking.cancelled'      => $e('booking_cancelled', 'important', ['email', 'whatsapp', 'sms'], 'booking:{entity_id}:cancelled', 'seva_booking', 'A seva booking is cancelled'),
        'booking.completed'      => $e('booking_completed', 'normal', ['email', 'whatsapp'], 'booking:{entity_id}:completed', 'seva_booking', 'A seva is performed'),
        'booking.reminder'       => $e('booking_reminder', 'important', ['whatsapp', 'email'], 'booking:{entity_id}:reminder:{vars.bookingDate}', 'seva_booking', 'The evening before a confirmed seva', ['whatsapp' => 'sms']),
        'donation.received'      => $e('donation_received', 'normal', ['email', 'whatsapp'], 'donation:{entity_id}:received', 'donation', 'The temple records a donation'),
        'donation.receipt'       => $e('donation_receipt', 'important', ['email', 'whatsapp'], 'donation:{entity_id}:receipt:{ctx.sequence}', 'donation', 'The committee sends a donation receipt'),
        'donation.paid'          => $e('donation_paid', 'important', ['email', 'whatsapp', 'sms'], 'donation:{vars.paymentReference}:paid', 'donation', 'An online donation is paid (its first successful payment)'),
        'payment.succeeded'      => $e('payment_success', 'important', ['email', 'whatsapp', 'sms'], 'payment:{vars.paymentReference}:success', 'payment', 'An online seva booking is paid (its first successful payment)'),
        // Email only, and important rather than urgent: a declined card is not an
        // emergency, and the red urgent banner would alarm a devotee who can simply try again.
        'payment.failed'         => $e('payment_failed', 'important', ['email'], 'payment:{vars.paymentReference}:failed', 'payment', 'An online payment attempt fails'),
        'payment.refunded'       => $e('payment_refund', 'important', ['email', 'whatsapp', 'sms'], 'refund:{entity_id}:processed', 'payment_refund', 'A refund of an online payment succeeds'),
        'event.registered'       => $e('event_registered', 'normal', ['email', 'whatsapp'], 'event:{entity_id}:registered:{recipient}', 'event', 'A devotee registers for an event'),
        'event.cancelled'        => $e('event_cancelled', 'important', ['email', 'whatsapp', 'sms'], 'event:{entity_id}:cancelled:{recipient}', 'event', 'An event a devotee registered for is cancelled'),
        'volunteer.registered'   => $e('volunteer_registered', 'normal', ['email'], 'volunteer:{entity_id}:{recipient}', 'volunteer', 'A devotee signs up to volunteer'),
        'membership.renewal_due' => $e('membership_renewal', 'important', ['email', 'whatsapp'], 'membership:{entity_id}:renewal:{vars.renewalDate}', 'membership', 'A membership is due for renewal'),
    ];
}

/** A catalogue dedupe pattern filled from the context, or null when something it needs is missing. */
function notifyEventDedupeKey(string $pattern, array $ctx): ?string
{
    $missing = false;
    $key = preg_replace_callback('/\{([A-Za-z0-9_.]+)\}/', static function (array $m) use ($ctx, &$missing): string {
        $name = $m[1];
        $value = null;
        if ($name === 'id') {
            $value = (int) ($ctx['devotee_id'] ?? 0) ?: null;
        } elseif ($name === 'entity_id') {
            $value = (int) ($ctx['entity_id'] ?? 0) ?: null;
        } elseif ($name === 'recipient') {
            if ((int) ($ctx['devotee_id'] ?? 0) > 0) {
                $value = 'd' . (int) $ctx['devotee_id'];
            } else {
                $digits = preg_replace('/\D+/', '', (string) ($ctx['to_phone'] ?? '')) ?? '';
                $email  = mb_strtolower(trim((string) ($ctx['to_email'] ?? '')));
                $value  = $digits !== '' ? 'p' . substr(sha1($digits), 0, 12) : ($email !== '' ? 'e' . substr(sha1($email), 0, 12) : null);
            }
        } elseif (str_starts_with($name, 'vars.')) {
            $value = $ctx['vars'][substr($name, 5)] ?? null;
        } elseif (str_starts_with($name, 'ctx.')) {
            $value = $ctx[substr($name, 4)] ?? null;
        }
        if (!is_scalar($value) || trim((string) $value) === '') {
            $missing = true;
            return '';
        }
        return trim((string) $value);
    }, $pattern);
    return $missing ? null : $key;
}

/**
 * Fire an automated event. $ctx carries the recipient (devotee_id for a
 * registered family, or to_phone / to_email / name / lang for a booking or
 * donation made by phone), vars, optional secret_vars, entity_id and any
 * extras the dedupe key names (donation.receipt: sequence). $ctx may override
 * channels, priority and dedupe_key, and may pass cta_url, image_url, details,
 * deliver_after and actor through to notify().
 *
 * Returns notify()'s result. Never throws.
 */
function notifyEvent(string $event, array $ctx): array
{
    if (!notifyTablesExist()) return notifyEmptyResult('tables missing');
    try {
        $catalogue = notifyEventCatalogue();
        if (!isset($catalogue[$event])) {
            error_log("[notify] unknown event \"{$event}\"");
            return notifyEmptyResult('unknown event');
        }
        $spec = $catalogue[$event];

        if (array_key_exists('dedupe_key', $ctx)) {
            $dedupe = notifyDedupeKey($ctx['dedupe_key']);
        } elseif ($spec['dedupe'] !== null) {
            $dedupe = notifyEventDedupeKey($spec['dedupe'], $ctx);
            if ($dedupe === null) {
                error_log("[notify] {$event} was not sent: its dedupe key {$spec['dedupe']} needs a value the caller did not give");
                return notifyEmptyResult('missing dedupe context');
            }
        } else {
            $dedupe = null;
        }

        $entityId = $ctx['entity_id'] ?? ($spec['entity_type'] === 'devotee' ? ($ctx['devotee_id'] ?? null) : null);
        $n = [
            'event'       => $event,
            'template'    => $spec['template'],
            'category'    => (string) (notifyTemplateDefaults()[$spec['template']]['category'] ?? 'general'),
            'priority'    => in_array($ctx['priority'] ?? null, NOTIFY_PRIORITIES, true) ? $ctx['priority'] : $spec['priority'],
            'channels'    => isset($ctx['channels']) && (is_array($ctx['channels']) || is_string($ctx['channels'])) ? $ctx['channels'] : $spec['channels'],
            'fallbacks'   => $spec['fallbacks'],
            'sync'        => $spec['sync'],
            'dedupe_key'  => $dedupe,
            'entity_type' => $spec['entity_type'],
            'entity_id'   => $entityId,
        ];
        foreach (['devotee_id', 'to_email', 'to_phone', 'name', 'lang', 'vars', 'secret_vars', 'cta_url', 'image_url', 'details', 'deliver_after', 'actor'] as $k) {
            if (array_key_exists($k, $ctx)) $n[$k] = $ctx[$k];
        }
        return notify($n);
    } catch (Throwable $e) {
        error_log("[notify] notifyEvent({$event}) failed: " . get_class($e) . ': ' . $e->getMessage());
        return notifyEmptyResult('error');
    }
}
