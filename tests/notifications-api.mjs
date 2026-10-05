#!/usr/bin/env node
/**
 * tests/notifications-api.mjs — the devotee notification API, tracking links,
 * unsubscribe, and the webhook and cron routes, end to end against the real
 * PHP + MySQL stack (docs/notifications/SPEC.md §6.1, §6.2, §6.6).
 *
 *   PHP_BIN=/path/to/php.sh node tests/notifications-api.mjs [http://127.0.0.1:8001]
 *
 * What it proves:
 *   • the API refuses a guest (401), a missing CSRF token (419) and an unknown
 *     action (404, before any auth check), and rate-limits changes per devotee;
 *   • a devotee only ever sees and changes their own notifications — never
 *     another devotee's, a guest's, one hidden from the app, one deleted, or one
 *     still held until its deliver_after;
 *   • list filters (status, category, search, date range in the devotee's own
 *     time zone) and cursor pages that walk every row exactly once;
 *   • read, unread, read-all, archive, unarchive, delete and click, with the
 *     unread count after each and the in-app delivery kept in step;
 *   • preferences round-trip, and security categories cannot be muted;
 *   • push devices register idempotently and are removed only by their owner;
 *   • tracked clicks redirect and count once, the open pixel is a real GIF,
 *     unsubscribe GET changes nothing and POST (and RFC 8058 one-click) does;
 *   • /api/notify-webhook/<driver> and /api/notify-cron reach their endpoints
 *     through api/index.php.
 *
 * Devotees are created with tests/support/notify_fixtures.php (sign-up is rate
 * limited per connection) and sign in through /api/auth/login. Every request
 * sends its own X-Forwarded-For in 10.31.x.x. A second PHP server on port 8030
 * runs with the test driver and a cron key; it is stopped at the end.
 *
 * Data: devotees e2e-napi-<run>-*@example.test, dedupe keys e2e:napi:<run>:*.
 * Both are removed at the start (a crashed earlier run) and at the end.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8001").replace(/\/$/, "");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const EXTRA_PORT = 8030;
const EXTRA = `http://127.0.0.1:${EXTRA_PORT}`;
const RUN = Date.now().toString(36);
const EMAIL_PREFIX = "e2e-napi-";
const DEDUPE = `e2e:napi:${RUN}`;
const CRON_KEY = `napi-cron-key-${randomBytes(12).toString("hex")}`;
const PASSWORD = "Kolam99Deep";

const IP = { a: "10.31.1.1", b: "10.31.2.2", guest: "10.31.3.3", track: "10.31.4.4", hook: "10.31.5.5", rate: "10.31.9.9", a8030: "10.31.6.6" };

let passed = 0;
const failures = [];
function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const section = (title) => console.log(`\n── ${title}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── PHP ───────────────────────────────────────────────────────────────── */

/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const viaBash = PHP_BIN.endsWith(".sh");

function php(args, env = {}) {
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}
function phpJson(args, env) {
  const r = php(args, env);
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`php ${args.slice(0, 2).join(" ")} printed no JSON (exit ${r.status}): ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
  }
}
const fixtures = (cmd, obj = {}, env) => phpJson(["tests/support/notify_fixtures.php", cmd, arg(obj)], env);
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}
const one = (query, params) => sql(query, params)[0] ?? null;

function createDevotee(tag, extra = {}) {
  const r = fixtures("create-devotee", { email: `${EMAIL_PREFIX}${RUN}-${tag}@example.test`, password: PASSWORD, name: `E2E-NAPI ${tag}`, ...extra });
  if (!r.id) throw new Error(`could not create devotee ${tag}: ${JSON.stringify(r)}`);
  return { id: r.id, email: r.email };
}

/** notify() through the fixtures CLI; returns the notification id. */
function seed(key, n, env) {
  const r = fixtures("notify", { channels: ["inapp"], category: "general", priority: "normal", ...n, dedupe_key: `${DEDUPE}:${key}` }, env);
  if (!r.result || (!r.result.id && !r.result.deduped)) throw new Error(`seed ${key} failed: ${JSON.stringify(r)}`);
  return r.result;
}

/** Signed link tokens, made by the service itself so the test never re-implements the signature. */
function tokens(pairs) {
  const code =
    'require "backend/includes/notify.php"; $out = []; foreach (json_decode($argv[1], true) as $k => [$kind, $id]) { $out[$k] = notifyToken($kind, (int) $id); } echo json_encode($out);';
  const r = php(["-r", code, JSON.stringify(pairs)]);
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    throw new Error(`token generation failed: ${r.stdout} ${r.stderr}`);
  }
}

/* ── A browser-ish client: one cookie jar, one CSRF token, one address ─── */
class Client {
  constructor(label, ip, base = BASE) {
    this.label = label;
    this.ip = ip;
    this.base = base;
    this.cookies = new Map();
    this.csrf = "";
  }

  #store(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async req(method, path, body, { headers: extra = {}, raw } = {}) {
    const headers = { Accept: "application/json", "X-Forwarded-For": this.ip, ...extra };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let payload;
    if (raw !== undefined) {
      payload = raw;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (method === "POST" && this.csrf && !("X-CSRF-Token" in headers)) headers["X-CSRF-Token"] = this.csrf;
    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload, redirect: "manual" });
    this.#store(res);
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* callers assert on json when they expect it */
    }
    if (json?.csrf) this.csrf = json.csrf;
    return { status: res.status, json, text, buf, headers: res.headers };
  }

  get = (p, opts) => this.req("GET", p, undefined, opts);
  post = (p, b = {}, opts) => this.req("POST", p, b, opts);

  async signIn(email) {
    await this.get("/api/auth/me");
    const r = await this.post("/api/auth/login", { email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`${this.label} could not sign in: ${r.status} ${r.text.slice(0, 200)}`);
    return r;
  }
}

const N = "/api/notifications";
const listIds = (r) => (r.json?.items ?? []).map((i) => i.id);

/* ── Extra server (test driver, cron key) ──────────────────────────────── */

let extraServer = null;
function killPort(port) {
  if (process.platform !== "win32") return;
  spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
    { stdio: "ignore" },
  );
}
async function startExtraServer() {
  killPort(EXTRA_PORT); // a server left by a crashed earlier run of this suite
  const args = ["-S", `127.0.0.1:${EXTRA_PORT}`, "router.php"];
  extraServer = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: resolve(ROOT, "backend"),
    env: {
      ...process.env,
      TRUSTED_PROXIES: "127.0.0.1,::1",
      SITE_URL: process.env.SITE_URL || "http://localhost:5173",
      NOTIFY_ALLOW_TEST_DRIVER: "1",
      NOTIFY_SMS_DRIVER: "test",
      // A real driver with none of its credentials: "not configured".
      NOTIFY_WHATSAPP_DRIVER: "meta",
      WHATSAPP_META_TOKEN: "",
      NOTIFY_CRON_KEY: CRON_KEY,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${EXTRA}/api/sevas`, { headers: { "X-Forwarded-For": IP.hook } });
      if (res.status === 200) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  return false;
}
function stopExtraServer() {
  if (extraServer && extraServer.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(extraServer.pid), "/T", "/F"], { stdio: "ignore" });
    else extraServer.kill("SIGTERM");
  }
  killPort(EXTRA_PORT);
}

/**
 * Hold the worker's MySQL lock from a separate PHP process, so the cron
 * endpoint answers 200 with locked:true — proving the key was accepted and the
 * worker called — without draining a queue other suites share.
 */
async function holdWorkerLock(fn) {
  const flag = resolve(tmpdir(), `napi-lock-${RUN}-${process.pid}.flag`);
  if (existsSync(flag)) unlinkSync(flag);
  const code = [
    'require "backend/includes/db.php";',
    '$db = getDB();',
    'if ((int) $db->query("SELECT GET_LOCK(\'temple_notify_worker\', 10)")->fetchColumn() !== 1) { echo "busy\\n"; exit(1); }',
    'echo "locked\\n";',
    '$flag = getenv("NAPI_LOCK_FLAG"); $until = time() + 30;',
    "while (time() < $until && !is_file($flag)) usleep(100000);",
    '$db->query("SELECT RELEASE_LOCK(\'temple_notify_worker\')");',
  ].join(" ");
  const child = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, "-r", code] : ["-r", code], {
    cwd: ROOT,
    env: { ...process.env, NAPI_LOCK_FLAG: flag },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise((r) => child.on("exit", r));
  for (let i = 0; i < 120 && !out.includes("locked") && !out.includes("busy") && child.exitCode === null; i++) await sleep(100);
  const held = out.includes("locked");
  try {
    return await fn(held);
  } finally {
    writeFileSync(flag, "done");
    await Promise.race([exited, sleep(5000)]);
    if (child.exitCode === null) child.kill();
    try {
      unlinkSync(flag);
    } catch {
      /* already gone */
    }
  }
}

/* ── Cleanup ───────────────────────────────────────────────────────────── */

function cleanup(devoteeIds = []) {
  // Guest notifications have no devotee to cascade from.
  sql("DELETE FROM notifications WHERE dedupe_key LIKE 'e2e:napi:%'");
  fixtures("cleanup", { email_prefix: EMAIL_PREFIX });
  sql("DELETE FROM rate_limits WHERE bucket LIKE '%10.31.%'");
  for (const id of devoteeIds) sql("DELETE FROM rate_limits WHERE bucket = ?", [`notif-post:d${id}`]);
}

/* ── The suite ─────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Notification API — ${BASE} (extra server ${EXTRA})`);
  console.log(`run id ${RUN}\n`);
  cleanup();

  const A = createDevotee("a", { phone: "919876500011", verified: true, country: "IN" });
  const B = createDevotee("b", { country: "IN" });
  const R = createDevotee("rate", {});
  const H = createDevotee("hook", { phone: "919876500020", verified: true });
  const ids = [A.id, B.id, R.id, H.id];

  try {
    await suite(A, B, R, H);
  } finally {
    stopExtraServer();
    cleanup(ids);
    const left = one(
      "SELECT (SELECT COUNT(*) FROM devotees WHERE email LIKE 'e2e-napi-%') AS devotees, (SELECT COUNT(*) FROM notifications WHERE dedupe_key LIKE 'e2e:napi:%') AS notifications, (SELECT COUNT(*) FROM rate_limits WHERE bucket LIKE '%10.31.%') AS limits",
    );
    console.log(`\nCleanup left: ${JSON.stringify(left)}`);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

async function suite(A, B, R, H) {
  /* ── Seed ─────────────────────────────────────────────────────────── */
  section("Seeding");
  const s = {};
  s.g1 = seed("g1", { devotee_id: A.id, title: "E2E-NAPI Kolam workshop", body: "Bring rice flour and a steady hand." }).id;
  s.b1 = seed("b1", {
    devotee_id: A.id, category: "booking", priority: "important", title: "E2E-NAPI Booking confirmed",
    body: "Your abhishekam is confirmed.", cta_url: "/account?tab=bookings", cta_label: "View booking", entity_type: "seva_booking", entity_id: 91,
  }).id;
  s.f1 = seed("f1", { devotee_id: A.id, category: "festival", title: "E2E-NAPI Festival night", body: "Lamps at 100% brightness_now." }).id;
  s.f2 = seed("f2", { devotee_id: A.id, category: "festival", title: "E2E-NAPI Therottam", body: "The chariot leaves at dawn." }).id;
  s.p1 = seed("p1", { devotee_id: A.id, category: "pooja", title: "E2E-NAPI Pournami pooja", body: "Evening pooja on the full moon." }).id;
  s.a1 = seed("a1", { devotee_id: A.id, category: "announcement", title: "E2E-NAPI Temple notice", body: "The office opens late tomorrow." }).id;
  s.d1 = seed("d1", { devotee_id: A.id, category: "donation", title: "E2E-NAPI Receipt ready", body: "Thank you for your offering." }).id;
  s.e1 = seed("e1", { devotee_id: A.id, category: "event", title: "E2E-NAPI Annadhanam", body: "Lunch is served after the pooja." }).id;
  s.archived = seed("archived", { devotee_id: A.id, title: "E2E-NAPI Archived one", body: "Put away." }).id;
  s.deleted = seed("deleted", { devotee_id: A.id, title: "E2E-NAPI Deleted one", body: "Removed." }).id;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace("T", " ");
  s.future = seed("future", { devotee_id: A.id, title: "E2E-NAPI Held until tomorrow", body: "Not yet.", deliver_after: tomorrow }).id;
  // Push only, and A has no device: the in-app copy is never shown.
  const hidden = seed("hidden", { devotee_id: A.id, channels: ["push"], title: "E2E-NAPI Push only", body: "Not in the bell." });
  s.hidden = hidden.id;
  const guest = seed("guest", { to_email: `${EMAIL_PREFIX}${RUN}-guest@example.test`, title: "E2E-NAPI Guest message", body: "For a guest." });
  s.guest = guest.id;
  s.bOwn = seed("b-own", { devotee_id: B.id, title: "E2E-NAPI B private", body: "Only for B." }).id;

  sql("UPDATE notifications SET archived_at = UTC_TIMESTAMP() WHERE id = ?", [s.archived]);
  sql("UPDATE notifications SET deleted_at = UTC_TIMESTAMP() WHERE id = ?", [s.deleted]);
  // Fixed times for the date-range checks. 18:00 UTC is 23:30 on 10 January in
  // India; 20:00 UTC is already 01:30 on the 11th. f1 and f2 share a second, so
  // the page order has to fall back to the id.
  sql("UPDATE notifications SET created_at = '2026-01-10 18:00:00' WHERE id = ?", [s.g1]);
  sql("UPDATE notifications SET created_at = '2026-01-10 20:00:00' WHERE id = ?", [s.b1]);
  sql("UPDATE notifications SET created_at = '2026-02-01 06:00:00' WHERE id IN (?, ?)", [s.f1, s.f2]);
  // The rest share one moment ten minutes ago (order then falls to the id), so
  // a held notification released "a minute ago" is unambiguously the newest.
  sql("UPDATE notifications SET created_at = UTC_TIMESTAMP() - INTERVAL 10 MINUTE WHERE id IN (?, ?, ?, ?)", [s.p1, s.a1, s.d1, s.e1]);

  check(Object.values(s).every((v) => Number.isInteger(v) && v > 0), "every seed notification was created", JSON.stringify(s));
  check(hidden.deliveries?.inapp === undefined && one("SELECT show_in_app FROM notifications WHERE id = ?", [s.hidden])?.show_in_app === 0, "the push-only notification has show_in_app 0");
  check(one("SELECT devotee_id FROM notifications WHERE id = ?", [s.guest])?.devotee_id === null, "the guest notification has no devotee");

  // Newest first: the four created now (id descending), f2/f1 tie, then b1, g1.
  const expectedAll = [s.e1, s.d1, s.a1, s.p1, s.f2, s.f1, s.b1, s.g1];

  /* ── Access ───────────────────────────────────────────────────────── */
  section("Access control");
  const guestClient = new Client("guest", IP.guest);
  await guestClient.get("/api/auth/me");
  let r = await guestClient.get(`${N}/list`);
  check(r.status === 401 && r.json?.code === "unauthenticated", "a guest is refused the list (401)", `status ${r.status}`);
  r = await guestClient.get(`${N}/unread`);
  check(r.status === 401, "and the unread count", `status ${r.status}`);
  r = await guestClient.post(`${N}/read-all`, {});
  check(r.status === 401, "and every change", `status ${r.status}`);
  r = await guestClient.get(`${N}/nosuchaction`);
  check(r.status === 404, "an unknown action is a 404 before the auth check", `status ${r.status}`);
  r = await guestClient.post(`${N}/nosuchaction`, {});
  check(r.status === 404, "whatever the method", `status ${r.status}`);
  r = await guestClient.get(`${N}/read/extra`);
  check(r.status === 404, "a multi-segment path is refused", `status ${r.status}`);
  r = await guestClient.get(`${N}`);
  check(r.status === 404, "the bare prefix is not a route", `status ${r.status}`);

  const a = new Client("A", IP.a);
  await a.signIn(A.email);
  const b = new Client("B", IP.b);
  await b.signIn(B.email);

  r = await a.get(`${N}/read`);
  check(r.status === 405, "GET on a POST-only action is 405", `status ${r.status}`);
  r = await a.post(`${N}/list`, {});
  check(r.status === 405, "POST on a GET-only action is 405", `status ${r.status}`);

  const csrf = a.csrf;
  const postActions = ["prefs", "read", "unread", "read-all", "archive", "unarchive", "delete", "click", "devices", "devices-remove"];
  let all419 = true;
  for (const action of postActions) {
    const rr = await a.post(`${N}/${action}`, { ids: [s.g1], id: s.g1 }, { headers: { "X-CSRF-Token": "" } });
    if (rr.status !== 419 || rr.json?.code !== "csrf") {
      all419 = false;
      console.log(`       ${action}: ${rr.status}`);
    }
  }
  a.csrf = csrf;
  check(all419, `every POST action without the CSRF token is refused (419) — ${postActions.length} actions`);
  r = await a.post(`${N}/read`, { ids: [s.g1] }, { headers: { "X-CSRF-Token": "f".repeat(64) } });
  check(r.status === 419, "a forged CSRF token is refused too", `status ${r.status}`);
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.g1])?.read_at === null, "and nothing was marked read by the refused requests");

  /* ── Listing ──────────────────────────────────────────────────────── */
  section("The list");
  r = await a.get(`${N}/list`);
  check(r.status === 200, "the list loads", `status ${r.status} ${r.text.slice(0, 200)}`);
  check(same(listIds(r), expectedAll), "it holds exactly A's visible notifications, newest first (ties by id)", `${listIds(r)} vs ${expectedAll}`);
  check(r.json?.unread === 8, "unread counts the eight (not the archived one)", `unread ${r.json?.unread}`);
  check(r.json?.nextCursor === null, "one page needs no cursor");
  const b1Item = r.json?.items?.find((i) => i.id === s.b1);
  check(
    b1Item &&
      b1Item.title === "E2E-NAPI Booking confirmed" &&
      b1Item.category === "booking" &&
      b1Item.categoryLabel?.en === "Booking" &&
      typeof b1Item.categoryLabel?.ta === "string" &&
      b1Item.icon === "calendar-check" &&
      b1Item.priority === "important" &&
      b1Item.ctaUrl === "/account?tab=bookings" &&
      b1Item.ctaLabel === "View booking" &&
      b1Item.imageUrl === null &&
      b1Item.createdAt === "2026-01-10T20:00:00Z" &&
      b1Item.readAt === null &&
      b1Item.archivedAt === null &&
      b1Item.isRead === false &&
      b1Item.isArchived === false &&
      same(b1Item.entity, { type: "seva_booking", id: 91 }),
    "an item has the SPEC shape",
    JSON.stringify(b1Item),
  );
  check(r.json?.items?.find((i) => i.id === s.g1)?.entity === null, "an item about nothing has entity null");
  check(r.headers.get("cache-control")?.includes("no-store"), "private responses are not cached");

  const seenByA = new Set(listIds(r));
  for (const [label, id] of [["another devotee's", s.bOwn], ["the guest", s.guest], ["the push-only", s.hidden], ["the deleted", s.deleted], ["the held", s.future]]) {
    check(!seenByA.has(id), `${label} notification is not in A's list`);
  }
  r = await a.get(`${N}/list?status=archived`);
  check(same(listIds(r), [s.archived]), "status=archived shows only the archived one", `${listIds(r)}`);
  r = await a.get(`${N}/list?status=unread`);
  check(same(listIds(r), expectedAll), "status=unread shows the eight", `${listIds(r)}`);
  r = await a.get(`${N}/list?status=read`);
  check(same(listIds(r), []), "status=read shows none yet");
  r = await b.get(`${N}/list`);
  check(same(listIds(r), [s.bOwn]) && r.json?.unread === 1, "B sees only B's own notification", `${listIds(r)}`);

  r = await a.get(`${N}/unread`);
  check(r.status === 200 && r.json?.unread === 8 && r.json?.latestId === s.e1 && /Z$/.test(r.json?.latestAt ?? ""), "unread gives the count and the newest id", r.text);
  check(r.headers.get("cache-control")?.includes("no-store"), "unread is Cache-Control: no-store");

  section("Filters");
  r = await a.get(`${N}/list?category=festival`);
  check(same(listIds(r), [s.f2, s.f1]), "one category", `${listIds(r)}`);
  r = await a.get(`${N}/list?category=festival,pooja`);
  check(same(listIds(r), [s.p1, s.f2, s.f1]), "several categories", `${listIds(r)}`);
  r = await a.get(`${N}/list?category=festival&status=archived`);
  check(same(listIds(r), []), "category and status combine");
  r = await a.get(`${N}/list?q=kolam`);
  check(same(listIds(r), [s.g1]), "q searches titles, case-insensitively", `${listIds(r)}`);
  r = await a.get(`${N}/list?q=${encodeURIComponent("chariot")}`);
  check(same(listIds(r), [s.f2]), "q searches bodies", `${listIds(r)}`);
  r = await a.get(`${N}/list?q=${encodeURIComponent("100%")}`);
  check(same(listIds(r), [s.f1]), "a % in q is a literal percent sign", `${listIds(r)}`);
  r = await a.get(`${N}/list?q=${encodeURIComponent("_")}`);
  check(same(listIds(r), [s.f1]), "an _ in q is a literal underscore, not a wildcard", `${listIds(r)}`);
  r = await a.get(`${N}/list?q=${encodeURIComponent("E2E-NAPI")}`);
  check(same(listIds(r), expectedAll), "q never reaches another devotee's rows", `${listIds(r)}`);
  r = await a.get(`${N}/list?q=${encodeURIComponent("' OR 1=1 --")}`);
  check(r.status === 200 && same(listIds(r), []), "an injection attempt is only a search term");
  r = await a.get(`${N}/list?q=festival&category=festival`);
  check(same(listIds(r), [s.f1]), "q and category combine", `${listIds(r)}`);

  // A's country is IN, so days are Asia/Kolkata days.
  r = await a.get(`${N}/list?from=2026-01-11&to=2026-01-11`);
  check(same(listIds(r), [s.b1]), "from/to are the devotee's own days (20:00 UTC is 11 January in India)", `${listIds(r)}`);
  r = await a.get(`${N}/list?from=2026-01-10&to=2026-01-10`);
  check(same(listIds(r), [s.g1]), "and 18:00 UTC is still 10 January there", `${listIds(r)}`);
  r = await a.get(`${N}/list?from=2026-01-01&to=2026-02-01`);
  check(same(listIds(r), [s.f2, s.f1, s.b1, s.g1]), "a range includes the whole of its last day", `${listIds(r)}`);
  r = await a.get(`${N}/list?from=2026-01-11`);
  check(same(listIds(r), [s.e1, s.d1, s.a1, s.p1, s.f2, s.f1, s.b1]), "from alone is open-ended", `${listIds(r)}`);
  r = await a.get(`${N}/list?to=2026-01-10`);
  check(same(listIds(r), [s.g1]), "to alone is open-ended", `${listIds(r)}`);
  r = await a.get(`${N}/list?category=booking&from=2026-01-11&to=2026-01-11`);
  check(same(listIds(r), [s.b1]), "dates and category combine", `${listIds(r)}`);

  section("Invalid parameters");
  const invalid = [
    ["status=bogus", "status"],
    ["status[]=all", "status"],
    ["category=Bad%20Key", "category"],
    [`q=${"x".repeat(101)}`, "q"],
    ["from=2026-02-30", "from"],
    ["to=13-01-2026", "to"],
    ["from=2026-01-12&to=2026-01-11", "to"],
    ["limit=0", "limit"],
    ["limit=51", "limit"],
    ["limit=ten", "limit"],
    ["cursor=%21%21%21", "cursor"],
    [`cursor=${Buffer.from("2026-01-01T00:00:00Z|x").toString("base64url")}`, "cursor"],
  ];
  for (const [query, field] of invalid) {
    const rr = await a.get(`${N}/list?${query}`);
    check(rr.status === 422 && typeof rr.json?.fields?.[field] === "string", `${query.slice(0, 40)} → 422 naming ${field}`, `status ${rr.status} ${rr.text.slice(0, 160)}`);
  }
  r = await a.get(`${N}/list?q=${"x".repeat(100)}`);
  check(r.status === 200, "a 100-character search is allowed");

  section("Cursor pages");
  const walked = [];
  let cursor = null;
  let pages = 0;
  let pageSizesOk = true;
  do {
    const rr = await a.get(`${N}/list?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    if (rr.status !== 200) {
      check(false, "a page loads", `status ${rr.status} ${rr.text.slice(0, 200)}`);
      break;
    }
    walked.push(...listIds(rr));
    cursor = rr.json.nextCursor;
    if (cursor !== null && (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor))) pageSizesOk = false;
    if (rr.json.items.length > 3 || (cursor !== null && rr.json.items.length !== 3)) pageSizesOk = false;
    pages += 1;
  } while (cursor && pages < 10);
  check(pages === 3, "eight rows in pages of three take three pages", `pages ${pages}`);
  check(pageSizesOk, "each page is full until the last, and the cursor is base64url");
  check(same(walked, expectedAll), "walking every page visits every row once, in order", `${walked}`);
  check(new Set(walked).size === walked.length, "with no duplicates");
  r = await a.get(`${N}/list?limit=2&category=festival,pooja`);
  const p2 = await a.get(`${N}/list?limit=2&category=festival,pooja&cursor=${r.json?.nextCursor}`);
  check(same([...listIds(r), ...listIds(p2)], [s.p1, s.f2, s.f1]) && p2.json?.nextCursor === null, "cursors keep the filters they were made with (the tied f2/f1 split across pages)", `${listIds(r)} | ${listIds(p2)}`);

  /* ── Changes ──────────────────────────────────────────────────────── */
  section("Read and unread");
  r = await a.post(`${N}/read`, { ids: [s.b1] });
  check(r.status === 200 && r.json?.ok === true && r.json?.updated === 1 && r.json?.unread === 7, "read marks one and returns the fresh count", r.text);
  let d = one("SELECT status, read_at FROM notification_deliveries WHERE notification_id = ? AND channel = 'inapp'", [s.b1]);
  check(d?.status === "read" && d?.read_at !== null, "the in-app delivery is read too", JSON.stringify(d));
  check(one("SELECT COUNT(*) AS c FROM notification_delivery_events e JOIN notification_deliveries d ON d.id = e.delivery_id WHERE d.notification_id = ? AND e.event = 'read'", [s.b1])?.c === 1, "and its history records it");
  r = await a.post(`${N}/read`, { ids: [s.b1] });
  check(r.json?.updated === 0 && r.json?.unread === 7, "reading it again changes nothing", r.text);
  r = await a.get(`${N}/list?status=read`);
  check(same(listIds(r), [s.b1]) && r.json.items[0].isRead === true && /Z$/.test(r.json.items[0].readAt), "status=read now shows it, with readAt", r.text.slice(0, 200));
  r = await a.get(`${N}/list?status=unread`);
  check(!listIds(r).includes(s.b1) && listIds(r).length === 7, "and status=unread no longer does");

  r = await a.post(`${N}/read`, { ids: [s.bOwn] });
  check(r.status === 200 && r.json?.updated === 0 && r.json?.unread === 7, "A reading B's notification updates 0", r.text);
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.bOwn])?.read_at === null, "and B's row is untouched");
  for (const [label, id] of [["the guest", s.guest], ["the push-only", s.hidden], ["the deleted", s.deleted], ["the held", s.future]]) {
    const rr = await a.post(`${N}/read`, { ids: [id] });
    check(rr.json?.updated === 0, `reading ${label} notification updates 0`, rr.text);
  }
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.future])?.read_at === null, "the held one was not marked read before it is due");

  r = await a.post(`${N}/unread`, { ids: [s.b1, s.bOwn] });
  check(r.json?.updated === 1 && r.json?.unread === 8, "unread restores it (and ignores B's id)", r.text);
  d = one("SELECT status, read_at FROM notification_deliveries WHERE notification_id = ? AND channel = 'inapp'", [s.b1]);
  check(d?.status === "sent" && d?.read_at === null, "the in-app delivery is back to sent with no read_at", JSON.stringify(d));

  r = await a.post(`${N}/read`, { ids: [s.g1, s.g1, String(s.g1)] });
  check(r.json?.updated === 1 && r.json?.unread === 7, "duplicate ids count once", r.text);
  r = await a.post(`${N}/unread`, { ids: [s.g1] });
  check(r.json?.updated === 1 && r.json?.unread === 8, "and unread puts it back", r.text);

  section("Id validation");
  for (const [label, body] of [
    ["no ids", {}],
    ["an empty list", { ids: [] }],
    // {"0": id} decodes in PHP to a real list, so a keyed object is the case to refuse.
    ["an object instead of a list", { ids: { first: s.g1 } }],
    ["a word", { ids: ["one"] }],
    ["zero", { ids: [0] }],
    ["a negative id", { ids: [-4] }],
    ["a fraction", { ids: [1.5] }],
    ["201 ids", { ids: Array.from({ length: 201 }, (_, i) => i + 1) }],
  ]) {
    const rr = await a.post(`${N}/archive`, body);
    check(rr.status === 422 && typeof rr.json?.fields?.ids === "string", `${label} → 422`, `status ${rr.status}`);
  }
  r = await a.post(`${N}/archive`, { ids: Array.from({ length: 200 }, (_, i) => 4000000000 - i) });
  check(r.status === 200 && r.json?.updated === 0, "200 ids is allowed (none of these exist)", `status ${r.status}`);

  section("Archive, unarchive, delete");
  r = await a.post(`${N}/archive`, { ids: [s.f1, s.bOwn] });
  check(r.json?.updated === 1 && r.json?.unread === 7, "archive hides one from the count (and ignores B's id)", r.text);
  check(one("SELECT archived_at FROM notifications WHERE id = ?", [s.bOwn])?.archived_at === null, "B's row is not archived");
  r = await a.get(`${N}/list`);
  check(!listIds(r).includes(s.f1), "the archived one leaves the main list");
  r = await a.get(`${N}/list?status=archived`);
  check(listIds(r).length === 2 && listIds(r).includes(s.f1) && listIds(r).includes(s.archived), "and joins the archived list", `${listIds(r)}`);
  check(r.json?.items?.find((i) => i.id === s.f1)?.isArchived === true, "with isArchived true");
  r = await a.post(`${N}/archive`, { ids: [s.f1] });
  check(r.json?.updated === 0, "archiving it again changes nothing");
  r = await a.post(`${N}/unarchive`, { ids: [s.f1] });
  check(r.json?.updated === 1 && r.json?.unread === 8, "unarchive brings it back", r.text);
  r = await a.get(`${N}/list`);
  check(same(listIds(r), expectedAll), "and the list is whole again", `${listIds(r)}`);

  r = await a.post(`${N}/delete`, { ids: [s.e1, s.bOwn] });
  check(r.json?.updated === 1 && r.json?.unread === 7, "delete removes one (and ignores B's id)", r.text);
  check(one("SELECT deleted_at FROM notifications WHERE id = ?", [s.e1])?.deleted_at !== null, "it is a soft delete: the row is kept with deleted_at");
  check(one("SELECT deleted_at FROM notifications WHERE id = ?", [s.bOwn])?.deleted_at === null, "B's row is not deleted");
  let everywhere = [];
  for (const st of ["all", "unread", "read", "archived"]) everywhere.push(...listIds(await a.get(`${N}/list?status=${st}`)));
  check(!everywhere.includes(s.e1), "a deleted notification appears under no status");
  r = await a.post(`${N}/delete`, { ids: [s.e1] });
  check(r.json?.updated === 0, "deleting it again changes nothing");
  r = await a.post(`${N}/unarchive`, { ids: [s.e1] });
  check(r.json?.updated === 0, "nor can it be unarchived back into view");

  section("Click");
  r = await a.post(`${N}/click`, { id: s.b1 });
  check(r.status === 200 && r.json?.ok === true && r.json?.url === "/account?tab=bookings" && r.json?.unread === 6, "click returns the link and the fresh count", r.text);
  d = one("SELECT id, status, clicked_at FROM notification_deliveries WHERE notification_id = ? AND channel = 'inapp'", [s.b1]);
  check(d?.status === "read" && d?.clicked_at !== null, "the in-app delivery is read and clicked", JSON.stringify(d));
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.b1])?.read_at !== null, "the notification is read");
  await a.post(`${N}/click`, { id: s.b1 });
  const clicks = one("SELECT COUNT(*) AS c FROM notification_delivery_events WHERE delivery_id = ? AND event = 'clicked'", [d.id])?.c;
  check(clicks === 1, "a second click is not a second recorded click", `clicked events ${clicks}`);
  r = await a.post(`${N}/click`, { id: s.g1 });
  check(r.status === 200 && r.json?.url === null && r.json?.unread === 5, "a notification with no link answers url null (and is read)", r.text);
  r = await a.post(`${N}/click`, { id: s.bOwn });
  check(r.status === 404, "clicking B's notification is a 404", `status ${r.status}`);
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.bOwn])?.read_at === null, "and does not mark it read");
  r = await a.post(`${N}/click`, { id: "first" });
  check(r.status === 422 && !!r.json?.fields?.id, "a click without a numeric id is 422", `status ${r.status}`);

  section("Read all");
  r = await a.post(`${N}/read-all`, {});
  check(r.status === 200 && r.json?.unread === 0 && r.json?.updated >= 5, "read-all leaves nothing unread", r.text);
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.bOwn])?.read_at === null, "and never touches B's");
  check(one("SELECT read_at FROM notifications WHERE id = ?", [s.future])?.read_at === null, "nor the one still held");
  const unreadDeliveries = one(
    "SELECT COUNT(*) AS c FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.devotee_id = ? AND n.deleted_at IS NULL AND n.show_in_app = 1 AND n.deliver_after IS NULL AND d.channel = 'inapp' AND d.status <> 'read'",
    [A.id],
  )?.c;
  check(unreadDeliveries === 0, "every visible in-app delivery is read", `unread deliveries ${unreadDeliveries}`);
  r = await a.post(`${N}/read-all`, {});
  check(r.json?.updated === 0 && r.json?.unread === 0, "a second read-all changes nothing");
  r = await a.post(`${N}/unread`, { ids: [s.p1] });
  check(r.json?.unread === 1, "one can be marked unread again afterwards");

  section("Held and hidden notifications");
  r = await a.get(`${N}/unread`);
  check(r.json?.unread === 1 && r.json?.latestId === s.d1, "the held notification is not counted nor latest", r.text);
  // Both times are moved relative to the row's own created_at (written by PHP's
  // clock), never to MySQL's UTC_TIMESTAMP(): the database container's clock can
  // differ from PHP's by tens of seconds. MySQL applies the assignments in
  // order, so deliver_after lands one minute before the original creation —
  // in the past, and after the new created_at.
  sql("UPDATE notifications SET created_at = created_at - INTERVAL 5 MINUTE, deliver_after = created_at + INTERVAL 4 MINUTE WHERE id = ?", [s.future]);
  const dueAt = one("SELECT deliver_after FROM notifications WHERE id = ?", [s.future]).deliver_after;
  r = await a.get(`${N}/list`);
  check(listIds(r)[0] === s.future, "once due it appears — at the top, dated when it became visible", `${listIds(r)}`);
  check(r.json?.items?.[0]?.createdAt === new Date(`${dueAt.replace(" ", "T")}Z`).toISOString().replace(".000Z", "Z"), "createdAt is its deliver_after", `${r.json?.items?.[0]?.createdAt} vs ${dueAt}`);
  check(r.json?.unread === 2, "and it counts as unread", `unread ${r.json?.unread}`);
  r = await a.get(`${N}/unread`);
  check(r.json?.latestId === s.future, "and is now the latest the bell sees", r.text);
  r = await a.post(`${N}/read`, { ids: [s.future] });
  check(r.json?.updated === 1, "and can be read now", r.text);
  everywhere = [];
  for (const st of ["all", "unread", "read", "archived"]) everywhere.push(...listIds(await a.get(`${N}/list?status=${st}`)));
  check(!everywhere.includes(s.hidden) && !everywhere.includes(s.guest) && !everywhere.includes(s.bOwn), "show_in_app 0, guest and B's rows never appear under any status");

  /* ── Categories and preferences ───────────────────────────────────── */
  section("Categories");
  r = await a.get(`${N}/categories`);
  const cats = r.json ?? [];
  const security = Array.isArray(cats) ? cats.find((c) => c.key === "security") : null;
  const festival = Array.isArray(cats) ? cats.find((c) => c.key === "festival") : null;
  check(r.status === 200 && Array.isArray(cats) && cats.length >= 10, "categories are listed", `status ${r.status}`);
  check(security?.mutable === false && security?.kind === "security" && security?.label?.en === "Security" && security?.icon === "shield-check", "security cannot be muted", JSON.stringify(security));
  check(festival?.mutable === true && festival?.defaultOn === true, "festival can", JSON.stringify(festival));

  section("Preferences");
  r = await a.get(`${N}/prefs`);
  const p = r.json ?? {};
  check(r.status === 200, "prefs load", `status ${r.status} ${r.text.slice(0, 200)}`);
  check(
    p.prefs?.lang === "ta" && p.prefs?.timezone === null && p.prefs?.effectiveTimezone === "Asia/Kolkata" &&
      same(p.prefs?.channels, { inapp: true, email: true, whatsapp: true, sms: true, push: true }) &&
      same(p.prefs?.muted, []) && p.prefs?.promotional === false && p.prefs?.unsubscribed === false,
    "a devotee who never saved gets the defaults, in their country's time zone",
    JSON.stringify(p.prefs),
  );
  check(Array.isArray(p.categories) && p.categories.some((c) => c.key === "booking" && c.mutable === false), "prefs carry the categories");
  check(same(p.channels?.inapp, { available: true }), "in-app is always available");
  check(p.channels?.email?.available === true && p.channels?.email?.reason === null, "email is available", JSON.stringify(p.channels?.email));
  check(p.channels?.whatsapp?.available === true && p.channels?.sms?.available === true, "whatsapp and sms are available with a phone (log driver)", JSON.stringify(p.channels));
  check(p.channels?.push?.available === true && typeof p.channels?.push?.publicKey === "string" && p.channels.push.publicKey.length === 87 && p.channels?.push?.devices === 0, "push has a public key and no devices yet", JSON.stringify(p.channels?.push));
  check(Array.isArray(p.languages) && p.languages.some((l) => l.code === "ta" && l.label === "தமிழ்") && p.languages.some((l) => l.code === "en"), "languages are offered with their own names");
  check(same(p.phone, { number: "+919876500011", verified: false }), "the phone is shown with its plus and its verification state", JSON.stringify(p.phone));

  r = await b.get(`${N}/prefs`);
  check(r.json?.channels?.whatsapp?.available === false && r.json?.channels?.whatsapp?.reason === "no phone", "without a phone, WhatsApp says why", JSON.stringify(r.json?.channels?.whatsapp));
  check(r.json?.channels?.sms?.reason === "no phone" && same(r.json?.phone, { number: null, verified: false }), "and so does SMS");

  r = await a.post(`${N}/prefs`, {
    lang: "en",
    timezone: "Europe/London",
    channels: { sms: false, whatsapp: true },
    muted: ["festival", "security", "booking", "no-such-category"],
    promotional: true,
  });
  check(r.status === 200 && r.json?.ok === true && typeof r.json?.message === "string", "prefs save", `status ${r.status} ${r.text.slice(0, 200)}`);
  check(r.json?.prefs?.lang === "en" && r.json?.prefs?.timezone === "Europe/London" && r.json?.prefs?.effectiveTimezone === "Europe/London", "language and time zone are saved", JSON.stringify(r.json?.prefs));
  check(r.json?.prefs?.channels?.sms === false && r.json?.prefs?.channels?.whatsapp === true && r.json?.prefs?.channels?.email === true, "a channel switch is saved and the others kept");
  check(same(r.json?.prefs?.muted, ["festival"]), "security and booking cannot be muted; unknown keys are dropped", JSON.stringify(r.json?.prefs?.muted));
  check(r.json?.prefs?.promotional === true, "promotional consent is recorded");
  const consentAt = one("SELECT promotional_opt_in_at FROM devotee_notification_prefs WHERE devotee_id = ?", [A.id])?.promotional_opt_in_at;
  check(!!consentAt, "as a consent time");
  r = await a.get(`${N}/prefs`);
  check(r.json?.prefs?.lang === "en" && same(r.json?.prefs?.muted, ["festival"]) && r.json?.prefs?.channels?.sms === false, "and read back the same", JSON.stringify(r.json?.prefs));

  r = await a.post(`${N}/prefs`, { promotional: false });
  check(r.json?.prefs?.promotional === false && r.json?.prefs?.lang === "en", "consent can be withdrawn without resetting the rest", JSON.stringify(r.json?.prefs));
  check(one("SELECT promotional_opt_in_at FROM devotee_notification_prefs WHERE devotee_id = ?", [A.id])?.promotional_opt_in_at === null, "and the consent time is cleared");

  for (const [label, body, field] of [
    ["an unknown language", { lang: "xx" }, "lang"],
    ["a language that is not a string", { lang: 7 }, "lang"],
    ["an unknown time zone", { timezone: "Mars/Olympus_Mons" }, "timezone"],
    ["channels that are not an object", { channels: "all" }, "channels"],
    ["a channel switch that is not a boolean", { channels: { email: "maybe" } }, "channels"],
    ["muted that is not a list", { muted: "festival" }, "muted"],
    ["promotional that is not a boolean", { promotional: "perhaps" }, "promotional"],
  ]) {
    const rr = await a.post(`${N}/prefs`, body);
    check(rr.status === 422 && typeof rr.json?.fields?.[field] === "string", `${label} → 422 naming ${field}`, `status ${rr.status} ${rr.text.slice(0, 160)}`);
  }
  r = await a.post(`${N}/prefs`, { lang: "ta", timezone: "Nowhere/Land" });
  check(r.status === 422, "one bad field fails the whole save");
  r = await a.get(`${N}/prefs`);
  check(r.json?.prefs?.lang === "en" && r.json?.prefs?.timezone === "Europe/London", "and nothing from a refused save was stored", JSON.stringify(r.json?.prefs));

  // In London, 10 January 18:00 and 20:00 UTC are both still the 10th.
  r = await a.get(`${N}/list?from=2026-01-10&to=2026-01-10`);
  check(same(listIds(r), [s.b1, s.g1]), "date filters follow a changed time zone", `${listIds(r)}`);

  /* ── Devices ──────────────────────────────────────────────────────── */
  section("Push devices");
  const endpoint = `https://push.example.test/e2e-napi-${RUN}/${randomBytes(8).toString("hex")}`;
  const keys = {
    p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
  r = await a.post(`${N}/devices`, { subscription: { endpoint, keys }, platform: "web" });
  check(r.status === 200 && r.json?.ok === true && Number.isInteger(r.json?.deviceId), "a browser registers for push", `status ${r.status} ${r.text.slice(0, 200)}`);
  const deviceId = r.json?.deviceId;
  r = await a.post(`${N}/devices`, { subscription: { endpoint, keys } });
  check(r.status === 200 && r.json?.deviceId === deviceId, "registering the same browser again is the same device", r.text);
  check(one("SELECT COUNT(*) AS c FROM devotee_devices WHERE devotee_id = ?", [A.id])?.c === 1, "one row, not two");
  r = await a.get(`${N}/prefs`);
  check(r.json?.channels?.push?.devices === 1, "prefs count the device", JSON.stringify(r.json?.channels?.push));

  for (const [label, body, field] of [
    ["no subscription", {}, "subscription"],
    ["a plain http endpoint", { subscription: { endpoint: endpoint.replace("https:", "http:"), keys } }, "endpoint"],
    ["an endpoint over 2000 characters", { subscription: { endpoint: `https://push.example.test/${"x".repeat(2000)}`, keys } }, "endpoint"],
    ["a short p256dh key", { subscription: { endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(1) } } }, "keys"],
    ["a long auth secret", { subscription: { endpoint, keys: { ...keys, auth: `${keys.auth}A` } } }, "keys"],
    ["an unknown platform", { subscription: { endpoint, keys }, platform: "toaster" }, "platform"],
  ]) {
    const rr = await a.post(`${N}/devices`, body);
    check(rr.status === 422 && typeof rr.json?.fields?.[field] === "string", `${label} → 422 naming ${field}`, `status ${rr.status} ${rr.text.slice(0, 160)}`);
  }
  // Right lengths, but not a point on the curve's uncompressed form: the service refuses it.
  r = await a.post(`${N}/devices`, { subscription: { endpoint: `${endpoint}-2`, keys: { ...keys, p256dh: Buffer.concat([Buffer.from([7]), randomBytes(64)]).toString("base64url") } } });
  check(r.status === 422 && typeof r.json?.error === "string", "a key the service cannot use → 422 with its message", `status ${r.status}`);

  r = await b.post(`${N}/devices-remove`, { endpoint });
  check(r.status === 200 && r.json?.ok === true && r.json?.removed === false, "B cannot remove A's device", r.text);
  check(one("SELECT COUNT(*) AS c FROM devotee_devices WHERE devotee_id = ? AND is_active = 1", [A.id])?.c === 1, "A's device is still there");
  r = await a.post(`${N}/devices-remove`, {});
  check(r.status === 422 && !!r.json?.fields?.endpoint, "devices-remove needs an endpoint", `status ${r.status}`);
  r = await a.post(`${N}/devices-remove`, { endpoint });
  check(r.json?.ok === true && r.json?.removed === true, "A removes it", r.text);
  r = await a.get(`${N}/prefs`);
  check(r.json?.channels?.push?.devices === 0, "and prefs count none");

  /* ── Rate limit ───────────────────────────────────────────────────── */
  section("Rate limit");
  const rc = new Client("rate", IP.rate);
  await rc.signIn(R.email);
  const statuses = [];
  for (let i = 0; i < 121; i++) statuses.push((await rc.post(`${N}/read-all`, {})).status);
  const firstLimited = statuses.indexOf(429);
  check(statuses.slice(0, 120).every((x) => x === 200), "120 changes in a minute are allowed", `first non-200 at ${statuses.findIndex((x) => x !== 200)}: ${statuses.find((x) => x !== 200)}`);
  check(statuses[120] === 429, "the 121st is refused (429)", `first 429 at ${firstLimited}`);
  r = await rc.post(`${N}/read-all`, {});
  check(r.status === 429 && r.json?.code === "rate_limited" && r.headers.get("retry-after") === "60", "with code rate_limited and Retry-After", `status ${r.status}`);
  r = await rc.get(`${N}/unread`);
  check(r.status === 200, "reading is not limited by it");
  r = await a.post(`${N}/read-all`, {});
  check(r.status === 200, "and another devotee's budget is separate");

  /* ── Tracking links ───────────────────────────────────────────────── */
  section("Tracked clicks");
  const t = new Client("tracker", IP.track); // no session: links are opened from an inbox
  const tExternal = seed("t-ext", { devotee_id: A.id, category: "event", title: "E2E-NAPI Darshan", body: "Timings.", cta_url: "https://example.org/darshan?x=1" });
  const tLocal = seed("t-local", { devotee_id: A.id, category: "event", title: "E2E-NAPI Sevas", body: "Book.", cta_url: "/sevas" });
  const tNone = seed("t-none", { devotee_id: A.id, category: "event", title: "E2E-NAPI No link", body: "Nothing to open." });
  const emailSend = seed(
    "t-email",
    { devotee_id: A.id, channels: ["email"], category: "booking", priority: "important", title: "E2E-NAPI Email", body: "An email.", cta_url: "/sevas", sync: true },
    { NOTIFY_EMAIL_DRIVER: "test", NOTIFY_ALLOW_TEST_DRIVER: "1" },
  );
  check(emailSend.deliveries?.email?.status === "sent", "an email delivery was sent through the test driver", JSON.stringify(emailSend.deliveries));
  const dExt = tExternal.deliveries.inapp.id;
  const dLocal = tLocal.deliveries.inapp.id;
  const dNone = tNone.deliveries.inapp.id;
  const dEmail = emailSend.deliveries?.email?.id;
  const tk = tokens({ ext: ["c", dExt], local: ["c", dLocal], none: ["c", dNone], open: ["o", dEmail], openAsClick: ["o", dExt], unsub: ["u", A.id], ghost: ["u", 3999999999] });

  r = await t.get(`/api/n/c/${tk.ext}`);
  check(r.status === 302 && r.headers.get("location") === "https://example.org/darshan?x=1", "a click on an https link redirects there", `status ${r.status} ${r.headers.get("location")}`);
  check(r.headers.get("referrer-policy") === "no-referrer", "without leaking the token in a Referer");
  d = one("SELECT status, clicked_at, read_at FROM notification_deliveries WHERE id = ?", [dExt]);
  check(d?.clicked_at !== null && d?.status === "read", "the click is recorded and the in-app delivery read", JSON.stringify(d));
  const firstClick = d?.clicked_at;
  await sleep(1100);
  r = await t.get(`/api/n/c/${tk.ext}`);
  check(r.status === 302, "a second click still redirects");
  check(
    one("SELECT clicked_at FROM notification_deliveries WHERE id = ?", [dExt])?.clicked_at === firstClick &&
      one("SELECT COUNT(*) AS c FROM notification_delivery_events WHERE delivery_id = ? AND event = 'clicked'", [dExt])?.c === 1,
    "but clicked_at is set only once",
  );
  r = await t.get(`/api/n/c/${tk.local}`);
  const loc = r.headers.get("location") ?? "";
  check(r.status === 302 && /^https?:\/\/[^/]+\/sevas$/.test(loc), "a site path is redirected to on the site's own address", loc);
  r = await t.req("HEAD", `/api/n/c/${tk.none}`);
  check(r.status === 302, "HEAD answers the redirect", `status ${r.status}`);
  check(one("SELECT clicked_at FROM notification_deliveries WHERE id = ?", [dNone])?.clicked_at === null, "but a link checker's HEAD is not a click");
  r = await t.get(`/api/n/c/${tk.none}`);
  check(r.status === 302 && /^https?:\/\/[^/]+\/$/.test(r.headers.get("location") ?? ""), "no link → the home page", r.headers.get("location"));
  const badSig = `${tk.local.split(".")[0]}.AAAAAAAAAAAAAAAA`;
  sql("UPDATE notification_deliveries SET clicked_at = NULL WHERE id = ?", [dLocal]);
  r = await t.get(`/api/n/c/${badSig}`);
  check(r.status === 302 && /^https?:\/\/[^/]+\/$/.test(r.headers.get("location") ?? ""), "a bad signature → the home page", r.headers.get("location"));
  check(one("SELECT clicked_at FROM notification_deliveries WHERE id = ?", [dLocal])?.clicked_at === null, "and records nothing");
  r = await t.get(`/api/n/c/${tk.openAsClick}`);
  check(r.status === 302 && /\/$/.test(r.headers.get("location") ?? "") && one("SELECT COUNT(*) AS c FROM notification_delivery_events WHERE delivery_id = ? AND event = 'clicked'", [dExt])?.c === 1, "an open token in a click URL is not a click");
  r = await t.get("/api/n/c/not-a-token");
  check(r.status === 404 && r.json?.error === "Not found", "a malformed token is not a route (404)", `status ${r.status}`);
  r = await t.get(`/api/n/x/${tk.ext}`);
  check(r.status === 404, "nor is an unknown kind", `status ${r.status}`);
  r = await t.post(`/api/n/c/${tk.ext}`, {});
  check(r.status === 405, "a click link only answers GET", `status ${r.status}`);

  section("Open pixel");
  r = await t.get(`/api/n/o/${tk.open}`);
  check(r.status === 200 && r.headers.get("content-type") === "image/gif", "the pixel is image/gif", `status ${r.status} ${r.headers.get("content-type")}`);
  check(r.buf.subarray(0, 6).toString("latin1") === "GIF89a" && r.buf.length > 30 && r.buf.length < 64 && r.buf[r.buf.length - 1] === 0x3b, "a real GIF89a file", `${r.buf.length} bytes`);
  check(/no-store/.test(r.headers.get("cache-control") ?? "") && /private/.test(r.headers.get("cache-control") ?? ""), "Cache-Control: no-store, private", r.headers.get("cache-control"));
  d = one("SELECT status, read_at FROM notification_deliveries WHERE id = ?", [dEmail]);
  check(d?.status === "read" && d?.read_at !== null, "the email delivery is now read", JSON.stringify(d));
  r = await t.get("/api/n/o/o1.AAAAAAAAAAAAAAAA");
  check(r.status === 200 && r.buf.subarray(0, 6).toString("latin1") === "GIF89a", "an invalid token still gets the GIF");
  r = await t.get(`/api/n/o/${tk.ext}`);
  check(r.status === 200 && r.headers.get("content-type") === "image/gif", "a click token on the pixel URL is still just a GIF");

  section("Unsubscribe");
  const unsubAt = () => one("SELECT unsubscribed_at FROM devotee_notification_prefs WHERE devotee_id = ?", [A.id])?.unsubscribed_at ?? null;
  check(unsubAt() === null, "A starts subscribed");
  r = await t.get(`/api/n/u/${tk.unsub}`);
  check(r.status === 200 && /^text\/html/.test(r.headers.get("content-type") ?? ""), "GET shows a page", `status ${r.status}`);
  check(/<form method="post" action="\/api\/n\/u\//.test(r.text) && /<button type="submit">/.test(r.text), "with a POST button");
  check(r.text.includes("Stop optional emails") && r.text.includes("விருப்ப மின்னஞ்சல்"), "in both languages");
  check(r.text.includes(`e***@example.test`) && !r.text.includes(A.email), "naming the address only in masked form");
  check(!/<script/i.test(r.text), "with no JavaScript");
  check(/default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""), "under a strict Content-Security-Policy");
  check(unsubAt() === null, "GET changed nothing (mail scanners follow links)");
  r = await t.req("HEAD", `/api/n/u/${tk.unsub}`);
  check(r.status === 200 && unsubAt() === null, "nor does HEAD");

  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" } });
  check(r.status === 200 && r.text.includes("You have been unsubscribed"), "POST unsubscribes and confirms", `status ${r.status}`);
  const firstUnsub = unsubAt();
  check(firstUnsub !== null, "unsubscribed_at is set");
  let row = one("SELECT email_on, lang, muted_categories FROM devotee_notification_prefs WHERE devotee_id = ?", [A.id]);
  check(row?.email_on === 1 && row?.lang === "en" && row?.muted_categories === "festival", "without switching email off (receipts and security mail still go) or touching other settings", JSON.stringify(row));
  check(r.text.includes("/account?tab=notifications"), "the confirmation links to the notification settings");
  r = await a.get(`${N}/prefs`);
  check(r.json?.prefs?.unsubscribed === true, "the devotee's settings show it");
  await sleep(1100);
  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check(r.status === 200 && unsubAt() === firstUnsub, "a repeated POST is idempotent (the first time is kept)", `${unsubAt()} vs ${firstUnsub}`);
  r = await t.get(`/api/n/u/${tk.unsub}`);
  check(r.status === 200 && r.text.includes("already unsubscribed") && !/<form/.test(r.text), "GET now says so, with no button");

  r = await a.post(`${N}/prefs`, { channels: { email: true } });
  check(r.json?.prefs?.unsubscribed === false && unsubAt() === null, "turning email on in settings resubscribes", JSON.stringify(r.json?.prefs));
  // RFC 8058: the mail provider posts from its own servers, multipart or urlencoded, no cookies.
  const boundary = `napi${RUN}`;
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`;
  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: multipart, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
  check(r.status === 200 && unsubAt() !== null, "an RFC 8058 one-click POST unsubscribes", `status ${r.status}`);

  r = await t.get(`/api/n/u/${badSig.replace(/^c/, "u")}`);
  check(r.status === 404 && /^text\/html/.test(r.headers.get("content-type") ?? "") && r.text.includes("This link is not valid"), "a bad unsubscribe token gets a page saying so (404)", `status ${r.status}`);
  r = await t.req("POST", `/api/n/u/${badSig.replace(/^c/, "u")}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check(r.status === 404, "and POSTing it changes nothing (404)", `status ${r.status}`);
  r = await t.get(`/api/n/u/${tk.ghost}`);
  check(r.status === 404 && r.text.includes("This link is not valid"), "a genuine token for an account that no longer exists is not valid either", `status ${r.status}`);
  r = await t.req("PUT", `/api/n/u/${tk.unsub}`);
  check(r.status === 405, "other methods are 405", `status ${r.status}`);

  /* ── Webhook and cron routes ──────────────────────────────────────── */
  section("Webhook route");
  const g = new Client("routes", IP.hook);
  r = await g.post("/api/notify-webhook/test", {});
  check(r.status === 404, "on the default server no channel uses the test driver: 404", `status ${r.status}`);
  r = await g.get("/api/notify-webhook/Not_A-Driver");
  check(r.status === 404 && r.json?.error === "Not found", "a malformed driver is not a route", `status ${r.status}`);

  const up = await startExtraServer();
  check(up, `a second server started on ${EXTRA_PORT} with the test driver`);
  if (up) {
    const hookSend = seed(
      "hook-sms",
      { devotee_id: H.id, channels: ["sms"], category: "booking", priority: "important", title: "E2E-NAPI SMS", body: "A text.", sync: true },
      { NOTIFY_SMS_DRIVER: "test", NOTIFY_ALLOW_TEST_DRIVER: "1" },
    );
    const smsId = hookSend.deliveries?.sms?.id;
    check(hookSend.deliveries?.sms?.status === "sent", "an SMS was sent through the test driver", JSON.stringify(hookSend.deliveries));
    const hook = new Client("hook", IP.hook, EXTRA);
    const payload = JSON.stringify({ updates: [{ message_id: `test-${smsId}`, status: "delivered" }] });
    const sig = createHmac("sha256", process.env.NOTIFY_TEST_WEBHOOK_SECRET || "test-webhook-secret").update(payload).digest("hex");
    r = await hook.req("POST", "/api/notify-webhook/test", undefined, { raw: payload, headers: { "Content-Type": "application/json", "X-Test-Signature": "0".repeat(64) } });
    check(r.status === 403 && r.text === "", "a wrong signature is refused with 403 and no body", `status ${r.status} ${r.text.slice(0, 80)}`);
    check(one("SELECT status FROM notification_deliveries WHERE id = ?", [smsId])?.status === "sent", "and changes nothing");
    r = await hook.req("POST", "/api/notify-webhook/test", undefined, { raw: payload, headers: { "Content-Type": "application/json", "X-Test-Signature": sig } });
    check(r.status === 200 && r.json?.ok === true, "a signed callback reaches notify_webhook.php through api/index.php", `status ${r.status} ${r.text.slice(0, 120)}`);
    check(one("SELECT status FROM notification_deliveries WHERE id = ?", [smsId])?.status === "delivered", "and the delivery is now delivered");
    r = await hook.post("/api/notify-webhook/twilio", {});
    check(r.status === 404, "a driver no channel uses is 404", `status ${r.status}`);

    section("Cron route");
    r = await g.get("/api/notify-cron");
    check(r.status === 404, "without NOTIFY_CRON_KEY the endpoint is 404", `status ${r.status}`);
    r = await hook.get("/api/notify-cron");
    check(r.status === 403, "with the key set, a request without it is 403", `status ${r.status}`);
    r = await hook.get("/api/notify-cron", { headers: { "X-Cron-Key": `${CRON_KEY}-wrong` } });
    check(r.status === 403, "and a wrong key is 403", `status ${r.status}`);
    await holdWorkerLock(async (held) => {
      check(held, "the worker lock is held by this suite, so no shared queue is drained");
      if (!held) return;
      const rr = await hook.get("/api/notify-cron", { headers: { "X-Cron-Key": CRON_KEY } });
      check(rr.status === 200 && rr.json?.locked === true, "the right key is 200 and reaches the worker (locked while this suite holds the lock)", `status ${rr.status} ${rr.text.slice(0, 160)}`);
    });
    r = await hook.req("PUT", "/api/notify-cron", undefined, { headers: { "X-Cron-Key": CRON_KEY } });
    check(r.status === 405, "the endpoint itself refuses other methods", `status ${r.status}`);

    section("Availability from provider configuration");
    const a2 = new Client("A on 8030", IP.a8030, EXTRA);
    await a2.signIn(A.email);
    r = await a2.get(`${N}/prefs`);
    check(r.json?.channels?.whatsapp?.available === false && r.json?.channels?.whatsapp?.reason === "not configured", "a driver without credentials is 'not configured'", JSON.stringify(r.json?.channels?.whatsapp));
    check(r.json?.channels?.sms?.available === true && r.json?.channels?.sms?.reason === null, "while a configured one is available", JSON.stringify(r.json?.channels?.sms));
  }

  section("Existing routes");
  r = await g.get("/api/sevas");
  check(r.status === 200 && Array.isArray(r.json), "GET /api/sevas still answers", `status ${r.status}`);
  r = await g.get("/api/no-such-route");
  check(r.status === 404 && r.json?.error === "Not found", "an unknown path is still a JSON 404", `status ${r.status}`);
  r = await g.get("/api/auth/me");
  check(r.status === 200 && "accountsEnabled" in (r.json ?? {}), "the auth group still answers");
  r = await g.get("/api/account/summary");
  check(r.status === 401, "the account group still needs a session");
  r = await g.get("/api/notificationsx/list");
  check(r.status === 404, "a lookalike prefix is not the notifications group");
}

main().catch((err) => {
  console.error("\nHarness error:", err);
  stopExtraServer();
  try {
    cleanup();
  } catch (e) {
    console.error("cleanup failed:", e.message);
  }
  process.exit(2);
});
