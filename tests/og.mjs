/**
 * Shared-link previews: what a crawler is told, and whether it matches the page.
 *
 *   node og.mjs [siteUrl] [phpUrl]
 *   node og.mjs http://localhost:5173 http://127.0.0.1:8000
 *
 * Two halves.
 *
 * 1. api/og.php answers every public route with a complete, correct preview —
 *    real title, description, image, canonical URL — including the two paths
 *    whose subject comes from the database (?photo= and ?seva=), and says
 *    nothing about account pages.
 *
 * 2. The copy in backend/includes/site_pages.php still matches what each React
 *    page renders. Those are two copies of the same sentence, in two languages,
 *    and nothing but a test keeps them honest: the page is loaded in a real
 *    browser, its og:title and og:description are read after React has written
 *    them, and they are compared with what og.php returns for the same path.
 *    Change a page's title or lead and this test names the file to update.
 *
 * The share sheet itself is covered by public-e2e.mjs.
 */
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");

const site = (process.argv[2] || "http://localhost:5173").replace(/\/$/, "");
const php = (process.argv[3] || "http://127.0.0.1:8000").replace(/\/$/, "");

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail = "") => (cond ? pass(name, detail) : fail(name, detail));
const section = (title) => results.push({ section: title });

/** Every unfurler this site cares about identifies itself; one stands for all. */
const UNFURLER = "WhatsApp/2.23.20.0 A";

/** Fetch a path as a crawler would and pull the meta tags out of the HTML. */
async function preview(path, { ua = UNFURLER, lang } = {}) {
  const headers = { "user-agent": ua };
  if (lang) headers["accept-language"] = lang;
  const res = await fetch(php + path, { headers, redirect: "manual" });
  const html = await res.text();
  const meta = {};
  for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) {
    meta[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "";
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? "";
  return { status: res.status, html, meta, title, canonical };
}

/* ── 1. The renderer ──────────────────────────────────────────────────────── */
section("api/og.php");

const ROUTES = ["/", "/about", "/sevas", "/events", "/gallery", "/donations", "/contact", "/panchangam"];
const seen = new Map();

for (const path of ROUTES) {
  const p = await preview(path);
  const label = path === "/" ? "/ (home)" : path;
  check(p.status === 200, `${label} answers 200`, `status ${p.status}`);
  check(!!p.meta["og:title"], `${label} has an og:title`);
  check(!!p.meta["og:description"], `${label} has an og:description`);
  check(
    p.meta["og:image"]?.startsWith("http"),
    `${label} names an absolute og:image`,
    p.meta["og:image"] ?? "(none)",
  );
  check(
    p.canonical === `${site}${path === "/" ? "" : path}` || p.canonical.endsWith(path),
    `${label} canonical points at the page itself`,
    p.canonical,
  );
  check(p.meta["og:site_name"]?.length > 10, `${label} names the temple as the site`);
  check(p.meta["twitter:card"] === "summary_large_image", `${label} declares a large Twitter card`);
  check(!/<meta name="robots"/.test(p.html), `${label} is left indexable`);
  if (p.meta["og:title"]) {
    const clash = seen.get(p.meta["og:title"]);
    check(!clash, `${label} does not reuse ${clash}'s title`, p.meta["og:title"]);
    seen.set(p.meta["og:title"], label);
  }
}

// Home is the one page whose title is the temple's name with nothing appended.
const home = await preview("/");
check(
  home.title === home.meta["og:site_name"],
  "the home page's title is the temple's name alone",
  home.title,
);

section("Language");
const eventsTa = await preview("/events");
const eventsEn = await preview("/events", { lang: "en-GB,en;q=0.9" });
check(eventsTa.meta["og:locale"] === "ta_IN", "Tamil is the default, as on the site itself");
check(eventsEn.meta["og:locale"] === "en_IN", "an English crawler is answered in English");
check(
  eventsEn.meta["og:title"] !== eventsTa.meta["og:title"],
  "…with a different title, not the same string twice",
  `${eventsTa.meta["og:title"]} / ${eventsEn.meta["og:title"]}`,
);
const forced = await preview("/events?lang=en");
check(forced.meta["og:locale"] === "en_IN", "?lang=en overrides the header");

section("From the database");
// Whatever the site actually holds; skipped rather than guessed at if empty.
const sevas = await (await fetch(`${php}/api/sevas`)).json().catch(() => []);
const gallery = await (await fetch(`${php}/api/gallery`)).json().catch(() => []);

if (Array.isArray(sevas) && sevas.length) {
  const s = sevas[0];
  const p = await preview(`/sevas?seva=${s.id}`, { lang: "en-GB,en" });
  check(p.meta["og:title"] === (s.name_en || s.name_ta), "one seva previews under its own name", p.meta["og:title"]);
  check(/₹/.test(p.meta["og:description"] ?? ""), "…and its description names the offering amount", p.meta["og:description"]);
  check(p.meta["og:type"] === "article", "…as an article rather than the site");
  check(p.canonical.endsWith(`/sevas?seva=${s.id}`) || p.canonical.endsWith("/sevas"), "…with the seva's own canonical", p.canonical);

  const missing = await preview(`/sevas?seva=99999999`, { lang: "en-GB,en" });
  check(missing.status === 200, "a seva id that does not exist still previews", `status ${missing.status}`);
  check(
    missing.meta["og:title"] === "Sevas",
    "…falling back to the seva list rather than inventing one",
    missing.meta["og:title"],
  );
} else {
  fail("seva previews not tested", "GET /api/sevas returned nothing");
}

if (Array.isArray(gallery) && gallery.length) {
  const g = gallery[0];
  const p = await preview(`/gallery?photo=${g.id}`);
  check(
    p.meta["og:image"].endsWith(`/uploads/${g.filename}`),
    "one photograph previews as itself, not the temple icon",
    p.meta["og:image"],
  );
  check(p.meta["og:image:alt"]?.length > 0, "…with alt text");
  if (g.caption) {
    check(p.meta["og:title"] === g.caption, "…titled with its caption", p.meta["og:title"]);
  }
} else {
  results.push({ note: "no gallery photos in the database — photo previews not exercised" });
}

section("What must not be previewed");
for (const path of ["/account", "/login", "/register"]) {
  const p = await preview(path);
  check(p.meta.robots === "noindex, nofollow", `${path} is marked noindex, nofollow`, p.meta.robots ?? "(none)");
  check(!p.meta["og:description"], `${path} gives nothing away in a description`);
}
const search = await preview("/search?q=abhishekam");
check(search.meta.robots === "noindex, follow", "a results page is not indexed but is followed", search.meta.robots);
check(/abhishekam/i.test(search.meta["og:title"] ?? ""), "…and its title names the query", search.meta["og:title"]);

const missingPage = await preview("/nothing-here");
check(missingPage.status === 404, "an address that is not part of the site answers 404", `status ${missingPage.status}`);
check(missingPage.meta.robots === "noindex, nofollow", "…and is not indexable");

section("Only crawlers are diverted");
const asBrowser = await fetch(`${php}/events`, {
  headers: { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36" },
  redirect: "manual",
});
check(
  asBrowser.status === 404,
  "a browser is not sent to the preview renderer (it is served the React app)",
  `status ${asBrowser.status}`,
);
const openRedirect = await preview("/?path=//evil.example.com/x");
check(
  !/evil\.example\.com/.test(openRedirect.html),
  "a path pointing at another host is refused, not echoed into a link",
);

/* ── 2. The two copies agree ──────────────────────────────────────────────── */
section("og.php matches what the page renders");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ta-IN" });
const page = await ctx.newPage();

/** The tags React wrote, read once Helmet has committed them. */
async function rendered(path) {
  await page.goto(site + path, { waitUntil: "networkidle" });
  // The site opens in Tamil and <Seo> writes on the first commit; give Helmet a
  // beat rather than racing it.
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    title: document.title,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? "",
    ogDesc: document.querySelector('meta[property="og:description"]')?.content ?? "",
    ogUrl: document.querySelector('meta[property="og:url"]')?.content ?? "",
    ogSite: document.querySelector('meta[property="og:site_name"]')?.content ?? "",
    canonical: document.querySelector('link[rel="canonical"]')?.href ?? "",
    card: document.querySelector('meta[name="twitter:card"]')?.content ?? "",
  }));
}

for (const path of ROUTES) {
  const label = path === "/" ? "/ (home)" : path;
  const react = await rendered(path);
  const server = await preview(path);
  check(
    react.ogTitle === server.meta["og:title"],
    `${label}: og:title agrees with site_pages.php`,
    `page "${react.ogTitle}" vs og.php "${server.meta["og:title"]}"`,
  );
  check(
    react.ogDesc === server.meta["og:description"],
    `${label}: og:description agrees with site_pages.php`,
    `page "${react.ogDesc}" vs og.php "${server.meta["og:description"]}"`,
  );
  check(react.ogSite === server.meta["og:site_name"], `${label}: both name the temple the same way`);
  check(react.card === "summary_large_image", `${label}: the page declares the same Twitter card`);
  check(
    react.canonical === react.ogUrl,
    `${label}: the page's canonical and og:url are the same address`,
    `${react.canonical} vs ${react.ogUrl}`,
  );
}

// A page that is dynamic on the client: the lightbox retitles the document, and
// that is what a copied address bar will preview as.
if (Array.isArray(gallery) && gallery.length) {
  const g = gallery[0];
  const react = await rendered(`/gallery?photo=${g.id}`);
  check(
    react.ogUrl.endsWith(`/gallery?photo=${g.id}`),
    "a deep-linked photo's og:url keeps the photo in it",
    react.ogUrl,
  );
  check(
    react.ogTitle === (g.caption || "தொகுப்பு"),
    "…and the open photograph is what the page says it is about",
    react.ogTitle,
  );
}

await ctx.close();
await browser.close();

/* ── Report ───────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.section) {
    console.log(`\n── ${r.section}`);
    continue;
  }
  if (r.note) {
    console.log(`  ·    ${r.note}`);
    continue;
  }
  if (!r.ok) failed++;
  console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail && !r.ok ? ` — ${r.detail}` : ""}`);
}
const total = results.filter((r) => r.ok !== undefined).length;
console.log(`\n${total - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
