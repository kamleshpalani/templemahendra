# Temple Live Streaming — Phase 0: existing project analysis

Date: 2026-09-14. Read-only analysis of the codebase plus research into YouTube Live. Nothing was changed. This is the deliverable the requirement asks for before Phase 1 ("Existing Architecture Summary, Reusable Components, Reusable Backend Services, Database Changes Required, Proposed Live Streaming Architecture, Files Expected to Be Modified, Files Expected to Be Created").

Where a line number is given it is from the file as read today; the CCAvenue payments build is still landing, so numbers in shared files will shift slightly.

---

## 1. Existing Architecture Summary

### 1.1 Frontend (`frontend/`)
| Item | What exists |
|---|---|
| Framework | React 18 + Vite 5, JavaScript (no TypeScript), `react-router-dom` v6, `react-helmet-async` for `<Seo>`, PWA via `vite-plugin-pwa` (Workbox). |
| Routing | `frontend/src/App.jsx`: every page lazy-loaded except Home, all under `<Layout>` → `<PageTransition>` (keyed on pathname; `useReveal`). Routes today: `/`, `/about`, `/sevas`, `/events`, `/gallery`, `/donations`, `/contact`, `/panchangam`, `/search`, `/register`, four policy pages, `/donate`, `/payment/result|receipt|verify` (payments, in progress), retired account paths → `/register`, `*` → NotFound. |
| Component architecture | Pages in `src/pages/*.jsx` (+ a CSS file each), shared primitives in `src/components/ui/` (Button, Badge, PageHero, SectionHeader, Tabs=SegmentedControl, Chip, Field, Modal, Feedback: SkeletonCards/SkeletonText/EmptyState/ErrorState/PageLoader), feature components in `src/components/<Feature>/`, hooks in `src/hooks/`, helpers in `src/lib/`, static facts in `src/data/temple.js`. |
| State management | React contexts only: `LangContext` (`lang`, `setLang`, `t(ta, en)`), `ToastContext`. No Redux/Zustand. Pages fetch in `useEffect`. Shared-config pattern: a module-level promise cache + hook (`lib/payments.js` `usePaymentsConfig`). Browser storage wrapped in try/catch (`temple:lang`, drafts in sessionStorage). |
| API layer | `src/services/api.js` axios (`baseURL /api`, 10 s, no credentials; logs every non-2xx to `console.error`). Pages that may legitimately get a 4xx use `fetch` (`getJson/postJson` in `lib/payments.js`). Dev proxy `/api`, `/admin`, `/uploads` → `VITE_PROXY_TARGET || http://localhost:8000`. |
| Authentication | None on the public site (devotee login was removed; family registration only). Admin is a separate PHP app under `/admin`. |
| UI library / styling | In-house "Sacred Light" design system: `src/styles/{tokens,base,layout,components,utilities}.css`, tokens only (no raw colours, no visual inline styles), `react-icons/lu`, 44 px touch targets, breakpoints 480/640/820/1024/1280/1536. Enforced by `npm run audit` (must stay at 0 findings; also scans `backend/admin`). Colour rules: moon = lunar content only, sage = auspicious-time only; there is **no "live" token** — a LIVE red uses the `--danger*` family (`--danger-on-dark` on ink). Pulsing-dot patterns exist (`Badge live`, `.pulse-pill__dot`). |
| Homepage | `src/pages/Home.jsx`: hero with a live temple-status panel (open/closed, next pooja, hours, next pournami — computed from the browser clock via `lib/templeTime.js` and `/api/pulse`), a "live band" strip (notices / nalla neram / donors), `HomepageWidgets` bento (DB widgets + synthesised cards), a "Plan your visit" mode switcher whose **NRI / Online** mode has a "Live Stream" tile linking to `https://youtube.com/@TempleMahendra` (Home.jsx:288-306), sevas, events, quick links, reviews. Section rhythm was compacted this week (`.home-section`). |
| Event pages | `src/pages/Events.jsx`: timeline of `/api/events` merged with computed pournami dates, filter tabs (SegmentedControl), `PageHero` + `ShareButton`, skeletons, empty state; no images, no per-event route, no dialog. |
| Responsive patterns | Mobile bottom nav ≤768 px (5 tabs), hamburger drawer ≤1023 px, `.split` two-column → one column ≤820, `.grid-*` collapse at 1024/820/640, mobile "dock" portalled to `document.body` for multi-step forms (Register, Donate). Public-e2e checks every route at 390/768/1024/1440 (one h1, no horizontal overflow, no console errors, axe at 1440). |
| Localisation | Every string inline as `t("தமிழ்", "English")`; `<html lang>` follows the choice; dates via `Intl` with `ta-IN`/`en-IN` and `timeZone: "Asia/Kolkata"`. No dictionary files. |
| Media | Plain `<img loading="lazy">` from `/uploads/<file>`; no `<picture>/srcset`, no `aspect-ratio` helper, no video element, no player library. The only iframe is the Google Maps embed on Contact. No CSP on the site (only `X-Frame-Options SAMEORIGIN`, nosniff, Referrer-Policy) — a YouTube iframe is not blocked. |
| Service worker | Workbox: `/api/*` GET = NetworkFirst (5 s, 1 h cache, 30 entries); `/api/payments*` = NetworkOnly (added by the payments build). A live-status poll **would be cached** unless a NetworkOnly rule is added. |

### 1.2 Backend (`backend/`)
| Item | What exists |
|---|---|
| Framework | None. Plain PHP 8.3, function-based modules under `backend/includes/`, PDO with prepared statements (`getDB()`, ERRMODE_EXCEPTION, `utf8mb4`), no ORM, no classes except the notification provider contract (`NotifyProvider` interface + value objects) and the new payments module. |
| API architecture | Front controller `backend/api/index.php`: exact-match route table (`GET /events`, `/sevas`, `/pulse`, … ; `POST /donations`, `/contact`, `/seva-bookings`, `/chat`) plus `preg_match` blocks before it for parameterised paths (`/n/…`, `/notify-webhook/…`, `/registrations`, `/payments/…`). Handlers answer with `sendJson`/`sendError`. CORS via `setCorsHeaders()`. In production any existing `backend/api/*.php` can be hit directly (htaccess), so handlers must be self-guarding. |
| Services / controllers / middleware | No such layers. "Services" = include files with functions (`includes/notify/*`, `includes/payments/*`, `includes/registration.php`). "Middleware" = `public_guard.php` (honeypot `hp_token`, per-IP flood buckets in `PUBLIC_GUARD_LIMITS`, 429 with `Retry-After`) and `rate_limit.php`. |
| Authentication / authorization | Admin only: `includes/auth.php` PHP sessions, `admin_users` table (roles `viewer < editor < owner`, linear) + an env bootstrap owner, capabilities in `ADMIN_CAPABILITIES` (`view`, `export`, `content.edit`, `devotees.edit`, `import`, `settings.edit`, `users.manage`, `notifications.*`, `payments.*`), per-page read/write capability maps, CSRF (`csrfField`/`csrfValid`), forced password change, `adminAudit()` → `admin_activity`. **There is no `/api/admin/*` REST layer**; admin writes are form POSTs to server-rendered pages with Post/Redirect/Get. The closest "admin API" is the in-page JSON pattern (`ncJson` in `admin/notifications.php`). |
| Validation | Per-field in each handler: `sanitizeText`, `normalizePhone`, `isValidDate`, `filter_var`; 422 `{error, fields}` for JSON APIs (registration, payments); admin forms re-render with `aria-invalid` + `.alert--error`. No datetime/timezone validator except `notifyToUtc()`/`notifyIsTimezone()` in `includes/notify/time.php`. |
| Logging | `error_log('[module] …')` prefixes; `notifyLogWrite()` to `backend/logs/*.log`; `notifyRedact()` scrubs secrets/PII from log text. |
| Error handling | API: JSON exception handler → 500 `{error, reference}` (no stack traces). Admin: `errors.php` renders a fatal page and turns warnings into exceptions. |
| Scheduled jobs | `bin/notify_worker.php` (CLI, `GET_LOCK`) and `/api/notify-cron` (key-protected HTTP trigger); the payments build adds `bin/payments_cron.php` + `/api/payments-cron` in the same shape. Outbound HTTP through `notifyHttp()` (curl, never throws, base URLs overridable by env for mocks). |
| Secrets | Environment variables read with `envValue()`; `backend/.env.example` documents them. The payments build adds an encrypted admin-entered settings store (`payment_settings`, `sodium_crypto_secretbox`, key in `PAYMENTS_SETTINGS_KEY`) — the pattern to copy for YouTube credentials later. |
| Uploads | Only `admin/gallery.php`: sniffs the image with `getimagesize()` (JPEG/PNG/WebP), ≤ 5 MB, random 24-hex filename, stored in `backend/uploads/`, served at `/uploads/<file>`, deny-all for scripts. No shared helper, no resizing. Image-by-URL fields also exist (campaign `image_url`, validated by `notifySafeCtaUrl()`: site path or https, ≤ 500 chars). |
| Analytics | None for pages/visitors. Only notification delivery tracking (`/api/n/…` opens/clicks) and `admin/notification_analytics.php`. |

### 1.3 Database
- MySQL 8.4, `utf8mb4_unicode_ci`, no ORM. Base install = `database/schema.sql` + migrations `001`–`010` applied in order (hand-run; idempotent via `information_schema` guards; `INSERT IGNORE` seeds; `VARCHAR` status columns rather than ENUMs in recent migrations; new tables store **UTC** written with `UTC_TIMESTAMP()`, legacy tables use server-zone `CURRENT_TIMESTAMP`).
- 40 tables. Relevant ones: `events` (title_ta/en, description, event_date DATE, is_active — no time, image, slug or timestamps), `poojas`, `sponsors`, `homepage_widgets` (ENUM content types; links to poojas/sponsors only), `homepage_settings` (public booleans), `gallery`, `announcements`, `sevas`, `seva_bookings`, `donations` (+ payments columns), `admin_users`, `admin_activity`, `devotees` (family registrations), the notification tables, `rate_limits`, and the payments tables (`payment_transactions`, `payment_refunds`, `payment_audit_log`, `payment_settings`, `payment_counters`, `donation_categories`).
- **Temple entity: none** — the temple is a constant (`frontend/src/data/temple.js` `TEMPLE`, `ADDRESS`, `TRUST`; duplicated in `includes/notify/defaults.php` and `api/chat.php`).
- **Deity entity: none** — `TEMPLE.deities` in `temple.js` (Sri Lingammal, Sri Renukadevi, Sri Chinnammal).
- **User entity:** `admin_users` (committee) only; devotees have no login.
- **Event entity:** `events` (above). **Donation entity:** `donations` + payments tables.
- Nothing stream-, video- or YouTube-related exists in any table.

### 1.4 Existing modules (reuse targets)
| Module | State | Relevance to live streaming |
|---|---|---|
| Admin panel | Server-rendered PHP pages with a shared layout (`admin_layout.php` nav groups, `admin_ui.php` helpers: badges, KPIs, tables, pagination, menus with confirm dialogs, filter chips, CSV helpers), `admin.js` behaviours (`data-confirm`, `data-toggle-password`, table search, bulk bars). `admin/events.php` and `admin/sevas.php` are the CRUD templates to copy. | The Live Streaming admin page follows this skeleton. |
| Notifications | Email / WhatsApp / SMS service with a template catalogue, guest recipients, consent rules, queue + worker, campaigns with owner approval; an automatic "event tomorrow" campaign already exists (`notify/reminders.php`) and categories `event` and `special_darshan` exist. In-app bell and push were removed with devotee accounts. | Phase 6 "Notify Me" can reuse the guest-recipient + campaign engine; the "website notification bell" no longer exists and would have to be a cookie-less, page-level subscription (see §5.9). |
| Email | `includes/mailer.php` (SMTP, HTML + text, no attachments) behind the notification service. | Reminder emails. |
| CCAvenue payments | In progress (docs/payments/SPEC.md): donations and seva bookings as "payables", simulator, admin pages, receipts. | Phase 7 links a donation to a stream by adding a `live_stream_id` to the payable, reusing the whole flow. |
| Language translation | Inline `t(ta, en)` everywhere; server copy bilingual in `site_pages.php`, notification templates, admin labels in English. | Every new string is bilingual from Phase 1; no separate pages per language. |
| File uploads / media | `gallery.php` upload code; URL fields validated by `notifySafeCtaUrl`. | Thumbnail/banner: a small shared helper copied from gallery.php + URL alternative. |
| Analytics | Only notification tracking. | Phase 11 needs new tables (viewer samples, events) fed by the provider poller. |
| Testing | Plain Node ESM suites (`fetch` + Playwright) and PHP CLI unit scripts in `tests/`, run against per-suite PHP servers (`serve.sh <port>`) and a test Vite; fixtures via PHP CLI scripts; suite-unique `X-Forwarded-For` blocks; style-A output (`✓/✗`, `N passed, M failed`). Regression baseline defined in `map-tests` (see §9). | The four Phase 1 suites follow this shape exactly. |

---

## 2. Reusable Components (frontend)

| Component / helper | Exact API | Use in Live Darshan |
|---|---|---|
| `Button` (`ui/Button.jsx`) | `{ variant: default\|primary\|gold\|outline\|outline-light\|soft\|ghost\|danger\|success, size: xs\|sm\|md\|lg, block, icon, trailingIcon, iconOnly, loading, to, href, type, disabled }` | Watch / Schedule / YouTube fallback buttons |
| `Badge` (`ui/Badge.jsx`) | `{ tone: default\|gold\|success\|warning\|danger\|info\|moon\|sage\|muted\|on-dark, live, size }` | Status badge (LIVE = `danger` + `live` dot; SCHEDULED = `info`; COMPLETED/OFFLINE = `muted`; ERROR = `danger`) |
| `PageHero` (`ui/PageHero.jsx`) | `{ variant, eyebrow, title, lead, children, crumbs, actions, aside, className }` — renders the page's only `<h1>` | Page header (new `.page-hero--live` variant in `layout.css`) |
| `SectionHeader` | `{ eyebrow, title, subtitle, align: center\|left\|split, actions, as, id, className }` | "Upcoming live darshans" section |
| `SegmentedControl` (`ui/Tabs.jsx`, default export) / `Chip` (`ui/Field.jsx`) | `{ items:[{value,label,count?,icon?}], value, onChange, label, variant }` / `{ active, count, children }` | Phase 2 schedule filters (Today / Tomorrow / This week / Festivals / All) |
| `SkeletonCards`, `SkeletonText`, `EmptyState`, `ErrorState`, `PageLoader` (`ui/Feedback.jsx`) | `SkeletonCards({count, className, height})`, `EmptyState({icon, title, children, action, compact, tone})`, `ErrorState({title, children, onRetry})` | Loading / "no stream" / failed states |
| `ShareButton` (`components/Share/ShareButton.jsx`) + `ShareSheet` | `{ title, text, to, url, label, variant, size, iconOnly }` — WhatsApp, Facebook, LinkedIn, X, email, copy link, native share | Phase 1 share button; Phase 5 is mostly metadata work |
| `Seo` (`components/Seo.jsx`) | `{ title, description, image, imageAlt, type, robots, children }` — canonical/og/twitter tags | Per-stream title, description, thumbnail, `type="video.other"` |
| `Modal` (`ui/Modal.jsx`) | `{ open, onClose, title, eyebrow, description, size, labelledBy, children }` (portal, focus trap, bottom sheet ≤640) | Not needed in Phase 1; available for a "Notify me" sheet later |
| `Alert` (`ui/Alert.jsx`) | `{ tone, title, onClose, children }` | "Stream ended / temporarily unavailable" notices |
| `useLang()` → `{ lang, setLang, t }`, `useToast()`, `useReveal()` | — | Everywhere |
| `lib/templeTime.js` | `getISTNow()`, `isTempleOpen()`, `getNextPooja()`, `secToHMS(sec)`, `to12h("HH:MM")`, `todayIST()` | Countdown rendering (`secToHMS`), IST display |
| `lib/share.js` | `siteOrigin()`, `absoluteUrl(path)`, `currentUrl()`, `copyText()`, `canNativeShare()`, `nativeShare()` | Share URLs, QR/OG links |
| `lib/payments.js` (in progress) | `getJson/postJson` (never throw), module-level promise cache + `usePaymentsConfig()` hook, `formatIstDate/formatIstDateTime` | Pattern for `useLiveStreams()`; the IST formatters are reused directly |
| Layout surfaces | `NAV_LINKS` (Layout.jsx), drawer (follows NAV_LINKS), `BottomNav` tabs, Footer `quickLinks`, Home NRI tile (`Home.jsx:288-306`), hero status panel | Entry points for Live Darshan |
| CSS primitives | `.card` (+ `--ink`, `--static`, `--interactive`), `.split` + `.split__sticky`, `.grid-3/4`, `.bento`, `.rise`/`.reveal`, `.badge--live` pulse, `.section.home-section` rhythm | Player + meta layout, cards |

Not reusable / missing: an aspect-ratio box (new `.live-player__frame { aspect-ratio: 16/9 }`), any video player (a plain YouTube iframe is enough for Phase 1), a countdown component (new `StreamCountdown`, Phase 2), a "live" colour token (use `--danger*`).

---

## 3. Reusable Backend Services

| Service | Signature / location | Use |
|---|---|---|
| DB + helpers | `getDB(): PDO`; `sendJson`, `sendError`, `sanitizeText`, `intParam`, `boolParam`, `isValidDate`, `envValue`, `siteUrl` (`includes/helpers.php`) | All handlers |
| Admin auth | `requireAdminAuth()`, `requireAdminCan($cap)`, `adminCan()`, `currentAdmin()`, `csrfField()/csrfValid()`, `adminCsrfGuard()`, `adminAudit($action, $subject, $detail)` (`includes/auth.php`, `admin/includes/admin_ui.php`) | Admin page + admin JSON API |
| Admin UI | `adminHeader/adminFooter`, `adminPageIntro`, `adminBadge($text, $tone, $live)`, `adminKpi`, `adminMenu` (with `confirm`), `adminPaginate`, `adminPagination`, `adminSortLink`, `adminEmpty`, `adminFmtDate`, `h()` | Live Streaming page |
| Public guard | `PUBLIC_GUARD_LIMITS` + `publicGuardLimit($bucket)`, honeypot helpers, `publicGuardHasColumn()` | Phase 1 public GETs are unlimited like `/api/events`; Phase 6 subscribe POST gets buckets + honeypot |
| Time | `notifyToUtc($local, $tz)`, `notifyFromUtc($utc, $tz, $fmt)`, `notifyIsTimezone($tz)`, `notifyNow()`, `notifyIso($utc)` (`includes/notify/time.php`; loadable with `notify/contracts.php`) — or the payments copies `payUtcNow()/payIstDate()` | Schedule conversion and validation |
| URL validation | `notifySafeCtaUrl($url)` (`includes/notify/tracking.php`): site path or https, ≤ 500 chars | thumbnail_url, banner_url, playback_url, recording_url |
| Outbound HTTP | `notifyHttp($method, $url, $headers, $body, $timeout)` → `{status, headers, body, error}`; `notifyRedact($text)` (`includes/notify/contracts.php`) | YouTube oEmbed (Phase 1, optional) and Data API / OAuth (Phase 3) |
| Encrypted settings | `paySecretEncrypt/paySecretDecrypt` pattern (`includes/payments/config.php`, sodium secretbox, env key) — copy, not shared (its save function only accepts payment keys) | Phase 3 YouTube credentials entered in the admin |
| Upload handling | `admin/gallery.php` lines 28-74 (size guard, `getimagesize` sniff, random name, `move_uploaded_file`) — copy into a shared helper | Thumbnail / banner upload |
| Scheduled job shape | `bin/payments_cron.php` + `api/payments_cron.php` (CLI guard, `--limit/--max-seconds`, key-protected HTTP trigger, `GET_LOCK`) | Phase 3 provider poller (`bin/live_cron.php`, `/api/live-cron`) |
| Notifications | `devoteeNotifyEvent($event, $ctx)` (guest recipients by phone/email, channels, dedupe keys), campaign engine + `notifyRemindBroadcast()` precedent, categories `event` / `special_darshan` | Phase 6 reminders ("24 h / 1 h / 15 min before / live now") |
| SEO / search / chatbot | `sitePages()` (`includes/site_pages.php`), `api/og.php` per-item preview branches (`/sevas?seva=` pattern), `api/search.php` `$PAGES`, `api/chat.php` facts | Register `/live-darshan`; per-stream previews in Phase 5 |
| Payments | payable model (`payCreateDonation`, receipts, admin detail) | Phase 7: donation with `live_stream_id` |

---

## 4. Database Changes Required

### Phase 1 — `database/migrations/011_live_streams.sql`
Conventions: header comment, "Requires 001–010", "Safe to re-run", `CREATE TABLE IF NOT EXISTS … ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`, column `COMMENT`s, `INSERT IGNORE` seeds, guarded `ALTER`s, `VARCHAR` status lists, **UTC** DATETIMEs.

**`temples`** (new, seeded with the one temple from `temple.js`) — `id`, `slug` UNIQUE (`pudupatti`), `name_ta`, `name_en`, `short_name_ta/en`, `address_ta/en`, `timezone` DEFAULT 'Asia/Kolkata', `logo_url`, `is_active`, `sort_order`, `created_at/updated_at` (UTC).

**`deities`** (new, seeded with the three deities) — `id`, `temple_id` FK → temples (CASCADE), `slug`, `name_ta`, `name_en`, `description_ta/en`, `image_url`, `sort_order`, `is_active`, timestamps; UNIQUE (`temple_id`, `slug`).

Why tables rather than a code list: the admin form needs Temple/Deity selects, the API returns temple/deity objects, and the later multi-temple/RBAC phases expect real ids with FK integrity. This is new precedent (every other module treats the temple as a constant); those copies stay untouched.

**`live_streams`** (new) — the requirement's field list, typed to the conventions:

| Column | Type | Notes |
|---|---|---|
| id | INT UNSIGNED PK AI | |
| temple_id | INT UNSIGNED NOT NULL, FK → temples (RESTRICT) | |
| deity_id | INT UNSIGNED NULL, FK → deities (SET NULL) | |
| title_ta, title_en | VARCHAR(300) NOT NULL | mirrors `events` |
| slug | VARCHAR(120) NOT NULL UNIQUE | `^[a-z0-9][a-z0-9-]{1,118}$`; never `live` / `upcoming` / `schedule` / `archive`; auto from title_en, editable |
| description_ta, description_en | TEXT NULL | |
| event_type | VARCHAR(40) NOT NULL DEFAULT 'live_darshan' | list in code: live_darshan, daily_pooja, abhishekam, deeparadhana, festival, bhajan, discourse, procession, special_event, other |
| provider | VARCHAR(20) NOT NULL DEFAULT 'youtube' | youtube, vimeo, aws_ivs, custom (only youtube implemented) |
| provider_broadcast_id | VARCHAR(100) NULL | YouTube: the video id the admin pastes |
| provider_stream_id | VARCHAR(100) NULL | YouTube `liveStream` id (Phase 3); **never public** |
| playback_url | VARCHAR(500) NULL | derived for YouTube when blank; admin override allowed |
| recording_url | VARCHAR(500) NULL | Phase 8 |
| thumbnail_url, banner_url | VARCHAR(500) NULL | `/uploads/...` or https |
| scheduled_start_at, scheduled_end_at | DATETIME NULL (UTC) | |
| actual_start_at, actual_end_at | DATETIME NULL (UTC) | |
| timezone | VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata' | zone the schedule was entered in |
| status | VARCHAR(20) NOT NULL DEFAULT 'DRAFT' | DRAFT SCHEDULED STARTING LIVE COMPLETED CANCELLED OFFLINE ERROR |
| is_featured, show_on_homepage | TINYINT(1) DEFAULT 0 | |
| donations_enabled, notifications_enabled, sharing_enabled, archive_enabled | TINYINT(1) DEFAULT 1 | |
| created_by, updated_by | VARCHAR(60) NULL | admin username (the env bootstrap owner has no `admin_users` row, so no FK — same as `admin_activity`) |
| created_at, updated_at | DATETIME NOT NULL (UTC) | |
| deleted_at | DATETIME NULL (UTC) | soft delete; every query filters `deleted_at IS NULL` |

Indexes: `(status, scheduled_start_at)`, `(deleted_at, status, scheduled_start_at)`, `(show_on_homepage, deleted_at)`, `(temple_id)`, `(deity_id)`, `(provider, provider_broadcast_id)`.

### Later phases (for planning only)
- 012: `live_stream_subscriptions` (Phase 6: id, live_stream_id, email, phone?, channel, reminders wanted, status, unsubscribe_token, timestamps; UNIQUE (live_stream_id, email, channel)); guarded `ALTER`s on `live_streams` for health columns (Phase 9: `health_status`, `last_status_check_at`, `last_successful_check_at`, `last_error`, `viewer_count`), `live_settings` k/v with `is_secret` (Phase 3 credentials), `live_stream_stats` viewer samples + `live_stream_events` append-only audit (Phases 10/11/15), `donations.live_stream_id` (Phase 7), a `homepage_widgets` link or synthesised card (Phase 2), an `admin_users` role/capability change (Phase 14).
- `database/schema.sql` stays as it is (install = schema + all migrations).

---

## 5. Proposed Live Streaming Architecture

### 5.1 Shape
```
Admin (PHP page + JSON admin API)          Public site (React)
   │ create / edit / schedule / delete          │ /live-darshan, /live-darshan/:slug
   ▼                                            ▼
backend/includes/live/*  ──────────────►  GET /api/live-streams/{live,upcoming,:id,:slug}
   │  store.php (CRUD, soft delete, status transitions, public shaping)
   │  validate.php, time.php, media.php
   │  providers/ StreamingProvider ── YouTubeProvider (Phase 1)
   │                                  VimeoProvider / IvsProvider (placeholders)
   ▼
MySQL: temples, deities, live_streams          Phase 3: bin/live_cron.php polls the provider and moves status
```
The frontend never sees provider specifics: the API returns a normalised **playback descriptor** and the React `LivePlayer` only knows `kind: "iframe" | "hls" | "link" | "none"`.

### 5.2 Provider abstraction (built in Phase 1, minimal; the requirement lists it under Phase 2 but wants Phase 1 "abstracted")
```php
interface StreamingProvider {
    public function name(): string;                       // 'youtube'
    public function parseReference(string $input): ?string;   // pasted URL or id → provider id
    public function playback(array $stream): array;       // ['kind'=>'iframe','embedUrl'=>…,'watchUrl'=>…] (no network)
    public function thumbnailUrl(array $stream): ?string; // no network
    public function fetchStatus(array $stream): array;    // Phase 3: ['status','scheduledStart','actualStart','actualEnd','viewerCount','embeddable','privacy','error']
    public function isConfigured(): bool;
}
```
`YouTubeProvider` (Phase 1): id/URL regex `^[A-Za-z0-9_-]{11}$` and the `watch?v=` / `youtu.be/` / `/live/` / `/embed/` / `/shorts/` forms; embed `https://www.youtube-nocookie.com/embed/<id>?rel=0&playsinline=1&hl=<ta|en>` (+ `autoplay=1&mute=1` only after the visitor presses Watch, per YouTube's minimum-functionality rules and mobile autoplay policy); watch URL `https://www.youtube.com/watch?v=<id>`; thumbnail `https://i.ytimg.com/vi/<id>/hqdefault.jpg` unless the admin set one. `fetchStatus()` returns `not configured` until Phase 3. Registry `liveProviderFor($name)` never throws (unknown → an "unavailable" provider, as the notification service does).

### 5.3 Status model
`DRAFT → SCHEDULED → STARTING → LIVE → COMPLETED`, with `CANCELLED` from DRAFT/SCHEDULED/STARTING, `OFFLINE`/`ERROR` from STARTING/LIVE (Phase 9), and back to LIVE from OFFLINE. One transition function (`liveSetStatus`) stamps `actual_start_at` on first LIVE and `actual_end_at` on COMPLETED and audits every change. Phase 1: the admin sets status by hand (Publish, Go live, End, Cancel buttons); Phase 3 automates the same function from the poller. Public visibility: `deleted_at IS NULL AND status <> 'DRAFT'`.

### 5.4 Public API (Phase 1)
Routing block in `api/index.php` before the route table: `#^/live-streams(?:/(live|upcoming|[0-9]{1,10}|[a-z0-9][a-z0-9-]{1,118}))?$#` → `api/live_streams.php` (GET/HEAD only; self-guarding when hit directly).
- `GET /api/live-streams/live` → `{ streams: [...] }` with status LIVE or STARTING, `Cache-Control: no-store`.
- `GET /api/live-streams/upcoming?limit=` → SCHEDULED with `scheduled_start_at >= now`, ascending, `max-age=60`.
- `GET /api/live-streams/:id` and `/:slug` → one stream (digits = id, else slug), 404 `{error}` otherwise.
- Every item: `id, slug, title_ta, title_en, description_ta, description_en, event_type, provider, status, temple {slug, name_ta, name_en}, deity {…} | null, scheduled_start_at, scheduled_end_at, actual_start_at, actual_end_at (ISO-8601 UTC), timezone, thumbnail_url, banner_url, playback: { kind, embedUrl, watchUrl }, flags {featured, showOnHomepage, donations, notifications, sharing, archive}` plus a top-level `server_time` (ISO UTC) so countdowns use server time (Phase 2). Never `provider_stream_id`, `created_by/updated_by`, `deleted_at`.
- Missing migration → `[]`/404, never 500 (`liveTablesExist()` probe).

### 5.5 Admin module (Phase 1)
- **Page** `backend/admin/live_streams.php` on the `events.php`/`sevas.php` skeleton: tabs/chips All · Draft · Scheduled · Live · Completed · Cancelled (+ Deleted), search, sortable table (title, temple/deity, type, schedule in the stream's zone, status badge with live dot, provider), row menu (Edit · View public page · Go live / End / Cancel · Delete) with `data-confirm`, form drawer with every requirement field: Title EN/TA, Description EN/TA, Temple (select), Deity (select filtered by temple), Event Type, Thumbnail and Banner (**file upload** through a shared helper copied from gallery.php **or** a URL field — both offered), Streaming Provider, Provider Video ID (URL or id accepted; parsed and validated), Playback URL (auto-filled, editable), Scheduled Date, Start Time, End Time, Timezone (IANA select, Asia/Kolkata first), and the option switches (Show on Homepage, Enable Donations, Enable Notifications, Enable Sharing, Enable Archive) plus Featured. Slug auto-generated from the English title (editable on create). Validation server-side with re-rendered errors; PRG + flash; `adminAudit('live_stream_*', 'Stream #id', …)`.
- **Admin JSON API** exactly as requested — `GET /api/admin/live-streams`, `POST /api/admin/live-streams`, `PUT /api/admin/live-streams/:id`, `DELETE /api/admin/live-streams/:id` — implemented as a session-protected JSON handler (`api/admin_live_streams.php`) that requires `includes/auth.php` (same session cookie as the admin), answers **401 JSON** when not signed in (never a redirect), **403 JSON** for insufficient capability or a missing/invalid `X-CSRF-Token`, and re-installs the JSON error handler after loading `auth.php`. It calls the same `includes/live/store.php` functions as the page, so there is one write path. CORS is not widened for admin routes (same origin only).
- **Capabilities** added to `ADMIN_CAPABILITIES`: `live.view` → viewer, `live.manage` (create/edit/schedule/delete) → editor, `live.publish` (status transitions) → editor, `live.provider` (credentials, Phase 3) → owner, `live.analytics` → viewer. Page read `live.view`, write `live.manage`; per-action `requireAdminCan('live.publish')`. This maps cleanly onto the requirement's permission names now; the Phase 14 roles (SUPER_ADMIN / TEMPLE_ADMIN / CONTENT_ADMIN / STREAM_MANAGER) need a schema + auth change because today's roles are a linear `viewer < editor < owner` list — flagged, not done in Phase 1.
- **Navigation:** "Live Streaming" under the Content group in `admin_layout.php`; quick action "New live stream".

### 5.6 Public page `/live-darshan` (Phase 1)
`pages/LiveDarshan.jsx` + `LiveDarshan.css`, route `live-darshan` and `live-darshan/:slug`:
- Temple header (`PageHero` variant `live`: temple name, address line, crumbs, share action, status badge aside).
- The list route shows the live stream if one exists, else the next scheduled one, else the "no stream" state (with the YouTube-channel fallback link, preserving today's NRI tile behaviour). The slug route shows that stream in any public status.
- Body: `.split` — left `LivePlayer` (16:9 card; SCHEDULED/OFFLINE/ERROR/COMPLETED-without-recording show a poster and the state message instead of an iframe; LIVE/STARTING show the poster with a **Watch** button that mounts the iframe with autoplay muted, or mount immediately — decision for the builder to verify against axe/console rules), right `StreamMeta` (`dl`: temple, deity, event type, date and time in the stream's zone with "IST", status badge, share). Below: "Upcoming live darshans" cards when any exist.
- `lib/live.js`: `STREAM_STATUS` meta (bilingual labels + tones), `useLiveStreams()` / `useStream(slug)` (fetch-based, module-level cache, poll every 30 s while LIVE/STARTING and 60 s otherwise, visibility-aware, cleared on unmount), `formatStreamTime(iso, lang, tz)`.
- No login (the public site has none). Bilingual; one `h1`; iframe `title`, `allow="autoplay; encrypted-media; picture-in-picture; web-share"`, `allowfullscreen`, `referrerpolicy="strict-origin-when-cross-origin"`, `loading="lazy"`.
- Entry points in Phase 1: NRI tile button → `/live-darshan`; Footer quick link; site search; chatbot fact; `NAV_LINKS` entry "Live Darshan" (must pass the existing 30-width header-fit test — if the 1024–1280 band overflows, fall back to drawer + footer only). Homepage "LIVE NOW / Next Live Darshan" block and bottom-nav changes are Phase 2.

### 5.7 Time handling
All instants stored in UTC; the admin enters wall-clock time in the stream's timezone; conversion with `notifyToUtc`/`notifyFromUtc`; the API returns ISO-8601 UTC + `timezone` + `server_time`; the browser formats with `Intl` in that zone and computes countdowns (Phase 2) from a server-time offset, never the device clock alone.

### 5.8 Security (Phase 1 scope of Phase 14)
Admin session + CSRF + capabilities on every write; 401/403 JSON on the admin API; URL fields validated (site path or https only, no `javascript:`); provider ids validated by regex; every output escaped (`h()` in PHP, React by default); the iframe `src` is built server-side from a validated id, never from free text; public GETs are read-only and cookie-less; no credentials in Phase 1; service-worker NetworkOnly rule for `/api/live-streams`.

### 5.9 Phase map (what lands when)
| Phase | Delivered by this architecture |
|---|---|
| 1 | Migration 011, provider interface + YouTube, public API, admin page + admin JSON API, `/live-darshan` page, entry points, tests |
| 2 | `/live-darshan/schedule` with filters, `StreamCountdown` (server-time offset), "Next Live Darshan" empty state, homepage LIVE NOW / next block (hero panel row or a home section), Vimeo/IVS placeholder classes |
| 3 | YouTube Data API v3 client over `notifyHttp` (API key for public data; OAuth refresh-token flow for owner data), `bin/live_cron.php` + `/api/live-cron`, automatic SCHEDULED→STARTING→LIVE→COMPLETED, encrypted credential store (`live_settings`) — **note:** since 2026-06-01 `search.list` is limited to 100 calls/day, so discovery of "what is live" must use a known video id (`videos.list`, 1 unit) or OAuth `liveBroadcasts.list`, never `search.list` polling |
| 4 | Premium player page: live header with viewer count (`liveStreamingDetails.concurrentViewers`, shown as returned), player states, Donate / Notify Me / Share row, "About this pooja", upcoming programs |
| 5 | Per-stream OG/SEO via an `og.php` branch (`/live-darshan/:slug`), share metadata |
| 6 | `live_stream_subscriptions`, public subscribe endpoint (honeypot + flood buckets), reminder scheduling through the notification service (email; the "website bell" as a cookie-less page-level subscription since the in-app bell was removed), unsubscribe tokens, duplicate prevention |
| 7 | Donation CTA on the stream page → the CCAvenue payable with `live_stream_id`; per-stream donation totals |
| 8 | `/live-darshan/archive` with filters; auto-archive on COMPLETED + `recording_url` |
| 9 | Health columns, error-state UX for the ten listed scenarios, provider error mapping (private / deleted / embed-restricted / quota) |
| 10 | Admin live-monitoring card (status, provider, started, viewers, last check, issues) |
| 11 | `live_stream_stats` samples + `live_stream_events`, analytics dashboard (omit metrics the provider does not supply) |
| 12 | Bilingual completion pass (already inline from Phase 1) |
| 13 | A11y/SEO/performance pass (lazy iframe, code-split page, API caching headers) |
| 14 | RBAC: per-role capability sets and the four requested roles (auth schema change), rate limits, CSP with `frame-src` for the providers |
| 15 | `live_stream_events` audit with previous/new values (Phase 1 already writes `admin_activity` rows) |
| 16 | Vimeo and AWS IVS providers (IVS needs an HLS player loaded only when `kind === "hls"`) |
| 17 | Full E2E regression |

---

## 6. Files / Modules Expected to Be Modified (Phase 1)

Shared files are also being edited by the payments build right now; live-streaming edits are small appended blocks and start only after that build lands.

| File | Change |
|---|---|
| `backend/api/index.php` | `/live-streams…` routing block and `/admin/live-streams…` block before the route table |
| `backend/includes/auth.php` | `live.*` capabilities; `live_streams.php` in the page read/write maps |
| `backend/admin/includes/admin_layout.php` | nav entry + quick action |
| `backend/admin/includes/admin_ui.php` | only if a new icon name is added |
| `backend/includes/site_pages.php`, `backend/api/search.php`, `backend/api/chat.php` | `/live-darshan` SEO entry, search entry, chatbot fact + rule |
| `backend/.env.example` | a "Live darshan" block (Phase 1 needs no secret; documents `LIVE_*`/`YOUTUBE_*` for later) |
| `frontend/src/App.jsx` | two lazy routes |
| `frontend/src/components/Layout/Layout.jsx`, `Footer.jsx` | nav / quick link entries |
| `frontend/src/pages/Home.jsx` | NRI tile button → `/live-darshan` (keep a secondary YouTube-channel link) |
| `frontend/src/styles/layout.css` | `.page-hero--live` |
| `frontend/vite.config.js` | NetworkOnly rule for `/api/live-streams` |
| `tests/admin-smoke.mjs`, `admin-roles.mjs`, `admin-hostile-input.mjs`, `og.mjs`, `public-e2e.mjs`, `search-api.mjs` | list/case additions only |
| `README.md`, `tests/README.md` | migration table, live section, new suites |

Not modified in Phase 1: `database/schema.sql`, `BottomNav.jsx`, `gallery.php`, `events.php`, notification templates, payments files, `deploy/*`, `index.html`, `package.json` (no new dependency).

## 7. Files / Modules Expected to Be Created (Phase 1)

| File | Purpose |
|---|---|
| `database/migrations/011_live_streams.sql` | `temples`, `deities`, `live_streams` + seeds |
| `backend/includes/live.php` | loader (db, helpers, notify/contracts + time, live/*) |
| `backend/includes/live/config.php` | constants (statuses, event types, providers, transitions), `liveTablesExist()` |
| `backend/includes/live/time.php` | UTC ↔ zone helpers, ISO output |
| `backend/includes/live/validate.php` | `liveValidate()`, `liveSlugify()` |
| `backend/includes/live/media.php` | `liveStoreImage($file)` (gallery.php pattern), `liveSafeUrl()` |
| `backend/includes/live/providers.php` | `StreamingProvider` interface, `YouTubeProvider`, unavailable provider, registry |
| `backend/includes/live/store.php` | load/list/insert/update/soft-delete/set-status, public shaping, transaction helper |
| `backend/includes/live/admin.php` | filters, status tones/labels, select options |
| `backend/api/live_streams.php` | public GET routes |
| `backend/api/admin_live_streams.php` | session-protected admin JSON API |
| `backend/admin/live_streams.php` | admin page |
| `frontend/src/lib/live.js` | status meta, hooks, formatting (the only frontend file that knows YouTube's URL shape, via the API's descriptor) |
| `frontend/src/components/Live/LivePlayer.jsx`, `LiveStatusBadge.jsx`, `StreamMeta.jsx`, `StreamCard.jsx`, `Live.css` | player, badge, meta list, upcoming card |
| `frontend/src/pages/LiveDarshan.jsx`, `LiveDarshan.css` | the public page |
| `tests/support/live_fixtures.php` | CLI fixtures (create-stream, set-status, unlink, sql, cleanup) |
| `tests/support/youtube_mock.mjs` | Node mock of oEmbed / Data API (used from Phase 3; smoke-started in Phase 1) |
| `tests/live-unit.php`, `tests/live-api.mjs`, `tests/admin-live.mjs`, `tests/live-ui.mjs` | the Phase 1 suites |
| `docs/live/SPEC-PHASE1.md` | the Phase 1 build contract (written next, after this analysis is accepted) |

---

## 8. Facts to confirm and decisions to make before Phase 1

1. **YouTube channel:** `https://youtube.com/@TempleMahendra` (linked from the homepage) answered **HTTP 404** today. The real handle / channel id is needed; the tile will be corrected as part of Phase 1.
2. **Embedding must be allowed:** the channel needs YouTube's *Advanced features* ("Embed live streams") and each broadcast must have "Allow embedding" on and be public or unlisted, not "made for kids". Otherwise the player shows "Video unavailable".
3. **Persistent vs scheduled broadcasts:** whether the temple streams through one permanent "Stream now" video id or creates a new scheduled event each time decides how much of Phase 3's discovery logic is needed.
4. **Admin API form:** the analysis recommends real `/api/admin/live-streams` JSON routes (session + CSRF header, 401/403 JSON) sharing one write path with the PHP page. The alternative — in-page JSON actions only — would not match the requirement's paths.
5. **Temples/deities as tables** (recommended) versus a code list — see §4.
6. **Main navigation:** add "Live Darshan" to the header links (8 links; verified by the header-fit test) or keep it to drawer + footer + homepage tile in Phase 1.
7. **Player behaviour:** poster + "Watch" button (mounts the iframe on click, autoplay muted) versus mounting the iframe immediately. Recommended: poster + Watch on the list page, immediate mount on the direct `/live-darshan/:slug` link.
8. **Credentials for Phase 3:** an API key (IP-restricted, server-side) covers public status and viewer counts; OAuth (`youtube.readonly`, consent screen **In production**, refresh token minted once by the channel-owning account) is needed for stream health and private/unlisted discovery. Both stay server-side.

---

## 9. Phase 1 testing plan (summary; the contract will spell out each check)

- **Unit** `tests/live-unit.php` (PHP CLI): id/URL parser, embed builder, slug generation and uniqueness, status transitions, UTC/zone conversion and validation, public serialiser omits private fields, length clamps, migration probe.
- **Integration** `tests/live-api.mjs` (PHP 8081, XFF 10.84.0.1-99): the four public routes (shapes, ordering, exclusions of DRAFT/CANCELLED/deleted/past, 404/405, JSON content type, no cookies, XSS-escaped, limit cap); admin JSON API (401 without session, 403 viewer / bad CSRF, 200 editor, one write path); existing `/api/events`, `/api/homepage_widgets`, `/api/search` unchanged.
- **Admin** `tests/admin-live.mjs` (PHP 8082, XFF 10.84.0.100-159): create/edit/delete/schedule through the page; Tamil round-trip; thumbnail/banner upload (valid PNG, non-image, oversize, `.php`); filters/search; roles (owner/editor/viewer), CSRF, hostile input; `admin_activity` rows; overflow + axe at 390/1440.
- **UI** `tests/live-ui.mjs` (Vite 5195 → PHP 8083, YouTube hosts stubbed with `ctx.route`): `/live-darshan` at 390/768/1024/1440 (one h1, no overflow, no console errors, axe with `iframes:false`), header/status/title/player/description/temple/deity/time present, iframe `src` asserted (nocookie host, `/embed/<id>`, expected params, `title`/`allow`/`allowfullscreen`), scheduled/offline states without iframe, YouTube fallback link, Tamil default and English toggle, 16:9 player box, no login needed.
- **Regression** (existing functionality unaffected): `registration-api`, `public-hardening`, `admin-smoke`, `admin-roles`, `admin-hostile-input`, `search-api`, `notify-unit`, `og` (minus the two known `/register` checks), `public-e2e` (minus the five known-stale sign-up checks), the payments suites once they are green, `npm run audit` = 0, `php -l` on every changed PHP file.
- Ports/addresses reserved for live streaming: PHP 8080-8089, Node mocks 8090-8099 (8099 closed for the network-failure case), Vite 5195, `X-Forwarded-For` 10.84.0.x, fixtures prefixed `E2E-LIVE-<run>`.

Supporting research and raw maps are in the session scratchpad (`live/map-backend.md`, `map-frontend.md`, `map-tests.md`, `research-youtube.md`).
