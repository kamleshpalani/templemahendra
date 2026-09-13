#!/usr/bin/env node
/**
 * tests/notify-providers.mjs — every notification provider, against stand-ins
 * for the outside services it talks to, over real HTTP and SMTP.
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh node tests/notify-providers.mjs
 *
 * What it proves, provider by provider:
 *   • the exact request each one makes — method, path, auth, body fields,
 *     template parameters, buttons — as received by a Node mock of the service;
 *   • how each class of answer (success, 429 with Retry-After, 5xx, network
 *     failure, each permanent error group, bad credentials) becomes a
 *     NotifyResult: sent, retry (with its wait), rejected, skipped;
 *   • Web Push end to end: a subscriber key pair made in Node, a receiver that
 *     verifies the VAPID JWT with the key the request names and decrypts the
 *     RFC 8291 aes128gcm body itself before asserting the payload;
 *   • FCM's OAuth: the mock token endpoint verifies the RS256 assertion with the
 *     public half of a key pair made here, and the token is cached across processes;
 *   • the mailer's new extra headers over SMTP and in the log transport, and the
 *     refusal of header injection;
 *   • the webhook endpoint over HTTP (two PHP servers with different drivers):
 *     Meta verification and signatures, Twilio signatures computed exactly as
 *     Twilio does, the MSG91 token, the test driver, and what is refused.
 *
 * Ports 8020–8029 (the providers agent's range): 8020 and 8028 PHP webhook
 * servers, 8021 Meta, 8022 Twilio, 8023 MSG91, 8024 SMTP, 8025 push receiver,
 * 8026 FCM, 8029 deliberately closed. Requests to the PHP servers carry
 * X-Forwarded-For 10.20.0.1. Creates e2e-providers-<run>-… rows and removes them.
 */

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const XFF = "10.20.0.1";
const EMAIL_PREFIX = `e2e-providers-${RUN}`;
const MAIL_LOG = resolve(ROOT, "backend/logs/mail.log");
const SITE = "https://temple.example";

const PORT = { hookA: 8020, meta: 8021, twilio: 8022, msg91: 8023, smtp: 8024, push: 8025, fcm: 8026, hookB: 8028, closed: 8029 };
const LOCAL = (port) => `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];
const phpNoise = [];

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
function note(text) {
  console.log(`  note ${text}`);
}
const show = (v) => JSON.stringify(v)?.slice(0, 400) ?? String(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const b64uDecode = (s) => Buffer.from(String(s ?? ""), "base64url");
const pad32 = (buf) => (buf.length >= 32 ? buf : Buffer.concat([Buffer.alloc(32 - buf.length), buf]));
function safeJson(input) {
  try {
    return JSON.parse(Buffer.isBuffer(input) ? input.toString("utf8") : String(input));
  } catch {
    return null;
  }
}

/* ── PHP processes ─────────────────────────────────────────────────────── */

// Provider settings from the caller's shell must not leak into a case that
// expects them unset; each case passes exactly what it needs.
const PROVIDER_ENV = /^(NOTIFY_|WHATSAPP_|TWILIO_|MSG91_|VAPID_|FCM_|MAIL_|SMTP_)/i;
function phpEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!PROVIDER_ENV.test(k)) env[k] = v;
  // No MSYS_NO_PATHCONV here: php.sh relies on Git Bash converting its own
  // "-c /c/…/php.ini" for php.exe, and every argument this suite passes is
  // relative or JSON, so nothing of ours is rewritten.
  return { ...env, SITE_URL: SITE, ...extra };
}
function phpCommand(args) {
  const viaBash = /\.sh$/i.test(PHP_BIN);
  return viaBash ? ["bash", [PHP_BIN, ...args]] : [PHP_BIN, args];
}

/** Run PHP without blocking the event loop — the mock servers must keep answering meanwhile. */
function runPhp(args, { input = "", env = {} } = {}) {
  const [cmd, argv] = phpCommand(args);
  return new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv(env), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: String(err) });
    });
    child.stdin.end(input);
  });
}

function notePhpNoise(label, text) {
  const m = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error):[^\n]*/.exec(text);
  if (m) phpNoise.push(`${label}: ${m[0]}`);
}

async function harness(command, payload, env = {}) {
  const r = await runPhp(["tests/support/notify_provider_harness.php", command], { input: JSON.stringify(payload), env });
  notePhpNoise(`harness ${command}`, r.stdout + r.stderr);
  const last = r.stdout.trim().split(/\r?\n/).pop() ?? "";
  const json = safeJson(last);
  if (!json) return { error: `harness ${command} printed no JSON (exit ${r.code}): ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}` };
  return json;
}
async function batch(ops, env = {}) {
  const r = await harness("batch", { ops }, env);
  if (r.error || !Array.isArray(r.results)) throw new Error(r.error ?? "batch returned no results");
  return r.results;
}
async function fixtures(command, args) {
  const r = await runPhp(["tests/support/notify_fixtures.php", command, JSON.stringify(args)]);
  notePhpNoise(`fixtures ${command}`, r.stdout + r.stderr);
  return safeJson(r.stdout.trim().split(/\r?\n/).pop() ?? "") ?? { error: `fixtures ${command}: ${r.stdout} ${r.stderr}` };
}
const sql = (query, params = []) => fixtures("sql", { query, params });

/* ── Mock servers ──────────────────────────────────────────────────────── */

function portInUse(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
}

function startHttp(port, handler) {
  return new Promise((ok, fail) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        await handler(req, res, Buffer.concat(chunks));
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`mock error: ${e}`);
      }
    });
    server.keepAliveTimeout = 1;
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}
function reply(res, status, body, headers = {}) {
  const isText = typeof body === "string";
  res.writeHead(status, { "Content-Type": isText ? "text/plain" : "application/json", ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

/* Meta WhatsApp Cloud API */
const META = {
  token: `EAAE2E${RUN}token`,
  phoneId: "109876543210",
  version: "v21.0",
  appSecret: `meta-app-secret-${RUN}`,
  verifyToken: `meta-verify-${RUN}-0123456789`,
};
const meta = { requests: [] };
async function metaHandler(req, res, body) {
  const json = safeJson(body);
  meta.requests.push({ method: req.method, url: req.url, headers: req.headers, json });
  const to = String(json?.to ?? "");
  const error = (status, code, message, headers = {}) =>
    reply(res, status, { error: { message, type: "OAuthException", code, error_data: { messaging_product: "whatsapp", details: message }, fbtrace_id: "AE2E" } }, headers);
  switch (to.slice(-4)) {
    case "0429": return error(429, 130429, "Rate limit hit", { "Retry-After": "90" });
    case "0500": return reply(res, 500, { error: { message: "Service temporarily unavailable", code: 2 } });
    case "0004": return error(400, 4, "Application request limit reached");
    case "1026": return error(400, 131026, "Message undeliverable");
    case "1047": return error(400, 131047, "Re-engagement message");
    case "2001": return error(404, 132001, "Template name does not exist in the translation");
    case "0100": return error(400, 100, "Invalid parameter: components[0]");
    case "0190": return error(401, 190, "Error validating access token: Session has expired");
    default:
      return reply(res, 200, { messaging_product: "whatsapp", contacts: [{ input: to, wa_id: to }], messages: [{ id: `wamid.${RUN}.${meta.requests.length}` }] });
  }
}

/* Twilio */
const TWILIO = {
  sid: "AC" + "0123456789abcdef".repeat(2),
  token: crypto.randomBytes(16).toString("hex"),
  waFrom: "whatsapp:+14155238886",
  smsFrom: "+14155550100",
  service: "MG" + "fedcba9876543210".repeat(2),
  content: "HX" + "abcdef0123456789".repeat(2),
};
const twilio = { requests: [] };
async function twilioHandler(req, res, body) {
  const form = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
  twilio.requests.push({ method: req.method, url: req.url, headers: req.headers, form });
  const error = (status, code, message, headers = {}) =>
    reply(res, status, { code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status }, headers);
  if (req.headers.authorization !== "Basic " + Buffer.from(`${TWILIO.sid}:${TWILIO.token}`).toString("base64")) {
    return error(401, 20003, "Authenticate");
  }
  const to = String(form.To ?? "");
  switch (to.slice(-4)) {
    case "0429": return error(429, 20429, "Too Many Requests", { "Retry-After": "45" });
    case "0500": return reply(res, 503, "Service Unavailable");
    case "1211": return error(400, 21211, `The 'To' number ${to.replace("whatsapp:", "")} is not a valid phone number.`);
    case "1610": return error(400, 21610, "Attempt to send to unsubscribed recipient");
    case "3016": return error(400, 63016, "Failed to send freeform message because you are outside the allowed window.");
    default:
      return reply(res, 201, { sid: `SM${crypto.randomBytes(16).toString("hex")}`, status: "queued", to, from: form.From ?? null });
  }
}

/* MSG91 */
const MSG91 = { key: `msg91-key-${RUN}`, webhookToken: `msg91-hook-${RUN}-abcdefghijklmnop` };
const msg91 = { requests: [] };
async function msg91Handler(req, res, body) {
  const json = safeJson(body);
  msg91.requests.push({ method: req.method, url: req.url, headers: req.headers, json });
  if (req.headers.authkey !== MSG91.key) return reply(res, 401, { type: "error", message: "Authentication failure" });
  if (json?.template_id === "BADTEMPLATE") return reply(res, 200, { type: "error", message: "Invalid template id" });
  const mobile = String(json?.recipients?.[0]?.mobiles ?? "");
  switch (mobile.slice(-4)) {
    case "0429": return reply(res, 429, { type: "error", message: "Too many requests" }, { "Retry-After": "30" });
    case "0500": return reply(res, 502, "Bad Gateway");
    case "0211": return reply(res, 200, { type: "error", message: "Mobile number not valid" });
    default: return reply(res, 200, { type: "success", message: `3763${RUN}${msg91.requests.length}` });
  }
}

/* SMTP: just enough of RFC 5321 for smtpSend() with SMTP_SECURE=none */
const smtp = { sessions: 0, messages: [] };
function startSmtp(port) {
  return new Promise((ok, fail) => {
    const server = net.createServer((socket) => {
      smtp.sessions += 1;
      let buffer = "";
      let inData = false;
      let rcpt = [];
      socket.setEncoding("utf8");
      const say = (line) => socket.write(`${line}\r\n`);
      say("220 mock.smtp.test ESMTP ready");
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end === -1) return;
            smtp.messages.push({ rcpt, data: buffer.slice(0, end) });
            buffer = buffer.slice(end + 5);
            inData = false;
            rcpt = [];
            say("250 2.0.0 queued as E2E");
            continue;
          }
          const nl = buffer.indexOf("\r\n");
          if (nl === -1) return;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          const verb = line.slice(0, 4).toUpperCase();
          if (verb === "EHLO" || verb === "HELO") say("250-mock.smtp.test\r\n250 8BITMIME");
          else if (verb === "MAIL") say("250 2.1.0 sender ok");
          else if (verb === "RCPT") {
            const address = (/<([^>]*)>/.exec(line) ?? [])[1] ?? "";
            if (address.includes("tempfail")) say("451 4.7.1 Greylisted, try again later");
            else if (address.includes("nouser")) say(`550 5.1.1 <${address}>: Recipient address rejected: User unknown`);
            else {
              rcpt.push(address);
              say("250 2.1.5 recipient ok");
            }
          } else if (verb === "DATA") {
            inData = true;
            say("354 End data with <CR><LF>.<CR><LF>");
          } else if (verb === "QUIT") {
            say("221 2.0.0 bye");
            socket.end();
            return;
          } else say("502 5.5.2 command not recognised");
        }
      });
    });
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}

/* Web Push receiver: verifies VAPID and decrypts like a push service plus browser would */
const vapidEcdh = crypto.createECDH("prime256v1");
vapidEcdh.generateKeys();
const VAPID = {
  public: b64u(vapidEcdh.getPublicKey()),
  private: b64u(pad32(vapidEcdh.getPrivateKey())),
  subject: "mailto:committee@temple.example",
};
function subscriber() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } };
}
const subs = Object.fromEntries(["ok1", "ok2", "tamil", "long", "gone", "big", "rate", "fail", "normal", "important"].map((n) => [n, subscriber()]));
const push = { requests: [] };

function verifyVapid(authorization) {
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!m) return { ok: false, why: "Authorization is not 'vapid t=…, k=…'" };
  const [, h, c, s, k] = m;
  const header = safeJson(b64uDecode(h));
  const claims = safeJson(b64uDecode(c));
  const point = b64uDecode(k);
  if (point.length !== 65 || point[0] !== 4) return { ok: false, why: "k is not a 65-byte point", header, claims, k };
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) }, format: "jwk" });
  const signature = b64uDecode(s);
  const ok = signature.length === 64 && crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, signature);
  return { ok, header, claims, k };
}

/** RFC 8291 decryption, written independently of the PHP side. */
function decryptPush(body, sub) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const keyid = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const uaPublic = sub.ecdh.getPublicKey();
  const secret = sub.ecdh.computeSecret(keyid);
  const prkKey = hmac(sub.auth, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, keyid, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (plain[end - 1] !== 2) throw new Error("no 0x02 last-record delimiter");
  const text = plain.subarray(0, end - 1);
  return { rs, idlen, keyid, bytes: text.length, json: JSON.parse(text.toString("utf8")) };
}

async function pushHandler(req, res, body) {
  const name = req.url.replace(/^\/push\//, "");
  const record = { name, headers: req.headers, vapid: verifyVapid(req.headers.authorization), bodyLength: body.length };
  try {
    record.decrypted = decryptPush(body, subs[name]);
  } catch (e) {
    record.decryptError = String(e);
  }
  push.requests.push(record);
  if (name === "gone") return reply(res, 410, "push subscription has unsubscribed or expired.");
  if (name === "big") return reply(res, 413, "Payload Too Large");
  if (name === "rate") return reply(res, 429, "Too Many Requests", { "Retry-After": "120" });
  if (name === "fail") return reply(res, 500, "Internal Server Error");
  return reply(res, 201, "", { Location: `${LOCAL(PORT.push)}/messages/${crypto.randomUUID()}` });
}

/* FCM: OAuth token endpoint + messages:send */
const fcmKeys = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const FCM = { project: "temple-e2e", clientEmail: `notify-${RUN}@temple-e2e.iam.gserviceaccount.com`, keyId: `kid${RUN}`, tokenUrl: `${LOCAL(PORT.fcm)}/token` };
const serviceAccount = (privateKey = fcmKeys.privateKey) =>
  JSON.stringify({ type: "service_account", project_id: FCM.project, private_key_id: FCM.keyId, private_key: privateKey, client_email: FCM.clientEmail, client_id: "1", token_uri: FCM.tokenUrl });
const fcm = { tokenRequests: [], sendRequests: [], issued: new Set(), revoked: new Set(), revokeNext: false };
async function fcmHandler(req, res, body) {
  if (req.url === "/token") {
    const form = new URLSearchParams(body.toString("utf8"));
    const record = { grantType: form.get("grant_type"), contentType: req.headers["content-type"] };
    const [h, c, s] = String(form.get("assertion") ?? "").split(".");
    record.header = safeJson(b64uDecode(h));
    record.claims = safeJson(b64uDecode(c));
    try {
      record.signatureOk = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${c}`), fcmKeys.publicKey, b64uDecode(s));
    } catch {
      record.signatureOk = false;
    }
    fcm.tokenRequests.push(record);
    if (!record.signatureOk) return reply(res, 400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
    const token = `ya29.e2e-${RUN}-${fcm.tokenRequests.length}`;
    fcm.issued.add(token);
    return reply(res, 200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
  }
  const route = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(req.url);
  if (!route) return reply(res, 404, { error: { code: 404, message: "no such route", status: "NOT_FOUND" } });
  const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
  const json = safeJson(body);
  fcm.sendRequests.push({ project: route[1], bearer, json, headers: req.headers });
  const error = (status, state, code, message, headers = {}) =>
    reply(res, status, { error: { code: status, message, status: state, details: code ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }] : [] } }, headers);
  if (fcm.revokeNext) {
    fcm.revokeNext = false;
    fcm.revoked.add(bearer);
  }
  if (!fcm.issued.has(bearer) || fcm.revoked.has(bearer)) return error(401, "UNAUTHENTICATED", null, "Request had invalid authentication credentials.");
  const token = String(json?.message?.token ?? "");
  if (token.startsWith("unregistered")) return error(404, "NOT_FOUND", "UNREGISTERED", "Requested entity was not found.");
  if (token.startsWith("invalid")) return error(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT", "The registration token is not a valid FCM registration token");
  if (token.startsWith("quota")) return error(429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "Quota exceeded for quota metric", { "Retry-After": "60" });
  if (token.startsWith("unavailable")) return error(503, "UNAVAILABLE", "UNAVAILABLE", "The service is currently unavailable.");
  return reply(res, 200, { name: `projects/${route[1]}/messages/0:${RUN}${fcm.sendRequests.length}` });
}

/* ── Shared message shapes ─────────────────────────────────────────────── */

const msg = (over = {}) => ({
  deliveryId: 501,
  notificationId: 301,
  lang: "en",
  category: "booking",
  priority: "important",
  title: "Booking confirmed",
  body: "Your seva booking BK-1042 is confirmed for 14 September.",
  ...over,
});
const send = (channel, driver, env, message, extra = {}) => ({ command: "send", channel, driver, env, message: msg(message), ...extra });

/* ── Mailer ────────────────────────────────────────────────────────────── */

function mailBlocksFor(email) {
  if (!existsSync(MAIL_LOG)) return [];
  return readFileSync(MAIL_LOG, "utf8").split("\n===== ").filter((b) => b.includes(`\nTo: ${email}\n`));
}

async function testMailer() {
  section("Email via the mailer: SMTP transport with extra headers");
  const smtpEnv = { MAIL_TRANSPORT: "smtp", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(PORT.smtp), SMTP_SECURE: "none", MAIL_FROM: "notify@temple.example", MAIL_FROM_NAME: "Temple E2E" };
  const unsubscribe = `<${SITE}/api/n/u/u12.abcdefghijklmnop>`;
  const listHeaders = { "List-Unsubscribe": unsubscribe, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const to = (tag) => `${EMAIL_PREFIX}-${tag}@example.test`;
  const before = smtp.messages.length;
  const sessionsBefore = smtp.sessions;

  const [ok, tamil, temp, perm, injected, reserved] = await batch([
    send("email", "mailer", smtpEnv, { deliveryId: 601, toEmail: to("smtp"), html: "<p>Namaskaram</p>", headers: listHeaders }),
    send("email", "mailer", smtpEnv, { deliveryId: 602, toEmail: to("tamil"), title: "சேவை உறுதி செய்யப்பட்டது", lang: "ta" }),
    send("email", "mailer", smtpEnv, { deliveryId: 603, toEmail: to("tempfail") }),
    send("email", "mailer", smtpEnv, { deliveryId: 604, toEmail: to("nouser") }),
    send("email", "mailer", smtpEnv, { deliveryId: 605, toEmail: to("inject"), headers: { "X-Evil": "ok\r\nBcc: victim@example.test" } }),
    send("email", "mailer", smtpEnv, { deliveryId: 606, toEmail: to("reserved"), headers: { Bcc: "victim@example.test" } }),
  ]);

  check(ok.result?.status === "sent", "SMTP 250 → sent", show(ok));
  check(/^<notify\.601\.[0-9a-f]{16}@temple\.example>$/.test(ok.result?.messageId ?? ""), "the result carries the Message-ID the provider chose", ok.result?.messageId);
  const delivered = smtp.messages.slice(before).find((m) => m.rcpt.includes(to("smtp")));
  const data = delivered?.data ?? "";
  check(!!delivered, "the SMTP mock received the message");
  check(data.includes(`\r\nMessage-ID: ${ok.result?.messageId}\r\n`), "that Message-ID is the one in the message");
  check((data.match(/^Message-ID:/gim) ?? []).length === 1, "exactly one Message-ID header (the mailer did not add its own)");
  check(data.includes(`\r\nList-Unsubscribe: ${unsubscribe}\r\n`), "List-Unsubscribe reaches the wire");
  check(data.includes("\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"), "List-Unsubscribe-Post reaches the wire");
  check(/\r\nSubject: Booking confirmed\r\n/.test(data) && data.includes(`To: <${to("smtp")}>`), "Subject is the title and To is the recipient");
  const tamilData = smtp.messages.slice(before).find((m) => m.rcpt.includes(to("tamil")))?.data ?? "";
  check(tamil.result?.status === "sent" && /Subject: =\?UTF-8\?B\?/.test(tamilData), "a Tamil subject is sent MIME-encoded", show(tamil));
  check(temp.result?.status === "retry" && /try later/.test(temp.result?.reason ?? ""), "SMTP 451 on RCPT → retry", show(temp));
  check(perm.result?.status === "rejected" && /refused the message/.test(perm.result?.reason ?? ""), "SMTP 550 on RCPT → rejected", show(perm));
  check(!(perm.result?.reason ?? "").includes("providers-"), "the rejection reason does not repeat the address", perm.result?.reason);
  check(injected.result?.status === "rejected" && /line break/.test(injected.result?.reason ?? ""), "a header value with CR/LF → rejected", show(injected));
  check(reserved.result?.status === "rejected" && /sets itself/.test(reserved.result?.reason ?? ""), "a Bcc passed as an extra header → rejected", show(reserved));
  check(smtp.sessions - sessionsBefore === 4, "the two refused messages never opened an SMTP session", `sessions ${smtp.sessions - sessionsBefore}`);

  const [down] = await batch([send("email", "mailer", { ...smtpEnv, SMTP_PORT: String(PORT.closed) }, { deliveryId: 607, toEmail: to("down") })]);
  check(down.result?.status === "retry" && /could not be sent right now/.test(down.result?.reason ?? ""), "SMTP connection refused → retry", show(down));

  section("Email via the mailer: log transport (MAIL_TRANSPORT unset)");
  const logEnv = { MAIL_TRANSPORT: null };
  const [logged, sendmailInjected, sendmailBadName, sendmailPlain, badAddress] = await batch([
    send("email", "mailer", logEnv, { deliveryId: 611, toEmail: to("logged"), headers: listHeaders }),
    { command: "sendmail", env: logEnv, to: to("log-inject"), headers: { "X-Evil": "a\r\nBcc: victim@example.test" } },
    { command: "sendmail", env: logEnv, to: to("log-badname"), headers: { "Bad\nName": "x" } },
    { command: "sendmail", env: logEnv, to: to("log-plain"), template: "e2e-providers" },
    send("email", "mailer", logEnv, { deliveryId: 612, toEmail: "not-an-address" }),
  ]);
  check(logged.result?.status === "sent" && logged.result?.recordedOnly === true && logged.result?.messageId === null, "logged → sent, recordedOnly, no message id", show(logged));
  const block = mailBlocksFor(to("logged")).pop() ?? "";
  check(block.includes(`\nList-Unsubscribe: ${unsubscribe}\n`), "extra headers are recorded in mail.log", block.slice(0, 300));
  check(/\nMessage-ID: <notify\.611\.[0-9a-f]{16}@temple\.example>\n/.test(block), "the Message-ID is recorded in mail.log");
  check(sendmailInjected.result?.ok === false && sendmailInjected.result?.status === "failed" && /line break/.test(sendmailInjected.result?.error ?? ""), "sendMail() refuses a CR/LF header value", show(sendmailInjected));
  check(mailBlocksFor(to("log-inject")).length === 0, "the refused message was not written to mail.log");
  check(sendmailBadName.result?.status === "failed" && /line break/.test(sendmailBadName.result?.error ?? ""), "sendMail() refuses a header name with a line break", show(sendmailBadName));
  const plain = mailBlocksFor(to("log-plain")).pop() ?? "";
  check(sendmailPlain.result?.status === "logged" && /\nTemplate: e2e-providers\n\nE2E providers\n/.test(plain), "without extra headers the mail.log entry keeps its old shape", plain.slice(0, 200));
  check(badAddress.result?.status === "rejected", "an invalid address → rejected", show(badAddress));
  const rows = await sql("SELECT status, error FROM mail_log WHERE to_email = ?", [to("log-inject")]);
  check(rows.rows?.[0]?.status === "failed" && /line break/.test(rows.rows?.[0]?.error ?? ""), "mail_log records the refusal", show(rows));
}

/* ── Meta ──────────────────────────────────────────────────────────────── */

async function testMeta() {
  const env = { WHATSAPP_META_TOKEN: META.token, WHATSAPP_META_PHONE_NUMBER_ID: META.phoneId, WHATSAPP_META_API_VERSION: META.version, WHATSAPP_META_BASE_URL: LOCAL(PORT.meta) };
  section("WhatsApp via Meta Cloud API: the requests");
  meta.requests.length = 0;
  const [tpl, tplEn, text, cta, noPhone, unconfigured] = await batch([
    send("whatsapp", "meta", env, {
      lang: "ta",
      toPhone: "919876540000",
      providerTemplate: "booking_confirmed",
      templateParams: ["அம்மு", "BK-1042", "14 Sep\n2026\tmorning", ""],
      buttons: [
        { type: "url", text: "View booking", value: `${SITE}/account?tab=bookings`, suffix: "account?tab=bookings" },
        { type: "url", text: "Sevas", value: `${SITE}/sevas` },
      ],
    }),
    send("whatsapp", "meta", env, { lang: "en", toPhone: "+91 98765 40000", providerTemplate: "welcome" }),
    send("whatsapp", "meta", env, { toPhone: "919876540000", ctaUrl: `${SITE}/account?tab=bookings`, ctaLabel: "View booking" }),
    send("whatsapp", "meta", env, { toPhone: "919876540000", buttons: [{ type: "url", text: "View my booking details", value: `${SITE}/account?tab=bookings` }] }),
    send("whatsapp", "meta", env, { toPhone: null }),
    send("whatsapp", "meta", { ...env, WHATSAPP_META_TOKEN: null }, { toPhone: "919876540000" }),
  ]);
  const [r0, r1, r2, r3] = meta.requests;

  check(tpl.result?.status === "sent" && tpl.result?.messageId === `wamid.${RUN}.1`, "template send → sent with messages[0].id", show(tpl));
  check(r0?.method === "POST" && r0?.url === `/v21.0/${META.phoneId}/messages`, "POST {base}/{version}/{phone number id}/messages", r0?.url);
  check(r0?.headers.authorization === `Bearer ${META.token}`, "Bearer token");
  check(r0?.json?.messaging_product === "whatsapp" && r0?.json?.to === "919876540000" && r0?.json?.type === "template", "template message to the digits");
  check(r0?.json?.template?.name === "booking_confirmed" && r0?.json?.template?.language?.code === "ta", "template name and language ta");
  const bodyParams = r0?.json?.template?.components?.find((c) => c.type === "body")?.parameters?.map((p) => p.text);
  check(show(bodyParams) === show(["அம்மு", "BK-1042", "14 Sep 2026 morning", "-"]), "body parameters in order; new lines and tabs flattened, empty → '-'", show(bodyParams));
  const buttons = r0?.json?.template?.components?.filter((c) => c.type === "button") ?? [];
  check(buttons.length === 1 && buttons[0].sub_type === "url" && buttons[0].index === "0" && buttons[0].parameters?.[0]?.text === "account?tab=bookings", "only the URL button with a dynamic suffix is sent, at its index", show(buttons));
  check(r1?.json?.template?.language?.code === "en_US" && r1?.json?.template?.components === undefined && r1?.json?.to === "919876540000", "English → en_US; no parameters → no components", show(r1?.json));
  check(r2?.json?.type === "text" && r2?.json?.text?.preview_url === true, "free-form with a link → text with preview_url", show(r2?.json));
  check((r2?.json?.text?.body ?? "").startsWith("*Booking confirmed*\n\n") && r2?.json?.text?.body.endsWith(`View booking: ${SITE}/account?tab=bookings`), "text carries the bold title and the labelled link", r2?.json?.text?.body);
  check(r3?.json?.type === "interactive" && r3?.json?.interactive?.type === "cta_url" && r3?.json?.interactive?.action?.name === "cta_url", "exactly one URL button → interactive cta_url", show(r3?.json));
  const ctaParams = r3?.json?.interactive?.action?.parameters ?? {};
  check(ctaParams.url === `${SITE}/account?tab=bookings` && [...(ctaParams.display_text ?? "")].length <= 20 && ctaParams.display_text.endsWith("…"), "button URL, and its label cut to WhatsApp's 20 characters", show(ctaParams));
  check(r3?.json?.interactive?.header?.text === "Booking confirmed" && r3?.json?.interactive?.body?.text?.startsWith("Your seva booking"), "title as header, body as body");
  check(noPhone.result?.status === "rejected" && noPhone.result?.reason === "no phone number", "no phone → rejected", show(noPhone));
  check(unconfigured.configured === false && unconfigured.result?.status === "skipped", "no token → not configured, skipped", show(unconfigured));
  check(meta.requests.length === 4, "nothing was sent for the refused cases", `requests ${meta.requests.length}`);

  section("WhatsApp via Meta Cloud API: how answers are read");
  const phones = { rate: "919876540429", down: "919876540500", appLimit: "919876540004", undeliverable: "919876541026", window: "919876541047", template: "919876542001", param: "919876540100", token: "919876540190" };
  const results = await batch([
    ...Object.values(phones).map((p) => send("whatsapp", "meta", env, { toPhone: p, providerTemplate: "booking_confirmed" })),
    send("whatsapp", "meta", { ...env, WHATSAPP_META_BASE_URL: LOCAL(PORT.closed) }, { toPhone: "919876540000" }),
  ]);
  const by = Object.fromEntries(Object.keys(phones).map((k, i) => [k, results[i].result ?? results[i]]));
  const network = results.at(-1).result ?? results.at(-1);
  check(by.rate.status === "retry" && by.rate.retryAfter === 90, "429 / 130429 → retry honouring Retry-After", show(by.rate));
  check(by.down.status === "retry" && by.down.retryAfter === null, "500 → retry", show(by.down));
  check(by.appLimit.status === "retry", "error 4 (rate limit) → retry", show(by.appLimit));
  check(by.undeliverable.status === "rejected" && /WhatsApp/.test(by.undeliverable.reason), "131026 → rejected with a plain reason", show(by.undeliverable));
  check(by.window.status === "rejected" && /24 hours/.test(by.window.reason) && /template/.test(by.window.reason), "131047 → rejected: outside the 24-hour window, template required", show(by.window));
  check(by.template.status === "rejected" && /template/i.test(by.template.reason), "132001 → rejected naming the template", show(by.template));
  check(by.param.status === "rejected" && /parameter/.test(by.param.reason), "100 → rejected naming the parameter", show(by.param));
  check(by.token.status === "retry" && by.token.retryAfter === 3600 && /WHATSAPP_META_TOKEN/.test(by.token.reason), "190 / 401 → retry in an hour, naming the token", show(by.token));
  check(network.status === "retry" && /could not reach/.test(network.reason), "network failure → retry", show(network));
  check(!(by.token.response ?? "").includes(META.token), "the stored response never holds the token");
}

/* ── Twilio ────────────────────────────────────────────────────────────── */

async function testTwilio() {
  const base = { TWILIO_ACCOUNT_SID: TWILIO.sid, TWILIO_AUTH_TOKEN: TWILIO.token, TWILIO_BASE_URL: LOCAL(PORT.twilio) };
  const wa = { ...base, TWILIO_WHATSAPP_FROM: TWILIO.waFrom };
  const sms = { ...base, TWILIO_SMS_FROM: TWILIO.smsFrom };
  section("Twilio WhatsApp and SMS: the requests");
  twilio.requests.length = 0;
  const [waTpl, waNotSid, waBody, smsFrom, smsService, waUnconfigured] = await batch([
    send("whatsapp", "twilio", wa, { toPhone: "919876540000", providerTemplate: TWILIO.content, templateParams: ["அம்மு", "BK-1042"], body: "ignored when a template is set" }),
    send("whatsapp", "twilio", wa, { toPhone: "919876540000", providerTemplate: "booking_confirmed" }),
    send("whatsapp", "twilio", wa, { toPhone: "919876540000", ctaUrl: "/account?tab=bookings", ctaLabel: "View booking", imageUrl: `${SITE}/uploads/seva.jpg` }),
    send("sms", "twilio", { ...sms, TWILIO_STATUS_CALLBACK_URL: "https://hooks.temple.example/twilio" }, { toPhone: "919876540000", ctaUrl: `${SITE}/account?tab=bookings` }),
    send("sms", "twilio", { ...base, TWILIO_MESSAGING_SERVICE_SID: TWILIO.service }, { toPhone: "919876540000" }),
    send("whatsapp", "twilio", { ...base, TWILIO_WHATSAPP_FROM: "+14155238886" }, { toPhone: "919876540000" }),
  ]);
  const [t0, t1, t2, t3] = twilio.requests;
  check(waTpl.result?.status === "sent" && /^SM[0-9a-f]{32}$/.test(waTpl.result?.messageId ?? ""), "WhatsApp template → sent with the Message SID", show(waTpl));
  check(t0?.method === "POST" && t0?.url === `/2010-04-01/Accounts/${TWILIO.sid}/Messages.json`, "POST /2010-04-01/Accounts/{sid}/Messages.json", t0?.url);
  check(t0?.headers["content-type"]?.startsWith("application/x-www-form-urlencoded"), "form-encoded body");
  check(t0?.form.From === TWILIO.waFrom && t0?.form.To === "whatsapp:+919876540000", "whatsapp: From and To", show(t0?.form));
  check(t0?.form.ContentSid === TWILIO.content && show(safeJson(t0?.form.ContentVariables)) === show({ 1: "அம்மு", 2: "BK-1042" }) && t0?.form.Body === undefined, "Content SID with ContentVariables {\"1\",\"2\"}, no Body", show(t0?.form));
  check(t0?.form.StatusCallback === `${SITE}/api/notify-webhook/twilio`, "StatusCallback defaults to siteUrl('/api/notify-webhook/twilio')", t0?.form.StatusCallback);
  check(waNotSid.result?.status === "rejected" && /Content SID/.test(waNotSid.result?.reason ?? ""), "a template that is not an HX Content SID → rejected, not sent", show(waNotSid));
  check(t1?.form.Body?.startsWith("*Booking confirmed*\n\nYour seva booking") && t1?.form.Body.endsWith(`View booking: ${SITE}/account?tab=bookings`) && t1?.form.MediaUrl === `${SITE}/uploads/seva.jpg`, "free-form WhatsApp: Body with title and absolute link, MediaUrl", show(t1?.form));
  check(t2?.form.From === TWILIO.smsFrom && t2?.form.To === "+919876540000" && t2?.form.Body === `Your seva booking BK-1042 is confirmed for 14 September.\n\n${SITE}/account?tab=bookings`, "SMS: From, E.164 To, body plus bare link, no title", show(t2?.form));
  check(t2?.form.StatusCallback === "https://hooks.temple.example/twilio", "TWILIO_STATUS_CALLBACK_URL is honoured");
  check(smsService.result?.status === "sent" && t3?.form.MessagingServiceSid === TWILIO.service && t3?.form.From === undefined, "SMS without a From uses the Messaging Service", show(t3?.form));
  check(waUnconfigured.configured === false && waUnconfigured.result?.status === "skipped", "a WhatsApp From without whatsapp: → not configured", show(waUnconfigured));
  check(twilio.requests.length === 4 && smsFrom.result?.status === "sent" && waBody.result?.status === "sent", "four sends reached Twilio", `requests ${twilio.requests.length}`);

  section("Twilio: how answers are read");
  const [rate, down, invalid, stopped, window, badToken, network] = await batch([
    send("sms", "twilio", sms, { toPhone: "919876540429" }),
    send("sms", "twilio", sms, { toPhone: "919876540500" }),
    send("sms", "twilio", sms, { toPhone: "919876541211" }),
    send("sms", "twilio", sms, { toPhone: "919876541610" }),
    send("whatsapp", "twilio", wa, { toPhone: "919876543016" }),
    send("sms", "twilio", { ...sms, TWILIO_AUTH_TOKEN: "0".repeat(32) }, { toPhone: "919876540000" }),
    send("sms", "twilio", { ...sms, TWILIO_BASE_URL: LOCAL(PORT.closed) }, { toPhone: "919876540000" }),
  ]);
  check(rate.result?.status === "retry" && rate.result?.retryAfter === 45, "429 → retry honouring Retry-After", show(rate));
  check(down.result?.status === "retry", "5xx → retry", show(down));
  check(invalid.result?.status === "rejected" && /not a valid phone number/.test(invalid.result?.reason ?? ""), "21211 → rejected", show(invalid));
  check(!(invalid.result?.response ?? "").includes("9876541211") && (invalid.result?.response ?? "").includes("1211"), "the stored response keeps only the last four digits", invalid.result?.response);
  check(stopped.result?.status === "rejected" && /STOP/.test(stopped.result?.reason ?? ""), "21610 → rejected (the devotee replied STOP)", show(stopped));
  check(window.result?.status === "rejected" && /24 hours/.test(window.result?.reason ?? ""), "63016 → rejected (outside the WhatsApp window)", show(window));
  check(badToken.result?.status === "retry" && badToken.result?.retryAfter === 3600 && /TWILIO_AUTH_TOKEN/.test(badToken.result?.reason ?? ""), "401 / 20003 → retry in an hour, naming the credentials", show(badToken));
  check(network.result?.status === "retry" && /could not reach Twilio/.test(network.result?.reason ?? ""), "network failure → retry", show(network));
}

/* ── MSG91 ─────────────────────────────────────────────────────────────── */

async function testMsg91() {
  const env = { MSG91_AUTH_KEY: MSG91.key, MSG91_BASE_URL: LOCAL(PORT.msg91) };
  section("MSG91 SMS: the request and the answers");
  msg91.requests.length = 0;
  const [ok, noTemplate, rate, down, badMobile, badTemplate, badKey, network, unconfigured] = await batch([
    send("sms", "msg91", env, { toPhone: "+91 98765 40000", providerTemplate: "6512d2e4d6fc05", templateParams: ["அம்மு", "BK-1042", 14] }),
    send("sms", "msg91", env, { toPhone: "919876540000" }),
    send("sms", "msg91", env, { toPhone: "919876540429", providerTemplate: "T1" }),
    send("sms", "msg91", env, { toPhone: "919876540500", providerTemplate: "T1" }),
    send("sms", "msg91", env, { toPhone: "919876540211", providerTemplate: "T1" }),
    send("sms", "msg91", env, { toPhone: "919876540000", providerTemplate: "BADTEMPLATE" }),
    send("sms", "msg91", { ...env, MSG91_AUTH_KEY: "wrong-key" }, { toPhone: "919876540000", providerTemplate: "T1" }),
    send("sms", "msg91", { ...env, MSG91_BASE_URL: LOCAL(PORT.closed) }, { toPhone: "919876540000", providerTemplate: "T1" }),
    send("sms", "msg91", { MSG91_AUTH_KEY: null }, { toPhone: "919876540000", providerTemplate: "T1" }),
  ]);
  const r0 = msg91.requests[0];
  check(ok.result?.status === "sent" && ok.result?.messageId === `3763${RUN}1`, "type success → sent with the request id", show(ok));
  check(r0?.method === "POST" && r0?.url === "/api/v5/flow/" && r0?.headers.authkey === MSG91.key, "POST /api/v5/flow/ with the authkey header", `${r0?.url} ${r0?.headers.authkey}`);
  check(show(r0?.json) === show({ template_id: "6512d2e4d6fc05", short_url: "0", recipients: [{ mobiles: "919876540000", var1: "அம்மு", var2: "BK-1042", var3: "14" }] }), "template_id, short_url 0, mobiles and var1…varN as strings", show(r0?.json));
  check(noTemplate.result?.status === "rejected" && noTemplate.result?.reason === "MSG91 needs a DLT-approved template id - set it on the template in the admin", "no template id → rejected with the admin instruction", show(noTemplate));
  check(rate.result?.status === "retry" && rate.result?.retryAfter === 30, "429 → retry honouring Retry-After", show(rate));
  check(down.result?.status === "retry", "5xx → retry", show(down));
  check(badMobile.result?.status === "rejected" && /mobile number/.test(badMobile.result?.reason ?? ""), "invalid number → rejected", show(badMobile));
  check(badTemplate.result?.status === "rejected" && /template id/.test(badTemplate.result?.reason ?? ""), "invalid template → rejected", show(badTemplate));
  check(badKey.result?.status === "retry" && badKey.result?.retryAfter === 3600 && /MSG91_AUTH_KEY/.test(badKey.result?.reason ?? ""), "authentication failure → retry in an hour", show(badKey));
  check(network.result?.status === "retry", "network failure → retry", show(network));
  check(unconfigured.configured === false && unconfigured.result?.status === "skipped", "no auth key → not configured, skipped", show(unconfigured));
  // Six reach the mock: success, 429, 5xx, bad mobile, bad template, bad key. The
  // missing template, the closed port and the unconfigured case must not.
  check(msg91.requests.length === 6 && !msg91.requests.some((r) => r.json?.template_id === undefined), "the case without a template never reached MSG91", `requests ${msg91.requests.length}`);
}

/* ── Web Push ──────────────────────────────────────────────────────────── */

const device = (id, name, over = {}) => ({ id, provider: "webpush", endpoint: `${LOCAL(PORT.push)}/push/${name}`, keys: subs[name]?.keys ?? subscriber().keys, ...over });

async function testWebPush() {
  const env = { VAPID_PUBLIC_KEY: VAPID.public, VAPID_PRIVATE_KEY: VAPID.private, VAPID_SUBJECT: VAPID.subject, NOTIFY_ALLOW_TEST_DRIVER: "1" };
  const data = { url: `${SITE}/account?tab=bookings`, trackUrl: `${SITE}/api/n/c/c77.abcdefghijklmnop`, notificationId: 301, category: "booking", priority: "urgent", tag: "booking-1042", image: `${SITE}/uploads/seva.jpg` };
  section("Web Push: VAPID, encryption and payload, verified by an independent receiver");
  push.requests.length = 0;
  const started = Math.floor(Date.now() / 1000);
  const [main] = await batch([
    send("push", "webpush", env, {
      priority: "urgent",
      title: "சேவை உறுதி",
      body: "உங்கள் சேவை பதிவு BK-1042 உறுதி செய்யப்பட்டது.",
      devices: [device(201, "ok1"), device(202, "ok2"), device(203, "gone"), { id: 209, provider: "fcm", endpoint: "fcm-token-not-for-webpush" }],
      data,
    }),
  ]);
  const ok1 = push.requests.find((r) => r.name === "ok1");
  const ok2 = push.requests.find((r) => r.name === "ok2");
  check(main.configured === true && main.result?.status === "sent", "two accepted and one gone → sent", show(main));
  const devs = main.result?.deviceResults ?? {};
  check(devs["201"]?.ok === true && devs["202"]?.ok === true && devs["203"]?.gone === true && devs["209"] === undefined, "per device: 201/202 ok, 203 gone (410), the FCM device untouched", show(devs));
  check(push.requests.length === 3, "one POST per web push subscription", `requests ${push.requests.length}`);
  check(ok1?.vapid.ok === true, "the VAPID JWT verifies (ES256, raw R||S) with the k key", show(ok1?.vapid));
  check(ok1?.vapid.header?.alg === "ES256" && ok1?.vapid.header?.typ === "JWT", "JWT header ES256");
  check(ok1?.vapid.k === VAPID.public, "k is VAPID_PUBLIC_KEY");
  check(ok1?.vapid.claims?.aud === LOCAL(PORT.push) && ok1?.vapid.claims?.sub === VAPID.subject, "aud is the push service origin, sub is VAPID_SUBJECT", show(ok1?.vapid.claims));
  const exp = ok1?.vapid.claims?.exp ?? 0;
  check(exp >= started + 43200 - 120 && exp <= started + 43200 + 300, "exp is twelve hours ahead", `exp - now = ${exp - started}`);
  check(ok1?.headers.ttl === "86400" && ok1?.headers.urgency === "high" && ok1?.headers.topic === "booking-1042", "urgent: TTL 86400, Urgency high, Topic from the tag", show([ok1?.headers.ttl, ok1?.headers.urgency, ok1?.headers.topic]));
  check(ok1?.headers["content-encoding"] === "aes128gcm" && ok1?.headers["content-type"] === "application/octet-stream", "Content-Encoding aes128gcm, application/octet-stream");
  check(!ok1?.decryptError && ok1?.decrypted?.rs === 4096 && ok1?.decrypted?.idlen === 65 && ok1?.decrypted?.keyid[0] === 4, "RFC 8188 header: record size 4096, 65-byte key id", ok1?.decryptError ?? show({ rs: ok1?.decrypted?.rs, idlen: ok1?.decrypted?.idlen }));
  const payload = ok1?.decrypted?.json ?? {};
  check(payload.title === "சேவை உறுதி" && payload.body === "உங்கள் சேவை பதிவு BK-1042 உறுதி செய்யப்பட்டது.", "decrypted payload: Tamil title and body intact", show(payload));
  check(payload.url === data.url && payload.trackUrl === data.trackUrl && payload.notificationId === 301 && payload.category === "booking" && payload.priority === "urgent" && payload.tag === "booking-1042" && payload.image === data.image && payload.icon === "/icons/icon-192x192.png", "decrypted payload carries url, trackUrl, notificationId, category, priority, tag, image, icon (SPEC §7.4)", show(payload));
  check(!ok2?.decryptError && ok2?.decrypted?.json?.tag === "booking-1042", "the second device decrypts with its own keys");
  check(ok1?.decrypted && ok2?.decrypted && !ok1.decrypted.keyid.equals(ok2.decrypted.keyid), "a fresh ephemeral key per subscription");

  section("Web Push: priorities, size limit and outcomes");
  push.requests.length = 0;
  const longBody = "அன்னதானம் ".repeat(900);
  const [normal, important, long, allGone, tooBig, rate, fail, mixed, onlyFcm, notHttps, badKeys] = await batch([
    send("push", "webpush", env, { priority: "normal", devices: [device(211, "normal")], data: { tag: "event reminder: Pournami 2026" } }),
    send("push", "webpush", env, { priority: "important", devices: [device(212, "important")] }),
    send("push", "webpush", env, { priority: "normal", title: "அன்னதானம் அழைப்பு", body: longBody, devices: [device(213, "long")], data }),
    send("push", "webpush", env, { devices: [device(214, "gone")] }),
    send("push", "webpush", env, { devices: [device(215, "big")] }),
    send("push", "webpush", env, { devices: [device(216, "rate")] }),
    send("push", "webpush", env, { devices: [device(217, "fail")] }),
    send("push", "webpush", env, { devices: [device(218, "rate"), device(219, "gone")] }),
    send("push", "webpush", env, { devices: [{ id: 220, provider: "fcm", endpoint: "token" }] }),
    send("push", "webpush", env, { devices: [device(221, "ok1", { endpoint: "http://push.example.com/abc" })] }),
    send("push", "webpush", env, { devices: [device(222, "ok1", { keys: { p256dh: "AAAA", auth: "BBBB" } })] }),
  ]);
  const normalReq = push.requests.find((r) => r.name === "normal");
  const importantReq = push.requests.find((r) => r.name === "important");
  const longReq = push.requests.find((r) => r.name === "long");
  check(normal.result?.status === "sent" && normalReq?.headers.ttl === "2419200" && normalReq?.headers.urgency === "low", "normal: TTL 28 days, Urgency low", show(normalReq?.headers));
  check(/^[A-Za-z0-9_-]{32}$/.test(normalReq?.headers.topic ?? "") && normalReq?.decrypted?.json?.tag === "event reminder: Pournami 2026", "a tag outside the Topic alphabet is hashed into 32 base64url characters", normalReq?.headers.topic);
  check(importantReq?.headers.urgency === "normal", "important: Urgency normal");
  const longPayload = longReq?.decrypted?.json ?? {};
  check(long.result?.status === "sent" && longReq?.decrypted?.bytes <= 3800, "a long message is fitted within 3800 bytes", `${longReq?.decrypted?.bytes} bytes`);
  check(longPayload.body?.endsWith("…") && longPayload.title === "அன்னதானம் அழைப்பு" && longPayload.url === data.url, "the body is shortened first; the title and link survive", show({ title: longPayload.title, tail: longPayload.body?.slice(-12) }));
  check(allGone.result?.status === "rejected" && allGone.result?.reason === "every device is gone" && allGone.result?.deviceResults?.["214"]?.gone === true, "all devices gone → rejected \"every device is gone\"", show(allGone));
  check(tooBig.result?.status === "rejected" && /too large/.test(tooBig.result?.reason ?? ""), "413 → rejected", show(tooBig));
  check(rate.result?.status === "retry" && rate.result?.retryAfter === 120, "429 → retry honouring Retry-After", show(rate));
  check(fail.result?.status === "retry", "500 → retry", show(fail));
  check(mixed.result?.status === "retry" && mixed.result?.deviceResults?.["219"]?.gone === true, "retryable plus gone → retry, still reporting the gone device", show(mixed));
  check(onlyFcm.result?.status === "skipped" && /no web push device/.test(onlyFcm.result?.reason ?? ""), "no web push device → skipped", show(onlyFcm));
  check(notHttps.result?.deviceResults?.["221"]?.gone === true && /https/.test(notHttps.result?.deviceResults?.["221"]?.reason ?? ""), "a non-https endpoint is never called and is retired", show(notHttps));
  check(badKeys.result?.deviceResults?.["222"]?.gone === true && /malformed/.test(badKeys.result?.deviceResults?.["222"]?.reason ?? ""), "malformed subscription keys → retired", show(badKeys));
  check(!push.requests.some((r) => r.name === "ok1"), "neither refused device reached a push service");

  section("Web Push: configuration");
  const other = crypto.createECDH("prime256v1");
  other.generateKeys();
  const [mismatch, half, loopbackProd] = await batch([
    send("push", "webpush", { ...env, VAPID_PUBLIC_KEY: b64u(other.getPublicKey()) }, { devices: [device(231, "ok1")] }),
    send("push", "webpush", { ...env, VAPID_PRIVATE_KEY: null }, { devices: [device(232, "ok1")] }),
    send("push", "webpush", { ...env, NOTIFY_ALLOW_TEST_DRIVER: null }, { devices: [device(233, "ok1")] }),
  ]);
  check(mismatch.configured === false && mismatch.result?.status === "skipped", "a public key that does not match the private key → not configured", show(mismatch));
  check(half.configured === false && half.result?.status === "skipped", "only one of the two VAPID keys → not configured", show(half));
  check(loopbackProd.result?.deviceResults?.["233"]?.gone === true, "plain-http loopback endpoints are refused outside a test environment", show(loopbackProd));

  // The development pair in notification_kv (SPEC §5.12), used when no env keys exist.
  const core = await harness("core", {});
  let rows = (await sql("SELECT k, v FROM notification_kv WHERE k IN ('vapid_public','vapid_private')")).rows ?? [];
  let inserted = null;
  if (rows.length < 2 && !core.vapidPublicKey) {
    const dev = crypto.createECDH("prime256v1");
    dev.generateKeys();
    inserted = { pub: b64u(dev.getPublicKey()), priv: b64u(pad32(dev.getPrivateKey())) };
    await sql("INSERT IGNORE INTO notification_kv (k, v, updated_at) VALUES ('vapid_public', ?, UTC_TIMESTAMP()), ('vapid_private', ?, UTC_TIMESTAMP())", [inserted.pub, inserted.priv]);
    note("notifyVapidPublicKey() is not available yet; a development pair was inserted for this check and is removed afterwards");
  }
  push.requests.length = 0;
  const devKeys = await harness("send", send("push", "webpush", { NOTIFY_ALLOW_TEST_DRIVER: "1", VAPID_PUBLIC_KEY: null, VAPID_PRIVATE_KEY: null }, { devices: [device(241, "ok1")] }, { core: true }));
  rows = (await sql("SELECT k, v FROM notification_kv WHERE k IN ('vapid_public','vapid_private')")).rows ?? [];
  const kvPublic = rows.find((r) => r.k === "vapid_public")?.v ?? "";
  const devReq = push.requests.find((r) => r.name === "ok1");
  check(devKeys.configured === true && devKeys.result?.status === "sent" && devReq?.vapid.ok === true, "without env keys the development pair from notification_kv signs", show(devKeys));
  check(kvPublic.includes("BEGIN") || devReq?.vapid.k === kvPublic, "k is notification_kv's vapid_public", `${devReq?.vapid.k} vs ${kvPublic}`);
  if (inserted) {
    await sql("DELETE FROM notification_kv WHERE (k = 'vapid_public' AND v = ?) OR (k = 'vapid_private' AND v = ?)", [inserted.pub, inserted.priv]);
  }
}

/* ── FCM ───────────────────────────────────────────────────────────────── */

async function testFcm() {
  const env = { FCM_PROJECT_ID: FCM.project, FCM_SERVICE_ACCOUNT_JSON: serviceAccount(), FCM_BASE_URL: LOCAL(PORT.fcm), FCM_TOKEN_URL: FCM.tokenUrl };
  const data = { url: `${SITE}/account?tab=bookings`, notificationId: 301, category: "booking", priority: "urgent", tag: "booking-1042", image: `${SITE}/uploads/seva.jpg` };
  const original = (await sql("SELECT v FROM notification_kv WHERE k = 'fcm_token'")).rows?.[0]?.v ?? null;
  const tmp = mkdtempSync(join(tmpdir(), "notify-providers-"));

  try {
    section("FCM HTTP v1: OAuth assertion, the message, token caching");
    const first = await harness("send", send("push", "fcm", env, {
      priority: "urgent",
      title: "Booking confirmed",
      body: "BK-1042 is confirmed.",
      devices: [{ id: 301, provider: "fcm", endpoint: "device-ok-1" }, { id: 302, provider: "webpush", endpoint: "https://push.example/x", keys: subs.ok1.keys }],
      data,
    }));
    const tokenReq = fcm.tokenRequests[0];
    const sent = fcm.sendRequests[0];
    const m = sent?.json?.message ?? {};
    check(first.configured === true && first.result?.status === "sent" && first.result?.messageId === `projects/${FCM.project}/messages/0:${RUN}1`, "accepted → sent with the message name", show(first));
    check(first.result?.deviceResults?.["301"]?.ok === true && first.result?.deviceResults?.["302"] === undefined, "only devices whose provider is fcm are sent", show(first.result?.deviceResults));
    check(fcm.tokenRequests.length === 1 && tokenReq?.signatureOk === true, "the RS256 assertion verifies with the service account's public key", show(tokenReq));
    check(tokenReq?.grantType === "urn:ietf:params:oauth:grant-type:jwt-bearer" && tokenReq?.header?.alg === "RS256" && tokenReq?.header?.kid === FCM.keyId, "jwt-bearer grant, alg RS256, kid");
    check(tokenReq?.claims?.iss === FCM.clientEmail && tokenReq?.claims?.scope === "https://www.googleapis.com/auth/firebase.messaging" && tokenReq?.claims?.aud === FCM.tokenUrl && tokenReq?.claims?.exp - tokenReq?.claims?.iat === 3600, "iss, firebase.messaging scope, aud = token URL, one-hour lifetime", show(tokenReq?.claims));
    check(sent?.project === FCM.project && fcm.issued.has(sent?.bearer), "POST /v1/projects/{id}/messages:send with the issued Bearer token");
    check(m.token === "device-ok-1" && show(m.notification) === show({ title: "Booking confirmed", body: "BK-1042 is confirmed.", image: data.image }), "token and notification {title, body, image}", show(m));
    check(show(m.data) === show({ url: data.url, notificationId: "301", category: "booking", priority: "urgent", tag: "booking-1042" }), "data values are all strings", show(m.data));
    check(m.android?.priority === "high" && m.apns?.headers?.["apns-priority"] === "10" && m.apns?.payload?.aps?.sound === "default", "urgent: android high, apns-priority 10, sound default", show([m.android, m.apns]));
    check(m.webpush?.fcm_options?.link === data.url, "webpush.fcm_options.link is the https deep link");

    const second = await harness("send", send("push", "fcm", env, { priority: "normal", devices: [{ id: 303, provider: "fcm", endpoint: "device-ok-2" }] }));
    const m2 = fcm.sendRequests.at(-1)?.json?.message ?? {};
    check(second.result?.status === "sent" && fcm.tokenRequests.length === 1, "a second worker process reuses the cached token (no token request)", `token requests ${fcm.tokenRequests.length}`);
    check(fcm.sendRequests.at(-1)?.bearer === sent?.bearer, "same bearer token from notification_kv");
    check(m2.android?.priority === "normal" && m2.apns?.headers?.["apns-priority"] === "5", "normal: android normal, apns-priority 5", show([m2.android, m2.apns]));
    const cached = safeJson((await sql("SELECT v FROM notification_kv WHERE k = 'fcm_token'")).rows?.[0]?.v ?? "");
    check(cached?.token === sent?.bearer && cached?.expires_at > Date.now() / 1000 + 3000 && /^[0-9a-f]{32}$/.test(cached?.fingerprint ?? ""), "notification_kv fcm_token holds the token, its expiry and an account fingerprint", show({ ...cached, token: cached?.token ? "…" : null }));

    section("FCM HTTP v1: errors and refresh");
    const [gone, mixed, invalid, quota, unavailable, noDevice] = await batch([
      send("push", "fcm", env, { devices: [{ id: 311, provider: "fcm", endpoint: "unregistered-1" }] }),
      send("push", "fcm", env, { devices: [{ id: 312, provider: "fcm", endpoint: "device-ok-3" }, { id: 313, provider: "fcm", endpoint: "unregistered-2" }] }),
      send("push", "fcm", env, { devices: [{ id: 314, provider: "fcm", endpoint: "invalid-1" }] }),
      send("push", "fcm", env, { devices: [{ id: 315, provider: "fcm", endpoint: "quota-1" }] }),
      send("push", "fcm", env, { devices: [{ id: 316, provider: "fcm", endpoint: "unavailable-1" }] }),
      send("push", "fcm", env, { devices: [{ id: 317, provider: "webpush", endpoint: "https://push.example/x" }] }),
    ]);
    check(gone.result?.status === "rejected" && gone.result?.reason === "every device is gone" && gone.result?.deviceResults?.["311"]?.gone === true, "UNREGISTERED → device gone", show(gone));
    check(mixed.result?.status === "sent" && mixed.result?.deviceResults?.["313"]?.gone === true, "one ok and one UNREGISTERED → sent, the stale token retired", show(mixed));
    check(invalid.result?.status === "rejected" && invalid.result?.deviceResults?.["314"]?.gone === false, "INVALID_ARGUMENT → rejected (not retired)", show(invalid));
    check(quota.result?.status === "retry" && quota.result?.retryAfter === 60, "QUOTA_EXCEEDED (429) → retry honouring Retry-After", show(quota));
    check(unavailable.result?.status === "retry", "UNAVAILABLE (503) → retry", show(unavailable));
    check(noDevice.result?.status === "skipped", "no FCM device → skipped", show(noDevice));
    check(fcm.tokenRequests.length === 1, "one batch of sends, still no new token", `token requests ${fcm.tokenRequests.length}`);

    fcm.revokeNext = true;
    const revoked = await harness("send", send("push", "fcm", env, { devices: [{ id: 321, provider: "fcm", endpoint: "device-ok-4" }] }));
    check(revoked.result?.status === "sent" && fcm.tokenRequests.length === 2, "a 401 on a cached token refreshes it once and the send succeeds", show(revoked));
    check(fcm.sendRequests.at(-1)?.bearer === `ya29.e2e-${RUN}-2`, "the retry used the fresh token");

    const file = join(tmp, "service-account.json");
    writeFileSync(file, serviceAccount());
    const [fromFile, noProject, broken, missingFile] = await batch([
      send("push", "fcm", { ...env, FCM_SERVICE_ACCOUNT_JSON: file }, { devices: [{ id: 331, provider: "fcm", endpoint: "device-ok-5" }] }),
      { command: "configured", channel: "push", driver: "fcm", env: { ...env, FCM_PROJECT_ID: null } },
      { command: "configured", channel: "push", driver: "fcm", env: { ...env, FCM_SERVICE_ACCOUNT_JSON: "{\"client_email\": \"x@y\"" } },
      { command: "configured", channel: "push", driver: "fcm", env: { ...env, FCM_SERVICE_ACCOUNT_JSON: join(tmp, "missing.json") } },
    ]);
    check(fromFile.configured === true && fromFile.result?.status === "sent", "FCM_SERVICE_ACCOUNT_JSON as a file path works", show(fromFile));
    check(noProject.configured === false && broken.configured === false && missingFile.configured === false, "no project id, unparsable JSON or a missing file → not configured", show([noProject, broken, missingFile]));

    const stranger = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const refused = await harness("send", send("push", "fcm", { ...env, FCM_SERVICE_ACCOUNT_JSON: serviceAccount(stranger.privateKey) }, { devices: [{ id: 341, provider: "fcm", endpoint: "device-ok-6" }] }));
    check(refused.result?.status === "retry" && refused.result?.retryAfter === 3600 && /FCM_SERVICE_ACCOUNT_JSON/.test(refused.result?.reason ?? ""), "a key Google refuses (invalid_grant) → retry in an hour", show(refused));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (original === null) await sql("DELETE FROM notification_kv WHERE k = 'fcm_token'");
    else await sql("UPDATE notification_kv SET v = ? WHERE k = 'fcm_token'", [original]);
  }
}

/* ── Webhooks through the endpoint ─────────────────────────────────────── */

function startPhpServer(port, env) {
  const [cmd, argv] = phpCommand(["-S", `127.0.0.1:${port}`, "-t", "backend", "tests/support/notify_webhook_router.php"]);
  const child = spawn(cmd, argv, { cwd: ROOT, env: phpEnv({ TRUSTED_PROXIES: "127.0.0.1,::1", ...env }), windowsHide: true });
  const server = { child, port, log: "" };
  child.stdout.setEncoding("utf8").on("data", (d) => (server.log += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (server.log += d));
  return server;
}
async function waitForServer(port) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${LOCAL(port)}/__health`, { headers: { "X-Forwarded-For": XFF } });
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  return false;
}
async function stopPhpServer(server) {
  if (!server) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
  else server.child.kill("SIGTERM");
  for (let i = 0; i < 20 && (await portInUse(server.port)); i += 1) await sleep(250);
  if (await portInUse(server.port) && process.platform === "win32") {
    // The port is in this suite's own range; whatever still holds it is our server.
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[1] === `127.0.0.1:${server.port}` && cols[3] === "LISTENING") spawnSync("taskkill", ["/pid", cols[4], "/T", "/F"], { windowsHide: true });
    }
  }
}
async function hook(port, method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${LOCAL(port)}${path}`, { method, headers: { "X-Forwarded-For": XFF, ...headers }, body, redirect: "manual" });
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
}
function twilioSignature(token, url, params) {
  // Exactly as Twilio documents it: the URL, then each name and value, names sorted.
  const data = Object.keys(params).sort().reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

async function testWebhooks() {
  const testSecret = `test-hook-secret-${RUN}`;
  const envA = {
    SITE_URL: LOCAL(PORT.hookA),
    NOTIFY_WHATSAPP_DRIVER: "twilio",
    NOTIFY_SMS_DRIVER: "twilio",
    NOTIFY_PUSH_DRIVER: "test",
    NOTIFY_ALLOW_TEST_DRIVER: "1",
    NOTIFY_TEST_WEBHOOK_SECRET: testSecret,
    TWILIO_ACCOUNT_SID: TWILIO.sid,
    TWILIO_AUTH_TOKEN: TWILIO.token,
    TWILIO_WHATSAPP_FROM: TWILIO.waFrom,
    TWILIO_SMS_FROM: TWILIO.smsFrom,
  };
  const envB = {
    SITE_URL: LOCAL(PORT.hookB),
    NOTIFY_WHATSAPP_DRIVER: "meta",
    NOTIFY_SMS_DRIVER: "msg91",
    WHATSAPP_META_TOKEN: META.token,
    WHATSAPP_META_PHONE_NUMBER_ID: META.phoneId,
    WHATSAPP_META_APP_SECRET: META.appSecret,
    WHATSAPP_META_VERIFY_TOKEN: META.verifyToken,
    MSG91_AUTH_KEY: MSG91.key,
    MSG91_WEBHOOK_TOKEN: MSG91.webhookToken,
  };
  const core = await harness("core", {});
  let serverA = null;
  let serverB = null;
  try {
    section("Webhook endpoint: servers");
    serverA = startPhpServer(PORT.hookA, envA);
    serverB = startPhpServer(PORT.hookB, envB);
    const readyA = await waitForServer(PORT.hookA);
    const readyB = await waitForServer(PORT.hookB);
    check(readyA && readyB, "both PHP webhook servers answer", serverA.log.slice(0, 300) + serverB.log.slice(0, 300));
    if (!readyA || !readyB) return;

    section("Webhook endpoint: Meta (server with NOTIFY_WHATSAPP_DRIVER=meta)");
    const verify = (token) => `/api/notify-webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
    const good = await hook(PORT.hookB, "GET", verify(META.verifyToken));
    check(good.status === 200 && good.text === "1158201444" && good.type.startsWith("text/plain"), "GET with the right verify token echoes hub.challenge", show(good));
    const bad = await hook(PORT.hookB, "GET", verify("wrong-token"));
    check(bad.status === 403 && bad.text === "", "GET with a wrong verify token → 403, no body", show(bad));

    const ts = 1789300000;
    const iso = (s) => new Date(s * 1000).toISOString().slice(0, 19).replace("T", " ");
    const metaBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "102290129340398",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550783881", phone_number_id: META.phoneId },
            statuses: [
              { id: `wamid.${RUN}.A`, status: "delivered", timestamp: String(ts), recipient_id: "919876540000" },
              { id: `wamid.${RUN}.B`, status: "read", timestamp: String(ts + 60), recipient_id: "919876540000" },
              { id: `wamid.${RUN}.C`, status: "failed", timestamp: String(ts + 120), recipient_id: "919876540000", errors: [{ code: 131047, title: "Re-engagement message", error_data: { details: "More than 24 hours have passed since the recipient last replied." } }] },
              { id: `wamid.${RUN}.D`, status: "deleted", timestamp: String(ts + 180) },
            ],
          },
        }],
      }],
    });
    const signature = "sha256=" + crypto.createHmac("sha256", META.appSecret).update(metaBody).digest("hex");
    const posted = await hook(PORT.hookB, "POST", "/api/notify-webhook/meta", { headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature }, body: metaBody });
    check(posted.status === 200, "POST with a valid X-Hub-Signature-256 → 200", show(posted));
    const forged = await hook(PORT.hookB, "POST", "/api/notify-webhook/meta", { headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + crypto.createHmac("sha256", "not-the-secret").update(metaBody).digest("hex") }, body: metaBody });
    check(forged.status === 403 && forged.text === "", "POST with a forged signature → 403, no body", show(forged));
    const unsigned = await hook(PORT.hookB, "POST", "/api/notify-webhook/meta", { headers: { "Content-Type": "application/json" }, body: metaBody });
    check(unsigned.status === 403, "POST without a signature → 403");
    const parsedMeta = await harness("webhook", { channel: "whatsapp", driver: "meta", env: { WHATSAPP_META_APP_SECRET: META.appSecret }, method: "POST", headers: { "X-Hub-Signature-256": signature }, body: metaBody });
    const mu = parsedMeta.result?.updates ?? [];
    check(mu.length === 3, "statuses parsed; an untracked status (deleted) is ignored", show(mu));
    check(mu[0]?.message_id === `wamid.${RUN}.A` && mu[0]?.status === "delivered" && mu[0]?.at === iso(ts) && mu[0]?.error === null, "delivered with its UTC time", show(mu[0]));
    check(mu[1]?.status === "read" && mu[1]?.at === iso(ts + 60), "read", show(mu[1]));
    check(mu[2]?.status === "failed" && /131047/.test(mu[2]?.error ?? "") && /24 hours/.test(mu[2]?.error ?? ""), "failed with errors[0] as the error", show(mu[2]));

    section("Webhook endpoint: Twilio (server with WhatsApp and SMS both on twilio)");
    const twilioUrl = `${LOCAL(PORT.hookA)}/api/notify-webhook/twilio`;
    const params = { AccountSid: TWILIO.sid, ApiVersion: "2010-04-01", ChannelPrefix: "whatsapp", From: TWILIO.waFrom, MessageSid: `SM${RUN}delivered`, MessageStatus: "delivered", SmsSid: `SM${RUN}delivered`, SmsStatus: "delivered", To: "whatsapp:+919876540000" };
    const form = new URLSearchParams(params).toString();
    const signed = await hook(PORT.hookA, "POST", "/api/notify-webhook/twilio", { headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, params) }, body: form });
    check(signed.status === 200 && signed.type.startsWith("text/xml") && signed.text === "<Response></Response>", "valid X-Twilio-Signature → 200 text/xml <Response></Response>", show(signed));
    const wrongSig = await hook(PORT.hookA, "POST", "/api/notify-webhook/twilio", { headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature("f".repeat(32), twilioUrl, params) }, body: form });
    check(wrongSig.status === 403 && wrongSig.text === "", "a signature made with another token → 403, no body", show(wrongSig));
    const otherUrl = await hook(PORT.hookA, "POST", "/api/notify-webhook/twilio", { headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(TWILIO.token, "https://elsewhere.example/api/notify-webhook/twilio", params) }, body: form });
    check(otherUrl.status === 403, "a signature over a different URL → 403");
    const tampered = await hook(PORT.hookA, "POST", "/api/notify-webhook/twilio", { headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, params) }, body: form.replace("delivered", "read") });
    check(tampered.status === 403, "a field changed after signing → 403");

    const failedParams = { AccountSid: TWILIO.sid, ErrorCode: "30003", ErrorMessage: "Unreachable destination handset + roaming", MessageSid: `SM${RUN}failed`, MessageStatus: "undelivered", To: "+919876540000" };
    const failedForm = new URLSearchParams(failedParams).toString();
    const parsedTwilio = await batch([
      { command: "webhook", channel: "sms", driver: "twilio", env: { TWILIO_AUTH_TOKEN: TWILIO.token }, method: "POST", url: twilioUrl, headers: { "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, failedParams) }, body: failedForm },
      { command: "webhook", channel: "whatsapp", driver: "twilio", env: { TWILIO_AUTH_TOKEN: TWILIO.token }, method: "POST", url: twilioUrl, headers: { "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, params) }, body: form },
      { command: "webhook", channel: "whatsapp", driver: "twilio", env: { TWILIO_AUTH_TOKEN: TWILIO.token }, method: "POST", url: "https://temple.example/api/notify-webhook/twilio", headers: { "X-Twilio-Signature": twilioSignature(TWILIO.token, "https://temple.example:443/api/notify-webhook/twilio", params) }, body: form },
    ]);
    const tf = parsedTwilio[0].result?.updates?.[0];
    check(tf?.message_id === `SM${RUN}failed` && tf?.status === "failed" && /30003/.test(tf?.error ?? "") && /roaming/.test(tf?.error ?? ""), "undelivered → failed with ErrorCode (values with + and spaces verify)", show(parsedTwilio[0]));
    check(parsedTwilio[1].result?.updates?.[0]?.status === "delivered", "delivered → delivered", show(parsedTwilio[1]));
    check(parsedTwilio[2].result?.ok === true, "a signature over the URL with its default port also verifies", show(parsedTwilio[2]));
    const states = await batch(["queued", "sending", "sent", "read", "failed"].map((state) => {
      const p = { MessageSid: `SM${RUN}${state}`, MessageStatus: state };
      return { command: "webhook", channel: "sms", driver: "twilio", env: { TWILIO_AUTH_TOKEN: TWILIO.token }, method: "POST", url: twilioUrl, headers: { "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, p) }, body: new URLSearchParams(p).toString() };
    }));
    check(show(states.map((s) => s.result?.updates?.[0]?.status)) === show(["sent", "sent", "sent", "read", "failed"]), "queued/sending/sent → sent, read → read, failed → failed", show(states.map((s) => s.result?.updates)));

    section("Webhook endpoint: MSG91 (token in the URL)");
    const msgBody = JSON.stringify({ data: [{ requestId: `3763${RUN}1`, userId: "1", report: [{ date: "2026-09-13 10:15:00", number: "919876540000", status: "1", desc: "DELIVERED" }] }] });
    const tokenOk = await hook(PORT.hookB, "POST", `/api/notify-webhook/msg91?token=${encodeURIComponent(MSG91.webhookToken)}`, { headers: { "Content-Type": "application/json" }, body: msgBody });
    check(tokenOk.status === 200 && safeJson(tokenOk.text)?.ok === true, "the right token → 200", show(tokenOk));
    const tokenBad = await hook(PORT.hookB, "POST", "/api/notify-webhook/msg91?token=guess", { headers: { "Content-Type": "application/json" }, body: msgBody });
    const tokenNone = await hook(PORT.hookB, "POST", "/api/notify-webhook/msg91", { headers: { "Content-Type": "application/json" }, body: msgBody });
    check(tokenBad.status === 403 && tokenNone.status === 403 && tokenBad.text === "", "a wrong or missing token → 403", show([tokenBad, tokenNone]));
    const m91 = { MSG91_WEBHOOK_TOKEN: MSG91.webhookToken };
    const q = { token: MSG91.webhookToken };
    const parsed91 = await batch([
      { command: "webhook", channel: "sms", driver: "msg91", env: m91, method: "POST", query: q, body: msgBody },
      { command: "webhook", channel: "sms", driver: "msg91", env: m91, method: "POST", query: q, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(JSON.stringify([{ requestId: "R-FORM", report: [{ number: "919876540000", status: "2", desc: "FAILED" }] }])) },
      { command: "webhook", channel: "sms", driver: "msg91", env: m91, method: "POST", query: q, body: JSON.stringify({ request_id: "R-FLAT", status: "rejected", description: "Rejected by operator (DLT template mismatch)" }) },
      { command: "webhook", channel: "sms", driver: "msg91", env: m91, method: "POST", query: q, body: JSON.stringify([{ requestId: "R-SENT", status: "sent" }, { requestId: "R-NDNC", status: "9" }]) },
      { command: "webhook", channel: "sms", driver: "msg91", env: m91, method: "GET", query: { ...q, requestId: "R-GET", status: "delivered" } },
    ]);
    const d1 = parsed91[0].result?.updates?.[0];
    check(d1?.message_id === `3763${RUN}1` && d1?.status === "delivered" && d1?.at === "2026-09-13 04:45:00", "JSON report: DELIVERED, IST time stored as UTC", show(d1));
    const d2 = parsed91[1].result?.updates?.[0];
    check(d2?.message_id === "R-FORM" && d2?.status === "failed" && /FAILED/.test(d2?.error ?? ""), "form report with a JSON data field: FAILED → failed", show(parsed91[1]));
    check(parsed91[2].result?.updates?.[0]?.status === "rejected" && /DLT/.test(parsed91[2].result?.updates?.[0]?.error ?? ""), "flat JSON with request_id: rejected with its description", show(parsed91[2]));
    check(show(parsed91[3].result?.updates?.map((u) => [u.message_id, u.status])) === show([["R-SENT", "sent"], ["R-NDNC", "failed"]]), "a list of reports: sent, and numeric code 9 (NDNC) → failed", show(parsed91[3]));
    check(parsed91[4].result?.updates?.[0]?.message_id === "R-GET" && parsed91[4].result?.updates?.[0]?.status === "delivered", "a GET report reads the query string", show(parsed91[4]));

    section("Webhook endpoint: test driver, routing and refusals");
    const testBody = JSON.stringify({ updates: [{ message_id: `test-e2e-${RUN}`, status: "delivered" }] });
    const testOk = await hook(PORT.hookA, "POST", "/api/notify-webhook/test", { headers: { "Content-Type": "application/json", "X-Test-Signature": crypto.createHmac("sha256", testSecret).update(testBody).digest("hex") }, body: testBody });
    check(testOk.status === 200 && testOk.type.startsWith("application/json") && safeJson(testOk.text)?.ok === true, "test driver with a valid X-Test-Signature → 200", show(testOk));
    const testBad = await hook(PORT.hookA, "POST", "/api/notify-webhook/test", { headers: { "Content-Type": "application/json", "X-Test-Signature": "0".repeat(64) }, body: testBody });
    check(testBad.status === 403 && testBad.text === "", "test driver with a bad signature → 403", show(testBad));
    const notHere = await hook(PORT.hookA, "POST", "/api/notify-webhook/meta", { body: "{}" });
    const fcmHere = await hook(PORT.hookA, "POST", "/api/notify-webhook/fcm", { body: "{}" });
    const badName = await hook(PORT.hookA, "POST", "/api/notify-webhook/Not_A_Driver", { body: "{}" });
    check(notHere.status === 404 && fcmHere.status === 404 && badName.status === 404, "a driver not configured on this server, or a malformed name → 404", show([notHere.status, fcmHere.status, badName.status]));
    const huge = await hook(PORT.hookA, "POST", "/api/notify-webhook/test", { headers: { "Content-Type": "application/json" }, body: "x".repeat(1024 * 1024 + 10) });
    check(huge.status === 413, "a body over 1 MB → 413", show(huge.status));
    const twilioGet = await hook(PORT.hookA, "GET", "/api/notify-webhook/twilio");
    check(twilioGet.status === 403, "Twilio GET (unsigned) → 403");

    await sleep(300);
    check(/\[notify-webhook\] meta POST refused with 403 \(signature mismatch\) from 10\.20\.0\.1/.test(serverB.log), "a refusal is logged with the reason and the caller, never in the response", serverB.log.slice(-600));
    // The built-in server's access log records query strings, so the MSG91 token and
    // Meta's verify token appear there by design (see NotifyMsg91SmsProvider). Secrets
    // that never travel in a URL must not appear anywhere.
    check(![META.appSecret, TWILIO.token, testSecret].some((s) => serverA.log.includes(s) || serverB.log.includes(s)), "no signing secret appears in the server logs");
    const noise = /(PHP )?(Warning|Notice|Deprecated|Fatal error|Parse error)/.exec(serverA.log + serverB.log);
    check(!noise, "no PHP warnings, notices or fatals from the endpoint", noise ? (serverA.log + serverB.log).slice(Math.max(0, noise.index - 200), noise.index + 300) : "");

    section("Webhook endpoint: applying updates");
    if (core.applyProviderUpdate) {
      const created = await fixtures("create-devotee", { email: `${EMAIL_PREFIX}-hook@example.test` });
      const dedupe = `e2e:providers:${RUN}:hook`;
      await sql("INSERT INTO notifications (devotee_id, title, body, category, dedupe_key, created_by, created_at) VALUES (?, 'E2E-PROVIDERS webhook', 'x', 'general', ?, 'system', UTC_TIMESTAMP())", [created.id, dedupe]);
      const notificationId = (await sql("SELECT id FROM notifications WHERE dedupe_key = ?", [dedupe])).rows?.[0]?.id;
      const twilioSid = `SM${RUN}applied`;
      await sql("INSERT INTO notification_deliveries (notification_id, channel, status, provider, provider_message_id, sent_at) VALUES (?, 'sms', 'sent', 'twilio', ?, UTC_TIMESTAMP()), (?, 'push', 'sent', 'test', ?, UTC_TIMESTAMP())", [notificationId, twilioSid, notificationId, `test-e2e-${RUN}`]);
      const p = { MessageSid: twilioSid, MessageStatus: "delivered" };
      await hook(PORT.hookA, "POST", "/api/notify-webhook/twilio", { headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, p) }, body: new URLSearchParams(p).toString() });
      await hook(PORT.hookA, "POST", "/api/notify-webhook/test", { headers: { "Content-Type": "application/json", "X-Test-Signature": crypto.createHmac("sha256", testSecret).update(testBody).digest("hex") }, body: testBody });
      const rows = (await sql("SELECT channel, status FROM notification_deliveries WHERE notification_id = ?", [notificationId])).rows ?? [];
      const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r.status]));
      check(byChannel.sms === "delivered" && byChannel.push === "delivered", "verified updates reach notification_deliveries through notifyApplyProviderUpdate()", show(rows));
    } else {
      const before = (serverA.log.match(/verified status update\(s\) not applied/g) ?? []).length;
      const p = { MessageSid: `SM${RUN}once`, MessageStatus: "delivered" };
      await hook(PORT.hookA, "POST", "/api/notify-webhook/twilio", { headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": twilioSignature(TWILIO.token, twilioUrl, p) }, body: new URLSearchParams(p).toString() });
      await sleep(300);
      const after = (serverA.log.match(/twilio: 1 verified status update\(s\) not applied/g) ?? []).length;
      check(after === before + 1, "with WhatsApp and SMS both on twilio, one callback is handled once, not per channel", `log lines ${before} → ${after}`);
      note("notifyApplyProviderUpdate() is not available yet (core, phase 1): updates were asserted through the harness; the endpoint logs that it could not apply them and still answers the provider");
    }
  } finally {
    await stopPhpServer(serverA);
    await stopPhpServer(serverB);
  }
}

/* ── notify_keys.php ───────────────────────────────────────────────────── */

async function testKeysCli() {
  section("backend/bin/notify_keys.php");
  const vapid = await runPhp(["backend/bin/notify_keys.php", "vapid"]);
  const pub = /^VAPID_PUBLIC_KEY=([A-Za-z0-9_-]+)$/m.exec(vapid.stdout)?.[1] ?? "";
  const priv = /^VAPID_PRIVATE_KEY=([A-Za-z0-9_-]+)$/m.exec(vapid.stdout)?.[1] ?? "";
  check(vapid.code === 0 && vapid.stdout.trim().split(/\r?\n/).length === 2, "vapid prints exactly two lines on stdout", vapid.stdout + vapid.stderr);
  check(b64uDecode(pub).length === 65 && b64uDecode(pub)[0] === 4 && b64uDecode(priv).length === 32, "a 65-byte public point and a 32-byte private key");
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(b64uDecode(priv));
  check(b64u(ecdh.getPublicKey()) === pub, "the printed public key belongs to the printed private key");

  const fine = {
    SITE_URL: SITE,
    NOTIFY_WHATSAPP_DRIVER: "meta", WHATSAPP_META_TOKEN: META.token, WHATSAPP_META_PHONE_NUMBER_ID: META.phoneId, WHATSAPP_META_APP_SECRET: META.appSecret, WHATSAPP_META_VERIFY_TOKEN: META.verifyToken,
    NOTIFY_SMS_DRIVER: "msg91", MSG91_AUTH_KEY: MSG91.key, MSG91_WEBHOOK_TOKEN: MSG91.webhookToken,
    NOTIFY_PUSH_DRIVER: "webpush", VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, VAPID_SUBJECT: VAPID.subject,
  };
  const ok = await runPhp(["backend/bin/notify_keys.php", "check"], { env: fine });
  notePhpNoise("notify_keys check", ok.stdout + ok.stderr);
  check(ok.code === 0 && /push \(driver "webpush"\): ready/.test(ok.stdout) && /whatsapp \(driver "meta"\): ready/.test(ok.stdout) && /sms \(driver "msg91"\): ready/.test(ok.stdout), "check with good settings: every channel ready, exit 0", ok.stdout.slice(0, 1200));
  check(/the VAPID public and private keys belong together/.test(ok.stdout), "check confirms the VAPID pair matches");
  check(![priv, META.token, META.appSecret, MSG91.key, MSG91.webhookToken].some((s) => ok.stdout.includes(s) || ok.stderr.includes(s)), "check prints no secret");

  const broken = await runPhp(["backend/bin/notify_keys.php", "check"], { env: { ...fine, VAPID_PUBLIC_KEY: VAPID.public, NOTIFY_SMS_DRIVER: "twilio", TWILIO_ACCOUNT_SID: "AC123" } });
  check(broken.code === 1 && /does not belong to VAPID_PRIVATE_KEY/.test(broken.stdout) && /TWILIO_ACCOUNT_SID must be AC/.test(broken.stdout), "check with a mismatched pair and a bad SID: named problems, exit 1", broken.stdout.slice(0, 1500));

  const fcmCheck = await runPhp(["backend/bin/notify_keys.php", "check"], { env: { SITE_URL: SITE, NOTIFY_PUSH_DRIVER: "fcm", FCM_PROJECT_ID: FCM.project, FCM_SERVICE_ACCOUNT_JSON: serviceAccount() } });
  check(/push \(driver "fcm"\): ready/.test(fcmCheck.stdout) && /private_key loads/.test(fcmCheck.stdout) && !fcmCheck.stdout.includes("PRIVATE KEY"), "check validates the FCM service account without printing the key", fcmCheck.stdout.slice(-900));
  const unknown = await runPhp(["backend/bin/notify_keys.php", "rotate"]);
  check(unknown.code === 2, "an unknown command exits 2");
}

/* ── Run ───────────────────────────────────────────────────────────────── */

async function main() {
  console.log(`notify-providers — run ${RUN}, PHP ${PHP_BIN}`);
  const busy = [];
  for (const port of Object.values(PORT)) if (await portInUse(port)) busy.push(port);
  if (busy.length) {
    console.error(`Ports already in use: ${busy.join(", ")}. Another run of this suite may still be going; nothing was changed.`);
    process.exit(2);
  }

  const servers = [];
  try {
    servers.push(await startHttp(PORT.meta, metaHandler));
    servers.push(await startHttp(PORT.twilio, twilioHandler));
    servers.push(await startHttp(PORT.msg91, msg91Handler));
    servers.push(await startSmtp(PORT.smtp));
    servers.push(await startHttp(PORT.push, pushHandler));
    servers.push(await startHttp(PORT.fcm, fcmHandler));

    const suites = [testMailer, testMeta, testTwilio, testMsg91, testWebPush, testFcm, testWebhooks, testKeysCli];
    for (const suite of suites) {
      try {
        await suite();
      } catch (e) {
        check(false, `${suite.name} completed without throwing`, e?.stack ?? String(e));
      }
    }
    section("PHP output");
    check(phpNoise.length === 0, "no PHP warnings, notices or fatals from any harness or CLI run", phpNoise.slice(0, 5).join(" | "));
  } finally {
    section("Cleanup");
    const cleaned = await fixtures("cleanup", { email_prefix: EMAIL_PREFIX });
    const mail = await sql("DELETE FROM mail_log WHERE to_email LIKE ?", ["e2e-providers-%"]);
    console.log(`  removed ${cleaned.deleted_devotees ?? 0} devotee(s) and ${mail.affected ?? 0} mail_log row(s)`);
    for (const s of servers) {
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
    const left = [];
    for (const port of Object.values(PORT)) if (await portInUse(port)) left.push(port);
    if (left.length) console.log(`  WARNING ports still listening: ${left.join(", ")}`);
    else console.log("  every port in 8020–8029 is closed again");
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length ? 1 : 0);
}

main();
