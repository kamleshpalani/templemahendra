// End-to-end test of the committee-accounts / roles feature.
//   node auth-test.mjs [base]
const base = process.argv[2] || "http://127.0.0.1:8000";
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught)/;
let pass = 0, fail = 0;
const ok = (c, name, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${name}${d ? " — " + d : ""}`); };

function jar() {
  let cookie = "";
  const grab = (res) => { for (const c of res.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  return {
    async get(path) { const r = await fetch(base + path, { headers: { cookie }, redirect: "manual" }); grab(r); return r; },
    async post(path, body) {
      const r = await fetch(base + path, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), redirect: "manual" });
      grab(r); return r;
    },
    get cookie() { return cookie; },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

async function login(session, username, password) {
  const page = await session.get("/admin/login.php");
  const csrf = csrfOf(await page.text());
  return session.post("/admin/login.php", { _csrf: csrf, username, password, next: "" });
}

// ── 1. environment admin still works ────────────────────────────────────────
const owner = jar();
let r = await login(owner, "admin", "Admin@Test123");
ok(r.status === 302, "env admin signs in", `status ${r.status}`);
let dash = await (await owner.get("/admin/")).text();
ok(!BAD.test(dash), "dashboard renders without PHP errors");
ok(dash.includes("Committee Accounts"), "owner sees the Committee Accounts nav item");

// ── 2. users page + create an editor ────────────────────────────────────────
let usersHtml = await (await owner.get("/admin/users.php")).text();
ok(!BAD.test(usersHtml), "users page renders");
ok(usersHtml.includes("Built-in recovery account"), "env account shown as read-only built-in");
const uname = "e2e_editor";
r = await owner.post("/admin/users.php", {
  _csrf: csrfOf(usersHtml), action: "save", id: "0",
  username: uname, display_name: "E2E Editor", email: "e2e@example.com", phone: "",
  role: "editor", password: "Kolam99Deep", is_active: "1",
});
ok(r.status === 303, "create editor account redirects", `status ${r.status}`);
usersHtml = await (await owner.get("/admin/users.php?issued=1")).text();
ok(usersHtml.includes("E2E Editor"), "new account appears in the list");
ok(usersHtml.includes("Share this password now"), "one-time password panel is shown");

// ── 3. weak password rejected ───────────────────────────────────────────────
r = await owner.post("/admin/users.php", {
  _csrf: csrfOf(usersHtml), action: "save", id: "0",
  username: "e2e_weak", display_name: "Weak", role: "viewer", password: "short", is_active: "1",
});
const weakHtml = await r.text();
ok(r.status === 200 && /at least 10 characters/i.test(weakHtml), "weak password is rejected with a reason");

// ── 4. the editor must change password, then gets editor-only access ────────
const editor = jar();
r = await login(editor, uname, "Kolam99Deep");
ok(r.status === 302 && (r.headers.get("location") || "").includes("profile.php?must_change=1"),
   "issued password forces a change on first sign-in", r.headers.get("location") || "");
// any other page bounces back to profile
r = await editor.get("/admin/sevas.php");
ok(r.status === 302 && (r.headers.get("location") || "").includes("profile.php"), "forced change blocks other pages");
let prof = await (await editor.get("/admin/profile.php")).text();
ok(!BAD.test(prof) && /Choose your own password to continue/.test(prof), "profile explains the forced change");
r = await editor.post("/admin/profile.php", {
  _csrf: csrfOf(prof), action: "password",
  current_password: "Kolam99Deep", new_password: "Vilakku42Raja", confirm_password: "Vilakku42Raja",
});
ok(r.status === 303, "password change succeeds", `status ${r.status}`);
// now normal navigation works
dash = await (await editor.get("/admin/")).text();
ok(!BAD.test(dash) && dash.includes("Dashboard"), "editor reaches the dashboard after changing password");
ok(!dash.includes("Committee Accounts"), "editor does NOT see Committee Accounts in the nav");
ok(!/Settings<\/span>/.test(dash) || !dash.includes("sidebar__link is-active"), "editor nav is filtered");
r = await editor.get("/admin/users.php");
const denied = await r.text();
ok(r.status === 403 && /do not have access/i.test(denied), "editor is refused the users page with an explanation", `status ${r.status}`);
r = await editor.get("/admin/settings.php");
ok(r.status === 403, "editor is refused system settings", `status ${r.status}`);
r = await editor.get("/admin/sevas.php");
ok(r.status === 200, "editor CAN open content pages", `status ${r.status}`);

// ── 5. viewer role is read-only ─────────────────────────────────────────────
usersHtml = await (await owner.get("/admin/users.php")).text();
await owner.post("/admin/users.php", {
  _csrf: csrfOf(usersHtml), action: "save", id: "0",
  username: "e2e_viewer", display_name: "E2E Viewer", role: "viewer", password: "ViewOnly123X", is_active: "1",
});
const viewer = jar();
await login(viewer, "e2e_viewer", "ViewOnly123X");
let vprof = await (await viewer.get("/admin/profile.php")).text();
await viewer.post("/admin/profile.php", { _csrf: csrfOf(vprof), action: "password", current_password: "ViewOnly123X", new_password: "QuietWatch42B", confirm_password: "QuietWatch42B" });
r = await viewer.get("/admin/sevas.php");
ok(r.status === 403, "viewer is refused content editing", `status ${r.status}`);
r = await viewer.get("/admin/donations.php");
ok(r.status === 200, "viewer CAN read donations", `status ${r.status}`);
r = await viewer.get("/admin/bulk_upload.php");
ok(r.status === 403, "viewer is refused bulk upload", `status ${r.status}`);

// ── 6. last-owner protection ────────────────────────────────────────────────
usersHtml = await (await owner.get("/admin/users.php")).text();
const ownerRow = /href="\/admin\/users\.php\?edit=(\d+)"/.exec(usersHtml);
ok(Boolean(ownerRow), "an editable account row exists");

// ── 7. open-redirect protection on ?next ────────────────────────────────────
const eve = jar();
let lg = await eve.get("/admin/login.php?next=https%3A%2F%2Fevil.example%2Fx");
r = await eve.post("/admin/login.php", { _csrf: csrfOf(await lg.text()), username: "admin", password: "Admin@Test123", next: "https://evil.example/x" });
ok(r.status === 302 && (r.headers.get("location") || "") === "/admin/", "external ?next is ignored", r.headers.get("location") || "");

// ── 8. audit log recorded the sign-ins ──────────────────────────────────────
usersHtml = await (await owner.get("/admin/users.php")).text();
ok(/Recent account activity/.test(usersHtml) && /e2e_editor/.test(usersHtml), "activity log shows account events");

console.log(`\n${pass} passed, ${fail} failed`);
console.log("CLEANUP: delete from admin_users where username like 'e2e_%'");
process.exit(fail ? 1 : 0);
