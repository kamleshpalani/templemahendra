<?php
/**
 * backend/includes/notify/policy.php — which channels a message may use for
 * one recipient (docs/registration/SPEC.md §6, docs/notifications/SPEC.md §5.4).
 *
 * This is the part of the system that keeps faith with families, so it is one
 * function with the rules in the order the spec gives them, and the first rule
 * that applies wins. Every "no" carries a short reason that is stored on the
 * delivery, so the committee can see why a family did not get a message
 * instead of guessing.
 */

require_once __DIR__ . '/consent.php';

/**
 * Skip reasons that come from the family's own choice. A delivery can wait in
 * the queue for hours (a recipient-timezone campaign, a retry backlog); a
 * family that unsubscribes meanwhile has said no, so these are checked again
 * at dispatch (queue.php).
 */
const NOTIFY_CONSENT_REASONS = ['no consent', 'unsubscribed'];

/**
 * channel => ['status' => 'queued'|'skipped', 'reason' => ?string]
 *
 * $recipient is notifyRecipientFromDevotee()'s shape (or a guest's):
 *   email, phone, consent (bool), unsubscribed (bool), and 'test' => true for
 *   an admin's test send to an address they typed.
 *
 * $fallbacks (the event catalogue's, e.g. ['whatsapp' => 'sms']) is applied
 * when a channel is skipped because its provider is not configured: the
 * fallback channel is then decided by the same rules and added to the result
 * with 'fallbackFor' => the channel it stands in for — unless it was requested
 * in its own right, in which case its own decision stands.
 */
function notifyAllowedChannels(array $requested, string $category, string $priority, array $recipient, bool $isCampaign, array $fallbacks = []): array
{
    // 1. Only the temple's channels. A retired or unknown one is dropped before
    //    any rule is asked about it, so it never becomes a delivery row.
    $requested = array_values(array_unique(array_filter($requested, static fn($c): bool => in_array($c, NOTIFY_CHANNELS, true))));
    $out = [];
    foreach ($requested as $channel) {
        if (isset($out[$channel])) continue;
        $out[$channel] = notifyChannelDecision($channel, $category, $priority, $recipient, $isCampaign);

        $fallback = $fallbacks[$channel] ?? null;
        if ($out[$channel]['reason'] === 'not configured'
            && is_string($fallback) && in_array($fallback, NOTIFY_CHANNELS, true)
            && !in_array($fallback, $requested, true) && !isset($out[$fallback])) {
            $out[$fallback] = notifyChannelDecision($fallback, $category, $priority, $recipient, $isCampaign) + ['fallbackFor' => $channel];
        }
    }
    return $out;
}

/**
 * One channel through rules 2–6.
 *
 * $isCampaign is part of the signature every caller already passes; no rule
 * depends on it any more, because consent is the same for an automated update
 * and a committee broadcast.
 */
function notifyChannelDecision(string $channel, string $category, string $priority, array $recipient, bool $isCampaign): array
{
    $skip = static fn(string $reason): array => ['status' => 'skipped', 'reason' => $reason];
    if (!in_array($channel, NOTIFY_CHANNELS, true)) return $skip('unknown channel');

    $priority     = in_array($priority, NOTIFY_PRIORITIES, true) ? $priority : 'normal';
    $needsConsent = notifyCategoryNeedsConsent($category);

    // 2. Somewhere to send it.
    if ($channel === 'email' && !filter_var((string) ($recipient['email'] ?? ''), FILTER_VALIDATE_EMAIL)) return $skip('no email');
    if (($channel === 'whatsapp' || $channel === 'sms') && strlen(preg_replace('/\D+/', '', (string) ($recipient['phone'] ?? '')) ?? '') < 7) return $skip('no phone');

    // 3. Something to send it with.
    if (!notifyProviderFor($channel)->isConfigured()) return $skip('not configured');

    // 4. Consent. A booking or donation message is the family's own business
    //    and always goes; an update needs the tick box on the registration.
    //    Unsubscribed is checked first because it is the more precise answer:
    //    an unsubscribed family has no consent either. A guest (a booking by
    //    phone) never gave consent. An admin's test send to the address they
    //    typed is the one exception: they asked for it.
    if ($needsConsent && empty($recipient['test'])) {
        if (!empty($recipient['unsubscribed'])) return $skip('unsubscribed');
        if (empty($recipient['consent'])) return $skip('no consent');
    }

    // 5. SMS costs the temple money and interrupts; routine news does not justify it.
    if ($channel === 'sms' && $priority === 'normal' && in_array(notifyCategoryKind($category), ['informational', 'promotional'], true)) {
        return $skip('sms reserved for important messages');
    }

    // 6.
    return ['status' => 'queued', 'reason' => null];
}
