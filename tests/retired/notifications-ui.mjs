#!/usr/bin/env node
/**
 * tests/notifications-ui.mjs — the devotee's bell, its panel and the
 * /notifications page, in a real browser against the Vite dev server, the PHP
 * API and MySQL (docs/notifications/SPEC.md §7.1, §7.2, §7.3, §7.5).
 *
 *   PHP_BIN=/path/to/php.sh node tests/notifications-ui.mjs [http://localhost:5173]
 *
 * What it proves:
 *   • the helpers group by the reader's calendar and speak relative times in
 *     Tamil and English;
 *   • the bell shows the unread count ("9+" past nine) and says it in its name;
 *   • the panel opens and closes by click, Escape and an outside click, returning
 *     focus to the bell; opening an item marks it read and follows its link;
 *     archive, delete and unread from the row menu; mark all as read; View all;
 *   • the page groups Today / Yesterday / This week / Earlier, scrolls through
 *     45 notifications in pages without a duplicate, filters by status,
 *     category, search and dates with each in the URL, and acts on a selection;
 *   • empty, filtered-empty and error states (with a working retry);
 *   • a notification created while the page is open appears on focus or
 *     visibilitychange without a reload, and a change in one tab reaches another;
 *   • at 390px the panel is a bottom sheet and the drawer has a Notifications row;
 *   • no horizontal overflow at 390/768/1024/1440, the signed-in header fits
 *     from 320 to 2560 by tests/public-e2e.mjs's own measure, axe finds nothing
 *     serious or critical, and nothing logs a console error.
 *
 * Devotees are created with tests/support/notify_fixtures.php and sign in through
 * the real /login form. Every browser context sends its own X-Forwarded-For in
 * 10.41.<run>.<n>. Data: devotees e2e-nui-<run>-*@example.test, dedupe keys
 * e2e:nui:<run>:*; removed at the start (a crashed run) and at the end, together
 * with this run's rate-limit rows.
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");

const BASE = (process.argv[2] || "http://localhost:5173").replace(/\/$/, "");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const EMAIL_PREFIX = "e2e-nui-";
const DEDUPE = `e2e:nui:${RUN}`;
const PASSWORD = "Kolam99Deep";
const TZ = "Asia/Kolkata";
const IST_MS = 5.5 * 3600 * 1000;
// A different third octet per run, so a re-run inside the same quarter-hour never
// meets the previous run's per-address sign-in count.
const OCTET = 1 + (Math.floor(Date.now() / 1000) % 250);
const ipFor = (n) => `10.41.${OCTET}.${n}`;
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
mkdirSync("shots/notifications", { recursive: true });

const results = [];
const check = (ok, name, detail = "") => results.push({ ok: Boolean(ok), name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const threw = (label, e) => fail(`${label} (scenario threw)`, String(e?.message || e).split("\n")[0].slice(0, 220));

/** Poll `fn` until it returns truthy or `ms` passes. */
async function until(fn, ms = 6000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* not there yet */
    }
    await sleep(step);
  }
  return false;
}

/* ── PHP fixtures ──────────────────────────────────────────────────────── */

/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const viaBash = PHP_BIN.endsWith(".sh");

function phpJson(args) {
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`php ${args[1] ?? ""} printed no JSON (exit ${r.status}): ${r.stdout.slice(-300)} ${r.stderr.slice(-300)}`);
  }
}
const fixtures = (cmd, obj = {}) => phpJson(["tests/support/notify_fixtures.php", cmd, arg(obj)]);
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}
const one = (query, params) => sql(query, params)[0] ?? null;

function createDevotee(tag, name) {
  const r = fixtures("create-devotee", {
    email: `${EMAIL_PREFIX}${RUN}-${tag}@example.test`,
    password: PASSWORD,
    name,
    verified: true,
  });
  if (!r.id) throw new Error(`could not create devotee ${tag}: ${JSON.stringify(r)}`);
  return { id: Number(r.id), email: r.email };
}

/** notify() for each spec, then one UPDATE that moves every row to its day. */
function seed(devoteeId, specs) {
  for (const s of specs) {
    const payload = {
      devotee_id: devoteeId,
      channels: ["inapp"],
      category: s.category,
      priority: s.priority ?? "normal",
      title: s.title,
      body: s.body,
      dedupe_key: `${DEDUPE}:${devoteeId}:${s.key}`,
    };
    if (s.cta) payload.cta_url = s.cta;
    const r = fixtures("notify", payload);
    const id = r?.result?.id;
    if (!id) throw new Error(`seeding ${s.key} failed: ${JSON.stringify(r).slice(0, 300)}`);
    s.id = Number(id);
  }
  const timed = specs.filter((s) => s.at);
  if (timed.length) {
    sql(
      `UPDATE notifications SET created_at = CASE id ${timed.map(() => "WHEN ? THEN ?").join(" ")} END
        WHERE id IN (${timed.map(() => "?").join(",")})`,
      [...timed.flatMap((s) => [s.id, s.at]), ...timed.map((s) => s.id)],
    );
  }
  return specs;
}

/* ── Time: the browser runs in Asia/Kolkata, so "today" is today in IST ── */
const istMidnight = (daysAgo) => {
  const n = new Date(Date.now() + IST_MS);
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - daysAgo) - IST_MS;
};
const sqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const istDay = (daysAgo) => new Date(istMidnight(daysAgo) + IST_MS).toISOString().slice(0, 10);
const todayAt = (minutesAgo) => sqlUtc(Math.max(istMidnight(0) + 30_000, Date.now() - minutesAgo * 60_000));

/* ── Test data ─────────────────────────────────────────────────────────── */
const CATS = ["general", "booking", "festival", "donation", "announcement", "event", "pooja"];
const TITLES = {
  general: "Temple office notice",
  booking: "Seva booking update",
  festival: "Festival announcement",
  donation: "Offering received with thanks",
  announcement: "Temple announcement",
  event: "Event reminder",
  pooja: "Pooja timing change",
};
const SEARCH_WORD = "Kumbabishekam";

/** 45 notifications: 5 today, 5 yesterday, 10 this week, 25 earlier; newest first. */
function pageSpecs() {
  return Array.from({ length: 45 }, (_, i) => {
    let at;
    let group;
    if (i < 5) {
      at = todayAt(3 + i * 4);
      group = "today";
    } else if (i < 10) {
      at = sqlUtc(istMidnight(1) + 18 * 3600e3 - (i - 5) * 30 * 60e3);
      group = "yesterday";
    } else if (i < 20) {
      at = sqlUtc(istMidnight(2 + Math.floor((i - 10) / 2)) + 12 * 3600e3 - (i - 10) * 60e3);
      group = "week";
    } else {
      at = sqlUtc(istMidnight(8 + (i - 20) * 2) + 11 * 3600e3);
      group = "earlier";
    }
    const category = CATS[i % CATS.length];
    return {
      key: `a${i}`,
      i,
      group,
      category,
      at,
      title: `${TITLES[category]} · ${String(i + 1).padStart(2, "0")}`,
      body: [3, 12, 30].includes(i)
        ? `The ${SEARCH_WORD} preparations begin at dawn; volunteers please report to the temple office.`
        : `Details for devotees about notice ${i + 1}, from the temple office in Pudupatti.`,
      cta: i % 3 === 0 ? "/events" : undefined,
      priority: i === 1 ? "important" : i === 4 ? "urgent" : "normal",
    };
  });
}

/** 12 notifications for the panel, all today; p0 is the newest. */
function panelSpecs() {
  const special = [
    { category: "booking", priority: "important", title: "Your seva booking is confirmed", body: "Abhishekam on Friday at 6:00 am. Please arrive fifteen minutes early.", cta: "/events" },
    { category: "festival", title: "Navaratri programme published", body: "The full nine-day schedule is on the festival page.", cta: "https://example.org/navaratri" },
    { category: "security", priority: "important", title: "Your password was changed", body: "If this was not you, reset your password straight away." },
    { category: "emergency", priority: "emergency", title: "Temple closes early today", body: "The sanctum closes at 7:00 pm for special rituals." },
  ];
  return Array.from({ length: 12 }, (_, i) => ({
    key: `p${i}`,
    at: todayAt(2 + i * 3),
    ...(special[i] ?? { category: "general", title: `Temple office notice ${i + 1}`, body: `A short notice from the temple office (${i + 1}).` }),
  }));
}

/* ── Browser helpers ───────────────────────────────────────────────────── */
const browser = await chromium.launch();
const IGNORE =
  /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js|example\.org/;

/**
 * A browser context whose calls to the site's API carry this suite's own
 * X-Forwarded-For. Only /api requests: on a cross-origin font request the extra
 * header forces a CORS preflight the font host refuses, and the console would
 * fill with failures that have nothing to do with the page under test.
 */
async function newContext({ width = 1440, height = 900, ipN, storageState } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN", timezoneId: TZ, storageState });
  const origin = new URL(BASE).origin;
  await ctx.route(
    (url) => url.origin === origin && url.pathname.startsWith("/api/"),
    (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": ipFor(ipN) } }),
  );
  return ctx;
}

/** Collect console errors; errors raised while `expectErrors(true)` are the ones a scenario provoked on purpose. */
function watch(page) {
  const errors = [];
  let expected = false;
  page.on("console", (m) => {
    if (m.type() === "error") errors.push({ text: `[console] ${m.text()}`, expected });
  });
  page.on("pageerror", (e) => errors.push({ text: `[pageerror] ${e.message}`, expected: false }));
  page.on("requestfailed", (r) => {
    errors.push({ text: `[requestfailed] ${r.url()} ${r.failure()?.errorText}`, expected });
  });
  page.expectErrors = (on) => {
    expected = on;
  };
  page.errors = () => errors.filter((e) => !e.expected && !IGNORE.test(e.text)).map((e) => e.text);
  return page;
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

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

/** The site opens in Tamil and keeps the choice in memory only; press English after every full load. */
async function english(page) {
  const en = page.locator('.lang-toggle__btn[lang="en"]');
  if (await en.count()) {
    await en.first().click();
    await page.waitForTimeout(200);
  }
}

async function go(page, path) {
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await english(page);
}

/** Sign in through the real form, arriving on /notifications by way of the route guard. */
async function signIn(page, email) {
  await page.goto(BASE + "/notifications", { waitUntil: "networkidle" });
  await page.waitForURL("**/login", { timeout: 15000 });
  await english(page);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/notifications", { timeout: 15000 });
}

const bellLabel = (page) => page.locator(".notif-bell").getAttribute("aria-label");
const waitBell = (page, label, ms = 10000) =>
  page
    .waitForFunction((l) => document.querySelector(".notif-bell")?.getAttribute("aria-label") === l, label, { timeout: ms })
    .then(() => true)
    .catch(() => false);
const focusIn = (page, selector) => page.evaluate((s) => Boolean(document.activeElement?.closest(s)), selector);
const focusOn = (page, cls) => page.evaluate((c) => Boolean(document.activeElement?.classList.contains(c)), cls);

/** The page's list has settled: no skeleton, and rows, an empty state or an error on screen. */
async function listReady(page, ms = 10000) {
  return page
    .waitForFunction(
      () =>
        !document.querySelector(".notif-page .notif-skel-list") &&
        Boolean(document.querySelector(".notif-page .notif-item, .notif-page .notif-empty, .notif-page .notif-error")),
      null,
      { timeout: ms },
    )
    .then(() => true)
    .catch(() => false);
}
const rowIds = (page, scope = ".notif-page") =>
  page.evaluate((s) => [...document.querySelectorAll(`${s} .notif-item`)].map((li) => Number(li.dataset.id)), scope);
const urlParams = (page) => Object.fromEntries(new URL(page.url()).searchParams);
/** A status tab by its exact name ("Read" must not also match "Unread"). */
const tab = (page, name) => page.locator(".notif-status").getByRole("tab", { name, exact: true });

/* ── Setup ─────────────────────────────────────────────────────────────── */
fixtures("cleanup", { email_prefix: EMAIL_PREFIX });

const P = createDevotee("panel", "E2E-NUI Lakshmi Panel");
const A = createDevotee("page", "E2E-NUI Arjun Page");
const E = createDevotee("empty", "E2E-NUI Esther Empty");
const PANEL = seed(P.id, panelSpecs());
const PAGE = seed(A.id, pageSpecs());
const byKey = (specs) => Object.fromEntries(specs.map((s) => [s.key, s]));
const p = byKey(PANEL);
const a = byKey(PAGE);
let storageA = null;

/* ── 1. Helpers (lib/notifications.js), in the browser that runs them ──── */
try {
  const ctx = await newContext({ ipN: 9 });
  const page = watch(await ctx.newPage());
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const r = await page.evaluate(async () => {
    const m = await import("/src/lib/notifications.js");
    const now = new Date(2026, 8, 13, 10, 0, 0); // 13 Sep 2026 10:00 in the context's zone (IST)
    const at = (dayOffset, h, min = 0) => new Date(2026, 8, 13 + dayOffset, h, min).toISOString();
    const groups = m
      .groupByTime(
        [
          { id: 6, createdAt: new Date(2026, 8, 13, 10, 0, 20).toISOString() }, // a few seconds "ahead"
          { id: 5, createdAt: at(0, 0, 5) },
          { id: 4, createdAt: at(-1, 23, 50) },
          { id: 3, createdAt: at(-2, 8) },
          { id: 2, createdAt: at(-6, 0, 30) },
          { id: 1, createdAt: at(-7, 23, 59) },
        ],
        now,
      )
      .map((g) => `${g.key}:${g.items.map((i) => i.id).join(",")}`);
    const rel = (iso, lang) => m.relativeTime(iso, lang, now);
    return {
      groups,
      en: [
        rel(new Date(now - 10_000).toISOString(), "en"),
        rel(new Date(now - 5 * 60_000).toISOString(), "en"),
        rel(at(0, 7), "en"),
        rel(at(-1, 23), "en"),
        rel(at(-3, 12), "en"),
        rel(at(-15, 12), "en"),
        rel(at(-70, 12), "en"),
      ],
      ta: [rel(new Date(now - 5 * 60_000).toISOString(), "ta"), rel(at(-1, 23), "ta")],
      internal: [m.isInternalPath("/events"), m.isInternalPath("//evil.example"), m.isInternalPath("https://x.example"), m.isInternalPath("/\\evil")],
      counts: [m.formatCount(0), m.formatCount(9), m.formatCount(10), m.formatCount(250)],
      icons: [
        m.iconFor({ icon: "siren", category: "general" }) === m.ICONS_BY_NAME.siren,
        m.iconFor({ icon: "no-such-icon", category: "booking" }) === m.CATEGORY_ICONS.booking,
        m.iconFor({}) === m.ICONS_BY_NAME.bell,
      ],
      full: m.formatDateTime(at(0, 9, 35), "en"),
    };
  });
  check(
    r.groups.join(" | ") === "today:6,5 | yesterday:4 | week:3,2 | earlier:1",
    "groupByTime splits by the reader's calendar days",
    r.groups.join(" | "),
  );
  check(
    /now/i.test(r.en[0]) && r.en[1] === "5 minutes ago" && r.en[2] === "3 hours ago" && r.en[3] === "yesterday" &&
      r.en[4] === "3 days ago" && r.en[5] === "2 weeks ago" && r.en[6] === "2 months ago",
    "relativeTime in English (Intl.RelativeTimeFormat)",
    r.en.join(" · "),
  );
  check(/நிமிட/.test(r.ta[0]) && /நேற்று/.test(r.ta[1]), "relativeTime in Tamil", r.ta.join(" · "));
  check(r.internal.join() === "true,false,false,false", "isInternalPath accepts site paths only", r.internal.join());
  check(r.counts.join() === "0,9,9+,9+", "formatCount caps the badge at 9+", r.counts.join());
  check(r.icons.every(Boolean), "iconFor: by icon name, then category, then the bell");
  check(/2026/.test(r.full) && /September/.test(r.full), "formatDateTime gives the full date for the tooltip", r.full);
  await ctx.close();
} catch (e) {
  threw("Helpers", e);
}

/* ── 2. The bell and its panel ─────────────────────────────────────────── */
try {
  const ctx = await newContext({ ipN: 1 });
  const page = watch(await ctx.newPage());
  await signIn(page, P.email);
  await go(page, "/");

  await page.waitForSelector(".notif-bell__count", { timeout: 12000 });
  check((await page.locator(".notif-bell__count").innerText()) === "9+", "the badge shows 9+ for twelve unread");
  check((await bellLabel(page)) === "Notifications, 12 unread", "the bell's accessible name carries the count", await bellLabel(page));
  check(
    await page.evaluate(() => {
      const bell = document.querySelector(".notif-bell").getBoundingClientRect();
      const avatar = document.querySelector(".navbar__acct-btn").getBoundingClientRect();
      return bell.right <= avatar.left && avatar.left - bell.right < 16;
    }),
    "the bell sits immediately before the account avatar",
  );

  const bell = page.locator(".notif-bell");
  const pop = page.locator('.notif-pop[role="dialog"]');

  // Open by click
  await bell.click();
  await pop.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll(".notif-pop .notif-item").length === 10, null, { timeout: 10000 });
  check(true, "clicking the bell opens the panel with the newest ten");
  check((await bell.getAttribute("aria-expanded")) === "true", "…and the bell reports itself expanded");
  check((await pop.getAttribute("aria-label")) === "Notifications", "the panel is a dialog named Notifications");
  check(await focusIn(page, ".notif-pop"), "focus moves into the panel");
  const box = await pop.boundingBox();
  check(box && box.width >= 380 && box.width <= 402 && box.height <= 900 * 0.7 + 2, "the panel is ~400px wide and at most 70vh tall", JSON.stringify(box));

  const first = page.locator(`.notif-pop .notif-item[data-id="${p.p0.id}"]`);
  check((await first.getAttribute("class")).includes("notif-item--unread"), "an unread row carries the unread style");
  check((await first.locator(".notif-item__dot").count()) === 1, "…and the gold dot");
  check((await first.locator(".notif-item__badge").innerText()) === "Important", "an important notification carries its priority badge");
  check(
    (await page.locator(`.notif-pop .notif-item[data-id="${p.p3.id}"] .notif-item__badge`).innerText()) === "Emergency",
    "an emergency carries the Emergency badge",
  );
  check(
    (await page.locator(`.notif-pop .notif-item[data-id="${p.p3.id}"] .notif-item__icon`).getAttribute("data-tone")) === "danger",
    "…and a danger-toned icon tile",
  );
  const time = first.locator("time");
  check(
    /minute|now/.test(await time.innerText()) && Boolean(await time.getAttribute("datetime")) && /2026|20\d\d/.test((await time.getAttribute("title")) ?? ""),
    "the row shows a relative time with the full date in its title",
    `${await time.innerText()} / ${await time.getAttribute("title")}`,
  );
  const ext = page.locator(`.notif-pop .notif-item[data-id="${p.p1.id}"] a.notif-item__main`);
  check(
    (await ext.getAttribute("target")) === "_blank" && (await ext.getAttribute("rel")) === "noopener noreferrer",
    "an https link opens in a new tab with noopener noreferrer",
  );
  await page.screenshot({ path: "shots/notifications/panel-1440.png" });

  const v = await axe(page);
  check(v.length === 0, "axe: nothing serious or critical with the panel open", v.slice(0, 4).join("\n      "));

  // Escape
  await page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached", timeout: 3000 });
  check(true, "Escape closes the panel");
  check(await focusOn(page, "notif-bell"), "…and focus returns to the bell");

  // Outside click
  await bell.click();
  await pop.waitFor({ state: "visible", timeout: 3000 });
  await page.locator("main h1").first().click();
  await pop.waitFor({ state: "detached", timeout: 3000 });
  check(true, "a click outside closes the panel");
  check(await until(() => focusOn(page, "notif-bell"), 2000), "…and focus returns to the bell");

  // Toggle
  await bell.click();
  await pop.waitFor({ state: "visible", timeout: 3000 });
  await bell.click();
  await pop.waitFor({ state: "detached", timeout: 3000 });
  check(true, "clicking the bell again closes the panel");

  // Opening an item marks it read and follows its link
  await bell.click();
  await first.waitFor({ state: "visible", timeout: 5000 });
  await first.locator(".notif-item__main").click();
  await page.waitForURL("**/events", { timeout: 10000 });
  check(true, "clicking an item navigates to its internal link");
  check(await waitBell(page, "Notifications, 11 unread"), "…the badge drops by one", await bellLabel(page));
  check(await until(() => one("SELECT read_at FROM notifications WHERE id = ?", [p.p0.id])?.read_at), "…the notification is read in the database");
  check(
    await until(() => one("SELECT clicked_at FROM notification_deliveries WHERE notification_id = ? AND channel = 'inapp'", [p.p0.id])?.clicked_at),
    "…and the in-app click is recorded",
  );
  check((await pop.count()) === 0, "…and the panel closed behind it");

  // Archive from the row menu
  await bell.click();
  await pop.waitFor({ state: "visible", timeout: 3000 });
  const rowP1 = page.locator(`.notif-pop .notif-item[data-id="${p.p1.id}"]`);
  await rowP1.locator(".notif-item__more").click();
  const menu = rowP1.locator('[role="menu"]');
  await menu.waitFor({ state: "visible", timeout: 3000 });
  check(await focusIn(page, '[role="menu"]'), "the row menu takes focus");
  await menu.locator('[role="menuitem"]', { hasText: "Archive" }).click();
  check(await until(async () => (await rowP1.count()) === 0), "Archive removes the row from the panel");
  check(await until(() => one("SELECT archived_at FROM notifications WHERE id = ?", [p.p1.id])?.archived_at), "…and archives it in the database");
  check(await waitBell(page, "Notifications, 10 unread"), "…and the badge counts it out", await bellLabel(page));
  check(await focusIn(page, ".notif-pop"), "…with focus kept inside the panel");

  // Keyboard on the menu: Escape closes the menu, not the panel
  const rowP2 = page.locator(`.notif-pop .notif-item[data-id="${p.p2.id}"]`);
  await rowP2.locator(".notif-item__more").focus();
  await page.keyboard.press("Enter");
  await rowP2.locator('[role="menu"]').waitFor({ state: "visible", timeout: 3000 });
  await page.keyboard.press("ArrowDown");
  const focusedItem = await page.evaluate(() => document.activeElement?.textContent?.trim());
  check(/Archive/.test(focusedItem ?? ""), "ArrowDown moves through the menu", focusedItem);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check((await rowP2.locator('[role="menu"]').count()) === 0 && (await pop.count()) === 1, "Escape closes the menu but leaves the panel open");
  check(await focusOn(page, "notif-item__more"), "…returning focus to the menu button");

  // Delete from the row menu
  await rowP2.locator(".notif-item__more").click();
  await rowP2.locator('[role="menuitem"]', { hasText: "Delete" }).click();
  check(await until(async () => (await rowP2.count()) === 0), "Delete removes the row");
  check(await until(() => one("SELECT deleted_at FROM notifications WHERE id = ?", [p.p2.id])?.deleted_at), "…and soft-deletes it in the database");
  check(await waitBell(page, "Notifications, 9 unread"), "…and the badge follows", await bellLabel(page));

  // Mark as unread
  const rowP0 = page.locator(`.notif-pop .notif-item[data-id="${p.p0.id}"]`);
  await rowP0.locator(".notif-item__more").click();
  await rowP0.locator('[role="menuitem"]', { hasText: "Mark as unread" }).click();
  check(await waitBell(page, "Notifications, 10 unread"), "Mark as unread puts it back in the count", await bellLabel(page));
  check(await until(async () => (await rowP0.getAttribute("class")).includes("notif-item--unread")), "…and restores the unread style");
  check(
    await until(async () => (await page.locator(".notif-pop .notif-item").count()) === 10),
    "the panel refills to ten after rows leave it",
  );

  // Mark all as read
  await page.locator(".notif-pop .notif-panel__markall").click();
  check(await waitBell(page, "Notifications"), "Mark all as read zeroes the badge", await bellLabel(page));
  check((await page.locator(".notif-bell__count").count()) === 0, "…and removes the badge");
  check(
    await until(() => Number(one("SELECT COUNT(*) AS n FROM notifications WHERE devotee_id = ? AND read_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL", [P.id]).n) === 0),
    "…and every notification is read in the database",
  );
  check((await page.locator(".notif-pop .notif-item--unread").count()) === 0, "…and no row is styled unread");

  // View all
  await page.locator(".notif-pop .notif-panel__all").click();
  await page.waitForURL("**/notifications", { timeout: 8000 });
  check(true, "View all notifications goes to /notifications");
  check((await pop.count()) === 0, "…closing the panel");

  const errs = page.errors();
  check(errs.length === 0, "bell and panel: no console errors", errs.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  threw("Bell and panel", e);
}

/* ── 3. The page ───────────────────────────────────────────────────────── */
try {
  const ctx = await newContext({ ipN: 2 });
  const page = watch(await ctx.newPage());
  await signIn(page, A.email);
  storageA = await ctx.storageState();
  check(await listReady(page), "the page loads its first rows");
  check((await page.locator("h1").count()) === 1 && /Notifications/.test(await page.locator("h1").innerText()), "one h1: Notifications");

  const firstIds = await rowIds(page);
  check(firstIds.length === 20, "the first page holds twenty", `${firstIds.length}`);
  check(
    firstIds.join() === PAGE.slice(0, 20).map((s) => s.id).join(),
    "rows are newest first",
  );
  const headings = await page.locator(".notif-group__title").evaluateAll((els) => els.map((h) => h.dataset.group + ":" + h.firstChild.textContent.trim()));
  check(headings.join() === "today:Today,yesterday:Yesterday,week:This week", "grouped under Today, Yesterday and This week", headings.join());
  check(
    await page.locator(`.notif-item[data-id="${a.a0.id}"]`).evaluate((li) => li.closest(".notif-group").querySelector("h2").dataset.group) === "today" &&
      await page.locator(`.notif-item[data-id="${a.a7.id}"]`).evaluate((li) => li.closest(".notif-group").querySelector("h2").dataset.group) === "yesterday" &&
      await page.locator(`.notif-item[data-id="${a.a15.id}"]`).evaluate((li) => li.closest(".notif-group").querySelector("h2").dataset.group) === "week",
    "each row sits under its own day",
  );
  check((await page.locator(`.notif-item[data-id="${a.a7.id}"] time`).innerText()) === "yesterday", "a row from yesterday says yesterday");
  check((await page.locator(".notif-more__btn").count()) === 1, "a Load more button is offered as the fallback");
  await page.screenshot({ path: "shots/notifications/page-1440.png", fullPage: false });

  // Infinite scroll
  await page.locator(".notif-more__sentinel").scrollIntoViewIfNeeded();
  check(await until(async () => (await rowIds(page)).length === 40, 10000), "scrolling to the end loads the second page");
  await page.locator(".notif-more__sentinel").scrollIntoViewIfNeeded();
  check(await until(async () => (await rowIds(page)).length === 45, 10000), "…and the third");
  const allIds = await rowIds(page);
  check(new Set(allIds).size === 45, "…with no duplicates", `${allIds.length} rows, ${new Set(allIds).size} unique`);
  check(allIds.join() === PAGE.map((s) => s.id).join(), "…in order, every seeded row exactly once");
  check((await page.locator(".notif-more").count()) === 0 && (await page.locator(".notif-end").count()) === 1, "the end of the list says so");
  const earlier = await page.locator('.notif-group__title[data-group="earlier"]').count();
  check(earlier === 1, "the Earlier group appears once older rows load");

  const v = await axe(page);
  check(v.length === 0, "axe: nothing serious or critical on /notifications", v.slice(0, 4).join("\n      "));

  // Bulk: mark read
  await page.evaluate(() => window.scrollTo(0, 0));
  for (const k of ["a0", "a1", "a2"]) await page.locator(`.notif-item[data-id="${a[k].id}"] .notif-check`).check();
  await page.locator(".notif-bulk").waitFor({ state: "visible", timeout: 3000 });
  check(/3 selected/.test(await page.locator(".notif-bulk__count").innerText()), "selecting rows shows the bulk bar");
  await page.locator('.notif-bulk [data-action="read"]').click();
  check(
    await until(() => page.evaluate((ids) => ids.every((id) => document.querySelector(`li[data-id="${id}"]`)?.dataset.read === "true"), [a.a0.id, a.a1.id, a.a2.id])),
    "bulk Mark read marks the rows",
  );
  check(await waitBell(page, "Notifications, 42 unread"), "…and the badge", await bellLabel(page));
  check(
    await until(() => Number(one("SELECT COUNT(*) AS n FROM notifications WHERE id IN (?,?,?) AND read_at IS NOT NULL", [a.a0.id, a.a1.id, a.a2.id]).n) === 3),
    "…and the database",
  );
  check((await page.locator(".notif-bulk").count()) === 0, "…and clears the selection");

  // Status filter
  await tab(page, "Unread").click();
  await page.waitForURL(/status=unread/, { timeout: 5000 });
  await listReady(page);
  await until(() => page.evaluate(() => [...document.querySelectorAll(".notif-item")].every((li) => li.dataset.read === "false")), 8000);
  const unreadRows = await page.locator(".notif-item").evaluateAll((els) => els.map((e) => e.dataset.read));
  check(unreadRows.length === 20 && unreadRows.every((r) => r === "false"), "Unread shows only unread rows (status=unread in the URL)", `${unreadRows.length}`);
  await tab(page, "Read").click();
  await page.waitForURL(/status=read/, { timeout: 5000 });
  await until(async () => (await rowIds(page)).length === 3);
  const readIds = await rowIds(page);
  check(readIds.sort().join() === [a.a0.id, a.a1.id, a.a2.id].sort().join(), "Read shows the three read rows (status=read)", readIds.join());
  await page.goBack();
  await page.waitForURL(/status=unread/, { timeout: 5000 });
  check(true, "the back button restores the previous filter");
  await tab(page, "All").click();
  await until(() => !new URL(page.url()).searchParams.has("status"), 5000);
  await listReady(page);
  check(!urlParams(page).status, "All removes the status from the URL");

  // Bulk archive, then the archived view, then move one back
  for (const k of ["a3", "a4"]) await page.locator(`.notif-item[data-id="${a[k].id}"] .notif-check`).check();
  await page.locator('.notif-bulk [data-action="archive"]').click();
  check(
    await until(async () => (await page.locator(`.notif-item[data-id="${a.a3.id}"], .notif-item[data-id="${a.a4.id}"]`).count()) === 0),
    "bulk Archive removes the rows from the inbox",
  );
  check(
    await until(() => Number(one("SELECT COUNT(*) AS n FROM notifications WHERE id IN (?,?) AND archived_at IS NOT NULL", [a.a3.id, a.a4.id]).n) === 2),
    "…and archives them in the database",
  );
  await tab(page, "Archived").click();
  await page.waitForURL(/status=archived/, { timeout: 5000 });
  await until(async () => (await rowIds(page)).length === 2);
  check((await rowIds(page)).sort().join() === [a.a3.id, a.a4.id].sort().join(), "Archived lists exactly those two");
  await page.locator(`.notif-item[data-id="${a.a4.id}"] .notif-check`).check();
  await page.locator('.notif-bulk [data-action="unarchive"]').click();
  check(await until(async () => (await rowIds(page)).length === 1), "Move to inbox takes it out of the archive");
  check(await until(() => one("SELECT archived_at FROM notifications WHERE id = ?", [a.a4.id])?.archived_at === null), "…and unarchives it in the database");
  await tab(page, "All").click();
  await until(() => !new URL(page.url()).searchParams.has("status"), 5000);
  await listReady(page);

  // Bulk delete, with its confirmation
  await page.locator(`.notif-item[data-id="${a.a5.id}"] .notif-check`).check();
  await page.locator('.notif-bulk [data-action="delete"]').click();
  const confirm = page.locator('.notif-confirm[role="dialog"]');
  await confirm.waitFor({ state: "visible", timeout: 3000 });
  check(/Delete 1 notification\?/.test(await confirm.innerText()), "bulk Delete asks first");
  await confirm.locator('[data-action="confirm-delete"]').click();
  check(await until(async () => (await page.locator(`.notif-item[data-id="${a.a5.id}"]`).count()) === 0), "confirming removes the row");
  check(await until(() => one("SELECT deleted_at FROM notifications WHERE id = ?", [a.a5.id])?.deleted_at), "…and soft-deletes it in the database");

  // Category filter (multi-select)
  await page.locator('.notif-cats .chip[data-category="festival"]').click();
  await page.waitForURL(/category=festival/, { timeout: 5000 });
  await listReady(page);
  // The URL changes before the list does; wait for the rows themselves.
  await until(async () => {
    const c = await page.locator(".notif-item").evaluateAll((els) => els.map((e) => e.dataset.category));
    return c.length === 7 && c.every((x) => x === "festival");
  }, 8000);
  let cats = await page.locator(".notif-item").evaluateAll((els) => els.map((e) => e.dataset.category));
  check(cats.length === 7 && cats.every((c) => c === "festival"), "a category chip filters to that category (category=festival)", `${cats.length}: ${[...new Set(cats)]}`);
  check((await page.locator('.notif-cats .chip[data-category="festival"]').getAttribute("aria-pressed")) === "true", "…and the chip shows as pressed");
  await page.locator('.notif-cats .chip[data-category="booking"]').click();
  await page.waitForURL(/category=festival(%2C|,)booking/, { timeout: 5000 });
  await listReady(page);
  await until(async () => (await rowIds(page)).length === 14);
  cats = await page.locator(".notif-item").evaluateAll((els) => els.map((e) => e.dataset.category));
  check(cats.length === 14 && cats.every((c) => c === "festival" || c === "booking"), "a second chip adds its category", `${cats.length}`);
  await page.locator(".notif-dates__clear").click();
  await until(() => new URL(page.url()).search === "", 5000);
  await listReady(page);
  check(new URL(page.url()).search === "", "Clear filters clears the URL");

  // Search (debounced)
  await page.fill(".notif-search input", SEARCH_WORD);
  await page.waitForURL(new RegExp(`q=${SEARCH_WORD}`), { timeout: 5000 });
  await listReady(page);
  // Three messages mention it, but a3 was archived above, and the inbox view leaves it out.
  await until(async () => (await rowIds(page)).length === 2, 8000);
  check(
    (await rowIds(page)).sort().join() === [a.a12.id, a.a30.id].sort().join(),
    "search finds the inbox messages that mention it (q= in the URL)",
    (await rowIds(page)).join(),
  );

  // Date range
  await page.locator(".notif-dates__clear").click();
  await until(() => new URL(page.url()).search === "", 5000);
  await listReady(page);
  const yesterday = istDay(1);
  await page.fill('input[name="from"]', yesterday);
  await page.fill('input[name="to"]', yesterday);
  await page.waitForURL(new RegExp(`from=${yesterday}&to=${yesterday}`), { timeout: 5000 });
  await listReady(page);
  await until(async () => (await rowIds(page)).length === 4);
  const dayIds = await rowIds(page);
  const expectedDay = PAGE.filter((s) => s.group === "yesterday" && s.key !== "a5").map((s) => s.id);
  check(dayIds.sort().join() === expectedDay.sort().join(), "a date range shows that day only (from= and to= in the URL)", `${dayIds.length}`);
  const groupsNow = await page.locator(".notif-group__title").evaluateAll((els) => els.map((h) => h.dataset.group));
  check(groupsNow.join() === "yesterday", "…under the Yesterday heading alone", groupsNow.join());

  // Filtered-empty
  await page.fill(".notif-search input", "zzqq-nothing-matches");
  await page.locator(".notif-empty--filtered").waitFor({ state: "visible", timeout: 6000 });
  check(/No notifications match these filters/.test(await page.locator(".notif-empty--filtered").innerText()), "no match shows the filtered-empty state");
  await page.locator(".notif-empty--filtered button").click();
  await until(() => new URL(page.url()).search === "", 5000);
  await listReady(page);
  await until(async () => (await rowIds(page)).length === 20, 8000);
  check(new URL(page.url()).search === "" && (await rowIds(page)).length === 20, "…whose Clear filters brings the list back");

  // Error state and retry
  page.expectErrors(true);
  await page.route("**/api/notifications/list**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated failure" }) }),
  );
  await page.reload({ waitUntil: "networkidle" });
  await english(page);
  await page.locator(".notif-page .notif-error").waitFor({ state: "visible", timeout: 8000 });
  check(true, "a failing list shows the error state");
  await page.unroute("**/api/notifications/list**");
  await page.locator(".notif-page .notif-error button").click();
  check(await listReady(page) && (await rowIds(page)).length === 20, "Try again loads the list");
  await page.waitForTimeout(400);
  page.expectErrors(false);

  // A new notification while the page is open: visibilitychange, then focus
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    window.__nuiStillHere = true;
  });
  const unreadInDb = () =>
    Number(one("SELECT COUNT(*) AS n FROM notifications WHERE devotee_id = ? AND read_at IS NULL AND archived_at IS NULL AND deleted_at IS NULL", [A.id]).n);
  const before = unreadInDb();
  const [live1] = seed(A.id, [{ key: "live1", category: "announcement", title: `Live arrival one ${RUN}`, body: "Created while the page was open." }]);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  check(
    await until(async () => (await page.locator(`.notif-item[data-id="${live1.id}"]`).count()) === 1, 8000),
    "a notification created meanwhile appears after visibilitychange",
  );
  check(await waitBell(page, `Notifications, ${before + 1} unread`), "…and the badge counts it", await bellLabel(page));
  check((await rowIds(page))[0] === live1.id, "…at the top of the list");
  await page.waitForLoadState("networkidle");
  const [live2] = seed(A.id, [{ key: "live2", category: "event", title: `Live arrival two ${RUN}`, body: "Created while the page was open, too." }]);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  check(
    await until(async () => (await page.locator(`.notif-item[data-id="${live2.id}"]`).count()) === 1, 8000),
    "another appears after the window regains focus",
  );
  check(await page.evaluate(() => window.__nuiStillHere === true), "…without a reload");
  check(new Set(await rowIds(page)).size === (await rowIds(page)).length, "…and merging never duplicates a row");

  // Another tab
  const page2 = watch(await ctx.newPage());
  await go(page2, "/");
  const unreadNow = (await bellLabel(page)).match(/(\d+) unread/)?.[1];
  check(await waitBell(page2, `Notifications, ${unreadNow} unread`), "a second tab shows the same count", await bellLabel(page2));
  await page.locator('[data-action="mark-all"]').click();
  check(await waitBell(page, "Notifications"), "Mark all as read on the page zeroes its badge");
  check(await waitBell(page2, "Notifications", 6000), "…and the other tab's badge follows without a reload", await bellLabel(page2));
  check(
    await until(() => page.evaluate(() => [...document.querySelectorAll(".notif-page .notif-item")].every((li) => li.dataset.read === "true"))),
    "…and every row on the page shows as read",
  );
  await page2.close();

  // Empty: nothing unread
  await tab(page, "Unread").click();
  await page.waitForURL(/status=unread/, { timeout: 5000 });
  await page.locator(".notif-empty").waitFor({ state: "visible", timeout: 6000 });
  check(/No unread notifications/.test(await page.locator(".notif-empty").innerText()), "the Unread view, emptied, says so");

  const errs = page.errors();
  check(errs.length === 0, "page: no console errors (outside the simulated failure)", errs.slice(0, 3).join(" | "));
  storageA = await ctx.storageState();
  await ctx.close();
} catch (e) {
  threw("Page", e);
}

/* ── 4. Phone: bottom sheet and the drawer row ─────────────────────────── */
try {
  seed(A.id, [
    { key: "m1", category: "booking", priority: "important", title: `Seva booking received ${RUN}`, body: "The office will confirm within a day.", cta: "/sevas" },
    { key: "m2", category: "donation", title: `Receipt ready ${RUN}`, body: "Your 80G receipt is ready to download." },
  ]);
  const ctx = await newContext({ width: 390, height: 844, ipN: 3, storageState: storageA });
  const page = watch(await ctx.newPage());
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  check(await waitBell(page, "அறிவிப்புகள், 2 படிக்கவில்லை"), "the bell speaks Tamil by default", await bellLabel(page));
  await english(page);
  check(await waitBell(page, "Notifications, 2 unread"), "…and English after the toggle");
  const bellBox = await page.locator(".notif-bell").boundingBox();
  check(bellBox && bellBox.x >= 0 && bellBox.x + bellBox.width <= 390, "the bell stays in the header at 390px", JSON.stringify(bellBox));

  await page.locator(".notif-bell").click();
  const sheet = page.locator('.modal.notif-sheet[role="dialog"]');
  await sheet.waitFor({ state: "visible", timeout: 5000 });
  await page.waitForTimeout(600); // let the sheet finish sliding up before measuring it
  await page.waitForFunction(() => document.querySelectorAll(".notif-sheet .notif-item").length === 10, null, { timeout: 8000 });
  const sheetBox = await sheet.boundingBox();
  check(
    sheetBox && Math.round(sheetBox.width) >= 388 && Math.abs(sheetBox.y + sheetBox.height - 844) <= 2,
    "below 640px the panel is a bottom sheet",
    JSON.stringify(sheetBox),
  );
  check((await page.locator(".notif-pop").count()) === 0, "…not the popover");
  check(!(await overflow(page)), "the sheet does not overflow 390px");
  await page.screenshot({ path: "shots/notifications/sheet-390.png" });
  const v = await axe(page);
  check(v.length === 0, "axe: nothing serious or critical with the sheet open", v.slice(0, 4).join("\n      "));
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached", timeout: 3000 });
  check(await until(() => focusOn(page, "notif-bell"), 2000), "Escape closes the sheet and returns focus to the bell");

  await page.locator(".navbar__toggle").click();
  await page.waitForTimeout(500);
  const row = page.locator("#mobile-drawer .drawer__notif");
  check(await row.isVisible(), "the drawer has a Notifications row");
  check((await row.locator(".drawer__notif-count").innerText()) === "2", "…with the unread count");
  check((await row.getAttribute("aria-label")) === "Notifications, 2 unread", "…spoken as part of its name");
  await page.screenshot({ path: "shots/notifications/drawer-390.png" });
  await row.click();
  await page.waitForURL("**/notifications", { timeout: 8000 });
  check((await page.locator("#mobile-drawer").getAttribute("aria-hidden")) === "true", "…which opens /notifications and closes the drawer");
  await listReady(page);
  check(!(await overflow(page)), "/notifications at 390px: no horizontal overflow");
  await page.screenshot({ path: "shots/notifications/page-390.png", fullPage: false });

  const errs = page.errors();
  check(errs.length === 0, "phone: no console errors", errs.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  threw("Phone", e);
}

/* ── 5. No horizontal overflow at four widths ──────────────────────────── */
try {
  for (const w of [390, 768, 1024, 1440]) {
    const ctx = await newContext({ width: w, height: w < 700 ? 844 : 900, ipN: 4, storageState: storageA });
    const page = watch(await ctx.newPage());
    await go(page, "/notifications");
    await listReady(page);
    check(!(await overflow(page)), `/notifications @${w}: no horizontal overflow`);
    check((await page.locator("h1").count()) === 1, `/notifications @${w}: exactly one h1`);
    await page.locator(".notif-bell").click();
    await page.waitForSelector(".notif-pop, .notif-sheet", { timeout: 5000 });
    await page.waitForTimeout(300);
    check(!(await overflow(page)), `/notifications @${w}: no overflow with the panel open`);
    if (w >= 640) {
      const box = await page.locator(".notif-pop").boundingBox();
      check(box && box.x >= 0 && box.x + box.width <= w, `@${w}: the panel sits inside the viewport`, JSON.stringify(box));
    }
    const errs = page.errors();
    check(errs.length === 0, `/notifications @${w}: no console errors`, errs.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  threw("Overflow", e);
}

/* ── 6. The signed-in header fits, by public-e2e's own measure ─────────── */
try {
  const WIDTHS_HEADER = [
    2560, 1920, 1600, 1560, 1559, 1440, 1366, 1340, 1339, 1280, 1250, 1249, 1200, 1100, 1024, 1023, 960, 900,
    768, 700, 640, 639, 620, 560, 520, 480, 460, 430, 400, 390, 375, 370, 360, 320,
  ];
  const measure = () => {
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
    const navEl = document.querySelector(".navbar__nav");
    const vis = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth + 1;
    };
    return {
      spill: Math.max(nav.spill, strip.spill),
      sel: nav.spill >= strip.spill ? nav.sel : `strip: ${strip.sel}`,
      navClip: navEl && getComputedStyle(navEl).display !== "none" ? navEl.scrollWidth - navEl.clientWidth : 0,
      bell: vis(document.querySelector(".notif-bell")),
      menu: vis(document.querySelector(".navbar__toggle")) || vis(document.querySelector(".navbar__acct-btn")),
      lang: vis(document.querySelector(".lang-toggle")),
    };
  };
  const problems = [];
  for (const w of WIDTHS_HEADER) {
    const member = await newContext({ width: w, height: 840, ipN: 6, storageState: storageA });
    const mp = await member.newPage();
    await mp.goto(BASE + "/", { waitUntil: "networkidle" });
    await mp.waitForSelector(".notif-bell", { timeout: 8000 }).catch(() => {});
    await mp.waitForTimeout(250);
    const m = await mp.evaluate(measure);
    // Once the page scrolls, the header becomes a floating island that is
    // narrower than the band at the top; it has to fit as well.
    await mp.evaluate(() => window.scrollTo(0, 700));
    await mp.waitForTimeout(700);
    const ms = await mp.evaluate(measure);
    await member.close();

    const guest = await newContext({ width: w, height: 840, ipN: 7 });
    const gp = await guest.newPage();
    await gp.goto(BASE + "/", { waitUntil: "networkidle" });
    await gp.waitForTimeout(250);
    const g = await gp.evaluate(measure);
    await guest.close();

    if (m.spill > 1) problems.push(`${w}px: ${m.sel} +${m.spill}px`);
    if (ms.spill > 1) problems.push(`${w}px scrolled: ${ms.sel} +${ms.spill}px`);
    if (!m.bell) problems.push(`${w}px: bell not fully visible`);
    if (!m.menu) problems.push(`${w}px: neither the menu nor the account button is reachable`);
    if (!m.lang) problems.push(`${w}px: language toggle not reachable`);
    if (m.navClip > g.navClip + 1) problems.push(`${w}px: nav clipped ${m.navClip}px signed in vs ${g.navClip}px as a guest`);
  }
  check(problems.length === 0, `signed-in header fits, at the top and scrolled, with the bell visible at ${WIDTHS_HEADER.length} widths (320–2560)`, problems.slice(0, 5).join(" | "));
} catch (e) {
  threw("Header fit", e);
}

/* ── 7. A devotee with no notifications ────────────────────────────────── */
try {
  const ctx = await newContext({ width: 1024, height: 800, ipN: 8 });
  const page = watch(await ctx.newPage());
  await signIn(page, E.email);
  await page.locator(".notif-page .notif-empty").waitFor({ state: "visible", timeout: 10000 });
  check(/You're all caught up/.test(await page.locator(".notif-empty").innerText()), "an empty account shows You're all caught up");
  check((await page.locator(".notif-empty--filtered").count()) === 0, "…not the filtered-empty state");
  check((await bellLabel(page)) === "Notifications" && (await page.locator(".notif-bell__count").count()) === 0, "the bell has no badge");
  await page.locator(".notif-bell").click();
  await page.locator(".notif-pop .empty-state").waitFor({ state: "visible", timeout: 6000 });
  check(/You're all caught up/.test(await page.locator(".notif-pop").innerText()), "the panel's empty state says the same");
  check((await page.locator(".notif-panel__markall").isDisabled()), "…and Mark all as read is disabled");
  const errs = page.errors();
  check(errs.length === 0, "empty account: no console errors", errs.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  threw("Empty account", e);
}

/* ── Report and cleanup ────────────────────────────────────────────────── */
await browser.close();

try {
  const ids = [P.id, A.id, E.id];
  fixtures("cleanup", { email_prefix: `${EMAIL_PREFIX}${RUN}-` });
  sql(
    `DELETE FROM rate_limits WHERE bucket LIKE ? OR bucket IN (${ids.map(() => "?").join(",")})`,
    [`login-ip:10.41.${OCTET}.%`, ...ids.map((id) => `notif-post:d${id}`)],
  );
  const left = one("SELECT COUNT(*) AS n FROM devotees WHERE email LIKE ?", [`${EMAIL_PREFIX}${RUN}-%`]);
  const orphans = one("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key LIKE ?", [`${DEDUPE}:%`]);
  check(Number(left.n) === 0 && Number(orphans.n) === 0, "cleanup removed this run's devotees and notifications", `${left.n} devotees, ${orphans.n} notifications left`);
} catch (e) {
  fail("cleanup", String(e?.message || e).slice(0, 200));
}

let passed = 0;
for (const r of results) {
  if (r.ok) passed += 1;
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail && !r.ok ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
