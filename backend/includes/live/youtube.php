<?php
/**
 * backend/includes/live/youtube.php — the YouTube Data API v3 client
 * (docs/live/SPEC-PHASE3.md §4.2, §6.1, §10.2).
 *
 * The only file in the module that speaks HTTP to Google. It asks about the
 * video ids the committee already pasted and nothing else: videos.list (1
 * unit) and, at Tier 2, liveBroadcasts.list (1 unit). It never discovers,
 * creates, changes or deletes a broadcast, and the channel-wide search
 * endpoint is never called — it has its own bucket of 100 calls a day, which
 * cannot support a poller (§0.2 #1).
 *
 * Every call goes through notifyHttp() (notify/contracts.php), which never
 * throws. The API key travels only as key=… in the query (the Data API
 * requires it there) and never in a header; no URL, query or response body is
 * ever logged, and every text that is logged or stored passes liveRedact().
 *
 * Tier 0 makes no call. Tier 1 is one API key. Tier 2 adds the OAuth trio and
 * owner-only broadcast detail, and a Tier 2 failure never stops Tier 1: a run
 * that cannot get a bearer, or whose bearer the API refuses, finishes on the
 * API key when one is configured (§4.2). There is no retry loop and no sleep:
 * the one forced token refresh and the one key= resend are the only repeats.
 *
 * mode = simulator (behind LIVE_ALLOW_SIMULATOR, §10.1) answers every call in
 * process through liveYoutubeSimulate(), the PHP twin of
 * tests/support/youtube_mock.mjs.
 */

/** Ids per videos.list call — a prudent self-imposed ceiling, not a documented limit. */
const LIVE_YT_BATCH_MAX = 50;

/** Calls of each kind per run (the poller's chunk limit). */
const LIVE_YT_MAX_CALLS = 4;

/** Seconds, passed to notifyHttp(). */
const LIVE_YT_TIMEOUT = 12;

/** The only OAuth scope ever used, and a hard ceiling. */
const LIVE_YT_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const LIVE_YT_API_BASE  = 'https://www.googleapis.com/youtube/v3';
const LIVE_YT_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Three parts cost the same 1 unit as one. */
const LIVE_YT_VIDEO_PART = 'snippet,status,liveStreamingDetails';

/** Tier 2. `statistics` is not a part liveBroadcasts.list accepts, so OAuth never removes the need for videos.list. */
const LIVE_YT_BCAST_PART = 'id,status,contentDetails';

/**
 * The committee sentences every call-level provider_notice, every call-level
 * sync_error and the connection test's flash are drawn from (§8.3). Never the
 * provider's own text. liveProviderConnectionMessage() maps a machine answer
 * onto them; liveYoutubeFetchMany() puts the matching one in its `notice`.
 */
const LIVE_PROVIDER_MESSAGES = [
    'connected'             => 'Connected — YouTube answered.',
    'no_key'                => 'No YouTube API key is set.',
    'unreachable'           => 'Could not reach YouTube. Try again in a moment.',
    'rate_limited'          => 'YouTube is limiting requests; the job will slow down and retry.',
    'key_refused'           => 'YouTube refused this key (it may be mistyped, expired, restricted to other addresses, or the YouTube Data API v3 is not enabled on the project).',
    'invalid_grant'         => 'The refresh token is no longer valid; reconnect the channel.',
    'invalid_client'        => 'Google no longer accepts the saved OAuth client (its secret was rotated or the client was deleted); save the current client id and secret.',
    'token_failed'          => 'Google sign-in failed; using the API key for now.',
    'bearer_refused'        => 'YouTube refused the Google sign-in for this project; using the API key for now.',
    'bearer_refused_no_key' => 'YouTube refused the Google sign-in for this project (check that the YouTube Data API v3 is enabled on it).',
    'owner_only'            => "YouTube's owner-only broadcast details could not be read; using public video data for now.",
    'quota'                 => "The day's quota is used up; it resets at midnight US Pacific time.",
    'request'               => "YouTube rejected the site's request; tell the developer.",
];

/**
 * The in-process stand-in's two fixed, obviously fake credential literals
 * (§10.1, §11.3 item 4). Not secrets: like PAY_SIMULATOR_DEV_KEY they only
 * ever steer the simulator. It accepts any API key but the wrong-key literal
 * (which gets Google's 400 "API key not valid"), and only the mock client
 * secret — the one tests/support/youtube_mock.mjs is started with — so both an
 * `auth` answer and an invalid_client refusal can be produced in process.
 */
const LIVE_YT_SIM_WRONG_API_KEY = 'wrong-key-not-secret';
const LIVE_YT_SIM_CLIENT_SECRET = 'mock-client-secret-not-secret';

/** The last four characters of a video id that choose a stand-in scenario (§10.2). */
const LIVE_YT_SIM_SCENARIOS = ['0404', '0429', '0500', '0403', '0401', 'UPCM', 'STRT', 'LIVE', 'HIDE', 'DONE', 'PRIV', 'NOEM', 'NOLS', 'RVOK'];

/* ── Addresses ───────────────────────────────────────────────────────────── */

/** LIVE_YT_API_BASE, or YOUTUBE_API_BASE_URL when §10.1 allows it. */
function liveYoutubeApiBase(): string
{
    return liveYoutubeOverrideUrl('YOUTUBE_API_BASE_URL') ?? LIVE_YT_API_BASE;
}

/** LIVE_YT_TOKEN_URL, or YOUTUBE_OAUTH_TOKEN_URL when §10.1 allows it. */
function liveYoutubeTokenUrl(): string
{
    return liveYoutubeOverrideUrl('YOUTUBE_OAUTH_TOKEN_URL') ?? LIVE_YT_TOKEN_URL;
}

/**
 * Internal: a test-only base-URL override, or null. Honoured only behind
 * liveSimulatorAllowed() (G21), and only as an https address with a plain
 * host, or plain http to 127.0.0.1 / localhost (where the Node stand-in
 * listens); never with credentials, a query or a fragment. A value that is
 * set but refused is logged once and ignored.
 */
function liveYoutubeOverrideUrl(string $var): ?string
{
    static $warned = [];
    if (!liveSimulatorAllowed()) return null;
    $raw = trim(envValue($var));
    if ($raw === '') return null;
    $p = preg_match('/[\x00-\x20\x7F\\\\]/', $raw) ? false : parse_url($raw);
    $ok = is_array($p) && isset($p['scheme'], $p['host'])
        && !isset($p['user']) && !isset($p['pass']) && !isset($p['query']) && !isset($p['fragment']);
    if ($ok) {
        $scheme = strtolower((string) $p['scheme']);
        $host   = strtolower((string) $p['host']);
        $ok = $scheme === 'https'
            ? preg_match('/^[a-z0-9.-]+$/', $host) === 1
            : ($scheme === 'http' && in_array($host, ['127.0.0.1', 'localhost'], true));
    }
    if (!$ok) {
        if (!isset($warned[$var])) {
            $warned[$var] = true;
            error_log("[live] {$var} is not an https address (or http on 127.0.0.1 / localhost) and was ignored");
        }
        return null;
    }
    return rtrim($raw, '/');
}

/** Internal: true when mode = simulator and the fence allows it — every call is then answered in process. */
function liveYoutubeSimulating(): bool
{
    return trim(liveSetting('mode')) === 'simulator' && liveSimulatorAllowed();
}

/**
 * Internal: one request, in the notifyHttp() shape. The query is sent
 * RFC 3986-encoded; in simulator mode liveYoutubeSimulate() answers without
 * opening a socket.
 *
 * @return array{status:int, headers:array, body:string, error:string}
 */
function liveYoutubeSend(string $method, string $url, array $headers, array $query, ?array $body): array
{
    if (liveYoutubeSimulating()) return liveYoutubeSimulate($method, $url, $headers, $query, $body ?? []);
    $full = $query ? $url . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : $url;
    return notifyHttp($method, $full, $headers, $body, LIVE_YT_TIMEOUT);
}

/* ── Run state ───────────────────────────────────────────────────────────── */

/**
 * Internal: what one run has learned that its later calls must honour — the
 * Tier 1 fallback and its standing notice (§4.2 "for the rest of the run"), a
 * token failure with no API key to fall back on (so a run asks the token
 * endpoint once, not once per chunk), a bearer held in memory (a dry run's,
 * G18, or one that could not be stored), a dry run's unrecorded token
 * refusal, and the actor its audit rows carry.
 */
function &liveYoutubeRunState(): array
{
    static $run = null;
    if ($run === null) {
        $run = ['actor' => 'cron', 'fallback' => false, 'notice' => '', 'failure' => null, 'mem_token' => null, 'dry_revoked' => null];
    }
    return $run;
}

/**
 * Begin a run: forget everything the previous run learned (the Tier 1
 * fallback, the standing notice, a remembered token failure, a bearer held in
 * memory) and record the actor that this run's audit rows
 * (live_provider_revoked, live_provider_token_rotated) carry — so a suite's
 * sweep writes rows its cleanup can remove by actor (§10.5). null keeps the
 * current actor ('cron' until one is given). The poller calls it once at the
 * start of every sweep, after liveConfigReset().
 */
function liveYoutubeRunStart(?string $actor = null): void
{
    $run = &liveYoutubeRunState();
    $a = $actor === null ? (string) $run['actor'] : (mb_substr(trim($actor), 0, 60) ?: 'cron');
    $run = ['actor' => $a, 'fallback' => false, 'notice' => '', 'failure' => null, 'mem_token' => null, 'dry_revoked' => null];
}

/* ── The batch ───────────────────────────────────────────────────────────── */

/**
 * One videos.list call for up to LIVE_YT_BATCH_MAX ids (1 unit), plus — at
 * Tier 2, and only when the batch holds a SCHEDULED or STARTING row — one
 * liveBroadcasts.list call for the same ids (1 more unit).
 *
 * When no bearer can be had, when the API refuses the bearer and an API key
 * is configured, or when liveBroadcasts.list fails after videos.list
 * answered, the call degrades to Tier 1 as §4.2's "Tier 2 never stops Tier 1"
 * says, and `notice` carries the sentence the answered call leaves.
 *
 * As built:
 *  - answers are keyed like $streams, one fact per row (an item fans out to
 *    every row carrying its id; an id the response did not carry, or a row
 *    whose provider_broadcast_id is not a video id, is liveYoutubeMissingFact()).
 *    A row whose id did not fit in the first LIVE_YT_BATCH_MAX distinct ids
 *    has no entry: it was not asked.
 *  - every Data API call is counted with liveQuotaSpend($db, 1) before it is
 *    made — the forced-refresh retry and the key= resend included, and in a
 *    dry run too; a dry run checks the ceiling first so it never opens the
 *    breaker (G18). When the spend is refused the call is not made: before
 *    videos.list that is outcome `skipped`; before liveBroadcasts.list the
 *    chunk is answered on its videos.list facts.
 *  - outcome null means the call answered (a 200, or a 404 videoNotFound
 *    handled as a 200 with no items). Otherwise class/outcome/error/
 *    retry_after describe the call-level failure (§4.2's table) and `notice`
 *    is its committee sentence from LIVE_PROVIDER_MESSAGES. `not_configured`
 *    (liveAutomationReady() false) and `skipped` (the breaker is open, or the
 *    quota spend was refused) make no call.
 *  - a quota answer opens the breaker (liveQuotaBlock()), except in a dry
 *    run; a `request` answer is logged once per call as class, status, reason
 *    and id count only.
 *  - never throws: anything unexpected is a transient `unreachable` failure,
 *    logged redacted.
 *
 * @param array<int, array> $streams  live_streams rows, keyed by id
 * @param bool $dryRun  a refreshed bearer is held in memory only, and a
 *                      token refusal is reported, not recorded (G18)
 * @return array{answers: array<int, array>, calls: int, units: int, class: ?string, error: ?string, outcome: ?string, retry_after: ?int, notice: string}
 */
function liveYoutubeFetchMany(array $streams, bool $dryRun = false, bool $probe = false): array
{
    $out = ['answers' => [], 'calls' => 0, 'units' => 0, 'class' => null, 'error' => null, 'outcome' => null, 'retry_after' => null, 'notice' => ''];
    try {
        return liveYoutubeFetchChunk($streams, $dryRun, $out, $probe);
    } catch (Throwable $e) {
        error_log('[live] YouTube check failed: ' . liveRedact(get_class($e) . ': ' . $e->getMessage()));
        return array_replace($out, [
            'answers' => [], 'class' => 'transient', 'error' => 'internal error', 'outcome' => 'unreachable',
            'retry_after' => null, 'notice' => LIVE_PROVIDER_MESSAGES['unreachable'],
        ]);
    }
}

/**
 * Readiness for the admin connection test (§8.3): the same gates as
 * liveAutomationReady() except the mode, so a credential can be proven before
 * automation is switched on. mode = simulator still needs the fence.
 */
function liveYoutubeProbeReady(): bool
{
    if (!liveAutomationInstalled()) return false;
    $mode = trim(liveSetting('mode'));
    if ($mode === 'simulator' && !liveSimulatorAllowed()) return false;
    if ($mode !== 'simulator' && liveAutomationTier() < 1) return false;
    return function_exists('curl_init') && liveQuotaBlockedUntil() === null;
}

/** Internal: the body of liveYoutubeFetchMany(); $out carries calls/units even when this throws. */
function liveYoutubeFetchChunk(array $streams, bool $dryRun, array &$out, bool $probe = false): array
{
    $run = &liveYoutubeRunState();

    // The ids: distinct, in row order, at most LIVE_YT_BATCH_MAX.
    $asked = [];
    $invalid = [];
    foreach ($streams as $k => $row) {
        $id = is_array($row) ? trim((string) ($row['provider_broadcast_id'] ?? '')) : '';
        if (!preg_match(LIVE_YT_ID_RE, $id) || $id === 'live_stream') {
            $invalid[$k] = true;
            continue;
        }
        if (count($asked) < LIVE_YT_BATCH_MAX && !in_array($id, $asked, true)) $asked[] = $id;
    }

    if (!($probe ? liveYoutubeProbeReady() : liveAutomationReady()['ok'])) {
        $out['outcome'] = liveQuotaBlockedUntil() !== null ? 'skipped' : 'not_configured';
        return $out;
    }
    // A token failure this run already met with no API key to fall back on.
    if ($run['failure'] !== null) return array_replace($out, $run['failure']);

    $db = getDB();
    $apiKey = liveCredential('api_key');
    $items = [];
    $bcasts = [];
    $chunkNotice = '';

    if ($asked) {
        // Tier 2: a bearer, unless this run already fell back to the key.
        $bearer = null;
        if (liveAutomationTier() === 2 && !$run['fallback']) {
            $tok = liveYoutubeAccessToken($db, false, $dryRun);
            if ($tok['ok']) {
                $bearer = (string) $tok['token'];
            } elseif (($fail = liveYoutubeTokenFallback($tok, $apiKey)) !== null) {
                return array_replace($out, $fail);
            }
        }

        // videos.list
        $v = liveYoutubeCall($db, $dryRun, $out, 'videos', $asked, $bearer, $apiKey);
        if ($v === null) {
            $out['outcome'] = 'skipped';
            return $out;
        }
        if ($bearer !== null && liveYoutubeBearerRefused($v)) {
            if ($v['status'] === 401) {
                // Exactly one forced refresh and one retry of the call (§4.2, 401 row).
                $tok = liveYoutubeAccessToken($db, true, $dryRun);
                if ($tok['ok']) {
                    $bearer = (string) $tok['token'];
                    $v = liveYoutubeCall($db, $dryRun, $out, 'videos', $asked, $bearer, $apiKey);
                } else {
                    if (($fail = liveYoutubeTokenFallback($tok, $apiKey)) !== null) return array_replace($out, $fail);
                    $bearer = null;   // the one retry goes with key=
                    $v = liveYoutubeCall($db, $dryRun, $out, 'videos', $asked, null, $apiKey);
                }
                if ($v === null) {
                    $out['outcome'] = 'skipped';
                    return $out;
                }
            }
            if ($bearer !== null && liveYoutubeBearerRefused($v)) {
                // The API refused the bearer itself: finish the run on the key (§4.2).
                if ($apiKey === '') return array_replace($out, liveYoutubeCallFailure($v));
                $run['fallback'] = true;
                $run['notice'] = LIVE_PROVIDER_MESSAGES['bearer_refused'];
                $bearer = null;
                $v = liveYoutubeCall($db, $dryRun, $out, 'videos', $asked, null, $apiKey);
                if ($v === null) {
                    $out['outcome'] = 'skipped';
                    return $out;
                }
            }
        }
        if ($v['outcome'] !== null && $v['outcome'] !== 'not_found') {
            return array_replace($out, liveYoutubeCallFailure($v));
        }
        if ($v['outcome'] === null) $items = liveYoutubeItemsById($v['body'], $asked);

        // liveBroadcasts.list — Tier 2, still on the bearer, and only for a batch with a SCHEDULED or STARTING row.
        if ($bearer !== null && liveYoutubeWantsBroadcasts($streams)) {
            [$bcasts, $chunkNotice] = liveYoutubeBroadcasts($db, $dryRun, $out, $asked, $bearer, $apiKey);
        }
    }

    foreach ($streams as $k => $row) {
        if (isset($invalid[$k])) {
            $out['answers'][$k] = liveYoutubeMissingFact();
            continue;
        }
        $id = trim((string) ($row['provider_broadcast_id'] ?? ''));
        if (!in_array($id, $asked, true)) continue;
        $out['answers'][$k] = isset($items[$id]) ? liveYoutubeFacts($items[$id], $bcasts[$id] ?? null) : liveYoutubeMissingFact();
    }
    $out['notice'] = $run['notice'] !== '' ? $run['notice'] : $chunkNotice;
    return $out;
}

/**
 * Internal: liveBroadcasts.list after videos.list answered. Any failure here
 * leaves the chunk on its videos.list facts: a bearer the API refuses, with an
 * API key, moves the rest of the run to the key (standing notice
 * bearer_refused); anything else gives this chunk the owner_only notice. A
 * refused quota spend skips the call silently (the breaker says why).
 *
 * @return array{0: array<string, array>, 1: string} items by id, and this chunk's notice
 */
function liveYoutubeBroadcasts(PDO $db, bool $dryRun, array &$out, array $asked, string $bearer, string $apiKey): array
{
    $run = &liveYoutubeRunState();
    $b = liveYoutubeCall($db, $dryRun, $out, 'liveBroadcasts', $asked, $bearer, '');
    if ($b === null) return [[], ''];
    if ($b['status'] === 401) {
        $tok = liveYoutubeAccessToken($db, true, $dryRun);
        if (!$tok['ok']) {
            if ($apiKey !== '') {
                liveYoutubeTokenFallback($tok, $apiKey);
                return [[], ''];
            }
            // No key: later chunks cannot get a bearer either; this one keeps its videos.list facts.
            liveYoutubeTokenFallback($tok, $apiKey);
            return [[], $tok['revoked'] ? liveYoutubeRevokedSentence((string) $tok['error']) : LIVE_PROVIDER_MESSAGES['owner_only']];
        }
        $b = liveYoutubeCall($db, $dryRun, $out, 'liveBroadcasts', $asked, (string) $tok['token'], '');
        if ($b === null) return [[], ''];
    }
    if (liveYoutubeBearerRefused($b)) {
        if ($apiKey !== '') {
            $run['fallback'] = true;
            $run['notice'] = LIVE_PROVIDER_MESSAGES['bearer_refused'];
            return [[], ''];
        }
        return [[], LIVE_PROVIDER_MESSAGES['owner_only']];
    }
    if ($b['outcome'] === 'not_found') return [[], ''];
    if ($b['outcome'] !== null) return [[], LIVE_PROVIDER_MESSAGES['owner_only']];
    return [liveYoutubeItemsById($b['body'], $asked), ''];
}

/**
 * Internal: a token failure met while trying for a bearer. With an API key
 * the run falls back to Tier 1 for the rest of the run and the standing
 * notice becomes the refusal's sentence (§3.3) or token_failed; null is
 * answered. Without one the failure is remembered for the rest of the run and
 * returned: `auth` for a refusal, `unreachable` otherwise.
 */
function liveYoutubeTokenFallback(array $tok, string $apiKey): ?array
{
    $run = &liveYoutubeRunState();
    $sentence = $tok['revoked'] ? liveYoutubeRevokedSentence((string) $tok['error']) : null;
    if ($apiKey !== '') {
        $run['fallback'] = true;
        $run['notice'] = $sentence ?? LIVE_PROVIDER_MESSAGES['token_failed'];
        return null;
    }
    $failure = $tok['revoked']
        ? ['class' => 'auth', 'outcome' => 'auth', 'error' => (string) $tok['error'], 'retry_after' => null, 'notice' => (string) $sentence]
        : ['class' => 'transient', 'outcome' => 'unreachable', 'error' => liveRedact('token: ' . (string) $tok['error'], 200), 'retry_after' => null, 'notice' => LIVE_PROVIDER_MESSAGES['unreachable']];
    $run['failure'] = $failure;
    return $failure;
}

/** Internal: the §3.3 sentence for invalid_grant / invalid_client. */
function liveYoutubeRevokedSentence(string $code): string
{
    return $code === 'invalid_client' ? LIVE_PROVIDER_MESSAGES['invalid_client'] : LIVE_PROVIDER_MESSAGES['invalid_grant'];
}

/** Internal: a 401, or a 403 the §4.2 table classes `auth` — the API refused the credential the request carried. */
function liveYoutubeBearerRefused(array $call): bool
{
    return $call['status'] === 401 || ($call['status'] === 403 && $call['class'] === 'auth');
}

/** Internal: does this batch hold a SCHEDULED or STARTING row (the only rows Tier 2's lifecycle can help)? */
function liveYoutubeWantsBroadcasts(array $streams): bool
{
    foreach ($streams as $row) {
        if (is_array($row) && in_array((string) ($row['status'] ?? ''), ['SCHEDULED', 'STARTING'], true)) return true;
    }
    return false;
}

/** Internal: the items of a usable list response, by id, for the ids asked only (first occurrence wins). */
function liveYoutubeItemsById(string $body, array $asked): array
{
    $data = json_decode($body, true);
    $out = [];
    $list = is_array($data) && is_array($data['items'] ?? null) ? $data['items'] : [];
    foreach ($list as $item) {
        if (!is_array($item) || !is_string($item['id'] ?? null)) continue;
        $id = $item['id'];
        if (in_array($id, $asked, true) && !isset($out[$id])) $out[$id] = $item;
    }
    return $out;
}

/**
 * Internal: count one unit, then make one Data API call, and classify it.
 * null when the quota spend was refused (the call was not made). The
 * credential is the bearer when one is given, else key=<api key> in the query
 * (omitted when there is none — only the simulator answers that); never both,
 * and never the key in a header.
 *
 * @return ?array{status:int, headers:array, body:string, class:?string, outcome:?string, message:string, bearer:bool}
 */
function liveYoutubeCall(PDO $db, bool $dryRun, array &$out, string $kind, array $ids, ?string $bearer, string $apiKey): ?array
{
    if (!liveYoutubeSpend($db, $dryRun)) return null;
    $query = ['part' => $kind === 'videos' ? LIVE_YT_VIDEO_PART : LIVE_YT_BCAST_PART, 'id' => implode(',', $ids)];
    if ($kind === 'liveBroadcasts') $query['maxResults'] = '50';
    $headers = ['Accept' => 'application/json'];
    if ($bearer !== null) {
        $headers['Authorization'] = 'Bearer ' . $bearer;
    } elseif ($apiKey !== '') {
        $query['key'] = $apiKey;
    }
    $r = liveYoutubeSend('GET', liveYoutubeApiBase() . '/' . $kind, $headers, $query, null);
    $out['calls']++;
    $out['units']++;

    $status  = (int) ($r['status'] ?? 0);
    $headers = is_array($r['headers'] ?? null) ? $r['headers'] : [];
    $body    = (string) ($r['body'] ?? '');
    [$class, $outcome, $message] = liveYoutubeClassify($status, $headers, $body);
    if ($outcome !== null && $status === 0 && (string) ($r['error'] ?? '') !== '') $message .= ': ' . $r['error'];
    $message = liveRedact($message, 200);
    if ($outcome === 'request') {
        error_log('[live] YouTube refused the request: ' . liveRedact($status . ' ' . liveYoutubeReason($body) . ', ' . count($ids) . ' ids'));
    }
    if ($outcome === 'quota' && !$dryRun) liveQuotaBlock($db, $message);
    return ['status' => $status, 'headers' => $headers, 'body' => $body, 'class' => $class, 'outcome' => $outcome, 'message' => $message, 'bearer' => $bearer !== null];
}

/**
 * Internal: count one Data API unit before a call (§5.3 step 8). A dry run
 * counts too, because Google charges it, but checks the ceiling first so it
 * never opens the breaker (G18): false there means "do not make the call".
 */
function liveYoutubeSpend(PDO $db, bool $dryRun): bool
{
    if ($dryRun) {
        [$min, $max] = LIVE_SETTING_RANGES['daily_quota_units'];
        $cap = liveSettingClampInt(liveSetting('daily_quota_units'), (int) LIVE_SETTING_DEFAULTS['daily_quota_units'], $min, $max);
        $fresh = liveSettingsFresh($db, ['quota_day', 'quota_units']);
        $units = trim($fresh['quota_units']['v'] ?? '0');
        $used = trim($fresh['quota_day']['v'] ?? '') === livePacificDay() && ctype_digit($units) ? (int) $units : 0;
        if ($used + 1 > $cap) return false;
    }
    return liveQuotaSpend($db, 1);
}

/** Internal: the call-level failure a classified call describes, with its committee sentence. */
function liveYoutubeCallFailure(array $call): array
{
    $outcome = (string) $call['outcome'];
    $notice = match ($outcome) {
        'rate_limited' => LIVE_PROVIDER_MESSAGES['rate_limited'],
        'quota'        => LIVE_PROVIDER_MESSAGES['quota'],
        'auth'         => $call['bearer'] ? LIVE_PROVIDER_MESSAGES['bearer_refused_no_key'] : LIVE_PROVIDER_MESSAGES['key_refused'],
        'request'      => LIVE_PROVIDER_MESSAGES['request'],
        default        => LIVE_PROVIDER_MESSAGES['unreachable'],
    };
    return [
        'answers'     => [],
        'class'       => $call['class'],
        'outcome'     => $outcome,
        'error'       => $call['message'],
        'retry_after' => liveRetryAfterSeconds($call['headers']),
        'notice'      => $notice,
    ];
}

/**
 * Map a machine answer to the committee's words: ['tone' => success | warning
 * | error, 'text' => a LIVE_PROVIDER_MESSAGES sentence]. Accepts
 * liveYoutubeFetchMany()'s result (and fetchStatus()'s "not configured"
 * literal). An answered call is `success` "Connected — YouTube answered.", or
 * `warning` with its notice when it degraded (§4.2); a failure uses the
 * sentence the client chose for it (its `notice`), else the outcome's. Never
 * echoes a raw response. The poller's call-level provider_notice and
 * sync_error sentence and the settings page's connection test both come from
 * here (§8.3, §5.3 step 9).
 *
 * @return array{tone: string, text: string}
 */
function liveProviderConnectionMessage(array $answer): array
{
    $outcome = isset($answer['outcome']) && is_string($answer['outcome']) ? $answer['outcome'] : null;
    $notice  = isset($answer['notice']) && is_string($answer['notice']) ? trim($answer['notice']) : '';
    if ($outcome === null && ($answer['ok'] ?? null) === false && ($answer['error'] ?? null) === 'not configured') {
        $outcome = 'not_configured';
    }
    if ($outcome === null || $outcome === '' || $outcome === 'not_found') {
        return $notice !== '' ? ['tone' => 'warning', 'text' => $notice] : ['tone' => 'success', 'text' => LIVE_PROVIDER_MESSAGES['connected']];
    }
    $text = match ($outcome) {
        'not_configured'  => LIVE_PROVIDER_MESSAGES['no_key'],
        'skipped', 'quota' => LIVE_PROVIDER_MESSAGES['quota'],
        'rate_limited'    => LIVE_PROVIDER_MESSAGES['rate_limited'],
        'auth'            => LIVE_PROVIDER_MESSAGES['key_refused'],
        'request'         => LIVE_PROVIDER_MESSAGES['request'],
        default           => LIVE_PROVIDER_MESSAGES['unreachable'],
    };
    if ($notice !== '' && in_array($notice, LIVE_PROVIDER_MESSAGES, true)) $text = $notice;
    $tone = in_array($outcome, ['auth', 'request'], true) ? 'error' : 'warning';
    return ['tone' => $tone, 'text' => $text];
}

/* ── OAuth ───────────────────────────────────────────────────────────────── */

/**
 * A usable bearer for Tier 2, or null. class is 'auth' only for
 * invalid_grant / invalid_client (the refusal of §3.3, `revoked` true) and
 * 'transient' for every other failure.
 *
 * As built: without $force the cached bearer is re-read from live_settings
 * (decrypted; usable while oauth_access_token_expires_at is in the future),
 * then one held in memory by this run. A refresh POSTs the refresh-token
 * grant to liveYoutubeTokenUrl() and caches the answer encrypted, with
 * oauth_access_token_expires_at = now + expires_in - 300 s (never a fixed
 * 3600); a refresh token Google rotates replaces a stored one in the same
 * transaction with one live_provider_token_rotated audit row (an env-supplied
 * one is never stored). On invalid_grant / invalid_client it sets
 * oauth_revoked_at and oauth_revoked_reason in one write, deletes the cached
 * bearer, writes the §3.3 sentence through liveProviderNoticeSet() and one
 * live_provider_revoked audit row naming the code. While oauth_revoked_at is
 * set it answers the refusal without asking the endpoint. A dry run writes
 * none of this: a refreshed bearer and a refusal are held in memory for the
 * run (G18).
 *
 * @return array{ok: bool, token: ?string, error: string, class: string, revoked: bool}
 */
function liveYoutubeAccessToken(PDO $db, bool $force = false, bool $dryRun = false): array
{
    $run = &liveYoutubeRunState();
    $fail = static fn(string $error, string $class = 'transient', bool $revoked = false): array
        => ['ok' => false, 'token' => null, 'error' => $error, 'class' => $class, 'revoked' => $revoked];
    $okTok = static fn(string $token): array => ['ok' => true, 'token' => $token, 'error' => '', 'class' => '', 'revoked' => false];

    try {
        $clientId = liveCredential('client_id');
        $secret   = liveCredential('client_secret');
        $refresh  = liveCredential('refresh_token');
        if ($clientId === '' || $secret === '' || $refresh === '') return $fail('OAuth credentials are not configured');
        if ($dryRun && $run['dry_revoked'] !== null) return $fail((string) $run['dry_revoked'], 'auth', true);

        $fresh = liveSettingsFresh($db, ['oauth_revoked_at', 'oauth_revoked_reason', 'oauth_access_token', 'oauth_access_token_expires_at']);
        if (liveSettingInstant($fresh['oauth_revoked_at']['v'] ?? '') !== null) {
            $code = trim($fresh['oauth_revoked_reason']['v'] ?? '');
            return $fail(in_array($code, LIVE_OAUTH_REVOKED_REASONS, true) ? $code : 'invalid_grant', 'auth', true);
        }

        $now = liveUtcNow();
        if (!$force) {
            $cached = isset($fresh['oauth_access_token']) ? liveSecretDecrypt($fresh['oauth_access_token']['v']) : null;
            $until  = liveSettingInstant($fresh['oauth_access_token_expires_at']['v'] ?? '');
            if ($cached !== null && $cached !== '' && $until !== null && $until > $now) return $okTok($cached);
            $mem = $run['mem_token'];
            if (is_array($mem) && $mem['expires'] > $now) return $okTok((string) $mem['token']);
        }

        $r = liveYoutubeSend('POST', liveYoutubeTokenUrl(), [
            'Content-Type' => 'application/x-www-form-urlencoded',
            'Accept'       => 'application/json',
        ], [], [
            'client_id'     => $clientId,
            'client_secret' => $secret,
            'refresh_token' => $refresh,
            'grant_type'    => 'refresh_token',
        ]);
        $status = (int) ($r['status'] ?? 0);
        $body   = (string) ($r['body'] ?? '');
        [$class, , $message] = liveYoutubeClassify($status, is_array($r['headers'] ?? null) ? $r['headers'] : [], $body, true);

        if ($class === null) {
            $data  = (array) json_decode($body, true);
            $token = (string) $data['access_token'];
            $ttl   = isset($data['expires_in']) && is_numeric($data['expires_in']) ? (int) $data['expires_in'] : 0;
            $until = gmdate('Y-m-d H:i:s', (int) strtotime($now . ' UTC') + max(0, $ttl - 300));
            liveYoutubeScopeCheck($data['scope'] ?? null);
            $rotated = is_string($data['refresh_token'] ?? null) && trim($data['refresh_token']) !== '' && $data['refresh_token'] !== $refresh
                ? trim($data['refresh_token']) : null;
            $run['mem_token'] = null;
            if ($dryRun) {
                $run['mem_token'] = ['token' => $token, 'expires' => $until];
                if ($rotated !== null) error_log('[live] a dry run was given a new refresh token by Google and did not store it');
                return $okTok($token);
            }
            try {
                liveTransaction($db, function (PDO $db) use ($token, $until, $rotated, $run): void {
                    liveSettingSave($db, 'oauth_access_token', $token, $run['actor']);
                    liveSettingSave($db, 'oauth_access_token_expires_at', $until, $run['actor']);
                    if ($rotated !== null && trim(envValue(LIVE_CREDENTIAL_ENV['refresh_token'])) === '') {
                        liveSettingSave($db, 'youtube_refresh_token', $rotated, $run['actor']);
                        liveAudit('live_provider_token_rotated', 'YouTube automation', 'youtube_refresh_token', $run['actor']);
                    }
                });
            } catch (Throwable) {
                // Without LIVE_SETTINGS_KEY nothing secret can be stored: the bearer lives for this run only.
                $run['mem_token'] = ['token' => $token, 'expires' => $until];
                liveConfigReset();
            }
            return $okTok($token);
        }

        if ($class === 'auth') {
            $code = liveYoutubeTokenError($body);
            $run['mem_token'] = null;
            if ($dryRun) {
                $run['dry_revoked'] = $code;
                return $fail($code, 'auth', true);
            }
            liveTransaction($db, function (PDO $db) use ($code, $now, $run): void {
                $db->prepare(
                    "INSERT INTO live_settings (k, v, is_secret, updated_by, updated_at)
                     VALUES ('oauth_revoked_at', :at, 0, :a1, UTC_TIMESTAMP()), ('oauth_revoked_reason', :code, 0, :a2, UTC_TIMESTAMP())
                     ON DUPLICATE KEY UPDATE v = VALUES(v), is_secret = 0, updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)"
                )->execute([':at' => $now, ':code' => $code, ':a1' => $run['actor'], ':a2' => $run['actor']]);
                liveSettingSave($db, 'oauth_access_token', null, $run['actor']);
                liveSettingSave($db, 'oauth_access_token_expires_at', '', $run['actor']);
            });
            liveProviderNoticeSet($db, liveYoutubeRevokedSentence($code));
            liveAudit('live_provider_revoked', 'YouTube automation', $code, $run['actor']);
            liveConfigReset();
            return $fail($code, 'auth', true);
        }

        $err = $status === 0 && (string) ($r['error'] ?? '') !== '' ? $message . ': ' . $r['error'] : $message;
        return $fail(liveRedact($err, 200));
    } catch (Throwable $e) {
        error_log('[live] YouTube sign-in failed: ' . liveRedact(get_class($e) . ': ' . $e->getMessage()));
        return $fail('internal error');
    }
}

/** Internal: the `error` code of a token-endpoint body — invalid_grant or invalid_client, else ''. */
function liveYoutubeTokenError(string $body): string
{
    $data = $body === '' ? null : json_decode($body, true);
    $code = is_array($data) && is_string($data['error'] ?? null) ? $data['error'] : '';
    return in_array($code, LIVE_OAUTH_REVOKED_REASONS, true) ? $code : '';
}

/**
 * Internal: LIVE_YT_SCOPE is the ceiling. A grant that carries any other
 * scope still works (only read endpoints are ever called) but is logged once,
 * so the owner can mint a narrower refresh token (§15 item 7).
 */
function liveYoutubeScopeCheck(mixed $scope): void
{
    static $warned = false;
    if ($warned || !is_string($scope) || trim($scope) === '') return;
    foreach (preg_split('/\s+/', trim($scope)) ?: [] as $s) {
        if ($s !== LIVE_YT_SCOPE) {
            $warned = true;
            error_log('[live] the Google sign-in carries more than the youtube.readonly scope; mint the refresh token with only ' . LIVE_YT_SCOPE);
            return;
        }
    }
}

/* ── Reading the answer ──────────────────────────────────────────────────── */

/**
 * One videos.list item (+ optional liveBroadcasts item) -> the §4.1 fact array.
 *
 * sync_state by §6.1, first match wins: privacy not public/unlisted, or
 * embeddable === false → restricted; no liveStreamingDetails → not_broadcast;
 * actualEndTime → ended; liveBroadcastContent live → live; upcoming →
 * upcoming; none (with details, no end) → ended; else unknown. At Tier 2, and
 * only for upcoming / live / ended / unknown, lifeCycleStatus replaces it
 * (created/ready → upcoming; testStarting/testing/liveStarting → starting;
 * live → live; complete → ended; revoked → revoked). Every field is
 * type-checked: a value of the wrong shape is null, never guessed.
 */
function liveYoutubeFacts(array $video, ?array $broadcast = null): array
{
    $snippet  = is_array($video['snippet'] ?? null) ? $video['snippet'] : [];
    $status   = is_array($video['status'] ?? null) ? $video['status'] : [];
    $details  = is_array($video['liveStreamingDetails'] ?? null) ? $video['liveStreamingDetails'] : null;
    $bStatus  = is_array($broadcast['status'] ?? null) ? $broadcast['status'] : [];
    $bContent = is_array($broadcast['contentDetails'] ?? null) ? $broadcast['contentDetails'] : [];
    $word = static fn(mixed $v, int $max = 30): ?string
        => is_string($v) && preg_match('/^[A-Za-z]{1,' . $max . '}$/D', $v) ? $v : null;

    $raw        = $word($snippet['liveBroadcastContent'] ?? null, 20);
    $privacy    = $word($status['privacyStatus'] ?? null, 20);
    $embeddable = is_bool($status['embeddable'] ?? null) ? $status['embeddable'] : null;
    $sStart     = liveYoutubeInstant($details['scheduledStartTime'] ?? null);
    $sEnd       = liveYoutubeInstant($details['scheduledEndTime'] ?? null);
    $aStart     = liveYoutubeInstant($details['actualStartTime'] ?? null);
    $aEnd       = liveYoutubeInstant($details['actualEndTime'] ?? null);
    $lifecycle  = $word($bStatus['lifeCycleStatus'] ?? null);

    if (($privacy !== 'public' && $privacy !== 'unlisted') || $embeddable === false) {
        $state = 'restricted';
    } elseif ($details === null) {
        $state = 'not_broadcast';
    } elseif ($aEnd !== null) {
        $state = 'ended';
    } elseif ($raw === 'live') {
        $state = 'live';
    } elseif ($raw === 'upcoming') {
        $state = 'upcoming';
    } elseif ($raw === 'none') {
        $state = 'ended';
    } else {
        $state = 'unknown';
    }
    if ($lifecycle !== null && in_array($state, ['upcoming', 'live', 'ended', 'unknown'], true)) {
        $state = match ($lifecycle) {
            'created', 'ready'                        => 'upcoming',
            'testStarting', 'testing', 'liveStarting' => 'starting',
            'live'                                    => 'live',
            'complete'                                => 'ended',
            'revoked'                                 => 'revoked',
            default                                   => $state,
        };
    }

    // concurrentViewers arrives as a string of digits; absent means unknown, never zero.
    $cv = $details['concurrentViewers'] ?? null;
    $viewers = null;
    if (is_int($cv) && $cv >= 0) {
        $viewers = min($cv, 4294967295);
    } elseif (is_string($cv) && preg_match('/^\d{1,10}$/D', $cv) && (int) $cv <= 4294967295) {
        $viewers = (int) $cv;
    }

    $thumbnail = null;
    $thumbs = is_array($snippet['thumbnails'] ?? null) ? $snippet['thumbnails'] : [];
    foreach (['maxres', 'standard', 'high', 'medium', 'default'] as $size) {
        $u = liveSafeUrl(is_array($thumbs[$size] ?? null) ? ($thumbs[$size]['url'] ?? null) : null);
        if ($u !== null && stripos($u, 'https://') === 0) {
            $thumbnail = $u;
            break;
        }
    }

    $streamId = $bContent['boundStreamId'] ?? null;
    $channel  = $snippet['channelId'] ?? null;
    $expected = liveCredential('channel_id');
    return [
        'ok'                 => true,
        'state'              => $state,
        'raw_state'          => $raw,
        'lifecycle'          => $lifecycle,
        'scheduled_start'    => $sStart,
        'scheduled_end'      => $sEnd,
        'actual_start'       => $aStart,
        'actual_end'         => $aEnd,
        'privacy'            => $privacy,
        'embeddable'         => $embeddable,
        'viewers'            => $viewers,
        'thumbnail'          => $thumbnail,
        'recording_status'   => $word($bStatus['recordingStatus'] ?? null),
        'provider_stream_id' => is_string($streamId) && preg_match('/^[A-Za-z0-9_-]{1,100}$/D', $streamId) ? $streamId : null,
        'channel_id'         => is_string($channel) && preg_match('/^[A-Za-z0-9_-]{1,64}$/D', $channel) ? $channel : null,
        'channel_expected'   => $expected !== '' ? $expected : null,
        'checked_at'         => liveUtcNow(),
        'error'              => null,
        'class'              => null,
        'retry_after'        => null,
    ];
}

/** The fact array for an id the response did not carry. */
function liveYoutubeMissingFact(): array
{
    $expected = liveCredential('channel_id');
    return [
        'ok'                 => true,
        'state'              => 'missing',
        'raw_state'          => null,
        'lifecycle'          => null,
        'scheduled_start'    => null,
        'scheduled_end'      => null,
        'actual_start'       => null,
        'actual_end'         => null,
        'privacy'            => null,
        'embeddable'         => null,
        'viewers'            => null,
        'thumbnail'          => null,
        'recording_status'   => null,
        'provider_stream_id' => null,
        'channel_id'         => null,
        'channel_expected'   => $expected !== '' ? $expected : null,
        'checked_at'         => liveUtcNow(),
        'error'              => null,
        'class'              => null,
        'retry_after'        => null,
    ];
}

/**
 * (HTTP status, Google's envelope) -> [class, outcome, message], by the table below; $token selects its token-endpoint rows.
 *
 * As built the answer carries a fourth element, the §4.2 table's scope:
 * [class, outcome, message, scope] — class and outcome null (scope null) for
 * a usable answer; scope 'row' only for 404 videoNotFound, else 'call'. The
 * key is (status, error.errors[0].reason) together, first matching row wins;
 * Google's error.message is read in exactly one row (400 badRequest "API
 * key…"). message is a short technical line — status and reason, never the
 * body — for logs; committee sentences come from LIVE_PROVIDER_MESSAGES.
 *
 * @return array{0: ?string, 1: ?string, 2: string, 3: ?string}
 */
function liveYoutubeClassify(int $status, array $headers, string $body, bool $token = false): array
{
    $data = $body === '' ? null : json_decode($body, true);

    if ($token) {
        if ($status === 200 && is_array($data) && is_string($data['access_token'] ?? null) && $data['access_token'] !== '') {
            return [null, null, '', null];
        }
        $code = liveYoutubeTokenError($body);
        if ($code !== '') return ['auth', 'auth', 'token endpoint refused the grant: ' . $code, 'call'];
        $raw = is_array($data) && is_string($data['error'] ?? null) && preg_match('/^[A-Za-z0-9_.-]{1,60}$/D', $data['error']) ? ' ' . $data['error'] : '';
        return ['transient', 'unreachable', $status === 0 ? 'token endpoint: no response' : 'token endpoint: HTTP ' . $status . $raw, 'call'];
    }

    $reason = liveYoutubeReason($body);
    $what   = trim('HTTP ' . $status . ' ' . $reason);
    if ($status === 0) return ['transient', 'unreachable', 'no response', 'call'];
    if ($status === 200) {
        $expected = is_array($data) && ($data === [] || !array_is_list($data))
            && (array_key_exists('items', $data)
                ? is_array($data['items']) && array_is_list($data['items'])
                : is_string($data['kind'] ?? null) && str_ends_with($data['kind'], 'ListResponse'));
        return $expected ? [null, null, '', null] : ['transient', 'unreachable', 'HTTP 200 with a body that is not the expected JSON', 'call'];
    }
    if ($status >= 500 && $status <= 599) return ['transient', 'unreachable', $what, 'call'];
    if ($status === 429) return ['transient', 'rate_limited', $what, 'call'];
    if ($status === 403 && in_array($reason, ['rateLimitExceeded', 'userRateLimitExceeded'], true)) return ['transient', 'rate_limited', $what, 'call'];
    if ($status === 403 && in_array($reason, ['quotaExceeded', 'dailyLimitExceeded'], true)) return ['quota', 'quota', $what, 'call'];
    if ($status === 400) {
        $gMessage = is_array($data) && is_array($data['error'] ?? null) && is_string($data['error']['message'] ?? null) ? $data['error']['message'] : '';
        if ($reason === 'keyInvalid' || ($reason === 'badRequest' && str_starts_with($gMessage, 'API key'))) return ['auth', 'auth', $what, 'call'];
    }
    if ($status === 401) return ['auth', 'auth', $what, 'call'];
    if ($status === 403) return ['auth', 'auth', $what, 'call'];
    if ($status === 404 && $reason === 'videoNotFound') return ['not_found', 'not_found', $what, 'row'];
    if ($status >= 400 && $status <= 499) return ['request', 'request', $what, 'call'];
    // 1xx, 3xx (redirects are never followed) and any 2xx but 200: not an answer.
    return ['transient', 'unreachable', $what, 'call'];
}

/** Internal: error.errors[0].reason of a Google error envelope, when it is a plain word; else ''. */
function liveYoutubeReason(string $body): string
{
    $data = $body === '' ? null : json_decode($body, true);
    $r = is_array($data) && is_array($data['error'] ?? null) && is_array($data['error']['errors'][0] ?? null)
        ? ($data['error']['errors'][0]['reason'] ?? null) : null;
    return is_string($r) && preg_match('/^[A-Za-z0-9_]{1,60}$/D', $r) ? $r : '';
}

/**
 * Delta-seconds or an HTTP-date Retry-After, clamped to [1, 86400]; null when absent or unparseable.
 *
 * A copy of the body of NotifyProviderSupport::retryAfter()
 * (notify/providers/NotifyProviderSupport.php), deliberately not a call: the
 * live module depends on exactly two notification pieces, the HTTP client and
 * the clock (live.php), and not on the provider layer, so a refactor of the
 * notification providers can never silently change the poller's back-off.
 * Header names are lower-case, as notifyHttp() returns them.
 */
function liveRetryAfterSeconds(array $headers): ?int
{
    $value = trim((string) ($headers['retry-after'] ?? ''));
    if ($value === '') return null;
    if (ctype_digit($value)) return min(86400, max(1, (int) $value));
    $at = strtotime($value);
    if ($at === false) return null;
    return min(86400, max(1, $at - time()));
}

/**
 * RFC 3339 (with or without fractional seconds, with an offset or Z) -> UTC 'Y-m-d H:i:s', or null.
 * Fractional seconds are dropped; a date or time that does not exist
 * (2026-02-31, 25:00, a leap second) is null, and so is anything outside
 * what a DATETIME column holds.
 */
function liveYoutubeInstant(mixed $iso): ?string
{
    if (!is_string($iso)) return null;
    $s = trim($iso);
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?([Zz]|[+-](\d{2}):(\d{2}))$/D', $s, $m)) return null;
    [, $y, $mo, $d, $h, $i, $sec, $zone] = $m;
    if (!checkdate((int) $mo, (int) $d, (int) $y) || (int) $h > 23 || (int) $i > 59 || (int) $sec > 59) return null;
    if (strtoupper($zone) === 'Z') {
        $zone = '+00:00';
    } elseif ((int) ($m[8] ?? 0) > 23 || (int) ($m[9] ?? 0) > 59) {
        return null;
    }
    $t = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s P', "{$y}-{$mo}-{$d} {$h}:{$i}:{$sec} {$zone}");
    if ($t === false) return null;
    $utc = $t->setTimezone(new DateTimeZone('UTC'));
    $year = (int) $utc->format('Y');
    return ($year >= 1000 && $year <= 9999) ? $utc->format('Y-m-d H:i:s') : null;
}

/* ── The in-process stand-in (§10.2) ─────────────────────────────────────── */

/**
 * The in-process stand-in (§10.2). Returns the notifyHttp() shape; no socket
 * is opened. $headers is passed so a bearer request is told from a key= one
 * (the PRIV scenario answers them differently).
 *
 * As built it answers every id exactly as tests/support/youtube_mock.mjs
 * does — the scenario table of §10.2 chosen by the last four characters of
 * each id, instants relative to liveUtcNow() at the moment of the request, a
 * whole-response error only when every id carries the same error tail (an
 * error-tail id in a mixed batch is omitted), more than 50 ids → 400
 * badRequest, a private video omitted without a valid bearer. Credentials:
 * any API key, or none (mode = simulator waives the tier, so Tier 0 can be
 * exercised), except LIVE_YT_SIM_WRONG_API_KEY, which gets the 400 "API key
 * not valid"; the token endpoint takes only LIVE_YT_SIM_CLIENT_SECRET (else
 * 401 invalid_client), answers mock-refresh-invalid-grant with 400
 * invalid_grant and mock-refresh-unavailable with a plain-text 500, as the
 * mock does. There is no per-id instant override and no failNext(). Routes are chosen by the path's
 * last segment: …/videos, …/liveBroadcasts, …/token. Bearers are
 * "mock-access-sim-<unix expiry>-<8 hex>", valid until that instant (3599 s),
 * so one cached by an earlier process is still honoured.
 */
function liveYoutubeSimulate(string $method, string $url, array $headers, array $query, array $body): array
{
    $json = static fn(int $status, array $doc, array $extra = []): array => [
        'status' => $status, 'headers' => ['content-type' => 'application/json; charset=utf-8'] + $extra,
        'body' => (string) json_encode($doc, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'error' => '',
    ];
    $text = static fn(int $status, string $t, array $extra = []): array => [
        'status' => $status, 'headers' => ['content-type' => 'text/plain; charset=utf-8'] + $extra, 'body' => $t, 'error' => '',
    ];
    $apiError = static fn(int $code, string $reason, string $message, array $extra = []): array => $json($code, ['error' => [
        'code' => $code, 'message' => $message,
        'errors' => [['message' => $message, 'domain' => $reason === 'quotaExceeded' ? 'youtube.quota' : 'global', 'reason' => $reason]],
    ]], $extra);
    $authError = static fn(): array => $apiError(401, 'authError', 'Invalid Credentials');

    $now = (int) strtotime(liveUtcNow() . ' UTC');
    $method = strtoupper($method);
    $path = (string) (parse_url($url, PHP_URL_PATH) ?? '');
    $auth = '';
    foreach ($headers as $k => $v) {
        if (strtolower((string) $k) === 'authorization') $auth = trim((string) $v);
    }
    $bearer = preg_match('/^Bearer\s+(\S+)$/i', $auth, $bm) ? $bm[1] : null;
    $bearerValid = $bearer !== null && preg_match('/^mock-access-sim-(\d{1,12})-[0-9a-f]{8}$/D', $bearer, $vm) === 1 && (int) $vm[1] > $now;

    if (str_ends_with($path, '/token')) {
        if ($method !== 'POST') return $text(405, 'Method not allowed', ['allow' => 'POST']);
        $grant = is_string($body['grant_type'] ?? null) ? $body['grant_type'] : '';
        $refresh = is_string($body['refresh_token'] ?? null) ? $body['refresh_token'] : '';
        $secret = is_string($body['client_secret'] ?? null) ? $body['client_secret'] : '';
        if ($grant !== 'refresh_token' || $refresh === '') {
            return $json(400, ['error' => 'unsupported_grant_type', 'error_description' => 'Only refresh_token is supported here']);
        }
        if (!hash_equals(LIVE_YT_SIM_CLIENT_SECRET, $secret)) {
            return $json(401, ['error' => 'invalid_client', 'error_description' => 'The OAuth client was not found.']);
        }
        if ($refresh === 'mock-refresh-invalid-grant') {
            return $json(400, ['error' => 'invalid_grant', 'error_description' => 'Token has been expired or revoked.']);
        }
        if ($refresh === 'mock-refresh-unavailable') return $text(500, 'Internal Server Error');
        return $json(200, [
            'access_token' => 'mock-access-sim-' . ($now + 3599) . '-' . bin2hex(random_bytes(4)),
            'expires_in'   => 3599,
            'scope'        => LIVE_YT_SCOPE,
            'token_type'   => 'Bearer',
        ]);
    }

    $videos = str_ends_with($path, '/videos');
    if (!$videos && !str_ends_with($path, '/liveBroadcasts')) {
        return $json(404, ['error' => ['code' => 404, 'message' => 'Unknown stand-in route', 'errors' => [['reason' => 'notFound']]]]);
    }
    if ($method !== 'GET') return $text(405, 'Method not allowed', ['allow' => 'GET']);
    if ($videos) {
        if ($bearer !== null) {
            if (!$bearerValid) return $authError();
        } else {
            $key = is_string($query['key'] ?? null) ? $query['key'] : '';
            if ($key === LIVE_YT_SIM_WRONG_API_KEY) {
                return $apiError(400, 'badRequest', 'API key not valid. Please pass a valid API key.');
            }
        }
    } elseif (!$bearerValid) {
        return $authError();
    }

    $ids = array_values(array_filter(array_map('trim', explode(',', is_string($query['id'] ?? null) ? $query['id'] : '')), static fn(string $s): bool => $s !== ''));
    if (!$ids) {
        return $apiError(400, 'missingRequiredParameter', 'No filter selected. Expected one of: id, ' . ($videos ? 'chart, myRating' : 'mine, broadcastStatus'));
    }
    if (count($ids) > 50) return $apiError(400, 'badRequest', 'Too many ids: at most 50 may be requested at once, got ' . count($ids) . '.');
    $scenarios = array_map('liveYoutubeSimScenario', $ids);
    $errorTails = ['0429', '0500', '0403', '0401'];
    if (in_array($scenarios[0], $errorTails, true) && count(array_unique($scenarios)) === 1) {
        return match ($scenarios[0]) {
            '0429'  => $apiError(429, 'rateLimitExceeded', 'Too many requests', ['retry-after' => '30']),
            '0500'  => $text(500, 'Internal Server Error'),
            '0403'  => $apiError(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.'),
            default => $authError(),
        };
    }

    $items = [];
    foreach ($ids as $i => $id) {
        if (array_key_exists($id, $items)) continue;   // an id asked twice is answered once
        $scenario = $scenarios[$i];
        if (!preg_match(LIVE_YT_ID_RE, $id) || $scenario === '0404' || in_array($scenario, $errorTails, true)) {
            $items[$id] = null;
            continue;
        }
        $s = liveYoutubeSimDescribe($id, $scenario, $now);
        if ($videos) {
            // As Google does it: a private video is invisible to a key= request.
            $items[$id] = ($s['privacy'] === 'private' && $bearer === null) ? null : liveYoutubeSimVideo($id, $s);
        } else {
            $items[$id] = liveYoutubeSimBroadcast($id, $s);
        }
    }
    $list = array_values(array_filter($items, static fn($x): bool => $x !== null));
    return $json(200, [
        'kind'     => $videos ? 'youtube#videoListResponse' : 'youtube#liveBroadcastListResponse',
        'etag'     => 'simulator',
        'items'    => $list,
        'pageInfo' => ['totalResults' => count($list), 'resultsPerPage' => $videos ? count($list) : 50],
    ]);
}

/** Internal: the §10.2 scenario of an id — its last four characters when they name one, else 'ok'. */
function liveYoutubeSimScenario(string $id): string
{
    $tail = substr($id, -4);
    return in_array($tail, LIVE_YT_SIM_SCENARIOS, true) ? $tail : 'ok';
}

/** Internal: what the stand-in says about one id under its scenario (§10.2 defaults; minutes from now). */
function liveYoutubeSimDescribe(string $id, string $scenario, int $now): array
{
    $upcoming = ['live' => 'upcoming', 'at' => ['scheduledStartTime' => 5], 'lifeCycleStatus' => 'ready', 'recordingStatus' => 'notRecording'];
    $liveNow  = ['live' => 'live', 'at' => ['scheduledStartTime' => -5, 'actualStartTime' => -5], 'lifeCycleStatus' => 'live', 'recordingStatus' => 'recording'];
    $d = match ($scenario) {
        'UPCM'  => $upcoming,
        'STRT'  => ['lifeCycleStatus' => 'testing'] + $upcoming,
        'LIVE'  => $liveNow,
        'HIDE'  => ['hideViewers' => true] + $liveNow,
        'DONE'  => ['live' => 'none', 'at' => ['scheduledStartTime' => -15, 'actualStartTime' => -15, 'actualEndTime' => -5], 'lifeCycleStatus' => 'complete', 'recordingStatus' => 'recorded'],
        'PRIV'  => ['privacy' => 'private'] + $liveNow,
        'NOEM'  => ['embeddable' => false] + $liveNow,
        'RVOK'  => ['lifeCycleStatus' => 'revoked'] + $upcoming,
        default => [],   // NOLS and anything unrecognised: a plain upload
    };
    $instants = [];
    foreach ($d['at'] ?? [] as $k => $minutes) $instants[$k] = gmdate('Y-m-d\TH:i:s\Z', $now + $minutes * 60);
    return [
        'live'            => $d['live'] ?? 'none',
        'instants'        => $instants,
        'privacy'         => $d['privacy'] ?? 'public',
        'embeddable'      => $d['embeddable'] ?? true,
        'hidden'          => !empty($d['hideViewers']),
        'lifeCycleStatus' => $d['lifeCycleStatus'] ?? null,
        'recordingStatus' => $d['recordingStatus'] ?? null,
        'broadcast'       => $d !== [],
    ];
}

/** Internal: the stand-in's videos.list item for one id. */
function liveYoutubeSimVideo(string $id, array $s): array
{
    $details = $s['instants'];
    if ($s['live'] === 'live' && !$s['hidden']) $details['concurrentViewers'] = '42';
    $item = [
        'kind'    => 'youtube#video',
        'etag'    => 'simulator-' . $id,
        'id'      => $id,
        'snippet' => [
            'publishedAt' => '2026-01-01T00:00:00Z',
            'channelId'   => 'UCmockmockmockmockmockmo',
            'title'       => 'Mock video ' . $id,
            'description' => '',
            'thumbnails'  => [
                'default' => ['url' => 'https://i.ytimg.com/vi/' . $id . '/default.jpg', 'width' => 120, 'height' => 90],
                'medium'  => ['url' => 'https://i.ytimg.com/vi/' . $id . '/mqdefault.jpg', 'width' => 320, 'height' => 180],
                'high'    => ['url' => 'https://i.ytimg.com/vi/' . $id . '/hqdefault.jpg', 'width' => 480, 'height' => 360],
            ],
            'channelTitle'         => 'Temple Mahendra',
            'liveBroadcastContent' => $s['live'],
        ],
        'status'  => ['uploadStatus' => 'processed', 'privacyStatus' => $s['privacy'], 'embeddable' => $s['embeddable'], 'madeForKids' => false],
    ];
    if (!($s['live'] === 'none' && $details === [])) $item['liveStreamingDetails'] = $details;
    return $item;
}

/** Internal: the stand-in's liveBroadcasts.list item for one id, or null when it is not a broadcast. */
function liveYoutubeSimBroadcast(string $id, array $s): ?array
{
    if (!$s['broadcast'] && $s['live'] === 'none' && $s['instants'] === []) return null;
    $life = $s['lifeCycleStatus'] ?? (isset($s['instants']['actualEndTime']) ? 'complete' : ($s['live'] === 'live' ? 'live' : 'ready'));
    $rec  = $s['recordingStatus'] ?? ($life === 'complete' ? 'recorded' : ($life === 'live' ? 'recording' : 'notRecording'));
    return [
        'kind'           => 'youtube#liveBroadcast',
        'etag'           => 'simulator-bc-' . $id,
        'id'             => $id,
        'status'         => ['lifeCycleStatus' => $life, 'privacyStatus' => $s['privacy'], 'recordingStatus' => $rec, 'madeForKids' => false, 'selfDeclaredMadeForKids' => false],
        'contentDetails' => [
            'boundStreamId'      => 'mock-stream-' . $id,
            'enableAutoStart'    => true,
            'enableAutoStop'     => true,
            'enableDvr'          => true,
            'recordFromStart'    => true,
            'startWithSlate'     => false,
            'latencyPreference'  => 'normal',
        ],
    ];
}
