#!/usr/bin/env node
/**
 * tests/public-pages.mjs — the Sponsorship and Deities pages (brief §6
 * Sponsorship, §6 Deities, §11 publish consent, §22 SEO, §23 accessibility,
 * §24 360 / 1366; §30 E2E-009 / 010 sponsor with and without consent).
 *
 *   PHP_BIN=/path/to/php node tests/public-pages.mjs
 *
 * Starts its own PHP server on 127.0.0.1:8102 with the payments simulator
 * switched on (so online giving is "usable" and the sponsor links point at
 * /donate) and its own Vite on 127.0.0.1:5182 proxying /api and /uploads to it;
 * the shared :8000 / :5173 are never touched. Chromium and axe-core come from
 * frontend/node_modules.
 *
 * What it proves
 *   API      GET /api/poojas?sponsorship=1 lists only active, upcoming poojas
 *            open for sponsorship (closed, past and hidden ones are left out),
 *            composes with ?type and ?past, and leaves the unfiltered list as it
 *            was; each item carries both names, the typed time, the amount and
 *            the consented sponsor's public name only — the sponsor who did not
 *            consent, and every phone, e-mail and amount of a sponsor, never
 *            appear, and withdrawing consent takes the name off at once.
 *            GET /api/donors carries the consented sponsor (type "sponsor",
 *            pooja in both languages) and never the other; GET /api/deities
 *            carries a shown deity and never a hidden one.
 *   Crawler  api/og.php answers a WhatsApp unfurler for /deities and
 *            /sponsorship in Tamil and in English with site_pages.php's words,
 *            an absolute image and the page's own canonical; sitemap.xml lists
 *            both; the SPA fallback (api/spa.php) answers them 200 and a
 *            sub-path of either 404.
 *   Browser  /sponsorship and /deities in Tamil and English at 360 and 1366:
 *            one h1, the seeded sponsorship with its type, date, time, amount,
 *            both names and "Sponsored by <family>", the open one "Open", the
 *            "Sponsor" link to /donate?pooja=<id> (followed through to the
 *            donate page, which names the pooja), the thank-you list with the
 *            consented sponsor and never the other; the deity with its image,
 *            both names and description in display order, a hidden deity
 *            absent and a broken image replaced by the mark; og:title and
 *            og:description as og.php states them; no horizontal overflow, no
 *            console errors, axe clean (serious / critical).
 *            With online giving off the link becomes the office phone from the
 *            site settings; empty and failed feeds show their states (the retry
 *            recovers); the drawer (360) and the footer (both widths) reach
 *            both pages while the desktop header row keeps its eight entries.
 *
 * Data: poojas, sponsors and deities named "E2E-PAGES-<run> …" (deity slugs
 * "e2e-pages-<run>-…") and one PNG "backend/uploads/e2e-pages-<run>-deity.png",
 * written through tests/support/live_fixtures.php `sql` and removed in
 * `finally` by prefix (this run's and any earlier run's that was cut short),
 * never by id. Seeded poojas are dated 300+ days out with the lowest-priority
 * types (monthly, daily), so the site's own "next pooja" never changes for
 * another suite running against the same database.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FRONTEND = resolve(ROOT, "frontend");
const UPLOADS = resolve(ROOT, "backend/uploads");
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(resolve(FRONTEND, "node_modules/axe-core/axe.min.js"), "utf8");

const PHP_BIN = process.env.PHP_BIN || "php";
const PHP_PORT = 8102;
const VITE_PORT = 5182;
const PHP_BASE = `http://127.0.0.1:${PHP_PORT}`;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const RUN = Date.now().toString(36);
const PREFIX = `E2E-PAGES-${RUN}`;
const FILE_PREFIX = "e2e-pages-";
const SHOTS = process.env.PAGES_SHOTS || resolve(ROOT, "shots/public-pages");
mkdirSync(SHOTS, { recursive: true });

// The simulator, so online giving is "usable" and the Sponsor links point at
// /donate. Fake values chosen here; nothing real is read or written.
const SERVER_ENV = {
  PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SECRET: "e2e-pages-fake-secret-0123456789abcdef-not-real",
  PAYMENTS_SETTINGS_KEY: Buffer.from("e2e-pages-fake-settings-key!!!!!").toString("base64"),
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({ enabled: "1", mode: "simulator" }),
  SITE_URL: BASE,
  TRUSTED_PROXIES: "127.0.0.1,::1",
  CORS_ORIGIN: "*",
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_SMS_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "test",
};

/* The words backend/includes/site_pages.php gives each page, as the React pages pass them to <Seo>. */
const PAGE_WORDS = {
  "/deities": {
    ta: ["குலதெய்வங்கள்", "கோயிலில் அருள்பாலிக்கும் தெய்வங்கள் — ஒவ்வொருவரின் பெயர், விவரம் மற்றும் திருவுருவப் படம்."],
    en: ["Deities", "The deities worshipped at the temple — the name, description and image of each."],
  },
  "/sponsorship": {
    ta: ["பூஜை உபயம்", "வரவிருக்கும் பூஜைகளில் உபயம் அளித்து ஆசி பெறுங்கள்; பெயர் வெளியிட அனுமதி அளித்த உபயதாரர்களுக்கு இங்கே நன்றி."],
    en: ["Sponsorship", "Sponsor an upcoming pooja and receive the blessings; sponsors who agreed to be named are thanked here."],
  },
};

/* ── Reporting ──────────────────────────────────────────────────────────── */

let passed = 0;
let failed = 0;
function check(cond, name, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}`);
    if (detail) console.log(`    ${String(detail).replace(/\s+/g, " ").slice(0, 700)}`);
  }
  return Boolean(cond);
}
const section = (title) => console.log(`\n── ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const openPages = new Set();
async function scenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(false, `${name} (scenario threw)`, String(e?.stack || e).split("\n").slice(0, 3).join(" "));
    for (const page of openPages) {
      try {
        console.log(`    at ${page.url()}`);
        const errs = page.errors();
        if (errs.length) console.log(`    browser: ${errs.slice(0, 3).join(" | ").slice(0, 600)}`);
        await page.screenshot({ path: resolve(SHOTS, `fail-${name.replace(/\W+/g, "-")}.png`), fullPage: true });
        await page.context().close();
      } catch {
        /* already closed */
      }
    }
  }
}

/* ── PHP fixtures (tests/support/live_fixtures.php) ─────────────────────── */

const viaBash = /\.sh$/i.test(PHP_BIN);
/** JSON for argv: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

function fixtures(cmd, obj = {}) {
  const args = ["tests/support/live_fixtures.php", cmd, arg(obj)];
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...SERVER_ENV },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`fixtures ${cmd} printed no JSON (exit ${r.status}): ${(r.stdout || "").slice(-300)} ${(r.stderr || "").slice(-300)}`);
  }
}
// No backslashes in statements: Git Bash strips them on the way to a php.sh.
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r;
}
const rows = (query, params = []) => sql(query, params).rows;

/* ── Dates in the temple's own day (IST) ────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIST = () => ymd(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })));
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
const TODAY = todayIST();
/** lib/payments.js formatPlainDate, exactly. */
const plainDate = (day, lang) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
};
/** lib/money.js formatMoney for a whole INR amount. */
const rupees = (n, lang) => new Intl.NumberFormat(lang === "ta" ? "ta-IN" : "en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n);

/* ── Seed data ──────────────────────────────────────────────────────────── */

// A 1×1 PNG: a real image the browser decodes.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const IMAGE_FILE = `${FILE_PREFIX}${RUN}-deity.png`;
const MISSING_FILE = `${FILE_PREFIX}${RUN}-missing.png`;
/** The browser's report of that one missing picture — expected, and nothing else. */
const MISSING_404 = new RegExp(`status of 404 .*/uploads/${MISSING_FILE.replace(/[.-]/g, (c) => `\\${c}`)}$`);

const N = {
  sponsored: { ta: `மாதாந்திர உபய பூஜை ${RUN}`, en: `${PREFIX} Monthly Sponsored Pooja` },
  sponsoredDesc: { ta: `உபயதாரர் குடும்பத்தின் சார்பில் சிறப்பு அர்ச்சனை ${RUN}`, en: `Special archana on behalf of the sponsoring family ${RUN}` },
  open: { ta: `தினசரி திறந்த பூஜை ${RUN}`, en: `${PREFIX} Daily Open Pooja` },
  closed: { ta: `நிறைவான பூஜை ${RUN}`, en: `${PREFIX} Closed Pooja` },
  past: { ta: `கடந்த பூஜை ${RUN}`, en: `${PREFIX} Past Pooja` },
  hidden: { ta: `மறைந்த பூஜை ${RUN}`, en: `${PREFIX} Hidden Pooja` },
  family: `${PREFIX} Consented Family`,
  person: `${PREFIX} Sponsor Person`,
  note: `${PREFIX} in memory of our elders`,
  privateA: `${PREFIX} Private Sponsor A`,
  privateFamilyA: `${PREFIX} Private Family A`,
  privateB: `${PREFIX} Private Sponsor B`,
  phone: "9000012345",
  email: `e2e-pages-${RUN}@example.test`,
  deity: { ta: `ஸ்ரீ சோதனை அம்மன் ${RUN}`, en: `${PREFIX} Sri Test Amman` },
  deityDesc: { ta: `அம்மனின் தமிழ் விளக்கம் ${RUN}`, en: `The goddess described in English ${RUN}` },
  broken: { ta: `ஸ்ரீ உடைந்த படம் ${RUN}`, en: `${PREFIX} Sri Broken Image` },
  hiddenDeity: { ta: `ஸ்ரீ மறைந்த தெய்வம் ${RUN}`, en: `${PREFIX} Sri Hidden Deity` },
};
const PRIVATE_BITS = [N.privateA, N.privateFamilyA, N.privateB, N.person, N.phone, N.email];
const seed = { sponsored: 0, open: 0, closed: 0, past: 0, hidden: 0, deity: 0, broken: 0, hiddenDeity: 0 };
const idOf = (table, column, value) => Number(rows(`SELECT id FROM ${table} WHERE ${column} = ? ORDER BY id DESC LIMIT 1`, [value])[0]?.id);

function seedRows() {
  const pooja = (names, desc, date, start, end, type, amount, available, active) =>
    sql(
      `INSERT INTO poojas (name_ta, name_en, description_ta, description_en, pooja_date, pooja_time, start_time, end_time, pooja_type,
         recurrence_type, sponsorship_amount, sponsorship_available, banner_url, is_featured, live_stream_enabled, is_active)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 'none', ?, ?, NULL, 0, 0, ?)`,
      [names.ta, names.en, desc?.ta ?? null, desc?.en ?? null, date, start, end, type, amount, available, active],
    );
  pooja(N.sponsored, N.sponsoredDesc, addDays(TODAY, 300), "18:00:00", "20:30:00", "monthly", 2501, 1, 1);
  seed.sponsored = idOf("poojas", "name_en", N.sponsored.en);
  pooja(N.open, null, addDays(TODAY, 301), "06:00:00", null, "daily", 1001, 1, 1);
  seed.open = idOf("poojas", "name_en", N.open.en);
  pooja(N.closed, null, addDays(TODAY, 302), "07:00:00", null, "daily", 1501, 0, 1);
  seed.closed = idOf("poojas", "name_en", N.closed.en);
  pooja(N.past, null, addDays(TODAY, -3), "07:00:00", null, "daily", 501, 1, 1);
  seed.past = idOf("poojas", "name_en", N.past.en);
  pooja(N.hidden, null, addDays(TODAY, 303), "07:00:00", null, "daily", 701, 1, 0);
  seed.hidden = idOf("poojas", "name_en", N.hidden.en);

  // Brief §11 / E2E-009 / 010: two sponsors of one pooja, only one of whom
  // agreed to be named, and a pooja whose only sponsor did not agree.
  const sponsor = (name, family, poojaId, consent, note = null) =>
    sql(
      `INSERT INTO sponsors (name, family_name, phone, email, note, pooja_id, amount, payment_status, publish_consent, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 2501.00, 'PAID', ?, 1)`,
      [name, family, N.phone, N.email, note, poojaId, consent],
    );
  sponsor(N.person, N.family, seed.sponsored, 1, N.note);
  sponsor(N.privateA, N.privateFamilyA, seed.sponsored, 0);
  sponsor(N.privateB, null, seed.open, 0);

  // Display order far below the temple's own deities (10 / 20 / 30), so no
  // other suite's idea of "the first deity" changes.
  const temple = Number(rows("SELECT id FROM temples WHERE slug = 'pudupatti' LIMIT 1")[0]?.id ?? rows("SELECT id FROM temples ORDER BY id LIMIT 1")[0]?.id);
  writeFileSync(resolve(UPLOADS, IMAGE_FILE), PNG);
  const deity = (slug, names, desc, image, sort, active) =>
    sql(
      `INSERT INTO deities (temple_id, slug, name_ta, name_en, description_ta, description_en, image_url, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP())`,
      [temple, slug, names.ta, names.en, desc?.ta ?? null, desc?.en ?? null, image, sort, active],
    );
  deity(`${FILE_PREFIX}${RUN}-shown`, N.deity, N.deityDesc, `/uploads/${IMAGE_FILE}`, 950, 1);
  seed.deity = idOf("deities", "name_en", N.deity.en);
  deity(`${FILE_PREFIX}${RUN}-broken`, N.broken, null, `/uploads/${MISSING_FILE}`, 951, 1);
  seed.broken = idOf("deities", "name_en", N.broken.en);
  deity(`${FILE_PREFIX}${RUN}-hidden`, N.hiddenDeity, null, null, 949, 0);
  seed.hiddenDeity = idOf("deities", "name_en", N.hiddenDeity.en);
}

/** Every row and file of this suite's prefix — this run's and any earlier run's that was cut short. */
function cleanup() {
  const out = {};
  const del = (label, query, params) => (out[label] = sql(query, params).affected);
  del("sponsors", "DELETE FROM sponsors WHERE name LIKE ? OR family_name LIKE ?", ["E2E-PAGES-%", "E2E-PAGES-%"]);
  del("poojas", "DELETE FROM poojas WHERE name_en LIKE ?", ["E2E-PAGES-%"]);
  del("deities", "DELETE FROM deities WHERE name_en LIKE ? AND slug LIKE ?", ["E2E-PAGES-%", "e2e-pages-%"]);
  let files = 0;
  for (const name of readdirSync(UPLOADS)) {
    if (name.startsWith(FILE_PREFIX) && name.endsWith(".png")) {
      try {
        unlinkSync(resolve(UPLOADS, name));
        files += 1;
      } catch {
        /* already gone */
      }
    }
  }
  out.files = files;
  return out;
}

/* ── Servers ────────────────────────────────────────────────────────────── */

function portInUse(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const sock = connect({ port, host });
    sock.once("connect", () => {
      sock.destroy();
      done(true);
    });
    sock.once("error", () => done(false));
  });
}

function startPhp() {
  const args = ["-S", `127.0.0.1:${PHP_PORT}`, "router.php"];
  const child = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: resolve(ROOT, "backend"),
    env: { ...process.env, ...SERVER_ENV },
    windowsHide: true,
  });
  const server = { child, port: PHP_PORT, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  return server;
}

function startVite() {
  // NODE_OPTIONS may carry the suites' fetch preload; Vite does not need it.
  const env = { ...process.env, VITE_PROXY_TARGET: PHP_BASE };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, [resolve(FRONTEND, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: FRONTEND,
    env,
    windowsHide: true,
  });
  const server = { child, port: VITE_PORT, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  return server;
}

async function waitForUrl(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      await res.arrayBuffer().catch(() => {});
      if (res.status < 500) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return false;
}

async function stopServer(server, hosts) {
  if (!server) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  else server.child.kill("SIGTERM");
  for (let i = 0; i < 20; i += 1) {
    let busy = false;
    for (const h of hosts) if (await portInUse(server.port, h)) busy = true;
    if (!busy) return;
    await sleep(250);
  }
  if (process.platform === "win32") {
    // The port is this suite's own; whatever still holds it is ours.
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "LISTENING" && (cols[1] ?? "").endsWith(`:${server.port}`)) {
        spawnSync("taskkill", ["/pid", cols[4], "/T", "/F"], { windowsHide: true });
      }
    }
  }
}

/* ── HTTP helpers ───────────────────────────────────────────────────────── */

async function api(path) {
  const res = await fetch(PHP_BASE + path, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* checked by callers */
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** What a link unfurler is told (router.php → api/og.php). */
async function preview(path, { lang, ua = "WhatsApp/2.23.20.0 A" } = {}) {
  const headers = { "user-agent": ua };
  if (lang === "en") headers["accept-language"] = "en-GB,en;q=0.9";
  const res = await fetch(PHP_BASE + path, { headers, redirect: "manual" });
  const html = await res.text();
  const meta = {};
  for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) {
    meta[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: res.status, html, meta, canonical };
}

/* ── Browser ────────────────────────────────────────────────────────────── */

let browser;
const IGNORE = /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|Download the React DevTools|workbox|sw\.js|React Router Future Flag/;

async function newPage({ width = 1366, height = 900, lang = "en" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: lang === "ta" ? "ta-IN" : "en-IN", timezoneId: "Asia/Kolkata" });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem("temple:lang", l);
      localStorage.setItem("templeVisited", "1");
    } catch {
      /* private mode */
    }
  }, lang);
  const page = await ctx.newPage();
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(90000);
  const errors = [];
  const allowed = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()} @ ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!IGNORE.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`);
  });
  page.allowErrors = (re) => allowed.push(re);
  // The seeded deity whose picture is missing on purpose: any page that lists
  // the deities asks for it once, and the 404 is the point of that row.
  allowed.push(MISSING_404);
  page.errors = () => errors.filter((e) => !IGNORE.test(e) && !allowed.some((re) => re.test(e)));
  openPages.add(page);
  ctx.on("close", () => openPages.delete(page));
  return page;
}

const shot = (page, name) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
async function axe(page) {
  await page.addScriptTag({ content: axeSource });
  // Cards fade in (opacity 0 → 1): a contrast check taken mid-fade reads a
  // colour nobody ever sees, so wait for every finite animation first.
  await page
    .evaluate(() =>
      Promise.race([
        Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getTiming?.().iterations ?? 1)).map((a) => a.finished.catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]),
    )
    .catch(() => {});
  return page.evaluate(async () => {
    const res = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
      rules: { "color-contrast": { enabled: true } },
    });
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
  });
}
const text = async (loc) => ((await loc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const headMeta = (page) =>
  page.evaluate(() => ({
    title: document.title,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? "",
    ogDesc: document.querySelector('meta[property="og:description"]')?.content ?? "",
    htmlLang: document.documentElement.lang,
  }));
/** Wait until <Seo> has written this page's own og:title (Helmet commits after the first render). */
const seoSettled = (page, want) =>
  page.waitForFunction((w) => document.querySelector('meta[property="og:title"]')?.content === w, want, { timeout: 15000 }).catch(() => {});

/* ── Scenarios ──────────────────────────────────────────────────────────── */

const ogAnswers = {}; // path → lang → { title, description } as og.php states them
let officeTel = "";

async function sponsorshipPage(lang, width) {
  const tag = `/sponsorship ${lang} @${width}`;
  const L = (ta, en) => (lang === "ta" ? ta : en);
  const other = lang === "ta" ? "en" : "ta";
  const page = await newPage({ width, lang });
  await page.goto(`${BASE}/sponsorship`, { waitUntil: "domcontentloaded" });
  const card = page.locator(`[data-testid="sponsorship-item"][data-pooja-id="${seed.sponsored}"]`);
  await card.waitFor();
  const [title, lead] = PAGE_WORDS["/sponsorship"][lang];
  await seoSettled(page, title);

  const h1s = await page.locator("h1").allTextContents();
  check(h1s.length === 1 && h1s[0].trim() === title, `${tag}: one h1, "${title}"`, JSON.stringify(h1s));
  const head = await headMeta(page);
  check(head.htmlLang === lang, `${tag}: <html lang> is ${lang}`, head.htmlLang);
  check(await page.getByText(lead, { exact: true }).first().isVisible(), `${tag}: the lead sentence is on the page`);
  check(
    head.ogTitle === ogAnswers["/sponsorship"][lang].title && head.ogDesc === ogAnswers["/sponsorship"][lang].description,
    `${tag}: og:title and og:description are the ones og.php gives a crawler`,
    `page "${head.ogTitle}" / "${head.ogDesc}" vs og.php "${ogAnswers["/sponsorship"][lang].title}" / "${ogAnswers["/sponsorship"][lang].description}"`,
  );
  check(head.title.startsWith(`${title} — `), `${tag}: the document title leads with the page title`, head.title);

  // The sponsored pooja: type, both names, date, time, description, amount, status.
  const c = await text(card);
  const apiItem = ogAnswers.apiSponsored;
  check(c.includes(N.sponsored[lang]), `${tag}: the pooja's name in the reading language`, c);
  check(
    (await card.locator(`[lang="${other}"]`).first().textContent().catch(() => "")).trim() === N.sponsored[other],
    `${tag}: …and its name in the other language, marked lang="${other}"`,
  );
  check(c.includes(L("மாதாந்திர பூஜை", "Monthly pooja")), `${tag}: the pooja's type`, c);
  check(c.includes(plainDate(addDays(TODAY, 300), lang)), `${tag}: its date, written out`, `${plainDate(addDays(TODAY, 300), lang)} in ${c}`);
  check(!!apiItem?.time && c.includes(apiItem.time), `${tag}: its time from the API ("${apiItem?.time}")`, c);
  check(c.includes(N.sponsoredDesc[lang]), `${tag}: its description in the reading language`);
  check(c.includes(rupees(2501, lang)), `${tag}: the sponsorship amount ${rupees(2501, lang)}`, c);
  const status = await text(card.locator('[data-status="sponsored"]'));
  check(status === L(`உபயம்: ${N.family}`, `Sponsored by ${N.family}`), `${tag}: status "Sponsored by <the consented family>"`, status);
  check((await card.locator('[data-status="open"]').count()) === 0, `${tag}: …and not also "Open"`);
  const inset = await card.evaluate((el) => el.querySelector("h3").getBoundingClientRect().left - el.getBoundingClientRect().left);
  check(inset >= 12, `${tag}: the card's content sits inside its padding, not on its edge`, `${inset}px`);

  // The open pooja: its only sponsor withheld consent, so it is simply open.
  const openCard = page.locator(`[data-testid="sponsorship-item"][data-pooja-id="${seed.open}"]`);
  const openStatus = await text(openCard.locator('[data-status="open"]'));
  check(openStatus === L("உபயத்திற்குத் திறந்துள்ளது", "Open"), `${tag}: the pooja without a consented sponsor says "${L("உபயத்திற்குத் திறந்துள்ளது", "Open")}"`, openStatus);
  check((await openCard.locator('[data-status="sponsored"]').count()) === 0, `${tag}: …with no sponsor named`);

  // Closed, past and hidden poojas are not "available sponsorships".
  for (const [label, id] of [["closed", seed.closed], ["past", seed.past], ["hidden", seed.hidden]]) {
    check((await page.locator(`[data-pooja-id="${id}"]`).count()) === 0, `${tag}: the ${label} pooja is not listed`);
  }

  // The Sponsor call to action (online giving is on in this server).
  const cta = card.locator('[data-testid="sponsor-cta"]');
  await cta.waitFor();
  check((await cta.getAttribute("href")) === `/donate?pooja=${seed.sponsored}`, `${tag}: "Sponsor" links to /donate?pooja=<id>`, await cta.getAttribute("href"));
  check((await text(cta)) === L("உபயம் அளிக்க", "Sponsor"), `${tag}: …and reads "${L("உபயம் அளிக்க", "Sponsor")}"`, await text(cta));
  check(
    (await openCard.locator('[data-testid="sponsor-cta"]').getAttribute("href")) === `/donate?pooja=${seed.open}`,
    `${tag}: the open pooja links to its own /donate?pooja=<id>`,
  );

  // The thank-you list: the consented sponsor with the pooja and the note; never the other.
  const thanks = page.locator('[data-testid="sponsorship-thanks"]');
  await thanks.waitFor();
  const mine = thanks.locator('[data-testid="sponsor-thanks-item"]', { hasText: N.family });
  check((await mine.count()) === 1, `${tag}: the thank-you list names the consented sponsor`);
  const mineText = await text(mine.first());
  check(mineText.includes(N.sponsored[lang]) && mineText.includes(N.note), `${tag}: …with the pooja in the reading language and the committee's note`, mineText);
  const body = await text(page.locator("main"));
  const leaked = PRIVATE_BITS.filter((bit) => body.includes(bit));
  check(leaked.length === 0, `${tag}: no sponsor who withheld consent, and no phone or e-mail, anywhere on the page`, leaked.join(", "));

  // Reachable without the header row: the footer names both pages.
  check((await page.locator('footer a[href="/sponsorship"]').count()) === 1 && (await page.locator('footer a[href="/deities"]').count()) === 1, `${tag}: the footer's quick links reach /sponsorship and /deities`);

  check(!(await overflow(page)), `${tag}: no horizontal overflow`);
  const v = await axe(page);
  check(v.length === 0, `${tag}: axe serious/critical violations`, v.join("\n      "));
  await shot(page, `sponsorship-${lang}-${width}`);
  const errs = page.errors();
  check(errs.length === 0, `${tag}: no console errors`, errs.join(" | "));
  await page.context().close();
}

async function deitiesPage(lang, width) {
  const tag = `/deities ${lang} @${width}`;
  const other = lang === "ta" ? "en" : "ta";
  const page = await newPage({ width, lang });
  await page.goto(`${BASE}/deities`, { waitUntil: "domcontentloaded" });
  const card = page.locator(`[data-testid="deity-card"][data-deity-id="${seed.deity}"]`);
  await card.waitFor();
  const [title, lead] = PAGE_WORDS["/deities"][lang];
  await seoSettled(page, title);

  const h1s = await page.locator("h1").allTextContents();
  check(h1s.length === 1 && h1s[0].trim() === title, `${tag}: one h1, "${title}"`, JSON.stringify(h1s));
  check(await page.getByText(lead, { exact: true }).first().isVisible(), `${tag}: the lead sentence is on the page`);
  const head = await headMeta(page);
  check(
    head.ogTitle === ogAnswers["/deities"][lang].title && head.ogDesc === ogAnswers["/deities"][lang].description,
    `${tag}: og:title and og:description are the ones og.php gives a crawler`,
    `page "${head.ogTitle}" / "${head.ogDesc}"`,
  );

  // The seeded deity: both names, the description in the reading language, the picture.
  check((await text(card.locator("h2"))) === N.deity[lang], `${tag}: the deity's name in the reading language is its heading`, await text(card.locator("h2")));
  check((await text(card.locator(`[lang="${other}"]`))) === N.deity[other], `${tag}: …and its name in the other language`);
  const inset = await card.evaluate((el) => el.querySelector("h2").getBoundingClientRect().left - el.getBoundingClientRect().left);
  check(inset >= 12, `${tag}: the card's content sits inside its padding, not on its edge`, `${inset}px`);
  check((await text(card)).includes(N.deityDesc[lang]) && !(await text(card)).includes(N.deityDesc[other]), `${tag}: the description in the reading language only`);
  await card.scrollIntoViewIfNeeded();
  const img = card.locator("img");
  await page.waitForFunction((id) => {
    const el = document.querySelector(`[data-deity-id="${id}"] img`);
    return el && el.complete && el.naturalWidth > 0;
  }, seed.deity, { timeout: 15000 }).catch(() => {});
  const imgState = await img.evaluate((el) => ({ src: el.getAttribute("src"), alt: el.alt, ok: el.complete && el.naturalWidth > 0 })).catch(() => null);
  check(imgState?.ok && imgState.src === `/uploads/${IMAGE_FILE}` && imgState.alt === N.deity[lang], `${tag}: the deity's image is shown, with its name as alt text`, JSON.stringify(imgState));

  // A picture that cannot be loaded leaves the card, as on About.
  const broken = page.locator(`[data-testid="deity-card"][data-deity-id="${seed.broken}"]`);
  await broken.scrollIntoViewIfNeeded();
  const gone = await page
    .waitForFunction((id) => {
      const el = document.querySelector(`[data-deity-id="${id}"]`);
      return el && !el.querySelector("img") && el.querySelector(".deity-card__glyph");
    }, seed.broken, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check(gone, `${tag}: a deity whose image is missing shows the mark, never a broken image`);

  check((await page.locator(`[data-deity-id="${seed.hiddenDeity}"]`).count()) === 0, `${tag}: a hidden deity is not shown`);
  const domIds = await page.locator('[data-testid="deity-card"]').evaluateAll((els) => els.map((el) => Number(el.dataset.deityId)));
  const feed = (await api("/api/deities")).json ?? [];
  const sortOf = new Map(feed.map((d) => [d.id, d.sort_order]));
  const known = domIds.filter((id) => sortOf.has(id));
  check(known.length >= 2 && known.every((id, i) => i === 0 || sortOf.get(id) >= sortOf.get(known[i - 1])), `${tag}: the deities are in the committee's display order`, domIds.join(","));
  check(domIds.indexOf(seed.deity) < domIds.indexOf(seed.broken), `${tag}: display order 950 before 951`);

  check(!(await overflow(page)), `${tag}: no horizontal overflow`);
  const v = await axe(page);
  check(v.length === 0, `${tag}: axe serious/critical violations`, v.join("\n      "));
  await shot(page, `deities-${lang}-${width}`);
  const errs = page.errors();
  check(errs.length === 0, `${tag}: no console errors`, errs.join(" | "));
  await page.context().close();
}

async function sponsorFollowThrough() {
  const page = await newPage({ width: 1366, lang: "en" });
  await page.goto(`${BASE}/sponsorship`, { waitUntil: "domcontentloaded" });
  const cta = page.locator(`[data-pooja-id="${seed.sponsored}"] [data-testid="sponsor-cta"]`);
  await cta.click();
  await page.waitForURL((u) => u.pathname === "/donate");
  check(new URL(page.url()).searchParams.get("pooja") === String(seed.sponsored), "following \"Sponsor\" opens /donate?pooja=<id>", page.url());
  const named = await page
    .waitForFunction((want) => document.querySelector("main")?.textContent?.includes(want), N.sponsored.en, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check(named, "…and the donate page names the pooja being sponsored", (await text(page.locator("main"))).slice(0, 300));
  const errs = page.errors();
  check(errs.length === 0, "…with no console errors", errs.join(" | "));
  await page.context().close();
}

async function officeWhenOffline() {
  for (const lang of ["en", "ta"]) {
    const page = await newPage({ width: 360, height: 780, lang });
    // Online giving off, exactly as the server says it when the gateway is not configured.
    await page.route("**/api/payments/config", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, ready: false, simulator: false }) }),
    );
    await page.goto(`${BASE}/sponsorship`, { waitUntil: "domcontentloaded" });
    const cta = page.locator(`[data-pooja-id="${seed.sponsored}"] [data-testid="sponsor-cta"]`);
    await cta.waitFor();
    const href = await cta.getAttribute("href");
    check(href === officeTel, `offline (${lang}): the Sponsor control calls the office number from the site settings`, `${href} vs ${officeTel}`);
    check((await page.locator('[data-testid="office-phone"]').getAttribute("href")) === officeTel, `offline (${lang}): the hero names the same office number`);
    check((await page.locator('[data-testid="sponsor-cta"][href^="/donate"]').count()) === 0, `offline (${lang}): nothing links to /donate while online giving is off`);
    const contact = page.locator(`[data-pooja-id="${seed.sponsored}"] a[href="/contact"]`);
    check((await contact.count()) === 1, `offline (${lang}): …and the office's contact details are one tap away`);
    check(!(await overflow(page)), `offline (${lang}) @360: no horizontal overflow`);
    const v = await axe(page);
    check(v.length === 0, `offline (${lang}) @360: axe serious/critical violations`, v.join("\n      "));
    const errs = page.errors();
    check(errs.length === 0, `offline (${lang}): no console errors`, errs.join(" | "));
    await page.context().close();
  }
}

async function emptyAndFailedStates() {
  // Nothing open for sponsorship and nobody to thank.
  let page = await newPage({ width: 360, height: 780, lang: "en" });
  await page.route(/\/api\/poojas\?.*sponsorship=1/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/donors", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(`${BASE}/sponsorship`, { waitUntil: "domcontentloaded" });
  await page.getByText("No sponsorships are open right now").waitFor();
  check(true, "empty: /sponsorship says no sponsorships are open");
  check(await page.getByText("No names to show yet").isVisible(), "empty: …and that there are no names to thank yet");
  check((await page.locator('[data-testid="sponsorship-item"]').count()) === 0, "empty: …and lists nothing");
  check(await page.locator('main a[href="/donations"]').first().isVisible(), "empty: …and offers the other ways to give");
  let errs = page.errors();
  check(errs.length === 0, "empty /sponsorship: no console errors", errs.join(" | "));
  await page.context().close();

  page = await newPage({ width: 360, height: 780, lang: "ta" });
  await page.route("**/api/deities", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.goto(`${BASE}/deities`, { waitUntil: "domcontentloaded" });
  await page.getByText("தெய்வ விவரங்கள் இன்னும் இல்லை").waitFor();
  check(true, "empty: /deities (Tamil) says no deities are listed yet, and invents none");
  check((await page.locator('[data-testid="deity-card"]').count()) === 0, "empty: …and shows no deity card");
  errs = page.errors();
  check(errs.length === 0, "empty /deities: no console errors", errs.join(" | "));
  await page.context().close();

  // A failed feed says so and recovers on "Try again".
  page = await newPage({ width: 1366, lang: "en" });
  let fail = true;
  await page.route("**/api/deities", (route) =>
    fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' }) : route.continue(),
  );
  page.allowErrors(/status of 500/);
  await page.goto(`${BASE}/deities`, { waitUntil: "domcontentloaded" });
  await page.getByText("Couldn't load the deities").first().waitFor();
  check(true, "failed: /deities says it could not load");
  fail = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await page.locator(`[data-deity-id="${seed.deity}"]`).waitFor();
  check(true, "failed: …and \"Try again\" loads the deities");
  errs = page.errors();
  check(errs.length === 0, "failed /deities: no unexpected console errors", errs.join(" | "));
  await page.context().close();
}

async function navigation() {
  for (const lang of ["en", "ta"]) {
    const L = (ta, en) => (lang === "ta" ? ta : en);
    // Phone: the drawer carries both pages.
    let page = await newPage({ width: 360, height: 780, lang });
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await page.locator(".navbar__toggle").click();
    await page.locator("#mobile-drawer.drawer--open").waitFor();
    const dDeities = page.locator('#mobile-drawer a[href="/deities"]');
    const dSponsor = page.locator('#mobile-drawer a[href="/sponsorship"]');
    check((await text(dDeities)) === L("குலதெய்வங்கள்", "Deities") && (await text(dSponsor)) === L("பூஜை உபயம்", "Sponsorship"), `drawer (${lang}) @360: lists Deities and Sponsorship`, `${await text(dDeities)} / ${await text(dSponsor)}`);
    await dSponsor.click();
    await page.waitForURL((u) => u.pathname === "/sponsorship");
    await page.locator("h1").waitFor();
    check((await page.locator("#mobile-drawer.drawer--open").count()) === 0 && (await text(page.locator("h1"))) === L("பூஜை உபயம்", "Sponsorship"), `drawer (${lang}) @360: the Sponsorship entry opens the page and the drawer closes`);
    check(!(await page.evaluate(() => { const r = document.querySelector(".navbar__inner"); return r.scrollWidth > r.clientWidth + 1; })), `header (${lang}) @360: the bar does not overflow`);
    await page.context().close();

    // Desktop: the header row keeps its own entries and does not overflow; the footer reaches both pages.
    page = await newPage({ width: 1366, lang });
    await page.goto(`${BASE}/deities`, { waitUntil: "domcontentloaded" });
    await page.locator("h1").waitFor();
    const header = await page.locator(".navbar__nav a").evaluateAll((els) => els.map((a) => a.getAttribute("href")));
    check(header.length === 8 && !header.includes("/deities") && !header.includes("/sponsorship"), `header (${lang}) @1366: the row keeps its eight entries`, header.join(" "));
    check(!(await page.evaluate(() => { const r = document.querySelector(".navbar__inner"); return r.scrollWidth > r.clientWidth + 1; })), `header (${lang}) @1366: the row does not overflow`);
    await page.locator('footer a[href="/sponsorship"]').click();
    await page.waitForURL((u) => u.pathname === "/sponsorship");
    await page.locator("h1").waitFor();
    check((await text(page.locator("h1"))) === L("பூஜை உபயம்", "Sponsorship"), `footer (${lang}) @1366: the Sponsorship quick link opens the page`);
    const errs = page.errors();
    check(errs.length === 0, `navigation (${lang}): no console errors`, errs.join(" | "));
    await page.context().close();
  }
}

/* ── Run ────────────────────────────────────────────────────────────────── */

let php = null;
let vite = null;

try {
  section("Preflight");
  for (const [port, host] of [[PHP_PORT, "127.0.0.1"], [VITE_PORT, "127.0.0.1"], [VITE_PORT, "::1"]]) {
    if (await portInUse(port, host)) {
      console.log(`✗ port ${port} (${host}) is already in use — stop whatever holds it (never the shared :8000/:5173)`);
      process.exit(2);
    }
  }
  console.log(`  cleanup at start: ${JSON.stringify(cleanup())}`);
  php = startPhp();
  check(await waitForUrl(`${PHP_BASE}/api/pulse`), `PHP answers on ${PHP_BASE}`, php.log.slice(-400));
  const cfg = (await api("/api/payments/config")).json;
  check(cfg?.enabled === true && cfg?.ready === true, "the test server has online giving on (simulator)", JSON.stringify(cfg).slice(0, 200));
  seedRows();
  check(Object.values(seed).every((id) => Number.isInteger(id) && id > 0), "seeded 5 poojas, 3 sponsors and 3 deities", JSON.stringify(seed));

  /* ── API ─────────────────────────────────────────────────────────────── */
  section("GET /api/poojas?sponsorship=1");
  let r = await api("/api/poojas?upcoming=1&sponsorship=1&limit=200");
  check(r.status === 200 && Array.isArray(r.json), "answers 200 with a list", `${r.status} ${r.text.slice(0, 120)}`);
  const list = Array.isArray(r.json) ? r.json : [];
  const ids = list.map((p) => p.id);
  check(list.every((p) => p.sponsorship_available === true), "every item is open for sponsorship");
  check(list.every((p) => p.date >= TODAY && p.is_past === false), "every item is today or later");
  check(ids.includes(seed.sponsored) && ids.includes(seed.open), "the two open poojas are listed");
  check(!ids.includes(seed.closed), "a pooja whose sponsorship is closed is not");
  check(!ids.includes(seed.past), "a past pooja is not");
  check(!ids.includes(seed.hidden), "a hidden pooja is not");
  check(list.every((p, i) => i === 0 || p.date >= list[i - 1].date), "soonest first");
  check(r.headers.get("x-has-more") === "0" || r.headers.get("x-has-more") === "1", "X-Has-More is sent as before");
  const A = list.find((p) => p.id === seed.sponsored);
  const B = list.find((p) => p.id === seed.open);
  ogAnswers.apiSponsored = A;
  const SHAPE = ["id", "name_ta", "name_en", "description_ta", "description_en", "date", "type", "start_time", "end_time", "time", "recurrence_type", "sponsorship_amount", "sponsorship_available", "banner_url", "is_featured", "live_stream_enabled", "is_past", "sponsor"];
  check(A && Object.keys(A).every((k) => SHAPE.includes(k)) && SHAPE.filter((k) => k !== "sponsor").every((k) => k in A), "an item has exactly the documented fields", A && Object.keys(A).join(","));
  check(A?.name_ta === N.sponsored.ta && A?.description_ta === N.sponsoredDesc.ta, "Tamil name and description arrive intact", A?.name_ta);
  check(A?.start_time === "18:00" && A?.end_time === "20:30" && A?.time === "6:00 PM – 8:30 PM" && A?.type === "monthly", "typed times, the display time and the type", JSON.stringify(A && [A.start_time, A.end_time, A.time, A.type]));
  check(A?.sponsorship_amount === 2501 && B?.sponsorship_amount === 1001, "the sponsorship amounts", JSON.stringify([A?.sponsorship_amount, B?.sponsorship_amount]));
  check(A?.sponsor && Object.keys(A.sponsor).sort().join() === "name,note" && A.sponsor.name === N.family && A.sponsor.note === N.note, "E2E-009 the consented sponsor is carried by family name, with only name and note", JSON.stringify(A?.sponsor));
  check(B && !("sponsor" in B), "E2E-010 a pooja whose only sponsor withheld consent carries no sponsor", JSON.stringify(B?.sponsor));
  const leakedApi = PRIVATE_BITS.filter((bit) => r.text.includes(bit));
  check(leakedApi.length === 0, "E2E-010 no withheld sponsor, phone or e-mail anywhere in the answer", leakedApi.join(", "));

  // Composes with the other filters; the unfiltered list is what it was.
  r = await api("/api/poojas?upcoming=1&limit=200");
  check(r.json?.some((p) => p.id === seed.closed && p.sponsorship_available === false) && r.json?.some((p) => p.id === seed.sponsored), "without the filter a closed pooja is still listed (existing behaviour)");
  r = await api("/api/poojas?upcoming=1&sponsorship=0&limit=200");
  check(r.json?.some((p) => p.id === seed.closed), "?sponsorship=0 filters nothing");
  r = await api("/api/poojas?sponsorship=1&type=monthly&limit=200");
  check(r.json?.some((p) => p.id === seed.sponsored) && !r.json?.some((p) => p.id === seed.open) && r.json?.every((p) => p.type === "monthly" && p.sponsorship_available), "?sponsorship=1&type=monthly composes");
  r = await api("/api/poojas?past=1&sponsorship=1&limit=200");
  check(r.json?.some((p) => p.id === seed.past) && r.json?.every((p) => p.sponsorship_available && p.is_past), "?past=1&sponsorship=1 composes");
  r = await api("/api/v1/poojas?upcoming=1&sponsorship=1&limit=200");
  check(r.status === 200 && JSON.stringify(r.json).includes(`"id":${seed.sponsored}`) && !JSON.stringify(r.json).includes(`"id":${seed.closed},`), "the /api/v1 alias honours the filter too", r.text.slice(0, 160));

  // Consent is read live: withdraw it and the name leaves at once; give it back.
  sql("UPDATE sponsors SET publish_consent = 0 WHERE family_name = ?", [N.family]);
  r = await api("/api/poojas?upcoming=1&sponsorship=1&limit=200");
  const withdrawn = r.json?.find((p) => p.id === seed.sponsored);
  check(withdrawn && !("sponsor" in withdrawn) && !r.text.includes(N.family), "consent withdrawn: the sponsor's name leaves the feed");
  sql("UPDATE sponsors SET publish_consent = 1 WHERE family_name = ?", [N.family]);

  section("GET /api/donors and GET /api/deities");
  r = await api("/api/donors");
  const sponsorsFeed = (r.json ?? []).filter((d) => d.type === "sponsor");
  const mine = sponsorsFeed.find((d) => d.name === N.family);
  check(!!mine && mine.pooja?.ta === N.sponsored.ta && mine.pooja?.en === N.sponsored.en && mine.label === N.note, "the consented sponsor is thanked, with the pooja in both languages", JSON.stringify(mine));
  check(Object.keys(mine ?? {}).sort().join() === "label,name,pooja,type", "…and carries nothing but name, label, pooja and type", mine && Object.keys(mine).join());
  const leakedDonors = PRIVATE_BITS.filter((bit) => r.text.includes(bit));
  check(leakedDonors.length === 0, "no withheld sponsor, phone or e-mail in /api/donors", leakedDonors.join(", "));
  r = await api("/api/deities");
  const shown = (r.json ?? []).find((d) => d.id === seed.deity);
  check(shown?.name_ta === N.deity.ta && shown?.description_en === N.deityDesc.en && shown?.image_url === `/uploads/${IMAGE_FILE}` && shown?.sort_order === 950, "a shown deity is in /api/deities with its names, description, image and order", JSON.stringify(shown));
  check(!(r.json ?? []).some((d) => d.id === seed.hiddenDeity), "a hidden deity is not");

  /* ── Crawler ─────────────────────────────────────────────────────────── */
  section("Crawler: og.php, sitemap.xml, spa.php");
  const origin = BASE;
  for (const path of ["/deities", "/sponsorship"]) {
    ogAnswers[path] = {};
    for (const lang of ["ta", "en"]) {
      const p = await preview(path, { lang });
      const [title, desc] = PAGE_WORDS[path][lang];
      ogAnswers[path][lang] = { title: p.meta["og:title"], description: p.meta["og:description"] };
      check(p.status === 200, `${path} (${lang}): a WhatsApp unfurler gets 200`, `status ${p.status}`);
      check(p.meta["og:title"] === title && p.meta["og:description"] === desc, `${path} (${lang}): og:title and og:description are the page's own words`, `${p.meta["og:title"]} / ${p.meta["og:description"]}`);
      check(p.meta["og:locale"] === (lang === "en" ? "en_IN" : "ta_IN"), `${path} (${lang}): og:locale`, p.meta["og:locale"]);
      check(/^https?:\/\//.test(p.meta["og:image"] ?? ""), `${path} (${lang}): an absolute og:image`, p.meta["og:image"]);
      check(p.canonical === `${origin}${path}` && p.meta["og:url"] === `${origin}${path}`, `${path} (${lang}): canonical and og:url are the page itself`, `${p.canonical} ${p.meta["og:url"]}`);
      check(p.meta["twitter:card"] === "summary_large_image" && (p.meta["og:site_name"] ?? "").length > 5, `${path} (${lang}): site name and large card`);
      check(!/<meta name="robots"/.test(p.html), `${path} (${lang}): left indexable`);
    }
    const forced = await preview(`${path}?lang=en`);
    check(forced.meta["og:title"] === PAGE_WORDS[path].en[0], `${path}: ?lang=en overrides a Tamil default`, forced.meta["og:title"]);
  }
  r = { res: await fetch(`${PHP_BASE}/sitemap.xml`) };
  const xml = await r.res.text();
  for (const path of ["/deities", "/sponsorship"]) check(xml.includes(`<loc>${origin}${path}</loc>`), `sitemap.xml lists ${path}`);
  for (const path of ["/deities", "/sponsorship"]) {
    const res = await fetch(`${PHP_BASE}${path}`, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "manual" });
    const html = await res.text();
    check(res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/html") && !res.headers.get("x-robots-tag") && /<div id="root">|Temple website/.test(html), `${path}: the SPA fallback answers 200 with the shell, no noindex`, `${res.status}`);
    const sub = await fetch(`${PHP_BASE}${path}/nothing-here`, { headers: { "user-agent": "Mozilla/5.0" }, redirect: "manual" });
    await sub.text();
    check(sub.status === 404 && sub.headers.get("x-robots-tag") === "noindex, nofollow", `${path}/nothing-here: 404, noindex`, `${sub.status}`);
    const direct = await fetch(`${PHP_BASE}/api/spa.php?path=${encodeURIComponent(path)}`);
    await direct.text();
    check(direct.status === 200, `${path}: api/spa.php agrees`, `${direct.status}`);
  }

  // The office number the page must fall back to (Admin → System → Settings, else the booklet's).
  const settings = (await api("/api/settings")).json;
  const phone = String(settings?.site?.phone_primary ?? "").replace(/^\+91/, "");
  officeTel = `tel:+91${phone || "9443002296"}`;

  /* ── Browser ─────────────────────────────────────────────────────────── */
  section("Browser");
  vite = startVite();
  check(await waitForUrl(`${BASE}/`), `Vite answers on ${BASE}`, vite.log.slice(-400));
  const viaProxy = await fetch(`${BASE}/api/payments/config`).then((x) => x.json()).catch(() => null);
  check(viaProxy?.enabled === true && viaProxy?.ready === true, "the test Vite proxies /api to the test PHP");
  browser = await chromium.launch();

  // Warm the lazy routes once so the first real scenario is not the one paying for compilation.
  const warm = await newPage();
  for (const path of ["/sponsorship", "/deities", `/donate?pooja=${seed.sponsored}`, "/"]) {
    await warm.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await warm.locator("h1").first().waitFor().catch(() => {});
    await sleep(500);
  }
  await warm.context().close();

  for (const lang of ["en", "ta"]) {
    for (const width of [360, 1366]) {
      await scenario(`sponsorship-${lang}-${width}`, () => sponsorshipPage(lang, width));
      await scenario(`deities-${lang}-${width}`, () => deitiesPage(lang, width));
    }
  }
  await scenario("follow-through", sponsorFollowThrough);
  await scenario("offline", officeWhenOffline);
  await scenario("states", emptyAndFailedStates);
  await scenario("navigation", navigation);

  check(!/PHP (?:Warning|Fatal|Notice|Deprecated)|SQLSTATE/.test(php.log), "no PHP warnings, notices, fatals or SQL errors in the server log", php.log.slice(-600));
} catch (e) {
  check(false, "the suite ran to the end", String(e?.stack || e).split("\n").slice(0, 4).join(" "));
} finally {
  section("Cleanup");
  try {
    if (browser) {
      for (const ctx of browser.contexts()) await ctx.close().catch(() => {});
      await browser.close();
    }
  } catch {
    /* already gone */
  }
  try {
    console.log(`  cleanup at end: ${JSON.stringify(cleanup())}`);
    const left = rows(
      "SELECT (SELECT COUNT(*) FROM poojas WHERE name_en LIKE ?) + (SELECT COUNT(*) FROM sponsors WHERE name LIKE ? OR family_name LIKE ?) + (SELECT COUNT(*) FROM deities WHERE name_en LIKE ?) AS n",
      [`${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`],
    )[0];
    check(Number(left?.n) === 0, "no rows of this run are left behind", JSON.stringify(left));
    check(!readdirSync(UPLOADS).some((f) => f.startsWith(`${FILE_PREFIX}${RUN}`)), "no files of this run are left in backend/uploads");
  } catch (e) {
    check(false, "cleanup at the end", String(e?.message || e));
  }
  await stopServer(vite, ["127.0.0.1", "::1"]);
  await stopServer(php, ["127.0.0.1"]);
  const still = (await portInUse(PHP_PORT)) || (await portInUse(VITE_PORT)) || (await portInUse(VITE_PORT, "::1"));
  check(!still, "both test servers are stopped");
  console.log(`\npublic-pages: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
