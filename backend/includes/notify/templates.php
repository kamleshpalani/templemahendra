<?php
/**
 * backend/includes/notify/templates.php — the words of every notification.
 *
 * A template is addressed by key × language × channel. The built-in wording
 * ships in defaults.php, so the system speaks before anyone edits a row; the
 * committee's edits live in `notification_templates` and win over the built-in
 * wording. Resolution (SPEC §5.2) for a key, language L and channel C:
 *
 *   DB (L, C) → DB (L, any) → default (L, C) → default (L, any)
 *   … then the same four steps for Tamil, then for English.
 *
 * Tamil comes before English on purpose: Tamil is the site's default language,
 * and a devotee who chose Hindi before a Hindi translation exists is more likely
 * to read the temple's own language than a translation of it.
 *
 * Rendering is deliberately dumb: {{name}} → value, nothing else. No
 * conditionals, no filters, no loops. The committee edits these in a textarea,
 * and a syntax they cannot break is worth more than one they could use cleverly.
 * Values are escaped only when the output is HTML; the template text itself is
 * the committee's and is never escaped or evaluated.
 */

require_once __DIR__ . '/contracts.php';
require_once __DIR__ . '/defaults.php';
require_once __DIR__ . '/../db.php';

/**
 * Variables notifyRender() fills from the temple's own facts when the caller
 * does not supply them. SPEC names the first five; the short name, trust name
 * and tax note are facts too, and filling them here means no caller has to
 * copy the Trust's registered name into its own code.
 */
const NOTIFY_TEMPLATE_AUTO_VARS = ['templeName', 'templeShortName', 'templeAddress', 'mapsUrl', 'supportPhone', 'trustName', 'taxNote'];

/** The variable syntax, shared by rendering and by the admin's "unknown variable" warnings. */
const NOTIFY_TEMPLATE_VAR_RE = '/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/';

/* ── Lookup ─────────────────────────────────────────────────────────────── */

/**
 * The active DB rows for one key as [lang => [channel => row]], cached for the
 * request: rendering one notification for five channels must not cost five
 * queries. Returns [] when the table is missing (before migration 007) or the
 * database is unreachable — the built-in wording keeps every message working.
 *
 * $reset clears the cache; see notifyTemplateCacheClear().
 */
function notifyTemplateDbRows(string $key, bool $reset = false): array
{
    static $cache = [];
    static $unavailable = false;

    if ($reset) {
        $cache = [];
        $unavailable = false;
        return [];
    }
    if ($unavailable) return [];
    if (array_key_exists($key, $cache)) return $cache[$key];
    // The core service's cached probe, when it is loaded, saves a failing query per key.
    if (function_exists('notifyTablesExist') && !notifyTablesExist()) return [];

    try {
        $stmt = getDB()->prepare(
            'SELECT lang, channel, title, body, cta_label, provider_template, provider_params
               FROM notification_templates
              WHERE template_key = :k AND is_active = 1'
        );
        $stmt->execute([':k' => $key]);
        $rows = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $rows[strtolower((string) $r['lang'])][(string) $r['channel']] = $r;
        }
        return $cache[$key] = $rows;
    } catch (Throwable $e) {
        // Remember the failure for the rest of the request, so a missing table
        // costs one log line rather than one per message.
        $unavailable = true;
        error_log('[notify] template table unavailable, using the built-in wording: ' . $e->getMessage());
        return [];
    }
}

/**
 * Forget cached template rows. The admin template editor calls this after a
 * save so its preview in the same request shows the new words; tests call it
 * after inserting rows.
 */
function notifyTemplateCacheClear(): void
{
    notifyTemplateDbRows('', true);
}

/**
 * Language codes to try, in order: the requested one (and its base language
 * for a regional code such as en-IN), then Tamil, then English.
 */
function notifyTemplateLangChain(string $lang): array
{
    $chain = [];
    $l = strtolower(trim($lang));
    if (preg_match('/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/', $l)) {
        $chain[] = $l;
        if (str_contains($l, '-')) $chain[] = explode('-', $l, 2)[0];
    }
    $chain[] = 'ta';
    $chain[] = 'en';
    return array_values(array_unique($chain));
}

/** One built-in variant, with a channel override inheriting the CTA label of its language's shared version. */
function notifyTemplateDefaultVariant(?array $def, string $lang, string $channel): ?array
{
    $variant = $def['langs'][$lang][$channel] ?? null;
    if (!is_array($variant) || trim((string) ($variant['body'] ?? '')) === '') return null;
    $any = $def['langs'][$lang]['any'] ?? [];
    return [
        'title'             => (string) ($variant['title'] ?? ''),
        'body'              => (string) $variant['body'],
        'cta_label'         => (string) ($variant['cta_label'] ?? ($any['cta_label'] ?? '')),
        'provider_template' => isset($variant['provider_template']) ? (string) $variant['provider_template'] : null,
        'provider_params'   => array_values(array_map('strval', (array) ($variant['provider_params'] ?? []))),
    ];
}

/** A DB row in the notifyTemplate() shape, or null when it has no body to send. */
function notifyTemplateRowVariant(?array $row): ?array
{
    if (!is_array($row) || trim((string) $row['body']) === '') return null;
    $params = [];
    if ($row['provider_params'] !== null && $row['provider_params'] !== '') {
        $decoded = json_decode((string) $row['provider_params'], true);
        if (is_array($decoded)) {
            foreach ($decoded as $name) {
                if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) $params[] = $name;
            }
        }
    }
    $providerTemplate = trim((string) ($row['provider_template'] ?? ''));
    return [
        'title'             => (string) $row['title'],
        'body'              => (string) $row['body'],
        'cta_label'         => $row['cta_label'] === null ? null : (string) $row['cta_label'],
        'provider_template' => $providerTemplate === '' ? null : $providerTemplate,
        'provider_params'   => $params,
    ];
}

/**
 * The template for a key in the best available language and channel, per the
 * resolution order at the top of this file. Returns
 *   ['title','body','cta_label','provider_template','provider_params' (names),
 *    'source' => 'db'|'default', 'lang' => used, 'channel' => used]
 * or null for a key that is neither built in nor in the database.
 */
function notifyTemplate(string $key, string $lang, string $channel): ?array
{
    if (!preg_match('/^[A-Za-z0-9_.-]{1,64}$/', $key)) return null;
    $channel  = in_array($channel, NOTIFY_CHANNELS, true) ? $channel : 'any';
    $channels = $channel === 'any' ? ['any'] : [$channel, 'any'];

    $defaults = notifyTemplateDefaults();
    $def      = $defaults[$key] ?? null;
    $db       = notifyTemplateDbRows($key);
    if ($def === null && !$db) return null;

    foreach (notifyTemplateLangChain($lang) as $l) {
        $found = null;
        foreach ($channels as $c) {
            if ($v = notifyTemplateRowVariant($db[$l][$c] ?? null)) { $found = $v + ['source' => 'db', 'lang' => $l, 'channel' => $c]; break; }
        }
        if ($found === null) {
            foreach ($channels as $c) {
                if ($v = notifyTemplateDefaultVariant($def, $l, $c)) { $found = $v + ['source' => 'default', 'lang' => $l, 'channel' => $c]; break; }
            }
        }
        if ($found === null) continue;

        // A channel-specific row saved without a button label borrows the label
        // of the shared version in the same language, so an edited SMS does not
        // silently strip the WhatsApp button of its words.
        if (($found['cta_label'] === null || $found['cta_label'] === '') && $found['channel'] !== 'any') {
            $shared = notifyTemplateRowVariant($db[$l]['any'] ?? null) ?? notifyTemplateDefaultVariant($def, $l, 'any');
            $found['cta_label'] = (string) ($shared['cta_label'] ?? '');
        }
        $found['cta_label'] = (string) $found['cta_label'];
        return $found;
    }
    return null;
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

/**
 * {{name}} → value. Unknown names render as ''. With $html the VALUES are
 * escaped for HTML; the template text never is. Array and object values are
 * ignored (rendered as ''). No other syntax exists.
 */
function notifyInterpolate(string $text, array $vars, bool $html = false): string
{
    if ($text === '' || !str_contains($text, '{{')) return $text;
    return (string) preg_replace_callback(NOTIFY_TEMPLATE_VAR_RE, static function (array $m) use ($vars, $html): string {
        $value = $vars[$m[1]] ?? null;
        if ($value === null || is_array($value) || is_object($value)) return '';
        $s = is_bool($value) ? ($value ? '1' : '0') : (string) $value;
        return $html ? htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') : $s;
    }, $text);
}

/** Every distinct {{name}} in the given texts, in order of first use. */
function notifyTemplateVarsUsed(string ...$texts): array
{
    $names = [];
    foreach ($texts as $t) {
        if (preg_match_all(NOTIFY_TEMPLATE_VAR_RE, $t, $m)) {
            foreach ($m[1] as $n) $names[$n] = true;
        }
    }
    return array_keys($names);
}

/** The temple facts as template variables, in the given language (English for any language without its own). */
function notifyTemplateAutoVars(string $lang): array
{
    $f = notifyTempleFacts();
    $l = $lang === 'ta' ? 'ta' : 'en';
    return [
        'templeName'      => $f['name'][$l],
        'templeShortName' => $f['shortName'][$l],
        'templeAddress'   => $f['address'][$l],
        'mapsUrl'         => $f['mapsUrl'],
        // Written the way the site prints it ("+91 94430 02296"): easier to read
        // aloud than bare E.164, still recognised as a number by phones, and the
        // spaces are GSM-7, so an SMS keeps its alphabet.
        'supportPhone'    => $f['supportPhoneDisplay'],
        'trustName'       => $f['trust'][$l],
        'taxNote'         => $f['taxNote'][$l],
    ];
}

/** A value counts as supplied when it is a non-empty scalar. */
function notifyTemplateHasValue(array $vars, string $name): bool
{
    if (!array_key_exists($name, $vars)) return false;
    $v = $vars[$name];
    return $v !== null && !is_array($v) && !is_object($v) && (string) (is_bool($v) ? (int) $v : $v) !== '';
}

/**
 * Render a template for one language and channel, as plain text.
 *
 * Returns ['title','body','cta_label','provider_template','provider_params'
 * (ordered VALUES for the provider template),'missing' (names the template uses
 * that $vars did not supply),'lang' (used),'channel' (used),'source'].
 * For an unknown key every text is '' and source is null, so a caller that
 * forgot to check still sends nothing rather than crashing.
 *
 * templeName, templeShortName, templeAddress, mapsUrl, supportPhone, trustName
 * and taxNote are filled from notifyTempleFacts() when absent and are never
 * reported missing. devoteeName, when absent, renders as a respectful generic
 * form of address ("அன்பர்" / "devotee") so a greeting never reads
 * "Vanakkam ," — but it is still reported missing, so a preview shows the gap.
 */
function notifyRender(string $key, string $lang, string $channel, array $vars): array
{
    $tpl = notifyTemplate($key, $lang, $channel);
    if ($tpl === null) {
        return [
            'title' => '', 'body' => '', 'cta_label' => '', 'provider_template' => null, 'provider_params' => [],
            'missing' => [], 'lang' => $lang, 'channel' => $channel, 'source' => null,
        ];
    }

    $used    = notifyTemplateVarsUsed($tpl['title'], $tpl['body'], $tpl['cta_label']);
    $missing = [];
    foreach (array_unique([...$used, ...$tpl['provider_params']]) as $name) {
        if (!notifyTemplateHasValue($vars, $name) && !in_array($name, NOTIFY_TEMPLATE_AUTO_VARS, true)) $missing[] = $name;
    }

    $all = $vars;
    foreach (notifyTemplateAutoVars($tpl['lang']) as $name => $value) {
        if (!notifyTemplateHasValue($all, $name)) $all[$name] = $value;
    }
    if (!notifyTemplateHasValue($all, 'devoteeName')) {
        $all['devoteeName'] = $tpl['lang'] === 'ta' ? 'அன்பர்' : 'devotee';
    }

    // Titles are one line everywhere they appear (subject, push, lock screen).
    $title = trim((string) preg_replace('/\s+/u', ' ', notifyInterpolate($tpl['title'], $all)));
    $body  = str_replace(["\r\n", "\r"], "\n", notifyInterpolate($tpl['body'], $all));
    // A value that rendered empty can leave a run of blank lines; keep paragraphs single-spaced.
    $body  = trim((string) preg_replace("/\n[ \t]*\n(?:[ \t]*\n)+/", "\n\n", $body));
    $cta   = trim((string) preg_replace('/\s+/u', ' ', notifyInterpolate($tpl['cta_label'], $all)));

    $params = [];
    foreach ($tpl['provider_params'] as $name) {
        $params[] = notifyInterpolate('{{' . $name . '}}', $all);
    }

    return [
        'title'             => mb_substr($title, 0, 200),
        'body'              => $body,
        'cta_label'         => mb_substr($cta, 0, 80),
        'provider_template' => $tpl['provider_template'],
        'provider_params'   => $params,
        'missing'           => $missing,
        'lang'              => $tpl['lang'],
        'channel'           => $tpl['channel'],
        'source'            => $tpl['source'],
    ];
}

/* ── SMS length ─────────────────────────────────────────────────────────── */

/**
 * GSM 03.38 alphabets. The basic table costs one septet per character; the
 * extension table is reached through an escape and costs two. Anything outside
 * both forces the whole message into UCS-2.
 */
function notifyGsmTables(): array
{
    static $tables = null;
    if ($tables !== null) return $tables;
    $basic = "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?"
           . '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
    $ext   = "\f^{}\\[~]|€";
    $tables = [
        'basic' => array_fill_keys(mb_str_split($basic), true),
        'ext'   => array_fill_keys(mb_str_split($ext), true),
    ];
    return $tables;
}

/**
 * How an SMS will be billed: ['chars' => int, 'segments' => int, 'encoding' => 'GSM-7'|'UCS-2'].
 *
 * chars is what the limit counts: septets for GSM-7 (extension characters such
 * as € [ ] { } count 2), UTF-16 code units for UCS-2 (so an emoji counts 2).
 * One segment holds 160 GSM-7 or 70 UCS-2; a multipart message loses room to its
 * concatenation header, 153 or 67 per part. Segments are filled the way
 * carriers fill them — an escape pair or a surrogate pair is never split across
 * two parts — so a message can need one part more than a plain division says.
 */
function notifySmsInfo(string $text): array
{
    $text = mb_scrub($text, 'UTF-8');
    if ($text === '') return ['chars' => 0, 'segments' => 0, 'encoding' => 'GSM-7'];

    $tables = notifyGsmTables();
    $chars  = mb_str_split($text);
    $gsm    = true;
    foreach ($chars as $ch) {
        if (!isset($tables['basic'][$ch]) && !isset($tables['ext'][$ch])) { $gsm = false; break; }
    }

    $units = [];
    foreach ($chars as $ch) {
        $units[] = $gsm
            ? (isset($tables['ext'][$ch]) ? 2 : 1)
            : (mb_ord($ch, 'UTF-8') > 0xFFFF ? 2 : 1);
    }
    $total  = array_sum($units);
    $single = $gsm ? 160 : 70;
    $part   = $gsm ? 153 : 67;

    if ($total <= $single) {
        $segments = 1;
    } else {
        $segments = 1;
        $fill = 0;
        foreach ($units as $u) {
            if ($fill + $u > $part) { $segments++; $fill = 0; }
            $fill += $u;
        }
    }
    return ['chars' => $total, 'segments' => $segments, 'encoding' => $gsm ? 'GSM-7' : 'UCS-2'];
}

/* ── Samples for previews ───────────────────────────────────────────────── */

/**
 * Realistic values for every variable a template declares or uses, in the given
 * language — for the admin's live previews and for tests. Automatic variables
 * come from the real temple facts. Amounts are written "Rs." rather than "₹"
 * because ₹ is outside the GSM-7 alphabet and would halve an SMS.
 */
function notifyTemplateSample(string $key, string $lang): array
{
    $l   = $lang === 'ta' ? 'ta' : 'en';
    $def = notifyTemplateDefaults()[$key] ?? null;

    $names = (array) ($def['variables'] ?? []);
    foreach (['any', 'email', 'inapp', 'push', 'sms', 'whatsapp'] as $c) {
        $tpl = notifyTemplate($key, $lang, $c);
        if ($tpl) $names = [...$names, ...notifyTemplateVarsUsed($tpl['title'], $tpl['body'], $tpl['cta_label']), ...$tpl['provider_params']];
    }

    $token = str_repeat('7c3e9a51', 8);
    $samples = [
        'devoteeName'      => ['ta' => 'கவிதா ராமசாமி', 'en' => 'Kavitha Ramasamy'],
        'verifyUrl'        => siteUrl('/verify-email?token=' . $token),
        'resetUrl'         => siteUrl('/reset-password?token=' . $token),
        'expiresHours'     => '48',
        'expiresMinutes'   => $key === 'phone_otp' ? '10' : '60',
        'changedAt'        => ['ta' => '13 செப்டம்பர் 2026, மாலை 6:45 (IST)', 'en' => '13 Sep 2026, 6:45 pm IST'],
        'changedFields'    => ['ta' => 'தொலைபேசி எண், முகவரி', 'en' => 'phone number, address'],
        'otpCode'          => '482913',
        'phoneMasked'      => '+91 ******2296',
        'bookingNumber'    => 'SB-1042',
        'sevaName'         => ['ta' => 'அபிஷேகம்', 'en' => 'Abhishekam'],
        'bookingDate'      => ['ta' => '20 செப்டம்பர் 2026', 'en' => '20 Sep 2026'],
        'changes'          => ['ta' => 'தேதி 18 செப்டம்பரிலிருந்து 20 செப்டம்பருக்கு மாற்றப்பட்டது', 'en' => 'Date moved from 18 Sep to 20 Sep 2026'],
        'reason'           => ['ta' => 'அன்று கோயிலில் சிறப்பு பூஜை நடைபெறுவதால்', 'en' => 'a special pooja is being held at the temple that day'],
        'receiptNumber'    => 'DN-2026-0187',
        'donationAmount'   => 'Rs. 1,001',
        'donationPurpose'  => ['ta' => 'அன்னதானம்', 'en' => 'Annadanam'],
        'donationDate'     => ['ta' => '12 செப்டம்பர் 2026', 'en' => '12 Sep 2026'],
        'paymentReference' => 'PAY-8F3K2Q',
        'paymentAmount'    => 'Rs. 251',
        'paymentFor'       => ['ta' => 'அபிஷேகம் சேவை', 'en' => 'Abhishekam seva'],
        'eventName'        => ['ta' => 'பௌர்ணமி பூஜை & அன்னதானம்', 'en' => 'Pournami Pooja and Annadanam'],
        'eventDate'        => ['ta' => '7 அக்டோபர் 2026, காலை 6:00', 'en' => '7 Oct 2026, 6:00 am'],
        'eventLocation'    => ['ta' => 'கோயில் வளாகம், புதுப்பட்டி', 'en' => 'Temple grounds, Pudupatti'],
        'poojaName'        => ['ta' => 'பௌர்ணமி பூஜை', 'en' => 'Pournami Pooja'],
        'poojaDate'        => ['ta' => '7 அக்டோபர் 2026', 'en' => '7 Oct 2026'],
        'poojaTime'        => ['ta' => 'காலை 6:00', 'en' => '6:00 am'],
        'opportunityName'  => ['ta' => 'மஹா சிவராத்திரி அன்னதான சேவை', 'en' => 'Maha Shivaratri annadanam service'],
        'membershipName'   => ['ta' => 'ஆண்டு உறுப்பினர்', 'en' => 'Annual membership'],
        'renewalDate'      => ['ta' => '1 அக்டோபர் 2026', 'en' => '1 Oct 2026'],
        'headline'         => ['ta' => 'இன்று கோயில் நடை சாத்தப்பட்டுள்ளது', 'en' => 'Temple closed today'],
        'message'          => [
            'ta' => 'கனமழை காரணமாக இன்று கோயில் நடை சாத்தப்பட்டுள்ளது. நாளை காலை 6 மணிக்கு வழக்கம் போல் பூஜை நடைபெறும்.',
            'en' => 'Due to heavy rain the temple is closed today. Pooja resumes tomorrow at 6 am as usual.',
        ],
        'title'            => ['ta' => 'மஹா சிவராத்திரி ஏற்பாடுகள்', 'en' => 'Maha Shivaratri arrangements'],
    ];

    $out = [];
    foreach (array_unique($names) as $name) {
        if (in_array($name, NOTIFY_TEMPLATE_AUTO_VARS, true) || $name === 'ctaUrl') continue;
        $s = $samples[$name] ?? null;
        $out[$name] = is_array($s) ? $s[$l] : ($s ?? '[' . $name . ']');
    }

    // A preview should show where the button really goes.
    $path = (string) ($def['cta_path'] ?? '/account');
    $cta  = notifyInterpolate($path, $out);
    $out['ctaUrl'] = preg_match('~^https?://~i', $cta) ? $cta : siteUrl($cta === '' ? '/account' : $cta);

    return $out + notifyTemplateAutoVars($l);
}
