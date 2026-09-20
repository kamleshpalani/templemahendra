# Gap analysis against the full project brief

Audit of `master` (after #42) against the 45-section TempleMahendra brief.
Each gap has a backlog ID (G-nn); defects found while closing them go in
`docs/DEFECTS.md`. Status is updated as PRs merge.

## Already satisfied (verified in code and by the recorded MySQL 8 browser runs)

| Brief section | Where it lives |
| --- | --- |
| React + Vite + Router, PHP 8 PDO REST APIs, MySQL utf8mb4, custom PHP CMS, Apache `.htaccess` | `frontend/`, `backend/api`, `backend/admin`, `deploy/` |
| Dynamic homepage engine (widget types, priority, pin, dates, manual/calendar/system sources) | `homepage_widgets`, `backend/api/homepage_widgets.php` |
| Pooja / seva management, Pournami auto-selection, panchang calendar (Pournami, Pradosham, Chaturthi, Nalla Neram) | `poojas`, `sevas`, `backend/api/pournamis.php`, `backend/api/calendar.php` |
| Events, announcements, gallery albums with validated uploads, contact form (rate limit, honeypot, DB, notification) | corresponding `backend/api` + `backend/admin` pages |
| Family registration, notification service (email/SMS/WhatsApp drivers, templates, campaigns, analytics, unsubscribe) | `docs/notifications/SPEC.md`, `backend/includes/notify` |
| CCAvenue: server-side order creation, encrypted request, response decryption + verification, idempotent callbacks, audit log, receipts (web, email, printable, verify page), refunds, simulator | `docs/payments/SPEC.md`, `backend/includes/payments` |
| YouTube Live: streams CMS, statuses, poller, admin settings, public page, schedule, archive, SEO, reminders, stream-linked donations | `docs/live/*`, `backend/includes/live` |
| Admin auth: `password_hash`/`verify`, session regeneration, CSRF, login rate limiting, server-side capability checks, session revocation on disable | `backend/includes/auth.php` |
| Tamil/English everywhere (`*_ta`/`*_en`, `t(ta,en)`), share previews for crawlers | `backend/api/og.php`, `Seo.jsx` |
| Security headers, SPA fallback that excludes `/api`, `/admin`, `/uploads`, upload directory protection | `deploy/htaccess_*` |
| Automated suites: 37 Node/PHP suites (~22k lines) covering API, admin, payments, live, notifications, hostile input | `tests/` |

## Gaps (backlog)

| ID | Brief | Gap | Priority | Status |
| --- | --- | --- | --- | --- |
| G-01 | §18 | No idle-session expiry; no account lockout after repeated failures (only per-minute rate limit) | P1 | done — `ADMIN_IDLE_MINUTES` (30 default), lock after 10 failures for 15 min, secure/httponly/SameSite cookies, `tests/admin-auth.mjs` |
| G-02 | §17, §30 E2E-013/046 | Three roles (viewer/editor/owner); brief needs Super Admin, Temple Admin, Content Editor, Finance Admin with server-side checks | P1 | done — `backend/includes/roles.php` capability matrix; stored roles `owner/admin/editor/finance/viewer` = Super Admin/Temple Admin/Content Editor/Finance Admin/Viewer; migration 015 |
| G-03 | §22 | No `sitemap.xml`, no `robots.txt`; 404 route exists but crawler status for unknown URLs is 200 (SPA) | P1 | done — `api/robots.php`, `api/sitemap.php` (pages + public broadcasts), `api/spa.php` SPA fallback returns 404 + `X-Robots-Tag` for unknown routes; `tests/seo-crawl.mjs` |
| G-04 | §41, §40 | Missing `TESTING.md`, `DEPLOYMENT.md`, `DATABASE.md`, `CCAvenue-INTEGRATION.md`, `LIVE-STREAMING.md`, backup/restore procedure | P1 | open |
| G-05 | §30 | No traceability from E2E-001…050 to the existing suites; some cases (SQLi/XSS/CSRF/404/tablet) need explicit checks | P1 | done — `docs/TESTING.md` matrix (48 covered, 1 partial, 1 gap); `tests/brief-e2e.mjs` adds E2E-006…023, 045, 047…049 in their own words |
| G-06 | §6 Deities | `deities` table exists (live phase 1) but no CMS page and no public page; About page deity content is static | P2 | done — `admin/deities.php` (Worship → Deities: Tamil/English name and description, image upload, order, shown/hidden, unique slug, live-stream delete guard, audit, `content.edit`), `GET /api/deities`, About page renders the CMS list with the built-in three as fallback; `tests/deities.mjs` (67 checks) |
| G-07 | §6 Videos | No videos module (YouTube videos, categories) beyond the live archive | P2 | done — migration 017 (`video_categories`, `videos`), Media → Videos CMS (`/admin/videos.php`: paste a YouTube URL or id, bilingual titles/descriptions, category, optional link to a completed broadcast whose recording is inherited when the link is blank, date, order, featured, shown/hidden; inline category editor), `GET /api/videos` (shown videos of shown categories, featured, category filter, pagination), `/videos` React page, Videos search group, sitemap entry; `tests/videos.mjs` (118 checks) |
| G-08 | §11 | `sponsors` lacks family name, email, amount, payment status, publish consent; nothing enforces consent before publication | P2 | done — migration 016 (`family_name`, `email`, `event_id`, `amount`, `payment_ref`, `payment_status`, `publish_consent` default 0, `updated_at`); `sponsorPublicSql()` gates `/api/donors` and every homepage sponsor path on `is_active AND publish_consent`, family name preferred; Finance → Sponsors CRUD/consent/filters, bulk import columns; `tests/sponsors.mjs` (105) |
| G-09 | §6 Calendar | Calendar is computed (astronomical); admins cannot add custom festival entries or disable computed ones | P2 | done — migration 018 (`calendar_entries`: `mode` add/hide, `entry_type`, date span, bilingual title/description, optional pooja/event FKs `ON DELETE SET NULL`, order, `is_active`); Worship → Temple Calendar CMS (`/admin/calendar_entries.php`: add a festival / pooja / holiday / special day on a date or span, or suppress a computed observance — one type or all — on a day; hide/show, edit, delete, audit, `content.edit`); `calendarApplyEntries()` merges rows into `GET /api/calendar` `special[]` (custom items carry `id`, `custom: true`, descriptions, links) so the Panchangam page, `upcoming[]` and the homepage next-Pournami lookup all follow; computed tithi/timings untouched; `tests/calendar-entries.mjs` (90 checks) |
| G-10 | §28, §15 | `admin_activity` records many actions but there is no Audit Logs admin page; some actions (settings, sponsors, streams) need coverage checks | P2 | done — People → Audit Logs (`/admin/audit_log.php`, `audit.view` = admin + owner, read-only: no write path at all); filters for search (record/detail/IP, wildcards literal), who, module (20 groups incl. Sign-in & sessions), one action, date range (swapped when reversed), sort; 50/page; CSV export honours the filters, is capped at 10,000 rows and is itself audited (`audit_exported`); dashboard shortcut; KPIs (entries, today, failed sign-ins 7d). Coverage added where it was missing: announcements, events, poojas (incl. toggle), sevas, homepage widgets, gallery, settings (lists only the changed keys), seva booking status (single + bulk), contact message deletes (single + bulk); deletes record the title/name of what was removed. `adminAudit()` now clamps every column to its width and stores the proxy-resolved client IP (`clientIp()`), not `REMOTE_ADDR` (D-020). Sponsors, deities, videos, calendar, payments, users and live streams already audited (`liveAudit()`). `tests/audit-log.mjs` (72 checks) |
| G-11 | §12, §32 | Live phase 9/10 not built: health columns, provider error mapping (private/deleted/embed-restricted/quota), error-state UX, admin monitoring card | P2 | open |
| G-12 | §26 | APIs are `/api/*`, not `/api/v1/*`; response envelope differs per endpoint | P3 | open |
| G-13 | §34 | No Lighthouse / performance run recorded | P3 | open |
| G-14 | §38, §39 | Staging deployment and production smoke test require Hostinger credentials (external) | P3 | blocked on user |
| G-15 | §2 Tailwind | Frontend uses its own CSS design system (tokens synced to the admin). Switching to Tailwind would be a rewrite with no functional gain | — | deviation, documented |
| G-16 | §2 PHPMailer | `includes/mailer.php` is a dependency-free SMTP client with `mail_log`; behaviour matches the PHPMailer requirement (authenticated SMTP via env vars) without Composer, which Hostinger shared hosting does not need | — | deviation, documented |
| G-18 | §29 | `tests/admin-notifications.mjs` still exercises the retired `inapp`/`push` channels (`NOTIFY_CHANNELS` is email/whatsapp/sms) and crashes mid-run on master; 39/47 pass | P3 | open |
| G-19 | §20, §30 E2E-040 | Contact form stores the message but raises no admin notification (no `contact.*` event in `includes/notify/events.php`) | P2 | open |
| G-17 | §12 statuses | Live statuses are `DRAFT/SCHEDULED/STARTING/LIVE/COMPLETED/CANCELLED/OFFLINE/ERROR`; the brief's `UPCOMING/LIVE/ENDED/CANCELLED` map to `SCHEDULED/LIVE/COMPLETED/CANCELLED` | — | deviation, documented |

## Execution order

1. G-01 auth hardening → 2. G-02 roles → 3. G-03 SEO files → 4. G-05 E2E matrix
→ 5. G-06 deities → 6. G-08 sponsors → 7. G-07 videos → 8. G-09 calendar entries
→ 9. G-10 audit page → 10. G-11 live health → 11. G-12 `/api/v1` alias
→ 12. G-04 docs (kept current throughout, finalised last) → 13. G-13 Lighthouse
→ 14. G-14 staging (when credentials are provided) → final regression + report.

Every item: inspect → implement → migration if needed → tests → run app →
exercise the workflow in a browser → record defects in `docs/DEFECTS.md` →
fix → rerun affected suites → PR.
