#!/usr/bin/env node
/**
 * tests/live-health.mjs — Live Darshan health monitoring (Live phases 9 and
 * 10; brief §16 "current livestream" on the dashboard, §32 unavailable /
 * deleted video, gap G-11).
 *
 *   coverage: one health verdict per broadcast read off the migration 012 sync
 *   columns — healthy, check overdue (LIVE and starts-soon SCHEDULED), failing
 *   (auth / request), needs attention (video not found / private / marked
 *   offline / marked error), automation paused, manual, notice (quota /
 *   transient / notice) and not in rotation — through GET
 *   /api/admin/live-streams?include=health; the dashboard card (status,
 *   provider, started, viewers, last check, issues) for the owner and a
 *   viewer; the summary when automation is off; no credential in any page or
 *   answer; 401 without a session (E2E-045)
 *
 *   node tests/live-health.mjs
 *
 * Starts two PHP servers (automation on with a fake key, and off). Needs the
 * DB_* environment and the admin account admin/Admin@Test123 (ADMIN_USERNAME /
 * ADMIN_PASSWORD override). Rows are titled "E2E-LIVE-hlth<run> …" and the
 * accounts e2ehlth_<run>_*; everything is removed in `finally`.
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
const P = `E2E-LIVE-hlth${RUN}`;
const ACTOR = `e2e-live-hlth${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const VIEWER = { user: `e2ehlth_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" };
const FAKE_KEY = "e2e-fake-youtube-key-not-a-secret-AIza0000";
const SETTINGS_KEY = Buffer.from("e2e-live-hlth-fake-settings-key!").toString("base64");
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const YT = "dQw4w9WgXcQ";

let checks = 0;
const logs = { on: "", off: "" };
const servers = [];
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };
let xffN = 0;
const xff = () => `10.96.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const flashOf = (html) => html.match(/alert[^>]*>([^<]+)/)?.[1] ?? "";
const utc = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");

const STRIP = /^(LIVE_|YOUTUBE_|GOOGLE_)/i;
function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIP.test(k)) env[k] = v;
  return env;
}
function fixture(command, args) {
  const r = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), command, "-"], {
    cwd: root, input: JSON.stringify(args), encoding: "utf8", env: baseEnv(),
  });
  const json = JSON.parse((r.stdout ?? "").trim().split("\n").at(-1) || "{}");
  assert.ok(!json.error, `fixture ${command}: ${json.error} ${JSON.stringify(json.fields ?? "")}`);
  return json;
}
const sql = (query, params = []) => fixture("sql", { query, params });
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redirected = (r) => r.status === 302 || r.status === 303;

function jar(base) {
  let cookie = "";
  const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  const s = {
    async get(path, headers = {}) {
      const r = await fetch(base + path, { headers: { cookie, "X-Forwarded-For": xff(), ...headers }, redirect: "manual" });
      grab(r);
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async json(path) {
      const r = await s.get(path);
      let body = null;
      try { body = JSON.parse(r.text); } catch { /* asserted below */ }
      return { status: r.status, body, text: r.text };
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
      const r = await s.post("/admin/login.php", { _csrf: csrfOf(page.text), username, password, next: "" });
      check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), `${username} signed in`, `${r.status} ${flashOf(r.text)}`);
      return r;
    },
  };
  return s;
}

async function startServer(name, extraEnv) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  const base = `http://127.0.0.1:${port}`;
  const passHash = process.env.ADMIN_PASS_HASH
    || spawnSync(php, ["-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);", ADMIN.password], { encoding: "utf8" }).stdout.trim();
  const server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: resolve(root, "backend"),
    env: { ...baseEnv(), TRUSTED_PROXIES: "127.0.0.1", LIVE_ALLOW_SIMULATOR: "1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash, SITE_URL: base, LIVE_SETTINGS_KEY: SETTINGS_KEY, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(server);
  server.stdout.on("data", (d) => { logs[name] += d; });
  server.stderr.on("data", (d) => { logs[name] += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(logs[name]);
    try { ready = (await fetch(`${base}/api/calendar`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, `PHP server (${name}) started`);
  return base;
}

const ids = {};
function stream(key, status, extra = {}) {
  const row = fixture("create-stream", {
    title_prefix: P, label: key, status, provider: "youtube", provider_reference: YT, actor: ACTOR,
    scheduled_start_local: extra.scheduled_start_local, timezone: "Asia/Kolkata", ...extra.create,
  });
  ids[key] = row.id;
  if (extra.set) {
    const cols = Object.keys(extra.set);
    sql(`UPDATE live_streams SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`, [...cols.map((c) => extra.set[c]), row.id]);
  }
  return row.id;
}
const byId = (list, key) => list.find((s) => s.id === ids[key]);

try {
  const probe = fixture("probe", {});
  assert.ok(probe.tables, "apply migrations 011 and 012 first");
  const migrated = sql("SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'live_streams' AND COLUMN_NAME IN ('sync_enabled','sync_state','sync_error','last_synced_at','last_sync_ok_at','viewer_count')").rows[0];
  check(Number(migrated.n) === 6, "migration 012 sync columns are the health source (no duplicate health_* columns needed)");

  const on = await startServer("on", { LIVE_SETTINGS_OVERLAY: JSON.stringify({ mode: "live", poll_seconds_live: "60", poll_seconds_soon: "300", lead_minutes: "30" }), YOUTUBE_API_KEY: FAKE_KEY });
  const off = await startServer("off", { LIVE_SETTINGS_OVERLAY: JSON.stringify({ mode: "off" }) });

  /* ── fixtures: one row per verdict ──────────────────────────────────── */
  const now = utc();
  const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
  stream("healthy", "LIVE", { set: { sync_state: "live", last_synced_at: now, last_sync_ok_at: now, viewer_count: 1234, actual_start_at: utc(-900) } });
  stream("overdue", "LIVE", { set: { sync_state: "live", last_synced_at: utc(-3600), last_sync_ok_at: utc(-3600), viewer_count: 7 } });
  stream("never", "LIVE", {});
  stream("auth", "LIVE", { set: { sync_error: "auth: YouTube refused the API key — check it in Admin → YouTube Automation.", last_synced_at: now } });
  stream("request", "STARTING", { set: { sync_error: "request: the request was malformed", last_synced_at: now } });
  stream("missing", "STARTING", { set: { sync_state: "missing", sync_error: `not_found: ${P} missing: YouTube did not return this video (deleted, private, or the id may be wrong).`, last_synced_at: now } });
  stream("private", "LIVE", { set: { sync_state: "restricted", sync_error: `config: ${P} private: the YouTube video is private or not embeddable; it must be public or unlisted, and embeddable.`, last_synced_at: now } });
  stream("quota", "LIVE", { set: { sync_error: "quota: the day's YouTube quota is used up", last_synced_at: now, sync_state: "live", last_sync_ok_at: utc(-120) } });
  stream("transient", "LIVE", { set: { sync_error: "transient: the check failed", last_synced_at: now } });
  stream("notice", "SCHEDULED", { scheduled_start_local: `${tomorrow} 18:00`, set: { sync_error: "notice: YouTube says this broadcast is scheduled for a different time", last_synced_at: now, sync_state: "upcoming" } });
  stream("manual", "LIVE", { set: { sync_enabled: 0, last_synced_at: utc(-7200) } });
  stream("paused", "LIVE", { set: { sync_enabled: 0, sync_error: "paused: YouTube said this video is not a live broadcast; automation for this row is switched off.", last_synced_at: now } });
  stream("later", "SCHEDULED", { scheduled_start_local: `${tomorrow} 18:00` });
  stream("soon", "SCHEDULED", { create: { starts_in_seconds: 600 } });
  stream("soonok", "SCHEDULED", { create: { starts_in_seconds: 600 }, set: { last_synced_at: now, sync_state: "upcoming" } });
  stream("offline", "OFFLINE", {});
  stream("error", "ERROR", {});
  stream("done", "COMPLETED", {});
  stream("vimeo", "LIVE", { set: { provider: "vimeo", provider_broadcast_id: "123456789" } });

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar(on);
  let r = await anon.json(`/api/admin/live-streams?include=health&q=${P}`);
  check(r.status === 401 && r.body?.code === "unauthenticated", "E2E-045 the health read needs a session", `${r.status}`);

  /* ── the verdicts, automation on ────────────────────────────────────── */
  const owner = jar(on);
  await owner.login(ADMIN.username, ADMIN.password);
  r = await owner.json(`/api/admin/live-streams?include=health&q=${P}&f=all`);
  check(r.status === 200 && Array.isArray(r.body?.streams) && r.body.health && !r.body.health.error, "include=health answers streams with verdicts and a summary", `${r.status} ${r.text.slice(0, 200)}`);
  const list = r.body.streams;
  const H = (key) => byId(list, key)?.health;
  check(list.length === Object.keys(ids).length, "every fixture row is listed", `${list.length}/${Object.keys(ids).length}`);

  let h = H("healthy");
  check(h?.level === "ok" && h.label === "Healthy" && h.tone === "success" && h.reason === "YouTube: live" && h.state === "live", "LIVE, checked just now, YouTube live → Healthy", JSON.stringify(h));
  const healthy = byId(list, "healthy");
  check(healthy.viewer_count === 1234 && healthy.viewers === 1234 && healthy.viewer_count_at && healthy.sync.enabled === true && healthy.sync.error === null, "the committee shape carries viewer_count with its time and the sync facts", JSON.stringify({ vc: healthy.viewer_count, v: healthy.viewers, sync: healthy.sync }));

  h = H("overdue");
  check(h?.level === "stale" && h.label === "Check overdue" && /Last checked 1 hour ago/.test(h.reason) && /live_cron/.test(h.reason) && h.checked_seconds_ago >= 3590, "LIVE, last checked an hour ago → Check overdue naming the cron job", JSON.stringify(h));
  check(byId(list, "overdue").viewer_count === 7 && byId(list, "overdue").viewers === null, "a stale viewer figure stays in the committee shape but leaves the public one", JSON.stringify(byId(list, "overdue").viewers));
  h = H("never");
  check(h?.level === "stale" && /Never checked while live/.test(h.reason) && h.checked_at === null, "LIVE and never checked → Check overdue", JSON.stringify(h));

  h = H("auth");
  check(h?.level === "failed" && h.label === "Failing" && h.tone === "danger" && /refused the API key/.test(h.reason) && !/^auth:/.test(h.reason), "auth error → Failing, the class token dropped from the sentence", JSON.stringify(h));
  h = H("request");
  check(h?.level === "failed" && /malformed/.test(h.reason), "request error → Failing", JSON.stringify(h));
  h = H("missing");
  check(h?.level === "attention" && h.label === "Needs attention" && h.tone === "warning" && /deleted, private/.test(h.reason) && h.state === "missing", "video not found (deleted) → Needs attention (brief §32)", JSON.stringify(h));
  h = H("private");
  check(h?.level === "attention" && /private or not embeddable/.test(h.reason) && h.state === "restricted", "private / embed-restricted video → Needs attention", JSON.stringify(h));
  h = H("quota");
  check(h?.level === "notice" && h.label === "Notice" && /quota is used up/.test(h.reason), "quota → Notice (clears itself)", JSON.stringify(h));
  h = H("transient");
  check(h?.level === "notice" && /check failed/.test(h.reason), "transient → Notice", JSON.stringify(h));
  h = H("notice");
  check(h?.level === "notice" && /different time/.test(h.reason), "a notice-class sentence → Notice", JSON.stringify(h));

  h = H("manual");
  check(h?.level === "manual" && h.label === "Manual" && /switched off for this broadcast/.test(h.reason), "sync_enabled = 0 → Manual, never stale", JSON.stringify(h));
  h = H("paused");
  check(h?.level === "paused" && h.label === "Automation paused" && h.tone === "danger" && /not a live broadcast/.test(h.reason), "machine-paused row → Automation paused", JSON.stringify(h));

  h = H("later");
  check(h?.level === "ok" && h.reason === "Waiting for the first check.", "SCHEDULED for tomorrow, unchecked → Healthy, waiting", JSON.stringify(h));
  h = H("soon");
  check(h?.level === "stale" && /Starts soon and has never been checked/.test(h.reason), "SCHEDULED inside the lead window, unchecked → Check overdue", JSON.stringify(h));
  h = H("soonok");
  check(h?.level === "ok" && h.reason === "YouTube: scheduled", "SCHEDULED inside the lead window, checked → Healthy", JSON.stringify(h));

  h = H("offline");
  check(h?.level === "attention" && /Marked offline by hand/.test(h.reason), "OFFLINE → Needs attention (devotees see the offline notice)", JSON.stringify(h));
  h = H("error");
  check(h?.level === "attention" && /Marked as an error by hand/.test(h.reason), "ERROR → Needs attention", JSON.stringify(h));
  h = H("done");
  check(h?.level === "idle" && h.label === "Not in rotation" && h.reason === "", "COMPLETED → Not in rotation", JSON.stringify(h));
  h = H("vimeo");
  check(h?.level === "manual" && /Not a YouTube broadcast/.test(h.reason), "a non-YouTube provider → Manual", JSON.stringify(h));

  /* ── the summary ────────────────────────────────────────────────────── */
  const S = r.body.health;
  check(S.automation.ready === true && S.automation.mode === "live" && S.automation.reason === "" && S.automation.tier >= 1, "automation on: ready, mode live", JSON.stringify(S.automation));
  const nowIds = S.now.map((s) => s.id);
  check(["healthy", "overdue", "auth", "request", "missing", "offline", "error"].every((k) => nowIds.includes(ids[k])) && !nowIds.includes(ids.later) && !nowIds.includes(ids.done), "`now` lists LIVE, STARTING, OFFLINE and ERROR rows, not SCHEDULED or COMPLETED", JSON.stringify(nowIds));
  check(S.now.findIndex((s) => s.id === ids.healthy) < S.now.findIndex((s) => s.id === ids.missing), "LIVE rows lead STARTING ones in `now`");
  check(S.issues.length === 5 && S.issues.every((s) => ["failed", "attention", "paused", "stale"].includes(s.health.level)), "issues are capped at five and carry only actionable levels", JSON.stringify(S.issues.map((s) => s.health.level)));
  check(S.issues[0].health.level === "failed" && S.issues.map((s) => s.health.level).join() === [...S.issues].sort((a, b) => ["failed", "attention", "paused", "stale"].indexOf(a.health.level) - ["failed", "attention", "paused", "stale"].indexOf(b.health.level)).map((s) => s.health.level).join(), "issues are ordered worst first", JSON.stringify(S.issues.map((s) => s.health.level)));
  check(S.counts.failed >= 2 && S.counts.attention >= 4 && S.counts.paused >= 1 && S.counts.stale >= 3 && S.counts.notice >= 3 && S.counts.ok >= 3 && S.counts.idle === 0, "counts cover every fixture level (COMPLETED rows are not counted)", JSON.stringify(S.counts));
  check(typeof S.last_check_at === "string" && Date.parse(S.last_check_at) >= Date.parse(`${now.replace(" ", "T")}Z`) - 1000, "last_check_at is the newest check", S.last_check_at);
  check(Number.isInteger(S.errors_24h) && S.errors_24h >= 0, "errors_24h is a count", String(S.errors_24h));
  check(!r.text.includes(FAKE_KEY) && !r.text.includes(SETTINGS_KEY), "no credential in the health answer");

  /* ── the dashboard card, owner ──────────────────────────────────────── */
  r = await owner.get("/admin/");
  check(r.status === 200 && !FATAL.test(r.text), "dashboard renders", `${r.status}`);
  const card = /<section class="card card--static" id="live-health">[\s\S]*?<\/section>/.exec(r.text)?.[0] ?? "";
  check(card !== "" && /Live Darshan/.test(card), "the Live Darshan card is on the dashboard");
  check(/Automation on/.test(card) && /needs? attention/.test(card) && /Last YouTube check:/.test(card) && /sync errors? in 24 h/.test(card), "card summary: automation, issue count, last check, errors in 24 h");
  check(/<th>Broadcast<\/th><th>Status<\/th><th>Provider<\/th><th>Started<\/th><th>Viewers<\/th><th>Last check<\/th><th>Health<\/th>/.test(card), "card columns: broadcast, status, provider, started, viewers, last check, health");
  check(card.includes(`${P} healthy`) && /Youtube/.test(card) && /1,234/.test(card) && /15 min ago/.test(card) && /Healthy/.test(card), "the healthy row shows its provider, started time, viewers and Healthy badge", card.slice(0, 300));
  check(card.includes(`${P} auth`) && /Failing/.test(card) && /Needs attention/.test(card) && /Check overdue/.test(card) && /Needs a person/.test(card), "issues list names the failing and overdue rows");
  check(card.includes(`/admin/live_streams.php?edit=${ids.auth}`) && card.includes('href="/admin/live_settings.php"'), "rows link to the stream editor; the owner sees the YouTube automation link");
  check(!r.text.includes(FAKE_KEY) && !r.text.includes(SETTINGS_KEY) && !/sbx1:/.test(r.text), "no credential in the dashboard HTML");

  /* ── the dashboard card, viewer (live.view, not live.provider) ───────── */
  let csrf = csrfOf((await owner.get("/admin/users.php")).text);
  r = await owner.post("/admin/users.php", { _csrf: csrf, action: "save", id: "0", username: VIEWER.user, display_name: `${P} viewer`, email: "", phone: "", role: "viewer", password: VIEWER.issued, is_active: "1" });
  check(redirected(r), "viewer account created", `${r.status} ${r.text.slice(0, 200)}`);
  const viewer = jar(on);
  await viewer.login(VIEWER.user, VIEWER.issued);
  const prof = (await viewer.get("/admin/profile.php")).text;
  await viewer.post("/admin/profile.php", { _csrf: csrfOf(prof), action: "password", current_password: VIEWER.issued, new_password: VIEWER.pw, confirm_password: VIEWER.pw });
  r = await viewer.get("/admin/");
  const vcard = /<section class="card card--static" id="live-health">[\s\S]*?<\/section>/.exec(r.text)?.[0] ?? "";
  check(r.status === 200 && vcard !== "" && vcard.includes(`${P} healthy`), "a viewer (live.view) sees the monitoring card", `${r.status}`);
  check(!vcard.includes('href="/admin/live_settings.php"'), "but not the YouTube automation link (live.provider is owner-only)");
  r = await viewer.json(`/api/admin/live-streams?include=health&q=${P}`);
  check(r.status === 200 && r.body?.health?.automation?.ready === true, "a viewer may read the health summary", `${r.status}`);

  /* ── automation off ─────────────────────────────────────────────────── */
  const ownerOff = jar(off);
  await ownerOff.login(ADMIN.username, ADMIN.password);
  r = await ownerOff.json(`/api/admin/live-streams?include=health&q=${P}&f=all`);
  const SO = r.body?.health;
  check(SO && SO.automation.ready === false && /switched off/.test(SO.automation.reason) && SO.automation.mode === "off", "automation off: not ready, with the committee's reason", JSON.stringify(SO?.automation));
  const offList = r.body.streams;
  check(byId(offList, "healthy").health.level === "manual" && byId(offList, "never").health.level === "manual" && /switched off/.test(byId(offList, "never").health.reason), "with automation off a LIVE row is Manual with the reason, never Check overdue", JSON.stringify([byId(offList, "healthy").health, byId(offList, "never").health]));
  check(byId(offList, "auth").health.level === "failed" && byId(offList, "offline").health.level === "attention", "recorded failures and hand-set OFFLINE still surface with automation off");
  r = await ownerOff.get("/admin/");
  const ocard = /<section class="card card--static" id="live-health">[\s\S]*?<\/section>/.exec(r.text)?.[0] ?? "";
  check(ocard !== "" && /Automation off/.test(ocard) && /switched off/.test(ocard), "dashboard card says Automation off and why");

  /* ── server logs ────────────────────────────────────────────────────── */
  const noise = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(`${logs.on}\n${logs.off}`);
  check(!noise, "no PHP warnings, notices or fatals in either server log", noise?.[0]);

  console.log(`\nlive-health: ${checks} passed, 0 failed`);
} finally {
  for (const s of servers) s.kill();
  try {
    fixture("cleanup", { title_prefix: P, admin_prefix: `e2ehlth_${RUN}_`, actors: [ACTOR] });
  } catch (e) {
    console.error(`cleanup: ${e.message}`);
  }
}
