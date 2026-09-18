# Live Darshan — Phase 4: the premium player page

Status: short build contract, 2026-09-18. Starts after Phase 3 (PR #33) is merged.
Where this file is silent, `SPEC-PHASE3.md`, then `SPEC-PHASE2.md`, then
`SPEC-PHASE1.md` apply. It is deliberately short: Phase 4 is presentation over
data the earlier phases already store.

## 0. The client's Phase 4, and what it becomes

> Premium player page: live header with viewer count
> (`liveStreamingDetails.concurrentViewers`, shown as returned), player
> states, Donate / Notify Me / Share row, "About this pooja", upcoming programs.

Decisions (settled):

1. **One page, no new route.** `/live-darshan` and `/live-darshan/:slug`
   (`pages/LiveDarshan.jsx`) grow; nothing moves.
2. **Viewer count becomes public, narrowly.** `liveShapePublic()` gains one key,
   `viewers` — an integer **only while** `status` is LIVE, `viewer_count` is
   not NULL and `last_sync_ok_at` is within the last **5 minutes**; otherwise
   `null`. "Shown as returned" means the figure YouTube gave, never rounded,
   never zero-filled: a missing figure shows nothing. Every other 012 column
   stays private (SPEC-PHASE3 §9 is amended by exactly this one word).
3. **Notify Me is Phase 6.** The row shows the button only when
   `flags.notifications` is set; until Phase 6 lands it opens a small `Modal`
   that says reminders are coming and offers the schedule link. No endpoint,
   no email field, nothing stored.
4. **Donate is a link**, not a payment flow: `/donate?stream=<slug>` when
   `flags.donations` is set and payments are usable — `usePaymentsConfig()`
   (module-cached, one `/api/payments/config` fetch per page load) says
   `enabled` and is neither loading nor failed. Phase 7 makes the donate
   page read `?stream=`; Phase 4 only sends it. Until then the parameter is
   ignored by `Donate.jsx` (it already ignores unknown params).
5. **No new live fetches.** The page keeps the two live hooks it has
   (`useLiveOverview`, `useStream`) plus `usePaymentsConfig()` for Donate; the
   viewer count arrives with the same poll the badge uses.

## 1. Backend — one key

`store.php` `liveShapePublic()`:

```php
'viewers' => ($status === 'LIVE' && isset($row['viewer_count']) && liveFresh($row['last_sync_ok_at'] ?? null, 300))
    ? (int) $row['viewer_count'] : null,
```

`liveFresh(?string $utc, int $seconds): bool` is a two-line helper in
`time.php` (true when `$utc` parses and is within `$seconds` of `liveUtcNow()`).
The public lists select `s.*`, so on a database without migration 012 the two
keys are simply absent from `$row` and `viewers` is `null` — no query change.

Tests: `PUBLIC_KEYS` in `tests/live-api.mjs` and the two pinned key lists in
`tests/live-unit.php` gain `viewers`; `PRIVATE_KEYS` is unchanged
(`viewer_count` — the column name — stays out of every response). New checks:
`viewers` is an int on a LIVE row with a fresh `last_sync_ok_at`, `null` on
the same row 6 minutes stale, `null` on STARTING/COMPLETED. Because
`liveShapeSchedule()` extends the public shape, the schedule item (and the
index route's `now` / `next`) carries `viewers` too; `SCHEDULE_KEYS` follows
`PUBLIC_KEYS`. `liveFresh()` rejects an instant in the future as well as one
older than `$seconds`.

Known limit (Phase 3 §5.5): `viewer_count` is frozen when YouTube omits
`concurrentViewers` while `last_sync_ok_at` still advances, so a figure the
provider stopped reporting can stay visible until the stream leaves LIVE.

## 2. Frontend

### 2.1 Live header (`components/Live/LiveHeader.jsx`, new)

Sits above the player on both routes, replacing today's `live-stream__head`
(which moves into "About this pooja"). One row: `LiveStatusBadge`, the title
as the page's `h2`, the deity and event-type label as a muted line, and — when
`viewers` is a number — a `ViewerCount` pill: eye icon, the number through
`Intl.NumberFormat(lang)`, sr-only text "N watching now" / "N பேர்
பார்க்கிறார்கள்". The pill appears and disappears with the poll; its change
is **not** announced (only status changes speak, as today).

### 2.2 Player states (`LivePlayer.jsx`)

The component already renders SCHEDULED / STARTING / LIVE / COMPLETED /
OFFLINE / ERROR / CANCELLED. Phase 4 adds:

- **COMPLETED with `flags.archive` and a playable `playback`**: the poster
  gets a "Watch the recording" button that mounts the iframe (same attributes
  as live). Without both, the existing "This darshan has ended" poster stays
  (`recording_url` remains private; Phase 8 owns archive pages).
- **OFFLINE / ERROR**: a "Try again" button that calls the hook's `refresh`.
- Every state keeps the 16:9 box, one `<figure>`, one `figcaption` with the
  state sentence, no layout shift when the iframe mounts.

### 2.3 Action row (`components/Live/StreamActions.jsx`, new)

Under the player: `Donate` (primary, per Decision 4), `Notify Me` (outline,
per Decision 3, only while SCHEDULED/STARTING), `Share` (the existing
`ShareButton` with the stream's title, text and `/live-darshan/:slug`, only
when `flags.sharing`). 44 px targets; wraps at 390. When none applies the row
is not rendered.

### 2.4 "About this pooja"

A `section` with `h3` "About this pooja" / "இந்த பூஜை பற்றி": the
description in the current language (falls back to the other, as
`streamDescription()` does), then `StreamMeta` (unchanged) on narrow widths;
on wide widths `StreamMeta` stays in the sticky aside as today.

### 2.5 Upcoming programs

Today's "Upcoming live darshans" grid stays; it gains the day label from
`StreamCard` (already present) and is capped at **6** with the "Full
schedule" button. No change of data.

### 2.6 Strings

All new strings are `t(ta, en)` pairs beside their use, as the page does now.
No new keys in `lib/live.js` beyond `formatViewers(n, lang)`.

## 3. Not in Phase 4

Per-stream OG tags (5), subscriptions and reminders (6), the donation
payable's `live_stream_id` (7), the archive page and auto-archive (8), health
UX (9), analytics (11), any admin change, any change to `poll.php`.

## 4. Tests

- `tests/live-unit.php`: §1's four checks.
- `tests/live-api.mjs`: `PUBLIC_KEYS` + the §1 checks; every existing
  assertion unchanged.
- `tests/live-ui.mjs` gains one scenario group `premium`: the header with a
  fixture whose `viewer_count` / `last_sync_ok_at` are set by `sql` (pill
  shows "42", then disappears after `sql` sets it NULL and the next poll), the
  action row at 390 and 1440 (which buttons for which flags), Notify Me's
  modal (focus trapped, Escape closes), the recording button on a COMPLETED
  fixture with a video id, "Try again" on OFFLINE, "About this pooja" in
  Tamil then English, axe at both widths.
- `admin-live.mjs`, `og.mjs`, `public-e2e.mjs`: rerun, no edit expected.

## 5. Acceptance

A LIVE fixture with `viewer_count = 42` and a fresh `last_sync_ok_at` shows
"42 watching now" on `/live-darshan` in both languages; the same fixture with
`viewer_count` NULL shows no pill and no "0"; `curl /api/live-streams` shows
`viewers` and none of the twelve 012 column names; Donate / Notify Me / Share
follow the row's flags; a COMPLETED row with a video id plays its recording on
demand; all live suites green on MySQL 8.
