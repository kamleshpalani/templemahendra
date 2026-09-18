#!/usr/bin/env node
/**
 * tests/admin-live.mjs — Admin → Live Streaming (docs/live/SPEC-PHASE1.md §4.5,
 * §6 "admin-live"), end to end against the real PHP + MySQL stack and a real
 * browser.
 *
 *   PHP_BIN=/path/to/php.sh node tests/admin-live.mjs
 *
 * Starts its own PHP server on 8082 (exit 2 when the port is taken). Signs in as
 * the environment admin (admin / Admin@Test123, an owner) and as an editor and
 * a viewer it creates through admin/users.php and deletes at the end. Requests
 * carry X-Forwarded-For 10.84.0.100–159.
 *
 * What it proves:
 *   1. the page answers 200 without PHP notices (the list, the live chip, an
 *      unknown ?edit id) and the "tv" icon is in the sidebar;
 *   2. create through the form: the Tamil title round-trips exactly, every
 *      field and flag is stored, the list shows the row, the edit view reflects
 *      every value, and an update changes only the edited columns;
 *   3. the validation matrix (empty titles, a bad date, an end before the
 *      start, a bad time zone, a bad video id, a javascript: URL, a duplicate
 *      slug, an illegal status) re-renders at 200 with the typed values kept
 *      and changes nothing;
 *   4. the status buttons: Publish → SCHEDULED, Go live → LIVE with
 *      actual_start_at, End stream → COMPLETED with actual_end_at, Cancel;
 *      Delete sets deleted_at and Restore clears it;
 *   5. thumbnails: a real PNG is stored and served as image/png from
 *      /uploads/live-…png; a text file named .png, an oversize file and a .php
 *      file are refused and nothing is saved;
 *   6. filters, search, sort and pagination; hostile ?q= and ?edit= values;
 *   7. roles: a viewer reads but every POST is refused and nothing changes; an
 *      editor creates, publishes and deletes; a forged _csrf changes nothing;
 *   8. at 390 and 1440 px the list and the open form drawer have no horizontal
 *      overflow and no serious or critical axe violations.
 *
 * Creates streams titled "E2E-LIVE-adm<run> …" and removes them, their
 * admin_activity rows, their uploads, its two accounts and its rate-limit
 * buckets at the end (and any earlier run's leftovers at the start).
 */

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const PHP_PORT = Number(process.env.LIVE_ADMIN_PORT || 8082);
const BASE = `http://127.0.0.1:${PHP_PORT}`;
const PHP_BIN = process.env.PHP_BIN || "php";
const viaBash = /\.sh$/i.test(PHP_BIN);
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = `adm${Date.now().toString(36)}`;
const PREFIX = `E2E-LIVE-${RUN}`;
const CLEAN_PREFIX = "E2E-LIVE-adm";
const ADMIN_PREFIX = "e2e_livea_";
const EDITOR = `${ADMIN_PREFIX}editor`;
const VIEWER = `${ADMIN_PREFIX}viewer`;
const EDITOR_PW = "LiveEdit99Tk";
const VIEWER_PW = "LiveView42Qm";
const IP = { owner: "10.84.0.100", editor: "10.84.0.101", viewer: "10.84.0.102", browser: "10.84.0.103", hostile: "10.84.0.104" };
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace|SQLSTATE)/;
const PAGE = "/admin/live_streams.php";
const YT = "dQw4w9WgXcQ";
const XSS = '"><script>alert(1)</script>';
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).replace(/\s+/g, " ").slice(0, 700)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── PHP, fixtures and SQL ─────────────────────────────────────────────── */
const STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i; // no real YouTube key or LIVE_CRON_KEY from the shell reaches a PHP child (SPEC-PHASE3 §11.4)
const PHP_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !STRIP.test(k))), TRUSTED_PROXIES: "127.0.0.1,::1", SITE_URL: BASE, CORS_ORIGIN: "*", ADMIN_USERNAME: "admin" };
function phpCommand(args) {
  return viaBash ? ["bash", [PHP_BIN, ...args]] : [PHP_BIN, args];
}
function php(args) {
  const [cmd, argv] = phpCommand(args);
  const r = spawnSync(cmd, argv, { cwd: REPO, encoding: "utf8", env: PHP_ENV, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
const phpNoise = [];
/** One fixture command; the JSON travels on stdin so Tamil survives the Windows command line. */
function fixture(command, args = {}) {
  const [cmd, argv] = phpCommand(["tests/support/live_fixtures.php", command, "-"]);
  const r = spawnSync(cmd, argv, { cwd: REPO, input: JSON.stringify(args), encoding: "utf8", env: PHP_ENV, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(`${r.stdout}\n${r.stderr}`);
  if (m) phpNoise.push(`fixture ${command}: ${m[0]}`);
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
const streamRow = (id) => one("SELECT * FROM live_streams WHERE id = ?", [id]);
const byTitle = (title) => one("SELECT * FROM live_streams WHERE title_en = ? ORDER BY id DESC", [title]);
const activity = (id) => rows("SELECT actor, action, subject, detail FROM admin_activity WHERE subject = ? ORDER BY id", [`Stream #${id}`]);
const countTitled = (like) => Number(one("SELECT COUNT(*) AS c FROM live_streams WHERE title_en LIKE ?", [like])?.c ?? 0);
const mkStream = (over = {}) => fixture("create-stream", { title_prefix: PREFIX, actor: "e2e", ...over });
const cleanup = () => fixture("cleanup", { title_prefix: CLEAN_PREFIX, admin_prefix: ADMIN_PREFIX, ips: Object.values(IP) });

/* ── Sessions ──────────────────────────────────────────────────────────── */
function jar(xff) {
  let cookie = "";
  const grab = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^(PHPSESSID=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
  };
  return {
    xff,
    async get(path) {
      const r = await fetch(BASE + path, { headers: { cookie, "X-Forwarded-For": xff }, redirect: "manual" });
      grab(r);
      return r;
    },
    async post(path, pairs) {
      const r = await fetch(BASE + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(pairs),
      });
      grab(r);
      return r;
    },
    async upload(path, fields, file) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      if (file) fd.append(file.field, new Blob([file.body], { type: file.type ?? "application/octet-stream" }), file.name);
      const r = await fetch(BASE + path, { method: "POST", redirect: "manual", headers: { cookie, "X-Forwarded-For": xff }, body: fd });
      grab(r);
      return r;
    },
    async html(path) {
      const r = await this.get(path);
      return { status: r.status, html: await r.text(), headers: r.headers };
    },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
async function login(session, username, password) {
  const page = await session.get("/admin/login.php");
  return session.post("/admin/login.php", { _csrf: csrfOf(await page.text()), username, password, next: "" });
}
const decode = (s) => s.replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const flashOf = (html) => decode(/<p class="alert alert--(?:success|warning|error|info)" role="(?:status|alert)"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? "");
/** POST, follow the 303 by hand, return {status, location, html (landing page), flash}. */
async function act(session, path, pairs, file = null) {
  const r = file === null && !pairs.__multipart ? await session.post(path, pairs) : await session.upload(path, Object.fromEntries(Object.entries(pairs).filter(([k]) => k !== "__multipart")), file);
  const location = r.headers.get("location") || "";
  if (r.status !== 303 && r.status !== 302) return { status: r.status, location, html: await r.text(), flash: "" };
  const target = location.startsWith("http") ? new URL(location).pathname + new URL(location).search : location;
  const landing = await session.html(target);
  return { status: r.status, location, html: landing.html, flash: flashOf(landing.html) };
}
const mainOf = (html) => (/<main[^>]*id="admin-content"[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? html).replace(/<script[\s\S]*?<\/script>/g, "");
const chip = (html, label) => {
  const m = new RegExp(`${label}\\s*<span class="chip__count">([0-9]+)</span>`).exec(html);
  return m ? Number(m[1]) : null;
};
/** English titles listed on the page, in order. */
const listed = (html) => [...mainOf(html).matchAll(/<td>\s*<span class="cell-title">([^<]*)<\/span>\s*<span class="cell-sub" lang="ta">/g)].map((m) => decode(m[1]));
const inputValue = (html, name) => {
  const m = new RegExp(`<(?:input|textarea)[^>]*\\bname="${name}"[^>]*>`).exec(html);
  if (!m) return null;
  const tag = m[0];
  if (tag.startsWith("<textarea")) {
    const t = new RegExp(`<textarea[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</textarea>`).exec(html);
    return t ? decode(t[1]) : null;
  }
  return decode(/\svalue="([^"]*)"/.exec(tag)?.[1] ?? "");
};
const selected = (html, name) => {
  const s = new RegExp(`<select[^>]*\\bname="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? "";
  return decode(/<option value="([^"]*)"[^>]*\sselected/.exec(s)?.[1] ?? "");
};
const checkedFlag = (html, name) => new RegExp(`<input type="checkbox" name="${name}" value="1" checked`).test(html);
const invalid = (html, name) => new RegExp(`\\bname="${name}"[^>]*aria-invalid="true"`).test(html) || new RegExp(`aria-invalid="true"[^>]*\\bname="${name}"`).test(html);
const fieldError = (html, key) => decode(new RegExp(`<span class="field__error" id="err-${key}">(?:<svg[\\s\\S]*?</svg>)?([^<]*)</span>`).exec(html)?.[1] ?? "");

/* ── Accounts ──────────────────────────────────────────────────────────── */
async function deleteAccounts(owner) {
  const { html } = await owner.html("/admin/users.php");
  const ids = html.split("<tr")
    .filter((row) => new RegExp(`class="cell-sub">(${EDITOR}|${VIEWER})\\b`).test(row))
    .map((row) => /users\.php\?edit=(\d+)/.exec(row)?.[1])
    .filter(Boolean);
  for (const id of ids) await owner.post("/admin/users.php", { _csrf: csrfOf(html), action: "delete", id });
}
async function createAccount(owner, username, displayName, role, password) {
  const { html } = await owner.html("/admin/users.php");
  const r = await owner.post("/admin/users.php", { _csrf: csrfOf(html), action: "save", id: "0", username, display_name: displayName, email: `${username}-${RUN}@example.test`, phone: "", role, password, is_active: "1" });
  if (r.status !== 303) throw new Error(`could not create ${username}: status ${r.status}`);
}
async function signInFresh(session, username, issued, chosen) {
  const r = await login(session, username, issued);
  if (r.status !== 302) throw new Error(`${username} could not sign in: ${r.status}`);
  const prof = await session.html("/admin/profile.php");
  const c = await session.post("/admin/profile.php", { _csrf: csrfOf(prof.html), action: "password", current_password: issued, new_password: chosen, confirm_password: chosen });
  if (c.status !== 303) throw new Error(`${username} could not change the issued password: ${c.status}`);
}

/* ── Server ────────────────────────────────────────────────────────────── */
function portInUse(port, host = "127.0.0.1") {
  return new Promise((done) => {
    const sock = connect({ port, host });
    sock.once("connect", () => { sock.destroy(); done(true); });
    sock.once("error", () => done(false));
  });
}
let server = null;
async function startServer() {
  const hash = php(["-r", "echo password_hash('Admin@Test123', PASSWORD_BCRYPT, ['cost' => 5]);"]).trim();
  const [cmd, argv] = phpCommand(["-S", `127.0.0.1:${PHP_PORT}`, "router.php"]);
  const child = spawn(cmd, argv, { cwd: resolve(REPO, "backend"), env: { ...PHP_ENV, ADMIN_PASS_HASH: hash }, windowsHide: true });
  server = { child, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/api/pulse`);
      if (res.status === 200) return true;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  return false;
}
async function stopServer() {
  if (server && server.child.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else server.child.kill("SIGTERM");
  }
  for (let i = 0; i < 20 && (await portInUse(PHP_PORT)); i++) await sleep(250);
}

/* ── The form ──────────────────────────────────────────────────────────── */
const tomorrow = (() => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
})();
const dayAfter = (() => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + 48 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
})();
/** Every field the save form posts, with sensible values; `over` replaces. */
function formPairs(csrf, over = {}) {
  const base = {
    _csrf: csrf, action: "save", id: "0",
    title_en: `${PREFIX} Pournami Abhishekam`, title_ta: `${PREFIX} பௌர்ணமி அபிஷேகம்`, slug: "",
    description_en: "The full-moon abhishekam, streamed live.", description_ta: "பௌர்ணமி அபிஷேகம் நேரடி ஒளிபரப்பு.",
    temple_id: "", deity_id: "", event_type: "abhishekam", status: "DRAFT",
    provider: "youtube", provider_reference: `https://www.youtube.com/watch?v=${YT}&t=10s`, playback_url: "", thumbnail_url: "", banner_url: "",
    scheduled_date: tomorrow, start_time: "18:00", end_time: "19:30", end_date: "", timezone: "Asia/Kolkata",
    donations_enabled: "1", notifications_enabled: "1", sharing_enabled: "1", archive_enabled: "1",
  };
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k]; else out[k] = v;
  }
  return out;
}

/* ── Preflight ─────────────────────────────────────────────────────────── */
if (await portInUse(PHP_PORT)) {
  console.log(`✗ port ${PHP_PORT} is already in use; this suite needs it.`);
  process.exit(2);
}
if (!(await startServer())) {
  console.log(`✗ the PHP server did not start on ${BASE} (PHP_BIN=${PHP_BIN}).\n${server?.log.slice(-600) ?? ""}`);
  await stopServer();
  process.exit(1);
}
const probe = fixture("probe", {});
if (!probe.tables) {
  console.log("✗ the live streaming tables are missing; apply migration 011 first");
  await stopServer();
  process.exit(1);
}
const TEMPLE_ID = String(probe.temple.id);
const DEITY = probe.deities.find((d) => d.slug === "lingammal") ?? probe.deities[0];
console.log(`  cleanup at start: ${JSON.stringify(cleanup())}`);

const owner = jar(IP.owner);
const editor = jar(IP.editor);
const viewer = jar(IP.viewer);
let browser = null;
const F = {};
try {
  let r = await login(owner, "admin", "Admin@Test123");
  check(r.status === 302, "the environment admin signs in", `status ${r.status}`);
  await deleteAccounts(owner);
  await createAccount(owner, EDITOR, "E2E Live Editor", "editor", "IssuedEd11Xy");
  await createAccount(owner, VIEWER, "E2E Live Viewer", "viewer", "IssuedVw22Xy");
  await signInFresh(editor, EDITOR, "IssuedEd11Xy", EDITOR_PW);
  await signInFresh(viewer, VIEWER, "IssuedVw22Xy", VIEWER_PW);
  check((await editor.get("/admin/")).status === 200 && (await viewer.get("/admin/")).status === 200, "the editor and the viewer are signed in");

  /* ── 1. The page ─────────────────────────────────────────────────────── */
  section("1. the page renders");
  let p = await owner.html(PAGE);
  check(p.status === 200 && !BAD.test(p.html), "live_streams.php → 200 without PHP notices", `status ${p.status}`);
  check(p.html.includes("<title>Live Streaming — Temple Admin</title>") && p.html.includes("<h1>Live Streaming</h1>"), "the title and h1 read Live Streaming");
  check(/<a href="\/admin\/live_streams\.php"[^>]*class="sidebar__link is-active"[^>]*>[\s\S]*?M8 21h8[\s\S]*?Live Streaming/.test(p.html), "the sidebar entry is active and carries the tv icon");
  const dash = await owner.html("/admin/");
  // Quick actions surface through the command palette (its JSON carries the icon name; the sprite carries the path).
  check(dash.status === 200 && dash.html.includes('"label":"New live stream","desc":"","href":"/admin/live_streams.php#new","icon":"tv"') && /"tv":"[\s\S]{0,400}?M8 21h8/.test(dash.html),
    "the dashboard's palette offers the quick action New live stream with the tv icon", `status ${dash.status}`);
  check(p.html.includes('href="/live-darshan"') && p.html.includes("Open /live-darshan"), "the Open /live-darshan action is offered");
  for (const q of ["?f=live", "?f=deleted", "?edit=999999999", "?sort=title&dir=asc&page=3"]) {
    const x = await owner.html(PAGE + q);
    check(x.status === 200 && !BAD.test(x.html), `live_streams.php${q} → 200 without notices`, `status ${x.status}`);
  }
  p = await owner.html(PAGE + "?edit=999999999");
  check(/That stream no longer exists/.test(p.html), "an unknown ?edit id says the stream no longer exists");
  check(/<option value="youtube"[^>]*>YouTube<\/option>/.test(p.html) && /<option value="vimeo"[^>]*disabled[^>]*>Vimeo — coming later/.test(p.html), "the provider select offers YouTube and disables the others");
  check(/<optgroup label="Asia">\s*<option value="Asia\/Kolkata" selected>Asia\/Kolkata \(IST\)/.test(p.html), "Asia/Kolkata (IST) is the first, selected time zone");
  check(selected(p.html, "status") === "DRAFT" && /<option value="SCHEDULED">/.test(p.html) && !/<option value="LIVE">/.test(p.html), "a new stream may only be Draft or Scheduled");

  /* ── 2. Create, list, edit view, update ──────────────────────────────── */
  section("2. create through the form, the list, the edit view, an update");
  p = await owner.html(PAGE);
  const TITLE_TA = `${PREFIX} பௌர்ணமி அபிஷேகம் – நேரடி தரிசனம்`;
  let res = await act(owner, PAGE, formPairs(csrfOf(p.html), {
    title_ta: TITLE_TA, temple_id: TEMPLE_ID, deity_id: String(DEITY.id), status: "SCHEDULED", is_featured: "1", notifications_enabled: null,
    playback_url: `https://www.youtube.com/live/${YT}`, thumbnail_url: "https://example.test/thumb.jpg",
  }));
  check(res.status === 303 && res.flash === "Created.", "create → 303 with the flash Created.", `${res.status} ${res.flash}`);
  F.a = byTitle(`${PREFIX} Pournami Abhishekam`);
  check(!!F.a, "the row exists");
  check(F.a?.title_ta === TITLE_TA, "the Tamil title round-trips exactly", F.a?.title_ta);
  check(F.a?.slug === `${PREFIX.toLowerCase()}-pournami-abhishekam`, "the slug was made from the English title", F.a?.slug);
  check(F.a?.status === "SCHEDULED" && F.a.provider === "youtube" && F.a.provider_broadcast_id === YT, "status, provider and the parsed video id are stored", `${F.a?.status} ${F.a?.provider} ${F.a?.provider_broadcast_id}`);
  check(Number(F.a?.temple_id) === Number(TEMPLE_ID) && Number(F.a?.deity_id) === Number(DEITY.id) && F.a.event_type === "abhishekam", "temple, deity and programme type are stored");
  check(F.a?.description_en === "The full-moon abhishekam, streamed live." && F.a.description_ta === "பௌர்ணமி அபிஷேகம் நேரடி ஒளிபரப்பு.", "both descriptions are stored");
  check(F.a?.playback_url === `https://www.youtube.com/live/${YT}` && F.a.thumbnail_url === "https://example.test/thumb.jpg" && F.a.banner_url === null, "the URLs are stored as typed, blank → NULL");
  check(F.a?.timezone === "Asia/Kolkata" && F.a.scheduled_start_at === `${tomorrow} 12:30:00` && F.a.scheduled_end_at === `${tomorrow} 14:00:00`, "18:00–19:30 IST is stored as 12:30–14:00 UTC", `${F.a?.scheduled_start_at} ${F.a?.scheduled_end_at}`);
  check(Number(F.a?.is_featured) === 1 && Number(F.a?.show_on_homepage) === 0 && Number(F.a?.donations_enabled) === 1 && Number(F.a?.notifications_enabled) === 0 && Number(F.a?.sharing_enabled) === 1 && Number(F.a?.archive_enabled) === 1,
    "the six flags follow the checkboxes (an unticked box is 0)", JSON.stringify([F.a?.is_featured, F.a?.show_on_homepage, F.a?.donations_enabled, F.a?.notifications_enabled, F.a?.sharing_enabled, F.a?.archive_enabled]));
  check(F.a?.created_by === "admin" && F.a.updated_by === "admin", "created_by and updated_by are the signed-in user");
  check(activity(F.a?.id).some((a) => a.action === "live_stream_create" && a.actor === "admin" && a.subject === `Stream #${F.a.id}`), "an admin_activity row live_stream_create names the admin", JSON.stringify(activity(F.a?.id)));

  p = await owner.html(`${PAGE}?q=${encodeURIComponent(PREFIX)}`);
  check(listed(p.html).includes(`${PREFIX} Pournami Abhishekam`), "the list shows the new stream");
  const row = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Pournami Abhishekam`)) ?? "";
  check(row.includes(`lang="ta">${TITLE_TA}<`) && row.includes(`/live-darshan/${F.a?.slug}`), "…with the Tamil title and the public address");
  check(/badge badge--info">Scheduled</.test(row) && /badge badge--gold">Featured</.test(row) && row.includes("Abhishekam") && row.includes(YT), "…its badges, programme type and video id");
  check(new RegExp(`${tomorrow.slice(8, 10)} \\w{3} \\d{4} · 18:00–19:30 IST`).test(decode(row)), "…and the schedule as a wall clock in IST", /<time[^>]*>([^<]*)</.exec(row)?.[1]);
  check(row.includes(`href="/live-darshan/${F.a?.slug}" target="_blank" rel="noopener"`) && /name="to" value="LIVE"/.test(row) && /name="to" value="STARTING"/.test(row) && /name="to" value="CANCELLED"/.test(row) && /name="to" value="DRAFT"/.test(row) && !/name="to" value="COMPLETED"/.test(row),
    "the row menu offers View page and exactly the legal transitions from SCHEDULED");

  p = await owner.html(`${PAGE}?edit=${F.a?.id}`);
  check(p.status === 200 && p.html.includes("Edit live stream") && p.html.includes(`name="id" value="${F.a?.id}"`), "the edit view opens");
  check(inputValue(p.html, "title_en") === `${PREFIX} Pournami Abhishekam` && inputValue(p.html, "title_ta") === TITLE_TA, "…with both titles");
  check(inputValue(p.html, "slug") === F.a?.slug && /name="slug"[^>]*readonly/.test(p.html), "…the slug, read-only once published");
  check(inputValue(p.html, "description_en") === "The full-moon abhishekam, streamed live." && inputValue(p.html, "description_ta") === "பௌர்ணமி அபிஷேகம் நேரடி ஒளிபரப்பு.", "…both descriptions");
  check(selected(p.html, "temple_id") === TEMPLE_ID && selected(p.html, "deity_id") === String(DEITY.id) && selected(p.html, "event_type") === "abhishekam" && selected(p.html, "provider") === "youtube", "…temple, deity, programme and provider selected");
  check(inputValue(p.html, "provider_reference") === YT && p.html.includes(`Video ID <code>${YT}</code>`) && p.html.includes(`href="https://www.youtube.com/watch?v=${YT}" target="_blank" rel="noopener">Preview on YouTube`), "…the parsed video id with a preview link");
  check(inputValue(p.html, "playback_url") === `https://www.youtube.com/live/${YT}` && inputValue(p.html, "thumbnail_url") === "https://example.test/thumb.jpg" && inputValue(p.html, "banner_url") === "", "…the URLs");
  check(inputValue(p.html, "scheduled_date") === tomorrow && inputValue(p.html, "start_time") === "18:00" && inputValue(p.html, "end_time") === "19:30" && inputValue(p.html, "end_date") === "" && selected(p.html, "timezone") === "Asia/Kolkata", "…the schedule as the wall clock that was typed");
  check(selected(p.html, "status") === "SCHEDULED" && /<option value="SCHEDULED" selected>Scheduled \(current\)/.test(p.html) && /<option value="LIVE">/.test(p.html) && !/<option value="COMPLETED">/.test(p.html), "…the status select offers the current status and its legal targets");
  check(checkedFlag(p.html, "is_featured") && !checkedFlag(p.html, "show_on_homepage") && checkedFlag(p.html, "donations_enabled") && !checkedFlag(p.html, "notifications_enabled") && checkedFlag(p.html, "sharing_enabled") && checkedFlag(p.html, "archive_enabled"), "…and every flag as stored");
  check(p.html.includes('<img class="thumb" src="https://example.test/thumb.jpg" alt="Current thumbnail"'), "…with a preview of the current thumbnail");

  const before = streamRow(F.a?.id);
  res = await act(owner, PAGE, formPairs(csrfOf(p.html), {
    id: String(F.a.id), title_ta: TITLE_TA, slug: F.a.slug, temple_id: TEMPLE_ID, deity_id: String(DEITY.id), status: "SCHEDULED", is_featured: "1", notifications_enabled: null,
    playback_url: `https://www.youtube.com/live/${YT}`, thumbnail_url: "https://example.test/thumb.jpg",
    description_en: "Edited description.", end_time: "20:00",
  }));
  const after = streamRow(F.a.id);
  check(res.status === 303 && res.flash === "Updated.", "update → 303 with the flash Updated.", `${res.status} ${res.flash}`);
  const changedCols = Object.keys(after).filter((k) => String(after[k]) !== String(before[k]));
  check(changedCols.sort().join(",") === "description_en,scheduled_end_at,updated_at", "only the edited columns (and updated_at) changed", changedCols.join(","));
  check(after.description_en === "Edited description." && after.scheduled_end_at === `${tomorrow} 14:30:00`, "…to the new values");
  check(activity(F.a.id).some((a) => a.action === "live_stream_update" && /changed description_en, scheduled_end_at/.test(a.detail)), "the update is audited naming the changed fields", JSON.stringify(activity(F.a.id).slice(-1)));

  /* ── 3. Validation ───────────────────────────────────────────────────── */
  section("3. validation keeps the typed values and changes nothing");
  const countBefore = countTitled(`${PREFIX}%`);
  const snapshotA = JSON.stringify(streamRow(F.a.id));
  p = await owner.html(PAGE);
  const csrf = csrfOf(p.html);
  const cases = [
    ["empty titles", { title_en: "", title_ta: "", temple_id: TEMPLE_ID }, ["title_en", "title_ta"]],
    ["a bad date", { title_en: `${PREFIX} Bad date`, temple_id: TEMPLE_ID, scheduled_date: "9999-99-99" }, ["scheduled_date"]],
    ["an end before the start", { title_en: `${PREFIX} Ends early`, temple_id: TEMPLE_ID, start_time: "18:00", end_time: "17:00" }, ["end_time"]],
    ["a bad time zone", { title_en: `${PREFIX} Bad zone`, temple_id: TEMPLE_ID, timezone: "Mars/Olympus" }, ["timezone"]],
    ["a bad video id", { title_en: `${PREFIX} Bad video`, temple_id: TEMPLE_ID, provider_reference: "https://vimeo.com/12345" }, ["provider_reference"]],
    ["a javascript: URL", { title_en: `${PREFIX} Bad URL`, temple_id: TEMPLE_ID, playback_url: "javascript:alert(1)", banner_url: "http://insecure.example/x.jpg" }, ["playback_url", "banner_url"]],
    ["a duplicate slug", { title_en: `${PREFIX} Dup slug`, temple_id: TEMPLE_ID, slug: F.a.slug.toUpperCase() }, ["slug"]],
    ["a reserved slug", { title_en: `${PREFIX} Reserved`, temple_id: TEMPLE_ID, slug: "upcoming" }, ["slug"]],
    ["a slug of digits only", { title_en: `${PREFIX} Digits`, temple_id: TEMPLE_ID, slug: "12345" }, ["slug"]],
    ["an illegal status on create", { title_en: `${PREFIX} Illegal`, temple_id: TEMPLE_ID, status: "LIVE" }, ["status"]],
    ["no video id when publishing", { title_en: `${PREFIX} No video`, temple_id: TEMPLE_ID, status: "SCHEDULED", provider_reference: "" }, ["provider_reference"]],
    ["no temple", { title_en: `${PREFIX} No temple`, temple_id: "999999" }, ["temple_id"]],
    ["a deity of no temple", { title_en: `${PREFIX} Bad deity`, temple_id: TEMPLE_ID, deity_id: "999999" }, ["deity_id"]],
    ["script in every field", { title_en: `${PREFIX} ${XSS}`, title_ta: XSS, slug: XSS, description_en: XSS, provider_reference: XSS, thumbnail_url: XSS, temple_id: TEMPLE_ID }, ["slug", "provider_reference", "thumbnail_url"]],
  ];
  for (const [label, over, keys] of cases) {
    const pairs = formPairs(csrf, over);
    const x = await owner.post(PAGE, pairs);
    const html = await x.text();
    const errs = keys.map((k) => fieldError(html, k));
    check(x.status === 200 && !BAD.test(html) && html.includes('id="live-errors"') && /Nothing has been saved/.test(html), `${label}: 200 with the error summary`, `status ${x.status}`);
    check(keys.every((k) => invalid(html, k)) && errs.every(Boolean), `${label}: aria-invalid and a message on ${keys.join(", ")}`, errs.join(" | ") || "no messages");
    check(inputValue(html, "title_en") === pairs.title_en && inputValue(html, "description_en") === pairs.description_en && inputValue(html, "scheduled_date") === pairs.scheduled_date, `${label}: the typed values are kept`);
    check(!html.includes("<script>alert(1)</script>"), `${label}: nothing is reflected unescaped`);
  }
  check(countTitled(`${PREFIX}%`) === countBefore && JSON.stringify(streamRow(F.a.id)) === snapshotA, "the validation matrix created and changed nothing");
  // An illegal status on update, through the form: SCHEDULED → COMPLETED is not in the table.
  p = await owner.html(`${PAGE}?edit=${F.a.id}`);
  let x = await owner.post(PAGE, formPairs(csrfOf(p.html), { id: String(F.a.id), title_ta: TITLE_TA, slug: F.a.slug, temple_id: TEMPLE_ID, deity_id: String(DEITY.id), status: "COMPLETED", description_en: "Edited description.", end_time: "20:00" }));
  let html = await x.text();
  check(x.status === 200 && fieldError(html, "status") === "That status change is not allowed." && streamRow(F.a.id).status === "SCHEDULED", "an illegal status jump on update is a field error and changes nothing", fieldError(html, "status"));
  // The slug field is read-only once published; posting a new one anyway is refused server-side.
  x = await owner.post(PAGE, formPairs(csrfOf(p.html), { id: String(F.a.id), title_ta: TITLE_TA, slug: `${F.a.slug}-moved`, temple_id: TEMPLE_ID, deity_id: String(DEITY.id), status: "SCHEDULED", description_en: "Edited description.", end_time: "20:00" }));
  html = await x.text();
  check(x.status === 200 && fieldError(html, "slug") === "The address is locked after publishing." && streamRow(F.a.id).slug === F.a.slug, "a new slug posted for a published stream is refused (the lock is not only the readonly attribute)", `${fieldError(html, "slug")} / ${streamRow(F.a.id).slug}`);
  // A title of digits only gets a slug that is not digits only (digits alone would be read as an id).
  x = await act(owner, PAGE, formPairs(csrf, { title_en: "2027", title_ta: `${PREFIX} இரண்டாயிரத்து இருபத்தேழு`, temple_id: TEMPLE_ID, status: "DRAFT" }));
  const digits = byTitle("2027");
  check(x.flash === "Created." && digits?.slug === "2027-darshan", "a title of digits only is given the slug 2027-darshan", `${x.flash} ${digits?.slug}`);
  if (digits) sql("UPDATE live_streams SET title_en = ? WHERE id = ?", [`${PREFIX} Digits title`, digits.id]);
  // Arrays where strings belong.
  x = await owner.post(PAGE, [["_csrf", csrf], ["action", "save"], ["id", "0"], ["title_en[]", "x"], ["title_ta[]", "y"], ["temple_id[]", TEMPLE_ID], ["status[]", "LIVE"], ["scheduled_date[]", "1"]]);
  html = await x.text();
  check(x.status === 200 && !BAD.test(html) && html.includes('id="live-errors"'), "arrays where strings belong are field errors, never a 500", `status ${x.status}`);

  /* ── 4. Status buttons, delete, restore ──────────────────────────────── */
  section("4. the status buttons, delete and restore");
  p = await owner.html(PAGE);
  res = await act(owner, PAGE, formPairs(csrfOf(p.html), { title_en: `${PREFIX} Draft one`, title_ta: `${PREFIX} வரைவு ஒன்று`, temple_id: TEMPLE_ID, status: "DRAFT", provider_reference: "", scheduled_date: "", start_time: "", end_time: "" }));
  F.d = byTitle(`${PREFIX} Draft one`);
  check(res.flash === "Created." && F.d?.status === "DRAFT" && F.d.scheduled_start_at === null && F.d.provider_broadcast_id === null, "a draft may be saved without a video id or a schedule", `${res.flash} ${F.d?.status}`);
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(PREFIX)}`);
  let draftRow = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Draft one`)) ?? "";
  check(!/name="to" value="SCHEDULED"/.test(draftRow) && /name="to" value="CANCELLED"/.test(draftRow) && /Add a video ID and a start time to publish/.test(draftRow), "a draft without a video id or a schedule offers Cancel but not Publish, and says why", `${draftRow.match(/name="to" value="[A-Z]+"/g)?.join(",")} | ${/Add a video ID[^<]*/.exec(draftRow)?.[0]}`);
  const status = (session, id, to) => act(session, PAGE, { _csrf: csrfOf(p.html), action: "status", id: String(id), to });
  res = await status(owner, F.d.id, "SCHEDULED");
  check(res.status === 303 && /^Cannot publish yet: /.test(res.flash) && /Enter the YouTube video ID or link before publishing\./.test(res.flash) && /Enter the date and start time before publishing\./.test(res.flash) && streamRow(F.d.id).status === "DRAFT", "posting Publish for it anyway is refused with the field errors as a flash; the row stays DRAFT", `${res.status} ${res.flash} ${streamRow(F.d.id).status}`);
  check(!activity(F.d.id).some((a) => a.action === "live_stream_status"), "…and nothing was audited as a status change", JSON.stringify(activity(F.d.id).map((a) => a.action)));
  res = await act(owner, PAGE, formPairs(csrfOf(p.html), { id: String(F.d.id), title_en: `${PREFIX} Draft one`, title_ta: `${PREFIX} வரைவு ஒன்று`, temple_id: TEMPLE_ID, status: "DRAFT", end_time: "" }));
  F.d = streamRow(F.d.id);
  check(res.flash === "Updated." && F.d.status === "DRAFT" && F.d.provider_broadcast_id === YT && F.d.scheduled_start_at !== null, "the video id and the schedule are added while it stays a draft", `${res.flash} ${F.d.status} ${F.d.provider_broadcast_id} ${F.d.scheduled_start_at}`);
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(PREFIX)}`);
  draftRow = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Draft one`)) ?? "";
  check(/name="to" value="SCHEDULED"/.test(draftRow) && /name="to" value="CANCELLED"/.test(draftRow) && /data-confirm="Publish/.test(draftRow) && !/Add a video ID/.test(draftRow), "now the row offers Publish and Cancel with a confirmation", draftRow.match(/data-confirm="[^"]*"/g)?.join(" | "));
  res = await status(owner, F.d.id, "SCHEDULED");
  check(res.status === 303 && res.flash === "Status changed to SCHEDULED." && streamRow(F.d.id).status === "SCHEDULED", "Publish → SCHEDULED", `${res.status} ${res.flash}`);
  res = await status(owner, F.d.id, "SCHEDULED");
  check(res.flash === "Already Scheduled." && streamRow(F.d.id).status === "SCHEDULED", "the same status again is a no-op with an info flash", res.flash);
  // Go live re-checks the row too: with the video id cleared it is refused and the menu does not offer it.
  sql("UPDATE live_streams SET provider_broadcast_id = NULL WHERE id = ?", [F.a.id]);
  res = await status(owner, F.a.id, "LIVE");
  check(res.status === 303 && /^Cannot go live yet: Enter the YouTube video ID or link before publishing\./.test(res.flash) && streamRow(F.a.id).status === "SCHEDULED", "Go live on a scheduled stream whose video id was cleared is refused with the field error", `${res.flash} ${streamRow(F.a.id).status}`);
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(PREFIX)}`);
  const noVideoRow = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Pournami Abhishekam`)) ?? "";
  check(!/name="to" value="LIVE"/.test(noVideoRow) && !/name="to" value="STARTING"/.test(noVideoRow) && /name="to" value="CANCELLED"/.test(noVideoRow) && /name="to" value="DRAFT"/.test(noVideoRow), "…and its row menu offers neither Go live nor Starting soon until the video id is back", noVideoRow.match(/name="to" value="[A-Z]+"/g)?.join(","));
  sql("UPDATE live_streams SET provider_broadcast_id = ? WHERE id = ?", [YT, F.a.id]);
  res = await status(owner, F.a.id, "LIVE");
  let a = streamRow(F.a.id);
  check(res.flash === "Status changed to LIVE." && a.status === "LIVE" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.actual_start_at ?? "") && a.actual_end_at === null, "Go live → LIVE with actual_start_at stamped", `${res.flash} ${a.status} ${a.actual_start_at}`);
  const startedAt = a.actual_start_at;
  res = await status(owner, F.a.id, "SCHEDULED");
  check(res.flash === "That status change is not allowed." && streamRow(F.a.id).status === "LIVE", "LIVE → SCHEDULED is refused by the button too", res.flash);
  res = await status(owner, F.a.id, "OFFLINE");
  check(res.flash === "Status changed to OFFLINE." && streamRow(F.a.id).status === "OFFLINE", "Mark offline → OFFLINE");
  res = await status(owner, F.a.id, "LIVE");
  a = streamRow(F.a.id);
  check(res.flash === "Status changed to LIVE." && a.status === "LIVE" && a.actual_start_at === startedAt, "Back live keeps the first actual_start_at");
  res = await status(owner, F.a.id, "COMPLETED");
  a = streamRow(F.a.id);
  check(res.flash === "Status changed to COMPLETED." && a.status === "COMPLETED" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.actual_end_at ?? ""), "End stream → COMPLETED with actual_end_at stamped", `${res.flash} ${a.status} ${a.actual_end_at}`);
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(PREFIX)}`);
  const doneRow = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Pournami Abhishekam`)) ?? "";
  check(!/name="to" value=/.test(doneRow) && /actual \d{2} \w{3} · \d{2}:\d{2}–\d{2}:\d{2} IST/.test(decode(doneRow)), "a completed stream offers no transition and shows the actual times", /actual[^<]*/.exec(decode(doneRow))?.[0]);
  res = await status(owner, F.d.id, "CANCELLED");
  check(res.flash === "Status changed to CANCELLED." && streamRow(F.d.id).status === "CANCELLED", "Cancel → CANCELLED");
  check(activity(F.a.id).filter((x) => x.action === "live_stream_status").map((x) => x.detail.split(" by ")[0]).join(";") === "SCHEDULED → LIVE;LIVE → OFFLINE;OFFLINE → LIVE;LIVE → COMPLETED", "every status change is audited from → to", JSON.stringify(activity(F.a.id).filter((x) => x.action === "live_stream_status")));
  res = await status(owner, 999999999, "LIVE");
  check(res.flash === "That stream no longer exists." , "a status change on an unknown id is a warning", res.flash);
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "status", id: String(F.d.id), to: XSS });
  check(res.status === 303 && res.flash === "That status change is not allowed." && streamRow(F.d.id).status === "CANCELLED", "a nonsense target status is refused", res.flash);

  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "delete", id: String(F.d.id) });
  let d = streamRow(F.d.id);
  check(res.flash === "Deleted." && d.deleted_at !== null && d.status === "CANCELLED", "Delete → deleted_at set, the row kept", `${res.flash} ${d.deleted_at}`);
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(PREFIX)}`);
  check(!listed(p.html).includes(`${PREFIX} Draft one`), "…and gone from the default list");
  p = await owner.html(`${PAGE}?f=deleted&q=${encodeURIComponent(PREFIX)}`);
  const binRow = p.html.split("<tr").find((tr) => tr.includes(`${PREFIX} Draft one`)) ?? "";
  check(listed(p.html).includes(`${PREFIX} Draft one`) && /badge badge--muted">Deleted</.test(binRow) && /name="action" value="restore"/.test(binRow) && !/name="action" value="status"/.test(binRow), "…listed under Deleted with a Restore action only");
  p = await owner.html(`${PAGE}?edit=${F.d.id}`);
  check(/That stream is in the bin/.test(p.html), "editing a deleted stream says it is in the bin");
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "delete", id: String(F.d.id) });
  check(res.flash === "That stream no longer exists.", "deleting it again is a warning", res.flash);
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "restore", id: String(F.d.id) });
  d = streamRow(F.d.id);
  check(res.flash === "Restored." && d.deleted_at === null, "Restore clears deleted_at", `${res.flash} ${d.deleted_at}`);
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "restore", id: String(F.d.id) });
  check(res.flash === "That stream is not in the bin.", "restoring it again is a warning", res.flash);
  check(activity(F.d.id).map((x) => x.action).join(",").includes("live_stream_delete,live_stream_restore"), "delete and restore are audited", activity(F.d.id).map((x) => x.action).join(","));

  /* ── 5. Uploads ──────────────────────────────────────────────────────── */
  section("5. thumbnail uploads");
  p = await owner.html(PAGE);
  const up = (file, over = {}) => act(owner, PAGE, { ...formPairs(csrfOf(p.html), { title_en: `${PREFIX} Upload`, title_ta: `${PREFIX} பதிவேற்றம்`, temple_id: TEMPLE_ID, ...over }), __multipart: true }, file);
  res = await up({ field: "thumbnail", body: PNG_1x1, name: "poster.png", type: "image/png" });
  F.u = byTitle(`${PREFIX} Upload`);
  check(res.status === 303 && res.flash === "Created." && /^\/uploads\/live-[0-9a-f]{24}\.png$/.test(F.u?.thumbnail_url ?? ""), "a real PNG is stored as /uploads/live-<hex>.png", `${res.flash} ${F.u?.thumbnail_url}`);
  const served = await fetch(BASE + F.u.thumbnail_url);
  const bytes = Buffer.from(await served.arrayBuffer());
  check(served.status === 200 && /^image\/png/.test(served.headers.get("content-type") || "") && bytes.equals(PNG_1x1), "…and served back as image/png, byte for byte", `${served.status} ${served.headers.get("content-type")}`);
  const uploadCount = countTitled(`${PREFIX} Upload%`);
  for (const [label, file] of [
    ["a text file named .png", { field: "thumbnail", body: Buffer.from("this is not an image at all, whatever the name says"), name: "fake.png", type: "image/png" }],
    ["an oversize file", { field: "thumbnail", body: Buffer.concat([PNG_1x1, Buffer.alloc(3 * 1024 * 1024, 0)]), name: "big.png", type: "image/png" }],
    ["a .php file", { field: "thumbnail", body: Buffer.from("<?php echo 'pwned'; ?>"), name: "shell.php", type: "application/x-php" }],
    ["a PHP file disguised as a PNG", { field: "banner", body: Buffer.from("<?php echo 'pwned'; ?>"), name: "shell.png", type: "image/png" }],
  ]) {
    const r2 = await up(file, { title_en: `${PREFIX} Upload ${label}` });
    const key = file.field;
    check(r2.status === 200 && r2.html.includes('id="live-errors"') && fieldError(r2.html, key) !== "" && invalid(r2.html, key), `${label} is refused with a ${key} error`, `${r2.status} ${fieldError(r2.html, key)}`);
  }
  check(countTitled(`${PREFIX} Upload%`) === uploadCount, "the refused uploads saved nothing");
  const orphaned = rows("SELECT thumbnail_url, banner_url FROM live_streams WHERE title_en LIKE ?", [`${PREFIX} Upload%`]).filter((x) => x.thumbnail_url !== F.u.thumbnail_url && (x.thumbnail_url || x.banner_url));
  check(orphaned.length === 0, "no refused file has a URL stored", JSON.stringify(orphaned));
  const noPhp = await fetch(`${BASE}/uploads/shell.php`);
  check(noPhp.status === 404 || noPhp.status === 403, "/uploads/*.php is never served as code", `status ${noPhp.status}`);
  // Replacing the upload removes the old file.
  p = await owner.html(`${PAGE}?edit=${F.u.id}`);
  const oldUrl = F.u.thumbnail_url;
  res = await act(owner, PAGE, { ...formPairs(csrfOf(p.html), { id: String(F.u.id), title_en: `${PREFIX} Upload`, title_ta: `${PREFIX} பதிவேற்றம்`, slug: F.u.slug, temple_id: TEMPLE_ID, thumbnail_url: oldUrl }), __multipart: true }, { field: "thumbnail", body: PNG_1x1, name: "poster2.png", type: "image/png" });
  F.u = streamRow(F.u.id);
  check(res.flash === "Updated." && F.u.thumbnail_url !== oldUrl && /^\/uploads\/live-/.test(F.u.thumbnail_url) && (await fetch(BASE + oldUrl)).status === 404 && (await fetch(BASE + F.u.thumbnail_url)).status === 200,
    "a replaced upload is stored and the old file is removed", `${res.flash} ${oldUrl} → ${F.u.thumbnail_url}`);

  /* ── 6. Filters, search, sort, pagination, hostile params ────────────── */
  section("6. filters, search, sort, pagination");
  const many = [];
  for (let i = 1; i <= 24; i++) {
    many.push(mkStream({ label: `Page ${String(i).padStart(2, "0")}`, status: i % 3 === 0 ? "DRAFT" : "SCHEDULED", scheduled_start_local: `${i % 2 ? tomorrow : dayAfter} ${String(6 + (i % 12)).padStart(2, "0")}:00` }));
  }
  F.live = mkStream({ label: "Now live", status: "LIVE" });
  F.off = mkStream({ label: "Offline", status: "OFFLINE" });
  const mine = () => rows("SELECT id, title_en, status, deleted_at, scheduled_start_at, created_at, updated_at FROM live_streams WHERE title_en LIKE ?", [`${PREFIX}%`]);
  const all = mine();
  const q = encodeURIComponent(PREFIX);
  p = await owner.html(`${PAGE}?q=${q}`);
  const total = all.filter((x) => x.deleted_at === null).length;
  check(new RegExp(`${total} of \\d+ records`).test(p.html) && listed(p.html).length === 25, `search: ${total} of the suite's streams, 25 on the first page`, `${listed(p.html).length} listed; ${/\d+ of \d+ records?/.exec(p.html)?.[0]}`);
  const p2 = await owner.html(`${PAGE}?q=${q}&page=2`);
  check(listed(p2.html).length === total - 25 && !listed(p2.html).some((t) => listed(p.html).includes(t)), "page 2 holds the rest, none repeated");
  check([...listed(p.html), ...listed(p2.html)].sort().join() === all.filter((x) => x.deleted_at === null).map((x) => x.title_en).sort().join(), "every stream is listed once across the pages");
  const expectChip = (f) => all.filter((x) => f === "deleted" ? x.deleted_at !== null : x.deleted_at === null && (f === "all" || (f === "live" ? ["LIVE", "STARTING", "OFFLINE", "ERROR"].includes(x.status) : x.status === f.toUpperCase()))).length;
  for (const [f, label] of [["all", "All"], ["draft", "Draft"], ["scheduled", "Scheduled"], ["live", "Live"], ["completed", "Completed"], ["cancelled", "Cancelled"], ["deleted", "Deleted"]]) {
    const x = await owner.html(`${PAGE}?f=${f}&q=${q}`);
    const want = all.filter((s) => f === "deleted" ? s.deleted_at !== null : s.deleted_at === null && (f === "all" || (f === "live" ? ["LIVE", "STARTING", "OFFLINE", "ERROR"].includes(s.status) : s.status === f.toUpperCase()))).map((s) => s.title_en).sort();
    const got = [...listed(x.html)].sort();
    const dbCount = Number(one(f === "deleted" ? "SELECT COUNT(*) AS c FROM live_streams WHERE deleted_at IS NOT NULL" : f === "all" ? "SELECT COUNT(*) AS c FROM live_streams WHERE deleted_at IS NULL" : f === "live" ? "SELECT COUNT(*) AS c FROM live_streams WHERE deleted_at IS NULL AND status IN ('LIVE','STARTING','OFFLINE','ERROR')" : `SELECT COUNT(*) AS c FROM live_streams WHERE deleted_at IS NULL AND status = '${f.toUpperCase()}'`).c);
    // The page holds 25 rows in schedule order; beyond that only membership is comparable here.
    const exact = want.length <= 25 ? got.join() === want.join() : got.length === 25 && got.every((t) => want.includes(t));
    check(x.status === 200 && exact, `f=${f} lists exactly the ${label} streams (${expectChip(f)})`, `got ${got.length}: ${got.slice(0, 3).join(", ")}`);
    check(chip(x.html, label) === dbCount, `the ${label} chip counts ${dbCount} (whole table)`, `chip ${chip(x.html, label)}`);
  }
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(YT)}`);
  check(listed(p.html).includes(`${PREFIX} Pournami Abhishekam`), "search finds a stream by its video id");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent(F.a.slug)}`);
  check(listed(p.html).length === 1 && listed(p.html)[0] === `${PREFIX} Pournami Abhishekam`, "search finds a stream by its slug");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent("பௌர்ணமி")}`);
  check(listed(p.html).includes(`${PREFIX} Pournami Abhishekam`), "search finds a stream by its Tamil title");
  p = await owner.html(`${PAGE}?q=${q}&sort=title&dir=asc`);
  const titlesAsc = listed(p.html);
  check(titlesAsc.join() === [...titlesAsc].sort((x, y) => x.localeCompare(y, "en")).join(), "sort=title&dir=asc orders by English title");
  p = await owner.html(`${PAGE}?q=${q}&sort=title&dir=desc`);
  const allTitles = all.filter((s) => s.deleted_at === null).map((s) => s.title_en);
  check(listed(p.html)[0] === [...allTitles].sort((x, y) => y.localeCompare(x, "en"))[0] && titlesAsc[0] === [...allTitles].sort((x, y) => x.localeCompare(y, "en"))[0], "dir=desc reverses it (first rows are the extremes of the whole set)", `${titlesAsc[0]} … ${listed(p.html)[0]}`);
  p = await owner.html(`${PAGE}?q=${q}&sort=schedule&dir=asc`);
  const sched = listed(p.html).map((t) => all.find((x) => x.title_en === t)).map((x) => x.scheduled_start_at ?? x.created_at);
  check(sched.every((v, i) => i === 0 || v >= sched[i - 1]), "sort=schedule&dir=asc orders by start (created_at when unscheduled)", sched.slice(0, 4).join(" | "));
  p = await owner.html(`${PAGE}?q=${q}&sort=updated&dir=desc`);
  const upd = listed(p.html).map((t) => all.find((x) => x.title_en === t).updated_at);
  check(upd.every((v, i) => i === 0 || v <= upd[i - 1]), "sort=updated&dir=desc puts the latest change first");
  p = await owner.html(`${PAGE}?q=${q}&sort=status&dir=asc`);
  const st = listed(p.html).map((t) => all.find((x) => x.title_en === t).status);
  check(st.every((v, i) => i === 0 || v >= st[i - 1]), "sort=status groups by status", st.join(","));
  p = await owner.html(`${PAGE}?q=${q}&page=99`);
  check(p.status === 200 && listed(p.html).length === total - 25, "a page past the end shows the last page");
  p = await owner.html(`${PAGE}?q=${encodeURIComponent("zzz-nothing-" + RUN)}`);
  check(/No live streams match/.test(p.html) && /Clear filters/.test(p.html), "an empty search shows the no-match state");
  const hostile = jar(IP.hostile);
  await login(hostile, "admin", "Admin@Test123");
  for (const query of [`q=${encodeURIComponent(XSS)}`, `edit=${encodeURIComponent(XSS)}`, `f=${encodeURIComponent(XSS)}&sort=${encodeURIComponent(XSS)}&dir=${encodeURIComponent(XSS)}&page=99999999999999999999`, "edit[]=1&q[]=2&f[]=live&page=-1", "edit=-1"]) {
    const x = await hostile.html(`${PAGE}?${query}`);
    check(x.status === 200 && !BAD.test(x.html) && !x.html.includes("<script>alert(1)</script>"), `?${query.slice(0, 40)} survives, nothing reflected unescaped`, `status ${x.status}`);
  }
  p = await hostile.html(`${PAGE}?q=${encodeURIComponent(XSS)}`);
  check(p.html.includes(`value="${XSS.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`), "the hostile search term is echoed escaped in the search box");

  /* ── 7. Roles and CSRF ───────────────────────────────────────────────── */
  section("7. roles and CSRF");
  const beforeAll = JSON.stringify(mine());
  const activityBefore = Number(one("SELECT COUNT(*) AS c FROM admin_activity WHERE actor = ?", [VIEWER]).c);
  p = await viewer.html(`${PAGE}?q=${q}`);
  check(p.status === 200 && !BAD.test(p.html) && listed(p.html).length === 25, "viewer: reads the list", `status ${p.status}`);
  check(/Your role can read live streams but not change them/.test(p.html) && /<fieldset disabled>/.test(p.html) && !/form-drawer-toggle/.test(p.html), "viewer: the form is disabled and there is no New live stream button");
  check(!/name="action" value="status"/.test(mainOf(p.html)) && !/name="action" value="delete"/.test(mainOf(p.html)) && /View page/.test(p.html), "viewer: rows offer Edit and View page but no status or delete forms");
  p = await viewer.html(`${PAGE}?edit=${F.a.id}`);
  check(p.status === 200 && inputValue(p.html, "title_en") === `${PREFIX} Pournami Abhishekam` && /<button type="submit" class="btn btn-primary" disabled>/.test(p.html), "viewer: the edit view opens read-only");
  const vcsrf = csrfOf(p.html);
  for (const [label, pairs] of [
    ["save", formPairs(vcsrf, { title_en: `${PREFIX} Viewer create`, temple_id: TEMPLE_ID })],
    ["update", formPairs(vcsrf, { id: String(F.a.id), title_en: `${PREFIX} Viewer edit`, title_ta: TITLE_TA, slug: F.a.slug, temple_id: TEMPLE_ID })],
    ["status", { _csrf: vcsrf, action: "status", id: String(F.d.id), to: "SCHEDULED" }],
    ["delete", { _csrf: vcsrf, action: "delete", id: String(F.a.id) }],
    ["restore", { _csrf: vcsrf, action: "restore", id: String(F.a.id) }],
  ]) {
    const x = await viewer.post(PAGE, pairs);
    check(x.status === 403, `viewer: POST ${label} → 403`, `status ${x.status}`);
  }
  x = await viewer.upload(PAGE, formPairs(vcsrf, { title_en: `${PREFIX} Viewer upload`, temple_id: TEMPLE_ID }), { field: "thumbnail", body: PNG_1x1, name: "v.png", type: "image/png" });
  check(x.status === 403, "viewer: an upload → 403", `status ${x.status}`);
  check(JSON.stringify(mine()) === beforeAll, "viewer: nothing was created, changed or deleted");
  check(Number(one("SELECT COUNT(*) AS c FROM admin_activity WHERE actor = ?", [VIEWER]).c) === activityBefore, "viewer: no activity row was written");
  check(rows("SELECT thumbnail_url FROM live_streams WHERE title_en = ?", [`${PREFIX} Viewer upload`]).length === 0, "viewer: no upload was stored");

  p = await editor.html(PAGE);
  check(p.status === 200 && /form-drawer-toggle/.test(p.html) && !/<fieldset disabled>/.test(p.html), "editor: opens the page with the form enabled");
  res = await act(editor, PAGE, formPairs(csrfOf(p.html), { title_en: `${PREFIX} Editor stream`, title_ta: `${PREFIX} ஆசிரியர் ஒளிபரப்பு`, temple_id: TEMPLE_ID, status: "SCHEDULED" }));
  F.e = byTitle(`${PREFIX} Editor stream`);
  check(res.flash === "Created." && F.e?.created_by === EDITOR, "editor: creates a stream in their own name", `${res.flash} ${F.e?.created_by}`);
  res = await act(editor, PAGE, { _csrf: csrfOf(p.html), action: "status", id: String(F.e.id), to: "LIVE" });
  check(res.flash === "Status changed to LIVE." && streamRow(F.e.id).status === "LIVE" && activity(F.e.id).some((a) => a.action === "live_stream_status" && a.actor === EDITOR), "editor: Go live works and is audited for the editor");
  p = await editor.html(`${PAGE}?edit=${F.e.id}`);
  check(!/name="status"[^>]*disabled/.test(p.html) && !/<input type="hidden" name="status"/.test(p.html), "editor: the status select is enabled in the edit form");
  res = await act(editor, PAGE, { _csrf: csrfOf(p.html), action: "status", id: String(F.e.id), to: "COMPLETED" });
  res = await act(editor, PAGE, { _csrf: csrfOf(p.html), action: "delete", id: String(F.e.id) });
  check(res.flash === "Deleted." && streamRow(F.e.id).deleted_at !== null && streamRow(F.e.id).status === "COMPLETED", "editor: ends and deletes it");
  check((await editor.get("/admin/settings.php")).status === 403, "editor: is still refused system settings");

  const snap = JSON.stringify(mine());
  p = await owner.html(PAGE);
  x = await owner.post(PAGE, formPairs("forged-token", { title_en: `${PREFIX} Forged`, temple_id: TEMPLE_ID }));
  html = await x.text();
  check(x.status === 200 && /alert--error/.test(html) && inputValue(html, "title_en") === `${PREFIX} Forged` && byTitle(`${PREFIX} Forged`) === null, "a forged _csrf on save is refused and the typing is reflected back, nothing saved", `status ${x.status}`);
  x = await owner.post(PAGE, { action: "status", id: String(F.a.id), to: "LIVE" });
  check((x.status === 303 || x.status === 200) && streamRow(F.a.id).status === "COMPLETED", "a status POST without a token changes nothing", `status ${x.status}`);
  x = await owner.post(PAGE, { _csrf: "forged", action: "delete", id: String(F.live.id) });
  check(streamRow(F.live.id).deleted_at === null, "a delete with a forged token changes nothing");
  check(JSON.stringify(mine()) === snap, "the forged requests changed nothing at all");
  res = await act(owner, PAGE, { _csrf: csrfOf(p.html), action: "explode", id: "1" });
  check(res.status === 303 && res.flash === "That action is not available on this page.", "an unknown action is refused with a flash", res.flash);

  /* ── 8. Browser ──────────────────────────────────────────────────────── */
  section("8. browser: overflow, accessibility and the tv icon at 390 and 1440");
  browser = await chromium.launch();
  const origin = new URL(BASE).origin;
  const axe = async (pg) => {
    await pg.addScriptTag({ content: axeSource });
    return pg.evaluate(async () => {
      const out = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } });
      return out.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
    });
  };
  const overflow = (pg) => pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route((u) => u.origin === origin, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": IP.browser } }));
    const pg = await ctx.newPage();
    const errors = [];
    pg.on("pageerror", (e) => errors.push(e.message));
    pg.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await pg.goto(BASE + "/admin/login.php");
    await pg.fill("#username", "admin");
    await pg.fill("#password", "Admin@Test123");
    await Promise.all([pg.waitForURL(/\/admin\/(?!login)/), pg.press("#password", "Enter")]);
    for (const [label, path] of [["list", `${PAGE}?q=${q}`], ["live chip", `${PAGE}?f=live`], ["edit form", `${PAGE}?edit=${F.a.id}`], ["deleted list", `${PAGE}?f=deleted&q=${q}`]]) {
      await pg.goto(BASE + path, { waitUntil: "load" });
      await pg.waitForTimeout(400);
      check(!(await overflow(pg)), `${label} @${width}: no horizontal overflow`);
      const v = await axe(pg);
      check(v.length === 0, `${label} @${width}: no serious or critical axe violations`, v.slice(0, 5).join("\n      "));
    }
    // The create form: a drawer opened by the button on a phone, always open beside the list on a desktop.
    await pg.goto(`${BASE}${PAGE}?q=${q}`, { waitUntil: "load" });
    const toggle = pg.locator(".form-drawer-toggle").first();
    if (await toggle.isVisible()) {
      await toggle.click();
      await pg.waitForTimeout(400);
      check(await pg.locator("#live-form").isVisible(), `form drawer @${width}: opens with the New live stream button`);
    } else {
      check(await pg.locator("#live-form").isVisible(), `form @${width}: is open beside the list without a toggle`);
    }
    check(!(await overflow(pg)), `form drawer @${width}: no horizontal overflow`);
    const v = await axe(pg);
    check(v.length === 0, `form drawer @${width}: no serious or critical axe violations`, v.slice(0, 5).join("\n      "));
    if (width === 1440) {
      check((await pg.locator('a.sidebar__link[href="/admin/live_streams.php"] svg path[d="M8 21h8"]').count()) === 1, "the tv icon renders in the sidebar entry");
      check(await pg.locator('a.sidebar__link[href="/admin/live_streams.php"]').isVisible(), "…and the entry is visible");
      await pg.fill("#title_en", "Pournami Abhishekam – Live");
      check((await pg.inputValue("#slug")) === "pournami-abhishekam-live", "the slug follows the English title as it is typed", await pg.inputValue("#slug"));
      await pg.fill("#slug", "my-own");
      await pg.fill("#title_en", "Something else");
      check((await pg.inputValue("#slug")) === "my-own", "…until the admin edits it by hand");
    }
    check(errors.length === 0, `@${width}: no script errors`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  section("9. hygiene");
  check(phpNoise.length === 0, "no PHP warnings, notices or fatals from the fixtures", phpNoise.slice(0, 3).join(" | "));
  check(!/(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):/.test(server.log), "no PHP warnings, notices or fatals from the server", /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(server.log)?.[0]);
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  try {
    await deleteAccounts(owner);
    const removed = cleanup();
    console.log(`  cleanup at end: ${JSON.stringify(removed)}`);
    const left = one("SELECT (SELECT COUNT(*) FROM live_streams WHERE title_en LIKE ?) + (SELECT COUNT(*) FROM admin_users WHERE username LIKE ?) + (SELECT COUNT(*) FROM admin_activity WHERE actor LIKE ?) AS c", [`${CLEAN_PREFIX}%`, `${ADMIN_PREFIX}%`, `${ADMIN_PREFIX}%`]);
    check(Number(left?.c) === 0, "every stream, upload and account this suite created is removed", `left ${left?.c}`);
  } catch (e) {
    check(false, "cleanup ran", e.stack || String(e));
  }
  await stopServer();
  check(!(await portInUse(PHP_PORT)), `port ${PHP_PORT} is closed again`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
