<?php
/**
 * tests/live-unit.php — the Live Darshan module's rules, one at a time, against
 * the real code and the real database (docs/live/SPEC-PHASE1.md §6, first suite).
 *
 *   PHP_BIN=/path/to/php.sh; $PHP_BIN tests/live-unit.php
 *
 * What it proves:
 *   • the vocabulary (§1): statuses, public statuses, event types, providers,
 *     reserved slugs and the transition table exactly as written;
 *   • YouTubeProvider::parseReference() for every accepted link form, the bare
 *     id, `live_stream`, wrong hosts, wrong lengths and hostile text → null;
 *     the embed, watch and thumbnail builders; the placeholder providers and a
 *     registry that never throws;
 *   • liveToUtc / liveFromUtc round trips in Asia/Kolkata and America/New_York
 *     (both sides of DST), the accepted input forms, and null for a bad zone,
 *     a bad date and 9999-99-99; liveIso, liveLocalParts, liveIsTimezone;
 *   • liveSlugify strips non-ASCII, liveUniqueSlug counts deleted rows and
 *     appends -2, -3; the reserved slugs are refused;
 *   • liveValidate (§4.2): a field error for every rule, arrays and oversized
 *     input answered with errors rather than exceptions, the typed values kept;
 *   • the store: insert, update, load (with and without deleted rows), the
 *     live / upcoming / admin lists and their filters, soft delete, and an
 *     admin_activity row for every write naming the actor;
 *   • every transition in §2, legal and illegal (COMPLETED is terminal), with
 *     actual_start_at / actual_end_at stamped once and the status audit line;
 *   • liveShapePublic omits the private keys and speaks ISO-8601 Z; liveShapeAdmin
 *     adds exactly the admin keys;
 *   • liveSafeUrl, liveStoreImage with a real 1×1 PNG, a text file named .png
 *     and an oversize blob, and liveDeleteUpload touching only /uploads/live-…;
 *   • the admin helpers: tones, labels, filter whitelist, action buttons;
 *   • liveTransaction commits a result and rolls back on an exception;
 *   • Phase 2 (docs/live/SPEC-PHASE2.md §3): the day / week / festival windows
 *     in Asia/Kolkata (23:59 IST inside, the next midnight outside, the week
 *     ending Sunday, month and year rollovers), day_bucket and
 *     starts_in_seconds, liveListSchedule membership, order (live first, an
 *     undated row last, COMPLETED last within its day) and counts, the reserved
 *     slug "schedule", and the Vimeo / AWS IVS placeholders (reference shapes,
 *     not configured, no playback, still not selectable).
 *
 * Exits 1 with "apply migration 011 first" when the tables are missing.
 * Creates streams titled "E2E-LIVE-UNIT-<run> …" (slugs e2e-live-unit-<run>-<n>),
 * one temple "e2e-unit-<run>" with one deity, and removes them all before exiting.
 */

if (PHP_SAPI !== 'cli') exit(1);

putenv('SITE_URL=https://temple.example.test');

$livePhp = __DIR__ . '/../backend/includes/live.php';
if (!is_file($livePhp)) {
    echo "backend/includes/live.php is missing: the Live Darshan backend has not been built yet.\n";
    exit(1);
}
require_once $livePhp;

$passed   = 0;
$failures = [];

function ok(bool $condition, string $label, string $detail = ''): bool
{
    global $passed, $failures;
    if ($condition) {
        $passed++;
        echo "  ok   {$label}\n";
    } else {
        $failures[] = $label;
        echo "  FAIL {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
    }
    return $condition;
}

function eq(mixed $actual, mixed $expected, string $label): bool
{
    return ok($actual === $expected, $label, 'expected ' . json_encode($expected, JSON_UNESCAPED_UNICODE) . ', got ' . json_encode($actual, JSON_UNESCAPED_UNICODE));
}

function section(string $title): void
{
    echo "\n── {$title}\n";
}

/** The exception class and message a callable throws, or null. */
function threw(callable $fn): ?string
{
    try {
        $fn();
    } catch (Throwable $e) {
        return get_class($e) . ': ' . $e->getMessage();
    }
    return null;
}

/** Sorted keys of an array, for shape comparisons. */
function keysOf(array $a): array
{
    $k = array_keys($a);
    sort($k);
    return $k;
}

if (!function_exists('liveTablesExist') || !liveTablesExist(true)) {
    echo "The live streaming tables are missing; apply migration 011 first (database/migrations/011_live_streams.sql).\n";
    exit(1);
}

$run    = base_convert((string) time(), 10, 36) . bin2hex(random_bytes(2));
$PREFIX = 'E2E-LIVE-UNIT';
$NAME   = "{$PREFIX}-{$run}";
$SLUG   = "e2e-live-unit-{$run}";
$ACTOR  = 'e2e-unit';
$db     = getDB();
$IST    = new DateTimeZone('Asia/Kolkata');
$tmpFiles = [];

echo "live-unit — run {$run}\n";

/** Remove every row this prefix created: streams, their audit rows, the test temple. */
function unitCleanup(PDO $db, string $like, string $templeSlugLike): array
{
    $out = ['streams' => 0, 'activity' => 0, 'temples' => 0];
    $stmt = $db->prepare('SELECT id FROM live_streams WHERE title_en LIKE ? OR title_ta LIKE ?');
    $stmt->execute([$like, $like]);
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    if ($ids) {
        $subjects = array_map(static fn(int $i): string => 'Stream #' . $i, $ids);
        $marks = implode(',', array_fill(0, count($subjects), '?'));
        $del = $db->prepare("DELETE FROM admin_activity WHERE subject IN ({$marks})");
        $del->execute($subjects);
        $out['activity'] = $del->rowCount();
        $out['streams'] = (int) $db->exec('DELETE FROM live_streams WHERE id IN (' . implode(',', $ids) . ')');
    }
    $del = $db->prepare('DELETE FROM temples WHERE slug LIKE ?');
    $del->execute([$templeSlugLike]);
    $out['temples'] = $del->rowCount();
    return $out;
}

unitCleanup($db, "{$PREFIX}-%", 'e2e-unit-%');

$templeId = (int) $db->query("SELECT id FROM temples WHERE slug = 'pudupatti'")->fetchColumn();
if ($templeId === 0) {
    echo "The temples table has no 'pudupatti' row; apply the migration 011 seeds first.\n";
    exit(1);
}
$deityStmt = $db->prepare("SELECT id FROM deities WHERE temple_id = ? AND slug = 'renukadevi'");
$deityStmt->execute([$templeId]);
$deityId = (int) $deityStmt->fetchColumn();
$tomorrow = (new DateTimeImmutable('tomorrow', $IST))->format('Y-m-d');
$dayAfter = (new DateTimeImmutable('tomorrow +1 day', $IST))->format('Y-m-d');
$yesterday = (new DateTimeImmutable('yesterday', $IST))->format('Y-m-d');
$YT = 'dQw4w9WgXcQ';

$base = [
    'title_ta' => "{$NAME} தரிசனம்", 'title_en' => "{$NAME} Darshan",
    'description_ta' => 'சோதனை விளக்கம்', 'description_en' => 'Test description',
    'temple_id' => (string) $templeId, 'deity_id' => (string) $deityId, 'event_type' => 'daily_pooja',
    'provider' => 'youtube', 'provider_reference' => "https://www.youtube.com/watch?v={$YT}",
    'playback_url' => '', 'thumbnail_url' => '', 'banner_url' => '',
    'scheduled_date' => $tomorrow, 'start_time' => '18:00', 'end_time' => '19:30', 'end_date' => '', 'timezone' => 'Asia/Kolkata',
    'status' => 'SCHEDULED',
    'is_featured' => '1', 'show_on_homepage' => '1', 'donations_enabled' => '1', 'notifications_enabled' => '1', 'sharing_enabled' => '1', 'archive_enabled' => '1',
];
$without = static function (array $a, string ...$keys): array {
    foreach ($keys as $k) unset($a[$k]);
    return $a;
};
$slugN = 0;
$made = [];
/** A stream through the module's own write path, then walked to a status along a legal route. */
$makeStream = static function (string $label, array $over = [], string $status = 'SCHEDULED') use (&$slugN, &$made, $db, $base, $NAME, $SLUG, $ACTOR): int {
    $slugN++;
    $in = array_replace($base, [
        'title_en' => "{$NAME} {$label}", 'title_ta' => "{$NAME} தரிசனம் {$label}", 'slug' => "{$SLUG}-{$slugN}",
        'status' => $status === 'DRAFT' ? 'DRAFT' : 'SCHEDULED',
    ], $over);
    $v = liveValidate($in, null, $db);
    if ($v['errors']) throw new RuntimeException("fixture {$label} refused: " . json_encode($v['errors'], JSON_UNESCAPED_UNICODE));
    $id = liveInsert($db, $v['values'], $ACTOR);
    $routes = ['DRAFT' => [], 'SCHEDULED' => [], 'STARTING' => ['STARTING'], 'LIVE' => ['LIVE'], 'COMPLETED' => ['LIVE', 'COMPLETED'],
               'CANCELLED' => ['CANCELLED'], 'OFFLINE' => ['LIVE', 'OFFLINE'], 'ERROR' => ['LIVE', 'OFFLINE', 'ERROR']];
    foreach ($routes[$status] ?? [] as $to) liveSetStatus($db, $id, $to, $ACTOR);
    $made[$label] = $id;
    return $id;
};
$row = static fn(int $id): array => liveLoad($db, $id, true) ?? [];
$lastAudit = static function (int $id, ?string $action = null) use ($db): ?array {
    $sql = 'SELECT actor, action, subject, detail FROM admin_activity WHERE subject = ?' . ($action !== null ? ' AND action = ?' : '') . ' ORDER BY id DESC LIMIT 1';
    $stmt = $db->prepare($sql);
    $stmt->execute($action !== null ? ["Stream #{$id}", $action] : ["Stream #{$id}"]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
};

try {
    /* ── 1. Vocabulary ───────────────────────────────────────────────────── */
    section('1. Vocabulary (§1, §2)');
    eq(LIVE_STATUSES, ['DRAFT', 'SCHEDULED', 'STARTING', 'LIVE', 'COMPLETED', 'CANCELLED', 'OFFLINE', 'ERROR'], 'LIVE_STATUSES in the contract order');
    $publicSorted = LIVE_PUBLIC_STATUSES;
    sort($publicSorted);
    eq($publicSorted, ['CANCELLED', 'COMPLETED', 'ERROR', 'LIVE', 'OFFLINE', 'SCHEDULED', 'STARTING'], 'LIVE_PUBLIC_STATUSES is every status but DRAFT');
    $liveSorted = LIVE_LIVE_STATUSES;
    sort($liveSorted);
    eq($liveSorted, ['LIVE', 'STARTING'], 'LIVE_LIVE_STATUSES is LIVE and STARTING');
    eq(array_keys(LIVE_EVENT_TYPES), ['live_darshan', 'daily_pooja', 'abhishekam', 'deeparadhana', 'festival', 'bhajan', 'discourse', 'procession', 'special_event', 'other'], 'the ten event types, in order');
    ok(array_reduce(LIVE_EVENT_TYPES, static fn(bool $c, $v): bool => $c && is_array($v) && isset($v[0], $v[1]) && $v[0] !== '' && $v[1] !== '' && preg_match('/\p{Tamil}/u', (string) $v[0]) === 1, true),
        'every event type carries a Tamil and an English label', json_encode(LIVE_EVENT_TYPES, JSON_UNESCAPED_UNICODE));
    eq(array_values(array_map(static fn($k): string => (string) $k, array_keys(LIVE_PROVIDERS))), ['youtube', 'vimeo', 'aws_ivs', 'custom'], 'the four providers, YouTube first');
    $reserved = LIVE_RESERVED_SLUGS;
    sort($reserved);
    eq($reserved, ['archive', 'live', 'schedule', 'upcoming'], 'the reserved slugs');
    $expectedTransitions = [
        'DRAFT'     => ['SCHEDULED', 'CANCELLED'],
        'SCHEDULED' => ['STARTING', 'LIVE', 'CANCELLED', 'DRAFT'],
        'STARTING'  => ['LIVE', 'OFFLINE', 'CANCELLED', 'SCHEDULED'],
        'LIVE'      => ['COMPLETED', 'OFFLINE'],
        'OFFLINE'   => ['LIVE', 'COMPLETED', 'ERROR'],
        'ERROR'     => ['SCHEDULED', 'LIVE', 'CANCELLED'],
        'CANCELLED' => ['SCHEDULED', 'DRAFT'],
        'COMPLETED' => [],
    ];
    foreach ($expectedTransitions as $from => $tos) {
        $have = array_values((array) (LIVE_TRANSITIONS[$from] ?? null));
        sort($have);
        sort($tos);
        eq($have, $tos, "LIVE_TRANSITIONS[{$from}] is exactly " . (count($tos) ? implode(', ', $tos) : '(none)'));
    }
    $transitionKeys = array_keys(LIVE_TRANSITIONS);
    sort($transitionKeys);
    $expectedKeys = array_keys($expectedTransitions);
    sort($expectedKeys);
    eq($transitionKeys, $expectedKeys, 'the transition table names every status once and nothing else');
    eq(liveTempleTz(), 'Asia/Kolkata', 'the temple zone is Asia/Kolkata');
    ok(liveTablesExist() === true && liveTablesExist(true) === true, 'liveTablesExist() answers true, cached and refreshed');

    /* ── 2. Providers ────────────────────────────────────────────────────── */
    section('2. YouTubeProvider::parseReference (§1)');
    $yt = liveProviderFor('youtube');
    ok($yt instanceof StreamingProvider && $yt instanceof YouTubeProvider, 'liveProviderFor(youtube) is the YouTubeProvider');
    eq($yt->name(), 'youtube', 'its name is youtube');
    ok($yt->isConfigured(), 'YouTube is configured (no keys needed in Phase 1)');
    ok(is_string($yt->label()) && $yt->label() !== '', 'it has a label');
    foreach ([
        'the bare id'                          => $YT,
        'the bare id with spaces around it'    => "  {$YT}  ",
        'watch?v='                             => "https://www.youtube.com/watch?v={$YT}",
        'http scheme'                          => "http://youtube.com/watch?v={$YT}",
        'no scheme'                            => "youtube.com/watch?v={$YT}",
        'www without scheme'                   => "www.youtube.com/watch?v={$YT}",
        'v after another query parameter'      => "https://www.youtube.com/watch?feature=share&v={$YT}",
        'trailing list and t parameters'       => "https://www.youtube.com/watch?v={$YT}&list=PLxyz&t=42s",
        'a fragment'                           => "https://www.youtube.com/watch?v={$YT}#t=10",
        'youtu.be'                             => "https://youtu.be/{$YT}",
        'youtu.be with ?t='                    => "https://youtu.be/{$YT}?t=30",
        '/live/'                               => "https://www.youtube.com/live/{$YT}",
        '/live/ with ?feature='                => "https://www.youtube.com/live/{$YT}?feature=share",
        '/embed/'                              => "https://www.youtube.com/embed/{$YT}",
        'youtube-nocookie /embed/ with params' => "https://www.youtube-nocookie.com/embed/{$YT}?rel=0&playsinline=1",
        '/shorts/'                             => "https://www.youtube.com/shorts/{$YT}",
        '/v/'                                  => "https://www.youtube.com/v/{$YT}",
        'm. host'                              => "https://m.youtube.com/watch?v={$YT}",
        'music. host'                          => "https://music.youtube.com/watch?v={$YT}",
        'an upper-case host'                   => "HTTPS://WWW.YOUTUBE.COM/watch?v={$YT}",
    ] as $label => $input) {
        eq($yt->parseReference($input), $YT, "accepts {$label}");
    }
    foreach ([
        'an empty string'                     => '',
        'only spaces'                         => '   ',
        'live_stream as a bare id'            => 'live_stream',
        'the channel live_stream embed'       => 'https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv',
        'a ten-character id'                  => substr($YT, 0, 10),
        'a twelve-character id'               => $YT . 'Q',
        'a twelve-character id in a link'     => "https://www.youtube.com/watch?v={$YT}Q",
        'an id with a bad character'          => substr($YT, 0, 10) . '!',
        'a Vimeo link'                        => 'https://vimeo.com/123456789',
        'a channel link'                      => 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
        'a handle link'                       => 'https://www.youtube.com/@TempleMahendra',
        'a playlist link'                     => 'https://www.youtube.com/playlist?list=PLabcdefghijk',
        'the id on another host'              => "https://evil.example/watch?v={$YT}",
        'a look-alike host'                   => "https://www.youtube.com.evil.example/watch?v={$YT}",
        'javascript:'                         => 'javascript:alert(1)',
        'script tags'                         => '"><script>alert(1)</script>',
        'six hundred characters'              => str_repeat('a', 600),
        'a tab inside the id'                 => substr($YT, 0, 5) . "\t" . substr($YT, 5),
        'a number-like string of 10 digits'   => '1234567890',
    ] as $label => $input) {
        eq($yt->parseReference($input), null, "refuses {$label}");
    }

    section('2b. embed, watch and thumbnail builders (§1, §4.1)');
    $streamRow = ['provider' => 'youtube', 'provider_broadcast_id' => $YT, 'playback_url' => null, 'thumbnail_url' => null, 'status' => 'LIVE'];
    $pb = $yt->playback($streamRow);
    eq(keysOf($pb), ['embedUrl', 'kind', 'watchUrl'], 'playback() returns exactly kind, embedUrl, watchUrl');
    eq($pb['kind'] ?? null, 'iframe', 'a valid id plays in an iframe');
    eq($pb['embedUrl'] ?? null, "https://www.youtube-nocookie.com/embed/{$YT}?rel=0&playsinline=1", 'the embed URL is the nocookie host with rel=0 and playsinline=1 (hl is added by the frontend)');
    eq($pb['watchUrl'] ?? null, "https://www.youtube.com/watch?v={$YT}", 'the watch URL');
    $pbOverride = $yt->playback(array_replace($streamRow, ['playback_url' => "https://youtu.be/{$YT}?t=5"]));
    eq($pbOverride['watchUrl'] ?? null, "https://youtu.be/{$YT}?t=5", 'an https playback_url replaces the watch URL');
    eq($pbOverride['embedUrl'] ?? null, $pb['embedUrl'], '…but never the embed, which is always built from the id');
    $pbHttp = $yt->playback(array_replace($streamRow, ['playback_url' => "http://youtu.be/{$YT}"]));
    eq($pbHttp['watchUrl'] ?? null, "https://www.youtube.com/watch?v={$YT}", 'an http playback_url is ignored');
    $pbNone = $yt->playback(array_replace($streamRow, ['provider_broadcast_id' => null]));
    ok(($pbNone['kind'] ?? null) !== 'iframe' && ($pbNone['embedUrl'] ?? null) === null, 'no id, no iframe', json_encode($pbNone));
    $pbBad = $yt->playback(array_replace($streamRow, ['provider_broadcast_id' => '"><script>']));
    ok(($pbBad['kind'] ?? null) !== 'iframe' && !str_contains((string) json_encode($pbBad), '<script>'), 'a stored id that is not an id builds no embed', json_encode($pbBad));
    eq($yt->thumbnailUrl($streamRow), "https://i.ytimg.com/vi/{$YT}/hqdefault.jpg", 'the default thumbnail is hqdefault.jpg for the id');
    eq($yt->thumbnailUrl(array_replace($streamRow, ['thumbnail_url' => '/uploads/live-abc.png'])), '/uploads/live-abc.png', 'an admin thumbnail wins');
    eq($yt->thumbnailUrl(array_replace($streamRow, ['provider_broadcast_id' => null])), null, 'no id and no thumbnail → null');
    $fs = $yt->fetchStatus($streamRow);
    ok(($fs['ok'] ?? null) === false && ($fs['error'] ?? null) === 'not configured', 'fetchStatus() is "not configured" in Phase 1', json_encode($fs));

    section('2c. the placeholder providers and the registry');
    eq(array_keys(liveProviderRegistry()), ['youtube', 'vimeo', 'aws_ivs', 'custom'], 'the registry lists youtube, vimeo, aws_ivs, custom');
    foreach (['vimeo', 'aws_ivs', 'custom'] as $name) {
        $p = liveProviderFor($name);
        ok($p instanceof StreamingProvider && $p->name() === $name && !$p->isConfigured(), "{$name} is a StreamingProvider that is not configured");
        eq($p->fetchStatus($streamRow)['ok'] ?? null, false, "{$name} fetchStatus() is not ok");
    }
    $custom = liveProviderFor('custom');
    eq($custom->parseReference('  my-stream-ref  '), 'my-stream-ref', 'custom keeps a trimmed reference');
    $longRef = $custom->parseReference(str_repeat('r', 101));
    ok($longRef === null || strlen($longRef) <= 100, 'custom limits a reference to 100 characters', json_encode($longRef));
    eq(liveProviderFor('vimeo')->parseReference('https://vimeo.com/123456789'), '123456789', 'vimeo recognises its numeric id (a Phase 2 placeholder: stored, still not selectable)');
    $customPb = $custom->playback(['provider' => 'custom', 'provider_broadcast_id' => 'ref', 'playback_url' => 'https://cdn.example/live.m3u8']);
    ok(($customPb['kind'] ?? null) === 'link' && ($customPb['watchUrl'] ?? null) === 'https://cdn.example/live.m3u8', 'custom with a playback URL is a link', json_encode($customPb));
    eq(liveProviderFor('custom')->playback(['provider' => 'custom', 'provider_broadcast_id' => 'ref', 'playback_url' => null])['kind'] ?? null, 'none', 'custom without a playback URL plays nothing');
    $unknown = null;
    ok(threw(function () use (&$unknown) { $unknown = liveProviderFor('nonsense'); }) === null && $unknown instanceof StreamingProvider && !$unknown->isConfigured(), 'an unknown provider name never throws');
    ok(threw(fn() => liveProviderFor('"><script>')) === null && threw(fn() => liveProviderFor('')) === null, 'nor does hostile or empty input');

    /* ── 3. Time ─────────────────────────────────────────────────────────── */
    section('3. Time (§4.1 live/time.php)');
    eq(liveToUtc('2026-09-13 18:00', 'Asia/Kolkata'), '2026-09-13 12:30:00', 'IST 18:00 is 12:30 UTC');
    eq(liveToUtc('2026-09-13 06:15:30', 'Asia/Kolkata'), '2026-09-13 00:45:30', 'the seconds form is accepted');
    eq(liveToUtc('2026-09-13T06:15', 'Asia/Kolkata'), '2026-09-13 00:45:00', 'the datetime-local T form is accepted');
    eq(liveToUtc('2026-09-14 01:30', 'Asia/Kolkata'), '2026-09-13 20:00:00', 'IST to UTC crosses midnight backwards');
    eq(liveToUtc('2026-07-04 10:00', 'America/New_York'), '2026-07-04 14:00:00', 'New York in July is EDT (UTC−4)');
    eq(liveToUtc('2026-01-15 10:00', 'America/New_York'), '2026-01-15 15:00:00', 'New York in January is EST (UTC−5)');
    eq(liveFromUtc('2026-09-13 12:30:00', 'Asia/Kolkata'), '2026-09-13 18:00', 'UTC back to the IST wall clock, Y-m-d H:i by default');
    eq(liveFromUtc('2026-07-04 14:00:00', 'America/New_York', 'H:i'), '10:00', 'UTC back to New York summer time with a format');
    eq(liveFromUtc('2026-01-15 15:00:00', 'America/New_York', 'Y-m-d H:i'), '2026-01-15 10:00', 'UTC back to New York winter time');
    eq(liveFromUtc('2026-09-13 20:00:00', 'Asia/Kolkata'), '2026-09-14 01:30', 'UTC to IST crosses midnight forwards');
    foreach (['Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Sydney'] as $tz) {
        $local = '2026-10-25 01:45';
        eq(liveFromUtc((string) liveToUtc($local, $tz), $tz), $local, "round trip in {$tz}");
    }
    foreach (['9999-99-99 10:00', '2026-02-30 10:00', '2026-13-01 10:00', 'tomorrow', '', '2026-09-13 25:00', '13-09-2026 10:00', '2026-09-13', '<script>', str_repeat('1', 300)] as $bad) {
        eq(liveToUtc($bad, 'Asia/Kolkata'), null, 'liveToUtc refuses ' . json_encode($bad));
    }
    $badZone = liveToUtc('2026-09-13 18:00', 'Not/AZone');
    ok($badZone === null || $badZone === '2026-09-13 12:30:00', 'a bad zone is refused or falls back to the temple zone, never a throw', json_encode($badZone));
    ok(threw(fn() => liveToUtc('2026-09-13 18:00', '"><script>')) === null, 'a hostile zone never throws');
    eq(liveIso('2026-09-13 04:05:06'), '2026-09-13T04:05:06Z', 'liveIso adds the T and the Z');
    eq(liveIso(null), null, 'liveIso(null) is null');
    eq(liveIso(''), null, 'liveIso("") is null');
    eq(liveIso('0000-00-00 00:00:00'), null, 'a zero date is null');
    eq(liveLocalParts('2026-09-13 12:30:00', 'Asia/Kolkata'), ['date' => '2026-09-13', 'time' => '18:00'], 'liveLocalParts gives the wall-clock date and time');
    eq(liveLocalParts('2026-09-13 20:00:00', 'Asia/Kolkata'), ['date' => '2026-09-14', 'time' => '01:30'], '…across midnight');
    eq(liveLocalParts(null, 'Asia/Kolkata'), ['date' => null, 'time' => null], 'liveLocalParts(null) is two nulls');
    ok(liveIsTimezone('Asia/Kolkata') && liveIsTimezone('UTC') && liveIsTimezone('America/New_York'), 'liveIsTimezone knows IANA names');
    ok(!liveIsTimezone('Not/AZone') && !liveIsTimezone('') && !liveIsTimezone(null) && !liveIsTimezone(['Asia/Kolkata']) && !liveIsTimezone(5) && !liveIsTimezone('asia/kolkata'), 'and refuses anything else');
    $now = liveUtcNow();
    ok(preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $now) === 1 && abs(strtotime($now . ' UTC') - time()) <= 2, 'liveUtcNow() is Y-m-d H:i:s in UTC, now', $now);

    /* ── 4. Slugs ────────────────────────────────────────────────────────── */
    section('4. Slugs (§1, §4.1 validate.php)');
    eq(liveSlugify('Sri Renukadevi Abhishekam – Live!'), 'sri-renukadevi-abhishekam-live', 'punctuation and dashes become single hyphens');
    eq(liveSlugify('  Deeparadhana   2026 '), 'deeparadhana-2026', 'spaces collapse');
    eq(liveSlugify('நேரடி தரிசனம் Pournami'), 'pournami', 'non-ASCII is stripped');
    $tamilOnly = liveSlugify('நேரடி தரிசனம்');
    ok(preg_match('/^[a-z0-9-]*$/', $tamilOnly) === 1, 'a Tamil-only title leaves only ASCII behind (the admin fills the slug)', json_encode($tamilOnly));
    $longSlug = liveSlugify(str_repeat('a', 200));
    ok(strlen($longSlug) <= 120 && preg_match('/^[a-z0-9][a-z0-9-]{1,118}$/', $longSlug) === 1, 'a long title is cut to the slug length', (string) strlen($longSlug));
    ok(!str_starts_with(liveSlugify('---Live now---'), '-') && !str_ends_with(liveSlugify('---Live now---'), '-'), 'no leading or trailing hyphen');
    ok(threw(fn() => liveSlugify('')) === null && threw(fn() => liveSlugify('<script>alert(1)</script>')) === null, 'liveSlugify never throws');
    // Digits alone would be read as an id by /api/live-streams/<x> and /live-darshan/<x>.
    eq(liveSlugify('2027'), '2027-darshan', 'a title of digits only gets -darshan appended');
    eq(liveSlugify('  2026 !! '), '2026-darshan', '…after the usual cleaning');
    eq(liveSlugify('Deepam 2026'), 'deepam-2026', 'digits with letters are left alone');
    ok(preg_match(LIVE_SLUG_RE, '12345') !== 1 && preg_match(LIVE_SLUG_RE, '2027-darshan') === 1 && preg_match(LIVE_SLUG_RE, 'a1') === 1, 'LIVE_SLUG_RE refuses digits only and accepts the rest');

    $slugA = "{$SLUG}-" . ($slugN + 1);
    $idA = $makeStream('Future A');
    eq($row($idA)['slug'] ?? null, $slugA, 'a stream is stored with the slug asked for');
    eq(liveUniqueSlug($db, $slugA, null), "{$slugA}-2", 'liveUniqueSlug appends -2 to a taken slug');
    eq(liveUniqueSlug($db, $slugA, $idA), $slugA, '…unless the row that holds it is the one being edited');
    $idA2 = $makeStream('Future A2', ['slug' => "{$slugA}-2", 'scheduled_date' => $dayAfter]);
    eq(liveUniqueSlug($db, $slugA, null), "{$slugA}-3", 'with -2 taken as well it appends -3');
    eq(liveUniqueSlug($db, "{$SLUG}-fresh", null), "{$SLUG}-fresh", 'a free slug is returned as it is');
    $idDeleted = $makeStream('Deleted G');
    $slugDeleted = $row($idDeleted)['slug'];
    ok(liveSoftDelete($db, $idDeleted, $ACTOR), 'a stream is soft-deleted for the uniqueness check');
    eq(liveUniqueSlug($db, $slugDeleted, null), "{$slugDeleted}-2", 'a deleted row still holds its slug');

    /* ── 5. Validation ───────────────────────────────────────────────────── */
    section('5. liveValidate (§4.2)');
    $field = static function (string $label, array $over, string $key, ?array $existing = null, ?string $needle = null) use ($db, $base): array {
        $in = $base;
        foreach ($over as $k => $v) {
            if ($v === '__unset__') unset($in[$k]); else $in[$k] = $v;
        }
        $r = liveValidate($in, $existing, $db);
        $has = isset($r['errors'][$key]) && is_string($r['errors'][$key]) && $r['errors'][$key] !== '';
        if ($has && $needle !== null) $has = stripos($r['errors'][$key], $needle) !== false;
        ok($has, "{$label} → a field error on \"{$key}\"" . ($needle !== null ? " saying \"{$needle}\"" : ''), json_encode($r['errors'] ?? null, JSON_UNESCAPED_UNICODE));
        return $r;
    };
    $clean = static function (string $label, array $over, ?array $existing = null) use ($db, $base): array {
        $in = $base;
        foreach ($over as $k => $v) {
            if ($v === '__unset__') unset($in[$k]); else $in[$k] = $v;
        }
        $r = liveValidate($in, $existing, $db);
        eq($r['errors'], [], "{$label} → no errors");
        return $r;
    };
    $LONG = str_repeat('ஃ', 600);
    $XSS = '"><script>alert(1)</script>';

    $v = $clean('a complete stream', []);
    ok(is_array($v['values']) && is_array($v['errors']), 'liveValidate returns values and errors');
    eq($v['values']['provider_broadcast_id'] ?? null, $YT, 'the pasted link is parsed to the video id');
    eq($v['values']['scheduled_start_at'] ?? null, liveToUtc("{$tomorrow} 18:00", 'Asia/Kolkata'), 'the start is converted to UTC');
    eq($v['values']['scheduled_end_at'] ?? null, liveToUtc("{$tomorrow} 19:30", 'Asia/Kolkata'), 'and so is the end');
    eq($v['values']['timezone'] ?? null, 'Asia/Kolkata', 'the zone is kept');
    ok(preg_match('/^[a-z0-9][a-z0-9-]{1,118}$/', (string) ($v['values']['slug'] ?? '')) === 1 && str_starts_with((string) $v['values']['slug'], 'e2e-live-unit-'), 'the slug is generated from title_en on create', json_encode($v['values']['slug'] ?? null));
    eq($v['values']['title_ta'] ?? null, "{$NAME} தரிசனம்", 'the Tamil title survives unchanged');
    ok(in_array($v['values']['is_featured'] ?? null, [true, 1], true) && in_array($v['values']['archive_enabled'] ?? null, [true, 1], true), 'checked flags are true');
    eq($v['values']['status'] ?? null, 'SCHEDULED', 'the status is kept');
    eq((int) ($v['values']['temple_id'] ?? 0), $templeId, 'the temple id is an int');
    eq((int) ($v['values']['deity_id'] ?? 0), $deityId, 'the deity id is an int');

    foreach ([
        ['title_ta missing', ['title_ta' => '__unset__'], 'title_ta'],
        ['title_ta blank', ['title_ta' => '   '], 'title_ta'],
        ['title_ta of one character', ['title_ta' => 'அ'], 'title_ta'],
        ['title_ta of 301 code points', ['title_ta' => str_repeat('அ', 301)], 'title_ta'],
        ['title_ta of 600 characters', ['title_ta' => $LONG], 'title_ta'],
        ['title_ta as an array', ['title_ta' => ['x']], 'title_ta'],
        ['title_ta that is only a tag', ['title_ta' => '<b></b>'], 'title_ta'],
        ['title_en missing', ['title_en' => '__unset__'], 'title_en'],
        ['title_en of one character', ['title_en' => 'A'], 'title_en'],
        ['title_en of 301 characters', ['title_en' => str_repeat('a', 301)], 'title_en'],
        ['title_en as a nested object', ['title_en' => ['a' => ['b' => 'x']]], 'title_en'],
        ['title_en null', ['title_en' => null], 'title_en'],
        ['description_ta of 5001 characters', ['description_ta' => str_repeat('அ', 5001)], 'description_ta'],
        ['description_en as an array', ['description_en' => ['x']], 'description_en'],
        ['description_en of 20000 characters', ['description_en' => str_repeat('d', 20000)], 'description_en'],
        ['slug with spaces', ['slug' => 'bad slug'], 'slug'],
        ['slug with capitals and punctuation', ['slug' => 'Bad_Slug!'], 'slug'],
        ['slug of one character', ['slug' => 'a'], 'slug'],
        ['slug starting with a hyphen', ['slug' => '-abc'], 'slug'],
        ['slug of digits only', ['slug' => '12345'], 'slug'],
        ['slug of 121 characters', ['slug' => str_repeat('a', 121)], 'slug'],
        ['slug as an array', ['slug' => ['abc']], 'slug'],
        ['slug "live" (reserved)', ['slug' => 'live'], 'slug'],
        ['slug "upcoming" (reserved)', ['slug' => 'upcoming'], 'slug'],
        ['slug "schedule" (reserved)', ['slug' => 'schedule'], 'slug'],
        ['slug "archive" (reserved)', ['slug' => 'archive'], 'slug'],
        ['slug already taken', ['slug' => $slugA], 'slug'],
        ['slug taken, in capitals', ['slug' => strtoupper($slugA)], 'slug'],
        ['slug of a deleted stream', ['slug' => $slugDeleted], 'slug'],
        ['temple_id missing', ['temple_id' => '__unset__'], 'temple_id'],
        ['temple_id blank', ['temple_id' => ''], 'temple_id'],
        ['temple_id that does not exist', ['temple_id' => '999999999'], 'temple_id'],
        ['temple_id as text', ['temple_id' => 'abc'], 'temple_id'],
        ['temple_id as an array', ['temple_id' => ['1']], 'temple_id'],
        ['deity_id that does not exist', ['deity_id' => '999999999'], 'deity_id'],
        ['deity_id as text', ['deity_id' => 'abc'], 'deity_id'],
        ['deity_id as an array', ['deity_id' => [$deityId]], 'deity_id'],
        ['event_type unknown', ['event_type' => 'nonsense'], 'event_type'],
        ['event_type with script', ['event_type' => $XSS], 'event_type'],
        ['event_type as an array', ['event_type' => ['festival']], 'event_type'],
        ['provider unknown', ['provider' => 'nonsense'], 'provider'],
        ['provider as an array', ['provider' => ['youtube']], 'provider'],
        ['provider_reference blank while SCHEDULED', ['provider_reference' => ''], 'provider_reference'],
        ['provider_reference missing while SCHEDULED', ['provider_reference' => '__unset__'], 'provider_reference'],
        ['provider_reference that is not a link or id', ['provider_reference' => 'not a link'], 'provider_reference'],
        ['provider_reference live_stream', ['provider_reference' => 'https://www.youtube.com/embed/live_stream?channel=UCx'], 'provider_reference'],
        ['provider_reference with script', ['provider_reference' => $XSS], 'provider_reference'],
        ['provider_reference as an array', ['provider_reference' => [$YT]], 'provider_reference'],
        ['provider_reference of 600 characters', ['provider_reference' => $LONG], 'provider_reference'],
        ['custom provider without a playback URL', ['provider' => 'custom', 'provider_reference' => 'ref', 'playback_url' => ''], 'playback_url'],
        ['playback_url javascript:', ['playback_url' => 'javascript:alert(1)'], 'playback_url'],
        ['playback_url http:', ['playback_url' => 'http://example.org/live'], 'playback_url'],
        ['playback_url with script', ['playback_url' => $XSS], 'playback_url'],
        ['playback_url of 600 characters', ['playback_url' => 'https://example.org/' . str_repeat('a', 600)], 'playback_url'],
        ['playback_url as an array', ['playback_url' => ['https://example.org']], 'playback_url'],
        ['thumbnail_url javascript:', ['thumbnail_url' => 'JavaScript:alert(1)'], 'thumbnail_url'],
        ['thumbnail_url http:', ['thumbnail_url' => 'http://example.org/a.png'], 'thumbnail_url'],
        ['thumbnail_url protocol-relative', ['thumbnail_url' => '//evil.example/a.png'], 'thumbnail_url'],
        ['thumbnail_url data:', ['thumbnail_url' => 'data:text/html,<script>alert(1)</script>'], 'thumbnail_url'],
        ['thumbnail_url as an array', ['thumbnail_url' => ['/uploads/a.png']], 'thumbnail_url'],
        ['banner_url javascript:', ['banner_url' => 'javascript:alert(1)'], 'banner_url'],
        ['banner_url with script', ['banner_url' => $XSS], 'banner_url'],
        ['scheduled_date 9999-99-99', ['scheduled_date' => '9999-99-99'], 'scheduled_date'],
        ['scheduled_date 30 February', ['scheduled_date' => '2026-02-30'], 'scheduled_date'],
        ['scheduled_date written 14-09-2026', ['scheduled_date' => '14-09-2026'], 'scheduled_date'],
        ['scheduled_date blank while SCHEDULED', ['scheduled_date' => ''], 'scheduled_date'],
        ['scheduled_date missing while SCHEDULED', ['scheduled_date' => '__unset__'], 'scheduled_date'],
        ['scheduled_date as an array', ['scheduled_date' => [$tomorrow]], 'scheduled_date'],
        ['scheduled_date with script', ['scheduled_date' => $XSS], 'scheduled_date'],
        ['start_time 25:00', ['start_time' => '25:00'], 'start_time'],
        ['start_time text', ['start_time' => 'six pm'], 'start_time'],
        ['start_time blank while SCHEDULED', ['start_time' => ''], 'start_time'],
        ['start_time as an array', ['start_time' => ['18:00']], 'start_time'],
        ['end_time before the start', ['end_time' => '17:00'], 'end_time'],
        ['end_time equal to the start', ['end_time' => '18:00'], 'end_time'],
        ['end_time text', ['end_time' => 'later'], 'end_time'],
        ['end_time as an array', ['end_time' => ['19:00']], 'end_time'],
        ['end_date 9999-99-99', ['end_date' => '9999-99-99', 'end_time' => '02:00'], 'end_date'],
        ['timezone unknown', ['timezone' => 'Not/AZone'], 'timezone'],
        ['timezone with script', ['timezone' => $XSS], 'timezone'],
        ['timezone as an array', ['timezone' => ['Asia/Kolkata']], 'timezone'],
        ['status unknown', ['status' => 'nonsense'], 'status'],
        ['status with script', ['status' => $XSS], 'status'],
        ['status as an array', ['status' => ['LIVE']], 'status'],
        ['status LIVE on create', ['status' => 'LIVE'], 'status'],
        ['status COMPLETED on create', ['status' => 'COMPLETED'], 'status'],
    ] as [$label, $over, $key]) {
        $field($label, $over, $key);
    }
    $field('provider vimeo', ['provider' => 'vimeo'], 'provider', null, 'not available yet');
    $field('provider aws_ivs', ['provider' => 'aws_ivs'], 'provider', null, 'not available yet');
    $endBeforeStartNextDay = liveValidate(array_replace($base, ['end_date' => $yesterday, 'end_time' => '19:00']), null, $db);
    ok(isset($endBeforeStartNextDay['errors']['end_time']) || isset($endBeforeStartNextDay['errors']['end_date']), 'an end_date before the start date → an error on end_time or end_date', json_encode($endBeforeStartNextDay['errors'] ?? null));

    $clean('DRAFT without a video id', ['status' => 'DRAFT', 'provider_reference' => '']);
    $clean('DRAFT without a schedule', ['status' => 'DRAFT', 'scheduled_date' => '', 'start_time' => '', 'end_time' => '']);
    $clean('no end time', ['end_time' => '']);
    $clean('an overnight stream with end_date the next day', ['end_date' => $dayAfter, 'end_time' => '02:00']);
    $clean('no deity', ['deity_id' => '']);
    $clean('a bare video id', ['provider_reference' => $YT]);
    $clean('a youtu.be link', ['provider_reference' => "https://youtu.be/{$YT}?t=10"]);
    $clean('the custom provider with an https playback URL', ['provider' => 'custom', 'provider_reference' => 'my ref', 'playback_url' => 'https://cdn.example/live.m3u8']);
    $clean('an https thumbnail and banner', ['thumbnail_url' => 'https://i.ytimg.com/vi/x/hq.jpg', 'banner_url' => 'https://example.org/b.webp']);
    $clean('site-path images', ['thumbnail_url' => '/uploads/live-abc.png', 'banner_url' => '/uploads/live-def.jpg']);
    $clean('an https playback override', ['playback_url' => "https://youtu.be/{$YT}"]);
    $clean('a blank timezone (defaults to Asia/Kolkata)', ['timezone' => '']);
    eq(liveValidate(array_replace($base, ['timezone' => '']), null, $db)['values']['timezone'] ?? null, 'Asia/Kolkata', 'a blank timezone stores Asia/Kolkata');
    $ny = $clean('a New York schedule', ['timezone' => 'America/New_York', 'scheduled_date' => '2026-07-04', 'start_time' => '10:00', 'end_time' => '11:00']);
    eq($ny['values']['scheduled_start_at'] ?? null, '2026-07-04 14:00:00', 'converted from EDT');
    $overnight = $clean('overnight values', ['end_date' => $dayAfter, 'end_time' => '02:00']);
    eq($overnight['values']['scheduled_end_at'] ?? null, liveToUtc("{$dayAfter} 02:00", 'Asia/Kolkata'), 'the overnight end lands on the next day in UTC');
    $desc300 = $clean('title_en of exactly 300 characters', ['title_en' => str_pad("{$NAME} ", 300, 'x')]);
    eq(mb_strlen((string) ($desc300['values']['title_en'] ?? '')), 300, 'the 300-character title is kept whole');
    $tags = $clean('a title carrying HTML', ['title_en' => "{$NAME} <b>Bold</b><script>alert(1)</script>"]);
    ok(!str_contains((string) ($tags['values']['title_en'] ?? ''), '<') && str_contains((string) ($tags['values']['title_en'] ?? ''), 'Bold'), 'tags are stripped by sanitizeText before the length is measured', json_encode($tags['values']['title_en'] ?? null));
    $desc5000 = $clean('description_en of exactly 5000 characters', ['description_en' => str_repeat('d', 5000)]);
    eq(mb_strlen((string) ($desc5000['values']['description_en'] ?? '')), 5000, 'the 5000-character description is kept whole');
    // publicGuardConsent() semantics: true, 1, "1", "true" mean yes (and "on", what a bare checkbox posts); anything else is no.
    foreach (['1' => true, 'true' => true, 'on' => true, 'yes' => false, '0' => false, '' => false, 'off' => false, 'false' => false, 'TRUE' => false] as $val => $expected) {
        $r = liveValidate(array_replace($base, ['is_featured' => (string) $val]), null, $db);
        eq((bool) ($r['values']['is_featured'] ?? null), $expected, "is_featured \"{$val}\" is " . ($expected ? 'true' : 'false'));
    }
    $r = liveValidate(array_replace($base, ['is_featured' => true, 'show_on_homepage' => 1, 'donations_enabled' => false]), null, $db);
    ok((bool) $r['values']['is_featured'] && (bool) $r['values']['show_on_homepage'] && !$r['values']['donations_enabled'], 'JSON true, 1 and false are read as booleans');
    $r = liveValidate($without($base, 'is_featured', 'show_on_homepage'), null, $db);
    ok(!($r['values']['is_featured'] ?? false) && !($r['values']['show_on_homepage'] ?? false) && $r['errors'] === [], 'a missing checkbox is false (checkbox semantics), not an error', json_encode($r['errors']));
    $r = liveValidate(array_replace($base, ['is_featured' => ['1'], 'sharing_enabled' => ['x' => 1]]), null, $db);
    ok($r['errors'] === [] && !($r['values']['is_featured'] ?? false), 'a checkbox sent as an array is simply unchecked', json_encode($r['errors']));

    // Hostile bodies: errors, never exceptions.
    $empty = liveValidate([], null, $db);
    ok(isset($empty['errors']['title_ta'], $empty['errors']['title_en'], $empty['errors']['temple_id']), 'an empty body names title_ta, title_en and temple_id', json_encode($empty['errors']));
    $arrays = [];
    foreach (array_keys($base) as $k) $arrays[$k] = [$XSS, 1];
    $hostile = null;
    ok(threw(function () use (&$hostile, $arrays, $db) { $hostile = liveValidate($arrays, null, $db); }) === null && count($hostile['errors'] ?? []) >= 8, 'a body of arrays everywhere answers with field errors, never an exception', json_encode(array_keys($hostile['errors'] ?? [])));
    $objects = [];
    foreach (array_keys($base) as $k) $objects[$k] = ['a' => ['b' => ['c' => 'x']]];
    ok(threw(fn() => liveValidate($objects, null, $db)) === null, 'nested objects everywhere never throw');
    $nulls = array_fill_keys(array_keys($base), null);
    ok(threw(fn() => liveValidate($nulls, null, $db)) === null, 'null everywhere never throws');
    $numbers = array_fill_keys(array_keys($base), 1e30);
    ok(threw(fn() => liveValidate($numbers, null, $db)) === null, 'huge numbers everywhere never throw');
    $everyXss = array_fill_keys(array_keys($base), $XSS);
    $xssResult = liveValidate($everyXss, null, $db);
    ok(threw(fn() => liveValidate($everyXss, null, $db)) === null && !str_contains(json_encode($xssResult['errors'], JSON_UNESCAPED_UNICODE), '<script>'), 'script in every field never throws and is never echoed inside an error message');

    // Update rules: status must be a legal transition from the stored status, or unchanged.
    $existing = $row($idA);
    $clean('an update that keeps SCHEDULED', ['slug' => $slugA, 'status' => 'SCHEDULED'], $existing);
    $clean('an update SCHEDULED → LIVE', ['slug' => $slugA, 'status' => 'LIVE'], $existing);
    $clean('an update SCHEDULED → DRAFT', ['slug' => $slugA, 'status' => 'DRAFT'], $existing);
    $field('an update SCHEDULED → COMPLETED', ['slug' => $slugA, 'status' => 'COMPLETED'], 'status', $existing, 'not allowed');
    $field('an update SCHEDULED → OFFLINE', ['slug' => $slugA, 'status' => 'OFFLINE'], 'status', $existing, 'not allowed');
    $clean("an update keeping the row's own slug", ['slug' => $slugA], $existing);
    $clean("an update keeping the row's own slug in capitals", ['slug' => strtoupper($slugA)], $existing);
    $field("an update taking another row's slug", ['slug' => "{$slugA}-2"], 'slug', $existing);
    // The address is fixed once published (share links): a SCHEDULED row refuses a new slug; a DRAFT does not.
    $field("an update changing a published row's slug", ['slug' => "{$slugA}-moved"], 'slug', $existing, 'locked after publishing');
    $draftRow = $row($makeStream('Draft slug', ['provider_reference' => '', 'scheduled_date' => '', 'start_time' => '', 'end_time' => ''], 'DRAFT'));
    $clean("an update changing a draft's slug", ['slug' => "{$SLUG}-draft-moved", 'status' => 'DRAFT', 'provider_reference' => '', 'scheduled_date' => '', 'start_time' => '', 'end_time' => ''], $draftRow);
    // This row was only for the slug rule; the list checks below count drafts.
    $db->prepare('DELETE FROM admin_activity WHERE subject = :s')->execute([':s' => 'Stream #' . (int) $draftRow['id']]);
    $db->prepare('DELETE FROM live_streams WHERE id = :id')->execute([':id' => (int) $draftRow['id']]);
    unset($made['Draft slug']);

    // Temple and deity integrity: a second temple with its own deity.
    $db->prepare("INSERT INTO temples (slug, name_ta, name_en, short_name_ta, short_name_en, timezone, is_active, sort_order, created_at, updated_at)
                  VALUES (:s, 'சோதனை கோயில்', 'E2E Unit Temple', 'சோதனை', 'E2E', 'Asia/Kolkata', 1, 99, UTC_TIMESTAMP(), UTC_TIMESTAMP())")
       ->execute([':s' => "e2e-unit-{$run}"]);
    $otherTempleId = (int) $db->lastInsertId();
    $db->prepare("INSERT INTO deities (temple_id, slug, name_ta, name_en, sort_order, is_active, created_at, updated_at)
                  VALUES (:t, 'e2e-deity', 'சோதனை தெய்வம்', 'E2E Deity', 1, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())")
       ->execute([':t' => $otherTempleId]);
    $otherDeityId = (int) $db->lastInsertId();
    $field("a deity of another temple", ['deity_id' => (string) $otherDeityId], 'deity_id');
    $clean('the other temple with its own deity', ['temple_id' => (string) $otherTempleId, 'deity_id' => (string) $otherDeityId]);
    $db->prepare('UPDATE temples SET is_active = 0 WHERE id = :id')->execute([':id' => $otherTempleId]);
    $field('an inactive temple', ['temple_id' => (string) $otherTempleId, 'deity_id' => ''], 'temple_id');
    $db->prepare('UPDATE temples SET is_active = 1 WHERE id = :id')->execute([':id' => $otherTempleId]);
    $opts = json_encode(liveTempleOptions($db), JSON_UNESCAPED_UNICODE);
    ok(str_contains($opts, 'E2E Unit Temple') && str_contains($opts, 'pudupatti'), 'liveTempleOptions lists both temples', substr($opts, 0, 300));
    $deityOpts = json_encode(liveDeityOptions($db, $otherTempleId), JSON_UNESCAPED_UNICODE);
    ok(str_contains($deityOpts, 'E2E Deity') && !str_contains($deityOpts, 'renukadevi'), 'liveDeityOptions filters by temple', substr($deityOpts, 0, 300));
    $allDeities = json_encode(liveDeityOptions($db, null), JSON_UNESCAPED_UNICODE);
    ok(str_contains($allDeities, 'E2E Deity') && str_contains($allDeities, 'renukadevi'), 'liveDeityOptions(null) lists every deity', substr($allDeities, 0, 300));

    /* ── 6. Store ────────────────────────────────────────────────────────── */
    section('6. The store (§4.1 store.php)');
    $a = $row($idA);
    eq($a['created_by'] ?? null, $ACTOR, 'liveInsert records created_by');
    eq($a['updated_by'] ?? null, $ACTOR, 'and updated_by');
    ok(($a['created_at'] ?? null) !== null && abs(strtotime($a['created_at'] . ' UTC') - time()) <= 120, 'created_at is UTC now', (string) ($a['created_at'] ?? null));
    eq($a['status'] ?? null, 'SCHEDULED', 'the row is SCHEDULED');
    eq($a['provider_broadcast_id'] ?? null, $YT, 'the video id is stored in provider_broadcast_id');
    ok(array_key_exists('deleted_at', $a) && $a['deleted_at'] === null, 'deleted_at is NULL', json_encode($a['deleted_at'] ?? 'missing'));
    ok(isset($a['temple_slug']) || isset($a['temple_name_en']) || isset($a['temple']), 'the loaded row is joined with the temple', implode(',', array_keys($a)));
    $created = $lastAudit($idA, 'live_stream_create');
    ok($created !== null && $created['actor'] === $ACTOR && str_contains((string) $created['detail'], 'Future A'), 'liveInsert audits live_stream_create for the actor, naming the title', json_encode($created));

    $vals = liveValidate(array_replace($base, ['slug' => $slugA, 'title_en' => "{$NAME} Future A renamed", 'description_en' => 'Edited']), $a, $db);
    eq($vals['errors'], [], 'an edit validates against the stored row');
    $before = $row($idA);
    liveUpdate($db, $idA, $vals['values'], 'e2e-editor');
    $after = $row($idA);
    eq($after['title_en'] ?? null, "{$NAME} Future A renamed", 'liveUpdate changes the title');
    eq($after['updated_by'] ?? null, 'e2e-editor', 'and records who did it');
    ok(($after['updated_at'] ?? '') >= ($before['updated_at'] ?? ''), 'updated_at moves forward');
    eq([$after['slug'], $after['status'], $after['created_by'], $after['scheduled_start_at']], [$before['slug'], $before['status'], $before['created_by'], $before['scheduled_start_at']], 'nothing else changed');
    $updated = $lastAudit($idA, 'live_stream_update');
    ok($updated !== null && $updated['actor'] === 'e2e-editor' && (str_contains((string) $updated['detail'], 'title_en') || str_contains((string) $updated['detail'], 'description_en')), 'liveUpdate audits live_stream_update naming the changed fields', json_encode($updated));
    ok(mb_strlen((string) ($updated['detail'] ?? '')) <= 500, 'the audit detail is at most 500 characters');

    $idLive = $makeStream('Live B', ['deity_id' => (string) $deityId], 'LIVE');
    $idStarting = $makeStream('Starting C', ['scheduled_date' => $tomorrow, 'start_time' => '05:00', 'end_time' => '06:00'], 'STARTING');
    $idCompleted = $makeStream('Completed D', [], 'COMPLETED');
    $idCancelled = $makeStream('Cancelled E', [], 'CANCELLED');
    $idDraft = $makeStream('Draft F', ['provider_reference' => '', 'scheduled_date' => '', 'start_time' => '', 'end_time' => ''], 'DRAFT');
    $idPast = $makeStream('Past H');
    $db->prepare('UPDATE live_streams SET scheduled_start_at = :s, scheduled_end_at = NULL WHERE id = :id')->execute([':s' => liveToUtc("{$yesterday} 18:00", 'Asia/Kolkata'), ':id' => $idPast]);
    $idNoStart = $makeStream('No start I');
    $db->prepare('UPDATE live_streams SET scheduled_start_at = NULL, scheduled_end_at = NULL WHERE id = :id')->execute([':id' => $idNoStart]);
    $idOffline = $makeStream('Offline J', [], 'OFFLINE');
    $idError = $makeStream('Error K', [], 'ERROR');
    // A SCHEDULED stream the committee is late to start: began 30 minutes ago, no end given (within the 3 h grace);
    // one that began 4 hours ago (grace over); one that began 5 hours ago but ends in 30 minutes (end wins).
    $idLate = $makeStream('Late L');
    $db->prepare('UPDATE live_streams SET scheduled_start_at = :s, scheduled_end_at = NULL WHERE id = :id')->execute([':s' => gmdate('Y-m-d H:i:s', time() - 30 * 60), ':id' => $idLate]);
    $idOver = $makeStream('Over M');
    $db->prepare('UPDATE live_streams SET scheduled_start_at = :s, scheduled_end_at = NULL WHERE id = :id')->execute([':s' => gmdate('Y-m-d H:i:s', time() - 4 * 3600), ':id' => $idOver]);
    $idEndsSoon = $makeStream('Ends soon N');
    $db->prepare('UPDATE live_streams SET scheduled_start_at = :s, scheduled_end_at = :e WHERE id = :id')->execute([':s' => gmdate('Y-m-d H:i:s', time() - 5 * 3600), ':e' => gmdate('Y-m-d H:i:s', time() + 30 * 60), ':id' => $idEndsSoon]);
    // Two LIVE broadcasts: the one that started most recently leads (it is the one the page features).
    $idLive2 = $makeStream('Live B2', ['scheduled_date' => $tomorrow, 'start_time' => '07:00'], 'LIVE');
    $db->prepare('UPDATE live_streams SET actual_start_at = :s WHERE id = :id')->execute([':s' => gmdate('Y-m-d H:i:s', time() - 2 * 3600), ':id' => $idLive]);
    $db->prepare('UPDATE live_streams SET actual_start_at = :s WHERE id = :id')->execute([':s' => gmdate('Y-m-d H:i:s', time() - 5 * 60), ':id' => $idLive2]);
    $mine = array_values($made);
    $only = static fn(array $rows): array => array_values(array_filter(array_map(static fn($r) => (int) ($r['id'] ?? 0), $rows), static fn(int $id) => in_array($id, $mine, true)));

    eq($only(liveListLive($db)), [$idLive2, $idLive, $idStarting], 'liveListLive lists LIVE first — the most recently started one leading — then STARTING, and nothing else');
    // Ended and removed again (the admin-list checks below count one COMPLETED stream).
    $db->prepare('DELETE FROM admin_activity WHERE subject = :s')->execute([':s' => 'Stream #' . $idLive2]);
    $db->prepare('DELETE FROM live_streams WHERE id = :id')->execute([':id' => $idLive2]);
    unset($made['Live B2']);
    $mine = array_values($made);
    eq($only(liveListLive($db)), [$idLive, $idStarting], 'without it the other LIVE stream leads again');
    $up = $only(liveListUpcoming($db, 100));
    $expectedUp = [$idEndsSoon, $idLate, $idA, $idA2];
    ok(array_slice($up, 0, 4) === $expectedUp, 'liveListUpcoming lists SCHEDULED streams that have not ended, soonest start first (a late one leads)', json_encode($up));
    ok(!in_array($idPast, $up, true) && !in_array($idOver, $up, true) && !in_array($idDraft, $up, true) && !in_array($idCancelled, $up, true) && !in_array($idCompleted, $up, true) && !in_array($idDeleted, $up, true) && !in_array($idLive, $up, true),
        'it excludes streams past their end (or start + 3 h), DRAFT, CANCELLED, COMPLETED, deleted and live streams', json_encode($up));
    ok(in_array($idNoStart, $up, true) && end($up) === $idNoStart, 'a SCHEDULED stream without a start time is listed last', json_encode($up));
    eq(count($only(liveListUpcoming($db, 1))), 1, 'the limit is honoured');

    eq((int) (liveLoadBySlug($db, $slugA)['id'] ?? 0), $idA, 'liveLoadBySlug finds a stream');
    eq(liveLoadBySlug($db, $slugDeleted), null, 'but never a deleted one');
    eq(liveLoadBySlug($db, "{$SLUG}-does-not-exist"), null, 'nor one that does not exist');
    eq((int) (liveLoadBySlug($db, $row($idDraft)['slug'])['id'] ?? 0), $idDraft, 'a DRAFT is loadable by slug at the store level (the API hides it)');
    eq(liveLoad($db, $idDeleted), null, 'liveLoad hides a deleted row by default');
    ok(($row($idDeleted)['deleted_at'] ?? null) !== null, 'liveLoad(withDeleted) returns it with deleted_at set');
    eq(liveLoad($db, 999999999), null, 'liveLoad of an unknown id is null');
    $locked = liveTransaction($db, static fn(PDO $db) => liveLoad($db, $idA, false, true));
    eq((int) ($locked['id'] ?? 0), $idA, 'liveLoad with a lock works inside liveTransaction');
    eq(liveTransaction($db, static fn(PDO $db): string => 'result'), 'result', "liveTransaction returns the callable's result");
    $rolled = threw(fn() => liveTransaction($db, static function (PDO $db) use ($idA): void {
        $db->prepare('UPDATE live_streams SET description_en = :d WHERE id = :id')->execute([':d' => 'ROLLED BACK', ':id' => $idA]);
        throw new RuntimeException('boom');
    }));
    ok($rolled !== null && str_contains($rolled, 'boom') && ($row($idA)['description_en'] ?? '') !== 'ROLLED BACK', 'liveTransaction rolls back and rethrows on an exception', (string) $rolled);
    ok(!$db->inTransaction(), 'no transaction is left open');

    ok(liveSoftDelete($db, $idCancelled, $ACTOR) === true, 'liveSoftDelete returns true');
    ok(($row($idCancelled)['deleted_at'] ?? null) !== null && ($row($idCancelled)['updated_by'] ?? null) === $ACTOR, 'the row has deleted_at and updated_by');
    ok(liveSoftDelete($db, $idCancelled, $ACTOR) === false, 'deleting it again returns false');
    ok(liveSoftDelete($db, 999999999, $ACTOR) === false, 'deleting an unknown id returns false');
    $deletedAudit = $lastAudit($idCancelled, 'live_stream_delete');
    ok($deletedAudit !== null && $deletedAudit['actor'] === $ACTOR, 'liveSoftDelete audits live_stream_delete', json_encode($deletedAudit));

    section('6b. liveListAdmin filters, sort and pages');
    $adminList = static function (array $filters, int $page = 1, int $per = 25) use ($db, $NAME): array {
        return liveListAdmin($db, liveAdminFilters($filters + ['q' => $NAME]), $page, $per);
    };
    $all = $adminList([]);
    eq(keysOf($all), ['page', 'pages', 'rows', 'total'], 'liveListAdmin returns rows, total, pages, page');
    $allIds = $only($all['rows']);
    ok(in_array($idA, $allIds, true) && in_array($idDraft, $allIds, true) && in_array($idLive, $allIds, true), '"all" lists scheduled, draft and live streams', json_encode($allIds));
    ok(!in_array($idDeleted, $allIds, true) && !in_array($idCancelled, $allIds, true), '"all" hides deleted streams', json_encode($allIds));
    eq((int) $all['total'], count($allIds), 'total counts the matching rows');
    $del = $only($adminList(['f' => 'deleted'])['rows']);
    sort($del);
    eq($del, [$idDeleted, $idCancelled], '"deleted" lists only the deleted streams');
    // The chips have no Offline / Error entry, so those broadcasts belong under "Live" (they are on air, with trouble).
    $liveRows = $only($adminList(['f' => 'live'])['rows']);
    sort($liveRows);
    $expectedLive = [$idLive, $idStarting, $idOffline, $idError];
    sort($expectedLive);
    eq($liveRows, $expectedLive, '"live" lists LIVE, STARTING, OFFLINE and ERROR');
    eq($only($adminList(['f' => 'draft'])['rows']), [$idDraft], '"draft" lists the draft');
    eq($only($adminList(['f' => 'completed'])['rows']), [$idCompleted], '"completed" lists the completed stream');
    $sched = $only($adminList(['f' => 'scheduled'])['rows']);
    sort($sched);
    $expectedSched = [$idA, $idA2, $idPast, $idNoStart, $idLate, $idOver, $idEndsSoon];
    sort($expectedSched);
    eq($sched, $expectedSched, '"scheduled" lists every SCHEDULED stream, past ones too');
    eq($only($adminList(['q' => "{$NAME} Starting"])['rows']), [$idStarting], 'q searches the title');
    eq($only($adminList(['q' => 'தரிசனம் Starting C'])['rows']), [$idStarting], 'q searches the Tamil title too');
    $byTitle = $adminList(['sort' => 'title', 'dir' => 'asc']);
    $titles = array_map(static fn($r) => (string) $r['title_en'], array_filter($byTitle['rows'], static fn($r) => in_array((int) $r['id'], $mine, true)));
    $sortedTitles = $titles;
    sort($sortedTitles, SORT_STRING | SORT_FLAG_CASE);
    eq(array_values($titles), $sortedTitles, 'sort=title dir=asc orders by the English title');
    $p1 = $adminList([], 1, 3);
    $p2 = $adminList([], 2, 3);
    ok(count($p1['rows']) === 3 && (int) $p1['pages'] === (int) ceil((int) $p1['total'] / 3) && (int) $p2['page'] === 2 && !array_intersect($only($p1['rows']), $only($p2['rows'])), 'pages of three do not overlap and pages is ceil(total/3)', json_encode([$p1['pages'], $p1['total'], count($p1['rows']), count($p2['rows'])]));
    $far = $adminList([], 999, 3);
    ok((int) $far['page'] <= (int) $far['pages'] && is_array($far['rows']), 'a page past the end is clamped', json_encode([$far['page'], $far['pages']]));
    ok(threw(fn() => liveListAdmin($db, liveAdminFilters(['f' => '"><script>', 'q' => str_repeat('x', 500), 'sort' => 'DROP TABLE', 'dir' => 'sideways', 'page' => '-1']), 1, 25)) === null, 'hostile filters never throw');

    /* ── 7. Transitions ──────────────────────────────────────────────────── */
    section('7. Transitions on a real row (§2)');
    $idT = $makeStream('Transitions T');
    $reset = static function (string $status) use ($db, $idT): void {
        $db->prepare('UPDATE live_streams SET status = :s, actual_start_at = NULL, actual_end_at = NULL WHERE id = :id')->execute([':s' => $status, ':id' => $idT]);
    };
    foreach (LIVE_STATUSES as $from) {
        foreach (LIVE_STATUSES as $to) {
            if ($from === $to) continue;
            $reset($from);
            $legal = in_array($to, $expectedTransitions[$from], true);
            $err = threw(fn() => liveSetStatus($db, $idT, $to, $ACTOR));
            $stored = $row($idT)['status'] ?? null;
            if ($legal) {
                ok($err === null && $stored === $to, "{$from} → {$to} is allowed", (string) ($err ?? "stored {$stored}"));
            } else {
                ok($err !== null && str_contains($err, 'LiveTransitionException') && $stored === $from, "{$from} → {$to} throws LiveTransitionException and changes nothing", (string) ($err ?? "no exception; stored {$stored}"));
            }
        }
    }
    $reset('COMPLETED');
    ok(count(array_filter(LIVE_STATUSES, fn($to) => $to !== 'COMPLETED' && threw(fn() => liveSetStatus($db, $idT, $to, $ACTOR)) === null)) === 0, 'COMPLETED is terminal');
    $reset('SCHEDULED');
    $same = threw(fn() => liveSetStatus($db, $idT, 'SCHEDULED', $ACTOR));
    $sameResult = $same === null ? liveSetStatus($db, $idT, 'SCHEDULED', $ACTOR) : null;
    ok(($same !== null && str_contains($same, 'LiveTransitionException')) || ($sameResult !== null && $sameResult['changed'] === false), 'setting the same status again is a no-op or a refused jump, never a phantom change', json_encode([$same, $sameResult]));
    ok(threw(fn() => liveSetStatus($db, $idT, 'NONSENSE', $ACTOR)) !== null, 'an unknown target status is refused');
    ok(threw(fn() => liveSetStatus($db, 999999999, 'LIVE', $ACTOR)) !== null, 'an unknown stream is refused');

    section('7a. A row without a video id or a start time cannot enter a public status');
    $idBare = $makeStream('Bare O', ['provider_reference' => '', 'scheduled_date' => '', 'start_time' => '', 'end_time' => ''], 'DRAFT');
    $bareErr = threw(fn() => liveSetStatus($db, $idBare, 'SCHEDULED', $ACTOR));
    ok($bareErr !== null && str_contains($bareErr, 'LiveValidationException') && ($row($idBare)['status'] ?? null) === 'DRAFT', 'DRAFT → SCHEDULED on a bare draft throws LiveValidationException and changes nothing', (string) $bareErr);
    $bareFields = null;
    try { liveSetStatus($db, $idBare, 'SCHEDULED', $ACTOR); } catch (LiveValidationException $e) { $bareFields = $e->fields; }
    ok(is_array($bareFields) && isset($bareFields['provider_reference'], $bareFields['scheduled_date']), 'the exception carries the field errors (provider_reference, scheduled_date)', json_encode($bareFields));
    ok(liveSetStatus($db, $idBare, 'CANCELLED', $ACTOR)['to'] === 'CANCELLED', 'DRAFT → CANCELLED needs no video id (it is not a public showing)');
    ok(threw(fn() => liveSetStatus($db, $idBare, 'SCHEDULED', $ACTOR)) !== null && ($row($idBare)['status'] ?? null) === 'CANCELLED', 'CANCELLED → SCHEDULED on the bare row is refused as well');
    ok(liveAdminActions($row($idBare)) !== [] && !in_array('SCHEDULED', array_column(liveAdminActions($row($idBare)), 'to'), true), 'liveAdminActions offers no Publish for it (Restore to draft only)', json_encode(array_column(liveAdminActions($row($idBare)), 'to')));
    ok(!liveReadyToPublish($row($idBare)) && liveReadyToPublish($row($idA)), 'liveReadyToPublish: false for the bare row, true for a scheduled one');
    liveUpdate($db, $idBare, ['provider_broadcast_id' => $YT, 'scheduled_start_at' => liveToUtc("{$tomorrow} 06:00", 'Asia/Kolkata')], $ACTOR);
    ok(liveSetStatus($db, $idBare, 'SCHEDULED', $ACTOR)['to'] === 'SCHEDULED', 'once a video id and a start time are stored the same transition succeeds');
    ok(in_array('LIVE', array_column(liveAdminActions($row($idBare)), 'to'), true), 'and liveAdminActions now offers Go live');
    $idBareLive = $makeStream('Bare P', [], 'SCHEDULED');
    $db->prepare('UPDATE live_streams SET provider_broadcast_id = NULL WHERE id = :id')->execute([':id' => $idBareLive]);
    ok(threw(fn() => liveSetStatus($db, $idBareLive, 'LIVE', $ACTOR)) !== null && ($row($idBareLive)['status'] ?? null) === 'SCHEDULED', 'SCHEDULED → LIVE is refused when the video id was cleared (entering STARTING/LIVE re-validates too)');

    section('7b. Effects: actual times and the audit line');
    $reset('SCHEDULED');
    $r1 = liveSetStatus($db, $idT, 'LIVE', $ACTOR);
    eq([$r1['changed'] ?? null, $r1['from'] ?? null, $r1['to'] ?? null], [true, 'SCHEDULED', 'LIVE'], 'liveSetStatus returns changed, from, to');
    $t = $row($idT);
    ok($t['actual_start_at'] !== null && abs(strtotime($t['actual_start_at'] . ' UTC') - time()) <= 60, 'the first entry into LIVE sets actual_start_at to now (UTC)', (string) $t['actual_start_at']);
    eq($t['actual_end_at'], null, 'actual_end_at stays NULL');
    eq($t['updated_by'], $ACTOR, 'updated_by is the actor');
    $audit = $lastAudit($idT, 'live_stream_status');
    ok($audit !== null && $audit['actor'] === $ACTOR && $audit['subject'] === "Stream #{$idT}" && str_starts_with((string) $audit['detail'], "SCHEDULED → LIVE by {$ACTOR}"), 'the audit row is live_stream_status / Stream #id / "from → to by actor"', json_encode($audit, JSON_UNESCAPED_UNICODE));
    $firstStart = $t['actual_start_at'];
    $db->prepare('UPDATE live_streams SET actual_start_at = :s WHERE id = :id')->execute([':s' => '2026-01-01 00:00:00', ':id' => $idT]);
    liveSetStatus($db, $idT, 'OFFLINE', $ACTOR);
    liveSetStatus($db, $idT, 'LIVE', $ACTOR);
    eq($row($idT)['actual_start_at'], '2026-01-01 00:00:00', 'going LIVE again keeps the first actual_start_at');
    liveSetStatus($db, $idT, 'COMPLETED', $ACTOR);
    $t = $row($idT);
    ok($t['actual_end_at'] !== null && abs(strtotime($t['actual_end_at'] . ' UTC') - time()) <= 60, 'COMPLETED sets actual_end_at', (string) $t['actual_end_at']);
    $stmt = $db->prepare("SELECT COUNT(*) FROM admin_activity WHERE subject = ? AND action = 'live_stream_status'");
    $stmt->execute(["Stream #{$idT}"]);
    ok((int) $stmt->fetchColumn() >= 4, 'every status change wrote an audit row');
    $reset('STARTING');
    liveSetStatus($db, $idT, 'LIVE', $ACTOR);
    ok($row($idT)['actual_start_at'] !== null, 'STARTING → LIVE sets actual_start_at as well');
    ok(($row($idLive)['actual_start_at'] ?? null) !== null, 'the LIVE fixture made through the store has actual_start_at');
    ok(($row($idCompleted)['actual_end_at'] ?? null) !== null, 'the COMPLETED fixture has actual_end_at');

    /* ── 8. Shapes ───────────────────────────────────────────────────────── */
    section('8. liveShapePublic and liveShapeAdmin (§4.3, §4.4)');
    $publicKeys = ['id', 'slug', 'title_ta', 'title_en', 'description_ta', 'description_en', 'event_type', 'event_type_label', 'provider', 'status', 'is_live',
                   'temple', 'deity', 'scheduled_start_at', 'scheduled_end_at', 'actual_start_at', 'actual_end_at', 'timezone', 'local', 'thumbnail_url', 'banner_url', 'playback', 'flags'];
    sort($publicKeys);
    $pubLive = liveShapePublic($row($idLive));
    eq(keysOf($pubLive), $publicKeys, 'the public shape has exactly the §4.3 keys');
    foreach (['provider_stream_id', 'created_by', 'updated_by', 'deleted_at', 'temple_id', 'deity_id', 'created_at', 'updated_at', 'provider_broadcast_id', 'playback_url', 'recording_url'] as $k) {
        ok(!array_key_exists($k, $pubLive), "…and never {$k}");
    }
    eq($pubLive['id'], $idLive, 'id is an int');
    eq($pubLive['is_live'], true, 'a LIVE stream is is_live true');
    eq(liveShapePublic($row($idA))['is_live'], false, 'a SCHEDULED one is not');
    eq(liveShapePublic($row($idStarting))['is_live'], true, 'STARTING counts as live');
    eq($pubLive['event_type_label'], ['ta' => LIVE_EVENT_TYPES['daily_pooja'][0], 'en' => LIVE_EVENT_TYPES['daily_pooja'][1]], 'event_type_label is {ta, en} from LIVE_EVENT_TYPES');
    eq(keysOf($pubLive['temple']), ['name_en', 'name_ta', 'short_name_en', 'short_name_ta', 'slug'], 'temple is {slug, name_ta, name_en, short_name_ta, short_name_en}');
    eq($pubLive['temple']['slug'], 'pudupatti', 'the temple slug');
    ok(preg_match('/\p{Tamil}/u', (string) $pubLive['temple']['name_ta']) === 1, 'the Tamil temple name is Tamil');
    eq(keysOf($pubLive['deity']), ['name_en', 'name_ta', 'slug'], 'deity is {slug, name_ta, name_en}');
    eq($pubLive['deity']['slug'], 'renukadevi', 'the deity slug');
    eq(liveShapePublic(array_replace($row($idA), ['deity_id' => null, 'deity_slug' => null, 'deity_name_ta' => null, 'deity_name_en' => null]))['deity'], null, 'no deity → null');
    ok(preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', (string) $pubLive['scheduled_start_at']) === 1 && preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', (string) $pubLive['actual_start_at']) === 1, 'instants are ISO-8601 with a Z', json_encode([$pubLive['scheduled_start_at'], $pubLive['actual_start_at']]));
    eq($pubLive['scheduled_start_at'], liveIso($row($idLive)['scheduled_start_at']), 'scheduled_start_at is the stored UTC instant');
    eq($pubLive['actual_end_at'], null, 'a NULL instant is null');
    eq($pubLive['timezone'], 'Asia/Kolkata', 'the zone');
    $localOf = static fn(array $shape): array => array_intersect_key($shape['local'] ?? [], ['date' => 1, 'start_time' => 1, 'end_time' => 1]);
    eq($localOf($pubLive), ['date' => $tomorrow, 'start_time' => '18:00', 'end_time' => '19:30'], 'local is the wall clock in the zone');
    eq($localOf(liveShapePublic($row($idNoStart))), ['date' => null, 'start_time' => null, 'end_time' => null], 'no schedule → nulls');
    $localExtras = array_diff(array_keys($pubLive['local'] ?? []), ['date', 'start_time', 'end_time', 'end_date']);
    ok($localExtras === [], 'local carries nothing beyond date, start_time, end_time (and end_date for an overnight stream)', implode(',', $localExtras));
    eq($pubLive['playback'], ['kind' => 'iframe', 'embedUrl' => "https://www.youtube-nocookie.com/embed/{$YT}?rel=0&playsinline=1", 'watchUrl' => "https://www.youtube.com/watch?v={$YT}"], 'playback is the provider descriptor');
    eq($pubLive['thumbnail_url'], "https://i.ytimg.com/vi/{$YT}/hqdefault.jpg", 'thumbnail_url defaults to hqdefault.jpg');
    eq($pubLive['banner_url'], null, 'banner_url is null when unset');
    eq($pubLive['flags'], ['featured' => true, 'showOnHomepage' => true, 'donations' => true, 'notifications' => true, 'sharing' => true, 'archive' => true], 'flags are booleans keyed as the contract says');
    eq($pubLive['provider'], 'youtube', 'provider');
    eq($pubLive['status'], 'LIVE', 'status');
    ok(is_string($pubLive['title_ta']) && is_string($pubLive['title_en']) && is_string($pubLive['slug']), 'titles and slug are strings');
    $adminShape = liveShapeAdmin($row($idLive));
    $adminKeys = array_merge($publicKeys, ['created_by', 'updated_by', 'created_at', 'updated_at', 'deleted_at', 'provider_broadcast_id', 'playback_url_raw', 'temple_id', 'deity_id']);
    sort($adminKeys);
    ok(array_diff($adminKeys, keysOf($adminShape)) === [], 'the admin shape is the public shape plus the §4.4 admin keys', implode(',', array_diff($adminKeys, keysOf($adminShape))));
    $adminExtras = array_diff(keysOf($adminShape), $adminKeys, ['thumbnail_url_raw']);
    ok($adminExtras === [], 'and nothing else (thumbnail_url_raw, the pasted link as typed, is the one tolerated extra)', implode(',', $adminExtras));
    eq([$adminShape['created_by'], $adminShape['provider_broadcast_id'], $adminShape['temple_id'], $adminShape['deity_id'], $adminShape['deleted_at']], [$ACTOR, $YT, $templeId, $deityId, null], 'the admin keys carry the row values');
    ok(preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', (string) $adminShape['created_at']) === 1, 'created_at is ISO-8601 Z too');
    ok(!array_key_exists('provider_stream_id', $adminShape), 'provider_stream_id is not even in the admin shape');
    $xssRow = array_replace($row($idA), ['title_en' => '"><script>alert(1)</script>', 'thumbnail_url' => 'javascript:alert(1)']);
    $xssShape = liveShapePublic($xssRow);
    ok($xssShape['title_en'] === '"><script>alert(1)</script>', 'the shape does not mangle text (escaping is the JSON encoder\'s and React\'s job)');
    ok(threw(fn() => liveShapePublic($xssRow)) === null, 'a hostile row never throws');

    /* ── 9. Media ────────────────────────────────────────────────────────── */
    section('9. liveSafeUrl, liveStoreImage, liveDeleteUpload (§4.1 media.php)');
    foreach ([
        ['/uploads/live-abc.png', '/uploads/live-abc.png'], ['/sevas', '/sevas'], ['  /events  ', '/events'],
        ['https://i.ytimg.com/vi/x/hqdefault.jpg', 'https://i.ytimg.com/vi/x/hqdefault.jpg'], ['HTTPS://Example.org/x', 'HTTPS://Example.org/x'],
        ['//evil.example/phish', null], ['http://example.org/', null], ['javascript:alert(1)', null], ['JavaScript:alert(1)', null],
        ['data:text/html,<script>alert(1)</script>', null], ['https://temple.org@evil.example/', null], ['/a b', null], ["/se\nvas", null],
        ['/\\evil.example', null], ['https:///nohost', null], ['sevas', null], ['', null], [null, null], [['/x'], null], [42, null],
        ['/' . str_repeat('a', 500), null], ['ftp://example.org', null], ['"><script>alert(1)</script>', null],
    ] as [$in, $expected]) {
        eq(liveSafeUrl($in), $expected, 'liveSafeUrl ' . json_encode($in, JSON_UNESCAPED_UNICODE) . ' → ' . json_encode($expected));
    }
    $uploadDir = realpath(__DIR__ . '/../backend/uploads') ?: (__DIR__ . '/../backend/uploads');
    $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
    $tmp = static function (string $name, string $bytes) use (&$tmpFiles): string {
        $path = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'e2e-live-unit-' . bin2hex(random_bytes(4)) . '-' . $name;
        file_put_contents($path, $bytes);
        $tmpFiles[] = $path;
        return $path;
    };
    $fileFor = static fn(string $path, string $name, int $error = UPLOAD_ERR_OK, ?int $size = null): array =>
        ['name' => $name, 'type' => 'image/png', 'tmp_name' => $path, 'error' => $error, 'size' => $size ?? (int) filesize($path)];
    $textPng = liveStoreImage($fileFor($tmp('text.png', 'hello, not an image'), 'text.png'), 'thumbnail');
    eq(keysOf($textPng), ['error', 'ok', 'url'], 'liveStoreImage returns exactly ok, url, error');
    ok($textPng['ok'] === false && $textPng['url'] === null && stripos((string) $textPng['error'], 'JPEG') !== false, 'a text file named .png is refused as not an image', json_encode($textPng));
    $phpPng = liveStoreImage($fileFor($tmp('evil.png', '<?php echo 1; ?>'), 'evil.php'), 'thumbnail');
    ok($phpPng['ok'] === false && $phpPng['url'] === null, 'a PHP file is refused', json_encode($phpPng));
    $big = liveStoreImage($fileFor($tmp('big.png', $png), 'big.png', UPLOAD_ERR_OK, UPLOAD_MAX_MB * 1024 * 1024 + 1), 'banner');
    ok($big['ok'] === false && $big['url'] === null && preg_match('/MB|large|exceed/i', (string) $big['error']) === 1, 'an oversize blob is refused with a size message', json_encode($big));
    $partial = liveStoreImage($fileFor($tmp('partial.png', $png), 'p.png', UPLOAD_ERR_PARTIAL), 'thumbnail');
    ok($partial['ok'] === false && $partial['url'] === null && $partial['error'] !== null && $partial['error'] !== '', 'an interrupted upload is refused with a message', json_encode($partial));
    $iniSize = liveStoreImage($fileFor($tmp('ini.png', $png), 'p.png', UPLOAD_ERR_INI_SIZE), 'thumbnail');
    ok($iniSize['ok'] === false && $iniSize['error'] !== '', 'a file over the server limit is refused with a message', json_encode($iniSize));
    ok(threw(fn() => liveStoreImage([], 'thumbnail')) === null && liveStoreImage([], 'thumbnail')['ok'] === false, 'an empty $_FILES entry never throws');
    ok(threw(fn() => liveStoreImage(['tmp_name' => '/does/not/exist', 'error' => UPLOAD_ERR_OK, 'size' => 10, 'name' => 'x.png'], 'thumbnail')) === null, 'a missing temp file never throws');
    $real = liveStoreImage($fileFor($tmp('real.png', $png), 'real.png'), 'thumbnail');
    ok(stripos((string) ($real['error'] ?? ''), 'JPEG') === false, 'a real 1×1 PNG passes the image sniff', json_encode($real));
    if ($real['ok'] === true) {
        ok(preg_match('#^/uploads/live-[0-9a-f]{24}\.png$#', (string) $real['url']) === 1, 'it is stored as /uploads/live-<24 hex>.png', (string) $real['url']);
        $stored = $uploadDir . DIRECTORY_SEPARATOR . basename((string) $real['url']);
        ok(is_file($stored) && file_get_contents($stored) === $png, 'the bytes are on disk under backend/uploads');
        liveDeleteUpload((string) $real['url']);
        ok(!is_file($stored), 'liveDeleteUpload removes it');
    } else {
        // move_uploaded_file() only accepts files PHP itself received in a request;
        // the page suite (admin-live.mjs) proves the stored path over HTTP.
        ok(preg_match('/move|upload/i', (string) $real['error']) === 1, 'outside a request only move_uploaded_file() stands in the way (the page suite covers the real upload)', json_encode($real));
    }
    $keep = $uploadDir . DIRECTORY_SEPARATOR . bin2hex(random_bytes(12)) . '.png';
    file_put_contents($keep, $png);
    $tmpFiles[] = $keep;
    liveDeleteUpload('/uploads/' . basename($keep));
    ok(is_file($keep), 'liveDeleteUpload leaves a gallery upload (no live- prefix) alone');
    $liveFile = $uploadDir . DIRECTORY_SEPARATOR . 'live-' . bin2hex(random_bytes(12)) . '.png';
    file_put_contents($liveFile, $png);
    $tmpFiles[] = $liveFile;
    liveDeleteUpload('https://evil.example/uploads/' . basename($liveFile));
    ok(is_file($liveFile), 'an absolute URL deletes nothing');
    liveDeleteUpload('/uploads/live-../../includes/db.php');
    ok(is_file(__DIR__ . '/../backend/includes/db.php'), 'a traversal deletes nothing');
    ok(threw(fn() => liveDeleteUpload('')) === null && threw(fn() => liveDeleteUpload('/uploads/live-does-not-exist.png')) === null, 'an empty or unknown path never throws');
    liveDeleteUpload('/uploads/' . basename($liveFile));
    ok(!is_file($liveFile), 'a /uploads/live-… file is removed');

    /* ── 10. Admin helpers ───────────────────────────────────────────────── */
    section('10. Admin helpers (§4.1 admin.php)');
    foreach (['DRAFT' => 'muted', 'SCHEDULED' => 'info', 'STARTING' => 'warning', 'LIVE' => 'danger', 'COMPLETED' => 'muted', 'CANCELLED' => 'muted', 'OFFLINE' => 'warning', 'ERROR' => 'danger'] as $status => $tone) {
        eq(liveStatusTone($status), $tone, "liveStatusTone({$status}) is {$tone}");
        ok(is_string(liveStatusLabel($status)) && liveStatusLabel($status) !== '', "liveStatusLabel({$status}) is a label", liveStatusLabel($status));
    }
    ok(threw(fn() => liveStatusTone('NONSENSE')) === null && threw(fn() => liveStatusLabel('"><script>')) === null, 'an unknown status never throws');
    $f = liveAdminFilters(['f' => '"><script>', 'q' => str_repeat('x', 200), 'sort' => 'DROP TABLE', 'dir' => 'sideways', 'page' => '-5']);
    eq($f['f'] ?? null, 'all', 'an unknown filter becomes all');
    ok(mb_strlen((string) ($f['q'] ?? '')) <= 100, 'q is cut to 100 characters');
    ok(in_array($f['sort'] ?? null, ['schedule', 'title', 'status', 'updated'], true), 'an unknown sort becomes a known one', (string) ($f['sort'] ?? null));
    ok(in_array($f['dir'] ?? null, ['asc', 'desc'], true), 'an unknown direction becomes asc or desc', (string) ($f['dir'] ?? null));
    ok((int) ($f['page'] ?? 0) >= 1, 'a negative page becomes 1');
    foreach (['all', 'draft', 'scheduled', 'live', 'completed', 'cancelled', 'deleted'] as $chip) eq(liveAdminFilters(['f' => $chip])['f'] ?? null, $chip, "filter {$chip} is accepted");
    foreach (['schedule', 'title', 'status', 'updated'] as $s) eq(liveAdminFilters(['sort' => $s])['sort'] ?? null, $s, "sort {$s} is accepted");
    ok(threw(fn() => liveAdminFilters(['f' => ['x'], 'q' => ['y'], 'sort' => ['z'], 'dir' => ['w'], 'page' => ['v']])) === null, 'array parameters never throw');
    $labelsOf = static function (array $actions): array {
        $labels = [];
        foreach ($actions as $k => $v) $labels[] = is_array($v) ? (string) ($v['label'] ?? $v[1] ?? '') : (string) $v;
        return $labels;
    };
    $targetsOf = static function (array $actions): array {
        $targets = [];
        foreach ($actions as $k => $v) $targets[] = is_array($v) ? (string) ($v['to'] ?? $v['status'] ?? $v[0] ?? $k) : (string) $k;
        return $targets;
    };
    // The contract's nine labels, plus one for OFFLINE → ERROR, a transition §2 allows but §4.1 names no button for.
    $knownLabels = ['Publish', 'Starting soon', 'Go live', 'End stream', 'Mark offline', 'Back live', 'Cancel', 'Reschedule', 'Restore to draft', 'Mark error'];
    foreach (LIVE_STATUSES as $status) {
        $actions = liveAdminActions(array_replace($row($idA), ['status' => $status]));
        $targets = $targetsOf($actions);
        sort($targets);
        $expected = $expectedTransitions[$status];
        sort($expected);
        eq($targets, $expected, "liveAdminActions({$status}) offers exactly the legal transitions");
        ok(!array_diff($labelsOf($actions), $knownLabels), "…with the documented button labels", implode(',', $labelsOf($actions)));
    }
    ok(in_array('Go live', $labelsOf(liveAdminActions(array_replace($row($idA), ['status' => 'SCHEDULED']))), true), 'SCHEDULED offers "Go live"');
    ok(in_array('Publish', $labelsOf(liveAdminActions(array_replace($row($idA), ['status' => 'DRAFT']))), true), 'DRAFT offers "Publish"');
    ok(in_array('End stream', $labelsOf(liveAdminActions(array_replace($row($idA), ['status' => 'LIVE']))), true), 'LIVE offers "End stream"');
    ok(in_array('Back live', $labelsOf(liveAdminActions(array_replace($row($idA), ['status' => 'OFFLINE']))), true), 'OFFLINE offers "Back live"');
    eq(liveAdminActions(array_replace($row($idA), ['status' => 'COMPLETED'])), [], 'COMPLETED offers nothing');

    /* ── 11. Phase 2 (docs/live/SPEC-PHASE2.md) ──────────────────────────── */
    section('11a. Schedule windows in Asia/Kolkata (SPEC-PHASE2 §1.2, time.php)');
    $IST_TZ = 'Asia/Kolkata';
    eq(liveDayRangeUtc('2026-09-15', $IST_TZ), ['from' => '2026-09-14 18:30:00', 'to' => '2026-09-15 18:30:00'], 'a day is local midnight to the next local midnight, in UTC (to exclusive)');
    eq(liveDayRangeUtc('2026-09-30', $IST_TZ)['to'] ?? null, '2026-09-30 18:30:00', 'the month end rolls into October');
    eq(liveDayRangeUtc('2026-12-31', $IST_TZ), ['from' => '2026-12-30 18:30:00', 'to' => '2026-12-31 18:30:00'], 'the year end');
    eq(liveDayRangeUtc('2028-02-29', $IST_TZ)['to'] ?? null, '2028-02-29 18:30:00', 'a leap day');
    eq(liveDayRangeUtc('2026-09-15', 'America/New_York'), ['from' => '2026-09-15 04:00:00', 'to' => '2026-09-16 04:00:00'], 'New York in September (EDT)');
    foreach (['2026-02-30', '9999-99-99', 'tomorrow', '', '<script>'] as $bad) eq(liveDayRangeUtc($bad, $IST_TZ), null, 'liveDayRangeUtc refuses ' . json_encode($bad));
    eq(liveDayRangeUtc('2026-09-15', 'Not/AZone'), null, 'and an unknown zone');
    $day = liveDayRangeUtc('2026-09-15', $IST_TZ);
    $lastSecond = liveToUtc('2026-09-15 23:59:59', $IST_TZ);
    $nextMidnight = liveToUtc('2026-09-16 00:00', $IST_TZ);
    ok($lastSecond >= $day['from'] && $lastSecond < $day['to'] && $nextMidnight >= $day['to'], '23:59:59 IST is inside the day and 00:00 the next day is outside');
    eq(liveWeekRangeUtc('2026-09-15', $IST_TZ), ['from' => '2026-09-14 18:30:00', 'to' => '2026-09-20 18:30:00', 'sunday' => '2026-09-20'], 'the week of Tuesday 15 Sep 2026 runs through Sunday 20 Sep inclusive');
    eq(liveWeekRangeUtc('2026-09-14', $IST_TZ)['sunday'] ?? null, '2026-09-20', 'a Monday runs seven days');
    eq(liveWeekRangeUtc('2026-09-20', $IST_TZ), ['from' => '2026-09-19 18:30:00', 'to' => '2026-09-20 18:30:00', 'sunday' => '2026-09-20'], 'a Sunday is a week of one day');
    eq(liveWeekRangeUtc('2026-09-29', $IST_TZ)['sunday'] ?? null, '2026-10-04', 'a week crosses the month end');
    eq(liveWeekRangeUtc('2026-12-30', $IST_TZ), ['from' => '2026-12-29 18:30:00', 'to' => '2027-01-03 18:30:00', 'sunday' => '2027-01-03'], 'a week crosses the year end');
    eq(liveWeekRangeUtc('2026-02-30', $IST_TZ), null, 'liveWeekRangeUtc refuses a bad date');
    $todayIst = liveTodayLocal($IST_TZ);
    ok(preg_match('/^\d{4}-\d{2}-\d{2}$/', $todayIst) === 1 && $todayIst === liveFromUtc(liveUtcNow(), $IST_TZ, 'Y-m-d'), 'liveTodayLocal is today on the IST wall clock', $todayIst);
    eq(liveShiftDateLocal('2026-12-31', 1, $IST_TZ), '2027-01-01', 'liveShiftDateLocal rolls the year');
    eq(liveShiftDateLocal('2026-03-01', -1, $IST_TZ), '2026-02-28', '…and back');
    eq(liveShiftDateLocal('2026-02-30', 1, $IST_TZ), null, '…and refuses a bad date');
    eq(array_keys(LIVE_SCHEDULE_FILTERS), ['today', 'tomorrow', 'week', 'festivals', 'all'], 'the five filters, in the page order');
    ok(array_reduce(LIVE_SCHEDULE_FILTERS, static fn(bool $c, $v): bool => $c && preg_match('/\p{Tamil}/u', (string) $v[0]) === 1 && $v[1] !== '', true), 'every filter carries a Tamil and an English label');
    eq(LIVE_FESTIVAL_TYPES, ['festival', 'procession', 'special_event'], 'the festival types');
    $tomorrowIst  = (string) liveShiftDateLocal($todayIst, 1, $IST_TZ);
    $yesterdayIst = (string) liveShiftDateLocal($todayIst, -1, $IST_TZ);
    $sundayIst    = (string) liveWeekRangeUtc($todayIst, $IST_TZ)['sunday'];
    $w = liveScheduleWindow('today', $IST_TZ);
    eq([$w['filter'], $w['from'], $w['to'], $w['today'], $w['tomorrow']], ['today', liveDayRangeUtc($todayIst, $IST_TZ)['from'], liveDayRangeUtc($todayIst, $IST_TZ)['to'], $todayIst, $tomorrowIst], "liveScheduleWindow('today') is today's day range");
    eq(liveScheduleWindow('tomorrow', $IST_TZ)['from'], liveDayRangeUtc($tomorrowIst, $IST_TZ)['from'], "'tomorrow' starts at tomorrow's midnight");
    eq(liveScheduleWindow('week', $IST_TZ)['to'], liveWeekRangeUtc($todayIst, $IST_TZ)['to'], "'week' ends with the coming Sunday");
    eq(liveScheduleWindow('all', $IST_TZ)['to'], liveDayRangeUtc((string) liveShiftDateLocal($todayIst, 90, $IST_TZ), $IST_TZ)['to'], "'all' reaches 90 days ahead");
    eq(liveScheduleWindow('bogus', $IST_TZ)['filter'], 'all', 'an unknown filter is all');
    eq(liveScheduleWindow('TODAY', $IST_TZ)['filter'], 'today', 'a filter name is case-folded');
    ok(liveScheduleWindow('tomorrow', $IST_TZ)['live'] === false && liveScheduleWindow('today', $IST_TZ)['live'] === true && liveScheduleWindow('all', $IST_TZ)['undated'] === true && liveScheduleWindow('week', $IST_TZ)['undated'] === false, 'live rows belong to today (not tomorrow); undated rows to all only');
    eq([liveScheduleWindow('week', $IST_TZ)['label_ta'], liveScheduleWindow('week', $IST_TZ)['label_en']], LIVE_SCHEDULE_FILTERS['week'], 'the window carries the filter labels');

    section('11b. day_bucket and starts_in_seconds (SPEC-PHASE2 §1.1)');
    $bucketOf = static fn(string $local, string $status = 'SCHEDULED'): string => liveDayBucket(['status' => $status, 'scheduled_start_at' => liveToUtc($local, 'Asia/Kolkata')], 'Asia/Kolkata');
    eq($bucketOf("{$todayIst} 23:59"), 'today', '23:59 IST today is today');
    eq($bucketOf("{$todayIst} 00:00"), 'today', '00:00 IST today is today');
    eq($bucketOf("{$tomorrowIst} 00:00"), 'tomorrow', '00:00 IST tomorrow is tomorrow');
    eq($bucketOf("{$tomorrowIst} 23:59"), 'tomorrow', '23:59 IST tomorrow is tomorrow');
    eq($bucketOf("{$yesterdayIst} 23:59"), 'past', '23:59 IST yesterday is past');
    eq($bucketOf(liveShiftDateLocal($todayIst, 2, $IST_TZ) . ' 06:00'), 'later', 'the day after tomorrow is later');
    eq($bucketOf("{$yesterdayIst} 18:00", 'LIVE'), 'today', 'a LIVE row scheduled yesterday is happening today');
    eq($bucketOf("{$tomorrowIst} 18:00", 'STARTING'), 'today', 'so is a STARTING one');
    eq($bucketOf("{$todayIst} 06:00", 'COMPLETED'), 'today', 'a COMPLETED row keeps its day');
    eq(liveDayBucket(['status' => 'SCHEDULED', 'scheduled_start_at' => null], $IST_TZ), 'later', 'no start → later');
    $in90 = ['status' => 'SCHEDULED', 'scheduled_start_at' => gmdate('Y-m-d H:i:s', time() + 90)];
    ok(abs((liveStartsInSeconds($in90) ?? 0) - 90) <= 1, 'starts_in_seconds is 90 for a start 90 s ahead', json_encode(liveStartsInSeconds($in90)));
    ok((liveStartsInSeconds(['status' => 'COMPLETED', 'scheduled_start_at' => gmdate('Y-m-d H:i:s', time() - 600)]) ?? 0) <= -598, 'negative once the start has passed');
    eq(liveStartsInSeconds(['status' => 'LIVE', 'scheduled_start_at' => gmdate('Y-m-d H:i:s')]), null, 'null for a LIVE row');
    eq(liveStartsInSeconds(['status' => 'STARTING', 'scheduled_start_at' => gmdate('Y-m-d H:i:s')]), null, 'null for a STARTING row');
    eq(liveStartsInSeconds(['status' => 'SCHEDULED', 'scheduled_start_at' => null]), null, 'null without a start');
    $shapeA = liveShapeSchedule($row($idA), $IST_TZ);
    $extraKeys = array_values(array_diff(array_keys($shapeA), $publicKeys));
    sort($extraKeys);
    eq($extraKeys, ['day_bucket', 'starts_in_seconds'], 'liveShapeSchedule is the public shape plus exactly day_bucket and starts_in_seconds');
    eq($shapeA['day_bucket'], 'tomorrow', "…the tomorrow fixture's bucket is tomorrow");
    ok(is_int($shapeA['starts_in_seconds']) && $shapeA['starts_in_seconds'] > 0, '…and it starts in a positive number of seconds', json_encode($shapeA['starts_in_seconds']));
    ok(threw(fn() => liveShapeSchedule(array_replace($row($idA), ['scheduled_start_at' => '"><script>', 'status' => 'nonsense']), 'Not/AZone')) === null, 'a hostile row never throws');

    section('11c. liveListSchedule: membership, order, counts (SPEC-PHASE2 §1.2, store.php)');
    $S = [];
    $S['today']          = $makeStream('P2 today late', ['scheduled_date' => $todayIst, 'start_time' => '23:59', 'end_time' => '']);
    $S['todayDone']      = $makeStream('P2 today done', ['scheduled_date' => $todayIst, 'start_time' => '05:00', 'end_time' => '06:00'], 'COMPLETED');
    $S['tomorrow0']      = $makeStream('P2 tomorrow midnight', ['scheduled_date' => $tomorrowIst, 'start_time' => '00:00', 'end_time' => '']);
    $S['sunday']         = $makeStream('P2 sunday', ['scheduled_date' => $sundayIst, 'start_time' => '10:00', 'end_time' => '']);
    $S['nextWeek']       = $makeStream('P2 next week', ['scheduled_date' => (string) liveShiftDateLocal($todayIst, 8, $IST_TZ), 'start_time' => '09:00', 'end_time' => '']);
    $S['far']            = $makeStream('P2 far', ['scheduled_date' => (string) liveShiftDateLocal($todayIst, 100, $IST_TZ), 'start_time' => '09:00', 'end_time' => '']);
    $S['festival']       = $makeStream('P2 festival', ['scheduled_date' => $tomorrowIst, 'start_time' => '10:00', 'end_time' => '', 'event_type' => 'festival']);
    $S['procession']     = $makeStream('P2 procession', ['scheduled_date' => $todayIst, 'start_time' => '17:00', 'end_time' => '', 'event_type' => 'procession']);
    $S['yesterday']      = $makeStream('P2 yesterday', ['scheduled_date' => $yesterdayIst, 'start_time' => '18:00', 'end_time' => '']);
    $S['draft']          = $makeStream('P2 draft', ['scheduled_date' => $todayIst, 'start_time' => '12:00', 'end_time' => ''], 'DRAFT');
    $S['deleted']        = $makeStream('P2 deleted', ['scheduled_date' => $todayIst, 'start_time' => '13:00', 'end_time' => '']);
    liveSoftDelete($db, $S['deleted'], $ACTOR);
    $S['undated']        = $makeStream('P2 undated', []);
    $db->prepare('UPDATE live_streams SET scheduled_start_at = NULL, scheduled_end_at = NULL WHERE id = :id')->execute([':id' => $S['undated']]);
    $S['cancelledToday'] = $makeStream('P2 cancelled today', ['scheduled_date' => $todayIst, 'start_time' => '20:00', 'end_time' => ''], 'CANCELLED');
    $listed = static function (string $filter, int $limit = 100) use ($db, &$made, $IST_TZ): array {
        $r = liveListSchedule($db, $filter, $limit, $IST_TZ);
        $mineNow = array_values($made);
        $all = array_map(static fn(array $x): int => (int) $x['id'], $r['rows']);
        return ['ids' => array_values(array_filter($all, static fn(int $id): bool => in_array($id, $mineNow, true))), 'all' => $all, 'rows' => $r['rows'], 'window' => $r['window'], 'counts' => $r['counts']];
    };
    $has = static fn(array $list, int $id): bool => in_array($id, $list, true);
    $liveNow = array_values(array_filter(array_map(static fn(array $x): int => (int) $x['id'], liveListLive($db)), static fn(int $id): bool => in_array($id, array_values($made), true)));
    ok(count($liveNow) >= 2 && $has($liveNow, $idLive) && $has($liveNow, $idStarting), 'the LIVE and STARTING fixtures are on air for these checks', json_encode($liveNow));

    $today = $listed('today');
    ok($has($today['ids'], $S['today']) && $has($today['ids'], $S['todayDone']) && $has($today['ids'], $S['procession']) && $has($today['ids'], $S['cancelledToday']), 'today lists the 23:59 stream, the completed one, the procession and the cancelled one', json_encode($today['ids']));
    ok($has($today['ids'], $idLive) && $has($today['ids'], $idStarting), 'today lists the LIVE and STARTING rows (they are on now)', json_encode($today['ids']));
    ok(!$has($today['ids'], $S['tomorrow0']) && !$has($today['ids'], $S['yesterday']) && !$has($today['ids'], $S['draft']) && !$has($today['ids'], $S['deleted']) && !$has($today['ids'], $S['undated']) && !$has($today['ids'], $S['nextWeek']), 'today excludes tomorrow 00:00, yesterday, the draft, the deleted, the undated and next week', json_encode($today['ids']));
    eq(array_slice($today['ids'], 0, count($liveNow)), $liveNow, "the live rows lead, in the live list's own order (LIVE most recently started, then STARTING)");
    $todayRest = array_values(array_filter($today['ids'], static fn(int $id): bool => !in_array($id, $liveNow, true)));
    ok(end($todayRest) === $S['todayDone'], "the COMPLETED row is last among today's", json_encode($todayRest));
    $todayStarts = array_values(array_map(static fn(array $r): string => (string) $r['scheduled_start_at'], array_filter($today['rows'], static fn(array $r): bool => !in_array((string) $r['status'], LIVE_LIVE_STATUSES, true) && (string) $r['status'] !== 'COMPLETED')));
    $sortedStarts = $todayStarts;
    sort($sortedStarts);
    eq($todayStarts, $sortedStarts, "the rest of today is in start order");
    ok(array_reduce($today['rows'], static fn(bool $c, array $r): bool => $c && in_array((string) $r['status'], LIVE_PUBLIC_STATUSES, true) && $r['deleted_at'] === null, true), 'every row listed is public and not deleted');

    $tomorrow = $listed('tomorrow');
    ok($has($tomorrow['ids'], $S['tomorrow0']) && $has($tomorrow['ids'], $S['festival']) && $has($tomorrow['ids'], $idA), 'tomorrow lists 00:00 tomorrow, the festival and the tomorrow fixture', json_encode($tomorrow['ids']));
    ok(!$has($tomorrow['ids'], $S['today']) && !$has($tomorrow['ids'], $idLive) && !$has($tomorrow['ids'], $idStarting) && !$has($tomorrow['ids'], $S['nextWeek']) && !$has($tomorrow['ids'], $S['undated']), 'tomorrow excludes today, the live rows, next week and the undated row', json_encode($tomorrow['ids']));
    $firstDone = null;
    foreach ($tomorrow['rows'] as $i => $r) if ((string) $r['status'] === 'COMPLETED') { $firstDone = $i; break; }
    ok($firstDone === null || array_reduce(array_slice($tomorrow['rows'], $firstDone), static fn(bool $c, array $r): bool => $c && (string) $r['status'] === 'COMPLETED', true), 'on tomorrow every COMPLETED row comes after the others', json_encode(array_map(static fn($r) => $r['status'], $tomorrow['rows'])));

    $week = $listed('week');
    ok($has($week['ids'], $S['today']) && $has($week['ids'], $S['sunday']) && $has($week['ids'], $idLive), 'week lists today, the coming Sunday and the live rows', json_encode($week['ids']));
    ok($tomorrowIst > $sundayIst || $has($week['ids'], $S['tomorrow0']), 'week lists tomorrow unless today is Sunday', json_encode([$tomorrowIst, $sundayIst]));
    ok(!$has($week['ids'], $S['nextWeek']) && !$has($week['ids'], $S['far']) && !$has($week['ids'], $S['yesterday']) && !$has($week['ids'], $S['undated']), 'week excludes next Monday onward, far, past and undated rows', json_encode($week['ids']));
    eq($week['window']['to'], liveWeekRangeUtc($todayIst, $IST_TZ)['to'], "the week window ends after the coming Sunday");

    $fest = $listed('festivals');
    ok($has($fest['ids'], $S['festival']) && $has($fest['ids'], $S['procession']), 'festivals lists the festival and the procession', json_encode($fest['ids']));
    ok(!$has($fest['ids'], $S['today']) && !$has($fest['ids'], $idLive) && !$has($fest['ids'], $idA) && !$has($fest['ids'], $S['far']), 'festivals excludes the other programme types (a live one included) and anything beyond 90 days', json_encode($fest['ids']));

    $all = $listed('all');
    foreach (['today', 'todayDone', 'tomorrow0', 'sunday', 'nextWeek', 'festival', 'procession', 'undated', 'cancelledToday'] as $k) ok($has($all['ids'], $S[$k]), "all lists {$k}", json_encode($all['ids']));
    ok($has($all['ids'], $idLive) && $has($all['ids'], $idStarting), 'all lists the live rows');
    foreach (['far', 'yesterday', 'draft', 'deleted'] as $k) ok(!$has($all['ids'], $S[$k]), "all excludes {$k}", json_encode($all['ids']));
    $tail = array_slice($all['all'], -2);
    ok(in_array($S['undated'], $tail, true) && in_array($idNoStart, $tail, true), 'the undated rows are last on all', json_encode(array_slice($all['all'], -4)));
    eq(array_slice($all['ids'], 0, count($liveNow)), $liveNow, 'all leads with the live rows');
    $counts = $all['counts'];
    eq(array_keys($counts), ['today', 'tomorrow', 'week', 'festivals', 'all'], 'counts carries the five filters');
    foreach (['today' => $today, 'tomorrow' => $tomorrow, 'week' => $week, 'festivals' => $fest, 'all' => $all] as $k => $r) {
        eq($counts[$k], count($r['all']), "counts.{$k} equals the number of rows the filter lists (under the 100 cap)");
    }
    ok($counts['today'] <= $counts['week'] && $counts['week'] <= $counts['all'] && $counts['tomorrow'] <= $counts['all'] && $counts['festivals'] <= $counts['all'], 'today ⊆ week ⊆ all; tomorrow, festivals ⊆ all', json_encode($counts));
    eq(count(liveListSchedule($db, 'all', 1, $IST_TZ)['rows']), 1, 'limit 1 gives one row');
    ok(count(liveListSchedule($db, 'all', 1000, $IST_TZ)['rows']) <= 100, 'the limit is capped at 100');
    eq(liveListSchedule($db, 'bogus', 10, $IST_TZ)['window']['filter'], 'all', 'an unknown filter lists all');
    ok(preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', (string) $all['window']['from']) === 1 && $all['window']['label_en'] === 'All' && preg_match('/\p{Tamil}/u', (string) $all['window']['label_ta']) === 1 && $all['window']['today'] === $todayIst, 'the window carries UTC bounds, today and both labels', json_encode($all['window']));
    ok(threw(fn() => liveListSchedule($db, '"><script>', -5, 'Not/AZone')) === null, 'hostile arguments never throw');
    $shaped = array_map(static fn(array $r): array => liveShapeSchedule($r, $IST_TZ, $all['window']['today']), $all['rows']);
    ok(array_reduce($shaped, static fn(bool $c, array $s): bool => $c && in_array($s['day_bucket'], ['today', 'tomorrow', 'later', 'past'], true), true), 'every schedule item has a known day_bucket');
    $shapedById = [];
    foreach ($shaped as $s) $shapedById[(int) $s['id']] = $s;
    eq([$shapedById[$S['today']]['day_bucket'] ?? null, $shapedById[$S['tomorrow0']]['day_bucket'] ?? null, $shapedById[$S['nextWeek']]['day_bucket'] ?? null, $shapedById[$idLive]['day_bucket'] ?? null, $shapedById[$S['undated']]['day_bucket'] ?? null], ['today', 'tomorrow', 'later', 'today', 'later'], 'buckets: today, tomorrow, later, today (live), later (undated)');
    ok(array_key_exists('starts_in_seconds', $shapedById[$idLive] ?? []) && $shapedById[$idLive]['starts_in_seconds'] === null && is_int($shapedById[$S['nextWeek']]['starts_in_seconds'] ?? null) && ($shapedById[$S['todayDone']]['starts_in_seconds'] ?? 0) < 0, 'starts_in_seconds: null live, positive ahead, negative for the completed one', json_encode([$shapedById[$idLive]['starts_in_seconds'] ?? 'missing', $shapedById[$S['nextWeek']]['starts_in_seconds'] ?? 'missing', $shapedById[$S['todayDone']]['starts_in_seconds'] ?? 'missing']));

    section('11d. Vimeo and AWS IVS placeholders (SPEC-PHASE2 §1.2, providers.php)');
    $vimeo = liveProviderFor('vimeo');
    ok($vimeo instanceof VimeoProvider && $vimeo->name() === 'vimeo' && !$vimeo->isConfigured(), 'vimeo is the VimeoProvider, not configured');
    foreach (['123456789' => '123456789', 'https://vimeo.com/123456789' => '123456789', 'vimeo.com/event/4567890' => '4567890', 'https://player.vimeo.com/video/98765432?h=abc' => '98765432', 'https://vimeo.com/channels/staffpicks/12345678' => '12345678', '  55555555  ' => '55555555', 'HTTPS://WWW.VIMEO.COM/123456789' => '123456789'] as $in => $want) {
        eq($vimeo->parseReference($in), $want, 'vimeo parses ' . json_encode($in));
    }
    foreach (['', '   ', 'abc', '1234', 'https://youtu.be/dQw4w9WgXcQ', 'https://vimeo.com/about', 'https://evil.example/vimeo.com/123456789', 'javascript:alert(1)', '"><script>alert(1)</script>', str_repeat('1', 13), str_repeat('a', 600)] as $in) {
        eq($vimeo->parseReference($in), null, 'vimeo refuses ' . json_encode(mb_substr($in, 0, 40)));
    }
    eq($vimeo->playback(['provider' => 'vimeo', 'provider_broadcast_id' => '123456789', 'playback_url' => 'https://vimeo.com/123456789']), ['kind' => 'none', 'embedUrl' => null, 'watchUrl' => null], 'vimeo plays nothing yet');
    eq($vimeo->fetchStatus([])['ok'] ?? null, false, 'vimeo fetchStatus is not configured');
    eq($vimeo->thumbnailUrl(['thumbnail_url' => '/uploads/live-abc.png']), '/uploads/live-abc.png', "vimeo keeps the admin's thumbnail");
    ok($vimeo->label() === 'Vimeo' && $vimeo->label('ta') === 'Vimeo', 'the Vimeo label reads the same in both languages');
    $ivs = liveProviderFor('aws_ivs');
    ok($ivs instanceof AwsIvsProvider && $ivs->name() === 'aws_ivs' && !$ivs->isConfigured(), 'aws_ivs is the AwsIvsProvider, not configured');
    $arn = 'arn:aws:ivs:ap-south-1:123456789012:channel/AbCdEf123456';
    $hls = 'https://abc.ap-south-1.playback.live-video.net/api/video/v1/x.m3u8';
    eq($ivs->parseReference($arn), $arn, 'IVS accepts a channel ARN');
    eq($ivs->parseReference("  {$hls}  "), $hls, 'IVS accepts an https .m3u8 address');
    eq($ivs->parseReference($hls . '?token=abc'), $hls . '?token=abc', '…with a query');
    foreach (['', 'arn:aws:s3:::bucket', 'arn:aws:ivs:ap-south-1:12:channel/x', 'http://x.example/live.m3u8', 'https://x.example/live.mp4', 'https://user:pw@x.example/live.m3u8', 'javascript:alert(1)', '"><script>alert(1)</script>', 'https://' . str_repeat('a', 100) . '.example/live.m3u8'] as $in) {
        eq($ivs->parseReference($in), null, 'IVS refuses ' . json_encode(mb_substr($in, 0, 40)));
    }
    eq($ivs->playback(['provider' => 'aws_ivs', 'provider_broadcast_id' => $arn])['kind'] ?? null, 'none', 'IVS plays nothing yet');
    eq($ivs->fetchStatus([])['ok'] ?? null, false, 'IVS fetchStatus is not configured');
    ok($ivs->label() === 'AWS IVS' && $ivs->label('ta') === 'AWS IVS', 'the AWS IVS label reads the same in both languages');
    eq(array_keys(liveProviderRegistry()), ['youtube', 'vimeo', 'aws_ivs', 'custom'], 'the registry order is youtube, vimeo, aws_ivs, custom');
    ok(liveProviderFor('custom') instanceof UnavailableProvider && liveProviderFor('nope') instanceof UnavailableProvider, 'custom and unknown keys stay UnavailableProvider');
    $field('provider vimeo is still not selectable', ['provider' => 'vimeo', 'provider_reference' => '123456789'], 'provider', null, 'not available yet');
    $field('provider aws_ivs is still not selectable', ['provider' => 'aws_ivs', 'provider_reference' => $arn], 'provider', null, 'not available yet');
    eq(liveUniqueSlug($db, 'schedule', null), 'schedule-2', 'the reserved slug "schedule" is skipped by liveUniqueSlug');
    eq(liveSlugify('Schedule'), 'schedule', '…while liveSlugify alone still yields it (the caller makes it unique)');
} catch (Throwable $e) {
    ok(false, 'the suite ran to the end', get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
} finally {
    section('Cleanup');
    try {
        if ($db->inTransaction()) $db->rollBack();
        foreach ($tmpFiles as $f) if (is_file($f)) @unlink($f);
        $removed = unitCleanup($db, "{$PREFIX}-%", 'e2e-unit-%');
        echo '  removed ' . json_encode($removed) . "\n";
        $left = (int) $db->query("SELECT (SELECT COUNT(*) FROM live_streams WHERE title_en LIKE '{$PREFIX}-%') + (SELECT COUNT(*) FROM temples WHERE slug LIKE 'e2e-unit-%')")->fetchColumn();
        ok($left === 0, 'cleanup removed every row this run created', "{$left} left");
        $stray = glob(realpath(__DIR__ . '/../backend/uploads') . DIRECTORY_SEPARATOR . 'live-*') ?: [];
        if ($stray) echo '  note: ' . count($stray) . " live-* file(s) remain in backend/uploads (not created by this run's checks unless a check above failed)\n";
    } catch (Throwable $e) {
        ok(false, 'cleanup ran', $e->getMessage());
    }
}

echo "\n{$passed} passed, " . count($failures) . " failed\n";
if ($failures) {
    echo "\nFailures:\n";
    foreach ($failures as $f) echo "  - {$f}\n";
}
exit($failures ? 1 : 0);
