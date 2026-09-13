// End-to-end tests for the public site (Vite dev server + real PHP API + MySQL).
//   PHP_BIN=/path/to/php node public-e2e.mjs [baseUrl]   (default http://127.0.0.1:5173)
// Covers: every route at 4 widths (console errors, single h1, no horizontal
// overflow, axe-core serious/critical violations), language toggle, mobile
// drawer + keyboard, seva booking modal (focus trap, validation, real submit),
// contact + donation forms, events filter, panchangam navigation, chatbot, 404.
// Launch fixes: the donor's thank-you-list consent reaching /api/donors, the
// honeypot field staying out of sight, Tab order and the accessibility tree,
// no reviews section without a Google key, the remembered language, and the
// friendly message every form and the chatbot show for HTTP 429.
//
// PHP_BIN (php, or a .sh wrapper that exports the DB environment) is used only
// to remove the pledges the consent scenario creates and to reset that
// scenario's own rate-limit buckets, through tests/support/notify_fixtures.php.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// playwright and axe-core are devDependencies of frontend/, and Node resolves a
// bare specifier from this file's own directory upwards — which never reaches
// frontend/node_modules. Resolving explicitly means "cd frontend && npm install"
// is the only setup step, with no symlink or root install to remember.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
import { mkdirSync, readFileSync } from "node:fs";

const base = process.argv[2] || "http://127.0.0.1:5173";
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
mkdirSync("shots/public", { recursive: true });
// screenshots land in ./shots next to wherever you run this from

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail = "") => (cond ? pass(name, detail) : fail(name, detail));

/* ── Database access for cleanup, through the shared fixtures script ─────── */
const REPO = fileURLToPath(new URL("..", import.meta.url));
const PHP_BIN = process.env.PHP_BIN || "php";
/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const cliJson = (obj) => JSON.stringify(obj).replace(/[-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
function sql(query, params = []) {
  const args = ["tests/support/notify_fixtures.php", "sql", cliJson({ query, params })];
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: REPO, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const line = (r.stdout || "").trim().split("\n").filter(Boolean).pop() ?? "";
  let out;
  try { out = JSON.parse(line); } catch { throw new Error(`fixtures sql printed no JSON (exit ${r.status}): ${(r.stdout || "").slice(-200)} ${(r.stderr || "").slice(-200)}`); }
  if (out.error) throw new Error(`fixtures sql: ${out.error}`);
  return out;
}

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
  // Two toggles now: one in the status strip, one in the footer. Take the first.
  await page.locator('.lang-toggle__btn[lang="en"]').first().click();
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

// Header fit — the row must sit inside its own container at every width.
//
// The navbar clips its overflow, so a row that is too wide loses its rightmost
// controls silently: no scrollbar, no console error, nothing a "no horizontal
// overflow" check would catch. That is exactly how the brand, seven Tamil nav
// labels and the right-hand controls came to be ~560px wider than the bar.
// This measures the real thing, at breakpoint boundaries and either side.
try {
  const WIDTHS_HEADER = [
    2560, 1920, 1600, 1560, 1559, 1440, 1366, 1340, 1339, 1280, 1200, 1100, 1024, 1023, 960, 900,
    768, 700, 640, 620, 560, 480, 460, 430, 400, 390, 375, 370, 360, 320,
  ];
  const spills = [];
  for (const w of WIDTHS_HEADER) {
    const page = await newPage(w, 840);
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(250);
    const worst = await page.evaluate(() => {
      // Both bands: the navbar row and the status strip above it, which now
      // carries the language toggle at the same right edge.
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
      return {
        spill: Math.max(nav.spill, strip.spill),
        sel: nav.spill >= strip.spill ? nav.sel : `strip: ${strip.sel}`,
        // The language toggle is the only way to switch language on desktop,
        // so it must stay inside the viewport at every width.
        langVisible: !!langBox && langBox.width > 0 && langBox.right <= document.documentElement.clientWidth + 1,
      };
    });
    if (worst.spill > 1) spills.push(`${w}px: ${worst.sel} +${worst.spill}px`);
    if (!worst.langVisible) spills.push(`${w}px: language toggle not reachable`);
    await page.context().close();
  }
  check(spills.length === 0, `header and status strip fit, language toggle reachable, at ${WIDTHS_HEADER.length} widths`, spills.slice(0, 4).join(" | "));
} catch (e) {
  fail("Header fit (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160));
}

// Sign-in / Sign-up must be reachable from the header at every width.
try {
  for (const w of [1920, 1440, 1024, 768, 390]) {
    const page = await newPage(w, 840);
    await page.goto(base + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => {
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.right <= document.documentElement.clientWidth + 1;
      };
      return {
        signup: vis(document.querySelector(".navbar__signup")),
        login: vis(document.querySelector(".navbar__login")),
        toggle: vis(document.querySelector(".navbar__toggle")),
      };
    });
    // Below 920px Login lives in the drawer, so the hamburger is what must show.
    const ok = seen.signup && (seen.login || seen.toggle);
    check(ok, `@${w}: sign-up is visible and sign-in is reachable`, JSON.stringify(seen));
    await page.context().close();
  }
} catch (e) {
  fail("Header auth entry points (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160));
}

// The PHP paths must not be swallowed by the React router.
//
// In production public_html/.htaccess passes ^(api|admin|uploads) through
// before the SPA fallback. The dev server needs the matching proxy entries, or
// /admin/ renders the React 404 page and the committee cannot sign in. This
// checks the behaviour a person actually hits, not the config file.
try {
  const page = await newPage();
  const res = await page.goto(base + "/admin/", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const title = await page.title();
  const isSpa404 = await page.evaluate(() => !!document.querySelector("#root .notfound, #root h1"));
  check(
    /admin/i.test(title) && !/^\s*$/.test(title),
    "/admin/ is served by PHP, not the React router",
    `title "${title}", status ${res?.status()}`,
  );
  check(!isSpa404, "/admin/ does not render the SPA shell");
  check(
    /login\.php/.test(page.url()),
    "/admin/ redirects an unauthenticated visitor to the admin sign-in",
    page.url(),
  );
  const errs = page.errors();
  check(errs.length === 0, "/admin/ loads its own assets cleanly", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Admin routing (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 160));
}

// Sharing: the sheet, the channels, copy-to-clipboard, and the item deep links
// those channels hand out. The preview metadata a crawler receives is a separate
// suite (tests/og.mjs) — this is only the part a visitor touches.
try {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-IN",
    // Granting clipboard-write lets the async Clipboard API succeed, which is
    // the path a real visitor on https takes. The execCommand fallback is what
    // runs without it, and the button has to work either way — so the copy is
    // asserted by reading the clipboard back, not by trusting the label.
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(base + "/gallery", { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  const trigger = page.locator(".share-btn").first();
  check(await trigger.count() === 1, "the gallery hero offers a share control");
  check(
    (await trigger.getAttribute("aria-haspopup")) === "dialog" &&
      (await trigger.getAttribute("aria-expanded")) === "false",
    "…announced as a closed dialog trigger",
  );

  await trigger.click();
  const sheet = page.locator('[role="dialog"].share-sheet');
  await sheet.waitFor({ state: "visible" });
  check(await sheet.count() === 1, "clicking it opens the share sheet");
  check(
    (await trigger.getAttribute("aria-expanded")) === "true",
    "…and the trigger now reports itself expanded",
  );
  check(
    await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') != null),
    "…with focus moved inside",
  );

  // Every channel is a real outbound link carrying this page's own URL.
  const links = await sheet.locator("a.share-opt").evaluateAll((els) =>
    els.map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: a.innerText.trim() })),
  );
  check(links.length === 5, "five channels are offered", links.map((l) => l.text).join(", "));
  const encoded = encodeURIComponent(base + "/gallery");
  for (const [host, label] of [
    ["wa.me", "WhatsApp"],
    ["facebook.com/sharer", "Facebook"],
    ["linkedin.com/sharing", "LinkedIn"],
    ["twitter.com/intent", "X"],
  ]) {
    const link = links.find((l) => l.href.includes(host));
    check(!!link, `${label} links to ${host}`);
    check(
      !!link && (link.href.includes(encoded) || link.href.includes(encodeURIComponent(base + "/gallery").replace(/%2F$/, ""))),
      `${label} carries this page's own address`,
      link?.href.slice(0, 110),
    );
    check(!!link && link.target === "_blank" && /noopener/.test(link.rel ?? ""), `${label} opens safely in a new tab`);
  }
  const mail = links.find((l) => l.href.startsWith("mailto:"));
  check(!!mail, "Email uses a mailto: link");
  check(!!mail && mail.target === null, "…and does not leave an empty tab behind");

  // The link is shown, not just copied, so a browser that refuses the clipboard
  // still leaves something a visitor can select.
  const shown = await sheet.locator(".share-link__url").inputValue();
  check(shown === base + "/gallery", "the sheet shows the link itself", shown);

  await sheet.locator(".share-link__btn").click();
  await page.waitForTimeout(500);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
  check(clip === base + "/gallery", "Copy link puts the address on the clipboard", clip || "(empty)");
  // The site opens in Tamil, so the confirmation is asserted in either language.
  const COPIED = /copied|நகலெடுக்கப்பட்டது/i;
  check(COPIED.test(await sheet.locator(".share-link__btn").innerText()), "…and the button confirms it", await sheet.locator(".share-link__btn").innerText());
  check(
    COPIED.test(await sheet.locator(".share-note").innerText()),
    "…with the result in a live region for screen readers",
  );
  check(await page.locator(".toast--success").count() >= 1, "…and a toast");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check(await page.locator(".share-sheet").count() === 0, "Escape closes the sheet");
  check(
    await page.evaluate(() => document.activeElement?.classList.contains("share-btn")),
    "…returning focus to the trigger that opened it",
  );

  // One photograph, shared and reopened from its own address.
  const tiles = page.locator(".gallery-tile");
  if (await tiles.count()) {
    await tiles.first().click();
    await page.waitForTimeout(600);
    const url = new URL(page.url());
    const photoId = url.searchParams.get("photo");
    check(!!photoId, "opening a photo puts it in the address bar", page.url());

    const lightboxShare = page.locator(".gallery-lightbox__share");
    check(await lightboxShare.count() === 1, "the lightbox offers its own share control");
    await lightboxShare.click();
    await page.waitForTimeout(500);
    const photoUrl = await page.locator(".share-link__url").inputValue();
    check(photoUrl.endsWith(`/gallery?photo=${photoId}`), "…sharing that photograph, not the gallery", photoUrl);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check(!new URL(page.url()).searchParams.get("photo"), "closing the photo clears it from the address bar", page.url());

    // The link, opened cold.
    await page.goto(`${base}/gallery?photo=${photoId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    check(
      await page.locator(".gallery-lightbox").count() === 1,
      "a shared photo link opens that photograph on arrival",
    );
    await page.keyboard.press("Escape");
  } else {
    results.push({ ok: true, name: "no gallery photos in the database — photo deep link not exercised", detail: "" });
  }

  // The same for a seva: the card's share button hands out a bookable link.
  await page.goto(base + "/sevas", { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const cardShare = page.locator(".seva-card__share").first();
  check(await cardShare.count() === 1, "each seva card offers a share control");
  await cardShare.click();
  await page.waitForTimeout(500);
  check(
    await page.locator(".share-sheet").count() === 1,
    "sharing a seva does not also open its booking form",
  );
  const sevaUrl = await page.locator(".share-link__url").inputValue();
  const sevaId = /seva=(\d+)/.exec(sevaUrl)?.[1];
  check(!!sevaId, "…and the link names that seva", sevaUrl);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  if (sevaId) {
    await page.goto(`${base}/sevas?seva=${sevaId}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    check(
      await page.locator('[role="dialog"]').count() === 1,
      "a shared seva link arrives with the booking form already open",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    check(!new URL(page.url()).searchParams.get("seva"), "closing it clears the seva from the address bar", page.url());
  }

  const v = await axe(page);
  check(v.length === 0, "sharing: axe serious/critical violations", v.slice(0, 4).join("\n      "));
  check(errors.length === 0, "sharing: no page errors", errors.slice(0, 2).join(" | "));
  await ctx.close();
} catch (e) {
  fail("Sharing (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── Launch fixes ─────────────────────────────────────────────────────────
   Each scenario below is its own client: API requests carry X-Forwarded-For
   10.71.<n>.<n> (the PHP server trusts the loopback proxy), so the flood limits
   they spend never collide with the rest of this suite or with another suite
   running at the same time. Those buckets are reset first so a second run
   within the hour starts from the same place. */
const clientIp = (n) => `10.71.${n}.${n}`;
async function newClientPage(n, { width = 1440, height = 900, context } = {}) {
  const ctx = context ?? (await browser.newContext({ viewport: { width, height }, locale: "en-IN" }));
  // Only the site's own API calls, so no third-party request ever carries it.
  await ctx.route(`${base}/api/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": clientIp(n) } }),
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.errors = () => errors;
  return page;
}
async function chooseLang(page, lang) {
  await page.locator(`.lang-toggle__btn[lang="${lang}"]`).first().click();
  await page.waitForTimeout(250);
}
const htmlLang = (page) => page.evaluate(() => document.documentElement.lang);

try {
  // Exact suffixes rather than a REGEXP: backslashes do not survive the Windows
  // command line on their way to the fixtures script.
  const mine = [1, 2, 3, 4, 5].map((n) => `%:${clientIp(n)}`);
  const r = sql(`DELETE FROM rate_limits WHERE ${mine.map(() => "bucket LIKE ?").join(" OR ")}`, mine);
  pass("launch fixes: own rate-limit buckets reset", `${r.affected} row(s)`);
} catch (e) {
  fail("launch fixes: resetting own rate-limit buckets (set PHP_BIN)", String(e.message || e).slice(0, 160));
}

// Donor consent: only a ticked box puts the name on /api/donors.
const consentNames = [];
try {
  const page = await newClientPage(1);
  const posted = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/donations")) posted.push(r.postDataJSON());
  });
  await page.goto(base + "/donations", { waitUntil: "networkidle" });
  await chooseLang(page, "en");

  const box = page.locator('input[name="showNamePublicly"]');
  check((await box.count()) === 1 && !(await box.isChecked()), "consent: thank-you-list box is present and unticked by default");
  check(
    (await page.getByRole("checkbox", { name: "Show my name on the temple's thank-you list" }).count()) === 1,
    "consent: the box is labelled for assistive technology",
  );
  const hint = await page.locator("#donation-show-name-hint").innerText();
  check(/only your name and the purpose/i.test(hint) && /never your phone number or the amount/i.test(hint), "consent: hint says only name and purpose are shown", hint);
  await chooseLang(page, "ta");
  check(/நன்றிப் பட்டியலில்/.test(await page.locator(".donations-pledge__consent").innerText()), "consent: label is translated into Tamil");
  await chooseLang(page, "en");

  const stamp = Date.now().toString().slice(-7);
  const publicName = `E2E-DON-PUB-${stamp}`;
  const privateName = `E2E-DON-PRIV-${stamp}`;
  consentNames.push(publicName, privateName);

  async function pledge(name, consent) {
    await page.fill('input[name="name"]', name);
    await page.fill('input[name="phone"]', "9876509999");
    await page.fill('input[name="amount"]', "501");
    await page.selectOption('select[name="purpose"]', "annadanam");
    if (consent) await box.check();
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/api/donations"));
    await page.click('form button[type="submit"]');
    const res = await response;
    await page.waitForTimeout(400);
    return res.status();
  }

  const s1 = await pledge(publicName, true);
  check(s1 === 201, "consent: pledge with the box ticked is saved", `HTTP ${s1}`);
  check(!(await box.isChecked()) && (await page.inputValue('input[name="name"]')) === "", "consent: the box and the form reset after a successful pledge");
  const s2 = await pledge(privateName, false);
  check(s2 === 201, "consent: pledge without the box is saved", `HTTP ${s2}`);

  check(posted[0]?.showNamePublicly === true && posted[1]?.showNamePublicly === false, "consent: showNamePublicly is sent as a JSON boolean", JSON.stringify(posted.map((p) => p?.showNamePublicly)));
  check(posted.every((p) => p?.hp_token === ""), "honeypot: an untouched form sends an empty hp_token");

  const donors = await (await page.request.get(base + "/api/donors")).json();
  const mine = donors.filter((d) => d.name === publicName);
  check(mine.length === 1 && mine[0].type === "donor", "consent: a ticked pledge appears in /api/donors", JSON.stringify(mine));
  check(!donors.some((d) => d.name === privateName), "consent: an unticked pledge does not appear in /api/donors");
  check(
    mine.length === 1 && Object.keys(mine[0]).every((k) => ["name", "label", "type"].includes(k)),
    "consent: the donor item carries no phone number or amount",
    JSON.stringify(mine[0] ?? {}),
  );
  check(page.errors().length === 0, "consent: no page errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Donor consent (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
} finally {
  if (consentNames.length) {
    try {
      const marks = consentNames.map(() => "?").join(",");
      // Queued thank-you messages first; deliveries cascade from notifications.
      sql(
        `DELETE FROM notifications WHERE entity_type = 'donation' AND entity_id IN (SELECT id FROM (SELECT id FROM donations WHERE name IN (${marks})) AS d)`,
        consentNames,
      );
      const r = sql(`DELETE FROM donations WHERE name IN (${marks})`, consentNames);
      check(r.affected === 2, "consent: test pledges removed from the database", `${r.affected} row(s)`);
    } catch (e) {
      fail("consent: removing test pledges (set PHP_BIN)", String(e.message || e).slice(0, 160));
    }
  }
}

// Honeypot: out of sight, out of the Tab order, out of the accessibility tree.
try {
  const page = await newClientPage(2);
  async function honeypot(label, scope, startSelector) {
    const hp = scope.locator('input[name="hp_token"]');
    check((await hp.count()) === 1, `${label}: honeypot field present`);
    // The input keeps its own size; what hides it is the 1px clipping wrapper
    // (.visually-hidden), so that is what is measured.
    const hidden = await hp.evaluate((el) => {
      const wrap = el.parentElement;
      const box = wrap.getBoundingClientRect();
      const cs = getComputedStyle(wrap);
      return { w: box.width, h: box.height, overflow: cs.overflow, clip: cs.clip };
    });
    check(
      hidden.w <= 1 && hidden.h <= 1 && hidden.overflow === "hidden",
      `${label}: honeypot is not visible`,
      JSON.stringify(hidden),
    );
    check(
      (await hp.getAttribute("tabindex")) === "-1" && (await hp.getAttribute("autocomplete")) === "off",
      `${label}: honeypot has tabindex -1 and autocomplete off`,
    );
    check(await hp.evaluate((el) => el.closest('[aria-hidden="true"]') !== null), `${label}: honeypot wrapper is aria-hidden`);
    const HP_LABEL = /Leave this field empty|காலியாக விடவும்/;
    check((await scope.getByRole("textbox", { name: HP_LABEL }).count()) === 0, `${label}: honeypot is not exposed as a textbox`);
    check(!HP_LABEL.test(await scope.ariaSnapshot()), `${label}: honeypot is absent from the accessibility tree`);
    await scope.locator(startSelector).focus();
    let landed = false;
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.getAttribute("name") === "hp_token")) {
        landed = true;
        break;
      }
    }
    check(!landed, `${label}: Tab never lands on the honeypot`);
  }

  await page.goto(base + "/contact", { waitUntil: "networkidle" });
  await honeypot("contact", page.locator("form").filter({ has: page.locator('textarea[name="message"]') }), 'input[name="name"]');

  await page.goto(base + "/donations", { waitUntil: "networkidle" });
  await honeypot("donation", page.locator("form.donations-pledge__form"), 'input[name="name"]');

  await page.goto(base + "/sevas", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator(".seva-card__book").first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible" });
  await honeypot("seva booking", dialog, 'input[name="devotee_name"]');
  await page.context().close();
} catch (e) {
  fail("Honeypot (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

// Reviews: with no Google key the Home page shows no reviews at all.
try {
  const page = await newClientPage(3);
  const reviewsCall = page.waitForResponse((r) => r.url().includes("/api/reviews"), { timeout: 15000 });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  const api = await (await reviewsCall).json().catch(() => null);
  if (api?.configured && api.reviews?.length) {
    results.push({ ok: true, name: "reviews: a Google key is configured here — the no-key checks were not exercised", detail: "" });
  } else {
    await scrollThrough(page);
    check(
      (await page.locator('#home-reviews-title, [aria-labelledby="home-reviews-title"], .reviews-summary, .reviews-card').count()) === 0,
      "reviews: no reviews section on Home without a Google key",
      JSON.stringify(api).slice(0, 90),
    );
    const text = await page.locator("body").innerText();
    const SAMPLES = /Kavitha Rajan|Murugan S\b|Lakshmi Priya|Senthil Kumar|Valarmathi D|Rajesh Naidu/;
    check(!SAMPLES.test(text), "reviews: no sample reviewer names on Home");
    check(!/Rate on Google|Google-ல் மதிப்பீடு/.test(text), "reviews: no Rate on Google button without reviews");
    check(
      await page.evaluate(() => [...document.querySelectorAll("main section")].every((s) => s.getBoundingClientRect().height > 40 || s.hidden)),
      "reviews: no empty section is left in the Home layout",
    );
  }
  const source = await (await page.request.get(base + "/src/components/Reviews/Reviews.jsx")).text();
  check(!/Kavitha Rajan|FALLBACK_REVIEWS/.test(source), "reviews: the built-in sample reviews are gone from the component");
  await page.context().close();
} catch (e) {
  fail("Reviews (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

// Remembered language.
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-IN" });
  const page = await newClientPage(4, { context: ctx });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  check((await htmlLang(page)) === "ta", "language: a first visit opens in Tamil");
  await chooseLang(page, "en");
  check((await page.evaluate(() => localStorage.getItem("temple:lang"))) === "en", "language: the choice is stored as temple:lang");

  await page.reload({ waitUntil: "networkidle" });
  check((await htmlLang(page)) === "en" && /Home/.test(await page.locator(".navbar__nav").innerText()), "language: English survives a reload");

  await page.goto(base + "/sevas", { waitUntil: "networkidle" });
  check((await htmlLang(page)) === "en" && /Sevas/.test(await page.locator("h1").innerText()), "language: English survives a full navigation", await page.locator("h1").innerText());
  await page.locator('.navbar__nav a[href="/about"]').first().click();
  await page.waitForTimeout(800);
  check((await htmlLang(page)) === "en" && new URL(page.url()).pathname === "/about", "language: English survives an in-app navigation");

  // A second tab follows a change made in the first.
  const other = await ctx.newPage();
  await other.goto(base + "/", { waitUntil: "networkidle" });
  check((await htmlLang(other)) === "en", "language: a new tab opens in the remembered language");
  await chooseLang(other, "ta");
  await page.waitForTimeout(400);
  check((await htmlLang(page)) === "ta", "language: switching in one tab updates the other");
  await ctx.close();

  const fresh = await newClientPage(4);
  await fresh.goto(base + "/", { waitUntil: "networkidle" });
  check((await htmlLang(fresh)) === "ta", "language: a fresh browser context starts in Tamil");
  await fresh.context().close();

  const junk = await newClientPage(4);
  await junk.addInitScript(() => localStorage.setItem("temple:lang", "fr"));
  await junk.goto(base + "/", { waitUntil: "networkidle" });
  check((await htmlLang(junk)) === "ta", "language: an unknown stored value falls back to Tamil");
  await junk.context().close();

  // Private browsing, or blocked site data: storage throws instead of returning null.
  const blocked = await newClientPage(4);
  await blocked.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
  });
  await blocked.goto(base + "/", { waitUntil: "networkidle" });
  await chooseLang(blocked, "en");
  check(
    (await htmlLang(blocked)) === "en" && blocked.errors().length === 0,
    "language: with storage blocked the site still loads and the toggle still works",
    blocked.errors().slice(0, 2).join(" | "),
  );
  await blocked.context().close();
} catch (e) {
  fail("Remembered language (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

// HTTP 429: every form and the chatbot explain it in plain words.
try {
  const LIMITED = {
    status: 429,
    contentType: "application/json",
    headers: { "Retry-After": "120" },
    body: JSON.stringify({ error: "Too many requests. Please try again later.", code: "rate_limited", retryAfter: 120 }),
  };
  const FRIENDLY = /Too many requests from this connection\. Please try again in about 2 minutes, or call the temple office\./;
  const page = await newClientPage(5);

  await page.route("**/api/contact", (r) => r.fulfill(LIMITED));
  await page.goto(base + "/contact", { waitUntil: "networkidle" });
  await chooseLang(page, "en");
  await page.fill('input[name="name"]', "E2E-LIMIT");
  await page.fill('input[name="phone"]', "9876504321");
  await page.fill('textarea[name="message"]', "Rate limit message check.");
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(900);
  check((await page.locator(".alert").filter({ hasText: FRIENDLY }).count()) === 1, "429: contact form shows the friendly message with the wait time");
  await chooseLang(page, "ta");
  check(
    (await page.locator(".alert").filter({ hasText: /அதிகமான கோரிக்கைகள்.*சுமார் 2 நிமிடத்தில்/ }).count()) === 1,
    "429: the message follows a switch to Tamil",
  );

  await page.route("**/api/donations", (r) => r.fulfill(LIMITED));
  await page.goto(base + "/donations", { waitUntil: "networkidle" });
  await chooseLang(page, "en");
  await page.fill('input[name="name"]', "E2E-LIMIT");
  await page.fill('input[name="phone"]', "9876509999");
  await page.fill('input[name="amount"]', "501");
  await page.click('form button[type="submit"]');
  await page.waitForTimeout(900);
  check((await page.locator(".alert").filter({ hasText: FRIENDLY }).count()) === 1, "429: donation form shows the friendly message");

  await page.route("**/api/seva-bookings", (r) => r.fulfill(LIMITED));
  await page.goto(base + "/sevas", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator(".seva-card__book").first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: "visible" });
  await dialog.locator('input[name="devotee_name"]').fill("E2E-LIMIT");
  await dialog.locator('input[name="phone"]').fill("9876501234");
  await dialog.locator('button[type="submit"]').click();
  await page.waitForTimeout(900);
  check((await dialog.locator(".alert").filter({ hasText: FRIENDLY }).count()) === 1, "429: seva booking shows the friendly message");
  check((await dialog.locator('input[name="devotee_name"]').inputValue()) === "E2E-LIMIT", "429: the booking form keeps what was typed");
  await page.keyboard.press("Escape");

  await page.route("**/api/chat", (r) => r.fulfill(LIMITED));
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.click(".chatbot__trigger");
  await page.waitForTimeout(400);
  await page.fill(".chatbot__input", "temple timings");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  const last = page.locator(".chatbot__bubble--assistant").last();
  check(FRIENDLY.test(await last.innerText()), "429: chatbot answers with the friendly message as an assistant reply", (await last.innerText()).slice(0, 90));
  check((await page.locator(".chatbot__bubble--error").count()) === 0, "429: chatbot does not show it as a failure");
  check(await page.locator(".chatbot__input").isEnabled(), "429: chatbot stays usable");
  check(page.errors().length === 0, "429: no page errors", page.errors().slice(0, 2).join(" | "));
  await page.context().close();
} catch (e) {
  fail("HTTP 429 messages (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
const cleanup = results.filter((r) => r.cleanup).map((r) => r.cleanup);
if (cleanup.length) console.log("CLEANUP:", cleanup.join(","));
process.exit(failed.length ? 1 : 0);
