# Live Darshan — Phase 3 build contract (YouTube API automation, client phase 3)

Status: build contract, 2026-09-18 (round 5). Starts only after Phase 2 is closed (review findings fixed, all live suites green). Every builder follows this file; where it and the code disagree, **this file wins**; where it is silent, follow `docs/live/SPEC-PHASE2.md`, then `docs/live/SPEC-PHASE1.md` (as amended), then the existing conventions — `docs/payments/SPEC.md` is this module's house reference for encrypted settings, a stand-in used when real credentials are absent, a cron job, an owner-only settings page, audit logging and the test style. **Nothing from Phase 4 or later is built here**: no player UX, no new poster source and no viewer figure anywhere, no sharing or Open Graph work, no Notify-Me subscriptions, no donation link tied to a stream, no archive page, no health dashboard, no analytics. Phase 3 is exactly one thing: the committee stops pressing *Go live* and *End stream* by hand, because a scheduled job asks YouTube what each broadcast is doing and moves the row itself, through the same `liveSetStatus()` the buttons use. **Phase 3 retrieves and stores; the only thing a devotee sees change is the status itself** (and the actual start and end instants that come with it). Nothing is committed to git by any builder.

---

## 0. Scope

### 0.1 The client's Phase 3, verbatim

> **PHASE 3 — YOUTUBE API AUTOMATION**
> Objective: Automatically synchronize live-stream status with YouTube.
>
> **3.1 YouTube API Integration.** Backend should retrieve:
> * Broadcast information
> * Scheduled start
> * Actual start
> * Actual end
> * Live status
> * Video thumbnail
> * Recording URL
> * Viewer count when supported
>
> **3.2 Automatic Status Transition.** Expected flow: SCHEDULED → STARTING → LIVE → COMPLETED. Avoid requiring admin to manually switch status.
>
> **3.3 Background Synchronization.** Create a scheduled job. Example: every defined interval, find active/upcoming streams, check provider, update status, update timestamps, store errors. Do not call provider continuously from users' browsers.
>
> **3.4 Secure Credentials.** Store YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN server-side only. Never expose credentials in frontend code.

### 0.2 Decisions (settled — do not reopen)

The committee authorised proceeding without asking. A builder who disagrees with a choice below writes it in their report and still builds what is here. Nothing in this contract waits for an answer from anyone (§15 is information, not a gate).

1. **Read-only, known ids only.** The job asks YouTube about the video ids the committee already pasted. It never discovers, creates, deletes or unlinks a broadcast. **`search.list` is forbidden outright** — since 2026-06-01 it has its own bucket capped at 100 calls a day, which cannot support a poller. The only endpoints Phase 3 may call are `videos.list` (1 unit) and, with OAuth, `liveBroadcasts.list` (1 unit).
2. **Three tiers, and Tier 1 is the target.** **Tier 0** = no credentials: today's behaviour exactly, no network call ever. **Tier 1** = one `YOUTUBE_API_KEY`: the whole of 3.2 and every field of 3.1 except owner-only broadcast detail. **Tier 2** = the OAuth trio on top (scope `youtube.readonly`, the channel's own Google account): adds `status.lifeCycleStatus` (a real STARTING signal), `status.recordingStatus` and `contentDetails.boundStreamId`. **The contract works completely at Tier 1**; Tier 2 is additive and optional, and a Tier 2 failure never stops Tier 1 (§4.2). §15 lists what the temple loses without it.
3. **The default is off.** `live_settings.mode` seeds to `off`. A site that applies migration 012 and never opens Admin → YouTube Automation sees no behavioural difference of any kind.
4. **A wrong automatic change is worse than a late one.** The job may make exactly four moves — `SCHEDULED→STARTING`, `SCHEDULED→LIVE`, `STARTING→LIVE`, `LIVE→COMPLETED` — plus the two-step catch-up built from them (#6). It never writes `OFFLINE`, `ERROR`, `CANCELLED` or `DRAFT`, never moves a row backwards, and never reads a row that is `DRAFT`, `COMPLETED`, `CANCELLED`, `OFFLINE` or `ERROR`. Those five states stay a person's word. **Every move needs evidence that belongs to this broadcast** (G24) **and a video devotees can play** — embeddable, `public` or `unlisted` (G10).
5. **`LIVE_TRANSITIONS` is not widened.** Phase 3 adds a *narrower*, machine-only `LIVE_AUTO_TRANSITIONS`, a strict subset. `tests/admin-live.mjs:375` asserts that a SCHEDULED row's status select offers **no** `<option value="COMPLETED">`, and `backend/includes/live/admin.php:86` builds the row menu straight from `LIVE_TRANSITIONS`; widening the table would change the committee's form, break a pinned suite and make the admin JSON API accept `PUT {status:'COMPLETED'}` on a scheduled row.
6. **The catch-up is two legal steps, not a new edge.** A broadcast that ran and ended while the cron was down is closed by `→ LIVE` (stamped with YouTube's `actualStartTime`) then `→ COMPLETED` (stamped with `actualEndTime`) inside one transaction. Both moves are already legal and the two audit rows are the truth. The row must still be in the working set, so §5.3 step 6 carries a catch-up disjunct: a `SCHEDULED` row whose start has passed stays eligible **back as far as `catchup_hours` (48)**, however long the cron was down and whatever earlier checks said. Besides `sync_enabled` (G4) and `next_sync_at`, no sync column affects that eligibility. **After an outage longer than `catchup_hours`**, the row stays `SCHEDULED` until a person closes it. Devotees are not shown it as upcoming: the public upcoming list already drops a SCHEDULED row once its end, or its start plus `LIVE_UPCOMING_GRACE_HOURS`, has passed (`liveListUpcoming()`, `store.php:169-179`, the "Phase 1 F3 rule" of `SPEC-PHASE2.md:23`), and the schedule never lists a past day (`liveScheduleWindow()`, `store.php:211-224`).
7. **COMPLETED is terminal, so it is debounced.** The job writes COMPLETED only from YouTube's own `actualEndTime`, and only once that instant is at least `complete_grace_seconds` (120) in the past, because `enableAutoStop` ends a broadcast about a minute after the encoder stops.
8. **A missing, private, deleted, non-embeddable, non-broadcast or foreign video changes no status.** With an API key alone the API cannot tell "deleted" from "made private": both vanish from `items[]` and arrive as `missing`. Phase 3 refuses to guess. It records the fact on the row, says so on the admin page, and leaves the status where a person put it. **A broadcast kept private until it goes live is normal**, and so is a late start, so on a `SCHEDULED` or `STARTING` row a `missing` answer (Tier 1) or a `restricted` one (Tier 2) is not a failure until `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`: it leaves a row notice saying the video is not visible on YouTube yet, is not counted, is not backed off and keeps the row's position cadence, so the row moves on the first pass after the video appears (§5.5). After that it is a row failure on a `SCHEDULED` row, and on a `STARTING` row G22's pause (`missing`) or notice N5 (`restricted`), as §6.2 says.
9. **Everything clause 3.1 lists is retrieved and stored; nothing new is displayed.** Clause 3.1 says *"Backend should retrieve"*. `provider_thumbnail_url` and `viewer_count` are stored and read by **nothing** in Phase 3 — not `thumbnailUrl()`, not any public page or JSON, not the admin. Phase 4 decides whether a poster or a viewer figure is shown; Phase 11 owns viewer figures behind the existing `live.analytics` capability (`auth.php:73`). `recording_url` is written as §4.2 says and, as today, displayed nowhere; it is written only when the row's `archive_enabled` is 1, the conservative reading of a flag Phase 8 owns and may revisit (§15 item 10). The viewer count is one current number with no instant of its own: it was read on the call that set `last_sync_ok_at` (§2.2).
10. **YouTube's instants own the actual times when ours are NULL.** `actual_start_at` / `actual_end_at` are stamped from `actualStartTime` / `actualEndTime`, so a cron outage does not distort the record. Each is still written only when it is currently NULL, so a value a person's click wrote always stands.
11. **The committee's schedule is never touched.** `scheduled_start_at` / `scheduled_end_at` are the times devotees were promised; the job writes neither (a row cannot even be SCHEDULED without a start, `validate.php:317`, and `tests/admin-live.mjs:388` pins "only the edited columns and `updated_at` changed"). YouTube's `scheduledStartTime` / `scheduledEndTime` land in their own provider-owned columns and are shown read-only on the admin page. YouTube's schedule **never triggers a move and never shifts a boundary**; its only use is as one of the two **vetoes** in the same-broadcast check (G24). A drift *notice* is deferred (§15 item 11).
12. **The admin always wins.** A per-stream `sync_enabled` switch, a global `mode`, and three graduated switches (`auto_starting` — seeded **0**, the one inferred move and so the one that is opted into — `auto_start` and `auto_end`). A person's forward move is adopted as the job's new baseline; a person's backwards move pauses automation for that row (§6.4). A person's pause is never undone by the machine; only the machine's own pauses (G15, G22) are lifted when the committee pastes a new video id (§5.1). "Wins" includes winning a race: if the row changes while a provider call that answers is in flight, the job writes nothing but `last_synced_at` on that pass, and the next pass sees the person's move (G23). A call that fails at call level never changes a status: it writes only `sync_error`, `last_synced_at` and `next_sync_at`, and only on rows with `sync_enabled = 1` (§5.3 step 9, G13).
13. **Nothing public changes shape.** `liveShapePublic()` and `liveShapeAdmin()` are byte-identical to Phase 2, and so is every `/api/live-streams/*` and `/api/admin/live-streams` response. The server-rendered admin page already receives raw `s.*` rows through `liveSelectSql()` (`store.php:87-96`, used by `liveListAdmin()` at `:407`), so the committee sees the sync columns without a shape edit. The only new route in the phase is `/api/live-cron`. The only public values that move are `status`, `actual_start_at` and `actual_end_at`.
14. **No frontend file changes.** Not one line under `frontend/`. No new dependency anywhere — the Data API is called through the existing `notifyHttp()`.
15. **Secrets are the live module's own.** A copy of the payments encryption (sodium secretbox, `sbx1:` prefix) keyed by a **new** `LIVE_SETTINGS_KEY`, in a **new** `live_settings` table. `paySettingSave()` throws `InvalidArgumentException` on any non-payment key (`payments/config.php:335`), and rotating one module's key must never brick the other's credentials.
16. **The stand-in comes first.** `tests/support/youtube_mock.mjs` already exists and was written for this phase. A `simulator` mode plus base-URL redirection makes every path in this contract testable with **no Google account, no key and no packet leaving the machine**. **Tests never touch a row they did not create** (§10.1, §11).
17. **Times.** Every new column is UTC, written with `UTC_TIMESTAMP()` or `liveUtcNow()`. One exception: the quota day is Pacific, because Google resets the pool at midnight America/Los_Angeles.

---

## 1. Vocabulary

New constants live beside the Phase 1/2 ones in `backend/includes/live/config.php`, except where the table says otherwise.

| Constant | Where | Value / meaning |
|---|---|---|
| `LIVE_MODES` | `settings.php` | `['off', 'simulator', 'live']`. There is deliberately no separate `enabled` key: Phase 3 has no public surface, so `mode = off` is the master switch. |
| `LIVE_PROVIDER_STATES` | `config.php` | `['upcoming', 'starting', 'live', 'ended', 'not_broadcast', 'restricted', 'missing', 'revoked', 'unknown']` — the module's word for what the provider last said, stored in `live_streams.sync_state`. §6.1 is the only place this vocabulary meets YouTube's. |
| `LIVE_SYNC_ERROR_CLASSES` | `config.php` | `['transient', 'quota', 'auth', 'not_found', 'config', 'request', 'paused', 'notice']` — the first token of `live_streams.sync_error`, named by who acts: nobody (`transient` clears itself; `quota` resets at midnight Pacific), the owner (`auth`), the committee (`not_found`: the video id; `config`: the row or the video; `paused`: the machine switched this row's automation off, G15 or G22; `notice`: a row-specific condition a person should look at, §5.5, **never counted as a failure**), a developer (`request`: our code sent something Google or `liveSetStatus()` refused). |
| `LIVE_AUTO_FLOW` | `config.php` | `['SCHEDULED' => 1, 'STARTING' => 2, 'LIVE' => 3, 'COMPLETED' => 4]` — the machine's one-way order, and the rank §6.4 compares. |
| `LIVE_AUTO_TRANSITIONS` | `config.php` | `['SCHEDULED' => ['STARTING', 'LIVE'], 'STARTING' => ['LIVE'], 'LIVE' => ['COMPLETED']]` — every status change the job may make; a strict subset of `LIVE_TRANSITIONS`, checked **before** `liveSetStatus()`. |
| `LIVE_MATCH_SCHEDULE_MINUTES` | `config.php` | `20` — how far YouTube's `scheduledStartTime` may sit from the row's `scheduled_start_at`, either side, and still be this broadcast's (G24, §5.1). Twenty minutes separates programmes half an hour apart (§6.2). |
| `LIVE_MATCH_EARLY_MINUTES` | `config.php` | `60` — how long before the row's `scheduled_start_at` YouTube's `actualStartTime` may lie and still be this broadcast's; the late bound is `LIVE_UPCOMING_GRACE_HOURS` (G24, §5.1). |
| `LIVE_POLL_MIN_SECONDS` | `config.php` | `30`. The fastest per-row cadence, enforced in code however a setting is written, and the floor on a manual *Check now* for one row (§8.4). 10,000 units ÷ 86,400 s means one call every 8.64 s exhausts the whole daily pool. |
| `LIVE_YT_BATCH_MAX` | `youtube.php` | `50` ids per `videos.list` call — a prudent self-imposed ceiling, not a documented limit. |
| `LIVE_YT_MAX_CALLS` | `youtube.php` | `4` calls of each kind per run. |
| `LIVE_YT_TIMEOUT` | `youtube.php` | `12` seconds, passed to `notifyHttp()`. |
| `LIVE_YT_SCOPE` | `youtube.php` | `'https://www.googleapis.com/auth/youtube.readonly'` — the only scope ever requested, and a hard ceiling. |
| `LIVE_YT_API_BASE` | `youtube.php` | `'https://www.googleapis.com/youtube/v3'` |
| `LIVE_YT_TOKEN_URL` | `youtube.php` | `'https://oauth2.googleapis.com/token'` |
| `LIVE_YT_VIDEO_PART` | `youtube.php` | `'snippet,status,liveStreamingDetails'` — three parts cost the same 1 unit as one. |
| `LIVE_YT_BCAST_PART` | `youtube.php` | `'id,status,contentDetails'` (Tier 2). `statistics` is not an accepted part for `liveBroadcasts.list`, so OAuth never removes the need for `videos.list`. |
| `LIVE_POLL_LATE_SECONDS` | `poll.php` | `900` — the cadence of a SCHEDULED row, and of any row carrying a notice, once `now` is past `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS` (§5.5). |
| `LIVE_SYNC_BACKOFF` | `poll.php` | `[60, 300, 900, 1800, 3600]` seconds by consecutive failure, ±10 % jitter; modelled on `NOTIFY_BACKOFF` (`notify/queue.php:24`). |
| `LIVE_SYNC_GIVE_UP_ATTEMPTS` | `poll.php` | `12` consecutive **row failures**, after which the row's automation is paused (G15). |
| `LIVE_SYNC_ROW_FAILURES` | `poll.php` | `['not_found', 'restricted', 'not_broadcast', 'not_ready', 'refused', 'error']` — the outcomes that are a failure **of this row**: only they move `sync_attempts` and the per-row back-off (§5.5). In a **notice position** (§5.5) — for example `not_found` or `restricted` on a SCHEDULED or STARTING row before `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS` — the same word is a notice and not a failure. |
| `LIVE_SYNC_OUTCOMES` | `poll.php` | The closed vocabulary of `livePollStream()`, 23 words, each defined below. Anything outside it is a bug. |

**`LIVE_SYNC_OUTCOMES`, defined.** The list is closed and no two words mean the same thing. `tests/live-unit.php` section 14 pins the list. The **group** column is what §5.5 keys on.

| Outcome | Group | It means, exactly |
|---|---|---|
| `starting` | move | the job moved this row `SCHEDULED → STARTING`. |
| `live` | move | the job moved this row into `LIVE`, from `SCHEDULED` or `STARTING`. |
| `ended` | move | the job moved this row into `COMPLETED`; the two-step catch-up also reports `ended`, with `to = LIVE` and `then = COMPLETED`. |
| `unchanged` | no move | a usable answer for this row from which no move follows and no other word below applies — it agrees with the status, the grace has not passed, or the state is `unknown`. It may leave a row notice (§5.5). |
| `overridden` | no move | a person's move was honoured instead of the machine's: the row's status is **ahead** of `synced_status` and is adopted as the new baseline (§6.4 step 3), or the row changed while this pass's call was in flight (G23, which writes nothing but `last_synced_at`). |
| `paused` | pause | this row's automation is off. Either it already was (`sync_enabled = 0`, reached only by a scoped *Check now*, which records the facts and moves nothing), or this pass switched it off: a backwards human move (G8), the twelfth consecutive row failure (G15), or a stuck STARTING row (G22). |
| `held` | no move | a legal, same-broadcast move with its evidence present, forbidden by `auto_starting` / `auto_start` / `auto_end` (G12). |
| `mismatch` | no move | a move's evidence is present but `liveProviderMatchesSchedule()` is false: YouTube's own instants, or the video's channel, say the pasted video is a different broadcast (G24). Always a row notice. |
| `not_ready` | row failure | `liveSetStatus()` threw `LiveValidationException` (G9). Class `config`. |
| `refused` | row failure | `liveSetStatus()` threw `LiveTransitionException`. Unreachable by construction (G7 runs first); if it appears it is a bug. Class `request`. |
| `not_found` | row failure | YouTube did not return this id — at Tier 1 that includes a private video. `sync_state = missing`. Class `not_found`; in a notice position (§5.5), class `notice` and not a failure. |
| `restricted` | row failure | the video exists but is `private` (seen only at Tier 2), or is not embeddable (G10). Class `config`; in a notice position, class `notice` and not a failure. |
| `not_broadcast` | row failure | the id is an ordinary upload: no `liveStreamingDetails`. Class `config`; in a notice position, class `notice` and not a failure. |
| `revoked` | no move | Tier 2 only: `lifeCycleStatus = revoked`. Recorded and shown; cancelling in front of devotees is a person's decision. |
| `rate_limited` | call failure | 429, or 403 `rateLimitExceeded` / `userRateLimitExceeded`. Class `transient`. |
| `quota` | call failure | 403 `quotaExceeded` / `dailyLimitExceeded`. Class `quota`; the breaker is open until the next midnight Pacific. |
| `auth` | call failure | the API refused the credential — at Tier 2, a refused bearer only when there is no API key to fall back on — or the token endpoint answered `invalid_grant` / `invalid_client` and there is no API key to fall back on (§4.2). Class `auth`. |
| `request` | call failure | Google refused the call as malformed (§4.2). Class `request`; logged with the class, status, reason and id count only. |
| `unreachable` | call failure | `notifyHttp()` answered `status = 0`, the API answered 5xx, a 200 body was not the expected JSON, or the token endpoint failed in any other way and there is no API key to fall back on (§4.2). Class `transient`. |
| `not_configured` | not run | `canAutomate()` was false when this row was reached. Nothing is written. |
| `skipped` | not run | the row was selected but not checked: the deadline cut the loop, the quota ceiling or `LIVE_YT_MAX_CALLS` stopped the sweep, or the row no longer exists under the lock. Nothing is written. |
| `dry_run` | not run | `--dry-run`: the decision is reported in `items[]` (its would-be outcome in `would`), and nothing is written but the quota count (G18). |
| `error` | row failure | `livePollStream()`'s `catch (Throwable)` caught anything but the two named exceptions (§5.3 step 13). Class `transient`; the message is redacted into `sync_error` and logged. |

The summary **counters** are separate from the outcomes: `started` counts rows whose outcome was `live`, `ended` counts rows whose outcome was `ended`, `changed` counts every row whose status actually moved (a catch-up adds 1 to `changed`, 1 to `started` and 1 to `ended`), `errors` counts rows whose outcome is in the row-failure or call-failure group (an outcome in a notice position excepted, §5.5), and `skipped` counts `skipped` rows, or is 1 when the whole sweep did not run (§5.3 steps 1–3).

**Language.** Phase 3 adds **no public string**, so it adds no `t(ta, en)` pair: every new sentence is admin English. The existing rules still bind every file touched: design tokens only in any admin CSS, `npm run audit` stays at 0, no new dependency, no hardcoded secret, idempotent SQL with `information_schema` guards, UTC in the database, capabilities and CSRF on every admin write, nothing committed to git by the builder.

---

## 2. Migration `database/migrations/012_live_automation.sql`

Header comment names the phase and this spec, "Requires 001 to 011", "Safe to re-run", and the `mysql --default-character-set=utf8mb4` line, like every other migration. Migration 011 has no `information_schema` guards to copy from, so 012 brings the guarded-ALTER pattern itself, from `database/migrations/010_payments.sql:121-131`.

**No column may carry `ON UPDATE CURRENT_TIMESTAMP`** — `tests/admin-live.mjs:387-388` compares every column of a row before and after an admin edit and requires that only the edited columns and `updated_at` changed.

### 2.1 `live_settings` (new)

Byte-for-byte the shape of `payment_settings` (`010_payments.sql:543-550`).

```sql
CREATE TABLE IF NOT EXISTS `live_settings` (
  `k`          VARCHAR(64) NOT NULL,
  `v`          TEXT        NOT NULL COMMENT 'plain for a setting; sbx1:base64(nonce+secretbox) for a secret',
  `is_secret`  TINYINT(1)  NOT NULL DEFAULT 0,
  `updated_by` VARCHAR(60) NULL DEFAULT NULL COMMENT 'admin username',
  `updated_at` DATETIME    NOT NULL COMMENT 'UTC',
  PRIMARY KEY (`k`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Seeded with `INSERT IGNORE` — a re-run never overwrites what the committee changed — **plain rows only. No credential is ever seeded.**

| `k` | seed | meaning |
|---|---|---|
| `mode` | `off` | `off` · `simulator` · `live`. The master switch. |
| `auto_starting` | `0` | may the job write STARTING. **The only switch seeded off**: STARTING is the one move made from an *inference* ("YouTube says upcoming and the start is close"), so it is the one move that can be made about a broadcast that never ran. |
| `auto_start` | `1` | may the job write LIVE |
| `auto_end` | `1` | may the job write COMPLETED |
| `starting_lead_minutes` | `10` | the half-width of §6.2 row 1's window around the scheduled start, and of the fast cadence (§5.5) |
| `lead_minutes` | `30` | how long before the scheduled start a SCHEDULED row enters the working set |
| `stale_hours` | `6` | how long after its scheduled end a SCHEDULED row stays in the working set (the catch-up disjunct is the one exception, §5.3 step 6) |
| `catchup_hours` | `48` | the catch-up horizon: how far back a SCHEDULED row's `scheduled_start_at` may be and still keep it in the working set (§5.3 step 6). Clamped 1–168 in code and in the form |
| `complete_grace_seconds` | `120` | `actualEndTime` must be this old before COMPLETED is written |
| `poll_seconds_live` | `60` | the fast cadence (§5.5) |
| `poll_seconds_soon` | `300` | the lead-in cadence, before a SCHEDULED row reaches the fast window (§5.5) |
| `backoff_max_seconds` | `3600` | ceiling of the failure back-off |
| `daily_quota_units` | `5000` | soft ceiling; reaching it opens the quota breaker for the Pacific day (§5.3 step 8). The site never needs more than ≈2,900 (§5.6) |
| `quota_day` | *(empty)* | the Pacific date (`Y-m-d`) the counter belongs to |
| `quota_units` | `0` | units spent on `quota_day` |
| `quota_blocked_until` | *(empty)* | UTC DATETIME; while it is in the future the sweep makes no call |
| `provider_fail_streak` | `0` | consecutive **call-level** failures (§5.3 step 9). It drives the call-level back-off and is reset whenever a call answers. It never pauses a broadcast |
| `provider_notice` | *(empty)* | the one **provider-wide** sentence for the settings page: a call-level failure streak, the quota breaker, an auth refusal, or a Tier 2 fallback (§4.2, §5.3 step 9). A condition of one row never goes here; it is that row's notice (§5.5). Written only through `liveProviderNoticeSet()` (§3.1), which writes no audit row. Committee English, never raw provider text, always stored through `liveRedact()` |
| `oauth_revoked_at` | *(empty)* | UTC DATETIME set when the token endpoint answers `invalid_grant` or `invalid_client`; while set, Tier 2 is unavailable whatever the source of the OAuth credentials (§3.3) |
| `oauth_revoked_reason` | *(empty)* | `invalid_grant` or `invalid_client`: which answer set `oauth_revoked_at`. Written together with it and cleared with it (§3.3), so the settings page can say what to fix for as long as Tier 2 is off (§8.3) |
| `oauth_access_token_expires_at` | *(empty)* | UTC DATETIME |
| `youtube_client_id` | *(empty)* | plain; not a secret, but masked in the form with the rest |
| `youtube_channel_id` | *(empty)* | plain and optional. When set, a video from another channel is a `mismatch` (G24). It discovers nothing |

Secret keys (`is_secret = 1`, never seeded, rows created only by the settings page or a token refresh): `youtube_api_key`, `youtube_client_secret`, `youtube_refresh_token`, `oauth_access_token`.

### 2.2 `live_streams` — twelve guarded columns and one index

`docs/live/PHASE0-ANALYSIS.md:152` reserves five names for Phase 9's **stream-health** work: `health_status`, `last_status_check_at`, `last_successful_check_at`, `last_error` and `viewer_count`. Phase 3 takes exactly one of them, `viewer_count`, because clause 3.1 asks for "Viewer count when supported" and a second column under a second name would be worse; Phases 9 and 11 **inherit** it (§2.3). That is why the error column here is **`sync_error`, not `last_error`**, and why there is no `viewer_count_at`: the figure is only read on a usable answer, whose instant is already `last_sync_ok_at`.

Each column is added with its own guarded block. **The `AFTER` column in this table is authoritative.** The **reset** column is what `liveUpdate()` writes when the committee changes the row's provider or video id (§5.1).

| Column | Type | Default | `AFTER` | Reset on a new video | Clause |
|---|---|---|---|---|---|
| `sync_enabled` | `TINYINT(1) NOT NULL` | `1` | `status` | `1` when the machine paused the row (`sync_enabled = 0` and `sync_error` beginning `paused`); otherwise kept — a person's choice | 3.2 — hold one broadcast by hand |
| `sync_state` | `VARCHAR(20) NULL` | `NULL` | `sync_enabled` | `NULL` | 3.3 — `LIVE_PROVIDER_STATES` |
| `synced_status` | `VARCHAR(20) NULL` | `NULL` | `sync_state` | `NULL` | 3.2 — the job's baseline: the status the row was left in by the job's last committed pass (§6.4). NULL means "no baseline yet" |
| `last_synced_at` | `DATETIME NULL` | `NULL` | `synced_status` | `NULL` | 3.3 — UTC; stamped by every check that was made, a failed one included — except a failed check of a row whose `sync_enabled` is 0, which is left byte-identical (§5.3 step 9, §5.5). Only *Check now*'s floor reads it (§8.4) |
| `last_sync_ok_at` | `DATETIME NULL` | `NULL` | `last_synced_at` | `NULL` | 3.3 — UTC; advanced only when this row's own item came back as a broadcast (§5.5). **Informational only**: the admin shows it as "last good answer from YouTube", it dates `viewer_count`, and no guard, window or cadence reads it |
| `next_sync_at` | `DATETIME NULL` | `NULL` | `last_sync_ok_at` | `NULL` | 3.3 — UTC; earliest the job may ask again. NULL = due now |
| `sync_attempts` | `SMALLINT UNSIGNED NOT NULL` | `0` | `next_sync_at` | `0` | 3.3 — consecutive row failures (`LIVE_SYNC_ROW_FAILURES`) |
| `sync_error` | `VARCHAR(300) NULL` | `NULL` | `sync_attempts` | `NULL` | 3.3 — "store errors": class + committee sentence, redacted and clipped; NULL when nothing needs a person; never public |
| `provider_thumbnail_url` | `VARCHAR(500) NULL` | `NULL` | `thumbnail_url` | `NULL` | 3.1 — "Video thumbnail"; stored, read by nothing in Phase 3 |
| `provider_scheduled_start_at` | `DATETIME NULL` | `NULL` | `scheduled_end_at` | `NULL` | 3.1 — "Scheduled start": YouTube's `scheduledStartTime`, UTC; **never** copied into `scheduled_start_at` |
| `provider_scheduled_end_at` | `DATETIME NULL` | `NULL` | `provider_scheduled_start_at` | `NULL` | 3.1 — YouTube's `scheduledEndTime`, UTC, on the same terms |
| `viewer_count` | `INT UNSIGNED NULL` | `NULL` | `actual_end_at` | `NULL` | 3.1 — "Viewer count when supported"; last seen, frozen at the end; stored, read by nothing in Phase 3 |

The reset also clears the two 011 columns Phase 3 is the only writer of, `provider_stream_id` and `recording_url`, because both describe the old video.

Column comments spell the rule out, e.g. `viewer_count` → `'YouTube concurrentViewers as at last_sync_ok_at; approximate; absent means unknown, never zero; never shown in phase 3'`, `last_sync_ok_at` → `'the last answer that returned this row''s own broadcast; a failed or empty check never advances it; informational only'`, `provider_scheduled_start_at` → `'what YouTube says the start is; the committee owns scheduled_start_at; never public'`.

The guarded form, for every column:

```sql
SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME = 'sync_enabled'
);
SET @sql := IF(@col = 0,
  'ALTER TABLE `live_streams`
     ADD COLUMN `sync_enabled` TINYINT(1) NOT NULL DEFAULT 1
       COMMENT ''0 = the cron leaves this broadcast to the committee; Check now still reads it''
       AFTER `status`',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
```

and the index:

```sql
SET @idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND INDEX_NAME = 'idx_sync_due'
);
SET @sql := IF(@idx = 0,
  'ALTER TABLE `live_streams` ADD INDEX `idx_sync_due` (`sync_enabled`, `status`, `next_sync_at`)',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
```

No backfill: `next_sync_at IS NULL` already means "due now" and `sync_enabled` defaults to 1, so every published stream joins the rotation on the first pass — and does nothing until `mode` leaves `off`.

**What "joins the rotation" must not mean.** A site that has run live darshan since Phase 1 has a tail of old SCHEDULED rows nobody ever ended. The first sweep after `mode` leaves `off` meets them all. Three things together keep that tail from becoming a devotee-facing claim: `catchup_hours` bounds the catch-up disjunct (§5.3 step 6); `auto_starting` seeds `0`; and §6.2 row 1's lower bound means the inference can anticipate a start and never resurrect a past one. Without them a sweep could flip never-broadcast rows into STARTING, which is in `LIVE_LIVE_STATUSES` (`config.php:19`), so `liveListLive()` (`store.php:124-130`) and `liveFeatured()` (`store.php:146-153`) — neither time-bounded — would publish them as `is_live` (`store.php:632`) on `/live-darshan`, the homepage (`SPEC-PHASE2.md:52`) and the index route. G22 is the backstop for a STARTING row that gets stuck anyway.

### 2.3 Deliberately not here

`provider_stream_id` and `recording_url` already exist (`011_live_streams.sql:160,162`); Phase 3 gives them a write path, not a column. `health_status`, `last_status_check_at`, `last_successful_check_at` and `last_error` are Phase 9's. `live_stream_subscriptions` is Phase 6's; `live_stream_events` / `live_stream_stats` are Phase 11/15's. Migration numbers 013+ stay free for them. Phases 9 and 11 inherit `viewer_count` as one current figure with no instant of its own; a time series is Phase 11's to design in its own table.

### 2.4 A partially upgraded database

`liveTablesExist()` (`config.php:98-117`) probes only 011's tables and answers **true** on a database with 011 but not 012. A second probe sits beside it, with the same per-request cache:

```php
/**
 * True when migration 012 is applied: live_settings answers and live_streams
 * has every one of the twelve 012 columns. Cached per request; $refresh re-probes.
 */
function liveAutomationInstalled(bool $refresh = false): bool
```

implemented with `SELECT 1 FROM live_settings LIMIT 0` and one `SELECT` naming **all twelve** §2.2 columns `FROM live_streams LIMIT 0` — 012 is a series of separate ALTERs, so a half-applied run must fail the probe — logging `'[live] automation tables unavailable (apply database/migrations/012_live_automation.sql)'`. **Every Phase 3 entry point checks it first**: `bin/live_cron.php` prints the sentence and exits **0**, `/api/live-cron` answers `503 {'code' => 'live_not_installed'}`, `admin/live_settings.php` renders a "not installed yet" page in the shape `admin/live_streams.php` uses at `:227-229`, and `admin/live_streams.php` hides the Sync column and passes `false` to `liveAdminSyncActions()` (§8.4), so the new row-menu items are not offered. Nothing fatals, and Phases 1 and 2 are untouched.

---

## 3. Credentials and settings

### 3.1 `backend/includes/live/settings.php` (new)

A copy of `backend/includes/payments/config.php:215-380`, never a shared dependency: `paySettingSave()` throws for any key outside the payment vocabulary (`config.php:335`), and `docs/live/PHASE0-ANALYSIS.md:102` already rules the encryption a copy.

```php
const LIVE_MODES = ['off', 'simulator', 'live'];

/** k => seed, exactly the plain rows migration 012 seeds (§2.1). */
const LIVE_SETTING_DEFAULTS = [ /* … */ ];

/** Setting keys stored encrypted. */
const LIVE_SECRET_KEYS = ['youtube_api_key', 'youtube_client_secret', 'youtube_refresh_token', 'oauth_access_token'];

/** The credentials the settings page edits, in form order. */
const LIVE_CREDENTIAL_FIELDS = ['api_key', 'client_id', 'client_secret', 'refresh_token', 'channel_id'];
const LIVE_CREDENTIAL_ENV = [
    'api_key'       => 'YOUTUBE_API_KEY',
    'client_id'     => 'YOUTUBE_CLIENT_ID',
    'client_secret' => 'YOUTUBE_CLIENT_SECRET',
    'refresh_token' => 'YOUTUBE_REFRESH_TOKEN',
    'channel_id'    => 'YOUTUBE_CHANNEL_ID',
];
const LIVE_CREDENTIAL_SETTING = [
    'api_key'       => 'youtube_api_key',
    'client_id'     => 'youtube_client_id',
    'client_secret' => 'youtube_client_secret',
    'refresh_token' => 'youtube_refresh_token',
    'channel_id'    => 'youtube_channel_id',
];

function liveSimulatorAllowed(): bool;                     // envValue('LIVE_ALLOW_SIMULATOR') === '1' — the one fence of §10.1
function liveSettingsRows(bool $refresh = false): array;   // k => ['v','is_secret','updated_by','updated_at']; [] when not installed
function liveSettingsAll(): array;                         // plain settings only, defaults merged, overlay applied (§10.3)
function liveSetting(string $key, string $default = ''): string;
function liveSettingsKey(): ?string;                       // 32 bytes from LIVE_SETTINGS_KEY, else null (also null without sodium)
function liveSecretEncrypt(string $plain): string;         // 'sbx1:' . base64(nonce ‖ secretbox); RuntimeException naming LIVE_SETTINGS_KEY
function liveSecretDecrypt(string $stored): ?string;       // null for wrong prefix, missing key, truncated, failed open
function liveStoredSecret(string $key): ?string;           // logs '[live] stored credential could not be decrypted' once per request
function liveCredential(string $field): string;            // env wins, then the stored row, else ''
function liveCredentialStatus(): array;                    // field => ['source' => 'env'|'stored'|'unreadable'|'none', 'env' => VAR, 'setting' => key, 'last4' => ?string]
function liveSettingSave(PDO $db, string $key, ?string $value, string $actor): void;  // InvalidArgumentException on an unknown key
function liveSettingsSaveMany(PDO $db, array $changes, string $actor): array;         // one liveTransaction(); returns the changed key NAMES
function liveConfigReset(): void;                          // clears the per-request caches; never writes or deletes a row
function liveAutomationConfig(): array;                    // every setting clamped to its range, as typed values, plus 'tier', 'mode' and 'channel_id'
function liveAutomationTier(): int;                        // 0 | 1 | 2
function liveAutomationReady(): array;                     // array{ok: bool, reason: string, tier: int} — the shape of payReady()
function liveRedact(string $text, int $max = 280): string; // never throws
function livePacificDay(): string;                         // 'Y-m-d' in America/Los_Angeles
function liveQuotaResetAtUtc(): string;                    // next midnight PT as a UTC 'Y-m-d H:i:s'
function liveQuotaBlockedUntil(): ?string;                 // UTC DATETIME while blocked, else null
function liveQuotaBlock(PDO $db, string $reason): void;    // quota_blocked_until = liveQuotaResetAtUtc(); logs once
function liveQuotaSpend(PDO $db, int $units): bool;        // rolls quota_day at the PT boundary; at daily_quota_units calls liveQuotaBlock() and answers false

/**
 * Record what the last whole call did, and answer the streak that follows.
 * $class null means "the call answered": the streak goes to 0 and
 * provider_notice becomes $notice — the run's standing Tier 2 sentence
 * (§4.2), or '' to clear it. Otherwise the streak is incremented and, when it
 * changes from 0 to 1 or the class changes, $notice is written once.
 * $notice is a sentence from liveProviderConnectionMessage()'s vocabulary.
 * Every notice write goes through liveProviderNoticeSet().
 * Never touches a live_streams row. §5.3 step 9.
 */
function liveProviderFailStreak(PDO $db, ?string $class, string $notice = ''): int;

/**
 * The only writer of provider_notice: stores liveRedact($text), or '' for
 * null, with updated_by NULL. Writes no audit row: liveSettingsSaveMany()
 * stays the admin save path and keeps its audit, and a per-sweep audit row
 * is forbidden (§6.5). The redaction is never skipped: at Tier 1 the
 * credential travels as key=<api key>, and a Google error body can quote
 * that URL. Its callers skip it in a dry run (G18).
 */
function liveProviderNoticeSet(PDO $db, ?string $text): void;

/**
 * The one eligibility predicate for every bulk statement over sync rows
 * (G2, G3): [SQL over the table alias `s`, its params]. The SQL is
 *   s.deleted_at IS NULL AND s.provider = 'youtube'
 *   AND s.provider_broadcast_id IS NOT NULL AND s.provider_broadcast_id <> ''
 *   AND s.status IN ('SCHEDULED','STARTING','LIVE')
 * plus, when liveSimulatorAllowed() and envValue('LIVE_SYNC_ONLY_TITLE_PREFIX')
 * is non-empty, " AND s.title_en LIKE :sync_prefix" bound to that value,
 * %/_-escaped, plus '%' (§10.1). sync_enabled is deliberately not in it: a
 * scoped run reads a paused row (G4), so the unscoped working set adds that
 * clause itself (§5.3 step 6). No statement spells its own copy of this.
 */
function liveSyncEligibleWhere(): array;
```

- **Algorithm**: `sodium_crypto_secretbox` (XSalsa20-Poly1305), a fresh 24-byte nonce, stored as `'sbx1:' . base64(nonce ‖ ciphertext)`. A value that fails to decrypt counts as **absent** and is logged once per request. `last4` (`mb_substr($plain, -4)`) is the only fragment of a secret that ever leaves this file.
- **Three sources, one rule**: an environment variable always wins and its field is read-only in the admin; then the stored row; then the built-in default (plain settings only).
- **`liveAutomationTier()`**: 2 when `client_id`, `client_secret` and `refresh_token` are all present **and `oauth_revoked_at` is empty**; else 1 when `api_key` is present; otherwise 0.
- **`liveAutomationReady()['ok']`** is true only when `liveTablesExist()`, `liveAutomationInstalled()`, `mode !== 'off'`, the tier is ≥ 1 (waived in `simulator` mode), `function_exists('curl_init')` and the quota breaker is closed. Its `reason` is a sentence a committee member can act on: *"YouTube automation is switched off — turn it on in Admin → YouTube Automation."*, *"No YouTube API key is set."*, *"Apply database migration 012_live_automation.sql."*, *"The day's YouTube quota is used up; it resets at midnight US Pacific time."*
- **`liveSettingsSaveMany()`** is the one admin save path; the job's own writes to operational rows (quota, streak, notice, bearer, revocation) go through the functions above and never audit. In its transaction, when any credential key changes, it also: deletes `oauth_access_token` and blanks `oauth_access_token_expires_at`, in every mode, so a rotated secret cannot keep working from a cached bearer; clears `oauth_revoked_at` and `oauth_revoked_reason` when `client_id`, `client_secret` or `refresh_token` changed; runs `UPDATE live_streams s SET s.next_sync_at = NULL WHERE {$where}` with `[$where, $params] = liveSyncEligibleWhere()`, so automation resumes on the next run instead of sitting out a back-off earned by the old credential, and a suite's save touches only that suite's rows; and calls `liveProviderFailStreak($db, null)`. It then calls `liveConfigReset()`.
- **`liveSyncEligibleWhere()` is the only statement of eligibility.** The working set (§5.3 step 6), the credential-save reset above, the **Reconnect** reset (§8.3) and any later bulk statement over sync rows all build on it; a builder who writes the predicate out by hand has a review finding.
- **The cached bearer** is stored encrypted in `oauth_access_token`, with its expiry in `oauth_access_token_expires_at`, and re-read from the database at the start of every run — **in every mode, exactly as in production, the simulator and `LIVE_SETTINGS_OVERLAY` (§10.3) included**, so the suites exercise the production credential path. That is safe because every suite that can write `live_settings` snapshots it at its start and restores it in its final `finally` (§11), and `liveConfigReset()` still writes and deletes nothing. The one exception is a dry run (G18): a bearer it refreshes is held in memory only, and the row is neither written nor deleted.
- **`liveRedact()`** runs `notifyRedact()` (`notify/contracts.php:212`) first, then removes every configured credential value verbatim and any `key=…` query parameter, then clips. The credential values are read once per request inside a `try`; if reading them fails (it is often called while handling a database error) it falls back to `notifyRedact()` plus the `key=` rule, so **it never throws**. `notifyRedact()` is not edited: it already catches `refresh_token` through the substring `token`, and the docblock says so.
- **`YouTubeProvider::isConfigured()` is not touched.** It returns `true` and means *"may be chosen for a stream"*: `backend/admin/live_streams.php:420-421` disables the provider `<option>` when it is false and `tests/live-unit.php:240` pins it true. Credential presence is `liveAutomationTier()` and `canAutomate()`.

### 3.2 Environment — `backend/.env.example`

Replace the `── Live darshan (YouTube Live) ──` block (`.env.example:116-123`) with the real block, each key blank, each generator inline, the test-only ones marked in the style of `.env.example:84,95`:

```
# ── Live darshan (YouTube Live) ──────────────────────────────────────────────
# docs/live/SPEC-PHASE1.md, SPEC-PHASE2.md, SPEC-PHASE3.md. Apply
# database/migrations/011_live_streams.sql and 012_live_automation.sql.
# Phases 1-2 need no keys: the committee pastes each broadcast's YouTube video
# id in Admin -> Live Streaming. Phase 3 lets a scheduled job follow YouTube
# instead. Everything below is optional; with none of it set nothing polls and
# the status buttons stay the only way a broadcast changes state.
#
# The zone new streams are scheduled in (default NOTIFY_TEMPLE_TZ, else Asia/Kolkata).
LIVE_TEMPLE_TZ=
# Base64 of 32 random bytes; without it the admin cannot store a YouTube
# credential and the variables below are the only source.
#   php -r "echo base64_encode(random_bytes(32));"
LIVE_SETTINGS_KEY=
# The scheduled job's HTTP trigger; /api/live-cron answers 404 until this is at
# least 24 characters.
#   php -r "echo bin2hex(random_bytes(24));"
LIVE_CRON_KEY=
# Credentials. A variable set here always wins and its field is read-only in
# the admin. YOUTUBE_API_KEY alone is enough for the whole of Phase 3; the
# OAuth trio is optional and only adds owner-only broadcast detail.
YOUTUBE_API_KEY=
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REFRESH_TOKEN=
YOUTUBE_CHANNEL_ID=
# Development and automated tests only - never set these in production.
# LIVE_ALLOW_SIMULATOR=1 allows everything below it; without it all of them
# are ignored.
LIVE_ALLOW_SIMULATOR=
YOUTUBE_API_BASE_URL=
YOUTUBE_OAUTH_TOKEN_URL=
LIVE_SETTINGS_OVERLAY=
LIVE_SYNC_ONLY_TITLE_PREFIX=
LIVE_SIM_FAIL_AFTER_LIVE=
```

and add to the `── Scheduled work ──` block (`.env.example:104-114`) the third crontab line `*    * * * *     /usr/bin/php /path/to/bin/live_cron.php` and `GET /api/live-cron` in the list of HTTP endpoints.

### 3.3 Rotation, disconnection and revocation

- **A save is a rotation.** A new value replaces the row and `updated_by` / `updated_at` record who and when; `liveSettingsSaveMany()` does the rest (§3.1).
- **Refresh-token rotation.** Google normally returns no `refresh_token` on a refresh; if one arrives it replaces the stored row in the same transaction and is audited as `live_provider_token_rotated`, naming no value. That and the cached bearer are the only automatic writes to a secret row.
- **Disconnect YouTube.** One owner-only, confirmed action deletes the four secret rows, blanks `oauth_access_token_expires_at`, sets `mode = off`, and writes one `live_provider_disconnected` audit row naming the keys removed. It never changes a stream's status.
- **A refused OAuth credential is switched off, once.** Two token answers are terminal, each with its own sentence: `invalid_grant` — *"The refresh token is no longer valid; reconnect the channel."* — and `invalid_client` — *"Google no longer accepts the saved OAuth client (its secret was rotated or the client was deleted); save the current client id and secret."* On either, the job sets `oauth_revoked_at = UTC_TIMESTAMP()` and, in the same write, `oauth_revoked_reason` to the code (`invalid_grant` or `invalid_client`), deletes the cached bearer, writes the sentence through `liveProviderNoticeSet()`, and writes one `live_provider_revoked` audit row whose detail names the error code. `provider_notice` is cleared by the next answered call (§5.3 step 9), so it is `oauth_revoked_reason` that keeps the owner told what to fix: the §8.3 status card shows that code's sentence for as long as the flag is set. The same run carries on at Tier 1 when an API key is configured (§4.2). **While `oauth_revoked_at` is set, `liveAutomationTier()` treats Tier 2 as unavailable whether the trio comes from the environment or the database**, so the next run is Tier 1 (or Tier 0, which `liveAutomationReady()` already stops) and never asks the token endpoint again. Nothing is deleted and `mode` is not changed. The flag and its reason are cleared together, only by saving any OAuth credential (§3.1) or by the owner's **Reconnect** action (§8.3); after either, the next run tries the token once more, and a second refusal sets them again with one more audit row. **Every other token failure is transient and never sets the flag** (§4.2). **Nor does a bearer the API refuses** — a 401 on the retry after the forced refresh, or a 403 that §4.2's table classes `auth`, from `videos.list` or `liveBroadcasts.list`: the credential may be fine and the Google Cloud project set up wrong, so with an API key the run finishes on the key at Tier 1 with its own provider notice, and without one it is a call-level `auth` failure (§4.2).
- **The blank field keeps what is stored.** A "Remove" tick clears it. An env-supplied credential is never stored at all.

---

## 4. The provider seam and the YouTube client

### 4.1 `backend/includes/live/providers.php` — one new method, one widened contract

The interface gains `canAutomate()` and `fetchStatus()`'s docblock gains the real shape. Nothing else in the file changes.

```php
    /**
     * True when this provider can be asked what a broadcast is doing: the mode
     * allows a call and the credentials are on file. Separate from
     * isConfigured(), which means "may be chosen for a stream" and gates
     * LIVE_SAVABLE_PROVIDERS — redefining that one would start refusing
     * YouTube streams on every site with no Google account.
     */
    public function canAutomate(): bool;

    /**
     * Phase 3: ask the provider what the broadcast is doing. Never throws,
     * never more than one HTTP round trip per sweep, and answers exactly
     * ['ok' => false, 'error' => 'not configured'] whenever canAutomate() is
     * false — which is every provider but YouTube, and YouTube itself until an
     * owner configures it.
     *
     * @return array{
     *   ok: bool,
     *   state: string,               // LIVE_PROVIDER_STATES
     *   raw_state: ?string,          // snippet.liveBroadcastContent as received
     *   lifecycle: ?string,          // Tier 2: status.lifeCycleStatus
     *   scheduled_start: ?string,    // UTC 'Y-m-d H:i:s'; stored in provider_scheduled_start_at only
     *   scheduled_end: ?string,      // UTC; stored in provider_scheduled_end_at only
     *   actual_start: ?string,
     *   actual_end: ?string,
     *   privacy: ?string,            // public | unlisted | private
     *   embeddable: ?bool,
     *   viewers: ?int,               // absent means unknown, never zero
     *   thumbnail: ?string,          // the best address YouTube reports, via liveSafeUrl(); stored only
     *   recording_status: ?string,   // Tier 2: notRecording | recording | recorded
     *   provider_stream_id: ?string, // Tier 2: contentDetails.boundStreamId
     *   channel_id: ?string,         // snippet.channelId
     *   channel_expected: ?string,   // the youtube_channel_id setting when set, else null (G24)
     *   checked_at: string,          // UTC 'Y-m-d H:i:s'
     *   error: ?string,
     *   class: ?string,              // LIVE_SYNC_ERROR_CLASSES
     *   retry_after: ?int,
     * }
     */
    public function fetchStatus(array $stream): array;
```

- `VimeoProvider`, `AwsIvsProvider` and `UnavailableProvider` each gain `public function canAutomate(): bool { return false; }` and keep `fetchStatus()` returning the exact literal `['ok' => false, 'error' => 'not configured']` (`providers.php:169, :205, :252`), which `tests/live-unit.php:317` pins.
- `YouTubeProvider::canAutomate(): bool { return liveAutomationReady()['ok']; }`
- `YouTubeProvider::fetchStatus(array $stream): array` returns the **same exact literal** when `canAutomate()` is false, so `tests/live-unit.php:309-310` stays green **unedited** — which is why §11.2 runs that section under a `mode = off` overlay. Otherwise it delegates to `liveYoutubeFetchMany([$stream])` and returns the one answer.
- **`YouTubeProvider::thumbnailUrl()` is not touched.** It still answers the admin's `thumbnail_url`, else `liveYoutubeThumbnailUrl($id)`, exactly as `tests/live-unit.php:306-308` pins. `provider_thumbnail_url` is read by nothing in Phase 3 (§0.2 #9).

### 4.2 `backend/includes/live/youtube.php` (new) — the Data API client

The only file in the module that speaks HTTP to Google. Every call goes through `notifyHttp(string $method, string $url, array $headers = [], string|array|null $body = null, int $timeoutSeconds = 15): array` (`notify/contracts.php:235`), which `backend/includes/live.php:20` already loads and which **never throws**: `status = 0` plus a free-text `error` covers DNS, TLS and timeout alike, so the admin sentence stays generic ("Could not reach YouTube").

```php
function liveYoutubeApiBase(): string;      // LIVE_YT_API_BASE, or YOUTUBE_API_BASE_URL when §10.1 allows it
function liveYoutubeTokenUrl(): string;     // LIVE_YT_TOKEN_URL, or YOUTUBE_OAUTH_TOKEN_URL when §10.1 allows it

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
 * @param array<int, array> $streams  live_streams rows, keyed by id
 * @param bool $dryRun  a refreshed bearer is held in memory only, and a
 *                      token refusal is reported, not recorded (G18)
 * @return array{answers: array<int, array>, calls: int, units: int, class: ?string, error: ?string, outcome: ?string, retry_after: ?int, notice: string}
 */
function liveYoutubeFetchMany(array $streams, bool $dryRun = false): array;

/**
 * A usable bearer for Tier 2, or null. class is 'auth' only for
 * invalid_grant / invalid_client (the refusal of §3.3, `revoked` true) and
 * 'transient' for every other failure.
 * @return array{ok: bool, token: ?string, error: string, class: string, revoked: bool}
 */
function liveYoutubeAccessToken(PDO $db, bool $force = false, bool $dryRun = false): array;

/** One videos.list item (+ optional liveBroadcasts item) -> the §4.1 fact array. */
function liveYoutubeFacts(array $video, ?array $broadcast = null): array;

/** The fact array for an id the response did not carry. */
function liveYoutubeMissingFact(): array;

/** (HTTP status, Google's envelope) -> [class, outcome, message], by the table below; $token selects its token-endpoint rows. */
function liveYoutubeClassify(int $status, array $headers, string $body, bool $token = false): array;

/** Delta-seconds or an HTTP-date Retry-After, clamped to [1, 86400]; null when absent or unparseable. */
function liveRetryAfterSeconds(array $headers): ?int;

/** RFC 3339 (with or without fractional seconds, with an offset or Z) -> UTC 'Y-m-d H:i:s', or null. */
function liveYoutubeInstant(mixed $iso): ?string;

/**
 * The in-process stand-in (§10.2). Returns the notifyHttp() shape; no socket
 * is opened. $headers is passed so a bearer request is told from a key= one
 * (the PRIV scenario answers them differently).
 */
function liveYoutubeSimulate(string $method, string $url, array $headers, array $query, array $body): array;
```

`liveRetryAfterSeconds()` is a **copy of the body** of `NotifyProviderSupport::retryAfter()` (`backend/includes/notify/providers/NotifyProviderSupport.php:24`), not a call. The call would work — `contracts.php:317-321` autoloads `Notify*` classes and `live.php:20` requires `contracts.php` — but the live module deliberately depends on exactly two notification pieces, the HTTP client and the clock (`live.php:20-21`), and not on the provider layer, so a refactor of the notification providers can never silently change the poller's back-off. The docblock says this.

**The calls.**

- `GET {base}/videos?part=snippet,status,liveStreamingDetails&id=<comma-joined ids>` — 1 unit. Credential: `key=<api key>` in the query at Tier 1 (the Data API requires it there), and for the rest of a Tier 2 run that could not get a bearer (below); `Authorization: Bearer <token>` otherwise at Tier 2. **The API key never travels in a header and is never logged.**
- `GET {base}/liveBroadcasts?part=id,status,contentDetails&id=<the same ids>&maxResults=50` — 1 unit, Tier 2 only, bearer only.
- **`search.list` is never called** — not by the job, not by *Check now*, not by the connection test. A grep for `search.list` or `/search?` under `backend/includes/live/` must find nothing, and the unit suite asserts it.

**Reading the answer.** A response shorter than the request is how a missing id is reported: the client diffs the requested ids against `items[].id` and marks each omission `missing`; the diff is authoritative. `idx_provider_ref` is **not** unique (`011_live_streams.sql:189`), so one item is fanned out to **every** row carrying that id — and each of those rows then passes its own same-broadcast check (G24), because the rows share a video, not a schedule.

Fields read per item: `snippet.liveBroadcastContent`, `snippet.channelId`, `snippet.thumbnails` (best of `maxres`, `standard`, `high`, `medium`, `default`, through `liveSafeUrl()`), `status.privacyStatus`, `status.embeddable`, `liveStreamingDetails.{scheduledStartTime, scheduledEndTime, actualStartTime, actualEndTime, concurrentViewers}`. `activeLiveChatId` is not read. From `liveBroadcasts.list`: `status.lifeCycleStatus`, `status.recordingStatus`, `contentDetails.boundStreamId`. Every fact also carries `channel_expected` = `liveCredential('channel_id')` (or null when blank), so the pure G24 check needs nothing but the row and the fact.

**Recording URL.** There is no `recordingUrl` field in the API: a `liveBroadcast` and its `video` share one id, so the archive lives at the address `liveYoutubeWatchUrl($id)` (`providers.php:81-84`) builds. `live_streams.recording_url` is written **once, in the same transaction as the machine's move to COMPLETED**, when it is currently NULL, the row's `archive_enabled` is 1 (`011_live_streams.sql:176`) and — at Tier 2 only — `recording_status === 'recorded'`. (The video is `public` or `unlisted` by then, because every move requires it, G10.) Otherwise it stays NULL. Honouring `archive_enabled` is the conservative reading of a flag Phase 8 owns — do not store what the row says not to keep — and Phase 8 may change it to a display-time condition by changing this one condition (§15 item 10). Nothing surfaces the column: `recording_url` is absent from both shapes and pinned out of every public body by `tests/live-api.mjs:77,425,828` and `tests/live-unit.php:833`.

**OAuth refresh.** `POST {tokenUrl}` with `['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => 'application/json']` and the array body `['client_id' => …, 'client_secret' => …, 'refresh_token' => …, 'grant_type' => 'refresh_token']`. `notifyHttp()` form-encodes an array body (`contracts.php:257-259`) but adds no content type, so the header is set explicitly, as `ccavApi()` does at `payments/ccavenue.php:264`. The access token is stored as §3.1 says, with `oauth_access_token_expires_at = now + expires_in - 300 s` — **never a hardcoded 3600**.

**Error classification** keys on **(HTTP status, `error.errors[0].reason`) together**, first matching row wins. The message text is read in exactly one row. The **scope** says whether the observation is about one broadcast or about the call; §5.3 step 9 turns that into who pays for it.

| HTTP status | reason | class | scope | outcome |
|---|---|---|---|---|
| 200, expected JSON | — | — | — | per-row processing (§6) |
| 200, body not the expected JSON | — | `transient` | call | `unreachable` |
| 0 (curl absent, DNS, TLS, timeout) | — | `transient` | call | `unreachable` |
| 500–599 | any, or no JSON body (the stand-in's 500 is plain text) | `transient` | call | `unreachable`; `Retry-After` honoured when longer |
| 429 | any | `transient` | call | `rate_limited`; `Retry-After` honoured |
| 403 | `rateLimitExceeded`, `userRateLimitExceeded` | `transient` | call | `rate_limited` |
| 403 | `quotaExceeded`, `dailyLimitExceeded` | `quota` | call | `quota` — `liveQuotaBlock()` until the next midnight America/Los_Angeles; **no retry** |
| 400 | `keyInvalid`; or `badRequest` whose `error.message` begins `API key` (Google's "API key not valid. Please pass a valid API key." and "API key expired…" — the stand-in answers the first, `youtube_mock.mjs:159-160`) | `auth` | call | `auth` |
| 401 | any (`authError`, `unauthorized`, …) | `auth` | call | `auth` — at Tier 2, exactly one forced token refresh and one retry of that call first; if the refresh fails, the token rows below decide, and a fallback sends that one retry with `key=`. If the retry's bearer is refused again and an API key is configured, the run finishes on the key at Tier 1 (below): **no `auth`, no `oauth_revoked_at`** |
| 403 | any other reason (`forbidden`, `insufficientPermissions`, `accessNotConfigured`, `ipRefererBlocked`, `keyInvalid`, …) | `auth` | call | `auth` — except that at Tier 2 a refused **bearer** request, with an API key configured, finishes the run on the key at Tier 1 (below): **no `auth`, no `oauth_revoked_at`** |
| 404 | `videoNotFound` | `not_found` | row | `not_found` for every id of that call — handled as a 200 with no items |
| 400 | any other (`badRequest`, `invalidParameter`, `missingRequiredParameter`, `incompatibleParameters`, …) | `request` | call | `request` — never retried |
| any other 4xx | any | `request` | call | `request` — never retried |
| token endpoint | `invalid_grant` | `auth` | call | §3.3's refusal, sentence *"The refresh token is no longer valid…"*; then Tier 1 for this run with an API key, else `auth` |
| token endpoint | `invalid_client` (the stand-in's 401 for a wrong secret, `youtube_mock.mjs:182-183`) | `auth` | call | §3.3's refusal, sentence *"Google no longer accepts the saved OAuth client…"*; then Tier 1 for this run with an API key, else `auth` |
| token endpoint | anything else — `status = 0`, a timeout, 429, 5xx, a body that is not the expected JSON or carries no `access_token`, any other error code | `transient` | call | **never `auth`, never the flag.** With an API key: this run falls back to Tier 1 and leaves the provider notice *"Google sign-in failed; using the API key for now."* Without one: `unreachable` |

**Tier 2 never stops Tier 1.** When a run cannot get a bearer, it sends `videos.list` with `key=` for the rest of the run and skips `liveBroadcasts.list`. **When the API refuses the bearer** — `videos.list` or `liveBroadcasts.list` answers 401 on the retry after the forced refresh, or a 403 this table classes `auth` — and an API key is configured, the run finishes on the API key at Tier 1: a refused `videos.list` is sent once more with `key=` (counted through `liveQuotaSpend()`), the rest of the run uses `key=` and skips `liveBroadcasts.list`, and the answered call leaves the provider notice *"YouTube refused the Google sign-in for this project; using the API key for now."* This does **not** set `oauth_revoked_at`: the credential may be fine and the project setup wrong (an OAuth client created in a Google Cloud project where the YouTube Data API is not enabled, for example). When `videos.list` answered and `liveBroadcasts.list` then fails for any other reason, the chunk is processed on its `videos.list` facts alone (no `lifecycle`, `recording_status` or `provider_stream_id`) and the answered call leaves the provider notice *"YouTube's owner-only broadcast details could not be read; using public video data for now."* None of these cases moves the fail streak or any row's `sync_attempts`. Only with no API key does a token failure or a refused bearer become a call-level failure of the chunk (§5.3 step 9).

A `request` answer is logged once per call as `'[live] YouTube refused the request: ' . liveRedact("$status $reason, $n ids")` — the class, status, reason and id count, **never the URL, the query or the body**.

**There is no in-process retry loop** anywhere, with the two exceptions above: the one forced token refresh, and the one `key=` resend of a `videos.list` whose bearer was refused. Retry is row state plus a later run, exactly as the payments cron and the notification worker do it; there is no `sleep()` in this module.

### 4.3 Loader

`backend/includes/live.php:23` ends the phase as:

```php
foreach (['config', 'time', 'settings', 'validate', 'media', 'providers', 'youtube', 'store', 'poll', 'admin'] as $liveModule) {
```

**but no builder writes that line in one edit.** `:24` is a bare `require_once`, so a name whose file does not exist yet is a fatal error on every request that loads the module (`/api/live-streams/*` via `api/index.php:115`, `/admin/live-streams` via `:117`, `backend/admin/live_streams.php:20`, `tests/support/live_fixtures.php`). §13's steps are sequential, so **each workstream adds its own module name in the same change as the file that name loads**:

| Step | Adds to the list | In the same change as |
|---|---|---|
| 1 | `'settings'`, after `'time'` | `backend/includes/live/settings.php` |
| 2 | `'youtube'`, after `'providers'` | `backend/includes/live/youtube.php` |
| 3 | `'poll'`, after `'store'` | `backend/includes/live/poll.php` |

A builder who finds a name already present leaves it alone and says so in its report.

---

## 5. The scheduled job

### 5.1 `backend/includes/live/poll.php` (new), and the `store.php` changes

```php
/**
 * One run, under the MySQL advisory lock. getDB() is called exactly once
 * because GET_LOCK is per connection.
 *
 * @param array{limit?:int, max_seconds?:int, stream_ids?:?array, dry_run?:bool,
 *              trigger?:string, actor?:string} $opts
 * @return array{checked:int, changed:int, started:int, ended:int, errors:int,
 *               skipped:int, calls:int, units:int, locked:bool,
 *               duration_ms:int, items:array}
 */
function liveCronRun(array $opts = []): array;

/** The batch, §5.3. @return the same array without locked/duration_ms. */
function livePollSweep(PDO $db, array $opts = []): array;

/**
 * Pure, G24: is this fact about this row's broadcast? True only when all hold,
 * with S = $row['scheduled_start_at']:
 *  (a) $facts['scheduled_start'], if present, lies in
 *      [S - LIVE_MATCH_SCHEDULE_MINUTES, S + LIVE_MATCH_SCHEDULE_MINUTES];
 *  (b) $facts['actual_start'], if present, lies in
 *      [S - LIVE_MATCH_EARLY_MINUTES, S + LIVE_UPCOMING_GRACE_HOURS];
 *  (c) $facts['channel_expected'], if non-empty, equals $facts['channel_id'];
 *  (d) $facts['actual_end'], if present, is at or after S: a broadcast that
 *      ended before this row's slot began is not this row's broadcast.
 * Bounds are inclusive. A row with no scheduled_start_at never matches.
 * A temple runs several broadcasts a day, so the 06:30 morning video pasted
 * into the 18:00 row fails (a), (b) and (d) separately, and the 06:00
 * suprabhatam (actual 05:58-06:25) pasted into the 06:30 abhishekam row
 * fails (a) and (d) separately.
 */
function liveProviderMatchesSchedule(array $row, array $facts): bool;

/**
 * Pure: what this fact means for this row — §6.4's order, then §6.2's moves,
 * then G22 and the notice positions (§5.5). No database, no clock beyond $now.
 * pause is null, 'person' (G8) or 'machine' (G22); notice is the N1–N5
 * sentence when the row is in a notice position, else null.
 * @return array{to: ?string, at: ?string, then: ?string, then_at: ?string,
 *               outcome: string, pause: ?string, reason: string, notice: ?string}
 */
function livePollDecide(array $row, array $fact, array $cfg, string $now): array;

/**
 * One row: lock, compare, decide, apply, record. **Never throws.**
 *
 * $row is the snapshot loaded before the remote call. Inside one
 * liveTransaction() the row is re-read with liveLoad($db, $id, true, true)
 * (FOR UPDATE, deleted rows included):
 *  - null (the row is gone): nothing is written; outcome `skipped`;
 *  - any of status, synced_status, sync_enabled, provider,
 *    provider_broadcast_id or deleted_at differs from the snapshot: the move is
 *    abandoned and only last_synced_at is written; outcome `overridden` (G23);
 *  - otherwise livePollDecide() runs once, against the locked row, and its
 *    result is applied and recorded in that same transaction (§5.5).
 * A dry run takes no lock and writes nothing: it decides against the snapshot
 * and reports (G18).
 *
 * @return array{outcome:string, would:?string, changed:bool, from:string, to:?string, state:?string, error:?string}
 */
function livePollStream(PDO $db, array $row, array $fact, array $cfg, string $actor, bool $dryRun = false): array;

/**
 * The one call site of every status move the poller makes, the catch-up's
 * two steps included. $row carries the status the step starts from (for the
 * catch-up's second step, LIVE). Checks G7 against LIVE_AUTO_TRANSITIONS, then
 * calls liveSetStatus($db, id, $to, actor, $at). Throws what liveSetStatus()
 * throws; never catches.
 *
 * Its first statement is the fenced test door of §10.1: when
 * liveSimulatorAllowed(), $to === 'COMPLETED' and (string) $row['id'] equals
 * envValue('LIVE_SIM_FAIL_AFTER_LIVE'), it throws
 * RuntimeException('simulated failure after LIVE'). The exception therefore
 * starts inside the second step's own call, exactly where a real failure of
 * that step would, so a try/catch wrapped around the call would swallow it.
 */
function livePollApplyMove(PDO $db, array $row, string $to, ?string $at): void;

/** Seconds until the next check after the $failures-th consecutive failure. */
function liveBackoffSeconds(int $failures, ?int $retryAfter = null): int;

/**
 * The next_sync_at an outcome writes, by §5.5's table: a UTC 'Y-m-d H:i:s',
 * or null for a row that has left the working set. $row is the row as the pass
 * leaves it; $failures is the new sync_attempts for a row failure, or the
 * streak for a call failure. The `quota` row returns liveQuotaBlockedUntil().
 */
function liveSyncNextAt(array $row, string $outcome, array $cfg, string $now, int $failures = 0, ?int $retryAfter = null): ?string;
```

and in `backend/includes/live/store.php`:

```php
/** The ids due for a check, §5.3 step 6, built on liveSyncEligibleWhere(). Only ids; each row is re-loaded with liveLoad(). */
function liveListDueForSync(PDO $db, array $opts): array;

/**
 * The cron-only writer for the 012 columns and the provider-owned fields.
 * Never validates, never audits, never writes `status`, and exists so none of
 * these joins LIVE_WRITE_COLUMNS (store.php:449-454). Writes exactly the keys
 * given — state, synced_status, error, attempts, next_sync_at,
 * last_synced_at, last_sync_ok_at, viewers, provider_thumbnail_url,
 * provider_scheduled_start, provider_scheduled_end, provider_stream_id,
 * recording_url — and nothing else; §5.5 says which outcome passes which.
 * scheduled_start_at and scheduled_end_at are not accepted keys.
 */
function liveRecordSync(PDO $db, int $id, array $facts): void;

/**
 * Flip one row's automation, with one audit row (live_sync_paused /
 * live_sync_resumed, detail $why).
 * Off: sync_enabled = 0 and sync_error = 'paused: ' . $why when $machine is
 * true (G15, G22 — the only machine pauses), else sync_error = NULL (a
 * person's Switch to manual, and G8, which is a person's backwards move).
 * On (Resume automation): a full reset in the same UPDATE — sync_enabled = 1,
 * synced_status = status, sync_attempts = 0, sync_error = NULL,
 * next_sync_at = NULL — so the next pass neither re-pauses the row on the old
 * baseline nor on the old failure count, and checks it at once.
 */
function liveSetSyncEnabled(PDO $db, int $id, bool $on, string $actor, string $why = '', bool $machine = false): bool;
```

**`liveUpdate()` resets the sync columns when the video changes.** When the save changes `provider` or `provider_broadcast_id` (both in `LIVE_WRITE_COLUMNS`, compared as `store.php:509` already does), the same `UPDATE` at `store.php:515` also sets every §2.2 column to its "reset on a new video" value, in this order:

1. `sync_enabled = IF(sync_enabled = 0 AND sync_error LIKE 'paused%', 1, sync_enabled)` — a machine pause (G15, G22) is lifted, a person's pause (*Switch to manual*, G8, both of which leave `sync_error` NULL) is kept. It comes before the `sync_error` clause because MySQL evaluates a single-table `UPDATE`'s assignments left to right;
2. then `sync_state`, `synced_status`, `last_synced_at`, `last_sync_ok_at`, `next_sync_at`, `sync_error`, `provider_thumbnail_url`, `provider_scheduled_start_at`, `provider_scheduled_end_at`, `viewer_count`, `provider_stream_id` and `recording_url` to NULL, and `sync_attempts` to 0.

`synced_status` is NULL **whatever status the save leaves** — DRAFT, CANCELLED, OFFLINE and ERROR have no rank — so the row's next pass takes its status as the baseline (§6.4). The lifted pause writes no audit row of its own: the `live_stream_update` row that records the new video id is the record. Everything the job knew described the old video; the corrected broadcast is due at once unless a person paused it. The clauses are appended only when `liveAutomationInstalled()` is true, so a database without 012 is untouched. `tests/admin-live.mjs:387-388` edits only `description_en` and `scheduled_end_at`, so its column comparison is unaffected.

`liveSetStatus()` gains **one optional parameter**, so every existing caller and test is unaffected:

```php
/**
 * @param ?string $at  The provider's own instant, UTC 'Y-m-d H:i:s', for the
 *   column this transition stamps (actual_start_at on LIVE, actual_end_at on
 *   COMPLETED). Null means liveUtcNow() — the Phase 1 behaviour. Each column
 *   is still written only when it is currently NULL.
 *
 *   Validated, never trusted: it came from a third-party response. Anything
 *   that is not a real UTC instant in exactly that format is discarded and
 *   $now used instead, silently — a status move must not fail because a
 *   provider sent a strange string, and the column is public
 *   (store.php:647-648).
 */
function liveSetStatus(PDO $db, int $id, string $to, string $actor, ?string $at = null): array
```

Inside, before the `:started` / `:ended` stamps at `store.php:592-599`:

```php
$t     = is_string($at) ? DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $at, new DateTimeZone('UTC')) : false;
$stamp = $t !== false && $t->format('Y-m-d H:i:s') === $at ? $at : $now;
```

used for `:started` and `:ended`; `status`, `updated_by` and `updated_at` still use `$now`. The round trip rejects `'2026-02-31 25:61:61'`, which a syntactic regex would pass.

### 5.2 `liveCronRun()` — the lock

A verbatim copy of `backend/includes/payments/reconcile.php:312-331`, with the lock named **`temple_live_cron`**:

```php
$db  = getDB();                                                   // exactly once: GET_LOCK is per connection
$got = (int) $db->query("SELECT GET_LOCK('temple_live_cron', 0)")->fetchColumn();
if ($got !== 1) return ['locked' => true] + $empty;               // timeout 0: never wait
try { $summary = livePollSweep($db, $opts); }
finally {
    try { $db->query("SELECT RELEASE_LOCK('temple_live_cron')")->closeCursor(); }
    catch (Throwable) { /* the lock is released with the connection anyway */ }
}
return $summary + ['locked' => false, 'duration_ms' => (int) round((microtime(true) - $started) * 1000)];
```

A one-minute tick with a 50-second budget leaves ten seconds of slack, so **an overlapping run is expected and is not an error**: the second exits 0 saying another run holds the lock. `README.md` says so in a sentence.

### 5.3 `livePollSweep()` — the batch

1. Starts from `['checked'=>0,'changed'=>0,'started'=>0,'ended'=>0,'errors'=>0,'skipped'=>0,'calls'=>0,'units'=>0,'items'=>[]]`. `liveTablesExist()` or `liveAutomationInstalled()` false → `skipped = 1`, **no throw**.
2. `$ready = liveAutomationReady(); if (!$ready['ok']) return $summary + ['skipped' => 1];` — nothing checked, nothing stamped, no call.
3. `liveQuotaBlockedUntil()` in the future → return with `skipped = 1`. **Zero calls until midnight Pacific.**
4. Clamps: `$limit = max(1, min(200, (int) ($opts['limit'] ?? 50)))`, `$maxSeconds = max(1, min(300, (int) ($opts['max_seconds'] ?? 50)))`, `$actor = mb_substr((string) ($opts['actor'] ?? 'cron'), 0, 60) ?: 'cron'`, `$trigger ∈ cli|http|admin`, `$dryRun = !empty($opts['dry_run'])`, and `{$lead}`, `{$stale}`, `{$catchup}` from `liveAutomationConfig()` (`catchup_hours` clamped `max(1, min(168, …))`). **`$now = liveUtcNow()` is captured here, once, before the working-set query**, and is the `$now` every `livePollDecide()` and `liveSyncNextAt()` of this run receives: a row's next due time is measured from the run's start, not from the moment its call returned, so a 12-second Google round trip cannot push a 60-second cadence onto the next-but-one tick.
5. **A scoped run never widens**: `$scoped = array_key_exists('stream_ids', $opts) && $opts['stream_ids'] !== null;` and `if ($scoped && !$ids) return $summary;` — the rule `bin/payments_cron.php:76-77` and `reconcile.php:60` enforce.
6. **Working set** — ids only, with `[$eligible, $params] = liveSyncEligibleWhere()` (§3.1). Clamped integers are interpolated (the pattern of `reconcile.php:69-76`); `LIVE_UPCOMING_GRACE_HOURS` (`store.php:161`) is concatenated exactly as `liveListUpcoming()` does at `store.php:175`, so the poller's window and the public upcoming list cannot drift apart (`{LIVE_UPCOMING_GRACE_HOURS}` would be emitted as literal text — PHP interpolates only variables):

```sql
SELECT s.id
  FROM live_streams s
 WHERE {$eligible}
   AND s.sync_enabled = 1
   AND (s.next_sync_at IS NULL OR s.next_sync_at <= UTC_TIMESTAMP() + INTERVAL 5 SECOND)
   AND (
         s.status IN ('STARTING','LIVE')
         OR (s.scheduled_start_at IS NOT NULL
             AND s.scheduled_start_at <= UTC_TIMESTAMP() + INTERVAL {$lead} MINUTE
             AND COALESCE(s.scheduled_end_at,
                          s.scheduled_start_at + INTERVAL " . LIVE_UPCOMING_GRACE_HOURS . " HOUR)
                 >= UTC_TIMESTAMP() - INTERVAL {$stale} HOUR)
         OR (s.status = 'SCHEDULED'
             AND s.scheduled_start_at <= UTC_TIMESTAMP()
             AND s.scheduled_start_at >= UTC_TIMESTAMP() - INTERVAL {$catchup} HOUR)
       )
 ORDER BY FIELD(s.status,'LIVE','STARTING','SCHEDULED'),
          (s.next_sync_at IS NULL) DESC, s.next_sync_at ASC, s.id ASC
 LIMIT {$limit}
```

   The third disjunct is the catch-up's licence (§0.2 #6): a SCHEDULED row whose start has passed, back as far as `catchup_hours`, with **no condition of its own on any sync column** (the `sync_enabled` and `next_sync_at` clauses above bind every disjunct, G4, G5) — no failed check and no earlier `upcoming` answer can end it. Its **`{$catchup}` lower bound** may not be simplified away: without it the first sweep after `mode` leaves `off` would select every row the committee ever forgot to end (§2.2). Past its grace such a row is asked every `LIVE_POLL_LATE_SECONDS` (§5.5).

   **The simulator scope** is part of `liveSyncEligibleWhere()`, so it binds scoped and unscoped runs alike and every other bulk statement over sync rows. It is how a suite works on a shared database without touching a row it did not create (§10.1). Without the flag the variable is ignored entirely.

   **A scoped run** is `WHERE {$eligible} AND s.id IN (…)`: it drops the `sync_enabled`, `next_sync_at` and window clauses and keeps the predicate (G2, G3, the simulator scope). *Check now* reads a paused row but never moves it (G4).
7. **An empty set costs zero API calls and returns at once.** Next week's schedule costs nothing.
8. **One call for the lot.** Ids are de-duplicated and chunked at `LIVE_YT_BATCH_MAX`, at most `LIVE_YT_MAX_CALLS` chunks; rows of chunks beyond that are `skipped`. Each call is counted with `liveQuotaSpend($db, 1)` **before** it is made — in a dry run too, because Google charges it. When `liveQuotaSpend()` answers false (the soft ceiling is reached, which opens the breaker), the call is not made and the remaining rows are `skipped`.
9. **A call-level failure is the call's fault, not the broadcast's.** One call carries up to fifty ids, so a scope-**call** answer of §4.2 — what is left after the Tier 2 fallback has been tried — fails every row of the chunk through no fault of any of them:
   - `liveProviderFailStreak($db, $class, $notice)` runs **once for the call**; it increments the streak and writes `provider_notice` once per streak. `$notice` is a sentence from `liveProviderConnectionMessage()`'s vocabulary (§8.3), never the provider's text;
   - **one statement per chunk** records it on the chunk's automated rows, built on `liveSyncEligibleWhere()` like every bulk statement over sync rows (§3.1): `UPDATE live_streams s SET s.sync_error = …, s.last_synced_at = UTC_TIMESTAMP(), s.next_sync_at = … WHERE s.id IN (the chunk) AND s.sync_enabled = 1 AND {$eligible}`, with `sync_error` = class + that sentence and `next_sync_at` = `liveBackoffSeconds($streak, $retryAfter)` from now — **except a `quota` refusal, whose `next_sync_at` is `liveQuotaBlockedUntil()`** (§5.5). **A row with `sync_enabled = 0`** — reachable only by a scoped *Check now* (G4) — **is left byte-identical**, `last_synced_at` included, so a machine pause's `paused: …` marker survives, the §8.4 badge stays, and a corrected video id still lifts the pause (§5.1); the *Check now* flash reports the failure instead (§8.4). The statement changes no status, so it takes no lock and needs no G23 comparison;
   - nothing else: **no row's `sync_attempts`, `last_sync_ok_at`, `synced_status` or facts change**, and no row reaches `livePollStream()`. This is why a Google outage, a revoked key or a mistyped key can never pause automation (G15).

   **A call that answered** (a 200, or a 404 handled as one) runs `liveProviderFailStreak($db, null, $answer['notice'])` **once for the call, before that chunk's rows are processed** — clearing the streak and leaving `provider_notice` as the run's standing Tier 2 sentence (§4.2), or empty — and then hands every row its own fact (`liveYoutubeMissingFact()` for an id the answer did not carry) to `livePollStream()`. **No row ever writes `provider_notice`**: a condition of one row is that row's notice, in its own `sync_error` (§5.5), so no chunk can wipe what another row reported. Whether a row's `last_sync_ok_at` moves is that row's business (§5.5), not the call's. In a dry run none of this step's writes happen (G18).
10. **The remote call happens outside every transaction** — no row is locked while Google thinks (`reconcile.php:14-17`). Each row is then handled by `livePollStream()` in its own `liveTransaction()` on the row re-read `FOR UPDATE` (§5.1): **G23 first, then one decision against the locked row** — §6.4's order, §6.2's moves and G22, in that order, all inside `livePollDecide()` — then the apply and the record (§5.5) in the same transaction. The race G23 closes: the row is `STARTING` and the call is in flight (`LIVE_YT_TIMEOUT` is 12 s); the committee presses **Reschedule** (`STARTING → SCHEDULED`, `admin.php:89`, legal at `config.php:53`); `SCHEDULED → LIVE` is in both `LIVE_TRANSITIONS` (`config.php:52`) and `LIVE_AUTO_TRANSITIONS`, so an unguarded job would silently undo the person. With G23 the pass writes only `last_synced_at`, `synced_status` still holds `STARTING`, and the next pass pauses the row through §6.4 step 2.
11. **Deadline**: `foreach ($ids as $id) { if (microtime(true) - $started > $maxSeconds) break; … }` — the rows not reached are `skipped`. There is no `sleep()`; the throttle is `next_sync_at` plus this wall-clock break.
12. **Idempotent and resumable**: every row that was checked is stamped `last_synced_at = UTC_TIMESTAMP()` and given the `next_sync_at` §5.5 names, except a row with `sync_enabled = 0` under a call-level or rolled-back failure, which is left byte-identical (step 9, §5.5); `not_configured`, `skipped` and `dry_run` rows are not touched at all. With the least-recently-due ordering, the next minute continues where the deadline cut this one off, and a re-run inside a row's cadence selects nothing.
13. **A row failure never aborts the batch.** `livePollStream()` never throws: `LiveTransitionException` → `refused`, `LiveValidationException` → `not_ready`, any other `Throwable` → `error` with `error_log('[live] poll ' . ($row['slug'] ?? '?') . ' failed: ' . liveRedact($e->getMessage()))`, copying `reconcile.php:246-251`. The `catch` sits **around the whole `liveTransaction()`, never around a `livePollApplyMove()` call**: `liveTransaction()` is nest-safe and with `$own === false` it rethrows without rolling back (`store.php:72-84`), so a catch inside would let the catch-up's first step commit while swallowing the second (§6.2). After the rollback the failure is recorded in a separate write (§5.5).
14. `items[]` records `['id','slug','outcome','would','from','to','state']` for the CLI and the admin flash. It is **never** returned by the HTTP endpoint.

### 5.4 `backend/bin/live_cron.php` (new) — the CLI job

A line-for-line sibling of `backend/bin/payments_cron.php`. The header comment is the deployment doc: Hostinger's `hPanel → Advanced → Cron Jobs, "Custom"`, the literal command `/usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php`, the usage line and the exit-status contract. First statement, before any require:

```php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
```

then one `require_once __DIR__ . '/../includes/live.php';`.

| Flag | Rule |
|---|---|
| `--limit=N` | `ctype_digit` and ≥ 1, else fail. Default 50, clamped 1–200 |
| `--max-seconds=N` | same. Default 50, clamped 1–300 |
| `--stream-ids=1,2` | split on `,`, each `ctype_digit` and > 0; **kept even when the list is empty** — a scoped run never widens |
| `--dry-run` | decide and report every row; **write nothing to the database but the quota count** (G18). Without `--json` it prints one line per item, `  #<id> <slug>: <from> -> <to or "no move"> (<would>)`, before the summary |
| `--json` | detected by `in_array` before the loop; prints the whole result array |
| `--help` / `-h` | prints `$usage`, `exit(0)` |

Parsed with the same `/^--([a-z-]+)=(.*)$/s` regex, values `trim($m[2], " \"'")`, `$opts` starting `['trigger' => 'cli', 'actor' => 'cron']`, and a `never`-returning `$fail()` closure that prints JSON `{"error": …}` on stdout with `--json` and `live cron: <msg>` on **STDERR** otherwise, then `exit(1)`.

- `liveTablesExist()` false → `$fail('apply database/migrations/011_live_streams.sql')` → exit 1.
- `liveAutomationInstalled()` false → `live cron: apply database/migrations/012_live_automation.sql; nothing to do.` and **exit 0**.
- `liveAutomationReady()['ok']` false → `live cron: ` + the reason + ` Nothing to do.` and **exit 0**.
- `$result['locked']` → `live cron: another run holds the lock; nothing to do.` and **exit 0**.
- otherwise `printf('live cron: checked %d, changed %d, started %d, ended %d, errors %d, skipped %d, calls %d, units %d in %d ms' . PHP_EOL, …)` and `exit(0)`.
- A `Throwable` from `liveCronRun()` → `error_log('[live cron] ' . get_class($e) . ': ' . liveRedact($e->getMessage()))` then `$fail(…)` → exit 1.

**Exit 1 is only ever an error.**

### 5.5 What each outcome writes, and when the row is asked again

Three tables, the only statement of these rules. `livePollStream()` writes the row inside the lock transaction, except the row-failure outcomes `not_ready`, `refused` and `error`, whose transaction rolled back and which are recorded by a separate `liveRecordSync()` afterwards. "Facts" means `sync_state`, `provider_scheduled_start_at`, `provider_scheduled_end_at`, `provider_thumbnail_url`, `viewer_count` (frozen, never zeroed, when the field is absent) and, at Tier 2, `provider_stream_id` — and, for a `missing`, `restricted` or `not_broadcast` answer, `sync_state` alone.

**Notice positions.** A condition of one row that a person should look at is written to that row's `sync_error` as `'notice: ' . $sentence` (through `liveRedact()`, clipped), **never to `provider_notice`**, and is **never counted as a failure**. These are the only notice positions, and N3 takes precedence over N4 and N5. "No move" below excludes `held` (the committee's own switch) and an `ended` fact whose `actual_end` is present but younger than `complete_grace_seconds` (the move follows on a later pass); those two are never notices.

| # | Position and answer | Outcome | Sentence |
|---|---|---|---|
| N1 | `SCHEDULED` or `STARTING`, `now ≤ scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, fact `missing` (at Tier 1 this includes a video kept private until it goes live, a late start included) | `not_found` | *"Stream #<id> “<title>”: not visible on YouTube yet (still private, or the id may be wrong)."* |
| N2 | `SCHEDULED` or `STARTING`, `now ≤ scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, fact `restricted` | `restricted` | *"Stream #<id> “<title>”: the YouTube video is still private or not embeddable; it must be public or unlisted, and embeddable, by the start."* |
| N3 | any status: a move's evidence is present and G24 is false | `mismatch` | §6.2's G24 sentence |
| N4 | `LIVE`, no move, fact not `live` — except `upcoming` or `starting` while `now ≤ scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS` (a person pressed *Go live* early) | what the fact gives: `unchanged`, `revoked`, `not_found`, `restricted` or `not_broadcast` | *"Stream #<id> “<title>” is live on the site but YouTube does not report it live — end it by hand if it has finished."* |
| N5 | `STARTING`, `now > scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, no move, fact **not** one G22 pauses on (`upcoming`, `not_broadcast`, `missing`) | what the fact gives: `unchanged` (`ended` without `actual_end`, Tier 2 `starting`, `unknown`), `revoked` or `restricted` | *"Stream #<id> “<title>” has been STARTING since {time} and YouTube does not report it live — end or cancel it by hand if it is not happening."* |

**N1 and N2 are the single statement of the hidden-until-live rule.** A `SCHEDULED` or `STARTING` row whose video is still hidden — `missing` at Tier 1, `restricted` at Tier 2 — is a notice, not a failure, until `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, a late start included. It keeps the position cadence below (60 s from `scheduled_start_at − starting_lead_minutes` through the start plus the grace; `poll_seconds_soon` for a SCHEDULED row before that window), is never backed off and keeps `sync_attempts` 0, so the row moves on the first pass after the video appears. After the start plus the grace the same answer is a row failure on a `SCHEDULED` row; on a `STARTING` row a `missing` fact is G22's pause and a `restricted` one is N5, both unchanged (§6.2).

**The position cadence** *P*, from the row as the pass leaves it, first matching row wins:

| Row position | *P* |
|---|---|
| moved to `COMPLETED` this pass, or `sync_enabled = 0` | `NULL` — the row has left the working set; whatever brings it back (Resume, a person's move, a new video id) finds it due at once |
| `now > scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, and the row is `SCHEDULED` or its `sync_error` is a notice | `LIVE_POLL_LATE_SECONDS` (900), until the row leaves the working set — for a SCHEDULED row, at `scheduled_start_at + catchup_hours` |
| `STARTING` or `LIVE` | `poll_seconds_live` (60) — a broadcast YouTube reports live is followed at this pace however long it runs |
| `SCHEDULED`, `now ≥ scheduled_start_at − starting_lead_minutes` | `poll_seconds_live` (60) — this covers a broadcaster running late, up to the grace |
| any other `SCHEDULED` row (inside `lead_minutes`, before the fast window) | `poll_seconds_soon` (300) |

**The outcomes** (group as in §1):

| Outcome | facts | `sync_error` | `sync_attempts` | `last_sync_ok_at` | `synced_status` | `next_sync_at` |
|---|---|---|---|---|---|---|
| `starting`, `live`, `ended` | written | `NULL` | 0 | by the rule below | the status after the move | *P* |
| `unchanged`, `held`, `revoked`, `mismatch`, `overridden` (§6.4 step 3) | written | `NULL`, or the notice of N3–N5 | 0 | by the rule below | the row's status | *P* |
| `not_found`, `restricted`, `not_broadcast` in a notice position (N1, N2, N4, N5) | written | the notice | 0 | by the rule below | the row's status | *P* |
| `not_found`, `restricted`, `not_broadcast` anywhere else | written | class + sentence | +1 | by the rule below | the row's status | `liveBackoffSeconds()` of the new `sync_attempts` |
| `paused` — G8 (a person's backwards move) | written | `NULL` | 0 | by the rule below | the row's status | `NULL` |
| `paused` — G22 | written | `paused: stuck: …` (§6.2) | 0 | by the rule below | the row's status | `NULL` |
| `paused` — already `sync_enabled = 0` (scoped *Check now*) | written | unchanged | unchanged | by the rule below | the row's status | unchanged |
| the twelfth consecutive row failure (G15) | as its own row | `paused: after 12 failures: ` + the failure | 12 | as its own row | as its own row | `NULL`, and outcome `paused` |
| `not_ready`, `refused`, `error` (a row with `sync_enabled = 1`) | not written (rolled back) | class + message | +1 | unchanged | unchanged | `liveBackoffSeconds()` of the new `sync_attempts` |
| `unreachable`, `rate_limited`, `auth`, `request` (a row with `sync_enabled = 1`) | not written | class + committee sentence | unchanged | unchanged | unchanged | `liveBackoffSeconds($streak, $retryAfter)` |
| `quota` (a row with `sync_enabled = 1`) | not written | `quota` + sentence | unchanged | unchanged | unchanged | `liveQuotaBlockedUntil()` |
| any of the five call-level outcomes, or `not_ready`, `refused`, `error`, on a row with `sync_enabled = 0` (scoped *Check now*) | not written | unchanged | unchanged | unchanged | unchanged | unchanged — the row is byte-identical, `last_synced_at` included; the *Check now* flash reports the failure (§8.4) |
| `overridden` (G23) | not written | unchanged | unchanged | unchanged | unchanged | unchanged |
| `not_configured`, `skipped`, `dry_run` | — | — | — | — | — | — (nothing at all, not even `last_synced_at`) |

`last_synced_at` is written by every row of the table except the last and the `sync_enabled = 0` failure row. **A pause marker is never erased by the machine**: nothing ever overwrites a `sync_error` that begins with `paused` except *Resume automation*, a new video id (§5.1, E7), or a person's status change that ends automation for the row. That is why the call-level write (§5.3 step 9) and the separate record of a rolled-back `not_ready`, `refused` or `error` both touch only rows with `sync_enabled = 1`. **`last_sync_ok_at` moves only when the row's own item came back as a broadcast** — any `sync_state` but `missing`, `restricted` and `not_broadcast` — and nothing but the admin panel reads it. Every seconds value is floored at `LIVE_POLL_MIN_SECONDS` (30) however the settings were written; `NULL` and the `quota` instant need no floor. A pause writes its `live_sync_paused` audit row through `liveSetSyncEnabled()` (§6.5); only G15 and G22 pass `$machine = true`.

```php
function liveBackoffSeconds(int $failures, ?int $retryAfter = null): int
{
    $i    = max(0, min(count(LIVE_SYNC_BACKOFF) - 1, $failures - 1));
    $base = LIVE_SYNC_BACKOFF[$i];
    $jit  = (int) round($base * (random_int(-100, 100) / 1000));    // ±10 %
    $n    = max(LIVE_POLL_MIN_SECONDS, $base + $jit);
    if ($retryAfter !== null) $n = max($n, $retryAfter);            // the provider's own header wins when longer
    return min($n, max(300, (int) liveSetting('backoff_max_seconds', '3600')));
}
```

The `300` is the same floor §8.3's form applies to `backoff_max_seconds` (300–86400), written here too because the overlay and a hand-edited row can reach the setting without the form. A builder who changes one changes both; §11.2 section 15 asserts the pair.

After a credential save or **Reconnect**, every row `liveSyncEligibleWhere()` selects has its `next_sync_at` set to `NULL` (§3.1, §8.3), so a back-off earned by the old credential never delays the new one.

### 5.6 Quota arithmetic — the reason the cadence is what it is

10,000 units/day ÷ 86,400 s = **one call every 8.64 seconds exhausts the whole daily pool**. The contract therefore forbids any cadence faster than 30 s and sets these numbers:

| Situation | calls/day | % of 10,000 |
|---|---|---|
| nothing scheduled | 0 | 0 % |
| three 2-hour broadcasts, 60 s in the fast window and while live, 300 s in the rest of the lead-in | ≈ 420 | ≈ 4 % |
| one broadcast live 24 h at 60 s (worst realistic, Tier 1) — never paused while YouTube says live (G22) | 1,440 | 14 % |
| the same at Tier 2 (a second call per tick while any row is SCHEDULED or STARTING) | ≤ 2,880 | ≤ 29 % |
| a row nobody closes — a SCHEDULED broadcast that never happened, or a LIVE / STARTING row carrying a notice — once its grace has passed (`LIVE_POLL_LATE_SECONDS`) | 96, batched with any others due at once | 1 % |

Batching is what makes this true: `videos.list` takes a comma-separated `id` list and still costs 1 unit, so the cost is a function of the tick rate, not of how many broadcasts the temple runs. The interval is a **setting, not a constant**, because Google began moving methods into their own capped buckets on 2026-06-01; if `videos.list` ever joins them, only a `live_settings` row should have to change.

### 5.7 `backend/api/live_cron.php` (new), routed at `/api/live-cron`

A line-by-line copy of `backend/api/payments_cron.php`. Requires `helpers.php`, `live.php`, `rate_limit.php`; then `ini_set('display_errors','0')`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`. In order:

1. `$configured = envValue('LIVE_CRON_KEY'); if (strlen($configured) < 24) { if ($configured !== '') error_log('[live-cron] LIVE_CRON_KEY is shorter than 24 characters, so the endpoint stays off'); sendJson(['error' => 'Not found'], 404); }` — a **bare 404**.
2. Anything but GET/POST → `Allow: GET, POST` and 405.
3. `if (!rateLimitPeek('live-cron-denied', 30, 3600)) sendJson(['error' => 'Too many attempts'], 429);`
4. `$sent = $_SERVER['HTTP_X_CRON_KEY'] ?? ($_GET['key'] ?? '');` — the header is preferred because a `?key=` ends up in access logs. Then the guard is `api/payments_cron.php:40` **verbatim**:

```php
if (!is_string($sent) || $sent === '' || !hash_equals($configured, $sent)) {
    rateLimitAllow('live-cron-denied', 30, 3600);
    error_log('[live-cron] refused a request with a missing or wrong key from ' . clientIp());
    sendJson(['error' => 'Forbidden'], 403);
}
```

   The `is_string()` test matters: `?key[]=x` makes `$sent` an array, and `hash_equals()` would throw a `TypeError` and answer 500.
5. `liveTablesExist()` false → 503 `{'error' => …, 'code' => 'not_installed'}` — the name `backend/api/admin_live_streams.php:98` already uses for this condition. `liveAutomationInstalled()` false → 503 `{'code' => 'live_not_installed'}`, a different condition (011 applied, 012 not).
6. `ignore_user_abort(true); @set_time_limit(60);`
7. `liveCronRun(['trigger' => 'http', 'limit' => 50, 'max_seconds' => 25, 'actor' => 'cron'])` inside `try`; a `Throwable` → 500 `{'code' => 'cron_failed'}`, logged **redacted**: `error_log('[live-cron] ' . get_class($e) . ': ' . liveRedact($e->getMessage()));` — at Tier 1 an exception can carry the URL that carries the key.
8. Answers a **narrowed** summary: `{checked, changed, started, ended, errors, skipped, locked}`. Never `items`, `calls`, `units` or `duration_ms` — `items[]` carries slugs and error text, and this caller is keyed but unauthenticated. `locked` is kept: it is the one field that tells a held run from an idle minute.

**Routing** — one bare line in `backend/api/index.php`, immediately before the `/live-streams` matcher at line 115, matching the `/payments-cron` line at `index.php:106`:

```php
if ($path === '/live-cron') { require __DIR__ . '/live_cron.php'; exit; }
```

Nothing else in `index.php` changes; the regex at `:117` is untouched. `rateLimitPeek` / `rateLimitAllow` need the `rate_limits` table from migration 003; without it the key check still works and the denial counter silently does not — one sentence in `README.md`.

### 5.8 Production schedule

`README.md:409-421` and the `.env.example` scheduled-work block gain the third line:

```
*    * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php
```

Every minute, because Phase 2's countdown and "Starting shortly" state are only worth having if the flip is prompt; the per-row `next_sync_at`, not the crontab, is the rate limit. A host without CLI cron calls `GET /api/live-cron` every minute with the key in an `X-Cron-Key` header.

**No provider work ever happens on a page or public API request.** The only three ways in are `bin/live_cron.php`, the keyed HTTP trigger, and an explicit owner or editor POST.

---

## 6. Transitions, automation and every guard

### 6.1 What YouTube says → `sync_state`

The only place the two vocabularies meet. `videos.list` is always consulted and is **decided first**; `liveBroadcasts.list` (Tier 2) only refines a video that `videos.list` already found playable.

From `videos.list`, for the row's `provider_broadcast_id`, first matching row wins:

| Observation | `sync_state` |
|---|---|
| the id is absent from `items[]` (at Tier 1 that includes every private video), or 404 `videoNotFound` | `missing` |
| `status.privacyStatus` is not `public` or `unlisted` (reachable only with the owner's bearer), or `status.embeddable === false` | `restricted` |
| `liveStreamingDetails` absent entirely (an ordinary upload) | `not_broadcast` |
| `liveStreamingDetails.actualEndTime` present | `ended` |
| `snippet.liveBroadcastContent === 'live'` | `live` |
| `snippet.liveBroadcastContent === 'upcoming'` | `upcoming` |
| `liveBroadcastContent === 'none'` with `liveStreamingDetails` present and no `actualEndTime` | `ended` |
| anything else | `unknown` |

At Tier 2, and only when the table above gave `upcoming`, `live`, `ended` or `unknown`, `status.lifeCycleStatus` replaces it: `created`/`ready` → `upcoming`; `testStarting`/`testing`/`liveStarting` → `starting`; `live` → `live`; `complete` → `ended`; `revoked` → `revoked`. A private video therefore stays `restricted` at Tier 2, where the owner's bearer lets `videos.list` return it; at Tier 1 it is `missing`. Either way, on a `SCHEDULED` or `STARTING` row it is a notice (N1, N2), not a failure, until `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, a late start included (§5.5).

Completion is derived from `actualEndTime` / `lifeCycleStatus`, **never** from the `status` object. An absent `concurrentViewers` means *unknown*, never "the stream ended"; the stored figure is frozen, never zeroed.

### 6.2 The moves the job may make

**Every move** — the four rows and the catch-up — requires, besides its own row:

- a usable answer for this row whose `sync_state` is not `missing`, `restricted`, `not_broadcast`, `revoked` or `unknown` — so the video is embeddable and `public` or `unlisted` (G10);
- `liveProviderMatchesSchedule($row, $fact)` (G24); when it is false the outcome is `mismatch`, the row's notice (N3, §5.5) is *"Stream #<id> “<title>”: the YouTube video pasted for this broadcast does not look like it (YouTube's start <time>, ours <time>) — check the video id."* (or *"…belongs to another YouTube channel…"*), and nothing moves;
- its switch; when the switch is off the outcome is `held`.

| From | To | Its own conditions |
|---|---|---|
| `SCHEDULED` | `STARTING` | `auto_starting = 1` (seeded **0**); `sync_state = 'upcoming'` (Tier 2: or `'starting'`); **`now − starting_lead_minutes <= scheduled_start_at <= now + starting_lead_minutes`** |
| `SCHEDULED` | `LIVE` | `auto_start = 1`; `sync_state = 'live'`; `actual_start` present |
| `STARTING` | `LIVE` | as above |
| `LIVE` | `COMPLETED` | `auto_end = 1`; `sync_state = 'ended'`; `actual_end` present **and** `actual_end <= now − complete_grace_seconds` |
| `SCHEDULED` or `STARTING` | `LIVE`, then `COMPLETED` (the catch-up) | `auto_start = 1` and `auto_end = 1`; `sync_state = 'ended'`; `actual_start` and `actual_end` both present; `actual_end <= now − complete_grace_seconds` |

`actual_start_at` is written from `actual_start`, `actual_end_at` from `actual_end`, each passed as `liveSetStatus()`'s `$at` (validated, §5.1) and each written only when the column is currently NULL.

At Tier 1 `starting` is never observed, so `STARTING` is inferred from "YouTube says *upcoming* and the start is within `starting_lead_minutes`" — exactly what Phase 2's "Starting shortly" means. Tier 2 replaces the inference with the observation.

**Why row 1 alone has a lower bound.** It is the only move made from an inference: rows 2–4 need an instant that only a broadcast that actually ran produces. Without the bound, a start that passed a year ago satisfies "within `starting_lead_minutes`", and a row whose video still reads `upcoming` would be advertised as STARTING with no way back (G6). **The machine may anticipate a start, and may never resurrect a past one.**

**YouTube's own schedule never triggers a move and never shifts a boundary.** Every boundary here — row 1's window, `lead_minutes`, `stale_hours`, G22 — is measured against `scheduled_start_at` / `scheduled_end_at`, the times devotees were promised. YouTube's `scheduledStartTime` is used in one place only: as a veto inside G24, together with `actualStartTime`, `actualEndTime` and the channel. The bounds are narrow because a temple broadcasts several times a day (a morning abhishekam, an evening deeparadhana). **The 06:30 morning video pasted into the 18:00 row is refused on every count**: YouTube's start is 11 h 30 min from the row's, far outside `LIVE_MATCH_SCHEDULE_MINUTES` (20); its 06:32 actual start is 10 h 28 min before the row's window `[17:00, 21:00]` opens; and it ended at 07:40, before the row's slot began. **The 06:00 suprabhatam (actual 05:58–06:25) pasted into the 06:30 abhishekam row** is the close case: its actual start passes the actual-start window, but YouTube's start is 30 minutes from the row's, outside 20, and it ended before 06:30 — a broadcast that ended before this row's slot began is not this row's broadcast (clause (d)). **Why these numbers:** 20 minutes separates programmes half an hour apart; a temple that schedules its YouTube event far from the committee's slot gets a notice and no automation, which is the safe failure — the committee presses the buttons as in Phase 2, or corrects one of the two times. The actual-start window refuses an all-day stream that began at 05:55 for a 10:00 row, last week's video and next week's broadcast. Its late edge is `LIVE_UPCOMING_GRACE_HOURS`, the same grace that keeps a late SCHEDULED row on the public list, so a broadcaster up to three hours late is still recognised.

**A stuck STARTING row is paused (G22).** When a pass decides on a `STARTING` row, `now > scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, no move follows, and the fact is **`upcoming`, `not_broadcast` or `missing` — and nothing else** — then on that pass the job:

- calls `liveSetSyncEnabled($db, $id, false, $actor, $why, true)`: `sync_enabled = 0`, one `live_sync_paused` audit row, and `sync_error = 'paused: stuck: this broadcast has been STARTING since {time} and YouTube does not report it live'`;
- reports outcome `paused`, with `next_sync_at = NULL` (§5.5);
- changes **no status** — `OFFLINE`, `ERROR` and `CANCELLED` stay a person's word.

Every other fact on such a row — `restricted`, `ended` without `actual_end`, Tier 2 `starting` (testing), `revoked`, `unknown` — gets notice N5 and **no pause** (§5.5). An `ended` fact that carries `actual_end` is never a trigger: once `actual_end` is `complete_grace_seconds` old it is the catch-up, and before that the pass is `unchanged` with no notice, so the catch-up follows a minute later.

The Sync column shows **"stuck — a person must end or cancel this"** while the row is still `STARTING` and paused with that error (§8.4). It is the backstop for a row started by hand and abandoned, or a video deleted before it ever went live. G22 **never** applies on a call-level failure (those rows never reach a decision, §5.3 step 9) and **never to a `LIVE` row**: if YouTube says a broadcast is live it is live however long it runs, and the job keeps polling it at `poll_seconds_live`.

**A LIVE row YouTube does not report live is left for the committee.** Nothing moves and nothing is paused; the row gets notice N4 (§5.5), unless YouTube still says `upcoming` or `starting` within the grace, which is a person pressing *Go live* early. A video that disappears or turns private mid-broadcast is that notice too, not a row failure, so the row is never backed off; past the grace it is asked every `LIVE_POLL_LATE_SECONDS` until a person ends it.

**The catch-up is one transaction, and its exception handling sits outside it.** It performs `→ LIVE` (stamped with `actual_start`) and `→ COMPLETED` (stamped with `actual_end`), each through `livePollApplyMove()` (§5.1), inside **one** `liveTransaction()`, producing two `live_stream_status` audit rows; the outcome is `ended`. After a long outage the row reaches the sweep only through §5.3 step 6's catch-up disjunct. `liveTransaction()` is nest-safe: with `$own === false` it rethrows and does **not** roll back (`store.php:72-84`). A `catch` around a `livePollApplyMove()` call inside the outer transaction would therefore swallow a failure of the second step while the first step's `→ LIVE` and its audit row committed — leaving the row `LIVE`, `is_live`, featured, for a broadcast that ended hours ago. Therefore **one `try` around the whole `liveTransaction()`** (§5.3 step 13). The second step cannot fail re-validation — `COMPLETED` is not in `LIVE_VALIDATED_TARGETS` (`store.php:38`), so `liveValidate()` never runs for it (`store.php:583`) — but it can fail on a lock timeout, a deadlock or any database error, and in the suites on `LIVE_SIM_FAIL_AFTER_LIVE`, whose throw starts inside that second call (§10.1). Either way both steps roll back, the row is recorded as a row failure (`error`) with its ordinary back-off, and G15 stops a catch-up that keeps failing.

`revoked` (Tier 2) changes no status: cancelling a broadcast in front of devotees is a person's decision. It is recorded in `sync_state` and surfaced.

### 6.3 Every guard against a wrong automatic change

Numbered so a reviewer can tick them off; each has a named check in §11.

| # | Guard |
|---|---|
| **G1** | `mode = 'off'` → no call, no row touched. Migration 012 not applied → `liveAutomationInstalled()` false → no call. Tier 0 and not `simulator` → `liveAutomationReady()` false → no call. |
| **G2** | Only `provider = 'youtube'`, `deleted_at IS NULL`, a non-empty `provider_broadcast_id`. G2 and G3 are `liveSyncEligibleWhere()`, the one predicate every bulk statement over sync rows uses (§3.1). |
| **G3** | Only `status IN ('SCHEDULED','STARTING','LIVE')`. `DRAFT`, `COMPLETED`, `CANCELLED`, `OFFLINE` and `ERROR` are never read and never written by the job — including by *Check now*. |
| **G4** | `sync_enabled = 0` → the cron skips the row; a scoped *Check now* records its facts, reports what it **would** do, and moves nothing (outcome `paused`, §6.4 step 1). A call-level or rolled-back failure leaves such a row byte-identical, so a `paused:` marker survives (§5.3 step 9, §5.5). |
| **G5** | Window: a `SCHEDULED` row is polled only inside `[start − lead_minutes, end + stale_hours]`, with one exception — §5.3 step 6's catch-up disjunct: a `SCHEDULED` row whose start has passed stays eligible back as far as `catchup_hours`, whatever earlier checks said. Besides `sync_enabled` (G4) and `next_sync_at`, no sync column affects eligibility. |
| **G6** | Forward only: the target's `LIVE_AUTO_FLOW` rank must be strictly greater than the current status's. |
| **G7** | Machine subset: the pair must be in `LIVE_AUTO_TRANSITIONS`, checked **before** `liveSetStatus()`. The job can never write `OFFLINE`, `ERROR`, `CANCELLED` or `DRAFT`. |
| **G8** | **Human baseline.** `synced_status` is the status the job's last committed pass left the row in (§5.5), or NULL when there is no baseline. A status that ranks **lower** than it is a person's backwards move and pauses the row as a person's pause (`sync_error` NULL), whatever YouTube says; one that ranks **higher** is a person's forward move and is adopted (§6.4). |
| **G9** | **Readiness.** `liveSetStatus()` re-runs `liveValidate()` for `SCHEDULED`/`STARTING`/`LIVE` (`store.php:583-588`). A `LiveValidationException` → outcome `not_ready`, a row failure with the field messages in `sync_error`. It never aborts the batch — a stream whose temple was deactivated must not crash every run. |
| **G10** | **Evidence only, and playable only.** `missing`, `restricted` (private, or not embeddable; `unlisted` is allowed), `not_broadcast`, `revoked` and `unknown` move nothing, ever — at any tier. |
| **G11** | **Debounce.** COMPLETED needs `actual_end` at least `complete_grace_seconds` in the past. |
| **G12** | **Switches.** `auto_starting`, `auto_start`, `auto_end`: a move a switch forbids reports `held` and changes nothing. |
| **G13** | **A failed check changes no status, ever.** A call failure writes only `last_synced_at`, `sync_error` and `next_sync_at`, and only on rows with `sync_enabled = 1`; a row failure additionally `sync_attempts` (§5.5). |
| **G14** | **Quota breaker.** `quotaExceeded` / `dailyLimitExceeded`, or reaching `daily_quota_units`, stops every provider call until the next midnight America/Los_Angeles. |
| **G15** | **Give up quietly — only on this broadcast's own failures.** After `LIVE_SYNC_GIVE_UP_ATTEMPTS` (12) consecutive `LIVE_SYNC_ROW_FAILURES` outcomes (notice positions excluded) the row is paused through `liveSetSyncEnabled()` with one `live_sync_paused` row and a `paused:` sentence in `sync_error`, which a new video id lifts (§5.1). A call failure never moves `sync_attempts` (§5.3 step 9), so a Google outage, a revoked key or a mistyped key can **never** pause automation on every broadcast at once; it writes one `provider_notice` instead. |
| **G16** | **Bounded run.** `--limit` clamps to 1–200, at most `LIVE_YT_MAX_CALLS` calls of each kind, and the wall-clock deadline breaks the loop. The rows not reached are untouched and still due, so the next run resumes where this one stopped. |
| **G17** | **A scoped run never widens.** An empty `--stream-ids=` list matches nothing. |
| **G18** | **A dry run writes nothing.** No row column, no audit row, no `live_settings` row — no facts, no `last_synced_at`, no `last_sync_ok_at`, no streak, no notice, no breaker, no stored bearer, no `oauth_revoked_at` or `oauth_revoked_reason` — except the quota count of the calls it really made, which Google charges. It decides against the snapshot and prints what it would do. |
| **G19** | **Never on a browser request.** The sweep is reachable only from `bin/live_cron.php`, the keyed `/api/live-cron`, and an admin POST. This keeps `tests/live-api.mjs`'s `F.late` row SCHEDULED half an hour past its start, `P2.soon`'s `starts_in_seconds` stable, and `tests/live-ui.mjs`'s `polling` scenario deterministic. |
| **G20** | **One write path.** No Phase 3 code may `UPDATE live_streams SET status` directly. Every change goes through `liveSetStatus()`, which takes `FOR UPDATE`, enforces `LIVE_TRANSITIONS`, re-validates, stamps the actual times and audits — the promise `backend/admin/live_streams.php:8-10` makes. |
| **G21** | **Stand-in only when allowed.** `mode = simulator`, the two base-URL overrides, the settings overlay, `LIVE_SYNC_ONLY_TITLE_PREFIX` and `LIVE_SIM_FAIL_AFTER_LIVE` are honoured only when `liveSimulatorAllowed()`; a non-https base only for `127.0.0.1` / `localhost`. |
| **G22** | **No resurrection, and no stuck STARTING row.** `SCHEDULED → STARTING` needs `scheduled_start_at >= now − starting_lead_minutes`; the catch-up disjunct reaches back only `catchup_hours`; `auto_starting` seeds `0`. A `STARTING` row whose fact is `upcoming`, `not_broadcast` or `missing` once `now` is past `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS`, and for which the pass decided no move, is paused (§6.2); any other fact there gets notice N5 and no pause. A `LIVE` row is never paused by G22. |
| **G23** | **A row that changed during the call is left alone.** Under the lock, `livePollStream()` compares `status`, `synced_status`, `sync_enabled`, `provider`, `provider_broadcast_id` and `deleted_at` with the snapshot; any difference abandons the pass: outcome `overridden`, only `last_synced_at` written — `synced_status` is **not** rewritten, so the next pass sees the person's move through G8 exactly as designed. |
| **G24** | **The evidence belongs to this broadcast.** Every move requires `liveProviderMatchesSchedule()`: YouTube's `scheduledStartTime`, when sent, within `LIVE_MATCH_SCHEDULE_MINUTES` (20) of `scheduled_start_at` either side; its `actualStartTime`, when sent, in `[scheduled_start_at − LIVE_MATCH_EARLY_MINUTES (60), scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS]`; its `actualEndTime`, when sent, at or after `scheduled_start_at`; and — when `youtube_channel_id` is set — the video on that channel. Otherwise outcome `mismatch`, row notice N3, and no move (§6.2). The morning video in the evening row fails every time check; the 06:00 suprabhatam in the 06:30 abhishekam row fails the schedule check and the end check, each on its own. |

### 6.4 How an admin override interacts with automation

`livePollDecide()` evaluates a row in this order and stops at the first step that applies:

1. **`sync_enabled = 0`** → no move. The cron never selects such a row; a scoped *Check now* records its facts and reports `paused` (G4).
2. **The status is behind `synced_status`** in `LIVE_AUTO_FLOW` (a person's backwards move — *Reschedule* `STARTING → SCHEDULED`, the one backwards move `LIVE_TRANSITIONS` offers inside the flow, or a row that left the flow and came back lower) → **pause**, whatever YouTube says: `sync_enabled = 0` with `sync_error` NULL (a person's pause, which a new video id does not lift), one `live_sync_paused` audit row naming the two statuses, outcome `paused`, and the admin shows `Manual` with **Switch to automatic**, which is *Resume automation* (G8). A person undoing the machine means stop.
3. **The status is ahead of `synced_status`** (a person's forward move — *Go live* pressed early while YouTube still says *upcoming*) → **adopt it**: `synced_status = status`, no move on this pass, outcome `overridden`. From then on the job may only move the row further forward (G6).
4. **Only then the machine's move** — §6.2's moves, then G22, then the notice positions (§5.5). An answer that agrees with the status is simply case 4 with no move (`unchanged`); there is no separate agreement rule.

**Steps 2 and 3 apply only when `synced_status` is non-NULL and a key of `LIVE_AUTO_FLOW`.** Otherwise — no baseline yet (a new row, or `liveUpdate()`'s reset, §5.1), or a value outside the flow (only a hand-edited database can hold one) — the pass takes the current status as its baseline and goes on to step 4 in the same pass. Every rank lookup is written `LIVE_AUTO_FLOW[$x] ?? null` and compared only after that test, so none can raise a warning. **Every pass that reaches `livePollDecide()` and commits writes `synced_status` = the status the pass leaves** (§5.5), so the next pass's comparison means "a person changed it since the job last looked". G23, call failures, the rolled-back row failures (`not_ready`, `refused`, `error`), dry runs and not-run outcomes never write it.

**Resume automation** (`liveSetSyncEnabled($db, $id, true, …)`) resets the row fully — `sync_enabled = 1`, `synced_status = status`, `sync_attempts = 0`, `sync_error = NULL`, `next_sync_at = NULL` — with one `live_sync_resumed` audit row, so the next pass neither re-pauses it on the old baseline nor gives up on the old failure count, and checks it at once.

*End stream*, *Cancel* and *Restore to draft* put the row outside the working set (G3); the job never looks at it again. At every moment the status buttons keep working exactly as today, with the same capability, CSRF and transition rules and the same row menu — `tests/admin-live.mjs:363` and `:375` are unaffected because `LIVE_TRANSITIONS` did not change.

### 6.5 Audit

`liveSetStatus()` already writes one `live_stream_status` row per real change through `liveAudit()` (`store.php:601`), with actor `cron` (or the run's actor) and the unchanged detail `"SCHEDULED → LIVE by cron — “title”"`, and a same-status call is already a silent no-op (`store.php:579`). The job adds **no per-poll audit row**: `admin_activity` feeds the dashboard's activity list, and a per-minute job that audited each poll would bury every human action.

The only other rows Phase 3 writes:

| action | subject | when |
|---|---|---|
| `live_sync_paused` | `Stream #<id>` | through `liveSetSyncEnabled()`: G8's backwards move, G15's give-up, G22's stuck row, or a person's *Switch to manual*. The detail carries the reason |
| `live_sync_resumed` | `Stream #<id>` | *Resume automation* / *Switch to automatic* (§6.4) |
| `live_sync_error` | `Stream #<id>` | at most once per stream per **changed** class at the head of `sync_error`, classes `notice` and `paused` excepted (a notice is not an error; a pause has its own row); call failures write `provider_notice` once instead (§5.3 step 9) |
| `live_provider_settings` | `YouTube automation` | a settings save through `liveSettingsSaveMany()` — **key names only** — or **Reconnect** (§8.3). `liveProviderNoticeSet()` never writes one |
| `live_provider_test` | `YouTube automation` | the connection test, with the tone and the committee sentence, never a raw response |
| `live_provider_disconnected` / `live_provider_revoked` / `live_provider_token_rotated` | `YouTube automation` | §3.3; `live_provider_revoked` names `invalid_grant` or `invalid_client` |

---

## 7. What the client asked for, and where each field lives

| Clause 3.1 | Where it comes from | Where it goes |
|---|---|---|
| Broadcast information | `videos.list part=snippet,status,liveStreamingDetails` (Tier 2 also `liveBroadcasts.list`) | `sync_state`, and the decision |
| Scheduled start | `liveStreamingDetails.scheduledStartTime` | `provider_scheduled_start_at`, kept apart from `scheduled_start_at`; shown read-only in §8.4's panel; used only as G24's veto |
| Actual start | `liveStreamingDetails.actualStartTime` | `actual_start_at`, when NULL |
| Actual end | `liveStreamingDetails.actualEndTime` | `actual_end_at`, when NULL |
| Live status | `snippet.liveBroadcastContent`, Tier 2 `status.lifeCycleStatus` | `sync_state` → `status` through `liveSetStatus()` |
| Video thumbnail | best of `snippet.thumbnails.{maxres,standard,high,medium,default}` | `provider_thumbnail_url`; stored, displayed nowhere (Phase 4 decides) |
| Recording URL | derived — a broadcast and its video share one id, so the archive is `liveYoutubeWatchUrl($id)` | `recording_url`, written once with the machine's COMPLETED under §4.2's conditions; surfaced by Phase 8 |
| Viewer count when supported | `liveStreamingDetails.concurrentViewers` | `viewer_count`, read as at `last_sync_ok_at`; stored, displayed nowhere (Phase 11, behind `live.analytics`) |

`liveStreamingDetails.scheduledEndTime` arrives in the same 1-unit response and lands in `provider_scheduled_end_at`.

---

## 8. Admin

### 8.1 Capabilities

No new capability: `'live.provider' => 'owner'` already exists and is unused (`auth.php:72`, "YouTube credentials and provider settings (Phase 3)"), and `'live.publish' => 'editor'` (`:71`) already covers status moves. Two lines are added:

- `adminPageCapability()` (`auth.php:80-102`): `'live_settings.php' => 'live.provider',`
- `adminPageWriteCapability()` (`auth.php:109-136`): `'live_settings.php' => 'live.provider',`

`requireAdminAuth()` enforces both maps before a page runs any handler (`auth.php:321-323`), so **`live_settings.php` is owner-only for every action on it**. Every POST branch still re-checks `requireAdminCan('live.provider')` (`payment_settings.php:63` is the precedent) as defence in depth, never as a lower bar.

The editor-reachable actions live on the other page: *Check now* and the automation toggle on `live_streams.php` require `live.publish` — they can move a status. `live.analytics` (`auth.php:73`) is not used: Phase 3 shows no viewer figure (§0.2 #9).

### 8.2 Navigation

`backend/admin/includes/admin_layout.php`, in the **Data & System** group beside `payment_settings.php`:

```php
'live_settings.php'    => ['refresh',    'YouTube Automation', 'API keys and automatic status updates'],
```

and, so the Ctrl+K palette can draw that icon, one entry under the `// Live streaming.` line of the `#icon-sprite` map (`admin_layout.php:284-285`):

```php
'tv' => adminIcon('tv'), 'refresh' => adminIcon('refresh'),
```

`refresh` (`admin_ui.php:80`) is used by no other nav entry. It is not `shield`, which `payment_settings.php` already uses in this group (`admin_layout.php:42`); `tv` stays `live_streams.php`'s (`admin_layout.php:18`).

### 8.3 `backend/admin/live_settings.php` (new) — owner only

Built on the `backend/admin/payment_settings.php` skeleton, with the same header-comment contract: *credentials never come back out; a blank field keeps what is stored; a "Remove" tick clears it; a credential given in the server environment always wins and its field is read-only*.

- `requireAdminAuth()`, `LIVE_SET_BASE = '/admin/live_settings.php'`; the POST branch opens with `requireAdminCan('live.provider')` then `adminCsrfGuard()`; every branch ends with `$_SESSION['flash_live_settings']` and `header('Location: ' . LIVE_SET_BASE, true, 303); exit;`.
- **Status card**: `liveAutomationReady()['reason']`; the tier in words ("Manual only" / "API key — public broadcast data" / "OAuth — owner broadcast data"); **"OAuth: switched off on {time} because Google refused the saved OAuth credentials"** while `oauth_revoked_at` is set, followed for as long as the flag is set by the sentence matching `oauth_revoked_reason` — `invalid_grant`: *"The refresh token is no longer valid: mint a new refresh token for the channel's Google account and save it."*; `invalid_client`: *"Google no longer accepts the saved OAuth client: check the client secret in Google Cloud, or save it again."* — with the **Reconnect** button; `LIVE_SETTINGS_KEY` and `LIVE_CRON_KEY` as `Set` / `Not set` badges; migration 012 applied; today's quota spend against `daily_quota_units` with the Pacific date; `quota_blocked_until` as a warning with its release time in the temple's zone; `provider_notice` when set; and **"YouTube stand-in: allowed on this server"** as a *danger* badge when `liveSimulatorAllowed()`. A permanent warning: *"A Google Cloud project whose OAuth consent screen is in Testing with an external user type is issued refresh tokens that expire after 7 days. Publish the app, or add this Google account as an internal user, before relying on OAuth."* Every figure on the card comes from `live_settings` or an argument-less function; there is deliberately no cross-table "last check" figure (§0 rules out a health dashboard).
- **Mode**: radios `Off`, `Live`, and `Simulator` — the last rendered **only** when `liveSimulatorAllowed()`, mirroring `payment_settings.php:351-356`. Choosing `live` without a credential is refused with the reason from `liveAutomationReady()`.
- **Switches and numbers**: `auto_starting`, `auto_start`, `auto_end` (tick boxes); `starting_lead_minutes` (1–120), `lead_minutes` (5–180), `stale_hours` (1–48), `catchup_hours` (1–168), `complete_grace_seconds` (30–1800), `poll_seconds_live` and `poll_seconds_soon` (**30**–900, refused below 30 with the arithmetic in the hint), `backoff_max_seconds` (300–86400, the floor `liveBackoffSeconds()` also applies, §5.5), `daily_quota_units` (100–10000). Each with a one-sentence hint. `auto_starting`'s: *"Shows a broadcast as 'starting shortly' when YouTube still says it is upcoming and the start is close. This is the one thing the job guesses rather than observes — leave it off until you have watched a broadcast go through."* `catchup_hours`'s: *"How long after its start the job keeps checking a broadcast that is still marked scheduled — after an outage, or the first time you turn automation on. Anything older is left for a person."* The operational rows (`quota_*`, `provider_fail_streak`, `provider_notice`, `oauth_revoked_at`, `oauth_revoked_reason`, `oauth_access_token_expires_at`) are shown, never posted.
- **Credentials** (`LIVE_SET_FIELD_LABELS` = field → `[label, hint]`), masked exactly as payments does:

```php
$fromEnv = $s['source'] === 'env';
$locked  = $fromEnv || !$keyOk;
$place   = match ($s['source']) {
    'env'        => 'Set in the server environment (' . $s['env'] . ')',
    'stored'     => '•••• ' . $s['last4'] . ' (stored)',
    'unreadable' => 'Stored, but it cannot be read with this LIVE_SETTINGS_KEY',
    default      => 'Not set',
};
```

rendered as `<input type="password" autocomplete="off" spellcheck="false" maxlength="300" placeholder="…" [disabled]>`, with a `data-toggle-password="<id>"` reveal button **only** on editable fields and a `remove[<field>]` tick only for `stored` / `unreadable`.
- **Save validation**: an env-sourced field is skipped without ever being stored; `remove` → `null`; blank → skipped; no `LIVE_SETTINGS_KEY` → *"YouTube keys cannot be stored until LIVE_SETTINGS_KEY is set on the server, or put them in the server environment"*; anything over 300 characters, an array, or containing `[\x00-\x1F\x7F]` refused; `client_id` must match `/^[A-Za-z0-9._-]{1,200}$/`; `channel_id` `/^UC[A-Za-z0-9_-]{22}$/` or blank. The save goes through `liveSettingsSaveMany()`, which also does §3.1's credential-change work.
- **Test the YouTube connection** — its own `sr-only` form referenced by `form="test-youtube"` so it never submits the settings form (`payment_settings.php:414,567-573`). It spends real units like any call, so it is refused while the quota breaker is open, counts through `liveQuotaSpend()`, and shares the `live-check-now` bucket below. One refresh-token exchange (Tier 2 only) and one `videos.list` on a syntactically valid but non-existent id: an empty `items[]` **proves the credential works without the page printing it**. `liveProviderConnectionMessage(array $answer): array{tone, text}` maps machine answers to committee sentences and is the vocabulary every `provider_notice` about a call is drawn from — "Connected — YouTube answered.", "No YouTube API key is set.", "Could not reach YouTube. Try again in a moment.", "YouTube is limiting requests; the job will slow down and retry.", "YouTube refused this key (it may be mistyped, expired, restricted to other addresses, or the YouTube Data API v3 is not enabled on the project).", "The refresh token is no longer valid; reconnect the channel.", "Google no longer accepts the saved OAuth client (its secret was rotated or the client was deleted); save the current client id and secret.", "Google sign-in failed; using the API key for now.", "YouTube refused the Google sign-in for this project; using the API key for now.", "YouTube's owner-only broadcast details could not be read; using public video data for now.", "The day's quota is used up; it resets at midnight US Pacific time.", "YouTube rejected the site's request; tell the developer." — and **never echoes the raw response**.
- **Reconnect** — shown only while `oauth_revoked_at` is set: clears it and `oauth_revoked_reason`, runs the credential save's reset `UPDATE … WHERE {liveSyncEligibleWhere()}` (§3.1), and writes one `live_provider_settings` audit row with the detail `reconnect`. The next run tries the token once (§3.3).
- **Disconnect YouTube** — §3.3, with a `data-confirm`.
- **Run a check now** (all due streams) — `liveCronRun(['limit' => 20, 'actor' => $actor, 'trigger' => 'admin'])`; `$summary['locked']` becomes the flash "A check is already going on (the scheduled one). Try again in a minute.", copying `backend/admin/payments.php:209-219`. **Throttled before it runs**: `if (!rateLimitAllow('live-check-now', 30, 3600, $actor)) { … }` refuses with *"You have run a lot of checks in the last hour. The scheduled job is still running normally — try again shortly."* and makes no call.
- **No "why automation last stopped" list.** `provider_notice` is on the status card and the per-row reasons are on the rows; a panel of recent `live_sync_error` rows would be the seed of the monitoring panel Phase 9/11 owns.
- **Audit** — `liveSettingsSaveMany()` writes `live_provider_settings` through `liveAudit()` holding **key names only**.

### 8.4 `backend/admin/live_streams.php` — three additions

1. **Two new branches**, between the `restore` branch (`:213`) and the fallback (`:220`), in the same shape as the others:

```php
} elseif ($msg === '' && $action === 'sync') {
    requireAdminCan('live.publish');
    $id  = (int) $str($_POST, 'id');
    $row = liveLoad($db, $id);
    // Two throttles, both before any provider call; §8.3 shares the second.
    $last  = $row['last_synced_at'] ?? null;
    $since = $last !== null ? max(0, time() - (int) strtotime($last . ' UTC')) : PHP_INT_MAX;
    if ($since < LIVE_POLL_MIN_SECONDS) {
        lsFlash('warning', 'Checked a moment ago — try again in ' . (LIVE_POLL_MIN_SECONDS - $since) . ' seconds.');
    } elseif (!rateLimitAllow('live-check-now', 30, 3600, $actor)) {
        lsFlash('warning', 'You have run a lot of checks in the last hour. The scheduled job is still running normally — try again shortly.');
    } else {
        $summary = liveCronRun(['stream_ids' => [$id], 'limit' => 1, 'actor' => $actor, 'trigger' => 'admin']);
        …lsFlash(…);
    }
    header('Location: ' . $back, true, 303); exit;
} elseif ($msg === '' && $action === 'automation') {
    requireAdminCan('live.publish');
    liveSetSyncEnabled($db, (int) $str($_POST, 'id'), $str($_POST, 'on') === '1', $actor);
    …lsFlash(…);  header('Location: ' . $back, true, 303); exit;
}
```

   `strtotime()` is given the ` UTC` suffix because the column is UTC and PHP's default zone may observe DST; a `last_synced_at` in the future (clock skew) counts as 0 seconds ago. Flashes are one committee sentence: "Checked with YouTube: it is live now — the broadcast is live on the site.", "Checked with YouTube: nothing has changed.", "YouTube did not return that video — it may be deleted, private, or the id may be wrong.", "That video is not a live broadcast.", "That YouTube video does not look like this broadcast — check the video id.", "Automation paused for this broadcast.", "Automation resumed.", "YouTube automation is not configured yet — open YouTube Automation.", and for a call-level outcome "Could not check with YouTube: " + the §8.3 sentence for it — on a row whose automation is off, the only record of that failure, because the row is left byte-identical (§5.3 step 9). Everything passes through `liveRedact()`.

   **Why the button is throttled.** `live.publish` is an editor capability, and a scoped run replaces the `next_sync_at`, `sync_enabled` and window clauses by design (§5.3 step 6), so the per-row cadence does not limit it. Each press costs 1 unit (2 at Tier 2); repeated presses or a page left on auto-refresh could open the quota breaker and stop **all** automation for the Pacific day (G14). The `last_synced_at` floor answers "I pressed it twice"; the hourly bucket, keyed per admin through `rateLimitAllow()`'s `$who` (`rate_limit.php:92`), answers everything else. Both refuse **before** any call.

2. **Two row-menu items**, built by a new pure function in `backend/includes/live/admin.php`, beside `liveAdminActions()`:

```php
/**
 * The automation items a row's menu offers: [] when $installed is false, the
 * row is deleted, or its provider is not youtube; otherwise
 *   ['action' => 'sync',       'label' => 'Check now',           'icon' => 'refresh'],
 *   ['action' => 'automation', 'on' => '0', 'label' => 'Switch to manual',    'icon' => 'toggle']
 *   (or 'on' => '1', 'Switch to automatic', when sync_enabled is 0).
 * $installed is an argument, never read inside, so a test can ask for the
 * "012 not applied" menu without touching the database.
 */
function liveAdminSyncActions(array $row, bool $installed): array
```

   It is a sibling, not a change to `liveAdminActions()`, whose output `tests/live-unit.php:970-975` pins to exactly the legal transitions. `live_streams.php` calls it inside the `if ($canPublish)` branch of the `if (!$deleted)` block (`:602-613`) as `liveAdminSyncActions($row, liveAutomationInstalled())` and renders each item as `['action' => …, 'id' => $rid] (+ 'on') + $formState`; `refresh` and `toggle` are existing icons (`admin_ui.php:80`, `:96`). *Switch to manual* calls `liveSetSyncEnabled()` without `$machine`, so it writes `sync_error = NULL`; *Switch to automatic* is *Resume automation* (§6.4). `adminCsrfGuard()` at `:115` and `csrfField()` at `:61` already cover both. They carry no `name="to"` field, so `tests/admin-live.mjs:363` is unaffected.

3. **A Sync column and an Automation panel — sync state only.** The list gains one column: `Auto` / `Manual`, the relative `last_synced_at`, the `sync_state` in plain English ("YouTube: live", "YouTube: not found"), and a `⚠` with the clipped `sync_error` as its `title`. A row that is `STARTING`, paused, and whose `sync_error` begins `paused: stuck` shows **"stuck — a person must end or cancel this"** as a *danger* badge; the badge disappears as soon as a person ends, cancels or resumes the row. A `sync_error` of class `notice` is shown as the notice, not as an error. The edit view gains a read-only Automation panel: automation on or off (and, for a machine pause, why), last checked (`last_synced_at`), "last good answer from YouTube" (`last_sync_ok_at`), next check, provider state, last error, and **YouTube's scheduled start and end** (`provider_scheduled_start_at` / `provider_scheduled_end_at`, labelled "what YouTube says", beside the committee's own times — the figures a committee member needs to understand a `mismatch`). The two schedules are shown side by side and not compared (§15 item 11). Nothing on the panel is editable. `provider_thumbnail_url`, `viewer_count`, `provider_stream_id` and `recording_url` are shown nowhere. On a site without migration 012 neither the column nor the panel is rendered. No shape function is involved: `liveListAdmin()` already returns raw `s.*` rows.

### 8.5 The admin JSON API

`backend/api/admin_live_streams.php` is **not changed**: no new route, method or key. A JSON *Check now* would need the router regex at `index.php:117` widened and POST added to the item-route whitelist at `admin_live_streams.php:92`; if a later phase needs it, it also adds `sync` to `liveShapeAdmin()` and updates `tests/live-unit.php:864-868` and `tests/live-api.mjs:75-77` in the same change.

---

## 9. The public API — unchanged, and what must never be public

**Nothing changes shape.** `liveShapePublic()` (`store.php:612-668`) and `liveShapeAdmin()` (`:671-685`) are untouched, and so is every `/api/live-streams/*` response, cache header, ordering and error shape. `tests/live-api.mjs`'s `PUBLIC_KEYS` / `ADMIN_KEYS` / `SCHEDULE_KEYS` and `tests/live-unit.php:828-832` / `:864-868` / `:871` need no edit.

What a devotee gets from Phase 3 is only this: the status on `/live-darshan`, the schedule and the homepage becomes right by itself, and `actual_start_at` / `actual_end_at` are the real instants rather than the moment a person clicked. The poster, the player and every other rendered value are exactly as in Phase 2.

**Never public, in any response, any public HTML, any log or any notification:** every column migration 012 adds — `sync_enabled`, `sync_state`, `synced_status`, `last_synced_at`, `last_sync_ok_at`, `next_sync_at`, `sync_attempts`, `sync_error`, `provider_thumbnail_url` (name and value), `provider_scheduled_start_at`, `provider_scheduled_end_at`, `viewer_count` — plus `provider_stream_id`, `recording_url`, every `live_settings` row, every credential, the cached access token, the channel id, the quota figures, the breaker state, and `items[]` from any cron summary.

`tests/live-api.mjs:77` `PRIVATE_KEYS` and the regexes at `:425` and `:828` gain the twelve new names in the same change.

---

## 10. Testing without a Google account

Two ways in, both refused on a real server. One flag governs all of it: **`LIVE_ALLOW_SIMULATOR=1`**, mirroring `PAYMENTS_ALLOW_SIMULATOR`.

### 10.1 The fence, and the test-only doors behind it

`liveSimulatorAllowed()` is `envValue('LIVE_ALLOW_SIMULATOR') === '1'`, and it is the only check for every test-only door in the module. The model is `paySimulatorAllowed()` (`payments/config.php:142`, the fence on `PAYMENTS_SETTINGS_OVERLAY` at `:184`). Payments' own base-URL override is fenced by a mode test instead (`payments/config.php:462-468`), which Phase 3 deliberately does not copy: a mode test would leave the door open on any site that had ever selected the test gateway, whereas `LIVE_ALLOW_SIMULATOR` is absent from every production environment by construction. **With the flag off, every variable below is ignored entirely** (G21):

| Variable | What it does behind the fence |
|---|---|
| `YOUTUBE_API_BASE_URL` / `YOUTUBE_OAUTH_TOKEN_URL` | `liveYoutubeApiBase()` / `liveYoutubeTokenUrl()` use them. A plain-`http` base is accepted only for `127.0.0.1` / `localhost`, where `tests/support/youtube_mock.mjs` listens. This works at `mode = live` too, so the suites exercise the **real** credential-sending path. |
| `LIVE_SETTINGS_OVERLAY` | §10.3. It overlays plain settings only; the OAuth bearer and its expiry are still cached in `live_settings` exactly as in production (§3.1), which the suites' snapshot and restore of that table cover. |
| `LIVE_SYNC_ONLY_TITLE_PREFIX` | part of `liveSyncEligibleWhere()` (§3.1), so it restricts every working set, scoped or not, **and every bulk statement over sync rows** — the credential-save and Reconnect resets included — to rows whose `title_en` starts with the value. **Every suite that sweeps or saves a credential sets it**, so no test ever touches a row it did not create. |
| `LIVE_SIM_FAIL_AFTER_LIVE` | a stream id: `livePollApplyMove()` throws `RuntimeException('simulated failure after LIVE')` as its first statement when `$to === 'COMPLETED'` for that id (§5.1). In a catch-up the first step has already written, and the exception starts inside the second step's own call, so a try/catch wrapped around that call would swallow it — the defect the check exists to catch. It exists for the one check that proves the catch-up rolls back as one (§11.2 section 15). |

`mode = simulator` (§10.2) sits behind the same fence. The stand-in's fixed, obviously fake credentials are `mock-youtube-api-key-not-secret`, `mock-client-id.apps.googleusercontent.test`, `mock-client-secret-not-secret`, `mock-refresh-token-not-secret`, `mock-refresh-invalid-grant` (the token endpoint answers `400 invalid_grant`) and `mock-refresh-unavailable` (it answers a plain-text 500); no real key ever appears in a test file.

### 10.2 `mode = simulator` — in process (the PHP unit suite)

`liveYoutubeSimulate()` answers `liveYoutubeFetchMany()` and the token exchange **in process**, with no socket — exactly why `ccavApi()` answers the payments simulator in process (`payments/ccavenue.php:232-233, :260-262`: the PHP built-in server cannot call itself over HTTP). It is refused without the flag, and the radio is not rendered on a normal server.

Scenarios in both stand-ins are chosen by the **last four characters of the video id**, extending the convention `youtube_mock.mjs:18-24` already uses. Instants are relative to the stand-in's own clock at the moment of the request, so the grace, window and same-broadcast checks work on any day; the Node mock lets `mock.setVideo()` override any of them.

| Suffix | Behaviour | Default instants |
|---|---|---|
| `0404` | 200 with the id omitted from `items[]` → `missing` *(existing)* | — |
| `0429` | 429 `rateLimitExceeded` + `Retry-After: 30` *(existing)* | — |
| `0500` | 500, plain text *(existing)* | — |
| `0403` | 403 `quotaExceeded`, domain `youtube.quota` *(existing)* | — |
| `0401` | 401 `authError` on every request for the id | — |
| `UPCM` | `liveBroadcastContent = upcoming` | `scheduledStartTime` now + 5 min |
| `STRT` | Tier 2 `lifeCycleStatus = testing` (Tier 1 sees `upcoming`) | `scheduledStartTime` now + 5 min |
| `LIVE` | `live`, `concurrentViewers` present | `scheduledStartTime` and `actualStartTime` now − 5 min |
| `HIDE` | as `LIVE`, `concurrentViewers` omitted | as `LIVE` |
| `DONE` | `none` with both actual instants, `recordingStatus = recorded` | `scheduledStartTime` and `actualStartTime` now − 15 min, `actualEndTime` now − 5 min |
| `PRIV` | as Google does it: **omitted from `items[]` for a `key=` request** (Tier 1 sees `missing`); returned with `privacyStatus = private` only to a valid bearer (Tier 2) | as `LIVE` |
| `NOEM` | `embeddable = false` | as `LIVE` |
| `NOLS` | a plain uploaded video: no `liveStreamingDetails` | — |
| `RVOK` | Tier 2 `lifeCycleStatus = revoked` | as `UPCM` |
| anything else | **`not_broadcast`** — a public, embeddable video with `liveBroadcastContent = 'none'` and no `liveStreamingDetails` | — |

The last row is the existing mock's behaviour stated honestly: `videoItem()` defaults `liveBroadcastContent` to `"none"` (`youtube_mock.mjs:98`) and emits `liveStreamingDetails` only when it has something to put in it (`:127`). So **every fixture in §11 carries an explicit suffix from this table**; an unsuffixed fixture is asserting `not_broadcast`. `liveYoutubeSimulate()` implements the same table and defaults, so the PHP and Node stand-ins answer any id identically. Unless a check says otherwise, fixtures are scheduled so these defaults pass G24: `UPCM`, `STRT` and `RVOK` fixtures start 5 minutes from now, `LIVE`, `HIDE`, `PRIV` and `NOEM` fixtures start now, and `DONE` fixtures started 15 minutes ago. A check that needs other instants sets them with `mock.setVideo()` in Node; in the PHP suite it calls `livePollStream()` with a fact that `liveYoutubeFacts()` builds from a hand-made item (§11.2). `liveYoutubeSimulate()` has no per-id instant override.

### 10.3 `LIVE_SETTINGS_OVERLAY`

A JSON object of **non-secret** setting keys overlaying `live_settings` for that PHP process, behind the fence. Secret keys in the overlay are ignored. Mirrors `PAYMENTS_SETTINGS_OVERLAY` (`payments/config.php:178-197`). The suites share one database, and a `live_settings` row left behind would flip `live-api.mjs`, `live-ui.mjs` and `og.mjs` into "provider configured".

### 10.4 Six additions to `tests/support/youtube_mock.mjs`, and no more

1. **Per-id scenario resolution over the whole §10.2 table.** `scenarioOf()` (`:59-62`) returns every tail in the table instead of its four (`["0404","0429","0500","0403"]`), and `"ok"` for anything else. `videoItem()` (`:96-129`) derives its defaults — `liveBroadcastContent`, the instants relative to `Date.now()`, `concurrentViewers`, `privacyStatus`, `embeddable` and the Tier 2 fields — from that scenario **when `mock.videos` holds no override for the field**; `mock.setVideo()` still wins field by field, and the `"none"` default (`:98`) and the conditional `liveStreamingDetails` (`:127`) are untouched. `handleVideos` derives the scenario from `ids[0]` alone today (`:164`); instead each id contributes its own item or omission — a `PRIV` id is omitted unless the request carries a valid bearer — and a whole-response error (429 / 500 / 403 / 401) is returned only when **every** requested id carries that scenario.
2. **`mock.failNext(id, times, scenario)`** — the same id fails N times with that scenario's answer, then answers normally.
3. **Bearer and token control** — `videos.list` accepts **either** `?key=` **or** `Authorization: Bearer` (it checks only `key` today, `:159`); an unknown or stale bearer answers `401 authError`; `startYoutubeMock({ tokenTtl })` replaces the hard-coded `expires_in: 3599` (`:186`); `/token` answers `400 {"error":"invalid_grant"}` for `mock-refresh-invalid-grant`, a plain-text 500 for `mock-refresh-unavailable`, keeps its existing `401 invalid_client` for a wrong client secret (`:182-183`), and may return a rotating `refresh_token`. The wrong-key answer stays exactly `400 badRequest "API key not valid. Please pass a valid API key."` (`:159-160`), which §4.2 classifies as `auth`.
4. **Viewer control** — `mock.setVideo(id, { concurrentViewersSeq: [...] })` for a rising count across polls and `{ hideViewers: true }`. `setVideo` also accepts `thumbnails`, `channelId`, `lifeCycleStatus`, `recordingStatus` and `boundStreamId`, and a new `GET /youtube/v3/liveBroadcasts` route serves them.
5. **Full header capture** in `mock.requests[]` (it keeps only `authorization` and `user-agent`, `:199`), so a check can prove the API key never travels in a header, plus `mock.quotaUnits`.
6. **A batch guard**: more than 50 ids → `400 badRequest` (class `request`), so the poller's batching is pinned.

There is deliberately **no** `mock.failAll()`: item 1 already gives a whole-response error when every requested id carries the same tail, which is how the real API behaves. A builder who wants a seventh addition writes it in their report and does not add it.

### 10.5 Four additions to `tests/support/live_fixtures.php`

The existing `sql {query, params}` command (`live_fixtures.php:289-294`) already covers every direct read and write a suite needs — the `live_settings` snapshot and restore, clearing the quota rows, the `provider_notice` sentinel, pre-filling a rate-limit bucket — so no settings command is added.

- `sync {ids?: [], limit?: int, actor?: string, dry_run?: bool}` → `liveCronRun()`'s whole result, as `payments_fixtures.php`'s `sweep` does (`:228-234`). The suites pass `actor: "e2e-live-sync"`, so every audit row a sweep writes outside a `Stream #<id>` subject is removable by actor.
- `due {ids: [], attempts?: int}` → sets `next_sync_at = NULL` on exactly the named rows, and `sync_attempts` to `attempts` when given. A scoped run ignores `next_sync_at` already; `due` is for the checks that must prove an **unscoped** sweep selects a row again after a back-off (§11.3 item 2), which would otherwise wait minutes, and for reaching G15's threshold without eleven runs. It is **scoped and never global** — an empty or absent `ids` is an error (the rule of G17) — and it deliberately leaves `last_synced_at` alone, so it never defeats *Check now*'s floor.
- `hold-lock {seconds}` → takes `SELECT GET_LOCK('temple_live_cron', 0)`, prints `{"locked":true}` on its own line as soon as it returns 1, then holds it for `seconds`, so the "another run holds the lock" path is proved from a second process without a test hook in production code.
- `cleanup` gains `actors: []` — exact actor names, each starting `e2e` — and removes `admin_activity` rows **only** by those actor names or, as today, by the fixture stream ids (`Stream #<id>`); never by a subject such as `YouTube automation`, which real rows share. With `admin_prefix` it also removes `rate_limits` rows whose bucket is `live-check-now:` + that prefix + `%`, because that bucket is keyed by admin name, not by the IP the existing `ips` clause matches (`:347-351`).

---

## 11. Test plan

Conventions unchanged: plain Node and plain PHP, no framework, `N passed, M failed`, a non-zero exit, a port-in-use preflight that exits 2, cleanup at the start **and** in `finally` with a "0 left" assertion, Windows children killed with `taskkill /T /F` plus the `netstat -ano` sweep `live-api.mjs:154-168` already needs, and never reporting a check as passed without running it. The user's own dev servers (PHP :8000, Vite :5173/:5174) are never stopped, reconfigured or posted to.

**Tests never touch a row they did not create.** Every sweep and every credential save or Reconnect runs with `LIVE_SYNC_ONLY_TITLE_PREFIX` set to the suite's own title prefix, which `liveSyncEligibleWhere()` applies to all of them; unscoped checks assert only on the suite's own ids and rows in `items[]`, `mock.requests` and the database, never on totals; audit rows are removed only by the suite's actor names or fixture ids; `live_settings`, the one shared table a suite must write, is snapshotted at the start and restored in the final `finally` with an assertion, as `tests/admin-payments.mjs:333-340` / `:1117-1125` does for `payment_settings`; and the one check that needs a database without migration 012 uses a scratch database it creates and drops itself (§11.3 item 1). Nothing ever alters the shared schema.

### 11.1 New reservations

| Thing | Value |
|---|---|
| New suite | `tests/live-sync.mjs` |
| PHP port | **8084** (a second, keyless server for §11.3 item 6 on **8085**) |
| Mock port | **8092** |
| XFF lane | **10.84.0.160–199** (between `admin-live.mjs`'s .100–159 and `live-ui.mjs`'s .200–249) |
| Fixture titles | `E2E-LIVE-sync<run>`, cleanup prefix and `LIVE_SYNC_ONLY_TITLE_PREFIX` `E2E-LIVE-sync` |
| Out-of-scope control rows | `E2E-LIVE-xsync<run>`, cleaned with the prefix `E2E-LIVE-xsync` — outside the scope prefix, so they prove what a sweep or reset must not touch |
| Scratch database | `<DB_NAME>_e2e_empty`, created and dropped by §11.3 item 1 |
| Actor | `e2e-live-sync` |
| Admin accounts | `e2e_lives_owner`, `e2e_lives_editor`, `e2e_lives_viewer`, prefix `e2e_lives_` |
| Regression servers (§12) | the builder's own PHP on **8088** and Vite on **5195** proxied to it — every §12 suite that takes a server address is pointed at these, never at the user's :8000 or :5173 |

`tests/README.md:119` documents what is taken today — "ports **8081–8083**, the YouTube stand-in on **8091**" — and `docs/live/SPEC-PHASE1.md:177` names 8081–8083 individually; nothing reserved a wider range, so 8084, 8085 and 8092 are **claimed here**, and §11.4's `tests/README.md` edit records them. 8088 is claimed here for §12's regression server (no suite under `tests/` uses it); 5195 is `live-ui.mjs`'s own Vite port (`tests/live-ui.mjs:79`), borrowed by §12 only while `live-ui.mjs` is not running. The payments suites keep their own ports (8060–8079, 5190), which §12 runs them on, and the user's servers are untouched.

### 11.2 `tests/live-unit.php` — four new sections, three amended

**The preamble, before anything is loaded.** For every key of `getenv()`, `$_ENV` and `$_SERVER` that matches `/^(YOUTUBE_|GOOGLE_)/`, or is `LIVE_SETTINGS_KEY`, `LIVE_CRON_KEY`, `LIVE_ALLOW_SIMULATOR`, `LIVE_SETTINGS_OVERLAY`, `LIVE_SYNC_ONLY_TITLE_PREFIX` or `LIVE_SIM_FAIL_AFTER_LIVE`: `putenv($k); unset($_ENV[$k], $_SERVER[$k]);`. `putenv('X=')` alone cannot hide a variable, because `envValue()` treats `''` as unset and falls back to `$_ENV` and `$_SERVER` (`helpers.php:157-163`), which in the CLI carry the developer's shell. Then:

```php
putenv('LIVE_ALLOW_SIMULATOR=1');
putenv('LIVE_SETTINGS_OVERLAY={"mode":"off"}');
putenv('LIVE_SYNC_ONLY_TITLE_PREFIX=' . $NAME);   // this run's rows only; set once $NAME exists (live-unit.php:109)
// LIVE_SETTINGS_KEY must decode to exactly SODIUM_CRYPTO_SECRETBOX_KEYBYTES = 32 bytes:
//   'e2e-' 4 + 'live-' 5 + 'unit-' 5 + 'fake-' 5 + 'settings-' 9 + 'key!' 4 = 32.
putenv('LIVE_SETTINGS_KEY=' . base64_encode('e2e-live-unit-fake-settings-key!'));
```

**The file-top overlay is `mode = off`, and only sections 12–15 switch it.** In `simulator` mode `canAutomate()` is true and `fetchStatus()` stops returning the literal, so a file-wide `simulator` would break `tests/live-unit.php:309-310` (which must pass **unedited**, §14 item 21) and this section's own "`canAutomate()` is false by default" check. Sections 12–15 each set their own overlay with `putenv('LIVE_SETTINGS_OVERLAY=' . json_encode($o)); liveConfigReset();` and restore the `off` overlay (and call `liveConfigReset()` again) in a `finally`; a section that needs a different setting puts it in that overlay. Each of those sections also snapshots `live_settings` at its start and restores it in the same `finally`. Their sweeps run with actor `e2e-unit` (`live-unit.php:111`), and `unitCleanup()` (`:119-137`) additionally removes `admin_activity` rows whose actor is exactly `e2e-unit`. Rows the sections change directly — `next_sync_at`, `sync_attempts`, `last_sync_ok_at`, a temple's `is_active` — are always the run's own rows and its own temple. Where a check needs a row the scope must **not** reach, it creates a run-owned control row whose title starts with `{$PREFIX}-` but not with `$NAME` — `E2E-LIVE-UNIT-_ctl-<run>`; the `_` is escaped in the scope's `LIKE` and can never begin `$run` — which `unitCleanup()` still removes.

**Instants.** Section 15's sweeps use the stand-in's default instants (§10.2), so their fixtures are scheduled as §10.2 says unless the check names another start that those defaults also pass (the walk's, for one). A check that needs other YouTube instants calls `livePollStream($db, $row, liveYoutubeFacts($item), $cfg, 'e2e-unit')` with a hand-made `videos.list` item instead of sweeping.

Amended: **2b/2c** — `tests/live-unit.php:240` (`isConfigured()` is true) and `:309-310` (`fetchStatus()` is exactly `['ok' => false, 'error' => 'not configured']`) **stay as they are and pass unedited**; new checks beside them assert `canAutomate()` is false for all four providers in that default state. **8** — unchanged; `:871` is re-proved after the poller starts writing `provider_stream_id`. **10** (admin helpers, `:942`) — the existing `liveAdminActions()` checks at `:970-982` are untouched; new checks assert `liveAdminSyncActions($youtubeRow, false) === []` (the menu on a database without 012, with nothing in the database changed), `[]` for a deleted row and for a `custom` row even with `true`, exactly *Check now* and *Switch to manual* with `true`, and *Switch to automatic* when `sync_enabled = 0`.

New:
- **12. Settings and secrets.** First, `ok(liveSettingsKey() !== null, 'the test LIVE_SETTINGS_KEY decodes to 32 bytes')`. Then: `liveSettingsKey()` against missing (the variable removed from `putenv`, `$_ENV` and `$_SERVER` for that case, then put back) / non-base64 / 31-byte / 33-byte values, all `null`; `liveSecretEncrypt()` throws naming `LIVE_SETTINGS_KEY` when the key is missing; round trip; `sbx1:` prefix; a tampered ciphertext decrypts to `null`; `liveCredential()` prefers the environment; `liveCredentialStatus()` reports `env` / `stored` / `unreadable` / `none` with a `last4` whose full value never appears; `liveSettingSave()` throws on an unknown key; `liveSettingsSaveMany()` returns key **names**, audits names only, and — with a credential changed — deletes the `oauth_access_token` row, blanks `oauth_access_token_expires_at` and clears `oauth_revoked_at` and `oauth_revoked_reason`; **`liveConfigReset()` writes and deletes nothing** (a `SELECT * FROM live_settings` before and after is identical); `liveAutomationTier()` 0 / 1 / 2, and **1 when the trio is complete but `oauth_revoked_at` is set**; `liveAutomationReady()` reasons in every off state; `liveRedact()` removes an API key, a `key=` query string and a refresh token, and returns a string rather than throwing when reading the credentials throws; `livePacificDay()` / `liveQuotaResetAtUtc()` across the PT boundary and a DST change; `liveQuotaSpend()` opening the breaker at `daily_quota_units`; `liveProviderNoticeSet()` storing through `liveRedact()` (a notice containing `key=AIzaSyFAKE…` and the configured key comes back with neither) and writing no `admin_activity` row; `liveProviderFailStreak()` counting up, resetting to 0 on `null` while leaving the `$notice` it was given (an empty one clears), and writing `provider_notice` once across three failures of one class; `liveSyncEligibleWhere()` carrying the `:sync_prefix` clause bound to this run's escaped `$NAME` under the preamble, carrying none with `LIVE_ALLOW_SIMULATOR` removed for that case, and never naming `sync_enabled`.
- **13. The client.** `liveYoutubeInstant()` on `2026-09-16T10:30:00Z`, a fractional-second form, an offset form, rubbish and null; `liveYoutubeFacts()` for every §10.2 scenario, including an unrecognised suffix → `not_broadcast`, `unlisted` → not `restricted`, and a Tier 2 private video with `lifeCycleStatus = live` → still `restricted`; `liveYoutubeSimulate()` omitting a `…PRIV` id for a `key=` request and returning it as private for a bearer; `liveYoutubeClassify()` for **every row of §4.2's table**, asserting class, scope and outcome — in particular `400 badRequest "API key not valid. Please pass a valid API key."` → `auth`, a `400 badRequest` with any other message → `request`, `403 accessNotConfigured` → `auth`, a plain-text 500 → `unreachable`, and a 418 → `request`; with `$token = true`, `invalid_grant` and `invalid_client` → `auth`, and status 0, 429, 500, a 200 with no `access_token` and `400 unsupported_grant_type` → `transient`, never `auth`; `liveRetryAfterSeconds()` on delta-seconds, an HTTP-date and a bad value; the chunker at 50, 51 and with duplicates; an id missing from the response becoming `missing`; two rows sharing one video id both answered; the token cache refreshing at `expires_in - 300`; **a grep that no file under `backend/includes/live/` contains `search.list` or builds a `/search` URL**.
- **14. The decision function.** `livePollDecide()` and `liveProviderMatchesSchedule()` are pure, so every cell of §6 is a direct assertion, and every returned outcome is asserted to be a member of `LIVE_SYNC_OUTCOMES` (whose 23 words are pinned). Each legal move with its outcome word; each move a switch forbids (`held`); row 1's window either side at both ends; the grace either side; `missing` / `restricted` / `not_broadcast` / `revoked` / `unknown` producing no move; the forward-only rule; the catch-up → `to = LIVE, then = COMPLETED`, `ended`; and every decided pair is in **both** `LIVE_AUTO_TRANSITIONS` and `LIVE_TRANSITIONS`. Then:
  - **§6.4's order and the baseline.** `sync_enabled = 0` → `paused` with `pause` null; a backwards move with an agreeing `upcoming` fact → `paused` with `pause = 'person'`; a forward move → `overridden`; `synced_status` NULL, and `synced_status = 'DRAFT'`, each with status SCHEDULED and a matching `live` fact → `live` in that same pass, run under an error handler that fails the check on any PHP warning or notice.
  - **G24 — "the morning video in the evening row".** Row `scheduled_start_at = 2026-09-17 12:30:00` (18:00 IST), `now = 12:00:00` (17:30 IST), fact `scheduled_start = 01:00:00` (06:30 IST), `actual_start = 01:02:00`, `actual_end = 02:10:00`: `mismatch`, with notice N3, for the SCHEDULED catch-up and for the same row set LIVE (row 4). **Partial evidence, by §1's rule** (`mismatch` only when a move's evidence is present and the match is false): `liveProviderMatchesSchedule()` is false for the fact reduced to only `scheduled_start` and for the fact reduced to only `actual_start` — each time check refuses it on its own. Through `livePollDecide()`: with only `scheduled_start` present on an `upcoming` fact, `now = 12:25` (inside the row's starting window), row 1 is `mismatch`; with only `actual_start` present on a `live` fact, row 2 is `mismatch`; and a SCHEDULED row whose fact lacks `actual_end` has no catch-up evidence, so neither reduction is a `mismatch` through the catch-up — it is `unchanged` (and the row set LIVE, with no `actual_end` for row 4, gets N4, not `mismatch`). No check forces `mismatch` where the rule gives `unchanged`. The bounds: `scheduled_start` 20 min either side matches and 21 min does not; `actual_start` at start − 60 min and at start + 3 h matches, at start − 61 min and start + 3 h 1 min does not; `actual_end` at the start matches and at start − 1 min does not. A `live` fact whose `actual_start` is 00:25 UTC (05:55 IST, an all-day stream) against a SCHEDULED row at 04:30 UTC (10:00 IST), `now` 04:00 → `mismatch`. A `channel_expected` that differs from `channel_id` → `mismatch`.
  - **G24 — "the suprabhatam in the abhishekam row".** Row `scheduled_start_at = 2026-09-17 01:00:00` (06:30 IST); the 06:00 suprabhatam's video has `scheduled_start = 00:30:00` (06:00 IST), `actual_start = 00:28:00` (05:58 IST) and `actual_end = 00:55:00` (06:25 IST), and its `actual_start` passes (b). It is `mismatch`, with N3, for **row 1** (SCHEDULED, an `upcoming` fact, `now = 00:52`, inside the row's starting window), **row 2** (SCHEDULED, a `live` fact, `now = 00:52`), **row 4** (the row set LIVE, an `ended` fact, `now = 00:58`) and **the catch-up** (SCHEDULED, an `ended` fact, `now = 00:58`) — each twice, on hand-made facts that carry that move's evidence and `actual_start` 00:28: **by (a) alone** — `scheduled_start` 00:30 kept, and no `actual_end`, or, where the move needs one (row 4, the catch-up), `actual_end = 01:01` with `now = 01:04`, so (d) passes — and **by (d) alone** — `scheduled_start` removed, `actual_end` 00:55 kept. `liveProviderMatchesSchedule()` is false for all eight facts.
  - **G22 exactly.** A `STARTING` row past `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS` with an `upcoming`, `not_broadcast` or `missing` fact → `paused`, `pause = 'machine'`, the stuck reason. The same row with a `restricted`, `ended`-without-`actual_end`, Tier 2 `starting`, `revoked` or `unknown` fact → no pause, notice N5. With an `ended` fact whose `actual_end` is 60 s old → `unchanged`, no pause, no notice; with `actual_end` 180 s old → `ended` (the catch-up). With a matching `live` fact → `live`; the same with `auto_start = 0` → `held`, no pause, no notice. The same `upcoming` fact one minute inside the grace → `unchanged`, no pause.
  - **Notice positions.** A SCHEDULED row one minute before its start with a `missing` fact → `not_found` with notice N1; with `restricted` → `restricted` with N2. The same two facts one minute after its start, and on a STARTING row one minute before and one minute after its start, give the same notices, each with `liveSyncNextAt()` 60 s (the position cadence, not a back-off). One minute past `scheduled_start_at + LIVE_UPCOMING_GRACE_HOURS` the SCHEDULED row's two facts are row failures (`notice` null), and the STARTING row's `missing` fact is G22's pause and its `restricted` fact N5. A `LIVE` row at start + 10 h with `scheduled_end_at` NULL and a `live` fact → `unchanged`, no pause, no notice. A `LIVE` row with an `ended` fact and no `actual_end` → `unchanged` with N4; with an `upcoming` fact → no notice inside the grace and N4 past it; with a `missing` fact → `not_found` with N4.
  - **`liveSyncNextAt()`** for **every row of §5.5**, including a SCHEDULED row 30 min past its start (60 s), 4 h past (900 s), 20 min before its start (300 s), an N1 row 20 min before its start (300 s, not a back-off), a LIVE row carrying a notice at start + 2 h (60 s) and at start + 4 h (900 s), a LIVE row without one at start + 10 h (60 s), `paused` and `ended` (`NULL`), and `quota` (exactly `quota_blocked_until`).
  - **The two words no sweep produces.** `refused` is unreachable because of the pair check above. `not_configured`: `liveCronRun()` called with the overlay set to `mode = off` (then restored) returns `skipped = 1`, `checked = 0` and an empty `items[]`, so no row ever reaches that word. Both stay in the pinned list.
- **15. The sweep on real rows**, under this section's `simulator` overlay (with `auto_starting = 1`). Successive `livePollSweep()` calls walk `SCHEDULED→STARTING→LIVE→COMPLETED` on a `…UPCM` fixture that **started 6 minutes ago** — inside `starting_lead_minutes`, so row 1 moves it; a start still ahead would make the walk's last step a `mismatch`, because the `…DONE` video's `actualEndTime` (now − 5 min) would precede the row's start (G24 (d)) — whose video is switched between scenarios (`…LIVE`, then `…DONE`) by a direct SQL write of its `provider_broadcast_id` between passes — not `liveUpdate()`, which would reset the row; `actual_start_at` / `actual_end_at` carry the stand-in's instants and are not re-stamped; an `$at` of `'not a date'`, `''` or `'2026-02-31 25:61:61'` falls back to `$now`; exactly one `live_stream_status` row per real change and none for an unchanged poll; DRAFT / COMPLETED / CANCELLED / OFFLINE / ERROR / deleted / non-YouTube rows, each starting now (inside every window, so only its status, deletion or provider keeps it out), are never selected; a `…LIVE` row starting now with `sync_enabled = 0` is skipped by the sweep and reports `paused` when scoped; the 30-second floor against an overlay `poll_seconds_live` of 5 (a `…LIVE` row starting now is due again 30 s after its move); `liveBackoffSeconds()` steps, jitter bounds, `Retry-After` winning, and **an overlay `backoff_max_seconds` of 120 behaving as 300**; a scoped run with an empty id list touches nothing; a quota answer sets `quota_blocked_until` and the next sweep makes no call; `viewer_count` set while live and frozen (not zeroed) when the field is absent and at the end, on the walk's row (started 6 minutes ago, so its `…DONE` end passes G24 (d)), and **no `viewer_count_at` column** (`SHOW COLUMNS`, which also pins the twelve); `recording_url` written once at COMPLETED (the walk's row) and **not** when `archive_enabled = 0` (a SCHEDULED `…DONE` row that started 15 minutes ago); `provider_thumbnail_url` stored and `YouTubeProvider::thumbnailUrl()` still `hqdefault.jpg` for that row; `provider_scheduled_start_at` stored while `scheduled_start_at` stays byte-identical. Then the named checks:

  - **G5 and the catch-up disjunct**, with `liveListDueForSync($db, [])` — no `stream_ids`, because a scoped run drops the window clauses, catch-up disjunct included. A SCHEDULED `…DONE` row that started 9 h ago and ended 8 h ago (`scheduled_end_at` `stale_hours + 2` h past, start inside `catchup_hours`) is selected with every sync column NULL, and **is still selected** after `sync_state = 'upcoming'`, `last_sync_ok_at` and `last_synced_at` are written as if a check had answered before an outage; the same row with `next_sync_at` an hour ahead is not; the same shape whose start is `catchup_hours + 1` h past is not; a SCHEDULED row starting `lead_minutes + 5` min from now is not. `livePollStream()` with a fact whose instants match that row (actual start = its start + 2 min, actual end = its end) then completes it in one pass with two audit rows.
  - **G22 and D1.** A SCHEDULED `…UPCM` row whose start is `catchup_hours + 1` h past is not selected (with `auto_starting = 1`, so the check cannot pass for the wrong reason); one two hours past inside the horizon is selected, not moved, and due again in about 60 s (inside the grace); one four hours past is due again in about 900 s; one five minutes away is moved. A `STARTING` `…UPCM` row whose start is `LIVE_UPCOMING_GRACE_HOURS + 1` h past keeps `STARTING`, ends with `sync_enabled = 0`, one `live_sync_paused` row, a `paused: stuck` error and `next_sync_at` NULL, and is absent from the next working set. A `STARTING` `…NOEM` row (a `restricted` fact) of the same age keeps `STARTING` and `sync_enabled = 1`, gets a `notice:` error with `sync_attempts = 0`, and is due again in about 900 s. **And the four negatives:** a `LIVE` row that started 8 h ago and whose `scheduled_end_at` is `stale_hours + 1` h past, given an `ended` fact matching its start (`scheduled_start` = its start, actual start = its start + 2 min, actual end = now − 5 min), ends `COMPLETED` and is not paused; a `STARTING` row whose start is `LIVE_UPCOMING_GRACE_HOURS + 1` h past, given an `ended` fact matching its start (actual start = its start + 2 min) whose end is 5 min old, completes through the catch-up and is not paused (both through `livePollStream()`, §11.2 "Instants"); a `LIVE` `…LIVE` row started 10 h ago with `scheduled_end_at` NULL is neither moved nor paused and is due again in about 60 s; a `STARTING` `…0500` row whose start is `LIVE_UPCOMING_GRACE_HOURS + 1` h past (a call failure) is not paused and its `sync_attempts` stays 0.
  - **G23.** On a `…LIVE` row starting now, `livePollStream()` is called with a snapshot saying `STARTING` / `synced_status = STARTING` while the database row has been moved to `SCHEDULED` behind it (write the row, then pass the stale array): the outcome is `overridden`, `status` is still `SCHEDULED`, **`synced_status` is still `STARTING`**, every column but `last_synced_at` is byte-identical, and no `live_stream_status` row was written. **The following sweep**, with the fact still `…LIVE`, leaves the row `SCHEDULED`, `sync_enabled = 0`, `sync_error` NULL, with one `live_sync_paused` row (G8). The forward twin — snapshot `STARTING`, row moved to `LIVE` by hand — gives `overridden` twice: once from G23, then from §6.4 step 3 with `synced_status = LIVE`. A snapshot whose `provider_broadcast_id` or `sync_enabled` differs from the row's is abandoned the same way. A matching snapshot performs the move.
  - **G8 on a row the job never moved.** A `…UPCM` row **starting two hours from now** — outside `starting_lead_minutes`, so `auto_starting = 1` cannot move it; outside `lead_minutes` too, so every check below is a sweep scoped to its id — checked once (`synced_status = SCHEDULED`), moved `SCHEDULED → STARTING` by `liveSetStatus()` as a person, checked (`overridden`, baseline `STARTING`), moved back to `SCHEDULED`, checked: `paused`, with `sync_error` NULL (a person's pause).
  - **Resume (D5).** That paused row, after `liveSetSyncEnabled($db, $id, true, 'e2e-unit')`, has `synced_status = SCHEDULED`, `sync_attempts = 0`, `sync_error` NULL, `next_sync_at` NULL and one `live_sync_resumed` row; the next sweep leaves `sync_enabled = 1` and writes no second `live_sync_paused` row.
  - **G9.** A `…LIVE` row starting now on the run's own temple, with that temple deactivated, reports `not_ready`, keeps `SCHEDULED`, has a `config` error and `sync_attempts = 1`; the temple is reactivated in a `finally`.
  - **G15 and the call-level rule**, each run scoped to the ids under test (a scoped run ignores `next_sync_at`, so no clock needs rewinding, and still batches its ids into one call). Twelve `…0404` failures on a row whose start is `LIVE_UPCOMING_GRACE_HOURS + 1` h past (inside the grace they would be notices, N1) pause the row with one `live_sync_paused` row and a `paused: after 12 failures` error; eleven do not (and `sync_attempts = 11` set directly reaches the threshold in one more run). Twelve runs over rows that are all `…0500` leave `sync_enabled = 1` and `sync_attempts = 0` on every row and write no `live_sync_paused` row; after the **first** of them `provider_notice` is overwritten with a sentinel, and after the twelfth the sentinel is still there — the notice was written once.
  - **The catch-up rolls back as one (D15, E11).** With `LIVE_SIM_FAIL_AFTER_LIVE` set to the id of a SCHEDULED `…DONE` row that started 15 minutes ago, the sweep reports `error`; the row is **still `SCHEDULED`**, `actual_start_at` is **still NULL**, `admin_activity` gained **no** `live_stream_status` row for it, `sync_attempts = 1`, and its `sync_error` contains `simulated failure after LIVE` — the throw that only the second step's `livePollApplyMove()` call raises, so the first step had run. With the variable removed (in a `finally`) and the row made due, the next sweep completes it with two audit rows. A try/catch placed around a `livePollApplyMove()` call inside the outer transaction would leave the row `LIVE` and fail this check.
  - **A dry run writes nothing (D6).** A `dry_run` sweep over a SCHEDULED `…DONE` row that started 15 minutes ago reports `dry_run` with `would = ended`; every column of the row is byte-identical afterwards, `admin_activity` is unchanged, and `live_settings` differs only in `quota_units` / `quota_day`. The real sweep that follows still completes it in one pass.
  - **A new video resets the row (D7, E7).** On a row the sweep has checked, `liveUpdate()` with a changed `provider_broadcast_id` leaves every §2.2 column at its "reset on a new video" value — `synced_status` NULL included — and `provider_stream_id` and `recording_url` NULL; a `liveUpdate()` that changes only `description_en` leaves every sync column as it was. **A machine pause is lifted:** a row paused by G15 — the G15 check's own row, whose start is `LIVE_UPCOMING_GRACE_HOURS` + 1 h past, so its `…0404` answers are failures and not N1 notices (§5.5); or one paused by a direct SQL write of `sync_enabled = 0` and `sync_error = 'paused: after 12 failures: …'` — (`sync_enabled = 0`, `sync_error` beginning `paused:`) given a new id ends with `sync_enabled = 1`, `sync_error` NULL and `next_sync_at` NULL. **A call-level failure does not erase the marker (F1):** before its new id, that machine-paused row is given a `…0500` video id by a direct SQL write (not `liveUpdate()`, which would lift the pause) and checked by a scoped sweep over its id — what *Check now* runs — whose call the stand-in answers with a 500; every column of the row is byte-identical to what it was before that sweep, `sync_error` still beginning `paused:` and `last_synced_at` included, and the corrected video id given next through `liveUpdate()` still lifts the pause as above. **A person's pause is kept:** a row paused through `liveSetSyncEnabled($db, $id, false, 'e2e-unit')` (`sync_error` NULL) given a new id keeps `sync_enabled = 0`.
  - **A draft published by a person (E6).** A DRAFT row starting now, created with no video id, gets a `…LIVE` id through `liveUpdate()`, is moved to SCHEDULED by `liveSetStatus()` as a person, and the first sweep moves it to LIVE with no `paused` outcome, under an error handler that fails the check on any PHP warning or notice; `synced_status` is `LIVE` afterwards.
  - **Credentials clear the back-off, inside the scope only (D12, E4).** Two rows with a call-level `next_sync_at` an hour out — one of this run, one control row `E2E-LIVE-UNIT-_ctl-<run>` — then `liveSettingsSaveMany()` saves a new API key: the run's row has `next_sync_at` NULL, the control row's `next_sync_at` is byte-identical, and `provider_fail_streak` is 0.

---

### 11.3 `tests/live-sync.mjs` — the new suite (PHP 8084, mock 8092)

Starts the mock **before** the PHP server — `phpEnv()` is built at spawn time and the base URLs must already be in it — with `apiKey` and `clientSecret` set to the stand-in's fake values (§10.1), and keeps it open for the whole run. Every PHP child (server and fixtures) gets an environment built by stripping `/^(LIVE_|YOUTUBE_|GOOGLE_)/i` from `process.env` and then setting `LIVE_ALLOW_SIMULATOR=1`, `YOUTUBE_API_BASE_URL`, `YOUTUBE_OAUTH_TOKEN_URL`, `LIVE_CRON_KEY`, `LIVE_SETTINGS_OVERLAY` (`mode = live`, `auto_starting = 1`), `LIVE_SYNC_ONLY_TITLE_PREFIX=E2E-LIVE-sync`, `YOUTUBE_API_KEY=mock-youtube-api-key-not-secret`, and a fake `LIVE_SETTINGS_KEY` from its own 32-byte literal — `Buffer.from("e2e-live-sync-fake-settings-key!").toString("base64")` (`'e2e-' 4 + 'live-' 5 + 'sync-' 5 + 'fake-' 5 + 'settings-' 9 + 'key!' 4 = 32`). Tier 2 checks add the three mock OAuth values to a fixture child's environment only. At the start, after the pre-run cleanup, it snapshots `live_settings` through the `sql` fixture; the final `finally` restores it and asserts the table matches the snapshot. Every sweep a check starts through the `sync` fixture passes `actor: "e2e-live-sync"`, and cleanup passes `actors: ["e2e-live-sync"]` and runs once for each title prefix of §11.1.

1. **The CLI job.** `runPhpAsync(["backend/bin/live_cron.php", "--stream-ids=<csv>", "--json"])` + `lastJson()` + `notePhpNoise("live_cron", …)` — never `spawnSync`, because the mock answering the run lives in the same Node process. `--help` exits 0; an unknown flag exits 1 with the message on stderr; `--stream-ids=` (empty) checks nothing; `--dry-run` on a `…LIVE` fixture starting now prints its would-be move, leaves every column of the row byte-identical and writes no audit row; **the cadence**: a `…UPCM` fixture starting in 20 minutes is checked by one unscoped run, and during a second unscoped run straight after — inside its 300 s cadence, both under `LIVE_SYNC_ONLY_TITLE_PREFIX` — `mock.requests` gains no request carrying the fixture's id (the requests are compared, not `last_synced_at`, whose one-second resolution would hide a re-check made in the same second; no total is asserted); `--limit` / `--max-seconds` clamping; a run whose child carries a `mode = off` overlay exits **0** with the switched-off reason.

   **Not installed, without touching shared data.** One CLI run against a scratch database the suite creates and drops itself, in this order:
   1. `sql {query: "SELECT DATABASE() AS db"}` names the shared database — the one `getDB()` opened from `DB_NAME` (`backend/includes/db.php:14-22`, `backend/config/database.php:24`). The check refuses to go on unless the name matches `/^[A-Za-z0-9_]{1,54}$/`; the scratch name is that name plus `_e2e_empty` (at most 64 characters).
   2. `sql` runs ``CREATE DATABASE IF NOT EXISTS `<db>_e2e_empty` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci``, then, for `live_streams`, `temples` and `deities` — the three tables `liveTablesExist()` probes (`config.php:105-109`) — ``CREATE TABLE IF NOT EXISTS `<db>_e2e_empty`.`<t>` LIKE `<db>`.`<t>` ``, which copies structure and no row. The scratch database so has 011's tables and no `live_settings`: `liveTablesExist()` is true and `liveAutomationInstalled()` false. (A completely empty database would test the other branch: §5.4 exits **1** when 011 is missing.)
   3. `runPhpAsync(["backend/bin/live_cron.php"])` with `DB_NAME=<db>_e2e_empty` added to that one child's environment. `dbEnv()` reads `getenv()` first (`backend/config/database.php:11-18`), the door `tests/notify-templates-unit.php:291-293` already uses. The run exits **0**, prints the `012_live_automation.sql` sentence, and emits no PHP warning.
   4. In a `finally`: ``DROP DATABASE IF EXISTS `<db>_e2e_empty` `` through `sql`. The pre-run cleanup issues the same drop, and the hygiene check (item 10) asserts the database is gone. A refused `CREATE` (a database user without the privilege) fails the check with MySQL's message; it is never skipped.
2. **The flow.** Fixtures whose `provider_reference` carries the suffix (`create-stream` accepts it, `live_fixtures.php:188`): a `…UPCM` fixture starting **5 minutes** from now (inside `starting_lead_minutes`) → STARTING; a `…LIVE` fixture starting now → LIVE in one run with `actual_start_at` equal to the mock's `actualStartTime` and one `live_stream_status` row; a LIVE fixture that started 15 minutes ago, given a `…DONE` video → COMPLETED with `actual_end_at` from the mock and `recording_url` set; a SCHEDULED `…DONE` fixture that started 15 minutes ago does the two-step catch-up in one sweep with two audit rows; at Tier 2, a `…STRT` fixture starting **5 minutes** from now gives SCHEDULED → STARTING and then, after `setVideo(id, {lifeCycleStatus: "live", actualStartTime: <now>})`, LIVE; an `unlisted` `…LIVE` video (`setVideo`) on a fixture starting now moves like a public one. The `…UPCM` fixture's `provider_scheduled_start_at` holds the mock's `scheduledStartTime` while its `scheduled_start_at` is byte-identical to what the fixture created.

   **The catch-up on a stale row that YouTube had already answered** — a **fresh** SCHEDULED `…DONE` fixture that started 9 h ago and ended 8 h ago (`scheduled_end_at` `stale_hours + 2` h past, start inside `catchup_hours`), its video set with `setVideo(id, {scheduledStartTime: <its start>, actualStartTime: <its start + 2 min>, actualEndTime: <its end>})`:

   1. a **scoped** run (`sync {ids: [its id]}`) with `mock.failNext(id, 1, "0500")` armed fails at call level: `sync_attempts` 0, `next_sync_at` backed off;
   2. `sql` writes `sync_state = 'upcoming'` and `last_sync_ok_at` = its start − 20 min on that row, as if a check had answered before the outage;
   3. after `due {ids: [its id]}`, an **unscoped** `sync` (no `ids`) lists that id in `items[]` — unscoped because a scoped run drops the window clauses, catch-up disjunct included — and completes it in that one sweep with two audit rows.

   Neither the failed check nor the earlier answer ends its eligibility (§0.2 #6). The unscoped sweep asserts only on this fixture's id.
3. **Guards.** Fixtures whose start **passed `LIVE_UPCOMING_GRACE_HOURS` + 1 h ago** — `…PRIV`, `…NOEM` and `…0404` — change no status and gain a row-failure `sync_error` with `sync_attempts = 1` (at Tier 1 the `…PRIV` one is `not_found`, because Google omits a private video; inside the grace all three would be notices, N1 and N2); a `…NOLS` fixture starting now reports `not_broadcast`; a `…RVOK` fixture starting in 5 minutes changes no status at Tier 2; at Tier 2 a `…PRIV` fixture starting now, with `setVideo(id, {lifeCycleStatus: "live", actualStartTime: <now>})`, is **not** moved (G10); DRAFT / CANCELLED / COMPLETED / deleted / non-YouTube rows, each starting now, are never selected; a `…LIVE` fixture starting now with `sync_enabled = 0` is skipped, and *Check now* on it reports `paused` without moving it; on a `…UPCM` fixture starting in 20 minutes, a forward human move is adopted (`overridden`) and a backwards one pauses the row with an audit line and `sync_error` NULL; `auto_end = 0` holds a LIVE fixture that started 15 minutes ago with a `…DONE` video at LIVE, outcome `held`.

   **Private until it goes live, a late start included (N1, N2).** At Tier 1 a `…PRIV` fixture whose start is **20 minutes ahead** reports `not_found` with `sync_state = missing`, `sync_attempts` 0, a `notice:` error reading "not visible on YouTube yet (still private, or the id may be wrong)", and `next_sync_at` about 300 s out — the position cadence, not a back-off. Its Tier 2 twin (same start) reports `restricted` with the N2 notice, `sync_attempts` 0 and the same cadence. **The late start (F3):** at Tier 1 a SCHEDULED `…LIVE` fixture that **started 7 minutes ago** (call its start S), its video set with `setVideo(id, {scheduledStartTime: S, actualStartTime: <now>})` and `mock.failNext(id, 3, "0404")` armed, stays missing for three scoped runs — each reports `not_found` with the N1 notice, `sync_attempts` 0, and `next_sync_at` 60 s (±2 s) after that run's `last_synced_at` (a back-off would have grown to 300 s, then 900 s); the fourth run, the first after the video appears, moves it to LIVE with `actual_start_at` equal to the mock's `actualStartTime` at S + 7 min. `sync_attempts` is 0 after every run, and the first pass after the video appeared came within 60 s of it — well under two minutes.

   **G24, end to end — "the morning video in the evening row"** (instants set with `setVideo`). A SCHEDULED fixture starting in 5 minutes (call its start T) whose `…DONE` video has `scheduledStartTime` T − 11 h 30 min, `actualStartTime` T − 11 h 28 min and `actualEndTime` T − 10 h 20 min — the 06:30 abhishekam pasted into the 18:00 row — stays SCHEDULED with outcome `mismatch` and a `notice:` error naming the stream, while `provider_notice` is untouched; a LIVE fixture (moved by hand) with such a video is **not** completed. Two fixtures starting now that share one `…LIVE` id whose `actualStartTime` is two days old are **both** left alone. A `…LIVE` fixture starting now, checked by a `sync` child whose environment sets `YOUTUBE_CHANNEL_ID` to a channel other than the mock's `UCmockmockmockmockmockmo` (`youtube_mock.mjs:110`), is a `mismatch`.

   **G22 and D1, end to end.** A SCHEDULED `…UPCM` fixture whose start is `catchup_hours + 1` h past is absent from an unscoped sweep's `items[]` and `mock.requests`, and is still SCHEDULED, while an otherwise identical fixture inside the horizon is checked; one an hour past, inside the horizon, is checked and **still SCHEDULED**; one five minutes from its start becomes STARTING. A STARTING `…UPCM` fixture whose start is `LIVE_UPCOMING_GRACE_HOURS + 1` h past ends the sweep still STARTING, with `sync_enabled = 0`, one `live_sync_paused` row, a `paused: stuck` error, and **"stuck — a person must end or cancel this"** in its `live_streams.php` list row; after a person cancels it the words are gone. A STARTING `…NOEM` fixture of the same age stays STARTING and enabled with the N5 notice. A LIVE `…LIVE` fixture that started 8 h ago and ended its schedule 7 h ago (`scheduled_end_at` `stale_hours + 1` h past) is **not** paused, and moves to COMPLETED once `setVideo` switches it to ended (`scheduledStartTime` = its start, `actualStartTime` = its start + 2 min, `actualEndTime` = now − 5 min). A LIVE `…LIVE` fixture that started 15 minutes ago, whose video is switched to `liveBroadcastContent: "none"` with no `actualEndTime`, stays LIVE and enabled, carries the N4 notice in its own `sync_error` (not in `provider_notice`) and is due again in about 60 s; the same fixture shape started 4 h ago is due again in about 900 s.
4. **Failures and back-off.** **Every check here is scoped** — `sync {ids}` or `--stream-ids` listing exactly its fixtures — because the mock returns a whole-response error only when every requested id carries that scenario, and because a scoped run ignores `next_sync_at`, so repeated runs need no clock rewinding. A scoped run with several ids still batches them into one call.

   Unless a check says otherwise, the fixtures here start now. `…0429` stores a `transient` error, honours `Retry-After: 30` in `next_sync_at` and changes no status; `mock.failNext(id, 2, "0500")` on a `…LIVE` fixture, then a third run, moves it and clears `sync_error` and `sync_attempts`; `…0500` backs off by the table; **the forced refresh** — at Tier 2, one ordinary run over a `…UPCM` fixture starting in 20 minutes first warms the cache (afterwards `oauth_access_token` is a `sbx1:` row with `is_secret = 1` and `oauth_access_token_expires_at` is set, §3.1); then, with `mock.failNext(id, 1, "0401")` armed on a `…LIVE` fixture, the next run's first request carries the cached bearer, `mock.tokensIssued` rises by **exactly one** (the forced refresh) and the retried call moves it; a `…0401` fixture at Tier 2 (every request refused) ends `auth` with the key sentence in `provider_notice`, once the `key=` resend has been refused too (§4.2); **a refused bearer falls back to the key (F4)** — at Tier 2 with the API key configured, `mock.failNext(id, 2, "0401")` on a `…LIVE` fixture refuses the bearer request and its retry after the forced refresh; the run sends that `videos.list` once more with `key=` (the request log shows the key in the query and no bearer), the fixture moves to LIVE, `provider_notice` reads *"YouTube refused the Google sign-in for this project; using the API key for now."*, `oauth_revoked_at` stays empty and no `live_provider_revoked` row is written; a wrong API key (a `sync` child with `YOUTUBE_API_KEY=wrong-key-not-secret` against a mock started with `apiKey`) ends `auth` with *"YouTube refused this key…"*, not `request`.

   **Token failures (E5).** Each is a `sync` child carrying the mock client id and secret, over a `…LIVE` fixture, and each starts with the cached bearer removed through `sql` (`oauth_access_token` deleted, `oauth_access_token_expires_at` blanked) — a bearer an earlier Tier 2 run cached in `live_settings` would otherwise be used without asking the token endpoint (§3.1):
   - **transient, with an API key** — `YOUTUBE_REFRESH_TOKEN=mock-refresh-unavailable` (the mock's `/token` answers 500): the fixture moves to LIVE through a `key=` request (the request log shows the key in the query and no bearer), `provider_notice` reads *"Google sign-in failed; using the API key for now."*, `oauth_revoked_at` stays empty and no `live_provider_revoked` row is written. The same with `YOUTUBE_OAUTH_TOKEN_URL=http://127.0.0.1:8085/token` — this suite's second port, on which nothing listens before item 6 (the port preflight proved it free) — gives `status = 0` and the same result;
   - **transient, without an API key** — the same child with `YOUTUBE_API_KEY` removed: the fixture does not move, its `sync_error` is class `transient`, `sync_attempts` stays 0, `oauth_revoked_at` stays empty;
   - **`invalid_client`** — a child whose `YOUTUBE_CLIENT_SECRET` differs from the one the mock was started with: `oauth_revoked_at` is set with `oauth_revoked_reason = 'invalid_client'`, one `live_provider_revoked` row names `invalid_client`, `provider_notice` reads *"Google no longer accepts the saved OAuth client…"*, and with the API key present the fixture still moves at Tier 1. **A second run** of the same child — Tier 1 now, and its answered call clears `provider_notice` (§5.3 step 9) — leaves the settings page's status card showing the `invalid_client` sentence of §8.3 (check or re-save the client secret) and not the `invalid_grant` one (F6). `oauth_revoked_at` and `oauth_revoked_reason` are cleared through `sql` afterwards (they live in `live_settings`, which the final `finally` also restores).

   `…0403` opens the quota breaker: the next run makes **zero** requests (`mock.requests.length` unchanged). A `finally` that runs before item 5 clears `quota_blocked_until`, `quota_units` and `quota_day` through `sql`.

   - **The mixed batch** — one run scoped to exactly three fixtures, `…0404` (started `LIVE_UPCOMING_GRACE_HOURS` + 1 h ago, so its answer is a row failure, not N1), `…LIVE` (starting now) and `…UPCM` (5 minutes out), produces **one** `videos.list` request carrying all three ids; the `…LIVE` row moves to LIVE, the `…UPCM` row to STARTING, and only the `…0404` row gains a `sync_error` and `sync_attempts = 1`.
   - **A call-level outage never pauses anything** — twelve runs scoped to a batch whose ids are **all** `…0500` leave `sync_enabled = 1`, `sync_attempts = 0` and every status unchanged on every row, and write no `live_sync_paused` row; after the first run `provider_notice` is overwritten with a sentinel through `sql`, and after the twelfth the sentinel is still there. Twelve `…0404` runs on one row that started `LIVE_UPCOMING_GRACE_HOURS` + 1 h ago, by contrast, pause it (G15) with a `paused:` error; `due {ids, attempts: 11}` then one run pauses a second row of the same shape.
   - **A revoked refresh token is tried once (D10).** With `YOUTUBE_REFRESH_TOKEN=mock-refresh-invalid-grant` (and the mock client id and secret) in the `sync` child's environment, and the cached bearer removed first as above, two consecutive runs over a `…LIVE` fixture make exactly **one** `/token` request between them, write exactly one `live_provider_revoked` row, set `oauth_revoked_at` with `oauth_revoked_reason = 'invalid_grant'`, and still move the fixture at Tier 1. After the owner presses **Reconnect** (item 7), both are empty, the next run makes one more `/token` request and sets them again.
   - **New credentials end the back-off, inside the scope only (D12, E4).** A `…0500` row backed off an hour out is due again after the owner saves a new client secret on the settings page (the API key is env-supplied on this server, so its field is read-only; any credential change clears the back-off, §3.1), while a control row `E2E-LIVE-xsync<run>` given `next_sync_at` an hour out through `sql` keeps it byte-identical.
5. **Quota and batching.** A run scoped to twelve `…UPCM` fixtures starting in 20 minutes produces exactly **one** `videos.list` request carrying twelve ids; sixty produce two; no request path contains `search`; the API key appears in the query and in **no** header and no log line; two fixtures starting now that share one `…LIVE` video id both **move** to LIVE off a single item (§4.2's fan-out).
6. **The HTTP trigger**, modelled on `tests/notify-worker.mjs:767-787`, with the second server on 8085, started without `LIVE_CRON_KEY` and then restarted with a 23-character one: 404 both times; 403 with no key, a wrong `X-Cron-Key`, a wrong `?key=` and `?key[]=x` (never 500); 200 with exactly `{checked, changed, started, ended, errors, skipped, locked}` on GET and POST and **no** `items` / `calls` / `units` / `duration_ms` — these sweeps touch only this suite's rows because the server carries `LIVE_SYNC_ONLY_TITLE_PREFIX`; `PUT` → 405 with `Allow: GET, POST`. The lock: `live_fixtures.php hold-lock {"seconds": 15}` runs in the background; the suite waits for its `{"locked":true}` line, then fires the HTTP call and the CLI in parallel — the HTTP call answers 200 **with `locked: true`**, the CLI prints "another run holds the lock" and exits **0**. The `live-cron-denied` bucket is removed by cleanup through `ips`.
7. **The settings page**, on the `tests/admin-payments.mjs:827-896` model: no credential anywhere in the HTML; an env-supplied credential shown read-only; the stored row is `sbx1:` ciphertext with `is_secret = 1` while the page shows `•••• XXXX (stored)`; the reveal toggle only on editable fields; a blank field keeps the stored value; Remove clears it; the audit row and the flash name keys only; the Simulator radio is absent on a server without the flag; `poll_seconds_live = 5` is refused; Test connection maps each scenario to its committee sentence, never leaks a response, and is refused while the breaker is open; Disconnect removes all four secrets and sets `mode = off`; a rotated client secret invalidates the cached token, observed through the cached row — after a Tier 2 `sync` child has cached a bearer (the `oauth_access_token` row exists), saving a new client secret on the page deletes that row and blanks `oauth_access_token_expires_at`, and the next Tier 2 run asks `/token` again (`mock.tokensIssued` + 1); **Reconnect** appears only while `oauth_revoked_at` is set and clears it and `oauth_revoked_reason`; after every save, Remove and Reconnect of this item, the control row `E2E-LIVE-xsync<run>` still has the `next_sync_at` an hour out that `sql` gave it; **viewer and editor get 403 on every POST — Run a check now included — and nothing changes**; a forged CSRF token changes nothing. **Hostile input** (moved here from `admin-hostile-input.mjs`, which defaults to the developer's :8000 server): every field of `save` over-length, as an array (`field[]`), with control characters and with a script payload, out-of-range and non-numeric numbers, a malformed `channel_id` and `client_id`, and an unknown `action` — no 5xx, no stack trace, no PHP notice, nothing stored.
8. **Check now and pause** on `live_streams.php`: the two row-menu items appear on a YouTube row and not on a `custom` one (their absence without 012 is proved without touching the schema, by `tests/live-unit.php` section 10, §11.2); Check now on a `…LIVE` fixture starting now moves it and flashes; an **editor** can and a viewer cannot; a forged CSRF is refused; *Switch to manual* / *Switch to automatic* write `live_sync_paused` / `live_sync_resumed` (*Switch to manual* leaves `sync_error` NULL), and *Switch to automatic* on a row paused by a backwards move leaves `synced_status = status` so the next sweep does not pause it again; the Sync column shows the last check and the clipped error; the four existing status buttons are unchanged; the Automation panel shows YouTube's scheduled start and end read-only and no viewer figure, and the row's `scheduled_start_at` is byte-identical to what the fixture created.

   **The two throttles (§8.4).** A second *Check now* on the same row within `LIVE_POLL_MIN_SECONDS` is refused with the flash naming the seconds remaining, and `mock.requests.length` is **unchanged**. For the hourly bucket, the suite pre-fills it through `sql` — `INSERT INTO rate_limits (bucket, hits, window_start) VALUES ('live-check-now:e2e_lives_editor', 30, NOW()) ON DUPLICATE KEY UPDATE hits = 30, window_start = NOW()` — and makes **one** press on a row never checked: it is refused with the bucket message and no new request; the owner, pressing the same row next, is **not** refused, proving the bucket is keyed per admin. Cleanup removes the bucket through `admin_prefix`.
9. **Browser** (one Playwright block): `/admin/live_settings.php` at 390 and 1440 — no horizontal overflow, axe clean, one `<h1>`, the reveal toggle only on editable fields.
10. **Hygiene.** No PHP notice or warning on stdout or stderr from the server, the CLI or any fixture; no 5xx; no cookie set by `/api/live-cron`; the strings `sbx1:`, the mock key, the mock client secret and the mock refresh tokens appear in **no** HTML, JSON, `admin_activity` row, `live_streams` row or file under `backend/logs/`; after cleanup no `E2E-LIVE-sync` or `E2E-LIVE-xsync` row, no `e2e-live-sync` audit row, no `live-check-now:e2e_lives_` bucket and no `<db>_e2e_empty` database is left, and `live_settings` equals the snapshot.

### 11.4 Existing suites — named lists only

- **The environment strip, in three suites** — landed by the Test harness workstream in step 1 (§13), before any file that reads `YOUTUBE_*` exists. Each of these hands the developer's whole shell to its PHP children today, so once the backend reads `YOUTUBE_*` a real key could reach a real Google endpoint (and a real `LIVE_CRON_KEY` would switch `/api/live-cron` on). Each gains `STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i`, applied to `process.env` before the suite's explicit keys are spread on, modelled on `payments-api.mjs:114-117`:
  - `tests/live-api.mjs` — `phpEnv()` (`:107-109`);
  - `tests/admin-live.mjs` — `PHP_ENV` (`:82`); this suite's server is the one §8.4's *Check now* runs on;
  - `tests/live-ui.mjs` — both spreads, `:140` (the `fixture()` child) and `:175` (`startPhp()`).

  The strip applies to the child environments only. The suites' own settings — `SITE_URL`, `TRUSTED_PROXIES`, `CORS_ORIGIN`, `ADMIN_USERNAME`, `SERVER_ENV` (`live-ui.mjs:92`) — are set after the strip and match none of the three prefixes; `LIVE_ADMIN_PORT` (`admin-live.mjs:51`), `LIVE_UI_PHP_PORT` / `LIVE_UI_VITE_PORT` (`live-ui.mjs:78-79`), `LIVE_SHOTS` (`:85`) and `LIVE_ONLY` (`:110`) are read by the Node process itself and are unaffected. Nothing is re-added. The edit is those lines and nothing else.
- **`tests/live-api.mjs`** (step 4): `PRIVATE_KEYS` (`:77`) and the regexes at `:425` and `:828` gain the twelve new column names; one check that `GET /api/live-cron` answers **404** on this suite's keyless server (as `payments-api.mjs:432-433` does).
- **Untouched, and why.** `admin-live.mjs:363` matches only `name="to" value="X"`, so the new menu items do not disturb it; `:375` holds because `LIVE_TRANSITIONS` is unchanged; `:387-388` holds because the job is cron-only, off by default, and `liveUpdate()`'s reset fires only when the video changes. If any of the three has changed since, the builder reports it rather than editing the suite.
- **`tests/admin-smoke.mjs`**: the page list (`:8-20`) gains `live_settings.php`.
- **`tests/admin-roles.mjs`**: **GET-only** checks for `live_settings.php` beside the live entries at `:108` and `:140-142`, on the `payment_settings.php` model at `:105`/`:135` — editor GET 403, viewer GET 403, owner GET 200. This suite defaults to the developer's :8000 server (`admin-roles.mjs:3`; §12 points it at the builder's 8088), so it never posts to `live_settings.php`: every POST to that page, the viewer's and editor's 403s included, lives in `tests/live-sync.mjs` (§11.3 item 7).
- **`tests/admin-hostile-input.mjs`** is **not** extended: it posts to `127.0.0.1:8000` by default (`admin-hostile-input.mjs:13`), the developer's own server, whose environment cannot be stripped and which may hold a real key. Its checks for `live_settings.php` live in §11.3 item 7.
- **`tests/README.md`**: the Live Darshan paragraph's port sentence (`:119`) becomes **"ports 8081–8085, the YouTube stand-in on 8091–8092"**; "Four suites" (`:117`) becomes five, with its prefixes and check count; a sentence says the suites scope every sweep to their own rows, restore `live_settings`, and never reach the network; and the one-at-a-time sentence (`:141`) names `admin-live.mjs`, `live-ui.mjs` **and** `live-sync.mjs`. While there, fix the stale "All 16 admin pages" at `tests/README.md:34` against `admin-smoke.mjs`'s real list.

---

## 12. Regression list

Run in this order, one suite at a time, on a machine where no other suite and no cron are running. **Every suite that takes a server address is pointed at the builder's own servers, never at the user's :8000 or :5173** (§11.1): a PHP server on **8088** — `$PHP_BIN -S 127.0.0.1:8088 -t backend backend/router.php` from the repository root, as `tests/payments-api.mjs:197` starts its own, with `SITE_URL=http://localhost:5195` as `tests/live-ui.mjs:92` sets for its pair — and a Vite on **5195** whose `/api` proxy points at it (`VITE_PROXY_TARGET=http://127.0.0.1:8088`, read at `frontend/vite.config.js:9`). `live-ui.mjs` starts its own Vite on 5195, so the builder's Vite is stopped before step 5 and started again for step 11 (a busy port makes `live-ui.mjs` exit 2).

1. `node tests/og.mjs http://localhost:5195 http://127.0.0.1:8088` — first, **before any live fixture exists**; its `/live-darshan` comparison holds only while nothing is live or upcoming.
2. `$PHP_BIN tests/live-unit.php`
3. `PHP_BIN=$PHP_BIN node tests/live-api.mjs`
4. `PHP_BIN=$PHP_BIN node tests/admin-live.mjs`
5. `LIVE_SHOTS=… PHP_BIN=$PHP_BIN node tests/live-ui.mjs`
6. `PHP_BIN=$PHP_BIN node tests/live-sync.mjs` — 4, 5 and 6 never together (`tests/README.md:141`)
7. `node tests/admin-smoke.mjs http://127.0.0.1:8088`
8. `node tests/admin-roles.mjs http://127.0.0.1:8088`
9. `node tests/admin-hostile-input.mjs http://127.0.0.1:8088` (unchanged; it proves the existing handlers still hold)
10. `node tests/search-api.mjs http://127.0.0.1:8088`
11. `PHP_BIN=$PHP_BIN node tests/public-e2e.mjs http://localhost:5195`
12. `php -l` on every new and changed PHP file
13. `cd frontend && npm run audit` → 0 findings (nothing under `frontend/` changed; run it to prove that)
14. `$PHP_BIN tests/payments-unit.php`
15. `PHP_BIN=$PHP_BIN node tests/payments-api.mjs` — PHP 8061, mock 8071
16. `PHP_BIN=$PHP_BIN node tests/admin-payments.mjs` — PHP 8062, mock 8072
17. `PHP_BIN=$PHP_BIN node tests/payments-ui.mjs` — PHP 8063, Vite 5190

The four payment suites start their own servers on their own documented ports (PHP 8060–8069, the CCAvenue stand-in 8070–8079, Vite 5190; `tests/README.md:77-100`), and run one at a time like the rest. They are run although nothing under `backend/includes/payments/` changes: a phase that changes nothing under payments can still break them through shared files, and on 2026-09-17 exactly that was found.

---

## 13. Ownership and order

Each builder owns only its files; anything outside needs a note in its report, not an edit. Nothing is committed to git by a builder.

| Step | Workstream | Owns |
|---|---|---|
| 1 | **Schema + settings** | `database/migrations/012_live_automation.sql`; `backend/includes/live/settings.php`, including `liveSyncEligibleWhere()` and `liveProviderNoticeSet()`; `liveAutomationInstalled()` and the §1 constants in `backend/includes/live/config.php`; **the word `'settings'` in the loader line at `backend/includes/live.php:23` (§4.3)**; the `.env.example` blocks. Applies 012 to the local database with `--default-character-set=utf8mb4`. Writes `asbuilt-phase3-settings.md` before step 3 starts. |
| 1 | **Test harness** (parallel) | `tests/support/youtube_mock.mjs` (§10.4); `tests/support/live_fixtures.php` (§10.5: `sync`, `due`, `hold-lock`, the `cleanup` changes); **the environment strip in `tests/live-api.mjs` (`:107-109`), `tests/admin-live.mjs` (`:82`) and `tests/live-ui.mjs` (`:140`, `:175`)** (§11.4), which must land before any file that reads `YOUTUBE_*` exists. Written against this file; run once step 2 lands. |
| 2 | **Provider + store** | `backend/includes/live/youtube.php` **and the word `'youtube'` in the loader line (§4.3)**; `canAutomate()` and the widened `fetchStatus()` in `providers.php`; in `store.php`: `liveSetStatus()`'s validated `$at`, `liveUpdate()`'s reset on a new video (the machine-pause rule included), `liveRecordSync()`, `liveListDueForSync()` (built on `liveSyncEligibleWhere()`), `liveSetSyncEnabled()`. |
| 3 | **Poller** | `backend/includes/live/poll.php` (with `livePollApplyMove()` and its fenced `LIVE_SIM_FAIL_AFTER_LIVE` throw) **and the word `'poll'` in the loader line (§4.3)**; `backend/bin/live_cron.php`; `backend/api/live_cron.php`; the one routing line in `backend/api/index.php`. |
| 3 | **Admin** (parallel) | `backend/admin/live_settings.php` (Reconnect included); `liveAdminSyncActions()` in `backend/includes/live/admin.php`; the two map lines in `backend/includes/auth.php`; in `backend/admin/includes/admin_layout.php` the nav line **and the `'refresh'` sprite entry at `:284-285`**; the three additions to `backend/admin/live_streams.php`; any `admin.css` addition. |
| 4 | **Suites** | `tests/live-unit.php` (the preamble, the section 2b/2c and 10 additions, sections 12–15, the `unitCleanup()` actor clause); `tests/live-sync.mjs`; the named list edits in `tests/live-api.mjs` (`PRIVATE_KEYS`, the two regexes, the 404 check), `tests/admin-smoke.mjs` and `tests/admin-roles.mjs` (GET-only). |
| 5 | **Integration** | Runs §12 in order, fixes defects in the owning files, reports exact pass/fail counts. |
| 6 | **Review** | Independent adversarial review: credential handling and the absence of any secret from HTML, JSON, logs and audit rows; every guard G1–G24 against a wrong automatic transition; §5.5's table and notice positions against the code, outcome by outcome; that no bulk statement over sync rows spells its own predicate instead of `liveSyncEligibleWhere()`; quota and back-off arithmetic; the admin permission surface and CSRF; that no private column reaches any public response; that no test touches a row it did not create; and that nothing from Phase 4+ has crept in. Verified findings → fixes → re-run of the affected suites. |
| 7 | **Docs** | `README.md` (the migration table row for 012, the cron block at `:409-421` with the overlapping-run and `rate_limits` sentences, a "Live Darshan automation" subsection with the Google Cloud steps and the 7-day warning); `tests/README.md` (§11.4); a final `.env.example` read-through; this file marked as built; **and three amendments to `docs/live/SPEC-PHASE1.md`**: `:72`, whose `liveSetStatus(PDO, int $id, string $to, string $actor)` gains the optional `?string $at = null` with one clause saying what it stamps (§5.1); `:137`, whose quoted `.env.example` sentence no longer exists after §3.2 and is restated as a pointer to the real block; and `:180`, whose description of `tests/support/youtube_mock.mjs` gains `GET /youtube/v3/liveBroadcasts`, bearer and `/token` handling, `failNext`, `setVideo` and the new suffixes of §10.2. Nothing else in Phase 1's text changes. |

`backend/includes/live/config.php` is shared by steps 1 and 2: step 1 finishes its constants before step 2 begins. `backend/includes/live.php:23` is shared by steps 1, 2 and 3, one word each, **never written ahead of the file it names** (§4.3).

---

## 14. Acceptance

A Phase 3 build is done when every one of these is true.

**Automation**
1. Migration 012 applies, re-applies and re-re-applies with no error and no second-run change; `live_settings` holds the seeded plain keys and **no secret**, with `mode = off` and `auto_starting = 0`; `live_streams` has the twelve columns — and no `viewer_count_at` — and `idx_sync_due`.
2. With `mode = live`, `auto_starting` ticked and only an API key set, a SCHEDULED broadcast whose YouTube video is *upcoming* becomes STARTING inside `starting_lead_minutes` of its start, LIVE within about a minute of the broadcast actually starting — including when it starts late, because a SCHEDULED row past its start keeps the fast cadence for `LIVE_UPCOMING_GRACE_HOURS` — and COMPLETED within about three minutes of it ending, with no committee member touching a button.
3. `actual_start_at` and `actual_end_at` hold YouTube's own instants, validated as real UTC instants before they are written, and are never re-stamped. `scheduled_start_at` and `scheduled_end_at` are never written by the job; YouTube's schedule is stored separately and shown read-only to the committee.
4. A broadcast that ran and ended while the cron was stopped is closed on the next run, in one sweep, with two audit rows and no transition error — **including when the stop was longer than `stale_hours` past the scheduled end**, back as far as `catchup_hours`, **and whatever YouTube answered before the stop**. Besides `sync_enabled` (G4) and `next_sync_at`, no sync column affects that eligibility. After a longer stop the row stays SCHEDULED for a person to close, and devotees do not find it in the upcoming list or on the schedule.
5. The job has never written `OFFLINE`, `ERROR`, `CANCELLED` or `DRAFT`, never moved a row backwards, and never moved a row on a private or non-embeddable video, at any tier.

**Safety**
6. Every guard G1–G24 has a passing named check in `tests/live-unit.php` or `tests/live-sync.mjs`, and every outcome of §1 except `refused` and `not_configured` is produced by at least one check whose `next_sync_at` is asserted against §5.5. No sweep can produce those two; `tests/live-unit.php` pins them by calling `livePollDecide()` (no pair outside `LIVE_AUTO_TRANSITIONS`, so `refused` is unreachable) and `liveCronRun()` (under `mode = off`, no row is reached, so `not_configured` never is), and both stay in the pinned list.
7. Turning `mode` to `off`, or pausing one broadcast, stops automation for it immediately; the status buttons still work and the row menu is unchanged. **Resume automation** resets the row (`synced_status`, `sync_attempts`, `sync_error`, `next_sync_at`), and the next sweep does not pause it again.
8. A person's forward move is adopted; a person's backwards move pauses that row's automation and says so in the audit log, whatever YouTube says.
9. A deleted, private, non-embeddable or non-broadcast video changes no status; the reason is on the row and on the admin page. **At either tier** a broadcast kept private until it goes live — `missing` at Tier 1, `restricted` at Tier 2 — carries a notice on a SCHEDULED or STARTING row until `LIVE_UPCOMING_GRACE_HOURS` after its start, a late start included, is not counted as failing and keeps its normal cadence, so it moves on the first pass after the video appears; after that it is a row failure on a SCHEDULED row, and G22's pause (`missing`) or notice N5 (`restricted`) on a STARTING one.
10. **The evidence belongs to the broadcast (G24).** A video whose `scheduledStartTime` is more than `LIVE_MATCH_SCHEDULE_MINUTES` (20) from the row's start, or whose `actualStartTime` lies outside `[start − LIVE_MATCH_EARLY_MINUTES, start + LIVE_UPCOMING_GRACE_HOURS]`, or whose `actualEndTime` is before the row's start, or which belongs to another channel when `youtube_channel_id` is set, moves nothing — not the catch-up, not `LIVE → COMPLETED` on a row a person set live — and the row's own notice names the stream. The 06:30 morning video pasted into the 18:00 row is refused by each time check on its own, and the 06:00 suprabhatam pasted into the 06:30 abhishekam row by the schedule check and by the end check, each on its own.
11. **Turning automation on does not advertise old broadcasts.** With a backlog of forgotten SCHEDULED rows, every row whose start is older than `catchup_hours` is unselected, and every row inside the horizon whose start is older than `starting_lead_minutes` is un-moved. A `STARTING` row whose video YouTube still reports `upcoming`, or as missing or not a broadcast, once `LIVE_UPCOMING_GRACE_HOURS` have passed since its start is paused, keeps its status, and reads **"stuck — a person must end or cancel this"** (G22); any other answer there leaves a notice and no pause, and an `ended` answer with its end instant is completed, never paused. **A `LIVE` row is never paused by that rule**: a 24-hour broadcast YouTube reports live is polled for all 24 hours and completed when it ends; a LIVE row YouTube does not report live is left for the committee with a notice and, past its grace, asked every 15 minutes.
12. **A committee click during a check is never undone.** If `status`, `synced_status`, `sync_enabled`, the video or the deleted flag changes while a provider call that answers is in flight (G23), that pass writes only `last_synced_at`, and the next pass applies §6.4 to what the person left — so *Reschedule* during a check ends with the row SCHEDULED and paused, never LIVE (G23). A catch-up that fails half-way rolls **both** steps back.
13. Changing a row's provider or video id resets every sync column that described the old video (`synced_status` to NULL), lifts a machine pause (G15, G22) but keeps a person's, and makes the row due at once unless a person paused it. A draft given a video id and then published by a person is moved by the first pass, with no PHP warning.
14. A condition of one row is a notice on that row, never a failure and never the global `provider_notice`. Twelve consecutive **row failures** pause that one row with one audit line; twelve consecutive **call-level** failures — a Google outage, a wrong key, a 5xx — pause **nothing**, leave every row's `sync_attempts` at 0 and say so once in `provider_notice`; a 429 with `Retry-After: 30` pushes `next_sync_at` at least 30 seconds out; a row that fails twice then succeeds has `sync_error` NULL and `sync_attempts` 0. After new credentials are saved, no row waits out the old back-off.
15. A 403 `quotaExceeded` makes the next run issue **zero** requests and is visible on the settings page. An `invalid_grant` or `invalid_client` switches Tier 2 off with one audit line and its own sentence, which the settings page keeps showing (from `oauth_revoked_reason`) for as long as Tier 2 is off, and is not tried again — even when the credentials come from the environment — until an owner saves new OAuth credentials or presses Reconnect. Any other token failure never switches Tier 2 off: that run uses the API key and says so, or, with no key, is a transient failure. Nor does a bearer the API refuses: with an API key the run finishes on the key and says so; with none it is an `auth` failure.
16. Twelve due rows cost exactly one `videos.list` request; `search.list` appears nowhere under `backend/`; `bin/live_cron.php` exits 0 when not installed (proved on a scratch database the suite creates and drops), not configured or locked, and 1 only on a real error; two overlapping runs are harmless; a dry run writes nothing but the quota count. A committee member pressing *Check now* repeatedly cannot spend the day's quota: the second press inside `LIVE_POLL_MIN_SECONDS` and any press past thirty in an hour are refused before any call (§8.3, §8.4).

**Secrets**
17. No credential, no bearer and no `sbx1:` string appears in any page's HTML, any JSON body, any flash, any `admin_activity` row, any `live_streams` row, any log line or any test file — including `/api/live-cron`'s `Throwable` log, the `request` log line and `live_settings.provider_notice`, all of which pass through `liveRedact()`, which never throws. The page shows at most the last four characters; audit rows name keys only.
18. A credential set in the server environment wins and its field is read-only; a blank field keeps what is stored; Remove clears it; Disconnect clears all four.
19. `/api/live-cron` answers a bare 404 until `LIVE_CRON_KEY` is at least 24 characters, 403 on a wrong key — including `?key[]=x`, never a 500 — with the attempt counted, 405 on PUT, and returns exactly `{checked, changed, started, ended, errors, skipped, locked}`.

**Blast radius**
20. `liveShapePublic()`, `liveShapeAdmin()`, `YouTubeProvider::thumbnailUrl()`, `backend/api/admin_live_streams.php` and every `/api/live-streams/*` response are unchanged; no new column name or value appears in any public body or page; the only public values that move are `status`, `actual_start_at` and `actual_end_at`. No page — public or admin — shows `provider_thumbnail_url` or `viewer_count`.
21. `LIVE_TRANSITIONS` is unchanged, and so are the committee's row menu and status select. Every suite in §12 passes at or above its previous count, with `tests/live-unit.php:240`, `:306-310`, `:832`, `:867-868` and `:871` and `tests/admin-live.mjs`'s three pinned assertions passing **unedited**, and the counts recorded in `tests/README.md`.
22. No file under `frontend/` changed; `npm run audit` is 0; no dependency was added anywhere.
23. The site works with 011 but not 012 applied (or with 012 half-applied): the admin shows a notice and offers no automation menu item (`liveAdminSyncActions(…, false)`), the cron exits 0, nothing fatals. The module is never half-loaded during the build: each workstream adds its own name to `live.php:23` with the file it names (§4.3).
24. **No test touched a row it did not create**: every sweep, credential save and Reconnect in the suites ran under `LIVE_SYNC_ONLY_TITLE_PREFIX` through `liveSyncEligibleWhere()`, and a control row outside that scope kept its `next_sync_at`; audit rows were removed only by test actor or fixture id; `live_settings` was restored; the "not installed" check used a scratch database and the shared schema was never altered; and neither `admin-hostile-input.mjs` nor `admin-roles.mjs` posted to `live_settings.php`.
25. Every new committee-facing string is admin English and no new string reaches a devotee; the admin pages use design tokens only. Nothing was committed to git.

---

## 15. What the temple must supply, and how the site behaves until they do

**This section is information only; nothing in it blocks the build or the tests** — every item is exercised by the simulator and the stand-in. Items 1–9 matter on the day automation is switched on in production. Item 10 records a choice Phase 3 made on Phase 8's behalf; item 11 records a feature deliberately left out.

| # | Needed from outside | Who | Until it arrives |
|---|---|---|---|
| 1 | A **Google Cloud project** with **YouTube Data API v3** enabled, and an **API key** from it, restricted to that API and, where Hostinger gives a stable outbound address, by server IP. Delivered as `YOUTUBE_API_KEY` in the server environment **or** pasted once into Admin → YouTube Automation. | the temple's Google account owner | Tier 0. `liveAutomationReady()` is false, the cron exits 0 with "No YouTube API key is set.", `fetchStatus()` answers "not configured", and the committee keeps pressing Publish / Go live / End exactly as in Phase 2. Nothing on the devotee's side differs. |
| 2 | **`LIVE_SETTINGS_KEY`** — base64 of 32 random bytes — set in Hostinger. | whoever deploys | Credentials cannot be stored from the admin; the fields are disabled with the reason. Environment variables still work. |
| 3 | **`LIVE_CRON_KEY`** — 24+ characters — only if the host has no CLI cron. | whoever deploys | `/api/live-cron` answers a bare 404. The CLI job still works. |
| 4 | The **crontab line** `* * * * * /usr/bin/php …/bin/live_cron.php` in hPanel → Advanced → Cron Jobs. | whoever deploys | Nothing polls. *Check now* in the admin still works, one broadcast at a time. |
| 5 | The committee's decision to **turn automation on** (`mode = live`), and — separately — to tick **`auto_starting`**, the one switch seeded `0` because STARTING is the one move inferred rather than observed. Also whether `auto_start` and `auto_end` are wanted from day one, or watched for a week with `auto_end = 0` first. | the committee | Seeded `off`, with `auto_starting` at `0`. Migration 012 can be applied to a live site with no behavioural change; turning `mode` on without `auto_starting` gives LIVE and COMPLETED automatically and leaves "starting shortly" to the committee. |
| 6 | **Quota**: the default allocation is 10,000 units/day, resetting at midnight US Pacific. §5.6 shows the site uses ≈4 % on a normal day and at most 14 % at Tier 1. **No quota extension is needed and none should be requested** — an extension requires a compliance audit. | — | If the pool is ever exhausted the job stops for the day, says so on the settings page, and the committee uses the buttons. |
| 7 | *(Optional, Tier 2)* **OAuth**: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` and a `YOUTUBE_REFRESH_TOKEN` minted once with `access_type=offline`, `prompt=consent` and the single scope `https://www.googleapis.com/auth/youtube.readonly`, from the Google account that **owns the broadcasting channel**. | the temple's Google account owner | Tier 1 — everything above still works. What is lost: a true STARTING signal (`lifeCycleStatus` = testing / liveStarting); `recordingStatus`, so `recording_url` is written without confirming an archive exists; and `boundStreamId`, so `provider_stream_id` stays empty. A private video moves nothing at either tier. None of it changes what a devotee sees. |
| 8 | *(Only if 7 is taken)* The OAuth consent screen **published/verified**, or the temple's account added as an internal user. An external project in *Testing* is issued refresh tokens that **expire after 7 days**, and `youtube.readonly` is a sensitive scope, so verification is required to leave Testing. There is also a limit of 100 refresh tokens per Google account per client id, so the admin reuses the stored token. | the temple's Google account owner | The refresh token dies weekly. The site handles it — `invalid_grant` switches Tier 2 off once (§3.3), automation carries on at Tier 1 on the API key, and the settings page says so — but someone must mint a new token and save it, or press Reconnect after fixing the cause, each time until the app is verified. The settings page carries this warning permanently. |
| 9 | Nothing else. In particular **no channel handle and no channel scan is required**: the committee already pastes each broadcast's video id, and Phase 3 only asks about those ids. `YOUTUBE_CHANNEL_ID` is optional; when set, a video from another channel moves nothing (G24). | — | — |
| 10 | *(A decision taken for Phase 8, recorded)* Phase 3 writes `recording_url` only when the row's `archive_enabled` is 1 (§4.2) — the conservative reading: do not store what the row says not to keep. Phase 8, which owns the archive and the flag, may instead store the address always and hide it at display time. | Phase 8 | Built as described. A broadcast whose flag is turned on afterwards has no stored address until someone fills it. Changing the reading is one condition in §4.2 and no schema change. |
| 11 | *(Deferred feature, recorded so it is not lost)* **A schedule-drift notice.** YouTube's `scheduledStartTime` is retrieved, stored and shown read-only from day one (§8.4), and used as G24's veto. *Comparing* it with the committee's own time and warning when they merely disagree — a threshold, a ⚠ in the list, a sentence in the panel — is a product feature the client's Phase 3 text does not carry. | the committee, if they want it | The two times sit side by side on the admin page. Devotees always see `scheduled_start_at`. |
