#!/usr/bin/env node
/**
 * tests/notify-triggers.mjs — the places the site tells a devotee something,
 * end to end through the real endpoints, the admin pages and MySQL.
 *
 *   PHP_BIN=/path/to/php.sh node tests/notify-triggers.mjs http://127.0.0.1:8002
 *
 * The server runs with its default drivers: email through the mailer into
 * backend/logs/mail.log, WhatsApp and SMS through the log driver into
 * backend/logs/notify.log. So what went out is read back from those logs
 * rather than faked. It must also run with CONTACT_NOTIFY_EMAIL set to exactly
 * office@example.test (the office copy of a contact message is checked against
 * that address) and with TRUSTED_PROXIES covering 127.0.0.1, so this run's
 * X-Forwarded-For is honoured.
 *
 * Devotee accounts are gone (docs/registration/SPEC.md §1): a family registers
 * once, without a password, and is only ever told something by email, WhatsApp
 * or SMS. It proves: a registration raises registration.received only when the
 * family ticked consent (by email and WhatsApp, counting the whole family,
 * deduped per family, and the worker mails it); a booking or donation is
 * acknowledged at the phone given, in the language the site was in, and
 * deduped on replay; admin status changes notify once per booking (single and
 * bulk) in the booking's own language; "Send receipt" numbers each receipt;
 * an announcement with "Also notify devotees" makes an email + WhatsApp draft
 * campaign and sends nothing; a contact-form message raises contact.received
 * for the temple office — one email-only notification per configured address,
 * numbered by message, deduped per address — and the worker mails it.
 *
 * Every request carries this run's own X-Forwarded-For. Families are
 * e2e-trig-<run>-*@example.test; registrations, bookings, donations, contact
 * messages and announcements are named E2E-TRIG-<run>…; all of it, and the
 * rate-limit buckets it used, is removed at the end (and any leftovers of an
 * earlier crashed run at the start).
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
const NOTIFY_LOG = resolve(ROOT, "backend/logs/notify.log");
/** The address CONTACT_NOTIFY_EMAIL must name on the server under test. */
const OFFICE = "office@example.test";

const RUN = Date.now().toString(36);
const P = `e2e-trig-${RUN}-`;
const NAME = `E2E-TRIG-${RUN}`;
// One address per run, so a second run in the same hour starts with fresh
// registration, booking, donation and contact budgets and cleanup can remove
// exactly its own buckets.
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
const arg = (obj) => JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

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
    `SELECT id, devotee_id, recipient_type, event, template_key, category, dedupe_key, vars, title, body,
            to_email, to_phone, lang, entity_type, entity_id, campaign_id
       FROM notifications WHERE ${where} ORDER BY id`,
    params,
  ).map((n) => ({ ...n, varsRaw: n.vars ?? "", vars: n.vars ? JSON.parse(n.vars) : {} }));
}
/** channel => delivery row */
function deliveries(notificationId) {
  const rows = sql("SELECT id, channel, status, skip_reason, provider FROM notification_deliveries WHERE notification_id = ?", [notificationId]);
  return Object.fromEntries(rows.map((d) => [d.channel, d]));
}
const channelsOf = (d) => Object.keys(d).sort().join(",");
const eventsFor = (devoteeId, event) => notifications("devotee_id = ? AND event = ?", [devoteeId, event]);
const eventsForEntity = (type, id, event) => notifications("entity_type = ? AND entity_id = ? AND event = ?", [type, id, event]);

/** A worker run confined to one notification, remembered so its row is removed at the end. */
function workerFor(notificationId) {
  const worker = php(["backend/bin/notify_worker.php", `--notification-ids=${notificationId}`, "--skip-campaigns", "--skip-reminders", "--json"]);
  if (worker.run_id) created.workerRuns.push(Number(worker.run_id));
  return worker;
}

/* ── Logs ──────────────────────────────────────────────────────────────── */

const mailBlocks = (email) =>
  (existsSync(MAIL_LOG) ? readFileSync(MAIL_LOG, "utf8") : "").split("\n===== ").filter((b) => b.includes(`To: ${email}\n`));
/** The last entry the log driver recorded for a WhatsApp or SMS delivery. */
function notifyLogBlock(deliveryId) {
  const text = existsSync(NOTIFY_LOG) ? readFileSync(NOTIFY_LOG, "utf8") : "";
  return text.split("===== ").filter((b) => new RegExp(`delivery #${deliveryId}\\s`).test(b)).pop() ?? "";
}

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

const created = { devotees: [], bookings: [], donations: [], contacts: [], campaigns: [], receipts: [], workerRuns: [] };

/**
 * Remove what this suite made. A booking, donation or contact message is not
 * attached to a family, so its notifications are removed through the row they
 * are about; everything a registration owns (members, its own notification)
 * cascades from the devotee row.
 */
function cleanup(namePrefix, emailPrefix) {
  const bookingIds = sql("SELECT id FROM seva_bookings WHERE devotee_name LIKE ?", [`${namePrefix}%`]).map((r) => Number(r.id));
  const donationIds = sql("SELECT id FROM donations WHERE name LIKE ?", [`${namePrefix}%`]).map((r) => Number(r.id));
  const contactIds = sql("SELECT id FROM contact_messages WHERE name LIKE ?", [`${namePrefix}%`]).map((r) => Number(r.id));
  if (bookingIds.length) sql(`DELETE FROM notifications WHERE entity_type = 'seva_booking' AND entity_id IN (${marks(bookingIds)})`, bookingIds);
  if (donationIds.length) {
    sql(`DELETE FROM notifications WHERE entity_type = 'donation' AND entity_id IN (${marks(donationIds)})`, donationIds);
    const receipts = donationIds.map((id) => `D-${String(id).padStart(6, "0")}`);
    sql(`DELETE FROM admin_activity WHERE action = 'donation_receipt' AND subject IN (${marks(receipts)})`, receipts);
  }
  if (contactIds.length) sql(`DELETE FROM notifications WHERE entity_type = 'contact_message' AND entity_id IN (${marks(contactIds)})`, contactIds);
  sql("DELETE FROM seva_bookings WHERE devotee_name LIKE ?", [`${namePrefix}%`]);
  sql("DELETE FROM donations WHERE name LIKE ?", [`${namePrefix}%`]);
  sql("DELETE FROM contact_messages WHERE name LIKE ?", [`${namePrefix}%`]);

  const campaignIds = sql("SELECT id FROM notification_campaigns WHERE name LIKE ?", [`Announcement: ${namePrefix}%`]).map((r) => Number(r.id));
  if (campaignIds.length) {
    sql(`DELETE FROM notification_audit WHERE campaign_id IN (${marks(campaignIds)})`, campaignIds);
    sql(`DELETE FROM notification_campaigns WHERE id IN (${marks(campaignIds)})`, campaignIds);
  }
  sql("DELETE FROM announcements WHERE title LIKE ?", [`${namePrefix}%`]);

  const removed = fixtures("cleanup", { email_prefix: emailPrefix, name_prefix: namePrefix });
  if (removed.error) throw new Error(`fixtures cleanup: ${removed.error}`);
  sql("DELETE FROM mail_log WHERE to_email LIKE ?", [`${emailPrefix}%`]);
  // The office's copy of a contact message is addressed to the office, so it is
  // recognised by the visitor's name in its subject line.
  sql("DELETE FROM mail_log WHERE to_email = ? AND subject LIKE ?", [OFFICE, `%${namePrefix}%`]);
  if (created.workerRuns.length) sql(`DELETE FROM notification_worker_runs WHERE id IN (${marks(created.workerRuns)})`, created.workerRuns);
}

/* ── The suite ─────────────────────────────────────────────────────────── */

async function main() {
  console.log(`Notification triggers — ${BASE}`);
  console.log(`run ${RUN}, X-Forwarded-For ${XFF}`);

  cleanup("E2E-TRIG-", "e2e-trig-");
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const phoneTail = String(Math.floor(Math.random() * 900) + 100);
  const registration = (over = {}) => ({
    name: `${NAME} Kavitha`,
    dateOfBirth: "",
    // As the form sends it (frontend/src/lib/familyRegistration.js): E.164, with the country.
    phone: `+91 98765 00${phoneTail}`,
    phoneCountry: "IN",
    email: `${P}a@example.test`,
    lang: "en",
    members: [{ name: "K. Meena", relationship: "spouse", age: 41 }],
    address1: "12 North Street",
    address2: "",
    city: "Pudupatti",
    state: "TN",
    country: "IN",
    postcode: "627719",
    consent: true,
    hp_token: "",
    ...over,
  });

  /* ── 1. Registration ────────────────────────────────────────────────── */
  section("Registration: registration.received, only for a family that ticked consent");
  const family = registration();
  const reg = new Client();
  let r = await reg.post("/api/registrations", family);
  check(r.status === 201 && r.text === '{"success":true}', "registering through the real endpoint answers 201 {\"success\":true}", `status ${r.status} ${r.text.slice(0, 160)}`);

  const registered = one("SELECT id, phone, lang, updates_consent_at FROM devotees WHERE email = ?", [family.email]);
  const devoteeId = Number(registered?.id ?? 0);
  created.devotees.push(devoteeId);
  const familyPhone = family.phone.replace(/\D/g, "");
  check(devoteeId > 0 && registered?.updates_consent_at !== null && registered?.phone === familyPhone, "the registration exists, with its consent recorded and its E.164 phone", JSON.stringify(registered));

  const welcome = eventsFor(devoteeId, "registration.received");
  check(welcome.length === 1, "registration.received created one notification", `${welcome.length}`);
  check(welcome[0]?.entity_type === "devotee" && Number(welcome[0]?.entity_id) === devoteeId && welcome[0]?.recipient_type === "devotee", "…about the registration itself", JSON.stringify(welcome[0] ?? {}));
  check(welcome[0]?.template_key === "registration_received" && welcome[0]?.category === "general", "…from the registration_received template in the general category", `${welcome[0]?.template_key} ${welcome[0]?.category}`);
  check(Number(welcome[0]?.vars?.familyCount) === 2, "…counting the registrant and the one member", welcome[0]?.varsRaw);
  check(welcome[0]?.lang === "en", "…in the family's language", welcome[0]?.lang);
  check(welcome[0]?.to_email === null && welcome[0]?.to_phone === null, "…with no address or number of its own: they are read from the registration when it is sent", `${welcome[0]?.to_email} ${welcome[0]?.to_phone}`);
  check(welcome[0]?.dedupe_key === `devotee:${devoteeId}:registered`, "…deduped per family", welcome[0]?.dedupe_key);
  const welcomeD = welcome[0] ? deliveries(welcome[0].id) : {};
  check(channelsOf(welcomeD) === "email,whatsapp", "…by email and WhatsApp only (no bell, no push)", channelsOf(welcomeD));
  check(welcomeD.email?.status === "queued" && welcomeD.whatsapp?.status === "queued", "…both queued for the worker, nothing sent inside the request", JSON.stringify(welcomeD));

  const replayWelcome = fixtures("event", { event: "registration.received", ctx: { devotee_id: devoteeId, entity_id: devoteeId, vars: { familyCount: 2 } } });
  check(replayWelcome.result?.deduped === true, "firing registration.received again is deduped", JSON.stringify(replayWelcome));
  check(eventsFor(devoteeId, "registration.received").length === 1, "…and still one notification");

  const worker = welcome[0] ? workerFor(welcome[0].id) : {};
  check(!worker.locked && Number(worker.sent) === 2, "a worker run confined to that notification sends its email and WhatsApp message", JSON.stringify(worker));
  const welcomeMail = mailBlocks(family.email);
  check(welcomeMail.length === 1 && welcomeMail[0].includes("Template: notify:general"), "the family received exactly one email, through the mailer", `${welcomeMail.length}`);
  const welcomeWa = welcomeD.whatsapp ? notifyLogBlock(Number(welcomeD.whatsapp.id)) : "";
  check(/^\S+\s+WHATSAPP\s/.test(welcomeWa) && welcomeWa.includes(`To: +${familyPhone}\n`), "…and the WhatsApp message is in backend/logs/notify.log, to their number", welcomeWa.slice(0, 120));

  const quiet = registration({ name: `${NAME} Quiet`, email: `${P}b@example.test`, phone: `+91 98765 01${phoneTail}`, consent: false });
  r = await reg.post("/api/registrations", quiet);
  const quietId = Number(one("SELECT id FROM devotees WHERE email = ?", [quiet.email])?.id ?? 0);
  created.devotees.push(quietId);
  check(r.status === 201 && quietId > 0, "a family that did not tick consent is registered all the same", `status ${r.status}`);
  check(notifications("devotee_id = ?", [quietId]).length === 0, "…and is told nothing");

  /* ── 2. Bookings ────────────────────────────────────────────────────── */
  section("Seva bookings are acknowledged at the phone given");
  const guest = new Client();
  r = await guest.post("/api/seva-bookings", {
    devotee_name: `${NAME} Booking`,
    phone: "9876543210",
    seva_name: `${NAME} Abhishekam`,
    preferred_date: tomorrow,
    message: "E2E-TRIG booking in English",
    lang: "en",
  });
  const bookingA = Number(r.json?.id ?? 0);
  created.bookings.push(bookingA);
  check(r.status === 201 && JSON.stringify(Object.keys(r.json ?? {})) === '["success","id"]', "a booking answers exactly as before", r.text);
  let received = eventsForEntity("seva_booking", bookingA, "booking.received");
  check(received.length === 1 && received[0].devotee_id === null && received[0].recipient_type === "guest", "booking.received went to the devotee by phone, not to an account", JSON.stringify(received[0] ?? {}));
  check(received[0]?.to_phone === "919876543210" && received[0]?.lang === "en", "…at the number they gave, in the language the site was in", `${received[0]?.to_phone} ${received[0]?.lang}`);
  check(received[0]?.vars?.bookingNumber === `B-${String(bookingA).padStart(6, "0")}`, "…with the booking number B-000000 style", received[0]?.vars?.bookingNumber);
  check(received[0]?.vars?.sevaName === `${NAME} Abhishekam` && /^\d{1,2} \w{3} \d{4}$/.test(received[0]?.vars?.bookingDate ?? ""), "…naming the seva and the date in English", received[0]?.varsRaw);
  check(received[0]?.dedupe_key === `booking:${bookingA}:received`, "…deduped per booking");
  const receivedD = received[0] ? deliveries(received[0].id) : {};
  check(channelsOf(receivedD) === "email,whatsapp" && receivedD.whatsapp?.status === "queued", "…queued on WhatsApp", JSON.stringify(receivedD));
  check(receivedD.email?.status === "skipped" && receivedD.email?.skip_reason === "no email", "…and skipped by email, because a booking gives no address", JSON.stringify(receivedD.email));

  const replay = fixtures("event", {
    event: "booking.received",
    ctx: { to_phone: "919876543210", name: `${NAME} Booking`, lang: "en", entity_id: bookingA, vars: received[0]?.vars ?? {} },
  });
  check(replay.result?.deduped === true, "replaying booking.received is deduped", JSON.stringify(replay));
  check(eventsForEntity("seva_booking", bookingA, "booking.received").length === 1, "…and still one notification");

  r = await guest.post("/api/seva-bookings", {
    devotee_name: `${NAME} Guest`,
    phone: "98765 43210",
    seva_name: `${NAME} Archanai`,
  });
  const bookingG = Number(r.json?.id ?? 0);
  created.bookings.push(bookingG);
  check(r.status === 201, "a booking with a spaced number, no date and no language is accepted", `status ${r.status}`);
  received = eventsForEntity("seva_booking", bookingG, "booking.received");
  check(received.length === 1 && received[0].to_phone === "919876543210" && received[0].lang === "ta", "booking.received went to the normalised number, in Tamil by default", `${received[0]?.to_phone} ${received[0]?.lang}`);
  check(received[0]?.vars?.bookingDate === "தேதி உறுதி செய்யப்பட வேண்டும்", "…saying the date is still to be confirmed", received[0]?.vars?.bookingDate);

  /* ── 3. Admin status changes ────────────────────────────────────────── */
  section("Admin: confirming, re-applying and bulk cancelling bookings");
  const admin = new Admin();
  check((await admin.login()) === 302, "the admin signs in");

  let act = await admin.act("/admin/seva_bookings.php", { action: "set_status", id: bookingA, status: "confirmed" });
  check(act.status === 302, "confirming a booking redirects", `status ${act.status}`);
  check(/Notified 1 devotee\./.test(flashOf(act.page)), "…and the flash says one devotee was notified", flashOf(act.page));
  let confirmed = eventsForEntity("seva_booking", bookingA, "booking.confirmed");
  check(confirmed.length === 1 && confirmed[0].to_phone === "919876543210" && confirmed[0].lang === "en", "booking.confirmed went to the booking's phone, in the booking's language", JSON.stringify(confirmed[0] ?? {}));
  check(confirmed[0]?.vars?.bookingNumber === `B-${String(bookingA).padStart(6, "0")}`, "…with the same booking number");
  const confirmedD = confirmed[0] ? deliveries(confirmed[0].id) : {};
  check(channelsOf(confirmedD) === "email,whatsapp" && confirmedD.whatsapp?.status === "queued", "…queued on WhatsApp", JSON.stringify(confirmedD));

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
  check(cancelledA[0]?.lang === "en" && cancelledA[0]?.vars?.reason === "The temple office has cancelled this booking", "…the English booking's reason in English", JSON.stringify(cancelledA[0]?.vars ?? {}));
  check(cancelledG[0]?.to_phone === "919876543210" && cancelledG[0]?.lang === "ta" && cancelledG[0]?.vars?.reason === "கோயில் அலுவலகம் இந்தப் பதிவை ரத்து செய்துள்ளது", "…the Tamil booking's by phone, with the reason in Tamil", JSON.stringify(cancelledG[0]?.vars ?? {}));
  const cancelledD = cancelledG[0] ? deliveries(cancelledG[0].id) : {};
  check(channelsOf(cancelledD) === "email,sms,whatsapp" && cancelledD.whatsapp?.status === "queued" && cancelledD.sms?.status === "queued", "…on WhatsApp and SMS, a cancellation being important", JSON.stringify(cancelledD));
  act = await admin.act("/admin/seva_bookings.php", { action: "bulk_status", status: "cancelled", "ids[]": [bookingA, bookingG] });
  check(/No bookings changed/.test(flashOf(act.page)) && eventsForEntity("seva_booking", bookingA, "booking.cancelled").length === 1, "re-applying the bulk cancel changes and sends nothing", flashOf(act.page));

  /* ── 4. Donations and receipts ──────────────────────────────────────── */
  section("Donations are acknowledged; receipts are numbered");
  r = await guest.post("/api/donations", {
    name: `${NAME} Donor`,
    phone: "9876543210",
    amount: 1001,
    purpose: "annadanam",
    message: "E2E-TRIG donation",
    lang: "en",
  });
  const donation = Number(r.json?.id ?? 0);
  created.donations.push(donation);
  check(r.status === 201 && JSON.stringify(Object.keys(r.json ?? {})) === '["success","id"]', "a donation answers exactly as before", r.text);
  const receipt = `D-${String(donation).padStart(6, "0")}`;
  created.receipts.push(receipt);
  const dReceived = eventsForEntity("donation", donation, "donation.received");
  check(dReceived.length === 1 && dReceived[0].devotee_id === null && dReceived[0].to_phone === "919876543210" && dReceived[0].lang === "en", "donation.received went to the donor by phone, in English", JSON.stringify(dReceived[0] ?? {}));
  check(dReceived[0]?.vars?.receiptNumber === receipt && dReceived[0]?.vars?.donationAmount === "Rs. 1,001" && dReceived[0]?.vars?.donationPurpose === "Annadanam", "…with the reference, the amount and the purpose", dReceived[0]?.varsRaw);
  check(dReceived[0]?.dedupe_key === `donation:${donation}:received`, "…deduped per donation");

  act = await admin.act("/admin/donations.php", { action: "send_receipt", id: donation });
  check(act.status === 303, "Send receipt posts and redirects", `status ${act.status}`);
  check(new RegExp(`Receipt ${receipt} \\(receipt 1\\)`).test(flashOf(act.page)) && /queued for WhatsApp/.test(flashOf(act.page)), "…and the flash reports receipt 1, queued for WhatsApp", flashOf(act.page));
  check(/Skipped: email \(no email\)/.test(flashOf(act.page)), "…and says email was skipped because a donation gives no address", flashOf(act.page));
  act = await admin.act("/admin/donations.php", { action: "send_receipt", id: donation });
  check(/\(receipt 2\)/.test(flashOf(act.page)), "sending it again is receipt 2", flashOf(act.page));
  check(act.page.includes("Send receipt again (2 sent)"), "…and the row action shows how many were sent");
  const receipts = eventsForEntity("donation", donation, "donation.receipt");
  check(
    receipts.map((n) => n.dedupe_key).join(" ") === `donation:${donation}:receipt:1 donation:${donation}:receipt:2`,
    "the two receipts carry sequences 1 and 2",
    receipts.map((n) => n.dedupe_key).join(" "),
  );
  check(receipts.every((n) => n.to_phone === "919876543210" && n.lang === "en"), "…each to the donor's phone, in the donation's language", JSON.stringify(receipts.map((n) => [n.to_phone, n.lang])));
  check(typeof receipts[0]?.vars?.donationDate === "string" && receipts[0].vars.donationDate.length > 0, "…with the donation date filled in");
  const audit = sql("SELECT detail FROM admin_activity WHERE action = 'donation_receipt' AND subject = ? ORDER BY id", [receipt]);
  check(audit.length === 2 && audit[1].detail.startsWith("receipt 2;"), "…and each send is in the admin activity log", JSON.stringify(audit));

  /* ── 5. Announcements ───────────────────────────────────────────────── */
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
  check(draftId > 0 && /draft email and WhatsApp notification/.test(flashOf(act.page)), "the flash links to the email and WhatsApp draft on the Notifications page", flashOf(act.page));
  const campaign = one("SELECT id, status, category, channels, template_key, created_by, name FROM notification_campaigns WHERE id = ?", [draftId]);
  if (campaign) created.campaigns.push(draftId);
  check(campaign?.status === "draft" && campaign?.category === "announcement", "the campaign is a draft in the announcement category", JSON.stringify(campaign));
  check(campaign?.channels === "email,whatsapp" && campaign?.template_key === "announcement", "…on email and WhatsApp, from the announcement template", `${campaign?.channels} ${campaign?.template_key}`);
  check(campaign?.created_by === "admin", "…created by the signed-in admin");
  const translations = sql("SELECT lang, title FROM notification_campaign_translations WHERE campaign_id = ? ORDER BY lang", [draftId]);
  check(translations.map((t) => t.lang).join(",") === "en,ta" && translations.every((t) => t.title === `${NAME} Festival notice`), "…with Tamil and English words from the announcement", JSON.stringify(translations));
  check(Number(one("SELECT COUNT(*) AS c FROM notifications WHERE campaign_id = ?", [draftId])?.c) === 0, "nothing was queued or sent");

  act = await admin.act("/admin/announcements.php", { action: "save", title: `${NAME} Plain notice`, body: "" });
  check(
    Number(one("SELECT COUNT(*) AS c FROM notification_campaigns WHERE name = ?", [`Announcement: ${NAME} Plain notice`])?.c) === 0,
    "an announcement without the checkbox makes no campaign",
  );

  /* ── 6. Contact form ────────────────────────────────────────────────── */
  section("A contact message raises contact.received for the temple office");
  const visitor = new Client();
  const note = `E2E-TRIG ${RUN}: could we book the hall for a naming ceremony?`;
  r = await visitor.post("/api/contact", { name: `${NAME} Visitor`, phone: "98765 43211", phoneCountry: "IN", message: note });
  check(r.status === 201 && r.text === '{"success":true}', "the contact form answers 201 {\"success\":true}", `status ${r.status} ${r.text.slice(0, 160)}`);
  const messageId = Number(one("SELECT id FROM contact_messages WHERE name = ?", [`${NAME} Visitor`])?.id ?? 0);
  created.contacts.push(messageId);
  check(messageId > 0, "the message is saved");

  const office = eventsForEntity("contact_message", messageId, "contact.received");
  check(office.length === 1, "contact.received created one notification: one per address in CONTACT_NOTIFY_EMAIL", `${office.length}`);
  check(office[0]?.to_email === OFFICE && office[0]?.devotee_id === null && office[0]?.recipient_type === "guest" && office[0]?.to_phone === null, "…addressed to the office, not to any family or phone", JSON.stringify(office[0] ?? {}));
  check(office[0]?.template_key === "contact_received" && office[0]?.category === "office" && office[0]?.lang === "en", "…from the contact_received template, in the office category, in English", `${office[0]?.template_key} ${office[0]?.category} ${office[0]?.lang}`);
  check(new RegExp(`^contact:${messageId}:received:e[0-9a-f]{12}$`).test(office[0]?.dedupe_key ?? ""), "…deduped per message and address", office[0]?.dedupe_key);
  check(
    office[0]?.vars?.senderName === `${NAME} Visitor` && office[0]?.vars?.senderPhone === "+919876543211" && office[0]?.vars?.message === note && typeof office[0]?.vars?.receivedAt === "string" && office[0].vars.receivedAt.length > 5,
    "…carrying who wrote, their number, the message and when",
    office[0]?.varsRaw,
  );
  check(office[0]?.title.includes(`${NAME} Visitor`) && office[0]?.body.includes(note) && office[0]?.body.includes("+919876543211"), "…worded with the name, the number and the message", `${office[0]?.title}`);
  const officeD = office[0] ? deliveries(office[0].id) : {};
  check(channelsOf(officeD) === "email" && officeD.email?.status === "queued", "…queued by email only", JSON.stringify(officeD));

  const replayOffice = fixtures("event", {
    event: "contact.received",
    ctx: { entity_id: messageId, to_email: OFFICE, name: "Temple office", lang: "en", vars: office[0]?.vars ?? {} },
  });
  check(replayOffice.result?.deduped === true, "raising contact.received again for the same address is deduped", JSON.stringify(replayOffice));
  check(eventsForEntity("contact_message", messageId, "contact.received").length === 1, "…and still one notification");

  const officeWorker = office[0] ? workerFor(office[0].id) : {};
  check(!officeWorker.locked && Number(officeWorker.sent) === 1, "a worker run confined to it sends the office's email", JSON.stringify(officeWorker));
  const officeMail = mailBlocks(OFFICE).filter((b) => b.includes(note));
  check(officeMail.length === 1 && officeMail[0].includes("Template: notify:office"), "…which is in the mail log, to the office, with the visitor's words", `${officeMail.length}`);

  r = await visitor.post("/api/contact", { name: `${NAME} Bot`, phone: "98765 43212", message: "E2E-TRIG honeypot", hp_token: "http://spam.example" });
  check(r.status === 201 && r.text === '{"success":true}', "a bot that fills the honeypot is answered as if saved", `status ${r.status} ${r.text.slice(0, 120)}`);
  check(Number(one("SELECT COUNT(*) AS c FROM contact_messages WHERE name = ?", [`${NAME} Bot`])?.c) === 0, "…but nothing is saved, so the office is not told");
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
    `SELECT (SELECT COUNT(*) FROM devotees WHERE email LIKE ? OR name LIKE ?) AS devotees,
            (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?) AS bookings,
            (SELECT COUNT(*) FROM donations WHERE name LIKE ?) AS donations,
            (SELECT COUNT(*) FROM contact_messages WHERE name LIKE ?) AS contacts,
            (SELECT COUNT(*) FROM announcements WHERE title LIKE ?) AS announcements,
            (SELECT COUNT(*) FROM notification_campaigns WHERE name LIKE ?) AS campaigns,
            (SELECT COUNT(*) FROM mail_log WHERE to_email LIKE ? OR (to_email = ? AND subject LIKE ?)) AS mails,
            (SELECT COUNT(*) FROM rate_limits WHERE bucket LIKE ?) AS buckets`,
    [`${P}%`, `${NAME}%`, `${NAME}%`, `${NAME}%`, `${NAME}%`, `${NAME}%`, `Announcement: ${NAME}%`, `${P}%`, OFFICE, `%${NAME}%`, `%:${XFF}`],
  );
  const orphans = (type, ids) =>
    ids.length ? Number(one(`SELECT COUNT(*) AS c FROM notifications WHERE entity_type = ? AND entity_id IN (${marks(ids)})`, [type, ...ids])?.c) : 0;
  const guestLeft = orphans("seva_booking", created.bookings) + orphans("donation", created.donations) + orphans("contact_message", created.contacts);
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
