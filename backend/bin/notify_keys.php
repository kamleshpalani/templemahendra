<?php
/**
 * backend/bin/notify_keys.php — a settings check for the notification
 * providers. Command line only.
 *
 *   php backend/bin/notify_keys.php check   say which channels are ready, and what is wrong with the rest
 *
 * `check` never prints a secret. It says whether a value is set, how long it is
 * and whether it has the shape the provider needs, and it exits 1 when a
 * channel's configured driver cannot send — so a deploy script can refuse to go
 * live with broken settings, and a committee member can paste the output into a
 * support request without leaking a token.
 *
 * The temple sends on email, WhatsApp and SMS. Web push and its VAPID and FCM
 * keys went with devotee sign-in (docs/registration/SPEC.md §6).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../includes/notify/contracts.php';

$command = $argv[1] ?? '';

switch ($command) {
    case 'check':
        exit(notifyKeysCheck());

    case '':
    case 'help':
    case '-h':
    case '--help':
        echo "Usage:\n"
            . "  php backend/bin/notify_keys.php check   report which notification channels are configured\n";
        exit(0);

    default:
        fwrite(STDERR, "Unknown command \"" . preg_replace('/[^\w-]/', '', $command) . "\". Use check.\n");
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

    foreach (NOTIFY_CHANNELS as $channel) {
        $driver   = notifyDriverName($channel);
        $provider = notifyProviderFor($channel, true);
        try {
            $ready = $provider->isConfigured();
        } catch (Throwable $e) {
            $ready = false;
        }
        echo "\n" . $channel . ' (driver "' . $driver . '"): ' . ($ready ? 'ready' : 'NOT READY') . "\n";

        $checks = match ($driver) {
            'mailer' => notifyKeysMailer(),
            'meta'   => notifyKeysMeta(),
            'twilio' => notifyKeysTwilio($channel),
            'msg91'  => notifyKeysMsg91(),
            'log'    => [['warn', 'the log driver writes messages to backend/logs/notify.log; nothing reaches a devotee']],
            'test'   => [['warn', 'the test driver is for test suites only and must never be used in production']],
            default  => [['error', 'unknown driver: use ' . implode(', ', array_keys(notifyProviderRegistry()[$channel] ?? []))]],
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
    $out[] = ['ok', 'an approved Meta template is sent by name, so every template used for temple updates must include the unsubscribe link itself'];
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
    $out[] = ['ok', 'sender id, route and DLT entity belong to each flow template in the MSG91 panel; every SMS template needs its DLT template id in the admin, and templates for temple updates must include the unsubscribe link'];
    $out[] = notifyKeysHttps('MSG91_BASE_URL', notifyEnv('MSG91_BASE_URL', 'https://control.msg91.com'), 'only a test mock should be plain http');
    return $out;
}
