import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = `E2E-SUB-${Date.now()}`;
const emailPrefix = prefix.toLowerCase();
const port = Number(process.env.LIVE_SUBS_PORT || 8086);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, NOTIFY_ALLOW_TEST_DRIVER: "1", NOTIFY_EMAIL_DRIVER: "test",
  TRUSTED_PROXIES: "127.0.0.1", SITE_URL: base,
};
const emails = new Set();
const ips = new Set();
let checks = 0;
let log = "";
let server;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
function php(code, args = {}) {
  const result = spawnSync(process.env.PHP_BIN || "php", [
    "-r", `require 'backend/includes/notify.php'; $a=json_decode($argv[1],true); ${code}`, JSON.stringify(args),
  ], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /warning|fatal|SQLSTATE/i);
  return JSON.parse(result.stdout);
}
function sql(query, params = []) {
  return php('$s=getDB()->prepare($a["query"]); $s->execute($a["params"]); echo json_encode($s->fetchAll());', { query, params });
}
function stream(options = {}) {
  const result = spawnSync(process.env.PHP_BIN || "php", [
    "tests/support/live_fixtures.php", "create-stream",
    JSON.stringify({ title_prefix: prefix, label: String(Math.random()).slice(2), status: "SCHEDULED", starts_in_seconds: 120, flags: { notifications: true }, ...options }),
  ], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return JSON.parse(result.stdout.trim());
}
function address(label) {
  const email = `${emailPrefix}-${label}@example.test`;
  emails.add(email);
  return email;
}
async function post(body, ip = `10.88.4.${ips.size + 1}`) {
  ips.add(ip);
  return fetch(`${base}/api/live-subscriptions`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
}
function subscription(s, email) {
  return sql("SELECT * FROM live_stream_subscriptions WHERE live_stream_id=? AND email=?", [s.id, email])[0];
}
function queue(ids) {
  return php('echo json_encode(liveQueueReminders(getDB(), 200, $a["ids"]));', { ids });
}
function notification(id) {
  return sql("SELECT n.*, d.id AS delivery_id FROM notifications n JOIN notification_deliveries d ON d.notification_id=n.id WHERE n.entity_type='live_subscription' AND n.entity_id=? ORDER BY n.id DESC LIMIT 1", [id])[0];
}
function dispatch(id) {
  return php('echo json_encode(notifyDispatchDelivery((int)$a["id"]));', { id });
}
try {
  check(php('echo json_encode(liveSubscriptionsExist());'), "migration 013 available");
  server = spawn(process.env.PHP_BIN || "php", ["-S", `127.0.0.1:${port}`, "router.php"], { cwd: resolve(root, "backend"), env });
  server.stdout.on("data", (data) => { log += data; });
  server.stderr.on("data", (data) => { log += data; });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`${base}/api/live-subscriptions`)).status === 405; } catch {}
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server ready; GET cannot subscribe");
  const s = stream();
  const email = address("primary");
  const body = { slug: s.slug, email, lang: "en", consent: true };
  for (const patch of [{ email: [] }, { email: "not-an-address" }, { email: `${"a".repeat(190)}@test.com` }, { consent: false }, { consent: "yes" }, { slug: [] }, { lang: "zz" }]) {
    check((await post({ ...body, ...patch })).status === 422, `invalid fields rejected: ${Object.keys(patch)}`);
  }
  const bot = address("bot");
  check((await post({ ...body, email: bot, hp_token: "filled" })).status === 201, "honeypot looks successful");
  check(!subscription(s, bot), "honeypot inserts nothing");
  const saved = await post(body);
  check(saved.status === 201, "subscription saved");
  check(!saved.headers.has("set-cookie") && saved.headers.get("cache-control").includes("no-store"), "no cookie or cache");
  check(JSON.stringify(await saved.json()) === '{"success":true}', "response exposes no subscriber identifiers");
  check((await post({ ...body, email: ` ${email.toUpperCase()} ` })).status === 201, "normalized duplicate accepted");
  check(sql("SELECT id FROM live_stream_subscriptions WHERE live_stream_id=?", [s.id]).length === 1, "duplicate has one row");
  for (const opts of [{ status: "DRAFT" }, { status: "COMPLETED" }, { deleted: true }, { flags: { notifications: false } }]) {
    const hidden = stream(opts);
    check((await post({ ...body, email: address(`hidden-${hidden.id}`), slug: hidden.slug })).status === 404, "ineligible stream rejected");
  }
  check((await post({ ...body, email: address("missing"), slug: `${emailPrefix}-missing` })).status === 404, "unknown stream rejected");
  check(queue([s.id]) === 1 && queue([s.id]) === 0, "queue once per subscription/start");
  const sub = subscription(s, email);
  const n = notification(sub.id);
  check(n.lang === "en" && n.cta_url === `/live-darshan/${s.slug}`, "correct language and stream link");
  check(dispatch(n.delivery_id).status === "sent", "test email driver accepts reminder");
  const url = php('echo json_encode(liveSubscriptionUnsubscribeUrl((int)$a["id"]));', { id: sub.id });
  const token = new URL(url).searchParams.get("token");
  check((await fetch(url)).status === 200 && subscription(s, email).unsubscribed_at === null, "GET cannot unsubscribe");
  check((await fetch(url, { method: "HEAD" })).status === 200 && subscription(s, email).unsubscribed_at === null, "HEAD cannot unsubscribe");
  check((await fetch(`${url}0`, { method: "POST" })).status === 404, "tampered token rejected");
  check((await fetch(url, { method: "POST" })).status === 200, "POST unsubscribes");
  const stopped = subscription(s, email).unsubscribed_at;
  check(stopped !== null && (await fetch(url, { method: "POST" })).status === 200, "unsubscribe idempotent");
  check((await post(body)).status === 201 && subscription(s, email).unsubscribed_at === stopped, "public repost cannot restore withdrawn consent");
  const testLog = readFileSync(resolve(root, "backend/logs/notify-test.log"), "utf8");
  check(testLog.includes(token) && testLog.includes(email), "email includes signed unsubscribe link");

  for (const mutation of ["unsubscribe", "cancel", "delete", "disabled", "reschedule", "expired"]) {
    const item = stream();
    const recipient = address(mutation);
    check((await post({ ...body, slug: item.slug, email: recipient, lang: "ta" })).status === 201, `${mutation}: saved`);
    check(queue([item.id]) === 1, `${mutation}: queued`);
    const subscriptionRow = subscription(item, recipient);
    const queued = notification(subscriptionRow.id);
    if (mutation === "unsubscribe") sql("UPDATE live_stream_subscriptions SET unsubscribed_at=UTC_TIMESTAMP() WHERE id=?", [subscriptionRow.id]);
    if (mutation === "cancel") sql("UPDATE live_streams SET status='CANCELLED' WHERE id=?", [item.id]);
    if (mutation === "delete") sql("UPDATE live_streams SET deleted_at=UTC_TIMESTAMP() WHERE id=?", [item.id]);
    if (mutation === "disabled") sql("UPDATE live_streams SET notifications_enabled=0 WHERE id=?", [item.id]);
    if (mutation === "reschedule") sql("UPDATE live_streams SET scheduled_start_at=DATE_ADD(scheduled_start_at, INTERVAL 1 MINUTE) WHERE id=?", [item.id]);
    if (mutation === "expired") sql("UPDATE live_streams SET scheduled_start_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 16 MINUTE) WHERE id=?", [item.id]);
    check(dispatch(queued.delivery_id).status === "skipped", `${mutation}: invalid queued reminder is suppressed`);
    if (mutation === "reschedule") {
      check(queue([item.id]) === 1 && queue([item.id]) === 0, "new scheduled time has one new reminder");
      check(dispatch(notification(subscriptionRow.id).delivery_id).status === "sent", "rescheduled Tamil reminder accepted");
    }
  }
  check(php('$r=["unsubscribed_at"=>null,"deleted_at"=>null,"notifications_enabled"=>1,"status"=>"SCHEDULED","scheduled_start_at"=>"2026-10-01 10:00:00"]; echo json_encode([liveSubscriptionDue($r,"2026-10-01 09:49:59"),liveSubscriptionDue($r,"2026-10-01 09:50:00"),liveSubscriptionDue($r,"2026-10-01 10:15:00"),liveSubscriptionDue($r,"2026-10-01 10:15:01")]);').join() === "false,true,true,false", "UTC reminder boundaries");
  const limitedEmail = address("limit");
  for (let i = 0; i < 5; i++) check((await post({ ...body, email: limitedEmail })).status === 201, "address bucket within limit");
  const limited = await post({ ...body, email: limitedEmail });
  check(limited.status === 429 && Number(limited.headers.get("retry-after")) > 0, "address bucket across IPs");
  const ip = "10.88.4.240";
  for (let i = 0; i < 20; i++) await post({}, ip);
  check((await post({}, ip)).status === 429, "invalid requests spend attempt bucket");
  check(!/PHP (Warning|Fatal|Notice)|SQLSTATE/.test(log), "no PHP or SQL errors");
} finally {
  server?.kill();
  sql("DELETE FROM notifications WHERE entity_type='live_subscription' AND entity_id IN (SELECT q.id FROM live_stream_subscriptions q JOIN live_streams s ON s.id=q.live_stream_id WHERE s.title_en LIKE ?)", [`${prefix}%`]);
  const cleanup = spawnSync(process.env.PHP_BIN || "php", ["tests/support/live_fixtures.php", "cleanup", JSON.stringify({ title_prefix: prefix, ips: [...ips] })], { cwd: root, env, encoding: "utf8" });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  for (const email of emails) sql("DELETE FROM rate_limits WHERE bucket=?", [`live-subscription-address:${createHash("sha256").update(email).digest("hex")}`]);
}
console.log(`\n${checks} checks passed`);
