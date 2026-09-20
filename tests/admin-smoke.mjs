// Admin smoke test: logs in and fetches every admin page, failing on PHP
// warnings/fatals or non-200 responses.
//   node admin-smoke.mjs http://127.0.0.1:8000 [page.php ...]
// Set SMOKE_XFF to give this run its own X-Forwarded-For (the servers trust it
// from 127.0.0.1), so parallel suites never share rate-limit buckets.
const base = process.argv[2] || "http://127.0.0.1:8000";
const only = process.argv.slice(3);
const PAGES = only.length
  ? only
  : ["", "homepage_widgets.php", "announcements.php", "gallery.php", "poojas.php", "sevas.php", "events.php", "sponsors.php",
     // Family Registrations: the list, a filter with a sort, and an unknown registration id.
     "devotees.php", "devotees.php?status=duplicates&sort=name&dir=asc", "devotees.php?edit=999999999",
     "seva_bookings.php", "donations.php", "contact_messages.php",
     "notifications.php", "notification_templates.php", "notification_segments.php", "notification_analytics.php",
     // Online payments (docs/payments/SPEC.md §10): every tab, the gateway settings and the categories.
     "payments.php", "payments.php?view=transactions", "payments.php?view=refunds", "payments.php?view=reconcile",
     "payments.php?number=DON-20990101-00000001", "payment_settings.php", "donation_categories.php",
     // Live Darshan (docs/live/SPEC-PHASE1.md §4.5): the list, the live chip and an unknown stream id.
     "live_streams.php", "live_streams.php?f=live", "live_streams.php?edit=999999999",
     "videos.php", "videos.php?f=featured&q=pournami", "videos.php?edit=999999999", "deities.php",
     "bulk_upload.php", "settings.php", "users.php", "profile.php"];
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught|Stack trace)/;
const XFF = process.env.SMOKE_XFF ? { "X-Forwarded-For": process.env.SMOKE_XFF } : {};

let cookie = "";
const grabCookie = (res) => {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const m = /^(PHPSESSID=[^;]+)/.exec(c);
    if (m) cookie = m[1];
  }
};
const get = async (path) => {
  const res = await fetch(base + path, { headers: { cookie, ...XFF }, redirect: "manual" });
  grabCookie(res);
  return res;
};

let failures = 0;
const login = await get("/admin/login.php");
const loginHtml = await login.text();
const csrf = /name="_csrf" value="([^"]+)"/.exec(loginHtml)?.[1];
if (!csrf) { console.log("✗ login page: no CSRF token"); process.exit(1); }
if (BAD.test(loginHtml)) { console.log("✗ login page has PHP errors"); failures++; }
const post = await fetch(base + "/admin/login.php", {
  method: "POST", redirect: "manual",
  headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...XFF },
  body: new URLSearchParams({ _csrf: csrf, username: "admin", password: "Admin@Test123" }),
});
grabCookie(post);
console.log(post.status === 302 ? "✓ login → 302" : `✗ login status ${post.status}`);
if (post.status !== 302) failures++;

for (const p of PAGES) {
  const res = await get("/admin/" + p);
  const html = await res.text();
  const title = /<title>(.*?)<\/title>/.exec(html)?.[1] ?? "(no title)";
  const bad = BAD.test(html);
  const ok = res.status === 200 && !bad;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} /admin/${p || "(dashboard)"} → ${res.status} ${bad ? "PHP ERRORS " : ""}· ${title} · ${(html.length / 1024).toFixed(1)} KB`);
  if (bad) {
    const snippet = html.match(/<b>(Warning|Fatal error|Deprecated|Notice)<\/b>:\s*([^<]{0,220})/g)?.slice(0, 3);
    console.log("   ", snippet?.join("\n    "));
  }
}
console.log(failures ? `FAILED (${failures})` : "ALL OK");
process.exit(failures ? 1 : 0);
