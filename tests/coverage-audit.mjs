#!/usr/bin/env node
/**
 * Coverage audit: every public API route, every admin page and every page of
 * the React site is requested by at least one suite.
 *
 * The inventory is read from the source, not kept by hand, so a new route, a
 * new admin page or a new <Route> that no suite exercises fails this check:
 *   - API: the GET/POST table in backend/api/index.php, its pattern routes
 *     (payments actions, live-streams sub-routes, events/:id, pages/:slug,
 *     tracked links, webhooks, crons), the /api/v1 aliases, and the files
 *     Apache calls directly (og.php, sitemap.php, robots.php, spa.php);
 *   - admin: every backend/admin/*.php;
 *   - site: every path="…" in frontend/src/App.jsx, looked for in the browser
 *     suites only (a page counts when a browser has opened it).
 * The brief's E2E-001…055 cases must each be named in docs/TESTING.md as
 * Covered (or Covered (simulated)).
 *
 * Static: no server, no database. Usage: node tests/coverage-audit.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(ROOT + p, "utf8");
const results = [];
const check = (ok, name, detail = "") => results.push({ ok: !!ok, name, detail });

const suites = readdirSync(ROOT + "tests")
  .filter((f) => /\.(mjs|php)$/.test(f) && f !== "coverage-audit.mjs")
  .map((f) => ({ name: f, src: read("tests/" + f) }));
const BROWSER_SUITES = new Set(["public-e2e.mjs", "public-content-ui.mjs", "public-pages.mjs", "payments-ui.mjs", "live-ui.mjs", "lighthouse.mjs", "pwa.mjs"]);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const whoUses = (re, only) => suites.filter((s) => (!only || only.has(s.name)) && re.test(s.src)).map((s) => s.name);
function cover(kind, label, re, only) {
  const by = whoUses(re, only);
  check(by.length > 0, `${kind} ${label}`, by.length ? by.slice(0, 4).join(", ") + (by.length > 4 ? ` +${by.length - 4}` : "") : "no suite requests it");
  return by.length;
}
// "/announcements" but not "/announcements.php" or "/announcements-x".
const apiPath = (p) => new RegExp(esc(p) + "(?![\\w.-])");

/* ── API ─────────────────────────────────────────────────────────────── */
const index = read("backend/api/index.php");
const table = index.slice(index.indexOf("$routes = ["));
let method = null;
const tableRoutes = [];
for (const line of table.split("\n")) {
  const m = line.match(/'(GET|POST)'\s*=>\s*\[/);
  if (m) { method = m[1]; continue; }
  const r = line.match(/'(\/[a-z_\/-]+)'\s*=>\s*'([a-z_]+\.php)'/);
  if (r && method) tableRoutes.push({ method, path: r[1] });
  if (/^\];/.test(line.trim())) break;
}
check(tableRoutes.length >= 20, "inventory: the route table in backend/api/index.php was read", `${tableRoutes.length} routes`);
for (const { method: m, path } of tableRoutes) cover("API", `${m} ${path}`, apiPath(path));

const alternation = (re) => {
  const m = index.match(re);
  return m ? m[1].split("|") : [];
};
const payActions = alternation(/\^\/payments\/\(([a-z|\/-]+)\)\$/);
check(payActions.length >= 10, "inventory: the payments actions were read", payActions.join(" "));
for (const a of payActions) cover("API", `/payments/${a}`, apiPath(`/payments/${a}`));

const liveSubs = alternation(/\^\/live-streams\(\?:\/\(([a-z|]+)\|/);
check(liveSubs.length >= 4, "inventory: the live-streams sub-routes were read", liveSubs.join(" "));
cover("API", "/live-streams", apiPath("/live-streams"));
for (const s of liveSubs) cover("API", `/live-streams/${s}`, apiPath(`/live-streams/${s}`));
cover("API", "/live-streams/<id or slug>", /\/live-streams\/(\$\{|[0-9]+(?![\w.-])|[a-z0-9]+-[a-z0-9-]+)/);
cover("API", "/live-streams/<id>/donations", /\/live-streams\/[^"'`\s]*\/donations/);
cover("API", "/live-subscriptions", apiPath("/live-subscriptions"));
cover("API", "/live-subscriptions/unsubscribe", apiPath("/live-subscriptions/unsubscribe"));
cover("API", "/admin/live-streams", apiPath("/api/admin/live-streams"));
cover("API", "/admin/live-streams/<id>", /\/api\/admin\/live-streams\/(\$\{|[0-9])/);
cover("API", "/events/<id>", /\/events\/(\$\{|[0-9])/);
cover("API", "/pages/<slug>", /\/api\/(v1\/)?pages\/(\$\{|[a-z])/);
cover("API", "/registrations", apiPath("/registrations"));
cover("API", "/n/<kind>/<token> (tracked links)", /\/n\/(\$\{|[cou]\/)/);
cover("API", "/notify-webhook/<provider>", /notify-webhook\//);
cover("API", "/notify-cron", /notify-cron|notify_cron/);
cover("API", "/payments-cron", /payments-cron|payments_cron/);
cover("API", "/live-cron", /live-cron|live_cron/);
for (const alias of ["/home", "/streams", "/sponsors"]) cover("API", `/v1${alias} (v1 alias)`, apiPath(`/v1${alias}`));
for (const f of ["og.php", "sitemap.php", "robots.php", "spa.php"]) cover("API", `${f} (called by Apache)`, new RegExp(esc(f) + "|" + (f === "sitemap.php" ? "sitemap\\.xml" : f === "robots.php" ? "robots\\.txt" : "\\b\\B")));

// Every file in backend/api is reached by one of the routes above.
const apiFiles = readdirSync(ROOT + "backend/api").filter((f) => f.endsWith(".php") && f !== "index.php");
for (const f of apiFiles) {
  check(index.includes(`'${f}'`) || index.includes(`/${f}'`) || ["og.php", "sitemap.php", "robots.php", "spa.php"].includes(f), `API file ${f} is routed`, "");
}

/* ── Admin pages ─────────────────────────────────────────────────────── */
const adminPages = readdirSync(ROOT + "backend/admin").filter((f) => f.endsWith(".php"));
for (const f of adminPages) cover("admin", f, new RegExp("(admin/|['\"`/])" + esc(f)));

/* ── React site ──────────────────────────────────────────────────────── */
const app = read("frontend/src/App.jsx");
const spaPaths = [...app.matchAll(/<Route\s+(?:key=\{[^}]+\}\s+)?path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "*");
check(spaPaths.length >= 25, "inventory: the routes in App.jsx were read", `${spaPaths.length} paths`);
for (const p of spaPaths) {
  if (p === "/") { cover("site", "/", /["'`]\/["'`]|base \+ "\/"|goto\(base\)/, BROWSER_SUITES); continue; }
  const re = p.includes(":")
    ? new RegExp("[\"'`/]" + esc(p.split("/:")[0]) + "/(\\$\\{|[a-z0-9])")
    : new RegExp("[\"'`/]" + esc(p) + "(?![\\w-])");
  cover("site", "/" + p, re, BROWSER_SUITES);
}
// Legacy paths that redirect (the key={path} map) are checked by name.
const legacy = app.match(/\[((?:"[^"]+",?\s*)+)\]\.map\(\(path\)/);
for (const p of legacy ? [...legacy[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []) cover("site", `/${p} (redirects to /register)`, new RegExp("[\"'`/]" + esc(p) + "(?![\\w-])"), BROWSER_SUITES);
cover("site", "an unknown path (404)", /404|not-found|does-not-exist|no-such/i, BROWSER_SUITES);

/* ── Brief E2E cases ─────────────────────────────────────────────────── */
const testing = read("docs/TESTING.md");
for (let n = 1; n <= 55; n++) {
  const id = "E2E-" + String(n).padStart(3, "0");
  const row = testing.split("\n").find((l) => l.startsWith(`| ${id} |`));
  const status = row ? row.split("|")[3].trim() : "missing";
  check(/^Covered/.test(status), `${id} is Covered in docs/TESTING.md`, status);
}

/* ── Report ──────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
const count = (k) => results.filter((r) => r.name.startsWith(k + " ")).length;
console.log(`\ninventory: ${count("API")} API routes and files, ${count("admin")} admin pages, ${count("site")} site paths, 55 brief cases`);
console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
