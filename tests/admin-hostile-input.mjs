// Hostile-input probe for the admin and the public registration endpoint: posts
// over-length strings, huge numbers, bad dates, arrays where strings belong and
// injection-ish payloads at every write handler, and fails on any 500 / PHP
// fatal / leaked stack trace / reflected script.
//   [PHP_BIN=/path/to/php.sh] node admin-hostile-input.mjs http://127.0.0.1:8050
// Requests carry X-Forwarded-For 10.80.0.210–219 (the server must trust
// 127.0.0.1). The registration it creates to aim the Family Registrations cases
// at is named "E2E-REG-HOST-<run>" and deleted at the end through the page's own
// Delete action; with PHP_BIN set, its rate-limit buckets are removed too.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const base = (process.argv[2] || "http://127.0.0.1:8000").replace(/\/$/, "");
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Deprecated<\/b>)/;
const XFF = "10.80.0.210";
const RUN = Date.now().toString(36);
const REG_NAME = `E2E-REG-HOST-${RUN} Hostile`;
let pass = 0, fail = 0;
const ok = (c, n, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };

let cookie = "";
const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
const get = async (p) => { const r = await fetch(base + p, { headers: { cookie, "X-Forwarded-For": XFF }, redirect: "manual" }); grab(r); return r; };
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { cookie, "X-Forwarded-For": XFF, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b), redirect: "manual" }); grab(r); return r; };
const csrfOf = (h) => /name="_csrf" value="([^"]+)"/.exec(h)?.[1];

const login = await get("/admin/login.php");
await post("/admin/login.php", { _csrf: csrfOf(await login.text()), username: "admin", password: "Admin@Test123" });

const LONG = "ஃ".repeat(600);          // 600 Tamil chars — past every VARCHAR here
const HUGE = "1e30";
const BIGINT = "99999999999999";
const XSS = '"><script>alert(1)</script>';

/* ── The public registration endpoint ───────────────────────────────────── */
// Addresses 10.80.0.211–219 in turn, a few posts each, so the attempt limit
// (15 an hour) never answers before the payload is read.
let regN = 0;
const regIp = () => `10.80.0.${211 + (Math.floor(regN++ / 10) % 9)}`;
async function register(body, label) {
  const r = await fetch(base + "/api/registrations", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Forwarded-For": regIp() },
    body: typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below */ }
  const bad = r.status >= 500 || FATAL.test(text) || json === null || r.headers.get("set-cookie");
  ok(!bad, `/api/registrations survives ${label}`, `status ${r.status}${bad ? " " + text.slice(0, 160) : ""}`);
  return { status: r.status, json, text };
}
const validRegistration = (over = {}) => ({
  name: REG_NAME, phone: "+91 90000 12345", phoneCountry: "IN", email: "", lang: "en", members: [],
  address1: "1 Car Street", city: "Pudupatti", state: "TN", country: "IN", postcode: "627719", consent: false, hp_token: "", ...over,
});
const deep = (n) => { let v = "x"; for (let i = 0; i < n; i++) v = { a: v }; return v; };
// Every field of a registration set to one hostile value. The honeypot stays
// blank so the payload reaches validation instead of the bot answer.
const everyField = (value) => ({ ...Object.fromEntries(Object.keys(validRegistration()).map((k) => [k, value])), hp_token: "" });

// [label, body, isBot]: a bot is answered 201 and saved nothing; anything else
// must be refused, never saved.
const REG_CASES = [
  ["a 600-character Tamil name, email, address and city", validRegistration({ name: LONG, email: LONG, address1: LONG, address2: LONG, city: LONG, state: LONG, postcode: LONG })],
  ["script in every text field", validRegistration({ name: XSS, email: XSS, address1: XSS, city: XSS, state: XSS, country: XSS, postcode: XSS, lang: XSS, dateOfBirth: XSS })],
  ["arrays in every field", everyField([XSS, 1])],
  ["numbers in every field", everyField(Number(BIGINT))],
  ["nested objects in every field", everyField(deep(30))],
  ["null in every field", everyField(null)],
  // Short names: the point is the member limit, not the request size limit.
  ["5,000 members", validRegistration({ members: Array.from({ length: 5000 }, (_, i) => ({ name: `m${i}`, relationship: XSS, age: HUGE })) })],
  ["members of every hostile type", validRegistration({ members: [null, 5, "x", [1, 2], deep(40), { name: [1], relationship: { k: 1 }, age: [12] }, { name: LONG, relationship: "son", age: Number(HUGE) }] })],
  ["impossible dates of birth", validRegistration({ dateOfBirth: "9999-99-99" })],
  ["SQL in the phone and name", validRegistration({ name: "Robert'); DROP TABLE devotees;--", phone: "1' OR '1'='1" })],
  ["a honeypot filled with an array", validRegistration({ hp_token: [XSS] }), true],
  ["a honeypot filled with a number", validRegistration({ hp_token: 7 }), true],
];
for (const [label, body, isBot] of REG_CASES) {
  const r = await register(body, label);
  if (isBot) ok(r.status === 201 && r.text === '{"success":true}', `${label} is answered as a bot`, `status ${r.status}`);
  else if (r.status === 201) ok(false, `${label} was refused, not saved`, "answered 201");
}
await register("[".repeat(2000) + "]".repeat(2000), "JSON nested 2,000 deep");
await register("{\"name\": \"unterminated", "truncated JSON");
await register(new Uint8Array([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]), "bytes that are not UTF-8");
await register(JSON.stringify(validRegistration({ name: "x".repeat(2_000_000) })), "a 2 MB name");

// One real registration for the admin cases below to aim at.
const seeded = await register(validRegistration(), "a valid registration (seeded for the admin cases)");
let regId = 0;
{
  const list = await (await get(`/admin/devotees.php?q=${encodeURIComponent(REG_NAME)}`)).text();
  regId = Number(/devotees\.php\?[^"]*edit=(\d+)/.exec(list.replace(/&amp;/g, "&"))?.[1] ?? 0);
  ok(seeded.status === 201 && regId > 0, "the seeded registration is found in the admin list", `id ${regId}`);
}
const EDIT = `devotees.php?edit=${regId}`;

/* ── Admin write handlers ───────────────────────────────────────────────── */
const CASES = [
  ["sevas.php",            { action: "save", id: "0", name_ta: LONG, name_en: LONG, description: LONG, amount: HUGE, sort_order: BIGINT, is_featured: "1", is_active: "1" }],
  ["sevas.php",            { action: "save", id: "0", name_ta: "x", name_en: "y", amount: "-5", sort_order: "abc" }],
  ["events.php",           { action: "save", id: "0", title_ta: LONG, title_en: LONG, description: LONG, event_date: "9999-99-99", is_active: "1" }],
  ["announcements.php",    { action: "save", id: "0", title: LONG, body: LONG, is_active: "1" }],
  ["poojas.php",           { action: "save", id: "0", name_ta: LONG, name_en: LONG, pooja_date: "not-a-date", pooja_time: LONG, pooja_type: XSS, description_ta: LONG, description_en: LONG, is_active: "1" }],
  ["sponsors.php",         { action: "save", id: "0", name: LONG, phone: LONG, note: LONG, pooja_id: BIGINT, is_active: "1" }],
  ["homepage_widgets.php", { action: "save", id: "0", content_type: XSS, source_type: XSS, title_ta: LONG, title_en: LONG, description_ta: LONG, description_en: LONG, linked_pooja_id: BIGINT, linked_sponsor_id: BIGINT, start_date: "bad", end_date: "bad", priority: BIGINT, is_pinned: "1", is_active: "1" }],
  ["seva_bookings.php",    { action: "bulk_status", "ids[]": BIGINT, status: XSS }],
  ["seva_bookings.php",    { id: BIGINT, status: "pending" }],
  ["contact_messages.php", { action: "delete", id: BIGINT }],
  ["contact_messages.php", { action: "bulk_delete", "ids[]": "abc" }],
  ["settings.php",         { show_pournami_section: "1", bogus_key: "1" }],
  ["gallery.php",          { action: "delete", id: BIGINT }],
  ["users.php",            { action: "save", id: "0", username: LONG, display_name: LONG, email: LONG, phone: LONG, role: XSS, password: LONG } ],
  ["profile.php",          { action: "details", display_name: LONG, email: LONG, phone: LONG }],
  // Family Registrations: every action, aimed at a real registration and at ids that do not exist.
  [EDIT,                   { action: "save", id: String(regId), name: LONG, date_of_birth: "9999-99-99", phone: LONG, phone_country: XSS, email: LONG, lang: XSS,
                             address1: LONG, address2: LONG, city: LONG, state: LONG, country: XSS, postcode: XSS, consent: XSS,
                             "members[0][id]": BIGINT, "members[0][name]": LONG, "members[0][relationship]": XSS, "members[0][age]": HUGE, "members[0][remove]": XSS }],
  [EDIT,                   { action: "save", id: String(regId), name: XSS, "members[0][name][]": "array", "members[1]": "scalar", "members[2][id]": "-7", "members[2][age]": "-1" }],
  [EDIT,                   { action: "save", id: String(regId), members: "not a list" }],
  [EDIT,                   { action: "save", id: BIGINT, name: "Nobody" }],
  [EDIT,                   { action: "merge", id: String(regId), target: BIGINT, fill_empty: XSS }],
  [EDIT,                   { action: "merge", id: String(regId), target: String(regId) }],
  [EDIT,                   { action: "merge", id: String(regId), target: "-1" }],
  [EDIT,                   { action: "not_duplicate", id: BIGINT }],
  [EDIT,                   { action: "archive", id: "abc", return: XSS }],
  [EDIT,                   { action: "restore", id: String(regId), return: "list" }],
  [EDIT,                   { action: "tag_add", id: String(regId), tags: LONG }],
  [EDIT,                   { action: "tag_remove", id: String(regId), tag: XSS }],
  [EDIT,                   { action: XSS, id: String(regId) }],
  [EDIT,                   { action: "delete", id: BIGINT }],
  // Online payments (docs/payments/SPEC.md §10): every write action on the three
  // pages, aimed at numbers, ids and amounts that cannot exist. The settings
  // "save" is probed further down, because it needs the rows snapshotted. The
  // CSRF token is read from the Reconciliation tab, the one view that always
  // carries a form for an owner (the Overview has none).
  ["payments.php?view=reconcile", { action: "resend_receipt", number: XSS }],
  ["payments.php?view=reconcile", { action: "check_now", number: LONG }],
  ["payments.php?view=reconcile", { action: "mark_reviewed", transaction_id: BIGINT, note: LONG }],
  ["payments.php?view=reconcile", { action: "show_pan", number: "DON-99999999-99999999" }],
  ["payments.php?view=reconcile", { action: "refund", number: "DON-20260101-00000001", transaction_id: BIGINT, kind: XSS, amount: HUGE, reason: LONG, method: XSS, gateway_reference: LONG, confirm_manual: XSS }],
  ["payments.php?view=reconcile", { action: "refund_check", refund_id: "abc" }],
  ["payments.php?view=reconcile", { action: "refund_fail", refund_id: BIGINT, reason: XSS }],
  ["payments.php?view=reconcile", { action: "reconcile_csv" }],
  ["payments.php?view=reconcile", { action: XSS, number: LONG }],
  ["payment_settings.php", { action: "test_connection", environment: XSS }],
  ["payment_settings.php", { action: XSS }],
  ["donation_categories.php", { action: "save", id: "0", slug: XSS, name_ta: LONG, name_en: LONG, description_ta: LONG, description_en: LONG, suggested_amount: HUGE, sort_order: BIGINT, is_active: "1" }],
  ["donation_categories.php", { action: "save", id: BIGINT, name_ta: "x", name_en: "y", suggested_amount: "-5", sort_order: "abc" }],
  ["donation_categories.php", { action: "delete", id: BIGINT }],
  ["donation_categories.php", { action: "hide", id: "abc" }],
  ["donation_categories.php", { action: XSS, id: XSS }],
  // Live Darshan (docs/live/SPEC-PHASE1.md §4.2, §4.5): the save form with every field hostile,
  // a delete of an id that cannot exist, an action that is script, and the status buttons.
  ["live_streams.php",     { action: "save", id: "0", title_ta: LONG, title_en: LONG, description_ta: LONG, description_en: LONG, slug: XSS,
                             temple_id: BIGINT, deity_id: BIGINT, event_type: XSS, provider: XSS, provider_reference: XSS,
                             playback_url: "javascript:alert(1)", thumbnail_url: XSS, banner_url: "javascript:alert(1)",
                             scheduled_date: "9999-99-99", start_time: LONG, end_time: "25:61", end_date: "bad", timezone: XSS, status: XSS,
                             is_featured: XSS, show_on_homepage: "1", donations_enabled: LONG, notifications_enabled: "1", sharing_enabled: "1", archive_enabled: "1" }],
  ["live_streams.php",     { action: "save", id: BIGINT, title_ta: "x", title_en: "y", temple_id: "1", status: "LIVE" }],
  ["live_streams.php",     { action: "save", id: "-1", "title_ta[]": "x", "title_en[]": "y", "temple_id[]": "1", "status[]": "LIVE" }],
  ["live_streams.php",     { action: "status", id: BIGINT, status: XSS }],
  ["live_streams.php",     { action: "status", id: "abc", status: "LIVE" }],
  ["live_streams.php",     { action: "delete", id: BIGINT }],
  ["live_streams.php",     { action: "restore", id: BIGINT }],
  ["live_streams.php",     { action: XSS, id: "0" }],
];

for (const [page, body] of CASES) {
  const html = await (await get("/admin/" + page)).text();
  const csrf = csrfOf(html);
  if (!csrf) { console.log(`- ${page}: no form for this account (read-only view) — skipped`); continue; }
  const r = await post("/admin/" + page, { _csrf: csrf, ...body });
  const out = r.status === 303 || r.status === 302 ? "" : await r.text();
  const bad = r.status >= 500 || FATAL.test(out) || out.includes("<script>alert(1)</script>");
  const label = Object.keys(body).slice(0, 3).join(",");
  ok(!bad, `${page} [${label}] survives hostile input`, `status ${r.status}${bad ? " " + (out.match(FATAL)?.[0] ?? "reflected script") : ""}`);
  if (bad) {
    const m = out.match(/(SQLSTATE\[[^\]]+\][^<]{0,140}|Uncaught[^<]{0,140})/);
    if (m) console.log("     →", m[0].replace(/\s+/g, " ").slice(0, 170));
  }
}

// The gateway settings "save" writes the shared payment_settings rows, so it is
// probed only when PHP_BIN lets the rows be snapshotted first and put back after.
if (process.env.PHP_BIN) {
  const PHP_BIN = process.env.PHP_BIN;
  const viaBash = PHP_BIN.endsWith(".sh");
  const fx = (cmd, obj) => {
    const args = ["tests/support/payments_fixtures.php", cmd, JSON.stringify(obj)];
    const res = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
    try { return JSON.parse(res.stdout.trim().split("\n").pop()); } catch { return { error: res.stderr || res.stdout }; }
  };
  const snap = fx("sql", { query: "SELECT k, v, is_secret, updated_by, updated_at FROM payment_settings", params: [] });
  if (!snap.error && (snap.rows ?? []).length > 0) {
    const html = await (await get("/admin/payment_settings.php")).text();
    const csrf = csrfOf(html);
    if (csrf) {
      const r = await post("/admin/payment_settings.php", {
        _csrf: csrf, action: "save", mode: XSS, enabled: XSS, "currencies[]": XSS, default_currency: XSS, international_enabled: XSS,
        donation_min: HUGE, donation_max: "-1", donation_max_foreign: LONG, preset_amounts: LONG, receipt_prefix: XSS, hold_minutes: BIGINT,
        notify_email: XSS, seva_online_enabled: XSS, tested_in_test: XSS,
        "cred[test][merchant_id]": LONG, "cred[production][working_key]": XSS, "cred[production][access_code]": LONG, "remove[production][access_code]": XSS,
      });
      const out = r.status === 303 || r.status === 302 ? "" : await r.text();
      const landing = await (await get("/admin/payment_settings.php")).text();
      const bad = r.status >= 500 || FATAL.test(out) || FATAL.test(landing) || out.includes("<script>alert(1)</script>") || landing.includes("<script>alert(1)</script>");
      ok(!bad, "payment_settings.php [save] survives hostile input", `status ${r.status}${bad ? " " + (out.match(FATAL)?.[0] ?? landing.match(FATAL)?.[0] ?? "reflected script") : ""}`);
    } else {
      console.log("- payment_settings.php [save]: no form for this account — skipped");
    }
    const wipe = fx("sql", { query: "DELETE FROM payment_settings", params: [] });
    let restored = !wipe.error;
    for (const row of snap.rows) {
      const ins = fx("sql", { query: "INSERT INTO payment_settings (k, v, is_secret, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)", params: [row.k, row.v, row.is_secret, row.updated_by, row.updated_at] });
      if (ins.error) restored = false;
    }
    ok(restored, "the payment settings are put back as they were", wipe.error || "");
  } else {
    console.log("- payment_settings.php [save]: skipped (migration 010 not applied, or the fixture could not read the rows)");
  }
} else {
  console.log("- payment_settings.php [save]: skipped (set PHP_BIN so the shared settings can be snapshotted and restored)");
}

// XSS reflection check on search params
for (const page of ["sevas.php", "events.php", "donations.php", "contact_messages.php", "seva_bookings.php", "sponsors.php", "poojas.php", "devotees.php", "payments.php", "donation_categories.php", "live_streams.php"]) {
  const r = await get(`/admin/${page}?q=${encodeURIComponent(XSS)}`);
  const html = await r.text();
  ok(!html.includes("<script>alert(1)</script>"), `${page}: search term is escaped`);
}
for (const query of [`status[]=${encodeURIComponent(XSS)}&sort=${encodeURIComponent(XSS)}&dir=${encodeURIComponent(XSS)}&country=${encodeURIComponent(XSS)}&tag=${encodeURIComponent(XSS)}&page=${BIGINT}`,
                     `edit=${encodeURIComponent(XSS)}`, `edit=${BIGINT}`, `export=csv&q=${encodeURIComponent(XSS)}&status=${encodeURIComponent(XSS)}`, `export=members_csv&sort=${encodeURIComponent(XSS)}`]) {
  const r = await get(`/admin/devotees.php?${query}`);
  const html = await r.text();
  ok(r.status === 200 && !FATAL.test(html) && !html.includes("<script>alert(1)</script>"), `devotees.php?${query.slice(0, 40)}… survives hostile filters`, `status ${r.status}`);
}
for (const query of [`view=transactions&q=${encodeURIComponent(XSS)}&status[]=x&sort=${encodeURIComponent(XSS)}&dir=${encodeURIComponent(XSS)}&country=${encodeURIComponent(XSS)}&purpose=${encodeURIComponent(XSS)}&currency=${encodeURIComponent(XSS)}&kind=${encodeURIComponent(XSS)}&from=9999-99-99&to=${encodeURIComponent(XSS)}&page=${BIGINT}&review[]=1`,
                     `view=${encodeURIComponent(XSS)}`, `number=${encodeURIComponent(XSS)}`, `number[]=1&pan=${encodeURIComponent(XSS)}`, `view=refunds&rstatus=${encodeURIComponent(XSS)}&page=-1`,
                     `view=reconcile&from=${encodeURIComponent(XSS)}&to=${BIGINT}&kind=${encodeURIComponent(XSS)}`, `export=csv&q=${encodeURIComponent(XSS)}&status=${encodeURIComponent(XSS)}`]) {
  const r = await get(`/admin/payments.php?${query}`);
  const html = await r.text();
  ok(r.status === 200 && !FATAL.test(html) && !html.includes("<script>alert(1)</script>"), `payments.php?${query.slice(0, 40)}… survives hostile filters`, `status ${r.status}`);
}
for (const query of [`f=${encodeURIComponent(XSS)}&q=${encodeURIComponent(XSS)}`, `edit=${encodeURIComponent(XSS)}`, `edit=${BIGINT}`, `edit[]=1`]) {
  const r = await get(`/admin/donation_categories.php?${query}`);
  const html = await r.text();
  ok(r.status === 200 && !FATAL.test(html) && !html.includes("<script>alert(1)</script>"), `donation_categories.php?${query.slice(0, 40)}… survives hostile filters`, `status ${r.status}`);
}
for (const query of [`f=${encodeURIComponent(XSS)}&q=${encodeURIComponent(XSS)}&sort=${encodeURIComponent(XSS)}&dir=${encodeURIComponent(XSS)}&page=${BIGINT}`,
                     `edit=${encodeURIComponent(XSS)}`, `edit=${BIGINT}`, `edit[]=1`, `f[]=live&q[]=1&page=-1`]) {
  const r = await get(`/admin/live_streams.php?${query}`);
  const html = await r.text();
  ok(r.status === 200 && !FATAL.test(html) && !html.includes("<script>alert(1)</script>"), `live_streams.php?${query.slice(0, 40)}… survives hostile filters`, `status ${r.status}`);
}

/* ── Cleanup ────────────────────────────────────────────────────────────── */
if (regId > 0) {
  const html = await (await get(`/admin/${EDIT}`)).text();
  const r = await post(`/admin/${EDIT}`, { _csrf: csrfOf(html), action: "delete", id: String(regId) });
  // The list repeats the name once, in the "Deleted the registration of …" message; the row itself must be gone.
  const gone = await (await get(`/admin/devotees.php?q=${encodeURIComponent(REG_NAME)}`)).text();
  ok(r.status === 302 && !gone.includes(`>${REG_NAME}</a>`) && gone.includes("No registrations match these filters"), "the seeded registration is deleted afterwards", `status ${r.status}`);
}
if (process.env.PHP_BIN) {
  const PHP_BIN = process.env.PHP_BIN;
  const viaBash = PHP_BIN.endsWith(".sh");
  const args = ["tests/support/notify_fixtures.php", "sql", JSON.stringify({ query: "DELETE FROM rate_limits WHERE bucket REGEXP ?", params: [":10[.]80[.]0[.]21[0-9]$"] })];
  const res = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });
  ok(res.status === 0 && !/error/.test(res.stdout), "its rate-limit buckets are removed", (res.stderr || res.stdout).slice(0, 160));
} else {
  console.log("- rate-limit buckets for 10.80.0.211–219 were left to expire (set PHP_BIN to remove them)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
