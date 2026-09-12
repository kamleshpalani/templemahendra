// Hostile-input probe for the admin: posts over-length strings, huge numbers,
// bad dates and injection-ish payloads at every write handler and fails on any
// 500 / PHP fatal / leaked stack trace.
const base = process.argv[2] || "http://127.0.0.1:8000";
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Deprecated<\/b>)/;
let pass = 0, fail = 0;
const ok = (c, n, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };

let cookie = "";
const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
const get = async (p) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); grab(r); return r; };
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b), redirect: "manual" }); grab(r); return r; };
const csrfOf = (h) => /name="_csrf" value="([^"]+)"/.exec(h)?.[1];

const login = await get("/admin/login.php");
await post("/admin/login.php", { _csrf: csrfOf(await login.text()), username: "admin", password: "Admin@Test123" });

const LONG = "ஃ".repeat(600);          // 600 Tamil chars — past every VARCHAR here
const HUGE = "1e30";
const BIGINT = "99999999999999";
const XSS = '"><script>alert(1)</script>';

const CASES = [
  ["sevas.php",            { action: "save", id: "0", name_ta: LONG, name_en: LONG, description: LONG, amount: HUGE, sort_order: BIGINT, is_featured: "1", is_active: "1" }],
  ["sevas.php",            { action: "save", id: "0", name_ta: "x", name_en: "y", amount: "-5", sort_order: "abc" }],
  ["events.php",           { action: "save", id: "0", title_ta: LONG, title_en: LONG, description: LONG, event_date: "9999-99-99", is_active: "1" }],
  ["announcements.php",    { action: "save", id: "0", title: LONG, body: LONG, is_active: "1" }],
  ["poojas.php",           { action: "save", id: "0", name_ta: LONG, name_en: LONG, pooja_date: "not-a-date", pooja_time: LONG, pooja_type: XSS, description_ta: LONG, description_en: LONG, is_active: "1" }],
  ["sponsors.php",         { action: "save", id: "0", name: LONG, phone: LONG, note: LONG, pooja_id: BIGINT, is_active: "1" }],
  ["homepage_widgets.php", { action: "save", id: "0", content_type: XSS, source_type: XSS, title_ta: LONG, title_en: LONG, description_ta: LONG, description_en: LONG, linked_pooja_id: BIGINT, linked_sponsor_id: BIGINT, start_date: "bad", end_date: "bad", priority: BIGINT, is_pinned: "1", is_active: "1" }],
  ["seva_bookings.php",    { action: "bulk_status", "ids[]": BIGINT, status: XSS }],
  ["seva_bookings.php",    { id: BIGINT, status: "pending" }],
  ["contact_messages.php", { action: "delete", id: BIGINT }],
  ["contact_messages.php", { action: "bulk_delete", "ids[]": "abc" }],
  ["settings.php",         { show_pournami_section: "1", bogus_key: "1" }],
  ["gallery.php",          { action: "delete", id: BIGINT }],
  ["users.php",            { action: "save", id: "0", username: LONG, display_name: LONG, email: LONG, phone: LONG, role: XSS, password: LONG } ],
  ["profile.php",          { action: "details", display_name: LONG, email: LONG, phone: LONG }],
];

for (const [page, body] of CASES) {
  const html = await (await get("/admin/" + page)).text();
  const csrf = csrfOf(html);
  if (!csrf) { console.log(`- ${page}: no form for this account (read-only view) — skipped`); continue; }
  const r = await post("/admin/" + page, { _csrf: csrf, ...body });
  const out = r.status === 303 || r.status === 302 ? "" : await r.text();
  const bad = r.status >= 500 || FATAL.test(out);
  const label = Object.keys(body).slice(0, 3).join(",");
  ok(!bad, `${page} [${label}] survives hostile input`, `status ${r.status}${bad ? " " + (out.match(FATAL)?.[0] ?? "") : ""}`);
  if (bad) {
    const m = out.match(/(SQLSTATE\[[^\]]+\][^<]{0,140}|Uncaught[^<]{0,140})/);
    if (m) console.log("     →", m[0].replace(/\s+/g, " ").slice(0, 170));
  }
}

// XSS reflection check on search params
for (const page of ["sevas.php", "events.php", "donations.php", "contact_messages.php", "seva_bookings.php", "sponsors.php", "poojas.php"]) {
  const r = await get(`/admin/${page}?q=${encodeURIComponent(XSS)}`);
  const html = await r.text();
  ok(!html.includes("<script>alert(1)</script>"), `${page}: search term is escaped`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
