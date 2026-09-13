<?php
// backend/admin/notifications.php — messages the committee sends to devotees:
// the campaign list, the composer (?new=1, ?edit=<id>) and one campaign's page
// (?view=<id>) with its approval, schedule, delivery figures and audit trail.
//
// Nothing here decides what is allowed. The page checks the capability first
// (so a refused action says why without a round trip to the service), then
// hands every change to notifyCampaignSave() / notifyCampaignTransition(),
// which check the acting admin's role again and enforce the approval rules
// (docs/notifications/SPEC.md §5.8). A hand-crafted POST therefore cannot do
// more than the buttons offer.
//
// Three JSON sub-endpoints serve assets/notify-campaigns.js:
//   POST action=estimate      → {"count", "approvalReason"}
//   POST action=preview       → notifyCampaignPreview()
//   GET  ?devotee_search=<q>  → {"items": [{id, name, email, city}]}  (≤ 20)
// They answer JSON even when refused (401, 403, 419, 422), because a script
// cannot read the HTML "not permitted" page the rest of the admin shows.
require_once __DIR__ . '/../includes/auth.php';

/** A JSON answer for the script, then stop. */
function ncJson(array $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR);
    exit;
}

$ncMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$ncAction = $ncMethod === 'POST' && is_string($_POST['action'] ?? null) ? $_POST['action'] : '';
$ncIsJson = ($ncMethod === 'POST' && in_array($ncAction, ['estimate', 'preview'], true))
    || ($ncMethod === 'GET' && isset($_GET['devotee_search']));

// The same policy requireAdminAuth() applies, answered in JSON.
if ($ncIsJson) {
    if (empty($_SESSION['admin_logged_in'])) ncJson(['error' => 'Your session has ended. Sign in again, then try once more.', 'code' => 'unauthenticated'], 401);
    if (!empty($_SESSION['admin_must_change'])) ncJson(['error' => 'Choose a new password on your profile page first.', 'code' => 'password_change'], 403);
    if (!adminCan('notifications.compose')) ncJson(['error' => 'Your role can read notifications but not compose them.', 'code' => 'forbidden'], 403);
}
requireAdminAuth();

require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/notify.php';
require_once __DIR__ . '/includes/admin_layout.php';
require_once __DIR__ . '/includes/notify_audience_form.php';

const NC_BASE     = '/admin/notifications.php';
const NC_PER_PAGE = 20;
const NC_STATUSES = ['draft', 'review', 'approved', 'scheduled', 'sending', 'completed', 'cancelled', 'failed'];

$db         = getDB();
$me         = currentAdmin() ?? [];
$actor      = ['username' => (string) ($me['username'] ?? 'admin'), 'role' => (string) ($me['role'] ?? 'viewer')];
$canCompose = adminCan('notifications.compose');
$canApprove = adminCan('notifications.approve');

// The tables arrive with migration 007. Until then the page says so instead of failing.
if (!notifyTablesExist()) {
    if ($ncIsJson) ncJson(['error' => 'Notifications are not switched on yet.', 'code' => 'notifications_disabled'], 503);
    adminHeader('Notifications', 'Communication');
    echo adminEmpty('bell', 'Notifications are not switched on yet',
        'Apply database/migrations/007_notifications.sql to let the committee send messages to devotees by in-app notification, email, WhatsApp, SMS and push.');
    adminFooter();
    exit;
}

/* ── Wording and small helpers ─────────────────────────────────────────── */

function ncStatusLabel(string $s): string
{
    return ['draft' => 'Draft', 'review' => 'Awaiting approval', 'approved' => 'Approved', 'scheduled' => 'Scheduled',
            'sending' => 'Sending', 'completed' => 'Sent', 'cancelled' => 'Cancelled', 'failed' => 'Failed'][$s] ?? ucfirst($s);
}

function ncStatusTone(string $s): string
{
    return ['draft' => 'muted', 'review' => 'warning', 'approved' => 'info', 'scheduled' => 'moon', 'sending' => 'gold',
            'completed' => 'success', 'cancelled' => 'muted', 'failed' => 'danger'][$s] ?? 'muted';
}

function ncChannelLabel(string $c): string
{
    return ['inapp' => 'In-app', 'email' => 'Email', 'whatsapp' => 'WhatsApp', 'sms' => 'SMS', 'push' => 'Push'][$c] ?? $c;
}

function ncChannelIcon(string $c): string
{
    return ['inapp' => 'bell', 'email' => 'mail', 'whatsapp' => 'message-circle', 'sms' => 'message-square', 'push' => 'smartphone'][$c] ?? 'dot';
}

function ncPriorityLabel(string $p): string
{
    return ['normal' => 'Normal', 'important' => 'Important', 'urgent' => 'Urgent', 'emergency' => 'Emergency'][$p] ?? ucfirst($p);
}

function ncPriorityTone(string $p): string
{
    return ['normal' => 'muted', 'important' => 'info', 'urgent' => 'warning', 'emergency' => 'danger'][$p] ?? 'muted';
}

/** "IST" for the default temple zone, the zone's name otherwise. */
function ncTzLabel(): string
{
    $tz = notifyTempleTz();
    return $tz === 'Asia/Kolkata' ? 'IST' : $tz;
}

/** A stored UTC time as the committee reads it: "20 Sep 2026 · 18:00 IST". */
function ncTempleTime(?string $utc): string
{
    if ($utc === null || $utc === '') return '—';
    try {
        return notifyFromUtc($utc, notifyTempleTz(), 'd M Y · H:i') . ' ' . ncTzLabel();
    } catch (Throwable) {
        return $utc;
    }
}

/** A wall-clock time as typed ('Y-m-d H:i:s'), formatted without converting it. */
function ncWallClock(?string $local): string
{
    if ($local === null || $local === '') return '';
    $t = strtotime($local . ' UTC');
    return $t ? gmdate('d M Y · H:i', $t) : $local;
}

/** "3 h ago" / "in 2 d", measured on the service's UTC clock rather than PHP's default zone. */
function ncAgo(?string $utc): string
{
    if ($utc === null || $utc === '') return '';
    $t = strtotime($utc . ' UTC');
    if (!$t) return '';
    $diff   = strtotime(notifyNow() . ' UTC') - $t;
    $future = $diff < 0;
    $d      = abs($diff);
    if ($d < 60) return 'just now';
    $text = match (true) {
        $d < 3600       => floor($d / 60) . ' min',
        $d < 86400      => floor($d / 3600) . ' h',
        $d < 86400 * 30 => floor($d / 86400) . ' d',
        default         => null,
    };
    if ($text === null) return ncTempleTime($utc);
    return $future ? 'in ' . $text : $text . ' ago';
}

function ncFlash(string $tone, string $text): void
{
    $_SESSION['flash_notifications'] = [$tone, $text];
}

function ncRedirect(string $url): never
{
    header('Location: ' . $url, true, 303);
    exit;
}

/** The list this request came from (same host, this page only), so a row action lands back on the filtered list. */
function ncBackUrl(string $fallback): string
{
    $ref = (string) ($_SERVER['HTTP_REFERER'] ?? '');
    $p   = $ref !== '' ? parse_url($ref) : false;
    if (!$p || empty($p['host']) || ($p['path'] ?? '') !== NC_BASE) return $fallback;
    $host = $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (strcasecmp($host, (string) ($_SERVER['HTTP_HOST'] ?? '')) !== 0) return $fallback;
    return NC_BASE . (!empty($p['query']) ? '?' . $p['query'] : '');
}

/**
 * Whether a channel can actually deliver on this site, for the channel cards.
 * ['driver' => name, 'tone' => ok|log|off, 'label' => sentence]
 */
function ncProviderStatus(string $channel): array
{
    if ($channel === 'inapp') return ['driver' => 'built-in', 'tone' => 'ok', 'label' => 'Built in - the notification bell on the website'];
    try {
        $p    = notifyProviderFor($channel);
        $name = $p->name();
        $ok   = $p->isConfigured();
    } catch (Throwable) {
        $name = 'unavailable';
        $ok   = false;
    }
    if ($name === 'log') return ['driver' => 'log', 'tone' => 'log', 'label' => 'Recording only - no provider configured'];
    if ($name === 'unavailable' || !$ok) return ['driver' => $name, 'tone' => 'off', 'label' => 'Not configured - messages on this channel are skipped'];
    if ($name === 'test') return ['driver' => 'test', 'tone' => 'log', 'label' => 'Test driver - development only, nothing reaches a person'];
    $names = ['mailer' => 'the site mailer', 'meta' => 'Meta WhatsApp Cloud API', 'twilio' => 'Twilio', 'msg91' => 'MSG91',
              'webpush' => 'Web Push', 'fcm' => 'Firebase Cloud Messaging'];
    return ['driver' => $name, 'tone' => 'ok', 'label' => 'Configured - ' . ($names[$name] ?? $name)];
}

/** When a campaign goes out, in words. '' when it is sent by hand. */
function ncScheduleLabel(array $c): string
{
    if ($c['schedule_tz'] === 'recipient' && $c['scheduled_local']) {
        $when = ncWallClock((string) $c['scheduled_local']) . ' in each devotee\'s own time';
        return in_array($c['status'], ['draft', 'review', 'approved'], true) ? $when . ' (planned)' : $when;
    }
    if ($c['scheduled_at'] && !in_array($c['status'], ['draft', 'review', 'approved'], true)) return ncTempleTime((string) $c['scheduled_at']);
    if ($c['scheduled_local']) return ncWallClock((string) $c['scheduled_local']) . ' ' . ncTzLabel() . ' (planned)';
    return '';
}

/** Categories a campaign may use: ones a devotee can switch off, plus emergencies. */
function ncCampaignCategories(string $current): array
{
    $out = [];
    foreach (notifyCategories(false) as $key => $cat) {
        $allowed = in_array($cat['kind'], ['informational', 'promotional', 'critical'], true) && $cat['is_active'] === 1;
        if ($allowed || $key === $current) $out[$key] = $cat;
    }
    return $out;
}

/** Message layouts for free-text campaigns: '' is the plain wrapper. */
function ncTemplateChoices(string $current): array
{
    $defaults = notifyTemplateDefaults();
    $out = [
        ''             => 'Free text - the title and message as written',
        'announcement' => 'Temple announcement - a headline and the message',
        'emergency'    => 'Emergency notice - marked urgent in every channel',
    ];
    if ($current !== '' && !isset($out[$current])) {
        $out[$current] = 'Current layout: ' . ($defaults[$current]['description'] ?? $current);
    }
    return $out;
}

/* ── The composer's state ───────────────────────────────────────────────── */

/** Tamil and English first, then the site's other languages in their configured order. */
function ncOrderLangs(array $langs): array
{
    $all = array_keys(notifyLanguages());
    $set = array_unique(array_merge(['ta', 'en'], array_values(array_filter($langs, static fn($l) => in_array($l, $all, true)))));
    usort($set, static fn($a, $b) => array_search($a, $all, true) <=> array_search($b, $all, true));
    return $set;
}

function ncComposerBlank(): array
{
    return [
        'name' => '', 'category' => 'announcement', 'priority' => 'normal', 'channels' => ['inapp'],
        'cta_url' => '', 'image_url' => '', 'template_key' => '', 'template_vars' => '',
        'translations' => ['ta' => ['title' => '', 'body' => '', 'cta_label' => ''], 'en' => ['title' => '', 'body' => '', 'cta_label' => '']],
        'langs' => ['ta', 'en'], 'schedule_mode' => 'manual', 'scheduled_local' => '', 'schedule_tz' => 'temple',
        'recurrence' => 'none', 'recur_until' => '', 'audience' => adminAudienceBlank(),
    ];
}

function ncComposerFromCampaign(array $c): array
{
    $f = ncComposerBlank();
    $f['name']          = (string) $c['name'];
    $f['category']      = (string) $c['category'];
    $f['priority']      = (string) $c['priority'];
    $f['channels']      = $c['channelsList'];
    $f['cta_url']       = (string) ($c['cta_url'] ?? '');
    $f['image_url']     = (string) ($c['image_url'] ?? '');
    $f['template_key']  = (string) ($c['template_key'] ?? '');
    $f['template_vars'] = $c['templateVars'] ? (string) json_encode($c['templateVars'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : '';
    foreach ($c['translations'] as $lang => $t) {
        $f['translations'][$lang] = ['title' => (string) $t['title'], 'body' => (string) $t['body'], 'cta_label' => (string) ($t['cta_label'] ?? '')];
    }
    $f['langs']           = ncOrderLangs(array_keys($f['translations']));
    $f['schedule_mode']   = $c['scheduled_local'] ? 'at' : 'manual';
    $f['scheduled_local'] = $c['scheduled_local'] ? substr(str_replace(' ', 'T', (string) $c['scheduled_local']), 0, 16) : '';
    $f['schedule_tz']     = (string) $c['schedule_tz'];
    $f['recurrence']      = (string) $c['recurrence'];
    $f['recur_until']     = (string) ($c['recur_until'] ?? '');
    $f['audience']        = adminAudienceStateFrom($c['segment_id'] !== null ? (int) $c['segment_id'] : null,
                                                  $c['segment_id'] === null && $c['audience'] ? json_decode((string) $c['audience'], true) : null);
    return $f;
}

function ncComposerFromPost(array $post): array
{
    $s = static fn(string $k, int $max): string => is_string($post[$k] ?? null) ? mb_substr(trim($post[$k]), 0, $max) : '';
    $languages = notifyLanguages();

    $channels = [];
    foreach ((array) ($post['channels'] ?? []) as $ch) {
        if (is_string($ch) && in_array($ch, NOTIFY_CHANNELS, true)) $channels[$ch] = $ch;
    }

    $translations = [];
    foreach ((array) ($post['translations'] ?? []) as $lang => $t) {
        $lang = strtolower((string) $lang);
        if (!isset($languages[$lang]) || !is_array($t)) continue;
        $translations[$lang] = [
            'title'     => is_string($t['title'] ?? null) ? mb_substr($t['title'], 0, 400) : '',
            'body'      => is_string($t['body'] ?? null) ? mb_substr($t['body'], 0, 25000) : '',
            'cta_label' => is_string($t['cta_label'] ?? null) ? mb_substr($t['cta_label'], 0, 160) : '',
        ];
    }
    $drop = is_string($post['remove_lang'] ?? null) ? $post['remove_lang'] : '';
    if ($drop !== '' && !in_array($drop, ['ta', 'en'], true)) unset($translations[$drop]);
    $langs = array_keys($translations);
    if (($post['action'] ?? '') === 'add_lang') {
        $add = strtolower($s('add_lang_code', 12));
        if (isset($languages[$add])) {
            $langs[] = $add;
            $translations[$add] ??= ['title' => '', 'body' => '', 'cta_label' => ''];
        }
    }
    foreach (['ta', 'en'] as $l) $translations[$l] ??= ['title' => '', 'body' => '', 'cta_label' => ''];

    return [
        'name'            => $s('name', 300),
        'category'        => $s('category', 32),
        'priority'        => in_array($post['priority'] ?? '', NOTIFY_PRIORITIES, true) ? $post['priority'] : 'normal',
        'channels'        => array_values($channels),
        'cta_url'         => $s('cta_url', 600),
        'image_url'       => $s('image_url', 600),
        'template_key'    => $s('template_key', 64),
        'template_vars'   => $s('template_vars', 20000),
        'translations'    => $translations,
        'langs'           => ncOrderLangs($langs),
        'schedule_mode'   => ($post['schedule_mode'] ?? '') === 'at' ? 'at' : 'manual',
        'scheduled_local' => $s('scheduled_local', 20),
        'schedule_tz'     => ($post['schedule_tz'] ?? '') === 'recipient' ? 'recipient' : 'temple',
        'recurrence'      => in_array($post['recurrence'] ?? '', NOTIFY_RECURRENCES, true) ? $post['recurrence'] : 'none',
        'recur_until'     => $s('recur_until', 10),
        'audience'        => adminAudienceStateFromPost($post, true),
    ];
}

/** notifyCampaignSave()'s input shape. */
function ncComposerToInput(array $f): array
{
    $aud = adminAudienceToInput($f['audience']);
    $at  = $f['schedule_mode'] === 'at';
    return [
        'name' => $f['name'], 'category' => $f['category'], 'priority' => $f['priority'], 'channels' => $f['channels'],
        'cta_url' => $f['cta_url'], 'image_url' => $f['image_url'], 'template_key' => $f['template_key'],
        'template_vars' => $f['template_vars'], 'segment_id' => $aud['segment_id'], 'audience' => $aud['audience'],
        'translations' => $f['translations'], 'schedule_tz' => $f['schedule_tz'],
        'scheduled_local' => $at && $f['scheduled_local'] !== '' ? $f['scheduled_local'] : null,
        'recurrence' => $at ? $f['recurrence'] : 'none',
        'recur_until' => $at && $f['recurrence'] !== 'none' ? $f['recur_until'] : '',
    ];
}

/**
 * Checks this page adds to the service's: a planned time must be in the future,
 * and a campaign may not borrow a category devotees cannot switch off (a
 * "booking" broadcast would ignore every devotee's mute).
 */
function ncComposerProblems(array $f): array
{
    $e = [];
    if ($f['schedule_mode'] === 'at') {
        $local = notifyParseLocal($f['scheduled_local']);
        if ($f['scheduled_local'] === '') {
            $e['scheduled_local'] = 'Choose the date and time to send it, or choose to send it by hand after approval.';
        } elseif ($local !== null) {
            $first = $f['schedule_tz'] === 'recipient'
                ? gmdate('Y-m-d H:i:s', (int) strtotime($local . ' UTC') - NOTIFY_RECIPIENT_LEAD_SECONDS)
                : notifyToUtc($local, notifyTempleTz());
            if ($first <= notifyNow()) {
                $e['scheduled_local'] = $f['schedule_tz'] === 'recipient'
                    ? 'That time has already arrived somewhere in the world. Choose a later time.'
                    : 'Choose a time in the future (' . ncTzLabel() . ').';
            }
        }
    }
    $cat = $f['category'] !== '' ? notifyCategory($f['category']) : null;
    if ($cat !== null && in_array($cat['kind'], ['transactional', 'security'], true)) {
        $e['category'] = 'That category is for messages about a devotee\'s own booking, donation or account, which devotees cannot switch off. Choose an announcement-type category.';
    }
    if ($f['audience']['source'] === 'segment' && !$f['audience']['segment_id']) $e['segment_id'] = 'Choose a saved audience.';
    return $e;
}

/* ── Field errors ───────────────────────────────────────────────────────── */

function ncErrId(string $key): string
{
    return 'nc-err-' . trim((string) preg_replace('/[^a-z0-9]+/i', '-', $key), '-');
}

/** aria-invalid and aria-describedby (hint and error) for a control. */
function ncAria(array $errors, string $key, ?string $hintId = null): string
{
    $ids = array_filter([$hintId, isset($errors[$key]) ? ncErrId($key) : null]);
    return (isset($errors[$key]) ? ' aria-invalid="true"' : '') . ($ids ? ' aria-describedby="' . implode(' ', $ids) . '"' : '');
}

function ncError(array $errors, string $key): string
{
    return isset($errors[$key]) ? '<span class="field__error" id="' . ncErrId($key) . '">' . adminIcon('alert-circle') . h((string) $errors[$key]) . '</span>' : '';
}

/** The control an error summary link should jump to. */
function ncErrorTarget(string $key): string
{
    if (preg_match('/^translations\.([a-z0-9-]+)\.(title|body|cta_label)$/', $key, $m)) return 'nc-lang-' . $m[1] . '-' . $m[2];
    if (preg_match('/^translations\.([a-z0-9-]+)$/', $key, $m)) return 'nc-lang-' . $m[1] . '-title';
    return ['name' => 'nc-name', 'category' => 'nc-category', 'priority' => 'nc-priority', 'channels' => 'nc-ch-inapp',
            'cta_url' => 'nc-cta', 'image_url' => 'nc-image', 'template_key' => 'nc-template', 'template_vars' => 'nc-template',
            'segment_id' => 'nc-segment', 'audience' => 'nc-audience', 'translations' => 'nc-lang-ta-title',
            'schedule_tz' => 'nc-tz-temple', 'scheduled_local' => 'nc-when', 'recurrence' => 'nc-recurrence',
            'recur_until' => 'nc-until'][$key] ?? 'nc-composer';
}

/** After approval: a campaign that already has its planned time is scheduled for it straight away. */
function ncScheduleIfPlanned(int $id, array $actor): ?string
{
    $c = notifyCampaignLoad($id);
    if ($c === null || $c['status'] !== 'approved' || $c['scheduled_local'] === null) return null;
    $r = notifyCampaignTransition($id, 'schedule', $actor);
    return $r['ok'] ? $r['message'] : 'It could not be scheduled for its planned time: ' . $r['message'];
}

/** The approval line under an estimate. */
function ncApprovalHint(array $f, ?int $count): string
{
    if ($count === null) return '';
    $why = notifyCampaignNeedsApproval(['priority' => $f['priority'], 'channels' => $f['channels'], 'category' => $f['category']], $count);
    return $why === null
        ? 'Small enough to be approved automatically when it is submitted.'
        : 'Needs an owner\'s approval when submitted: ' . $why . '.';
}

/* ── JSON sub-endpoints ─────────────────────────────────────────────────── */

if ($ncIsJson) {
    try {
        if ($ncMethod === 'GET') {
            $term = is_string($_GET['devotee_search']) ? $_GET['devotee_search'] : '';
            ncJson(['items' => adminAudienceFindDevotees($db, $term, 20)]);
        }
        if (!csrfValid()) {
            ncJson(['error' => 'Your session expired or the form was tampered with. Reload the page and try again.', 'code' => 'csrf'], 419);
        }
        $form = ncComposerFromPost($_POST);

        if ($ncAction === 'estimate') {
            $est = adminAudienceEstimate($db, $form['audience']);
            if ($est['count'] === null) {
                ncJson(['error' => $est['error'], 'code' => 'invalid', 'fields' => [$est['field'] => $est['error']]], 422);
            }
            $why = notifyCampaignNeedsApproval(['priority' => $form['priority'], 'channels' => $form['channels'], 'category' => $form['category']], $est['count']);
            ncJson(['count' => $est['count'], 'approvalReason' => $why]);
        }

        // preview
        $channel = is_string($_POST['preview_channel'] ?? null) ? $_POST['preview_channel'] : '';
        $lang    = is_string($_POST['preview_lang'] ?? null) ? $_POST['preview_lang'] : '';
        $fields  = [];
        if (!in_array($channel, NOTIFY_CHANNELS, true)) $fields['preview_channel'] = 'Choose a channel to preview.';
        if (!isset(notifyLanguages()[$lang])) $fields['preview_lang'] = 'Choose a language this site offers.';
        if ($form['template_key'] !== '' && notifyTemplate($form['template_key'], 'ta', 'any') === null) $fields['template_key'] = 'Choose a layout from the list.';
        if ($fields) ncJson(['error' => reset($fields), 'code' => 'invalid', 'fields' => $fields], 422);

        $campaignId = (int) ($_POST['campaign_id'] ?? 0);
        $campaign   = null;
        if ($campaignId > 0 && !isset($_POST['translations'])) {
            $campaign = notifyCampaignGet($campaignId);
            if ($campaign === null) ncJson(['error' => 'That notification no longer exists.', 'code' => 'not_found'], 404);
        }
        $campaign ??= [
            'translations' => $form['translations'], 'category' => $form['category'] !== '' ? $form['category'] : 'announcement',
            'priority' => $form['priority'], 'cta_url' => $form['cta_url'], 'image_url' => $form['image_url'],
            'template_key' => $form['template_key'], 'template_vars' => $form['template_vars'],
        ];
        $sample = (int) ($_POST['sample_devotee_id'] ?? 0);
        ncJson(notifyCampaignPreview($campaign, $channel, $lang, $sample > 0 ? $sample : null));
    } catch (Throwable $e) {
        error_log('[notify] admin ' . ($ncAction ?: 'devotee search') . ' failed: ' . get_class($e) . ': ' . $e->getMessage());
        ncJson(['error' => 'That could not be worked out just now. Please try again.', 'code' => 'server_error'], 500);
    }
}

/* ── Form posts → flash + 303 ───────────────────────────────────────────── */

$msg            = '';
$composer       = null;   // form state when re-rendering the composer from a POST
$composerId     = null;
$composerErrors = [];
$serverEstimate = null;
$foundDevotees  = null;

if ($ncMethod === 'POST') {
    $refresh = in_array($ncAction, ['add_rule', 'add_lang', 'find_devotees', 'estimate_form'], true)
        || isset($_POST['remove_rule']) || isset($_POST['remove_lang']) || isset($_POST['remove_devotee']);
    $isComposerPost = $refresh || in_array($ncAction, ['save', 'save_submit'], true);
    $postedId = is_scalar($_POST['id'] ?? null) && ctype_digit((string) $_POST['id']) ? (int) $_POST['id'] : 0;

    if ($isComposerPost) {
        // Second line of defence behind requireAdminAuth()'s write policy.
        if (!$canCompose) {
            ncFlash('error', 'Your role can read notifications but not write them.');
            ncRedirect(NC_BASE);
        }
        $composer   = ncComposerFromPost($_POST);
        $composerId = $postedId > 0 ? $postedId : null;

        if (!csrfValid()) {
            // Keep what was typed; nothing is saved until the form comes back with a fresh token.
            $composerErrors['_'] = 'Your session expired or the form was tampered with. Nothing was saved - check the form and save again.';
        } elseif ($refresh) {
            if ($ncAction === 'estimate_form') {
                $serverEstimate = adminAudienceEstimate($db, $composer['audience']);
            }
            if ($ncAction === 'find_devotees') {
                $composer['audience']['source'] = 'selected';
                $foundDevotees = adminAudienceFindDevotees($db, $composer['audience']['lookup'], 20);
            }
        } else {
            $existing = $composerId !== null ? notifyCampaignLoad($composerId) : null;
            if ($composerId !== null && $existing === null) {
                ncFlash('warning', 'That notification no longer exists.');
                ncRedirect(NC_BASE);
            }
            $input = ncComposerToInput($composer);
            [, , $errors] = notifyCampaignValidate($input, $existing);
            $errors += ncComposerProblems($composer);
            $saved = null;
            if (!$errors) {
                $saved = notifyCampaignSave($input, $actor, $composerId);
                if (!$saved['ok']) $errors = $saved['errors'];
            }
            if ($errors) {
                $composerErrors = $errors;
            } else {
                $id = (int) $saved['id'];
                $wasApproved = $existing !== null && $existing['status'] !== 'draft';
                if ($ncAction === 'save_submit') {
                    $t = notifyCampaignTransition($id, 'submit', $actor);
                    $text = 'Saved. ' . $t['message'];
                    if ($t['ok'] && $t['status'] === 'approved' && ($more = ncScheduleIfPlanned($id, $actor)) !== null) $text .= ' ' . $more;
                    ncFlash($t['ok'] ? 'success' : 'warning', $text);
                    ncRedirect(NC_BASE . '?view=' . $id);
                }
                ncFlash('success', $existing === null
                    ? 'Draft saved. Submit it when it is ready; nothing is sent before then.'
                    : ($wasApproved ? 'Saved. Because it changed, it is a draft again and needs to be submitted for approval once more.' : 'Changes saved.'));
                ncRedirect(NC_BASE . '?edit=' . $id);
            }
        }
    } else {
        $return = ($_POST['return'] ?? '') === 'list' ? ncBackUrl(NC_BASE) : NC_BASE . '?view=' . $postedId;
        if (!csrfValid()) {
            ncFlash('error', 'Your session expired or the form was tampered with. Nothing was changed - please try again.');
            ncRedirect($return);
        }
        $needs = ['submit' => 'compose', 'approve' => 'approve', 'reject' => 'approve', 'schedule' => 'compose', 'send_now' => 'compose',
                  'emergency_send' => 'approve', 'cancel' => 'compose', 'duplicate' => 'compose', 'test_send' => 'compose'];
        if (!isset($needs[$ncAction])) {
            ncFlash('error', 'That is not something a notification can do.');
            ncRedirect($return);
        }
        if (!adminCan('notifications.' . $needs[$ncAction])) {
            ncFlash('error', $needs[$ncAction] === 'approve'
                ? 'Only an owner can do that. Your role is ' . ucfirst($actor['role']) . '.'
                : 'Your role can read notifications but not change them.');
            ncRedirect($return);
        }
        if ($postedId <= 0 || notifyCampaignLoad($postedId) === null) {
            ncFlash('warning', 'That notification no longer exists.');
            ncRedirect(NC_BASE);
        }

        $reason = is_string($_POST['reason'] ?? null) ? mb_substr(trim($_POST['reason']), 0, 500) : '';
        if ($ncAction === 'test_send') {
            $r = notifyCampaignTestSend($postedId, $actor, [
                'email' => is_string($_POST['test_email'] ?? null) ? trim($_POST['test_email']) : null,
                'phone' => is_string($_POST['test_phone'] ?? null) && trim($_POST['test_phone']) !== '' ? trim($_POST['test_phone']) : null,
                'lang'  => is_string($_POST['test_lang'] ?? null) ? $_POST['test_lang'] : null,
            ]);
            ncFlash($r['ok'] ? 'success' : 'error', $r['message']);
            ncRedirect(NC_BASE . '?view=' . $postedId . '#nc-test');
        }

        $opts = [];
        if (in_array($ncAction, ['reject', 'emergency_send'], true)) $opts['reason'] = $reason;
        if ($ncAction === 'schedule') {
            $opts['scheduled_local'] = is_string($_POST['scheduled_local'] ?? null) ? $_POST['scheduled_local'] : '';
            $opts['schedule_tz'] = ($_POST['schedule_tz'] ?? '') === 'recipient' ? 'recipient' : 'temple';
        }
        $r = notifyCampaignTransition($postedId, $ncAction, $actor, $opts);
        $text = $r['message'];
        if ($r['ok'] && $ncAction === 'approve' && ($more = ncScheduleIfPlanned($postedId, $actor)) !== null) $text .= ' ' . $more;
        ncFlash($r['ok'] ? 'success' : 'error', $text);
        if ($r['ok'] && $ncAction === 'duplicate' && $r['id']) ncRedirect(NC_BASE . '?edit=' . (int) $r['id']);
        ncRedirect($return);
    }
}

// Flash from the previous request.
if (!empty($_SESSION['flash_notifications']) && is_array($_SESSION['flash_notifications'])) {
    [$fTone, $fText] = $_SESSION['flash_notifications'] + [null, null];
    unset($_SESSION['flash_notifications']);
    $fTone = in_array($fTone, ['success', 'error', 'warning', 'info'], true) ? $fTone : 'info';
    $msg .= '<p class="alert alert--' . $fTone . '" role="' . ($fTone === 'error' ? 'alert' : 'status') . '">' . h((string) $fText) . '</p>';
}

$gets = static fn(string $k): string => is_string($_GET[$k] ?? null) ? trim($_GET[$k]) : '';

/* ══════════════════════════════════════════════════════════════════════════
   COMPOSER — ?new=1, ?edit=<id>, or a POST being re-rendered
   ══════════════════════════════════════════════════════════════════════════ */

$editing = null;
if ($composer === null && ($gets('new') !== '' || $gets('edit') !== '')) {
    requireAdminCan('notifications.compose');
    if ($gets('edit') !== '') {
        $editing = notifyCampaignLoad((int) $gets('edit'));
        if ($editing === null) {
            ncFlash('warning', 'That notification no longer exists.');
            ncRedirect(NC_BASE);
        }
        if (!in_array($editing['status'], NOTIFY_CAMPAIGN_EDITABLE, true)) {
            ncFlash('warning', 'A notification that is ' . strtolower(ncStatusLabel($editing['status'])) . ' cannot be changed. Duplicate it to send something similar.');
            ncRedirect(NC_BASE . '?view=' . (int) $editing['id']);
        }
        $composer   = ncComposerFromCampaign($editing);
        $composerId = (int) $editing['id'];
    } else {
        $composer = ncComposerBlank();
        $seg = (int) $gets('segment');
        if ($seg > 0) $composer['audience'] = adminAudienceStateFrom($seg, null);
    }
} elseif ($composer !== null && $composerId !== null) {
    $editing = notifyCampaignLoad($composerId);
}

if ($composer !== null) {
    $f       = $composer;
    $errors  = $composerErrors;
    $isEdit  = $composerId !== null;
    $cats    = ncCampaignCategories($f['category']);
    $langs   = notifyLanguages();
    $tzLabel = ncTzLabel();
    $nowWall = substr(str_replace(' ', 'T', notifyFromUtc(notifyNow(), notifyTempleTz())), 0, 16);
    $estimateCount = $serverEstimate['count'] ?? null;

    $title = $isEdit ? 'Edit notification' : 'New notification';
    adminHeader($title, 'Communication', [
        'wide'    => true,
        'actions' => '<a href="' . NC_BASE . ($isEdit ? '?view=' . (int) $composerId : '') . '" class="btn btn-ghost btn--sm">' . adminIcon('arrow-left') . ($isEdit ? 'Back to the notification' : 'All notifications') . '</a>',
    ]);
    echo $msg;
    ?>
<div class="nc-page">
  <?php if ($editing && $editing['status'] !== 'draft'): ?>
    <div class="callout callout--maroon mb-4" data-keep>
      <?= adminIcon('alert') ?>
      <p><strong>This notification is <?= h(strtolower(ncStatusLabel($editing['status']))) ?>.</strong>
        Saving a change returns it to a draft: the approval<?= $editing['status'] === 'scheduled' ? ' and the schedule are' : ' is' ?> withdrawn and it has to be submitted again.</p>
    </div>
  <?php endif; ?>

  <?php if ($errors): ?>
    <div class="alert alert--error nc-error-summary" role="alert" tabindex="-1" id="nc-error-summary" data-keep>
      <div class="alert__body">
        <p class="alert__title">Nothing was saved. Please fix <?= count($errors) === 1 ? 'this' : 'these ' . count($errors) . ' things' ?>:</p>
        <ul class="nc-error-summary__list">
          <?php foreach ($errors as $key => $text): ?>
            <li><?php if ($key === '_'): ?><?= h((string) $text) ?><?php else: ?><a href="#<?= h(ncErrorTarget((string) $key)) ?>"><?= h((string) $text) ?></a><?php endif; ?></li>
          <?php endforeach; ?>
        </ul>
      </div>
    </div>
  <?php endif; ?>

  <form method="POST" action="<?= NC_BASE ?>" class="nc-composer" id="nc-composer" novalidate data-nc-composer
        aria-label="<?= h($title) ?>">
    <?= csrfField() ?>
    <?php // Enter in a text field submits the first button in the form: make that "Save draft", never "add a rule". ?>
    <button type="submit" name="action" value="save" class="sr-only" tabindex="-1">Save draft</button>
    <?php if ($isEdit): ?><input type="hidden" name="id" value="<?= (int) $composerId ?>" /><?php endif; ?>
    <input type="hidden" name="template_vars" value="<?= h($f['template_vars']) ?>" />

    <div class="nc-layout">
      <div class="nc-main">

        <section class="card card--solid card--static nc-card" aria-labelledby="nc-basics-h">
          <h2 class="nc-card__title" id="nc-basics-h"><?= adminIcon('pencil') ?>About this notification</h2>
          <label for="nc-name">
            <span class="field__label">Name <span class="field__required" aria-hidden="true">*</span></span>
            <input id="nc-name" name="name" type="text" maxlength="160" required aria-required="true" autocomplete="off"
                   value="<?= h($f['name']) ?>" placeholder="e.g. Kanda Sashti festival schedule"<?= ncAria($errors, 'name', 'nc-name-hint') ?> />
            <?= ncError($errors, 'name') ?>
            <span class="field__hint" id="nc-name-hint">For the committee only. Devotees never see it.</span>
          </label>
          <div class="form-grid">
            <label for="nc-category">
              <span class="field__label">Category <span class="field__required" aria-hidden="true">*</span></span>
              <select id="nc-category" name="category" required aria-required="true" data-nc-refresh<?= ncAria($errors, 'category', 'nc-category-hint') ?>>
                <?php foreach ($cats as $key => $cat): ?>
                  <option value="<?= h($key) ?>"<?= $f['category'] === $key ? ' selected' : '' ?>><?= h($cat['label_en']) ?><?= $cat['kind'] === 'promotional' ? ' (promotional)' : ($cat['kind'] === 'critical' ? ' (reaches everyone)' : '') ?></option>
                <?php endforeach; ?>
              </select>
              <?= ncError($errors, 'category') ?>
              <span class="field__hint" id="nc-category-hint">Devotees who muted the category do not receive it. Promotional messages reach only devotees who opted in.</span>
            </label>
            <label for="nc-priority">
              <span class="field__label">Priority</span>
              <select id="nc-priority" name="priority" data-nc-refresh<?= ncAria($errors, 'priority', 'nc-priority-hint') ?>>
                <?php foreach (NOTIFY_PRIORITIES as $p): ?>
                  <option value="<?= h($p) ?>"<?= $f['priority'] === $p ? ' selected' : '' ?>><?= h(ncPriorityLabel($p)) ?></option>
                <?php endforeach; ?>
              </select>
              <?= ncError($errors, 'priority') ?>
              <span class="field__hint" id="nc-priority-hint">Urgent and emergency always need an owner's approval and reach devotees who muted the category.</span>
            </label>
          </div>
          <label for="nc-template">
            <span class="field__label">Layout</span>
            <select id="nc-template" name="template_key" data-nc-refresh<?= ncAria($errors, 'template_key', 'nc-template-hint') ?>>
              <?php foreach (ncTemplateChoices($f['template_key']) as $key => $label): ?>
                <option value="<?= h($key) ?>"<?= $f['template_key'] === $key ? ' selected' : '' ?>><?= h($label) ?></option>
              <?php endforeach; ?>
            </select>
            <?= ncError($errors, 'template_key') ?><?= ncError($errors, 'template_vars') ?>
            <span class="field__hint" id="nc-template-hint">How the words are framed in each channel. The wording of layouts is edited on the Message Templates page.</span>
          </label>
        </section>

        <fieldset class="card card--solid card--static nc-fieldset" id="nc-channels"<?= isset($errors['channels']) ? ' aria-describedby="' . ncErrId('channels') . '"' : '' ?>>
          <legend class="nc-legend"><?= adminIcon('send') ?><span>Channels</span></legend>
          <?= ncError($errors, 'channels') ?>
          <p class="field__hint nc-fieldset__intro">Each devotee's own settings still apply: a channel they switched off, or have no number or device for, is skipped for them.</p>
          <div class="nc-channel-grid">
            <?php
              $channelNotes = [
                  'inapp'    => 'In the bell on the website, for devotees with an account.',
                  'email'    => 'Needs a confirmed address for most categories.',
                  'whatsapp' => 'Paid per message. Needs the devotee\'s mobile number.',
                  'sms'      => 'Paid per message. Used only for important messages and above.',
                  'push'     => 'Devotees who switched on alerts on a phone or computer.',
              ];
            ?>
            <?php foreach (NOTIFY_CHANNELS as $ch): $ps = ncProviderStatus($ch); $on = in_array($ch, $f['channels'], true); ?>
              <label class="nc-channel<?= $on ? ' is-checked' : '' ?>" for="nc-ch-<?= $ch ?>">
                <input type="checkbox" id="nc-ch-<?= $ch ?>" name="channels[]" value="<?= $ch ?>"<?= $on ? ' checked' : '' ?>
                       aria-describedby="nc-ch-<?= $ch ?>-status nc-ch-<?= $ch ?>-note" data-nc-channel data-label="<?= h(ncChannelLabel($ch)) ?>" />
                <span class="nc-channel__icon"><?= adminIcon(ncChannelIcon($ch)) ?></span>
                <span class="nc-channel__text">
                  <strong><?= h(ncChannelLabel($ch)) ?></strong>
                  <small class="nc-channel__status nc-channel__status--<?= h($ps['tone']) ?>" id="nc-ch-<?= $ch ?>-status"><?= h($ps['label']) ?></small>
                  <small class="nc-channel__note" id="nc-ch-<?= $ch ?>-note"><?= h($channelNotes[$ch]) ?></small>
                </span>
              </label>
            <?php endforeach; ?>
          </div>
        </fieldset>

        <section class="card card--solid card--static nc-card" aria-labelledby="nc-message-h">
          <h2 class="nc-card__title" id="nc-message-h"><?= adminIcon('message-square') ?>Message</h2>
          <?= ncError($errors, 'translations') ?>
          <p class="field__hint">Each devotee receives their own language. When a language is missing they get Tamil, then English.
            You may write <code>{{devoteeName}}</code> and <code>{{templeName}}</code>; they are filled in for every devotee.</p>
          <div class="nc-langs" data-nc-langs>
            <div class="tabs tabs--underline nc-tablist" role="tablist" aria-label="Message languages" data-nc-lang-tablist hidden></div>
            <?php foreach ($f['langs'] as $lang):
              $t = $f['translations'][$lang] ?? ['title' => '', 'body' => '', 'cta_label' => ''];
              $label = $langs[$lang] ?? strtoupper($lang);
              $base = 'translations.' . $lang;
            ?>
              <div class="nc-lang-panel" id="nc-lang-<?= h($lang) ?>" data-nc-lang-panel="<?= h($lang) ?>" data-label="<?= h($label) ?>">
                <h3 class="nc-lang-panel__title">
                  <span lang="<?= h($lang) ?>"><?= h($label) ?></span>
                  <?php if (!in_array($lang, ['ta', 'en'], true)): ?>
                    <button type="submit" name="remove_lang" value="<?= h($lang) ?>" class="btn btn-ghost btn--xs" data-nc-remove-lang><?= adminIcon('x') ?>Remove <?= h($label) ?></button>
                  <?php endif; ?>
                </h3>
                <?= ncError($errors, $base) ?>
                <label for="nc-lang-<?= h($lang) ?>-title">
                  <span class="field__label">Title<?= $lang === 'ta' ? ' <span class="field__optional">Tamil or English is required</span>' : '' ?></span>
                  <input id="nc-lang-<?= h($lang) ?>-title" type="text" name="translations[<?= h($lang) ?>][title]" maxlength="200" lang="<?= h($lang) ?>" dir="auto"
                         value="<?= h($t['title']) ?>" data-counter data-nc-refresh<?= ncAria($errors, $base . '.title') ?> />
                  <?= ncError($errors, $base . '.title') ?>
                </label>
                <label for="nc-lang-<?= h($lang) ?>-body">
                  <span class="field__label">Message</span>
                  <textarea id="nc-lang-<?= h($lang) ?>-body" name="translations[<?= h($lang) ?>][body]" rows="6" maxlength="20000" lang="<?= h($lang) ?>" dir="auto"
                            data-counter data-nc-body data-nc-refresh<?= ncAria($errors, $base . '.body', 'nc-lang-' . h($lang) . '-sms') ?>><?= h($t['body']) ?></textarea>
                  <?= ncError($errors, $base . '.body') ?>
                  <span class="field__hint nc-sms-count" id="nc-lang-<?= h($lang) ?>-sms" data-nc-sms-count></span>
                </label>
                <label for="nc-lang-<?= h($lang) ?>-cta_label">
                  <span class="field__label">Button label <span class="field__optional">optional</span></span>
                  <input id="nc-lang-<?= h($lang) ?>-cta_label" type="text" name="translations[<?= h($lang) ?>][cta_label]" maxlength="80" lang="<?= h($lang) ?>" dir="auto"
                         value="<?= h($t['cta_label']) ?>" data-nc-refresh<?= ncAria($errors, $base . '.cta_label') ?> />
                  <?= ncError($errors, $base . '.cta_label') ?>
                </label>
              </div>
            <?php endforeach; ?>

            <?php $spare = array_diff_key($langs, array_flip($f['langs'])); ?>
            <div class="nc-add-lang"<?= $spare ? '' : ' hidden' ?> data-nc-add-lang-row>
              <label for="nc-add-lang">
                <span class="field__label">Add a language</span>
                <select id="nc-add-lang" name="add_lang_code" data-nc-add-lang-select>
                  <?php foreach ($spare as $code => $label): ?>
                    <option value="<?= h($code) ?>"><?= h($label) ?> (<?= h($code) ?>)</option>
                  <?php endforeach; ?>
                </select>
              </label>
              <button type="submit" name="action" value="add_lang" class="btn btn--sm" data-nc-add-lang><?= adminIcon('plus') ?> Add language</button>
            </div>
            <template data-nc-lang-template>
              <div class="nc-lang-panel" id="nc-lang-__LANG__" data-nc-lang-panel="__LANG__" data-label="">
                <h3 class="nc-lang-panel__title">
                  <span lang="__LANG__" data-nc-lang-name></span>
                  <button type="button" class="btn btn-ghost btn--xs" data-nc-remove-lang><?= adminIcon('x') ?><span data-nc-remove-label>Remove</span></button>
                </h3>
                <label for="nc-lang-__LANG__-title"><span class="field__label">Title</span>
                  <input id="nc-lang-__LANG__-title" type="text" name="translations[__LANG__][title]" maxlength="200" lang="__LANG__" dir="auto" data-nc-counter data-nc-refresh /></label>
                <label for="nc-lang-__LANG__-body"><span class="field__label">Message</span>
                  <textarea id="nc-lang-__LANG__-body" name="translations[__LANG__][body]" rows="6" maxlength="20000" lang="__LANG__" dir="auto" aria-describedby="nc-lang-__LANG__-sms" data-nc-counter data-nc-body data-nc-refresh></textarea>
                  <span class="field__hint nc-sms-count" id="nc-lang-__LANG__-sms" data-nc-sms-count></span></label>
                <label for="nc-lang-__LANG__-cta_label"><span class="field__label">Button label <span class="field__optional">optional</span></span>
                  <input id="nc-lang-__LANG__-cta_label" type="text" name="translations[__LANG__][cta_label]" maxlength="80" lang="__LANG__" dir="auto" data-nc-refresh /></label>
              </div>
            </template>
          </div>
        </section>

        <section class="card card--solid card--static nc-card" aria-labelledby="nc-link-h">
          <h2 class="nc-card__title" id="nc-link-h"><?= adminIcon('external') ?>Link and picture</h2>
          <div class="form-grid">
            <label for="nc-cta">
              <span class="field__label">Button link <span class="field__optional">optional</span></span>
              <input id="nc-cta" type="text" inputmode="url" name="cta_url" maxlength="500" spellcheck="false" autocapitalize="off"
                     value="<?= h($f['cta_url']) ?>" placeholder="/events" data-nc-refresh<?= ncAria($errors, 'cta_url', 'nc-cta-hint') ?> />
              <?= ncError($errors, 'cta_url') ?>
              <span class="field__hint" id="nc-cta-hint">A page on this site such as /sevas, or an address starting with https://.</span>
            </label>
            <label for="nc-image">
              <span class="field__label">Picture <span class="field__optional">optional</span></span>
              <input id="nc-image" type="text" inputmode="url" name="image_url" maxlength="500" spellcheck="false" autocapitalize="off"
                     value="<?= h($f['image_url']) ?>" placeholder="/uploads/gallery/festival.jpg" data-nc-refresh<?= ncAria($errors, 'image_url', 'nc-image-hint') ?> />
              <?= ncError($errors, 'image_url') ?>
              <span class="field__hint" id="nc-image-hint">Shown in push alerts and the bell where the device supports it.</span>
            </label>
          </div>
        </section>

        <?= adminAudienceForm($db, $f['audience'], [
            'segments'      => adminAudienceSegments($db),
            'errors'        => $errors,
            'found'         => $foundDevotees,
            'estimate'      => $estimateCount,
            'estimateError' => $serverEstimate['error'] ?? null,
            'approvalHint'  => ncApprovalHint($f, $estimateCount),
        ]) ?>

        <fieldset class="card card--solid card--static nc-fieldset" id="nc-schedule" data-nc-schedule>
          <legend class="nc-legend"><?= adminIcon('calendar-clock') ?><span>When it is sent</span></legend>
          <fieldset class="nc-subfieldset">
            <legend class="nc-sublegend">Sending</legend>
            <div class="nc-source-grid nc-source-grid--2">
              <label class="nc-option" for="nc-mode-manual">
                <input type="radio" id="nc-mode-manual" name="schedule_mode" value="manual"<?= $f['schedule_mode'] === 'manual' ? ' checked' : '' ?> data-nc-schedule-mode />
                <span class="nc-option__icon"><?= adminIcon('send') ?></span>
                <span class="nc-option__text"><strong>By hand, once approved</strong><small>Press “Send now” on its page when it has been approved.</small></span>
              </label>
              <label class="nc-option" for="nc-mode-at">
                <input type="radio" id="nc-mode-at" name="schedule_mode" value="at"<?= $f['schedule_mode'] === 'at' ? ' checked' : '' ?> data-nc-schedule-mode />
                <span class="nc-option__icon"><?= adminIcon('calendar-clock') ?></span>
                <span class="nc-option__text"><strong>At a date and time</strong><small>It is scheduled as soon as it is approved.</small></span>
              </label>
            </div>
          </fieldset>

          <div class="nc-schedule-at" data-nc-schedule-at>
            <div class="form-grid">
              <label for="nc-when">
                <span class="field__label">Date and time</span>
                <input id="nc-when" type="datetime-local" name="scheduled_local" value="<?= h($f['scheduled_local']) ?>" min="<?= h($nowWall) ?>"<?= ncAria($errors, 'scheduled_local', 'nc-when-hint') ?> />
                <?= ncError($errors, 'scheduled_local') ?>
                <span class="field__hint" id="nc-when-hint">Temple time now: <?= h(ncTempleTime(notifyNow())) ?>.</span>
              </label>
              <fieldset class="nc-subfieldset">
                <legend class="nc-sublegend">Whose clock</legend>
                <label class="checkbox-label nc-radio" for="nc-tz-temple">
                  <input type="radio" id="nc-tz-temple" name="schedule_tz" value="temple"<?= $f['schedule_tz'] === 'temple' ? ' checked' : '' ?> />
                  <span>Temple time (<?= h($tzLabel) ?>) <small class="nc-muted">Everyone receives it at the same moment.</small></span>
                </label>
                <label class="checkbox-label nc-radio" for="nc-tz-recipient">
                  <input type="radio" id="nc-tz-recipient" name="schedule_tz" value="recipient"<?= $f['schedule_tz'] === 'recipient' ? ' checked' : '' ?> />
                  <span>Each devotee's own time <small class="nc-muted">6:00 pm in Chennai, then 6:00 pm in London hours later.</small></span>
                </label>
                <?= ncError($errors, 'schedule_tz') ?>
              </fieldset>
            </div>
            <div class="form-grid">
              <label for="nc-recurrence">
                <span class="field__label">Repeat</span>
                <select id="nc-recurrence" name="recurrence" data-nc-recurrence<?= ncAria($errors, 'recurrence') ?>>
                  <?php foreach (['none' => 'Does not repeat', 'daily' => 'Every day', 'weekly' => 'Every week', 'monthly' => 'Every month, on the same date'] as $key => $label): ?>
                    <option value="<?= $key ?>"<?= $f['recurrence'] === $key ? ' selected' : '' ?>><?= h($label) ?></option>
                  <?php endforeach; ?>
                </select>
                <?= ncError($errors, 'recurrence') ?>
              </label>
              <label for="nc-until" data-nc-until>
                <span class="field__label">Last date <span class="field__optional">optional</span></span>
                <input id="nc-until" type="date" name="recur_until" value="<?= h($f['recur_until']) ?>"<?= ncAria($errors, 'recur_until', 'nc-until-hint') ?> />
                <?= ncError($errors, 'recur_until') ?>
                <span class="field__hint" id="nc-until-hint">Leave empty to keep repeating until it is cancelled.</span>
              </label>
            </div>
          </div>
        </fieldset>

        <div class="card card--solid card--static nc-card nc-submitbar">
          <div class="form-actions">
            <button type="submit" name="action" value="save" class="btn btn-outline"><?= adminIcon('check') ?> Save draft</button>
            <button type="submit" name="action" value="save_submit" class="btn btn-primary"><?= adminIcon('send') ?> Save and submit</button>
            <a href="<?= NC_BASE . ($isEdit ? '?view=' . (int) $composerId : '') ?>" class="btn btn-ghost">Cancel</a>
          </div>
          <p class="field__hint">Submitting sends nothing yet. Small messages are approved automatically; larger, urgent, paid or promotional ones wait for an owner other than you.
            <?php if ($isEdit): ?><a href="<?= NC_BASE ?>?view=<?= (int) $composerId ?>#nc-test">Send yourself a test</a> from its page.<?php endif; ?></p>
        </div>
      </div>

      <aside class="nc-aside" aria-label="Recipients and preview">
        <section class="card card--solid card--static nc-card nc-preview" data-nc-preview aria-labelledby="nc-preview-h">
          <h2 class="nc-card__title" id="nc-preview-h"><?= adminIcon('eye') ?>Preview</h2>
          <div class="nc-preview__toolbar" data-nc-preview-toolbar hidden>
            <div class="tabs tabs--underline nc-tablist" role="tablist" aria-label="Preview channel" data-nc-preview-tabs></div>
            <label for="nc-preview-lang" class="nc-preview__lang">
              <span class="field__label">Language</span>
              <select id="nc-preview-lang" data-nc-preview-lang></select>
            </label>
          </div>
          <div class="nc-preview__panel" id="nc-preview-panel" role="tabpanel" tabindex="0" aria-live="off" data-nc-preview-panel>
            <p class="field__hint">Save the draft to see how it looks in every channel on its page.</p>
          </div>
        </section>
      </aside>
    </div>
  </form>
</div>
<script src="/admin/assets/notify-campaigns.js" defer></script>
    <?php
    adminFooter();
    exit;
}

/* ══════════════════════════════════════════════════════════════════════════
   ONE CAMPAIGN — ?view=<id>
   ══════════════════════════════════════════════════════════════════════════ */

if ($gets('view') !== '') {
    $c = notifyCampaignGet((int) $gets('view'));
    if ($c === null) {
        ncFlash('warning', 'That notification no longer exists.');
        ncRedirect(NC_BASE);
    }
    $id       = (int) $c['id'];
    $status   = (string) $c['status'];
    $fields   = notifyAudienceFields();
    $describe = $c['segment_id'] !== null && $c['segment'] === null
        ? ['summary' => 'The saved audience it used has been deleted', 'items' => [], 'ok' => false]
        : adminAudienceDescribe($c['rules'], $fields);
    $stats    = $c['stats'];
    $mine     = (string) $c['created_by'] === $actor['username'];
    $canEdit  = $canCompose && in_array($status, NOTIFY_CAMPAIGN_EDITABLE, true);
    $canCancel = in_array($status, NOTIFY_CAMPAIGN_CANCELLABLE, true) && ($status === 'draft' && $mine ? $canCompose : $canApprove);
    $problem  = in_array($status, ['draft', 'review', 'approved'], true) ? notifyCampaignProblem($c) : null;
    $cat      = notifyCategory((string) $c['category']);
    $catLabel = $cat['label_en'] ?? (string) $c['category'];
    $liveCount = null;
    try {
        if ($c['rules'] !== null && in_array($status, ['draft', 'review', 'approved', 'scheduled'], true)) $liveCount = notifyAudienceCount($c['rules']);
    } catch (Throwable) {
        $liveCount = null;
    }

    // The audit trail, newest first.
    $audit = [];
    try {
        $stmt = $db->prepare('SELECT id, action, actor, actor_role, detail, created_at FROM notification_audit WHERE campaign_id = :id ORDER BY created_at DESC, id DESC LIMIT 200');
        $stmt->execute([':id' => $id]);
        $audit = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        error_log('[notify] audit trail unavailable: ' . $e->getMessage());
    }
    // The latest decision, for the banner: sent back since it was last submitted?
    $lastRejection = null;
    foreach ($audit as $a) {
        if ($a['action'] === 'submitted') break;
        if ($a['action'] === 'rejected') {
            $lastRejection = $a;
            break;
        }
    }

    // Why deliveries were skipped, the commonest first.
    $skips = [];
    try {
        $stmt = $db->prepare(
            "SELECT d.channel, COALESCE(d.skip_reason, 'no reason recorded') AS reason, COUNT(*) AS n
               FROM notification_deliveries d JOIN notifications x ON x.id = d.notification_id
              WHERE x.campaign_id = :id AND d.status = 'skipped'
              GROUP BY d.channel, reason ORDER BY n DESC LIMIT 12"
        );
        $stmt->execute([':id' => $id]);
        $skips = $stmt->fetchAll(PDO::FETCH_ASSOC);
    } catch (Throwable) {
        $skips = [];
    }

    // Previews, per channel and language, rendered on the server so the page reads the same without JavaScript.
    $previewLangs = [];
    foreach ($c['translations'] as $lang => $t) {
        if (trim($t['title']) !== '' && trim($t['body']) !== '') $previewLangs[] = $lang;
    }
    $previews = [];
    foreach ($c['channelsList'] as $ch) {
        foreach ($previewLangs as $lang) {
            try {
                $previews[$ch][$lang] = notifyCampaignPreview($c, $ch, $lang);
            } catch (Throwable $e) {
                error_log('[notify] preview failed: ' . $e->getMessage());
            }
        }
    }

    $tzLabel  = ncTzLabel();
    $nowWall  = substr(str_replace(' ', 'T', notifyFromUtc(notifyNow(), notifyTempleTz())), 0, 16);
    $selfOk   = $status === 'review' ? notifyCampaignSelfApprovalAllowed($c, $actor['username']) : false;
    $langs    = notifyLanguages();

    $topActions = '<a href="' . NC_BASE . '" class="btn btn-ghost btn--sm">' . adminIcon('arrow-left') . 'All notifications</a>';
    if ($canEdit) $topActions .= '<a href="' . NC_BASE . '?edit=' . $id . '" class="btn btn-outline btn--sm">' . adminIcon('pencil') . 'Edit</a>';
    adminHeader((string) $c['name'], 'Communication', ['actions' => $topActions, 'wide' => true]);
    echo $msg;

    $channelStatusCols = [
        'Waiting'   => ['queued', 'sending', 'failed'],
        'Sent'      => ['sent'],
        'Delivered' => ['delivered'],
        'Read'      => ['read'],
        'Failed'    => ['rejected', 'dead'],
        'Skipped'   => ['skipped'],
        'Cancelled' => ['cancelled'],
    ];
    $sum = static function (array $byStatus, array $keys): int {
        $n = 0;
        foreach ($keys as $k) $n += (int) ($byStatus[$k] ?? 0);
        return $n;
    };
    $sentTotal = 0;
    foreach ($stats['byChannel'] as $byStatus) $sentTotal += $sum($byStatus, ['sent', 'delivered', 'read']);
    ?>
<div class="nc-page">

  <?php if ($status === 'review'): ?>
    <section class="callout callout--maroon nc-banner mb-4" id="nc-approval" aria-labelledby="nc-approval-h">
      <?= adminIcon('user-check') ?>
      <div class="nc-banner__body">
        <h2 class="nc-banner__title" id="nc-approval-h">Waiting for an owner's approval</h2>
        <p><strong>Why:</strong> <?= h((string) ($c['approval_reason'] ?: 'It crosses an approval threshold')) ?>.
          <?= (int) $c['estimated_count'] > 0 ? 'About ' . number_format((int) $c['estimated_count']) . ' devotees when it was submitted' . ($c['submitted_by'] ? ' by ' . h((string) $c['submitted_by']) : '') . ', ' . h(ncAgo((string) $c['submitted_at'])) . '.' : '' ?></p>
        <p><strong>Who can approve:</strong>
          <?php if (notifyEnv('NOTIFY_ALLOW_SELF_APPROVAL') === '1'): ?>
            any owner, including its author (this site allows self-approval).
          <?php else: ?>
            any owner other than its author, <strong><?= h((string) $c['created_by']) ?></strong>. When no other owner exists, the author may approve it.
          <?php endif; ?>
        </p>
        <?php if ($canApprove && $selfOk): ?>
          <div class="nc-banner__actions">
            <form method="POST" action="<?= NC_BASE ?>">
              <?= csrfField() ?>
              <input type="hidden" name="action" value="approve" /><input type="hidden" name="id" value="<?= $id ?>" />
              <button type="submit" class="btn btn-primary btn--sm" data-confirm="Approve “<?= h((string) $c['name']) ?>”? <?= $c['scheduled_local'] ? 'It will be scheduled for its planned time.' : 'It can then be sent or scheduled.' ?>" data-confirm-label="Approve"><?= adminIcon('check') ?> Approve</button>
            </form>
            <details class="nc-details">
              <summary class="btn btn-outline btn--sm"><?= adminIcon('undo') ?> Send back to the author</summary>
              <form method="POST" action="<?= NC_BASE ?>" class="nc-inline-form">
                <?= csrfField() ?>
                <input type="hidden" name="action" value="reject" /><input type="hidden" name="id" value="<?= $id ?>" />
                <label for="nc-reject-reason">
                  <span class="field__label">What needs to change <span class="field__required" aria-hidden="true">*</span></span>
                  <textarea id="nc-reject-reason" name="reason" rows="3" maxlength="500" required aria-required="true"></textarea>
                </label>
                <button type="submit" class="btn btn--sm"><?= adminIcon('undo') ?> Send back</button>
              </form>
            </details>
          </div>
        <?php elseif ($canApprove): ?>
          <p class="nc-banner__note"><?= adminIcon('info') ?> You wrote this notification, so another owner needs to approve it.</p>
        <?php else: ?>
          <p class="nc-banner__note"><?= adminIcon('info') ?> Your role (<?= h(ucfirst($actor['role'])) ?>) cannot approve. An owner will review it.</p>
        <?php endif; ?>
      </div>
    </section>
  <?php elseif ($status === 'draft' && $lastRejection): $rd = json_decode((string) $lastRejection['detail'], true) ?: []; ?>
    <div class="callout callout--maroon mb-4" role="note">
      <?= adminIcon('undo') ?>
      <p><strong>Sent back by <?= h((string) $lastRejection['actor']) ?> <?= h(ncAgo((string) $lastRejection['created_at'])) ?>:</strong> <?= h((string) ($rd['reason'] ?? '')) ?></p>
    </div>
  <?php endif; ?>

  <?php if ($problem !== null && $status !== 'review'): ?>
    <div class="callout mb-4" role="note"><?= adminIcon('alert') ?><p><strong>Before it can be sent:</strong> <?= h($problem) ?></p></div>
  <?php elseif ($status === 'failed' && $c['last_error']): ?>
    <div class="callout callout--maroon mb-4" role="note"><?= adminIcon('alert-circle') ?><p><strong>It stopped:</strong> <?= h((string) $c['last_error']) ?></p></div>
  <?php endif; ?>

  <section class="card card--solid card--static nc-card nc-summary" aria-labelledby="nc-summary-h">
    <div class="nc-summary__head">
      <div>
        <p class="nc-eyebrow">Notification #<?= $id ?></p>
        <h2 class="nc-summary__title" id="nc-summary-h"><?= h((string) $c['name']) ?></h2>
        <p class="nc-badges">
          <?= adminBadge(ncStatusLabel($status), ncStatusTone($status), $status === 'sending') ?>
          <?= $c['priority'] !== 'normal' ? adminBadge(ncPriorityLabel((string) $c['priority']), ncPriorityTone((string) $c['priority'])) : '' ?>
          <?= adminBadge($catLabel, 'gold') ?>
          <?= $c['recurrence'] !== 'none' ? adminBadge('Repeats ' . $c['recurrence'], 'sage') : '' ?>
        </p>
      </div>
    </div>
    <dl class="dl-grid nc-facts">
      <dt>Audience</dt>
      <dd>
        <?= $c['segment'] ? 'Saved audience <a href="/admin/notification_segments.php?edit=' . (int) $c['segment']['id'] . '">' . h($c['segment']['name']) . '</a>: ' : '' ?><?= h($describe['summary']) ?>
        <?php if ($describe['items']): ?><ul class="nc-rule-list"><?php foreach ($describe['items'] as $item): ?><li><?= h($item) ?></li><?php endforeach; ?></ul><?php endif; ?>
        <?php if ($liveCount !== null): ?><span class="nc-muted">Matches <?= number_format($liveCount) ?> devotee<?= $liveCount === 1 ? '' : 's' ?> right now<?= (int) $c['estimated_count'] > 0 ? '; ' . number_format((int) $c['estimated_count']) . ' when submitted' : '' ?>.</span><?php endif; ?>
      </dd>
      <dt>Channels</dt>
      <dd class="nc-channel-list">
        <?php foreach ($c['channelsList'] as $ch): $ps = ncProviderStatus($ch); ?>
          <span class="nc-channel-chip"><?= adminIcon(ncChannelIcon($ch), 'ico--sm') ?><?= h(ncChannelLabel($ch)) ?><small class="nc-channel__status nc-channel__status--<?= h($ps['tone']) ?>"><?= h($ps['label']) ?></small></span>
        <?php endforeach; ?>
      </dd>
      <dt>When</dt>
      <dd>
        <?php $when = ncScheduleLabel($c); ?>
        <?= $when !== '' ? h($when) : ($status === 'sending' || $status === 'completed' ? 'Sent by hand ' . h(ncTempleTime((string) $c['scheduled_at'])) : 'By hand, from this page, once approved') ?>
        <?php if ($c['recurrence'] !== 'none'): ?>
          <span class="nc-muted">Repeats <?= h($c['recurrence']) ?><?= $c['recur_until'] ? ' until ' . h(ncWallClock($c['recur_until'] . ' 00:00:00')) : ' until cancelled' ?>.</span>
        <?php endif; ?>
        <?php if ($c['schedule_tz'] === 'recipient' && $c['scheduled_local']): ?>
          <span class="nc-muted nc-tz-note"><?= adminIcon('globe', 'ico--xs') ?>Each devotee receives it at that time in their own time zone (from their settings, or their country).
            <?= $c['scheduled_at'] && $status === 'scheduled' ? 'The first devotees, furthest east, receive it from ' . h(ncTempleTime((string) $c['scheduled_at'])) . '; devotees west of India later that day.' : '' ?></span>
        <?php elseif ($c['scheduled_local']): ?>
          <span class="nc-muted nc-tz-note"><?= adminIcon('globe', 'ico--xs') ?>Temple time. Devotees in other countries receive it at the same moment, which is a different hour on their clock.</span>
        <?php endif; ?>
        <?php if ($c['next_run_at'] && $status === 'scheduled' && (int) $c['run_count'] > 0): ?>
          <span class="nc-muted">Sent <?= (int) $c['run_count'] ?> time<?= (int) $c['run_count'] === 1 ? '' : 's' ?> so far.</span>
        <?php endif; ?>
      </dd>
      <?php if ($c['cta_url']): ?><dt>Button link</dt><dd><code><?= h((string) $c['cta_url']) ?></code></dd><?php endif; ?>
      <?php if ($c['image_url']): ?><dt>Picture</dt><dd><code><?= h((string) $c['image_url']) ?></code></dd><?php endif; ?>
      <dt>Written by</dt><dd><?= h((string) ($c['created_by'] ?: 'system')) ?> · <?= h(ncTempleTime((string) $c['created_at'])) ?><?= $c['updated_by'] && $c['updated_by'] !== $c['created_by'] ? ' · last edited by ' . h((string) $c['updated_by']) : '' ?></dd>
      <?php if ($c['approved_by']): ?><dt>Approved</dt><dd><?= $c['approved_by'] === 'system' ? 'Automatically (below every approval threshold)' : h((string) $c['approved_by']) ?> · <?= h(ncTempleTime((string) $c['approved_at'])) ?></dd><?php endif; ?>
      <?php if ($c['sent_by']): ?><dt>Sent by</dt><dd><?= h((string) $c['sent_by']) ?><?= $c['started_at'] ? ' · started ' . h(ncTempleTime((string) $c['started_at'])) : '' ?><?= $c['completed_at'] ? ' · finished ' . h(ncTempleTime((string) $c['completed_at'])) : '' ?></dd><?php endif; ?>
      <?php if ($c['cancelled_by']): ?><dt>Cancelled</dt><dd><?= h((string) $c['cancelled_by']) ?> · <?= h(ncTempleTime((string) $c['cancelled_at'])) ?></dd><?php endif; ?>
    </dl>
  </section>

  <div class="dash-grid nc-view-grid">
    <div class="nc-main">
      <section class="card card--solid card--static nc-card" aria-labelledby="nc-stats-h">
        <h2 class="nc-card__title" id="nc-stats-h"><?= adminIcon('activity') ?>Delivery</h2>
        <?php if ((int) $stats['recipients'] === 0): ?>
          <?= adminEmpty('send', in_array($status, ['completed', 'cancelled', 'failed'], true) ? 'Nothing was delivered' : 'Nothing has been sent yet',
              $status === 'sending' ? 'The worker is preparing messages for each devotee; figures appear within a few minutes.' : 'Figures appear here once it starts sending.', '', true) ?>
        <?php else: ?>
          <?= adminKpi([
              ['icon' => 'users',        'value' => number_format((int) $stats['recipients']), 'label' => 'Devotees reached', 'variant' => 'accent'],
              ['icon' => 'check-circle', 'value' => number_format($sentTotal), 'label' => 'Messages sent'],
              ['icon' => 'eye',          'value' => number_format((int) $stats['read']), 'label' => 'Read in the bell'],
              ['icon' => 'mail',         'value' => number_format((int) $stats['opened']), 'label' => 'Emails opened'],
              ['icon' => 'arrow-up-right', 'value' => number_format((int) $stats['clicked']), 'label' => 'Link clicks'],
              ['icon' => 'alert-circle', 'value' => number_format((int) $stats['failed'] + (int) $stats['dead']), 'label' => 'Failed', 'sub' => (int) $stats['dead'] > 0 ? (int) $stats['dead'] . ' gave up after retries' : null],
          ]) ?>
          <?php // The table scrolls sideways on a phone and holds nothing focusable, so the wrapper takes focus for keyboard scrolling. ?>
          <div class="table-wrap" tabindex="0" role="region" aria-label="Messages by channel and status">
            <table class="table table--compact nc-stat-table" data-no-search>
              <caption class="sr-only">Messages by channel and status</caption>
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <?php foreach (array_keys($channelStatusCols) as $label): ?><th scope="col" class="text-right"><?= h($label) ?></th><?php endforeach; ?>
                  <th scope="col" class="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                <?php foreach (NOTIFY_CHANNELS as $ch): if (!isset($stats['byChannel'][$ch])) continue; $bs = $stats['byChannel'][$ch]; ?>
                  <tr>
                    <th scope="row"><?= adminIcon(ncChannelIcon($ch), 'ico--sm') ?> <?= h(ncChannelLabel($ch)) ?></th>
                    <?php foreach ($channelStatusCols as $keys): ?><td class="cell-num text-right"><?= number_format($sum($bs, $keys)) ?></td><?php endforeach; ?>
                    <td class="cell-num text-right"><strong><?= number_format(array_sum($bs)) ?></strong></td>
                  </tr>
                <?php endforeach; ?>
              </tbody>
            </table>
          </div>
          <?php if ($skips): ?>
            <h3 class="nc-subtitle">Why some were skipped</h3>
            <ul class="nc-skip-list">
              <?php foreach ($skips as $s): ?>
                <li><span><?= h(ncChannelLabel((string) $s['channel'])) ?>: <?= h((string) $s['reason']) ?></span><span class="cell-num"><?= number_format((int) $s['n']) ?></span></li>
              <?php endforeach; ?>
            </ul>
          <?php endif; ?>
          <p class="field__hint">Per-delivery detail and requeueing are on <a href="/admin/notification_analytics.php?campaign=<?= $id ?>">Delivery Analytics</a>.</p>
        <?php endif; ?>
      </section>

      <section class="card card--solid card--static nc-card" aria-labelledby="nc-pv-h">
        <h2 class="nc-card__title" id="nc-pv-h"><?= adminIcon('eye') ?>How it looks</h2>
        <?php if (!$previews): ?>
          <p class="field__hint">Write a title and message and choose a channel to see a preview.</p>
        <?php else: ?>
          <div class="nc-tabs" data-nc-tabs>
            <div class="tabs tabs--underline nc-tablist" role="tablist" aria-label="Preview channel" data-nc-tablist hidden></div>
            <?php foreach ($previews as $ch => $byLang): ?>
              <div class="nc-tabpanel" id="nc-pv-<?= h($ch) ?>" data-nc-tabpanel data-label="<?= h(ncChannelLabel($ch)) ?>">
                <h3 class="nc-tabpanel__heading"><?= adminIcon(ncChannelIcon($ch), 'ico--sm') ?> <?= h(ncChannelLabel($ch)) ?></h3>
                <div class="nc-pv-grid">
                  <?php foreach ($byLang as $lang => $p): ?>
                    <div class="nc-pv-cell">
                      <p class="nc-pv-lang" lang="<?= h($lang) ?>"><?= h($langs[$lang] ?? strtoupper($lang)) ?></p>
                      <?php
                        $bodyHtml = nl2br(h((string) $p['body']));
                        $missing  = $p['missing'] ? '<p class="nc-pv-missing">' . adminIcon('alert', 'ico--xs') . 'No value for: ' . h(implode(', ', $p['missing'])) . '</p>' : '';
                      ?>
                      <?php if ($ch === 'inapp'): ?>
                        <article class="nc-pv-inapp" lang="<?= h($lang) ?>">
                          <span class="nc-pv-inapp__icon"><?= adminIcon('bell') ?></span>
                          <div class="nc-pv-inapp__text">
                            <strong class="nc-pv-inapp__title"><?= h((string) $p['title']) ?></strong>
                            <p class="nc-pv-inapp__body"><?= $bodyHtml ?></p>
                            <?php if ($p['cta_url']): ?><span class="nc-pv-inapp__cta"><?= h((string) ($p['cta_label'] ?: 'Open')) ?> <?= adminIcon('arrow-right', 'ico--xs') ?></span><?php endif; ?>
                          </div>
                        </article>
                      <?php elseif ($ch === 'email'): ?>
                        <div class="nc-pv-email">
                          <p class="nc-pv-email__subject"><span class="nc-muted">Subject</span> <span lang="<?= h($lang) ?>"><?= h((string) $p['title']) ?></span></p>
                          <iframe class="nc-pv-email__frame" sandbox="" referrerpolicy="no-referrer" loading="lazy" title="Email preview, <?= h($langs[$lang] ?? $lang) ?>" srcdoc="<?= h((string) $p['html']) ?>"></iframe>
                        </div>
                      <?php elseif ($ch === 'whatsapp'): ?>
                        <div class="nc-pv-wa">
                          <div class="nc-pv-wa__bubble" lang="<?= h($lang) ?>"><?= $p['title'] !== '' ? '<strong>' . h((string) $p['title']) . '</strong><br />' : '' ?><?= $bodyHtml ?>
                            <?php if ($p['cta_url']): ?><span class="nc-pv-wa__link"><?= h((string) $p['cta_url']) ?></span><?php endif; ?>
                          </div>
                          <p class="nc-pv-meta"><?= $p['provider_template'] ? 'Approved template <code>' . h((string) $p['provider_template']) . '</code>' . ($p['params'] ? ' with ' . h(implode(' · ', array_map(static fn($v, $i) => ($i + 1) . ': ' . $v, $p['params'], array_keys($p['params'])))) : '') : 'No approved template name is set, so it is sent as free text.' ?></p>
                        </div>
                      <?php elseif ($ch === 'sms'): ?>
                        <div class="nc-pv-sms">
                          <p class="nc-pv-sms__text" lang="<?= h($lang) ?>"><?= $bodyHtml ?></p>
                          <?php $sms = $p['sms'] ?? ['chars' => 0, 'segments' => 0, 'encoding' => 'GSM-7']; ?>
                          <p class="nc-pv-meta"><?= number_format((int) $sms['chars']) ?> characters · <?= (int) $sms['segments'] ?> SMS part<?= (int) $sms['segments'] === 1 ? '' : 's' ?> · <?= h((string) $sms['encoding']) ?><?= $p['provider_template'] ? ' · DLT template <code>' . h((string) $p['provider_template']) . '</code>' : '' ?></p>
                        </div>
                      <?php else: ?>
                        <div class="nc-pv-push" lang="<?= h($lang) ?>">
                          <span class="nc-pv-push__icon"><?= adminIcon('bell') ?></span>
                          <div><strong class="nc-pv-push__title"><?= h((string) $p['title']) ?></strong><p class="nc-pv-push__body"><?= h((string) $p['body']) ?></p></div>
                        </div>
                      <?php endif; ?>
                      <?= $missing ?>
                    </div>
                  <?php endforeach; ?>
                </div>
              </div>
            <?php endforeach; ?>
          </div>
        <?php endif; ?>
      </section>
    </div>

    <div class="nc-side">
      <?php
        $actionsHtml = '';
        ob_start();
        if ($canCompose && $status === 'draft'): ?>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-action">
            <?= csrfField() ?><input type="hidden" name="action" value="submit" /><input type="hidden" name="id" value="<?= $id ?>" />
            <button type="submit" class="btn btn-primary btn--block"<?= $problem ? ' aria-describedby="nc-submit-hint"' : '' ?>><?= adminIcon('send') ?> Submit for approval</button>
            <p class="field__hint" id="nc-submit-hint">Nothing is sent yet. Small messages are approved at once.</p>
          </form>
        <?php endif;
        if ($canCompose && $status === 'approved' && $c['recurrence'] === 'none'): ?>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-action">
            <?= csrfField() ?><input type="hidden" name="action" value="send_now" /><input type="hidden" name="id" value="<?= $id ?>" />
            <button type="submit" class="btn btn-primary btn--block"
                    data-confirm="Send “<?= h((string) $c['name']) ?>” now to about <?= number_format($liveCount ?? (int) $c['estimated_count']) ?> devotees by <?= h(implode(', ', array_map('ncChannelLabel', $c['channelsList']))) ?>? It cannot be unsent."
                    data-confirm-label="Send now"><?= adminIcon('send') ?> Send now</button>
          </form>
        <?php endif;
        if ($canCompose && $status === 'approved'): ?>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-action nc-inline-form" id="nc-schedule-form">
            <?= csrfField() ?><input type="hidden" name="action" value="schedule" /><input type="hidden" name="id" value="<?= $id ?>" />
            <fieldset class="nc-subfieldset">
              <legend class="nc-sublegend">Schedule</legend>
              <label for="nc-sched-when">
                <span class="field__label">Date and time</span>
                <input id="nc-sched-when" type="datetime-local" name="scheduled_local" required aria-required="true" min="<?= h($nowWall) ?>"
                       value="<?= $c['scheduled_local'] ? h(substr(str_replace(' ', 'T', (string) $c['scheduled_local']), 0, 16)) : '' ?>" />
              </label>
              <label class="checkbox-label nc-radio" for="nc-sched-temple">
                <input type="radio" id="nc-sched-temple" name="schedule_tz" value="temple"<?= $c['schedule_tz'] !== 'recipient' ? ' checked' : '' ?> />
                <span>Temple time (<?= h($tzLabel) ?>)</span>
              </label>
              <label class="checkbox-label nc-radio" for="nc-sched-recipient">
                <input type="radio" id="nc-sched-recipient" name="schedule_tz" value="recipient"<?= $c['schedule_tz'] === 'recipient' ? ' checked' : '' ?> />
                <span>Each devotee's own time</span>
              </label>
              <button type="submit" class="btn btn-outline btn--block"><?= adminIcon('calendar-clock') ?> Schedule</button>
            </fieldset>
          </form>
        <?php endif;
        if ($canApprove && $c['priority'] === 'emergency' && in_array($status, ['draft', 'review', 'approved'], true)): ?>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-action nc-inline-form nc-emergency">
            <?= csrfField() ?><input type="hidden" name="action" value="emergency_send" /><input type="hidden" name="id" value="<?= $id ?>" />
            <label for="nc-emergency-reason">
              <span class="field__label">Emergency send: why it cannot wait <span class="field__required" aria-hidden="true">*</span></span>
              <textarea id="nc-emergency-reason" name="reason" rows="3" maxlength="500" required aria-required="true" aria-describedby="nc-emergency-hint"></textarea>
              <span class="field__hint" id="nc-emergency-hint">Sends now without a second approval. Your name and reason are kept in the audit trail.</span>
            </label>
            <button type="submit" class="btn btn-danger btn--block"
                    data-confirm="Send this emergency notification now to about <?= number_format($liveCount ?? (int) $c['estimated_count']) ?> devotees, without a second approval? It reaches devotees who muted announcements."
                    data-confirm-label="Send emergency notification"><?= adminIcon('siren') ?> Emergency send</button>
          </form>
        <?php endif;
        if ($canEdit): ?>
          <a class="btn btn-outline btn--block" href="<?= NC_BASE ?>?edit=<?= $id ?>"><?= adminIcon('pencil') ?> Edit<?= $status !== 'draft' ? ' (returns it to draft)' : '' ?></a>
        <?php endif;
        if ($canCompose): ?>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-action">
            <?= csrfField() ?><input type="hidden" name="action" value="duplicate" /><input type="hidden" name="id" value="<?= $id ?>" />
            <button type="submit" class="btn btn-ghost btn--block"><?= adminIcon('copy') ?> Duplicate as a new draft</button>
          </form>
        <?php endif;
        if ($canCancel): ?>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-action">
            <?= csrfField() ?><input type="hidden" name="action" value="cancel" /><input type="hidden" name="id" value="<?= $id ?>" />
            <button type="submit" class="btn btn-danger btn--block"
                    data-confirm="<?= $status === 'sending' ? 'Stop sending “' . h((string) $c['name']) . '”? Messages already delivered stay delivered; waiting ones are cancelled.' : 'Cancel “' . h((string) $c['name']) . '”? It will not be sent. You can duplicate it later.' ?>"
                    data-confirm-label="<?= $status === 'sending' ? 'Stop sending' : 'Cancel notification' ?>"><?= adminIcon('x-circle') ?> <?= $status === 'sending' ? 'Stop sending' : 'Cancel' ?></button>
          </form>
        <?php endif;
        $actionsHtml = trim((string) ob_get_clean());
      ?>
      <section class="card card--solid card--static nc-card" id="nc-actions" aria-labelledby="nc-actions-h">
        <h2 class="nc-card__title" id="nc-actions-h"><?= adminIcon('list-checks') ?>What next</h2>
        <?php if ($actionsHtml !== ''): ?>
          <div class="nc-actions"><?= $actionsHtml ?></div>
        <?php else: ?>
          <p class="field__hint"><?= $canCompose ? 'Nothing more can be done with it.' : 'You have read access. An editor or owner sends and changes notifications.' ?></p>
        <?php endif; ?>
      </section>

      <?php if ($canCompose && $previewLangs && $c['channelsList']): ?>
        <section class="card card--solid card--static nc-card" id="nc-test" aria-labelledby="nc-test-h">
          <h2 class="nc-card__title" id="nc-test-h"><?= adminIcon('flask') ?>Send a test</h2>
          <form method="POST" action="<?= NC_BASE ?>" class="nc-inline-form">
            <?= csrfField() ?><input type="hidden" name="action" value="test_send" /><input type="hidden" name="id" value="<?= $id ?>" />
            <label for="nc-test-email">
              <span class="field__label">Email</span>
              <input id="nc-test-email" type="email" name="test_email" maxlength="190" autocomplete="email" spellcheck="false" value="<?= h((string) ($me['email'] ?? '')) ?>" />
            </label>
            <label for="nc-test-phone">
              <span class="field__label">Mobile number <span class="field__optional">for WhatsApp and SMS</span></span>
              <input id="nc-test-phone" type="tel" name="test_phone" maxlength="20" autocomplete="tel" placeholder="+919876543210" />
            </label>
            <label for="nc-test-lang">
              <span class="field__label">Language</span>
              <select id="nc-test-lang" name="test_lang">
                <?php foreach ($previewLangs as $lang): ?><option value="<?= h($lang) ?>"><?= h($langs[$lang] ?? $lang) ?></option><?php endforeach; ?>
              </select>
            </label>
            <button type="submit" class="btn btn-outline btn--block"><?= adminIcon('flask') ?> Send test now</button>
            <p class="field__hint">Sends it as it stands, whatever its approval, with “[TEST]” before the title, on the channels ticked above that reach an email or a number.</p>
          </form>
        </section>
      <?php endif; ?>

      <section class="card card--solid card--static nc-card" id="nc-audit" aria-labelledby="nc-audit-h">
        <h2 class="nc-card__title" id="nc-audit-h"><?= adminIcon('history') ?>History</h2>
        <?php if (!$audit): ?>
          <p class="field__hint">No history recorded.</p>
        <?php else: ?>
          <ol class="feed nc-timeline">
            <?php foreach ($audit as $a):
              [$icon, $tone, $label] = ncAuditLook((string) $a['action']);
              $lines = ncAuditLines(json_decode((string) $a['detail'], true) ?: []);
            ?>
              <li class="feed__item">
                <span class="feed__icon<?= $tone ? ' feed__icon--' . $tone : '' ?>"><?= adminIcon($icon) ?></span>
                <div class="feed__body">
                  <strong><?= h($label) ?></strong> by <?= h((string) ($a['actor'] ?: 'system')) ?><?= $a['actor_role'] ? ' <span class="nc-muted">(' . h((string) $a['actor_role']) . ')</span>' : '' ?>
                  <?php if ($lines): ?><ul class="nc-audit-lines"><?php foreach ($lines as $line): ?><li><?= h($line) ?></li><?php endforeach; ?></ul><?php endif; ?>
                </div>
                <time class="feed__time" datetime="<?= h((string) notifyIso((string) $a['created_at'])) ?>" title="<?= h(ncTempleTime((string) $a['created_at'])) ?>"><?= h(ncAgo((string) $a['created_at'])) ?></time>
              </li>
            <?php endforeach; ?>
          </ol>
        <?php endif; ?>
      </section>
    </div>
  </div>
</div>
<script src="/admin/assets/notify-campaigns.js" defer></script>
    <?php
    adminFooter();
    exit;
}

/** [icon, feed tone, label] for an audit action. */
function ncAuditLook(string $action): array
{
    return [
        'created'            => ['plus', '', 'Created'],
        'edited'             => ['pencil', '', 'Edited'],
        'submitted'          => ['send', 'info', 'Submitted'],
        'approved'           => ['check-circle', 'success', 'Approved'],
        'rejected'           => ['undo', 'gold', 'Sent back'],
        'scheduled'          => ['calendar-clock', 'info', 'Scheduled'],
        'sent'               => ['send', 'success', 'Sending started'],
        'cancelled'          => ['x-circle', 'gold', 'Cancelled'],
        'duplicated'         => ['copy', '', 'Duplicated'],
        'completed'          => ['check', 'success', 'Finished sending'],
        'failed'             => ['alert-circle', 'gold', 'Failed'],
        'requeued'           => ['refresh', 'info', 'Requeued'],
        'test_sent'          => ['flask', '', 'Test sent'],
        'emergency_override' => ['siren', 'gold', 'Emergency send'],
    ][$action] ?? ['dot', '', ucfirst(str_replace('_', ' ', $action))];
}

/** The parts of an audit detail worth reading; the stored snapshot itself is left out. */
function ncAuditLines(array $d): array
{
    $out = [];
    if (!empty($d['reason']) && is_string($d['reason'])) $out[] = 'Reason: ' . $d['reason'];
    if (!empty($d['approval_reason']) && is_string($d['approval_reason'])) $out[] = 'Needed approval: ' . $d['approval_reason'];
    if (isset($d['estimate']) && is_numeric($d['estimate'])) $out[] = 'About ' . number_format((int) $d['estimate']) . ' devotees';
    if (!empty($d['mode']) && $d['mode'] === 'send now') $out[] = 'Sent by hand';
    if (!empty($d['scheduled_at']) && is_string($d['scheduled_at'])) {
        $out[] = ($d['schedule_tz'] ?? '') === 'recipient' && !empty($d['scheduled_local'])
            ? 'For ' . ncWallClock((string) $d['scheduled_local']) . ' in each devotee\'s time'
            : 'For ' . ncTempleTime($d['scheduled_at']);
    }
    if (!empty($d['next_local']) && is_string($d['next_local'])) $out[] = 'Next: ' . ncWallClock($d['next_local']);
    if (isset($d['deliveries_cancelled']) && is_numeric($d['deliveries_cancelled'])) $out[] = number_format((int) $d['deliveries_cancelled']) . ' waiting messages cancelled';
    if (isset($d['recipients']) && is_numeric($d['recipients'])) $out[] = number_format((int) $d['recipients']) . ' devotees reached';
    if (!empty($d['approval_void'])) $out[] = 'Its approval was withdrawn because it changed' . (!empty($d['previous_status']) ? ' (was ' . strtolower(ncStatusLabel((string) $d['previous_status'])) . ')' : '');
    elseif (!empty($d['previous_status']) && is_string($d['previous_status'])) $out[] = 'Was ' . strtolower(ncStatusLabel($d['previous_status']));
    if (!empty($d['new_id']) && is_numeric($d['new_id'])) $out[] = 'New draft #' . (int) $d['new_id'];
    if (!empty($d['duplicated_from']) && is_numeric($d['duplicated_from'])) $out[] = 'Copied from #' . (int) $d['duplicated_from'];
    if (!empty($d['to']) && is_array($d['to'])) $out[] = 'To ' . implode(', ', array_map('strval', array_filter($d['to'], 'is_scalar')));
    if (!empty($d['deliveries']) && is_array($d['deliveries'])) {
        $parts = [];
        foreach ($d['deliveries'] as $ch => $s) if (is_string($s)) $parts[] = ncChannelLabel((string) $ch) . ' ' . $s;
        if ($parts) $out[] = implode('; ', $parts);
    }
    if (!empty($d['error']) && is_string($d['error'])) $out[] = 'Error: ' . $d['error'];
    if (!empty($d['recurrence_dropped'])) $out[] = 'Its repeat was dropped';
    return $out;
}

/* ══════════════════════════════════════════════════════════════════════════
   LIST
   ══════════════════════════════════════════════════════════════════════════ */

$q      = mb_substr($gets('q'), 0, 100);
$status = in_array($gets('status'), NC_STATUSES, true) ? $gets('status') : '';
$sort   = $gets('sort') === 'scheduled' ? 'scheduled' : 'updated';
$dir    = in_array($gets('dir'), ['asc', 'desc'], true) ? $gets('dir') : ($sort === 'scheduled' ? 'asc' : 'desc');
$page   = max(1, (int) $gets('page'));
$query  = ['q' => $q, 'status' => $status, 'sort' => $sort, 'dir' => $dir];

$baseWhere  = [];
$baseParams = [];
if ($q !== '') {
    $baseWhere[] = ctype_digit($q) ? '(c.name LIKE :q OR c.id = :qid)' : 'c.name LIKE :q';
    $baseParams[':q'] = '%' . addcslashes($q, '%_\\') . '%';
    if (ctype_digit($q)) $baseParams[':qid'] = (int) $q;
}

$chipCounts = array_fill_keys(NC_STATUSES, 0);
$stmt = $db->prepare('SELECT c.status, COUNT(*) AS n FROM notification_campaigns c' . ($baseWhere ? ' WHERE ' . implode(' AND ', $baseWhere) : '') . ' GROUP BY c.status');
$stmt->execute($baseParams);
foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $chipCounts[(string) $r['status']] = (int) $r['n'];
$allCount = array_sum($chipCounts);

$where  = $baseWhere;
$params = $baseParams;
if ($status !== '') {
    $where[] = 'c.status = :status';
    $params[':status'] = $status;
}
// $sort and $dir come from whitelists above, so this interpolation is safe.
$order = $sort === 'scheduled'
    ? ' ORDER BY (c.scheduled_at IS NULL), c.scheduled_at ' . strtoupper($dir) . ', c.id DESC'
    : ' ORDER BY c.updated_at ' . strtoupper($dir) . ', c.id ' . strtoupper($dir);
$sql = 'SELECT c.id, c.name, c.category, c.priority, c.channels, c.status, c.segment_id, c.audience, c.estimated_count,
               c.approval_reason, c.schedule_tz, c.scheduled_local, c.scheduled_at, c.next_run_at, c.recurrence, c.last_error,
               c.created_by, c.updated_by, c.created_at, c.updated_at
          FROM notification_campaigns c' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . $order;
$list = adminPaginate($db, $sql, $params, $page, NC_PER_PAGE);
$rows = $list['rows'];

// Recipients, sent and failed for the whole page in one query, not three per row.
$rowStats = [];
$segNames = [];
if ($rows) {
    $marks = [];
    $ids   = [];
    foreach ($rows as $i => $r) {
        $marks[] = ':c' . $i;
        $ids[':c' . $i] = (int) $r['id'];
    }
    $stmt = $db->prepare(
        "SELECT n.campaign_id,
                COUNT(DISTINCT n.id) AS recipients,
                COALESCE(SUM(d.status IN ('sent', 'delivered', 'read')), 0) AS sent,
                COALESCE(SUM(d.status IN ('rejected', 'dead', 'failed')), 0) AS failed
           FROM notifications n
           LEFT JOIN notification_deliveries d ON d.notification_id = n.id
          WHERE n.campaign_id IN (" . implode(',', $marks) . ')
          GROUP BY n.campaign_id'
    );
    $stmt->execute($ids);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $rowStats[(int) $r['campaign_id']] = $r;

    $segIds = array_values(array_unique(array_filter(array_map(static fn($r) => (int) $r['segment_id'], $rows))));
    if ($segIds) {
        $sm = [];
        $sp = [];
        foreach ($segIds as $i => $sid) {
            $sm[] = ':s' . $i;
            $sp[':s' . $i] = $sid;
        }
        $stmt = $db->prepare('SELECT id, name FROM notification_segments WHERE id IN (' . implode(',', $sm) . ')');
        $stmt->execute($sp);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) $segNames[(int) $r['id']] = (string) $r['name'];
    }
}

$kpi = $db->prepare(
    "SELECT COALESCE(SUM(status = 'review'), 0) AS review_n,
            COALESCE(SUM(status = 'scheduled'), 0) AS scheduled_n,
            COALESCE(SUM(status = 'sending'), 0) AS sending_n,
            COALESCE(SUM(status = 'completed' AND completed_at >= :since), 0) AS done_n
       FROM notification_campaigns"
);
$kpi->execute([':since' => notifyNowPlus(-30 * 86400)]);
$kpi = $kpi->fetch(PDO::FETCH_ASSOC);

$categories = notifyCategories(false);

adminHeader('Notifications', 'Communication', [
    'actions' => $canCompose ? '<a href="' . NC_BASE . '?new=1" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New notification</a>' : '',
    'wide'    => true,
]);
echo $msg;
echo adminPageIntro(
    'Messages from the committee to devotees: in the bell on the website, and by email, WhatsApp, SMS or push. '
    . 'Large, urgent, paid and promotional messages wait for a second owner\'s approval before anything is sent.'
    . ($canCompose ? '' : ' You have read access.'),
    '<a href="/admin/notification_segments.php" class="btn btn-ghost btn--sm">' . adminIcon('users') . 'Saved audiences</a>'
    . '<a href="/admin/notification_analytics.php" class="btn btn-ghost btn--sm">' . adminIcon('activity') . 'Delivery analytics</a>'
);
echo adminKpi([
    ['icon' => 'user-check',     'value' => (int) $kpi['review_n'],    'label' => 'Awaiting approval', 'variant' => (int) $kpi['review_n'] > 0 ? 'accent' : '',
     'href' => NC_BASE . '?status=review'],
    ['icon' => 'calendar-clock', 'value' => (int) $kpi['scheduled_n'], 'label' => 'Scheduled', 'href' => NC_BASE . '?status=scheduled&sort=scheduled'],
    ['icon' => 'send',           'value' => (int) $kpi['sending_n'],   'label' => 'Sending now', 'href' => NC_BASE . '?status=sending'],
    ['icon' => 'check-circle',   'value' => (int) $kpi['done_n'],      'label' => 'Sent in 30 days', 'href' => NC_BASE . '?status=completed'],
]);
?>
<div class="nc-page">
  <form method="GET" action="<?= NC_BASE ?>" class="toolbar" role="search" aria-label="Find notifications">
    <?php if ($status !== ''): ?><input type="hidden" name="status" value="<?= h($status) ?>" /><?php endif; ?>
    <div class="toolbar__search">
      <?= adminIcon('search') ?>
      <label for="nc-q" class="sr-only">Search notifications by name or number</label>
      <input id="nc-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search by name or number…" autocomplete="off" maxlength="100" />
    </div>
    <div class="toolbar__group">
      <label for="nc-sort">Sort by
        <select id="nc-sort" name="sort">
          <option value="updated"<?= $sort === 'updated' ? ' selected' : '' ?>>Last changed</option>
          <option value="scheduled"<?= $sort === 'scheduled' ? ' selected' : '' ?>>Send time</option>
        </select>
      </label>
      <label for="nc-dir">Order
        <select id="nc-dir" name="dir">
          <option value="desc"<?= $dir === 'desc' ? ' selected' : '' ?>>Newest first</option>
          <option value="asc"<?= $dir === 'asc' ? ' selected' : '' ?>>Oldest first</option>
        </select>
      </label>
      <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
      <?php if ($q !== '' || $status !== ''): ?>
        <a href="<?= NC_BASE ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a>
      <?php endif; ?>
    </div>
    <span class="toolbar__count" aria-live="polite"><?= $list['total'] ?> notification<?= $list['total'] === 1 ? '' : 's' ?></span>
  </form>

  <nav class="filter-chips mb-4" aria-label="Filter by status">
    <a class="chip" href="<?= h(NC_BASE . adminQuery($query, ['status' => null, 'page' => null])) ?>"<?= $status === '' ? ' aria-current="page"' : '' ?>>All <span class="chip__count"><?= $allCount ?></span></a>
    <?php foreach (NC_STATUSES as $s): ?>
      <a class="chip" href="<?= h(NC_BASE . adminQuery($query, ['status' => $s, 'page' => null])) ?>"<?= $status === $s ? ' aria-current="page"' : '' ?>><?= h(ncStatusLabel($s)) ?> <span class="chip__count"><?= $chipCounts[$s] ?></span></a>
    <?php endforeach; ?>
  </nav>

  <?php if ($rows): ?>
  <div class="table-wrap">
    <table class="table nc-list-table" data-no-search>
      <caption class="sr-only">Notifications<?= $status !== '' ? ', ' . h(strtolower(ncStatusLabel($status))) : '' ?></caption>
      <thead>
        <tr>
          <th scope="col">Notification</th>
          <th scope="col">Status</th>
          <th scope="col">Audience</th>
          <th scope="col" class="text-right">Delivery</th>
          <?= adminSortLink('scheduled', 'Send time', $query) ?>
          <?= adminSortLink('updated', 'Changed', $query) ?>
          <th scope="col"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <?php foreach ($rows as $row):
          $id   = (int) $row['id'];
          $st   = (string) $row['status'];
          $rs   = $rowStats[$id] ?? ['recipients' => 0, 'sent' => 0, 'failed' => 0];
          $chs  = array_values(array_intersect(NOTIFY_CHANNELS, explode(',', (string) $row['channels'])));
          $mine = (string) $row['created_by'] === $actor['username'];
          if ($row['segment_id'] !== null) {
              $aud = isset($segNames[(int) $row['segment_id']]) ? 'Saved: ' . $segNames[(int) $row['segment_id']] : 'Saved audience (deleted)';
          } else {
              $a = json_decode((string) $row['audience'], true);
              $aud = match ($a['mode'] ?? null) {
                  'all_devotees' => 'All devotees',
                  'selected'     => count((array) ($a['devotee_ids'] ?? [])) . ' chosen devotees',
                  'rules'        => count((array) ($a['rules'] ?? [])) . ' rule' . (count((array) ($a['rules'] ?? [])) === 1 ? '' : 's') . ', match ' . (($a['match'] ?? 'all') === 'any' ? 'any' : 'all'),
                  default        => 'Not chosen yet',
              };
          }
          $when = ncScheduleLabel($row);

          $menu = [['label' => 'Open', 'href' => NC_BASE . '?view=' . $id, 'icon' => 'eye']];
          if ($canCompose && in_array($st, NOTIFY_CAMPAIGN_EDITABLE, true)) {
              $menu[] = ['label' => 'Edit', 'href' => NC_BASE . '?edit=' . $id, 'icon' => 'pencil'];
          }
          if ($canCompose && $st === 'draft') {
              $menu[] = ['label' => 'Submit for approval', 'icon' => 'send', 'form' => ['action' => 'submit', 'id' => $id, 'return' => 'list'],
                         'confirm' => 'Submit “' . $row['name'] . '”? Nothing is sent yet; small messages are approved at once.', 'confirmLabel' => 'Confirm submit'];
          }
          if ($st === 'review' && $canApprove) {
              $menu[] = ['label' => 'Review and approve', 'href' => NC_BASE . '?view=' . $id . '#nc-approval', 'icon' => 'user-check'];
          }
          if ($canCompose && $st === 'approved') {
              if ($row['recurrence'] === 'none') {
                  $menu[] = ['label' => 'Send now', 'icon' => 'send', 'form' => ['action' => 'send_now', 'id' => $id, 'return' => 'list'],
                             'confirm' => 'Send “' . $row['name'] . '” now to about ' . number_format((int) $row['estimated_count']) . ' devotees? It cannot be unsent.', 'confirmLabel' => 'Send now'];
              }
              $menu[] = ['label' => 'Schedule…', 'href' => NC_BASE . '?view=' . $id . '#nc-schedule-form', 'icon' => 'calendar-clock'];
          }
          if ($canCompose) {
              $menu[] = ['label' => 'Duplicate', 'icon' => 'copy', 'form' => ['action' => 'duplicate', 'id' => $id]];
          }
          $menu[] = ['label' => 'History', 'href' => NC_BASE . '?view=' . $id . '#nc-audit', 'icon' => 'history'];
          if (in_array($st, NOTIFY_CAMPAIGN_CANCELLABLE, true) && ($st === 'draft' && $mine ? $canCompose : $canApprove)) {
              $menu[] = 'divider';
              $menu[] = ['label' => $st === 'sending' ? 'Stop sending' : 'Cancel', 'icon' => 'x-circle', 'danger' => true,
                         'form' => ['action' => 'cancel', 'id' => $id, 'return' => 'list'],
                         'confirm' => ($st === 'sending' ? 'Stop sending “' : 'Cancel “') . $row['name'] . '”? Waiting messages will not be sent.',
                         'confirmLabel' => $st === 'sending' ? 'Stop sending' : 'Cancel notification'];
          }
        ?>
        <tr>
          <td>
            <a class="cell-title" href="<?= NC_BASE ?>?view=<?= $id ?>"><?= h((string) $row['name']) ?></a>
            <span class="cell-sub">#<?= $id ?> · <?= h($categories[$row['category']]['label_en'] ?? (string) $row['category']) ?><?= $row['priority'] !== 'normal' ? ' · ' . h(ncPriorityLabel((string) $row['priority'])) : '' ?></span>
            <span class="nc-row-channels" aria-label="Channels: <?= h(implode(', ', array_map('ncChannelLabel', $chs))) ?>">
              <?php foreach ($chs as $ch): ?><span class="nc-row-channel" title="<?= h(ncChannelLabel($ch)) ?>"><?= adminIcon(ncChannelIcon($ch), 'ico--xs') ?><?= h(ncChannelLabel($ch)) ?></span><?php endforeach; ?>
            </span>
          </td>
          <td>
            <?= adminBadge(ncStatusLabel($st), ncStatusTone($st), $st === 'sending') ?>
            <?php if ($st === 'review' && $row['approval_reason']): ?><span class="cell-sub"><?= h((string) $row['approval_reason']) ?></span><?php endif; ?>
            <?php if ($st === 'failed' && $row['last_error']): ?><span class="cell-sub"><?= h(mb_substr((string) $row['last_error'], 0, 120)) ?></span><?php endif; ?>
          </td>
          <td>
            <?= h($aud) ?>
            <?php if ((int) $row['estimated_count'] > 0): ?><span class="cell-sub">About <?= number_format((int) $row['estimated_count']) ?> when submitted</span><?php endif; ?>
          </td>
          <td class="cell-num text-right">
            <?php if ((int) $rs['recipients'] > 0): ?>
              <span><?= number_format((int) $rs['recipients']) ?> devotee<?= (int) $rs['recipients'] === 1 ? '' : 's' ?></span>
              <span class="cell-sub"><?= number_format((int) $rs['sent']) ?> sent · <span class="<?= (int) $rs['failed'] > 0 ? 'nc-failed' : '' ?>"><?= number_format((int) $rs['failed']) ?> failed</span></span>
            <?php else: ?>
              <span class="cell-sub">Not sent yet</span>
            <?php endif; ?>
          </td>
          <td class="cell-date">
            <?= $when !== '' ? h($when) : '<span class="cell-sub">By hand</span>' ?>
            <?php if ($row['recurrence'] !== 'none'): ?><span class="cell-sub">Repeats <?= h((string) $row['recurrence']) ?></span><?php endif; ?>
          </td>
          <td class="cell-date">
            <time datetime="<?= h((string) notifyIso((string) $row['updated_at'])) ?>" title="<?= h(ncTempleTime((string) $row['updated_at'])) ?>"><?= h(ncAgo((string) $row['updated_at'])) ?></time>
            <span class="cell-sub">by <?= h((string) ($row['updated_by'] ?: $row['created_by'] ?: 'system')) ?></span>
          </td>
          <td class="cell-actions"><?= adminMenu($menu, 'Actions for ' . $row['name']) ?></td>
        </tr>
        <?php endforeach; ?>
      </tbody>
    </table>
  </div>
  <?= adminPagination($list['page'], $list['pages'], $query, $list['total'], NC_PER_PAGE) ?>
  <?php elseif ($q !== '' || $status !== ''): ?>
    <?= adminEmpty('search', 'No notifications match', 'Try a different search or status.', '<a href="' . NC_BASE . '" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
  <?php else: ?>
    <?= adminEmpty('bell', 'No notifications yet',
        'Write a message once, in Tamil and English, choose who receives it and how, and send it now or at a set time.',
        $canCompose ? '<a href="' . NC_BASE . '?new=1" class="btn btn-primary btn--sm">' . adminIcon('plus') . 'New notification</a>' : '') ?>
  <?php endif; ?>
</div>
<?php adminFooter(); ?>
