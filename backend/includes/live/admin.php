<?php
/**
 * backend/includes/live/admin.php — what Admin → Live Streaming needs beyond
 * the store: status badges and labels, the whitelisted list filters, the
 * action buttons a row may offer, and the time-zone list for the form
 * (docs/live/SPEC-PHASE1.md §4.1, §4.5).
 */

/** Badge tone for a status (admin badge tones: muted, info, warning, danger). */
function liveStatusTone(string $status): string
{
    return match ($status) {
        'SCHEDULED'         => 'info',
        'STARTING'          => 'warning',
        'LIVE'              => 'danger',
        'OFFLINE'           => 'warning',
        'ERROR'             => 'danger',
        default             => 'muted', // DRAFT, COMPLETED, CANCELLED, unknown
    };
}

/** True when the badge should carry the pulsing "live" dot. */
function liveStatusIsLive(string $status): bool
{
    return in_array($status, LIVE_LIVE_STATUSES, true);
}

/** "Live now", "Starting soon", … for the committee. */
function liveStatusLabel(string $status): string
{
    return match ($status) {
        'DRAFT'     => 'Draft',
        'SCHEDULED' => 'Scheduled',
        'STARTING'  => 'Starting soon',
        'LIVE'      => 'Live now',
        'COMPLETED' => 'Ended',
        'CANCELLED' => 'Cancelled',
        'OFFLINE'   => 'Offline',
        'ERROR'     => 'Error',
        default     => $status,
    };
}

/** The admin chips, in order: key => label. */
const LIVE_ADMIN_FILTERS = [
    'all'       => 'All',
    'draft'     => 'Draft',
    'scheduled' => 'Scheduled',
    'live'      => 'Live',
    'completed' => 'Completed',
    'cancelled' => 'Cancelled',
    'deleted'   => 'Deleted',
];

/** The sortable columns: key => label. */
const LIVE_ADMIN_SORTS = ['schedule' => 'Schedule', 'title' => 'Title', 'status' => 'Status', 'updated' => 'Updated'];

/**
 * Whitelisted list filters from a query array.
 * @return array{f: string, q: string, sort: string, dir: string, page: int}
 */
function liveAdminFilters(array $get): array
{
    $str = static fn(string $k): string => is_scalar($get[$k] ?? null) ? trim((string) $get[$k]) : '';
    $f    = isset(LIVE_ADMIN_FILTERS[$str('f')]) ? $str('f') : 'all';
    $sort = isset(LIVE_ADMIN_SORTS[$str('sort')]) ? $str('sort') : 'schedule';
    $dir  = strtolower($str('dir')) === 'asc' ? 'asc' : 'desc';
    $page = preg_match('/^\d{1,6}$/', $str('page')) ? max(1, (int) $str('page')) : 1;
    return ['f' => $f, 'q' => mb_substr($str('q'), 0, 100), 'sort' => $sort, 'dir' => $dir, 'page' => $page];
}

/**
 * The status buttons a row offers, one per allowed transition:
 * [['to' => 'LIVE', 'label' => 'Go live', 'icon' => 'activity', 'danger' => bool, 'confirm' => '…?'], …].
 * A deleted row offers none (it has Restore instead). A row without a video
 * id or a start time is not offered Publish, Starting soon or Go live
 * (liveReadyToPublish(); liveSetStatus() would refuse them anyway).
 */
function liveAdminActions(array $row): array
{
    if (!empty($row['deleted_at'])) return [];
    $from  = (string) ($row['status'] ?? '');
    $title = mb_substr((string) ($row['title_en'] ?? ''), 0, 80);
    $ready = liveReadyToPublish($row);
    $out = [];
    foreach (LIVE_TRANSITIONS[$from] ?? [] as $to) {
        if (!$ready && in_array($to, LIVE_VALIDATED_TARGETS, true)) continue;
        [$label, $icon, $danger] = match ($to) {
            'SCHEDULED' => $from === 'DRAFT' ? ['Publish', 'send', false] : ['Reschedule', 'calendar-clock', false],
            'STARTING'  => ['Starting soon', 'clock', false],
            'LIVE'      => in_array($from, ['OFFLINE', 'ERROR'], true) ? ['Back live', 'activity', false] : ['Go live', 'activity', false],
            'COMPLETED' => ['End stream', 'check-circle', false],
            'OFFLINE'   => ['Mark offline', 'alert-circle', false],
            'ERROR'     => ['Mark error', 'alert', true],
            'CANCELLED' => ['Cancel', 'x-circle', true],
            'DRAFT'     => ['Restore to draft', 'undo', false],
            default     => [$to, 'dot', false],
        };
        $confirm = match ($to) {
            'SCHEDULED' => $from === 'DRAFT' ? "Publish “{$title}”? It appears on the Live Darshan page as scheduled." : "Move “{$title}” back to scheduled?",
            'STARTING'  => "Mark “{$title}” as starting soon? Viewers see the player.",
            'LIVE'      => "Go live now for “{$title}”?",
            'COMPLETED' => "End “{$title}”? This cannot be undone.",
            'OFFLINE'   => "Mark “{$title}” as temporarily offline?",
            'ERROR'     => "Mark “{$title}” as unavailable (error)?",
            'CANCELLED' => "Cancel “{$title}”? Viewers see it as cancelled.",
            'DRAFT'     => "Take “{$title}” off the public page and back to draft?",
            default     => "Change the status of “{$title}” to {$to}?",
        };
        $out[] = ['to' => $to, 'label' => $label, 'icon' => $icon, 'danger' => $danger, 'confirm' => $confirm];
    }
    return $out;
}

/**
 * The automation items a row's menu offers (docs/live/SPEC-PHASE3.md §8.4): []
 * when $installed is false, the row is deleted, or its provider is not
 * youtube; otherwise
 *   ['action' => 'sync',       'label' => 'Check now',           'icon' => 'refresh'],
 *   ['action' => 'automation', 'on' => '0', 'label' => 'Switch to manual',    'icon' => 'toggle']
 *   (or 'on' => '1', 'Switch to automatic', when sync_enabled is 0).
 * $installed is an argument, never read inside, so a test can ask for the
 * "012 not applied" menu without touching the database.
 *
 * A sibling of liveAdminActions(), never a change to it: that one's output is
 * exactly the legal status transitions (LIVE_TRANSITIONS), and these items
 * carry no `to`, so the status menu and its tests are untouched.
 */
function liveAdminSyncActions(array $row, bool $installed): array
{
    if (!$installed || !empty($row['deleted_at']) || (string) ($row['provider'] ?? '') !== 'youtube') return [];
    $on = (int) ($row['sync_enabled'] ?? 1) === 1;
    return [
        ['action' => 'sync', 'label' => 'Check now', 'icon' => 'refresh'],
        $on
            ? ['action' => 'automation', 'on' => '0', 'label' => 'Switch to manual', 'icon' => 'toggle']
            : ['action' => 'automation', 'on' => '1', 'label' => 'Switch to automatic', 'icon' => 'toggle'],
    ];
}

/**
 * IANA zones for the form's select, grouped by region with Asia/Kolkata first:
 * ['Asia' => ['Asia/Kolkata', …], 'Europe' => […], …].
 */
function liveTimezoneGroups(): array
{
    static $groups = null;
    if ($groups !== null) return $groups;
    $groups = ['Asia' => ['Asia/Kolkata']];
    foreach (timezone_identifiers_list() as $tz) {
        if ($tz === 'Asia/Kolkata') continue;
        $slash = strpos($tz, '/');
        $region = $slash === false ? 'Other' : substr($tz, 0, $slash);
        $groups[$region][] = $tz;
    }
    $order = ['Asia', 'Europe', 'America', 'Australia', 'Pacific', 'Africa', 'Indian', 'Atlantic', 'Antarctica', 'Arctic', 'Other'];
    uksort($groups, static function (string $a, string $b) use ($order): int {
        $ia = array_search($a, $order, true);
        $ib = array_search($b, $order, true);
        return ($ia === false ? 99 : $ia) <=> ($ib === false ? 99 : $ib) ?: strcmp($a, $b);
    });
    return $groups;
}

/**
 * "14 Sep 2026 · 18:00–19:30 IST" — the schedule of a row in its own zone, for
 * the admin table; '' when nothing is scheduled.
 */
function liveAdminSchedule(array $row): string
{
    $tz = (string) ($row['timezone'] ?? liveTempleTz());
    $start = $row['scheduled_start_at'] ?? null;
    if ($start === null || $start === '') return '';
    $s = liveFromUtc((string) $start, $tz, 'd M Y · H:i');
    $end = $row['scheduled_end_at'] ?? null;
    if ($end !== null && $end !== '') {
        $sameDay = liveFromUtc((string) $start, $tz, 'Y-m-d') === liveFromUtc((string) $end, $tz, 'Y-m-d');
        $s .= '–' . liveFromUtc((string) $end, $tz, $sameDay ? 'H:i' : 'd M Y · H:i');
    }
    return $s . ' ' . liveZoneLabel($tz, (string) $start);
}
