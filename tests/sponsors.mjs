#!/usr/bin/env node
/**
 * tests/sponsors.mjs — Sponsor management (brief §11) and publication consent
 * on every public sponsor outlet (E2E-009 / E2E-010).
 *
 *   migration 016: family_name, email, event_id, amount, payment_ref,
 *     payment_status, publish_consent (default 0), updated_at, indexes, FK
 *   admin page needs a session (E2E-045) and finance.edit: finance + editor
 *     200, viewer 403 (E2E-013/046); forged CSRF writes nothing (E2E-049)
 *   validation: email, amount, payment status, dangling pooja/event links
 *   create / edit / hide / consent toggle / delete with Tamil intact (E2E-003)
 *   public: /api/donors and /api/homepage_widgets (manual link, auto pooja,
 *     zero-widget fallback) show only active + consented sponsors, prefer the
 *     family name, and never carry phone / email / amount / payment fields
 *   SQL and script payloads are stored as data (E2E-047/048)
 *   bulk import: new columns map + validate; old 3-column files still work
 *   audit rows for create / update / toggle / consent / delete
 *
 *   node tests/sponsors.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment, migrations 015 + 016, and the admin account admin/Admin@Test123
 * (ADMIN_USERNAME / ADMIN_PASSWORD override). Everything it writes carries the
 * prefix "E2E-SPON-<run>" and is deleted in `finally`.
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
const P = `E2E-SPON-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE sponsors;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const PHONE = "9876501234";
const EMAIL = `spon-${RUN}@example.com`;
const ACCOUNTS = {
  editor:  { user: `e2espon_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2espon_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2espon_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.92.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };

function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
const one = (query, params = []) => sql(query, params).rows[0];

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
      const isForm = body instanceof FormData;
      const r = await fetch(base + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff(), ...(isForm ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...headers },
        body: isForm ? body : new URLSearchParams(body),
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
const findSponsor = (name) => one("SELECT * FROM sponsors WHERE name = ? ORDER BY id DESC LIMIT 1", [name]);
const audits = (action, id) => one("SELECT COUNT(*) AS n, MAX(detail) AS detail FROM admin_activity WHERE action = ? AND subject = ?", [action, `sponsor:${id}`]);
const PRIVATE = /"(phone|email|amount|payment_ref|payment_status|publish_consent|is_active|family_name)"/;
/* sponsor entries on the donor strip and on homepage cards, by sponsor name */
const donorSponsors = (json) => (json ?? []).filter((i) => i.type === "sponsor");
const widgetSponsors = (json) => (Array.isArray(json) ? json : (json?.widgets ?? [])).map((w) => w.sponsor).filter(Boolean);

const today = new Date();
const plus = (d) => new Date(today.getTime() + d * 86400000).toISOString().slice(0, 10);
const savedWidgets = [];

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
    try { ready = (await fetch(`${base}/api/donors`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── migration 016 ──────────────────────────────────────────────────── */
  const cols = sql("SELECT COLUMN_NAME AS c, COLUMN_TYPE AS t, COLUMN_DEFAULT AS d, IS_NULLABLE AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors'").rows;
  const col = (c) => cols.find((x) => x.c === c);
  check(col("family_name")?.t === "varchar(200)" && col("email")?.t === "varchar(190)" && col("event_id")?.t === "int unsigned" && col("amount")?.t === "decimal(12,2)" && col("payment_ref")?.t === "varchar(100)", "migration 016: family_name, email, event_id, amount, payment_ref columns", JSON.stringify(cols.map((c) => c.c)));
  check(/^enum\('PENDING','PAID','FAILED','REFUNDED','WAIVED'\)$/.test(col("payment_status")?.t ?? "") && col("payment_status").d === "PENDING", "migration 016: payment_status enum defaults to PENDING", col("payment_status")?.t);
  check(col("publish_consent")?.t === "tinyint(1)" && col("publish_consent").d === "0" && col("publish_consent").n === "NO", "migration 016: publish_consent defaults to 0 — existing sponsors are never published silently");
  check(!!col("updated_at"), "migration 016: updated_at column");
  const idx = sql("SELECT INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' GROUP BY INDEX_NAME").rows.map((r) => r.i);
  check(idx.includes("idx_sponsor_public") && idx.includes("idx_sponsor_event"), "migration 016: public and event indexes", idx.join(","));
  const fk = one("SELECT COUNT(*) AS n FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'sponsors' AND REFERENCED_TABLE_NAME = 'events' AND DELETE_RULE = 'SET NULL'");
  check(fk.n === 1, "migration 016: event FK with ON DELETE SET NULL");

  /* ── fixtures: a future pooja and an event ─────────────────────────── */
  sql("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_time, pooja_type, is_active) VALUES (?, ?, ?, '18:00', 'special', 1)", [`${P} சிறப்பு பூஜை`, `${P} Special Pooja`, plus(400)]);
  const pooja = one("SELECT * FROM poojas WHERE name_en = ?", [`${P} Special Pooja`]);
  sql("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?, ?, '', ?, 1)", [`${P} திருவிழா`, `${P} Festival`, plus(30)]);
  const event = one("SELECT * FROM events WHERE title_en = ?", [`${P} Festival`]);
  check(pooja?.id > 0 && event?.id > 0, "fixture pooja and event created");

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  let r = await anon.get("/admin/sponsors.php");
  check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 sponsors page redirects to sign-in", `${r.status}`);
  r = await anon.post("/admin/sponsors.php", { action: "save", name: `${P} anonymous`, publish_consent: "1", is_active: "1" });
  check(!findSponsor(`${P} anonymous`), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in ─────────────────────────────────────────────────── */
  const owner = jar();
  r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/sponsors.php");
  check(r.status === 200 && !FATAL.test(r.text), "sponsors page renders for the owner", `${r.status} ${r.text.match(FATAL)?.[0]}`);
  for (const f of ["name", "family_name", "phone", "email", "pooja_id", "event_id", "amount", "payment_status", "payment_ref", "publish_consent", "is_active", "note"]) {
    check(new RegExp(`name="${f}"`).test(r.text), `form has the ${f} field`);
  }
  check(r.text.includes(`${P} Special Pooja`) || r.text.includes(`${P} சிறப்பு பூஜை`), "pooja dropdown lists the fixture pooja");
  check(r.text.includes(`${P} Festival`) || r.text.includes(`${P} திருவிழா`), "event dropdown lists the fixture event");
  check(/status=published/.test(r.text) && /status=unpaid/.test(r.text), "list offers On website and Payment pending filters");
  let csrf = csrfOf(r.text);
  check(csrf.length >= 32, "CSRF token issued");
  const save = (fields, s = owner, token = csrf) => s.post("/admin/sponsors.php", { _csrf: token, action: "save", ...fields });
  const act = (action, id, s = owner, token = csrf) => s.post("/admin/sponsors.php", { _csrf: token, action, id: String(id) });

  /* ── E2E-049: CSRF ──────────────────────────────────────────────────── */
  const before = one("SELECT COUNT(*) AS n FROM sponsors").n;
  r = await save({ name: `${P} forged`, publish_consent: "1", is_active: "1" }, owner, "forged-" + csrf.slice(0, 20));
  check(r.status === 200 && /tampered with/.test(r.text), "E2E-049 forged token is refused with a message", `${r.status}`);
  r = await owner.post("/admin/sponsors.php", { action: "save", name: `${P} no token`, is_active: "1" });
  check(one("SELECT COUNT(*) AS n FROM sponsors").n === before, "E2E-049 forged and missing tokens wrote nothing");

  /* ── validation ─────────────────────────────────────────────────────── */
  r = await save({ name: "", family_name: `${P} nameless`, is_active: "1" });
  check(r.status === 200 && /required/i.test(r.text) && !one("SELECT id FROM sponsors WHERE family_name = ?", [`${P} nameless`]), "a sponsor without a name is refused");
  r = await save({ name: `${P} bad email`, email: "not-an-email", is_active: "1" });
  check(r.status === 200 && /email address does not look right/.test(r.text) && !findSponsor(`${P} bad email`), "an invalid email is refused");
  r = await save({ name: `${P} bad amount`, amount: "12abc", is_active: "1" });
  check(r.status === 200 && /Amount must be a number/.test(r.text) && !findSponsor(`${P} bad amount`), "a non-numeric amount is refused");
  r = await save({ name: `${P} negative`, amount: "-5", is_active: "1" });
  check(r.status === 200 && !findSponsor(`${P} negative`), "a negative amount is refused");
  r = await save({ name: `${P} bad pooja`, pooja_id: "99999999", is_active: "1" });
  check(r.status === 200 && /pooja no longer exists/.test(r.text) && !findSponsor(`${P} bad pooja`), "a dangling pooja link is refused");
  r = await save({ name: `${P} bad event`, event_id: "99999999", is_active: "1" });
  check(r.status === 200 && /event no longer exists/.test(r.text) && !findSponsor(`${P} bad event`), "a dangling event link is refused");
  r = await save({ name: `${P} bad status`, payment_status: "STOLEN", is_active: "1" });
  const badStatus = findSponsor(`${P} bad status`);
  check(redirected(r) && badStatus?.payment_status === "PENDING", "an unknown payment status falls back to PENDING", badStatus?.payment_status);

  /* ── create: full record, no consent ────────────────────────────────── */
  r = await save({
    name: `${P} முருகன்`, family_name: `${P} முருகன் குடும்பம்`, phone: PHONE, email: EMAIL,
    pooja_id: String(pooja.id), event_id: String(event.id), amount: "5,000.50", payment_status: "PAID", payment_ref: `UPI-${RUN}`,
    note: `${P} அன்னதானம்`, is_active: "1",
  });
  check(redirected(r), "created sponsor redirects to the list", `${r.status} ${flashOf(r.text)}`);
  const murugan = findSponsor(`${P} முருகன்`);
  check(murugan && murugan.family_name === `${P} முருகன் குடும்பம்` && murugan.note === `${P} அன்னதானம்`, "E2E-003 Tamil name, family name and note stored intact", JSON.stringify(murugan));
  check(murugan.phone === PHONE && murugan.email === EMAIL && murugan.amount === "5000.50" && murugan.payment_status === "PAID" && murugan.payment_ref === `UPI-${RUN}`, "contact, amount (comma stripped), payment status and reference stored", JSON.stringify(murugan));
  check(murugan.pooja_id === pooja.id && murugan.event_id === event.id, "pooja and event links stored");
  check(murugan.is_active === 1 && murugan.publish_consent === 0, "consent is off unless the box is ticked");
  let a = audits("sponsor_created", murugan.id);
  check(a.n === 1 && /no consent/.test(a.detail ?? ""), "creation is audited with the consent state", JSON.stringify(a));

  /* ── E2E-010: active without consent is hidden everywhere ──────────── */
  const widgetsBefore = one("SELECT COUNT(*) AS n FROM homepage_widgets WHERE is_active = 1").n;
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_sponsor_id, show_sponsor, priority, is_pinned, is_active) VALUES ('sponsor', ?, ?, 'manual', ?, 1, 999, 1, 1)", [`${P} ஸ்பான்சர் அட்டை`, `${P} Sponsor card`, murugan.id]);
  const manualWidget = one("SELECT id FROM homepage_widgets WHERE title_en = ?", [`${P} Sponsor card`]).id;
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_pooja_id, show_sponsor, priority, is_pinned, is_active) VALUES ('upcoming_pooja', ?, ?, 'calendar', ?, 1, 998, 1, 1)", [`${P} பூஜை அட்டை`, `${P} Pooja card`, pooja.id]);
  const poojaWidget = one("SELECT id FROM homepage_widgets WHERE title_en = ?", [`${P} Pooja card`]).id;
  savedWidgets.push(manualWidget, poojaWidget);

  r = await api("/api/donors");
  check(r.status === 200 && Array.isArray(r.json), "GET /api/donors answers a list", `${r.status}`);
  check(!r.text.includes(P), "E2E-010 /api/donors omits an active sponsor without consent");
  r = await api("/api/homepage_widgets");
  check(r.status === 200 && r.json, "GET /api/homepage_widgets answers", `${r.status}`);
  const manualCard = (Array.isArray(r.json) ? r.json : r.json.widgets ?? []).find((w) => w.id === manualWidget);
  const poojaCard = (Array.isArray(r.json) ? r.json : r.json.widgets ?? []).find((w) => w.id === poojaWidget);
  check(manualCard && !manualCard.sponsor, "E2E-010 manually linked sponsor card carries no sponsor without consent", JSON.stringify(manualCard?.sponsor));
  check(poojaCard && !poojaCard.sponsor, "E2E-010 pooja card carries no sponsor without consent", JSON.stringify(poojaCard?.sponsor));

  /* ── consent toggle → E2E-009: published, family name, nothing private ─ */
  r = await act("consent", murugan.id);
  check(redirected(r) && one("SELECT publish_consent FROM sponsors WHERE id = ?", [murugan.id]).publish_consent === 1, "consent action grants consent");
  a = audits("sponsor_consent", murugan.id);
  check(a.n === 1 && a.detail === "granted", "consent grant is audited");
  r = await api("/api/donors");
  let mine = donorSponsors(r.json).filter((i) => i.name.startsWith(P));
  check(mine.length === 1 && mine[0].name === `${P} முருகன் குடும்பம்`, "E2E-009 /api/donors shows the sponsor under the family name", JSON.stringify(mine));
  check(mine[0].label === `${P} அன்னதானம்` && mine[0].pooja?.ta === `${P} சிறப்பு பூஜை`, "E2E-009 note and pooja names are the public payload");
  check(!PRIVATE.test(JSON.stringify(mine)) && !r.text.includes(PHONE) && !r.text.includes(EMAIL) && !r.text.includes("5000.5") && !r.text.includes(`UPI-${RUN}`), "phone, email, amount, reference and status never reach /api/donors");
  r = await api("/api/homepage_widgets");
  let cards = Array.isArray(r.json) ? r.json : r.json.widgets ?? [];
  let m = cards.find((w) => w.id === manualWidget);
  check(m?.sponsor?.name === `${P} முருகன் குடும்பம்` && m.sponsor.note === `${P} அன்னதானம்`, "E2E-009 manually linked card shows the family name", JSON.stringify(m?.sponsor));
  check(!PRIVATE.test(JSON.stringify(cards.map((w) => w.sponsor))) && !r.text.includes(PHONE) && !r.text.includes(EMAIL) && !r.text.includes(`UPI-${RUN}`), "no private sponsor fields on homepage cards");
  check(Object.keys(m.sponsor).sort().join(",") === "name,note", "homepage sponsor object is exactly {name, note}", Object.keys(m.sponsor).join(","));

  /* ── inactive with consent is hidden ────────────────────────────────── */
  r = await act("toggle", murugan.id);
  check(redirected(r) && one("SELECT is_active FROM sponsors WHERE id = ?", [murugan.id]).is_active === 0, "toggle hides the sponsor");
  a = audits("sponsor_toggled", murugan.id);
  check(a.n === 1 && a.detail === "hidden", "hide is audited");
  r = await api("/api/donors");
  check(!r.text.includes(P), "E2E-010 hidden sponsor with consent leaves /api/donors");
  r = await api("/api/homepage_widgets");
  cards = Array.isArray(r.json) ? r.json : r.json.widgets ?? [];
  check(!cards.find((w) => w.id === manualWidget)?.sponsor && !cards.find((w) => w.id === poojaWidget)?.sponsor, "E2E-010 hidden sponsor with consent leaves the homepage cards");
  r = await owner.get("/admin/sponsors.php?status=hidden");
  check(r.text.includes(`${P} முருகன்`), "Hidden filter lists it");
  r = await owner.get("/admin/sponsors.php?status=published");
  check(!r.text.includes(`${P} முருகன்`), "On website filter omits a hidden sponsor");
  await act("toggle", murugan.id);
  check(one("SELECT is_active FROM sponsors WHERE id = ?", [murugan.id]).is_active === 1, "toggle shows it again");
  r = await owner.get("/admin/sponsors.php?status=published");
  check(r.text.includes(`${P} முருகன்`), "On website filter lists an active, consented sponsor");

  /* ── family name empty → sponsor name is shown ──────────────────────── */
  r = await save({ id: String(murugan.id), name: `${P} முருகன்`, family_name: "", phone: PHONE, email: EMAIL, pooja_id: String(pooja.id), event_id: String(event.id), amount: "5000.50", payment_status: "PENDING", payment_ref: `UPI-${RUN}`, note: `${P} அன்னதானம்`, publish_consent: "1", is_active: "1" });
  const edited = one("SELECT * FROM sponsors WHERE id = ?", [murugan.id]);
  check(redirected(r) && edited.family_name === null && edited.payment_status === "PENDING" && edited.publish_consent === 1, "edit clears the family name, changes payment status and keeps consent", JSON.stringify(edited));
  check(edited.updated_at >= edited.created_at, "updated_at is maintained");
  a = audits("sponsor_updated", murugan.id);
  check(a.n === 1, "edit is audited");
  r = await api("/api/donors");
  mine = donorSponsors(r.json).filter((i) => i.name.startsWith(P));
  check(mine.length === 1 && mine[0].name === `${P} முருகன்`, "without a family name the sponsor name is shown", JSON.stringify(mine));
  r = await owner.get("/admin/sponsors.php?status=unpaid");
  check(r.text.includes(`${P} முருகன்`), "Payment pending filter lists it");
  r = await owner.get(`/admin/sponsors.php?edit=${murugan.id}`);
  check(r.status === 200 && r.text.includes(`value="${P} முருகன்"`) && r.text.includes(`value="${EMAIL}"`) && /value="PENDING"\s+selected/.test(r.text) && /name="publish_consent" value="1" checked/.test(r.text), "edit form is pre-filled including email, status and consent");
  r = await owner.get(`/admin/sponsors.php?q=${encodeURIComponent(`UPI-${RUN}`)}`);
  check(r.text.includes(`${P} முருகன்`), "search matches the payment reference");
  r = await owner.get(`/admin/sponsors.php?q=${encodeURIComponent(EMAIL)}`);
  check(r.text.includes(`${P} முருகன்`), "search matches the email");

  /* ── consent withdrawn ──────────────────────────────────────────────── */
  r = await act("consent", murugan.id);
  check(one("SELECT publish_consent FROM sponsors WHERE id = ?", [murugan.id]).publish_consent === 0 && audits("sponsor_consent", murugan.id).n === 2, "consent can be withdrawn and is audited");
  r = await api("/api/donors");
  check(!r.text.includes(P), "E2E-010 withdrawn consent removes the sponsor from /api/donors");

  /* ── zero-widget fallback honours consent ───────────────────────────── */
  const parkedWidgets = sql("SELECT id FROM homepage_widgets WHERE is_active = 1").rows.map((w) => w.id);
  const parkedPoojas = sql("SELECT id FROM poojas WHERE is_active = 1 AND id <> ? AND pooja_date >= CURDATE()", [pooja.id]).rows.map((w) => w.id);
  const park = (table, ids, state) => { for (const id of ids) sql(`UPDATE ${table} SET is_active = ? WHERE id = ?`, [state, id]); };
  park("homepage_widgets", parkedWidgets, 0);
  park("poojas", parkedPoojas, 0);
  sql("UPDATE poojas SET pooja_date = ? WHERE id = ?", [plus(1), pooja.id]);
  r = await api("/api/homepage_widgets");
  cards = Array.isArray(r.json) ? r.json : r.json.widgets ?? [];
  check(cards.length >= 1 && cards[0].pooja?.id === pooja.id && !cards[0].sponsor, "zero-widget fallback picks the fixture pooja but no unconsented sponsor", JSON.stringify(cards[0]));
  sql("UPDATE sponsors SET publish_consent = 1 WHERE id = ?", [murugan.id]);
  r = await api("/api/homepage_widgets");
  cards = Array.isArray(r.json) ? r.json : r.json.widgets ?? [];
  check(cards[0]?.sponsor?.name === `${P} முருகன்` && !PRIVATE.test(JSON.stringify(cards[0].sponsor)), "zero-widget fallback attaches the consented sponsor by name only", JSON.stringify(cards[0]?.sponsor));
  park("poojas", parkedPoojas, 1);
  park("homepage_widgets", parkedWidgets.filter((id) => id !== manualWidget && id !== poojaWidget), 1);
  check(one("SELECT COUNT(*) AS n FROM homepage_widgets WHERE is_active = 1").n === widgetsBefore, "pre-existing widgets restored");

  /* ── E2E-047/048: hostile payloads are data ─────────────────────────── */
  r = await save({ name: SQLI, family_name: XSS, note: XSS, payment_ref: SQLI.slice(0, 100), publish_consent: "1", is_active: "1" });
  check(redirected(r), "hostile payloads are accepted as text", `${r.status} ${flashOf(r.text)}`);
  const hostile = findSponsor(SQLI);
  check(hostile && hostile.name === SQLI && !/<script|onerror/.test(hostile.family_name) && hostile.family_name.startsWith(P), "E2E-047 SQL payload stored verbatim (table still exists); tags stripped on save", JSON.stringify(hostile));
  r = await owner.get("/admin/sponsors.php");
  check(!r.text.includes("<script>alert(1)</script>") && !r.text.includes("onerror=alert(2)>") && r.text.includes("&#039;); DROP TABLE"), "E2E-048 admin list escapes the payload");
  r = await api("/api/donors");
  check(r.json.some((i) => i.name === hostile.family_name) && !/<script/.test(r.text), "E2E-048 public feed carries the stored text as JSON; no script tag");
  r = await owner.get("/admin/sponsors.php?q=" + encodeURIComponent(SQLI));
  check(r.status === 200 && !FATAL.test(r.text) && r.text.includes("DROP TABLE"), "E2E-047 SQL payload in the search box is harmless");

  /* ── delete ─────────────────────────────────────────────────────────── */
  r = await act("delete", hostile.id);
  check(redirected(r) && !one("SELECT id FROM sponsors WHERE id = ?", [hostile.id]) && audits("sponsor_deleted", hostile.id).n === 1, "delete removes the row and is audited");
  /* deleting the linked event nulls the link rather than deleting the sponsor */
  sql("DELETE FROM events WHERE id = ?", [event.id]);
  check(one("SELECT event_id FROM sponsors WHERE id = ?", [murugan.id])?.event_id === null, "deleting an event keeps the sponsor and clears the link (ON DELETE SET NULL)");

  /* ── bulk import ────────────────────────────────────────────────────── */
  async function importCsv(label, body, wanted) {
    let html = (await owner.get("/admin/bulk_upload.php?entity=sponsors")).text;
    const fd = new FormData();
    fd.set("_csrf", csrfOf(html)); fd.set("entity", "sponsors"); fd.set("action", "upload");
    fd.set("csv", new Blob([body], { type: "text/csv" }), `${label}.csv`);
    r = await owner.post("/admin/bulk_upload.php", fd);
    html = redirected(r) ? (await owner.get("/admin/bulk_upload.php?entity=sponsors")).text : r.text;
    const selects = [...html.matchAll(/<select[^>]*name="map\[(\d+)\][^>]*>([\s\S]*?)<\/select>/g)];
    const mapping = {};
    const auto = [];
    selects.forEach(([, i, opts], n) => {
      auto.push(/<option value="([^"]*)"[^>]*selected/.exec(opts)?.[1] ?? "");
      if (wanted[n] && opts.includes(`value="${wanted[n]}"`)) mapping[`map[${i}]`] = wanted[n];
    });
    r = await owner.post("/admin/bulk_upload.php", { _csrf: csrfOf(html), entity: "sponsors", action: "map", ...mapping });
    html = r.status >= 300 ? (await owner.get("/admin/bulk_upload.php?entity=sponsors")).text : r.text;
    const preview = html;
    r = await owner.post("/admin/bulk_upload.php", { _csrf: csrfOf(html), entity: "sponsors", action: "confirm", skip_duplicates: "1" });
    html = r.status >= 300 ? (await owner.get("/admin/bulk_upload.php?entity=sponsors")).text : r.text;
    const total = Number(/data-total="(\d+)"/.exec(html)?.[1] ?? 0);
    const token = /data-csrf="([^"]+)"/.exec(html)?.[1] ?? csrfOf(html);
    let offset = 0, imported = 0, guard = 0;
    while (offset < total && guard++ < 10) {
      const res = await owner.post("/admin/bulk_upload.php", { _csrf: token, entity: "sponsors", action: "import_chunk", offset: String(offset), limit: "100", skip_duplicates: "1" });
      const j = JSON.parse(res.text);
      assert.ok(!j.error, j.error);
      imported += Number(j.ok || 0); offset += Number(j.processed || 0) || total;
    }
    const done = (await owner.get("/admin/bulk_upload.php?entity=sponsors&done=1")).text;
    check(/Import complete|Imported/i.test(done), `${label} import: results page renders`);
    return { auto, preview, total, imported };
  }
  let imp = await importCsv("new", `Sponsor Name,Family,Mobile,Email,Amount,Payment,Reference,Consent,Remark,Active\n${P} Bulk One,${P} Bulk One & Family,9000000001,bulk1-${RUN}@example.com,2500,paid,TXN-${RUN}-1,yes,Annadanam,yes\n${P} Bulk Two,,9000000002,,1000,,,no,Lamp,yes\n${P} Bulk Bad,,9000000003,not-an-email,abc,LOST,,maybe,Bad row,yes\n`,
    ["name", "family_name", "phone", "email", "amount", "payment_status", "payment_ref", "publish_consent", "note", "is_active"]);
  check(imp.auto.join(",") === "name,family_name,phone,email,amount,payment_status,payment_ref,publish_consent,note,is_active", "bulk import auto-maps the new headers", imp.auto.join(","));
  check(/must be an email address/.test(imp.preview) && /number of rupees/.test(imp.preview) && /PENDING, PAID, FAILED/.test(imp.preview), "bulk import preview flags bad email, amount and payment status", imp.preview.match(/import-summary[\s\S]{0,400}/)?.[0]?.replace(/<[^>]+>/g, " "));
  check(imp.total === 3 && imp.imported === 2, "bulk import writes the two valid rows and skips the invalid one", `${imp.imported}/${imp.total}`);
  const b1 = findSponsor(`${P} Bulk One`);
  const b2 = findSponsor(`${P} Bulk Two`);
  check(b1 && b1.family_name === `${P} Bulk One & Family` && b1.email === `bulk1-${RUN}@example.com` && b1.amount === "2500.00" && b1.payment_status === "PAID" && b1.payment_ref === `TXN-${RUN}-1` && b1.publish_consent === 1, "imported row carries every new field (status upper-cased)", JSON.stringify(b1));
  check(b2 && b2.family_name === null && b2.email === null && b2.amount === "1000.00" && b2.payment_status === "PENDING" && b2.publish_consent === 0, "blank import cells become NULL / PENDING / no consent", JSON.stringify(b2));
  check(!findSponsor(`${P} Bulk Bad`), "the invalid row was not imported");
  imp = await importCsv("legacy", `\uFEFFSponsor Name,Mobile Number,Remark\n${P} Legacy,9000000009,Flower sponsor\n`, ["name", "phone", "note"]);
  const legacyRow = findSponsor(`${P} Legacy`);
  check(imp.imported === 1 && legacyRow && legacyRow.publish_consent === 0 && legacyRow.payment_status === "PENDING" && legacyRow.amount === null, "an old 3-column file still imports, unpublished and pending", `${imp.imported}/${imp.total} auto=${imp.auto} ${JSON.stringify(legacyRow)} ${imp.preview.match(/import-summary[\s\S]{0,600}/)?.[0]?.replace(/<[^>]+>/g, " ")}`);
  r = await api("/api/donors");
  mine = donorSponsors(r.json).filter((i) => i.name.startsWith(P)).map((i) => i.name);
  check(mine.includes(`${P} Bulk One & Family`) && !mine.includes(`${P} Bulk Two`) && !mine.includes(`${P} Legacy`), "only the consented import appears publicly, by family name", mine.join(" | "));

  /* ── E2E-013/046: roles ─────────────────────────────────────────────── */
  const usersHtml = (await owner.get("/admin/users.php")).text;
  const sessions = {};
  for (const [role, acc] of Object.entries(ACCOUNTS)) {
    r = await owner.post("/admin/users.php", { _csrf: csrfOf(usersHtml), action: "save", id: "0", username: acc.user, display_name: `${P} ${role}`, email: "", phone: "", role, password: acc.issued, is_active: "1" });
    check(redirected(r), `owner creates a ${role} account`, `${r.status} ${flashOf(r.text)}`);
    const s = jar();
    await s.login(acc.user, acc.issued);
    const prof = (await s.get("/admin/profile.php")).text;
    await s.post("/admin/profile.php", { _csrf: csrfOf(prof), action: "password", current_password: acc.issued, new_password: acc.pw, confirm_password: acc.pw });
    sessions[role] = s;
  }
  for (const role of ["finance", "editor"]) {
    r = await sessions[role].get("/admin/sponsors.php");
    check(r.status === 200 && r.text.includes(`${P} முருகன்`), `E2E-013 ${role} (finance.edit) opens the Sponsors page`, `${r.status}`);
  }
  const finCsrf = csrfOf((await sessions.finance.get("/admin/sponsors.php")).text);
  r = await save({ name: `${P} by finance`, amount: "101", payment_status: "WAIVED", is_active: "1" }, sessions.finance, finCsrf);
  const byFinance = findSponsor(`${P} by finance`);
  check(redirected(r) && byFinance?.payment_status === "WAIVED", "E2E-013 finance can create a sponsor");
  r = await sessions.viewer.get("/admin/sponsors.php");
  check(r.status === 403, "E2E-013 viewer gets 403 on the Sponsors page", `${r.status}`);
  r = await sessions.viewer.post("/admin/sponsors.php", { _csrf: "x", action: "consent", id: String(byFinance.id) });
  check(r.status === 403 && one("SELECT publish_consent FROM sponsors WHERE id = ?", [byFinance.id]).publish_consent === 0, "E2E-046 viewer POST is refused server-side; consent unchanged", `${r.status}`);
  r = await sessions.viewer.get("/admin/bulk_upload.php?entity=sponsors");
  check(r.status === 403, "E2E-046 viewer cannot open the sponsor import", `${r.status}`);

  /* ── homepage widget editor flags unconsented sponsors ──────────────── */
  r = await owner.get("/admin/homepage_widgets.php");
  check(r.status === 200 && new RegExp(`${P} by finance \\(no publish consent\\)`).test(r.text), "widget editor marks a sponsor without consent", `${r.status}`);

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\nsponsors: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\nsponsors: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  try {
    sql("DELETE FROM homepage_widgets WHERE title_en LIKE ?", [`${P}%`]);
    sql("DELETE FROM sponsors WHERE name LIKE ? OR family_name LIKE ?", [`${P}%`, `${P}%`]);
    sql("DELETE FROM events WHERE title_en LIKE ?", [`${P}%`]);
    sql("DELETE FROM poojas WHERE name_en LIKE ?", [`${P}%`]);
    sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2espon_${RUN}_%`]);
    sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ?", [`%${P}%`, `%${P}%`, `e2espon_${RUN}_%`]);
  } catch (e) { console.error(e.message); }
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
