#!/usr/bin/env node
/**
 * tests/notify-links.mjs — the links inside a notification (tracked clicks,
 * the email open pixel, unsubscribe) and the webhook and cron routes, end to
 * end against the real PHP + MySQL stack (docs/notifications/SPEC.md §6.2,
 * §6.6; docs/registration/SPEC.md §6 for consent and unsubscribe).
 *
 *   PHP_BIN=/path/to/php.sh node tests/notify-links.mjs [http://127.0.0.1:8001]
 *
 * Devotee accounts were retired (docs/registration/SPEC.md §1): there is no
 * sign-in, no devotee notification API, no bell, no push. What a family still
 * touches are the links in the messages the temple sends, so that is what this
 * suite proves:
 *   • tracked clicks redirect to the notification's link (a site path on the
 *     site's own address, an https URL as given, nothing → the home page) and
 *     are counted once; a HEAD, a bad signature or an open token pasted into a
 *     click URL records nothing; a click on an email counts as an open;
 *   • the open pixel is a real GIF for every token, genuine or not, and a
 *     genuine one marks the email delivery read;
 *   • unsubscribe: GET (and HEAD) only shows the page — mail scanners follow
 *     links — while the button's POST and an RFC 8058 one-click POST withdraw
 *     the family's consent (devotees.unsubscribed_at, first time kept), after
 *     which temple updates are skipped and booking messages still go; a bad
 *     or orphaned token gets a 404 page, other methods 405;
 *   • retired channels (inapp, push) are dropped before any delivery is made;
 *   • /api/notify-webhook/<driver> and /api/notify-cron reach their endpoints
 *     through api/index.php: a signed provider callback updates a delivery, an
 *     unsigned one is 403; the cron endpoint is 404 without a key, 403 with the
 *     wrong one and runs the worker with the right one;
 *   • channel availability follows the provider configuration ("not
 *     configured" with the event's fallback), and the existing routes still
 *     answer.
 *
 * Registrations are created with tests/support/notify_fixtures.php (the form
 * is rate limited per connection) and messages with its notify command, sent
 * through the test driver. Every request sends its own X-Forwarded-For in
 * 10.31.x.x. A second PHP server on port 8030 runs with the test driver and a
 * cron key; it is stopped at the end.
 *
 * Data: registrations e2e-napi-<run>-*@example.test, dedupe keys
 * e2e:napi:<run>:*. Both are removed at the start (a crashed earlier run) and
 * at the end.
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

const IP = { track: "10.31.4.4", hook: "10.31.5.5" };

/** The test driver, for messages this suite sends itself. */
const TEST_EMAIL = { NOTIFY_EMAIL_DRIVER: "test", NOTIFY_ALLOW_TEST_DRIVER: "1" };
const TEST_SMS = { NOTIFY_SMS_DRIVER: "test", NOTIFY_ALLOW_TEST_DRIVER: "1" };
/** What the second server runs with: SMS through the test driver, WhatsApp on a real driver with no credentials. */
const EXTRA_ENV = {
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_SMS_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "meta",
  WHATSAPP_META_TOKEN: "",
  WHATSAPP_META_PHONE_NUMBER_ID: "",
};

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── PHP ───────────────────────────────────────────────────────────────── */

/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
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

/** notify() through the fixtures CLI; returns the result (id, deliveries per channel). */
function seed(key, n, env) {
  const r = fixtures("notify", { channels: ["email"], category: "general", priority: "normal", ...n, dedupe_key: `${DEDUPE}:${key}` }, env);
  if (!r.result || (!r.result.id && !r.result.deduped)) throw new Error(`seed ${key} failed: ${JSON.stringify(r)}`);
  return r.result;
}
/** notify() for a message that is expected NOT to be created: returns the raw result. */
const tryNotify = (key, n, env) => fixtures("notify", { channels: ["email"], category: "general", priority: "normal", ...n, dedupe_key: `${DEDUPE}:${key}` }, env).result;

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

/* ── A browser-ish client: no session, one address (links are opened from an inbox) ─── */
class Client {
  constructor(label, ip, base = BASE) {
    this.label = label;
    this.ip = ip;
    this.base = base;
  }

  async req(method, path, body, { headers: extra = {}, raw } = {}) {
    const headers = { Accept: "application/json", "X-Forwarded-For": this.ip, ...extra };
    let payload;
    if (raw !== undefined) {
      payload = raw;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload, redirect: "manual" });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* callers assert on json when they expect it */
    }
    return { status: res.status, json, text, buf, headers: res.headers };
  }

  get = (p, opts) => this.req("GET", p, undefined, opts);
  post = (p, b = {}, opts) => this.req("POST", p, b, opts);
}

const delivery = (id) => one("SELECT status, clicked_at, read_at, delivered_at FROM notification_deliveries WHERE id = ?", [id]);
const clicks = (id) => one("SELECT COUNT(*) AS c FROM notification_delivery_events WHERE delivery_id = ? AND event = 'clicked'", [id])?.c;

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
      ...EXTRA_ENV,
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
  // Guest notifications have no registration to cascade from.
  sql("DELETE FROM notifications WHERE dedupe_key LIKE 'e2e:napi:%'");
  fixtures("cleanup", { email_prefix: EMAIL_PREFIX });
  sql("DELETE FROM rate_limits WHERE bucket LIKE '%10.31.%'");
}

/* ── The suite ─────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Notification links — ${BASE} (extra server ${EXTRA})`);
  console.log(`run id ${RUN}\n`);
  cleanup();

  // A registered with an email and ticked the consent box; H registered by phone only.
  const A = createDevotee("a", { phone: "919876500011", consent: true, country: "IN", lang: "en" });
  const H = createDevotee("hook", { phone: "919876500020", consent: true });

  try {
    await suite(A, H);
  } finally {
    stopExtraServer();
    cleanup();
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

async function suite(A, H) {
  /* ── Seed ─────────────────────────────────────────────────────────── */
  section("Seeding");
  const consent = one("SELECT updates_consent_at, unsubscribed_at, email FROM devotees WHERE id = ?", [A.id]);
  check(consent?.updates_consent_at !== null && consent?.unsubscribed_at === null && consent?.email === A.email, "A registered with an email and consent to temple updates", JSON.stringify(consent));

  // Sent now through the test driver, so the deliveries are in the state an
  // opened email is in: sent, not yet read.
  const tExternal = seed("t-ext", { devotee_id: A.id, title: "E2E-NAPI Darshan", body: "Timings.", cta_url: "https://example.org/darshan?x=1", sync: true }, TEST_EMAIL);
  const tNone = seed("t-none", { devotee_id: A.id, title: "E2E-NAPI No link", body: "Nothing to open.", sync: true }, TEST_EMAIL);
  // A guest's booking email: no registration, no consent needed.
  const guestEmail = `${EMAIL_PREFIX}${RUN}-guest@example.test`;
  const tLocal = seed("t-local", { to_email: guestEmail, category: "booking", priority: "important", title: "E2E-NAPI Sevas", body: "Book.", cta_url: "/sevas", sync: true }, TEST_EMAIL);
  const opened = seed("t-open", { devotee_id: A.id, category: "booking", priority: "important", title: "E2E-NAPI Email", body: "An email.", cta_url: "/sevas", sync: true }, TEST_EMAIL);
  // Held until tomorrow: still queued, so no worker sends it meanwhile.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace("T", " ");
  const held = seed("t-held", { devotee_id: A.id, title: "E2E-NAPI Held", body: "Not yet.", cta_url: "/events", deliver_after: tomorrow });

  const sent = { ext: tExternal, none: tNone, local: tLocal, open: opened };
  check(
    Object.values(sent).every((r) => Number.isInteger(r.id) && r.id > 0 && r.deliveries?.email?.status === "sent"),
    "every email was created and sent through the test driver",
    JSON.stringify(Object.fromEntries(Object.entries(sent).map(([k, r]) => [k, r.deliveries]))),
  );
  check(
    Object.values(sent).every((r) => Object.keys(r.deliveries).length === 1) && held.deliveries?.email?.status === "queued",
    "a notification has exactly the channel it asked for, and the held one is queued",
    JSON.stringify(held.deliveries),
  );
  check(one("SELECT devotee_id, recipient_type, to_email FROM notifications WHERE id = ?", [tLocal.id])?.devotee_id === null, "the guest notification has no registration behind it");
  const retired = tryNotify("retired", { devotee_id: A.id, channels: ["inapp", "push"], title: "E2E-NAPI Bell", body: "Nobody's bell." });
  check(retired?.id === null && retired?.skipped === "no channels", "retired channels (inapp, push) are dropped before any delivery is made", JSON.stringify(retired));

  const dExt = tExternal.deliveries.email.id;
  const dLocal = tLocal.deliveries.email.id;
  const dNone = tNone.deliveries.email.id;
  const dEmail = opened.deliveries.email.id;
  const dHeld = held.deliveries.email.id;
  const tk = tokens({
    ext: ["c", dExt], local: ["c", dLocal], none: ["c", dNone], held: ["c", dHeld],
    open: ["o", dEmail], openAsClick: ["o", dExt], unsub: ["u", A.id], ghost: ["u", 3999999999],
  });

  /* ── Tracking links ───────────────────────────────────────────────── */
  section("Tracked clicks");
  const t = new Client("tracker", IP.track); // no session: links are opened from an inbox
  let r = await t.get(`/api/n/c/${tk.ext}`);
  check(r.status === 302 && r.headers.get("location") === "https://example.org/darshan?x=1", "a click on an https link redirects there", `status ${r.status} ${r.headers.get("location")}`);
  check(r.headers.get("referrer-policy") === "no-referrer", "without leaking the token in a Referer");
  check(/no-store/.test(r.headers.get("cache-control") ?? ""), "and the redirect is not cached", r.headers.get("cache-control"));
  let d = delivery(dExt);
  check(d?.clicked_at !== null && d?.status === "read" && d?.read_at !== null, "the click is recorded, and an email click counts as an open (the delivery is read)", JSON.stringify(d));
  check(one("SELECT detail FROM notification_delivery_events WHERE delivery_id = ? AND event = 'read'", [dExt])?.detail === "read (link clicked)", "with the reason on the delivery's history");
  const firstClick = d?.clicked_at;
  await sleep(1100);
  r = await t.get(`/api/n/c/${tk.ext}`);
  check(r.status === 302, "a second click still redirects");
  check(delivery(dExt)?.clicked_at === firstClick && clicks(dExt) === 1, "but clicked_at is set only once");
  r = await t.get(`/api/n/c/${tk.local}`);
  const loc = r.headers.get("location") ?? "";
  check(r.status === 302 && /^https?:\/\/[^/]+\/sevas$/.test(loc), "a site path is redirected to on the site's own address", loc);
  check(delivery(dLocal)?.clicked_at !== null, "a guest's click is recorded too");
  r = await t.req("HEAD", `/api/n/c/${tk.none}`);
  check(r.status === 302, "HEAD answers the redirect", `status ${r.status}`);
  check(delivery(dNone)?.clicked_at === null, "but a link checker's HEAD is not a click");
  r = await t.get(`/api/n/c/${tk.none}`);
  check(r.status === 302 && /^https?:\/\/[^/]+\/$/.test(r.headers.get("location") ?? ""), "no link → the home page", r.headers.get("location"));
  r = await t.get(`/api/n/c/${tk.held}`);
  d = delivery(dHeld);
  check(r.status === 302 && /\/events$/.test(r.headers.get("location") ?? "") && d?.clicked_at !== null && d?.status === "queued" && d?.read_at === null, "a click on a message not yet sent is counted but cannot mark it read", JSON.stringify(d));
  const badSig = `${tk.local.split(".")[0]}.AAAAAAAAAAAAAAAA`;
  sql("UPDATE notification_deliveries SET clicked_at = NULL WHERE id = ?", [dLocal]);
  r = await t.get(`/api/n/c/${badSig}`);
  check(r.status === 302 && /^https?:\/\/[^/]+\/$/.test(r.headers.get("location") ?? ""), "a bad signature → the home page", r.headers.get("location"));
  check(delivery(dLocal)?.clicked_at === null, "and records nothing");
  r = await t.get(`/api/n/c/${tk.openAsClick}`);
  check(r.status === 302 && /\/$/.test(r.headers.get("location") ?? "") && clicks(dExt) === 1, "an open token in a click URL is not a click");
  r = await t.get("/api/n/c/not-a-token");
  check(r.status === 404 && r.json?.error === "Not found", "a malformed token is not a route (404)", `status ${r.status}`);
  r = await t.get(`/api/n/x/${tk.ext}`);
  check(r.status === 404, "nor is an unknown kind", `status ${r.status}`);
  r = await t.get(`/api/n/c/${tk.ext}/extra`);
  check(r.status === 404, "nor a longer path", `status ${r.status}`);
  r = await t.post(`/api/n/c/${tk.ext}`, {});
  check(r.status === 405 && /GET, HEAD/.test(r.headers.get("allow") ?? ""), "a click link only answers GET (405, with Allow)", `status ${r.status}`);

  section("Open pixel");
  r = await t.get(`/api/n/o/${tk.open}`);
  check(r.status === 200 && r.headers.get("content-type") === "image/gif", "the pixel is image/gif", `status ${r.status} ${r.headers.get("content-type")}`);
  check(r.buf.subarray(0, 6).toString("latin1") === "GIF89a" && r.buf.length > 30 && r.buf.length < 64 && r.buf[r.buf.length - 1] === 0x3b, "a real GIF89a file", `${r.buf.length} bytes`);
  check(/no-store/.test(r.headers.get("cache-control") ?? "") && /private/.test(r.headers.get("cache-control") ?? ""), "Cache-Control: no-store, private", r.headers.get("cache-control"));
  d = delivery(dEmail);
  check(d?.status === "read" && d?.read_at !== null && d?.delivered_at !== null, "the email delivery is now read", JSON.stringify(d));
  check(one("SELECT detail FROM notification_delivery_events WHERE delivery_id = ? AND event = 'read'", [dEmail])?.detail === "opened", "recorded as an open");
  const firstOpen = d?.read_at;
  await sleep(1100);
  r = await t.get(`/api/n/o/${tk.open}`);
  check(r.status === 200 && delivery(dEmail)?.read_at === firstOpen, "a second load keeps the first read time");
  r = await t.get("/api/n/o/o1.AAAAAAAAAAAAAAAA");
  check(r.status === 200 && r.buf.subarray(0, 6).toString("latin1") === "GIF89a", "an invalid token still gets the GIF");
  r = await t.get(`/api/n/o/${tk.ext}`);
  check(r.status === 200 && r.headers.get("content-type") === "image/gif", "a click token on the pixel URL is still just a GIF");
  r = await t.post(`/api/n/o/${tk.open}`, {});
  check(r.status === 405, "the pixel only answers GET", `status ${r.status}`);

  section("Unsubscribe");
  const unsubAt = () => one("SELECT unsubscribed_at FROM devotees WHERE id = ?", [A.id])?.unsubscribed_at ?? null;
  check(unsubAt() === null, "A starts subscribed");
  r = await t.get(`/api/n/u/${tk.unsub}`);
  check(r.status === 200 && /^text\/html/.test(r.headers.get("content-type") ?? ""), "GET shows a page", `status ${r.status}`);
  check(/<form method="post" action="\/api\/n\/u\//.test(r.text) && /<button type="submit">/.test(r.text) && r.text.includes('name="List-Unsubscribe" value="One-Click"'), "with a POST button");
  check(r.text.includes("Stop temple updates?") && r.text.includes("கோயில் அறிவிப்புகளை நிறுத்தவா?"), "in both languages");
  check(r.text.includes("e***@example.test") && !r.text.includes(A.email), "naming the address only in masked form");
  check(r.text.includes("seva bookings and donations") && r.text.includes("will still reach you"), "saying which messages still come");
  check(/href="tel:\+91\d+"/.test(r.text) && !/\/account/.test(r.text), "offering the temple office's phone, not a settings link");
  check(!/<script/i.test(r.text), "with no JavaScript");
  check(/default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""), "under a strict Content-Security-Policy");
  check(/no-store/.test(r.headers.get("cache-control") ?? "") && /noindex/.test(r.headers.get("x-robots-tag") ?? ""), "not cached, not indexed");
  check(unsubAt() === null, "GET changed nothing (mail scanners follow links)");
  r = await t.req("HEAD", `/api/n/u/${tk.unsub}`);
  check(r.status === 200 && unsubAt() === null, "nor does HEAD");

  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" } });
  check(r.status === 200 && r.text.includes("Temple updates stopped") && r.text.includes("No more temple updates will be sent to this registration"), "POST unsubscribes and confirms", `status ${r.status}`);
  const firstUnsub = unsubAt();
  check(firstUnsub !== null, "unsubscribed_at is set");
  let row = one("SELECT updates_consent_at, is_active, email, phone, lang FROM devotees WHERE id = ?", [A.id]);
  check(row?.updates_consent_at !== null && row?.is_active === 1 && row?.email === A.email && row?.lang === "en", "without touching the rest of the registration", JSON.stringify(row));
  check(!/<form/.test(r.text) && /href="tel:/.test(r.text), "the confirmation has no button and offers the office's phone to subscribe again");
  const update = tryNotify("after-unsub-update", { devotee_id: A.id, title: "E2E-NAPI Festival", body: "A temple update." });
  check(update?.id > 0 && update?.deliveries?.email?.status === "skipped" && update?.deliveries?.email?.reason === "unsubscribed", "a temple update to A is now skipped as unsubscribed", JSON.stringify(update?.deliveries));
  const booking = tryNotify("after-unsub-booking", { devotee_id: A.id, category: "booking", priority: "important", title: "E2E-NAPI Booking", body: "Your own booking.", deliver_after: tomorrow });
  check(booking?.id > 0 && booking?.deliveries?.email?.status === "queued", "while a message about A's own booking still goes", JSON.stringify(booking?.deliveries));
  await sleep(1100);
  r = await t.req("POST", `/api/n/u/${tk.unsub}`, undefined, { raw: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  check(r.status === 200 && unsubAt() === firstUnsub, "a repeated POST is idempotent (the first time is kept)", `${unsubAt()} vs ${firstUnsub}`);
  r = await t.get(`/api/n/u/${tk.unsub}`);
  check(r.status === 200 && r.text.includes("Temple updates are already stopped") && !/<form/.test(r.text), "GET now says so, with no button");

  // The committee recorded consent again at the office, which clears the withdrawal.
  sql("UPDATE devotees SET updates_consent_at = UTC_TIMESTAMP(), unsubscribed_at = NULL WHERE id = ?", [A.id]);
  check(unsubAt() === null, "consent recorded again: A is subscribed once more");
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
  check(r.status === 404 && r.text.includes("This link is not valid"), "a genuine token for a registration that no longer exists is not valid either", `status ${r.status}`);
  r = await t.get(`/api/n/u/${tk.ext.replace(/^c/, "u")}`);
  check(r.status === 404, "a click token in an unsubscribe URL is not valid", `status ${r.status}`);
  r = await t.req("PUT", `/api/n/u/${tk.unsub}`);
  check(r.status === 405, "other methods are 405", `status ${r.status}`);
  check(unsubAt() !== null && one("SELECT COUNT(*) AS c FROM devotees WHERE email LIKE ?", [`${EMAIL_PREFIX}${RUN}-%`])?.c === 2, "none of that touched a registration");

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
    const hookSend = seed("hook-sms", { devotee_id: H.id, channels: ["sms"], category: "booking", priority: "important", title: "E2E-NAPI SMS", body: "A text.", sync: true }, TEST_SMS);
    const smsId = hookSend.deliveries?.sms?.id;
    check(hookSend.deliveries?.sms?.status === "sent", "an SMS was sent through the test driver", JSON.stringify(hookSend.deliveries));
    const hook = new Client("hook", IP.hook, EXTRA);
    const payload = JSON.stringify({ updates: [{ message_id: `test-${smsId}`, status: "delivered" }] });
    const sig = createHmac("sha256", process.env.NOTIFY_TEST_WEBHOOK_SECRET || "test-webhook-secret").update(payload).digest("hex");
    r = await hook.req("POST", "/api/notify-webhook/test", undefined, { raw: payload, headers: { "Content-Type": "application/json", "X-Test-Signature": "0".repeat(64) } });
    check(r.status === 403 && r.text === "", "a wrong signature is refused with 403 and no body", `status ${r.status} ${r.text.slice(0, 80)}`);
    check(delivery(smsId)?.status === "sent", "and changes nothing");
    r = await hook.req("POST", "/api/notify-webhook/test", undefined, { raw: payload, headers: { "Content-Type": "application/json", "X-Test-Signature": sig } });
    check(r.status === 200 && r.json?.ok === true, "a signed callback reaches notify_webhook.php through api/index.php", `status ${r.status} ${r.text.slice(0, 120)}`);
    check(delivery(smsId)?.status === "delivered", "and the delivery is now delivered");
    r = await hook.post("/api/notify-webhook/twilio", {});
    check(r.status === 404, "a driver no channel uses is 404", `status ${r.status}`);
    r = await hook.get(`/api/n/o/${tokens({ sms: ["o", smsId] }).sms}`);
    check(r.status === 200 && r.headers.get("content-type") === "image/gif" && delivery(smsId)?.status === "delivered", "an open token for an SMS delivery is a GIF that records nothing (only email has a pixel)");

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
    // The same configuration as the second server: WhatsApp on a real driver
    // with no credentials, SMS through the test driver.
    const avail = seed(
      "avail",
      { devotee_id: H.id, channels: ["whatsapp"], fallbacks: { whatsapp: "sms" }, category: "booking", priority: "important", title: "E2E-NAPI Availability", body: "Which channel?", deliver_after: tomorrow },
      EXTRA_ENV,
    );
    check(avail.deliveries?.whatsapp?.status === "skipped" && avail.deliveries?.whatsapp?.reason === "not configured", "a driver without credentials is 'not configured'", JSON.stringify(avail.deliveries));
    check(avail.deliveries?.sms?.status === "queued", "and the event's fallback channel stands in, through the configured driver", JSON.stringify(avail.deliveries));
    const fallbackEvent = one("SELECT detail FROM notification_delivery_events WHERE delivery_id = ? AND event = 'queued'", [avail.deliveries?.sms?.id]);
    check(/instead of whatsapp, which is not configured/.test(fallbackEvent?.detail ?? ""), "with the reason on the delivery's history", JSON.stringify(fallbackEvent));
    r = await hook.post("/api/notify-webhook/meta", { entry: [] });
    check(r.status === 403 && r.text === "", "the webhook route follows the configured driver even before its credentials are set: an unsigned Meta callback is 403, not 404", `status ${r.status}`);
  }

  section("Existing routes");
  r = await g.get("/api/sevas");
  check(r.status === 200 && Array.isArray(r.json), "GET /api/sevas still answers", `status ${r.status}`);
  r = await g.get("/api/no-such-route");
  check(r.status === 404 && r.json?.error === "Not found", "an unknown path is still a JSON 404", `status ${r.status}`);
  r = await g.get("/api/registrations");
  check(r.status === 405, "the registration form still answers (405 for GET)", `status ${r.status}`);
  r = await g.get("/api/nx/c/" + tk.ext);
  check(r.status === 404, "a lookalike prefix is not the links group");
  r = await g.get("/api/notify-webhookx/test");
  check(r.status === 404, "nor the webhook group");
  r = await g.get("/api/notifications/list");
  check(r.status === 404, "the retired devotee notification API is gone");
  r = await g.get("/api/auth/me");
  check(r.status === 404, "and so is devotee sign-in");
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
