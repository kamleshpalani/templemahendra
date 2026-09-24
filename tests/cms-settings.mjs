#!/usr/bin/env node
/**
 * tests/cms-settings.mjs — the admin CMS structure of brief §15 and the
 * settings behind it (migration 025): site settings, written pages, SEO
 * overrides, Nalla Neram, languages, the regrouped sidebar and the
 * dashboard cards.
 *
 *   migration 025: site_settings, pages (mission and history seeded),
 *   seo_settings — utf8mb4, the unique keys
 *   GET /api/pages, GET /api/pages/{slug} (hidden → 404), GET /api/settings
 *   (site, seo, languages; private office keys never leave the server),
 *   GET /api/pulse hours / schedule from the settings, GET /api/calendar
 *   Nalla Neram from the committee's table
 *   admin: every new page needs a session (E2E-045); Pages and Nalla Neram
 *   are for editors, SEO and Languages for admins, Roles for everyone
 *   (E2E-013 / E2E-046); forged CSRF writes nothing (E2E-049)
 *   Pages: create / edit / hide / delete in both languages, slug rules,
 *   duplicate slug refused, hostile input stored as text (E2E-047/048)
 *   Settings: temple details in both languages, each validation, opening
 *   hours and the daily schedule as typed lines, back to the default
 *   SEO: an override changes the server preview (og.php) and drops the page
 *   from sitemap.xml when marked noindex; switched off, the built-in words
 *   return; duplicate path refused
 *   Nalla Neram: the table the committee saves is what the calendar shows;
 *   a window that ends before it starts is refused; reset
 *   Languages: at least one language, the default among them
 *   Sidebar groups (Content / Temple / Media / Finance / Communication /
 *   Devotees / System) and the four dashboard cards
 *   audit rows for pages, settings, SEO, Nalla Neram and languages
 *
 *   node tests/cms-settings.mjs
 *
 * Starts its own PHP server. Needs the DB_* environment, migrations 015,
 * 024 and 025, and the admin account admin/Admin@Test123 (ADMIN_USERNAME /
 * ADMIN_PASSWORD override). Everything it writes carries the prefix
 * "E2E-CMS-<run>"; the site_settings rows it touches are restored in
 * `finally`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-CMS-${RUN}`;
const SLUG = `e2e-cms-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const SQLI = `${P}'); DROP TABLE pages;-- `;
const UNFURLER = "WhatsApp/2.23.20.0 A";
const ACCOUNTS = {
  editor:  { user: `e2ecms_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2ecms_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2ecms_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};
const TOUCHED = ["temple_name", "temple_descriptor", "phone_primary", "email", "social_youtube", "temple_hours", "pooja_schedule", "daily_special", "coming_soon_days", "contact_notify_email", "nalla_neram", "languages_enabled", "language_default", "hero_lead"];

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
let saved = [];
const xff = () => `10.94.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };

function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const column = (table, name) => sql("SELECT COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, name]).rows[0];
const indexOn = (table, name) => sql("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, MIN(NON_UNIQUE) AS nu FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? GROUP BY INDEX_NAME", [table, name]).rows[0];

function jar() {
  let cookie = "";
  const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  const s = {
    async get(path, headers = {}) {
      const r = await fetch(base + path, { headers: { cookie, "X-Forwarded-For": xff(), ...headers }, redirect: "manual" });
      grab(r);
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async post(path, body, headers = {}) {
      const r = await fetch(base + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff(), "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body),
      });
      grab(r);
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async login(username, password) {
      const page = await s.get("/admin/login.php");
      return s.post("/admin/login.php", { _csrf: csrfOf(page.text), username, password, next: "" });
    },
    /** POST with the page's own CSRF token. */
    async submit(path, body) {
      const page = await s.get(path);
      return s.post(path, { _csrf: csrfOf(page.text), ...body });
    },
  };
  return s;
}
async function api(path, headers = {}) {
  const r = await fetch(base + path, { headers: { "X-Forwarded-For": xff(), ...headers }, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* checked by callers */ }
  return { status: r.status, headers: r.headers, text, json };
}
async function preview(path, lang = "en") {
  const r = await api(path, { "user-agent": UNFURLER, "accept-language": lang });
  const meta = {};
  for (const m of r.text.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) {
    meta[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return { status: r.status, meta, html: r.text, title: /<title>([^<]*)<\/title>/.exec(r.text)?.[1] ?? "" };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redirected = (r) => r.status === 302 || r.status === 303;
const flashOf = (html) => html.match(/alert[^>]*>([^<]+)/)?.[1] ?? "";
const findPage = (slug) => sql("SELECT * FROM pages WHERE slug = ?", [slug]).rows[0];
const findSeo = (path) => sql("SELECT * FROM seo_settings WHERE path = ?", [path]).rows[0];
const setting = (key) => sql("SELECT value_ta, value_en, value FROM site_settings WHERE key_name = ?", [key]).rows[0];
const audits = (action, subject) => sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = ? AND subject = ?", [action, subject]).rows[0].n;
const fieldError = (html, id) => new RegExp(`id="${id}"[^>]*role="alert"`).test(html) || new RegExp(`<span class="field__error" id="${id}"`).test(html);

try {
  /* ── migration 025 ─────────────────────────────────────────────────── */
  for (const t of ["site_settings", "pages", "seo_settings"]) {
    const row = sql("SELECT TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]).rows[0];
    check(row && /^utf8mb4/.test(row.c), `migration 025: ${t} exists and is utf8mb4`, JSON.stringify(row));
  }
  check(column("site_settings", "key_name")?.t === "varchar(80)" && column("site_settings", "value_ta")?.t === "text" && column("site_settings", "value")?.t === "text", "site_settings holds a Tamil, an English and a plain value per key");
  check(column("pages", "body_ta")?.t === "mediumtext" && column("pages", "body_en")?.t === "mediumtext", "pages bodies are MEDIUMTEXT");
  check(indexOn("pages", "slug")?.nu === 0 || indexOn("pages", "uniq_page_slug")?.nu === 0, "pages.slug is unique");
  check(indexOn("seo_settings", "path")?.nu === 0 || indexOn("seo_settings", "uniq_seo_path")?.nu === 0, "seo_settings.path is unique");
  const seeded = sql("SELECT slug FROM pages WHERE slug IN ('mission','history') ORDER BY slug").rows.map((r) => r.slug).join();
  check(seeded === "history,mission", "mission and history pages are seeded", seeded);
  saved = sql("SELECT key_name, value_ta, value_en, value FROM site_settings WHERE key_name IN (" + TOUCHED.map(() => "?").join(",") + ")", TOUCHED).rows;
  sql("DELETE FROM site_settings WHERE key_name IN (" + TOUCHED.map(() => "?").join(",") + ")", TOUCHED);

  /* ── server ─────────────────────────────────────────────────────────── */
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  base = `http://127.0.0.1:${port}`;
  const passHash = process.env.ADMIN_PASS_HASH
    || spawnSync(php, ["-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);", ADMIN.password], { encoding: "utf8" }).stdout.trim();
  server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: resolve(root, "backend"),
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash, SITE_URL: `http://127.0.0.1:${port}`, CONTACT_NOTIFY_EMAIL: "", CONTACT_NOTIFY_LANG: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/api/settings`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── public API with nothing edited ─────────────────────────────────── */
  let r = await api("/api/settings");
  check(r.status === 200 && r.json && typeof r.json.site === "object" && typeof r.json.seo === "object" && typeof r.json.languages === "object", "GET /api/settings carries site, seo and languages beside the homepage switches", r.text.slice(0, 200));
  check(r.json.site.phone_primary === "+919443002296" && r.json.site.temple_name && r.json.site.temple_name.ta === null, "built-in defaults: the phone; an unedited bilingual setting is null in both languages");
  check(!("contact_notify_email" in r.json.site) && !("contact_notify_lang" in r.json.site), "the office alert address never leaves the server");
  check(r.json.languages.enabled.join() === "ta,en" && r.json.languages.default === "ta", "languages: Tamil and English, Tamil first", JSON.stringify(r.json.languages));
  check(/max-age=60/.test(r.headers.get("cache-control") ?? ""), "settings are cacheable for a minute");
  r = await api("/api/pages");
  check(r.status === 200 && Array.isArray(r.json) && r.json.some((p) => p.slug === "mission") && r.json.every((p) => !("body_ta" in p) && "has_body" in p), "GET /api/pages lists the pages without their bodies");
  r = await api("/api/pages/mission");
  check(r.status === 200 && r.json.slug === "mission" && "body_ta" in r.json && "body_en" in r.json && r.json.title_ta === "நோக்கம்", "GET /api/pages/mission carries both bodies and the Tamil title");
  r = await api(`/api/pages/${SLUG}-none`);
  check(r.status === 404, "an unknown page is 404", `${r.status}`);
  r = await api("/api/pages/Bad_Slug");
  check(r.status === 404, "a slug outside the pattern is 404", `${r.status}`);
  r = await api("/api/pulse");
  check(r.status === 200 && r.json.hours.length === 2 && r.json.hours[0].open === "06:00" && r.json.schedule.length === 6 && r.json.schedule[0].name_en === "Thiruvanandal", "pulse: the built-in hours and daily schedule", JSON.stringify(r.json.hours));

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  for (const page of ["pages", "seo", "nalla_neram", "roles", "languages", "settings"]) {
    r = await anon.get(`/admin/${page}.php`);
    check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), `E2E-045 admin ${page} page redirects to sign-in`, `${r.status}`);
  }
  await anon.post("/admin/pages.php", { action: "save", id: "0", slug: SLUG, title_ta: `${P} அனாமதேய`, title_en: `${P} anonymous`, is_active: "1" });
  check(!findPage(SLUG), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in; sidebar and dashboard ──────────────────────────── */
  const owner = jar();
  r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/");
  check(r.status === 200 && !FATAL.test(r.text), "dashboard renders", `${r.status}`);
  for (const g of ["Content", "Temple", "Media", "Finance", "Communication", "Devotees", "System"]) {
    check(new RegExp(`<span class="sidebar__group">${g}</span>`).test(r.text), `sidebar group “${g}” (brief §15)`);
  }
  for (const [file, label] of [["pages.php", "Pages"], ["nalla_neram.php", "Nalla Neram"], ["seo.php", "SEO"], ["roles.php", "Roles"], ["languages.php", "Languages"], ["users.php", "Users"]]) {
    check(new RegExp(`href="/admin/${file.replace(".", "\\.")}"[\\s\\S]{0,1500}?<span class="sidebar__link-label">${label}</span>`).test(r.text), `sidebar links ${label}`);
  }
  for (const card of ["Next poojas", "Online payments · 7 days", "Latest donations", "Recent CMS activity"]) {
    check(r.text.includes(card), `dashboard card “${card}”`);
  }

  /* ── roles: editor / finance / viewer ───────────────────────────────── */
  const uh = (await owner.get("/admin/users.php")).text;
  for (const [role, a] of Object.entries(ACCOUNTS)) {
    const res = await owner.post("/admin/users.php", { _csrf: csrfOf(uh), action: "save", id: "0", username: a.user, display_name: `${P} ${role}`, email: "", phone: "", role, password: a.issued, is_active: "1" });
    check(redirected(res), `owner creates the ${role} account`, `${res.status} ${flashOf(res.text)}`);
  }
  const sessions = {};
  for (const [role, a] of Object.entries(ACCOUNTS)) {
    const s = jar();
    await s.login(a.user, a.issued);
    const prof = await s.get("/admin/profile.php");
    await s.post("/admin/profile.php", { _csrf: csrfOf(prof.text), action: "password", current_password: a.issued, new_password: a.pw, confirm_password: a.pw });
    sessions[role] = s;
  }
  const matrix = [
    ["pages.php", 200, 403, 403], ["nalla_neram.php", 200, 403, 403], ["seo.php", 403, 403, 403], ["languages.php", 403, 403, 403], ["roles.php", 200, 200, 200], ["settings.php", 403, 403, 403],
  ];
  for (const [page, ...want] of matrix) {
    const got = [];
    for (const role of ["editor", "finance", "viewer"]) got.push((await sessions[role].get(`/admin/${page}`)).status);
    check(got.join() === want.join(), `E2E-013 ${page} → editor/finance/viewer ${want.join("/")}`, got.join("/"));
  }
  r = await sessions.finance.post("/admin/pages.php", { _csrf: "x", action: "save", id: "0", slug: SLUG, title_ta: "x", title_en: `${P} finance` });
  check(r.status === 403 && !findPage(SLUG), "E2E-046 finance POST to Pages is refused server-side", `${r.status}`);
  r = await sessions.editor.post("/admin/seo.php", { _csrf: "x", action: "save", path: `/${SLUG}`, title_en: `${P} editor` });
  check(r.status === 403 && !findSeo(`/${SLUG}`), "E2E-046 editor POST to SEO is refused server-side", `${r.status}`);
  r = await sessions.editor.post("/admin/pages.php", { _csrf: "forged", action: "save", id: "0", slug: SLUG, title_ta: "x", title_en: `${P} forged` });
  check(r.status === 200 && /security token|expired|try again/i.test(r.text) && !findPage(SLUG), "E2E-049 a forged CSRF token writes nothing", `${r.status}`);
  r = await sessions.editor.get("/admin/roles.php");
  check(/Capability matrix/.test(r.text) && /content\.edit/.test(r.text) && /Super Admin|Owner/.test(r.text), "the Roles page shows the capability matrix");

  /* ── Pages: create / edit / hide / delete ───────────────────────────── */
  const ed = sessions.editor;
  r = await ed.submit("/admin/pages.php", { action: "save", id: "0", slug: `${SLUG} Page!`, title_ta: `${P} வரலாறு`, title_en: `${P} History`, body_ta: `${P} முதல் பத்தி\n\nஇரண்டாம் பத்தி`, body_en: `${P} First paragraph\n\nSecond paragraph`, meta_description_en: `${P} meta`, sort_order: "5", is_active: "1" });
  check(redirected(r), "editor creates a page", `${r.status} ${flashOf(r.text)}`);
  let page = findPage(`${SLUG}-page`);
  check(page && page.title_ta === `${P} வரலாறு` && page.body_en.includes("Second paragraph") && page.sort_order === 5, "the address is slugified and both languages are stored", JSON.stringify(page ?? null));
  check(audits("page_created", `page:${page.id}`) === 1, "audit: page_created");
  r = await api(`/api/pages/${SLUG}-page`);
  check(r.status === 200 && r.json.body_ta.startsWith(`${P} முதல்`) && r.json.meta_description_en === `${P} meta`, "the new page is served by the API");
  r = await api("/api/pages");
  check(r.json.some((p) => p.slug === `${SLUG}-page` && p.has_body === true), "and listed with has_body");
  r = await ed.submit("/admin/pages.php", { action: "save", id: "0", slug: `${SLUG}-page`, title_ta: "x", title_en: `${P} dup`, is_active: "1" });
  check(r.status === 200 && fieldError(r.text, "pg-slug-err") && !findPage(`${SLUG}-dup`) && sql("SELECT COUNT(*) AS n FROM pages WHERE slug = ?", [`${SLUG}-page`]).rows[0].n === 1, "a second page with the same address is refused");
  r = await ed.submit("/admin/pages.php", { action: "save", id: "0", slug: `${SLUG}-notitle`, title_ta: "", title_en: `${P} no tamil`, is_active: "1" });
  check(r.status === 200 && fieldError(r.text, "pg-title-ta-err") && !findPage(`${SLUG}-notitle`), "a page without a Tamil title is refused");
  r = await ed.submit("/admin/pages.php", { action: "save", id: String(page.id), slug: `${SLUG}-page`, title_ta: `${P} வரலாறு`, title_en: `${P} History edited`, body_ta: XSS, body_en: SQLI, is_active: "1" });
  check(redirected(r), "editor edits the page", `${r.status}`);
  page = findPage(`${SLUG}-page`);
  check(page.title_en === `${P} History edited` && page.body_en === SQLI.trim() && !page.body_ta.includes("<script>") && sql("SELECT COUNT(*) AS n FROM pages").rows[0].n >= 2, "E2E-047/048 hostile bodies stored as text, tags stripped, the table intact", page.body_ta);
  check(audits("page_updated", `page:${page.id}`) === 1, "audit: page_updated");
  r = await ed.get("/admin/pages.php");
  check(!/<script>alert\(1\)/.test(r.text) && r.text.includes(`${P} History edited`), "the list escapes hostile input");
  r = await ed.submit("/admin/pages.php", { action: "toggle", id: String(page.id) });
  check(redirected(r) && findPage(`${SLUG}-page`).is_active === 0, "editor hides the page");
  r = await api(`/api/pages/${SLUG}-page`);
  check(r.status === 404, "a hidden page is 404 for the public", `${r.status}`);
  check(!(await api("/api/pages")).json.some((p) => p.slug === `${SLUG}-page`), "and not listed");
  check(audits("page_toggled", `page:${page.id}`) === 1, "audit: page_toggled");
  r = await ed.submit("/admin/pages.php", { action: "delete", id: String(page.id) });
  check(redirected(r) && !findPage(`${SLUG}-page`), "editor deletes the page");
  check(audits("page_deleted", `page:${page.id}`) === 1, "audit: page_deleted");

  /* ── Settings: temple details ───────────────────────────────────────── */
  const site = (body) => owner.submit("/admin/settings.php", { form: "site", ...body });
  r = await owner.get("/admin/settings.php");
  check(r.status === 200 && /name="temple_name_ta"[^>]*lang="ta"/.test(r.text) && /name="temple_name_en"/.test(r.text) && /name="temple_hours"/.test(r.text) && /name="pooja_schedule"/.test(r.text) && /name="social_youtube"/.test(r.text) && /name="contact_notify_email"/.test(r.text), "the settings page has the temple-details form (bilingual, hours, schedule, social, office)");
  r = await site({ phone_primary: "phone me", email: "not-an-email", social_youtube: "http://youtube.com/x", coming_soon_days: "0", temple_hours: "06:00 - 05:00", daily_special: "one | two", pooja_schedule: "25:00 | a | b" });
  check(r.status === 200 && ["err-phone_primary", "err-email", "err-social_youtube", "err-coming_soon_days", "err-temple_hours", "err-daily_special", "err-pooja_schedule"].every((id) => fieldError(r.text, id)), "each bad value is refused with its own message");
  check(!setting("phone_primary") && !setting("temple_hours"), "and nothing was saved");
  r = await site({ temple_name_ta: `${P} கோயில்`, temple_name_en: `${P} Temple`, phone_primary: "+91 94430 02296", email: "office@example.org", social_youtube: "https://youtube.com/@temple", coming_soon_days: "5", temple_hours: "05:30 - 12:00\n17:00 - 21:30", pooja_schedule: "07:00 | காலை பூஜை | Morning Pooja\n19:00 | மாலை பூஜை | Evening Pooja", daily_special: "ஞா | Sun\nதி | Mon\nசெ | Tue\nபு | Wed\nவி | Thu\nவெ | Fri\nச | Sat", contact_notify_email: "office@example.org, second@example.org", hero_lead_en: `${P} lead` });
  check(redirected(r) && /#site$/.test(r.headers.get("location") ?? ""), "owner saves the temple details", `${r.status} ${flashOf(r.text)}`);
  check(setting("temple_name")?.value_ta === `${P} கோயில்` && setting("phone_primary")?.value === "+919443002296" && setting("coming_soon_days")?.value === "5", "values are stored, the phone without spaces", JSON.stringify(setting("phone_primary")));
  check(audits("site_settings_saved", "site_settings") >= 1, "audit: site_settings_saved");
  r = await api("/api/settings");
  check(r.json.site.temple_name.ta === `${P} கோயில்` && r.json.site.temple_name.en === `${P} Temple` && r.json.site.email === "office@example.org" && r.json.site.social_youtube === "https://youtube.com/@temple" && r.json.site.coming_soon_days === "5", "GET /api/settings serves the saved details");
  check(!("contact_notify_email" in r.json.site), "the office address is still private");
  r = await api("/api/pulse");
  check(r.json.hours.length === 2 && r.json.hours[1].open === "17:00" && r.json.schedule.length === 2 && r.json.schedule[1].name_en === "Evening Pooja" && r.json.todaySpecial && /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/.test(r.json.todaySpecial.en), "pulse: the committee's hours, schedule and specials", JSON.stringify([r.json.hours, r.json.schedule, r.json.todaySpecial]));
  r = await owner.get("/admin/settings.php");
  check(r.text.includes("05:30 - 12:00\n17:00 - 21:30") && r.text.includes(`${P} Temple`), "the form shows what was saved, hours as typed lines");
  r = await site({ temple_name_ta: "", temple_name_en: "", phone_primary: "", email: "", social_youtube: "", coming_soon_days: "", temple_hours: "", pooja_schedule: "", daily_special: "", contact_notify_email: "", hero_lead_en: "" });
  check(redirected(r), "owner clears the fields", `${r.status}`);
  r = await api("/api/settings");
  check(r.json.site.phone_primary === "+919443002296" && r.json.site.temple_name.en === null && r.json.site.coming_soon_days === "3", "empty fields fall back to the defaults");
  r = await api("/api/pulse");
  check(r.json.hours[0].open === "06:00" && r.json.schedule.length === 6, "pulse is back on the built-in hours");

  /* ── Nalla Neram ────────────────────────────────────────────────────── */
  const windows = (a, b) => { const o = {}; for (let d = 0; d < 7; d++) { o[`from_${d}_0`] = a[0]; o[`to_${d}_0`] = a[1]; o[`from_${d}_1`] = b[0]; o[`to_${d}_1`] = b[1]; } return o; };
  r = await ed.get("/admin/nalla_neram.php");
  check(r.status === 200 && /name="from_0_0"/.test(r.text) && /name="to_6_1"/.test(r.text) && /Built-in table/.test(r.text), "editor opens Nalla Neram with fourteen windows on the built-in table");
  r = await ed.submit("/admin/nalla_neram.php", { action: "save", ...windows(["09:00", "07:30"], ["22:30", "24:00"]) });
  check(r.status === 200 && fieldError(r.text, "err-0_0") && !setting("nalla_neram"), "a window that ends before it starts is refused, nothing saved");
  r = await ed.submit("/admin/nalla_neram.php", { action: "save", ...windows(["08:15", "09:45"], ["20:00", "21:30"]) });
  check(redirected(r), "editor saves the table", `${r.status} ${flashOf(r.text)}`);
  check(JSON.parse(setting("nalla_neram").value)[3][0][0] === "08:15", "the table is stored as JSON");
  check(audits("nalla_neram_saved", "site_settings:nalla_neram") >= 1, "audit: nalla_neram_saved");
  const ym = new Date().toISOString().slice(0, 7);
  r = await api(`/api/calendar?month=${ym}`);
  const day = r.json.days?.[0];
  check(r.status === 200 && day && JSON.stringify(day.timings.nalla_neram) === JSON.stringify([["08:15", "09:45"], ["20:00", "21:30"]]), "the calendar shows the committee's windows", JSON.stringify(day?.timings?.nalla_neram));
  r = await api("/api/settings");
  check(Array.isArray(r.json.site.nalla_neram) ? r.json.site.nalla_neram[0][0][0] === "08:15" : JSON.parse(r.json.site.nalla_neram)[0][0][0] === "08:15", "GET /api/settings carries the table");
  r = await ed.get("/admin/nalla_neram.php");
  check(/Edited by the committee/.test(r.text) && /action" value="reset"/.test(r.text), "the page says the table was edited and offers a reset");
  r = await ed.submit("/admin/nalla_neram.php", { action: "reset" });
  check(redirected(r) && !setting("nalla_neram")?.value, "reset returns to the built-in table");
  r = await api(`/api/calendar?month=${ym}`);
  check(r.json.days[0].timings.nalla_neram[0][0] !== "08:15", "and the calendar follows");

  /* ── Languages ──────────────────────────────────────────────────────── */
  r = await owner.submit("/admin/languages.php", { default: "ta" });
  check(r.status === 200 && /at least one language/i.test(r.text), "no language at all is refused");
  r = await owner.submit("/admin/languages.php", { "enabled[en]": "1", default: "ta" });
  check(r.status === 200 && /must be one of the languages/i.test(r.text), "a default that is not offered is refused");
  r = await owner.submit("/admin/languages.php", { "enabled[ta]": "1", "enabled[en]": "1", default: "en" });
  check(redirected(r), "owner makes English the default", `${r.status}`);
  r = await api("/api/settings");
  check(r.json.languages.enabled.join() === "ta,en" && r.json.languages.default === "en", "GET /api/settings says so", JSON.stringify(r.json.languages));
  check(audits("languages_saved", "site_settings:languages") >= 1, "audit: languages_saved");
  r = await owner.submit("/admin/languages.php", { "enabled[ta]": "1", "enabled[en]": "1", default: "ta" });
  check(redirected(r) && (await api("/api/settings")).json.languages.default === "ta", "and back to Tamil");

  /* ── SEO overrides ──────────────────────────────────────────────────── */
  const before = await preview("/about");
  check(before.status === 200 && before.title !== "" && !("robots" in before.meta), "built-in preview of /about: a title, indexable", JSON.stringify(before.meta));
  const sitemapBefore = (await api("/sitemap.xml")).text;
  check(sitemapBefore.includes(`/about</loc>`), "the sitemap lists /about");
  r = await owner.submit("/admin/seo.php", { action: "save", path: "about", title_ta: `${P} எங்களைப் பற்றி`, title_en: `${P} About the temple`, description_en: `${P} the override description`, og_image: "https://cdn.example.org/e2e-preview.jpg", noindex: "1", is_active: "1" });
  check(redirected(r), "owner creates an override for /about", `${r.status} ${flashOf(r.text)}`);
  const seo = findSeo("/about");
  check(seo && seo.noindex === 1 && seo.title_ta === `${P} எங்களைப் பற்றி`, "the path is normalised and the override stored", JSON.stringify(seo ?? null));
  check(audits("seo_created", `seo:${seo.id}`) === 1, "audit: seo_created");
  let after = await preview("/about");
  check(after.title.startsWith(`${P} About the temple`) && after.meta["og:title"] === `${P} About the temple` && after.meta.description === `${P} the override description` && /noindex/.test(after.meta.robots ?? "") && after.meta["og:image"] === "https://cdn.example.org/e2e-preview.jpg", "the server preview uses the override in English, with the robots directive and the image", JSON.stringify(after.meta));
  after = await preview("/about", "ta");
  check(after.meta["og:title"] === `${P} எங்களைப் பற்றி` && after.meta.description === `${P} the override description`, "in Tamil the Tamil title, and the English description as fallback");
  check(!(await api("/sitemap.xml")).text.includes(`/about</loc>`), "a noindex page leaves the sitemap");
  r = await api("/api/settings");
  check(r.json.seo["/about"] && r.json.seo["/about"].title_en === `${P} About the temple` && r.json.seo["/about"].noindex === true, "GET /api/settings carries the override for the React <Seo>");
  r = await owner.submit("/admin/seo.php", { action: "save", path: "/about", title_en: `${P} twice`, is_active: "1" });
  check(r.status === 200 && fieldError(r.text, "seo-path-err") && findSeo("/about").title_en !== `${P} twice`, "a second override for the same address is refused");
  r = await owner.submit("/admin/seo.php", { action: "save", path: "/about", id: String(seo.id), title_en: `${P} twice`, is_active: "1", og_image: "javascript:alert(1)" });
  check(r.status === 200 && fieldError(r.text, "seo-img-err"), "a script image address is refused");
  r = await owner.submit("/admin/seo.php", { action: "save", path: "no spaces here", title_en: `${P} bad path`, is_active: "1" });
  check(r.status === 200 && fieldError(r.text, "seo-path-err"), "a path with spaces is refused");
  r = await owner.submit("/admin/seo.php", { action: "toggle", id: String(seo.id) });
  check(redirected(r) && findSeo("/about").is_active === 0, "owner switches the override off");
  after = await preview("/about");
  check(after.title === before.title && !("robots" in after.meta), "the built-in words are back");
  check((await api("/sitemap.xml")).text.includes(`/about</loc>`), "and /about is back in the sitemap");
  check(audits("seo_toggled", `seo:${seo.id}`) === 1, "audit: seo_toggled");
  r = await owner.submit("/admin/seo.php", { action: "delete", id: String(seo.id) });
  check(redirected(r) && !findSeo("/about"), "owner deletes the override");
  check(audits("seo_deleted", `seo:${seo.id}`) === 1, "audit: seo_deleted");

  /* ── the dashboard shows the CMS activity ───────────────────────────── */
  r = await owner.get("/admin/");
  check(r.text.includes("seo deleted") && r.text.includes("languages saved") && r.text.includes("nalla neram saved"), "Recent CMS activity lists the changes just made");
  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\ncms-settings: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\ncms-settings: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  sql("DELETE FROM pages WHERE slug LIKE ?", [`${SLUG}%`]);
  sql("DELETE FROM seo_settings WHERE title_en LIKE ? OR title_ta LIKE ? OR path LIKE ?", [`${P}%`, `${P}%`, `/${SLUG}%`]);
  sql("DELETE FROM site_settings WHERE key_name IN (" + TOUCHED.map(() => "?").join(",") + ")", TOUCHED);
  for (const row of saved) sql("INSERT INTO site_settings (key_name, value_ta, value_en, value) VALUES (?, ?, ?, ?)", [row.key_name, row.value_ta, row.value_en, row.value]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2ecms_${RUN}_%`]);
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ? OR (action IN ('site_settings_saved','nalla_neram_saved','languages_saved','seo_created','seo_toggled','seo_deleted','seo_updated') AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE))", [`%${P}%`, `%${P}%`, `e2ecms_${RUN}_%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
