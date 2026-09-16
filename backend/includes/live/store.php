<?php
/**
 * backend/includes/live/store.php — every read and every write of live_streams
 * (docs/live/SPEC-PHASE1.md §4.1, §2).
 *
 * The admin page and the admin JSON API both call these functions, so there is
 * one write path: liveInsert(), liveUpdate(), liveSoftDelete(), liveRestore()
 * and liveSetStatus(). Every write audits through liveAudit() with the
 * signed-in username (or the CLI actor), and every status change goes through
 * liveSetStatus(), which enforces LIVE_TRANSITIONS and stamps actual_start_at
 * / actual_end_at.
 *
 * Rows come back joined with their temple and deity names (temple_*, deity_*
 * columns) so shaping needs no second query.
 */

/** Thrown by liveSetStatus() for a jump LIVE_TRANSITIONS does not allow. */
class LiveTransitionException extends RuntimeException
{
}

/**
 * Thrown by liveSetStatus() when the stored row is not ready for a public
 * status (SCHEDULED, STARTING or LIVE): no video id, no start time, or any
 * other liveValidate() error. $fields is the field => message map the page
 * shows as a flash and the API answers as 422.
 */
class LiveValidationException extends RuntimeException
{
    /** @param array<string, string> $fields */
    public function __construct(public readonly array $fields, string $message = 'The stream is not ready for that status.')
    {
        parent::__construct($message . ($fields ? ' ' . implode(' ', $fields) : ''));
    }
}

/** Statuses a stream may only enter once liveValidate() passes on the stored row (§2). */
const LIVE_VALIDATED_TARGETS = ['SCHEDULED', 'STARTING', 'LIVE'];

/**
 * Write one admin_activity row for a live-stream write. Inside the admin
 * (auth.php loaded) this is adminAudit(), which also records the request's
 * address; from the PHP CLI — the test fixtures, tests/live-unit.php and the
 * future poller — auth.php is not (and must not be) loaded, so the row is
 * inserted here directly. Best effort either way, like adminAudit(): a
 * failed audit never fails the write.
 */
function liveAudit(string $action, string $subject, string $detail, string $actor): void
{
    if (function_exists('adminAudit')) {
        adminAudit($action, $subject, $detail, $actor);
        return;
    }
    try {
        getDB()->prepare('INSERT INTO admin_activity (actor, action, subject, detail, ip) VALUES (:a, :ac, :s, :d, NULL)')
               ->execute([
                   ':a'  => mb_substr($actor !== '' ? $actor : 'cli', 0, 60),
                   ':ac' => mb_substr($action, 0, 60),
                   ':s'  => mb_substr($subject, 0, 200),
                   ':d'  => mb_substr($detail, 0, 500),
               ]);
    } catch (Throwable $e) {
        error_log('[live] audit skipped: ' . $e->getMessage());
    }
}

/**
 * Run $work($db) in a transaction, nested-safe: inside an existing transaction
 * it just runs (the outer owner commits); otherwise it begins, commits, and
 * rolls back and rethrows on any exception.
 */
function liveTransaction(PDO $db, callable $work): mixed
{
    $own = !$db->inTransaction();
    if ($own) $db->beginTransaction();
    try {
        $result = $work($db);
        if ($own) $db->commit();
        return $result;
    } catch (Throwable $e) {
        if ($own && $db->inTransaction()) $db->rollBack();
        throw $e;
    }
}

/** The SELECT every read uses: the stream (alias s) with its temple (t) and deity (d). */
function liveSelectSql(): string
{
    return 'SELECT s.*,
                   t.slug AS temple_slug, t.name_ta AS temple_name_ta, t.name_en AS temple_name_en,
                   t.short_name_ta AS temple_short_name_ta, t.short_name_en AS temple_short_name_en,
                   d.slug AS deity_slug, d.name_ta AS deity_name_ta, d.name_en AS deity_name_en
              FROM live_streams s
              JOIN temples t ON t.id = s.temple_id
              LEFT JOIN deities d ON d.id = s.deity_id';
}

/** One stream by id. Deleted rows only when asked; $lock takes FOR UPDATE inside a transaction. */
function liveLoad(PDO $db, int $id, bool $withDeleted = false, bool $lock = false): ?array
{
    if ($id <= 0) return null;
    $sql = liveSelectSql() . ' WHERE s.id = :id' . ($withDeleted ? '' : ' AND s.deleted_at IS NULL') . ($lock ? ' FOR UPDATE' : '');
    $stmt = $db->prepare($sql);
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/** One non-deleted stream by slug (case-folded). */
function liveLoadBySlug(PDO $db, string $slug): ?array
{
    $s = strtolower(trim($slug));
    if ($s === '' || !preg_match(LIVE_SLUG_RE, $s)) return null;
    $stmt = $db->prepare(liveSelectSql() . ' WHERE LOWER(s.slug) = :slug AND s.deleted_at IS NULL LIMIT 1');
    $stmt->execute([':slug' => $s]);
    $row = $stmt->fetch();
    return $row ?: null;
}

/**
 * Streams that are live now: LIVE first — the most recently started one
 * leading, so it is the one the page features — then STARTING, soonest first.
 */
function liveListLive(PDO $db): array
{
    $stmt = $db->query(liveSelectSql() . "
        WHERE s.deleted_at IS NULL AND s.status IN ('LIVE', 'STARTING')
        ORDER BY " . liveLiveOrderSql());
    return $stmt->fetchAll();
}

/** The ORDER BY of the live list: LIVE first, most recently started leading, then STARTING soonest first. */
function liveLiveOrderSql(): string
{
    return "FIELD(s.status, 'LIVE', 'STARTING'),
            (COALESCE(s.actual_start_at, s.scheduled_start_at) IS NULL),
            CASE WHEN s.status = 'LIVE' THEN COALESCE(s.actual_start_at, s.scheduled_start_at) END DESC,
            s.scheduled_start_at ASC, s.id DESC";
}

/**
 * The one broadcast the page features right now: the LIVE stream that
 * started most recently, else the STARTING one nearest its start, else null
 * (docs/live/SPEC-PHASE2.md §1.2). The index route answers it as `now`.
 */
function liveFeatured(PDO $db): ?array
{
    $stmt = $db->query(liveSelectSql() . "
        WHERE s.deleted_at IS NULL AND s.status IN ('LIVE', 'STARTING')
        ORDER BY " . liveLiveOrderSql() . '
        LIMIT 1');
    $row = $stmt->fetch();
    return $row ?: null;
}

/**
 * How long a SCHEDULED stream stays listed after its start when no end was
 * given: the committee may be late pressing Go live, and a devotee who opens
 * the page then should see the poster, not "nothing scheduled".
 */
const LIVE_UPCOMING_GRACE_HOURS = 3;

/**
 * SCHEDULED streams that have not ended: the end time when one was given,
 * else the start plus LIVE_UPCOMING_GRACE_HOURS, is still ahead of now (a NULL
 * start is listed last). Soonest start first, so one that is running late
 * leads the list.
 */
function liveListUpcoming(PDO $db, int $limit): array
{
    $limit = max(1, min(50, $limit));
    $stmt = $db->prepare(liveSelectSql() . "
        WHERE s.deleted_at IS NULL AND s.status = 'SCHEDULED'
          AND (s.scheduled_start_at IS NULL
               OR COALESCE(s.scheduled_end_at, s.scheduled_start_at + INTERVAL " . LIVE_UPCOMING_GRACE_HOURS . " HOUR) >= :now)
        ORDER BY (s.scheduled_start_at IS NULL), s.scheduled_start_at ASC, s.id ASC
        LIMIT " . $limit);
    $stmt->execute([':now' => liveUtcNow()]);
    return $stmt->fetchAll();
}

/**
 * The first upcoming broadcast (the §1 "upcoming" rule: SCHEDULED and not
 * over, soonest start first), or null. The index route answers it as `next`.
 */
function liveNextUpcoming(PDO $db): ?array
{
    return liveListUpcoming($db, 1)[0] ?? null;
}

/* ── The public schedule (docs/live/SPEC-PHASE2.md §1.2) ──────────────── */

/**
 * The window one schedule filter covers, computed on the temple's wall clock:
 * ['filter' => the resolved key, 'from' / 'to' => UTC 'Y-m-d H:i:s' (`to`
 * exclusive), 'today' / 'tomorrow' => local dates, 'festivals' => bool (event
 * type restricted), 'undated' => bool (SCHEDULED rows without a start are
 * listed too), 'label_ta' / 'label_en']. An unknown filter is `all`.
 *
 *   today      the local day
 *   tomorrow   the next local day
 *   week       today through the coming Sunday inclusive
 *   festivals  today through today + LIVE_SCHEDULE_HORIZON_DAYS, festival types only
 *   all        today through today + LIVE_SCHEDULE_HORIZON_DAYS, plus undated SCHEDULED rows
 *
 * Streams that are live (LIVE, STARTING) belong to every window except
 * `tomorrow` — they are happening today — and to `festivals` only when they
 * are of a festival type.
 */
function liveScheduleWindow(string $filter, string $tz, ?string $today = null): array
{
    $key = strtolower(trim($filter));
    if (!isset(LIVE_SCHEDULE_FILTERS[$key])) $key = 'all';
    if (!liveIsTimezone($tz)) $tz = liveTempleTz();
    $today    = $today !== null && liveShiftDateLocal($today, 0, $tz) !== null ? $today : liveTodayLocal($tz);
    $tomorrow = (string) liveShiftDateLocal($today, 1, $tz);
    $horizon  = (string) liveShiftDateLocal($today, LIVE_SCHEDULE_HORIZON_DAYS, $tz);
    $range = match ($key) {
        'today'    => liveDayRangeUtc($today, $tz),
        'tomorrow' => liveDayRangeUtc($tomorrow, $tz),
        'week'     => liveWeekRangeUtc($today, $tz),
        default    => ['from' => liveDayRangeUtc($today, $tz)['from'], 'to' => liveDayRangeUtc($horizon, $tz)['to']],
    };
    [$labelTa, $labelEn] = LIVE_SCHEDULE_FILTERS[$key];
    return [
        'filter'    => $key,
        'from'      => (string) ($range['from'] ?? ''),
        'to'        => (string) ($range['to'] ?? ''),
        'today'     => $today,
        'tomorrow'  => $tomorrow,
        'timezone'  => $tz,
        'festivals' => $key === 'festivals',
        'undated'   => $key === 'all',
        'live'      => $key !== 'tomorrow',
        'label_ta'  => $labelTa,
        'label_en'  => $labelEn,
    ];
}

/**
 * The SQL membership test of one window (a fragment on alias s) and its
 * parameters, suffixed so several windows can share one statement.
 * @return array{0: string, 1: array<string, string>}
 */
function liveScheduleWhereSql(array $window, string $suffix = ''): array
{
    $public = "'" . implode("','", LIVE_PUBLIC_STATUSES) . "'";
    // A live broadcast is happening today whatever its schedule said (its
    // day_bucket is "today"): a window that does not take live rows must
    // not list one by its date either.
    $inWindow = "(s.scheduled_start_at >= :from{$suffix} AND s.scheduled_start_at < :to{$suffix}" . ($window['live'] ? '' : " AND s.status NOT IN ('LIVE', 'STARTING')") . ')';
    $parts = [$inWindow];
    if ($window['live']) $parts[] = "s.status IN ('LIVE', 'STARTING')";
    if ($window['undated']) $parts[] = "(s.scheduled_start_at IS NULL AND s.status = 'SCHEDULED')";
    $sql = "s.deleted_at IS NULL AND s.status IN ({$public}) AND (" . implode(' OR ', $parts) . ')';
    if ($window['festivals']) $sql .= " AND s.event_type IN ('" . implode("','", LIVE_FESTIVAL_TYPES) . "')";
    return [$sql, [":from{$suffix}" => $window['from'], ":to{$suffix}" => $window['to']]];
}

/**
 * The public schedule for one filter: the rows in the window (live first —
 * the live list's own order — then by start ascending, an undated row last,
 * and a COMPLETED broadcast after the others of its day), the window, and the
 * row count of every filter for the page's tabs.
 *
 * @return array{rows: array, window: array, counts: array<string, int>}
 */
function liveListSchedule(PDO $db, string $filter, int $limit, string $tz): array
{
    $limit  = max(1, min(100, $limit));
    $window = liveScheduleWindow($filter, $tz);
    $tz     = $window['timezone'];
    [$where, $params] = liveScheduleWhereSql($window);
    $stmt = $db->prepare(liveSelectSql() . " WHERE {$where}
        ORDER BY (s.status IN ('LIVE', 'STARTING')) DESC,
                 " . liveLiveOrderSql() . ',
                 (s.scheduled_start_at IS NULL), s.scheduled_start_at ASC, s.id ASC
        LIMIT ' . $limit);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    // The day a broadcast belongs to is a local date; MySQL cannot say it
    // without its zone tables, so the within-day rule is applied here (the
    // sort is stable, and the SQL order already holds the rest).
    $dayOf = static function (array $r) use ($tz): string {
        if (in_array((string) $r['status'], LIVE_LIVE_STATUSES, true)) return '';
        $start = $r['scheduled_start_at'] ?? null;
        return $start === null ? '9999-99-99' : liveFromUtc((string) $start, $tz, 'Y-m-d');
    };
    usort($rows, static function (array $a, array $b) use ($dayOf): int {
        $la = in_array((string) $a['status'], LIVE_LIVE_STATUSES, true);
        $lb = in_array((string) $b['status'], LIVE_LIVE_STATUSES, true);
        if ($la !== $lb) return $la ? -1 : 1;
        if ($la) return 0;
        $c = strcmp($dayOf($a), $dayOf($b));
        if ($c !== 0) return $c;
        $ea = (string) $a['status'] === 'COMPLETED';
        $eb = (string) $b['status'] === 'COMPLETED';
        if ($ea !== $eb) return $ea ? 1 : -1;
        return [(string) ($a['scheduled_start_at'] ?? '9999'), (int) $a['id']] <=> [(string) ($b['scheduled_start_at'] ?? '9999'), (int) $b['id']];
    });

    return ['rows' => $rows, 'window' => $window, 'counts' => liveScheduleCounts($db, $tz, $window['today'])];
}

/** How many streams each filter lists (the page's tab counts), in one query. */
function liveScheduleCounts(PDO $db, string $tz, ?string $today = null): array
{
    $sums = [];
    $params = [];
    foreach (array_keys(LIVE_SCHEDULE_FILTERS) as $i => $key) {
        [$sql, $p] = liveScheduleWhereSql(liveScheduleWindow($key, $tz, $today), (string) $i);
        $sums[] = "COALESCE(SUM({$sql}), 0) AS `{$key}`";
        $params += $p;
    }
    $stmt = $db->prepare('SELECT ' . implode(', ', $sums) . ' FROM live_streams s');
    $stmt->execute($params);
    $r = $stmt->fetch() ?: [];
    $out = [];
    foreach (array_keys(LIVE_SCHEDULE_FILTERS) as $key) $out[$key] = (int) ($r[$key] ?? 0);
    return $out;
}

/**
 * Which day a broadcast falls on for the schedule, on the wall clock of a
 * zone: today, tomorrow, later or past. A live broadcast is happening today
 * whatever its schedule said; one without a start is "later".
 */
function liveDayBucket(array $row, string $tz, ?string $today = null): string
{
    if (in_array((string) ($row['status'] ?? ''), LIVE_LIVE_STATUSES, true)) return 'today';
    $start = $row['scheduled_start_at'] ?? null;
    if ($start === null || trim((string) $start) === '') return 'later';
    if (!liveIsTimezone($tz)) $tz = liveTempleTz();
    $today ??= liveTodayLocal($tz);
    $date = liveFromUtc((string) $start, $tz, 'Y-m-d');
    if ($date === '') return 'later';
    if ($date < $today) return 'past';
    if ($date === $today) return 'today';
    if ($date === liveShiftDateLocal($today, 1, $tz)) return 'tomorrow';
    return 'later';
}

/**
 * Seconds until the scheduled start by the server's clock (negative once it
 * has passed), or null when there is no start or the broadcast is already
 * live. The countdown on the page uses this together with server_time.
 */
function liveStartsInSeconds(array $row): ?int
{
    if (in_array((string) ($row['status'] ?? ''), LIVE_LIVE_STATUSES, true)) return null;
    $start = $row['scheduled_start_at'] ?? null;
    if ($start === null || trim((string) $start) === '') return null;
    $at = strtotime(trim((string) $start) . ' UTC');
    if ($at === false) return null;
    return $at - (int) strtotime(liveUtcNow() . ' UTC');
}

/** The public shape plus the two schedule keys, day_bucket and starts_in_seconds. */
function liveShapeSchedule(array $row, string $tz, ?string $today = null): array
{
    return liveShapePublic($row) + [
        'day_bucket'        => liveDayBucket($row, $tz, $today),
        'starts_in_seconds' => liveStartsInSeconds($row),
    ];
}

/** WHERE clause and params for one admin chip: all, draft, scheduled, live, completed, cancelled, deleted. */
function liveAdminWhereFor(string $f): array
{
    return match ($f) {
        'draft'     => ["s.deleted_at IS NULL AND s.status = 'DRAFT'", []],
        'scheduled' => ["s.deleted_at IS NULL AND s.status = 'SCHEDULED'", []],
        'live'      => ["s.deleted_at IS NULL AND s.status IN ('LIVE', 'STARTING', 'OFFLINE', 'ERROR')", []],
        'completed' => ["s.deleted_at IS NULL AND s.status = 'COMPLETED'", []],
        'cancelled' => ["s.deleted_at IS NULL AND s.status = 'CANCELLED'", []],
        'deleted'   => ['s.deleted_at IS NOT NULL', []],
        default     => ['s.deleted_at IS NULL', []],
    };
}

/**
 * The admin list: filtered (liveAdminFilters), sorted, paginated.
 * @return array{rows: array, total: int, pages: int, page: int}
 */
function liveListAdmin(PDO $db, array $filters, int $page, int $perPage = 25): array
{
    [$whereSql, $params] = liveAdminWhereFor((string) ($filters['f'] ?? 'all'));
    $where = [$whereSql];
    $q = trim((string) ($filters['q'] ?? ''));
    if ($q !== '') {
        $like = '%' . addcslashes($q, '%_\\') . '%';
        $where[] = '(s.title_en LIKE :q1 OR s.title_ta LIKE :q2 OR s.slug LIKE :q3 OR s.provider_broadcast_id LIKE :q4)';
        $params += [':q1' => $like, ':q2' => $like, ':q3' => $like, ':q4' => $like];
    }
    $dir = strtolower((string) ($filters['dir'] ?? 'desc')) === 'asc' ? 'ASC' : 'DESC';
    $order = match ((string) ($filters['sort'] ?? 'schedule')) {
        'title'   => "s.title_en $dir, s.id $dir",
        'status'  => "s.status $dir, COALESCE(s.scheduled_start_at, s.created_at) DESC, s.id DESC",
        'updated' => "s.updated_at $dir, s.id $dir",
        default   => "COALESCE(s.scheduled_start_at, s.created_at) $dir, s.id $dir",
    };
    $sql = liveSelectSql() . ' WHERE ' . implode(' AND ', $where) . ' ORDER BY ' . $order;
    $count = 'SELECT COUNT(*) FROM live_streams s WHERE ' . implode(' AND ', $where);
    return livePaginate($db, $sql, $params, $page, $perPage, $count);
}

/**
 * Run a paginated query (the shape of adminPaginate(), kept here so the JSON
 * API and the unit tests need no admin UI file). $sql has no LIMIT.
 * @return array{rows: array, total: int, pages: int, page: int}
 */
function livePaginate(PDO $db, string $sql, array $params, int $page, int $perPage, string $countSql): array
{
    $perPage = max(1, min(100, $perPage));
    $page    = max(1, $page);
    $stmt = $db->prepare($countSql);
    $stmt->execute($params);
    $total = (int) $stmt->fetchColumn();
    $pages = max(1, (int) ceil($total / $perPage));
    $page  = min($page, $pages);
    $stmt  = $db->prepare($sql . ' LIMIT ' . $perPage . ' OFFSET ' . (($page - 1) * $perPage));
    $stmt->execute($params);
    return ['rows' => $stmt->fetchAll(), 'total' => $total, 'pages' => $pages, 'page' => $page];
}

/** Row counts per admin chip. */
function liveAdminCounts(PDO $db): array
{
    $r = $db->query("SELECT
            COALESCE(SUM(deleted_at IS NULL), 0) AS `all`,
            COALESCE(SUM(deleted_at IS NULL AND status = 'DRAFT'), 0) AS draft,
            COALESCE(SUM(deleted_at IS NULL AND status = 'SCHEDULED'), 0) AS scheduled,
            COALESCE(SUM(deleted_at IS NULL AND status IN ('LIVE','STARTING','OFFLINE','ERROR')), 0) AS live,
            COALESCE(SUM(deleted_at IS NULL AND status = 'COMPLETED'), 0) AS completed,
            COALESCE(SUM(deleted_at IS NULL AND status = 'CANCELLED'), 0) AS cancelled,
            COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted
        FROM live_streams")->fetch() ?: [];
    $out = [];
    foreach (['all', 'draft', 'scheduled', 'live', 'completed', 'cancelled', 'deleted'] as $k) $out[$k] = (int) ($r[$k] ?? 0);
    return $out;
}

/** The writable columns, in the order the INSERT/UPDATE names them. */
const LIVE_WRITE_COLUMNS = [
    'temple_id', 'deity_id', 'title_ta', 'title_en', 'slug', 'description_ta', 'description_en',
    'event_type', 'provider', 'provider_broadcast_id', 'playback_url', 'thumbnail_url', 'banner_url',
    'scheduled_start_at', 'scheduled_end_at', 'timezone',
    'is_featured', 'show_on_homepage', 'donations_enabled', 'notifications_enabled', 'sharing_enabled', 'archive_enabled',
];

/** Audit detail text: the title and a list, clipped to the column. */
function liveAuditDetail(string $lead, array $row, array $extra = []): string
{
    $title = mb_substr((string) ($row['title_en'] ?? ''), 0, 120);
    $s = $lead . ' “' . $title . '”';
    if ($extra) $s .= ' — ' . implode(', ', $extra);
    return mb_substr($s, 0, 500);
}

/**
 * Create a stream from liveValidate() values (status DRAFT or SCHEDULED).
 * Returns the new id. Audits live_stream_create.
 */
function liveInsert(PDO $db, array $values, string $actor): int
{
    return liveTransaction($db, function (PDO $db) use ($values, $actor): int {
        $now = liveUtcNow();
        $cols = LIVE_WRITE_COLUMNS;
        $params = [];
        foreach ($cols as $c) $params[':' . $c] = $values[$c] ?? null;
        $status = liveIsStatus($values['status'] ?? null) && in_array($values['status'], LIVE_CREATE_STATUSES, true) ? $values['status'] : 'DRAFT';
        $by = mb_substr($actor, 0, 60);
        $params += [':status' => $status, ':created_by' => $by, ':updated_by' => $by, ':created_at' => $now, ':updated_at' => $now];
        $sql = 'INSERT INTO live_streams (' . implode(', ', $cols) . ', status, created_by, updated_by, created_at, updated_at)
                VALUES (' . implode(', ', array_map(static fn(string $c): string => ':' . $c, $cols)) . ', :status, :created_by, :updated_by, :created_at, :updated_at)';
        $db->prepare($sql)->execute($params);
        $id = (int) $db->lastInsertId();
        liveAudit('live_stream_create', 'Stream #' . $id, liveAuditDetail('Created', $values, [
            'status ' . $status, 'slug ' . (string) ($values['slug'] ?? ''), 'provider ' . (string) ($values['provider'] ?? ''),
        ]), $actor);
        return $id;
    });
}

/**
 * Update a stream from liveValidate() values. Columns are written first; a
 * changed status then goes through liveSetStatus() in the same transaction, so
 * an illegal jump (LiveTransitionException) rolls the whole save back.
 * Audits live_stream_update naming the changed fields.
 */
function liveUpdate(PDO $db, int $id, array $values, string $actor): void
{
    liveTransaction($db, function (PDO $db) use ($id, $values, $actor): void {
        $existing = liveLoad($db, $id, false, true);
        if ($existing === null) throw new RuntimeException('That stream no longer exists.');
        $now = liveUtcNow();
        $changed = [];
        $sets = [];
        $params = [':id' => $id, ':by' => mb_substr($actor, 0, 60), ':now' => $now];
        foreach (LIVE_WRITE_COLUMNS as $c) {
            if (!array_key_exists($c, $values)) continue;
            $new = $values[$c];
            $old = $existing[$c] ?? null;
            $same = ($new === null && $old === null) || ($new !== null && $old !== null && (string) $new === (string) $old);
            if (!$same) $changed[] = $c;
            $sets[] = "$c = :$c";
            $params[':' . $c] = $new;
        }
        if ($sets) {
            $db->prepare('UPDATE live_streams SET ' . implode(', ', $sets) . ', updated_by = :by, updated_at = :now WHERE id = :id')->execute($params);
        }
        $to = isset($values['status']) && liveIsStatus($values['status']) ? (string) $values['status'] : (string) $existing['status'];
        $statusChanged = false;
        if ($to !== (string) $existing['status']) {
            $r = liveSetStatus($db, $id, $to, $actor);
            $statusChanged = $r['changed'];
        }
        if ($changed || !$statusChanged) {
            liveAudit('live_stream_update', 'Stream #' . $id, liveAuditDetail('Updated', $values + $existing, [
                $changed ? 'changed ' . implode(', ', $changed) : 'no field changed',
            ]), $actor);
        }
    });
}

/** Soft-delete a stream. False when it does not exist or is already deleted. Audits live_stream_delete. */
function liveSoftDelete(PDO $db, int $id, string $actor): bool
{
    return liveTransaction($db, function (PDO $db) use ($id, $actor): bool {
        $row = liveLoad($db, $id, false, true);
        if ($row === null) return false;
        $db->prepare('UPDATE live_streams SET deleted_at = :now, updated_by = :by, updated_at = :now2 WHERE id = :id AND deleted_at IS NULL')
           ->execute([':now' => liveUtcNow(), ':by' => mb_substr($actor, 0, 60), ':now2' => liveUtcNow(), ':id' => $id]);
        liveAudit('live_stream_delete', 'Stream #' . $id, liveAuditDetail('Deleted', $row, ['status ' . $row['status'], 'slug ' . $row['slug']]), $actor);
        return true;
    });
}

/** Bring a soft-deleted stream back. False when it is not deleted. Audits live_stream_restore. */
function liveRestore(PDO $db, int $id, string $actor): bool
{
    return liveTransaction($db, function (PDO $db) use ($id, $actor): bool {
        $row = liveLoad($db, $id, true, true);
        if ($row === null || $row['deleted_at'] === null) return false;
        $db->prepare('UPDATE live_streams SET deleted_at = NULL, updated_by = :by, updated_at = :now WHERE id = :id')
           ->execute([':by' => mb_substr($actor, 0, 60), ':now' => liveUtcNow(), ':id' => $id]);
        liveAudit('live_stream_restore', 'Stream #' . $id, liveAuditDetail('Restored', $row, ['status ' . $row['status']]), $actor);
        return true;
    });
}

/**
 * Move a stream to another status. The only function that changes status:
 * it enforces LIVE_TRANSITIONS, stamps actual_start_at on the first entry into
 * LIVE and actual_end_at on COMPLETED, and audits live_stream_status.
 *
 * Entering SCHEDULED, STARTING or LIVE (LIVE_VALIDATED_TARGETS) also runs
 * liveValidate() on the stored row with the target status, so a draft without
 * a video id or a start time cannot be published by a button, the API or the
 * poller — the same rule the form applies when it saves a non-draft status.
 *
 * @return array{changed: bool, from: string, to: string}
 * @throws LiveTransitionException when the jump is not allowed
 * @throws LiveValidationException when the row is not ready for the target status
 * @throws RuntimeException when the stream does not exist (or is deleted)
 */
function liveSetStatus(PDO $db, int $id, string $to, string $actor): array
{
    $to = strtoupper(trim($to));
    return liveTransaction($db, function (PDO $db) use ($id, $to, $actor): array {
        $row = liveLoad($db, $id, false, true);
        if ($row === null) throw new RuntimeException('That stream no longer exists.');
        $from = (string) $row['status'];
        if ($from === $to) return ['changed' => false, 'from' => $from, 'to' => $to];
        if (!liveIsStatus($to) || !liveTransitionAllowed($from, $to)) {
            throw new LiveTransitionException('That status change is not allowed (' . $from . ' → ' . $to . ').');
        }
        if (in_array($to, LIVE_VALIDATED_TARGETS, true)) {
            $in = liveRowToInput($row);
            $in['status'] = $to;
            $checked = liveValidate($in, $row, $db);
            if ($checked['errors']) throw new LiveValidationException($checked['errors']);
        }
        $now = liveUtcNow();
        $sets = ['status = :to', 'updated_by = :by', 'updated_at = :now'];
        $params = [':to' => $to, ':by' => mb_substr($actor, 0, 60), ':now' => $now, ':id' => $id];
        if ($to === 'LIVE' && $row['actual_start_at'] === null) {
            $sets[] = 'actual_start_at = :started';
            $params[':started'] = $now;
        }
        if ($to === 'COMPLETED' && $row['actual_end_at'] === null) {
            $sets[] = 'actual_end_at = :ended';
            $params[':ended'] = $now;
        }
        $db->prepare('UPDATE live_streams SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($params);
        liveAudit('live_stream_status', 'Stream #' . $id, mb_substr($from . ' → ' . $to . ' by ' . $actor . ' — “' . mb_substr((string) $row['title_en'], 0, 120) . '”', 0, 500), $actor);
        return ['changed' => true, 'from' => $from, 'to' => $to];
    });
}

/* ── Shapes ──────────────────────────────────────────────────────────────── */

/**
 * What the public API answers for one stream. Never provider_stream_id,
 * created_by/updated_by, deleted_at or the temple's and deity's ids.
 */
function liveShapePublic(array $row): array
{
    $provider = liveProviderFor((string) ($row['provider'] ?? ''));
    $tz    = (string) ($row['timezone'] ?? liveTempleTz());
    $start = liveLocalParts($row['scheduled_start_at'] ?? null, $tz);
    $end   = liveLocalParts($row['scheduled_end_at'] ?? null, $tz);
    $type  = (string) ($row['event_type'] ?? 'other');
    $label = LIVE_EVENT_TYPES[$type] ?? LIVE_EVENT_TYPES['other'];
    $status = (string) ($row['status'] ?? 'DRAFT');
    return [
        'id'               => (int) $row['id'],
        'slug'             => (string) $row['slug'],
        'title_ta'         => (string) $row['title_ta'],
        'title_en'         => (string) $row['title_en'],
        'description_ta'   => $row['description_ta'] !== null && $row['description_ta'] !== '' ? (string) $row['description_ta'] : null,
        'description_en'   => $row['description_en'] !== null && $row['description_en'] !== '' ? (string) $row['description_en'] : null,
        'event_type'       => $type,
        'event_type_label' => ['ta' => $label[0], 'en' => $label[1]],
        'provider'         => (string) ($row['provider'] ?? ''),
        'status'           => $status,
        'is_live'          => in_array($status, LIVE_LIVE_STATUSES, true),
        'temple'           => [
            'slug'          => (string) ($row['temple_slug'] ?? ''),
            'name_ta'       => (string) ($row['temple_name_ta'] ?? ''),
            'name_en'       => (string) ($row['temple_name_en'] ?? ''),
            'short_name_ta' => (string) ($row['temple_short_name_ta'] ?? ''),
            'short_name_en' => (string) ($row['temple_short_name_en'] ?? ''),
        ],
        'deity'            => !empty($row['deity_slug']) ? [
            'slug'    => (string) $row['deity_slug'],
            'name_ta' => (string) ($row['deity_name_ta'] ?? ''),
            'name_en' => (string) ($row['deity_name_en'] ?? ''),
        ] : null,
        'scheduled_start_at' => liveIso($row['scheduled_start_at'] ?? null),
        'scheduled_end_at'   => liveIso($row['scheduled_end_at'] ?? null),
        'actual_start_at'    => liveIso($row['actual_start_at'] ?? null),
        'actual_end_at'      => liveIso($row['actual_end_at'] ?? null),
        'timezone'         => $tz,
        'local'            => [
            'date'       => $start['date'],
            'start_time' => $start['time'],
            'end_time'   => $end['time'],
            'end_date'   => $end['date'] !== null && $end['date'] !== $start['date'] ? $end['date'] : null,
        ],
        'thumbnail_url'    => $provider->thumbnailUrl($row),
        'banner_url'       => liveSafeUrl($row['banner_url'] ?? null),
        'playback'         => $provider->playback($row),
        'flags'            => [
            'featured'       => !empty($row['is_featured']),
            'showOnHomepage' => !empty($row['show_on_homepage']),
            'donations'      => !empty($row['donations_enabled']),
            'notifications'  => !empty($row['notifications_enabled']),
            'sharing'        => !empty($row['sharing_enabled']),
            'archive'        => !empty($row['archive_enabled']),
        ],
    ];
}

/** The public shape plus what only the committee sees. */
function liveShapeAdmin(array $row): array
{
    return liveShapePublic($row) + [
        'created_by'            => $row['created_by'] ?? null,
        'updated_by'            => $row['updated_by'] ?? null,
        'created_at'            => liveIso($row['created_at'] ?? null),
        'updated_at'            => liveIso($row['updated_at'] ?? null),
        'deleted_at'            => liveIso($row['deleted_at'] ?? null),
        'provider_broadcast_id' => $row['provider_broadcast_id'] ?? null,
        'playback_url_raw'      => $row['playback_url'] ?? null,
        'thumbnail_url_raw'     => $row['thumbnail_url'] ?? null,
        'temple_id'             => (int) $row['temple_id'],
        'deity_id'              => isset($row['deity_id']) ? (int) $row['deity_id'] : null,
    ];
}

/* ── Select options ──────────────────────────────────────────────────────── */

/** Active temples for a select: [id => ['id','slug','name_ta','name_en','short_name_ta','short_name_en','timezone']]. */
function liveTempleOptions(PDO $db): array
{
    $out = [];
    foreach ($db->query('SELECT id, slug, name_ta, name_en, short_name_ta, short_name_en, timezone FROM temples WHERE is_active = 1 ORDER BY sort_order ASC, id ASC')->fetchAll() as $t) {
        $out[(int) $t['id']] = ['id' => (int) $t['id']] + $t;
    }
    return $out;
}

/** Active deities, of one temple or all, in display order: [['id','temple_id','slug','name_ta','name_en'], …]. */
function liveDeityOptions(PDO $db, ?int $templeId = null): array
{
    $sql = 'SELECT id, temple_id, slug, name_ta, name_en FROM deities WHERE is_active = 1' . ($templeId !== null ? ' AND temple_id = :t' : '') . ' ORDER BY temple_id ASC, sort_order ASC, id ASC';
    $stmt = $db->prepare($sql);
    $stmt->execute($templeId !== null ? [':t' => $templeId] : []);
    $out = [];
    foreach ($stmt->fetchAll() as $d) {
        $out[] = ['id' => (int) $d['id'], 'temple_id' => (int) $d['temple_id'], 'slug' => $d['slug'], 'name_ta' => $d['name_ta'], 'name_en' => $d['name_en']];
    }
    return $out;
}
