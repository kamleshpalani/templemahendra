<?php
/**
 * tests/notify-templates-unit.php — the words of the notification system.
 *
 *   PHP_BIN=/path/to/php.sh; $PHP_BIN tests/notify-templates-unit.php
 *
 * Proves, against the real database:
 *   • every template key in SPEC §5.2 exists in Tamil and English, with SMS and
 *     WhatsApp variants, and uses only variables it declares or that are filled
 *     automatically;
 *   • English SMS fit one GSM-7 segment with realistic values; titles fit 60;
 *   • interpolation escapes values (never the template) and reports gaps;
 *   • database rows override the built-in wording in exactly the SPEC order,
 *     with the Tamil-then-English language fallback, and a missing table falls
 *     back to the built-in wording;
 *   • SMS length and segment counting at the boundaries;
 *   • the email wrapper neutralises hostile input, refuses unsafe links, and
 *     shows the unsubscribe link, open pixel and priority banner only when due.
 *
 * Writes three rendered emails to the email-previews directory for a visual
 * check. Database rows it creates use template_key "e2e_tpl_…" and are deleted
 * before and after the run, so it can be run repeatedly.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../backend/includes/notify/templates.php';
require_once __DIR__ . '/../backend/includes/notify/email.php';

$failures = 0;
$passes   = 0;
function check(bool $cond, string $label, string $detail = ''): void
{
    global $failures, $passes;
    if ($cond) { $passes++; echo "ok   $label\n"; return; }
    $failures++;
    echo "FAIL $label" . ($detail !== '' ? "\n     $detail" : '') . "\n";
}

$db  = getDB();
$run = bin2hex(random_bytes(3));
$cleanup = static function () use ($db): void {
    $db->exec("DELETE FROM notification_templates WHERE template_key LIKE 'e2e\\_tpl\\_%'");
};
$cleanup();
register_shutdown_function($cleanup);

/* ── 1. Every SPEC key exists, bilingual, with channel variants ─────────── */

// SPEC §5.2: key => [category, variables beyond devoteeName/templeName/ctaUrl]
$spec = [
    'welcome'               => ['general', []],
    'email_verification'    => ['security', ['verifyUrl', 'expiresHours']],
    'email_verified'        => ['security', []],
    'password_reset'        => ['security', ['resetUrl', 'expiresMinutes']],
    'password_changed'      => ['security', ['changedAt']],
    'profile_updated'       => ['security', ['changedFields']],
    'phone_otp'             => ['security', ['otpCode', 'expiresMinutes']],
    'phone_verified'        => ['security', ['phoneMasked']],
    'booking_received'      => ['booking', ['bookingNumber', 'sevaName', 'bookingDate']],
    'booking_confirmed'     => ['booking', ['bookingNumber', 'sevaName', 'bookingDate']],
    'booking_modified'      => ['booking', ['bookingNumber', 'sevaName', 'bookingDate', 'changes']],
    'booking_cancelled'     => ['booking', ['bookingNumber', 'sevaName', 'bookingDate', 'reason']],
    'booking_completed'     => ['booking', ['bookingNumber', 'sevaName']],
    'booking_reminder'      => ['booking', ['bookingNumber', 'sevaName', 'bookingDate', 'templeAddress', 'mapsUrl']],
    'donation_received'     => ['donation', ['receiptNumber', 'donationAmount', 'donationPurpose']],
    'donation_receipt'      => ['donation', ['receiptNumber', 'donationAmount', 'donationPurpose', 'donationDate', 'trustName', 'taxNote']],
    'payment_success'       => ['payment', ['paymentReference', 'paymentAmount', 'paymentFor']],
    'payment_failed'        => ['payment', ['paymentReference', 'paymentAmount', 'paymentFor', 'reason']],
    'event_registered'      => ['event', ['eventName', 'eventDate', 'eventLocation']],
    'event_cancelled'       => ['event', ['eventName', 'eventDate', 'reason']],
    'event_reminder'        => ['event', ['eventName', 'eventDate', 'eventLocation']],
    'festival_reminder'     => ['festival', ['eventName', 'eventDate', 'eventLocation']],
    'pooja_reminder'        => ['pooja', ['poojaName', 'poojaDate', 'poojaTime']],
    'volunteer_registered'  => ['volunteer', ['opportunityName']],
    'volunteer_opportunity' => ['volunteer', ['opportunityName', 'eventDate']],
    'membership_renewal'    => ['membership', ['membershipName', 'renewalDate']],
    'special_darshan'       => ['special_darshan', ['eventName', 'eventDate', 'eventLocation']],
    'announcement'          => ['announcement', ['headline', 'message']],
    'emergency'             => ['emergency', ['headline', 'message']],
    'campaign_generic'      => [null, ['title', 'message']],
];

$defaults = notifyTemplateDefaults();
$shapeProblems = [];
$varProblems   = [];
foreach ($spec as $key => [$category, $vars]) {
    $d = $defaults[$key] ?? null;
    if (!is_array($d)) { $shapeProblems[] = "$key missing"; continue; }
    if ($category !== null && ($d['category'] ?? null) !== $category) $shapeProblems[] = "$key category {$d['category']} ≠ $category";
    if (trim((string) ($d['description'] ?? '')) === '') $shapeProblems[] = "$key has no description";
    if (!is_string($d['cta_path'] ?? null)) $shapeProblems[] = "$key has no cta_path";
    $declared = (array) ($d['variables'] ?? []);
    foreach (['devoteeName', 'ctaUrl', ...$vars] as $v) {
        if (!in_array($v, $declared, true)) $shapeProblems[] = "$key does not declare $v";
    }
    foreach (['ta', 'en'] as $l) {
        $any = $d['langs'][$l]['any'] ?? [];
        if (trim((string) ($any['title'] ?? '')) === '' || trim((string) ($any['body'] ?? '')) === '') $shapeProblems[] = "$key $l any lacks title/body";
        if (trim((string) ($any['cta_label'] ?? '')) === '') $shapeProblems[] = "$key $l any lacks cta_label";
        foreach (['sms', 'whatsapp'] as $c) {
            if (trim((string) ($d['langs'][$l][$c]['body'] ?? '')) === '') $shapeProblems[] = "$key $l $c lacks a body";
        }
        foreach ($d['langs'][$l] as $c => $variant) {
            $used = notifyTemplateVarsUsed((string) ($variant['title'] ?? ''), (string) $variant['body'], (string) ($variant['cta_label'] ?? ''), (string) $d['cta_path']);
            foreach ($used as $name) {
                if (!in_array($name, $declared, true) && !in_array($name, NOTIFY_TEMPLATE_AUTO_VARS, true)) $varProblems[] = "$key $l $c uses undeclared {{{$name}}}";
            }
        }
    }
}
check(count($defaults) >= count($spec) && !$shapeProblems, 'all ' . count($spec) . ' SPEC template keys exist with category, description, variables, cta_path, ta+en any/sms/whatsapp', implode('; ', $shapeProblems));
check(!$varProblems, 'every {{variable}} used in any variant is declared or automatic', implode('; ', $varProblems));

/* ── 2. Lengths with realistic values ───────────────────────────────────── */

$smsProblems = [];
$titleProblems = [];
$sampleProblems = [];
$taSms = [];
foreach (array_keys($spec) as $key) {
    foreach (['ta', 'en'] as $l) {
        $sample = notifyTemplateSample($key, $l);
        foreach ((array) $defaults[$key]['variables'] as $v) {
            if (!isset($sample[$v]) || $sample[$v] === '' || str_starts_with((string) $sample[$v], '[')) $sampleProblems[] = "$key $l $v";
        }
        $any = notifyRender($key, $l, 'any', $sample);
        if (mb_strlen($any['title']) > 60) $titleProblems[] = "$key $l (" . mb_strlen($any['title']) . '): ' . $any['title'];
        if ($any['missing']) $sampleProblems[] = "$key $l any missing " . implode(',', $any['missing']);

        $sms  = notifyRender($key, $l, 'sms', $sample);
        $info = notifySmsInfo($sms['body']);
        if ($sms['channel'] !== 'sms' || $sms['lang'] !== $l) $smsProblems[] = "$key $l did not resolve its own sms variant";
        if ($l === 'en' && ($info['encoding'] !== 'GSM-7' || $info['chars'] > 160)) {
            $smsProblems[] = "$key en {$info['encoding']} {$info['chars']} chars: {$sms['body']}";
        }
        if ($l === 'ta') $taSms[$key] = $info;
    }
}
check(!$sampleProblems, 'notifyTemplateSample supplies a realistic value for every declared variable, and samples leave nothing missing', implode('; ', $sampleProblems));
check(!$titleProblems, 'every rendered title (ta and en, sample values) is at most 60 characters', implode(' | ', $titleProblems));
check(!$smsProblems, 'every English SMS renders as one GSM-7 segment (≤160) with sample values', implode(' | ', $smsProblems));
// Free-text wrappers carry the committee's own message, so their length is the
// committee's to choose; the admin preview shows them the segment count.
$freeText = ['announcement', 'emergency', 'campaign_generic'];
$longTa = array_filter($taSms, fn($i, $k) => $i['segments'] > 2 && !in_array($k, $freeText, true), ARRAY_FILTER_USE_BOTH);
check(!$longTa, 'every Tamil SMS with fixed wording fits in two UCS-2 segments', json_encode($longTa, JSON_UNESCAPED_UNICODE));
$taSegs = array_count_values(array_map(fn($i) => $i['segments'], $taSms));
ksort($taSegs);
echo '     Tamil SMS segments: ' . json_encode($taSegs) . " (segments => templates)\n";

/* ── 3. Security copy rules ─────────────────────────────────────────────── */

foreach (['email_verification' => 'verifyUrl', 'password_reset' => 'resetUrl'] as $key => $var) {
    foreach (['ta', 'en'] as $l) {
        $lines = explode("\n", $defaults[$key]['langs'][$l]['any']['body']);
        check(in_array('{{' . $var . '}}', $lines, true), "$key $l body puts {{{$var}}} alone on its own line");
        foreach (['sms', 'whatsapp'] as $c) {
            check(!str_contains($defaults[$key]['langs'][$l][$c]['body'], '{{' . $var . '}}'), "$key $l $c never carries the link to a phone");
        }
    }
}
foreach (['ta', 'en'] as $l) {
    foreach (['any', 'sms', 'whatsapp'] as $c) {
        $b = $defaults['phone_otp']['langs'][$l][$c]['body'];
        check((bool) preg_match('/^\*?\{\{otpCode\}\}/', $b) && str_contains($b, '{{expiresMinutes}}'), "phone_otp $l $c starts with the code and states the expiry");
    }
}
check(str_contains($defaults['phone_otp']['langs']['en']['sms']['body'], 'Never share this code'), 'phone_otp en sms says never share this code');
check(str_contains($defaults['phone_otp']['langs']['ta']['sms']['body'], 'பகிர வேண்டாம்'), 'phone_otp ta sms says never share this code');
foreach (['password_changed', 'profile_updated', 'password_reset', 'phone_verified'] as $key) {
    check(str_contains($defaults[$key]['langs']['en']['any']['body'], 'not'), "$key en says what to do if it was not the devotee");
}
$reset = notifyRender('password_reset', 'en', 'email', notifyTemplateSample('password_reset', 'en'));
$resetUrl = notifyTemplateSample('password_reset', 'en')['resetUrl'];
$text = notifyEmailText(['title' => $reset['title'], 'body' => $reset['body'], 'lang' => 'en', 'cta_url' => $resetUrl, 'cta_label' => $reset['cta_label']]);
preg_match('~^(https?://\S+/reset-password\?token=[a-f0-9]+)$~m', $text, $m);
check(($m[1] ?? null) === $resetUrl, 'the reset link can be read from the plain-text email on a line of its own');

/* ── 4. Temple facts ────────────────────────────────────────────────────── */

$facts = notifyTempleFacts();
check((bool) preg_match('/^\+91\d{10}$/', $facts['phones']['primary']) && (bool) preg_match('/^\+91\d{10}$/', $facts['phones']['secondary']), 'temple phone numbers are E.164');
check($facts['supportPhone'] === $facts['phones']['primary'], 'supportPhone is the primary contact the site calls');
check(str_starts_with($facts['mapsUrl'], 'https://maps.google.com/maps?q=Dhabbalavaar%20Renuka%20Devi') && !str_contains($facts['mapsUrl'], ' '), 'maps URL is encoded like the site builds it');
foreach (['name', 'shortName', 'address', 'trust', 'taxNote'] as $f) {
    check(($facts[$f]['ta'] ?? '') !== '' && ($facts[$f]['en'] ?? '') !== '', "temple fact $f exists in ta and en");
}

/* ── 5. Interpolation ───────────────────────────────────────────────────── */

check(notifyInterpolate('Hi {{name}}!', ['name' => 'Kavitha']) === 'Hi Kavitha!', 'interpolate replaces a variable');
check(notifyInterpolate('Hi {{ name }}', ['name' => 'K']) === 'Hi K', 'interpolate tolerates spaces inside the braces');
check(notifyInterpolate('<b>{{x}}</b>', ['x' => '<script>alert("1")</script>'], true) === '<b>&lt;script&gt;alert(&quot;1&quot;)&lt;/script&gt;</b>', 'html mode escapes the value but not the template');
check(notifyInterpolate('<b>{{x}}</b>', ['x' => '<i>'], false) === '<b><i></b>', 'plain mode leaves values as written');
check(notifyInterpolate('[{{nope}}]', []) === '[]', 'an unknown variable renders empty');
check(notifyInterpolate('[{{arr}}]', ['arr' => ['a', 'b']]) === '[]', 'an array value is ignored');
check(notifyInterpolate('{{n}} {{b}}', ['n' => 42, 'b' => true]) === '42 1', 'numbers and booleans render as text');
check(notifyInterpolate('{{x}} {x} {{{x}}} {% if %}', ['x' => 'v']) === 'v {x} {v} {% if %}', 'no other syntax is interpreted');
check(notifyInterpolate('{{a}}', ['a' => '{{b}}', 'b' => 'leak']) === '{{b}}', 'values are not re-interpolated');

/* ── 6. Render: automatic facts, missing names, registered templates ───── */

$key = 'e2e_tpl_' . $run;
check(notifyTemplateRegister($key, [
    'category' => 'general', 'description' => 'test', 'variables' => ['devoteeName'], 'cta_path' => '/',
    'langs' => [
        'ta' => ['any' => ['title' => 'TA-DEFAULT-ANY', 'body' => 'ta default any {{nosuch}}', 'cta_label' => 'TA-CTA'],
                 'sms' => ['title' => '', 'body' => 'ta default sms']],
        'en' => ['any' => ['title' => 'EN-DEFAULT-ANY {{devoteeName}}', 'body' => "Hello {{devoteeName}} of {{templeName}}, call {{supportPhone}}. [{{nosuch}}]\n\n\n\nEnd", 'cta_label' => 'EN-CTA'],
                 'sms' => ['title' => '', 'body' => 'en default sms']],
    ],
]), 'a module can register its own template');
check(notifyTemplateRegister('welcome', ['langs' => []]) === false, 'a built-in template cannot be replaced by registration');
notifyTemplateCacheClear();

$r = notifyRender($key, 'en', 'any', ['devoteeName' => 'Kavitha']);
check(str_contains($r['body'], $facts['name']['en']) && str_contains($r['body'], $facts['supportPhoneDisplay']), 'templeName and supportPhone are filled automatically');
check(str_contains($r['body'], '[]') && $r['missing'] === ['nosuch'], 'an unknown variable renders empty and is reported missing (and automatic ones are not)', json_encode($r['missing']));
check(!str_contains($r['body'], "\n\n\n"), 'blank-line runs collapse to one paragraph break');
$r = notifyRender($key, 'en', 'any', []);
check($r['title'] === 'EN-DEFAULT-ANY devotee' && in_array('devoteeName', $r['missing'], true), 'an absent devoteeName reads "devotee" and is still reported missing');
$r = notifyRender($key, 'en', 'any', ['devoteeName' => 'Kavitha', 'templeName' => 'Override Temple']);
check(str_contains($r['body'], 'Override Temple'), 'a caller-supplied templeName wins over the automatic one');
$r = notifyRender('no_such_template_' . $run, 'en', 'any', []);
check($r['source'] === null && $r['body'] === '' && $r['title'] === '', 'rendering an unknown key returns empty text, not an error');
check(notifyTemplate('no_such_template_' . $run, 'en', 'any') === null, 'notifyTemplate returns null for an unknown key');
check(notifyTemplate("bad key'; --", 'en', 'any') === null, 'a malformed key is rejected before any query');

/* ── 7. Database overrides, precedence and language fallback ────────────── */

$ins = $db->prepare(
    'INSERT INTO notification_templates (template_key, lang, channel, title, body, cta_label, provider_template, provider_params, is_active, updated_by)
     VALUES (:k, :l, :c, :t, :b, :cta, :pt, :pp, :a, :u)'
);
$add = static function (string $k, string $l, string $c, string $title, string $body, ?string $cta = null, ?string $pt = null, ?array $pp = null, int $active = 1) use ($ins): void {
    $ins->execute([':k' => $k, ':l' => $l, ':c' => $c, ':t' => $title, ':b' => $body, ':cta' => $cta, ':pt' => $pt,
                   ':pp' => $pp === null ? null : json_encode($pp), ':a' => $active, ':u' => 'e2e']);
    notifyTemplateCacheClear();
};
$src = static fn(?array $t) => $t === null ? 'null' : "{$t['source']}:{$t['lang']}:{$t['channel']}";

check($src(notifyTemplate($key, 'en', 'sms')) === 'default:en:sms', 'no rows: default (en, sms)');
check($src(notifyTemplate($key, 'en', 'email')) === 'default:en:any', 'no rows: a channel without an override uses default (en, any)');

$add($key, 'en', 'any', 'DB-EN-ANY', 'db en any', 'DB-EN-CTA');
check($src(notifyTemplate($key, 'en', 'sms')) === 'db:en:any', 'DB (en, any) outranks default (en, sms)');
check($src(notifyTemplate($key, 'en', 'any')) === 'db:en:any', 'DB (en, any) outranks default (en, any)');

$add($key, 'en', 'sms', '', 'db en sms {{devoteeName}}', null, 'dlt-1107', ['devoteeName', 'supportPhone']);
$t = notifyTemplate($key, 'en', 'sms');
check($src($t) === 'db:en:sms', 'DB (en, sms) outranks DB (en, any)');
check($t['cta_label'] === 'DB-EN-CTA', 'a channel row without a CTA label borrows the shared row\'s label');
check($t['provider_template'] === 'dlt-1107' && $t['provider_params'] === ['devoteeName', 'supportPhone'], 'provider template and ordered parameter names come from the row');
$r = notifyRender($key, 'en', 'sms', ['devoteeName' => 'Kavitha']);
check($r['provider_params'] === ['Kavitha', $facts['supportPhoneDisplay']] && $r['body'] === 'db en sms Kavitha', 'render returns provider parameter VALUES in order', json_encode($r['provider_params']));

$add($key, 'en', 'push', 'INACTIVE', 'inactive push', null, null, null, 0);
check($src(notifyTemplate($key, 'en', 'push')) === 'db:en:any', 'an inactive row is ignored');
$add($key, 'en', 'whatsapp', '', '   ');
check($src(notifyTemplate($key, 'en', 'whatsapp')) === 'db:en:any', 'a row with an empty body is ignored');

check($src(notifyTemplate($key, 'hi', 'sms')) === 'default:ta:sms', 'Hindi with no Hindi rows falls back to Tamil defaults before English rows');
$add($key, 'ta', 'any', 'DB-TA-ANY', 'db ta any');
check($src(notifyTemplate($key, 'hi', 'sms')) === 'db:ta:any', 'Hindi falls back to DB (ta, any) ahead of default (ta, sms)');
check($src(notifyTemplate($key, 'ta', 'email')) === 'db:ta:any', 'Tamil email uses DB (ta, any)');
$add($key, 'hi', 'any', 'DB-HI-ANY', 'db hi any');
check($src(notifyTemplate($key, 'hi', 'sms')) === 'db:hi:any', 'a Hindi row is used for Hindi');
check($src(notifyTemplate($key, 'hi-IN', 'sms')) === 'db:hi:any', 'a regional code (hi-IN) falls back to its base language');
check($src(notifyTemplate($key, '../../etc', 'any')) === 'db:ta:any', 'a malformed language code falls back to Tamil');

$dbOnly = 'e2e_tpl_' . $run . '_dbonly';
$add($dbOnly, 'en', 'any', 'Only in DB', 'only english');
check($src(notifyTemplate($dbOnly, 'ta', 'sms')) === 'db:en:any', 'a DB-only key with only English resolves Tamil requests to English');
check(notifyTemplate($dbOnly . 'x', 'ta', 'sms') === null, 'a key with neither default nor row is unknown');

// Cached per request: a row added without clearing the cache is not seen until it is cleared.
$ins->execute([':k' => $dbOnly, ':l' => 'ta', ':c' => 'any', ':t' => 'TA', ':b' => 'tamil now', ':cta' => null, ':pt' => null, ':pp' => null, ':a' => 1, ':u' => 'e2e']);
check($src(notifyTemplate($dbOnly, 'ta', 'any')) === 'db:en:any', 'lookups are cached for the request');
notifyTemplateCacheClear();
check($src(notifyTemplate($dbOnly, 'ta', 'any')) === 'db:ta:any', 'notifyTemplateCacheClear() makes new rows visible');

// Table missing: a database without notification_templates must still speak.
$code = 'require ' . var_export(realpath(__DIR__ . '/../backend/includes/notify/templates.php'), true) . ';'
      . '$t = notifyTemplate("booking_confirmed", "ta", "sms");'
      . '$r = notifyRender("booking_confirmed", "en", "any", ["sevaName" => "Archana"]);'
      . 'echo json_encode(["src" => $t["source"] ?? null, "ok" => str_contains($r["title"], "Archana")]);';
$env = getenv();
$env['DB_NAME'] = 'information_schema';
$proc = proc_open([PHP_BINARY, '-c', (string) php_ini_loaded_file(), '-r', $code], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
$out = stream_get_contents($pipes[1]);
$err = stream_get_contents($pipes[2]);
proc_close($proc);
$res = json_decode(trim($out), true);
check(($res['src'] ?? null) === 'default' && ($res['ok'] ?? false) === true, 'with the templates table missing, built-in wording is used', trim($out . ' ' . $err));

/* ── 8. SMS length and segments ─────────────────────────────────────────── */

$sms = static fn(string $s) => notifySmsInfo($s);
$is  = static fn(array $i, int $c, int $s, string $e) => $i['chars'] === $c && $i['segments'] === $s && $i['encoding'] === $e;
check($is($sms(''), 0, 0, 'GSM-7'), 'empty text is zero segments');
check($is($sms(str_repeat('a', 160)), 160, 1, 'GSM-7'), '160 ASCII characters are one segment');
check($is($sms(str_repeat('a', 161)), 161, 2, 'GSM-7'), '161 ASCII characters are two segments');
check($is($sms(str_repeat('a', 306)), 306, 2, 'GSM-7'), '306 ASCII characters are two 153-character parts');
check($is($sms(str_repeat('a', 307)), 307, 3, 'GSM-7'), '307 ASCII characters are three parts');
check($is($sms(str_repeat('€', 80)), 160, 1, 'GSM-7'), 'extension characters count two (80 € = 160, one segment)');
check($is($sms(str_repeat('a', 159) . '{'), 161, 2, 'GSM-7'), 'an extension character pushes 159 + { over one segment');
check($is($sms(str_repeat('a', 152) . '[' . str_repeat('a', 152)), 306, 3, 'GSM-7'), 'an escape pair is never split across parts');
check($is($sms("Rs. 1,001 @ £5 \n ÄÖÑÜ§¿äöñüà"), 28, 1, 'GSM-7'), 'GSM basic-table accents and symbols stay GSM-7');
check($sms('Rs. ₹1,001')['encoding'] === 'UCS-2', '₹ forces UCS-2');
check($sms('façade')['encoding'] === 'UCS-2', 'lowercase ç is not in the GSM alphabet');
check($sms("Can’t")['encoding'] === 'UCS-2', 'a curly apostrophe forces UCS-2');
check($is($sms(str_repeat('க', 70)), 70, 1, 'UCS-2'), '70 Tamil characters are one segment');
check($is($sms(str_repeat('க', 71)), 71, 2, 'UCS-2'), '71 Tamil characters are two segments');
check($is($sms(str_repeat('க', 134)), 134, 2, 'UCS-2'), '134 Tamil characters are two 67-character parts');
check($is($sms(str_repeat('🙏', 35)), 70, 1, 'UCS-2'), 'an emoji counts as two UTF-16 units (35 emoji = 70)');
check($is($sms(str_repeat('🙏', 36)), 72, 2, 'UCS-2'), '36 emoji need two segments');
check($is($sms(str_repeat('க', 66) . '🙏' . str_repeat('க', 66)), 134, 3, 'UCS-2'), 'a surrogate pair is never split across parts');
check($is($sms('Hi 🙏'), 5, 1, 'UCS-2'), 'one emoji switches a short message to UCS-2');

/* ── 9. The email wrapper ───────────────────────────────────────────────── */

$hostile = [
    'title'          => '<script>alert(1)</script> Title',
    'body'           => "Line <img src=x onerror=alert(1)>\njavascript:alert(2)\n\nSee https://example.org/a?b=1&c=2). And https://example.org/x இது\nhttps://good.example.org/p",
    'lang'           => 'en" onload="x',
    'preheader'      => '<b>preheader</b>',
    'category_label' => '<i>Booking</i>',
    'priority'       => 'normal',
    'details'        => [['<b>Seva</b>', '"><svg onload=alert(3)>'], ['Only one'], 'not a row', [['nested'], 'x'], ['Date', "20 Sep\n2026"]],
    'cta_url'        => 'javascript:alert(4)',
    'cta_label'      => '<u>Go</u>',
    'contact'        => ['phone' => '+91 94430 02296', 'email' => 'office@example.org', 'address' => '<b>Pudupatti</b>'],
];
$html = notifyEmailHtml($hostile);
check(!str_contains($html, '<script') && str_contains($html, '&lt;script&gt;alert(1)&lt;/script&gt; Title'), 'a hostile title is escaped');
check(!str_contains($html, '<img src=x') && !str_contains($html, '<svg') && !str_contains($html, '<b>') && !str_contains($html, '<i>Booking') && !str_contains($html, '<u>'), 'hostile body, details, labels and contact are escaped');
check(!preg_match('/href="\s*javascript/i', $html) && !str_contains($html, 'alert(4)'), 'a javascript: CTA produces no button and no link');
check(!preg_match('/href="javascript/i', $html) && str_contains($html, 'javascript:alert(2)'), 'javascript: text in the body is not linked');
check(str_contains($html, 'href="https://example.org/a?b=1&amp;c=2"') && str_contains($html, '&amp;c=2</a>). And'), 'body URLs are linked, escaped, and trailing punctuation stays outside');
check(str_contains($html, 'href="https://example.org/x"') && str_contains($html, '</a> இது'), 'a Tamil word after a URL is not swallowed into the link');
check(str_contains($html, '<html lang="ta"'), 'a malformed lang falls back to lang="ta"');
check(substr_count($html, 'Only one') === 0 && str_contains($html, '20 Sep<br />2026'), 'malformed detail rows are dropped; newlines in values become breaks');
check(!str_contains($html, 'Unsubscribe') && !str_contains($html, 'width="1" height="1"'), 'no unsubscribe link and no pixel unless given');
check(!str_contains($html, 'role="alert"'), 'normal priority shows no banner');
check(str_contains($html, 'href="mailto:office@example.org"') && str_contains($html, 'href="tel:+919443002296"'), 'contact phone and email are linked');
check(str_contains($html, 'src="' . siteUrl('/icons/icon-192x192.png') . '"'), 'the header uses the absolute site icon by default');
check((bool) preg_match('/<div style="display:none[^"]*">&lt;b&gt;preheader&lt;\/b&gt;/', $html), 'the preheader is hidden and escaped');
check(str_contains(notifyEmailHtml(['title' => 't', 'body' => 'b', 'cta_url' => "  https://x.example/go \n", 'cta_label' => 'Go', 'lang' => 'en']), 'href="https://x.example/go"'), 'whitespace around a pasted CTA URL is trimmed');
foreach (['//evil.example/x', 'data:text/html,hi', 'javascript:alert(1)', "https://x.example/\njavascript:", 'https://site.example@evil.example/', 'ftp://x.example/', 'http:/x'] as $bad) {
    $h = notifyEmailHtml(['title' => 't', 'body' => 'b', 'cta_url' => $bad, 'cta_label' => 'Go', 'lang' => 'en']);
    check(!str_contains($h, '>Go</a>'), 'unsafe CTA URL refused: ' . json_encode($bad));
}

$good = notifyEmailHtml([
    'title' => 'Seva confirmed', 'body' => "First paragraph.\nSecond line.\n\nSecond paragraph.", 'lang' => 'en',
    'priority' => 'urgent', 'cta_url' => '/account?tab=bookings', 'cta_label' => 'View booking',
    'preferences_url' => 'https://temple.example/account?tab=notifications',
    'unsubscribe_url' => 'https://temple.example/api/n/u/u12.abcdefghijklmnop',
    'open_pixel_url'  => 'https://temple.example/api/n/o/o34.abcdefghijklmnop',
]);
check(str_contains($good, '>First paragraph.<br />Second line.</p>') && str_contains($good, '>Second paragraph.</p>'), 'blank lines make paragraphs and newlines make breaks');
check(str_contains($good, 'href="' . siteUrl('/account?tab=bookings') . '"') && str_contains($good, '>View booking</a>'), 'a site-path CTA becomes an absolute button link');
check(str_contains($good, 'If the button does not work'), 'the CTA has a plain fallback link');
$slash = notifyEmailHtml(['title' => 't', 'body' => "See https://example.org/a/b for more.", 'lang' => 'en', 'cta_url' => '/', 'cta_label' => 'Home']);
check(str_contains($slash, 'If the button does not work'), 'a short site-path CTA keeps its fallback link even when the body contains slashes');
$verifyLink = siteUrl('/verify-email?token=abc123');
$inBody = notifyEmailHtml(['title' => 't', 'body' => "Open this link:\n\n$verifyLink\n\nThanks.", 'lang' => 'en', 'cta_url' => $verifyLink, 'cta_label' => 'Confirm']);
check(!str_contains($inBody, 'If the button does not work') && str_contains($inBody, '>Confirm</a>'), 'the fallback link is not repeated when the body already shows the CTA URL on its own line');
check(str_contains($good, 'Unsubscribe from these emails') && str_contains($good, 'u12.abcdefghijklmnop'), 'the unsubscribe link appears when given');
check(str_contains($good, 'src="https://temple.example/api/n/o/o34.abcdefghijklmnop" width="1" height="1"'), 'the open pixel appears when given');
check(str_contains($good, 'role="alert"') && str_contains($good, '>Urgent</div>'), 'urgent priority shows the urgent banner');
$em = notifyEmailHtml(['title' => 'Closed', 'body' => 'b', 'lang' => 'ta', 'priority' => 'emergency']);
check(str_contains($em, 'role="alert"') && str_contains($em, 'அவசர அறிவிப்பு') && str_contains($em, '<html lang="ta"'), 'emergency priority shows the emergency banner in the recipient language');
check(str_contains($em, $facts['name']['ta']), 'the header shows the temple name in Tamil for a Tamil email');
check(!preg_match('/<style|class="/i', $good . $em), 'no <style> element and no classes: inline styles only');
check((bool) preg_match('/max-width:600px/', $good) && str_contains($good, '<!--[if mso]><table role="presentation" width="600"'), '600 px layout with an Outlook column');
$sec = notifyEmailHtml(['title' => 't', 'body' => 'b', 'lang' => 'en', 'category' => 'security']);
check(str_contains($sec, 'security message about your account'), 'security emails explain why they ignore preferences');

$txt = notifyEmailText([
    'title' => 'Seva confirmed', 'body' => 'Body with https://example.org/in-body link.', 'lang' => 'en', 'priority' => 'emergency',
    'cta_url' => '/account?tab=bookings', 'cta_label' => 'View booking', 'details' => [['Seva', 'Abhishekam']],
    'preferences_url' => 'https://temple.example/account?tab=notifications', 'unsubscribe_url' => 'https://temple.example/api/n/u/u12.abcdefghijklmnop',
]);
check(str_contains($txt, "View booking:\n" . siteUrl('/account?tab=bookings')), 'the plain text writes out the CTA URL');
check(str_contains($txt, 'https://example.org/in-body') && str_contains($txt, 'Seva: Abhishekam') && str_contains($txt, 'EMERGENCY NOTICE'), 'the plain text keeps body links, details and the banner');
check(str_contains($txt, 'Notification settings: https://temple.example/account?tab=notifications') && str_contains($txt, 'Unsubscribe from these emails: https://temple.example/api/n/u/'), 'the plain text writes out preference and unsubscribe links');
check(!str_contains(notifyEmailText(['title' => 't', 'body' => 'b', 'lang' => 'en', 'cta_url' => 'javascript:alert(1)']), 'javascript'), 'the plain text drops an unsafe CTA too');

/* ── 10. Previews for a visual check ────────────────────────────────────── */

$dir = 'C:/Users/nithp/AppData/Local/Temp/claude/email-previews';
if (!is_dir($dir)) @mkdir($dir, 0775, true);
$categories = ['booking' => ['ta' => 'சேவை பதிவு', 'en' => 'Booking'], 'security' => ['ta' => 'பாதுகாப்பு', 'en' => 'Security'], 'emergency' => ['ta' => 'அவசரம்', 'en' => 'Emergency']];
// The last flag is the unsubscribe link. SPEC §5.10 gives one only to
// informational and promotional emails; booking (transactional), security and
// emergency (critical) carry the preferences link alone, so the previews do too.
$previews = [
    ['booking_confirmed', 'ta', 'important', [['சேவை', 'அபிஷேகம்'], ['தேதி', '20 செப்டம்பர் 2026'], ['பதிவு எண்', 'SB-1042']], false],
    ['password_reset', 'en', 'urgent', [], false],
    ['emergency', 'en', 'emergency', [], false],
];
$written = 0;
foreach ($previews as [$pkey, $plang, $prio, $details, $unsubscribe]) {
    $sample = notifyTemplateSample($pkey, $plang);
    $rend   = notifyRender($pkey, $plang, 'email', $sample);
    $cat    = $defaults[$pkey]['category'];
    $p = [
        'title' => $rend['title'], 'body' => $rend['body'], 'lang' => $plang, 'priority' => $prio,
        'category' => $cat, 'category_label' => $categories[$cat][$plang],
        'cta_url' => $sample['ctaUrl'], 'cta_label' => $rend['cta_label'], 'details' => $details,
        'preferences_url' => siteUrl('/account?tab=notifications'),
        'unsubscribe_url' => $unsubscribe ? siteUrl('/api/n/u/u12.abcdefghijklmnop') : null,
        'open_pixel_url'  => siteUrl('/api/n/o/o34.abcdefghijklmnop'),
    ];
    $written += (int) (file_put_contents("$dir/$pkey-$plang.html", notifyEmailHtml($p)) > 0);
    file_put_contents("$dir/$pkey-$plang.txt", notifyEmailText($p));
}
check($written === 3, "three preview emails written to $dir");

$cleanup();
$left = (int) $db->query("SELECT COUNT(*) FROM notification_templates WHERE template_key LIKE 'e2e\\_tpl\\_%'")->fetchColumn();
check($left === 0, 'test template rows are cleaned up');

echo $failures ? "\n$passes passed, $failures FAILED\n" : "\nALL OK — $passes passed\n";
exit($failures ? 1 : 0);
