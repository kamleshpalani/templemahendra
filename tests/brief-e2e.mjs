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
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
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
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash },
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
  const expected = sql("SELECT id FROM poojas WHERE is_active = 1 AND pooja_date >= CURDATE() ORDER BY FIELD(pooja_type,'pournami','amavasai','ekadasi','special','monthly','sashti','daily') ASC, pooja_date ASC LIMIT 1").rows[0].id;
  check(ours && ours.pooja && ours.pooja.id === expected && ours.pooja.date >= today, "E2E-008 the stale calendar card was re-pointed at the next valid Pournami-first pooja", JSON.stringify(ours?.pooja));

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
    const f = resolve(root, "backend/uploads", g.filename);
    if (existsSync(f)) unlinkSync(f);
  }
  sql("DELETE FROM homepage_widgets WHERE title_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM gallery WHERE caption LIKE ?", [`${P}%`]);
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
