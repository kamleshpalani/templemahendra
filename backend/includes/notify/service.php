<?php
/**
 * backend/includes/notify/service.php — notify(): "tell this devotee that…"
 * becomes one notification row and one delivery per channel (SPEC §5.3).
 *
 * The notification row is the canonical copy: it is what the bell shows, and
 * every channel is delivered from it. A delivery row is a place in the queue.
 *
 * NEVER BREAK A USER FLOW. A booking must save even if the notification tables
 * are missing, a provider is down or a template has a typo. notify() therefore
 * never throws: it logs "[notify] …" and returns a result that says what
 * happened, and callers are free to ignore it.
 *
 * SECRETS. One-time codes and verification links travel in secret_vars. They
 * are rendered only at dispatch, inside the same request, and never stored:
 * the stored copy shows •••• in their place. That is also why such a message is
 * sent synchronously and is never retried — a later attempt could not
 * reproduce the secret.
 */

require_once __DIR__ . '/policy.php';
require_once __DIR__ . '/tracking.php';

/** Attempts per channel before a delivery is dead. In-app never retries: it is a row, not a send. */
const NOTIFY_MAX_ATTEMPTS = ['inapp' => 1, 'email' => 5, 'whatsapp' => 5, 'sms' => 3, 'push' => 3];
const NOTIFY_SECRET_MASK  = '••••';

function notifyEmptyResult(?string $skipped, bool $deduped = false, ?int $id = null): array
{
    return ['id' => $id, 'deduped' => $deduped, 'skipped' => $skipped, 'deliveries' => []];
}

/** A scalar that is not an empty string. */
function notifyHasValue(array $vars, string $name): bool
{
    if (!array_key_exists($name, $vars)) return false;
    $v = $vars[$name];
    return $v !== null && is_scalar($v) && (string) (is_bool($v) ? (int) $v : $v) !== '';
}

/**
 * ['devotee_id','name','email','email_verified','phone','phone_verified','country',
 *  'lang','timezone','prefs','active','devices']
 *
 * 'devices' (active push devices) is an addition to the SPEC shape; the channel
 * policy needs it. A devotee that does not exist comes back with devotee_id null.
 *
 * Accepts an id or a devotees row. Campaign expansion passes rows carrying
 * '_prefs' and '_devices' it loaded for a whole batch, to save two queries per
 * devotee.
 */
function notifyRecipientFromDevotee(array|int $devotee): array
{
    $blank = [
        'devotee_id' => null, 'name' => '', 'email' => null, 'email_verified' => false,
        'phone' => null, 'phone_verified' => false, 'country' => null, 'lang' => 'ta',
        'timezone' => notifyTempleTz(), 'prefs' => null, 'active' => false, 'devices' => 0,
    ];
    if (!notifyTablesExist()) return $blank;

    $row = $devotee;
    $needed = ['id', 'name', 'email', 'email_verified_at', 'phone', 'phone_verified_at', 'country', 'is_active'];
    if (is_int($devotee) || count(array_intersect_key(array_flip($needed), $devotee)) < count($needed)) {
        $id = is_int($devotee) ? $devotee : (int) ($devotee['id'] ?? 0);
        if ($id < 1) return $blank;
        $stmt = getDB()->prepare(
            'SELECT id, name, email, email_verified_at, phone, phone_verified_at, country, is_active FROM devotees WHERE id = :id'
        );
        $stmt->execute([':id' => $id]);
        $loaded = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$loaded) return $blank;
        $row = is_array($devotee) ? $loaded + $devotee : $loaded;
    }

    $id    = (int) $row['id'];
    $prefs = is_array($row['_prefs'] ?? null) ? $row['_prefs'] : notifyPrefs($id);
    if (array_key_exists('_devices', $row)) {
        $devices = (int) $row['_devices'];
    } else {
        $stmt = getDB()->prepare('SELECT COUNT(*) FROM devotee_devices WHERE devotee_id = :d AND is_active = 1');
        $stmt->execute([':d' => $id]);
        $devices = (int) $stmt->fetchColumn();
    }

    return [
        'devotee_id'     => $id,
        'name'           => (string) $row['name'],
        'email'          => $row['email'] !== null ? (string) $row['email'] : null,
        'email_verified' => $row['email_verified_at'] !== null,
        'phone'          => $row['phone'] !== null && $row['phone'] !== '' ? (string) $row['phone'] : null,
        'phone_verified' => $row['phone_verified_at'] !== null,
        'country'        => $row['country'] ?? null,
        'lang'           => $prefs['lang'] ?? 'ta',
        'timezone'       => $prefs['effectiveTimezone'] ?? notifyTimezoneFor($prefs, $row['country'] ?? null),
        'prefs'          => $prefs,
        'active'         => (int) $row['is_active'] === 1,
        'devices'        => $devices,
    ];
}

/**
 * The variables a template is rendered with, from what was stored.
 *
 * Internal keys (leading underscore) are dropped. devoteeName and ctaUrl are
 * filled when the caller did not supply them. Secrets are masked for the stored
 * copy and real only at dispatch.
 */
function notifyRenderVars(array $stored, array $recipient, ?string $ctaUrl, array $secretVars, bool $maskSecrets): array
{
    $vars = [];
    foreach ($stored as $k => $v) {
        if (!is_string($k) || $k === '' || $k[0] === '_') continue;
        if ($v === null || is_scalar($v)) $vars[$k] = $v;
    }
    if (!notifyHasValue($vars, 'devoteeName') && trim((string) ($recipient['name'] ?? '')) !== '') {
        $vars['devoteeName'] = trim((string) $recipient['name']);
    }
    if (!notifyHasValue($vars, 'ctaUrl') && $ctaUrl !== null) $vars['ctaUrl'] = $ctaUrl;
    foreach ((array) ($stored['_secret'] ?? []) as $k) {
        if (!is_string($k)) continue;
        $vars[$k] = $maskSecrets ? NOTIFY_SECRET_MASK : (string) ($secretVars[$k] ?? '');
    }
    return $vars;
}

/** [[label, value], …] with at most 20 rows of short strings, or []. */
function notifyCleanDetails(mixed $details): array
{
    $rows = [];
    foreach (is_array($details) ? $details : [] as $row) {
        if (!is_array($row)) continue;
        $row = array_values($row);
        if (count($row) < 2 || !is_scalar($row[0]) || !is_scalar($row[1])) continue;
        $rows[] = [mb_substr(trim((string) $row[0]), 0, 120), mb_substr(trim((string) $row[1]), 0, 500)];
        if (count($rows) >= 20) break;
    }
    return $rows;
}

/** A dedupe key that fits its column: long keys keep a readable head and a hash of the whole. */
function notifyDedupeKey(mixed $key): ?string
{
    if (!is_scalar($key)) return null;
    $k = trim((string) $key);
    if ($k === '') return null;
    return strlen($k) <= 190 ? $k : substr($k, 0, 149) . ':' . sha1($k);
}

/**
 * Create a notification. See SPEC §5.3 for every input key. Beyond the spec:
 *
 *   fallbacks     ['whatsapp' => 'sms'] — used when a channel's provider is not configured
 *   title_prefix  prepended to the title on every channel ("[TEST] " for test sends)
 *
 * Returns ['id','deduped','skipped','deliveries' => [channel => ['id','status','reason','recordedOnly']]].
 */
function notify(array $n): array
{
    if (!notifyTablesExist()) return notifyEmptyResult('tables missing');
    try {
        return notifyCreate($n);
    } catch (Throwable $e) {
        error_log('[notify] notify() failed for ' . (string) ($n['event'] ?? $n['template'] ?? 'a free-text message')
            . ': ' . get_class($e) . ': ' . $e->getMessage());
        return notifyEmptyResult('error');
    }
}

function notifyCreate(array $n): array
{
    $db  = getDB();
    $now = notifyNow();

    /* ── What is being said ─────────────────────────────────────────────── */
    $template = is_string($n['template'] ?? null) && trim($n['template']) !== '' ? trim($n['template']) : null;
    $defaults = $template !== null ? (notifyTemplateDefaults()[$template] ?? null) : null;
    if ($template !== null && notifyTemplate($template, 'ta', 'any') === null) {
        error_log("[notify] unknown template \"{$template}\"");
        return notifyEmptyResult('unknown template');
    }
    $hasText = notifyPickLang($n['title'] ?? null, 'ta') !== null && notifyPickLang($n['body'] ?? null, 'ta') !== null;
    if ($template === null && !$hasText) return notifyEmptyResult('nothing to send');

    $priority = in_array($n['priority'] ?? null, NOTIFY_PRIORITIES, true) ? $n['priority'] : 'normal';
    $category = is_string($n['category'] ?? null) && $n['category'] !== '' ? $n['category'] : (string) ($defaults['category'] ?? 'general');
    if (notifyCategory($category) === null) {
        error_log("[notify] unknown category \"{$category}\"; filed under general");
        $category = 'general';
    }
    $kind = notifyCategoryKind($category);

    $channels = $n['channels'] ?? ['inapp'];
    if (is_string($channels)) $channels = explode(',', $channels);
    $channels = array_values(array_unique(array_filter(
        array_map(static fn($c) => strtolower(trim((string) $c)), (array) $channels),
        static fn(string $c): bool => in_array($c, NOTIFY_CHANNELS, true)
    )));
    if (!$channels) return notifyEmptyResult('no channels');

    $fallbacks = [];
    foreach ((array) ($n['fallbacks'] ?? []) as $from => $to) {
        if (in_array($from, NOTIFY_CHANNELS, true) && in_array($to, NOTIFY_CHANNELS, true)) $fallbacks[$from] = $to;
    }

    /* ── To whom ────────────────────────────────────────────────────────── */
    $devoteeId = (int) ($n['devotee_id'] ?? 0);
    $toEmail   = null;
    $toPhone   = null;
    if (is_string($n['to_email'] ?? null) && trim($n['to_email']) !== '') {
        $e = mb_strtolower(trim($n['to_email']));
        if (filter_var($e, FILTER_VALIDATE_EMAIL) && strlen($e) <= 190) $toEmail = $e;
    }
    if (isset($n['to_phone']) && is_scalar($n['to_phone'])) {
        $p = normalizePhone((string) $n['to_phone']);
        if ($p['error'] === '' && $p['phone'] !== '') $toPhone = $p['phone'];
    }

    if ($devoteeId > 0) {
        $recipient = is_array($n['_recipient'] ?? null) && (int) ($n['_recipient']['devotee_id'] ?? 0) === $devoteeId
            ? $n['_recipient']
            : notifyRecipientFromDevotee($devoteeId);
        if (empty($recipient['devotee_id'])) return notifyEmptyResult('no such devotee');

        if (!$recipient['active']) {
            // A closed account receives nothing, except a security message to its
            // own address — the one way its owner can learn what is happening to it.
            if ($kind !== 'security') return notifyEmptyResult('account closed');
            $channels = array_values(array_intersect($channels, ['email']));
            if (!$channels) return notifyEmptyResult('account closed');
            $toEmail = null;
            $toPhone = null;
        }
        if ($toEmail !== null && $toEmail !== mb_strtolower((string) $recipient['email'])) {
            $recipient['email'] = $toEmail;
            $recipient['email_verified'] = false;
        } else {
            $toEmail = null;
        }
        if ($toPhone !== null && $toPhone !== preg_replace('/\D+/', '', (string) $recipient['phone'])) {
            $recipient['phone'] = $toPhone;
            $recipient['phone_verified'] = false;
        } else {
            $toPhone = null;
        }
    } else {
        if ($toEmail === null && $toPhone === null) return notifyEmptyResult('no recipient');
        $recipient = [
            'devotee_id' => null, 'name' => '', 'email' => $toEmail, 'email_verified' => false,
            'phone' => $toPhone, 'phone_verified' => false, 'country' => null, 'lang' => 'ta',
            'timezone' => notifyTempleTz(), 'prefs' => null, 'active' => true, 'devices' => 0,
        ];
        if (!empty($n['_test'])) $recipient['test'] = true;
    }
    if (is_string($n['name'] ?? null) && trim($n['name']) !== '') {
        $recipient['name'] = sanitizeText($n['name'], 200);
    }
    if (is_string($n['lang'] ?? null) && isset(notifyLanguages()[strtolower(trim($n['lang']))])) {
        $recipient['lang'] = strtolower(trim($n['lang']));
    }
    $lang = (string) $recipient['lang'];

    /* ── When ───────────────────────────────────────────────────────────── */
    $deliverAfter = null;
    if (is_string($n['deliver_after'] ?? null) && trim($n['deliver_after']) !== '') {
        $t = strtotime(trim($n['deliver_after']) . ' UTC');
        if ($t !== false) {
            $candidate = gmdate('Y-m-d H:i:s', $t);
            if ($candidate > $now) $deliverAfter = $candidate;
        }
    }
    $recipient['deliver_after'] = $deliverAfter;

    /* ── Variables, with secrets kept out ───────────────────────────────── */
    $vars = [];
    foreach ((array) ($n['vars'] ?? []) as $k => $v) {
        if (!is_string($k) || !preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $k)) continue;
        if ($v === null || is_bool($v) || is_int($v) || is_float($v)) $vars[$k] = $v;
        elseif (is_string($v)) $vars[$k] = mb_substr($v, 0, 2000);
    }
    $secretVars = [];
    foreach ((array) ($n['secret_vars'] ?? []) as $k => $v) {
        if (is_string($k) && preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $k) && is_scalar($v)) $secretVars[$k] = (string) $v;
    }
    foreach (array_keys($secretVars) as $k) unset($vars[$k]); // a secret passed twice is still a secret
    if ($secretVars) $vars['_secret'] = array_keys($secretVars);
    $details = notifyCleanDetails($n['details'] ?? null);
    if ($details) $vars['_details'] = $details;
    $prefix = is_string($n['title_prefix'] ?? null) ? mb_substr($n['title_prefix'], 0, 20) : '';
    if ($prefix !== '') $vars['_titlePrefix'] = $prefix;

    /* ── The link ───────────────────────────────────────────────────────── */
    $ctaUrl = null;
    if (array_key_exists('cta_url', $n) && $n['cta_url'] !== null && $n['cta_url'] !== '') {
        $ctaUrl = notifySafeCtaUrl(is_string($n['cta_url']) ? $n['cta_url'] : null);
        if ($ctaUrl === null) error_log('[notify] an unsafe cta_url was dropped');
    }
    if ($ctaUrl === null && !empty($defaults['cta_path'])) {
        $ctaUrl = notifySafeCtaUrl(notifyInterpolate((string) $defaults['cta_path'], notifyRenderVars($vars, $recipient, null, [], true)));
    }

    /* ── The stored copy, in the recipient's language ───────────────────── */
    $renderVars = notifyRenderVars($vars, $recipient, notifyAbsoluteUrl($ctaUrl), $secretVars, true);
    if ($template !== null) {
        $r        = notifyRender($template, $lang, 'any', $renderVars);
        $title    = $r['title'];
        $body     = $r['body'];
        $ctaLabel = $r['cta_label'];
    } else {
        $title    = notifyInterpolate((string) notifyPickLang($n['title'], $lang), $renderVars);
        $body     = notifyInterpolate((string) notifyPickLang($n['body'], $lang), $renderVars);
        $ctaLabel = notifyInterpolate((string) notifyPickLang($n['cta_label'] ?? null, $lang), $renderVars);
    }
    $labelOverride = notifyPickLang($n['cta_label'] ?? null, $lang);
    if ($template !== null && $labelOverride !== null) {
        $ctaLabel = notifyInterpolate($labelOverride, $renderVars);
        $vars['_ctaLabel'] = mb_substr($labelOverride, 0, 80);
    }
    $title = trim((string) preg_replace('/\s+/u', ' ', $prefix . $title));
    if ($title === '' || $title === trim($prefix)) $title = trim($prefix . notifyCategoryLabel($category, $lang));
    $body = mb_substr(trim($body), 0, 60000);
    $ctaLabel = trim($ctaLabel);

    /* ── Which channels ─────────────────────────────────────────────────── */
    $isCampaign = (int) ($n['campaign_id'] ?? 0) > 0 || !empty($n['_campaign']);
    $decisions  = notifyAllowedChannels($channels, $category, $priority, $recipient, $isCampaign, $fallbacks);
    $showInApp  = isset($decisions['inapp']) && $decisions['inapp']['status'] !== 'skipped';

    $imageUrl   = is_string($n['image_url'] ?? null) ? notifySafeCtaUrl($n['image_url']) : null;
    $entityType = is_string($n['entity_type'] ?? null) && preg_match('/^[a-z_]{1,32}$/', $n['entity_type']) ? $n['entity_type'] : null;
    $entityId   = isset($n['entity_id']) && is_numeric($n['entity_id']) && (int) $n['entity_id'] > 0 ? (int) $n['entity_id'] : null;
    $event      = is_string($n['event'] ?? null) ? mb_substr($n['event'], 0, 64) : null;
    $dedupeKey  = notifyDedupeKey($n['dedupe_key'] ?? null);
    $campaignId = (int) ($n['campaign_id'] ?? 0) > 0 ? (int) $n['campaign_id'] : null;
    $actor      = is_string($n['actor'] ?? null) && trim($n['actor']) !== '' ? mb_substr(trim($n['actor']), 0, 120) : 'system';

    /* ── Write it: the notification and its deliveries together ─────────── */
    $ownTx = !$db->inTransaction();
    if ($ownTx) $db->beginTransaction();
    try {
        $db->prepare(
            'INSERT INTO notifications
                (campaign_id, run_no, devotee_id, recipient_type, to_email, to_phone, lang, template_key, event,
                 category, priority, title, body, cta_url, cta_label, image_url, entity_type, entity_id, vars,
                 dedupe_key, show_in_app, deliver_after, created_by, created_at)
             VALUES
                (:campaign, :run, :devotee, :rtype, :email, :phone, :lang, :template, :event,
                 :category, :priority, :title, :body, :cta, :cta_label, :image, :etype, :eid, :vars,
                 :dedupe, :show, :after, :actor, :now)'
        )->execute([
            ':campaign'  => $campaignId,
            ':run'       => max(0, min(65535, (int) ($n['run_no'] ?? 0))),
            ':devotee'   => $recipient['devotee_id'],
            ':rtype'     => $recipient['devotee_id'] ? 'devotee' : 'guest',
            ':email'     => $recipient['devotee_id'] ? $toEmail : $recipient['email'],
            ':phone'     => $recipient['devotee_id'] ? $toPhone : $recipient['phone'],
            ':lang'      => mb_substr($lang, 0, 8),
            ':template'  => $template,
            ':event'     => $event,
            ':category'  => $category,
            ':priority'  => $priority,
            ':title'     => mb_substr($title, 0, 200),
            ':body'      => $body,
            ':cta'       => $ctaUrl,
            ':cta_label' => $ctaLabel === '' ? null : mb_substr($ctaLabel, 0, 80),
            ':image'     => $imageUrl,
            ':etype'     => $entityType,
            ':eid'       => $entityId,
            ':vars'      => $vars ? json_encode($vars, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
            ':dedupe'    => $dedupeKey,
            ':show'      => $showInApp ? 1 : 0,
            ':after'     => $deliverAfter,
            ':actor'     => $actor,
            ':now'       => $now,
        ]);
        $notificationId = (int) $db->lastInsertId();

        $deliveries = [];
        $insert = $db->prepare(
            'INSERT INTO notification_deliveries
                (notification_id, channel, status, priority_rank, max_attempts, next_attempt_at, skip_reason, sent_at, created_at, updated_at)
             VALUES (:n, :c, :s, :rank, :max, :next, :skip, :sent, :now1, :now2)'
        );
        foreach ($decisions as $channel => $decision) {
            $status = $decision['status'];
            $insert->execute([
                ':n'    => $notificationId,
                ':c'    => $channel,
                ':s'    => $status,
                ':rank' => NOTIFY_PRIORITY_RANK[$priority],
                ':max'  => NOTIFY_MAX_ATTEMPTS[$channel],
                ':next' => $status === 'queued' ? $deliverAfter : null,
                ':skip' => $status === 'skipped' ? mb_substr((string) $decision['reason'], 0, 120) : null,
                ':sent' => $status === 'sent' ? $now : null,
                ':now1' => $now,
                ':now2' => $now,
            ]);
            $deliveryId = (int) $db->lastInsertId();
            $detail = match ($status) {
                'skipped' => (string) $decision['reason'],
                'sent'    => 'visible in the app',
                default   => $deliverAfter !== null ? 'held until ' . notifyIso($deliverAfter) : null,
            };
            if (!empty($decision['fallbackFor'])) {
                $detail = trim(($detail ?? '') . ' (instead of ' . $decision['fallbackFor'] . ', which is not configured)');
            }
            notifyDeliveryEvent($deliveryId, $status, $detail);
            $deliveries[$channel] = ['id' => $deliveryId, 'status' => $status, 'reason' => $decision['reason'], 'recordedOnly' => false];
        }
        if ($ownTx) $db->commit();
    } catch (PDOException $e) {
        if ($ownTx && $db->inTransaction()) $db->rollBack();
        if ($dedupeKey !== null && (int) ($e->errorInfo[1] ?? 0) === 1062 && str_contains($e->getMessage(), 'uniq_dedupe')) {
            return notifyDedupedResult($dedupeKey);
        }
        throw $e;
    } catch (Throwable $e) {
        if ($ownTx && $db->inTransaction()) $db->rollBack();
        throw $e;
    }

    /* ── Send now, when the caller cannot wait for the worker ───────────── */
    if ((!empty($n['sync']) || $secretVars) && $deliverAfter === null) {
        foreach ($deliveries as $channel => $d) {
            if ($channel === 'inapp' || $d['status'] !== 'queued') continue;
            $r = notifyDispatchDelivery($d['id'], $secretVars);
            $deliveries[$channel] = ['id' => $d['id'], 'status' => $r['status'], 'reason' => $r['reason'], 'recordedOnly' => $r['recordedOnly']];
        }
    }

    return ['id' => $notificationId, 'deduped' => false, 'skipped' => null, 'deliveries' => $deliveries];
}

/** The result for a dedupe key that already has its notification. */
function notifyDedupedResult(string $dedupeKey): array
{
    $stmt = getDB()->prepare('SELECT id FROM notifications WHERE dedupe_key = :k');
    $stmt->execute([':k' => $dedupeKey]);
    $id = (int) $stmt->fetchColumn();
    $result = notifyEmptyResult(null, true, $id ?: null);
    if ($id) {
        $stmt = getDB()->prepare('SELECT id, channel, status, skip_reason, failure_reason, provider FROM notification_deliveries WHERE notification_id = :n ORDER BY id');
        $stmt->execute([':n' => $id]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $d) {
            $result['deliveries'][$d['channel']] = [
                'id' => (int) $d['id'], 'status' => $d['status'],
                'reason' => $d['skip_reason'] ?? $d['failure_reason'], 'recordedOnly' => $d['provider'] === 'log',
            ];
        }
    }
    return $result;
}
