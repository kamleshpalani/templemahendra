import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const prefix = `E2E-LIVE-og${Date.now()}`;
const origin = "https://temple.example";
let checks = 0;
let log = "";
let server;
const check = (ok, label) => { assert.ok(ok, label); checks++; };
function fixture(command, data = {}) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), command, "-"], {
    cwd: root, input: JSON.stringify(data), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
let base;
async function preview(path, language = "ta") {
  const response = await fetch(base + path, {
    headers: { "User-Agent": "WhatsApp/2.23", "Accept-Language": language },
  });
  const html = await response.text();
  const meta = Object.fromEntries([...html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
  return { response, html, meta, canonical: decode(/<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] || "") };
}

try {
  check(fixture("probe").tables, "migration 011 is available on MySQL");
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
    try { ready = (await fetch(`${base}/api/og.php?path=/`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");
  const descriptions = { description_ta: "சோதனை நேரடி தரிசனம்", description_en: "A broadcast for the preview suite." };
  for (const status of ["SCHEDULED", "STARTING", "LIVE", "COMPLETED", "OFFLINE", "ERROR", "CANCELLED"]) {
    const row = fixture("create-stream", { title_prefix: prefix, label: status, status, ...descriptions });
    for (const lang of ["ta", "en"]) {
      const p = await preview(`/live-darshan/${row.slug}?utm_source=test`, lang);
      check(p.response.status === 200, `${status}/${lang}: public`);
      check(p.meta["og:title"] === row[`title_${lang}`], `${status}/${lang}: stored title`);
      check(p.meta["og:description"] === descriptions[`description_${lang}`], `${status}/${lang}: stored description`);
      check(p.meta["og:locale"] === `${lang}_IN`, `${status}/${lang}: locale`);
      check(p.meta["twitter:title"] === p.meta["og:title"] && p.meta["twitter:description"] === p.meta["og:description"], "Twitter agrees");
      check(p.canonical === `${origin}/live-darshan/${row.slug}` && p.meta["og:url"] === p.canonical, "canonical strips tracking");
      check(p.meta["og:type"] === "video.other" && !p.meta.robots, "public video is indexable");
      check(p.meta["og:image"].startsWith("https://i.ytimg.com/"), "provider thumbnail without remote fetch");
      check(!p.meta["og:image:width"] && !p.meta["og:image:height"], "remote dimensions not invented");
      check(p.response.headers.get("cache-control") === "public, max-age=60", "short crawler cache");
      check(p.response.headers.get("vary")?.includes("Accept-Language"), "language varies cache");
      check(!p.response.headers.get("set-cookie"), "preview has no session");
      check(!/sync_error|provider_broadcast_id|created_by/.test(p.html), "private fields absent");
    }
    const numeric = await preview(`/live-darshan/${row.id}?lang=en`);
    check(numeric.meta["og:title"] === row.title_en && numeric.canonical.endsWith(`/${row.slug}`), "numeric alias and query language");
    const uppercase = await preview(`/live-darshan/${row.slug.toUpperCase()}`);
    check(uppercase.canonical.endsWith(`/${row.slug}`), "saved lowercase slug is canonical");
  }
  const fallback = fixture("create-stream", { title_prefix: prefix, label: "fallback", description_en: "", description_ta: descriptions.description_ta, thumbnail_url: "https://images.example/pooja.jpg" });
  fixture("sql", { query: "UPDATE live_streams SET title_en = '' WHERE id = ?", params: [fallback.id] });
  let p = await preview(`/live-darshan/${fallback.slug}`, "en");
  check(p.meta["og:title"] === fallback.title_ta && p.meta["og:description"] === descriptions.description_ta, "other-language fallback");
  check(p.meta["og:image"] === "https://images.example/pooja.jpg", "custom HTTPS thumbnail");
  fixture("sql", { query: "UPDATE live_streams SET title_en = ?, description_ta = ?, description_en = ?, thumbnail_url = ? WHERE id = ?", params: ['A "title" <script>alert(1)</script>', "", "😀 ".repeat(150), "/icons/icon-512x512.png", fallback.id] });
  p = await preview(`/live-darshan/${fallback.slug}`, "en");
  check(p.meta["og:title"] === 'A "title" <script>alert(1)</script>' && !p.html.includes("<script>alert(1)</script>"), "stored title escaped");
  check(Array.from(p.meta["og:description"]).length === 200, "description caps Unicode code points");
  check(p.meta["og:image"] === `${origin}/icons/icon-512x512.png` && p.meta["og:image:width"] === "512", "local thumbnail dimensions");
  fixture("sql", { query: "UPDATE live_streams SET description_en = '', thumbnail_url = '/missing.jpg' WHERE id = ?", params: [fallback.id] });
  p = await preview(`/live-darshan/${fallback.slug}`, "en");
  check(p.meta["og:description"] === (await preview("/live-darshan", "en")).meta["og:description"], "empty description uses page lead");
  check(!p.meta["og:image"].endsWith("/missing.jpg"), "missing local thumbnail uses site fallback");
  for (const options of [{ status: "DRAFT" }, { status: "SCHEDULED", deleted: true }]) {
    const row = fixture("create-stream", { title_prefix: prefix, label: "hidden", ...options });
    p = await preview(`/live-darshan/${row.slug}`);
    check(p.response.status === 404 && p.meta.robots === "noindex, nofollow", "hidden rows return noindex/404");
    check(!p.html.includes(row.title_en) && !p.html.includes(row.title_ta), "hidden title not disclosed");
    check(p.response.headers.get("cache-control").includes("no-store"), "hidden preview not cached");
  }
  p = await preview("/live-darshan/no-such-stream?lang=en");
  check(p.response.status === 404 && p.meta["og:title"] === "Broadcast not found", "unknown stream");
  check((await preview("/live-darshan/schedule")).response.status === 200, "schedule remains static");
  const direct = await preview(`/api/og.php?path=/live-darshan/${fallback.slug}&lang=en`);
  check(direct.canonical.endsWith(`/${fallback.slug}`), "direct endpoint");
  check(!/PHP (?:Warning|Fatal|Notice)|SQLSTATE/.test(log), "no PHP or MySQL errors");
  console.log(`${checks} passed, 0 failed`);
} finally {
  fixture("cleanup", { title_prefix: prefix });
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
