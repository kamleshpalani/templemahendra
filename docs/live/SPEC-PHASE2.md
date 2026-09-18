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
- `GET /api/live-streams/schedule?filter=today|tomorrow|week|festivals|all&limit=` (default `all`, limit default 50 max 100) → `{ streams: [...], filter, window: { from, to (ISO UTC, `to` exclusive), today, timezone, label_ta, label_en }, counts: { today, tomorrow, week, festivals, all }, server_time }`. Items use `liveShapePublic()` plus `day_bucket` (`today|tomorrow|later|past`; a live row is `today`, an undated row `later`) and `starts_in_seconds` (null when no start or already live; negative once the start has passed). Membership (amended 2026-09-16): every public status **except CANCELLED** — COMPLETED (and OFFLINE / ERROR) rows of the window stay listed, a cancelled broadcast leaves the schedule and its counts, as it leaves the Phase 1 upcoming list; live rows belong to every window but `tomorrow`; undated SCHEDULED rows appear on `all` only. Sorting: live first (LIVE, STARTING, in the live list's order), then by `scheduled_start_at` ascending (NULL last), COMPLETED last within a day. `Cache-Control: public, max-age=30`. Go-live note (review O9): `server_time` and `starts_in_seconds` travel in that cached body, so a CDN in front of this route must not hold it longer than `max-age` or must forward `Age`; the browser already asks with `cache: no-store`.
- `GET /api/live-streams` (index) gains `next` = the first upcoming stream (or null) and `now` = the featured live stream (or null) so the homepage and the main page need one call; both carry `day_bucket` and `starts_in_seconds` as schedule items do (the `live` / `upcoming` items keep the plain public shape); `server_time` already present.
- `LIVE_RESERVED_SLUGS` += `schedule`; the routing regex already excludes it from slug lookups by listing it explicitly before the slug branch.

### 1.2 Library (`backend/includes/live/`)
- `store.php`: `liveListSchedule(PDO $db, string $filter, int $limit, string $tz): array{rows, window, counts}` (all filters computed with `liveIstRangeUtc()`-style helpers in `time.php`: `liveDayRangeUtc(string $ymd, string $tz)`, `liveWeekRangeUtc(string $ymd, string $tz)`, `liveTodayLocal(string $tz)`), `liveFeatured(PDO $db): ?array` (the featured live stream: newest LIVE/STARTING by `COALESCE(actual_start_at, scheduled_start_at) DESC`, as fixed in Phase 1), `liveNextUpcoming(PDO $db): ?array` (first SCHEDULED with end/start window not passed, per the Phase 1 F3 rule).
- `providers.php`: `final class VimeoProvider implements StreamingProvider` and `final class AwsIvsProvider implements StreamingProvider` — `isConfigured()` false, `parseReference()` returns null except a plausible id shape (Vimeo: digits or `vimeo.com/(event/)?<id>`; IVS: an ARN or a `.m3u8` https URL, ≤ 100 characters so it fits the column) stored but unusable, `playback()` → `['kind'=>'none']`, `fetchStatus()` → not configured, `label(string $lang = 'en')` (the interface gained the language parameter; both brands read the same in Tamil). Registry lists `youtube, vimeo, aws_ivs, custom`; the admin select keeps them disabled with "coming later".
- `config.php`: `LIVE_SCHEDULE_FILTERS` (`key => [ta, en]`), `LIVE_FESTIVAL_TYPES`.

### 1.3 SEO/search/chat
- `site_pages.php`: `/live-darshan/schedule` → `['நேரடி தரிசன அட்டவணை', 'Live Darshan schedule', 'இன்று, நாளை மற்றும் இந்த வாரத்தின் நேரடி பூஜைகள், அபிஷேகங்கள் மற்றும் திருவிழா ஒளிபரப்புகளின் அட்டவணை.', 'The schedule of live poojas, abhishekams and festival broadcasts for today, tomorrow and this week.']` (the React page passes exactly these to `<Seo>`).
- `search.php` `$PAGES` entry for the schedule (keywords: schedule timetable அட்டவணை live darshan நேரடி தரிசனம்); `chat.php` fact mentions the schedule page.

## 2. Frontend

### 2.1 `lib/live.js`
- `useLiveOverview()` also exposes `now` and `next` from the index route.
- `useSchedule(filter)` → `{ streams, counts, window, serverOffset, loading, error }` from `/api/live-streams/schedule?filter=`; refetch on filter change, **keeping the previous `streams` while `loading`** (only a failed load empties them, so the retry is a first load again — review F6). Polling (amended, review O7): 30 s while a listed broadcast is live, 60 s while any listed row is within ±15 min of its start (a "Starting shortly" pill becomes the Live now group without a reload), otherwise asleep until the nearest start comes into that window (at most 30 min).
- `useCountdown(startsAtIso, serverOffset)` → `{ seconds, parts: { dd, hh, mm, ss }, phase: 'waiting'|'soon'|'started' }` using `Date.now() + serverOffset`; `dd` is null under a day and whole days above it, `hh` then being the hours within the day (review F2); `soon` when < 5 min; ticks with one interval, cleared on unmount; frozen when the tab is hidden and corrected on visibility change.
- `useStartPassed(startsAtIso, serverOffset)` → true once the instant has passed, flipped by one timeout at the instant itself (review F4), so a page's poster and hero flip with the countdown rather than at the next poll.
- `dayLabel(stream, lang)` → "Today" / "Tomorrow" / weekday+date ("இன்று" / "நாளை" / …) from `day_bucket` and the stream's local date. The Tamil later-day label is assembled from `formatToParts` as "வியாழன், 24 செப்டம்பர்" — weekday, day, month, as the day heading reads (review F5), not ICU's "செப்டம்பர் 24, வியாழன்".
- `weekIsOneDay(window)` → true on a Sunday, when "this week" is that one day (review O11).
- `EVENT_TYPE_LABELS` mirrors `LIVE_EVENT_TYPES` in `config.php` exactly, key by key (review O14); `tests/live-api.mjs` compares the two files.

### 2.2 Components (`components/Live/`)
- `StreamCountdown({ startsAt, serverOffset, t })`: `<div className="live-countdown" role="group" aria-label>` with a visual `HH : MM : SS` — `DD : HH : MM : SS` with a "DAYS" / "நாட்கள்" caption from a day out (review F2) — (`aria-hidden`, `font-variant-numeric: tabular-nums`, `--danger*`/gold accents only) and an `sr-only` sentence ("Starts in about 1 hour 35 minutes") refreshed each minute; at `started` it renders "Starting shortly" / "விரைவில் தொடங்கும்". Tamil captions: "நேரடி தரிசனம் தொடங்க இன்னும்" and the units மணி · நிமி · நொடி (review O15). Respects reduced motion (no pulsing).
- `NextDarshanCard({ stream, serverOffset, t, lang })`: eyebrow "Next Live Darshan" / "அடுத்த நேரடி தரிசனம்", title, "Today • 6:30 PM IST" line (`dayLabel` + time), `StreamCountdown`, buttons "View schedule" (→ `/live-darshan/schedule`) and "Details" (→ slug page).
- `LiveNowCard({ stream, t })`: red "LIVE NOW" badge (`Badge tone="danger" live`), thumbnail (16:9 box), title, temple/deity line, "Watch live" (`Button variant="primary"` → slug page). Used by the homepage block.
- `StreamCard` gains the status badge, `dayLabel` and a compact countdown (minutes only) when `starts_in_seconds < 24h`.
- `ScheduleFilters({ value, counts, onChange, t })`: `SegmentedControl` with the five filters and counts. Below 640 px `.live-filters` wraps into two rows (chips keep their 44 px height, tokens only) instead of scrolling a chip out of sight; where the strip does scroll, the selected chip is brought into view on mount and whenever it or the counts change (review F1).

### 2.3 Pages
- `pages/LiveSchedule.jsx` + `.css`, route `live-darshan/schedule` (lazy): `<Seo>` with the §1.3 strings, `PageHero variant="live"` (title "Live Darshan schedule"), filters (`?filter=` synced to the URL with `useSearchParams`, replace; the Share button shares that same address, `?filter=` and all — review O13), a `grid-3` of `StreamCard`s grouped by day with a small day heading (`h2`), per-filter empty states ("No live darshan today. See this week's schedule." with a button that switches the filter — to `all` rather than `week` when the week is one day, i.e. on a Sunday; review O11), skeletons **on the first load and after an error only** (a filter switch keeps the previous list, dimmed and `aria-busy` — review F6), error state with retry, a live region announcing the count ("Showing 3 programmes").
- `pages/LiveDarshan.jsx`: when nothing is live and `next` exists, the main column shows `LivePlayer` poster + `NextDarshanCard` (countdown) instead of only the poster text; the page title stays the list title; "Upcoming live darshans" section links to the schedule. The poster's and the hero's "Starting shortly" comes from `useStartPassed` (review F4), so they flip with the countdown at T+0.
- `pages/Home.jsx`: new `LiveHomeSection` (own file `components/Live/LiveHomeSection.jsx`): `section.section.home-section.reveal` before "Upcoming events", rendered only when `now` or `next` exists; LIVE → `LiveNowCard`; else `NextDarshanCard` (compact variant with "View schedule"); `SectionHeader align="split"` "Live darshan" with a "Schedule" action (44 px tall, `.home-live .section-head__actions .btn` — review F3). The hero panel gets one row "Live darshan" showing "LIVE now" / "Next at 6:30 PM" / "Starting shortly" once that time has passed (`useStartPassed`, review F4) / nothing (row hidden when nothing). No empty section ever (public-e2e's "no empty section" rule).
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

## 5. Review fixes (2026-09-16)

The independent review of the built phase (scratchpad `live/review2/findings-phase2.md`) found the following; each is fixed above and pinned by a test.

| # | What was wrong | What it is now | Pinned by |
| - | -------------- | -------------- | --------- |
| F1 | The five filter chips overflowed a 390 px strip — the selected one sat past the right edge with no scrollbar or fade | `.live-filters` wraps into two rows below 640 px; where it still scrolls, the selected chip is scrolled into view | `live-ui` "filter strip @390 (en/ta)" — every chip inside the viewport, 44 px, the selected one in view |
| F2 | A broadcast days away counted "191 : 38 : 52 HRS" | A days unit from 24 h up ("07 : 23 : 38 : 52", caption DAYS / நாட்கள்); HH : MM : SS under a day; the sr sentence unchanged | `live-ui` "days countdown @1440/@390" and "under a day the clock is HH : MM : SS" |
| F3 | The homepage live section's "Schedule" action was 36 px tall | `.home-live .section-head__actions .btn { min-height: 44px }` | `live-ui` "every target in the live section is at least 44 px tall" |
| F4 | At T+0 the poster, the hero and the homepage's hero row kept the past start time until the next 60 s poll | `useStartPassed` flips them at the instant, with the countdown | `live-ui` "T+0: the poster flips within seconds of the card" / "T+0 (Home): the hero row flips" |
| F5 | The Tamil later-day label read "செப்டம்பர் 24, வியாழன்", unlike the heading above it | Assembled from `formatToParts` as "வியாழன், 24 செப்டம்பர்" | `live-ui` "Tamil: a later day reads weekday, day month" |
| F6 | Switching a filter blanked the list into skeletons | The previous list stays, dimmed and `aria-busy`; skeletons only on the first load and after an error | `live-ui` "slow API" (the answer held back 900 ms) |
| O7 | The schedule page never refetched unless something was already live | 30 s while live, 60 s while a listed row is within ±15 min of its start, else asleep until it is | `live-ui` "go live: a poll moves it into the Live now group without a reload" |
| O9 | `max-age=30` covers `server_time` | Go-live note in §1.1 (a CDN must not hold the route longer, or must forward `Age`) | — (documentation) |
| O11 | On a Sunday the Today/Tomorrow empty states offered a "this week" that was the same one day | `weekIsOneDay(window)` sends both to `all` | `live-ui` "today with nothing" and the forced Sunday/Monday windows |
| O13 | Share handed out `/live-darshan/schedule` without the filter | The address shared is the one on screen | `live-ui` "the share sheet hands out the schedule with ?filter=week" |
| O14 | `EVENT_TYPE_LABELS.procession` said "ஊர்வலம்", `config.php` "திருவீதி உலா" | The mirror matches, key by key | `live-api` "the browser's event-type labels mirror config.php exactly" |
| O15 | "நேரடி தரிசனம் தொடங்க" read clipped; "வினா" for seconds | "நேரடி தரிசனம் தொடங்க இன்னும்"; "நொடி" | `live-ui` "days countdown (ta): the caption reads as a sentence" |

Left as built, deliberately: O8 (homepage polling), O10 (the start time appears four times on `/live-darshan` — each in its own role), O12 (`counts` are the window's totals, not capped by `limit`).
