// Authentication hardening + four business roles (brief §17–18, E2E-011/012/013/046/050).
//   node tests/admin-auth.mjs [base]
//
// Needs the PHP server with the usual env admin (admin / Admin@Test123). The
// idle-expiry check waits for the timeout, so it only runs when the server
// was started with ADMIN_IDLE_MINUTES=1 and the same value is exported here:
//   ADMIN_IDLE_MINUTES=1 node tests/admin-auth.mjs
const base = process.argv[2] || "http://127.0.0.1:8000";
const BAD = /(<b>Warning<\/b>|<b>Fatal error<\/b>|<b>Deprecated<\/b>|<b>Notice<\/b>|Parse error|Uncaught)/;
let pass = 0, fail = 0;
const ok = (c, name, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${name}${d ? " — " + d : ""}`); };

function jar() {
  let cookie = "", lastSet = [];
  const grab = (res) => {
    lastSet = res.headers.getSetCookie?.() ?? [];
    for (const c of lastSet) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; }
  };
  return {
    async get(path) { const r = await fetch(base + path, { headers: { cookie }, redirect: "manual" }); grab(r); return r; },
    async post(path, body) {
      const r = await fetch(base + path, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body), redirect: "manual" });
      grab(r); return r;
    },
    get cookie() { return cookie; },
    get lastSetCookie() { return lastSet; },
  };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
async function login(session, username, password) {
  const page = await session.get("/admin/login.php");
  const csrf = csrfOf(await page.text());
  return session.post("/admin/login.php", { _csrf: csrf, username, password, next: "" });
}

const PREFIX = "e2eauth_";
const ACCOUNTS = {
  admin:   { user: `${PREFIX}admin`,   issued: "Gopuram77Tem", pw: "Mandapam91Ad" },
  editor:  { user: `${PREFIX}editor`,  issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `${PREFIX}finance`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `${PREFIX}viewer`,  issued: "ViewOnly123X", pw: "QuietWatch42B" },
  locked:  { user: `${PREFIX}locked`,  issued: "Kumbam31Lock", pw: "Kumbam31Lock" },
};

// ── owner signs in; cookie flags ────────────────────────────────────────────
const owner = jar();
const first = await owner.get("/admin/login.php");
const sc = owner.lastSetCookie.find((c) => c.startsWith("PHPSESSID=")) || "";
ok(/httponly/i.test(sc), "session cookie is HttpOnly", sc);
ok(/samesite=lax/i.test(sc), "session cookie is SameSite=Lax", sc);
ok(!/secure/i.test(sc), "no Secure flag over plain http (set automatically under https)");
let r = await login(owner, "admin", "Admin@Test123");
ok(r.status === 302, "E2E-011 env admin signs in", `status ${r.status}`);
r = await login(jar(), "admin", "definitely-wrong");
ok(r.status === 200 && /Invalid username or password/.test(await r.text()), "E2E-012 wrong password is rejected");

async function usersHtml() { return (await owner.get("/admin/users.php")).text(); }
async function deleteTestAccounts() {
  const html = await usersHtml();
  const ids = html.split("<tr").filter((row) => row.includes(`class="cell-sub">${PREFIX}`))
    .map((row) => /users\.php\?edit=(\d+)/.exec(row)?.[1]).filter(Boolean);
  for (const id of ids) await owner.post("/admin/users.php", { _csrf: csrfOf(html), action: "delete", id });
}
await deleteTestAccounts();

async function createAccount(role, a) {
  const html = await usersHtml();
  const res = await owner.post("/admin/users.php", {
    _csrf: csrfOf(html), action: "save", id: "0", username: a.user, display_name: `E2E ${role}`,
    email: "", phone: "", role, password: a.issued, is_active: "1",
  });
  return res.status;
}
async function signInFresh(role, a) {
  const s = jar();
  let res = await login(s, a.user, a.issued);
  if (res.status !== 302) return null;
  const prof = await (await s.get("/admin/profile.php")).text();
  await s.post("/admin/profile.php", { _csrf: csrfOf(prof), action: "password", current_password: a.issued, new_password: a.pw, confirm_password: a.pw });
  return s;
}

// ── the four business roles are creatable and labelled ──────────────────────
for (const role of ["admin", "editor", "finance", "viewer"]) {
  ok((await createAccount(role, ACCOUNTS[role])) === 303, `owner creates a ${role} account`);
}
let uh = await usersHtml();
ok(!BAD.test(uh), "users page renders without PHP errors");
for (const label of ["Super Admin", "Temple Admin", "Content Editor", "Finance Admin", "Viewer"]) {
  ok(uh.includes(label), `users page shows the "${label}" role`);
}
ok(uh.includes("Temple Admins") && uh.includes("Finance"), "KPI strip counts the new roles");

const sessions = {};
for (const role of ["admin", "editor", "finance", "viewer"]) {
  sessions[role] = await signInFresh(role, ACCOUNTS[role]);
  ok(sessions[role] !== null, `${role} signs in and completes the first-password change`);
}
const status = async (s, path) => (await s.get(path)).status;
const matrix = [
  // page,                        admin, editor, finance, viewer
  ["/admin/sevas.php",              200,   200,    403,     403],
  ["/admin/announcements.php",      200,   200,    403,     403],
  ["/admin/bulk_upload.php",        200,   200,    403,     403],
  ["/admin/donations.php",          200,   200,    200,     200],
  ["/admin/sponsors.php",           200,   200,    200,     403],  // sponsor PII: not for read-only viewers
  ["/admin/donation_categories.php",200,   200,    200,     403],
  ["/admin/payments.php",           200,   200,    200,     200],
  ["/admin/payment_settings.php",   403,   403,    403,     403],
  ["/admin/settings.php",           200,   403,    403,     403],
  ["/admin/users.php",              403,   403,    403,     403],
  ["/admin/live_streams.php",       200,   200,    200,     200],
  ["/admin/live_settings.php",      403,   403,    403,     403],
  ["/admin/notification_templates.php", 200, 200,  200,     200],
];
for (const [page, ...want] of matrix) {
  const got = [];
  for (const role of ["admin", "editor", "finance", "viewer"]) got.push(await status(sessions[role], page));
  ok(got.join() === want.join(), `E2E-013 ${page} → admin/editor/finance/viewer ${want.join("/")}`, got.join("/"));
}
// writes are checked server-side, not just hidden (E2E-046)
let p = await (await sessions.finance.get("/admin/donations.php")).text();
r = await sessions.finance.post("/admin/sevas.php", { _csrf: csrfOf(p) || "x", action: "save" });
ok(r.status === 403, "E2E-046 finance POST to a content page is refused", `status ${r.status}`);
r = await sessions.editor.post("/admin/settings.php", { _csrf: "x", action: "save" });
ok(r.status === 403, "E2E-046 editor POST to settings is refused", `status ${r.status}`);
r = await sessions.viewer.post("/admin/payments.php", { _csrf: "x", action: "refund" });
ok(r.status === 403, "E2E-046 viewer POST to payments is refused", `status ${r.status}`);
const denied = await (await sessions.finance.get("/admin/sevas.php")).text();
ok(/Finance Admin/.test(denied) && /do not have access/i.test(denied), "403 page names the business role");
const dash = await (await sessions.finance.get("/admin/")).text();
ok(!BAD.test(dash) && /Finance Admin/.test(dash), "sidebar shows the Finance Admin label");
const ap = await (await sessions.admin.get("/admin/profile.php")).text();
ok(!BAD.test(ap) && /Temple Admin/.test(ap), "profile shows the Temple Admin label");

// ── E2E-050 logout invalidates the session ─────────────────────────────────
const cookieBefore = sessions.editor.cookie;
r = await sessions.editor.get("/admin/logout.php");
const replay = await fetch(base + "/admin/sevas.php", { headers: { cookie: cookieBefore }, redirect: "manual" });
ok(replay.status === 302 && /login\.php/.test(replay.headers.get("location") || ""), "E2E-050 old session cookie no longer works after logout", `status ${replay.status}`);
const jsonReplay = await fetch(base + "/api/admin/live-streams", { headers: { cookie: cookieBefore, accept: "application/json" }, redirect: "manual" });
ok(jsonReplay.status === 401, "E2E-045 protected JSON endpoint refuses the dead session", `status ${jsonReplay.status}`);
const anon = await fetch(base + "/api/admin/live-streams", { headers: { accept: "application/json" }, redirect: "manual" });
ok(anon.status === 401, "E2E-045 protected JSON endpoint refuses anonymous callers", `status ${anon.status}`);

// ── account lockout after repeated failures (independent of the browser session)
ok((await createAccount("viewer", ACCOUNTS.locked)) === 303, "lockout fixture account created");
let lastMsg = "";
for (let i = 0; i < 10; i++) {
  const res = await login(jar(), ACCOUNTS.locked.user, "wrong-" + i);
  lastMsg = await res.text();
}
ok(/temporarily locked/.test(lastMsg), "10th failure reports the account is locked");
r = await login(jar(), ACCOUNTS.locked.user, ACCOUNTS.locked.issued);
ok(r.status === 200 && /temporarily locked/.test(await r.text()), "correct password is refused while locked");
r = await login(jar(), ACCOUNTS.locked.user.toUpperCase(), ACCOUNTS.locked.issued);
ok(r.status === 200 && /temporarily locked/.test(await r.text()), "lock is case-insensitive on the username");
r = await login(jar(), ACCOUNTS.viewer.user, ACCOUNTS.viewer.pw);
ok(r.status === 302, "other accounts are unaffected by the lock", `status ${r.status}`);
uh = await usersHtml();
ok(/account locked/.test(uh) && /10 failed sign-ins/.test(uh), "lock is audited (activity log)");
// an owner issuing a new password clears the lock
const lockedId = uh.split("<tr").find((row) => row.includes(`class="cell-sub">${ACCOUNTS.locked.user}<`)) ?? "";
const lid = /users\.php\?edit=(\d+)/.exec(lockedId)?.[1];
r = await owner.post("/admin/users.php", { _csrf: csrfOf(uh), action: "save", id: lid, username: ACCOUNTS.locked.user, display_name: "E2E locked", email: "", phone: "", role: "viewer", password: "Unlocked77Ab", is_active: "1" });
ok(r.status === 303, "owner resets the locked account's password", `status ${r.status}`);
r = await login(jar(), ACCOUNTS.locked.user, "Unlocked77Ab");
ok(r.status === 302, "password reset by an owner lifts the lock", `status ${r.status}`);

// ── idle expiry (only when the server runs with a 1-minute idle timeout) ───
const idleMin = Number(process.env.ADMIN_IDLE_MINUTES || 0);
if (idleMin >= 1 && idleMin <= 2) {
  const s = sessions.viewer;
  ok((await status(s, "/admin/")) === 200, "viewer session alive before idling");
  await new Promise((res) => setTimeout(res, idleMin * 60_000 + 5_000));
  r = await s.get("/admin/donations.php");
  ok(r.status === 302 && /reason=expired/.test(r.headers.get("location") || ""), "idle session is expired and explained", r.headers.get("location") || `status ${r.status}`);
  const lg = await (await s.get("/admin/login.php?reason=expired")).text();
  ok(/Your session expired/.test(lg), "login page shows the expiry notice");
} else {
  console.log("· idle expiry skipped (run the server with ADMIN_IDLE_MINUTES=1 and export it here)");
}

// ── cleanup ─────────────────────────────────────────────────────────────────
await deleteTestAccounts();
uh = await usersHtml();
ok(!uh.includes(`class="cell-sub">${PREFIX}`), "test accounts removed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
