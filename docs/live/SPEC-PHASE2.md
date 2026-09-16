# Live Darshan — Phase 2 build contract (scheduling and automation, client phase 2)

Status: build contract, 2026-09-15. Starts only after Phase 1 is closed (review findings fixed, suites green). Every builder follows this file; where it and the code disagree, this file wins; where it is silent, follow `docs/live/SPEC-PHASE1.md` (as amended) and the existing conventions. **Nothing from Phase 3+ is built here** (no YouTube API calls, no cron, no notifications, no donations link).

## 0. Scope (from the client's Phase 2)

1. `/live-darshan/schedule` with filters **Today · Tomorrow · This Week · Festivals · All**; cards show title, temple, deity, date, time, thumbnail, status.
2. Countdown "Live Darshan starts in **HH : MM : SS**" on upcoming streams, driven by server/event time, never the device clock alone.
3. Upcoming state on `/live-darshan` when nothing is live: "Next Live Darshan · Evening Deeparadhana · Today • 6:30 PM · [countdown]".
4. Homepage integration: when live → "🔴 LIVE NOW · Morning Abhishekam · [Watch Live]"; when upcoming → "Next Live Darshan · Evening Deeparadhana · 6:30 PM · [View Schedule]"; nothing when neither (no empty band).
5. Provider abstraction: the `StreamingProvider` interface exists from Phase 1; add named placeholders `VimeoProvider` and `AwsIvsProvider` (not configured, never selectable yet) so Phase 16 has its slots.

Decisions (recommended options, taken without waiting): the schedule window is computed in the temple timezone (Asia/Kolkata) on the server; "This Week" = today through the coming Sunday inclusive; "Festivals" = `event_type IN ('festival','procession','special_event')`; "All" = every public stream from the start of today onward (next 90 days) plus anything live; COMPLETED streams of today stay on the Today list (marked Ended) so devotees see what already happened; the homepage block is a `home-section` placed before "Upcoming events", rendered only when the API returns a live or upcoming stream; the countdown is visual (`aria-hidden`) with a plain-text sentence for screen readers updated once a minute.

## 1. Backend

### 1.1 Public API additions (`backend/api/live_streams.php`, routing block already matches any slug — add `schedule` to the reserved words and the route list)
- `GET /api/live-streams/schedule?filter=today|tomorrow|week|festivals|all&limit=` (default `all`, limit default 50 max 100) → `{ streams: [...], filter, window: { from, to (ISO UTC) , label_ta, label_en }, counts: { today, tomorrow, week, festivals, all }, server_time }`. Items use `liveShapePublic()` plus `day_bucket` (`today|tomorrow|later|past`) and `starts_in_seconds` (null when no start or already live). Sorting: live first (LIVE, STARTING), then by `scheduled_start_at` ascending (NULL last), COMPLETED last within a day. `Cache-Control: public, max-age=30`.
- `GET /api/live-streams` (index) gains `next` = the first upcoming stream (or null) and `now` = the featured live stream (or null) so the homepage and the main page need one call; `server_time` already present.
- `LIVE_RESERVED_SLUGS` += `schedule`; the routing regex already excludes it from slug lookups by listing it explicitly before the slug branch.

### 1.2 Library (`backend/includes/live/`)
- `store.php`: `liveListSchedule(PDO $db, string $filter, int $limit, string $tz): array{rows, window, counts}` (all filters computed with `liveIstRangeUtc()`-style helpers in `time.php`: `liveDayRangeUtc(string $ymd, string $tz)`, `liveWeekRangeUtc(string $ymd, string $tz)`, `liveTodayLocal(string $tz)`), `liveFeatured(PDO $db): ?array` (the featured live stream: newest LIVE/STARTING by `COALESCE(actual_start_at, scheduled_start_at) DESC`, as fixed in Phase 1), `liveNextUpcoming(PDO $db): ?array` (first SCHEDULED with end/start window not passed, per the Phase 1 F3 rule).
- `providers.php`: `final class VimeoProvider implements StreamingProvider` and `final class AwsIvsProvider implements StreamingProvider` — `isConfigured()` false, `parseReference()` returns null except a plausible id shape (Vimeo: digits or `vimeo.com/(event/)?<id>`; IVS: an ARN or a `.m3u8` https URL) stored but unusable, `playback()` → `['kind'=>'none']`, `fetchStatus()` → not configured, `label()` bilingual. Registry lists `youtube, vimeo, aws_ivs, custom`; the admin select keeps them disabled with "coming later".
- `config.php`: `LIVE_SCHEDULE_FILTERS` (`key => [ta, en]`), `LIVE_FESTIVAL_TYPES`.

### 1.3 SEO/search/chat
- `site_pages.php`: `/live-darshan/schedule` → `['நேரடி தரிசன அட்டவணை', 'Live Darshan schedule', 'இன்று, நாளை மற்றும் இந்த வாரத்தின் நேரடி பூஜைகள், அபிஷேகங்கள் மற்றும் திருவிழா ஒளிபரப்புகளின் அட்டவணை.', 'The schedule of live poojas, abhishekams and festival broadcasts for today, tomorrow and this week.']` (the React page passes exactly these to `<Seo>`).
- `search.php` `$PAGES` entry for the schedule (keywords: schedule timetable அட்டவணை live darshan நேரடி தரிசனம்); `chat.php` fact mentions the schedule page.

## 2. Frontend

### 2.1 `lib/live.js`
- `useLiveOverview()` also exposes `now` and `next` from the index route.
- `useSchedule(filter)` → `{ streams, counts, window, serverOffset, loading, error }` from `/api/live-streams/schedule?filter=`; refetch on filter change; poll every 60 s while any stream is live.
- `useCountdown(startsAtIso, serverOffset)` → `{ seconds, parts: { hh, mm, ss }, phase: 'waiting'|'soon'|'started' }` using `Date.now() + serverOffset`; `soon` when < 5 min; ticks with one interval, cleared on unmount; frozen when the tab is hidden and corrected on visibility change.
- `dayLabel(stream, lang)` → "Today" / "Tomorrow" / weekday+date ("இன்று" / "நாளை" / …) from `day_bucket` and the stream's local date.

### 2.2 Components (`components/Live/`)
- `StreamCountdown({ startsAt, serverOffset, t })`: `<div className="live-countdown" role="group" aria-label>` with a visual `HH : MM : SS` (`aria-hidden`, `font-variant-numeric: tabular-nums`, `--danger*`/gold accents only) and an `sr-only` sentence ("Starts in about 1 hour 35 minutes") refreshed each minute; at `started` it renders "Starting shortly" / "விரைவில் தொடங்கும்". Respects reduced motion (no pulsing).
- `NextDarshanCard({ stream, serverOffset, t, lang })`: eyebrow "Next Live Darshan" / "அடுத்த நேரடி தரிசனம்", title, "Today • 6:30 PM IST" line (`dayLabel` + time), `StreamCountdown`, buttons "View schedule" (→ `/live-darshan/schedule`) and "Details" (→ slug page).
- `LiveNowCard({ stream, t })`: red "LIVE NOW" badge (`Badge tone="danger" live`), thumbnail (16:9 box), title, temple/deity line, "Watch live" (`Button variant="primary"` → slug page). Used by the homepage block.
- `StreamCard` gains the status badge, `dayLabel` and a compact countdown (minutes only) when `starts_in_seconds < 24h`.
- `ScheduleFilters({ value, counts, onChange, t })`: `SegmentedControl` with the five filters and counts.

### 2.3 Pages
- `pages/LiveSchedule.jsx` + `.css`, route `live-darshan/schedule` (lazy): `<Seo>` with the §1.3 strings, `PageHero variant="live"` (title "Live Darshan schedule"), filters (`?filter=` synced to the URL with `useSearchParams`, replace), a `grid-3` of `StreamCard`s grouped by day with a small day heading (`h2`), per-filter empty states ("No live darshan today. See this week's schedule." with a button that switches the filter), skeletons, error state with retry, a live region announcing the count ("Showing 3 programmes").
- `pages/LiveDarshan.jsx`: when nothing is live and `next` exists, the main column shows `LivePlayer` poster + `NextDarshanCard` (countdown) instead of only the poster text; the page title stays the list title; "Upcoming live darshans" section links to the schedule.
- `pages/Home.jsx`: new `LiveHomeSection` (own file `components/Live/LiveHomeSection.jsx`): `section.section.home-section.reveal` before "Upcoming events", rendered only when `now` or `next` exists; LIVE → `LiveNowCard`; else `NextDarshanCard` (compact variant with "View schedule"); `SectionHeader align="split"` "Live darshan" with a "Schedule" action. The hero panel gets one row "Live darshan" showing "LIVE now" / "Next at 6:30 PM" / nothing (row hidden when nothing). No empty section ever (public-e2e's "no empty section" rule).
- Nav: none new; the schedule is reachable from the Live Darshan page, the homepage block, and the footer link "Live Darshan" (unchanged).

### 2.4 Rules
Bilingual `t()`, tokens only, audit 0, `fetch` only, one `h1`, 44 px targets, reduced motion, no new dependency, NetworkOnly rule already covers `/api/live-streams`.

## 3. Tests

- `tests/live-unit.php` + : day/week/festival window computations in Asia/Kolkata (today/tomorrow/week boundaries at 23:59 IST, week ending Sunday, month/year rollovers), `day_bucket` and `starts_in_seconds`, ordering (live first, NULL last, COMPLETED last), reserved slug `schedule`, Vimeo/IVS providers (reference parsing, not configured, playback none).
- `tests/live-api.mjs` + : fixtures across today/tomorrow/this week/next week/past/festival/live/completed-today/draft/deleted; every filter's membership and order; counts; `window` ISO; `limit` cap; `filter=bogus` → `all`; `next`/`now` on the index route; cache headers; no private keys.
- `tests/live-ui.mjs` + : `/live-darshan/schedule` at 390/768/1024/1440 (one h1, overflow, console, axe with `iframes:false`), filter switching updates the URL and the list, counts, empty states per filter with the switch button, day headings; countdown: with a fixture starting in 90 s the display counts down (two samples 5 s apart differ by ~5 s), the sr-only sentence exists, at T+0 it shows "Starting shortly", and a mocked `server_time` skewed by +10 min shifts the countdown (proves server-offset use); homepage LIVE state (red LIVE NOW card, Watch live → slug page), upcoming state (Next card + countdown + View schedule), nothing state (no live section, no empty band); hero panel row; Tamil/English.
- Existing lists (append only): `og.mjs` ROUTES + `public-e2e.mjs` ROUTES (`/live-darshan/schedule`), `search-api.mjs` (terms "schedule", "அட்டவணை").
- Regression list as Phase 1 (§6), plus the payments suites are NOT run by the live builder.

## 4. Ownership / order

One builder for backend + frontend + tests is acceptable (the change is mostly frontend); if two, the backend builder writes `asbuilt-phase2-backend.md` first. Then integration (all live suites + regression), independent review (correctness of windows/countdown, UX at both widths, Tamil), fixes, docs (README Live Darshan section: schedule page, homepage block). Ports: PHP 8081-8089, Vite 5195, XFF 10.84.0.x, prefixes `E2E-LIVE2-`.

Acceptance: schedule page with the five filters and the listed card fields; countdown in HH : MM : SS from server time; the upcoming state on `/live-darshan`; homepage LIVE NOW / Next Live Darshan / nothing; provider placeholders present; all suites green; regression unchanged.
