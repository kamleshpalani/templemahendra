#!/usr/bin/env node
/**
 * tests/notify-triggers.mjs — the places the site tells a devotee something,
 * end to end through the real endpoints, the admin pages and MySQL.
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
 *     node tests/notify-triggers.mjs http://127.0.0.1:8002
 *
 * The server runs with its default drivers: email through the mailer into
 * backend/logs/mail.log, WhatsApp, SMS and push through the log driver into
 * backend/logs/notify.log. So the verification link and the one-time code are
 * read back from those logs rather than faked.
 *
 * It proves: registering creates the in-app welcome and sends the confirmation
 * email (the link on its own line, never stored); confirming creates one
 * "email confirmed" notification and no second welcome email; a profile change
 * names the changed fields and never their values; a new phone number loses its
 * verification; the phone code flow works, counts wrong tries and is limited;
 * bookings and donations are acknowledged for accounts and guests, deduped on
 * replay; admin status changes notify once per booking (single and bulk);
 * "Send receipt" numbers each receipt; an announcement with "Also notify
 * devotees" makes a draft campaign and sends nothing; a password reset or
 * change sends password_changed.
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
const NOTIFY_LOG = resolve(ROOT, "backend/logs/notify.log");

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
function tokenFor(email, path) {
  for (const b of mailBlocks(email).reverse()) {
    const m = b.match(new RegExp(`https?://\\S*${path.replace(/[/?]/g, "\\$&")}\\?token=([a-f0-9]{64})`));
    if (m) return { token: m[1], block: b };
  }
  return { token: null, block: "" };
}
/** The one-time code the log driver recorded for an SMS delivery. */
function otpFromNotifyLog(deliveryId) {
  const text = existsSync(NOTIFY_LOG) ? readFileSync(NOTIFY_LOG, "utf8") : "";
  const blocks = text.split("===== ").filter((b) => new RegExp(`delivery #${deliveryId}\\s`).test(b));
  const last = blocks.pop();
  if (!last) return null;
  const afterTitle = last.slice(last.indexOf("\nTitle:"));
  return afterTitle.match(/(?:^|\D)(\d{6})(?:\D|$)/)?.[1] ?? null;
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

  const devoteeIds = sql("SELECT id FROM devotees WHERE email LIKE ?", [`${emailPrefix}%`]).map((r) => Number(r.id));
  for (const id of devoteeIds) {
    sql("DELETE FROM rate_limits WHERE bucket IN (?, ?, ?)", [`otp-issue-15m:d${id}`, `otp-issue-day:d${id}`, `otp-confirm:d${id}`]);
  }
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

  /* ── 1. Registration ────────────────────────────────────────────────── */
  section("Registration: in-app welcome and the confirmation email");
  const user = {
    name: `${NAME} Kavitha`,
    email: `${P}a@example.test`,
    password: "Kolam99Deep",
    phone: `919876500${phoneTail}`,
    phoneCountry: "IN",
    country: "IN",
    state: "TN",
    city: "Pudupatti",
  };
  const reg = new Client();
  await reg.get("/api/auth/me");
  let r = await reg.post("/api/auth/register", user);
  check(r.status === 201, "registering through the real endpoint answers 201", `status ${r.status} ${r.text.slice(0, 160)}`);
  check(r.json?.emailDelivery === "unavailable", "with no mail transport the reply says email is unavailable", r.json?.emailDelivery);

  const devoteeId = Number(one("SELECT id FROM devotees WHERE email = ?", [user.email])?.id ?? 0);
  created.devotees.push(devoteeId);
  check(devoteeId > 0, "the account exists");

  const welcome = eventsFor(devoteeId, "account.registered");
  check(welcome.length === 1, "account.registered created one notification", `${welcome.length}`);
  const welcomeD = welcome[0] ? deliveries(welcome[0].id) : {};
  check(welcomeD.inapp?.status === "sent" && Number(welcome[0]?.show_in_app) === 1, "…visible in the bell straight away");
  check(Object.keys(welcomeD).join(",") === "inapp", "…and in-app only (no second email at sign-up)", Object.keys(welcomeD).join(","));
  check(welcome[0]?.dedupe_key === `devotee:${devoteeId}:welcome`, "…deduped per devotee", welcome[0]?.dedupe_key);

  const verification = eventsFor(devoteeId, "account.email_verification");
  check(verification.length === 1, "account.email_verification created one notification", `${verification.length}`);
  const verificationD = verification[0] ? deliveries(verification[0].id) : {};
  check(verificationD.email?.status === "sent" && verificationD.email?.provider === "mailer", "…whose email went out through the mailer inside the request", JSON.stringify(verificationD.email));
  check(!verificationD.inapp, "…with no in-app copy");

  const { token: verifyToken, block: verifyBlock } = tokenFor(user.email, "/verify-email");
  check(!!verifyToken, "the confirmation link is in the mail log");
  check(/\nhttps?:\/\/\S*\/verify-email\?token=[a-f0-9]{64}\n/.test(verifyBlock), "…on a line of its own in the plain-text email");
  check(
    !!verifyToken && !verification[0]?.varsRaw.includes(verifyToken) && !verification[0]?.body.includes(verifyToken),
    "…and the link was never stored in the notification",
  );
  check(JSON.stringify(verification[0]?.vars?._secret) === '["verifyUrl"]', "…only the name of the secret is kept", verification[0]?.varsRaw);

  /* ── 2. Confirming the address ──────────────────────────────────────── */
  section("Confirming the email: one notification, no second welcome email");
  r = await reg.post("/api/auth/verify", { token: verifyToken });
  check(r.status === 200 && r.json?.user?.verified === true, "the link confirms the address", `status ${r.status}`);
  check(r.json?.user?.phoneVerified === false, "devoteePublic carries phoneVerified", JSON.stringify(r.json?.user));

  const verified = eventsFor(devoteeId, "account.email_verified");
  check(verified.length === 1, "account.email_verified created one notification", `${verified.length}`);
  const verifiedD = verified[0] ? deliveries(verified[0].id) : {};
  check(verifiedD.inapp?.status === "sent", "…in the bell");
  check(verifiedD.email?.status === "queued", "…and one email queued for the worker", JSON.stringify(verifiedD.email));
  check(!mailBlocks(user.email).some((b) => b.includes("Template: welcome")), "the old separate welcome email was not sent");

  const worker = php(["backend/bin/notify_worker.php", `--notification-ids=${verified[0]?.id ?? 0}`, "--skip-campaigns", "--skip-reminders", "--json"]);
  if (worker.run_id) created.workerRuns.push(Number(worker.run_id));
  check(!worker.locked && Number(worker.sent) === 1, "a worker run confined to that notification sends its email", JSON.stringify(worker));
  check(mailBlocks(user.email).length === 2, "the devotee received exactly two emails: the link and the confirmation", `${mailBlocks(user.email).length}`);

  const replayVerified = fixtures("event", { event: "account.email_verified", ctx: { devotee_id: devoteeId } });
  check(replayVerified.result?.deduped === true, "firing account.email_verified again is deduped", JSON.stringify(replayVerified));

  /* ── 3. Sign in ─────────────────────────────────────────────────────── */
  section("Sign in");
  const dev = new Client();
  await dev.get("/api/auth/me");
  r = await dev.post("/api/auth/login", { email: user.email, password: user.password });
  check(r.status === 200 && r.json?.user?.email === user.email, "the devotee signs in", `status ${r.status}`);

  /* ── 4. Profile ─────────────────────────────────────────────────────── */
  section("Profile changes name the fields, never the values");
  r = await dev.post("/api/account/profile", {
    name: `${NAME} Kavitha Devi`,
    phone: user.phone,
    phoneCountry: "IN",
    country: "IN",
    state: "TN",
    city: "Tenkasi",
  });
  check(r.status === 200, "the profile saves", `status ${r.status} ${r.text.slice(0, 120)}`);
  let profile = eventsFor(devoteeId, "account.profile_updated");
  check(profile.length === 1, "account.profile_updated created one notification", `${profile.length}`);
  check(profile[0]?.vars?.changedKeys === "name,city", "…naming exactly the changed fields", profile[0]?.vars?.changedKeys);
  check(typeof profile[0]?.vars?.changedFields === "string" && profile[0].vars.changedFields.length > 0, "…as a readable list", profile[0]?.vars?.changedFields);
  check(
    !profile[0]?.varsRaw.includes("Tenkasi") && !profile[0]?.varsRaw.includes("Kavitha Devi") && !profile[0]?.body.includes("Tenkasi"),
    "…and holding none of the new values",
    profile[0]?.varsRaw,
  );
  const profileD = profile[0] ? deliveries(profile[0].id) : {};
  check(profileD.inapp?.status === "sent" && profileD.email?.status === "queued", "…in the bell and by email", JSON.stringify(profileD));

  r = await dev.post("/api/account/profile", {
    name: `${NAME} Kavitha Devi`,
    phone: user.phone,
    phoneCountry: "IN",
    country: "IN",
    state: "TN",
    city: "Tenkasi",
  });
  check(r.status === 200 && eventsFor(devoteeId, "account.profile_updated").length === 1, "saving without changes notifies nobody");

  /* ── 5. A new phone number loses its verification ───────────────────── */
  section("Changing the phone number clears its verification");
  sql("UPDATE devotees SET phone_verified_at = UTC_TIMESTAMP() WHERE id = ?", [devoteeId]);
  r = await dev.get("/api/auth/me");
  check(r.json?.user?.phoneVerified === true, "a verified number reads phoneVerified: true");
  const newPhone = `919876511${phoneTail}`;
  r = await dev.post("/api/account/profile", {
    name: `${NAME} Kavitha Devi`,
    phone: newPhone,
    phoneCountry: "IN",
    country: "IN",
    state: "TN",
    city: "Tenkasi",
  });
  check(r.status === 200 && r.json?.user?.phoneVerified === false, "saving a different number answers phoneVerified: false", JSON.stringify(r.json?.user));
  check(one("SELECT phone_verified_at FROM devotees WHERE id = ?", [devoteeId])?.phone_verified_at === null, "…and phone_verified_at is cleared");
  profile = eventsFor(devoteeId, "account.profile_updated");
  check(profile.length === 2 && profile[1].vars.changedKeys === "phone", "…with a profile notice naming the phone", profile.map((p) => p.vars.changedKeys).join(" / "));
  check(!profile[1]?.varsRaw.includes(newPhone.slice(-6)), "…that does not repeat the new number");

  /* ── 6. Verifying the phone with a code ─────────────────────────────── */
  section("Phone verification with a one-time code");
  r = await dev.post("/api/account/phone-verify-start", {});
  check(r.status === 200 && r.json?.ok === true, "phone-verify-start answers 200", `status ${r.status} ${r.text.slice(0, 160)}`);
  check(r.json?.channel === "sms" && r.json?.expiresIn === 600, "…by SMS, valid for ten minutes", JSON.stringify(r.json));
  check(typeof r.json?.message === "string" && !r.json.message.includes(newPhone), "…with a message that masks the number", r.json?.message);

  const otpDelivery = one(
    `SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
      WHERE n.devotee_id = ? AND n.event = 'phone.otp' AND d.channel = 'sms' ORDER BY d.id DESC LIMIT 1`,
    [devoteeId],
  );
  const code = otpDelivery ? otpFromNotifyLog(Number(otpDelivery.id)) : null;
  check(!!code, "the code appears in backend/logs/notify.log", `delivery ${otpDelivery?.id}`);
  const otpNotif = eventsFor(devoteeId, "phone.otp").pop();
  check(!!code && !otpNotif?.varsRaw.includes(code) && !otpNotif?.body.includes(code), "…and never in the stored notification");

  const wrong = code === "000000" ? "111111" : "000000";
  r = await dev.post("/api/account/phone-verify-confirm", { code: wrong });
  check(r.status === 422 && r.json?.attemptsLeft === 4 && !!r.json?.fields?.code, "a wrong code is refused with the tries left", `status ${r.status} ${r.text.slice(0, 160)}`);

  r = await dev.post("/api/account/phone-verify-confirm", { code: "12ab" });
  check(r.status === 422 && r.json?.attemptsLeft === null, "a malformed code is refused without spending a try", r.text.slice(0, 160));

  r = await dev.post("/api/account/phone-verify-confirm", { code });
  check(r.status === 200 && r.json?.user?.phoneVerified === true, "the right code verifies the number", `status ${r.status} ${r.text.slice(0, 160)}`);
  check(eventsFor(devoteeId, "phone.verified").length === 1, "…and phone.verified is in the bell");

  r = await dev.post("/api/account/phone-verify-start", {});
  check(r.status === 200 && r.json?.alreadyVerified === true, "asking again for a verified number sends nothing", r.text.slice(0, 160));

  sql("UPDATE devotees SET phone_verified_at = NULL WHERE id = ?", [devoteeId]);
  r = await dev.post("/api/account/phone-verify-start", {});
  const second = r.status;
  r = await dev.post("/api/account/phone-verify-start", {});
  const third = r.status;
  r = await dev.post("/api/account/phone-verify-start", {});
  check(second === 200 && third === 200, "the second and third codes within 15 minutes are sent", `${second}, ${third}`);
  check(r.status === 429 && r.json?.code === "rate_limited" && r.json?.retryAfter > 0, "the fourth within 15 minutes is refused (429) with retryAfter", `status ${r.status} ${r.text.slice(0, 160)}`);

  /* ── 7. Bookings ────────────────────────────────────────────────────── */
  section("Seva bookings are acknowledged");
  r = await dev.post("/api/seva-bookings", {
    devotee_name: `${NAME} Booking`,
    phone: "9876543210",
    seva_name: `${NAME} Abhishekam`,
    preferred_date: tomorrow,
    message: "E2E-TRIG signed-in booking",
  });
  const bookingA = Number(r.json?.id ?? 0);
  created.bookings.push(bookingA);
  check(r.status === 201 && JSON.stringify(Object.keys(r.json ?? {})) === '["success","id"]', "a signed-in booking answers exactly as before", r.text);
  let received = eventsForEntity("seva_booking", bookingA, "booking.received");
  check(received.length === 1 && Number(received[0].devotee_id) === devoteeId, "booking.received went to the account", JSON.stringify(received[0] ?? {}));
  check(received[0]?.vars?.bookingNumber === `B-${String(bookingA).padStart(6, "0")}`, "…with the booking number B-000000 style", received[0]?.vars?.bookingNumber);
  check(received[0]?.dedupe_key === `booking:${bookingA}:received`, "…deduped per booking");
  const receivedD = received[0] ? deliveries(received[0].id) : {};
  check(receivedD.inapp?.status === "sent" && receivedD.email?.status === "queued" && receivedD.whatsapp?.status === "queued", "…in the bell, by email and on WhatsApp", JSON.stringify(receivedD));

  const replay = fixtures("event", {
    event: "booking.received",
    ctx: { devotee_id: devoteeId, entity_id: bookingA, vars: received[0]?.vars ?? {} },
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
  check(guestD.inapp?.skip_reason === "no account" && guestD.whatsapp?.status === "queued", "…on WhatsApp, with no in-app copy", JSON.stringify(guestD));

  /* ── 8. Admin status changes ────────────────────────────────────────── */
  section("Admin: confirming, re-applying and bulk cancelling bookings");
  const admin = new Admin();
  check((await admin.login()) === 302, "the admin signs in");

  let act = await admin.act("/admin/seva_bookings.php", { action: "set_status", id: bookingA, status: "confirmed" });
  check(act.status === 302, "confirming a booking redirects", `status ${act.status}`);
  check(/Notified 1 devotee\./.test(flashOf(act.page)), "…and the flash says one devotee was notified", flashOf(act.page));
  let confirmed = eventsForEntity("seva_booking", bookingA, "booking.confirmed");
  check(confirmed.length === 1 && Number(confirmed[0].devotee_id) === devoteeId, "booking.confirmed went to the account");
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
    message: "E2E-TRIG signed-in donation",
  });
  const donation = Number(r.json?.id ?? 0);
  created.donations.push(donation);
  check(r.status === 201 && JSON.stringify(Object.keys(r.json ?? {})) === '["success","id"]', "a donation answers exactly as before", r.text);
  const receipt = `D-${String(donation).padStart(6, "0")}`;
  created.receipts.push(receipt);
  const dReceived = eventsForEntity("donation", donation, "donation.received");
  check(dReceived.length === 1 && Number(dReceived[0].devotee_id) === devoteeId, "donation.received went to the account");
  check(dReceived[0]?.vars?.receiptNumber === receipt && dReceived[0]?.vars?.donationAmount === "Rs. 1,001", "…with the reference and the amount", dReceived[0]?.varsRaw);

  act = await admin.act("/admin/donations.php", { action: "send_receipt", id: donation });
  check(act.status === 303, "Send receipt posts and redirects", `status ${act.status}`);
  check(new RegExp(`Receipt ${receipt} \\(receipt 1\\)`).test(flashOf(act.page)) && /queued for email/.test(flashOf(act.page)), "…and the flash reports receipt 1 and its channels", flashOf(act.page));
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
  check(campaign?.channels === "inapp,push" && campaign?.template_key === "announcement", "…on in-app and push, from the announcement template");
  check(campaign?.created_by === "admin", "…created by the signed-in admin");
  const translations = sql("SELECT lang, title FROM notification_campaign_translations WHERE campaign_id = ? ORDER BY lang", [draftId]);
  check(translations.map((t) => t.lang).join(",") === "en,ta" && translations.every((t) => t.title === `${NAME} Festival notice`), "…with Tamil and English words from the announcement", JSON.stringify(translations));
  check(Number(one("SELECT COUNT(*) AS c FROM notifications WHERE campaign_id = ?", [draftId])?.c) === 0, "nothing was queued or sent");

  act = await admin.act("/admin/announcements.php", { action: "save", title: `${NAME} Plain notice`, body: "" });
  check(
    Number(one("SELECT COUNT(*) AS c FROM notification_campaigns WHERE name = ?", [`Announcement: ${NAME} Plain notice`])?.c) === 0,
    "an announcement without the checkbox makes no campaign",
  );

  /* ── 11. Passwords ──────────────────────────────────────────────────── */
  section("A password reset or change sends password_changed");
  const anon = new Client();
  await anon.get("/api/auth/me");
  r = await anon.post("/api/auth/forgot", { email: user.email });
  check(r.status === 200, "forgot-password answers 200", `status ${r.status}`);
  const resetNotif = eventsFor(devoteeId, "security.password_reset");
  check(resetNotif.length === 1 && deliveries(resetNotif[0].id).email?.status === "sent", "security.password_reset sent its email inside the request");
  const { token: resetToken, block: resetBlock } = tokenFor(user.email, "/reset-password");
  check(!!resetToken && /\nhttps?:\/\/\S*\/reset-password\?token=[a-f0-9]{64}\n/.test(resetBlock), "the reset link is on its own line in the mail log");
  r = await anon.post("/api/auth/reset", { token: resetToken, password: "Nandri88Kolam" });
  check(r.status === 200, "the reset sets a new password", `status ${r.status} ${r.text.slice(0, 120)}`);
  let changed = eventsFor(devoteeId, "security.password_changed");
  check(changed.length === 1, "security.password_changed created one notification", `${changed.length}`);
  const changedD = changed[0] ? deliveries(changed[0].id) : {};
  check(changedD.inapp?.status === "sent" && changedD.email?.status === "sent", "…in the bell and emailed at once", JSON.stringify(changedD));
  check(typeof changed[0]?.vars?.changedAt === "string" && changed[0].vars.changedAt.length > 5, "…saying when", changed[0]?.vars?.changedAt);

  r = await anon.post("/api/account/password", { currentPassword: "Nandri88Kolam", newPassword: "Maadam77Vilakku" });
  check(r.status === 200, "changing the password from the account page works", `status ${r.status} ${r.text.slice(0, 120)}`);
  changed = eventsFor(devoteeId, "security.password_changed");
  check(changed.length === 2, "…and sends a second password_changed", `${changed.length}`);
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
