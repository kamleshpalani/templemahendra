#!/usr/bin/env node
/**
 * tests/deities.mjs — Deities CMS (brief §6 "Deities", §15 Temple → Deities)
 * and the public /api/deities feed the About page reads.
 *
 *   admin page needs a session (E2E-045) and content.edit: editor 200,
 *   finance/viewer 403 (E2E-013/046); forged CSRF writes nothing (E2E-049)
 *   create / edit / hide / show / delete with Tamil intact (E2E-003)
 *   slug is derived from the English name and made unique
 *   image upload: decoded type only (PHP-as-JPEG and GIF refused), random name
 *   a deity a live stream points at cannot be deleted, only hidden
 *   /api/deities: active rows only, display order, Tamil intact, no <script>
 *   SQL and script payloads are stored as data (E2E-047/048)
 *
 *   node tests/deities.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment, migration 011, and the admin account admin/Admin@Test123
 * (ADMIN_USERNAME / ADMIN_PASSWORD override). Everything it writes carries the
 * prefix "E2E-DEITY-<run>" and is deleted in `finally`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-DEITY-${RUN}`;
const ACTOR = `e2e-deity-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE deities;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const ACCOUNTS = {
  editor:  { user: `e2edeity_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2edeity_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2edeity_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.91.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };

function fixture(command, args) {
  const r = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), command, JSON.stringify(args)], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

/* cookie jars: one per signed-in account */
function jar() {
  let cookie = "";
  const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  const s = {
    async get(path, headers = {}) {
      const r = await fetch(base + path, { headers: { cookie, "X-Forwarded-For": xff(), ...headers }, redirect: "manual" });
      grab(r);
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async post(path, body, headers = {}) {
      const isForm = body instanceof FormData;
      const r = await fetch(base + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff(), ...(isForm ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...headers },
        body: isForm ? body : new URLSearchParams(body),
      });
      grab(r);
      return { status: r.status, headers: r.headers, text: await r.text() };
    },
    async login(username, password) {
      const page = await s.get("/admin/login.php");
      return s.post("/admin/login.php", { _csrf: csrfOf(page.text), username, password, next: "" });
    },
  };
  return s;
}
async function api(path) {
  const r = await fetch(base + path, { headers: { "X-Forwarded-For": xff() }, redirect: "manual" });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* checked by callers */ }
  return { status: r.status, headers: r.headers, text, json };
}
const csrfOf = (html) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const redirected = (r) => r.status === 302 || r.status === 303;
const flashOf = (html) => html.match(/alert[^>]*>([^<]+)/)?.[1] ?? "";
const findDeity = (en) => sql("SELECT * FROM deities WHERE name_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const ownedFiles = [];

try {
  /* ── server ─────────────────────────────────────────────────────────── */
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolveClose) => socket.close(resolveClose));
  base = `http://127.0.0.1:${port}`;
  const passHash = process.env.ADMIN_PASS_HASH
    || spawnSync(php, ["-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);", ADMIN.password], { encoding: "utf8" }).stdout.trim();
  server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: resolve(root, "backend"),
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/api/deities`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── public feed baseline ───────────────────────────────────────────── */
  let r = await api("/api/deities");
  check(r.status === 200 && Array.isArray(r.json) && r.json.length >= 1, "GET /api/deities answers a list", `${r.status} ${r.text.slice(0, 80)}`);
  check(r.json.every((d) => typeof d.name_ta === "string" && typeof d.name_en === "string" && typeof d.slug === "string" && "description_en" in d && "image_url" in d), "each deity has both names, slug, descriptions and image");
  check(/max-age=/.test(r.headers.get("cache-control") ?? "") && /charset=utf-8/i.test(r.headers.get("content-type") ?? ""), "feed is cacheable UTF-8 JSON");
  const seeded = r.json.find((d) => d.slug === "lingammal");
  check(!seeded || seeded.name_ta === "ஸ்ரீ லிங்கம்மாள்", "E2E-003 seeded Tamil name reaches the API intact", seeded?.name_ta);

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  r = await anon.get("/admin/deities.php");
  check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 admin deities page redirects to sign-in", `${r.status}`);
  r = await anon.post("/admin/deities.php", { action: "save", id: "0", name_ta: `${P} அனாமதேய`, name_en: `${P} anonymous`, is_active: "1" });
  check(!findDeity(`${P} anonymous`), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in ─────────────────────────────────────────────────── */
  const owner = jar();
  r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/deities.php");
  check(r.status === 200 && !FATAL.test(r.text), "deities page renders for the owner", `${r.status}`);
  check(/name="name_ta"/.test(r.text) && /name="name_en"/.test(r.text) && /name="description_ta"/.test(r.text) && /name="image"/.test(r.text) && /name="sort_order"/.test(r.text) && /name="is_active"/.test(r.text), "form has Tamil/English names, descriptions, image, order and status");
  check(r.text.includes('href="/admin/deities.php"') && /Deities/.test(r.text), "sidebar links to Deities");
  let csrf = csrfOf(r.text);
  check(csrf.length >= 32, "CSRF token issued");
  const save = (fields, s = owner, token = csrf) => s.post("/admin/deities.php", { _csrf: token, action: "save", ...fields });

  /* ── E2E-049: CSRF ──────────────────────────────────────────────────── */
  const before = sql("SELECT COUNT(*) AS n FROM deities").rows[0].n;
  r = await save({ id: "0", name_ta: `${P} போலி`, name_en: `${P} forged`, is_active: "1" }, owner, "forged-" + csrf.slice(0, 20));
  check(r.status === 200 && /tampered with/.test(r.text), "E2E-049 forged token is refused with a message", `${r.status}`);
  r = await owner.post("/admin/deities.php", { action: "save", id: "0", name_ta: `${P} போலி`, name_en: `${P} no token`, is_active: "1" });
  check(sql("SELECT COUNT(*) AS n FROM deities").rows[0].n === before, "E2E-049 forged and missing tokens wrote nothing");

  /* ── validation ─────────────────────────────────────────────────────── */
  r = await save({ id: "0", name_ta: "", name_en: `${P} no tamil`, is_active: "1" });
  check(r.status === 200 && /highlighted/.test(r.text) && !findDeity(`${P} no tamil`), "a deity without a Tamil name is refused");
  r = await save({ id: "0", name_ta: `${P} வரிசை`, name_en: `${P} bad order`, sort_order: "abc", is_active: "1" });
  check(r.status === 200 && !findDeity(`${P} bad order`), "a non-numeric display order is refused");
  r = await save({ id: "0", name_ta: `${P} படம்`, name_en: `${P} bad url`, image_url: "javascript:alert(1)", is_active: "1" });
  check(r.status === 200 && !findDeity(`${P} bad url`), "a javascript: image address is refused");

  /* ── create ─────────────────────────────────────────────────────────── */
  r = await save({ id: "0", name_ta: `${P} ஸ்ரீ முருகன்`, name_en: `${P} Sri Murugan`, description_ta: "தமிழ் விளக்கம் — வேலவன்", description_en: "English description", sort_order: "5", is_active: "1" });
  check(redirected(r), "created deity redirects to the list", `${r.status} ${flashOf(r.text)}`);
  const murugan = findDeity(`${P} Sri Murugan`);
  check(murugan && murugan.name_ta === `${P} ஸ்ரீ முருகன்` && murugan.description_ta === "தமிழ் விளக்கம் — வேலவன்" && murugan.sort_order === 5 && murugan.is_active === 1, "E2E-003 row stored with Tamil name and description intact", JSON.stringify(murugan));
  check(/^e2e-deity-[a-z0-9]+-sri-murugan$/.test(murugan.slug), "slug derives from the English name", murugan.slug);
  r = await owner.get("/admin/deities.php");
  check(r.text.includes(`${P} Sri Murugan`) && r.text.includes(`${P} ஸ்ரீ முருகன்`), "list shows the deity in both languages");
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'deity_created' AND subject = ?", [`deity:${murugan.id}`]).rows[0].n === 1, "creation is audited");

  /* a second deity with the same English name gets a distinct slug */
  r = await save({ id: "0", name_ta: `${P} ஸ்ரீ முருகன் 2`, name_en: `${P} Sri Murugan`, sort_order: "1" });
  const twin = sql("SELECT * FROM deities WHERE name_en = ? AND id <> ?", [`${P} Sri Murugan`, murugan.id]).rows[0];
  check(redirected(r) && twin && twin.slug === `${murugan.slug}-2` && twin.is_active === 0, "same English name → unique slug; unchecked status stores hidden", JSON.stringify(twin));

  /* ── public feed: active only, ordered ──────────────────────────────── */
  r = await api("/api/deities");
  const pubM = r.json.find((d) => d.id === murugan.id);
  check(pubM && pubM.name_ta === `${P} ஸ்ரீ முருகன்` && pubM.description_ta === "தமிழ் விளக்கம் — வேலவன்" && pubM.description_en === "English description", "public feed carries the new deity with Tamil intact", JSON.stringify(pubM));
  check(!r.json.some((d) => d.id === twin.id), "a hidden deity is not in the public feed");
  const orders = r.json.map((d) => d.sort_order);
  check(orders.every((o, i) => i === 0 || o >= orders[i - 1]), "public feed is in display order", orders.join(","));
  check(r.json[0].id === murugan.id, "sort_order 5 sorts before the seeded 10/20/30", `${r.json[0].id} vs ${murugan.id}`);

  /* ── edit ───────────────────────────────────────────────────────────── */
  r = await save({ id: String(murugan.id), name_ta: `${P} ஸ்ரீ முருகப்பெருமான்`, name_en: `${P} Sri Murugan (edited)`, description_ta: "திருத்தப்பட்டது", description_en: "edited", sort_order: "7", is_active: "1" });
  const edited = sql("SELECT * FROM deities WHERE id = ?", [murugan.id]).rows[0];
  check(redirected(r) && edited.name_en === `${P} Sri Murugan (edited)` && edited.name_ta === `${P} ஸ்ரீ முருகப்பெருமான்` && edited.description_ta === "திருத்தப்பட்டது" && edited.sort_order === 7 && edited.slug === murugan.slug, "edit persisted; slug unchanged", JSON.stringify(edited));
  check(sql("SELECT COUNT(*) AS n FROM deities WHERE name_en LIKE ?", [`${P}%`]).rows[0].n === 2, "edit did not create a duplicate");
  r = await owner.get(`/admin/deities.php?edit=${murugan.id}`);
  check(r.status === 200 && r.text.includes(`value="${P} ஸ்ரீ முருகப்பெருமான்"`), "edit form is pre-filled with the Tamil name");

  /* ── hide / show ────────────────────────────────────────────────────── */
  r = await owner.post("/admin/deities.php", { _csrf: csrf, action: "toggle", id: String(murugan.id) });
  check(redirected(r) && sql("SELECT is_active FROM deities WHERE id = ?", [murugan.id]).rows[0].is_active === 0, "toggle hides the deity");
  r = await api("/api/deities");
  check(!r.json.some((d) => d.id === murugan.id), "a hidden deity leaves the public feed");
  r = await owner.get("/admin/deities.php?f=hidden");
  check(r.text.includes(`${P} Sri Murugan (edited)`), "Hidden filter lists it");
  r = await owner.get("/admin/deities.php?f=active");
  check(!r.text.includes(`${P} Sri Murugan (edited)`), "Shown filter omits it");
  await owner.post("/admin/deities.php", { _csrf: csrf, action: "toggle", id: String(murugan.id) });
  check(sql("SELECT is_active FROM deities WHERE id = ?", [murugan.id]).rows[0].is_active === 1, "toggle shows it again");

  /* ── E2E-047/048: hostile payloads are data ─────────────────────────── */
  r = await save({ id: "0", name_ta: XSS, name_en: SQLI, description_en: XSS, description_ta: SQLI, is_active: "1" });
  check(redirected(r), "hostile payloads are accepted as text", `${r.status} ${flashOf(r.text)}`);
  const hostile = sql("SELECT * FROM deities WHERE name_en = ?", [SQLI]).rows[0];
  check(hostile && hostile.name_en === SQLI && !/<script|onerror/.test(hostile.name_ta) && hostile.name_ta.startsWith(P), "E2E-047 the SQL payload is stored verbatim (table still exists); tags are stripped on save", JSON.stringify(hostile));
  check(sql("SELECT COUNT(*) AS n FROM deities WHERE name_en LIKE ?", [`${P}%`]).rows[0].n === 3, "E2E-047 exactly one row was written");
  r = await owner.get("/admin/deities.php");
  check(!r.text.includes("<script>alert(1)</script>") && !r.text.includes("onerror=alert(2)>") && r.text.includes("&#039;); DROP TABLE") , "E2E-048 admin list shows the payload escaped, never as markup");
  r = await owner.get(`/admin/deities.php?edit=${hostile.id}`);
  check(!r.text.includes("<script>alert(1)</script>") && !/<img src=x onerror/.test(r.text), "E2E-048 edit form escapes the payload");
  r = await api("/api/deities");
  check(r.json.some((d) => d.id === hostile.id && d.name_en === SQLI && d.name_ta === hostile.name_ta) && !/<script/.test(r.text), "E2E-048 API returns the stored text as a JSON string; no script tag anywhere");
  const searched = await owner.get("/admin/deities.php?f=" + encodeURIComponent(SQLI));
  check(searched.status === 200 && !FATAL.test(searched.text), "E2E-047 SQL payload in the filter is harmless");

  /* ── image upload ───────────────────────────────────────────────────── */
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const uploadSave = (blob, filename, fields) => {
    const form = new FormData();
    form.set("_csrf", csrf); form.set("action", "save");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("image", blob, filename);
    return owner.post("/admin/deities.php", form);
  };
  r = await uploadSave(new Blob(["<?php echo 'owned'; ?>"], { type: "image/jpeg" }), "shell.php.jpg", { id: "0", name_ta: `${P} மாறுவேடம்`, name_en: `${P} disguised`, is_active: "1" });
  check(r.status === 200 && /Only JPEG, PNG and WebP/.test(r.text) && !findDeity(`${P} disguised`), "E2E-023 a PHP file with an image name and MIME is refused and no row is written", `${r.status}`);
  r = await uploadSave(new Blob(["GIF89a not really"], { type: "image/gif" }), "photo.gif", { id: "0", name_ta: `${P} gif`, name_en: `${P} gif`, is_active: "1" });
  check(/Only JPEG, PNG and WebP/.test(r.text) && !findDeity(`${P} gif`), "E2E-023 an unsupported image type is refused");
  r = await uploadSave(new Blob([png], { type: "application/octet-stream" }), "../../evil.php", { id: String(murugan.id), name_ta: `${P} ஸ்ரீ முருகப்பெருமான்`, name_en: `${P} Sri Murugan (edited)`, sort_order: "7", is_active: "1" });
  const withImage = sql("SELECT * FROM deities WHERE id = ?", [murugan.id]).rows[0];
  check(redirected(r) && /^\/uploads\/[a-f0-9]{24}\.png$/.test(withImage.image_url ?? ""), "E2E-021 image stored under a random name with the decoded type's extension", `${r.status} ${withImage.image_url} ${flashOf(r.text)}`);
  const imgFile = withImage.image_url.slice("/uploads/".length);
  ownedFiles.push(imgFile);
  check(existsSync(resolve(root, "backend/uploads", imgFile)), "E2E-021 file is on disk");
  r = await api("/api/deities");
  check(r.json.find((d) => d.id === murugan.id)?.image_url === withImage.image_url, "public feed carries the image address");
  r = await anon.get(withImage.image_url);
  check(r.status === 200 && /^image\/png/.test(r.headers.get("content-type") ?? ""), "E2E-022 the image is served as an image");
  /* editing without a new file keeps the image */
  r = await save({ id: String(murugan.id), name_ta: `${P} ஸ்ரீ முருகப்பெருமான்`, name_en: `${P} Sri Murugan (edited)`, image_url: withImage.image_url, sort_order: "7", is_active: "1" });
  check(sql("SELECT image_url FROM deities WHERE id = ?", [murugan.id]).rows[0].image_url === withImage.image_url && existsSync(resolve(root, "backend/uploads", imgFile)), "re-saving without a new file keeps the image");

  /* ── a live stream pins the deity ───────────────────────────────────── */
  const stream = fixture("create-stream", { title_prefix: P, label: "pinned", status: "SCHEDULED", deity_slug: withImage.slug, actor: ACTOR });
  check(stream.id > 0 && sql("SELECT deity_id FROM live_streams WHERE id = ?", [stream.id]).rows[0].deity_id === murugan.id, "fixture stream is linked to the deity");
  r = await owner.post("/admin/deities.php", { _csrf: csrf, action: "delete", id: String(murugan.id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM deities WHERE id = ?", [murugan.id]).rows[0].n === 1, "a deity a live stream points at is not deleted");
  r = await owner.get("/admin/deities.php");
  check(/cannot be deleted\. Hide it instead/.test(r.text), "…and the admin is told to hide it instead");
  check(existsSync(resolve(root, "backend/uploads", imgFile)), "…its image is kept");
  r = await owner.get("/admin/live_streams.php");
  check(r.status === 200 && r.text.includes(`${P} Sri Murugan (edited)`), "the deity is offered in the live-stream form");
  /* hiding keeps the stream's reference; deleting an unlinked deity works */
  await owner.post("/admin/deities.php", { _csrf: csrf, action: "toggle", id: String(murugan.id) });
  check(sql("SELECT deity_id FROM live_streams WHERE id = ?", [stream.id]).rows[0].deity_id === murugan.id, "hiding keeps the stream's deity reference");
  r = await owner.post("/admin/deities.php", { _csrf: csrf, action: "delete", id: String(twin.id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM deities WHERE id = ?", [twin.id]).rows[0].n === 0, "an unlinked deity is deleted");
  check(sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = 'deity_deleted' AND subject = ?", [`deity:${twin.id}`]).rows[0].n === 1, "deletion is audited");

  /* ── E2E-013/046: roles ─────────────────────────────────────────────── */
  const usersHtml = (await owner.get("/admin/users.php")).text;
  const sessions = {};
  for (const [role, a] of Object.entries(ACCOUNTS)) {
    r = await owner.post("/admin/users.php", { _csrf: csrfOf(usersHtml), action: "save", id: "0", username: a.user, display_name: `${P} ${role}`, email: "", phone: "", role, password: a.issued, is_active: "1" });
    check(redirected(r), `owner creates a ${role} account`, `${r.status} ${flashOf(r.text)}`);
    const s = jar();
    r = await s.login(a.user, a.issued);
    const prof = (await s.get("/admin/profile.php")).text;
    await s.post("/admin/profile.php", { _csrf: csrfOf(prof), action: "password", current_password: a.issued, new_password: a.pw, confirm_password: a.pw });
    sessions[role] = s;
  }
  r = await sessions.editor.get("/admin/deities.php");
  check(r.status === 200 && r.text.includes(`${P} Sri Murugan (edited)`), "E2E-013 editor (content.edit) opens the Deities page", `${r.status}`);
  const edCsrf = csrfOf(r.text);
  r = await save({ id: "0", name_ta: `${P} ஆசிரியர்`, name_en: `${P} by editor`, is_active: "1" }, sessions.editor, edCsrf);
  const byEditor = findDeity(`${P} by editor`);
  check(redirected(r) && !!byEditor, "E2E-013 editor can create a deity");
  for (const role of ["finance", "viewer"]) {
    r = await sessions[role].get("/admin/deities.php");
    check(r.status === 403, `E2E-013 ${role} gets 403 on the Deities page`, `${r.status}`);
    r = await sessions[role].post("/admin/deities.php", { _csrf: "x", action: "toggle", id: String(byEditor.id) });
    check(r.status === 403 && sql("SELECT is_active FROM deities WHERE id = ?", [byEditor.id]).rows[0].is_active === 1, `E2E-046 ${role} POST is refused server-side`, `${r.status}`);
  }

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\ndeities: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\ndeities: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  try { fixture("cleanup", { title_prefix: P, actors: [ACTOR] }); } catch (e) { console.error(e.message); }
  for (const f of ownedFiles) {
    const p = resolve(root, "backend/uploads", f);
    if (existsSync(p)) unlinkSync(p);
  }
  sql("DELETE FROM deities WHERE name_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2edeity_${RUN}_%`]);
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ?", [`%${P}%`, `%${P}%`, `e2edeity_${RUN}_%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
