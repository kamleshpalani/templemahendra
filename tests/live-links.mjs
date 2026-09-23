#!/usr/bin/env node
/**
 * tests/live-links.mjs — a live stream's pooja / event links, the sponsor
 * credit, the recording a hand-ended stream keeps, the Featured and Show on
 * homepage switches, and the public "unavailable video" flag (brief §12, §6,
 * §32; database/migrations/022_live_links.sql).
 *
 *   node tests/live-links.mjs
 *
 * Starts its own PHP server on 8093 (exit 2 when the port is taken) with the
 * YouTube simulator switched on (LIVE_ALLOW_SIMULATOR=1, mode simulator), so
 * the §32 case is driven by the simulator's own answers: a video id ending
 * 0404 is reported missing, one ending NOEM not embeddable. Every PHP child
 * gets the shell's LIVE_ / YOUTUBE_ / GOOGLE_ variables removed.
 *
 * What it proves:
 *   1. a stream created with pooja_id and event_id stores both; the public
 *      shape carries pooja {id, name_ta, name_en, date, time} and event {id,
 *      title_ta, title_en, date} with the Tamil names intact; the admin JSON
 *      API accepts, refuses (422 on a vanished pooja) and clears them;
 *   2. the sponsor credit: the pooja's consenting, active sponsor is named
 *      (family name over the private name, with the note) — never the phone,
 *      the email or the amount; a sponsor without consent, an inactive one
 *      and one who withdrew consent are never named;
 *   3. deleting the pooja or the event nulls the link (ON DELETE SET NULL) and
 *      the stream stays;
 *   4. End stream by hand keeps the broadcast's own video as the recording
 *      (archive on, YouTube, recording_url empty) and the archive lists it;
 *      not with the archive switch off, not for a custom provider, and never
 *      over a recording already set;
 *   5. is_featured lists a stream first among the upcoming (index and
 *      /upcoming) and first on its day of the schedule, while `next` stays
 *      the next in time; show_on_homepage = 0 removes a stream from the
 *      index's now / next while it stays in live / upcoming and the schedule;
 *   6. playback.unavailable / reason on a LIVE stream whose last check found
 *      the video missing or restricted, false otherwise and never on a
 *      SCHEDULED one.
 *
 * Creates streams titled "E2E-LIVE-links<run> …", poojas / events / sponsors
 * named the same, and removes them all at the end (and an earlier run's
 * leftovers at the start).
 */

import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const PORT = Number(process.env.LIVE_LINKS_PORT || 8093);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const PREFIX = `E2E-LIVE-links${RUN}`;
const SLUG = `e2e-live-links${RUN}`;
const CLEAN_PREFIX = "E2E-LIVE-links";
const ACTOR = "e2e-live-links";
const IP = { public: "10.84.0.170", admin: "10.84.0.171" };
const OVERLAY = { mode: "simulator", auto_starting: "1", auto_start: "1", auto_end: "1", complete_grace_seconds: "30" };
const WATCH = (id) => `https://www.youtube.com/watch?v=${id}`;

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).replace(/\s+/g, " ").slice(0, 700)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, 600) ?? String(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const istLocal = (offsetMinutes = 0) => new Date(Date.now() + 5.5 * 3600 * 1000 + offsetMinutes * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
const istDate = (offsetDays) => istLocal(offsetDays * 24 * 60).slice(0, 10);

/* ── PHP ───────────────────────────────────────────────────────────────── */
const STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i;
function phpCommand(args) {
  return /\.sh$/i.test(PHP_BIN) ? ["bash", [PHP_BIN, ...args]] : [PHP_BIN, args];
}
function phpEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return {
    ...env,
    TRUSTED_PROXIES: "127.0.0.1,::1", SITE_URL: BASE, CORS_ORIGIN: "*", ADMIN_USERNAME: "admin",
    LIVE_ALLOW_SIMULATOR: "1",
    LIVE_SETTINGS_OVERLAY: JSON.stringify(OVERLAY),
    LIVE_SYNC_ONLY_TITLE_PREFIX: CLEAN_PREFIX,
    ...extra,
  };
}
const phpNoise = [];
const notePhpNoise = (label, text) => {
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(text);
  if (m) phpNoise.push(`${label}: ${m[0]}`);
};
function fixture(command, args = {}) {
  const [cmd, argv] = phpCommand(["tests/support/live_fixtures.php", command, "-"]);
  const r = spawnSync(cmd, argv, { cwd: ROOT, input: JSON.stringify(args), encoding: "utf8", env: phpEnv(), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  notePhpNoise(`fixture ${command}`, `${r.stdout}\n${r.stderr}`);
  const last = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let json = null;
  try { json = JSON.parse(last); } catch { /* reported below */ }
  if (!json) throw new Error(`fixture ${command} printed no JSON (exit ${r.status}): ${(r.stdout ?? "").slice(0, 300)} ${(r.stderr ?? "").slice(0, 300)}`);
  if (json.error) throw new Error(`fixture ${command}: ${json.error}${json.fields ? " " + JSON.stringify(json.fields) : ""}`);
  return json;
}
const sql = (query, params = []) => fixture("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;
const row = (id) => one("SELECT * FROM live_streams WHERE id = ?", [id]);
let n = 0;
const mk = (label, over = {}) => {
  n += 1;
  const r = fixture("create-stream", { title_prefix: PREFIX, label, slug: `${SLUG}-${n}`, actor: ACTOR, status: "SCHEDULED", ...over });
  return { ...r, id: Number(r.id) };
};
const ytId = (suffix) => `E2EL${String(++n).padStart(3, "0")}${suffix}`.slice(-11); // 11 chars, ends in the simulator's scenario
const setStatus = (id, status) => fixture("set-status", { id, status, actor: ACTOR });
const sync = (ids) => fixture("sync", { ids, actor: ACTOR });
function cleanup() {
  const a = fixture("cleanup", { title_prefix: CLEAN_PREFIX, actors: [ACTOR], ips: Object.values(IP) });
  sql("DELETE FROM sponsors WHERE name LIKE ?", [`${CLEAN_PREFIX}%`]);
  sql("DELETE FROM poojas WHERE name_en LIKE ?", [`${CLEAN_PREFIX}%`]);
  sql("DELETE FROM events WHERE title_en LIKE ?", [`${CLEAN_PREFIX}%`]);
  return a;
}

/* ── Server and HTTP ───────────────────────────────────────────────────── */
function portInUse(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const sock = connect({ port, host });
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("error", () => done(false));
  });
}
let server = null;
async function startServer() {
  const [cmd, argv] = phpCommand(["-S", `127.0.0.1:${PORT}`, "-t", "backend", "backend/router.php"]);
  const hashCmd = phpCommand(["-r", "echo password_hash('Admin@Test123', PASSWORD_BCRYPT, ['cost' => 5]);"]);
  const hash = spawnSync(hashCmd[0], hashCmd[1], { cwd: ROOT, encoding: "utf8", env: phpEnv(), windowsHide: true }).stdout.trim();
  const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv({ ADMIN_PASS_HASH: hash }), windowsHide: true });
  server = { child, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/pulse`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
async function stopServer() {
  if (server && server.child.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else server.child.kill("SIGTERM");
  }
  for (let i = 0; i < 20 && (await portInUse(PORT)); i++) await sleep(250);
}
async function http(method, path, { ip = IP.public, cookie = "", json = undefined, headers = {} } = {}) {
  const h = { "X-Forwarded-For": ip, ...headers };
  if (cookie) h.cookie = cookie;
  if (json !== undefined) h["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined, redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, data };
}
const pub = (path) => http("GET", path);
const stream = async (slug) => (await pub(`/api/live-streams/${slug}`)).data?.stream ?? null;
/** One admin session: sign in through the login page, keep the cookie, fetch the CSRF token from the admin API. */
async function adminSession() {
  let cookie = "";
  const grab = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  const page = await fetch(`${BASE}/admin/login.php`, { headers: { "X-Forwarded-For": IP.admin }, redirect: "manual" });
  grab(page);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const login = await fetch(`${BASE}/admin/login.php`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "X-Forwarded-For": IP.admin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf, username: "admin", password: "Admin@Test123", next: "" }),
  });
  grab(login);
  if (login.status !== 302) throw new Error(`the admin could not sign in: ${login.status}`);
  const list = await http("GET", "/api/admin/live-streams", { ip: IP.admin, cookie });
  const token = list.data?.csrf ?? "";
  return { api: (method, path, json) => http(method, path, { ip: IP.admin, cookie, json, headers: { "X-CSRF-Token": token } }) };
}

/* ── Run ───────────────────────────────────────────────────────────────── */
console.log(`live-links — run ${RUN}, PHP ${PHP_BIN}`);
if (await portInUse(PORT)) {
  console.log(`✗ port ${PORT} is already in use; this suite needs it.`);
  process.exit(2);
}
const probe = fixture("probe", {});
if (!probe.tables) {
  console.log("✗ the live streaming tables are missing; apply migration 011 first");
  process.exit(1);
}
const linkColumns = Number(one("SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME IN ('pooja_id', 'event_id')")?.c ?? 0);
if (linkColumns !== 2) {
  console.log("✗ live_streams has no pooja_id / event_id; apply database/migrations/022_live_links.sql first");
  process.exit(1);
}
console.log(`  cleanup at start: ${JSON.stringify(cleanup())}`);
if (!(await startServer())) {
  console.log(`✗ the PHP server did not start on ${BASE}.\n${server?.log.slice(-600) ?? ""}`);
  await stopServer();
  process.exit(1);
}

const F = {};
const D = {};
try {
  /* ── 1. Links ────────────────────────────────────────────────────────── */
  section("1. a stream linked to a pooja and an event");
  const poojaName = `${PREFIX} Pournami pooja`;
  const poojaTa = `${PREFIX} பௌர்ணமி அபிஷேகம்`;
  const eventTitle = `${PREFIX} Aadi festival`;
  const eventTa = `${PREFIX} ஆடித் திருவிழா`;
  sql("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_time, pooja_type, is_active) VALUES (?, ?, ?, ?, 'pournami', 1)", [poojaTa, poojaName, istDate(3), "6:00 AM"]);
  D.pooja = Number(one("SELECT id FROM poojas WHERE name_en = ?", [poojaName])?.id ?? 0);
  sql("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?, ?, '', ?, 1)", [eventTa, eventTitle, istDate(3)]);
  D.event = Number(one("SELECT id FROM events WHERE title_en = ?", [eventTitle])?.id ?? 0);
  check(D.pooja > 0 && D.event > 0, "fixtures: a pooja and an event", `${D.pooja} ${D.event}`);
  F.linked = mk("Linked darshan", { status: "SCHEDULED", pooja_id: D.pooja, event_id: D.event, scheduled_start_local: `${istDate(3)} 06:00`, scheduled_end_local: `${istDate(3)} 07:00` });
  let r = row(F.linked.id);
  check(Number(r?.pooja_id) === D.pooja && Number(r?.event_id) === D.event, "create with pooja_id and event_id stores both links", `${r?.pooja_id} ${r?.event_id}`);
  let s = await stream(F.linked.slug);
  check(JSON.stringify(s?.pooja) === JSON.stringify({ id: D.pooja, name_ta: poojaTa, name_en: poojaName, date: istDate(3), time: "6:00 AM" }), "the public shape carries pooja {id, name_ta, name_en, date, time} with the Tamil name intact", show(s?.pooja));
  check(JSON.stringify(s?.event) === JSON.stringify({ id: D.event, title_ta: eventTa, title_en: eventTitle, date: istDate(3) }), "…and event {id, title_ta, title_en, date}", show(s?.event));
  check(s?.sponsor === null, "…and sponsor null while the pooja has no sponsor");
  r = await pub("/api/live-streams/upcoming?limit=50");
  const listed = (r.data?.streams ?? []).find((x) => x.id === F.linked.id);
  check(listed?.pooja?.id === D.pooja && listed?.event?.id === D.event, "the upcoming list carries the same pooja and event", show(listed?.pooja));
  F.plain = mk("Plain darshan", { status: "SCHEDULED", scheduled_start_local: `${istDate(4)} 06:00` });
  s = await stream(F.plain.slug);
  check(s?.pooja === null && s?.event === null && s?.sponsor === null, "an unlinked stream answers pooja, event and sponsor null");

  // The admin JSON API: accept, refuse a vanished pooja, clear.
  const admin = await adminSession();
  const body = { title_ta: `${PREFIX} நிர்வாக ஒளிபரப்பு`, title_en: `${PREFIX} Admin linked`, temple_id: String(probe.temple.id), provider: "youtube", provider_reference: "dQw4w9WgXcQ", status: "DRAFT", pooja_id: String(D.pooja), event_id: String(D.event) };
  r = await admin.api("POST", "/api/admin/live-streams", body);
  check(r.status === 201 && r.data?.stream?.pooja_id === D.pooja && r.data?.stream?.event_id === D.event && r.data?.stream?.pooja?.name_en === poojaName, "POST /api/admin/live-streams with pooja_id and event_id → 201 with both in the admin shape", `${r.status} ${r.text.slice(0, 200)}`);
  F.viaApi = { id: Number(r.data?.stream?.id ?? 0) };
  r = await admin.api("POST", "/api/admin/live-streams", { ...body, title_en: `${PREFIX} Admin bad pooja`, pooja_id: "999999999" });
  check(r.status === 422 && /no longer exists/.test(r.data?.fields?.pooja_id ?? ""), "a pooja that does not exist → 422 with a pooja_id field error", `${r.status} ${r.text.slice(0, 200)}`);
  r = await admin.api("POST", "/api/admin/live-streams", { ...body, title_en: `${PREFIX} Admin bad event`, event_id: "abc" });
  check(r.status === 422 && r.data?.fields?.event_id, "a non-numeric event_id → 422 with an event_id field error", `${r.status} ${r.text.slice(0, 200)}`);
  r = await admin.api("PUT", `/api/admin/live-streams/${F.viaApi.id}`, { pooja_id: "", event_id: "0" });
  check(r.status === 200 && r.data?.stream?.pooja_id === null && r.data?.stream?.event_id === null && r.data?.stream?.pooja === null, "PUT with pooja_id '' and event_id '0' clears both", `${r.status} ${r.text.slice(0, 200)}`);
  check(rows("SELECT id FROM live_streams WHERE title_en LIKE ?", [`${PREFIX} Admin bad%`]).length === 0, "the refused bodies created nothing");

  /* ── 2. The sponsor credit ───────────────────────────────────────────── */
  section("2. the sponsor credit (consent-gated, name and note only)");
  const family = `${PREFIX} Kandasamy family`;
  sql("INSERT INTO sponsors (name, family_name, phone, email, note, pooja_id, amount, payment_ref, payment_status, publish_consent, is_active) VALUES (?, ?, '9876543210', 'private-sponsor@example.test', 'In memory of our elders', ?, 5001, 'UPI-77', 'PAID', 1, 1)", [`${PREFIX} Kandasamy`, family, D.pooja]);
  sql("INSERT INTO sponsors (name, family_name, phone, email, note, pooja_id, amount, publish_consent, is_active) VALUES (?, NULL, '9000000000', 'quiet@example.test', 'Quiet note', ?, 2000, 0, 1)", [`${PREFIX} Quiet donor`, D.pooja]);
  r = await pub(`/api/live-streams/${F.linked.slug}`);
  s = r.data?.stream;
  check(JSON.stringify(s?.sponsor) === JSON.stringify({ name: family, note: "In memory of our elders" }), "sponsor {name, note}: the family name over the private name, with the note", show(s?.sponsor));
  check(!r.text.includes("9876543210") && !r.text.includes("private-sponsor@example.test") && !r.text.includes("UPI-77") && !/\b5001\b/.test(r.text) && !r.text.includes(`${PREFIX} Kandasamy"`), "never the phone, the email, the reference or the amount", r.text.slice(0, 300));
  check(!r.text.includes("Quiet donor") && !r.text.includes("Quiet note"), "a sponsor without consent is never named");
  sql("UPDATE sponsors SET publish_consent = 0 WHERE family_name = ?", [family]);
  s = await stream(F.linked.slug);
  check(s?.sponsor === null && s?.pooja?.id === D.pooja, "a sponsor who withdrew consent is no longer named (the pooja stays)", show(s?.sponsor));
  sql("UPDATE sponsors SET publish_consent = 1, is_active = 0 WHERE family_name = ?", [family]);
  s = await stream(F.linked.slug);
  check(s?.sponsor === null, "an inactive sponsor is not named even with consent");
  sql("UPDATE sponsors SET is_active = 1 WHERE family_name = ?", [family]);
  s = await stream(F.linked.slug);
  check(s?.sponsor?.name === family, "…and named again once active and consenting");
  sql("UPDATE sponsors SET family_name = NULL WHERE family_name = ?", [family]);
  s = await stream(F.linked.slug);
  check(s?.sponsor?.name === `${PREFIX} Kandasamy`, "without a family name the sponsor's own name is used (as the Poojas page does)", show(s?.sponsor));
  r = await pub("/api/live-streams/schedule?filter=all&limit=100");
  check((r.data?.streams ?? []).find((x) => x.id === F.linked.id)?.sponsor?.name === `${PREFIX} Kandasamy`, "the schedule items carry the credit too");

  /* ── 3. Deleting the pooja / the event ───────────────────────────────── */
  section("3. deleting the pooja or the event nulls the link");
  sql("DELETE FROM sponsors WHERE pooja_id = ?", [D.pooja]);
  sql("DELETE FROM poojas WHERE id = ?", [D.pooja]);
  r = row(F.linked.id);
  s = await stream(F.linked.slug);
  check(r !== null && r.pooja_id === null && Number(r.event_id) === D.event, "deleting the pooja sets pooja_id NULL and keeps the stream and its event", `${r?.pooja_id} ${r?.event_id}`);
  check(s?.pooja === null && s?.sponsor === null && s?.event?.id === D.event && s?.status === "SCHEDULED", "…and the public shape answers pooja and sponsor null, event intact", show([s?.pooja, s?.sponsor, s?.event]));
  sql("DELETE FROM events WHERE id = ?", [D.event]);
  s = await stream(F.linked.slug);
  check(s !== null && s.event === null && row(F.linked.id)?.event_id === null, "deleting the event sets event_id NULL and the stream stays public", show(s?.event));

  /* ── 4. The recording after a hand end ───────────────────────────────── */
  section("4. End stream by hand keeps the video as the recording (brief §12)");
  const vid = ytId("LIVE");
  F.ended = mk("Ended by hand", { status: "LIVE", provider_reference: vid, event_type: "discourse", scheduled_start_local: istLocal(-60), scheduled_end_local: istLocal(30) });
  check(row(F.ended.id)?.recording_url === null && row(F.ended.id)?.status === "LIVE", "a live stream has no recording yet");
  const end = setStatus(F.ended.id, "COMPLETED");
  r = row(F.ended.id);
  check(end.changed && r?.status === "COMPLETED" && r?.recording_url === WATCH(vid) && r?.actual_end_at !== null, "End stream → COMPLETED with recording_url = the broadcast's own watch URL in the same write", `${r?.status} ${r?.recording_url}`);
  s = await stream(F.ended.slug);
  check(s?.playback?.kind === "iframe" && s?.playback?.embedUrl?.includes(vid) && s?.playback?.watchUrl === WATCH(vid), "…the completed player plays the recording", show(s?.playback));
  const month = istDate(0).slice(0, 7);
  r = await pub(`/api/live-streams/archive?event_type=discourse&month=${month}`);
  check((r.data?.streams ?? []).some((x) => x.id === F.ended.id), "…and /live-darshan/archive lists it", show((r.data?.streams ?? []).map((x) => x.id)));
  check(rows("SELECT action, detail FROM admin_activity WHERE subject = ? AND action = 'live_stream_status' ORDER BY id DESC LIMIT 1", [`Stream #${F.ended.id}`])[0]?.detail?.startsWith("LIVE → COMPLETED"), "the status change is audited as before");
  F.noArchive = mk("Ended unarchived", { status: "LIVE", provider_reference: ytId("LIVE"), archive_enabled: 0, scheduled_start_local: istLocal(-60) });
  setStatus(F.noArchive.id, "COMPLETED");
  check(row(F.noArchive.id)?.recording_url === null, "not with the archive switch off");
  F.custom = mk("Ended custom", { status: "LIVE", provider: "custom", provider_reference: "my ref", playback_url: "https://cdn.example/live.m3u8", scheduled_start_local: istLocal(-60) });
  setStatus(F.custom.id, "COMPLETED");
  check(row(F.custom.id)?.recording_url === null, "not for a custom provider");
  F.preset = mk("Ended with a recording", { status: "LIVE", provider_reference: ytId("LIVE"), scheduled_start_local: istLocal(-60) });
  sql("UPDATE live_streams SET recording_url = ? WHERE id = ?", [WATCH("ZYXWVUTSRQP"), F.preset.id]);
  setStatus(F.preset.id, "COMPLETED");
  check(row(F.preset.id)?.recording_url === WATCH("ZYXWVUTSRQP"), "a recording already set is never overwritten");

  /* ── 5. Featured and Show on homepage ────────────────────────────────── */
  section("5. is_featured orders first; show_on_homepage = 0 leaves now / next");
  const dayA = istDate(1);
  const dayB = istDate(2);
  F.a = mk("Plain tomorrow", { status: "SCHEDULED", scheduled_start_local: `${dayA} 18:00`, show_on_homepage: 1 });
  F.c = mk("Plain day after early", { status: "SCHEDULED", scheduled_start_local: `${dayB} 05:00`, show_on_homepage: 1 });
  F.b = mk("Featured day after", { status: "SCHEDULED", is_featured: 1, scheduled_start_local: `${dayB} 06:00`, show_on_homepage: 1 });
  const mine = [F.a.id, F.b.id, F.c.id, F.linked.id, F.plain.id];
  const order = (list) => (list ?? []).map((x) => x.id).filter((id) => mine.includes(id));
  r = await pub("/api/live-streams/upcoming?limit=50");
  check(order(r.data?.streams)[0] === F.b.id && order(r.data?.streams).indexOf(F.a.id) < order(r.data?.streams).indexOf(F.c.id), "/upcoming lists the featured stream first, the rest soonest first", show(order(r.data?.streams)));
  check((r.data?.streams ?? []).find((x) => x.id === F.b.id)?.flags?.featured === true, "…and its flags.featured is true");
  r = await pub("/api/live-streams");
  check(order(r.data?.upcoming)[0] === F.b.id, "the index's upcoming list does the same", show(order(r.data?.upcoming)));
  check(r.data?.next?.id === F.a.id, "next stays the next in time, not the featured one", show([r.data?.next?.id, F.a.id]));
  r = await pub("/api/live-streams/schedule?filter=all&limit=100");
  const sched = order(r.data?.streams);
  check(sched.indexOf(F.a.id) < sched.indexOf(F.b.id) && sched.indexOf(F.b.id) < sched.indexOf(F.c.id), "the schedule keeps the day order and lists the featured stream first on its day", show(sched));

  F.homeOff = mk("Live, homepage off", { status: "LIVE", provider_reference: ytId("LIVE"), scheduled_start_local: istLocal(-30) });
  r = await pub("/api/live-streams");
  check(r.data?.now === null && (r.data?.live ?? []).some((x) => x.id === F.homeOff.id), "a LIVE stream with show_on_homepage = 0 is in live[] but now is null", show([r.data?.now?.id, (r.data?.live ?? []).map((x) => x.id)]));
  r = await pub("/api/live-streams/schedule?filter=today&limit=100");
  check((r.data?.streams ?? []).some((x) => x.id === F.homeOff.id), "…and it is on today's schedule");
  sql("UPDATE live_streams SET show_on_homepage = 1 WHERE id = ?", [F.homeOff.id]);
  r = await pub("/api/live-streams");
  check(r.data?.now?.id === F.homeOff.id && r.data?.now?.day_bucket === "today", "with the switch on it is now", show(r.data?.now?.id));
  sql("UPDATE live_streams SET show_on_homepage = 0 WHERE id IN (?, ?, ?)", [F.a.id, F.b.id, F.c.id]);
  r = await pub("/api/live-streams");
  check(r.data?.next === null && order(r.data?.upcoming).length === 5, "with every upcoming switch off next is null while upcoming still lists them", show([r.data?.next, order(r.data?.upcoming)]));
  setStatus(F.homeOff.id, "COMPLETED");

  /* ── 6. §32: an unavailable video ────────────────────────────────────── */
  section("6. playback.unavailable from the simulator's answers (brief §32)");
  F.gone = mk("Video gone", { status: "LIVE", provider_reference: ytId("0404"), scheduled_start_local: istLocal(-20) });
  F.priv = mk("Video not embeddable", { status: "LIVE", provider_reference: ytId("NOEM"), scheduled_start_local: istLocal(-20) });
  F.fine = mk("Video fine", { status: "LIVE", provider_reference: ytId("LIVE"), scheduled_start_local: istLocal(-20) });
  s = await stream(F.gone.slug);
  check(s?.playback?.unavailable === false && s?.playback?.reason === null && s?.playback?.kind === "iframe", "before any check the flag is false", show(s?.playback));
  const run = sync([F.gone.id, F.priv.id, F.fine.id]);
  const outcomeOf = (id) => (run.items ?? []).find((i) => Number(i.id) === id)?.outcome;
  check(outcomeOf(F.gone.id) === "not_found" && outcomeOf(F.priv.id) === "restricted" && ["unchanged", "overridden", "live"].includes(outcomeOf(F.fine.id)), "the simulator reports the video missing, not embeddable and live", show(run.items));
  check(row(F.gone.id)?.sync_state === "missing" && row(F.priv.id)?.sync_state === "restricted" && row(F.gone.id)?.status === "LIVE", "…recorded in sync_state; the status is untouched (the poller never sets ERROR)", `${row(F.gone.id)?.sync_state} ${row(F.priv.id)?.sync_state}`);
  s = await stream(F.gone.slug);
  check(s?.playback?.unavailable === true && s?.playback?.reason === "missing" && s?.playback?.kind === "iframe" && s?.status === "LIVE", "a missing video: playback.unavailable true, reason missing", show(s?.playback));
  s = await stream(F.priv.slug);
  check(s?.playback?.unavailable === true && s?.playback?.reason === "restricted", "a private / non-embeddable video: reason restricted", show(s?.playback));
  s = await stream(F.fine.slug);
  check(s?.playback?.unavailable === false && s?.playback?.reason === null, "a video YouTube reports live: false", show(s?.playback));
  r = await pub("/api/live-streams/live");
  check((r.data?.streams ?? []).find((x) => x.id === F.gone.id)?.playback?.unavailable === true, "the live list carries the flag too");
  sql("UPDATE live_streams SET sync_state = 'missing' WHERE id = ?", [F.a.id]);
  s = await stream(F.a.slug);
  check(s?.playback?.unavailable === false, "a SCHEDULED stream is never marked unavailable (nothing is framed yet)");
  const back = sync([F.gone.id]);
  sql("UPDATE live_streams SET sync_state = NULL WHERE id = ?", [F.gone.id]);
  s = await stream(F.gone.slug);
  check(back.checked >= 1 && s?.playback?.unavailable === false, "once the check no longer says missing the flag clears", show(s?.playback));
  for (const id of [F.gone.id, F.priv.id, F.fine.id]) setStatus(id, "COMPLETED");

  section("7. hygiene");
  check(phpNoise.length === 0, "no PHP warnings, notices or fatals from the fixtures", phpNoise.slice(0, 3).join(" | "));
  check(!/(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):/.test(server.log), "no PHP warnings, notices or fatals from the server", /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(server.log)?.[0]);
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try {
    const removed = cleanup();
    console.log(`  cleanup at end: ${JSON.stringify(removed)}`);
    const left = one("SELECT (SELECT COUNT(*) FROM live_streams WHERE title_en LIKE ?) + (SELECT COUNT(*) FROM poojas WHERE name_en LIKE ?) + (SELECT COUNT(*) FROM events WHERE title_en LIKE ?) + (SELECT COUNT(*) FROM sponsors WHERE name LIKE ?) AS c", [`${CLEAN_PREFIX}%`, `${CLEAN_PREFIX}%`, `${CLEAN_PREFIX}%`, `${CLEAN_PREFIX}%`]);
    check(Number(left?.c) === 0, "every stream, pooja, event and sponsor this suite created is removed", `left ${left?.c}`);
  } catch (e) {
    check(false, "cleanup ran", e.stack || String(e));
  }
  await stopServer();
  check(!(await portInUse(PORT)), `port ${PORT} is closed again`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
