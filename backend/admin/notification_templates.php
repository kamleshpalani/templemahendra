<?php
// backend/admin/notification_templates.php — Message Templates: the wording of
// every automated notification, per language and channel, and the categories
// messages are filed under.
//
// The built-in wording ships in backend/includes/notify/defaults.php, so every
// message works before anyone opens this page. Saving here writes one row to
// notification_templates, and that row wins over the built-in wording for
// exactly that template, language and channel (templates.php documents the
// fallback order). "Reset to built-in" deletes the row; the built-in text itself
// is never changed from here.
//
// Only an owner (notifications.templates) may change wording. An edit reaches
// every future booking confirmation or password reset at once, with no approval
// step in between, so it deserves the same trust as the site settings. Everyone
// who can see notifications may read the wording and its preview.
//
// Warnings about variables never block a save. The committee may have a good
// reason to drop the booking number from an SMS; the page says what will happen
// and trusts them.
require_once __DIR__ . '/../includes/auth.php';
requireAdminAuth();
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/notify.php';
require_once __DIR__ . '/includes/admin_layout.php';

const NC_PAGE = '/admin/notification_templates.php';

/**
 * Channels a wording can target, in the order an admin thinks about them:
 * [full label, short column label, what the variant is used for].
 */
const NC_TPL_CHANNELS = [
    'any'      => ['Shared',   'All',  'Shared wording: the bell, email and push, and every channel without a version of its own'],
    'email'    => ['Email',    'Mail', 'Email only'],
    'sms'      => ['SMS',      'SMS',  'SMS only: keep it short, every segment is billed'],
    'whatsapp' => ['WhatsApp', 'WA',   'WhatsApp only: *bold* renders as bold'],
    'push'     => ['Push',     'Push', 'Push notification on a phone or computer'],
    'inapp'    => ['In-app',   'App',  'The notification bell on the website'],
];

/**
 * Icons a category may use. Lucide names, because the devotee site draws them
 * with lucide-react-icons; a name outside this list could render as nothing
 * there, so the page offers a fixed list instead of a free-text field.
 */
const NC_CATEGORY_ICONS = [
    'bell', 'megaphone', 'party-popper', 'flame', 'calendar-days', 'calendar-check', 'sparkles',
    'heart-handshake', 'hand-heart', 'credit-card', 'badge-check', 'landmark', 'siren', 'shield-check',
    'gift', 'users', 'star', 'sun', 'moon', 'music', 'book-open', 'info', 'map-pin', 'heart', 'flower',
];

/** Kinds the committee may create. The others carry rights devotees cannot opt out of, so they ship with the site. */
const NC_NEW_KINDS = ['informational', 'promotional'];

$db  = getDB();
$str = static fn(array $src, string $k): string => is_scalar($src[$k] ?? null) ? trim((string) $src[$k]) : '';

if (!notifyTablesExist()) {
    adminHeader('Message Templates', 'Communication');
    echo adminEmpty(
        'mail',
        'Notifications are not switched on yet',
        'Apply database/migrations/007_notifications.sql to keep edited wording and categories. Until then every message uses the built-in wording that ships with the site.'
    );
    adminFooter();
    exit;
}

$canEdit = adminCan('notifications.templates');
$me      = currentAdmin() ?? [];
$actor   = ['username' => (string) ($me['username'] ?? 'admin'), 'role' => (string) ($me['role'] ?? 'owner')];

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** A page URL with the given query (empty values dropped). */
function ncTplUrl(array $params = []): string
{
    return NC_PAGE . rtrim(adminQuery($params), '?');
}

/**
 * Every template key: the built-in catalogue first, in its own logical order,
 * then any key that exists only as database rows (a module that registered its
 * own messages, or rows kept from an older version). Each entry has category,
 * description, variables, cta_path, langs and builtin.
 */
function ncTplCatalogue(array $rows): array
{
    $out = [];
    foreach (notifyTemplateDefaults() as $key => $def) {
        $out[$key] = $def + ['builtin' => isset(notifyTemplateBuiltIn()[$key])];
    }
    foreach ($rows as $key => $_) {
        if (isset($out[$key])) continue;
        $out[$key] = [
            'category' => 'general', 'description' => 'Wording stored only in the database; it has no built-in version.',
            'variables' => [], 'cta_path' => '', 'langs' => [], 'builtin' => false,
        ];
    }
    return $out;
}

/** Every stored row, active or not, as [key][lang][channel] => row. One query for the whole page. */
function ncTplAllRows(PDO $db): array
{
    $rows = [];
    $stmt = $db->query(
        'SELECT id, template_key, lang, channel, title, body, cta_label, provider_template, provider_params,
                is_active, updated_by, updated_at
           FROM notification_templates
          ORDER BY template_key, lang, channel'
    );
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $rows[(string) $r['template_key']][strtolower((string) $r['lang'])][(string) $r['channel']] = $r;
    }
    return $rows;
}

/**
 * Plain template text as the committee typed it: newlines normalised, control
 * characters removed (a pasted NUL or form feed would reach an SMS gateway),
 * surrounding space trimmed. A single-line field also folds runs of whitespace.
 * No tag stripping: the text is never HTML, and "a < b" must survive.
 */
function ncTplClean(string $text, bool $multiline): string
{
    $text = str_replace(["\r\n", "\r"], "\n", mb_scrub($text, 'UTF-8'));
    $text = (string) preg_replace($multiline ? '/[\x00-\x08\x0B-\x1F\x7F]/u' : '/[\x00-\x1F\x7F]/u', $multiline ? '' : ' ', $text);
    if (!$multiline) $text = (string) preg_replace('/\s+/u', ' ', $text);
    return trim($text);
}

/** A stored row as the audit trail keeps it. */
function ncTplSnapshot(?array $row): ?array
{
    if ($row === null) return null;
    $params = json_decode((string) ($row['provider_params'] ?? ''), true);
    return [
        'title'             => (string) $row['title'],
        'body'              => (string) $row['body'],
        'cta_label'         => $row['cta_label'] === null ? null : (string) $row['cta_label'],
        'provider_template' => $row['provider_template'] === null ? null : (string) $row['provider_template'],
        'provider_params'   => is_array($params) ? array_values($params) : [],
        'is_active'         => (int) ($row['is_active'] ?? 1),
    ];
}

/** "Tamil", "English", or the code for a language the site does not name. */
function ncTplLangName(string $code): string
{
    $english = ['ta' => 'Tamil', 'en' => 'English', 'hi' => 'Hindi', 'te' => 'Telugu', 'ml' => 'Malayalam', 'kn' => 'Kannada',
                'mr' => 'Marathi', 'gu' => 'Gujarati', 'bn' => 'Bengali', 'pa' => 'Punjabi', 'or' => 'Odia', 'si' => 'Sinhala',
                'ur' => 'Urdu', 'ms' => 'Malay', 'fr' => 'French', 'de' => 'German'];
    return $english[$code] ?? strtoupper($code);
}

/**
 * Variable warnings for a wording (SPEC §8.3). Never blocking:
 *   unknown   a {{name}} the template does not provide renders as nothing, which
 *             is almost always a typo;
 *   no longer a declared variable the wording it replaces used, and this text
 *             drops — the booking number vanishing from a confirmation is worth
 *             a second look, but can be intended.
 * $before is the wording devotees receive now for this language and channel.
 */
function ncTplWarnings(array $def, string $title, string $body, string $cta, array $params, ?array $before): array
{
    $declared = array_values(array_map('strval', (array) ($def['variables'] ?? [])));
    $known    = array_unique([...$declared, ...NOTIFY_TEMPLATE_AUTO_VARS, 'devoteeName', 'ctaUrl']);
    $used     = notifyTemplateVarsUsed($title, $body, $cta);
    // A key with no built-in definition declares nothing; judging it against an
    // empty list would flag every variable, so only its own earlier text counts.
    if (!$declared && $before !== null) {
        $known = array_unique([...$known, ...notifyTemplateVarsUsed($before['title'], $before['body'], (string) $before['cta_label'])]);
    }

    $warnings = [];
    foreach (array_diff(array_unique([...$used, ...$params]), $known) as $name) {
        $warnings[] = '{{' . $name . '}} is not a variable of this message, so it will print as nothing. Check its spelling against the variables listed with the editor.';
    }
    if ($before !== null) {
        $was = notifyTemplateVarsUsed($before['title'], $before['body'], (string) $before['cta_label']);
        foreach (array_diff(array_intersect($was, $declared), $used, $params) as $name) {
            $warnings[] = 'The wording no longer uses {{' . $name . '}}, which the version it replaces included. Devotees will not see that detail.';
        }
    }
    return $warnings;
}

/**
 * Render unsaved wording with sample values for the live preview. It mirrors
 * what notifyRender() and the queue do with saved wording (title folded onto
 * one line, blank-line runs collapsed, the link appended to an SMS when it fits,
 * push bodies shortened), so the preview shows what a devotee would receive.
 */
function ncTplPreview(string $key, array $def, string $lang, string $channel, string $title, string $body, string $cta, string $providerTemplate, array $params, ?array $before): array
{
    $vars   = notifyTemplateSample($key, $lang);
    $l      = $lang === 'ta' ? 'ta' : 'en';
    $t      = trim((string) preg_replace('/\s+/u', ' ', notifyInterpolate($title, $vars)));
    $b      = str_replace(["\r\n", "\r"], "\n", notifyInterpolate($body, $vars));
    $b      = trim((string) preg_replace("/\n[ \t]*\n(?:[ \t]*\n)+/", "\n\n", $b));
    $c      = trim((string) preg_replace('/\s+/u', ' ', notifyInterpolate($cta, $vars)));
    // A channel version saved without a button label borrows the shared one, as notifyTemplate() does.
    if ($c === '' && $channel !== 'any') {
        $shared = notifyTemplate($key, $lang, 'any');
        $c = trim(notifyInterpolate((string) ($shared['cta_label'] ?? ''), $vars));
    }
    $ctaUrl   = (string) ($vars['ctaUrl'] ?? '');
    $category = (string) ($def['category'] ?? 'general');
    $shownTitle = $t !== '' ? $t : notifyCategoryLabel($category, $l);

    $out = [
        'ok' => true, 'title' => $t, 'body' => $b, 'cta_label' => $c,
        'email_html' => null, 'sms' => null, 'whatsapp' => null, 'push' => null, 'inapp' => null,
        'warnings' => ncTplWarnings($def, $title, $body, $cta, $params, $before),
    ];

    if ($channel === 'any' || $channel === 'email') {
        $out['email_html'] = notifyEmailHtml([
            'title' => $shownTitle, 'body' => $b, 'lang' => $lang, 'category' => $category,
            'category_label' => notifyCategoryLabel($category, $l),
            'priority' => $category === 'emergency' ? 'emergency' : 'normal',
            'cta_url' => $ctaUrl !== '' ? $ctaUrl : null, 'cta_label' => $c,
            'logo_url' => siteUrl('/icons/icon-192x192.png'), 'preferences_url' => notifyPreferencesUrl(),
        ]);
    }
    if ($channel === 'sms') {
        $text = $b !== '' ? $b : $t;
        if ($ctaUrl !== '' && !str_contains($text, $ctaUrl)) {
            $with = $text . "\n" . $ctaUrl;
            if (notifySmsInfo($with)['segments'] <= max(2, notifySmsInfo($text)['segments'])) $text = $with;
        }
        $out['sms'] = ['text' => $text] + notifySmsInfo($text);
    }
    if ($channel === 'whatsapp') {
        $values = [];
        foreach ($params as $name) $values[] = ['name' => $name, 'value' => notifyInterpolate('{{' . $name . '}}', $vars)];
        $out['whatsapp'] = [
            'text' => $b !== '' ? $b : $t, 'cta_label' => $c,
            'provider_template' => $providerTemplate !== '' ? $providerTemplate : null, 'params' => $values,
        ];
    }
    if ($channel === 'any' || $channel === 'push') {
        $text = trim((string) preg_replace("/\s*\n\s*/u", ' ', $b));
        if (mb_strlen($text) > NOTIFY_PUSH_BODY_MAX) $text = rtrim(mb_substr($text, 0, NOTIFY_PUSH_BODY_MAX - 1)) . '…';
        $out['push'] = ['title' => $shownTitle, 'body' => $text];
    }
    if ($channel === 'any' || $channel === 'inapp') {
        $out['inapp'] = ['title' => $shownTitle, 'body' => $b, 'cta_label' => $c];
    }
    return $out;
}

/** WhatsApp's *bold*, rendered safely: escape first, then only the asterisk pairs become <strong>. */
function ncTplWhatsAppHtml(string $text): string
{
    return (string) preg_replace('/\*([^*\n]+)\*/u', '<strong>$1</strong>', h($text));
}

/** "13 Sep 2026 · 18:45 IST" from a UTC DATETIME. */
function ncTplLocal(?string $utc): string
{
    if ($utc === null || $utc === '') return '—';
    $tz = notifyTempleTz();
    try {
        return notifyFromUtc($utc, $tz, 'd M Y · H:i') . ' ' . ($tz === 'Asia/Kolkata' ? 'IST' : $tz);
    } catch (Throwable) {
        return $utc;
    }
}

/** Read the provider parameter textarea: one variable name per line, in order. */
function ncTplParseParams(string $text, array &$errors): array
{
    $params = [];
    foreach (preg_split('/\R/u', $text) ?: [] as $line) {
        $name = trim(str_replace(['{{', '}}'], '', $line));
        if ($name === '') continue;
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]{0,63}$/', $name)) {
            $errors['provider_params'] = 'Each provider parameter is one variable name per line, such as devoteeName. "' . mb_substr($name, 0, 40) . '" is not one.';
            continue;
        }
        $params[] = $name;
    }
    if (count($params) > 20) $errors['provider_params'] = 'A provider template takes at most 20 parameters.';
    return $params;
}

/* ── State ───────────────────────────────────────────────────────────────── */

$rows       = ncTplAllRows($db);
$catalogue  = ncTplCatalogue($rows);
$languages  = notifyLanguages();
$categories = notifyCategories(false);

$tab = $str($_GET, 'tab') === 'categories' ? 'categories' : 'templates';

// The variant open in the editor, from the query (GET) or the form (POST).
$src         = $_SERVER['REQUEST_METHOD'] === 'POST' ? $_POST : $_GET;
$editKey     = $str($src, 'key');
$editKey     = isset($catalogue[$editKey]) ? $editKey : '';
$editLang    = strtolower($str($src, 'lang'));
$editLang    = isset($languages[$editLang]) ? $editLang : 'ta';
$editChannel = $str($src, 'channel');
$editChannel = isset(NC_TPL_CHANNELS[$editChannel]) ? $editChannel : 'any';

$msg        = '';
$formErrors = [];     // field => message, for the template editor
$formValues = null;   // submitted values to show again after a refused save
$catError   = '';     // message for the categories panel
$catForm    = null;   // submitted category values to show again

/* ── POST ────────────────────────────────────────────────────────────────── */

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $str($_POST, 'action');

    // The live preview answers JSON, so it is handled before any HTML exists.
    if ($action === 'preview') {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        if (!csrfValid()) {
            http_response_code(419);
            echo json_encode(['ok' => false, 'error' => 'Your session expired. Reload the page to keep previewing.']);
            exit;
        }
        if (!$canEdit || $editKey === '') {
            http_response_code($canEdit ? 422 : 403);
            echo json_encode(['ok' => false, 'error' => $canEdit ? 'Unknown template.' : 'Your role cannot edit wording.']);
            exit;
        }
        $pErrors = [];
        $params  = ncTplParseParams($str($_POST, 'provider_params'), $pErrors);
        $preview = ncTplPreview(
            $editKey, $catalogue[$editKey], $editLang, $editChannel,
            ncTplClean((string) ($_POST['title'] ?? ''), false),
            ncTplClean((string) ($_POST['body'] ?? ''), true),
            ncTplClean((string) ($_POST['cta_label'] ?? ''), false),
            $str($_POST, 'provider_template'),
            $params,
            notifyTemplate($editKey, $editLang, $editChannel)
        );
        echo json_encode($preview, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    $msg = adminCsrfGuard();
    if ($msg === '' && !$canEdit) {
        // Second line of defence behind requireAdminAuth()'s write policy.
        $msg = '<p class="alert alert--error" role="alert">Only a committee owner can change message wording or categories.</p>';
    }

    if ($msg === '' && ($action === 'save_template' || $action === 'reset_template')) {
        if ($editKey === '') {
            $_SESSION['flash_ntpl'] = ['error', 'That template does not exist.', []];
            header('Location: ' . ncTplUrl(), true, 303);
            exit;
        }
        $def       = $catalogue[$editKey];
        $editorUrl = ncTplUrl(['key' => $editKey, 'lang' => $editLang, 'channel' => $editChannel]);
        $stmt      = $db->prepare('SELECT * FROM notification_templates WHERE template_key = :k AND lang = :l AND channel = :c');
        $stmt->execute([':k' => $editKey, ':l' => $editLang, ':c' => $editChannel]);
        $existing  = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        $label     = $editKey . ' · ' . ncTplLangName($editLang) . ' · ' . NC_TPL_CHANNELS[$editChannel][0];

        if ($action === 'reset_template') {
            if ($existing === null) {
                $_SESSION['flash_ntpl'] = ['info', $label . ' already uses the built-in wording.', []];
                header('Location: ' . $editorUrl, true, 303);
                exit;
            }
            $db->prepare('DELETE FROM notification_templates WHERE id = :id')->execute([':id' => (int) $existing['id']]);
            notifyTemplateCacheClear();
            notifyAudit(null, 'template_saved', $actor, [
                'template_key' => $editKey, 'lang' => $editLang, 'channel' => $editChannel, 'reset' => true,
                'before' => ncTplSnapshot($existing), 'after' => null,
            ]);
            $hasBuiltIn = notifyTemplateDefaultVariant($def, $editLang, $editChannel) !== null;
            $_SESSION['flash_ntpl'] = ['success', $hasBuiltIn
                ? 'Restored the built-in wording for ' . $label . '.'
                : 'Removed the customised wording for ' . $label . '. Devotees now receive the wording it falls back to.', []];
            header('Location: ' . $editorUrl, true, 303);
            exit;
        }

        // save_template
        $title    = ncTplClean((string) ($_POST['title'] ?? ''), false);
        $body     = ncTplClean((string) ($_POST['body'] ?? ''), true);
        $cta      = ncTplClean((string) ($_POST['cta_label'] ?? ''), false);
        $provider = $str($_POST, 'provider_template');
        $params   = ncTplParseParams($str($_POST, 'provider_params'), $formErrors);
        $needsTitle = !in_array($editChannel, ['sms', 'whatsapp'], true);

        if ($needsTitle && $title === '') $formErrors['title'] = 'Enter a title. It is the email subject and the first line of a push or bell notification.';
        if (mb_strlen($title) > 200)      $formErrors['title'] = 'Keep the title within 200 characters.';
        if ($body === '')                 $formErrors['body'] = 'Enter the message. An empty message would send nothing.';
        if (mb_strlen($body) > 4000)      $formErrors['body'] = 'Keep the message within 4,000 characters.';
        if (mb_strlen($cta) > 80)         $formErrors['cta_label'] = 'Keep the button label within 80 characters.';
        if ($provider !== '' && !preg_match('/^[A-Za-z0-9_.:\-]{1,160}$/', $provider)) {
            $formErrors['provider_template'] = 'A provider template name uses letters, digits, underscores, dots, colons and hyphens only (for example booking_confirmed_v2 or a DLT template id).';
        }

        if ($formErrors) {
            $formValues = ['title' => $title, 'body' => $body, 'cta_label' => $cta, 'provider_template' => $provider, 'provider_params' => implode("\n", $params)];
            $msg = '<p class="alert alert--error" role="alert">The wording was not saved. Correct the highlighted fields and save again.</p>';
        } else {
            $before   = notifyTemplate($editKey, $editLang, $editChannel);
            $warnings = ncTplWarnings($def, $title, $body, $cta, $params, $before);
            $db->prepare(
                'INSERT INTO notification_templates
                        (template_key, lang, channel, title, body, cta_label, provider_template, provider_params, is_active, updated_by, created_at, updated_at)
                 VALUES (:k, :l, :c, :t, :b, :cta, :pt, :pp, 1, :by, UTC_TIMESTAMP(), UTC_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), cta_label = VALUES(cta_label),
                        provider_template = VALUES(provider_template), provider_params = VALUES(provider_params),
                        is_active = 1, updated_by = VALUES(updated_by), updated_at = UTC_TIMESTAMP()'
            )->execute([
                ':k' => $editKey, ':l' => $editLang, ':c' => $editChannel, ':t' => $title, ':b' => $body,
                ':cta' => $cta !== '' ? $cta : null, ':pt' => $provider !== '' ? $provider : null,
                ':pp' => $params ? json_encode($params) : null, ':by' => mb_substr($actor['username'], 0, 120),
            ]);
            notifyTemplateCacheClear();
            notifyAudit(null, 'template_saved', $actor, [
                'template_key' => $editKey, 'lang' => $editLang, 'channel' => $editChannel,
                'before' => ncTplSnapshot($existing),
                'after'  => ['title' => $title, 'body' => $body, 'cta_label' => $cta !== '' ? $cta : null,
                             'provider_template' => $provider !== '' ? $provider : null, 'provider_params' => $params, 'is_active' => 1],
                'warnings' => $warnings,
            ]);
            $_SESSION['flash_ntpl'] = ['success', 'Saved the wording for ' . $label . '. Messages sent from now on use it.', $warnings];
            header('Location: ' . $editorUrl, true, 303);
            exit;
        }
    }

    if ($msg === '' && ($action === 'save_category' || $action === 'add_category')) {
        $tab     = 'categories';
        $key     = $str($_POST, 'cat_key');
        $labelTa = ncTplClean((string) ($_POST['label_ta'] ?? ''), false);
        $labelEn = ncTplClean((string) ($_POST['label_en'] ?? ''), false);
        $icon    = $str($_POST, 'icon');
        $sortRaw = $str($_POST, 'sort_order');
        $active  = isset($_POST['is_active']) ? 1 : 0;
        $defOn   = isset($_POST['default_on']) ? 1 : 0;
        $kind    = $str($_POST, 'kind');
        $catForm = compact('action', 'key', 'labelTa', 'labelEn', 'icon', 'sortRaw', 'active', 'defOn', 'kind');

        $problems = [];
        if ($labelTa === '' || mb_strlen($labelTa) > 120) $problems[] = 'Enter a Tamil label of up to 120 characters.';
        if ($labelEn === '' || mb_strlen($labelEn) > 120) $problems[] = 'Enter an English label of up to 120 characters.';
        if (!in_array($icon, NC_CATEGORY_ICONS, true))    $problems[] = 'Choose an icon from the list.';
        if (!preg_match('/^\d{1,4}$/', $sortRaw))          $problems[] = 'The sort order is a whole number from 0 to 9999.';

        $before = $categories[$key] ?? null;
        if ($action === 'add_category') {
            if (!preg_match('/^[a-z_]{3,32}$/', $key)) {
                $problems[] = 'The key is 3 to 32 lowercase letters or underscores, such as annadanam_updates. It is permanent.';
            } elseif ($before !== null) {
                $problems[] = 'A category with the key "' . $key . '" already exists.';
            }
            if (!in_array($kind, NC_NEW_KINDS, true)) {
                $problems[] = 'A new category is informational or promotional. Transactional, security and emergency categories ship with the site because devotees cannot switch them off.';
            }
        } elseif ($before === null) {
            $problems[] = 'That category no longer exists.';
        } elseif ((int) $before['is_active'] === 1 && $active === 0) {
            // Switching a category off hides it from the composer and the devotee's
            // settings. A security or emergency category must always be there when
            // it is needed, and a campaign already on its way would lose its label.
            if (in_array($before['kind'], ['security', 'critical'], true)) {
                $problems[] = '"' . $before['label_en'] . '" is a ' . ($before['kind'] === 'critical' ? 'emergency' : 'security') . ' category and stays active: account safety and emergency messages must always have it.';
            } else {
                $busy = $db->prepare("SELECT COUNT(*) FROM notification_campaigns WHERE category = :k AND status IN ('scheduled', 'sending')");
                $busy->execute([':k' => $key]);
                $n = (int) $busy->fetchColumn();
                if ($n > 0) {
                    $problems[] = '"' . $before['label_en'] . '" is used by ' . $n . ' scheduled or sending campaign' . ($n === 1 ? '' : 's') . '. Let ' . ($n === 1 ? 'it' : 'them') . ' finish, or cancel ' . ($n === 1 ? 'it' : 'them') . ', before deactivating the category.';
                }
            }
        }

        if ($problems) {
            $catError = implode(' ', $problems);
        } else {
            $sort = (int) $sortRaw;
            if ($action === 'add_category') {
                $db->prepare(
                    'INSERT INTO notification_categories (`key`, label_ta, label_en, icon, kind, default_on, is_active, sort_order, updated_by, updated_at)
                     VALUES (:k, :ta, :en, :i, :kind, :d, :a, :s, :by, UTC_TIMESTAMP())'
                )->execute([':k' => $key, ':ta' => $labelTa, ':en' => $labelEn, ':i' => $icon, ':kind' => $kind,
                            ':d' => $defOn, ':a' => $active, ':s' => $sort, ':by' => mb_substr($actor['username'], 0, 120)]);
                $after = ['label_ta' => $labelTa, 'label_en' => $labelEn, 'icon' => $icon, 'kind' => $kind, 'default_on' => $defOn, 'is_active' => $active, 'sort_order' => $sort];
                $flash = 'Added the category "' . $labelEn . '".';
            } else {
                // Default-on only means something where a devotee can opt out.
                $defOn = in_array($before['kind'], NOTIFY_MUTABLE_KINDS, true) ? $defOn : (int) $before['default_on'];
                $db->prepare(
                    'UPDATE notification_categories
                        SET label_ta = :ta, label_en = :en, icon = :i, default_on = :d, is_active = :a, sort_order = :s,
                            updated_by = :by, updated_at = UTC_TIMESTAMP()
                      WHERE `key` = :k'
                )->execute([':k' => $key, ':ta' => $labelTa, ':en' => $labelEn, ':i' => $icon, ':d' => $defOn,
                            ':a' => $active, ':s' => $sort, ':by' => mb_substr($actor['username'], 0, 120)]);
                $after = ['label_ta' => $labelTa, 'label_en' => $labelEn, 'icon' => $icon, 'kind' => $before['kind'], 'default_on' => $defOn, 'is_active' => $active, 'sort_order' => $sort];
                $flash = 'Saved the category "' . $labelEn . '".';
            }
            notifyCategoriesForget();
            $snap = static fn(?array $c): ?array => $c === null ? null : array_intersect_key($c, array_flip(['label_ta', 'label_en', 'icon', 'kind', 'default_on', 'is_active', 'sort_order']));
            notifyAudit(null, 'category_saved', $actor, ['category' => $key, 'created' => $action === 'add_category', 'before' => $snap($before), 'after' => $after]);
            $_SESSION['flash_ntpl'] = ['success', $flash, []];
            header('Location: ' . ncTplUrl(['tab' => 'categories']) . '#cat-' . $key, true, 303);
            exit;
        }
    }

    if ($msg === '' && !in_array($action, ['save_template', 'reset_template', 'save_category', 'add_category'], true)) {
        $msg = '<p class="alert alert--error" role="alert">Unknown action.</p>';
    }
}

// Flash from the previous redirect. Warnings stay on the page (data-keep): a
// toast that fades in five seconds is no place for "{{bookingNo}} prints as nothing".
$flash = $_SESSION['flash_ntpl'] ?? null;
unset($_SESSION['flash_ntpl']);
$flashWarnings = [];
if (is_array($flash) && count($flash) === 3) {
    [$tone, $text, $flashWarnings] = $flash;
    $tone = in_array($tone, ['success', 'error', 'warning', 'info'], true) ? $tone : 'info';
    $msg .= '<p class="alert alert--' . $tone . '" role="' . ($tone === 'error' ? 'alert' : 'status') . '">' . h((string) $text) . '</p>';
    $flashWarnings = is_array($flashWarnings) ? $flashWarnings : [];
}

$rows       = ncTplAllRows($db);
$categories = notifyCategories(false);
$kindTones  = ['transactional' => 'info', 'security' => 'moon', 'critical' => 'danger', 'informational' => 'sage', 'promotional' => 'gold'];
$customised = 0;
foreach ($rows as $byLang) foreach ($byLang as $byChannel) $customised += count($byChannel);

/* ── Page ────────────────────────────────────────────────────────────────── */

// The cross-link lives in the intro's action row, not the topbar: on a phone the
// topbar has room for the page title and nothing else.
adminHeader('Message Templates', 'Communication', ['wide' => true]);
echo $msg;
if ($flashWarnings) {
    echo '<div class="alert alert--warning ntpl-alert" role="status" data-keep><span class="alert__icon">' . adminIcon('alert') . '</span><div class="alert__body"><strong class="alert__title">Please check the variables</strong><ul class="ntpl-warn-list">';
    foreach ($flashWarnings as $w) echo '<li>' . h((string) $w) . '</li>';
    echo '</ul></div></div>';
}

echo adminPageIntro(
    'The words of every automated message — booking confirmations, receipts, reminders, security notices — in each language and channel. '
    . 'Built-in wording ships with the site; a customised version saved here replaces it for that language and channel, for messages sent from then on.'
    . ($canEdit ? '' : ' You can read every template; only a committee owner can change wording.')
);
?>

<nav class="tabs mb-4" aria-label="Message template sections">
  <a class="tab" href="<?= h(ncTplUrl()) ?>"<?= $tab === 'templates' && $editKey === '' ? ' aria-current="page"' : '' ?>><?= adminIcon('mail') ?>Templates <span class="tab__count"><?= count($catalogue) ?></span></a>
  <a class="tab" href="<?= h(ncTplUrl(['tab' => 'categories'])) ?>"<?= $tab === 'categories' ? ' aria-current="page"' : '' ?>><?= adminIcon('layers') ?>Categories <span class="tab__count"><?= count($categories) ?></span></a>
</nav>

<?php
/* ── Editor ──────────────────────────────────────────────────────────────── */
if ($tab === 'templates' && $editKey !== ''):
    $def       = $catalogue[$editKey];
    $row       = $rows[$editKey][$editLang][$editChannel] ?? null;
    $builtIn   = notifyTemplateDefaultVariant($def['langs'] ? $def : null, $editLang, $editChannel);
    $effective = notifyTemplate($editKey, $editLang, $editChannel);

    if ($row !== null) {
        $params = json_decode((string) ($row['provider_params'] ?? ''), true);
        $values = ['title' => (string) $row['title'], 'body' => (string) $row['body'], 'cta_label' => (string) ($row['cta_label'] ?? ''),
                   'provider_template' => (string) ($row['provider_template'] ?? ''), 'provider_params' => implode("\n", is_array($params) ? $params : [])];
        $source = 'Customised by ' . ($row['updated_by'] ?: 'the committee') . ' on ' . ncTplLocal($row['updated_at']) . '.'
                . ((int) $row['is_active'] === 1 ? '' : ' This version is switched off, so devotees receive the wording it falls back to; saving switches it on again.');
    } elseif ($builtIn !== null) {
        $values = ['title' => $builtIn['title'], 'body' => $builtIn['body'], 'cta_label' => $builtIn['cta_label'],
                   'provider_template' => (string) ($builtIn['provider_template'] ?? ''), 'provider_params' => implode("\n", $builtIn['provider_params'])];
        $source = 'Built-in wording. Saving creates a customised version for ' . ncTplLangName($editLang) . ' ' . NC_TPL_CHANNELS[$editChannel][0] . '.';
    } else {
        $values = ['title' => (string) ($effective['title'] ?? ''), 'body' => (string) ($effective['body'] ?? ''), 'cta_label' => (string) ($effective['cta_label'] ?? ''),
                   'provider_template' => (string) ($effective['provider_template'] ?? ''), 'provider_params' => implode("\n", (array) ($effective['provider_params'] ?? []))];
        $source = $effective
            ? 'No wording of its own yet. Devotees receive the ' . ncTplLangName($effective['lang']) . ' ' . NC_TPL_CHANNELS[$effective['channel']][0] . ' version, shown here; saving gives this language and channel its own.'
            : 'No wording exists for this message yet.';
    }
    if ($formValues !== null) $values = $formValues;

    $declared = array_values(array_map('strval', (array) ($def['variables'] ?? [])));
    $sample   = notifyTemplateSample($editKey, $editLang);
    $params   = array_values(array_filter(array_map('trim', preg_split('/\R/u', $values['provider_params']) ?: []), 'strlen'));
    $preview  = ncTplPreview($editKey, $def, $editLang, $editChannel, $values['title'], $values['body'], $values['cta_label'], $values['provider_template'], $params, $effective);
    $category = $categories[$def['category']] ?? null;
    $variant  = ncTplLangName($editLang) . ' · ' . NC_TPL_CHANNELS[$editChannel][0];
    $showProvider = in_array($editChannel, ['any', 'sms', 'whatsapp'], true);
    $ro       = $canEdit ? '' : ' readonly';
    $invalid  = static fn(string $f): string => isset($formErrors[$f]) ? ' aria-invalid="true" aria-describedby="err-' . $f . '"' : '';
    $fieldErr = static fn(string $f): string => isset($formErrors[$f]) ? '<span class="field__error" id="err-' . $f . '">' . adminIcon('alert-circle') . h($formErrors[$f]) . '</span>' : '';
    $cellState = static function (string $lang, string $channel) use ($rows, $editKey, $def): string {
        if (isset($rows[$editKey][$lang][$channel])) return 'custom';
        return notifyTemplateDefaultVariant($def['langs'] ? $def : null, $lang, $channel) !== null ? 'builtin' : 'inherits';
    };
    $stateWord = ['custom' => 'customised', 'builtin' => 'built-in', 'inherits' => 'uses a fallback'];
?>
<div class="ntpl-editor-head">
  <a class="btn btn-ghost btn--sm" href="<?= h(ncTplUrl()) ?>"><?= adminIcon('arrow-left') ?>All templates</a>
  <div class="ntpl-editor-head__text">
    <h2 class="ntpl-editor-head__title"><code><?= h($editKey) ?></code></h2>
    <p class="ntpl-editor-head__desc"><?= h((string) ($def['description'] ?? '')) ?></p>
    <p class="cluster">
      <?= adminBadge($category ? $category['label_en'] : $def['category'], 'gold') ?>
      <?php if ($category): ?><?= adminBadge($category['kind'], $kindTones[$category['kind']] ?? 'muted') ?><?php endif; ?>
      <?php if (!$def['builtin']): ?><?= adminBadge('No built-in version', 'muted') ?><?php endif; ?>
    </p>
  </div>
</div>

<div class="ntpl-variant-nav">
  <nav class="tabs" aria-label="Language">
    <?php foreach ($languages as $code => $native): $st = $cellState($code, $editChannel); ?>
      <a class="tab" href="<?= h(ncTplUrl(['key' => $editKey, 'lang' => $code, 'channel' => $editChannel])) ?>"<?= $code === $editLang ? ' aria-current="page"' : '' ?>>
        <span lang="<?= h($code) ?>"><?= h($native) ?></span>
        <?php if ($st === 'custom'): ?><span class="ntpl-dot" aria-hidden="true"></span><?php endif; ?>
        <span class="sr-only">(<?= h($stateWord[$st]) ?>)</span>
      </a>
    <?php endforeach; ?>
  </nav>
  <nav class="tabs" aria-label="Channel">
    <?php foreach (NC_TPL_CHANNELS as $ch => [$chLabel]): $st = $cellState($editLang, $ch); ?>
      <a class="tab" href="<?= h(ncTplUrl(['key' => $editKey, 'lang' => $editLang, 'channel' => $ch])) ?>"<?= $ch === $editChannel ? ' aria-current="page"' : '' ?>>
        <?= h($chLabel) ?>
        <?php if ($st === 'custom'): ?><span class="ntpl-dot" aria-hidden="true"></span><?php endif; ?>
        <span class="sr-only">(<?= h($stateWord[$st]) ?>)</span>
      </a>
    <?php endforeach; ?>
  </nav>
  <p class="field__hint"><span class="ntpl-dot" aria-hidden="true"></span> marks a customised version.</p>
</div>

<div class="ntpl-editor">
  <section class="card card--solid card--static ntpl-panel" aria-labelledby="ed-title">
    <h2 id="ed-title" class="ntpl-panel__title"><?= adminIcon('pencil') ?><?= h($variant) ?></h2>
    <p class="field__hint ntpl-source"><?= h(NC_TPL_CHANNELS[$editChannel][2]) ?>. <?= h($source) ?></p>

    <form method="POST" action="<?= h(NC_PAGE) ?>" class="ntpl-form" id="tpl-form"<?= $canEdit ? ' data-ntpl-editor' : '' ?> novalidate>
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save_template" />
      <input type="hidden" name="key" value="<?= h($editKey) ?>" />
      <input type="hidden" name="lang" value="<?= h($editLang) ?>" />
      <input type="hidden" name="channel" value="<?= h($editChannel) ?>" />

      <label for="t-title">
        <span class="field__label">Title<?php if (in_array($editChannel, ['sms', 'whatsapp'], true)): ?> <span class="field__optional">not sent on this channel</span><?php else: ?> <span class="field__required" aria-hidden="true">*</span><?php endif; ?></span>
        <input id="t-title" name="title" type="text" maxlength="200" autocomplete="off" lang="<?= h($editLang) ?>" data-var-target
               value="<?= h($values['title']) ?>"<?= $ro ?><?= $invalid('title') ?> />
        <?= $fieldErr('title') ?>
        <span class="field__hint">The email subject, and the first line of a push or bell notification. No personal names: it shows on lock screens.</span>
      </label>

      <label for="t-body">
        <span class="field__label">Message <span class="field__required" aria-hidden="true">*</span></span>
        <textarea id="t-body" name="body" rows="12" maxlength="4000" lang="<?= h($editLang) ?>" data-var-target spellcheck="true"<?= $ro ?><?= $invalid('body') ?>><?= h($values['body']) ?></textarea>
        <?= $fieldErr('body') ?>
        <span class="field__hint">Plain text. A blank line starts a new paragraph. Variables in double braces, such as {{devoteeName}}, are filled in for each devotee.</span>
      </label>

      <label for="t-cta">
        <span class="field__label">Button label <span class="field__optional">optional</span></span>
        <input id="t-cta" name="cta_label" type="text" maxlength="80" autocomplete="off" lang="<?= h($editLang) ?>" data-var-target
               value="<?= h($values['cta_label']) ?>"<?= $ro ?><?= $invalid('cta_label') ?> />
        <?= $fieldErr('cta_label') ?>
        <span class="field__hint"><?= $editChannel === 'any' ? 'The words on the email and WhatsApp button.' : 'Left empty, the shared version\'s label is used.' ?></span>
      </label>

      <div class="ntpl-vars" aria-labelledby="vars-title">
        <p class="field__label" id="vars-title">Variables</p>
        <p class="field__hint" id="vars-hint"><?= $canEdit ? 'Select a variable to insert it where the cursor is.' : 'The values each message fills in.' ?> The preview uses the sample values shown.</p>
        <ul class="ntpl-vars__list" aria-label="Variables of this message" data-ntpl-vars>
          <?php foreach (array_unique([...$declared, 'devoteeName', 'ctaUrl']) as $v): ?>
            <li class="ntpl-vars__item"><code class="ntpl-var" data-var="<?= h($v) ?>">{{<?= h($v) ?>}}</code> <span class="ntpl-vars__sample"><?= h(mb_strimwidth((string) ($sample[$v] ?? ''), 0, 48, '…')) ?></span></li>
          <?php endforeach; ?>
        </ul>
        <p class="field__hint">Temple facts, filled in automatically:</p>
        <ul class="ntpl-vars__list" aria-label="Temple facts" data-ntpl-vars>
          <?php foreach (NOTIFY_TEMPLATE_AUTO_VARS as $v): ?>
            <li class="ntpl-vars__item"><code class="ntpl-var" data-var="<?= h($v) ?>">{{<?= h($v) ?>}}</code> <span class="ntpl-vars__sample"><?= h(mb_strimwidth((string) ($sample[$v] ?? ''), 0, 48, '…')) ?></span></li>
          <?php endforeach; ?>
        </ul>
      </div>

      <?php if ($showProvider): ?>
      <fieldset class="ntpl-provider">
        <legend>Provider template <span class="field__optional">optional</span></legend>
        <p class="field__hint">WhatsApp business messages outside a conversation, and SMS in India, must use a template the provider has approved. Enter its name and the variables it expects, in order. Leave both empty to send the text above.</p>
        <label for="t-ptpl">
          <span class="field__label">Template name or DLT id</span>
          <input id="t-ptpl" name="provider_template" type="text" maxlength="160" autocomplete="off" spellcheck="false"
                 value="<?= h($values['provider_template']) ?>"<?= $ro ?><?= $invalid('provider_template') ?> />
          <?= $fieldErr('provider_template') ?>
        </label>
        <label for="t-pparams">
          <span class="field__label">Parameters, one per line</span>
          <textarea id="t-pparams" name="provider_params" rows="4" spellcheck="false" class="ntpl-mono"<?= $ro ?><?= $invalid('provider_params') ?>><?= h($values['provider_params']) ?></textarea>
          <?= $fieldErr('provider_params') ?>
          <span class="field__hint">Variable names such as devoteeName, sevaName, bookingDate — in the order of {{1}}, {{2}}, {{3}} in the approved template.</span>
        </label>
      </fieldset>
      <?php else: ?>
        <input type="hidden" name="provider_template" value="" />
        <input type="hidden" name="provider_params" value="" />
      <?php endif; ?>

      <div class="ntpl-warnings" data-ntpl-warnings aria-live="polite">
        <?php if ($preview['warnings']): ?>
          <div class="callout ntpl-callout--warn"><?= adminIcon('alert') ?><div><p><strong>Please check the variables</strong></p><ul class="ntpl-warn-list">
            <?php foreach ($preview['warnings'] as $w): ?><li><?= h($w) ?></li><?php endforeach; ?>
          </ul></div></div>
        <?php endif; ?>
      </div>

      <?php if ($canEdit): ?>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary"><?= adminIcon('check') ?> Save wording</button>
        <a class="btn btn-ghost" href="<?= h(ncTplUrl()) ?>">Cancel</a>
      </div>
      <?php endif; ?>
    </form>

    <?php if ($canEdit && $row !== null): ?>
    <form method="POST" action="<?= h(NC_PAGE) ?>" class="ntpl-reset">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="reset_template" />
      <input type="hidden" name="key" value="<?= h($editKey) ?>" />
      <input type="hidden" name="lang" value="<?= h($editLang) ?>" />
      <input type="hidden" name="channel" value="<?= h($editChannel) ?>" />
      <button type="submit" class="btn btn-outline btn--sm" data-confirm="Discard the customised wording for <?= h($variant) ?> and go back to <?= $builtIn !== null ? 'the built-in wording' : 'the wording it falls back to' ?>? The customised text cannot be recovered." data-confirm-label="Reset to built-in"><?= adminIcon('refresh') ?> Reset to built-in</button>
      <span class="field__hint">Deletes this customised version. The change is recorded in the audit trail.</span>
    </form>
    <?php endif; ?>
  </section>

  <section class="card card--static ntpl-panel ntpl-preview" aria-labelledby="pv-title" data-ntpl-preview>
    <div class="ntpl-preview__head">
      <h2 id="pv-title" class="ntpl-panel__title"><?= adminIcon('eye') ?>Preview</h2>
      <span class="field__hint" data-pv-status role="status">With sample values</span>
    </div>

    <?php if ($preview['email_html'] !== null): ?>
      <h3 class="subhead">Email</h3>
      <iframe class="ntpl-email-frame" sandbox="" title="Email preview of <?= h($variant) ?>" srcdoc="<?= h($preview['email_html']) ?>" data-pv="email" loading="lazy"></iframe>
    <?php endif; ?>

    <?php if ($preview['sms'] !== null): $s = $preview['sms']; ?>
      <h3 class="subhead">SMS</h3>
      <div class="ntpl-phone">
        <p class="ntpl-sms" data-pv="sms-text" lang="<?= h($editLang) ?>"><?= h($s['text']) ?></p>
      </div>
      <p class="ntpl-meta" data-pv="sms-info"><?= (int) $s['chars'] ?> characters · <?= (int) $s['segments'] ?> segment<?= (int) $s['segments'] === 1 ? '' : 's' ?> · <?= h($s['encoding']) ?></p>
      <p class="field__hint">GSM-7 fits 160 characters in one segment (153 per segment when split). Tamil, emoji and symbols such as ₹ switch the whole message to UCS-2: 70 per segment, 67 when split. Every segment is billed.</p>
    <?php endif; ?>

    <?php if ($preview['whatsapp'] !== null): $wa = $preview['whatsapp']; ?>
      <h3 class="subhead">WhatsApp</h3>
      <div class="ntpl-wa">
        <p class="ntpl-wa__bubble" data-pv="wa-text" lang="<?= h($editLang) ?>"><?= ncTplWhatsAppHtml($wa['text']) ?></p>
        <p class="ntpl-wa__button" data-pv="wa-cta"<?= $wa['cta_label'] === '' ? ' hidden' : '' ?>><?= adminIcon('external', 'ico--xs') ?><span data-pv="wa-cta-label"><?= h($wa['cta_label']) ?></span></p>
      </div>
      <div class="ntpl-meta" data-pv="wa-template"<?= $wa['provider_template'] === null ? ' hidden' : '' ?>>
        <p>Sent as the approved template <strong data-pv="wa-template-name"><?= h((string) $wa['provider_template']) ?></strong> with parameters:</p>
        <ol class="ntpl-params" data-pv="wa-params">
          <?php foreach ($wa['params'] as $p): ?><li><code><?= h($p['name']) ?></code> <?= h($p['value']) ?></li><?php endforeach; ?>
        </ol>
      </div>
    <?php endif; ?>

    <?php if ($preview['push'] !== null): $pu = $preview['push']; ?>
      <h3 class="subhead">Push notification</h3>
      <div class="ntpl-push">
        <img class="ntpl-push__icon" src="/icons/icon-192x192.png" alt="" width="40" height="40" />
        <div class="ntpl-push__text">
          <p class="ntpl-push__app">Temple · now</p>
          <p class="ntpl-push__title" data-pv="push-title" lang="<?= h($editLang) ?>"><?= h($pu['title']) ?></p>
          <p class="ntpl-push__body" data-pv="push-body" lang="<?= h($editLang) ?>"><?= h($pu['body']) ?></p>
        </div>
      </div>
    <?php endif; ?>

    <?php if ($preview['inapp'] !== null): $ia = $preview['inapp']; ?>
      <h3 class="subhead">Notification bell</h3>
      <div class="ntpl-inapp">
        <span class="ntpl-inapp__icon"><?= adminIcon('bell') ?></span>
        <div class="ntpl-inapp__text">
          <p class="ntpl-inapp__title" data-pv="inapp-title" lang="<?= h($editLang) ?>"><?= h($ia['title']) ?></p>
          <p class="ntpl-inapp__body" data-pv="inapp-body" lang="<?= h($editLang) ?>"><?= h($ia['body']) ?></p>
          <p class="ntpl-inapp__cta" data-pv="inapp-cta"<?= $ia['cta_label'] === '' ? ' hidden' : '' ?>><?= h($ia['cta_label']) ?></p>
        </div>
      </div>
    <?php endif; ?>
  </section>
</div>

<?php
/* ── Categories ──────────────────────────────────────────────────────────── */
elseif ($tab === 'categories'):
    $iconSelect = static function (string $id, string $current, bool $disabled = false): string {
        $out = '<select id="' . h($id) . '" name="icon"' . ($disabled ? ' disabled' : '') . '>';
        $list = in_array($current, NC_CATEGORY_ICONS, true) || $current === '' ? NC_CATEGORY_ICONS : [$current, ...NC_CATEGORY_ICONS];
        foreach ($list as $name) $out .= '<option value="' . h($name) . '"' . ($name === $current ? ' selected' : '') . '>' . h($name) . '</option>';
        return $out . '</select>';
    };
    $kindHelp = [
        'transactional' => 'About something the devotee did (a booking, a donation). Always delivered.',
        'security'      => 'Account safety. Always delivered, by email even when email is switched off.',
        'critical'      => 'Emergencies. Delivered on every channel except WhatsApp without opt-in.',
        'informational' => 'Temple news. Devotees can mute it.',
        'promotional'   => 'Offers and appeals. Only devotees who opted in receive it.',
    ];
?>
<?php if ($catError !== ''): ?>
  <div class="alert alert--error ntpl-alert" role="alert" data-keep><span class="alert__icon"><?= adminIcon('alert-circle') ?></span><div class="alert__body"><?= h($catError) ?></div></div>
<?php endif; ?>

<div class="callout mb-4">
  <?= adminIcon('info') ?>
  <p>Every notification belongs to a category. The <strong>kind</strong> decides what a devotee may switch off, so it cannot be changed after a category is created. Labels, icon, order and whether a category is offered can be edited at any time. Devotees see categories in the order given here.</p>
</div>

<div class="ntpl-cats">
  <?php foreach ($categories as $key => $c):
      $isForm  = $catForm !== null && $catForm['action'] === 'save_category' && $catForm['key'] === $key;
      $vTa     = $isForm ? $catForm['labelTa'] : $c['label_ta'];
      $vEn     = $isForm ? $catForm['labelEn'] : $c['label_en'];
      $vIcon   = $isForm ? $catForm['icon'] : $c['icon'];
      $vSort   = $isForm ? $catForm['sortRaw'] : (string) $c['sort_order'];
      $vActive = $isForm ? $catForm['active'] : $c['is_active'];
      $vDef    = $isForm ? $catForm['defOn'] : $c['default_on'];
      $slug    = h($key);
  ?>
  <article class="card card--static ntpl-cat<?= $c['is_active'] ? '' : ' ntpl-cat--off' ?>" id="cat-<?= $slug ?>" aria-labelledby="cat-<?= $slug ?>-title">
    <div class="ntpl-cat__head">
      <h3 class="ntpl-cat__title" id="cat-<?= $slug ?>-title"><?= h($c['label_en']) ?> <span class="ntpl-cat__ta" lang="ta"><?= h($c['label_ta']) ?></span></h3>
      <div class="cluster">
        <code class="ntpl-cat__key"><?= $slug ?></code>
        <?= adminBadge($c['kind'], $kindTones[$c['kind']] ?? 'muted') ?>
        <?= $c['is_active'] ? adminBadge('Active', 'success') : adminBadge('Inactive', 'muted') ?>
      </div>
    </div>
    <p class="field__hint"><?= h($kindHelp[$c['kind']] ?? '') ?></p>

    <?php if ($canEdit): ?>
    <form method="POST" action="<?= h(NC_PAGE) ?>?tab=categories" class="ntpl-cat__form">
      <?= csrfField() ?>
      <input type="hidden" name="action" value="save_category" />
      <input type="hidden" name="cat_key" value="<?= $slug ?>" />
      <div class="ntpl-cat__grid">
        <label for="c-<?= $slug ?>-ta"><span class="field__label">Tamil label</span>
          <input id="c-<?= $slug ?>-ta" name="label_ta" lang="ta" maxlength="120" required value="<?= h($vTa) ?>" />
        </label>
        <label for="c-<?= $slug ?>-en"><span class="field__label">English label</span>
          <input id="c-<?= $slug ?>-en" name="label_en" maxlength="120" required value="<?= h($vEn) ?>" />
        </label>
        <label for="c-<?= $slug ?>-icon"><span class="field__label">Icon</span><?= $iconSelect('c-' . $key . '-icon', $vIcon) ?></label>
        <label for="c-<?= $slug ?>-sort"><span class="field__label">Order</span>
          <input id="c-<?= $slug ?>-sort" name="sort_order" type="number" min="0" max="9999" step="1" inputmode="numeric" required value="<?= h($vSort) ?>" />
        </label>
      </div>
      <div class="ntpl-cat__switches">
        <label class="switch">
          <input type="checkbox" name="is_active" value="1"<?= $vActive ? ' checked' : '' ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label"><strong>Active</strong><span class="switch__desc">Offered in the composer and the devotee's settings.</span></span>
        </label>
        <label class="switch">
          <input type="checkbox" name="default_on" value="1"<?= $vDef ? ' checked' : '' ?><?= $c['mutable'] ? '' : ' disabled' ?> />
          <span class="switch__track" aria-hidden="true"></span>
          <span class="switch__label"><strong>On by default</strong><span class="switch__desc"><?= $c['mutable'] ? 'Devotees receive it until they mute it.' : 'Not applicable: devotees cannot mute this kind.' ?></span></span>
        </label>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn--sm"><?= adminIcon('check') ?> Save <?= h($c['label_en']) ?></button>
        <?php if ($c['updated_by']): ?><span class="field__hint">Last changed by <?= h($c['updated_by']) ?>, <?= h(ncTplLocal($c['updated_at'])) ?></span><?php endif; ?>
      </div>
    </form>
    <?php else: ?>
    <dl class="dl-grid">
      <dt>Icon</dt><dd><code><?= h($c['icon']) ?></code></dd>
      <dt>Order</dt><dd><?= (int) $c['sort_order'] ?></dd>
      <dt>On by default</dt><dd><?= $c['mutable'] ? ($c['default_on'] ? 'Yes' : 'No — devotees opt in') : 'Always delivered' ?></dd>
    </dl>
    <?php endif; ?>
  </article>
  <?php endforeach; ?>
</div>

<?php if ($canEdit):
    $isAdd = $catForm !== null && $catForm['action'] === 'add_category';
?>
<section class="card card--solid card--static ntpl-panel mt-6" id="new-category" aria-labelledby="new-cat-title">
  <h2 class="ntpl-panel__title" id="new-cat-title"><?= adminIcon('plus') ?>Add a category</h2>
  <p class="field__hint">For temple news or appeals the existing categories do not cover, such as annadanam updates or a building fund. Devotees can mute any category added here.</p>
  <form method="POST" action="<?= h(NC_PAGE) ?>?tab=categories" class="ntpl-cat__form">
    <?= csrfField() ?>
    <input type="hidden" name="action" value="add_category" />
    <div class="ntpl-cat__grid">
      <label for="n-key"><span class="field__label">Key <span class="field__required" aria-hidden="true">*</span></span>
        <input id="n-key" name="cat_key" required pattern="[a-z_]{3,32}" maxlength="32" spellcheck="false" autocomplete="off" aria-describedby="n-key-hint"
               value="<?= h($isAdd ? $catForm['key'] : '') ?>" />
        <span class="field__hint" id="n-key-hint">3–32 lowercase letters or underscores. Permanent.</span>
      </label>
      <label for="n-kind"><span class="field__label">Kind <span class="field__required" aria-hidden="true">*</span></span>
        <select id="n-kind" name="kind" required>
          <?php foreach (NC_NEW_KINDS as $k): ?>
            <option value="<?= h($k) ?>"<?= $isAdd && $catForm['kind'] === $k ? ' selected' : '' ?>><?= h(ucfirst($k)) ?></option>
          <?php endforeach; ?>
        </select>
      </label>
      <label for="n-ta"><span class="field__label">Tamil label <span class="field__required" aria-hidden="true">*</span></span>
        <input id="n-ta" name="label_ta" lang="ta" maxlength="120" required value="<?= h($isAdd ? $catForm['labelTa'] : '') ?>" />
      </label>
      <label for="n-en"><span class="field__label">English label <span class="field__required" aria-hidden="true">*</span></span>
        <input id="n-en" name="label_en" maxlength="120" required value="<?= h($isAdd ? $catForm['labelEn'] : '') ?>" />
      </label>
      <label for="n-icon"><span class="field__label">Icon</span><?= $iconSelect('n-icon', $isAdd ? $catForm['icon'] : 'bell') ?></label>
      <label for="n-sort"><span class="field__label">Order</span>
        <input id="n-sort" name="sort_order" type="number" min="0" max="9999" step="1" inputmode="numeric" required value="<?= h($isAdd ? $catForm['sortRaw'] : '200') ?>" />
      </label>
    </div>
    <div class="ntpl-cat__switches">
      <label class="switch">
        <input type="checkbox" name="is_active" value="1"<?= !$isAdd || $catForm['active'] ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>Active</strong><span class="switch__desc">Offer it straight away.</span></span>
      </label>
      <label class="switch">
        <input type="checkbox" name="default_on" value="1"<?= !$isAdd || $catForm['defOn'] ? ' checked' : '' ?> />
        <span class="switch__track" aria-hidden="true"></span>
        <span class="switch__label"><strong>On by default</strong><span class="switch__desc">Promotional categories still reach only devotees who opted in.</span></span>
      </label>
    </div>
    <div class="form-actions">
      <button type="submit" class="btn btn-primary"><?= adminIcon('plus') ?> Add category</button>
    </div>
  </form>
</section>
<?php endif; ?>

<?php
/* ── Template list ───────────────────────────────────────────────────────── */
else:
    $fCategory = $str($_GET, 'category');
    $fCategory = isset($categories[$fCategory]) ? $fCategory : '';
    $fLang     = strtolower($str($_GET, 'lang'));
    $fLang     = isset($languages[$fLang]) ? $fLang : '';
    $fChannel  = $str($_GET, 'channel');
    $fChannel  = isset(NC_TPL_CHANNELS[$fChannel]) ? $fChannel : '';
    $fState    = in_array($str($_GET, 'state'), ['customised', 'default'], true) ? $str($_GET, 'state') : '';
    $q         = mb_substr($str($_GET, 'q'), 0, 80);
    $filtered  = $fCategory !== '' || $fLang !== '' || $fChannel !== '' || $fState !== '' || $q !== '';

    // Group keys by category, in the committee's category order.
    $groups = [];
    $shown  = 0;
    foreach ($catalogue as $key => $def) {
        $cat = (string) $def['category'];
        if ($fCategory !== '' && $cat !== $fCategory) continue;
        if ($q !== '' && mb_stripos($key . ' ' . ($def['description'] ?? ''), $q) === false) continue;
        $custom = 0;
        foreach ($rows[$key] ?? [] as $lang => $byChannel) {
            if ($fLang !== '' && $lang !== $fLang) continue;
            foreach ($byChannel as $ch => $_) {
                if ($fChannel === '' || $ch === $fChannel) $custom++;
            }
        }
        if ($fState === 'customised' && $custom === 0) continue;
        if ($fState === 'default' && $custom > 0) continue;
        $groups[$cat][$key] = $custom;
        $shown++;
    }
    $order = array_keys($categories);
    $rank  = static fn(string $cat): int => ($i = array_search($cat, $order, true)) === false ? PHP_INT_MAX : (int) $i;
    uksort($groups, static fn($a, $b) => $rank((string) $a) <=> $rank((string) $b));
    $channelCols = $fChannel !== '' ? [$fChannel => NC_TPL_CHANNELS[$fChannel]] : NC_TPL_CHANNELS;
?>
<form method="GET" action="<?= h(NC_PAGE) ?>" class="toolbar" role="search" aria-label="Filter templates">
  <div class="toolbar__search">
    <?= adminIcon('search') ?>
    <label class="sr-only" for="f-q">Search templates</label>
    <input id="f-q" type="search" name="q" value="<?= h($q) ?>" placeholder="Search key or description…" autocomplete="off" />
  </div>
  <div class="toolbar__group">
    <label for="f-category">Category
      <select id="f-category" name="category">
        <option value="">All</option>
        <?php foreach ($categories as $k => $c): ?><option value="<?= h($k) ?>"<?= $fCategory === $k ? ' selected' : '' ?>><?= h($c['label_en']) ?></option><?php endforeach; ?>
      </select>
    </label>
    <label for="f-lang">Language
      <select id="f-lang" name="lang">
        <option value="">All</option>
        <?php foreach ($languages as $code => $native): ?><option value="<?= h($code) ?>"<?= $fLang === $code ? ' selected' : '' ?>><?= h(ncTplLangName($code)) ?></option><?php endforeach; ?>
      </select>
    </label>
    <label for="f-channel">Channel
      <select id="f-channel" name="channel">
        <option value="">All</option>
        <?php foreach (NC_TPL_CHANNELS as $ch => [$chLabel]): ?><option value="<?= h($ch) ?>"<?= $fChannel === $ch ? ' selected' : '' ?>><?= h($chLabel) ?></option><?php endforeach; ?>
      </select>
    </label>
    <label for="f-state">Wording
      <select id="f-state" name="state">
        <option value="">Any</option>
        <option value="customised"<?= $fState === 'customised' ? ' selected' : '' ?>>Customised</option>
        <option value="default"<?= $fState === 'default' ? ' selected' : '' ?>>Built-in only</option>
      </select>
    </label>
    <button type="submit" class="btn btn--sm"><?= adminIcon('filter') ?> Apply</button>
    <?php if ($filtered): ?><a href="<?= h(ncTplUrl()) ?>" class="btn btn-ghost btn--sm"><?= adminIcon('x') ?> Reset</a><?php endif; ?>
  </div>
  <span class="toolbar__count" aria-live="polite"><?= $shown ?> of <?= count($catalogue) ?> templates · <?= $customised ?> customised version<?= $customised === 1 ? '' : 's' ?></span>
</form>

<p class="ntpl-legend field__hint">
  <span class="ntpl-cell ntpl-cell--custom">Custom</span> customised here ·
  <span class="ntpl-cell ntpl-cell--builtin">Default</span> built-in wording ·
  <span class="ntpl-cell ntpl-cell--inherits">·</span> no version of its own; uses the shared wording, or Tamil, then English.
  Select any cell to open that version.
</p>

<?php if (!$groups): ?>
  <?= adminEmpty('search', 'No templates match these filters', 'Try another category, language or search.', '<a href="' . h(ncTplUrl()) . '" class="btn btn-primary btn--sm">' . adminIcon('x') . 'Clear filters</a>') ?>
<?php endif; ?>

<?php foreach ($groups as $cat => $keys): $c = $categories[$cat] ?? null; ?>
<section class="ntpl-group" aria-labelledby="grp-<?= h($cat) ?>">
  <h2 class="ntpl-group__title" id="grp-<?= h($cat) ?>">
    <?= h($c ? $c['label_en'] : $cat) ?>
    <?php if ($c): ?><?= adminBadge($c['kind'], $kindTones[$c['kind']] ?? 'muted') ?><?php endif; ?>
    <span class="ntpl-group__count"><?= count($keys) ?> template<?= count($keys) === 1 ? '' : 's' ?></span>
  </h2>
  <div class="ntpl-keys">
    <?php foreach ($keys as $key => $custom):
        $def   = $catalogue[$key];
        $langs = $fLang !== '' ? [$fLang] : array_values(array_unique(['ta', 'en', ...array_keys($rows[$key] ?? [])]));
        $langs = array_values(array_filter($langs, static fn($l) => isset($languages[$l])));
        $firstLang = $fLang !== '' ? $fLang : 'ta';
    ?>
    <article class="card card--static ntpl-key" aria-labelledby="key-<?= h($key) ?>">
      <div class="ntpl-key__head">
        <h3 class="ntpl-key__title" id="key-<?= h($key) ?>"><a href="<?= h(ncTplUrl(['key' => $key, 'lang' => $firstLang, 'channel' => $fChannel !== '' ? $fChannel : 'any'])) ?>"><code><?= h($key) ?></code></a></h3>
        <?= $custom ? adminBadge($custom . ' customised', 'gold') : adminBadge('Built-in', 'muted') ?>
      </div>
      <p class="ntpl-key__desc"><?= h((string) ($def['description'] ?? '')) ?></p>
      <table class="ntpl-matrix">
        <caption class="sr-only">Versions of <?= h($key) ?> by language and channel</caption>
        <thead>
          <tr>
            <td class="ntpl-matrix__corner"></td>
            <?php foreach ($channelCols as $ch => [$chLabel, $short]): ?>
              <th scope="col"><abbr title="<?= h($chLabel) ?>"><?= h($short) ?></abbr></th>
            <?php endforeach; ?>
          </tr>
        </thead>
        <tbody>
          <?php foreach ($langs as $l): ?>
          <tr>
            <th scope="row"><abbr title="<?= h(ncTplLangName($l)) ?>"><?= h(strtoupper($l)) ?></abbr></th>
            <?php foreach ($channelCols as $ch => [$chLabel]):
                $row = $rows[$key][$l][$ch] ?? null;
                if ($row !== null) {
                    [$cls, $text, $state] = ['custom', 'Custom', (int) $row['is_active'] === 1 ? 'customised' : 'customised but switched off'];
                } elseif ($def['langs'] && notifyTemplateDefaultVariant($def, $l, $ch) !== null) {
                    [$cls, $text, $state] = ['builtin', 'Default', 'built-in wording'];
                } else {
                    [$cls, $text, $state] = ['inherits', '·', 'no version of its own'];
                }
            ?>
              <td><a class="ntpl-cell ntpl-cell--<?= $cls ?>" href="<?= h(ncTplUrl(['key' => $key, 'lang' => $l, 'channel' => $ch])) ?>" aria-label="<?= h($key . ', ' . ncTplLangName($l) . ' ' . $chLabel . ': ' . $state) ?>"><?= h($text) ?></a></td>
            <?php endforeach; ?>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </article>
    <?php endforeach; ?>
  </div>
</section>
<?php endforeach; ?>

<?php endif; ?>

<script src="/admin/assets/notify-content.js" defer></script>
<?php adminFooter(); ?>
