<?php
/**
 * backend/includes/live.php — loads the Live Darshan module
 * (docs/live/SPEC-PHASE1.md §4.1).
 *
 * Everything about live streams — the vocabulary, time conversion, validation,
 * uploads, the streaming-provider seam, the store and the admin read models —
 * lives in backend/includes/live/, which the web server never serves directly
 * (backend/includes/.htaccess). The public API, the admin JSON API and the
 * admin page require this one file and call the library; they hold no stream
 * logic of their own.
 *
 * Loading costs function and class definitions and no database query. The
 * notification service's clock and secrets file (notify/time.php) loads on its
 * own, without the rest of that service.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/helpers.php';
require_once __DIR__ . '/notify/contracts.php';   // notifyEnv(), notifyHttp(), notifyRedact()
require_once __DIR__ . '/notify/time.php';        // notifyNow(), notifyIso(), notifyIsTimezone(), notifyToUtc(), notifyFromUtc()

foreach (['config', 'time', 'settings', 'validate', 'media', 'providers', 'youtube', 'store', 'poll', 'health', 'subscriptions', 'donations', 'admin'] as $liveModule) {
    require_once __DIR__ . '/live/' . $liveModule . '.php';
}
unset($liveModule);
