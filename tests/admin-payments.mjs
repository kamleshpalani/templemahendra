#!/usr/bin/env node
/**
 * tests/admin-payments.mjs — Admin → Online Payments, Payment Gateway and
 * Donation Categories (docs/payments/SPEC.md §8, §9.2, §10, §12 item 3), end to
 * end against the real PHP + MySQL stack, a stand-in CCAvenue and a real browser.
 *
 *   PHP_BIN=/path/to/php.sh node tests/admin-payments.mjs
 *
 * Starts its own PHP server on 8062 in TEST mode, pointed at the CCAvenue mock
 * it starts on 8072, with credentials invented for this run (nothing here is a
 * real secret). Exits 2 when either port is taken. Signs in as the environment
 * admin (admin / Admin@Test123) and as an editor and a viewer it creates through
 * admin/users.php and deletes at the end. Requests carry X-Forwarded-For
 * 10.83.0.20–29.
 *
 * What it proves:
 *   1. roles: a viewer reads and exports but every POST is refused and changes
 *      nothing; an editor manages (resend, check, mark reviewed, reconcile) but
 *      is refused refunds and the gateway settings; an owner does everything;
 *      a missing or forged CSRF token changes nothing on any of the three pages;
 *   2. the Transactions tab: filters, search, sort, pagination and the CSV export
 *      (with a formula cell neutralised);
 *   3. the Overview KPIs against figures computed independently in SQL over a
 *      backdated fixture set, including the IST month boundary;
 *   4. the detail view: attempts, refunds and audit trail; Check with CCAvenue
 *      now; Mark reviewed; the masked PAN and its logged reveal;
 *   5. refunds: two partials, an over-refund refused, one refused by the
 *      gateway, one the gateway did not answer then Check again, one marked as
 *      failed, a full refund, and the manual method — the payment's own rows
 *      untouched before and after;
 *   6. the Payment Gateway page: masked credentials, blank keeps, Remove clears,
 *      env-provided fields read-only, the stored value is ciphertext, PRODUCTION
 *      refused without credentials and without the tick, Test connection
 *      wording per mock scenario, the audit holding key names only — with the
 *      payment_settings rows snapshotted and restored;
 *   7. donation categories: create, duplicate key refused, edit with the key
 *      immutable, hide, delete unused, delete refused when used;
 *   8. donations.php and seva_bookings.php additions and their unchanged
 *      existing behaviour; the dashboard KPI;
 *   9. reconciliation: every section, Run checks now, and the CSV upload with
 *      alias headers, a missing-column error and mismatches;
 *  10. at 390 and 1440 px the three new pages have no horizontal overflow and no
 *      serious or critical axe violations.
 *
 * Creates payables named "E2E-PAY-ADM-<run> …" and removes them, their attempts,
 * refunds, audit rows, notifications, activity entries, its accounts, its
 * category, its rate_limits buckets and the receipt counter it advanced.
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { startCcavenueMock, portInUse } from "./support/ccavenue_mock.mjs";

const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const PHP_PORT = 8062;
const MOCK_PORT = 8072;
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PHP_BIN = process.env.PHP_BIN || "php";
const viaBash = PHP_BIN.endsWith(".sh");
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = Date.now().toString(36);
const PREFIX = `E2E-PAY-ADM-${RUN}`;
const EDITOR = "e2e_pay_editor";
const VIEWER = "e2e_pay_viewer";
const EDITOR_PW = "PayEdit99Tk";
const VIEWER_PW = "PayView42Qm";
const SLUG = `e2epay_${RUN}`;
const IP = { owner: "10.83.0.20", editor: "10.83.0.21", viewer: "10.83.0.22", gateway: "10.83.0.23", browser: "10.83.0.24", fixture: "10.83.0.25" };
const ALL_IPS = Object.values(IP);
const BUCKETS_REGEXP = ":10[.]83[.]0[.]2[0-9]$";
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace|SQLSTATE)/;
const PAGE = "/admin/payments.php";
const SETTINGS = "/admin/payment_settings.php";
const CATEGORIES = "/admin/donation_categories.php";

// Invented for this run; the mock and the server share them through the environment.
const WORKING_KEY = `e2e-working-key-${RUN}-not-a-secret`;
const ACCESS_CODE = `E2EACCESS${RUN.toUpperCase()}`;
const MERCHANT_ID = "123456";
const PAYMENTS_SECRET = crypto.randomBytes(24).toString("hex"); // 48 chars
const SETTINGS_KEY = crypto.randomBytes(32).toString("base64");
const PROD_KEY = `e2e-prod-working-key-${RUN}-fake`;
const PROD_ACCESS = `E2EPRODACCESS${RUN.toUpperCase()}`;

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 700)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── PHP, fixtures and SQL ─────────────────────────────────────────────── */
const PHP_ENV = {
  ...process.env,
  TRUSTED_PROXIES: "127.0.0.1,::1",
  SITE_URL: BASE,
  ADMIN_USERNAME: "admin",
  CCAVENUE_TEST_MERCHANT_ID: MERCHANT_ID,
  CCAVENUE_TEST_ACCESS_CODE: ACCESS_CODE,
  CCAVENUE_TEST_WORKING_KEY: WORKING_KEY,
  CCAVENUE_TRANSACTION_URL: `http://127.0.0.1:${MOCK_PORT}/transaction/transaction.do?command=initiateTransaction`,
  CCAVENUE_API_URL: `http://127.0.0.1:${MOCK_PORT}/apis/servlet/DoWebTrans`,
  // https return URLs, so the only thing standing between TEST and PRODUCTION is the
  // committee's tick (§10.4). The suite posts gateway responses straight to the
  // server, so these addresses are never actually fetched.
  CCAVENUE_REDIRECT_URL: `https://127.0.0.1:${PHP_PORT}/api/payments/ccavenue/response`,
  CCAVENUE_CANCEL_URL: `https://127.0.0.1:${PHP_PORT}/api/payments/ccavenue/cancel`,
  CCAVENUE_NOTIFY_URL: `https://127.0.0.1:${PHP_PORT}/api/payments/ccavenue/notify`,
  PAYMENTS_SECRET,
  PAYMENTS_SETTINGS_KEY: SETTINGS_KEY,
  PAYMENTS_ALLOW_SIMULATOR: "",
  PAYMENTS_SETTINGS_OVERLAY: "",
};
function php(args, env = PHP_ENV) {
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: REPO, encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
function fixtures(cmd, obj) {
  const data = JSON.parse(php(["tests/support/payments_fixtures.php", cmd, JSON.stringify(obj)]).trim().split("\n").pop());
  if (data.error) throw new Error(`fixtures ${cmd}: ${data.error}${data.fields ? " " + JSON.stringify(data.fields) : ""}`);
  return data;
}
// No backslashes in statements: Git Bash strips them on the way to php.sh.
const sql = (query, params = []) => fixtures("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;
const donation = (number) => one("SELECT * FROM donations WHERE donation_number = ?", [number]);
const booking = (number) => one("SELECT * FROM seva_bookings WHERE order_number = ?", [number]);
const attempt = (orderId) => one("SELECT * FROM payment_transactions WHERE order_id = ?", [orderId]);
const refundsOf = (orderId) => rows("SELECT r.* FROM payment_refunds r JOIN payment_transactions t ON t.id = r.transaction_id WHERE t.order_id = ? ORDER BY r.id", [orderId]);
const auditEvents = (orderId) => rows("SELECT a.event FROM payment_audit_log a JOIN payment_transactions t ON t.id = a.transaction_id WHERE t.order_id = ? ORDER BY a.id", [orderId]).map((r) => r.event);
const activity = (subject) => rows("SELECT actor, action, subject, detail FROM admin_activity WHERE subject = ? ORDER BY id", [subject]);
const setting = (k) => one("SELECT k, v, is_secret FROM payment_settings WHERE k = ?", [k]);

/* ── Money and IST helpers (independent of the PHP implementation) ─────── */
const money = (n) => "₹" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** KPI cards show whole rupees (§10.3); tables and hints keep the paise. */
const kpiMoney = (n) => "₹" + Math.round(Number(n)).toLocaleString("en-US");
const foreign = (code, n) => `${code} ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const IST_MS = 330 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const utcString = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
/** An IST wall-clock moment (y, m0, d, h, min) as a UTC "Y-m-d H:i:s" string. */
const istToUtc = (y, m0, d, h = 0, min = 0) => utcString(new Date(Date.UTC(y, m0, d, h, min) - IST_MS));
const nowIst = new Date(Date.now() + IST_MS);
const Y = nowIst.getUTCFullYear();
const M = nowIst.getUTCMonth();
const D = nowIst.getUTCDate();
const PERIOD = {
  today: [istToUtc(Y, M, D), istToUtc(Y, M, D + 1)],
  month: [istToUtc(Y, M, 1), istToUtc(Y, M + 1, 1)],
  year: [istToUtc(Y, 0, 1), istToUtc(Y + 1, 0, 1)],
  prevMonth: [istToUtc(Y, M - 1, 1), istToUtc(Y, M, 1)],
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (y, m0) => { const d = new Date(Date.UTC(y, m0, 1)); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
// 23:50 IST on the last day of last month, and 00:10 IST on the first of this month.
const LAST_MONTH_LATE = istToUtc(Y, M, 0, 23, 50);
const THIS_MONTH_EARLY = istToUtc(Y, M, 1, 0, 10);

/** Every online payable as one row: kind, id, number, amount, amount_refunded, currency, status, paid_at, country, receipt_number. */
const PAYABLES_SQL = `SELECT 'donation' AS kind, id, donation_number AS number, amount, amount_refunded, currency, status, paid_at, country, receipt_number
                        FROM donations WHERE source = 'online' AND donation_number IS NOT NULL
                      UNION ALL
                      SELECT 'seva_booking', id, order_number, amount, amount_refunded, COALESCE(currency, 'INR'), payment_status, paid_at, phone_country, receipt_number
                        FROM seva_bookings WHERE payment_mode = 'online' AND order_number IS NOT NULL`;
const RECEIVED = "x.status IN ('SUCCESS','PARTIALLY_REFUNDED')";
/** Money received = every SUCCESS attempt's amount, less every SUCCESS refund (§10.3) — from the transaction and refund tables, not the payable's own columns. */
const NET_JOINS = `JOIN (SELECT payable_type, payable_id, SUM(amount) AS gross FROM payment_transactions WHERE status = 'SUCCESS' GROUP BY payable_type, payable_id) g
                     ON g.payable_type = x.kind AND g.payable_id = x.id
                   LEFT JOIN (SELECT t.payable_type, t.payable_id, SUM(r.amount) AS refunded FROM payment_refunds r JOIN payment_transactions t ON t.id = r.transaction_id
                               WHERE r.status = 'SUCCESS' GROUP BY t.payable_type, t.payable_id) rf
                     ON rf.payable_type = x.kind AND rf.payable_id = x.id`;
function receivedSql(extraWhere = "", params = []) {
  const r = rows(`SELECT x.currency, COUNT(*) AS n, SUM(g.gross - COALESCE(rf.refunded, 0)) AS net FROM (${PAYABLES_SQL}) x ${NET_JOINS} WHERE ${RECEIVED} ${extraWhere} GROUP BY x.currency`, params);
  const out = { count: 0, inr: 0, others: {} };
  for (const row of r) {
    out.count += Number(row.n);
    if (row.currency === "INR") out.inr = Number(row.net);
    else out.others[row.currency] = Number(row.net);
  }
  return out;
}
const countSql = (where) => Number(one(`SELECT COUNT(*) AS c FROM (${PAYABLES_SQL}) x WHERE ${where}`).c);

/* ── Sessions ──────────────────────────────────────────────────────────── */
function jar(xff) {
  let cookie = "";
  const grab = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^(PHPSESSID=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
  };
  return {
    xff,
    async get(path) {
      const r = await fetch(BASE + path, { headers: { cookie, "X-Forwarded-For": xff }, redirect: "manual" });
      grab(r);
      return r;
    },
    async post(path, pairs) {
      const r = await fetch(BASE + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(pairs),
      });
      grab(r);
      return r;
    },
    async upload(path, fields, file) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      if (file) fd.append(file.field, new Blob([file.body], { type: file.type ?? "text/csv" }), file.name);
      const r = await fetch(BASE + path, { method: "POST", redirect: "manual", headers: { cookie, "X-Forwarded-For": xff }, body: fd });
      grab(r);
      return r;
    },
    async html(path) {
      const r = await this.get(path);
      return { status: r.status, html: await r.text(), headers: r.headers };
    },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
async function login(session, username, password) {
  const page = await session.get("/admin/login.php");
  return session.post("/admin/login.php", { _csrf: csrfOf(await page.text()), username, password, next: "" });
}
const decode = (s) => s.replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** The flash on the page after a redirect. */
const flashOf = (html) => decode(/<p class="alert alert--(?:success|warning|error)" role="(?:status|alert)">([^<]*)<\/p>/.exec(html)?.[1] ?? "");
/** POST, follow the 303 by hand, return {status, location, html (of the landing page), flash}. */
async function act(session, path, pairs) {
  const r = await session.post(path, pairs);
  const location = r.headers.get("location") || "";
  if (r.status !== 303 && r.status !== 302) return { status: r.status, location, html: await r.text(), flash: "" };
  const landing = await session.html(location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location);
  return { status: r.status, location, html: landing.html, flash: flashOf(landing.html) };
}
/** Payment numbers linked from a list page. */
const listed = (html) => [...new Set([...html.matchAll(/payments\.php\?number=((?:DON|SEV)-\d{8}-\d{8})/g)].map((m) => m[1]))];
const kpi = (html, label) => {
  const m = new RegExp(`<div class="stat__val">([^<]+)</div><div class="stat__label">${label.replace(/[()]/g, "\\$&")}</div>`).exec(html);
  return m ? decode(m[1]) : null;
};
const kpiSub = (html, label) => {
  const m = new RegExp(`<div class="stat__label">${label.replace(/[()]/g, "\\$&")}</div><div class="stat__sub">([^<]+)</div>`).exec(html);
  return m ? decode(m[1]) : null;
};
const chip = (html, label) => {
  const m = new RegExp(`${label}<span class="chip__count">([0-9]+)</span>`).exec(html);
  return m ? Number(m[1]) : null;
};
const mainOf = (html) => (/<main[^>]*id="admin-content"[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? html).replace(/<script[\s\S]*?<\/script>/g, "");

/* ── Accounts ──────────────────────────────────────────────────────────── */
async function deleteAccounts(owner) {
  const { html } = await owner.html("/admin/users.php");
  const ids = html.split("<tr")
    .filter((row) => new RegExp(`class="cell-sub">(${EDITOR}|${VIEWER})\\b`).test(row))
    .map((row) => /users\.php\?edit=(\d+)/.exec(row)?.[1])
    .filter(Boolean);
  for (const id of ids) await owner.post("/admin/users.php", { _csrf: csrfOf(html), action: "delete", id });
}
async function createAccount(owner, username, displayName, role, password) {
  const { html } = await owner.html("/admin/users.php");
  const r = await owner.post("/admin/users.php", { _csrf: csrfOf(html), action: "save", id: "0", username, display_name: displayName, email: `${username}-${RUN}@example.test`, phone: "", role, password, is_active: "1" });
  if (r.status !== 303) throw new Error(`could not create ${username}: status ${r.status}`);
}
async function signInFresh(session, username, issued, chosen) {
  const r = await login(session, username, issued);
  if (r.status !== 302) throw new Error(`${username} could not sign in: ${r.status}`);
  const prof = await session.html("/admin/profile.php");
  const c = await session.post("/admin/profile.php", { _csrf: csrfOf(prof.html), action: "password", current_password: issued, new_password: chosen, confirm_password: chosen });
  if (c.status !== 303) throw new Error(`${username} could not change the issued password: ${c.status}`);
}

/* ── Servers ───────────────────────────────────────────────────────────── */
function killPort(port) {
  if (process.platform !== "win32") return;
  spawnSync("powershell", ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`], { stdio: "ignore", windowsHide: true });
}
let server = null;
async function startServer() {
  // The environment admin's password hash is computed here so no hash lives in this file.
  const hash = php(["-r", "echo password_hash('Admin@Test123', PASSWORD_BCRYPT, ['cost' => 5]);"]).trim();
  const args = ["-S", `127.0.0.1:${PHP_PORT}`, "router.php"];
  server = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: resolve(REPO, "backend"), env: { ...PHP_ENV, ADMIN_PASS_HASH: hash }, stdio: "ignore", windowsHide: true,
  });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/api/pulse`);
      if (res.status === 200) return true;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  return false;
}
function stopServer() {
  if (server && server.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else server.kill("SIGTERM");
  }
  killPort(PHP_PORT);
}

/* ── Preflight ─────────────────────────────────────────────────────────── */
if (await portInUse(PHP_PORT) || await portInUse(MOCK_PORT)) {
  console.log(`✗ port ${PHP_PORT} or ${MOCK_PORT} is already in use; this suite needs both.`);
  process.exit(2);
}
const mock = await startCcavenueMock({ port: MOCK_PORT, workingKey: WORKING_KEY, accessCode: ACCESS_CODE });
if (!(await startServer())) {
  console.log(`✗ the PHP server did not start on ${BASE} (PHP_BIN=${PHP_BIN}).`);
  stopServer();
  await mock.close();
  process.exit(1);
}

/* ── Shared state, snapshotted and restored ────────────────────────────── */
const settingsSnapshot = rows("SELECT k, v, is_secret, updated_by, updated_at FROM payment_settings");
const counterSnapshot = rows("SELECT name, value, updated_at FROM payment_counters WHERE name LIKE 'receipt:%'");
const activityStart = Number(one("SELECT COALESCE(MAX(id), 0) AS m FROM admin_activity").m);
function restoreShared() {
  sql("DELETE FROM payment_settings");
  for (const r of settingsSnapshot) {
    sql("INSERT INTO payment_settings (k, v, is_secret, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)", [r.k, r.v, r.is_secret, r.updated_by, r.updated_at]);
  }
  sql("DELETE FROM payment_counters WHERE name LIKE 'receipt:%'");
  for (const r of counterSnapshot) sql("INSERT INTO payment_counters (name, value, updated_at) VALUES (?, ?, ?)", [r.name, r.value, r.updated_at]);
}
function cleanupRows() {
  fixtures("cleanup", { name_prefix: "E2E-PAY-ADM-", ips: ALL_IPS });
  sql("DELETE FROM donation_categories WHERE slug LIKE 'e2epay_%'");
  sql("DELETE FROM admin_activity WHERE id > ? AND (action LIKE 'payment_%' OR action LIKE 'donation_category_%' OR actor IN (?, ?) OR subject IN (?, ?))", [activityStart, EDITOR, VIEWER, EDITOR, VIEWER]);
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [BUCKETS_REGEXP]);
}
function applyTestSettings() {
  const wanted = {
    enabled: "1", mode: "test", currencies: "INR,USD", default_currency: "INR", international_enabled: "1",
    seva_online_enabled: "1", notify_email: "1", notify_sms: "0", notify_whatsapp: "0",
    donation_min: "1", donation_max: "500000", donation_max_foreign: "10000", preset_amounts: "500,1000,2500,5000,10000", hold_minutes: "30",
  };
  for (const [k, v] of Object.entries(wanted)) {
    sql("INSERT INTO payment_settings (k, v, is_secret, updated_by, updated_at) VALUES (?, ?, 0, 'e2e', UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE v = VALUES(v), is_secret = 0", [k, v]);
  }
  sql("DELETE FROM payment_settings WHERE is_secret = 1");
}

/* ── Driving payments through the mock ─────────────────────────────────── */
const created = []; // every fixture, for the report and the cleanup check
function mkDonation(over = {}) {
  const fx = fixtures("create-donation", {
    name: `${PREFIX} ${over.who ?? "Donor"}`, phone: "919876543210", phoneCountry: "IN", country: "IN", category: "general", amount: "1001",
    email: `e2e-pay-${RUN}-${(over.who ?? "d").toLowerCase()}@example.test`, ip: IP.fixture, acceptTerms: true, lang: "en", ...over,
  });
  created.push(fx);
  return fx;
}
function mkSeva(over = {}) {
  const fx = fixtures("create-seva-payable", { devotee_name: `${PREFIX} ${over.who ?? "Devotee"}`, phone: "919876543211", phoneCountry: "IN", seva_id: 1, ip: IP.fixture, acceptTerms: true, lang: "en", ...over });
  created.push(fx);
  return fx;
}
/** Post the checkout fields to the mock so it knows the order (amount, currency, return URLs). */
async function checkout(fx) {
  const r = await fetch(fx.checkout.url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fx.checkout.fields) });
  if (r.status !== 200) throw new Error(`mock checkout for ${fx.order_id}: ${r.status}`);
}
/** A gateway response of one kind posted to the return URL, as CCAvenue's redirect would; returns the 303 location. */
async function callback(orderId, kind = "success", overrides = {}) {
  const built = mock.response(orderId, kind, overrides);
  const route = kind === "aborted" ? "cancel" : "response";
  const r = await fetch(`${BASE}/api/payments/ccavenue/${route}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", "X-Forwarded-For": IP.gateway },
    body: new URLSearchParams({ encResp: built.encResp }),
  });
  return { status: r.status, location: r.headers.get("location") || "", encResp: built.encResp };
}
async function pay(fx, kind = "success", overrides = {}) {
  await checkout(fx);
  return callback(fx.order_id, kind, overrides);
}

/* ── Settings form (owner) ─────────────────────────────────────────────── */
function settingsPairs(csrf, over = {}, extra = []) {
  const pairs = [
    ["_csrf", csrf], ["action", "save"], ["enabled", "1"], ["mode", "test"], ["currencies[]", "USD"], ["default_currency", "INR"],
    ["international_enabled", "1"], ["donation_min", "1"], ["donation_max", "500000"], ["donation_max_foreign", "10000"],
    ["preset_amounts", "500,1000,2500,5000,10000"], ["receipt_prefix", "TMR"], ["notify_email", "1"], ["seva_online_enabled", "1"], ["hold_minutes", "30"],
  ].filter(([k]) => !(k in over) || over[k] !== null);
  for (const [k, v] of Object.entries(over)) {
    if (v === null) continue;
    const i = pairs.findIndex(([pk]) => pk === k);
    if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]);
  }
  return [...pairs, ...extra];
}

cleanupRows();
applyTestSettings();
const cfg = fixtures("config", {});
if (!cfg.ready || cfg.mode !== "test" || !cfg.api_configured) {
  console.log(`✗ the server under test is not ready in TEST mode: ${cfg.reason} (mode ${cfg.mode}, api ${cfg.api_configured})`);
  restoreShared();
  stopServer();
  await mock.close();
  process.exit(1);
}

const owner = jar(IP.owner);
const editor = jar(IP.editor);
const viewer = jar(IP.viewer);
let browser = null;
const F = {}; // fixtures by short name
try {
  let r = await login(owner, "admin", "Admin@Test123");
  check(r.status === 302, "the environment admin signs in", `status ${r.status}`);
  await deleteAccounts(owner);
  await createAccount(owner, EDITOR, "E2E Pay Editor", "editor", "IssuedEd11Xy");
  await createAccount(owner, VIEWER, "E2E Pay Viewer", "viewer", "IssuedVw22Xy");
  await signInFresh(editor, EDITOR, "IssuedEd11Xy", EDITOR_PW);
  await signInFresh(viewer, VIEWER, "IssuedVw22Xy", VIEWER_PW);
  check((await editor.get("/admin/")).status === 200 && (await viewer.get("/admin/")).status === 200, "the editor and the viewer are signed in");

  /* ── Fixtures ────────────────────────────────────────────────────────── */
  section("fixtures: payables driven through the mock gateway");
  F.d1 = mkDonation({ who: "Anbu", amount: "1001", pan: "ABCDE1234F", address: "5 Temple Car Street", city: "Tenkasi", state: "Tamil Nadu", postcode: "627811", message: "For the festival", notes: "Call after 6pm", showNamePublicly: true });
  await checkout(F.d1);
  mock.order(F.d1.order_id).bankRefNo = '=HYPERLINK("http://example.test")'; // a formula-looking cell for the CSV check
  const d1cb = await callback(F.d1.order_id, "success");
  check(d1cb.status === 303 && /\/payment\/result\?ref=DON-/.test(d1cb.location) && donation(F.d1.number).status === "SUCCESS" && attempt(F.d1.order_id).verification === "status_api",
    "D1: a UPI success is SUCCESS, confirmed with the status API", `${d1cb.status} ${d1cb.location} ${donation(F.d1.number)?.status}`);
  F.d1.receipt = donation(F.d1.number).receipt_number;
  const d1replay = await fetch(`${BASE}/api/payments/ccavenue/notify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "X-Forwarded-For": IP.gateway }, body: new URLSearchParams({ encResp: d1cb.encResp }) });
  check(d1replay.status === 200 && Number(attempt(F.d1.order_id).response_count) === 2, "D1: a replayed response only counts a second callback", `${d1replay.status} count ${attempt(F.d1.order_id).response_count}`);

  F.d2 = mkDonation({ who: "Bala", amount: "2500", category: "temple_development", phone: "12025550123", phoneCountry: "US", country: "US" });
  await pay(F.d2, "card");
  F.d3 = mkDonation({ who: "Chitra", amount: "25", currency: "USD", country: "GB", phone: "447700900123", phoneCountry: "GB" });
  await pay(F.d3, "success");
  F.d4 = mkDonation({ who: "Devi", amount: "500" });
  await pay(F.d4, "failure");
  F.d5 = mkDonation({ who: "Ezhil", amount: "300" });
  await pay(F.d5, "aborted");
  F.d6 = mkDonation({ who: "Fathima", amount: "200" }); // never reached the gateway; four hours old
  fixtures("backdate", { order_ids: [F.d6.order_id], minutes: 240 });
  F.d7 = mkDonation({ who: "Gowri", amount: "150" });
  await pay(F.d7, "tamper");
  F.d8 = mkDonation({ who: "Hari", amount: "4000", category: "annadanam" });
  await pay(F.d8, "success");
  sql("UPDATE donations SET paid_at = ? WHERE donation_number = ?", [LAST_MONTH_LATE, F.d8.number]);
  F.d9 = mkDonation({ who: "Indra", amount: "350" });
  await pay(F.d9, "awaited");
  F.d10 = mkDonation({ who: "Jaya", amount: "600" });
  await pay(F.d10, "success", { tracking_id: "" }); // no CCAvenue reference → refunds by hand only
  F.d11 = mkDonation({ who: "Kamal", amount: "450" });
  await checkout(F.d11);
  mock.setApiScenario(F.d11.order_id, "http500"); // the status API is down during the callback
  await callback(F.d11.order_id, "success");
  mock.setApiScenario(F.d11.order_id, "ok");
  F.d13 = mkDonation({ who: "Oviya", amount: "800", category: "education" });
  await pay(F.d13, "success");
  sql("UPDATE donations SET paid_at = ? WHERE donation_number = ?", [THIS_MONTH_EARLY, F.d13.number]);
  F.s1 = mkSeva({ who: "Meena", seva_id: 1 });
  await pay(F.s1, "success");
  F.s2 = mkSeva({ who: "Nila", seva_id: 2 }); // started, never paid
  const fillers = [];
  for (let i = 0; i < 12; i++) fillers.push(mkDonation({ who: `Filler ${pad(i + 1)}`, amount: String(10 + i), email: "" }));
  sql("INSERT INTO donations (name, phone, amount, purpose, message) VALUES (?, '9876500000', 777, 'general', 'pledge fixture')", [`${PREFIX} Pledge`]);

  const st = (fx) => donation(fx.number)?.status ?? booking(fx.number)?.payment_status;
  check(st(F.d2) === "SUCCESS" && st(F.d3) === "SUCCESS" && donation(F.d3.number).currency === "USD" && st(F.d4) === "FAILED" && st(F.d5) === "CANCELLED"
    && st(F.d6) === "INITIATED" && st(F.d7) === "PENDING" && Number(attempt(F.d7.order_id).needs_review) === 1 && st(F.d8) === "SUCCESS" && st(F.d9) === "PENDING"
    && st(F.d10) === "SUCCESS" && attempt(F.d10.order_id).tracking_id === null && st(F.d11) === "SUCCESS" && attempt(F.d11.order_id).verification === "callback"
    && st(F.d13) === "SUCCESS" && st(F.s1) === "SUCCESS" && booking(F.s1.number).status === "pending" && st(F.s2) === "INITIATED",
    "the fixture set is in the intended states",
    [F.d2, F.d3, F.d4, F.d5, F.d6, F.d7, F.d8, F.d9, F.d10, F.d11, F.d13, F.s1, F.s2].map((f) => `${f.number}:${st(f)}`).join(" "));
  const seva1 = one("SELECT amount FROM sevas WHERE id = 1");
  check(Number(booking(F.s1.number).amount) === Number(seva1.amount) && Number(attempt(F.s1.order_id).amount) === Number(seva1.amount), "S1 was charged the seva's own price", `${booking(F.s1.number).amount} vs ${seva1.amount}`);

  /* ── 1. Roles and CSRF ───────────────────────────────────────────────── */
  section("1. roles and CSRF");
  for (const view of ["", "?view=transactions", "?view=refunds", "?view=reconcile", `?number=${F.d1.number}`]) {
    const p = await viewer.html(PAGE + view);
    check(p.status === 200 && !BAD.test(p.html), `viewer reads payments.php${view}`, `status ${p.status}`);
  }
  let p = await viewer.html(PAGE + `?number=${F.d1.number}`);
  check(!p.html.includes('name="action" value="resend_receipt"') && !p.html.includes('name="action" value="refund"') && !p.html.includes('name="action" value="check_now"'),
    "the viewer sees no resend, check or refund forms");
  r = await viewer.get(`${PAGE}?export=csv&q=${encodeURIComponent(PREFIX)}`);
  check(r.status === 200 && /text\/csv/.test(r.headers.get("content-type") || ""), "the viewer can export the CSV", `status ${r.status}`);
  const d7Before = attempt(F.d7.order_id);
  let vp = await viewer.html(PAGE);
  for (const [label, pairs] of [
    ["mark_reviewed", { action: "mark_reviewed", transaction_id: String(F.d7.transaction_id), note: "viewer tries" }],
    ["resend_receipt", { action: "resend_receipt", number: F.d1.number }],
    ["refund", { action: "refund", number: F.d1.number, transaction_id: String(F.d1.transaction_id), kind: "full", reason: "viewer tries a refund", method: "gateway_api" }],
    ["run_checks", { action: "run_checks" }],
  ]) {
    r = await viewer.post(PAGE, { _csrf: csrfOf(vp.html), ...pairs });
    check(r.status === 403, `viewer POST ${label} is refused`, `status ${r.status}`);
  }
  check(Number(attempt(F.d7.order_id).needs_review) === 1 && refundsOf(F.d1.order_id).length === 0 && JSON.stringify(attempt(F.d7.order_id)) === JSON.stringify(d7Before),
    "and nothing changed");
  check((await viewer.get(SETTINGS)).status === 403 && (await viewer.get(CATEGORIES)).status === 403, "the viewer is refused Payment Gateway and Donation Categories");
  check((await editor.get(SETTINGS)).status === 403, "the editor is refused Payment Gateway");
  let ep = await editor.html(PAGE + `?number=${F.d1.number}`);
  check(ep.status === 200 && ep.html.includes('name="action" value="resend_receipt"') && ep.html.includes('name="action" value="check_now"') && !ep.html.includes('name="action" value="refund"'),
    "the editor sees resend and check but no refund form");
  r = await editor.post(PAGE, { _csrf: csrfOf(ep.html), action: "refund", number: F.d1.number, transaction_id: String(F.d1.transaction_id), kind: "full", reason: "editor tries a refund", method: "gateway_api" });
  check(r.status === 403 && refundsOf(F.d1.order_id).length === 0, "the editor is refused a refund", `status ${r.status}`);
  r = await editor.post(SETTINGS, { _csrf: csrfOf(ep.html), action: "test_connection", environment: "test" });
  check(r.status === 403, "the editor is refused a settings POST", `status ${r.status}`);
  const op = await owner.html(PAGE + `?number=${F.d1.number}`);
  check(op.html.includes('name="action" value="refund"') && op.html.includes("Payments: TEST"), "the owner sees the refund form and the TEST badge in the topbar");
  // CSRF: missing and forged, on each of the three pages, changes nothing.
  r = await owner.post(PAGE, { action: "mark_reviewed", transaction_id: String(F.d7.transaction_id), note: "no token" });
  check(r.status === 303 && Number(attempt(F.d7.order_id).needs_review) === 1, "payments.php: a POST without a CSRF token changes nothing", `status ${r.status}`);
  r = await owner.post(PAGE, { _csrf: "forged", action: "refund", number: F.d1.number, transaction_id: String(F.d1.transaction_id), kind: "full", reason: "forged token", method: "gateway_api" });
  check(r.status === 303 && refundsOf(F.d1.order_id).length === 0, "payments.php: a forged token changes nothing");
  const modeBefore = setting("mode").v;
  r = await owner.post(SETTINGS, [["_csrf", "forged"], ["action", "save"], ["mode", "production"], ["enabled", "0"]]);
  check(r.status === 303 && setting("mode").v === modeBefore && setting("enabled").v === "1", "payment_settings.php: a forged token changes nothing", `status ${r.status}`);
  r = await owner.post(CATEGORIES, { action: "save", id: "0", slug: `${SLUG}_csrf`, name_ta: "x", name_en: "y" });
  check(r.status === 303 && one("SELECT id FROM donation_categories WHERE slug = ?", [`${SLUG}_csrf`]) === null, "donation_categories.php: a POST without a token changes nothing", `status ${r.status}`);

  /* ── 2. Transactions ─────────────────────────────────────────────────── */
  section("2. transactions: filters, search, sort, pagination, CSV");
  const q = encodeURIComponent(PREFIX);
  const T = `${PAGE}?view=transactions`;
  p = await owner.html(`${T}&q=${q}`);
  check(p.status === 200 && !BAD.test(p.html) && p.html.includes("<title>Online Payments — Temple Admin</title>"), "the Transactions tab renders", `status ${p.status}`);
  const expectedAll = rows(`SELECT number FROM (${PAYABLES_SQL}) x`).map((r) => r.number).filter((n) => created.some((f) => f.number === n));
  check(/>26 records</.test(p.html) && /Showing 1–25 of 26/.test(p.html) && listed(p.html).length === 25, "26 payables, 25 on the first page", `${listed(p.html).length} listed; ${/(\d+) records?/.exec(p.html)?.[0]}`);
  const p2 = await owner.html(`${T}&q=${q}&page=2`);
  check(listed(p2.html).length === 1 && !listed(p.html).includes(listed(p2.html)[0]), "page 2 holds the 26th");
  check(expectedAll.length === 26 && [...listed(p.html), ...listed(p2.html)].sort().join() === expectedAll.sort().join(), "every fixture payable is listed once across the pages");
  const head = /<thead>[\s\S]*?<\/thead>/.exec(p.html)?.[0] ?? "";
  const cols = [...head.matchAll(/<th[\s>][^>]*>(?:<a[^>]*>)?([^<]+)/g)].map((m) => m[1].trim());
  check(cols.join("|") === "Donation ID|Transaction ID|Donor|Country|Purpose|Amount|Currency|Payment status|Payment method|Date", "the columns are the ones the contract names", cols.join("|"));
  const rowOf = (html, number) => html.split("<tr").find((tr) => tr.includes(`number=${number}`)) ?? "";
  const d1row = rowOf(p.html, F.d1.number);
  check(d1row.includes(attempt(F.d1.order_id).tracking_id) && d1row.includes("General Donation") && d1row.includes("₹1,001.00") && d1row.includes(">INR<") && d1row.includes(">Success<") && d1row.includes("UPI") && d1row.includes('title="IN">India<'),
    "D1's row shows its CCAvenue reference, purpose, amount, currency, status, method and the country's name (code in the title)", d1row.replace(/\s+/g, " ").slice(0, 400));
  check(rowOf(p.html, F.d2.number).includes('title="US">United States<') && p.html.includes('<option value="US">United States (US)</option>') && p.html.includes('<option value="GB">United Kingdom (GB)</option>'),
    "countries are named; the filter keeps codes as values with names as labels");
  check(rowOf(p.html, F.d7.number).includes(">Review<") && rowOf(p.html, F.d7.number).includes("is-flagged"), "D7's row carries the Review badge");
  check(rowOf(p.html, F.s1.number).includes("Seva: ") && rowOf(p.html, F.s1.number).includes("Seva booking"), "S1's purpose reads Seva: …");
  const expectFilter = (where, params = []) => rows(`SELECT number FROM (${PAYABLES_SQL}) x WHERE ${where}`, params).map((r) => r.number).filter((n) => created.some((f) => f.number === n)).sort().join();
  for (const [label, query, where, params] of [
    ["status=SUCCESS", "status=SUCCESS", "x.status = 'SUCCESS'"],
    ["status=FAILED", "status=FAILED", "x.status = 'FAILED'"],
    ["kind=seva_booking", "kind=seva_booking", "x.kind = 'seva_booking'"],
    ["purpose=seva", "purpose=seva", "x.kind = 'seva_booking'"],
    ["currency=USD", "currency=USD", "x.currency = 'USD'"],
    ["country=US", "country=US", "x.country = 'US'"],
    ["purpose=temple_development", "purpose=temple_development", "x.number = ?", [F.d2.number]],
    ["review=1", "review=1", "x.number = ?", [F.d7.number]],
  ]) {
    const page = await owner.html(`${T}&q=${q}&${query}`);
    const got = listed(page.html).sort().join();
    const want = expectFilter(where, params);
    check(page.status === 200 && got === want, `filter ${label} lists exactly the matching payables`, `got ${got}\n    want ${want}`);
  }
  // from = today (IST) on the first attempt's creation: everything but a fixture backdated past midnight.
  const firstAttempt = Object.fromEntries(rows("SELECT SUBSTRING_INDEX(order_id, '-R', 1) AS number, MIN(created_at) AS c FROM payment_transactions GROUP BY number").map((r) => [r.number, r.c]));
  const sinceToday = expectedAll.filter((n) => (firstAttempt[n] ?? "") >= PERIOD.today[0]).sort().join();
  p = await owner.html(`${T}&q=${q}&from=${Y}-${pad(M + 1)}-${pad(D)}`);
  const sinceCount = Number(/(\d+) records?</.exec(p.html)?.[1] ?? -1);
  check(sinceCount === sinceToday.split(",").filter(Boolean).length && listed(p.html).every((n) => sinceToday.includes(n)), "from=today (IST) filters on the first attempt's creation", `got ${sinceCount}, want ${sinceToday.split(",").length}`);
  check(listed((await owner.html(`${T}&q=${q}&to=${Y - 1}-12-31`)).html).length === 0, "to=last year lists nothing");
  for (const [label, term, want] of [
    ["the number", F.d2.number, [F.d2.number]],
    ["an order id", F.d2.order_id, [F.d2.number]],
    ["a tracking id", attempt(F.d1.order_id).tracking_id, [F.d1.number]],
    ["a name", `${PREFIX} Chitra`, [F.d3.number]],
    ["phone digits", "2025550123", [F.d2.number]],
    ["an email", `e2e-pay-${RUN}-hari@`, [F.d8.number]],
  ]) {
    const page = await owner.html(`${T}&q=${encodeURIComponent(term)}`);
    check(listed(page.html).sort().join() === want.sort().join(), `search on ${label} finds it`, listed(page.html).join());
  }
  const amounts = (html) => listed(html).map((n) => Number(one(`SELECT amount FROM (${PAYABLES_SQL}) x WHERE number = ?`, [n]).amount));
  p = await owner.html(`${T}&q=${q}&sort=amount&dir=asc`);
  let a = amounts(p.html);
  check(a.length > 1 && a.every((v, i) => i === 0 || v >= a[i - 1]), "sort by amount ascending", a.join());
  p = await owner.html(`${T}&q=${q}&sort=amount&dir=desc`);
  a = amounts(p.html);
  check(a.length > 1 && a.every((v, i) => i === 0 || v <= a[i - 1]), "sort by amount descending", a.join());
  p = await owner.html(`${T}&q=${q}&sort=name&dir=asc`);
  const names = listed(p.html).map((n) => one(`SELECT COALESCE(d.name, b.devotee_name) AS name FROM (SELECT ? AS n) z LEFT JOIN donations d ON d.donation_number = z.n LEFT JOIN seva_bookings b ON b.order_number = z.n`, [n]).name);
  check(names.length > 1 && names.every((v, i) => i === 0 || v.localeCompare(names[i - 1]) >= 0), "sort by donor name", names.slice(0, 5).join(" | "));
  p = await owner.html(`${T}&q=${encodeURIComponent('"><script>alert(1)</script>')}&status[]=x&sort=<b>&dir=up&page=99999999999&from=9999-99-99&country=<x>&purpose=<x>&currency=<x>&kind=<x>`);
  check(p.status === 200 && !BAD.test(p.html) && !p.html.includes("<script>alert(1)</script>"), "hostile filters are ignored and escaped", `status ${p.status}`);
  r = await owner.get(`${PAGE}?export=csv&q=${q}`);
  const csvBytes = Buffer.from(await r.arrayBuffer());
  const csv = csvBytes.toString("utf8");
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  check(r.status === 200 && /text\/csv/.test(r.headers.get("content-type") || "") && csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf, "the CSV export answers text/csv with a BOM");
  check(lines[0] === "number,kind,order_id,tracking_id,bank_ref_no,name,phone,email,country,purpose,amount,currency,status,payment_mode,receipt_number,amount_refunded,created_at_ist,paid_at_ist", "the CSV columns are the contract's", lines[0]);
  check(lines.length === 27, "the CSV holds every filtered payable", `${lines.length - 1} rows`);
  const d1csv = lines.find((l) => l.startsWith(F.d1.number));
  check(Boolean(d1csv) && d1csv.includes(`"'=HYPERLINK(""http://example.test"")"`) && d1csv.includes("919876543210") && d1csv.includes(`e2e-pay-${RUN}-anbu@example.test`) && d1csv.includes(F.d1.receipt),
    "D1's row neutralises the formula cell and carries phone, email and receipt", d1csv);
  check(activity("payments.csv").some((x) => x.action === "payment_export"), "the export is in the activity log");

  /* ── 3. Overview KPIs ────────────────────────────────────────────────── */
  section("3. overview KPIs against independent SQL");
  p = await owner.html(PAGE);
  check(p.status === 200 && !BAD.test(p.html), "the overview renders");
  const total = receivedSql();
  check(kpi(p.html, "Received (all time)") === kpiMoney(total.inr), "Received (all time) is the net INR of successful and partly refunded payables, in whole rupees", `${kpi(p.html, "Received (all time)")} vs ${kpiMoney(total.inr)}`);
  check((kpiSub(p.html, "Received (all time)") || "").startsWith(`${total.count} payment`) && (kpiSub(p.html, "Received (all time)") || "").includes(`also ${foreign("USD", total.others.USD ?? 0)}`),
    "with the count and the USD listed separately", kpiSub(p.html, "Received (all time)"));
  for (const [label, key] of [["Today", "today"], ["This month", "month"], ["This year", "year"]]) {
    const want = receivedSql("AND x.paid_at >= ? AND x.paid_at < ?", PERIOD[key]);
    check(kpi(p.html, label) === kpiMoney(want.inr), `${label} (IST) matches`, `${kpi(p.html, label)} vs ${kpiMoney(want.inr)}`);
  }
  const monthNet = receivedSql("AND x.paid_at >= ? AND x.paid_at < ?", PERIOD.month).inr;
  const monthWithoutD13 = receivedSql("AND x.paid_at >= ? AND x.paid_at < ? AND x.number <> ?", [...PERIOD.month, F.d13.number]).inr;
  check(Math.round((monthNet - monthWithoutD13) * 100) === 80000 && kpi(p.html, "This month") === kpiMoney(monthNet), "a payment at 00:10 IST on the 1st counts in this month");
  const prevNet = receivedSql("AND x.paid_at >= ? AND x.paid_at < ?", PERIOD.prevMonth).inr;
  const prevWithoutD8 = receivedSql("AND x.paid_at >= ? AND x.paid_at < ? AND x.number <> ?", [...PERIOD.prevMonth, F.d8.number]).inr;
  const prevLabel = monthLabel(Y, M - 1);
  check(Math.round((prevNet - prevWithoutD8) * 100) === 400000 && p.html.includes(`<tr><td>${prevLabel.slice(0, 3)}</td><td>${prevLabel} · ${money(prevNet)}</td></tr>`),
    "a payment at 23:50 IST on the last day of last month counts in last month's bar", `${prevLabel} · ${money(prevNet)}`);
  check(kpi(p.html, "Successful") === String(countSql("x.receipt_number IS NOT NULL")) && kpi(p.html, "Failed") === String(countSql("x.status = 'FAILED'")) && kpi(p.html, "Pending") === String(countSql("x.status IN ('INITIATED','PENDING')")),
    "Successful, Failed and Pending counts", `${kpi(p.html, "Successful")}/${kpi(p.html, "Failed")}/${kpi(p.html, "Pending")}`);
  const pendingCard = decode(p.html.split("<a class=\"card").find((c) => c.includes('<div class="stat__label">Pending</div>')) ?? "");
  const openList = await owner.html(`${T}&status=open`);
  check(/href="[^"]*status=open[^"]*"/.test(pendingCard) && Number(/(\d+) records?</.exec(openList.html)?.[1] ?? -1) === Number(kpi(p.html, "Pending")),
    "the Pending card links to status=open, whose list has exactly the payables it counts", `${/href="([^"]+)"/.exec(pendingCard)?.[1]} · ${/(\d+) records?</.exec(openList.html)?.[0]} vs ${kpi(p.html, "Pending")}`);
  check(listed((await owner.html(`${T}&q=${q}&status=open`)).html).sort().join() === expectFilter("x.status IN ('INITIATED','PENDING')") && openList.html.includes('<option value="open" selected>Open (initiated or pending)</option>'),
    "status=open lists INITIATED and PENDING payables and is offered in the status filter");
  const dom = receivedSql("AND (x.country IS NULL OR x.country = 'IN') AND x.currency = 'INR'");
  const intl = receivedSql("AND x.country IS NOT NULL AND x.country <> 'IN' AND x.currency = 'INR'");
  const domCount = countSql(`${RECEIVED} AND (x.country IS NULL OR x.country = 'IN')`);
  const intlCount = countSql(`${RECEIVED} AND x.country IS NOT NULL AND x.country <> 'IN'`);
  check(kpi(p.html, "Domestic") === kpiMoney(dom.inr) && kpi(p.html, "International") === kpiMoney(intl.inr) && kpiSub(p.html, "Domestic") === `${domCount} from India` && kpiSub(p.html, "International") === `${intlCount} from abroad`,
    "Domestic and International split by country", `${kpi(p.html, "Domestic")} ${kpiSub(p.html, "Domestic")} / ${kpi(p.html, "International")} ${kpiSub(p.html, "International")}`);
  const refundedAtStart = Number(one("SELECT COALESCE(SUM(amount), 0) s FROM payment_refunds WHERE status = 'SUCCESS' AND currency = 'INR'").s);
  check(kpi(p.html, "Refunded") === kpiMoney(refundedAtStart) && refundsOf(F.d1.order_id).length === 0, "Refunded matches the successful refunds on file (none of this run's yet)", `${kpi(p.html, "Refunded")} vs ${kpiMoney(refundedAtStart)}`);
  check(p.html.includes("Received by purpose") && p.html.includes("General Donation") && p.html.includes("Seva: "), "the purpose shares name categories and sevas");
  const attention = /Flagged for review<\/dt>\s*<dd><a[^>]*>(\d+)<\/a>[\s\S]*?Open longer than 3 hours<\/dt>\s*<dd><a[^>]*>(\d+)<\/a>/.exec(p.html);
  check(Boolean(attention) && Number(attention[1]) === Number(one("SELECT COUNT(*) c FROM payment_transactions WHERE needs_review = 1").c) && Number(attention[2]) >= 1,
    "Needs attention counts flagged and stale attempts", attention?.slice(1).join("/"));
  const pk = await owner.html(`${PAGE}?kind=seva_booking`);
  check(kpi(pk.html, "Received (all time)") === kpiMoney(receivedSql("AND x.kind = 'seva_booking'").inr), "the kind switch narrows to seva bookings", kpi(pk.html, "Received (all time)"));

  /* ── 4. Detail view, Check now, Mark reviewed, PAN ───────────────────── */
  section("4. detail view");
  p = await owner.html(`${PAGE}?number=${F.d1.number}`);
  const d1 = attempt(F.d1.order_id);
  check(p.status === 200 && p.html.includes(F.d1.order_id) && p.html.includes(d1.tracking_id) && p.html.includes(">TEST<") && p.html.includes("status_api") && p.html.includes("2 responses"),
    "D1's attempt row shows order id, environment, reference, verification and responses");
  check(p.html.includes(F.d1.receipt) && p.html.includes("Open receipt") && p.html.includes(`/payment/receipt?ref=${F.d1.number}&amp;t=`), "the receipt number and a tokenised receipt link");
  check(p.html.includes("Status changed") && p.html.includes("Response duplicate") && p.html.includes("Attempt created") && p.html.includes("Payable created"), "the history lists the audit events");
  check(p.html.includes("ABCDE••••F") && !p.html.includes("ABCDE1234F") && p.html.includes("5 Temple Car Street") && p.html.includes("For the festival") && p.html.includes("Call after 6pm") && p.html.includes(">Shown<"),
    "the PAN is masked; address, message, note and the thank-you consent are shown");
  const panViews = () => activity(F.d1.number).filter((x) => x.action === "payment_pan_viewed").length;
  let res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "show_pan", number: F.d1.number });
  check(res.status === 303 && res.location.endsWith(`payments.php?number=${F.d1.number}`) && res.html.includes("ABCDE1234F") && panViews() === 1, "Show reveals the PAN once, on the plain detail URL, and logs it", `${res.status} ${res.location}`);
  const reloaded = await owner.html(`${PAGE}?number=${F.d1.number}`);
  check(!reloaded.html.includes("ABCDE1234F") && reloaded.html.includes("ABCDE••••F") && panViews() === 1, "a reload of that URL shows the mask again and logs nothing new");
  check(!(await viewer.html(`${PAGE}?number=${F.d1.number}&pan=1`)).html.includes("ABCDE1234F") && !(await owner.html(`${PAGE}?number=${F.d1.number}&pan=1`)).html.includes("ABCDE1234F"), "no query flag reveals it, for anyone");
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "mark_reviewed", transaction_id: String(F.d7.transaction_id), note: "" });
  check(res.status === 303 && Number(attempt(F.d7.order_id).needs_review) === 1 && /note|reason|3/i.test(res.flash), "Mark reviewed without a note is refused", res.flash);
  // The editor's token comes from a page that carries a form (the overview has none).
  const editorCsrf = async () => csrfOf((await editor.html(`${PAGE}?view=reconcile`)).html);
  res = await act(editor, PAGE, { _csrf: await editorCsrf(), action: "mark_reviewed", number: F.d7.number, transaction_id: String(F.d7.transaction_id), note: "Checked with the bank statement" });
  check(res.status === 303 && Number(attempt(F.d7.order_id).needs_review) === 0 && auditEvents(F.d7.order_id).includes("admin_marked_reviewed"), "the editor marks D7 reviewed with a note", res.flash);
  mock.setApiStatus(F.d9.order_id, "Successful");
  res = await act(editor, PAGE, { _csrf: await editorCsrf(), action: "check_now", number: F.d9.number });
  check(res.status === 303 && donation(F.d9.number).status === "SUCCESS" && donation(F.d9.number).receipt_number !== null && attempt(F.d9.order_id).verification === "status_api" && /Checked 1 attempt/.test(res.flash),
    "Check with CCAvenue now settles an awaited payment that CCAvenue now reports paid", `${res.flash} ${donation(F.d9.number)?.status}`);
  res = await act(editor, PAGE, { _csrf: await editorCsrf(), action: "resend_receipt", number: F.d1.number });
  const resendEvents = auditEvents(F.d1.order_id).filter((e) => e === "notification_queued" || e === "notification_skipped" || e === "receipt_emailed");
  check(res.status === 303 && /Receipt /.test(res.flash) && res.flash.includes(F.d1.receipt) && activity(F.d1.number).some((x) => x.action === "payment_receipt_resend"),
    "Resend receipt reports what was queued or skipped and is logged", res.flash);
  check(rows("SELECT id FROM notifications WHERE dedupe_key = ?", [`receipt:${F.d1.number}:resend:1`]).length === 1 || resendEvents.length > 0, "and the resend is recorded", resendEvents.join());
  p = await owner.html(`${PAGE}?number=${F.s1.number}`);
  check(p.html.includes("Seva booking") && p.html.includes(`/admin/seva_bookings.php?q=${F.s1.number}`) && p.html.includes("Booking status") && p.html.includes(">Pending<"), "a seva payment links to its booking, which is still pending");
  p = await owner.html(`${PAGE}?number=DON-20990101-00000001`);
  check(p.status === 200 && p.html.includes("That payment number was not found"), "an unknown number is reported, not a 500");

  /* ── 5. Refunds ──────────────────────────────────────────────────────── */
  section("5. refunds");
  const txnBefore = attempt(F.d1.order_id);
  const donBefore = donation(F.d1.number);
  const refundPost = async (session, fx, over) => act(session, PAGE, { _csrf: csrfOf((await session.html(`${PAGE}?number=${fx.number}`)).html), action: "refund", number: fx.number, transaction_id: String(fx.transaction_id), method: "gateway_api", ...over });
  p = await owner.html(`${PAGE}?number=${F.d1.number}`);
  check(p.html.includes(`data-confirm="Refund ₹1,001.00 of ${F.d1.number} to ${PREFIX} Anbu? This cannot be undone."`) && p.html.includes("Sent to CCAvenue automatically"),
    "the refund form confirms with the exact sentence and says it goes to CCAvenue");
  res = await refundPost(owner, F.d1, { kind: "partial", amount: "250", reason: "Duplicate payment, first part" });
  let d1r = refundsOf(F.d1.order_id);
  check(res.status === 303 && /accepted/i.test(res.flash) && d1r.length === 1 && d1r[0].status === "SUCCESS" && d1r[0].kind === "partial" && Number(d1r[0].amount) === 250
    && donation(F.d1.number).status === "PARTIALLY_REFUNDED" && Number(donation(F.d1.number).amount_refunded) === 250, "a partial refund of ₹250 is accepted by the gateway", `${res.flash} ${JSON.stringify(d1r)}`);
  res = await refundPost(owner, F.d1, { kind: "partial", amount: "251.00", reason: "Duplicate payment, second part" });
  check(res.status === 303 && Number(donation(F.d1.number).amount_refunded) === 501 && refundsOf(F.d1.order_id).length === 2, "a second partial brings the refunded total to ₹501", res.flash);
  res = await refundPost(owner, F.d1, { kind: "partial", amount: "1000", reason: "Trying to refund too much" });
  check(res.status === 303 && /cannot be more than/i.test(res.flash) && refundsOf(F.d1.order_id).length === 2 && Number(donation(F.d1.number).amount_refunded) === 501, "an over-refund is refused", res.flash);
  res = await refundPost(owner, F.d1, { kind: "partial", amount: "100.13", reason: "The gateway will refuse this one" });
  d1r = refundsOf(F.d1.order_id);
  check(res.status === 303 && /refused/i.test(res.flash) && d1r.length === 3 && d1r[2].status === "FAILED" && /Simulated refusal/.test(d1r[2].gateway_message) && donation(F.d1.number).status === "PARTIALLY_REFUNDED" && Number(donation(F.d1.number).amount_refunded) === 501,
    "a refund CCAvenue refuses is FAILED and the payable stays partly refunded", `${res.flash} ${JSON.stringify(d1r[2])}`);
  res = await refundPost(owner, F.d1, { kind: "partial", amount: "10", reason: "abc" });
  check(res.status === 303 && /reason/i.test(res.flash) && refundsOf(F.d1.order_id).length === 3, "a reason shorter than 5 characters is refused", res.flash);
  res = await refundPost(owner, F.d1, { kind: "full", amount: "100", reason: "Typed an amount but left Full selected" });
  check(res.status === 303 && /“Full” is selected/.test(res.flash) && /Rs\. 100/.test(res.flash) && refundsOf(F.d1.order_id).length === 3 && Number(donation(F.d1.number).amount_refunded) === 501,
    "kind=full posted with a different typed amount is refused and nothing is refunded", res.flash);
  res = await refundPost(owner, F.d1, { kind: "full", reason: "Return the rest to the donor" });
  d1r = refundsOf(F.d1.order_id);
  check(res.status === 303 && d1r.length === 4 && d1r[3].kind === "full" && Number(d1r[3].amount) === 500 && d1r[3].status === "SUCCESS" && donation(F.d1.number).status === "REFUNDED" && Number(donation(F.d1.number).amount_refunded) === 1001,
    "a full refund returns the remaining ₹500 and the donation is REFUNDED", `${res.flash} ${JSON.stringify(d1r[3])}`);
  const txnAfter = attempt(F.d1.order_id);
  const donAfter = donation(F.d1.number);
  const strip = (row, keys) => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k))));
  check(strip(txnBefore, ["updated_at"]) === strip(txnAfter, ["updated_at"]) && strip(donBefore, ["status", "amount_refunded", "updated_at"]) === strip(donAfter, ["status", "amount_refunded", "updated_at"]),
    "the payment's attempt row and the donation's own fields are unchanged by refunds");
  check(auditEvents(F.d1.order_id).filter((e) => e === "refund_requested").length === 4 && auditEvents(F.d1.order_id).includes("refund_accepted") && auditEvents(F.d1.order_id).includes("refund_refused"),
    "every refund step is in the payment's audit log", auditEvents(F.d1.order_id).join());
  check(rows("SELECT id FROM notifications WHERE entity_type = 'payment_refund' AND entity_id IN (?, ?, ?)", [d1r[0].id, d1r[1].id, d1r[3].id]).length === 3
    && rows("SELECT id FROM notifications WHERE entity_type = 'payment_refund' AND entity_id = ?", [d1r[2].id]).length === 0,
    "each successful refund raised payment.refunded once, the refused one not at all");
  p = await owner.html(`${PAGE}?number=${F.d1.number}`);
  check(!p.html.includes('name="action" value="refund"') && p.html.includes("4 recorded"), "nothing is left to refund on D1");
  // D2: CCAvenue does not answer, then Check again; then a refund marked as failed.
  mock.setApiScenario(F.d2.order_id, "http500");
  res = await refundPost(owner, F.d2, { kind: "partial", amount: "100", reason: "Gateway is down for this one" });
  let d2r = refundsOf(F.d2.order_id);
  check(res.status === 303 && /did not answer/i.test(res.flash) && d2r.length === 1 && d2r[0].status === "REQUESTED" && donation(F.d2.number).status === "REFUND_INITIATED",
    "when CCAvenue does not answer the refund stays requested and the payable is REFUND_INITIATED", `${res.flash} ${JSON.stringify(d2r[0])}`);
  p = await owner.html(`${PAGE}?number=${F.d2.number}`);
  check(p.html.includes('name="action" value="refund_check"') && p.html.includes('name="action" value="refund_fail"'), "Check again and Mark as failed are offered");
  mock.setApiScenario(F.d2.order_id, "ok");
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "refund_check", number: F.d2.number, refund_id: String(d2r[0].id) });
  d2r = refundsOf(F.d2.order_id);
  const refundCalls = mock.requests.filter((x) => x.kind === "api" && x.command === "refundOrder" && x.payload?.refund_ref_no === d2r[0].refund_reference);
  check(res.status === 303 && d2r[0].status === "SUCCESS" && donation(F.d2.number).status === "PARTIALLY_REFUNDED" && Number(donation(F.d2.number).amount_refunded) === 100 && refundCalls.length === 2,
    "Check again re-sends with the same refund reference and settles it", `${res.flash} calls ${refundCalls.length}`);
  mock.setApiScenario(F.d2.order_id, "http500");
  res = await refundPost(owner, F.d2, { kind: "partial", amount: "50", reason: "Will be marked failed by hand" });
  d2r = refundsOf(F.d2.order_id);
  mock.setApiScenario(F.d2.order_id, "ok");
  p = await owner.html(`${PAGE}?number=${F.d2.number}`);
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "refund_fail", number: F.d2.number, refund_id: String(d2r[1].id), reason: "Not found in the CCAvenue dashboard" });
  d2r = refundsOf(F.d2.order_id);
  check(res.status === 303 && d2r[1].status === "FAILED" && /Marked as failed/.test(d2r[1].gateway_message) && donation(F.d2.number).status === "PARTIALLY_REFUNDED" && Number(donation(F.d2.number).amount_refunded) === 100,
    "Mark as failed closes a waiting refund and the payable returns to partly refunded", `${res.flash} ${JSON.stringify(d2r[1])}`);
  res = await act(editor, PAGE, { _csrf: await editorCsrf(), action: "refund_fail", number: F.d2.number, refund_id: String(d2r[1].id), reason: "editor tries" });
  check(res.status === 403, "the editor is refused Mark as failed", `status ${res.status}`);
  // S1: full refund of a seva booking.
  res = await refundPost(owner, F.s1, { kind: "full", reason: "The temple cannot perform the seva that week" });
  check(res.status === 303 && booking(F.s1.number).payment_status === "REFUNDED" && booking(F.s1.number).status === "pending", "a seva booking is refunded in full and its booking status is left to the office", res.flash);
  p = await owner.html(`${PAGE}?number=${F.s1.number}`);
  check(p.html.includes("Also cancel the booking?") && p.html.includes(`/admin/seva_bookings.php?q=${F.s1.number}`), "the detail view asks whether to cancel the booking too");
  // D10: no CCAvenue reference → the manual method.
  p = await owner.html(`${PAGE}?number=${F.d10.number}`);
  check(p.html.includes('name="method" value="manual"') && p.html.includes("I have already refunded this in the CCAvenue dashboard") && p.html.includes('name="confirm_manual"'), "D10 offers only a manual refund");
  res = await refundPost(owner, F.d10, { kind: "full", reason: "Refunded from the dashboard", method: "manual", gateway_reference: "DASH123" });
  check(res.status === 303 && /Tick the box/i.test(res.flash) && refundsOf(F.d10.order_id).length === 0, "a manual refund without the confirmation tick is refused", res.flash);
  res = await refundPost(owner, F.d10, { kind: "full", reason: "Refunded from the dashboard", method: "manual", gateway_reference: "DASH123", confirm_manual: "1" });
  const d10r = refundsOf(F.d10.order_id);
  check(res.status === 303 && d10r.length === 1 && d10r[0].method === "manual" && d10r[0].status === "SUCCESS" && d10r[0].gateway_reference === "DASH123" && donation(F.d10.number).status === "REFUNDED" && auditEvents(F.d10.order_id).includes("refund_manual_recorded"),
    "a manual refund is recorded at once with its dashboard reference", `${res.flash} ${JSON.stringify(d10r[0])}`);
  // D12: a double payment — attempt 1 declined, the retry pays (the receipt), then CCAvenue reports attempt 1 paid after all.
  F.d12 = mkDonation({ who: "Lakshmi", amount: "700" });
  await pay(F.d12, "failure");
  const d12retry = await fetch(`${BASE}/api/payments/retry`, {
    method: "POST", headers: { "content-type": "application/json", "X-Forwarded-For": IP.fixture },
    body: JSON.stringify({ number: F.d12.number, token: fixtures("token", { number: F.d12.number }).token }),
  });
  const d12r2 = await d12retry.json().catch(() => ({}));
  check(d12retry.status === 201 && d12r2.gateway?.url, "D12: after the decline a retry is issued", `${d12retry.status} ${JSON.stringify(d12r2).slice(0, 200)}`);
  await checkout({ order_id: `${F.d12.number}-R2`, checkout: d12r2.gateway });
  await callback(`${F.d12.number}-R2`, "success");
  fixtures("apply", { order_id: F.d12.order_id, status: "SUCCESS", facts: { verification: "status_api", verified: true, checked: true }, actor: "cron" });
  const d12 = donation(F.d12.number);
  const d12a1 = attempt(F.d12.order_id);
  const d12a2 = attempt(`${F.d12.number}-R2`);
  check(d12.status === "SUCCESS" && d12a1.status === "SUCCESS" && d12a2.status === "SUCCESS" && Number(d12a1.needs_review) === 1 && d12.receipt_number !== null && Number(d12.amount_refunded) === 0,
    "D12 is paid twice: both attempts SUCCESS, attempt 1 flagged, one receipt", JSON.stringify([d12.status, d12a1.status, d12a2.status, d12.receipt_number]));
  p = await owner.html(`${PAGE}?number=${F.d12.number}`);
  const attemptRow = (html, orderId) => html.split("<tr").find((tr) => tr.includes(`>${orderId}</span>`)) ?? "";
  check(attemptRow(p.html, `${F.d12.number}-R2`).includes("the receipt") && attemptRow(p.html, F.d12.order_id).includes("extra payment"), "the detail view marks the retry as the receipt and attempt 1 as the extra payment");
  check(p.html.includes('id="refund-attempt"') && p.html.includes(`<option value="${d12a1.id}" data-left="700.00">`) && p.html.includes(`<option value="${d12a2.id}" data-left="700.00">`) && /₹700\.00 left · extra payment<\/option>/.test(p.html),
    "the refund form offers both attempts with what each can give back");
  res = await refundPost(owner, F.d12, { transaction_id: String(d12a1.id), kind: "full", reason: "Paid twice; the extra payment goes back", method: "manual", gateway_reference: "DASH-DOUBLE", confirm_manual: "1" });
  const d12after = donation(F.d12.number);
  const d12ref = refundsOf(F.d12.order_id);
  check(res.status === 303 && d12ref.length === 1 && d12ref[0].status === "SUCCESS" && Number(d12ref[0].amount) === 700 && Number(d12ref[0].transaction_id) === Number(d12a1.id)
    && d12after.status === "SUCCESS" && Number(d12after.amount_refunded) === 0 && d12after.receipt_number === d12.receipt_number,
    "refunding the extra attempt leaves the donation SUCCESS, nothing refunded against its receipt", `${res.flash} ${JSON.stringify([d12after.status, d12after.amount_refunded, d12ref[0]])}`);
  p = await owner.html(`${PAGE}?number=${F.d12.number}`);
  check(attemptRow(p.html, F.d12.order_id).includes("Refunded in full") && !p.html.includes('id="refund-attempt"') && p.html.includes(`name="transaction_id" value="${d12a2.id}"`),
    "the extra attempt reads Refunded in full and only the receipt attempt is left to refund");
  const secOf = (html, id) => new RegExp(`aria-labelledby="sec-${id}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? "";
  p = await owner.html(`${PAGE}?view=reconcile`);
  const dpRows = secOf(p.html, "double_payments").split("<tr").filter((tr) => tr.includes(F.d12.number));
  check(dpRows.length === 2 && dpRows.some((tr) => tr.includes(`${F.d12.number}-R2`) && /keep it/.test(tr)) && dpRows.some((tr) => tr.includes(`>${F.d12.order_id}<`) && /refunded in full/.test(tr)),
    "Double payments lists both attempts: keep the receipt one; the extra one is refunded in full", dpRows.map((tr) => tr.replace(/\s+/g, " ").slice(0, 200)).join(" || "));
  check(!secOf(p.html, "refund_mismatches").includes(F.d12.number), "and no refund mismatch is reported for it");
  p = await owner.html(`${PAGE}?view=refunds`);
  check(p.status === 200 && p.html.includes(d1r[0].refund_reference) && p.html.includes(d2r[1].refund_reference) && p.html.includes(d10r[0].refund_reference), "the Refunds tab lists them");
  p = await owner.html(`${PAGE}?view=refunds&rstatus=FAILED`);
  check(p.html.includes(d2r[1].refund_reference) && !p.html.includes(d1r[0].refund_reference), "and filters by refund status");
  p = await owner.html(PAGE);
  const refundedNow = Number(one("SELECT COALESCE(SUM(amount), 0) s FROM payment_refunds WHERE status = 'SUCCESS' AND currency = 'INR'").s);
  check(kpi(p.html, "Refunded") === kpiMoney(refundedNow), "the Refunded KPI now sums the successful refunds", `${kpi(p.html, "Refunded")} vs ${kpiMoney(refundedNow)}`);
  check(kpi(p.html, "Received (all time)") === kpiMoney(receivedSql().inr), "and Received (all time) is net of them (every SUCCESS attempt less every SUCCESS refund)", `${kpi(p.html, "Received (all time)")} vs ${kpiMoney(receivedSql().inr)}`);

  /* ── 6. Payment Gateway settings ─────────────────────────────────────── */
  section("6. payment gateway settings");
  p = await owner.html(SETTINGS);
  check(p.status === 200 && !BAD.test(p.html) && p.html.includes("<title>Payment Gateway — Temple Admin</title>") && p.html.includes("Payments: TEST"), "the settings page renders for the owner");
  check(!p.html.includes(WORKING_KEY) && !p.html.includes(ACCESS_CODE) && !p.html.includes(PAYMENTS_SECRET) && !p.html.includes(SETTINGS_KEY), "no credential or secret appears in the HTML");
  check(p.html.includes("Set in the server environment (CCAVENUE_TEST_WORKING_KEY)") && /id="cred-test-working_key"[^>]*disabled/.test(p.html.replace(/\n/g, " ")), "the env-provided TEST key is shown as such and read-only");
  check(p.html.includes('id="cred-production-working_key"') && p.html.includes('placeholder="Not set"') && p.html.includes('data-toggle-password="cred-production-working_key"'), "the PRODUCTION fields are editable with a show toggle");
  check(p.html.includes(`https://127.0.0.1:${PHP_PORT}/api/payments/ccavenue/response`) && p.html.includes("/api/payments/ccavenue/cancel") && p.html.includes("/api/payments/ccavenue/notify") && p.html.includes("whitelist"), "the dashboard values list the three URLs and the IP note");
  check(p.html.includes("running in TEST mode") && p.html.includes(">Configured<"), "the status says TEST mode and the API is configured");
  // PRODUCTION refused without credentials.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { mode: "production" }));
  check(res.status === 303 && /PRODUCTION needs a Merchant ID/.test(res.flash) && setting("mode").v === "test", "PRODUCTION is refused without production credentials", res.flash);
  // Store production credentials.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), {}, [["cred[production][merchant_id]", "7654321"], ["cred[production][access_code]", PROD_ACCESS], ["cred[production][working_key]", PROD_KEY], ["cred[test][working_key]", "must-not-be-stored"]]));
  const stored = setting("prod_working_key");
  check(res.status === 303 && /3 settings saved|settings saved/.test(res.flash) && stored !== null && Number(stored.is_secret) === 1 && stored.v.startsWith("sbx1:") && !stored.v.includes(PROD_KEY),
    "production keys are stored as ciphertext", `${res.flash} ${stored?.v?.slice(0, 12)}`);
  check(setting("test_working_key") === null, "a key supplied by the environment is never stored from the form");
  p = await owner.html(SETTINGS);
  check(p.html.includes(`•••• ${PROD_KEY.slice(-4)} (stored)`) && p.html.includes(`•••• 4321 (stored)`) && !p.html.includes(PROD_KEY) && !p.html.includes(PROD_ACCESS), "the page shows only the last four characters");
  const detail = rows("SELECT detail FROM admin_activity WHERE action = 'payment_settings' AND id > ? ORDER BY id DESC", [activityStart]).map((x) => x.detail).join(" ");
  const auditData = rows("SELECT detail, data FROM payment_audit_log WHERE event = 'settings_changed' ORDER BY id DESC LIMIT 3").map((x) => `${x.detail} ${x.data}`).join(" ");
  check(detail.includes("prod_working_key") && !detail.includes(PROD_KEY) && !detail.includes(PROD_ACCESS) && auditData.includes("prod_working_key") && !auditData.includes(PROD_KEY),
    "both audit logs hold the key names only", detail.slice(0, 200));
  // Blank keeps.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html)));
  check(res.status === 303 && setting("prod_working_key").v === stored.v && setting("prod_access_code") !== null, "a blank credential field keeps the stored value", res.flash);
  // PRODUCTION with credentials but no tick, then with the tick — accepted, and put straight back to TEST.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { mode: "production" }));
  check(res.status === 303 && /passed testing in TEST mode/i.test(res.flash) && setting("mode").v === "test", "PRODUCTION is refused without the TEST-lifecycle tick", res.flash);
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { mode: "production", tested_in_test: "1" }));
  const wentLive = setting("mode").v === "production";
  check(res.status === 303 && wentLive && /1 setting saved/.test(res.flash) && res.html.includes("live in PRODUCTION"), "with credentials, PAYMENTS_SECRET, https URLs and the tick, PRODUCTION is accepted", res.flash);
  // A routine save while live (the tick is unticked again on every page load) keeps PRODUCTION.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { mode: "production" }, [["notify_sms", "1"]]));
  check(res.status === 303 && setting("mode").v === "production" && setting("notify_sms").v === "1" && !/passed testing/.test(res.flash) && res.html.includes("live in PRODUCTION"),
    "a routine save while live (SMS switched on, no tick) keeps PRODUCTION", `${res.flash} → mode ${setting("mode").v}`);
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html)));
  check(res.status === 303 && setting("mode").v === "test" && setting("notify_sms").v === "0" && res.html.includes("running in TEST mode"), "and TEST is chosen again", res.flash);
  // Validation of the other fields.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { donation_min: "0", receipt_prefix: "x", hold_minutes: "5", preset_amounts: "1,999999999" }));
  check(res.status === 303 && /at least ₹1/.test(res.flash) && /prefix/.test(res.flash) && /hold/.test(res.flash) && /suggested/i.test(res.flash) && Number(setting("donation_min").v) === 1 && setting("receipt_prefix").v === "TMR" && Number(setting("hold_minutes").v) === 30,
    "bad amounts, prefix, hold and presets are refused with reasons and the old values stay", res.flash);
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { preset_amounts: "100,200,300", hold_minutes: "45" }, [["currencies[]", "GBP"]]));
  check(res.status === 303 && setting("preset_amounts").v === "100,200,300" && setting("hold_minutes").v === "45" && setting("currencies").v === "INR,USD,GBP", "valid changes are saved", res.flash);
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), { preset_amounts: "500,1000,2500,5000,10000", hold_minutes: "30" }));
  check(setting("currencies").v === "INR,USD" && setting("preset_amounts").v === "500,1000,2500,5000,10000", "and put back");
  // Remove clears.
  res = await act(owner, SETTINGS, settingsPairs(csrfOf(p.html), {}, [["remove[production][working_key]", "1"]]));
  p = await owner.html(SETTINGS);
  check(res.status === 303 && setting("prod_working_key") === null && p.html.includes('id="cred-production-working_key"') && /id="cred-production-working_key"[^>]*placeholder="Not set"/.test(p.html.replace(/\n/g, " ")),
    "Remove clears a stored key", res.flash);
  // Test connection.
  const testConn = async (env) => act(owner, SETTINGS, { _csrf: csrfOf(p.html), action: "test_connection", environment: env });
  res = await testConn("test");
  check(res.status === 303 && /Connected — CCAvenue answered/.test(res.flash), "Test connection: connected (no such order)", res.flash);
  mock.setApiScenario("CONNECTIONTEST", "refused");
  res = await testConn("test");
  check(/refused the access code|whitelisted/.test(res.flash), "Test connection: 51407 → access code or IP whitelist", res.flash);
  mock.setApiScenario("CONNECTIONTEST", "http500");
  res = await testConn("test");
  check(/Could not reach CCAvenue/.test(res.flash), "Test connection: unreachable", res.flash);
  mock.setApiScenario("CONNECTIONTEST", "ok");
  const realKey = mock.apiWorkingKey;
  mock.apiWorkingKey = "a-different-key-so-decryption-fails";
  res = await testConn("test");
  mock.apiWorkingKey = realKey;
  check(/working key does not match/.test(res.flash), "Test connection: -1 → the working key does not match", res.flash);
  res = await testConn("production");
  check(/No API credentials/.test(res.flash) || /Could not reach|refused/.test(res.flash), "Test connection for PRODUCTION reports its state without a raw response", res.flash);
  check(!/status=|enc_response|error_code/.test(res.flash), "no raw gateway response reaches the flash");

  /* ── 7. Donation categories ──────────────────────────────────────────── */
  section("7. donation categories");
  p = await editor.html(CATEGORIES);
  check(p.status === 200 && !BAD.test(p.html) && p.html.includes("<title>Donation Categories — Temple Admin</title>") && p.html.includes("General Donation") && p.html.includes(">general<"), "the editor opens the list");
  const catForm = (csrf, over = {}) => ({ _csrf: csrf, action: "save", id: "0", slug: SLUG, name_ta: "சோதனை நோக்கம்", name_en: `E2E Purpose ${RUN}`, description_ta: "விளக்கம்", description_en: "A purpose for tests", suggested_amount: "1500", sort_order: "99", is_active: "1", ...over });
  res = await act(editor, CATEGORIES, catForm(csrfOf(p.html)));
  let cat = one("SELECT * FROM donation_categories WHERE slug = ?", [SLUG]);
  check(res.status === 303 && cat !== null && cat.name_en === `E2E Purpose ${RUN}` && Number(cat.suggested_amount) === 1500 && Number(cat.is_active) === 1 && /Created/.test(res.flash), "creates a category", res.flash);
  check(activity(SLUG).some((x) => x.action === "donation_category_created"), "and logs it");
  r = await editor.post(CATEGORIES, catForm(csrfOf(p.html), { name_en: "Second try" }));
  let html = await r.text();
  check(r.status === 200 && /already used/.test(html) && rows("SELECT id FROM donation_categories WHERE slug = ?", [SLUG]).length === 1, "a duplicate key is refused and kept in the form", `status ${r.status}`);
  r = await editor.post(CATEGORIES, catForm(csrfOf(p.html), { slug: "Bad Key!", name_en: "Bad key" }));
  html = await r.text();
  check(r.status === 200 && /lowercase letters/.test(html) && one("SELECT id FROM donation_categories WHERE name_en = 'Bad key'") === null, "an invalid key is refused");
  r = await editor.post(CATEGORIES, catForm(csrfOf(p.html), { slug: `${SLUG}_amt`, suggested_amount: "abc" }));
  check(r.status === 200 && one("SELECT id FROM donation_categories WHERE slug = ?", [`${SLUG}_amt`]) === null, "a bad suggested amount is refused");
  res = await act(editor, CATEGORIES, catForm(csrfOf(p.html), { id: String(cat.id), slug: "hacked_key", name_en: `E2E Purpose ${RUN} edited`, suggested_amount: "" }));
  cat = one("SELECT * FROM donation_categories WHERE id = ?", [cat.id]);
  check(res.status === 303 && cat.slug === SLUG && cat.name_en === `E2E Purpose ${RUN} edited` && cat.suggested_amount === null, "editing changes the name but never the key", res.flash);
  const edit = await editor.html(`${CATEGORIES}?edit=${cat.id}`);
  check(edit.html.includes('id="dc-slug"') && /id="dc-slug"[^>]*readonly/.test(edit.html.replace(/\n/g, " ")) && edit.html.includes(`E2E Purpose ${RUN} edited`), "the edit form shows the key read-only");
  res = await act(editor, CATEGORIES, { _csrf: csrfOf(p.html), action: "hide", id: String(cat.id) });
  check(res.status === 303 && Number(one("SELECT is_active FROM donation_categories WHERE id = ?", [cat.id]).is_active) === 0, "Hide deactivates it", res.flash);
  p = await editor.html(`${CATEGORIES}?f=hidden`);
  check(p.html.includes(`E2E Purpose ${RUN} edited`) && p.html.includes(">Hidden<"), "the Hidden filter lists it");
  const general = one("SELECT id FROM donation_categories WHERE slug = 'general'");
  res = await act(editor, CATEGORIES, { _csrf: csrfOf(p.html), action: "delete", id: String(general.id) });
  check(res.status === 303 && /cannot be deleted/.test(res.flash) && one("SELECT id FROM donation_categories WHERE slug = 'general'") !== null, "a category in use cannot be deleted", res.flash);
  const allCats = await editor.html(CATEGORIES);
  const generalRow = allCats.html.split("<tr").find((tr) => tr.includes(">general<")) ?? "";
  const mineRow = allCats.html.split("<tr").find((tr) => tr.includes(`>${SLUG}<`)) ?? "";
  check(generalRow !== "" && !generalRow.includes('value="delete"') && mineRow.includes('value="delete"'), "the menu offers Delete only for an unused category");
  res = await act(editor, CATEGORIES, { _csrf: csrfOf(p.html), action: "delete", id: String(cat.id) });
  check(res.status === 303 && one("SELECT id FROM donation_categories WHERE id = ?", [cat.id]) === null && activity(SLUG).some((x) => x.action === "donation_category_deleted"), "an unused category is deleted", res.flash);
  p = await editor.html(`${CATEGORIES}?q=${encodeURIComponent('"><script>alert(1)</script>')}&f=<x>&edit=abc`);
  check(p.status === 200 && !BAD.test(p.html) && !p.html.includes("<script>alert(1)</script>"), "hostile filters are escaped");

  /* ── 8. donations.php, seva_bookings.php, dashboard ──────────────────── */
  section("8. donations.php, seva_bookings.php and the dashboard");
  const DON = "/admin/donations.php";
  p = await owner.html(`${DON}?q=${q}`);
  check(p.status === 200 && !BAD.test(p.html) && p.html.includes('id="f-source"') && p.html.includes("<th scope=\"col\">Payment</th>"), "donations.php has the Source filter and the Payment column");
  const pledgeRow = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Pledge`)) ?? "";
  // D1 is the oldest of this run's 26 donations, so on a 25-per-page list it sits on page 2: search for it by name.
  const onlineRow = (await owner.html(`${DON}?q=${encodeURIComponent(`${PREFIX} Anbu`)}`)).html.split("<tr").slice(1).find((tr) => tr.includes(`${PREFIX} Anbu`)) ?? "";
  check(pledgeRow.includes(">Pledge<") && !pledgeRow.includes("Open payment") && (pledgeRow.includes("Send receipt") || pledgeRow.includes("receipt")), "a pledge row keeps its Pledge badge and receipt action", pledgeRow.replace(/\s+/g, " ").slice(0, 300));
  check(onlineRow.includes(">Online<") && onlineRow.includes(">Refunded<") && onlineRow.includes(`payments.php?number=${F.d1.number}`) && !onlineRow.includes("Send receipt"), "an online row shows Online + its status and Open payment instead of Send receipt", onlineRow.replace(/\s+/g, " ").slice(0, 400));
  p = await owner.html(`${DON}?q=${q}&source=pledge`);
  check(p.html.includes(`${PREFIX} Pledge`) && !p.html.includes(`${PREFIX} Anbu`), "source=pledge lists only pledges");
  p = await owner.html(`${DON}?q=${q}&source=online`);
  check(!p.html.includes(`${PREFIX} Pledge`) && p.html.includes(`${PREFIX} Anbu`) && p.html.includes(`${PREFIX} Devi`), "source=online lists the online rows, failed ones included");
  const wantTotal = Number(one("SELECT COALESCE(SUM(amount - amount_refunded), 0) s FROM donations WHERE source = 'pledge' OR status IN ('SUCCESS','PARTIALLY_REFUNDED')").s);
  p = await owner.html(DON);
  const totalKpi = kpi(p.html, "Total recorded");
  check(totalKpi === "₹" + Math.round(wantTotal).toLocaleString("en-US"), "Total recorded counts pledges and successful online donations net of refunds", `${totalKpi} vs ${wantTotal}`);
  r = await owner.get(`${DON}?export=csv&q=${q}`);
  const donCsv = (await r.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  check(donCsv[0].endsWith(",created_at,source,status,donation_number,currency,category") && donCsv.some((l) => l.includes(F.d1.number) && l.includes("online,REFUNDED") && l.includes("General Donation")),
    "the donations CSV appends source, status, number, currency and category", donCsv[0]);
  const notifBefore = Number(one("SELECT COUNT(*) c FROM notifications WHERE entity_type = 'donation' AND entity_id = ?", [donation(F.d1.number).id]).c);
  res = await act(owner, DON, { _csrf: csrfOf(p.html), action: "send_receipt", id: String(donation(F.d1.number).id) });
  check(res.status === 303 && /paid online.*Online Payments/i.test(res.flash) && Number(one("SELECT COUNT(*) c FROM notifications WHERE entity_type = 'donation' AND entity_id = ?", [donation(F.d1.number).id]).c) === notifBefore,
    "the pledge receipt is refused for an online donation and points to Online Payments", res.flash);
  const SB = "/admin/seva_bookings.php";
  p = await owner.html(`${SB}?q=${q}`);
  check(p.status === 200 && !BAD.test(p.html) && p.html.includes(`${PREFIX} Meena`) && !p.html.includes(`${PREFIX} Nila`), "the default bookings list shows the paid booking and hides the unpaid online one");
  const s1row = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Meena`)) ?? "";
  const s1 = booking(F.s1.number);
  check(s1row.includes(`Paid online ₹251.00 · ${s1.receipt_number}`) && s1row.includes(`payments.php?number=${F.s1.number}`) && s1row.includes("Open payment"), "the paid booking wears its amount and receipt, linked to the payment", s1row.replace(/\s+/g, " ").slice(0, 400));
  check(chip(p.html, "Unpaid online") === 1 && chip(p.html, "All") === 1, "the chips count the queue and the unpaid online booking separately", `${chip(p.html, "Unpaid online")} / ${chip(p.html, "All")}`);
  p = await owner.html(`${SB}?q=${q}&status=unpaid_online`);
  check(p.html.includes(`${PREFIX} Nila`) && !p.html.includes(`${PREFIX} Meena`) && p.html.includes("Online · Initiated"), "Unpaid online lists exactly the unpaid booking");
  p = await owner.html(`${SB}?q=${encodeURIComponent(F.s1.number)}`);
  check(p.html.includes(`${PREFIX} Meena`) && /1 record</.test(p.html), "a search by order number finds the booking");
  r = await owner.get(`${SB}?export=csv&q=${q}`);
  const sbCsv = (await r.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  check(sbCsv[0] === "id,devotee_name,phone,seva_id,seva_name,preferred_date,message,status,created_at,payment_mode,amount,payment_status,order_number,receipt_number,paid_at" && sbCsv.some((l) => l.includes(F.s1.number) && l.includes("online,251.00,REFUNDED")),
    "the bookings CSV appends the payment columns", sbCsv[0]);
  p = await owner.html(`${SB}?q=${q}`);
  res = await act(owner, SB, { _csrf: csrfOf(p.html), action: "set_status", id: String(s1.id), status: "confirmed" });
  check((res.status === 302 || res.status === 303) && booking(F.s1.number).status === "confirmed", "the existing status change still works on a paid booking", `${res.status} ${booking(F.s1.number).status}`);
  await act(owner, SB, { _csrf: csrfOf(p.html), action: "set_status", id: String(s1.id), status: "pending" });
  const dash = await owner.html("/admin/");
  const onlineMonthWant = Number(one(`SELECT COALESCE(SUM(x.amount - x.amount_refunded), 0) s FROM (${PAYABLES_SQL}) x WHERE ${RECEIVED} AND x.currency = 'INR' AND x.paid_at >= ? AND x.paid_at < ?`, PERIOD.month).s);
  check(dash.status === 200 && !BAD.test(dash.html) && kpi(dash.html, "Online payments this month") === "₹" + Math.round(onlineMonthWant).toLocaleString("en-US"),
    "the dashboard shows Online payments this month", `${kpi(dash.html, "Online payments this month")} vs ${onlineMonthWant}`);
  check(kpi(dash.html, "Total donations") === "₹" + Math.round(wantTotal).toLocaleString("en-US"), "and its Total donations excludes failed online donations", kpi(dash.html, "Total donations"));
  check(dash.html.includes(">Online Payments<") && dash.html.includes(">Payment Gateway<") && dash.html.includes(">Donation Categories<") && dash.html.includes("Export payments CSV"), "the navigation and palette name the three pages and the export");

  /* ── 9. Reconciliation ───────────────────────────────────────────────── */
  section("9. reconciliation");
  const REC = `${PAGE}?view=reconcile`;
  p = await owner.html(REC);
  check(p.status === 200 && !BAD.test(p.html), "the Reconciliation tab renders");
  const sectionOf = (html, id) => new RegExp(`aria-labelledby="sec-${id}">([\\s\\S]*?)</section>`).exec(html)?.[1] ?? "";
  check(["paid_at_gateway", "unverified_success", "needs_review", "duplicate_callbacks", "double_payments", "missing", "refund_mismatches", "stale_open"].every((id) => p.html.includes(`aria-labelledby="sec-${id}"`)), "all eight sections are present");
  check(sectionOf(p.html, "unverified_success").includes(F.d11.order_id), "D11 (status API down at callback time) is under Paid here without CCAvenue confirmation");
  check(sectionOf(p.html, "duplicate_callbacks").includes(F.d1.order_id), "D1 is under Duplicate callbacks");
  check(sectionOf(p.html, "stale_open").includes(F.d6.order_id), "D6 is under Stale open attempts");
  check(!sectionOf(p.html, "needs_review").includes(F.d7.order_id), "D7 left Needs review once marked reviewed");
  // Run checks now: D11 gets verified, D6 is closed.
  res = await act(editor, PAGE, { _csrf: await editorCsrf(), action: "run_checks" });
  check(res.status === 303 && /Checked \d+ attempt/.test(res.flash) && attempt(F.d11.order_id).verification === "status_api" && attempt(F.d6.order_id).status === "CANCELLED",
    "Run checks now verifies D11 with CCAvenue and closes D6 after 3 hours", `${res.flash} d11 ${attempt(F.d11.order_id).verification} d6 ${attempt(F.d6.order_id).status}`);
  // CSV upload.
  const istDay = `${pad(D)}/${pad(M + 1)}/${Y}`;
  const report = [
    "Order No,Reference No,Order Amount,Currency,Order Status,Order Date",
    `${F.d1.order_id},${attempt(F.d1.order_id).tracking_id},1000.00,INR,Successful,${istDay} 00:00:01`,
    `${F.d4.order_id},${attempt(F.d4.order_id).tracking_id},500.00,INR,Successful,${istDay} 12:00:00`,
    `DON-20990101-00000001,999,10.00,INR,Successful,${istDay} 23:59:58`,
    "",
  ].join("\r\n");
  const auditBefore = Number(one("SELECT COUNT(*) c FROM payment_audit_log WHERE event = 'reconcile_csv_mismatch'").c);
  r = await editor.upload(PAGE, { _csrf: csrfOf((await editor.html(REC)).html), action: "reconcile_csv" }, { field: "report", body: report, name: "ccavenue-orders.csv" });
  p = await editor.html(REC);
  check(r.status === 303 && /Compared 3 report rows: 2 matched, 3 differences/.test(flashOf(p.html)), "the CSV is compared: 3 rows, 2 matched, 3 differences", flashOf(p.html));
  const diff = /aria-labelledby="r-diff-title"([\s\S]*?)<\/section>/.exec(p.html)?.[1] ?? "";
  check(diff.includes(F.d1.order_id) && diff.includes(">amount<") && diff.includes("1001.00") && diff.includes("1000.00") && diff.includes(F.d4.order_id) && diff.includes(">status<") && diff.includes("DON-20990101-00000001") && diff.includes("not found"),
    "the differences table lists the amount, status and unknown-order mismatches", diff.replace(/\s+/g, " ").slice(0, 500));
  check(sectionOf(p.html, "paid_at_gateway").includes(F.d4.order_id) && sectionOf(p.html, "missing").includes("DON-20990101-00000001") && sectionOf(p.html, "missing").includes(F.d2.order_id),
    "Paid at CCAvenue and Missing transactions pick up the report's rows");
  check(Number(one("SELECT COUNT(*) c FROM payment_audit_log WHERE event = 'reconcile_csv_mismatch'").c) === auditBefore + 3, "each mismatch is audited once");
  r = await editor.upload(PAGE, { _csrf: csrfOf(p.html), action: "reconcile_csv" }, { field: "report", body: "Order No,Reference No\r\nX,1\r\n", name: "short.csv" });
  p = await editor.html(REC);
  check(r.status === 303 && /no column for: Amount \(.*Status \(/.test(flashOf(p.html)) && /"Order Amt"/.test(flashOf(p.html)), "a report without amount and status columns is refused with the aliases", flashOf(p.html));
  r = await editor.upload(PAGE, { _csrf: csrfOf(p.html), action: "reconcile_csv" }, { field: "report", body: report, name: "orders.xlsx", type: "application/octet-stream" });
  p = await editor.html(REC);
  check(r.status === 303 && /must be a \.csv/.test(flashOf(p.html)), "a non-.csv file is refused", flashOf(p.html));
  r = await editor.upload(PAGE, { _csrf: csrfOf(p.html), action: "reconcile_csv" });
  p = await editor.html(REC);
  check(r.status === 303 && /Choose the order report/.test(flashOf(p.html)), "a missing file is refused", flashOf(p.html));
  res = await act(editor, PAGE, { _csrf: csrfOf(p.html), action: "clear_csv" });
  check(res.status === 303 && !res.html.includes('aria-labelledby="r-diff-title"'), "Clear removes the comparison", res.flash);
  r = await viewer.upload(PAGE, { _csrf: csrfOf((await viewer.html(REC)).html), action: "reconcile_csv" }, { field: "report", body: report, name: "orders.csv" });
  check(r.status === 403, "a viewer cannot upload a report", `status ${r.status}`);

  /* ── 10. Browser ─────────────────────────────────────────────────────── */
  section("10. browser: overflow and accessibility at 390 and 1440");
  browser = await chromium.launch();
  const origin = new URL(BASE).origin;
  const axe = async (pg) => {
    await pg.addScriptTag({ content: axeSource });
    return pg.evaluate(async () => {
      const out = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } });
      return out.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
    });
  };
  const overflow = (pg) => pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route((u) => u.origin === origin, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": IP.browser } }));
    const pg = await ctx.newPage();
    const errors = [];
    pg.on("pageerror", (e) => errors.push(e.message));
    pg.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await pg.goto(BASE + "/admin/login.php");
    await pg.fill("#username", "admin");
    await pg.fill("#password", "Admin@Test123");
    await Promise.all([pg.waitForURL(/\/admin\/(?!login)/), pg.press("#password", "Enter")]);
    for (const [label, path] of [
      ["overview", PAGE], ["transactions", `${T}&q=${q}`], ["detail", `${PAGE}?number=${F.d2.number}`], ["reconciliation", REC],
      ["payment gateway", SETTINGS], ["donation categories", CATEGORIES],
    ]) {
      await pg.goto(BASE + path, { waitUntil: "load" });
      await pg.waitForTimeout(500);
      check(!(await overflow(pg)), `${label} @${width}: no horizontal overflow`);
      const v = await axe(pg);
      check(v.length === 0, `${label} @${width}: no serious or critical axe violations`, v.slice(0, 5).join("\n      "));
      if (label === "overview") {
        const clipped = await pg.evaluate(() => Array.from(document.querySelectorAll(".stat__val")).filter((el) => {
          const card = el.closest(".stat").getBoundingClientRect();
          return el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().right > card.right - 4;
        }).map((el) => el.textContent.trim()));
        check(clipped.length === 0, `overview @${width}: no KPI value is clipped by its card`, clipped.join(" | "));
      }
    }
    if (width === 1440) {
      await pg.goto(`${BASE}${SETTINGS}`, { waitUntil: "load" });
      const toggle = pg.locator('[data-toggle-password="cred-production-working_key"]');
      await pg.fill("#cred-production-working_key", "typed-value");
      await toggle.click();
      check((await pg.getAttribute("#cred-production-working_key", "type")) === "text" && (await toggle.getAttribute("aria-pressed")) === "true", "the show-key toggle reveals what was typed");
      await pg.goto(`${BASE}${PAGE}?number=${F.d2.number}`, { waitUntil: "load" });
      await pg.fill("#refund-reason", "Browser check of the confirmation");
      await pg.click(".pay-refund-form button[type=submit]");
      const dialog = pg.locator('[role="alertdialog"]').first();
      await dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => null);
      const dialogText = (await dialog.textContent().catch(() => "")) || "";
      check(dialogText.includes(`Refund ₹2,400.00 of ${F.d2.number} to ${PREFIX} Bala? This cannot be undone.`), "the refund button opens the confirmation dialog with the exact sentence", dialogText.slice(0, 200));
      await pg.keyboard.press("Escape");
      check(refundsOf(F.d2.order_id).length === 2, "and cancelling the dialog sends nothing");
      // Typing an amount chooses "Part of it", and the sentence says that amount — not the whole refundable amount.
      await pg.fill("#refund-amount", "150");
      check(await pg.isChecked('input[name="kind"][value="partial"]'), "typing an amount selects Part of it");
      await pg.click(".pay-refund-form button[type=submit]");
      await dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => null);
      const partialText = (await dialog.textContent().catch(() => "")) || "";
      check(partialText.includes(`Refund ₹150.00 of ${F.d2.number} to ${PREFIX} Bala? This cannot be undone.`), "the confirmation names the typed partial amount", partialText.slice(0, 200));
      await pg.keyboard.press("Escape");
      await pg.check('input[name="kind"][value="full"]');
      await pg.click(".pay-refund-form button[type=submit]");
      await dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => null);
      const fullAgain = (await dialog.textContent().catch(() => "")) || "";
      check(fullAgain.includes(`Refund ₹2,400.00 of ${F.d2.number}`), "choosing Full again puts the whole refundable amount back in the sentence", fullAgain.slice(0, 200));
      await pg.keyboard.press("Escape");
      check(refundsOf(F.d2.order_id).length === 2, "and still nothing was sent");
    }
    check(errors.length === 0, `@${width}: no script errors`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  try {
    await deleteAccounts(owner);
    cleanupRows();
    restoreShared();
    const left = one(`SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?)
      + (SELECT COUNT(*) FROM payment_transactions t WHERE t.order_id IN (${created.length ? created.map(() => "?").join(",") : "''"}))
      + (SELECT COUNT(*) FROM donation_categories WHERE slug LIKE 'e2epay_%') + (SELECT COUNT(*) FROM admin_users WHERE username IN (?, ?))
      + (SELECT COUNT(*) FROM rate_limits WHERE bucket REGEXP ?) + (SELECT COUNT(*) FROM payment_settings WHERE is_secret = 1 AND k LIKE 'prod_%' AND updated_by = 'admin') AS c`,
      [`${PREFIX}%`, `${PREFIX}%`, ...created.map((f) => f.order_id), EDITOR, VIEWER, BUCKETS_REGEXP]);
    const settingsNow = rows("SELECT k, v FROM payment_settings ORDER BY k").map((x) => `${x.k}=${x.v}`).join("|");
    const settingsWant = [...settingsSnapshot].sort((a, b) => a.k.localeCompare(b.k)).map((x) => `${x.k}=${x.v}`).join("|");
    check(Number(left.c) === 0 && settingsNow === settingsWant, "every fixture is removed afterwards and the payment settings are restored", `left ${left?.c}; settings ${settingsNow === settingsWant ? "match" : "differ"}`);
  } catch (e) {
    check(false, "cleanup ran", e.stack || String(e));
  }
  stopServer();
  await mock.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
