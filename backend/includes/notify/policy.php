<?php
/**
 * backend/includes/notify/policy.php — which channels a message may use for
 * one recipient (SPEC §5.4).
 *
 * This is the part of the system that keeps faith with devotees, so it is one
 * function with the rules in the order the spec gives them, and the first rule
 * that applies wins. Every "no" carries a short reason that is stored on the
 * delivery, so the committee can see why a devotee did not get a message
 * instead of guessing.
 */

require_once __DIR__ . '/prefs.php';

/**
 * channel => ['status' => 'queued'|'sent'|'skipped', 'reason' => ?string]
 *
 * $recipient is notifyRecipientFromDevotee()'s shape. Two optional keys are read
 * as well: 'devices' (active push devices; notifyRecipientFromDevotee fills it)
 * and 'deliver_after' (a UTC time: an in-app message held until then is queued
 * rather than visible at once).
 *
 * $fallbacks (the event catalogue's, e.g. ['whatsapp' => 'sms']) is applied
 * when a channel is skipped because its provider is not configured: the
 * fallback channel is then decided by the same rules and added to the result
 * with 'fallbackFor' => the channel it stands in for — unless it was requested
 * in its own right, in which case its own decision stands.
 */
function notifyAllowedChannels(array $requested, string $category, string $priority, array $recipient, bool $isCampaign, array $fallbacks = []): array
{
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

/** One channel through rules 1–8. */
function notifyChannelDecision(string $channel, string $category, string $priority, array $recipient, bool $isCampaign): array
{
    $skip = static fn(string $reason): array => ['status' => 'skipped', 'reason' => $reason];

    $kind       = notifyCategoryKind($category);
    $mutable    = in_array($kind, NOTIFY_MUTABLE_KINDS, true);
    $priority   = in_array($priority, NOTIFY_PRIORITIES, true) ? $priority : 'normal';
    $urgentPlus = $priority === 'urgent' || $priority === 'emergency';
    $isGuest    = empty($recipient['devotee_id']);
    // Guests have no preferences: every toggle counts as on, nothing is muted,
    // and promotional is never allowed (there is no consent to point to).
    $prefs      = $isGuest ? null : (is_array($recipient['prefs'] ?? null) ? $recipient['prefs'] : notifyPrefsFromRow(null, null));
    $toggleOn   = static fn(string $c): bool => $prefs === null || !isset($prefs['channels'][$c]) || (bool) $prefs['channels'][$c];

    // 1. In-app lives in the account itself.
    if ($channel === 'inapp') {
        if ($isGuest) return $skip('no account');
        if (!$toggleOn('inapp') && $mutable && !$urgentPlus) return $skip('turned off');
        $after = $recipient['deliver_after'] ?? null;
        $held  = is_string($after) && $after !== '' && $after > notifyNow();
        return ['status' => $held ? 'queued' : 'sent', 'reason' => null];
    }

    // 2. Somewhere to send it.
    if ($channel === 'email' && !filter_var((string) ($recipient['email'] ?? ''), FILTER_VALIDATE_EMAIL)) return $skip('no email');
    if (($channel === 'whatsapp' || $channel === 'sms') && strlen(preg_replace('/\D+/', '', (string) ($recipient['phone'] ?? '')) ?? '') < 7) return $skip('no phone');
    if ($channel === 'push' && (int) ($recipient['devices'] ?? 0) < 1) return $skip('no device');

    // 3. Something to send it with.
    if (!notifyProviderFor($channel)->isConfigured()) return $skip('not configured');

    // 4. Consent the kind of message needs. An admin's test send to their own
    //    address (recipient 'test') is the one exception: they asked for it.
    $consented = !empty($recipient['test']);
    if ($kind === 'promotional' && !$consented) {
        if ($isGuest || empty($prefs['promotional'])) return $skip('no promotional consent');
        if (($channel === 'whatsapp' || $channel === 'sms') && empty($recipient['phone_verified'])) return $skip('phone not verified');
        if ($channel === 'email' && empty($recipient['email_verified'])) return $skip('email not verified');
    }
    if ($kind === 'informational' && $isCampaign && $channel === 'email' && empty($recipient['email_verified'])) {
        return $skip('email not verified');
    }
    if ($channel === 'email' && $mutable && !$isGuest && !empty($prefs['unsubscribed'])) return $skip('unsubscribed');

    // 5. The devotee's switch for the channel. Security email always goes (it is
    //    how an account is recovered); an emergency ignores every switch except
    //    WhatsApp's, because WhatsApp opt-in is Meta's rule, not ours.
    if (!$toggleOn($channel)) {
        $overridden = ($kind === 'security' && $channel === 'email') || ($kind === 'critical' && $channel !== 'whatsapp');
        if (!$overridden) return $skip('turned off');
    }

    // 6. A muted category, unless the message is urgent enough to break through.
    if ($mutable && !$urgentPlus && in_array($category, (array) ($prefs['muted'] ?? []), true)) return $skip('muted');

    // 7. SMS costs the temple money and interrupts; routine news does not justify it.
    if ($channel === 'sms' && $priority === 'normal' && $mutable) return $skip('sms reserved for important messages');

    // 8.
    return ['status' => 'queued', 'reason' => null];
}
