import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const prefix = `E2E-LDON-${Date.now()}`;
const port = Number(process.env.LIVE_DONATIONS_PORT || 8088);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PAYMENTS_ALLOW_SIMULATOR: "1",
  PAYMENTS_SETTINGS_OVERLAY: JSON.stringify({ enabled: "1", mode: "simulator", international_enabled: "1", currencies: "INR,USD", notify_email: "0", notify_whatsapp: "0", notify_sms: "0" }),
  PAYMENTS_SECRET: `${prefix}-local-testing-only-123456789`, SITE_URL: base, TRUSTED_PROXIES: "127.0.0.1",
  NOTIFY_ALLOW_TEST_DRIVER: "1", NOTIFY_EMAIL_DRIVER: "test", NOTIFY_SMS_DRIVER: "test", NOTIFY_WHATSAPP_DRIVER: "test",
};
const ips = new Set();
let checks = 0, log = "", server;
const check = (condition, label) => { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); };
function php(code, args = {}) {
  const r = spawnSync("php", ["-r", `require 'backend/includes/payments.php'; $a=json_decode($argv[1],true); ${code}`, JSON.stringify(args)], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.doesNotMatch(r.stderr, /warning|fatal|SQLSTATE/i);
  return JSON.parse(r.stdout);
}
function fixture(module, command, args) {
  const r = spawnSync("php", [`tests/support/${module}_fixtures.php`, command, JSON.stringify(args)], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim());
}
function sql(query, params = []) {
  return php('$s=getDB()->prepare($a["query"]); $s->execute($a["params"]); echo json_encode($s->columnCount() ? $s->fetchAll() : []);', { query, params });
}
function stream(opts = {}) {
  return fixture("live", "create-stream", { title_prefix: prefix, label: String(Math.random()).slice(2), status: "LIVE", flags: { donations: true }, ...opts });
}
const body = (s, extra = {}) => ({
  category: "general", amount: "1001", currency: "INR", name: `${prefix} Donor`, phone: "919876543210", phoneCountry: "IN",
  country: "IN", acceptTerms: true, lang: "en", ...(s ? { stream: s.slug } : {}), ...extra,
});
async function post(path, data) {
  const ip = `10.88.7.${ips.size + 1}`;
  ips.add(ip);
  const r = await fetch(`${base}/api/payments/${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(data) });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function totals(s) {
  const r = await fetch(`${base}/api/live-streams/${s.slug}/donations`);
  return { status: r.status, body: await r.json(), headers: r.headers };
}
function paid(s, { amount = "1001", currency = "INR", environment = "production", status = "SUCCESS" } = {}) {
  const f = fixture("payments", "create-donation", body(s, { amount, currency }));
  const row = sql("SELECT * FROM donations WHERE donation_number=?", [f.number])[0];
  const attempt = sql("SELECT * FROM payment_transactions WHERE payable_type='donation' AND payable_id=?", [row.id])[0];
  sql("UPDATE payment_transactions SET environment=? WHERE id=?", [environment, attempt.id]);
  fixture("payments", "apply", { order_id: attempt.order_id, status, facts: { verification: "manual" } });
  return { ...row, attempt };
}
try {
  check(php('echo json_encode(liveDonationsExist(getDB()));'), "migration 014 present");
  server = spawn("php", ["-S", `127.0.0.1:${port}`, "router.php"], { cwd: resolve(root, "backend"), env });
  server.stdout.on("data", (s) => { log += s; });
  server.stderr.on("data", (s) => { log += s; });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { ready = (await fetch(`${base}/api/payments/config`)).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP ready");
  const s = stream();
  check((await totals(s)).body.totals.length === 0, "empty totals");
  for (const value of [[], {}, 123, "not-found", "bad/slug"]) {
    const r = await post("donations", body(s, { stream: value }));
    check(r.status === 422 && r.body.fields.stream, "invalid stream rejected");
  }
  for (const opts of [{ status: "DRAFT" }, { status: "CANCELLED" }, { deleted: true }, { flags: { donations: false } }]) {
    const hidden = stream(opts);
    check((await post("donations", body(hidden))).status === 422, "unavailable stream cannot accept checkout");
    check((await totals(hidden)).status === 404, "unavailable stream hides totals");
  }
  const unlinked = await post("donations", body(null, { live_stream_id: s.id }));
  check(unlinked.body.success, "general donation still works");
  check(sql("SELECT live_stream_id FROM donations WHERE donation_number=?", [unlinked.body.number])[0].live_stream_id === null, "client numeric attribution ignored");
  const r = await post("donations", body(s));
  check(r.body.success && r.body.gateway && !r.headers.has("set-cookie"), "linked cookie-less checkout succeeds");
  const d = sql("SELECT * FROM donations WHERE donation_number=?", [r.body.number])[0];
  check(Number(d.live_stream_id) === s.id, "server-resolved stream id persisted");
  const attempt = sql("SELECT * FROM payment_transactions WHERE payable_type='donation' AND payable_id=?", [d.id])[0];
  fixture("payments", "apply", { order_id: attempt.order_id, status: "FAILED" });
  const retry = await post("retry", { number: r.body.number, token: r.body.token, stream: "hostile-change" });
  check(retry.body.success && sql("SELECT live_stream_id FROM donations WHERE id=?", [d.id])[0].live_stream_id === s.id, "retry retains immutable attribution");
  check(sql("SELECT id FROM donations WHERE donation_number=?", [r.body.number]).length === 1, "retry creates no duplicate payable");
  const race = stream();
  check(php('$v=payValidateDonation($a["body"],payConfig()); getDB()->prepare("UPDATE live_streams SET donations_enabled=0 WHERE id=?")->execute([$a["id"]]); try { payCreateDonation(getDB(),$v["values"],payConfig(),"10.88.7.254"); echo "false"; } catch(LiveDonationUnavailable $e) { echo "true"; }', { body: body(race), id: race.id }), "creation rechecks stream after validation");
  check(sql("SELECT id FROM donations WHERE live_stream_id=?", [race.id]).length === 0, "rejected creation is atomic");
  for (const environment of ["simulator", "test"]) paid(s, { environment });
  for (const status of ["PENDING", "FAILED", "CANCELLED"]) paid(s, { status });
  check((await totals(s)).body.totals.length === 0, "test and unpaid attempts excluded");
  const real = paid(s, { amount: "1001.50" });
  paid(s, { amount: "25.25", currency: "USD" });
  const summary = await totals(s);
  assert.deepEqual(summary.body.totals, [{ currency: "INR", amount: "1001.50", count: 1 }, { currency: "USD", amount: "25.25", count: 1 }]);
  check(summary.headers.get("cache-control") === "no-store", "separate currencies, exact decimals and no cache");
  check(!JSON.stringify(summary.body).includes(prefix) && Object.keys(summary.body).length === 2, "aggregate exposes no donor data");
  fixture("payments", "apply", { order_id: real.attempt.order_id, status: "SUCCESS" });
  check((await totals(s)).body.totals[0].amount === "1001.50", "callback replay cannot inflate total");
  const refund = (amount) => php('$p=payLoadPayableById(getDB(),"donation",$a["id"]); $at=payLoadAttempt(getDB(),$a["attempt"]); echo json_encode(payRefundCreate(getDB(),$p,$at,"partial",$a["amount"],"Local test refund","manual",null,"test"));', { id: real.id, attempt: real.attempt.id, amount });
  check(refund("100.25").ok, "partial refund applied through payment service");
  check((await totals(s)).body.totals[0].amount === "901.25", "completed refund deducted");
  check(refund("901.25").ok, "remaining amount refunded");
  check((await totals(s)).body.totals.length === 1 && (await totals(s)).body.totals[0].currency === "USD", "full refund removes payable from totals");
  const numeric = await fetch(`${base}/api/live-streams/${s.id}/donations`);
  check(numeric.ok, "numeric stream alias works");
  check((await fetch(`${base}/api/live-streams/${s.slug}/donations`, { method: "HEAD" })).status === 200, "HEAD allowed");
  check((await fetch(`${base}/api/live-streams/${s.slug}/donations`, { method: "POST" })).status === 405, "totals read only");
  check(!/Warning:|Fatal error:|Notice:|SQLSTATE/.test(log), "no PHP runtime errors");
  console.log(`${checks} checks passed`);
} finally {
  server?.kill();
  fixture("payments", "cleanup", { name_prefix: prefix, ips: [...ips, "10.88.7.254"] });
  fixture("live", "cleanup", { title_prefix: prefix });
}
