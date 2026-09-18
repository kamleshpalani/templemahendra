#!/usr/bin/env node
/**
 * tests/live-sync.mjs — the Phase 3 poller end to end against the YouTube
 * stand-in (docs/live/SPEC-PHASE3.md §11.3): the CLI job, the HTTP trigger,
 * the status walk, the guards, failures and back-off, quota, and the lock.
 *
 *   node tests/live-sync.mjs
 *
 * Starts its own PHP servers on 8084 (keyed) and 8085 (keyless / short-key) and
 * the stand-in on 8092; never touches the user's :8000. Every PHP child gets an
 * environment with the shell's LIVE_, YOUTUBE_ and GOOGLE_ variables removed, so no real key
 * and no real cron key reaches the run. Rows are E2E-LIVE-sync<run> and every
 * sweep is confined to them by LIVE_SYNC_ONLY_TITLE_PREFIX; live_settings is
 * snapshotted and restored. Needs DB_* (and ADMIN_* for the server) in the shell.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startYoutubeMock, portInUse } from "./support/youtube_mock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const ROUTER = process.env.LIVE_ROUTER || "backend/router.php";
const PORT = { php: Number(process.env.LIVE_PORT || 8084), php2: Number(process.env.LIVE_PORT2 || 8085), mock: Number(process.env.LIVE_MOCK_PORT || 8092) };
const BASE = `http://127.0.0.1:${PORT.php}`;
const BASE2 = `http://127.0.0.1:${PORT.php2}`;
const RUN = Date.now().toString(36);
const PREFIX = `E2E-LIVE-sync${RUN}`;
const SLUG = `e2e-live-sync${RUN}`;
const CLEAN_PREFIX = "E2E-LIVE-sync";
const CTL_PREFIX = "E2E-LIVE-xsync";
const ACTOR = "e2e-live-sync";
const IP = { cron: "10.84.0.160", wrong: "10.84.0.161" };
const MOCK_KEY = "mock-youtube-api-key-not-secret";
const MOCK_SECRET = "mock-client-secret-not-secret";
const CRON_KEY = "e2e-live-cron-key-not-a-secret-value";     // 36 chars
const SHORT_KEY = "e2e-short-cron-key-23ch";                  // 23 chars: too short
const SETTINGS_KEY = Buffer.from("e2e-live-sync-fake-settings-key!").toString("base64");
const OVERLAY = { mode: "live", auto_starting: "1", auto_start: "1", auto_end: "1", complete_grace_seconds: "30" };
const GRACE_H = 3; // LIVE_UPCOMING_GRACE_HOURS

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
const secondsBetween = (a, b) => (Date.parse(`${b}Z`.replace(" ", "T")) - Date.parse(`${a}Z`.replace(" ", "T"))) / 1000;
const utc = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
const iso = (mysql) => `${mysql.replace(" ", "T")}Z`;

/* ── PHP processes ─────────────────────────────────────────────────────── */
function phpCommand(args) {
  return /\.sh$/i.test(PHP_BIN) ? ["bash", [PHP_BIN, ...args]] : [PHP_BIN, args];
}
const STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i;
function phpEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return {
    ...env,
    TRUSTED_PROXIES: "127.0.0.1,::1", SITE_URL: BASE, CORS_ORIGIN: "*",
    LIVE_ALLOW_SIMULATOR: "1",
    YOUTUBE_API_BASE_URL: `http://127.0.0.1:${PORT.mock}/youtube/v3`,
    YOUTUBE_OAUTH_TOKEN_URL: `http://127.0.0.1:${PORT.mock}/token`,
    LIVE_CRON_KEY: CRON_KEY,
    LIVE_SETTINGS_OVERLAY: JSON.stringify(OVERLAY),
    LIVE_SYNC_ONLY_TITLE_PREFIX: CLEAN_PREFIX,
    YOUTUBE_API_KEY: MOCK_KEY,
    LIVE_SETTINGS_KEY: SETTINGS_KEY,
    ...extra,
  };
}
const phpNoise = [];
function notePhpNoise(label, text) {
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(text);
  if (m) phpNoise.push(`${label}: ${m[0]}`);
}
function fixture(command, args = {}, extraEnv = {}) {
  const [cmd, argv] = phpCommand(["tests/support/live_fixtures.php", command, "-"]);
  const r = spawnSync(cmd, argv, { cwd: ROOT, input: JSON.stringify(args), encoding: "utf8", env: phpEnv(extraEnv), windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  notePhpNoise(`fixture ${command}`, `${r.stdout}\n${r.stderr}`);
  const last = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  let json = null;
  try { json = JSON.parse(last); } catch { /* reported below */ }
  if (!json) throw new Error(`fixture ${command} printed no JSON (exit ${r.status}): ${(r.stdout ?? "").slice(0, 300)} ${(r.stderr ?? "").slice(0, 300)}`);
  if (json.error) throw new Error(`fixture ${command}: ${json.error}${json.fields ? " " + JSON.stringify(json.fields) : ""}`);
  return json;
}
/** A PHP child whose HTTP calls the in-process mock must be able to answer: never spawnSync. */
function runPhpAsync(args, input = "", extraEnv = {}) {
  const [cmd, argv] = phpCommand(args);
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(extraEnv), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    child.on("error", (err) => { clearTimeout(timer); done({ code: -1, stdout, stderr: String(err) }); });
    child.stdin.end(input);
  });
}
const lastJson = (r) => {
  try { return JSON.parse((r.stdout ?? "").trim().split(/\r?\n/).pop() ?? ""); } catch { return { error: `${r.stdout} ${r.stderr}`.slice(0, 400) }; }
};
/** One liveCronRun() through the fixture. ids present (even []) scopes the run. */
async function sync(args = {}, extraEnv = {}) {
  const r = await runPhpAsync(["tests/support/live_fixtures.php", "sync", "-"], JSON.stringify({ actor: ACTOR, ...args }), extraEnv);
  notePhpNoise("fixture sync", `${r.stdout}\n${r.stderr}`);
  const json = lastJson(r);
  if (json.error) throw new Error(`sync: ${json.error}`);
  return json;
}
async function cli(args, extraEnv = {}) {
  const r = await runPhpAsync(["backend/bin/live_cron.php", ...args], "", extraEnv);
  notePhpNoise("live_cron", `${r.stdout}\n${r.stderr}`);
  return r;
}
const sql = (query, params = []) => fixture("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;
const row = (id) => one("SELECT * FROM live_streams WHERE id = ?", [id]);
const statusRows = (id) => rows("SELECT detail FROM admin_activity WHERE action = 'live_stream_status' AND subject = ? ORDER BY id", [`Stream #${id}`]);
const audit = (id) => rows("SELECT actor, action, subject, detail FROM admin_activity WHERE subject = ? ORDER BY id", [`Stream #${id}`]);
const setting = (k) => one("SELECT v FROM live_settings WHERE k = ?", [k])?.v ?? null;
const item = (res, id) => (res.items ?? []).find((i) => Number(i.id) === Number(id)) ?? null;
const requestsFor = (id, from = 0) => mock.requests.slice(from).filter((r) => /\/videos$/.test(r.path) && String(r.query?.id ?? "").split(",").includes(id));
const ytId = (suffix, n) => `E2Es${String(n).padStart(3, "0")}${suffix}`.slice(-11).padStart(11, "x"); // 11 chars, ends in the scenario

/* ── Servers ───────────────────────────────────────────────────────────── */
function startPhpServer(port, extraEnv = {}) {
  const [cmd, argv] = phpCommand(["-S", `127.0.0.1:${port}`, "-t", "backend", ROUTER]);
  const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(extraEnv), windowsHide: true });
  const s = { child, log: "", port };
  child.stdout.setEncoding("utf8").on("data", (d) => (s.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (s.log += d));
  return s;
}
async function waitForServer(base) {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`${base}/api/pulse`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
async function stopPhpServer(s) {
  if (!s) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(s.child.pid), "/T", "/F"], { windowsHide: true });
  else s.child.kill("SIGTERM");
  for (let i = 0; i < 20 && (await portInUse(s.port)); i += 1) await sleep(250);
}
const cookiesSet = [];
async function http(base, method, path, { ip = IP.cron, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { "X-Forwarded-For": ip, ...headers }, redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (res.headers.get("set-cookie")) cookiesSet.push(`${method} ${path}: ${res.headers.get("set-cookie")}`);
  return { status: res.status, headers: res.headers, text, data };
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */
let fixtureN = 0;
let ytN = 0;
const mk = (label, suffix, startsIn, over = {}) => {
  fixtureN += 1;
  ytN += 1;
  const id = ytId(suffix, ytN);
  const r = fixture("create-stream", {
    title_prefix: PREFIX, label, slug: `${SLUG}-${fixtureN}`, actor: "e2e", provider: "youtube", provider_reference: id,
    status: "SCHEDULED", starts_in_seconds: startsIn, ...over,
  });
  return { ...r, id: Number(r.id), yt: id };
};
const due = (ids, attempts) => fixture("due", attempts === undefined ? { ids } : { ids, attempts });
function cleanup() {
  const a = fixture("cleanup", { title_prefix: CLEAN_PREFIX, actors: [ACTOR], ips: Object.values(IP) });
  const b = fixture("cleanup", { title_prefix: CTL_PREFIX });
  return { streams: a.streams + b.streams, activity: a.activity + b.activity, buckets: a.buckets };
}

/* ── Run ───────────────────────────────────────────────────────────────── */
console.log(`live-sync — run ${RUN}, PHP ${PHP_BIN}, router ${ROUTER}`);
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
  if (!one("SHOW TABLES LIKE 'live_settings'")) {
    console.error("✗ live_settings is missing; apply database/migrations/012_live_automation.sql first.");
    process.exit(2);
  }
  console.log(`leftovers removed at start: ${show(cleanup())}`);
} catch (e) {
  console.error(`✗ the fixtures cannot reach the database or the live module: ${e.message}`);
  process.exit(2);
}
const dbName = one("SELECT DATABASE() AS db")?.db ?? "";
const SCRATCH = /^[A-Za-z0-9_]{1,54}$/.test(dbName) ? `${dbName}_e2e_empty` : null;
if (SCRATCH) sql(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
const settingsSnapshot = rows("SELECT k, v, is_secret FROM live_settings ORDER BY k");
const clearQuota = () => sql("UPDATE live_settings SET v = '' WHERE k IN ('quota_blocked_until', 'quota_units', 'quota_day', 'provider_notice')");

let mock = null;
let server = null;
let server2 = null;
try {
  mock = await startYoutubeMock({ port: PORT.mock, apiKey: MOCK_KEY, clientSecret: MOCK_SECRET });
  server = startPhpServer(PORT.php);
  if (!(await waitForServer(BASE))) {
    check(false, `the PHP server answers /api/pulse on ${PORT.php}`, server?.log.slice(0, 600));
    throw new Error("no PHP server");
  }
  clearQuota();

  /* 1. The CLI job */
  section("1. The CLI job");
  {
    let r = await cli(["--help"]);
    check(r.code === 0 && /--stream-ids/.test(r.stdout), "--help exits 0 with the usage", `${r.code} ${r.stdout.slice(0, 100)}`);
    r = await cli(["--bogus"]);
    check(r.code === 1 && /^live cron: unknown option/.test(r.stderr) && r.stdout === "", "an unknown flag exits 1 with the message on stderr", `${r.code} ${r.stdout} ${r.stderr.slice(0, 80)}`);
    r = await cli(["--limit=0"]);
    check(r.code === 1 && /--limit/.test(r.stderr), "--limit=0 is refused", `${r.code} ${r.stderr}`);
    r = await cli(["--stream-ids=1,x", "--json"]);
    check(r.code === 1 && lastJson(r).error, "--stream-ids with a non-id exits 1 with a JSON error under --json", `${r.code} ${r.stdout}`);
    const before = mock.requests.length;
    r = await cli(["--stream-ids=", "--json"]);
    let j = lastJson(r);
    check(r.code === 0 && j.checked === 0 && j.calls === 0 && mock.requests.length === before, "--stream-ids= (empty) checks nothing and makes no request", show(j));
    check(["checked", "changed", "started", "ended", "errors", "skipped", "calls", "units", "items", "locked", "duration_ms"].every((k) => k in j), "the CLI JSON carries the whole summary", show(j));

    const dry = mk("dry", "LIVE", 0);
    const snap = row(dry.id);
    const dryAudits = audit(dry.id).length;
    r = await cli([`--stream-ids=${dry.id}`, "--dry-run", "--json"]);
    j = lastJson(r);
    const it = item(j, dry.id);
    check(r.code === 0 && it?.outcome === "dry_run" && it.would === "live" && it.to === "LIVE" && j.calls === 1, "--dry-run prints the would-be move", show(j));
    check(JSON.stringify(row(dry.id)) === JSON.stringify(snap), "--dry-run leaves every column of the row byte-identical", show(row(dry.id)));
    check(audit(dry.id).length === dryAudits && statusRows(dry.id).length === 0, "--dry-run writes no audit or status row");
    r = await cli([`--stream-ids=${dry.id}`, "--limit=9999", "--max-seconds=9999"]);
    check(r.code === 0 && /checked 1/.test(r.stdout), "--limit / --max-seconds beyond the range are clamped, not refused", `${r.code} ${r.stdout}`);

    r = await cli(["--json"], { LIVE_SETTINGS_OVERLAY: JSON.stringify({ ...OVERLAY, mode: "off" }) });
    j = lastJson(r);
    check(r.code === 0 && j.skipped === 1 && j.reason, "mode = off exits 0 with the switched-off reason", `${r.code} ${show(j)}`);
    r = await cli([], { LIVE_SETTINGS_OVERLAY: JSON.stringify({ ...OVERLAY, mode: "off" }) });
    check(r.code === 0 && /not running/.test(r.stdout), "…and in plain text", `${r.code} ${r.stdout}`);

    // The cadence: a row checked inside its window is not asked again straight after.
    const cad = mk("cadence", "UPCM", 20 * 60);
    const a = await sync();
    check(item(a, cad.id) !== null && requestsFor(cad.yt).length === 1, "an unscoped run checks a fixture starting in 20 minutes", show(a));
    const mark = mock.requests.length;
    const b = await sync();
    check(item(b, cad.id) === null && requestsFor(cad.yt, mark).length === 0, "a second unscoped run straight after asks nothing about it (300 s cadence)", show(b));
    const c = row(cad.id);
    check(c.status === "SCHEDULED" && c.sync_state === "upcoming" && c.provider_scheduled_start_at && c.scheduled_start_at === cad.scheduled_start_at, "its provider_scheduled_start_at is stored while scheduled_start_at is untouched", show(c));

    if (SCRATCH) {
      try {
        sql(`CREATE DATABASE IF NOT EXISTS \`${SCRATCH}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        for (const t of ["live_streams", "temples", "deities"]) sql(`CREATE TABLE IF NOT EXISTS \`${SCRATCH}\`.\`${t}\` LIKE \`${dbName}\`.\`${t}\``);
        r = await cli([], { DB_NAME: SCRATCH });
        check(r.code === 0 && /012_live_automation\.sql/.test(r.stdout) && !/Warning|Notice/.test(r.stdout + r.stderr), "without migration 012 the CLI exits 0 and names the migration", `${r.code} ${r.stdout} ${r.stderr}`);
        sql(`DROP TABLE \`${SCRATCH}\`.\`live_streams\``);
        r = await cli([], { DB_NAME: SCRATCH });
        check(r.code === 1 && /011_live_streams\.sql/.test(r.stderr), "without migration 011 the CLI exits 1", `${r.code} ${r.stdout} ${r.stderr}`);
      } finally {
        sql(`DROP DATABASE IF EXISTS \`${SCRATCH}\``);
      }
    } else check(false, "the database name is plain enough for a scratch copy", dbName);
  }

  /* 2. The flow */
  section("2. The flow");
  {
    const up = mk("upcm", "UPCM", 5 * 60);
    const lv = mk("live", "LIVE", 0);
    const dn = mk("done", "DONE", -15 * 60);
    const cu = mk("catchup", "DONE", -15 * 60);
    fixture("set-status", { id: dn.id, status: "LIVE", actor: "e2e" });
    sql("UPDATE live_streams SET synced_status = 'LIVE' WHERE id = ?", [dn.id]); // as if the job had moved it
    const before = mock.requests.length;
    const res = await sync({ ids: [up.id, lv.id, dn.id, cu.id] });
    check(res.calls === 1 && mock.requests.length - before === 1 && requestsFor(up.yt, before).length === 1 && requestsFor(cu.yt, before).length === 1, "four scoped rows are one videos.list request", show(res));
    check(item(res, up.id)?.outcome === "starting" && row(up.id).status === "STARTING", "…UPCM starting in 5 minutes → STARTING", show(item(res, up.id)));
    const l = row(lv.id);
    check(item(res, lv.id)?.outcome === "live" && l.status === "LIVE" && l.synced_status === "LIVE" && l.actual_start_at && statusRows(lv.id).length === 1, "…LIVE starting now → LIVE with actual_start_at and one status row", show(l));
    const d = row(dn.id);
    check(item(res, dn.id)?.outcome === "ended" && d.status === "COMPLETED" && d.actual_end_at && d.recording_url, "a LIVE row given a …DONE video → COMPLETED with actual_end_at and recording_url", show(d));
    const c = row(cu.id);
    check(item(res, cu.id)?.outcome === "ended" && c.status === "COMPLETED" && c.actual_start_at && c.actual_end_at, "a SCHEDULED …DONE row catches up to COMPLETED in one sweep", show(c));
    check(statusRows(cu.id).length === 2 && /→ LIVE/.test(statusRows(cu.id)[0]?.detail) && /→ COMPLETED/.test(statusRows(cu.id)[1]?.detail), "…with two live_stream_status audit rows", show(statusRows(cu.id)));
    check(res.started === 2 && res.ended === 2 && res.changed === 4 && res.errors === 0, "the counters: started 2, ended 2, changed 4", show(res));
    check(l.next_sync_at && secondsBetween(l.last_synced_at, l.next_sync_at) >= 30 && secondsBetween(l.last_synced_at, l.next_sync_at) <= 60, "a LIVE row is due again inside 60 s", `${l.last_synced_at} → ${l.next_sync_at}`);
    check(c.next_sync_at === null && c.sync_enabled === 1, "a COMPLETED row has no next check", show(c));

    // A stale row YouTube had already answered still catches up (§0.2 #6).
    const st = mk("stale", "DONE", -9 * 3600, { ends_in_seconds: -8 * 3600 });
    mock.setVideo(st.yt, { scheduledStartTime: iso(st.scheduled_start_at), actualStartTime: iso(utc(-9 * 3600 + 120)), actualEndTime: iso(st.scheduled_end_at) });
    mock.failNext(st.yt, 1, "0500");
    const f = await sync({ ids: [st.id] });
    let s = row(st.id);
    check(item(f, st.id)?.outcome === "unreachable" && s.sync_attempts === 0 && s.next_sync_at && s.status === "SCHEDULED", "a call-level 500 backs the row off without counting a row failure", show(s));
    sql("UPDATE live_streams SET sync_state = 'upcoming', last_sync_ok_at = ? WHERE id = ?", [utc(-9 * 3600 - 1200), st.id]);
    due([st.id]);
    const u = await sync();
    s = row(st.id);
    check(item(u, st.id)?.outcome === "ended" && s.status === "COMPLETED" && statusRows(st.id).length === 2, "after due, an unscoped sweep lists and completes the stale row (catch-up disjunct)", show(item(u, st.id) ?? u));
  }

  /* 3. Guards */
  section("3. Guards");
  {
    const old = -(GRACE_H + 1) * 3600;
    const priv = mk("priv", "PRIV", old);
    const noem = mk("noem", "NOEM", old);
    const miss = mk("miss", "0404", old);
    const nols = mk("nols", "NOLS", 0);
    const paused = mk("paused", "LIVE", 0);
    sql("UPDATE live_streams SET sync_enabled = 0 WHERE id = ?", [paused.id]);
    const fwd = mk("forward", "UPCM", 20 * 60);
    const back = mk("backward", "UPCM", 20 * 60);
    const res = await sync({ ids: [priv.id, noem.id, miss.id, nols.id, fwd.id, back.id] });
    for (const [f, word] of [[priv, "not_found"], [noem, "restricted"], [miss, "not_found"]]) {
      const r = row(f.id);
      check(item(res, f.id)?.outcome === word && r.status === "SCHEDULED" && r.sync_attempts === 1 && r.sync_error && !/^notice:/.test(r.sync_error), `…${f.yt.slice(-4)} past the grace: ${word}, a row failure with sync_attempts 1`, show(r));
    }
    check(item(res, nols.id)?.outcome === "not_broadcast" && row(nols.id).status === "SCHEDULED", "…NOLS starting now reports not_broadcast", show(item(res, nols.id)));
    check(res.checked === 6 && res.errors === 4 && res.changed === 0, "the counters: checked 6, errors 4, changed 0", show(res));

    // A forward human move is adopted; a backwards one pauses.
    fixture("set-status", { id: fwd.id, status: "LIVE", actor: "e2e" });
    sql("UPDATE live_streams SET synced_status = 'SCHEDULED' WHERE id = ?", [fwd.id]);
    fixture("set-status", { id: back.id, status: "STARTING", actor: "e2e" });
    fixture("set-status", { id: back.id, status: "SCHEDULED", actor: "e2e" });
    sql("UPDATE live_streams SET synced_status = 'STARTING' WHERE id = ?", [back.id]);
    const hm = await sync({ ids: [fwd.id, back.id] });
    const fr = row(fwd.id);
    check(item(hm, fwd.id)?.outcome === "overridden" && fr.status === "LIVE" && fr.synced_status === "LIVE" && fr.sync_enabled === 1, "a forward human move is adopted (overridden) and becomes the baseline", show(fr));
    const br = row(back.id);
    check(item(hm, back.id)?.outcome === "paused" && br.status === "SCHEDULED" && br.sync_enabled === 0 && br.sync_error === null && br.next_sync_at === null, "a backwards human move pauses the row with sync_error NULL", show(br));
    check(audit(back.id).some((a) => a.action === "live_sync_paused" && /by hand/.test(a.detail)), "…with one live_sync_paused audit line", show(audit(back.id)));

    // A paused row is skipped unscoped, reports paused when scoped.
    const un = await sync();
    check(item(un, paused.id) === null && row(paused.id).status === "SCHEDULED", "a row with sync_enabled = 0 is not in an unscoped sweep", show(un));
    const sc = await sync({ ids: [paused.id] });
    check(item(sc, paused.id)?.outcome === "paused" && row(paused.id).status === "SCHEDULED", "Check now on it reports paused without moving it", show(sc));

    // auto_end = 0 holds.
    const held = mk("held", "DONE", -15 * 60);
    fixture("set-status", { id: held.id, status: "LIVE", actor: "e2e" });
    sql("UPDATE live_streams SET synced_status = 'LIVE' WHERE id = ?", [held.id]);
    const hd = await sync({ ids: [held.id] }, { LIVE_SETTINGS_OVERLAY: JSON.stringify({ ...OVERLAY, auto_end: "0" }) });
    check(item(hd, held.id)?.outcome === "held" && row(held.id).status === "LIVE", "auto_end = 0 holds a LIVE row whose video has ended", show(item(hd, held.id)));

    // Never selected.
    const never = [];
    for (const [label, over] of [["draft", { status: "DRAFT" }], ["cancelled", { status: "SCHEDULED" }], ["deleted", { deleted: true }], ["custom", { provider: "custom", provider_reference: "", playback_url: "https://example.com/x.m3u8" }]]) {
      const f = mk(label, "LIVE", 0, over);
      if (label === "cancelled") fixture("set-status", { id: f.id, status: "CANCELLED", actor: "e2e" });
      never.push(f);
    }
    const ns = await sync();
    check(never.every((f) => item(ns, f.id) === null), "DRAFT / CANCELLED / deleted / non-YouTube rows are never selected", show(ns));

    // G24: the morning video in the evening row.
    const ev = mk("evening", "DONE", 5 * 60);
    const T = Date.parse(iso(ev.scheduled_start_at));
    const at = (minutesBefore) => new Date(T - minutesBefore * 60_000).toISOString();
    mock.setVideo(ev.yt, { scheduledStartTime: at(11 * 60 + 30), actualStartTime: at(11 * 60 + 28), actualEndTime: at(10 * 60 + 20) });
    const noticeBefore = setting("provider_notice");
    const g24 = await sync({ ids: [ev.id] });
    const er = row(ev.id);
    check(item(g24, ev.id)?.outcome === "mismatch" && er.status === "SCHEDULED" && /^notice:/.test(er.sync_error ?? "") && er.sync_error.includes(`#${ev.id}`), "G24: a video from another time stays put with a mismatch notice naming the stream", show(er));
    check(setting("provider_notice") === noticeBefore, "…and provider_notice is untouched");
    const chan = mk("channel", "LIVE", 0);
    const ch = await sync({ ids: [chan.id] }, { YOUTUBE_CHANNEL_ID: "UCothrchannlothrchannlot" });
    check(item(ch, chan.id)?.outcome === "mismatch" && row(chan.id).status === "SCHEDULED", "a video on another channel than YOUTUBE_CHANNEL_ID is a mismatch", show(item(ch, chan.id)));

    // G22 and D1.
    const horizon = mk("horizon", "UPCM", -(48 + 1) * 3600);
    const inside = mk("inside", "UPCM", -2 * 3600);
    const stuck = mk("stuck", "UPCM", old);
    fixture("set-status", { id: stuck.id, status: "STARTING", actor: "e2e" });
    const stuckR = mk("stuck-restricted", "NOEM", old);
    fixture("set-status", { id: stuckR.id, status: "STARTING", actor: "e2e" });
    const mark = mock.requests.length;
    const g22 = await sync();
    check(item(g22, horizon.id) === null && requestsFor(horizon.yt, mark).length === 0 && row(horizon.id).status === "SCHEDULED", "a SCHEDULED row past catchup_hours is neither selected nor asked about", show(g22));
    check(item(g22, inside.id)?.outcome === "unchanged" && row(inside.id).status === "SCHEDULED", "one two hours past inside the horizon is checked and stays SCHEDULED", show(item(g22, inside.id)));
    const sr = row(stuck.id);
    check(item(g22, stuck.id)?.outcome === "paused" && sr.status === "STARTING" && sr.sync_enabled === 0 && /^paused: stuck/.test(sr.sync_error ?? "") && sr.next_sync_at === null, "G22: a STARTING row past the grace with an upcoming video is paused as stuck", show(sr));
    check(audit(stuck.id).filter((a) => a.action === "live_sync_paused").length === 1, "…with one live_sync_paused row");
    const rr = row(stuckR.id);
    check(item(g22, stuckR.id)?.outcome === "restricted" && rr.status === "STARTING" && rr.sync_enabled === 1 && /^notice:/.test(rr.sync_error ?? "") && rr.sync_attempts === 0, "a STARTING …NOEM row of the same age keeps going with the N5 notice", show(rr));
    check(rr.next_sync_at && secondsBetween(rr.last_synced_at, rr.next_sync_at) >= 800, "…and is due again in about 900 s", `${rr.last_synced_at} → ${rr.next_sync_at}`);

    const longLive = mk("long-live", "LIVE", -8 * 3600, { ends_in_seconds: -7 * 3600 });
    fixture("set-status", { id: longLive.id, status: "LIVE", actor: "e2e" });
    sql("UPDATE live_streams SET synced_status = 'LIVE' WHERE id = ?", [longLive.id]);
    const ll1 = await sync({ ids: [longLive.id] });
    check(item(ll1, longLive.id)?.outcome === "unchanged" && row(longLive.id).sync_enabled === 1, "a LIVE row long past its scheduled end is not paused", show(item(ll1, longLive.id)));
    mock.setVideo(longLive.yt, { liveBroadcastContent: "none", scheduledStartTime: iso(longLive.scheduled_start_at), actualStartTime: iso(utc(-8 * 3600 + 120)), actualEndTime: iso(utc(-300)), concurrentViewers: null });
    const ll2 = await sync({ ids: [longLive.id] });
    check(item(ll2, longLive.id)?.outcome === "ended" && row(longLive.id).status === "COMPLETED", "…and completes once YouTube reports the end", show(item(ll2, longLive.id)));

    const n4 = mk("n4", "LIVE", -15 * 60);
    fixture("set-status", { id: n4.id, status: "LIVE", actor: "e2e" });
    sql("UPDATE live_streams SET synced_status = 'LIVE' WHERE id = ?", [n4.id]);
    mock.setVideo(n4.yt, { liveBroadcastContent: "none", actualEndTime: null, concurrentViewers: null });
    const n4r = await sync({ ids: [n4.id] });
    const n4row = row(n4.id);
    check(item(n4r, n4.id)?.outcome === "unchanged" && n4row.status === "LIVE" && n4row.sync_enabled === 1 && /^notice:/.test(n4row.sync_error ?? "") && /end it by hand/.test(n4row.sync_error), "N4: a LIVE row YouTube no longer reports live stays LIVE with the notice in its own sync_error", show(n4row));
    check(secondsBetween(n4row.last_synced_at, n4row.next_sync_at) <= 60, "…and is due again in about 60 s", `${n4row.last_synced_at} → ${n4row.next_sync_at}`);
  }

  /* 4. Failures and back-off */
  section("4. Failures and back-off");
  try {
    const r429 = mk("rate", "0429", 0);
    const a = await sync({ ids: [r429.id] });
    let r = row(r429.id);
    check(item(a, r429.id)?.outcome === "rate_limited" && /^transient:/.test(r.sync_error ?? "") && r.status === "SCHEDULED" && r.sync_attempts === 0, "…0429 stores a transient error and moves nothing", show(r));
    check(secondsBetween(r.last_synced_at, r.next_sync_at) >= 30, "…and honours Retry-After: 30", `${r.last_synced_at} → ${r.next_sync_at}`);

    const flaky = mk("flaky", "LIVE", 0);
    mock.failNext(flaky.yt, 2, "0500");
    const f1 = await sync({ ids: [flaky.id] });
    const f2 = await sync({ ids: [flaky.id] });
    const f3 = await sync({ ids: [flaky.id] });
    r = row(flaky.id);
    check(item(f1, flaky.id)?.outcome === "unreachable" && item(f2, flaky.id)?.outcome === "unreachable" && item(f3, flaky.id)?.outcome === "live", "two 500s then an answer: unreachable, unreachable, live", `${item(f1, flaky.id)?.outcome} ${item(f2, flaky.id)?.outcome} ${item(f3, flaky.id)?.outcome}`);
    check(r.status === "LIVE" && r.sync_error === null && r.sync_attempts === 0, "…the move clears sync_error and sync_attempts", show(r));
    check(setting("provider_notice") === "" || setting("provider_notice") === null, "…and the answered call clears provider_notice", show(setting("provider_notice")));

    // A call-level outage never pauses anything (twelve runs).
    const out1 = mk("outage-a", "0500", 0);
    const out2 = mk("outage-b", "0500", 0);
    for (let i = 0; i < 12; i += 1) await sync({ ids: [out1.id, out2.id] });
    const o1 = row(out1.id);
    const o2 = row(out2.id);
    check(o1.sync_enabled === 1 && o2.sync_enabled === 1 && o1.sync_attempts === 0 && o2.sync_attempts === 0 && o1.status === "SCHEDULED", "twelve call-level failures pause nothing and count no row failure", show([o1, o2]));
    check(audit(out1.id).every((x) => x.action !== "live_sync_paused"), "…and write no live_sync_paused row");
    check(secondsBetween(o1.last_synced_at, o1.next_sync_at) >= 30, "…but the row is backed off", `${o1.last_synced_at} → ${o1.next_sync_at}`);

    // G15: twelve row failures pause.
    const gone = mk("gone", "0404", -(GRACE_H + 1) * 3600);
    for (let i = 0; i < 12; i += 1) await sync({ ids: [gone.id] });
    r = row(gone.id);
    check(r.sync_enabled === 0 && r.sync_attempts === 12 && /^paused: after 12 failures/.test(r.sync_error ?? "") && r.next_sync_at === null, "G15: twelve row failures pause the row", show(r));
    const gone2 = mk("gone-2", "0404", -(GRACE_H + 1) * 3600);
    due([gone2.id], 11);
    await sync({ ids: [gone2.id] });
    check(row(gone2.id).sync_enabled === 0 && row(gone2.id).sync_attempts === 12, "…and due {attempts: 11} then one run pauses another", show(row(gone2.id)));

    // The mixed batch.
    const m404 = mk("mix-404", "0404", -(GRACE_H + 1) * 3600);
    const mLive = mk("mix-live", "LIVE", 0);
    const mUp = mk("mix-upcm", "UPCM", 5 * 60);
    const mark = mock.requests.length;
    const mixed = await sync({ ids: [m404.id, mLive.id, mUp.id] });
    const vids = mock.requests.slice(mark).filter((q) => /\/videos$/.test(q.path));
    check(vids.length === 1 && [m404.yt, mLive.yt, mUp.yt].every((id) => String(vids[0]?.query?.id ?? "").split(",").includes(id)), "a mixed batch is one videos.list request carrying all three ids", show(vids.map((v) => v.query)));
    check(row(mLive.id).status === "LIVE" && row(mUp.id).status === "STARTING" && row(m404.id).status === "SCHEDULED" && row(m404.id).sync_attempts === 1 && row(mLive.id).sync_attempts === 0, "…LIVE moves, …UPCM starts, only …0404 fails", show(mixed));

    // A wrong key is auth, not request.
    const wk = mk("wrong-key", "LIVE", 0);
    const wkr = await sync({ ids: [wk.id] }, { YOUTUBE_API_KEY: "wrong-key-not-secret" });
    check(item(wkr, wk.id)?.outcome === "auth" && /refused this key/.test(setting("provider_notice") ?? ""), "a wrong API key ends auth with the key sentence in provider_notice", `${show(item(wkr, wk.id))} ${setting("provider_notice")}`);
    check(!JSON.stringify(rows("SELECT sync_error FROM live_streams WHERE title_en LIKE ?", [`${PREFIX}%`])).includes("wrong-key-not-secret") && !(setting("provider_notice") ?? "").includes("wrong-key"), "…and the key itself appears in no row");
    clearQuota();

    // Quota.
    const q = mk("quota", "0403", 0);
    const qr = await sync({ ids: [q.id] });
    check(item(qr, q.id)?.outcome === "quota" && setting("quota_blocked_until"), "…0403 opens the quota breaker", `${show(item(qr, q.id))} ${setting("quota_blocked_until")}`);
    check(row(q.id).next_sync_at === setting("quota_blocked_until"), "…and the row's next check is exactly quota_blocked_until", `${row(q.id).next_sync_at} vs ${setting("quota_blocked_until")}`);
    const before = mock.requests.length;
    const q2 = await sync({ ids: [q.id] });
    check(mock.requests.length === before && q2.calls === 0 && q2.skipped >= 1, "while the breaker is open a run makes zero requests", show(q2));
    const cliQ = await cli(["--json"]);
    check(cliQ.code === 0 && lastJson(cliQ).skipped === 1 && mock.requests.length === before, "…and the CLI exits 0 with the quota reason", `${cliQ.code} ${cliQ.stdout}`);
  } finally {
    clearQuota();
  }

  /* 5. Quota and batching */
  section("5. Quota and batching");
  {
    const twelve = [];
    for (let i = 0; i < 12; i += 1) twelve.push(mk(`batch-${i}`, "UPCM", 20 * 60));
    const mark = mock.requests.length;
    const b = await sync({ ids: twelve.map((f) => f.id) });
    const vids = mock.requests.slice(mark).filter((q) => /\/videos$/.test(q.path));
    check(vids.length === 1 && b.calls === 1 && b.units === 1 && String(vids[0]?.query?.id ?? "").split(",").length === 12, "twelve scoped rows are one videos.list request with twelve ids", show(b));
    check(mock.requests.slice(mark).every((q) => !/search/.test(q.path)), "no request path contains search");
    check(vids.every((v) => v.query?.key === MOCK_KEY && !Object.entries(v.headers).some(([k, val]) => k !== "host" && String(val).includes(MOCK_KEY))), "the API key travels in the query and in no header", show(vids[0]?.headers));
    const twinA = mk("twin-a", "LIVE", 0);
    const twinB = mk("twin-b", "LIVE", 0, { provider_reference: twinA.yt });
    const mark2 = mock.requests.length;
    const t = await sync({ ids: [twinA.id, twinB.id] });
    const ids = String(mock.requests.slice(mark2).find((q) => /\/videos$/.test(q.path))?.query?.id ?? "").split(",");
    check(ids.length === 1 && row(twinA.id).status === "LIVE" && row(twinB.id).status === "LIVE" && t.started === 2, "two rows sharing one video id both move off a single item", `${ids} ${show(t)}`);
  }

  /* 6. The HTTP trigger */
  section("6. The HTTP trigger");
  {
    server2 = startPhpServer(PORT.php2, { LIVE_CRON_KEY: "" });
    check(await waitForServer(BASE2), `a keyless server answers on ${PORT.php2}`, server2.log.slice(0, 300));
    let r = await http(BASE2, "GET", `/api/live-cron?key=${CRON_KEY}`);
    check(r.status === 404, "without LIVE_CRON_KEY the endpoint is a bare 404", `${r.status} ${r.text}`);
    await stopPhpServer(server2);
    server2 = startPhpServer(PORT.php2, { LIVE_CRON_KEY: SHORT_KEY });
    check(await waitForServer(BASE2), "a server with a 23-character key starts", server2.log.slice(0, 300));
    r = await http(BASE2, "GET", `/api/live-cron?key=${SHORT_KEY}`);
    check(r.status === 404, "a key shorter than 24 characters keeps the endpoint off (404)", `${r.status} ${r.text}`);
    await stopPhpServer(server2);
    server2 = null;

    r = await http(BASE, "GET", "/api/live-cron");
    check(r.status === 403, "no key → 403", `${r.status} ${r.text}`);
    r = await http(BASE, "GET", "/api/live-cron", { headers: { "X-Cron-Key": "wrong-wrong-wrong-wrong-wrong" } });
    check(r.status === 403, "a wrong X-Cron-Key → 403", `${r.status}`);
    r = await http(BASE, "GET", "/api/live-cron?key=wrong-wrong-wrong-wrong-wrong");
    check(r.status === 403, "a wrong ?key= → 403", `${r.status}`);
    r = await http(BASE, "GET", "/api/live-cron?key[]=x");
    check(r.status === 403, "?key[]=x → 403, never 500", `${r.status} ${r.text}`);
    for (const method of ["GET", "POST"]) {
      r = await http(BASE, method, "/api/live-cron", { headers: { "X-Cron-Key": CRON_KEY } });
      check(r.status === 200 && JSON.stringify(Object.keys(r.data ?? {}).sort()) === JSON.stringify(["changed", "checked", "ended", "errors", "locked", "skipped", "started"]), `${method} with the key → 200 with exactly the seven counters`, `${r.status} ${r.text}`);
      check(!("items" in (r.data ?? {})) && !("calls" in (r.data ?? {})) && !("units" in (r.data ?? {})) && !("duration_ms" in (r.data ?? {})), `${method}: no items, calls, units or duration_ms`);
    }
    r = await http(BASE, "GET", `/api/live-cron?key=${CRON_KEY}`);
    check(r.status === 200 && r.data?.locked === false, "?key= works too", `${r.status} ${r.text}`);
    r = await http(BASE, "PUT", "/api/live-cron", { headers: { "X-Cron-Key": CRON_KEY } });
    check(r.status === 405 && r.headers.get("allow") === "GET, POST", "PUT → 405 with Allow: GET, POST", `${r.status} ${r.headers.get("allow")}`);
    for (let i = 0; i < 30; i += 1) await http(BASE, "GET", "/api/live-cron", { ip: IP.wrong });
    r = await http(BASE, "GET", "/api/live-cron", { ip: IP.wrong, headers: { "X-Cron-Key": CRON_KEY } });
    check(r.status === 429, "thirty wrong keys from one address → 429 even with the right key", `${r.status} ${r.text}`);

    // The lock.
    const [cmd, argv] = phpCommand(["tests/support/live_fixtures.php", "hold-lock", "-"]);
    const holder = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(), windowsHide: true });
    let holderOut = "";
    holder.stdout.setEncoding("utf8").on("data", (d) => (holderOut += d));
    holder.stdin.end(JSON.stringify({ seconds: 15 }));
    for (let i = 0; i < 80 && !/"locked":true/.test(holderOut); i += 1) await sleep(100);
    check(/"locked":true/.test(holderOut), "the lock holder reports it has the lock", holderOut);
    const [h, c] = await Promise.all([http(BASE, "GET", "/api/live-cron", { headers: { "X-Cron-Key": CRON_KEY } }), cli([])]);
    check(h.status === 200 && h.data?.locked === true && h.data?.checked === 0, "while the lock is held the HTTP call answers 200 with locked: true", `${h.status} ${h.text}`);
    check(c.code === 0 && /another run holds the lock/.test(c.stdout), "…and the CLI says so and exits 0", `${c.code} ${c.stdout} ${c.stderr}`);
    holder.kill();
    await new Promise((done) => holder.on("close", done));
  }

  /* 7. Hygiene */
  section("7. Hygiene");
  {
    check(cookiesSet.length === 0, "/api/live-cron sets no cookie", cookiesSet.join(" | "));
    const dump = JSON.stringify(rows("SELECT sync_error FROM live_streams WHERE title_en LIKE ?", [`${PREFIX}%`])) + JSON.stringify(rows("SELECT detail FROM admin_activity WHERE actor = ? OR subject LIKE 'Stream #%'", [ACTOR])) + JSON.stringify(rows("SELECT k, v FROM live_settings WHERE is_secret = 0"));
    check(!dump.includes(MOCK_KEY) && !dump.includes(MOCK_SECRET) && !dump.includes("sbx1:") && !dump.includes(CRON_KEY), "no credential in any live_streams, admin_activity or plain live_settings row");
    check(!server.log.includes(MOCK_KEY) && !server.log.includes(CRON_KEY), "no credential in the server log");
    check(phpNoise.length === 0, "no PHP warnings, notices or fatals from the fixtures, the CLI or the sweeps", phpNoise.slice(0, 5).join(" | "));
  }
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  section("Cleanup");
  try {
    clearQuota();
    sql("UPDATE live_settings SET v = '' WHERE k IN ('oauth_revoked_at', 'oauth_revoked_reason')");
    const removed = cleanup();
    console.log(`  removed ${show(removed)}`);
    const left = Number(one("SELECT COUNT(*) AS c FROM live_streams WHERE title_en LIKE ? OR title_en LIKE ?", [`${CLEAN_PREFIX}%`, `${CTL_PREFIX}%`])?.c);
    check(left === 0, "cleanup removed every stream this suite created", `${left} left`);
    check(Number(one("SELECT COUNT(*) AS c FROM admin_activity WHERE actor = ?", [ACTOR])?.c) === 0, "no e2e-live-sync audit row is left");
    // Restore the settings the run touched (the job writes only its operational rows).
    for (const s of settingsSnapshot) sql("UPDATE live_settings SET v = ? WHERE k = ? AND is_secret = 0", [s.v, s.k]);
    const after = rows("SELECT k, v, is_secret FROM live_settings ORDER BY k");
    check(JSON.stringify(after) === JSON.stringify(settingsSnapshot), "live_settings equals its snapshot", show(after.filter((a, i) => JSON.stringify(a) !== JSON.stringify(settingsSnapshot[i]))));
    if (SCRATCH) check(!one("SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?", [SCRATCH]), "the scratch database is gone");
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
  await stopPhpServer(server);
  await stopPhpServer(server2);
  if (mock) await mock.close();
  const reported = (server?.log ?? "").split(/\r?\n/).filter((l) => /\[live|PHP (Warning|Notice|Deprecated|Fatal)/.test(l));
  if (reported.length) console.log(`  server log (${reported.length} line(s)):\n${reported.slice(0, 40).map((l) => `    ${l.slice(0, 400)}`).join("\n")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
