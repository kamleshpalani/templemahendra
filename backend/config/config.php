<?php
// backend/config/config.php

define('SITE_NAME', 'Sri Mahendra Temple');
define('UPLOAD_DIR', __DIR__ . '/../uploads/');
define('UPLOAD_MAX_MB', 5);
define('ALLOWED_IMAGE_TYPES', ['image/jpeg', 'image/png', 'image/webp']);

// CORS — restrict to your domain in production
define('CORS_ORIGIN', getenv('CORS_ORIGIN') ?: '*');

// ── AI Chatbot ────────────────────────────────────────────────────────
// Set GEMINI_API_KEY in your Hostinger environment variables (or .env)
// to enable Google Gemini AI responses. Leave empty for rule-based fallback.
// Get a free key at: https://aistudio.google.com/app/apikey
// On Hostinger: hPanel → Hosting → Manage → PHP → Environment Variables
//   Key:   GEMINI_API_KEY
//   Value: AIza...your-key...


// ── Environment and error handling (brief §27) ────────────────────────────
// APP_ENV = production (the default when unset), staging or development.
// Outside development no error detail is ever printed: a visitor or a donor
// must not see a stack trace, a path or a database message. Everything is
// logged instead — to the server's own error log when the host configured
// one, else to backend/logs/php-error.log (a folder its .htaccess denies to
// the web and .gitignore keeps out of the repository). APP_DEBUG=1 (see
// includes/errors.php) still shows detail on screen in development only.
if (!defined('APP_ENV')) {
    $appEnv = strtolower(trim((string) (getenv('APP_ENV') ?: ($_SERVER['APP_ENV'] ?? 'production'))));
    define('APP_ENV', in_array($appEnv, ['production', 'staging', 'development'], true) ? $appEnv : 'production');
    unset($appEnv);
}
if (APP_ENV !== 'development') {
    ini_set('display_errors', '0');
    ini_set('display_startup_errors', '0');
}
ini_set('log_errors', '1');
// The PHP built-in server (local development and every test suite) keeps
// logging to its own console, where the suites look for warnings.
if ((string) ini_get('error_log') === '' && PHP_SAPI !== 'cli' && PHP_SAPI !== 'cli-server') {
    $logDir = __DIR__ . '/../logs';
    if (is_dir($logDir) && is_writable($logDir)) {
        ini_set('error_log', $logDir . '/php-error.log');
    }
    unset($logDir);
}
