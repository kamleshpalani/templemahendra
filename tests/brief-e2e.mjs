#!/usr/bin/env node
/**
 * tests/brief-e2e.mjs — the brief's §30 cases that no other suite states in
 * its own words (see the matrix in docs/TESTING.md):
 *
 *   E2E-006/007/008  upcoming pooja shown, expired excluded, next auto-selected
 *   E2E-014/015/016  admin creates, edits, archives (hides) a pooja
 *   E2E-017/018      admin creates an event; it is public
 *   E2E-019/020      admin creates an announcement; it reaches the homepage feed
 *   E2E-021/022/023  gallery upload lands and is public; a disguised PHP file is refused
 *   E2E-045          protected API rejects an unauthenticated caller
 *   E2E-047          SQL payloads are data, never SQL
 *   E2E-048          script payloads never come back executable
 *   E2E-049          a forged CSRF token changes nothing
 *
 *   node tests/brief-e2e.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1, so each request can
 * present a fresh X-Forwarded-For and the public flood limits never answer
 * first). Needs the DB_* environment and the admin account admin/Admin@Test123
 * (ADMIN_USERNAME / ADMIN_PASSWORD override). Every row it writes carries the
 * prefix "E2E-BRIEF-<run>" and is deleted in `finally`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-BRIEF-${RUN}`;
// The linked-event card has no title of its own (it takes the event's), so it is
// found for cleanup by this run-unique picture address.
const POSTER = `/uploads/${P.toLowerCase()}-poster.webp`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
// The temple office address the server is started with, so E2E-040 can look
// for exactly the notification the contact form raised (test email driver).
const OFFICE = `e2e-brief-office-${RUN}@example.test`;
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE poojas;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.90.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };
const isoDate = (offsetDays) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

/* one signed-in admin session */
let cookie = "";
const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
async function get(path, headers = {}) {
  const r = await fetch(base + path, { headers: { cookie, "X-Forwarded-For": xff(), ...headers }, redirect: "manual" });
  grab(r);
  return { status: r.status, headers: r.headers, text: await r.text() };
}
async function post(path, body, headers = {}) {
  const isForm = body instanceof FormData;
  const r = await fetch(base + path, {
    method: "POST", redirect: "manual",
    headers: { cookie, "X-Forwarded-For": xff(), ...(isForm ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...headers },
    body: isForm ? body : new URLSearchParams(body),
  });
  grab(r);
  return { status: r.status, headers: r.headers, text: await r.text() };
}
async function api(path, body, headers = {}) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { "X-Forwarded-For": xff(), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* checked by callers */ }
  return { status: r.status, headers: r.headers, text, json };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
let csrf = "";

const created = { poojas: [], events: [], announcements: [], widgets: [], gallery: [] };

try {
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
    env: {
      ...process.env, TRUSTED_PROXIES: "127.0.0.1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash,
      NOTIFY_ALLOW_TEST_DRIVER: "1", NOTIFY_EMAIL_DRIVER: "test", CONTACT_NOTIFY_EMAIL: OFFICE,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/api/announcements`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── E2E-045: protected API without a session ───────────────────────── */
  let r = await api("/api/admin/live-streams");
  check(r.status === 401 && r.json?.code === "unauthenticated", "E2E-045 admin API answers 401 without a session", `${r.status} ${r.text.slice(0, 80)}`);
  r = await get("/admin/poojas.php");
  check((r.status === 302 || r.status === 303) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 admin page redirects to sign-in", `${r.status}`);

  /* ── sign in ────────────────────────────────────────────────────────── */
  r = await get("/admin/login.php");
  r = await post("/admin/login.php", { _csrf: csrfOf(r.text), username: ADMIN.username, password: ADMIN.password, next: "" });
  check((r.status === 302 || r.status === 303) && !/login\.php/.test(r.headers.get("location") ?? ""), "admin signed in", `${r.status} ${r.headers.get("location")} ${r.text.match(/alert[^>]*>([^<]+)/)?.[1]}`);
  csrf = csrfOf((await get("/admin/poojas.php")).text);
  check(csrf.length >= 32, "CSRF token issued");

  /* ── E2E-049: a forged token changes nothing ────────────────────────── */
  const before = sql("SELECT COUNT(*) AS n FROM poojas").rows[0].n;
  r = await post("/admin/poojas.php", { _csrf: "forged-" + csrf.slice(0, 20), action: "save", id: "0", name_ta: `${P} போலி`, name_en: `${P} forged`, pooja_date: isoDate(5), pooja_type: "special", is_active: "1" });
  check(r.status === 200 && /tampered with/.test(r.text), "E2E-049 forged token is refused with a message", `${r.status}`);
  check(sql("SELECT COUNT(*) AS n FROM poojas").rows[0].n === before, "E2E-049 …and nothing was written");
  r = await post("/admin/poojas.php", { action: "save", id: "0", name_ta: `${P} போலி`, name_en: `${P} no token`, pooja_date: isoDate(5), pooja_type: "special", is_active: "1" });
  check(sql("SELECT COUNT(*) AS n FROM poojas WHERE name_en LIKE ?", [`${P}%`]).rows[0].n === 0, "E2E-049 a missing token is refused too");

  /* ── E2E-014: admin creates a pooja ─────────────────────────────────── */
  const save = (fields) => post("/admin/poojas.php", { _csrf: csrf, action: "save", ...fields });
  const findPooja = (en) => sql("SELECT * FROM poojas WHERE name_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];

  r = await save({ id: "0", name_ta: "", name_en: `${P} incomplete`, pooja_date: "", pooja_type: "special", is_active: "1" });
  check(r.status === 200 && /required/i.test(r.text) && !findPooja(`${P} incomplete`), "E2E-014 missing Tamil name and date are refused");
  r = await save({ id: "0", name_ta: `${P} பௌர்ணமி`, name_en: `${P} Pournami`, pooja_date: "2099-02-30", pooja_type: "pournami", is_active: "1" });
  check(/valid date/i.test(r.text) && !findPooja(`${P} Pournami`), "E2E-014 an impossible date is refused");

  const pastDate = isoDate(-3), soonDate = isoDate(2), laterDate = isoDate(9);
  r = await save({ id: "0", name_ta: `${P} கடந்த பௌர்ணமி`, name_en: `${P} Past Pournami`, description_ta: "கடந்தது", description_en: "already over", pooja_date: pastDate, pooja_time: "18:00", pooja_type: "pournami", is_active: "1" });
  check(r.status === 302 || r.status === 303, "E2E-014 saved pooja redirects to the list");
  const past = findPooja(`${P} Past Pournami`);
  check(past && past.pooja_date === pastDate && past.name_ta === `${P} கடந்த பௌர்ணமி`, "E2E-014 pooja row stored with Tamil name intact");
  created.poojas.push(past.id);
  await save({ id: "0", name_ta: `${P} அடுத்த பௌர்ணமி`, name_en: `${P} Next Pournami`, description_ta: "அடுத்தது", description_en: "the next one", pooja_date: laterDate, pooja_time: "18:30", pooja_type: "pournami", is_active: "1" });
  const next = findPooja(`${P} Next Pournami`);
  check(!!next, "E2E-014 second pooja stored");
  created.poojas.push(next.id);
  await save({ id: "0", name_ta: `${P} அபிஷேகம்`, name_en: `${P} Abhishekam`, pooja_date: soonDate, pooja_time: "07:00", pooja_type: "special", is_active: "1" });
  const special = findPooja(`${P} Abhishekam`);
  created.poojas.push(special.id);
  r = await get("/admin/poojas.php?q=" + encodeURIComponent(P));
  check(r.text.includes(`${P} Next Pournami`) && r.text.includes(`${P} அடுத்த பௌர்ணமி`), "E2E-014 list shows the new pooja in both languages");

  /* ── E2E-015: edit ──────────────────────────────────────────────────── */
  r = await save({ id: String(next.id), name_ta: `${P} அடுத்த பௌர்ணமி`, name_en: `${P} Next Pournami (edited)`, description_ta: "திருத்தப்பட்டது", description_en: "edited", pooja_date: laterDate, pooja_time: "19:00", pooja_type: "pournami", is_active: "1" });
  const edited = sql("SELECT * FROM poojas WHERE id = ?", [next.id]).rows[0];
  check((r.status === 302 || r.status === 303) && edited.name_en === `${P} Next Pournami (edited)` && edited.pooja_time === "19:00" && edited.description_ta === "திருத்தப்பட்டது", "E2E-015 edit persisted; other columns kept");
  check(sql("SELECT COUNT(*) AS n FROM poojas WHERE name_en LIKE ?", [`${P}%`]).rows[0].n === 3, "E2E-015 edit did not create a duplicate");

  /* ── E2E-006/007/008: homepage selection ────────────────────────────── */
  // A calendar widget still pointing at the pooja that has passed is the
  // brief's scenario: the API must not show it and must move on.
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_pooja_id, priority, is_pinned, is_active) VALUES ('calendar_pooja', ?, ?, 'calendar', ?, 1, 1, 1)", [`${P} widget`, `${P} widget`, past.id]);
  created.widgets.push(sql("SELECT id FROM homepage_widgets WHERE title_en = ?", [`${P} widget`]).rows[0].id);
  r = await api("/api/homepage_widgets");
  check(r.status === 200 && Array.isArray(r.json), "homepage widgets API answers");
  const poojaBlocks = r.json.flatMap((w) => (w.pooja ? [w.pooja] : []));
  const today = isoDate(0);
  check(!poojaBlocks.some((p) => p.id === past.id) && !r.text.includes(`${P} Past Pournami`), "E2E-007 the expired Pournami is not shown as upcoming");
  check(poojaBlocks.length > 0 && poojaBlocks.every((p) => p.date >= today), "E2E-006 an upcoming pooja is shown and every date is today or later", JSON.stringify(poojaBlocks.map((p) => p.date)));
  const ours = r.json.find((w) => w.title_en === `${P} widget`);
  const expected = sql("SELECT id FROM poojas WHERE is_active = 1 AND pooja_date >= CURDATE() ORDER BY FIELD(pooja_type,'pournami','amavasai','pradosham','chaturthi','ekadasi','sashti','abhishekam','archana','festival','special','monthly','daily') ASC, pooja_date ASC, id ASC LIMIT 1").rows[0].id;
  check(ours && ours.pooja && ours.pooja.id === expected && ours.pooja.date >= today, "E2E-008 the stale calendar card was re-pointed at the next valid Pournami-first pooja", JSON.stringify(ours?.pooja));

  /* ── §10 edge cases: a manual pooja card, and a second stale calendar card */
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_pooja_id, priority, is_pinned, is_active) VALUES ('upcoming_pooja', ?, ?, 'manual', ?, 2, 0, 1)", [`${P} manual-past`, `${P} manual-past`, past.id]);
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_pooja_id, priority, is_pinned, is_active) VALUES ('calendar_pooja', ?, ?, 'calendar', ?, 3, 0, 1)", [`${P} second-calendar`, `${P} second-calendar`, past.id]);
  r = await api("/api/homepage_widgets");
  const manualPast = r.json.find((w) => w.title_en === `${P} manual-past`);
  check(!manualPast?.pooja || (manualPast.pooja.id !== past.id && manualPast.pooja.date >= today), "E2E-007 a manual card linked to a past pooja never publishes it", JSON.stringify(manualPast?.pooja));
  const secondCal = r.json.find((w) => w.title_en === `${P} second-calendar`);
  check(secondCal && secondCal.pooja && secondCal.pooja.id === expected, "E2E-008 a second stale calendar card is re-pointed as well (no early break)", JSON.stringify(secondCal?.pooja));
  check(r.json.every((w) => !w.pooja || w.pooja.date >= today), "E2E-007 no card anywhere carries an expired pooja");
  check(r.json.every((w) => ["manual", "calendar", "system"].includes(w.source_type)), "§8 every card states its source type");

  /* ── §9 pooja fields (migration 024) and GET /api/poojas ─────────────── */
  const rich = (fields) => save({ id: String(special.id), name_ta: `${P} அபிஷேகம்`, name_en: `${P} Abhishekam`, pooja_date: soonDate, pooja_time: "", pooja_type: "abhishekam", is_active: "1", ...fields });
  r = await rich({ start_time: "18:30", end_time: "21:00", sponsorship_amount: "1501", sponsorship_available: "1", is_featured: "1", live_stream_enabled: "1", banner_url: "/uploads/banner.webp" });
  let richRow = sql("SELECT * FROM poojas WHERE id = ?", [special.id]).rows[0];
  check((r.status === 302 || r.status === 303) && richRow.start_time === "18:30:00" && richRow.end_time === "21:00:00" && Number(richRow.sponsorship_amount) === 1501 && richRow.is_featured === 1 && richRow.live_stream_enabled === 1 && richRow.pooja_type === "abhishekam" && richRow.banner_url === "/uploads/banner.webp", "§9 typed times, sponsorship amount, featured, live-stream flag and banner are stored", JSON.stringify(richRow));
  check(richRow.pooja_time === "6:30 PM – 9:00 PM", "§9 the display time is derived from the typed range", String(richRow.pooja_time));
  r = await rich({ start_time: "21:00", end_time: "18:30" });
  check(r.status === 200 && /after the start/.test(r.text) && sql("SELECT start_time FROM poojas WHERE id = ?", [special.id]).rows[0].start_time === "18:30:00", "§9 an end time before the start time is refused and nothing changes");
  r = await rich({ start_time: "18:30", end_time: "21:00", sponsorship_amount: "1501", is_featured: "1", live_stream_enabled: "1", banner_url: "javascript:alert(1)" });
  check(r.status === 200 && /site path/.test(r.text), "§9 a banner that is not a site path or https address is refused");
  r = await api("/api/poojas?upcoming=1&limit=200");
  const apiPooja = r.json.find((p) => p.id === special.id);
  check(r.status === 200 && apiPooja && apiPooja.start_time === "18:30" && apiPooja.end_time === "21:00" && apiPooja.time === "6:30 PM – 9:00 PM" && apiPooja.sponsorship_amount === 1501 && apiPooja.sponsorship_available === true && apiPooja.is_featured === true && apiPooja.live_stream_enabled === true && apiPooja.name_ta === `${P} அபிஷேகம்`, "GET /api/poojas lists the pooja with times, price, flags and Tamil intact", JSON.stringify(apiPooja));
  r = await api("/api/poojas?type=abhishekam&featured=1&limit=200");
  check(r.json.some((p) => p.id === special.id) && r.json.every((p) => p.type === "abhishekam" && p.is_featured === true), "GET /api/poojas filters by type and featured");
  check(!r.json.some((p) => p.id === past.id) && r.json.every((p) => p.date >= today), "GET /api/poojas never lists an expired pooja as upcoming");
  r = await api("/api/poojas?past=1&limit=200");
  check(r.json.some((p) => p.id === past.id && p.is_past === true), "GET /api/poojas?past=1 lists past poojas");

  /* ── §9 recurring poojas: Generate from Panchangam ───────────────────── */
  r = await post("/admin/poojas.php", { _csrf: csrf, action: "generate", observance: "pradosham", months: "2", g_name_ta: `${P} பிரதோஷம்`, g_name_en: `${P} Pradosham`, g_start_time: "17:30", g_end_time: "19:00", g_amount: "501" });
  const gen = sql("SELECT pooja_date, pooja_type, recurrence_type, start_time, sponsorship_amount FROM poojas WHERE name_en = ? ORDER BY pooja_date", [`${P} Pradosham`]).rows;
  check((r.status === 302 || r.status === 303) && gen.length >= 2 && gen.every((g) => g.pooja_type === "pradosham" && g.recurrence_type === "pradosham" && g.start_time === "17:30:00" && Number(g.sponsorship_amount) === 501), "§9 Generate from Panchangam adds one Pradosham per occurrence, marked with its recurrence type", JSON.stringify(gen).slice(0, 240));
  check(gen.every((g) => g.pooja_date >= today) && new Set(gen.map((g) => g.pooja_date)).size === gen.length, "§9 generated dates are upcoming and distinct");
  r = await post("/admin/poojas.php", { _csrf: csrf, action: "generate", observance: "pradosham", months: "2", g_name_ta: `${P} பிரதோஷம்`, g_name_en: `${P} Pradosham` });
  check((r.status === 302 || r.status === 303) && sql("SELECT COUNT(*) AS n FROM poojas WHERE name_en = ?", [`${P} Pradosham`]).rows[0].n === gen.length, "§9 generating again adds nothing (idempotent)");
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'pooja_generated' AND detail LIKE ?", [`%${P} Pradosham%`]).rows[0].n >= 1, "§9 the generation is audited");

  /* ── E2E-016: archive (hide) ────────────────────────────────────────── */
  r = await post("/admin/poojas.php", { _csrf: csrf, action: "toggle", id: String(next.id) });
  check((r.status === 302 || r.status === 303) && sql("SELECT is_active FROM poojas WHERE id = ?", [next.id]).rows[0].is_active === 0, "E2E-016 toggle hides the pooja");
  r = await api("/api/homepage_widgets");
  check(!r.text.includes(`${P} Next Pournami`), "E2E-016 a hidden pooja leaves the public feed");
  r = await get("/admin/poojas.php?q=" + encodeURIComponent(P));
  check(/Hidden/.test(r.text), "E2E-016 the list marks it Hidden");

  /* ── E2E-017/018: events ────────────────────────────────────────────── */
  r = await post("/admin/events.php", { _csrf: csrf, action: "save", id: "0", title_ta: `${P} திருவிழா`, title_en: `${P} Festival`, description: "brief festival", event_date: isoDate(12), is_active: "1" });
  const event = sql("SELECT * FROM events WHERE title_en = ?", [`${P} Festival`]).rows[0];
  check((r.status === 302 || r.status === 303) && event && event.title_ta === `${P} திருவிழா`, "E2E-017 admin created an event", `${r.status} ${r.text.match(/alert[^>]*>([^<]+)/)?.[1]} ${JSON.stringify(event)}`);
  created.events.push(event.id);
  r = await api("/api/events?upcoming=1&limit=100");
  check(r.status === 200 && r.json.some((e) => e.id === event.id && e.title_ta === `${P} திருவிழா`), "E2E-018 the event is public with Tamil intact");
  r = await post("/admin/events.php", { _csrf: csrf, action: "save", id: "0", title_ta: `${P} x`, title_en: `${P} no date`, description: "", event_date: "", is_active: "1" });
  check(!sql("SELECT id FROM events WHERE title_en = ?", [`${P} no date`]).rows.length, "E2E-017 an event without a date is refused");

  /* ── §8 content types, links, images and display order (migration 024) */
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_event_id, image_url, priority, display_order, is_active) VALUES ('upcoming_event', '', '', 'manual', ?, ?, 4, 0, 1)", [event.id, POSTER]);
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, description_ta, description_en, source_type, priority, display_order, is_active) VALUES ('custom', ?, ?, 'தனிப்பயன் உரை', 'free text', 'manual', 5, 2, 1)", [`${P} custom`, `${P} custom`]);
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, priority, display_order, is_active) VALUES ('custom', ?, ?, 'manual', 5, 1, 1)", [`${P} custom-first`, `${P} custom-first`]);
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, priority, is_active) VALUES ('livestream', ?, ?, 'manual', 6, 1)", [`${P} stream-none`, `${P} stream-none`]);
  r = await api("/api/homepage_widgets");
  const evCard = r.json.find((w) => w.event && w.event.id === event.id);
  check(evCard && evCard.content_type === "upcoming_event" && evCard.title_ta === `${P} திருவிழா` && evCard.event_date === event.event_date && evCard.image_url === POSTER, "§8 an Upcoming Event card takes its title and date from the linked event and carries its image", JSON.stringify(evCard).slice(0, 240));
  const customIdx = r.json.findIndex((w) => w.title_en === `${P} custom`);
  const customFirstIdx = r.json.findIndex((w) => w.title_en === `${P} custom-first`);
  check(customIdx > -1 && r.json[customIdx].content_type === "custom" && r.json[customIdx].description_ta === "தனிப்பயன் உரை", "§8 a custom card is published as written");
  check(customFirstIdx > -1 && customFirstIdx < customIdx, "§8 display order breaks a priority tie");
  check(!r.json.some((w) => w.title_en === `${P} stream-none`), "§8 a Live Stream card with no broadcast is not shown");
  r = await post("/admin/homepage_widgets.php", { _csrf: csrf, action: "save", id: "0", content_type: "announcement", source_type: "manual", title_ta: `${P} படம்`, title_en: `${P} bad image`, image_url: "javascript:alert(1)", priority: "10", is_active: "1" });
  check(r.status === 200 && /site path/.test(r.text) && !sql("SELECT id FROM homepage_widgets WHERE title_en = ?", [`${P} bad image`]).rows.length, "§8 the admin refuses an image address that is not a site path or https");
  r = await post("/admin/homepage_widgets.php", { _csrf: csrf, action: "save", id: "0", content_type: "custom", source_type: "manual", title_ta: `${P} சிறப்பு`, title_en: `${P} admin custom`, image_url: "/uploads/deity.webp", display_order: "3", priority: "10", is_active: "1" });
  const adminCustom = sql("SELECT content_type, image_url, display_order FROM homepage_widgets WHERE title_en = ?", [`${P} admin custom`]).rows[0];
  check((r.status === 302 || r.status === 303) && adminCustom && adminCustom.content_type === "custom" && adminCustom.image_url === "/uploads/deity.webp" && adminCustom.display_order === 3, "§8 the admin saves a custom card with its image and display order", JSON.stringify(adminCustom));

  /* ── E2E-019/020: announcements ─────────────────────────────────────── */
  r = await post("/admin/announcements.php", { _csrf: csrf, action: "save", id: "0", title: `${P} அறிவிப்பு`, body: `${P} announcement body`, is_active: "1" });
  const ann = sql("SELECT * FROM announcements WHERE title = ?", [`${P} அறிவிப்பு`]).rows[0];
  check((r.status === 302 || r.status === 303) && !!ann, "E2E-019 admin created an announcement");
  created.announcements.push(ann.id);
  r = await api("/api/announcements?limit=50");
  check(r.status === 200 && r.json.some((a) => a.id === ann.id && a.body === `${P} announcement body`), "E2E-020 the announcement is in the public feed");
  r = await post("/admin/announcements.php", { _csrf: csrf, action: "save", id: "0", title: "", body: `${P} untitled`, is_active: "1" });
  check(!sql("SELECT id FROM announcements WHERE body = ?", [`${P} untitled`]).rows.length, "E2E-019 an announcement without a title is refused");

  /* ── E2E-021/022/023: gallery ───────────────────────────────────────── */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const upload = (blob, filename, caption) => {
    const form = new FormData();
    form.set("_csrf", csrf); form.set("action", "upload"); form.set("caption", caption);
    form.set("image", blob, filename);
    return post("/admin/gallery.php", form);
  };
  const galleryBefore = sql("SELECT COUNT(*) AS n FROM gallery").rows[0].n;
  r = await upload(new Blob(["<?php echo 'owned'; ?>"], { type: "image/jpeg" }), "shell.php.jpg", `${P} disguised`);
  check(r.status === 200 && /Only JPEG, PNG and WebP/.test(r.text), "E2E-023 a PHP file with an image name and MIME is refused", `${r.status}`);
  r = await upload(new Blob(["GIF89a not really"], { type: "image/gif" }), "photo.gif", `${P} gif`);
  check(/Only JPEG, PNG and WebP/.test(r.text), "E2E-023 an unsupported image type is refused");
  r = await upload(new Blob([png], { type: "application/octet-stream" }), "../../evil.php", `${P} traversal`);
  check(r.status === 302 || r.status === 303, "E2E-021 the stored name never comes from the upload");
  let rows = sql("SELECT * FROM gallery WHERE caption LIKE ?", [`${P}%`]).rows;
  check(rows.length === 1 && /^[a-f0-9]{24}\.png$/.test(rows[0].filename), "E2E-021 stored under a random name with the decoded type's extension", rows.map((x) => x.filename).join(","));
  check(sql("SELECT COUNT(*) AS n FROM gallery").rows[0].n === galleryBefore + 1, "E2E-023 refused uploads created no rows");
  created.gallery.push(...rows);
  check(existsSync(resolve(root, "backend/uploads", rows[0].filename)), "E2E-021 file is on disk");
  r = await api("/api/gallery");
  check(r.json.some((g) => g.id === rows[0].id && g.caption === `${P} traversal`), "E2E-022 the photo is in the public gallery feed");
  r = await get(`/uploads/${rows[0].filename}`);
  check(r.status === 200 && /^image\/png/.test(r.headers.get("content-type") ?? ""), "E2E-022 the photo is served as an image");
  r = await get("/uploads/nothing.php");
  check(r.status !== 200 || !/owned/.test(r.text), "uploads never execute PHP");

  /* ── E2E-047: SQL payloads are data ─────────────────────────────────── */
  r = await api("/api/search?q=" + encodeURIComponent("' OR 1=1; DROP TABLE poojas;--"));
  check(r.status === 200 && !FATAL.test(r.text), "E2E-047 search treats the payload as a term");
  r = await api("/api/contact", { name: SQLI, phone: "+91 90000 22222", phoneCountry: "IN", message: `${P} ' UNION SELECT password_hash FROM admin_users--`, hp_token: "" });
  check(r.status === 201 && r.json?.success === true, "E2E-047 contact form stores the payload as text", `${r.status} ${r.text.slice(0, 100)}`);
  const stored = sql("SELECT name, message FROM contact_messages WHERE name = ?", [SQLI]).rows[0];
  check(stored && /UNION SELECT/.test(stored.message), "E2E-047 stored verbatim (prepared statements)");
  check(sql("SELECT COUNT(*) AS n FROM poojas WHERE id IN (?, ?, ?)", created.poojas).rows[0].n === 3, "E2E-047 the poojas table is intact");
  r = await save({ id: "0", name_ta: SQLI, name_en: SQLI + " en", pooja_date: isoDate(20), pooja_type: "special", is_active: "0" });
  const sqlPooja = findPooja(SQLI + " en");
  check((r.status === 302 || r.status === 303) && sqlPooja && sqlPooja.name_ta === SQLI, "E2E-047 admin save stores the payload verbatim");
  if (sqlPooja) created.poojas.push(sqlPooja.id);

  /* ── E2E-038 / 039 / 040: a full enquiry, a bad one, and the office alert */
  const visitorEmail = `${P.toLowerCase()}@example.test`;
  r = await api("/api/contact", { name: `${P} Visitor`, phone: "+91 90000 44444", phoneCountry: "IN", email: visitorEmail, subject: `${P} சேவை பதிவு`, message: `${P} Can I book an abhishekam on Pournami?`, hp_token: "" });
  check(r.status === 201 && r.json?.success === true, "E2E-038 contact form accepts name, email, phone, subject and message", `${r.status} ${r.text.slice(0, 100)}`);
  const enquiry = sql("SELECT id, email, subject FROM contact_messages WHERE name = ? ORDER BY id DESC LIMIT 1", [`${P} Visitor`]).rows[0];
  check(enquiry && enquiry.email === visitorEmail && enquiry.subject === `${P} சேவை பதிவு`, "E2E-038 email and Tamil subject are stored intact", JSON.stringify(enquiry));
  r = await api("/api/contact", { name: `${P} Bad Email`, phone: "+91 90000 55555", phoneCountry: "IN", email: "not-an-address", message: `${P} hello there`, hp_token: "" });
  check(r.status === 400 && sql("SELECT COUNT(*) AS n FROM contact_messages WHERE name = ?", [`${P} Bad Email`]).rows[0].n === 0, "E2E-039 an invalid email is refused and nothing is stored", `${r.status}`);
  const alerts = sql(
    "SELECT n.to_email, n.category, n.recipient_type, n.title, n.vars, d.channel, d.status FROM notifications n LEFT JOIN notification_deliveries d ON d.notification_id = n.id WHERE n.event = 'contact.received' AND n.entity_id = ? ORDER BY n.id DESC",
    [enquiry?.id ?? 0],
  ).rows;
  check(alerts.length === 1 && alerts[0].to_email === OFFICE && alerts[0].category === "office" && alerts[0].recipient_type === "guest", "E2E-040 exactly one office notification is created for the enquiry", JSON.stringify(alerts).slice(0, 300));
  check(alerts[0]?.channel === "email" && alerts[0]?.status === "queued", "E2E-040 its email delivery is queued for the worker", JSON.stringify(alerts[0] ?? null).slice(0, 300));
  check(/சேவை பதிவு/.test(alerts[0]?.title ?? "") && /Can I book/.test(alerts[0]?.vars ?? ""), "E2E-040 the alert carries the subject and the message", (alerts[0]?.title ?? "") + " " + (alerts[0]?.vars ?? "").slice(0, 120));

  /* ── E2E-048: script payloads never come back executable ───────────── */
  r = await api("/api/contact", { name: XSS, phone: "+91 90000 33333", phoneCountry: "IN", message: `${P} ${XSS}`, hp_token: "" });
  check(r.status === 201, "E2E-048 contact form accepts the text");
  r = await get("/admin/contact_messages.php");
  check(r.status === 200 && !r.text.includes("<script>alert(1)") && !r.text.includes("onerror=alert(2)"), "E2E-048 admin inbox renders the payload inert");
  r = await save({ id: "0", name_ta: XSS, name_en: `${P} xss en`, description_en: XSS, pooja_date: isoDate(1), pooja_type: "special", is_active: "1" });
  const xssPooja = findPooja(`${P} xss en`);
  check((r.status === 302 || r.status === 303) && !!xssPooja, "E2E-048 pooja with a script payload saved");
  if (xssPooja) created.poojas.push(xssPooja.id);
  r = await get("/admin/poojas.php?q=" + encodeURIComponent(P));
  check(!r.text.includes("<script>alert(1)") && !/<img src=x onerror/.test(r.text), "E2E-048 admin list escapes it");
  r = await get("/admin/poojas.php?edit=" + xssPooja.id);
  check(!r.text.includes("<script>alert(1)") && !/<img src=x onerror/.test(r.text), "E2E-048 edit form escapes it");
  r = await api("/api/homepage_widgets");
  check(!r.text.includes("<script>alert(1)</script>") || r.headers.get("content-type").startsWith("application/json"), "E2E-048 public JSON is JSON, not HTML");
  r = await api("/api/search?q=" + encodeURIComponent(`${P} xss`));
  check(!r.text.includes("<script>alert(1)</script>") || r.headers.get("content-type").startsWith("application/json"), "E2E-048 search result is JSON");

  check(!FATAL.test(log) && !/PHP (?:Warning|Fatal|Notice|Deprecated)/.test(log), "no PHP or MySQL errors in the server log", log.slice(-300));
  console.log(`${checks} passed, 0 failed`);
} finally {
  for (const g of created.gallery) {
    // the original and, since migration 021, its thumb and medium variants
    for (const name of [g.filename, g.thumb_filename, g.medium_filename]) {
      const f = name ? resolve(root, "backend/uploads", name) : null;
      if (f && existsSync(f)) unlinkSync(f);
    }
  }
  sql("DELETE FROM homepage_widgets WHERE title_en LIKE ? OR image_url = ?", [`${P}%`, POSTER]);
  // The flood-limit buckets this run's addresses (10.90.x.y) filled: every run
  // counts from the same addresses, so a second run inside the window would
  // otherwise be refused with 429 by its own first run.
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [":10[.]90[.][0-9]+[.][0-9]+$"]);
  sql("DELETE FROM gallery WHERE caption LIKE ?", [`${P}%`]);
  try { sql("DELETE FROM notifications WHERE to_email = ?", [OFFICE]); } catch { /* notification tables absent */ }
  sql("DELETE FROM contact_messages WHERE name LIKE ?", [`${P}%`]);
  sql("DELETE FROM announcements WHERE title LIKE ? OR body LIKE ?", [`${P}%`, `${P}%`]);
  sql("DELETE FROM events WHERE title_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM poojas WHERE name_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ?", [`%${P}%`, `%${P}%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
