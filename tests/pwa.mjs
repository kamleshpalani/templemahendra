#!/usr/bin/env node
/**
 * tests/pwa.mjs — the installable app and its service worker, in a real
 * browser, against a production build (brief §24 mobile, §27 security, §34
 * performance).
 *
 *   PHP_BIN=/path/to/php node tests/pwa.mjs
 *
 * Builds the site into <repo>/.pwa-dist (PWA_BUILD=0 reuses the last one),
 * serves it with `vite preview` on :4181 proxying to its own PHP on :8106, and
 * drives Chromium with service workers allowed. The user's :8000 / :5173 are
 * never touched.
 *
 * What it proves
 *   manifest   index.html links exactly one manifest; it has the temple's
 *              name, start_url and scope "/", display standalone, the theme
 *              colour of the page, and 192 / 512 px icons that are served.
 *   install    /sw.js registers with scope "/", activates, and controls the
 *              page after a reload; the precache holds index.html and every
 *              script and stylesheet index.html loads.
 *   caching    a GET under /api is kept in "temple-api" (network first, for a
 *              weak signal at the temple); /api/payments/* and
 *              /api/live-streams/* are never kept in any cache (a payment
 *              status or an on-air flag must be the truth of this moment, and a
 *              receipt carries a donor's name and PAN).
 *   offline    with the network cut, a page visited before and one never
 *              visited both open from the app shell, in the language chosen.
 *   PHP paths  /admin/, /api/ and /uploads/ are never answered with the React
 *              app: online, /admin/login.php comes from PHP (not the service
 *              worker) and shows the committee's sign-in form; offline, those
 *              three fail as a network error instead of rendering the site.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FRONTEND = resolve(ROOT, "frontend");
const DIST = resolve(ROOT, ".pwa-dist");
const PHP_BIN = process.env.PHP_BIN || "php";
const viaBash = PHP_BIN.endsWith(".sh");
const PHP_PORT = 8106;
const PREVIEW_PORT = 4181;
const PHP_BASE = `http://127.0.0.1:${PHP_PORT}`;
const BASE = `http://127.0.0.1:${PREVIEW_PORT}`;
const viteBin = resolve(FRONTEND, "node_modules/vite/bin/vite.js");
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");

let passed = 0;
let failed = 0;
function check(cond, name, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}`);
    if (detail) console.log(`    ${String(detail).replace(/\s+/g, " ").slice(0, 600)}`);
  }
  return Boolean(cond);
}
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portInUse(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const sock = connect({ port, host });
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("error", () => done(false));
  });
}
async function waitForUrl(url, tries = 120) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return false;
}
function start(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, windowsHide: true });
  const server = { child, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  return server;
}
function stop(server) {
  if (!server) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  else server.child.kill("SIGTERM");
}

/** Every cache's URLs, read inside the page (Cache Storage is per origin). */
const cacheContents = (page) =>
  page.evaluate(async () => {
    const out = {};
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      out[name] = (await c.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
    }
    return out;
  });

let php = null;
let preview = null;
let browser = null;

try {
  section("Preflight");
  for (const port of [PHP_PORT, PREVIEW_PORT]) {
    if (await portInUse(port)) {
      console.log(`✗ port ${port} is already in use — stop whatever holds it (never the user's :8000/:5173)`);
      process.exit(2);
    }
  }
  if (process.env.PWA_BUILD !== "0" || !existsSync(resolve(DIST, "index.html"))) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const b = spawnSync(process.execPath, [viteBin, "build", "--outDir", DIST, "--emptyOutDir"], { cwd: FRONTEND, env, encoding: "utf8", windowsHide: true });
    check(b.status === 0, "the production build succeeds", (b.stderr || b.stdout || "").slice(-400));
  }
  check(existsSync(resolve(DIST, "sw.js")) && existsSync(resolve(DIST, "manifest.webmanifest")), "the build has sw.js and manifest.webmanifest");

  php = start(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, "-S", `127.0.0.1:${PHP_PORT}`, "router.php"] : ["-S", `127.0.0.1:${PHP_PORT}`, "router.php"], { cwd: resolve(ROOT, "backend"), env: process.env });
  check(await waitForUrl(`${PHP_BASE}/api/settings`), `PHP answers on ${PHP_BASE}`, php.log.slice(-300));
  const previewEnv = { ...process.env, VITE_PROXY_TARGET: PHP_BASE };
  delete previewEnv.NODE_OPTIONS;
  preview = start(process.execPath, [viteBin, "preview", "--outDir", DIST, "--port", String(PREVIEW_PORT), "--host", "127.0.0.1", "--strictPort"], { cwd: FRONTEND, env: previewEnv });
  check(await waitForUrl(`${BASE}/`), `the preview answers on ${BASE}`, preview.log.slice(-300));
  const proxied = await fetch(`${BASE}/api/settings`).then((r) => r.json()).catch(() => null);
  check(proxied && typeof proxied === "object", "the preview proxies /api to the test PHP");

  section("Manifest");
  const html = await fetch(`${BASE}/`).then((r) => r.text());
  const links = html.match(/<link[^>]+rel="manifest"[^>]*>/g) ?? [];
  check(links.length === 1 && /href="\/manifest\.webmanifest"/.test(links[0]), "index.html links exactly one manifest", JSON.stringify(links));
  const mres = await fetch(`${BASE}/manifest.webmanifest`);
  const manifest = await mres.json().catch(() => null);
  check(mres.ok && manifest, "the manifest is served and is JSON", mres.status);
  check(/Dhabbalavaar/.test(manifest?.name ?? "") && /தபலவார்/.test(manifest?.name ?? "") && manifest?.short_name === "Dhabbalavaar Temple", "the manifest names the temple in Tamil and English, with a short name", manifest?.name);
  check(manifest?.start_url === "/" && manifest?.scope === "/" && manifest?.display === "standalone", "start_url and scope are /, display standalone", JSON.stringify([manifest?.start_url, manifest?.scope, manifest?.display]));
  const themeMeta = html.match(/<meta name="theme-color" content="([^"]+)"/)?.[1];
  check(manifest?.theme_color && manifest.theme_color === themeMeta, "the manifest's theme colour matches the page's theme-color", `${manifest?.theme_color} / ${themeMeta}`);
  for (const size of ["192x192", "512x512"]) {
    const icon = (manifest?.icons ?? []).find((i) => i.sizes === size);
    const res = icon ? await fetch(`${BASE}${icon.src}`) : null;
    check(res?.ok && /image\/png/.test(res.headers.get("content-type") ?? ""), `the ${size} icon is listed and served as PNG`, icon?.src);
  }

  section("Install");
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "en-IN", serviceWorkers: "allow" });
  await ctx.addInitScript(() => {
    try { localStorage.setItem("temple:lang", "en"); } catch { /* private mode */ }
  });
  // Third parties are not under test; an empty answer keeps every wait about the site.
  await ctx.route((url) => /^https:\/\/(fonts\.(googleapis|gstatic)\.com|www\.google\.com\/maps|(www\.)?youtube(-nocookie)?\.com|i\.ytimg\.com)\//.test(url.href), (r) => r.fulfill({ status: 200, body: "" }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const reg = await page.evaluate(async () => {
    const r = await Promise.race([navigator.serviceWorker.ready, new Promise((res) => setTimeout(() => res(null), 20000))]);
    return r ? { scope: r.scope, script: r.active?.scriptURL, state: r.active?.state } : null;
  });
  check(reg?.scope === `${BASE}/` && reg?.script === `${BASE}/sw.js` && reg?.state === "activated", "/sw.js registers with scope / and activates", JSON.stringify(reg));
  await page.reload({ waitUntil: "networkidle" });
  check(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null) === `${BASE}/sw.js`, "after a reload the service worker controls the page");

  const caches0 = await cacheContents(page);
  const precacheName = Object.keys(caches0).find((n) => /precache/.test(n));
  const precached = precacheName ? caches0[precacheName].map((u) => u.split("?")[0]) : [];
  check(precached.includes("/index.html"), "the precache holds index.html", precacheName);
  const shellAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const missing = shellAssets.filter((a) => !precached.includes(a));
  check(shellAssets.length >= 2 && missing.length === 0, `the precache holds every script and stylesheet index.html loads (${shellAssets.length})`, JSON.stringify(missing));

  section("Runtime caching");
  await page.evaluate(async () => {
    for (const p of ["/api/settings", "/api/payments/config", "/api/live-streams/live", "/api/live-streams/upcoming"]) await fetch(p).catch(() => null);
  });
  await sleep(1500);
  const caches1 = await cacheContents(page);
  const everyUrl = Object.values(caches1).flat();
  check((caches1["temple-api"] ?? []).some((u) => u.startsWith("/api/settings")), "a GET under /api is kept in temple-api (network first)", JSON.stringify(caches1["temple-api"] ?? []));
  check(!everyUrl.some((u) => u.startsWith("/api/payments")), "nothing under /api/payments is kept in any cache", JSON.stringify(everyUrl.filter((u) => u.startsWith("/api/payments"))));
  check(!everyUrl.some((u) => u.startsWith("/api/live-streams")), "nothing under /api/live-streams is kept in any cache", JSON.stringify(everyUrl.filter((u) => u.startsWith("/api/live-streams"))));

  section("PHP paths online");
  const admin = await page.goto(`${BASE}/admin/login.php`, { waitUntil: "domcontentloaded" });
  check(admin?.status() === 200 && admin.fromServiceWorker() === false, "/admin/login.php is fetched from PHP, not answered by the service worker", `${admin?.status()} fromServiceWorker=${admin?.fromServiceWorker()}`);
  check((await page.locator('input[type="password"]').count()) === 1 && (await page.locator("#root").count()) === 0, "it shows the committee's sign-in form, not the React app");

  section("Offline");
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.goto(`${BASE}/about`, { waitUntil: "networkidle" });
  await ctx.setOffline(true);
  for (const path of ["/about", "/events", "/contact"]) {
    let ok = false;
    let why = "";
    try {
      const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      await page.locator("h1").first().waitFor({ timeout: 15000 });
      ok = res?.fromServiceWorker() === true && (await page.locator("#root").count()) === 1;
      why = `fromServiceWorker=${res?.fromServiceWorker()}`;
    } catch (e) {
      why = String(e.message || e).split("\n")[0];
    }
    check(ok, `offline: ${path} opens from the app shell${path === "/about" ? " (visited before)" : " (never visited)"}`, why);
  }
  check((await page.evaluate(() => document.documentElement.lang)) === "en", "offline: the chosen language is kept");
  for (const path of ["/admin/", "/api/settings", "/uploads/gallery/none.jpg"]) {
    let reached = null;
    try {
      const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
      reached = `${res?.status()} fromServiceWorker=${res?.fromServiceWorker()} root=${await page.locator("#root").count()}`;
    } catch (e) {
      reached = null;
    }
    check(reached === null, `offline: ${path} is a network error, never the React app`, reached ?? "");
  }
  await ctx.setOffline(false);
  check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  await ctx.close();
} catch (e) {
  check(false, "the suite ran to the end", String(e?.stack || e).split("\n").slice(0, 4).join(" "));
} finally {
  if (browser) await browser.close().catch(() => {});
  stop(preview);
  stop(php);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
