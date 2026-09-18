#!/usr/bin/env node
/**
 * tests/live-api.mjs — the Live Darshan APIs end to end against a PHP server
 * this suite starts (docs/live/SPEC-PHASE1.md §6, second suite).
 *
 *   PHP_BIN=/path/to/php.sh node tests/live-api.mjs
 *
 * Ports: PHP on 8081, the YouTube mock on 8091 (both must be free; exit 2
 * otherwise). Requests carry X-Forwarded-For 10.84.0.1–99, so the server must
 * trust 127.0.0.1 (TRUSTED_PROXIES is set for it here). LIVE_ROUTER names the
 * router the server runs (default backend/router.php; the stage-A build used a
 * throwaway router that carried the §4.3 routing block before api/index.php did).
 *
 * What it proves:
 *   1. the public API (§4.3): index, live (LIVE first, then STARTING, nothing
 *      else), upcoming (soonest first; past, DRAFT, CANCELLED, COMPLETED and
 *      deleted streams excluded; a NULL start last; the limit capped at 50 and
 *      nonsense limits ignored), one stream by id and by slug in the same shape
 *      (digits are an id), 404 for a DRAFT, deleted or unknown stream, 405 with
 *      Allow for anything but GET/HEAD, the JSON content type, the cache-control
 *      values, no cookie on any answer, script in a title escaped, the private
 *      columns absent, server_time in ISO-8601 Z;
 *   2. the admin API (§4.4): 401 JSON without a session (never a redirect), the
 *      CSRF token from GET, 403 csrf without the header, 201 on create with
 *      created_by = the signed-in user, edit, 409 for an illegal status jump,
 *      an audited legal one, soft delete that vanishes from the public API, a
 *      viewer reading but never writing, an editor creating and publishing, a
 *      forced password change refused with its own code, hostile bodies
 *      answered 422 and never 500;
 *   3. /api/events, /api/homepage_widgets and /api/search still answer as
 *      before; the YouTube mock (tests/support/youtube_mock.mjs) starts and
 *      answers its scenarios; no request answers 5xx; the server logs no PHP
 *      warning;
 *   4. Phase 2 (docs/live/SPEC-PHASE2.md §3): /api/live-streams/schedule with
 *      fixtures across today / tomorrow / this week / next week / past /
 *      festival / live / completed-today / draft / deleted — every filter's
 *      membership and order, the counts, the ISO window, the limit cap,
 *      filter=bogus → all, the cache header, the item shape (public keys plus
 *      day_bucket and starts_in_seconds), and now / next on the index route.
 *
 * Creates streams titled "E2E-LIVE-api<run> …" (slugs e2e-live-api<run>-<n>),
 * two committee accounts e2e_live_viewer / e2e_live_editor, and removes them,
 * their admin_activity rows and this suite's rate-limit buckets at the end.
 */

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startYoutubeMock, portInUse } from "./support/youtube_mock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const ROUTER = process.env.LIVE_ROUTER || "backend/router.php";
const PORT = { php: Number(process.env.LIVE_PORT || 8081), mock: Number(process.env.LIVE_MOCK_PORT || 8091) };
const BASE = `http://127.0.0.1:${PORT.php}`;
const RUN = `api${Date.now().toString(36)}`;
const PREFIX = `E2E-LIVE-${RUN}`;      // titles: E2E-LIVE-<run> …
const SLUG = `e2e-live-${RUN}`;        // slugs: e2e-live-<run>-<n>
const CLEAN_PREFIX = "E2E-LIVE-api";   // every earlier run of this suite, never another suite's rows
const ADMIN_PREFIX = "e2e_live_";
const ACCOUNTS = {
  viewer: { username: "e2e_live_viewer", issued: "ViewOnly123X", password: "QuietWatch42B" },
  editor: { username: "e2e_live_editor", issued: "Kolam99Deep", password: "Vilakku42Raja" },
};
// Addresses: our own 10.84.0.1–99 block.
const IP = { public: "10.84.0.10", methods: "10.84.0.11", hostile: "10.84.0.12", admin: "10.84.0.20", viewer: "10.84.0.21", editor: "10.84.0.22", regress: "10.84.0.30" };
const YT = "dQw4w9WgXcQ";
const EMBED = (id) => `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`;
const WATCH = (id) => `https://www.youtube.com/watch?v=${id}`;
const THUMB = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const PUBLIC_KEYS = ["id", "slug", "title_ta", "title_en", "description_ta", "description_en", "event_type", "event_type_label", "provider", "status", "is_live",
  "temple", "deity", "scheduled_start_at", "scheduled_end_at", "actual_start_at", "actual_end_at", "timezone", "local", "thumbnail_url", "banner_url", "playback", "viewers", "flags"].sort();
const ADMIN_KEYS = [...PUBLIC_KEYS, "created_by", "updated_by", "created_at", "updated_at", "deleted_at", "provider_broadcast_id", "playback_url_raw", "temple_id", "deity_id"].sort();
const ADMIN_TOLERATED_EXTRAS = ["thumbnail_url_raw"];
const PRIVATE_KEYS = ["provider_stream_id", "viewer_count", "last_sync_ok_at", "sync_error", "next_sync_at", "created_by", "updated_by", "deleted_at", "temple_id", "deity_id", "provider_broadcast_id", "playback_url", "created_at", "updated_at", "recording_url"];
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const XSS = '"><script>alert(1)</script>';

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v))?.slice(0, 600) ?? String(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keysOf = (o) => Object.keys(o ?? {}).sort();
const sameKeys = (o, keys) => JSON.stringify(keysOf(o)) === JSON.stringify(keys);
const idsOf = (list) => (list ?? []).map((s) => Number(s?.id));
/** A wall-clock 'YYYY-MM-DD HH:MM' in IST, some minutes from now. */
const istLocal = (offsetMinutes = 0) => {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + offsetMinutes * 60 * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
};
const istDate = (offsetDays) => istLocal(offsetDays * 24 * 60).slice(0, 10);
const utcIso = (mysql) => (mysql ? `${String(mysql).replace(" ", "T")}Z` : null);

/* ── PHP processes ─────────────────────────────────────────────────────── */
function phpCommand(args) {
  const viaBash = /\.sh$/i.test(PHP_BIN);
  return viaBash ? ["bash", [PHP_BIN, ...args]] : [PHP_BIN, args];
}
const STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i; // no real YouTube key or LIVE_CRON_KEY from the shell reaches a PHP child (SPEC-PHASE3 §11.4)
function phpEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return { ...env, TRUSTED_PROXIES: "127.0.0.1,::1", SITE_URL: BASE, CORS_ORIGIN: "*", ...extra };
}
const phpNoise = [];
function notePhpNoise(label, text) {
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(text);
  if (m) phpNoise.push(`${label}: ${m[0]}`);
}
/** One fixture command; the JSON argument travels on stdin, so nothing is quoted for a shell. */
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
const streamRow = (id) => one("SELECT * FROM live_streams WHERE id = ?", [id]);
const activity = (id) => rows("SELECT actor, action, subject, detail FROM admin_activity WHERE subject = ? ORDER BY id", [`Stream #${id}`]);
const countTitled = (title) => Number(one("SELECT COUNT(*) AS c FROM live_streams WHERE title_en = ?", [title])?.c ?? 0);

/* ── The PHP server ────────────────────────────────────────────────────── */
let server = null;
function startPhpServer() {
  const [cmd, argv] = phpCommand(["-S", `127.0.0.1:${PORT.php}`, "-t", "backend", ROUTER]);
  const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(), windowsHide: true });
  const s = { child, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (s.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (s.log += d));
  return s;
}
async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/pulse`);
      if (res.ok) return true;
    } catch { /* not listening yet */ }
    await sleep(250);
  }
  return false;
}
async function stopPhpServer(s) {
  if (!s) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(s.child.pid), "/T", "/F"], { windowsHide: true });
  else s.child.kill("SIGTERM");
  for (let i = 0; i < 20 && (await portInUse(PORT.php)); i += 1) await sleep(250);
  if ((await portInUse(PORT.php)) && process.platform === "win32") {
    // The port is this suite's own; whatever still holds it is our server.
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === `127.0.0.1:${PORT.php}` && cols[3] === "LISTENING") spawnSync("taskkill", ["/pid", cols[4], "/T", "/F"], { windowsHide: true });
    }
    for (let i = 0; i < 20 && (await portInUse(PORT.php)); i += 1) await sleep(250);
  }
}

/* ── HTTP ──────────────────────────────────────────────────────────────── */
const cookiesSet = [];
const serverErrors = [];
async function http(method, path, { json, raw, ip = IP.public, headers = {}, cookie = "" } = {}) {
  const h = { "X-Forwarded-For": ip, ...headers };
  if (cookie) h.cookie = cookie;
  let body;
  if (raw !== undefined) {
    h["content-type"] = "application/json";
    body = raw;
  } else if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, { method, headers: h, body, redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const setCookie = res.headers.get("set-cookie");
  // Neither API may hand out a cookie: the public one has no session, the admin one only ever reads the admin's.
  if (setCookie && path.startsWith("/api/live-streams")) cookiesSet.push(`${method} ${path} → ${res.status}: ${setCookie}`);
  if (setCookie && path.startsWith("/api/admin/")) cookiesSet.push(`${method} ${path} → ${res.status}: ${setCookie}`);
  if (res.status >= 500) serverErrors.push(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return { status: res.status, headers: res.headers, text, data };
}
const pub = (path, opts = {}) => http("GET", path, opts);
const isJson = (r) => r.headers.get("content-type") === "application/json; charset=utf-8";
const cache = (r) => r.headers.get("cache-control") ?? "";
const isNotFound = (r) => r.status === 404 && r.text === '{"error":"Not found"}';
const hasPublicShape = (s) => sameKeys(s, PUBLIC_KEYS) && PRIVATE_KEYS.every((k) => !(k in (s ?? {})));

/** A cookie jar for one admin session (the pattern of admin-roles.mjs). */
function jar(ip) {
  let cookie = "";
  const grab = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  return {
    async get(path) { const r = await fetch(BASE + path, { headers: { cookie, "X-Forwarded-For": ip }, redirect: "manual" }); grab(r); return r; },
    async post(path, body) {
      const r = await fetch(BASE + path, { method: "POST", headers: { cookie, "X-Forwarded-For": ip, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), redirect: "manual" });
      grab(r); return r;
    },
    /** The admin JSON API with this session's cookie. */
    api(method, path, opts = {}) { return http(method, path, { ...opts, ip, cookie }); },
    get cookie() { return cookie; },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
async function login(session, username, password) {
  const page = await session.get("/admin/login.php");
  const csrf = csrfOf(await page.text());
  return session.post("/admin/login.php", { _csrf: csrf, username, password, next: "" });
}
/** Create a committee account as the owner, sign it in, and get past the forced password change. */
async function makeAccount(owner, role, ip) {
  const acct = ACCOUNTS[role];
  const usersHtml = await (await owner.get("/admin/users.php")).text();
  const created = await owner.post("/admin/users.php", {
    _csrf: csrfOf(usersHtml), action: "save", id: "0", username: acct.username, display_name: `E2E Live ${role}`, email: "", phone: "",
    role, password: acct.issued, is_active: "1",
  });
  check(created.status === 303, `the owner creates the ${role} account ${acct.username}`, `status ${created.status}`);
  const session = jar(ip);
  const first = await login(session, acct.username, acct.issued);
  check(first.status === 302 && (first.headers.get("location") || "").includes("must_change=1"), `${role}: the issued password forces a change on first sign-in`, first.headers.get("location") || `status ${first.status}`);
  return { session, acct };
}
async function finishPasswordChange(session, acct, role) {
  const prof = await (await session.get("/admin/profile.php")).text();
  const r = await session.post("/admin/profile.php", { _csrf: csrfOf(prof), action: "password", current_password: acct.issued, new_password: acct.password, confirm_password: acct.password });
  check(r.status === 303, `${role}: the password change succeeds`, `status ${r.status}`);
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */
let fixtureN = 0;
const mk = (label, over = {}) => {
  fixtureN += 1;
  return fixture("create-stream", { title_prefix: PREFIX, label, slug: `${SLUG}-${fixtureN}`, actor: "e2e", ...over });
};
function cleanup() {
  return fixture("cleanup", { title_prefix: CLEAN_PREFIX, admin_prefix: ADMIN_PREFIX, ips: Object.values(IP) });
}

/* ── Run ───────────────────────────────────────────────────────────────── */
console.log(`live-api — run ${RUN}, PHP ${PHP_BIN}, router ${ROUTER}`);
const busy = [];
for (const port of Object.values(PORT)) if (await portInUse(port)) busy.push(port);
if (busy.length) {
  console.error(`Ports already in use: ${busy.join(", ")}. Another run of this suite may still be going; nothing was changed.`);
  process.exit(2);
}
let probe;
try {
  probe = fixture("probe");
  if (!probe.tables) {
    console.error("✗ the live streaming tables are missing; apply database/migrations/011_live_streams.sql first.");
    process.exit(2);
  }
  if (!probe.viewer_columns) {
    console.error("✗ the viewer tests require migration 012_live_automation.sql.");
    process.exit(2);
  }
  console.log(`leftovers removed at start: ${show(cleanup())}`);
} catch (e) {
  console.error(`✗ the fixtures cannot reach the database or the live module: ${e.message}`);
  process.exit(2);
}
const templeId = Number(probe.temple?.id);
const deityId = (slug) => Number((probe.deities ?? []).find((d) => d.slug === slug)?.id ?? 0);

let mock = null;
const F = {};
const owner = jar(IP.admin);
try {
  server = startPhpServer();
  if (!(await waitForServer())) {
    check(false, `the PHP server answers /api/pulse on ${PORT.php}`, server?.log.slice(0, 600));
    throw new Error("no PHP server");
  }
  const routed = await pub("/api/live-streams");
  if (routed.status === 404 && routed.text === '{"error":"Not found"}' && !("live" in (routed.data ?? {}))) {
    check(false, "GET /api/live-streams is routed (the §4.3 block in api/index.php, or LIVE_ROUTER for the stage-A build)", `${routed.status} ${routed.text}`);
    throw new Error("the live routes are not wired");
  }

  /* ── Fixtures ──────────────────────────────────────────────────────── */
  section("Fixtures");
  F.live = mk("Live now", { status: "LIVE", deity_slug: "renukadevi", scheduled_start_local: istLocal(-60), scheduled_end_local: istLocal(60), flags: { featured: true, showOnHomepage: true } });
  F.starting = mk("Starting soon", { status: "STARTING", scheduled_start_local: istLocal(10), scheduled_end_local: istLocal(70) });
  F.future = mk("Tomorrow evening", { status: "SCHEDULED", deity_slug: "lingammal", scheduled_start_local: `${istDate(1)} 18:00`, scheduled_end_local: `${istDate(1)} 19:30` });
  F.xss = mk("XSS", { status: "SCHEDULED", scheduled_start_local: `${istDate(1)} 20:00`, title_en: `${PREFIX} ${XSS} XSS`, title_ta: `${PREFIX} <img src=x onerror=alert(1)> தரிசனம்`, description_en: `<svg/onload=alert(1)>desc ${XSS}`, description_ta: `விளக்கம் ${XSS}` });
  F.future2 = mk("Day after", { status: "SCHEDULED", scheduled_start_local: `${istDate(2)} 06:00` });
  F.past = mk("Yesterday", { status: "SCHEDULED", scheduled_start_local: `${istDate(-1)} 18:00` });
  F.completed = mk("Ended", { status: "COMPLETED", scheduled_start_local: istLocal(-180), scheduled_end_local: istLocal(-120) });
  F.cancelled = mk("Cancelled", { status: "CANCELLED", scheduled_start_local: `${istDate(1)} 09:00` });
  F.draft = mk("Draft", { status: "DRAFT", provider_reference: "" });
  F.deleted = mk("Deleted", { status: "SCHEDULED", scheduled_start_local: `${istDate(1)} 10:00`, deleted: true });
  F.nostart = mk("No start", { status: "SCHEDULED", scheduled_start_local: `${istDate(3)} 10:00` });
  sql("UPDATE live_streams SET scheduled_start_at = NULL, scheduled_end_at = NULL WHERE id = ?", [F.nostart.id]);
  // Still SCHEDULED half an hour after its start (the committee is late pressing Go live): listed, and first.
  F.late = mk("Running late", { status: "SCHEDULED", scheduled_start_local: istLocal(-30) });
  const mine = Object.values(F).map((f) => f.id);
  const onlyMine = (list) => idsOf(list).filter((id) => mine.includes(id));
  check(Object.values(F).every((f) => f.id > 0 && f.slug.startsWith(SLUG)), "twelve fixtures created through the module's own write path", show(F));
  check(F.live.status === "LIVE" && F.starting.status === "STARTING" && F.completed.status === "COMPLETED" && F.cancelled.status === "CANCELLED" && F.draft.status === "DRAFT" && F.deleted.deleted_at !== null, "…in the statuses asked for", show(Object.fromEntries(Object.entries(F).map(([k, v]) => [k, v.status]))));
  check(F.live.actual_start_at !== null && F.completed.actual_end_at !== null, "going LIVE stamped actual_start_at and ending stamped actual_end_at");

  /* ── 1. Public API ─────────────────────────────────────────────────── */
  section("1a. GET /api/live-streams (index)");
  let r = await pub("/api/live-streams");
  check(r.status === 200 && isJson(r), "200 with content-type application/json; charset=utf-8", `${r.status} ${r.headers.get("content-type")}`);
  check(sameKeys(r.data, ["live", "next", "now", "server_time", "upcoming"]), "exactly live, upcoming, now, next, server_time (now/next per SPEC-PHASE2 §1.1)", keysOf(r.data).join(","));
  check(cache(r) === "no-store, private", "Cache-Control: no-store, private", cache(r));
  check(r.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
  check(ISO_Z.test(r.data?.server_time ?? "") && Math.abs(Date.parse(r.data.server_time) - Date.now()) < 60_000, "server_time is ISO-8601 Z and now", r.data?.server_time);
  check(JSON.stringify(onlyMine(r.data?.live)) === JSON.stringify([F.live.id, F.starting.id]), "live lists the LIVE stream first, then the STARTING one", show(onlyMine(r.data?.live)));
  check(!idsOf(r.data?.upcoming).some((id) => [F.past.id, F.draft.id, F.cancelled.id, F.completed.id, F.deleted.id, F.live.id, F.starting.id].includes(id)), "upcoming excludes the past, DRAFT, CANCELLED, COMPLETED, deleted and live streams", show(onlyMine(r.data?.upcoming)));
  check(onlyMine(r.data?.upcoming)[0] === F.late.id, "a SCHEDULED stream 30 min past its start (no end, within the 3 h grace) is still upcoming, and first", show(onlyMine(r.data?.upcoming)));
  check((r.data?.upcoming ?? []).length <= 10, "upcoming on the index is at most 10 streams", String((r.data?.upcoming ?? []).length));
  const liveItem = (r.data?.live ?? []).find((s) => s.id === F.live.id);
  check(hasPublicShape(liveItem), "a live item has exactly the §4.3 keys and none of the private ones", keysOf(liveItem).join(","));
  check(liveItem?.is_live === true && liveItem?.status === "LIVE" && liveItem?.provider === "youtube", "is_live true, status LIVE, provider youtube");
  check(liveItem?.slug === F.live.slug && liveItem?.title_en === `${PREFIX} Live now` && /\p{Script=Tamil}/u.test(liveItem?.title_ta ?? ""), "slug and both titles", show([liveItem?.slug, liveItem?.title_en, liveItem?.title_ta]));
  check(JSON.stringify(liveItem?.playback) === JSON.stringify({ kind: "iframe", embedUrl: EMBED(YT), watchUrl: WATCH(YT) }), "playback is {kind iframe, embedUrl nocookie …?rel=0&playsinline=1, watchUrl}", show(liveItem?.playback));
  check(liveItem?.thumbnail_url === THUMB(YT) && liveItem?.banner_url === null, "thumbnail_url defaults to hqdefault.jpg; banner_url null", show([liveItem?.thumbnail_url, liveItem?.banner_url]));
  check(liveItem?.temple?.slug === "pudupatti" && sameKeys(liveItem?.temple, ["name_en", "name_ta", "short_name_en", "short_name_ta", "slug"]) && /\p{Script=Tamil}/u.test(liveItem?.temple?.name_ta ?? ""), "temple is {slug, name_ta, name_en, short_name_ta, short_name_en}", show(liveItem?.temple));
  check(liveItem?.deity?.slug === "renukadevi" && sameKeys(liveItem?.deity, ["name_en", "name_ta", "slug"]), "deity is {slug, name_ta, name_en}", show(liveItem?.deity));
  check(JSON.stringify(liveItem?.event_type_label) === JSON.stringify({ ta: "நேரடி தரிசனம்", en: "Live darshan" }) && liveItem?.event_type === "live_darshan", "event_type_label carries both languages", show(liveItem?.event_type_label));
  check(liveItem?.scheduled_start_at === utcIso(F.live.scheduled_start_at) && liveItem?.actual_start_at === utcIso(F.live.actual_start_at) && liveItem?.actual_end_at === null && ISO_Z.test(liveItem?.scheduled_end_at ?? ""), "instants are the stored UTC times as ISO-8601 Z, null when unset", show([liveItem?.scheduled_start_at, liveItem?.actual_start_at, liveItem?.actual_end_at]));
  check(liveItem?.timezone === "Asia/Kolkata" && liveItem?.local?.date === istLocal(-60).slice(0, 10) && liveItem?.local?.start_time === istLocal(-60).slice(11, 16) && liveItem?.local?.end_time === istLocal(60).slice(11, 16), "local is the IST wall clock {date, start_time, end_time}", show(liveItem?.local));
  check(JSON.stringify(liveItem?.flags) === JSON.stringify({ featured: true, showOnHomepage: true, donations: true, notifications: true, sharing: true, archive: true }), "flags are booleans keyed featured, showOnHomepage, donations, notifications, sharing, archive", show(liveItem?.flags));
  check(liveItem?.viewers === null, "viewers is null when YouTube has not reported a figure (SPEC-PHASE4 §1)", show(liveItem?.viewers));

  section("1a′. viewers (SPEC-PHASE4 §1): public only while LIVE and fresh");
  const viewersOf = async (id) => (await pub(`/api/live-streams/${id}`)).data?.stream?.viewers;
  sql("UPDATE live_streams SET viewer_count = 42, last_sync_ok_at = UTC_TIMESTAMP() WHERE id IN (?, ?)", [F.live.id, F.starting.id]);
  check((await viewersOf(F.live.id)) === 42, "a LIVE row with viewer_count 42 and a fresh last_sync_ok_at answers viewers 42", show(await viewersOf(F.live.id)));
  check((await viewersOf(F.starting.id)) === null, "…the STARTING row with the same columns answers null");
  sql("UPDATE live_streams SET last_sync_ok_at = UTC_TIMESTAMP() - INTERVAL 6 MINUTE WHERE id = ?", [F.live.id]);
  check((await viewersOf(F.live.id)) === null, "…and null once the last good check is 6 minutes old");
  sql("UPDATE live_streams SET viewer_count = NULL, last_sync_ok_at = NULL WHERE id IN (?, ?)", [F.live.id, F.starting.id]);
  check((await viewersOf(F.live.id)) === null, "…and null again with no figure (never zero-filled)");

  section("1b. GET /api/live-streams/live");
  r = await pub("/api/live-streams/live");
  check(r.status === 200 && isJson(r) && sameKeys(r.data, ["server_time", "streams"]), "200 with streams and server_time", `${r.status} ${keysOf(r.data)}`);
  check(cache(r) === "no-store, private", "Cache-Control: no-store, private", cache(r));
  check(JSON.stringify(onlyMine(r.data?.streams)) === JSON.stringify([F.live.id, F.starting.id]), "LIVE first, then STARTING, and nothing else of ours", show(onlyMine(r.data?.streams)));
  check((r.data?.streams ?? []).every((s) => ["LIVE", "STARTING"].includes(s.status) && s.is_live === true), "every stream listed is LIVE or STARTING with is_live true");
  const startingItem = (r.data?.streams ?? []).find((s) => s.id === F.starting.id);
  check(startingItem?.deity === null && hasPublicShape(startingItem), "a stream without a deity has deity null and the same shape", show(startingItem?.deity));

  section("1c. GET /api/live-streams/upcoming");
  r = await pub("/api/live-streams/upcoming?limit=50");
  check(r.status === 200 && isJson(r) && sameKeys(r.data, ["server_time", "streams"]), "200 with streams and server_time", `${r.status} ${keysOf(r.data)}`);
  check(cache(r) === "public, max-age=60", "Cache-Control: public, max-age=60", cache(r));
  const up = onlyMine(r.data?.streams);
  check(JSON.stringify(up.filter((id) => id !== F.nostart.id)) === JSON.stringify([F.late.id, F.future.id, F.xss.id, F.future2.id]), "our SCHEDULED streams come soonest first (the one running late leads)", show(up));
  check(up.includes(F.nostart.id) && up[up.length - 1] === F.nostart.id, "a SCHEDULED stream without a start time is listed last", show(up));
  check(!up.some((id) => [F.past.id, F.draft.id, F.cancelled.id, F.completed.id, F.deleted.id, F.live.id, F.starting.id].includes(id)), "past (beyond start + 3 h), DRAFT, CANCELLED, COMPLETED, deleted and live streams are excluded", show(up));
  const starts = (r.data?.streams ?? []).map((s) => s.scheduled_start_at).filter(Boolean);
  check(starts.every((t, i) => i === 0 || t >= starts[i - 1]) && starts.every((t) => Date.parse(t) >= Date.now() - 3 * 3600 * 1000), "the whole list is ascending and nothing started more than 3 h ago");
  sql("UPDATE live_streams SET scheduled_start_at = ? WHERE id = ?", [istLocal(-200).replace(/^(\S+) (\S+)$/, (m, d, t) => new Date(`${d}T${t}:00+05:30`).toISOString().slice(0, 19).replace("T", " ")), F.late.id]);
  r = await pub("/api/live-streams/upcoming?limit=50");
  check(!idsOf(r.data?.streams).includes(F.late.id), "…once its start is more than 3 h ago (and no end was given) it drops out", show(onlyMine(r.data?.streams)));
  sql("UPDATE live_streams SET scheduled_end_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 20 MINUTE) WHERE id = ?", [F.late.id]);
  r = await pub("/api/live-streams/upcoming?limit=50");
  check(idsOf(r.data?.streams)[0] === F.late.id || onlyMine(r.data?.streams)[0] === F.late.id, "…but an end time still ahead keeps it listed however long ago it started", show(onlyMine(r.data?.streams)));
  sql("UPDATE live_streams SET scheduled_end_at = NULL, scheduled_start_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) WHERE id = ?", [F.late.id]);
  check((r.data?.streams ?? []).every((s) => s.status === "SCHEDULED" && s.is_live === false), "every upcoming stream is SCHEDULED");
  r = await pub("/api/live-streams/upcoming");
  check(r.status === 200 && (r.data?.streams ?? []).length <= 10, "the default limit is 10", String((r.data?.streams ?? []).length));
  r = await pub("/api/live-streams/upcoming?limit=1");
  check(r.status === 200 && (r.data?.streams ?? []).length === 1, "limit=1 gives one");
  r = await pub("/api/live-streams/upcoming?limit=9999");
  check(r.status === 200 && (r.data?.streams ?? []).length <= 50, "limit=9999 is capped at 50", String((r.data?.streams ?? []).length));
  for (const bad of ["abc", "-1", "0", "1e3", "%22%3E%3Cscript%3E", "[]=1"]) {
    r = await pub(`/api/live-streams/upcoming?limit=${bad}`);
    check(r.status === 200 && Array.isArray(r.data?.streams), `limit=${bad} is ignored, not a 500`, `${r.status} ${r.text.slice(0, 120)}`);
  }

  section("1d. one stream by id and by slug");
  const byId = await pub(`/api/live-streams/${F.future.id}`);
  const bySlug = await pub(`/api/live-streams/${F.future.slug}`);
  check(byId.status === 200 && isJson(byId) && sameKeys(byId.data, ["server_time", "stream"]), "GET /:id → 200 {stream, server_time}", `${byId.status} ${keysOf(byId.data)}`);
  check(bySlug.status === 200 && JSON.stringify(bySlug.data?.stream) === JSON.stringify(byId.data?.stream), "GET /:slug answers the same stream in the same shape");
  check(cache(byId) === "public, max-age=60" && cache(bySlug) === "public, max-age=60", "both are public, max-age=60", `${cache(byId)} | ${cache(bySlug)}`);
  const future = byId.data?.stream;
  check(hasPublicShape(future) && future?.id === F.future.id && future?.status === "SCHEDULED" && future?.is_live === false, "the SCHEDULED stream has the public shape, is_live false", keysOf(future).join(","));
  check(future?.local?.date === istDate(1) && future?.local?.start_time === "18:00" && future?.local?.end_time === "19:30" && future?.scheduled_start_at === utcIso(F.future.scheduled_start_at), "its schedule: tomorrow 18:00–19:30 IST, stored as UTC", show([future?.local, future?.scheduled_start_at]));
  check(future?.deity?.slug === "lingammal" && future?.actual_start_at === null && future?.actual_end_at === null, "deity lingammal, no actual times yet");
  check(JSON.stringify(future?.playback) === JSON.stringify({ kind: "iframe", embedUrl: EMBED(YT), watchUrl: WATCH(YT) }), "a scheduled stream already carries its playback descriptor (the page decides when to mount it)");
  r = await pub(`/api/live-streams/${F.future.slug.toUpperCase()}`);
  check(isNotFound(r), "a slug in capitals is not a route (the regex is lowercase) → 404", `${r.status} ${r.text.slice(0, 80)}`);
  for (const [label, path] of [
    ["a DRAFT stream by slug", `/api/live-streams/${F.draft.slug}`],
    ["a DRAFT stream by id", `/api/live-streams/${F.draft.id}`],
    ["a deleted stream by slug", `/api/live-streams/${F.deleted.slug}`],
    ["a deleted stream by id", `/api/live-streams/${F.deleted.id}`],
    ["an unknown slug", `/api/live-streams/${SLUG}-nope`],
    ["an unknown id", "/api/live-streams/999999999"],
    ["id 0", "/api/live-streams/0"],
    ["an eleven-digit id", "/api/live-streams/99999999999"],
    ["a sub-path", `/api/live-streams/${F.future.slug}/x`],
    ["a slug starting with a hyphen", "/api/live-streams/-abc"],
    ["a slug of one character", "/api/live-streams/a"],
    ["a slug with a dot", "/api/live-streams/a.b"],
    ["a slug of 120 characters", `/api/live-streams/${"a".repeat(120)}`],
    ["script in the path", `/api/live-streams/${encodeURIComponent(XSS)}`],
    ["a near miss on the collection name", "/api/live-streamsx"],
    ["a near miss under /api/admin/", "/api/admin/live-streamz"],
  ]) {
    r = await pub(path, { ip: IP.hostile });
    check(isNotFound(r), `${label} → 404 {"error":"Not found"}`, `${r.status} ${r.text.slice(0, 120)}`);
  }
  r = await pub("/api/live-streams/archive");
  check(r.status === 200 && isJson(r) && sameKeys(r.data, ["event_types", "has_more", "page", "server_time", "streams", "timezone"])
    && Array.isArray(r.data?.streams) && r.data.page === 1 && typeof r.data.has_more === "boolean",
    "GET /archive → 200 with the paginated archive contract", `${r.status} ${r.text.slice(0, 300)}`);
  r = await pub(`/api/live-streams/${F.completed.slug}`);
  check(r.status === 200 && r.data?.stream?.status === "COMPLETED" && r.data.stream.actual_end_at !== null && r.data.stream.is_live === false, "a COMPLETED stream is public with its actual_end_at", show(r.data?.stream?.status));
  r = await pub(`/api/live-streams/${F.cancelled.slug}`);
  check(r.status === 200 && r.data?.stream?.status === "CANCELLED", "a CANCELLED stream is public by slug");
  r = await pub(`/api/live-streams/${F.past.id}`);
  check(r.status === 200 && r.data?.stream?.status === "SCHEDULED", "a past SCHEDULED stream is still reachable by id (only the lists hide it)");
  r = await pub(`/api/live-streams/${F.nostart.id}`);
  check(r.status === 200 && r.data?.stream?.scheduled_start_at === null && r.data?.stream?.local?.date === null && r.data?.stream?.local?.start_time === null, "a stream without a schedule answers nulls, not a 500", show(r.data?.stream?.local));

  section("1e. script in a title is escaped, private columns are absent");
  r = await pub(`/api/live-streams/${F.xss.id}`);
  check(r.status === 200 && !r.text.includes("<script>") && !r.text.includes("onerror") && !r.text.includes("<svg"), "no raw <script>, onerror or <svg in the JSON", r.text.slice(0, 300));
  check(r.data?.stream?.title_en?.includes('">') && r.data?.stream?.title_en?.includes("alert(1)") && !r.data.stream.title_en.includes("<"), "tags were stripped on save, the rest is carried as text and JSON-escaped", show(r.data?.stream?.title_en));
  check(/\p{Script=Tamil}/u.test(r.data?.stream?.title_ta ?? "") && !(r.data?.stream?.title_ta ?? "").includes("<"), "the Tamil title survives without its tag", show(r.data?.stream?.title_ta));
  const allText = [byId.text, bySlug.text, r.text].join("");
  check(!/"(provider_stream_id|created_by|updated_by|deleted_at|temple_id|deity_id|provider_broadcast_id|playback_url|recording_url)"/.test(allText), "no private column name appears anywhere in the public JSON");
  check(!allText.includes('"e2e"'), "the fixture actor's name (created_by) is nowhere in the public JSON");

  section("1f. methods, HEAD, cookies");
  for (const path of ["/api/live-streams", "/api/live-streams/live", "/api/live-streams/upcoming", `/api/live-streams/${F.future.id}`, `/api/live-streams/${F.future.slug}`]) {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      r = await http(method, path, { json: {}, ip: IP.methods });
      check(r.status === 405 && r.data?.error === "Method not allowed" && r.headers.get("allow") === "GET, HEAD", `${method} ${path} → 405 with Allow: GET, HEAD`, `${r.status} ${r.headers.get("allow")} ${r.text.slice(0, 100)}`);
    }
  }
  r = await http("HEAD", "/api/live-streams/live", { ip: IP.methods });
  check(r.status === 200, "HEAD /live → 200", `${r.status}`);
  r = await http("HEAD", `/api/live-streams/${F.draft.id}`, { ip: IP.methods });
  check(r.status === 404, "HEAD of a DRAFT → 404", `${r.status}`);
  r = await http("OPTIONS", "/api/live-streams", { ip: IP.methods });
  check(r.status === 204 || r.status === 200 || r.status === 405, "OPTIONS is answered (CORS preflight or 405), never 5xx", `${r.status}`);
  r = await pub("/api/live-streams", { headers: { cookie: "PHPSESSID=abcdefghijklmnopqrstuvwxyz" } });
  check(r.status === 200 && !r.headers.get("set-cookie"), "a public request carrying a stray cookie is answered without touching sessions", r.headers.get("set-cookie") ?? "");
  check(cookiesSet.length === 0, "no public response set a cookie so far", cookiesSet.slice(0, 3).join(" | "));

  /* ── 2. Admin API ──────────────────────────────────────────────────── */
  section("2a. without a session");
  r = await http("GET", "/api/admin/live-streams", { ip: IP.admin });
  check(r.status === 401 && isJson(r) && r.data?.error === "Sign in to the admin first" && r.data?.code === "unauthenticated", 'GET without a cookie → 401 {"error":"Sign in to the admin first","code":"unauthenticated"}', `${r.status} ${r.text.slice(0, 160)}`);
  check(!r.headers.get("location"), "…and not a redirect to the login page");
  check(!r.headers.get("set-cookie"), "…and no session cookie is handed out", r.headers.get("set-cookie") ?? "");
  check(cache(r).includes("no-store"), "…with Cache-Control no-store", cache(r));
  r = await http("POST", "/api/admin/live-streams", { json: { title_en: "x" }, ip: IP.admin });
  check(r.status === 401 && r.data?.code === "unauthenticated", "POST without a cookie → 401");
  r = await http("PUT", `/api/admin/live-streams/${F.future.id}`, { json: { title_en: "x" }, ip: IP.admin });
  check(r.status === 401 && r.data?.code === "unauthenticated", "PUT without a cookie → 401");
  r = await http("DELETE", `/api/admin/live-streams/${F.future.id}`, { ip: IP.admin });
  check(r.status === 401 && r.data?.code === "unauthenticated" && streamRow(F.future.id)?.deleted_at === null, "DELETE without a cookie → 401 and deletes nothing");
  r = await http("GET", "/api/admin/live-streams", { ip: IP.admin, cookie: "PHPSESSID=nonsensenonsensenonsense00" });
  check(r.status === 401 && r.data?.code === "unauthenticated", "a cookie that is not a session → 401 JSON", `${r.status} ${r.text.slice(0, 120)}`);

  section("2b. the owner signs in: GET list, csrf, filters, shape");
  const signedIn = await login(owner, "admin", "Admin@Test123");
  check(signedIn.status === 302, "the owner signs in through /admin/login.php", `status ${signedIn.status}`);
  r = await owner.api("GET", `/api/admin/live-streams?q=${encodeURIComponent(PREFIX)}`);
  check(r.status === 200 && isJson(r) && sameKeys(r.data, ["csrf", "page", "pages", "streams", "total"]), "GET → 200 {streams, total, pages, page, csrf}", `${r.status} ${keysOf(r.data)}`);
  const csrf = r.data?.csrf ?? "";
  check(/^[0-9a-f]{64}$/.test(csrf), "csrf is the session's 64-hex token", csrf.slice(0, 12));
  check(cache(r) === "no-store, private" && r.headers.get("x-content-type-options") === "nosniff", "Cache-Control no-store, private and nosniff", cache(r));
  check(!r.headers.get("access-control-allow-credentials"), "CORS is not widened with credentials");
  check(!r.headers.get("set-cookie"), "an authenticated answer sets no cookie");
  const listed = idsOf(r.data?.streams).sort((a, b) => a - b);
  const expectedAll = mine.filter((id) => id !== F.deleted.id).sort((a, b) => a - b);
  check(JSON.stringify(listed) === JSON.stringify(expectedAll) && r.data?.total === expectedAll.length, "the list (f=all) holds every non-deleted fixture, DRAFT included, and total matches", show([listed, r.data?.total]));
  const adminLive = (r.data?.streams ?? []).find((s) => s.id === F.live.id);
  check(ADMIN_KEYS.every((k) => k in (adminLive ?? {})), "the admin shape carries the public keys plus the §4.4 admin keys", ADMIN_KEYS.filter((k) => !(k in (adminLive ?? {}))).join(","));
  const extras = keysOf(adminLive).filter((k) => !ADMIN_KEYS.includes(k) && !ADMIN_TOLERATED_EXTRAS.includes(k));
  check(extras.length === 0, "…and nothing else", extras.join(","));
  check(adminLive?.created_by === "e2e" && adminLive?.updated_by === "e2e" && adminLive?.provider_broadcast_id === YT && adminLive?.temple_id === templeId && adminLive?.deity_id === deityId("renukadevi") && adminLive?.deleted_at === null && ISO_Z.test(adminLive?.created_at ?? ""), "created_by, provider_broadcast_id, temple_id, deity_id, created_at as stored", show([adminLive?.created_by, adminLive?.provider_broadcast_id, adminLive?.temple_id, adminLive?.deity_id, adminLive?.created_at]));
  check(!("provider_stream_id" in (adminLive ?? {})), "provider_stream_id is not even in the admin shape");
  const filter = async (f) => idsOf((await owner.api("GET", `/api/admin/live-streams?f=${f}&q=${encodeURIComponent(PREFIX)}`)).data?.streams).sort((a, b) => a - b);
  check(JSON.stringify(await filter("deleted")) === JSON.stringify([F.deleted.id]), "f=deleted lists only the deleted fixture");
  check(JSON.stringify(await filter("draft")) === JSON.stringify([F.draft.id]), "f=draft lists the draft");
  check(JSON.stringify(await filter("live")) === JSON.stringify([F.live.id, F.starting.id].sort((a, b) => a - b)), "f=live lists LIVE and STARTING");
  check(JSON.stringify(await filter("completed")) === JSON.stringify([F.completed.id]), "f=completed");
  check(JSON.stringify(await filter("cancelled")) === JSON.stringify([F.cancelled.id]), "f=cancelled");
  check(JSON.stringify(await filter("scheduled")) === JSON.stringify([F.future.id, F.xss.id, F.future2.id, F.past.id, F.nostart.id, F.late.id].sort((a, b) => a - b)), "f=scheduled lists every SCHEDULED fixture, past, late and unscheduled too");
  r = await owner.api("GET", `/api/admin/live-streams?q=${encodeURIComponent(PREFIX + " Tomorrow")}`);
  check(idsOf(r.data?.streams).join() === String(F.future.id), "q searches the title", show(idsOf(r.data?.streams)));
  r = await owner.api("GET", `/api/admin/live-streams?q=${encodeURIComponent(PREFIX)}&sort=title&dir=asc`);
  const titles = (r.data?.streams ?? []).map((s) => s.title_en);
  check(JSON.stringify(titles) === JSON.stringify([...titles].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))), "sort=title&dir=asc orders by the English title", show(titles));
  r = await owner.api("GET", `/api/admin/live-streams?f=${encodeURIComponent(XSS)}&sort=DROP%20TABLE&dir=sideways&page=-1&q[]=1&q=${encodeURIComponent(XSS)}`);
  check(r.status === 200 && Array.isArray(r.data?.streams) && !r.text.includes("<script>"), "hostile filters → 200, nothing reflected", `${r.status} ${r.text.slice(0, 120)}`);
  r = await owner.api("GET", `/api/admin/live-streams/${F.draft.id}`);
  check(r.status === 200 && sameKeys(r.data, ["stream"]) && r.data?.stream?.status === "DRAFT", "GET /:id shows a DRAFT to the committee", `${r.status} ${keysOf(r.data)}`);
  r = await owner.api("GET", `/api/admin/live-streams/${F.deleted.id}`);
  check(r.status === 200 && r.data?.stream?.deleted_at !== null && ISO_Z.test(r.data?.stream?.deleted_at ?? ""), "GET /:id shows a deleted stream with its deleted_at", show(r.data?.stream?.deleted_at));
  r = await owner.api("GET", "/api/admin/live-streams/999999999");
  check(r.status === 404 && r.data?.error === "Not found", "GET /:unknown → 404");
  r = await owner.api("GET", `/api/admin/live-streams/${F.live.slug}`);
  check(r.status === 404, "the admin route takes ids only: a slug → 404", `${r.status}`);

  section("2c. CSRF");
  const body = {
    title_ta: `${PREFIX} தரிசனம் API`, title_en: `${PREFIX} API created`, slug: `${SLUG}-api1`, description_en: "Made through the JSON API",
    temple_id: templeId, deity_id: deityId("lingammal"), event_type: "abhishekam", provider: "youtube", provider_reference: `https://youtu.be/${YT}?t=10`,
    scheduled_date: istDate(1), start_time: "18:00", end_time: "19:30", timezone: "Asia/Kolkata", status: "SCHEDULED",
    is_featured: true, show_on_homepage: "1", donations_enabled: "1", notifications_enabled: "0", sharing_enabled: "1", archive_enabled: "",
  };
  r = await owner.api("POST", "/api/admin/live-streams", { json: body });
  check(r.status === 403 && r.data?.code === "csrf", "POST without X-CSRF-Token → 403 code csrf", `${r.status} ${r.text.slice(0, 120)}`);
  r = await owner.api("POST", "/api/admin/live-streams", { json: body, headers: { "X-CSRF-Token": "0".repeat(64) } });
  check(r.status === 403 && r.data?.code === "csrf", "POST with a wrong token → 403 csrf");
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, _csrf: "not-it" } });
  check(r.status === 403 && r.data?.code === "csrf", "POST with a wrong _csrf field → 403 csrf");
  check(countTitled(body.title_en) === 0, "nothing was created by the refused posts");
  r = await owner.api("PUT", `/api/admin/live-streams/${F.future.id}`, { json: { title_en: `${PREFIX} forged` } });
  check(r.status === 403 && r.data?.code === "csrf" && streamRow(F.future.id)?.title_en === `${PREFIX} Tomorrow evening`, "PUT without the token → 403 csrf and nothing changed");
  r = await owner.api("DELETE", `/api/admin/live-streams/${F.future.id}`);
  check(r.status === 403 && r.data?.code === "csrf" && streamRow(F.future.id)?.deleted_at === null, "DELETE without the token → 403 csrf and nothing deleted");
  const H = { "X-CSRF-Token": csrf };

  section("2d. POST create");
  r = await owner.api("POST", "/api/admin/live-streams", { json: body, headers: H });
  check(r.status === 201 && isJson(r) && sameKeys(r.data, ["stream"]), "POST → 201 {stream}", `${r.status} ${r.text.slice(0, 300)}`);
  const created = r.data?.stream ?? {};
  const createdId = Number(created.id);
  check(created.slug === `${SLUG}-api1` && created.status === "SCHEDULED" && created.provider_broadcast_id === YT && created.created_by === "admin" && created.updated_by === "admin", "the stream: slug, SCHEDULED, the id parsed from the youtu.be link, created_by admin", show([created.slug, created.status, created.provider_broadcast_id, created.created_by]));
  check(created.deity?.slug === "lingammal" && created.event_type === "abhishekam" && created.local?.date === istDate(1) && created.local?.start_time === "18:00" && created.local?.end_time === "19:30", "deity, programme and schedule as sent", show([created.deity, created.event_type, created.local]));
  check(JSON.stringify(created.flags) === JSON.stringify({ featured: true, showOnHomepage: true, donations: true, notifications: false, sharing: true, archive: false }), "flags: true/\"1\" on, \"0\"/\"\" off", show(created.flags));
  const createdRow = streamRow(createdId);
  check(createdRow?.created_by === "admin" && createdRow?.updated_by === "admin" && createdRow?.status === "SCHEDULED" && createdRow?.title_ta === body.title_ta && Number(createdRow?.is_featured) === 1 && Number(createdRow?.notifications_enabled) === 0, "the row exists with created_by = admin and the Tamil title intact", show(createdRow));
  check(activity(createdId).some((a) => a.action === "live_stream_create" && a.actor === "admin"), "admin_activity has live_stream_create by admin", show(activity(createdId)));
  const pubCreated = await pub(`/api/live-streams/${created.slug}`);
  check(pubCreated.status === 200 && pubCreated.data?.stream?.id === createdId, "the new stream is public at once (SCHEDULED)");
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, _csrf: csrf, title_en: `${PREFIX} API via _csrf`, slug: `${SLUG}-api2` } });
  check(r.status === 201 && r.data?.stream?.slug === `${SLUG}-api2`, "the token may travel as a _csrf field instead", `${r.status} ${r.text.slice(0, 160)}`);
  const second = Number(r.data?.stream?.id);
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, title_en: `${PREFIX} API ${XSS}`, title_ta: `${PREFIX} <b>bold</b> தரிசனம்`, slug: `${SLUG}-api3`, description_ta: XSS }, headers: H });
  check(r.status === 201 && !r.text.includes("<script>") && !r.text.includes("<b>") && r.data?.stream?.title_en?.includes("alert(1)"), "script in a title is stripped on save and escaped in the answer", `${r.status} ${r.text.slice(0, 200)}`);
  const third = Number(r.data?.stream?.id);
  const draftViaApi = await owner.api("POST", "/api/admin/live-streams", { json: { title_ta: `${PREFIX} வரைவு`, title_en: `${PREFIX} API draft`, slug: `${SLUG}-api4`, temple_id: templeId, status: "DRAFT" }, headers: H });
  check(draftViaApi.status === 201 && draftViaApi.data?.stream?.status === "DRAFT" && draftViaApi.data?.stream?.playback?.kind === "none", "a DRAFT needs neither video id nor schedule and plays nothing", `${draftViaApi.status} ${draftViaApi.text.slice(0, 160)}`);
  const fourth = Number(draftViaApi.data?.stream?.id);
  r = await pub(`/api/live-streams/${fourth}`);
  check(isNotFound(r), "…and is not public");

  section("2e. POST refused with 422, never 500");
  const expectField = async (label, json, key, opts = {}) => {
    const res = await owner.api("POST", "/api/admin/live-streams", { json, headers: H, ...opts });
    check(res.status === 422 && res.data?.error === "Please correct the highlighted fields." && typeof res.data?.fields?.[key] === "string" && res.data.fields[key] !== "", `${label} → 422 with "${key}"`, `${res.status} ${res.text.slice(0, 300)}`);
    return res;
  };
  r = await owner.api("POST", "/api/admin/live-streams", { json: {}, headers: H });
  check(r.status === 422 && ["title_ta", "title_en", "temple_id"].every((k) => typeof r.data?.fields?.[k] === "string"), "an empty object → 422 naming title_ta, title_en, temple_id", `${r.status} ${r.text.slice(0, 200)}`);
  for (const [label, raw] of [["a JSON array", "[1,2,3]"], ["a JSON string", '"hello"'], ["null", "null"], ["a number", "42"], ["not JSON", "title_en=x"], ["truncated JSON", '{"title_en": "x'], ["JSON nested 2,000 deep", "[".repeat(2000) + "]".repeat(2000)]]) {
    r = await owner.api("POST", "/api/admin/live-streams", { raw, headers: H });
    check(r.status === 422 && isJson(r) && "fields" in (r.data ?? {}), `a body that is ${label} → 422 JSON`, `${r.status} ${r.text.slice(0, 160)}`);
  }
  r = await owner.api("POST", "/api/admin/live-streams", { raw: "", headers: H });
  check(r.status === 422, "an empty body → 422", `${r.status}`);
  const everyArray = Object.fromEntries(Object.keys(body).map((k) => [k, [XSS, 1]]));
  r = await owner.api("POST", "/api/admin/live-streams", { json: everyArray, headers: H });
  check(r.status === 422 && Object.keys(r.data?.fields ?? {}).length >= 8 && !r.text.includes("<script>"), "arrays in every field → 422 with many field errors, nothing reflected", `${r.status} ${r.text.slice(0, 200)}`);
  r = await owner.api("POST", "/api/admin/live-streams", { json: Object.fromEntries(Object.keys(body).map((k) => [k, { a: { b: { c: XSS } } }])), headers: H });
  check(r.status === 422, "nested objects in every field → 422", `${r.status}`);
  r = await owner.api("POST", "/api/admin/live-streams", { json: Object.fromEntries(Object.keys(body).map((k) => [k, null])), headers: H });
  check(r.status === 422, "null in every field → 422", `${r.status}`);
  r = await owner.api("POST", "/api/admin/live-streams", { json: Object.fromEntries(Object.keys(body).map((k) => [k, 1e30])), headers: H });
  check(r.status === 422, "huge numbers in every field → 422", `${r.status}`);
  await expectField("a title of 600 Tamil characters", { ...body, slug: `${SLUG}-x`, title_ta: "ஃ".repeat(600) }, "title_ta");
  await expectField("no English title", { ...body, slug: `${SLUG}-x`, title_en: "" }, "title_en");
  await expectField("a description of 5001 characters", { ...body, slug: `${SLUG}-x`, description_en: "d".repeat(5001) }, "description_en");
  await expectField("a duplicate slug", { ...body, slug: `${SLUG}-api1`, title_en: `${PREFIX} dup` }, "slug");
  await expectField("a reserved slug", { ...body, slug: "live", title_en: `${PREFIX} reserved` }, "slug");
  await expectField("a slug with script", { ...body, slug: XSS, title_en: `${PREFIX} xss slug` }, "slug");
  await expectField("temple_id 99999999999999", { ...body, slug: `${SLUG}-x`, temple_id: "99999999999999" }, "temple_id");
  await expectField("temple_id text", { ...body, slug: `${SLUG}-x`, temple_id: "abc" }, "temple_id");
  await expectField("a deity that does not exist", { ...body, slug: `${SLUG}-x`, deity_id: 999999999 }, "deity_id");
  await expectField("event_type with script", { ...body, slug: `${SLUG}-x`, event_type: XSS }, "event_type");
  await expectField("provider vimeo (not available yet)", { ...body, slug: `${SLUG}-x`, provider: "vimeo" }, "provider");
  await expectField("provider with script", { ...body, slug: `${SLUG}-x`, provider: XSS }, "provider");
  await expectField("a video reference that is not a link", { ...body, slug: `${SLUG}-x`, provider_reference: "not a link" }, "provider_reference");
  await expectField("the channel live_stream embed", { ...body, slug: `${SLUG}-x`, provider_reference: "https://www.youtube.com/embed/live_stream?channel=UCx" }, "provider_reference");
  await expectField("no video reference while SCHEDULED", { ...body, slug: `${SLUG}-x`, provider_reference: "" }, "provider_reference");
  await expectField("playback_url javascript:", { ...body, slug: `${SLUG}-x`, playback_url: "javascript:alert(1)" }, "playback_url");
  await expectField("thumbnail_url javascript:", { ...body, slug: `${SLUG}-x`, thumbnail_url: "javascript:alert(1)" }, "thumbnail_url");
  await expectField("thumbnail_url http:", { ...body, slug: `${SLUG}-x`, thumbnail_url: "http://example.org/a.png" }, "thumbnail_url");
  await expectField("banner_url with script", { ...body, slug: `${SLUG}-x`, banner_url: XSS }, "banner_url");
  await expectField("scheduled_date 9999-99-99", { ...body, slug: `${SLUG}-x`, scheduled_date: "9999-99-99" }, "scheduled_date");
  await expectField("scheduled_date 2026-02-30", { ...body, slug: `${SLUG}-x`, scheduled_date: "2026-02-30" }, "scheduled_date");
  await expectField("no date while SCHEDULED", { ...body, slug: `${SLUG}-x`, scheduled_date: "", start_time: "" }, "scheduled_date");
  await expectField("start_time 25:00", { ...body, slug: `${SLUG}-x`, start_time: "25:00" }, "start_time");
  await expectField("end before start", { ...body, slug: `${SLUG}-x`, end_time: "17:00" }, "end_time");
  await expectField("timezone Not/AZone", { ...body, slug: `${SLUG}-x`, timezone: "Not/AZone" }, "timezone");
  await expectField("timezone with script", { ...body, slug: `${SLUG}-x`, timezone: XSS }, "timezone");
  await expectField("status LIVE on create", { ...body, slug: `${SLUG}-x`, status: "LIVE" }, "status");
  await expectField("status nonsense", { ...body, slug: `${SLUG}-x`, status: "nonsense" }, "status");
  await expectField("status with script", { ...body, slug: `${SLUG}-x`, status: XSS }, "status");
  r = await owner.api("POST", "/api/admin/live-streams", { raw: JSON.stringify({ ...body, slug: `${SLUG}-x`, description_en: "x".repeat(600 * 1024) }), headers: H });
  check(r.status === 413 || r.status === 422, "a 600 KB body is refused (413 or 422), not a 500", `${r.status}`);
  check(countTitled(`${PREFIX} dup`) === 0 && countTitled(`${PREFIX} reserved`) === 0, "nothing was created by the refused bodies");

  section("2f. PUT edit, illegal and legal transitions");
  const before = streamRow(createdId);
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { title_en: `${PREFIX} API edited`, description_en: "Edited through the API" }, headers: H });
  check(r.status === 200 && sameKeys(r.data, ["stream"]) && r.data?.stream?.title_en === `${PREFIX} API edited`, "PUT with a partial body → 200 {stream} with the new title", `${r.status} ${r.text.slice(0, 200)}`);
  const after = streamRow(createdId);
  const changedCols = Object.keys(after ?? {}).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before?.[k]));
  check(JSON.stringify(changedCols.sort()) === JSON.stringify(["description_en", "title_en", "updated_at"].sort()) || JSON.stringify(changedCols.sort()) === JSON.stringify(["description_en", "title_en"].sort()), "only title_en, description_en (and updated_at) changed", changedCols.join(","));
  check(after?.updated_by === "admin" && after?.slug === before?.slug && after?.status === "SCHEDULED" && after?.title_ta === before?.title_ta, "updated_by admin; slug, status and the Tamil title untouched");
  check(activity(createdId).some((a) => a.action === "live_stream_update" && a.actor === "admin" && /title_en/.test(a.detail ?? "")), "admin_activity has live_stream_update naming title_en", show(activity(createdId)));
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { status: "COMPLETED" }, headers: H });
  check(r.status === 409 && r.data?.code === "transition" && typeof r.data?.error === "string", "PUT status COMPLETED on a SCHEDULED stream → 409 code transition", `${r.status} ${r.text.slice(0, 160)}`);
  check(streamRow(createdId)?.status === "SCHEDULED" && streamRow(createdId)?.actual_end_at === null, "…and the row is untouched");
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { status: "OFFLINE" }, headers: H });
  check(r.status === 409 && r.data?.code === "transition", "SCHEDULED → OFFLINE → 409 as well");
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { status: "NONSENSE" }, headers: H });
  check(r.status === 422 && typeof r.data?.fields?.status === "string", "an unknown status → 422 on status", `${r.status} ${r.text.slice(0, 120)}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { status: "LIVE" }, headers: H });
  check(r.status === 200 && r.data?.stream?.status === "LIVE" && r.data?.stream?.is_live === true && ISO_Z.test(r.data?.stream?.actual_start_at ?? ""), "PUT status LIVE → 200, is_live, actual_start_at stamped", `${r.status} ${r.text.slice(0, 200)}`);
  const statusAudit = activity(createdId).find((a) => a.action === "live_stream_status");
  check(Boolean(statusAudit) && statusAudit.actor === "admin" && statusAudit.subject === `Stream #${createdId}` && (statusAudit.detail ?? "").startsWith("SCHEDULED → LIVE by admin"), 'admin_activity has live_stream_status "SCHEDULED → LIVE by admin"', show(activity(createdId)));
  r = await pub("/api/live-streams/live");
  check(idsOf(r.data?.streams).includes(createdId), "the public /live now lists it");
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { status: "COMPLETED", title_en: `${PREFIX} API ended` }, headers: H });
  check(r.status === 200 && r.data?.stream?.status === "COMPLETED" && ISO_Z.test(r.data?.stream?.actual_end_at ?? "") && r.data?.stream?.title_en === `${PREFIX} API ended`, "a field edit and a legal transition in one PUT", `${r.status} ${r.text.slice(0, 200)}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${createdId}`, { json: { status: "LIVE" }, headers: H });
  check(r.status === 409 && r.data?.code === "transition" && streamRow(createdId)?.status === "COMPLETED", "COMPLETED is terminal: back to LIVE → 409");
  r = await owner.api("PUT", `/api/admin/live-streams/${second}`, { json: { title_en: `${PREFIX} API via _csrf`, status: "COMPLETED", scheduled_date: "9999-99-99" }, headers: H });
  check(r.status === 409 || (r.status === 422 && r.data?.fields?.scheduled_date), "an illegal jump together with a bad date is refused (409 or 422), never applied", `${r.status} ${r.text.slice(0, 160)}`);
  check(streamRow(second)?.status === "SCHEDULED", "…and the row stayed SCHEDULED");
  r = await owner.api("PUT", `/api/admin/live-streams/${second}`, { json: { slug: `${SLUG}-api1` }, headers: H });
  check(r.status === 422 && typeof r.data?.fields?.slug === "string", "taking another stream's slug → 422 on slug", `${r.status} ${r.text.slice(0, 120)}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${second}`, { json: { slug: `${SLUG}-api2` }, headers: H });
  check(r.status === 200, "keeping its own slug is fine", `${r.status} ${r.text.slice(0, 120)}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${second}`, { json: { slug: `${SLUG}-api2-moved` }, headers: H });
  check(r.status === 422 && /locked after publishing/.test(r.data?.fields?.slug ?? "") && streamRow(second)?.slug === `${SLUG}-api2`, "a published (SCHEDULED) stream's slug cannot be changed: 422 'locked after publishing', slug unchanged", `${r.status} ${r.text.slice(0, 160)}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${fourth}`, { json: { slug: `${SLUG}-api4-moved` }, headers: H });
  check(r.status === 200 && r.data?.stream?.slug === `${SLUG}-api4-moved`, "a DRAFT's slug can still be changed", `${r.status} ${r.text.slice(0, 120)}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${fourth}`, { json: { status: "SCHEDULED" }, headers: H });
  check(r.status === 422 && r.data?.fields?.provider_reference && r.data?.fields?.scheduled_date && streamRow(fourth)?.status === "DRAFT", "publishing a draft with no video id and no schedule → 422 naming both, row still DRAFT", `${r.status} ${r.text.slice(0, 200)}`);
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, title_en: "2027", slug: "" }, headers: H });
  const digitId = r.data?.stream?.id;
  check(r.status === 201 && r.data?.stream?.slug === "2027-darshan", "a title of digits only gets the slug 2027-darshan (digits alone would be read as an id)", `${r.status} ${r.data?.stream?.slug}`);
  r = await pub("/api/live-streams/2027-darshan");
  check(r.status === 200 && r.data?.stream?.id === digitId, "…and GET /api/live-streams/2027-darshan reaches it", `${r.status} ${r.text.slice(0, 100)}`);
  if (digitId) { sql("UPDATE live_streams SET title_en = ? WHERE id = ?", [`${PREFIX} digits`, digitId]); }
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, slug: "12345", title_en: `${PREFIX} digit slug` }, headers: H });
  check(r.status === 422 && /digits/.test(r.data?.fields?.slug ?? ""), "an explicit slug of digits only → 422 on slug", `${r.status} ${r.text.slice(0, 160)}`);
  r = await owner.api("PUT", "/api/admin/live-streams/999999999", { json: { title_en: "x" }, headers: H });
  check(r.status === 404 && r.data?.error === "Not found", "PUT /:unknown → 404");
  r = await owner.api("PUT", `/api/admin/live-streams/${F.deleted.id}`, { json: { title_en: `${PREFIX} raise the dead` }, headers: H });
  check(r.status === 404 && streamRow(F.deleted.id)?.title_en !== `${PREFIX} raise the dead`, "PUT on a deleted stream → 404 and no change");
  r = await owner.api("PUT", `/api/admin/live-streams/${second}`, { raw: "[1,2]", headers: H });
  check(r.status === 422, "PUT with a JSON array → 422", `${r.status}`);
  r = await owner.api("PUT", `/api/admin/live-streams/${second}`, { json: { title_en: ["x"], thumbnail_url: "javascript:alert(1)", scheduled_date: "9999-99-99" }, headers: H });
  check(r.status === 422 && r.data?.fields?.title_en && r.data?.fields?.thumbnail_url && r.data?.fields?.scheduled_date, "PUT with hostile fields → 422 naming each", `${r.status} ${r.text.slice(0, 200)}`);

  section("2g. DELETE");
  r = await owner.api("DELETE", `/api/admin/live-streams/${third}`, { headers: H });
  check(r.status === 200 && r.text === '{"success":true}', 'DELETE → 200 {"success":true}', `${r.status} ${r.text.slice(0, 100)}`);
  const deletedRow = streamRow(third);
  check(deletedRow?.deleted_at !== null && deletedRow?.updated_by === "admin", "the row is soft-deleted (deleted_at set), not removed", show(deletedRow?.deleted_at));
  check(isNotFound(await pub(`/api/live-streams/${third}`)) && isNotFound(await pub(`/api/live-streams/${SLUG}-api3`)), "…and gone from the public API by id and by slug");
  r = await owner.api("GET", `/api/admin/live-streams?f=deleted&q=${encodeURIComponent(PREFIX)}`);
  check(idsOf(r.data?.streams).includes(third), "…but listed under f=deleted for the committee");
  r = await owner.api("DELETE", `/api/admin/live-streams/${third}`, { headers: H });
  check(r.status === 404 && r.data?.error === "Not found", "DELETE again → 404");
  r = await owner.api("DELETE", "/api/admin/live-streams/999999999", { headers: H });
  check(r.status === 404, "DELETE /:unknown → 404");
  check(activity(third).some((a) => a.action === "live_stream_delete" && a.actor === "admin"), "admin_activity has live_stream_delete by admin", show(activity(third)));
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, slug: `${SLUG}-api3`, title_en: `${PREFIX} reuse deleted slug` }, headers: H });
  check(r.status === 422 && r.data?.fields?.slug, "a deleted stream keeps its slug: reusing it → 422", `${r.status} ${r.text.slice(0, 120)}`);

  section("2h. methods on the admin routes");
  for (const [method, path, allow] of [["PATCH", "/api/admin/live-streams", "GET, HEAD, POST"], ["PUT", "/api/admin/live-streams", "GET, HEAD, POST"], ["DELETE", "/api/admin/live-streams", "GET, HEAD, POST"], ["POST", `/api/admin/live-streams/${second}`, "GET, HEAD, PUT, DELETE"], ["PATCH", `/api/admin/live-streams/${second}`, "GET, HEAD, PUT, DELETE"]]) {
    r = await owner.api(method, path, { json: {}, headers: H });
    check(r.status === 405 && r.data?.error === "Method not allowed" && r.headers.get("allow") === allow, `${method} ${path.replace(String(second), ":id")} → 405 with Allow: ${allow}`, `${r.status} ${r.headers.get("allow")} ${r.text.slice(0, 100)}`);
  }
  r = await owner.api("HEAD", "/api/admin/live-streams");
  check(r.status === 200, "HEAD on the collection → 200", `${r.status}`);

  /* ── 3. Roles ──────────────────────────────────────────────────────── */
  section("3a. a viewer reads and never writes");
  const viewer = await makeAccount(owner, "viewer", IP.viewer);
  r = await viewer.session.api("GET", "/api/admin/live-streams");
  check(r.status === 403 && r.data?.code === "password_change", "before changing the issued password: 403 code password_change", `${r.status} ${r.text.slice(0, 120)}`);
  await finishPasswordChange(viewer.session, viewer.acct, "viewer");
  r = await viewer.session.api("GET", `/api/admin/live-streams?q=${encodeURIComponent(PREFIX)}`);
  check(r.status === 200 && Array.isArray(r.data?.streams) && r.data.streams.length > 0 && typeof r.data?.csrf === "string", "viewer: GET → 200 with the list and a csrf token", `${r.status} ${r.text.slice(0, 120)}`);
  const viewerCsrf = r.data?.csrf ?? "";
  r = await viewer.session.api("GET", `/api/admin/live-streams/${F.live.id}`);
  check(r.status === 200 && r.data?.stream?.id === F.live.id, "viewer: GET /:id → 200");
  const snapshot = JSON.stringify(streamRow(second));
  const activityBefore = Number(one("SELECT COUNT(*) AS c FROM admin_activity WHERE actor = ? AND action LIKE 'live_stream_%'", [viewer.acct.username])?.c);
  r = await viewer.session.api("POST", "/api/admin/live-streams", { json: { ...body, slug: `${SLUG}-viewer`, title_en: `${PREFIX} viewer create` }, headers: { "X-CSRF-Token": viewerCsrf } });
  check(r.status === 403 && r.data?.code === "forbidden", "viewer: POST → 403 code forbidden", `${r.status} ${r.text.slice(0, 120)}`);
  r = await viewer.session.api("PUT", `/api/admin/live-streams/${second}`, { json: { title_en: `${PREFIX} viewer edit` }, headers: { "X-CSRF-Token": viewerCsrf } });
  check(r.status === 403 && r.data?.code === "forbidden", "viewer: PUT → 403 forbidden");
  r = await viewer.session.api("PUT", `/api/admin/live-streams/${second}`, { json: { status: "LIVE" }, headers: { "X-CSRF-Token": viewerCsrf } });
  check(r.status === 403 && r.data?.code === "forbidden", "viewer: PUT status → 403 forbidden");
  r = await viewer.session.api("DELETE", `/api/admin/live-streams/${second}`, { headers: { "X-CSRF-Token": viewerCsrf } });
  check(r.status === 403 && r.data?.code === "forbidden", "viewer: DELETE → 403 forbidden");
  check(countTitled(`${PREFIX} viewer create`) === 0 && JSON.stringify(streamRow(second)) === snapshot, "nothing was created, changed or deleted");
  check(Number(one("SELECT COUNT(*) AS c FROM admin_activity WHERE actor = ? AND action LIKE 'live_stream_%'", [viewer.acct.username])?.c) === activityBefore, "and no live_stream_* activity was written for the viewer");

  section("3b. an editor creates, publishes and deletes");
  const editor = await makeAccount(owner, "editor", IP.editor);
  await finishPasswordChange(editor.session, editor.acct, "editor");
  r = await editor.session.api("GET", "/api/admin/live-streams");
  const editorCsrf = r.data?.csrf ?? "";
  check(r.status === 200 && /^[0-9a-f]{64}$/.test(editorCsrf), "editor: GET → 200 with a csrf token", `${r.status}`);
  r = await editor.session.api("POST", "/api/admin/live-streams", { json: { ...body, slug: `${SLUG}-editor`, title_en: `${PREFIX} editor created` }, headers: { "X-CSRF-Token": editorCsrf } });
  check(r.status === 201 && r.data?.stream?.created_by === editor.acct.username, "editor: POST → 201 with created_by = the editor", `${r.status} ${r.text.slice(0, 160)}`);
  const editorId = Number(r.data?.stream?.id);
  check(streamRow(editorId)?.created_by === editor.acct.username && activity(editorId).some((a) => a.action === "live_stream_create" && a.actor === editor.acct.username), "the row and its audit name the editor");
  r = await editor.session.api("PUT", `/api/admin/live-streams/${editorId}`, { json: { status: "STARTING" }, headers: { "X-CSRF-Token": editorCsrf } });
  check(r.status === 200 && r.data?.stream?.status === "STARTING", "editor: a status change (live.publish) → 200", `${r.status} ${r.text.slice(0, 120)}`);
  check(activity(editorId).some((a) => a.action === "live_stream_status" && a.actor === editor.acct.username && (a.detail ?? "").startsWith(`SCHEDULED → STARTING by ${editor.acct.username}`)), "…audited for the editor", show(activity(editorId)));
  r = await editor.session.api("POST", "/api/admin/live-streams", { json: { ...body, slug: `${SLUG}-editor2`, title_en: `${PREFIX} editor csrf` }, headers: { "X-CSRF-Token": csrf } });
  check(r.status === 403 && r.data?.code === "csrf", "editor: the owner's token does not work for the editor's session → 403 csrf");
  r = await editor.session.api("DELETE", `/api/admin/live-streams/${editorId}`, { headers: { "X-CSRF-Token": editorCsrf } });
  check(r.status === 200 && streamRow(editorId)?.deleted_at !== null, "editor: DELETE → 200 and the row is soft-deleted");

  /* ── 4. The rest of the API is unaffected ──────────────────────────── */
  section("4. /api/events, /api/homepage_widgets, /api/search still answer");
  r = await http("GET", "/api/events", { ip: IP.regress });
  check(r.status === 200 && Array.isArray(r.data), "/api/events → 200 with a list", `${r.status} ${r.text.slice(0, 80)}`);
  r = await http("GET", "/api/homepage_widgets", { ip: IP.regress });
  check(r.status === 200 && r.data !== null && typeof r.data === "object", "/api/homepage_widgets → 200 JSON", `${r.status} ${r.text.slice(0, 80)}`);
  r = await http("GET", "/api/search?q=abhishekam", { ip: IP.regress });
  check(r.status === 200 && Array.isArray(r.data?.groups), "/api/search?q=abhishekam → 200 with groups", `${r.status} ${r.text.slice(0, 80)}`);
  r = await http("GET", "/api/pulse", { ip: IP.regress });
  check(r.status === 200, "/api/pulse → 200");
  r = await http("GET", "/api/admin/", { ip: IP.regress });
  check(r.status === 404, "/api/admin/ is not a route", `${r.status}`);
  r = await http("GET", "/api/nothing-here", { ip: IP.regress });
  check(r.status === 404 && r.data?.error === "Not found", "an unknown route is still a JSON 404");

  /* ── 5. The YouTube mock starts and answers ────────────────────────── */
  section("5. tests/support/youtube_mock.mjs (smoke)");
  mock = await startYoutubeMock({ port: PORT.mock, apiKey: "e2e-live-mock-key" });
  let m = await fetch(`${mock.base}/__health`);
  check(m.status === 200 && (await m.text()) === "ok", "the mock answers /__health");
  m = await fetch(`${mock.oembedUrl}?url=${encodeURIComponent(WATCH(YT))}&format=json`);
  const oembed = await m.json().catch(() => null);
  check(m.status === 200 && oembed?.title && oembed?.thumbnail_url === THUMB(YT) && /<iframe/.test(oembed?.html ?? ""), "oEmbed for a good link → 200 with title, thumbnail_url and html", show(oembed));
  m = await fetch(`${mock.oembedUrl}?url=${encodeURIComponent(`https://youtu.be/${YT}`)}&format=json`);
  check(m.status === 200, "oEmbed accepts the youtu.be form");
  m = await fetch(`${mock.oembedUrl}?url=${encodeURIComponent(WATCH("abcdefg0404"))}&format=json`);
  check(m.status === 400, "oEmbed for an id ending 0404 → 400");
  m = await fetch(`${mock.oembedUrl}?url=${encodeURIComponent(WATCH("abcdefg0403"))}&format=json`);
  check(m.status === 401, "oEmbed for an id ending 0403 → 401 (private / not embeddable)");
  m = await fetch(`${mock.oembedUrl}?url=nonsense&format=json`);
  check(m.status === 400, "oEmbed for a non-link → 400");
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet,liveStreamingDetails,status&id=${YT}&key=e2e-live-mock-key`);
  const videos = await m.json().catch(() => null);
  check(m.status === 200 && videos?.items?.length === 1 && videos.items[0].id === YT && videos.items[0].snippet?.liveBroadcastContent === "none" && videos.items[0].status?.embeddable === true, "videos.list → one item with snippet and status", show(videos));
  mock.setVideo(YT, { liveBroadcastContent: "live", actualStartTime: "2026-09-14T12:30:00Z", concurrentViewers: 128 });
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet,liveStreamingDetails&id=${YT}&key=e2e-live-mock-key`);
  const liveVideo = (await m.json().catch(() => null))?.items?.[0];
  check(liveVideo?.snippet?.liveBroadcastContent === "live" && liveVideo?.liveStreamingDetails?.concurrentViewers === "128", "setVideo() makes it live with viewers", show(liveVideo));
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet&id=abcdefg0404&key=e2e-live-mock-key`);
  check(m.status === 200 && (await m.json())?.items?.length === 0, "…0404 → 200 with no items");
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet&id=abcdefg0429&key=e2e-live-mock-key`);
  check(m.status === 429 && m.headers.get("retry-after") === "30", "…0429 → 429 with Retry-After: 30");
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet&id=abcdefg0500&key=e2e-live-mock-key`);
  check(m.status === 500, "…0500 → 500");
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet&id=abcdefg0403&key=e2e-live-mock-key`);
  check(m.status === 403 && (await m.json())?.error?.errors?.[0]?.reason === "quotaExceeded", "…0403 → 403 quotaExceeded");
  m = await fetch(`${mock.apiBaseUrl}/videos?part=snippet&id=${YT}&key=wrong`);
  check(m.status === 400, "a wrong API key → 400");
  m = await fetch(mock.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "r", client_id: "c", client_secret: "s" }) });
  check(m.status === 200 && (await m.json())?.token_type === "Bearer", "POST /token issues a bearer token");
  check(mock.requests.length >= 14 && mock.requests.every((q) => q.method && q.path), "every request was logged", String(mock.requests.length));
  await mock.close();
  mock = null;
  check(!(await portInUse(PORT.mock)), "the mock closes its port");

  /* ── 7. Phase 2: the schedule route and now/next ───────────────────── */
  section("7. GET /api/live-streams/schedule and now/next on the index (SPEC-PHASE2 §1.1)");
  // Rows across the windows, made now so the Phase 1 ordering checks above saw only their own.
  const sundayIst = (() => {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return istDate((7 - d.getUTCDay()) % 7);
  })();
  const P2 = {};
  P2.todayLate = mk("P2 today late", { status: "SCHEDULED", scheduled_start_local: `${istDate(0)} 23:59` });
  P2.todayDone = mk("P2 today done", { status: "COMPLETED", scheduled_start_local: `${istDate(0)} 05:00`, scheduled_end_local: `${istDate(0)} 06:00` });
  P2.tomorrow0 = mk("P2 tomorrow midnight", { status: "SCHEDULED", scheduled_start_local: `${istDate(1)} 00:00` });
  P2.sunday = mk("P2 sunday", { status: "SCHEDULED", scheduled_start_local: `${sundayIst} 10:00` });
  P2.nextWeek = mk("P2 next week", { status: "SCHEDULED", scheduled_start_local: `${istDate(8)} 09:00` });
  P2.far = mk("P2 far", { status: "SCHEDULED", scheduled_start_local: `${istDate(100)} 09:00` });
  P2.festival = mk("P2 festival", { status: "SCHEDULED", event_type: "festival", scheduled_start_local: `${istDate(1)} 10:00` });
  P2.procession = mk("P2 procession", { status: "SCHEDULED", event_type: "procession", scheduled_start_local: `${istDate(0)} 17:00` });
  P2.soon = mk("P2 soon", { status: "SCHEDULED", starts_in_seconds: 90 });
  P2.draftToday = mk("P2 draft today", { status: "DRAFT", scheduled_start_local: `${istDate(0)} 12:00` });
  P2.deletedToday = mk("P2 deleted today", { status: "SCHEDULED", scheduled_start_local: `${istDate(0)} 13:00`, deleted: true });
  check(Object.values(P2).every((f) => f.id > 0), "eleven Phase 2 fixtures created", show(Object.fromEntries(Object.entries(P2).map(([k, v]) => [k, v.status]))));
  const p2ids = [...Object.values(P2).map((f) => f.id), F.live.id, F.starting.id, F.nostart.id, F.future.id, F.past.id, F.draft.id, F.deleted.id];
  const mineP2 = (list) => idsOf(list).filter((id) => p2ids.includes(id));
  const SCHEDULE_KEYS = [...PUBLIC_KEYS, "day_bucket", "starts_in_seconds"].sort();
  const hasScheduleShape = (s) => sameKeys(s, SCHEDULE_KEYS) && PRIVATE_KEYS.every((k) => !(k in (s ?? {})));
  const sched = (q = "") => pub(`/api/live-streams/schedule${q ? `?${q}` : ""}`);
  const itemOf = (res, id) => (res.data?.streams ?? []).find((s) => s.id === id);

  r = await sched("filter=today&limit=100");
  check(r.status === 200 && isJson(r) && sameKeys(r.data, ["counts", "filter", "server_time", "streams", "window"]), "GET /schedule → 200 {streams, filter, window, counts, server_time}", `${r.status} ${keysOf(r.data)}`);
  check(cache(r) === "public, max-age=30", "Cache-Control: public, max-age=30", cache(r));
  check(r.headers.get("x-content-type-options") === "nosniff" && !r.headers.get("set-cookie"), "nosniff and no cookie");
  check(ISO_Z.test(r.data?.server_time ?? ""), "server_time is ISO-8601 Z");
  check(r.data?.filter === "today" && r.data?.window?.label_en === "Today" && /\p{Script=Tamil}/u.test(r.data?.window?.label_ta ?? ""), "filter echoed, window labelled in both languages", show(r.data?.window));
  check(sameKeys(r.data?.window, ["from", "label_en", "label_ta", "timezone", "to", "today"]) && r.data?.window?.timezone === "Asia/Kolkata" && r.data?.window?.today === istDate(0), "window is {from, to, today, timezone, label_ta, label_en} on the IST calendar", show(r.data?.window));
  check(ISO_Z.test(r.data?.window?.from ?? "") && ISO_Z.test(r.data?.window?.to ?? "") && Date.parse(r.data.window.to) - Date.parse(r.data.window.from) === 86_400_000, "window.from/to are ISO Z and one day apart", show(r.data?.window));
  check(r.data?.window?.from === `${istDate(-1)}T18:30:00Z` && r.data?.window?.to === `${istDate(0)}T18:30:00Z`, "today's window is IST midnight to IST midnight, in UTC", show(r.data?.window));
  check(sameKeys(r.data?.counts, ["all", "festivals", "today", "tomorrow", "week"]) && Object.values(r.data?.counts ?? {}).every((n) => Number.isInteger(n) && n >= 0), "counts carries the five filters as integers", show(r.data?.counts));
  const todayIds = mineP2(r.data?.streams);
  check([P2.todayLate.id, P2.todayDone.id, P2.procession.id, F.live.id, F.starting.id].every((id) => todayIds.includes(id)), "today lists the 23:59 stream, the completed one, the procession and the live rows", show(todayIds));
  check(![P2.tomorrow0.id, P2.festival.id, P2.nextWeek.id, P2.far.id, F.future.id, F.past.id, F.draft.id, F.deleted.id, F.nostart.id, P2.draftToday.id, P2.deletedToday.id].some((id) => todayIds.includes(id)), "today excludes tomorrow, next week, far, past, the drafts, the deleted and the undated rows", show(todayIds));
  check(todayIds[0] === F.live.id && todayIds[1] === F.starting.id, "live rows lead: LIVE then STARTING", show(todayIds));
  check(todayIds[todayIds.length - 1] === P2.todayDone.id, "the COMPLETED row is last on today", show(todayIds));
  const lateItem = itemOf(r, P2.todayLate.id);
  check(hasScheduleShape(lateItem), "a schedule item has the public keys plus day_bucket and starts_in_seconds, and none of the private ones", keysOf(lateItem).join(","));
  check(lateItem?.day_bucket === "today" && Number.isInteger(lateItem?.starts_in_seconds), "…day_bucket today, starts_in_seconds an integer", show([lateItem?.day_bucket, lateItem?.starts_in_seconds]));
  check(itemOf(r, F.live.id)?.day_bucket === "today" && itemOf(r, F.live.id)?.starts_in_seconds === null, "a live item: day_bucket today, starts_in_seconds null");
  check(itemOf(r, P2.todayDone.id)?.starts_in_seconds < 0 && itemOf(r, P2.todayDone.id)?.status === "COMPLETED", "the completed item: negative starts_in_seconds, status COMPLETED (shown as Ended)");
  check(!r.text.includes('"e2e"') && !/"(provider_stream_id|created_by|updated_by|deleted_at|temple_id|deity_id|provider_broadcast_id|recording_url)"/.test(r.text), "no private key or actor name in the schedule JSON");

  r = await sched("filter=tomorrow&limit=100");
  const tomorrowIds = mineP2(r.data?.streams);
  check(r.data?.filter === "tomorrow" && r.data?.window?.from === `${istDate(0)}T18:30:00Z` && r.data?.window?.to === `${istDate(1)}T18:30:00Z`, "tomorrow's window is the next IST day", show(r.data?.window));
  check([P2.tomorrow0.id, P2.festival.id, F.future.id].every((id) => tomorrowIds.includes(id)), "tomorrow lists 00:00 tomorrow, the festival and the tomorrow fixture", show(tomorrowIds));
  check(![P2.todayLate.id, F.live.id, F.starting.id, P2.nextWeek.id, F.nostart.id].some((id) => tomorrowIds.includes(id)), "tomorrow excludes today, the live rows, next week and the undated row", show(tomorrowIds));
  check(!idsOf(r.data?.streams).includes(F.cancelled.id) && (r.data?.streams ?? []).every((s) => s.status !== "CANCELLED"), "the CANCELLED broadcast of tomorrow 09:00 is not listed (cancelled rows leave the schedule; ended ones stay)", show(idsOf(r.data?.streams)));
  const tomorrowCount = r.data?.counts?.tomorrow;
  const uncancel = fixture("set-status", { id: F.cancelled.id, status: "SCHEDULED", actor: "e2e" });
  r = await sched("filter=tomorrow&limit=100");
  check(uncancel.changed && idsOf(r.data?.streams).includes(F.cancelled.id) && r.data?.counts?.tomorrow === tomorrowCount + 1, "…and is not counted: scheduling it again adds one to the tomorrow list and count", show([r.data?.counts?.tomorrow, tomorrowCount]));
  fixture("set-status", { id: F.cancelled.id, status: "CANCELLED", actor: "e2e" });
  r = await sched("filter=tomorrow&limit=100");
  check(itemOf(r, P2.tomorrow0.id)?.day_bucket === "tomorrow" && itemOf(r, P2.tomorrow0.id)?.local?.start_time === "00:00", "00:00 IST tomorrow is bucket tomorrow", show(itemOf(r, P2.tomorrow0.id)?.local));
  const tomorrowStarts = (r.data?.streams ?? []).filter((s) => s.status !== "COMPLETED").map((s) => s.scheduled_start_at);
  check(tomorrowStarts.every((t, i) => i === 0 || t >= tomorrowStarts[i - 1]), "tomorrow is in start order", show(tomorrowStarts));

  r = await sched("filter=week&limit=100");
  const weekIds = mineP2(r.data?.streams);
  check(r.data?.window?.to === `${sundayIst}T18:30:00Z`, "the week window ends after the coming Sunday (IST)", show([r.data?.window?.to, sundayIst]));
  check([P2.todayLate.id, P2.sunday.id, F.live.id].every((id) => weekIds.includes(id)), "week lists today, the coming Sunday and the live rows", show(weekIds));
  check(![P2.nextWeek.id, P2.far.id, F.past.id, F.nostart.id].some((id) => weekIds.includes(id)), "week excludes next Monday onward, far, past and undated", show(weekIds));
  check(itemOf(r, P2.sunday.id)?.day_bucket === (sundayIst === istDate(0) ? "today" : sundayIst === istDate(1) ? "tomorrow" : "later"), "the Sunday item's bucket matches its distance from today");

  r = await sched("filter=festivals&limit=100");
  const festIds = mineP2(r.data?.streams);
  check(r.data?.filter === "festivals" && r.data?.window?.label_en === "Festivals", "filter festivals is echoed");
  check([P2.festival.id, P2.procession.id].every((id) => festIds.includes(id)), "festivals lists the festival and the procession", show(festIds));
  check(![P2.todayLate.id, F.live.id, F.future.id, P2.far.id].some((id) => festIds.includes(id)), "festivals excludes the other programme types (a live one included) and beyond 90 days", show(festIds));
  check((r.data?.streams ?? []).every((s) => ["festival", "procession", "special_event"].includes(s.event_type)), "every festival item is a festival type");

  r = await sched("filter=all&limit=100");
  const allIds = mineP2(r.data?.streams);
  check([P2.todayLate.id, P2.todayDone.id, P2.tomorrow0.id, P2.sunday.id, P2.nextWeek.id, P2.festival.id, P2.procession.id, P2.soon.id, F.live.id, F.starting.id, F.nostart.id, F.future.id].every((id) => allIds.includes(id)), "all lists everything from today for 90 days, the live rows and the undated one", show(allIds));
  check(![P2.far.id, F.past.id, F.draft.id, F.deleted.id, P2.draftToday.id, P2.deletedToday.id].some((id) => allIds.includes(id)), "all excludes far, past, drafts and deleted rows", show(allIds));
  check(allIds[allIds.length - 1] === F.nostart.id && itemOf(r, F.nostart.id)?.day_bucket === "later" && itemOf(r, F.nostart.id)?.starts_in_seconds === null, "the undated row is last, bucket later, starts_in_seconds null", show(allIds));
  check(allIds[0] === F.live.id, "all leads with the live row");
  const soonItem = itemOf(r, P2.soon.id);
  check(soonItem?.starts_in_seconds >= 30 && soonItem?.starts_in_seconds <= 90 && soonItem?.day_bucket === "today" && ISO_Z.test(soonItem?.scheduled_start_at ?? ""), "a start 90 s ahead (fixture starts_in_seconds) reads as starts_in_seconds ≤ 90, today", show([soonItem?.starts_in_seconds, soonItem?.day_bucket]));
  check(Math.abs(Date.parse(soonItem?.scheduled_start_at ?? 0) - Date.parse(r.data?.server_time ?? 0) - soonItem?.starts_in_seconds * 1000) <= 1500, "starts_in_seconds agrees with scheduled_start_at − server_time", show([soonItem?.scheduled_start_at, r.data?.server_time, soonItem?.starts_in_seconds]));
  check(Date.parse(r.data?.window?.to) - Date.parse(r.data?.window?.from) === 91 * 86_400_000, "the all window spans today plus 90 days", show(r.data?.window));
  const counts = r.data?.counts ?? {};
  const countOf = async (f) => (await sched(`filter=${f}&limit=100`)).data?.streams?.length ?? -1;
  for (const f of ["today", "tomorrow", "week", "festivals", "all"]) {
    const n = await countOf(f);
    check(counts[f] === n, `counts.${f} (${counts[f]}) equals the rows filter=${f} lists (${n})`);
  }
  check(counts.today <= counts.week && counts.week <= counts.all && counts.tomorrow <= counts.all && counts.festivals <= counts.all, "today ⊆ week ⊆ all; tomorrow, festivals ⊆ all", show(counts));

  r = await sched("");
  check(r.status === 200 && r.data?.filter === "all" && (r.data?.streams ?? []).length <= 50, "no filter → all, at most 50 streams", `${r.data?.filter} ${(r.data?.streams ?? []).length}`);
  for (const bad of ["bogus", "%22%3E%3Cscript%3E", "", "[]=1", "all%00"]) {
    r = await sched(`filter=${bad}`);
    check(r.status === 200 && r.data?.filter === "all" && !r.text.includes("<script>"), `filter=${bad || "(empty)"} → all, nothing reflected`, `${r.status} ${r.data?.filter} ${r.text.slice(0, 80)}`);
  }
  r = await sched("filter=Today");
  check(r.status === 200 && r.data?.filter === "today", "filter names are case-folded");
  r = await sched("filter=all&limit=1");
  check(r.status === 200 && (r.data?.streams ?? []).length === 1, "limit=1 gives one");
  r = await sched("filter=all&limit=1000");
  check(r.status === 200 && (r.data?.streams ?? []).length <= 100, "limit=1000 is capped at 100", String((r.data?.streams ?? []).length));
  for (const bad of ["abc", "-1", "0", "1e3"]) {
    r = await sched(`filter=all&limit=${bad}`);
    check(r.status === 200 && Array.isArray(r.data?.streams), `limit=${bad} is ignored, not a 500`, `${r.status}`);
  }
  r = await http("HEAD", "/api/live-streams/schedule", { ip: IP.methods });
  check(r.status === 200 && cache(r) === "public, max-age=30", "HEAD /schedule → 200 with the same cache header", `${r.status} ${cache(r)}`);
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    r = await http(method, "/api/live-streams/schedule", { json: {}, ip: IP.methods });
    check(r.status === 405 && r.headers.get("allow") === "GET, HEAD", `${method} /schedule → 405 with Allow: GET, HEAD`, `${r.status} ${r.headers.get("allow")}`);
  }
  r = await pub("/api/live-streams/schedule/x", { ip: IP.hostile });
  check(isNotFound(r), "/schedule/x → 404");
  r = await owner.api("POST", "/api/admin/live-streams", { json: { ...body, slug: "schedule", title_en: `${PREFIX} takes the schedule slug` }, headers: H });
  check(r.status === 422 && /reserved/i.test(r.data?.fields?.slug ?? ""), 'a stream cannot take the slug "schedule" (reserved) → 422', `${r.status} ${r.text.slice(0, 160)}`);

  r = await pub("/api/live-streams");
  check(r.status === 200 && cache(r) === "no-store, private", "the index is still no-store");
  check(r.data?.now?.id === F.live.id && r.data?.now?.status === "LIVE" && r.data?.now?.day_bucket === "today" && r.data?.now?.starts_in_seconds === null, "now is the featured LIVE stream with the two schedule keys", show([r.data?.now?.id, r.data?.now?.status, r.data?.now?.day_bucket, r.data?.now?.starts_in_seconds]));
  check(hasScheduleShape(r.data?.now) && hasScheduleShape(r.data?.next), "now and next have the schedule shape (public keys + day_bucket + starts_in_seconds)", `${keysOf(r.data?.now).join(",")} | ${keysOf(r.data?.next).join(",")}`);
  check(r.data?.next?.id === r.data?.upcoming?.[0]?.id && r.data?.next?.status === "SCHEDULED", "next is the first upcoming stream", show([r.data?.next?.id, r.data?.upcoming?.[0]?.id]));
  check(["today", "tomorrow", "later", "past"].includes(r.data?.next?.day_bucket) && (r.data?.next?.starts_in_seconds === null || Number.isInteger(r.data?.next?.starts_in_seconds)), "next carries a day_bucket and starts_in_seconds");
  check(hasPublicShape(r.data?.live?.[0]) && hasPublicShape(r.data?.upcoming?.[0]), "the live and upcoming items keep the plain public shape");
  const endLive = fixture("set-status", { id: F.live.id, status: "COMPLETED", actor: "e2e" });
  const endStarting = fixture("set-status", { id: F.starting.id, status: "CANCELLED", actor: "e2e" });
  r = await pub("/api/live-streams");
  check(endLive.changed && endStarting.changed && r.data?.now === null && r.data?.live?.length === 0, "with nothing live, now is null", show([r.data?.now, r.data?.live?.length]));
  r = await sched("filter=today&limit=100");
  check(mineP2(r.data?.streams).includes(F.live.id) && itemOf(r, F.live.id)?.status === "COMPLETED", "the ended broadcast stays on today's schedule as COMPLETED");

  // The browser keeps its own copy of the event-type labels for an answer that
  // carries none (frontend/src/lib/live.js EVENT_TYPE_LABELS). The API's label
  // wins on screen, so a mirror that drifts is only wrong where it is used —
  // which is exactly where nobody looks (review fix O14).
  const phpSource = readFileSync(resolve(ROOT, "backend/includes/live/config.php"), "utf8");
  const jsSource = readFileSync(resolve(ROOT, "frontend/src/lib/live.js"), "utf8");
  const pairs = (source, re, inner) => Object.fromEntries([...(re.exec(source)?.[1] ?? "").matchAll(inner)].map((m) => [m[1], `${m[2]}|${m[3]}`]));
  const phpLabels = pairs(phpSource, /const LIVE_EVENT_TYPES = \[([\s\S]*?)\n\];/, /'([a-z_]+)'\s*=>\s*\['([^']*)',\s*'([^']*)'\]/g);
  const jsLabels = pairs(jsSource, /export const EVENT_TYPE_LABELS = \{([\s\S]*?)\n\};/, /([a-z_]+):\s*\{\s*ta:\s*"([^"]*)",\s*en:\s*"([^"]*)"\s*\}/g);
  const drift = Object.keys(phpLabels).filter((k) => jsLabels[k] !== phpLabels[k]);
  check(
    Object.keys(phpLabels).length >= 10 && Object.keys(jsLabels).length === Object.keys(phpLabels).length && drift.length === 0,
    "the browser's event-type labels mirror config.php exactly",
    drift.map((k) => `${k}: php ${phpLabels[k]} vs js ${jsLabels[k]}`).join(" | ") || `php ${Object.keys(phpLabels).length}, js ${Object.keys(jsLabels).length}`,
  );
  const phpFilters = pairs(phpSource, /const LIVE_SCHEDULE_FILTERS = \[([\s\S]*?)\n\];/, /'([a-z_]+)'\s*=>\s*\['([^']*)',\s*'([^']*)'\]/g);
  const jsFilters = Object.fromEntries(
    [...(/export const SCHEDULE_FILTERS = \[([\s\S]*?)\n\];/.exec(jsSource)?.[1] ?? "").matchAll(/value:\s*"([a-z]+)",\s*ta:\s*"([^"]*)",\s*en:\s*"([^"]*)"/g)].map((m) => [m[1], `${m[2]}|${m[3]}`]),
  );
  const filterDrift = Object.keys(phpFilters).filter((k) => jsFilters[k] !== phpFilters[k]);
  check(Object.keys(jsFilters).length === 5 && filterDrift.length === 0, "…and the five filter labels mirror it too", filterDrift.map((k) => `${k}: php ${phpFilters[k]} vs js ${jsFilters[k]}`).join(" | "));

  /* ── 6. Hygiene ────────────────────────────────────────────────────── */
  section("6. hygiene");
  check(cookiesSet.length === 0, "no public or admin API response set a cookie", cookiesSet.slice(0, 3).join(" | "));
  check(serverErrors.length === 0, "no request answered 5xx", serverErrors.slice(0, 3).join(" | "));
  const noise = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error)/.exec(server?.log ?? "");
  check(!noise, "no PHP warnings, notices or fatals from the server", noise ? (server?.log ?? "").slice(Math.max(0, noise.index - 200), noise.index + 300) : "");
  check(phpNoise.length === 0, "no PHP warnings, notices or fatals from the fixtures", phpNoise.slice(0, 5).join(" | "));
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  section("Cleanup");
  try {
    const removed = cleanup();
    console.log(`  removed ${show(removed)}`);
    const left = Number(one("SELECT (SELECT COUNT(*) FROM live_streams WHERE title_en LIKE ?) + (SELECT COUNT(*) FROM admin_users WHERE username LIKE ?) AS c", [`${CLEAN_PREFIX}%`, `${ADMIN_PREFIX}%`])?.c);
    check(left === 0, "cleanup removed every stream and account this suite created", `${left} left`);
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
  await stopPhpServer(server);
  if (mock) await mock.close();
  const reported = (server?.log ?? "").split(/\r?\n/).filter((l) => /\[live|\[api|\[notify|PHP (Warning|Notice|Deprecated|Fatal)/.test(l));
  if (reported.length) console.log(`  server log (${reported.length} line(s)):\n${reported.slice(0, 40).map((l) => `    ${l.slice(0, 400)}`).join("\n")}`);
  const stillOpen = [];
  for (const port of Object.values(PORT)) if (await portInUse(port)) stillOpen.push(port);
  if (stillOpen.length) console.log(`  WARNING ports still listening: ${stillOpen.join(", ")}`);
  else console.log(`  ports ${PORT.php} and ${PORT.mock} are closed again`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
