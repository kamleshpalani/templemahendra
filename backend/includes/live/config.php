<?php
/**
 * backend/includes/live/config.php — the vocabulary of the Live Darshan module
 * (docs/live/SPEC-PHASE1.md §1, §2; SPEC-PHASE3.md §1) and whether migrations
 * 011 and 012 are applied.
 *
 * Statuses, event types, providers and the status-transition table live here
 * and nowhere else: the admin page, the admin JSON API, the public API and
 * the Phase 3 poller all read these constants, so a stream can never be in a
 * state one of them does not know.
 */

/** Every status a stream can be in. */
const LIVE_STATUSES = ['DRAFT', 'SCHEDULED', 'STARTING', 'LIVE', 'COMPLETED', 'CANCELLED', 'OFFLINE', 'ERROR'];

/** Statuses the public may see (a deleted row is never public whatever its status). */
const LIVE_PUBLIC_STATUSES = ['SCHEDULED', 'STARTING', 'LIVE', 'COMPLETED', 'CANCELLED', 'OFFLINE', 'ERROR'];

/** "Live" for the player and the /live route. */
const LIVE_LIVE_STATUSES = ['LIVE', 'STARTING'];

/** How recent the last good provider check must be for the viewer count to be shown (SPEC-PHASE4 §1). */
const LIVE_VIEWERS_FRESH_SECONDS = 300;

/** key => [Tamil label, English label]. */
const LIVE_EVENT_TYPES = [
    'live_darshan'  => ['நேரடி தரிசனம்',   'Live darshan'],
    'daily_pooja'   => ['தினசரி பூஜை',     'Daily pooja'],
    'abhishekam'    => ['அபிஷேகம்',        'Abhishekam'],
    'deeparadhana'  => ['தீபாராதனை',       'Deeparadhana'],
    'festival'      => ['திருவிழா',        'Festival'],
    'bhajan'        => ['பஜனை',            'Bhajan'],
    'discourse'     => ['சொற்பொழிவு',      'Discourse'],
    'procession'    => ['திருவீதி உலா',    'Procession'],
    'special_event' => ['சிறப்பு நிகழ்வு', 'Special event'],
    'other'         => ['மற்றவை',          'Other'],
];

/** key => label. Only youtube is implemented in Phase 1 (see providers.php). */
const LIVE_PROVIDERS = [
    'youtube' => 'YouTube',
    'vimeo'   => 'Vimeo',
    'aws_ivs' => 'AWS IVS',
    'custom'  => 'Custom URL',
];

/** Providers a stream may be saved with in Phase 1. */
const LIVE_SAVABLE_PROVIDERS = ['youtube', 'custom'];

/**
 * from => [to, …]. Enforced by liveSetStatus(); the admin page's buttons, the
 * JSON API and Phase 3's poller all go through it. COMPLETED is terminal.
 */
const LIVE_TRANSITIONS = [
    'DRAFT'     => ['SCHEDULED', 'CANCELLED'],
    'SCHEDULED' => ['STARTING', 'LIVE', 'CANCELLED', 'DRAFT'],
    'STARTING'  => ['LIVE', 'OFFLINE', 'CANCELLED', 'SCHEDULED'],
    'LIVE'      => ['COMPLETED', 'OFFLINE'],
    'OFFLINE'   => ['LIVE', 'COMPLETED', 'ERROR'],
    'ERROR'     => ['SCHEDULED', 'LIVE', 'CANCELLED'],
    'CANCELLED' => ['SCHEDULED', 'DRAFT'],
    'COMPLETED' => [],
];

/** Slugs the public router uses for itself; a stream can never take one. */
const LIVE_RESERVED_SLUGS = ['live', 'upcoming', 'schedule', 'archive'];

/**
 * The public schedule's filters (docs/live/SPEC-PHASE2.md §1.2): key => [Tamil
 * label, English label], in the order the page shows them. The windows are
 * computed in the temple's zone by liveListSchedule() (store.php).
 */
const LIVE_SCHEDULE_FILTERS = [
    'today'     => ['இன்று',         'Today'],
    'tomorrow'  => ['நாளை',          'Tomorrow'],
    'week'      => ['இந்த வாரம்',    'This week'],
    'festivals' => ['திருவிழாக்கள்', 'Festivals'],
    'all'       => ['அனைத்தும்',     'All'],
];

/** Event types the "Festivals" filter shows. */
const LIVE_FESTIVAL_TYPES = ['festival', 'procession', 'special_event'];

/** How far ahead the "All" and "Festivals" filters look, in days from today. */
const LIVE_SCHEDULE_HORIZON_DAYS = 90;

/**
 * The slug rule (§1). Never all digits: in /api/live-streams/<x> and
 * /live-darshan/<x> a run of digits is an id, so a digits-only slug could
 * never be reached (liveSlugify() appends "-darshan" to such a title).
 */
const LIVE_SLUG_RE = '/^(?![0-9]+$)[a-z0-9][a-z0-9-]{1,118}$/';

/** Statuses a stream may be created in. */
const LIVE_CREATE_STATUSES = ['DRAFT', 'SCHEDULED'];

/*
 * Phase 3 — YouTube API automation (docs/live/SPEC-PHASE3.md §1). The
 * settings vocabulary (LIVE_MODES, LIVE_SETTING_DEFAULTS, the credential maps)
 * is in settings.php; the Data API constants are in youtube.php and the
 * poller's in poll.php.
 */

/**
 * What the provider last said about a broadcast, stored in
 * live_streams.sync_state. SPEC-PHASE3 §6.1 is the only place this vocabulary
 * meets YouTube's.
 */
const LIVE_PROVIDER_STATES = ['upcoming', 'starting', 'live', 'ended', 'not_broadcast', 'restricted', 'missing', 'revoked', 'unknown'];

/**
 * The first token of live_streams.sync_error, named by who acts: nobody
 * (transient clears itself; quota resets at midnight Pacific), the owner
 * (auth), the committee (not_found: the video id; config: the row or the
 * video; paused: the machine switched this row's automation off; notice: a
 * row condition a person should look at, never counted as a failure), or a
 * developer (request).
 */
const LIVE_SYNC_ERROR_CLASSES = ['transient', 'quota', 'auth', 'not_found', 'config', 'request', 'paused', 'notice'];

/** The machine's one-way order, and the rank the human-baseline rule compares (SPEC-PHASE3 §6.4). */
const LIVE_AUTO_FLOW = ['SCHEDULED' => 1, 'STARTING' => 2, 'LIVE' => 3, 'COMPLETED' => 4];

/**
 * from => [to, …]: every status change the scheduled job may make. A strict
 * subset of LIVE_TRANSITIONS, checked before liveSetStatus(); LIVE_TRANSITIONS
 * itself is never widened for the machine (SPEC-PHASE3 §0.2 #5).
 */
const LIVE_AUTO_TRANSITIONS = [
    'SCHEDULED' => ['STARTING', 'LIVE'],
    'STARTING'  => ['LIVE'],
    'LIVE'      => ['COMPLETED'],
];

/** How far YouTube's scheduledStartTime may sit from scheduled_start_at, either side, and still be this broadcast's (G24). */
const LIVE_MATCH_SCHEDULE_MINUTES = 20;

/** How long before scheduled_start_at YouTube's actualStartTime may lie and still be this broadcast's (G24). */
const LIVE_MATCH_EARLY_MINUTES = 60;

/**
 * The fastest per-row cadence in seconds, enforced in code however a setting
 * is written, and the floor on a manual Check now of one row. 10,000 units a
 * day ÷ 86,400 s: one call every 8.64 s exhausts the whole daily pool.
 */
const LIVE_POLL_MIN_SECONDS = 30;

/**
 * True when migration 011 is applied: live_streams, temples and deities all
 * answer. Cached per request; $refresh re-probes (tests that apply the
 * migration mid-run).
 */
function liveTablesExist(bool $refresh = false): bool
{
    static $exists = null;
    if ($refresh) $exists = null;
    if ($exists !== null) return $exists;
    try {
        $db = getDB();
        foreach ([
            'SELECT 1 FROM live_streams LIMIT 0',
            'SELECT 1 FROM temples LIMIT 0',
            'SELECT 1 FROM deities LIMIT 0',
        ] as $sql) {
            $db->query($sql)->closeCursor();
        }
        return $exists = true;
    } catch (Throwable $e) {
        error_log('[live] live streaming tables unavailable (apply database/migrations/011_live_streams.sql): ' . $e->getMessage());
        return $exists = false;
    }
}

/**
 * True when migration 012 is applied: live_settings answers and live_streams
 * has every one of the twelve 012 columns. Cached per request; $refresh re-probes.
 *
 * 012 is a series of separate ALTERs, so a half-applied run must fail the
 * probe: the second statement names all twelve columns. Every Phase 3 entry
 * point checks this first and degrades to Phase 2 behaviour when it is false
 * (docs/live/SPEC-PHASE3.md §2.4).
 */
function liveAutomationInstalled(bool $refresh = false): bool
{
    static $installed = null;
    if ($refresh) $installed = null;
    if ($installed !== null) return $installed;
    try {
        $db = getDB();
        $db->query('SELECT 1 FROM live_settings LIMIT 0')->closeCursor();
        $db->query(
            'SELECT sync_enabled, sync_state, synced_status, last_synced_at, last_sync_ok_at, next_sync_at,
                    sync_attempts, sync_error, provider_thumbnail_url, provider_scheduled_start_at,
                    provider_scheduled_end_at, viewer_count
               FROM live_streams LIMIT 0'
        )->closeCursor();
        return $installed = true;
    } catch (Throwable) {
        error_log('[live] automation tables unavailable (apply database/migrations/012_live_automation.sql)');
        return $installed = false;
    }
}

/**
 * The zone a new stream is scheduled in when none is given: LIVE_TEMPLE_TZ,
 * else the notification service's NOTIFY_TEMPLE_TZ, else Asia/Kolkata.
 */
function liveTempleTz(): string
{
    $tz = trim(envValue('LIVE_TEMPLE_TZ', ''));
    if ($tz !== '' && notifyIsTimezone($tz)) return $tz;
    return notifyTempleTz();
}

/** True for a status name in LIVE_STATUSES. */
function liveIsStatus(mixed $status): bool
{
    return is_string($status) && in_array($status, LIVE_STATUSES, true);
}

/** True when a stream may move from $from to $to (same status counts as allowed, a no-op). */
function liveTransitionAllowed(string $from, string $to): bool
{
    if ($from === $to) return liveIsStatus($from);
    return in_array($to, LIVE_TRANSITIONS[$from] ?? [], true);
}
