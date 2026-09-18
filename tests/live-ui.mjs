#!/usr/bin/env node
/**
 * tests/live-ui.mjs — the devotee's side of Live Darshan, in a real browser
 * against a PHP server and a Vite dev server this suite starts itself
 * (docs/live/SPEC-PHASE1.md §5, §6 "live-ui").
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
 *     node tests/live-ui.mjs
 *
 *   LIVE_SHOTS=<dir>   where the screenshots go (default shots/live)
 *   LIVE_ONLY=a,b      run a subset of scenarios while a failure is chased
 *
 * Servers (both stopped at the end, whatever happens):
 *   • PHP on 127.0.0.1:8083 with SITE_URL=http://localhost:5195;
 *   • a throwaway Vite on http://localhost:5195 whose /api proxy points at that
 *     PHP (VITE_PROXY_TARGET). The user's own :8000 / :5173 are never touched.
 *
 * Every YouTube host (youtube.com, youtube-nocookie.com, ytimg.com,
 * googlevideo.com) is answered by a stub before any navigation, so nothing
 * leaves the machine and the player frame is inspected, not played.
 *
 * What it proves:
 *   • /live-darshan with a LIVE broadcast at 390/768/1024/1440: one h1, no
 *     horizontal overflow, no console errors, axe (iframes off) clean at 390
 *     and 1440; the temple header, the status badge, the title, description,
 *     temple, deity, programme, date and time are on the page; the upcoming
 *     grid lists the scheduled broadcast;
 *   • the YouTube iframe: host www.youtube-nocookie.com, path /embed/<id>,
 *     rel=0, playsinline=1, hl=ta then hl=en after the language toggle, its
 *     title, allow (autoplay, picture-in-picture), allowfullscreen,
 *     referrerpolicy and lazy loading; a 16:9 box within 2 px at 390 and 1440;
 *   • /live-darshan/<slug> loads directly, an unknown slug and a DRAFT slug show
 *     the not-found state, OFFLINE and COMPLETED show their poster text and no
 *     iframe; "Watch on YouTube" opens in a new tab with noopener;
 *   • Tamil by default (<html lang="ta">), English after the toggle and still
 *     English after a reload;
 *   • the header link, the drawer link, the footer link and the Home NRI tile
 *     all reach /live-darshan; the tile keeps a secondary YouTube-channel link;
 *   • the header and status strip fit at the same 30 widths tests/public-e2e.mjs
 *     measures, with the new nav entry (SPEC Decision 3);
 *   • after the live broadcast ends the scheduled one is shown as a poster with
 *     "Starts <date> at <time> IST" and no iframe; after that one is cancelled
 *     the empty state offers the YouTube channel and the events page;
 *   • Phase 2 (docs/live/SPEC-PHASE2.md §3): /live-darshan/schedule at four
 *     widths (one h1, no overflow, no console errors, axe with iframes off),
 *     the five filters with their counts, filter switching that updates the
 *     address and the list, a direct load with ?filter=, an unknown filter,
 *     the day headings ("Live now", "Today ·", "Tomorrow ·"), the compact
 *     countdown on a card within the next day, the per-filter empty state
 *     with its switch button, Tamil labels; the countdown on /live-darshan
 *     with a fixture starting in 90 s (HH:MM:SS, two samples 5 s apart differ
 *     by about 5 s, the sr-only sentence, aria-hidden digits, "Starting
 *     shortly" at T+0) and a server_time skewed by ±10 min shifting it (the
 *     server offset is used, not the phone's clock); the homepage in its
 *     three states — LIVE NOW card with Watch live reaching the broadcast,
 *     the next darshan with its countdown and View schedule, and nothing at
 *     all (no live section, no empty band) — plus the hero panel row.
 *
 * Data: streams titled "E2E-LIVE-ui<run> …", X-Forwarded-For 10.84.0.200–249.
 * Rows are removed by title prefix at the start and in `finally`, with their
 * admin_activity rows and rate-limit buckets.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const FRONTEND = resolve(ROOT, "frontend");
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(resolve(FRONTEND, "node_modules/axe-core/axe.min.js"), "utf8");

const PHP_BIN = process.env.PHP_BIN || "php";
const PHP_PORT = Number(process.env.LIVE_UI_PHP_PORT || 8083);
const VITE_PORT = Number(process.env.LIVE_UI_VITE_PORT || 5195);
const PHP_BASE = `http://127.0.0.1:${PHP_PORT}`;
const BASE = `http://localhost:${VITE_PORT}`;
const RUN = `ui${Date.now().toString(36)}`;
const PREFIX = `E2E-LIVE-${RUN}`;
const CLEAN_PREFIX = "E2E-LIVE-ui";
const SHOTS = process.env.LIVE_SHOTS || resolve(ROOT, "shots/live");
mkdirSync(SHOTS, { recursive: true });
const YT = "dQw4w9WgXcQ";
const YT2 = "jNQXAC9IVRw";
const CHANNEL_URL = "https://youtube.com/@TempleMahendra";
const YOUTUBE_HOSTS = /youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com/;

// The payments simulator is switched on so the Donate action (SPEC-PHASE4 §2.2)
// can be seen; the values are invented here and nothing real is read or written.
const SERVER_ENV = {
  SITE_URL: BASE, TRUSTED_PROXIES: "127.0.0.1,::1", CORS_ORIGIN: "*",
  PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SECRET: "e2e-live-ui-fake-secret-0123456789abcdef-not-real",
  PAYMENTS_SETTINGS_KEY: Buffer.from("e2e-live-ui-fake-settings-key!!!").toString("base64"),
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({ enabled: "1", mode: "simulator", default_currency: "INR", currencies: "INR" }),
};

/* ── Reporting (style A) ────────────────────────────────────────────────── */
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
const ONLY = (process.env.LIVE_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const openPages = new Set();
async function scenario(key, name, fn) {
  if (ONLY.length && !ONLY.includes(key)) return;
  section(name);
  try {
    await fn();
  } catch (e) {
    check(false, `${name} (scenario threw)`, String(e?.stack || e).split("\n").slice(0, 3).join(" "));
    for (const page of openPages) {
      try {
        console.log(`    at ${page.url()}`);
        const errs = page.errors();
        if (errs.length) console.log(`    browser: ${errs.slice(0, 3).join(" | ").slice(0, 600)}`);
        await page.screenshot({ path: resolve(SHOTS, `fail-${key}.png`), fullPage: true });
        await page.context().close();
      } catch {
        /* already closed */
      }
    }
  }
}

/* ── PHP fixtures ───────────────────────────────────────────────────────── */
const STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i; // no real YouTube key or LIVE_CRON_KEY from the shell reaches a PHP child (SPEC-PHASE3 §11.4)
const viaBash = /\.sh$/i.test(PHP_BIN);
const phpNoise = [];
/** One fixture command; the JSON travels on stdin so Tamil survives the Windows command line. */
function fixture(command, args = {}) {
  const argv = ["tests/support/live_fixtures.php", command, "-"];
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...argv] : argv, {
    cwd: ROOT, input: JSON.stringify(args), encoding: "utf8", env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k))), ...SERVER_ENV }, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) throw r.error;
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(`${r.stdout}\n${r.stderr}`);
  if (m) phpNoise.push(`fixture ${command}: ${m[0]}`);
  const line = (r.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  let json;
  try { json = JSON.parse(line); } catch { throw new Error(`fixture ${command} printed no JSON (exit ${r.status}): ${(r.stdout || "").slice(-300)} ${(r.stderr || "").slice(-300)}`); }
  if (json.error) throw new Error(`fixture ${command}: ${json.error}${json.fields ? " " + JSON.stringify(json.fields) : ""}`);
  return json;
}
const sql = (query, params = []) => fixture("sql", { query, params }).rows;
const mkStream = (over = {}) => fixture("create-stream", { title_prefix: PREFIX, actor: "e2e", ...over });
const setStatus = (id, status) => fixture("set-status", { id, status, actor: "e2e" });

const usedIps = new Set();
let ipSeq = 200;
function nextIp() {
  const ip = `10.84.0.${ipSeq}`;
  ipSeq = ipSeq >= 249 ? 200 : ipSeq + 1;
  usedIps.add(ip);
  return ip;
}
const cleanup = () => fixture("cleanup", { title_prefix: CLEAN_PREFIX, ips: [...usedIps] });

/* ── Servers ────────────────────────────────────────────────────────────── */
function portInUse(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const sock = connect({ port, host });
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("error", () => done(false));
  });
}
function startPhp() {
  const args = ["-S", `127.0.0.1:${PHP_PORT}`, "router.php"];
  const child = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: resolve(ROOT, "backend"), env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k))), ...SERVER_ENV }, windowsHide: true });
  const server = { child, port: PHP_PORT, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  return server;
}
function startVite() {
  const child = spawn(process.execPath, [resolve(FRONTEND, "node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"], {
    cwd: FRONTEND, env: { ...process.env, VITE_PROXY_TARGET: PHP_BASE }, windowsHide: true,
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
      if (res.status < 500) return true;
    } catch { /* not listening yet */ }
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
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] === "LISTENING" && (cols[1] ?? "").endsWith(`:${server.port}`)) spawnSync("taskkill", ["/pid", cols[4], "/T", "/F"], { windowsHide: true });
    }
  }
}

/* ── Browser ────────────────────────────────────────────────────────────── */
let browser;
const IGNORE = /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js|React Router Future Flag/;

/**
 * A page in its own context. `lang` null leaves the site to its default
 * (Tamil); otherwise the remembered language is pre-set. Every YouTube host
 * is stubbed before the first navigation.
 */
async function newPage({ width = 1440, height = 900, lang = "en", address = nextIp(), slowApi = null, slowMs = 800 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  await ctx.addInitScript((l) => {
    try {
      if (l) localStorage.setItem("temple:lang", l);
      localStorage.setItem("templeVisited", "1");
    } catch {
      /* private mode */
    }
  }, lang);
  // Playwright tries the most recently registered route first, so the header
  // route is registered first and hands every third-party request on
  // (fallback), and the YouTube stub, registered last, answers those before
  // anything can leave the machine.
  const origin = new URL(BASE).origin;
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== origin) return route.fallback();
    return route.continue({ headers: { ...req.headers(), "x-forwarded-for": address } });
  });
  await ctx.route(YOUTUBE_HOSTS, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" }));
  // An API answer held back, so what the page does while it waits can be seen
  // (the filter switch keeping its list — review fix F6). Registered last, so
  // it answers before the header route above; it forwards the same address.
  if (slowApi) {
    await ctx.route(slowApi, async (route) => {
      await sleep(slowMs);
      const req = route.request();
      await route.continue({ headers: { ...req.headers(), "x-forwarded-for": address } }).catch(() => {});
    });
  }
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
  page.errors = () => errors.filter((e) => !IGNORE.test(e) && !allowed.some((re) => re.test(e)));
  page.address = address;
  openPages.add(page);
  ctx.on("close", () => openPages.delete(page));
  return page;
}
const shot = (page, name) => page.screenshot({ path: resolve(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
async function axe(page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const res = await window.axe.run(document, {
      iframes: false,
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
      rules: { "color-contrast": { enabled: true } },
    });
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
  });
}
const text = async (loc) => ((await loc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);
/** dt → dd of the broadcast details list. */
const facts = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll(".live-meta .live-meta__row")) {
      const dt = row.querySelector("dt");
      const dd = row.querySelector("dd");
      if (dt && dd) out[dt.textContent.replace(/\s+/g, " ").trim()] = dd.textContent.replace(/\s+/g, " ").trim();
    }
    return out;
  });
async function openLive(page, path = "/live-darshan") {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor();
  await page.locator(".live-stage, .live-empty, .error-state, [class*='error']").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
}
const iframeAttrs = (page) =>
  page.evaluate(() => {
    const f = document.querySelector(".live-player__iframe");
    if (!f) return null;
    const r = f.parentElement.getBoundingClientRect();
    return {
      src: f.getAttribute("src"), title: f.getAttribute("title"), allow: f.getAttribute("allow"),
      allowfullscreen: f.hasAttribute("allowfullscreen"), referrerpolicy: f.getAttribute("referrerpolicy"), loading: f.getAttribute("loading"),
      frameW: r.width, frameH: r.height,
    };
  });

/* ── Fixtures ───────────────────────────────────────────────────────────── */
const F = {};
const tomorrowIst = (() => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
})();
const dayAfterIst = (() => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + 48 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
})();
const longDate = (ymd, lang = "en") => new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(`${ymd}T12:00:00+05:30`));
/** The IST calendar date some days from today ('YYYY-MM-DD'). */
const istDate = (days = 0) => new Date(Date.now() + 5.5 * 3600 * 1000 + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
/** The title of the broadcast the list route features: the head's h2 while live, the next-darshan card's h2 otherwise (Phase 2). */
const mainTitle = (page) => text(page.locator(".live-stage__main h2").first());
async function openSchedule(page, query = "") {
  await page.goto(`${BASE}/live-darshan/schedule${query}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor();
  await page.locator(".live-schedule__day, .live-schedule__empty, .empty-state--error").first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
}
/** "HH:MM:SS" of a countdown clock, and that as seconds. */
const clockOf = async (loc) => (await loc.locator(".live-countdown__digits").allTextContents()).map((s) => s.trim()).join(":");
const clockSeconds = (s) => { const [h, m, sec] = s.split(":").map(Number); return h * 3600 + m * 60 + sec; };
/** The clock's units as the page draws them: [{ digits, label }, …] — four once a days unit is shown. */
const clockUnits = (loc) =>
  loc.locator(".live-countdown__unit").evaluateAll((els) =>
    els.map((el) => ({
      digits: el.querySelector(".live-countdown__digits")?.textContent.trim() ?? "",
      label: el.querySelector(".live-countdown__label")?.textContent.trim() ?? "",
    })),
  );
/** Every filter chip as it is laid out: its box, whether it is selected and whether it sits inside the strip. */
const filterChips = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector(".live-filters");
    if (!strip) return null;
    const box = strip.getBoundingClientRect();
    return [...strip.querySelectorAll('[role="tab"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: el.textContent.replace(/\s+/g, " ").trim(),
        left: Math.round(r.left),
        right: Math.round(r.right),
        height: Math.round(r.height),
        selected: el.getAttribute("aria-selected") === "true",
        inStrip: r.left >= box.left - 1 && r.right <= box.right + 1,
      };
    });
  });
/** "வியாழன், 24 செப்டம்பர்" — the Tamil day label the page should build (review fix F5). */
function taDayLabel(ymd) {
  const parts = new Intl.DateTimeFormat("ta-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long" }).formatToParts(new Date(`${ymd}T12:00:00+05:30`));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")}`;
}

/* ── Scenarios ──────────────────────────────────────────────────────────── */
async function liveAtWidths() {
  for (const w of [390, 768, 1024, 1440]) {
    const page = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await openLive(page);
    const h1s = await page.locator("h1").count();
    check(h1s === 1, `/live-darshan @${w}: exactly one h1`, `found ${h1s}`);
    check((await text(page.locator("h1"))) === "Live Darshan", `/live-darshan @${w}: the h1 is the page title`, await text(page.locator("h1")));
    check(!(await overflow(page)), `/live-darshan @${w}: no horizontal overflow`);
    check((await page.locator(".navbar").count()) === 1 && (await page.locator(".live-player__iframe").count()) === 1, `/live-darshan @${w}: the temple header and the player are on the page`);
    const a = await iframeAttrs(page);
    check(a && Math.abs(a.frameH - (a.frameW * 9) / 16) <= 2 && a.frameW <= w, `/live-darshan @${w}: the player box is 16:9 within 2 px`, JSON.stringify({ w: a?.frameW, h: a?.frameH }));
    if (w === 1440 || w === 390) {
      const v = await axe(page);
      check(v.length === 0, `/live-darshan @${w}: axe serious/critical violations (iframes off)`, v.join("\n      "));
      await shot(page, `live-${w}`);
    }
    const errs = page.errors();
    check(errs.length === 0, `/live-darshan @${w}: no console errors`, errs.slice(0, 3).join(" | "));
    await page.context().close();
  }
}

async function liveFacts() {
  const page = await newPage();
  await openLive(page);
  check(/Renuka Devi Lingamma Sinnammal Temple/.test(await text(page.locator(".page-hero__eyebrow"))), "the hero eyebrow names the temple", await text(page.locator(".page-hero__eyebrow")));
  const hero = page.locator(".live-hero__status");
  check((await hero.count()) === 1 && /Live now/.test(await text(hero)) && /Started \d{1,2}:\d{2} (am|pm) IST/.test(await text(hero)), "the hero shows the Live now badge and when it started", await text(hero));
  check((await hero.locator(".badge").getAttribute("class"))?.includes("badge--live"), "the hero badge carries the live dot");
  check((await text(page.locator(".live-stream__title"))) === F.live.title_en, "the stream title is shown", await text(page.locator(".live-stream__title")));
  check(/Test live darshan created by the test suite/.test(await text(page.locator(".live-stream__desc"))), "the description is shown");
  const f = await facts(page);
  check(/Sri Lingammal/.test(f.Temple ?? ""), "details: Temple", JSON.stringify(f));
  check(/Sri Lingammal/.test(f.Deity ?? ""), "details: Deity", f.Deity);
  check(f.Programme === "Live darshan", "details: Programme (the API's English label)", f.Programme);
  check(/\d{4}/.test(f.Date ?? "") && /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/.test(f.Date ?? ""), "details: Date as a long date", f.Date);
  check(f.Date === longDate(tomorrowIst), "details: Date is the scheduled date (the same instant as Time, not the day it actually started)", `${f.Date} vs ${longDate(tomorrowIst)}`);
  check(/^6:00 pm – 7:00 pm IST/.test(f.Time ?? "") && /Started \d{1,2}:\d{2} (am|pm) IST$/.test(f.Time ?? ""), "details: Time is the scheduled window in IST with the actual start as the sub-line", f.Time);
  check(/Live now/.test(f.Status ?? ""), "details: Status badge", f.Status);
  check((await page.locator(".live-actions .share-btn").count()) === 1, "the share button is offered when sharing is enabled");
  const cards = page.locator(".live-upcoming .live-card");
  check((await cards.count()) >= 1 && (await cards.first().getAttribute("href")) === `/live-darshan/${F.sched.slug}`, "the upcoming grid lists the scheduled broadcast and links to its page", await cards.first().getAttribute("href").catch(() => "none"));
  check(/Scheduled/.test(await text(cards.first())) && /\d{1,2}:\d{2} (am|pm) IST/.test(await text(cards.first())), "…with its Scheduled badge and time", await text(cards.first()));
  const foot = page.locator(".live-player__foot a");
  check((await foot.count()) === 1 && (await foot.getAttribute("href")) === `https://www.youtube.com/watch?v=${YT}` && (await foot.getAttribute("target")) === "_blank" && /noopener/.test((await foot.getAttribute("rel")) ?? ""), "Watch on YouTube opens the watch page in a new tab with noopener", `${await foot.getAttribute("href")} ${await foot.getAttribute("rel")}`);
  check((await text(foot)) === "Watch on YouTube", "…and reads Watch on YouTube", await text(foot));
  const targets = await page.evaluate(() => [...document.querySelectorAll("main a.btn, main button")].map((el) => ({ h: el.getBoundingClientRect().height, t: el.textContent.trim().slice(0, 30) })).filter((x) => x.h > 0 && x.h < 44));
  check(targets.length === 0, "every button the page places is at least 44 px tall", JSON.stringify(targets));
  check(page.errors().length === 0, "facts: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
}

async function iframeChecks() {
  // Tamil first (the site's default), then English after the toggle.
  const page = await newPage({ lang: null });
  await openLive(page);
  check((await htmlLang(page)) === "ta", "the page opens in Tamil");
  let a = await iframeAttrs(page);
  const u = new URL(a?.src ?? "http://x/");
  check(u.host === "www.youtube-nocookie.com", "iframe host is www.youtube-nocookie.com", a?.src);
  check(u.pathname === `/embed/${YT}`, "iframe path is /embed/<id>", u.pathname);
  check(u.searchParams.get("rel") === "0" && u.searchParams.get("playsinline") === "1", "iframe query carries rel=0 and playsinline=1", u.search);
  check(u.searchParams.get("hl") === "ta", "iframe hl=ta in Tamil", u.search);
  check(!u.searchParams.has("autoplay"), "no autoplay parameter (the player's own control is used)", u.search);
  check((a?.title ?? "").startsWith("நேரடி தரிசனம் – ") && (a?.title ?? "").endsWith(F.live.title_ta), "iframe title names the broadcast in Tamil", a?.title);
  check(/autoplay/.test(a?.allow ?? "") && /picture-in-picture/.test(a?.allow ?? ""), "iframe allow includes autoplay and picture-in-picture", a?.allow);
  check(a?.allowfullscreen === true, "iframe allows full screen");
  check(a?.referrerpolicy === "strict-origin-when-cross-origin", "iframe referrerpolicy is strict-origin-when-cross-origin", a?.referrerpolicy);
  check(a?.loading === "lazy", "iframe loads lazily", a?.loading);
  check(/நேரலை/.test(await text(page.locator(".live-hero__status"))), "the badge reads நேரலை in Tamil", await text(page.locator(".live-hero__status")));
  check((await text(page.locator("h1"))) === "நேரடி தரிசனம்", "the h1 is the Tamil page title", await text(page.locator("h1")));
  await page.locator('.lang-toggle__btn[lang="en"]').first().click();
  await page.waitForTimeout(400);
  check((await htmlLang(page)) === "en", "the toggle switches to English");
  a = await iframeAttrs(page);
  check(new URL(a?.src ?? "http://x/").searchParams.get("hl") === "en", "iframe hl=en after the toggle", a?.src);
  check((a?.title ?? "").startsWith("Live darshan – ") && (a?.title ?? "").endsWith(F.live.title_en), "iframe title follows the language", a?.title);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".live-stage").waitFor();
  check((await htmlLang(page)) === "en" && (await text(page.locator("h1"))) === "Live Darshan", "English survives a reload");
  check(page.errors().length === 0, "iframe: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
}

async function slugRoutes() {
  const page = await newPage();
  await openLive(page, `/live-darshan/${F.live.slug}`);
  check((await page.locator(".live-player__iframe").count()) === 1 && (await text(page.locator(".live-stream__title"))) === F.live.title_en, "/live-darshan/<slug> loads the live broadcast directly");
  check((await page.locator('.page-hero a[href="/live-darshan"]').count()) >= 1, "the crumb trail links back to /live-darshan");
  const share = page.locator(".live-actions .share-btn");
  await share.click();
  const shown = await page.locator(".share-link__url").inputValue().catch(() => "");
  check(shown === `${BASE}/live-darshan/${F.live.slug}`, "the share sheet hands out the broadcast's own address", shown);
  await page.keyboard.press("Escape");
  check((await page.locator(".live-upcoming .live-card").count()) >= 1 && (await page.locator(`.live-upcoming .live-card[href="/live-darshan/${F.live.slug}"]`).count()) === 0, "the upcoming grid excludes the broadcast being viewed");
  check(page.errors().length === 0, "slug: no console errors", page.errors().slice(0, 2).join(" | "));

  // An unknown slug is a 404 from the API; the browser logs that fetch, which is expected here.
  page.allowErrors(/404|Failed to load resource/);
  await openLive(page, `/live-darshan/no-such-darshan-${RUN}`);
  const empty = page.locator(".live-empty");
  check((await empty.count()) === 1 && /That darshan was not found/.test(await text(empty)), "an unknown slug shows the not-found state", await text(empty));
  check((await empty.locator('a[href="/live-darshan"]').count()) === 1, "…with a way back to Live Darshan");
  check((await page.locator("h1").count()) === 1 && (await page.locator(".live-player__iframe").count()) === 0, "…one h1 and no player");
  await openLive(page, `/live-darshan/${F.draft.slug}`);
  check(/That darshan was not found/.test(await text(page.locator(".live-empty"))), "a DRAFT slug is not found");
  // A slug the pattern refuses is "not found" without any request.
  const requests = [];
  page.on("request", (r) => { if (r.url().includes("/api/live-streams/")) requests.push(r.url()); });
  await openLive(page, `/live-darshan/${encodeURIComponent('"><script>alert(1)</script>')}`);
  check(/That darshan was not found/.test(await text(page.locator(".live-empty"))) && requests.length === 0, "a hostile slug is not found without asking the API", requests.join(" "));
  await page.context().close();

  const off = await newPage();
  await openLive(off, `/live-darshan/${F.off.slug}`);
  check((await off.locator(".live-player__iframe").count()) === 0 && (await off.locator(".live-player__poster").count()) === 1, "OFFLINE: a poster, no iframe");
  check((await text(off.locator(".live-player__state-text"))) === "The broadcast is temporarily offline. Please check again shortly.", "OFFLINE: the state text", await text(off.locator(".live-player__state-text")));
  check(/Temporarily offline/.test(await text(off.locator(".live-player__state"))) && /Temporarily offline/.test(await text(off.locator(".live-hero__status"))), "OFFLINE: the badge on the poster and in the hero");
  check((await off.locator(".live-player__foot a").count()) === 1, "OFFLINE: Watch on YouTube is still offered");
  await shot(off, "offline-1440");
  await openLive(off, `/live-darshan/${F.done.slug}`);
  check((await off.locator(".live-player__iframe").count()) === 0 && (await text(off.locator(".live-player__state-text"))) === "This darshan has ended.", "COMPLETED: the poster says the darshan has ended", await text(off.locator(".live-player__state-text")));
  check(/Ended \d{1,2}:\d{2} (am|pm) IST/.test((await facts(off)).Time ?? ""), "COMPLETED: the details show when it ended", (await facts(off)).Time);
  check(off.errors().length === 0, "offline/completed: no console errors", off.errors().slice(0, 2).join(" | "));
  await off.context().close();

  // ERROR, in Tamil: the badge says the darshan is unavailable, not that there is "a problem".
  F.err = mkStream({ label: "Error one", status: "ERROR", scheduled_start_local: `${dayAfterIst} 09:00` });
  const err = await newPage({ lang: null });
  await openLive(err, `/live-darshan/${F.err.slug}`);
  const errHero = await text(err.locator(".live-hero__status"));
  check(/கிடைக்கவில்லை/.test(errHero) && !/பிரச்சனை/.test(errHero) && (await err.locator(".live-player__iframe").count()) === 0, "ERROR: the Tamil badge reads கிடைக்கவில்லை on a poster, no iframe", errHero);
  check((await text(err.locator(".live-player__state-text"))) === "நேரடி தரிசனம் தற்காலிகமாகக் கிடைக்கவில்லை.", "ERROR: the Tamil state text", await text(err.locator(".live-player__state-text")));
  await err.context().close();
  setStatus(F.err.id, "CANCELLED");
}

async function entryPoints() {
  const page = await newPage();
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor();
  const nav = page.locator('.navbar__nav a[href="/live-darshan"]');
  check((await nav.count()) === 1 && (await nav.isVisible()) && (await text(nav)) === "Live Darshan", "the header carries a Live Darshan link", await text(nav));
  await nav.click();
  await page.locator(".live-stage").waitFor();
  check(new URL(page.url()).pathname === "/live-darshan" && (await text(page.locator("h1"))) === "Live Darshan", "…which reaches the page");
  check((await page.locator('.navbar__nav a[href="/live-darshan"]').getAttribute("class"))?.includes("navbar__link--active"), "…and is marked active there");
  const foot = page.locator('.footer__links a[href="/live-darshan"]');
  check((await foot.count()) === 1 && (await text(foot)) === "Live Darshan", "the footer quick links carry Live Darshan", await text(foot));
  await page.goto(`${BASE}/about`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor();
  await page.locator('.footer__links a[href="/live-darshan"]').click();
  await page.locator(".live-stage").waitFor();
  check(new URL(page.url()).pathname === "/live-darshan", "the footer link reaches the page");

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.locator('[role="tab"]', { hasText: /NRI/ }).first().click();
  const tile = page.locator('a[href="/live-darshan"]', { hasText: /Watch live darshan/ });
  await tile.first().waitFor({ state: "attached" });
  check((await tile.count()) === 1, "Home: the NRI tile's primary button goes to /live-darshan");
  const tileBox = page.locator(".home-tile", { has: tile }).first();
  const channel = tileBox.locator(`a[href="${CHANNEL_URL}"]`);
  check((await channel.count()) === 1 && (await channel.getAttribute("target")) === "_blank" && /noopener/.test((await channel.getAttribute("rel")) ?? "") && /YouTube channel/.test(await text(channel)), "Home: the tile keeps a secondary YouTube-channel link in a new tab", await text(channel));
  await tile.first().scrollIntoViewIfNeeded();
  await tile.first().click();
  await page.locator(".live-stage").waitFor();
  check(new URL(page.url()).pathname === "/live-darshan", "Home: the tile button reaches the page");
  check(page.errors().length === 0, "entry points: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();

  const phone = await newPage({ width: 390, height: 844 });
  await phone.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await phone.locator("h1").first().waitFor();
  await phone.click(".navbar__toggle");
  await phone.waitForTimeout(450);
  const drawerLink = phone.locator('#mobile-drawer a[href="/live-darshan"]');
  check((await drawerLink.count()) === 1 && (await drawerLink.isVisible()), "the mobile drawer carries Live Darshan");
  await drawerLink.click();
  await phone.locator(".live-stage").waitFor();
  check(new URL(phone.url()).pathname === "/live-darshan", "…which reaches the page");
  check((await phone.locator("#mobile-drawer").getAttribute("aria-hidden")) === "true", "…and the drawer closes");
  await phone.context().close();
}

/** The public-e2e header-fit measurement, with the new nav entry (SPEC Decision 3). */
async function headerFit() {
  const WIDTHS_HEADER = [
    2560, 1920, 1600, 1560, 1559, 1440, 1366, 1340, 1339, 1280, 1200, 1100, 1024, 1023, 960, 900,
    768, 700, 640, 620, 560, 480, 460, 430, 400, 390, 375, 370, 360, 320,
    // The bands the Live Darshan entry changed: the seva CTA in Tamil (1439/1440) and 1024–1059 without the entry.
    1439, 1400, 1399, 1060, 1059, 1040,
  ];
  // The nav clips its own overflow (overflow: hidden), so a label pushed past
  // the nav's edge never spills out of .navbar__inner: the links are measured
  // against the nav box and the right cluster as well (the review's check).
  // The Live Darshan entry is given up between 1024 and 1059 px (Decision 3).
  for (const lang of [null, "en"]) {
    const spills = [];
    const gaps = [];
    for (const w of WIDTHS_HEADER) {
      const page = await newPage({ width: w, height: 840, lang });
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.waitForTimeout(250);
      const worst = await page.evaluate(() => {
        const navEl = document.querySelector(".navbar__nav");
        const navShown = !!navEl && getComputedStyle(navEl).display !== "none";
        const links = navShown ? [...navEl.querySelectorAll("a")].filter((a) => getComputedStyle(a).display !== "none") : [];
        const nb = navShown ? navEl.getBoundingClientRect() : null;
        const first = links[0]?.getBoundingClientRect();
        const last = links.at(-1)?.getBoundingClientRect();
        const brand = document.querySelector(".navbar__brand")?.getBoundingClientRect();
        const controls = navEl?.nextElementSibling?.getBoundingClientRect();
        const clipped = navShown && first && last && brand && controls
          ? Math.max(0, Math.round(nb.left - first.left), Math.round(brand.right - first.left), Math.round(last.right - nb.right), Math.round(last.right - controls.left))
          : 0;
        const twoLines = links.length > 1 && Math.abs(first.top - last.top) > 8;
        const overflowOf = (sel) => {
          const inner = document.querySelector(sel);
          if (!inner) return { spill: 0, sel: `missing ${sel}` };
          const box = inner.getBoundingClientRect();
          let spill = 0;
          let worstSel = "";
          for (const el of inner.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right - box.right > spill) {
              spill = Math.round(r.right - box.right);
              worstSel = String(el.className).slice(0, 40);
            }
          }
          return { spill, sel: worstSel };
        };
        const nav = overflowOf(".navbar__inner");
        const strip = overflowOf(".pulse-strip__inner");
        const langBox = document.querySelector(".lang-toggle")?.getBoundingClientRect();
        const navBox = document.querySelector(".navbar__nav")?.getBoundingClientRect();
        const next = document.querySelector(".navbar__nav")?.nextElementSibling?.getBoundingClientRect();
        return {
          spill: Math.max(nav.spill, strip.spill),
          sel: nav.spill >= strip.spill ? nav.sel : `strip: ${strip.sel}`,
          langVisible: !!langBox && langBox.width > 0 && langBox.right <= document.documentElement.clientWidth + 1,
          gap: navBox && next && navBox.width > 0 ? Math.round(next.left - navBox.right) : null,
          navShown,
          clipped,
          twoLines,
          liveVisible: !!document.querySelector('.navbar__nav a[href="/live-darshan"]') && document.querySelector('.navbar__nav a[href="/live-darshan"]').getBoundingClientRect().width > 0,
        };
      });
      if (worst.spill > 1) spills.push(`${w}px: ${worst.sel} +${worst.spill}px`);
      if (worst.clipped > 1) spills.push(`${w}px: nav labels clipped by ${worst.clipped}px`);
      if (worst.twoLines) spills.push(`${w}px: nav wrapped onto two lines`);
      if (!worst.langVisible) spills.push(`${w}px: language toggle not reachable`);
      const wantLive = worst.navShown && w >= 1060;
      if (worst.navShown && worst.liveVisible !== wantLive) spills.push(`${w}px: Live Darshan entry ${worst.liveVisible ? "shown" : "hidden"}, expected ${wantLive ? "shown" : "hidden"}`);
      if (worst.gap !== null && worst.navShown) gaps.push(`${w}:${worst.gap}${worst.liveVisible ? "" : "(no entry)"}`);
      await page.context().close();
    }
    check(spills.length === 0, `header and status strip fit, no nav label clipped, language toggle reachable, at ${WIDTHS_HEADER.length} widths (${lang ?? "ta"}); the Live Darshan entry is shown from 1060 px and given up at 1024–1059`, spills.slice(0, 4).join(" | "));
    console.log(`  nav→controls gap (${lang ?? "ta"}): ${gaps.join(" ")}`);
  }
}

async function scheduledThenEmpty() {
  const r = setStatus(F.live.id, "COMPLETED");
  check(r.changed === true && r.to === "COMPLETED", "fixture: the live broadcast is ended");
  for (const w of [390, 1440]) {
    const page = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await openLive(page);
    check((await page.locator(".live-player__iframe").count()) === 0 && (await page.locator(".live-player__poster").count()) === 1, `SCHEDULED @${w}: a poster, no iframe`);
    check((await mainTitle(page)) === F.sched.title_en, `SCHEDULED @${w}: the next broadcast is the one shown`, await mainTitle(page));
    check((await page.locator(".live-next").count()) === 1 && (await page.locator(".live-stream__head").count()) === 0, `SCHEDULED @${w}: the next-darshan card stands in for the plain head (Phase 2)`);
    const state = await text(page.locator(".live-player__state-text"));
    check(state === `Starts ${longDate(tomorrowIst)} at 6:00 pm IST`, `SCHEDULED @${w}: "Starts <date> at <time> IST" as the wall clock in IST`, state);
    check(/The broadcast will appear here when it begins/.test(await text(page.locator(".live-player__state-sub"))), `SCHEDULED @${w}: the waiting note`);
    check(/Scheduled/.test(await text(page.locator(".live-hero__status"))) && new RegExp(`${longDate(tomorrowIst)} · 6:00 pm IST`).test(await text(page.locator(".live-hero__status"))), `SCHEDULED @${w}: the hero shows Scheduled with the date and time`, await text(page.locator(".live-hero__status")));
    const f = await facts(page);
    check(f.Time === "6:00 pm – 7:00 pm IST" && f.Date === longDate(tomorrowIst), `SCHEDULED @${w}: details show the date and the 6:00–7:00 pm IST window`, `${f.Date} / ${f.Time}`);
    check(!(await overflow(page)), `SCHEDULED @${w}: no horizontal overflow`);
    if (w === 1440 || w === 390) {
      const v = await axe(page);
      check(v.length === 0, `SCHEDULED @${w}: axe serious/critical violations`, v.join("\n      "));
    }
    await shot(page, `scheduled-${w}`);
    check(page.errors().length === 0, `SCHEDULED @${w}: no console errors`, page.errors().slice(0, 2).join(" | "));
    await page.context().close();
  }

  // Tamil wording of the same poster: "<date> அன்று <time> தொடங்கும்" — the time token already
  // ends in am/pm and the zone, so no "மணிக்கு" follows it.
  const ta = await newPage({ lang: null });
  await openLive(ta);
  const taState = await text(ta.locator(".live-player__state-text"));
  const taTime = new Intl.DateTimeFormat("ta-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(`${tomorrowIst}T18:00:00+05:30`)).replace(/\s+/g, " ");
  check(taState === `${longDate(tomorrowIst, "ta")} அன்று ${taTime} IST தொடங்கும்`, "SCHEDULED: the Tamil poster sentence", `${taState} (expected …அன்று ${taTime} IST தொடங்கும்)`);
  check(!/மணிக்கு/.test(taState), "SCHEDULED: no மணிக்கு after the am/pm + zone token");
  check(/திட்டமிடப்பட்டது/.test(await text(ta.locator(".live-hero__status"))), "SCHEDULED: the Tamil badge");
  await ta.context().close();

  // A SCHEDULED broadcast whose start has passed (the committee is late pressing Go live) is still
  // shown — first, since it starts soonest — with a poster that says it is starting shortly.
  const lateStart = new Date(Date.now() + 5.5 * 3600 * 1000 - 20 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
  F.late = mkStream({ label: "Running late", status: "SCHEDULED", scheduled_start_local: lateStart });
  const index = await fetch(`${PHP_BASE}/api/live-streams`).then((r) => r.json());
  check(index.upcoming[0]?.slug === F.late.slug, "fixture: a SCHEDULED broadcast 20 min past its start (no end) leads the API's upcoming list", JSON.stringify(index.upcoming.map((s) => s.slug)));
  for (const [lang, want] of [["en", "Starting shortly"], [null, "விரைவில் தொடங்கும்"]]) {
    const late = await newPage({ lang });
    await openLive(late);
    check((await mainTitle(late)) === (lang === "en" ? F.late.title_en : F.late.title_ta) && (await late.locator(".live-player__iframe").count()) === 0 && (await late.locator(".live-player__poster").count()) === 1, `LATE (${lang ?? "ta"}): the list route shows it as a poster, no iframe`, await mainTitle(late));
    check((await late.locator(".live-countdown--started").count()) === 1 && (await text(late.locator(".live-countdown--started"))) === want, `LATE (${lang ?? "ta"}): the countdown reads "${want}" too`, await text(late.locator(".live-countdown--started")));
    check((await text(late.locator(".live-player__state-text"))) === want, `LATE (${lang ?? "ta"}): the poster says "${want}"`, await text(late.locator(".live-player__state-text")));
    check(new RegExp(lang === "en" ? "Scheduled" : "திட்டமிடப்பட்டது").test(await text(late.locator(".live-hero__status"))), `LATE (${lang ?? "ta"}): the badge still reads Scheduled`);
    check(late.errors().length === 0, `LATE (${lang ?? "ta"}): no console errors`, late.errors().slice(0, 2).join(" | "));
    if (lang === "en") await shot(late, "late-1440");
    await late.context().close();
  }
  setStatus(F.late.id, "CANCELLED"); // SCHEDULED → CANCELLED (a scheduled broadcast cannot be "ended")

  const r2 = setStatus(F.sched.id, "CANCELLED");
  check(r2.changed === true, "fixture: the scheduled broadcast is cancelled");
  const api = await fetch(`${PHP_BASE}/api/live-streams`).then((x) => x.json()).catch(() => null);
  if (api && (api.live.length || api.upcoming.length)) {
    console.log(`  (other broadcasts exist in this database — ${api.live.length} live, ${api.upcoming.length} upcoming — the empty state cannot be shown here)`);
    return;
  }
  for (const w of [390, 1440]) {
    const page = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await openLive(page);
    const empty = page.locator(".live-empty");
    check((await empty.count()) === 1 && /No live darshan is scheduled right now/.test(await text(empty)), `EMPTY @${w}: the empty state`, await text(empty));
    const yt = empty.locator(`a[href="${CHANNEL_URL}"]`);
    check((await yt.count()) === 1 && (await yt.getAttribute("target")) === "_blank" && /noopener/.test((await yt.getAttribute("rel")) ?? "") && /YouTube channel/.test(await text(yt)), `EMPTY @${w}: the YouTube channel button opens in a new tab`);
    check((await empty.locator('a[href="/events"]').count()) === 1, `EMPTY @${w}: the events button`);
    check((await page.locator(".live-player, .live-hero__status").count()) === 0 && (await page.locator("h1").count()) === 1, `EMPTY @${w}: no player, no hero status, one h1`);
    check(!(await overflow(page)), `EMPTY @${w}: no horizontal overflow`);
    const v = await axe(page);
    check(v.length === 0, `EMPTY @${w}: axe serious/critical violations`, v.join("\n      "));
    await shot(page, `empty-${w}`);
    check(page.errors().length === 0, `EMPTY @${w}: no console errors`, page.errors().slice(0, 2).join(" | "));
    await page.context().close();
  }
  const cancelled = await newPage();
  await openLive(cancelled, `/live-darshan/${F.sched.slug}`);
  check((await text(cancelled.locator(".live-player__state-text"))) === "This darshan was cancelled." && (await cancelled.locator(".live-player__iframe").count()) === 0, "CANCELLED: the slug page says so with no iframe");
  await cancelled.context().close();
}

async function liveRegionAndPolling() {
  // A STARTING broadcast becomes LIVE while the page is open: the poll picks it
  // up and the live region announces it once. The poll is 30 s; the clock is
  // not faked here, so the fixture flips first and the page's next poll is awaited.
  F.soon = mkStream({ label: "Starting soon", status: "STARTING", provider_reference: YT2, scheduled_start_local: `${dayAfterIst} 05:30`, deity_slug: "renukadevi" });
  const page = await newPage();
  const hits = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/api/live-streams")) hits.push({ t: Date.now(), p: u.pathname }); });
  await openLive(page, `/live-darshan/${F.soon.slug}`);
  check(/Starting soon/.test(await text(page.locator(".live-hero__status"))) && (await page.locator(".live-player__iframe").count()) === 1, "STARTING: the player is mounted with the Starting soon badge");
  check((await text(page.locator('.live-page [role="status"][aria-live="polite"]'))) === "", "the live region is empty on load");
  setStatus(F.soon.id, "LIVE");
  const announced = await page
    .locator('.live-page [role="status"][aria-live="polite"]', { hasText: /Live darshan has started/ })
    .waitFor({ state: "attached", timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  check(announced, "after the next poll the live region announces that live darshan has started");
  check(/Live now/.test(await text(page.locator(".live-hero__status"))), "…and the badge now reads Live now", await text(page.locator(".live-hero__status")));
  check(page.errors().length === 0, "polling: no console errors", page.errors().slice(0, 2).join(" | "));
  // Leaving the page stops every poller — including the one React's development
  // double-mount would have orphaned before the fix in lib/live.js (the review's check).
  await page.locator('.navbar__nav a[href="/events"]').click();
  await page.locator("h1", { hasText: /Events|நிகழ்வுகள்/ }).first().waitFor();
  await page.waitForTimeout(1500);
  const left = Date.now();
  await page.waitForTimeout(POLL_WAIT_MS);
  const after = hits.filter((h) => h.t > left);
  check(after.length === 0, `after leaving the page no /api/live-streams request is made in ${POLL_WAIT_MS / 1000} s (no orphaned poller)`, after.map((h) => h.p).join(","));
  await page.context().close();
  setStatus(F.soon.id, "COMPLETED");
}
const POLL_WAIT_MS = 35000;

/* ── Phase 4: the premium player page ──────────────────────────────────── */
const setViewers = (id, count, okAt) => sql("UPDATE live_streams SET viewer_count = ?, last_sync_ok_at = ? WHERE id = ?", [count, okAt, id]);
const utcNow = (deltaSeconds = 0) => new Date(Date.now() + deltaSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
/** Every action in the row under the player: text, href, height and whether it sits inside the viewport. */
const actionRow = (page) =>
  page.evaluate(() => {
    const row = document.querySelector(".live-actions");
    if (!row) return null;
    const vw = document.documentElement.clientWidth;
    return [...row.querySelectorAll("a.btn, button")].map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent.replace(/\s+/g, " ").trim(), href: el.getAttribute("href"), h: Math.round(r.height), fits: r.left >= 0 && r.right <= vw + 1 };
    });
  });

async function premiumPage() {
  // A live figure YouTube reported a moment ago is shown; once it is gone the pill goes with it (never "0").
  setViewers(F.live.id, 42, utcNow());
  const api = await fetch(`${PHP_BASE}/api/live-streams/${F.live.slug}`).then((r) => r.json());
  check(api?.stream?.viewers === 42 && !("viewer_count" in (api?.stream ?? {})) && !("last_sync_ok_at" in (api?.stream ?? {})), "the API hands out viewers = 42 and keeps the private columns to itself", JSON.stringify(api?.stream ?? api).slice(0, 300));
  for (const w of [1440, 390]) {
    const page = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await openLive(page);
    const head = page.locator(".live-stream__head");
    check((await head.locator(".badge").count()) === 1 && /Live now/.test(await text(head)), `@${w}: the header strip carries the Live now badge`, await text(head));
    check((await text(head.locator("h2"))) === F.live.title_en, `@${w}: …and the title as the page's h2`);
    check(/Sri Lingammal/.test(await text(head.locator(".live-header__meta"))) && /Live darshan/.test(await text(head.locator(".live-header__meta"))), `@${w}: …the deity and the programme as metadata`, await text(head.locator(".live-header__meta")));
    const pill = head.locator(".live-header__viewers");
    check((await pill.count()) === 1 && (await pill.getAttribute("data-viewers")) === "42" && /42 watching now/.test(await text(pill)), `@${w}: the viewer pill reads 42 watching now`, await text(pill));
    check((await pill.evaluate((el) => el.closest('[aria-live], [role="status"]'))) === null, `@${w}: the pill is not inside a live region`);
    const row = await actionRow(page);
    check(Array.isArray(row) && row.length === 2 && row.some((b) => /^Donate$/.test(b.text) && b.href === `/donate?stream=${F.live.slug}`) && row.some((b) => /^Share$/.test(b.text)) && !row.some((b) => /Notify/.test(b.text)), `@${w}: LIVE offers Donate (to /donate?stream=<slug>) and Share, not Notify me`, JSON.stringify(row));
    check(Array.isArray(row) && row.every((b) => b.h >= 44 && b.fits), `@${w}: every action is 44 px tall and inside the viewport`, JSON.stringify(row));
    const about = page.locator(".live-about");
    check((await text(about.locator("h3"))) === "About this pooja" && /Test live darshan created by the test suite/.test(await text(about)), `@${w}: About this pooja carries the description`, await text(about));
    if (w === 390) {
      const order = await page.evaluate(() => {
        const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
        return { player: y(".live-player"), head: y(".live-stream__head"), actions: y(".live-actions"), about: y(".live-about"), meta: y(".live-meta-card") };
      });
      check(order.player < order.head && order.head < order.actions && order.actions < order.about && order.about < order.meta, "@390: player, header, actions, About, then the details — one column", JSON.stringify(order));
    }
    check(!(await overflow(page)), `@${w}: no horizontal overflow`);
    const v = await axe(page);
    check(v.length === 0, `@${w}: axe serious/critical violations (iframes off)`, v.join("\n      "));
    await shot(page, `phase4-live-${w}`);
    check(page.errors().length === 0, `@${w}: no console errors`, page.errors().slice(0, 2).join(" | "));
    await page.context().close();
  }
  // Tamil: the heading, the pill's sentence and the Tamil description.
  const ta = await newPage({ lang: null });
  await openLive(ta);
  check((await text(ta.locator(".live-about h3"))) === "இந்த பூஜை பற்றி" && /சோதனை நேரடி தரிசனம்/.test(await text(ta.locator(".live-about"))), "Tamil: இந்த பூஜை பற்றி with the Tamil description", await text(ta.locator(".live-about")));
  check(/42 பேர் பார்க்கிறார்கள்/.test(await text(ta.locator(".live-header__viewers"))), "Tamil: the pill's sentence", await text(ta.locator(".live-header__viewers")));
  check(/நன்கொடை/.test(await text(ta.locator(".live-actions"))) && /பங்கிடு/.test(await text(ta.locator(".live-actions"))), "Tamil: Donate and Share labels", await text(ta.locator(".live-actions")));
  await ta.context().close();

  // The figure goes stale (six minutes old), then is gone: no pill, no zero.
  setViewers(F.live.id, 42, utcNow(-360));
  const stale = await newPage();
  await openLive(stale);
  check((await stale.locator(".live-header__viewers").count()) === 0 && (await stale.locator(".live-stream__head .badge").count()) === 1, "a six-minute-old figure shows no pill (the badge stays)");
  setViewers(F.live.id, null, null);
  await openLive(stale);
  check((await stale.locator(".live-header__viewers").count()) === 0 && !/\b0 watching/.test(await text(stale.locator(".live-stream__head"))), "no figure at all: no pill and never a 0");
  await stale.context().close();

  // Every flag off: the row is not rendered at all.
  F.bare = mkStream({ label: "Bare one", status: "LIVE", provider_reference: YT2, donations_enabled: 0, notifications_enabled: 0, sharing_enabled: 0, archive_enabled: 0, scheduled_start_local: `${dayAfterIst} 10:00` });
  const bare = await newPage();
  await openLive(bare, `/live-darshan/${F.bare.slug}`);
  check((await bare.locator(".live-actions").count()) === 0 && (await bare.locator(".live-player__iframe").count()) === 1, "with every flag off the action row is omitted (the player stays)");
  await bare.context().close();
  setStatus(F.bare.id, "COMPLETED");

  // SCHEDULED: Notify me opens the Phase 4 note — a dialog with a focus trap, Escape to close, focus back on the button.
  const sched = await newPage({ width: 390, height: 844 });
  await openLive(sched, `/live-darshan/${F.sched.slug}`);
  const row = await actionRow(sched);
  check(Array.isArray(row) && row.some((b) => /^Notify me$/.test(b.text)) && row.some((b) => /^Donate$/.test(b.text)) && row.some((b) => /^Share$/.test(b.text)), "SCHEDULED @390: Donate, Notify me and Share", JSON.stringify(row));
  check(Array.isArray(row) && row.every((b) => b.h >= 44 && b.fits), "SCHEDULED @390: every action 44 px and inside the viewport", JSON.stringify(row));
  await shot(sched, "phase4-scheduled-390");
  const notify = sched.locator(".live-actions button", { hasText: "Notify me" });
  await notify.click();
  const dialog = sched.locator('[role="dialog"]');
  await dialog.waitFor();
  check((await dialog.count()) === 1 && /Reminders are coming soon/.test(await text(dialog)) && /the schedule has every upcoming time/.test(await text(dialog)), "Notify me opens the reminders-are-coming note", await text(dialog));
  check((await dialog.locator('a[href="/live-darshan/schedule"]').count()) === 1 && (await dialog.locator("input, textarea").count()) === 0, "…with the schedule as the way out and no email field (Phase 6 owns reminders)");
  await sched.waitForTimeout(200);
  check((await dialog.getAttribute("aria-modal")) === "true" && (await sched.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)), "…focus moved into the dialog");
  for (let i = 0; i < 8; i += 1) await sched.keyboard.press("Tab");
  check(await sched.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), "…Tab stays inside it (focus trap)");
  const dv = await axe(sched);
  check(dv.length === 0, "…axe serious/critical violations with the dialog open @390", dv.join("\n      "));
  await shot(sched, "phase4-notify-390");
  await sched.keyboard.press("Escape");
  await sched.locator('[role="dialog"]').waitFor({ state: "detached" });
  check((await sched.locator('[role="dialog"]').count()) === 0, "Escape closes it");
  await sched.waitForTimeout(200);
  check(await sched.evaluate(() => /Notify me/.test(document.activeElement?.textContent ?? "")), "…and focus returns to Notify me");
  check(sched.errors().length === 0, "scheduled: no console errors", sched.errors().slice(0, 2).join(" | "));
  await sched.context().close();

  // COMPLETED with archive: the poster until "Watch the recording" is pressed, then the same 16:9 iframe.
  const done = await newPage();
  await openLive(done, `/live-darshan/${F.done.slug}`);
  const watch = done.locator(".live-player__state button", { hasText: "Watch the recording" });
  check((await watch.count()) === 1 && (await done.locator(".live-player__iframe").count()) === 0 && (await text(done.locator(".live-player__state-text"))) === "This darshan has ended.", "COMPLETED (archived): the ended poster offers Watch the recording, no iframe yet");
  const before = await done.locator(".live-player__frame").boundingBox();
  await watch.click();
  await done.locator(".live-player__iframe").waitFor();
  const a = await iframeAttrs(done);
  check(a && /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}\?/.test(a.src) && /^Recording – /.test(a.title) && a.allowfullscreen, "…pressing it mounts the recording iframe (youtube-nocookie, titled Recording – …)", JSON.stringify(a));
  check(a && Math.abs(a.frameH - (a.frameW * 9) / 16) <= 2 && before && Math.abs(before.height - a.frameH) <= 2, "…in the same 16:9 box, no layout shift", JSON.stringify({ before: before?.height, after: a?.frameH }));
  check((await done.locator(".live-actions").count()) === 1 && !/Notify/.test(await text(done.locator(".live-actions"))), "COMPLETED: Donate/Share remain, Notify me does not", await text(done.locator(".live-actions")));
  check(done.errors().length === 0, "completed: no console errors", done.errors().slice(0, 2).join(" | "));
  // Without the archive flag the poster stays as it was.
  F.doneNoArchive = mkStream({ label: "Finished unarchived", status: "COMPLETED", archive_enabled: 0, scheduled_start_local: `${dayAfterIst} 11:00`, scheduled_end_local: `${dayAfterIst} 12:00` });
  await openLive(done, `/live-darshan/${F.doneNoArchive.slug}`);
  check((await done.locator(".live-player__state button").count()) === 0 && (await done.locator(".live-player__iframe").count()) === 0 && (await text(done.locator(".live-player__state-text"))) === "This darshan has ended.", "COMPLETED without archive: the ended poster, no button, no iframe");
  await done.context().close();

  // OFFLINE: Try again asks the API for the broadcast once more.
  const off = await newPage();
  const hits = [];
  off.on("request", (r) => { if (r.url().includes(`/api/live-streams/${F.off.slug}`)) hits.push(Date.now()); });
  await openLive(off, `/live-darshan/${F.off.slug}`);
  const again = off.locator(".live-player__state button", { hasText: "Try again" });
  const seen = hits.length;
  check((await again.count()) === 1 && ((await again.boundingBox())?.height ?? 0) >= 44, "OFFLINE: the poster offers Try again (44 px)");
  await again.click();
  await off.waitForTimeout(1500);
  check(hits.length > seen, "…pressing it fetches the broadcast again", `${seen} → ${hits.length}`);
  check((await off.locator(".live-player__poster").count()) === 1 && (await off.locator(".live-player__iframe").count()) === 0, "…and, still offline, the poster stays");
  await off.context().close();

  // The upcoming grid stops at six; the schedule page has the rest.
  F.many = [];
  for (let i = 0; i < 7; i += 1) F.many.push(mkStream({ label: `Upcoming ${i + 1}`, status: "SCHEDULED", scheduled_start_local: `${istDate(3 + i)} 06:00`, scheduled_end_local: `${istDate(3 + i)} 07:00` }));
  const grid = await newPage();
  await openLive(grid);
  const cards = await grid.locator(".live-upcoming .live-card").count();
  check(cards === 6, "the upcoming grid shows six at most", `${cards} cards`);
  check((await grid.locator('.live-upcoming a[href="/live-darshan/schedule"]').count()) === 1, "…with Full schedule as the way to the rest");
  await grid.context().close();
  for (const s of F.many) setStatus(s.id, "CANCELLED");
}

/* ── Phase 2: the schedule page ─────────────────────────────────────────── */
async function schedulePage() {
  // Rows across the windows, while F.live is still on air. They are cancelled
  // again at the end so the later scenarios' "next" broadcast stays F.sched.
  const S = {};
  S.todayLate = mkStream({ label: "Evening Deeparadhana today", status: "SCHEDULED", event_type: "deeparadhana", deity_slug: "lingammal", scheduled_start_local: `${istDate(0)} 23:59` });
  S.tomorrowEarly = mkStream({ label: "Kalasanthi tomorrow", status: "SCHEDULED", event_type: "daily_pooja", scheduled_start_local: `${tomorrowIst} 06:30` });
  S.festival = mkStream({ label: "Festival procession", status: "SCHEDULED", event_type: "festival", deity_slug: "renukadevi", scheduled_start_local: `${tomorrowIst} 10:00` });
  S.nextWeek = mkStream({ label: "Next week bhajan", status: "SCHEDULED", event_type: "bhajan", scheduled_start_local: `${istDate(8)} 18:00` });
  try {
    await schedulePageChecks(S);
  } finally {
    // Whatever happened above, these rows must not be the next broadcast the later scenarios see.
    for (const f of [S.todayLate, S.tomorrowEarly, S.nextWeek, S.festival]) {
      try { setStatus(f.id, "CANCELLED"); } catch { /* already cancelled */ }
    }
  }
}

/** Cancel (or end) a fixture whatever state a failed check left it in. */
function retire(row) {
  if (!row?.id) return;
  for (const to of ["COMPLETED", "CANCELLED"]) {
    try { setStatus(row.id, to); return; } catch { /* not allowed from this status; try the next */ }
  }
}

async function schedulePageChecks(S) {
  const api = await fetch(`${PHP_BASE}/api/live-streams/schedule?filter=all&limit=100`).then((r) => r.json());
  check(Array.isArray(api.streams) && api.counts && api.streams.some((s) => s.slug === S.todayLate.slug), "fixture: the API's schedule lists the new rows", JSON.stringify(api.counts));

  for (const w of [390, 768, 1024, 1440]) {
    const page = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await openSchedule(page);
    const h1s = await page.locator("h1").count();
    check(h1s === 1 && (await text(page.locator("h1"))) === "Live Darshan schedule", `/live-darshan/schedule @${w}: exactly one h1, the page title`, `${h1s} × ${await text(page.locator("h1"))}`);
    check(!(await overflow(page)), `/live-darshan/schedule @${w}: no horizontal overflow`);
    check((await page.locator(".live-schedule__day").count()) >= 2 && (await page.locator(".live-card").count()) >= 4, `/live-darshan/schedule @${w}: day groups and cards are on the page`);
    if (w === 1440 || w === 390) {
      const v = await axe(page);
      check(v.length === 0, `/live-darshan/schedule @${w}: axe serious/critical violations (iframes off)`, v.join("\n      "));
      await shot(page, `schedule-${w}`);
    }
    check(page.errors().length === 0, `/live-darshan/schedule @${w}: no console errors`, page.errors().slice(0, 3).join(" | "));
    await page.context().close();
  }

  // The filter strip on a phone (review fix F1): five chips, in both
  // languages, every one of them inside the viewport and inside its own strip
  // — the selected chip included, which used to sit past the right edge with
  // no scrollbar, fade or wrap to hint at it.
  for (const lang of ["en", null]) {
    for (const query of ["", "?filter=festivals"]) {
      const strip = await newPage({ width: 390, height: 844, lang });
      await openSchedule(strip, query);
      const chips = await filterChips(strip);
      const outside = (chips ?? []).filter((c) => c.left < -1 || c.right > 390 + 1);
      const short = (chips ?? []).filter((c) => c.height < 44);
      const selected = (chips ?? []).find((c) => c.selected);
      const where = `${lang ?? "ta"}${query || " (All)"}`;
      check((chips ?? []).length === 5 && outside.length === 0, `filter strip @390 (${where}): every chip is inside the viewport`, JSON.stringify(chips));
      check(short.length === 0, `filter strip @390 (${where}): every chip is at least 44 px tall`, JSON.stringify(short));
      check(Boolean(selected) && selected.inStrip, `filter strip @390 (${where}): the selected chip is in view`, JSON.stringify(selected));
      check(!(await overflow(strip)), `filter strip @390 (${where}): no horizontal overflow`);
      if (query === "") await shot(strip, `schedule-filters-390-${lang ?? "ta"}`);
      await strip.context().close();
    }
  }

  const page = await newPage();
  await openSchedule(page);
  check(new URL(page.url()).searchParams.get("filter") === null, "a plain load has no ?filter (All)");
  const tabs = page.locator('.live-filters [role="tab"]');
  check((await tabs.count()) === 5 && (await tabs.allTextContents()).map((s) => s.replace(/\d+/g, "").trim()).join("|") === "Today|Tomorrow|This week|Festivals|All", "the five filters, in order", (await tabs.allTextContents()).join("|"));
  check((await tabs.nth(4).getAttribute("aria-selected")) === "true", "All is selected by default");
  const tabCounts = await page.locator(".live-filters .tab__count").allTextContents();
  check(tabCounts.join(",") === [api.counts.today, api.counts.tomorrow, api.counts.week, api.counts.festivals, api.counts.all].join(","), "each tab shows the API's count", `${tabCounts.join(",")} vs ${JSON.stringify(api.counts)}`);
  const headings = await page.locator(".live-schedule__day-title").allTextContents();
  check(/^Live now/.test(headings[0] ?? "") && (await page.locator(".live-schedule__day-title--live").count()) === 1, "the first day group is Live now, marked as live", headings.join(" | "));
  check(headings.some((h) => /^Today ·/.test(h)) && headings.some((h) => /^Tomorrow ·/.test(h)), "there are Today · and Tomorrow · headings", headings.join(" | "));
  check(headings.some((h) => /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} \w+ \d{4}/.test(h)), "a later day is headed by its weekday and date", headings.join(" | "));
  check(/\d+ programmes?/.test(headings[0] ?? ""), "a heading carries its programme count", headings[0]);
  for (const f of [F.live, S.todayLate, S.tomorrowEarly, S.festival, S.nextWeek]) {
    check((await page.locator(`.live-card[href="/live-darshan/${f.slug}"]`).count()) === 1, `the card for ${f.title_en.replace(PREFIX, "").trim()} links to its page`);
  }
  const liveCard = page.locator(`.live-card[href="/live-darshan/${F.live.slug}"]`);
  check(/Live now/.test(await text(liveCard)) && (await liveCard.locator(".badge--live").count()) === 1, "the live card carries the Live now badge", await text(liveCard));
  const todayCard = page.locator(`.live-card[href="/live-darshan/${S.todayLate.slug}"]`);
  check(/Today · 11:59 pm IST/.test(await text(todayCard)) && /Deeparadhana/.test(await text(todayCard)) && /Sri Lingammal/.test(await text(todayCard)), "a card shows title, temple, deity, programme, day and time", await text(todayCard));
  const soonPill = todayCard.locator(".live-countdown--compact");
  check((await soonPill.count()) === 1 && /in (\d+ h ?)?(\d+ min)?|in under a minute|Starting shortly/.test(await text(soonPill)), "a broadcast within the next day counts down in minutes on its card", await text(soonPill));
  const nextWeekCard = page.locator(`.live-card[href="/live-darshan/${S.nextWeek.slug}"]`);
  check((await nextWeekCard.locator(".live-countdown--compact").count()) === 0 && /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} \w+ · 6:00 pm IST/.test(await text(nextWeekCard)), "a broadcast next week has no countdown and shows its weekday and date", await text(nextWeekCard));
  check((await page.locator(".live-schedule__window").count()) === 1 && /IST/.test(await text(page.locator(".live-schedule__window"))), "the window's dates are shown with the zone", await text(page.locator(".live-schedule__window")));

  await tabs.nth(1).click();
  await page.waitForTimeout(600);
  check(new URL(page.url()).searchParams.get("filter") === "tomorrow", "clicking Tomorrow puts ?filter=tomorrow in the address", page.url());
  check((await tabs.nth(1).getAttribute("aria-selected")) === "true", "…and selects the tab");
  await page.locator(`.live-card[href="/live-darshan/${S.tomorrowEarly.slug}"]`).waitFor();
  check((await page.locator(`.live-card[href="/live-darshan/${S.festival.slug}"]`).count()) === 1 && (await page.locator(`.live-card[href="/live-darshan/${S.todayLate.slug}"]`).count()) === 0 && (await page.locator(`.live-card[href="/live-darshan/${F.live.slug}"]`).count()) === 0, "…the list shows tomorrow's rows and not today's or the live one");
  check((await page.locator(".live-card").count()) === api.counts.tomorrow, "…as many cards as the tab's count", `${await page.locator(".live-card").count()} vs ${api.counts.tomorrow}`);
  const region = page.locator('.live-schedule [role="status"][aria-live="polite"]');
  check(new RegExp(`Showing ${api.counts.tomorrow} programmes?`).test(await text(region)), "the live region announces the count", await text(region));
  await tabs.nth(3).click();
  await page.locator(`.live-card[href="/live-darshan/${S.festival.slug}"]`).waitFor();
  const festHrefs = await page.locator(".live-card").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  check(new URL(page.url()).searchParams.get("filter") === "festivals" && festHrefs.includes(`/live-darshan/${S.festival.slug}`) && !festHrefs.includes(`/live-darshan/${S.todayLate.slug}`), "Festivals lists the festival and not the deeparadhana", festHrefs.join(","));
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  check(new URL(page.url()).searchParams.get("filter") === "all" && (await tabs.nth(4).getAttribute("aria-selected")) === "true", "the arrow keys move between filters and update the address", page.url());
  check(page.errors().length === 0, "schedule: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();

  const direct = await newPage();
  await openSchedule(direct, "?filter=week");
  check((await direct.locator('.live-filters [role="tab"]').nth(2).getAttribute("aria-selected")) === "true" && (await direct.locator(`.live-card[href="/live-darshan/${S.nextWeek.slug}"]`).count()) === 0 && (await direct.locator(`.live-card[href="/live-darshan/${S.todayLate.slug}"]`).count()) === 1, "a direct load with ?filter=week selects This week and lists this week only");
  // The share link carries the filter that is on screen (review fix O13).
  await openSchedule(direct, "?filter=week");
  await direct.locator(".page-hero .share-btn").click();
  const sharedWeek = await direct.locator(".share-link__url").inputValue().catch(() => "");
  check(sharedWeek === `${BASE}/live-darshan/schedule?filter=week`, "the share sheet hands out the schedule with ?filter=week", sharedWeek);
  await direct.keyboard.press("Escape");
  await openSchedule(direct, "?filter=bogus");
  check((await direct.locator('.live-filters [role="tab"]').nth(4).getAttribute("aria-selected")) === "true", "?filter=bogus falls back to All");
  await direct.locator(".page-hero .share-btn").click();
  const sharedAll = await direct.locator(".share-link__url").inputValue().catch(() => "");
  check(sharedAll === `${BASE}/live-darshan/schedule`, "…and the plain page (All) is shared without a filter", sharedAll);
  await direct.keyboard.press("Escape");
  await direct.context().close();

  // Switching a filter keeps the list that is on screen while the new answer
  // is on its way — dimmed and aria-busy, never skeletons (review fix F6).
  const slow = await newPage({ slowApi: "**/api/live-streams/schedule**", slowMs: 900 });
  await openSchedule(slow);
  const shown = (p) => p.evaluate(() => ({
    days: document.querySelectorAll(".live-schedule__day").length,
    cards: document.querySelectorAll(".live-card").length,
    skeletons: document.querySelectorAll(".live-schedule__skeleton").length,
    busy: document.querySelectorAll('.live-schedule__list[aria-busy="true"]').length,
    filter: new URL(location.href).searchParams.get("filter"),
  }));
  const before = await shown(slow);
  check(before.days >= 2 && before.skeletons === 0 && before.busy === 0, "slow API: the first answer is shown, no skeletons left", JSON.stringify(before));
  await slow.locator('.live-filters [role="tab"]').nth(1).click();
  await slow.waitForTimeout(300);
  const during = await shown(slow);
  check(during.filter === "tomorrow" && during.skeletons === 0 && during.days >= 2 && during.cards >= before.cards, "…switching to Tomorrow keeps the previous list on screen (no skeletons, nothing blanks)", JSON.stringify(during));
  check(during.busy === 1, "…and marks it aria-busy while the answer is awaited", JSON.stringify(during));
  await slow.waitForFunction(() => document.querySelectorAll('.live-schedule__list[aria-busy="true"]').length === 0, null, { timeout: 15000 });
  await slow.locator(`.live-card[href="/live-darshan/${S.tomorrowEarly.slug}"]`).waitFor({ timeout: 15000 });
  const after = await shown(slow);
  check(after.busy === 0 && after.skeletons === 0 && after.cards === api.counts.tomorrow, "…and when it lands the new list replaces it, busy cleared", JSON.stringify(after));
  check(slow.errors().length === 0, "slow API: no console errors", slow.errors().slice(0, 2).join(" | "));
  await slow.context().close();

  // The empty state: a cancelled broadcast leaves the schedule (only ended ones stay), so once the
  // festival is cancelled the Festivals filter has nothing, and the empty state's button switches to All.
  setStatus(S.festival.id, "CANCELLED");
  const festivalsLeft = await fetch(`${PHP_BASE}/api/live-streams/schedule?filter=festivals`).then((r) => r.json());
  check(festivalsLeft.streams.length === 0 && festivalsLeft.counts.festivals === 0, "fixture: with the festival cancelled the Festivals filter is empty and counts 0", JSON.stringify(festivalsLeft.streams.map((s) => s.slug)));
  const empty = await newPage();
  await openSchedule(empty, "?filter=festivals");
  const box = empty.locator(".live-schedule__empty");
  check((await box.count()) === 1 && /No festival broadcast is scheduled/.test(await text(box)), "Festivals with nothing: the empty state", await text(box));
  const switchBtn = box.locator("button", { hasText: /See all/ });
  check((await switchBtn.count()) === 1 && (await switchBtn.evaluate((el) => el.getBoundingClientRect().height)) >= 44, "…with a See all button at least 44 px tall");
  await switchBtn.click();
  await empty.locator(".live-card").first().waitFor();
  check(new URL(empty.url()).searchParams.get("filter") === "all" && (await empty.locator(".live-card").count()) >= 4, "…which switches to All and lists the broadcasts", empty.url());
  await empty.context().close();


  const ta = await newPage({ lang: null });
  await openSchedule(ta);
  check((await htmlLang(ta)) === "ta" && (await text(ta.locator("h1"))) === "நேரடி தரிசன அட்டவணை", "Tamil: the h1", await text(ta.locator("h1")));
  const taTabs = (await ta.locator('.live-filters [role="tab"]').allTextContents()).map((s) => s.replace(/\d+/g, "").trim());
  check(taTabs.join("|") === "இன்று|நாளை|இந்த வாரம்|திருவிழாக்கள்|அனைத்தும்", "Tamil: the five filter labels", taTabs.join("|"));
  const taHeadings = await ta.locator(".live-schedule__day-title").allTextContents();
  check(/^இப்போது நேரலை/.test(taHeadings[0] ?? "") && taHeadings.some((h) => /^இன்று ·/.test(h)) && taHeadings.some((h) => /^நாளை ·/.test(h)), "Tamil: Live now, Today and Tomorrow headings", taHeadings.join(" | "));
  check(/நிகழ்ச்சி/.test(await text(ta.locator('.live-schedule [role="status"][aria-live="polite"]'))), "Tamil: the live region", await text(ta.locator('.live-schedule [role="status"][aria-live="polite"]')));
  // A later day reads "வியாழன், 24 செப்டம்பர்" — weekday, day, month, as the
  // day heading above it does, not ICU's "செப்டம்பர் 24, வியாழன்" (review fix F5).
  const wantTaDay = taDayLabel(istDate(8));
  const nextWeekWhen = await text(ta.locator(`.live-card[href="/live-darshan/${S.nextWeek.slug}"] .live-card__when`));
  check(nextWeekWhen.startsWith(wantTaDay), "Tamil: a later day reads weekday, day month (as the heading does)", `${nextWeekWhen} (expected to start with ${wantTaDay})`);
  const taFullDate = new Intl.DateTimeFormat("ta-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${istDate(8)}T12:00:00+05:30`));
  const taLaterHeading = (await ta.locator(".live-schedule__day-title").allTextContents()).find((h) => h.includes(taFullDate));
  check(Boolean(taLaterHeading) && taFullDate.startsWith(wantTaDay.split(",")[0]), "Tamil: its day heading is the same weekday-first date with the year", `${taLaterHeading ?? "no heading"} / ${taFullDate}`);
  await ta.context().close();
}

/* ── Phase 2: the countdown and the homepage's three states ─────────────── */
async function countdownAndHome() {
  const api = await fetch(`${PHP_BASE}/api/live-streams`).then((r) => r.json()).catch(() => null);
  if (!api || api.live.length || api.upcoming.length) {
    console.log(`  (other broadcasts exist in this database — ${api?.live.length} live, ${api?.upcoming.length} upcoming — the homepage states cannot be shown here)`);
    return;
  }
  const made = [];
  try {
    await countdownAndHomeChecks(made);
  } finally {
    for (const row of made) retire(row);
  }
}

/**
 * A filter with nothing on it offers a way out: Today and Tomorrow send the
 * visitor to "this week" — except on a Sunday, when the week is that one day
 * and cannot hold tomorrow, and both offer every upcoming broadcast instead
 * (review fix O11). What to expect is read from the window the API returns,
 * so this holds whatever day the suite is run on.
 */
async function emptySwitchCheck(filter) {
  const answer = await fetch(`${PHP_BASE}/api/live-streams/schedule?filter=${filter}`).then((r) => r.json());
  if (answer.streams.length) {
    console.log(`  (the database has ${answer.streams.length} broadcast(s) on the ${filter} filter — its empty state cannot be shown here)`);
    return;
  }
  const sunday = new Date(`${answer.window.today}T00:00:00Z`).getUTCDay() === 0;
  const want = sunday ? "all" : "week";
  const label = sunday ? /See all/ : /This week's schedule/;
  const page = await newPage();
  await openSchedule(page, `?filter=${filter}`);
  const box = page.locator(".live-schedule__empty");
  check((await box.count()) === 1, `${filter} with nothing: the empty state`, await text(box));
  const go = box.locator("button").first();
  check(label.test(await text(go)), `…its button offers the "${want}" way out (today is ${answer.window.today}, ${sunday ? "a Sunday" : "not a Sunday"})`, await text(go));
  check((await go.evaluate((el) => el.getBoundingClientRect().height)) >= 44, "…at least 44 px tall");
  await go.click();
  await page.waitForTimeout(700);
  check(new URL(page.url()).searchParams.get("filter") === want, `…and switches to ?filter=${want}`, page.url());
  check(page.errors().length === 0, `${filter} empty: no console errors`, page.errors().slice(0, 2).join(" | "));
  await page.context().close();
}

/**
 * The same rule with the weekday forced, so both sides of it are pinned on
 * whatever day the suite runs: the answer's window is rewritten to a Sunday
 * (the week is that one day → "See all") and to a Monday (→ "This week's
 * schedule"), with nothing listed either way (review fix O11).
 */
async function emptySwitchWeekdayCheck() {
  const SUNDAY = "2026-09-20";
  const MONDAY = "2026-09-21";
  for (const filter of ["today", "tomorrow"]) {
    for (const [ymd, want, label] of [[SUNDAY, "all", /See all/], [MONDAY, "week", /This week's schedule/]]) {
      const page = await newPage();
      await page.route("**/api/live-streams/schedule**", async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        body.streams = [];
        body.counts = { today: 0, tomorrow: 0, week: 0, festivals: 0, all: 0 };
        if (body.window) body.window = { ...body.window, today: ymd };
        await route.fulfill({ response: res, json: body });
      });
      await openSchedule(page, `?filter=${filter}`);
      const go = page.locator(".live-schedule__empty button").first();
      const who = `${filter} empty on ${ymd === SUNDAY ? "a Sunday" : "a Monday"}`;
      check(label.test(await text(go)), `${who}: the button offers the "${want}" way out`, await text(go));
      await go.click();
      await page.waitForTimeout(600);
      check(new URL(page.url()).searchParams.get("filter") === want, `${who}: …and switches to ?filter=${want}`, page.url());
      check(page.errors().length === 0, `${who}: no console errors`, page.errors().slice(0, 2).join(" | "));
      await page.context().close();
    }
  }
}

async function countdownAndHomeChecks(made) {
  const keep = (row) => { made.push(row); return row; };
  const noEmptySection = (page) => page.evaluate(() => [...document.querySelectorAll("main section")].every((s) => s.getBoundingClientRect().height > 40 || s.hidden));

  // 1. Nothing live or scheduled: no live section, no hero row, no empty band.
  const none = await newPage();
  await none.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await none.waitForTimeout(800);
  check((await none.locator(".home-live").count()) === 0 && (await none.locator(".home-hero__row--live").count()) === 0, "Home (nothing scheduled): no live section and no hero row");
  check(await noEmptySection(none), "Home (nothing scheduled): no empty section is left in the layout");
  check(none.errors().length === 0, "Home (nothing scheduled): no console errors", none.errors().slice(0, 2).join(" | "));
  await none.context().close();

  // With nothing scheduled, the Today and Tomorrow filters show their empty
  // state — and the way out it offers depends on the weekday (review fix O11).
  await emptySwitchCheck("today");
  await emptySwitchCheck("tomorrow");
  await emptySwitchWeekdayCheck();

  // 2. A broadcast in ten minutes: the homepage's upcoming state and the hero row.
  F.nextHome = keep(mkStream({ label: "Evening Deeparadhana", status: "SCHEDULED", event_type: "deeparadhana", deity_slug: "renukadevi", starts_in_seconds: 600 }));
  for (const w of [1440, 390]) {
    const home = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await home.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await home.locator(".home-live .live-next").waitFor({ timeout: 30000 });
    const card = home.locator(".home-live .live-next");
    check(/Next Live Darshan/.test(await text(card)) && (await text(card.locator(".live-next__title"))) === F.nextHome.title_en, `Home upcoming @${w}: the Next Live Darshan card with the title`, await text(card));
    check(/Today • \d{1,2}:\d{2} (am|pm) IST/.test(await text(card.locator(".live-next__when"))), `Home upcoming @${w}: "Today • <time> IST"`, await text(card.locator(".live-next__when")));
    check((await card.locator(".live-countdown__clock").count()) === 1 && /^00:(09|10):\d{2}$/.test(await clockOf(card)), `Home upcoming @${w}: the countdown reads about ten minutes`, await clockOf(card));
    const view = card.locator('a[href="/live-darshan/schedule"]', { hasText: /View schedule/ });
    check((await view.count()) === 1 && (await view.evaluate((el) => el.getBoundingClientRect().height)) >= 44, `Home upcoming @${w}: View schedule → /live-darshan/schedule, 44 px`);
    const headAction = home.locator('.home-live .section-head__actions a[href="/live-darshan/schedule"]');
    check((await headAction.count()) === 1, `Home upcoming @${w}: the section header's Schedule action`);
    // The section's own action is a full touch target too (review fix F3).
    const smallTargets = await home.evaluate(() =>
      [...document.querySelectorAll(".home-live a.btn, .home-live button")]
        .map((el) => ({ h: Math.round(el.getBoundingClientRect().height), t: el.textContent.trim().slice(0, 30) }))
        .filter((x) => x.h > 0 && x.h < 44),
    );
    check(smallTargets.length === 0, `Home upcoming @${w}: every target in the live section is at least 44 px tall`, JSON.stringify(smallTargets));
    const row = home.locator(".home-hero__row--live");
    check((await row.count()) === 1 && /Next at \d{1,2}:\d{2} (am|pm) IST/.test(await text(row)) && (await row.locator('a[href="/live-darshan/schedule"]').count()) === 1 && (await row.locator(".home-hero__row--live-on, .home-hero__live-dot").count()) === 0, `Home upcoming @${w}: the hero row reads "Next at <time>" and links to the schedule`, await text(row));
    check((await home.locator(".home-live").evaluate((el) => el.getBoundingClientRect().height)) > 40 && (await noEmptySection(home)), `Home upcoming @${w}: the live section has content, no empty section`);
    check(!(await overflow(home)), `Home upcoming @${w}: no horizontal overflow`);
    await home.locator(".home-live").scrollIntoViewIfNeeded();
    await home.waitForTimeout(400);
    await shot(home, `home-next-${w}`);
    check(home.errors().length === 0, `Home upcoming @${w}: no console errors`, home.errors().slice(0, 2).join(" | "));
    await home.context().close();
  }
  const taHome = await newPage({ lang: null });
  await taHome.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await taHome.locator(".home-live .live-next").waitFor({ timeout: 30000 });
  check(/அடுத்த நேரடி தரிசனம்/.test(await text(taHome.locator(".home-live .live-next"))) && /இன்று • /.test(await text(taHome.locator(".home-live .live-next__when"))) && /அட்டவணையைப் பார்க்க/.test(await text(taHome.locator(".home-live .live-next__actions"))), "Home upcoming (Tamil): the card's eyebrow, day and button", await text(taHome.locator(".home-live .live-next")));
  check(/நேரடி தரிசனம்/.test(await text(taHome.locator(".home-hero__row--live"))) && /அடுத்தது/.test(await text(taHome.locator(".home-hero__row--live"))), "Home upcoming (Tamil): the hero row", await text(taHome.locator(".home-hero__row--live")));
  await taHome.context().close();
  setStatus(F.nextHome.id, "CANCELLED");

  // 3. T+0: a broadcast starting in a few seconds reads "Starting shortly" once
  // the instant passes — the countdown, the poster and the hero together, at
  // the instant itself rather than at the next 60 s poll (review fix F4).
  const t0 = keep(mkStream({ label: "Starting now", status: "SCHEDULED", starts_in_seconds: 25 }));
  const p0 = await newPage();
  await openLive(p0);
  check((await mainTitle(p0)) === t0.title_en, "T+0: the list route features the broadcast about to start", await mainTitle(p0));
  const beforeState = await text(p0.locator(".live-player__state-text"));
  check(/^Starts /.test(beforeState), "T+0: before the instant the poster still announces the start", beforeState);
  await p0.evaluate(() => { window.__noReload = true; });
  const shortly = await p0.locator(".live-next .live-countdown--started", { hasText: /Starting shortly/ }).waitFor({ timeout: 40000 }).then(() => true).catch(() => false);
  check(shortly, "T+0: the countdown reads Starting shortly once the instant has passed");
  check((await p0.locator(".live-countdown__clock").count()) === 0, "T+0: the digits are gone");
  const posterFlipped = await p0.locator(".live-player__state-text", { hasText: /^Starting shortly$/ }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  check(posterFlipped, "T+0: the poster flips within seconds of the card, not at the next poll", await text(p0.locator(".live-player__state-text")));
  const heroLine = await text(p0.locator(".live-hero__status"));
  check(/Starting shortly/.test(heroLine), "T+0: the hero status says so too", heroLine);
  check(/Scheduled/.test(heroLine), "T+0: …and still carries the Scheduled badge", heroLine);
  check(await p0.evaluate(() => window.__noReload === true), "T+0: nothing reloaded the page");
  check(p0.errors().length === 0, "T+0: no console errors", p0.errors().slice(0, 2).join(" | "));
  await p0.context().close();
  setStatus(t0.id, "CANCELLED");

  // …and the homepage's hero row flips with them, under the visitor.
  const t0home = keep(mkStream({ label: "Starting now on the homepage", status: "SCHEDULED", starts_in_seconds: 30 }));
  const h0 = await newPage();
  await h0.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await h0.locator(".home-hero__row--live").waitFor({ timeout: 30000 });
  check(/Next at \d{1,2}:\d{2} (am|pm) IST/.test(await text(h0.locator(".home-hero__row--live"))), "T+0 (Home): the hero row first reads Next at <time>", await text(h0.locator(".home-hero__row--live")));
  await h0.evaluate(() => { window.__noReload = true; });
  const rowFlipped = await h0.locator(".home-hero__row--live", { hasText: /Starting shortly/ }).waitFor({ timeout: 45000 }).then(() => true).catch(() => false);
  check(rowFlipped, "T+0 (Home): the hero row flips to Starting shortly at the instant", await text(h0.locator(".home-hero__row--live")));
  check(await h0.evaluate(() => window.__noReload === true), "T+0 (Home): without a reload");
  check(h0.errors().length === 0, "T+0 (Home): no console errors", h0.errors().slice(0, 2).join(" | "));
  await h0.context().close();
  setStatus(t0home.id, "CANCELLED");

  // 3b. A broadcast days away: the clock grows a days unit instead of counting
  // 191 hours (review fix F2), and the Tamil captions read as sentences (O15).
  const far = keep(mkStream({ label: "Aadi festival procession", status: "SCHEDULED", event_type: "procession", scheduled_start_local: `${istDate(8)} 10:00` }));
  for (const [w, lang] of [[1440, "en"], [390, null]]) {
    const p = await newPage({ width: w, height: w < 700 ? 844 : 900, lang });
    await openLive(p);
    const far90 = p.locator(".live-next");
    const units = await clockUnits(far90);
    const who = `${w} (${lang ?? "ta"})`;
    check(units.length === 4, `days countdown @${who}: four units — days, hours, minutes, seconds`, JSON.stringify(units));
    check(units[0]?.label === (lang === "en" ? "days" : "நாட்கள்"), `days countdown @${who}: the first unit is captioned days`, JSON.stringify(units[0]));
    check(/^\d{2}$/.test(units[1]?.digits ?? "") && Number(units[1]?.digits) < 24, `days countdown @${who}: the hour count is two digits, under 24 (never 191)`, JSON.stringify(units[1]));
    check(Number(units[0]?.digits) >= 7 && Number(units[0]?.digits) <= 8, `days countdown @${who}: the days count is the whole days left`, JSON.stringify(units[0]));
    const farSr = await text(far90.locator(".live-countdown .sr-only"));
    check(lang === "en" ? /^Starts in about \d+ days?( \d+ hours?)?$/.test(farSr) : /நாட்/.test(farSr), `days countdown @${who}: the sr sentence still speaks in days`, farSr);
    if (lang === null) {
      check((await text(far90.locator(".live-countdown__caption"))) === "நேரடி தரிசனம் தொடங்க இன்னும்", "days countdown (ta): the caption reads as a sentence", await text(far90.locator(".live-countdown__caption")));
      check(units[3]?.label === "நொடி", "days countdown (ta): the seconds unit is நொடி", JSON.stringify(units[3]));
      check(/திருவீதி உலா/.test(await text(far90.locator(".live-next__line"))), "days countdown (ta): the procession label matches config.php", await text(far90.locator(".live-next__line")));
    }
    check(!(await overflow(p)), `days countdown @${who}: no horizontal overflow`);
    const fits = await far90.evaluate((el) => {
      const clock = el.querySelector(".live-countdown__clock");
      const panel = el.querySelector(".live-countdown");
      if (!clock || !panel) return false;
      const c = clock.getBoundingClientRect();
      const b = panel.getBoundingClientRect();
      return c.width > 0 && c.left >= b.left - 1 && c.right <= b.right + 1;
    });
    check(fits, `days countdown @${who}: the four units sit inside the countdown panel`);
    await shot(p, `next-days-${w}-${lang ?? "ta"}`);
    check(p.errors().length === 0, `days countdown @${who}: no console errors`, p.errors().slice(0, 2).join(" | "));
    await p.context().close();
  }
  setStatus(far.id, "CANCELLED");

  // 4. The countdown proper: a broadcast in 90 s on /live-darshan.
  F.next90 = keep(mkStream({ label: "Evening Deeparadhana", status: "SCHEDULED", event_type: "deeparadhana", deity_slug: "renukadevi", starts_in_seconds: 90 }));
  const page = await newPage();
  await openLive(page);
  const card = page.locator(".live-next");
  check((await card.count()) === 1 && /Next Live Darshan/.test(await text(card)) && (await text(card.locator(".live-next__title"))) === F.next90.title_en, "/live-darshan (nothing live): the Next Live Darshan card with the title", await text(card));
  check((await page.locator(".live-stage__main h2").count()) === 1 && (await page.locator(".live-stream__head").count()) === 0, "…the card's title is the page's h2; no duplicate head");
  check((await page.locator(".live-player__poster").count()) === 1 && (await page.locator(".live-player__iframe").count()) === 0, "…above it the poster, no iframe");
  check(/Today • \d{1,2}:\d{2} (am|pm) IST/.test(await text(card.locator(".live-next__when"))), '…"Today • <time> IST"', await text(card.locator(".live-next__when")));
  check(/Deeparadhana · Sri Lingammal .* · Sri Renuka Devi/.test(await text(card.locator(".live-next__line"))) || /Deeparadhana/.test(await text(card.locator(".live-next__line"))), "…programme, temple and deity", await text(card.locator(".live-next__line")));
  const group = card.locator('.live-countdown[role="group"]');
  check((await group.count()) === 1 && /Time until it starts/.test((await group.getAttribute("aria-label")) ?? ""), "the countdown is a labelled group");
  check((await card.locator(".live-countdown__clock").getAttribute("aria-hidden")) === "true", "the digits are aria-hidden");
  check((await clockUnits(card)).length === 3, "under a day the clock is HH : MM : SS — no days unit", JSON.stringify(await clockUnits(card)));
  const d1 = await clockOf(card);
  check(/^\d{2}:\d{2}:\d{2}$/.test(d1) && clockSeconds(d1) > 40 && clockSeconds(d1) <= 90, "the clock reads HH:MM:SS with about a minute and a half left", d1);
  check(/^Live darshan starts in$/.test(await text(card.locator(".live-countdown__caption"))), "…under the caption Live darshan starts in", await text(card.locator(".live-countdown__caption")));
  const sr = await text(card.locator(".live-countdown .sr-only"));
  check(/^Starts in (about \d+ minutes?|under a minute)$/.test(sr), "an sr-only sentence at minute precision", sr);
  await page.waitForTimeout(5000);
  const d2 = await clockOf(card);
  const drift = clockSeconds(d1) - clockSeconds(d2);
  check(drift >= 4 && drift <= 6, "two samples 5 s apart differ by about 5 s (the clock ticks)", `${d1} → ${d2}`);
  const viewBtn = card.locator('.live-next__actions a[href="/live-darshan/schedule"]');
  const detailsBtn = card.locator(`.live-next__actions a[href="/live-darshan/${F.next90.slug}"]`);
  check((await viewBtn.count()) === 1 && /View schedule/.test(await text(viewBtn)) && (await detailsBtn.count()) === 1 && /Details/.test(await text(detailsBtn)), "View schedule and Details buttons");
  const targets = await page.evaluate(() => [...document.querySelectorAll("main a.btn, main button")].map((el) => ({ h: el.getBoundingClientRect().height, t: el.textContent.trim().slice(0, 30) })).filter((x) => x.h > 0 && x.h < 44));
  check(targets.length === 0, "every button the page places is at least 44 px tall", JSON.stringify(targets));
  check((await page.locator(".live-upcoming .section-head__actions a[href='/live-darshan/schedule']").count()) <= 1, "the upcoming section (when shown) links to the schedule");
  await shot(page, "next-1440");
  check(page.errors().length === 0, "countdown: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();

  // The proof that the server's clock drives it: the same page with server_time skewed.
  for (const [skewMin, label] of [[-10, "behind"], [10, "ahead"]]) {
    const p = await newPage();
    await p.route("**/api/live-streams", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.server_time = new Date(Date.parse(body.server_time) + skewMin * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      await route.fulfill({ response: res, json: body });
    });
    await openLive(p);
    if (skewMin < 0) {
      const d = await clockOf(p.locator(".live-next"));
      check(/^\d{2}:\d{2}:\d{2}$/.test(d) && clockSeconds(d) >= 600 && clockSeconds(d) <= 700, `a server_time 10 min ${label} shifts the countdown to about 11 min (the server offset is used, not the device clock)`, d);
    } else {
      check((await p.locator(".live-next .live-countdown--started").count()) === 1 && (await p.locator(".live-countdown__clock").count()) === 0, `a server_time 10 min ${label} makes it Starting shortly at once`, await text(p.locator(".live-next .live-countdown")));
    }
    await p.context().close();
  }

  // 4b. The schedule page keeps asking while a listed broadcast is within a
  // quarter of an hour of its start, so the pill becomes the Live now group
  // under the visitor, with no reload (review fix O7). Nothing else is live
  // here: before the fix the page stopped polling altogether.
  const goLive = await newPage();
  await openSchedule(goLive, "?filter=today");
  await goLive.evaluate(() => { window.__noReload = true; });
  check(
    (await goLive.locator(`.live-card[href="/live-darshan/${F.next90.slug}"]`).count()) === 1 && (await goLive.locator(".live-schedule__day-title--live").count()) === 0,
    "go live: today's schedule lists the broadcast and has no Live now group yet",
  );
  setStatus(F.next90.id, "LIVE");
  const joined = await goLive
    .locator(`.live-schedule__day:has(.live-schedule__day-title--live) .live-card[href="/live-darshan/${F.next90.slug}"]`)
    .waitFor({ state: "attached", timeout: 90000 })
    .then(() => true)
    .catch(() => false);
  check(joined, "…a poll moves it into the Live now group without a reload");
  check(await goLive.evaluate(() => window.__noReload === true), "…and the page really was never reloaded");
  check(goLive.errors().length === 0, "go live: no console errors", goLive.errors().slice(0, 2).join(" | "));
  await goLive.context().close();
  setStatus(F.next90.id, "COMPLETED");

  // 5. A broadcast goes live: the homepage's LIVE NOW state, and the schedule's Live now group.
  F.morning = keep(mkStream({ label: "Morning Abhishekam", status: "LIVE", event_type: "abhishekam", deity_slug: "lingammal", scheduled_start_local: `${tomorrowIst} 06:00` }));
  for (const w of [1440, 390]) {
    const home = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await home.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await home.locator(".home-live .live-now").waitFor({ timeout: 30000 });
    const now = home.locator(".home-live .live-now");
    const badge = now.locator(".live-now__badge");
    check((await badge.count()) === 1 && /LIVE NOW/.test(await text(badge)) && /badge--danger/.test((await badge.getAttribute("class")) ?? "") && /badge--live/.test((await badge.getAttribute("class")) ?? ""), `Home LIVE @${w}: the red LIVE NOW badge with the live dot`, await badge.getAttribute("class"));
    check((await text(now.locator(".live-now__title"))) === F.morning.title_en && /Abhishekam/.test(await text(now.locator(".live-now__line"))), `Home LIVE @${w}: the title and programme`, await text(now));
    check((await now.locator(".live-now__thumb").count()) === 1 && (await home.locator(".home-live .live-next").count()) === 0, `Home LIVE @${w}: a thumbnail box, and no next-darshan card`);
    const watch = now.locator(`a[href="/live-darshan/${F.morning.slug}"]`, { hasText: /Watch live/ });
    check((await watch.count()) === 1 && (await watch.evaluate((el) => el.getBoundingClientRect().height)) >= 44, `Home LIVE @${w}: Watch live → the broadcast's page, 44 px`);
    const row = home.locator(".home-hero__row--live");
    check((await row.count()) === 1 && /LIVE now/.test(await text(row)) && (await home.locator(".home-hero__row--live-on").count()) === 1 && (await row.locator(`a[href="/live-darshan/${F.morning.slug}"]`).count()) === 1, `Home LIVE @${w}: the hero row reads LIVE now and links to the broadcast`, await text(row));
    check(!(await overflow(home)) && (await noEmptySection(home)), `Home LIVE @${w}: no overflow, no empty section`);
    await home.locator(".home-live").scrollIntoViewIfNeeded();
    await home.waitForTimeout(400);
    await shot(home, `home-live-${w}`);
    if (w === 1440) {
      const v = await axe(home);
      check(v.length === 0, "Home LIVE @1440: axe serious/critical violations", v.join("\n      "));
      await watch.click();
      await home.locator(".live-stage").waitFor();
      check(new URL(home.url()).pathname === `/live-darshan/${F.morning.slug}` && (await home.locator(".live-player__iframe").count()) === 1, "Home LIVE: Watch live reaches the broadcast's page with the player");
    }
    check(home.errors().length === 0, `Home LIVE @${w}: no console errors`, home.errors().slice(0, 2).join(" | "));
    await home.context().close();
  }
  const taLive = await newPage({ lang: null });
  await taLive.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await taLive.locator(".home-live .live-now").waitFor({ timeout: 30000 });
  check(/இப்போது நேரலை/.test(await text(taLive.locator(".home-live .live-now__badge"))) && /நேரலையைப் பார்க்க/.test(await text(taLive.locator(".home-live .live-now__actions"))) && /இப்போது நேரலை/.test(await text(taLive.locator(".home-hero__row--live"))), "Home LIVE (Tamil): the badge, the button and the hero row", await text(taLive.locator(".home-live .live-now")));
  await taLive.context().close();
  const sched = await newPage();
  await openSchedule(sched, "?filter=today");
  const first = await sched.locator(".live-schedule__day-title").first().textContent();
  check(/^Live now/.test((first ?? "").trim()) && (await sched.locator(`.live-schedule__day:first-of-type .live-card[href="/live-darshan/${F.morning.slug}"]`).count()) === 1, "the schedule's Today filter leads with the Live now group holding the broadcast", first ?? "");
  await sched.context().close();
  setStatus(F.morning.id, "COMPLETED");
}

/* ── Main ───────────────────────────────────────────────────────────────── */
let php = null;
let vite = null;
try {
  section("Preflight");
  for (const [port, host] of [[PHP_PORT, "127.0.0.1"], [VITE_PORT, "127.0.0.1"], [VITE_PORT, "::1"]]) {
    if (await portInUse(port, host)) {
      console.log(`✗ port ${port} (${host}) is already in use — stop whatever holds it (never the user's :8000/:5173)`);
      process.exit(2);
    }
  }
  const probe = fixture("probe", {});
  if (!probe.tables) {
    console.log("✗ the live streaming tables are missing; apply migration 011 first");
    process.exit(1);
  }
  if (!probe.viewer_columns) {
    console.log("✗ the viewer tests require migration 012_live_automation.sql.");
    process.exit(2);
  }
  console.log(`  cleanup at start: ${JSON.stringify(cleanup())}`);

  php = startPhp();
  check(await waitForUrl(`${PHP_BASE}/api/pulse`), `PHP answers on ${PHP_BASE}`, php.log.slice(-400));
  vite = startVite();
  check(await waitForUrl(`${BASE}/`), `Vite answers on ${BASE}`, vite.log.slice(-400));
  const viaProxy = await fetch(`${BASE}/api/live-streams`).then((r) => r.json()).catch(() => null);
  check(Array.isArray(viaProxy?.live) && Array.isArray(viaProxy?.upcoming), "the test Vite proxies /api/live-streams to the test PHP", JSON.stringify(viaProxy).slice(0, 200));
  if (viaProxy && (viaProxy.live.length || viaProxy.upcoming.length)) {
    console.log(`  (note: this database already has ${viaProxy.live.length} live and ${viaProxy.upcoming.length} upcoming broadcasts; the list-route checks assume the suite's own are chosen first)`);
  }

  section("Fixtures");
  F.live = mkStream({ label: "Pournami Abhishekam", status: "LIVE", deity_slug: "lingammal", scheduled_start_local: `${tomorrowIst} 18:00`, scheduled_end_local: `${tomorrowIst} 19:00` });
  F.sched = mkStream({ label: "Deeparadhana", status: "SCHEDULED", event_type: "deeparadhana", deity_slug: "renukadevi", provider_reference: YT2, scheduled_start_local: `${tomorrowIst} 18:00`, scheduled_end_local: `${tomorrowIst} 19:00` });
  F.off = mkStream({ label: "Offline one", status: "OFFLINE", provider_reference: `https://youtu.be/${YT}`, scheduled_start_local: `${dayAfterIst} 06:00` });
  F.draft = mkStream({ label: "Draft one", status: "DRAFT" });
  F.done = mkStream({ label: "Finished one", status: "COMPLETED", scheduled_start_local: `${dayAfterIst} 07:00`, scheduled_end_local: `${dayAfterIst} 08:00` });
  check(F.live.status === "LIVE" && F.sched.status === "SCHEDULED" && F.off.status === "OFFLINE" && F.draft.status === "DRAFT" && F.done.status === "COMPLETED", "five fixtures in the intended states", [F.live, F.sched, F.off, F.draft, F.done].map((f) => `${f.slug}:${f.status}`).join(" "));
  const index = await fetch(`${PHP_BASE}/api/live-streams`).then((r) => r.json());
  check(index.live[0]?.slug === F.live.slug && index.upcoming.some((s) => s.slug === F.sched.slug), "the API lists the live fixture first and the scheduled one as upcoming", JSON.stringify({ live: index.live.map((s) => s.slug), upcoming: index.upcoming.map((s) => s.slug) }));

  browser = await chromium.launch();
  const warm = await newPage();
  for (const path of ["/live-darshan", "/", "/about"]) {
    await warm.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await warm.locator("h1").first().waitFor().catch(() => {});
  }
  await warm.context().close();

  await scenario("widths", "/live-darshan (LIVE) at four widths", liveAtWidths);
  await scenario("facts", "The live broadcast's facts", liveFacts);
  await scenario("iframe", "The YouTube iframe, Tamil then English", iframeChecks);
  await scenario("slug", "Slug routes: direct, not found, draft, offline, completed", slugRoutes);
  await scenario("entry", "Header, drawer, footer and Home tile", entryPoints);
  await scenario("header", "Header fit at 30 widths with the new nav entry", headerFit);
  await scenario("polling", "Polling and the live region", liveRegionAndPolling);
  await scenario("schedule", "The schedule page: filters, address, counts, day groups, empty state (Phase 2)", schedulePage);
  await scenario("phase4", "The premium player page: viewer count, actions, Notify me, the recording, Try again, About this pooja (Phase 4)", premiumPage);
  await scenario("scheduled", "After the live broadcast ends: SCHEDULED, then the empty state", scheduledThenEmpty);
  await scenario("phase2", "The countdown, the server offset and the homepage's three states (Phase 2)", countdownAndHome);

  section("Hygiene");
  check(phpNoise.length === 0, "no PHP warnings, notices or fatals from the fixtures", phpNoise.slice(0, 3).join(" | "));
  check(!/(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):/.test(php.log), "no PHP warnings, notices or fatals from the server", /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(php.log)?.[0]);
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
    const left = sql("SELECT COUNT(*) AS n FROM live_streams WHERE title_en LIKE ?", [`${CLEAN_PREFIX}%`])[0];
    check(Number(left?.n) === 0, "no rows of this suite are left behind", JSON.stringify(left));
  } catch (e) {
    check(false, "cleanup at the end", String(e?.message || e));
  }
  await stopServer(vite, ["127.0.0.1", "::1"]);
  await stopServer(php, ["127.0.0.1"]);
  const still = (await portInUse(PHP_PORT)) || (await portInUse(VITE_PORT)) || (await portInUse(VITE_PORT, "::1"));
  check(!still, "both test servers are stopped");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
