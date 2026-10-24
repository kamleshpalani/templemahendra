#!/usr/bin/env node
/**
 * tests/calendar-entries.mjs — Temple Calendar entries (brief §6 "Temple
 * Calendar": admins create, edit and disable entries; gap G-09) and their merge
 * into the computed Panchangam feed GET /api/calendar.
 *
 *   migration 018: InnoDB utf8mb4, indexes, FKs to poojas/events (SET NULL)
 *   admin page needs a session (E2E-045) and content.edit: editor 200,
 *   finance/viewer 403 (E2E-013/046); forged CSRF writes nothing (E2E-049)
 *   validation: dates 2020–2035, end ≥ start, Tamil + English title for "add"
 *   create / edit / hide / show / delete with Tamil intact (E2E-003), audited
 *   /api/calendar: custom entries appended to special[] (with id, custom,
 *   descriptions), multi-day spans (across a month boundary), hidden rows
 *   ignored, "hide" entries strip a computed observance (or all of them) but
 *   keep custom ones, upcoming[] follows; the computed days are otherwise
 *   untouched (same tithi/timings as before)
 *   SQL and script payloads are stored as data (E2E-047/048)
 *
 *   node tests/calendar-entries.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment, migration 018, and the admin account admin/Admin@Test123
 * (ADMIN_USERNAME / ADMIN_PASSWORD override). Everything it writes carries the
 * prefix "E2E-CAL-<run>" and is deleted in `finally`. It works in March/April
 * 2033 so it never collides with the committee's real entries.
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
const P = `E2E-CAL-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE calendar_entries;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const ACCOUNTS = {
  editor:  { user: `e2ecal_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2ecal_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2ecal_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};
const Y = 2033, M = 3; // a quiet month far from today; still inside the API's 2020–2035 window

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.93.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };

function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

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
async function api(path) {
  const r = await fetch(base + path, { headers: { "X-Forwarded-For": xff() }, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* checked by callers */ }
  return { status: r.status, headers: r.headers, text, json };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redirected = (r) => r.status === 302 || r.status === 303;
const flashOf = (html) => html.match(/alert[^>]*>([^<]+)/)?.[1] ?? "";
const findEntry = (en) => sql("SELECT * FROM calendar_entries WHERE title_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const month = async (y = Y, m = M) => (await api(`/api/calendar?year=${y}&month=${m}`)).json;
const dayOf = (data, date) => data.days.find((d) => d.date === date);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const stripCustom = (data) => data.days.map((d) => ({ ...d, special: d.special.filter((s) => !s.custom) }));
let poojaId = 0;
let eventId = 0;

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
    try { ready = (await fetch(`${base}/api/calendar`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── migration 018 ──────────────────────────────────────────────────── */
  const tbl = sql("SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_entries'").rows[0];
  check(tbl && tbl.ENGINE === "InnoDB" && tbl.TABLE_COLLATION === "utf8mb4_unicode_ci", "calendar_entries is InnoDB utf8mb4_unicode_ci", JSON.stringify(tbl));
  const cols = sql("SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_entries'").rows;
  const col = (n) => cols.find((c) => c.COLUMN_NAME === n)?.COLUMN_TYPE ?? "";
  check(/^enum\('add','hide'\)$/.test(col("mode")) && /'pournami'/.test(col("entry_type")) && col("entry_date") === "date" && col("end_date") === "date" && /text/.test(col("description_ta")) && col("is_active").startsWith("tinyint"), "columns: mode, entry_type, dates, bilingual text, is_active", cols.map((c) => c.COLUMN_NAME).join(","));
  const idx = sql("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_entries' GROUP BY INDEX_NAME").rows.map((r) => r.INDEX_NAME);
  check(idx.includes("idx_calendar_entry_active_dates") && idx.includes("idx_calendar_entry_pooja") && idx.includes("idx_calendar_entry_event"), "date-range, pooja and event indexes exist", idx.join(","));
  const fks = sql("SELECT CONSTRAINT_NAME, REFERENCED_TABLE_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_entries' AND REFERENCED_TABLE_NAME IS NOT NULL").rows;
  check(fks.some((f) => f.REFERENCED_TABLE_NAME === "poojas") && fks.some((f) => f.REFERENCED_TABLE_NAME === "events"), "foreign keys to poojas and events", JSON.stringify(fks));
  const rules = sql("SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'calendar_entries'").rows;
  check(rules.length === 2 && rules.every((r) => r.DELETE_RULE === "SET NULL"), "both FKs are ON DELETE SET NULL", JSON.stringify(rules));

  /* ── computed baseline ──────────────────────────────────────────────── */
  const baseline = await month();
  check(baseline && baseline.days.length === 31 && baseline.days.every((d) => Array.isArray(d.special) && d.tithi_ta && d.timings), "GET /api/calendar answers 31 computed days for March 2033");
  check(!baseline.days.some((d) => d.special.some((s) => s.custom)), "precondition: no committee entries in the test month");
  const pournamiDay = baseline.days.find((d) => d.special.some((s) => s.type === "pournami"));
  const busyDay = baseline.days.find((d) => d.special.length >= 1 && d !== pournamiDay);
  check(pournamiDay && busyDay, "the month has a computed Pournami and another observance to work with", `${pournamiDay?.date} ${busyDay?.date}`);

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  let r = await anon.get("/admin/calendar_entries.php");
  check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 admin calendar page redirects to sign-in", `${r.status}`);
  r = await anon.post("/admin/calendar_entries.php", { action: "save", id: "0", mode: "add", entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} அனாமதேய`, title_en: `${P} anonymous`, is_active: "1" });
  check(!findEntry(`${P} anonymous`), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in ─────────────────────────────────────────────────── */
  const owner = jar();
  r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/calendar_entries.php");
  check(r.status === 200 && !FATAL.test(r.text), "calendar page renders for the owner", `${r.status}`);
  check(/name="entry_type"/.test(r.text) && /name="entry_date"/.test(r.text) && /name="end_date"/.test(r.text) && /name="title_ta"/.test(r.text) && /name="title_en"/.test(r.text) && /name="description_ta"/.test(r.text) && /name="pooja_id"/.test(r.text) && /name="event_id"/.test(r.text) && /name="is_active"/.test(r.text), "form has type, dates, Tamil/English title and description, links and status");
  check(r.text.includes('href="/admin/calendar_entries.php"') && /Temple Calendar/.test(r.text), "sidebar links to Temple Calendar");
  r = await owner.get("/admin/calendar_entries.php?new=hide");
  check(r.status === 200 && /Suppress a computed observance/.test(r.text) && /name="mode" value="hide"/.test(r.text) && !/name="title_ta"/.test(r.text), "the suppression form asks only for the observance and date");
  let csrf = csrfOf(r.text);
  check(csrf.length >= 32, "CSRF token issued");
  const save = (fields, s = owner, token = csrf) => s.post("/admin/calendar_entries.php", { _csrf: token, action: "save", ...fields });

  /* ── E2E-049: CSRF ──────────────────────────────────────────────────── */
  const before = sql("SELECT COUNT(*) AS n FROM calendar_entries").rows[0].n;
  r = await save({ id: "0", mode: "add", entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} போலி`, title_en: `${P} forged`, is_active: "1" }, owner, "forged-" + csrf.slice(0, 20));
  check(r.status === 200 && /tampered with/.test(r.text), "E2E-049 forged token is refused with a message", `${r.status}`);
  r = await owner.post("/admin/calendar_entries.php", { action: "save", id: "0", mode: "add", entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} போலி`, title_en: `${P} no token`, is_active: "1" });
  check(sql("SELECT COUNT(*) AS n FROM calendar_entries").rows[0].n === before, "E2E-049 forged and missing tokens wrote nothing");

  /* ── validation ─────────────────────────────────────────────────────── */
  const bad = [
    [{ entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: "", title_en: `${P} no tamil` }, "an entry without a Tamil title is refused"],
    [{ entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} த`, title_en: "" }, "an entry without an English title is refused"],
    [{ entry_type: "festival", entry_date: "2033-02-30", title_ta: `${P} த`, title_en: `${P} bad date` }, "an impossible date is refused"],
    [{ entry_type: "festival", entry_date: "2041-01-01", title_ta: `${P} த`, title_en: `${P} far date` }, "a date outside 2020–2035 is refused"],
    [{ entry_type: "festival", entry_date: ymd(Y, M, 10), end_date: ymd(Y, M, 9), title_ta: `${P} த`, title_en: `${P} backwards` }, "an end date before the start date is refused"],
    [{ entry_type: "all", entry_date: ymd(Y, M, 3), title_ta: `${P} த`, title_en: `${P} all add` }, "type 'all' is only for suppressions"],
    [{ entry_type: "'; DROP TABLE calendar_entries;--", entry_date: ymd(Y, M, 3), title_ta: `${P} த`, title_en: `${P} bad type` }, "an unknown type is refused"],
    [{ entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} த`, title_en: `${P} bad order`, sort_order: "abc" }, "a non-numeric order is refused"],
    [{ entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} த`, title_en: `${P} bad pooja`, pooja_id: "999999999" }, "a pooja id that does not exist is refused"],
    [{ entry_type: "festival", entry_date: ymd(Y, M, 3), title_ta: `${P} த`, title_en: `${P} bad event`, event_id: "1 OR 1=1" }, "a non-numeric event id is refused"],
  ];
  for (const [fields, label] of bad) {
    r = await save({ id: "0", mode: "add", is_active: "1", ...fields });
    check(r.status === 200 && /highlighted/.test(r.text) && !FATAL.test(r.text) && !findEntry(fields.title_en), label, `${r.status}`);
  }
  check(sql("SELECT COUNT(*) AS n FROM calendar_entries").rows[0].n === before, "no invalid submission wrote a row");

  /* ── create: a single-day festival, with description and links ──────── */
  sql("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_type, is_active) VALUES (?, ?, ?, 'special', 1)", [`${P} பூஜை`, `${P} pooja`, ymd(Y, M, 12)]);
  poojaId = sql("SELECT id FROM poojas WHERE name_en = ?", [`${P} pooja`]).rows[0].id;
  sql("INSERT INTO events (title_ta, title_en, event_date, is_active) VALUES (?, ?, ?, 1)", [`${P} நிகழ்வு`, `${P} event`, ymd(Y, M, 12)]);
  eventId = sql("SELECT id FROM events WHERE title_en = ?", [`${P} event`]).rows[0].id;
  r = await save({ id: "0", mode: "add", entry_type: "festival", entry_date: ymd(Y, M, 12), title_ta: `${P} பங்குனி உத்திரம்`, title_en: `${P} Panguni Uthiram`,
    description_ta: "தேர் திருவிழா — மாலை 6 மணி", description_en: "Chariot festival at 6 pm", pooja_id: String(poojaId), event_id: String(eventId), sort_order: "5", is_active: "1" });
  check(redirected(r), "created entry redirects to the list", `${r.status} ${flashOf(r.text)}`);
  const fest = findEntry(`${P} Panguni Uthiram`);
  check(fest && fest.title_ta === `${P} பங்குனி உத்திரம்` && fest.description_ta === "தேர் திருவிழா — மாலை 6 மணி" && fest.entry_date === ymd(Y, M, 12) && fest.end_date === null && fest.mode === "add" && fest.entry_type === "festival" && fest.pooja_id === poojaId && fest.event_id === eventId && fest.sort_order === 5 && fest.is_active === 1, "E2E-003 row stored with Tamil title and description intact, links and order", JSON.stringify(fest));
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'calendar_entry_created' AND subject = ?", [`calendar_entry:${fest.id}`]).rows[0].n === 1, "creation is audited");
  r = await owner.get("/admin/calendar_entries.php?f=all");
  check(r.text.includes(`${P} Panguni Uthiram`) && r.text.includes(`${P} பங்குனி உத்திரம்`) && r.text.includes(`${P} pooja`) && r.text.includes(`${P} event`), "list shows the entry in both languages with its links");

  /* ── public merge: appended to that day, computed items untouched ──── */
  let data = await month();
  let day = dayOf(data, ymd(Y, M, 12));
  const mine = day.special.find((s) => s.id === fest.id);
  check(mine && mine.custom === true && mine.type === "festival" && mine.ta === `${P} பங்குனி உத்திரம்` && mine.en === `${P} Panguni Uthiram` && mine.description_ta === "தேர் திருவிழா — மாலை 6 மணி" && mine.description_en === "Chariot festival at 6 pm" && mine.pooja_id === poojaId && mine.event_id === eventId && mine.end_date === null, "E2E-003 /api/calendar carries the entry with Tamil intact, id, custom flag, descriptions and links", JSON.stringify(mine));
  check(day.special.filter((s) => !s.custom).length === dayOf(baseline, ymd(Y, M, 12)).special.length && day.tithi_ta === dayOf(baseline, ymd(Y, M, 12)).tithi_ta, "computed observances and tithi on that day are unchanged");
  check(JSON.stringify(stripCustom(data)) === JSON.stringify(baseline.days), "every other computed value in the month is byte-identical to the baseline");
  check(data.days.filter((d) => d.special.some((s) => s.id === fest.id)).length === 1, "a single-day entry appears on exactly one day");
  check(typeof mine.ta === "string" && !("title_ta" in mine), "public item uses the calendar's {type, ta, en} shape the React page already renders");

  /* ── a multi-day span crossing the month boundary ───────────────────── */
  r = await save({ id: "0", mode: "add", entry_type: "pooja", entry_date: ymd(Y, M, 30), end_date: ymd(Y, M + 1, 2), title_ta: `${P} மண்டல பூஜை`, title_en: `${P} Mandala pooja`, is_active: "1" });
  const span = findEntry(`${P} Mandala pooja`);
  check(redirected(r) && span && span.end_date === ymd(Y, M + 1, 2), "a multi-day entry is stored with its end date", JSON.stringify(span));
  data = await month();
  const next = await month(Y, M + 1);
  const onDays = [...data.days, ...next.days].filter((d) => d.special.some((s) => s.id === span.id)).map((d) => d.date);
  check(JSON.stringify(onDays) === JSON.stringify([ymd(Y, M, 30), ymd(Y, M, 31), ymd(Y, M + 1, 1), ymd(Y, M + 1, 2)]), "the span marks every day from start to end across the month boundary", onDays.join(","));
  check(dayOf(next, ymd(Y, M + 1, 1)).special.find((s) => s.id === span.id)?.type === "pooja", "the entry's type travels with it");

  /* ── ordering within a day ──────────────────────────────────────────── */
  r = await save({ id: "0", mode: "add", entry_type: "custom", entry_date: ymd(Y, M, 12), title_ta: `${P} முதல்`, title_en: `${P} first`, sort_order: "1", is_active: "1" });
  const first = findEntry(`${P} first`);
  data = await month();
  const ids = dayOf(data, ymd(Y, M, 12)).special.filter((s) => s.custom).map((s) => s.id);
  check(JSON.stringify(ids) === JSON.stringify([first.id, fest.id]), "entries on one day follow sort_order", ids.join(","));

  /* ── edit ───────────────────────────────────────────────────────────── */
  r = await save({ id: String(fest.id), mode: "add", entry_type: "holiday", entry_date: ymd(Y, M, 13), title_ta: `${P} திருத்தம்`, title_en: `${P} Panguni Uthiram (edited)`, description_en: "moved", pooja_id: "", event_id: "", sort_order: "7", is_active: "1" });
  const edited = sql("SELECT * FROM calendar_entries WHERE id = ?", [fest.id]).rows[0];
  check(redirected(r) && edited.title_en === `${P} Panguni Uthiram (edited)` && edited.title_ta === `${P} திருத்தம்` && edited.entry_type === "holiday" && edited.entry_date === ymd(Y, M, 13) && edited.description_ta === null && edited.description_en === "moved" && edited.pooja_id === null && edited.event_id === null && edited.sort_order === 7, "edit persisted (type, date, text, cleared links)", JSON.stringify(edited));
  check(sql("SELECT COUNT(*) AS n FROM calendar_entries WHERE title_en LIKE ?", [`${P}%`]).rows[0].n === 3, "edit did not create a duplicate");
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'calendar_entry_updated' AND subject = ?", [`calendar_entry:${fest.id}`]).rows[0].n === 1, "edit is audited");
  data = await month();
  check(!dayOf(data, ymd(Y, M, 12)).special.some((s) => s.id === fest.id) && dayOf(data, ymd(Y, M, 13)).special.some((s) => s.id === fest.id && s.type === "holiday"), "the public calendar follows the edit");
  r = await owner.get(`/admin/calendar_entries.php?edit=${fest.id}`);
  check(r.status === 200 && r.text.includes(`value="${P} திருத்தம்"`) && /value="holiday" selected/.test(r.text), "edit form is pre-filled with the Tamil title and type");
  r = await owner.get("/admin/calendar_entries.php?edit=999999999");
  check(r.status === 200 && /no longer exists/.test(r.text) && !FATAL.test(r.text), "editing a missing id is handled");

  /* ── hide / show ────────────────────────────────────────────────────── */
  r = await owner.post("/admin/calendar_entries.php", { _csrf: csrf, action: "toggle", id: String(fest.id) });
  check(redirected(r) && sql("SELECT is_active FROM calendar_entries WHERE id = ?", [fest.id]).rows[0].is_active === 0, "toggle hides the entry");
  data = await month();
  check(!data.days.some((d) => d.special.some((s) => s.id === fest.id)), "a hidden entry leaves the public calendar");
  r = await owner.get("/admin/calendar_entries.php?f=hidden");
  check(r.text.includes(`${P} Panguni Uthiram (edited)`), "Hidden filter lists it");
  r = await owner.get("/admin/calendar_entries.php?f=upcoming");
  check(!r.text.includes(`${P} Panguni Uthiram (edited)`) && r.text.includes(`${P} Mandala pooja`), "Upcoming filter omits hidden entries and lists applied ones");
  await owner.post("/admin/calendar_entries.php", { _csrf: csrf, action: "toggle", id: String(fest.id) });
  check(sql("SELECT is_active FROM calendar_entries WHERE id = ?", [fest.id]).rows[0].is_active === 1, "toggle applies it again");
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'calendar_entry_toggled' AND subject = ?", [`calendar_entry:${fest.id}`]).rows[0].n === 2, "both toggles are audited");

  /* ── suppress a computed observance ─────────────────────────────────── */
  r = await save({ id: "0", mode: "hide", entry_type: "pournami", entry_date: pournamiDay.date, is_active: "1" });
  check(redirected(r), "a Pournami suppression is saved without titles", `${r.status} ${flashOf(r.text)}`);
  const hide = sql("SELECT * FROM calendar_entries WHERE mode = 'hide' AND entry_date = ? ORDER BY id DESC LIMIT 1", [pournamiDay.date]).rows[0];
  check(hide && hide.entry_type === "pournami" && hide.title_en === "" && hide.description_en === null, "suppression row: mode hide, type pournami, no text", JSON.stringify(hide));
  data = await month();
  day = dayOf(data, pournamiDay.date);
  check(!day.special.some((s) => s.type === "pournami"), "the computed Pournami is gone from that day");
  check(day.special.filter((s) => !s.custom).length === pournamiDay.special.length - 1 && day.tithi_ta === pournamiDay.tithi_ta, "other computed observances and the tithi on that day stay");
  check(!data.upcoming.some((d) => d.date === pournamiDay.date && d.special.some((s) => s.type === "pournami")), "upcoming[] no longer offers that Pournami");
  r = await owner.get("/admin/calendar_entries.php?f=suppress");
  check(r.text.includes(`Suppress Pournami`) && r.text.includes(pournamiDay.date), "Suppressions filter lists it");
  /* suppressing one type does not touch a custom entry on the same day; 'all' removes every computed one */
  r = await save({ id: "0", mode: "add", entry_type: "pournami", entry_date: pournamiDay.date, title_ta: `${P} முன்நாள் பௌர்ணமி`, title_en: `${P} Pournami observed today`, is_active: "1" });
  const own = findEntry(`${P} Pournami observed today`);
  r = await save({ id: "0", mode: "hide", entry_type: "all", entry_date: busyDay.date, is_active: "1" });
  const hideAll = sql("SELECT * FROM calendar_entries WHERE mode = 'hide' AND entry_type = 'all' AND entry_date = ?", [busyDay.date]).rows[0];
  data = await month();
  day = dayOf(data, pournamiDay.date);
  check(day.special.some((s) => s.id === own.id && s.type === "pournami") && !day.special.some((s) => s.type === "pournami" && !s.custom), "the committee's own Pournami entry replaces the computed one");
  check(hideAll && dayOf(data, busyDay.date).special.length === 0, "'all' clears every computed observance on its day", JSON.stringify(dayOf(data, busyDay.date).special));
  /* hiding the suppression restores the computed day */
  await owner.post("/admin/calendar_entries.php", { _csrf: csrf, action: "toggle", id: String(hideAll.id) });
  data = await month();
  check(JSON.stringify(dayOf(data, busyDay.date).special) === JSON.stringify(busyDay.special), "a hidden suppression restores the computed observances");

  /* ── the same merge feeds the homepage's next-Pournami lookup ───────── */
  const homeMonth = await api(`/api/calendar?year=${Y}&month=${M}`);
  check(homeMonth.status === 200 && !homeMonth.json.days.some((d) => d.special.some((s) => s.type === "pournami" && !s.custom && d.date === pournamiDay.date)), "the homepage's month feed sees the suppression too");

  /* ── FK: deleting the linked pooja/event nulls the link, keeps the entry */
  r = await save({ id: String(first.id), mode: "add", entry_type: "custom", entry_date: ymd(Y, M, 12), title_ta: `${P} முதல்`, title_en: `${P} first`, pooja_id: String(poojaId), event_id: String(eventId), sort_order: "1", is_active: "1" });
  check(sql("SELECT pooja_id, event_id FROM calendar_entries WHERE id = ?", [first.id]).rows[0].pooja_id === poojaId, "entry linked to the pooja and event");
  sql("DELETE FROM poojas WHERE id = ?", [poojaId]); poojaId = 0;
  sql("DELETE FROM events WHERE id = ?", [eventId]); eventId = 0;
  const orphan = sql("SELECT * FROM calendar_entries WHERE id = ?", [first.id]).rows[0];
  check(orphan && orphan.pooja_id === null && orphan.event_id === null, "ON DELETE SET NULL: the entry survives with its links cleared", JSON.stringify(orphan));
  data = await month();
  check(dayOf(data, ymd(Y, M, 12)).special.some((s) => s.id === first.id && s.pooja_id === null), "the public calendar still lists it");

  /* ── E2E-047/048: hostile payloads are data ─────────────────────────── */
  r = await save({ id: "0", mode: "add", entry_type: "custom", entry_date: ymd(Y, M, 20), title_ta: XSS, title_en: SQLI, description_en: XSS, description_ta: SQLI, is_active: "1" });
  check(redirected(r), "hostile payloads are accepted as text", `${r.status} ${flashOf(r.text)}`);
  const hostile = findEntry(SQLI);
  check(hostile && hostile.title_en === SQLI && !/<script|onerror/.test(hostile.title_ta) && hostile.title_ta.startsWith(P), "E2E-047 the SQL payload is stored verbatim (table still exists); tags are stripped on save", JSON.stringify(hostile));
  r = await owner.get("/admin/calendar_entries.php?f=all");
  check(!r.text.includes("<script>alert(1)</script>") && !r.text.includes("onerror=alert(2)>") && r.text.includes("&#039;); DROP TABLE"), "E2E-048 admin list shows the payload escaped, never as markup");
  r = await owner.get(`/admin/calendar_entries.php?edit=${hostile.id}`);
  check(!r.text.includes("<script>alert(1)</script>") && !/<img src=x onerror/.test(r.text), "E2E-048 edit form escapes the payload");
  data = await month();
  check(dayOf(data, ymd(Y, M, 20)).special.some((s) => s.id === hostile.id && s.en === SQLI) && !/<script/.test(JSON.stringify(data)), "E2E-048 API returns the stored text as a JSON string; no script tag anywhere");
  r = await owner.get("/admin/calendar_entries.php?f=" + encodeURIComponent(SQLI) + "&edit=" + encodeURIComponent(SQLI));
  check(r.status === 200 && !FATAL.test(r.text), "E2E-047 SQL payload in the filter and edit id is harmless");
  r = await api(`/api/calendar?year=${encodeURIComponent(SQLI)}&month=${encodeURIComponent(XSS)}`);
  check(r.status === 200 && r.json && r.json.days.length >= 28, "E2E-047 hostile year/month fall back to the current month");

  /* ── delete ─────────────────────────────────────────────────────────── */
  r = await owner.post("/admin/calendar_entries.php", { _csrf: csrf, action: "delete", id: String(hostile.id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM calendar_entries WHERE id = ?", [hostile.id]).rows[0].n === 0, "delete removes the entry");
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'calendar_entry_deleted' AND subject = ?", [`calendar_entry:${hostile.id}`]).rows[0].n === 1, "deletion is audited");
  data = await month();
  check(!dayOf(data, ymd(Y, M, 20)).special.some((s) => s.id === hostile.id), "a deleted entry leaves the public calendar");

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
  r = await sessions.editor.get("/admin/calendar_entries.php?f=all");
  check(r.status === 200 && r.text.includes(`${P} Mandala pooja`), "E2E-013 editor (content.edit) opens the Temple Calendar page", `${r.status}`);
  const edCsrf = csrfOf(r.text);
  r = await save({ id: "0", mode: "add", entry_type: "festival", entry_date: ymd(Y, M, 25), title_ta: `${P} ஆசிரியர்`, title_en: `${P} by editor`, is_active: "1" }, sessions.editor, edCsrf);
  const byEditor = findEntry(`${P} by editor`);
  check(redirected(r) && !!byEditor, "E2E-013 editor can create an entry");
  for (const role of ["finance", "viewer"]) {
    r = await sessions[role].get("/admin/calendar_entries.php");
    check(r.status === 403, `E2E-013 ${role} gets 403 on the Temple Calendar page`, `${r.status}`);
    r = await sessions[role].post("/admin/calendar_entries.php", { _csrf: "x", action: "toggle", id: String(byEditor.id) });
    check(r.status === 403 && sql("SELECT is_active FROM calendar_entries WHERE id = ?", [byEditor.id]).rows[0].is_active === 1, `E2E-046 ${role} POST is refused server-side`, `${r.status}`);
    r = await sessions[role].post("/admin/calendar_entries.php", { _csrf: "x", action: "delete", id: String(byEditor.id) });
    check(r.status === 403 && sql("SELECT COUNT(*) AS n FROM calendar_entries WHERE id = ?", [byEditor.id]).rows[0].n === 1, `E2E-046 ${role} cannot delete`, `${r.status}`);
  }

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\ncalendar-entries: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\ncalendar-entries: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  sql("DELETE FROM calendar_entries WHERE title_en LIKE ? OR (mode = 'hide' AND entry_date BETWEEN ? AND ?)", [`${P}%`, `${Y}-01-01`, `${Y}-12-31`]);
  if (poojaId) sql("DELETE FROM poojas WHERE id = ?", [poojaId]);
  if (eventId) sql("DELETE FROM events WHERE id = ?", [eventId]);
  sql("DELETE FROM poojas WHERE name_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM events WHERE title_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2ecal_${RUN}_%`]);
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ?", [`%${P}%`, `%${P}%`, `e2ecal_${RUN}_%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
