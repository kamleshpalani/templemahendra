# Security review (OWASP Top 10, 2021)

Scope: the PHP API and admin (`backend/`), the React site (`frontend/`), the
Apache configuration shipped in `deploy/`, and the CCAvenue and YouTube
integrations, on branch `claude/dod-completion` (September 2026). Brief §27
asks for this review. Every claim below points at the code that carries it
and, where one exists, the suite that proves it.

Severity: S1 critical · S2 high · S3 medium · S4 low. Status: **fixed** (in
this branch), **holds** (reviewed, no change needed), **accepted** (a known
residual risk with its reason), **open** (needs action before production).

## Summary

| Category | Verdict | Open items |
| --- | --- | --- |
| A01 Broken access control | holds | — |
| A02 Cryptographic failures | holds | Production must run behind TLS (see A05) |
| A03 Injection | holds (one S2 data leak fixed) | — |
| A04 Insecure design | holds | — |
| A05 Security misconfiguration | fixed | Set `CORS_ORIGIN`, `APP_ENV=production`, Hostinger "Force HTTPS" |
| A06 Vulnerable and outdated components | fixed / accepted | react-router 6 open-redirect advisory (needs v7) |
| A07 Identification and authentication failures | holds | — |
| A08 Software and data integrity failures | holds | — |
| A09 Security logging and monitoring failures | fixed | — |
| A10 Server-side request forgery | holds | — |

No S1 or S2 finding is open.

## A01 — Broken access control

- **Holds.** Every admin page starts with `requireAdminAuth()`
  (`backend/includes/auth.php:460`), which checks the session, the idle
  timeout, whether the account is still active, and the capability the page
  needs to be read (`adminPageCapability()`) and, for a POST, to be changed
  (`adminPageWriteCapability()`). The capabilities of each role are code, not
  data (`backend/includes/roles.php`), so a database edit cannot widen access.
  Proof: `tests/admin-auth.mjs` (role × page matrix, a forbidden POST refused
  server-side), `tests/admin-roles.mjs`, `tests/cms-settings.mjs`,
  `tests/admin-receipts.mjs` (editor and viewer get 403 on GET and POST).
- Public endpoints never return private data: sponsors pass through
  `sponsorPublicSql()` (`backend/includes/public_guard.php`), which requires
  publish consent, drops refunded sponsorships and — **fixed in this branch
  (S2, D-037)** — never publishes the bookkeeping note the payment module
  writes on an online sponsorship (it held the donation number and, for a
  foreign currency, the amount). `/api/poojas`, `/api/homepage_widgets`,
  `/api/donors` and the live-stream feed all use it. Proof: `tests/payments-api.mjs`
  ("/api/poojas never publishes an online sponsor's note"), `tests/sponsors.mjs`.
- A donor's payment and receipt pages need an HMAC access token compared with
  `hash_equals()` (`backend/includes/payments/numbers.php:239,252`); a guessed
  number without its token answers 404. Proof: `tests/payments-api.mjs`.

## A02 — Cryptographic failures

- **Holds.** Admin passwords use `password_hash(PASSWORD_BCRYPT)` and
  `password_verify()` (`backend/includes/auth.php:349,378`,
  `backend/admin/users.php:115`); the environment account's hash is compared
  with `hash_equals()`.
- CCAvenue payloads are AES-128-CBC with the merchant working key as the
  gateway requires (`backend/includes/payments/ccavenue.php:31,48`). Gateway
  credentials stored in the database are sealed with libsodium
  `crypto_secretbox` under `PAYMENTS_SETTINGS_KEY`
  (`backend/includes/payments/config.php:10`); the key lives only in the
  environment.
- No card data is ever received or stored: the donor pays on CCAvenue's own
  page and only the tracking id, bank reference and payment mode come back.
- Transport: production must be HTTPS. `deploy/htaccess_*` redirect to HTTPS
  and send HSTS over TLS (A05); session cookies are `Secure` when the request
  is HTTPS (`auth.php:28–35`).

## A03 — Injection

- **SQL: holds.** Every query that carries request data uses PDO prepared
  statements (525 `prepare()` calls under `backend/`); no query concatenates
  `$_GET`/`$_POST`. Column and table names that vary come from fixed
  allow-lists (for example the sort keys of the admin lists). Proof:
  `tests/brief-e2e.mjs` E2E-047, `tests/search-api.mjs`
  ("an injection attempt is just a search term"), `tests/admin-hostile-input.mjs`.
- **XSS: holds.** Admin output goes through `h()`
  (`backend/admin/includes/admin_ui.php:24`, `htmlspecialchars` with
  `ENT_QUOTES`); React escapes by default and the code has no
  `dangerouslySetInnerHTML` on user content; og.php escapes every value and
  JSON-LD is serialised so a hostile title cannot close its `<script>` tag.
  Proof: `tests/brief-e2e.mjs` E2E-048, `tests/admin-hostile-input.mjs`,
  `tests/structured-data.mjs` (a `</script>` title stays inert),
  `tests/og.mjs`.
- **CSV formula injection: holds.** Payment and receipt exports prefix a cell
  that starts with `= + - @`, a tab or a carriage return with `'`
  (`backend/includes/payments/admin.php:51`); `tests/admin-receipts.mjs`
  checks a stored `=HYPERLINK(…)` comes out inert.
- **Header/mail injection: holds.** The mailer builds headers from validated
  addresses only (`backend/includes/mailer.php`); the contact form validates
  e-mail with `FILTER_VALIDATE_EMAIL`.

## A04 — Insecure design

- **Holds.** Payments follow the brief's lifecycle: an internal transaction
  is created before the redirect; the response is decrypted and checked
  against the stored order (order id, amount, currency, merchant parameter —
  `backend/includes/payments/response.php:210–276`); a mismatch is audited
  and never marked paid; the browser's return is never trusted on its own;
  callbacks are idempotent (a replayed response, a duplicate server
  notification or a re-run sweep never creates a second donation, receipt or
  sponsorship; `sponsors.donation_id` is UNIQUE). Proof:
  `tests/payments-unit.php`, `tests/payments-api.mjs` (tampered, replayed,
  wrong amount, timeout, stale link), `tests/payments-ui.mjs`.
- Public forms carry honeypots and per-address flood limits
  (`publicGuardLimit()`, `backend/includes/public_guard.php:60`). Proof:
  `tests/public-hardening.mjs`.
- A seva marked not bookable is refused by both booking paths (D-035).

## A05 — Security misconfiguration

- **Fixed in this branch** (`deploy/htaccess_public_html`, `htaccess_api`,
  `htaccess_uploads`): HTTPS redirect (308 for the API so a POST stays a
  POST), HSTS for a year over TLS only, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, a strict
  Content-Security-Policy for the React site (no inline script — the Vite
  build has none) and a relaxed one only for `/admin` and `api/og.php`,
  `X-Powered-By` removed; `includes/ config/ bin/ logs/ database/ tests/
  vendor/` and dotfiles, dumps, logs, shell scripts and `.env` files are never
  served; uploads cannot execute PHP and are sandboxed. Proof:
  `tests/deploy-config.mjs` (45 checks).
- **Fixed:** `APP_ENV` (`backend/config/config.php`) — production by default;
  outside development no error detail is shown and `APP_DEBUG` is ignored.
  Proof: `tests/deploy-config.mjs`.
- **Fixed (D-038):** admin pages loaded `.env.local` with `putenv()` for
  every line, overriding variables the server was started with; admin pages
  and the API could read different databases. `.env.local` now only fills
  gaps (`backend/includes/auth.php`).
- **Open (configuration, S4):** `CORS_ORIGIN` defaults to `*` when unset
  (`config.php`). The API sends no credentials, so a wildcard cannot leak a
  session, but production should set it to the site's own origin (the
  `.env.example` already shows it). Also switch on Hostinger's "Force HTTPS"
  and set `APP_ENV=production` in the hosting panel.

## A06 — Vulnerable and outdated components

- **Fixed:** `npm audit fix` within semver ranges removed two high
  (axios prototype-pollution gadget, form-data CRLF injection) and two
  moderate (follow-redirects header leak) advisories from the production
  dependencies.
- **Accepted (S3):** react-router-dom 6.30 carries open-redirect advisories
  for backslash paths passed to `<Link>` / `useNavigate`. The fix is the v7
  major (a routing rewrite). Every `to=` in the site is a literal or built
  from numeric ids and fixed slugs; no user-supplied URL reaches `<Link>` or
  `navigate()`. Upgrade to v7 in a separate change.
- PHP has no Composer dependencies; the SMTP client, CCAvenue crypto and
  YouTube client are in-repo and reviewed with the modules.

## A07 — Identification and authentication failures

- **Holds.** Sessions are `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS,
  strict mode on, regenerated on sign-in (`auth.php:28–35,396`); idle expiry
  (`ADMIN_IDLE_MINUTES`, default 30); an account locks after 10 failures for
  15 minutes (`ADMIN_LOCKOUT_ATTEMPTS`), a per-address throttle stops password
  spraying across names, and the environment recovery account cannot be locked
  from outside; a disabled account's live sessions end at once; CSRF tokens on
  every admin POST (`adminCsrfGuard()`, `admin_ui.php:313`, `hash_equals`).
  Proof: `tests/admin-auth.mjs` (64 checks: E2E-011/012/050, lockout,
  throttle), `tests/brief-e2e.mjs` E2E-049.

## A08 — Software and data integrity failures

- **Holds.** CCAvenue responses are accepted only after decryption and the
  order/amount/currency match (A04); the local payment simulator refuses
  requests without its access code and HMAC signature
  (`backend/includes/payments/simulator.php:111,145`) and only runs with
  `PAYMENTS_ALLOW_SIMULATOR`. Backups carry a SHA-256 manifest and
  `deploy/restore.sh` refuses a damaged one (`tests/backup-restore.mjs`).
  Uploads are decoded as images before they are kept and stored under random
  names (`backend/includes/gallery_images.php:67`,
  `backend/admin/gallery.php:140`).

## A09 — Security logging and monitoring failures

- **Fixed/holds.** `admin_activity` records sign-in, sign-out, failures,
  lockouts and every create/update/delete across the CMS, payments status
  changes, sponsors, users and roles, live streams and settings; this branch
  added bulk imports and notification campaign actions. The Audit Logs page
  filters and exports it (`tests/audit-log.mjs`). Payments keep their own
  append-only `payment_audit_log`. Errors are logged, never shown
  (`APP_ENV`), with secrets redacted from live-sync errors (`liveRedact()`).

## A10 — Server-side request forgery

- **Holds.** The server makes outbound requests only to fixed hosts: the
  CCAvenue status API, the YouTube Data API, Google Gemini
  (`backend/api/chat.php:101`, a constant URL) and the configured mail /
  WhatsApp / SMS providers (`notifyHttp()`, `backend/includes/notify/contracts.php:235`,
  base URLs from configuration). No endpoint fetches a URL a visitor or
  committee member supplies; picture addresses typed into the CMS are only
  written into pages for the browser to load.

## Before production

1. Hosting panel: `APP_ENV=production`, `CORS_ORIGIN=https://<the site>`,
   `SITE_URL`, database, SMTP, `PAYMENTS_SETTINGS_KEY`, CCAvenue keys (test
   first), never in Git.
2. Hostinger → SSL → install the certificate and switch on "Force HTTPS";
   upload `deploy/htaccess_*` to their folders (DEPLOYMENT.md).
3. Run `node tests/deploy-config.mjs` against the release and the staging
   checklist in `docs/CCAvenue-INTEGRATION.md`.
4. Plan the react-router v7 upgrade (A06).
