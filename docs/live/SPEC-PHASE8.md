# Phase 8 — Recordings archive

## Public archive

`/live-darshan/archive` lists completed, non-deleted YouTube streams with
`archive_enabled = 1` and a saved, canonical YouTube `recording_url`.
Completing a stream alone does not prove a recording exists. Missing, invalid,
disabled, private draft and cancelled recordings do not appear. This is a
read model over `live_streams`, not another lifecycle state or a copied table.

`GET|HEAD /api/live-streams/archive?event_type=festival&month=2026-09&page=1`
returns `{streams, page, has_more, event_types, timezone, server_time}`.
There are 12 cards per page, ordered by completion time (scheduled start,
then creation time as fallbacks), newest first with descending ID ties.
`month` is the completion month in the temple timezone, converted to UTC
in PHP; MySQL timezone tables are not required. Event type and month are
optional (months 1900-01 through 9998-12, pages 1–10000). Malformed filters return
422, failed reads 503/no-store; absent migration 011 yields an empty archive.
Public stream fields stay unchanged.

Filters and pagination live in the URL and survive Back/Forward and refresh.
The Tamil/English page includes loading, error/retry and empty states,
keyboard-accessible filters and previous/next navigation. Cards open the
existing stream page; the recording iframe is only loaded on demand.
The archive has static bilingual crawler metadata and links from the live
player and schedule pages.

## Completion and playback

The existing poller atomically moves eligible YouTube broadcasts to COMPLETED
and saves their recording URL when the provider permits it. Such rows appear
in the archive without another worker (public API cache lifetime: 60 seconds).
No new cron, provider request, dependency or database migration is needed.
Apply migrations through 014 for all live features; archive storage is in 011,
and automatic completion requires the poller and migration 012.

The stream editor accepts an optional YouTube recording link or ID, normalizes
it to a canonical watch URL and can clear it. This covers manually ended
broadcasts, replacement recordings and recordings that were not ready at
completion. A changed provider/video clears the old recording; save a replacement
after changing the video. Disabling archive hides playback on the detail page
as well as removing its card. Re-enabling archive restores a saved recording.

Completed playback uses the saved recording ID, never an old live video or a
playback URL override. Unsupported or unsafe recording URLs produce no player.
URLs are not fetched or checked against YouTube on public requests. Real video
availability, embedding restrictions and deletion remain provider-controlled;
the existing Watch on YouTube fallback remains available.

## Verification

`tests/live-archive.mjs` uses MySQL 8 and owned fixtures to cover eligibility,
pagination, timezone month boundaries, invalid requests, public-field privacy,
recording normalization and replacement, manual completion, poller completion,
archive toggles and safe playback. Run the existing live unit/API/poller suites,
PHP syntax checks, frontend build and design audit, then recorded browser tests
for the bilingual archive, filters, navigation, editor and on-demand player.
