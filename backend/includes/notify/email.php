<?php
/**
 * backend/includes/notify/email.php — the branded email every notification
 * wears, and its plain-text twin.
 *
 * It extends the look of mailTemplate() in mailer.php (maroon header, gold
 * accent, warm off-white page) but is built for the constraints of real inboxes
 * rather than browsers:
 *
 *   • Table layout and inline styles only. Gmail strips <style> in many
 *     contexts and Outlook for Windows renders with Word, so nothing depends on
 *     a stylesheet, flexbox or a media query. The one conditional comment keeps
 *     Outlook from stretching the 600 px column across the whole window.
 *   • Solid colours with explicit bgcolor attributes and a light colour-scheme
 *     declaration. Clients that force dark mode invert light surfaces; every
 *     text/background pair here keeps at least 7:1 contrast either way, and no
 *     text sits on a gradient or image that inversion could wreck.
 *   • 16 px body text, 44 px tall button, the link written out under it for
 *     clients that block buttons or readers who prefer to copy.
 *   • Every dynamic value is escaped. URLs pass an http(s)-only check before
 *     they are ever put in an href; anything else is dropped, not "fixed".
 *
 * The plain-text part matters as much as the HTML: it is what screen readers in
 * some clients announce, what spam filters compare, and what a test reads the
 * verification link from.
 */

require_once __DIR__ . '/contracts.php';
require_once __DIR__ . '/defaults.php';

const NOTIFY_EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans Tamil','Nirmala UI',Latha,Helvetica,Arial,sans-serif";

/* ── Small helpers ──────────────────────────────────────────────────────── */

function notifyEmailEsc(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** Text as the devotee should see it: valid UTF-8, Unix newlines, no control characters but tab and newline. */
function notifyEmailCleanText(mixed $value): string
{
    if (is_array($value) || is_object($value) || $value === null) return '';
    $s = mb_scrub((string) $value, 'UTF-8');
    $s = str_replace(["\r\n", "\r"], "\n", $s);
    return (string) preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/', '', $s);
}

function notifyEmailOneLine(mixed $value): string
{
    return trim((string) preg_replace('/\s+/u', ' ', notifyEmailCleanText($value)));
}

/**
 * An absolute http(s) URL safe to place in an href or src, or null.
 *
 * A site path ("/account?tab=bookings", never "//host") becomes absolute with
 * siteUrl(), because a relative link in an email has nothing to be relative to.
 * javascript:, data:, protocol-relative and anything with whitespace, control
 * characters or backslashes is refused outright.
 */
function notifyEmailSafeUrl(mixed $url): ?string
{
    if (!is_string($url)) return null;
    $u = trim($url);
    if ($u === '' || strlen($u) > 2000 || preg_match('/[\x00-\x20\x7F\\\\]/', $u)) return null;
    if ($u[0] === '/') {
        if (str_starts_with($u, '//')) return null;
        $u = siteUrl($u);
    }
    $parts = parse_url($u);
    if (!is_array($parts) || empty($parts['host'])) return null;
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    if ($scheme !== 'http' && $scheme !== 'https') return null;
    if (isset($parts['user']) || isset($parts['pass'])) return null; // https://site.org@evil.example/ reads as the temple
    return $u;
}

/** A BCP 47-ish language code for the lang attribute; Tamil when the value is not one. */
function notifyEmailLangAttr(mixed $lang): string
{
    $l = is_string($lang) ? trim($lang) : '';
    return preg_match('/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/', $l) ? $l : 'ta';
}

/** The words around a message (banner, footer, link hints), in Tamil or English. */
function notifyEmailCopy(string $lang): array
{
    $ta = [
        'emergency'     => 'அவசர அறிவிப்பு',
        'emergencySub'  => 'உடனே படிக்கவும்',
        'urgent'        => 'உடனடி கவனம் தேவை',
        'urgentSub'     => 'இந்தச் செய்தி உங்கள் கவனத்திற்கு உடனே தேவைப்படுகிறது',
        'ctaFallback'   => 'பொத்தான் வேலை செய்யவில்லை என்றால், இந்த இணைப்பை நகலெடுத்து உங்கள் உலாவியில் திறக்கவும்:',
        'defaultCta'    => 'விவரங்களைப் பார்க்க',
        'details'       => 'விவரங்கள்',
        'help'          => 'உதவி தேவையா?',
        'call'          => 'கோயில் அலுவலகத்தை அழைக்க:',
        'write'         => 'மின்னஞ்சல்:',
        'why'           => '%s இணையதளத்தில் உங்களுக்குக் கணக்கு இருப்பதாலோ, கோயில் உங்களைத் தொடர்பு கொள்ள நீங்கள் கேட்டதாலோ இந்தச் செய்தி அனுப்பப்பட்டது.',
        'whySecurity'   => 'இது உங்கள் கணக்கின் பாதுகாப்பு பற்றிய செய்தி. பிற மின்னஞ்சல்களை நிறுத்தியிருந்தாலும் இது அனுப்பப்படும்.',
        'whyEmergency'  => 'இது கோயிலின் அவசர அறிவிப்பு. பக்தர்களின் பாதுகாப்பிற்காக, பிற அறிவிப்புகளை நிறுத்தியிருந்தாலும் இது அனுப்பப்படும்.',
        'prefs'         => 'அறிவிப்பு அமைப்புகள்',
        'unsubscribe'   => 'இந்த மின்னஞ்சல்களை நிறுத்த',
    ];
    $en = [
        'emergency'     => 'Emergency notice',
        'emergencySub'  => 'Please read this now',
        'urgent'        => 'Urgent',
        'urgentSub'     => 'This message needs your attention now',
        'ctaFallback'   => 'If the button does not work, copy this link into your browser:',
        'defaultCta'    => 'View details',
        'details'       => 'Details',
        'help'          => 'Need help?',
        'call'          => 'Call the temple office:',
        'write'         => 'Email:',
        'why'           => 'You are receiving this because you have an account on the %s website, or asked the temple to contact you.',
        'whySecurity'   => 'This is a security message about your account. It is sent even when other emails are turned off.',
        'whyEmergency'  => 'This is an emergency notice from the temple. For the safety of devotees it is sent even when other notifications are turned off.',
        'prefs'         => 'Notification settings',
        'unsubscribe'   => 'Unsubscribe from these emails',
    ];
    return $lang === 'ta' ? $ta : $en;
}

/**
 * One line of plain text as HTML, with http(s) URLs turned into links.
 *
 * The text is split around each URL and every piece is escaped on its own, so
 * nothing in the text can become markup. Only ASCII URL characters are matched
 * (a Tamil word written straight after a link is not swallowed into it), and
 * trailing sentence punctuation stays outside the link.
 */
function notifyEmailLinkify(string $line, string $linkColour = '#8a2c0d'): string
{
    if (!preg_match_all('~https?://[A-Za-z0-9\-._\~:/?#\[\]@!$&()*+,;=%]+~i', $line, $m, PREG_OFFSET_CAPTURE)) {
        return notifyEmailEsc($line);
    }
    $html = '';
    $pos  = 0;
    foreach ($m[0] as [$url, $offset]) {
        // Punctuation that ends a sentence, and a closing bracket the URL did not open.
        while ($url !== '') {
            $last = substr($url, -1);
            if (strpbrk($last, '.,;:!?') !== false
                || ($last === ')' && substr_count($url, '(') < substr_count($url, ')'))
                || ($last === ']' && substr_count($url, '[') < substr_count($url, ']'))) {
                $url = substr($url, 0, -1);
                continue;
            }
            break;
        }
        $safe = notifyEmailSafeUrl($url);
        $html .= notifyEmailEsc(substr($line, $pos, $offset - $pos));
        $html .= $safe === null
            ? notifyEmailEsc($url)
            : '<a href="' . notifyEmailEsc($safe) . '" target="_blank" style="color:' . $linkColour . ';text-decoration:underline;word-break:break-all">' . notifyEmailEsc($url) . '</a>';
        $pos = $offset + strlen($url);
    }
    return $html . notifyEmailEsc(substr($line, $pos));
}

/** Plain text body → paragraphs. A blank line starts a paragraph; a single newline is a line break. */
function notifyEmailParagraphs(string $body): string
{
    $body = trim($body);
    if ($body === '') return '';
    $html = '';
    foreach (preg_split("/\n[ \t]*\n+/", $body) as $para) {
        $lines = array_map(static fn($l) => notifyEmailLinkify(rtrim($l)), explode("\n", trim($para, "\n")));
        $html .= '<p style="margin:0 0 16px;font-family:' . NOTIFY_EMAIL_FONT . ';font-size:16px;line-height:1.65;color:#3a1a1a">'
               . implode('<br />', $lines) . '</p>';
    }
    return $html;
}

/** [[label, value], …] with malformed rows dropped. */
function notifyEmailDetails(mixed $details): array
{
    $rows = [];
    foreach (is_array($details) ? $details : [] as $row) {
        if (!is_array($row)) continue;
        $row = array_values($row);
        if (count($row) < 2 || is_array($row[0]) || is_array($row[1]) || is_object($row[0]) || is_object($row[1])) continue;
        $label = notifyEmailOneLine($row[0]);
        $value = trim(notifyEmailCleanText($row[1]));
        if ($label === '' && $value === '') continue;
        $rows[] = [$label, $value];
    }
    return $rows;
}

/** Contact lines: the caller's, else the temple office's number and address from the facts. */
function notifyEmailContact(array $p, string $lang): array
{
    $facts = notifyTempleFacts();
    $given = $p['contact'] ?? null;
    $c = is_array($given)
        ? $given
        : ['phone' => $facts['supportPhone'], 'address' => $facts['address'][$lang]];

    $phone = notifyEmailOneLine($c['phone'] ?? '');
    $digits = preg_replace('/[^\d+]/', '', $phone) ?? '';
    $email = notifyEmailOneLine($c['email'] ?? '');
    return [
        'phone'     => $phone,
        'phoneHref' => preg_match('/^\+?\d{7,15}$/', $digits) ? 'tel:' . $digits : null,
        'phoneShow' => $phone !== '' && $phone === $facts['supportPhone'] ? $facts['supportPhoneDisplay'] : $phone,
        'email'     => filter_var($email, FILTER_VALIDATE_EMAIL) ? $email : '',
        'address'   => notifyEmailOneLine($c['address'] ?? ''),
    ];
}

/** Why this devotee receives this email, in their language. */
function notifyEmailWhy(array $p, string $lang, string $templeName, array $copy): string
{
    $note = notifyEmailOneLine($p['footer_note'] ?? '');
    if ($note !== '') return $note;
    $category = (string) ($p['category'] ?? '');
    if ($category === 'security') return $copy['whySecurity'];
    if ($category === 'emergency' || ($p['priority'] ?? '') === 'emergency') return $copy['whyEmergency'];
    return sprintf($copy['why'], $templeName);
}

/* ── The HTML email ─────────────────────────────────────────────────────── */

/**
 * The branded HTML email. Keys of $p (all optional except title and body):
 *
 *   title, body (plain text; a blank line starts a paragraph, a newline is a
 *   line break, URLs become links), lang, preheader, category_label, priority
 *   (normal|important|urgent|emergency — urgent and emergency show a banner),
 *   cta_url (http(s) or a site path; anything else means no button), cta_label,
 *   details ([[label, value], …]), logo_url (default: the site icon), contact
 *   (['phone','email','address']; default: the temple office), preferences_url,
 *   unsubscribe_url (the link appears only when given), open_pixel_url (the
 *   image appears only when given).
 *
 * Two extra keys tune the footer: category (a category key — security and
 * emergency explain why the message ignored the devotee's settings) and
 * footer_note (replaces the explanation entirely).
 */
function notifyEmailHtml(array $p): string
{
    $langAttr   = notifyEmailLangAttr($p['lang'] ?? 'ta');
    $l          = strtolower(substr($langAttr, 0, 2)) === 'ta' ? 'ta' : 'en';
    $copy       = notifyEmailCopy($l);
    $facts      = notifyTempleFacts();
    $templeName = $facts['name'][$l];
    $descriptor = $facts['descriptor'][$l];

    $title     = notifyEmailOneLine($p['title'] ?? '');
    $body      = trim(notifyEmailCleanText($p['body'] ?? ''));
    $priority  = in_array($p['priority'] ?? null, NOTIFY_PRIORITIES, true) ? $p['priority'] : 'normal';
    $category  = notifyEmailOneLine($p['category_label'] ?? '');
    $preheader = notifyEmailOneLine($p['preheader'] ?? '');
    if ($preheader === '') $preheader = mb_substr(notifyEmailOneLine($body), 0, 140);

    $logo    = notifyEmailSafeUrl($p['logo_url'] ?? null) ?? siteUrl('/icons/icon-192x192.png');
    $ctaUrl  = notifyEmailSafeUrl($p['cta_url'] ?? null);
    $ctaText = notifyEmailOneLine($p['cta_label'] ?? '');
    if ($ctaText === '') $ctaText = $copy['defaultCta'];
    $prefs   = notifyEmailSafeUrl($p['preferences_url'] ?? null);
    $unsub   = notifyEmailSafeUrl($p['unsubscribe_url'] ?? null);
    $pixel   = notifyEmailSafeUrl($p['open_pixel_url'] ?? null);
    $details = notifyEmailDetails($p['details'] ?? []);
    $contact = notifyEmailContact($p, $l);
    $why     = notifyEmailWhy($p, $l, $templeName, $copy);
    $e       = 'notifyEmailEsc';
    $font    = 'font-family:' . NOTIFY_EMAIL_FONT . ';';

    // ── Header band: logo, the clan-deity descriptor in gold, the temple's name.
    $header = '<tr><td bgcolor="#5a0e0e" style="background:#5a0e0e;padding:20px 24px">'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
        . '<td width="56" valign="middle" style="width:56px;padding:0 14px 0 0">'
        . '<img src="' . $e($logo) . '" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border:0;border-radius:12px;background:#ffffff" />'
        . '</td>'
        . '<td valign="middle" style="' . $font . '">'
        . '<div style="' . $font . 'font-size:13px;line-height:1.5;color:#f5d37a;letter-spacing:0.3px">' . $e($descriptor) . '</div>'
        // The Tamil name is twice as long as the English one; at 17 px it takes four lines on a phone.
        . '<div style="' . $font . 'font-size:' . ($l === 'ta' ? '15px' : '17px') . ';line-height:1.4;font-weight:700;color:#ffffff;margin-top:2px">' . $e($templeName) . '</div>'
        . '</td></tr></table></td></tr>';

    // ── Priority banner. Emergency is loud on purpose; urgent is firm but calm.
    $banner = '';
    if ($priority === 'emergency') {
        $banner = '<tr><td bgcolor="#b91c1c" style="background:#b91c1c;padding:14px 24px;' . $font . '" role="alert">'
            . '<div style="' . $font . 'font-size:17px;line-height:1.4;font-weight:700;color:#ffffff;text-transform:none">&#9888;&#65039; ' . $e($copy['emergency']) . '</div>'
            . '<div style="' . $font . 'font-size:14px;line-height:1.5;color:#ffffff;margin-top:2px">' . $e($copy['emergencySub']) . '</div>'
            . '</td></tr>';
    } elseif ($priority === 'urgent') {
        $banner = '<tr><td bgcolor="#fff4d6" style="background:#fff4d6;border-left:6px solid #b45309;padding:12px 18px;' . $font . '" role="alert">'
            . '<div style="' . $font . 'font-size:16px;line-height:1.4;font-weight:700;color:#6b2508">' . $e($copy['urgent']) . '</div>'
            . '<div style="' . $font . 'font-size:14px;line-height:1.5;color:#6b2508;margin-top:2px">' . $e($copy['urgentSub']) . '</div>'
            . '</td></tr>';
    }

    // ── Title and body.
    $main = '<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:28px 24px 8px">';
    if ($category !== '') {
        $main .= '<div style="' . $font . 'font-size:13px;line-height:1.4;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;color:#9a3412;margin:0 0 8px">' . $e($category) . '</div>';
    }
    // Tamil glyphs are wider than Latin ones; at 24 px a Tamil title takes three lines on a phone.
    $main .= '<h1 style="' . $font . 'font-size:' . ($l === 'ta' ? '22px' : '24px') . ';line-height:1.35;font-weight:700;color:#2a0a0a;margin:0 0 18px">' . $e($title) . '</h1>'
        . notifyEmailParagraphs($body);

    // ── Details table.
    if ($details) {
        $main .= '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fdf7ef" style="background:#fdf7ef;border:1px solid #eadbc8;border-radius:12px;margin:4px 0 20px;border-collapse:separate">';
        $n = count($details);
        foreach ($details as $i => [$label, $value]) {
            $border = $i < $n - 1 ? 'border-bottom:1px solid #eadbc8;' : '';
            $valueHtml = implode('<br />', array_map('notifyEmailLinkify', explode("\n", $value)));
            $main .= '<tr>'
                . '<td valign="top" width="38%" style="' . $border . $font . 'width:38%;padding:12px 8px 12px 16px;font-size:14px;line-height:1.5;color:#6b4a3f">' . $e($label) . '</td>'
                . '<td valign="top" style="' . $border . $font . 'padding:12px 16px 12px 8px;font-size:16px;line-height:1.5;font-weight:600;color:#2a0a0a;word-break:break-word">' . $valueHtml . '</td>'
                . '</tr>';
        }
        $main .= '</table>';
    }

    // ── Call to action. The written-out link is skipped when the body already
    //    shows the same URL on its own line (verification and reset emails).
    if ($ctaUrl !== null) {
        $main .= '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px"><tr>'
            . '<td align="center" bgcolor="#991b1b" style="background:#991b1b;border-radius:999px">'
            . '<a href="' . $e($ctaUrl) . '" target="_blank" style="display:inline-block;' . $font . 'font-size:16px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;padding:12px 28px;border:1px solid #991b1b;border-radius:999px">'
            . $e($ctaText) . '</a></td></tr></table>';
        // Compared line by line against the absolute URL: a substring test would
        // let a CTA of "/" (or any short path) hide the fallback behind any body
        // that happens to contain a slash.
        $bodyLines = array_map('trim', explode("\n", $body));
        if (!in_array($ctaUrl, $bodyLines, true) && !in_array(trim((string) ($p['cta_url'] ?? '')), $bodyLines, true)) {
            $main .= '<p style="' . $font . 'font-size:14px;line-height:1.6;color:#5e4a42;margin:0 0 20px">' . $e($copy['ctaFallback']) . '<br />'
                . '<a href="' . $e($ctaUrl) . '" target="_blank" style="color:#8a2c0d;text-decoration:underline;word-break:break-all">' . $e($ctaUrl) . '</a></p>';
        }
    }
    $main .= '</td></tr>';

    // ── Contact block.
    $contactHtml = '';
    if ($contact['phone'] !== '' || $contact['email'] !== '' || $contact['address'] !== '') {
        $lines = [];
        if ($contact['phone'] !== '') {
            $lines[] = $e($copy['call']) . ' ' . ($contact['phoneHref']
                ? '<a href="' . $e($contact['phoneHref']) . '" style="color:#8a2c0d;text-decoration:underline;white-space:nowrap">' . $e($contact['phoneShow']) . '</a>'
                : $e($contact['phoneShow']));
        }
        if ($contact['email'] !== '') {
            $lines[] = $e($copy['write']) . ' <a href="mailto:' . $e($contact['email']) . '" style="color:#8a2c0d;text-decoration:underline;word-break:break-all">' . $e($contact['email']) . '</a>';
        }
        if ($contact['address'] !== '') $lines[] = $e($contact['address']);
        $contactHtml = '<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:0 24px 24px">'
            . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
            . '<td style="border-top:1px solid #eadbc8;padding:18px 0 0;' . $font . '">'
            . '<div style="' . $font . 'font-size:15px;line-height:1.5;font-weight:700;color:#2a0a0a;margin:0 0 4px">' . $e($copy['help']) . '</div>'
            . '<div style="' . $font . 'font-size:15px;line-height:1.7;color:#3a1a1a">' . implode('<br />', $lines) . '</div>'
            . '</td></tr></table></td></tr>';
    }

    // ── Footer: why this arrived, and how to change it.
    $links = [];
    if ($prefs !== null) {
        $links[] = '<a href="' . $e($prefs) . '" target="_blank" style="color:#8a2c0d;text-decoration:underline">' . $e($copy['prefs']) . '</a>';
    }
    if ($unsub !== null) {
        $links[] = '<a href="' . $e($unsub) . '" target="_blank" style="color:#8a2c0d;text-decoration:underline">' . $e($copy['unsubscribe']) . '</a>';
    }
    $footer = '<tr><td bgcolor="#fbf5ec" style="background:#fbf5ec;border-top:1px solid #eadbc8;padding:18px 24px 22px;' . $font . '">'
        . '<p style="' . $font . 'font-size:14px;line-height:1.6;color:#5e4a42;margin:0">' . $e($why) . '</p>'
        . ($links ? '<p style="' . $font . 'font-size:14px;line-height:1.6;color:#5e4a42;margin:10px 0 0">' . implode(' &nbsp;&middot;&nbsp; ', $links) . '</p>' : '')
        . '<p style="' . $font . 'font-size:13px;line-height:1.6;color:#5e4a42;margin:10px 0 0">' . $e($facts['trust'][$l]) . '</p>'
        . '</td></tr>';

    // The hidden preheader is padded with invisible characters so the inbox
    // preview does not run on into the header text after it.
    $preheaderHtml = '<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:#f6eee2">'
        . $e($preheader) . str_repeat('&#847;&zwnj;&nbsp;', 60) . '</div>';

    $pixelHtml = $pixel !== null
        ? '<img src="' . $e($pixel) . '" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0" />'
        : '';

    return '<!DOCTYPE html>'
        . '<html lang="' . $e($langAttr) . '" dir="ltr" xmlns="http://www.w3.org/1999/xhtml">'
        . '<head><meta charset="utf-8" />'
        . '<meta name="viewport" content="width=device-width,initial-scale=1" />'
        . '<meta http-equiv="X-UA-Compatible" content="IE=edge" />'
        . '<meta name="x-apple-disable-message-reformatting" />'
        . '<meta name="format-detection" content="telephone=no,address=no,email=no,date=no" />'
        . '<meta name="color-scheme" content="light" /><meta name="supported-color-schemes" content="light" />'
        . '<title>' . $e($title) . '</title></head>'
        . '<body style="margin:0;padding:0;background:#f6eee2;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">'
        . $preheaderHtml
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6eee2" style="background:#f6eee2">'
        . '<tr><td align="center" style="padding:24px 12px">'
        . '<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->'
        . '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #eadbc8;border-radius:16px;overflow:hidden;border-collapse:separate">'
        . $header . $banner . $main . $contactHtml . $footer
        . '</table>'
        . '<!--[if mso]></td></tr></table><![endif]-->'
        . '</td></tr></table>'
        . $pixelHtml
        . '</body></html>';
}

/* ── The plain-text email ───────────────────────────────────────────────── */

/**
 * The plain-text alternative of notifyEmailHtml(), from the same $p. Every link
 * is written out in full: there is no markup to hide one behind.
 */
function notifyEmailText(array $p): string
{
    $langAttr = notifyEmailLangAttr($p['lang'] ?? 'ta');
    $l        = strtolower(substr($langAttr, 0, 2)) === 'ta' ? 'ta' : 'en';
    $copy     = notifyEmailCopy($l);
    $facts    = notifyTempleFacts();
    $priority = in_array($p['priority'] ?? null, NOTIFY_PRIORITIES, true) ? $p['priority'] : 'normal';

    $out   = [];
    $out[] = $facts['name'][$l];
    $out[] = '';
    if ($priority === 'emergency') {
        $out[] = '*** ' . mb_strtoupper($copy['emergency']) . ' — ' . $copy['emergencySub'] . ' ***';
        $out[] = '';
    } elseif ($priority === 'urgent') {
        $out[] = '*** ' . $copy['urgent'] . ' — ' . $copy['urgentSub'] . ' ***';
        $out[] = '';
    }
    $category = notifyEmailOneLine($p['category_label'] ?? '');
    if ($category !== '') $out[] = '[' . $category . ']';
    $out[] = notifyEmailOneLine($p['title'] ?? '');
    $out[] = '';

    $body = trim(notifyEmailCleanText($p['body'] ?? ''));
    if ($body !== '') {
        $out[] = $body;
        $out[] = '';
    }

    $details = notifyEmailDetails($p['details'] ?? []);
    if ($details) {
        foreach ($details as [$label, $value]) {
            $out[] = ($label !== '' ? $label . ': ' : '') . str_replace("\n", "\n  ", $value);
        }
        $out[] = '';
    }

    $ctaUrl = notifyEmailSafeUrl($p['cta_url'] ?? null);
    if ($ctaUrl !== null) {
        $label = notifyEmailOneLine($p['cta_label'] ?? '');
        $out[] = ($label !== '' ? $label : $copy['defaultCta']) . ':';
        $out[] = $ctaUrl;
        $out[] = '';
    }

    $contact = notifyEmailContact($p, $l);
    if ($contact['phone'] !== '' || $contact['email'] !== '' || $contact['address'] !== '') {
        $out[] = $copy['help'];
        if ($contact['phone'] !== '') $out[] = $copy['call'] . ' ' . $contact['phoneShow'];
        if ($contact['email'] !== '') $out[] = $copy['write'] . ' ' . $contact['email'];
        if ($contact['address'] !== '') $out[] = $contact['address'];
        $out[] = '';
    }

    $out[] = '--';
    $out[] = notifyEmailWhy($p, $l, $facts['name'][$l], $copy);
    $prefs = notifyEmailSafeUrl($p['preferences_url'] ?? null);
    if ($prefs !== null) $out[] = $copy['prefs'] . ': ' . $prefs;
    $unsub = notifyEmailSafeUrl($p['unsubscribe_url'] ?? null);
    if ($unsub !== null) $out[] = $copy['unsubscribe'] . ': ' . $unsub;
    $out[] = $facts['trust'][$l];

    return implode("\n", $out) . "\n";
}
