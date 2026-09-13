<?php
/**
 * api/og.php — the page WhatsApp, Facebook, LinkedIn, X, Telegram, Slack and
 * Discord actually read when someone shares a link to this site.
 *
 * WHY
 * The public site is a React app. Its <Seo> component writes the title,
 * description and Open Graph tags after the JavaScript has run, which is fine
 * for browsers and for search engines that execute scripts — and useless for
 * link unfurlers, which fetch the HTML once and never run anything. Left to
 * index.html, every shared link would preview with the same title and no
 * picture, whichever page was sent.
 *
 * So Apache routes those crawlers here (see deploy/htaccess_public_html) and
 * this file renders a small, complete document for the path they asked about:
 * real title, real description, real image, correct canonical URL.
 *
 * WHERE THE WORDS COME FROM
 *   • a page's own copy      → includes/site_pages.php, kept in step with the
 *                              React pages by tests/og.mjs
 *   • one seva, one photo    → the database, the same rows the page renders
 * Nothing is invented here and no address is hard-coded: siteUrl() resolves the
 * origin from SITE_URL, falling back to the requested host.
 *
 * A person who opens this endpoint directly is sent on to the real page.
 *
 *   GET /api/og.php?path=/gallery&photo=7
 *   GET /api/og.php?path=/sevas&seva=3
 *   GET /api/og.php?path=/events&lang=en
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/site_pages.php';

// A crawler must never be handed a stack trace, and a preview is not worth a
// 500: anything unexpected falls through to the temple's name and front page.
ini_set('display_errors', '0');
ini_set('log_errors', '1');

/** The temple's identity, as the shared-link layer states it. Mirrors data/temple.js. */
function ogIdentity(): array
{
    return [
        'name_ta' => 'அருள்மிகு ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள் திருக்கோவில்',
        'name_en' => 'Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple',
        'alt_ta'  => 'மலர் அலங்காரத்தில் மூன்று தெய்வங்கள் — ஸ்ரீ லிங்கம்மாள், ஸ்ரீ ரேணுகாதேவி, ஸ்ரீ சின்னம்மாள்',
        'alt_en'  => 'The three deities in floral alankaram — Sri Lingammal, Sri Renukadevi, Sri Chinnammal',
    ];
}

/**
 * The site path being asked about, reduced to something safe to echo into a
 * canonical URL: no host, no scheme, no fragment, no backslashes. Anything that
 * is not a plain local path is treated as the front page rather than trusted,
 * because this value ends up in a link the visitor's browser will follow.
 */
function ogPath(): string
{
    $raw = (string) ($_GET['path'] ?? '');
    if ($raw === '') {
        $raw = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
        // Reached directly with no path: there is nothing to describe but the site.
        if (str_contains($raw, 'og.php')) $raw = '/';
    }

    // Accept a whole "/gallery?photo=7" in one parameter as well as separate
    // query arguments — whichever way the caller found easier.
    $parts = explode('?', $raw, 2);
    $raw   = $parts[0];
    if (isset($parts[1])) {
        parse_str($parts[1], $extra);
        $_GET += is_array($extra) ? $extra : [];
    }

    $raw = explode('#', $raw)[0];
    $raw = '/' . ltrim($raw, '/');
    if (strlen($raw) > 512) return '/';
    if (preg_match('#[\\\\\s]|^/{2,}#', $raw)) return '/';
    return rtrim($raw, '/') ?: '/';
}

/** 'en' only when asked for; the site itself opens in Tamil. */
function ogLang(): string
{
    $q = strtolower(trim((string) ($_GET['lang'] ?? '')));
    if ($q === 'en' || $q === 'ta') return $q;
    // Crawlers usually forward the sharer's own Accept-Language.
    $accept = strtolower((string) ($_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? ''));
    if ($accept !== '' && !str_contains($accept, 'ta') && str_contains($accept, 'en')) return 'en';
    return 'ta';
}

/** One line, short enough for a preview card, cut on a word where possible. */
function ogTrim(?string $value, int $max = 200): string
{
    $s = trim(preg_replace('/\s+/u', ' ', strip_tags((string) $value)));
    if ($s === '' || mb_strlen($s) <= $max) return $s;
    $cut = mb_substr($s, 0, $max - 1);
    $sp  = mb_strrpos($cut, ' ');
    if ($sp !== false && $sp > $max * 0.6) $cut = mb_substr($cut, 0, $sp);
    return $cut . '…';
}

/**
 * Where a public file actually sits on disk. On Hostinger the built site and the
 * API share one document root; locally the API runs from backend/ and the public
 * files are still in the frontend's folder. Both are tried so the preview only
 * ever advertises an image that exists — a broken og:image is worse than a
 * plainer one, because the platform caches the failure.
 */
function ogPublicFile(string $path): ?string
{
    $roots = array_filter([
        $_SERVER['DOCUMENT_ROOT'] ?? null,
        __DIR__ . '/../..',                 // public_html/, when api/ sits inside it
        __DIR__ . '/../../frontend/public', // local checkout
    ]);
    foreach ($roots as $root) {
        $candidate = rtrim((string) $root, '/\\') . '/' . ltrim($path, '/');
        if (is_file($candidate)) return $candidate;
    }
    return null;
}

/** The preview image for a path: the caller's own, else the sanctum photo, else the app icon. */
function ogImage(?string $preferred): array
{
    $candidates = array_filter([$preferred, '/images/deities-alankaram.jpg', '/icons/icon-512x512.png']);
    foreach ($candidates as $path) {
        $file = ogPublicFile($path);
        if ($file === null) continue;
        $size = @getimagesize($file);
        return [
            'url'    => siteUrl($path),
            'width'  => $size[0] ?? null,
            'height' => $size[1] ?? null,
        ];
    }
    // Nothing on disk. Still name the icon: it ships with every build, and the
    // file may simply be unreadable from this process.
    return ['url' => siteUrl('/icons/icon-512x512.png'), 'width' => null, 'height' => null];
}

/* ── Resolve what this path is about ─────────────────────────────────────── */

$path = ogPath();
$lang = ogLang();
$id   = ogIdentity();
$site = $lang === 'en' ? $id['name_en'] : $id['name_ta'];

$title       = '';
$description = '';
$image       = null;
$imageAlt    = $lang === 'en' ? $id['alt_en'] : $id['alt_ta'];
$type        = 'website';
$robots      = '';
$status      = 200;

try {
    $pages   = sitePages();
    $private = sitePrivatePaths();

    if (in_array($path, $private, true)) {
        // A personal page. Answer politely, say nothing about it, index nothing.
        $robots = 'noindex, nofollow';
    } elseif ($path === '/gallery' && ($_GET['photo'] ?? '') !== '') {
        $stmt = getDB()->prepare('SELECT caption, filename FROM gallery WHERE id = :id AND is_active = 1');
        $stmt->execute([':id' => (int) $_GET['photo']]);
        $photo = $stmt->fetch();
        [, , $descTa, $descEn] = $pages['/gallery'];
        $title       = $photo && $photo['caption'] !== '' ? $photo['caption'] : ($lang === 'en' ? 'Gallery' : 'தொகுப்பு');
        $description = $photo && $photo['caption'] !== '' ? $photo['caption'] : ($lang === 'en' ? $descEn : $descTa);
        $type        = 'article';
        if ($photo) {
            $image    = '/uploads/' . $photo['filename'];
            $imageAlt = $title;
        }
    } elseif ($path === '/sevas' && ($_GET['seva'] ?? '') !== '') {
        $stmt = getDB()->prepare('SELECT name_ta, name_en, description, amount FROM sevas WHERE id = :id AND is_active = 1');
        $stmt->execute([':id' => (int) $_GET['seva']]);
        $seva = $stmt->fetch();
        [, , $descTa, $descEn] = $pages['/sevas'];
        if ($seva) {
            $title    = $lang === 'en' ? ($seva['name_en'] ?: $seva['name_ta']) : ($seva['name_ta'] ?: $seva['name_en']);
            $offering = $lang === 'en' ? 'Offering' : 'சமர்ப்பணம்';
            // Whole rupees read as whole rupees; paise only when there are any.
            $amount   = (float) $seva['amount'];
            $money    = '₹' . number_format($amount, $amount === floor($amount) ? 0 : 2);
            $description = ogTrim($seva['description']) ?: ($lang === 'en' ? $descEn : $descTa);
            $description = $description . ' · ' . $offering . ' ' . $money;
        } else {
            $title       = $lang === 'en' ? 'Sevas' : 'சேவைகள்';
            $description = $lang === 'en' ? $descEn : $descTa;
        }
        $type = 'article';
    } elseif (isset($pages[$path])) {
        [$titleTa, $titleEn, $descTa, $descEn] = $pages[$path];
        $title       = $lang === 'en' ? $titleEn : $titleTa;
        $description = $lang === 'en' ? $descEn : $descTa;
        // A results list is not a destination, but its links are worth following.
        if ($path === '/search') {
            $robots = 'noindex, follow';
            $q      = ogTrim($_GET['q'] ?? '', 80);
            if ($q !== '') $title = $title . ': ' . $q;
        }
    } else {
        // An address that is not part of the site. React answers it with its own
        // not-found page, and this says the same thing rather than pretending.
        $title  = $lang === 'en' ? 'Page Not Found' : 'பக்கம் கிடைக்கவில்லை';
        $robots = 'noindex, nofollow';
        $status = 404;
    }
} catch (Throwable $e) {
    // A database that is down must not cost the temple its preview.
    error_log('[og] ' . get_class($e) . ': ' . $e->getMessage());
    if ($title === '' && isset($pages[$path])) {
        [$titleTa, $titleEn] = $pages[$path];
        $title = $lang === 'en' ? $titleEn : $titleTa;
    }
}

$canonical   = siteUrl($path) . ($path === '/search' && ($_GET['q'] ?? '') !== '' ? '?q=' . urlencode((string) $_GET['q']) : '');
$preview     = ogImage($image);
$docTitle    = $title === '' ? $site : $title . ' — ' . $site;
$description = ogTrim($description);
$h           = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');

http_response_code($status);
header('Content-Type: text/html; charset=utf-8');
// Unfurlers scrape the same link repeatedly; five minutes spares the database
// without holding a stale title for long.
header('Cache-Control: public, max-age=300');
?>
<!doctype html>
<html lang="<?= $lang === 'en' ? 'en' : 'ta' ?>">
<head>
<meta charset="utf-8">
<title><?= $h($docTitle) ?></title>
<?php if ($description !== ''): ?>
<meta name="description" content="<?= $h($description) ?>">
<?php endif; ?>
<?php if ($robots !== ''): ?>
<meta name="robots" content="<?= $h($robots) ?>">
<?php endif; ?>
<link rel="canonical" href="<?= $h($canonical) ?>">

<meta property="og:type" content="<?= $h($type) ?>">
<meta property="og:site_name" content="<?= $h($site) ?>">
<meta property="og:locale" content="<?= $lang === 'en' ? 'en_IN' : 'ta_IN' ?>">
<meta property="og:title" content="<?= $h($title === '' ? $site : $title) ?>">
<?php if ($description !== ''): ?>
<meta property="og:description" content="<?= $h($description) ?>">
<?php endif; ?>
<meta property="og:url" content="<?= $h($canonical) ?>">
<meta property="og:image" content="<?= $h($preview['url']) ?>">
<?php if ($preview['width'] && $preview['height']): ?>
<meta property="og:image:width" content="<?= (int) $preview['width'] ?>">
<meta property="og:image:height" content="<?= (int) $preview['height'] ?>">
<?php endif; ?>
<meta property="og:image:alt" content="<?= $h($imageAlt) ?>">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="<?= $h($title === '' ? $site : $title) ?>">
<?php if ($description !== ''): ?>
<meta name="twitter:description" content="<?= $h($description) ?>">
<?php endif; ?>
<meta name="twitter:image" content="<?= $h($preview['url']) ?>">
<meta name="twitter:image:alt" content="<?= $h($imageAlt) ?>">
</head>
<body>
<h1><?= $h($title === '' ? $site : $title) ?></h1>
<?php if ($description !== ''): ?>
<p><?= $h($description) ?></p>
<?php endif; ?>
<p><a href="<?= $h($canonical) ?>"><?= $h($lang === 'en' ? 'Continue to the temple website' : 'கோயில் இணையதளத்திற்குச் செல்ல') ?></a></p>
<script>
/* A person who opened this endpoint directly should end up on the real page.
   Guarded on the address bar: when Apache routed a crawler here internally the
   browser is already at the real path, and redirecting would only fetch it
   again. */
(function () {
  if (location.pathname.indexOf("/api/og.php") === 0 || location.pathname.indexOf("/og.php") === 0) {
    location.replace(<?= json_encode($canonical, JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>);
  }
})();
</script>
</body>
</html>
