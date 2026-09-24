# Gap analysis against the full project brief

Audit of `master` (after #42) against the 45-section TempleMahendra brief.
Each gap has a backlog ID (G-nn); defects found while closing them go in
`docs/DEFECTS.md`. Status is updated as PRs merge.

## Already satisfied (verified in code and by the recorded MySQL 8 browser runs)

| Brief section | Where it lives |
| --- | --- |
| React + Vite + Router, PHP 8 PDO REST APIs, MySQL utf8mb4, custom PHP CMS, Apache `.htaccess` | `frontend/`, `backend/api`, `backend/admin`, `deploy/` |
| Dynamic homepage engine — every §8 content type (pooja, Pournami, sponsor, upcoming event, live stream, custom), priority, pin, dates, image, linked entity, display order, manual / calendar / system sources; every §9 pooja field (start / end time, recurrence through *Generate from Panchangam*, sponsorship amount and availability, banner, featured, live-stream flag, status = `is_active`); the §10 rules fixed in D-027 (migration 024) | `homepage_widgets`, `poojas`, `backend/api/homepage_widgets.php`, `backend/api/poojas.php` |
| Pooja / seva management, Pournami auto-selection, panchang calendar (Pournami, Pradosham, Sankatahara Chaturthi since D-029, Nalla Neram — editable since migration 025) | `poojas`, `sevas`, `backend/api/pournamis.php`, `backend/api/calendar.php`, `backend/admin/nalla_neram.php` |
| Bilingual events (type, span, times, venue, picture, `/events/<id>`), announcements with a publish window, sevas with timing and `is_bookable` (migration 020); gallery albums, alt text and GD thumbnails with validated uploads (migration 021); contact form (rate limit, honeypot, DB, notification) | corresponding `backend/api` + `backend/admin` pages |
| Family registration, notification service (email/SMS/WhatsApp drivers, templates, campaigns, analytics, unsubscribe) | `docs/notifications/SPEC.md`, `backend/includes/notify` |
| CCAvenue: server-side order creation, encrypted request, response decryption + verification, idempotent callbacks, audit log, receipts (web, email, printable, verify page), refunds, simulator | `docs/payments/SPEC.md`, `backend/includes/payments` |
| YouTube Live: streams CMS, statuses, poller, admin settings, public page, schedule, archive, SEO, reminders, stream-linked donations | `docs/live/*`, `backend/includes/live` |
| Admin auth: `password_hash`/`verify`, session regeneration, CSRF, login rate limiting, server-side capability checks, session revocation on disable | `backend/includes/auth.php` |
| Tamil/English everywhere (`*_ta`/`*_en`, `t(ta,en)`), share previews for crawlers | `backend/api/og.php`, `Seo.jsx` |
| Security headers, SPA fallback that excludes `/api`, `/admin`, `/uploads`, upload directory protection | `deploy/htaccess_*` |
| Automated suites: 47 Node/PHP suites (~27k lines) covering API, admin, payments, live, notifications, hostile input, bilingual content, gallery, stream links and the CMS settings | `tests/` |

## Gaps (backlog)

| ID | Brief | Gap | Priority | Status |
| --- | --- | --- | --- | --- |
| G-01 | §18 | No idle-session expiry; no account lockout after repeated failures (only per-minute rate limit) | P1 | done — `ADMIN_IDLE_MINUTES` (30 default), lock after 10 failures for 15 min, secure/httponly/SameSite cookies, `tests/admin-auth.mjs`. The "per-IP throttle" the first pass credited did not exist (D-022): now 30 failures from one address in 15 min refuse the address, and the recovery account's lock is per address |
| G-02 | §17, §30 E2E-013/046 | Three roles (viewer/editor/owner); brief needs Super Admin, Temple Admin, Content Editor, Finance Admin with server-side checks | P1 | done — `backend/includes/roles.php` capability matrix; stored roles `owner/admin/editor/finance/viewer` = Super Admin/Temple Admin/Content Editor/Finance Admin/Viewer; migration 015 |
| G-03 | §22 | No `sitemap.xml`, no `robots.txt`; 404 route exists but crawler status for unknown URLs is 200 (SPA) | P1 | done — `api/robots.php`, `api/sitemap.php` (pages + public broadcasts), `api/spa.php` SPA fallback returns 404 + `X-Robots-Tag` for unknown routes; `tests/seo-crawl.mjs` |
| G-04 | §41, §40 | Missing `TESTING.md`, `DEPLOYMENT.md`, `DATABASE.md`, `CCAvenue-INTEGRATION.md`, `LIVE-STREAMING.md`, backup/restore procedure | P1 | done — all five documents exist under `docs/`; `deploy/backup.sh` / `restore.sh` and the rehearsal are in `DEPLOYMENT.md` → *Backups and restore* |
| G-05 | §30 | No traceability from E2E-001…050 to the existing suites; some cases (SQLi/XSS/CSRF/404/tablet) need explicit checks | P1 | done — `docs/TESTING.md` matrix (48 covered, 1 partial, 1 gap); `tests/brief-e2e.mjs` adds E2E-006…023, 045, 047…049 in their own words |
| G-06 | §6 Deities | `deities` table exists (live phase 1) but no CMS page and no public page; About page deity content is static | P2 | done — `admin/deities.php` (Worship → Deities: Tamil/English name and description, image upload, order, shown/hidden, unique slug, live-stream delete guard, audit, `content.edit`), `GET /api/deities`, About page renders the CMS list with the built-in three as fallback; `tests/deities.mjs` (67 checks) |
| G-07 | §6 Videos | No videos module (YouTube videos, categories) beyond the live archive | P2 | done — migration 017 (`video_categories`, `videos`), Media → Videos CMS (`/admin/videos.php`: paste a YouTube URL or id, bilingual titles/descriptions, category, optional link to a completed broadcast whose recording is inherited when the link is blank, date, order, featured, shown/hidden; inline category editor), `GET /api/videos` (shown videos of shown categories, featured, category filter, pagination), `/videos` React page, Videos search group, sitemap entry; `tests/videos.mjs` (118 checks) |
| G-08 | §11 | `sponsors` lacks family name, email, amount, payment status, publish consent; nothing enforces consent before publication | P2 | done — migration 016 (`family_name`, `email`, `event_id`, `amount`, `payment_ref`, `payment_status`, `publish_consent` default 0, `updated_at`); `sponsorPublicSql()` gates `/api/donors` and every homepage sponsor path on `is_active AND publish_consent`, family name preferred; Finance → Sponsors CRUD/consent/filters, bulk import columns; `tests/sponsors.mjs` (105) |
| G-09 | §6 Calendar | Calendar is computed (astronomical); admins cannot add custom festival entries or disable computed ones | P2 | done — migration 018 (`calendar_entries`: `mode` add/hide, `entry_type`, date span, bilingual title/description, optional pooja/event FKs `ON DELETE SET NULL`, order, `is_active`); Worship → Temple Calendar CMS (`/admin/calendar_entries.php`: add a festival / pooja / holiday / special day on a date or span, or suppress a computed observance — one type or all — on a day; hide/show, edit, delete, audit, `content.edit`); `calendarApplyEntries()` merges rows into `GET /api/calendar` `special[]` (custom items carry `id`, `custom: true`, descriptions, links) so the Panchangam page, `upcoming[]` and the homepage next-Pournami lookup all follow; computed tithi/timings untouched; `tests/calendar-entries.mjs` (90 checks) |
| G-10 | §28, §15 | `admin_activity` records many actions but there is no Audit Logs admin page; some actions (settings, sponsors, streams) need coverage checks | P2 | done — People → Audit Logs (`/admin/audit_log.php`, `audit.view` = admin + owner, read-only: no write path at all); filters for search (record/detail/IP, wildcards literal), who, module (20 groups incl. Sign-in & sessions), one action, date range (swapped when reversed), sort; 50/page; CSV export honours the filters, is capped at 10,000 rows and is itself audited (`audit_exported`); dashboard shortcut; KPIs (entries, today, failed sign-ins 7d). Coverage added where it was missing: announcements, events, poojas (incl. toggle), sevas, homepage widgets, gallery, settings (lists only the changed keys), seva booking status (single + bulk), contact message deletes (single + bulk); deletes record the title/name of what was removed. `adminAudit()` now clamps every column to its width and stores the proxy-resolved client IP (`clientIp()`), not `REMOTE_ADDR` (D-020). Sponsors, deities, videos, calendar, payments, users and live streams already audited (`liveAudit()`). `tests/audit-log.mjs` (72 checks) |
| G-11 | §12, §32 | Live phase 9/10 not built: health columns, provider error mapping (private/deleted/embed-restricted/quota), error-state UX, admin monitoring card | P2 | done — `includes/live/health.php`, the dashboard Live Darshan card, `?include=health` on the admin API, `tests/live-health.mjs` (56 checks) |
| G-12 | §26 | APIs are `/api/*`, not `/api/v1/*`; response envelope differs per endpoint | P3 | in progress (next phase) |
| G-13 | §34 | No Lighthouse / performance run recorded | P3 | open (scheduled in the next phase) |
| G-14 | §38, §39 | Staging deployment and production smoke test require Hostinger credentials (external) | P3 | blocked on user |
| G-15 | §2 Tailwind | Frontend uses its own CSS design system (tokens synced to the admin). Switching to Tailwind would be a rewrite with no functional gain | — | deviation, documented |
| G-16 | §2 PHPMailer | `includes/mailer.php` is a dependency-free SMTP client with `mail_log`; behaviour matches the PHPMailer requirement (authenticated SMTP via env vars) without Composer, which Hostinger shared hosting does not need | — | deviation, documented |
| G-18 | §29 | `tests/admin-notifications.mjs` still exercises the retired `inapp`/`push` channels (`NOTIFY_CHANNELS` is email/whatsapp/sms) and crashes mid-run on master; 39/47 pass | P3 | in progress (next phase) — D-015 |
| G-19 | §20, §30 E2E-040 | Contact form stores the message but raises no admin notification (no `contact.*` event in `includes/notify/events.php`) | P2 | done — migration 019 (`contact_messages.email`, `subject`, `updated_at`; transactional `office` category), `includes/contact_notify.php` raises `contact.received` (template `contact_received`, email) to `CONTACT_NOTIFY_EMAIL`; the form and inbox carry email and subject; `tests/brief-e2e.mjs` E2E-038/039/040 |
| G-17 | §12 statuses | Live statuses are `DRAFT/SCHEDULED/STARTING/LIVE/COMPLETED/CANCELLED/OFFLINE/ERROR`; the brief's `UPCOMING/LIVE/ENDED/CANCELLED` map to `SCHEDULED/LIVE/COMPLETED/CANCELLED` | — | deviation, documented |
| G-20 | §15, §16 | Admin CMS structure: sidebar groups (Content / Temple / Media / Finance / Communication / Devotees / System), Pages CMS, Nalla Neram editor, Roles matrix, Languages, SEO overrides, temple-details Settings; dashboard cards for next poojas, online payments (7 days), latest donations, recent CMS activity | P1 | done — migration 025 (`site_settings`, `pages`, `seo_settings`); `backend/admin/{pages,nalla_neram,roles,languages,seo,settings}.php`; `GET /api/pages[/{slug}]`, `GET /api/settings` (`site`, `seo`, `languages`); `og.php` / sitemap honour SEO overrides; panchangam / pulse / contact alerts read the settings; frontend reads them through `lib/siteSettings.js` (Home, Footer, Contact, About, Seo, LangContext); `tests/cms-settings.mjs` 124 |
| G-21 | §6 Home, §7 | Homepage sections manageable from the CMS: hero title/lead, introduction, hours, daily schedule, today's special, Nalla Neram, social links, phone/e-mail, temple name | P1 | done — part of G-20 (`site_settings`); bilingual announcement ticker, event cards link to `/events/<id>` |
| G-22 | §6 Sponsorship, §6 Deities | Public Sponsorship page (open sponsorships, amount, related pooja, consented sponsors) and a public Deities page | P2 | in progress (next phase) |
| G-23 | §20 | Sponsor confirmation notification and live-stream announcement | P2 | in progress (next phase) |
| G-24 | §14, §15 | Finance → Receipts admin page (issued receipts, search, resend) | P2 | in progress (next phase) |
| G-25 | §22 | Structured data (JSON-LD) and album-aware share previews | P3 | in progress (next phase) |
| G-26 | §24, §34 | Responsive matrix 360/390/768/1024/1366/1920, Firefox/WebKit/Edge and mobile emulation runs, Lighthouse | P3 | in progress (next phase) |

## Execution order

1. G-01 auth hardening → 2. G-02 roles → 3. G-03 SEO files → 4. G-05 E2E matrix
→ 5. G-06 deities → 6. G-08 sponsors → 7. G-07 videos → 8. G-09 calendar entries
→ 9. G-10 audit page → 10. G-11 live health → 11. G-12 `/api/v1` alias
→ 12. G-04 docs (kept current throughout, finalised last) → 13. G-13 Lighthouse
→ 14. G-14 staging (when credentials are provided) → final regression + report.

Done since: G-19 contact alerts, migrations 020–025 (bilingual content,
gallery albums, stream links, pooja sponsorships, the homepage engine, the
CMS settings — G-20, G-21). Next phase: G-22 … G-26, G-12, G-18 / D-015,
G-13, then G-14 when the credentials arrive.

Every item: inspect → implement → migration if needed → tests → run app →
exercise the workflow in a browser → record defects in `docs/DEFECTS.md` →
fix → rerun affected suites → PR.
