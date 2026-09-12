#!/usr/bin/env node
/**
 * tests/devotee-auth.mjs — devotee accounts, email and public search, end to end
 * against the real PHP + MySQL stack.
 *
 *   node tests/devotee-auth.mjs [http://127.0.0.1:8000]
 *
 * It proves the things that actually matter for an account system: CSRF is
 * enforced, the password policy is enforced server-side, tokens are single-use,
 * the endpoints do not reveal who has an account, rate limits bite, records are
 * scoped to their owner, and one devotee cannot read another's history.
 *
 * Email is read from backend/logs/mail.log, which is where the mailer writes
 * when MAIL_TRANSPORT is unset — so the verification and reset links are
 * exercised for real rather than faked.
 *
 * Creates accounts as e2e-auth-<run>-*@example.test and rows named E2E-AUTH-*.
 * Run it against a disposable database. The cleanup SQL is printed at the end.
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIL_LOG = resolve(HERE, "../backend/logs/mail.log");

const RUN = Date.now().toString(36);
const A = { name: "E2E-AUTH Ammu Devi", email: `e2e-auth-${RUN}-a@example.test`, password: "Kolam99Deep" };
const B = { name: "E2E-AUTH Bala Raja", email: `e2e-auth-${RUN}-b@example.test`, password: "Vilakku42Raja" };

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
function section(title) {
  console.log(`\n── ${title}`);
}

/* ── A browser-ish client: one cookie jar, one CSRF token ─────────────── */
class Client {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.csrf = "";
  }

  #store(res) {
    // Node exposes every Set-Cookie separately through getSetCookie().
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async req(method, path, body) {
    const headers = { Accept: "application/json" };
    if (this.cookies.size) headers.Cookie = this.cookieHeader;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      if (this.csrf) headers["X-CSRF-Token"] = this.csrf;
    }
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    this.#store(res);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* a non-JSON body is itself a finding; callers assert on json */
    }
    if (json?.csrf) this.csrf = json.csrf;
    return { status: res.status, json, text };
  }

  get = (p) => this.req("GET", p);
  post = (p, b = {}) => this.req("POST", p, b);

  /** Pick up a session cookie and a CSRF token the way the SPA does on boot. */
  async boot() {
    const r = await this.get("/api/auth/me");
    return r;
  }
}

/* ── Reading the mail the server "sent" ───────────────────────────────── */
function mailLog() {
  return existsSync(MAIL_LOG) ? readFileSync(MAIL_LOG, "utf8") : "";
}
/** The newest link of a kind addressed to this recipient. */
function linkFor(email, path) {
  const blocks = mailLog().split("\n===== ").filter(Boolean);
  const mine = blocks.filter((b) => b.includes(`To: ${email}`));
  for (const b of mine.reverse()) {
    const m = b.match(new RegExp(`https?://\\S*${path}\\?token=([a-f0-9]{64})`));
    if (m) return m[1];
  }
  return null;
}
function mailCountFor(email, template) {
  return mailLog()
    .split("\n===== ")
    .filter((b) => b.includes(`To: ${email}`) && b.includes(`Template: ${template}`)).length;
}

async function main() {
  console.log(`Devotee accounts, email and search — ${BASE}`);
  console.log(`run id ${RUN}\n`);

  /* ── 1. Boot and CSRF ─────────────────────────────────────────────── */
  section("Session and CSRF");
  const a = new Client("A");
  let r = await a.boot();
  check(r.status === 200, "GET /auth/me answers 200 for a guest", `status ${r.status}`);
  check(r.json?.user === null, "guest sees user: null");
  check(r.json?.accountsEnabled === true, "accountsEnabled is true (migration 003 applied)");
  check(typeof r.json?.csrf === "string" && r.json.csrf.length >= 32, "a CSRF token is issued");

  // A client that has a session but deliberately sends no CSRF header.
  const noCsrf = new Client("no-csrf");
  await noCsrf.boot();
  noCsrf.csrf = "";
  r = await noCsrf.post("/api/auth/register", { ...A, email: `x-${RUN}@example.test` });
  check(r.status === 419, "register without the CSRF header is refused (419)", `status ${r.status}`);
  check(r.json?.code === "csrf", "and says why");

  noCsrf.csrf = "0".repeat(64);
  r = await noCsrf.post("/api/auth/register", { ...A, email: `x-${RUN}@example.test` });
  check(r.status === 419, "register with a forged CSRF token is refused (419)", `status ${r.status}`);

  /* ── 2. Registration and the password policy ──────────────────────── */
  section("Registration");
  r = await a.post("/api/auth/register", { ...A, password: "short1A" });
  check(r.status === 422, "a short password is rejected server-side", `status ${r.status}`);
  check(!!r.json?.fields?.password, "the password field carries the reason");

  r = await a.post("/api/auth/register", { ...A, password: "templeisgreat1A" });
  check(r.status === 422 && /guess/i.test(r.json?.fields?.password ?? ""), "a password containing 'temple' is rejected");

  r = await a.post("/api/auth/register", { ...A, email: "not-an-email" });
  check(r.status === 422 && !!r.json?.fields?.email, "an invalid email address is rejected");

  r = await a.post("/api/auth/register", { ...A, phone: "12" });
  check(r.status === 422 && !!r.json?.fields?.phone, "a two-digit phone number is rejected");

  r = await a.post("/api/auth/register", { ...A, phone: "9876543210" });
  check(r.status === 201, "a valid registration is accepted (201)", `status ${r.status} ${r.text.slice(0, 120)}`);
  const firstReply = JSON.stringify({ ok: r.json?.ok, message: r.json?.message });
  check(r.json?.emailDelivery === "unavailable", "with MAIL_TRANSPORT unset, emailDelivery says unavailable");
  check(mailCountFor(A.email, "verify") === 1, "a verification email was written to the mail log");

  const verifyToken = linkFor(A.email, "/verify-email");
  check(!!verifyToken, "the verification link carries a 64-hex token");

  /* ── 3. Enumeration protection ────────────────────────────────────── */
  section("Enumeration protection");
  r = await a.post("/api/auth/register", { ...A, phone: "9876543210" });
  check(r.status === 201, "registering an address that already exists still answers 201");
  check(
    JSON.stringify({ ok: r.json?.ok, message: r.json?.message }) === firstReply,
    "…with a byte-identical body, so the endpoint reveals nothing",
  );
  check(mailCountFor(A.email, "already_registered") === 1, "the real owner was told instead");
  check(mailCountFor(A.email, "verify") === 1, "and no second verification token was issued");

  /* ── 4. Sign-in ───────────────────────────────────────────────────── */
  section("Sign in");
  r = await a.post("/api/auth/login", { email: A.email, password: "Wrong99Pass" });
  check(r.status === 401, "the wrong password is refused (401)", `status ${r.status}`);
  check(!/exist|found|unknown/i.test(r.json?.error ?? ""), "the message does not say whether the account exists");

  r = await a.post("/api/auth/login", { email: A.email, password: A.password });
  check(r.status === 200 && r.json?.user?.email === A.email, "the right password signs in", `status ${r.status}`);
  check(r.json?.user?.verified === false, "the account is not yet confirmed");
  check(!("pass_hash" in (r.json?.user ?? {})), "the password hash is never sent to the client");

  r = await a.get("/api/auth/me");
  check(r.json?.user?.email === A.email, "the session survives the next request");

  /* ── 5. Email confirmation ────────────────────────────────────────── */
  section("Email confirmation");
  r = await a.post("/api/auth/verify", { token: "z".repeat(64) });
  check(r.status === 400, "a token of the right shape but wrong value is refused", `status ${r.status}`);

  r = await a.post("/api/auth/verify", { token: verifyToken });
  check(r.status === 200 && r.json?.user?.verified === true, "the real token confirms the address", `status ${r.status}`);

  r = await a.post("/api/auth/verify", { token: verifyToken });
  check(r.status === 400 && r.json?.code === "token_invalid", "the same token cannot be used twice");

  r = await a.post("/api/auth/resend");
  check(r.json?.message?.includes("already confirmed"), "resend on a confirmed account says so instead of sending");

  /* ── 6. The account's own records ─────────────────────────────────── */
  section("Account records");
  r = await a.get("/api/account/summary");
  check(r.status === 200, "summary loads", `status ${r.status}`);
  check(r.json?.bookings === 0 && r.json?.donations === 0, "a new account starts empty");

  // A booking made while signed in must land in this devotee's history.
  const bookingName = `E2E-AUTH Booking ${RUN}`;
  r = await a.post("/api/seva-bookings", {
    devotee_name: bookingName,
    phone: "9876543210",
    seva_name: "E2E-AUTH Abhishekam",
    preferred_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    message: "E2E-AUTH signed-in booking",
  });
  check(r.status === 201, "a seva booking is accepted while signed in", `status ${r.status}`);

  r = await a.post("/api/donations", {
    name: bookingName,
    phone: "9876543210",
    amount: 501,
    purpose: "E2E-AUTH",
    message: "E2E-AUTH signed-in donation",
  });
  check(r.status === 201, "a donation is accepted while signed in", `status ${r.status}`);

  r = await a.get("/api/account/bookings");
  check(Array.isArray(r.json) && r.json.length === 1, "the booking appears in the devotee's own history", `${r.text.slice(0, 140)}`);
  check(r.json?.[0]?.seva_name === "E2E-AUTH Abhishekam", "…with the right seva");

  r = await a.get("/api/account/donations");
  check(Array.isArray(r.json) && r.json.length === 1, "the donation appears too");
  check(Number(r.json?.[0]?.amount) === 501, "…with the right amount");

  r = await a.get("/api/account/summary");
  check(r.json?.bookings === 1 && r.json?.donations === 1, "the summary counts both");
  check(Number(r.json?.donated) === 501, "and totals the amount given");
  check(r.json?.nextBooking?.seva_name === "E2E-AUTH Abhishekam", "the next upcoming seva is surfaced");

  /* ── 7. Profile and password ──────────────────────────────────────── */
  section("Profile and password");
  r = await a.post("/api/account/profile", { name: "E2E-AUTH Ammu Devi Renamed", phone: "9123456780" });
  check(r.status === 200 && r.json?.user?.name === "E2E-AUTH Ammu Devi Renamed", "the profile saves", `status ${r.status}`);
  check(r.json?.user?.phone === "9123456780", "…including the phone number");

  r = await a.post("/api/account/profile", { name: "x" });
  check(r.status === 422 && !!r.json?.fields?.name, "a one-letter name is rejected");

  r = await a.post("/api/account/password", { currentPassword: "Wrong99Pass", newPassword: "Maadam77Vilakku" });
  check(r.status === 422 && !!r.json?.fields?.currentPassword, "changing the password needs the current one");

  r = await a.post("/api/account/password", { currentPassword: A.password, newPassword: "weak" });
  check(r.status === 422 && !!r.json?.fields?.newPassword, "the new password must meet the policy");

  const newPassword = "Maadam77Vilakku";
  r = await a.post("/api/account/password", { currentPassword: A.password, newPassword });
  check(r.status === 200, "the password changes with the right current one", `status ${r.status}`);

  const a2 = new Client("A-again");
  await a2.boot();
  r = await a2.post("/api/auth/login", { email: A.email, password: newPassword });
  check(r.status === 200, "the new password signs in");
  r = await a2.post("/api/auth/login", { email: A.email, password: A.password });
  check(r.status === 401, "the old password no longer works");

  /* ── 8. Forgot and reset ──────────────────────────────────────────── */
  section("Forgot and reset");
  const c = new Client("C");
  await c.boot();
  r = await c.post("/api/auth/forgot", { email: A.email });
  const vagueKnown = r.json?.message;
  check(r.status === 200, "forgot-password answers 200 for a known address", `status ${r.status}`);

  r = await c.post("/api/auth/forgot", { email: `nobody-${RUN}@example.test` });
  check(r.status === 200 && r.json?.message === vagueKnown, "…and identically for an unknown one");
  check(mailCountFor(`nobody-${RUN}@example.test`, "reset") === 0, "no email is sent for an address with no account");

  const resetToken = linkFor(A.email, "/reset-password");
  check(!!resetToken, "the reset link carries a 64-hex token");

  r = await c.post("/api/auth/reset", { token: resetToken, password: "weak" });
  check(r.status === 422 && r.json?.code === "weak_password", "a weak new password is refused");
  check(!!r.json?.hint, "…and the reply warns that the link has now been spent");

  r = await c.post("/api/auth/reset", { token: resetToken, password: "Nandri88Kolam" });
  check(r.status === 400 && r.json?.code === "token_invalid", "the spent token cannot be reused");

  // A fresh link, used properly this time.
  await c.post("/api/auth/forgot", { email: A.email });
  const token2 = linkFor(A.email, "/reset-password");
  check(token2 && token2 !== resetToken, "asking again issues a different token");

  r = await c.post("/api/auth/reset", { token: token2, password: "Nandri88Kolam" });
  check(r.status === 200 && r.json?.user?.email === A.email, "the new password is set and the devotee is signed in", `status ${r.status}`);

  r = await c.get("/api/account/summary");
  check(r.status === 200, "that session can read the account straight away");

  /* ── 9. Isolation between accounts ────────────────────────────────── */
  section("One devotee cannot read another's history");
  const b = new Client("B");
  await b.boot();
  r = await b.post("/api/auth/register", { ...B, phone: "9000000001" });
  check(r.status === 201, "a second account registers", `status ${r.status}`);
  r = await b.post("/api/auth/login", { email: B.email, password: B.password });
  check(r.status === 200, "and signs in");

  r = await b.get("/api/account/bookings");
  check(Array.isArray(r.json) && r.json.length === 0, "devotee B sees none of devotee A's bookings", `${r.text.slice(0, 120)}`);
  r = await b.get("/api/account/donations");
  check(Array.isArray(r.json) && r.json.length === 0, "nor any of their donations");
  r = await b.get("/api/account/summary");
  check(r.json?.donated === 0, "and B's total given is their own");

  /* ── 10. Sign out ─────────────────────────────────────────────────── */
  section("Sign out");
  r = await b.post("/api/auth/logout");
  check(r.status === 200, "logout answers 200");
  r = await b.get("/api/auth/me");
  check(r.json?.user === null, "the session is gone");
  r = await b.get("/api/account/summary");
  check(r.status === 401 && r.json?.code === "unauthenticated", "account endpoints refuse a guest (401)", `status ${r.status}`);

  /* ── 11. Rate limiting ────────────────────────────────────────────── */
  section("Rate limiting");
  const spam = new Client("spam");
  await spam.boot();
  let sawLimit = false;
  for (let i = 0; i < 9 && !sawLimit; i += 1) {
    const rr = await spam.post("/api/auth/login", { email: A.email, password: `Wrong99Pass${i}` });
    if (rr.status === 429) sawLimit = true;
  }
  check(sawLimit, "repeated wrong passwords for one account hit a 429");

  /* ── 12. Hostile input ────────────────────────────────────────────── */
  section("Hostile input");
  const hostile = new Client("hostile");
  await hostile.boot();
  const nasty = [
    { name: "<script>alert(1)</script>", email: `xss-${RUN}@example.test`, password: "Kolam99Deep" },
    { name: "x".repeat(5000), email: `long-${RUN}@example.test`, password: "Kolam99Deep" },
    { name: "Robert'); DROP TABLE devotees;--", email: `sqli-${RUN}@example.test`, password: "Kolam99Deep" },
  ];
  for (const payload of nasty) {
    r = await hostile.post("/api/auth/register", payload);
    check(r.status < 500, `register survives ${payload.email.split("-")[0]} payload`, `status ${r.status}`);
    check(!/Fatal error|Stack trace|PDOException/i.test(r.text), "…and leaks no stack trace");
  }
  r = await hostile.get("/api/auth/me");
  check(r.status === 200, "the devotees table is still there after the SQL payload");

  r = await hostile.post("/api/auth/verify", { token: "../../etc/passwd" });
  check(r.status === 400, "a traversal string is not accepted as a token", `status ${r.status}`);

  // fetch() normalises "../" out of a URL before sending, so the traversal must
  // be expressed in a way that actually reaches the server as extra segments.
  r = await hostile.get("/api/auth/a/b");
  check(r.status === 404, "a multi-segment auth path is refused", `status ${r.status}`);
  r = await hostile.get("/api/auth/%2e%2e%2f%2e%2e%2fincludes%2fdb.php");
  check(r.status === 404, "an encoded traversal is refused", `status ${r.status}`);
  r = await hostile.get("/includes/db.php");
  check(r.status === 403, "includes/ is not reachable over HTTP", `status ${r.status}`);
  r = await hostile.get("/config/config.php");
  check(r.status === 403, "nor is config/", `status ${r.status}`);
  r = await hostile.get("/logs/mail.log");
  check(r.status === 403, "nor is the mail log, which holds reset links", `status ${r.status}`);

  r = await hostile.get("/api/account/summary");
  check(r.status === 401, "a known account action still needs a session");

  r = await hostile.get("/api/auth/nosuchaction");
  check(r.status === 404, "an unknown auth action is a 404", `status ${r.status}`);
  r = await hostile.get("/api/account/nosuchaction");
  check(r.status === 404, "an unknown account action is a 404 before the auth check", `status ${r.status}`);

  /* ── 13. Public search ────────────────────────────────────────────── */
  section("Public search");
  const s = new Client("search");
  r = await s.get("/api/search?q=a");
  check(r.status === 200 && r.json?.total === 0, "a one-character query returns nothing, politely", `status ${r.status}`);
  check(!!r.json?.message, "…with a message saying why");

  r = await s.get("/api/search?q=abhishekam");
  check(r.status === 200 && r.json?.total > 0, "a real word finds results", `total ${r.json?.total}`);
  check(Array.isArray(r.json?.groups) && r.json.groups.every((g) => g.label_ta && g.label_en), "every group is labelled in both languages");
  check(
    r.json.groups.every((g) => g.items.every((i) => typeof i.url === "string" && i.url.startsWith("/"))),
    "every result points at an in-site path",
  );

  r = await s.get("/api/search?q=80G");
  const urls = (r.json?.groups ?? []).flatMap((g) => g.items.map((i) => i.url));
  check(urls.includes("/about#trust"), "a keyword that never appears on screen still finds its page (80G → Trust)", urls.join(","));

  r = await s.get(`/api/search?q=${encodeURIComponent("பௌர்ணமி")}`);
  check(r.status === 200 && r.json?.total > 0, "a Tamil query finds results", `total ${r.json?.total}`);

  r = await s.get(`/api/search?q=${encodeURIComponent("zzqq-nothing-matches-this")}`);
  check(r.status === 200 && r.json?.total === 0 && Array.isArray(r.json.groups), "no matches returns an empty group list, not an error");

  r = await s.get(`/api/search?q=${encodeURIComponent("100%")}`);
  check(r.status === 200, "a query containing % does not break the LIKE", `status ${r.status}`);
  r = await s.get(`/api/search?q=${encodeURIComponent("a_b")}`);
  check(r.status === 200, "nor does one containing _");
  r = await s.get(`/api/search?q=${encodeURIComponent("' OR 1=1 --")}`);
  check(r.status === 200 && !/Fatal|PDOException/i.test(r.text), "an injection attempt is just a search term");

  r = await s.req("POST", "/api/search", {});
  check(r.status === 405 || r.status === 404, "search is GET-only", `status ${r.status}`);

  r = await s.get("/api/search?q=pooja&limit=9999");
  const per = Math.max(...(r.json?.groups ?? [{ items: [] }]).map((g) => g.items.length), 0);
  check(per <= 50, "the limit is capped server-side", `largest group ${per}`);

  /* ── Done ─────────────────────────────────────────────────────────── */
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log(
    `\nCleanup:\n  DELETE FROM devotees WHERE email LIKE 'e2e-auth-%' OR email LIKE 'xss-%' OR email LIKE 'long-%' OR email LIKE 'sqli-%';` +
      `\n  DELETE FROM seva_bookings WHERE devotee_name LIKE 'E2E-AUTH%';` +
      `\n  DELETE FROM donations WHERE name LIKE 'E2E-AUTH%';` +
      `\n  DELETE FROM rate_limits;`,
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\nHarness error:", err);
  // Leave a trace of what the server said, so a crash here is debuggable.
  try {
    writeFileSync(resolve(HERE, "devotee-auth.last-error.txt"), String(err.stack ?? err));
  } catch {
    /* nothing to do */
  }
  process.exit(2);
});
