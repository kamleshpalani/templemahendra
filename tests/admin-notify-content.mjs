// End-to-end tests for the notification content admin: Message Templates
// (wording, preview, reset, categories) and Delivery Analytics (KPIs, filters,
// retired channels, CSV, requeue, worker health).
//
//   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
//     node tests/admin-notify-content.mjs http://127.0.0.1:8025
//
// The server under test should run with the deterministic providers
// (NOTIFY_ALLOW_TEST_DRIVER=1 NOTIFY_EMAIL_DRIVER=test NOTIFY_WHATSAPP_DRIVER=test
// NOTIFY_SMS_DRIVER=test); the PHP helpers this suite runs get the same settings.
//
// Real PHP server, real MySQL. Family registrations, notifications and
// deliveries are seeded through tests/support/notify_fixtures.php and then given
// exact statuses with SQL, so every KPI can be checked against a number
// computed here independently. Historic in-app and push rows (channels retired
// with devotee sign-in, docs/registration/SPEC.md §6) are inserted directly,
// because the service rightly refuses to create them. Every request carries
// this suite's own X-Forwarded-For (10.81.0.150–199).
//
// Re-runnable: it removes its own rows before and after — registrations
// e2e-notify-content-…, template text, notification titles and campaigns
// E2E-NOTIFY-CONTENT…, admin accounts e2e_notify_content_…, and categories
// qa_notify_content_… (a category key allows only lowercase letters and
// underscores, so it cannot carry the usual prefix).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const base = (process.argv[2] || "http://127.0.0.1:8025").replace(/\/$/, "");
const PHP_BIN = process.env.PHP_BIN || "php";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = Date.now().toString(36);
const LETTERS = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const XFF = `10.81.0.${150 + Math.floor(Math.random() * 50)}`;
const MARK = `E2E-NOTIFY-CONTENT ${RUN}`;
const EMAIL = (tag) => `e2e-notify-content-${RUN}-${tag}@example.test`;
const ADMIN_PREFIX = "e2e_notify_content_";
const CAT_PREFIX = "qa_notify_content_";
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace)/;
const CONSENT_REASONS = ["no consent", "unsubscribed"];
const STOP_EN = /\nTo stop temple updates: \S+\/api\/n\/u\/u0\.previewonlylink0$/;

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
  return cond;
};

/* ── PHP and SQL helpers ───────────────────────────────────────────────── */
// The helpers queue real notifications, so they use the same deterministic
// providers as the server: a provider that is not configured would skip a
// channel before consent is ever asked about.
const PHP_ENV = { ...process.env, NOTIFY_ALLOW_TEST_DRIVER: "1", NOTIFY_EMAIL_DRIVER: "test", NOTIFY_WHATSAPP_DRIVER: "test", NOTIFY_SMS_DRIVER: "test" };
function php(args) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: REPO, encoding: "utf8", env: PHP_ENV, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
function fixtures(cmd, obj) {
  const out = php(["tests/support/notify_fixtures.php", cmd, JSON.stringify(obj)]);
  const data = JSON.parse(out.trim().split("\n").pop());
  if (data.error) throw new Error(`fixtures ${cmd}: ${data.error}`);
  return data;
}
const sql = (query, params = []) => fixtures("sql", { query, params }).rows;
const phpJson = (code) => JSON.parse(php(["-r", `require 'backend/includes/notify.php'; ${code}`]).trim());
const utcNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");

/* ── HTTP session with this suite's X-Forwarded-For ─────────────────────── */
function jar() {
  let cookie = "";
  const grab = (res) => {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^(PHPSESSID=[^;]+)/.exec(c);
      if (m) cookie = m[1];
    }
  };
  const headers = (extra = {}) => ({ cookie, "X-Forwarded-For": XFF, ...extra });
  return {
    async get(path) {
      const r = await fetch(base + path, { headers: headers(), redirect: "manual" });
      grab(r);
      return r;
    },
    async post(path, body, accept = "text/html") {
      const r = await fetch(base + path, {
        method: "POST", redirect: "manual",
        headers: headers({ "content-type": "application/x-www-form-urlencoded", accept }),
        body: new URLSearchParams(body),
      });
      grab(r);
      return r;
    },
    get sessionId() { return cookie.replace(/^PHPSESSID=/, ""); },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
async function login(s, username, password) {
  const page = await s.get("/admin/login.php");
  const csrf = csrfOf(await page.text());
  const r = await s.post("/admin/login.php", { _csrf: csrf, username, password, next: "" });
  return r.status;
}
async function csrfFor(s, path = "/admin/notification_templates.php") {
  return csrfOf(await (await s.get(path)).text());
}
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// The page's own content, without the admin shell (whose menu links to committee accounts).
const content = (html) => {
  const start = html.indexOf('<nav class="tabs mb-4"');
  const end = html.indexOf('<script src="/admin/assets/notify-content.js"');
  return html.slice(start < 0 ? 0 : start, end < 0 ? html.length : end);
};

/* ── Cleanup ───────────────────────────────────────────────────────────── */
// No backslashes in SQL sent through the CLI: Git Bash drops them from arguments,
// which breaks the JSON. LEFT(col, n) = 'prefix' and LOCATE() are exact matches instead of escaped LIKEs.
function cleanup() {
  fixtures("cleanup", { email_prefix: "e2e-notify-content-" });
  fixtures("cleanup", { name_prefix: "E2E-NOTIFY-CONTENT" });
  sql("DELETE FROM notification_templates WHERE LEFT(body, 18) = 'E2E-NOTIFY-CONTENT'");
  sql("DELETE FROM notification_campaigns WHERE LEFT(name, 19) = 'E2E-NOTIFY-CONTENT-'");
  sql("DELETE FROM notification_categories WHERE LEFT(`key`, 18) = ?", [CAT_PREFIX]);
  sql(`DELETE FROM notification_audit
        WHERE (action IN ('template_saved','category_saved') AND (LOCATE('E2E-NOTIFY-CONTENT', detail) > 0 OR LOCATE(?, detail) > 0))
           OR LEFT(actor, 19) = ?`, [CAT_PREFIX, ADMIN_PREFIX]);
  sql("DELETE FROM admin_activity WHERE LEFT(subject, 19) IN ('e2e-notify-content-', ?) OR LEFT(actor, 19) = ?", [ADMIN_PREFIX, ADMIN_PREFIX]);
  sql("DELETE FROM admin_users WHERE LEFT(username, 19) = ?", [ADMIN_PREFIX]);
  // Buckets are "action:ip" (or "action:who|ip"); only this run's address.
  sql("DELETE FROM rate_limits WHERE bucket LIKE ? OR bucket LIKE ?", [`%:${XFF}`, `%|${XFF}`]);
}

/* ── Analytics expectations, computed independently of the page ────────── */
const SENT = ["sent", "delivered", "read"];
const FAILED = ["failed", "rejected", "dead"];
function expectKpis(rows) {
  const is = (d, list) => list.includes(d.status);
  const sent = (d) => is(d, SENT);
  const opened = (d) => sent(d) && (d.read || d.status === "read");
  const clicked = (d) => sent(d) && d.clicked;
  const delivered = (d) => ["delivered", "read"].includes(d.status);
  const count = (f) => rows.filter(f).length;
  const rate = (n, d) => ({ text: d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—", title: `${n}/${d}` });
  const ch = (c) => (d) => d.channel === c;
  const and = (...fs) => (d) => fs.every((f) => f(d));
  const attempted = (d) => is(d, [...SENT, ...FAILED]);
  return {
    notifications: { text: String(new Set(rows.map((d) => d.n)).size) },
    sent: { text: String(count(sent)) },
    delivered: { text: String(count(delivered)) },
    failed: { text: String(count((d) => is(d, FAILED))) },
    email_open_rate: rate(count(and(ch("email"), opened)), count(and(ch("email"), sent))),
    click_rate: rate(count(clicked), count(sent)),
    whatsapp_rate: rate(count(and(ch("whatsapp"), delivered)), count(and(ch("whatsapp"), attempted))),
    sms_rate: rate(count(and(ch("sms"), delivered)), count(and(ch("sms"), attempted))),
    skipped_consent: { text: String(count((d) => d.status === "skipped" && CONSENT_REASONS.includes(d.reason))) },
  };
}
function readKpis(html) {
  const out = {};
  for (const m of html.matchAll(/data-kpi="([a-z_]+)"(?: title="([^"]*)")?>([^<]*)</g)) {
    out[m[1]] = { text: decode(m[3]), title: m[2] };
  }
  return out;
}
function compareKpis(label, html, expected) {
  const got = readKpis(html);
  for (const [k, e] of Object.entries(expected)) {
    const g = got[k] || {};
    const ok = g.text === e.text && (e.title === undefined || g.title === e.title);
    check(ok, `${label}: ${k} = ${e.text}${e.title ? ` (${e.title})` : ""}`, `got ${JSON.stringify(g)}`);
  }
  for (const gone of ["inapp_read_rate", "push_rate"]) {
    check(!(gone in got), `${label}: no ${gone} KPI`);
  }
}

/* ══════════════════════════════════════════════════════════════════════ */
cleanup();

const owner = jar();
check((await login(owner, "admin", "Admin@Test123")) === 302, "owner (environment admin) signs in");

// Committee accounts for the role checks, created directly: the accounts page
// is not what this suite tests, and its forced password change would add noise.
const hash = php(["-r", "echo password_hash('Kolam99Deep42', PASSWORD_BCRYPT);"]).trim();
const editorName = `${ADMIN_PREFIX}ed_${RUN}`;
const viewerName = `${ADMIN_PREFIX}vw_${RUN}`;
sql("INSERT INTO admin_users (username, display_name, pass_hash, role, is_active, must_change) VALUES (?, 'E2E Notify Content Editor', ?, 'editor', 1, 0), (?, 'E2E Notify Content Viewer', ?, 'viewer', 1, 0)",
  [editorName, hash, viewerName, hash]);
const editor = jar();
const viewer = jar();
check((await login(editor, editorName, "Kolam99Deep42")) === 302, "editor signs in");
check((await login(viewer, viewerName, "Kolam99Deep42")) === 302, "viewer signs in");

/* ── 1. Templates: list, channels, roles ───────────────────────────────── */
let templateKeys = [];
{
  const r = await owner.get("/admin/notification_templates.php");
  const html = await r.text();
  check(r.status === 200 && !BAD.test(html), "template list renders for the owner", `status ${r.status}`);
  check(html.includes("booking_confirmed") && html.includes("registration_received") && !html.includes("password_reset"), "template list shows the current built-in keys and none of the account ones");
  check(/class="ntpl-matrix"/.test(html) && /ntpl-cell--builtin/.test(html), "template list has the language × channel grid");
  const firstMatrix = /<table class="ntpl-matrix">[\s\S]*?<\/thead>/.exec(html)?.[0] || "";
  const columns = [...firstMatrix.matchAll(/<abbr title="([^"]+)"/g)].map((m) => m[1]);
  check(JSON.stringify(columns) === JSON.stringify(["Shared", "Email", "SMS", "WhatsApp"]), "the grid has Shared, Email, SMS and WhatsApp columns only", JSON.stringify(columns));
  check(!/channel=(push|inapp)/.test(html) && !/>(Push|In-app)</.test(html), "no push or in-app version is offered anywhere in the list");
  templateKeys = [...new Set([...html.matchAll(/\?key=([a-z_]+)&amp;/g)].map((m) => m[1]))];
  check(templateKeys.length >= 20 && templateKeys.includes("registration_received"), `the list links every template (${templateKeys.length})`);

  const f = await (await owner.get("/admin/notification_templates.php?category=donation&channel=sms&lang=en")).text();
  check(f.includes("donation_receipt") && !f.includes("<code>booking_confirmed</code>"), "category filter narrows the list");
  const retired = await owner.get("/admin/notification_templates.php?channel=push");
  const rh = await retired.text();
  check(retired.status === 200 && !BAD.test(rh) && !/>Push</.test(rh), "a retired channel in the query falls back to every live channel", `status ${retired.status}`);

  const e = await editor.get("/admin/notification_templates.php?key=booking_confirmed&lang=en&channel=sms");
  const eh = await e.text();
  check(e.status === 200 && !eh.includes("Save wording") && !eh.includes('value="reset_template"') && !eh.includes("data-ntpl-editor") && /readonly/.test(eh), "editor can read a template but gets no save or reset button", `status ${e.status}`);
  const v = await viewer.get("/admin/notification_templates.php");
  check(v.status === 200, "viewer can open the template list", `status ${v.status}`);
}

/* ── 2. Override the English SMS of booking_confirmed; previews ────────── */
const EDIT = "/admin/notification_templates.php?key=booking_confirmed&lang=en&channel=sms";
{
  const page = await (await owner.get(EDIT)).text();
  check(page.includes('value="save_template"') && page.includes("data-ntpl-editor"), "owner gets the editable form");
  check(/data-pv="sms-info">\d+ characters · \d+ segments? · GSM-7</.test(page), "server-rendered SMS preview shows characters, segments and encoding");
  check(!page.includes('data-pv="sms-stop-hint"') && !/stop temple updates/i.test(page), "a booking SMS preview has no stop-updates line");
  check(!/push or bell|bell notification|lock screens/i.test(page), "the title hint no longer mentions push or the bell");
  const csrf = csrfOf(page);

  const body1 = `${MARK}: your {{sevaName}} on {{bookingDate}} is confirmed. Booking {{bookingNumber}}. {{notAVar}}`;
  let r = await owner.post("/admin/notification_templates.php", {
    _csrf: csrf, action: "save_template", key: "booking_confirmed", lang: "en", channel: "sms",
    title: "", body: body1, cta_label: "", provider_template: "", provider_params: "",
  });
  check(r.status === 303 && (r.headers.get("location") || "").includes("key=booking_confirmed"), "saving the override redirects back to the editor", `status ${r.status} ${r.headers.get("location")}`);
  const after = await (await owner.get(EDIT)).text();
  check(/Saved the wording for booking_confirmed/.test(after), "success message is shown");
  check(/\{\{notAVar\}\} is not a variable of this message/.test(decode(after)), "unknown-variable warning appears after saving");
  check(/data-keep/.test(after), "warnings stay on the page instead of fading as a toast");

  const row = sql("SELECT body, updated_by, is_active FROM notification_templates WHERE template_key='booking_confirmed' AND lang='en' AND channel='sms'")[0];
  check(row && row.body === body1 && row.updated_by === "admin", "the row is stored with the author", JSON.stringify(row));

  const rendered = phpJson(`echo json_encode(notifyRender('booking_confirmed', 'en', 'sms', ['sevaName' => 'Abhishekam', 'bookingDate' => '20 Sep 2026', 'bookingNumber' => 'SB-7']));`);
  check(rendered.source === "db" && rendered.body === `${MARK}: your Abhishekam on 20 Sep 2026 is confirmed. Booking SB-7.`,
    "notifyRender returns the override", JSON.stringify(rendered));
  const other = phpJson(`echo json_encode(notifyRender('booking_confirmed', 'ta', 'sms', []));`);
  check(other.source === "default", "other languages keep the built-in wording");

  let audit = sql("SELECT actor, detail FROM notification_audit WHERE action='template_saved' AND LOCATE(?, detail) > 0 ORDER BY id DESC LIMIT 1", [RUN])[0];
  const d1 = audit ? JSON.parse(audit.detail) : {};
  check(audit && audit.actor === "admin" && d1.before === null && d1.after?.body === body1 && d1.channel === "sms", "audit template_saved records before (none) and after", audit?.detail);

  // Second save drops {{bookingNumber}}: warned, never blocked.
  const body2 = `${MARK} v2: your {{sevaName}} on {{bookingDate}} is confirmed.`;
  r = await owner.post("/admin/notification_templates.php", {
    _csrf: csrf, action: "save_template", key: "booking_confirmed", lang: "en", channel: "sms",
    title: "", body: body2, cta_label: "", provider_template: "booking_confirmed_v2", provider_params: "devoteeName\nsevaName",
  });
  check(r.status === 303, "a save that drops a variable still saves", `status ${r.status}`);
  const after2 = decode(await (await owner.get(EDIT)).text());
  check(/no longer uses \{\{bookingNumber\}\}/.test(after2), "declared-variable-dropped warning appears");
  audit = sql("SELECT detail FROM notification_audit WHERE action='template_saved' AND LOCATE(?, detail) > 0 ORDER BY id DESC LIMIT 1", [`${RUN} v2`])[0];
  const d2 = audit ? JSON.parse(audit.detail) : {};
  check(d2.before?.body === body1 && d2.after?.body === body2 && JSON.stringify(d2.after?.provider_params) === '["devoteeName","sevaName"]',
    "audit keeps the previous wording as before, with provider params in order", audit?.detail);

  // Validation: an empty message is refused and nothing changes.
  r = await owner.post("/admin/notification_templates.php", {
    _csrf: csrf, action: "save_template", key: "booking_confirmed", lang: "en", channel: "sms",
    title: "", body: "   ", cta_label: "", provider_template: "bad name!", provider_params: "",
  });
  const invalid = await r.text();
  check(r.status === 200 && /was not saved/.test(invalid) && /aria-invalid="true"/.test(invalid), "an empty message is refused with field errors");
  check(sql("SELECT body FROM notification_templates WHERE template_key='booking_confirmed' AND lang='en' AND channel='sms'")[0]?.body === body2, "the refused save changed nothing");
  r = await owner.post("/admin/notification_templates.php", {
    _csrf: csrf, action: "save_template", key: "booking_confirmed", lang: "en", channel: "email",
    title: "", body: `${MARK} no title`, cta_label: "", provider_template: "", provider_params: "",
  });
  const noTitle = await r.text();
  check(r.status === 200 && /Enter a title\. It is the email subject\.<\/span>/.test(noTitle), "an email without a title is refused with the email-only reason");
  check(!sql("SELECT 1 FROM notification_templates WHERE LOCATE(?, body) = 1", [`${MARK} no title`]).length, "the untitled email was not stored");

  // Live preview endpoint.
  const preview = async (fields) => {
    const res = await owner.post("/admin/notification_templates.php", { _csrf: csrf, action: "preview", cta_label: "", provider_template: "", provider_params: "", title: "", ...fields }, "application/json");
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  let p = await preview({ key: "booking_confirmed", lang: "en", channel: "sms", body: "Hi {{devoteeName}}, {{typo}}" });
  const pj = p.json;
  check(p.status === 200 && pj.ok && pj.sms?.encoding === "GSM-7" && pj.sms.segments >= 1 && /^Hi Kavitha Ramasamy,\n/.test(pj.sms.text), "preview JSON renders SMS with sample values", JSON.stringify(pj).slice(0, 300));
  check((pj.warnings || []).some((w) => w.includes("{{typo}}")), "preview JSON carries the unknown-variable warning");
  check(pj.stop_line === null && !/stop temple updates/i.test(pj.sms?.text || ""), "a booking SMS preview carries no stop-updates line (an unsubscribe does not stop it)");

  p = await preview({ key: "booking_confirmed", lang: "ta", channel: "any", title: "சோதனை", body: "வணக்கம் {{devoteeName}}", cta_label: "பார்க்க" });
  const pa = p.json;
  check(pa.ok && /<html/i.test(pa.email_html || "") && pa.email_html.includes("சோதனை"), "preview JSON for the shared version has the email HTML");
  check(!("push" in pa) && !("inapp" in pa) && Object.keys(pa).every((k) => !/push|inapp/i.test(k)), "preview JSON has no push or in-app parts", Object.keys(pa).join(","));
  check(!(pa.email_html || "").includes("/api/n/u/"), "a booking email preview has no unsubscribe link");

  p = await preview({ key: "booking_confirmed", lang: "en", channel: "whatsapp", body: "Hello {{devoteeName}}" });
  check(p.json.ok && p.json.whatsapp?.text === "Hello Kavitha Ramasamy" && p.json.whatsapp.template_needs_stop === false, "a booking WhatsApp preview carries no stop-updates line", JSON.stringify(p.json.whatsapp));

  // registration_received is in an informational category: families agreed to updates, and every update carries a way to stop them.
  const regBody = "Welcome {{devoteeName}}. Your family of {{familyCount}} is registered with the temple.";
  p = await preview({ key: "registration_received", lang: "en", channel: "sms", body: regBody });
  check(p.status === 200 && STOP_EN.test(p.json.sms?.text || ""), "a consent-needing SMS preview ends with the stop-updates line", JSON.stringify(p.json.sms));
  const withoutStop = (p.json.sms?.text || "").replace(STOP_EN, "");
  const counted = phpJson(`echo json_encode(notifySmsInfo(${JSON.stringify(p.json.sms?.text || "")}));`);
  check(withoutStop.startsWith("Welcome Kavitha Ramasamy.") && p.json.sms?.chars === counted.chars && p.json.sms?.segments === counted.segments, "the SMS count includes the stop-updates line", JSON.stringify({ got: p.json.sms, counted }));
  p = await preview({ key: "registration_received", lang: "ta", channel: "sms", body: "வணக்கம் {{devoteeName}}" });
  check(/\nகோயில் அறிவிப்புகளை நிறுத்த: \S+\/api\/n\/u\/u0\.previewonlylink0$/.test(p.json.sms?.text || ""), "the Tamil stop-updates line is used for a Tamil SMS", p.json.sms?.text);
  p = await preview({ key: "registration_received", lang: "en", channel: "whatsapp", body: regBody });
  const waText = p.json.whatsapp?.text || "";
  check(/\n\nTo stop temple updates: \S+\/api\/n\/u\/u0\.previewonlylink0$/.test(waText) && p.json.whatsapp.template_needs_stop === false, "a consent-needing WhatsApp preview ends with the stop-updates line", waText);
  p = await preview({ key: "registration_received", lang: "en", channel: "whatsapp", body: regBody, provider_template: "registration_received_v1", provider_params: "devoteeName" });
  check(!/stop temple updates/i.test(p.json.whatsapp?.text || "") && p.json.whatsapp?.template_needs_stop === true, "an approved WhatsApp template gets no appended line and is flagged instead", JSON.stringify(p.json.whatsapp));
  p = await preview({ key: "registration_received", lang: "en", channel: "email", title: "Registered", body: regBody });
  check((p.json.email_html || "").includes("/api/n/u/u0.previewonlylink0"), "a consent-needing email preview carries the preview-only unsubscribe link");

  const regSms = await (await owner.get("/admin/notification_templates.php?key=registration_received&lang=en&channel=sms")).text();
  const smsText = decode(/data-pv="sms-text"[^>]*>([^<]*)</.exec(regSms)?.[1] || "");
  check(STOP_EN.test(smsText) && regSms.includes('data-pv="sms-stop-hint"'), "the server-rendered SMS preview shows the stop-updates line and explains it", smsText);
  const regWa = await (await owner.get("/admin/notification_templates.php?key=registration_received&lang=en&channel=whatsapp")).text();
  check(/To stop temple updates:/.test(regWa) && /data-pv="wa-stop-note" hidden/.test(regWa), "the server-rendered WhatsApp preview shows the line, with the template note hidden");

  r = await owner.post("/admin/notification_templates.php", { _csrf: "wrong", action: "preview", key: "booking_confirmed", lang: "en", channel: "sms", body: "x" }, "application/json");
  check(r.status === 419, "preview without a valid CSRF token is refused", `status ${r.status}`);

  // An editor cannot save.
  const ecsrf = await csrfFor(editor, EDIT);
  r = await editor.post("/admin/notification_templates.php", {
    _csrf: ecsrf, action: "save_template", key: "booking_confirmed", lang: "en", channel: "sms", title: "", body: `${MARK} editor`,
  });
  check(r.status === 403, "an editor cannot save wording (403)", `status ${r.status}`);
  check(!sql("SELECT 1 FROM notification_templates WHERE LOCATE(?, body) = 1", [`${MARK} editor`]).length, "the editor's text was not stored");

  // Reset to built-in.
  const resetPage = await (await owner.get(EDIT)).text();
  check(/value="reset_template"/.test(resetPage) && /data-confirm="Discard the customised wording/.test(resetPage), "reset button asks for confirmation");
  r = await owner.post("/admin/notification_templates.php", { _csrf: csrf, action: "reset_template", key: "booking_confirmed", lang: "en", channel: "sms" });
  check(r.status === 303, "reset redirects", `status ${r.status}`);
  check(!sql("SELECT 1 FROM notification_templates WHERE template_key='booking_confirmed' AND lang='en' AND channel='sms'").length, "reset deletes the row");
  const back = phpJson(`echo json_encode(notifyRender('booking_confirmed', 'en', 'sms', ['sevaName' => 'Abhishekam']));`);
  const builtIn = phpJson(`echo json_encode(notifyTemplateBuiltIn()['booking_confirmed']['langs']['en']['sms']);`);
  check(back.source === "default" && !back.body.includes("E2E-NOTIFY-CONTENT") && builtIn.body.includes("{{sevaName}}"), "notifyRender is back to the built-in wording", JSON.stringify(back));
  audit = sql("SELECT detail FROM notification_audit WHERE action='template_saved' AND JSON_EXTRACT(detail, '$.reset') = true AND LOCATE(?, detail) > 0 ORDER BY id DESC LIMIT 1", [`${RUN} v2`])[0];
  check(audit && JSON.parse(audit.detail).after === null, "reset is audited with before and after = null");

  // No editor or preview mentions an account page: every template, shared and per channel.
  const offenders = [];
  for (const key of templateKeys) {
    for (const [lang, channel] of [["ta", "any"], ["en", "any"], ["en", "sms"], ["en", "whatsapp"]]) {
      const html = await (await owner.get(`/admin/notification_templates.php?key=${key}&lang=${lang}&channel=${channel}`)).text();
      const own = content(html);
      if (BAD.test(html) || /\/account/.test(decode(own)) || /data-pv="(push|inapp)-/.test(own)) offenders.push(`${key} ${lang} ${channel}`);
    }
  }
  check(templateKeys.length > 0 && offenders.length === 0, `no template editor or preview mentions /account or renders push/in-app parts (${templateKeys.length} templates × 4 versions)`, offenders.join(", "));
}

/* ── 3. Categories ─────────────────────────────────────────────────────── */
const CAT = `${CAT_PREFIX}${LETTERS}`;
const CATS = "/admin/notification_templates.php?tab=categories";
{
  const page = await (await owner.get(CATS)).text();
  const own = content(page);
  check(!BAD.test(page) && page.includes('value="add_category"'), "categories tab renders with the add form");
  // Wording is judged on the visible text: markup such as class="badge badge--muted" is not wording.
  const ownText = decode(own.replace(/<[^>]+>/g, " "));
  check(!/name="default_on"/.test(page) && !/On by default/i.test(ownText) && !/\bmute|opted in|opt in|devotee's settings/i.test(ownText), "the category editor has no default-on switch and no muting or opt-in wording",
    /.{0,60}(On by default|\bmute|opted in|opt in|devotee's settings).{0,60}/i.exec(ownText)?.[0]);
  check(/<input type="hidden" name="kind" value="informational" \/>/.test(page) && !/id="n-kind"/.test(page), "a new category is informational, with no kind to choose");
  check(/agreed to temple updates when they registered, and stops when they unsubscribe/.test(own) && /an unsubscribe does not stop it/.test(own), "kind descriptions explain consent and unsubscribe");
  const csrf = csrfOf(page);
  const add = (over) => owner.post(CATS, { _csrf: csrf, action: "add_category", cat_key: CAT, kind: "informational", label_ta: "சோதனை", label_en: `E2E Notify Content ${LETTERS}`, icon: "bell", sort_order: "300", is_active: "1", ...over });

  let r = await add({ cat_key: "Bad Key" });
  check(r.status === 200 && /3 to 32 lowercase letters/.test(await r.text()), "a malformed key is refused");
  r = await add({ kind: "security" });
  check(r.status === 200 && /A new category is informational/.test(await r.text()), "a new category cannot be a security kind");
  r = await add({ kind: "promotional" });
  check(r.status === 200 && /promotional and security categories are no longer used/.test(await r.text()), "a new category cannot be promotional");
  r = await add({ icon: "skull" });
  check(r.status === 200 && /Choose an icon from the list/.test(await r.text()), "an icon outside the list is refused");
  check(!sql("SELECT 1 FROM notification_categories WHERE `key` = ?", [CAT]).length, "refused adds created nothing");

  r = await add({});
  check(r.status === 303, "a valid informational category is added", `status ${r.status}`);
  const row = sql("SELECT kind, label_en, is_active, sort_order, icon FROM notification_categories WHERE `key` = ?", [CAT])[0];
  check(row && row.kind === "informational" && row.label_en === `E2E Notify Content ${LETTERS}` && Number(row.sort_order) === 300 && Number(row.is_active) === 1, "the category row is stored", JSON.stringify(row));
  r = await add({});
  check(r.status === 200 && /already exists/.test(await r.text()), "a duplicate key is refused");

  const edit = (over) => owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: CAT, label_ta: "சோதனை 2", label_en: `E2E Notify Content ${LETTERS} renamed`, icon: "gift", sort_order: "301", is_active: "1", ...over });
  r = await edit({});
  check(r.status === 303 && sql("SELECT label_en FROM notification_categories WHERE `key` = ?", [CAT])[0]?.label_en === `E2E Notify Content ${LETTERS} renamed`, "labels, icon and order can be edited");
  const audit = sql("SELECT detail FROM notification_audit WHERE action='category_saved' AND LOCATE(?, detail) > 0 ORDER BY id DESC LIMIT 1", [CAT])[0];
  const ad = audit ? JSON.parse(audit.detail) : {};
  check(ad.before?.label_en === `E2E Notify Content ${LETTERS}` && ad.after?.label_en === `E2E Notify Content ${LETTERS} renamed` && ad.after?.kind === "informational"
    && !("default_on" in (ad.after || {})) && !("default_on" in (ad.before || {})), "category_saved audit has before and after, without default_on", audit?.detail);

  sql("INSERT INTO notification_campaigns (name, category, status, channels, created_by) VALUES (?, ?, 'scheduled', 'email', ?)", [`E2E-NOTIFY-CONTENT-${RUN}`, CAT, editorName]);
  r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: CAT, label_ta: "சோதனை 2", label_en: `E2E Notify Content ${LETTERS} renamed`, icon: "gift", sort_order: "301" });
  check(r.status === 200 && /used by 1 scheduled or sending campaign/.test(await r.text()), "deactivating a category used by a scheduled email campaign is refused with a message");
  check(Number(sql("SELECT is_active FROM notification_categories WHERE `key` = ?", [CAT])[0]?.is_active) === 1, "the category stays active");

  sql("UPDATE notification_campaigns SET status = 'draft' WHERE name = ?", [`E2E-NOTIFY-CONTENT-${RUN}`]);
  r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: CAT, label_ta: "சோதனை 2", label_en: `E2E Notify Content ${LETTERS} renamed`, icon: "gift", sort_order: "301" });
  check(r.status === 303 && Number(sql("SELECT is_active FROM notification_categories WHERE `key` = ?", [CAT])[0]?.is_active) === 0, "once the campaign is a draft the category can be deactivated");

  // Shipped categories: the emergency one stays on, the retired kinds stay off. Restored if a refusal ever fails.
  const shipped = (key) => sql("SELECT label_ta, label_en, icon, sort_order, is_active, updated_by, updated_at FROM notification_categories WHERE `key` = ?", [key])[0];
  const restore = (key, was) => sql("UPDATE notification_categories SET is_active = ?, label_ta = ?, label_en = ?, icon = ?, sort_order = ?, updated_by = ?, updated_at = ? WHERE `key` = ?",
    [was.is_active, was.label_ta, was.label_en, was.icon, was.sort_order, was.updated_by, was.updated_at, key]);
  const emergency = shipped("emergency");
  r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: "emergency", label_ta: emergency.label_ta, label_en: emergency.label_en, icon: emergency.icon, sort_order: String(emergency.sort_order) });
  const emergencyText = await r.text();
  const emergencyNow = shipped("emergency");
  if (Number(emergencyNow.is_active) !== Number(emergency.is_active)) restore("emergency", emergency);
  check(r.status === 200 && /is an emergency category and stays active/.test(emergencyText) && Number(emergencyNow.is_active) === Number(emergency.is_active), "the emergency category cannot be deactivated");

  const promo = shipped("promotional");
  if (promo) {
    r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: "promotional", label_ta: promo.label_ta, label_en: promo.label_en, icon: promo.icon, sort_order: String(promo.sort_order), is_active: "1" });
    const promoText = decode(await r.text());
    const promoNow = shipped("promotional");
    if (Number(promoNow.is_active) !== Number(promo.is_active)) restore("promotional", promo);
    check(r.status === 200 && /is a promotional category, which is no longer used/.test(promoText) && Number(promoNow.is_active) === Number(promo.is_active), "a promotional category cannot be switched on");
    check(new RegExp(`id="cat-promotional"[\\s\\S]*?name="is_active" value="1" disabled`).test(page), "the promotional category's Active switch is disabled");
  } else {
    check(false, "the promotional category exists (migration 009 keeps it, switched off)");
  }

  const ecsrf = await csrfFor(editor, CATS);
  r = await editor.post(CATS, { _csrf: ecsrf, action: "add_category", cat_key: `${CAT}_x`, kind: "informational", label_ta: "x", label_en: "x", icon: "bell", sort_order: "1" });
  check(r.status === 403, "an editor cannot add a category (403)", `status ${r.status}`);
}

/* ── 4. Analytics over seeded notifications ────────────────────────────── */
const AN_CAT = `${CAT_PREFIX}an_${LETTERS}`;
sql("INSERT INTO notification_categories (`key`, label_ta, label_en, icon, kind, is_active, sort_order) VALUES (?, 'சோதனை பகுப்பாய்வு', ?, 'bell', 'informational', 1, 990)", [AN_CAT, `E2E Notify Content analytics ${LETTERS}`]);
// Three registrations: one agreed to temple updates, one did not, one agreed and then unsubscribed.
const consenting = fixtures("create-devotee", { email: EMAIL("a"), name: "E2E-NOTIFY-CONTENT Analytics", phone: "919876512345", lang: "en", consent: true });
const noConsent = fixtures("create-devotee", { email: EMAIL("n"), name: "E2E-NOTIFY-CONTENT No consent", phone: "919876512346", lang: "en" });
const unsubscribed = fixtures("create-devotee", { email: EMAIL("u"), name: "E2E-NOTIFY-CONTENT Unsubscribed", phone: "919876512347", lang: "en", consent: true, unsubscribed: true });
const CHANNELS = ["email", "whatsapp", "sms"];
// n, status per live channel [status, read, clicked], historic retired rows, and who it is for. n4 is 45 days old.
const PLAN = [
  { n: 1, title: `${MARK} one`, s: { email: ["read", 1, 1], whatsapp: ["delivered", 0, 0], sms: ["dead", 0, 0] }, retired: { inapp: ["read", 1, 0], push: ["sent", 0, 1] } },
  { n: 2, title: `=cmd|' /C calc'!A0 ${MARK}`, s: { email: ["sent", 0, 0], whatsapp: ["failed", 0, 0], sms: ["delivered", 0, 0] }, retired: { push: ["rejected", 0, 0] } },
  { n: 3, title: `${MARK} three`, s: { email: ["delivered", 0, 0], whatsapp: ["read", 1, 0], sms: ["sent", 0, 0] } },
  { n: 4, title: `${MARK} old`, old: true, s: { email: ["read", 1, 0], whatsapp: ["dead", 0, 0], sms: ["delivered", 0, 0] }, retired: { inapp: ["sent", 0, 0] } },
  { n: 5, title: `${MARK} no consent`, devotee: noConsent, expectSkip: "no consent" },
  { n: 6, title: `${MARK} unsubscribed`, devotee: unsubscribed, expectSkip: "unsubscribed" },
];
const seeded = [];
let deadSmsId = 0;
let retiredPushId = 0;
let retiredInappId = 0;
for (const p of PLAN) {
  // Held a day, so a worker running for another suite cannot claim these before their statuses are set below.
  const res = fixtures("notify", {
    devotee_id: (p.devotee || consenting).id, title: p.title, body: `${MARK} body ${p.n}`, category: AN_CAT, priority: "urgent",
    channels: CHANNELS, dedupe_key: `e2e:admin-notify-content:${RUN}:${p.n}`, deliver_after: utcNow(86400000),
  }).result;
  const nid = res.id;
  const deliveries = sql("SELECT id, channel, status, skip_reason FROM notification_deliveries WHERE notification_id = ? ORDER BY id", [nid]);
  check(nid && deliveries.length === 3, `seed notification ${p.n} has a delivery per live channel`, JSON.stringify(res));
  if (p.expectSkip) {
    check(deliveries.every((d) => d.status === "skipped" && d.skip_reason === p.expectSkip), `seed notification ${p.n}: every channel is skipped "${p.expectSkip}"`, JSON.stringify(deliveries));
    for (const d of deliveries) seeded.push({ n: p.n, id: Number(d.id), channel: d.channel, status: d.status, reason: d.skip_reason, read: false, clicked: false, old: false });
    continue;
  }
  if (p.old) {
    sql("UPDATE notifications SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 DAY) WHERE id = ?", [nid]);
  }
  for (const d of deliveries) {
    const [status, read, clicked] = p.s[d.channel];
    const bad = FAILED.includes(status);
    sql(`UPDATE notification_deliveries
            SET status = ?, read_at = IF(?, UTC_TIMESTAMP(), NULL), clicked_at = IF(?, UTC_TIMESTAMP(), NULL),
                sent_at = IF(? IN ('sent','delivered','read'), UTC_TIMESTAMP(), NULL),
                attempts = IF(?, max_attempts, 0), next_attempt_at = NULL, claim_token = NULL,
                failure_reason = IF(?, 'Provider refused the number', NULL),
                provider_response = IF(?, 'provider said: <script>alert(1)</script>', NULL),
                created_at = IF(?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 DAY), created_at)
          WHERE id = ?`,
      [status, read, clicked, status, bad ? 1 : 0, bad ? 1 : 0, bad ? 1 : 0, p.old ? 1 : 0, d.id]);
    seeded.push({ n: p.n, id: Number(d.id), channel: d.channel, status, read: !!read, clicked: !!clicked, old: !!p.old });
    if (p.n === 1 && d.channel === "sms") deadSmsId = Number(d.id);
  }
  // History from before the bell and web push were retired: the enum still holds these rows.
  for (const [channel, [status, read, clicked]] of Object.entries(p.retired || {})) {
    const bad = FAILED.includes(status);
    sql(`INSERT INTO notification_deliveries
            (notification_id, channel, status, priority_rank, provider, attempts, max_attempts, failure_reason, sent_at, read_at, clicked_at, created_at, updated_at)
         VALUES (?, ?, ?, 1, NULL, IF(?, 1, 0), 1, IF(?, 'Browser subscription expired', NULL),
                 IF(? IN ('sent','delivered','read'), UTC_TIMESTAMP(), NULL), IF(?, UTC_TIMESTAMP(), NULL), IF(?, UTC_TIMESTAMP(), NULL),
                 IF(?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 DAY), UTC_TIMESTAMP()), UTC_TIMESTAMP())`,
      [nid, channel, status, bad ? 1 : 0, bad ? 1 : 0, status, read, clicked, p.old ? 1 : 0]);
    const id = Number(sql("SELECT id FROM notification_deliveries WHERE notification_id = ? AND channel = ?", [nid, channel])[0]?.id);
    seeded.push({ n: p.n, id, channel, status, read: !!read, clicked: !!clicked, old: !!p.old });
    if (p.n === 1 && channel === "inapp") retiredInappId = id;
    if (p.n === 2 && channel === "push") retiredPushId = id;
  }
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const daysAgo = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - n * 86400000));
const istMidnightUtc = (day) => new Date(`${day}T00:00:00+05:30`).toISOString().slice(0, 19).replace("T", " ");
const AN = "/admin/notification_analytics.php";
const q = (o) => `${AN}?${new URLSearchParams(o)}`;
const recent = seeded.filter((d) => !d.old);
{
  // F1: category, default 30 days — n1…n3, n5, n6 and their retired rows.
  let r = await owner.get(q({ category: AN_CAT }));
  let html = await r.text();
  check(r.status === 200 && !BAD.test(html), "analytics renders", `status ${r.status}`);
  compareKpis("category filter (30 days)", html, expectKpis(recent));
  check(/3 had not agreed to temple updates · 3 had unsubscribed/.test(html), "the consent KPI splits no consent from unsubscribed");
  check(!/In-app read rate|Push engagement|Read in the bell|shown on the bell|in-app counts|switched off or/.test(html), "no in-app or push KPI or wording remains");
  check(/data-worker-health/.test(html) && /Worker health/.test(html) && /(Running|Not running|Never run)/.test(html), "worker health card is shown");
  check(!/SMS or push message/.test(html), "worker copy does not mention push");
  check(/<figure class="bars/.test(html) && /<ul class="shares"/.test(html), "daily sends bars and channel shares render");
  check(/data-channel="sms"/.test(html) && /Channel performance/.test(html), "channel performance table renders");
  check(/<tr data-channel="inapp">\s*<td><span class="cell-title">In-app \(retired\)<\/span>/.test(html)
    && /<tr data-channel="push">\s*<td><span class="cell-title">Push \(retired\)<\/span>/.test(html), "historic in-app and push rows are labelled retired in the channel table");
  const order = [...html.matchAll(/<tr data-channel="([a-z]+)">/g)].map((m) => m[1]);
  check(JSON.stringify(order) === JSON.stringify(["email", "whatsapp", "sms", "inapp", "push"]), "live channels come first, retired ones after", JSON.stringify(order));
  check(/In-app \(retired\)/.test(/<ul class="shares"[\s\S]*?<\/ul>/.exec(html)?.[0] || ""), "the channel shares label the retired rows too");
  check(/<option value="inapp">In-app \(retired\)<\/option>/.test(html) && /<option value="push">Push \(retired\)<\/option>/.test(html), "the channel filter offers retired channels that have history in the range");
  check(html.includes(`data-delivery="${deadSmsId}"`), "the dead SMS appears in the failed and dead table");
  check(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<script>alert(1)</script>"), "provider response is escaped");
  const pushRow = new RegExp(`<tr data-delivery="${retiredPushId}">[\\s\\S]*?</tr>`).exec(html)?.[0] || "";
  check(/#\d+ · Push \(retired\)/.test(pushRow) && /Retired channel; cannot be re-sent/.test(pushRow) && !/Requeue/.test(pushRow), "a failed retired delivery is labelled and offers no requeue", pushRow.slice(0, 300));

  // F2: widen to 60 days — n4 joins.
  html = await (await owner.get(q({ category: AN_CAT, from: daysAgo(60), to: today }))).text();
  compareKpis("60-day range", html, expectKpis(seeded));

  // F3: SMS only — the email rate has no denominator, and no retired row is in view.
  html = await (await owner.get(q({ category: AN_CAT, channel: "sms" }))).text();
  compareKpis("SMS channel filter", html, expectKpis(recent.filter((d) => d.channel === "sms")));
  check(readKpis(html).email_open_rate?.text === "—" && readKpis(html).email_open_rate?.title === "0/0", "a zero denominator shows — with 0/0");
  check(!/data-channel="(inapp|push)"/.test(html), "retired channels are not listed when the filter holds no history for them");

  // F4: status filter.
  html = await (await owner.get(q({ category: AN_CAT, status: "dead", from: daysAgo(60), to: today }))).text();
  compareKpis("status=dead filter", html, expectKpis(seeded.filter((d) => d.status === "dead")));

  // F5: source=automated equals F1; source=campaign is empty.
  html = await (await owner.get(q({ category: AN_CAT, source: "automated" }))).text();
  compareKpis("source=automated", html, expectKpis(recent));
  html = await (await owner.get(q({ category: AN_CAT, source: "campaign" }))).text();
  check(readKpis(html).sent?.text === "0" && readKpis(html).click_rate?.text === "—" && readKpis(html).skipped_consent?.text === "0", "source=campaign has none of the automated rows");

  // F6: skipped only — exactly the consent skips.
  html = await (await owner.get(q({ category: AN_CAT, status: "skipped" }))).text();
  compareKpis("status=skipped filter", html, expectKpis(recent.filter((d) => d.status === "skipped")));
  check(readKpis(html).skipped_consent?.text === "6", "six deliveries were skipped for consent", JSON.stringify(readKpis(html).skipped_consent));

  // F7: a retired channel as the filter shows its history.
  html = await (await owner.get(q({ category: AN_CAT, channel: "inapp" }))).text();
  compareKpis("retired channel filter (inapp)", html, expectKpis(recent.filter((d) => d.channel === "inapp")));
  check(/<option value="inapp" selected>In-app \(retired\)<\/option>/.test(html), "the retired channel stays selected in the filter");

  // Unsubscribes in range: registrations, not deliveries, so other suites' families count too — bounded by counts taken around the request.
  const countUnsub = () => Number(sql("SELECT COUNT(*) AS n FROM devotees WHERE unsubscribed_at >= ? AND unsubscribed_at < ?", [istMidnightUtc(today), istMidnightUtc(daysAgo(-1))])[0].n);
  const before = countUnsub();
  html = await (await owner.get(q({ category: AN_CAT, from: today, to: today }))).text();
  const afterCount = countUnsub();
  const shown = Number((readKpis(html).unsubscribes?.text || "").replace(/,/g, ""));
  check(shown >= 1 && shown >= Math.min(before, afterCount) && shown <= Math.max(before, afterCount), "Unsubscribes in range counts families who unsubscribed in the dates", `shown ${shown}, before ${before}, after ${afterCount}`);
  const older = await (await owner.get(q({ category: AN_CAT, from: daysAgo(60), to: daysAgo(40) }))).text();
  const olderExpected = Number(sql("SELECT COUNT(*) AS n FROM devotees WHERE unsubscribed_at >= ? AND unsubscribed_at < ?", [istMidnightUtc(daysAgo(60)), istMidnightUtc(daysAgo(39))])[0].n);
  check(readKpis(older).unsubscribes?.text === String(olderExpected), "an older range does not count today's unsubscribe", `got ${JSON.stringify(readKpis(older).unsubscribes)}, expected ${olderExpected}`);

  // CSV
  r = await owner.get(q({ category: AN_CAT, from: daysAgo(60), to: today, export: "csv" }));
  const buf = Buffer.from(await r.arrayBuffer());
  const csv = buf.toString("utf8");
  check(r.status === 200 && (r.headers.get("content-type") || "").startsWith("text/csv"), "CSV export answers text/csv", `status ${r.status}`);
  check(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "CSV starts with a UTF-8 BOM");
  const lines = csv.replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  check(lines.length === 1 + seeded.length, `CSV holds exactly the ${seeded.length} filtered deliveries plus a header`, `got ${lines.length - 1}`);
  check(seeded.every((d) => lines.some((l) => l.startsWith(`${d.id},`))), "every seeded delivery id is in the CSV");
  check(lines.some((l) => l.startsWith(`${retiredInappId},`) && l.includes(",inapp,")), "historic rows keep their channel in the CSV");
  check(/(^|,)"?'=cmd\|/m.test(csv) && !/(^|,)"?=cmd\|/m.test(csv), "a =cmd title is neutralised with an apostrophe");
  check(!/@example\.test/.test(csv), "the CSV carries no email addresses");
  const smsCsv = await (await owner.get(q({ category: AN_CAT, channel: "sms", export: "csv" }))).text();
  const smsLines = smsCsv.replace(/^﻿/, "").split("\n").filter((l) => l.trim()).length;
  check(smsLines === 1 + recent.filter((d) => d.channel === "sms").length, "CSV follows the channel filter", `got ${smsLines - 1}`);

  // Requeue: viewer refused, editor (notifications.compose) allowed; a retired channel never.
  const vcsrf = await csrfFor(viewer, AN);
  r = await viewer.post(AN, { _csrf: vcsrf, action: "requeue", delivery_id: String(deadSmsId), category: AN_CAT });
  check(r.status === 403 && sql("SELECT status FROM notification_deliveries WHERE id = ?", [deadSmsId])[0]?.status === "dead", "a viewer cannot requeue (403)", `status ${r.status}`);
  const epage = await (await editor.get(q({ category: AN_CAT }))).text();
  check(epage.includes(`aria-label="Requeue delivery #${deadSmsId}"`) && !epage.includes(`aria-label="Requeue delivery #${retiredPushId}"`), "the editor sees a Requeue button, but not on the retired row");
  r = await editor.post(AN, { _csrf: csrfOf(epage), action: "requeue", delivery_id: String(retiredPushId), category: AN_CAT });
  const retiredFlash = await (await editor.get(q({ category: AN_CAT }))).text();
  check(r.status === 303 && /Push \(retired\), a channel that is no longer used/.test(retiredFlash) && sql("SELECT status FROM notification_deliveries WHERE id = ?", [retiredPushId])[0]?.status === "rejected", "requeueing a retired delivery is refused and changes nothing");
  r = await editor.post(AN, { _csrf: csrfOf(retiredFlash), action: "requeue", delivery_id: String(deadSmsId), category: AN_CAT });
  check(r.status === 303 && (r.headers.get("location") || "").includes(`category=${AN_CAT}`), "requeue redirects back to the same filter", `status ${r.status} ${r.headers.get("location")}`);
  const dq = sql("SELECT status, attempts, failure_reason FROM notification_deliveries WHERE id = ?", [deadSmsId])[0];
  check(dq.status === "queued" && Number(dq.attempts) === 0 && dq.failure_reason === null, "requeue moves the dead delivery to queued with attempts reset", JSON.stringify(dq));
  const ra = sql("SELECT actor, detail FROM notification_audit WHERE action = 'requeued' AND actor = ? ORDER BY id DESC LIMIT 1", [editorName])[0];
  check(ra && Number(JSON.parse(ra.detail).delivery_id) === deadSmsId && JSON.parse(ra.detail).previous_status === "dead", "requeue is audited", ra?.detail);
  check(sql("SELECT 1 FROM notification_delivery_events WHERE delivery_id = ? AND event = 'requeued'", [deadSmsId]).length === 1, "requeue writes a delivery event");
  const flash = await (await editor.get(q({ category: AN_CAT }))).text();
  check(/\(SMS\) is back in the queue/.test(flash), "requeue confirms on the page");
  r = await editor.post(AN, { _csrf: csrfOf(flash), action: "requeue", delivery_id: String(deadSmsId), category: AN_CAT });
  check(r.status === 303 && /nothing to requeue/.test(await (await editor.get(q({ category: AN_CAT }))).text()), "requeueing a queued delivery explains there is nothing to do");
  const oldWa = seeded.find((d) => d.n === 4 && d.channel === "whatsapp").id;
  r = await editor.post(AN, { _csrf: "bad", action: "requeue", delivery_id: String(oldWa) });
  check(r.status === 303 && sql("SELECT status FROM notification_deliveries WHERE id = ?", [oldWa])[0]?.status === "dead", "requeue without a valid CSRF token changes nothing");
}

/* ── 5. Browser: accessibility, overflow, chips and live preview ────────── */
{
  const browser = await chromium.launch();
  const url = new URL(base);
  const pages = [
    ["template list", "/admin/notification_templates.php"],
    ["template editor", "/admin/notification_templates.php?key=booking_confirmed&lang=en&channel=sms"],
    ["shared template editor", "/admin/notification_templates.php?key=registration_received&lang=ta&channel=any"],
    ["WhatsApp template editor", "/admin/notification_templates.php?key=registration_received&lang=en&channel=whatsapp"],
    ["categories", "/admin/notification_templates.php?tab=categories"],
    ["analytics", `/admin/notification_analytics.php?${new URLSearchParams({ category: AN_CAT, from: daysAgo(60), to: today })}`],
  ];
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-IN" });
    // The suite's X-Forwarded-For goes only to our own server. Sent context-wide it would reach
    // Google Fonts too, whose CORS preflight refuses unknown headers and blocks the fonts.
    await ctx.route((u) => u.origin === url.origin, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": XFF } }));
    await ctx.addCookies([{ name: "PHPSESSID", value: owner.sessionId, domain: url.hostname, path: "/" }]);
    for (const [name, path] of pages) {
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
      // Failed requests are judged by URL: the admin's web fonts cannot load offline, which says nothing about this page.
      page.on("requestfailed", (rq) => { if (!/fonts\.(googleapis|gstatic)\.com/.test(rq.url())) errors.push(`[requestfailed] ${rq.url()} ${rq.failure()?.errorText}`); });
      page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource|fonts\.(googleapis|gstatic)\.com/.test(m.text())) errors.push(`[console] ${m.text()}`); });
      const res = await page.goto(base + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      check(res.status() === 200, `${name} @${width}: loads`, `status ${res.status()}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      check(!overflow, `${name} @${width}: no horizontal overflow`, await page.evaluate(() => {
        const wide = [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 4);
        return wide.map((el) => `${el.tagName}.${el.className}`).join(" | ");
      }));
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        // .topbar-user is the admin shell's account button (admin_layout.php, not these pages): below
        // 820px its name is hidden, a shell-wide finding reported to the layout's owner. Everything else counts.
        const r = await window.axe.run({ exclude: [[".topbar-user"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } });
        return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
      });
      check(violations.length === 0, `${name} @${width}: axe 0 serious or critical`, violations.slice(0, 6).join("\n    "));
      check(errors.length === 0, `${name} @${width}: no script errors`, errors.join(" | "));

      if (width === 1440 && name === "template editor") {
        const chips = await page.locator(".ntpl-var-btn").count();
        check(chips > 5, "variable chips are upgraded to buttons", `found ${chips}`);
        const body = page.locator("#t-body");
        await body.fill("Vanakkam ");
        await body.press("End");
        await page.locator(".ntpl-var-btn", { hasText: "{{sevaName}}" }).first().click();
        check((await body.inputValue()) === "Vanakkam {{sevaName}}", "a chip inserts {{var}} at the cursor", await body.inputValue());
        await page.waitForFunction(() => /updated/.test(document.querySelector("[data-pv-status]")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
        const sms = await page.locator('[data-pv="sms-text"]').textContent();
        check(/^Vanakkam Abhishekam/.test(sms || "") && !/stop temple updates/i.test(sms || ""), "the live preview renders the edit with sample values", sms);
        const info = await page.locator('[data-pv="sms-info"]').textContent();
        check(/\d+ characters · 1 segment · GSM-7/.test(info || ""), "the live preview updates the SMS count", info);
        await body.press("End");
        await body.type(" {{nopeVar}}");
        await page.waitForFunction(() => /nopeVar/.test(document.querySelector("[data-ntpl-warnings]")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
        check(/\{\{nopeVar\}\} is not a variable/.test((await page.locator("[data-ntpl-warnings]").textContent()) || ""), "live warnings flag an unknown variable");
      }

      if (width === 1440 && name === "WhatsApp template editor") {
        const waStatus = () => page.locator("[data-pv-status]").textContent();
        const waitUpdated = async (previous) => {
          await page.waitForFunction((prev) => {
            const s = document.querySelector("[data-pv-status]")?.textContent || "";
            return /updated/.test(s) && s !== prev;
          }, previous, { timeout: 8000 }).catch(() => {});
        };
        const body = page.locator("#t-body");
        await body.fill("Vanakkam {{devoteeName}}");
        await waitUpdated("");
        const text = (await page.locator('[data-pv="wa-text"]').textContent()) || "";
        check(/^Vanakkam Kavitha Ramasamy\s+To stop temple updates: \S+previewonlylink0$/.test(text), "the live WhatsApp preview keeps the stop-updates line under the edit", text);
        check(await page.locator('[data-pv="wa-stop-note"]').isHidden(), "the approved-template note is hidden while no template is named");
        // Force a status change so the next wait sees this refresh rather than the last one.
        await page.evaluate(() => { document.querySelector("[data-pv-status]").textContent = "…"; });
        await page.locator("#t-ptpl").fill("registration_received_v1");
        await waitUpdated(await waStatus());
        check(await page.locator('[data-pv="wa-stop-note"]').isVisible(), "naming an approved template shows the note that its own wording must carry the link");
        check(!/stop temple updates/i.test((await page.locator('[data-pv="wa-text"]').textContent()) || ""), "an approved template's preview has no appended line");
      }
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
}

/* ── Cleanup ───────────────────────────────────────────────────────────── */
cleanup();
const leftovers = {
  devotees: sql("SELECT COUNT(*) AS n FROM devotees WHERE LEFT(email, 19) = 'e2e-notify-content-' OR LEFT(name, 18) = 'E2E-NOTIFY-CONTENT'")[0].n,
  notifications: sql("SELECT COUNT(*) AS n FROM notifications WHERE LOCATE('E2E-NOTIFY-CONTENT', title) > 0")[0].n,
  templates: sql("SELECT COUNT(*) AS n FROM notification_templates WHERE LEFT(body, 18) = 'E2E-NOTIFY-CONTENT'")[0].n,
  categories: sql("SELECT COUNT(*) AS n FROM notification_categories WHERE LEFT(`key`, 18) = ?", [CAT_PREFIX])[0].n,
  campaigns: sql("SELECT COUNT(*) AS n FROM notification_campaigns WHERE LEFT(name, 19) = 'E2E-NOTIFY-CONTENT-'")[0].n,
  admins: sql("SELECT COUNT(*) AS n FROM admin_users WHERE LEFT(username, 19) = ?", [ADMIN_PREFIX])[0].n,
  audit: sql("SELECT COUNT(*) AS n FROM notification_audit WHERE LOCATE(?, detail) > 0 OR LEFT(actor, 19) = ?", [RUN, ADMIN_PREFIX])[0].n,
  deliveries: sql("SELECT COUNT(*) AS n FROM notification_deliveries WHERE id IN (?, ?, ?)", [deadSmsId, retiredPushId, retiredInappId])[0].n,
};
check(Object.values(leftovers).every((n) => Number(n) === 0), "cleanup leaves none of this suite's rows", JSON.stringify(leftovers));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
