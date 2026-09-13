<?php
/**
 * backend/bin/notify_keys.php — keys, and a settings check, for the
 * notification providers. Command line only.
 *
 *   php backend/bin/notify_keys.php vapid   print a fresh Web Push (VAPID) key pair as environment lines
 *   php backend/bin/notify_keys.php check   say which channels are ready, and what is wrong with the rest
 *
 * `check` never prints a secret. It says whether a value is set, how long it is
 * and whether it has the shape the provider needs, and it exits 1 when a
 * channel's configured driver cannot send — so a deploy script can refuse to go
 * live with broken settings, and a committee member can paste the output into a
 * support request without leaking a token.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../includes/notify/contracts.php';

$command = $argv[1] ?? '';

switch ($command) {
    case 'vapid':
        $pair = NotifyEcKeys::generate();
        if ($pair === null) {
            fwrite(STDERR, "Could not generate a P-256 key pair: the PHP openssl extension cannot create EC keys here.\n");
            exit(1);
        }
        // Guidance on stderr, so `php notify_keys.php vapid >> .env` captures only the two lines.
        fwrite(STDERR, "# Web Push keys. Set both in the hosting environment once and keep them:\n"
            . "# changing them later silently orphans every existing push subscription.\n");
        echo 'VAPID_PUBLIC_KEY=' . notifyB64u($pair['public']) . "\n";
        echo 'VAPID_PRIVATE_KEY=' . notifyB64u($pair['private']) . "\n";
        exit(0);

    case 'check':
        exit(notifyKeysCheck());

    case '':
    case 'help':
    case '-h':
    case '--help':
        echo "Usage:\n"
            . "  php backend/bin/notify_keys.php vapid   print VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY\n"
            . "  php backend/bin/notify_keys.php check   report which notification channels are configured\n";
        exit(0);

    default:
        fwrite(STDERR, "Unknown command \"" . preg_replace('/[^\w-]/', '', $command) . "\". Use vapid or check.\n");
        exit(2);
}

/** Print the report; return the exit code. */
function notifyKeysCheck(): int
{
    $errors = 0;
    $print = static function (array $checks) use (&$errors): void {
        foreach ($checks as [$level, $text]) {
            if ($level === 'error') $errors++;
            echo '  ' . str_pad($level, 6) . ' ' . $text . "\n";
        }
    };

    echo "General\n";
    $print(notifyKeysGeneral());

    foreach (NOTIFY_EXTERNAL_CHANNELS as $channel) {
        $driver   = notifyDriverName($channel);
        $provider = notifyProviderFor($channel, true);
        try {
            $ready = $provider->isConfigured();
        } catch (Throwable $e) {
            $ready = false;
        }
        echo "\n" . $channel . ' (driver "' . $driver . '"): ' . ($ready ? 'ready' : 'NOT READY') . "\n";

        $checks = match ($driver) {
            'mailer'  => notifyKeysMailer(),
            'meta'    => notifyKeysMeta(),
            'twilio'  => notifyKeysTwilio($channel),
            'msg91'   => notifyKeysMsg91(),
            'webpush' => notifyKeysWebPush(),
            'fcm'     => notifyKeysFcm(),
            'log'     => [['warn', 'the log driver writes messages to backend/logs/notify.log; nothing reaches a devotee']],
            'test'    => [['warn', 'the test driver is for test suites only and must never be used in production']],
            default   => [['error', 'unknown driver: use ' . implode(', ', array_keys(notifyProviderRegistry()[$channel] ?? []))]],
        };
        if (!$ready && $driver !== 'log') {
            $checks[] = ['error', 'the provider reports it is not configured, so this channel will be skipped'];
        }
        $print($checks);
    }

    echo "\n" . ($errors === 0 ? 'No problems found.' : $errors . ' problem(s) found.') . "\n";
    return $errors === 0 ? 0 : 1;
}

/** "NAME is set (N characters)" or "NAME is not set" — never the value. */
function notifyKeysSet(string $name): string
{
    $value = notifyEnv($name);
    return $value === '' ? "$name is not set" : "$name is set (" . strlen($value) . ' characters)';
}

function notifyKeysHttps(string $name, string $value, string $why): array
{
    return stripos($value, 'https://') === 0
        ? ['ok', "$name is an https address"]
        : ['warn', "$name is not an https address: $why"];
}

function notifyKeysGeneral(): array
{
    $out = [];
    $secret = notifyEnv('NOTIFY_SECRET');
    $out[] = strlen($secret) >= 32
        ? ['ok', notifyKeysSet('NOTIFY_SECRET')]
        : ['warn', 'NOTIFY_SECRET is missing or shorter than 32 characters: a secret is generated into notification_kv instead; set one in production'];
    $out[] = notifyKeysHttps('SITE_URL', siteUrl(), 'provider callbacks, tracking and unsubscribe links need the public https address');
    $out[] = function_exists('curl_init') ? ['ok', 'the curl extension is available'] : ['error', 'the PHP curl extension is missing: no provider can send'];
    return $out;
}

function notifyKeysMailer(): array
{
    $out = [];
    $transport = strtolower(notifyEnv('MAIL_TRANSPORT'));
    if ($transport === 'smtp') {
        $out[] = ['ok', 'MAIL_TRANSPORT=smtp'];
        $out[] = notifyEnv('SMTP_HOST') !== '' ? ['ok', 'SMTP_HOST is set'] : ['error', 'SMTP_HOST is not set'];
        $port = notifyEnv('SMTP_PORT', '587');
        $out[] = ctype_digit($port) && (int) $port > 0 && (int) $port < 65536 ? ['ok', "SMTP_PORT is $port"] : ['error', 'SMTP_PORT is not a port number'];
        $secure = strtolower(notifyEnv('SMTP_SECURE', 'tls'));
        $out[] = in_array($secure, ['tls', 'ssl', 'none'], true) ? ['ok', "SMTP_SECURE is $secure"] : ['error', 'SMTP_SECURE must be tls, ssl or none'];
        $out[] = notifyEnv('SMTP_USER') !== '' ? ['ok', notifyKeysSet('SMTP_PASS') . '; SMTP_USER is set'] : ['warn', 'SMTP_USER is not set: the server must accept mail without signing in'];
    } elseif ($transport === 'mail') {
        $out[] = ['warn', "MAIL_TRANSPORT=mail: PHP's mail() is unreliable on shared hosting; prefer smtp"];
    } else {
        $out[] = ['warn', 'MAIL_TRANSPORT is not set: emails are written to backend/logs/mail.log and not sent'];
    }
    $out[] = filter_var(notifyEnv('MAIL_FROM'), FILTER_VALIDATE_EMAIL)
        ? ['ok', 'MAIL_FROM is a valid address']
        : ['warn', 'MAIL_FROM is not a valid address: mail goes out from no-reply@<host>'];
    return $out;
}

function notifyKeysMeta(): array
{
    $out = [];
    $out[] = notifyEnv('WHATSAPP_META_TOKEN') !== '' ? ['ok', notifyKeysSet('WHATSAPP_META_TOKEN')] : ['error', 'WHATSAPP_META_TOKEN is not set'];
    $out[] = ctype_digit(notifyEnv('WHATSAPP_META_PHONE_NUMBER_ID'))
        ? ['ok', 'WHATSAPP_META_PHONE_NUMBER_ID is a numeric id']
        : ['error', 'WHATSAPP_META_PHONE_NUMBER_ID must be the numeric phone number id from the Meta dashboard (not the phone number)'];
    $out[] = notifyEnv('WHATSAPP_META_APP_SECRET') !== ''
        ? ['ok', notifyKeysSet('WHATSAPP_META_APP_SECRET')]
        : ['warn', 'WHATSAPP_META_APP_SECRET is not set: every status callback will be refused'];
    $out[] = strlen(notifyEnv('WHATSAPP_META_VERIFY_TOKEN')) >= 16
        ? ['ok', notifyKeysSet('WHATSAPP_META_VERIFY_TOKEN')]
        : ['warn', 'WHATSAPP_META_VERIFY_TOKEN is missing or shorter than 16 characters: the webhook subscription check needs it'];
    $out[] = preg_match('/^v\d+\.\d+$/', notifyEnv('WHATSAPP_META_API_VERSION', 'v21.0'))
        ? ['ok', 'WHATSAPP_META_API_VERSION is ' . notifyEnv('WHATSAPP_META_API_VERSION', 'v21.0')]
        : ['error', 'WHATSAPP_META_API_VERSION must look like v21.0'];
    $out[] = notifyKeysHttps('WHATSAPP_META_BASE_URL', notifyEnv('WHATSAPP_META_BASE_URL', 'https://graph.facebook.com'), 'only a test mock should be plain http');
    return $out;
}

function notifyKeysTwilio(string $channel): array
{
    $out = [];
    $out[] = preg_match('/^AC[0-9a-f]{32}$/i', notifyEnv('TWILIO_ACCOUNT_SID'))
        ? ['ok', 'TWILIO_ACCOUNT_SID has the AC… shape']
        : ['error', 'TWILIO_ACCOUNT_SID must be AC followed by 32 hexadecimal characters'];
    $token = notifyEnv('TWILIO_AUTH_TOKEN');
    $out[] = $token === ''
        ? ['error', 'TWILIO_AUTH_TOKEN is not set']
        : (preg_match('/^[0-9a-f]{32}$/i', $token) ? ['ok', notifyKeysSet('TWILIO_AUTH_TOKEN')] : ['warn', 'TWILIO_AUTH_TOKEN does not look like a 32-character auth token']);
    if ($channel === 'whatsapp') {
        $out[] = preg_match('/^whatsapp:\+\d{7,15}$/', notifyEnv('TWILIO_WHATSAPP_FROM'))
            ? ['ok', 'TWILIO_WHATSAPP_FROM has the whatsapp:+… shape']
            : ['error', 'TWILIO_WHATSAPP_FROM must look like whatsapp:+14155238886'];
    } else {
        $from = notifyEnv('TWILIO_SMS_FROM');
        $service = notifyEnv('TWILIO_MESSAGING_SERVICE_SID');
        if ($from !== '') {
            $out[] = preg_match('/^\+\d{7,15}$/', $from) ? ['ok', 'TWILIO_SMS_FROM is an E.164 number'] : ['warn', 'TWILIO_SMS_FROM is not an E.164 number (+…); an alphanumeric sender works only where the country allows it'];
        } elseif ($service !== '') {
            $out[] = preg_match('/^MG[0-9a-f]{32}$/i', $service) ? ['ok', 'TWILIO_MESSAGING_SERVICE_SID has the MG… shape'] : ['error', 'TWILIO_MESSAGING_SERVICE_SID must be MG followed by 32 hexadecimal characters'];
        } else {
            $out[] = ['error', 'set TWILIO_SMS_FROM or TWILIO_MESSAGING_SERVICE_SID'];
        }
    }
    $callback = notifyEnv('TWILIO_STATUS_CALLBACK_URL') !== '' ? notifyEnv('TWILIO_STATUS_CALLBACK_URL') : siteUrl('/api/notify-webhook/twilio');
    $out[] = notifyKeysHttps('the Twilio status callback URL', $callback, 'Twilio can only report delivery to a public https address');
    return $out;
}

function notifyKeysMsg91(): array
{
    $out = [];
    $out[] = notifyEnv('MSG91_AUTH_KEY') !== '' ? ['ok', notifyKeysSet('MSG91_AUTH_KEY')] : ['error', 'MSG91_AUTH_KEY is not set'];
    $out[] = strlen(notifyEnv('MSG91_WEBHOOK_TOKEN')) >= 24
        ? ['ok', notifyKeysSet('MSG91_WEBHOOK_TOKEN')]
        : ['warn', 'MSG91_WEBHOOK_TOKEN is missing or shorter than 24 characters: delivery reports will be refused'];
    $out[] = ['ok', 'sender id, route and DLT entity belong to each flow template in the MSG91 panel; every SMS template needs its DLT template id in the admin'];
    $out[] = notifyKeysHttps('MSG91_BASE_URL', notifyEnv('MSG91_BASE_URL', 'https://control.msg91.com'), 'only a test mock should be plain http');
    return $out;
}

function notifyKeysWebPush(): array
{
    $out = [];
    $public  = notifyEnv('VAPID_PUBLIC_KEY');
    $private = notifyEnv('VAPID_PRIVATE_KEY');
    if ($public === '' && $private === '') {
        $out[] = ['warn', 'VAPID keys are not set: the development pair in notification_kv is used; run `php backend/bin/notify_keys.php vapid` and set your own before going live'];
    } elseif ($public === '' || $private === '') {
        $out[] = ['error', 'set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither'];
    } else {
        $pub  = notifyB64uDecode($public);
        $priv = notifyB64uDecode($private);
        $pubOk  = NotifyEcKeys::isPublicPoint($pub) && NotifyEcKeys::publicKey($pub) !== null;
        $privOk = strlen($priv) === 32;
        $out[] = $pubOk
            ? ['ok', 'VAPID_PUBLIC_KEY is a 65-byte P-256 public key']
            : ['error', 'VAPID_PUBLIC_KEY must be base64url of a 65-byte uncompressed P-256 point (87 characters)'];
        $out[] = $privOk
            ? ['ok', 'VAPID_PRIVATE_KEY is 32 bytes']
            : ['error', 'VAPID_PRIVATE_KEY must be base64url of 32 bytes (43 characters)'];
        if ($pubOk && $privOk) {
            $out[] = NotifyEcKeys::publicFromPrivate($priv) === $pub
                ? ['ok', 'the VAPID public and private keys belong together']
                : ['error', 'VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY'];
        }
    }
    $out[] = preg_match('~^(mailto:[^\s@]+@\S+|https://\S+)$~i', notifyEnv('VAPID_SUBJECT'))
        ? ['ok', 'VAPID_SUBJECT is a mailto: or https: contact']
        : ['warn', 'VAPID_SUBJECT is not set to mailto:… or https://…: MAIL_FROM or the site URL is used instead'];
    $out[] = NotifyEcKeys::generate() !== null
        ? ['ok', 'openssl can create the per-message encryption keys']
        : ['error', 'openssl cannot create P-256 keys here, so push messages cannot be encrypted'];
    return $out;
}

function notifyKeysFcm(): array
{
    $out = [];
    $project = notifyEnv('FCM_PROJECT_ID');
    $out[] = $project === ''
        ? ['error', 'FCM_PROJECT_ID is not set']
        : (preg_match('/^[a-z][a-z0-9-]{4,}$/', $project) ? ['ok', 'FCM_PROJECT_ID has the shape of a project id'] : ['warn', 'FCM_PROJECT_ID does not look like a Firebase project id']);

    $raw = trim(notifyEnv('FCM_SERVICE_ACCOUNT_JSON'));
    if ($raw === '') {
        $out[] = ['error', 'FCM_SERVICE_ACCOUNT_JSON is not set (a path to the key file, or the JSON itself)'];
        return $out;
    }
    if (!str_starts_with($raw, '{')) {
        if (!is_file($raw) || !is_readable($raw)) {
            $out[] = ['error', 'FCM_SERVICE_ACCOUNT_JSON names a file that does not exist or cannot be read'];
            return $out;
        }
        $out[] = ['ok', 'FCM_SERVICE_ACCOUNT_JSON names a readable file'];
        $raw = (string) file_get_contents($raw);
    } else {
        $out[] = ['ok', 'FCM_SERVICE_ACCOUNT_JSON holds inline JSON'];
    }
    $json = json_decode($raw, true);
    if (!is_array($json)) {
        $out[] = ['error', 'the service account JSON does not parse'];
        return $out;
    }
    if (($json['type'] ?? '') !== 'service_account') $out[] = ['warn', 'the JSON "type" is not service_account'];
    $out[] = filter_var($json['client_email'] ?? '', FILTER_VALIDATE_EMAIL)
        ? ['ok', 'client_email is present']
        : ['error', 'client_email is missing or not an address'];
    $key = is_string($json['private_key'] ?? null) ? openssl_pkey_get_private($json['private_key']) : false;
    while (openssl_error_string() !== false) {
        // drain
    }
    $out[] = $key !== false ? ['ok', 'private_key loads'] : ['error', 'private_key is missing or cannot be loaded'];
    if ($project !== '' && isset($json['project_id']) && $json['project_id'] !== $project) {
        $out[] = ['warn', 'the service account belongs to a different project than FCM_PROJECT_ID'];
    }
    $out[] = notifyKeysHttps('FCM_TOKEN_URL', notifyEnv('FCM_TOKEN_URL', 'https://oauth2.googleapis.com/token'), 'only a test mock should be plain http');
    return $out;
}
