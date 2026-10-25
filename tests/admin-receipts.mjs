#!/usr/bin/env node
/**
 * tests/admin-receipts.mjs — Admin → Finance → Receipts (brief §14, §15
 * Finance, §17, §28): backend/admin/receipts.php against the real PHP + MySQL
 * stack.
 *
 *   PHP_BIN=/path/to/php node tests/admin-receipts.mjs
 *
 * Starts its own PHP server on a free port in SIMULATOR mode through the
 * PAYMENTS_SETTINGS_OVERLAY (so no payment_settings row is touched), with the
 * notification test drivers, and signs in as the environment admin
 * (admin / Admin@Test123) and as an admin, an editor, a finance admin and a
 * viewer it creates through admin/users.php. Requests carry X-Forwarded-For
 * from a 10.97.<octet>.x lane of their own.
 *
 * What it proves:
 *   1. the list: every issued receipt (donations and seva bookings) with its
 *      receipt number, payment number, donor, purpose in both scripts (category,
 *      seva, or the pooja a donation sponsors), amount, currency, issue date,
 *      CCAvenue reference and status; unpaid and failed payments are absent;
 *      Tamil names round-trip; hostile names are escaped;
 *   2. search by receipt number, payment number, donor name and phone;
 *   3. the month, type and status filters, one by one;
 *   4. pagination and sorting;
 *   5. totals for the filtered set against figures computed independently in SQL;
 *   6. the CSV export: header row, every filtered row, formula cells
 *      neutralised, the audit row;
 *   7. Resend receipt through the payments module's own code path (the
 *      notification row, the test email delivery, the audit rows), and its
 *      refusals;
 *   8. roles: payments.view opens the page, payments.manage resends, a viewer's
 *      POST is refused; a forged or missing CSRF token changes nothing.
 *
 * Creates payables named "E2E-RCPT-<run> …" and removes them, their attempts,
 * refunds, audit rows, notifications, the pooja and accounts it made, its
 * activity entries and its rate_limits buckets. Nothing it creates carries the
 * E2E-PAY-ADM- prefix, so admin-payments.mjs's own counts are untouched.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import crypto from "node:crypto";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const PHP_BIN = process.env.PHP_BIN || "php";
const viaBash = /\.sh$/i.test(PHP_BIN);
const RUN = Date.now().toString(36);
const PREFIX = `E2E-RCPT-${RUN}`;
const USER = (role) => `e2ercpt_${RUN}_${role}`;
const PAGE = "/admin/receipts.php";
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace|SQLSTATE)/;
const OCTET = 1 + Math.floor(Math.random() * 250);
const IP = { owner: `10.97.${OCTET}.10`, admin: `10.97.${OCTET}.11`, editor: `10.97.${OCTET}.12`, finance: `10.97.${OCTET}.13`, viewer: `10.97.${OCTET}.14`, anon: `10.97.${OCTET}.15`, fixture: `10.97.${OCTET}.16` };
const ALL_IPS = Object.values(IP);
const BUCKETS_REGEXP = `:10[.]97[.]${OCTET}[.]1[0-9]$`;

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 700)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Server address and environment ────────────────────────────────────── */
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const PHP_PORT = probe.address().port;
await new Promise((done) => probe.close(done));
const BASE = `http://127.0.0.1:${PHP_PORT}`;

// The caller's shell must not leak provider or gateway settings into the server
// or the fixtures; every process gets exactly this run's environment.
const STRIP = /^(NOTIFY_|PAYMENTS_|CCAVENUE_|WHATSAPP_|TWILIO_|MSG91_|MAIL_|SMTP_|SITE_URL$|TRUSTED_PROXIES$)/i;
const baseEnv = {};
for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) baseEnv[k] = v;
const PHP_ENV = {
  ...baseEnv,
  TRUSTED_PROXIES: "127.0.0.1,::1",
  SITE_URL: BASE,
  ADMIN_USERNAME: "admin",
  PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({
    enabled: "1", mode: "simulator", seva_online_enabled: "1", international_enabled: "1", currencies: "INR,USD", default_currency: "INR",
    notify_email: "1", notify_whatsapp: "0", notify_sms: "0", receipt_prefix: "TMR", hold_minutes: "30",
  }),
  PAYMENTS_SECRET: crypto.randomBytes(24).toString("hex"), // 48 chars, invented for this run
  PAYMENTS_SETTINGS_KEY: crypto.randomBytes(32).toString("base64"),
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "test",
  NOTIFY_SMS_DRIVER: "test",
};

function php(args, input = null) {
  const cmd = viaBash ? "bash" : PHP_BIN;
  const argv = viaBash ? [PHP_BIN, ...args] : args;
  const r = spawnSync(cmd, argv, { cwd: REPO, encoding: "utf8", env: PHP_ENV, input: input ?? undefined, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`php ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
/** One fixture command; the JSON argument travels on stdin, so nothing is quoted for a shell. */
function fixture(cmd, obj = {}) {
  const out = php(["tests/support/payments_fixtures.php", cmd, "-"], JSON.stringify(obj));
  const data = JSON.parse(out.trim().split(/\r?\n/).pop());
  if (data.error) throw new Error(`fixture ${cmd}: ${data.error}${data.fields ? " " + JSON.stringify(data.fields) : ""}`);
  return data;
}
const sql = (query, params = []) => fixture("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;
const donation = (number) => one("SELECT * FROM donations WHERE donation_number = ?", [number]);
const booking = (number) => one("SELECT * FROM seva_bookings WHERE order_number = ?", [number]);
const activity = (action) => rows("SELECT actor, action, subject, detail FROM admin_activity WHERE action = ? AND id > ? ORDER BY id", [action, activityStart]);
const notesFor = (number) => rows("SELECT id, event, dedupe_key, to_email FROM notifications WHERE dedupe_key LIKE ? ORDER BY id", [`receipt:${number}:resend:%`]);
const deliveriesOf = (notificationId) => rows("SELECT channel, status, provider FROM notification_deliveries WHERE notification_id = ? ORDER BY channel", [notificationId]);
const auditEvents = (orderId) => rows("SELECT a.event FROM payment_audit_log a JOIN payment_transactions t ON t.id = a.transaction_id WHERE t.order_id = ? ORDER BY a.id", [orderId]).map((r) => r.event);

/* ── Money and IST helpers (independent of the PHP implementation) ─────── */
const money = (n) => "₹" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const kpiMoney = (n) => "₹" + Math.round(Number(n)).toLocaleString("en-US");
const IST_MS = 330 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const utcString = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const istToUtc = (y, m0, d, h = 0, min = 0) => utcString(new Date(Date.UTC(y, m0, d, h, min) - IST_MS));
const nowIst = new Date(Date.now() + IST_MS);
const Y = nowIst.getUTCFullYear();
const M = nowIst.getUTCMonth();
const D = nowIst.getUTCDate();
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const THIS_MONTH = `${Y}-${pad(M + 1)}`;
const prev = new Date(Date.UTC(Y, M - 1, 1));
const PREV_MONTH = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}`;
const LAST_MONTH_LATE = istToUtc(Y, M, 0, 23, 50); // 23:50 IST on the last day of last month
const TODAY_IST_LABEL = `${pad(D)} ${MONTHS[M]} ${Y}`;
const POOJA_DATE = new Date(Date.UTC(Y, M, D + 10)).toISOString().slice(0, 10);

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
    async get(path, extra = {}) {
      const r = await fetch(BASE + path, { headers: { cookie, "X-Forwarded-For": xff, ...extra }, redirect: "manual" });
      grab(r);
      return r;
    },
    async post(path, pairs, extra = {}) {
      const r = await fetch(BASE + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff, "content-type": "application/x-www-form-urlencoded", ...extra },
        body: new URLSearchParams(pairs),
      });
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
const flashOf = (html) => decode(/<p class="alert alert--(?:success|warning|error)" role="(?:status|alert)">([^<]*)<\/p>/.exec(html)?.[1] ?? "");
/** POST, follow the 303 by hand, return {status, location, html (of the landing page), flash}. */
async function act(session, pairs, extra = {}) {
  const r = await session.post(PAGE, pairs, extra);
  const location = r.headers.get("location") || "";
  if (r.status !== 303 && r.status !== 302) return { status: r.status, location, html: await r.text(), flash: "" };
  const path = location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location;
  const landing = await session.html(path);
  return { status: r.status, location, html: landing.html, flash: flashOf(landing.html) };
}
const mainOf = (html) => (/<main[^>]*id="admin-content"[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? html).replace(/<script[\s\S]*?<\/script>/g, "");
/** Receipt numbers shown in the list (the cell-title of each row). */
const listedReceipts = (html) => [...mainOf(html).matchAll(/<span class="cell-title tabular">([A-Z]{2,8}-\d{4}-\d{6})<\/span>/g)].map((m) => m[1]);
const kpi = (html, label) => {
  const m = new RegExp(`<div class="stat__val">([^<]+)</div><div class="stat__label">${label.replace(/[()]/g, "\\$&")}</div>`).exec(html);
  return m ? decode(m[1]) : null;
};
const kpiSub = (html, label) => {
  const m = new RegExp(`<div class="stat__label">${label.replace(/[()]/g, "\\$&")}</div><div class="stat__sub">([^<]+)</div>`).exec(html);
  return m ? decode(m[1]) : null;
};
const countOf = (html) => Number(/<span class="toolbar__count"[^>]*>(\d+) receipt/.exec(html)?.[1] ?? -1);
const amountsOf = (html) => [...mainOf(html).matchAll(/class="cell-money">([^<]+)/g)].map((m) => Number(decode(m[1]).replace(/[^\d.]/g, "")));
/** One receipt's row out of the table markup of one or more pages (already through mainOf). */
const rowOf = (tables, receipt) => tables.split("<tr>").find((r) => r.includes(`>${receipt}</span>`)) ?? "";

/* ── Accounts ──────────────────────────────────────────────────────────── */
async function createAccount(owner, role, password) {
  const { html } = await owner.html("/admin/users.php");
  const r = await owner.post("/admin/users.php", { _csrf: csrfOf(html), action: "save", id: "0", username: USER(role), display_name: `E2E receipts ${role}`, email: "", phone: "", role, password, is_active: "1" });
  if (r.status !== 303) throw new Error(`could not create the ${role} account: status ${r.status}`);
}
async function signInFresh(role, issued, chosen) {
  const s = jar(IP[role]);
  const r = await login(s, USER(role), issued);
  if (r.status !== 302) throw new Error(`${role} could not sign in: ${r.status}`);
  const prof = await s.html("/admin/profile.php");
  const c = await s.post("/admin/profile.php", { _csrf: csrfOf(prof.html), action: "password", current_password: issued, new_password: chosen, confirm_password: chosen });
  if (c.status !== 303) throw new Error(`${role} could not change the issued password: ${c.status}`);
  return s;
}

/* ── Server ────────────────────────────────────────────────────────────── */
let server = null;
let serverLog = "";
async function startServer() {
  const hash = php(["-r", "echo password_hash('Admin@Test123', PASSWORD_BCRYPT, ['cost' => 5]);"]).trim();
  const args = ["-S", `127.0.0.1:${PHP_PORT}`, "router.php"];
  server = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: resolve(REPO, "backend"), env: { ...PHP_ENV, ADMIN_PASS_HASH: hash }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) return false;
    try {
      if ((await fetch(`${BASE}/api/pulse`)).status === 200) return true;
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
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */
const created = []; // every payable made here, for the cleanup check
let seq = 0;
function paid(fx, facts = {}) {
  seq++;
  fixture("apply", {
    order_id: fx.order_id, status: "SUCCESS", actor: "e2e-receipts",
    facts: { verification: "callback", responded: true, gateway_status: "Success", tracking_id: `RC${RUN.toUpperCase()}${pad(seq)}`, bank_ref_no: `BANK${RUN}${pad(seq)}`, payment_mode: "UPI", ...facts },
  });
  const row = fx.type === "donation" ? donation(fx.number) : booking(fx.number);
  fx.receipt = row?.receipt_number ?? null;
  fx.tracking = facts.tracking_id ?? `RC${RUN.toUpperCase()}${pad(seq)}`;
  return fx;
}
function mkDonation(over = {}) {
  const who = over.who ?? "Donor";
  const fx = fixture("create-donation", {
    name: `${PREFIX} ${who}`, phone: "919876543210", phoneCountry: "IN", country: "IN", category: "general", amount: "1001",
    email: `e2e-rcpt-${RUN}-${who.replace(/[^a-z0-9]/gi, "").toLowerCase() || "d"}@example.test`, ip: IP.fixture, acceptTerms: true, lang: "en", ...over,
  });
  created.push(fx);
  return fx;
}
function mkSeva(over = {}) {
  const fx = fixture("create-seva-payable", { devotee_name: `${PREFIX} ${over.who ?? "Devotee"}`, phone: "919876543211", phoneCountry: "IN", seva_id: 1, ip: IP.fixture, acceptTerms: true, lang: "en", ...over });
  created.push(fx);
  return fx;
}
function cleanupRows() {
  fixture("cleanup", { name_prefix: `${PREFIX}`, ips: ALL_IPS });
  sql("DELETE FROM poojas WHERE name_en LIKE ?", [`${PREFIX}%`]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2ercpt_${RUN}_%`]);
  const receipts = created.map((f) => f.receipt).filter(Boolean);
  sql(`DELETE FROM admin_activity WHERE id > ? AND (actor LIKE ? OR subject LIKE ? OR (action = 'receipts_export' AND detail LIKE ?)
        OR (action = 'receipts_resend' AND subject IN (${receipts.length ? receipts.map(() => "?").join(",") : "''"})))`,
    [activityStart, `e2ercpt_${RUN}_%`, `e2ercpt_${RUN}_%`, `%${PREFIX}%`, ...receipts]);
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [BUCKETS_REGEXP]);
}

/* ── Preflight ─────────────────────────────────────────────────────────── */
if (!(await startServer())) {
  console.log(`✗ the PHP server did not start on ${BASE} (PHP_BIN=${PHP_BIN}).\n${serverLog.slice(0, 800)}`);
  stopServer();
  process.exit(1);
}
const cfg = fixture("config", {});
if (!cfg.ready || cfg.mode !== "simulator") {
  console.log(`✗ the server under test is not ready in SIMULATOR mode: ${cfg.reason} (mode ${cfg.mode})`);
  stopServer();
  process.exit(1);
}
const activityStart = Number(one("SELECT COALESCE(MAX(id), 0) AS m FROM admin_activity").m);

const owner = jar(IP.owner);
const anon = jar(IP.anon);
const S = {}; // role sessions
const F = {}; // fixtures by short name
try {
  let r = await login(owner, "admin", "Admin@Test123");
  check(r.status === 302, "the environment admin signs in", `status ${r.status}`);

  /* ── Fixtures ────────────────────────────────────────────────────────── */
  section("fixtures: paid, refunded, unpaid and failed payables");
  sql("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_type, is_active) VALUES (?, ?, ?, 'special', 1)", [`${PREFIX} பௌர்ணமி பூஜை`, `${PREFIX} Pournami Pooja`, POOJA_DATE]);
  const pooja = one("SELECT id, name_ta, name_en FROM poojas WHERE name_en = ?", [`${PREFIX} Pournami Pooja`]);
  const generalCat = one("SELECT name_en, name_ta FROM donation_categories WHERE slug = 'general'");
  const annaCat = one("SELECT name_en, name_ta FROM donation_categories WHERE slug = 'annadanam'");
  const seva1 = one("SELECT id, name_en, name_ta, amount FROM sevas WHERE id = 1");
  const seva2 = one("SELECT id, name_en, name_ta, amount FROM sevas WHERE id = 2");
  check(pooja && generalCat && annaCat && seva1 && seva2 && seva1.name_ta && generalCat.name_ta, "the pooja, categories and sevas the fixtures use exist with Tamil names", JSON.stringify({ pooja, generalCat, seva1 }));

  const GB_PHONE = `4477009${String(Date.now() % 100000).padStart(5, "0")}`;
  F.r1 = paid(mkDonation({ who: "Anbu", amount: "1001", category: "general" }), { bank_ref_no: '=HYPERLINK("http://example.test")' });
  F.r2 = paid(mkDonation({ who: "முருகன்", amount: "2500", category: "annadanam", lang: "ta" }));
  F.r3 = paid(mkDonation({ who: '"><script>alert(1)</script>', amount: "150", email: "" }));
  F.r4 = paid(mkDonation({ who: "Chitra", amount: "25", currency: "USD", country: "GB", phone: GB_PHONE, phoneCountry: "GB" }));
  F.r5 = paid(mkDonation({ who: "Devi", amount: "5000", category: "general", pooja_id: pooja.id }));
  F.r6 = paid(mkDonation({ who: "Ezhil", amount: "800" }));
  sql("UPDATE donations SET paid_at = ? WHERE donation_number = ?", [LAST_MONTH_LATE, F.r6.number]);
  F.r7 = paid(mkDonation({ who: "Fathima", amount: "600" }));
  fixture("refund", { order_id: F.r7.order_id, kind: "full", method: "manual", reason: "E2E receipts: full refund", actor: "e2e-receipts" });
  F.r8 = paid(mkDonation({ who: "Gowri", amount: "1000" }));
  fixture("refund", { order_id: F.r8.order_id, kind: "partial", amount: "250", method: "manual", reason: "E2E receipts: partial refund", actor: "e2e-receipts" });
  F.s1 = paid(mkSeva({ who: "Meena", seva_id: 1, email: `e2e-rcpt-${RUN}-meena@example.test` }));
  F.s2 = paid(mkSeva({ who: "வள்ளி", seva_id: 2, lang: "ta" }));
  F.u1 = mkDonation({ who: "Unpaid", amount: "300" }); // INITIATED: no receipt
  F.f1 = mkDonation({ who: "Failed", amount: "200" });
  fixture("apply", { order_id: F.f1.order_id, status: "FAILED", actor: "e2e-receipts", facts: { verification: "callback", responded: true, gateway_status: "Failure", failure_message: "Declined" } });
  const fillers = [];
  for (let i = 0; i < 17; i++) fillers.push(paid(mkDonation({ who: `Filler ${pad(i + 1)}`, amount: String(10 + i), email: "" })));
  const RECEIPTS = [F.r1, F.r2, F.r3, F.r4, F.r5, F.r6, F.r7, F.r8, F.s1, F.s2, ...fillers];
  const TOTAL = RECEIPTS.length; // 27

  check(RECEIPTS.every((f) => /^[A-Z]{2,8}-\d{4}-\d{6}$/.test(f.receipt ?? "")) && new Set(RECEIPTS.map((f) => f.receipt)).size === TOTAL,
    `${TOTAL} receipts were issued, each with its own number`, RECEIPTS.map((f) => `${f.number}:${f.receipt}`).join(" "));
  check(donation(F.r7.number).status === "REFUNDED" && donation(F.r8.number).status === "PARTIALLY_REFUNDED" && Number(donation(F.r8.number).amount_refunded) === 250
    && donation(F.u1.number).status === "INITIATED" && donation(F.u1.number).receipt_number === null && donation(F.f1.number).status === "FAILED" && donation(F.f1.number).receipt_number === null
    && donation(F.r4.number).currency === "USD" && booking(F.s1.number).payment_status === "SUCCESS",
    "the fixture set is in the intended states", [F.r7, F.r8, F.u1, F.f1].map((f) => `${f.number}:${donation(f.number)?.status}`).join(" "));
  const tokenOf = (number) => fixture("token", { number }).token;
  const q = encodeURIComponent(PREFIX);

  /* ── 1. The list ─────────────────────────────────────────────────────── */
  section("1. the list and its columns");
  let p = await owner.html(`${PAGE}?q=${q}`);
  let p2 = await owner.html(`${PAGE}?q=${q}&page=2`);
  check(p.status === 200 && !BAD.test(p.html) && p2.status === 200 && !BAD.test(p2.html), "the page renders without PHP errors", `status ${p.status}`);
  check(/<h1>Receipts<\/h1>/.test(p.html) && /<span>Finance<\/span>/.test(p.html), "titled Receipts under the Finance breadcrumb");
  check(/href="\/admin\/receipts\.php"[^>]*class="sidebar__link is-active"/.test(p.html) && /Finance<\/span>[\s\S]*receipts\.php/.test(p.html), "the sidebar lists Receipts under Finance and marks it current");
  check(/Payments: SIMULATOR/.test(p.html) && /href="\/admin\/payments\.php\?view=transactions"/.test(p.html), "the header says the payments are simulated and links to Online Payments");
  for (const col of ["Receipt", "Payment", "Donor", "Purpose", "Amount", "Currency", "Status", "Issued (IST)", "Payment reference"]) {
    check(new RegExp(`<th[^>]*>(?:<a[^>]*>)?${col.replace(/[()]/g, "\\$&")}`).test(p.html), `column "${col}"`);
  }
  const shown = new Set([...listedReceipts(p.html), ...listedReceipts(p2.html)]);
  check(RECEIPTS.every((f) => shown.has(f.receipt)), "every issued receipt of the fixture set is listed (two pages)", `${shown.size} shown; missing ${RECEIPTS.filter((f) => !shown.has(f.receipt)).map((f) => f.receipt).join(",")}`);
  check(!p.html.includes(F.u1.number) && !p2.html.includes(F.u1.number) && !p.html.includes(F.f1.number) && !p2.html.includes(F.f1.number), "the unpaid and the failed payment have no receipt and are absent");
  check(countOf(p.html) === TOTAL, `the toolbar counts ${TOTAL} receipts`, countOf(p.html));

  const tables = mainOf(p.html) + mainOf(p2.html); // newest first, so the oldest receipts sit on page 2
  let row = rowOf(tables, F.r1.receipt);
  check(row.includes(`payments.php?number=${F.r1.number}`) && row.includes(`>${F.r1.number}</a>`), "R1: its payment number links to the Online Payments detail");
  check(row.includes(`${PREFIX} Anbu`) && row.includes("919876543210") && row.includes(`e2e-rcpt-${RUN}-anbu@example.test`), "R1: donor name, phone and email");
  check(row.includes(generalCat.name_en) && row.includes(`lang="ta">${generalCat.name_ta}`), "R1: purpose is the category in English and Tamil", row.slice(0, 400));
  check(row.includes(money(1001)) && row.includes("<td>INR</td>") && row.includes(">Paid<"), "R1: amount, currency and the PAID status");
  check(row.includes(TODAY_IST_LABEL) && /<time datetime="[^"]+Z">/.test(row), "R1: issued today (IST) as a <time>");
  check(row.includes(F.r1.tracking) && row.includes("=HYPERLINK(&quot;http://example.test&quot;)") && row.includes(">UPI<"), "R1: tracking id, bank reference (escaped) and payment mode", row.slice(0, 600));
  check(row.includes(`href="${BASE}/payment/receipt?ref=${F.r1.number}&amp;t=${tokenOf(F.r1.number)}"`) && row.includes('target="_blank" rel="noopener"'), "R1: opens the donor's printable receipt link the payments module builds");
  check(row.includes('name="action" value="resend_receipt"') && row.includes(`name="number" value="${F.r1.number}"`), "R1: the owner sees the Resend form");
  check(/>Donation(?: ·|<)/.test(row) && row.includes(">SIMULATOR<"), "R1: kind and the SIMULATOR marker");
  row = rowOf(tables, F.r2.receipt);
  check(row.includes(`${PREFIX} முருகன்`) && row.includes(annaCat.name_en) && row.includes(annaCat.name_ta), "R2: a Tamil donor name and the Annadhanam category round-trip intact");
  row = rowOf(tables, F.r3.receipt);
  check(row.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !p.html.includes("<script>alert(1)</script>"), "R3: a hostile donor name is escaped, never rendered");
  row = rowOf(tables, F.r4.receipt);
  check(row.includes("USD 25.00") && row.includes("<td>USD</td>") && row.includes(GB_PHONE), "R4: a USD receipt shows its own currency");
  row = rowOf(tables, F.r5.receipt);
  check(row.includes(`${generalCat.name_en} · ${pooja.name_en}`) && row.includes(pooja.name_ta), "R5: a pooja donation names the pooja in both scripts", row.slice(0, 500));
  row = rowOf(tables, F.r7.receipt);
  check(row.includes(">Refunded<") && row.includes(`−${money(600)} refunded`), "R7: refunded in full");
  row = rowOf(tables, F.r8.receipt);
  check(row.includes(">Partially refunded<") && row.includes(`−${money(250)} refunded`), "R8: partially refunded");
  row = rowOf(tables, F.s1.receipt);
  check(row.includes(`Seva: ${seva1.name_en}`) && row.includes(`lang="ta">${seva1.name_ta}`) && />Seva booking(?: ·|<)/.test(row) && row.includes(`payments.php?number=${F.s1.number}`) && row.includes(money(seva1.amount)),
    "S1: a seva receipt shows the seva in both scripts, its booking number and the seva's price", row.slice(0, 500));
  row = rowOf(tables, F.s2.receipt);
  check(row.includes(`${PREFIX} வள்ளி`) && row.includes(seva2.name_ta), "S2: a Tamil devotee name on a seva receipt");
  p = await owner.html(PAGE);
  check(p.status === 200 && !BAD.test(p.html) && countOf(p.html) >= TOTAL, "the unfiltered list renders and counts at least this run's receipts", countOf(p.html));

  /* ── 2. Search ───────────────────────────────────────────────────────── */
  section("2. search");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(F.r1.receipt)}`);
  check(countOf(p.html) === 1 && listedReceipts(p.html).join() === F.r1.receipt, "by receipt number → exactly that receipt", listedReceipts(p.html).join());
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(F.s1.number)}`);
  check(countOf(p.html) === 1 && listedReceipts(p.html).join() === F.s1.receipt, "by booking number → exactly that receipt");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(`${PREFIX} Anbu`)}`);
  check(countOf(p.html) === 1 && listedReceipts(p.html).join() === F.r1.receipt, "by donor name → exactly that receipt");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(`${PREFIX} முருகன்`)}`);
  check(countOf(p.html) === 1 && listedReceipts(p.html).join() === F.r2.receipt, "by a Tamil donor name → exactly that receipt");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent("+44 " + GB_PHONE.slice(2))}`);
  check(countOf(p.html) === 1 && listedReceipts(p.html).join() === F.r4.receipt, "by phone (digits only are matched) → exactly that receipt", listedReceipts(p.html).join());
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(`${PREFIX} nobody-here`)}`);
  check(countOf(p.html) === 0 && p.html.includes("No receipts match these filters"), "no match → the empty state with a Clear filters link");

  /* ── 3. Filters ──────────────────────────────────────────────────────── */
  section("3. filters");
  const has = (html, f) => listedReceipts(html).includes(f.receipt);
  p = await owner.html(`${PAGE}?q=${q}&month=${PREV_MONTH}`);
  check(countOf(p.html) === 1 && has(p.html, F.r6) && !has(p.html, F.r1), `month=${PREV_MONTH} → only the receipt issued last month`, listedReceipts(p.html).join());
  p = await owner.html(`${PAGE}?q=${q}&month=${THIS_MONTH}`);
  p2 = await owner.html(`${PAGE}?q=${q}&month=${THIS_MONTH}&page=2`);
  // Each page is read on its own: listedReceipts() looks inside one page's <main>.
  const onEither = (f) => has(p.html, f) || has(p2.html, f);
  check(countOf(p.html) === TOTAL - 1 && onEither(F.r1) && !onEither(F.r6), `month=${THIS_MONTH} → every other receipt`,
    `count ${countOf(p.html)} of ${TOTAL - 1}; R1 ${F.r1.receipt} ${onEither(F.r1) ? "listed" : "missing"}; R6 ${F.r6.receipt} ${onEither(F.r6) ? "listed" : "absent"}; page 1: ${listedReceipts(p.html).length} rows, page 2: ${listedReceipts(p2.html).length} rows`);
  p = await owner.html(`${PAGE}?q=${q}&type=seva_booking`);
  check(countOf(p.html) === 2 && has(p.html, F.s1) && has(p.html, F.s2) && !has(p.html, F.r1), "type=seva_booking → the two seva receipts");
  p = await owner.html(`${PAGE}?q=${q}&type=donation`);
  check(countOf(p.html) === TOTAL - 2 && has(p.html, F.r1) && !has(p.html, F.s1), "type=donation → the donation receipts");
  p = await owner.html(`${PAGE}?q=${q}&status=REFUNDED`);
  check(countOf(p.html) === 1 && has(p.html, F.r7), "status=REFUNDED → the refunded receipt only");
  p = await owner.html(`${PAGE}?q=${q}&status=PARTIALLY_REFUNDED`);
  check(countOf(p.html) === 1 && has(p.html, F.r8), "status=PARTIALLY_REFUNDED → the partially refunded receipt only");
  p = await owner.html(`${PAGE}?q=${q}&status=PAID`);
  check(countOf(p.html) === TOTAL - 2 && has(p.html, F.r1) && !has(p.html, F.r7) && !has(p.html, F.r8), "status=PAID → every receipt whose money is still here");
  p = await owner.html(`${PAGE}?q=${q}&status=REFUND_INITIATED`);
  check(countOf(p.html) === 0, "status=REFUND_INITIATED → none of these");
  p = await owner.html(`${PAGE}?q=${q}&type=donation&status=PAID&month=${THIS_MONTH}`);
  check(countOf(p.html) === TOTAL - 5 && !has(p.html, F.s1) && !has(p.html, F.r6) && !has(p.html, F.r7), "the filters combine", countOf(p.html));
  p = await owner.html(`${PAGE}?q=${encodeURIComponent('"><script>alert(1)</script>')}&status[]=x&type=<x>&month=9999-99&sort=<b>&dir=up&page=99999999999&export[]=csv`);
  check(p.status === 200 && !BAD.test(p.html) && !p.html.includes("<script>alert(1)</script>") && p.html.includes('value="&quot;&gt;&lt;script&gt;'), "hostile filters are ignored and the search term is escaped", `status ${p.status}`);

  /* ── 4. Pagination and sorting ───────────────────────────────────────── */
  section("4. pagination and sorting");
  p = await owner.html(`${PAGE}?q=${q}`);
  p2 = await owner.html(`${PAGE}?q=${q}&page=2`);
  const page1 = listedReceipts(p.html);
  const page2 = listedReceipts(p2.html);
  check(page1.length === 25 && page2.length === TOTAL - 25 && new Set([...page1, ...page2]).size === TOTAL, "25 receipts on page 1, the rest on page 2, no overlap", `${page1.length} + ${page2.length}`);
  check(p.html.includes(`Showing 1–25 of ${TOTAL}`) && p2.html.includes(`Showing 26–${TOTAL} of ${TOTAL}`) && /aria-label="Next page"/.test(p.html), "the pagination bar says where you are");
  const dates1 = [...mainOf(p.html).matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]);
  check(dates1.length === 25 && dates1.every((d, i) => i === 0 || d <= dates1[i - 1]), "newest receipt first by default", dates1.slice(0, 3).join());
  p = await owner.html(`${PAGE}?q=${q}&sort=amount&dir=asc`);
  let a = amountsOf(p.html);
  check(a.length === 25 && a.every((v, i) => i === 0 || v >= a[i - 1]), "sort by amount ascending", a.join());
  p = await owner.html(`${PAGE}?q=${q}&sort=receipt&dir=desc`);
  const rc = listedReceipts(p.html);
  check(rc.length === 25 && rc.every((v, i) => i === 0 || v <= rc[i - 1]), "sort by receipt number descending", rc.slice(0, 3).join());

  /* ── 5. Totals ───────────────────────────────────────────────────────── */
  section("5. totals for the filtered set against independent SQL");
  const sums = (where = "", params = []) => rows(`SELECT currency, COUNT(*) AS n, SUM(amount) AS gross, SUM(amount_refunded) AS refunded FROM (
      SELECT amount, amount_refunded, currency, status, receipt_number, paid_at, 'donation' AS kind FROM donations WHERE source = 'online' AND name LIKE ? AND receipt_number IS NOT NULL
      UNION ALL SELECT amount, amount_refunded, COALESCE(currency, 'INR'), payment_status, receipt_number, paid_at, 'seva_booking' FROM seva_bookings WHERE payment_mode = 'online' AND devotee_name LIKE ? AND receipt_number IS NOT NULL) x ${where} GROUP BY currency`, [`${PREFIX}%`, `${PREFIX}%`, ...params]);
  let t = sums();
  let inr = t.find((x) => x.currency === "INR");
  let usd = t.find((x) => x.currency === "USD");
  p = await owner.html(`${PAGE}?q=${q}`);
  check(Number(kpi(p.html, "Receipts")) === TOTAL && Number(inr.n) + Number(usd.n) === TOTAL, `Receipts = ${TOTAL}`, kpi(p.html, "Receipts"));
  check(kpi(p.html, "Amount (₹)") === kpiMoney(inr.gross) && kpiSub(p.html, "Amount (₹)") === `${inr.n} in rupees · also USD ${Number(usd.gross).toFixed(2)}`, "Amount (₹) is the rupee sum, with the USD receipt listed beside it", `${kpi(p.html, "Amount (₹)")} / ${kpiSub(p.html, "Amount (₹)")}`);
  check(kpi(p.html, "Refunded (₹)") === kpiMoney(inr.refunded) && Number(inr.refunded) === 850, "Refunded (₹) is the sum of the refunds (600 + 250)", kpi(p.html, "Refunded (₹)"));
  check(kpi(p.html, "Net (₹)") === kpiMoney(Number(inr.gross) - Number(inr.refunded)), "Net (₹) = amount − refunded", kpi(p.html, "Net (₹)"));
  t = sums("WHERE x.status = 'REFUNDED'");
  p = await owner.html(`${PAGE}?q=${q}&status=REFUNDED`);
  check(Number(kpi(p.html, "Receipts")) === 1 && kpi(p.html, "Amount (₹)") === kpiMoney(t[0].gross) && kpi(p.html, "Refunded (₹)") === kpiMoney(600) && kpi(p.html, "Net (₹)") === kpiMoney(0), "totals follow the filter (refunded set: ₹600 in, ₹600 back, net ₹0)");
  t = sums("WHERE x.kind = 'seva_booking'");
  p = await owner.html(`${PAGE}?q=${q}&type=seva_booking`);
  check(Number(kpi(p.html, "Receipts")) === 2 && kpi(p.html, "Amount (₹)") === kpiMoney(t[0].gross) && kpiSub(p.html, "Amount (₹)") === "2 in rupees", "totals for the seva receipts", `${kpi(p.html, "Amount (₹)")} vs ${t[0].gross}`);

  /* ── 6. CSV export ───────────────────────────────────────────────────── */
  section("6. CSV export");
  r = await owner.get(`${PAGE}?export=csv&q=${q}`);
  const csvBytes = Buffer.from(await r.arrayBuffer());
  const csv = csvBytes.toString("utf8");
  const lines = csv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  check(r.status === 200 && /text\/csv/.test(r.headers.get("content-type") || "") && /receipts-\d{4}-\d{2}-\d{2}\.csv/.test(r.headers.get("content-disposition") || "") && csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
    "answers text/csv with a BOM and a dated filename", `${r.status} ${r.headers.get("content-type")}`);
  check(lines[0] === "receipt_number,kind,number,donor_name,phone,email,purpose,purpose_ta,amount,currency,status,issued_at_ist,tracking_id,bank_ref_no,payment_mode,amount_refunded,environment", "the header row", lines[0]);
  check(lines.length === TOTAL + 1 && RECEIPTS.every((f) => lines.some((l) => l.startsWith(f.receipt + ","))), `${TOTAL} rows, one per receipt`, `${lines.length - 1} rows`);
  // A cell as PHP's fputcsv writes it: enclosed when it holds a comma, a quote, a space or a line break.
  const cell = (v) => (/[",\r\n\t ]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const r1csv = lines.find((l) => l.startsWith(F.r1.receipt + ","));
  check(Boolean(r1csv) && r1csv.includes(`,donation,${F.r1.number},`) && r1csv.includes(`"'=HYPERLINK(""http://example.test"")"`) && r1csv.includes("919876543210") && r1csv.includes(`e2e-rcpt-${RUN}-anbu@example.test`)
    && r1csv.includes(`,${cell(generalCat.name_en)},${cell(generalCat.name_ta)},1001.00,INR,PAID,`) && r1csv.includes(F.r1.tracking) && r1csv.includes(",UPI,0.00,simulator"),
    "R1's row: formula cell neutralised; purpose in both scripts; amount, PAID, tracking id, mode, environment", r1csv);
  const r7csv = lines.find((l) => l.startsWith(F.r7.receipt + ","));
  const r3csv = lines.find((l) => l.startsWith(F.r3.receipt + ","));
  const s1csv = lines.find((l) => l.startsWith(F.s1.receipt + ","));
  check(Boolean(r7csv) && r7csv.includes(",600.00,INR,REFUNDED,") && r7csv.includes(",600.00,simulator"), "R7's row carries REFUNDED and the refunded amount", r7csv);
  check(Boolean(r3csv) && r3csv.includes(`,${cell(`${PREFIX} "><script>alert(1)</script>`)},`), "a quoted hostile name is a plain CSV cell", r3csv);
  check(Boolean(s1csv) && s1csv.includes(`,seva_booking,${F.s1.number},`) && s1csv.includes(`,${cell(`Seva: ${seva1.name_en}`)},${cell(seva1.name_ta)},`), "S1's row names the seva in both scripts", s1csv);
  check(!csv.includes(F.u1.number) && !csv.includes(F.f1.number), "unpaid and failed payments are not exported");
  let exports = activity("receipts_export");
  check(exports.some((x) => x.subject === "receipts.csv" && x.actor === "admin" && x.detail.startsWith(`${TOTAL} rows`) && x.detail.includes(`q=${PREFIX}`)), "the export is audited as receipts_export with the row count and filters", JSON.stringify(exports.slice(-1)));
  r = await owner.get(`${PAGE}?export=csv&q=${q}&status=REFUNDED`);
  const filtered = (await r.text()).replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  check(filtered.length === 2 && filtered[1].startsWith(F.r7.receipt + ","), "a filtered export holds only the filtered rows", `${filtered.length - 1} rows`);

  /* ── 7. Resend receipt ───────────────────────────────────────────────── */
  section("7. Resend receipt through the payments module");
  p = await owner.html(`${PAGE}?q=${q}`);
  const ownerCsrf = csrfOf(p.html);
  let res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: F.r1.number }, { referer: `${BASE}${PAGE}?q=${q}&status=PAID` });
  check(res.status === 303 && res.location === `${PAGE}?q=${q}&status=PAID`, "POST redirects back to the filtered list it came from", `${res.status} ${res.location}`);
  check(res.flash === `Receipt ${F.r1.receipt} (send 1): queued for email.`, "the flash says the receipt was queued for email", res.flash);
  let notes = notesFor(F.r1.number);
  check(notes.length === 1 && notes[0].event === "donation.paid" && notes[0].dedupe_key === `receipt:${F.r1.number}:resend:1` && notes[0].to_email === `e2e-rcpt-${RUN}-anbu@example.test`, "one notification row: donation.paid, resend 1, to the donor's email", JSON.stringify(notes));
  let deliveries = notes.length ? deliveriesOf(notes[0].id) : [];
  check(deliveries.length === 1 && deliveries[0].channel === "email" && ["queued", "sending", "sent", "delivered"].includes(deliveries[0].status), "an email delivery through the test driver", JSON.stringify(deliveries));
  const events = auditEvents(F.r1.order_id);
  check(events.includes("notification_queued") && events.includes("receipt_emailed"), "the payment's own audit trail records the queue and the email", events.join());
  let resends = activity("receipts_resend");
  check(resends.some((x) => x.subject === F.r1.receipt && x.actor === "admin" && x.detail.includes(`${F.r1.number}: send 1`) && x.detail.includes("email")), "the resend is in the activity log as receipts_resend against the receipt number", JSON.stringify(resends));
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: F.r1.number });
  check(res.status === 303 && res.flash === `Receipt ${F.r1.receipt} (send 2): queued for email.` && notesFor(F.r1.number).length === 2, "a second resend is send 2", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: F.s1.number });
  check(res.status === 303 && res.flash === `Receipt ${F.s1.receipt} (send 1): queued for email.` && notesFor(F.s1.number).length === 1 && notesFor(F.s1.number)[0].event === "payment.succeeded", "a seva receipt resends as payment.succeeded", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: F.s2.number });
  check(res.status === 303 && res.flash === `Receipt ${F.s2.receipt} (send 1): no channel could take it. Skipped: email (no email).` && /alert--warning/.test(res.html), "a devotee without an email: the warning says the email was skipped", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: F.u1.number });
  check(res.status === 303 && /No receipt has been issued/.test(res.flash) && notesFor(F.u1.number).length === 0, "an unpaid payment has no receipt to send", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: "DON-20990101-00000001" });
  check(res.status === 303 && /no longer exists/.test(res.flash), "an unknown number is refused", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: `${F.r1.number}'); DROP TABLE donations;--` });
  check(res.status === 303 && /no longer exists/.test(res.flash) && donation(F.r1.number) !== null, "a hostile number is refused, and nothing happened to the table", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "delete_everything", number: F.r1.number });
  check(res.status === 303 && /not available on this page/.test(res.flash), "an unknown action is refused", res.flash);
  res = await act(owner, { _csrf: ownerCsrf, action: "resend_receipt", number: F.r1.number }, { referer: "http://evil.example/admin/receipts.php?q=x" });
  check(res.status === 303 && res.location === PAGE, "a foreign referer never becomes the redirect target", res.location);

  /* ── 8. Roles and CSRF ───────────────────────────────────────────────── */
  section("8. roles and CSRF");
  r = await anon.get(PAGE);
  check(r.status === 302 && /login\.php/.test(r.headers.get("location") || ""), "E2E-045 no session → the login page", `status ${r.status}`);
  const r1Before = notesFor(F.r1.number).length;
  r = await anon.post(PAGE, { _csrf: "x", action: "resend_receipt", number: F.r1.number });
  check(r.status === 302 && notesFor(F.r1.number).length === r1Before, "E2E-045 an anonymous POST is redirected and sends nothing", `status ${r.status}`);
  await createAccount(owner, "admin", "Gopuram77Tem");
  await createAccount(owner, "editor", "Kolam99Deep");
  await createAccount(owner, "finance", "Deepam55Fin");
  await createAccount(owner, "viewer", "ViewOnly123X");
  S.admin = await signInFresh("admin", "Gopuram77Tem", "Mandapam91Ad");
  S.editor = await signInFresh("editor", "Kolam99Deep", "Vilakku42Raja");
  S.finance = await signInFresh("finance", "Deepam55Fin", "Prasadam63Fx");
  S.viewer = await signInFresh("viewer", "ViewOnly123X", "QuietWatch42B");
  check(Object.values(S).length === 4, "an admin, an editor, a finance admin and a viewer are signed in");
  // The page reads with payments.view and writes with payments.manage — the
  // same policy as Admin → Online Payments, which shows these receipts too
  // (roles.php: payments.view for every role, payments.manage for all but the viewer).
  const got = [];
  for (const role of ["admin", "editor", "finance", "viewer"]) got.push((await S[role].get(PAGE)).status);
  check(got.join("/") === "200/200/200/200", "E2E-013 GET → admin/editor/finance/viewer 200/200/200/200 (payments.view)", got.join("/"));
  const vp = await S.viewer.html(`${PAGE}?q=${q}`);
  check(vp.status === 200 && !BAD.test(vp.html) && listedReceipts(vp.html).length === 25 && !vp.html.includes('name="action" value="resend_receipt"'), "the viewer reads the list but sees no Resend form");
  r = await S.viewer.get(`${PAGE}?export=csv&q=${q}`);
  check(r.status === 200 && /text\/csv/.test(r.headers.get("content-type") || "") && (await r.text()).split(/\r?\n/).filter(Boolean).length === TOTAL + 1, "the viewer may export (export capability)");
  r = await S.viewer.post(PAGE, { _csrf: csrfOf(vp.html), action: "resend_receipt", number: F.r1.number });
  check(r.status === 403 && /do not have access/i.test(await r.text()) && notesFor(F.r1.number).length === r1Before, "E2E-046 the viewer's POST is refused server-side and sends nothing", `status ${r.status}`);
  for (const role of ["admin", "editor", "finance"]) {
    const page = await S[role].html(`${PAGE}?q=${q}`);
    res = await act(S[role], { _csrf: csrfOf(page.html), action: "resend_receipt", number: F.r2.number });
    check(res.status === 303 && /queued for email/.test(res.flash) && activity("receipts_resend").some((x) => x.actor === USER(role) && x.subject === F.r2.receipt), `E2E-046 the ${role} resends (payments.manage) and is named in the activity log`, res.flash);
  }
  check(notesFor(F.r2.number).length === 3, "three resends of R2, one per role", notesFor(F.r2.number).length);
  const before = notesFor(F.r1.number).length;
  res = await act(owner, { _csrf: "forged-token", action: "resend_receipt", number: F.r1.number });
  check(res.status === 303 && /tampered/.test(res.flash) && notesFor(F.r1.number).length === before, "E2E-049 a forged CSRF token is refused and sends nothing", res.flash);
  res = await act(owner, { action: "resend_receipt", number: F.r1.number });
  check(res.status === 303 && /tampered/.test(res.flash) && notesFor(F.r1.number).length === before, "E2E-049 a missing CSRF token is refused too", res.flash);
  const dash = await owner.html("/admin/");
  check(dash.html.includes('href="/admin/receipts.php"') && dash.html.includes("Export receipts CSV"), "the dashboard sidebar and the command palette know the page");
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try {
    cleanupRows();
    const left = one(`SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?)
      + (SELECT COUNT(*) FROM payment_transactions WHERE order_id IN (${created.length ? created.map(() => "?").join(",") : "''"}))
      + (SELECT COUNT(*) FROM poojas WHERE name_en LIKE ?) + (SELECT COUNT(*) FROM admin_users WHERE username LIKE ?)
      + (SELECT COUNT(*) FROM rate_limits WHERE bucket REGEXP ?) AS c`,
      [`${PREFIX}%`, `${PREFIX}%`, ...created.map((f) => f.order_id), `${PREFIX}%`, `e2ercpt_${RUN}_%`, BUCKETS_REGEXP]);
    check(Number(left.c) === 0, "every fixture is removed afterwards", `left ${left?.c}`);
  } catch (e) {
    check(false, "cleanup ran", e.stack || String(e));
  }
  stopServer();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
