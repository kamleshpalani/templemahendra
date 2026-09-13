<?php
/**
 * tests/support/notify_provider_harness.php — drive one notification provider
 * directly, without the queue, so tests/notify-providers.mjs can assert exactly
 * what a provider sends and how it reads each answer. CLI only; refuses to run
 * from a web server.
 *
 *   php tests/support/notify_provider_harness.php <command> '<json>'
 *   php tests/support/notify_provider_harness.php <command> < request.json
 *
 * Commands — each prints one JSON object on stdout and exits 0, or prints
 * {"error": "..."} and exits 1:
 *
 *   send        {"channel","driver","env"?,"core"?,"message":{NotifyMessage fields by name}}
 *               → {"provider","class","configured","result":{status,messageId,reason,response,
 *                  retryAfter,deviceResults,recordedOnly}}
 *   webhook     {"channel","driver","env"?,"method","headers"?,"body"?,"query"?,"url"?}
 *               → {"provider","result": handleWebhook()'s array}
 *   configured  {"channel","driver","env"?} → {"provider","class","configured"}
 *   sendmail    {"env"?,"to","subject"?,"html"?,"text"?,"template"?,"headers"?} → {"result": sendMail()'s array}
 *   core        {} → whether backend/includes/notify.php exists and which service functions it defines
 *   batch       {"ops":[{"command": …, …}, …]} → {"results":[…]} — many cases, one PHP start
 *
 * "env" sets environment variables for that one operation; null unsets one.
 * Whatever an operation set is restored before the next, so batched cases
 * never inherit each other's settings. "core": true loads notify.php (when it
 * exists) first, as the worker would — needed where a provider asks the service
 * for something, such as the development VAPID keys.
 *
 * The database environment comes from the caller (PHP_BIN=php.sh in the suites).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../../backend/includes/notify/contracts.php';
require_once __DIR__ . '/../../backend/includes/db.php';

/** Per-operation environment with restore, so a batch behaves like separate runs. */
final class HarnessEnv
{
    private array $original = [];

    public function apply(array $env): void
    {
        $this->restore();
        foreach ($env as $name => $value) {
            $name = (string) $name;
            if (!preg_match('/^[A-Z][A-Z0-9_]*$/', $name)) throw new InvalidArgumentException("invalid environment variable name: $name");
            if (!array_key_exists($name, $this->original)) {
                $this->original[$name] = [getenv($name), $_ENV[$name] ?? null, $_SERVER[$name] ?? null];
            }
            unset($_ENV[$name], $_SERVER[$name]);
            if ($value === null) {
                putenv($name);
                continue;
            }
            putenv($name . '=' . (is_bool($value) ? ($value ? '1' : '0') : (string) $value));
        }
    }

    public function restore(): void
    {
        foreach ($this->original as $name => [$env, $envArray, $server]) {
            $env === false ? putenv($name) : putenv($name . '=' . $env);
            if ($envArray === null) unset($_ENV[$name]); else $_ENV[$name] = $envArray;
            if ($server === null) unset($_SERVER[$name]); else $_SERVER[$name] = $server;
        }
        $this->original = [];
    }
}

function harnessOut(array $data, int $code = 0): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), "\n";
    exit($code);
}

function harnessLoadCore(): void
{
    $service = __DIR__ . '/../../backend/includes/notify.php';
    if (is_file($service)) require_once $service;
}

function harnessProvider(array $args): NotifyProvider
{
    $channel = (string) ($args['channel'] ?? '');
    if (!in_array($channel, NOTIFY_EXTERNAL_CHANNELS, true)) {
        throw new InvalidArgumentException('channel must be one of ' . implode(', ', NOTIFY_EXTERNAL_CHANNELS));
    }
    return notifyProviderFor($channel, true);
}

function harnessMessage(array $fields, string $channel): NotifyMessage
{
    $known = ['deliveryId', 'notificationId', 'channel', 'lang', 'category', 'priority', 'title', 'body', 'attempt', 'html',
              'ctaUrl', 'ctaLabel', 'imageUrl', 'toEmail', 'toPhone', 'devices', 'providerTemplate', 'templateParams',
              'buttons', 'headers', 'data', 'idempotencyKey'];
    $unknown = array_diff(array_keys($fields), $known);
    if ($unknown !== []) throw new InvalidArgumentException('unknown message field(s): ' . implode(', ', $unknown));
    $defaults = ['deliveryId' => 1, 'notificationId' => 1, 'channel' => $channel, 'lang' => 'en',
                 'category' => 'general', 'priority' => 'normal', 'title' => '', 'body' => ''];
    return new NotifyMessage(...array_merge($defaults, $fields));
}

function harnessResult(NotifyResult $r): array
{
    return [
        'status'        => $r->status,
        'messageId'     => $r->messageId,
        'reason'        => $r->reason,
        'response'      => $r->response,
        'retryAfter'    => $r->retryAfter,
        'deviceResults' => (object) $r->deviceResults,
        'recordedOnly'  => $r->recordedOnly,
    ];
}

function harnessRun(string $command, array $args, HarnessEnv $env): array
{
    $vars = is_array($args['env'] ?? null) ? $args['env'] : [];
    if (isset($args['channel'], $args['driver']) && is_string($args['channel']) && is_string($args['driver'])) {
        $vars['NOTIFY_' . strtoupper($args['channel']) . '_DRIVER'] = $args['driver'];
    }
    $env->apply($vars);
    if (!empty($args['core'])) harnessLoadCore();

    switch ($command) {
        case 'send':
            $provider   = harnessProvider($args);
            $configured = $provider->isConfigured();
            $result     = $provider->send(harnessMessage(is_array($args['message'] ?? null) ? $args['message'] : [], (string) $args['channel']));
            return ['provider' => $provider->name(), 'class' => get_class($provider), 'configured' => $configured, 'result' => harnessResult($result)];

        case 'webhook':
            $provider = harnessProvider($args);
            $result = $provider->handleWebhook(
                strtoupper((string) ($args['method'] ?? 'POST')),
                array_change_key_case(array_map('strval', is_array($args['headers'] ?? null) ? $args['headers'] : []), CASE_LOWER),
                (string) ($args['body'] ?? ''),
                array_map('strval', is_array($args['query'] ?? null) ? $args['query'] : []),
                (string) ($args['url'] ?? 'https://temple.example/api/notify-webhook/' . ($args['driver'] ?? ''))
            );
            return ['provider' => $provider->name(), 'result' => $result];

        case 'configured':
            $provider = harnessProvider($args);
            return ['provider' => $provider->name(), 'class' => get_class($provider), 'configured' => $provider->isConfigured()];

        case 'sendmail':
            require_once __DIR__ . '/../../backend/includes/mailer.php';
            return ['result' => sendMail(
                (string) ($args['to'] ?? ''),
                (string) ($args['subject'] ?? 'E2E providers'),
                (string) ($args['html'] ?? '<p>E2E providers</p>'),
                (string) ($args['text'] ?? 'E2E providers'),
                (string) ($args['template'] ?? 'e2e-providers'),
                is_array($args['headers'] ?? null) ? $args['headers'] : []
            )];

        case 'core':
            harnessLoadCore();
            return [
                'notifyPhp'           => is_file(__DIR__ . '/../../backend/includes/notify.php'),
                'applyProviderUpdate' => function_exists('notifyApplyProviderUpdate'),
                'vapidPublicKey'      => function_exists('notifyVapidPublicKey'),
            ];
    }
    throw new InvalidArgumentException('unknown command; use send, webhook, configured, sendmail, core or batch');
}

$command = $argv[1] ?? '';
$input   = $argv[2] ?? '';
if ($input === '' && !stream_isatty(STDIN)) $input = (string) stream_get_contents(STDIN);
$args = json_decode(trim($input) === '' ? '{}' : $input, true);
if (!is_array($args)) harnessOut(['error' => 'the request must be a JSON object'], 1);

$env = new HarnessEnv();
try {
    if ($command === 'batch') {
        $results = [];
        foreach ((array) ($args['ops'] ?? []) as $op) {
            try {
                if (!is_array($op)) throw new InvalidArgumentException('each op must be an object');
                $results[] = harnessRun((string) ($op['command'] ?? ''), $op, $env);
            } catch (Throwable $e) {
                $results[] = ['error' => get_class($e) . ': ' . $e->getMessage()];
            }
        }
        $env->restore();
        harnessOut(['results' => $results]);
    }
    $out = harnessRun($command, $args, $env);
    $env->restore();
    harnessOut($out);
} catch (Throwable $e) {
    harnessOut(['error' => get_class($e) . ': ' . $e->getMessage()], 1);
}
