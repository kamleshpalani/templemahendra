<?php
/**
 * backend/bin/live_cron.php — asks YouTube about every due broadcast and moves
 * live streams SCHEDULED → STARTING → LIVE → COMPLETED
 * (docs/live/SPEC-PHASE3.md §5.4).
 *
 * Run it from cron every minute. On Hostinger: hPanel → Advanced → Cron Jobs,
 * "Custom", every minute, with the PHP binary the site uses:
 *
 *   /usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php
 *
 * (adjust the path to wherever backend/bin was uploaded). A host without CLI
 * cron can call /api/live-cron over HTTP instead; see api/live_cron.php. The
 * job costs nothing while nothing is scheduled: rows are asked only inside
 * their own window, one YouTube call per run for the lot.
 *
 *   php backend/bin/live_cron.php [--limit=50] [--max-seconds=50]
 *         [--stream-ids=1,2] [--dry-run] [--json]
 *
 * --stream-ids confines a run to those rows, whatever their window (test suites
 * share one database; an empty list matches nothing). --dry-run decides and
 * prints but writes nothing except the quota count of the calls it made. A
 * MySQL lock makes a second run that starts while the first is still going
 * exit at once.
 *
 * Exit status: 0 when the run completed (including "another run holds the
 * lock", "automation is off" and "not installed yet"), 1 on an error.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once __DIR__ . '/../includes/live.php';

$usage = <<<TXT
Usage: php backend/bin/live_cron.php [options]

  --limit=N            check at most N streams (default 50, at most 200)
  --max-seconds=N      stop starting new checks after N seconds (default 50, at most 300)
  --stream-ids=A,B     only these stream ids (any window; an empty list matches nothing)
  --dry-run            decide and report, write nothing but the quota count
  --json               print the result as JSON
  --help               this text

TXT;

$fail = static function (string $message, bool $json): never {
    if ($json) {
        echo json_encode(['error' => $message], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    } else {
        fwrite(STDERR, "live cron: {$message}\n");
    }
    exit(1);
};

$args = array_slice($argv, 1);
$json = in_array('--json', $args, true);
$opts = ['trigger' => 'cli', 'actor' => 'cron'];
foreach ($args as $arg) {
    if ($arg === '--json') continue;
    if ($arg === '--dry-run') {
        $opts['dry_run'] = true;
        continue;
    }
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
            $opts[$name === 'limit' ? 'limit' : 'max_seconds'] = max(1, min($name === 'limit' ? 200 : 300, (int) $value));
            break;
        case 'stream-ids':
            $ids = array_values(array_filter(array_map('trim', explode(',', $value)), static fn($v) => $v !== ''));
            foreach ($ids as $id) {
                if (!ctype_digit($id) || (int) $id < 1) $fail("--stream-ids: \"{$id}\" is not a stream id", $json);
            }
            // Kept even when empty: a scoped run must never widen to every stream (G17).
            $opts['stream_ids'] = array_map('intval', $ids);
            break;
        default:
            $fail("unknown option --{$name}\n\n{$usage}", $json);
    }
}

try {
    if (!liveTablesExist()) $fail('the live streaming tables are missing; apply database/migrations/011_live_streams.sql', $json);
    if (!liveAutomationInstalled()) {
        if ($json) {
            echo json_encode(['skipped' => 1, 'reason' => 'not_installed'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
        } else {
            echo "live cron: automation is not installed (apply database/migrations/012_live_automation.sql); nothing to do.\n";
        }
        exit(0);
    }
    $ready = liveAutomationReady();
    if (!$ready['ok']) {
        if ($json) {
            echo json_encode(['skipped' => 1, 'reason' => (string) ($ready['reason'] ?? 'not_ready')], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
        } else {
            echo 'live cron: automation is not running (' . (string) ($ready['reason'] ?? 'not ready') . "); nothing to do.\n";
        }
        exit(0);
    }
    $result = liveCronRun($opts);
} catch (Throwable $e) {
    error_log('[live cron] ' . get_class($e) . ': ' . liveRedact($e->getMessage()));
    $fail(liveRedact($e->getMessage()), $json);
}

if ($json) {
    echo json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}
if ($result['locked']) {
    echo "live cron: another run holds the lock; nothing to do.\n";
    exit(0);
}
printf(
    "live cron: checked %d, changed %d, started %d, ended %d, errors %d, skipped %d; %d call(s), %d unit(s); %d ms%s\n",
    $result['checked'], $result['changed'], $result['started'], $result['ended'], $result['errors'], $result['skipped'],
    $result['calls'], $result['units'], $result['duration_ms'], !empty($opts['dry_run']) ? ' (dry run)' : ''
);
foreach ($result['items'] as $it) {
    printf(
        "  #%d %s: %s%s (%s%s%s)\n",
        $it['id'], $it['slug'], $it['outcome'], $it['would'] !== null ? ' → would ' . $it['would'] : '',
        $it['from'], $it['to'] !== null ? ' → ' . $it['to'] : '', $it['state'] !== null ? ', YouTube: ' . $it['state'] : ''
    );
}
exit(0);
