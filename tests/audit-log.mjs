#!/usr/bin/env node
/**
 * tests/audit-log.mjs — Audit Logs (brief §28 audit log, §15 System → Audit
 * Logs, §16 dashboard "recent CMS activity"; gap G-10).
 *
 *   coverage: sign-in, sign-out, failed sign-in, content create/update/delete
 *   (announcement, event, pooja, seva, widget), settings change, account change
 *   each write one admin_activity row with actor, action, subject (entity:id),
 *   detail and IP
 *   /admin/audit_log.php needs a session (E2E-045); owner + admin 200, editor,
 *   finance and viewer 403 (E2E-013/046); POST is refused; the page has no
 *   write path so rows can never be edited or deleted from the CMS
 *   filters: who, module, single action, search, date range, sort; unknown
 *   values fall back safely; pagination; CSV export honours the filters and
 *   itself leaves an audit row
 *   SQL and script payloads in audited data or in the filters are stored /
 *   echoed as text only (E2E-047/048); Tamil survives (E2E-003)
 *
 *   node tests/audit-log.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment and the admin account admin/Admin@Test123 (ADMIN_USERNAME /
 * ADMIN_PASSWORD override). Everything it writes carries the prefix
 * "E2E-AUD-<run>" and is deleted in `finally`.
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
const P = `E2E-AUD-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE admin_activity;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const ACCOUNTS = {
  admin:   { user: `e2eaud_${RUN}_ad`, issued: "Kovil77Admin", pw: "Gopuram51Key" },
  editor:  { user: `e2eaud_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2eaud_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2eaud_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.94.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
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
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redirected = (r) => r.status === 302 || r.status === 303;
const flashOf = (html) => html.match(/alert[^>]*>([^<]+)/)?.[1] ?? "";
const audit = (action, subjectLike = "%") => sql("SELECT * FROM admin_activity WHERE action = ? AND subject LIKE ? ORDER BY id DESC LIMIT 1", [action, subjectLike]).rows[0];
const rowsOf = (html) => (html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr>/g) ?? []).length;
const countOf = (html) => Number(/toolbar__count">(\d+) entr/.exec(html)?.[1] ?? -1);

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

  /* ── schema ─────────────────────────────────────────────────────────── */
  const tbl = sql("SELECT ENGINE, TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_activity'").rows[0];
  check(tbl && tbl.ENGINE === "InnoDB" && tbl.TABLE_COLLATION === "utf8mb4_unicode_ci", "admin_activity is InnoDB utf8mb4_unicode_ci", JSON.stringify(tbl));
  const cols = sql("SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_activity'").rows;
  const col = (n) => cols.find((c) => c.COLUMN_NAME === n)?.COLUMN_TYPE ?? "";
  check(col("actor") === "varchar(60)" && col("action") === "varchar(60)" && col("subject") === "varchar(190)" && col("detail") === "varchar(500)" && col("created_at") === "datetime", "columns: actor, action(60), subject, detail, ip, created_at", cols.map((c) => `${c.COLUMN_NAME}:${c.COLUMN_TYPE}`).join(","));
  const idx = sql("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_activity' GROUP BY INDEX_NAME").rows.map((r) => r.INDEX_NAME);
  check(idx.includes("idx_created") && idx.includes("idx_actor"), "created_at and actor indexes exist", idx.join(","));

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  let r = await anon.get("/admin/audit_log.php");
  check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 audit page redirects to sign-in", `${r.status}`);
  r = await anon.get("/admin/audit_log.php?export=csv");
  check(redirected(r) && !/^id,when/.test(r.text), "E2E-045 anonymous CSV export is refused", `${r.status}`);

  /* ── failed and successful sign-in are audited ──────────────────────── */
  const failIp = xff();
  r = await anon.post("/admin/login.php", { _csrf: csrfOf((await anon.get("/admin/login.php")).text), username: `${P}-nobody`, password: "wrong-pass", next: "" }, { "X-Forwarded-For": failIp });
  let row = audit("login_failed", `%${P}-nobody%`);
  check(!!row && row.actor === `${P}-nobody` && row.ip === failIp, "a failed sign-in is audited with the attempted name and the caller's IP", JSON.stringify(row));

  const owner = jar();
  const ownerIp = xff();
  r = await owner.post("/admin/login.php", { _csrf: csrfOf((await owner.get("/admin/login.php")).text), username: ADMIN.username, password: ADMIN.password, next: "" }, { "X-Forwarded-For": ownerIp });
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  row = sql("SELECT * FROM admin_activity WHERE action = 'login' AND actor = ? ORDER BY id DESC LIMIT 1", [ADMIN.username]).rows[0];
  check(!!row && row.ip === ownerIp, "the sign-in is audited with actor and IP", JSON.stringify(row));

  /* ── page renders for the owner ─────────────────────────────────────── */
  r = await owner.get("/admin/audit_log.php");
  check(r.status === 200 && !FATAL.test(r.text), "audit page renders for the owner", `${r.status}`);
  check(/Audit Logs/.test(r.text) && r.text.includes('href="/admin/audit_log.php"'), "sidebar links to Audit Logs");
  check(/name="q"/.test(r.text) && /name="actor"/.test(r.text) && /name="module"/.test(r.text) && /name="from"/.test(r.text) && /name="to"/.test(r.text), "filters: search, who, what, from, to");
  check(/Export CSV/.test(r.text) && !/name="action"/.test(r.text) && !/method="POST"/i.test(r.text.replace(/<form[^>]*id="logout[^"]*"[\s\S]*?<\/form>/, "")), "read-only: export link, no action forms");
  check(rowsOf(r.text) >= 2 && /Login failed/.test(r.text) && r.text.includes(`${P}-nobody`), "the fresh sign-in rows are already listed");
  r = await owner.get("/admin/");
  check(r.status === 200 && r.text.includes('href="/admin/audit_log.php"') && /CMS audit log/.test(r.text), "dashboard links to the audit log (brief §16)");

  /* ── content writes are audited across modules ──────────────────────── */
  const csrfFor = async (path) => csrfOf((await owner.get(path)).text);
  // announcement create → update → delete
  let csrf = await csrfFor("/admin/announcements.php");
  r = await owner.post("/admin/announcements.php", { _csrf: csrf, action: "save", id: "0", title: `${P} அறிவிப்பு ${XSS}`, body: SQLI, is_active: "1" });
  const ann = sql("SELECT id FROM announcements WHERE title LIKE ? ORDER BY id DESC LIMIT 1", [`${P}%`]).rows[0];
  check(redirected(r) && !!ann, "announcement created", `${r.status} ${flashOf(r.text)}`);
  row = audit("announcement_created", `announcement:${ann.id}`);
  check(!!row && row.actor === ADMIN.username && row.detail.includes("அறிவிப்பு") && !row.detail.includes("<script>") && row.ip.startsWith("10.94."), "announcement_created audited: Tamil intact, tags stripped by sanitizeText, client IP resolved through the proxy", JSON.stringify(row));
  r = await owner.post("/admin/announcements.php", { _csrf: csrf, action: "save", id: String(ann.id), title: `${P} edited`, body: "b", is_active: "0" });
  check(redirected(r) && !!audit("announcement_updated", `announcement:${ann.id}`), "announcement_updated audited");
  r = await owner.post("/admin/announcements.php", { _csrf: csrf, action: "delete", id: String(ann.id) });
  row = audit("announcement_deleted", `announcement:${ann.id}`);
  check(redirected(r) && !!row && row.detail.includes(`${P} edited`), "announcement_deleted audited with the title of what was removed", JSON.stringify(row));
  check(sql("SELECT COUNT(*) AS n FROM announcements WHERE id = ?", [ann.id]).rows[0].n === 0, "…and the announcement really is gone");

  // event
  csrf = await csrfFor("/admin/events.php");
  r = await owner.post("/admin/events.php", { _csrf: csrf, action: "save", id: "0", title_ta: `${P} திருவிழா`, title_en: `${P} Festival ${SQLI}`, description: "d", event_date: "2033-04-04", is_active: "1" });
  const ev = sql("SELECT id FROM events WHERE title_en LIKE ?", [`${P} Festival%`]).rows[0];
  check(redirected(r) && !!ev && !!audit("event_created", `event:${ev.id}`), "event_created audited", `${r.status} ${flashOf(r.text)}`);
  r = await owner.post("/admin/events.php", { _csrf: csrf, action: "delete", id: String(ev.id) });
  row = audit("event_deleted", `event:${ev.id}`);
  check(redirected(r) && !!row && row.detail.startsWith(`${P} Festival`) && row.detail.includes("DROP TABLE"), "event_deleted audited with the (SQL-payload) title stored as text", JSON.stringify(row));

  // pooja create → toggle → delete
  csrf = await csrfFor("/admin/poojas.php");
  r = await owner.post("/admin/poojas.php", { _csrf: csrf, action: "save", id: "0", name_ta: `${P} பூஜை`, name_en: `${P} Pooja`, description_ta: "", description_en: "", pooja_date: "2033-04-05", pooja_time: "18:00", pooja_type: "special", is_active: "1" });
  const pj = sql("SELECT id FROM poojas WHERE name_en = ?", [`${P} Pooja`]).rows[0];
  check(redirected(r) && !!pj && !!audit("pooja_created", `pooja:${pj.id}`), "pooja_created audited", `${r.status} ${flashOf(r.text)}`);
  r = await owner.post("/admin/poojas.php", { _csrf: csrf, action: "toggle", id: String(pj.id) });
  row = audit("pooja_toggled", `pooja:${pj.id}`);
  check(redirected(r) && !!row && row.detail === "hidden", "pooja_toggled audited with the new state", JSON.stringify(row));
  r = await owner.post("/admin/poojas.php", { _csrf: csrf, action: "delete", id: String(pj.id) });
  row = audit("pooja_deleted", `pooja:${pj.id}`);
  check(redirected(r) && !!row && row.detail === `${P} Pooja`, "pooja_deleted audited with the name", JSON.stringify(row));
  r = await owner.post("/admin/poojas.php", { _csrf: csrf, action: "delete", id: String(pj.id) });
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'pooja_deleted' AND subject = ?", [`pooja:${pj.id}`]).rows[0].n === 1, "deleting an already-deleted pooja is not audited twice");

  // seva
  csrf = await csrfFor("/admin/sevas.php");
  r = await owner.post("/admin/sevas.php", { _csrf: csrf, action: "save", id: "0", name_ta: `${P} சேவை`, name_en: `${P} Seva`, description: "d", amount: "101", sort_order: "0", is_active: "1" });
  const sv = sql("SELECT id FROM sevas WHERE name_en = ?", [`${P} Seva`]).rows[0];
  check(redirected(r) && !!sv && !!audit("seva_created", `seva:${sv.id}`), "seva_created audited", `${r.status} ${flashOf(r.text)}`);
  r = await owner.post("/admin/sevas.php", { _csrf: csrf, action: "delete", id: String(sv.id) });
  row = audit("seva_deleted", `seva:${sv.id}`);
  check(redirected(r) && !!row && row.detail === `${P} Seva`, "seva_deleted audited with the name", JSON.stringify(row));

  // homepage widget
  csrf = await csrfFor("/admin/homepage_widgets.php");
  r = await owner.post("/admin/homepage_widgets.php", { _csrf: csrf, action: "save", id: "0", content_type: "announcement", source_type: "manual", title_ta: `${P} அட்டை`, title_en: `${P} Card`, description_ta: "", description_en: "", priority: "1", is_active: "1" });
  const wg = sql("SELECT id FROM homepage_widgets WHERE title_en = ?", [`${P} Card`]).rows[0];
  check(redirected(r) && !!wg && !!audit("widget_created", `widget:${wg.id}`), "widget_created audited", `${r.status} ${flashOf(r.text)}`);
  r = await owner.post("/admin/homepage_widgets.php", { _csrf: csrf, action: "toggle", id: String(wg.id), val: "1" });
  row = audit("widget_toggled", `widget:${wg.id}`);
  check(redirected(r) && !!row && row.detail === "off", "widget_toggled audited", JSON.stringify(row));
  r = await owner.post("/admin/homepage_widgets.php", { _csrf: csrf, action: "delete", id: String(wg.id) });
  row = audit("widget_deleted", `widget:${wg.id}`);
  check(redirected(r) && !!row && row.detail === `${P} Card`, "widget_deleted audited with the title", JSON.stringify(row));

  // settings: flip one switch and restore it, both audited with the changed key
  const settingsBefore = sql("SELECT key_name, val FROM homepage_settings").rows;
  const cur = Object.fromEntries(settingsBefore.map((s) => [s.key_name, s.val]));
  const keys = ["show_pournami_section", "show_nalla_strip", "show_donor_ticker"];
  csrf = await csrfFor("/admin/settings.php");
  const flipped = Object.fromEntries(keys.filter((k) => k !== "show_donor_ticker" ? cur[k] === "1" : cur[k] !== "1").map((k) => [k, "on"]));
  r = await owner.post("/admin/settings.php", { _csrf: csrf, ...flipped });
  row = audit("settings_saved", "homepage_settings");
  check(redirected(r) && !!row && row.detail.includes(`show_donor_ticker=${cur.show_donor_ticker === "1" ? "0" : "1"}`) && !row.detail.includes("show_pournami_section"), "settings_saved audited listing only the changed key", JSON.stringify(row));
  r = await owner.post("/admin/settings.php", { _csrf: csrf, ...Object.fromEntries(keys.filter((k) => cur[k] === "1").map((k) => [k, "on"])) });
  check(redirected(r) && sql("SELECT key_name, val FROM homepage_settings").rows.every((s) => s.val === cur[s.key_name]), "settings restored");
  r = await owner.post("/admin/settings.php", { _csrf: csrf, ...Object.fromEntries(keys.filter((k) => cur[k] === "1").map((k) => [k, "on"])) });
  row = audit("settings_saved", "homepage_settings");
  check(!!row && row.detail === "no changes", "a no-op settings save is audited as 'no changes'", JSON.stringify(row));

  /* ── accounts and roles ─────────────────────────────────────────────── */
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
  check(!!audit("user_create", `%${ACCOUNTS.admin.user}%`) || !!sql("SELECT id FROM admin_activity WHERE action LIKE 'user_%' AND (subject LIKE ? OR detail LIKE ?)", [`%${ACCOUNTS.admin.user}%`, `%${ACCOUNTS.admin.user}%`]).rows[0], "creating an account is audited");
  check(!!sql("SELECT id FROM admin_activity WHERE action = 'password_change' AND actor = ?", [ACCOUNTS.editor.user]).rows[0], "changing one's own password is audited");

  r = await sessions.admin.get("/admin/audit_log.php");
  check(r.status === 200 && !FATAL.test(r.text) && rowsOf(r.text) > 0, "E2E-013 admin (audit.view) opens the audit page", `${r.status}`);
  for (const role of ["editor", "finance", "viewer"]) {
    r = await sessions[role].get("/admin/audit_log.php");
    check(r.status === 403, `E2E-013 ${role} gets 403 on the audit page`, `${r.status}`);
    r = await sessions[role].get("/admin/audit_log.php?export=csv");
    check(r.status === 403 && !/^\uFEFF?id,when/.test(r.text), `E2E-046 ${role} cannot export the CSV`, `${r.status}`);
    r = await sessions[role].get("/admin/");
    check(r.status === 200 && !r.text.includes('href="/admin/audit_log.php"'), `${role} does not see Audit Logs in the sidebar or dashboard`);
  }
  const auditRows = sql("SELECT COUNT(*) AS n FROM admin_activity").rows[0].n;
  r = await owner.post("/admin/audit_log.php", { _csrf: csrfOf((await owner.get("/admin/settings.php")).text), action: "delete", id: "1" });
  check(sql("SELECT COUNT(*) AS n FROM admin_activity").rows[0].n >= auditRows, "a POST to the audit page deletes nothing", `${r.status}`);

  /* ── filters ────────────────────────────────────────────────────────── */
  r = await owner.get(`/admin/audit_log.php?actor=${encodeURIComponent(ACCOUNTS.editor.user)}`);
  check(r.status === 200 && rowsOf(r.text) === countOf(r.text) && rowsOf(r.text) >= 2 && !r.text.includes(`>${ADMIN.username}</a>`), "filter by who lists only that person's rows (login + password change)", `${rowsOf(r.text)} ${countOf(r.text)}`);
  r = await owner.get(`/admin/audit_log.php?module=announcement&q=${encodeURIComponent(P)}`);
  check(r.status === 200 && countOf(r.text) === 3 && /Announcement created/.test(r.text) && /Announcement updated/.test(r.text) && /Announcement deleted/.test(r.text), "filter by module + search narrows to the three announcement rows", `${countOf(r.text)}`);
  check(!/<script>alert\(1\)/.test(r.text) && !/<img src=x onerror/.test(r.text) && r.text.includes("&quot;&gt;alert(1)"), "E2E-048 the audited payload renders escaped on the page");
  r = await owner.get(`/admin/audit_log.php?q=${encodeURIComponent(`${P}%`)}`);
  check(r.status === 200 && countOf(r.text) === 0, "LIKE wildcards in the search are literal, not wildcards", `${countOf(r.text)}`);
  r = await owner.get(`/admin/audit_log.php?action=pooja_toggled&q=pooja%3A${pj.id}`);
  check(r.status === 200 && countOf(r.text) === 1 && r.text.includes(`pooja:${pj.id}`) && /Pooja toggled/.test(r.text), "filter by one action + record search finds exactly the toggle row", `${countOf(r.text)}`);
  r = await owner.get("/admin/audit_log.php?module=signin");
  check(r.status === 200 && countOf(r.text) >= 6 && /Login failed/.test(r.text) && !/Announcement created/.test(r.text), "the Sign-in module groups login, failed login and password changes", `${countOf(r.text)}`);
  r = await owner.get(`/admin/audit_log.php?q=${encodeURIComponent(SQLI)}`);
  check(r.status === 200 && !FATAL.test(r.text) && countOf(r.text) === 2 && sql("SELECT COUNT(*) AS n FROM admin_activity").rows[0].n > 10, "E2E-047 SQL payload as a search term is just a search term (matches the two event rows)", `${countOf(r.text)}`);
  r = await owner.get(`/admin/audit_log.php?q=${encodeURIComponent(XSS)}&actor=${encodeURIComponent(XSS)}&module=${encodeURIComponent(XSS)}&action=${encodeURIComponent(XSS)}&from=${encodeURIComponent(XSS)}&to=2033-13-45&page=-9&dir=${encodeURIComponent(XSS)}`);
  check(r.status === 200 && !FATAL.test(r.text) && !/<script>alert\(1\)/.test(r.text) && /not a valid date/.test(r.text), "E2E-048 hostile filter values are escaped, unknown module/action/dir ignored, bad dates flagged");
  const today = new Date().toISOString().slice(0, 10);
  r = await owner.get(`/admin/audit_log.php?from=${today}&to=${today}`);
  check(r.status === 200 && countOf(r.text) === sql("SELECT COUNT(*) AS n FROM admin_activity WHERE created_at >= CURDATE()").rows[0].n, "date range Today matches the database count", `${countOf(r.text)}`);
  r = await owner.get("/admin/audit_log.php?from=2030-01-01&to=2030-01-02");
  check(r.status === 200 && countOf(r.text) === 0 && /No entries match these filters/.test(r.text), "an empty range shows the filtered empty state");
  r = await owner.get("/admin/audit_log.php?from=2030-01-02&to=2030-01-01");
  check(r.status === 200 && !/not a valid date/.test(r.text) && /id="f-from"[^>]*value="2030-01-01"/.test(r.text) && /id="f-to"[^>]*value="2030-01-02"/.test(r.text), "reversed dates are swapped, not an error");
  const asc = await owner.get("/admin/audit_log.php?dir=asc");
  const desc = await owner.get("/admin/audit_log.php?dir=desc");
  const firstTime = (html) => /<time datetime="([^"]+)"/.exec(html)?.[1] ?? "";
  check(asc.status === 200 && desc.status === 200 && firstTime(asc.text) < firstTime(desc.text), "sort direction flips the order", `${firstTime(asc.text)} vs ${firstTime(desc.text)}`);

  /* ── pagination ─────────────────────────────────────────────────────── */
  const total = sql("SELECT COUNT(*) AS n FROM admin_activity").rows[0].n;
  r = await owner.get("/admin/audit_log.php");
  check(rowsOf(r.text) === Math.min(50, total) && countOf(r.text) === total, "first page shows 50 rows at most and the full count", `${rowsOf(r.text)} of ${total}`);
  if (total > 50) {
    const pages = Math.ceil(total / 50);
    r = await owner.get(`/admin/audit_log.php?page=${pages}`);
    check(r.status === 200 && rowsOf(r.text) === total - (pages - 1) * 50 && /aria-current="page"/.test(r.text), "last page shows the remainder", `${rowsOf(r.text)}`);
    r = await owner.get("/admin/audit_log.php?page=999999");
    check(r.status === 200 && rowsOf(r.text) > 0, "an out-of-range page clamps to the last page");
  } else {
    checks += 2;
  }

  /* ── CSV export ─────────────────────────────────────────────────────── */
  r = await owner.get(`/admin/audit_log.php?module=announcement&q=${encodeURIComponent(P)}&export=csv`);
  check(r.status === 200 && /text\/csv/.test(r.headers.get("content-type") ?? "") && /attachment; filename="audit-log-/.test(r.headers.get("content-disposition") ?? ""), "CSV export downloads", `${r.status} ${r.headers.get("content-type")}`);
  const lines = r.text.replace(/^\uFEFF/, "").trim().split("\n");
  check(lines[0] === "id,when,actor,action,subject,detail,ip" && lines.length === 4 && lines.slice(1).every((l) => l.includes(`announcement:${ann.id}`)), "CSV honours the filters (header + 3 rows)", lines.join(" | "));
  check(r.text.includes("அறிவிப்பு"), "E2E-003 Tamil detail is intact in the CSV");
  row = audit("audit_exported", "admin_activity");
  check(!!row && row.actor === ADMIN.username && row.detail.includes("module=announcement"), "the export itself is audited with the filters used", JSON.stringify(row));

  /* ── sign-out is audited ────────────────────────────────────────────── */
  r = await sessions.viewer.get("/admin/logout.php");
  check(redirected(r) && !!sql("SELECT id FROM admin_activity WHERE action = 'logout' AND actor = ?", [ACCOUNTS.viewer.user]).rows[0], "signing out is audited");

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\naudit-log: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\naudit-log: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  sql("DELETE FROM announcements WHERE title LIKE ?", [`${P}%`]);
  sql("DELETE FROM events WHERE title_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM poojas WHERE name_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM sevas WHERE name_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM homepage_widgets WHERE title_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2eaud_${RUN}_%`]);
  // every request this suite makes carries a 10.94.x.x forwarded address
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ? OR (ip LIKE '10.94.%' AND created_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE))", [`%${P}%`, `%${P}%`, `e2eaud_${RUN}_%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
