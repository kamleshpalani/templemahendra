<?php
/**
 * backend/api/n.php — the links inside a notification that are not the site
 * itself: tracked clicks, the email open pixel, and one-click unsubscribe
 * (docs/notifications/SPEC.md §6.2).
 *
 * api/index.php routes /api/n/<c|o|u>/<token> here with $trackKind and
 * $trackToken, and only when the token has the right shape. Whether it is
 * genuine is decided here, by notifyTokenVerify().
 *
 *   GET  /api/n/c/<token>  record the click, 302 to the notification's link
 *   GET  /api/n/o/<token>  record the open, answer a 1×1 GIF
 *   GET  /api/n/u/<token>  a page explaining unsubscribing, with a button
 *   POST /api/n/u/<token>  unsubscribe (the button, or RFC 8058 one-click)
 *
 * These are opened from inboxes, not from the site, so the rules differ from
 * the JSON API:
 *   • Never an error a person has to decode. A bad click link still lands on
 *     the home page; a bad pixel is still a picture.
 *   • GET never changes anything that matters. Mail scanners and link
 *     previewers fetch every URL in a message; if a GET unsubscribed, a
 *     corporate virus scanner would unsubscribe the devotee on delivery.
 *     Clicks and opens are only statistics, so a GET may record those.
 *   • No JavaScript, no cookies, no CSRF. The token itself proves the link came
 *     from the email, and RFC 8058 one-click posts arrive from the mail
 *     provider's servers with no session at all.
 *   • The token must not travel further than this request: Referrer-Policy
 *     no-referrer keeps it out of the Referer header of whatever is opened next.
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/notify.php';

// Whatever goes wrong, a devotee must never see a stack trace on these pages.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

/** A transparent 1×1 GIF89a, the smallest image every mail client renders. */
const N_PIXEL_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

$kind   = isset($trackKind) && is_string($trackKind) ? $trackKind : '';
$token  = isset($trackToken) && is_string($trackToken) ? $trackToken : '';
$method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));

header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
header('X-Content-Type-Options: nosniff');

if (!in_array($kind, ['c', 'o', 'u'], true)) {
    http_response_code(404);
    header('Content-Type: application/json; charset=utf-8');
    echo '{"error":"Not found"}';
    exit;
}

/*
 * ['kind' => …, 'id' => int] when the token is genuine AND was issued for this
 * kind of link. An open token pasted into a click URL is not a click.
 */
$verified = null;
try {
    if (notifyTablesExist()) {
        $t = notifyTokenVerify($token);
        if ($t !== null && $t['kind'] === $kind) $verified = $t;
    }
} catch (Throwable $e) {
    error_log('[notify-link] token check failed: ' . get_class($e) . ': ' . $e->getMessage());
}

match ($kind) {
    'c' => nClick($verified, $method),
    'o' => nOpen($verified, $method),
    'u' => nUnsubscribe($verified, $method, $token),
};

/* ── Click ──────────────────────────────────────────────────────────────── */

function nClick(?array $verified, string $method): never
{
    if ($method !== 'GET' && $method !== 'HEAD') nMethodNotAllowed('GET, HEAD');

    $target = siteUrl('/');
    if ($verified !== null) {
        try {
            $stmt = getDB()->prepare(
                'SELECT n.cta_url
                   FROM notification_deliveries d
                   JOIN notifications n ON n.id = d.notification_id
                  WHERE d.id = :id'
            );
            $stmt->execute([':id' => $verified['id']]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row) {
                // A HEAD is a link checker asking whether the URL works, not a person.
                if ($method === 'GET') notifyRecordClick($verified['id']);
                // Checked again here: this value becomes a Location header.
                $safe = notifySafeCtaUrl($row['cta_url'] ?? null);
                if ($safe !== null) $target = $safe[0] === '/' ? siteUrl($safe) : $safe;
            }
        } catch (Throwable $e) {
            error_log('[notify-link] click failed: ' . get_class($e) . ': ' . $e->getMessage());
        }
    }

    http_response_code(302);
    header('Cache-Control: no-store, private');
    header('Location: ' . $target);
    exit;
}

/* ── Open pixel ─────────────────────────────────────────────────────────── */

function nOpen(?array $verified, string $method): never
{
    if ($method !== 'GET' && $method !== 'HEAD') nMethodNotAllowed('GET, HEAD');

    if ($verified !== null && $method === 'GET') {
        notifyRecordOpen($verified['id']); // never throws
    }

    // Every request gets the same picture: a broken-image icon in the email
    // would tell the reader nothing useful, and a different answer for a bad
    // token would tell a prober which tokens are real.
    $gif = base64_decode(N_PIXEL_GIF_BASE64);
    http_response_code(200);
    header('Content-Type: image/gif');
    header('Content-Length: ' . strlen($gif));
    // Cached copies would hide every open after the first.
    header('Cache-Control: no-store, private, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    echo $gif;
    exit;
}

/* ── Unsubscribe ────────────────────────────────────────────────────────── */

function nUnsubscribe(?array $verified, string $method, string $token): never
{
    if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) nMethodNotAllowed('GET, HEAD, POST');

    try {
        if (!notifyTablesExist()) nPage(503, 'unavailable');
        if ($verified === null) nPage(404, 'invalid');

        $stmt = getDB()->prepare('SELECT id, email FROM devotees WHERE id = :id');
        $stmt->execute([':id' => $verified['id']]);
        $devotee = $stmt->fetch(PDO::FETCH_ASSOC);
        // The account was deleted: there is nothing left to unsubscribe.
        if (!$devotee) nPage(404, 'invalid');

        $masked = notifyRedact((string) ($devotee['email'] ?? ''), 190);
        $action = '/api/n/u/' . $token;

        if ($method === 'POST') {
            // Unsubscribed = no optional (informational or promotional) email. The
            // email switch itself stays on, because it also carries booking
            // confirmations, receipts and security messages, which this devotee
            // still needs. notifySavePrefs keeps the first unsubscribe time, so a
            // second POST (a mail provider retrying) changes nothing.
            notifySavePrefs((int) $devotee['id'], ['unsubscribed' => true]);
            nPage(200, 'done', ['email' => $masked]);
        }

        $already = notifyPrefs((int) $devotee['id'])['unsubscribed'];
        nPage(200, $already ? 'already' : 'confirm', ['email' => $masked, 'action' => $action]);
    } catch (Throwable $e) {
        error_log('[notify-link] unsubscribe failed: ' . get_class($e) . ': ' . $e->getMessage());
        nPage(500, 'error');
    }
}

function nMethodNotAllowed(string $allow): never
{
    http_response_code(405);
    header('Allow: ' . $allow);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    echo 'Method not allowed';
    exit;
}

/**
 * The words for each state of the unsubscribe page, Tamil first as on the site.
 * {email} is the masked address ("k***@example.org"), so someone reading a
 * shared inbox can tell which account the link belongs to.
 */
function nCopy(string $state): array
{
    $keepTa = 'சேவை பதிவு உறுதிப்படுத்தல்கள், நன்கொடை ரசீதுகள், கணக்குப் பாதுகாப்புச் செய்திகள் தொடர்ந்து மின்னஞ்சலில் வரும். இணையதள அறிவிப்புகள், வாட்ஸ்அப், குறுஞ்செய்தி அமைப்புகள் மாறாது.';
    $keepEn = 'Booking confirmations, donation receipts and account security emails will still reach you. Notifications on the website, WhatsApp and SMS are not changed.';

    return match ($state) {
        'confirm' => [
            'title' => ['ta' => 'விருப்ப மின்னஞ்சல்களை நிறுத்தவா?', 'en' => 'Stop optional emails from the temple?'],
            'ta'    => ['கோயில் அறிவிப்புகள், திருவிழா, பூஜை, நிகழ்வுச் செய்திகள் போன்ற விருப்ப மின்னஞ்சல்கள் {email} முகவரிக்கு இனி அனுப்பப்படாது.', $keepTa],
            'en'    => ['Temple announcements and news about festivals, poojas and events will no longer be emailed to {email}.', $keepEn],
            'button' => ['ta' => 'மின்னஞ்சல்களை நிறுத்து', 'en' => 'Unsubscribe'],
            'link'   => ['ta' => 'அல்லது எவை வேண்டும் என்று தேர்ந்தெடுங்கள்', 'en' => 'Or choose exactly what you receive'],
        ],
        'already' => [
            'title' => ['ta' => 'நீங்கள் ஏற்கனவே விலகியுள்ளீர்கள்', 'en' => 'You are already unsubscribed'],
            'ta'    => ['{email} முகவரிக்கு விருப்ப மின்னஞ்சல்கள் அனுப்பப்படுவதில்லை.', $keepTa],
            'en'    => ['Optional emails are not being sent to {email}.', $keepEn],
            'link'  => ['ta' => 'மின்னஞ்சல்களை மீண்டும் பெற, அறிவிப்பு அமைப்புகளைத் திறக்கவும்', 'en' => 'To receive them again, open your notification settings'],
        ],
        'done' => [
            'title' => ['ta' => 'விலகல் உறுதிசெய்யப்பட்டது', 'en' => 'You have been unsubscribed'],
            'ta'    => ['{email} முகவரிக்கு இனி விருப்ப மின்னஞ்சல்கள் அனுப்பப்படாது.', $keepTa],
            'en'    => ['No more optional emails will be sent to {email}.', $keepEn],
            'link'  => ['ta' => 'மனம் மாறினால், அறிவிப்பு அமைப்புகளில் மீண்டும் இயக்கலாம்', 'en' => 'Changed your mind? Turn them back on in your notification settings'],
        ],
        'invalid' => [
            'title' => ['ta' => 'இந்த இணைப்பு செல்லாது', 'en' => 'This link is not valid'],
            'ta'    => ['இணைப்பு முழுமையாக இல்லாமல் இருக்கலாம், அல்லது அந்தக் கணக்கு மூடப்பட்டிருக்கலாம். உள்நுழைந்த பின் அறிவிப்பு அமைப்புகளில் மின்னஞ்சல்களை நிர்வகிக்கலாம்.'],
            'en'    => ['The link may be incomplete, or the account it belonged to has been closed. After signing in, you can manage emails in your notification settings.'],
            'link'  => ['ta' => 'அறிவிப்பு அமைப்புகள்', 'en' => 'Notification settings'],
        ],
        'unavailable' => [
            'title' => ['ta' => 'மின்னஞ்சல் அமைப்புகள் இப்போது கிடைக்கவில்லை', 'en' => 'Email settings are not available right now'],
            'ta'    => ['சிறிது நேரம் கழித்து மீண்டும் முயலுங்கள், அல்லது கோயில் அலுவலகத்தைத் தொடர்பு கொள்ளுங்கள்.'],
            'en'    => ['Please try again later, or contact the temple office.'],
        ],
        default => [
            'title' => ['ta' => 'ஏதோ தவறு நடந்தது', 'en' => 'Something went wrong'],
            'ta'    => ['உங்கள் தேர்வைச் சேமிக்க முடியவில்லை. சிறிது நேரத்தில் மீண்டும் முயலுங்கள்.'],
            'en'    => ['Your choice could not be saved. Please try again in a moment.'],
        ],
    };
}

/**
 * A small, complete page in the site's colours. Inline CSS only, no script, no
 * external request: it must render in the in-app browser of a mail client on a
 * slow connection, and it has nothing to do but explain and offer one button.
 */
function nPage(int $status, string $state, array $ctx = []): never
{
    $h     = static fn(string $v): string => htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $copy  = nCopy($state);
    $email = (string) ($ctx['email'] ?? '');
    $fill  = static fn(string $text): string => str_replace(
        '{email}',
        '<strong class="addr">' . $h($email !== '' ? $email : '—') . '</strong>',
        $h($text)
    );

    $facts   = function_exists('notifyTempleFacts') ? notifyTempleFacts() : [];
    $nameTa  = (string) ($facts['name']['ta'] ?? 'அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்');
    $nameEn  = (string) ($facts['name']['en'] ?? 'Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple');
    $prefs   = siteUrl('/account?tab=notifications');
    $home    = siteUrl('/');

    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store, private');
    // Nothing on this page loads from anywhere; the form posts back to this site.
    header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");

    $paras = static function (array $lines) use ($fill): string {
        $out = '';
        foreach ($lines as $line) $out .= '<p>' . $fill($line) . '</p>';
        return $out;
    };
    ?>
<!doctype html>
<html lang="ta">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title><?= $h($copy['title']['en']) ?> — <?= $h($nameEn) ?></title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; padding: 24px 16px; min-height: 100vh;
    background: #fffbf5; color: #3d1111;
    font: 16px/1.65 -apple-system, "Segoe UI", Roboto, "Noto Sans Tamil", "Latha", Helvetica, Arial, sans-serif;
    display: flex; align-items: flex-start; justify-content: center;
  }
  main {
    width: 100%; max-width: 560px; background: #ffffff; overflow: hidden;
    border: 1px solid rgba(153, 27, 27, 0.14); border-radius: 16px;
    box-shadow: 0 10px 30px rgba(61, 7, 7, 0.08);
  }
  .band { background: linear-gradient(135deg, #1a0606, #3d0a0a); padding: 22px 24px; }
  .band p { margin: 0; overflow-wrap: anywhere; }
  .temple-ta { color: #fde68a; font-size: 14px; line-height: 1.5; }
  .temple-en { color: #ffffff; font-size: 13px; opacity: 0.92; margin-top: 4px !important; }
  .content { padding: 26px 24px 28px; }
  h1 { margin: 0 0 18px; font-size: 22px; line-height: 1.35; color: #5c0d0d; }
  h1 span { display: block; }
  h1 .en { font-size: 18px; color: #7a1414; margin-top: 4px; }
  .lang { padding: 0; margin: 0 0 14px; }
  .lang + .lang { border-top: 1px solid rgba(153, 27, 27, 0.1); padding-top: 14px; }
  .lang p { margin: 0 0 10px; }
  .addr { overflow-wrap: anywhere; }
  form { margin: 22px 0 8px; }
  button {
    display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 2px 8px;
    min-height: 48px; width: 100%; padding: 12px 22px; border: 0; border-radius: 999px;
    background: #991b1b; color: #ffffff; font: inherit; font-weight: 700; cursor: pointer;
  }
  button:hover { background: #7a1414; }
  button:focus-visible, a:focus-visible { outline: 3px solid #d97706; outline-offset: 3px; }
  .links { margin: 18px 0 0; font-size: 15px; }
  .links a { color: #92400e; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
  .links span { display: block; margin-top: 8px; }
  .home { margin-top: 20px !important; font-size: 14px; color: #6b4447; }
  @media (min-width: 480px) {
    body { padding: 48px 24px; }
    .band { padding: 24px 30px; }
    .content { padding: 30px 30px 32px; }
    button { width: auto; }
  }
</style>
</head>
<body>
<main aria-labelledby="page-title">
  <header class="band">
    <p class="temple-ta"><?= $h($nameTa) ?></p>
    <p class="temple-en" lang="en"><?= $h($nameEn) ?></p>
  </header>
  <div class="content">
    <h1 id="page-title"><span><?= $h($copy['title']['ta']) ?></span><span class="en" lang="en"><?= $h($copy['title']['en']) ?></span></h1>
    <section class="lang"><?= $paras($copy['ta']) ?></section>
    <section class="lang" lang="en"><?= $paras($copy['en']) ?></section>
<?php if ($state === 'confirm'): ?>
    <form method="post" action="<?= $h((string) $ctx['action']) ?>">
      <input type="hidden" name="List-Unsubscribe" value="One-Click">
      <button type="submit"><span><?= $h($copy['button']['ta']) ?></span><span lang="en"><?= $h($copy['button']['en']) ?></span></button>
    </form>
<?php endif; ?>
<?php if (isset($copy['link'])): ?>
    <p class="links"><a href="<?= $h($prefs) ?>"><span><?= $h($copy['link']['ta']) ?></span><span lang="en"><?= $h($copy['link']['en']) ?></span></a></p>
<?php endif; ?>
    <p class="home"><a href="<?= $h($home) ?>">முகப்பு பக்கம் · <span lang="en">Temple website</span></a></p>
  </div>
</main>
</body>
</html>
<?php
    exit;
}
