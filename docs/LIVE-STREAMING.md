# Live streaming (YouTube Live)

Operator guide for Live Darshan: how a broadcast is created, what the statuses
mean, how the YouTube poller is switched on, and how to read the health card.
The full rules live in `docs/live/PHASE0-ANALYSIS.md` and
`docs/live/SPEC-PHASE1.md` … `SPEC-PHASE8.md`; `README.md` → *Live Darshan*
is the committee-facing walk-through. Nothing here streams video: the temple
broadcasts from its own YouTube channel (YouTube Studio, a phone, OBS) and the
site embeds it with the privacy-enhanced `youtube-nocookie.com` player.

Needs migrations `011_live_streams.sql` (streams), `012_live_automation.sql`
(poller), `013_live_subscriptions.sql` (reminders), `014_live_donations.sql`
(stream-linked donations).

## What the public sees

| Route | Content |
| --- | --- |
| `/live-darshan` | the broadcast that matters now: LIVE player with 🔴 indicator, viewer pill while live and fresh (≤ 5 min), or the next scheduled darshan as a poster with countdown in the temple's zone; Donate / Notify me / Share row; "About this pooja" |
| `/live-darshan/schedule` | upcoming broadcasts, temple time and the visitor's own |
| `/live-darshan/archive` | COMPLETED broadcasts that kept their recording |
| `/live-darshan/<slug>` | one broadcast, with per-stream Open Graph / share preview for crawlers |
| homepage | LIVE indicator + CTA while a stream is LIVE / STARTING; otherwise the next scheduled darshan block |

Public APIs (no cookies, cache headers set): `GET /api/live-streams`,
`/api/live-streams/live`, `/upcoming`, `/schedule`, `/archive`,
`/api/live-streams/<slug>`, `/api/live-streams/<slug>/donations`;
`POST /api/live-subscriptions` and `/live-subscriptions/unsubscribe` (email
reminders with a per-subscription unsubscribe link). Admin JSON:
`/api/admin/live-streams[/<id>]`.

## Statuses

`DRAFT → SCHEDULED → STARTING → LIVE → COMPLETED`, plus `CANCELLED`,
`OFFLINE` (broadcast dropped) and `ERROR` (provider reports the video is
gone / private / invalid). The brief's `UPCOMING` is `SCHEDULED` and `ENDED`
is `COMPLETED`. Allowed transitions are enforced in
`backend/includes/live/validate.php`; the admin shows only the buttons that
apply. A COMPLETED row with `archive_enabled` on becomes an archive entry
with `recording_url`; without it the recording is not listed.

Times are stored in UTC with the row's `timezone` (default `LIVE_TEMPLE_TZ`,
else `NOTIFY_TEMPLE_TZ`, else `Asia/Kolkata`).

## Admin

Media → **Live Streaming** (`/admin/live_streams.php`): create a stream by
pasting a YouTube URL or video id, pick the pooja / event / deity it belongs
to, the schedule, the Tamil and English titles, and whether donations and the
archive are offered; filters for Draft / Scheduled / Live / Completed /
Cancelled / Deleted; per-row status buttons offered from the current status
(**Publish**, **Starting soon**, **Go live**, **End stream**, **Mark
offline**, **Cancel**, **Back live**) plus **Check now**. Owner-only **YouTube Automation**
(`/admin/live_settings.php`): API key or OAuth client, mode Off / Live, the
three move switches (start / live / end), **Run a check now**, **Test the
YouTube connection**, **Disconnect YouTube**.

Capabilities (`backend/includes/roles.php`): `live.view` and `live.analytics`
every role; `live.manage` and `live.publish` editor/admin/owner;
`live.provider` (credentials, mode) owner only. Every change writes
`admin_activity` (`live_stream_create|update|status|delete|restore`,
`live_provider_*`, `live_sync_*`) through `liveAudit()`.

## Automation (the poller)

Three tiers — pick the smallest that does the job:

| Tier | Needs | Gives |
| --- | --- | --- |
| 0 | nothing | manual buttons only; no network call ever |
| 1 | `YOUTUBE_API_KEY` (Data API v3, key restricted to the YouTube Data API and the server's IP) | automatic SCHEDULED → STARTING → LIVE → COMPLETED, viewer count, recording link |
| 2 | OAuth client (`YOUTUBE_CLIENT_ID/SECRET/REFRESH_TOKEN`, scope `youtube.readonly`, the channel's own Google account) | a real "starting" signal (`lifeCycleStatus`), recording status, owner-only broadcast detail |

Credentials come from environment variables (read-only in the admin) or are
stored from the admin page, encrypted with libsodium under
`LIVE_SETTINGS_KEY`. **Back that key up with the database** — without it the
stored credential cannot be decrypted (`DEPLOYMENT.md`).

Setup:

1. Google Cloud → enable *YouTube Data API v3* → create an API key → restrict
   it. (Tier 2: an OAuth client of type *Web application*, redirect URI shown
   on the admin page, consent with the channel's account.)
2. Set `LIVE_SETTINGS_KEY` (and `LIVE_CRON_KEY` if using the HTTP trigger) in
   hPanel. Paste the key on Admin → YouTube Automation, *Test the YouTube
   connection*.
3. Schedule the job **every minute** — it decides which rows are due:

   ```cron
   * * * * *  /usr/bin/php /home/<account>/domains/<site>/public_html/bin/live_cron.php
   ```

   or, without CLI cron, `GET https://<domain>/api/live-cron` every minute
   with header `X-Cron-Key: <LIVE_CRON_KEY>` (404 until the key is ≥ 24
   chars; 403 on a wrong key; 30 wrong keys an hour lock the caller).
4. Set the mode to **Live**. Each of the three moves has its own switch.

Behaviour worth knowing (SPEC-PHASE3 §5–6):

- Cadence: a LIVE / STARTING row is checked about every minute
  (`poll_seconds_live`), an upcoming one every five (`poll_seconds_soon`),
  nothing when no stream is in rotation — an idle run costs no quota. The
  daily YouTube quota (10 000 units) is more than enough for a temple
  schedule; a quota refusal opens a breaker until midnight US-Pacific and the
  admin shows a notice.
- A status set by hand is never undone. If YouTube would move a row
  backwards, or a row fails 12 checks in a row (backoff 1 → 60 min), its
  automation is **paused** (`sync_enabled = 0`, `sync_error` starting
  `paused`) and shown on the health card; re-enable it on the row.
- A video whose scheduled date does not match the row is left alone with a
  warning; a deleted / private video is reported as `not_found` in
  `sync_error` (the poller never sets `ERROR` — that status is the
  committee's).
- Runs never overlap (`GET_LOCK('temple_live_cron')`). CLI flags: `--limit`,
  `--max-seconds`, `--stream-ids`, `--dry-run`, `--json`. Exit 0 when idle,
  off or locked; 1 only for a real error.
- Neither the CLI, the endpoint, nor the error log ever prints a key or token.

## Health monitoring

Dashboard → **Live Darshan** card and `GET /api/admin/live-streams?include=health`
(session cookie + `live.view`)
derive a verdict per stream from the sync columns the poller already writes
(no separate health table — `backend/includes/live/health.php`):

| Verdict | Meaning | Do |
| --- | --- | --- |
| Failing | auth / request error from YouTube | check the key or OAuth connection (*Test the YouTube connection*) |
| Needs attention | video not found, configuration error, row is OFFLINE / ERROR | fix the video id or end/cancel the row |
| Automation paused | machine paused after a manual/provider contradiction | review, then re-enable sync on the row |
| Check overdue | a LIVE / STARTING row has not been checked for 3× its cadence (min 10 min) | is the cron running? (`DEPLOYMENT.md` → *Cron jobs*) |
| Notice | quota / transient — will retry | nothing |
| Manual | automation off, or a non-YouTube provider | nothing |
| Healthy / Not in rotation | fine | nothing |

`tests/live-health.mjs` covers the classification; the card also lists the
last successful check and the next due time.

## Reminders, donations, archive, SEO

- **Notify me** (Phase 6): email consent for one broadcast with an
  unsubscribe link in every message; `bin/notify_worker.php` every minute
  sends the reminders. Needs the notification module configured
  (`MAIL_TRANSPORT`).
- **Donate while watching** (Phase 7): when `donations_enabled` is on the
  Donate button opens checkout with `live_stream_id` set and
  `/api/live-streams/<slug>/donations` reports totals. Follows every rule in
  `CCAvenue-INTEGRATION.md`.
- **Archive** (Phase 8): completion keeps the recording when
  `archive_enabled` is on; the poller fills `recording_url`; the archive page
  lists it and the Videos module can link to it.
- **Share previews** (Phase 5): `/live-darshan/<slug>` answers crawlers with
  the stream's own title, Tamil title, image and times; a missing slug is a
  real 404. Real WhatsApp / Facebook previews were checked with local crawler
  user agents only.

## Testing

```bash
php tests/live-unit.php
node tests/live-api.mjs && node tests/live-sync.mjs && node tests/live-health.mjs
node tests/live-ui.mjs           # browser: player states at 390/768/1024/1366
node tests/live-og.mjs && node tests/live-archive.mjs && node tests/live-subscriptions.mjs && node tests/live-donations.mjs
```

All of these run against the built-in simulator (`LIVE_ALLOW_SIMULATOR=1`,
mode *simulator*, `YOUTUBE_API_BASE_URL` pointed at the local stub) — they
cover the brief's §32 cases (no stream, upcoming, live, ended, cancelled,
invalid URL, unavailable video, pooja- and event-linked streams, mobile and
desktop players, homepage indicator).

## Not yet verified against the real provider

Real YouTube Data API answers, OAuth consent with the temple's channel,
quota behaviour over a full festival day and actual playback of a live embed
(the tests assert the iframe and its `src`, not moving video) remain to be
exercised on staging with the temple's account — `DEPLOYMENT.md` → *Staging
validation*, `GAP-ANALYSIS.md`.
