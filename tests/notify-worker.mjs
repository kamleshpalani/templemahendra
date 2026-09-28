#!/usr/bin/env node
/**
 * tests/notify-worker.mjs — the Notification Service's queue, worker,
 * campaigns and reminders, end to end through the PHP CLI and MySQL.
 *
 *   PHP_BIN=/path/to/php.sh node tests/notify-worker.mjs
 *
 * PHP_BIN is a wrapper that exports the database environment (DB_*) and
 * NOTIFY_ALLOW_TEST_DRIVER=1; the suite sets every other variable itself. It
 * starts the two PHP servers it needs for /api/notify-cron on ports 8011 and
 * 8012 and stops them at the end.
 *
 * Every provider is the deterministic test driver (contracts.php), which picks
 * its outcome from the recipient ("retry", "flaky", "reject" in an address, or
 * a phone ending 0001) and writes what it would have sent to
 * backend/logs/notify-test.log. Time is moved with the worker's --now instead of
 * sleeping, and every worker run is confined to this suite's notifications or
 * campaigns (--notification-ids / --campaign-id), because other suites share the
 * database.
 *
 * The channels are email, WhatsApp and SMS (docs/registration/SPEC.md §6): the
 * bell and web push were retired with devotee sign-in, and a registered family
 * receives temple updates (announcements, festivals, poojas) only after ticking
 * the consent box, while a message about its own booking always goes.
 *
 * It proves: every channel queues and the worker sends it, with tracked links,
 * an unsubscribe link on every update and none on a booking message; retries
 * back off, fail and die after the channel's attempt limit; a flaky send
 * succeeds on its second attempt; a rejection is permanent; the per-channel
 * throttle holds; a stale "sending" claim is recovered; dedupe keeps one row;
 * secrets are sent synchronously and never stored; skip reasons (no phone, no
 * consent, unsubscribed, SMS restraint, archived) are recorded, also when
 * consent is withdrawn after queueing; campaigns go through approval (no
 * self-approval), expand 600 families across several runs, deliver at each
 * family's own local time, repeat monthly and cancel cleanly; reminders are
 * created once and a reminder approved too late is not sent; provider status
 * updates only move forward; and /api/notify-cron checks its key.
 *
 * Creates registrations as e2e-core-<run>-*@example.test, campaigns named
 * E2E-CORE-<run>…, events, poojas and bookings named E2E-CORE-<run>…, and
 * removes them (and its worker-run and audit rows) at the end.
 */

import { spawnSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const TEST_LOG = resolve(ROOT, "backend/logs/notify-test.log");

const RUN = Date.now().toString(36);
const P = `e2e-core-${RUN}-`;
const TAG = `e2e-core-${RUN}`;
const NAME = `E2E-CORE-${RUN}`;
const XFF = "10.10.0.7";
const PORT_OFF = 8011;
const PORT_ON = 8012;
const CRON_KEY = `e2e-core-cron-${randomBytes(16).toString("hex")}`;
const SITE = "https://temple.example.test";
const START = new Date(Date.now() - 2000).toISOString().slice(0, 19);

const baseEnv = {
  ...process.env,
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_WHATSAPP_DRIVER: "test",
  NOTIFY_SMS_DRIVER: "test",
  SITE_URL: SITE,
  // The environment owner exists, so a campaign's author is never the only
  // owner who could approve it (this hash signs nobody in).
  ADMIN_USERNAME: "admin",
  ADMIN_PASS_HASH: "$2y$10$e2eCoreSuiteOnlyHashThatMatchesNoPasswordAtAllXXXXXXXXXX",
};
for (const k of Object.keys(baseEnv)) {
  if (/^NOTIFY_RATE_|^NOTIFY_CRON_|^NOTIFY_APPROVAL_THRESHOLD$|^NOTIFY_ALLOW_SELF_APPROVAL$/.test(k)) delete baseEnv[k];
}

let passed = 0;
const failures = [];
const runIds = [];

function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (actual, expected, label) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const section = (title) => console.log(`\n── ${title}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ── PHP ───────────────────────────────────────────────────────────────── */

/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

function php(args, env = {}) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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
    throw new Error(`php ${args[0]} ${args[1] ?? ""} printed no JSON (exit ${r.status}): ${r.stdout.slice(-600)} ${r.stderr.slice(-600)}`);
  }
}
const fixtures = (cmd, obj = {}, env) => phpJson(["tests/support/notify_fixtures.php", cmd, arg(obj)], env);
const harness = (cmd, obj = {}, env) => phpJson(["tests/support/notify_core_harness.php", cmd, arg(obj)], env);
function sql(query, params = [], env) {
  const r = fixtures("sql", { query, params }, env);
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}
const one = (query, params) => sql(query, params)[0] ?? null;

function notify(n, env) {
  const r = fixtures("notify", n, env);
  if (r.error) throw new Error(r.error);
  return r.result;
}
function event(name, ctx, env) {
  const r = fixtures("event", { event: name, ctx }, env);
  if (r.error) throw new Error(r.error);
  return r.result;
}

/** One worker run; retried while another suite's run holds the lock. */
function worker(flags, env) {
  for (let i = 0; i < 60; i++) {
    const r = php(["backend/bin/notify_worker.php", "--json", ...flags], env);
    const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`worker printed no JSON (exit ${r.status}): ${r.stdout.slice(-600)} ${r.stderr.slice(-600)}`);
    }
    if (json.error && json.run_id === undefined) throw new Error(`worker failed: ${json.error}`);
    if (json.locked) {
      sleep(500);
      continue;
    }
    if (json.run_id) runIds.push(json.run_id);
    return json;
  }
  throw new Error("the worker lock stayed busy for 30 seconds");
}

const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const future = (seconds) => utc(Date.now() + seconds * 1000);

/** What the test driver "sent" for a delivery, oldest first. */
function sentFor(deliveryId) {
  if (!existsSync(TEST_LOG)) return [];
  return readFileSync(TEST_LOG, "utf8")
    .split("\n")
    .filter((l) => l.includes(`"deliveryId":${deliveryId},`))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.deliveryId === deliveryId && e.at.slice(0, 19) >= START);
}

const delivery = (id) => one("SELECT * FROM notification_deliveries WHERE id = ?", [id]);
const deliveriesOf = (notificationId) =>
  Object.fromEntries(sql("SELECT * FROM notification_deliveries WHERE notification_id = ?", [notificationId]).map((d) => [d.channel, d]));
const eventsOf = (deliveryId) => sql("SELECT event, detail FROM notification_delivery_events WHERE delivery_id = ? ORDER BY id", [deliveryId]);

/** A registered family. Consent to temple updates is given unless the caller says otherwise. */
function devotee(key, extra = {}) {
  const r = fixtures("create-devotee", { email: `${P}${key}@example.test`, name: `E2E Core ${key}`, consent: true, ...extra });
  if (r.error) throw new Error(r.error);
  return r.id;
}

/* ── HTTP servers for /api/notify-cron ─────────────────────────────────── */

const servers = [];
function startServer(port, env) {
  const router = resolve(ROOT, "tests/support/notify_cron_router.php");
  const viaBash = PHP_BIN.endsWith(".sh");
  const args = ["-S", `127.0.0.1:${port}`, "-t", resolve(ROOT, "backend"), router];
  const child = spawn(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: resolve(ROOT, "backend"),
    env: { ...baseEnv, TRUSTED_PROXIES: "127.0.0.1,::1", ...env },
    stdio: "ignore",
  });
  servers.push(child);
  return child;
}
async function waitForServer(port) {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { headers: { "X-Forwarded-For": XFF } });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}
function stopServers() {
  for (const child of servers) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
}
async function cron(port, { method = "GET", key, query = "" } = {}) {
  const headers = { "X-Forwarded-For": XFF, Accept: "application/json" };
  if (key !== undefined) headers["X-Cron-Key"] = key;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/notify-cron${query}`, { method, headers });
    const text = await res.text();
    if (res.status === 409) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* asserted by the caller */
    }
    return { status: res.status, json, text };
  }
  return { status: 409, json: null, text: "lock busy" };
}

/* ── The suite ─────────────────────────────────────────────────────────── */

function cleanup() {
  return harness("cleanup", { email_prefix: "e2e-core-", run_ids: runIds });
}

async function main() {
  const pre = cleanup();
  if (pre.error) throw new Error(`cleanup before the run failed: ${pre.error}`);

  const A = devotee("a", { phone: "919812345670" });
  const RETRY = devotee("retry", { phone: "919812345674" });
  const FLAKY = devotee("flaky");
  const REJECT = devotee("reject");
  const NOPHONE = devotee("nophone");
  const NOCONSENT = devotee("noconsent", { phone: "919812345673", consent: false });
  const UNSUB = devotee("unsub", { phone: "919812345678", unsubscribed: true });
  const SMS = devotee("sms", { phone: "919812345671" });
  const SECRET = devotee("secret", { phone: "919812345672" });
  const IN = devotee("in", { country: "IN", phone: "919812345675" });
  const GB = devotee("gb", { country: "GB", state: "ENG", city: "Leicester", phone: "447700900321", phoneCountry: "GB" });
  const key = (k) => `e2e:core:${RUN}:${k}`;

  /* ── 1 ────────────────────────────────────────────────────────────────── */
  section("Every channel is queued, then the worker sends it");
  const n1 = notify({
    devotee_id: A, template: "announcement", vars: { headline: `${NAME} headline`, message: "The temple will open at 5 am tomorrow." },
    category: "announcement", priority: "important", channels: ["email", "whatsapp", "sms"],
    cta_url: "/events", dedupe_key: key("n1"),
  });
  check(Number.isInteger(n1.id) && !n1.deduped && n1.skipped === null, "notify() creates a notification", JSON.stringify(n1));
  eq(["email", "whatsapp", "sms"].map((c) => n1.deliveries[c]?.status), ["queued", "queued", "queued"], "email, WhatsApp and SMS are queued");
  eq(Object.keys(n1.deliveries), ["email", "whatsapp", "sms"], "no other channel exists");
  const row1 = one("SELECT * FROM notifications WHERE id = ?", [n1.id]);
  check(row1.show_in_app === 0 && row1.deliver_after === null && row1.title.includes(NAME), "the stored copy is in the recipient's language and never flagged for the retired bell", JSON.stringify(row1));
  const w1 = worker([`--notification-ids=${n1.id}`, "--skip-reminders"]);
  eq([w1.claimed, w1.sent, w1.failed], [3, 3, 0], "the worker claims and sends the three queued deliveries");
  const d1 = deliveriesOf(n1.id);
  eq(["email", "whatsapp", "sms"].map((c) => d1[c].status), ["sent", "sent", "sent"], "all three are sent");
  check(d1.email.provider === "test" && d1.email.provider_message_id === `test-${d1.email.id}` && d1.email.attempts === 1, "provider and message id recorded", JSON.stringify(d1.email));
  check(eventsOf(d1.email.id).map((e) => e.event).join(",") === "queued,claimed,sent", "every state change wrote a delivery event", JSON.stringify(eventsOf(d1.email.id)));

  const mail = sentFor(d1.email.id)[0];
  check(mail && mail.html === true && mail.toEmail === `${P}a@example.test` && mail.title === row1.title, "the email has HTML, the address and the rendered subject", JSON.stringify(mail));
  check(/^https:\/\/temple\.example\.test\/api\/n\/c\/c\d+\.[A-Za-z0-9_-]{16}$/.test(mail?.ctaUrl ?? "") && mail.ctaUrl.includes(`/c${d1.email.id}.`), "the email CTA is the tracked link for this delivery", mail?.ctaUrl);
  const unsubscribeUrl = `${SITE}/api/n/u/u${A}.`;
  check((mail?.headers?.["List-Unsubscribe"] ?? "").startsWith(`<${unsubscribeUrl}`) && mail?.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click", "an update's email carries one-click List-Unsubscribe headers", JSON.stringify(mail?.headers));
  eq(mail?.idempotencyKey, `temple-n${n1.id}-email`, "a stable idempotency key is passed to the provider");
  check(mail?.body.includes(`/api/n/c/c${d1.email.id}.`) && mail?.body.includes(unsubscribeUrl), "the plain-text part carries the tracked link and the unsubscribe link");
  const wa = sentFor(d1.whatsapp.id)[0];
  check(wa && wa.toPhone === "919812345670" && wa.buttons.some((b) => b.type === "url" && b.value.includes(`/c${d1.whatsapp.id}.`)), "WhatsApp gets a tracked URL button", JSON.stringify(wa?.buttons));
  check(wa && !wa.buttons.some((b) => b.type === "call"), "no call button on informational news");
  check(wa?.body.includes(unsubscribeUrl), "the WhatsApp text ends with the stop-updates line", wa?.body);
  const sms1 = sentFor(d1.sms.id)[0];
  check(sms1 && sms1.title === "" && sms1.body.length > 0, "the SMS is plain text with no title", JSON.stringify(sms1));
  check(sms1?.body.includes(unsubscribeUrl), "…and carries the stop-updates line too", sms1?.body);

  /* ── 2 ────────────────────────────────────────────────────────────────── */
  section("Transactional messages, links and fallbacks");
  const bookingId = 900000000 + Math.floor(Math.random() * 90000000);
  const conf = event("booking.confirmed", {
    devotee_id: A, entity_id: bookingId, vars: { bookingNumber: `SB-${bookingId}`, sevaName: "Abhishekam", bookingDate: "20 Sep 2031" },
  });
  eq([Object.keys(conf.deliveries), conf.deliveries.email?.status, conf.deliveries.whatsapp?.status], [["email", "whatsapp"], "queued", "queued"], "booking.confirmed uses the catalogue's channels");
  worker([`--notification-ids=${conf.id}`, "--skip-reminders"]);
  const dc = deliveriesOf(conf.id);
  const confMail = sentFor(dc.email.id)[0];
  check(confMail && Array.isArray(confMail.headers) && confMail.headers.length === 0, "a booking email has no List-Unsubscribe header", JSON.stringify(confMail?.headers));
  check(confMail?.ctaUrl?.includes(`/c${dc.email.id}.`), "the booking email CTA is tracked");
  check(confMail && !confMail.body.includes("/api/n/u/"), "and no unsubscribe link: an unsubscribe does not stop a booking message");
  const confWa = sentFor(dc.whatsapp.id)[0];
  check(confWa?.buttons.some((b) => b.type === "call" && b.value === "+919443002296"), "a booking WhatsApp offers a call button to the temple", JSON.stringify(confWa?.buttons));
  check(confWa && !confWa.body.includes("/api/n/u/"), "…and has no stop-updates line");
  const again = event("booking.confirmed", { devotee_id: A, entity_id: bookingId, vars: { bookingNumber: "x", sevaName: "x", bookingDate: "x" } });
  check(again.deduped === true && again.id === conf.id, "confirming the same booking twice notifies once", JSON.stringify(again));

  const noWa = event("booking.confirmed", {
    devotee_id: A, entity_id: bookingId + 1, vars: { bookingNumber: `SB-${bookingId + 1}`, sevaName: "Archana", bookingDate: "21 Sep 2031" },
  }, { NOTIFY_WHATSAPP_DRIVER: "nonexistent" });
  eq([noWa.deliveries.whatsapp?.status, noWa.deliveries.whatsapp?.reason, noWa.deliveries.sms?.status], ["skipped", "not configured", "queued"], "WhatsApp not configured falls back to SMS");
  check(eventsOf(noWa.deliveries.sms.id).some((e) => (e.detail ?? "").includes("instead of whatsapp")), "the fallback is explained in the delivery history");

  const shortSms = notify({ devotee_id: A, title: "E2E", body: "Your seva is confirmed.", category: "booking", priority: "important", channels: ["sms"], cta_url: "/account?tab=bookings", dedupe_key: key("sms-link") });
  const plainSms = notify({ devotee_id: A, title: "E2E", body: "No link in this one.", category: "booking", priority: "important", channels: ["sms"], dedupe_key: key("sms-plain") });
  worker([`--notification-ids=${shortSms.id},${plainSms.id}`, "--skip-reminders"]);
  const linked = sentFor(shortSms.deliveries.sms.id)[0];
  check(linked?.body.startsWith("Your seva is confirmed.\nhttps://temple.example.test/api/n/c/c"), "a short SMS gets the tracked link appended", linked?.body);
  eq(sentFor(plainSms.deliveries.sms.id)[0]?.body, "No link in this one.", "an SMS without a CTA gets no link");

  /* ── 3 ────────────────────────────────────────────────────────────────── */
  section("Retry, backoff, dead, requeue");
  const r1 = notify({ devotee_id: RETRY, title: "E2E retry", body: "Retry me", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("retry") });
  const rid = r1.deliveries.email.id;
  let w = worker([`--notification-ids=${r1.id}`, "--skip-reminders"]);
  eq([w.claimed, w.failed], [1, 1], "the first attempt fails and is counted");
  let rd = one("SELECT status, attempts, max_attempts, failure_reason, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), next_attempt_at) AS wait FROM notification_deliveries WHERE id = ?", [rid]);
  check(rd.status === "failed" && rd.attempts === 1 && rd.max_attempts === 5, "status failed after one of five attempts", JSON.stringify(rd));
  check(rd.wait >= 45 && rd.wait <= 75, "next_attempt_at is about a minute away (60 s ±10%)", String(rd.wait));
  w = worker([`--notification-ids=${r1.id}`, "--skip-reminders"]);
  eq([w.claimed, delivery(rid).attempts], [0, 1], "a failed delivery is not retried before its time");
  const t0 = Date.now();
  for (let k = 1; k <= 4; k++) {
    w = worker([`--notification-ids=${r1.id}`, "--skip-reminders", `--now=${utc(t0 + k * 8 * 3600 * 1000)}`]);
    check(w.claimed === 1, `attempt ${k + 1} is claimed once the clock passes next_attempt_at`, JSON.stringify(w));
  }
  rd = delivery(rid);
  eq([rd.status, rd.attempts, rd.failure_reason, rd.next_attempt_at], ["dead", 5, "simulated transient failure", null], "after five attempts the delivery is dead");
  const rEvents = eventsOf(rid).map((e) => e.event);
  eq([rEvents.filter((e) => e === "failed").length, rEvents.filter((e) => e === "dead").length, rEvents.filter((e) => e === "claimed").length], [4, 1, 5], "four failures, one death and five claims are in the history");
  w = worker([`--notification-ids=${r1.id}`, "--skip-reminders", `--now=${utc(t0 + 100 * 3600 * 1000)}`]);
  eq(w.claimed, 0, "a dead delivery is never claimed again");
  eq(harness("requeue", { id: rid, actor: `${TAG}-owner` }).ok, true, "notifyRequeue puts a dead delivery back");
  rd = delivery(rid);
  eq([rd.status, rd.attempts, rd.failure_reason], ["queued", 0, null], "requeued with attempts reset");
  check(eventsOf(rid).some((e) => e.event === "requeued" && e.detail.includes(`${TAG}-owner`)), "the requeue is in the history with who did it");
  check(one("SELECT COUNT(*) AS n FROM notification_audit WHERE action = 'requeued' AND actor = ?", [`${TAG}-owner`]).n === 1, "and it is audited");
  eq(harness("requeue", { id: d1.email.id, actor: `${TAG}-owner` }).ok, false, "a sent delivery cannot be requeued");

  /* ── 4 ────────────────────────────────────────────────────────────────── */
  section("Flaky and rejected");
  const f1 = notify({ devotee_id: FLAKY, title: "E2E flaky", body: "Second time lucky", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("flaky") });
  worker([`--notification-ids=${f1.id}`, "--skip-reminders"]);
  eq(delivery(f1.deliveries.email.id).status, "failed", "a flaky send fails on attempt 1");
  worker([`--notification-ids=${f1.id}`, "--skip-reminders", `--now=${future(15 * 60)}`]);
  const fd = delivery(f1.deliveries.email.id);
  eq([fd.status, fd.attempts, fd.failure_reason], ["sent", 2, null], "…and is sent on attempt 2");
  eq(sentFor(fd.id).map((e) => e.attempt), [1, 2], "the provider saw attempts 1 and 2");

  const j1 = notify({ devotee_id: REJECT, title: "E2E reject", body: "No", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("reject") });
  w = worker([`--notification-ids=${j1.id}`, "--skip-reminders"]);
  eq([w.rejected, delivery(j1.deliveries.email.id).status, delivery(j1.deliveries.email.id).failure_reason], [1, "rejected", "simulated permanent rejection"], "a rejection is recorded as rejected");
  w = worker([`--notification-ids=${j1.id}`, "--skip-reminders", `--now=${future(2 * 86400)}`]);
  eq([w.claimed, delivery(j1.deliveries.email.id).attempts], [0, 1], "a rejection is never retried");

  /* ── 5 ────────────────────────────────────────────────────────────────── */
  section("Throttle");
  const smsIds = [];
  for (let i = 0; i < 5; i++) {
    smsIds.push(notify({ devotee_id: SMS, title: "E2E", body: `Throttle ${i}`, category: "booking", priority: "important", channels: ["sms"], dedupe_key: key(`throttle-${i}`) }).id);
  }
  const tThrottle = Date.now() + 30 * 60 * 1000;
  const rate = { NOTIFY_RATE_SMS_PER_MIN: "2" };
  w = worker([`--notification-ids=${smsIds.join(",")}`, "--skip-reminders", `--now=${utc(tThrottle)}`], rate);
  eq([w.claimed, w.sent], [2, 2], "NOTIFY_RATE_SMS_PER_MIN=2 sends two");
  const queuedLeft = () => one(`SELECT COUNT(*) AS n FROM notification_deliveries WHERE status = 'queued' AND notification_id IN (${smsIds.join(",")})`).n;
  eq(queuedLeft(), 3, "three wait in the queue");
  w = worker([`--notification-ids=${smsIds.join(",")}`, "--skip-reminders", `--now=${utc(tThrottle + 5000)}`], rate);
  eq(w.claimed, 0, "within the same minute nothing more is sent");
  w = worker([`--notification-ids=${smsIds.join(",")}`, "--skip-reminders", `--now=${utc(tThrottle + 125000)}`], rate);
  eq([w.claimed, queuedLeft()], [2, 1], "a minute later two more go out");

  /* ── 6 ────────────────────────────────────────────────────────────────── */
  section("Stale claims");
  const s1 = notify({ devotee_id: A, title: "E2E stale", body: "x", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("stale") });
  const s2 = notify({ devotee_id: A, title: "E2E fresh claim", body: "x", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("fresh") });
  sql("UPDATE notification_deliveries SET status = 'sending', claim_token = ?, claimed_at = UTC_TIMESTAMP() - INTERVAL 20 MINUTE, attempts = 1 WHERE id = ?", ["e2ecorestale0000000000000000000a", s1.deliveries.email.id]);
  sql("UPDATE notification_deliveries SET status = 'sending', claim_token = ?, claimed_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE, attempts = 1 WHERE id = ?", ["e2ecorefresh000000000000000000ab", s2.deliveries.email.id]);
  w = worker([`--notification-ids=${s1.id},${s2.id}`, "--skip-reminders"]);
  const sd1 = delivery(s1.deliveries.email.id);
  eq([sd1.status, sd1.attempts, sd1.claim_token], ["sent", 2, null], "a claim older than ten minutes is recovered and sent");
  check(eventsOf(sd1.id).some((e) => e.event === "requeued" && e.detail === "worker interrupted"), "the recovery is in the history");
  eq(delivery(s2.deliveries.email.id).status, "sending", "a recent claim is left to the run that holds it");

  /* ── 7 ────────────────────────────────────────────────────────────────── */
  section("Dedupe");
  const dd1 = notify({ devotee_id: A, title: "E2E dedupe", body: "once", channels: ["email"], dedupe_key: key("dedupe") });
  const dd2 = notify({ devotee_id: A, title: "E2E dedupe again", body: "twice", channels: ["email"], dedupe_key: key("dedupe") });
  eq([dd2.deduped, dd2.id, dd2.deliveries.email?.id], [true, dd1.id, dd1.deliveries.email.id], "the same dedupe key returns the existing notification");
  eq(one("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = ?", [key("dedupe")]).n, 1, "and never a second row");

  /* ── 8 ────────────────────────────────────────────────────────────────── */
  section("Secrets travel synchronously and are never stored");
  // No built-in message carries a one-time secret since sign-in was retired, so
  // the rule is proved with a booking number passed through secret_vars.
  const secret = "SB-482913";
  const secretSend = notify({
    devotee_id: SECRET, template: "booking_confirmed", category: "booking", priority: "important", channels: ["sms"],
    vars: { sevaName: "Abhishekam", bookingDate: "20 Sep 2031" }, secret_vars: { bookingNumber: secret }, dedupe_key: key("secret"),
  });
  eq(secretSend.deliveries.sms?.status, "sent", "the SMS is sent inside the call, without the worker");
  const secretRow = one("SELECT title, body, vars FROM notifications WHERE id = ?", [secretSend.id]);
  check(!JSON.stringify(secretRow).includes(secret), "the secret is absent from the stored title, body and vars", JSON.stringify(secretRow));
  // MySQL returns JSON columns re-serialised (with spaces), so compare parsed values.
  eq(JSON.parse(secretRow.vars)._secret, ["bookingNumber"], "the stored vars name the secret without its value");
  check(sentFor(secretSend.deliveries.sms.id)[0]?.body.includes(secret), "the provider received the secret");
  check(!JSON.stringify(sql("SELECT detail FROM notification_delivery_events WHERE delivery_id = ?", [secretSend.deliveries.sms.id])).includes(secret), "the secret is not in the delivery history");
  const secretRetry = notify({
    to_phone: "919812340001", name: "E2E Core guest", template: "booking_confirmed", category: "booking", priority: "important", channels: ["sms"],
    vars: { sevaName: "Archana", bookingDate: "21 Sep 2031" }, secret_vars: { bookingNumber: "SB-111222" }, dedupe_key: key("secret-retry"),
  });
  eq([secretRetry.deliveries.sms?.status, secretRetry.deliveries.sms?.reason], ["dead", "security message not retried"], "a failing secret send is dead, not retried");
  eq(delivery(secretRetry.deliveries.sms.id).next_attempt_at, null, "no retry is scheduled");
  eq(harness("requeue", { id: secretRetry.deliveries.sms.id, actor: `${TAG}-owner` }).ok, false, "a secret message cannot be requeued");
  sql("UPDATE notification_deliveries SET status = 'queued', attempts = 0 WHERE id = ?", [secretRetry.deliveries.sms.id]);
  worker([`--notification-ids=${secretRetry.id}`, "--skip-reminders"]);
  eq([delivery(secretRetry.deliveries.sms.id).status, delivery(secretRetry.deliveries.sms.id).failure_reason], ["dead", "security message not retried"], "the worker refuses to send a secret it never had");

  /* ── 9 ────────────────────────────────────────────────────────────────── */
  section("Skip reasons are recorded");
  const sk = notify({ devotee_id: NOPHONE, title: "E2E skips", body: "x", category: "announcement", priority: "important", channels: ["sms", "whatsapp", "email"], dedupe_key: key("skips") });
  const skd = deliveriesOf(sk.id);
  eq([skd.sms.skip_reason, skd.whatsapp.skip_reason, skd.email.status], ["no phone", "no phone", "queued"], "no phone is stored on the deliveries");
  check(eventsOf(skd.sms.id).some((e) => e.event === "skipped" && e.detail === "no phone"), "…and in their history");
  const guestNews = notify({ to_email: `${P}guest@example.test`, title: "E2E news", body: "x", category: "announcement", priority: "important", channels: ["email"], dedupe_key: key("guest-news") });
  eq([guestNews.deliveries.email?.status, guestNews.deliveries.email?.reason], ["skipped", "no consent"], "a guest never receives temple updates");
  const noConsentNews = notify({ devotee_id: NOCONSENT, title: "E2E news", body: "x", category: "festival", priority: "important", channels: ["email", "whatsapp"], dedupe_key: key("noconsent-news") });
  eq([noConsentNews.deliveries.email?.reason, noConsentNews.deliveries.whatsapp?.reason], ["no consent", "no consent"], "a family that did not tick the box gets no update on any channel");
  const noConsentBooking = notify({ devotee_id: NOCONSENT, title: "E2E booking", body: "x", category: "booking", priority: "important", channels: ["email", "whatsapp"], dedupe_key: key("noconsent-booking") });
  eq([noConsentBooking.deliveries.email?.status, noConsentBooking.deliveries.whatsapp?.status], ["queued", "queued"], "…but a message about its own booking needs no consent");
  const unsubNews = notify({ devotee_id: UNSUB, title: "E2E news", body: "x", category: "festival", priority: "important", channels: ["email", "sms"], dedupe_key: key("unsub-news") });
  eq([unsubNews.deliveries.email?.reason, unsubNews.deliveries.sms?.reason], ["unsubscribed", "unsubscribed"], "an unsubscribed family is skipped with reason unsubscribed");
  eq(notify({ devotee_id: UNSUB, title: "E2E booking", body: "x", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("unsub-booking") }).deliveries.email?.status, "queued", "an unsubscribe does not stop a booking message");
  const routineSms = notify({ devotee_id: A, title: "E2E routine", body: "x", category: "announcement", priority: "normal", channels: ["sms", "whatsapp"], dedupe_key: key("routine-sms") });
  eq([routineSms.deliveries.sms?.reason, routineSms.deliveries.whatsapp?.status], ["sms reserved for important messages", "queued"], "routine news does not go by SMS; WhatsApp still queues");

  // Consent withdrawn while a message waits in the queue still counts at dispatch.
  const LATER = devotee("later", { phone: "919812345677" });
  const laterMail = notify({ devotee_id: LATER, title: "E2E later", body: "x", category: "announcement", priority: "important", channels: ["email"], dedupe_key: key("later-email") });
  const laterWa = notify({ devotee_id: LATER, title: "E2E later festival", body: "x", category: "festival", priority: "important", channels: ["whatsapp"], dedupe_key: key("later-festival") });
  const laterBooking = notify({ devotee_id: LATER, title: "E2E later booking", body: "x", category: "booking", priority: "important", channels: ["email"], dedupe_key: key("later-booking") });
  eq([laterMail.deliveries.email?.status, laterWa.deliveries.whatsapp?.status, laterBooking.deliveries.email?.status], ["queued", "queued", "queued"], "three messages wait in the queue");
  eq(harness("unsubscribe", { devotee_id: LATER }).ok, true, "the family unsubscribes from a link");
  eq(harness("unsubscribe", { devotee_id: LATER }).ok, true, "unsubscribing twice is harmless");
  worker([`--notification-ids=${laterMail.id},${laterWa.id},${laterBooking.id}`, "--skip-reminders"]);
  const lm = delivery(laterMail.deliveries.email.id);
  eq([lm.status, lm.skip_reason], ["skipped", "unsubscribed"], "an update queued before the unsubscribe is not sent");
  check(eventsOf(lm.id).some((e) => e.event === "skipped" && e.detail.includes("consent changed after it was queued")), "the history says consent changed", JSON.stringify(eventsOf(lm.id)));
  eq(sentFor(lm.id).length, 0, "nothing reached the provider");
  eq([delivery(laterWa.deliveries.whatsapp.id).status, delivery(laterWa.deliveries.whatsapp.id).skip_reason], ["skipped", "unsubscribed"], "the same on WhatsApp");
  eq(delivery(laterBooking.deliveries.email.id).status, "sent", "the booking email still goes out");

  // An archived registration receives no more updates, only its own booking messages.
  const heldNews = notify({ devotee_id: NOPHONE, title: "E2E held news", body: "x", category: "announcement", priority: "important", channels: ["email"], dedupe_key: key("held-news") });
  eq(heldNews.deliveries.email?.status, "queued", "control: an update to an open registration is queued");
  sql("UPDATE devotees SET is_active = 0 WHERE id = ?", [NOPHONE]);
  const closedNews = notify({ devotee_id: NOPHONE, title: "E2E news", body: "x", channels: ["email"], dedupe_key: key("closed-news") });
  eq([closedNews.id, closedNews.skipped], [null, "registration archived"], "an archived registration receives no update");
  const closedBooking = notify({ devotee_id: NOPHONE, template: "booking_confirmed", vars: { bookingNumber: "B-000001", sevaName: "Archana", bookingDate: "22 Sep 2031" }, channels: ["email", "whatsapp"], dedupe_key: key("closed-booking") });
  eq([closedBooking.id !== null, closedBooking.deliveries.email?.status], [true, "queued"], "…except a message about its own booking");
  worker([`--notification-ids=${heldNews.id}`, "--skip-reminders"]);
  const hn = delivery(heldNews.deliveries.email.id);
  check(hn.status === "skipped" && hn.skip_reason === "registration archived" && eventsOf(hn.id).some((e) => e.detail?.includes("archived after it was queued")), "an update queued before the archive is not sent", JSON.stringify(hn));
  sql("UPDATE devotees SET is_active = 1 WHERE id = ?", [NOPHONE]);

  /* ── 10 ───────────────────────────────────────────────────────────────── */
  section("Campaign approval, editing and bulk expansion");
  const editor = { username: `${TAG}-editor`, role: "editor" };
  const owner = { username: `${TAG}-owner`, role: "owner" };
  const owner2 = { username: `${TAG}-owner2`, role: "owner" };
  const viewer = { username: `${TAG}-viewer`, role: "viewer" };

  const bulk = harness("bulk-devotees", { prefix: `${P}bulk-`, count: 600, tag: `${TAG}-bulk`, consent: true });
  eq(Number(bulk.n), 600, "600 fixture families with consent exist");
  const translations = {
    ta: { title: `${NAME} அறிவிப்பு`, body: "வணக்கம் {{devoteeName}}, நாளை சிறப்பு பூஜை நடைபெறும்.", cta_label: "நிகழ்வுகள்" },
    en: { title: `${NAME} notice`, body: "Vanakkam {{devoteeName}}, a special pooja is tomorrow.", cta_label: "Events" },
  };
  const bulkInput = {
    name: `${NAME} bulk`, category: "announcement", priority: "normal", channels: ["email"], cta_url: "/events",
    audience: { mode: "rules", match: "all", rules: [{ field: "tag", op: "in", value: [`${TAG}-bulk`] }] }, translations,
  };
  const viewerSave = harness("campaign-save", { input: bulkInput, actor: viewer });
  check(viewerSave.ok === false && viewerSave.errors._, "a viewer cannot save a campaign", JSON.stringify(viewerSave));
  const invalidSave = harness("campaign-save", { input: { name: "", channels: [], translations: { ta: { title: "only a title" } }, cta_url: "javascript:alert(1)" }, actor: editor });
  check(invalidSave.ok === false && ["name", "channels", "audience", "translations.ta.body", "cta_url", "category"].every((k) => invalidSave.errors[k]), "validation names every problem", JSON.stringify(invalidSave.errors));
  const retiredSave = harness("campaign-save", { input: { ...bulkInput, channels: ["inapp", "push"] }, actor: editor });
  check(retiredSave.ok === false && retiredSave.errors.channels, "the retired in-app and push channels are not channels at all", JSON.stringify(retiredSave.errors));
  const saved = harness("campaign-save", { input: bulkInput, actor: owner });
  check(saved.ok && saved.id, "the owner saves a draft", JSON.stringify(saved));
  const CID = saved.id;
  let tr = harness("campaign-transition", { id: CID, action: "submit", actor: owner });
  check(tr.ok && tr.status === "review" && tr.message.includes("Reaches 600 families"), "600 families needs a second approval", JSON.stringify(tr));
  let camp = harness("campaign-get", { id: CID }).campaign;
  eq([camp.requires_approval, camp.estimated_count, camp.approval_reason, camp.submitted_by], [1, 600, "Reaches 600 families", owner.username], "the estimate and reason are stored");
  tr = harness("campaign-transition", { id: CID, action: "approve", actor: editor });
  check(!tr.ok && tr.status === "review", "an editor cannot approve", JSON.stringify(tr));
  tr = harness("campaign-transition", { id: CID, action: "approve", actor: owner });
  check(!tr.ok && tr.message.includes("another owner"), "the author cannot approve their own campaign", JSON.stringify(tr));
  tr = harness("campaign-transition", { id: CID, action: "approve", actor: owner }, { NOTIFY_ALLOW_SELF_APPROVAL: "1" });
  check(tr.ok, "NOTIFY_ALLOW_SELF_APPROVAL=1 permits it", JSON.stringify(tr));
  const editAfter = harness("campaign-save", { id: CID, input: { ...bulkInput, priority: "important" }, actor: editor });
  check(editAfter.ok, "an editor edits the approved campaign", JSON.stringify(editAfter));
  camp = harness("campaign-get", { id: CID }).campaign;
  eq([camp.status, camp.approved_by, camp.requires_approval], ["draft", null, 0], "editing an approved campaign returns it to draft");
  check(one("SELECT COUNT(*) AS n FROM notification_audit WHERE campaign_id = ? AND action = 'edited' AND JSON_EXTRACT(detail, '$.approval_void') = true", [CID]).n === 1, "the voided approval is audited");
  tr = harness("campaign-transition", { id: CID, action: "submit", actor: owner });
  eq(tr.status, "review", "resubmitted");
  tr = harness("campaign-transition", { id: CID, action: "approve", actor: owner2 });
  check(tr.ok && tr.status === "approved", "another owner approves", JSON.stringify(tr));
  tr = harness("campaign-transition", { id: CID, action: "send_now", actor: viewer });
  check(!tr.ok, "a viewer cannot send");
  tr = harness("campaign-transition", { id: CID, action: "send_now", actor: editor });
  eq([tr.ok, tr.status], [true, "sending"], "an editor sends it now");

  const expandFlags = [`--campaign-id=${CID}`, "--expand-limit=250", "--channels=none"];
  const countRun = () => one("SELECT COUNT(*) AS n, COUNT(DISTINCT devotee_id) AS d FROM notifications WHERE campaign_id = ?", [CID]);
  w = worker(expandFlags);
  camp = harness("campaign-get", { id: CID }).campaign;
  check(w.campaigns_expanded === 1 && countRun().n === 250 && camp.status === "sending" && camp.expand_cursor > 0 && camp.started_at, "run 1 expands 250 and remembers where it stopped", JSON.stringify({ w, n: countRun(), cursor: camp.expand_cursor }));
  worker(expandFlags);
  eq(countRun().n, 500, "run 2 continues from the cursor to 500");
  worker(expandFlags);
  camp = harness("campaign-get", { id: CID }).campaign;
  eq([countRun().n, countRun().d, camp.run_count, camp.recipient_count, camp.expand_cursor, camp.next_run_at], [600, 600, 1, 600, 0, null], "run 3 reaches all 600 families exactly once");
  eq(camp.status, "sending", "the campaign is not complete while its emails wait in the queue");
  worker(expandFlags);
  eq(countRun().n, 600, "another run adds nobody");
  w = worker([`--campaign-id=${CID}`], { NOTIFY_RATE_EMAIL_PER_MIN: "1000" });
  eq([w.claimed, w.sent], [600, 600], "a run with room in the email throttle sends all 600");
  const bulkSample = one("SELECT n.title, n.body, n.lang, n.run_no, n.dedupe_key, n.cta_url, d.status FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id WHERE n.campaign_id = ? ORDER BY n.id LIMIT 1", [CID]);
  check(bulkSample.lang === "ta" && bulkSample.title === `${NAME} அறிவிப்பு` && bulkSample.body.startsWith("வணக்கம் E2E Bulk") && bulkSample.run_no === 1
    && bulkSample.dedupe_key.startsWith(`campaign:${CID}:1:`) && bulkSample.cta_url === "/events" && bulkSample.status === "sent", "each family gets the campaign in their language with their name", JSON.stringify(bulkSample));
  worker(expandFlags);
  eq(harness("campaign-get", { id: CID }).campaign.status, "completed", "with every email sent the campaign completes on the next run");
  const stats = harness("campaign-stats", { id: CID });
  eq([stats.recipients, stats.byChannel?.email?.sent], [600, 600], "campaign stats count recipients by channel and status");
  const actions = sql("SELECT action, actor FROM notification_audit WHERE campaign_id = ? ORDER BY id", [CID]).map((a) => `${a.action}:${a.actor}`);
  check(["created:" + owner.username, "submitted:" + owner.username, "approved:" + owner2.username, "sent:" + editor.username, "completed:system"].every((a) => actions.includes(a)), "the audit trail records who did what", JSON.stringify(actions));

  const dup = harness("campaign-transition", { id: CID, action: "duplicate", actor: editor });
  const dupRow = dup.id ? harness("campaign-get", { id: dup.id }).campaign : null;
  check(dup.ok && dupRow?.status === "draft" && dupRow.name === `${NAME} bulk (copy)` && Object.keys(dupRow.translations).join() === "ta,en" && dupRow.recurrence === "none", "duplicate makes a new draft with the same words", JSON.stringify(dup));

  /* ── 11 ───────────────────────────────────────────────────────────────── */
  section("Recipient time zones, test send and preview");
  harness("tag", { devotee_ids: [IN, GB], tag: `${TAG}-tz` });
  const tzAudience = { mode: "rules", match: "all", rules: [{ field: "tag", op: "in", value: [`${TAG}-tz`] }] };
  const tz = harness("campaign-save", {
    input: { name: `${NAME} tz`, category: "announcement", priority: "normal", channels: ["email"], audience: tzAudience, translations, schedule_tz: "recipient" },
    actor: editor,
  });
  tr = harness("campaign-transition", { id: tz.id, action: "submit", actor: editor });
  check(tr.ok && tr.status === "approved", "a small campaign is approved automatically", JSON.stringify(tr));
  check(sql("SELECT actor, detail FROM notification_audit WHERE campaign_id = ? AND action = 'approved'", [tz.id]).some((a) => a.actor === "system" && a.detail.includes("below approval threshold")), "…and the automatic approval is audited");
  tr = harness("campaign-transition", { id: tz.id, action: "schedule", actor: editor, opts: { scheduled_local: "2031-03-10 09:00" } });
  check(tr.ok && tr.status === "scheduled", "scheduled for 09:00 in each family's zone", JSON.stringify(tr));
  camp = harness("campaign-get", { id: tz.id }).campaign;
  eq([camp.scheduled_local, camp.next_run_at, camp.scheduled_at], ["2031-03-10 09:00:00", "2031-03-10 09:00:00", "2031-03-09 19:00:00"], "next_run_at keeps the wall clock; scheduled_at is the earliest instant (UTC+14)");
  w = worker([`--campaign-id=${tz.id}`, "--channels=none"]);
  eq(w.campaigns_expanded, 0, "not due yet in real time");
  w = worker([`--campaign-id=${tz.id}`, "--channels=none", "--now=2031-03-09 20:00:00"]);
  eq(w.campaigns_expanded, 1, "due once the first zone is within 14 hours");
  const tzRows = Object.fromEntries(sql("SELECT devotee_id, deliver_after FROM notifications WHERE campaign_id = ?", [tz.id]).map((r) => [r.devotee_id, r.deliver_after]));
  eq([tzRows[IN], tzRows[GB]], ["2031-03-10 03:30:00", "2031-03-10 09:00:00"], "deliver_after is 09:00 in Kolkata for IN and 09:00 in London for GB");
  const inDel = delivery(one("SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND n.devotee_id = ? AND d.channel = 'email'", [tz.id, IN]).id);
  eq([inDel.status, inDel.next_attempt_at], ["queued", "2031-03-10 03:30:00"], "the email is held until then");
  check(eventsOf(inDel.id).some((e) => e.event === "queued" && e.detail?.startsWith("held until 2031-03-10T03:30:00")), "the hold is in the delivery history", JSON.stringify(eventsOf(inDel.id)));
  worker([`--campaign-id=${tz.id}`, "--now=2031-03-10 04:00:00"]);
  const tzState = () => Object.fromEntries(sql("SELECT n.devotee_id AS k, d.status FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND d.channel = 'email'", [tz.id]).map((r) => [r.k, r.status]));
  let st = tzState();
  eq([st[IN], st[GB]], ["sent", "queued"], "at 09:30 IST the Indian family has it; the London family does not");
  eq(harness("campaign-get", { id: tz.id }).campaign.status, "sending", "the campaign is not complete while deliveries wait");
  worker([`--campaign-id=${tz.id}`, "--now=2031-03-10 09:30:00"]);
  st = tzState();
  eq(st[GB], "sent", "at 09:30 in London the other family has it");
  worker([`--campaign-id=${tz.id}`, "--channels=none", "--now=2031-03-10 09:31:00"]);
  eq(harness("campaign-get", { id: tz.id }).campaign.status, "completed", "completion is detected on a later run");

  const ts = harness("campaign-test-send", { id: tz.id, actor: editor, to: { email: `${P}tester@example.test`, lang: "en" } });
  check(ts.ok && ts.deliveries?.email?.status === "sent", "a test send goes out at once, whatever the campaign's state", JSON.stringify(ts));
  const tsMail = ts.deliveries?.email ? sentFor(ts.deliveries.email.id)[0] : null;
  check(tsMail?.title.startsWith("[TEST] ") && tsMail.toEmail === `${P}tester@example.test`, "the test is titled [TEST] and reaches the typed address although it gave no consent", tsMail?.title);
  eq(harness("campaign-test-send", { id: tz.id, actor: editor, to: { email: `${P}tester@example.test`, lang: "en" } }).deduped, true, "the same test within a minute is not sent twice");
  eq(harness("campaign-test-send", { id: tz.id, actor: viewer, to: { email: `${P}tester@example.test` } }).ok, false, "a viewer cannot send tests");
  check(one("SELECT COUNT(*) AS n FROM notification_audit WHERE campaign_id = ? AND action = 'test_sent'", [tz.id]).n >= 1, "test sends are audited");
  const pvEmail = harness("campaign-preview", { campaign: harness("campaign-get", { id: tz.id }).campaign, channel: "email", lang: "en", sample: GB });
  check(pvEmail.title === `${NAME} notice` && pvEmail.html?.includes("<!DOCTYPE html>") && pvEmail.body.includes("E2E Core gb"), "an email preview renders the HTML with the sample family's name", JSON.stringify({ ...pvEmail, html: pvEmail.html?.length }));
  const pvSms = harness("campaign-preview", { campaign: { translations, template_key: "", category: "announcement", cta_url: "/events" }, channel: "sms", lang: "ta" });
  check(pvSms.sms && pvSms.sms.encoding === "UCS-2" && pvSms.sms.segments >= 1 && pvSms.html === null, "an SMS preview of unsaved input counts characters and segments", JSON.stringify(pvSms.sms));
  check(pvSms.body?.includes("/api/n/u/u0.previewonlylink0"), "the preview shows the stop-updates line with a link that unsubscribes nobody", pvSms.body);

  /* ── 12 ───────────────────────────────────────────────────────────────── */
  section("Recurrence and cancellation");
  harness("tag", { devotee_ids: [IN, GB], tag: `${TAG}-rec` });
  const rec = harness("campaign-save", {
    input: {
      name: `${NAME} monthly`, category: "announcement", priority: "normal", channels: ["email"], translations,
      audience: { mode: "rules", match: "all", rules: [{ field: "tag", op: "in", value: [`${TAG}-rec`] }] },
      scheduled_local: "2031-01-31 10:00", recurrence: "monthly", recur_until: "2031-03-15",
    },
    actor: editor,
  });
  harness("campaign-transition", { id: rec.id, action: "submit", actor: editor });
  check(!harness("campaign-transition", { id: rec.id, action: "send_now", actor: editor }).ok, "a repeating campaign cannot be sent now");
  tr = harness("campaign-transition", { id: rec.id, action: "schedule", actor: editor });
  camp = harness("campaign-get", { id: rec.id }).campaign;
  check(tr.ok && camp.next_run_at === "2031-01-31 04:30:00", "10:00 IST on 31 January is 04:30 UTC", JSON.stringify(camp.next_run_at));
  w = worker([`--campaign-id=${rec.id}`, "--now=2031-01-31 05:00:00"]);
  camp = harness("campaign-get", { id: rec.id }).campaign;
  eq([camp.status, camp.run_count, camp.recipient_count, camp.next_run_at, w.sent], ["scheduled", 1, 2, "2031-02-28 04:30:00", 2], "after run 1 the next run is 28 February (clamped), same wall clock; both emails went in the same run");
  w = worker([`--campaign-id=${rec.id}`, "--now=2031-02-28 05:00:00"]);
  camp = harness("campaign-get", { id: rec.id }).campaign;
  eq([camp.status, camp.run_count, camp.recipient_count, camp.next_run_at, w.sent], ["sending", 2, 4, null, 2], "31 March is after recur_until, so run 2 is the last");
  eq(sql("SELECT run_no, COUNT(*) AS n FROM notifications WHERE campaign_id = ? GROUP BY run_no ORDER BY run_no", [rec.id]).map((r) => [r.run_no, r.n]), [[1, 2], [2, 2]], "each run reached both families once");
  worker([`--campaign-id=${rec.id}`, "--channels=none", "--now=2031-02-28 05:01:00"]);
  eq(harness("campaign-get", { id: rec.id }).campaign.status, "completed", "and it completes once run 2's emails are sent");

  const cancelCamp = harness("campaign-save", {
    input: { name: `${NAME} cancel`, category: "announcement", priority: "normal", channels: ["email", "whatsapp"], audience: tzAudience, translations, schedule_tz: "recipient" },
    actor: editor,
  });
  harness("campaign-transition", { id: cancelCamp.id, action: "submit", actor: editor });
  harness("campaign-transition", { id: cancelCamp.id, action: "schedule", actor: editor, opts: { scheduled_local: "2031-05-10 09:00" } });
  worker([`--campaign-id=${cancelCamp.id}`, "--channels=none", "--now=2031-05-09 20:00:00"]);
  eq(one("SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND d.status = 'queued'", [cancelCamp.id]).n, 4, "four deliveries wait for their local time");
  tr = harness("campaign-transition", { id: cancelCamp.id, action: "cancel", actor: editor });
  check(!tr.ok, "an editor cannot cancel a campaign that is not their own draft", JSON.stringify(tr));
  tr = harness("campaign-transition", { id: cancelCamp.id, action: "cancel", actor: owner });
  check(tr.ok && tr.status === "cancelled" && tr.message.includes("4"), "an owner cancels it", JSON.stringify(tr));
  eq(one("SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND d.status = 'cancelled'", [cancelCamp.id]).n, 4, "every queued delivery is cancelled");
  w = worker([`--campaign-id=${cancelCamp.id}`, "--now=2031-05-10 12:00:00"]);
  eq([w.claimed, w.campaigns_expanded], [0, 0], "a cancelled campaign sends nothing later");
  const draft = harness("campaign-save", { input: { ...bulkInput, name: `${NAME} own draft` }, actor: editor });
  eq(harness("campaign-transition", { id: draft.id, action: "cancel", actor: editor }).status, "cancelled", "an editor may cancel their own draft");

  const urgent = harness("campaign-save", { input: { ...bulkInput, name: `${NAME} urgent`, priority: "urgent", audience: tzAudience }, actor: editor });
  tr = harness("campaign-transition", { id: urgent.id, action: "submit", actor: editor });
  eq([tr.status, harness("campaign-get", { id: urgent.id }).campaign.approval_reason], ["review", "Urgent/emergency priority"], "urgent priority needs approval");
  check(!harness("campaign-transition", { id: urgent.id, action: "reject", actor: owner2 }).ok, "rejecting needs a reason");
  tr = harness("campaign-transition", { id: urgent.id, action: "reject", actor: owner2, opts: { reason: "Too alarming" } });
  eq([tr.ok, tr.status], [true, "draft"], "rejected back to draft");
  const emergency = harness("campaign-save", { input: { ...bulkInput, name: `${NAME} emergency`, priority: "emergency", category: "emergency", audience: tzAudience }, actor: editor });
  check(!harness("campaign-transition", { id: emergency.id, action: "emergency_send", actor: editor, opts: { reason: "Flood" } }).ok, "an editor cannot use emergency send");
  check(!harness("campaign-transition", { id: emergency.id, action: "emergency_send", actor: owner }).ok, "emergency send needs a reason");
  tr = harness("campaign-transition", { id: emergency.id, action: "emergency_send", actor: owner, opts: { reason: "Flood warning for the temple road" } });
  eq([tr.ok, tr.status], [true, "sending"], "an owner sends an emergency straight away");
  check(one("SELECT COUNT(*) AS n FROM notification_audit WHERE campaign_id = ? AND action = 'emergency_override'", [emergency.id]).n === 1, "the override is audited");

  /* ── 13 ───────────────────────────────────────────────────────────────── */
  section("Reminders");
  const tomorrow = "2031-07-15";
  sql("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?, ?, ?, ?, 1)", [`${NAME} நிகழ்வு`, `${NAME} event`, "E2E", tomorrow]);
  sql("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_time, pooja_type, is_active) VALUES (?, ?, ?, '07:00 AM', 'special', 1)", [`${NAME} பூஜை`, `${NAME} pooja`, tomorrow]);
  sql("INSERT INTO seva_bookings (devotee_id, devotee_name, phone, seva_name, preferred_date, status) VALUES (?, ?, '919812345670', 'Abhishekam', ?, 'confirmed')", [A, `${NAME} A`, tomorrow]);
  sql("INSERT INTO seva_bookings (devotee_id, devotee_name, phone, phone_country, seva_name, preferred_date, status) VALUES (NULL, ?, '9812345676', 'IN', 'Archana', ?, 'confirmed')", [`${NAME} guest`, tomorrow]);
  sql("INSERT INTO seva_bookings (devotee_id, devotee_name, phone, seva_name, preferred_date, status) VALUES (?, ?, '919812345670', 'Archana', ?, 'pending')", [A, `${NAME} pending`, tomorrow]);
  const eventId = one("SELECT id FROM events WHERE title_en = ?", [`${NAME} event`]).id;
  const poojaId = one("SELECT id FROM poojas WHERE name_en = ?", [`${NAME} pooja`]).id;
  const bookingIds = sql("SELECT id, status FROM seva_bookings WHERE devotee_name LIKE ?", [`${NAME}%`]);
  const confirmedIds = bookingIds.filter((b) => b.status === "confirmed").map((b) => b.id);
  const reminderFlags = ["--skip-campaigns", "--channels=none"];
  w = worker([...reminderFlags, "--now=2031-07-14 11:00:00"]);
  eq(w.reminders_created, 0, "at 16:30 IST no reminders are made");
  w = worker([...reminderFlags, "--now=2031-07-14 12:00:00"]);
  check(w.reminders_created >= 4, "at 17:30 IST reminders are made", JSON.stringify(w));
  const bookingReminders = () => sql(`SELECT n.entity_id, n.devotee_id, n.recipient_type, n.to_phone, n.dedupe_key, n.event FROM notifications n WHERE n.entity_type = 'seva_booking' AND n.entity_id IN (${bookingIds.map((b) => b.id).join(",")}) ORDER BY n.entity_id`);
  let br = bookingReminders();
  eq(br.map((r) => r.entity_id), confirmedIds, "one booking.reminder per confirmed booking, none for the pending one");
  check(br.every((r) => r.devotee_id === null && r.recipient_type === "guest" && r.event === "booking.reminder" && r.dedupe_key.endsWith(`:reminder:${tomorrow}`))
    && br[0].to_phone === "919812345670" && br[1].to_phone === "919812345676", "each reminder goes to the phone on the booking (with the country code), not to a registration", JSON.stringify(br));
  const remD = deliveriesOf(one("SELECT id FROM notifications WHERE entity_type = 'seva_booking' AND entity_id = ?", [confirmedIds[0]]).id);
  eq([Object.keys(remD).sort(), remD.whatsapp?.status, remD.email?.skip_reason], [["email", "whatsapp"], "queued", "no email"], "the reminder goes by WhatsApp; with no address on the booking, email is skipped");
  const reminderCampaigns = () => sql("SELECT id, name, status, created_by, channels, priority, category, template_key, requires_approval, approval_reason, audience, JSON_UNQUOTE(JSON_EXTRACT(template_vars, '$.reminderKey')) AS rk FROM notification_campaigns WHERE JSON_UNQUOTE(JSON_EXTRACT(template_vars, '$.reminderKey')) IN (?, ?) ORDER BY id", [`event:${eventId}:${tomorrow}`, `pooja:${poojaId}:${tomorrow}`]);
  let rc = reminderCampaigns();
  eq(rc.length, 2, "one automatic campaign for the event and one for the pooja");
  const ev = rc.find((c) => c.rk.startsWith("event:"));
  eq(ev && [ev.name, ev.status, ev.created_by, ev.channels, ev.priority, ev.category, ev.template_key, ev.requires_approval],
    [`Reminder: ${NAME} event (automatic)`, "review", "system", "email,whatsapp", "normal", "event", "event_reminder", 1], "the event reminder campaign waits for the committee's approval, by email and WhatsApp");
  check(ev?.approval_reason.startsWith("Automatic reminder by email and WhatsApp"), "…and says why", ev?.approval_reason);
  const evRule = JSON.parse(ev.audience).rules[0];
  check(evRule.field === "consent" && evRule.op === "is" && evRule.value === true, "its audience is every family that agreed to temple updates", JSON.stringify(evRule));
  eq(rc.find((c) => c.rk.startsWith("pooja:"))?.template_key, "pooja_reminder", "the pooja reminder uses pooja_reminder");
  w = worker([...reminderFlags, "--now=2031-07-14 12:20:00"]);
  br = bookingReminders();
  rc = reminderCampaigns();
  eq([br.length, rc.length], [2, 2], "a second run creates no duplicates");
  tr = harness("campaign-transition", { id: ev.id, action: "approve", actor: owner2 });
  eq([tr.ok, tr.status], [true, "approved"], "an owner approves the event reminder");
  worker([`--campaign-id=${ev.id}`, "--channels=none", "--now=2031-07-15 02:00:00"]);
  const late = one("SELECT status, cancelled_by, last_error FROM notification_campaigns WHERE id = ?", [ev.id]);
  check(late.status === "cancelled" && late.cancelled_by === "system" && late.last_error.includes(tomorrow), "approved only on the day itself, the reminder is cancelled rather than sent", JSON.stringify(late));
  eq(one("SELECT COUNT(*) AS n FROM notifications WHERE campaign_id = ?", [ev.id]).n, 0, "nobody was told \"tomorrow\" about today");

  /* ── 14 ───────────────────────────────────────────────────────────────── */
  section("Provider status updates");
  const pe = d1.email;
  eq(harness("provider-update", { provider: "test", message_id: `test-${pe.id}`, status: "delivered" }).changed, 1, "delivered is applied");
  eq(delivery(pe.id).status, "delivered", "status is delivered");
  check(delivery(pe.id).delivered_at !== null, "delivered_at is set");
  eq(harness("provider-update", { provider: "test", message_id: `test-${pe.id}`, status: "sent" }).changed, 0, "a late 'sent' does not move it backwards");
  eq(harness("provider-update", { provider: "test", message_id: `test-${pe.id}`, status: "read", at: "2026-01-01 00:00:00" }).changed, 1, "read is applied");
  const readRow = delivery(pe.id);
  eq([readRow.status, readRow.read_at], ["read", "2026-01-01 00:00:00"], "read_at takes the provider's time");
  eq(harness("provider-update", { provider: "test", message_id: `test-${pe.id}`, status: "failed", error: "bounced" }).changed, 0, "a failure after delivery changes nothing");
  check(eventsOf(pe.id).some((e) => e.event === "webhook" && e.detail.includes("failed: bounced") && e.detail.includes("ignored")), "…but is kept in the history");
  const waRow = d1.whatsapp;
  eq(harness("provider-update", { provider: "test", message_id: `test-${waRow.id}`, status: "failed", error: "undeliverable to +919812345670" }).changed, 1, "a failure before delivery is applied");
  const waAfter = delivery(waRow.id);
  check(waAfter.status === "rejected" && !waAfter.failure_reason.includes("919812345670"), "it becomes rejected, with the number redacted", JSON.stringify(waAfter));
  eq(harness("provider-update", { provider: "meta", message_id: `test-${d1.sms.id}`, status: "delivered" }).changed, 0, "the provider name must match");
  eq(harness("provider-update", { provider: "test", message_id: "no-such-message", status: "delivered" }).changed, 0, "an unknown message id changes nothing");
  harness("record-open", { id: dc.email.id });
  eq(delivery(dc.email.id).status, "read", "an email open marks the delivery read");
  harness("record-click", { id: dc.whatsapp.id });
  harness("record-click", { id: dc.whatsapp.id });
  const clicked = delivery(dc.whatsapp.id);
  check(clicked.clicked_at && clicked.status === "sent", "a WhatsApp click records the click and leaves reading to the provider's receipts", JSON.stringify(clicked));
  eq(eventsOf(dc.whatsapp.id).filter((e) => e.event === "clicked").length, 1, "a click is recorded once");
  harness("record-click", { id: fd.id });
  check(delivery(fd.id).clicked_at && delivery(fd.id).status === "read", "an email click also proves the email was read", JSON.stringify(delivery(fd.id)));

  /* ── 15 ───────────────────────────────────────────────────────────────── */
  section("/api/notify-cron key handling");
  startServer(PORT_OFF, {});
  startServer(PORT_ON, { NOTIFY_CRON_KEY: CRON_KEY, NOTIFY_CRON_TEST_HOLD_LOCK: "1" });
  check((await waitForServer(PORT_OFF)) && (await waitForServer(PORT_ON)), "both PHP servers started");
  let res = await cron(PORT_OFF, { key: CRON_KEY });
  eq(res.status, 404, "without NOTIFY_CRON_KEY the endpoint is 404");
  res = await cron(PORT_ON);
  eq(res.status, 403, "no key → 403");
  res = await cron(PORT_ON, { key: "wrong-key-wrong-key-wrong-key" });
  eq(res.status, 403, "a wrong header key → 403");
  res = await cron(PORT_ON, { query: "?key=also-wrong-also-wrong-also" });
  eq(res.status, 403, "a wrong ?key= → 403");
  res = await cron(PORT_ON, { key: CRON_KEY });
  check(res.status === 200 && res.json && ["run_id", "claimed", "sent", "failed", "dead", "rejected", "skipped", "campaigns_expanded", "reminders_created", "duration_ms", "locked"].every((k) => k in res.json),
    "the right key → 200 with the worker's counters", `${res.status} ${res.text.slice(0, 300)}`);
  eq(res.json?.locked, true, "the test router held the worker lock, so no shared queue was drained");
  res = await cron(PORT_ON, { method: "POST", query: `?key=${CRON_KEY}` });
  eq(res.status, 200, "POST with ?key= is accepted too");
  res = await cron(PORT_ON, { method: "PUT", key: CRON_KEY });
  eq(res.status, 405, "other methods → 405");
  sql("DELETE FROM rate_limits WHERE bucket = ?", [`notify-cron-denied:${XFF}`]);
}

try {
  await main();
} catch (err) {
  failures.push(`crashed: ${err.message}`);
  console.log(`\n  FAIL the suite crashed: ${err.stack}`);
} finally {
  stopServers();
  try {
    const c = cleanup();
    check(!c.error, "cleanup removed this run's rows", JSON.stringify(c));
    const left = one("SELECT (SELECT COUNT(*) FROM devotees WHERE email LIKE 'e2e-core-%') AS devotees, (SELECT COUNT(*) FROM notification_campaigns WHERE name LIKE 'E2E-CORE-%' OR name LIKE 'Reminder: E2E-CORE-%') AS campaigns, (SELECT COUNT(*) FROM notifications WHERE dedupe_key LIKE 'e2e:core:%') AS notifications, (SELECT COUNT(*) FROM notification_audit WHERE actor LIKE 'e2e-core-%') AS audit");
    eq([Number(left.devotees), Number(left.campaigns), Number(left.notifications), Number(left.audit)], [0, 0, 0, 0], "nothing of this suite is left behind");
  } catch (err) {
    failures.push(`cleanup: ${err.message}`);
    console.log(`  FAIL cleanup — ${err.message}`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failures:\n  - " + failures.join("\n  - "));
  process.exit(1);
}
