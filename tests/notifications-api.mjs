#!/usr/bin/env node
/**
 * tests/notifications-api.mjs — the notification links in every message and
 * the service's HTTP routes, end to end against the real PHP + MySQL stack
 * (docs/notifications/SPEC.md §6.2, §6.6; docs/registration/SPEC.md §6).
 *
 *   PHP_BIN=/path/to/php.sh node tests/notifications-api.mjs [http://127.0.0.1:8050]
 *
 * What it proves:
 *   • the devotee inbox, its preferences and push devices went with devotee
 *     sign-in: every one of their routes, and the account routes, answers 404
 *     under /api and /api/v1, starts no session and changes nothing;
 *   • tracked clicks redirect (https links as given, site paths on the site's
 *     own address, no link to the home page), count once, ignore a link
 *     checker's HEAD, bad signatures and open tokens, and answer only GET;
 *   • the open pixel is a real GIF, uncached, marks an email read once, and
 *     answers any token with the same GIF;
 *   • unsubscribe: GET shows a two-language page (masked email, or masked
 *     phone when the registration has none) and changes nothing; POST and the
 *     RFC 8058 one-click (urlencoded or multipart, no cookies) withdraw the
 *     family's consent once, after which temple news stops on every channel
 *     while its own booking messages still go; bad, forged and orphaned tokens
 *     get the "not valid" page; other methods are 405;
 *   • /api/notify-webhook/<driver> (signatures, 404 for drivers no channel
 *     uses) and /api/notify-cron (key checks) reach their endpoints through
 *     api/index.php; a driver without credentials is skipped as not configured.
 *
 * Registrations are created with tests/support/notify_fixtures.php. Every
 * request sends its own X-Forwarded-For in 10.31.x.x. A second PHP server on
 * port 8030 runs with the test driver and a cron key; it is stopped at the end.
 *
 * Data: registrations e2e-napi-<run>-*@example.test (and one without an email,
 * removed by id), dedupe keys e2e:napi:<run>:*. Removed at the start (a crashed
 * earlier run) and at the end.
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

const IP = { guest: "10.31.3.3", track: "10.31.4.4", hook: "10.31.5.5" };

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
  const r = fixtures("create-devotee", { email: `${EMAIL_PREFIX}${RUN}-${tag}@example.test`, name: `E2E-NAPI ${tag}`, ...extra });
  if (!r.id) throw new Error(`could not create devotee ${tag}: ${JSON.stringify(r)}`);
  return { id: r.id, email: r.email };
}

/** notify() through the fixtures CLI; returns the notification id. */
function seed(key, n, env) {
  const r = fixtures("notify", { channels: ["email"], category: "general", priority: "normal", ...n, dedupe_key: `${DEDUPE}:${key}` }, env);
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
}


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

function cleanup() {
  // Guest notifications have no devotee to cascade from.
  sql("DELETE FROM notifications WHERE dedupe_key LIKE 'e2e:napi:%'");
  fixtures("cleanup", { email_prefix: EMAIL_PREFIX });
  sql("DELETE FROM rate_limits WHERE bucket LIKE '%10.31.%'");
}

/* ── The suite ─────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Notification links and routes — ${BASE} (extra server ${EXTRA})`);
  console.log(`run id ${RUN}\n`);
  cleanup();

  // Families who registered with consent to temple updates; P has no email.
  const A = createDevotee("a", { phone: "919876500011", country: "IN", consent: true });
  const H = createDevotee("hook", { phone: "919876500020", consent: true });
  const P = createDevotee("phoneonly", { email: "", phone: "919876500033", consent: true });
  const ids = [A.id, H.id, P.id];

  try {
    await suite(A, H, P);
  } finally {
    stopExtraServer();
    cleanup(ids);
    sql("DELETE FROM devotees WHERE id = ?", [P.id]);
    const left = one(
      "SELECT (SELECT COUNT(*) FROM devotees WHERE email LIKE 'e2e-napi-%' OR id = ?) AS devotees, (SELECT COUNT(*) FROM notifications WHERE dedupe_key LIKE 'e2e:napi:%') AS notifications, (SELECT COUNT(*) FROM rate_limits WHERE bucket LIKE '%10.31.%') AS limits",
      [P.id],
    );
    check(Object.values(left ?? {}).every((v) => Number(v) === 0), "this run left nothing behind", JSON.stringify(left));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

async function suite(A, H, P) {
  let r;
  let d;

  /* ── The retired devotee inbox ─────────────────────────────────────── */
  section("The devotee inbox, preferences and push devices are retired");
  // They went with devotee sign-in (docs/registration/SPEC.md §1, §6): a
  // family changes nothing online except through the unsubscribe link below.
  const guest = new Client("guest", IP.guest);
  const inbox = seed("inbox", { devotee_id: A.id, category: "booking", priority: "important", title: "E2E-NAPI Booking confirmed", body: "Your abhishekam is confirmed." });
  const retired = [
    ["GET", "/notifications"], ["GET", "/notifications/unread-count"], ["GET", "/notifications/prefs"], ["POST", "/notifications/prefs"],
    ["POST", "/notifications/read"], ["POST", "/notifications/read-all"], ["POST", "/notifications/archive"], ["POST", "/notifications/delete"],
    ["POST", "/notifications/click"], ["POST", "/notifications/devices"], ["DELETE", "/notifications/devices"], ["GET", "/auth/me"], ["GET", "/account/summary"],
  ];
  const answers = [];
  for (const [method, path] of retired) {
    for (const prefix of ["/api", "/api/v1"]) {
      const res = await guest.req(method, prefix + path, method === "GET" ? undefined : { ids: [inbox.id], endpoint: "https://push.example.test/x", channels: { email: false } });
      answers.push({ route: `${method} ${prefix}${path}`, status: res.status });
    }
  }
  check(answers.every((a) => a.status === 404), `all ${answers.length} inbox, preference, device and account routes answer 404 under /api and /api/v1`, JSON.stringify(answers.filter((a) => a.status !== 404)));
  check(guest.cookies.size === 0, "none of them starts a session");
  const inboxRow = one("SELECT read_at, archived_at, deleted_at, show_in_app FROM notifications WHERE id = ?", [inbox.id]);
  check(inboxRow?.read_at === null && inboxRow?.archived_at === null && inboxRow?.deleted_at === null && Number(inboxRow?.show_in_app) === 0, "and the notification they named is untouched and never shown in an app", JSON.stringify(inboxRow));
  check(Number(one("SELECT COUNT(*) AS c FROM notification_deliveries WHERE notification_id = ? AND channel IN ('inapp', 'push')", [inbox.id])?.c) === 0, "no in-app or push delivery exists for it");

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
  const dExt = tExternal.deliveries?.email?.id;
  const dLocal = tLocal.deliveries?.email?.id;
  const dNone = tNone.deliveries?.email?.id;
  const dEmail = emailSend.deliveries?.email?.id;
  check([dExt, dLocal, dNone, dEmail].every((x) => Number.isInteger(x) && x > 0), "each consenting family's news has an email delivery", JSON.stringify([dExt, dLocal, dNone, dEmail]));
  const tk = tokens({ ext: ["c", dExt], local: ["c", dLocal], none: ["c", dNone], open: ["o", dEmail], openAsClick: ["o", dExt], unsub: ["u", A.id], unsubPhone: ["u", P.id], ghost: ["u", 3999999999] });

  r = await t.get(`/api/n/c/${tk.ext}`);
  check(r.status === 302 && r.headers.get("location") === "https://example.org/darshan?x=1", "a click on an https link redirects there", `status ${r.status} ${r.headers.get("location")}`);
  check(r.headers.get("referrer-policy") === "no-referrer", "without leaking the token in a Referer");
  check(/no-store/.test(r.headers.get("cache-control") ?? ""), "and the redirect is not cached", r.headers.get("cache-control"));
  d = one("SELECT status, clicked_at, read_at FROM notification_deliveries WHERE id = ?", [dExt]);
  check(d?.clicked_at !== null && d?.status === "read", "the click is recorded and the email counts as read", JSON.stringify(d));
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
  const openedAt = d?.read_at;
  await sleep(1100);
  await t.get(`/api/n/o/${tk.open}`);
  check(one("SELECT read_at FROM notification_deliveries WHERE id = ?", [dEmail])?.read_at === openedAt, "a second open keeps the first time");
  r = await t.get("/api/n/o/o1.AAAAAAAAAAAAAAAA");
  check(r.status === 200 && r.buf.subarray(0, 6).toString("latin1") === "GIF89a", "an invalid token still gets the GIF");
  r = await t.get(`/api/n/o/${tk.ext}`);
  check(r.status === 200 && r.headers.get("content-type") === "image/gif", "a click token on the pixel URL is still just a GIF");

  section("Unsubscribe");
  const unsubAt = (id = A.id) => one("SELECT unsubscribed_at FROM devotees WHERE id = ?", [id])?.unsubscribed_at ?? null;
  check(unsubAt() === null, "A starts with consent and not unsubscribed");
  r = await t.get(`/api/n/u/${tk.unsub}`);
  check(r.status === 200 && /^text\/html/.test(r.headers.get("content-type") ?? ""), "GET shows a page", `status ${r.status}`);
  check(/<form method="post" action="\/api\/n\/u\//.test(r.text) && /<button type="submit"/.test(r.text), "with a POST button");
  check(r.text.includes("Stop temple updates?") && r.text.includes("கோயில் அறிவிப்புகளை நிறுத்தவா?"), "in both languages");
  check(r.text.includes("Messages about your own seva bookings and donations") && r.text.includes("call the temple office"), "saying booking and donation messages keep coming, and that the office is the way back");
  check(r.text.includes("e***@example.test") && !r.text.includes(A.email), "naming the address only in masked form");
  check(!/<script/i.test(r.text) && !r.text.includes("/account"), "with no JavaScript and no account page");
  check(/default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""), "under a strict Content-Security-Policy");
  check(unsubAt() === null, "GET changed nothing (mail scanners follow links)");
  r = await t.req("HEAD", `/api/n/u/${tk.unsub}`);
  check(r.status === 200 && unsubAt() === null, "nor does HEAD");

  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" } });
  check(r.status === 200 && r.text.includes("Temple updates stopped") && r.text.includes("கோயில் அறிவிப்புகள் நிறுத்தப்பட்டன"), "POST unsubscribes and confirms in both languages", `status ${r.status}`);
  const firstUnsub = unsubAt();
  check(firstUnsub !== null, "unsubscribed_at is set on the registration");
  const news = seed("after-unsub-news", { devotee_id: A.id, category: "festival", priority: "important", channels: ["email", "whatsapp"], title: "E2E-NAPI Festival", body: "x" });
  check(news.deliveries?.email?.reason === "unsubscribed" && news.deliveries?.whatsapp?.reason === "unsubscribed", "festival news is no longer sent, by email or WhatsApp", JSON.stringify(news.deliveries));
  const own = seed("after-unsub-booking", { devotee_id: A.id, category: "booking", priority: "important", channels: ["email", "whatsapp"], title: "E2E-NAPI Booking", body: "x" });
  check(own.deliveries?.email?.status === "queued" && own.deliveries?.whatsapp?.status === "queued", "but the family's own booking message still goes", JSON.stringify(own.deliveries));
  await sleep(1100);
  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check(r.status === 200 && unsubAt() === firstUnsub, "a repeated POST is idempotent (the first time is kept)", `${unsubAt()} vs ${firstUnsub}`);
  r = await t.get(`/api/n/u/${tk.unsub}`);
  check(r.status === 200 && r.text.includes("Temple updates are already stopped") && !/<form/.test(r.text), "GET now says so, with no button");

  // The office gives consent back (Devotees → the registration); a mail provider's RFC 8058 one-click works again.
  sql("UPDATE devotees SET unsubscribed_at = NULL WHERE id = ?", [A.id]);
  const boundary = `napi${RUN}`;
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--${boundary}--\r\n`;
  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: multipart, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
  check(r.status === 200 && unsubAt() !== null, "an RFC 8058 one-click POST (multipart, no cookies) unsubscribes", `status ${r.status}`);

  r = await t.get(`/api/n/u/${tk.unsubPhone}`);
  check(r.status === 200 && r.text.includes("******0033") && !r.text.includes("919876500033"), "a registration without an email is named by its masked phone", r.text.match(/\(([^)]*0033[^)]*)\)/)?.[1] ?? "");
  r = await t.get(`/api/n/u/${badSig.replace(/^c/, "u")}`);
  check(r.status === 404 && /^text\/html/.test(r.headers.get("content-type") ?? "") && r.text.includes("This link is not valid"), "a bad unsubscribe token gets a page saying so (404)", `status ${r.status}`);
  r = await t.req("POST", `/api/n/u/${badSig.replace(/^c/, "u")}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check(r.status === 404, "and POSTing it changes nothing (404)", `status ${r.status}`);
  r = await t.get(`/api/n/u/${tk.ghost}`);
  check(r.status === 404 && r.text.includes("This link is not valid"), "a genuine token for a registration that no longer exists is not valid either", `status ${r.status}`);
  r = await t.req("PUT", `/api/n/u/${tk.unsub}`);
  check(r.status === 405 && r.headers.get("allow") === "GET, HEAD, POST", "other methods are 405 with Allow", `status ${r.status} ${r.headers.get("allow")}`);

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
    r = await hook.post("/api/notify-webhook/webpush", {});
    check(r.status === 404, "the retired push driver has no webhook", `status ${r.status}`);

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
  }

  section("Availability from provider configuration");
  // What the extra server runs with: WhatsApp on Meta with no token, SMS on the test driver.
  const avail = seed(
    "availability",
    { devotee_id: H.id, channels: ["whatsapp", "sms"], category: "booking", priority: "important", title: "E2E-NAPI Availability", body: "x" },
    { NOTIFY_ALLOW_TEST_DRIVER: "1", NOTIFY_SMS_DRIVER: "test", NOTIFY_WHATSAPP_DRIVER: "meta", WHATSAPP_META_TOKEN: "" },
  );
  check(avail.deliveries?.whatsapp?.status === "skipped" && avail.deliveries?.whatsapp?.reason === "not configured", "a driver without credentials is 'not configured' and skipped", JSON.stringify(avail.deliveries?.whatsapp));
  check(avail.deliveries?.sms?.status === "queued", "while a configured one queues", JSON.stringify(avail.deliveries?.sms));

  section("Existing routes");
  r = await g.get("/api/sevas");
  check(r.status === 200 && Array.isArray(r.json), "GET /api/sevas still answers", `status ${r.status}`);
  r = await g.get("/api/no-such-route");
  check(r.status === 404 && r.json?.error === "Not found", "an unknown path is still a JSON 404", `status ${r.status}`);
  r = await g.get("/api/notificationsx/list");
  check(r.status === 404, "a lookalike prefix is not a route either");
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
