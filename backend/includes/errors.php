<?php
/**
 * backend/includes/errors.php — one safety net for the whole admin.
 *
 * Nothing that reaches a committee member's browser should ever contain a
 * stack trace, a filesystem path or a database message: those help an attacker
 * and mean nothing to the reader. This installs handlers that log the detail
 * for the developer and show a calm, styled page to the person.
 *
 * Required by includes/auth.php, so every admin page is covered without
 * having to remember anything.
 *
 * Set APP_DEBUG=1 in the environment (never in production) to see the real
 * error on screen while developing.
 */

if (!function_exists('appDebug')) {
    function appDebug(): bool
    {
        $v = getenv('APP_DEBUG');
        if ($v === false || $v === '') {
            $v = $_ENV['APP_DEBUG'] ?? $_SERVER['APP_DEBUG'] ?? '';
        }
        return $v === '1' || strtolower((string) $v) === 'true';
    }
}

if (!appDebug()) {
    ini_set('display_errors', '0');
    ini_set('display_startup_errors', '0');
}
ini_set('log_errors', '1');
error_reporting(E_ALL);

if (!function_exists('renderFatalPage')) {
    /**
     * Render a friendly 500 and stop. Safe to call at any point: if output has
     * already started we append the panel rather than trying to rewrite headers.
     */
    function renderFatalPage(string $reference, ?string $debugDetail = null): void
    {
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: text/html; charset=utf-8');
        }
        $ref   = htmlspecialchars($reference, ENT_QUOTES, 'UTF-8');
        $debug = $debugDetail !== null
            ? '<pre class="cols" style="white-space:pre-wrap">' . htmlspecialchars($debugDetail, ENT_QUOTES, 'UTF-8') . '</pre>'
            : '';
        echo <<<HTML
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" /><title>Something went wrong — Temple Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="stylesheet" href="/admin/assets/ds/tokens.css" />
<link rel="stylesheet" href="/admin/assets/ds/base.css" />
<link rel="stylesheet" href="/admin/assets/ds/layout.css" />
<link rel="stylesheet" href="/admin/assets/ds/components.css" />
<link rel="stylesheet" href="/admin/assets/ds/utilities.css" />
<link rel="stylesheet" href="/admin/assets/admin.css" />
</head><body style="display:block">
<main class="container container--narrow section">
  <div class="empty-state empty-state--error" role="alert">
    <span class="empty-state__icon" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
    </span>
    <h1 class="empty-state__title">That did not save</h1>
    <p>Something went wrong on the server, so nothing was changed. Please go back and try again.</p>
    <p class="muted">If it keeps happening, quote reference <strong>{$ref}</strong> to whoever maintains the site.</p>
    {$debug}
    <div class="empty-state__actions">
      <a class="btn btn-primary" href="/admin/">Back to dashboard</a>
      <a class="btn btn-outline" href="javascript:history.back()">Go back</a>
    </div>
  </div>
</main>
</body></html>
HTML;
    }
}

set_exception_handler(function (Throwable $e): void {
    $ref = strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
    error_log(sprintf(
        '[admin %s] %s: %s in %s:%d',
        $ref,
        get_class($e),
        $e->getMessage(),
        $e->getFile(),
        $e->getLine()
    ));
    renderFatalPage($ref, appDebug() ? ($e->getMessage() . "\n\n" . $e->getTraceAsString()) : null);
    exit;
});

set_error_handler(function (int $no, string $str, string $file = '', int $line = 0): bool {
    // Convert anything that is not merely a notice into an exception so the
    // handler above deals with it uniformly.
    if (!(error_reporting() & $no)) return false;
    if (in_array($no, [E_NOTICE, E_USER_NOTICE, E_DEPRECATED, E_USER_DEPRECATED], true)) {
        error_log(sprintf('[admin notice] %s in %s:%d', $str, $file, $line));
        return true;
    }
    throw new ErrorException($str, 0, $no, $file, $line);
});

register_shutdown_function(function (): void {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        $ref = strtoupper(substr(bin2hex(random_bytes(4)), 0, 8));
        error_log(sprintf('[admin %s] fatal: %s in %s:%d', $ref, $e['message'], $e['file'], $e['line']));
        if (!headers_sent()) {
            renderFatalPage($ref, appDebug() ? $e['message'] : null);
        }
    }
});
