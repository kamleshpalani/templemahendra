#!/usr/bin/env node
/**
 * tests/notify-triggers.mjs — the places the site tells a devotee something,
 * end to end through the real endpoints, the admin pages and MySQL.
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
 *     node tests/notify-triggers.mjs http://127.0.0.1:8002
 *
 * The server runs with its default drivers: email through the mailer into
 * backend/logs/mail.log, WhatsApp and SMS through the log driver into
 * backend/logs/notify.log.
 *
 * It proves: devotee sign-in is retired (docs/registration/SPEC.md §1) — every
 * account endpoint answers 404 under /api and /api/v1, creates nothing and
 * sends nothing, and the account, security and phone-code events no longer
 * exist; a family that registers with consent is told once
 * (registration.received, email and WhatsApp, in its language, with the family
 * count, deduped on replay) and one without consent is told nothing; bookings
 * and donations are acknowledged to the phone on the form (a booking is not
 * linked to a registration, SPEC §3), deduped on replay; admin status changes
 * notify once per booking (single and bulk); "Send receipt" numbers each
 * receipt; an announcement with "Also notify devotees" makes a draft email and
 * WhatsApp campaign and sends nothing. contact.received is covered by
 * brief-e2e.mjs (E2E-040) and sponsor.confirmed by payments-api.mjs and
 * sponsors.mjs.
 *
 * Every request carries this run's own X-Forwarded-For. Devotees are
 * e2e-trig-<run>-*@example.test; bookings, donations and announcements are named
 * E2E-TRIG-<run>…; all of it, and the rate-limit buckets it used, is removed at
 * the end (and any leftovers of an earlier crashed run at the start).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8002").replace(/\/$/, "");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const MAIL_LOG = resolve(ROOT, "backend/logs/mail.log");

const RUN = Date.now().toString(36);
const P = `e2e-trig-${RUN}-`;
const NAME = `E2E-TRIG-${RUN}`;
// One address per run, so a second run in the same hour starts with fresh
// sign-up and sign-in budgets and cleanup can remove exactly its own buckets.
const OCTET = 1 + Math.floor(Math.random() * 254);
const XFF = `10.32.${OCTET}.${OCTET}`;

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

/* ── PHP and SQL ───────────────────────────────────────────────────────── */

/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

function php(args) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`php ${args.join(" ").slice(0, 120)} printed no JSON (exit ${r.status}): ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
  }
}
const fixtures = (cmd, obj = {}) => php(["tests/support/notify_fixtures.php", cmd, arg(obj)]);
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}
const one = (query, params) => sql(query, params)[0] ?? null;
const marks = (list) => list.map(() => "?").join(",");

/** Notifications matching a WHERE clause, oldest first, with vars decoded. */
function notifications(where, params) {
  return sql(
    `SELECT id, devotee_id, event, dedupe_key, vars, title, body, to_phone, lang, show_in_app, campaign_id
       FROM notifications WHERE ${where} ORDER BY id`,
    params,
  ).map((n) => ({ ...n, varsRaw: n.vars ?? "", vars: n.vars ? JSON.parse(n.vars) : {} }));
}
/** channel => delivery row */
function deliveries(notificationId) {
  const rows = sql("SELECT channel, status, skip_reason, provider FROM notification_deliveries WHERE notification_id = ?", [notificationId]);
  return Object.fromEntries(rows.map((d) => [d.channel, d]));
}
const eventsFor = (devoteeId, event) => notifications("devotee_id = ? AND event = ?", [devoteeId, event]);
const eventsForEntity = (type, id, event) => notifications("entity_type = ? AND entity_id = ? AND event = ?", [type, id, event]);

/* ── Logs ──────────────────────────────────────────────────────────────── */

const mailBlocks = (email) =>
  (existsSync(MAIL_LOG) ? readFileSync(MAIL_LOG, "utf8") : "").split("\n===== ").filter((b) => b.includes(`To: ${email}\n`));

/* ── HTTP: one cookie jar per client, this run's own address ───────────── */

class Client {
  constructor() {
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
  async req(method, path, { json, form } = {}) {
    const headers = { "X-Forwarded-For": XFF, Accept: "application/json, text/html" };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      if (this.csrf) headers["X-CSRF-Token"] = this.csrf;
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = (form instanceof URLSearchParams ? form : new URLSearchParams(form)).toString();
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
    this.#store(res);
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* HTML pages */
    }
    if (parsed?.csrf) this.csrf = parsed.csrf;
    return { status: res.status, json: parsed, text, location: res.headers.get("location") };
  }
  get = (p) => this.req("GET", p);
  post = (p, b = {}) => this.req("POST", p, { json: b });
  form = (p, f) => this.req("POST", p, { form: f });
}

/** The admin: signs in through the login form, then posts forms with the page's CSRF token. */
class Admin extends Client {
  async login() {
    const page = await this.get("/admin/login.php");
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
    const r = await this.form("/admin/login.php", { _csrf: token ?? "", username: "admin", password: "Admin@Test123" });
    return r.status;
  }
  async token(page) {
    const r = await this.get(page);
    return /name="_csrf" value="([^"]+)"/.exec(r.text)?.[1] ?? "";
  }
  /** POST a form, then load the page the redirect points at — where the flash is shown. */
  async act(page, fields) {
    const token = await this.token(page);
    const params = new URLSearchParams({ _csrf: token });
    for (const [k, v] of Object.entries(fields)) {
      for (const value of Array.isArray(v) ? v : [v]) params.append(k, String(value));
    }
    const r = await this.form(page, params);
    const next = r.location ? await this.get(r.location.replace(/^https?:\/\/[^/]+/, "")) : { text: "" };
    return { status: r.status, page: next.text };
  }
}
/** The text of the flash alerts on an admin page, with entities decoded enough to read. */
const flashOf = (html) =>
  [...html.matchAll(/<p class="alert alert--(?:success|warning|error)"[^>]*>([\s\S]*?)<\/p>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))
    .join(" | ");

/* ── Cleanup ───────────────────────────────────────────────────────────── */

const created = { devotees: [], bookings: [], donations: [], campaigns: [], receipts: [], workerRuns: [] };

/**
 * Remove what this suite made. Guest notifications are not attached to a
 * devotee, so they are removed through the booking or donation they are about;
 * everything an account owns cascades from the devotee row.
 */
function cleanup(namePrefix, emailPrefix) {
  const bookingIds = sql("SELECT id FROM seva_bookings WHERE devotee_name LIKE ?", [`${namePrefix}%`]).map((r) => Number(r.id));
  const donationIds = sql("SELECT id FROM donations WHERE name LIKE ?", [`${namePrefix}%`]).map((r) => Number(r.id));
  if (bookingIds.length) sql(`DELETE FROM notifications WHERE entity_type = 'seva_booking' AND entity_id IN (${marks(bookingIds)})`, bookingIds);
  if (donationIds.length) {
    sql(`DELETE FROM notifications WHERE entity_type = 'donation' AND entity_id IN (${marks(donationIds)})`, donationIds);
    const receipts = donationIds.map((id) => `D-${String(id).padStart(6, "0")}`);
    sql(`DELETE FROM admin_activity WHERE action = 'donation_receipt' AND subject IN (${marks(receipts)})`, receipts);
  }
  sql("DELETE FROM seva_bookings WHERE devotee_name LIKE ?", [`${namePrefix}%`]);
  sql("DELETE FROM donations WHERE name LIKE ?", [`${namePrefix}%`]);

  const campaignIds = sql("SELECT id FROM notification_campaigns WHERE name LIKE ?", [`Announcement: ${namePrefix}%`]).map((r) => Number(r.id));
  if (campaignIds.length) {
    sql(`DELETE FROM notification_audit WHERE campaign_id IN (${marks(campaignIds)})`, campaignIds);
    sql(`DELETE FROM notification_campaigns WHERE id IN (${marks(campaignIds)})`, campaignIds);
  }
  sql("DELETE FROM announcements WHERE title LIKE ?", [`${namePrefix}%`]);

  const removed = fixtures("cleanup", { email_prefix: emailPrefix });
  if (removed.error) throw new Error(`fixtures cleanup: ${removed.error}`);
  sql("DELETE FROM mail_log WHERE to_email LIKE ?", [`${emailPrefix}%`]);
  if (created.workerRuns.length) sql(`DELETE FROM notification_worker_runs WHERE id IN (${marks(created.workerRuns)})`, created.workerRuns);
}

/* ── The suite ─────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Notification triggers — ${BASE}`);
  console.log(`run ${RUN}, X-Forwarded-For ${XFF}`);

  cleanup("E2E-TRIG-", "e2e-trig-");
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const phoneTail = String(Math.floor(Math.random() * 900) + 100);

  /* ── 1. The retired account endpoints ──────────────────────────────── */
  section("Devotee sign-in is retired: its endpoints answer 404 and do nothing");
  const ghost = {
    name: `${NAME} Ghost`, email: `${P}ghost@example.test`, password: "Kolam99Deep", phone: `919876522${phoneTail}`, phoneCountry: "IN",
    country: "IN", state: "TN", city: "Pudupatti", token: "0".repeat(64), code: "123456", currentPassword: "Kolam99Deep", newPassword: "Nandri88Kolam",
  };
  const anon = new Client();
  const retiredRoutes = [
    ["GET", "/auth/me"], ["POST", "/auth/register"], ["POST", "/auth/login"], ["POST", "/auth/verify"], ["POST", "/auth/forgot"],
    ["POST", "/auth/reset"], ["POST", "/account/profile"], ["POST", "/account/password"], ["POST", "/account/phone-verify-start"],
    ["POST", "/account/phone-verify-confirm"], ["GET", "/notifications"], ["POST", "/notifications/read-all"],
  ];
  const answers = [];
  for (const [method, path] of retiredRoutes) {
    for (const prefix of ["/api", "/api/v1"]) {
      const res = method === "GET" ? await anon.get(prefix + path) : await anon.post(prefix + path, ghost);
      answers.push({ route: `${method} ${prefix}${path}`, status: res.status, cookie: anon.cookies.size });
    }
  }
  check(answers.every((a) => a.status === 404), `all ${answers.length} account routes answer 404 under /api and /api/v1`, JSON.stringify(answers.filter((a) => a.status !== 404)));
  check(anon.cookies.size === 0, "none of them starts a session (no cookie)", [...anon.cookies.keys()].join(","));
  check(Number(one("SELECT COUNT(*) AS c FROM devotees WHERE email = ?", [ghost.email])?.c) === 0, "no registration was created by them");
  check(mailBlocks(ghost.email).length === 0, "and no email was sent");
  for (const ev of ["account.registered", "account.email_verification", "account.email_verified", "account.profile_updated", "security.password_reset", "security.password_changed", "phone.otp", "phone.verified"]) {
    const fired = fixtures("event", { event: ev, ctx: { to_email: ghost.email, to_phone: ghost.phone } });
    check(fired.result?.id === null && fired.result?.skipped === "unknown event", `${ev} is not an event any more`, JSON.stringify(fired));
  }

  /* ── 2. Family registration ─────────────────────────────────────────── */
  section("Family registration: registration.received");
  const family = {
    name: `${NAME} Kavitha`, dateOfBirth: "", phone: `+91 98765 00${phoneTail}`, phoneCountry: "IN", email: `${P}a@example.test`, lang: "en",
    members: [{ name: `${NAME} Meena`, relationship: "spouse", age: 41 }, { name: `${NAME} Arun`, relationship: "son", age: 12 }],
    address1: "12 North Street", address2: "", city: "Pudupatti", state: "TN", country: "IN", postcode: "627719", consent: true, hp_token: "",
  };
  const fam = new Client();
  let r = await fam.post("/api/registrations", family);
  check(r.status === 201, "a family registers through POST /api/registrations", `status ${r.status} ${r.text.slice(0, 160)}`);
  const devoteeId = Number(one("SELECT id FROM devotees WHERE email = ?", [family.email])?.id ?? 0);
  created.devotees.push(devoteeId);
  check(devoteeId > 0 && one("SELECT updates_consent_at FROM devotees WHERE id = ?", [devoteeId])?.updates_consent_at !== null, "the registration is stored with its consent time");
  const welcome = eventsFor(devoteeId, "registration.received");
  check(welcome.length === 1, "registration.received created one notification", `${welcome.length}`);
  check(welcome[0]?.dedupe_key === `devotee:${devoteeId}:registered` && welcome[0]?.lang === "en", "…deduped per family, in the language the form was sent in", `${welcome[0]?.dedupe_key} ${welcome[0]?.lang}`);
  check(Number(welcome[0]?.vars?.familyCount) === 3 && (welcome[0]?.body ?? "").includes("3"), "…counting the registrant and both members", welcome[0]?.varsRaw);
  const welcomeD = welcome[0] ? deliveries(welcome[0].id) : {};
  check(Object.keys(welcomeD).sort().join(",") === "email,whatsapp" && welcomeD.email?.status === "queued" && welcomeD.whatsapp?.status === "queued", "…by email and WhatsApp (no in-app, no push)", JSON.stringify(welcomeD));
  const replayWelcome = fixtures("event", { event: "registration.received", ctx: { devotee_id: devoteeId, vars: welcome[0]?.vars ?? {} } });
  check(replayWelcome.result?.deduped === true && eventsFor(devoteeId, "registration.received").length === 1, "firing it again is deduped", JSON.stringify(replayWelcome));

  const declining = { ...family, name: `${NAME} Selvi`, email: `${P}b@example.test`, phone: `+91 98765 11${phoneTail}`, members: [], consent: false };
  r = await fam.post("/api/registrations", declining);
  const declineId = Number(one("SELECT id FROM devotees WHERE email = ?", [declining.email])?.id ?? 0);
  created.devotees.push(declineId);
  check(r.status === 201 && declineId > 0, "a family that does not tick the box registers too", `status ${r.status}`);
  check(eventsFor(declineId, "registration.received").length === 0, "…and is told nothing");

  /* ── 7. Bookings ────────────────────────────────────────────────────── */
  section("Seva bookings are acknowledged");
  const dev = new Client();
  r = await dev.post("/api/seva-bookings", {
    devotee_name: `${NAME} Booking`,
    phone: "9876543210",
    seva_name: `${NAME} Abhishekam`,
    preferred_date: tomorrow,
    message: "E2E-TRIG booking",
  });
  const bookingA = Number(r.json?.id ?? 0);
  created.bookings.push(bookingA);
  check(r.status === 201 && JSON.stringify(Object.keys(r.json ?? {})) === '["success","id"]', "a booking answers exactly {success, id}", r.text);
  let received = eventsForEntity("seva_booking", bookingA, "booking.received");
  check(received.length === 1 && received[0].devotee_id === null && received[0].to_phone === "919876543210", "booking.received went to the phone on the booking (a booking is not linked to a registration)", JSON.stringify(received[0] ?? {}));
  check(received[0]?.vars?.bookingNumber === `B-${String(bookingA).padStart(6, "0")}`, "…with the booking number B-000000 style", received[0]?.vars?.bookingNumber);
  check(received[0]?.dedupe_key === `booking:${bookingA}:received`, "…deduped per booking");
  const receivedD = received[0] ? deliveries(received[0].id) : {};
  check(!receivedD.inapp && !receivedD.push && receivedD.whatsapp?.status === "queued" && receivedD.email?.skip_reason === "no email", "…on WhatsApp (the form has no email, so that channel is skipped with its reason)", JSON.stringify(receivedD));

  const replay = fixtures("event", {
    event: "booking.received",
    ctx: { to_phone: "919876543210", entity_id: bookingA, vars: received[0]?.vars ?? {} },
  });
  check(replay.result?.deduped === true, "replaying booking.received is deduped", JSON.stringify(replay));
  check(eventsForEntity("seva_booking", bookingA, "booking.received").length === 1, "…and still one notification");

  const guest = new Client();
  r = await guest.post("/api/seva-bookings", {
    devotee_name: `${NAME} Guest`,
    phone: "98765 43210",
    seva_name: `${NAME} Archanai`,
    preferred_date: tomorrow,
  });
  const bookingG = Number(r.json?.id ?? 0);
  created.bookings.push(bookingG);
  check(r.status === 201, "a guest booking is accepted", `status ${r.status}`);
  received = eventsForEntity("seva_booking", bookingG, "booking.received");
  check(received.length === 1 && received[0].devotee_id === null, "booking.received went to the guest", JSON.stringify(received[0] ?? {}));
  check(received[0]?.to_phone === "919876543210" && received[0]?.lang === "ta", "…at the phone they gave, in Tamil", `${received[0]?.to_phone} ${received[0]?.lang}`);
  const guestD = received[0] ? deliveries(received[0].id) : {};
  check(!guestD.inapp && !guestD.push && guestD.whatsapp?.status === "queued", "…on WhatsApp, with no in-app or push copy", JSON.stringify(guestD));

  /* ── 8. Admin status changes ────────────────────────────────────────── */
  section("Admin: confirming, re-applying and bulk cancelling bookings");
  const admin = new Admin();
  check((await admin.login()) === 302, "the admin signs in");

  let act = await admin.act("/admin/seva_bookings.php", { action: "set_status", id: bookingA, status: "confirmed" });
  check(act.status === 302, "confirming a booking redirects", `status ${act.status}`);
  check(/Notified 1 devotee\./.test(flashOf(act.page)), "…and the flash says one devotee was notified", flashOf(act.page));
  let confirmed = eventsForEntity("seva_booking", bookingA, "booking.confirmed");
  check(confirmed.length === 1 && confirmed[0].devotee_id === null && confirmed[0].to_phone === "919876543210", "booking.confirmed went to the phone on the booking", JSON.stringify(confirmed[0] ?? {}));
  check(confirmed[0]?.vars?.bookingNumber === `B-${String(bookingA).padStart(6, "0")}`, "…with the same booking number");

  act = await admin.act("/admin/seva_bookings.php", { action: "set_status", id: bookingA, status: "confirmed" });
  check(/already Confirmed/.test(flashOf(act.page)), "re-applying the status says nothing changed", flashOf(act.page));
  await admin.act("/admin/seva_bookings.php", { action: "set_status", id: bookingA, status: "pending" });
  act = await admin.act("/admin/seva_bookings.php", { action: "set_status", id: bookingA, status: "confirmed" });
  check(/No devotee was notified/.test(flashOf(act.page)), "confirming again after pending notifies nobody", flashOf(act.page));
  confirmed = eventsForEntity("seva_booking", bookingA, "booking.confirmed");
  check(confirmed.length === 1, "…still exactly one booking.confirmed", `${confirmed.length}`);

  act = await admin.act("/admin/seva_bookings.php", { action: "bulk_status", status: "cancelled", "ids[]": [bookingA, bookingG] });
  check(/Updated 2 bookings to Cancelled\./.test(flashOf(act.page)) && /Notified 2 devotees\./.test(flashOf(act.page)), "bulk cancel reports two updated and two notified", flashOf(act.page));
  const cancelledA = eventsForEntity("seva_booking", bookingA, "booking.cancelled");
  const cancelledG = eventsForEntity("seva_booking", bookingG, "booking.cancelled");
  check(cancelledA.length === 1 && cancelledG.length === 1, "each booking got one booking.cancelled", `${cancelledA.length}, ${cancelledG.length}`);
  check(cancelledG[0]?.to_phone === "919876543210" && typeof cancelledG[0]?.vars?.reason === "string", "…the guest's by phone, with a reason", JSON.stringify(cancelledG[0]?.vars ?? {}));
  act = await admin.act("/admin/seva_bookings.php", { action: "bulk_status", status: "cancelled", "ids[]": [bookingA, bookingG] });
  check(/No bookings changed/.test(flashOf(act.page)) && eventsForEntity("seva_booking", bookingA, "booking.cancelled").length === 1, "re-applying the bulk cancel changes and sends nothing", flashOf(act.page));

  /* ── 9. Donations and receipts ──────────────────────────────────────── */
  section("Donations are acknowledged; receipts are numbered");
  r = await dev.post("/api/donations", {
    name: `${NAME} Donor`,
    phone: "9876543210",
    amount: 1001,
    purpose: "annadanam",
    message: "E2E-TRIG donation",
  });
  const donation = Number(r.json?.id ?? 0);
  created.donations.push(donation);
  check(r.status === 201 && JSON.stringify(Object.keys(r.json ?? {})) === '["success","id"]', "a donation answers exactly as before", r.text);
  const receipt = `D-${String(donation).padStart(6, "0")}`;
  created.receipts.push(receipt);
  const dReceived = eventsForEntity("donation", donation, "donation.received");
  check(dReceived.length === 1 && dReceived[0].devotee_id === null && dReceived[0].to_phone === "919876543210", "donation.received went to the phone the donor gave", JSON.stringify(dReceived[0] ?? {}));
  check(dReceived[0]?.vars?.receiptNumber === receipt && dReceived[0]?.vars?.donationAmount === "Rs. 1,001", "…with the reference and the amount", dReceived[0]?.varsRaw);

  act = await admin.act("/admin/donations.php", { action: "send_receipt", id: donation });
  check(act.status === 303, "Send receipt posts and redirects", `status ${act.status}`);
  check(new RegExp(`Receipt ${receipt} \\(receipt 1\\)`).test(flashOf(act.page)) && flashOf(act.page).includes("queued for WhatsApp. Skipped: email (no email)."), "…and the flash reports receipt 1, the channel it went on and the one skipped with its reason", flashOf(act.page));
  act = await admin.act("/admin/donations.php", { action: "send_receipt", id: donation });
  check(/\(receipt 2\)/.test(flashOf(act.page)), "sending it again is receipt 2", flashOf(act.page));
  check(act.page.includes("Send receipt again (2 sent)"), "…and the row action shows how many were sent");
  const receipts = eventsForEntity("donation", donation, "donation.receipt");
  check(
    receipts.map((n) => n.dedupe_key).join(" ") === `donation:${donation}:receipt:1 donation:${donation}:receipt:2`,
    "the two receipts carry sequences 1 and 2",
    receipts.map((n) => n.dedupe_key).join(" "),
  );
  check(typeof receipts[0]?.vars?.donationDate === "string" && receipts[0].vars.donationDate.length > 0, "…with the donation date filled in");

  /* ── 10. Announcements ──────────────────────────────────────────────── */
  section("Announcement with “Also notify devotees” makes a draft campaign");
  const annPage = await admin.get("/admin/announcements.php");
  check(annPage.text.includes('name="notify_devotees"'), "the create form offers the checkbox");
  // Hidden (no is_active), so the homepage ticker other suites look at never shows it.
  act = await admin.act("/admin/announcements.php", {
    action: "save",
    title: `${NAME} Festival notice`,
    body: "The Aadi festival begins on Friday.",
    notify_devotees: "1",
  });
  check(act.status === 303, "saving the announcement redirects", `status ${act.status}`);
  const draftId = Number(/\/admin\/notifications\.php\?edit=(\d+)/.exec(act.page)?.[1] ?? 0);
  check(draftId > 0, "the flash links to the draft on the Notifications page", flashOf(act.page));
  const campaign = one("SELECT id, status, category, channels, template_key, created_by, name FROM notification_campaigns WHERE id = ?", [draftId]);
  if (campaign) created.campaigns.push(draftId);
  check(campaign?.status === "draft" && campaign?.category === "announcement", "the campaign is a draft in the announcement category", JSON.stringify(campaign));
  check(campaign?.channels === "email,whatsapp" && campaign?.template_key === "announcement", "…by email and WhatsApp, from the announcement template", JSON.stringify(campaign));
  check(campaign?.created_by === "admin", "…created by the signed-in admin");
  const translations = sql("SELECT lang, title FROM notification_campaign_translations WHERE campaign_id = ? ORDER BY lang", [draftId]);
  check(translations.map((t) => t.lang).join(",") === "en,ta" && translations.every((t) => t.title === `${NAME} Festival notice`), "…with Tamil and English words from the announcement", JSON.stringify(translations));
  check(Number(one("SELECT COUNT(*) AS c FROM notifications WHERE campaign_id = ?", [draftId])?.c) === 0, "nothing was queued or sent");

  act = await admin.act("/admin/announcements.php", { action: "save", title: `${NAME} Plain notice`, body: "" });
  check(
    Number(one("SELECT COUNT(*) AS c FROM notification_campaigns WHERE name = ?", [`Announcement: ${NAME} Plain notice`])?.c) === 0,
    "an announcement without the checkbox makes no campaign",
  );

}

let crashed = null;
try {
  await main();
} catch (err) {
  crashed = err;
  failures.push(`harness: ${err.message}`);
  console.log(`\n  FAIL harness error — ${err.stack ?? err}`);
}

section("Cleanup");
try {
  cleanup(NAME, P);
  sql("DELETE FROM rate_limits WHERE bucket LIKE ?", [`%:${XFF}`]);
  const left = one(
    `SELECT (SELECT COUNT(*) FROM devotees WHERE email LIKE ?) AS devotees,
            (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?) AS bookings,
            (SELECT COUNT(*) FROM donations WHERE name LIKE ?) AS donations,
            (SELECT COUNT(*) FROM announcements WHERE title LIKE ?) AS announcements,
            (SELECT COUNT(*) FROM notification_campaigns WHERE name LIKE ?) AS campaigns,
            (SELECT COUNT(*) FROM rate_limits WHERE bucket LIKE ?) AS buckets`,
    [`${P}%`, `${NAME}%`, `${NAME}%`, `${NAME}%`, `Announcement: ${NAME}%`, `%:${XFF}`],
  );
  const guestLeft = created.bookings.length
    ? Number(one(`SELECT COUNT(*) AS c FROM notifications WHERE entity_type = 'seva_booking' AND entity_id IN (${marks(created.bookings)})`, created.bookings)?.c)
    : 0;
  check(Object.values(left ?? {}).every((v) => Number(v) === 0) && guestLeft === 0, "this run left nothing behind", JSON.stringify({ ...left, guestNotifications: guestLeft }));
} catch (err) {
  failures.push(`cleanup: ${err.message}`);
  console.log(`  FAIL cleanup — ${err.message}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failures.length || crashed ? 1 : 0);
