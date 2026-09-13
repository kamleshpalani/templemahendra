#!/usr/bin/env node
/**
 * tests/admin-registrations.mjs — the committee's Family Registrations page
 * (backend/admin/devotees.php, docs/registration/SPEC.md §8), end to end
 * against the real PHP + MySQL stack and a real browser.
 *
 *   PHP_BIN=/path/to/php.sh node tests/admin-registrations.mjs [http://127.0.0.1:8050]
 *
 * Signs in as the environment admin (admin / Admin@Test123) and as an editor and
 * a viewer it creates through admin/users.php and deletes at the end. Requests
 * carry X-Forwarded-For 10.80.0.160–169 (the server must trust 127.0.0.1).
 *
 * What it proves:
 *   1. the KPIs count what the database holds;
 *   2. every filter, the chip counts, sorting, and search on name, email, phone
 *      digits, PIN, tag and family members' names;
 *   3. editing: errors are listed and kept in the form (nothing saved), the PIN
 *      and date of birth rules, members added, changed and removed (zero is
 *      fine, 21 is not), and a consent recorded by the office names the admin
 *      and lifts an unsubscribe;
 *   4. duplicates: merge moves members, tags, a legacy booking and donation link
 *      and a notification to the target and deletes the source; "not a
 *      duplicate" clears the flag; delete; archive and restore;
 *   5. both CSV exports, with a "=cmd" cell neutralised;
 *   6. a viewer reads and exports but every POST is refused; a missing or forged
 *      CSRF token changes nothing; every change is in the activity log;
 *   7. at 390 and 1440 px the list and the edit view have no horizontal
 *      overflow and no serious or critical axe violations, and the "Add
 *      another family member" control adds and removes a row.
 *
 * Creates registrations named "E2E-REG-ADM-<run> …" (with a booking and a
 * donation named the same way) and removes them, their activity entries, its
 * accounts and its rate_limits buckets at the end.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");
const axeSource = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");

const BASE = (process.argv[2] || "http://127.0.0.1:8050").replace(/\/$/, "");
const PHP_BIN = process.env.PHP_BIN || "php";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = Date.now().toString(36);
const PREFIX = `E2E-REG-ADM-${RUN}`;
const PAGE = "/admin/devotees.php";
const EDITOR = "e2e_regadm_editor";
const VIEWER = "e2e_regadm_viewer";
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace|SQLSTATE)/;
const BUCKETS_REGEXP = ":10[.]80[.]0[.]16[0-9]$";

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 700)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);

/* ── PHP and SQL ───────────────────────────────────────────────────────── */
function php(args) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
function fixtures(cmd, obj) {
  const data = JSON.parse(php(["tests/support/notify_fixtures.php", cmd, JSON.stringify(obj)]).trim().split("\n").pop());
  if (data.error) throw new Error(`fixtures ${cmd}: ${data.error}`);
  return data;
}
// No backslashes in statements: Git Bash strips them on the way to php.sh.
const sql = (query, params = []) => fixtures("sql", { query, params });
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;
const reg = (id) => one("SELECT * FROM devotees WHERE id = ?", [id]);
const membersOf = (id) => rows("SELECT id, name, relationship, age, sort_order FROM devotee_family_members WHERE devotee_id = ? ORDER BY sort_order, id", [id]);
const activity = (subject) => rows("SELECT actor, action, subject, detail FROM admin_activity WHERE subject = ? ORDER BY id", [subject]);

/* ── Sessions ──────────────────────────────────────────────────────────── */
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
    async html(path) {
      const r = await this.get(path);
      return { status: r.status, html: await r.text(), headers: r.headers };
    },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
async function login(session, username, password) {
  const page = await session.get("/admin/login.php");
  return session.post("/admin/login.php", [["_csrf", csrfOf(await page.text())], ["username", username], ["password", password], ["next", ""]]);
}
const decode = (s) => s.replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** The Save form for a registration, as the page would post it, with overrides. */
function saveForm(csrf, row, over = {}, members = null) {
  const consent = row.updates_consent_at && !row.unsubscribed_at;
  const fields = {
    _csrf: csrf, action: "save", id: String(row.id), name: row.name, date_of_birth: row.date_of_birth ?? "",
    phone: row.phone ?? "", phone_country: row.phone_country ?? "", email: row.email ?? "", lang: row.lang,
    address1: row.address1 ?? "", address2: row.address2 ?? "", city: row.city ?? "", state: row.state ?? "",
    country: row.country ?? "", postcode: row.postcode ?? "", ...(consent ? { consent: "1" } : {}), ...over,
  };
  const pairs = Object.entries(fields).filter(([, v]) => v !== undefined);
  (members ?? []).forEach((m, i) => {
    pairs.push([`members[${i}][id]`, m.id ? String(m.id) : ""]);
    pairs.push([`members[${i}][name]`, m.name ?? ""]);
    pairs.push([`members[${i}][relationship]`, m.relationship ?? ""]);
    pairs.push([`members[${i}][age]`, m.age === null || m.age === undefined ? "" : String(m.age)]);
    if (m.remove) pairs.push([`members[${i}][remove]`, "1"]);
  });
  return pairs;
}
const existing = (id) => membersOf(id).map((m) => ({ id: m.id, name: m.name, relationship: m.relationship, age: m.age }));
const kpi = (html, label) => {
  const m = new RegExp(`<div class="stat__val">([0-9,]+)</div><div class="stat__label">${label}</div>`).exec(html);
  return m ? Number(m[1].replace(/,/g, "")) : null;
};
const chip = (html, label) => {
  const m = new RegExp(`>${label}<span class="chip__count">([0-9]+)</span>`).exec(html);
  return m ? Number(m[1]) : null;
};

/* ── Cleanup ───────────────────────────────────────────────────────────── */
function cleanupRows(prefixLike) {
  const ids = rows("SELECT id FROM devotees WHERE name LIKE ?", [prefixLike]).map((r) => `Registration #${r.id}`);
  for (const subject of ids) sql("DELETE FROM admin_activity WHERE subject = ?", [subject]);
  sql("DELETE FROM admin_activity WHERE subject LIKE ?", ["e2e-regadm-%"]);
  sql("DELETE FROM seva_bookings WHERE devotee_name LIKE ?", [prefixLike]);
  sql("DELETE FROM donations WHERE name LIKE ?", [prefixLike]);
  sql("DELETE FROM devotees WHERE name LIKE ?", [prefixLike]);
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [BUCKETS_REGEXP]);
}
async function deleteAccounts(owner) {
  const { html } = await owner.html("/admin/users.php");
  const ids = html.split("<tr")
    .filter((row) => new RegExp(`class="cell-sub">(${EDITOR}|${VIEWER})\\b`).test(row))
    .map((row) => /users\.php\?edit=(\d+)/.exec(row)?.[1])
    .filter(Boolean);
  for (const id of ids) await owner.post("/admin/users.php", [["_csrf", csrfOf(html)], ["action", "delete"], ["id", id]]);
  sql("DELETE FROM admin_activity WHERE actor IN (?, ?) OR subject IN (?, ?)", [EDITOR, VIEWER, EDITOR, VIEWER]);
}

const probe = await fetch(`${BASE}/api/pulse`).catch(() => null);
if (!probe || !probe.ok) {
  console.log(`✗ no backend at ${BASE}. Start one with serve.sh 8050.`);
  process.exit(1);
}
cleanupRows("E2E-REG-ADM-%");

const owner = jar("10.80.0.160");
let browser = null;
try {
  let r = await login(owner, "admin", "Admin@Test123");
  check(r.status === 302, "the environment admin signs in", `status ${r.status}`);
  await deleteAccounts(owner);

  /* ── Fixtures ────────────────────────────────────────────────────────── */
  const digits = String(Math.floor(Math.random() * 90000) + 10000);
  const phoneA = `9198${digits}01`;
  const phoneC = `9198${digits}03`;
  const memberKey = `Kavya${RUN}`;
  const mk = (args) => fixtures("create-devotee", args).id;
  const A = mk({ name: `${PREFIX} Anbu`, phone: phoneA, email: `e2e-regadm-anbu-${RUN}@example.test`, city: "Tenkasi", postcode: "627811",
    address1: "5 Temple Car Street", consent: true, members: [{ name: memberKey, relationship: "spouse", age: 40 }, { name: "Ravi", relationship: "son", age: 12 }] });
  const B = mk({ name: `${PREFIX} Bala`, phone: phoneA, phoneCountry: "SG", email: `e2e-regadm-bala-${RUN}@example.test`, country: "SG", state: null, city: "Singapore",
    postcode: null, lang: "en", members: [{ name: "Bala Wife", relationship: "spouse", age: 38 }] });
  const C = mk({ name: `${PREFIX} Chitra`, phone: phoneC, consent: true, unsubscribed: true, postcode: "627719", members: [{ name: "Murugan", relationship: "father", age: 70 }] });
  const D = mk({ name: `${PREFIX} Devi`, phone: `9198${digits}04`, consent: true, active: false, postcode: "627719" });
  sql("UPDATE devotees SET date_of_birth = ? WHERE id = ?", ["1980-01-15", A]);
  sql("UPDATE devotees SET duplicate_of = ? WHERE id = ?", [A, B]);
  sql("INSERT INTO devotee_tags (devotee_id, tag, created_by) VALUES (?, ?, 'e2e')", [B, `e2e-regadm-${RUN}`]);
  sql("INSERT INTO seva_bookings (devotee_name, phone, seva_name, devotee_id) VALUES (?, ?, 'Archana', ?)", [`${PREFIX} booking`, phoneA, B]);
  sql("INSERT INTO donations (name, phone, amount, purpose, devotee_id) VALUES (?, ?, 101, 'other', ?)", [`${PREFIX} donation`, phoneA, B]);
  sql("INSERT INTO notifications (devotee_id, recipient_type, lang, template_key, event, category, title, body, created_by) VALUES (?, 'devotee', 'en', 'e2e_regadm', 'e2e.regadm', 'general', ?, 'E2E body', 'system')", [B, `${PREFIX} message`]);

  /* ── 1. KPIs ─────────────────────────────────────────────────────────── */
  section("1. KPIs");
  const counts = () => one(`SELECT COALESCE(SUM(is_active = 1), 0) AS families, COALESCE(SUM(is_active = 1 AND duplicate_of IS NOT NULL), 0) AS duplicates,
    COALESCE(SUM(is_active = 1 AND updates_consent_at IS NOT NULL AND unsubscribed_at IS NULL), 0) AS consented,
    COALESCE(SUM(created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0) AS recent,
    (SELECT COUNT(*) FROM devotee_family_members m JOIN devotees d ON d.id = m.devotee_id AND d.is_active = 1) AS members FROM devotees`);
  const before = counts();
  let page = await owner.html(PAGE);
  const after = counts();
  check(page.status === 200 && !BAD.test(page.html) && page.html.includes("<title>Family Registrations — Temple Admin</title>"), "the list renders as Family Registrations", `status ${page.status}`);
  const within = (v, key) => v !== null && v >= Math.min(Number(before[key]), Number(after[key])) && v <= Math.max(Number(before[key]), Number(after[key]));
  check(within(kpi(page.html, "Families"), "families"), "Families counts active registrations", `${kpi(page.html, "Families")} vs ${before.families}`);
  check(within(kpi(page.html, "Family members"), "members"), "Family members counts members of active registrations", `${kpi(page.html, "Family members")} vs ${before.members}`);
  check(within(kpi(page.html, "Possible duplicates"), "duplicates"), "Possible duplicates counts flagged registrations", `${kpi(page.html, "Possible duplicates")} vs ${before.duplicates}`);
  check(within(kpi(page.html, "Agreed to updates"), "consented"), "Agreed to updates counts consent in force", `${kpi(page.html, "Agreed to updates")} vs ${before.consented}`);
  check(within(kpi(page.html, "Registered in the last 30 days"), "recent"), "Registered in the last 30 days", `${kpi(page.html, "Registered in the last 30 days")} vs ${before.recent}`);
  // The page's own content, without the admin shell (whose account menu says "Signed in as").
  const mainOf = (html) => (/<main[^>]*id="admin-content"[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "").replace(/<script[\s\S]*?<\/script>/g, "");
  check(mainOf(page.html) !== "" && !/password|email confirmation|confirmed|signed in|sign-up|last login/i.test(mainOf(page.html)), "no password, confirmation or sign-in wording anywhere on the list");
  const dash = await owner.html("/admin/");
  check(dash.status === 200 && !BAD.test(dash.html) && kpi(dash.html, "Registered families") !== null && kpi(dash.html, "Possible duplicates") !== null,
    "the dashboard shows Registered families and Possible duplicates");
  check(dash.html.includes(">Family Registrations<") && dash.html.includes("Possible duplicate registrations") && dash.html.includes("Export families CSV")
    && !dash.html.includes("Devotees awaiting confirmation") && !dash.html.includes("Devotee Accounts"),
    "the navigation and palette name Family Registrations and its two quick actions");

  /* ── 2. Filters and search ───────────────────────────────────────────── */
  section("2. filters and search");
  const names = { A: `${PREFIX} Anbu`, B: `${PREFIX} Bala`, C: `${PREFIX} Chitra`, D: `${PREFIX} Devi` };
  const listed = (html) => Object.entries(names).filter(([, n]) => html.includes(`>${n}</a>`)).map(([k]) => k).join("");
  const q = encodeURIComponent(PREFIX);
  page = await owner.html(`${PAGE}?q=${q}`);
  check(listed(page.html) === "ABCD", "All lists every registration, archived included", listed(page.html));
  check(/>4 registrations</.test(page.html), "and counts them");
  check(chip(page.html, "All") === 4 && chip(page.html, "Possible duplicates") === 1 && chip(page.html, "Agreed to updates") === 1 && chip(page.html, "No consent") === 2 && chip(page.html, "Archived") === 1,
    "the chips count what each would list under the search", ["All", "Possible duplicates", "Agreed to updates", "No consent", "Archived"].map((l) => chip(page.html, l)).join(","));
  for (const [status, expect] of [["duplicates", "B"], ["consented", "A"], ["no_consent", "BC"], ["archived", "D"]]) {
    page = await owner.html(`${PAGE}?q=${q}&status=${status}`);
    check(page.status === 200 && listed(page.html) === expect, `status=${status} lists ${expect}`, listed(page.html));
  }
  page = await owner.html(`${PAGE}?q=${q}&country=SG`);
  check(listed(page.html) === "B", "the country filter", listed(page.html));
  page = await owner.html(`${PAGE}?tag=${encodeURIComponent(`e2e-regadm-${RUN}`)}`);
  check(listed(page.html) === "B" && page.html.includes('class="devotee-tag-link"'), "the tag filter", listed(page.html));
  for (const [label, term, expect] of [["a family member's name", memberKey, "A"], ["phone digits", phoneC.slice(-6), "C"], ["a PIN typed with a space", "627 811", "A"],
    ["an email", `e2e-regadm-bala-${RUN}`, "B"], ["a town", "Singapore", "B"], ["an address", "Temple Car", "A"]]) {
    page = await owner.html(`${PAGE}?q=${encodeURIComponent(term)}`);
    check(listed(page.html).includes(expect) && listed(page.html).length === 1, `search on ${label} finds ${expect}`, listed(page.html));
  }
  page = await owner.html(`${PAGE}?q=${q}&sort=name&dir=asc`);
  const order = (html) => Object.entries(names).map(([k, n]) => [k, html.indexOf(`>${n}</a>`)]).sort((x, y) => x[1] - y[1]).map(([k]) => k).join("");
  check(order(page.html) === "ABCD", "sort by name, ascending", order(page.html));
  page = await owner.html(`${PAGE}?q=${q}&sort=name&dir=desc`);
  check(order(page.html) === "DCBA", "sort by name, descending", order(page.html));
  page = await owner.html(`${PAGE}?q=${q}&sort=created_at&dir=asc`);
  check(order(page.html) === "ABCD" && page.status === 200, "sort by date", order(page.html));
  page = await owner.html(`${PAGE}?q=${encodeURIComponent('"><script>alert(1)</script>')}&status[]=x&country=${encodeURIComponent("<b>")}&edit[]=1`);
  check(page.status === 200 && !page.html.includes("<script>alert(1)</script>") && !BAD.test(page.html), "hostile filter values are escaped or ignored");
  page = await owner.html(`${PAGE}?q=${q}`);
  check(page.html.includes("2 members") && page.html.includes(memberKey) && page.html.includes("No members added") && page.html.includes("Possible duplicate of #" + A),
    "a row shows the family's size, first names, and the duplicate badge");
  check(page.html.includes("Age ") && page.html.includes("Writes in English"), "a row shows the registrant's age and language");

  /* ── 3. Editing ──────────────────────────────────────────────────────── */
  section("3. the edit view");
  page = await owner.html(`${PAGE}?edit=${A}`);
  let csrf = csrfOf(page.html);
  check(page.status === 200 && !BAD.test(page.html) && page.html.includes("Edit registration") && page.html.includes(`value="${memberKey}"`), "the edit view shows the registration and its members");
  check(page.html.includes('id="duplicates"') && page.html.includes(`Merge into #${B}`), "the duplicates panel lists the registration with the same phone");
  check(page.html.includes("Agreed on the registration form on") && page.html.includes('id="devotee-tags"'), "consent is explained and the tags editor is kept");
  check(!/gender/i.test(page.html) && !/password/i.test(page.html.replace(/<script[\s\S]*?<\/script>/g, "")), "no gender field and no password text");

  const rowA = reg(A);
  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrf, rowA, { name: "", email: "not-an-email", address1: "5 Temple Car Street X", postcode: "" },
    [{ ...existing(A)[0], age: "abc" }, existing(A)[1]]));
  let html = await r.text();
  check(r.status === 422, "a Save with errors answers 422", `status ${r.status}`);
  check(html.includes('id="reg-errors"') && html.includes('href="#d-name"') && html.includes('href="#d-email"') && html.includes('href="#d-postcode"') && html.includes('href="#m-0-age"'),
    "the error summary links to every problem");
  check(/<input id="d-name"[^>]*aria-invalid="true"/.test(html) && /<input id="m-0-age"[^>]*aria-invalid="true"/.test(html), "the fields in error are marked invalid");
  check(html.includes('value="5 Temple Car Street X"') && html.includes('value="not-an-email"') && /<input id="m-0-age"[^>]*value="abc"/.test(html),
    "what was typed is kept in the form");
  check(reg(A).name === names.A && reg(A).address1 === "5 Temple Car Street" && Number(membersOf(A)[0].age) === 40, "and nothing was saved");

  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrf, rowA, { postcode: "62781" }));
  html = await r.text();
  check(r.status === 422 && html.includes('href="#d-postcode"') && decode(html).includes("A PIN code is 6 digits"), "an Indian address needs a 6-digit PIN");
  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrf, rowA, { date_of_birth: "2999-01-01" }));
  check(r.status === 422 && (await r.text()).includes('href="#d-dob"'), "a date of birth in the future is refused");
  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrf, rowA, {}, [...existing(A), ...Array.from({ length: 19 }, (_, i) => ({ name: `Extra ${i + 1}`, relationship: "other_relative", age: "" }))]));
  check(r.status === 422 && (await r.text()).includes('href="#d-members"') && membersOf(A).length === 2, "21 family members are refused");

  const [kav, ravi] = existing(A);
  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrf, rowA, { name: `${names.A} Renamed`, date_of_birth: "", email: "", lang: "en" },
    [{ ...kav, age: 41 }, { ...ravi, remove: true }, { name: `Selvi${RUN}`, relationship: "daughter", age: 8 }, { name: "", relationship: "", age: "" }]));
  check(r.status === 302 && (r.headers.get("location") || "").includes(`edit=${A}`), "a valid Save redirects back to the registration", `status ${r.status}`);
  names.A = `${names.A} Renamed`;
  let a = reg(A);
  check(a.name === names.A && a.date_of_birth === null && a.email === null && a.lang === "en", "details are saved: date of birth and email are optional", JSON.stringify({ n: a.name, d: a.date_of_birth, e: a.email, l: a.lang }));
  let fam = membersOf(A);
  check(fam.length === 2 && fam[0].name === memberKey && Number(fam[0].age) === 41 && Number(fam[0].sort_order) === 0 && fam[1].name === `Selvi${RUN}` && fam[1].relationship === "daughter" && Number(fam[1].sort_order) === 1,
    "a member is changed, one removed, one added (the blank row is ignored)", JSON.stringify(fam));
  let log = activity(`Registration #${A}`);
  check(log.some((x) => x.action === "registration.update" && x.actor === "admin" && /name/.test(x.detail)) && log.some((x) => x.action === "registration.members" && /added Selvi/i.test(x.detail) && /updated Kavya/i.test(x.detail) && /removed Ravi/i.test(x.detail)),
    "the change and the members are in the activity log", JSON.stringify(log));
  page = await owner.html(`${PAGE}?edit=${A}`);
  check(decode(page.html).includes(`Saved ${names.A}.`), "the office is told what was saved");
  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrfOf(page.html), reg(A), { date_of_birth: "1979-06-30" }, existing(A)));
  check(r.status === 302 && reg(A).date_of_birth === "1979-06-30", "a date of birth can be given later");

  section("3b. consent recorded by the office");
  let c = reg(C);
  page = await owner.html(`${PAGE}?edit=${C}`);
  csrf = csrfOf(page.html);
  check(page.html.includes("Withdrawn from a link in a message on") && page.html.includes("Unsubscribed"), "an unsubscribe is shown with its date");
  r = await owner.post(`${PAGE}?edit=${C}`, saveForm(csrf, c, {}, existing(C)));
  const cAfterUntouched = reg(C);
  check(r.status === 302 && cAfterUntouched.unsubscribed_at === c.unsubscribed_at && cAfterUntouched.updates_consent_at === c.updates_consent_at, "saving it unticked leaves the unsubscribe as it was");
  r = await owner.post(`${PAGE}?edit=${C}`, saveForm(csrf, c, { consent: "1" }, existing(C)));
  c = reg(C);
  check(r.status === 302 && c.updates_consent_by === "admin" && c.unsubscribed_at === null && c.updates_consent_at !== null && c.updates_consent_at !== cAfterUntouched.updates_consent_at,
    "ticking consent records it in the admin's name and clears the unsubscribe", JSON.stringify({ by: c.updates_consent_by, at: c.updates_consent_at, un: c.unsubscribed_at }));
  check(activity(`Registration #${C}`).some((x) => x.action === "registration.consent" && /Recorded consent/.test(x.detail)), "recording consent is logged");
  page = await owner.html(`${PAGE}?edit=${C}`);
  check(page.html.includes("Recorded by admin on"), "and the page says who recorded it");
  r = await owner.post(`${PAGE}?edit=${C}`, saveForm(csrfOf(page.html), c, { consent: undefined }, existing(C)));
  c = reg(C);
  check(r.status === 302 && c.updates_consent_at === null && c.updates_consent_by === null, "unticking withdraws it");
  check(activity(`Registration #${C}`).some((x) => x.action === "registration.consent" && /Withdrew consent/.test(x.detail)), "withdrawing is logged");

  /* ── 4. Duplicates, delete, archive ──────────────────────────────────── */
  section("4. merge");
  page = await owner.html(`${PAGE}?edit=${B}`);
  csrf = csrfOf(page.html);
  check(page.html.includes(`Flagged as a possible duplicate of registration #${A}`) && page.html.includes(`value="not_duplicate"`), "the flagged registration explains the flag and offers Not a duplicate");
  const targetMembersBefore = membersOf(A).length;
  r = await owner.post(`${PAGE}?edit=${B}`, [["_csrf", csrf], ["action", "merge"], ["id", String(B)], ["target", String(A)], ["fill_empty", "1"]]);
  check(r.status === 302 && (r.headers.get("location") || "").includes(`edit=${A}`), "merge redirects to the registration kept", `status ${r.status} ${r.headers.get("location")}`);
  check(reg(B) === null, "the merged registration is deleted");
  fam = membersOf(A);
  check(fam.length === targetMembersBefore + 1 && fam[fam.length - 1].name === "Bala Wife" && Number(fam[fam.length - 1].sort_order) >= targetMembersBefore, "its member joins the target's family, after its own", JSON.stringify(fam));
  check(Number(one("SELECT COUNT(*) AS c FROM devotee_tags WHERE devotee_id = ? AND tag = ?", [A, `e2e-regadm-${RUN}`]).c) === 1, "its tag moves");
  check(Number(one("SELECT devotee_id FROM seva_bookings WHERE devotee_name = ?", [`${PREFIX} booking`])?.devotee_id) === A, "its legacy booking link moves");
  check(Number(one("SELECT devotee_id FROM donations WHERE name = ?", [`${PREFIX} donation`])?.devotee_id) === A, "its legacy donation link moves");
  check(Number(one("SELECT devotee_id FROM notifications WHERE title = ?", [`${PREFIX} message`])?.devotee_id) === A, "its notification history moves");
  a = reg(A);
  check(a.email === `e2e-regadm-bala-${RUN}@example.test` && a.city === "Tenkasi", "ticked, the target's empty email is filled while its own details are kept", `${a.email} ${a.city}`);
  check(activity(`Registration #${A}`).some((x) => x.action === "registration.merge" && x.detail.includes(`#${B}`) && /1 family member/.test(x.detail)), "the merge is logged against the registration kept");
  page = await owner.html(`${PAGE}?edit=${A}`);
  check(/Merged .* into registration #/.test(decode(page.html)), "the office is told what moved");

  section("4b. zero members, not a duplicate, delete, archive and restore");
  r = await owner.post(`${PAGE}?edit=${A}`, saveForm(csrfOf(page.html), reg(A), {}, existing(A).map((m) => ({ ...m, remove: true }))));
  check(r.status === 302 && membersOf(A).length === 0, "every member can be removed: a registration of one is complete");
  page = await owner.html(`${PAGE}?edit=${A}`);
  check(page.html.includes("The registrant only; no family members added"), "and the page says so");

  const E = mk({ name: `${PREFIX} Elango`, phone: phoneC, postcode: "627719", members: [{ name: "Elango Son", relationship: "son" }] });
  sql("UPDATE devotees SET duplicate_of = ? WHERE id = ?", [C, E]);
  page = await owner.html(`${PAGE}?edit=${E}`);
  csrf = csrfOf(page.html);
  r = await owner.post(`${PAGE}?edit=${E}`, [["_csrf", csrf], ["action", "not_duplicate"], ["id", String(E)]]);
  check(r.status === 302 && reg(E).duplicate_of === null, "Not a duplicate clears the flag");
  check(activity(`Registration #${E}`).some((x) => x.action === "registration.not_duplicate"), "and is logged");
  r = await owner.post(`${PAGE}?edit=${E}`, [["_csrf", csrf], ["action", "delete"], ["id", String(E)]]);
  check(r.status === 302 && reg(E) === null && Number(one("SELECT COUNT(*) AS c FROM devotee_family_members WHERE devotee_id = ?", [E]).c) === 0, "Delete removes the registration and its members");
  check(activity(`Registration #${E}`).some((x) => x.action === "registration.delete" && /1 family member/.test(x.detail)), "and is logged");
  r = await owner.post(`${PAGE}?q=${q}`, [["_csrf", csrf], ["action", "archive"], ["id", String(C)], ["return", "list"]]);
  check(r.status === 302 && Number(reg(C).is_active) === 0 && !(r.headers.get("location") || "").includes("edit="), "Archive from the list keeps the registration and returns to the list");
  r = await owner.post(`${PAGE}?edit=${C}`, [["_csrf", csrf], ["action", "restore"], ["id", String(C)]]);
  check(r.status === 302 && Number(reg(C).is_active) === 1, "Restore brings it back");
  const cLog = activity(`Registration #${C}`).map((x) => x.action);
  check(cLog.includes("registration.archive") && cLog.includes("registration.restore"), "both are logged", cLog.join(","));
  r = await owner.post(PAGE, [["_csrf", csrf], ["action", "archive"], ["id", "99999999"]]);
  check(r.status === 302, "an action on a registration that does not exist is refused politely");
  r = await owner.post(`${PAGE}?edit=${A}`, [["_csrf", csrf], ["action", "merge"], ["id", String(A)], ["target", String(A)]]);
  page = await owner.html(`${PAGE}?edit=${A}`);
  check(r.status === 302 && reg(A) && decode(page.html).includes("cannot be merged into itself"), "a registration cannot be merged into itself");

  /* ── 5. CSV ──────────────────────────────────────────────────────────── */
  section("5. CSV exports");
  const F = mk({ name: `${PREFIX} Formula`, phone: `9198${digits}06`, address2: "@SUM(1+1)", postcode: "627719", members: [{ name: "=cmd|' /C calc'!A0", relationship: "son", age: 9 }] });
  const parseCsv = (text) => text.replace(/^﻿/, "").trim().split(/\r?\n/);
  let res = await owner.get(`${PAGE}?export=csv&q=${q}`);
  let csv = await res.text();
  let lines = parseCsv(csv);
  const head = lines[0].split(",");
  check(res.status === 200 && /text\/csv/.test(res.headers.get("content-type") || "") && /family-registrations-/.test(res.headers.get("content-disposition") || ""), "the families CSV downloads");
  check(["date_of_birth", "lang", "consent", "duplicate_of", "member_count", "members"].every((c) => head.includes(c)) && head[head.length - 1] === "tags", "it has date_of_birth, lang, consent, duplicate_of, member_count, members (and tags last)", lines[0]);
  check(!/pass_hash|email_verified|last_login|verification/i.test(lines[0]), "and no password, verification or last-login columns");
  // After the merge and the delete: Anbu, Chitra, Devi and Formula, under one header.
  check(lines.length === 5 && csv.includes(names.A) && csv.includes(names.C) && csv.includes(names.D) && csv.includes("Formula") && !csv.includes(names.B), "it follows the search filter", `${lines.length} lines`);
  check(csv.includes(`"'=cmd|' /C calc'!A0 (Son, 9)"`) && csv.includes("'@SUM(1+1)"), "cells starting = or @ are neutralised with an apostrophe");
  res = await owner.get(`${PAGE}?export=members_csv&q=${q}`);
  csv = await res.text();
  lines = parseCsv(csv);
  check(res.status === 200 && /family-members-/.test(res.headers.get("content-disposition") || "") && lines[0] === "registration_id,registrant,registrant_phone,member_position,member_name,relationship,relationship_en,relationship_ta,age",
    "the members CSV downloads with one row per member", lines[0]);
  check(csv.includes(`"'=cmd|' /C calc'!A0"`) && csv.includes("மகன்"), "its formula cell is neutralised and Tamil survives");

  /* ── 6. Roles and CSRF ───────────────────────────────────────────────── */
  section("6. editor, viewer and CSRF");
  let users = await owner.html("/admin/users.php");
  for (const [username, role] of [[EDITOR, "editor"], [VIEWER, "viewer"]]) {
    r = await owner.post("/admin/users.php", [["_csrf", csrfOf(users.html)], ["action", "save"], ["id", "0"], ["username", username], ["display_name", `E2E Reg ${role}`],
      ["email", ""], ["phone", ""], ["role", role], ["password", "Kolam99Deep"], ["is_active", "1"]]);
    check(r.status === 303, `the owner creates the ${role} account`, `status ${r.status}`);
    users = await owner.html("/admin/users.php");
  }
  const signIn = async (username, xff, newPassword) => {
    const s = jar(xff);
    await login(s, username, "Kolam99Deep");
    const prof = await s.html("/admin/profile.php");
    await s.post("/admin/profile.php", [["_csrf", csrfOf(prof.html)], ["action", "password"], ["current_password", "Kolam99Deep"], ["new_password", newPassword], ["confirm_password", newPassword]]);
    return s;
  };
  const editor = await signIn(EDITOR, "10.80.0.161", "Vilakku42Raja");
  page = await editor.html(`${PAGE}?edit=${C}`);
  check(page.status === 200 && page.html.includes("Save registration"), "the editor can open a registration to edit", `status ${page.status}`);
  r = await editor.post(`${PAGE}?edit=${C}`, saveForm(csrfOf(page.html), reg(C), { city: "Sankarankovil" }, existing(C)));
  check(r.status === 302 && reg(C).city === "Sankarankovil", "the editor can save a change");
  check(activity(`Registration #${C}`).some((x) => x.actor === EDITOR && x.action === "registration.update"), "logged in the editor's name");

  const viewer = await signIn(VIEWER, "10.80.0.162", "QuietWatch42B");
  page = await viewer.html(`${PAGE}?q=${q}`);
  check(page.status === 200 && page.html.includes("View details") && !page.html.includes("Open and edit") && !page.html.includes('value="archive"'), "the viewer reads the list with no change actions");
  const vEdit = await viewer.html(`${PAGE}?edit=${A}`);
  check(vEdit.status === 200 && vEdit.html.includes("Registration details") && vEdit.html.includes("<fieldset disabled>") && !vEdit.html.includes("Save registration")
    && !vEdit.html.includes('value="merge"') && !vEdit.html.includes('value="tag_add"') && !vEdit.html.includes("data-repeat-add"), "the viewer's registration view is read-only");
  res = await viewer.get(`${PAGE}?export=csv&q=${q}`);
  check(res.status === 200 && /text\/csv/.test(res.headers.get("content-type") || ""), "the viewer can export the families CSV");
  res = await viewer.get(`${PAGE}?export=members_csv&q=${q}`);
  check(res.status === 200 && /text\/csv/.test(res.headers.get("content-type") || ""), "and the members CSV");
  const vcsrf = csrfOf(vEdit.html);
  const cBefore = JSON.stringify(reg(C));
  const aBefore = JSON.stringify(reg(A));
  for (const [label, pairs] of [
    ["save", saveForm(vcsrf, reg(C), { city: "Viewer Town" })],
    ["archive", [["_csrf", vcsrf], ["action", "archive"], ["id", String(C)]]],
    ["delete", [["_csrf", vcsrf], ["action", "delete"], ["id", String(C)]]],
    ["merge", [["_csrf", vcsrf], ["action", "merge"], ["id", String(C)], ["target", String(A)]]],
    ["not_duplicate", [["_csrf", vcsrf], ["action", "not_duplicate"], ["id", String(C)]]],
    ["tag_add", [["_csrf", vcsrf], ["action", "tag_add"], ["id", String(C)], ["tags", "viewer-tag"]]],
  ]) {
    r = await viewer.post(`${PAGE}?edit=${C}`, pairs);
    check(r.status === 403, `the viewer's ${label} is refused with 403`, `status ${r.status}`);
  }
  check(JSON.stringify(reg(C)) === cBefore && JSON.stringify(reg(A)) === aBefore, "and nothing changed");
  check(!rows("SELECT actor FROM admin_activity WHERE actor = ? AND action LIKE 'registration.%'", [VIEWER]).length, "nothing was logged for the viewer");

  page = await owner.html(`${PAGE}?edit=${C}`);
  r = await owner.post(`${PAGE}?edit=${C}`, saveForm("", reg(C), { city: "No Token Town" }).filter(([k]) => k !== "_csrf"));
  html = await r.text();
  check(r.status === 403 && reg(C).city === "Sankarankovil" && /session expired|tampered/i.test(html), "a Save with no CSRF token is refused and changes nothing", `status ${r.status}`);
  r = await owner.post(`${PAGE}?edit=${C}`, [["_csrf", "forged"], ["action", "delete"], ["id", String(C)]]);
  check(r.status === 403 && reg(C) !== null, "a Delete with a forged token is refused");

  /* ── 7. Browser ──────────────────────────────────────────────────────── */
  section("7. browser: overflow, accessibility and the member rows");
  browser = await chromium.launch();
  const origin = new URL(BASE).origin;
  const axe = async (p) => {
    await p.addScriptTag({ content: axeSource });
    return p.evaluate(async () => {
      const out = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "best-practice"] } });
      return out.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]} — ${v.help}`);
    });
  };
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  // Give the edit view a family again, with a duplicate beside it, so every panel is on screen.
  const G = mk({ name: `${PREFIX} Ganesh`, phone: phoneC, postcode: "627719", consent: true, members: [{ name: "Ganesh Wife", relationship: "spouse", age: 35 }, { name: "Ganesh Son", relationship: "son", age: 6 }] });
  sql("UPDATE devotees SET duplicate_of = ?, date_of_birth = '1985-03-02' WHERE id = ?", [C, G]);
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    // X-Forwarded-For only to our own server; sent to Google Fonts it would fail their CORS preflight.
    await ctx.route((u) => u.origin === origin, (route) => route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": "10.80.0.163" } }));
    const p = await ctx.newPage();
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|favicon|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await p.goto(BASE + "/admin/login.php");
    await p.fill("#username", "admin");
    await p.fill("#password", "Admin@Test123");
    await Promise.all([p.waitForURL(/\/admin\/(?!login)/), p.press("#password", "Enter")]);
    for (const [label, path] of [["list", `${PAGE}?q=${q}`], ["edit view", `${PAGE}?edit=${G}`]]) {
      await p.goto(BASE + path, { waitUntil: "load" });
      await p.waitForTimeout(600);
      check(!(await overflow(p)), `${label} @${width}: no horizontal overflow`);
      const v = await axe(p);
      check(v.length === 0, `${label} @${width}: no serious or critical axe violations`, v.slice(0, 5).join("\n      "));
    }
    if (width === 1440) {
      const rowsNow = () => p.locator('[data-repeat-list="members"] > li').count();
      const start = await rowsNow();
      const add = p.locator('[data-repeat-add="members"]');
      check(await add.isVisible(), "the Add another family member button appears with JavaScript");
      await add.click();
      check((await rowsNow()) === start + 1, "it adds a row", `${start} → ${await rowsNow()}`);
      const focused = await p.evaluate(() => document.activeElement?.id || "");
      check(/^m-\d+-name$/.test(focused), "and moves focus to the new name field", focused);
      await p.waitForTimeout(150);
      const announced = ((await p.locator('[data-repeat-status="members"]').textContent()) || "").trim();
      check(announced === "Added a row for a new family member.", "and announces it politely", announced);
      await p.fill(`#${focused}`, `Browser${RUN}`);
      await p.selectOption(`#${focused.replace("-name", "-relationship")}`, "daughter");
      await p.locator('[data-repeat-list="members"] > li').last().locator("[data-repeat-remove]").click();
      check((await rowsNow()) === start, "Remove this row takes it away again");
      await add.click();
      const second = await p.evaluate(() => document.activeElement?.id || "");
      await p.fill(`#${second}`, `Browser${RUN}`);
      await p.selectOption(`#${second.replace("-name", "-relationship")}`, "daughter");
      await Promise.all([p.waitForURL(/edit=/), p.click("button:has-text('Save registration')")]);
      check(membersOf(G).some((m) => m.name === `Browser${RUN}` && m.relationship === "daughter"), "a member added in the browser is saved", JSON.stringify(membersOf(G)));
      await p.fill("#d-name", "");
      await p.click("button:has-text('Save registration')");
      await p.waitForSelector("#reg-errors");
      const focusIsSummary = await p.evaluate(() => document.activeElement?.id === "reg-errors");
      check(focusIsSummary, "after a Save with errors the summary receives focus");
      const v = await axe(p);
      check(v.length === 0 && !(await overflow(p)), "the form with errors has no serious axe violations and no overflow", v.slice(0, 5).join("\n      "));
    }
    check(errors.length === 0, `@${width}: no script errors`, errors.slice(0, 3).join(" | "));
    await ctx.close();
  }
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  try {
    await deleteAccounts(owner);
    cleanupRows(`${PREFIX}%`);
    const left = one("SELECT (SELECT COUNT(*) FROM devotees WHERE name LIKE ?) + (SELECT COUNT(*) FROM seva_bookings WHERE devotee_name LIKE ?) + (SELECT COUNT(*) FROM donations WHERE name LIKE ?) + (SELECT COUNT(*) FROM admin_users WHERE username IN (?, ?)) + (SELECT COUNT(*) FROM rate_limits WHERE bucket REGEXP ?) AS c",
      [`${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, EDITOR, VIEWER, BUCKETS_REGEXP]).c;
    check(Number(left) === 0, "cleanup removed every row, account and bucket this suite created", `${left} left`);
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
