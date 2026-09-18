<?php
/**
 * tests/support/live_fixtures.php — shared setup for the Live Darshan test
 * suites (docs/live/SPEC-PHASE1.md §6). CLI only; refuses to run from a web server.
 *
 *   php tests/support/live_fixtures.php <command> '<json>'
 *   php tests/support/live_fixtures.php <command> -        (JSON on stdin)
 *
 * Commands (each prints exactly one JSON object on the last line of stdout;
 * exit 0 on success, 1 with {"error": "..."} otherwise):
 *
 *   probe          {}                       tables present?, UTC now, the seeded temple and deities
 *   create-stream  {title_prefix, label?, title_en?, title_ta?, slug?, status?, provider?,
 *                   provider_reference?, playback_url?, thumbnail_url?, banner_url?,
 *                   description_ta?, description_en?, event_type?, temple_slug?, deity_slug?,
 *                   scheduled_start_local?, scheduled_end_local?, timezone?, flags?,
 *                   starts_in_seconds?, ends_in_seconds?,
 *                   actual_start_local?, actual_end_local?, deleted?, actor?}
 *                                           → {id, slug, status, …} (the row as stored)
 *                  starts_in_seconds (Phase 2) sets the start that many seconds from now,
 *                  to the second (the local form is minute precision), for countdown checks;
 *                  ends_in_seconds does the same for the end (else NULL).
 *   set-status     {id, status, actor?}     liveSetStatus() → {changed, from, to}
 *   unlink         {url}                    liveDeleteUpload() for a /uploads/live-… file → {deleted}
 *   sql            {query, params}          one statement, rows back
 *   sync           {ids?, limit?, actor?, dry_run?}
 *                                           (Phase 3) one liveCronRun() → its whole result, printed
 *                                           as it is. ids present (even []) makes the run scoped to
 *                                           exactly those rows; absent, the run is the job's own
 *                                           unscoped sweep. actor defaults to "e2e-live-sync".
 *   due            {ids, attempts?}         (Phase 3) next_sync_at = NULL on exactly those rows, and
 *                                           sync_attempts = attempts when given; never global, and
 *                                           last_synced_at is left alone → {matched, updated}
 *   hold-lock      {seconds}                (Phase 3) takes GET_LOCK('temple_live_cron', 0), prints
 *                                           {"locked":true} on its own line the moment it has it,
 *                                           holds it for seconds (1-120), releases it and exits 0
 *   cleanup        {title_prefix, admin_prefix?, ips?, actors?}
 *                                           every stream this prefix created (hard delete), its
 *                                           admin_activity rows, its uploaded files, and optionally
 *                                           the test admin accounts (with their live-check-now
 *                                           rate-limit buckets), the rate-limit buckets of ips, and
 *                                           the admin_activity rows written by exactly the actors
 *                                           named (each "e2e-…" or "e2e_…")
 *
 * create-stream writes through the module's own path — liveValidate() then
 * liveInsert() — and then walks liveSetStatus() along a legal route to the
 * status asked for (SCHEDULED → LIVE → COMPLETED, and so on), so a fixture row
 * looks exactly like one an admin made, including its audit rows. Only two
 * things are written straight to SQL: a schedule in the past (validation may
 * refuse one) and an explicit actual_start/actual_end.
 *
 * The database environment comes from the caller (PHP_BIN in the suites).
 * Rows are only ever removed by a title prefix, never by id.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

function liveFixtureOut(array $data, int $code = 0): never
{
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";
    exit($code);
}

/** A cleanup prefix long and plain enough that it can only match test rows. */
function liveFixtureSafePrefix(string $prefix): bool
{
    return strlen($prefix) >= 8 && preg_match('/^[A-Za-z0-9._ -]+$/', $prefix) === 1;
}

function liveFixtureHasTable(PDO $db, string $table): bool
{
    $stmt = $db->prepare('SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t');
    $stmt->execute([':t' => $table]);
    return (int) $stmt->fetchColumn() > 0;
}

/** "a,b,c" as a list of ints for an IN clause, never empty. */
function liveFixtureIn(array $ids): string
{
    $ids = array_values(array_filter(array_map('intval', $ids), static fn(int $i): bool => $i > 0));
    return $ids ? implode(',', $ids) : '0';
}

/**
 * A list of stream ids from a command's JSON, each a positive whole number, or
 * the command fails: a scoped fixture never quietly drops an id it was given.
 * @return list<int>
 */
function liveFixtureIdList(mixed $raw, string $name = 'ids'): array
{
    if (!is_array($raw) || !array_is_list($raw)) liveFixtureOut(['error' => "{$name} must be a list of stream ids"], 1);
    $ids = [];
    foreach ($raw as $v) {
        $ok = (is_int($v) && $v > 0) || (is_string($v) && ctype_digit($v) && (int) $v > 0);
        if (!$ok) liveFixtureOut(['error' => "every one of {$name} must be a positive whole number"], 1);
        $ids[] = (int) $v;
    }
    return $ids;
}

$livePhp = __DIR__ . '/../../backend/includes/live.php';
if (!is_file($livePhp)) {
    liveFixtureOut(['error' => 'backend/includes/live.php is missing: the Live Darshan backend has not been built yet'], 1);
}
require_once $livePhp;

$cmd = $argv[1] ?? '';
$raw = $argv[2] ?? '{}';
if ($raw === '-' || $raw === '') $raw = stream_get_contents(STDIN) ?: '{}';
$args = json_decode($raw, true);
if (!is_array($args)) liveFixtureOut(['error' => 'the argument must be a JSON object'], 1);

/** The legal route from SCHEDULED to each status a fixture may ask for (§2). */
const LIVE_FIXTURE_ROUTES = [
    'DRAFT'     => [],
    'SCHEDULED' => [],
    'STARTING'  => ['STARTING'],
    'LIVE'      => ['LIVE'],
    'COMPLETED' => ['LIVE', 'COMPLETED'],
    'CANCELLED' => ['CANCELLED'],
    'OFFLINE'   => ['LIVE', 'OFFLINE'],
    'ERROR'     => ['LIVE', 'OFFLINE', 'ERROR'],
];

/** Flag keys as the form/API names them, from either that name or the public flags name. */
function liveFixtureFlags(array $args): array
{
    $map = [
        'is_featured'           => ['featured', 'is_featured'],
        'show_on_homepage'      => ['showOnHomepage', 'show_on_homepage'],
        'donations_enabled'     => ['donations', 'donations_enabled'],
        'notifications_enabled' => ['notifications', 'notifications_enabled'],
        'sharing_enabled'       => ['sharing', 'sharing_enabled'],
        'archive_enabled'       => ['archive', 'archive_enabled'],
    ];
    $defaults = ['is_featured' => false, 'show_on_homepage' => false, 'donations_enabled' => true,
                 'notifications_enabled' => true, 'sharing_enabled' => true, 'archive_enabled' => true];
    $flags = is_array($args['flags'] ?? null) ? $args['flags'] : [];
    $out = [];
    foreach ($map as $key => $names) {
        $value = $defaults[$key];
        foreach ($names as $n) {
            if (array_key_exists($n, $flags)) $value = (bool) $flags[$n];
            if (array_key_exists($n, $args)) $value = (bool) $args[$n];
        }
        $out[$key] = $value ? '1' : '';
    }
    return $out;
}

try {
    $db = getDB();
    $needTables = in_array($cmd, ['create-stream', 'set-status', 'cleanup', 'due'], true);
    if ($needTables && !liveTablesExist(true)) {
        liveFixtureOut(['error' => 'the live streaming tables are missing; apply migration 011 first'], 1);
    }

    switch ($cmd) {
        case 'probe': {
            $tables = liveTablesExist(true);
            $temple = $deities = null;
            if ($tables) {
                $temple  = $db->query("SELECT id, slug, name_ta, name_en, timezone FROM temples ORDER BY sort_order, id LIMIT 1")->fetch(PDO::FETCH_ASSOC) ?: null;
                $deities = $db->query('SELECT id, temple_id, slug, name_ta, name_en FROM deities ORDER BY sort_order, id')->fetchAll(PDO::FETCH_ASSOC);
            }
            liveFixtureOut(['tables' => $tables, 'now' => liveUtcNow(), 'temple' => $temple, 'deities' => $deities]);
        }

        case 'create-stream': {
            $prefix = (string) ($args['title_prefix'] ?? '');
            if (!liveFixtureSafePrefix($prefix)) liveFixtureOut(['error' => 'title_prefix must be at least eight plain characters'], 1);
            $label   = trim((string) ($args['label'] ?? 'Darshan'));
            $status  = strtoupper((string) ($args['status'] ?? 'SCHEDULED'));
            if (!isset(LIVE_FIXTURE_ROUTES[$status])) liveFixtureOut(['error' => "status {$status} is not one of " . implode(',', array_keys(LIVE_FIXTURE_ROUTES))], 1);
            $tz      = (string) ($args['timezone'] ?? 'Asia/Kolkata');
            $zone    = new DateTimeZone(liveIsTimezone($tz) ? $tz : 'Asia/Kolkata');
            $actor   = (string) ($args['actor'] ?? 'e2e');

            // The temple and, optionally, the deity: by slug, else the first active ones.
            $templeSlug = (string) ($args['temple_slug'] ?? 'pudupatti');
            $stmt = $db->prepare('SELECT id FROM temples WHERE slug = :s LIMIT 1');
            $stmt->execute([':s' => $templeSlug]);
            $templeId = (int) $stmt->fetchColumn();
            if ($templeId === 0) $templeId = (int) $db->query('SELECT id FROM temples WHERE is_active = 1 ORDER BY sort_order, id LIMIT 1')->fetchColumn();
            if ($templeId === 0) liveFixtureOut(['error' => 'no temple row: apply the migration 011 seeds'], 1);
            $deityId = '';
            if (!empty($args['deity_slug'])) {
                $stmt = $db->prepare('SELECT id FROM deities WHERE temple_id = :t AND slug = :s LIMIT 1');
                $stmt->execute([':t' => $templeId, ':s' => (string) $args['deity_slug']]);
                $deityId = (string) ((int) $stmt->fetchColumn());
                if ($deityId === '0') liveFixtureOut(['error' => 'no deity ' . $args['deity_slug'] . ' for temple ' . $templeSlug], 1);
            }

            // The schedule, as an admin would type it (wall clock in the stream's zone).
            $startLocal = (string) ($args['scheduled_start_local'] ?? (new DateTimeImmutable('tomorrow', $zone))->format('Y-m-d') . ' 18:00');
            $endLocal   = (string) ($args['scheduled_end_local'] ?? '');
            $splitLocal = static function (string $local): array {
                $local = trim(str_replace('T', ' ', $local));
                if ($local === '') return ['', ''];
                $parts = explode(' ', $local, 2);
                return [$parts[0], substr($parts[1] ?? '', 0, 5)];
            };
            [$date, $time] = $splitLocal($startLocal);
            [$endDate, $endTime] = $splitLocal($endLocal);
            if ($endDate === $date) $endDate = '';

            $in = [
                'title_ta'           => (string) ($args['title_ta'] ?? "{$prefix} தரிசனம் {$label}"),
                'title_en'           => (string) ($args['title_en'] ?? "{$prefix} {$label}"),
                'description_ta'     => (string) ($args['description_ta'] ?? 'சோதனை நேரடி தரிசனம்'),
                'description_en'     => (string) ($args['description_en'] ?? 'Test live darshan created by the test suite.'),
                'temple_id'          => (string) $templeId,
                'deity_id'           => $deityId,
                'event_type'         => (string) ($args['event_type'] ?? 'live_darshan'),
                'provider'           => (string) ($args['provider'] ?? 'youtube'),
                'provider_reference' => (string) ($args['provider_reference'] ?? 'dQw4w9WgXcQ'),
                'playback_url'       => (string) ($args['playback_url'] ?? ''),
                'thumbnail_url'      => (string) ($args['thumbnail_url'] ?? ''),
                'banner_url'         => (string) ($args['banner_url'] ?? ''),
                'scheduled_date'     => $date,
                'start_time'         => $time,
                'end_time'           => $endTime,
                'end_date'           => $endDate,
                'timezone'           => $tz,
                'status'             => $status === 'DRAFT' ? 'DRAFT' : 'SCHEDULED',
            ] + liveFixtureFlags($args);
            if (array_key_exists('slug', $args) && $args['slug'] !== null) $in['slug'] = (string) $args['slug'];

            $startUtc = $date !== '' ? liveToUtc("{$date} {$time}", $tz) : null;
            $endUtc   = $endTime !== '' ? liveToUtc(($endDate !== '' ? $endDate : $date) . " {$endTime}", $tz) : null;

            $checked  = liveValidate($in, null, $db);
            $fixTimes = false;
            $timeKeys = ['scheduled_date', 'start_time', 'end_time', 'end_date'];
            if ($checked['errors'] && array_intersect(array_keys($checked['errors']), $timeKeys) && $startUtc !== null && $startUtc < liveUtcNow()) {
                // Validation refused a schedule in the past; make the row with a
                // future one and move it back in SQL — a fixture may need the past.
                $fixTimes = true;
                $future = $in;
                $future['scheduled_date'] = (new DateTimeImmutable('tomorrow', $zone))->format('Y-m-d');
                $future['start_time'] = '18:00';
                $future['end_time'] = '';
                $future['end_date'] = '';
                $checked = liveValidate($future, null, $db);
            }
            if ($checked['errors']) liveFixtureOut(['error' => 'validation refused the fixture', 'fields' => $checked['errors']], 1);

            $id = liveInsert($db, $checked['values'], $actor);
            if ($fixTimes) {
                $db->prepare('UPDATE live_streams SET scheduled_start_at = :s, scheduled_end_at = :e WHERE id = :id')
                   ->execute([':s' => $startUtc, ':e' => $endUtc, ':id' => $id]);
            }
            if (isset($args['starts_in_seconds']) && is_numeric($args['starts_in_seconds'])) {
                // A start relative to now, to the second (the countdown checks need it).
                $nowTs = (int) strtotime(liveUtcNow() . ' UTC');
                $relStart = gmdate('Y-m-d H:i:s', $nowTs + (int) $args['starts_in_seconds']);
                $relEnd = isset($args['ends_in_seconds']) && is_numeric($args['ends_in_seconds']) ? gmdate('Y-m-d H:i:s', $nowTs + (int) $args['ends_in_seconds']) : null;
                $db->prepare('UPDATE live_streams SET scheduled_start_at = :s, scheduled_end_at = :e WHERE id = :id')
                   ->execute([':s' => $relStart, ':e' => $relEnd, ':id' => $id]);
            }
            foreach (LIVE_FIXTURE_ROUTES[$status] as $to) {
                liveSetStatus($db, $id, $to, $actor);
            }
            foreach (['actual_start_local' => 'actual_start_at', 'actual_end_local' => 'actual_end_at'] as $arg => $col) {
                if (!empty($args[$arg])) {
                    $utc = liveToUtc((string) $args[$arg], $tz);
                    if ($utc === null) liveFixtureOut(['error' => "{$arg} is not a date and time"], 1);
                    $db->prepare("UPDATE live_streams SET {$col} = :v WHERE id = :id")->execute([':v' => $utc, ':id' => $id]);
                }
            }
            if (!empty($args['deleted'])) liveSoftDelete($db, $id, $actor);

            $row = liveLoad($db, $id, true) ?? [];
            liveFixtureOut([
                'id'                    => $id,
                'slug'                  => (string) ($row['slug'] ?? ''),
                'status'                => (string) ($row['status'] ?? ''),
                'title_en'              => $row['title_en'] ?? null,
                'title_ta'              => $row['title_ta'] ?? null,
                'provider'              => $row['provider'] ?? null,
                'provider_broadcast_id' => $row['provider_broadcast_id'] ?? null,
                'temple_id'             => isset($row['temple_id']) ? (int) $row['temple_id'] : null,
                'deity_id'              => isset($row['deity_id']) ? (int) $row['deity_id'] : null,
                'timezone'              => $row['timezone'] ?? null,
                'scheduled_start_at'    => $row['scheduled_start_at'] ?? null,
                'scheduled_end_at'      => $row['scheduled_end_at'] ?? null,
                'actual_start_at'       => $row['actual_start_at'] ?? null,
                'actual_end_at'         => $row['actual_end_at'] ?? null,
                'deleted_at'            => $row['deleted_at'] ?? null,
                'created_by'            => $row['created_by'] ?? null,
            ]);
        }

        case 'set-status': {
            $id = (int) ($args['id'] ?? 0);
            $to = strtoupper((string) ($args['status'] ?? ''));
            if ($id <= 0 || $to === '') liveFixtureOut(['error' => 'give id and status'], 1);
            try {
                $result = liveSetStatus($db, $id, $to, (string) ($args['actor'] ?? 'e2e'));
            } catch (LiveTransitionException $e) {
                liveFixtureOut(['error' => $e->getMessage(), 'code' => 'transition'], 1);
            } catch (LiveValidationException $e) {
                liveFixtureOut(['error' => $e->getMessage(), 'code' => 'validation', 'fields' => $e->fields], 1);
            }
            liveFixtureOut($result);
        }

        case 'unlink': {
            $url = (string) ($args['url'] ?? $args['filename'] ?? '');
            if ($url !== '' && !str_starts_with($url, '/')) $url = '/uploads/' . $url;
            $path = realpath(__DIR__ . '/../../backend/uploads') . DIRECTORY_SEPARATOR . basename($url);
            $before = $url !== '' && is_file($path);
            if ($url !== '') liveDeleteUpload($url);
            liveFixtureOut(['deleted' => $before && !is_file($path), 'existed' => $before]);
        }

        case 'sql': {
            $stmt = $db->prepare((string) ($args['query'] ?? ''));
            $stmt->execute((array) ($args['params'] ?? []));
            $rows = $stmt->columnCount() > 0 ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
            liveFixtureOut(['rows' => $rows, 'affected' => $stmt->rowCount()]);
        }

        case 'sync': {
            // docs/live/SPEC-PHASE3.md §10.5: one run of the job, the result printed
            // whole, as payments_fixtures.php's `sweep` does. The suites pass
            // actor "e2e-live-sync", so an audit row a sweep writes outside a
            // "Stream #<id>" subject is removable by actor.
            if (!function_exists('liveCronRun')) {
                liveFixtureOut(['error' => 'liveCronRun() is missing: backend/includes/live/poll.php (SPEC-PHASE3 §13 step 3) is not built yet'], 1);
            }
            $actor = (string) ($args['actor'] ?? 'e2e-live-sync');
            if ($actor === '') liveFixtureOut(['error' => 'actor must not be empty'], 1);
            $opts = ['trigger' => 'cli', 'actor' => $actor];
            if (array_key_exists('ids', $args) && $args['ids'] !== null) {
                // Kept even when empty: a scoped run never widens (§5.3 step 5).
                $opts['stream_ids'] = liveFixtureIdList($args['ids']);
            }
            if (array_key_exists('limit', $args) && $args['limit'] !== null) {
                if (!is_numeric($args['limit'])) liveFixtureOut(['error' => 'limit must be a number'], 1);
                $opts['limit'] = (int) $args['limit'];
            }
            if (!empty($args['dry_run'])) $opts['dry_run'] = true;
            liveFixtureOut(liveCronRun($opts));
        }

        case 'due': {
            // §10.5: make exactly the named rows due now, and optionally set their
            // failure count (G15's threshold without eleven runs). Never global,
            // and last_synced_at is left alone so Check now's floor still holds.
            if (!array_key_exists('ids', $args) || $args['ids'] === null) liveFixtureOut(['error' => 'due needs ids: it is never global'], 1);
            $ids = liveFixtureIdList($args['ids']);
            if (!$ids) liveFixtureOut(['error' => 'due needs at least one id: it is never global'], 1);
            if (function_exists('liveAutomationInstalled') && !liveAutomationInstalled(true)) {
                liveFixtureOut(['error' => 'the Phase 3 sync columns are missing; apply migration 012 first'], 1);
            }
            $set = 'next_sync_at = NULL';
            $params = [];
            if (array_key_exists('attempts', $args) && $args['attempts'] !== null) {
                $a = $args['attempts'];
                $ok = (is_int($a) && $a >= 0) || (is_string($a) && ctype_digit($a));
                if (!$ok || (int) $a > 65535) liveFixtureOut(['error' => 'attempts must be a whole number from 0 to 65535'], 1);
                $set .= ', sync_attempts = :attempts';
                $params[':attempts'] = (int) $a;
            }
            $in = liveFixtureIn($ids);
            $matched = (int) $db->query("SELECT COUNT(*) FROM live_streams WHERE id IN ({$in})")->fetchColumn();
            $stmt = $db->prepare("UPDATE live_streams SET {$set} WHERE id IN ({$in})");
            $stmt->execute($params);
            liveFixtureOut(['matched' => $matched, 'updated' => $stmt->rowCount()]);
        }

        case 'hold-lock': {
            // §10.5: hold the job's advisory lock from a second process, so "another
            // run holds the lock" is proved with no test hook in production code.
            // GET_LOCK is per connection: this process's one connection holds it.
            $seconds = max(1, min(120, (int) ($args['seconds'] ?? 15)));
            $got = (int) $db->query("SELECT GET_LOCK('temple_live_cron', 0)")->fetchColumn();
            if ($got !== 1) liveFixtureOut(['error' => 'another process already holds temple_live_cron'], 1);
            fwrite(STDOUT, json_encode(['locked' => true]) . "\n");
            fflush(STDOUT);
            sleep($seconds);
            try {
                $db->query("SELECT RELEASE_LOCK('temple_live_cron')")->closeCursor();
            } catch (Throwable) {
                // the lock is released with the connection anyway
            }
            exit(0);
        }

        case 'cleanup': {
            $prefix = (string) ($args['title_prefix'] ?? '');
            if (!liveFixtureSafePrefix($prefix)) liveFixtureOut(['error' => 'title_prefix must be at least eight plain characters'], 1);
            // Phase 3: exact actor names, checked before anything is deleted. A bare
            // "e2e" is refused: it is the shared default actor of every live suite.
            $actors = $args['actors'] ?? [];
            if (!is_array($actors) || !array_is_list($actors)) liveFixtureOut(['error' => 'actors must be a list of actor names'], 1);
            foreach ($actors as $a) {
                if (!is_string($a) || !preg_match('/^e2e[-_][A-Za-z0-9._-]{1,56}$/D', $a)) {
                    liveFixtureOut(['error' => 'every actor must be an exact test actor name starting "e2e-" or "e2e_"'], 1);
                }
            }
            $actors = array_values(array_unique($actors));
            $like = addcslashes($prefix, '%_') . '%';
            $counts = ['streams' => 0, 'activity' => 0, 'uploads' => 0, 'notifications' => 0, 'admin_users' => 0, 'buckets' => 0];

            $stmt = $db->prepare('SELECT id, thumbnail_url, banner_url FROM live_streams WHERE title_en LIKE :a OR title_ta LIKE :b');
            $stmt->execute([':a' => $like, ':b' => $like]);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
            $ids = array_map(static fn(array $r): int => (int) $r['id'], $rows);
            $uploadDir = realpath(__DIR__ . '/../../backend/uploads');
            foreach ($rows as $r) {
                foreach (['thumbnail_url', 'banner_url'] as $col) {
                    $url = (string) ($r[$col] ?? '');
                    if (!str_starts_with($url, '/uploads/live-')) continue;
                    $path = $uploadDir ? $uploadDir . DIRECTORY_SEPARATOR . basename($url) : '';
                    $had = $path !== '' && is_file($path);
                    liveDeleteUpload($url);
                    if ($had && !is_file($path)) $counts['uploads']++;
                }
            }
            if ($ids) {
                $in = liveFixtureIn($ids);
                $subjects = array_map(static fn(int $i): string => 'Stream #' . $i, $ids);
                foreach (array_chunk($subjects, 200) as $chunk) {
                    $marks = implode(',', array_fill(0, count($chunk), '?'));
                    $del = $db->prepare("DELETE FROM admin_activity WHERE subject IN ({$marks})");
                    $del->execute($chunk);
                    $counts['activity'] += $del->rowCount();
                }
                if (liveFixtureHasTable($db, 'notifications')) {
                    $counts['notifications'] = (int) $db->exec("DELETE FROM notifications WHERE entity_type = 'live_stream' AND entity_id IN ({$in})");
                }
                $counts['streams'] = (int) $db->exec("DELETE FROM live_streams WHERE id IN ({$in})");
            }

            // Phase 3 (SPEC-PHASE3 §10.5): audit rows a suite's sweeps wrote outside a
            // "Stream #<id>" subject, removed only by the exact actor names given —
            // never by a subject such as "YouTube automation", which real rows share.
            if ($actors) {
                $marks = implode(',', array_fill(0, count($actors), '?'));
                $del = $db->prepare("DELETE FROM admin_activity WHERE actor IN ({$marks})");
                $del->execute($actors);
                $counts['activity'] += $del->rowCount();
            }

            // Test committee accounts a suite made for the role checks (never a real one:
            // the prefix must be at least eight plain characters and start with e2e).
            $adminPrefix = (string) ($args['admin_prefix'] ?? '');
            if ($adminPrefix !== '') {
                if (!liveFixtureSafePrefix($adminPrefix) || !str_starts_with($adminPrefix, 'e2e')) {
                    liveFixtureOut(['error' => 'admin_prefix must be at least eight plain characters and start with e2e'], 1);
                }
                $alike = addcslashes($adminPrefix, '%_') . '%';
                $del = $db->prepare('DELETE FROM admin_activity WHERE actor LIKE :a OR subject LIKE :b');
                $del->execute([':a' => $alike, ':b' => $alike]);
                $counts['activity'] += $del->rowCount();
                $del = $db->prepare('DELETE FROM admin_users WHERE username LIKE :u');
                $del->execute([':u' => $alike]);
                $counts['admin_users'] = $del->rowCount();
                // Phase 3: the Check now bucket is keyed by admin name, not by the IP
                // the ips clause below matches (SPEC-PHASE3 §8.4, §10.5).
                if (liveFixtureHasTable($db, 'rate_limits')) {
                    $del = $db->prepare('DELETE FROM rate_limits WHERE bucket LIKE :b');
                    $del->execute([':b' => 'live-check-now:' . $alike]);
                    $counts['buckets'] += $del->rowCount();
                }
            }
            foreach ((array) ($args['ips'] ?? []) as $ip) {
                if (!is_string($ip) || !preg_match('/^[0-9a-fA-F.:]{3,45}$/D', $ip)) continue;
                $del = $db->prepare('DELETE FROM rate_limits WHERE bucket LIKE :b');
                $del->execute([':b' => '%:' . $ip]);
                $counts['buckets'] += $del->rowCount();
            }
            liveFixtureOut($counts);
        }
    }
    liveFixtureOut(['error' => "unknown command \"{$cmd}\"; use probe, create-stream, set-status, unlink, sql, sync, due, hold-lock or cleanup"], 1);
} catch (Throwable $e) {
    liveFixtureOut(['error' => get_class($e) . ': ' . $e->getMessage()], 1);
}
