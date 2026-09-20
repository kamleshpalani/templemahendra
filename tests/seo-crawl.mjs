#!/usr/bin/env node
/**
 * tests/seo-crawl.mjs — what a crawler gets from the server itself (brief §22,
 * E2E-044): /robots.txt, /sitemap.xml, and an honest status line for every
 * address the React app is asked for through the SPA fallback (api/spa.php).
 *
 *   PHP_BIN=php node tests/seo-crawl.mjs
 *
 * Starts its own PHP server on a free port with SITE_URL set, creates
 * broadcast fixtures titled "E2E-SEO-crawl<run> …" and removes them at the end.
 * Needs the MySQL environment (DB_HOST … DB_PASS) the other suites use.
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
const prefix = `E2E-SEO-crawl${Date.now()}`;
const origin = "https://temple.example";
let checks = 0;
let log = "";
let server;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };
function fixture(command, data = {}) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), command, "-"], {
    cwd: root, input: JSON.stringify(data), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
let base;
const get = async (path, headers = {}) => {
  const response = await fetch(base + path, { headers, redirect: "manual" });
  return { response, text: await response.text() };
};
const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

try {
  check(fixture("probe").tables, "live tables are available on MySQL");
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  base = `http://127.0.0.1:${port}`;
  server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: resolve(root, "backend"),
    env: { ...process.env, SITE_URL: origin },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => { log += data; });
  server.stderr.on("data", (data) => { log += data; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/robots.txt`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── robots.txt ─────────────────────────────────────────────────────── */
  let r = await get("/robots.txt");
  check(r.response.status === 200 && r.response.headers.get("content-type").startsWith("text/plain"), "robots.txt is plain text");
  check(/^User-agent: \*$/m.test(r.text), "robots.txt addresses every crawler");
  for (const path of ["/admin/", "/api/", "/search", "/payment/result", "/payment/receipt", "/payment/verify"]) {
    check(r.text.includes(`Disallow: ${path}\n`), `robots.txt disallows ${path}`);
  }
  check(!/Disallow: \/uploads/.test(r.text) && !/Disallow: \/$/m.test(r.text), "photos and pages stay crawlable");
  check(r.text.includes(`Sitemap: ${origin}/sitemap.xml`), "robots.txt points at the sitemap on the real origin");

  /* ── sitemap.xml ────────────────────────────────────────────────────── */
  const shown = fixture("create-stream", { title_prefix: prefix, label: "public", status: "SCHEDULED" });
  const recorded = fixture("create-stream", { title_prefix: prefix, label: "recorded", status: "COMPLETED" });
  const cancelled = fixture("create-stream", { title_prefix: prefix, label: "cancelled", status: "CANCELLED" });
  const draft = fixture("create-stream", { title_prefix: prefix, label: "draft", status: "DRAFT" });
  const gone = fixture("create-stream", { title_prefix: prefix, label: "deleted", status: "SCHEDULED", deleted: true });

  r = await get("/sitemap.xml");
  check(r.response.status === 200 && r.response.headers.get("content-type").startsWith("application/xml"), "sitemap.xml is XML");
  check(r.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && r.text.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"'), "sitemap protocol envelope");
  const urls = locs(r.text);
  check(urls.every((u) => u.startsWith(origin + "/") || u === origin + "/"), "every <loc> is on the configured origin", urls.find((u) => !u.startsWith(origin)));
  check(new Set(urls).size === urls.length, "no duplicate <loc>");
  for (const path of ["/", "/about", "/sevas", "/events", "/gallery", "/donations", "/donate", "/contact", "/panchangam", "/register", "/live-darshan", "/live-darshan/schedule", "/live-darshan/archive", "/privacy-policy", "/terms-and-conditions", "/refund-cancellation-policy", "/shipping-delivery-policy"]) {
    check(urls.includes(origin + path), `sitemap lists ${path}`);
  }
  check(!urls.includes(origin + "/search") && !urls.some((u) => u.includes("/payment/")), "search and payment pages are not listed");
  check(urls.includes(`${origin}/live-darshan/${shown.slug}`), "a scheduled broadcast is listed");
  check(urls.includes(`${origin}/live-darshan/${recorded.slug}`), "a recording is listed");
  check(!urls.includes(`${origin}/live-darshan/${cancelled.slug}`), "a cancelled broadcast is not listed");
  check(!urls.includes(`${origin}/live-darshan/${draft.slug}`), "a draft is not listed");
  check(!urls.includes(`${origin}/live-darshan/${gone.slug}`), "a deleted broadcast is not listed");
  check(new RegExp(`<loc>${origin}/live-darshan/${recorded.slug}</loc>\\s*<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`).test(r.text), "broadcast entries carry lastmod");
  check(!r.text.includes("<script") && !r.text.includes("sync_error"), "nothing but URLs in the sitemap");

  /* ── SPA fallback: honest status line (E2E-044) ─────────────────────── */
  const html = async (path, ua = "Mozilla/5.0") => get(path, { "User-Agent": ua });
  const isShell = (t) => /<div id="root">|Temple website/.test(t);
  for (const path of ["/", "/about", "/donate", "/live-darshan", "/live-darshan/schedule", "/live-darshan/archive", "/payment/result", "/login", `/live-darshan/${shown.slug}`, `/live-darshan/${shown.id}`, `/live-darshan/${cancelled.slug}`]) {
    r = await html(path);
    check(r.response.status === 200 && r.response.headers.get("content-type").startsWith("text/html") && isShell(r.text), `${path} → 200 shell`, `${r.response.status}`);
    check(!r.response.headers.get("x-robots-tag"), `${path} carries no noindex header`);
  }
  for (const path of ["/no-such-page", "/about/nothing-here", "/live-darshan/no-such-stream", `/live-darshan/${draft.slug}`, `/live-darshan/${gone.slug}`, "/live-darshan/999999999", "/admin-panel", "/.git/config"]) {
    r = await html(path);
    check(r.response.status === 404 && r.response.headers.get("content-type").startsWith("text/html") && isShell(r.text), `${path} → 404 shell`, `${r.response.status}`);
    check(r.response.headers.get("x-robots-tag") === "noindex, nofollow", `${path} header says noindex`);
  }
  r = await html("/about?utm_source=x#top");
  check(r.response.status === 200, "query and fragment do not change the answer");
  r = await html("/no-such-page", "WhatsApp/2.23");
  check(r.response.status === 404 && /noindex, nofollow/.test(r.text), "an unfurler still gets the 404 preview");
  r = await get("/api/no-such-route");
  check(r.response.status === 404 && r.response.headers.get("content-type").startsWith("application/json"), "API 404s stay JSON");
  r = await get("/includes/site_pages.php");
  check(r.response.status === 403, "closed directories stay closed");
  const direct = await get("/api/spa.php?path=/no-such-page");
  check(direct.response.status === 404, "direct endpoint agrees");
  const bare = await get("/api/spa.php");
  check(bare.response.status === 200, "the endpoint itself is the home shell");

  check(!/PHP (?:Warning|Fatal|Notice|Deprecated)|SQLSTATE/.test(log), "no PHP or MySQL errors", log.slice(-400));
  console.log(`${checks} passed, 0 failed`);
} finally {
  fixture("cleanup", { title_prefix: prefix });
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
