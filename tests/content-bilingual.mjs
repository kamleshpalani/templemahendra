#!/usr/bin/env node
/**
 * tests/content-bilingual.mjs — bilingual announcements, events and sevas
 * (brief §6 Events, §6 Pooja/Seva, §7 multilingual, §25; migration 020):
 * /admin/announcements.php, /admin/events.php, /admin/sevas.php,
 * GET /api/announcements, GET /api/events[/{id}], GET /api/sevas, the event
 * page's server answers (api/og.php, api/spa.php, sitemap.xml).
 *
 *   migration 020: the new columns, their types and defaults, the indexes,
 *   and the backfill of the old single-language columns
 *   admin pages need a session (E2E-045) and content.edit: editor 200,
 *   finance/viewer 403 (E2E-013/046); forged CSRF writes nothing (E2E-049)
 *   announcement: create / edit / hide / delete with Tamil intact (E2E-019),
 *   a publish window (only current notices are public), the old title/body
 *   fields still accepted, both languages and the legacy keys in the feed
 *   event: type, featured, last day, times, venue, picture, bilingual
 *   description; validation of each; ?upcoming, ?past (newest first),
 *   ?featured, ?type, a clean 422 for junk; GET /api/events/{id} 200 / 404;
 *   og.php preview, spa.php status and the sitemap entry for /events/<id>
 *   seva: bilingual description and timing, is_bookable, the old
 *   description field still accepted and a missing is_bookable leaving the
 *   seva bookable
 *   SQL and script payloads are stored as data (E2E-047/048)
 *
 *   node tests/content-bilingual.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment, migrations 015 and 020, and the admin account admin/Admin@Test123
 * (ADMIN_USERNAME / ADMIN_PASSWORD override). Everything it writes carries the
 * prefix "E2E-BILING-<run>" and is deleted in `finally`.
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
const P = `E2E-BILING-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE events;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const UNFURLER = "WhatsApp/2.23.20.0 A";
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const ACCOUNTS = {
  editor:  { user: `e2ebiling_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2ebiling_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2ebiling_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};
const ANN_KEYS = ["id", "title_ta", "title_en", "body_ta", "body_en", "title", "body", "start_date", "end_date", "created_at"];
const EVENT_KEYS = ["id", "title_ta", "title_en", "description_ta", "description_en", "description", "event_type", "is_featured", "event_date", "end_date", "start_time", "end_time", "venue_ta", "venue_en", "image_url"];
const SEVA_KEYS = ["id", "name_ta", "name_en", "description_ta", "description_en", "description", "timing_ta", "timing_en", "amount", "is_featured", "is_bookable"];

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.93.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };

/** YYYY-MM-DD, `offset` days from today (local clock; offsets of 3+ days are safe against any server clock). */
const isoDate = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };

function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const column = (table, name) => sql("SELECT COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d, EXTRA AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?", [table, name]).rows[0];
const indexOn = (table, name) => sql("SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? GROUP BY INDEX_NAME", [table, name]).rows[0]?.cols ?? "";

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
/** What a link unfurler is told about a path: status and the meta tags. */
async function preview(path, lang = "en") {
  const r = await api(path, { "user-agent": UNFURLER, "accept-language": lang });
  const meta = {};
  for (const m of r.text.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) {
    meta[m[1]] = m[2].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return { status: r.status, meta, html: r.text };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redirected = (r) => r.status === 302 || r.status === 303;
const flashOf = (html) => html.match(/alert[^>]*>([^<]+)/)?.[1] ?? "";
const findAnn = (en) => sql("SELECT * FROM announcements WHERE title_en = ? OR title = ? ORDER BY id DESC LIMIT 1", [en, en]).rows[0];
const findEvent = (en) => sql("SELECT * FROM events WHERE title_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const findSeva = (en) => sql("SELECT * FROM sevas WHERE name_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const audits = (action, subject) => sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = ? AND subject = ?", [action, subject]).rows[0].n;
const sameKeys = (obj, keys) => Object.keys(obj).sort().join() === [...keys].sort().join();

try {
  /* ── migration 020 (brief §7, §25) ──────────────────────────────────── */
  let c = column("announcements", "title_ta");
  check(c && c.t === "varchar(300)" && c.n === "NO", "announcements.title_ta is VARCHAR(300) NOT NULL", JSON.stringify(c));
  check(column("announcements", "title_en")?.t === "varchar(300)" && column("announcements", "body_ta")?.t === "text" && column("announcements", "body_en")?.t === "text", "announcements.title_en / body_ta / body_en exist");
  check(column("announcements", "start_date")?.t === "date" && column("announcements", "end_date")?.t === "date" && column("announcements", "end_date")?.n === "YES", "announcements.start_date / end_date are nullable DATEs");
  c = column("announcements", "updated_at");
  check(c && /on update CURRENT_TIMESTAMP/i.test(c.e), "announcements.updated_at is maintained by MySQL", JSON.stringify(c));
  check(column("announcements", "title")?.t === "varchar(300)" && column("announcements", "body")?.t === "text", "the old title / body columns are kept");
  c = column("events", "event_type");
  check(c && c.t === "enum('festival','pooja','special','other')" && c.d === "other", "events.event_type is the four-value ENUM defaulting to other", JSON.stringify(c));
  c = column("events", "is_featured");
  check(c && c.t === "tinyint(1)" && c.d === "0", "events.is_featured defaults to 0", JSON.stringify(c));
  check(column("events", "description_ta")?.t === "text" && column("events", "description_en")?.t === "text" && column("events", "description")?.t === "text", "events.description_ta / description_en added, description kept");
  check(column("events", "end_date")?.t === "date" && column("events", "start_time")?.t === "time" && column("events", "end_time")?.t === "time", "events.end_date DATE, start_time / end_time TIME");
  check(column("events", "venue_ta")?.t === "varchar(300)" && column("events", "venue_en")?.t === "varchar(300)" && column("events", "image_url")?.t === "varchar(500)", "events.venue_ta / venue_en VARCHAR(300), image_url VARCHAR(500)");
  check(column("events", "created_at")?.t === "datetime" && /on update CURRENT_TIMESTAMP/i.test(column("events", "updated_at")?.e ?? ""), "events.created_at / updated_at exist");
  c = column("sevas", "is_bookable");
  check(c && c.t === "tinyint(1)" && c.d === "1", "sevas.is_bookable defaults to 1", JSON.stringify(c));
  check(column("sevas", "description_ta")?.t === "text" && column("sevas", "description_en")?.t === "text" && column("sevas", "timing_ta")?.t === "varchar(200)" && column("sevas", "timing_en")?.t === "varchar(200)", "sevas.description_ta / description_en TEXT, timing_ta / timing_en VARCHAR(200)");
  check(column("sevas", "created_at")?.t === "datetime" && /on update CURRENT_TIMESTAMP/i.test(column("sevas", "updated_at")?.e ?? ""), "sevas.created_at / updated_at exist");
  check(indexOn("announcements", "idx_announcement_window") === "is_active,start_date,end_date", "announcements idx_announcement_window (is_active, start_date, end_date)");
  check(indexOn("events", "idx_event_featured") === "is_active,is_featured,event_date" && indexOn("events", "idx_event_type") === "is_active,event_type,event_date", "events featured and type indexes");
  let rows = sql("SELECT TABLE_NAME AS t, TABLE_COLLATION AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('announcements','events','sevas')").rows;
  check(rows.length === 3 && rows.every((r) => /^utf8mb4/.test(r.c)), "the three tables are utf8mb4", JSON.stringify(rows));
  check(sql("SELECT COUNT(*) AS n FROM announcements WHERE title_ta = '' OR title_en = ''").rows[0].n === 0, "backfill: every announcement has a Tamil and an English title");
  check(sql("SELECT COUNT(*) AS n FROM events WHERE description IS NOT NULL AND description <> '' AND description_ta IS NULL AND description_en IS NULL").rows[0].n === 0, "backfill: every described event has a bilingual description");
  check(sql("SELECT COUNT(*) AS n FROM sevas WHERE description IS NOT NULL AND description <> '' AND description_ta IS NULL AND description_en IS NULL").rows[0].n === 0, "backfill: every described seva has a bilingual description");

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
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash, SITE_URL: `http://127.0.0.1:${port}` },
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

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  for (const page of ["announcements", "events", "sevas"]) {
    let r = await anon.get(`/admin/${page}.php`);
    check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), `E2E-045 admin ${page} page redirects to sign-in`, `${r.status}`);
  }
  await anon.post("/admin/events.php", { action: "save", id: "0", title_ta: `${P} அனாமதேய`, title_en: `${P} anonymous`, event_date: isoDate(5), is_active: "1" });
  check(!findEvent(`${P} anonymous`), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in ─────────────────────────────────────────────────── */
  const owner = jar();
  let r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/announcements.php");
  check(r.status === 200 && !FATAL.test(r.text), "announcements page renders for the owner", `${r.status}`);
  check(/name="title_ta"[^>]*lang="ta"/.test(r.text) && /name="title_en"/.test(r.text) && /name="body_ta"[^>]*lang="ta"/.test(r.text) && /name="body_en"/.test(r.text) && /name="start_date"/.test(r.text) && /name="end_date"/.test(r.text), "announcement form has Tamil (lang=ta) and English titles and bodies, and the publish window");
  const annCsrf = csrfOf(r.text);
  r = await owner.get("/admin/events.php");
  check(r.status === 200 && !FATAL.test(r.text), "events page renders for the owner", `${r.status}`);
  check(/name="event_type"/.test(r.text) && /name="end_date"/.test(r.text) && /name="start_time"/.test(r.text) && /name="end_time"/.test(r.text) && /name="venue_ta"[^>]*lang="ta"/.test(r.text) && /name="venue_en"/.test(r.text) && /name="description_ta"[^>]*lang="ta"/.test(r.text) && /name="description_en"/.test(r.text) && /name="image_url"/.test(r.text) && /name="is_featured"/.test(r.text), "event form has type, last day, times, bilingual venue and description, picture, featured");
  const evCsrf = csrfOf(r.text);
  r = await owner.get("/admin/sevas.php");
  check(r.status === 200 && !FATAL.test(r.text), "sevas page renders for the owner", `${r.status}`);
  check(/name="description_ta"[^>]*lang="ta"/.test(r.text) && /name="description_en"/.test(r.text) && /name="timing_ta"[^>]*lang="ta"/.test(r.text) && /name="timing_en"/.test(r.text) && /type="checkbox" name="is_bookable"/.test(r.text), "seva form has bilingual description and timing, and the bookable switch");
  const sevaCsrf = csrfOf(r.text);
  check(annCsrf.length >= 32 && evCsrf.length >= 32 && sevaCsrf.length >= 32, "CSRF tokens issued");
  const annPost = (fields, s = owner, token = annCsrf) => s.post("/admin/announcements.php", { _csrf: token, ...fields });
  const evPost = (fields, s = owner, token = evCsrf) => s.post("/admin/events.php", { _csrf: token, ...fields });
  const sevaPost = (fields, s = owner, token = sevaCsrf) => s.post("/admin/sevas.php", { _csrf: token, ...fields });

  /* ── E2E-049: CSRF ──────────────────────────────────────────────────── */
  r = await annPost({ action: "save", id: "0", title_ta: `${P} போலி`, title_en: `${P} forged`, is_active: "1" }, owner, "forged-" + annCsrf.slice(0, 20));
  check(r.status === 200 && /tampered with/.test(r.text) && r.text.includes(`${P} forged`) && !findAnn(`${P} forged`), "E2E-049 a forged token is refused with a message and the typing is shown again, nothing written", `${r.status}`);
  r = await owner.post("/admin/events.php", { action: "save", id: "0", title_ta: "த", title_en: `${P} no token`, event_date: isoDate(5), is_active: "1" });
  r = await owner.post("/admin/sevas.php", { action: "save", id: "0", name_ta: "த", name_en: `${P} no token`, amount: "10", is_active: "1" });
  check(!findEvent(`${P} no token`) && !findSeva(`${P} no token`), "E2E-049 missing tokens write nothing");

  /* ── announcements (E2E-019/020) ────────────────────────────────────── */
  const TA_TITLE = `${P} கும்பாபிஷேக ஏற்பாடுகள்`;
  const TA_BODY = "கும்பாபிஷேகத்திற்கான ஏற்பாடுகள் தொடங்கிவிட்டன — பக்தர்கள் அனைவரும் வரவேற்கப்படுகிறார்கள்.";
  r = await annPost({ action: "save", id: "0", title_ta: TA_TITLE, title_en: `${P} Kumbabhishekam preparations`, body_ta: TA_BODY, body_en: "Preparations have begun; all devotees are welcome.", start_date: isoDate(-3), end_date: isoDate(3), is_active: "1" });
  const ann = findAnn(`${P} Kumbabhishekam preparations`);
  check(redirected(r) && ann && ann.title_ta === TA_TITLE && ann.title_en === `${P} Kumbabhishekam preparations` && ann.body_ta === TA_BODY && ann.body_en === "Preparations have begun; all devotees are welcome." && ann.start_date === isoDate(-3) && ann.end_date === isoDate(3) && ann.is_active === 1, "E2E-019 announcement created in both languages with a window, Tamil intact", `${r.status} ${flashOf(r.text)} ${JSON.stringify(ann)}`);
  check(ann.title === ann.title_en && ann.body === ann.body_en, "the old title / body columns carry the English text");
  check(audits("announcement_created", `announcement:${ann.id}`) === 1, "announcement_created is audited");
  r = await api("/api/announcements?limit=50");
  let pub = r.json?.find((a) => a.id === ann.id);
  check(r.status === 200 && pub && pub.title_ta === TA_TITLE && pub.title_en === ann.title_en && pub.body_ta === TA_BODY && pub.body_en === ann.body_en && pub.title === ann.title_en && pub.body === ann.body_en && pub.start_date === isoDate(-3), "E2E-020 the feed carries both languages and the legacy title / body keys", JSON.stringify(pub));
  check(sameKeys(pub, ANN_KEYS), "a public announcement exposes exactly the documented keys", Object.keys(pub).join());
  check(/charset=utf-8/i.test(r.headers.get("content-type") ?? ""), "feed is UTF-8 JSON");

  r = await annPost({ action: "save", id: "0", title_ta: `${P} எதிர்காலம்`, title_en: `${P} future`, start_date: isoDate(4), is_active: "1" });
  const future = findAnn(`${P} future`);
  r = await annPost({ action: "save", id: "0", title_ta: `${P} காலாவதி`, title_en: `${P} expired`, end_date: isoDate(-4), is_active: "1" });
  const expired = findAnn(`${P} expired`);
  r = await annPost({ action: "save", id: "0", title_ta: `${P} மறைவு`, title_en: `${P} hidden` });
  const hiddenAnn = findAnn(`${P} hidden`);
  check(future && expired && hiddenAnn && hiddenAnn.is_active === 0, "future, expired and hidden notices saved");
  r = await api("/api/announcements?limit=50");
  const ids = new Set((r.json ?? []).map((a) => a.id));
  check(ids.has(ann.id) && !ids.has(future.id) && !ids.has(expired.id) && !ids.has(hiddenAnn.id), "only the current, active notice is public: a future start, a past end and a hidden flag each keep it out", [...ids].join());
  r = await owner.get("/admin/announcements.php?q=" + encodeURIComponent(P));
  check(/Scheduled/.test(r.text) && /Expired/.test(r.text) && r.text.includes(TA_TITLE), "admin list marks Scheduled and Expired notices and shows the Tamil title");

  r = await annPost({ action: "save", id: "0", title: `${P} பழைய படிவம்`, body: `${P} legacy body`, is_active: "1" });
  const legacyAnn = findAnn(`${P} பழைய படிவம்`);
  check(redirected(r) && legacyAnn && legacyAnn.title_ta === `${P} பழைய படிவம்` && legacyAnn.title_en === `${P} பழைய படிவம்` && legacyAnn.body_ta === `${P} legacy body` && legacyAnn.body_en === `${P} legacy body` && legacyAnn.title === `${P} பழைய படிவம்`, "the old title / body fields are still accepted: one text becomes both languages", JSON.stringify(legacyAnn));
  r = await annPost({ action: "save", id: "0", title_ta: "", title_en: "", body_ta: `${P} untitled`, is_active: "1" });
  check(r.status === 200 && /required/.test(r.text) && !sql("SELECT id FROM announcements WHERE body_ta = ?", [`${P} untitled`]).rows.length, "a notice without any title is refused");
  r = await annPost({ action: "save", id: "0", title_ta: `${P} தலைகீழ்`, title_en: `${P} backwards`, start_date: isoDate(3), end_date: isoDate(1), is_active: "1" });
  check(r.status === 200 && !findAnn(`${P} backwards`), "a window whose last day comes before the first is refused");
  r = await annPost({ action: "save", id: "0", title_ta: `${P} தவறான தேதி`, title_en: `${P} bad date`, start_date: "2026-13-45", is_active: "1" });
  check(r.status === 200 && !findAnn(`${P} bad date`), "an impossible date is refused");

  r = await annPost({ action: "save", id: String(ann.id), title_ta: TA_TITLE + " (திருத்தம்)", title_en: `${P} Kumbabhishekam preparations (edited)`, body_ta: TA_BODY, body_en: "", start_date: "", end_date: "", is_active: "1" });
  let edited = sql("SELECT * FROM announcements WHERE id = ?", [ann.id]).rows[0];
  check(redirected(r) && edited.title_ta === TA_TITLE + " (திருத்தம்)" && edited.title_en === `${P} Kumbabhishekam preparations (edited)` && edited.body_en === null && edited.body === TA_BODY && edited.start_date === null && edited.end_date === null, "edit persisted: window cleared, the legacy body falls back to Tamil when English is blank", JSON.stringify(edited));
  check(audits("announcement_updated", `announcement:${ann.id}`) === 1, "announcement_updated is audited");
  r = await owner.get(`/admin/announcements.php?edit=${ann.id}`);
  check(r.status === 200 && r.text.includes(`value="${TA_TITLE} (திருத்தம்)"`) && r.text.includes(TA_BODY), "edit form is pre-filled with the Tamil title and body");
  r = await annPost({ action: "toggle", id: String(ann.id) });
  check(redirected(r) && sql("SELECT is_active FROM announcements WHERE id = ?", [ann.id]).rows[0].is_active === 0 && audits("announcement_toggled", `announcement:${ann.id}`) === 1, "toggle hides the notice and is audited");
  r = await api("/api/announcements?limit=50");
  check(!r.json.some((a) => a.id === ann.id), "a hidden notice leaves the feed");
  await annPost({ action: "toggle", id: String(ann.id) });
  r = await api("/api/announcements?limit=50");
  check(r.json.some((a) => a.id === ann.id && a.body_ta === TA_BODY && a.body_en === TA_BODY), "toggle shows it again; an empty English body falls back to the Tamil one in the feed");

  /* ── events (E2E-017/018) ───────────────────────────────────────────── */
  const TA_EVENT = `${P} தைப்பூசம்`;
  const TA_DESC = "கவாடி ஊர்வலம் — காலை அபிஷேகம், மாலை தீபாராதனை.";
  const TA_VENUE = "கோயில் மண்டபம்";
  r = await evPost({ action: "save", id: "0", title_ta: TA_EVENT, title_en: `${P} Thai Poosam`, event_type: "festival", event_date: isoDate(5), end_date: isoDate(7), start_time: "18:00", end_time: "21:30", venue_ta: TA_VENUE, venue_en: "Temple mandapam", description_ta: TA_DESC, description_en: "Kavadi procession; morning abhishekam, evening deeparadhana.", image_url: "https://example.com/thai-poosam.jpg", is_featured: "1", is_active: "1" });
  const ev = findEvent(`${P} Thai Poosam`);
  check(redirected(r) && ev && ev.title_ta === TA_EVENT && ev.event_type === "festival" && ev.is_featured === 1 && ev.event_date === isoDate(5) && ev.end_date === isoDate(7) && ev.start_time === "18:00:00" && ev.end_time === "21:30:00" && ev.venue_ta === TA_VENUE && ev.venue_en === "Temple mandapam" && ev.description_ta === TA_DESC && ev.description_en === "Kavadi procession; morning abhishekam, evening deeparadhana." && ev.image_url === "https://example.com/thai-poosam.jpg" && ev.is_active === 1, "E2E-017 event created with type, featured, last day, times, venue, picture and both descriptions, Tamil intact", `${r.status} ${flashOf(r.text)} ${JSON.stringify(ev)}`);
  check(ev.description === ev.description_en && !!ev.created_at && !!ev.updated_at, "the old description column carries the English text; timestamps set");
  check(audits("event_created", `event:${ev.id}`) === 1, "event_created is audited");
  r = await evPost({ action: "save", id: "0", title_ta: `${P} பழைய பூஜை`, title_en: `${P} Old pooja`, event_type: "pooja", event_date: isoDate(-10), description: "legacy description only", is_active: "1" });
  const past1 = findEvent(`${P} Old pooja`);
  r = await evPost({ action: "save", id: "0", title_ta: `${P} மிகப் பழைய`, title_en: `${P} Older special`, event_type: "special", event_date: isoDate(-20), is_active: "1" });
  const past2 = findEvent(`${P} Older special`);
  r = await evPost({ action: "save", id: "0", title_ta: `${P} மறைந்த`, title_en: `${P} Hidden event`, event_date: isoDate(3) });
  const hiddenEv = findEvent(`${P} Hidden event`);
  check(past1 && past1.description_ta === "legacy description only" && past1.description_en === "legacy description only" && past1.event_type === "pooja" && past1.is_featured === 0, "the old description field is still accepted and becomes both languages; an omitted featured flag is 0", JSON.stringify(past1));
  check(past2 && hiddenEv && hiddenEv.is_active === 0, "past and hidden events saved");

  const refusedEvent = async (fields, label) => {
    const res = await evPost({ action: "save", id: "0", title_ta: "த", is_active: "1", ...fields });
    check(res.status === 200 && /highlighted/.test(res.text) && !findEvent(fields.title_en), label, `${res.status} ${flashOf(res.text)}`);
  };
  await refusedEvent({ title_en: `${P} bad type`, event_type: "carnival", event_date: isoDate(5) }, "an unknown event type is refused");
  await refusedEvent({ title_en: `${P} bad time`, event_date: isoDate(5), start_time: "25:00" }, "an impossible time is refused");
  await refusedEvent({ title_en: `${P} ends first`, event_date: isoDate(5), start_time: "21:00", end_time: "18:00" }, "a one-day event ending before it starts is refused");
  await refusedEvent({ title_en: `${P} last day first`, event_date: isoDate(5), end_date: isoDate(4) }, "a last day before the first day is refused");
  await refusedEvent({ title_en: `${P} js image`, event_date: isoDate(5), image_url: "javascript:alert(1)" }, "a javascript: picture is refused");
  await refusedEvent({ title_en: `${P} http image`, event_date: isoDate(5), image_url: "http://example.com/x.jpg" }, "a plain-http picture is refused");
  await refusedEvent({ title_en: `${P} dotdot image`, event_date: isoDate(5), image_url: "/uploads/../config/database.php" }, "a dot-dot site path is refused");
  await refusedEvent({ title_en: `${P} no date`, event_date: "" }, "E2E-017 an event without a date is refused");
  r = await evPost({ action: "save", id: "0", title_ta: `${P} உள்ளூர் படம்`, title_en: `${P} local picture`, event_date: isoDate(30), end_date: isoDate(32), start_time: "20:00", end_time: "06:00", image_url: "/uploads/deities-alankaram.jpg", is_active: "1" });
  const local = findEvent(`${P} local picture`);
  check(redirected(r) && local && local.image_url === "/uploads/deities-alankaram.jpg" && local.end_time === "06:00:00", "a site picture path is accepted, and an overnight span may end before it starts", JSON.stringify(local));

  r = await api("/api/events?upcoming=1&limit=100");
  pub = r.json?.find((e) => e.id === ev.id);
  check(r.status === 200 && pub && pub.title_ta === TA_EVENT && pub.description_ta === TA_DESC && pub.description_en === ev.description_en && pub.description === ev.description_en && pub.event_type === "festival" && pub.is_featured === true && pub.end_date === isoDate(7) && pub.start_time === "18:00" && pub.end_time === "21:30" && pub.venue_ta === TA_VENUE && pub.venue_en === "Temple mandapam" && pub.image_url === "https://example.com/thai-poosam.jpg", "E2E-018 the public list carries both languages, the legacy key, type, featured, span, HH:MM times, venue and picture", JSON.stringify(pub));
  check(sameKeys(pub, EVENT_KEYS), "a public event exposes exactly the documented keys", Object.keys(pub).join());
  check(!r.json.some((e) => e.id === past1.id || e.id === hiddenEv.id), "?upcoming omits past and hidden events");
  r = await api("/api/events?past=1&limit=100");
  const pastIds = r.json.map((e) => e.id);
  check(r.status === 200 && pastIds.includes(past1.id) && pastIds.includes(past2.id) && pastIds.indexOf(past1.id) < pastIds.indexOf(past2.id) && !pastIds.includes(ev.id), "?past lists the archive newest first, without upcoming events", pastIds.join());
  check(r.json.find((e) => e.id === past1.id)?.description_ta === "legacy description only", "an event with only the old description answers it in both languages");
  r = await api("/api/events?featured=1&limit=100");
  check(r.json.some((e) => e.id === ev.id) && r.json.every((e) => e.is_featured === true), "?featured lists only featured events");
  r = await api("/api/events?type=festival&limit=100");
  check(r.json.some((e) => e.id === ev.id) && r.json.every((e) => e.event_type === "festival") && !r.json.some((e) => e.id === past1.id), "?type=festival lists only festivals");
  r = await api("/api/events?type=pooja&past=1&limit=100");
  check(r.json.some((e) => e.id === past1.id) && !r.json.some((e) => e.id === past2.id), "?type combines with ?past");
  r = await api("/api/events?type=carnival");
  check(r.status === 422 && r.json && typeof r.json.error === "string" && !/SQLSTATE/.test(r.text), "E2E-047 a junk type answers a clean 422, never a SQL error", `${r.status} ${r.text.slice(0, 80)}`);
  r = await api("/api/events");
  check(r.status === 200 && Array.isArray(r.json) && r.json.some((e) => e.id === ev.id), "GET /api/events without parameters still answers the plain list");

  r = await api(`/api/events/${ev.id}`);
  check(r.status === 200 && r.json && r.json.id === ev.id && r.json.title_ta === TA_EVENT && r.json.description_ta === TA_DESC && r.json.description_en === ev.description_en && r.json.venue_ta === TA_VENUE && r.json.event_type === "festival" && sameKeys(r.json, EVENT_KEYS), "GET /api/events/{id} answers one active event with both languages", `${r.status} ${r.text.slice(0, 200)}`);
  r = await api(`/api/events/${hiddenEv.id}`);
  check(r.status === 404 && r.json?.error, "a hidden event answers 404");
  r = await api("/api/events/999999999");
  check(r.status === 404, "an unknown id answers 404");
  r = await api("/api/events/abc");
  check(r.status === 404 && !FATAL.test(r.text), "a non-numeric id answers 404");

  /* the event page's server answers: preview, status line, sitemap */
  let p = await preview(`/events/${ev.id}`, "en");
  check(p.status === 200 && p.meta["og:title"] === `${P} Thai Poosam` && p.meta["og:type"] === "article" && p.meta["og:image"] === "https://example.com/thai-poosam.jpg" && p.meta["og:image:alt"] === `${P} Thai Poosam`, "og.php previews the event under its English title, as an article, with its picture", JSON.stringify(p.meta));
  check(p.meta["og:description"]?.includes("Kavadi procession") && /\d{1,2}.*\d{4}/.test(p.meta["og:description"] ?? "") && p.meta["og:url"]?.endsWith(`/events/${ev.id}`) && !/<meta name="robots"/.test(p.html), "…its description names the dates and the programme, its canonical is the event page, and it is indexable", p.meta["og:description"]);
  p = await preview(`/events/${ev.id}`, "ta");
  check(p.meta["og:title"] === TA_EVENT && p.meta["og:description"]?.includes(TA_DESC) && p.meta["og:locale"] === "ta_IN", "…and in Tamil for a Tamil reader", JSON.stringify(p.meta));
  p = await preview(`/events/${hiddenEv.id}`, "en");
  check(p.status === 404 && p.meta.robots === "noindex, nofollow" && !p.meta["og:description"] && !p.html.includes(`${P} Hidden event`), "a hidden event previews as 404, noindex, without its words", `${p.status} ${JSON.stringify(p.meta)}`);
  p = await preview("/events/999999999", "en");
  check(p.status === 404 && /Event not found/.test(p.meta["og:title"] ?? ""), "an unknown event previews as 404 'Event not found'", p.meta["og:title"]);
  r = await api(`/events/${ev.id}`, { "user-agent": BROWSER });
  check(r.status === 200 && !/property="og:type"\s+content="article"/.test(r.text), "a browser asking for the event page gets the app shell with 200, not the preview", `${r.status}`);
  r = await api(`/events/${hiddenEv.id}`, { "user-agent": BROWSER });
  check(r.status === 404, "…and 404 for a hidden event (no soft 404)", `${r.status}`);
  r = await api("/sitemap.xml");
  check(r.status === 200 && r.text.includes(`/events/${ev.id}</loc>`) && !r.text.includes(`/events/${past1.id}</loc>`) && !r.text.includes(`/events/${hiddenEv.id}</loc>`), "sitemap lists the upcoming active event, not past or hidden ones");
  r = await api("/api/search?q=" + encodeURIComponent(`${P} Thai`));
  check(r.status === 200 && r.json?.groups?.find((g) => g.type === "events")?.items.some((i) => i.title_ta === TA_EVENT), "site search still finds the event by title");

  r = await evPost({ action: "save", id: String(ev.id), title_ta: TA_EVENT, title_en: `${P} Thai Poosam (edited)`, event_type: "special", event_date: isoDate(5), end_date: "", start_time: "", end_time: "", venue_ta: "", venue_en: "", description_ta: "திருத்தப்பட்டது", description_en: "", image_url: "", is_active: "1" });
  edited = sql("SELECT * FROM events WHERE id = ?", [ev.id]).rows[0];
  check(redirected(r) && edited.title_en === `${P} Thai Poosam (edited)` && edited.event_type === "special" && edited.is_featured === 0 && edited.end_date === null && edited.start_time === null && edited.venue_ta === null && edited.image_url === null && edited.description_ta === "திருத்தப்பட்டது" && edited.description_en === null && edited.description === "திருத்தப்பட்டது", "edit persisted: type changed, unchecked featured clears it, blanks become NULL, the legacy description falls back to Tamil", JSON.stringify(edited));
  check(sql("SELECT COUNT(*) AS n FROM events WHERE title_en LIKE ?", [`${P}%`]).rows[0].n === 5 && audits("event_updated", `event:${ev.id}`) === 1, "edit did not create a duplicate and is audited");
  r = await owner.get(`/admin/events.php?edit=${ev.id}`);
  check(r.status === 200 && r.text.includes(`value="${TA_EVENT}"`) && /<option value="special" selected>/.test(r.text) && r.text.includes("திருத்தப்பட்டது"), "edit form is pre-filled with the Tamil title, the type and the Tamil description");
  r = await evPost({ action: "feature", id: String(ev.id) });
  check(redirected(r) && sql("SELECT is_featured FROM events WHERE id = ?", [ev.id]).rows[0].is_featured === 1 && audits("event_featured", `event:${ev.id}`) === 1, "feature toggle sets featured and is audited");
  r = await evPost({ action: "toggle", id: String(ev.id) });
  check(redirected(r) && sql("SELECT is_active FROM events WHERE id = ?", [ev.id]).rows[0].is_active === 0 && audits("event_toggled", `event:${ev.id}`) === 1, "toggle hides the event and is audited");
  r = await api(`/api/events/${ev.id}`);
  check(r.status === 404, "a hidden event's own address answers 404");
  await evPost({ action: "toggle", id: String(ev.id) });
  r = await api("/api/events?featured=1&limit=100");
  check(r.json.some((e) => e.id === ev.id && e.event_type === "special"), "toggle shows it again, still featured");
  r = await owner.get("/admin/events.php?f=featured&q=" + encodeURIComponent(P));
  check(r.text.includes(`${P} Thai Poosam (edited)`) && !r.text.includes(`${P} Old pooja`) && /Special/.test(r.text) && /Featured/.test(r.text), "Featured filter lists it with its type and Featured badges");
  r = await owner.get("/admin/events.php?f=all&t=pooja&q=" + encodeURIComponent(P));
  check(r.text.includes(`${P} Old pooja`) && !r.text.includes(`${P} Thai Poosam (edited)`), "type filter narrows the admin list");
  r = await evPost({ action: "delete", id: String(past2.id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM events WHERE id = ?", [past2.id]).rows[0].n === 0 && audits("event_deleted", `event:${past2.id}`) === 1, "delete removes the event and is audited");

  /* ── sevas ──────────────────────────────────────────────────────────── */
  const TA_SEVA = `${P} சிறப்பு அபிஷேகம்`;
  const TA_SDESC = "பாலாபிஷேகம், தேன் மற்றும் ரோஜாநீரால் தெய்வ அபிஷேகம்.";
  const TA_TIMING = "தினமும் காலை 7–9";
  r = await sevaPost({ action: "save", id: "0", name_ta: TA_SEVA, name_en: `${P} Special Abhishekam`, description_ta: TA_SDESC, description_en: "Sacred bathing with milk, honey and rose water.", timing_ta: TA_TIMING, timing_en: "Daily 7–9 am", amount: "501", sort_order: "5", is_featured: "1", is_bookable: "0", is_active: "1" });
  const seva = findSeva(`${P} Special Abhishekam`);
  check(redirected(r) && seva && seva.name_ta === TA_SEVA && seva.description_ta === TA_SDESC && seva.description_en === "Sacred bathing with milk, honey and rose water." && seva.timing_ta === TA_TIMING && seva.timing_en === "Daily 7–9 am" && Number(seva.amount) === 501 && seva.sort_order === 5 && seva.is_featured === 1 && seva.is_bookable === 0 && seva.is_active === 1, "seva created with bilingual description and timing, not bookable, Tamil intact", `${r.status} ${flashOf(r.text)} ${JSON.stringify(seva)}`);
  check(seva.description === seva.description_en && !!seva.created_at, "the old description column carries the English text; created_at set");
  check(audits("seva_created", `seva:${seva.id}`) === 1, "seva_created is audited");
  r = await sevaPost({ action: "save", id: "0", name_ta: `${P} பழைய சேவை`, name_en: `${P} Legacy seva`, description: "d", amount: "101", sort_order: "6", is_active: "1" });
  const legacySeva = findSeva(`${P} Legacy seva`);
  check(redirected(r) && legacySeva && legacySeva.description_ta === "d" && legacySeva.description_en === "d" && legacySeva.is_bookable === 1 && legacySeva.timing_ta === null, "the old description field is still accepted and a request that never mentions is_bookable leaves the seva bookable", JSON.stringify(legacySeva));
  r = await api("/api/sevas?limit=100");
  pub = r.json?.find((s) => s.id === seva.id);
  const pubLegacy = r.json?.find((s) => s.id === legacySeva.id);
  check(r.status === 200 && pub && pub.description_ta === TA_SDESC && pub.description_en === seva.description_en && pub.description === seva.description_en && pub.timing_ta === TA_TIMING && pub.timing_en === "Daily 7–9 am" && pub.is_bookable === false && pubLegacy && pubLegacy.is_bookable === true && pubLegacy.description_ta === "d", "GET /api/sevas carries bilingual description and timing, the legacy key and is_bookable", JSON.stringify(pub));
  check(sameKeys(pub, SEVA_KEYS), "a public seva exposes exactly the documented keys", Object.keys(pub).join());
  r = await api("/api/sevas?featured=1&limit=100");
  check(r.json.some((s) => s.id === seva.id) && !r.json.some((s) => s.id === legacySeva.id), "?featured still filters");
  r = await sevaPost({ action: "save", id: String(seva.id), name_ta: TA_SEVA, name_en: `${P} Special Abhishekam (edited)`, description_ta: TA_SDESC, description_en: "", timing_ta: "", timing_en: "Fridays 6 pm", amount: "551", sort_order: "5", is_bookable: "1", is_active: "1" });
  edited = sql("SELECT * FROM sevas WHERE id = ?", [seva.id]).rows[0];
  check(redirected(r) && edited.name_en === `${P} Special Abhishekam (edited)` && edited.description_en === null && edited.description === TA_SDESC && edited.timing_ta === null && edited.timing_en === "Fridays 6 pm" && Number(edited.amount) === 551 && edited.is_bookable === 1 && edited.is_featured === 0, "edit persisted: bookable again, unchecked featured clears it, blanks become NULL, legacy description falls back to Tamil", JSON.stringify(edited));
  check(audits("seva_updated", `seva:${seva.id}`) === 1, "seva_updated is audited");
  r = await owner.get(`/admin/sevas.php?edit=${seva.id}`);
  check(r.status === 200 && r.text.includes(`value="${TA_SEVA}"`) && r.text.includes(TA_SDESC) && r.text.includes('value="Fridays 6 pm"'), "edit form is pre-filled with the Tamil name, description and the timing");
  r = await sevaPost({ action: "bookable", id: String(seva.id) });
  check(redirected(r) && sql("SELECT is_bookable FROM sevas WHERE id = ?", [seva.id]).rows[0].is_bookable === 0 && audits("seva_bookable_toggled", `seva:${seva.id}`) === 1, "the bookable action switches booking off and is audited");
  r = await api("/api/sevas?limit=100");
  check(r.json.find((s) => s.id === seva.id)?.is_bookable === false, "…and the public list says so");
  r = await owner.get("/admin/sevas.php?f=unbookable");
  check(r.text.includes(`${P} Special Abhishekam (edited)`) && !r.text.includes(`${P} Legacy seva`) && /Not bookable/.test(r.text), "Not bookable filter and badge");
  r = await sevaPost({ action: "toggle", id: String(seva.id) });
  check(redirected(r) && sql("SELECT is_active FROM sevas WHERE id = ?", [seva.id]).rows[0].is_active === 0 && audits("seva_toggled", `seva:${seva.id}`) === 1, "toggle hides the seva and is audited");
  r = await api("/api/sevas?limit=100");
  check(!r.json.some((s) => s.id === seva.id), "a hidden seva leaves the public list");
  await sevaPost({ action: "toggle", id: String(seva.id) });
  r = await sevaPost({ action: "save", id: "0", name_ta: "த", name_en: `${P} bad amount`, amount: "-5", is_active: "1" });
  check(r.status === 200 && !findSeva(`${P} bad amount`), "a negative amount is still refused");

  /* ── E2E-047/048: hostile payloads are data ─────────────────────────── */
  r = await annPost({ action: "save", id: "0", title_ta: XSS, title_en: SQLI, body_ta: SQLI, body_en: XSS, is_active: "1" });
  const hostileAnn = findAnn(SQLI);
  check(redirected(r) && hostileAnn && hostileAnn.title_en === SQLI && !/<script|onerror/.test(hostileAnn.title_ta + hostileAnn.body_en) && hostileAnn.title_ta.startsWith(P), "E2E-047 hostile announcement stored as text (table still exists); tags stripped on save", JSON.stringify(hostileAnn));
  r = await evPost({ action: "save", id: "0", title_ta: XSS, title_en: SQLI, venue_ta: XSS, venue_en: SQLI, description_ta: SQLI, description_en: XSS, event_type: "festival", event_date: isoDate(9), is_active: "1" });
  const hostileEv = findEvent(SQLI);
  check(redirected(r) && hostileEv && hostileEv.title_en === SQLI && !/<script|onerror/.test(hostileEv.title_ta + hostileEv.venue_ta + hostileEv.description_en), "E2E-047 hostile event stored as text", JSON.stringify(hostileEv));
  r = await sevaPost({ action: "save", id: "0", name_ta: XSS, name_en: SQLI, description_ta: SQLI, timing_ta: XSS, timing_en: SQLI, amount: "1", is_active: "1" });
  const hostileSeva = findSeva(SQLI);
  check(redirected(r) && hostileSeva && hostileSeva.name_en === SQLI && !/<script|onerror/.test(hostileSeva.name_ta + hostileSeva.timing_ta), "E2E-047 hostile seva stored as text", JSON.stringify(hostileSeva));
  for (const page of ["announcements", "events", "sevas"]) {
    r = await owner.get(`/admin/${page}.php?q=${encodeURIComponent(P)}&f=${encodeURIComponent(XSS)}&t=${encodeURIComponent(XSS)}`);
    check(r.status === 200 && !FATAL.test(r.text) && !r.text.includes("<script>alert(1)</script>") && !r.text.includes("onerror=alert(2)>") && r.text.includes("&#039;); DROP TABLE"), `E2E-048 ${page} list shows the payload escaped, never as markup; hostile filters are harmless`);
  }
  r = await owner.get(`/admin/events.php?edit=${hostileEv.id}`);
  check(!r.text.includes("<script>alert(1)</script>") && !/<img src=x onerror/.test(r.text), "E2E-048 event edit form escapes the payload");
  r = await api("/api/events?upcoming=1&limit=100");
  check(r.json.some((e) => e.id === hostileEv.id && e.title_en === SQLI) && !/<script/.test(r.text), "E2E-048 the API returns the stored text as a JSON string; no script tag anywhere");
  p = await preview(`/events/${hostileEv.id}`, "en");
  check(p.status === 200 && !p.html.includes("<script>alert(1)</script>") && !/<img src=x onerror/.test(p.html) && p.html.includes("&#039;); DROP TABLE"), "E2E-048 og.php escapes the hostile event in its preview");
  r = await api("/api/search?q=" + encodeURIComponent(`${P}'); DROP`));
  check(r.status === 200 && !/<script/.test(r.text), "E2E-047 hostile search is harmless");

  /* ── E2E-013/046: roles ─────────────────────────────────────────────── */
  const usersHtml = (await owner.get("/admin/users.php")).text;
  const sessions = {};
  for (const [role, a] of Object.entries(ACCOUNTS)) {
    r = await owner.post("/admin/users.php", { _csrf: csrfOf(usersHtml), action: "save", id: "0", username: a.user, display_name: `${P} ${role}`, email: "", phone: "", role, password: a.issued, is_active: "1" });
    check(redirected(r), `owner creates a ${role} account`, `${r.status} ${flashOf(r.text)}`);
    const s = jar();
    r = await s.login(a.user, a.issued);
    const prof = (await s.get("/admin/profile.php")).text;
    await s.post("/admin/profile.php", { _csrf: csrfOf(prof), action: "password", current_password: a.issued, new_password: a.pw, confirm_password: a.pw });
    sessions[role] = s;
  }
  r = await sessions.editor.get("/admin/events.php?f=all&q=" + encodeURIComponent(P));
  check(r.status === 200 && r.text.includes(`${P} Thai Poosam (edited)`), "E2E-013 editor (content.edit) opens the Events page", `${r.status}`);
  const edCsrf = csrfOf(r.text);
  r = await evPost({ action: "save", id: "0", title_ta: `${P} ஆசிரியர்`, title_en: `${P} by editor`, event_type: "pooja", event_date: isoDate(6), description_ta: "ஆசிரியர்", is_active: "1" }, sessions.editor, edCsrf);
  const byEditor = findEvent(`${P} by editor`);
  check(redirected(r) && !!byEditor && byEditor.description_ta === "ஆசிரியர்", "E2E-013 editor can add a bilingual event");
  for (const role of ["finance", "viewer"]) {
    for (const page of ["announcements", "events", "sevas"]) {
      r = await sessions[role].get(`/admin/${page}.php`);
      check(r.status === 403, `E2E-013 ${role} gets 403 on the ${page} page`, `${r.status}`);
    }
    r = await sessions[role].post("/admin/events.php", { _csrf: "x", action: "toggle", id: String(byEditor.id) });
    check(r.status === 403 && sql("SELECT is_active FROM events WHERE id = ?", [byEditor.id]).rows[0].is_active === 1, `E2E-046 ${role} event POST is refused server-side`, `${r.status}`);
    r = await sessions[role].post("/admin/sevas.php", { _csrf: "x", action: "bookable", id: String(seva.id) });
    check(r.status === 403 && sql("SELECT is_bookable FROM sevas WHERE id = ?", [seva.id]).rows[0].is_bookable === 0, `E2E-046 ${role} seva POST is refused server-side`, `${r.status}`);
    r = await sessions[role].post("/admin/announcements.php", { _csrf: "x", action: "delete", id: String(ann.id) });
    check(r.status === 403 && sql("SELECT COUNT(*) AS n FROM announcements WHERE id = ?", [ann.id]).rows[0].n === 1, `E2E-046 ${role} announcement POST is refused server-side`, `${r.status}`);
  }

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\ncontent-bilingual: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\ncontent-bilingual: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  sql("DELETE FROM announcements WHERE title LIKE ? OR title_ta LIKE ? OR title_en LIKE ? OR body_ta LIKE ?", [`${P}%`, `${P}%`, `${P}%`, `${P}%`]);
  sql("DELETE FROM events WHERE title_en LIKE ? OR title_ta LIKE ?", [`${P}%`, `${P}%`]);
  sql("DELETE FROM sevas WHERE name_en LIKE ? OR name_ta LIKE ?", [`${P}%`, `${P}%`]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2ebiling_${RUN}_%`]);
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ?", [`%${P}%`, `%${P}%`, `e2ebiling_${RUN}_%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
