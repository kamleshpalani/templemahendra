#!/usr/bin/env node
/**
 * tests/notify-prefs-ui.mjs — the devotee's notification settings, push on this
 * device, and mobile number verification, in a real browser against the real
 * Vite dev server, PHP API and MySQL (docs/notifications/SPEC.md §6.1, §6.5, §7.4).
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
 *     node tests/notify-prefs-ui.mjs [http://localhost:5173]
 *
 *   SKIP_BUILD=1   skips the production-build check at the end (about a minute)
 *
 * What it proves:
 *   • /account?tab=notifications opens the tab directly, and ?tab= works for
 *     every tab, replaces history (Back leaves the page) and drops a bad value;
 *   • channel and topic switches save, survive a reload, and match GET prefs;
 *   • security and booking topics are locked "Always on" and cannot be muted,
 *     not even by posting them to the API;
 *   • language, time zone (the browser's zone offered first) and promotional
 *     consent save; consent is off by default;
 *   • unsaved changes are guarded when switching tabs;
 *   • an unavailable channel says why and links to the fix;
 *   • push: under vite dev the page explains the inactive service worker; with
 *     the Push API mocked it subscribes (never prompting on load), registers the
 *     device, unsubscribes and removes it; a denied permission explains how to
 *     fix it; iOS outside a home-screen app says to install it;
 *   • phone verification end to end, reading the code from backend/logs/notify.log;
 *   • the sticky save bar at 390 px, no horizontal overflow at 390/768/1440,
 *     axe with no serious or critical violations, no console errors;
 *   • public/push-sw.js behaves (run in a Node sandbox), and a production build
 *     loads it from the generated sw.js.
 *
 * Devotees come from tests/support/notify_fixtures.php (sign-up is rate limited)
 * and sign in through /api/auth/login. Every browser context sends its own
 * X-Forwarded-For in 10.42.x.x. Data: devotees e2e-nprefs-<run>-*@example.test,
 * removed (with everything that cascades from them and their rate-limit buckets)
 * at the start and at the end.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(resolve(ROOT, "frontend/node_modules/axe-core/axe.min.js"), "utf8");

const BASE = (process.argv[2] || "http://localhost:5173").replace(/\/$/, "");
const PHP_BIN = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const EMAIL_PREFIX = "e2e-nprefs-";
const PASSWORD = "Kolam99Deep";
const SHOTS = resolve(ROOT, "shots/notify-prefs");
const BUILD_OUT = "C:/Users/nithp/AppData/Local/Temp/claude/build-prefs";
mkdirSync(SHOTS, { recursive: true });

const ip = (n) => `10.42.${n}.${n}`;

let passed = 0;
const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (title) => console.log(`\n── ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const threw = (label, e) => check(false, `${label} (scenario threw)`, String(e?.message || e).split("\n")[0].slice(0, 240));

/* ── PHP fixtures ───────────────────────────────────────────────────────── */

const viaBash = PHP_BIN.endsWith(".sh");
/** JSON for argv: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

function fixtures(cmd, obj = {}) {
  const args = ["tests/support/notify_fixtures.php", cmd, arg(obj)];
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`fixtures ${cmd} printed no JSON (exit ${r.status}): ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
  }
}
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}

/** Delete this suite's devotees (everything cascades) and the rate-limit buckets they and our addresses used. */
function cleanup() {
  const ids = sql("SELECT id FROM devotees WHERE email LIKE ?", [`${EMAIL_PREFIX}%`]).map((r) => Number(r.id));
  for (const id of ids) {
    sql("DELETE FROM rate_limits WHERE bucket IN (?, ?, ?, ?)", [
      `notif-post:d${id}`,
      `otp-issue-15m:d${id}`,
      `otp-issue-day:d${id}`,
      `otp-confirm:d${id}`,
    ]);
  }
  sql("DELETE FROM rate_limits WHERE bucket LIKE ?", ["%:10.42.%"]);
  const r = fixtures("cleanup", { email_prefix: EMAIL_PREFIX });
  if (r.error) throw new Error(`cleanup: ${r.error}`);
  return r.deleted_devotees;
}

let phoneSeq = 0;
function createDevotee(tag, extra = {}) {
  const r = fixtures("create-devotee", {
    email: `${EMAIL_PREFIX}${RUN}-${tag}@example.test`,
    password: PASSWORD,
    name: `E2E-NPREFS ${tag}`,
    verified: true,
    ...extra,
  });
  if (!r.id) throw new Error(`could not create devotee ${tag}: ${JSON.stringify(r)}`);
  return { id: Number(r.id), email: r.email, phone: extra.phone ?? null };
}
/** A unique Indian mobile number for this run, as stored: country code and digits. */
function uniquePhone() {
  phoneSeq += 1;
  return `9197${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, "0")}`;
}

/** The newest one-time code sent by SMS/WhatsApp to +<digits>, from the log driver's file. */
function codeFromLog(digits) {
  const file = resolve(ROOT, "backend/logs/notify.log");
  if (!existsSync(file)) return null;
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const blocks = buf.toString("utf8").split("===== ").filter((b) => b.includes(`\nTo: +${digits}\n`));
    const last = blocks.pop();
    if (!last) return null;
    const afterTitle = last.slice(last.indexOf("\nTitle:"));
    const body = afterTitle.slice(afterTitle.indexOf("\n", 1));
    return body.match(/(?<!\d)(\d{6})(?!\d)/)?.[1] ?? null;
  } finally {
    closeSync(fd);
  }
}

/* ── Browser ────────────────────────────────────────────────────────────── */

const browser = await chromium.launch();
const IGNORE =
  /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js|React Router Future Flag/;

async function newPage({ width = 1440, height = 900, address, timezoneId = "Asia/Kolkata", userAgent, push } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN", timezoneId, userAgent });
  // X-Forwarded-For only on requests to the site itself. As a context-wide
  // extra header it also rides on the Google Fonts requests, where it forces a
  // CORS preflight that fonts.gstatic.com refuses — a console error the page
  // never causes for a real visitor.
  const origin = new URL(BASE).origin;
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin !== origin) return route.continue();
    return route.continue({ headers: { ...req.headers(), "x-forwarded-for": address } });
  });
  if (push) await ctx.addInitScript(installPushMock, push);
  const page = await ctx.newPage();
  const errors = [];
  const allowed = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()} @ ${m.location()?.url ?? ""}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!IGNORE.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`);
  });
  // A 4xx the scenario provokes on purpose (a wrong code) is logged by the
  // browser and by the API client; those, and only those, are expected.
  page.allowErrors = (re) => allowed.push(re);
  page.errors = () => errors.filter((e) => !IGNORE.test(e) && !allowed.some((re) => re.test(e)));
  page.address = address;
  return page;
}

/** Runs in the page before any script: a Push API that behaves like Chrome's, under test control. */
function installPushMock(opts) {
  const state = { permission: opts.permission || "default", next: opts.next || "granted", sub: null, prompts: 0, subscribeCalls: 0, unsubscribes: 0 };
  window.__pushMock = state;
  const makeSub = (key) => ({
    endpoint: opts.endpoint,
    expirationTime: null,
    options: { applicationServerKey: key, userVisibleOnly: true },
    toJSON: () => ({ endpoint: opts.endpoint, expirationTime: null, keys: { p256dh: opts.p256dh, auth: opts.auth } }),
    unsubscribe: async () => {
      state.sub = null;
      state.unsubscribes += 1;
      return true;
    },
  });
  const pushManager = {
    getSubscription: async () => state.sub,
    subscribe: async (o) => {
      state.subscribeCalls += 1;
      state.userVisibleOnly = o.userVisibleOnly;
      state.keyLength = o.applicationServerKey ? o.applicationServerKey.byteLength : 0;
      state.sub = makeSub(o.applicationServerKey);
      return state.sub;
    },
  };
  const reg = { active: { state: "activated" }, scope: location.origin + "/", pushManager };
  const sw = {
    getRegistration: async () => reg,
    ready: Promise.resolve(reg),
    register: async () => reg,
    addEventListener() {},
    removeEventListener() {},
    controller: null,
  };
  Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get: () => sw });
  window.PushManager = function PushManager() {};
  function FakeNotification() {}
  Object.defineProperty(FakeNotification, "permission", { get: () => state.permission });
  FakeNotification.requestPermission = async () => {
    state.prompts += 1;
    state.permission = state.next;
    return state.permission;
  };
  window.Notification = FakeNotification;
}

/** Sign in through the real endpoint, in the page's own cookie jar. */
/* page.request shares the page's cookies but not its routes, so each call names the address itself. */
const xff = (page) => ({ "X-Forwarded-For": page.address });

async function signIn(page, email) {
  const c = await page.request.get(`${BASE}/api/auth/csrf`, { headers: xff(page) });
  const { csrf } = await c.json();
  const r = await page.request.post(`${BASE}/api/auth/login`, {
    data: { email, password: PASSWORD },
    headers: { ...xff(page), "X-CSRF-Token": csrf },
  });
  if (r.status() !== 200) throw new Error(`sign-in failed for ${email}: ${r.status()} ${(await r.text()).slice(0, 200)}`);
}

async function apiGet(page, path) {
  const r = await page.request.get(`${BASE}/api${path}`, { headers: xff(page) });
  return { status: r.status(), json: await r.json().catch(() => null) };
}
async function apiPost(page, path, data) {
  const c = await page.request.get(`${BASE}/api/auth/csrf`, { headers: xff(page) });
  const { csrf } = await c.json();
  const r = await page.request.post(`${BASE}/api${path}`, { data, headers: { ...xff(page), "X-CSRF-Token": csrf } });
  return { status: r.status(), json: await r.json().catch(() => null) };
}

/**
 * Navigate, then switch the interface to English. The site opens in Tamil and
 * keeps the choice in React state only, so it resets on every full load.
 */
async function go(page, path) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  const en = page.locator('.lang-toggle__btn[lang="en"]');
  if (await en.count()) {
    await en.first().click();
    await page.waitForTimeout(250);
  }
}
async function openPrefs(page) {
  await go(page, "/account?tab=notifications");
  await page.waitForSelector(".np-savebar", { timeout: 15000 });
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

async function axe(page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const res = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] },
    });
    return res.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
  });
}

const selectedTab = (page) => page.locator('[role="tab"][aria-selected="true"]').innerText();
const row = (page, attr, key) => page.locator(`.np-row[data-${attr}="${key}"]`);
const switchIn = (locator) => locator.locator('input[role="switch"]');
const flip = (locator) => locator.locator("label.switch").click();
const saveStatus = (page) => page.locator(".np-savebar__status").innerText();

async function saveAndWait(page) {
  const saveBtn = page.locator('.np-savebar button[type="submit"]');
  await saveBtn.click();
  await page.waitForSelector(".toast--success", { timeout: 10000 });
  await page.waitForFunction(() => /All changes saved/.test(document.querySelector(".np-savebar__status")?.textContent ?? ""), null, {
    timeout: 10000,
  });
}

const prefsOf = async (page) => (await apiGet(page, "/notifications/prefs")).json;

/* ── Setup ──────────────────────────────────────────────────────────────── */

console.log(`run ${RUN} against ${BASE}`);
const leftover = cleanup();
if (leftover) console.log(`  removed ${leftover} devotee(s) left by an earlier run`);

const A = createDevotee("main", { phone: uniquePhone() });
const B = createDevotee("nophone");
const P = createDevotee("push", { phone: uniquePhone() });
const O = createDevotee("otp", { phone: uniquePhone() });

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const PUSH_KEYS = { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) };

/* ── 1. Direct link, toggles, reload ────────────────────────────────────── */
section("1. /account?tab=notifications, channels and topics save and survive a reload");
try {
  const page = await newPage({ address: ip(1), timezoneId: "Europe/London" });
  await signIn(page, A.email);
  await openPrefs(page);

  check((await selectedTab(page)).includes("Notifications"), "?tab=notifications opens the Notifications tab", await selectedTab(page));
  check(page.url().endsWith("/account?tab=notifications"), "and the address keeps the tab", page.url());
  check((await page.locator(".np-row[data-channel]").count()) === 5, "five channels are listed");
  check(/All changes saved/.test(await saveStatus(page)), "nothing is dirty on arrival", await saveStatus(page));
  check(await page.locator('.np-savebar button[type="submit"]').isDisabled(), "Save is disabled until something changes");

  const bucket = sql("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = ?", [`login-ip:${ip(1)}`])[0];
  check(Number(bucket?.n) === 1, "sign-in was counted against this suite's own X-Forwarded-For", JSON.stringify(bucket));

  const before = await prefsOf(page);
  check(before?.prefs?.channels?.email === true && before.prefs.muted.length === 0, "a new devotee starts with every channel on and nothing muted");

  await flip(row(page, "channel", "email"));
  await flip(row(page, "category", "festival"));
  check(/Unsaved changes/.test(await saveStatus(page)), "changing a switch marks the page unsaved");
  await saveAndWait(page);
  check(true, "saving shows a success toast");

  const after = await prefsOf(page);
  check(after?.prefs?.channels?.email === false, "GET prefs: email is off", JSON.stringify(after?.prefs?.channels));
  check(after?.prefs?.muted?.includes("festival"), "GET prefs: festival is muted", JSON.stringify(after?.prefs?.muted));
  check(after?.prefs?.channels?.whatsapp === true && after?.prefs?.channels?.inapp === true, "GET prefs: untouched channels stay on");

  await openPrefs(page);
  check(!(await switchIn(row(page, "channel", "email")).isChecked()), "after a reload the email switch is still off");
  check(!(await switchIn(row(page, "category", "festival")).isChecked()), "after a reload the festival switch is still off");
  check(await switchIn(row(page, "category", "announcement")).isChecked(), "and other topics are still on");

  /* Locked topics */
  for (const key of ["security", "booking", "emergency"]) {
    const r = row(page, "category", key);
    check((await r.count()) === 1, `the ${key} topic is listed`);
    check((await switchIn(r).count()) === 0, `the ${key} topic has no switch`);
    check(/Always on/.test(await r.innerText()), `the ${key} topic reads "Always on"`, (await r.innerText()).replace(/\s+/g, " "));
    check((await r.locator(".np-lock svg").count()) === 1, `the ${key} topic shows a lock icon`);
    check((await r.locator(".np-row__note").innerText()).length > 10, `the ${key} topic says why in one line`);
  }
  const forced = await apiPost(page, "/notifications/prefs", { muted: ["security", "booking", "festival", "announcement"] });
  check(forced.status === 200, "posting locked topics as muted is accepted without error", String(forced.status));
  check(
    !forced.json?.prefs?.muted?.includes("security") && !forced.json?.prefs?.muted?.includes("booking"),
    "…but security and booking are never muted",
    JSON.stringify(forced.json?.prefs?.muted),
  );
  check(forced.json?.prefs?.muted?.includes("announcement"), "…while a mutable topic in the same request is");
  await openPrefs(page);
  check(!(await switchIn(row(page, "category", "announcement")).isChecked()), "the page shows the topic muted through the API");

  /* Language and time zone */
  const langSelect = page.getByLabel("Language for your messages");
  const tzSelect = page.getByLabel("Time zone");
  check((await langSelect.inputValue()) === "ta", "the message language starts as Tamil");
  check((await tzSelect.inputValue()) === "", "the time zone starts as automatic");
  const firstZone = await tzSelect.locator("optgroup").first().locator("option").first();
  check((await firstZone.getAttribute("value")) === "Europe/London", "the browser's own zone is offered first", await firstZone.getAttribute("value"));
  check(/Automatic from my country/.test(await tzSelect.locator('option[value=""]').innerText()), 'there is an "Automatic from my country" choice');

  await langSelect.selectOption("en");
  await tzSelect.selectOption("Asia/Singapore");
  await saveAndWait(page);
  let p = await prefsOf(page);
  check(p?.prefs?.lang === "en" && p?.prefs?.timezone === "Asia/Singapore", "language and time zone save", `${p?.prefs?.lang} ${p?.prefs?.timezone}`);
  await openPrefs(page);
  check(
    (await page.getByLabel("Language for your messages").inputValue()) === "en" && (await page.getByLabel("Time zone").inputValue()) === "Asia/Singapore",
    "and survive a reload",
  );
  await page.getByLabel("Time zone").selectOption("");
  await saveAndWait(page);
  p = await prefsOf(page);
  check(p?.prefs?.timezone === null, "choosing Automatic clears the saved zone", String(p?.prefs?.timezone));

  /* Promotional consent */
  const consent = page.locator(".np-consent input[type=checkbox]");
  check(!(await consent.isChecked()), "promotional consent is off by default");
  check(await switchIn(row(page, "category", "promotional")).isDisabled(), "the promotional topic waits for consent");
  await consent.check();
  check(!(await switchIn(row(page, "category", "promotional")).isDisabled()), "ticking consent enables the promotional topic");
  await saveAndWait(page);
  p = await prefsOf(page);
  check(p?.prefs?.promotional === true, "consent saves", String(p?.prefs?.promotional));
  await openPrefs(page);
  check(await page.locator(".np-consent input[type=checkbox]").isChecked(), "consent survives a reload");
  await page.locator(".np-consent input[type=checkbox]").uncheck();
  await saveAndWait(page);
  p = await prefsOf(page);
  check(p?.prefs?.promotional === false, "withdrawing consent saves", String(p?.prefs?.promotional));

  /* Unsaved-change guard */
  await flip(row(page, "channel", "inapp"));
  await page.locator('[role="tab"]', { hasText: "Bookings" }).click();
  await page.waitForTimeout(400);
  const dialog = page.locator('[role="dialog"]');
  check((await dialog.count()) === 1 && /Leave without saving/.test(await dialog.innerText()), "leaving with unsaved changes asks first");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await page.waitForTimeout(300);
  check((await selectedTab(page)).includes("Notifications") && /Unsaved changes/.test(await saveStatus(page)), '"Keep editing" stays, changes intact');
  await page.locator('[role="tab"]', { hasText: "Bookings" }).click();
  await page.waitForTimeout(300);
  await page.locator('[role="dialog"]').getByRole("button", { name: "Discard changes" }).click();
  await page.waitForTimeout(600);
  check(page.url().endsWith("?tab=bookings"), '"Discard changes" moves on to the tab', page.url());
  p = await prefsOf(page);
  check(p?.prefs?.channels?.inapp === true, "and the discarded change was never saved");

  await openPrefs(page);
  const v2 = await axe(page);
  check(v2.length === 0, "notifications tab @1440: axe serious/critical", v2.slice(0, 6).join("\n      "));
  await page.screenshot({ path: resolve(SHOTS, "notifications-1440.png"), fullPage: true });
  const errs = page.errors();
  check(errs.length === 0, "scenario 1: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Settings save and reload", e);
}

/* ── 2. An unavailable channel ──────────────────────────────────────────── */
section("2. A devotee without a phone: WhatsApp and SMS say why, and link to the fix");
try {
  const page = await newPage({ address: ip(2) });
  await signIn(page, B.email);
  await openPrefs(page);
  const api = await prefsOf(page);
  check(api?.channels?.whatsapp?.reason === "no phone" && api?.channels?.sms?.reason === "no phone", "GET prefs reports no phone");
  for (const key of ["whatsapp", "sms"]) {
    const r = row(page, "channel", key);
    check(/Add a mobile number to your details/.test(await r.innerText()), `${key} shows its reason`, (await r.innerText()).replace(/\s+/g, " "));
    check(await switchIn(r).isDisabled(), `${key} cannot be switched on`);
    check((await r.getByRole("button", { name: "Add a phone number" }).count()) === 1, `${key} offers "Add a phone number"`);
  }
  await row(page, "channel", "whatsapp").getByRole("button", { name: "Add a phone number" }).click();
  await page.waitForTimeout(700);
  check(page.url().endsWith("?tab=profile"), "the action opens the Profile tab", page.url());
  check(
    await page.evaluate(() => document.activeElement?.classList.contains("phone-input__num")),
    "with the cursor in the phone number field",
  );
  check((await page.locator(".acct-phone").count()) === 0, "no verification block while there is no number");
  const errs = page.errors();
  check(errs.length === 0, "scenario 2: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Unavailable channel", e);
}

/* ── 3. Push under vite dev ─────────────────────────────────────────────── */
section("3. Push under vite dev explains the inactive service worker");
try {
  const page = await newPage({ address: ip(3) });
  await signIn(page, A.email);
  await openPrefs(page);
  const api = await prefsOf(page);
  check(api?.channels?.push?.available === true && typeof api?.channels?.push?.publicKey === "string", "the API offers push with a public key");
  const device = page.locator('.np-row[data-channel="push"] .np-device');
  await page.waitForFunction(() => document.querySelector(".np-device")?.dataset.pushReason !== "checking", null, { timeout: 10000 });
  check((await device.getAttribute("data-push-reason")) === "service-worker-inactive", "the hook reports service-worker-inactive", await device.getAttribute("data-push-reason"));
  const text = (await device.innerText()).replace(/\s+/g, " ");
  check(/service worker/i.test(text) && /vite dev/.test(text), "and the page says why in plain words", text.slice(0, 160));
  check((await device.getByRole("button", { name: /Turn on for this device/ }).count()) === 0, "with no button that cannot work");
  const errs = page.errors();
  check(errs.length === 0, "scenario 3: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Push in development", e);
}

/* ── 4. Push subscribe and unsubscribe (mocked Push API) ───────────────── */
section("4. Push on this device: subscribe registers the device, unsubscribe removes it");
try {
  const endpoint = `https://push.example.test/e2e-nprefs/${RUN}/granted`;
  const page = await newPage({ address: ip(4), push: { next: "granted", endpoint, ...PUSH_KEYS } });
  await signIn(page, P.email);
  await openPrefs(page);
  const device = page.locator(".np-device");
  await page.waitForFunction(() => document.querySelector(".np-device")?.dataset.pushReason !== "checking", null, { timeout: 10000 });
  check((await device.getAttribute("data-push-reason")) === "ok", "with the Push API present the device can subscribe", await device.getAttribute("data-push-reason"));
  const mock0 = await page.evaluate(() => ({ ...window.__pushMock, sub: undefined }));
  check(mock0.prompts === 0, "the page never asks for permission on load", JSON.stringify(mock0));
  check(/Off for this device/.test(await device.innerText()), 'it starts "Off for this device"');

  await device.getByRole("button", { name: "Turn on for this device" }).click();
  await page.waitForFunction(() => /On for this device/.test(document.querySelector(".np-device")?.textContent ?? ""), null, { timeout: 10000 });
  const mock1 = await page.evaluate(() => ({ ...window.__pushMock, sub: undefined }));
  check(mock1.prompts === 1, "clicking asks for permission once", String(mock1.prompts));
  check(mock1.subscribeCalls === 1 && mock1.userVisibleOnly === true, "and subscribes with userVisibleOnly");
  check(mock1.keyLength === 65, "using the 65-byte application server key decoded from base64url", String(mock1.keyLength));
  let rows = sql("SELECT id, is_active, platform, provider, keys_json FROM devotee_devices WHERE devotee_id = ? AND endpoint_hash = SHA2(?, 256)", [P.id, endpoint]);
  check(rows.length === 1 && Number(rows[0].is_active) === 1, "POST devices registered the device", JSON.stringify(rows));
  check(rows[0]?.provider === "webpush" && JSON.parse(rows[0]?.keys_json ?? "{}").auth === PUSH_KEYS.auth, "with its Web Push keys");
  await page.waitForFunction(() => /1 device on your account/.test(document.querySelector(".np-device")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  check(/1 device on your account/.test(await device.innerText()), "the device count updates");
  check((await page.locator(".toast--success").count()) > 0, "and a toast confirms it");

  await device.getByRole("button", { name: "Turn off for this device" }).click();
  await page.waitForFunction(() => /Off for this device/.test(document.querySelector(".np-device")?.textContent ?? ""), null, { timeout: 10000 });
  await page.waitForTimeout(800);
  const mock2 = await page.evaluate(() => ({ ...window.__pushMock, sub: undefined }));
  check(mock2.unsubscribes === 1, "turning off unsubscribes the browser", String(mock2.unsubscribes));
  rows = sql("SELECT id FROM devotee_devices WHERE devotee_id = ?", [P.id]);
  check(rows.length === 0, "and POST devices-remove deleted the device", JSON.stringify(rows));
  const errs = page.errors();
  check(errs.length === 0, "scenario 4: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Push subscribe", e);
}

/* ── 5. Permission denied; iOS outside the home screen ──────────────────── */
section("5. Push: permission denied, and iOS outside an installed app");
try {
  const page = await newPage({ address: ip(5), push: { next: "denied", endpoint: `https://push.example.test/e2e-nprefs/${RUN}/denied`, ...PUSH_KEYS } });
  await signIn(page, P.email);
  await openPrefs(page);
  const device = page.locator(".np-device");
  await page.waitForFunction(() => document.querySelector(".np-device")?.dataset.pushReason === "ok", null, { timeout: 10000 });
  await device.getByRole("button", { name: "Turn on for this device" }).click();
  await page.waitForFunction(() => document.querySelector(".np-device")?.dataset.pushReason === "denied", null, { timeout: 10000 });
  const text = (await device.innerText()).replace(/\s+/g, " ");
  check(/blocked/i.test(text) && /Allow/.test(text) && /reload/i.test(text), "a refused prompt explains how to allow notifications again", text.slice(0, 200));
  const mock = await page.evaluate(() => ({ ...window.__pushMock, sub: undefined }));
  check(mock.subscribeCalls === 0, "and nothing was subscribed");
  check(sql("SELECT id FROM devotee_devices WHERE devotee_id = ?", [P.id]).length === 0, "and no device was registered");
  const errs = page.errors();
  check(errs.length === 0, "scenario 5 (denied): no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();

  const ios = await newPage({
    address: ip(6),
    width: 390,
    height: 844,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });
  await signIn(ios, P.email);
  await openPrefs(ios);
  await ios.waitForFunction(() => document.querySelector(".np-device")?.dataset.pushReason !== "checking", null, { timeout: 10000 });
  const iosDevice = ios.locator(".np-device");
  check((await iosDevice.getAttribute("data-push-reason")) === "ios-install-required", "iPhone Safari outside the app reports ios-install-required", await iosDevice.getAttribute("data-push-reason"));
  check(/Add to Home Screen/.test(await iosDevice.innerText()), "with guidance to add the app to the Home Screen");
  const iosErrs = ios.errors();
  check(iosErrs.length === 0, "scenario 5 (iOS): no console errors", iosErrs.slice(0, 3).join(" | "));
  await ios.context().close();
} catch (e) {
  threw("Push denied / iOS", e);
}

/* ── 6. Phone verification ──────────────────────────────────────────────── */
section("6. Mobile number verification, end to end");
try {
  const page = await newPage({ address: ip(7) });
  page.allowErrors(/422|phone-verify-confirm|Failed to load resource: the server responded with a status of 422/);
  await signIn(page, O.email);
  await openPrefs(page);

  const wa = row(page, "channel", "whatsapp");
  check(/not verified yet/.test(await wa.innerText()), "an unverified number is called out on the WhatsApp row");
  await wa.getByRole("button", { name: "Verify number" }).click();
  await page.waitForTimeout(700);
  check(page.url().endsWith("?tab=profile"), '"Verify number" opens the Profile tab', page.url());
  const block = page.locator(".acct-phone");
  check((await block.count()) === 1 && /Not verified/.test(await block.innerText()), "the profile shows the number as not verified");
  const verifyBtn = block.getByRole("button", { name: "Verify number" });
  check(await verifyBtn.evaluate((el) => el === document.activeElement), "with focus on its Verify button");

  await verifyBtn.click();
  const codeInput = page.locator('.acct-phone input[autocomplete="one-time-code"]');
  await codeInput.waitFor({ timeout: 15000 });
  check((await codeInput.getAttribute("inputmode")) === "numeric", "the code field opens the numeric keypad");
  check(await codeInput.evaluate((el) => el === document.activeElement), "and takes focus");
  check(/ending \d{4}/.test(await block.innerText()), "the page says where the code went", (await block.innerText()).replace(/\s+/g, " ").slice(0, 160));
  const resend = block.getByRole("button", { name: /Resend code/ });
  check(await resend.isDisabled(), "Resend waits");
  check(/Resend code in 0:[0-3]\d/.test(await resend.innerText()), "and counts down", await resend.innerText());
  await page.waitForTimeout(1300);
  check(/Resend code in 0:[0-2]\d/.test(await resend.innerText()), "the countdown moves", await resend.innerText());

  let code = null;
  for (let i = 0; i < 20 && !code; i++) {
    code = codeFromLog(O.phone);
    if (!code) await sleep(250);
  }
  check(/^\d{6}$/.test(code ?? ""), "the code was sent through the log driver to this number", String(code));

  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  await codeInput.fill(wrong);
  await block.getByRole("button", { name: "Confirm code" }).click();
  await page.waitForSelector(".acct-phone .field__error", { timeout: 10000 });
  const errText = await page.locator(".acct-phone .field__error").innerText();
  check(/4 attempts left/.test(errText), "a wrong code shows the attempts left", errText);
  const vCode = await axe(page);
  check(vCode.length === 0, "profile with the code step: axe serious/critical", vCode.slice(0, 6).join("\n      "));

  await page.locator('.acct-phone input[autocomplete="one-time-code"]').fill(code);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => /Verified/.test(document.querySelector(".acct-phone__badge")?.textContent ?? ""), null, { timeout: 10000 });
  check(true, 'the right code (Enter in the field) shows "Verified"');
  check(page.url().endsWith("?tab=profile"), "Enter confirmed the code instead of submitting the profile form", page.url());
  check((await page.locator(".toast--success").count()) > 0, "with a success toast");
  const me = await apiGet(page, "/auth/me");
  check(me.json?.user?.phoneVerified === true, "the signed-in user is refreshed: phoneVerified true");
  const db = sql("SELECT phone_verified_at FROM devotees WHERE id = ?", [O.id])[0];
  check(!!db?.phone_verified_at, "and devotees.phone_verified_at is set");
  await openPrefs(page);
  check((await row(page, "channel", "whatsapp").getByRole("button", { name: "Verify number" }).count()) === 0, "the settings stop asking to verify");
  await page.screenshot({ path: resolve(SHOTS, "profile-verified-1440.png"), fullPage: false });
  const errs = page.errors();
  check(errs.length === 0, "scenario 6: no console errors besides the provoked 422", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Phone verification", e);
}

/* ── 7. ?tab= for every tab, and Back ───────────────────────────────────── */
section("7. ?tab= for every tab, a bad value, and Back");
try {
  const page = await newPage({ address: ip(8) });
  await signIn(page, A.email);
  const expected = { overview: "Overview", bookings: "Bookings", donations: "Offerings", profile: "My details", notifications: "Notifications" };
  for (const [key, label] of Object.entries(expected)) {
    await go(page, `/account?tab=${key}`);
    await page.waitForTimeout(400);
    check((await selectedTab(page)).includes(label), `?tab=${key} selects ${label}`, await selectedTab(page));
  }
  await go(page, "/account?tab=nope");
  await page.waitForTimeout(500);
  check((await selectedTab(page)).includes("Overview"), "an unknown tab shows the overview");
  check(page.url().endsWith("/account"), "and is dropped from the address", page.url());

  await go(page, "/sevas");
  await go(page, "/account");
  await page.waitForTimeout(400);
  const lengthBefore = await page.evaluate(() => history.length);
  for (const [label, key] of [["Bookings", "bookings"], ["My details", "profile"], ["Notifications", "notifications"]]) {
    await page.locator('[role="tab"]', { hasText: label }).click();
    await page.waitForTimeout(350);
    check(page.url().endsWith(`?tab=${key}`), `clicking ${label} writes ?tab=${key}`, page.url());
  }
  check((await page.evaluate(() => history.length)) === lengthBefore, "tab switches replace history instead of adding entries");
  await page.locator('[role="tab"]', { hasText: "Overview" }).click();
  await page.waitForTimeout(350);
  check(page.url().endsWith("/account"), "Overview is a bare /account", page.url());
  await page.locator('[role="tab"]', { hasText: "Notifications" }).click();
  await page.waitForTimeout(350);
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check(page.url().endsWith("/sevas"), "Back leaves the account page in one step", page.url());
  await page.goForward({ waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  check(page.url().endsWith("?tab=notifications"), "and Forward returns to the tab last shown", page.url());
  const errs = page.errors();
  check(errs.length === 0, "scenario 7: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Tabs in the URL", e);
}

/* ── 8. Layout: sticky save bar at 390, no overflow ─────────────────────── */
section("8. Layout at 390, 768 and 1440 px");
try {
  const page = await newPage({ address: ip(9), width: 390, height: 844 });
  await signIn(page, A.email);
  await openPrefs(page);
  check(!(await overflow(page)), "notifications tab @390: no horizontal overflow");
  const v390 = await axe(page);
  check(v390.length === 0, "notifications tab @390: axe serious/critical", v390.slice(0, 6).join("\n      "));

  const barState = () =>
    page.evaluate(() => {
      const el = document.querySelector(".np-savebar");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav")?.getBoundingClientRect();
      const btn = el.querySelector('button[type="submit"]').getBoundingClientRect();
      const hit = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
      return {
        floating: el.classList.contains("np-savebar--floating"),
        position: getComputedStyle(el).position,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        vw: document.documentElement.clientWidth,
        vh: window.innerHeight,
        navTop: nav ? Math.round(nav.top) : null,
        saveHit: !!hit?.closest('.np-savebar button[type="submit"]'),
        formBottom: Math.round(document.querySelector(".np").getBoundingClientRect().bottom),
      };
    });

  let bar = await barState();
  check(bar && !bar.floating, "with nothing to save, the bar stays at the end of the form", JSON.stringify(bar));
  await page.locator(".np").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await flip(row(page, "channel", "inapp"));
  await page.waitForTimeout(500);
  bar = await barState();
  check(bar.floating && bar.position === "fixed", "an unsaved change lifts the save bar into view", JSON.stringify(bar));
  check(bar.formBottom > bar.vh && bar.top >= 0 && bar.bottom <= bar.vh, "at the top of a long form it is on screen", JSON.stringify(bar));
  check(bar.navTop === null || bar.bottom <= bar.navTop, "above the bottom navigation", JSON.stringify(bar));
  check(bar.left >= 0 && bar.right <= bar.vw, "inside the viewport's width", JSON.stringify(bar));
  check(bar.saveHit, "and nothing covers its Save button");
  await page.screenshot({ path: resolve(SHOTS, "notifications-390.png") });

  // Scrolled through the form, it follows; past the end, it settles back in place.
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(500);
  bar = await barState();
  check(bar.floating && bar.bottom <= (bar.navTop ?? bar.vh), "halfway down the form it is still in view", JSON.stringify(bar));
  await page.locator(".np-savebar-slot").evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(600);
  bar = await barState();
  check(bar && !bar.floating, "at the end of the form it returns to its place", JSON.stringify(bar));
  await page.locator(".np").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(500);

  // Saving from the floating bar works through its form attribute, and focus lands on the status line.
  await page.locator(".np-savebar--floating").getByRole("button", { name: "Save changes" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".toast--success", { timeout: 10000 });
  await page.waitForTimeout(700);
  bar = await barState();
  check(bar && !bar.floating, "saving from the floating bar saves and settles it", JSON.stringify(bar));
  check(
    await page.evaluate(() => document.activeElement?.classList.contains("np-savebar__status")),
    "and focus moves to the status line instead of being lost",
  );
  const savedInapp = (await prefsOf(page))?.prefs?.channels?.inapp;
  check(savedInapp === false, "the change was saved", String(savedInapp));
  await flip(row(page, "channel", "inapp"));
  await page.waitForTimeout(300);

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(400);
  check(!(await overflow(page)), "notifications tab @768: no horizontal overflow");
  await page.screenshot({ path: resolve(SHOTS, "notifications-768.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  check(!(await overflow(page)), "notifications tab @1440: no horizontal overflow");
  check((await page.locator(".np-savebar--floating").count()) === 0, "on a wide screen the bar stays at the end of the form");

  await page.locator(".np-savebar").getByRole("button", { name: "Save changes" }).click();
  await page.waitForFunction(() => /All changes saved/.test(document.querySelector(".np-savebar__status")?.textContent ?? ""), null, { timeout: 10000 });
  check((await prefsOf(page))?.prefs?.channels?.inapp === true, "the in-app channel is back on");

  await page.setViewportSize({ width: 390, height: 844 });
  await go(page, "/account?tab=profile");
  await page.waitForSelector(".acct-phone", { timeout: 10000 });
  check(!(await overflow(page)), "profile with the verification block @390: no horizontal overflow");
  await page.screenshot({ path: resolve(SHOTS, "profile-390.png"), fullPage: true });
  const errs = page.errors();
  check(errs.length === 0, "scenario 8: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  threw("Layout", e);
}

await browser.close();

/* ── 9. push-sw.js in a sandbox ─────────────────────────────────────────── */
section("9. public/push-sw.js");
try {
  const swSource = readFileSync(resolve(ROOT, "frontend/public/push-sw.js"), "utf8");
  check(!/^\s*(import|export)\s/m.test(swSource), "a plain script with no imports or exports");
  const ORIGIN = "https://temple.example";

  function loadWorker() {
    const listeners = {};
    const w = { shown: [], opened: [], fetched: [], clients: [] };
    const self = {
      location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
      addEventListener: (type, fn) => (listeners[type] = fn),
      registration: {
        showNotification: async (title, options) => {
          w.shown.push({ title, options });
        },
      },
    };
    const clients = {
      matchAll: async () => w.clients,
      openWindow: async (url) => {
        w.opened.push(url);
        return null;
      },
    };
    const sandbox = vm.createContext({ self, clients, URL, fetch: async (u) => (w.fetched.push(u), {}) });
    vm.runInContext(swSource, sandbox);
    w.fire = async (type, event) => {
      let pending = Promise.resolve();
      event.waitUntil = (p) => (pending = p);
      listeners[type](event);
      await pending;
    };
    return w;
  }
  const pushData = (value) => ({ data: { json: () => (typeof value === "string" ? JSON.parse(value) : value), text: () => String(value) } });
  const tab = (url, messages = [], navs = []) => ({
    url,
    focused: false,
    postMessage: (m) => messages.push(m),
    focus: async function () {
      this.focused = true;
      return this;
    },
    navigate: async (u) => (navs.push(u), null),
  });

  let w = loadWorker();
  const messages = [];
  w.clients = [tab(`${ORIGIN}/sevas`, messages)];
  await w.fire(
    "push",
    pushData({
      title: "Booking confirmed",
      body: "See you on Friday",
      url: "/account?tab=bookings",
      trackUrl: `${ORIGIN}/api/n/c/c12.abcdefghijklmnop`,
      notificationId: 12,
      category: "booking",
      priority: "urgent",
      tag: "n12",
      image: "https://img.example/banner.jpg",
    }),
  );
  const shown = w.shown[0];
  check(shown?.title === "Booking confirmed" && shown.options.body === "See you on Friday", "push shows the title and body");
  check(shown?.options.icon === "/icons/icon-192x192.png" && shown.options.badge === "/icons/icon-192x192.png", "with the temple icon and badge");
  check(shown?.options.tag === "n12" && shown.options.renotify === true, "with its tag and renotify");
  check(shown?.options.requireInteraction === true, "urgent messages require interaction");
  check(shown?.options.image === "https://img.example/banner.jpg", "an https image is kept");
  check(shown?.options.data.url === `${ORIGIN}/account?tab=bookings` && shown.options.data.notificationId === 12, "data carries the absolute url and the id");
  check(messages.length === 1 && messages[0].type === "notification-received" && messages[0].notificationId === 12, "every open tab is told a notification arrived");

  w = loadWorker();
  await w.fire("push", { data: { json: () => JSON.parse("{not json"), text: () => "Plain text body" } });
  check(w.shown[0]?.title === "Dhabbalavaar Temple" && w.shown[0].options.body === "Plain text body", "an unreadable payload still shows a notification");
  check(!("renotify" in (w.shown[0]?.options ?? {})), "without renotify when there is no tag (a TypeError in Chromium)");

  w = loadWorker();
  await w.fire("push", pushData({ title: "x", url: "javascript:alert(1)", image: "http://insecure.example/a.png", priority: "normal" }));
  check(w.shown[0]?.options.data.url === `${ORIGIN}/notifications`, "a javascript: url falls back to /notifications");
  check(!("image" in w.shown[0].options) && w.shown[0].options.requireInteraction === false, "an http image is dropped; normal priority does not stick");

  w = loadWorker();
  const navs = [];
  const open = tab(`${ORIGIN}/`, [], navs);
  w.clients = [open];
  let closed = false;
  await w.fire("notificationclick", {
    notification: { close: () => (closed = true), data: { url: `${ORIGIN}/account?tab=bookings`, trackUrl: `${ORIGIN}/api/n/c/c12.abcdefghijklmnop` } },
  });
  check(closed, "a click closes the notification");
  check(open.focused && navs[0] === `${ORIGIN}/account?tab=bookings` && w.opened.length === 0, "an open tab of the site is focused and navigated");
  check(w.fetched[0] === `${ORIGIN}/api/n/c/c12.abcdefghijklmnop`, "and the click is recorded through the site's own tracking link");

  w = loadWorker();
  const navs2 = [];
  w.clients = [tab(`${ORIGIN}/`, [], navs2)];
  await w.fire("notificationclick", { notification: { close() {}, data: { url: "https://other.example/page", trackUrl: null } } });
  check(navs2.length === 0 && w.opened[0] === "https://other.example/page", "a link to another site never navigates the open tab; it opens a window");

  w = loadWorker();
  const navs3 = [];
  w.clients = [tab("https://evil.example/", [], navs3)];
  await w.fire("notificationclick", { notification: { close() {}, data: { url: "/notifications", trackUrl: `${ORIGIN}/api/n/c/c9.abcdefghijklmnop` } } });
  check(navs3.length === 0 && w.opened[0] === `${ORIGIN}/api/n/c/c9.abcdefghijklmnop`, "a tab on another origin is not reused; no tab opens the tracked link");
} catch (e) {
  threw("push-sw.js", e);
}

/* ── 10. The production service worker loads push-sw.js ─────────────────── */
section("10. Production build");
if (process.env.SKIP_BUILD === "1") {
  console.log("  skipped (SKIP_BUILD=1)");
} else {
  try {
    const r = spawnSync("npx", ["vite", "build", "--outDir", BUILD_OUT, "--emptyOutDir"], {
      cwd: resolve(ROOT, "frontend"),
      encoding: "utf8",
      shell: true,
      timeout: 420_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    check(r.status === 0, "npx vite build succeeds", `${r.status} ${(r.stderr || "").slice(-400)}`);
    const sw = existsSync(`${BUILD_OUT}/sw.js`) ? readFileSync(`${BUILD_OUT}/sw.js`, "utf8") : "";
    check(/importScripts\(\s*["']push-sw\.js["']\s*\)/.test(sw), 'the generated sw.js calls importScripts("push-sw.js")', sw.slice(0, 120));
    check(existsSync(`${BUILD_OUT}/push-sw.js`), "and push-sw.js is published next to it");
  } catch (e) {
    threw("Production build", e);
  }
}

/* ── Cleanup and report ─────────────────────────────────────────────────── */
section("Cleanup");
try {
  const removed = cleanup();
  check(removed === 4, "removed this run's four devotees", String(removed));
  const left = sql("SELECT COUNT(*) AS n FROM devotees WHERE email LIKE ?", [`${EMAIL_PREFIX}%`])[0];
  check(Number(left.n) === 0, "no test devotees remain");
  const buckets = sql("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket LIKE ?", ["%:10.42.%"])[0];
  check(Number(buckets.n) === 0, "no rate-limit buckets for this suite's addresses remain");
} catch (e) {
  threw("Cleanup", e);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
