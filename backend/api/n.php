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

        $stmt = getDB()->prepare('SELECT id, email, phone FROM devotees WHERE id = :id');
        $stmt->execute([':id' => $verified['id']]);
        $devotee = $stmt->fetch(PDO::FETCH_ASSOC);
        // The registration was deleted (or merged into another): nothing is left to unsubscribe.
        if (!$devotee) nPage(404, 'invalid');

        // Enough for a family sharing one inbox or phone to tell whose
        // registration this is: the masked email, or the masked phone when the
        // registration has no email.
        $email   = trim((string) ($devotee['email'] ?? ''));
        $contact = $email !== '' ? notifyRedact($email, 190) : notifyMaskPhone((string) ($devotee['phone'] ?? ''));
        $action  = '/api/n/u/' . $token;

        if ($method === 'POST') {
            // Unsubscribing withdraws the family's consent to temple updates on
            // every channel (docs/registration/SPEC.md §6). Messages about their
            // own bookings and donations are not updates and keep coming.
            // notifyUnsubscribe keeps the first time, so a second POST (a mail
            // provider retrying a one-click request) changes nothing.
            notifyUnsubscribe((int) $devotee['id']);
            nPage(200, 'done', ['contact' => $contact]);
        }

        $already = !empty(notifyConsentState((int) $devotee['id'])['unsubscribed']);
        nPage(200, $already ? 'already' : 'confirm', ['contact' => $contact, 'action' => $action]);
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
 * {contact} is the registration's masked email ("k***@example.org"), or its
 * masked phone when it has no email, so someone reading a shared inbox or phone
 * can tell whose registration the link belongs to. 'office' introduces the
 * temple office's phone number, which the page shows instead of any settings
 * link: devotees do not sign in, and the office is how anything is changed.
 */
function nCopy(string $state): array
{
    $keepTa = 'உங்கள் சேவை பதிவுகள், நன்கொடைகள் பற்றிய உறுதிப்படுத்தல்கள், நினைவூட்டல்கள், ரசீதுகள் தொடர்ந்து வரும்.';
    $keepEn = 'Messages about your own seva bookings and donations, such as confirmations, reminders and receipts, will still reach you.';
    $againTa = 'மீண்டும் கோயில் அறிவிப்புகளைப் பெற, அல்லது வேறு எதற்கும், கோயில் அலுவலகத்தை அழைக்கவும்:';
    $againEn = 'To receive temple updates again, or for anything else, call the temple office:';

    return match ($state) {
        'confirm' => [
            'title'  => ['ta' => 'கோயில் அறிவிப்புகளை நிறுத்தவா?', 'en' => 'Stop temple updates?'],
            'ta'     => ['இந்தப் பதிவுக்கு ({contact}) திருவிழா, பூஜை மற்றும் கோயில் அறிவிப்புகள் இனி மின்னஞ்சல், வாட்ஸ்அப், குறுஞ்செய்தி எதிலும் அனுப்பப்படாது.', $keepTa],
            'en'     => ['News of festivals, poojas and temple announcements will no longer be sent to this registration ({contact}) by email, WhatsApp or SMS.', $keepEn],
            'button' => ['ta' => 'அறிவிப்புகளை நிறுத்து', 'en' => 'Stop updates'],
            'office' => ['ta' => 'கேள்விகள் இருந்தால், கோயில் அலுவலகத்தை அழைக்கவும்:', 'en' => 'Questions? Call the temple office:'],
        ],
        'already' => [
            'title'  => ['ta' => 'கோயில் அறிவிப்புகள் ஏற்கனவே நிறுத்தப்பட்டுள்ளன', 'en' => 'Temple updates are already stopped'],
            'ta'     => ['இந்தப் பதிவுக்கு ({contact}) கோயில் அறிவிப்புகள் அனுப்பப்படுவதில்லை.', $keepTa],
            'en'     => ['Temple updates are not being sent to this registration ({contact}).', $keepEn],
            'office' => ['ta' => $againTa, 'en' => $againEn],
        ],
        'done' => [
            'title'  => ['ta' => 'கோயில் அறிவிப்புகள் நிறுத்தப்பட்டன', 'en' => 'Temple updates stopped'],
            'ta'     => ['இந்தப் பதிவுக்கு ({contact}) இனி கோயில் அறிவிப்புகள் அனுப்பப்படாது.', $keepTa],
            'en'     => ['No more temple updates will be sent to this registration ({contact}).', $keepEn],
            'office' => ['ta' => $againTa, 'en' => $againEn],
        ],
        'invalid' => [
            'title'  => ['ta' => 'இந்த இணைப்பு செல்லாது', 'en' => 'This link is not valid'],
            'ta'     => ['இணைப்பு முழுமையாக இல்லாமல் இருக்கலாம், அல்லது அந்தப் பதிவு நீக்கப்பட்டிருக்கலாம்.'],
            'en'     => ['The link may be incomplete, or the registration it belonged to has been removed.'],
            'office' => ['ta' => 'கோயில் அறிவிப்புகளை நிறுத்த, கோயில் அலுவலகத்தை அழைக்கவும்:', 'en' => 'To stop temple updates, call the temple office:'],
        ],
        'unavailable' => [
            'title'  => ['ta' => 'இப்போது இதை மாற்ற முடியவில்லை', 'en' => 'This cannot be changed right now'],
            'ta'     => ['சிறிது நேரம் கழித்து மீண்டும் முயலுங்கள்.'],
            'en'     => ['Please try again later.'],
            'office' => ['ta' => 'அல்லது கோயில் அலுவலகத்தை அழைக்கவும்:', 'en' => 'Or call the temple office:'],
        ],
        default => [
            'title'  => ['ta' => 'ஏதோ தவறு நடந்தது', 'en' => 'Something went wrong'],
            'ta'     => ['உங்கள் தேர்வைச் சேமிக்க முடியவில்லை. சிறிது நேரத்தில் மீண்டும் முயலுங்கள்.'],
            'en'     => ['Your choice could not be saved. Please try again in a moment.'],
            'office' => ['ta' => 'அல்லது கோயில் அலுவலகத்தை அழைக்கவும்:', 'en' => 'Or call the temple office:'],
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
    $h       = static fn(string $v): string => htmlspecialchars($v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $copy    = nCopy($state);
    $contact = (string) ($ctx['contact'] ?? '');
    $fill    = static fn(string $text): string => str_replace(
        '{contact}',
        '<strong class="addr">' . $h($contact !== '' ? $contact : '—') . '</strong>',
        $h($text)
    );

    $facts        = function_exists('notifyTempleFacts') ? notifyTempleFacts() : [];
    $nameTa       = (string) ($facts['name']['ta'] ?? 'அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்');
    $nameEn       = (string) ($facts['name']['en'] ?? 'Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple');
    $officeTel    = (string) ($facts['supportPhone'] ?? '+919443002296');
    $officeShown  = (string) ($facts['supportPhoneDisplay'] ?? '+91 94430 02296');
    $home         = siteUrl('/');

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
  .office .tel { display: inline-block; margin-top: 6px; font-weight: 700; font-size: 17px; white-space: nowrap; }
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
<?php if (isset($copy['office'])): ?>
    <p class="links office"><span><?= $h($copy['office']['ta']) ?></span><span lang="en"><?= $h($copy['office']['en']) ?></span>
      <a class="tel" href="tel:<?= $h($officeTel) ?>"><?= $h($officeShown) ?></a></p>
<?php endif; ?>
    <p class="home"><a href="<?= $h($home) ?>">முகப்பு பக்கம் · <span lang="en">Temple website</span></a></p>
  </div>
</main>
</body>
</html>
<?php
    exit;
}
