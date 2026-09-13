// End-to-end tests for the notification content admin: Message Templates
// (wording, preview, reset, categories), Delivery Analytics (KPIs, filters, CSV,
// requeue, worker health) and devotee tags on devotees.php.
//
//   PHP_BIN=/c/Users/nithp/AppData/Local/Temp/claude/temple-php-0913/php.sh \
//     node tests/admin-notify-content.mjs http://127.0.0.1:8004
//
// Real PHP server, real MySQL. Devotees, notifications and deliveries are
// seeded through tests/support/notify_fixtures.php and then given exact
// statuses with SQL, so every KPI can be checked against a number computed
// here independently. Every request carries this suite's own X-Forwarded-For.
// Re-runnable: it removes its own rows before and after (emails e2e-nc-…,
// categories qa_nc_…, campaigns E2E-NC-…, template text E2E-NC…, admin
// accounts e2e_nc_…).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const base = (process.argv[2] || "http://127.0.0.1:8004").replace(/\/$/, "");
const PHP_BIN = process.env.PHP_BIN || "php";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = Date.now().toString(36);
const LETTERS = Array.from({ length: 6 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const XFF = `10.34.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
const MARK = `E2E-NC ${RUN}`;
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace)/;

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
  return cond;
};

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
const sql = (query, params = []) => fixtures("sql", { query, params }).rows;
const phpJson = (code) => JSON.parse(php(["-r", `require 'backend/includes/notify.php'; ${code}`]).trim());

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

/* ── Cleanup ───────────────────────────────────────────────────────────── */
function cleanup(extraActors = []) {
  fixtures("cleanup", { email_prefix: "e2e-nc-" });
  sql("DELETE FROM notification_templates WHERE body LIKE 'E2E-NC%'");
  sql("DELETE FROM notification_campaigns WHERE name LIKE 'E2E-NC-%'");
  // No backslashes in SQL sent through the CLI: Git Bash drops them from arguments,
  // which breaks the JSON. LEFT(col, n) = 'prefix' is an exact prefix match instead of an escaped LIKE.
  // Test categories use qa_nc_ because a category key allows letters and underscores only.
  sql("DELETE FROM notification_categories WHERE LEFT(`key`, 6) = 'qa_nc_'");
  sql("DELETE FROM notification_audit WHERE (action IN ('template_saved','category_saved') AND (detail LIKE '%E2E-NC%' OR detail LIKE '%qa_nc_%')) OR LEFT(actor, 7) = 'e2e_nc_'");
  sql("DELETE FROM admin_activity WHERE subject LIKE 'e2e-nc-%' OR LEFT(actor, 7) = 'e2e_nc_'");
  sql("DELETE FROM admin_users WHERE LEFT(username, 7) = 'e2e_nc_'");
  sql("DELETE FROM rate_limits WHERE bucket LIKE ?", [`%${XFF}%`]);
  for (const a of extraActors) sql("DELETE FROM notification_audit WHERE actor = ?", [a]);
}

/* ── Analytics expectations, computed independently of the page ────────── */
const SENT = ["sent", "delivered", "read"];
const FAILED = ["failed", "rejected", "dead"];
function expectKpis(rows) {
  const is = (d, list) => list.includes(d.status);
  const sent = (d) => is(d, SENT);
  const opened = (d) => sent(d) && (d.read || d.status === "read");
  const clicked = (d) => sent(d) && d.clicked;
  const delivered = (d) => ["delivered", "read"].includes(d.status) || (d.channel === "inapp" && d.status === "sent");
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
    inapp_read_rate: rate(count(and(ch("inapp"), opened)), count(and(ch("inapp"), sent))),
    click_rate: rate(count(clicked), count(sent)),
    whatsapp_rate: rate(count(and(ch("whatsapp"), (d) => ["delivered", "read"].includes(d.status))), count(and(ch("whatsapp"), attempted))),
    sms_rate: rate(count(and(ch("sms"), (d) => ["delivered", "read"].includes(d.status))), count(and(ch("sms"), attempted))),
    push_rate: rate(count(and(ch("push"), clicked)), count(and(ch("push"), sent))),
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
}

/* ══════════════════════════════════════════════════════════════════════ */
cleanup();

const owner = jar();
check((await login(owner, "admin", "Admin@Test123")) === 302, "owner (environment admin) signs in");

// Committee accounts for the role checks, created directly: the accounts page
// is not what this suite tests, and its forced password change would add noise.
const hash = php(["-r", "echo password_hash('Kolam99Deep42', PASSWORD_BCRYPT);"]).trim();
const editorName = `e2e_nc_ed_${RUN}`;
const viewerName = `e2e_nc_vw_${RUN}`;
sql("INSERT INTO admin_users (username, display_name, pass_hash, role, is_active, must_change) VALUES (?, 'E2E NC Editor', ?, 'editor', 1, 0), (?, 'E2E NC Viewer', ?, 'viewer', 1, 0)",
  [editorName, hash, viewerName, hash]);
const editor = jar();
const viewer = jar();
check((await login(editor, editorName, "Kolam99Deep42")) === 302, "editor signs in");
check((await login(viewer, viewerName, "Kolam99Deep42")) === 302, "viewer signs in");

/* ── 1. Templates: list, roles ─────────────────────────────────────────── */
{
  const r = await owner.get("/admin/notification_templates.php");
  const html = await r.text();
  check(r.status === 200 && !BAD.test(html), "template list renders for the owner", `status ${r.status}`);
  check(html.includes("booking_confirmed") && html.includes("password_reset"), "template list shows built-in keys");
  check(/class="ntpl-matrix"/.test(html) && /ntpl-cell--builtin/.test(html), "template list has the language × channel grid");

  const f = await (await owner.get("/admin/notification_templates.php?category=security&channel=sms&lang=en")).text();
  check(f.includes("password_reset") && !f.includes("<code>booking_confirmed</code>"), "category filter narrows the list");

  const e = await editor.get("/admin/notification_templates.php?key=booking_confirmed&lang=en&channel=sms");
  const eh = await e.text();
  check(e.status === 200 && !eh.includes("Save wording") && !eh.includes('value="reset_template"') && !eh.includes("data-ntpl-editor") && /readonly/.test(eh), "editor can read a template but gets no save or reset button", `status ${e.status}`);
  const v = await viewer.get("/admin/notification_templates.php");
  check(v.status === 200, "viewer can open the template list", `status ${v.status}`);
}

/* ── 2. Override the English SMS of booking_confirmed ──────────────────── */
const EDIT = "/admin/notification_templates.php?key=booking_confirmed&lang=en&channel=sms";
{
  const page = await (await owner.get(EDIT)).text();
  check(page.includes('value="save_template"') && page.includes('data-ntpl-editor'), "owner gets the editable form");
  check(/data-pv="sms-info">\d+ characters · \d+ segments? · GSM-7</.test(page), "server-rendered SMS preview shows characters, segments and encoding");
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

  let audit = sql("SELECT actor, detail FROM notification_audit WHERE action='template_saved' AND detail LIKE ? ORDER BY id DESC LIMIT 1", [`%${RUN}%`])[0];
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
  audit = sql("SELECT detail FROM notification_audit WHERE action='template_saved' AND detail LIKE ? ORDER BY id DESC LIMIT 1", [`%${RUN} v2%`])[0];
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

  // Live preview endpoint.
  r = await owner.post("/admin/notification_templates.php", {
    _csrf: csrf, action: "preview", key: "booking_confirmed", lang: "en", channel: "sms",
    title: "", body: "Hi {{devoteeName}}, {{typo}}", cta_label: "", provider_template: "", provider_params: "",
  }, "application/json");
  const pj = await r.json().catch(() => ({}));
  check(r.status === 200 && pj.ok && pj.sms?.encoding === "GSM-7" && pj.sms.segments >= 1 && /^Hi Kavitha Ramasamy,\n/.test(pj.sms.text), "preview JSON renders SMS with sample values", JSON.stringify(pj).slice(0, 300));
  check((pj.warnings || []).some((w) => w.includes("{{typo}}")), "preview JSON carries the unknown-variable warning");
  r = await owner.post("/admin/notification_templates.php", {
    _csrf: csrf, action: "preview", key: "booking_confirmed", lang: "ta", channel: "any",
    title: "சோதனை", body: "வணக்கம் {{devoteeName}}", cta_label: "பார்க்க",
  }, "application/json");
  const pa = await r.json().catch(() => ({}));
  check(pa.ok && /<html/i.test(pa.email_html || "") && pa.push?.title === "சோதனை" && pa.inapp?.cta_label === "பார்க்க", "preview JSON for the shared version has email HTML, push and in-app");
  r = await owner.post("/admin/notification_templates.php", { _csrf: "wrong", action: "preview", key: "booking_confirmed", lang: "en", channel: "sms", body: "x" }, "application/json");
  check(r.status === 419, "preview without a valid CSRF token is refused", `status ${r.status}`);

  // An editor cannot save.
  const ecsrf = await csrfFor(editor, EDIT);
  r = await editor.post("/admin/notification_templates.php", {
    _csrf: ecsrf, action: "save_template", key: "booking_confirmed", lang: "en", channel: "sms", title: "", body: `${MARK} editor`,
  });
  check(r.status === 403, "an editor cannot save wording (403)", `status ${r.status}`);
  check(!sql("SELECT 1 FROM notification_templates WHERE body LIKE ?", [`${MARK} editor%`]).length, "the editor's text was not stored");

  // Reset to built-in.
  const resetPage = await (await owner.get(EDIT)).text();
  check(/value="reset_template"/.test(resetPage) && /data-confirm="Discard the customised wording/.test(resetPage), "reset button asks for confirmation");
  r = await owner.post("/admin/notification_templates.php", { _csrf: csrf, action: "reset_template", key: "booking_confirmed", lang: "en", channel: "sms" });
  check(r.status === 303, "reset redirects", `status ${r.status}`);
  check(!sql("SELECT 1 FROM notification_templates WHERE template_key='booking_confirmed' AND lang='en' AND channel='sms'").length, "reset deletes the row");
  const back = phpJson(`echo json_encode(notifyRender('booking_confirmed', 'en', 'sms', ['sevaName' => 'Abhishekam']));`);
  const builtIn = phpJson(`echo json_encode(notifyTemplateBuiltIn()['booking_confirmed']['langs']['en']['sms']);`);
  check(back.source === "default" && !back.body.includes("E2E-NC") && builtIn.body.includes("{{sevaName}}"), "notifyRender is back to the built-in wording", JSON.stringify(back));
  audit = sql("SELECT detail FROM notification_audit WHERE action='template_saved' AND JSON_EXTRACT(detail, '$.reset') = true AND detail LIKE ? ORDER BY id DESC LIMIT 1", [`%${RUN} v2%`])[0];
  check(audit && JSON.parse(audit.detail).after === null, "reset is audited with before and after = null");
}

/* ── 3. Categories ─────────────────────────────────────────────────────── */
// Category keys are letters and underscores only, so the test prefix has no digits.
const CAT = `qa_nc_${LETTERS}`;
const CATS = "/admin/notification_templates.php?tab=categories";
{
  const page = await (await owner.get(CATS)).text();
  check(!BAD.test(page) && page.includes('value="add_category"'), "categories tab renders with the add form");
  const csrf = csrfOf(page);
  const add = (over) => owner.post(CATS, { _csrf: csrf, action: "add_category", cat_key: CAT, kind: "informational", label_ta: "சோதனை", label_en: `E2E NC ${LETTERS}`, icon: "bell", sort_order: "300", is_active: "1", default_on: "1", ...over });

  let r = await add({ cat_key: "Bad Key" });
  check(r.status === 200 && /3 to 32 lowercase letters/.test(await r.text()), "a malformed key is refused");
  r = await add({ kind: "security" });
  check(r.status === 200 && /informational or promotional/.test(await r.text()), "a new category cannot be a security kind");
  r = await add({ icon: "skull" });
  check(r.status === 200 && /Choose an icon from the list/.test(await r.text()), "an icon outside the list is refused");
  check(!sql("SELECT 1 FROM notification_categories WHERE `key` = ?", [CAT]).length, "refused adds created nothing");

  r = await add({});
  check(r.status === 303, "a valid informational category is added", `status ${r.status}`);
  const row = sql("SELECT kind, label_en, is_active, default_on, sort_order, icon FROM notification_categories WHERE `key` = ?", [CAT])[0];
  check(row && row.kind === "informational" && row.label_en === `E2E NC ${LETTERS}` && Number(row.sort_order) === 300, "the category row is stored", JSON.stringify(row));
  r = await add({});
  check(r.status === 200 && /already exists/.test(await r.text()), "a duplicate key is refused");

  const edit = (over) => owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: CAT, label_ta: "சோதனை 2", label_en: `E2E NC ${LETTERS} renamed`, icon: "gift", sort_order: "301", is_active: "1", default_on: "1", ...over });
  r = await edit({});
  check(r.status === 303 && sql("SELECT label_en FROM notification_categories WHERE `key` = ?", [CAT])[0]?.label_en === `E2E NC ${LETTERS} renamed`, "labels, icon and order can be edited");
  const audit = sql("SELECT detail FROM notification_audit WHERE action='category_saved' AND detail LIKE ? ORDER BY id DESC LIMIT 1", [`%${CAT}%`])[0];
  const ad = audit ? JSON.parse(audit.detail) : {};
  check(ad.before?.label_en === `E2E NC ${LETTERS}` && ad.after?.label_en === `E2E NC ${LETTERS} renamed` && ad.after?.kind === "informational", "category_saved audit has before and after", audit?.detail);

  sql("INSERT INTO notification_campaigns (name, category, status, channels, created_by) VALUES (?, ?, 'scheduled', 'inapp', ?)", [`E2E-NC-${RUN}`, CAT, editorName]);
  const { is_active: _drop, ...noActive } = { is_active: "1" };
  r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: CAT, label_ta: "சோதனை 2", label_en: `E2E NC ${LETTERS} renamed`, icon: "gift", sort_order: "301", default_on: "1", ...noActive });
  const refused = await r.text();
  check(r.status === 200 && /used by 1 scheduled or sending campaign/.test(refused), "deactivating a category used by a scheduled campaign is refused with a message");
  check(Number(sql("SELECT is_active FROM notification_categories WHERE `key` = ?", [CAT])[0]?.is_active) === 1, "the category stays active");

  sql("UPDATE notification_campaigns SET status = 'draft' WHERE name = ?", [`E2E-NC-${RUN}`]);
  r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: CAT, label_ta: "சோதனை 2", label_en: `E2E NC ${LETTERS} renamed`, icon: "gift", sort_order: "301", default_on: "1" });
  check(r.status === 303 && Number(sql("SELECT is_active FROM notification_categories WHERE `key` = ?", [CAT])[0]?.is_active) === 0, "once the campaign is a draft the category can be deactivated");

  const sec = sql("SELECT label_ta, label_en, icon, sort_order, is_active FROM notification_categories WHERE `key` = 'security'")[0];
  r = await owner.post(CATS, { _csrf: csrf, action: "save_category", cat_key: "security", label_ta: sec.label_ta, label_en: sec.label_en, icon: sec.icon, sort_order: String(sec.sort_order) });
  check(r.status === 200 && /stays active/.test(await r.text()), "a security category cannot be deactivated");
  check(Number(sql("SELECT is_active FROM notification_categories WHERE `key` = 'security'")[0]?.is_active) === Number(sec.is_active), "security category unchanged");

  const ecsrf = await csrfFor(editor, CATS);
  r = await editor.post(CATS, { _csrf: ecsrf, action: "add_category", cat_key: `${CAT}_x`, kind: "informational", label_ta: "x", label_en: "x", icon: "bell", sort_order: "1" });
  check(r.status === 403, "an editor cannot add a category (403)", `status ${r.status}`);
}

/* ── 4. Analytics over seeded notifications ────────────────────────────── */
const AN_CAT = `qa_nc_an_${LETTERS}`;
sql("INSERT INTO notification_categories (`key`, label_ta, label_en, icon, kind, default_on, is_active, sort_order) VALUES (?, 'சோதனை பகுப்பாய்வு', ?, 'bell', 'informational', 1, 1, 990)", [AN_CAT, `E2E NC analytics ${LETTERS}`]);
const devotee = fixtures("create-devotee", { email: `e2e-nc-${RUN}-a@example.test`, name: "E2E NC Analytics", phone: "+919876500001", verified: true, phoneVerified: true });
const CHANNELS = ["inapp", "email", "whatsapp", "sms", "push"];
// n, status per channel, read/clicked flags. n4 is 45 days old.
const PLAN = [
  { n: 1, title: `${MARK} one`, s: { inapp: ["read", 1, 0], email: ["read", 1, 1], whatsapp: ["delivered", 0, 0], sms: ["dead", 0, 0], push: ["sent", 0, 1] } },
  { n: 2, title: `=cmd|' /C calc'!A0 ${MARK}`, s: { inapp: ["sent", 0, 0], email: ["sent", 0, 0], whatsapp: ["failed", 0, 0], sms: ["delivered", 0, 0], push: ["rejected", 0, 0] } },
  { n: 3, title: `${MARK} three`, s: { inapp: ["read", 1, 1], email: ["delivered", 0, 0], whatsapp: ["read", 1, 0], sms: ["sent", 0, 0], push: ["skipped", 0, 0] } },
  { n: 4, title: `${MARK} old`, old: true, s: { inapp: ["sent", 0, 0], email: ["read", 1, 0], whatsapp: ["dead", 0, 0], sms: ["delivered", 0, 0], push: ["sent", 0, 0] } },
];
const seeded = [];
let deadSmsId = 0;
for (const p of PLAN) {
  const res = fixtures("notify", {
    devotee_id: devotee.id, title: p.title, body: `${MARK} body ${p.n}`, category: AN_CAT, priority: "urgent",
    channels: CHANNELS, dedupe_key: `e2e:admin-notify-content:${RUN}:${p.n}`,
  }).result;
  const nid = res.id;
  const deliveries = sql("SELECT id, channel FROM notification_deliveries WHERE notification_id = ?", [nid]);
  check(nid && deliveries.length === 5, `seed notification ${p.n} has a delivery per channel`, JSON.stringify(res));
  if (p.old) {
    sql("UPDATE notifications SET created_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 DAY) WHERE id = ?", [nid]);
  }
  for (const d of deliveries) {
    const [status, read, clicked] = p.s[d.channel];
    const dead = status === "dead" || status === "failed" || status === "rejected";
    sql(`UPDATE notification_deliveries
            SET status = ?, read_at = IF(?, UTC_TIMESTAMP(), NULL), clicked_at = IF(?, UTC_TIMESTAMP(), NULL),
                sent_at = IF(? IN ('sent','delivered','read'), UTC_TIMESTAMP(), NULL),
                attempts = IF(?, max_attempts, 0), next_attempt_at = NULL, claim_token = NULL,
                failure_reason = IF(?, 'Provider refused the number', NULL),
                provider_response = IF(?, 'provider said: <script>alert(1)</script>', NULL),
                created_at = IF(?, DATE_SUB(UTC_TIMESTAMP(), INTERVAL 45 DAY), created_at)
          WHERE id = ?`,
      [status, read, clicked, status, dead ? 1 : 0, dead ? 1 : 0, dead ? 1 : 0, p.old ? 1 : 0, d.id]);
    seeded.push({ n: p.n, id: Number(d.id), channel: d.channel, status, read: !!read, clicked: !!clicked, old: !!p.old });
    if (p.n === 1 && d.channel === "sms") deadSmsId = Number(d.id);
  }
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const daysAgo = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - n * 86400000));
const AN = "/admin/notification_analytics.php";
const q = (o) => `${AN}?${new URLSearchParams(o)}`;
{
  // F1: category, default 30 days — n1…n3.
  let r = await owner.get(q({ category: AN_CAT }));
  let html = await r.text();
  check(r.status === 200 && !BAD.test(html), "analytics renders", `status ${r.status}`);
  compareKpis("category filter (30 days)", html, expectKpis(seeded.filter((d) => !d.old)));
  check(/data-worker-health/.test(html) && /Worker health/.test(html) && /(Running|Not running|Never run)/.test(html), "worker health card is shown");
  check(/<figure class="bars/.test(html) && /<ul class="shares"/.test(html), "daily sends bars and channel shares render");
  check(/data-channel="sms"/.test(html) && /Channel performance/.test(html), "channel performance table renders");
  check(html.includes(`data-delivery="${deadSmsId}"`), "the dead SMS appears in the failed and dead table");
  check(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<script>alert(1)</script>"), "provider response is escaped");

  // F2: widen to 60 days — n4 joins.
  html = await (await owner.get(q({ category: AN_CAT, from: daysAgo(60), to: today }))).text();
  compareKpis("60-day range", html, expectKpis(seeded));

  // F3: SMS only — the email rate has no denominator.
  html = await (await owner.get(q({ category: AN_CAT, channel: "sms" }))).text();
  const smsOnly = expectKpis(seeded.filter((d) => !d.old && d.channel === "sms"));
  compareKpis("SMS channel filter", html, smsOnly);
  check(readKpis(html).email_open_rate?.text === "—" && readKpis(html).email_open_rate?.title === "0/0", "a zero denominator shows — with 0/0");

  // F4: status filter.
  html = await (await owner.get(q({ category: AN_CAT, status: "dead", from: daysAgo(60), to: today }))).text();
  compareKpis("status=dead filter", html, expectKpis(seeded.filter((d) => d.status === "dead")));

  // F5: source=automated equals F1; source=campaign is empty.
  html = await (await owner.get(q({ category: AN_CAT, source: "automated" }))).text();
  compareKpis("source=automated", html, expectKpis(seeded.filter((d) => !d.old)));
  html = await (await owner.get(q({ category: AN_CAT, source: "campaign" }))).text();
  check(readKpis(html).sent?.text === "0" && readKpis(html).click_rate?.text === "—", "source=campaign has none of the automated rows");

  // CSV
  r = await owner.get(q({ category: AN_CAT, from: daysAgo(60), to: today, export: "csv" }));
  const buf = Buffer.from(await r.arrayBuffer());
  const csv = buf.toString("utf8");
  check(r.status === 200 && (r.headers.get("content-type") || "").startsWith("text/csv"), "CSV export answers text/csv", `status ${r.status}`);
  check(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "CSV starts with a UTF-8 BOM");
  const lines = csv.replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  check(lines.length === 1 + seeded.length, `CSV holds exactly the ${seeded.length} filtered deliveries plus a header`, `got ${lines.length - 1}`);
  check(seeded.every((d) => lines.some((l) => l.startsWith(`${d.id},`))), "every seeded delivery id is in the CSV");
  check(/(^|,)"?'=cmd\|/m.test(csv) && !/(^|,)"?=cmd\|/m.test(csv), "a =cmd title is neutralised with an apostrophe");
  check(!/@example\.test/.test(csv), "the CSV carries no email addresses");
  const smsCsv = await (await owner.get(q({ category: AN_CAT, channel: "sms", export: "csv" }))).text();
  check(smsCsv.replace(/^﻿/, "").split("\n").filter((l) => l.trim()).length === 1 + 3, "CSV follows the channel filter");

  // Requeue: viewer refused, editor (notifications.compose) allowed.
  const vcsrf = await csrfFor(viewer, AN);
  r = await viewer.post(AN, { _csrf: vcsrf, action: "requeue", delivery_id: String(deadSmsId), category: AN_CAT });
  check(r.status === 403 && sql("SELECT status FROM notification_deliveries WHERE id = ?", [deadSmsId])[0]?.status === "dead", "a viewer cannot requeue (403)", `status ${r.status}`);
  const epage = await (await editor.get(q({ category: AN_CAT }))).text();
  check(epage.includes(`aria-label="Requeue delivery #${deadSmsId}"`), "the editor sees a Requeue button");
  r = await editor.post(AN, { _csrf: csrfOf(epage), action: "requeue", delivery_id: String(deadSmsId), category: AN_CAT });
  check(r.status === 303 && (r.headers.get("location") || "").includes(`category=${AN_CAT}`), "requeue redirects back to the same filter", `status ${r.status} ${r.headers.get("location")}`);
  const dq = sql("SELECT status, attempts, failure_reason FROM notification_deliveries WHERE id = ?", [deadSmsId])[0];
  check(dq.status === "queued" && Number(dq.attempts) === 0 && dq.failure_reason === null, "requeue moves the dead delivery to queued with attempts reset", JSON.stringify(dq));
  const ra = sql("SELECT actor, detail FROM notification_audit WHERE action = 'requeued' AND actor = ? ORDER BY id DESC LIMIT 1", [editorName])[0];
  check(ra && Number(JSON.parse(ra.detail).delivery_id) === deadSmsId && JSON.parse(ra.detail).previous_status === "dead", "requeue is audited", ra?.detail);
  check(sql("SELECT 1 FROM notification_delivery_events WHERE delivery_id = ? AND event = 'requeued'", [deadSmsId]).length === 1, "requeue writes a delivery event");
  const flash = await (await editor.get(q({ category: AN_CAT }))).text();
  check(/is back in the queue/.test(flash), "requeue confirms on the page");
  r = await editor.post(AN, { _csrf: csrfOf(flash), action: "requeue", delivery_id: String(deadSmsId), category: AN_CAT });
  check(r.status === 303 && /nothing to requeue/.test(await (await editor.get(q({ category: AN_CAT }))).text()), "requeueing a queued delivery explains there is nothing to do");
  r = await editor.post(AN, { _csrf: "bad", action: "requeue", delivery_id: String(seeded.find((d) => d.n === 4 && d.channel === "whatsapp").id) });
  check(r.status === 303 && sql("SELECT status FROM notification_deliveries WHERE id = ?", [seeded.find((d) => d.n === 4 && d.channel === "whatsapp").id])[0]?.status === "dead", "requeue without a valid CSRF token changes nothing");
}

/* ── 5. Devotee tags ───────────────────────────────────────────────────── */
const tagged = fixtures("create-devotee", { email: `e2e-nc-${RUN}-t@example.test`, name: "E2E NC Tagged" });
const UNIQUE_TAG = `e2e-nc:${LETTERS}`;
{
  const DEV = `/admin/devotees.php?edit=${tagged.id}`;
  let page = await (await owner.get(DEV)).text();
  check(!BAD.test(page) && page.includes('id="devotee-tags"') && page.includes('value="tag_add"'), "the edit panel has a tag editor");
  const csrf = csrfOf(page);

  let r = await owner.post(DEV, { _csrf: csrf, action: "tag_add", id: String(tagged.id), tags: `Volunteer, interest:annadanam ${UNIQUE_TAG}` });
  check(r.status === 302 && (r.headers.get("location") || "").includes("#devotee-tags"), "adding tags redirects back to the tag editor", `status ${r.status}`);
  let tags = sql("SELECT tag FROM devotee_tags WHERE devotee_id = ? ORDER BY tag", [tagged.id]).map((t) => t.tag);
  check(JSON.stringify(tags) === JSON.stringify([UNIQUE_TAG, "interest:annadanam", "volunteer"].sort()), "tags are stored lowercase", JSON.stringify(tags));

  r = await owner.post(DEV, { _csrf: csrf, action: "tag_add", id: String(tagged.id), tags: "fine bad!tag" });
  page = await (await owner.get(DEV)).text();
  check(/is not a valid tag/.test(decode(page)) && sql("SELECT COUNT(*) AS n FROM devotee_tags WHERE devotee_id = ?", [tagged.id])[0].n == 3, "an invalid tag is refused and nothing is added");
  r = await owner.post(DEV, { _csrf: csrf, action: "tag_add", id: String(tagged.id), tags: "x".repeat(41) });
  check(sql("SELECT COUNT(*) AS n FROM devotee_tags WHERE devotee_id = ?", [tagged.id])[0].n == 3, "a tag over 40 characters is refused");

  page = await (await owner.get(DEV)).text();
  check(page.includes(`aria-label="Remove the tag ${UNIQUE_TAG}"`) && page.includes('<datalist id="devotee-tag-suggestions">'), "chips have remove buttons and the input has suggestions");

  let list = await (await owner.get(`/admin/devotees.php?tag=${encodeURIComponent(UNIQUE_TAG)}`)).text();
  check(list.includes(`e2e-nc-${RUN}-t@example.test`) && !list.includes(`e2e-nc-${RUN}-a@example.test`) && /1 devotee</.test(list), "?tag= filters the list to tagged devotees");
  check(list.includes('class="devotee-tag-link"') && /<th scope="col">Tags<\/th>/.test(list), "the list has a tags column with tag links");
  list = await (await owner.get(`/admin/devotees.php?tag=e2e-nc:none${LETTERS}`)).text();
  check(!list.includes(`e2e-nc-${RUN}-t@example.test`), "an unused tag matches nobody");

  const csvRes = await owner.get(`/admin/devotees.php?export=csv&tag=${encodeURIComponent(UNIQUE_TAG)}`);
  const csv = (await csvRes.text()).replace(/^﻿/, "");
  const csvLines = csv.split("\n").filter((l) => l.trim());
  check(csvLines[0].endsWith(",tags") && csvLines.length === 2 && csvLines[1].includes("interest:annadanam"), "CSV export follows the tag filter and includes tags", csvLines.join(" | "));

  r = await owner.post(DEV, { _csrf: csrf, action: "tag_remove", id: String(tagged.id), tag: "volunteer" });
  tags = sql("SELECT tag FROM devotee_tags WHERE devotee_id = ? ORDER BY tag", [tagged.id]).map((t) => t.tag);
  check(r.status === 302 && !tags.includes("volunteer") && tags.length === 2, "a tag can be removed", JSON.stringify(tags));
  const acts = sql("SELECT detail FROM admin_activity WHERE action = 'devotee.tags' AND subject = ? ORDER BY id", [`e2e-nc-${RUN}-t@example.test`]);
  check(acts.length === 2 && /Added tags/.test(acts[0].detail) && /Removed tag volunteer/.test(acts[1].detail), "tag changes are audited as devotee.tags", JSON.stringify(acts));

  const vcsrf = await csrfFor(viewer, "/admin/devotees.php");
  r = await viewer.post(DEV, { _csrf: vcsrf, action: "tag_add", id: String(tagged.id), tags: "viewer-tag" });
  check(r.status === 403 && !sql("SELECT 1 FROM devotee_tags WHERE tag = 'viewer-tag'").length, "a viewer cannot tag (403)", `status ${r.status}`);

  // Existing features of the page keep working.
  r = await owner.post(DEV, { _csrf: csrf, action: "save", id: String(tagged.id), name: "E2E NC Renamed", email: `e2e-nc-${RUN}-t@example.test`, phone: "", phone_country: "", country: "IN", city: "Pudupatti", state: "TN", address1: "", address2: "", postcode: "" });
  check(r.status === 302 && sql("SELECT name FROM devotees WHERE id = ?", [tagged.id])[0]?.name === "E2E NC Renamed", "saving devotee details still works");
  r = await owner.post("/admin/devotees.php", { _csrf: csrf, action: "verify", id: String(tagged.id) });
  check(r.status === 302 && sql("SELECT email_verified_at FROM devotees WHERE id = ?", [tagged.id])[0]?.email_verified_at !== null, "marking an email confirmed still works");
  const plain = await owner.get("/admin/devotees.php?status=verified&sort=name&dir=asc");
  check(plain.status === 200 && !BAD.test(await plain.text()), "the devotee list with status and sort still renders");
}

/* ── 6. Browser: accessibility, overflow, chips and live preview ────────── */
{
  const browser = await chromium.launch();
  const url = new URL(base);
  const pages = [
    ["template list", "/admin/notification_templates.php"],
    ["template editor", "/admin/notification_templates.php?key=booking_confirmed&lang=en&channel=sms"],
    ["shared template editor", "/admin/notification_templates.php?key=booking_reminder&lang=ta&channel=any"],
    ["categories", "/admin/notification_templates.php?tab=categories"],
    ["analytics", `/admin/notification_analytics.php?${new URLSearchParams({ category: AN_CAT, from: daysAgo(60), to: today })}`],
    ["devotee tags", `/admin/devotees.php?edit=${tagged.id}`],
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
        check(/^Vanakkam Abhishekam/.test(sms || ""), "the live preview renders the edit with sample values", sms);
        const info = await page.locator('[data-pv="sms-info"]').textContent();
        check(/\d+ characters · 1 segment · GSM-7/.test(info || ""), "the live preview updates the SMS count", info);
        await body.press("End");
        await body.type(" {{nopeVar}}");
        await page.waitForFunction(() => /nopeVar/.test(document.querySelector("[data-ntpl-warnings]")?.textContent || ""), null, { timeout: 8000 }).catch(() => {});
        check(/\{\{nopeVar\}\} is not a variable/.test((await page.locator("[data-ntpl-warnings]").textContent()) || ""), "live warnings flag an unknown variable");
      }
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
}

/* ── Cleanup ───────────────────────────────────────────────────────────── */
cleanup([editorName]);
const leftovers = {
  devotees: sql("SELECT COUNT(*) AS n FROM devotees WHERE email LIKE 'e2e-nc-%'")[0].n,
  notifications: sql("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%E2E-NC%'")[0].n,
  templates: sql("SELECT COUNT(*) AS n FROM notification_templates WHERE body LIKE 'E2E-NC%'")[0].n,
  categories: sql("SELECT COUNT(*) AS n FROM notification_categories WHERE LEFT(`key`, 6) = 'qa_nc_'")[0].n,
  campaigns: sql("SELECT COUNT(*) AS n FROM notification_campaigns WHERE name LIKE 'E2E-NC-%'")[0].n,
  admins: sql("SELECT COUNT(*) AS n FROM admin_users WHERE LEFT(username, 7) = 'e2e_nc_'")[0].n,
  audit: sql("SELECT COUNT(*) AS n FROM notification_audit WHERE detail LIKE ? OR LEFT(actor, 7) = 'e2e_nc_'", [`%${RUN}%`])[0].n,
};
check(Object.values(leftovers).every((n) => Number(n) === 0), "cleanup leaves none of this suite's rows", JSON.stringify(leftovers));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
