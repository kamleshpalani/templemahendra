#!/usr/bin/env node
/**
 * tests/payments-ui.mjs — the donor's side of online payments, in a real
 * browser against a PHP server and a Vite dev server this suite starts itself
 * (docs/payments/SPEC.md §7, §12 item 4).
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
 *     node tests/payments-ui.mjs
 *
 *   PAY_SHOTS=<dir>   where the screenshots go (default shots/payments)
 *
 * Servers (both stopped at the end, whatever happens):
 *   • PHP on 127.0.0.1:8063 with the simulator overlay (mode=simulator, seva
 *     payments and international on), SITE_URL=http://localhost:5190 and the
 *     notification test drivers, so the real payment code runs end to end and
 *     no message leaves the machine.
 *   • A throwaway Vite on http://localhost:5190 whose /api proxy points at that
 *     PHP (VITE_PROXY_TARGET). The user's own :8000 / :5173 are never touched.
 *
 * What it proves:
 *   • /donate at 390/768/1024/1440: one h1, no horizontal overflow, no console
 *     errors, axe clean; the "not open yet" card when payments are off;
 *   • purpose cards with a suggested amount, preset chips and "Other amount",
 *     the currency select only when international is on, per-step validation
 *     with a focused error summary, Back / Next, the browser's Back button, the
 *     draft surviving a reload without the PAN, the review showing amount and
 *     currency, a double press of Proceed sending exactly one POST, the
 *     "Redirecting securely to CCAvenue…" state, and the back-forward cache
 *     return from the gateway resetting the button;
 *   • simulator → Pay → the success page's facts → the receipt (screen and print
 *     media: the site's chrome is display:none, the QR code and verify link are
 *     present) → the verify page, genuine and forged;
 *   • Decline → failed page → Try again → a new "-R2" order → success;
 *     Cancel → cancelled page → "Return to the donation page" keeps the draft;
 *     Awaited → pending page that polls to success once the sweep confirms it;
 *   • Tamil strings on the donate page; the Home tile; the /donations page's
 *     "Donate online" card only when payments are on, with every pledge selector
 *     unchanged; the seva dialog's online path (one submit button, the price
 *     from the server) and its request path unchanged; the policy pages.
 *
 * Data: donors "E2E-PAY-UI-<run> …", emails e2e-pay-ui-<run>-…@example.test,
 * X-Forwarded-For 10.83.0.100–199. Rows are removed by name prefix (never by
 * number) at the start and in `finally`, together with their attempts, audit,
 * notifications, simulator counters and rate-limit buckets. The receipt counter
 * is put back where it was when only this run advanced it.
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
const PHP_PORT = 8063;
const VITE_PORT = 5190;
const PHP_BASE = `http://127.0.0.1:${PHP_PORT}`;
const BASE = `http://localhost:${VITE_PORT}`;
const RUN = Date.now().toString(36);
const NAME_PREFIX = "E2E-PAY-UI";
const DONOR = `${NAME_PREFIX}-${RUN} Donor`;
const DEVOTEE = `${NAME_PREFIX}-${RUN} Seva`;
const EMAIL = `e2e-pay-ui-${RUN}-donor@example.test`;
const SHOTS = process.env.PAY_SHOTS || resolve(ROOT, "shots/payments");
mkdirSync(SHOTS, { recursive: true });

// Fake values, chosen here; nothing real is ever read or written.
const SERVER_ENV = {
  PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SECRET: "e2e-pay-ui-fake-secret-0123456789abcdef-not-real",
  PAYMENTS_SETTINGS_KEY: Buffer.from("e2e-pay-ui-fake-settings-key!!!!").toString("base64"),
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({
    enabled: "1",
    mode: "simulator",
    seva_online_enabled: "1",
    international_enabled: "1",
    currencies: "INR,USD",
    default_currency: "INR",
  }),
  SITE_URL: BASE,
  TRUSTED_PROXIES: "127.0.0.1,::1",
  CORS_ORIGIN: "*",
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_SMS_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "test",
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
// PAY_ONLY=success,cancel runs a subset while a failure is being chased.
const ONLY = (process.env.PAY_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const openPages = new Set();
async function scenario(key, name, fn) {
  if (ONLY.length && !ONLY.includes(key)) return;
  try {
    await fn();
  } catch (e) {
    check(false, `${name} (scenario threw)`, String(e?.stack || e).split("\n").slice(0, 3).join(" "));
    // Whatever was on screen when it broke, and what the browser complained about.
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

const viaBash = /\.sh$/i.test(PHP_BIN);
/** JSON for argv: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

function fixtures(cmd, obj = {}) {
  const args = ["tests/support/payments_fixtures.php", cmd, arg(obj)];
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
// No backslashes in statements: Git Bash strips them on the way to php.sh.
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}

const usedIps = new Set();
let ipSeq = 100;
function nextIp() {
  const ip = `10.83.0.${ipSeq}`;
  ipSeq += 1;
  usedIps.add(ip);
  return ip;
}

/** Every row this suite's names created, plus the buckets its addresses used. */
function cleanup() {
  const r = fixtures("cleanup", { name_prefix: NAME_PREFIX, ips: [...usedIps] });
  if (r.error) throw new Error(`cleanup: ${r.error}`);
  return r;
}

/** The receipt counters as they stand, so they can be put back after the run. */
const countersNow = () => Object.fromEntries(sql("SELECT name, value FROM payment_counters WHERE name LIKE ?", ["receipt:%"]).map((r) => [r.name, Number(r.value)]));

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
  const child = spawn(process.execPath, [resolve(FRONTEND, "node_modules/vite/bin/vite.js"), "--port", String(VITE_PORT), "--strictPort"], {
    cwd: FRONTEND,
    env: { ...process.env, VITE_PROXY_TARGET: PHP_BASE },
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
const IGNORE = /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js|React Router Future Flag/;

async function newPage({ width = 1440, height = 900, lang = "en", address = nextIp() } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN", timezoneId: "Asia/Kolkata" });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem("temple:lang", l);
      localStorage.setItem("templeVisited", "1");
    } catch {
      /* private mode */
    }
    // Headless Chromium has no print dialog; count the calls instead.
    window.__printed = 0;
    window.print = () => {
      window.__printed += 1;
    };
    // The hand-off to the gateway is a form.submit() the page builds itself.
    // Record what it posts and hold it until the test lets it go
    // (awaitHandoff → __releaseHandoff), so the "Redirecting…" card can be
    // read and photographed however long that takes. A fixed delay here raced
    // the full-page screenshot, which takes 3–6 s at 1440 px on a busy machine:
    // the browser left mid-shot and the checks after it ran on the simulator.
    const nativeSubmit = HTMLFormElement.prototype.submit;
    const held = [];
    window.__handoff = [];
    HTMLFormElement.prototype.submit = function submitHeld() {
      const fields = {};
      for (const el of Array.from(this.elements)) if (el.name) fields[el.name] = el.value;
      window.__handoff.push({ action: this.action, method: this.method, fields });
      held.push(this);
    };
    // The first post goes ahead, as it would have without the hold (a real
    // browser has left the page before a second one could run). It is started
    // on a fresh task so the evaluate that calls this returns first.
    window.__releaseHandoff = () => {
      const form = held.shift();
      held.length = 0;
      if (form) setTimeout(() => nativeSubmit.call(form), 0);
      return form ? 1 : 0;
    };
  }, lang);
  // X-Forwarded-For only on requests to the site itself: as a context-wide
  // header it would also ride on Google Fonts requests and force a preflight.
  const origin = new URL(BASE).origin;
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== origin) return route.continue();
    return route.continue({ headers: { ...req.headers(), "x-forwarded-for": address } });
  });
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
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
      rules: { "color-contrast": { enabled: true } },
    });
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
  });
}
const text = async (loc) => ((await loc.textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const focusedClass = (page) => page.evaluate(() => document.activeElement?.className ?? "");
const focusedId = (page) => page.evaluate(() => document.activeElement?.id ?? "");
const sessionItem = (page, key) => page.evaluate((k) => sessionStorage.getItem(k), key);

/** dt → dd of a definition list. */
const facts = (page, selector) =>
  page.evaluate((sel) => {
    const out = {};
    for (const row of document.querySelectorAll(`${sel} dt`)) {
      const dd = row.nextElementSibling;
      out[row.textContent.trim()] = dd ? dd.textContent.replace(/\s+/g, " ").trim() : "";
    }
    return out;
  }, selector);

/** The status/receipt query from a result or receipt URL. */
function refOf(url) {
  const u = new URL(url);
  return { ref: u.searchParams.get("ref"), t: u.searchParams.get("t") };
}

/** The real config with a change on top (for "off" and "no international" states). */
async function mockConfig(page, patch) {
  await page.route("**/api/payments/config", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: typeof patch === "function" ? patch(body) : { ...body, ...patch } });
  });
}

/* ── Donate page helpers ────────────────────────────────────────────────── */

const nextBtn = (page) => page.locator(".don-actions__next:visible");
const backBtn = (page) => page.locator(".don-actions__back:visible");
const stepTitle = (page) => page.locator("#don-step-title");

async function openDonate(page, step = "") {
  await page.goto(`${BASE}/donate${step ? `?step=${step}` : ""}`, { waitUntil: "domcontentloaded" });
  await page.locator("h1").first().waitFor();
  await page.locator(".form-stepper, .don-closed").first().waitFor();
}

async function pickCategory(page, slug) {
  await page.locator(`.pay-choice__option:has(input[name="category"][value="${slug}"])`).click();
}
async function pickPreset(page, amount) {
  await page.locator(`.don-amounts__chip:has(input[value="${amount}"])`).click();
}

async function fillPurpose(page, { category = "temple_development", preset = 5000, amount = null } = {}) {
  await pickCategory(page, category);
  if (amount !== null) await page.fill("#don-amount", String(amount));
  else await pickPreset(page, preset);
}

async function fillDetails(page, { name = DONOR, phone = "9876512345", email = EMAIL, pan = "", address = "", city = "", postcode = "", message = "" } = {}) {
  await page.fill("#don-name", name);
  await page.fill("#don-phone", phone);
  if (email) await page.fill("#don-email", email);
  if (address) await page.fill("#don-address", address);
  if (city) await page.fill("#don-city", city);
  if (postcode) await page.fill("#don-postcode", postcode);
  if (pan) await page.fill("#don-pan", pan);
  if (message) await page.fill("#don-message", message);
}

/**
 * The hand-off: the "Redirecting…" card is on screen and the page has called
 * form.submit(), which the init script above holds. Returns what the page is
 * about to post and what the card said; `before` runs while the card is still
 * up, and only then is the post released and the browser allowed to leave.
 */
async function awaitHandoff(page, { shotName = null, before = null } = {}) {
  await page.locator(".pay-redirect__title").waitFor();
  await page.waitForFunction(() => (window.__handoff || []).length > 0);
  const seen = await page.evaluate(() => ({ ...window.__handoff[0], count: window.__handoff.length }));
  seen.title = await text(page.locator(".pay-redirect__title"));
  seen.role = (await page.locator(".pay-redirect").getAttribute("role")) ?? "";
  if (shotName) await shot(page, shotName);
  if (before) await before(page, seen);
  const released = await page.evaluate(() => window.__releaseHandoff());
  if (released !== 1) throw new Error(`awaitHandoff: no held gateway post to release on ${page.url()}`);
  return seen;
}

/** The facts the simulator page shows for the order it received. */
async function simulatorFacts(page) {
  await page.waitForURL(/\/api\/payments\/simulator/);
  await page.locator('button[data-sim="upi"]').waitFor();
  return { title: await text(page.locator("h1")), ...(await facts(page, "main dl")) };
}

/** Press a simulator button and wait for the site's result page. */
async function simulatorPress(page, action) {
  await page.locator(`button[data-sim="${action}"]`).click();
  await page.waitForURL(/\/payment\/result/);
  await page.locator(".pay-result__title").waitFor();
}

/** Fill the three steps and proceed; returns once the simulator page is up. */
async function startDonation(page, { category = "temple_development", preset = 5000, amount = null, details = {} } = {}) {
  await openDonate(page);
  await fillPurpose(page, { category, preset, amount });
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
  await fillDetails(page, details);
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();
  await page.check("#don-accept-terms");
  await nextBtn(page).click();
  await awaitHandoff(page);
  return simulatorFacts(page);
}

/* ── Scenarios ──────────────────────────────────────────────────────────── */

async function donateAtWidths() {
  section("/donate at four widths");
  for (const w of [390, 768, 1024, 1440]) {
    const page = await newPage({ width: w, height: w < 700 ? 844 : 900 });
    await openDonate(page);
    await page.waitForTimeout(500);
    const h1s = await page.locator("h1").count();
    check(h1s === 1, `/donate @${w}: exactly one h1`, `found ${h1s}`);
    check(!(await overflow(page)), `/donate @${w}: no horizontal overflow`);
    check((await page.locator(".form-stepper").count()) === 1, `/donate @${w}: the stepper is shown`);
    check(/Simulator/.test(await text(page.locator(".pay-banner"))), `/donate @${w}: the simulator banner says so`);
    if (w === 1440) {
      const v = await axe(page);
      check(v.length === 0, "/donate @1440: axe serious/critical violations", v.join("\n      "));
    }
    if (w === 390 || w === 1440) await shot(page, `donate-step1-${w}`);
    const errs = page.errors();
    check(errs.length === 0, `/donate @${w}: no console errors`, errs.slice(0, 3).join(" | "));
    await page.context().close();
  }
}

async function closedState() {
  section("When payments are off");
  const page = await newPage();
  await mockConfig(page, { enabled: false, ready: false });
  await openDonate(page);
  check((await page.locator(".don-closed").count()) === 1, "off: the 'will open soon' card is shown");
  check(/Online donations will open soon/.test(await text(page.locator(".don-closed__title"))), "off: its heading");
  check((await page.locator(".form-stepper").count()) === 0, "off: no stepper");
  check((await page.locator('.don-closed a[href="/donations#bank-details"]').count()) === 1, "off: bank transfer link");
  check((await page.locator('.don-closed a[href="/donations#pledge"]').count()) === 1, "off: pledge link");
  await shot(page, "donate-closed-1440");
  await page.goto(`${BASE}/donations`, { waitUntil: "domcontentloaded" });
  await page.locator("#pledge").waitFor();
  await page.waitForTimeout(800);
  check((await page.locator("#donate-online").count()) === 0, "off: /donations has no Donate-online card");
  check((await page.locator('.page-hero a[href="/donate"]').count()) === 0, "off: /donations hero has no Donate-online action");
  check(page.errors().length === 0, "off: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
}

async function donationsPage() {
  section("/donations with payments on");
  const page = await newPage();
  await page.goto(`${BASE}/donations`, { waitUntil: "domcontentloaded" });
  await page.locator("#donate-online").waitFor();
  check((await page.locator("#donate-online").count()) === 1, "on: the Donate-online card is at the top of the left column");
  check((await page.locator('#donate-online a[href="/donate"]').count()) === 1, "on: the card links to /donate");
  check((await page.locator('.page-hero a[href="/donate"]').count()) === 1, "on: the hero has a Donate-online action");
  // Everything the older public suite relies on is still there.
  check((await page.locator("#pledge").count()) === 1 && (await page.locator("#bank-details").count()) === 1, "on: #pledge and #bank-details anchors kept");
  const chip = page.locator("button", { hasText: /₹1001|₹1,001/ }).first();
  await chip.click();
  check((await page.inputValue('input[name="amount"]')) === "1001", "on: the ₹1001 pledge chip still fills input[name=amount]");
  check((await page.locator('form button[type="submit"]').count()) >= 1, "on: the pledge form's submit button is present");
  check((await page.locator(".donations__info > *").first().getAttribute("id")) === "donate-online", "on: the card is the first thing in the left column");
  check(!(await overflow(page)), "on: /donations has no horizontal overflow");
  await shot(page, "donations-1440");
  check(page.errors().length === 0, "on: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();

  // The Home tile points at /donate too (its NRI content).
  const home = await newPage();
  await home.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await home.locator('[role="tab"]', { hasText: /NRI/ }).first().click();
  // The tile sits in a scroll-revealed block, so it may be attached but not yet painted.
  const tile = home.locator('a[href="/donate"]', { hasText: /Donate Online/ });
  await tile.first().waitFor({ state: "attached" });
  check((await tile.count()) >= 1, "Home: the Online Donation tile goes to /donate");
  check(/UPI, card or net banking/.test(await text(home.locator(".home-tile", { has: tile }).first())), "Home: the tile no longer talks about a bank transfer");
  await home.context().close();
}

async function purposeStep() {
  section("Step 1: purpose and amount");
  const page = await newPage();
  await openDonate(page);

  await nextBtn(page).click();
  const summary = page.locator(".form-summary");
  await summary.waitFor();
  const items = await summary.locator("li").count();
  check(items === 2, "empty Next: the error summary lists the purpose and the amount", `${items} items`);
  check(/form-summary/.test(await focusedClass(page)), "empty Next: focus moves to the error summary");
  check((await page.locator("#don-amount").getAttribute("aria-invalid")) === "true", "empty Next: the amount field is marked invalid");
  await shot(page, "donate-errors-1440");
  await summary.locator("a").first().click();
  check((await focusedId(page)) === "don-category", "summary link: focuses the first purpose radio");

  await pickCategory(page, "temple_development");
  await page.waitForTimeout(150);
  check((await summary.locator("li").count()) === 1, "choosing a purpose clears its own error");

  await pickPreset(page, 5000);
  check((await page.inputValue("#don-amount")) === "5000", "the ₹5,000 chip fills the amount");
  check(/You are giving ₹5,000 \(INR\) for Temple Development/.test(await text(page.locator(".don-summary"))), "live summary line names amount, currency and purpose");
  check((await page.locator(".form-summary").count()) === 0, "a valid amount clears the summary");

  await page.fill("#don-amount", "700");
  check((await page.locator('.don-amounts__chip input:checked[value="other"]').count()) === 1, "typing an amount selects 'Other amount'");
  check(/₹700/.test(await text(page.locator(".don-summary"))), "the summary follows the typed amount");

  await page.fill("#don-amount", "999999");
  await nextBtn(page).click();
  await summary.waitFor();
  check(/5,00,000/.test(await text(summary)), "an amount over the maximum names the limit (₹5,00,000)");
  await page.fill("#don-amount", "0");
  await nextBtn(page).click();
  check(/at least ₹1/.test(await text(summary)), "an amount under the minimum says at least ₹1");

  // Currency: shown because the server has international on with INR and USD.
  check((await page.locator("#don-currency").count()) === 1, "international on: the currency select is shown");
  await page.selectOption("#don-currency", "USD");
  check((await page.locator(".don-amounts").count()) === 0, "USD: the rupee preset chips disappear");
  check(/Amounts are in USD/.test(await text(page.locator(".field:has(#don-currency)"))), "USD: 'Amounts are in USD' hint");
  check(/Amount \(USD\)/.test(await text(page.locator("label[for='don-amount']"))), "USD: the amount label carries the code");
  await page.selectOption("#don-currency", "INR");
  check((await page.locator(".don-amounts").count()) === 1, "back to INR: the preset chips return");
  check(page.errors().length === 0, "step 1: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();

  // Suggested amounts (none seeded): the config is patched for this page only.
  const p2 = await newPage();
  await mockConfig(p2, (body) => ({
    ...body,
    categories: body.categories.map((c) => (c.slug === "annadanam" ? { ...c, suggestedAmount: 1500 } : c)),
  }));
  await openDonate(p2);
  check(/Suggested ₹1,500/.test(await text(p2.locator('.pay-choice__option:has(input[value="annadanam"])'))), "a category shows its suggested amount");
  await pickCategory(p2, "annadanam");
  check((await p2.inputValue("#don-amount")) === "1500", "picking it fills the suggested amount");
  await p2.fill("#don-amount", "700");
  await pickCategory(p2, "general");
  await pickCategory(p2, "annadanam");
  check((await p2.inputValue("#don-amount")) === "700", "a typed amount is never overwritten by a suggestion");
  await p2.context().close();

  const p3 = await newPage();
  await mockConfig(p3, { international: false, currencies: [{ code: "INR", decimals: 2 }] });
  await openDonate(p3);
  check((await p3.locator("#don-currency").count()) === 0, "international off: no currency select");
  await p3.context().close();
}

async function successFlow() {
  section("Details, review, hand-off and a successful payment");
  const page = await newPage();
  let posts = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/api/payments/donations")) posts += 1;
  });

  await openDonate(page);
  await fillPurpose(page, { category: "temple_development", preset: 5000 });
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
  check(/step=details/.test(page.url()), "Next: the step is in the URL");
  check((await focusedId(page)) === "don-step-title", "Next: focus lands on the step heading");
  // The announcement is written on the next animation frame, after a clear.
  const announced = await page
    .locator(".sr-only[role='status']", { hasText: /Step 2 of 3/ })
    .waitFor({ state: "attached", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(announced, "Next: the step change is announced");

  await nextBtn(page).click();
  const summary = page.locator(".form-summary");
  await summary.waitFor();
  const items = await summary.locator("li").count();
  check(items === 2, "details, empty Next: name and mobile number are required", `${items} items`);
  check(/form-summary/.test(await focusedClass(page)), "details, empty Next: focus on the summary");

  await fillDetails(page, { pan: "abcde1234f", address: "12 Temple Street", city: "Pudupatti", postcode: "627719", message: "For the annadanam hall" });
  check((await page.inputValue("#don-pan")) === "ABCDE1234F", "the PAN is uppercased as typed");
  await shot(page, "donate-step2-1440");
  await backBtn(page).click();
  await stepTitle(page).filter({ hasText: /Purpose and amount/ }).waitFor();
  check((await page.inputValue("#don-amount")) === "5000", "Back keeps what was typed");
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
  check((await page.inputValue("#don-name")) === DONOR, "Next again: the details are still there");
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();

  check((await text(page.locator(".don-total__value"))) === "₹5,000", "review: the amount is shown large");
  check((await text(page.locator(".don-total__code"))) === "INR", "review: the currency is shown with it");
  check((await text(page.locator(".don-total__purpose"))) === "Temple Development", "review: the purpose under the amount");
  const review = await facts(page, ".don-review__list");
  check(review["PAN"] === "ABCDE1234F", "review: the PAN is listed", JSON.stringify(review));
  check(review["Thank-you list"] === "Anonymous", "review: anonymous by default");
  check((await page.locator('a[href="/terms-and-conditions"][target="_blank"][rel="noopener"]').count()) === 1, "review: terms link opens in a new tab");
  check((await page.locator('a[href="/refund-cancellation-policy"][target="_blank"][rel="noopener"]').count()) === 1, "review: refund policy link opens in a new tab");
  await shot(page, "donate-review-1440");

  await page.goBack();
  await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
  check(/step=details/.test(page.url()), "browser Back returns to the previous step");
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();

  await page.reload({ waitUntil: "domcontentloaded" });
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();
  const restored = await facts(page, ".don-review__list");
  check(restored["Full name"] === DONOR, "reload: the draft restores the details");
  check(restored["PAN"] === "Not given", "reload: the PAN is not kept in the draft");
  check((await text(page.locator(".don-total__value"))) === "₹5,000", "reload: the amount survives");
  await page.locator('button[aria-label="Edit your details"]').click();
  await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
  await page.fill("#don-pan", "ABCDE1234F");
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();
  check((await facts(page, ".don-review__list"))["PAN"] === "ABCDE1234F", "Edit from review returns to review with the PAN");

  await nextBtn(page).click();
  await summary.waitFor();
  check(/Terms/.test(await text(summary)), "Proceed without the tick: the terms are required");
  check((await page.locator("#don-accept-terms").getAttribute("aria-invalid")) === "true", "the terms checkbox is marked invalid");
  await page.check("#don-accept-terms");

  // Two presses in the same tick: the ref guard, not React state, must stop the second.
  await page.$eval(".don-actions__next:visible", (b) => {
    b.click();
    b.click();
  });
  const seen = await awaitHandoff(page, {
    shotName: "redirecting-1440",
    before: async (p, s) => {
      // A back-forward-cache return fires pageshow with persisted=true.
      await p.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      // The handler only sets state; React takes the card down on its next
      // render. Wait for that render instead of a fixed pause, then read.
      await p.locator(".pay-redirect").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      s.afterShow = {
        redirect: await p.locator(".pay-redirect").count(),
        label: await text(p.locator(".don-actions__next:visible")),
        disabled: await p.locator(".don-actions__next:visible").isDisabled().catch(() => true),
      };
    },
  });
  const sim = await simulatorFacts(page);
  check(posts === 1, "a double press of Proceed sends exactly one POST", `${posts} POSTs`);
  check(seen.count === 1, "the gateway form is submitted once", `${seen.count} submits`);
  check(seen.title === "Redirecting securely to CCAvenue…", "the 'Redirecting securely to CCAvenue…' card is shown", seen.title);
  check(seen.role === "status", "the hand-off card is a live status region");
  check(seen.action === `${BASE}/api/payments/simulator` && seen.method === "post", "the form posts to the checkout URL the server issued", `${seen.method} ${seen.action}`);
  check(
    Object.keys(seen.fields ?? {}).sort().join(",") === "access_code,encRequest" && /^[0-9a-f]+$/.test(seen.fields.encRequest) && seen.fields.access_code === "SIMULATORACCESS",
    "the browser posts encRequest and access_code only",
    JSON.stringify(Object.keys(seen.fields ?? {})),
  );
  check(seen.afterShow?.redirect === 0 && seen.afterShow?.label === "Proceed to payment" && seen.afterShow?.disabled === false, "pageshow(persisted) puts the review step back with the button enabled", JSON.stringify(seen.afterShow));
  check(sim.title === "CCAvenue simulator — test payments only", "the simulator page opened", sim.title);
  check(/^DON-\d{8}-\d{8}$/.test(sim["Order ID"] ?? ""), "the order id is the donation number", sim["Order ID"]);
  check(sim.Amount === "5000.00" && sim.Currency === "INR", "the gateway received the server's amount and currency", `${sim.Amount} ${sim.Currency}`);
  check(sim["Billing name"] === DONOR, "the gateway received the billing name");
  const firstNumber = sim["Order ID"];

  // The real Back button from the gateway.
  await page.goBack({ waitUntil: "domcontentloaded" });
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();
  await page.waitForTimeout(300);
  check((await page.locator(".pay-redirect").count()) === 0, "Back from the gateway: no 'Redirecting' card");
  check(!(await nextBtn(page).isDisabled()) && (await text(nextBtn(page))) === "Proceed to payment", "Back from the gateway: Proceed is enabled again");
  const afterBack = await facts(page, ".don-review__list");
  check(afterBack["Full name"] === DONOR, "Back from the gateway: the review still has the details");
  if (afterBack["PAN"] !== "ABCDE1234F") {
    // The browser reloaded the page rather than restoring it, so the PAN (never
    // written to the draft) has to be typed again for the receipt checks below.
    console.log("  (the page was reloaded on Back, not restored from the cache: re-entering the PAN)");
    await page.locator('button[aria-label="Edit your details"]').click();
    await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
    await page.fill("#don-pan", "ABCDE1234F");
    await nextBtn(page).click();
    await stepTitle(page).filter({ hasText: /Review/ }).waitFor();
  }
  if (!(await page.isChecked("#don-accept-terms"))) await page.check("#don-accept-terms");
  await nextBtn(page).click();
  await awaitHandoff(page);
  const sim2 = await simulatorFacts(page);
  check(/^DON-\d{8}-\d{8}$/.test(sim2["Order ID"] ?? "") && sim2["Order ID"] !== firstNumber, "Proceeding again starts a fresh donation", sim2["Order ID"]);
  const number = sim2["Order ID"];

  await simulatorPress(page, "upi");
  const { ref, t: token } = refOf(page.url());
  check(ref === number && /^[A-Za-z0-9_-]{22}$/.test(token ?? ""), "the gateway returns to /payment/result with the number and its token");
  const title = page.locator(".pay-result__title");
  await title.filter({ hasText: /Thank you for your contribution/ }).waitFor();
  check((await focusedClass(page)).includes("pay-result__title"), "success: the heading takes focus");
  check(/successfully received/.test(await text(page.locator(".pay-result__lead"))), "success: the confirmation sentence");
  const f = await facts(page, ".pay-result__facts");
  check(f["Donation ID"] === number, "success: Donation ID", JSON.stringify(f));
  check(f["Amount"] === "₹5,000 (INR)", "success: Amount with currency", f["Amount"]);
  check(f["Purpose"] === "Temple Development", "success: Purpose");
  check(f["Name"] === DONOR, "success: Donor name");
  check(/^\d{12}$/.test(f["CCAvenue reference"] ?? ""), "success: CCAvenue reference (tracking id)", f["CCAvenue reference"]);
  check(f["Payment mode"] === "UPI", "success: Payment mode");
  check(/^SIM-\d{4}-\d{6}$/.test(f["Receipt number"] ?? ""), "success: Receipt number is a SIM-… number (a simulator payment never takes a real receipt number)", f["Receipt number"]);
  check(f["Payment status"] === "Paid", "success: status badge reads Paid");
  check(/Payment date/.test(Object.keys(f).join(",")) && /2\d{3}/.test(f["Payment date"] ?? ""), "success: Payment date", f["Payment date"]);
  check(/Simulator/.test(await text(page.locator(".pay-banner"))) && /no real money/.test(await text(page.locator(".pay-banner"))), "success: the simulator banner says no real money was taken", await text(page.locator(".pay-banner")));
  check((await sessionItem(page, "temple:donation-draft")) === null, "success: the donation draft is cleared");
  check((await sessionItem(page, "temple:payment-last")) === null, "success: the last-payment entry is cleared");
  check((await page.locator("h1").count()) === 1, "success: one h1");
  check(!(await overflow(page)), "success: no horizontal overflow");
  const v = await axe(page);
  check(v.length === 0, "success: axe serious/critical violations", v.join("\n      "));
  await shot(page, "result-success-1440");

  const row = sql("SELECT id, status, receipt_number, email, pan, show_name_publicly FROM donations WHERE donation_number = ?", [number])[0];
  check(row?.status === "SUCCESS" && row.receipt_number === f["Receipt number"], "DB: the donation is SUCCESS with that receipt number", JSON.stringify(row));
  check(row?.email === EMAIL && row.pan === "ABCDE1234F" && Number(row.show_name_publicly) === 0, "DB: email, PAN and consent stored as entered", JSON.stringify(row));
  const att = sql("SELECT attempt, status, verification, response_count, payment_mode FROM payment_transactions WHERE order_id = ?", [number])[0];
  check(att?.status === "SUCCESS" && att.verification === "status_api" && Number(att.response_count) === 1, "DB: the attempt is SUCCESS, confirmed with the status API", JSON.stringify(att));

  // Email the receipt to the address on file.
  const emailBtn = page.locator(".pay-result__email button", { hasText: /Email it to/ });
  check(/Email it to e•••@example\.test/.test(await text(emailBtn)), "email: the button shows the masked address", await text(emailBtn));
  await emailBtn.click();
  const sent = page.locator(".pay-email.alert--success");
  await sent.waitFor();
  check(/on its way to e•••@example\.test/.test(await text(sent)), "email: the receipt is queued");
  const notes = sql("SELECT event, dedupe_key FROM notifications WHERE entity_type = 'donation' AND entity_id = ? ORDER BY id", [row?.id ?? 0]);
  check(notes.some((n) => n.event === "donation.paid" && /:paid$/.test(n.dedupe_key ?? "")) && notes.some((n) => /resend/.test(n.dedupe_key ?? "")), "DB: one donation.paid and one resend notification", JSON.stringify(notes));
  check(page.errors().length === 0, "success flow: no console errors", page.errors().slice(0, 3).join(" | "));

  // The receipt.
  await page.locator(".pay-result__actions a", { hasText: /Download receipt/ }).click();
  await page.waitForURL(/\/payment\/receipt/);
  await page.locator(".pay-receipt").waitFor();
  check((await page.locator("h1").count()) === 1 && (await text(page.locator("h1"))) === "Donation receipt", "receipt: the document title is the page's only h1");
  const r = await facts(page, ".pay-receipt__list");
  check(r["Receipt number"] === f["Receipt number"], "receipt: Receipt number", JSON.stringify(r));
  check(/no real money/.test(await text(page.locator(".pay-banner"))), "receipt: the banner says no real money was taken", await text(page.locator(".pay-banner")));
  check(r["Donation ID"] === number, "receipt: Donation ID");
  check(r["CCAvenue reference"] === f["CCAvenue reference"], "receipt: CCAvenue reference");
  check(/^SIM\d{10}$/.test(r["Bank reference"] ?? ""), "receipt: Bank reference");
  check(r["PAN"] === "ABCDE••••F", "receipt: the PAN is masked");
  check(/12 Temple Street, Pudupatti/.test(r["Address"] ?? "") && /627719/.test(r["Address"] ?? "") && /India/.test(r["Address"] ?? ""), "receipt: the address with the country", r["Address"]);
  check(r["Amount"] === "₹5,000 (INR)", "receipt: Amount");
  check((await text(page.locator(".pay-receipt__amount-words"))) === "Rupees Five Thousand Only", "receipt: the amount in words");
  check(r["Payment mode"] === "UPI" && r["Payment status"] === "Paid", "receipt: mode and status");
  check(/Reg\. No\. 9\/2023/.test(await text(page.locator(".pay-receipt__head"))) && /AAKTA2241H/.test(await text(page.locator(".pay-receipt__head"))), "receipt: Trust registration and PAN in the header");
  check(/computer-generated receipt/.test(await text(page.locator(".pay-receipt__generated"))), "receipt: the no-signature note");
  check((await page.locator(".pay-receipt__verify svg").count()) === 1, "receipt: the QR code is present");
  const verifyUrl = await text(page.locator(".pay-receipt__verify-url"));
  check(verifyUrl.startsWith(`${BASE}/payment/verify?r=${encodeURIComponent(r["Receipt number"])}&v=`), "receipt: the verification link is printed under the QR", verifyUrl);
  check((await page.evaluate(() => window.__printed)) === 0, "receipt: nothing printed without print=1");
  await page.locator(".pay-receipt-toolbar button", { hasText: /^Print$/ }).click();
  check((await page.evaluate(() => window.__printed)) === 1, "receipt: Print calls window.print()");
  await page.locator(".pay-receipt-toolbar button", { hasText: /Download PDF/ }).click();
  check((await page.evaluate(() => window.__printed)) === 2, "receipt: Download PDF calls window.print() (Save as PDF)");
  check(/Save as PDF/.test(await text(page.locator(".pay-receipt-toolbar__hint"))), "receipt: the Save-as-PDF hint");
  check((await page.locator(".pay-receipt-page__email button", { hasText: /Email it to/ }).count()) === 1, "receipt: the email-receipt button");
  check(!(await overflow(page)), "receipt: no horizontal overflow");
  const rv = await axe(page);
  check(rv.length === 0, "receipt: axe serious/critical violations", rv.join("\n      "));
  await shot(page, "receipt-screen-1440");

  await page.emulateMedia({ media: "print" });
  await page.waitForTimeout(200);
  const printed = await page.evaluate(() => {
    const out = {};
    for (const s of [".skip-link", ".pulse-strip", ".navbar", ".footer", ".bottom-nav", ".fab-group", ".pay-receipt-toolbar", ".pay-receipt-page__email", ".pay-banner .alert__close", ".pay-receipt", ".pay-receipt__verify svg"]) {
      const el = document.querySelector(s);
      out[s] = el ? getComputedStyle(el).display : "absent";
    }
    return out;
  });
  const chromeHidden = Object.entries(printed).filter(([k]) => k !== ".pay-receipt" && k !== ".pay-receipt__verify svg" && k !== ".pay-banner .alert__close").every(([, d]) => d === "none" || d === "absent");
  check(chromeHidden, "print: header, footer, nav, floating buttons and the toolbar are display:none", JSON.stringify(printed));
  check(printed[".pay-receipt"] !== "none" && printed[".pay-receipt__verify svg"] !== "none", "print: the receipt and its QR code stay visible");
  check(printed[".navbar"] === "none" && printed[".footer"] === "none" && printed[".pay-receipt-toolbar"] === "none", "print: the three main chrome pieces are gone (not merely absent)");
  await shot(page, "receipt-print-1440");
  await page.emulateMedia({ media: null });

  await page.goto(`${BASE}/payment/receipt?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}&print=1`, { waitUntil: "domcontentloaded" });
  await page.locator(".pay-receipt").waitFor();
  await page.waitForTimeout(900);
  check((await page.evaluate(() => window.__printed)) === 1, "receipt?print=1 prints once after rendering");

  // Verification by QR link.
  await page.goto(verifyUrl, { waitUntil: "domcontentloaded" });
  await page.locator(".pay-result__title").waitFor();
  check((await text(page.locator(".pay-result__title"))) === "This receipt is genuine", "verify: a genuine receipt");
  const vf = await facts(page, ".pay-result__facts");
  check(vf["Receipt number"] === r["Receipt number"] && vf["Amount"] === "₹5,000 (INR)" && vf["Purpose"] === "Temple Development", "verify: number, amount and purpose", JSON.stringify(vf));
  check(vf["Donor"] === "Anonymous devotee", "verify: an anonymous donor is not named");
  check((await page.locator("h1").count()) === 1, "verify: one h1");
  await shot(page, "verify-1440");
  await page.goto(`${BASE}/payment/verify?r=${encodeURIComponent(r["Receipt number"])}&v=aaaaaaaaaa`, { waitUntil: "domcontentloaded" });
  await page.locator(".pay-result__title").waitFor();
  check((await text(page.locator(".pay-result__title"))) === "We could not verify this receipt", "verify: a forged token is refused");
  check(page.errors().length === 0, "receipt and verify pages: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();

  // The same pages on a phone.
  const phone = await newPage({ width: 390, height: 844 });
  await phone.goto(`${BASE}/payment/result?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await phone.locator(".pay-result__title").filter({ hasText: /Thank you/ }).waitFor();
  check(!(await overflow(phone)), "success @390: no horizontal overflow");
  await shot(phone, "result-success-390");
  await phone.goto(`${BASE}/payment/receipt?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await phone.locator(".pay-receipt").waitFor();
  check(!(await overflow(phone)), "receipt @390: no horizontal overflow");
  await shot(phone, "receipt-screen-390");
  await phone.emulateMedia({ media: "print" });
  await phone.waitForTimeout(200);
  await shot(phone, "receipt-print-390");
  await phone.emulateMedia({ media: null });
  await phone.goto(verifyUrl, { waitUntil: "domcontentloaded" });
  await phone.locator(".pay-result__title").waitFor();
  check(!(await overflow(phone)), "verify @390: no horizontal overflow");
  await shot(phone, "verify-390");
  check(phone.errors().length === 0, "phone result/receipt/verify: no console errors", phone.errors().slice(0, 3).join(" | "));
  await phone.context().close();

  return { number, ref, token };
}

async function declineAndRetry() {
  section("Decline, then try again");
  const page = await newPage();
  const sim = await startDonation(page, { category: "annadanam", amount: 1000 });
  const number = sim["Order ID"];
  await simulatorPress(page, "decline");
  const title = page.locator(".pay-result__title");
  await title.filter({ hasText: /Payment unsuccessful/ }).waitFor();
  check(/unable to complete/.test(await text(page.locator(".pay-result__lead"))), "failed: the sentence");
  check((await text(page.locator(".pay-result__reason"))) === "Simulated decline by the bank", "failed: the gateway's failure message");
  const f = await facts(page, ".pay-result__facts");
  check(f["Payment status"] === "Failed" && f["Amount"] === "₹1,000 (INR)", "failed: status badge and amount", JSON.stringify(f));
  check((await page.locator("button", { hasText: /^Try again$/ }).count()) === 1, "failed: Try again");
  check((await page.locator("button", { hasText: /Choose another payment method/ }).count()) === 1, "failed: Choose another payment method");
  check((await page.locator('a[href="/contact"]', { hasText: /Contact support/ }).count()) === 1, "failed: Contact support");
  check(/UPI, card or net banking/.test(await text(page.locator(".pay-result").first())), "failed: explains CCAvenue's page lets them pick a method");
  check((await sessionItem(page, "temple:donation-draft")) !== null, "failed: the draft is kept");
  check(!(await overflow(page)), "failed: no horizontal overflow");
  await shot(page, "result-failed-1440");
  const { ref, t: token } = refOf(page.url());

  await page.locator("button", { hasText: /Choose another payment method/ }).click();
  const again = await awaitHandoff(page);
  check(again.title === "Redirecting securely to CCAvenue…", "try again: the hand-off card on the result page");
  const sim2 = await simulatorFacts(page);
  check(sim2["Order ID"] === `${number}-R2`, "try again: a second attempt with the -R2 order id", sim2["Order ID"]);
  check(sim2.Amount === "1000.00", "try again: the same server-side amount");
  await simulatorPress(page, "card");
  await title.filter({ hasText: /Thank you for your contribution/ }).waitFor();
  const f2 = await facts(page, ".pay-result__facts");
  check(f2["Donation ID"] === number && f2["Payment mode"] === "Credit Card" && /^SIM-/.test(f2["Receipt number"] ?? ""), "try again: the retry succeeded on the same donation", JSON.stringify(f2));
  const attempts = sql("SELECT attempt, order_id, status FROM payment_transactions WHERE order_id IN (?, ?) ORDER BY attempt", [number, `${number}-R2`]);
  check(attempts.length === 2 && attempts[0].status === "FAILED" && attempts[1].status === "SUCCESS", "DB: attempt 1 FAILED, attempt 2 SUCCESS", JSON.stringify(attempts));
  check(page.errors().length === 0, "decline/retry: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();

  const phone = await newPage({ width: 390, height: 844 });
  // Show the failed page again on a phone through the retry's own number.
  await phone.goto(`${BASE}/payment/result?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await phone.locator(".pay-result__title").waitFor();
  check(!(await overflow(phone)), "result @390: no horizontal overflow");
  await phone.context().close();
}

async function cancelKeepsDraft() {
  section("Cancel at the gateway");
  const page = await newPage();
  const sim = await startDonation(page, { category: "general", preset: 2500 });
  const number = sim["Order ID"];
  await simulatorPress(page, "cancel");
  const title = page.locator(".pay-result__title");
  await title.filter({ hasText: /Payment cancelled/ }).waitFor();
  check(/No money was taken/.test(await text(page.locator(".pay-result__lead"))), "cancelled: 'No money was taken'");
  const f = await facts(page, ".pay-result__facts");
  check(f["Payment status"] === "Cancelled" && f["Donation ID"] === number, "cancelled: status and number", JSON.stringify(f));
  check((await page.locator("button", { hasText: /^Try again$/ }).count()) === 1, "cancelled: Try again");
  await shot(page, "result-cancelled-1440");
  check(sql("SELECT status FROM donations WHERE donation_number = ?", [number])[0]?.status === "CANCELLED", "DB: the donation is CANCELLED");
  await page.locator("a", { hasText: /Return to the donation page/ }).click();
  await page.waitForURL(/\/donate\?step=review/);
  await stepTitle(page).filter({ hasText: /Review/ }).waitFor();
  check((await text(page.locator(".don-total__value"))) === "₹2,500" && (await facts(page, ".don-review__list"))["Full name"] === DONOR, "return: the draft is still there on the review step");

  // The cancel URL with nothing to decrypt, and a stranger with no reference.
  await page.goto(`${BASE}/payment/result?state=cancelled`, { waitUntil: "domcontentloaded" });
  await page.locator(".pay-result__title").waitFor();
  check((await text(page.locator(".pay-result__title"))) === "Payment cancelled", "state=cancelled without a number: the cancelled card");
  check((await page.locator("button", { hasText: /^Try again$/ }).count()) === 1, "state=cancelled: Try again is offered because the last payment is known");
  await page.goto(`${BASE}/payment/result?state=unknown`, { waitUntil: "domcontentloaded" });
  await page.locator(".pay-result__title").waitFor();
  check((await text(page.locator(".pay-result__title"))) === "We could not read the payment result", "state=unknown: the 'could not read' card");
  check(/confirmed or returned automatically/.test(await text(page.locator(".pay-result__lead"))), "state=unknown: the reassurance about money");
  check(page.errors().length === 0, "cancel: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();

  const stranger = await newPage();
  stranger.allowErrors(/status of 404/);
  await stranger.goto(`${BASE}/payment/result?ref=${encodeURIComponent(number)}&t=not-the-token-at-all`, { waitUntil: "domcontentloaded" });
  await stranger.locator(".pay-result__title").waitFor();
  check((await text(stranger.locator(".pay-result__title"))) === "We could not read the payment result", "a wrong token shows nothing about the payment");
  check((await stranger.locator("button", { hasText: /^Try again$/ }).count()) === 0, "a stranger gets no Try again");
  check(stranger.errors().length === 0, "wrong token: no console errors (fetch, not axios)", stranger.errors().slice(0, 3).join(" | "));
  await stranger.context().close();
}

async function awaitedThenConfirmed() {
  section("Awaited, then confirmed by the sweep");
  const page = await newPage();
  const sim = await startDonation(page, { category: "festival", amount: 1500 });
  const number = sim["Order ID"];
  await simulatorPress(page, "awaited");
  const title = page.locator(".pay-result__title");
  await title.filter({ hasText: /Confirming your payment/ }).waitFor();
  check((await page.locator(".pay-result__spinner").count()) === 1, "pending: a spinner");
  check(/updates by itself/.test(await text(page.locator(".pay-result__lead"))), "pending: says the page updates by itself");
  check((await facts(page, ".pay-result__facts"))["Payment status"] === "Confirming", "pending: status badge reads Confirming");
  await shot(page, "result-pending-1440");
  check(sql("SELECT status FROM payment_transactions WHERE order_id = ?", [number])[0]?.status === "PENDING", "DB: the attempt is PENDING");

  // The bank confirms: the simulator now reports success and the sweep asks it.
  sql("UPDATE payment_counters SET value = 1 WHERE name = ?", [`sim:${number}`]);
  const sweep = fixtures("sweep", { order_ids: [number] });
  check(sweep.sweep?.changed >= 1, "sweep: the status API upgraded the attempt", JSON.stringify(sweep).slice(0, 200));
  await title.filter({ hasText: /Thank you for your contribution/ }).waitFor({ timeout: 25000 });
  check(true, "pending: the page polled its way to the success view");
  // PaymentResult empties its live region and writes the sentence on the next
  // animation frame (so a repeated message is spoken again), which is after
  // the heading has changed: wait for that write rather than reading the
  // region the moment the heading appears, when it is still empty.
  const announcedPaid = await page
    .waitForFunction(() => /confirmed/.test([...document.querySelectorAll(".sr-only[role='status']")].pop()?.textContent ?? ""), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(announcedPaid, "pending → success is announced to screen readers", await text(page.locator(".sr-only[role='status']").last()));
  check(/^SIM-/.test((await facts(page, ".pay-result__facts"))["Receipt number"] ?? ""), "pending → success: the receipt number appears");
  const att = sql("SELECT status, verification FROM payment_transactions WHERE order_id = ?", [number])[0];
  check(att?.status === "SUCCESS" && att.verification === "status_api", "DB: SUCCESS verified by the status API", JSON.stringify(att));
  check(page.errors().length === 0, "awaited: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();
}

async function tamilAndPhone() {
  section("Tamil, and the phone layout");
  const page = await newPage({ width: 390, height: 844, lang: "ta" });
  await openDonate(page);
  check((await text(page.locator("h1"))) === "இணையவழி நன்கொடை", "ta: the page title");
  check((await text(stepTitle(page))) === "நோக்கமும் தொகையும்", "ta: step 1 heading");
  check(/படி 1 \/ 3/.test(await text(page.locator(".form-stepper__compact"))), "ta @390: the compact stepper line");
  check((await text(nextBtn(page))) === "அடுத்து", "ta: the Next button");
  check((await page.locator(".don-actions--dock").isVisible()) && !(await page.locator(".don-actions--inline").isVisible()), "@390: the actions dock above the bottom navigation");
  await nextBtn(page).click();
  await page.locator(".form-summary").waitFor();
  check(/தொடர்வதற்கு முன்/.test(await text(page.locator(".form-summary__title"))), "ta: the error summary title");
  await shot(page, "donate-errors-390-ta");
  await pickCategory(page, "temple_development");
  await pickPreset(page, 5000);
  check(/வழங்குகிறீர்கள்/.test(await text(page.locator(".don-summary"))), "ta: the live summary sentence");
  check(/₹5,000 · /.test(await text(page.locator(".don-actions__summary"))), "@390: the dock shows the amount and purpose", await text(page.locator(".don-actions__summary")));
  check(!(await overflow(page)), "ta @390 step 1: no horizontal overflow");
  await shot(page, "donate-step1-390-ta");
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /உங்கள் விவரங்கள்/ }).waitFor();
  check(true, "ta: step 2 heading");
  await fillDetails(page, { email: "" });
  check(!(await overflow(page)), "ta @390 step 2: no horizontal overflow");
  await shot(page, "donate-step2-390-ta");
  await nextBtn(page).click();
  await stepTitle(page).filter({ hasText: /சரிபார்த்துப் பணம் செலுத்தவும்/ }).waitFor();
  check((await text(nextBtn(page))) === "பணம் செலுத்தத் தொடரவும்", "ta: the Proceed button");
  check(/விதிமுறைகளையும்/.test(await text(page.locator(".don-terms"))), "ta: the terms sentence");
  check(!(await overflow(page)), "ta @390 review: no horizontal overflow");
  await shot(page, "donate-review-390-ta");

  // Switching the language in place keeps the step and the data.
  await page.locator('.lang-toggle__btn[lang="en"]').first().click();
  await stepTitle(page).filter({ hasText: /Review and pay/ }).waitFor();
  check((await facts(page, ".don-review__list"))["Full name"] === DONOR && (await text(page.locator(".don-total__value"))) === "₹5,000", "en after ta: the step and the draft survive the language switch");
  await shot(page, "donate-review-390");
  await page.locator('button[aria-label="Edit your details"]').click();
  await stepTitle(page).filter({ hasText: /Your details/ }).waitFor();
  await shot(page, "donate-step2-390");
  check(page.errors().length === 0, "ta/phone: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();
}

async function sevaOnline() {
  section("Seva dialog: pay online");
  const page = await newPage();
  await page.goto(`${BASE}/sevas`, { waitUntil: "domcontentloaded" });
  const card = page.locator(".seva-card").first();
  await card.locator(".seva-card__book").waitFor();
  const shownPrice = (await text(card.locator(".seva-card__amount"))).replace(/[^\d.]/g, "");
  const sevaName = await text(card.locator(".seva-card__name"));
  await card.locator(".seva-card__book").click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await dialog.locator("fieldset.pay-choice").waitFor();
  check((await dialog.locator("fieldset.pay-choice").count()) === 1, "dialog: the pay-now / request radio group");
  check((await dialog.locator('input[name="payChoice"]').count()) === 2, "dialog: two choices");
  check(await dialog.locator('input[name="payChoice"][value="online"]').isChecked(), "dialog: pay online is the default");
  check((await dialog.locator('button[type="submit"]').count()) === 1, "dialog: exactly one submit button");
  const expected = `Pay ₹${Number(shownPrice).toLocaleString("en-IN")} securely`;
  check((await text(dialog.locator('button[type="submit"]'))) === expected, "dialog: the submit label carries the price", `${await text(dialog.locator('button[type="submit"]'))} vs ${expected}`);
  check((await dialog.locator("#booking-email").count()) === 1, "dialog: the optional email field");
  check((await dialog.locator("#booking-accept-terms").count()) === 1, "dialog: the terms checkbox");
  await dialog.locator('button[type="submit"]').click();
  await page.waitForTimeout(300);
  check((await dialog.locator('[role="alert"]').count()) >= 2, "dialog: empty submit shows the errors (name, phone, terms)");
  await dialog.locator('input[name="devotee_name"]').fill(DEVOTEE);
  await dialog.locator('input[name="phone"]').fill("9876512346");
  await dialog.locator("#booking-email").fill(EMAIL);
  await dialog.locator("#booking-accept-terms").check();
  await shot(page, "sevas-dialog-1440");
  let posted = null;
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/payments\/seva-bookings$/.test(r.url())) posted = r.postDataJSON();
  });
  await dialog.locator('button[type="submit"]').click();
  const seen = await awaitHandoff(page, {
    shotName: "sevas-redirecting-1440",
    before: async (p, s) => {
      s.inDialog = await p
        .locator('[role="dialog"] .pay-redirect__title')
        .waitFor({ state: "attached", timeout: 2000 })
        .then(() => 1)
        .catch(() => 0);
    },
  });
  const sim = await simulatorFacts(page);
  check(seen.inDialog === 1 && seen.title === "Redirecting securely to CCAvenue…", "dialog: the hand-off card appears inside the dialog");
  check(posted && posted.seva_id && posted.acceptTerms === true && posted.lang === "en" && !("amount" in posted), "dialog: posts seva_id, terms and lang — never an amount", JSON.stringify(posted));
  check(/^SEV-\d{8}-\d{8}$/.test(sim["Order ID"] ?? ""), "seva: the order id is the booking number", sim["Order ID"]);
  check(sim.Amount === Number(shownPrice).toFixed(2) && sim.Currency === "INR", "seva: the gateway got the server's price in INR", `${sim.Amount} ${sim.Currency}`);
  const number = sim["Order ID"];
  await simulatorPress(page, "upi");
  await page.locator(".pay-result__title").filter({ hasText: /Payment received for your seva/ }).waitFor();
  check(/will call you to confirm the date/.test(await text(page.locator(".pay-result__lead"))), "seva success: the office will call");
  const f = await facts(page, ".pay-result__facts");
  check(f["Booking ID"] === number && f["Seva"] === sevaName && /^SIM-/.test(f["Receipt number"] ?? ""), "seva success: Booking ID, Seva and receipt number", JSON.stringify(f));
  await shot(page, "result-seva-1440");
  const row = sql("SELECT payment_mode, payment_status, status, amount, currency, receipt_number FROM seva_bookings WHERE order_number = ?", [number])[0];
  check(row?.payment_mode === "online" && row.payment_status === "SUCCESS" && row.status === "pending" && Number(row.amount) === Number(shownPrice), "DB: paid online, booking still pending for the office", JSON.stringify(row));
  await page.locator(".pay-result__actions a", { hasText: /Download receipt/ }).click();
  await page.locator(".pay-receipt").waitFor();
  check((await text(page.locator("h1"))) === "Seva payment receipt" && (await facts(page, ".pay-receipt__list"))["Seva"] === sevaName, "seva receipt: title and seva name");
  check(page.errors().length === 0, "seva online: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();
}

async function sevaRequest() {
  section("Seva dialog: the request path is unchanged");
  const page = await newPage();
  await page.goto(`${BASE}/sevas`, { waitUntil: "domcontentloaded" });
  await page.locator(".seva-card__book").first().waitFor();
  await page.locator(".seva-card__book").first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await dialog.locator('.pay-choice__option:has(input[value="request"])').click();
  check((await dialog.locator('button[type="submit"]').count()) === 1, "request: still one submit button");
  check((await text(dialog.locator('button[type="submit"]'))) === "Submit Booking", "request: the submit label is the old one");
  check((await dialog.locator("#booking-email").count()) === 0 && (await dialog.locator("#booking-accept-terms").count()) === 0, "request: no email field, no terms tick");
  let posted = null;
  let url = "";
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/seva-bookings$/.test(r.url())) {
      url = r.url();
      posted = r.postDataJSON();
    }
  });
  await dialog.locator('input[name="devotee_name"]').fill(DEVOTEE);
  await dialog.locator('input[name="phone"]').fill("9876512347");
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator("#booking-success-title").waitFor();
  check(/received|பெறப்பட்டது/i.test(await text(dialog)), "request: the booking is received (real API)");
  check(/\/api\/seva-bookings$/.test(url) && posted?.lang === "en" && posted?.hp_token === "", "request: POST /api/seva-bookings with lang", JSON.stringify(posted));
  const row = sql("SELECT payment_mode, payment_status, status FROM seva_bookings WHERE devotee_name = ? ORDER BY id DESC LIMIT 1", [DEVOTEE])[0];
  check(row?.payment_mode === "offline" && row.payment_status === null && row.status === "pending", "DB: an offline request with no payment status", JSON.stringify(row));
  check(page.errors().length === 0, "seva request: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();
}

async function policyPages() {
  section("Policy pages");
  const page = await newPage();
  for (const path of ["/privacy-policy", "/terms-and-conditions", "/refund-cancellation-policy", "/shipping-delivery-policy"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.locator("h1").first().waitFor();
    await page.locator(".policy-toc").waitFor();
    check((await page.locator("h1").count()) === 1, `${path}: exactly one h1`);
    check((await page.locator(".policy-toc__chip").count()) >= 3, `${path}: a table of contents`);
    check((await page.locator(".footer__legal a").count()) === 4, `${path}: four legal links in the footer`);
  }
  check(page.errors().length === 0, "policies: no console errors", page.errors().slice(0, 3).join(" | "));
  await page.context().close();
}

/* ── Main ───────────────────────────────────────────────────────────────── */

let php = null;
let vite = null;
let countersBefore = {};
let receiptsMine = 0;

try {
  section("Preflight");
  for (const [port, host] of [[PHP_PORT, "127.0.0.1"], [VITE_PORT, "127.0.0.1"], [VITE_PORT, "::1"]]) {
    if (await portInUse(port, host)) {
      console.log(`✗ port ${port} (${host}) is already in use — stop whatever holds it (never the user's :8000/:5173)`);
      process.exit(2);
    }
  }
  const before = cleanup();
  console.log(`  cleanup at start: ${JSON.stringify(before)}`);
  countersBefore = countersNow();

  php = startPhp();
  check(await waitForUrl(`${PHP_BASE}/api/pulse`), `PHP answers on ${PHP_BASE}`, php.log.slice(-400));
  const cfg = await fetch(`${PHP_BASE}/api/payments/config`).then((r) => r.json()).catch(() => null);
  check(cfg?.enabled === true && cfg.ready === true && cfg.simulator === true && cfg.sevaOnline === true && cfg.international === true, "the test server runs the simulator with seva payments and international on", JSON.stringify(cfg).slice(0, 300));
  if (!cfg?.ready) throw new Error("payments are not ready on the test server; nothing else can run");

  vite = startVite();
  check(await waitForUrl(`${BASE}/`), `Vite answers on ${BASE}`, vite.log.slice(-400));
  const viaProxy = await fetch(`${BASE}/api/payments/config`).then((r) => r.json()).catch(() => null);
  check(viaProxy?.simulator === true, "the test Vite proxies /api to the test PHP");

  browser = await chromium.launch();

  // Warm the lazy routes once so the first real scenario is not the one paying for compilation.
  const warm = await newPage();
  for (const path of ["/donate", "/payment/result?state=unknown", "/payment/receipt", "/payment/verify", "/sevas", "/donations", "/privacy-policy", "/"]) {
    await warm.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await warm.locator("h1, .pay-receipt-missing__title").first().waitFor().catch(() => {});
  }
  await warm.context().close();

  await scenario("widths", "/donate at four widths", donateAtWidths);
  await scenario("closed", "When payments are off", closedState);
  await scenario("donations", "/donations with payments on", donationsPage);
  await scenario("purpose", "Step 1", purposeStep);
  await scenario("success", "Success flow", successFlow);
  await scenario("decline", "Decline and retry", declineAndRetry);
  await scenario("cancel", "Cancel", cancelKeepsDraft);
  await scenario("awaited", "Awaited", awaitedThenConfirmed);
  await scenario("tamil", "Tamil and phone", tamilAndPhone);
  await scenario("seva", "Seva online", sevaOnline);
  await scenario("request", "Seva request", sevaRequest);
  await scenario("policies", "Policy pages", policyPages);

  section("Secrets");
  const leak = sql(
    "SELECT COUNT(*) AS n FROM payment_audit_log WHERE (detail LIKE ? OR data LIKE ?) AND created_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR",
    ["%simulator-working-key%", "%simulator-working-key%"],
  )[0];
  check(Number(leak?.n) === 0, "the simulator working key appears in no audit row written this hour");
  const mine = sql("SELECT COUNT(*) AS n FROM donations WHERE name LIKE ? AND receipt_number IS NOT NULL", [`${NAME_PREFIX}%`])[0];
  const mineSeva = sql("SELECT COUNT(*) AS n FROM seva_bookings WHERE devotee_name LIKE ? AND receipt_number IS NOT NULL", [`${NAME_PREFIX}%`])[0];
  receiptsMine = Number(mine?.n ?? 0) + Number(mineSeva?.n ?? 0);
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
    const left = sql("SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?) AS n", [`${NAME_PREFIX}%`, `${NAME_PREFIX}%`])[0];
    check(Number(left?.n) === 0, "no rows of this suite are left behind", JSON.stringify(left));
    // Put the receipt counter back when nobody else advanced it meanwhile.
    const countersAfter = countersNow();
    for (const [name, value] of Object.entries(countersAfter)) {
      const was = countersBefore[name];
      if (was === undefined && value === receiptsMine) {
        sql("DELETE FROM payment_counters WHERE name = ?", [name]);
        console.log(`  ${name} removed (only this run used it)`);
      } else if (was !== undefined && value - was === receiptsMine) {
        sql("UPDATE payment_counters SET value = ? WHERE name = ?", [was, name]);
        console.log(`  ${name} put back to ${was}`);
      } else {
        console.log(`  ${name} left at ${value} (was ${was ?? "absent"}; ${receiptsMine} receipts were ours)`);
      }
    }
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
