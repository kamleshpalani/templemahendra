<?php
/**
 * backend/includes/live/poll.php — the scheduled job that asks YouTube about
 * every due broadcast and moves rows SCHEDULED → STARTING → LIVE → COMPLETED
 * (docs/live/SPEC-PHASE3.md §5, §6).
 *
 * Reached only from bin/live_cron.php, the keyed /api/live-cron and an admin
 * POST (G19). Every status move goes through livePollApplyMove() and then
 * liveSetStatus() (G20); every other column the job writes goes through
 * liveRecordSync(). The remote call is made outside every transaction; each
 * row is then decided and written under its own FOR UPDATE lock (G23).
 */

/** The cadence of a SCHEDULED row, and of any row carrying a notice, once now is past scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS (§5.5). */
const LIVE_POLL_LATE_SECONDS = 900;

/** Seconds by consecutive failure, ±10 % jitter (§5.5). */
const LIVE_SYNC_BACKOFF = [60, 300, 900, 1800, 3600];

/** Consecutive row failures after which the row's automation is paused (G15). */
const LIVE_SYNC_GIVE_UP_ATTEMPTS = 12;

/** The outcomes that count against one row's sync_attempts (§1). */
const LIVE_SYNC_ROW_FAILURES = ['not_found', 'restricted', 'not_broadcast', 'not_ready', 'refused', 'error'];

/** The outcomes that are the call's fault, never a row's (§1, §5.3 step 9). */
const LIVE_SYNC_CALL_FAILURES = ['rate_limited', 'quota', 'auth', 'request', 'unreachable'];

/** The closed vocabulary of livePollStream() (§1). Anything outside it is a bug. */
const LIVE_SYNC_OUTCOMES = [
    'starting', 'live', 'ended',
    'unchanged', 'overridden', 'paused', 'held', 'mismatch',
    'not_ready', 'refused', 'not_found', 'restricted', 'not_broadcast', 'revoked',
    'rate_limited', 'quota', 'auth', 'request', 'unreachable',
    'not_configured', 'skipped', 'dry_run', 'error',
];

/** The provider states from which no move ever follows (G10). */
const LIVE_POLL_NO_EVIDENCE = ['missing', 'restricted', 'not_broadcast', 'revoked', 'unknown'];

/** The facts on a STARTING row past its grace that pause it (G22). */
const LIVE_POLL_STUCK_STATES = ['upcoming', 'not_broadcast', 'missing'];

/** The columns whose change since the snapshot means the answer is about another broadcast or another decision (G23). */
const LIVE_POLL_FENCE = ['status', 'synced_status', 'sync_enabled', 'provider', 'provider_broadcast_id', 'deleted_at'];

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** A UTC 'Y-m-d H:i:s' as a Unix timestamp, or null for anything else. */
function livePollTs(mixed $utc): ?int
{
    if (!is_string($utc) || $utc === '') return null;
    $t = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $utc, new DateTimeZone('UTC'));
    return ($t !== false && $t->format('Y-m-d H:i:s') === $utc) ? $t->getTimestamp() : null;
}

/** A Unix timestamp as a UTC 'Y-m-d H:i:s'. */
function livePollAt(int $ts): string
{
    return gmdate('Y-m-d H:i:s', $ts);
}

/** "18 Sep 2026 18:00 IST" for a row's instant, in the row's zone. */
function livePollWhen(?string $utc, array $row): string
{
    if ($utc === null || $utc === '') return '?';
    $tz = (string) ($row['timezone'] ?? liveTempleTz());
    $s = liveFromUtc($utc, $tz, 'd M Y H:i');
    return $s === '' ? $utc . ' UTC' : $s . ' ' . liveZoneLabel($tz, $utc);
}

/** 'Stream #12 “Evening deeparadhana”' — the head of every row sentence. */
function livePollName(array $row): string
{
    $title = trim((string) ($row['title_en'] ?? ''));
    if ($title === '') $title = trim((string) ($row['title_ta'] ?? ''));
    return 'Stream #' . (int) ($row['id'] ?? 0) . ' “' . mb_substr($title, 0, 80) . '”';
}

/** G23: true while every LIVE_POLL_FENCE column still reads as the snapshot did. */
function livePollUnchanged(array $snapshot, array $current): bool
{
    foreach (LIVE_POLL_FENCE as $k) {
        if ((string) ($current[$k] ?? '') !== (string) ($snapshot[$k] ?? '')) return false;
    }
    return true;
}

/**
 * The same fence as SQL for a write made from a snapshot without a lock:
 * ['s.status <=> :f_status AND …', [':f_status' => …, …]].
 */
function livePollFenceSql(array $snapshot): array
{
    $where = [];
    $params = [];
    foreach (LIVE_POLL_FENCE as $k) {
        $p = ':f_' . $k;
        $where[] = "s.{$k} <=> {$p}";
        $params[$p] = $snapshot[$k] ?? null;
    }
    return [implode(' AND ', $where), $params];
}

/** The first token of a sync_error (its class), or null. */
function livePollErrorClass(?string $error): ?string
{
    if ($error === null || $error === '') return null;
    $head = strstr($error, ':', true);
    return $head === false ? null : trim($head);
}

/**
 * The live_sync_error audit row: at most once per stream per changed class at
 * the head of sync_error, classes notice and paused excepted (§6.5).
 */
function livePollAuditError(array $row, string $newError, string $actor): void
{
    $class = livePollErrorClass($newError);
    if ($class === null || in_array($class, ['notice', 'paused'], true)) return;
    if ($class === livePollErrorClass($row['sync_error'] ?? null)) return;
    liveAudit('live_sync_error', 'Stream #' . (int) $row['id'], liveRedact($newError, 500), $actor);
}

/* ── Timing ──────────────────────────────────────────────────────────────── */

/** Seconds until the next check after the $failures-th consecutive failure (§5.5). */
function liveBackoffSeconds(int $failures, ?int $retryAfter = null): int
{
    $i    = max(0, min(count(LIVE_SYNC_BACKOFF) - 1, $failures - 1));
    $base = LIVE_SYNC_BACKOFF[$i];
    $jit  = (int) round($base * (random_int(-100, 100) / 1000));    // ±10 %
    $n    = max(LIVE_POLL_MIN_SECONDS, $base + $jit);
    if ($retryAfter !== null) $n = max($n, $retryAfter);            // the provider's own header wins when longer
    return min($n, max(300, (int) liveSetting('backoff_max_seconds', '3600')));
}

/**
 * The next_sync_at an outcome writes, by §5.5's tables: a UTC 'Y-m-d H:i:s',
 * or null for a row that has left the working set. $row is the row as the
 * pass leaves it (status, sync_enabled, sync_error, scheduled_start_at);
 * $failures is the new sync_attempts for a row failure (0 means the answer
 * sat in a notice position and keeps the position cadence), or the streak
 * for a call failure. The `quota` row returns liveQuotaBlockedUntil().
 */
function liveSyncNextAt(array $row, string $outcome, array $cfg, string $now, int $failures = 0, ?int $retryAfter = null): ?string
{
    $nowTs = livePollTs($now) ?? time();
    if ($outcome === 'quota') return liveQuotaBlockedUntil();
    if (in_array($outcome, LIVE_SYNC_CALL_FAILURES, true)) {
        return livePollAt($nowTs + liveBackoffSeconds(max(1, $failures), $retryAfter));
    }
    if (in_array($outcome, ['paused', 'not_configured', 'skipped', 'dry_run'], true)) return null;
    if (in_array($outcome, LIVE_SYNC_ROW_FAILURES, true) && $failures > 0) {
        return livePollAt($nowTs + liveBackoffSeconds($failures));
    }

    // The position cadence P, first matching row wins.
    $status = (string) ($row['status'] ?? '');
    if ($status === 'COMPLETED' || (int) ($row['sync_enabled'] ?? 1) === 0) return null;
    $floor = static fn(int $s): int => max(LIVE_POLL_MIN_SECONDS, $s);
    $sTs = livePollTs($row['scheduled_start_at'] ?? null);
    $graceEnd = $sTs !== null ? $sTs + LIVE_UPCOMING_GRACE_HOURS * 3600 : null;
    $isNotice = str_starts_with((string) ($row['sync_error'] ?? ''), 'notice');
    if ($graceEnd !== null && $nowTs > $graceEnd && ($status === 'SCHEDULED' || $isNotice)) {
        return livePollAt($nowTs + $floor(LIVE_POLL_LATE_SECONDS));
    }
    if ($status === 'STARTING' || $status === 'LIVE') {
        return livePollAt($nowTs + $floor((int) ($cfg['poll_seconds_live'] ?? 60)));
    }
    if ($status === 'SCHEDULED' && $sTs !== null && $nowTs >= $sTs - (int) ($cfg['starting_lead_minutes'] ?? 10) * 60) {
        return livePollAt($nowTs + $floor((int) ($cfg['poll_seconds_live'] ?? 60)));
    }
    return livePollAt($nowTs + $floor((int) ($cfg['poll_seconds_soon'] ?? 300)));
}

/* ── Evidence and decision ───────────────────────────────────────────────── */

/**
 * Pure, G24: is this fact about this row's broadcast? True only when all hold,
 * with S = $row['scheduled_start_at']:
 *  (a) $facts['scheduled_start'], if present, lies in
 *      [S - LIVE_MATCH_SCHEDULE_MINUTES, S + LIVE_MATCH_SCHEDULE_MINUTES];
 *  (b) $facts['actual_start'], if present, lies in
 *      [S - LIVE_MATCH_EARLY_MINUTES, S + LIVE_UPCOMING_GRACE_HOURS];
 *  (c) $facts['channel_expected'], if non-empty, equals $facts['channel_id'];
 *  (d) $facts['actual_end'], if present, is at or after S.
 * Bounds are inclusive. A row with no scheduled_start_at never matches.
 */
function liveProviderMatchesSchedule(array $row, array $facts): bool
{
    $s = livePollTs($row['scheduled_start_at'] ?? null);
    if ($s === null) return false;
    $sStart = livePollTs($facts['scheduled_start'] ?? null);
    if ($sStart !== null && abs($sStart - $s) > LIVE_MATCH_SCHEDULE_MINUTES * 60) return false;
    $aStart = livePollTs($facts['actual_start'] ?? null);
    if ($aStart !== null && ($aStart < $s - LIVE_MATCH_EARLY_MINUTES * 60 || $aStart > $s + LIVE_UPCOMING_GRACE_HOURS * 3600)) return false;
    $expected = trim((string) ($facts['channel_expected'] ?? ''));
    if ($expected !== '' && $expected !== trim((string) ($facts['channel_id'] ?? ''))) return false;
    $aEnd = livePollTs($facts['actual_end'] ?? null);
    if ($aEnd !== null && $aEnd < $s) return false;
    return true;
}

/**
 * Pure: what this fact means for this row — §6.4's order, then §6.2's moves,
 * then G22 and the notice positions (§5.5). No database, no clock beyond $now.
 * pause is null, 'person' (G8) or 'machine' (G22); notice is the N1–N5
 * sentence when the row is in a notice position, else null.
 *
 * @return array{to: ?string, at: ?string, then: ?string, then_at: ?string,
 *               outcome: string, pause: ?string, reason: string, notice: ?string}
 */
function livePollDecide(array $row, array $fact, array $cfg, string $now): array
{
    $out = ['to' => null, 'at' => null, 'then' => null, 'then_at' => null, 'outcome' => 'unchanged', 'pause' => null, 'reason' => '', 'notice' => null];
    $status = (string) ($row['status'] ?? '');
    $state  = (string) ($fact['state'] ?? 'unknown');
    $nowTs  = livePollTs($now) ?? time();
    $sTs    = livePollTs($row['scheduled_start_at'] ?? null);
    $graceEnd = $sTs !== null ? $sTs + LIVE_UPCOMING_GRACE_HOURS * 3600 : null;
    $inGrace  = $graceEnd !== null && $nowTs <= $graceEnd;
    $pastGrace = $graceEnd !== null && $nowTs > $graceEnd;
    $name = livePollName($row);

    // §6.4 step 1: the row's automation is off (a scoped Check now).
    if ((int) ($row['sync_enabled'] ?? 1) === 0) {
        return ['outcome' => 'paused'] + $out;
    }

    // §6.4 steps 2 and 3: the human baseline (G8).
    $base = $row['synced_status'] ?? null;
    $baseRank = is_string($base) ? (LIVE_AUTO_FLOW[$base] ?? null) : null;
    $rank = LIVE_AUTO_FLOW[$status] ?? null;
    if ($baseRank !== null && $rank !== null) {
        if ($rank < $baseRank) {
            return [
                'outcome' => 'paused',
                'pause'   => 'person',
                'reason'  => "Status moved back from {$base} to {$status} by hand; automation paused",
            ] + $out;
        }
        if ($rank > $baseRank) {
            return ['outcome' => 'overridden'] + $out;
        }
    }

    // §6.2: the machine's move.
    $aStart = $fact['actual_start'] ?? null;
    $aEnd   = $fact['actual_end'] ?? null;
    $aEndTs = livePollTs($aEnd);
    $graceOk = $aEndTs !== null && $aEndTs <= $nowTs - (int) ($cfg['complete_grace_seconds'] ?? 120);
    $before = in_array($status, ['SCHEDULED', 'STARTING'], true);
    $candidate = null;   // [to, at, then, then_at, outcome, switch]
    if (!in_array($state, LIVE_POLL_NO_EVIDENCE, true)) {
        if ($before && $state === 'ended' && $aStart !== null && $aEnd !== null && $graceOk) {
            $candidate = ['LIVE', $aStart, 'COMPLETED', $aEnd, 'ended', !empty($cfg['auto_start']) && !empty($cfg['auto_end'])];
        } elseif ($before && $state === 'live' && $aStart !== null) {
            $candidate = ['LIVE', $aStart, null, null, 'live', !empty($cfg['auto_start'])];
        } elseif ($status === 'SCHEDULED' && in_array($state, ['upcoming', 'starting'], true) && $sTs !== null
            && abs($sTs - $nowTs) <= (int) ($cfg['starting_lead_minutes'] ?? 10) * 60) {
            $candidate = ['STARTING', null, null, null, 'starting', !empty($cfg['auto_starting'])];
        } elseif ($status === 'LIVE' && $state === 'ended' && $aEnd !== null && $graceOk) {
            $candidate = ['COMPLETED', $aEnd, null, null, 'ended', !empty($cfg['auto_end'])];
        }
    }
    if ($candidate !== null) {
        [$to, $at, $then, $thenAt, $outcome, $switch] = $candidate;
        if (!liveProviderMatchesSchedule($row, $fact)) {
            $expected = trim((string) ($fact['channel_expected'] ?? ''));
            if ($expected !== '' && $expected !== trim((string) ($fact['channel_id'] ?? ''))) {
                $notice = $name . ': the YouTube video pasted for this broadcast belongs to another YouTube channel — check the video id.';
            } else {
                $theirs = $fact['scheduled_start'] ?? $aStart;
                $notice = $name . ': the YouTube video pasted for this broadcast does not look like it (YouTube\'s start '
                    . livePollWhen(is_string($theirs) ? $theirs : null, $row) . ', ours '
                    . livePollWhen($row['scheduled_start_at'] ?? null, $row) . ') — check the video id.';
            }
            return ['outcome' => 'mismatch', 'notice' => $notice] + $out;
        }
        if (!$switch) return ['outcome' => 'held'] + $out;
        return ['to' => $to, 'at' => $at, 'then' => $then, 'then_at' => $thenAt, 'outcome' => $outcome] + $out;
    }

    // No move. G22: a stuck STARTING row.
    if ($status === 'STARTING' && $pastGrace && in_array($state, LIVE_POLL_STUCK_STATES, true)) {
        return [
            'outcome' => 'paused',
            'pause'   => 'machine',
            'reason'  => 'stuck: this broadcast has been STARTING since ' . livePollWhen($row['scheduled_start_at'] ?? null, $row)
                . ' and YouTube does not report it live',
        ] + $out;
    }

    $outcome = match ($state) {
        'missing'       => 'not_found',
        'restricted'    => 'restricted',
        'not_broadcast' => 'not_broadcast',
        'revoked'       => 'revoked',
        default         => 'unchanged',
    };

    // The notice positions N1, N2, N4, N5 (§5.5); N3 was handled above.
    $notice = null;
    if ($before && $inGrace && $state === 'missing') {
        $notice = $name . ': not visible on YouTube yet (still private, or the id may be wrong).';
    } elseif ($before && $inGrace && $state === 'restricted') {
        $notice = $name . ': the YouTube video is still private or not embeddable; it must be public or unlisted, and embeddable, by the start.';
    } elseif ($status === 'LIVE' && $state !== 'live' && !(in_array($state, ['upcoming', 'starting'], true) && $inGrace)) {
        if (!($state === 'ended' && $aEnd !== null)) {
            $notice = $name . ' is live on the site but YouTube does not report it live — end it by hand if it has finished.';
        }
    } elseif ($status === 'STARTING' && $pastGrace && !in_array($state, LIVE_POLL_STUCK_STATES, true) && $state !== 'live') {
        if (!($state === 'ended' && $aEnd !== null)) {
            $notice = $name . ' has been STARTING since ' . livePollWhen($row['scheduled_start_at'] ?? null, $row)
                . ' and YouTube does not report it live — end or cancel it by hand if it is not happening.';
        }
    }
    return ['outcome' => $outcome, 'notice' => $notice] + $out;
}

/* ── Applying ────────────────────────────────────────────────────────────── */

/**
 * The one call site of every status move the poller makes, the catch-up's
 * two steps included. $row carries the status the step starts from. Checks
 * G7 against LIVE_AUTO_TRANSITIONS, then calls liveSetStatus(). Throws what
 * liveSetStatus() throws; never catches.
 *
 * Its first statement is the fenced test door of §10.1.
 */
function livePollApplyMove(PDO $db, array $row, string $to, ?string $at): void
{
    if (liveSimulatorAllowed() && $to === 'COMPLETED' && (string) ($row['id'] ?? '') === envValue('LIVE_SIM_FAIL_AFTER_LIVE')) {
        throw new RuntimeException('simulated failure after LIVE');
    }
    $from = (string) ($row['status'] ?? '');
    if (!in_array($to, LIVE_AUTO_TRANSITIONS[$from] ?? [], true)) {
        throw new LiveTransitionException('The job may not move a stream ' . $from . ' → ' . $to . '.');
    }
    liveSetStatus($db, (int) $row['id'], $to, (string) ($row['_poll_actor'] ?? 'cron'), $at);
}

/** Internal: the provider-owned columns a usable answer writes (§5.5 "facts"). */
function livePollFacts(array $fact): array
{
    $state = (string) ($fact['state'] ?? 'unknown');
    $facts = ['state' => in_array($state, LIVE_PROVIDER_STATES, true) ? $state : 'unknown'];
    if (in_array($state, ['missing', 'restricted', 'not_broadcast'], true)) return $facts;
    $facts['provider_scheduled_start'] = livePollTs($fact['scheduled_start'] ?? null) !== null ? $fact['scheduled_start'] : null;
    $facts['provider_scheduled_end']   = livePollTs($fact['scheduled_end'] ?? null) !== null ? $fact['scheduled_end'] : null;
    $thumb = liveSafeUrl($fact['thumbnail'] ?? null);
    $facts['provider_thumbnail_url'] = ($thumb !== null && stripos($thumb, 'https://') === 0) ? $thumb : null;
    if (is_int($fact['viewers'] ?? null) && $fact['viewers'] >= 0) $facts['viewers'] = $fact['viewers'];
    $sid = $fact['provider_stream_id'] ?? null;
    if (is_string($sid) && preg_match('/^[A-Za-z0-9_-]{1,100}$/D', $sid)) $facts['provider_stream_id'] = $sid;
    return $facts;
}

/** Internal: the class and committee sentence a row-failure outcome records. */
function livePollFailureText(string $outcome, array $row, string $message = ''): string
{
    $name = livePollName($row);
    return match ($outcome) {
        'not_found'     => 'not_found: ' . $name . ': YouTube did not return this video (deleted, private, or the id may be wrong).',
        'restricted'    => 'config: ' . $name . ': the YouTube video is private or not embeddable; it must be public or unlisted, and embeddable.',
        'not_broadcast' => 'config: ' . $name . ': the YouTube video is not a live broadcast.',
        'not_ready'     => 'config: ' . ($message !== '' ? $message : 'the stream is not ready for that status'),
        'refused'       => 'request: ' . ($message !== '' ? $message : 'that status change is not allowed'),
        default         => 'transient: ' . ($message !== '' ? $message : 'the check failed'),
    };
}

/**
 * One row: lock, compare, decide, apply, record. Never throws (§5.1, §5.3
 * step 13). $row is the snapshot loaded before the remote call; a dry run
 * takes no lock and writes nothing (G18). $now is the run's captured instant
 * (liveUtcNow() when the caller has none).
 *
 * @return array{outcome:string, would:?string, changed:bool, from:string, to:?string, state:?string, error:?string}
 */
function livePollStream(PDO $db, array $row, array $fact, array $cfg, string $actor, bool $dryRun = false, ?string $now = null): array
{
    $now ??= liveUtcNow();
    $id = (int) ($row['id'] ?? 0);
    $from = (string) ($row['status'] ?? '');
    $state = is_string($fact['state'] ?? null) ? $fact['state'] : null;
    $base = ['outcome' => 'unchanged', 'would' => null, 'changed' => false, 'from' => $from, 'to' => null, 'state' => $state, 'error' => null];

    if ($dryRun) {
        $d = livePollDecide($row, $fact, $cfg, $now);
        return ['outcome' => 'dry_run', 'would' => $d['outcome'], 'to' => $d['then'] ?? $d['to'], 'error' => $d['notice']] + $base;
    }

    $row['_poll_actor'] = $actor;
    try {
        return liveTransaction($db, function (PDO $db) use ($row, $fact, $cfg, $actor, $now, $id, $base): array {
            $locked = liveLoad($db, $id, true, true);
            if ($locked === null) return ['outcome' => 'skipped'] + $base;

            // G23: the row changed while the call was in flight.
            if (!livePollUnchanged($row, $locked)) {
                liveRecordSync($db, $id, ['last_synced_at' => $now]);
                return ['outcome' => 'overridden', 'from' => (string) $locked['status']] + $base;
            }

            $locked['_poll_actor'] = $actor;
            $d = livePollDecide($locked, $fact, $cfg, $now);
            $status = (string) $locked['status'];
            $changed = false;
            if ($d['to'] !== null) {
                livePollApplyMove($db, $locked, $d['to'], $d['at']);
                $status = $d['to'];
                $changed = true;
                if ($d['then'] !== null) {
                    $second = $locked;
                    $second['status'] = $d['to'];
                    livePollApplyMove($db, $second, $d['then'], $d['then_at']);
                    $status = $d['then'];
                }
            }

            $rec = livePollFacts($fact) + ['last_synced_at' => $now, 'synced_status' => $status];
            if (
                $changed && $status === 'COMPLETED' && ($locked['recording_url'] ?? null) === null
                && !empty($locked['archive_enabled'])
                && (($fact['recording_status'] ?? null) === null || $fact['recording_status'] === 'recorded')
                && is_string($locked['provider_broadcast_id'] ?? null)
            ) {
                $rec['recording_url'] = liveYoutubeWatchUrl((string) $locked['provider_broadcast_id']);
            }
            $okState = !in_array((string) ($fact['state'] ?? ''), ['missing', 'restricted', 'not_broadcast'], true);
            if ($okState) $rec['last_sync_ok_at'] = $now;
            $after = $locked;
            $after['status'] = $status;
            $outcome = $d['outcome'];
            $error = null;

            if ($outcome === 'paused' && $d['pause'] === null) {
                // Already sync_enabled = 0: facts only; error, attempts and next_sync_at untouched.
                $after['sync_enabled'] = 0;
            } elseif ($outcome === 'paused') {
                liveSetSyncEnabled($db, $id, false, $actor, $d['reason'], $d['pause'] === 'machine');
                $after['sync_enabled'] = 0;
                $rec['attempts'] = 0;
                $rec['next_sync_at'] = null;
            } elseif (in_array($outcome, LIVE_SYNC_ROW_FAILURES, true) && $d['notice'] === null) {
                // A missing, restricted or not_broadcast answer outside a notice position: a row failure.
                $attempts = (int) ($locked['sync_attempts'] ?? 0) + 1;
                $error = livePollFailureText($outcome, $locked);
                if ($attempts >= LIVE_SYNC_GIVE_UP_ATTEMPTS) {
                    liveSetSyncEnabled($db, $id, false, $actor, 'after ' . LIVE_SYNC_GIVE_UP_ATTEMPTS . ' failures: ' . $error, true);
                    $rec['attempts'] = $attempts;
                    $rec['next_sync_at'] = null;
                    $outcome = 'paused';
                } else {
                    livePollAuditError($locked, $error, $actor);
                    $rec['error'] = $error;
                    $rec['attempts'] = $attempts;
                    $rec['next_sync_at'] = liveSyncNextAt($after, $outcome, $cfg, $now, $attempts);
                }
            } else {
                $error = $d['notice'] !== null ? 'notice: ' . $d['notice'] : null;
                $rec['error'] = $error;
                $rec['attempts'] = 0;
                $after['sync_error'] = $error;
                $rec['next_sync_at'] = liveSyncNextAt($after, $outcome, $cfg, $now);
            }
            liveRecordSync($db, $id, $rec);

            return [
                'outcome' => $outcome,
                'changed' => $changed,
                'to'      => $changed ? $status : null,
                'error'   => $error,
            ] + $base;
        });
    } catch (LiveTransitionException $e) {
        $outcome = 'refused';
        $message = $e->getMessage();
    } catch (LiveValidationException $e) {
        $outcome = 'not_ready';
        $message = $e->fields ? implode(' ', array_map(static fn($f, $m): string => "{$f}: {$m}", array_keys($e->fields), $e->fields)) : $e->getMessage();
    } catch (Throwable $e) {
        $outcome = 'error';
        $message = $e->getMessage();
        error_log('[live] poll ' . ($row['slug'] ?? '?') . ' failed: ' . liveRedact($message));
    }

    // A rolled-back row failure, recorded in a separate write under its own
    // lock (§5.5); a row a person changed meanwhile (G23) is left alone, as is
    // a row with sync_enabled = 0.
    $error = livePollFailureText($outcome, $row, liveRedact($message, 250));
    if ((int) ($row['sync_enabled'] ?? 1) === 1) {
        try {
            $written = liveTransaction($db, function (PDO $db) use ($row, $id, $actor, $now, $cfg, $outcome, $error): ?string {
                $locked = liveLoad($db, $id, true, true);
                if ($locked === null || !livePollUnchanged($row, $locked)) return 'overridden';
                $attempts = (int) ($locked['sync_attempts'] ?? 0) + 1;
                if ($attempts >= LIVE_SYNC_GIVE_UP_ATTEMPTS) {
                    liveSetSyncEnabled($db, $id, false, $actor, 'after ' . LIVE_SYNC_GIVE_UP_ATTEMPTS . ' failures: ' . $error, true);
                    liveRecordSync($db, $id, ['attempts' => $attempts, 'last_synced_at' => $now, 'next_sync_at' => null]);
                    return 'paused';
                }
                livePollAuditError($locked, $error, $actor);
                liveRecordSync($db, $id, [
                    'error'          => $error,
                    'attempts'       => $attempts,
                    'last_synced_at' => $now,
                    'next_sync_at'   => liveSyncNextAt($locked, $outcome, $cfg, $now, $attempts),
                ]);
                return null;
            });
            if ($written === 'overridden') return ['outcome' => 'overridden'] + $base;
            if ($written === 'paused') return ['outcome' => 'paused', 'error' => $error] + $base;
        } catch (Throwable $e2) {
            error_log('[live] poll ' . ($row['slug'] ?? '?') . ' could not record its failure: ' . liveRedact($e2->getMessage()));
        }
    }
    return ['outcome' => $outcome, 'error' => $error] + $base;
}

/* ── The sweep and the lock ──────────────────────────────────────────────── */

/**
 * The batch, §5.3. The same array as liveCronRun() without locked/duration_ms.
 */
function livePollSweep(PDO $db, array $opts = []): array
{
    $started = microtime(true);
    $summary = ['checked' => 0, 'changed' => 0, 'started' => 0, 'ended' => 0, 'errors' => 0, 'skipped' => 0, 'calls' => 0, 'units' => 0, 'items' => []];

    // Steps 1–3: nothing to do, no throw, no call. Fresh settings, and a run
    // whose provider audit rows (a revoked or rotated token) name this actor.
    $actor = mb_substr(trim((string) ($opts['actor'] ?? 'cron')), 0, 60) ?: 'cron';
    liveConfigReset();
    liveYoutubeRunStart($actor);
    if (!liveTablesExist() || !liveAutomationInstalled()) return ['skipped' => 1] + $summary;
    if (!liveAutomationReady()['ok']) return ['skipped' => 1] + $summary;
    if (liveQuotaBlockedUntil() !== null) return ['skipped' => 1] + $summary;

    // Step 4: clamps, and the run's one instant.
    $limit      = max(1, min(200, (int) ($opts['limit'] ?? 50)));
    $maxSeconds = max(1, min(300, (int) ($opts['max_seconds'] ?? 50)));
    $trigger    = in_array($opts['trigger'] ?? '', ['cli', 'http', 'admin'], true) ? $opts['trigger'] : 'cli';
    $dryRun     = !empty($opts['dry_run']);
    $cfg        = liveAutomationConfig();
    $now        = liveUtcNow();
    unset($trigger);

    // Steps 5–7: the working set; a scoped run never widens; an empty set costs nothing.
    $scoped = array_key_exists('stream_ids', $opts) && $opts['stream_ids'] !== null;
    $listOpts = ['limit' => $limit, 'lead_minutes' => $cfg['lead_minutes'], 'stale_hours' => $cfg['stale_hours'], 'catchup_hours' => $cfg['catchup_hours']];
    if ($scoped) $listOpts['stream_ids'] = (array) $opts['stream_ids'];
    $ids = $scoped && !$listOpts['stream_ids'] ? [] : liveListDueForSync($db, $listOpts);
    if (!$ids) return $summary;

    $rows = [];
    foreach (array_unique($ids) as $id) {
        $row = liveLoad($db, (int) $id);
        if ($row === null) {
            $summary['skipped']++;
            continue;
        }
        $rows[(int) $id] = $row;
    }
    if (!$rows) return $summary;

    $item = static fn(array $row, string $outcome, ?string $would = null, ?string $to = null, ?string $state = null): array => [
        'id' => (int) $row['id'], 'slug' => (string) ($row['slug'] ?? ''), 'outcome' => $outcome, 'would' => $would,
        'from' => (string) ($row['status'] ?? ''), 'to' => $to, 'state' => $state,
    ];
    $skipAll = static function (array $chunk) use (&$summary, $item): void {
        foreach ($chunk as $row) {
            $summary['skipped']++;
            $summary['items'][] = $item($row, 'skipped');
        }
    };

    // Steps 8–13: one call per chunk, then each row under its own lock.
    $chunks = array_chunk($rows, LIVE_YT_BATCH_MAX, true);
    foreach ($chunks as $i => $chunk) {
        if ($i >= LIVE_YT_MAX_CALLS || microtime(true) - $started > $maxSeconds) {
            $skipAll($chunk);
            continue;
        }
        $answer = liveYoutubeFetchMany($chunk, $dryRun);
        $summary['calls'] += (int) $answer['calls'];
        $summary['units'] += (int) $answer['units'];
        $outcome = $answer['outcome'];

        if ($outcome === 'not_configured') {
            foreach ($chunk as $row) $summary['items'][] = $item($row, 'not_configured');
            continue;
        }
        if ($outcome === 'skipped') {
            $skipAll($chunk);
            continue;
        }
        if ($outcome !== null) {
            // Step 9: a call-level failure is the call's fault, not the broadcast's.
            $notice = (string) ($answer['notice'] ?? '');
            if ($notice === '') $notice = liveProviderConnectionMessage($answer)['text'];
            $class = is_string($answer['class'] ?? null) && $answer['class'] !== '' ? $answer['class'] : 'transient';
            if (!$dryRun) {
                $streak = liveProviderFailStreak($db, $class, $notice);
                $next = liveSyncNextAt([], $outcome, $cfg, $now, $streak, $answer['retry_after'] ?? null);
                [$eligible, $params] = liveSyncEligibleWhere();
                // Only rows still as the snapshot saw them (G23): a row a person
                // changed during the call keeps its own fresh error and due time.
                foreach ($chunk as $rowId => $row) {
                    [$fence, $fenceParams] = livePollFenceSql($row);
                    $sql = 'UPDATE live_streams s
                               SET s.sync_error = :err, s.last_synced_at = :now, s.next_sync_at = :next
                             WHERE s.id = :id AND s.sync_enabled = 1 AND ' . $fence . ' AND ' . $eligible;
                    $db->prepare($sql)->execute($params + $fenceParams + [':id' => (int) $rowId, ':err' => liveRedact($class . ': ' . $notice, 300), ':now' => $now, ':next' => $next]);
                }
            }
            foreach ($chunk as $row) {
                $summary['checked']++;
                $summary['errors']++;
                $summary['items'][] = $dryRun ? $item($row, 'dry_run', $outcome) : $item($row, $outcome);
            }
            continue;
        }

        // The call answered: the streak clears once, then every row gets its own fact.
        if (!$dryRun) liveProviderFailStreak($db, null, (string) ($answer['notice'] ?? ''));
        foreach ($chunk as $id => $row) {
            if (microtime(true) - $started > $maxSeconds) {
                $summary['skipped']++;
                $summary['items'][] = $item($row, 'skipped');
                continue;
            }
            $fact = $answer['answers'][$id] ?? liveYoutubeMissingFact();
            $r = livePollStream($db, $row, $fact, $cfg, $actor, $dryRun, $now);
            $summary['checked']++;
            if ($r['changed']) {
                $summary['changed']++;
                if ($r['outcome'] === 'ended' && $r['from'] !== 'LIVE') $summary['started']++;   // the catch-up
            }
            if ($r['outcome'] === 'live') $summary['started']++;
            if ($r['outcome'] === 'ended') $summary['ended']++;
            if ($r['outcome'] === 'skipped') $summary['skipped']++;
            if ((in_array($r['outcome'], LIVE_SYNC_ROW_FAILURES, true) && !str_starts_with((string) ($r['error'] ?? ''), 'notice'))
                || in_array($r['outcome'], LIVE_SYNC_CALL_FAILURES, true)) {
                $summary['errors']++;
            }
            $summary['items'][] = $item($row, $r['outcome'], $r['would'], $r['to'], $r['state']);
        }
    }
    return $summary;
}

/**
 * One run, under the MySQL advisory lock. getDB() is called exactly once
 * because GET_LOCK is per connection (§5.2).
 *
 * @param array{limit?:int, max_seconds?:int, stream_ids?:?array, dry_run?:bool,
 *              trigger?:string, actor?:string} $opts
 * @return array{checked:int, changed:int, started:int, ended:int, errors:int,
 *               skipped:int, calls:int, units:int, locked:bool,
 *               duration_ms:int, items:array}
 */
function liveCronRun(array $opts = []): array
{
    $started = microtime(true);
    $empty = ['checked' => 0, 'changed' => 0, 'started' => 0, 'ended' => 0, 'errors' => 0, 'skipped' => 0, 'calls' => 0, 'units' => 0, 'items' => []];
    $db = getDB();
    $got = (int) $db->query("SELECT GET_LOCK('temple_live_cron', 0)")->fetchColumn();
    if ($got !== 1) {
        return ['locked' => true, 'duration_ms' => (int) round((microtime(true) - $started) * 1000)] + $empty;
    }
    try {
        $summary = livePollSweep($db, $opts);
    } finally {
        try {
            $db->query("SELECT RELEASE_LOCK('temple_live_cron')")->closeCursor();
        } catch (Throwable) {
            // The connection's end releases it.
        }
    }
    return $summary + ['locked' => false, 'duration_ms' => (int) round((microtime(true) - $started) * 1000)];
}
