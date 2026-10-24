#!/usr/bin/env node
/**
 * tests/structured-data.mjs — what crawlers and link unfurlers read beyond the
 * title and description (brief §22): schema.org structured data from
 * backend/api/og.php, the album- and photo-aware gallery previews, and the
 * album entries of sitemap.xml (migration 021).
 *
 *   "/"                     one HinduTemple record: name, address, telephone,
 *                           url, opening hours — parseable JSON in both languages
 *   /events/<id>            an Event record (name, startDate, location); a
 *                           hostile title cannot close the script tag
 *   /live-darshan/<slug>    a VideoObject published as a BroadcastEvent
 *                           (isLiveBroadcast, startDate)
 *   /gallery?album=<slug>   the album's own title in each language, canonical
 *                           keeps ?album=; an unknown album previews as the gallery
 *   /gallery?photo=<id>     titled by the caption, described by the alt text in
 *                           the reader's language; a hidden photo previews as the gallery
 *   sitemap.xml             lists /gallery?album=<slug> only while the album
 *                           holds a shown photo
 *
 *   node tests/structured-data.mjs
 *
 * Starts its own PHP server (SITE_URL=https://temple.example). Needs the DB_*
 * environment and migrations 011, 020, 021. Rows carry E2E-SD-<run> and are
 * removed in `finally`.
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
const P = `E2E-SD-${RUN}`;
const origin = "https://temple.example";
const ALBUM = "navaratri";
let checks = 0;
let log = "";
let server;
let base;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; console.log(`✓ ${label}`); };

function run(script, command, data) {
  const r = spawnSync(php, [resolve(root, script), command, "-"], { cwd: root, input: JSON.stringify(data), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
const sql = (query, params = []) => run("tests/support/live_fixtures.php", "sql", { query, params });
const fixture = (command, data = {}) => run("tests/support/live_fixtures.php", command, data);
const decode = (t) => t.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const dateIn = (days) => { const d = new Date(Date.now() + 330 * 60000); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

async function preview(path, lang = "en") {
  const r = await fetch(base + path, { headers: { "User-Agent": "WhatsApp/2.23.20.0 A", "Accept-Language": lang } });
  const html = await r.text();
  const meta = Object.fromEntries([...html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)].map((m) => [m[1], decode(m[2])]));
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let ld = [];
  let parsed = true;
  for (const s of scripts) {
    try { const v = JSON.parse(s); ld.push(...(Array.isArray(v) ? v : [v])); } catch { parsed = false; }
  }
  return { status: r.status, html, meta, scripts, ld, parsed, canonical: decode(/<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] || "") };
}
const typeOf = (rec) => (Array.isArray(rec?.["@type"]) ? rec["@type"] : [rec?.["@type"]]);
const find = (ld, type) => ld.find((r) => typeOf(r).includes(type));

let eventId = 0;
let photoId = 0;
let albumId = 0;
try {
  /* ── server ─────────────────────────────────────────────────────────── */
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  base = `http://127.0.0.1:${port}`;
  server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], { cwd: resolve(root, "backend"), env: { ...process.env, SITE_URL: origin }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try { ready = (await fetch(`${base}/api/settings`)).ok; } catch { await delay(100); }
  }
  check(ready, "PHP server started");

  /* ── "/" — the temple ──────────────────────────────────────────────── */
  for (const lang of ["en", "ta"]) {
    const p = await preview("/", lang);
    check(p.status === 200 && p.scripts.length >= 1 && p.parsed, `/ (${lang}): structured data is present and parses`, `${p.scripts.length} scripts`);
    const temple = find(p.ld, "HinduTemple") ?? find(p.ld, "PlaceOfWorship");
    check(Boolean(temple) && temple["@context"] === "https://schema.org", `/ (${lang}): one schema.org HinduTemple record`, JSON.stringify(p.ld).slice(0, 200));
    check(typeof temple.name === "string" && temple.name.length > 3, `/ (${lang}): it names the temple`, temple.name);
    check(temple.address && typeOf(temple.address).includes("PostalAddress"), `/ (${lang}): with a PostalAddress`);
    check(typeof temple.telephone === "string" && /^\+?\d[\d\s-]{7,}$/.test(temple.telephone), `/ (${lang}): with the office telephone`, temple.telephone);
    check(typeof temple.url === "string" && temple.url.startsWith(origin), `/ (${lang}): its url is the site's own origin`, temple.url);
    check(Array.isArray(temple.openingHoursSpecification) && temple.openingHoursSpecification.length > 0, `/ (${lang}): with the opening hours`);
  }
  check((await preview("/", "ta")).ld.length > 0 && /[஀-௿]/.test(JSON.stringify(find((await preview("/", "ta")).ld, "HinduTemple") ?? {})), "/ (ta): the Tamil preview carries the Tamil name");

  /* ── /events/<id> — an Event, and a hostile title stays data ───────── */
  const hostile = `${P} </script><script>alert(1)</script> Festival`;
  const eventDate = dateIn(6);
  sql("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?, ?, ?, ?, 1)", [`${P} திருவிழா`, hostile, "Structured data test.", eventDate]);
  eventId = Number(sql("SELECT id FROM events WHERE title_en = ?", [hostile]).rows[0].id);
  const ev = await preview(`/events/${eventId}`, "en");
  check(ev.status === 200 && ev.parsed, "/events/<id>: 200 and the structured data parses");
  const record = find(ev.ld, "Event");
  check(Boolean(record) && record.name === hostile, "/events/<id>: an Event record named by the stored title", JSON.stringify(record ?? null).slice(0, 200));
  check(typeof record.startDate === "string" && record.startDate.startsWith(eventDate), "/events/<id>: startDate is the event day", record.startDate);
  check(record.location && (typeOf(record.location).includes("Place") || typeOf(record.location).includes("HinduTemple") || typeOf(record.location).includes("PlaceOfWorship")), "/events/<id>: located at the temple");
  // Either JSON escape (< or <\/) keeps the tag closed; the name above
  // already proved the title decodes back intact.
  check(!ev.scripts.some((s) => /<\/script/i.test(s)) && ev.scripts.some((s) => /\\u003C\/script|<\\\/script/i.test(s)), "/events/<id>: the title's </script> is escaped inside the JSON", ev.scripts.join(" ").slice(0, 200));
  check(!/<script>alert\(1\)<\/script>/.test(ev.html), "/events/<id>: no executable script from the title anywhere in the page");
  const evTa = await preview(`/events/${eventId}`, "ta");
  check(find(evTa.ld, "Event")?.name === `${P} திருவிழா`, "/events/<id> (ta): the Tamil title in Tamil", find(evTa.ld, "Event")?.name);

  /* ── /live-darshan/<slug> — a broadcast ───────────────────────────── */
  const stream = fixture("create-stream", { title_prefix: P, label: "structured", status: "SCHEDULED", description_ta: "சோதனை", description_en: "Structured data test." });
  const live = await preview(`/live-darshan/${stream.slug}`, "en");
  check(live.status === 200 && live.parsed, "/live-darshan/<slug>: 200 and the structured data parses");
  const video = find(live.ld, "VideoObject");
  const broadcast = video?.publication ?? find(live.ld, "BroadcastEvent");
  check(Boolean(video), "/live-darshan/<slug>: a VideoObject", JSON.stringify(live.ld).slice(0, 200));
  check(Boolean(broadcast) && typeOf(broadcast).includes("BroadcastEvent") && broadcast.isLiveBroadcast === true, "…published as a live BroadcastEvent", JSON.stringify(broadcast ?? null).slice(0, 200));
  check(typeof broadcast.startDate === "string" && broadcast.startDate.length >= 10, "…with its scheduled start", broadcast.startDate);

  /* ── gallery album and photo previews, sitemap ─────────────────────── */
  albumId = Number(sql("SELECT id FROM gallery_albums WHERE slug = ?", [ALBUM]).rows[0]?.id ?? 0);
  check(albumId > 0, `the seeded album "${ALBUM}" exists (migration 021)`);
  const album = sql("SELECT title_ta, title_en, is_active FROM gallery_albums WHERE id = ?", [albumId]).rows[0];
  sql("INSERT INTO gallery (album_id, filename, caption, alt_ta, alt_en, is_active) VALUES (?, ?, ?, ?, ?, 1)",
    [albumId, `e2e-sd-${RUN}.jpg`, `${P} lamp`, `${P} விளக்கு ஏற்றும் பக்தர்கள்`, `${P} devotees lighting lamps`]);
  photoId = Number(sql("SELECT id FROM gallery WHERE caption = ?", [`${P} lamp`]).rows[0].id);

  for (const lang of ["en", "ta"]) {
    const a = await preview(`/gallery?album=${ALBUM}`, lang);
    check(a.status === 200 && a.meta["og:title"] === album[`title_${lang}`], `/gallery?album (${lang}): titled by the album`, a.meta["og:title"]);
    check(a.canonical === `${origin}/gallery?album=${ALBUM}`, `/gallery?album (${lang}): the canonical keeps ?album=`, a.canonical);
    const ph = await preview(`/gallery?photo=${photoId}`, lang);
    const alt = lang === "en" ? `${P} devotees lighting lamps` : `${P} விளக்கு ஏற்றும் பக்தர்கள்`;
    check(ph.meta["og:title"] === `${P} lamp` && ph.meta["og:description"] === alt, `/gallery?photo (${lang}): the caption and the ${lang === "en" ? "English" : "Tamil"} alt text`, `${ph.meta["og:title"]} / ${ph.meta["og:description"]}`);
    check(ph.meta["og:image:alt"] === alt, `/gallery?photo (${lang}): the image's alt is the alt text`, ph.meta["og:image:alt"]);
  }
  const unknown = await preview("/gallery?album=no-such-album-e2e", "en");
  check(unknown.status === 200 && unknown.meta["og:title"] === "Gallery" && !unknown.canonical.includes("album="), "an unknown album previews as the gallery itself", `${unknown.meta["og:title"]} ${unknown.canonical}`);

  let map = await (await fetch(`${base}/sitemap.xml`)).text();
  check(map.includes(`<loc>${origin}/gallery?album=${ALBUM}</loc>`), "sitemap.xml lists the album while it holds a shown photo");
  sql("UPDATE gallery SET is_active = 0 WHERE id = ?", [photoId]);
  const hiddenPhoto = await preview(`/gallery?photo=${photoId}`, "en");
  check(hiddenPhoto.meta["og:title"] === "Gallery", "a hidden photo previews as the gallery", hiddenPhoto.meta["og:title"]);
  const stillShown = Number(sql("SELECT COUNT(*) AS n FROM gallery WHERE album_id = ? AND is_active = 1", [albumId]).rows[0].n);
  map = await (await fetch(`${base}/sitemap.xml`)).text();
  check(stillShown > 0 || !map.includes(`/gallery?album=${ALBUM}</loc>`), "…and an album without a shown photo leaves the sitemap");

  check(!/(Fatal error|Warning:|Notice:|Deprecated:|Uncaught)/.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-400));
  console.log(`\nstructured-data: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\nstructured-data: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-1500));
  process.exitCode = 1;
} finally {
  try {
    if (eventId) sql("DELETE FROM events WHERE id = ?", [eventId]);
    sql("DELETE FROM events WHERE title_en LIKE ? OR title_ta LIKE ?", [`${P}%`, `${P}%`]);
    sql("DELETE FROM gallery WHERE caption LIKE ?", [`${P}%`]);
    fixture("cleanup", { title_prefix: P });
  } catch (e) {
    console.error(`cleanup: ${e.message}`);
  }
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
