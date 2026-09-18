<?php

require_once __DIR__ . '/../includes/notify.php';
require_once __DIR__ . '/../includes/public_guard.php';

header('Cache-Control: no-store, private');
header('X-Robots-Tag: noindex, nofollow');
header('Referrer-Policy: no-referrer');
ini_set('display_errors', '0');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    if (($liveSubscriptionAction ?? '') === 'unsubscribe') {
        if (!in_array($method, ['GET', 'HEAD', 'POST'], true)) {
            header('Allow: GET, HEAD, POST');
            sendError('Method not allowed', 405);
        }
        if (!liveSubscriptionsExist() || !notifyTablesExist()) sendError('Reminders unavailable', 503);
        $token = is_string($_GET['token'] ?? null) ? $_GET['token'] : '';
        $id = liveSubscriptionTokenId($token);
        if ($id === null || liveSubscriptionLoad($id) === null) sendError('Invalid unsubscribe link', 404);
        if ($method === 'POST') {
            getDB()->prepare(
                'UPDATE live_stream_subscriptions SET unsubscribed_at = COALESCE(unsubscribed_at, :now) WHERE id = :id'
            )->execute([':now' => notifyNow(), ':id' => $id]);
        }
        header('Content-Type: text/html; charset=utf-8');
        header("Content-Security-Policy: default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        if ($method === 'HEAD') exit;
        $done = $method === 'POST';
        echo '<!doctype html><html lang="ta"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<title>Darshan reminders</title><main><h1>தரிசன நினைவூட்டல்கள் / Darshan reminders</h1>';
        if ($done) {
            echo '<p>இந்த ஒளிபரப்பிற்கான நினைவூட்டல் நிறுத்தப்பட்டது.</p><p lang="en">Reminders for this broadcast are stopped.</p>';
        } else {
            echo '<p>இந்த ஒளிபரப்பிற்கான நினைவூட்டலை நிறுத்த வேண்டுமா?</p>'
                . '<p lang="en">Stop reminders for this broadcast? This cannot be undone for this broadcast.</p>'
                . '<form method="post"><button type="submit">நிறுத்து / Unsubscribe</button></form>';
        }
        echo '<p><a href="/live-darshan">நேரடி தரிசனம் / Live darshan</a></p></main></html>';
        exit;
    }

    if ($method !== 'POST') {
        header('Allow: POST');
        sendError('Method not allowed', 405);
    }
    publicGuardLimit('live-subscription-attempt');
    $body = getJsonBody();
    publicGuardHoneypotOrContinue($body);
    $email = is_string($body['email'] ?? null) ? mb_strtolower(trim($body['email'])) : '';
    $slug = is_string($body['slug'] ?? null) ? trim($body['slug']) : '';
    $lang = $body['lang'] ?? 'ta';
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 190
        || !preg_match('/^[a-z0-9][a-z0-9-]{1,118}$/D', $slug)
        || !in_array($lang, ['ta', 'en'], true) || !publicGuardConsent($body['consent'] ?? null)) {
        sendJson(['error' => 'A valid email, stream, language and consent are required.', 'code' => 'invalid'], 422);
    }
    if (!liveSubscriptionsExist() || !notifyTablesExist() || !notifyProviderFor('email')->isConfigured()) {
        sendJson(['error' => 'Email reminders are unavailable.', 'code' => 'unavailable'], 503);
    }
    publicGuardLimit('live-subscription-saved');
    $addressBucket = hash('sha256', $email);
    if (!rateLimitAllow('live-subscription-address', 5, 86400, $addressBucket)) {
        publicGuardTooMany(publicGuardRetryAfter('live-subscription-address', 86400, $addressBucket));
    }
    if (!liveSubscribe(getDB(), $slug, $email, $lang)) sendError('Broadcast unavailable for reminders', 404);
    sendJson(['success' => true], 201);
} catch (Throwable $e) {
    error_log('[live-subscription] ' . liveRedact($e->getMessage()));
    sendError('Reminders unavailable. Please try again later.', 503);
}
