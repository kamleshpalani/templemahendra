#!/usr/bin/env node
/**
 * tests/payments-api.mjs — the public payments API end to end, in TEST mode,
 * against a PHP server this suite starts and a stand-in for CCAvenue it runs
 * itself (docs/payments/SPEC.md §12, suite 2).
 *
 *   PHP_BIN=/path/to/php.sh node tests/payments-api.mjs
 *
 * Ports: PHP on 8061, the CCAvenue mock on 8071 (both must be free; exit 2
 * otherwise). The PHP server gets fake TEST credentials, the mock's URLs, a
 * settings overlay (mode test, seva payments on, INR + USD) and the test
 * notification drivers, so nothing here touches the shared payment_settings
 * rows or a real gateway. Requests carry X-Forwarded-For 10.83.0.1–99.
 *
 * What it proves:
 *   1. /config: the exact shape, and never a merchant id, access code or key;
 *   2. creating a donation: 405, the 422 field matrix and hostile bodies, the
 *      honeypot, the two flood limits, no cookies, 503 when payments are off;
 *   3. what a create stores before the browser leaves (INITIATED rows, audit,
 *      redirected_at) and what the encRequest carries: the §4.3 fields in
 *      order, with the server's own amount and currency;
 *   4. the browser return: Success → SUCCESS, receipt number, one donation.paid,
 *      status-API confirmation recorded; a replay changes nothing but counters;
 *      the notify channel; Failure → FAILED with an email-only message; Abort
 *      and cancel_url → CANCELLED with no message; Awaited → PENDING until the
 *      sweep confirms it; a tampered amount, currency or merchant_param2 and a
 *      response under the wrong environment's key are never SUCCESS;
 *   5. hostile returns (unknown order, garbage, oversize, GET) redirect and
 *      never answer 500; the status API being unreachable during a callback;
 *   6. retries: 409 once paid, -R2 order ids, five attempts at most;
 *   7. status, receipt, receipt-email and verify: the token is required, another
 *      number's token is a 404, a missing email is saved, verify masks or
 *      anonymises the donor;
 *   8. seva payables: the price comes from the database, a zero-price or
 *      inactive seva is refused, an expired hold cancels the booking and a late
 *      success restores it;
 *   9. /api/donors lists only paid online donations; POST /api/donations and
 *      /api/seva-bookings keep their contracts;
 *  10. the working key and access code appear in no JSON, HTML, database row or
 *      log the site writes.
 *
 * Creates rows named "E2E-PAY-API-<run> …" (donations, bookings, two sevas) with
 * their attempts, audit rows and notifications, and removes them, the audit rows
 * its hostile posts left, and its rate_limits buckets at the end. The receipt
 * numbers it takes are given back when nobody else issued one meanwhile.
 */

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { startCcavenueMock, portInUse } from "./support/ccavenue_mock.mjs";
import { ccavDecrypt, ccavParse, ccavEncrypt, ccavBuild } from "./support/ccavenue_crypto.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const PORT = { php: 8061, mock: 8071 };
const BASE = `http://127.0.0.1:${PORT.php}`;
const RUN = Date.now().toString(36);
const PREFIX = "E2E-PAY-API";
const NAME = `${PREFIX}-${RUN}`;
const EMAIL = `e2e-pay-api-${RUN}`;
const PHONE = "919876543210";
// Fake credentials for this run. Nothing here is a secret.
const KEYS = {
  merchantId: "9081726",
  accessCode: `E2EPAYAPI${RUN.toUpperCase()}ACCESS`,
  workingKey: `e2e-pay-api-working-key-${RUN}-not-secret`,
  simulatorKey: "simulator-working-key-not-secret",
};
const OVERLAY = { enabled: "1", mode: "test", seva_online_enabled: "1", international_enabled: "1", currencies: "INR,USD", default_currency: "INR", notify_email: "1", notify_whatsapp: "1", notify_sms: "0", hold_minutes: "30", receipt_prefix: "TMR" };
const ENV = {
  PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify(OVERLAY),
  PAYMENTS_SECRET: `e2e-pay-api-fake-secret-${RUN}-0123456789abcdef`,
  PAYMENTS_SETTINGS_KEY: Buffer.from(`e2e-pay-api-settings-${RUN}`.padEnd(32, "k").slice(0, 32)).toString("base64"),
  CCAVENUE_TEST_MERCHANT_ID: KEYS.merchantId,
  CCAVENUE_TEST_ACCESS_CODE: KEYS.accessCode,
  CCAVENUE_TEST_WORKING_KEY: KEYS.workingKey,
  CCAVENUE_TRANSACTION_URL: `http://127.0.0.1:${PORT.mock}/transaction/transaction.do?command=initiateTransaction`,
  CCAVENUE_API_URL: `http://127.0.0.1:${PORT.mock}/apis/servlet/DoWebTrans`,
  SITE_URL: BASE,
  TRUSTED_PROXIES: "127.0.0.1,::1",
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "test",
  NOTIFY_SMS_DRIVER: "test",
};
// Addresses: lanes 10.83.0.1–69 for creates and retries, fixed ones above.
const IP = { flood: "10.83.0.90", floodOther: "10.83.0.91", floodCount: "10.83.0.92", honey: "10.83.0.93", methods: "10.83.0.94", lookup: "10.83.0.95", receiptEmail: "10.83.0.96", gateway: "10.83.0.97", legacy: "10.83.0.98", off: "10.83.0.99" };
const BUCKETS_REGEXP = ":10[.]83[.]0[.]([1-9]|[1-9][0-9])$";
const usedIps = new Set(Object.values(IP));

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, 600) ?? String(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keysOf = (o) => JSON.stringify(Object.keys(o ?? {}));
const istNow = () => new Date(Date.now() + 5.5 * 3600 * 1000);
const istYmd = () => istNow().toISOString().slice(0, 10);
const istYear = String(istNow().getUTCFullYear());
const istTomorrow = () => new Date(istNow().getTime() + 86400 * 1000).toISOString().slice(0, 10);

/* ── PHP processes ─────────────────────────────────────────────────────── */
// The caller's shell must not leak provider or gateway settings into the server
// or the fixtures; every process gets exactly this run's environment.
const STRIP = /^(NOTIFY_|PAYMENTS_|CCAVENUE_|WHATSAPP_|TWILIO_|MSG91_|MAIL_|SMTP_|SITE_URL$|TRUSTED_PROXIES$)/i;
function phpEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return { ...env, ...ENV, ...extra };
}
function phpCommand(args) {
  const viaBash = /\.sh$/i.test(PHP_BIN);
  return viaBash ? ["bash", [PHP_BIN, ...args]] : [PHP_BIN, args];
}
const phpNoise = [];
function notePhpNoise(label, text) {
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(text);
  if (m) phpNoise.push(`${label}: ${m[0]}`);
}
/** One fixture command; the JSON argument travels on stdin, so nothing is quoted for a shell. */
function fixture(command, args = {}, env = {}) {
  const [cmd, argv] = phpCommand(["tests/support/payments_fixtures.php", command, "-"]);
  const r = spawnSync(cmd, argv, { cwd: ROOT, input: JSON.stringify(args), encoding: "utf8", env: phpEnv(env), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  notePhpNoise(`fixture ${command}`, `${r.stdout}\n${r.stderr}`);
  const last = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let json = null;
  try { json = JSON.parse(last); } catch { /* reported below */ }
  if (!json) throw new Error(`fixture ${command} printed no JSON (exit ${r.status}): ${(r.stdout ?? "").slice(0, 300)} ${(r.stderr ?? "").slice(0, 300)}`);
  if (json.error) throw new Error(`fixture ${command}: ${json.error}${json.fields ? " " + JSON.stringify(json.fields) : ""}`);
  return json;
}
const sql = (query, params = []) => fixture("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;
const txn = (orderId) => one("SELECT * FROM payment_transactions WHERE order_id = ?", [orderId]);
const don = (number) => one("SELECT * FROM donations WHERE donation_number = ?", [number]);
const booking = (number) => one("SELECT * FROM seva_bookings WHERE order_number = ?", [number]);
const audits = (transactionId) => rows("SELECT event FROM payment_audit_log WHERE transaction_id = ? ORDER BY id", [transactionId]).map((r) => r.event);
const payableAudits = (type, id) => rows("SELECT event FROM payment_audit_log WHERE payable_type = ? AND payable_id = ? ORDER BY id", [type, id]).map((r) => r.event);
const notes = (type, id) => rows("SELECT id, event, dedupe_key, to_email, to_phone, cta_url FROM notifications WHERE entity_type = ? AND entity_id = ? ORDER BY id", [type, id]);
const channelsOf = (notificationId) => rows("SELECT channel FROM notification_deliveries WHERE notification_id = ? AND channel IN ('email','whatsapp','sms') ORDER BY channel", [notificationId]).map((r) => r.channel).join(",");
const hits = (bucket, ip) => one("SELECT hits FROM rate_limits WHERE bucket = ?", [`${bucket}:${ip}`])?.hits;

/**
 * Run PHP without blocking the event loop: a sweep asks the status API, and the
 * mock that answers it lives in this process.
 */
function runPhpAsync(args, input = "") {
  const [cmd, argv] = phpCommand(args);
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: String(err) });
    });
    child.stdin.end(input);
  });
}
const lastJson = (r) => {
  try { return JSON.parse((r.stdout ?? "").trim().split(/\r?\n/).pop() ?? ""); } catch { return { error: `${r.stdout} ${r.stderr}`.slice(0, 400) }; }
};
/** payReconcileSweep() through the fixture, for the order ids given. */
async function sweep(args) {
  const r = await runPhpAsync(["tests/support/payments_fixtures.php", "sweep", "-"], JSON.stringify(args));
  notePhpNoise("fixture sweep", `${r.stdout}\n${r.stderr}`);
  const json = lastJson(r);
  return json.sweep ?? json;
}
/** The CLI sweep (backend/bin/payments_cron.php --json), parsed. */
async function cliSweep(orderIds) {
  const r = await runPhpAsync(["backend/bin/payments_cron.php", `--order-ids=${orderIds.join(",")}`, "--json"]);
  notePhpNoise("payments_cron", `${r.stdout}\n${r.stderr}`);
  return lastJson(r);
}

/* ── The PHP server ────────────────────────────────────────────────────── */
let server = null;
function startPhpServer(extraEnv = {}) {
  const [cmd, argv] = phpCommand(["-S", `127.0.0.1:${PORT.php}`, "-t", "backend", "backend/router.php"]);
  const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(extraEnv), windowsHide: true });
  const s = { child, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (s.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (s.log += d));
  return s;
}
async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/pulse`);
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  return false;
}
async function stopPhpServer(s) {
  if (!s) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(s.child.pid), "/T", "/F"], { windowsHide: true });
  else s.child.kill("SIGTERM");
  for (let i = 0; i < 20 && (await portInUse(PORT.php)); i += 1) await sleep(250);
  if ((await portInUse(PORT.php)) && process.platform === "win32") {
    // The port is this suite's own; whatever still holds it is our server.
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === `127.0.0.1:${PORT.php}` && cols[3] === "LISTENING") spawnSync("taskkill", ["/pid", cols[4], "/T", "/F"], { windowsHide: true });
    }
    for (let i = 0; i < 20 && (await portInUse(PORT.php)); i += 1) await sleep(250);
  }
}
let serverLogs = "";
async function restartServer(extraEnv = {}) {
  if (server) {
    serverLogs += server.log;
    await stopPhpServer(server);
  }
  server = startPhpServer(extraEnv);
  return waitForServer();
}

/* ── HTTP ──────────────────────────────────────────────────────────────── */
// Lanes: each address makes at most 14 attempts and 6 creates, inside the
// 20-attempt / 8-created limits, before the next lane is used.
let laneN = 0;
let laneAttempts = 0;
let laneCreates = 0;
function laneIp() {
  if (laneN === 0 || laneAttempts >= 14 || laneCreates >= 6) {
    laneN += 1;
    laneAttempts = 0;
    laneCreates = 0;
    if (laneN > 69) throw new Error("the suite ran out of lane addresses");
  }
  laneAttempts += 1;
  const ip = `10.83.0.${laneN}`;
  usedIps.add(ip);
  return ip;
}
const cookies = [];
const serverErrors = [];
const bodies = [];
async function http(method, path, { json, form, ip, headers = {}, lane = false } = {}) {
  const xff = ip ?? (lane ? laneIp() : IP.lookup);
  const h = { "X-Forwarded-For": xff, ...headers };
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = typeof json === "string" ? json : JSON.stringify(json);
  }
  if (form !== undefined) {
    h["content-type"] = "application/x-www-form-urlencoded";
    body = typeof form === "string" ? form : new URLSearchParams(form).toString();
  }
  const url = path.startsWith("http") ? path : BASE + path;
  const res = await fetch(url, { method, headers: h, body, redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (url.startsWith(BASE)) {
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookies.push(`${method} ${path} → ${res.status}: ${setCookie}`);
    // 503 is a deliberate answer (payments switched off); anything else in the 5xx range is a failure.
    if (res.status >= 500 && res.status !== 503) serverErrors.push(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    bodies.push(text);
    if (lane && res.status === 201 && data?.number) laneCreates += 1;
  }
  return { status: res.status, headers: res.headers, text, data, ip: xff };
}
const noStore = (r) => (r.headers.get("cache-control") ?? "").includes("no-store");
const is429 = (r) => {
  const ra = Number(r.headers.get("retry-after"));
  return r.status === 429 && Number.isInteger(ra) && ra > 0
    && r.data?.error === "Too many requests. Please try again later." && r.data?.code === "rate_limited" && r.data?.retryAfter === ra;
};
const isNotFound = (r) => r.status === 404 && r.data?.error === "Not found" && r.data?.code === "not_found";

/* ── Payables ──────────────────────────────────────────────────────────── */
const slug = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const donation = (label, over = {}) => ({
  category: "general", amount: "1001", currency: "INR", name: `${NAME} ${label}`, phone: PHONE, phoneCountry: "IN", country: "IN",
  email: `${EMAIL}-${slug(label)}@example.test`, address: "12 Middle Street", city: "Pudupatti", state: "Tamil Nadu", postcode: "627719",
  message: "E2E payments API", showNamePublicly: false, lang: "en", acceptTerms: true, hp_token: "", ...over,
});
const without = (obj, ...keys) => {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
};
const create = (body, opts = {}) => http("POST", "/api/payments/donations", { json: body, lane: true, ...opts });
const createSeva = (body, opts = {}) => http("POST", "/api/payments/seva-bookings", { json: body, lane: true, ...opts });
const retry = (number, token, opts = {}) => http("POST", "/api/payments/retry", { json: { number, token }, lane: true, ...opts });
const status = (number, token) => http("GET", `/api/payments/status?ref=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`, { ip: IP.lookup });
const receipt = (number, token) => http("GET", `/api/payments/receipt?ref=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`, { ip: IP.lookup });
const verify = (r, v) => http("GET", `/api/payments/verify?r=${encodeURIComponent(r)}&v=${encodeURIComponent(v)}`, { ip: IP.lookup });
const gatewayPost = (channel, form) => http("POST", `/api/payments/ccavenue/${channel}`, { form, ip: IP.gateway });
const resultUrl = (number, token) => `${BASE}/payment/result?ref=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`;
const decryptRequest = (created) => ccavParse(ccavDecrypt(created.data?.gateway?.fields?.encRequest ?? "", KEYS.workingKey) ?? "");

async function expectField(label, body, key, opts = {}) {
  const r = await create(body, opts);
  const ok = r.status === 422 && r.data?.error === "Please check the highlighted fields."
    && r.data?.fields && Object.prototype.hasOwnProperty.call(r.data.fields, key)
    && typeof r.data.fields[key] === "string" && r.data.fields[key].length > 0;
  check(ok, `${label} → 422 with "${key}"`, `${r.status} ${r.text.slice(0, 400)}`);
  return r;
}

/* ── The CCAvenue mock, driven like a browser ──────────────────────────── */
let mock = null;
const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function parseMockForms(html) {
  const forms = {};
  for (const m of html.matchAll(/<form method="post" action="([^"]+)">([\s\S]*?)<\/form>/g)) {
    const fields = {};
    for (const i of m[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[i[1]] = unescapeHtml(i[2]);
    const kind = /data-mock="([^"]+)"/.exec(m[2])?.[1];
    if (kind) forms[kind] = { action: unescapeHtml(m[1]), fields };
  }
  return forms;
}
/** Post the checkout form to the mock, as the donor's browser would; returns the page's buttons. */
async function openCheckout(created) {
  const r = await http("POST", created.data.gateway.url, { form: created.data.gateway.fields, ip: IP.gateway });
  return { r, forms: parseMockForms(r.text) };
}
/** Press one button: the mock records the outcome and 307s; the browser re-posts the same body to the merchant. */
async function press(forms, kind) {
  const f = forms[kind];
  if (!f) throw new Error(`the mock page has no "${kind}" button`);
  const r1 = await http("POST", f.action, { form: f.fields, ip: IP.gateway });
  const loc = r1.headers.get("location");
  const r2 = loc ? await http("POST", loc, { form: f.fields, ip: IP.gateway }) : null;
  return { r1, r2, loc, fields: f.fields };
}
/** Create a donation, open the mock and press a button; returns everything a check may need. */
async function pay(label, kind, over = {}) {
  const created = await create(donation(label, over));
  if (created.status !== 201) throw new Error(`create "${label}" answered ${created.status}: ${created.text.slice(0, 300)}`);
  const { forms } = await openCheckout(created);
  const pressed = await press(forms, kind);
  return { created, number: created.data.number, token: created.data.token, forms, ...pressed };
}
const apiCallsFor = (orderId) => mock.requests.filter((q) => q.kind === "api" && q.command === "orderStatusTracker" && q.payload?.order_no === orderId).length;

/* ── Cleanup ───────────────────────────────────────────────────────────── */
function cleanup() {
  const removed = fixture("cleanup", { name_prefix: PREFIX, ips: [...usedIps] });
  sql("DELETE FROM sevas WHERE name_en LIKE ?", [`${PREFIX}%`]);
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [BUCKETS_REGEXP]);
  return removed;
}

/* ── Run ───────────────────────────────────────────────────────────────── */
console.log(`payments-api — run ${RUN}, PHP ${PHP_BIN}`);
const busy = [];
for (const port of Object.values(PORT)) if (await portInUse(port)) busy.push(port);
if (busy.length) {
  console.error(`Ports already in use: ${busy.join(", ")}. Another run of this suite may still be going; nothing was changed.`);
  process.exit(2);
}
// The server pays in TEST mode, so its receipts are TEST-… from the TEST counter (§1); the temple's own sequence is never touched.
const COUNTER = `receipt:test:${istYear}`;
const RECEIPT_RE = new RegExp(`^TEST-${istYear}-\\d{6}$`);
let counterBefore = null;
let templeCounterBefore = null; // the real sequence, receipt:<year>: this suite must never move it
try {
  counterBefore = one("SELECT value FROM payment_counters WHERE name = ?", [COUNTER])?.value ?? null;
  templeCounterBefore = one("SELECT value FROM payment_counters WHERE name = ?", [`receipt:${istYear}`])?.value ?? null;
  console.log(`leftovers removed at start: ${show(cleanup())}`);
  // The receipt counter is shared by every process on this database. Another
  // suite running at the same time (it advances, snapshots or restores the
  // counter) makes receipt numbers collide, which no suite can guard against.
  const others = Number(one("SELECT COUNT(*) c FROM payment_transactions WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 5 MINUTE")?.c);
  if (others > 0) console.log(`  WARNING: ${others} payment attempt(s) were created in the last five minutes by something else on this database; a suite running concurrently can reset the shared receipt counter and break receipt assignment in this run`);
} catch (e) {
  console.error(`✗ the fixtures cannot reach the database: ${e.message}`);
  process.exit(2);
}

try {
  mock = await startCcavenueMock({ port: PORT.mock, workingKey: KEYS.workingKey, accessCode: KEYS.accessCode });
  if (!(await restartServer())) {
    check(false, `the PHP server answers /api/pulse on ${PORT.php}`, server?.log.slice(0, 600));
    throw new Error("no PHP server");
  }
  const effective = fixture("config");
  if (!effective.ready || effective.mode !== "test" || effective.transaction_url !== ENV.CCAVENUE_TRANSACTION_URL) {
    check(false, "payments are ready in TEST mode with the mock's URLs", show(effective));
    throw new Error(`payments not ready: ${effective.reason}`);
  }
  console.log(`  server up: mode ${effective.mode}, gateway ${effective.transaction_url}`);

  /* ── 1. Config ───────────────────────────────────────────────────────── */
  section("1. GET /api/payments/config");
  let r = await http("GET", "/api/payments/config", { ip: IP.lookup });
  const CONFIG_KEYS = ["enabled", "ready", "simulator", "testMode", "currencies", "defaultCurrency", "international", "min", "max", "maxForeign", "presets", "categories", "sevaOnline", "holdMinutes"];
  check(r.status === 200 && keysOf(r.data) === JSON.stringify(CONFIG_KEYS), "200 with exactly the SPEC keys", `${r.status} ${keysOf(r.data)}`);
  check(r.data?.enabled === true && r.data?.ready === true && r.data?.simulator === false && r.data?.testMode === true, "enabled, ready, test mode, not the simulator", show(r.data));
  check(show(r.data?.currencies) === show([{ code: "INR", decimals: 2 }, { code: "USD", decimals: 2 }]) && r.data?.defaultCurrency === "INR" && r.data?.international === true, "currencies INR and USD with decimals, default INR, international on", show(r.data?.currencies));
  check(r.data?.min === 1 && r.data?.max === 500000 && r.data?.maxForeign === 10000 && show(r.data?.presets) === show([500, 1000, 2500, 5000, 10000]), "min, max, maxForeign and presets are numbers", show([r.data?.min, r.data?.max, r.data?.maxForeign, r.data?.presets]));
  const cats = r.data?.categories ?? [];
  check(cats.length === 13 && cats.every((c) => typeof c.slug === "string" && c.name?.ta && c.name?.en && "description" in c && "suggestedAmount" in c) && cats[0].slug === "general", "13 categories with slug, bilingual name and description, suggestedAmount", show(cats.slice(0, 2)));
  check(r.data?.sevaOnline === true && r.data?.holdMinutes === 30, "sevaOnline and holdMinutes follow the settings", show([r.data?.sevaOnline, r.data?.holdMinutes]));
  check(!r.text.includes(KEYS.merchantId) && !r.text.includes(KEYS.accessCode) && !r.text.includes(KEYS.workingKey), "no merchant id, access code or working key in the config");
  check(noStore(r) && (r.headers.get("cache-control") ?? "").includes("private"), "Cache-Control: no-store, private", r.headers.get("cache-control"));
  r = await http("POST", "/api/payments/config", { json: {}, ip: IP.methods });
  check(r.status === 405 && r.data?.error === "Method not allowed", "POST config → 405");
  r = await http("HEAD", "/api/payments/config", { ip: IP.methods });
  check(r.status === 200, "HEAD config → 200");
  r = await http("GET", "/api/payments/nope", { ip: IP.methods });
  check(r.status === 404, "an unknown payments route → 404");
  r = await http("POST", "/api/payments/simulator", { form: { encRequest: "00", access_code: "x" }, ip: IP.methods });
  check(r.status === 404, "the simulator route answers 404 in TEST mode");
  r = await http("GET", "/api/payments-cron", { ip: IP.methods });
  check(r.status === 404, "the HTTP cron is off without PAYMENTS_CRON_KEY → 404");

  /* ── 2. Creating a donation: methods, validation, honeypot, limits ───── */
  section("2a. methods");
  for (const [method, path] of [["GET", "/api/payments/donations"], ["PUT", "/api/payments/donations"], ["DELETE", "/api/payments/seva-bookings"], ["GET", "/api/payments/retry"], ["GET", "/api/payments/receipt-email"], ["POST", "/api/payments/status"], ["POST", "/api/payments/receipt"], ["POST", "/api/payments/verify"]]) {
    r = await http(method, path, { json: method === "GET" ? undefined : {}, ip: IP.methods });
    check(r.status === 405 && r.data?.error === "Method not allowed" && (r.headers.get("allow") ?? "") !== "", `${method} ${path} → 405 with Allow`, `${r.status} ${r.headers.get("allow")} ${r.text.slice(0, 120)}`);
  }
  check(hits("payment-attempt", IP.methods) === undefined, "a wrong method spends no attempt");

  section("2b. the 422 field matrix");
  const empty = await create({});
  check(empty.status === 422 && ["category", "amount", "name", "phone", "country", "acceptTerms"].every((k) => typeof empty.data?.fields?.[k] === "string"), "an empty body → 422 naming category, amount, name, phone, country, acceptTerms", show(empty.data));
  await expectField("no category", without(donation("v"), "category"), "category");
  await expectField("an unknown category", donation("v", { category: "not-a-purpose" }), "category");
  await expectField("a category as an array", donation("v", { category: ["general"] }), "category");
  await expectField("amount 0", donation("v", { amount: "0" }), "amount");
  await expectField("amount 500001 (over the maximum)", donation("v", { amount: "500001" }), "amount");
  await expectField("amount 1e3", donation("v", { amount: "1e3" }), "amount");
  await expectField("amount 1,000", donation("v", { amount: "1,000" }), "amount");
  await expectField("amount with three decimals", donation("v", { amount: "10.005" }), "amount");
  await expectField("amount as an object", donation("v", { amount: { a: 1 } }), "amount");
  await expectField("USD 10001 (over the foreign maximum)", donation("v", { currency: "USD", amount: "10001", country: "US", phone: "12025550123", phoneCountry: "US" }), "amount");
  await expectField("currency GBP (not in the allow-list)", donation("v", { currency: "GBP" }), "currency");
  await expectField("currency as an array", donation("v", { currency: ["USD"] }), "currency");
  await expectField("a name of one character", donation("v", { name: "A" }), "name");
  await expectField("a name as an array", donation("v", { name: ["x"] }), "name");
  await expectField("a name of 101 characters", donation("v", { name: "அ".repeat(101) }), "name");
  await expectField("no phone", donation("v", { phone: "" }), "phone");
  await expectField("a phone of nine national digits", donation("v", { phone: "91987654321" }), "phone");
  await expectField("a phone as an array", donation("v", { phone: ["919876543210"] }), "phone");
  await expectField("country written out", donation("v", { country: "India" }), "country");
  await expectField("an email that is not an address", donation("v", { email: "nope" }), "email");
  await expectField("an Indian PIN of five digits", donation("v", { postcode: "62771" }), "postcode");
  await expectField("a PAN of the wrong shape", donation("v", { pan: "ABCD1234F" }), "pan");
  await expectField("a message of 501 characters", donation("v", { message: "m".repeat(501) }), "message");
  await expectField("notes of 501 characters", donation("v", { notes: "n".repeat(501) }), "notes");
  await expectField("terms not accepted", donation("v", { acceptTerms: false }), "acceptTerms");
  await expectField('terms accepted with "yes"', donation("v", { acceptTerms: "yes" }), "acceptTerms");
  for (const [label, raw] of [["a JSON array", "[1,2,3]"], ["not JSON", "name=E2E"], ["null", "null"], ["a JSON string", '"hello"']]) {
    r = await create(raw);
    check(r.status === 422 && r.data?.fields?.category && r.data?.fields?.amount && r.data?.fields?.name, `a body that is ${label} → 422 naming the required fields`, `${r.status} ${r.text.slice(0, 200)}`);
  }
  const hostile = await create({ category: ["x"], amount: { a: 1 }, name: 5, phone: [], phoneCountry: ["IN"], country: 7, email: ["e"], pan: [], message: ["m"], notes: { n: 1 }, acceptTerms: ["1"], showNamePublicly: { x: 1 }, lang: ["ta"], hp_token: [] });
  check(hostile.status === 422 && Object.keys(hostile.data?.fields ?? {}).length >= 6, "a body of arrays and objects everywhere → 422, never 500", `${hostile.status} ${hostile.text.slice(0, 300)}`);
  const legacyPost = await create(donation("v", { seva_id: 1, devotee_name: "x" }));
  check(legacyPost.status === 201, "extra keys that belong to another form are ignored", `${legacyPost.status} ${legacyPost.text.slice(0, 200)}`);

  section("2c. the honeypot");
  const honey = await create(donation("honeypot", { hp_token: "http://spam.example" }), { ip: IP.honey, lane: false });
  check(honey.status === 201 && honey.text === '{"success":true}', 'a honeypot hit answers 201 with exactly {"success":true}', `${honey.status} ${honey.text}`);
  check(!one("SELECT id FROM donations WHERE name = ?", [`${NAME} honeypot`]), "and saves nothing");
  check(Number(hits("payment-attempt", IP.honey)) === 1 && hits("payment-created", IP.honey) === undefined, "and counts as an attempt, not a create", `${hits("payment-attempt", IP.honey)} / ${hits("payment-created", IP.honey)}`);
  const blankHoney = await create(donation("honeypot blank", { hp_token: "   " }), { ip: IP.honey, lane: false });
  check(blankHoney.status === 201 && /^DON-/.test(blankHoney.data?.number ?? ""), "a whitespace-only honeypot is a person, and is created", `${blankHoney.status} ${blankHoney.text.slice(0, 120)}`);

  section("2d. flood limits: 8 created and 20 attempts an hour per address");
  let codes = [];
  for (let i = 1; i <= 8; i++) codes.push((await create(donation(`flood ${i}`), { ip: IP.flood, lane: false })).status);
  check(codes.every((s) => s === 201), "8 donations from one address are created", codes.join(","));
  r = await create(donation("flood over"), { ip: IP.flood, lane: false });
  check(is429(r), "the 9th is refused with 429, Retry-After, code and retryAfter", `${r.status} ${r.headers.get("retry-after")} ${r.text}`);
  check(!one("SELECT id FROM donations WHERE name = ?", [`${NAME} flood over`]), "and is not created");
  codes = [];
  for (let i = 10; i <= 20; i++) codes.push((await create(donation("flood bad", { amount: "-5" }), { ip: IP.flood, lane: false })).status);
  check(codes.length === 11 && codes.every((s) => s === 422), "invalid posts up to attempt 20 are answered 422, not 429", codes.join(","));
  r = await create(donation("flood bad", { amount: "-5" }), { ip: IP.flood, lane: false });
  check(is429(r), "attempt 21 is refused with 429 even though it is invalid", `${r.status} ${r.text}`);
  r = await create(donation("flood honey", { hp_token: "bot" }), { ip: IP.flood, lane: false });
  check(is429(r), "a honeypot hit is limited as well: the attempt is counted before the honeypot is read");
  r = await create(donation("flood other"), { ip: IP.floodOther, lane: false });
  check(r.status === 201, "a different address is unaffected", `${r.status} ${r.text.slice(0, 120)}`);
  codes = [];
  for (let i = 0; i < 4; i++) codes.push((await create(donation("flood count bad", { amount: "-5" }), { ip: IP.floodCount, lane: false })).status);
  check(codes.every((s) => s === 422) && Number(hits("payment-attempt", IP.floodCount)) === 4 && hits("payment-created", IP.floodCount) === undefined, "invalid posts count as attempts, not creates", `${codes} attempts ${hits("payment-attempt", IP.floodCount)} created ${hits("payment-created", IP.floodCount)}`);
  r = await create(donation("flood count good"), { ip: IP.floodCount, lane: false });
  check(r.status === 201 && Number(hits("payment-created", IP.floodCount)) === 1, "the next valid one counts one create", `${r.status} created ${hits("payment-created", IP.floodCount)}`);

  /* ── 3. What a create stores and sends ───────────────────────────────── */
  section("3. creating a donation: rows, audit and the encRequest");
  const A = donation("Sundar Kumar", { showNamePublicly: true, pan: "abcde1234f", notes: "private note" });
  const a = await create(A);
  const numA = a.data?.number ?? "";
  const tokA = a.data?.token ?? "";
  check(a.status === 201 && keysOf(a.data) === JSON.stringify(["success", "number", "token", "gateway", "simulator"]), "201 with exactly success, number, token, gateway, simulator", `${a.status} ${keysOf(a.data)}`);
  check(new RegExp(`^DON-${istYmd().replace(/-/g, "")}-\\d{8}$`).test(numA), `the number is DON-<IST date>-<8 digits>: ${numA}`);
  check(/^[A-Za-z0-9_-]{22}$/.test(tokA) && a.data?.simulator === false, "a 22-character base64url token; not the simulator", tokA);
  check(a.data?.gateway?.url === ENV.CCAVENUE_TRANSACTION_URL && keysOf(a.data?.gateway?.fields) === JSON.stringify(["encRequest", "access_code"]), "gateway.url is the TEST checkout URL and fields are encRequest + access_code", show(a.data?.gateway));
  check(a.data?.gateway?.fields?.access_code === KEYS.accessCode, "access_code in the form fields is the TEST access code (designed to be public)");
  check(noStore(a) && !a.headers.get("set-cookie"), "the answer is no-store and sets no cookie");
  const dA = don(numA);
  const tA = txn(numA);
  check(dA?.source === "online" && dA?.status === "INITIATED" && dA?.currency === "INR" && dA?.amount === "1001.00" && dA?.purpose === "general" && Number(dA?.category_id) > 0 && dA?.pan === "ABCDE1234F" && dA?.notes === "private note" && Number(dA?.show_name_publicly) === 1 && dA?.updated_at, "the donation row: online, INITIATED, INR 1001.00, category resolved, PAN upper-cased, consent stored", show(dA));
  check(tA?.status === "INITIATED" && Number(tA?.attempt) === 1 && tA?.environment === "test" && tA?.amount === "1001.00" && tA?.currency === "INR" && tA?.verification === "none" && Number(tA?.response_count) === 0 && tA?.redirected_at && tA?.client_ip === a.ip, "the attempt row: INITIATED, attempt 1, TEST, amount copied, redirected_at set, client ip", show(tA));
  check(payableAudits("donation", dA?.id).includes("payable_created") && show(audits(tA?.id)) === show(["attempt_created", "redirect_issued"]), "audit: payable_created, then attempt_created and redirect_issued on the attempt", show([payableAudits("donation", dA?.id), audits(tA?.id)]));
  const reqA = decryptRequest(a);
  check(Object.keys(reqA).join(",") === "merchant_id,order_id,currency,amount,redirect_url,cancel_url,language,billing_name,billing_address,billing_city,billing_state,billing_zip,billing_country,billing_tel,billing_email,merchant_param1,merchant_param2,merchant_param3", "encRequest decrypts under the TEST working key to the §4.3 fields in order", Object.keys(reqA).join(","));
  check(reqA.merchant_id === KEYS.merchantId && reqA.order_id === numA && reqA.currency === "INR" && reqA.amount === "1001.00" && reqA.language === "EN", "merchant id, order id, currency and amount", show(reqA));
  check(reqA.redirect_url === `${BASE}/api/payments/ccavenue/response` && reqA.cancel_url === `${BASE}/api/payments/ccavenue/cancel`, "redirect and cancel URLs point at this site", show([reqA.redirect_url, reqA.cancel_url]));
  check(reqA.billing_name === A.name && reqA.billing_address === "12 Middle Street" && reqA.billing_city === "Pudupatti" && reqA.billing_state === "Tamil Nadu" && reqA.billing_zip === "627719" && reqA.billing_country === "India" && reqA.billing_tel === PHONE && reqA.billing_email === A.email, "billing fields from the stored donation, country as its English name", show(reqA));
  check(reqA.merchant_param1 === "donation" && reqA.merchant_param2 === numA && reqA.merchant_param3 === "1", "merchant_param1/2/3 = type, number, attempt");

  const tampered = await create(donation("Tamper & Sons <b>😀", { amount: "2500", merchant_id: "1", redirect_url: "http://evil.example", order_id: "HACK", mer_amount: "1.00", status: "SUCCESS" }));
  const reqT = decryptRequest(tampered);
  check(tampered.status === 201 && reqT.amount === "2500.00" && reqT.merchant_id === KEYS.merchantId && reqT.redirect_url === `${BASE}/api/payments/ccavenue/response` && reqT.order_id === tampered.data?.number && don(tampered.data?.number)?.status === "INITIATED", "posted merchant_id, redirect_url, order_id, mer_amount and status are ignored: the payload holds only validated values", show(reqT));
  check(!/[&='"<>]/.test(reqT.billing_name) && !/\p{Extended_Pictographic}/u.test(reqT.billing_name) && reqT.billing_name.includes("Tamper") && reqT.billing_name.includes("Sons"), "billing_name is cleaned of & = quotes < > and emoji", reqT.billing_name);
  check(reqT.amount === don(tampered.data?.number)?.amount, "the amount sent is the amount stored");

  /* ── 4. The browser return ───────────────────────────────────────────── */
  section("4a. Success: SUCCESS, receipt, one donation.paid, status-API confirmation");
  const simA = await openCheckout(a);
  check(simA.r.status === 200 && Object.keys(simA.forms).join(",") === "success,card,failure,aborted,awaited,tamper,currency", "the mock checkout page renders the seven buttons for the order", Object.keys(simA.forms).join(","));
  const lastCheckout = mock.requests.filter((q) => q.kind === "checkout").pop();
  check(lastCheckout?.form?.access_code === KEYS.accessCode && lastCheckout?.fields?.order_id === numA, "the mock received the access code and decrypted the order");
  const payA = await press(simA.forms, "success");
  check(payA.r1.status === 307 && payA.loc === `${BASE}/api/payments/ccavenue/response`, "Pay: the mock 307s the browser to redirect_url", `${payA.r1.status} ${payA.loc}`);
  check(payA.r2?.status === 303 && payA.r2.headers.get("location") === resultUrl(numA, tokA), "the response route answers 303 to /payment/result?ref=&t=", payA.r2?.headers.get("location"));
  check(noStore(payA.r2) && payA.r2.headers.get("x-robots-tag") === "noindex, nofollow" && payA.r2.headers.get("referrer-policy") === "no-referrer" && payA.r2.headers.get("x-content-type-options") === "nosniff", "the 303 carries no-store, noindex, no-referrer, nosniff");
  const dA2 = don(numA);
  const tA2 = txn(numA);
  const mockA = mock.order(numA);
  check(dA2?.status === "SUCCESS" && RECEIPT_RE.test(dA2?.receipt_number ?? "") && dA2?.paid_at, `the donation is SUCCESS with receipt ${dA2?.receipt_number} (a TEST-mode number) and paid_at`, show([dA2?.status, dA2?.receipt_number, dA2?.paid_at]));
  check(String(one("SELECT value FROM payment_counters WHERE name = ?", [`receipt:${istYear}`])?.value ?? null) === String(templeCounterBefore) && Number(one("SELECT value FROM payment_counters WHERE name = ?", [COUNTER])?.value) >= 1,
    "the TEST-mode receipt came from receipt:test:<year>; the temple's receipt:<year> sequence did not move", `temple counter ${templeCounterBefore} → ${one("SELECT value FROM payment_counters WHERE name = ?", [`receipt:${istYear}`])?.value ?? null}`);
  check(tA2?.status === "SUCCESS" && tA2?.gateway_status === "Success" && tA2?.tracking_id === mockA?.trackingId && tA2?.bank_ref_no === mockA?.bankRefNo && tA2?.payment_mode === "UPI" && Number(tA2?.response_count) === 1 && tA2?.responded_at, "the attempt is SUCCESS with tracking id, bank ref, UPI, one response", show(tA2));
  check(tA2?.verification === "status_api" && tA2?.verified_at && Number(tA2?.needs_review) === 0, "verification = status_api with verified_at, no review flag", show([tA2?.verification, tA2?.verified_at, tA2?.needs_review]));
  const apiA = mock.requests.filter((q) => q.kind === "api" && q.payload?.order_no === numA);
  check(apiA.length === 1 && apiA[0].command === "orderStatusTracker" && apiA[0].payload?.reference_no === mockA?.trackingId && apiA[0].form?.access_code === KEYS.accessCode && apiA[0].form?.version === "1.2" && apiA[0].form?.request_type === "JSON", "one orderStatusTracker call with reference_no and order_no, version 1.2, JSON", show(apiA.map((q) => [q.command, q.payload])));
  const stored = JSON.parse(tA2?.gateway_response ?? "null");
  const ALLOWED = ["order_id", "tracking_id", "bank_ref_no", "order_status", "failure_message", "payment_mode", "card_name", "status_code", "status_message", "currency", "amount", "mer_amount", "trans_date", "bin_country", "eci_value", "retry", "response_code", "merchant_param1", "merchant_param2", "merchant_param3"];
  check(stored && Object.keys(stored).every((k) => ALLOWED.includes(k)) && stored.order_status === "Success" && stored.amount === "1001.00" && !("mock_kind" in stored), "gateway_response holds allow-listed keys only", show(stored));
  const evA = audits(tA2?.id);
  check(["response_received", "verification_ok", "status_changed", "notification_queued"].every((e) => evA.includes(e)) && payableAudits("donation", dA2?.id).includes("receipt_assigned"), "audit: response_received, verification_ok, status_changed, receipt_assigned, notification_queued", show(evA));
  const nA = notes("donation", dA2?.id);
  check(nA.length === 1 && nA[0].event === "donation.paid" && nA[0].dedupe_key === `donation:${numA}:paid` && nA[0].to_email === A.email && (nA[0].to_phone ?? "").includes("9876543210"), "exactly one donation.paid notification, deduped on the number, to the donor's email and phone", show(nA));
  check(channelsOf(nA[0]?.id) === "email,whatsapp", "its channels follow the settings: email and whatsapp, no sms", channelsOf(nA[0]?.id));
  check((nA[0]?.cta_url ?? "").includes(`ref=${numA}`), "its link is the receipt page", nA[0]?.cta_url);

  section("4b. status and receipt");
  const stA = await status(numA, tokA);
  const STATUS_KEYS = ["kind", "number", "status", "amount", "currency", "amountRefunded", "createdAt", "paidAt", "receiptNumber", "donorName", "purpose", "seva", "preferredDate", "trackingId", "bankRefNo", "paymentMode", "failureMessage", "canRetry", "attempts", "simulator", "testMode", "email"];
  check(stA.status === 200 && keysOf(stA.data) === JSON.stringify(STATUS_KEYS), "status: 200 with exactly the SPEC keys", `${stA.status} ${keysOf(stA.data)}`);
  check(stA.data?.kind === "donation" && stA.data?.status === "SUCCESS" && stA.data?.amount === 1001 && stA.data?.currency === "INR" && stA.data?.amountRefunded === 0 && stA.data?.receiptNumber === dA2?.receipt_number && stA.data?.donorName === A.name, "status values: kind, SUCCESS, amount 1001, receipt, donor", show(stA.data));
  check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(stA.data?.createdAt ?? "") && /Z$/.test(stA.data?.paidAt ?? ""), "createdAt and paidAt are ISO-8601 UTC", show([stA.data?.createdAt, stA.data?.paidAt]));
  check(stA.data?.purpose?.en === "General Donation" && typeof stA.data?.purpose?.ta === "string" && stA.data?.seva === null && stA.data?.trackingId === mockA?.trackingId && stA.data?.paymentMode === "UPI" && stA.data?.failureMessage === null && stA.data?.canRetry === false && stA.data?.attempts === 1 && stA.data?.simulator === false && stA.data?.testMode === true && stA.data?.email === "e•••@example.test", "purpose, tracking id, mode, no retry, testMode (the attempt's environment), masked email", show(stA.data));
  check(noStore(stA), "status is no-store");
  const rcA = await receipt(numA, tokA);
  check(rcA.status === 200 && keysOf(rcA.data) === JSON.stringify([...STATUS_KEYS, "verifyUrl", "pan", "address", "message"]), "receipt: the status keys plus verifyUrl, pan, address, message", `${rcA.status} ${keysOf(rcA.data)}`);
  check(rcA.data?.pan === "ABCDE••••F" && show(rcA.data?.address) === show({ line: "12 Middle Street", city: "Pudupatti", state: "Tamil Nadu", postcode: "627719", country: "IN" }) && rcA.data?.message === "E2E payments API" && (rcA.data?.verifyUrl ?? "").startsWith(`${BASE}/payment/verify?r=${dA2?.receipt_number}&v=`), "masked PAN, the address, the message and an absolute verify URL", show(rcA.data));
  check(!rcA.text.includes("private note"), "the donor's private note is not on the receipt");
  const b0 = await create(donation("Other"));
  const numB = b0.data?.number ?? "";
  const tokB = b0.data?.token ?? "";
  check(isNotFound(await status(numA, tokB)), "status with another number's token → 404 not_found");
  check(isNotFound(await status(numA, "x".repeat(22))), "status with a wrong token → 404");
  check(isNotFound(await status("DON-20200101-00000001", tokA)), "status with an unknown number → 404");
  check(isNotFound(await status("HACK", tokA)) && isNotFound(await status(`${numA}-R2`, tokA)), "status with a malformed number or an order id → 404");
  check(isNotFound(await receipt(numB, tokB)), "receipt for a payment that is not paid → 404");
  check(isNotFound(await http("GET", `/api/payments/receipt?ref=${numA}`, { ip: IP.lookup })), "receipt without a token → 404");
  check(hits("payment-lookup", IP.lookup) !== undefined, "lookups spend the payment-lookup bucket");

  section("4c. a replayed response and the notify channel");
  const replay = await gatewayPost("response", { encResp: payA.fields.encResp });
  check(replay.status === 303 && replay.headers.get("location") === resultUrl(numA, tokA), "a replayed response answers the same 303");
  const tA3 = txn(numA);
  check(Number(tA3?.response_count) === 2 && tA3?.status === "SUCCESS" && don(numA)?.receipt_number === dA2?.receipt_number && audits(tA3?.id).includes("response_duplicate"), "it only counts a second response and audits response_duplicate; same receipt", show([tA3?.response_count, tA3?.status]));
  check(notes("donation", dA2?.id).length === 1 && apiCallsFor(numA) === 1, "still one notification and no second status-API call");
  const notify = await gatewayPost("notify", { encResp: payA.fields.encResp });
  check(notify.status === 200 && notify.text === "OK" && (notify.headers.get("content-type") ?? "").startsWith("text/plain") && noStore(notify), 'the notify channel answers 200 text/plain "OK"', `${notify.status} ${notify.text}`);
  check(Number(txn(numA)?.response_count) === 3 && notes("donation", dA2?.id).length === 1, "the notify channel counts as a response, sends nothing new");

  section("4d. verify");
  const vu = new URL(rcA.data?.verifyUrl ?? "http://x/?r=&v=");
  const verA = await verify(vu.searchParams.get("r"), vu.searchParams.get("v"));
  check(verA.status === 200 && verA.data?.valid === true && verA.data?.receiptNumber === dA2?.receipt_number && verA.data?.date === istYmd() && verA.data?.amount === 1001 && verA.data?.currency === "INR" && verA.data?.status === "SUCCESS" && verA.data?.purpose?.en === "General Donation", "a genuine receipt: valid, receipt number, IST date, amount, purpose", show(verA.data));
  check(verA.data?.donor === "E•••• S•••• K••••" && !verA.text.includes("Sundar"), "the donor who ticked the list is shown masked", verA.data?.donor);
  check(keysOf(verA.data) === JSON.stringify(["valid", "receiptNumber", "date", "amount", "currency", "status", "purpose", "donor"]) && !verA.text.includes(PHONE) && !verA.text.includes(A.email), "and nothing else: no phone, email or name", keysOf(verA.data));
  r = await verify(vu.searchParams.get("r"), "AAAAAAAAAA");
  check(r.status === 200 && r.text === '{"valid":false}', "a wrong verify token → 200 {valid:false}");
  r = await verify("NOT-A-RECEIPT", vu.searchParams.get("v"));
  check(r.status === 200 && r.text === '{"valid":false}', "a receipt number of the wrong shape → {valid:false}");
  const ghost = fixture("token", { receipt: "TMR-1999-000001" });
  r = await verify("TMR-1999-000001", ghost.verify);
  check(r.status === 200 && r.text === '{"valid":false}', "a receipt that does not exist, with its own valid token → {valid:false}");
  r = await http("GET", "/api/payments/verify", { ip: IP.lookup });
  check(r.status === 200 && r.text === '{"valid":false}', "no parameters at all → {valid:false}");

  section("4e. receipt-email");
  const emA = await http("POST", "/api/payments/receipt-email", { json: { ref: numA, t: tokA }, ip: IP.receiptEmail });
  check(emA.status === 202 && show(emA.data) === show({ success: true, email: "e•••@example.test" }), "202 {success, masked email} when the donor gave an email", `${emA.status} ${emA.text}`);
  const nA2 = notes("donation", dA2?.id);
  check(nA2.length === 2 && nA2[1].event === "donation.paid" && nA2[1].dedupe_key === `receipt:${numA}:resend:1` && channelsOf(nA2[1].id) === "email", "it re-raises donation.paid as resend 1, to email only", show(nA2.map((n) => [n.event, n.dedupe_key])));
  check(audits(tA2?.id).includes("receipt_emailed"), "audit receipt_emailed");
  check(isNotFound(await http("POST", "/api/payments/receipt-email", { json: { ref: numA, t: tokB }, ip: IP.receiptEmail })), "with another number's token → 404");
  check(isNotFound(await http("POST", "/api/payments/receipt-email", { json: { ref: numB, t: tokB }, ip: IP.receiptEmail })), "for a payment that is not paid → 404");
  for (let i = 0; i < 2; i++) await http("POST", "/api/payments/receipt-email", { json: { ref: numA, t: "bad" }, ip: IP.receiptEmail });
  r = await http("POST", "/api/payments/receipt-email", { json: { ref: numA, t: tokA }, ip: IP.receiptEmail });
  check(is429(r), "the 6th receipt-email request from one address in an hour → 429", `${r.status} ${r.text}`);
  check(notes("donation", dA2?.id).length === 2, "and nothing more was queued");

  section("4f. a donor without an email: receipt-email saves it");
  const N = await pay("No Email", "success", { email: "", showNamePublicly: false });
  const dN = don(N.number);
  check(dN?.status === "SUCCESS" && dN?.email === null, "a donation without an email is paid", show([dN?.status, dN?.email]));
  const nN = notes("donation", dN?.id);
  check(nN.length === 1 && nN[0].to_email === null && channelsOf(nN[0].id).includes("whatsapp"), "its donation.paid goes to the phone only", show(nN));
  r = await http("POST", "/api/payments/receipt-email", { json: { ref: N.number, t: N.token }, ip: IP.lookup });
  check(r.status === 422 && typeof r.data?.fields?.email === "string", "receipt-email without an address → 422 fields.email", `${r.status} ${r.text}`);
  r = await http("POST", "/api/payments/receipt-email", { json: { ref: N.number, t: N.token, email: "not-an-address" }, ip: IP.lookup });
  check(r.status === 422 && typeof r.data?.fields?.email === "string", "with an invalid address → 422 fields.email");
  r = await http("POST", "/api/payments/receipt-email", { json: { ref: N.number, t: N.token, email: `${EMAIL}-Late@Example.TEST` }, ip: IP.lookup });
  check(r.status === 202 && r.data?.email === "e•••@example.test", "with a valid address → 202", `${r.status} ${r.text}`);
  check(don(N.number)?.email === `${EMAIL}-late@example.test`, "the address is saved on the donation, lowercase", don(N.number)?.email);
  const nN2 = notes("donation", dN?.id);
  check(nN2.length === 2 && nN2[1].dedupe_key === `receipt:${N.number}:resend:1` && nN2[1].to_email === `${EMAIL}-late@example.test` && channelsOf(nN2[1].id) === "email", "the receipt is queued to that email only", show(nN2));
  const rcN = await receipt(N.number, N.token);
  const vN = new URL(rcN.data?.verifyUrl ?? "http://x/?r=&v=");
  const verN = await verify(vN.searchParams.get("r"), vN.searchParams.get("v"));
  check(verN.data?.valid === true && verN.data?.donor === "Anonymous devotee", "verify shows a donor who did not tick the list as an anonymous devotee", show(verN.data));

  section("4g. Failure: FAILED with an email-only message, then a retry");
  const B = await pay("Declined", "failure");
  const dB = don(B.number);
  const tB = txn(B.number);
  check(B.r2?.status === 303 && B.r2.headers.get("location") === resultUrl(B.number, B.token), "Decline → 303 to the result page");
  check(dB?.status === "FAILED" && tB?.status === "FAILED" && tB?.gateway_status === "Failure" && tB?.failure_message === "Simulated decline by the bank" && tB?.status_code === "0" && !dB?.receipt_number, "donation and attempt are FAILED with the gateway's failure message; no receipt", show([dB?.status, tB?.status, tB?.failure_message]));
  const nB = notes("payment", tB?.id);
  check(nB.length === 1 && nB[0].event === "payment.failed" && nB[0].dedupe_key === `payment:${B.number}:failed` && channelsOf(nB[0].id) === "email" && (nB[0].cta_url ?? "").includes("/payment/result"), "one payment.failed, email only, linking to the result page", show(nB));
  check(notes("donation", dB?.id).length === 0 && apiCallsFor(B.number) === 0, "no donation message and no status-API call for a failure");
  const stB = await status(B.number, B.token);
  check(stB.data?.status === "FAILED" && stB.data?.canRetry === true && stB.data?.failureMessage === "Simulated decline by the bank" && stB.data?.attempts === 1, "status: FAILED, canRetry, the failure message", show(stB.data));
  r = await retry(B.number, "y".repeat(22));
  check(r.status === 403 && r.data?.code === "bad_token", "retry with a wrong token → 403 bad_token", `${r.status} ${r.text}`);
  r = await retry("HACK", B.token);
  check(r.status === 403 && r.data?.code === "bad_token", "retry with a malformed number → 403 bad_token");
  const ghostNumber = "DON-20200101-00000001";
  r = await retry(ghostNumber, fixture("token", { number: ghostNumber }).token);
  check(isNotFound(r), "retry with a valid token for a number that does not exist → 404");
  r = await retry(numB, tokB);
  check(r.status === 409 && r.data?.code === "not_retryable" && r.data?.status === "INITIATED", "retry on a payment started a moment ago → 409 not_retryable, status INITIATED", `${r.status} ${r.text}`);
  const rB = await retry(B.number, B.token);
  const reqB2 = decryptRequest(rB);
  check(rB.status === 201 && keysOf(rB.data) === JSON.stringify(["success", "number", "token", "gateway", "simulator"]) && rB.data?.number === B.number && rB.data?.token === B.token, "retry → 201 in the create shape, same number and token", `${rB.status} ${rB.text.slice(0, 200)}`);
  check(reqB2.order_id === `${B.number}-R2` && reqB2.merchant_param3 === "2" && reqB2.amount === "1001.00" && reqB2.merchant_param2 === B.number, "the new attempt is -R2 with the stored amount", show(reqB2));
  check(don(B.number)?.status === "INITIATED" && txn(`${B.number}-R2`)?.status === "INITIATED" && audits(txn(`${B.number}-R2`)?.id).includes("retry_requested"), "the donation is INITIATED again; audit retry_requested");
  const simB2 = await openCheckout(rB);
  await press(simB2.forms, "card");
  const tB2 = txn(`${B.number}-R2`);
  check(don(B.number)?.status === "SUCCESS" && tB2?.status === "SUCCESS" && tB2?.payment_mode === "Credit Card" && tB2?.card_name === "Visa" && txn(B.number)?.status === "FAILED", "paying the retry by card: donation SUCCESS, R2 SUCCESS, attempt 1 stays FAILED", show([don(B.number)?.status, tB2?.status, tB2?.payment_mode]));
  check(notes("donation", dB?.id).length === 1 && notes("donation", dB?.id)[0].event === "donation.paid", "one donation.paid after the retry");
  r = await retry(B.number, B.token);
  check(r.status === 409 && r.data?.code === "not_retryable" && r.data?.status === "SUCCESS", "retry once paid → 409 not_retryable, status SUCCESS", `${r.status} ${r.text}`);
  check((await status(B.number, B.token)).data?.attempts === 2, "status counts two attempts");

  section("4h. five attempts at most; no message without an email");
  const L = await pay("Limit", "failure", { email: "" });
  check(don(L.number)?.status === "FAILED" && notes("payment", txn(L.number)?.id).length === 0, "a failure without an email sends nothing");
  let rL = null;
  for (let n = 2; n <= 5; n++) {
    rL = await retry(L.number, L.token);
    if (rL.status !== 201) break;
    const sim = await openCheckout(rL);
    await press(sim.forms, "failure");
  }
  const attemptsL = rows("SELECT order_id, status, attempt FROM payment_transactions WHERE payable_type = 'donation' AND payable_id = ? ORDER BY attempt", [don(L.number)?.id]);
  check(attemptsL.length === 5 && attemptsL.every((t, i) => Number(t.attempt) === i + 1 && t.status === "FAILED" && t.order_id === (i === 0 ? L.number : `${L.number}-R${i + 1}`)), "attempts 1–5 with order ids …, -R2 … -R5, all FAILED", show(attemptsL));
  r = await retry(L.number, L.token);
  check(r.status === 409 && r.data?.code === "not_retryable" && r.data?.status === "FAILED", "the sixth attempt → 409 not_retryable", `${r.status} ${r.text}`);
  const stL = await status(L.number, L.token);
  check(stL.data?.attempts === 5 && stL.data?.canRetry === false, "status: 5 attempts, no retry offered", show(stL.data));

  section("4i. Abort and cancel_url: CANCELLED, no message");
  const C = await pay("Cancelled", "aborted", { showNamePublicly: true });
  check(C.r1.status === 307 && C.loc === `${BASE}/api/payments/ccavenue/cancel` && C.r2?.status === 303 && C.r2.headers.get("location") === resultUrl(C.number, C.token), "Cancel: the mock 307s to cancel_url, which answers 303 to the result page", `${C.loc} ${C.r2?.status}`);
  const tC = txn(C.number);
  check(don(C.number)?.status === "CANCELLED" && tC?.status === "CANCELLED" && tC?.gateway_status === "Aborted", "donation and attempt are CANCELLED", show([don(C.number)?.status, tC?.status]));
  check(notes("donation", don(C.number)?.id).length === 0 && notes("payment", tC?.id).length === 0, "no message on CANCELLED");
  check((await status(C.number, C.token)).data?.canRetry === true, "a cancelled payment can be tried again at once");
  r = await gatewayPost("cancel", {});
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=cancelled`, "cancel_url without encResp → state=cancelled", r.headers.get("location"));
  r = await gatewayPost("cancel", { orderNo: numA, order_status: "Aborted" });
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=cancelled` && don(numA)?.status === "SUCCESS", "a plain orderNo field on cancel_url changes nothing");

  section("4j. Awaited: PENDING until the sweep confirms it");
  const F = await pay("Awaited", "awaited");
  const tF = txn(F.number);
  check(don(F.number)?.status === "PENDING" && tF?.status === "PENDING" && tF?.gateway_status === "Awaited" && Number(tF?.needs_review) === 0 && Number(tF?.response_count) === 1, "Awaited → attempt and donation PENDING, no review flag", show([don(F.number)?.status, tF?.status, tF?.gateway_status]));
  check(notes("donation", don(F.number)?.id).length === 0 && (await status(F.number, F.token)).data?.canRetry === false, "no message yet, and no retry inside fifteen minutes");
  mock.setApiStatus(F.number, "Successful");
  const sweepF = await cliSweep([F.number]);
  check(sweepF.checked === 1 && sweepF.changed === 1 && sweepF.locked === false && sweepF.items?.[0]?.outcome === "paid" && sweepF.items?.[0]?.to === "SUCCESS", "the CLI sweep (--order-ids --json) checks it and it becomes SUCCESS", show(sweepF));
  const tF2 = txn(F.number);
  check(tF2?.status === "SUCCESS" && tF2?.verification === "status_api" && tF2?.verified_at && tF2?.last_checked_at && don(F.number)?.status === "SUCCESS" && RECEIPT_RE.test(don(F.number)?.receipt_number ?? ""), "SUCCESS verified by the status API, receipt assigned", show(tF2));
  check(["reconcile_checked", "verification_ok", "status_changed"].every((e) => audits(tF2?.id).includes(e)) && notes("donation", don(F.number)?.id).length === 1, "audit reconcile_checked + verification_ok; one donation.paid from the sweep", show(audits(tF2?.id)));

  section("4k. a tampered amount, currency or merchant_param2 is never SUCCESS");
  const D = await pay("Tampered Amount", "tamper", { amount: "1000", showNamePublicly: true });
  const tD = txn(D.number);
  check(D.r2?.status === 303 && tD?.status === "PENDING" && Number(tD?.needs_review) === 1 && don(D.number)?.status === "PENDING" && !don(D.number)?.receipt_number, "amount 999.00 for a 1000.00 order → PENDING + needs_review, no receipt", show([tD?.status, tD?.needs_review, don(D.number)?.status]));
  check(audits(tD?.id).includes("response_mismatch") && JSON.parse(tD?.gateway_response ?? "{}").amount === "999.00" && apiCallsFor(D.number) === 0, "audit response_mismatch; the response is kept; CCAvenue was not asked", show(audits(tD?.id)));
  check(notes("donation", don(D.number)?.id).length === 0, "no message");
  const forged = mock.encrypt({ order_id: D.number, tracking_id: "111122223333", order_status: "Success", currency: "INR", amount: "1.00", merchant_param2: D.number });
  r = await gatewayPost("response", { encResp: forged });
  check(r.status === 303 && txn(D.number)?.status === "PENDING" && don(D.number)?.status === "PENDING" && Number(txn(D.number)?.response_count) === 2, "a hand-built Success with amount 1.00 → still PENDING", show([r.status, txn(D.number)?.status]));
  const sweepD = await sweep({ order_ids: [D.number] });
  check(sweepD.checked === 1 && sweepD.changed === 0 && sweepD.items?.[0]?.outcome === "disagrees" && txn(D.number)?.status === "PENDING" && audits(tD?.id).includes("verification_disagrees"), "the sweep asks CCAvenue, which reports the other amount: still PENDING, audit verification_disagrees", show(sweepD));
  const E = await pay("Wrong Currency", "currency");
  const tE = txn(E.number);
  check(tE?.status === "PENDING" && Number(tE?.needs_review) === 1 && audits(tE?.id).includes("response_mismatch") && don(E.number)?.status === "PENDING", "USD for an INR order → PENDING + needs_review + response_mismatch", show([tE?.status, tE?.needs_review]));
  const P = await create(donation("Param Mismatch"));
  const numP = P.data?.number ?? "";
  await openCheckout(P);
  const forgedP = mock.response(numP, "success", { record: false, merchant_param2: numA });
  r = await gatewayPost("response", { encResp: forgedP.encResp });
  const tP = txn(numP);
  const mismatchP = one("SELECT data FROM payment_audit_log WHERE transaction_id = ? AND event = 'response_mismatch'", [tP?.id]);
  check(r.status === 303 && tP?.status === "PENDING" && Number(tP?.needs_review) === 1 && (mismatchP?.data ?? "").includes("merchant_param2"), "a Success naming another donation in merchant_param2 → PENDING + needs_review, the mismatch audited", show([tP?.status, mismatchP?.data]));
  check(apiCallsFor(numP) === 0 && don(numP)?.status === "PENDING", "and CCAvenue was not asked");

  section("4l. a response under the wrong environment's key");
  const W = await create(donation("Wrong Key"));
  const numW = W.data?.number ?? "";
  const underSimulatorKey = ccavEncrypt(ccavBuild({ order_id: numW, tracking_id: "222233334444", order_status: "Success", currency: "INR", amount: "1001.00", merchant_param2: numW }), KEYS.simulatorKey);
  r = await gatewayPost("response", { encResp: underSimulatorKey });
  const tW = txn(numW);
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=unknown` && !r.headers.get("location")?.includes(W.data?.token ?? "§"),
    "the browser gets state=unknown — no number, no access token — as for any response we cannot read", r.headers.get("location"));
  check(tW?.status === "INITIATED" && Number(tW?.needs_review) === 1 && audits(tW?.id).includes("response_wrong_environment") && don(numW)?.status === "INITIATED", "a TEST order answered under the simulator key: nothing applied, needs_review, audit response_wrong_environment", show([tW?.status, tW?.needs_review, audits(tW?.id)]));
  r = await gatewayPost("notify", { encResp: underSimulatorKey });
  check(r.status === 400 && r.text === "Bad Request" && txn(numW)?.status === "INITIATED" && Number(txn(numW)?.response_count) === 0, "the notify channel answers 400 to it and counts no response", `${r.status} ${r.text}`);
  const underProductionKey = ccavEncrypt(ccavBuild({ order_id: numW, order_status: "Success", currency: "INR", amount: "1001.00" }), "some-production-key-nobody-configured");
  r = await gatewayPost("response", { encResp: underProductionKey });
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=unknown` && txn(numW)?.status === "INITIATED", "a response under a key this server does not have → state=unknown, nothing changed");

  /* ── 5. Hostile returns and an unreachable status API ────────────────── */
  section("5a. hostile gateway returns never answer 500");
  const before5 = Number(one("SELECT COUNT(*) c FROM payment_audit_log WHERE ip = ? AND transaction_id IS NULL AND payable_id IS NULL", [IP.gateway])?.c);
  r = await gatewayPost("response", { encResp: mock.encrypt({ order_id: "DON-20200101-99999999", order_status: "Success", amount: "1.00", currency: "INR" }) });
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=unknown`, "an order this site never issued → state=unknown", r.headers.get("location"));
  r = await gatewayPost("response", { encResp: mock.encrypt({ order_id: "HACK'; DROP TABLE donations; --", order_status: "Success" }) });
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=unknown`, "an order id of the wrong shape → state=unknown");
  r = await gatewayPost("response", { encResp: "abcd" });
  check(r.status === 303 && r.headers.get("location") === `${BASE}/payment/result?state=unknown`, "garbage encResp → state=unknown");
  r = await gatewayPost("response", { encResp: "zz" });
  check(r.status === 303 && r.headers.get("location")?.endsWith("state=unknown"), "encResp that is not hex → state=unknown");
  r = await gatewayPost("response", { encResp: "ab".repeat(35000) });
  check(r.status === 303 && r.headers.get("location")?.endsWith("state=unknown"), "an encResp over 64 KB → state=unknown");
  r = await gatewayPost("response", {});
  check(r.status === 303 && r.headers.get("location")?.endsWith("state=unknown"), "a response without encResp → state=unknown");
  r = await gatewayPost("notify", { encResp: "ab".repeat(35000) });
  check(r.status === 413 && r.text === "Payload Too Large", "an oversize notify → 413");
  r = await gatewayPost("notify", { encResp: "zz" });
  check(r.status === 400 && r.text === "Bad Request" && (r.headers.get("content-type") ?? "").startsWith("text/plain"), "an undecryptable notify → 400 text");
  r = await gatewayPost("notify", {});
  check(r.status === 400, "a notify without encResp → 400");
  r = await gatewayPost("notify", { encResp: mock.encrypt({ order_id: "DON-20200101-99999999", order_status: "Success" }) });
  check(r.status === 200 && r.text === "OK", "a notify for an unknown order is acknowledged with 200 OK (and audited)");
  for (const channel of ["response", "cancel", "notify"]) {
    for (const method of ["GET", "HEAD", "PUT"]) {
      r = await http(method, `/api/payments/ccavenue/${channel}`, { ip: IP.gateway });
      check(r.status === 303 && r.headers.get("location") === `${BASE}/donations`, `${method} ${channel} → 303 /donations`, `${r.status} ${r.headers.get("location")}`);
    }
  }
  const after5 = Number(one("SELECT COUNT(*) c FROM payment_audit_log WHERE ip = ? AND transaction_id IS NULL AND payable_id IS NULL", [IP.gateway])?.c);
  const hostileEvents = rows("SELECT event, COUNT(*) n FROM payment_audit_log WHERE ip = ? AND transaction_id IS NULL AND payable_id IS NULL GROUP BY event", [IP.gateway]).map((x) => `${x.event}:${x.n}`).join(" ");
  check(after5 - before5 >= 8 && /response_unknown_order:[3-9]/.test(hostileEvents) && /response_undecryptable:[4-9]/.test(hostileEvents), "unknown orders and undecryptable bodies are audited with the caller's address", hostileEvents);
  const hostileData = rows("SELECT detail, data FROM payment_audit_log WHERE ip = ? AND transaction_id IS NULL AND payable_id IS NULL", [IP.gateway]);
  const parsedHostile = hostileData.map((x) => { try { return JSON.parse(x.data ?? "{}"); } catch { return {}; } });
  check(hostileData.length > 0 && hostileData.every((x) => String(x.data ?? "").length < 600 && !`${x.detail} ${x.data}`.includes("abababababab"))
    && parsedHostile.every((d) => !("order_id" in d) || String(d.order_id).length <= 30)
    && parsedHostile.some((d) => d.length >= 70000), "those audit rows carry the channel, the length and an order id cut to 30 characters, never the body", show(parsedHostile));

  section("5b. the status API unreachable during the callback");
  const U0 = await create(donation("Unreachable", { showNamePublicly: false }));
  const numU = U0.data?.number ?? "";
  const simU = await openCheckout(U0);
  mock.setApiScenario(numU, "http500");
  const payU = await press(simU.forms, "success");
  const tU = txn(numU);
  check(payU.r2?.status === 303 && tU?.status === "SUCCESS" && tU?.verification === "callback" && tU?.verified_at === null && Number(tU?.needs_review) === 0, "CCAvenue's API answers 500: SUCCESS stands on the callback alone (verification = callback)", show([tU?.status, tU?.verification, tU?.verified_at]));
  const receiptU = don(numU)?.receipt_number ?? "";
  check(don(numU)?.status === "SUCCESS" && RECEIPT_RE.test(receiptU) && notes("donation", don(numU)?.id).length === 1 && audits(tU?.id).includes("verification_unavailable"), "receipt and donation.paid as usual; audit verification_unavailable", show(audits(tU?.id)));
  mock.setApiScenario(numU, "garbage");
  let sweepU = await sweep({ order_ids: [numU] });
  check(sweepU.checked === 1 && sweepU.changed === 0 && sweepU.items?.[0]?.outcome === "unavailable" && txn(numU)?.verification === "callback", "a sweep while the API answers garbage changes nothing", show(sweepU));
  mock.setApiScenario(numU, "http429");
  sweepU = await sweep({ order_ids: [numU] });
  check(sweepU.items?.[0]?.outcome === "unavailable" && txn(numU)?.verification === "callback", "…nor while it answers 429", show(sweepU));
  mock.setApiScenario(numU, "ok");
  sweepU = await sweep({ order_ids: [numU] });
  const tU2 = txn(numU);
  check(sweepU.checked === 1 && sweepU.items?.[0]?.outcome === "verified" && tU2?.verification === "status_api" && tU2?.verified_at && tU2?.status === "SUCCESS", "a later sweep upgrades it to status_api", show([sweepU, tU2?.verification]));
  check(don(numU)?.receipt_number === receiptU && notes("donation", don(numU)?.id).length === 1 && audits(tU2?.id).includes("verification_ok"), "same receipt, still one message, audit verification_ok");
  sweepU = await sweep({ order_ids: [numU] });
  check(sweepU.checked === 0, "a verified SUCCESS is not checked again");

  /* ── 6. Seva payables ────────────────────────────────────────────────── */
  section("6a. a seva payable: the price comes from the database");
  const seva = one("SELECT id, amount, name_en FROM sevas WHERE id = 1 AND is_active = 1 AND amount > 0");
  check(Boolean(seva), "seva 1 is active with a price to test against", show(seva));
  const S = await createSeva({ seva_id: 1, devotee_name: `${NAME} Seva`, phone: PHONE, phoneCountry: "IN", email: `${EMAIL}-seva@example.test`, preferred_date: istTomorrow(), message: "E2E seva", lang: "ta", acceptTerms: true, amount: "1", currency: "USD", hp_token: "" });
  const numS = S.data?.number ?? "";
  const reqS = decryptRequest(S);
  check(S.status === 201 && new RegExp(`^SEV-${istYmd().replace(/-/g, "")}-\\d{8}$`).test(numS) && S.data?.simulator === false, `201 with a SEV number: ${numS}`, `${S.status} ${S.text.slice(0, 200)}`);
  check(reqS.amount === Number(seva?.amount).toFixed(2) && reqS.currency === "INR" && reqS.merchant_param1 === "seva_booking" && reqS.merchant_param2 === numS && reqS.billing_address === "" && reqS.billing_country === "India" && reqS.billing_name === `${NAME} Seva`, "the encRequest carries the database price in INR (the posted amount and currency are ignored), no billing address", show(reqS));
  const bS = booking(numS);
  check(bS?.payment_mode === "online" && bS?.status === "pending" && bS?.payment_status === "INITIATED" && bS?.amount === Number(seva?.amount).toFixed(2) && bS?.currency === "INR" && bS?.email === `${EMAIL}-seva@example.test` && bS?.preferred_date === istTomorrow() && bS?.lang === "ta" && bS?.hold_expires_at, "the booking: online, pending, INITIATED, price, currency, email, date, a hold", show(bS));
  const holdMinutes = Number(one("SELECT TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), hold_expires_at) m FROM seva_bookings WHERE order_number = ?", [numS])?.m);
  check(holdMinutes >= 28 && holdMinutes <= 30, "the hold is hold_minutes (30) ahead, in UTC", `${holdMinutes} minutes`);
  const simS = await openCheckout(S);
  await press(simS.forms, "success");
  const bS2 = booking(numS);
  const tS = txn(numS);
  check(bS2?.payment_status === "SUCCESS" && RECEIPT_RE.test(bS2?.receipt_number ?? "") && bS2?.paid_at && bS2?.status === "pending" && tS?.status === "SUCCESS" && tS?.verification === "status_api", "paid: payment_status SUCCESS with a receipt, the booking itself stays pending", show([bS2?.payment_status, bS2?.receipt_number, bS2?.status]));
  const nS = notes("payment", tS?.id);
  check(nS.length === 1 && nS[0].event === "payment.succeeded" && nS[0].dedupe_key === `payment:${numS}:success` && nS[0].to_email === `${EMAIL}-seva@example.test`, "one payment.succeeded on the attempt, deduped on the number", show(nS));
  const stS = await status(numS, S.data?.token);
  check(stS.data?.kind === "seva_booking" && stS.data?.status === "SUCCESS" && stS.data?.purpose === null && stS.data?.seva?.en === seva?.name_en && stS.data?.preferredDate === istTomorrow() && stS.data?.amount === Number(seva?.amount), "status: kind seva_booking, the seva's bilingual name, the preferred date", show(stS.data));
  const rcS = await receipt(numS, S.data?.token);
  const vS = new URL(rcS.data?.verifyUrl ?? "http://x/?r=&v=");
  const verS = await verify(vS.searchParams.get("r"), vS.searchParams.get("v"));
  check(verS.data?.valid === true && verS.data?.seva?.en === seva?.name_en && verS.data?.purpose === undefined && verS.data?.donor === "Anonymous devotee", "verify: the seva, and always an anonymous devotee", show(verS.data));

  section("6b. a zero-price, inactive or unknown seva is refused");
  sql("INSERT INTO sevas (name_ta, name_en, amount, is_active) VALUES (?, ?, 0, 1), (?, ?, 100, 0)", [`${NAME} இலவசம்`, `${NAME} zero price`, `${NAME} மறைந்த`, `${NAME} inactive`]);
  const zeroId = Number(one("SELECT id FROM sevas WHERE name_en = ?", [`${NAME} zero price`])?.id);
  const inactiveId = Number(one("SELECT id FROM sevas WHERE name_en = ?", [`${NAME} inactive`])?.id);
  const sevaBody = (over) => ({ seva_id: 1, devotee_name: `${NAME} Refused`, phone: PHONE, phoneCountry: "IN", acceptTerms: true, lang: "en", ...over });
  for (const [label, over] of [["a seva priced 0", { seva_id: zeroId }], ["an inactive seva", { seva_id: inactiveId }], ["an unknown seva", { seva_id: 999999999 }], ["a seva id as text", { seva_id: "abc" }], ["a seva id as an array", { seva_id: [1] }], ["no seva id", { seva_id: undefined }]]) {
    r = await createSeva(sevaBody(over));
    check(r.status === 422 && typeof r.data?.fields?.seva_id === "string", `${label} → 422 with "seva_id"`, `${r.status} ${r.text.slice(0, 200)}`);
  }
  for (const [label, over, key] of [["a name of one character", { devotee_name: "A" }, "devotee_name"], ["a date in the past", { preferred_date: "2020-01-01" }, "preferred_date"], ["a date written 14-09-2026", { preferred_date: "14-09-2026" }, "preferred_date"], ["terms not accepted", { acceptTerms: false }, "acceptTerms"], ["a phone as an array", { phone: [PHONE] }, "phone"]]) {
    r = await createSeva(sevaBody(over));
    check(r.status === 422 && typeof r.data?.fields?.[key] === "string", `seva: ${label} → 422 with "${key}"`, `${r.status} ${r.text.slice(0, 200)}`);
  }
  check(Number(one("SELECT COUNT(*) c FROM seva_bookings WHERE devotee_name = ?", [`${NAME} Refused`])?.c) === 0, "none of the refused bookings was saved");

  section("6c. an expired hold cancels the booking; a late success restores it");
  const H = await createSeva({ seva_id: 2, devotee_name: `${NAME} Hold`, phone: PHONE, phoneCountry: "IN", acceptTerms: true, lang: "en" });
  const numH = H.data?.number ?? "";
  const simH = await openCheckout(H);
  const moved = fixture("backdate", { number: numH, hold_minutes: 1 });
  check(moved.bookings === 1, "the fixture moves the hold into the past");
  const sweepH = await sweep({ order_ids: [numH], expire_holds: true });
  const bH = booking(numH);
  check(sweepH.expired === 1 && bH?.status === "cancelled" && bH?.payment_status === "INITIATED" && payableAudits("seva_booking", bH?.id).includes("hold_expired"), "the sweep cancels the unpaid booking and audits hold_expired; the payment stays INITIATED", show([sweepH, bH?.status, bH?.payment_status]));
  check(notes("seva_booking", bH?.id).length === 0 && notes("payment", txn(numH)?.id).length === 0, "no message on hold expiry");
  await press(simH.forms, "success");
  const bH2 = booking(numH);
  check(bH2?.payment_status === "SUCCESS" && bH2?.status === "pending" && RECEIPT_RE.test(bH2?.receipt_number ?? "") && payableAudits("seva_booking", bH2?.id).includes("booking_restored"), "a late success makes the payment SUCCESS and the booking pending again; audit booking_restored", show([bH2?.payment_status, bH2?.status, payableAudits("seva_booking", bH2?.id)]));
  check(notes("payment", txn(numH)?.id).length === 1 && notes("payment", txn(numH)?.id)[0].event === "payment.succeeded", "payment.succeeded is sent for the late payment");
  const sweepAgain = await sweep({ order_ids: [numH], expire_holds: true });
  check(sweepAgain.expired === 0 && booking(numH)?.status === "pending", "a paid booking is never expired");

  section("6d. a booking the office cancelled cannot be paid for; one its hold cancelled still can");
  const O = await createSeva({ seva_id: 2, devotee_name: `${NAME} Office Cancel`, phone: PHONE, phoneCountry: "IN", acceptTerms: true, lang: "en" });
  const numO = O.data?.number ?? "";
  const simO = await openCheckout(O);
  await press(simO.forms, "failure");
  check(booking(numO)?.payment_status === "FAILED" && (await status(numO, O.data?.token)).data?.canRetry === true, "a declined booking payment offers a retry", show(booking(numO)?.payment_status));
  sql("UPDATE seva_bookings SET status = 'cancelled' WHERE order_number = ?", [numO]); // the office's Cancel action
  r = await retry(numO, O.data?.token);
  check(r.status === 409 && r.data?.code === "not_retryable" && r.data?.status === "FAILED" && txn(`${numO}-R2`) === null, "once the office cancels the booking, retry → 409 not_retryable and no new attempt", `${r.status} ${r.text}`);
  check((await status(numO, O.data?.token)).data?.canRetry === false, "and the status page offers no retry");
  const K = await createSeva({ seva_id: 2, devotee_name: `${NAME} Hold Cancel`, phone: PHONE, phoneCountry: "IN", acceptTerms: true, lang: "en" });
  const numK = K.data?.number ?? "";
  const simK = await openCheckout(K);
  await press(simK.forms, "failure");
  fixture("backdate", { number: numK, hold_minutes: 1 });
  const sweepK = await sweep({ order_ids: [numK], expire_holds: true });
  check(sweepK.expired === 1 && booking(numK)?.status === "cancelled", "the hold expires and the sweep cancels the unpaid booking");
  r = await retry(numK, K.data?.token);
  check(r.status === 201 && r.data?.number === numK && txn(`${numK}-R2`)?.status === "INITIATED", "a booking cancelled only by its hold expiring can still be tried again (the payment restores it)", `${r.status} ${r.text.slice(0, 200)}`);

  /* ── 7. Donors and the existing contracts ────────────────────────────── */
  section("7. /api/donors and the pledge and request-only contracts");
  const donors = await http("GET", "/api/donors", { ip: IP.legacy });
  const mine = (donors.data ?? []).filter((x) => String(x.name).startsWith(NAME));
  check(donors.status === 200 && mine.length === 1 && mine[0].name === A.name && mine[0].label === "General Donation" && mine[0].type === "donor" && keysOf(mine[0]) === JSON.stringify(["name", "label", "type"]), "donors lists only the SUCCESS donation that ticked the list, labelled with the category's English name", show(mine));
  const listed = new Set((donors.data ?? []).map((x) => x.name));
  check(!listed.has(`${NAME} Cancelled`) && !listed.has(`${NAME} Tampered Amount`) && !listed.has(`${NAME} No Email`), "a CANCELLED or PENDING donation with consent, and a paid one without consent, are not listed", [...listed].filter((n) => n.startsWith(NAME)).join(" | "));
  const pledge = await http("POST", "/api/donations", { json: { name: `${NAME} Pledge`, phone: "9000012345", amount: 21, purpose: "annadanam" }, ip: IP.legacy });
  const pledgeRow = one("SELECT source, status, donation_number, currency FROM donations WHERE name = ?", [`${NAME} Pledge`]);
  check(pledge.status === 201 && pledge.data?.success === true && Number(pledge.data?.id) > 0 && keysOf(pledge.data) === '["success","id"]', "POST /api/donations still answers 201 {success, id}", `${pledge.status} ${pledge.text}`);
  check(pledgeRow?.source === "pledge" && pledgeRow?.status === null && pledgeRow?.donation_number === null && pledgeRow?.currency === "INR", "a pledge is stored as a pledge: no status, no number", show(pledgeRow));
  const request = await http("POST", "/api/seva-bookings", { json: { devotee_name: `${NAME} Request`, phone: "9000012345", phoneCountry: "IN", seva_name: "Archana" }, ip: IP.legacy });
  const requestRow = one("SELECT payment_mode, payment_status, order_number, status FROM seva_bookings WHERE devotee_name = ?", [`${NAME} Request`]);
  check(request.status === 201 && request.data?.success === true && Number(request.data?.id) > 0 && keysOf(request.data) === '["success","id"]', "POST /api/seva-bookings still answers 201 {success, id}", `${request.status} ${request.text}`);
  check(requestRow?.payment_mode === "offline" && requestRow?.payment_status === null && requestRow?.order_number === null && requestRow?.status === "pending", "a request-only booking is offline with no payment status", show(requestRow));

  /* ── 8. Payments switched off ────────────────────────────────────────── */
  section("8. with payments switched off (a second server with enabled=0)");
  const off = await restartServer({ PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({ ...OVERLAY, enabled: "0", notify_email: "0" }) });
  check(off, "the server restarts with the disabled overlay", server?.log.slice(0, 400));
  r = await http("GET", "/api/payments/config", { ip: IP.off });
  check(r.status === 200 && r.data?.enabled === false && r.data?.ready === false && keysOf(r.data) === JSON.stringify(CONFIG_KEYS), "config answers 200 with enabled and ready false", show(r.data));
  r = await create(donation("Off"), { ip: IP.off, lane: false });
  check(r.status === 503 && r.data?.code === "payments_unavailable" && typeof r.data?.error === "string", "POST donations → 503 payments_unavailable", `${r.status} ${r.text}`);
  check(!one("SELECT id FROM donations WHERE name = ?", [`${NAME} Off`]), "and nothing is created");
  r = await createSeva(sevaBody({ devotee_name: `${NAME} Off Seva` }), { ip: IP.off, lane: false });
  check(r.status === 503 && r.data?.code === "payments_unavailable", "POST seva-bookings → 503");
  r = await retry(C.number, C.token, { ip: IP.off, lane: false });
  check(r.status === 503 && r.data?.code === "payments_unavailable", "retry → 503 (the token is still checked first)");
  r = await retry(C.number, "bad", { ip: IP.off, lane: false });
  check(r.status === 403 && r.data?.code === "bad_token", "retry with a bad token → 403 even when off");
  r = await http("GET", `/api/payments/status?ref=${numA}&t=${tokA}`, { ip: IP.off });
  check(r.status === 200 && r.data?.status === "SUCCESS", "a donor can still read the status of a paid donation");
  r = await http("POST", "/api/payments/receipt-email", { json: { ref: numA, t: tokA }, ip: IP.off });
  check(r.status === 409 && r.data?.code === "email_off", "receipt-email with email messages off → 409 email_off", `${r.status} ${r.text}`);
  r = await http("GET", "/api/payments/config", { ip: IP.off });
  check(!r.text.includes(KEYS.merchantId) && !r.text.includes(KEYS.workingKey) && !r.text.includes(KEYS.accessCode), "still no credential in the config");

  /* ── 9. Secrecy and hygiene ──────────────────────────────────────────── */
  section("9. the working key and access code never leave PHP");
  const stripped = bodies.map((t) => {
    try {
      const j = JSON.parse(t);
      if (j?.gateway?.fields?.access_code) delete j.gateway.fields.access_code;
      return JSON.stringify(j);
    } catch {
      return t;
    }
  });
  check(!stripped.some((t) => t.includes(KEYS.workingKey)), "the working key appears in no response body");
  check(!stripped.some((t) => t.includes(KEYS.accessCode)), "the access code appears in no response body except the checkout form fields");
  check(!stripped.some((t) => t.includes(KEYS.merchantId)), "the merchant id appears in no response body");
  const like = (s) => `%${s}%`;
  check(Number(one("SELECT COUNT(*) c FROM payment_transactions WHERE CAST(gateway_response AS CHAR) LIKE ? OR CAST(gateway_response AS CHAR) LIKE ?", [like(KEYS.workingKey), like(KEYS.accessCode)])?.c) === 0, "no key or access code in payment_transactions.gateway_response");
  check(Number(one("SELECT COUNT(*) c FROM payment_audit_log WHERE detail LIKE ? OR detail LIKE ? OR CAST(data AS CHAR) LIKE ? OR CAST(data AS CHAR) LIKE ?", [like(KEYS.workingKey), like(KEYS.accessCode), like(KEYS.workingKey), like(KEYS.accessCode)])?.c) === 0, "no key or access code in payment_audit_log");
  check(Number(one("SELECT COUNT(*) c FROM notifications WHERE title LIKE ? OR body LIKE ? OR CAST(vars AS CHAR) LIKE ? OR body LIKE ? OR CAST(vars AS CHAR) LIKE ?", [like(KEYS.workingKey), like(KEYS.workingKey), like(KEYS.workingKey), like(KEYS.accessCode), like(KEYS.accessCode)])?.c) === 0, "no key or access code in notifications");
  const logDir = join(ROOT, "backend", "logs");
  const logHits = [];
  if (existsSync(logDir)) {
    for (const f of readdirSync(logDir)) {
      if (!/\.log$/i.test(f)) continue;
      const text = readFileSync(join(logDir, f), "utf8");
      if (text.includes(KEYS.workingKey) || text.includes(KEYS.accessCode)) logHits.push(f);
    }
  }
  check(logHits.length === 0, "no key or access code in backend/logs/*", logHits.join(", "));
  const allLogs = serverLogs + (server?.log ?? "");
  check(!allLogs.includes(KEYS.workingKey) && !allLogs.includes(KEYS.accessCode), "no key or access code in the PHP server's own output");
  const noise = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error)/.exec(allLogs);
  check(!noise, "no PHP warnings, notices or fatals from the server", noise ? allLogs.slice(Math.max(0, noise.index - 200), noise.index + 300) : "");
  check(phpNoise.length === 0, "no PHP warnings, notices or fatals from the fixtures or the CLI sweep", phpNoise.slice(0, 5).join(" | "));
  check(serverErrors.length === 0, "no request answered 5xx", serverErrors.slice(0, 3).join(" | "));
  check(cookies.length === 0, "no response set a cookie", cookies.slice(0, 3).join(" | "));
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  section("Cleanup");
  try {
    const issued = Number(one(
      "SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE ? AND receipt_number LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ? AND receipt_number LIKE ?) AS c",
      [`${PREFIX}%`, `TEST-${istYear}-%`, `${PREFIX}%`, `TEST-${istYear}-%`],
    )?.c);
    const removed = cleanup();
    console.log(`  removed ${show(removed)}`);
    const left = Number(one(
      "SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?) + (SELECT COUNT(*) FROM sevas WHERE name_en LIKE ?) + (SELECT COUNT(*) FROM rate_limits WHERE bucket REGEXP ?) AS c",
      [`${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, BUCKETS_REGEXP],
    )?.c);
    check(left === 0, "cleanup removed every row and bucket this suite created", `${left} left`);
    // Give the receipt numbers back, but only if nobody else issued one meanwhile.
    const now = one("SELECT value FROM payment_counters WHERE name = ?", [COUNTER])?.value ?? null;
    const before = counterBefore === null ? 0 : Number(counterBefore);
    if (now !== null && Number(now) === before + issued) {
      if (counterBefore === null) sql("DELETE FROM payment_counters WHERE name = ?", [COUNTER]);
      else sql("UPDATE payment_counters SET value = ? WHERE name = ?", [before, COUNTER]);
      console.log(`  ${COUNTER} put back to ${counterBefore ?? "(absent)"} (this run issued ${issued})`);
    } else {
      console.log(`  ${COUNTER} left at ${now} (before ${counterBefore ?? "absent"}, this run issued ${issued})`);
    }
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
  await stopPhpServer(server);
  if (mock) await mock.close();
  // What the server itself reported (error_log lines), for whoever reads a failure.
  const reported = (serverLogs + (server?.log ?? "")).split(/\r?\n/).filter((l) => /\[payments|\[notify|PHP (Warning|Notice|Deprecated|Fatal)/.test(l));
  if (reported.length) console.log(`  server log (${reported.length} line(s)):\n${reported.slice(0, 40).map((l) => `    ${l.slice(0, 400)}`).join("\n")}`);
  const stillOpen = [];
  for (const port of Object.values(PORT)) if (await portInUse(port)) stillOpen.push(port);
  if (stillOpen.length) console.log(`  WARNING ports still listening: ${stillOpen.join(", ")}`);
  else console.log(`  ports ${PORT.php} and ${PORT.mock} are closed again`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
