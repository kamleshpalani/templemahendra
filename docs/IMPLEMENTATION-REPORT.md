# TempleMahendra — implementation report (brief §45)

Branch `claude/dod-completion`, built on `master` between 20 and 27 September
2026. This report covers what the branch delivers against the 45-section
brief, how it was tested, what was found and fixed, and what still stands
between it and production.

Everything below was run on the local environment: Windows 11, PHP 8.3,
Node 24, MySQL 8.4 in Docker, and Playwright's Chromium, Firefox, WebKit plus
the installed Microsoft Edge. Staging and production (brief §38, §39) need the
Hostinger account and CCAvenue sandbox credentials, which the repository
deliberately does not hold. They are the one open item (G-14).

## 1. Release readiness

**Verdict: ready for staging.** All nine backlog packages are merged and
tested. Every brief section from §6 to §35 has a working, tested
implementation or a documented deviation (§2 Tailwind and PHPMailer, §12 status
names). No S1 or S2 defect is open. What must happen next, in order:

1. Create the Hostinger staging site and give it its own database,
   `APP_ENV=staging`, SMTP settings and the CCAvenue **test** keys.
2. Follow `docs/DEPLOYMENT.md` → *Release procedure*: migrations 001–025 with
   a utf8mb4 client, upload, the three `deploy/htaccess_*` files, cron jobs.
3. Run the staging checklist in `docs/CCAvenue-INTEGRATION.md` (a real test
   transaction, a replayed response, a refund) and the smoke list in
   `DEPLOYMENT.md`. Run `node tests/backup-restore.mjs` against staging.
4. Production: the same steps with `APP_ENV=production`, `CORS_ORIGIN` set to
   the site's origin, Hostinger *Force HTTPS*, and only CCAvenue *Test
   connection* until the committee approves live payments.

## 2. Features delivered (brief §6–§28)

| § | Requirement | Delivered |
| --- | --- | --- |
| 6 Home | Every section dynamic and managed from the CMS | Hero title and lead, introduction, hours, daily schedule, today's special, Nalla Neram, phones, e-mail, social links from Admin → System → Settings; homepage cards (upcoming / Pournami / coming-soon pooja, event, live stream, sponsor, custom) with expiry and fallback rules; bilingual announcement ticker; live indicator and next darshan; consented sponsors; donation call to action; gallery preview strip; map; footer |
| 6 About | History, mission, deities, management, photos | Mission and history from Content → Pages, deities from the CMS, committee and trust from the booklet data |
| 6 Deities | Bilingual deity records with image, order, status | Temple → Deities; public `/deities` page |
| 6 Pooja / Seva | Regular, special and recurring poojas; sponsorship; timing; availability | Pooja model with start/end time, types incl. Pradosham and Sankatahara Chaturthi, "Generate from Panchangam", sponsorship amount and availability, banner, featured and live flags; sevas with bilingual description and timing and `is_bookable`; upcoming special poojas on /sevas |
| 6 Events | Upcoming, festival, historical, featured, details | Type, featured, date span, times, venue, image, bilingual description; `/events` (IST day, featured first) and `/events/<id>` |
| 6 Calendar | Pournami, Pradosham, Sankatahara Chaturthi, festivals, custom entries, disable | Computed observances plus Temple → Temple Calendar (add / hide) and Temple → Nalla Neram |
| 6 Gallery | Albums, grid, event albums, lightbox, responsive | Seeded albums, bilingual alt text, 480/1280 px GD copies, `/gallery?album=` and `?photo=` deep links |
| 6 Videos | YouTube videos, recordings, categories | Media → Videos, `/videos` |
| 6 Live Temple | Live page with indicator, titles, pooja/event, schedule, sponsor, donation, sharing | Live Darshan page, schedule, archive, pooja/event links, consented sponsor credit, stream-linked donations, unavailable-video poster |
| 6 Donations | Eight categories | Editable donation categories including Pournami Pooja |
| 6 Sponsorship | Available sponsorships, pooja, amount, status, consented sponsor | `/sponsorship`; `/donate?pooja=<id>`; one sponsor row per paid pooja donation |
| 6 Contact | Address, phone, e-mail, map, form, social links | From the site settings; form with e-mail and subject; the office is alerted |
| 7 | Tamil and English everywhere | `*_ta` / `*_en` on every content table; `t(ta, en)` in the React app; default and offered languages in Admin → System → Languages |
| 8–10 | Homepage engine and next-pooja selection | Every card type, priority, pin, dates, display order, manual / calendar / system sources, expired poojas never shown, re-pointing and fallbacks |
| 11 | Sponsor management and consent | Family name, e-mail, linked pooja/event, amount, transaction, payment status, consent, notes; consent gates every public output; the payment module's bookkeeping note is never published |
| 12 | YouTube Live | Streams CMS (paste a URL or id), statuses, automatic polling, health, archive with the recording, subscriber reminders |
| 13 | CCAvenue | Server-side order, encrypted request, decrypted and verified response, idempotent callbacks, audit, refunds, timeout and stale-link handling, simulator for development |
| 14 | Receipts | Unique numbers; web, e-mail and printable receipts; verify page; Finance → Receipts admin page with search, filters, totals, CSV and resend |
| 15 | Admin navigation | Content · Temple · Media · Finance · Communication · Devotees · System, with Pages, Nalla Neram, Roles, Settings, Languages, SEO, Receipts, Audit Logs |
| 16 | Dashboard | Next poojas, events, current livestream, latest donations, totals, messages, gallery counts, pending/failed payments, recent CMS activity |
| 17 | Roles | Super Admin, Temple Admin, Content Editor, Finance Admin and Viewer, checked on the server for reading and for changing every page |
| 18 | Authentication | bcrypt, secure sessions, idle expiry, CSRF, per-account lockout and per-address throttle, logout |
| 19 | Gallery uploads | Decoded-image validation, random names, GD thumbnails, only metadata in MySQL |
| 20 | Notifications | Donation success, failed payment, contact alert, **sponsor confirmation**, **live-stream announcement** and **upcoming-event notification** (the last two through the campaign composer, so consent and approval apply) |
| 21 | Contact form | Name, e-mail, phone, subject, message; validation, honeypot, flood limits, storage, e-mail alert |
| 22 | SEO | Titles, descriptions, canonical URLs, Open Graph previews, sitemap, robots, clean URLs, **JSON-LD** (HinduTemple, Event, BroadcastEvent), alt text, per-page overrides |
| 23 | Accessibility | axe (WCAG 2 A/AA) in every browser suite; Lighthouse Accessibility 98–100 |
| 24 | Responsive and browsers | 360 / 390 / 768 / 1024 / 1366 / 1920 px in Chromium, Edge, Firefox and WebKit, plus Pixel 5 and iPhone 13 emulation |
| 25 | Database | 51 tables, foreign keys, indexes, `created_at` / `updated_at`, 25 idempotent migrations |
| 26 | Versioned API | `/api/v1/*` with the brief's envelope; `/api/*` unchanged for the site |
| 27 | Security | HTTPS, HSTS, CSP and the other headers, private paths denied, `APP_ENV`, OWASP review (`docs/SECURITY-REVIEW.md`) |
| 28 | Audit log | Sign-in/out, content, payments, sponsors, users and roles, streams, settings, bulk imports, notification campaigns |
| 40 | Backups | `deploy/backup.sh` / `restore.sh`; the rehearsal is an automated suite |
| 41 | Documentation | README, TESTING, DEPLOYMENT, DATABASE, CCAvenue-INTEGRATION, LIVE-STREAMING, SECURITY-REVIEW, DEFECTS, GAP-ANALYSIS, this report |

## 3. Architecture

A React 18 + Vite single-page site is served from `public_html` and calls
same-origin PHP 8 REST endpoints in `backend/api`. Those use PDO prepared
statements against MySQL 8 in utf8mb4. A custom PHP admin in `backend/admin`
uses server-side sessions, CSRF tokens and capability checks. Apache
`.htaccess` files provide clean URLs, the SPA fallback (which never swallows
`/api`, `/admin` or `/uploads`), HTTPS and security headers. Link unfurlers
and crawlers are answered by `backend/api/og.php`. Three cron scripts in
`backend/bin` send notifications, reconcile payments and poll YouTube. There
is no framework and no runtime Composer or npm dependency on the server.

## 4. Database changes

Twenty-five idempotent migrations (`docs/DATABASE.md` has the full index).
This branch added 019–025: contact e-mail and subject (019), bilingual
announcements, events and sevas (020), gallery albums and image variants
(021), live-stream links (022), pooja sponsorship through payments (023), the
homepage engine and pooja model (024), and site settings, CMS pages and SEO
overrides (025). The schema now holds 51 tables and 41 foreign keys. Every
migration is guarded by `information_schema` checks and must be applied with
a utf8mb4 client.

## 5. APIs

The README's *API Endpoints* section lists every route. This branch added or
changed these: `GET /api/poojas` (with `?sponsorship=1`),
`/api/events/{id}`, `/api/gallery/albums`, `/api/pages` and
`/api/pages/{slug}`, `/api/settings` (site, SEO and languages), the bilingual
`/api/search`, and the `/api/v1/*` alias with its envelope.

## 6. CMS modules

- **Overview**: Dashboard.
- **Content**: Homepage, Pages, Announcements.
- **Temple**: Deities, Poojas, Sevas, Events, Temple Calendar, Nalla Neram.
- **Media**: Gallery, Videos, Live Streaming, YouTube Automation.
- **Finance**: Donations, Online Payments, Receipts, Sponsors, Donation Categories, Payment Gateway.
- **Communication**: Notifications, Message Templates, Audiences, Delivery Analytics, Messages.
- **Devotees**: Family Registrations, Seva Bookings, Bulk Upload.
- **System**: Users, Roles, Settings, Languages, SEO, Audit Logs, My Profile.

## 7. CCAvenue status

Complete against the local simulator, with every §31 scenario automated. The
covered paths are success, failure, cancellation, invalid and tampered
responses, a duplicate callback, a refresh or back after paying, an expired
session, a wrong amount, a record mismatch, receipts, gateway timeout, a
stale link, pooja sponsorship and refunds. The real CCAvenue round trip is
the first staging task and is not yet exercised, because no sandbox
credentials exist in this environment.

## 8. Live streaming status

Complete against the YouTube Data API simulator, with every §32 case
automated: none, upcoming, live, ended, cancelled, invalid URL, deleted or
private video, the mobile and desktop player, the homepage LIVE indicator, and
streams linked to a pooja or an event. A real channel's credentials are needed
on staging.

## 9. Tamil and English status

Every content table is bilingual, and every UI string goes through
`t(ta, en)`. Tamil round-trips through admin → MySQL → API → page in the
suites, including backup and restore byte for byte. The default language and
the offered languages are set by the committee.

## 10. Tests

**Created in this branch (13):** `cms-settings`, `content-bilingual`,
`gallery`, `live-links`, `public-content-ui`, `public-pages`,
`admin-receipts`, `api-v1`, `structured-data`, `deploy-config`,
`backup-restore`, `lighthouse`, plus the rewritten `admin-bulk-import`.
**Brought up to date:** `public-e2e` (six widths, four browsers, device
emulation; D-017), `admin-notifications` (D-015), `brief-e2e`,
`payments-api`, `sponsors`, `admin-hostile-input`, `admin-auth`,
`admin-smoke`, `admin-roles`. **Final regression:** see §10.1, run after the
last code change.

### 10.1 Final regression

(See the table appended at the end of this report — one row per suite, with
the number of checks passed and failed in the final run.)

### 10.2 Cross-browser, responsive and performance

See `docs/TESTING.md` → *Cross-browser, responsive and performance* and
`tests/reports/lighthouse/summary.md`.

## 11. Defects

`docs/DEFECTS.md` holds D-001…D-048 in the brief's §35 format. This branch
found and fixed D-022…D-048. The most significant were:

- **D-037 (S2, privacy):** an online sponsor's bookkeeping note was
  published.
- **D-035 (S2):** a seva marked not bookable still took bookings.
- **D-047 (S2, security):** two high-severity dependency advisories.
- **D-038 (S3, security):** `.env.local` overrode the real environment for
  admin pages.
- **D-027 (S2):** stale homepage pooja cards.

**Open:** none at S1 or S2. D-046 (the WebKit share-sheet focus) is fixed and
awaiting its WebKit retest in the final matrix run.

## 12. Security review

`docs/SECURITY-REVIEW.md` walks the OWASP Top 10 (2021) with file:line
evidence and the suite that proves each point. It finds no S1 or S2 open.
One risk is accepted: react-router 6's open-redirect advisory, which needs the
v7 major upgrade, while no user-supplied URL reaches a router link. Three
production settings remain: `CORS_ORIGIN`, `APP_ENV`, and *Force HTTPS*.

## 13. Performance review

Lighthouse runs on six routes, mobile and desktop. Accessibility scored
98–100, Best Practices 100 and SEO 92–100. Performance was 69–89 on mobile
(simulated slow 4G) and 82–97 on desktop in the first run. The biggest
remaining opportunities are unused JavaScript and CSS in the main bundle and
render-blocking Google Fonts. The fixes already made are the footer layout
shift, the heading order, and routing robots/sitemap through PHP in preview.
Images are lazy-loaded with explicit sizes, route code is split per page, and
API responses are small and cached for 60 seconds where public.

## 14. Staging result

Not run. It needs the Hostinger account and the CCAvenue sandbox
credentials (G-14).

## 15. Smoke result

This is local only: a production build served by `vite preview` with PHP and
MySQL. Every public route opens in four browsers and two emulated phones. The
admin signs in, and every admin page renders (`admin-smoke`). Payments
complete against the simulator, and the backup restores.

## 16. Remaining issues

- G-14: staging and production validation (credentials).
- react-router v7 upgrade (A06, accepted for now).
- Performance: split the main bundle further and self-host the fonts to lift
  mobile Performance above 90.
