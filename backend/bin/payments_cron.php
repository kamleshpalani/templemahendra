<?php
/**
 * backend/bin/payments_cron.php — checks open and unverified online payments
 * with CCAvenue and expires unpaid seva holds (docs/payments/SPEC.md §9.1).
 *
 * Run it from cron every 10 minutes. On Hostinger: hPanel → Advanced → Cron
 * Jobs, "Custom", every 10 minutes, with the PHP binary the site uses:
 *
 *   /usr/bin/php /home/<account>/domains/<site>/public_html/bin/payments_cron.php
 *
 * (adjust the path to wherever backend/bin was uploaded). A host without CLI
 * cron can call /api/payments-cron over HTTP instead; see api/payments_cron.php.
 * The notification worker (bin/notify_worker.php) must also run, every minute,
 * for receipts and payment messages to be sent.
 *
 *   php backend/bin/payments_cron.php [--limit=40] [--max-seconds=50]
 *         [--order-ids=DON-20260914-00001234,SEV-…] [--json]
 *
 * --order-ids confines a run to those attempts, whatever their age (test suites
 * share one database). A MySQL lock makes a second run that starts while the
 * first is still going exit at once.
 *
 * Exit status: 0 when the run completed (including "another run holds the
 * lock"), 1 on an error.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../includes/payments.php';

$usage = <<<TXT
Usage: php backend/bin/payments_cron.php [options]

  --limit=N            check at most N attempts (default 40)
  --max-seconds=N      stop starting new checks after N seconds (default 50)
  --order-ids=A,B      only these order ids (any age)
  --json               print the result as JSON
  --help               this text

TXT;

$fail = static function (string $message, bool $json): never {
    if ($json) {
        echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    } else {
        fwrite(STDERR, "payments cron: {$message}\n");
    }
    exit(1);
};

$args = array_slice($argv, 1);
$json = in_array('--json', $args, true);
$opts = ['trigger' => 'cli', 'actor' => 'cron'];
foreach ($args as $arg) {
    if ($arg === '--json') continue;
    if ($arg === '--help' || $arg === '-h') {
        echo $usage;
        exit(0);
    }
    if (!preg_match('/^--([a-z-]+)=(.*)$/s', $arg, $m)) $fail("unknown option {$arg}\n\n{$usage}", $json);
    [$name, $value] = [$m[1], trim($m[2], " \"'")];
    switch ($name) {
        case 'limit':
        case 'max-seconds':
            if (!ctype_digit($value) || (int) $value < 1) $fail("--{$name} needs a whole number of at least 1", $json);
            $opts[$name === 'limit' ? 'limit' : 'max_seconds'] = (int) $value;
            break;
        case 'order-ids':
            $ids = array_values(array_filter(array_map('trim', explode(',', $value)), static fn($v) => $v !== ''));
            foreach ($ids as $id) {
                if (payParseNumber($id) === null) $fail("--order-ids: \"{$id}\" is not an order id this site issues", $json);
            }
            // Kept even when empty: a scoped run must never widen to every attempt.
            $opts['order_ids'] = $ids;
            break;
        default:
            $fail("unknown option --{$name}\n\n{$usage}", $json);
    }
}

try {
    if (!payTablesExist()) $fail('the payments tables are missing; apply database/migrations/010_payments.sql', $json);
    $result = payCronRun($opts);
} catch (Throwable $e) {
    error_log('[payments cron] ' . get_class($e) . ': ' . $e->getMessage());
    $fail($e->getMessage(), $json);
}

if ($json) {
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}
if ($result['locked']) {
    echo "payments cron: another run holds the lock; nothing to do.\n";
    exit(0);
}
printf(
    "payments cron: checked %d, changed %d, cancelled %d, holds expired %d, errors %d; %d ms\n",
    $result['checked'], $result['changed'], $result['cancelled'], $result['expired'], $result['errors'], $result['duration_ms']
);
exit(0);
