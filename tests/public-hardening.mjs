#!/usr/bin/env node
/**
 * tests/public-hardening.mjs — the public forms, lists and chat against abuse
 * and accidental disclosure, end to end against the real PHP + MySQL stack.
 *
 *   PHP_BIN=/path/to/php.sh node tests/public-hardening.mjs [http://127.0.0.1:8050] [http://127.0.0.1:8051]
 *
 * The first server is an ordinary backend with no GEMINI_API_KEY. The second
 * must be started with GEMINI_API_KEY set to any dummy value and
 * CHAT_AI_DAILY_LIMIT=0; it proves the AI cost cap switches the AI off without
 * a network call. Both need TRUSTED_PROXIES=127.0.0.1,::1 so that each scenario
 * can send its own X-Forwarded-For (10.80.0.100–159) and keep its own
 * rate-limit buckets.
 *
 * What it proves:
 *   1. /api/homepage_widgets never carries a sponsor's phone number, in any card
 *      path (manually linked, calendar-driven, zero-widget fallback).
 *   2. /api/donors lists a pledge only when the donor explicitly agreed.
 *   3. The honeypot answers 201 {"success": true} and saves nothing, on seva
 *      bookings, donations, contact and family registration.
 *   4. Flood limits on seva bookings, donations, contact and family
 *      registration: saved and attempt limits, the 429 shape, per-address
 *      isolation, invalid posts counting as attempts but not saves; and the chat
 *      window limit.
 *   5. CHAT_AI_DAILY_LIMIT=0 answers from the built-in rules at once.
 *   6. The admin donations page: owner and editor can show and hide donors on
 *      the thank-you list (single and bulk), a viewer cannot, every change is
 *      in the activity log, the CSV has the column.
 *
 * Creates rows prefixed "PHT-<run>" (donations, bookings, messages, sponsors,
 * poojas, widgets), family registrations named "E2E-REG-PHT-<run> …" and admin
 * accounts "pht_<run>_*", and removes them, their notifications (where that
 * table exists), activity entries and its rate_limits buckets at the end.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] || "http://127.0.0.1:8050").replace(/\/$/, "");
const AI_BASE = (process.argv[3] || "http://127.0.0.1:8051").replace(/\/$/, "");
const PHP_BIN = process.env.PHP_BIN || "php";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = Date.now().toString(36);
const MARK = `PHT-${RUN}`;
const ADMIN_PREFIX = `pht_${RUN}_`;
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace)/;
// Scenario n speaks from 10.80.0.(100 + n); n stays below 60.
const ip = (n) => `10.80.0.${100 + n}`;
const BUCKETS_REGEXP = ":10[.]80[.]0[.]1[0-5][0-9]$";
const REG_MARK = `E2E-REG-PHT-${RUN}`;

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);

/* ── PHP and SQL helpers ───────────────────────────────────────────────── */
function php(args) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
function fixtures(cmd, obj) {
  const out = php(["tests/support/notify_fixtures.php", cmd, JSON.stringify(obj)]);
  const data = JSON.parse(out.trim().split("\n").pop());
  if (data.error) throw new Error(`fixtures ${cmd}: ${data.error}`);
  return data;
}
const sql = (query, params = []) => fixtures("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;

/* ── HTTP ──────────────────────────────────────────────────────────────── */
async function api(path, { method = "GET", body, xff, base = BASE } = {}) {
  const headers = { "X-Forwarded-For": xff };
  if (body !== undefined) headers["content-type"] = "application/json";
  const started = Date.now();
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json, ms: Date.now() - started };
}
const post = (path, body, xff, base) => api(path, { method: "POST", body, xff, base });

function jar(xff) {
  let cookie = "";
  const grab = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^(PHPSESSID=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
  };
  return {
    async get(path) {
      const r = await fetch(BASE + path, { headers: { cookie, "X-Forwarded-For": xff }, redirect: "manual" });
      grab(r);
      return r;
    },
    async post(path, pairs) {
      const r = await fetch(BASE + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(pairs),
      });
      grab(r);
      return r;
    },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
async function adminLogin(session, username, password) {
  const page = await session.get("/admin/login.php");
  const csrf = csrfOf(await page.text());
  return session.post("/admin/login.php", [["_csrf", csrf], ["username", username], ["password", password], ["next", ""]]);
}

/* ── Cleanup (also run first, so a crashed run leaves nothing behind) ──── */
// No backslashes in these statements: Git Bash strips them from the arguments
// on the way to php.sh, which leaves invalid JSON. Admin names are matched by
// exact prefix instead of an escaped LIKE, since "_" is a LIKE wildcard.
const LIST_ACTIONS = "('donation_list_show', 'donation_list_hide')";
/** True when a table exists. The notification tables are optional (migration 007), and this suite runs without them. */
function hasTable(table) {
  return Number(rows("SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [table])[0].c) > 0;
}
function cleanup(prefixLike, adminPrefix, regPrefixLike) {
  if (hasTable("notifications")) {
    sql("DELETE n FROM notifications n JOIN donations d ON n.entity_type = 'donation' AND n.entity_id = d.id WHERE d.name LIKE ?", [prefixLike]);
    sql("DELETE n FROM notifications n JOIN seva_bookings b ON n.entity_type = 'seva_booking' AND n.entity_id = b.id WHERE b.devotee_name LIKE ?", [prefixLike]);
  }
  // A registration's own notifications cascade with it.
  sql("DELETE FROM devotees WHERE name LIKE ?", [regPrefixLike]);
  sql(`DELETE a FROM admin_activity a JOIN donations d ON a.subject = CONCAT('D-', LPAD(d.id, 6, '0')) WHERE a.action IN ${LIST_ACTIONS} AND d.name LIKE ?`, [prefixLike]);
  sql("DELETE FROM donations WHERE name LIKE ?", [prefixLike]);
  sql("DELETE FROM seva_bookings WHERE devotee_name LIKE ?", [prefixLike]);
  sql("DELETE FROM contact_messages WHERE name LIKE ?", [prefixLike]);
  sql("DELETE FROM homepage_widgets WHERE title_en LIKE ?", [prefixLike]);
  sql("DELETE FROM sponsors WHERE name LIKE ?", [prefixLike]);
  sql("DELETE FROM poojas WHERE name_en LIKE ?", [prefixLike]);
  sql("DELETE FROM admin_activity WHERE LEFT(actor, CHAR_LENGTH(?)) = ? OR LEFT(COALESCE(subject, ''), CHAR_LENGTH(?)) = ?", [adminPrefix, adminPrefix, adminPrefix, adminPrefix]);
  sql("DELETE FROM admin_users WHERE LEFT(username, CHAR_LENGTH(?)) = ?", [adminPrefix, adminPrefix]);
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [BUCKETS_REGEXP]);
}

const probe = await fetch(`${BASE}/api/pulse`).catch(() => null);
if (!probe || !probe.ok) {
  console.log(`✗ no backend at ${BASE}. Start one with serve.sh 8050.`);
  process.exit(1);
}
// Leftovers of earlier runs of this suite, whatever their run id.
cleanup("PHT-%", "pht_", "E2E-REG-PHT-%");

const istToday = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const guest = (label) => `${MARK} ${label}`;
const PHONE = "9000012345";

try {
  /* ── 1. Sponsor phone numbers never reach the homepage ────────────────── */
  section("1. homepage widgets never carry a sponsor's phone");
  const sponsorDigits = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  const tail = sponsorDigits.slice(-7);
  const noPhone = (raw) => !raw.includes(tail) && !/"phone"/i.test(raw) && !/sponsor_phone/i.test(raw);

  // Real rows over HTTP: a pournami today beats every other upcoming pooja, so
  // the calendar-driven card (widget 'calendar' with no pooja) also picks it up.
  sql("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_time, pooja_type, is_active) VALUES (?, ?, ?, '06:00 PM', 'pournami', 1)",
    [`${MARK} பௌர்ணமி`, `${MARK} Pournami`, istToday]);
  const poojaId = Number(rows("SELECT id FROM poojas WHERE name_en = ?", [`${MARK} Pournami`])[0].id);
  sql("INSERT INTO sponsors (name, phone, note, pooja_id, is_active) VALUES (?, ?, ?, ?, 1)",
    [`${MARK} Sponsor`, `+91 ${sponsorDigits.slice(0, 5)} ${sponsorDigits.slice(5)}`, `${MARK} note`, poojaId]);
  const sponsorId = Number(rows("SELECT id FROM sponsors WHERE name = ?", [`${MARK} Sponsor`])[0].id);
  sql("INSERT INTO homepage_widgets (content_type, title_ta, title_en, source_type, linked_pooja_id, linked_sponsor_id, show_sponsor, priority, is_pinned, is_active) VALUES ('sponsor', ?, ?, 'manual', ?, ?, 1, -100000, 1, 1)",
    [`${MARK} கார்டு`, `${MARK} card`, poojaId, sponsorId]);
  // The phone as stored has spaces; look for the digits in either shape.
  const spaced = `${sponsorDigits.slice(0, 5)} ${sponsorDigits.slice(5)}`;
  let r = await api("/api/homepage_widgets", { xff: ip(1) });
  check(r.status === 200 && Array.isArray(r.json), "homepage_widgets answers 200 with a list", r.text.slice(0, 200));
  const mine = (r.json || []).find((w) => w.title_en === `${MARK} card`);
  check(mine?.sponsor?.name === `${MARK} Sponsor`, "the linked sponsor card shows the sponsor's name", JSON.stringify(mine));
  check(mine?.sponsor?.note === `${MARK} note`, "the linked sponsor card keeps the dedication note", JSON.stringify(mine?.sponsor));
  check(mine && Object.keys(mine.sponsor || {}).sort().join(",") === "name,note", "the sponsor object holds only name and note", JSON.stringify(mine?.sponsor));
  check(noPhone(r.text) && !r.text.includes(spaced), "the raw response contains no phone digits and no phone key");

  for (const scenario of ["manual", "calendar", "fallback"]) {
    const out = php(["tests/support/public_hardening_widgets.php", scenario, JSON.stringify({ prefix: `${MARK}-${scenario}`, phone: sponsorDigits })]);
    const { raw } = JSON.parse(out.trim().split("\n").pop());
    let widgets = null;
    try { widgets = JSON.parse(raw); } catch { /* reported below */ }
    const sponsored = (widgets || []).filter((w) => w.sponsor?.name === `${MARK}-${scenario} Sponsor`);
    check(sponsored.length > 0, `${scenario} path: a card carries the sponsor`, raw.slice(0, 300));
    check(noPhone(raw), `${scenario} path: no phone digits or phone key anywhere in the body`, raw.slice(0, 300));
  }
  const leftover = rows("SELECT COUNT(*) c FROM sponsors WHERE name LIKE ?", [`${MARK}-%`])[0].c;
  check(Number(leftover) === 0, "the card-path harness left no rows behind (its transaction rolled back)");

  /* ── 2. Donor consent ─────────────────────────────────────────────────── */
  section("2. the thank-you list needs the donor's consent");
  const consentCases = [
    ["true", true, true], ["1", 1, true], ['"1"', "1", true], ['"true"', "true", true],
    ["false", false, false], ['"false"', "false", false], ["missing", undefined, false], ["an array", [true], false],
    ['"yes"', "yes", false],
  ];
  for (const [i, [label, value, listed]] of consentCases.entries()) {
    const body = { name: guest(`consent ${label}`), phone: PHONE, phoneCountry: "IN", amount: 101, purpose: "annadanam" };
    if (value !== undefined) body.showNamePublicly = value;
    // Two addresses, so nine pledges stay inside the eight-saved limit.
    r = await post("/api/donations", body, ip(i < 5 ? 2 : 3));
    check(r.status === 201 && r.json?.id > 0, `pledge with showNamePublicly ${label} is accepted`, r.text);
    const flag = rows("SELECT show_name_publicly f FROM donations WHERE id = ?", [r.json?.id ?? 0])[0]?.f;
    check(Number(flag) === (listed ? 1 : 0), `showNamePublicly ${label} stores ${listed ? 1 : 0}`, `stored ${flag}`);
  }
  sql("INSERT INTO donations (name, phone, amount, purpose) VALUES (?, ?, 55, 'other')", [guest("consent legacy"), PHONE]);
  const legacyFlag = rows("SELECT show_name_publicly f FROM donations WHERE name = ?", [guest("consent legacy")])[0].f;
  check(Number(legacyFlag) === 0, "a row inserted without the column defaults to not shown");

  r = await api("/api/donors", { xff: ip(1) });
  check(r.status === 200 && Array.isArray(r.json), "donors answers 200 with a list");
  const names = new Set((r.json || []).map((d) => d.name));
  for (const [label, , listed] of consentCases) {
    check(names.has(guest(`consent ${label}`)) === listed, `donors ${listed ? "lists" : "does not list"} the pledge with ${label}`);
  }
  check(!names.has(guest("consent legacy")), "donors does not list a row that never gave consent");
  const donorItem = (r.json || []).find((d) => d.name === guest("consent true"));
  check(donorItem && Object.keys(donorItem).sort().join(",") === "label,name,type" && donorItem.type === "donor",
    "a donor item keeps the old shape (name, label, type) and no amount or phone", JSON.stringify(donorItem));
  check(!r.text.includes(PHONE), "donors never contains a donor's phone");

  /* ── 3. Honeypot ──────────────────────────────────────────────────────── */
  section("3. the honeypot");
  // A complete, valid family registration (docs/registration/SPEC.md §5).
  const registration = (name, over = {}) => ({
    name, phone: PHONE, phoneCountry: "IN", email: "", lang: "en", members: [], address1: "1 Car Street",
    city: "Pudupatti", state: "TN", country: "IN", postcode: "627719", consent: true, hp_token: "", ...over,
  });
  const honey = [
    ["/api/seva-bookings", { devotee_name: guest("honey"), phone: PHONE, phoneCountry: "IN", seva_name: "Archana", hp_token: "http://spam.example" }, "SELECT COUNT(*) c FROM seva_bookings WHERE devotee_name = ?", "seva-booking", guest("honey")],
    ["/api/donations", { name: guest("honey"), phone: PHONE, amount: 500, hp_token: " x " }, "SELECT COUNT(*) c FROM donations WHERE name = ?", "donation", guest("honey")],
    ["/api/contact", { name: guest("honey"), phone: PHONE, message: "Hello", hp_token: "filled" }, "SELECT COUNT(*) c FROM contact_messages WHERE name = ?", "contact", guest("honey")],
    ["/api/registrations", registration(`${REG_MARK} honey`, { members: [{ name: "K. Meena", relationship: "spouse", age: 40 }], hp_token: "http://spam.example" }), "SELECT COUNT(*) c FROM devotees WHERE name = ?", "registration", `${REG_MARK} honey`],
  ];
  for (const [path, body, countSql, bucket, savedName] of honey) {
    r = await post(path, body, ip(4));
    check(r.status === 201 && r.text.trim() === '{"success":true}', `${path} honeypot hit answers 201 with exactly {"success":true}`, `${r.status} ${r.text}`);
    check(Number(rows(countSql, [savedName])[0].c) === 0, `${path} honeypot hit saves nothing`);
    const b = rows("SELECT bucket, hits FROM rate_limits WHERE bucket IN (?, ?)", [`${bucket}-attempt:${ip(4)}`, `${bucket}-saved:${ip(4)}`]);
    check(b.length === 1 && b[0].bucket.startsWith(`${bucket}-attempt`) && Number(b[0].hits) === 1, `${path} honeypot hit counts as an attempt, not a save`, JSON.stringify(b));
  }
  // Blank or whitespace honeypot is a person: saved as normal.
  r = await post("/api/contact", { name: guest("honey blank"), phone: PHONE, message: "Hello", hp_token: "   " }, ip(5));
  check(r.status === 201 && Number(rows("SELECT COUNT(*) c FROM contact_messages WHERE name = ?", [guest("honey blank")])[0].c) === 1,
    "a whitespace-only honeypot is treated as a real message", r.text);
  if (hasTable("notifications")) {
    const honeyNotified = rows("SELECT COUNT(*) c FROM notifications n JOIN donations d ON n.entity_type='donation' AND n.entity_id=d.id WHERE d.name = ?", [guest("honey")])[0].c;
    check(Number(honeyNotified) === 0, "a honeypot hit triggers no notification");
  } else {
    console.log("- no notifications table: the honeypot's no-notification check does not apply");
  }

  /* ── 4. Flood limits ──────────────────────────────────────────────────── */
  // invalidStatus: what a post that fails validation answers before the limit
  // bites; countSql and nameOf find a submission by the name it was sent with.
  const forms = [
    {
      path: "/api/seva-bookings", bucket: "seva-booking", saved: 8, attempts: 20, ips: [10, 11, 12], invalidStatus: 400,
      countSql: "SELECT COUNT(*) c FROM seva_bookings WHERE devotee_name = ?", nameOf: (n) => guest(`flood ${n}`),
      valid: (n) => ({ devotee_name: guest(`flood ${n}`), phone: PHONE, phoneCountry: "IN", seva_name: "Archana" }),
      invalid: () => ({ devotee_name: "", phone: PHONE, seva_name: "Archana" }),
    },
    {
      path: "/api/donations", bucket: "donation", saved: 8, attempts: 20, ips: [20, 21, 22], invalidStatus: 400,
      countSql: "SELECT COUNT(*) c FROM donations WHERE name = ?", nameOf: (n) => guest(`flood ${n}`),
      valid: (n) => ({ name: guest(`flood ${n}`), phone: PHONE, amount: 21 }),
      invalid: () => ({ name: guest("flood bad"), phone: PHONE, amount: -5 }),
    },
    {
      path: "/api/contact", bucket: "contact", saved: 5, attempts: 15, ips: [30, 31, 32], invalidStatus: 400,
      countSql: "SELECT COUNT(*) c FROM contact_messages WHERE name = ?", nameOf: (n) => guest(`flood ${n}`),
      valid: (n) => ({ name: guest(`flood ${n}`), phone: PHONE, message: "Vanakkam" }),
      invalid: () => ({ name: guest("flood bad"), phone: "12", message: "Vanakkam" }),
    },
    {
      // The registration answers 422 with its field errors, and a family saved
      // with a number already on file is still a save.
      path: "/api/registrations", bucket: "registration", saved: 10, attempts: 15, ips: [55, 56, 57], invalidStatus: 422,
      countSql: "SELECT COUNT(*) c FROM devotees WHERE name = ?", nameOf: (n) => `${REG_MARK} flood ${n}`,
      valid: (n) => registration(`${REG_MARK} flood ${n}`, { consent: false }),
      invalid: () => registration(`${REG_MARK} flood bad`, { postcode: "" }),
    },
  ];
  const is429 = (res) => {
    const ra = Number(res.headers.get("retry-after"));
    return res.status === 429 && Number.isInteger(ra) && ra > 0
      && res.json?.error === "Too many requests. Please try again later."
      && res.json?.code === "rate_limited" && res.json?.retryAfter === ra;
  };
  for (const f of forms) {
    section(`4. flood limits: ${f.path}`);
    const [a, b, c] = f.ips.map(ip);
    let codes = [];
    for (let i = 1; i <= f.saved; i++) codes.push((await post(f.path, f.valid(`${f.bucket} ${i}`), a)).status);
    check(codes.every((s) => s === 201), `${f.saved} valid submissions from one address are saved`, codes.join(","));
    r = await post(f.path, f.valid(`${f.bucket} over`), a);
    check(is429(r), `submission ${f.saved + 1} is refused with 429, Retry-After, code and retryAfter`, `${r.status} ${r.headers.get("retry-after")} ${r.text}`);
    const overSaved = rows(f.countSql, [f.nameOf(`${f.bucket} over`)])[0].c;
    check(Number(overSaved) === 0, "the refused submission was not saved");

    // Attempts so far: saved + 1. Invalid posts use up the rest of the attempts.
    codes = [];
    for (let i = f.saved + 2; i <= f.attempts; i++) codes.push((await post(f.path, f.invalid(), a)).status);
    check(codes.length > 0 && codes.every((s) => s === f.invalidStatus), `invalid posts up to attempt ${f.attempts} are answered ${f.invalidStatus}, not 429`, codes.join(","));
    r = await post(f.path, f.invalid(), a);
    check(is429(r), `attempt ${f.attempts + 1} is refused with 429 even though it is invalid`, `${r.status} ${r.text}`);

    r = await post(f.path, f.valid(`${f.bucket} other address`), b);
    check(r.status === 201, "a different address is unaffected", `${r.status} ${r.text}`);

    codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(f.path, f.invalid(), c)).status);
    const att = rows("SELECT hits FROM rate_limits WHERE bucket = ?", [`${f.bucket}-attempt:${c}`])[0]?.hits;
    const sav = rows("SELECT hits FROM rate_limits WHERE bucket = ?", [`${f.bucket}-saved:${c}`])[0]?.hits;
    check(codes.every((s) => s === f.invalidStatus) && Number(att) === 4 && sav === undefined, "invalid submissions count as attempts but not as saves", `codes ${codes} attempts ${att} saved ${sav}`);
    r = await post(f.path, f.valid(`${f.bucket} after invalid`), c);
    const sav2 = rows("SELECT hits FROM rate_limits WHERE bucket = ?", [`${f.bucket}-saved:${c}`])[0]?.hits;
    check(r.status === 201 && Number(sav2) === 1, "the next valid submission from that address is saved and counts one save", `${r.status} saved ${sav2}`);
  }

  section("4. flood limits: /api/chat");
  let chatCodes = [];
  for (let i = 0; i < 30; i++) chatCodes.push((await post("/api/chat", { message: "temple timings" }, ip(40))).status);
  check(chatCodes.every((s) => s === 200), "30 chat messages in ten minutes are answered", chatCodes.join(","));
  r = await post("/api/chat", { message: "temple timings" }, ip(40));
  check(is429(r), "message 31 is refused with 429 and the standard body", `${r.status} ${r.text}`);
  r = await post("/api/chat", { message: "temple timings" }, ip(41));
  check(r.status === 200 && typeof r.json?.reply === "string", "another address can still chat", r.text.slice(0, 120));

  /* ── 5. AI cost cap ───────────────────────────────────────────────────── */
  section("5. CHAT_AI_DAILY_LIMIT=0");
  const aiProbe = await fetch(`${AI_BASE}/api/pulse`).catch(() => null);
  if (check(Boolean(aiProbe?.ok), `the capped server answers at ${AI_BASE}`, "start it with GEMINI_API_KEY=dummy CHAT_AI_DAILY_LIMIT=0 serve.sh 8051")) {
    const aiBucketsBefore = rows("SELECT COALESCE(SUM(hits), 0) h FROM rate_limits WHERE bucket LIKE 'chat-ai:%'")[0].h;
    r = await post("/api/chat", { message: "What are the temple timings?" }, ip(42), AI_BASE);
    check(r.status === 200 && /6:00/.test(r.json?.reply || ""), "a question is answered from the built-in rules", r.text.slice(0, 160));
    check(r.ms < 3000, "the answer comes back at once, without trying the AI", `${r.ms} ms`);
    r = await post("/api/chat", { message: "zzqx unrelated words" }, ip(42), AI_BASE);
    check(r.status === 200 && /temple timings/i.test(r.json?.reply || "") && r.ms < 3000, "an unmatched question gets the normal help reply, not an error", `${r.status} ${r.ms} ms ${r.text.slice(0, 120)}`);
    const aiBucketsAfter = rows("SELECT COALESCE(SUM(hits), 0) h FROM rate_limits WHERE bucket LIKE 'chat-ai:%'")[0].h;
    check(Number(aiBucketsAfter) === Number(aiBucketsBefore), "no AI call was counted against the daily budget", `${aiBucketsBefore} → ${aiBucketsAfter}`);
  }

  /* ── 6. Admin: the thank-you list flag ────────────────────────────────── */
  section("6. admin donations: thank-you list");
  const hash = php(["-r", "echo password_hash('Kolam99Deep', PASSWORD_BCRYPT);"]).trim();
  for (const role of ["editor", "viewer"]) {
    sql("INSERT INTO admin_users (username, display_name, pass_hash, role, is_active, must_change) VALUES (?, ?, ?, ?, 1, 0)",
      [`${ADMIN_PREFIX}${role}`, `PHT ${role}`, hash, role]);
  }
  for (const label of ["admin A", "admin B", "admin C"]) {
    sql("INSERT INTO donations (name, phone, amount, purpose) VALUES (?, ?, 1001, 'festival')", [guest(label), PHONE]);
  }
  const adminIds = rows("SELECT id, name FROM donations WHERE name IN (?, ?, ?) ORDER BY id", [guest("admin A"), guest("admin B"), guest("admin C")]).map((x) => Number(x.id));
  const receipt = (id) => `D-${String(id).padStart(6, "0")}`;
  const flagOf = (id) => Number(rows("SELECT show_name_publicly f FROM donations WHERE id = ?", [id])[0].f);
  const activity = (id) => rows(`SELECT actor, action FROM admin_activity WHERE subject = ? AND action IN ${LIST_ACTIONS} ORDER BY id`, [receipt(id)]);
  const listUrl = `/admin/donations.php?q=${encodeURIComponent(MARK + " admin")}`;

  const owner = jar(ip(50));
  r = await adminLogin(owner, "admin", "Admin@Test123");
  check(r.status === 302, "owner signs in", `status ${r.status}`);
  let html = await (await owner.get(listUrl)).text();
  check(!BAD.test(html) && html.includes("Thank-you list"), "owner sees the Thank-you list column without PHP errors");
  check((html.match(/badge badge--muted">Not shown</g) || []).length === 3, "the three new donations are marked Not shown");
  check(html.includes("Show on thank-you list") && html.includes('data-bulk="bulk-form"'), "owner gets the row action and the bulk bar");
  check(/donors who ticked/i.test(html) && /permission/i.test(html), "the page explains when a donor may be shown");
  let csrf = csrfOf(html);

  r = await owner.post("/admin/donations.php", [["_csrf", csrf], ["action", "set_listed"], ["id", String(adminIds[0])], ["show", "1"]]);
  check(r.status === 303 && flagOf(adminIds[0]) === 1, "owner shows one donor on the thank-you list", `status ${r.status} flag ${flagOf(adminIds[0])}`);
  const ownerLog = activity(adminIds[0]);
  check(ownerLog.length === 1 && ownerLog[0].actor === "admin" && ownerLog[0].action === "donation_list_show", "the owner's change is in the activity log", JSON.stringify(ownerLog));
  html = await (await owner.get(listUrl)).text();
  check(/is now shown on the thank-you list/.test(html), "the owner is told what changed", html.match(/<p class="alert[^<]*<\/p>/)?.[0]);
  check(html.includes("Hide from thank-you list"), "a shown donor offers Hide instead of Show");
  r = await api("/api/donors", { xff: ip(1) });
  check((r.json || []).some((d) => d.name === guest("admin A")), "the donor the owner showed now appears on /api/donors");
  html = await (await owner.get(`/admin/donations.php?q=${encodeURIComponent(MARK + " admin")}&listed=shown`)).text();
  check(html.includes(guest("admin A")) && !html.includes(guest("admin B")), "the Shown filter lists only shown donations");

  const editor = jar(ip(51));
  r = await adminLogin(editor, `${ADMIN_PREFIX}editor`, "Kolam99Deep");
  check(r.status === 302, "editor signs in", `status ${r.status} ${r.headers.get("location")}`);
  html = await (await editor.get(listUrl)).text();
  check(!BAD.test(html) && html.includes('data-bulk="bulk-form"'), "editor gets the bulk bar");
  csrf = csrfOf(html);
  r = await editor.post("/admin/donations.php", [["_csrf", csrf], ["action", "bulk_listed"], ...adminIds.map((id) => ["ids[]", String(id)]), ["show", "1"]]);
  check(r.status === 303 && adminIds.every((id) => flagOf(id) === 1), "editor shows all selected donors in bulk", adminIds.map(flagOf).join(","));
  const editorShow = [adminIds[1], adminIds[2]].flatMap(activity).filter((x) => x.actor === `${ADMIN_PREFIX}editor` && x.action === "donation_list_show");
  check(editorShow.length === 2 && activity(adminIds[0]).length === 1, "only the donations that changed are logged, one entry each", JSON.stringify(adminIds.map(activity)));
  html = await (await editor.get(listUrl)).text();
  check(/2 donations are now shown on the thank-you list\. 1 already was\./.test(html), "the bulk result says how many changed", html.match(/<p class="alert[^<]*<\/p>/)?.[0]);
  r = await editor.post("/admin/donations.php", [["_csrf", csrfOf(html)], ["action", "bulk_listed"], ...adminIds.map((id) => ["ids[]", String(id)]), ["ids[]", "abc"], ["ids[]", "-4"], ["show", "0"]]);
  check(r.status === 303 && adminIds.every((id) => flagOf(id) === 0), "editor hides the selected donors in bulk (junk ids ignored)", adminIds.map(flagOf).join(","));
  const hides = adminIds.flatMap(activity).filter((x) => x.action === "donation_list_hide" && x.actor === `${ADMIN_PREFIX}editor`);
  check(hides.length === 3, "each hide is written to the activity log", JSON.stringify(hides));
  r = await editor.post("/admin/donations.php", [["_csrf", "forged"], ["action", "set_listed"], ["id", String(adminIds[0])], ["show", "1"]]);
  check(r.status === 303 && flagOf(adminIds[0]) === 0, "a forged CSRF token changes nothing");

  const viewer = jar(ip(52));
  r = await adminLogin(viewer, `${ADMIN_PREFIX}viewer`, "Kolam99Deep");
  check(r.status === 302, "viewer signs in", `status ${r.status}`);
  r = await viewer.get(listUrl);
  html = await r.text();
  check(r.status === 200 && !BAD.test(html) && html.includes("Thank-you list") && html.includes("Not shown"), "viewer can read the Thank-you list column");
  check(!html.includes("Show on thank-you list") && !html.includes('data-bulk="bulk-form"'), "viewer gets no show/hide actions and no bulk bar");
  r = await viewer.post("/admin/donations.php", [["_csrf", csrfOf(html) || ""], ["action", "set_listed"], ["id", String(adminIds[0])], ["show", "1"]]);
  check(r.status === 403 && flagOf(adminIds[0]) === 0, "viewer's single change is refused with 403", `status ${r.status}`);
  r = await viewer.post("/admin/donations.php", [["_csrf", csrfOf(html) || ""], ["action", "bulk_listed"], ...adminIds.map((id) => ["ids[]", String(id)]), ["show", "1"]]);
  check(r.status === 403 && adminIds.every((id) => flagOf(id) === 0), "viewer's bulk change is refused with 403", `status ${r.status}`);
  check(adminIds.flatMap(activity).every((x) => x.actor !== `${ADMIN_PREFIX}viewer`), "nothing was logged for the viewer");
  r = await viewer.get(`${listUrl}&export=csv`);
  const csv = await r.text();
  const [head, ...lines] = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
  check(r.status === 200 && head.split(",").includes("show_name_publicly"), "viewer can export, and the CSV has a show_name_publicly column", head);
  check(lines.length === 3 && lines.every((l) => l.split(",")[head.split(",").indexOf("show_name_publicly")] === "0"), "the CSV carries each donation's flag", lines.join(" | "));
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try {
    cleanup(`${MARK}%`, ADMIN_PREFIX, `${REG_MARK}%`);
    const left = rows(
      "SELECT (SELECT COUNT(*) FROM donations WHERE name LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?) + (SELECT COUNT(*) FROM contact_messages WHERE name LIKE ?) + (SELECT COUNT(*) FROM sponsors WHERE name LIKE ?) + (SELECT COUNT(*) FROM devotees WHERE name LIKE ?) + (SELECT COUNT(*) FROM rate_limits WHERE bucket REGEXP ?) AS c",
      [`${MARK}%`, `${MARK}%`, `${MARK}%`, `${MARK}%`, `${REG_MARK}%`, BUCKETS_REGEXP],
    )[0].c;
    check(Number(left) === 0, "cleanup removed every row and bucket this run created", `${left} left`);
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
