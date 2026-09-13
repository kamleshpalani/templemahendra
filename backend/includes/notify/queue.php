<?php
/**
 * backend/includes/notify/queue.php — the delivery queue, the worker, and what
 * providers tell us afterwards (SPEC §5.7).
 *
 * Shared hosting has no daemons and no Redis, so the queue is a MySQL table and
 * the worker is a cron job that runs once a minute for at most 50 seconds.
 * Three things make that safe:
 *
 *   • A named MySQL lock: two overlapping runs cannot both work.
 *   • Atomic claims: a run marks the rows it will send with its own random
 *     claim_token in one UPDATE, then reads back only those rows. A row can be
 *     claimed by exactly one run.
 *   • Stale-claim recovery: a run that died mid-send (the host killed PHP)
 *     leaves rows "sending"; after ten minutes the next run puts them back.
 *
 * Status only moves forward — queued < sending < sent < delivered < read — and
 * every change writes a notification_delivery_events row, because "why did
 * this devotee not get the message" is the question the committee will ask.
 */

require_once __DIR__ . '/service.php';

const NOTIFY_BACKOFF             = [60, 300, 1800, 7200, 21600];
const NOTIFY_STALE_CLAIM_SECONDS = 600;
const NOTIFY_RATE_DEFAULTS       = ['email' => 60, 'whatsapp' => 80, 'sms' => 30, 'push' => 600];
const NOTIFY_PUSH_BODY_MAX       = 180;
/**
 * Channel-policy reasons that come from the devotee's own choices. A delivery
 * can wait in the queue for hours (a recipient-timezone campaign, a retry
 * backlog); a devotee who unsubscribes or switches a channel off meanwhile has
 * said no, so these are checked again at dispatch.
 */
const NOTIFY_PREFERENCE_REASONS  = ['turned off', 'muted', 'unsubscribed', 'no promotional consent', 'email not verified', 'phone not verified'];

/** Record one step in a delivery's history. Never throws. */
function notifyDeliveryEvent(int $deliveryId, string $event, ?string $detail = null): void
{
    try {
        getDB()->prepare(
            'INSERT INTO notification_delivery_events (delivery_id, event, detail, created_at) VALUES (:d, :e, :x, :now)'
        )->execute([
            ':d'   => $deliveryId,
            ':e'   => mb_substr($event, 0, 24),
            ':x'   => $detail === null || $detail === '' ? null : mb_substr($detail, 0, 500),
            ':now' => notifyNow(),
        ]);
    } catch (Throwable $e) {
        error_log('[notify] could not record a delivery event: ' . $e->getMessage());
    }
}

/**
 * Seconds to wait before attempt n+1, after n attempts: 1 min, 5 min, 30 min,
 * 2 h, then 6 h, each ±10% so a provider outage does not bring every retry back
 * in the same second. A provider's own Retry-After wins when it is longer.
 */
function notifyBackoffSeconds(int $attempts, ?int $retryAfter = null): int
{
    $base   = NOTIFY_BACKOFF[max(0, min(count(NOTIFY_BACKOFF) - 1, $attempts - 1))];
    $jitter = (int) round($base * random_int(-1000, 1000) / 10000);
    return max(max(0, (int) $retryAfter), $base + $jitter);
}

/** Sends per minute a channel may make, from NOTIFY_RATE_<CHANNEL>_PER_MIN. */
function notifyRatePerMinute(string $channel): int
{
    $default = NOTIFY_RATE_DEFAULTS[$channel] ?? 60;
    $value   = notifyEnv('NOTIFY_RATE_' . strtoupper($channel) . '_PER_MIN', (string) $default);
    return ctype_digit($value) && (int) $value > 0 ? (int) $value : $default;
}

function notifyDispatchOutcome(string $status, ?string $reason, bool $recordedOnly = false, ?string $messageId = null): array
{
    return ['status' => $status, 'reason' => $reason, 'recordedOnly' => $recordedOnly, 'providerMessageId' => $messageId];
}

/* ── Dispatch ───────────────────────────────────────────────────────────── */

/**
 * Send one delivery now.
 *
 * A queued or failed delivery is claimed first (the attempt is counted then),
 * so this is safe to call for any id. One already being sent by a worker is
 * left alone, and a finished one reports its status without sending again.
 *
 * Returns ['status' => new status, 'reason' => ?string, 'recordedOnly' => bool, 'providerMessageId' => ?string].
 */
function notifyDispatchDelivery(int $deliveryId, array $secretVars = []): array
{
    if (!notifyTablesExist()) return notifyDispatchOutcome('skipped', 'tables missing');
    try {
        $db   = getDB();
        $load = $db->prepare('SELECT * FROM notification_deliveries WHERE id = :id');
        $load->execute([':id' => $deliveryId]);
        $row = $load->fetch(PDO::FETCH_ASSOC);
        if (!$row) return notifyDispatchOutcome('skipped', 'no such delivery');

        if ($row['channel'] === 'inapp') {
            if ($row['status'] === 'queued') {
                notifyReleaseInApp((int) $row['id']);
                return notifyDispatchOutcome('sent', null);
            }
            return notifyDispatchOutcome($row['status'], null);
        }
        if ($row['status'] === 'sending') return notifyDispatchOutcome('sending', 'already being sent');
        if (!in_array($row['status'], ['queued', 'failed'], true)) {
            return notifyDispatchOutcome($row['status'], $row['failure_reason'] ?? $row['skip_reason'], $row['provider'] === 'log', $row['provider_message_id']);
        }

        $token = bin2hex(random_bytes(16));
        $claim = $db->prepare(
            "UPDATE notification_deliveries
                SET status = 'sending', claim_token = :t, claimed_at = :now, attempts = attempts + 1
              WHERE id = :id AND status IN ('queued', 'failed')"
        );
        $claim->execute([':t' => $token, ':now' => notifyNow(), ':id' => $deliveryId]);
        if ($claim->rowCount() === 0) return notifyDispatchOutcome('sending', 'already being sent');

        $load->execute([':id' => $deliveryId]);
        $row = $load->fetch(PDO::FETCH_ASSOC);
        notifyDeliveryEvent($deliveryId, 'claimed', 'attempt ' . (int) $row['attempts'] . ' of ' . (int) $row['max_attempts']);
        return notifyDispatchClaimed($row, $secretVars);
    } catch (Throwable $e) {
        error_log('[notify] dispatch of delivery ' . $deliveryId . ' failed: ' . get_class($e) . ': ' . $e->getMessage());
        return notifyDispatchOutcome('sending', 'internal error');
    }
}

/**
 * Send a delivery this process has already claimed (status 'sending', its
 * claim_token set). Loads the notification and recipient, renders the channel's
 * words, calls the provider and records the result.
 */
function notifyDispatchClaimed(array $d, array $secretVars): array
{
    $db = getDB();
    $stmt = $db->prepare('SELECT * FROM notifications WHERE id = :id');
    $stmt->execute([':id' => (int) $d['notification_id']]);
    $notif = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$notif) return notifyApplyResult($d, NotifyResult::skipped('notification removed'), null, false);

    $vars       = json_decode((string) ($notif['vars'] ?? ''), true) ?: [];
    $secretKeys = array_values(array_filter((array) ($vars['_secret'] ?? []), 'is_string'));
    $hasSecret  = $secretKeys !== [];
    if ($hasSecret && array_diff($secretKeys, array_keys($secretVars))) {
        // The secret was never stored, so nothing can send this message now.
        return notifyApplyTerminal($d, 'dead', 'security message not retried');
    }

    // The recipient as they are now: an address changed since the message was
    // queued is the address that should receive it.
    if ($notif['devotee_id'] !== null) {
        $recipient = notifyRecipientFromDevotee((int) $notif['devotee_id']);
        if (empty($recipient['devotee_id'])) return notifyApplyResult($d, NotifyResult::skipped('account removed'), null, $hasSecret);
        if (!$recipient['active'] && notifyCategoryKind((string) $notif['category']) !== 'security') {
            return notifyApplyResult($d, NotifyResult::skipped('account closed'), null, $hasSecret);
        }
    } else {
        $recipient = [
            'devotee_id' => null, 'name' => '', 'email' => null, 'email_verified' => false, 'phone' => null,
            'phone_verified' => false, 'country' => null, 'lang' => $notif['lang'], 'timezone' => notifyTempleTz(),
            'prefs' => null, 'active' => true, 'devices' => 0,
        ];
    }
    if ($notif['to_email'] !== null) {
        $recipient['email'] = $notif['to_email'];
        $recipient['email_verified'] = false; // an override address was never verified (notify() decided on the same basis)
    }
    if ($notif['to_phone'] !== null) {
        $recipient['phone'] = $notif['to_phone'];
        $recipient['phone_verified'] = false;
    }

    // What the devotee has chosen since the message was queued still counts.
    // Only preference reasons are re-applied: contact details and providers are
    // checked below anyway, and nothing else about the decision can change.
    if ($notif['devotee_id'] !== null) {
        $decision = notifyChannelDecision((string) $d['channel'], (string) $notif['category'], (string) $notif['priority'], $recipient, $notif['campaign_id'] !== null);
        if ($decision['status'] === 'skipped' && in_array($decision['reason'], NOTIFY_PREFERENCE_REASONS, true)) {
            return notifyApplyResult($d, NotifyResult::skipped((string) $decision['reason']), null, $hasSecret, 'the devotee\'s settings changed after it was queued');
        }
    }

    $provider = notifyProviderFor((string) $d['channel']);
    if (!$provider->isConfigured()) return notifyApplyResult($d, NotifyResult::skipped('not configured'), $provider->name(), $hasSecret);

    try {
        $message = notifyBuildMessage($d, $notif, $recipient, $vars, $secretVars);
    } catch (Throwable $e) {
        error_log('[notify] could not build delivery ' . (int) $d['id'] . ': ' . get_class($e) . ': ' . $e->getMessage());
        $message = NotifyResult::retry('the message could not be prepared');
    }
    if ($message instanceof NotifyResult) return notifyApplyResult($d, $message, $provider->name(), $hasSecret);

    try {
        $result = $provider->send($message);
    } catch (Throwable $e) {
        // Providers must not throw; one that does is treated as a transient failure.
        error_log('[notify] provider ' . $provider->name() . ' threw: ' . get_class($e) . ': ' . $e->getMessage());
        $result = NotifyResult::retry('provider error: ' . get_class($e));
    }
    return notifyApplyResult($d, $result, $provider->name(), $hasSecret);
}

/**
 * The words and addressing for one channel, as a NotifyMessage — or a
 * NotifyResult when there is nothing to send to (no address, no device).
 */
function notifyBuildMessage(array $d, array $notif, array $recipient, array $vars, array $secretVars): NotifyMessage|NotifyResult
{
    $channel        = (string) $d['channel'];
    $deliveryId     = (int) $d['id'];
    $notificationId = (int) $notif['id'];
    $lang           = (string) $notif['lang'];
    $category       = (string) $notif['category'];
    $priority       = (string) $notif['priority'];
    $kind           = notifyCategoryKind($category);
    $template       = $notif['template_key'];
    $hasSecret      = !empty($vars['_secret']);

    // The link. Normally the stored CTA, tracked. A link built from a secret
    // (a verification URL) was never stored, so it is rebuilt here from the
    // template's path and sent untracked: the tracking redirect could not know it.
    $ctaTarget = notifyAbsoluteUrl($notif['cta_url']);
    $tracked   = $ctaTarget !== null ? notifyTrackedUrl($deliveryId, $ctaTarget) : null;
    if ($hasSecret && $template !== null) {
        $path = (string) (notifyTemplateDefaults()[$template]['cta_path'] ?? '');
        if ($path !== '' && array_intersect(notifyTemplateVarsIn($path), (array) $vars['_secret'])) {
            // The service built this link itself (a verification or reset URL), so
            // plain http is acceptable here — it is what a local install uses.
            $built     = trim(notifyInterpolate($path, notifyRenderVars($vars, $recipient, null, $secretVars, false)));
            $ctaTarget = preg_match('~^https?://[^\s\\\\]+$~i', $built) && strlen($built) <= 2000 ? $built : notifyAbsoluteUrl($built);
            $tracked   = null;
        }
    }
    $link = $tracked ?? $ctaTarget;

    $renderVars = notifyRenderVars($vars, $recipient, $link, $secretVars, false);
    $providerTemplate = null;
    $templateParams   = [];
    if ($template !== null) {
        $r        = notifyRender((string) $template, $lang, $channel, $renderVars);
        $title    = $r['title'];
        $body     = $r['body'];
        $ctaLabel = isset($vars['_ctaLabel']) ? notifyInterpolate((string) $vars['_ctaLabel'], $renderVars) : $r['cta_label'];
        $prefix   = (string) ($vars['_titlePrefix'] ?? '');
        $title    = trim($prefix . $title);
        $providerTemplate = $r['provider_template'];
        $templateParams   = $r['provider_params'];
    } else {
        $title    = (string) $notif['title'];
        $body     = (string) $notif['body'];
        $ctaLabel = (string) ($notif['cta_label'] ?? '');
    }
    if ($title === '') $title = notifyCategoryLabel($category, $lang);
    $ctaLabel = trim((string) $ctaLabel);
    $image    = notifyAbsoluteUrl($notif['image_url']);
    $idem     = 'temple-n' . $notificationId . '-' . $channel;

    $base = [
        'deliveryId' => $deliveryId, 'notificationId' => $notificationId, 'channel' => $channel, 'lang' => $lang,
        'category' => $category, 'priority' => $priority, 'attempt' => max(1, (int) $d['attempts']),
        'imageUrl' => $image, 'idempotencyKey' => $idem,
    ];

    switch ($channel) {
        case 'email': {
            $to = (string) ($recipient['email'] ?? '');
            if (!filter_var($to, FILTER_VALIDATE_EMAIL)) return NotifyResult::skipped('no email');
            $isDevotee = $notif['devotee_id'] !== null;
            // Optional mail gets one-click unsubscribe (RFC 8058). Security and
            // transactional mail carries only the preferences link: unsubscribing
            // from a password reset would help nobody.
            $unsubscribe = $isDevotee && in_array($kind, NOTIFY_MUTABLE_KINDS, true) ? notifyUnsubscribeUrl((int) $notif['devotee_id']) : null;
            $p = [
                'title'           => $title,
                'body'            => $body,
                'lang'            => $lang,
                'category'        => $category,
                'category_label'  => notifyCategoryLabel($category, $lang),
                'priority'        => $priority,
                'cta_url'         => $link,
                'cta_label'       => $ctaLabel,
                'details'         => (array) ($vars['_details'] ?? []),
                'logo_url'        => siteUrl('/icons/icon-192x192.png'),
                'preferences_url' => $isDevotee ? notifyPreferencesUrl() : null,
                'unsubscribe_url' => $unsubscribe,
                'open_pixel_url'  => notifyOpenPixelUrl($deliveryId),
            ];
            $headers = $unsubscribe !== null
                ? ['List-Unsubscribe' => '<' . $unsubscribe . '>', 'List-Unsubscribe-Post' => 'List-Unsubscribe=One-Click']
                : [];
            return new NotifyMessage(...$base + [
                'title' => mb_substr($title, 0, 200), 'body' => notifyEmailText($p), 'html' => notifyEmailHtml($p),
                'ctaUrl' => $link, 'ctaLabel' => $ctaLabel === '' ? null : $ctaLabel, 'toEmail' => $to, 'headers' => $headers,
            ]);
        }

        case 'sms': {
            $phone = preg_replace('/\D+/', '', (string) ($recipient['phone'] ?? '')) ?? '';
            if (strlen($phone) < 7) return NotifyResult::skipped('no phone');
            $text = trim($body) !== '' ? trim($body) : $title;
            // A link is worth adding when the template did not already include one
            // and it does not push the message past two parts (or past the parts
            // the words alone already need).
            if ($link !== null && !str_contains($text, $link)) {
                $with = $text . "\n" . $link;
                if (notifySmsInfo($with)['segments'] <= max(2, notifySmsInfo($text)['segments'])) $text = $with;
            }
            return new NotifyMessage(...$base + [
                'title' => '', 'body' => $text, 'ctaUrl' => $link, 'toPhone' => $phone,
                'providerTemplate' => $providerTemplate, 'templateParams' => $templateParams,
            ]);
        }

        case 'whatsapp': {
            $phone = preg_replace('/\D+/', '', (string) ($recipient['phone'] ?? '')) ?? '';
            if (strlen($phone) < 7) return NotifyResult::skipped('no phone');
            $buttons = [];
            if ($link !== null && stripos($link, 'https://') === 0) {
                $label = $ctaLabel !== '' ? $ctaLabel : ($lang === 'ta' ? 'விவரங்கள்' : 'View details');
                $buttons[] = ['type' => 'url', 'text' => mb_substr($label, 0, 20), 'value' => $link];
            }
            // A number to call is useful for a booking, a payment or an emergency,
            // and noise on news the devotee does not need to act on.
            $support = preg_replace('/[^\d]/', '', (string) (notifyTempleFacts()['supportPhone'] ?? '')) ?? '';
            if (in_array($kind, ['transactional', 'critical'], true) && strlen($support) >= 7) {
                $buttons[] = ['type' => 'call', 'text' => $lang === 'ta' ? 'கோயிலை அழைக்க' : 'Call the temple', 'value' => '+' . $support];
            }
            return new NotifyMessage(...$base + [
                'title' => $title, 'body' => $body !== '' ? $body : $title, 'ctaUrl' => $link,
                'ctaLabel' => $ctaLabel === '' ? null : $ctaLabel, 'toPhone' => $phone,
                'providerTemplate' => $providerTemplate, 'templateParams' => $providerTemplate !== null ? $templateParams : [],
                'buttons' => $buttons,
            ]);
        }

        case 'push': {
            if ($notif['devotee_id'] === null) return NotifyResult::skipped('no device');
            $stmt = getDB()->prepare(
                'SELECT id, provider, endpoint, keys_json FROM devotee_devices
                  WHERE devotee_id = :d AND is_active = 1 ORDER BY id DESC LIMIT 20'
            );
            $stmt->execute([':d' => (int) $notif['devotee_id']]);
            $devices = [];
            foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
                $keys = json_decode((string) ($row['keys_json'] ?? ''), true);
                $devices[] = [
                    'id' => (int) $row['id'], 'provider' => (string) $row['provider'], 'endpoint' => (string) $row['endpoint'],
                    'keys' => is_array($keys) ? ['p256dh' => (string) ($keys['p256dh'] ?? ''), 'auth' => (string) ($keys['auth'] ?? '')] : null,
                ];
            }
            if (!$devices) return NotifyResult::skipped('no device');
            $text = trim((string) preg_replace("/\s*\n\s*/u", ' ', $body));
            if (mb_strlen($text) > NOTIFY_PUSH_BODY_MAX) $text = rtrim(mb_substr($text, 0, NOTIFY_PUSH_BODY_MAX - 1)) . '…';
            return new NotifyMessage(...$base + [
                'title' => $title, 'body' => $text, 'ctaUrl' => $ctaTarget, 'ctaLabel' => $ctaLabel === '' ? null : $ctaLabel,
                'devices' => $devices,
                'data' => [
                    'url'            => $ctaTarget ?? siteUrl('/notifications'),
                    'trackUrl'       => $tracked,
                    'notificationId' => $notificationId,
                    'category'       => $category,
                    'priority'       => $priority,
                    'tag'            => 'n' . $notificationId,
                    'image'          => $image,
                ],
            ]);
        }
    }
    return NotifyResult::skipped('unknown channel');
}

/** {{names}} used in a piece of template text. */
function notifyTemplateVarsIn(string $text): array
{
    preg_match_all('/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/', $text, $m);
    return array_values(array_unique($m[1]));
}

/**
 * Record a provider's answer on a claimed delivery.
 *
 * The write is conditioned on the claim token, so a run that was presumed dead
 * and recovered cannot overwrite what a later run recorded — except a success,
 * which is always recorded: the message did go out, and saying otherwise would
 * invite a second copy.
 */
function notifyApplyResult(array $d, NotifyResult $result, ?string $providerName, bool $hasSecret, ?string $eventNote = null): array
{
    $db  = getDB();
    $id  = (int) $d['id'];
    $now = notifyNow();

    $status = $result->status;
    $reason = $result->reason;

    // Push reports per device: retire the gone ones, then decide for the delivery.
    if ($d['channel'] === 'push' && $result->deviceResults) {
        $ok = 0;
        $gone = 0;
        foreach ($result->deviceResults as $deviceId => $dr) {
            if (!empty($dr['gone'])) {
                $gone++;
                $db->prepare('UPDATE devotee_devices SET is_active = 0, failures = LEAST(failures + 1, 255) WHERE id = :id')
                   ->execute([':id' => (int) $deviceId]);
                notifyDeliveryEvent($id, 'device_gone', 'device #' . (int) $deviceId . ' retired: ' . mb_substr((string) ($dr['reason'] ?? 'gone'), 0, 200));
            } elseif (!empty($dr['ok'])) {
                $ok++;
                $db->prepare('UPDATE devotee_devices SET failures = 0, last_seen_at = :now WHERE id = :id')
                   ->execute([':now' => $now, ':id' => (int) $deviceId]);
            } else {
                $db->prepare('UPDATE devotee_devices SET failures = LEAST(failures + 1, 255) WHERE id = :id')
                   ->execute([':id' => (int) $deviceId]);
            }
        }
        $total = count($result->deviceResults);
        if ($ok > 0) {
            $status = NotifyResult::SENT;
        } elseif ($gone === $total) {
            $status = NotifyResult::REJECTED;
            $reason = 'every device has unsubscribed';
        } elseif ($status === NotifyResult::SENT) {
            $status = NotifyResult::RETRY;
            $reason = 'no device accepted the message';
        }
    }

    $response = mb_substr($result->response, 0, 2000);

    if ($status === NotifyResult::SENT) {
        $stmt = $db->prepare(
            "UPDATE notification_deliveries
                SET status = 'sent', provider = :p, provider_message_id = :m, provider_response = :r, sent_at = :now,
                    failure_reason = NULL, skip_reason = NULL, next_attempt_at = NULL, claim_token = NULL
              WHERE id = :id AND status IN ('sending', 'queued', 'failed')"
        );
        $stmt->execute([':p' => $providerName, ':m' => $result->messageId, ':r' => $response === '' ? null : $response, ':now' => $now, ':id' => $id]);
        notifyDeliveryEvent($id, 'sent', $result->recordedOnly
            ? 'recorded only by the ' . $providerName . ' driver; no provider is configured'
            : 'accepted by ' . $providerName . ($result->messageId ? ' as ' . mb_substr($result->messageId, 0, 120) : ''));
        return notifyDispatchOutcome('sent', null, $result->recordedOnly, $result->messageId);
    }

    if ($status === NotifyResult::RETRY) {
        if ($hasSecret) return notifyApplyTerminal($d, 'dead', 'security message not retried', $providerName, $response, $reason);
        $attempts = (int) $d['attempts'];
        $max      = (int) $d['max_attempts'];
        if ($attempts >= $max) {
            return notifyApplyTerminal($d, 'dead', $reason !== '' ? $reason : 'retries exhausted', $providerName, $response, 'attempt ' . $attempts . ' of ' . $max);
        }
        $next = notifyNowPlus(notifyBackoffSeconds($attempts, $result->retryAfter));
        $stmt = $db->prepare(
            "UPDATE notification_deliveries
                SET status = 'failed', provider = :p, provider_response = :r, failure_reason = :f,
                    next_attempt_at = :next, claim_token = NULL
              WHERE id = :id AND claim_token <=> :t"
        );
        $stmt->execute([':p' => $providerName, ':r' => $response === '' ? null : $response, ':f' => mb_substr($reason, 0, 300), ':next' => $next, ':id' => $id, ':t' => $d['claim_token']]);
        if ($stmt->rowCount() > 0) {
            notifyDeliveryEvent($id, 'failed', 'attempt ' . $attempts . ' of ' . $max . ' failed: ' . $reason . ' — next attempt ' . notifyIso($next));
        }
        return notifyDispatchOutcome('failed', $reason);
    }

    if ($status === NotifyResult::REJECTED) {
        return notifyApplyTerminal($d, 'rejected', $reason !== '' ? $reason : 'rejected by the provider', $providerName, $response);
    }

    // skipped
    $stmt = $db->prepare(
        "UPDATE notification_deliveries
            SET status = 'skipped', provider = COALESCE(:p, provider), skip_reason = :s, next_attempt_at = NULL, claim_token = NULL
          WHERE id = :id AND claim_token <=> :t"
    );
    $skip = mb_substr($reason !== '' ? $reason : 'not attempted', 0, 120);
    $stmt->execute([':p' => $providerName, ':s' => $skip, ':id' => $id, ':t' => $d['claim_token']]);
    if ($stmt->rowCount() > 0) notifyDeliveryEvent($id, 'skipped', $skip . ($eventNote !== null ? ' (' . $eventNote . ')' : ''));
    return notifyDispatchOutcome('skipped', $skip);
}

/** dead or rejected, with the reason kept for the admin. */
function notifyApplyTerminal(array $d, string $status, string $reason, ?string $providerName = null, string $response = '', ?string $note = null): array
{
    $id   = (int) $d['id'];
    $stmt = getDB()->prepare(
        'UPDATE notification_deliveries
            SET status = :s, provider = COALESCE(:p, provider), provider_response = COALESCE(:r, provider_response),
                failure_reason = :f, next_attempt_at = NULL, claim_token = NULL
          WHERE id = :id AND claim_token <=> :t'
    );
    $stmt->execute([
        ':s' => $status, ':p' => $providerName, ':r' => $response === '' ? null : $response,
        ':f' => mb_substr($reason, 0, 300), ':id' => $id, ':t' => $d['claim_token'] ?? null,
    ]);
    if ($stmt->rowCount() > 0) notifyDeliveryEvent($id, $status, $reason . ($note ? ' (' . $note . ')' : ''));
    return notifyDispatchOutcome($status, $reason);
}

/** A held in-app message whose time has come becomes visible. */
function notifyReleaseInApp(int $deliveryId): bool
{
    $stmt = getDB()->prepare(
        "UPDATE notification_deliveries SET status = 'sent', sent_at = :now, next_attempt_at = NULL
          WHERE id = :id AND channel = 'inapp' AND status = 'queued'"
    );
    $stmt->execute([':now' => notifyNow(), ':id' => $deliveryId]);
    if ($stmt->rowCount() === 0) return false;
    notifyDeliveryEvent($deliveryId, 'sent', 'now visible in the app');
    return true;
}

/* ── The worker ─────────────────────────────────────────────────────────── */

/**
 * One worker run. See SPEC §5.7 for the order of work.
 *
 * opts: max_seconds (50), batch (100), channels (default: every external
 * channel plus releasing held in-app messages; [] processes no channel),
 * notification_ids (int[]; limits recovery, release and claims to those
 * notifications and skips campaigns and reminders), campaign_id (limits the
 * same to one campaign's notifications and expands only that campaign; skips
 * reminders), skip_campaigns, skip_reminders, trigger ('cli'|'http'),
 * expand_limit (at most this many devotees expanded per campaign per run;
 * 0 = as many as the time budget allows), now (UTC; tests only, honoured only
 * when NOTIFY_ALLOW_TEST_DRIVER=1).
 *
 * Returns ['run_id','claimed','sent','failed','dead','rejected','skipped',
 *          'campaigns_expanded','reminders_created','duration_ms','locked','error'].
 *
 * @throws RuntimeException when the notification tables are missing
 */
function notifyWorkerRun(array $opts = []): array
{
    $started = microtime(true);
    $result  = [
        'run_id' => null, 'claimed' => 0, 'sent' => 0, 'failed' => 0, 'dead' => 0, 'rejected' => 0, 'skipped' => 0,
        'campaigns_expanded' => 0, 'reminders_created' => 0, 'duration_ms' => 0, 'locked' => false, 'error' => null,
    ];
    if (!notifyTablesExist()) {
        throw new RuntimeException('The notification tables are missing; apply database/migrations/007_notifications.sql.');
    }

    $maxSeconds = max(1, min(600, (int) ($opts['max_seconds'] ?? 50)));
    $batch      = max(1, min(1000, (int) ($opts['batch'] ?? 100)));
    $deadline   = $started + $maxSeconds;
    $trigger    = in_array($opts['trigger'] ?? 'cli', ['cli', 'http'], true) ? (string) ($opts['trigger'] ?? 'cli') : 'cli';

    $channels = array_key_exists('channels', $opts) && $opts['channels'] !== null
        ? array_values(array_intersect(NOTIFY_CHANNELS, array_map('strval', (array) $opts['channels'])))
        : NOTIFY_CHANNELS;

    // A run told to work on particular notifications must never touch others,
    // even when none of the ids given is usable: an empty scope matches nothing.
    $idScoped   = !empty($opts['notification_ids']);
    $ids        = $idScoped ? array_values(array_unique(array_filter(array_map('intval', (array) $opts['notification_ids']), static fn(int $i): bool => $i > 0))) : [];
    $campaignId = isset($opts['campaign_id']) && (int) $opts['campaign_id'] > 0 ? (int) $opts['campaign_id'] : null;
    $scoped     = $idScoped || $campaignId !== null;

    $testClock = false;
    if (!empty($opts['now'])) {
        if (notifyEnv('NOTIFY_ALLOW_TEST_DRIVER') === '1') {
            notifyClockOffset((string) $opts['now']);
            $testClock = true;
        } else {
            error_log('[notify] the worker ignored "now": it is honoured only when NOTIFY_ALLOW_TEST_DRIVER=1');
        }
    }

    $db = getDB();
    try {
        $got = (int) $db->query("SELECT GET_LOCK('temple_notify_worker', 0)")->fetchColumn();
        if ($got !== 1) {
            $result['locked'] = true;
            $result['duration_ms'] = (int) round((microtime(true) - $started) * 1000);
            return $result;
        }

        try {
            $db->prepare('INSERT INTO notification_worker_runs (started_at, `trigger`) VALUES (:s, :t)')
               ->execute([':s' => notifyNow(), ':t' => $trigger]);
            $result['run_id'] = (int) $db->lastInsertId();

            $scope = ['sql' => '', 'params' => []];
            if ($idScoped) {
                if ($ids) {
                    $names = [];
                    foreach ($ids as $i => $nid) {
                        $names[] = ':nid' . $i;
                        $scope['params'][':nid' . $i] = $nid;
                    }
                    $scope['sql'] .= ' AND notification_id IN (' . implode(', ', $names) . ')';
                } else {
                    $scope['sql'] .= ' AND 1 = 0';
                }
            }
            if ($campaignId !== null) {
                $scope['sql'] .= ' AND notification_id IN (SELECT id FROM notifications WHERE campaign_id = :scope_campaign)';
                $scope['params'][':scope_campaign'] = $campaignId;
            }

            $step = static function (string $name, callable $fn) use (&$result): void {
                try {
                    $fn();
                } catch (Throwable $e) {
                    $result['error'] = $name . ': ' . mb_substr($e->getMessage(), 0, 400);
                    error_log('[notify] worker ' . $name . ' failed: ' . get_class($e) . ': ' . $e->getMessage());
                }
            };

            $step('recovery', static function () use ($channels, $scope): void {
                notifyRecoverStaleClaims($channels, $scope);
            });

            if (empty($opts['skip_campaigns']) && !$idScoped) {
                $step('campaigns', static function () use (&$result, $deadline, $campaignId, $opts): void {
                    $result['campaigns_expanded'] = notifyCampaignsExpandDue($deadline, $campaignId, max(0, (int) ($opts['expand_limit'] ?? 0)));
                });
            }

            if (empty($opts['skip_reminders']) && !$scoped) {
                $step('reminders', static function () use (&$result, $testClock): void {
                    $result['reminders_created'] = notifyRemindersMaybeRun($testClock);
                });
            }

            if (in_array('inapp', $channels, true)) {
                $step('in-app release', static function () use ($scope): void {
                    $stmt = getDB()->prepare(
                        "SELECT id FROM notification_deliveries
                          WHERE channel = 'inapp' AND status = 'queued' AND next_attempt_at <= :now{$scope['sql']}
                          ORDER BY id LIMIT 2000"
                    );
                    $stmt->execute([':now' => notifyNow()] + $scope['params']);
                    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) notifyReleaseInApp((int) $id);
                });
            }

            $step('sending', static function () use (&$result, $channels, $scope, $batch, $deadline): void {
                notifyClaimLoop(array_values(array_intersect(NOTIFY_EXTERNAL_CHANNELS, $channels)), $scope, $batch, $deadline, $result);
            });
        } finally {
            $result['duration_ms'] = (int) round((microtime(true) - $started) * 1000);
            if ($result['run_id'] !== null) {
                try {
                    $db->prepare(
                        'UPDATE notification_worker_runs
                            SET finished_at = :f, claimed = :c, sent = :s, failed = :fl, dead = :d,
                                campaigns_expanded = :ce, reminders_created = :rc, duration_ms = :ms, error = :e
                          WHERE id = :id'
                    )->execute([
                        ':f' => notifyNow(), ':c' => $result['claimed'], ':s' => $result['sent'], ':fl' => $result['failed'],
                        ':d' => $result['dead'], ':ce' => $result['campaigns_expanded'], ':rc' => $result['reminders_created'],
                        ':ms' => $result['duration_ms'], ':e' => $result['error'], ':id' => $result['run_id'],
                    ]);
                } catch (Throwable $e) {
                    error_log('[notify] could not finish the worker run row: ' . $e->getMessage());
                }
            }
            try {
                $db->query("SELECT RELEASE_LOCK('temple_notify_worker')")->closeCursor();
            } catch (Throwable $e) {
                error_log('[notify] could not release the worker lock: ' . $e->getMessage());
            }
        }
    } finally {
        if ($testClock) notifyClockOffset(null, true);
    }
    return $result;
}

/** Claims older than ten minutes belong to a run that died; put them back in the queue. */
function notifyRecoverStaleClaims(array $channels, array $scope): int
{
    $external = array_values(array_intersect(NOTIFY_EXTERNAL_CHANNELS, $channels));
    if (!$external) return 0;
    $db  = getDB();
    $cut = notifyNowPlus(-NOTIFY_STALE_CLAIM_SECONDS);
    $in  = implode(', ', array_map(static fn(string $c): string => $db->quote($c), $external));
    $stmt = $db->prepare(
        "SELECT id, attempts, max_attempts FROM notification_deliveries
          WHERE status = 'sending' AND claimed_at < :cut AND channel IN ({$in}){$scope['sql']}
          ORDER BY id LIMIT 500"
    );
    $stmt->execute([':cut' => $cut] + $scope['params']);
    $recovered = 0;
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $last = (int) $row['attempts'] >= (int) $row['max_attempts'];
        $upd = $db->prepare(
            "UPDATE notification_deliveries
                SET status = :s, claim_token = NULL, claimed_at = NULL, failure_reason = :f
              WHERE id = :id AND status = 'sending' AND claimed_at < :cut"
        );
        $upd->execute([
            ':s' => $last ? 'dead' : 'queued', ':f' => $last ? 'worker interrupted on the last attempt' : null,
            ':id' => (int) $row['id'], ':cut' => $cut,
        ]);
        if ($upd->rowCount() > 0) {
            $recovered++;
            notifyDeliveryEvent((int) $row['id'], $last ? 'dead' : 'requeued', $last ? 'worker interrupted on the last attempt' : 'worker interrupted');
        }
    }
    return $recovered;
}

/** Claim due deliveries channel by channel, within each channel's throttle, and send them. */
function notifyClaimLoop(array $channels, array $scope, int $batch, float $deadline, array &$result): void
{
    $db   = getDB();
    $done = [];
    while (microtime(true) < $deadline) {
        $progress = false;
        foreach ($channels as $channel) {
            if (isset($done[$channel]) || microtime(true) >= $deadline) continue;

            $count = $db->prepare('SELECT COUNT(*) FROM notification_deliveries WHERE channel = :c AND sent_at >= :since');
            $count->execute([':c' => $channel, ':since' => notifyNowPlus(-60)]);
            $room = notifyRatePerMinute($channel) - (int) $count->fetchColumn();
            if ($room <= 0) {
                $done[$channel] = 'throttled';
                continue;
            }

            $token = bin2hex(random_bytes(16));
            $now   = notifyNow();
            $claim = $db->prepare(
                "UPDATE notification_deliveries
                    SET status = 'sending', claim_token = :t, claimed_at = :now, attempts = attempts + 1
                  WHERE status IN ('queued', 'failed') AND channel = :c
                    AND (next_attempt_at IS NULL OR next_attempt_at <= :now2){$scope['sql']}
                  ORDER BY priority_rank, id
                  LIMIT " . max(1, min($batch, $room))
            );
            $claim->execute([':t' => $token, ':now' => $now, ':c' => $channel, ':now2' => $now] + $scope['params']);
            $claimed = $claim->rowCount();
            if ($claimed === 0) {
                $done[$channel] = 'empty';
                continue;
            }
            $progress = true;
            $result['claimed'] += $claimed;

            $rows = $db->prepare('SELECT * FROM notification_deliveries WHERE claim_token = :t ORDER BY priority_rank, id');
            $rows->execute([':t' => $token]);
            $list = $rows->fetchAll(PDO::FETCH_ASSOC);
            foreach ($list as $i => $row) {
                if (microtime(true) >= $deadline) {
                    // Out of time: hand the rest back untouched rather than leave
                    // them "sending" for ten minutes.
                    $release = $db->prepare(
                        "UPDATE notification_deliveries
                            SET status = IF(next_attempt_at IS NULL OR attempts <= 1, 'queued', 'failed'),
                                claim_token = NULL, claimed_at = NULL, attempts = GREATEST(attempts - 1, 0)
                          WHERE claim_token = :t AND status = 'sending'"
                    );
                    $release->execute([':t' => $token]);
                    $result['claimed'] -= count($list) - $i;
                    return;
                }
                notifyDeliveryEvent((int) $row['id'], 'claimed', 'attempt ' . (int) $row['attempts'] . ' of ' . (int) $row['max_attempts']);
                try {
                    $outcome = notifyDispatchClaimed($row, []);
                } catch (Throwable $e) {
                    // One row the service cannot handle (a database hiccup while loading
                    // it) must not strand the rest of the batch in "sending" for ten
                    // minutes. It goes back through the normal retry path.
                    error_log('[notify] delivery ' . (int) $row['id'] . ' could not be dispatched: ' . get_class($e) . ': ' . $e->getMessage());
                    try {
                        $outcome = notifyApplyResult($row, NotifyResult::retry('internal error while sending'), null, false);
                    } catch (Throwable) {
                        $outcome = notifyDispatchOutcome('sending', 'internal error');
                    }
                }
                if (isset($result[$outcome['status']]) && in_array($outcome['status'], ['sent', 'failed', 'dead', 'rejected', 'skipped'], true)) {
                    $result[$outcome['status']]++;
                }
            }
        }
        if (!$progress) break;
    }
}

/**
 * Put a failed, dead or rejected delivery back in the queue with its attempts
 * reset. A message that carried a one-time secret cannot be requeued: the
 * secret was never stored. Audited.
 */
function notifyRequeue(int $deliveryId, string $actor): bool
{
    if (!notifyTablesExist()) return false;
    try {
        $db = getDB();
        $stmt = $db->prepare(
            'SELECT d.id, d.channel, d.status, n.campaign_id, n.vars
               FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
              WHERE d.id = :id'
        );
        $stmt->execute([':id' => $deliveryId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row || !in_array($row['status'], ['dead', 'failed', 'rejected'], true)) return false;
        $vars = json_decode((string) ($row['vars'] ?? ''), true) ?: [];
        if (!empty($vars['_secret'])) return false;

        $upd = $db->prepare(
            "UPDATE notification_deliveries
                SET status = 'queued', attempts = 0, next_attempt_at = NULL, claim_token = NULL, claimed_at = NULL, failure_reason = NULL
              WHERE id = :id AND status IN ('dead', 'failed', 'rejected')"
        );
        $upd->execute([':id' => $deliveryId]);
        if ($upd->rowCount() === 0) return false;

        $who = mb_substr(trim($actor) !== '' ? trim($actor) : 'system', 0, 120);
        notifyDeliveryEvent($deliveryId, 'requeued', 'requeued by ' . $who . ' (was ' . $row['status'] . ')');
        notifyAudit($row['campaign_id'] !== null ? (int) $row['campaign_id'] : null, 'requeued', ['username' => $who, 'role' => null], [
            'delivery_id' => $deliveryId, 'channel' => $row['channel'], 'previous_status' => $row['status'],
        ]);
        return true;
    } catch (Throwable $e) {
        error_log('[notify] requeue of delivery ' . $deliveryId . ' failed: ' . $e->getMessage());
        return false;
    }
}

/**
 * Apply a provider's status callback. Deliveries are found by the driver name
 * and the provider's message id. Status only moves forward; a failure counts
 * only before delivery (a "failed" after "delivered" is kept as an event and
 * changes nothing). Returns how many deliveries changed.
 *
 * A reported failure becomes 'rejected' rather than a retry: the provider has
 * already tried, and sending again could reach the devotee twice. The admin can
 * requeue it.
 */
function notifyApplyProviderUpdate(string $provider, string $messageId, string $status, ?string $error = null, ?string $at = null): int
{
    if (!notifyTablesExist() || trim($provider) === '' || trim($messageId) === '') return 0;
    $status = strtolower(trim($status));
    if (!in_array($status, ['sent', 'delivered', 'read', 'failed', 'rejected'], true)) return 0;

    try {
        $db  = getDB();
        $now = notifyNow();
        $when = $now;
        if ($at !== null && trim($at) !== '') {
            $t = strtotime(str_contains($at, 'T') || str_contains($at, 'Z') || str_contains($at, '+') ? $at : $at . ' UTC');
            if ($t !== false) $when = min($now, gmdate('Y-m-d H:i:s', $t));
        }

        $stmt = $db->prepare(
            'SELECT id, status FROM notification_deliveries WHERE provider = :p AND provider_message_id = :m ORDER BY id LIMIT 50'
        );
        $stmt->execute([':p' => mb_substr($provider, 0, 32), ':m' => mb_substr($messageId, 0, 190)]);
        $changed = 0;
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $id      = (int) $row['id'];
            $current = (string) $row['status'];
            $sql     = null;
            $params  = [':id' => $id];

            switch ($status) {
                case 'sent':
                    if (in_array($current, ['queued', 'sending', 'failed'], true)) {
                        $sql = "SET status = 'sent', sent_at = COALESCE(sent_at, :at), failure_reason = NULL, next_attempt_at = NULL";
                        $params[':at'] = $when;
                    }
                    break;
                case 'delivered':
                    if (in_array($current, ['queued', 'sending', 'failed', 'sent'], true)) {
                        $sql = "SET status = 'delivered', delivered_at = :at, sent_at = COALESCE(sent_at, :at2), failure_reason = NULL, next_attempt_at = NULL";
                        $params += [':at' => $when, ':at2' => $when];
                    } elseif ($current === 'read') {
                        $sql = 'SET delivered_at = COALESCE(delivered_at, :at)';
                        $params[':at'] = $when;
                    }
                    break;
                case 'read':
                    if (in_array($current, ['queued', 'sending', 'failed', 'sent', 'delivered'], true)) {
                        $sql = "SET status = 'read', read_at = :at, delivered_at = COALESCE(delivered_at, :at2), sent_at = COALESCE(sent_at, :at3), failure_reason = NULL, next_attempt_at = NULL";
                        $params += [':at' => $when, ':at2' => $when, ':at3' => $when];
                    }
                    break;
                case 'failed':
                case 'rejected':
                    if (in_array($current, ['queued', 'sending', 'sent'], true)) {
                        $sql = "SET status = 'rejected', failure_reason = :f, next_attempt_at = NULL, claim_token = NULL";
                        $params[':f'] = mb_substr(notifyRedact((string) ($error ?? 'the provider reported a failure'), 300), 0, 300);
                    }
                    break;
            }

            $detail = $status . ($error !== null && $error !== '' ? ': ' . notifyRedact($error, 300) : '');
            if ($sql === null) {
                notifyDeliveryEvent($id, 'webhook', $detail . ' (ignored: already ' . $current . ')');
                continue;
            }
            $upd = $db->prepare("UPDATE notification_deliveries {$sql} WHERE id = :id");
            $upd->execute($params);
            if ($upd->rowCount() > 0) {
                $changed++;
                $newStatus = in_array($status, ['failed', 'rejected'], true) ? 'rejected' : $status;
                notifyDeliveryEvent($id, $newStatus === $current ? 'webhook' : $newStatus, 'webhook: ' . $detail);
            } else {
                notifyDeliveryEvent($id, 'webhook', $detail . ' (no change)');
            }
        }
        return $changed;
    } catch (Throwable $e) {
        error_log('[notify] provider update failed: ' . get_class($e) . ': ' . $e->getMessage());
        return 0;
    }
}
