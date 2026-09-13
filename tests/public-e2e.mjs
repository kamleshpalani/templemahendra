// End-to-end tests for the public site (Vite dev server + real PHP API + MySQL).
//   node public.mjs [baseUrl]            (default http://127.0.0.1:5173)
// Covers: every route at 4 widths (console errors, single h1, no horizontal
// overflow, axe-core serious/critical violations), language toggle, mobile
// drawer + keyboard, seva booking modal (focus trap, validation, real submit),
// contact + donation forms, events filter, panchangam navigation, chatbot, 404.
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

await browser.close();

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
const cleanup = results.filter((r) => r.cleanup).map((r) => r.cleanup);
if (cleanup.length) console.log("CLEANUP:", cleanup.join(","));
process.exit(failed.length ? 1 : 0);
