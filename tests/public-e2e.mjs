// End-to-end tests for the public site (Vite dev server + real PHP API + MySQL).
//   node public.mjs [baseUrl]            (default http://127.0.0.1:5173)
// Covers: every route at 4 widths (console errors, single h1, no horizontal
// overflow, axe-core serious/critical violations), language toggle, mobile
// drawer + keyboard, seva booking modal (focus trap, validation, real submit),
// contact + donation forms, events filter, panchangam navigation, chatbot, 404.
import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";

const base = process.argv[2] || "http://127.0.0.1:5173";
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
mkdirSync("shots/public", { recursive: true });
// screenshots land in ./shots next to wherever you run this from

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail = "") => (cond ? pass(name, detail) : fail(name, detail));

const browser = await chromium.launch();
const IGNORE = /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js/;

async function newPage(width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[console] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => { if (!IGNORE.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
  page.errors = () => errors.filter((e) => !IGNORE.test(e));
  return page;
}
async function scrollThrough(page) {
  await page.addStyleTag({ content: "html{scroll-behavior:auto !important}" });
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.waitForTimeout(600);
  const stuck = await page.evaluate(() => document.querySelectorAll(".reveal:not(.is-visible)").length);
  if (stuck) console.log("   (note: " + stuck + " .reveal blocks still hidden after the sweep)");
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
async function axe(page) {
  await page.addScriptTag({ content: axeSource });
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] }, rules: { "color-contrast": { enabled: true } } });
    return res.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
  });
  return r;
}

const ROUTES = ["/", "/about", "/sevas", "/events", "/panchangam", "/donations", "/contact", "/definitely-not-a-page"];
const WIDTHS = [390, 768, 1024, 1440];

for (const route of ROUTES) {
  for (const w of WIDTHS) {
    const page = await newPage(w, w < 700 ? 844 : 900);
    await page.goto(base + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    const h1s = await page.locator("h1").count();
    check(h1s === 1, `${route} @${w}: exactly one h1`, `found ${h1s}`);
    check(!(await overflow(page)), `${route} @${w}: no horizontal overflow`);
    const errs = page.errors();
    check(errs.length === 0, `${route} @${w}: no console errors`, errs.slice(0, 3).join(" | "));
    if (w === 1440 || w === 390) {
      await scrollThrough(page);
      await page.screenshot({ path: `shots/public/${route === "/" ? "home" : route.slice(1)}-${w}.png`, fullPage: true });
    }
    if (w === 1440 && route !== "/definitely-not-a-page") {
      const v = await axe(page);
      check(v.length === 0, `${route}: axe serious/critical violations`, v.slice(0, 6).join("\n      "));
    }
    await page.context().close();
  }
}

// Language toggle
try {
  const page = await newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  const before = await page.evaluate(() => document.documentElement.lang);
  await page.click('.lang-toggle__btn[lang="en"]');
  const after = await page.evaluate(() => document.documentElement.lang);
  check(before === "ta" && after === "en", "language toggle switches <html lang>", `${before} → ${after}`);
  check(await page.locator(".navbar__nav").innerText().then((t) => /Home/.test(t)), "language toggle re-renders navigation in English");
  await page.context().close();
} catch (e) { fail("Language toggle (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Mobile drawer + keyboard
try {
  const page = await newPage(390, 844);
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.click(".navbar__toggle");
  await page.waitForTimeout(450);
  check(await page.locator("#mobile-drawer").getAttribute("aria-hidden").then((v) => v === "false"), "drawer opens (aria-hidden=false)");
  const focusInDrawer = await page.evaluate(() => document.activeElement?.closest("#mobile-drawer") != null);
  check(focusInDrawer, "drawer moves focus inside");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(450);
  check(await page.locator("#mobile-drawer").getAttribute("aria-hidden").then((v) => v === "true"), "Escape closes drawer");
  const focusBack = await page.evaluate(() => document.activeElement?.classList.contains("navbar__toggle"));
  check(focusBack, "focus returns to hamburger after close");
  check(await page.locator(".bottom-nav").isVisible(), "bottom nav visible on mobile");
  await page.context().close();
} catch (e) { fail("Mobile drawer + keyboard (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Seva booking modal: focus trap, validation, real submission
try {
  const page = await newPage();
  await page.goto(base + "/sevas", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const book = page.locator("button", { hasText: /Book|பதிவு/ }).first();
  await book.click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible" });
  check(await dialog.count() === 1, "booking modal opens");
  const inside = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null);
  check(inside, "modal takes focus");
  let trapped = true;
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press("Tab");
    if (!(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null))) { trapped = false; break; }
  }
  check(trapped, "Tab focus stays trapped in modal");
  await dialog.locator('button[type="submit"]').click();
  await page.waitForTimeout(300);
  const alerts = await dialog.locator('[role="alert"]').count();
  check(alerts >= 1, "empty submit shows field errors", `${alerts} alerts`);
  const stamp = "E2E-" + Date.now().toString().slice(-6);
  await dialog.locator('input[name="devotee_name"]').fill(stamp);
  await dialog.locator('input[name="phone"]').fill("9876501234");
  await dialog.locator('button[type="submit"]').click();
  await page.waitForTimeout(2500);
  const success = await dialog.innerText();
  check(/received|பெறப்பட்டது/i.test(success), "booking submits to real API and shows success", success.slice(0, 80));
  check(await page.locator(".toast").count() >= 1, "success toast appears");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(await page.locator('[role="dialog"]').count() === 0, "Escape closes modal after success");
  check(page.errors().length === 0, "sevas flow: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
  results.push({ ok: true, name: `booking created as ${stamp} (clean up in DB)`, detail: stamp, cleanup: stamp });
} catch (e) { fail("Seva booking modal: focus trap, validation, real submission (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Contact form
try {
  const page = await newPage();
  await page.goto(base + "/contact", { waitUntil: "networkidle" });
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(300);
  check((await page.locator('form [role="alert"]').count()) >= 2, "contact: validation errors on empty submit");
  const stamp = "E2E-MSG-" + Date.now().toString().slice(-6);
  await page.fill('input[name="name"]', stamp);
  await page.fill('input[name="phone"]', "9876504321");
  await page.fill('textarea[name="message"]', "Automated e2e test message — safe to delete.");
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(2500);
  check((await page.locator('[role="status"], .alert--success').filter({ hasText: /sent|அனுப்பப்பட்டது/i }).count()) >= 1, "contact: success feedback shown");
  check(page.errors().length === 0, "contact: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
  results.push({ ok: true, name: `message created as ${stamp}`, cleanup: stamp });
} catch (e) { fail("Contact form (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Donations form + quick amount chip
try {
  const page = await newPage();
  await page.goto(base + "/donations", { waitUntil: "networkidle" });
  const chip = page.locator('button', { hasText: /₹1001|₹1,001/ }).first();
  await chip.click();
  const amount = await page.inputValue('input[name="amount"]');
  check(amount === "1001", "donation quick-amount chip fills amount", amount);
  const stamp = "E2E-DON-" + Date.now().toString().slice(-6);
  await page.fill('input[name="name"]', stamp);
  await page.fill('input[name="phone"]', "9876509999");
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(2500);
  check((await page.locator('.alert--success, [role="status"]').filter({ hasText: /recorded|பதிவு/i }).count()) >= 1, "donation: success feedback shown");
  check(page.errors().length === 0, "donations: no console errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
  results.push({ ok: true, name: `donation created as ${stamp}`, cleanup: stamp });
} catch (e) { fail("Donations form + quick amount chip (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Events filter tabs + keyboard
try {
  const page = await newPage();
  await page.goto(base + "/events", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const tabs = page.locator('[role="tablist"] [role="tab"]');
  check((await tabs.count()) >= 3, "events: filter tabs rendered");
  await tabs.nth(1).click();
  await page.waitForTimeout(300);
  check(await tabs.nth(1).getAttribute("aria-selected").then((v) => v === "true"), "events: clicking a tab selects it");
  await tabs.nth(1).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  check(await tabs.nth(2).getAttribute("aria-selected").then((v) => v === "true"), "events: ArrowRight moves selection");
  await page.context().close();
} catch (e) { fail("Events filter tabs + keyboard (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Panchangam navigation
try {
  const page = await newPage();
  await page.goto(base + "/panchangam", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const label = page.locator(".panchang-nav__label").first();
  const before = await label.innerText();
  await page.locator('.panchang-nav__month button').nth(1).click();
  await page.waitForTimeout(1200);
  const after = await label.innerText();
  check(before !== after, "panchangam: next month changes the label", `${before} → ${after}`);
  check((await page.locator(".panchang__cell, .panchang-cell").count()) >= 28, "panchangam: day cells rendered");
  await page.context().close();
} catch (e) { fail("Panchangam navigation (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

// Chatbot round-trip (rule-based fallback on the backend)
try {
  const page = await newPage();
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.click(".chatbot__trigger");
  await page.waitForTimeout(400);
  await page.fill(".chatbot__input", "temple timings");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  const bubbles = await page.locator(".chatbot__bubble--assistant").count();
  check(bubbles >= 2, "chatbot: reply bubble received", `${bubbles} assistant bubbles`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator(".chatbot__window").count()) === 0, "chatbot: Escape closes window");
  await page.context().close();
} catch (e) { fail("Chatbot round-trip (rule-based fallback on the backend) (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160)); }

await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
const cleanup = results.filter((r) => r.cleanup).map((r) => r.cleanup);
if (cleanup.length) console.log("CLEANUP:", cleanup.join(","));
process.exit(failed.length ? 1 : 0);
