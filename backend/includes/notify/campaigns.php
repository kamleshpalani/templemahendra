<?php
/**
 * backend/includes/notify/campaigns.php — messages the committee composes and
 * sends to many devotees (SPEC §5.8).
 *
 *   draft → review → approved → scheduled → sending → completed
 *                                   (plus cancelled and failed)
 *
 * WHY A SECOND PAIR OF EYES. A broadcast to hundreds of devotees, a paid SMS
 * run or an "urgent" banner cannot be taken back. So a campaign that crosses any
 * of the lines in notifyCampaignNeedsApproval() waits for an owner who did not
 * write it. Everything smaller is approved automatically, and says so in the
 * audit trail.
 *
 * THE RULES LIVE HERE, NOT IN THE PAGE. Every function that changes a campaign
 * takes the acting admin (['username' => …, 'role' => 'owner'|'editor'|'viewer'])
 * and checks the capability itself, so a page that forgets a check, or a
 * hand-crafted POST, still cannot approve its own broadcast.
 *
 * SCALE. Nothing here sends. Approval only makes a campaign due; the worker
 * expands it into per-devotee notifications 500 at a time within its time
 * budget, remembering where it stopped (expand_cursor), and the queue delivers
 * them. The dedupe key campaign:{id}:{run}:{devotee} makes a restarted
 * expansion harmless.
 */

require_once __DIR__ . '/queue.php';
require_once __DIR__ . '/audience.php';

const NOTIFY_CAMPAIGN_EDITABLE      = ['draft', 'review', 'approved', 'scheduled'];
const NOTIFY_CAMPAIGN_CANCELLABLE   = ['draft', 'review', 'approved', 'scheduled', 'sending'];
const NOTIFY_RECURRENCES            = ['none', 'daily', 'weekly', 'monthly'];
const NOTIFY_EXPAND_BATCH           = 500;
/** UTC+14 (Kiribati) is the first place on Earth to reach a wall-clock time… */
const NOTIFY_RECIPIENT_LEAD_SECONDS = 50400;
/** …and UTC−12 the last. */
const NOTIFY_RECIPIENT_LAG_SECONDS  = 43200;

/* ── Who is acting ──────────────────────────────────────────────────────── */

function notifyActorRole(array $actor): string
{
    $role = $actor['role'] ?? null;
    return in_array($role, ['viewer', 'editor', 'owner'], true) ? $role : 'viewer';
}

function notifyActorName(array $actor): string
{
    $name = is_string($actor['username'] ?? null) ? trim($actor['username']) : '';
    return $name === '' ? 'system' : mb_substr($name, 0, 120);
}

/** The notification capabilities of SPEC §8.1, checked against the actor's role. An actor without a role is a viewer. */
function notifyActorCan(array $actor, string $capability): bool
{
    $rank = ['viewer' => 0, 'editor' => 1, 'owner' => 2];
    $need = [
        'notifications.view'      => 'viewer',
        'notifications.compose'   => 'editor',
        'notifications.approve'   => 'owner',
        'notifications.templates' => 'owner',
    ][$capability] ?? 'owner';
    return $rank[notifyActorRole($actor)] >= $rank[$need];
}

/** The system itself, for reminders and expansion. */
function notifySystemActor(): array
{
    return ['username' => 'system', 'role' => null];
}

/* ── Audit ──────────────────────────────────────────────────────────────── */

/** Record what happened to a campaign, with the message as it stood. Never throws. */
function notifyAudit(?int $campaignId, string $action, array $actor, array $detail = []): void
{
    try {
        if (!notifyTablesExist()) return;
        $db   = getDB();
        $name = null;
        if ($campaignId !== null && $campaignId > 0) {
            $stmt = $db->prepare('SELECT name FROM notification_campaigns WHERE id = :id');
            $stmt->execute([':id' => $campaignId]);
            $name = $stmt->fetchColumn();
            if ($name === false) {
                $name = null;
                $campaignId = null;
            }
        } else {
            $campaignId = null;
        }
        $json = json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
        if ($json === false || strlen($json) > 60000) {
            $json = json_encode(['truncated' => true, 'keys' => array_keys($detail)]);
        }
        $role = $actor['role'] ?? null;
        $ip   = isset($_SERVER['REMOTE_ADDR']) ? (function_exists('clientIp') ? clientIp() : (string) $_SERVER['REMOTE_ADDR']) : null;
        $db->prepare(
            'INSERT INTO notification_audit (campaign_id, campaign_name, action, actor, actor_role, detail, ip, created_at)
             VALUES (:c, :n, :a, :actor, :role, :d, :ip, :now)'
        )->execute([
            ':c' => $campaignId, ':n' => $name, ':a' => mb_substr($action, 0, 32),
            ':actor' => notifyActorName($actor), ':role' => in_array($role, ['viewer', 'editor', 'owner'], true) ? $role : null,
            ':d' => $json, ':ip' => $ip !== null ? mb_substr($ip, 0, 45) : null, ':now' => notifyNow(),
        ]);
    } catch (Throwable $e) {
        error_log('[notify] audit failed: ' . $e->getMessage());
    }
}

/* ── Reading ────────────────────────────────────────────────────────────── */

/** The campaign row with translations, resolved rules, channel list and decoded template variables. No stats. */
function notifyCampaignLoad(int $id): ?array
{
    if ($id < 1 || !notifyTablesExist()) return null;
    $db   = getDB();
    $stmt = $db->prepare('SELECT * FROM notification_campaigns WHERE id = :id');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    $stmt = $db->prepare(
        "SELECT lang, title, body, cta_label FROM notification_campaign_translations
          WHERE campaign_id = :id ORDER BY lang = 'ta' DESC, lang = 'en' DESC, lang"
    );
    $stmt->execute([':id' => $id]);
    $row['translations'] = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $t) {
        $row['translations'][(string) $t['lang']] = ['title' => (string) $t['title'], 'body' => (string) $t['body'], 'cta_label' => $t['cta_label']];
    }

    $row['segment'] = null;
    $rules = null;
    if ($row['segment_id'] !== null) {
        $stmt = $db->prepare('SELECT id, name, rules FROM notification_segments WHERE id = :id');
        $stmt->execute([':id' => (int) $row['segment_id']]);
        $segment = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($segment) {
            $row['segment'] = ['id' => (int) $segment['id'], 'name' => (string) $segment['name']];
            $rules = json_decode((string) $segment['rules'], true);
        }
    } else {
        $rules = json_decode((string) ($row['audience'] ?? ''), true);
    }
    $row['rules']        = is_array($rules) ? $rules : null;
    $row['channelsList'] = array_values(array_intersect(NOTIFY_CHANNELS, explode(',', (string) $row['channels'])));
    $vars = json_decode((string) ($row['template_vars'] ?? ''), true);
    $row['templateVars'] = is_array($vars) ? $vars : [];
    return $row;
}

/** row + 'translations' => [lang => …] + 'rules' + 'segment' + 'channelsList' + 'templateVars' + 'stats' */
function notifyCampaignGet(int $id): ?array
{
    $c = notifyCampaignLoad($id);
    if ($c === null) return null;
    $c['stats'] = notifyCampaignStats($id);
    return $c;
}

/** ['recipients','byChannel' => [channel => [status => count]],'opened','clicked','read','failed','dead'] */
function notifyCampaignStats(int $id): array
{
    $out = ['recipients' => 0, 'byChannel' => [], 'opened' => 0, 'clicked' => 0, 'read' => 0, 'failed' => 0, 'dead' => 0];
    if ($id < 1 || !notifyTablesExist()) return $out;
    try {
        $db = getDB();
        $stmt = $db->prepare('SELECT COUNT(*) AS recipients, SUM(read_at IS NOT NULL) AS was_read FROM notifications WHERE campaign_id = :id');
        $stmt->execute([':id' => $id]);
        $n = $stmt->fetch(PDO::FETCH_ASSOC);
        $out['recipients'] = (int) $n['recipients'];
        $out['read']       = (int) $n['was_read'];

        $stmt = $db->prepare(
            'SELECT d.channel, d.status, COUNT(*) AS n,
                    SUM(d.channel = \'email\' AND d.read_at IS NOT NULL) AS opened,
                    SUM(d.clicked_at IS NOT NULL) AS clicked
               FROM notification_deliveries d
               JOIN notifications x ON x.id = d.notification_id
              WHERE x.campaign_id = :id
              GROUP BY d.channel, d.status'
        );
        $stmt->execute([':id' => $id]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $out['byChannel'][(string) $r['channel']][(string) $r['status']] = (int) $r['n'];
            $out['opened']  += (int) $r['opened'];
            $out['clicked'] += (int) $r['clicked'];
            if ($r['status'] === 'failed' || $r['status'] === 'rejected') $out['failed'] += (int) $r['n'];
            if ($r['status'] === 'dead') $out['dead'] += (int) $r['n'];
        }
    } catch (Throwable $e) {
        error_log('[notify] campaign stats failed: ' . $e->getMessage());
    }
    return $out;
}

/**
 * Why this campaign needs a second approval, or null when it does not.
 * $campaign is a notifyCampaignGet() row or unsaved input of the same shape.
 */
function notifyCampaignNeedsApproval(array $campaign, int $estimate): ?string
{
    $raw       = notifyEnv('NOTIFY_APPROVAL_THRESHOLD', '50');
    $threshold = ctype_digit($raw) ? (int) $raw : 50;
    if ($estimate > $threshold) return "Reaches {$estimate} devotees";

    if (in_array($campaign['priority'] ?? 'normal', ['urgent', 'emergency'], true)) return 'Urgent/emergency priority';

    $channels = $campaign['channelsList'] ?? ($campaign['channels'] ?? []);
    if (is_string($channels)) $channels = explode(',', $channels);
    if (array_intersect(['whatsapp', 'sms'], (array) $channels) && $estimate > 10) return "Paid channels to {$estimate} devotees";

    if (notifyCategoryKind((string) ($campaign['category'] ?? '')) === 'promotional') return 'Promotional message';
    return null;
}

/* ── Saving ─────────────────────────────────────────────────────────────── */

/** 'Y-m-d H:i:00' from what an admin typed ('Y-m-d H:i', seconds or the datetime-local 'T' form), or null. */
function notifyParseLocal(mixed $value): ?string
{
    if (!is_string($value)) return null;
    $s = trim(str_replace('T', ' ', $value));
    foreach (['Y-m-d H:i:s', 'Y-m-d H:i'] as $format) {
        $p = date_parse_from_format($format, $s);
        if ($p['error_count'] === 0 && $p['warning_count'] === 0 && $p['year'] >= 2000 && $p['year'] <= 2100) {
            return sprintf('%04d-%02d-%02d %02d:%02d:00', $p['year'], $p['month'], $p['day'], $p['hour'], $p['minute']);
        }
    }
    return null;
}

/** "20 Sep 2026, 6:00 pm IST" — how the admin reads a UTC instant. */
function notifyTempleTimeLabel(string $utc): string
{
    $tz = notifyTempleTz();
    return notifyFromUtc($utc, $tz, 'j M Y, g:i a') . ' ' . ($tz === 'Asia/Kolkata' ? 'IST' : $tz);
}

/** The parts of a campaign worth keeping in the audit trail. */
function notifyCampaignSnapshot(array $c): array
{
    $keep = ['name', 'status', 'category', 'priority', 'channels', 'cta_url', 'image_url', 'template_key', 'template_vars',
             'segment_id', 'audience', 'schedule_tz', 'scheduled_local', 'recurrence', 'recur_until', 'estimated_count'];
    return array_intersect_key($c, array_flip($keep)) + ['translations' => $c['translations'] ?? []];
}

/**
 * Check composer input. Returns [columns, translations, errors]; errors are
 * keyed by field ('translations.en.body' for one language's message).
 */
function notifyCampaignValidate(array $in, ?array $existing): array
{
    $errors = [];
    $data   = [];

    $name = is_string($in['name'] ?? null) ? trim((string) preg_replace('/\s+/u', ' ', $in['name'])) : '';
    if ($name === '') $errors['name'] = 'Give it a name the committee will recognise.';
    elseif (mb_strlen($name) > 160) $errors['name'] = 'Keep the name under 160 characters.';
    $data['name'] = $name;

    $category = is_string($in['category'] ?? null) ? trim($in['category']) : '';
    $cat = $category !== '' ? notifyCategory($category) : null;
    if ($cat === null || ($cat['is_active'] !== 1 && ($existing['category'] ?? null) !== $category)) $errors['category'] = 'Choose a category.';
    $data['category'] = $category;

    $priority = $in['priority'] ?? 'normal';
    if (!in_array($priority, NOTIFY_PRIORITIES, true)) {
        $errors['priority'] = 'Choose a priority.';
        $priority = 'normal';
    }
    $data['priority'] = $priority;

    $channels = $in['channels'] ?? [];
    if (is_string($channels)) $channels = explode(',', $channels);
    $channels = array_values(array_intersect(NOTIFY_CHANNELS, array_map(static fn($c) => strtolower(trim((string) $c)), (array) $channels)));
    if (!$channels) $errors['channels'] = 'Choose at least one channel.';
    $data['channels'] = implode(',', $channels);

    foreach (['cta_url' => 'Use a site path such as /sevas, or an address starting with https://.',
              'image_url' => 'Use a site path such as /images/festival.jpg, or an address starting with https://.'] as $field => $message) {
        $value = is_string($in[$field] ?? null) ? trim($in[$field]) : '';
        if ($value === '') {
            $data[$field] = null;
        } elseif (($safe = notifySafeCtaUrl($value)) === null) {
            $errors[$field] = $message;
            $data[$field] = null;
        } else {
            $data[$field] = $safe;
        }
    }

    $templateKey = is_string($in['template_key'] ?? null) ? trim($in['template_key']) : '';
    if ($templateKey === '') {
        $data['template_key'] = null;
    } elseif (notifyTemplate($templateKey, 'ta', 'any') === null) {
        $errors['template_key'] = 'Choose a template from the list.';
        $data['template_key'] = null;
    } else {
        $data['template_key'] = $templateKey;
    }

    $vars = $in['template_vars'] ?? [];
    if (is_string($vars)) $vars = trim($vars) === '' ? [] : json_decode($vars, true);
    $cleanVars = [];
    if (!is_array($vars)) {
        $errors['template_vars'] = 'Template values must be text.';
    } else {
        foreach ($vars as $k => $v) {
            if (!is_string($k) || !preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $k)) {
                $errors['template_vars'] = 'Template value names use letters, digits and underscores.';
                continue;
            }
            if (is_array($v)) {
                $map = [];
                foreach ($v as $l => $text) {
                    if (is_string($l) && preg_match('/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/', $l) && is_scalar($text)) $map[$l] = mb_substr((string) $text, 0, 2000);
                }
                $cleanVars[$k] = $map;
            } elseif ($v === null || is_scalar($v)) {
                $cleanVars[$k] = is_string($v) ? mb_substr($v, 0, 2000) : $v;
            } else {
                $errors['template_vars'] = 'Template values must be text.';
            }
        }
    }
    // An automatic reminder keeps its identity through an edit, or the next worker
    // run would not recognise it and create a second reminder.
    if (isset($existing['templateVars']['reminderKey']) && !isset($cleanVars['reminderKey'])) {
        $cleanVars['reminderKey'] = $existing['templateVars']['reminderKey'];
    }
    $data['template_vars'] = $cleanVars ? json_encode($cleanVars, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;

    $segmentId = $in['segment_id'] ?? null;
    $data['segment_id'] = null;
    $data['audience']   = null;
    if ($segmentId !== null && $segmentId !== '' && (int) $segmentId !== 0) {
        $stmt = getDB()->prepare('SELECT id FROM notification_segments WHERE id = :id');
        $stmt->execute([':id' => (int) $segmentId]);
        if ($stmt->fetchColumn() === false) $errors['segment_id'] = 'That saved audience no longer exists.';
        else $data['segment_id'] = (int) $segmentId;
    } else {
        $audience = $in['audience'] ?? null;
        if ($audience === null || $audience === '' || $audience === []) {
            $errors['audience'] = 'Choose who should receive this.';
        } else {
            try {
                $data['audience'] = json_encode(notifyAudienceNormalize(is_string($audience) ? $audience : (array) $audience), JSON_UNESCAPED_UNICODE);
            } catch (InvalidArgumentException $e) {
                $errors['audience'] = $e->getMessage();
            }
        }
    }

    $langs = notifyLanguages();
    $translations = [];
    $given = $in['translations'] ?? [];
    foreach (is_array($given) ? $given : [] as $lang => $t) {
        $lang = strtolower((string) $lang);
        if (!isset($langs[$lang])) {
            $errors['translations.' . $lang] = 'That language is not offered on this site.';
            continue;
        }
        $t     = is_array($t) ? $t : [];
        $title = is_string($t['title'] ?? null) ? trim((string) preg_replace('/\s+/u', ' ', $t['title'])) : '';
        $body  = is_string($t['body'] ?? null) ? trim(str_replace(["\r\n", "\r"], "\n", $t['body'])) : '';
        $label = is_string($t['cta_label'] ?? null) ? trim($t['cta_label']) : '';
        if ($title === '' && $body === '') continue;
        if ($title === '') $errors["translations.{$lang}.title"] = 'Add a title.';
        if ($body === '') $errors["translations.{$lang}.body"] = 'Add the message.';
        if (mb_strlen($title) > 200) $errors["translations.{$lang}.title"] = 'Keep the title under 200 characters.';
        if (mb_strlen($body) > 20000) $errors["translations.{$lang}.body"] = 'Keep the message under 20,000 characters.';
        if (mb_strlen($label) > 80) $errors["translations.{$lang}.cta_label"] = 'Keep the button label under 80 characters.';
        $translations[$lang] = ['title' => $title, 'body' => $body, 'cta_label' => $label === '' ? null : $label];
    }
    if (!$translations) $errors['translations'] = 'Write the title and message in at least one language.';

    $tz = $in['schedule_tz'] ?? 'temple';
    if (!in_array($tz, ['temple', 'recipient'], true)) {
        $errors['schedule_tz'] = 'Choose the temple\'s time or each devotee\'s own time.';
        $tz = 'temple';
    }
    $data['schedule_tz'] = $tz;

    $localRaw = $in['scheduled_local'] ?? null;
    $local = null;
    if ($localRaw !== null && $localRaw !== '') {
        $local = notifyParseLocal($localRaw);
        if ($local === null) $errors['scheduled_local'] = 'Enter a date and time, such as 2026-10-02 18:00.';
    }
    $data['scheduled_local'] = $local;

    $recurrence = $in['recurrence'] ?? 'none';
    if (!in_array($recurrence, NOTIFY_RECURRENCES, true)) {
        $errors['recurrence'] = 'Choose how often it repeats.';
        $recurrence = 'none';
    }
    if ($recurrence !== 'none' && $local === null && !isset($errors['scheduled_local'])) {
        $errors['scheduled_local'] = 'Set the first send time for a repeating notification.';
    }
    $data['recurrence'] = $recurrence;

    $until = is_string($in['recur_until'] ?? null) ? trim($in['recur_until']) : '';
    $data['recur_until'] = null;
    if ($recurrence !== 'none' && $until !== '') {
        if (!isValidDate($until)) $errors['recur_until'] = 'Enter the last date, such as 2026-12-31.';
        elseif ($local !== null && $until < substr($local, 0, 10)) $errors['recur_until'] = 'The last date must be on or after the first send.';
        else $data['recur_until'] = $until;
    }

    return [$data, $translations, $errors];
}

/**
 * Create ($id null) or edit a campaign. Editing one that is in review, approved
 * or scheduled returns it to draft — the approval was for the old words.
 *
 * Returns ['ok' => bool, 'id' => ?int, 'errors' => [field => message]]
 */
function notifyCampaignSave(array $input, array $actor, ?int $id = null): array
{
    $fail = static fn(array $errors) => ['ok' => false, 'id' => $id, 'errors' => $errors];
    if (!notifyTablesExist()) return $fail(['_' => 'Notifications are not available on this site yet.']);
    if (!notifyActorCan($actor, 'notifications.compose')) return $fail(['_' => 'Your role can read notifications but not write them.']);

    $db = getDB();
    try {
        $existing = null;
        if ($id !== null) {
            $existing = notifyCampaignLoad($id);
            if ($existing === null) return $fail(['_' => 'That notification no longer exists.']);
            if (!in_array($existing['status'], NOTIFY_CAMPAIGN_EDITABLE, true)) {
                return $fail(['_' => 'A notification that is sending, finished, cancelled or failed cannot be changed. Duplicate it instead.']);
            }
        }
        [$data, $translations, $errors] = notifyCampaignValidate($input, $existing);
        if ($errors) return $fail($errors);

        $who = notifyActorName($actor);
        $now = notifyNow();
        $approvalVoid = $existing !== null && $existing['status'] !== 'draft';

        $db->beginTransaction();
        $params = [
            ':name' => $data['name'], ':category' => $data['category'], ':priority' => $data['priority'], ':channels' => $data['channels'],
            ':cta' => $data['cta_url'], ':image' => $data['image_url'], ':tkey' => $data['template_key'], ':tvars' => $data['template_vars'],
            ':segment' => $data['segment_id'], ':audience' => $data['audience'], ':tz' => $data['schedule_tz'],
            ':local' => $data['scheduled_local'], ':recur' => $data['recurrence'], ':until' => $data['recur_until'],
            ':by' => $who, ':now' => $now,
        ];
        if ($existing === null) {
            $db->prepare(
                "INSERT INTO notification_campaigns
                    (name, category, priority, channels, cta_url, image_url, template_key, template_vars, segment_id, audience,
                     status, schedule_tz, scheduled_local, recurrence, recur_until, created_by, updated_by, created_at, updated_at)
                 VALUES (:name, :category, :priority, :channels, :cta, :image, :tkey, :tvars, :segment, :audience,
                     'draft', :tz, :local, :recur, :until, :by, :by2, :now, :now2)"
            )->execute($params + [':by2' => $who, ':now2' => $now]);
            $id = (int) $db->lastInsertId();
        } else {
            $reset = $approvalVoid
                ? ", status = 'draft', requires_approval = 0, approval_reason = NULL, submitted_by = NULL, submitted_at = NULL,
                     approved_by = NULL, approved_at = NULL, scheduled_at = NULL, next_run_at = NULL"
                : '';
            $stmt = $db->prepare(
                "UPDATE notification_campaigns
                    SET name = :name, category = :category, priority = :priority, channels = :channels, cta_url = :cta,
                        image_url = :image, template_key = :tkey, template_vars = :tvars, segment_id = :segment, audience = :audience,
                        schedule_tz = :tz, scheduled_local = :local, recurrence = :recur, recur_until = :until,
                        updated_by = :by, updated_at = :now{$reset}
                  WHERE id = :id AND status = :from"
            );
            $stmt->execute($params + [':id' => $id, ':from' => $existing['status']]);
            if ($stmt->rowCount() === 0) {
                // rowCount is 0 both for "status changed under us" and "nothing changed"; tell them apart.
                $check = $db->prepare('SELECT status FROM notification_campaigns WHERE id = :id');
                $check->execute([':id' => $id]);
                if ($check->fetchColumn() !== $existing['status']) {
                    $db->rollBack();
                    return $fail(['_' => 'It changed while you were editing (someone approved, scheduled or sent it). Reload and try again.']);
                }
            }
            $db->prepare('DELETE FROM notification_campaign_translations WHERE campaign_id = :id')->execute([':id' => $id]);
        }
        $ins = $db->prepare('INSERT INTO notification_campaign_translations (campaign_id, lang, title, body, cta_label) VALUES (:c, :l, :t, :b, :cta)');
        foreach ($translations as $lang => $t) {
            $ins->execute([':c' => $id, ':l' => $lang, ':t' => $t['title'], ':b' => $t['body'], ':cta' => $t['cta_label']]);
        }
        $db->commit();

        $saved = notifyCampaignLoad($id);
        notifyAudit($id, $existing === null ? 'created' : 'edited', $actor, array_filter([
            'snapshot'        => $saved ? notifyCampaignSnapshot($saved) : null,
            'approval_void'   => $approvalVoid ?: null,
            'previous_status' => $approvalVoid ? $existing['status'] : null,
        ], static fn($v) => $v !== null));
        return ['ok' => true, 'id' => $id, 'errors' => []];
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        error_log('[notify] saving a campaign failed: ' . get_class($e) . ': ' . $e->getMessage());
        return $fail(['_' => 'The notification could not be saved. Please try again.']);
    }
}

/* ── Transitions ────────────────────────────────────────────────────────── */

/** What stops a campaign from being sent as it stands, or null. */
function notifyCampaignProblem(array $c): ?string
{
    $complete = false;
    foreach ($c['translations'] ?? [] as $t) {
        if (trim((string) ($t['title'] ?? '')) !== '' && trim((string) ($t['body'] ?? '')) !== '') $complete = true;
    }
    if (!$complete) return 'Write the title and message in at least one language first.';
    if (!($c['channelsList'] ?? [])) return 'Choose at least one channel first.';
    if (($c['segment_id'] ?? null) !== null && ($c['segment'] ?? null) === null) return 'The saved audience it uses no longer exists. Choose another.';
    if (!is_array($c['rules'] ?? null)) return 'Choose who should receive it first.';
    try {
        notifyAudienceNormalize($c['rules']);
    } catch (InvalidArgumentException $e) {
        return $e->getMessage();
    }
    if (notifyCategory((string) ($c['category'] ?? '')) === null) return 'The category it uses no longer exists. Choose another.';
    return null;
}

/**
 * True when approving one's own campaign is acceptable: the site allows it, or
 * there is no other owner who could approve it (a one-person committee must
 * still be able to send).
 */
function notifyCampaignSelfApprovalAllowed(array $c, string $approver): bool
{
    if ((string) ($c['created_by'] ?? '') !== $approver) return true;
    if (notifyEnv('NOTIFY_ALLOW_SELF_APPROVAL') === '1') return true;

    // The environment admin is always an owner, when it can sign in at all.
    if (notifyEnv('ADMIN_PASS_HASH') !== '' && notifyEnv('ADMIN_USERNAME', 'admin') !== $approver) return false;
    try {
        $stmt = getDB()->prepare("SELECT COUNT(*) FROM admin_users WHERE role = 'owner' AND is_active = 1 AND username <> :u");
        $stmt->execute([':u' => $approver]);
        return (int) $stmt->fetchColumn() === 0;
    } catch (Throwable) {
        return true; // no accounts table: the environment admin is the only account there is
    }
}

/**
 * Move a campaign through its life. Actions: submit, approve, reject, schedule,
 * send_now, emergency_send, cancel, duplicate (SPEC §5.8 table). opts: reason
 * (reject, emergency_send), scheduled_local and schedule_tz (schedule).
 *
 * Returns ['ok' => bool, 'status' => new status, 'message' => human text, 'id' => ?int (duplicate)]
 */
function notifyCampaignTransition(int $id, string $action, array $actor, array $opts = []): array
{
    $res = static fn(bool $ok, string $status, string $message, ?int $newId = null): array => ['ok' => $ok, 'status' => $status, 'message' => $message, 'id' => $newId];
    if (!notifyTablesExist()) return $res(false, '', 'Notifications are not available on this site yet.');

    $db = getDB();
    try {
        $c = notifyCampaignLoad($id);
        if ($c === null) return $res(false, '', 'That notification no longer exists.');
        $status = (string) $c['status'];
        $who    = notifyActorName($actor);
        $now    = notifyNow();
        $deny   = static fn(string $why) => $res(false, $status, $why);
        $raced  = static fn() => $res(false, $status, 'It changed while you were looking at it. Reload and try again.');
        $reason = is_string($opts['reason'] ?? null) ? mb_substr(trim($opts['reason']), 0, 500) : '';

        switch ($action) {
            case 'submit': {
                if (!notifyActorCan($actor, 'notifications.compose')) return $deny('Your role cannot submit notifications.');
                if ($status !== 'draft') return $deny('Only a draft can be submitted.');
                if ($problem = notifyCampaignProblem($c)) return $deny($problem);
                $estimate = notifyAudienceCount($c['rules']);
                if ($estimate === 0) return $deny('No devotee matches this audience, so there is no one to send it to.');
                $why = notifyCampaignNeedsApproval($c, $estimate);

                if ($why !== null) {
                    $stmt = $db->prepare(
                        "UPDATE notification_campaigns
                            SET status = 'review', requires_approval = 1, approval_reason = :why, estimated_count = :n,
                                submitted_by = :who, submitted_at = :now, updated_at = :now2
                          WHERE id = :id AND status = 'draft'"
                    );
                    $stmt->execute([':why' => $why, ':n' => $estimate, ':who' => $who, ':now' => $now, ':now2' => $now, ':id' => $id]);
                    if ($stmt->rowCount() === 0) return $raced();
                    notifyAudit($id, 'submitted', $actor, ['estimate' => $estimate, 'approval_reason' => $why, 'snapshot' => notifyCampaignSnapshot($c)]);
                    return $res(true, 'review', "Sent for approval ({$why}). An owner other than you needs to approve it.");
                }

                $stmt = $db->prepare(
                    "UPDATE notification_campaigns
                        SET status = 'approved', requires_approval = 0, approval_reason = NULL, estimated_count = :n,
                            submitted_by = :who, submitted_at = :now, approved_by = 'system', approved_at = :now2, updated_at = :now3
                      WHERE id = :id AND status = 'draft'"
                );
                $stmt->execute([':n' => $estimate, ':who' => $who, ':now' => $now, ':now2' => $now, ':now3' => $now, ':id' => $id]);
                if ($stmt->rowCount() === 0) return $raced();
                notifyAudit($id, 'submitted', $actor, ['estimate' => $estimate, 'snapshot' => notifyCampaignSnapshot($c)]);
                notifyAudit($id, 'approved', notifySystemActor(), ['reason' => 'below approval threshold', 'estimate' => $estimate]);
                return $res(true, 'approved', 'Approved automatically: it is below every approval threshold. Send it now or schedule it.');
            }

            case 'approve': {
                if (!notifyActorCan($actor, 'notifications.approve')) return $deny('Only an owner can approve notifications.');
                if ($status !== 'review') return $deny('Only a notification waiting for approval can be approved.');
                if (!notifyCampaignSelfApprovalAllowed($c, $who)) {
                    return $deny('You wrote this notification, so another owner needs to approve it.');
                }
                $stmt = $db->prepare(
                    "UPDATE notification_campaigns SET status = 'approved', approved_by = :who, approved_at = :now, updated_at = :now2
                      WHERE id = :id AND status = 'review'"
                );
                $stmt->execute([':who' => $who, ':now' => $now, ':now2' => $now, ':id' => $id]);
                if ($stmt->rowCount() === 0) return $raced();
                notifyAudit($id, 'approved', $actor, ['approval_reason' => $c['approval_reason'], 'estimate' => (int) $c['estimated_count'], 'snapshot' => notifyCampaignSnapshot($c)]);
                return $res(true, 'approved', 'Approved. It can now be sent or scheduled.');
            }

            case 'reject': {
                if (!notifyActorCan($actor, 'notifications.approve')) return $deny('Only an owner can send a notification back.');
                if ($status !== 'review') return $deny('Only a notification waiting for approval can be sent back.');
                if ($reason === '') return $deny('Say what needs to change, so the author can fix it.');
                $stmt = $db->prepare(
                    "UPDATE notification_campaigns SET status = 'draft', submitted_by = NULL, submitted_at = NULL, updated_at = :now
                      WHERE id = :id AND status = 'review'"
                );
                $stmt->execute([':now' => $now, ':id' => $id]);
                if ($stmt->rowCount() === 0) return $raced();
                notifyAudit($id, 'rejected', $actor, ['reason' => $reason, 'snapshot' => notifyCampaignSnapshot($c)]);
                return $res(true, 'draft', 'Sent back to the author as a draft.');
            }

            case 'schedule': {
                if (!notifyActorCan($actor, 'notifications.compose')) return $deny('Your role cannot schedule notifications.');
                if ($status !== 'approved') return $deny('Only an approved notification can be scheduled.');
                $tz = in_array($opts['schedule_tz'] ?? null, ['temple', 'recipient'], true) ? $opts['schedule_tz'] : $c['schedule_tz'];
                $local = array_key_exists('scheduled_local', $opts) ? notifyParseLocal($opts['scheduled_local']) : ($c['scheduled_local'] !== null ? notifyParseLocal((string) $c['scheduled_local']) : null);
                if ($local === null) return $deny('Choose the date and time to send it.');
                if ($c['recurrence'] !== 'none' && $c['recur_until'] !== null && (string) $c['recur_until'] < substr($local, 0, 10)) {
                    return $deny('The first send is after the repeat end date. Change one of them.');
                }

                if ($tz === 'recipient') {
                    // Stored as the wall-clock time itself; the worker starts expanding
                    // when the first time zone reaches it.
                    $nextRun     = $local;
                    $scheduledAt = gmdate('Y-m-d H:i:s', (int) strtotime($local . ' UTC') - NOTIFY_RECIPIENT_LEAD_SECONDS);
                    if ($scheduledAt <= $now) return $deny('That time has already arrived somewhere in the world. Choose a later time.');
                    // gmdate: $local is a wall-clock time parsed as UTC, and PHP's default zone must not shift it.
                    $when = gmdate('j M Y, g:i a', (int) strtotime($local . ' UTC')) . ' in each devotee\'s own time zone';
                } else {
                    $scheduledAt = notifyToUtc($local, notifyTempleTz());
                    $nextRun     = $scheduledAt;
                    if ($scheduledAt <= $now) return $deny('Choose a time in the future.');
                    $when = notifyTempleTimeLabel($scheduledAt);
                }
                $stmt = $db->prepare(
                    "UPDATE notification_campaigns
                        SET status = 'scheduled', schedule_tz = :tz, scheduled_local = :local, scheduled_at = :at,
                            next_run_at = :next, updated_by = :who, updated_at = :now
                      WHERE id = :id AND status = 'approved'"
                );
                $stmt->execute([':tz' => $tz, ':local' => $local, ':at' => $scheduledAt, ':next' => $nextRun, ':who' => $who, ':now' => $now, ':id' => $id]);
                if ($stmt->rowCount() === 0) return $raced();
                notifyAudit($id, 'scheduled', $actor, ['schedule_tz' => $tz, 'scheduled_local' => $local, 'scheduled_at' => $scheduledAt, 'recurrence' => $c['recurrence'], 'snapshot' => notifyCampaignSnapshot($c)]);
                return $res(true, 'scheduled', "Scheduled for {$when}.");
            }

            case 'send_now': {
                if (!notifyActorCan($actor, 'notifications.compose')) return $deny('Your role cannot send notifications.');
                if ($status !== 'approved') return $deny('Only an approved notification can be sent.');
                if ($c['recurrence'] !== 'none') return $deny('A repeating notification is scheduled rather than sent now. Use Schedule.');
                $stmt = $db->prepare(
                    "UPDATE notification_campaigns
                        SET status = 'sending', scheduled_local = NULL, scheduled_at = :now, next_run_at = :now2,
                            expand_cursor = 0, sent_by = :who, updated_at = :now3
                      WHERE id = :id AND status = 'approved'"
                );
                $stmt->execute([':now' => $now, ':now2' => $now, ':who' => $who, ':now3' => $now, ':id' => $id]);
                if ($stmt->rowCount() === 0) return $raced();
                notifyAudit($id, 'sent', $actor, ['mode' => 'send now', 'estimate' => (int) $c['estimated_count'], 'snapshot' => notifyCampaignSnapshot($c)]);
                return $res(true, 'sending', 'Sending has started. Messages go out over the next few minutes.');
            }

            case 'emergency_send': {
                if (!notifyActorCan($actor, 'notifications.approve')) return $deny('Only an owner can send an emergency notification.');
                if (!in_array($status, ['draft', 'review', 'approved'], true)) return $deny('This notification cannot be sent as an emergency in its current state.');
                if ($c['priority'] !== 'emergency') return $deny('Set the priority to emergency first.');
                if ($reason === '') return $deny('Say why this cannot wait for the usual approval.');
                if ($problem = notifyCampaignProblem($c)) return $deny($problem);
                $estimate = notifyAudienceCount($c['rules']);
                if ($estimate === 0) return $deny('No devotee matches this audience, so there is no one to send it to.');

                $stmt = $db->prepare(
                    "UPDATE notification_campaigns
                        SET status = 'sending', requires_approval = 1, approval_reason = :why, estimated_count = :n,
                            submitted_by = COALESCE(submitted_by, :who), submitted_at = COALESCE(submitted_at, :now),
                            approved_by = :who2, approved_at = :now2, sent_by = :who3, recurrence = 'none', recur_until = NULL,
                            scheduled_local = NULL, scheduled_at = :now3, next_run_at = :now4, expand_cursor = 0, updated_at = :now5
                      WHERE id = :id AND status = :from"
                );
                $stmt->execute([
                    ':why' => mb_substr('Emergency override: ' . $reason, 0, 200), ':n' => $estimate, ':who' => $who, ':who2' => $who, ':who3' => $who,
                    ':now' => $now, ':now2' => $now, ':now3' => $now, ':now4' => $now, ':now5' => $now, ':id' => $id, ':from' => $status,
                ]);
                if ($stmt->rowCount() === 0) return $raced();
                notifyAudit($id, 'emergency_override', $actor, [
                    'reason' => $reason, 'estimate' => $estimate, 'previous_status' => $status,
                    'recurrence_dropped' => $c['recurrence'] !== 'none' ? $c['recurrence'] : null, 'snapshot' => notifyCampaignSnapshot($c),
                ]);
                return $res(true, 'sending', "Emergency send started to {$estimate} devotees.");
            }

            case 'cancel': {
                if (!in_array($status, NOTIFY_CAMPAIGN_CANCELLABLE, true)) return $deny('This notification has already finished and cannot be cancelled.');
                $ownDraft = $status === 'draft' && (string) $c['created_by'] === $who;
                if ($ownDraft ? !notifyActorCan($actor, 'notifications.compose') : !notifyActorCan($actor, 'notifications.approve')) {
                    return $deny('Only an owner can cancel a notification that is not your own draft.');
                }
                $db->beginTransaction();
                try {
                    $stmt = $db->prepare(
                        "UPDATE notification_campaigns
                            SET status = 'cancelled', cancelled_by = :who, cancelled_at = :now, next_run_at = NULL, updated_at = :now2
                          WHERE id = :id AND status = :from"
                    );
                    $stmt->execute([':who' => $who, ':now' => $now, ':now2' => $now, ':id' => $id, ':from' => $status]);
                    if ($stmt->rowCount() === 0) {
                        $db->rollBack();
                        return $raced();
                    }
                    // Anything still waiting (or waiting to retry) stays unsent. A
                    // message a worker is sending this second will finish.
                    $db->prepare(
                        "INSERT INTO notification_delivery_events (delivery_id, event, detail, created_at)
                         SELECT d.id, 'cancelled', :detail, :now
                           FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
                          WHERE n.campaign_id = :id AND d.status IN ('queued', 'failed')"
                    )->execute([':detail' => mb_substr('campaign cancelled by ' . $who, 0, 500), ':now' => $now, ':id' => $id]);
                    $upd = $db->prepare(
                        "UPDATE notification_deliveries d JOIN notifications n ON n.id = d.notification_id
                            SET d.status = 'cancelled', d.next_attempt_at = NULL, d.claim_token = NULL
                          WHERE n.campaign_id = :id AND d.status IN ('queued', 'failed')"
                    );
                    $upd->execute([':id' => $id]);
                    $cancelled = $upd->rowCount();
                    // An in-app message held for its time must not appear in the bell later.
                    $db->prepare(
                        "UPDATE notifications n SET n.show_in_app = 0
                          WHERE n.campaign_id = :id AND n.show_in_app = 1
                            AND EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id = n.id AND d.channel = 'inapp' AND d.status = 'cancelled')"
                    )->execute([':id' => $id]);
                    $db->commit();
                } catch (Throwable $e) {
                    if ($db->inTransaction()) $db->rollBack();
                    throw $e;
                }
                notifyAudit($id, 'cancelled', $actor, ['previous_status' => $status, 'deliveries_cancelled' => $cancelled, 'snapshot' => notifyCampaignSnapshot($c)]);
                return $res(true, 'cancelled', $cancelled > 0 ? "Cancelled. {$cancelled} waiting messages will not be sent." : 'Cancelled.');
            }

            case 'duplicate': {
                if (!notifyActorCan($actor, 'notifications.compose')) return $deny('Your role cannot create notifications.');
                $vars = $c['templateVars'];
                unset($vars['reminderKey']); // a copy is the committee's own, not the automatic reminder
                $name = mb_substr($c['name'], 0, 153) . ' (copy)';
                $db->beginTransaction();
                try {
                    $db->prepare(
                        "INSERT INTO notification_campaigns
                            (name, category, priority, channels, cta_url, image_url, template_key, template_vars, segment_id, audience,
                             status, schedule_tz, recurrence, created_by, updated_by, created_at, updated_at)
                         VALUES (:name, :category, :priority, :channels, :cta, :image, :tkey, :tvars, :segment, :audience,
                             'draft', :tz, 'none', :who, :who2, :now, :now2)"
                    )->execute([
                        ':name' => $name, ':category' => $c['category'], ':priority' => $c['priority'], ':channels' => $c['channels'],
                        ':cta' => $c['cta_url'], ':image' => $c['image_url'], ':tkey' => $c['template_key'],
                        ':tvars' => $vars ? json_encode($vars, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null,
                        ':segment' => $c['segment_id'], ':audience' => $c['audience'], ':tz' => $c['schedule_tz'],
                        ':who' => $who, ':who2' => $who, ':now' => $now, ':now2' => $now,
                    ]);
                    $newId = (int) $db->lastInsertId();
                    $ins = $db->prepare('INSERT INTO notification_campaign_translations (campaign_id, lang, title, body, cta_label) VALUES (:c, :l, :t, :b, :cta)');
                    foreach ($c['translations'] as $lang => $t) {
                        $ins->execute([':c' => $newId, ':l' => $lang, ':t' => $t['title'], ':b' => $t['body'], ':cta' => $t['cta_label']]);
                    }
                    $db->commit();
                } catch (Throwable $e) {
                    if ($db->inTransaction()) $db->rollBack();
                    throw $e;
                }
                notifyAudit($id, 'duplicated', $actor, ['new_id' => $newId, 'snapshot' => notifyCampaignSnapshot($c)]);
                notifyAudit($newId, 'created', $actor, ['duplicated_from' => $id, 'snapshot' => notifyCampaignSnapshot(notifyCampaignLoad($newId) ?? $c)]);
                return $res(true, 'draft', 'Copied as a new draft.', $newId);
            }
        }
        return $res(false, $status, 'That is not something a notification can do.');
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        error_log("[notify] campaign {$id} {$action} failed: " . get_class($e) . ': ' . $e->getMessage());
        return $res(false, '', 'That could not be done just now. Please try again.');
    }
}

/* ── Recurrence ─────────────────────────────────────────────────────────── */

/**
 * The next wall-clock occurrence after $local ('Y-m-d H:i:s' in the schedule's
 * zone). Daily +1 day, weekly +7 days, monthly the same day next month clamped
 * to the month's last day. $anchorDay keeps a monthly series on its original
 * day: 31 Jan → 28 Feb → 31 Mar, not 28 Mar. Returns null for 'none'.
 *
 * Arithmetic is done on the wall clock (in UTC, which has no daylight saving)
 * and converted to an instant afterwards, so 9:00 stays 9:00 across a DST change.
 */
function notifyNextOccurrence(string $local, string $recurrence, ?int $anchorDay = null): ?string
{
    $d = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', trim($local), new DateTimeZone('UTC'));
    if ($d === false) throw new InvalidArgumentException('A wall-clock time looks like 2026-10-02 18:00:00.');
    switch ($recurrence) {
        case 'daily':
            return $d->modify('+1 day')->format('Y-m-d H:i:s');
        case 'weekly':
            return $d->modify('+7 days')->format('Y-m-d H:i:s');
        case 'monthly':
            $year  = (int) $d->format('Y');
            $month = (int) $d->format('n') + 1;
            if ($month > 12) {
                $month = 1;
                $year++;
            }
            $day = min($anchorDay ?? (int) $d->format('j'), cal_days_in_month(CAL_GREGORIAN, $month, $year));
            return $d->setDate($year, $month, $day)->format('Y-m-d H:i:s');
    }
    return null;
}

/** The wall-clock time of the run a campaign is on, in its schedule zone. */
function notifyCampaignRunLocal(array $c): ?string
{
    if ($c['scheduled_local'] === null || $c['next_run_at'] === null) return null;
    return $c['schedule_tz'] === 'recipient'
        ? (string) $c['next_run_at']
        : notifyFromUtc((string) $c['next_run_at'], notifyTempleTz());
}

/* ── Expansion (the worker) ─────────────────────────────────────────────── */

/**
 * Expand every due campaign, most urgent first, within the time budget.
 * Returns how many campaigns had devotees expanded.
 */
function notifyCampaignsExpandDue(float $deadline, ?int $onlyCampaignId = null, int $expandLimit = 0): int
{
    $db  = getDB();
    $sql = "SELECT id FROM notification_campaigns
             WHERE ((status IN ('approved', 'scheduled') AND next_run_at IS NOT NULL
                     AND ((schedule_tz = 'temple' AND next_run_at <= :now)
                       OR (schedule_tz = 'recipient' AND next_run_at <= :lead)))
                    OR status = 'sending')";
    $params = [':now' => notifyNow(), ':lead' => notifyNowPlus(NOTIFY_RECIPIENT_LEAD_SECONDS)];
    if ($onlyCampaignId !== null) {
        $sql .= ' AND id = :only';
        $params[':only'] = $onlyCampaignId;
    }
    $sql .= " ORDER BY FIELD(priority, 'emergency', 'urgent', 'important', 'normal'), next_run_at, id LIMIT 50";
    $stmt = $db->prepare($sql);
    $stmt->execute($params);

    $expanded = 0;
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
        if (microtime(true) >= $deadline) break;
        try {
            if (notifyCampaignExpand((int) $id, $deadline, $expandLimit)) $expanded++;
        } catch (Throwable $e) {
            // A database hiccup is not the campaign's fault: note it, try again next run.
            error_log('[notify] expanding campaign ' . $id . ' failed: ' . get_class($e) . ': ' . $e->getMessage());
            try {
                $db->prepare('UPDATE notification_campaigns SET last_error = :e WHERE id = :id')
                   ->execute([':e' => mb_substr($e->getMessage(), 0, 500), ':id' => (int) $id]);
            } catch (Throwable) {
            }
        }
    }
    return $expanded;
}

/** Devotee rows for a batch, with preferences and device counts, keyed by id. */
function notifyCampaignRecipientRows(array $ids): array
{
    if (!$ids) return [];
    $names  = [];
    $params = [];
    foreach (array_values($ids) as $i => $id) {
        $names[] = ':d' . $i;
        $params[':d' . $i] = (int) $id;
    }
    $stmt = getDB()->prepare(
        'SELECT d.id, d.name, d.email, d.email_verified_at, d.phone, d.phone_verified_at, d.country, d.is_active,
                p.devotee_id AS pref_devotee_id, p.lang AS pref_lang, p.timezone AS pref_timezone,
                p.email_on, p.whatsapp_on, p.push_on, p.sms_on, p.inapp_on, p.muted_categories,
                p.promotional_opt_in_at, p.unsubscribed_at, p.updated_at AS pref_updated_at,
                (SELECT COUNT(*) FROM devotee_devices dv WHERE dv.devotee_id = d.id AND dv.is_active = 1) AS device_count
           FROM devotees d
           LEFT JOIN devotee_notification_prefs p ON p.devotee_id = d.id
          WHERE d.id IN (' . implode(', ', $names) . ')'
    );
    $stmt->execute($params);
    $rows = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $pref = $r['pref_devotee_id'] === null ? null : [
            'lang' => $r['pref_lang'], 'timezone' => $r['pref_timezone'],
            'email_on' => $r['email_on'], 'whatsapp_on' => $r['whatsapp_on'], 'push_on' => $r['push_on'],
            'sms_on' => $r['sms_on'], 'inapp_on' => $r['inapp_on'], 'muted_categories' => $r['muted_categories'],
            'promotional_opt_in_at' => $r['promotional_opt_in_at'], 'unsubscribed_at' => $r['unsubscribed_at'],
            'updated_at' => $r['pref_updated_at'],
        ];
        $r['_prefs']   = notifyPrefsFromRow($pref, $r['country']);
        $r['_devices'] = (int) $r['device_count'];
        $rows[(int) $r['id']] = $r;
    }
    return $rows;
}

/** The translation to use for a language: its own, then Tamil, then English, then any complete one. [lang, translation] */
function notifyCampaignTranslation(array $translations, string $lang): array
{
    $complete = static fn($t): bool => is_array($t) && trim((string) ($t['title'] ?? '')) !== '' && trim((string) ($t['body'] ?? '')) !== '';
    foreach (array_unique([$lang, 'ta', 'en']) as $l) {
        if (isset($translations[$l]) && $complete($translations[$l])) return [$l, $translations[$l]];
    }
    foreach ($translations as $l => $t) {
        if ($complete($t)) return [(string) $l, $t];
    }
    return [$lang, ['title' => '', 'body' => '', 'cta_label' => null]];
}

/** The temple's facts as variables for interpolating a campaign's own words. */
function notifyFactVars(string $lang): array
{
    try {
        $f = notifyTempleFacts();
    } catch (Throwable) {
        return [];
    }
    $l = $lang === 'ta' ? 'ta' : 'en';
    return array_filter([
        'templeName'      => $f['name'][$l] ?? null,
        'templeShortName' => $f['shortName'][$l] ?? null,
        'templeAddress'   => $f['address'][$l] ?? null,
        'mapsUrl'         => $f['mapsUrl'] ?? null,
        'supportPhone'    => $f['supportPhone'] ?? null,
    ], 'is_scalar');
}

/**
 * Template variables for one recipient: the campaign's own values (a per-language
 * map resolved to the recipient's language) plus title, message and headline
 * from the translation, with {{devoteeName}} and the temple facts filled in.
 */
function notifyCampaignVars(array $c, array $translation, string $lang, string $devoteeName): array
{
    $vars = [];
    foreach ((array) ($c['templateVars'] ?? []) as $k => $v) {
        if (!is_string($k) || $k === 'reminderKey') continue;
        if (is_array($v)) $v = notifyPickLang($v, $lang);
        if ($v === null || is_scalar($v)) $vars[$k] = $v;
    }
    $context = $vars + notifyFactVars($lang) + [
        'devoteeName' => $devoteeName !== '' ? $devoteeName : ($lang === 'ta' ? 'அன்பர்' : 'devotee'),
    ];
    $title = notifyInterpolate((string) ($translation['title'] ?? ''), $context);
    $body  = notifyInterpolate((string) ($translation['body'] ?? ''), $context);
    foreach (['title' => $title, 'message' => $body, 'headline' => $title] as $k => $v) {
        if (!notifyHasValue($vars, $k)) $vars[$k] = $v;
    }
    return $vars;
}

/**
 * Work on one due campaign: start its run, expand devotees after the cursor in
 * batches until the budget or the limit runs out, and finish the run when no
 * devotee remains. A sending campaign whose runs are all expanded is only
 * checked for completion. Returns true when devotees were expanded.
 */
function notifyCampaignExpand(int $id, float $deadline, int $limit = 0): bool
{
    $db = getDB();
    $c  = notifyCampaignLoad($id);
    if ($c === null) return false;

    if ($c['status'] === 'sending' && $c['next_run_at'] === null) {
        notifyCampaignCheckCompletion($id);
        return false;
    }
    if (in_array($c['status'], ['approved', 'scheduled'], true)) {
        $stmt = $db->prepare(
            "UPDATE notification_campaigns
                SET status = 'sending', started_at = COALESCE(started_at, :now), expand_cursor = 0, last_error = NULL
              WHERE id = :id AND status = :from"
        );
        $stmt->execute([':now' => notifyNow(), ':id' => $id, ':from' => $c['status']]);
        if ($stmt->rowCount() === 0) return false;
        notifyAudit($id, 'sent', notifySystemActor(), ['run' => (int) $c['run_count'] + 1, 'scheduled_at' => $c['scheduled_at']]);
        $c['status'] = 'sending';
        $c['expand_cursor'] = 0;
    } elseif ($c['status'] !== 'sending') {
        return false;
    } else {
        $db->prepare('UPDATE notification_campaigns SET started_at = COALESCE(started_at, :now) WHERE id = :id')
           ->execute([':now' => notifyNow(), ':id' => $id]);
    }

    try {
        if (!is_array($c['rules'])) throw new InvalidArgumentException('The saved audience it used no longer exists.');
        $rules = notifyAudienceNormalize($c['rules']);
        if (notifyCategory((string) $c['category']) === null) throw new InvalidArgumentException('Its category no longer exists.');
    } catch (InvalidArgumentException $e) {
        $db->prepare("UPDATE notification_campaigns SET status = 'failed', last_error = :e, next_run_at = NULL WHERE id = :id AND status = 'sending'")
           ->execute([':e' => mb_substr($e->getMessage(), 0, 500), ':id' => $id]);
        notifyAudit($id, 'failed', notifySystemActor(), ['error' => $e->getMessage()]);
        return false;
    }

    $run      = (int) $c['run_count'] + 1;
    $template = $c['template_key'] ?: 'campaign_generic';
    $runLocal = $c['schedule_tz'] === 'recipient' ? notifyCampaignRunLocal($c) : null;
    $cursor   = (int) $c['expand_cursor'];
    $done     = 0;
    $finished = false;
    $status   = $db->prepare('SELECT status FROM notification_campaigns WHERE id = :id');
    $saveCursor = $db->prepare('UPDATE notification_campaigns SET expand_cursor = :c WHERE id = :id');

    while (microtime(true) < $deadline && ($limit === 0 || $done < $limit)) {
        // Cancelled between batches: stop at once.
        $status->execute([':id' => $id]);
        if ($status->fetchColumn() !== 'sending') break;

        $take = $limit === 0 ? NOTIFY_EXPAND_BATCH : min(NOTIFY_EXPAND_BATCH, $limit - $done);
        $ids  = notifyAudienceBatch($rules, $cursor, $take);
        if (!$ids) {
            $finished = true;
            break;
        }
        $rows = notifyCampaignRecipientRows($ids);
        foreach ($ids as $i => $devoteeId) {
            if (microtime(true) >= $deadline) break 2;
            if (isset($rows[$devoteeId])) notifyCampaignNotifyOne($c, $rows[$devoteeId], $run, $template, $runLocal);
            $cursor = $devoteeId;
            $done++;
            if ($i % 100 === 99) $saveCursor->execute([':c' => $cursor, ':id' => $id]);
        }
        $saveCursor->execute([':c' => $cursor, ':id' => $id]);
        if (count($ids) < $take) {
            $finished = true;
            break;
        }
    }
    $saveCursor->execute([':c' => $cursor, ':id' => $id]);

    if ($finished) notifyCampaignFinishRun($id, $run);
    return $done > 0 || $finished;
}

/** One devotee's notification for a campaign run. */
function notifyCampaignNotifyOne(array $c, array $row, int $run, string $template, ?string $runLocal): array
{
    $recipient = notifyRecipientFromDevotee($row);
    [$lang, $translation] = notifyCampaignTranslation($c['translations'], (string) $recipient['lang']);

    $deliverAfter = null;
    if ($runLocal !== null) {
        $at = notifyToUtc($runLocal, (string) $recipient['timezone']);
        if ($at > notifyNow()) $deliverAfter = $at;
    }

    return notify([
        'template'      => $template,
        'vars'          => notifyCampaignVars($c, $translation, $lang, (string) $recipient['name']),
        'category'      => $c['category'],
        'priority'      => $c['priority'],
        'channels'      => $c['channelsList'],
        'devotee_id'    => (int) $row['id'],
        '_recipient'    => $recipient,
        'lang'          => $lang,
        'cta_url'       => $c['cta_url'],
        'cta_label'     => $translation['cta_label'] ?? null,
        'image_url'     => $c['image_url'],
        'campaign_id'   => (int) $c['id'],
        'run_no'        => $run,
        'dedupe_key'    => 'campaign:' . (int) $c['id'] . ':' . $run . ':' . (int) $row['id'],
        'entity_type'   => 'campaign',
        'entity_id'     => (int) $c['id'],
        'deliver_after' => $deliverAfter,
        'actor'         => $c['created_by'] ?: 'system',
    ]);
}

/**
 * A run has reached every devotee: count it, then schedule the next occurrence
 * or wait for the last deliveries to finish. Occurrences that passed while the
 * worker was not running are skipped rather than sent in a burst.
 */
function notifyCampaignFinishRun(int $id, int $run): void
{
    $db = getDB();
    $c  = notifyCampaignLoad($id);
    if ($c === null || $c['status'] !== 'sending') return;

    $count = $db->prepare('SELECT COUNT(*) FROM notifications WHERE campaign_id = :id');
    $count->execute([':id' => $id]);
    $recipients = (int) $count->fetchColumn();

    $next = null;
    $local = notifyCampaignRunLocal($c);
    if ($c['recurrence'] !== 'none' && $local !== null) {
        $anchor    = (int) substr((string) $c['scheduled_local'], 8, 2);
        $candidate = notifyNextOccurrence($local, (string) $c['recurrence'], $anchor);
        $isPast = static function (string $wall) use ($c): bool {
            return $c['schedule_tz'] === 'recipient'
                ? gmdate('Y-m-d H:i:s', (int) strtotime($wall . ' UTC') + NOTIFY_RECIPIENT_LAG_SECONDS) <= notifyNow()
                : notifyToUtc($wall, notifyTempleTz()) <= notifyNow();
        };
        for ($guard = 0; $candidate !== null && $isPast($candidate) && $guard < 2000; $guard++) {
            $candidate = notifyNextOccurrence($candidate, (string) $c['recurrence'], $anchor);
        }
        if ($candidate !== null && ($c['recur_until'] === null || substr($candidate, 0, 10) <= (string) $c['recur_until'])) {
            $next = $candidate;
        }
    }

    if ($next !== null) {
        $nextRun     = $c['schedule_tz'] === 'recipient' ? $next : notifyToUtc($next, notifyTempleTz());
        $scheduledAt = $c['schedule_tz'] === 'recipient'
            ? gmdate('Y-m-d H:i:s', (int) strtotime($next . ' UTC') - NOTIFY_RECIPIENT_LEAD_SECONDS)
            : $nextRun;
        $db->prepare(
            "UPDATE notification_campaigns
                SET status = 'scheduled', run_count = :run, recipient_count = :n, expand_cursor = 0,
                    next_run_at = :next, scheduled_at = :at
              WHERE id = :id AND status = 'sending'"
        )->execute([':run' => $run, ':n' => $recipients, ':next' => $nextRun, ':at' => $scheduledAt, ':id' => $id]);
        notifyAudit($id, 'scheduled', notifySystemActor(), ['run_finished' => $run, 'recipients' => $recipients, 'next_local' => $next, 'next_run_at' => $nextRun]);
        return;
    }

    $db->prepare(
        "UPDATE notification_campaigns SET run_count = :run, recipient_count = :n, expand_cursor = 0, next_run_at = NULL
          WHERE id = :id AND status = 'sending'"
    )->execute([':run' => $run, ':n' => $recipients, ':id' => $id]);
    notifyCampaignCheckCompletion($id);
}

/** A sending campaign with nothing left to expand is complete once nothing is waiting to be sent. */
function notifyCampaignCheckCompletion(int $id): bool
{
    $db = getDB();
    $open = $db->prepare(
        "SELECT COUNT(*) FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
          WHERE n.campaign_id = :id AND d.status IN ('queued', 'sending', 'failed')"
    );
    $open->execute([':id' => $id]);
    if ((int) $open->fetchColumn() > 0) return false;

    $stmt = $db->prepare(
        "UPDATE notification_campaigns SET status = 'completed', completed_at = :now
          WHERE id = :id AND status = 'sending' AND next_run_at IS NULL"
    );
    $stmt->execute([':now' => notifyNow(), ':id' => $id]);
    if ($stmt->rowCount() === 0) return false;
    $stats = notifyCampaignStats($id);
    notifyAudit($id, 'completed', notifySystemActor(), ['recipients' => $stats['recipients'], 'byChannel' => $stats['byChannel']]);
    return true;
}

/* ── Preview and test send ──────────────────────────────────────────────── */

/**
 * What a campaign looks like on one channel in one language, for the composer.
 * $campaign is a notifyCampaignGet() row or unsaved input of the same shape
 * (translations, template_key, template_vars or templateVars, category,
 * priority, cta_url, image_url). With $sampleDevoteeId the preview uses that
 * devotee's name.
 *
 * ['title','body','html' (email only),'cta_label','cta_url','provider_template','params',
 *  'sms' => ['chars','segments','encoding'] (sms only),'missing' => []]
 */
function notifyCampaignPreview(array $campaign, string $channel, string $lang, ?int $sampleDevoteeId = null): array
{
    $out = ['title' => '', 'body' => '', 'html' => null, 'cta_label' => '', 'cta_url' => null, 'provider_template' => null, 'params' => [], 'sms' => null, 'missing' => []];
    $channel = in_array($channel, NOTIFY_CHANNELS, true) ? $channel : 'inapp';
    $lang    = preg_match('/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/', $lang) ? $lang : 'ta';

    $translations = [];
    foreach ((array) ($campaign['translations'] ?? []) as $l => $t) {
        if (is_array($t)) $translations[strtolower((string) $l)] = ['title' => (string) ($t['title'] ?? ''), 'body' => (string) ($t['body'] ?? ''), 'cta_label' => $t['cta_label'] ?? null];
    }
    $vars = $campaign['templateVars'] ?? ($campaign['template_vars'] ?? []);
    if (is_string($vars)) $vars = json_decode($vars, true);
    $c = [
        'templateVars' => is_array($vars) ? $vars : [],
        'category'     => (string) ($campaign['category'] ?? 'announcement'),
        'priority'     => in_array($campaign['priority'] ?? null, NOTIFY_PRIORITIES, true) ? $campaign['priority'] : 'normal',
    ];
    $templateKey = is_string($campaign['template_key'] ?? null) && $campaign['template_key'] !== '' ? $campaign['template_key'] : 'campaign_generic';
    [$usedLang, $translation] = notifyCampaignTranslation($translations, $lang);

    $name = '';
    if ($sampleDevoteeId !== null && $sampleDevoteeId > 0) {
        $name = (string) (notifyRecipientFromDevotee($sampleDevoteeId)['name'] ?? '');
    }
    $sampleName = $name !== '' ? $name : (string) (notifyTemplateSample($templateKey, $usedLang)['devoteeName'] ?? '');
    $vars = notifyCampaignVars($c, $translation, $usedLang, $sampleName);
    $vars['devoteeName'] = $sampleName;

    $cta = notifySafeCtaUrl(is_string($campaign['cta_url'] ?? null) ? $campaign['cta_url'] : null);
    if ($cta === null) {
        $path = (string) (notifyTemplateDefaults()[$templateKey]['cta_path'] ?? '');
        if ($path !== '') $cta = notifySafeCtaUrl(notifyInterpolate($path, $vars));
    }
    $ctaAbs = notifyAbsoluteUrl($cta);
    if ($ctaAbs !== null) $vars['ctaUrl'] = $ctaAbs;

    $r = notifyRender($templateKey, $usedLang, $channel, $vars);
    $out['title']             = $r['title'];
    $out['body']              = $r['body'];
    $out['cta_label']         = trim((string) ($translation['cta_label'] ?? '')) !== '' ? trim((string) $translation['cta_label']) : $r['cta_label'];
    $out['cta_url']           = $ctaAbs;
    $out['provider_template'] = $r['provider_template'];
    $out['params']            = $r['provider_params'];
    $out['missing']           = array_values(array_diff($r['missing'], $sampleName !== '' ? ['devoteeName'] : []));

    if ($channel === 'email') {
        $mutable = in_array(notifyCategoryKind($c['category']), NOTIFY_MUTABLE_KINDS, true);
        $out['html'] = notifyEmailHtml([
            'title' => $out['title'], 'body' => $out['body'], 'lang' => $usedLang, 'category' => $c['category'],
            'category_label' => notifyCategoryLabel($c['category'], $usedLang), 'priority' => $c['priority'],
            'cta_url' => $ctaAbs, 'cta_label' => $out['cta_label'], 'logo_url' => siteUrl('/icons/icon-192x192.png'),
            'preferences_url' => notifyPreferencesUrl(), 'unsubscribe_url' => $mutable ? notifyPreferencesUrl() : null,
        ]);
    } elseif ($channel === 'sms') {
        $text = trim($out['body']) !== '' ? trim($out['body']) : $out['title'];
        if ($ctaAbs !== null && !str_contains($text, $ctaAbs)) {
            $with = $text . "\n" . $ctaAbs;
            if (notifySmsInfo($with)['segments'] <= max(2, notifySmsInfo($text)['segments'])) $text = $with;
        }
        $out['body'] = $text;
        $out['sms']  = notifySmsInfo($text);
    } elseif ($channel === 'push') {
        $text = trim((string) preg_replace("/\s*\n\s*/u", ' ', $out['body']));
        if (mb_strlen($text) > NOTIFY_PUSH_BODY_MAX) $text = rtrim(mb_substr($text, 0, NOTIFY_PUSH_BODY_MAX - 1)) . '…';
        $out['body'] = $text;
    }
    return $out;
}

/** "k***@example.org" / "••••••3210" — enough for the audit trail to tell sends apart. */
function notifyMaskContact(?string $email, ?string $phone): array
{
    $out = [];
    if ($email) $out['email'] = notifyRedact($email, 190);
    if ($phone) $out['phone'] = str_repeat('•', max(0, strlen($phone) - 4)) . substr($phone, -4);
    return $out;
}

/**
 * Send the campaign as it stands to one address, now, whatever its state and
 * audience. The title is prefixed "[TEST] ". Channel rules still apply, except
 * that an address typed by the admin counts as consenting to receive it.
 * to: ['email' => ?, 'phone' => ?, 'devotee_id' => ?, 'lang' => ?]
 *
 * Returns ['ok' => bool, 'message' => string, 'id' => ?int, 'deduped' => bool, 'deliveries' => notify()'s]
 */
function notifyCampaignTestSend(int $id, array $actor, array $to): array
{
    $res = static fn(bool $ok, string $message, ?array $r = null): array => [
        'ok' => $ok, 'message' => $message, 'id' => $r['id'] ?? null, 'deduped' => (bool) ($r['deduped'] ?? false), 'deliveries' => $r['deliveries'] ?? [],
    ];
    if (!notifyTablesExist()) return $res(false, 'Notifications are not available on this site yet.');
    if (!notifyActorCan($actor, 'notifications.compose')) return $res(false, 'Your role cannot send test notifications.');
    $c = notifyCampaignLoad($id);
    if ($c === null) return $res(false, 'That notification no longer exists.');

    $email = is_string($to['email'] ?? null) && filter_var(trim($to['email']), FILTER_VALIDATE_EMAIL) ? mb_strtolower(trim($to['email'])) : null;
    $phone = isset($to['phone']) && is_scalar($to['phone']) ? normalizePhone((string) $to['phone'])['phone'] : '';
    $phone = $phone !== '' ? $phone : null;
    $devoteeId = isset($to['devotee_id']) && (int) $to['devotee_id'] > 0 ? (int) $to['devotee_id'] : null;
    if ($email === null && $phone === null && $devoteeId === null) return $res(false, 'Give an email address or a mobile number to send the test to.');

    $complete = false;
    foreach ($c['translations'] as $t) if (trim($t['title']) !== '' && trim($t['body']) !== '') $complete = true;
    if (!$complete) return $res(false, 'Write the title and message in at least one language first.');
    if (!$c['channelsList']) return $res(false, 'Choose at least one channel first.');

    $recipientName = '';
    $lang = is_string($to['lang'] ?? null) ? strtolower($to['lang']) : null;
    if ($devoteeId !== null) {
        $recipient = notifyRecipientFromDevotee($devoteeId);
        if (empty($recipient['devotee_id'])) return $res(false, 'That devotee account no longer exists.');
        $recipientName = (string) $recipient['name'];
        $lang ??= (string) $recipient['lang'];
    }
    $lang = isset(notifyLanguages()[(string) $lang]) ? (string) $lang : 'ta';
    [$usedLang, $translation] = notifyCampaignTranslation($c['translations'], $lang);

    $who  = notifyActorName($actor);
    $hash = sha1(json_encode(['e' => $email, 'p' => $phone, 'd' => $devoteeId, 'l' => $usedLang]));
    $result = notify([
        'event'        => 'campaign.test',
        'template'     => $c['template_key'] ?: 'campaign_generic',
        'vars'         => notifyCampaignVars($c, $translation, $usedLang, $recipientName),
        'category'     => $c['category'],
        'priority'     => $c['priority'],
        'channels'     => $c['channelsList'],
        'devotee_id'   => $devoteeId,
        'to_email'     => $email,
        'to_phone'     => $phone,
        'lang'         => $usedLang,
        'cta_url'      => $c['cta_url'],
        'cta_label'    => $translation['cta_label'] ?? null,
        'image_url'    => $c['image_url'],
        'entity_type'  => 'campaign',
        'entity_id'    => $id,
        'dedupe_key'   => 'test:' . $id . ':' . $hash . ':' . gmdate('YmdHi', (int) strtotime(notifyNow() . ' UTC')),
        'sync'         => true,
        'title_prefix' => '[TEST] ',
        'actor'        => $who,
        '_test'        => $devoteeId === null,
    ]);

    $summary = [];
    foreach ($result['deliveries'] as $channel => $d) {
        $summary[$channel] = $d['status'] . ($d['reason'] ? ' (' . $d['reason'] . ')' : '');
    }
    notifyAudit($id, 'test_sent', $actor, ['to' => notifyMaskContact($email, $phone) + ($devoteeId ? ['devotee_id' => $devoteeId] : []), 'lang' => $usedLang, 'deliveries' => $summary]);

    if ($result['deduped']) return $res(true, 'That test was already sent in the last minute.', $result);
    if ($result['id'] === null) return $res(false, 'The test could not be sent: ' . ($result['skipped'] ?? 'unknown reason') . '.', $result);
    $parts = [];
    foreach ($summary as $channel => $s) $parts[] = $channel . ': ' . $s;
    return $res(true, 'Test sent. ' . implode('; ', $parts) . '.', $result);
}
