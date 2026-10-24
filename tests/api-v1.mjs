#!/usr/bin/env node
/**
 * tests/api-v1.mjs — the versioned API (brief §26, GAP-ANALYSIS G-12):
 * /api/v1/<anything> is an alias of /api/<anything>, and under the prefix
 * every JSON answer carries the envelope
 *
 *   success  {"success":true,"data":<today's payload>,"message":""}
 *   error    {"success":false,"error":{"code":…,"message":…,"fields":{…}}}
 *
 * while the unversioned /api/* keeps today's shapes byte for byte.
 *
 *   node tests/api-v1.mjs
 *
 * What it proves:
 *   • every GET route registered in backend/api/index.php (the table is read
 *     from the file, so a new route is covered the day it is added), the
 *     pattern routes (events/{id}, pages/{slug}, live-streams/*, payments/*,
 *     the cron endpoints, the admin live API) and the POST forms answer the
 *     same status and the same headers on both prefixes, and the v1 body is
 *     exactly the envelope of the unversioned body
 *   • the 400/422 (with fields), 401, 403, 404, 405 and 429 envelopes, and
 *     the status → code map for the statuses no public route can be made to
 *     answer on demand (409, 413, 500, 503)
 *   • the alias table: /api/v1/home, /api/v1/streams[/…], /api/v1/sponsors,
 *     /api/v1/payments/ccavenue/*; /api/v1/auth has no target and says so
 *   • the unversioned bodies are what they were before the envelope existed
 *     (fixed bytes for the 404, 405, 422, 429 and 401 shapes; no envelope key
 *     on any list), so the React app and every other suite see no change
 *   • nothing that is not JSON is ever wrapped: og.php, sitemap.php,
 *     robots.php, spa.php, the CCAvenue return / cancel / notify answers, the
 *     simulator, a notification webhook, a tracked link; OPTIONS and HEAD
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1, NOTIFY_CRON_KEY set
 * so the cron endpoint can answer 403). Needs the DB_* environment. Writes
 * nothing but rate_limits buckets for its own X-Forwarded-For range
 * (10.93.<run>.x), removed in `finally`.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const NET = Date.now() % 256;                       // this run's X-Forwarded-For range: 10.93.<NET>.x
const CRON_KEY = `e2e-api-v1-${RUN}-0123456789abcdef`;
const FATAL = /(PHP (Warning|Notice|Fatal error|Deprecated)|<b>(Warning|Notice|Fatal error|Deprecated)<\/b>|Uncaught|Stack trace|SQLSTATE)/;
const IGNORED_HEADERS = new Set(["date", "host", "x-powered-by", "connection", "content-length", "transfer-encoding"]);
// Values that legitimately differ between two fetches a few milliseconds apart.
const VOLATILE = /"(serverTime|server_time|countdownSec|starts_in_seconds|generated_at)":(?:"[^"]*"|-?\d+)/g;
const FALLBACK = {
  UNAUTHORIZED: "Sign in first", FORBIDDEN: "Forbidden", NOT_FOUND: "Not found", METHOD_NOT_ALLOWED: "Method not allowed",
  RATE_LIMITED: "Too many requests. Please try again later.", SERVER_ERROR: "The server could not complete that request. Please try again.",
  VALIDATION_ERROR: "Please check the request.",
};
const CODE = { 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 429: "RATE_LIMITED" };

let pass = 0;
let fail = 0;
let log = "";
let server;
let base;
let xffN = 0;
const ip = (n) => `10.93.${NET}.${n}`;
const xff = () => ip((xffN++ % 200) + 10);
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 500)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);

function sql(query, params = []) {
  const r = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], { cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

async function request(method, path, { body, headers = {}, from } = {}) {
  const h = { "X-Forwarded-For": from ?? xff(), ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}
const get = (path, opts) => request("GET", path, opts);
const post = (path, body, opts = {}) => request("POST", path, { body, ...opts });

/** The envelope apiEnvelope() (includes/helpers.php) builds for an error payload. */
function expectedError(json, status) {
  const code = CODE[status] ?? (status >= 500 ? "SERVER_ERROR" : "VALIDATION_ERROR");
  const given = json && typeof json === "object" && !Array.isArray(json) ? json : {};
  const error = { code, message: typeof given.error === "string" && given.error !== "" ? given.error : FALLBACK[code] };
  if (typeof given.code === "string" && given.code !== "") error.reason = given.code;
  if (given.fields && typeof given.fields === "object") error.fields = Array.isArray(given.fields) && given.fields.length === 0 ? {} : given.fields;
  for (const [k, v] of Object.entries(given)) if (!["error", "code", "fields"].includes(k) && !(k in error)) error[k] = v;
  return { success: false, error };
}
const stable = (text) => text.replace(VOLATILE, '"$1":0');
const headerMap = (headers) => {
  const out = {};
  for (const [k, v] of headers) if (!IGNORED_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
};
const isEnvelope = (json) => json && typeof json === "object" && !Array.isArray(json) && typeof json.success === "boolean"
  && (json.success ? "data" in json && "message" in json : json.error && typeof json.error === "object");

/**
 * The core assertion: /api/v1<path> answers what /api<path> answers, wrapped.
 * Same status, the same headers (names and values), and the body either the
 * exact success envelope around the unversioned bytes or the error envelope.
 */
async function alias(v1Path, plainPath, { method = "GET", body, volatile = false, label } = {}) {
  const from = xff();
  const plain = await request(method, `/api${plainPath}`, { body, from });
  const v1 = await request(method, `/api/v1${v1Path}`, { body, from });
  const name = label ?? `${method} /api/v1${v1Path} ≡ /api${plainPath}`;
  const sameStatus = plain.status === v1.status;
  const sameHeaders = JSON.stringify(headerMap(plain.headers)) === JSON.stringify(headerMap(v1.headers));
  let sameBody;
  if (plain.status < 400) {
    sameBody = stable(v1.text) === stable(`{"success":true,"data":${plain.text},"message":""}`) && (volatile || v1.text === `{"success":true,"data":${plain.text},"message":""}`);
  } else {
    sameBody = JSON.stringify(v1.json) === JSON.stringify(expectedError(plain.json, plain.status));
  }
  check(sameStatus && sameHeaders && sameBody, `${name} (${plain.status})`,
    `status ${plain.status}/${v1.status}; headers ${JSON.stringify(headerMap(plain.headers))} vs ${JSON.stringify(headerMap(v1.headers))}; plain ${plain.text.slice(0, 160)} | v1 ${v1.text.slice(0, 200)}`);
  check(!isEnvelope(plain.json), `  …and /api${plainPath} itself is not wrapped`, plain.text.slice(0, 120));
  return { plain, v1 };
}

try {
  /* ── server ─────────────────────────────────────────────────────────── */
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  base = `http://127.0.0.1:${port}`;
  server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: resolve(root, "backend"),
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", NOTIFY_CRON_KEY: CRON_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/api/pulse`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── every GET route in the table ───────────────────────────────────── */
  section("every GET route registered in backend/api/index.php");
  const src = readFileSync(resolve(root, "backend/api/index.php"), "utf8");
  const table = /'GET'\s*=>\s*\[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
  const routes = [...table.matchAll(/'(\/[^']+)'\s*=>/g)].map((m) => m[1]);
  check(routes.length >= 15 && routes.includes("/deities") && routes.includes("/homepage_widgets"), `the route table was read from index.php (${routes.length} GET routes)`, routes.join(" "));
  const withQuery = { "/search": "?q=pooja", "/gallery": "?limit=2", "/poojas": "?limit=3", "/events": "?upcoming=1" };
  for (const route of routes) {
    const q = withQuery[route] ?? "";
    await alias(route + q, route + q, { volatile: route === "/pulse" });
  }

  section("the pattern routes");
  const events = (await get("/api/events")).json;
  const eventId = Array.isArray(events) && events[0]?.id ? events[0].id : (events?.events?.[0]?.id ?? 999999999);
  await alias(`/events/${eventId}`, `/events/${eventId}`);
  await alias("/events/999999999", "/events/999999999");
  const pages = (await get("/api/pages")).json;
  const slug = Array.isArray(pages) && pages[0]?.slug ? pages[0].slug : (pages?.pages?.[0]?.slug ?? "no-such-page");
  await alias(`/pages/${slug}`, `/pages/${slug}`);
  await alias("/pages/no-such-page", "/pages/no-such-page");
  for (const p of ["/live-streams", "/live-streams/live", "/live-streams/upcoming", "/live-streams/schedule?filter=week", "/live-streams/archive", "/live-streams/999999999", "/live-streams/no-such-stream"]) {
    await alias(p, p, { volatile: true });
  }
  await alias("/payments/config", "/payments/config");
  await alias("/payments/status?ref=x&t=y", "/payments/status?ref=x&t=y");
  await alias("/payments/verify?r=x&v=y", "/payments/verify?r=x&v=y");
  await alias("/registrations", "/registrations");                          // 405: the form is POST-only
  await alias("/live-subscriptions/unsubscribe", "/live-subscriptions/unsubscribe");
  await alias("/live-cron", "/live-cron");                                  // 404: no key configured
  await alias("/payments-cron", "/payments-cron");
  await alias("/admin/live-streams", "/admin/live-streams");                // 401 without a session cookie
  await alias("/admin/live-streams/1", "/admin/live-streams/1");
  await alias("/events?type=junk", "/events?type=junk");                    // 422 from a list
  await alias("/videos?page=abc", "/videos?page=abc");
  await alias("/gallery?album=no-such-album", "/gallery?album=no-such-album");

  /* ── the error envelopes ────────────────────────────────────────────── */
  section("the error envelopes");
  let r = await get("/api/v1/no-such-route");
  check(r.status === 404 && r.text === '{"success":false,"error":{"code":"NOT_FOUND","message":"Not found"}}', "404 → NOT_FOUND", r.text);
  r = await get("/api/v1");
  check(r.status === 404 && r.json?.error?.code === "NOT_FOUND", "/api/v1 alone is not a route", r.text);
  r = await get("/api/v1/registrations");
  check(r.status === 405 && r.text === '{"success":false,"error":{"code":"METHOD_NOT_ALLOWED","message":"Method not allowed"}}', "405 → METHOD_NOT_ALLOWED (GET on the registration form)", r.text);
  r = await post("/api/v1/live-streams", {});
  check(r.status === 405 && r.json?.error?.code === "METHOD_NOT_ALLOWED" && r.headers.get("allow") === "GET, HEAD", "405 → METHOD_NOT_ALLOWED keeps the Allow header (POST on live-streams)", `${r.status} ${r.headers.get("allow")} ${r.text}`);
  r = await post("/api/v1/registrations", {});
  check(r.status === 422 && r.json?.error?.code === "VALIDATION_ERROR" && r.json.error.message === "Please correct the highlighted fields." && typeof r.json.error.fields?.name === "string" && typeof r.json.error.fields?.phone === "string", "422 → VALIDATION_ERROR with the per-field messages under error.fields", r.text);
  check(Object.keys(r.json?.error ?? {}).join(",") === "code,message,fields", "…and nothing else in error", r.text);
  r = await post("/api/v1/contact", {});
  check(r.status === 400 && r.text === '{"success":false,"error":{"code":"VALIDATION_ERROR","message":"Name, phone, and message are required"}}', "POST /api/v1/contact with nothing → 400 VALIDATION_ERROR with the sentence the form shows", r.text);
  r = await post("/api/v1/contact", { name: `E2E-APIV1-${RUN}`, phone: "919876543210", message: "hello", email: "not-an-email" });
  check(r.status === 400 && r.json?.error?.code === "VALIDATION_ERROR" && /valid email/.test(r.json.error.message), "…a bad email is a VALIDATION_ERROR naming the problem (no fields: contact.php reports none today)", r.text);
  r = await get("/api/v1/admin/live-streams");
  check(r.status === 401 && r.text === '{"success":false,"error":{"code":"UNAUTHORIZED","message":"Sign in to the admin first","reason":"unauthenticated"}}', "401 → UNAUTHORIZED on the admin API without a session; the endpoint's own code survives as reason", r.text);
  r = await get("/api/v1/notify-cron?key=wrong");
  check(r.status === 403 && r.text === '{"success":false,"error":{"code":"FORBIDDEN","message":"Forbidden"}}', "403 → FORBIDDEN (cron endpoint, wrong key)", r.text);
  r = await get("/api/v1/payments/status?ref=x&t=y");
  check(r.status === 404 && r.json?.error?.code === "NOT_FOUND" && r.json.error.reason === "not_found", "a handler's own code ('not_found') is kept as error.reason", r.text);

  const flooder = ip(250);
  let last;
  for (let i = 0; i < 16; i++) last = await post("/api/v1/contact", {}, { from: flooder });
  check(last.status === 429 && last.json?.error?.code === "RATE_LIMITED" && last.json.error.reason === "rate_limited" && Number.isInteger(last.json.error.retryAfter) && /^\d+$/.test(last.headers.get("retry-after") ?? ""), "429 → RATE_LIMITED after the 15 contact attempts an address gets, with retryAfter and the Retry-After header", `${last.status} ${last.headers.get("retry-after")} ${last.text}`);
  const plainFlood = await post("/api/contact", {}, { from: flooder });
  check(plainFlood.status === 429 && Object.keys(plainFlood.json ?? {}).join(",") === "error,code,retryAfter", "…while the unversioned 429 keeps its {error, code, retryAfter} shape", plainFlood.text);

  const map = spawnSync(php, ["-r", "define('API_ENVELOPE', true); require $argv[1]; foreach ([400, 401, 403, 404, 405, 409, 413, 422, 429, 500, 503] as $s) echo $s, '=', apiEnvelope(['error' => 'x'], $s)['error']['code'], ' '; echo json_encode(apiEnvelope(['error' => 'Too large', 'fields' => []], 413)), ' ', json_encode(apiEnvelope(['error' => 'Boom', 'reference' => 'AB12'], 500)), ' ', json_encode(apiEnvelope([], 200)), ' ', json_encode(apiEnvelope(null, 201));", resolve(root, "backend/includes/helpers.php")], { cwd: root, encoding: "utf8" });
  check(map.status === 0 && map.stdout.startsWith("400=VALIDATION_ERROR 401=UNAUTHORIZED 403=FORBIDDEN 404=NOT_FOUND 405=METHOD_NOT_ALLOWED 409=VALIDATION_ERROR 413=VALIDATION_ERROR 422=VALIDATION_ERROR 429=RATE_LIMITED 500=SERVER_ERROR 503=SERVER_ERROR "), "status → code map: 400/409/413/422 VALIDATION_ERROR, 401, 403, 404, 405, 429, 5xx SERVER_ERROR", map.stdout + map.stderr);
  check(map.stdout.includes('{"success":false,"error":{"code":"VALIDATION_ERROR","message":"Too large","fields":{}}}'), "an empty fields list is sent as {} so the type never changes", map.stdout);
  check(map.stdout.includes('{"success":false,"error":{"code":"SERVER_ERROR","message":"Boom","reference":"AB12"}}'), "a 500's reference is kept under error", map.stdout);
  check(map.stdout.endsWith('{"success":true,"data":[],"message":""} {"success":true,"data":null,"message":""}'), "success wraps any payload as data, with message \"\"", map.stdout);

  /* ── the alias table ────────────────────────────────────────────────── */
  section("the alias table (brief §26 names that differ from today's routes)");
  await alias("/home", "/homepage_widgets", { label: "GET /api/v1/home ≡ /api/homepage_widgets" });
  await alias("/streams", "/live-streams", { volatile: true, label: "GET /api/v1/streams ≡ /api/live-streams" });
  await alias("/streams/upcoming", "/live-streams/upcoming", { volatile: true, label: "GET /api/v1/streams/upcoming ≡ /api/live-streams/upcoming" });
  await alias("/streams/schedule?filter=week", "/live-streams/schedule?filter=week", { volatile: true, label: "GET /api/v1/streams/schedule ≡ /api/live-streams/schedule" });
  await alias("/streams/999999999", "/live-streams/999999999", { label: "GET /api/v1/streams/<id> ≡ /api/live-streams/<id> (404)" });
  await alias("/sponsors", "/poojas", { label: "GET /api/v1/sponsors ≡ /api/poojas (sponsorship amount, availability, consented sponsor)" });
  await alias("/sponsors?all=1&limit=2", "/poojas?all=1&limit=2", { label: "GET /api/v1/sponsors?all=1&limit=2 ≡ /api/poojas?all=1&limit=2 (query string passes through)" });
  r = await get("/api/v1/auth/me");
  check(r.status === 404 && r.json?.error?.code === "NOT_FOUND", "/api/v1/auth/* has no target (no public auth API; admin sign-in is /admin/login.php) and answers NOT_FOUND", r.text);
  r = await get("/api/v1/streams/");
  check(r.status === 200 && r.json?.success === true, "a trailing slash is tolerated on the alias too", r.text.slice(0, 100));
  r = await get("/api/home");
  check(r.status === 404 && r.text === '{"error":"Not found"}', "the alias exists under v1 only: /api/home is still not a route", r.text);
  r = await get("/api/v10/deities");
  check(r.status === 404 && r.text === '{"error":"Not found"}', "/api/v10 is not a version", r.text);

  /* ── CCAvenue routes: the same handlers, never wrapped ──────────────── */
  section("/api/v1/payments/ccavenue/* → the existing payments routes, pass-through");
  for (const route of ["response", "cancel"]) {
    const plain = await get(`/api/payments/ccavenue/${route}`);
    const v1 = await get(`/api/v1/payments/ccavenue/${route}`);
    check(plain.status === 303 && v1.status === 303 && v1.headers.get("location") === plain.headers.get("location") && v1.text === plain.text && /^text\/plain/.test(v1.headers.get("content-type") ?? ""), `GET ccavenue/${route}: a 303 to the donations page on both prefixes`, `${plain.status}/${v1.status} ${plain.headers.get("location")} | ${v1.headers.get("location")}`);
    const postPlain = await request("POST", `/api/payments/ccavenue/${route}`, { headers: { "content-type": "application/x-www-form-urlencoded" } });
    const postV1 = await request("POST", `/api/v1/payments/ccavenue/${route}`, { headers: { "content-type": "application/x-www-form-urlencoded" } });
    check(postPlain.status === 303 && postV1.status === 303 && postV1.headers.get("location") === postPlain.headers.get("location") && /\/payment\/result\?state=/.test(postV1.headers.get("location") ?? ""), `POST ccavenue/${route} with nothing: the same redirect to /payment/result on both prefixes`, `${postPlain.status}/${postV1.status} ${postV1.headers.get("location")}`);
  }
  {
    const plain = await request("POST", "/api/payments/ccavenue/notify", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    const v1 = await request("POST", "/api/v1/payments/ccavenue/notify", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    check(plain.status === v1.status && v1.text === plain.text && /^text\/plain/.test(v1.headers.get("content-type") ?? "") && v1.json === undefined, "POST ccavenue/notify: CCAvenue's plain-text acknowledgement, identical on both prefixes", `${plain.status}/${v1.status} ${v1.headers.get("content-type")} ${v1.text}`);
    const simPlain = await request("POST", "/api/payments/simulator", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    const simV1 = await request("POST", "/api/v1/payments/simulator", { headers: { "content-type": "application/x-www-form-urlencoded" } });
    check(simPlain.status === simV1.status && simV1.text === simPlain.text && !isEnvelope(simV1.json), "the local simulator answers the same page or JSON on both prefixes, never an envelope", `${simPlain.status}/${simV1.status} ${simV1.text.slice(0, 120)}`);
  }

  /* ── nothing that is not JSON is wrapped ────────────────────────────── */
  section("never wrapped: crawler files, provider callbacks, tracked links, OPTIONS, HEAD");
  r = await get("/api/og.php?path=/");
  check(r.status === 200 && /^text\/html/.test(r.headers.get("content-type") ?? "") && /<meta property="og:title"/.test(r.text) && !isEnvelope(r.json), "/api/og.php is the HTML preview", `${r.status} ${r.headers.get("content-type")}`);
  r = await get("/api/sitemap.php");
  check(r.status === 200 && /^application\/xml/.test(r.headers.get("content-type") ?? "") && r.text.startsWith("<?xml"), "/api/sitemap.php is XML", `${r.status} ${r.headers.get("content-type")} ${r.text.slice(0, 40)}`);
  r = await get("/api/robots.php");
  check(r.status === 200 && /^text\/plain/.test(r.headers.get("content-type") ?? "") && /User-agent/.test(r.text), "/api/robots.php is text", `${r.status} ${r.headers.get("content-type")}`);
  r = await get("/robots.txt");
  check(r.status === 200 && /User-agent/.test(r.text), "/robots.txt still routes to it", `${r.status}`);
  r = await get("/sitemap.xml");
  check(r.status === 200 && r.text.startsWith("<?xml"), "/sitemap.xml still routes to the sitemap", `${r.status}`);
  r = await get("/api/spa.php?path=/");
  check(/^text\/html/.test(r.headers.get("content-type") ?? "") && !isEnvelope(r.json), "/api/spa.php is the HTML shell (or its honest 404), never JSON", `${r.status} ${r.headers.get("content-type")}`);
  r = await get("/api/v1/og.php");
  check(r.status === 404 && r.json?.error?.code === "NOT_FOUND", "/api/v1/og.php is not a resource: NOT_FOUND, the crawler files live only at /api/*.php", r.text);
  {
    const plain = await get("/api/notify-webhook/whatsapp");
    const v1 = await get("/api/v1/notify-webhook/whatsapp");
    check(plain.status === v1.status && v1.text === plain.text && !isEnvelope(v1.json), "a notification provider's webhook answers its own body on both prefixes (pass-through, even when that body is JSON)", `${plain.status}/${v1.status} ${plain.text.slice(0, 80)} | ${v1.text.slice(0, 80)}`);
    const token = "c1234567.abcdefghijklmnop";
    const tPlain = await get(`/api/n/c/${token}`);
    const tV1 = await get(`/api/v1/n/c/${token}`);
    check(tPlain.status === tV1.status && tV1.text === tPlain.text && !isEnvelope(tV1.json) && (tV1.headers.get("location") ?? "") === (tPlain.headers.get("location") ?? ""), "a tracked link inside a notification answers the same redirect or page on both prefixes", `${tPlain.status}/${tV1.status} ${tV1.text.slice(0, 80)}`);
  }
  {
    const plain = await request("OPTIONS", "/api/deities");
    const v1 = await request("OPTIONS", "/api/v1/deities");
    check(plain.status === 204 && v1.status === 204 && v1.text === "" && v1.headers.get("access-control-allow-origin") === plain.headers.get("access-control-allow-origin") && v1.headers.get("access-control-allow-headers") === plain.headers.get("access-control-allow-headers"), "CORS preflight: 204 with the same Access-Control headers on both prefixes", `${plain.status}/${v1.status}`);
    // The route table is keyed by method (GET, POST), so HEAD on a table route
    // has always been a 404 from index.php; that must stay the same on v1.
    // live-streams handles HEAD itself, so there the envelope route answers 200.
    const headPlain = await request("HEAD", "/api/deities");
    const head = await request("HEAD", "/api/v1/deities");
    check(head.status === headPlain.status && head.text === "" && headPlain.text === "", "HEAD on a table route answers the same status on both prefixes, with no body", `${headPlain.status}/${head.status}`);
    const headLive = await request("HEAD", "/api/v1/live-streams/upcoming");
    check(headLive.status === 200 && headLive.text === "" && /^application\/json/.test(headLive.headers.get("content-type") ?? ""), "HEAD /api/v1/live-streams/upcoming: 200, JSON type, no body", `${headLive.status} ${headLive.text.length}`);
  }

  /* ── the unversioned API is what it was ─────────────────────────────── */
  section("the unversioned /api/* is unchanged, byte for byte");
  r = await get("/api/no-such-route");
  check(r.status === 404 && r.text === '{"error":"Not found"}', "404 body is exactly {\"error\":\"Not found\"}", r.text);
  r = await get("/api/registrations");
  check(r.status === 405 && r.text === '{"error":"Method not allowed"}', "405 body is exactly {\"error\":\"Method not allowed\"}", r.text);
  r = await post("/api/registrations", {});
  check(r.status === 422 && Object.keys(r.json ?? {}).join(",") === "error,fields" && r.text.startsWith('{"error":"Please correct the highlighted fields.","fields":{"'), "422 body is exactly {error, fields}", r.text.slice(0, 80));
  r = await get("/api/admin/live-streams");
  check(r.status === 401 && r.text === '{"error":"Sign in to the admin first","code":"unauthenticated"}', "the admin API's raw 401 is untouched", r.text);
  r = await post("/api/contact", {});
  check(r.status === 400 && r.text === '{"error":"Name, phone, and message are required"}', "the contact form's 400 is untouched", r.text);
  r = await get("/api/deities");
  check(r.status === 200 && r.text.startsWith("[") && r.headers.get("cache-control") === "public, max-age=300", "/api/deities is a bare list with its cache header", `${r.status} ${r.headers.get("cache-control")} ${r.text.slice(0, 40)}`);
  r = await get("/api/settings");
  check(r.status === 200 && r.text.startsWith("{") && !("success" in (r.json ?? {})) && "site" in (r.json ?? {}), "/api/settings is the bare object", r.text.slice(0, 60));
  for (const route of routes) {
    const plain = await get(`/api${route}${withQuery[route] ?? ""}`);
    if (!check(!isEnvelope(plain.json), `/api${route} carries no envelope key`, plain.text.slice(0, 80))) break;
  }

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-800));
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try {
    const gone = sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [`:10\\.93\\.${NET}\\.[0-9]+$`]);
    const left = sql("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket REGEXP ?", [`:10\\.93\\.${NET}\\.[0-9]+$`]).rows[0].n;
    check(Number(left) === 0, `cleanup removed this run's rate-limit buckets (${gone.affected})`, `${left} left`);
    const saved = sql("SELECT COUNT(*) AS n FROM contact_messages WHERE name LIKE ?", [`E2E-APIV1-${RUN}%`]).rows[0].n;
    check(Number(saved) === 0, "no contact message was saved by the validation probes", `${saved} saved`);
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}

console.log(`\napi-v1: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
