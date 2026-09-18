import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = `E2E-LARCH-${Date.now()}`;
const port = Number(process.env.LIVE_ARCHIVE_PORT || 8089);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LIVE_|YOUTUBE_|GOOGLE_)/i.test(key))),
  LIVE_TEMPLE_TZ: "Asia/Kolkata", SITE_URL: base,
};
const video = "abcdefghijk";
const recording = "ZYXWVUTSRQP";
const url = `https://www.youtube.com/watch?v=${recording}`;
let checks = 0, log = "", server;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
function php(code, args = {}) {
  const r = spawnSync("php", ["-r", `require 'backend/includes/live.php'; $a=json_decode($argv[1],true); ${code}`, JSON.stringify(args)], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stderr, /Warning|Notice|Fatal|SQLSTATE/);
  return JSON.parse(r.stdout);
}
function fixture(command, args) {
  const r = spawnSync("php", ["tests/support/live_fixtures.php", command, JSON.stringify(args)], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim());
}
function sql(query, params = []) {
  return php('$s=getDB()->prepare($a["query"]); $s->execute($a["params"]); echo json_encode($s->columnCount() ? $s->fetchAll() : []);', { query, params });
}
function stream(opts = {}) {
  return fixture("create-stream", { title_prefix: prefix, label: String(Math.random()).slice(2), status: "COMPLETED", provider_reference: video, ...opts });
}
function save(id, input) {
  return php('$db=getDB(); $v=liveValidate($a["input"],liveLoad($db,$a["id"]),$db); if (!$v["errors"]) liveUpdate($db,$a["id"],$v["values"],$a["actor"]); echo json_encode($v["errors"]);', { id, input, actor: prefix });
}
function archived(opts = {}, at = "1981-03-15 10:00:00") {
  const s = stream(opts);
  assert.deepEqual(save(s.id, { recording_url: `https://youtu.be/${recording}?feature=shared` }), []);
  sql("UPDATE live_streams SET actual_end_at=? WHERE id=?", [at, s.id]);
  return s;
}
async function get(path = "/api/live-streams/archive", options = {}) {
  const r = await fetch(`${base}${path}`, options);
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null };
}
const archive = (query = "") => get(`/api/live-streams/archive?${query}`);
const march = () => archive("month=1981-03");
const ids = (r) => r.body.streams.map((s) => s.id);
const detail = (s) => get(`/api/live-streams/${s.slug}`);
try {
  check(php('echo json_encode(liveTablesExist() && liveAutomationInstalled());'), "live migrations installed on MySQL");
  server = spawn("php", ["-S", `127.0.0.1:${port}`, "router.php"], { cwd: resolve(root, "backend"), env });
  server.stdout.on("data", (s) => { log += s; });
  server.stderr.on("data", (s) => { log += s; });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await archive()).status === 200; } catch {}
    if (ready) break;
    await delay(100);
  }
  check(ready, "archive server ready");
  const main = archived({ event_type: "festival" });
  const second = archived({ event_type: "daily_pooja" });
  const first = await march();
  check(first.status === 200 && ids(first).includes(main.id), "saved completed recording appears automatically");
  check(!first.headers.has("set-cookie") && first.headers.get("cache-control").includes("max-age=60"), "public read has bounded caching and no session");
  check(first.body.timezone === "Asia/Kolkata" && first.body.event_types.festival.length === 2, "temple timezone and bilingual event vocabulary supplied");
  check(sql("SELECT recording_url FROM live_streams WHERE id=?", [main.id])[0].recording_url === url, "recording links are normalized at save");
  let d = (await detail(main)).body.stream;
  check(d.playback.embedUrl.includes(recording) && d.playback.watchUrl === url, "completed player uses recording rather than live video ID");
  check(!["recording_url", "provider_stream_id", "created_by", "updated_by", "sync_error"].some((k) => k in d), "private columns are not added to public shape");
  check(ids(await archive("month=1981-03&event_type=festival")).includes(main.id)
    && !ids(await archive("month=1981-03&event_type=festival")).includes(second.id), "event filter combines with month");

  for (const opts of [{ status: "DRAFT" }, { status: "SCHEDULED" }, { status: "LIVE" }, { status: "CANCELLED" }, { flags: { archive: false } }]) {
    const hidden = archived(opts);
    check(!ids(await march()).includes(hidden.id), `${JSON.stringify(opts)} excluded`);
  }
  const removed = archived();
  sql("UPDATE live_streams SET deleted_at=UTC_TIMESTAMP() WHERE id=?", [removed.id]);
  check(!ids(await march()).includes(removed.id) && (await detail(removed)).status === 404, "deleted recordings are hidden");
  const missing = stream();
  check((await detail(missing)).body.stream.playback.kind === "none", "completion without a recording offers no player");
  check(!ids(await march()).includes(missing.id), "missing recordings are absent");
  for (const invalid of ["javascript:alert(1)", "https://evil.example/watch?v=abcdefghijk", "live_stream", "https://www.youtube.com/watch?v=too_short", [], {}]) {
    check(Boolean(save(main.id, { recording_url: invalid }).recording_url), "unsafe or malformed recording input rejected");
  }
  check(sql("SELECT recording_url FROM live_streams WHERE id=?", [main.id])[0].recording_url === url, "failed validation preserves saved recording");
  assert.deepEqual(save(main.id, { archive_enabled: false }), []);
  check(!ids(await march()).includes(main.id) && (await detail(main)).body.stream.playback.kind === "none", "archive switch hides both card and playback");
  assert.deepEqual(save(main.id, { archive_enabled: true }), []);
  check(ids(await march()).includes(main.id), "re-enabling archive restores the recording");
  assert.deepEqual(save(main.id, { recording_url: "" }), []);
  check(!ids(await march()).includes(main.id), "clearing recording removes the card");
  assert.deepEqual(save(main.id, { recording_url: recording }), []);
  assert.deepEqual(save(main.id, { provider_reference: "12345678901" }), []);
  check(sql("SELECT recording_url FROM live_streams WHERE id=?", [main.id])[0].recording_url === null, "replacing the live video clears its old recording");
  assert.deepEqual(save(main.id, { recording_url: recording }), []);
  check((await detail(main)).body.stream.playback.watchUrl === url, "replacement recording can be saved independently");
  const bad = archived();
  sql("UPDATE live_streams SET recording_url='https://evil.example/recording' WHERE id=?", [bad.id]);
  check(!ids(await march()).includes(bad.id) && (await detail(bad)).body.stream.playback.kind === "none", "invalid legacy recording produces neither card nor player");
  const before = archived({}, "1981-02-28 18:29:59");
  const edge = archived({}, "1981-02-28 18:30:00");
  const last = archived({}, "1981-03-31 18:29:59");
  const after = archived({}, "1981-03-31 18:30:00");
  const boundaries = ids(await march());
  check(!boundaries.includes(before.id) && boundaries.includes(edge.id) && boundaries.includes(last.id) && !boundaries.includes(after.id), "month uses inclusive/exclusive temple-local boundaries without MySQL timezone tables");
  const pages = Array.from({ length: 14 }, () => archived({ event_type: "bhajan" }, "1981-04-10 10:00:00"));
  const p1 = await archive("month=1981-04&event_type=bhajan");
  const p2 = await archive("month=1981-04&event_type=bhajan&page=2");
  check(p1.body.streams.length === 12 && p1.body.has_more && p2.body.streams.length === 2 && !p2.body.has_more, "bounded pagination returns all 14 rows");
  assert.deepEqual([...ids(p1), ...ids(p2)], pages.map((s) => s.id).reverse());
  check(true, "ID ties yield stable descending pages without duplicates");
  check((await archive("month=1981-04&page=10000")).body.streams.length === 0, "out-of-range page returns an empty list");
  for (const query of ["page=0", "page=-1", "page=10001", "page[]=1", "month[]=1981-03", "month=1981-13", "month=0000-01", "month=9999-12", "event_type[]=festival", "event_type=unknown", "page=1%20OR%201=1"]) {
    const r = await archive(query);
    check(r.status === 422 && r.headers.get("cache-control") === "no-store", `invalid query rejected: ${query}`);
  }
  check((await get("/api/live-streams/archive", { method: "HEAD" })).body === null, "HEAD has no body");
  check((await get("/api/live-streams/archive", { method: "POST" })).status === 405, "archive refuses writes");
  const manual = stream({ status: "LIVE" });
  assert.deepEqual(save(manual.id, { recording_url: recording }), []);
  check((await detail(manual)).body.stream.playback.embedUrl.includes(video), "a live stream keeps its live video until completion");
  fixture("set-status", { id: manual.id, status: "COMPLETED", actor: prefix });
  check((await detail(manual)).body.stream.playback.embedUrl.includes(recording), "manual completion switches to saved recording");
  for (const recordingStatus of ["recorded", "notRecording"]) {
    const auto = stream({ status: "LIVE", starts_in_seconds: -3600, ends_in_seconds: -1800 });
    const result = php('$db=getDB(); $r=liveLoad($db,$a["id"]); $f=["ok"=>true,"state"=>"ended","actual_start"=>$r["scheduled_start_at"],"actual_end"=>gmdate("Y-m-d H:i:s",time()-180),"recording_status"=>$a["recording_status"]]; $out=livePollStream($db,$r,$f,["auto_end"=>true,"complete_grace_seconds"=>30],$a["actor"]); echo json_encode(["result"=>$out,"row"=>liveLoad($db,$a["id"])]);',
      { id: auto.id, recording_status: recordingStatus, actor: prefix });
    check(result.row.status === "COMPLETED", "poller applies completion atomically");
    const listed = ids(await archive()).includes(auto.id);
    check(recordingStatus === "recorded"
      ? result.row.recording_url?.includes(video) && listed
      : result.row.recording_url === null && !listed, `${recordingStatus}: archive reflects provider recording evidence`);
  }
  const seo = await fetch(`${base}/live-darshan/archive?lang=en`, { headers: { "User-Agent": "facebookexternalhit/1.1" } });
  check(seo.status === 200 && (await seo.text()).includes("Darshan recordings"), "archive crawler metadata is a public page");
  check(!/PHP (Warning|Notice|Fatal)|SQLSTATE/.test(log), "no PHP runtime or SQL errors");
  console.log(`${checks} archive checks passed`);
} finally {
  if (server) server.kill();
  fixture("cleanup", { title_prefix: prefix });
}
