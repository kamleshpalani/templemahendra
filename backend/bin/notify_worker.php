<?php
/**
 * backend/bin/notify_worker.php — sends what the notification queue holds.
 *
 * Run it from cron every minute. On Hostinger: hPanel → Advanced → Cron Jobs,
 * "Custom", every minute, with the PHP binary the site uses:
 *
 *   /usr/bin/php /home/<account>/domains/<site>/public_html/bin/notify_worker.php
 *
 * (adjust the path to wherever backend/bin was uploaded). A host without CLI
 * cron can call /api/notify-cron over HTTP instead; see api/notify_cron.php.
 *
 * Each run stops after --max-seconds, and a MySQL lock makes a second run that
 * starts while the first is still going exit at once, so a slow provider can
 * never pile runs on top of each other.
 *
 *   php backend/bin/notify_worker.php [--max-seconds=50] [--batch=100]
 *         [--channels=email,sms|none] [--notification-ids=1,2] [--campaign-id=9]
 *         [--skip-campaigns] [--skip-reminders] [--expand-limit=500]
 *         [--now="2026-09-13 12:00:00"] [--json]
 *
 * --now moves the service clock for this run (tests only; ignored unless
 * NOTIFY_ALLOW_TEST_DRIVER=1). --notification-ids and --campaign-id confine a
 * run to those rows, which is how test suites share one database.
 *
 * Exit status: 0 when the run completed (including "another run holds the
 * lock"), 1 on an error.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../includes/notify.php';

$usage = <<<TXT
Usage: php backend/bin/notify_worker.php [options]

  --max-seconds=N         stop claiming after N seconds (default 50)
  --batch=N               deliveries claimed at a time per channel (default 100)
  --channels=a,b          only these channels: inapp,email,whatsapp,sms,push, or "none"
  --notification-ids=1,2  only these notifications (no campaigns or reminders)
  --campaign-id=N         only this campaign (expansion and its deliveries)
  --skip-campaigns        do not expand campaigns
  --skip-reminders        do not create reminders
  --expand-limit=N        expand at most N devotees per campaign this run
  --now="Y-m-d H:i:s"     UTC test clock (needs NOTIFY_ALLOW_TEST_DRIVER=1)
  --json                  print the result as JSON
  --help                  this text

TXT;

$fail = static function (string $message, bool $json) use ($usage): never {
    if ($json) {
        echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    } else {
        fwrite(STDERR, "notify worker: {$message}\n");
    }
    exit(1);
};

$args = array_slice($argv, 1);
$json = in_array('--json', $args, true);
$opts = [];
foreach ($args as $arg) {
    if ($arg === '--json') continue;
    if ($arg === '--help' || $arg === '-h') {
        echo $usage;
        exit(0);
    }
    if ($arg === '--skip-campaigns') { $opts['skip_campaigns'] = true; continue; }
    if ($arg === '--skip-reminders') { $opts['skip_reminders'] = true; continue; }
    if (!preg_match('/^--([a-z-]+)=(.*)$/s', $arg, $m)) $fail("unknown option {$arg}\n\n{$usage}", $json);

    [$name, $value] = [$m[1], trim($m[2], " \"'")];
    switch ($name) {
        case 'max-seconds':
        case 'batch':
        case 'expand-limit':
        case 'campaign-id':
            if (!ctype_digit($value)) $fail("--{$name} needs a whole number", $json);
            $opts[str_replace('-', '_', $name)] = (int) $value;
            break;
        case 'channels':
            $list = $value === 'none' || $value === '' ? [] : array_map('trim', explode(',', $value));
            foreach ($list as $c) {
                if (!in_array($c, NOTIFY_CHANNELS, true)) $fail("--channels: unknown channel \"{$c}\"", $json);
            }
            $opts['channels'] = $list;
            break;
        case 'notification-ids':
            $ids = array_map('trim', explode(',', $value));
            foreach ($ids as $id) {
                if (!ctype_digit($id)) $fail('--notification-ids needs a comma-separated list of numbers', $json);
            }
            // Kept even when every id is 0: a scoped run must never widen to the whole queue.
            $opts['notification_ids'] = array_map('intval', $ids);
            break;
        case 'now':
            if (!preg_match('/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/', $value) || strtotime($value . ' UTC') === false) {
                $fail('--now needs a UTC time such as "2026-09-13 12:00:00"', $json);
            }
            $opts['now'] = gmdate('Y-m-d H:i:s', (int) strtotime(str_replace('T', ' ', $value) . ' UTC'));
            break;
        default:
            $fail("unknown option --{$name}\n\n{$usage}", $json);
    }
}
$opts['trigger'] = 'cli';

try {
    $result = notifyWorkerRun($opts);
} catch (Throwable $e) {
    error_log('[notify worker] ' . get_class($e) . ': ' . $e->getMessage());
    $fail($e->getMessage(), $json);
}

if ($json) {
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}
if ($result['locked']) {
    echo "notify worker: another run holds the lock; nothing to do.\n";
    exit(0);
}
printf(
    "notify worker run #%d: claimed %d, sent %d, failed %d, dead %d, rejected %d, skipped %d; campaigns %d, reminders %d; %d ms%s\n",
    $result['run_id'], $result['claimed'], $result['sent'], $result['failed'], $result['dead'], $result['rejected'], $result['skipped'],
    $result['campaigns_expanded'], $result['reminders_created'], $result['duration_ms'],
    $result['error'] ? '; error: ' . $result['error'] : ''
);
exit(0);
