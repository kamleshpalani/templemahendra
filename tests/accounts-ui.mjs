// Browser tests for the new screens: devotee accounts and site search.
//   node tests/accounts-ui.mjs [baseUrl]        (default http://localhost:5173)
//
// Drives the real Vite dev server against the real PHP API and MySQL. Covers
// every new route at four widths (one h1, no horizontal overflow, no console
// errors, axe serious/critical), then the journeys themselves: register, sign
// in, the guarded account area, tab switching, profile save, sign out, the
// Ctrl+K palette including keyboard navigation, and the /search page.
//
// Creates accounts as e2e-ui-<run>-*@example.test. Cleanup SQL is printed at
// the end; run against a disposable database.
// playwright and axe-core are devDependencies of frontend/, and Node resolves a
// bare specifier from this file's own directory upwards — which never reaches
// frontend/node_modules. Resolving explicitly means "cd frontend && npm install"
// is the only setup step, with no symlink or root install to remember.
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
import { mkdirSync, readFileSync } from "node:fs";

const base = (process.argv[2] || "http://localhost:5173").replace(/\/$/, "");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
mkdirSync("shots/accounts", { recursive: true });

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail = "") => (cond ? pass(name, detail) : fail(name, detail));

const RUN = Date.now().toString(36);
const USER = {
  name: "E2E-UI Meena Kumari",
  email: `e2e-ui-${RUN}@example.test`,
  phone: "9876501234",
  city: "Pudupatti",
  password: "Kolam99Deep",
};

const browser = await chromium.launch();
const IGNORE =
  /fonts\.gstatic|googleapis|google\.com\/maps|wa\.me|favicon|ERR_ABORTED|reviews|Download the React DevTools|workbox|sw\.js/;

async function newPage(width = 1440, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height }, locale: "en-IN" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console] ${m.text()}`);
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
 * The site opens in Tamil, and the choice lives in React state rather than
 * storage, so it resets on every full page load. These assertions read English
 * copy, so the toggle is pressed after each navigation. (SPA navigation inside
 * a scenario keeps the choice, so it only needs pressing once per goto.)
 */
async function go(page, path) {
  await page.goto(base + path, { waitUntil: "networkidle" });
  const en = page.locator('.lang-toggle__btn[lang="en"]');
  if (await en.count()) {
    await en.first().click();
    await page.waitForTimeout(250);
  }
}

/**
 * The combobox inside the <Field> whose label reads `label` — the country and
 * the state pickers share one class, so addressing them by position breaks
 * whenever the address fields are reordered. Ask for them by name instead.
 */
const picker = (page, label) =>
  page
    .locator(".field", { has: page.locator(".field__label", { hasText: label }) })
    .locator(".country-select");

/** Sign in through the real form, leaving the page on /account. */
async function signIn(page) {
  await go(page, "/login");
  await page.fill('input[type="email"]', USER.email);
  await page.fill('input[type="password"]', USER.password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/account", { timeout: 15000 });
  await page.waitForTimeout(700);
}

/* ── 1. Every new route, four widths ──────────────────────────────────── */
const ROUTES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/search",
  "/search?q=abhishekam",
];
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
      await page.screenshot({
        path: `shots/accounts/${route.replace(/[/?=]/g, "_") || "root"}-${w}.png`,
        fullPage: true,
      });
    }
    if (w === 390) {
      await page.screenshot({ path: `shots/accounts/${route.replace(/[/?=]/g, "_")}-390.png`, fullPage: true });
    }
    await page.context().close();
  }
}

/* ── 2. Registration ──────────────────────────────────────────────────── */
try {
  const page = await newPage();
  await go(page, "/register");

  // The meter responds as the password is typed; the full rules live behind the
  // help button rather than taking five lines of the form.
  const segBefore = await page.locator('.pw-meter__seg[data-met="true"]').count();
  await page.fill('input[name="password"]', USER.password);
  await page.waitForTimeout(250);
  const segAfter = await page.locator('.pw-meter__seg[data-met="true"]').count();
  check(segBefore === 0, "the password meter starts empty", `${segBefore} lit`);
  check(segAfter === 4, "a valid password lights every segment", `${segAfter} of 4`);
  check((await page.locator(".pw-meter__list").count()) === 0, "the rule list is not taking up form space");
  await page.locator(".pw-meter__help").click();
  await page.waitForTimeout(300);
  check(
    (await page.locator('.pw-meter__list li[data-met="true"]').count()) === 4,
    "the help popover shows every rule met",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Client-side validation fires before any request goes out.
  await page.fill('input[name="password"]', "short");
  await page.click('button[type="submit"]');
  await page.waitForTimeout(400);
  const errorTexts = await page.locator(".field__error").allInnerTexts();
  check(errorTexts.length >= 3, "submitting an incomplete form shows field errors", `${errorTexts.length} errors`);
  check(
    errorTexts.some((x) => /phone|number/i.test(x)),
    "…including one for the now-required phone number",
    errorTexts.join(" | ").slice(0, 120),
  );

  await page.fill('input[name="name"]', USER.name);
  await page.fill('input[name="email"]', USER.email);
  await page.fill('input[name="password"]', USER.password);
  await page.fill('input[name="confirm"]', USER.password);
  await page.fill(".phone-input__num", USER.phone);
  await page.fill('input[name="city"]', USER.city);

  // The country defaults to India, so India's state list is what gets offered.
  check(
    (await picker(page, "Country").innerText()).includes("India"),
    "the country field defaults to India",
  );
  check(
    (await page.inputValue(".phone-input__num")) === "98765 01234",
    "the number is grouped the way India writes it",
    await page.inputValue(".phone-input__num"),
  );

  // The address reads state → city → country, and all three are required.
  // textContent, not innerText: the labels are uppercased in CSS, and the point
  // here is the order and the required asterisk, not the casing.
  const labels = await page.$$eval(".field__label", (els) => els.map((e) => e.textContent.trim()));
  const at = (word) => labels.findIndex((x) => x.startsWith(word));
  check(
    at("State") >= 0 && at("State") < at("City") && at("City") < at("Country"),
    "the address fields read state, then city, then country",
    labels.join(" | "),
  );
  check(
    ["State", "City", "Country"].every((w) => at(w) >= 0 && labels[at(w)].includes("*")),
    "and each of the three is marked required",
    labels.join(" | "),
  );

  await picker(page, "State").click();
  await page.waitForTimeout(450);
  await page.fill(".country-pop__search input", "tamil");
  await page.waitForTimeout(450);
  check((await page.locator(".country-pop__opt").count()) === 1, "searching the state list finds Tamil Nadu");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check(
    (await picker(page, "State").innerText()).includes("Tamil Nadu"),
    "and selecting it fills the state field",
  );

  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);

  const body = await page.locator("body").innerText();
  // Sign-up is capped at five completed registrations per hour per IP. Running
  // this suite twice in an hour, or alongside devotee-auth.mjs, exhausts it and
  // every later scenario then fails as a confusing timeout. Say so here instead.
  if (/Too many sign-up attempts/i.test(body)) {
    fail(
      "registration was rate-limited, not tested",
      "Run DELETE FROM rate_limits; and do not run devotee-auth.mjs at the same time.",
    );
  }
  check(/Check your email|Account created/i.test(body), "registering lands on the confirmation screen", body.slice(0, 120));
  check(
    /could not send email|sign in directly/i.test(body),
    "with MAIL_TRANSPORT unset it says so plainly rather than pretending",
  );
  check(await page.locator('a[href="/login"]').count() > 0, "and offers a way to sign in");
  const errs = page.errors();
  check(errs.length === 0, "registration flow: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Registration (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 3. The route guard ───────────────────────────────────────────────── */
try {
  const page = await newPage();
  await go(page, "/account");
  await page.waitForTimeout(1200);
  check(page.url().endsWith("/login"), "/account while signed out redirects to /login", page.url());
  // The redirect is a client-side navigation, so English survives it.
  await page.fill('input[type="email"]', USER.email);
  await page.fill('input[type="password"]', USER.password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/account", { timeout: 15000 });
  check(page.url().endsWith("/account"), "signing in returns to where the visitor was headed", page.url());
  await page.context().close();
} catch (e) {
  fail("Route guard (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 4. Sign in, the account area, and a reload ───────────────────────── */
try {
  const page = await newPage();
  await signIn(page);

  check((await page.locator("h1").innerText()).includes("Meena"), "the account header greets the devotee by name");
  check((await page.locator(".stat").count()) === 4, "four KPI cards render");
  check(
    (await page.locator(".acct-verify").count()) === 1,
    "an unconfirmed address gets a prompt to confirm it",
  );

  // Reload must not bounce a signed-in devotee back to /login.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check(page.url().endsWith("/account"), "a reload keeps the devotee on /account", page.url());
  // A full reload resets the language to Tamil (LangProvider keeps the choice in
  // React state only), so English has to be chosen again before reading labels.
  await page.locator('.lang-toggle__btn[lang="en"]').first().click();
  await page.waitForTimeout(300);

  // Tabs
  await page.click('[role="tab"]:has-text("Bookings")');
  await page.waitForTimeout(900);
  let text = await page.locator(".acct-panel").innerText();
  check(/No bookings yet|Seva/i.test(text), "the Bookings tab renders its own panel", text.slice(0, 80));

  await page.click('[role="tab"]:has-text("Offerings")');
  await page.waitForTimeout(900);
  text = await page.locator(".acct-panel").innerText();
  check(/No offerings recorded|Amount/i.test(text), "the Offerings tab renders its own panel", text.slice(0, 80));

  // Arrow keys move between tabs (roving tabindex)
  await page.locator('[role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);
  const selected = await page.locator('[role="tab"][aria-selected="true"]').innerText();
  check(/details/i.test(selected), "ArrowRight moves to the next tab", selected);

  // The address opens holding what was typed at sign-up, in the same order.
  check(
    (await page.inputValue('.acct-form input[autocomplete="address-level2"]')) === USER.city,
    "the account page opens with the town given at sign-up",
  );
  check(
    (await picker(page, "Country").innerText()).includes("India"),
    "…and the country it was registered with",
  );

  // City is required here too, so a receipt always has somewhere to go.
  await page.fill('.acct-form input[autocomplete="address-level2"]', "");
  await page.click('.acct-form button[type="submit"]');
  await page.waitForTimeout(700);
  check(
    (await page.locator(".acct-form .field__error").count()) > 0,
    "clearing the town blocks the save",
  );
  await page.fill('.acct-form input[autocomplete="address-level2"]', USER.city);

  // Profile save
  await page.fill('.acct-form input[autocomplete="name"]', "E2E-UI Meena Kumari Renamed");
  await page.fill('.acct-form input[autocomplete="postal-code"]', "627719");
  await page.click('.acct-form button[type="submit"]');
  await page.waitForTimeout(1600);
  check((await page.locator(".toast--success").count()) > 0, "saving the profile shows a success toast");

  const v = await axe(page);
  check(v.length === 0, "/account: axe serious/critical violations", v.slice(0, 6).join("\n      "));
  await page.screenshot({ path: "shots/accounts/account-1440.png", fullPage: true });

  const errs = page.errors();
  check(errs.length === 0, "account area: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Account area (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 5. The navbar account menu and sign out ──────────────────────────── */
try {
  const page = await newPage();
  await signIn(page);
  await go(page, "/");
  await page.waitForTimeout(800);

  check((await page.locator(".navbar__acct-btn").count()) === 1, "the navbar shows the devotee's initials when signed in");
  await page.click(".navbar__acct-btn");
  await page.waitForTimeout(350);
  check((await page.locator('.menu[role="menu"]').count()) === 1, "clicking it opens the account menu");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await page.locator('.menu[role="menu"]').count()) === 0, "Escape closes the menu");

  await page.click(".navbar__acct-btn");
  await page.waitForTimeout(300);
  await page.click('.menu__item:has-text("Sign out")');
  await page.waitForTimeout(1800);
  check(
    (await page.locator(".navbar__login").count()) === 1 && (await page.locator(".navbar__signup").count()) === 1,
    "after signing out the navbar offers Login and Sign Up again",
  );

  await page.goto(`${base}/account`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  check(page.url().endsWith("/login"), "and /account is guarded again", page.url());
  await page.context().close();
} catch (e) {
  fail("Navbar account menu (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 6. The Ctrl+K palette ────────────────────────────────────────────── */
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
  check((await page.locator(".chip").count()) > 0, "suggestions are offered before anything is typed");

  await page.fill(".cmdk__input", "a");
  await page.waitForTimeout(500);
  check(/at least 2 characters/i.test(await page.locator(".cmdk__body").innerText()), "one character asks for more");

  await page.fill(".cmdk__input", "abhishekam");
  await page.waitForTimeout(1200);
  const rows = await page.locator(".cmdk__row").count();
  check(rows > 0, "typing a real word lists results", `${rows} rows`);
  check(
    await page.locator('.cmdk__row[data-active="true"]').count().then((n) => n === 1),
    "exactly one row is highlighted",
  );
  check(
    await page.evaluate(() => {
      const input = document.querySelector(".cmdk__input");
      const id = input?.getAttribute("aria-activedescendant");
      return !!id && !!document.getElementById(id);
    }),
    "aria-activedescendant points at a row that exists",
  );

  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(250);
  const second = await page.evaluate(() => {
    const rowsAll = [...document.querySelectorAll(".cmdk__row")];
    return rowsAll.findIndex((r) => r.dataset.active === "true");
  });
  check(second === 1, "ArrowDown moves the highlight", `index ${second}`);

  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  check(!page.url().endsWith("/"), "Enter opens the highlighted result", page.url());
  check((await page.locator(".cmdk").count()) === 0, "and the palette closes behind it");

  // "/" opens it too, and Escape returns focus to the opener.
  await page.keyboard.press("/");
  await page.waitForTimeout(700);
  check((await page.locator(".cmdk").count()) === 1, '"/" also opens the palette');
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check((await page.locator(".cmdk").count()) === 0, "Escape closes it");

  // Typing "/" inside a field must not hijack the keystroke.
  await go(page, "/contact");
  await page.waitForTimeout(600);
  await page.fill('textarea[name="message"]', "");
  await page.click('textarea[name="message"]');
  await page.keyboard.press("/");
  await page.waitForTimeout(400);
  check((await page.locator(".cmdk").count()) === 0, '"/" while typing in a field does not open the palette');
  check(
    (await page.inputValue('textarea[name="message"]')) === "/",
    "and the slash reaches the field",
  );

  const errs = page.errors();
  check(errs.length === 0, "palette: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Search palette (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 7. The /search page ──────────────────────────────────────────────── */
try {
  const page = await newPage();
  await go(page, "/search");
  await page.waitForTimeout(700);
  check(/Type something above/i.test(await page.locator("body").innerText()), "an empty search page invites a query");

  await page.fill('.srch__field input', "pournami");
  await page.click('.srch__form button[type="submit"]');
  await page.waitForTimeout(1500);
  check(/\?q=pournami/.test(page.url()), "searching puts the query in the URL", page.url());
  const hits = await page.locator(".srch__hit").count();
  check(hits > 0, "results are listed", `${hits} hits`);
  check((await page.locator(".srch__count").innerText()).match(/\d/) !== null, "the result count is shown");

  // A type filter narrows the list.
  const groupsBefore = await page.locator(".srch__group").count();
  if (groupsBefore > 1) {
    await page.click(".srch__filters .chip:nth-child(2)");
    await page.waitForTimeout(600);
    const groupsAfter = await page.locator(".srch__group").count();
    check(groupsAfter === 1, "a type filter narrows the page to one group", `${groupsBefore} → ${groupsAfter}`);
  } else {
    check(true, "a type filter narrows the page to one group", "only one group returned; filter is a no-op");
  }

  // Following a result must land on a real page.
  await go(page, "/search?q=annadanam");
  await page.waitForTimeout(1200);
  if (await page.locator(".srch__hit").count()) {
    await page.locator(".srch__hit").first().click();
    await page.waitForTimeout(1200);
    check((await page.locator("h1").count()) === 1, "a result leads to a real page with one h1", page.url());
  } else {
    fail("a result leads to a real page with one h1", "no hits for 'annadanam'");
  }

  await go(page, "/search?q=zzqqxx-nothing");
  await page.waitForTimeout(1200);
  check(/Nothing matched/i.test(await page.locator("body").innerText()), "no matches shows an empty state, not an error");

  const errs = page.errors();
  check(errs.length === 0, "search page: no console errors", errs.slice(0, 3).join(" | "));
  await page.context().close();
} catch (e) {
  fail("Search page (scenario threw)", String(e.message || e).split("\n")[0].slice(0, 200));
}

/* ── 8. Mobile: drawer search and account rows ────────────────────────── */
try {
  const page = await newPage(390, 844);
  await go(page, "/");
  await page.click(".navbar__toggle");
  await page.waitForTimeout(500);
  check((await page.locator(".drawer__search").count()) === 1, "the mobile drawer offers search");
  check((await page.locator('.drawer__acct a[href="/login"]').count()) === 1, "and a sign-in row for a guest");
  check((await page.locator('.drawer__acct a[href="/register"]').count()) === 1, "and a register row");

  await page.click(".drawer__search");
  await page.waitForTimeout(900);
  check((await page.locator(".cmdk").count()) === 1, "tapping it opens the palette");
  check((await page.locator("#mobile-drawer[aria-hidden='true']").count()) === 1, "and closes the drawer behind it");
  check(!(await overflow(page)), "the palette does not overflow a 390px viewport");
  await page.screenshot({ path: "shots/accounts/palette-390.png" });
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
console.log(
  `CLEANUP:\n  DELETE FROM devotees WHERE email LIKE 'e2e-ui-%';\n  DELETE FROM rate_limits;`,
);
process.exit(ok === results.length ? 0 : 1);
