<?php
/**
 * backend/includes/live/health.php — one derived health verdict per broadcast,
 * and the dashboard's Live Darshan monitoring summary (Live phases 9 and 10,
 * docs/live/PHASE0-ANALYSIS.md).
 *
 * Nothing here writes. The verdict is read off the columns migration 012
 * already keeps (sync_enabled, sync_error, sync_state, last_synced_at,
 * last_sync_ok_at, viewer_count), so the reserved health_status /
 * last_status_check_at / last_successful_check_at / last_error columns are
 * not added: they would duplicate those four.
 */

/** Levels, worst first; the dashboard sorts and counts by this order. */
const LIVE_HEALTH_LEVELS = ['failed', 'attention', 'paused', 'stale', 'notice', 'manual', 'ok', 'idle'];

/** level => [label, admin badge tone]. */
const LIVE_HEALTH_LABELS = [
    'failed'    => ['Failing',           'danger'],
    'attention' => ['Needs attention',   'warning'],
    'paused'    => ['Automation paused', 'danger'],
    'stale'     => ['Check overdue',     'warning'],
    'notice'    => ['Notice',            'info'],
    'manual'    => ['Manual',            'muted'],
    'ok'        => ['Healthy',           'success'],
    'idle'      => ['Not in rotation',   'muted'],
];

/** The levels that put a row on the dashboard's issues list. */
const LIVE_HEALTH_ISSUE_LEVELS = ['failed', 'attention', 'paused', 'stale'];

/** The statuses the scheduled job keeps checking (LIVE_AUTO_FLOW minus its terminal). */
const LIVE_HEALTH_ROTATION = ['SCHEDULED', 'STARTING', 'LIVE'];

/** Seconds a LIVE / STARTING row may go unchecked, as a multiple of its cadence, before it is stale. */
const LIVE_HEALTH_STALE_FACTOR = 3;

/** The floor under the stale threshold: cron granularity plus one slow run. */
const LIVE_HEALTH_STALE_MIN_SECONDS = 600;

/** What YouTube last said, in words. */
const LIVE_HEALTH_STATE_LABELS = [
    'upcoming'      => 'YouTube: scheduled',
    'starting'      => 'YouTube: about to start',
    'live'          => 'YouTube: live',
    'ended'         => 'YouTube: ended',
    'not_broadcast' => 'YouTube: not a live broadcast',
    'restricted'    => 'YouTube: private or not embeddable',
    'missing'       => 'YouTube: video not found',
    'revoked'       => 'YouTube: credentials refused',
    'unknown'       => 'YouTube: no answer yet',
];

/** The sentence after a sync_error's class token. */
function liveHealthSentence(?string $error): string
{
    $s = trim((string) $error);
    $p = strpos($s, ':');
    return $p === false ? $s : trim(substr($s, $p + 1));
}

/**
 * The verdict for one row. $automation is liveAutomationReady() (passed in so
 * a list of rows costs one settings read); $cfg is liveAutomationConfig().
 *
 * @return array{level: string, label: string, tone: string, reason: string,
 *               state: ?string, checked_at: ?string, ok_at: ?string, checked_seconds_ago: ?int}
 */
function liveHealthOf(array $row, array $automation, array $cfg, ?string $now = null): array
{
    $now ??= liveUtcNow();
    $nowTs = livePollTs($now) ?? time();
    $status = (string) ($row['status'] ?? 'DRAFT');
    $state  = isset($row['sync_state']) && in_array($row['sync_state'], LIVE_PROVIDER_STATES, true) ? (string) $row['sync_state'] : null;
    $checked = isset($row['last_synced_at']) && livePollTs($row['last_synced_at']) !== null ? (string) $row['last_synced_at'] : null;
    $okAt    = isset($row['last_sync_ok_at']) && livePollTs($row['last_sync_ok_at']) !== null ? (string) $row['last_sync_ok_at'] : null;
    $ago     = $checked !== null ? max(0, $nowTs - (int) livePollTs($checked)) : null;
    $error   = trim((string) ($row['sync_error'] ?? ''));
    $class   = livePollErrorClass($error === '' ? null : $error);

    $verdict = static function (string $level, string $reason) use ($state, $checked, $okAt, $ago): array {
        [$label, $tone] = LIVE_HEALTH_LABELS[$level];
        return [
            'level' => $level, 'label' => $label, 'tone' => $tone, 'reason' => $reason,
            'state' => $state, 'checked_at' => liveIso($checked), 'ok_at' => liveIso($okAt), 'checked_seconds_ago' => $ago,
        ];
    };

    // A person parked the broadcast in a state devotees see as unavailable.
    if ($status === 'OFFLINE') return $verdict('attention', 'Marked offline by hand — press Back live when the broadcast resumes, or End it.');
    if ($status === 'ERROR')   return $verdict('attention', 'Marked as an error by hand — press Back live once fixed, or End it.');

    if (!in_array($status, LIVE_HEALTH_ROTATION, true)) return $verdict('idle', '');
    if ((string) ($row['provider'] ?? '') !== 'youtube') return $verdict('manual', 'Not a YouTube broadcast: statuses are set by hand.');

    if ((int) ($row['sync_enabled'] ?? 1) === 0) {
        if ($class === 'paused') return $verdict('paused', liveHealthSentence($error));
        return $verdict('manual', 'Automation switched off for this broadcast.');
    }

    if ($class !== null && $class !== 'notice') {
        $level = match ($class) {
            'auth', 'request'      => 'failed',
            'not_found', 'config'  => 'attention',
            default                => 'notice',   // transient, quota: clear themselves
        };
        return $verdict($level, liveHealthSentence($error));
    }

    if (!$automation['ok']) return $verdict('manual', (string) $automation['reason']);

    // Automation is on and able: is the job actually visiting this row?
    if (in_array($status, ['LIVE', 'STARTING'], true)) {
        $cadence = (int) ($cfg['poll_seconds_live'] ?? 60);
        $limit = max(LIVE_HEALTH_STALE_MIN_SECONDS, $cadence * LIVE_HEALTH_STALE_FACTOR);
        if ($checked === null) return $verdict('stale', 'Never checked while ' . strtolower($status) . ' — is the scheduled job (bin/live_cron.php) running?');
        if ($ago > $limit) return $verdict('stale', 'Last checked ' . liveHealthAgo($ago) . ' ago — is the scheduled job (bin/live_cron.php) running?');
    } elseif ($status === 'SCHEDULED') {
        $sTs = livePollTs($row['scheduled_start_at'] ?? null);
        $lead = (int) ($cfg['lead_minutes'] ?? 30) * 60;
        if ($sTs !== null && $nowTs >= $sTs - $lead) {
            $cadence = (int) ($cfg['poll_seconds_soon'] ?? 300);
            $limit = max(LIVE_HEALTH_STALE_MIN_SECONDS, $cadence * LIVE_HEALTH_STALE_FACTOR);
            if ($checked === null) return $verdict('stale', 'Starts soon and has never been checked — is the scheduled job (bin/live_cron.php) running?');
            if ($ago > $limit) return $verdict('stale', 'Starts soon; last checked ' . liveHealthAgo($ago) . ' ago — is the scheduled job (bin/live_cron.php) running?');
        }
    }

    if ($class === 'notice') return $verdict('notice', liveHealthSentence($error));

    $said = $state !== null ? (LIVE_HEALTH_STATE_LABELS[$state] ?? '') : '';
    return $verdict('ok', $checked === null ? 'Waiting for the first check.' : $said);
}

/** "4 minutes", "2 hours", "3 days" for a number of seconds. */
function liveHealthAgo(int $seconds): string
{
    if ($seconds < 60) return $seconds . ' seconds';
    if ($seconds < 3600) return (int) floor($seconds / 60) . ' minute' . ($seconds >= 120 ? 's' : '');
    if ($seconds < 86400) return (int) floor($seconds / 3600) . ' hour' . ($seconds >= 7200 ? 's' : '');
    return (int) floor($seconds / 86400) . ' day' . ($seconds >= 172800 ? 's' : '');
}

/** liveShapeAdmin() plus its health verdict and the sync facts the committee may see. */
function liveShapeHealth(array $row, array $automation, array $cfg, ?string $now = null): array
{
    $health = liveHealthOf($row, $automation, $cfg, $now);
    return liveShapeAdmin($row) + [
        'health' => $health,
        'sync'   => [
            'enabled'    => (int) ($row['sync_enabled'] ?? 1) === 1,
            'state'      => $health['state'],
            'error'      => ($e = trim((string) ($row['sync_error'] ?? ''))) !== '' ? $e : null,
            'checked_at' => $health['checked_at'],
            'ok_at'      => $health['ok_at'],
            'next_at'    => liveIso($row['next_sync_at'] ?? null),
            'attempts'   => (int) ($row['sync_attempts'] ?? 0),
        ],
        // The committee sees the figure whenever one was stored, with its age;
        // the public shape hides it once stale.
        'viewer_count'    => isset($row['viewer_count']) ? (int) $row['viewer_count'] : null,
        'viewer_count_at' => $health['ok_at'],
    ];
}

/**
 * Everything the dashboard's Live Darshan card shows, in one read:
 *
 *   automation   ready, reason, tier, mode, quota_blocked_until, oauth_revoked_at, provider_notice
 *   last_check_at   the most recent check of any broadcast (ISO Z or null)
 *   now          LIVE / STARTING / OFFLINE / ERROR rows, live first, each with health
 *   next         the next SCHEDULED broadcast, or null
 *   counts       rows in rotation (plus OFFLINE / ERROR) per health level
 *   issues       the rows whose level is in LIVE_HEALTH_ISSUE_LEVELS, worst first, at most $maxIssues
 *   errors_24h   live_sync_error audit rows in the last 24 hours
 */
function liveHealthSummary(PDO $db, int $maxIssues = 5, ?string $now = null): array
{
    $now ??= liveUtcNow();
    $automation = liveAutomationReady();
    $cfg = liveAutomationConfig();

    $rows = $db->query(liveSelectSql() . "
        WHERE s.deleted_at IS NULL AND s.status IN ('LIVE', 'STARTING', 'OFFLINE', 'ERROR', 'SCHEDULED')
        ORDER BY FIELD(s.status, 'LIVE', 'STARTING', 'OFFLINE', 'ERROR', 'SCHEDULED'),
                 (COALESCE(s.actual_start_at, s.scheduled_start_at) IS NULL),
                 CASE WHEN s.status IN ('LIVE', 'OFFLINE', 'ERROR') THEN COALESCE(s.actual_start_at, s.scheduled_start_at) END DESC,
                 s.scheduled_start_at ASC, s.id DESC")->fetchAll();

    $counts = array_fill_keys(LIVE_HEALTH_LEVELS, 0);
    $nowRows = [];
    $issues = [];
    $lastCheck = null;
    foreach ($rows as $row) {
        $shaped = liveShapeHealth($row, $automation, $cfg, $now);
        $counts[$shaped['health']['level']]++;
        if (in_array($row['status'], ['LIVE', 'STARTING', 'OFFLINE', 'ERROR'], true)) $nowRows[] = $shaped;
        if (in_array($shaped['health']['level'], LIVE_HEALTH_ISSUE_LEVELS, true)) $issues[] = $shaped;
        $c = $row['last_synced_at'] ?? null;
        if (is_string($c) && ($lastCheck === null || $c > $lastCheck)) $lastCheck = $c;
    }
    $rank = array_flip(LIVE_HEALTH_LEVELS);
    usort($issues, static fn(array $a, array $b): int => $rank[$a['health']['level']] <=> $rank[$b['health']['level']]);
    $issues = array_slice($issues, 0, max(0, $maxIssues));

    $next = liveNextUpcoming($db);

    $errors24h = 0;
    try {
        $stmt = $db->prepare("SELECT COUNT(*) FROM admin_activity WHERE action = 'live_sync_error' AND created_at >= :since");
        $stmt->execute([':since' => livePollAt((livePollTs($now) ?? time()) - 86400)]);
        $errors24h = (int) $stmt->fetchColumn();
    } catch (Throwable) {
        // Without the audit table the figure is simply 0.
    }

    return [
        'automation' => [
            'ready'               => $automation['ok'],
            'reason'              => $automation['reason'],
            'tier'                => $automation['tier'],
            'mode'                => $cfg['mode'],
            'quota_blocked_until' => liveIso($cfg['quota_blocked_until']),
            'oauth_revoked_at'    => liveIso($cfg['oauth_revoked_at']),
            'provider_notice'     => (string) $cfg['provider_notice'],
        ],
        'last_check_at' => liveIso($lastCheck),
        'now'           => $nowRows,
        'next'          => $next !== null ? liveShapeHealth($next, $automation, $cfg, $now) : null,
        'counts'        => $counts,
        'issues'        => $issues,
        'errors_24h'    => $errors24h,
    ];
}
