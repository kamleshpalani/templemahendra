#!/usr/bin/env node
/**
 * tests/admin-notifications.mjs — the admin notification campaigns and saved
 * audiences, end to end over HTTP and in a real browser.
 *
 *   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
 *     node tests/admin-notifications.mjs http://127.0.0.1:8003
 *
 * The server under test must run with
 *   NOTIFY_ALLOW_TEST_DRIVER=1 NOTIFY_EMAIL_DRIVER=test NOTIFY_APPROVAL_THRESHOLD=2
 * so that two devotees are "small" (approved automatically) and three need an
 * owner, and a test send never reaches a real mailbox.
 *
 * It proves: roles are enforced on the server (a viewer is refused every write
 * and the JSON endpoints; an editor composes, submits and sends small campaigns
 * but cannot approve; an owner cannot approve their own campaign while another
 * owner exists); the estimate equals notifyAudienceCount(); the preview answers
 * for every channel; send now plus a worker run scoped to the campaign notifies
 * exactly its audience; a scheduled campaign that is cancelled cancels its
 * queued deliveries; duplicate, emergency send (reason required), test send and
 * CSRF refusals behave; saved audiences are saved, audited, locked while an
 * approved campaign uses them and deleted afterwards; a validation error keeps
 * the form without JavaScript; and list, composer and campaign pages have no
 * serious or critical axe violations and no horizontal overflow at 390 and
 * 1440 px.
 *
 * Creates admin accounts e2e_nc_<run>_*, devotees e2e-nc-<run>-*@example.test,
 * campaigns and audiences named E2E-NC-<run>…, and removes all of them (with
 * their notifications, audit rows and worker-run rows) at the end. Every request
 * carries X-Forwarded-For 10.33.7.7.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PHP_BIN = process.env.PHP_BIN || "php";
const BASE = (process.argv[2] || "http://127.0.0.1:8003").replace(/\/$/, "");
const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const RUN = Date.now().toString(36);
const P = `e2e-nc-${RUN}-`;
const NAME = `E2E-NC-${RUN}`;
const TAG_SMALL = `e2e-nc-${RUN}-s`;
const TAG_LARGE = `e2e-nc-${RUN}-l`;
const XFF = "10.33.7.7";
const PASSWORD = "Kolam99Deep!nc";
const USERS = { editor: `e2e_nc_${RUN}_ed`, owner: `e2e_nc_${RUN}_ow`, viewer: `e2e_nc_${RUN}_vw` };

let passed = 0;
const failures = [];
const runIds = [];
function check(ok, label, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (actual, expected, label) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const section = (title) => console.log(`\n── ${title}`);

/* ── PHP ───────────────────────────────────────────────────────────────── */

const phpEnv = {
  ...process.env,
  NOTIFY_ALLOW_TEST_DRIVER: "1",
  NOTIFY_EMAIL_DRIVER: "test",
  NOTIFY_APPROVAL_THRESHOLD: "2",
};
/** JSON for a command line: non-ASCII escaped, because Windows argv is not UTF-8 all the way down. */
const arg = (obj) => JSON.stringify(obj).replace(/[-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
function php(args, env = {}) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, {
    cwd: ROOT, env: { ...phpEnv, ...env }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}
function phpJson(args, env) {
  const r = php(args, env);
  const line = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`php ${args.join(" ").slice(0, 80)} printed no JSON (exit ${r.status}): ${r.stdout.slice(-400)} ${r.stderr.slice(-400)}`);
  }
}
const fixtures = (cmd, obj = {}) => phpJson(["tests/support/notify_fixtures.php", cmd, arg(obj)]);
function sql(query, params = []) {
  const r = fixtures("sql", { query, params });
  if (r.error) throw new Error(`${r.error} in ${query}`);
  return r.rows;
}
const one = (query, params) => sql(query, params)[0] ?? null;
const audienceCount = (rules) =>
  phpJson(["-r", 'require "backend/includes/notify.php"; echo json_encode(["count" => notifyAudienceCount(json_decode(getenv("NC_RULES"), true))]);'], { NC_RULES: JSON.stringify(rules) }).count;

/* ── HTTP ──────────────────────────────────────────────────────────────── */

const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const flashOf = (html) => {
  const m = /<p class="alert alert--(\w+)" role="\w+">([\s\S]*?)<\/p>/.exec(html);
  return m ? { tone: m[1], text: decode(m[2]) } : null;
};

function session(label) {
  let cookie = "";
  const grab = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^(PHPSESSID=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
  };
  const s = {
    label,
    csrf: "",
    async get(path, headers = {}) {
      const res = await fetch(BASE + path, { headers: { cookie, "X-Forwarded-For": XFF, ...headers }, redirect: "manual" });
      grab(res);
      return res;
    },
    async post(path, pairs, headers = {}) {
      const body = new URLSearchParams();
      for (const [k, v] of Array.isArray(pairs) ? pairs : Object.entries(pairs)) body.append(k, String(v));
      const res = await fetch(BASE + path, {
        method: "POST", body, redirect: "manual",
        headers: { cookie, "X-Forwarded-For": XFF, "content-type": "application/x-www-form-urlencoded", ...headers },
      });
      grab(res);
      return res;
    },
    /** POST, follow the 303 once, and return [status, location, flash on the page it lands on]. */
    async act(pairs, path = "/admin/notifications.php") {
      const res = await s.post(path, pairs);
      const location = res.headers.get("location") || "";
      if (res.status !== 303) return { status: res.status, location, flash: flashOf(await res.text()), html: "" };
      const page = await s.get(location.startsWith("/") ? location : "/admin/notifications.php");
      const html = await page.text();
      return { status: res.status, location, flash: flashOf(html), html };
    },
  };
  return s;
}

async function login(s, username, password) {
  const page = await s.get("/admin/login.php");
  const res = await s.post("/admin/login.php", { _csrf: csrfOf(await page.text()), username, password });
  // The token is per session; take it from the first page that prints a form
  // for this role (the built-in account's profile page has none).
  for (const path of ["/admin/profile.php", "/admin/notifications.php?new=1"]) {
    s.csrf = csrfOf(await (await s.get(path)).text()) || "";
    if (s.csrf) break;
  }
  return res.status;
}

/** Composer fields for a campaign whose audience is one tag (or a saved segment). */
function campaignForm(s, { name, action = "save", channels = ["inapp"], priority = "normal", category = "announcement", tag, segmentId, id }) {
  const pairs = [
    ["_csrf", s.csrf], ["action", action], ["name", name], ["category", category], ["priority", priority],
    ["template_key", ""], ["template_vars", ""],
    ["translations[ta][title]", "சோதனை அறிவிப்பு"], ["translations[ta][body]", "இது ஒரு சோதனைச் செய்தி, {{devoteeName}}."], ["translations[ta][cta_label]", ""],
    ["translations[en][title]", "Test notice"], ["translations[en][body]", "This is a test message for {{devoteeName}}."], ["translations[en][cta_label]", "See events"],
    ["cta_url", "/events"], ["image_url", ""],
    ["schedule_mode", "manual"], ["scheduled_local", ""], ["schedule_tz", "temple"], ["recurrence", "none"], ["recur_until", ""],
  ];
  if (id) pairs.push(["id", id]);
  for (const c of channels) pairs.push(["channels[]", c]);
  if (segmentId) pairs.push(["audience_source", "segment"], ["segment_id", segmentId]);
  else pairs.push(["audience_source", "rules"], ["match", "all"], ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", tag]);
  return pairs;
}
const idFrom = (location) => Number(/[?&](?:edit|view)=(\d+)/.exec(location)?.[1] || 0);
const campaign = (id) => one("SELECT * FROM notification_campaigns WHERE id = ?", [id]);
/** A temple-time wall clock ms from now, as a datetime-local value. */
const templeWall = (ms) => new Date(Date.now() + ms).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata", hour12: false }).slice(0, 16).replace(" ", "T");
function worker(id, extra = []) {
  const r = phpJson(["backend/bin/notify_worker.php", `--campaign-id=${id}`, "--max-seconds=20", "--json", ...extra]);
  if (r.run_id) runIds.push(Number(r.run_id));
  return r;
}

/* ── Run ───────────────────────────────────────────────────────────────── */

const ids = { small: [], large: [] };
let browser = null;

try {
  section("setup");
  const probe = await fetch(BASE + "/admin/login.php", { headers: { "X-Forwarded-For": XFF } }).catch(() => null);
  if (!probe || probe.status !== 200) throw new Error(`no admin at ${BASE} (start serve.sh 8003 with the environment in this file's header)`);

  const hash = php(["-r", 'echo password_hash(getenv("NC_PW"), PASSWORD_BCRYPT);'], { NC_PW: PASSWORD }).stdout.trim();
  check(hash.startsWith("$2y$"), "bcrypt hash made through php");
  for (const [role, username] of [["editor", USERS.editor], ["owner", USERS.owner], ["viewer", USERS.viewer]]) {
    sql("INSERT INTO admin_users (username, display_name, email, pass_hash, role, is_active, must_change) VALUES (?, ?, ?, ?, ?, 1, 0)",
      [username, `E2E NC ${role}`, `${P}${role}@example.test`, hash, role]);
  }
  for (let i = 0; i < 2; i++) ids.small.push(fixtures("create-devotee", { email: `${P}s${i}@example.test`, name: `E2E Small ${i}`, verified: true, city: "Madurai" }).id);
  for (let i = 0; i < 3; i++) ids.large.push(fixtures("create-devotee", { email: `${P}l${i}@example.test`, name: `E2E Large ${i}`, verified: true, city: "Chennai" }).id);
  for (const id of ids.small) sql("INSERT INTO devotee_tags (devotee_id, tag, created_by) VALUES (?, ?, 'e2e')", [id, TAG_SMALL]);
  for (const id of ids.large) sql("INSERT INTO devotee_tags (devotee_id, tag, created_by) VALUES (?, ?, 'e2e')", [id, TAG_LARGE]);
  check(ids.small.length === 2 && ids.large.length === 3, "5 tagged fixture devotees");

  const admin = session("admin");
  const editor = session("editor");
  const owner = session("owner");
  const viewer = session("viewer");
  eq(await login(admin, "admin", "Admin@Test123"), 302, "environment owner signs in");
  eq(await login(editor, USERS.editor, PASSWORD), 302, "editor signs in");
  eq(await login(owner, USERS.owner, PASSWORD), 302, "second owner signs in");
  eq(await login(viewer, USERS.viewer, PASSWORD), 302, "viewer signs in");
  check(Boolean(editor.csrf && owner.csrf && viewer.csrf && admin.csrf), "every session has a CSRF token");

  section("navigation and pages");
  let html = await (await editor.get("/admin/notifications.php")).text();
  check(/Communication/.test(html) && /notification_segments\.php/.test(html) && /notification_analytics\.php/.test(html), "sidebar has the Communication group");
  check(/notify-campaigns\.css/.test(html) && /notify-content\.css/.test(html), "both notification stylesheets are linked");
  html = await (await editor.get("/admin/notifications.php?new=1")).text();
  check(/Recording only - no provider configured/.test(html), "channel card says WhatsApp/SMS/push only record (log driver)");
  check(/Test driver - development only/.test(html), "channel card names the email test driver");
  check(/id="nc-audience-fields"/.test(html) && /"booking_status"/.test(html), "rules builder field table is printed as JSON");

  section("roles on the server");
  let res = await viewer.get("/admin/notifications.php");
  eq(res.status, 200, "viewer can read the list");
  res = await viewer.get("/admin/notifications.php?new=1");
  eq(res.status, 403, "viewer cannot open the composer");
  res = await viewer.post("/admin/notifications.php", campaignForm(viewer, { name: `${NAME}-viewer`, tag: TAG_SMALL }));
  eq(res.status, 403, "viewer POST save is refused with 403");
  res = await viewer.post("/admin/notifications.php", [["_csrf", viewer.csrf], ["action", "estimate"], ["audience_source", "all"]]);
  let json = await res.json().catch(() => null);
  check(res.status === 403 && json?.code === "forbidden", "viewer POST estimate answers JSON 403", `${res.status} ${JSON.stringify(json)}`);
  res = await viewer.get(`/admin/notifications.php?devotee_search=${encodeURIComponent(P)}`);
  json = await res.json().catch(() => null);
  check(res.status === 403 && json?.code === "forbidden", "viewer devotee search answers JSON 403");
  res = await viewer.post("/admin/notification_segments.php", [["_csrf", viewer.csrf], ["action", "save"], ["name", `${NAME} viewer seg`], ["audience_source", "all"]]);
  eq(res.status, 403, "viewer cannot save an audience");
  check(!one("SELECT id FROM notification_campaigns WHERE name = ?", [`${NAME}-viewer`]), "nothing was created by the viewer");
  res = await fetch(BASE + "/admin/notifications.php", { method: "POST", headers: { "X-Forwarded-For": XFF, "content-type": "application/x-www-form-urlencoded" }, body: "action=estimate", redirect: "manual" });
  json = await res.json().catch(() => null);
  check(res.status === 401 && json?.code === "unauthenticated", "signed-out estimate answers JSON 401");

  section("estimate");
  const tagRules = (tag) => ({ mode: "rules", match: "all", rules: [{ field: "tag", op: "in", value: [tag] }] });
  const estimatePairs = (s, tag, extra = []) => [["_csrf", s.csrf], ["action", "estimate"], ["audience_source", "rules"], ["match", "all"],
    ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", tag], ["priority", "normal"], ["category", "announcement"], ["channels[]", "inapp"], ...extra];
  res = await editor.post("/admin/notifications.php", estimatePairs(editor, TAG_SMALL));
  json = await res.json();
  eq(json.count, audienceCount(tagRules(TAG_SMALL)), "estimate equals notifyAudienceCount (small)");
  eq(json.count, 2, "small audience is 2 devotees");
  eq(json.approvalReason, null, "small in-app audience needs no approval");
  res = await editor.post("/admin/notifications.php", estimatePairs(editor, TAG_LARGE));
  json = await res.json();
  eq(json.count, audienceCount(tagRules(TAG_LARGE)), "estimate equals notifyAudienceCount (large)");
  eq(json.approvalReason, "Reaches 3 devotees", "large audience names its approval reason");
  const allCount = (await (await editor.post("/admin/notifications.php", [["_csrf", editor.csrf], ["action", "estimate"], ["audience_source", "all"]])).json()).count;
  eq(allCount, audienceCount({ mode: "all_devotees" }), "estimate equals notifyAudienceCount (all devotees)");
  res = await editor.post("/admin/notifications.php", [["_csrf", "wrong"], ["action", "estimate"], ["audience_source", "all"]]);
  json = await res.json().catch(() => null);
  check(res.status === 419 && json?.code === "csrf", "estimate with a bad CSRF token answers 419");
  res = await editor.post("/admin/notifications.php", [["_csrf", editor.csrf], ["action", "estimate"], ["audience_source", "rules"], ["match", "all"],
    ["rules[0][field]", "country"], ["rules[0][op]", "in"], ["rules[0][value]", "India"]]);
  json = await res.json().catch(() => null);
  check(res.status === 422 && /two-letter country codes/.test(json?.fields?.audience || ""), "an invalid rule answers 422 with the audience field", JSON.stringify(json));
  res = await editor.post("/admin/notifications.php", [["_csrf", editor.csrf], ["action", "estimate"], ["audience_source", "segment"], ["segment_id", ""]]);
  json = await res.json().catch(() => null);
  check(res.status === 422 && Boolean(json?.fields?.segment_id), "a saved audience without a choice answers 422 on segment_id");

  section("preview");
  const previewPairs = (s, channel, lang) => [...campaignForm(s, { name: `${NAME}-preview`, action: "preview", tag: TAG_SMALL, channels: ["inapp", "email", "whatsapp", "sms", "push"] }),
    ["preview_channel", channel], ["preview_lang", lang]];
  for (const channel of ["inapp", "email", "whatsapp", "sms", "push"]) {
    res = await editor.post("/admin/notifications.php", previewPairs(editor, channel, "en"));
    json = await res.json().catch(() => null);
    const keys = ["title", "body", "html", "cta_label", "cta_url", "provider_template", "params", "sms", "missing"];
    check(res.status === 200 && keys.every((k) => k in (json || {})), `preview JSON for ${channel} has every key`, `${res.status} ${JSON.stringify(json).slice(0, 160)}`);
    check((json?.title || "").includes("Test notice") || (json?.body || "").includes("test message"), `preview for ${channel} carries the English words`);
    if (channel === "email") check(typeof json?.html === "string" && json.html.includes("Test notice"), "email preview has the branded HTML");
    if (channel === "sms") check(json?.sms?.segments >= 1 && ["GSM-7", "UCS-2"].includes(json?.sms?.encoding), "sms preview counts characters and parts");
    if (channel !== "email") check(json?.html === null, `${channel} preview has no HTML`);
  }
  res = await editor.post("/admin/notifications.php", previewPairs(editor, "inapp", "ta"));
  json = await res.json();
  check(json.title.includes("சோதனை"), "Tamil preview uses the Tamil translation");
  res = await editor.post("/admin/notifications.php", previewPairs(editor, "fax", "en"));
  json = await res.json().catch(() => null);
  check(res.status === 422 && Boolean(json?.fields?.preview_channel), "an unknown preview channel answers 422");

  section("devotee picker");
  res = await editor.get(`/admin/notifications.php?devotee_search=${encodeURIComponent(P)}`);
  json = await res.json();
  check(res.status === 200 && json.items.length === 5 && json.items.length <= 20, "search finds the five fixture devotees", JSON.stringify(json).slice(0, 200));
  eq(Object.keys(json.items[0] || {}).sort(), ["city", "email", "id", "name"], "each result carries only id, name, email and city");
  json = await (await editor.get("/admin/notifications.php?devotee_search=a")).json();
  eq(json.items, [], "a one-letter search returns nothing");

  section("validation without JavaScript");
  res = await editor.post("/admin/notifications.php", [
    ["_csrf", editor.csrf], ["action", "save"], ["name", ""], ["category", "announcement"], ["priority", "normal"], ["channels[]", "inapp"],
    ["translations[ta][title]", ""], ["translations[ta][body]", ""], ["translations[en][title]", "Only a title"], ["translations[en][body]", ""],
    ["cta_url", "javascript:alert(1)"], ["audience_source", "rules"], ["match", "all"],
    ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", TAG_SMALL], ["schedule_mode", "manual"],
  ]);
  html = await res.text();
  check(res.status === 200 && /Nothing was saved/.test(html), "server re-renders the composer with an error summary");
  check(/id="nc-name"[^>]*aria-invalid="true"/.test(html) && /Give it a name/.test(html), "the name field is marked invalid with its message");
  check(/Use a site path such as \/sevas/.test(html), "the unsafe link is refused with a reason");
  check(/Add the message\./.test(html), "a title without a message is refused per language");
  check(html.includes('value="javascript:alert(1)"') && html.includes(`value="${TAG_SMALL}"`) && html.includes('value="Only a title"'), "typed values are kept");
  check(!one("SELECT id FROM notification_campaigns WHERE name = ''"), "nothing was saved");
  res = await editor.post("/admin/notifications.php", [...campaignForm(editor, { name: `${NAME}-addrule`, action: "add_rule", tag: TAG_SMALL })]);
  html = await res.text();
  check(/name="rules\[1\]\[field\]"/.test(html) && html.includes(`value="${TAG_SMALL}"`), "Add rule without JavaScript adds a row and keeps the first");
  res = await editor.post("/admin/notifications.php", [...campaignForm(editor, { name: `${NAME}-count`, action: "estimate_form", tag: TAG_SMALL })]);
  html = await res.text();
  check(/data-nc-estimate-count>2</.test(html), "Count recipients without JavaScript shows the count");
  res = await editor.post("/admin/notifications.php", [...campaignForm(editor, { name: `${NAME}-cat`, category: "booking", tag: TAG_SMALL })]);
  html = await res.text();
  check(/which devotees cannot switch off/.test(html), "a transactional category is refused for a campaign");

  section("small campaign: editor submits, it auto-approves, send now, worker");
  let r = await editor.act(campaignForm(editor, { name: `${NAME}-small`, tag: TAG_SMALL }));
  const smallId = idFrom(r.location);
  check(r.status === 303 && smallId > 0 && /\?edit=/.test(r.location), "save draft redirects back to the composer", r.location);
  check(/Draft saved/.test(r.flash?.text || ""), "save flashes a confirmation");
  let c = campaign(smallId);
  check(c?.status === "draft" && c?.created_by === USERS.editor, "draft stored as the editor's");
  eq(Number(one("SELECT COUNT(*) AS n FROM notification_campaign_translations WHERE campaign_id = ?", [smallId]).n), 2, "Tamil and English translations stored");
  r = await editor.act([["_csrf", editor.csrf], ["action", "submit"], ["id", smallId]]);
  c = campaign(smallId);
  check(c.status === "approved" && c.approved_by === "system", "submit auto-approves a 2-devotee in-app campaign", JSON.stringify(c && { s: c.status, a: c.approved_by }));
  check(/Approved automatically/.test(r.flash?.text || ""), "the page says it was approved automatically");
  const auditApproved = one("SELECT detail FROM notification_audit WHERE campaign_id = ? AND action = 'approved' AND actor = 'system'", [smallId]);
  check(Boolean(auditApproved) && /below approval threshold/.test(auditApproved.detail), "automatic approval is audited by system");
  r = await editor.act([["_csrf", editor.csrf], ["action", "send_now"], ["id", smallId]]);
  check(campaign(smallId).status === "sending", "editor can send an approved campaign now");
  worker(smallId);
  if (campaign(smallId).status === "sending") worker(smallId);
  const got = sql("SELECT devotee_id FROM notifications WHERE campaign_id = ? ORDER BY devotee_id", [smallId]).map((x) => Number(x.devotee_id));
  eq(got, [...ids.small].sort((a, b) => a - b), "worker notified exactly the campaign's audience");
  eq(sql("SELECT status FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND d.channel = 'inapp'", [smallId]).map((x) => x.status), ["sent", "sent"], "in-app deliveries are visible");
  eq(campaign(smallId).status, "completed", "campaign completes once nothing waits");
  html = await (await editor.get(`/admin/notifications.php?view=${smallId}`)).text();
  check(/Devotees reached/.test(html) && /History/.test(html) && /Sending started/.test(html), "campaign page shows delivery figures and the audit trail");
  html = await (await editor.get(`/admin/notifications.php?q=${encodeURIComponent(NAME + "-small")}`)).text();
  check(html.includes(`${NAME}-small`) && /2 devotees/.test(html) && /2 sent/.test(html), "list row shows recipients and sent from the batched stats");

  section("large campaign: review, approvals, schedule, cancel");
  r = await editor.act(campaignForm(editor, { name: `${NAME}-large`, action: "save_submit", tag: TAG_LARGE, channels: ["inapp", "email"] }));
  const largeId = idFrom(r.location);
  c = campaign(largeId);
  check(largeId > 0 && c.status === "review" && c.approval_reason === "Reaches 3 devotees", "3 devotees go to review with the threshold at 2", JSON.stringify(c && { s: c.status, r: c.approval_reason }));
  check(/Waiting for an owner/.test(r.html) && new RegExp(USERS.editor).test(r.html), "view shows the approval banner naming the author");
  r = await editor.act([["_csrf", editor.csrf], ["action", "approve"], ["id", largeId]]);
  check(campaign(largeId).status === "review" && /Only an owner/.test(r.flash?.text || ""), "the editor cannot approve", r.flash?.text);

  r = await admin.act(campaignForm(admin, { name: `${NAME}-admin`, action: "save_submit", priority: "urgent", tag: TAG_SMALL }));
  const adminId = idFrom(r.location);
  check(campaign(adminId)?.status === "review", "an urgent campaign by the environment owner goes to review");
  check(/another owner needs to approve it/.test(r.html), "its page tells its author another owner must approve");
  r = await admin.act([["_csrf", admin.csrf], ["action", "approve"], ["id", adminId]]);
  check(campaign(adminId).status === "review" && /You wrote this notification/.test(r.flash?.text || ""), "the owner cannot approve their own campaign", r.flash?.text);
  r = await admin.act([["_csrf", admin.csrf], ["action", "cancel"], ["id", adminId]]);
  eq(campaign(adminId).status, "cancelled", "the owner cancels it");

  r = await owner.act([["_csrf", owner.csrf], ["action", "approve"], ["id", largeId]]);
  c = campaign(largeId);
  check(c.status === "approved" && c.approved_by === USERS.owner, "the second owner approves", JSON.stringify({ s: c.status, a: c.approved_by }));
  r = await editor.act([["_csrf", editor.csrf], ["action", "schedule"], ["id", largeId], ["scheduled_local", templeWall(-3600e3)], ["schedule_tz", "temple"]]);
  check(campaign(largeId).status === "approved" && /future/.test(r.flash?.text || ""), "a time in the past is refused", r.flash?.text);
  r = await editor.act([["_csrf", editor.csrf], ["action", "schedule"], ["id", largeId], ["scheduled_local", templeWall(2 * 86400e3)], ["schedule_tz", "temple"]]);
  c = campaign(largeId);
  check(c.status === "scheduled" && Boolean(c.scheduled_at) && /Scheduled for/.test(r.flash?.text || ""), "editor schedules it two days ahead", r.flash?.text);
  check(/IST/.test(r.html) && /Temple time/.test(r.html), "the schedule is shown in temple time with a time-zone note");
  // Move the worker's clock past the send time, expand without sending, so email deliveries wait in the queue.
  const after = new Date(new Date(c.scheduled_at.replace(" ", "T") + "Z").getTime() + 60e3).toISOString().slice(0, 19).replace("T", " ");
  worker(largeId, [`--now=${after}`, "--channels=none"]);
  const queued = Number(one("SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND d.channel = 'email' AND d.status = 'queued'", [largeId]).n);
  eq(queued, 3, "expansion left 3 email deliveries queued");
  r = await editor.act([["_csrf", editor.csrf], ["action", "cancel"], ["id", largeId]]);
  check(campaign(largeId).status === "sending" && /Only an owner can cancel/.test(r.flash?.text || ""), "the editor cannot cancel someone else's sending campaign", r.flash?.text);
  r = await owner.act([["_csrf", owner.csrf], ["action", "cancel"], ["id", largeId]]);
  eq(campaign(largeId).status, "cancelled", "the owner cancels it");
  const byStatus = Object.fromEntries(sql("SELECT d.status, COUNT(*) AS n FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.campaign_id = ? AND d.channel = 'email' GROUP BY d.status", [largeId]).map((x) => [x.status, Number(x.n)]));
  eq(byStatus, { cancelled: 3 }, "its queued deliveries were cancelled");
  check(/3 waiting messages/.test(r.flash?.text || ""), "the flash says how many were cancelled");

  section("test send");
  r = await editor.act([["_csrf", editor.csrf], ["action", "test_send"], ["id", largeId], ["test_email", `${P}me@example.test`], ["test_phone", ""], ["test_lang", "en"]]);
  check(/Test sent/.test(r.flash?.text || ""), "test send reports what happened", r.flash?.text);
  const testRow = one("SELECT n.id, n.title, d.status FROM notifications n JOIN notification_deliveries d ON d.notification_id = n.id AND d.channel = 'email' WHERE n.dedupe_key LIKE ? ORDER BY n.id DESC LIMIT 1", [`test:${largeId}:%`]);
  check(testRow?.status === "sent" && /^\[TEST\] /.test(testRow?.title || ""), "the test email was sent with [TEST] in the title", JSON.stringify(testRow));
  check(Boolean(one("SELECT id FROM notification_audit WHERE campaign_id = ? AND action = 'test_sent'", [largeId])), "test send is audited");
  html = await (await editor.get(`/admin/notifications.php?view=${largeId}`)).text();
  check(html.includes(`value="${P}editor@example.test"`), "test-send form defaults to the signed-in admin's email");

  section("duplicate, emergency send, CSRF");
  r = await editor.act([["_csrf", editor.csrf], ["action", "duplicate"], ["id", smallId]]);
  const copyId = idFrom(r.location);
  c = campaign(copyId);
  check(/\?edit=/.test(r.location) && c?.status === "draft" && c?.name === `${NAME}-small (copy)`, "duplicate opens a new draft named (copy)", r.location);
  eq(Number(one("SELECT COUNT(*) AS n FROM notification_campaign_translations WHERE campaign_id = ?", [copyId]).n), 2, "the copy has both translations");

  r = await owner.act(campaignForm(owner, { name: `${NAME}-emergency`, priority: "emergency", category: "emergency", tag: TAG_SMALL }));
  const emId = idFrom(r.location);
  r = await editor.act([["_csrf", editor.csrf], ["action", "emergency_send"], ["id", emId], ["reason", "Flooding"]]);
  check(campaign(emId).status === "draft" && /Only an owner/.test(r.flash?.text || ""), "the editor cannot emergency send");
  r = await owner.act([["_csrf", owner.csrf], ["action", "emergency_send"], ["id", emId], ["reason", ""]]);
  check(campaign(emId).status === "draft" && /Say why/.test(r.flash?.text || ""), "emergency send without a reason is refused", r.flash?.text);
  r = await owner.act([["_csrf", owner.csrf], ["action", "emergency_send"], ["id", emId], ["reason", "Temple closed: flooding on the approach road"]]);
  check(campaign(emId).status === "sending" && Boolean(one("SELECT id FROM notification_audit WHERE campaign_id = ? AND action = 'emergency_override'", [emId])), "with a reason it sends and is audited as an emergency override");
  r = await owner.act([["_csrf", owner.csrf], ["action", "cancel"], ["id", emId]]);
  eq(campaign(emId).status, "cancelled", "the emergency test campaign is stopped before any worker expands it");

  r = await editor.act([["_csrf", "forged"], ["action", "submit"], ["id", copyId]]);
  check(campaign(copyId).status === "draft" && /expired or the form was tampered/.test(r.flash?.text || ""), "a forged CSRF token changes nothing");

  section("saved audiences");
  r = await editor.act([["_csrf", editor.csrf], ["action", "save"], ["name", `${NAME} small audience`], ["description", "The two small fixtures"],
    ["audience_source", "rules"], ["match", "all"], ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", TAG_SMALL]], "/admin/notification_segments.php");
  const seg = one("SELECT id, rules FROM notification_segments WHERE name = ?", [`${NAME} small audience`]);
  check(r.status === 303 && Boolean(seg), "editor saves an audience");
  check(Boolean(seg) && JSON.parse(seg.rules).rules[0].value[0] === TAG_SMALL, "its rules are stored normalised");
  const segAudit = one("SELECT detail FROM notification_audit WHERE action = 'segment_saved' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.segment_id')) AS UNSIGNED) = ?", [Number(seg?.id)]);
  check(Boolean(segAudit), "saving an audience is audited as segment_saved");
  res = await editor.post("/admin/notification_segments.php", [["_csrf", editor.csrf], ["action", "save"], ["name", `${NAME} small audience`], ["audience_source", "all"]]);
  check(/already has that name/.test(await res.text()), "a duplicate audience name is refused");
  res = await editor.post("/admin/notification_segments.php", [["_csrf", editor.csrf], ["action", "estimate"], ["audience_source", "rules"], ["match", "all"], ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", TAG_SMALL]]);
  eq((await res.json()).count, 2, "audience estimate answers JSON");

  r = await editor.act(campaignForm(editor, { name: `${NAME}-segment`, action: "save_submit", segmentId: seg.id }));
  const segCampaignId = idFrom(r.location);
  check(campaign(segCampaignId)?.status === "approved", "a campaign using the saved audience auto-approves");
  r = await editor.act([["_csrf", editor.csrf], ["action", "schedule"], ["id", segCampaignId], ["scheduled_local", templeWall(3 * 86400e3)], ["schedule_tz", "recipient"]]);
  c = campaign(segCampaignId);
  check(c.status === "scheduled" && c.schedule_tz === "recipient", "scheduled in each devotee's own time");
  check(/in each devotee&#039;s own time zone|in each devotee's own time zone/.test(r.html), "the page explains recipient time zones");
  html = await (await editor.get(`/admin/notification_segments.php?q=${encodeURIComponent(NAME)}`)).text();
  check(html.includes(`${NAME} small audience`) && /1 notification\b/.test(html) && /locked/.test(html), "the list shows it is used by 1 notification and locked");
  r = await editor.act([["_csrf", editor.csrf], ["action", "delete"], ["id", seg.id]], "/admin/notification_segments.php");
  check(Boolean(one("SELECT id FROM notification_segments WHERE id = ?", [seg.id])) && /cannot be deleted/.test(r.flash?.text || ""), "delete is refused while a scheduled campaign uses it", r.flash?.text);
  res = await editor.post("/admin/notification_segments.php", [["_csrf", editor.csrf], ["action", "save"], ["id", seg.id], ["name", `${NAME} small audience`],
    ["audience_source", "rules"], ["match", "all"], ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", TAG_LARGE]]);
  check(/rules cannot change while/.test(await res.text()), "its rules cannot change while locked");
  r = await editor.act([["_csrf", editor.csrf], ["action", "save"], ["id", seg.id], ["name", `${NAME} small audience renamed`],
    ["audience_source", "rules"], ["match", "all"], ["rules[0][field]", "tag"], ["rules[0][op]", "in"], ["rules[0][value]", TAG_SMALL]], "/admin/notification_segments.php");
  check(r.status === 303 && Boolean(one("SELECT id FROM notification_segments WHERE name = ?", [`${NAME} small audience renamed`])), "renaming a locked audience is allowed");
  await owner.act([["_csrf", owner.csrf], ["action", "cancel"], ["id", segCampaignId]]);
  eq(campaign(segCampaignId).status, "cancelled", "the owner cancels the campaign using it");
  res = await viewer.post("/admin/notification_segments.php", [["_csrf", viewer.csrf], ["action", "delete"], ["id", seg.id]]);
  eq(res.status, 403, "a viewer cannot delete an audience");
  r = await editor.act([["_csrf", editor.csrf], ["action", "delete"], ["id", seg.id]], "/admin/notification_segments.php");
  check(!one("SELECT id FROM notification_segments WHERE id = ?", [seg.id]) && /Deleted/.test(r.flash?.text || ""), "once nothing active uses it, it is deleted");
  check(Boolean(one("SELECT id FROM notification_audit WHERE action = 'segment_saved' AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.deleted')) = 'true' AND CAST(JSON_UNQUOTE(JSON_EXTRACT(detail, '$.segment_id')) AS UNSIGNED) = ?", [Number(seg.id)])), "deletion is audited");

  section("browser: axe, overflow, behaviour");
  browser = await chromium.launch();
  const axe = async (page) => {
    await page.addScriptTag({ content: axeSource });
    return page.evaluate(async () => {
      const out = await window.axe.run(document, { iframes: false, runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } });
      return out.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
    });
  };
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  async function uiContext(width, { js = true } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, javaScriptEnabled: js, extraHTTPHeaders: { "X-Forwarded-For": XFF } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + "/admin/login.php");
    await page.fill("#username", "admin");
    await page.fill("#password", "Admin@Test123");
    // Enter submits the form: without JavaScript the login button's entrance
    // animation never reports "stable", so a click would wait forever.
    await Promise.all([page.waitForURL(/\/admin\/(?!login)/), page.press("#password", "Enter")]);
    return { ctx, page, errors };
  }
  const pages = [
    ["list", "/admin/notifications.php"],
    ["composer", "/admin/notifications.php?new=1"],
    ["campaign", `/admin/notifications.php?view=${largeId}`],
    ["audiences", "/admin/notification_segments.php"],
  ];
  for (const width of [390, 1440]) {
    const { ctx, page, errors } = await uiContext(width);
    for (const [label, path] of pages) {
      await page.goto(BASE + path, { waitUntil: "load" });
      await page.waitForTimeout(700);
      check(!(await overflow(page)), `${label} @${width}: no horizontal overflow`);
      const v = await axe(page);
      check(v.length === 0, `${label} @${width}: no serious or critical axe violations`, v.slice(0, 5).join("\n      "));
    }
    check(errors.length === 0, `@${width}: no script errors`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }

  {
    const { ctx, page, errors } = await uiContext(1440);
    await page.goto(BASE + "/admin/notifications.php?new=1", { waitUntil: "load" });
    await page.click("#nc-lang-tab-en");
    check((await page.getAttribute("#nc-lang-tab-en", "aria-selected")) === "true", "the English language tab opens");
    await page.fill("#nc-lang-en-title", "Browser preview title");
    await page.fill("#nc-lang-en-body", "Browser preview body");
    await page.selectOption("#nc-preview-lang", "en").catch(() => {});
    await page.waitForFunction(() => document.querySelector("#nc-preview-lang option[value=en]"));
    await page.selectOption("#nc-preview-lang", "en");
    await page.waitForFunction(() => (document.querySelector("[data-nc-preview-panel]")?.textContent || "").includes("Browser preview title"), null, { timeout: 8000 }).catch(() => {});
    check((await page.textContent("[data-nc-preview-panel]")).includes("Browser preview title"), "live preview shows the typed English title");
    await page.check("#nc-ch-sms");
    await page.waitForSelector("#nc-pv-tab-sms");
    await page.focus("#nc-pv-tab-inapp");
    await page.keyboard.press("ArrowRight");
    const focused = await page.evaluate(() => document.activeElement?.id);
    check(focused === "nc-pv-tab-sms" && (await page.getAttribute("#nc-pv-tab-sms", "aria-selected")) === "true", "preview tabs move and select with the arrow keys", focused);
    await page.waitForFunction(() => /SMS part/.test(document.querySelector("[data-nc-preview-panel]")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
    check(/SMS part/.test(await page.textContent("[data-nc-preview-panel]")), "SMS preview shows the part count");
    check(/As an SMS: about/.test(await page.textContent("#nc-lang-en-sms")), "the message field counts SMS characters and parts");
    check(await page.isHidden("#nc-lang-ta"), "language panels become tabs (Tamil hidden while English is open)");

    await page.selectOption("#nc-rule-0-field", "tag");
    await page.fill("#nc-rule-0-value", TAG_SMALL);
    await page.waitForFunction(() => document.querySelector("[data-nc-estimate-count]")?.textContent.trim() === "2", null, { timeout: 8000 }).catch(() => {});
    eq((await page.textContent("[data-nc-estimate-count]")).trim(), "2", "live estimate counts the rule's devotees");
    check(/approved automatically/.test(await page.textContent("[data-nc-approval-hint]")), "the estimate says approval will be automatic");
    await page.click("[data-nc-add-rule]");
    check(await page.isVisible("#nc-rule-1-field"), "Add rule adds a row in place");
    await page.selectOption("#nc-rule-1-field", "booking_status");
    check(await page.isVisible("#nc-rule-1-value-0"), "choosing a field builds its value control (checkboxes for booking status)");
    await page.click('[data-nc-remove-rule][aria-label="Remove rule 2"]');
    check(!(await page.$("#nc-rule-1-field")), "Remove rule removes the row");

    await page.check("#nc-src-selected");
    await page.fill("#nc-devotee-lookup", P);
    await page.waitForSelector("#nc-devotee-results [role=option]", { timeout: 8000 }).catch(() => {});
    check((await page.getAttribute("#nc-devotee-lookup", "aria-expanded")) === "true", "the devotee picker opens its list");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /1 chosen/.test(document.querySelector("[data-nc-selected-count]")?.textContent || ""), null, { timeout: 5000 }).catch(() => {});
    check(/1 chosen/.test(await page.textContent("[data-nc-selected-count]")), "keyboard choice adds a devotee");
    await page.waitForFunction(() => document.querySelector("[data-nc-estimate-count]")?.textContent.trim() === "1", null, { timeout: 8000 }).catch(() => {});
    eq((await page.textContent("[data-nc-estimate-count]")).trim(), "1", "the estimate follows the chosen devotees");
    check(errors.length === 0, "composer behaviour raised no script errors", errors.slice(0, 3).join(" | "));
    page.on("dialog", (d) => d.accept());
    await ctx.close();
  }

  {
    const { ctx, page } = await uiContext(390, { js: false });
    await page.goto(BASE + "/admin/notifications.php?new=1", { waitUntil: "load" });
    check(await page.isVisible("#nc-lang-ta-title") && await page.isVisible("#nc-lang-en-title"), "without JavaScript every language is visible");
    await page.fill("#nc-cta", "ftp://not-allowed");
    await page.fill("#nc-lang-en-title", "Kept title");
    // Keyboard activation, as for the login: without JavaScript Playwright never sees buttons as "stable".
    await page.focus('.nc-submitbar button[value="save"]');
    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.keyboard.press("Enter")]);
    check(/Nothing was saved/.test(await page.textContent("body")), "without JavaScript the server's error summary is shown");
    eq(await page.inputValue("#nc-cta"), "ftp://not-allowed", "without JavaScript the typed link is kept");
    eq(await page.inputValue("#nc-lang-en-title"), "Kept title", "without JavaScript the typed title is kept");
    check(await page.getAttribute("#nc-name", "aria-invalid") === "true", "without JavaScript the name is marked invalid");
    check(!(await overflow(page)), "composer with errors @390 without JavaScript: no horizontal overflow");
    await ctx.close();
  }
} catch (err) {
  failures.push(`crashed: ${err.message}`);
  console.log(`\n  FAIL crashed — ${err.stack || err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  section("cleanup");
  try {
    const campaignIds = sql("SELECT id FROM notification_campaigns WHERE name LIKE ?", [`${NAME}%`]).map((x) => Number(x.id));
    if (campaignIds.length) {
      const marks = campaignIds.map(() => "?").join(",");
      sql(`DELETE FROM notifications WHERE campaign_id IN (${marks}) OR (entity_type = 'campaign' AND entity_id IN (${marks}))`, [...campaignIds, ...campaignIds]);
      sql(`DELETE FROM notification_audit WHERE campaign_id IN (${marks})`, campaignIds);
      sql(`DELETE FROM notification_campaigns WHERE id IN (${marks})`, campaignIds);
    }
    sql("DELETE FROM notification_audit WHERE campaign_name LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(detail, '$.name')) LIKE ?", [`${NAME}%`, `${NAME}%`]);
    sql("DELETE FROM notification_segments WHERE name LIKE ?", [`${NAME}%`]);
    fixtures("cleanup", { email_prefix: P });
    const usernames = Object.values(USERS);
    sql(`DELETE FROM admin_activity WHERE actor IN (${usernames.map(() => "?").join(",")}) OR subject IN (${usernames.map(() => "?").join(",")})`, [...usernames, ...usernames]);
    sql(`DELETE FROM admin_users WHERE username IN (${usernames.map(() => "?").join(",")})`, usernames);
    if (runIds.length) sql(`DELETE FROM notification_worker_runs WHERE id IN (${runIds.map(() => "?").join(",")})`, runIds);
    const left = one(
      `SELECT (SELECT COUNT(*) FROM notification_campaigns WHERE name LIKE ?) AS campaigns,
              (SELECT COUNT(*) FROM notification_segments WHERE name LIKE ?) AS segments,
              (SELECT COUNT(*) FROM devotees WHERE email LIKE ?) AS devotees,
              (SELECT COUNT(*) FROM admin_users WHERE username IN (?, ?, ?)) AS users,
              (SELECT COUNT(*) FROM notifications WHERE to_email LIKE ?) AS guest_notifications`,
      [`${NAME}%`, `${NAME}%`, `${P}%`, ...usernames, `${P}%`],
    );
    check(Object.values(left).every((n) => Number(n) === 0), "no test rows left", JSON.stringify(left));
  } catch (err) {
    failures.push(`cleanup: ${err.message}`);
    console.log(`  FAIL cleanup — ${err.message}`);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(failures.length ? 1 : 0);
}
