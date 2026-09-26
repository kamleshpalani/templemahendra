/**
 * tests/public-content-ui.mjs — the public content pages in a real browser
 * (brief §6 Pooja / Seva, Events and Home; §7 Tamil; §23 accessibility;
 * §24 360 / 1366; §30 E2E-006 upcoming pooja, E2E-007 expired pooja excluded,
 * E2E-009 / 010 sponsor with and without consent, E2E-018 event displays;
 * defect D-026 the events page's idea of "today").
 *
 *   PHP_BIN=/path/to/php node tests/public-content-ui.mjs
 *
 * Starts its own PHP server on 8101 with the payments simulator switched on
 * (so the sponsor links point at /donate) and its own Vite on 5181 proxying to
 * it; the user's :8000 / :5173 are never touched. Chromium and axe-core come
 * from frontend/node_modules.
 *
 * What it proves
 *   /sevas   the "Upcoming special poojas" section shows a seeded upcoming
 *            pooja in English and in Tamil with its date, time, type, price,
 *            Featured and Live-stream badges (no on-air pulse), the consented
 *            sponsor's family name and never the sponsor who withheld consent;
 *            "Sponsor this pooja" links to /donate?pooja=<id> while online
 *            giving works and becomes the office's phone number when it does
 *            not; a pooja whose sponsorship is closed says so with no link; an
 *            expired pooja is not listed. A seva with is_bookable = 0 shows its
 *            description and timing but no Book control and no ?seva= link,
 *            shares /sevas, and carries the "Contact the temple office" line
 *            with the office number; a bookable one keeps its Book control and
 *            its ?seva= link. /sevas?seva=<id> opens the booking dialog for the
 *            bookable seva; for the office-only one it opens nothing and the
 *            parameter leaves the address bar.
 *   /events  a seeded event dated today in IST is listed as upcoming; the
 *            featured events lead the timeline as one run (this run's featured
 *            festival ahead of its sooner, unfeatured event) and every card
 *            links to /events/<id>; the panel above leads the soonest featured
 *            event; with the browser clock at 01:00 IST (when the UTC date is
 *            still yesterday) the next Pournami is the coming one, yesterday's
 *            is neither listed nor flagged "Today" (D-026).
 *   /        the featured sevas show description and timing, an office-only
 *            seva links to /sevas without ?seva= and a bookable one with it;
 *            the gallery strip shows the seeded photographs with their alt
 *            text, lazily loaded, each linking to /gallery?photo=<id>, and is
 *            absent when the gallery answers nothing.
 *   /donate  ?pooja=<id> names the pooja from /api/poojas.
 *   axe on /sevas and /events at 360 and 1366, no horizontal overflow, no
 *   console errors on any page.
 *
 * Data: poojas, sponsors, sevas, events and gallery rows named
 * "E2E-PUBUI-<run> …" with real PNG files under backend/uploads/, written
 * through tests/support/live_fixtures.php `sql` and removed in `finally`
 * (only rows of this prefix, never by id). The home page's featured-seva and
 * the events page's Pournami answers are served to the browser from this
 * suite (the real rows, re-ordered) so the shared database's own ordering is
 * never changed for anyone else.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
const PHP_PORT = 8101;
const VITE_PORT = 5181;
const PHP_BASE = `http://127.0.0.1:${PHP_PORT}`;
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const RUN = Date.now().toString(36);
const PREFIX = `E2E-PUBUI-${RUN}`;
const FILE_PREFIX = "e2e-pubui-";
const SHOTS = process.env.PUBUI_SHOTS || resolve(ROOT, "shots/public-content");
mkdirSync(SHOTS, { recursive: true });

// The simulator, so online giving is "usable" and the sponsor links point at
// /donate. Fake values chosen here; nothing real is read or written.
const SERVER_ENV = {
  PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SECRET: "e2e-pubui-fake-secret-0123456789abcdef-not-real",
  PAYMENTS_SETTINGS_KEY: Buffer.from("e2e-pubui-fake-settings-key!!!!!").toString("base64"),
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({ enabled: "1", mode: "simulator", seva_online_enabled: "1" }),
  SITE_URL: BASE,
  TRUSTED_PROXIES: "127.0.0.1,::1",
  CORS_ORIGIN: "*",
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_SMS_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "test",
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
  return r.rows;
}

/* ── Dates in the temple's own day (IST) ────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Today's IST date, the way lib/templeTime.js works it out. */
const todayIST = () => ymd(new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })));
function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
const TODAY = todayIST();

/* ── Seed data ──────────────────────────────────────────────────────────── */

// A 1×1 PNG. The rows say 480×360: the strip's layout comes from those
// columns, the file only has to be a real image the browser can decode.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const seed = {
  pooja: null, // the featured, live, sponsorable Pournami three days out
  closed: null, // sponsorship closed, five days out
  past: null, // two days ago: must never be listed
  officeSeva: null, // is_bookable = 0
  onlineSeva: null, // is_bookable = 1
  todayEvent: null, // dated today in IST, not featured
  featuredEvent: null, // tomorrow, featured: leads the timeline
  photos: [], // three gallery rows with files on disk
  files: [],
};
const NAMES = {
  pooja: { ta: `பௌர்ணமி சிறப்பு பூஜை ${RUN}`, en: `${PREFIX} Pournami Special Pooja` },
  closed: { ta: `பிரதோஷ பூஜை ${RUN}`, en: `${PREFIX} Pradosham Pooja` },
  past: { ta: `கடந்த பூஜை ${RUN}`, en: `${PREFIX} Past Pooja` },
  sponsorFamily: `${PREFIX} Family`,
  sponsorPrivate: `${PREFIX} Private Sponsor`,
  officeSeva: { ta: `அலுவலக சேவை ${RUN}`, en: `${PREFIX} Office Seva` },
  onlineSeva: { ta: `இணைய சேவை ${RUN}`, en: `${PREFIX} Online Seva` },
  officeDesc: { ta: `அலுவலகம் மூலம் மட்டும் ஏற்பாடு ${RUN}`, en: `Arranged only through the office ${RUN}` },
  officeTiming: { ta: `தினமும் காலை 7 – 9 மணி ${RUN}`, en: `Daily 7 – 9 am ${RUN}` },
  todayEvent: { ta: `இன்றைய நிகழ்வு ${RUN}`, en: `${PREFIX} Today Event` },
  featuredEvent: { ta: `சிறப்பு திருவிழா ${RUN}`, en: `${PREFIX} Featured Festival` },
  photoAlt: (n) => ({ ta: `கோயில் புகைப்படம் ${RUN} ${n}`, en: `${PREFIX} temple photo ${n}` }),
};

const idOf = (table, column, value) => Number(sql(`SELECT id FROM ${table} WHERE ${column} = ? ORDER BY id DESC LIMIT 1`, [value])[0]?.id);

function seedRows() {
  sql(
    `INSERT INTO poojas (name_ta, name_en, description_ta, description_en, pooja_date, pooja_time, start_time, end_time, pooja_type,
       recurrence_type, sponsorship_amount, sponsorship_available, banner_url, is_featured, live_stream_enabled, is_active)
     VALUES (?, ?, ?, ?, ?, NULL, '18:00:00', '20:30:00', 'pournami', 'pournami', 2500.00, 1, NULL, 1, 1, 1)`,
    [NAMES.pooja.ta, NAMES.pooja.en, `பௌர்ணமி அன்று சிறப்பு அபிஷேகம் ${RUN}`, `Special abhishekam on the full-moon evening ${RUN}`, addDays(TODAY, 3)],
  );
  seed.pooja = idOf("poojas", "name_en", NAMES.pooja.en);
  sql(
    `INSERT INTO poojas (name_ta, name_en, description_ta, description_en, pooja_date, pooja_time, start_time, end_time, pooja_type,
       recurrence_type, sponsorship_amount, sponsorship_available, banner_url, is_featured, live_stream_enabled, is_active)
     VALUES (?, ?, NULL, NULL, ?, NULL, '17:30:00', NULL, 'pradosham', 'none', 1500.00, 0, NULL, 0, 0, 1)`,
    [NAMES.closed.ta, NAMES.closed.en, addDays(TODAY, 5)],
  );
  seed.closed = idOf("poojas", "name_en", NAMES.closed.en);
  sql(
    `INSERT INTO poojas (name_ta, name_en, description_ta, description_en, pooja_date, pooja_time, start_time, end_time, pooja_type,
       recurrence_type, sponsorship_amount, sponsorship_available, banner_url, is_featured, live_stream_enabled, is_active)
     VALUES (?, ?, NULL, NULL, ?, NULL, '06:00:00', NULL, 'special', 'none', 1000.00, 1, NULL, 1, 0, 1)`,
    [NAMES.past.ta, NAMES.past.en, addDays(TODAY, -2)],
  );
  seed.past = idOf("poojas", "name_en", NAMES.past.en);

  // Two sponsors of the same pooja: only the consenting one may be published (brief §11, E2E-009 / 010).
  sql(
    `INSERT INTO sponsors (name, family_name, phone, email, note, pooja_id, amount, payment_status, publish_consent, is_active)
     VALUES (?, ?, NULL, NULL, ?, ?, 2500.00, 'PAID', 1, 1)`,
    [`${PREFIX} Sponsor`, NAMES.sponsorFamily, `in memory of our elders ${RUN}`, seed.pooja],
  );
  sql(
    `INSERT INTO sponsors (name, family_name, phone, email, note, pooja_id, amount, payment_status, publish_consent, is_active)
     VALUES (?, NULL, NULL, NULL, NULL, ?, 2500.00, 'PAID', 0, 1)`,
    [NAMES.sponsorPrivate, seed.pooja],
  );

  // Sort orders far down the list and not featured: the shared site's own
  // first cards stay the same for every other suite running against it.
  sql(
    `INSERT INTO sevas (name_ta, name_en, description, description_ta, description_en, timing_ta, timing_en, amount, sort_order, is_featured, is_bookable, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 501.00, 9990, 0, 0, 1)`,
    [NAMES.officeSeva.ta, NAMES.officeSeva.en, NAMES.officeDesc.en, NAMES.officeDesc.ta, NAMES.officeDesc.en, NAMES.officeTiming.ta, NAMES.officeTiming.en],
  );
  seed.officeSeva = idOf("sevas", "name_en", NAMES.officeSeva.en);
  sql(
    `INSERT INTO sevas (name_ta, name_en, description, description_ta, description_en, timing_ta, timing_en, amount, sort_order, is_featured, is_bookable, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 251.00, 9991, 0, 1, 1)`,
    [NAMES.onlineSeva.ta, NAMES.onlineSeva.en, `Bookable online ${RUN}`, `இணையத்தில் பதிவு செய்யலாம் ${RUN}`, `Bookable online ${RUN}`, `மாலை 6 மணி ${RUN}`, `Evenings at 6 ${RUN}`],
  );
  seed.onlineSeva = idOf("sevas", "name_en", NAMES.onlineSeva.en);

  sql(
    `INSERT INTO events (title_ta, title_en, description, description_ta, description_en, event_type, is_featured, event_date, end_date, start_time, end_time, venue_ta, venue_en, image_url, is_active)
     VALUES (?, ?, ?, ?, ?, 'special', 0, ?, NULL, '10:00:00', '12:00:00', NULL, NULL, NULL, 1)`,
    [NAMES.todayEvent.ta, NAMES.todayEvent.en, `Today in IST ${RUN}`, `இன்று நடக்கும் ${RUN}`, `Today in IST ${RUN}`, TODAY],
  );
  seed.todayEvent = idOf("events", "title_en", NAMES.todayEvent.en);
  sql(
    `INSERT INTO events (title_ta, title_en, description, description_ta, description_en, event_type, is_featured, event_date, end_date, start_time, end_time, venue_ta, venue_en, image_url, is_active)
     VALUES (?, ?, ?, ?, ?, 'festival', 1, ?, NULL, '18:00:00', '21:00:00', ?, ?, NULL, 1)`,
    [NAMES.featuredEvent.ta, NAMES.featuredEvent.en, `Featured festival ${RUN}`, `சிறப்பு திருவிழா விவரம் ${RUN}`, `Featured festival ${RUN}`, addDays(TODAY, 1), "கோயில் முன்பு", "Temple forecourt"],
  );
  seed.featuredEvent = idOf("events", "title_en", NAMES.featuredEvent.en);

  for (const n of [1, 2, 3]) {
    const name = `${FILE_PREFIX}${RUN}-${n}.png`;
    writeFileSync(resolve(UPLOADS, name), PNG);
    seed.files.push(name);
    const alt = NAMES.photoAlt(n);
    sql(
      `INSERT INTO gallery (album_id, filename, thumb_filename, medium_filename, width, height, caption, alt_ta, alt_en, is_active)
       VALUES (NULL, ?, ?, ?, 480, 360, ?, ?, ?, 1)`,
      [name, name, name, `${PREFIX} photo ${n}`, alt.ta, alt.en],
    );
    seed.photos.push({ id: idOf("gallery", "caption", `${PREFIX} photo ${n}`), file: name, alt });
  }
}

/** Every row and file of this prefix — this run's and any earlier run's that was cut short. */
function cleanup() {
  const out = {};
  const del = (label, query, params) => {
    const r = fixtures("sql", { query, params });
    if (r.error) throw new Error(`cleanup ${label}: ${r.error}`);
    out[label] = r.affected;
  };
  del("sponsors", "DELETE FROM sponsors WHERE name LIKE ? OR family_name LIKE ?", [`${"E2E-PUBUI-"}%`, `${"E2E-PUBUI-"}%`]);
  del("poojas", "DELETE FROM poojas WHERE name_en LIKE ?", ["E2E-PUBUI-%"]);
  del("sevas", "DELETE FROM sevas WHERE name_en LIKE ?", ["E2E-PUBUI-%"]);
  del("events", "DELETE FROM events WHERE title_en LIKE ?", ["E2E-PUBUI-%"]);
  del("gallery", "DELETE FROM gallery WHERE caption LIKE ?", ["E2E-PUBUI-%"]);
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

// --host 127.0.0.1: on Node 24 Vite's default binds ::1 only, and every page
// here dials 127.0.0.1 (tests/README.md, D-033).
function startVite() {
  const child = spawn(
    process.execPath,
    [resolve(FRONTEND, "node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: FRONTEND, env: { ...process.env, VITE_PROXY_TARGET: PHP_BASE }, windowsHide: true },
  );
  const server = { child, port: VITE_PORT, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  return server;
}

async function waitForUrl(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
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
    // The port is in this suite's own range; whatever still holds it is ours.
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "LISTENING" && /:(\d+)$/.test(cols[1] ?? "") && cols[1].endsWith(`:${server.port}`)) {
        spawnSync("taskkill", ["/pid", cols[4], "/T", "/F"], { windowsHide: true });
      }
    }
  }
}

/* ── Browser ────────────────────────────────────────────────────────────── */

let browser;
const IGNORE = /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js|React Router Future Flag|youtube|ytimg|googlevideo/;

async function newPage({ width = 1366, height = 900, lang = "en" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  // Third parties (fonts, the Maps embed, YouTube) are not under test and can
  // take seconds from this network; an empty 200 keeps every wait about the site.
  await ctx.route(
    (url) => /^https:\/\/(fonts\.(googleapis|gstatic)\.com|www\.google\.com\/maps|maps\.google\.com|(www\.)?youtube(-nocookie)?\.com|i\.ytimg\.com|[a-z0-9.-]*googlevideo\.com)\//.test(url.href),
    (route) => route.fulfill({ status: 200, contentType: /fonts\.googleapis/.test(route.request().url()) ? "text/css" : "text/html", body: "" }),
  );
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
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()} @ ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!IGNORE.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`);
  });
  page.errors = () => errors.filter((e) => !IGNORE.test(e));
  openPages.add(page);
  ctx.on("close", () => openPages.delete(page));
  return page;
}

const shot = (page, name) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
/** One section on its own: a full-page shot of a long page is too small to review at 360 px. */
const elShot = (loc, name) => loc.screenshot({ path: resolve(SHOTS, `${name}.png`), animations: "disabled" }).catch(() => {});
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
async function axe(page) {
  await page.addScriptTag({ content: axeSource });
  // Alerts and cards fade in (opacity 0 → 1): a contrast check taken mid-fade
  // reads a colour nobody ever sees, so wait for every running animation first.
  // Only finite animations are awaited (a pulsing dot never finishes), and never
  // for longer than a second and a half.
  await page.evaluate(() => Promise.race([
    Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getTiming?.().iterations ?? 1)).map((a) => a.finished.catch(() => {}))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ])).catch(() => {});
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

/** The card of one seeded seva on /sevas. */
const sevaCard = (page, name) => page.locator(".seva-card").filter({ hasText: name }).first();
/** The share sheet's link for a card's share control. */
async function sharedUrl(page, card) {
  await card.locator(".seva-card__share").click();
  await page.locator(".share-sheet").waitFor({ state: "visible" });
  const url = await page.locator(".share-link__url").inputValue();
  await page.keyboard.press("Escape");
  await page.locator(".share-sheet").waitFor({ state: "hidden" }).catch(() => {});
  return url;
}

/* ── Scenarios ──────────────────────────────────────────────────────────── */

async function sevasPage() {
  section("/sevas — special poojas and sevas (English, 1366)");
  const page = await newPage();
  await page.goto(`${BASE}/sevas`, { waitUntil: "networkidle" });
  await page.locator(".sevas-poojas").waitFor({ state: "visible" });
  await shot(page, "sevas-1366");

  const card = page.locator(`.pooja-card[data-pooja-id="${seed.pooja}"]`);
  check((await card.count()) === 1, "E2E-006: the seeded upcoming pooja has a card in the special-poojas section");
  const body = await text(card);
  check(body.includes(NAMES.pooja.en), "the card names the pooja in English", body);
  check(body.includes("Pournami"), "the card carries its type", body);
  check((await text(card.locator(".pooja-card__featured"))) === "Featured", "the Featured badge is shown for is_featured = 1", body);
  check(/^Live/.test(await text(card.locator(".pooja-card__live"))), "the Live badge is shown for live_stream_enabled = 1", body);
  check((await card.locator(".badge--live").count()) === 0, "…without the pulsing on-air dot: the pooja is days away, not on air now");
  check(body.includes("2,500"), "the sponsorship amount is the row's ₹2,500", body);
  check(body.includes("6:00 PM") && body.includes("8:30 PM"), "the display time comes from start_time / end_time", body);
  const dt = await card.locator("time").getAttribute("datetime");
  check(dt === addDays(TODAY, 3), "the <time> carries the pooja's date", dt);
  check(body.includes("Special abhishekam on the full-moon evening"), "the English description is shown", body);
  const link = card.locator("a.pooja-card__sponsor");
  check((await link.count()) === 1 && (await link.getAttribute("href")) === `/donate?pooja=${seed.pooja}`, "Sponsor this pooja links to /donate?pooja=<id> while online giving works", await link.getAttribute("href"));
  const sponsorLine = await text(card.locator(".pooja-card__sponsor-line"));
  check(sponsorLine.includes(NAMES.sponsorFamily), "E2E-009: the consenting sponsor's family name is shown", sponsorLine);
  check(!body.includes(NAMES.sponsorPrivate) && !body.includes(`${PREFIX} Sponsor`), "E2E-010: the sponsor without consent is not shown, nor the consenting sponsor's own name", body);

  const closed = page.locator(`.pooja-card[data-pooja-id="${seed.closed}"]`);
  check((await closed.count()) === 1, "the pooja whose sponsorship is closed still has a card");
  check((await closed.locator(".pooja-card__featured, .pooja-card__live").count()) === 0, "…and, neither featured nor streamed, carries neither badge", await text(closed));
  check((await closed.locator(".pooja-card__closed").count()) === 1 && (await closed.locator(".pooja-card__sponsor").count()) === 0, "…saying Fully sponsored, with no sponsor link", await text(closed));
  check((await page.locator(`.pooja-card[data-pooja-id="${seed.past}"]`).count()) === 0, "E2E-007: the pooja two days ago is not listed");
  const ids = await page.locator(".pooja-card").evaluateAll((els) => els.map((e) => Number(e.dataset.poojaId)));
  check(ids.indexOf(seed.pooja) < ids.indexOf(seed.closed), "the cards run soonest first", ids.join(","));

  const office = sevaCard(page, NAMES.officeSeva.en);
  check((await office.count()) === 1, "the office-only seva is listed");
  const officeText = await text(office);
  check(officeText.includes(NAMES.officeDesc.en) && officeText.includes(NAMES.officeTiming.en), "…with its English description and timing", officeText);
  check((await office.locator(".seva-card__book").count()) === 0, "…and no Book control at all");
  check((await office.locator("button").filter({ hasText: /Book/ }).count()) === 0, "…no button says Book");
  check((await office.locator('a[href*="seva="]').count()) === 0, "…and no ?seva= link anywhere on its card");
  const note = office.locator(".seva-card__note");
  check((await note.count()) === 1 && /contact the temple office/i.test(await text(note)), "…but a Contact-the-temple-office line", await text(note));
  const tel = await note.locator("a[href^='tel:']").getAttribute("href");
  check(/^tel:\+91\d{10}$/.test(tel ?? ""), "…whose phone number is a tel: link", tel);
  const officeShare = await sharedUrl(page, office);
  check(!/[?&]seva=/.test(officeShare) && /\/sevas/.test(officeShare), "sharing the office-only seva hands out /sevas with no ?seva= deep link", officeShare);

  const online = sevaCard(page, NAMES.onlineSeva.en);
  check((await online.locator(".seva-card__book").count()) === 1, "the bookable seva keeps its Book control");
  const onlineShare = await sharedUrl(page, online);
  check(new RegExp(`[?&]seva=${seed.onlineSeva}(&|$)`).test(onlineShare), "…and shares its ?seva= deep link", onlineShare);

  check(page.errors().length === 0, "/sevas: no console errors", page.errors().slice(0, 3).join(" | "));
  check(!(await overflow(page)), "/sevas @1366: no horizontal overflow");
  const v = await axe(page);
  check(v.length === 0, "/sevas @1366: axe serious/critical violations", v.join("\n      "));
  await page.context().close();
}

async function sevasTamil() {
  section("/sevas — Tamil (390)");
  const page = await newPage({ width: 390, height: 844, lang: "ta" });
  await page.goto(`${BASE}/sevas`, { waitUntil: "networkidle" });
  await page.locator(".sevas-poojas").waitFor({ state: "visible" });
  check((await page.evaluate(() => document.documentElement.lang)) === "ta", "the page is in Tamil");
  const card = page.locator(`.pooja-card[data-pooja-id="${seed.pooja}"]`);
  const body = await text(card);
  check(body.includes(NAMES.pooja.ta), "E2E-003: the pooja's Tamil name is shown intact", body);
  check((await text(card.locator(".pooja-card__featured"))) === "சிறப்பு" && (await text(card.locator(".pooja-card__live"))).startsWith("நேரலை"), "the Featured and Live badges read in Tamil", body);
  const sponsorTa = card.locator("a.pooja-card__sponsor");
  check((await sponsorTa.getAttribute("href")) === `/donate?pooja=${seed.pooja}` && /ஸ்பான்சர்/.test(await text(sponsorTa)), "the sponsor link reads in Tamil and keeps its /donate?pooja=<id> target", await text(sponsorTa));
  check(body.includes("பௌர்ணமி அன்று சிறப்பு அபிஷேகம்"), "the Tamil description is shown", body);
  check(body.includes(NAMES.sponsorFamily), "the consented sponsor is named in Tamil mode too", body);
  const office = sevaCard(page, NAMES.officeSeva.ta);
  const officeText = await text(office);
  check(officeText.includes(NAMES.officeDesc.ta) && officeText.includes(NAMES.officeTiming.ta), "the office-only seva shows its Tamil description and timing", officeText);
  check((await office.locator(".seva-card__book").count()) === 0 && /அலுவலகத்தை/.test(officeText), "…no Book control, the office line in Tamil", officeText);
  check(!(await overflow(page)), "/sevas @390 Tamil: no horizontal overflow");
  check(page.errors().length === 0, "/sevas Tamil: no console errors", page.errors().slice(0, 3).join(" | "));
  await shot(page, "sevas-390-ta");
  await elShot(page.locator(".sevas-poojas"), "sevas-poojas-390-ta");
  await elShot(office, "sevas-office-card-390-ta");
  await page.context().close();
}

async function sevasDeepLinks() {
  section("/sevas?seva=<id>");
  const page = await newPage();
  await page.goto(`${BASE}/sevas?seva=${seed.officeSeva}`, { waitUntil: "networkidle" });
  await sevaCard(page, NAMES.officeSeva.en).waitFor({ state: "visible" });
  await sleep(1500);
  check((await page.locator('[role="dialog"]').count()) === 0, "?seva= for the office-only seva does not open the booking dialog");
  check(!/[?&]seva=/.test(page.url()), "…and the address bar stops naming a form that never opened", page.url());
  check(page.errors().length === 0, "office-only deep link: no console errors", page.errors().slice(0, 3).join(" | "));

  await page.goto(`${BASE}/sevas?seva=${seed.onlineSeva}`, { waitUntil: "networkidle" });
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible" });
  check((await dialog.count()) === 1 && (await text(dialog)).includes(NAMES.onlineSeva.en), "?seva= for the bookable seva opens its booking dialog", await text(dialog));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" }).catch(() => {});
  check(!/[?&]seva=/.test(page.url()), "closing the dialog clears ?seva= from the address", page.url());
  await page.context().close();
}

async function sevasOffline() {
  section("/sevas — online giving off");
  const page = await newPage();
  await page.route(
    (url) => url.pathname === "/api/payments/config",
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false, ready: false }) }),
  );
  await page.goto(`${BASE}/sevas`, { waitUntil: "networkidle" });
  await page.locator(".sevas-poojas").waitFor({ state: "visible" });
  const card = page.locator(`.pooja-card[data-pooja-id="${seed.pooja}"]`);
  const sponsor = card.locator(".pooja-card__sponsor");
  const href = await sponsor.getAttribute("href");
  check(/^tel:\+91\d{10}$/.test(href ?? ""), "without online giving, Sponsor this pooja becomes the office's phone number", href);
  check(/call/i.test(await text(sponsor)), "…and says so", await text(sponsor));
  check((await page.locator(`a[href="/donate?pooja=${seed.pooja}"]`).count()) === 0, "…with no /donate link on the page");
  await page.context().close();
}

async function sevasSmall() {
  section("/sevas @360");
  const page = await newPage({ width: 360, height: 780 });
  await page.goto(`${BASE}/sevas`, { waitUntil: "networkidle" });
  await page.locator(".sevas-poojas").waitFor({ state: "visible" });
  check(!(await overflow(page)), "/sevas @360: no horizontal overflow");
  const v = await axe(page);
  check(v.length === 0, "/sevas @360: axe serious/critical violations", v.join("\n      "));
  check(page.errors().length === 0, "/sevas @360: no console errors", page.errors().slice(0, 3).join(" | "));
  await shot(page, "sevas-360");
  await page.context().close();
}

/** /events with the browser at 01:00 IST today: the UTC date is still yesterday (D-026). */
async function eventsAt(width, height, withAxe) {
  const page = await newPage({ width, height });
  const yesterday = addDays(TODAY, -1);
  const coming = addDays(TODAY, 9);
  // A controlled Pournami list, so "next" has one right answer: yesterday's
  // (expired in IST, still "today" in UTC) and the coming one.
  const pournami = (date, en, ta) => ({ date, title_ta: `பௌர்ணமி பூஜை ${ta}`, title_en: `Pournami Pooja ${en}`, desc_ta: "", desc_en: "", time: "4:00 PM – 9:00 PM", weekday_ta: "", weekday_en: "", tamil_month: { ta: "", en: "" } });
  await page.route(
    (url) => url.pathname === "/api/pournamis",
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([pournami(yesterday, "gone", "கடந்தது"), pournami(coming, "coming", "வரும்")]) }),
  );
  await page.clock.setFixedTime(new Date(`${TODAY}T01:00:00+05:30`));
  await page.goto(`${BASE}/events`, { waitUntil: "networkidle" });
  await page.locator(".events-timeline .events-item").first().waitFor({ state: "visible" });
  const utcDate = await page.evaluate(() => new Date().toISOString().slice(0, 10));
  check(utcDate === yesterday, `the browser's UTC date is yesterday (${yesterday}) at 01:00 IST`, utcDate);

  const nextDate = await page.locator(".events-hero__next-date").getAttribute("datetime");
  check(nextDate === coming, "D-026: the next Pournami is the coming one, not yesterday's", nextDate);
  check((await page.locator('.events-moon__tile[aria-current="date"]').count()) === 0, "D-026: no Pournami tile is flagged Today", "");
  const nextTile = page.locator(".events-moon__tile").filter({ hasText: "Next" });
  check((await nextTile.count()) === 1 && (await nextTile.locator("time").getAttribute("datetime")) === coming, "the coming Pournami's tile carries the Next flag", await nextTile.count());

  const titles = await page.locator(".events-timeline .events-item__title").allTextContents();
  // Featured first: the featured cards form an unbroken run at the top of the
  // timeline (another suite's featured event may share it), this run's
  // featured festival is in that run, and this run's unfeatured event dated
  // today still comes after it although it is sooner.
  const flags = await page.locator(".events-timeline .events-item").evaluateAll((els) =>
    els.map((el) => ({ featured: /Featured/.test(el.querySelector(".events-item__badges")?.textContent ?? ""), href: el.querySelector(".events-item__title a")?.getAttribute("href") ?? "" })),
  );
  const lead = flags.findIndex((f) => !f.featured);
  const run = lead === -1 ? flags : flags.slice(0, lead);
  check(run.length > 0 && flags.slice(run.length).every((f) => !f.featured), "the featured events lead the upcoming timeline as one run", JSON.stringify(flags.slice(0, 6)));
  check(run.some((f) => f.href === `/events/${seed.featuredEvent}`), "…and this run's featured festival (tomorrow) is in it", titles.slice(0, 4).join(" | "));
  const posFeatured = flags.findIndex((f) => f.href === `/events/${seed.featuredEvent}`);
  const posToday = flags.findIndex((f) => f.href === `/events/${seed.todayEvent}`);
  check(posFeatured !== -1 && posToday > posFeatured, "…ahead of the unfeatured event dated today", `${posFeatured} / ${posToday}`);
  const featuredLink = page.locator(`.events-timeline .events-item__title a[href="/events/${seed.featuredEvent}"]`);
  check((await featuredLink.count()) === 1, "…and its card links to /events/<id>");
  const todayLink = page.locator(`.events-timeline .events-item__title a[href="/events/${seed.todayEvent}"]`);
  check((await todayLink.count()) === 1, "E2E-018: the event dated today in IST is listed as upcoming and links to /events/<id>", titles.join(" | "));
  const pastTitle = titles.find((s) => s.includes("gone"));
  check(!pastTitle, "yesterday's Pournami is not in the upcoming list", titles.join(" | "));
  // The panel above the timeline leads the soonest featured upcoming event the
  // API holds: this run's festival unless another suite has a sooner one.
  const upcoming = await fetch(`${PHP_BASE}/api/events?upcoming=1&limit=100`).then((r) => r.json()).catch(() => []);
  const soonest = (Array.isArray(upcoming) ? upcoming : []).filter((e) => e.is_featured).sort((a, b) => a.event_date.localeCompare(b.event_date) || a.id - b.id)[0];
  const panelHref = await page.locator(".events-featured__title a").getAttribute("href").catch(() => null);
  check(Boolean(soonest) && panelHref === `/events/${soonest.id}` && (soonest.id === seed.featuredEvent || soonest.event_date <= addDays(TODAY, 1)), "the soonest featured event is also led large above the timeline, linking to /events/<id>", `${panelHref} vs ${soonest?.id}`);
  check(!(await overflow(page)), `/events @${width}: no horizontal overflow`);
  if (withAxe) {
    const v = await axe(page);
    check(v.length === 0, `/events @${width}: axe serious/critical violations`, v.join("\n      "));
  }
  check(page.errors().length === 0, `/events @${width}: no console errors`, page.errors().slice(0, 3).join(" | "));
  await shot(page, `events-${width}`);
  await page.context().close();
}

async function eventsPage() {
  section("/events — IST day, featured first, links (1366 and 360)");
  await eventsAt(1366, 900, true);
  await eventsAt(360, 780, true);

  // The timeline's month in the reading language (it was always English).
  const ta = await newPage({ width: 1366, height: 900, lang: "ta" });
  await ta.goto(`${BASE}/events`, { waitUntil: "networkidle" });
  await ta.locator(".events-timeline .events-item").first().waitFor({ state: "visible" });
  const months = (await ta.locator(".events-timeline .events-item__month").allTextContents()).map((s) => s.trim()).filter(Boolean);
  check(months.length > 0 && months.every((m) => /[஀-௿]/.test(m)), "in Tamil every timeline month is written in Tamil", months.slice(0, 6).join(" | "));
  const todayTitle = await text(ta.locator(`.events-timeline .events-item__title a[href="/events/${seed.todayEvent}"]`));
  check(/[஀-௿]/.test(todayTitle), "…and the seeded event's title is the Tamil one", todayTitle);
  check(ta.errors().length === 0, "/events Tamil: no console errors", ta.errors().slice(0, 3).join(" | "));
  await ta.context().close();
}

async function homePage() {
  section("/ — featured sevas and the gallery strip");
  const mine = (await fetch(`${PHP_BASE}/api/sevas?limit=100`).then((r) => r.json())).filter((s) => String(s.name_en).startsWith(PREFIX));
  check(mine.length === 2, "the two seeded sevas are in /api/sevas", JSON.stringify(mine.map((s) => s.name_en)));
  const page = await newPage();
  // The featured-seva request is answered with this run's two rows (as the
  // API shaped them) so the home page can be checked without re-ordering the
  // shared site's own featured sevas for anyone else.
  await page.route(
    (url) => url.pathname === "/api/sevas" && url.searchParams.get("featured") === "1",
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mine) }),
  );
  // The strip's request is answered the same way: this run's photos exactly
  // as the API shaped them, so another suite uploading photos at the same
  // time cannot push them out of the newest six.
  const myPhotos = (await fetch(`${PHP_BASE}/api/gallery?limit=200`).then((r) => r.json())).filter((g) => String(g.caption ?? "").startsWith(PREFIX));
  check(myPhotos.length === seed.photos.length, "the seeded photos are in /api/gallery", JSON.stringify(myPhotos.map((g) => g.id)));
  const pinGallery = (p) =>
    p.route(
      (url) => url.pathname === "/api/gallery" && !url.pathname.endsWith("/albums") && url.searchParams.has("limit"),
      (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(myPhotos) }),
    );
  await pinGallery(page);
  // The hero's live row names the broadcast's pooja and its consented sponsor
  // (migration 022): answered with one scheduled stream that carries both.
  const liveBody = (() => {
    const start = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const stream = {
      id: 990001, slug: "e2e-pubui-darshan", status: "SCHEDULED", provider: "youtube", timezone: "Asia/Kolkata",
      title_ta: "மாலை ஆரத்தி", title_en: "Evening Aarti", scheduled_start_at: start, day_bucket: "today", starts_in_seconds: 10800,
      pooja: { id: 1, name_ta: "பௌர்ணமி பூஜை", name_en: "Pournami Pooja", date: TODAY, time: null },
      event: null, sponsor: { name: `${PREFIX} Family`, note: null }, playback: { unavailable: false, reason: null },
    };
    return JSON.stringify({ live: [], upcoming: [stream], now: null, next: stream });
  })();
  const pinLive = (p) =>
    p.route(
      (url) => url.pathname === "/api/live-streams",
      (route) => route.fulfill({ status: 200, contentType: "application/json", body: liveBody }),
    );
  await pinLive(page);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const liveRow = page.locator(".home-hero__live-link small");
  await liveRow.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const liveText = await text(liveRow.first());
  check(liveText.includes("Evening Aarti") && liveText.includes("Pournami Pooja") && liveText.includes(`Sponsor: ${PREFIX} Family`), "the hero's live row names the stream, its pooja and its consented sponsor", liveText);
  await page.locator(".home-seva-grid").waitFor({ state: "visible" });

  const office = page.locator(`.home-seva[data-seva-id="${seed.officeSeva}"]`);
  check((await office.count()) === 1, "the office-only seva is on the home page");
  check(/^tel:(\+91)?\d{10}$/.test((await office.getAttribute("href")) ?? ""), "…is a call to the temple office (tel:), never a ?seva= booking link", await office.getAttribute("href"));
  const officeText = await text(office);
  check(officeText.includes(NAMES.officeDesc.en) && officeText.includes(NAMES.officeTiming.en), "…with its description and timing", officeText);
  check(!/Book/.test(officeText), "…and no Book call", officeText);
  const online = page.locator(`.home-seva[data-seva-id="${seed.onlineSeva}"]`);
  check((await online.getAttribute("href")) === `/sevas?seva=${seed.onlineSeva}`, "the bookable seva links to its ?seva= booking form", await online.getAttribute("href"));
  check(/Book/.test(await text(online)), "…with a Book call", await text(online));
  await elShot(page.locator(".home-seva-grid"), "home-sevas-1366");

  const strip = page.locator(".home-gallery__strip");
  check((await strip.count()) === 1, "the gallery preview strip is on the page");
  await strip.scrollIntoViewIfNeeded();
  for (const photo of seed.photos) {
    const img = strip.locator(`img[alt="${photo.alt.en}"]`);
    check((await img.count()) === 1, `photo ${photo.id}: shown with its English alt text`);
    check((await img.getAttribute("loading")) === "lazy" && (await img.getAttribute("decoding")) === "async", `photo ${photo.id}: loading="lazy" decoding="async"`);
    check((await img.getAttribute("width")) === "480" && (await img.getAttribute("height")) === "360", `photo ${photo.id}: width and height from the row`, `${await img.getAttribute("width")}×${await img.getAttribute("height")}`);
    const href = await img.locator("xpath=ancestor::a[1]").getAttribute("href");
    check(href === `/gallery?photo=${photo.id}`, `photo ${photo.id}: links to /gallery?photo=<id>`, href);
    const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
    check(loaded, `photo ${photo.id}: the file was served and decoded`);
  }
  check((await strip.locator("img").count()) <= 6, "the strip shows at most six photographs", await strip.locator("img").count());
  check(page.errors().length === 0, "/: no console errors", page.errors().slice(0, 3).join(" | "));
  check(!(await overflow(page)), "/ @1366: no horizontal overflow");
  await shot(page, "home-1366");
  await page.context().close();

  const ta = await newPage({ width: 360, height: 780, lang: "ta" });
  await pinGallery(ta);
  await pinLive(ta);
  await ta.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const taLive = await text(ta.locator(".home-hero__live-link small").first());
  check(taLive.includes("மாலை ஆரத்தி") && taLive.includes("பௌர்ணமி பூஜை") && taLive.includes(`ஸ்பான்சர்: ${PREFIX} Family`), "in Tamil the live row reads the Tamil stream and pooja names", taLive);
  const taStrip = ta.locator(".home-gallery__strip");
  await taStrip.scrollIntoViewIfNeeded();
  check((await taStrip.locator(`img[alt="${seed.photos[0].alt.ta}"]`).count()) === 1, "in Tamil the strip uses the Tamil alt text");
  check(!(await overflow(ta)), "/ @360: no horizontal overflow");
  await elShot(ta.locator(".home-gallery"), "home-gallery-360-ta");
  check(ta.errors().length === 0, "/ @360 Tamil: no console errors", ta.errors().slice(0, 3).join(" | "));
  await ta.context().close();

  const empty = await newPage();
  await empty.route(
    (url) => url.pathname === "/api/gallery",
    (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await empty.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await empty.locator(".home-seva-grid").waitFor({ state: "visible" });
  check((await empty.locator(".home-gallery").count()) === 0, "with an empty gallery answer there is no strip and no heading");
  await empty.context().close();
}

async function donatePooja() {
  section("/donate?pooja=<id>");
  const page = await newPage();
  const asked = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/")) asked.push(u.pathname + u.search);
  });
  await page.goto(`${BASE}/donate?pooja=${seed.pooja}`, { waitUntil: "networkidle" });
  const name = page.locator(".don-pooja__name");
  await name.waitFor({ state: "visible" });
  await page.waitForFunction(() => !/Finding the pooja/.test(document.querySelector(".don-pooja__name")?.textContent ?? ""));
  const label = await text(name);
  // The seeded pooja has no homepage card at all, so its name can only have come from the pooja list.
  check(label.includes(NAMES.pooja.en), "the donation names the pooja from /api/poojas", label);
  check(asked.some((p) => /^\/api\/poojas\?all=1/.test(p)) && !asked.some((p) => p.startsWith("/api/homepage_widgets")), "…looked up in GET /api/poojas?all=1, not the homepage widgets", asked.join(" "));
  check(page.errors().length === 0, "/donate?pooja=: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();
}

/* ── Main ───────────────────────────────────────────────────────────────── */

let php = null;
let vite = null;

try {
  section("Preflight");
  for (const [port, host] of [[PHP_PORT, "127.0.0.1"], [VITE_PORT, "127.0.0.1"]]) {
    if (await portInUse(port, host)) {
      console.log(`✗ port ${port} (${host}) is already in use — stop whatever holds it (never the user's :8000/:5173)`);
      process.exit(2);
    }
  }
  if (!existsSync(UPLOADS)) mkdirSync(UPLOADS, { recursive: true });
  console.log(`  cleanup at start: ${JSON.stringify(cleanup())}`);
  seedRows();
  check([seed.pooja, seed.closed, seed.past, seed.officeSeva, seed.onlineSeva, seed.todayEvent, seed.featuredEvent, ...seed.photos.map((p) => p.id)].every((n) => Number.isInteger(n) && n > 0), "the seed rows were written", JSON.stringify(seed));

  php = startPhp();
  check(await waitForUrl(`${PHP_BASE}/api/pulse`), `PHP answers on ${PHP_BASE}`, php.log.slice(-400));
  const cfg = await fetch(`${PHP_BASE}/api/payments/config`).then((r) => r.json()).catch(() => null);
  check(cfg?.enabled === true && cfg.ready === true && cfg.simulator === true, "the test server runs the payments simulator", JSON.stringify(cfg).slice(0, 300));
  const api = await fetch(`${PHP_BASE}/api/poojas?upcoming=1&limit=6`).then((r) => r.json()).catch(() => null);
  const row = Array.isArray(api) ? api.find((p) => p.id === seed.pooja) : null;
  check(Boolean(row) && row.sponsor?.name === NAMES.sponsorFamily && row.is_featured === true && row.live_stream_enabled === true, "/api/poojas?upcoming=1 carries the seeded pooja with its consented sponsor", JSON.stringify(row).slice(0, 300));

  vite = startVite();
  check(await waitForUrl(`${BASE}/`), `Vite answers on ${BASE}`, vite.log.slice(-400));
  const viaProxy = await fetch(`${BASE}/api/payments/config`).then((r) => r.json()).catch(() => null);
  check(viaProxy?.simulator === true, "the test Vite proxies /api to the test PHP");

  browser = await chromium.launch();
  // Warm the lazy routes once so the first real scenario is not the one paying for compilation.
  const warm = await newPage();
  for (const path of ["/sevas", "/events", "/", "/donate"]) {
    await warm.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await warm.locator("h1").first().waitFor().catch(() => {});
  }
  await warm.context().close();

  await scenario("sevas", sevasPage);
  await scenario("sevas-tamil", sevasTamil);
  await scenario("sevas-deep-links", sevasDeepLinks);
  await scenario("sevas-offline", sevasOffline);
  await scenario("sevas-360", sevasSmall);
  await scenario("events", eventsPage);
  await scenario("home", homePage);
  await scenario("donate", donatePooja);
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
    const after = cleanup();
    console.log(`  cleanup at end: ${JSON.stringify(after)}`);
    const left = sql(
      "SELECT (SELECT COUNT(*) FROM poojas WHERE name_en LIKE ?) + (SELECT COUNT(*) FROM sevas WHERE name_en LIKE ?) + (SELECT COUNT(*) FROM events WHERE title_en LIKE ?) + (SELECT COUNT(*) FROM gallery WHERE caption LIKE ?) + (SELECT COUNT(*) FROM sponsors WHERE name LIKE ?) AS n",
      [`${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`],
    )[0];
    check(Number(left?.n) === 0, "no rows of this run are left behind", JSON.stringify(left));
    check(seed.files.every((f) => !existsSync(resolve(UPLOADS, f))), "no files of this run are left behind");
  } catch (e) {
    check(false, "cleanup at the end", String(e?.message || e));
  }
  await stopServer(vite, ["127.0.0.1"]);
  await stopServer(php, ["127.0.0.1"]);
  const still = (await portInUse(PHP_PORT)) || (await portInUse(VITE_PORT));
  check(!still, "both test servers are stopped");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
