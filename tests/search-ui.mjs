// Browser tests for the site search: the Ctrl+K palette and the /search page.
//   node tests/search-ui.mjs [baseUrl]          (default http://localhost:5173)
//
// Drives the real Vite dev server against the real PHP API and MySQL. Proves
// that /search (empty and with a query) renders at four widths with one h1, no
// horizontal overflow, no console errors and no axe serious/critical
// violations; that Ctrl+K and "/" open the palette with focus in the box, the
// arrows and Enter walk and open results, Escape closes it, and "/" inside a
// field is left alone; that the /search page puts the query in the URL, lists
// and counts results, narrows by type, leads to a real page, and shows an
// empty state for no matches; and that the mobile drawer and the navbar icon
// open the same palette.
//
// Read-only: nothing is created. The queries are words the search index already
// answers from the site's own pages and sevas (see GET /api/search?q=…), so no
// rows are seeded and no cleanup is needed.
// playwright and axe-core are devDependencies of frontend/, and Node resolves a
// bare specifier from this file's own directory upwards — which never reaches
// frontend/node_modules. Resolving explicitly means "cd frontend && npm install"
// is the only setup step, with no symlink or root install to remember.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
import { mkdirSync, readFileSync } from "node:fs";

const base = (process.argv[2] || "http://localhost:5173").replace(/\/$/, "");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
mkdirSync("shots/search", { recursive: true });

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail = "") => (cond ? pass(name, detail) : fail(name, detail));

// Words the index answers today, from content that already exists:
//   "abhishekam" — pages, a seva, an event and an announcement (several groups)
//   "annadanam"  — the annadanam hall page and a seva
// Both are also offered as suggestion chips in the palette.
const MANY_GROUPS = "abhishekam";
const FOLLOWABLE = "annadanam";
const NOTHING = "zzqqxx-nothing";

const browser = await chromium.launch();
const IGNORE =
  /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js|youtube|ytimg|googlevideo/;

async function newPage(width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN" });
  const page = await ctx.newPage();
  const errors = [];
  // "Failed to load resource" names no URL in its text; the location carries
  // it, so a third-party font or map that IGNORE already exempts is exempt here too.
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()} ${m.location()?.url ?? ""}`.trimEnd());
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!IGNORE.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`);
  });
  page.errors = () => errors.filter((e) => !IGNORE.test(e));
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

/**
 * Navigate, then switch the interface to English.
 *
 * The site opens in Tamil. The choice is remembered in localStorage, so within
 * one browser context it survives reloads — but every scenario starts from a
 * fresh context, which begins in Tamil again. These assertions read English
 * copy, so the toggle is pressed after each navigation; pressing it when English
 * is already chosen changes nothing.
 */
async function go(page, path) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  const en = page.locator('.lang-toggle__btn[lang="en"]');
  if (await en.count()) {
    await en.first().click();
    await page.waitForTimeout(250);
  }
}

/** The index of the highlighted palette row, or -1. */
const activeRow = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".cmdk__row")].findIndex((r) => r.dataset.active === "true"));

/* ── 1. The /search page, four widths ─────────────────────────────────── */
const ROUTES = ["/search", `/search?q=${MANY_GROUPS}`];
const WIDTHS = [390, 768, 1024, 1440];

for (const route of ROUTES) {
  for (const w of WIDTHS) {
    const page = await newPage(w, w < 700 ? 844 : 900);
    await page.goto(base + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const h1s = await page.locator("h1").count();
    check(h1s === 1, `${route} @${w}: exactly one h1`, `found ${h1s}`);
    check(!(await overflow(page)), `${route} @${w}: no horizontal overflow`);
    const errs = page.errors();
    check(errs.length === 0, `${route} @${w}: no console errors`, errs.slice(0, 3).join(" | "));
    if (w === 1440) {
      const v = await axe(page);
      check(v.length === 0, `${route}: axe serious/critical violations`, v.slice(0, 6).join("\n      "));
    }
    if (w === 1440 || w === 390) {
      await page.screenshot({ path: `shots/search/${route.replace(/[/?=]/g, "_")}-${w}.png`, fullPage: true });
    }
    await page.context().close();
  }
}

/* ── 2. The Ctrl+K palette ────────────────────────────────────────────── */
try {
  const page = await newPage();
  await go(page, "/");
  await page.waitForTimeout(600);

  await page.keyboard.press("Control+k");
  await page.waitForTimeout(800);
  check((await page.locator(".cmdk").count()) === 1, "Ctrl+K opens the palette");
  check(
    await page.evaluate(() => document.activeElement?.classList.contains("cmdk__input")),
    "focus lands in the search box",
  );
  check(
    (await page.locator('.cmdk[role="dialog"][aria-modal="true"]').count()) === 1 &&
      (await page.locator('.cmdk__input[role="combobox"]').count()) === 1,
    "it is announced as a modal dialog holding a combobox",
  );
  check((await page.locator(".chip").count()) > 0, "suggestions are offered before anything is typed");

  await page.fill(".cmdk__input", "a");
  await page.waitForTimeout(500);
  check(/at least 2 characters/i.test(await page.locator(".cmdk__body").innerText()), "one character asks for more");

  await page.fill(".cmdk__input", MANY_GROUPS);
  await page.waitForTimeout(1200);
  const rows = await page.locator(".cmdk__row").count();
  check(rows > 0, "typing a real word lists results", `${rows} rows`);
  check((await page.locator(".cmdk__group[role='group']").count()) > 1, "results are grouped by type", `${await page.locator(".cmdk__group[role='group']").count()} groups`);
  check((await page.locator('.cmdk__row[data-active="true"]').count()) === 1, "exactly one row is highlighted");
  check(
    await page.evaluate(() => {
      const input = document.querySelector(".cmdk__input");
      const id = input?.getAttribute("aria-activedescendant");
      const row = id && document.getElementById(id);
      return !!row && row.dataset.active === "true" && row.getAttribute("aria-selected") === "true";
    }),
    "aria-activedescendant points at the highlighted row",
  );
  check((await page.locator(".cmdk__all").count()) === 1, "a 'See all results' link is offered");

  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  check((await activeRow(page)) === 1, "ArrowDown moves the highlight", `index ${await activeRow(page)}`);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(250);
  check((await activeRow(page)) === 0, "ArrowUp moves it back", `index ${await activeRow(page)}`);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(250);
  check((await activeRow(page)) === rows - 1, "ArrowUp from the top wraps to the last row", `index ${await activeRow(page)} of ${rows}`);
  // The list is longer than the sheet; the arrows must scroll the highlighted
  // row into view, and the scrolling region must be the listbox the combobox
  // controls — not the body around it, which nothing in the Tab order reaches.
  const scrolled = await page.evaluate(() => {
    const body = document.querySelector(".cmdk__body");
    const list = document.querySelector("#cmdk-list");
    const row = document.querySelector('.cmdk__row[data-active="true"]');
    const l = list.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    return {
      bodyScrolls: body.scrollHeight > body.clientHeight + 1,
      listScrolls: list.scrollHeight > list.clientHeight + 1,
      rowInView: r.top >= l.top - 1 && r.bottom <= l.bottom + 1,
    };
  });
  check(scrolled.listScrolls && !scrolled.bodyScrolls, "the listbox itself is the scrolling region", JSON.stringify(scrolled));
  check(scrolled.rowInView, "the highlighted row is scrolled into view", JSON.stringify(scrolled));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  check((await activeRow(page)) === 0, "ArrowDown from the bottom wraps to the first", `index ${await activeRow(page)}`);
  check(
    await page.evaluate(() => document.activeElement?.classList.contains("cmdk__input")),
    "the arrows never move focus out of the box",
  );
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const target = await page.evaluate(() => {
    const id = document.querySelector(".cmdk__input")?.getAttribute("aria-activedescendant");
    return document.getElementById(id)?.querySelector(".cmdk__row-title")?.textContent ?? "";
  });

  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check(new URL(page.url()).pathname !== "/", "Enter opens the highlighted result", `${target} → ${page.url()}`);
  check((await page.locator(".cmdk").count()) === 0, "and the palette closes behind it");

  // "/" opens it too, and Escape closes it.
  await page.keyboard.press("/");
  await page.waitForTimeout(700);
  check((await page.locator(".cmdk").count()) === 1, '"/" also opens the palette');
  check((await page.locator(".cmdk__input").inputValue()) === "", "a reopened palette starts empty");
  check(
    (await page.locator(".cmdk__chips .chip", { hasText: MANY_GROUPS }).count()) >= 1,
    "the last search is remembered as a recent chip",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check((await page.locator(".cmdk").count()) === 0, "Escape closes it");

  // No matches is an empty state, not an error.
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(500);
  await page.fill(".cmdk__input", NOTHING);
  await page.waitForTimeout(1200);
  check(
    (await page.locator(".cmdk__empty").count()) === 1 && (await page.locator(".cmdk__hint--error").count()) === 0,
    "no matches shows the palette's empty state, not an error",
  );
  // Enter with nothing highlighted goes to the full page for the query.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1000);
  check(
    new URL(page.url()).pathname === "/search" && new URL(page.url()).searchParams.get("q") === NOTHING,
    "Enter with no result highlighted opens /search for the query",
    page.url(),
  );
  check((await page.locator(".cmdk").count()) === 0, "and closes the palette");

  // The navbar icon is the mouse route in.
  await page.locator(".navbar__search").click();
  await page.waitForTimeout(600);
  check((await page.locator(".cmdk").count()) === 1, "the navbar search icon opens the palette");
  await page.locator(".cmdk__close").click();
  await page.waitForTimeout(400);
  check((await page.locator(".cmdk").count()) === 0, "the close button closes it");

  // The palette itself must pass axe.
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(500);
  await page.fill(".cmdk__input", MANY_GROUPS);
  await page.waitForTimeout(1200);
  const v = await axe(page);
  check(v.length === 0, "palette with results: axe serious/critical violations", v.slice(0, 6).join("\n      "));
  await page.screenshot({ path: "shots/search/palette-1440.png" });
  await page.keyboard.press("Escape");

  // Typing "/" inside a field must not hijack the keystroke.
  await go(page, "/contact");
  await page.waitForTimeout(600);
  await page.fill('textarea[name="message"]', "");
  await page.click('textarea[name="message"]');
  await page.keyboard.press("/");
  await page.waitForTimeout(400);
  check((await page.locator(".cmdk").count()) === 0, '"/" while typing in a field does not open the palette');
  check((await page.inputValue('textarea[name="message"]')) === "/", "and the slash reaches the field");

  const errs = page.errors();
  check(errs.length === 0, "palette: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Search palette (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 3. The /search page ──────────────────────────────────────────────── */
try {
  const page = await newPage();
  await go(page, "/search");
  await page.waitForTimeout(700);
  check(/Type something above/i.test(await page.locator("body").innerText()), "an empty search page invites a query");
  check((await page.locator('form[role="search"]').count()) === 1, "the form is a search landmark");

  await page.fill(".srch__field input", MANY_GROUPS);
  await page.click('.srch__form button[type="submit"]');
  await page.waitForTimeout(1500);
  check(new RegExp(`\\?q=${MANY_GROUPS}`).test(page.url()), "searching puts the query in the URL", page.url());
  check((await page.locator("h1").innerText()).includes(MANY_GROUPS), "the heading repeats the query", await page.locator("h1").innerText());
  const hits = await page.locator(".srch__hit").count();
  check(hits > 0, "results are listed", `${hits} hits`);
  const count = await page.locator(".srch__count").innerText();
  check(/\d/.test(count), "the result count is shown", count);
  check(
    parseInt(count, 10) === hits,
    "the count matches the number of hits listed",
    `${count} vs ${hits} hits`,
  );

  // A type filter narrows the list, and pressing it again restores everything.
  const groupsBefore = await page.locator(".srch__group").count();
  check(groupsBefore > 1, `"${MANY_GROUPS}" returns more than one group, so the filter can be exercised`, `${groupsBefore} groups`);
  const filterChips = page.locator(".srch__filters .chip");
  check((await filterChips.count()) === groupsBefore + 1, "one filter chip per group, plus All", `${await filterChips.count()} chips`);
  await filterChips.nth(1).click();
  await page.waitForTimeout(600);
  const groupsAfter = await page.locator(".srch__group").count();
  check(groupsAfter === 1, "a type filter narrows the page to one group", `${groupsBefore} → ${groupsAfter}`);
  await filterChips.nth(1).click();
  await page.waitForTimeout(600);
  check((await page.locator(".srch__group").count()) === groupsBefore, "pressing the same filter again shows every group");

  // Back returns to the empty page: the URL is the state.
  await page.goBack();
  await page.waitForTimeout(900);
  check(
    !new URL(page.url()).searchParams.get("q") && (await page.inputValue(".srch__field input")) === "",
    "the back button clears the query and the box",
    page.url(),
  );

  // Following a result must land on a real page.
  await go(page, `/search?q=${FOLLOWABLE}`);
  await page.waitForTimeout(1200);
  if (await page.locator(".srch__hit").count()) {
    await page.locator(".srch__hit").first().click();
    await page.waitForTimeout(1200);
    check((await page.locator("h1").count()) === 1, "a result leads to a real page with one h1", page.url());
    check(!/^\/search/.test(new URL(page.url()).pathname), "…which is not the search page itself", page.url());
  } else {
    fail("a result leads to a real page with one h1", `no hits for '${FOLLOWABLE}'`);
  }

  await go(page, `/search?q=${NOTHING}`);
  await page.waitForTimeout(1200);
  check(/Nothing matched/i.test(await page.locator("body").innerText()), "no matches shows an empty state, not an error");
  check((await page.locator(".srch__hit").count()) === 0, "…and lists nothing");

  await go(page, "/search?q=a");
  await page.waitForTimeout(900);
  check(/at least 2 characters/i.test(await page.locator("body").innerText()), "a one-letter query asks for more, without calling the API");

  const errs = page.errors();
  check(errs.length === 0, "search page: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Search page (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 4. Mobile: the drawer's search row and the palette at 390px ──────── */
try {
  const page = await newPage(390, 844);
  await go(page, "/");
  await page.click(".navbar__toggle");
  await page.waitForTimeout(500);
  check((await page.locator(".drawer__search").count()) === 1, "the mobile drawer offers search");

  await page.click(".drawer__search");
  await page.waitForTimeout(900);
  check((await page.locator(".cmdk").count()) === 1, "tapping it opens the palette");
  check((await page.locator("#mobile-drawer[aria-hidden='true']").count()) === 1, "and closes the drawer behind it");
  check(!(await overflow(page)), "the palette does not overflow a 390px viewport");

  await page.fill(".cmdk__input", MANY_GROUPS);
  await page.waitForTimeout(1200);
  check((await page.locator(".cmdk__row").count()) > 0, "results list on a phone too");
  check(!(await overflow(page)), "…without horizontal overflow");
  await page.screenshot({ path: "shots/search/palette-390.png" });

  const errs = page.errors();
  check(errs.length === 0, "mobile palette: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Mobile drawer (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── Report ───────────────────────────────────────────────────────────── */
await browser.close();
let ok = 0;
for (const r of results) {
  if (r.ok) {
    ok += 1;
    console.log(`✓ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  } else {
    console.log(`✗ ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
}
console.log(`\n${ok}/${results.length} passed`);
process.exit(ok === results.length ? 0 : 1);
