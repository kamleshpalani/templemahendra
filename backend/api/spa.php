<?php
/**
 * api/spa.php — the React shell, with an honest status line.
 *
 * Apache cannot know which addresses the React app has pages for, so a plain
 * "serve index.html for everything" fallback answers HTTP 200 to every typo.
 * Search engines call that a soft 404 and index the not-found page as content.
 * Instead, public_html/.htaccess sends non-file requests here; the shell is
 * served unchanged, but with 404 when includes/site_pages.php says the address
 * is not a page of the site. The visitor sees exactly what they saw before.
 *
 *   curl -sI https://example.org/no-such-page | head -1   → HTTP/1.1 404
 *   curl -sI https://example.org/about        | head -1   → HTTP/1.1 200
 */

require_once __DIR__ . '/../includes/helpers.php';
require_once __DIR__ . '/../includes/site_pages.php';

$path   = sitePathFromRequest((string) ($_GET['path'] ?? parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH)));
if (str_contains($path, 'spa.php')) $path = '/';
$status = sitePathStatus($path);

/** index.html sits beside api/ on Hostinger, in frontend/dist on a local build. */
function spaShell(): ?string
{
    foreach ([$_SERVER['DOCUMENT_ROOT'] ?? null, __DIR__ . '/../..', __DIR__ . '/../../frontend/dist'] as $root) {
        if (!$root) continue;
        $file = realpath(rtrim((string) $root, '/\\') . '/index.html');
        if ($file && is_file($file)) return $file;
    }
    return null;
}

http_response_code($status);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
if ($status === 404) header('X-Robots-Tag: noindex, nofollow');

$shell = spaShell();
if ($shell !== null) {
    readfile($shell);
    exit;
}

// No built frontend next to the API (local dev without `npm run build`): say
// what happened rather than a blank page.
$h = static fn(?string $v): string => htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title><?= $status === 404 ? 'Page Not Found' : 'Temple website' ?></title>
<?php if ($status === 404): ?><meta name="robots" content="noindex, nofollow"><?php endif; ?>
</head>
<body>
<h1><?= $status === 404 ? 'Page Not Found' : 'Temple website' ?></h1>
<p><?= $status === 404 ? 'There is no page at ' . $h($path) . '.' : 'The frontend has not been built; run <code>npm run build</code> in frontend/.' ?></p>
</body>
</html>
