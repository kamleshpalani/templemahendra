#!/usr/bin/env node
/**
 * tests/videos.mjs — Videos module (brief §6 "Videos", §15 Media → Videos):
 * /admin/videos.php, GET /api/videos and the videos group of /api/search.
 *
 *   migration 017: videos + video_categories, utf8mb4, unique youtube_id, FKs
 *   admin page needs a session (E2E-045) and content.edit: editor 200,
 *   finance/viewer 403 (E2E-013/046); forged CSRF writes nothing (E2E-049)
 *   YouTube input: bare id, watch/shorts/live/embed/youtu.be URLs; junk refused;
 *   duplicate id refused with a pointer to the existing row
 *   create / edit / hide / show / feature / delete with Tamil intact (E2E-003)
 *   category create / edit / hide / delete; a category with videos is kept
 *   /api/videos: shown videos only, hidden categories hide their videos,
 *   featured first, category filter + pagination, public fields only, no <script>
 *   a video may point at a COMPLETED live stream and inherit its recording
 *   /api/search finds videos by title in either language
 *   SQL and script payloads are stored as data (E2E-047/048)
 *
 *   node tests/videos.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment, migrations 015 and 017, and the admin account admin/Admin@Test123
 * (ADMIN_USERNAME / ADMIN_PASSWORD override). Everything it writes carries the
 * prefix "E2E-VIDEO-<run>" and is deleted in `finally`.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-VIDEO-${RUN}`;
const ACTOR = `e2e-video-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE videos;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const ACCOUNTS = {
  editor:  { user: `e2evideo_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2evideo_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2evideo_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};
/* Distinct, well-formed ids; no network is touched so they need not exist on YouTube. */
const YT = { a: `E2Ea${RUN}`.padEnd(11, "x").slice(0, 11), b: `E2Eb${RUN}`.padEnd(11, "x").slice(0, 11), c: `E2Ec${RUN}`.padEnd(11, "x").slice(0, 11), d: `E2Ed${RUN}`.padEnd(11, "x").slice(0, 11), s: `E2Es${RUN}`.padEnd(11, "x").slice(0, 11) };
const PUBLIC_FIELDS = ["id", "youtube_id", "title_ta", "title_en", "description_ta", "description_en", "published_on", "is_featured", "category", "live_stream_slug", "embed_url", "watch_url", "thumbnail_url"];

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.92.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
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
      const r = await fetch(base + path, {
        method: "POST", redirect: "manual",
        headers: { cookie, "X-Forwarded-For": xff(), "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams(body),
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
const findVideo = (en) => sql("SELECT * FROM videos WHERE title_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const findCat = (en) => sql("SELECT * FROM video_categories WHERE name_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const audits = (action, subject) => sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = ? AND subject = ?", [action, subject]).rows[0].n;
const createdCatIds = [];

try {
  /* ── schema (brief §25/§33) ─────────────────────────────────────────── */
  let rows = sql("SELECT TABLE_NAME AS t, TABLE_COLLATION AS c, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('videos','video_categories')").rows;
  check(rows.length === 2 && rows.every((r) => /^utf8mb4/.test(r.c) && r.e === "InnoDB"), "migration 017: both tables exist as utf8mb4 InnoDB", JSON.stringify(rows));
  rows = sql("SELECT INDEX_NAME AS i, NON_UNIQUE AS nu, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos' GROUP BY INDEX_NAME, NON_UNIQUE").rows;
  check(rows.some((r) => r.cols === "youtube_id" && Number(r.nu) === 0), "youtube_id is unique", JSON.stringify(rows));
  check(rows.some((r) => /^is_active/.test(r.cols)) && rows.some((r) => r.cols.startsWith("category_id")), "public-order and category indexes exist", JSON.stringify(rows));
  rows = sql("SELECT COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'videos' AND REFERENCED_TABLE_NAME IS NOT NULL").rows;
  check(rows.some((r) => r.c === "category_id" && r.rt === "video_categories") && rows.some((r) => r.c === "live_stream_id" && r.rt === "live_streams"), "foreign keys to video_categories and live_streams", JSON.stringify(rows));
  const seededCat = sql("SELECT * FROM video_categories WHERE slug = 'poojas'").rows[0];
  check(seededCat && seededCat.name_ta === "பூஜைகள்", "seeded category keeps its Tamil name", JSON.stringify(seededCat));

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
    try { ready = (await fetch(`${base}/api/videos`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── public feed baseline ───────────────────────────────────────────── */
  let r = await api("/api/videos");
  check(r.status === 200 && r.json && Array.isArray(r.json.videos) && Array.isArray(r.json.categories) && "featured" in r.json && typeof r.json.has_more === "boolean" && r.json.page === 1, "GET /api/videos answers {categories, videos, featured, page, has_more}", `${r.status} ${r.text.slice(0, 120)}`);
  check(/charset=utf-8/i.test(r.headers.get("content-type") ?? ""), "feed is UTF-8 JSON");
  r = await api("/api/videos?category=no-such-category-" + RUN);
  check(r.status === 200 && r.json.videos.length === 0 && r.json.has_more === false, "an unknown category filter answers an empty list, not an error", `${r.status}`);
  r = await api("/api/videos?page=abc&category=" + encodeURIComponent("' OR 1=1 --"));
  check(r.status === 422 && r.json && typeof r.json.error === "string" && !/SQLSTATE/.test(r.text), "E2E-047 junk page/category parameters get a clean 422, never a SQL error", `${r.status} ${r.text.slice(0, 80)}`);

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  r = await anon.get("/admin/videos.php");
  check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 admin videos page redirects to sign-in", `${r.status}`);
  r = await anon.post("/admin/videos.php", { action: "save", id: "0", youtube: YT.a, title_ta: `${P} அனாமதேய`, title_en: `${P} anonymous`, is_active: "1" });
  check(!findVideo(`${P} anonymous`), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in ─────────────────────────────────────────────────── */
  const owner = jar();
  r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/videos.php");
  check(r.status === 200 && !FATAL.test(r.text), "videos page renders for the owner", `${r.status}`);
  check(/name="youtube"/.test(r.text) && /name="title_ta"/.test(r.text) && /name="title_en"/.test(r.text) && /name="description_ta"/.test(r.text) && /name="category_id"/.test(r.text) && /name="live_stream_id"/.test(r.text) && /name="published_on"/.test(r.text) && /name="sort_order"/.test(r.text) && /name="is_featured"/.test(r.text) && /name="is_active"/.test(r.text), "form has YouTube link, Tamil/English titles and descriptions, category, recording, date, order, featured, status");
  check(/name="cat_name_ta"/.test(r.text) && /name="cat_name_en"/.test(r.text), "category editor is on the page");
  check(r.text.includes('href="/admin/videos.php"') && /Videos/.test(r.text), "sidebar links to Videos");
  let csrf = csrfOf(r.text);
  check(csrf.length >= 32, "CSRF token issued");
  const save = (fields, s = owner, token = csrf) => s.post("/admin/videos.php", { _csrf: token, action: "save", ...fields });
  const act = (fields, s = owner, token = csrf) => s.post("/admin/videos.php", { _csrf: token, ...fields });

  /* ── E2E-049: CSRF ──────────────────────────────────────────────────── */
  const before = sql("SELECT COUNT(*) AS n FROM videos").rows[0].n;
  r = await save({ id: "0", youtube: YT.a, title_ta: `${P} போலி`, title_en: `${P} forged`, is_active: "1" }, owner, "forged-" + csrf.slice(0, 20));
  check(r.status === 200 && /tampered with/.test(r.text), "E2E-049 forged token is refused with a message", `${r.status}`);
  r = await owner.post("/admin/videos.php", { action: "save", id: "0", youtube: YT.a, title_ta: `${P} போலி`, title_en: `${P} no token`, is_active: "1" });
  r = await owner.post("/admin/videos.php", { action: "cat_save", cat_id: "0", cat_name_ta: `${P} போலி`, cat_name_en: `${P} no token cat` });
  check(sql("SELECT COUNT(*) AS n FROM videos").rows[0].n === before && !findCat(`${P} no token cat`), "E2E-049 forged and missing tokens wrote nothing");

  /* ── validation ─────────────────────────────────────────────────────── */
  const refused = async (fields, label) => {
    const res = await save({ id: "0", is_active: "1", ...fields });
    check(res.status === 200 && /highlighted/.test(res.text) && !findVideo(fields.title_en), label, `${res.status} ${flashOf(res.text)}`);
  };
  await refused({ youtube: "", title_ta: "த", title_en: `${P} no link` }, "a video without a YouTube link is refused");
  await refused({ youtube: "https://example.com/watch?v=" + YT.a, title_ta: "த", title_en: `${P} other host` }, "a non-YouTube host is refused");
  await refused({ youtube: "javascript:alert(1)", title_ta: "த", title_en: `${P} js` }, "a javascript: link is refused");
  await refused({ youtube: "abc", title_ta: "த", title_en: `${P} short id` }, "a too-short id is refused");
  await refused({ youtube: "<script>alert(1)</script>", title_ta: "த", title_en: `${P} tag id` }, "markup in the link is refused");
  await refused({ youtube: YT.a, title_ta: "", title_en: `${P} no tamil` }, "a video without a Tamil title is refused");
  await refused({ youtube: YT.a, title_ta: "த", title_en: "" }, "a video without an English title is refused");
  await refused({ youtube: YT.a, title_ta: "த", title_en: `${P} bad date`, published_on: "2026-13-45" }, "an impossible date is refused");
  await refused({ youtube: YT.a, title_ta: "த", title_en: `${P} bad order`, sort_order: "abc" }, "a non-numeric order is refused");
  await refused({ youtube: YT.a, title_ta: "த", title_en: `${P} bad cat`, category_id: "999999" }, "an unknown category is refused");
  await refused({ youtube: YT.a, title_ta: "த", title_en: `${P} bad stream`, live_stream_id: "999999" }, "an unknown live stream is refused");
  r = await save({ id: "0", youtube: YT.a, title_ta: "த", title_en: `${P} re-shown`, is_active: "1" }, owner, "x".repeat(40));
  check(!findVideo(`${P} re-shown`), "refused saves never write");

  /* ── URL forms all normalise to the id ──────────────────────────────── */
  const forms = [
    [`https://www.youtube.com/watch?v=${YT.a}&t=42s`, YT.a, "watch URL with extra query"],
    [`https://youtu.be/${YT.b}?si=share`, YT.b, "youtu.be short link"],
    [`https://www.youtube.com/shorts/${YT.c}`, YT.c, "shorts URL"],
    [`  ${YT.d}  `, YT.d, "bare id with whitespace"],
  ];
  const made = {};
  for (const [input, id, label] of forms) {
    r = await save({ id: "0", youtube: input, title_ta: `${P} ${label} த`, title_en: `${P} ${label}`, category_id: String(seededCat.id), is_active: "1", sort_order: "10" });
    const row = findVideo(`${P} ${label}`);
    check(redirected(r) && row && row.youtube_id === id, `${label} stores the bare id`, `${r.status} ${flashOf(r.text)} ${JSON.stringify(row)}`);
    made[id] = row;
  }
  r = await save({ id: "0", youtube: `https://www.youtube.com/embed/${YT.a}`, title_ta: `${P} நகல்`, title_en: `${P} duplicate`, is_active: "1" });
  check(r.status === 200 && /already listed/.test(r.text) && r.text.includes(`#${made[YT.a].id}`) && !findVideo(`${P} duplicate`), "the same video via another URL form is refused, naming the existing row", `${r.status} ${flashOf(r.text)}`);
  check(audits("video_created", `video:${made[YT.a].id}`) === 1, "creation is audited");

  /* ── create with everything, Tamil intact ───────────────────────────── */
  const TA_DESC = "பௌர்ணமி பூஜை — முழு நிலா நாளில் அம்மனுக்கு அபிஷேகம் ஆராதனை.";
  r = await save({ id: "0", youtube: `https://www.youtube.com/live/${YT.s}?feature=share`, title_ta: `${P} பௌர்ணமி பூஜை`, title_en: `${P} Pournami Pooja`, description_ta: TA_DESC, description_en: "Full-moon abhishekam and aradhana.", category_id: String(seededCat.id), published_on: "2026-09-06", sort_order: "1", is_featured: "1", is_active: "1" });
  const pournami = findVideo(`${P} Pournami Pooja`);
  check(redirected(r) && pournami && pournami.youtube_id === YT.s && pournami.title_ta === `${P} பௌர்ணமி பூஜை` && pournami.description_ta === TA_DESC && pournami.published_on === "2026-09-06" && pournami.sort_order === 1 && pournami.is_featured === 1 && pournami.is_active === 1 && pournami.category_id === seededCat.id, "E2E-003 /live/ URL row stored with Tamil title, description, date, category, featured", JSON.stringify(pournami));
  r = await owner.get("/admin/videos.php");
  check(r.text.includes(`${P} Pournami Pooja`) && r.text.includes(`${P} பௌர்ணமி பூஜை`) && r.text.includes(`https://www.youtube.com/watch?v=${YT.s}`), "list shows the video in both languages with its YouTube link");
  r = await owner.get("/admin/videos.php?f=featured");
  check(r.text.includes(`${P} Pournami Pooja`) && !r.text.includes(`${P} watch URL with extra query`), "Featured filter lists only featured videos");
  r = await owner.get("/admin/videos.php?q=" + encodeURIComponent(YT.b));
  check(r.text.includes(`${P} youtu.be short link`) && !r.text.includes(`${P} Pournami Pooja`), "search by video id narrows the list");
  r = await owner.get("/admin/videos.php?q=" + encodeURIComponent("பௌர்ணமி பூஜை"));
  check(r.text.includes(`${P} Pournami Pooja`), "search by Tamil title finds it");

  /* ── public feed ────────────────────────────────────────────────────── */
  r = await api("/api/videos");
  const pub = r.json.videos.find((v) => v.id === pournami.id);
  check(pub && pub.title_ta === `${P} பௌர்ணமி பூஜை` && pub.description_ta === TA_DESC && pub.is_featured === true && pub.category?.slug === "poojas" && pub.category.name_ta === "பூஜைகள்", "public feed carries the new video with Tamil intact and its category", JSON.stringify(pub));
  check(Object.keys(pub).sort().join() === [...PUBLIC_FIELDS].sort().join(), "public video exposes only the public fields", Object.keys(pub).join());
  check(pub.embed_url === `https://www.youtube-nocookie.com/embed/${YT.s}?rel=0&playsinline=1` && pub.watch_url === `https://www.youtube.com/watch?v=${YT.s}` && pub.thumbnail_url === `https://i.ytimg.com/vi/${YT.s}/hqdefault.jpg`, "embed, watch and thumbnail URLs are built from the validated id", JSON.stringify(pub));
  check(r.json.featured && r.json.featured.id === pournami.id, "the featured video is surfaced separately");
  check(r.json.videos[0].id === pournami.id, "sort_order 1 lists first");
  const pc = r.json.categories.find((c) => c.slug === "poojas");
  check(pc && pc.count >= 5 && Object.keys(pc).sort().join() === "count,name_en,name_ta,slug", "category summary has slug, names and a count", JSON.stringify(pc));
  r = await api("/api/videos?category=poojas");
  check(r.json.videos.every((v) => v.category?.slug === "poojas") && r.json.videos.some((v) => v.id === pournami.id), "category filter returns only that category");
  r = await api("/api/videos?page=9999");
  check(r.status === 200 && r.json.videos.length === 0 && r.json.has_more === false && r.json.page === 9999, "a page past the end is empty with has_more=false");

  /* ── edit ───────────────────────────────────────────────────────────── */
  r = await save({ id: String(pournami.id), youtube: YT.s, title_ta: `${P} பௌர்ணமி பூஜை (திருத்தம்)`, title_en: `${P} Pournami Pooja (edited)`, description_ta: "திருத்தப்பட்டது", description_en: "edited", category_id: String(seededCat.id), published_on: "2026-09-07", sort_order: "2", is_active: "1" });
  let edited = sql("SELECT * FROM videos WHERE id = ?", [pournami.id]).rows[0];
  check(redirected(r) && edited.title_en === `${P} Pournami Pooja (edited)` && edited.title_ta === `${P} பௌர்ணமி பூஜை (திருத்தம்)` && edited.description_ta === "திருத்தப்பட்டது" && edited.published_on === "2026-09-07" && edited.sort_order === 2 && edited.is_featured === 0, "edit persisted; unchecked featured clears it", JSON.stringify(edited));
  check(sql("SELECT COUNT(*) AS n FROM videos WHERE title_en LIKE ?", [`${P}%`]).rows[0].n === 5, "edit did not create a duplicate");
  check(audits("video_updated", `video:${pournami.id}`) === 1, "update is audited");
  r = await owner.get(`/admin/videos.php?edit=${pournami.id}`);
  check(r.status === 200 && r.text.includes(`value="${P} பௌர்ணமி பூஜை (திருத்தம்)"`) && r.text.includes(`value="${YT.s}"`), "edit form is pre-filled with the Tamil title and the video id");
  r = await save({ id: String(pournami.id), youtube: YT.a, title_ta: "த", title_en: `${P} Pournami Pooja (edited)`, is_active: "1" });
  check(r.status === 200 && /already listed/.test(r.text) && sql("SELECT youtube_id FROM videos WHERE id = ?", [pournami.id]).rows[0].youtube_id === YT.s, "editing onto another row's id is refused and changes nothing");
  r = await save({ id: "987654321", youtube: YT.s, title_ta: "த", title_en: `${P} ghost`, is_active: "1" });
  check(r.status === 200 && /no longer exists/.test(r.text) && !findVideo(`${P} ghost`), "editing a deleted id is refused");

  /* ── feature / hide / show ──────────────────────────────────────────── */
  r = await act({ action: "feature", id: String(pournami.id) });
  check(redirected(r) && sql("SELECT is_featured FROM videos WHERE id = ?", [pournami.id]).rows[0].is_featured === 1 && audits("video_featured", `video:${pournami.id}`) === 1, "feature toggle sets featured and is audited");
  r = await act({ action: "toggle", id: String(pournami.id) });
  check(redirected(r) && sql("SELECT is_active FROM videos WHERE id = ?", [pournami.id]).rows[0].is_active === 0 && audits("video_toggled", `video:${pournami.id}`) === 1, "toggle hides the video and is audited");
  r = await api("/api/videos");
  check(!r.json.videos.some((v) => v.id === pournami.id) && r.json.featured?.id !== pournami.id, "a hidden video leaves the public feed even when featured");
  r = await owner.get("/admin/videos.php?f=hidden");
  check(r.text.includes(`${P} Pournami Pooja (edited)`), "Hidden filter lists it");
  r = await owner.get("/admin/videos.php?f=active");
  check(!r.text.includes(`${P} Pournami Pooja (edited)`), "Shown filter omits it");
  await act({ action: "toggle", id: String(pournami.id) });
  r = await api("/api/videos");
  check(r.json.videos.some((v) => v.id === pournami.id) && r.json.featured?.id === pournami.id, "toggle shows it again and it is featured once more");
  r = await act({ action: "toggle", id: "987654321" });
  check(redirected(r) && audits("video_toggled", "video:987654321") === 0, "toggling a missing id is a no-op");

  /* ── categories ─────────────────────────────────────────────────────── */
  const catPost = (fields, s = owner, token = csrf) => s.post("/admin/videos.php", { _csrf: token, action: "cat_save", ...fields });
  r = await catPost({ cat_id: "0", cat_name_ta: "", cat_name_en: `${P} no tamil cat` });
  check(redirected(r) && !findCat(`${P} no tamil cat`), "a category without a Tamil name is refused");
  r = await catPost({ cat_id: "0", cat_name_ta: `${P} சொற்பொழிவு`, cat_name_en: `${P} Discourses`, cat_sort_order: "50" });
  const cat = findCat(`${P} Discourses`);
  check(redirected(r) && cat && cat.name_ta === `${P} சொற்பொழிவு` && cat.sort_order === 50 && cat.is_active === 1 && /^e2e-video-[a-z0-9]+-discourses$/.test(cat.slug), "category created with Tamil name and a slug from the English name", JSON.stringify(cat));
  createdCatIds.push(cat.id);
  check(audits("video_category_created", `video_category:${cat.id}`) === 1, "category creation is audited");
  r = await catPost({ cat_id: "0", cat_name_ta: `${P} சொற்பொழிவு 2`, cat_name_en: `${P} Discourses` });
  const twinCat = sql("SELECT * FROM video_categories WHERE name_en = ? AND id <> ?", [`${P} Discourses`, cat.id]).rows[0];
  check(redirected(r) && twinCat && twinCat.slug !== cat.slug && twinCat.slug.startsWith(cat.slug), "same English name → distinct slug", JSON.stringify(twinCat));
  createdCatIds.push(twinCat.id);
  r = await catPost({ cat_id: String(cat.id), cat_name_ta: `${P} உபன்யாசம்`, cat_name_en: `${P} Discourses (edited)`, cat_sort_order: "51" });
  edited = sql("SELECT * FROM video_categories WHERE id = ?", [cat.id]).rows[0];
  check(redirected(r) && edited.name_en === `${P} Discourses (edited)` && edited.name_ta === `${P} உபன்யாசம்` && edited.sort_order === 51 && edited.slug === cat.slug && audits("video_category_updated", `video_category:${cat.id}`) === 1, "category edit persisted; slug unchanged; audited", JSON.stringify(edited));

  /* move a video into it, then hide the category */
  r = await save({ id: String(made[YT.d].id), youtube: YT.d, title_ta: `${P} bare id with whitespace த`, title_en: `${P} bare id with whitespace`, category_id: String(cat.id), sort_order: "10", is_active: "1" });
  check(redirected(r) && sql("SELECT category_id FROM videos WHERE id = ?", [made[YT.d].id]).rows[0].category_id === cat.id, "a video can be moved to the new category");
  r = await api("/api/videos");
  check(r.json.videos.some((v) => v.id === made[YT.d].id && v.category?.slug === cat.slug) && r.json.categories.some((c) => c.slug === cat.slug && c.count === 1), "public feed shows the new category with its count");
  r = await act({ action: "cat_delete", cat_id: String(cat.id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM video_categories WHERE id = ?", [cat.id]).rows[0].n === 1, "a category with videos is not deleted");
  r = await owner.get("/admin/videos.php");
  check(/cannot be deleted\. Hide it/.test(r.text), "…and the admin is told to hide it or move the videos");
  r = await act({ action: "cat_toggle", cat_id: String(cat.id) });
  check(redirected(r) && sql("SELECT is_active FROM video_categories WHERE id = ?", [cat.id]).rows[0].is_active === 0 && audits("video_category_toggled", `video_category:${cat.id}`) === 1, "category toggle hides it and is audited");
  r = await api("/api/videos");
  check(!r.json.videos.some((v) => v.id === made[YT.d].id) && !r.json.categories.some((c) => c.slug === cat.slug), "a hidden category hides its videos and itself from the public feed");
  r = await api("/api/videos?category=" + cat.slug);
  check(r.json.videos.length === 0, "filtering by a hidden category answers nothing");
  await act({ action: "cat_toggle", cat_id: String(cat.id) });
  r = await api("/api/videos");
  check(r.json.videos.some((v) => v.id === made[YT.d].id), "showing the category brings its videos back");
  r = await act({ action: "cat_delete", cat_id: String(twinCat.id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM video_categories WHERE id = ?", [twinCat.id]).rows[0].n === 0 && audits("video_category_deleted", `video_category:${twinCat.id}`) === 1, "an empty category is deleted and audited");

  /* ── E2E-047/048: hostile payloads are data ─────────────────────────── */
  r = await save({ id: "0", youtube: `https://www.youtube.com/watch?v=${YT.a}`, title_ta: XSS, title_en: SQLI, description_en: XSS, description_ta: SQLI, is_active: "1" });
  check(r.status === 200 && /already listed/.test(r.text) && !r.text.includes("<script>alert(1)</script>"), "E2E-048 hostile titles echoed back into the form are escaped");
  const dupCheck = await save({ id: "0", youtube: YT.a, title_ta: "த", title_en: `${P} dup again`, is_active: "1" });
  check(dupCheck.text.includes("&quot;&gt;") || !dupCheck.text.includes(`<script>alert`), "E2E-048 duplicate message never renders markup");
  r = await act({ action: "cat_save", cat_id: "0", cat_name_ta: XSS, cat_name_en: SQLI });
  const hostileCat = sql("SELECT * FROM video_categories WHERE name_en = ?", [SQLI]).rows[0];
  check(redirected(r) && hostileCat && !/<script|onerror/.test(hostileCat.name_ta) && hostileCat.name_ta.startsWith(P), "E2E-047 the SQL payload is stored verbatim (table still exists); tags are stripped on save", JSON.stringify(hostileCat));
  createdCatIds.push(hostileCat.id);
  const hostileYt = `E2Eh${RUN}`.padEnd(11, "x").slice(0, 11);
  r = await save({ id: "0", youtube: hostileYt, title_ta: XSS, title_en: SQLI, description_en: XSS, description_ta: SQLI, category_id: String(hostileCat.id), is_active: "1" });
  const hostile = sql("SELECT * FROM videos WHERE title_en = ?", [SQLI]).rows[0];
  check(redirected(r) && hostile && hostile.title_en === SQLI && !/<script|onerror/.test(hostile.title_ta + hostile.description_en), "E2E-047 hostile video stored as text", JSON.stringify(hostile));
  check(sql("SELECT COUNT(*) AS n FROM videos WHERE title_en LIKE ?", [`${P}%`]).rows[0].n === 6, "E2E-047 exactly one row was written");
  r = await owner.get("/admin/videos.php");
  check(!r.text.includes("<script>alert(1)</script>") && !r.text.includes("onerror=alert(2)>") && r.text.includes("&#039;); DROP TABLE"), "E2E-048 admin list shows the payload escaped, never as markup");
  r = await owner.get(`/admin/videos.php?edit=${hostile.id}`);
  check(!r.text.includes("<script>alert(1)</script>") && !/<img src=x onerror/.test(r.text), "E2E-048 edit form escapes the payload");
  r = await api("/api/videos");
  check(r.json.videos.some((v) => v.id === hostile.id && v.title_en === SQLI) && !/<script/.test(r.text), "E2E-048 API returns the stored text as a JSON string; no script tag anywhere");
  r = await owner.get("/admin/videos.php?q=" + encodeURIComponent(SQLI) + "&c=" + encodeURIComponent(SQLI) + "&f=" + encodeURIComponent(XSS));
  check(r.status === 200 && !FATAL.test(r.text) && !r.text.includes("<script>alert(1)</script>"), "E2E-047 hostile filter parameters are harmless");
  r = await api("/api/search?q=" + encodeURIComponent(`${P}'); DROP`));
  check(r.status === 200 && !/<script/.test(r.text), "E2E-047 hostile search is harmless");

  /* ── live-stream recording link ─────────────────────────────────────── */
  const stream = fixture("create-stream", { title_prefix: P, label: "recording", status: "COMPLETED", provider_reference: YT.b + "", actor: ACTOR });
  check(stream.id > 0 && stream.status === "COMPLETED", "fixture: a COMPLETED stream exists", JSON.stringify(stream));
  r = await owner.get("/admin/videos.php");
  check(r.text.includes(`<option value="${stream.id}"`), "the completed stream is offered in the recording picker");
  /* blank link + stream → inherits the broadcast id, which YT.b already uses → duplicate */
  r = await save({ id: "0", youtube: "", title_ta: "த", title_en: `${P} inherited dup`, live_stream_id: String(stream.id), is_active: "1" });
  check(r.status === 200 && /already listed/.test(r.text) && !findVideo(`${P} inherited dup`), "a blank link inherits the stream's recording id (refused here because it is already listed)");
  r = await save({ id: String(made[YT.b].id), youtube: YT.b, title_ta: `${P} youtu.be short link த`, title_en: `${P} youtu.be short link`, category_id: String(seededCat.id), live_stream_id: String(stream.id), sort_order: "10", is_active: "1" });
  check(redirected(r) && sql("SELECT live_stream_id FROM videos WHERE id = ?", [made[YT.b].id]).rows[0].live_stream_id === stream.id, "a video can be linked to the completed stream");
  r = await api("/api/videos");
  const linked = r.json.videos.find((v) => v.id === made[YT.b].id);
  check(linked && linked.live_stream_slug === stream.slug, "public feed carries the stream slug for the archive link", JSON.stringify(linked));
  const fresh = fixture("create-stream", { title_prefix: P, label: "fresh", status: "COMPLETED", provider_reference: `E2Ef${RUN}`.padEnd(11, "x").slice(0, 11), actor: ACTOR });
  r = await save({ id: "0", youtube: "", title_ta: `${P} பதிவு`, title_en: `${P} inherited`, live_stream_id: String(fresh.id), is_active: "1" });
  const inherited = findVideo(`${P} inherited`);
  check(redirected(r) && inherited && inherited.youtube_id === `E2Ef${RUN}`.padEnd(11, "x").slice(0, 11) && inherited.live_stream_id === fresh.id, "a blank link inherits the stream's recording id", JSON.stringify(inherited));
  fixture("cleanup", { title_prefix: P, actors: [ACTOR] });
  check(sql("SELECT COUNT(*) AS n FROM live_streams WHERE id IN (?, ?)", [stream.id, fresh.id]).rows[0].n === 0, "fixture streams removed");
  rows = sql("SELECT live_stream_id FROM videos WHERE id IN (?, ?)", [made[YT.b].id, inherited.id]).rows;
  check(rows.length === 2 && rows.every((x) => x.live_stream_id === null), "deleting a stream keeps its videos and clears the link (FK SET NULL)", JSON.stringify(rows));
  r = await api("/api/videos");
  check(r.status === 200 && r.json.videos.find((v) => v.id === made[YT.b].id)?.live_stream_slug === null, "public feed still lists the video without a stream slug");

  /* ── site search ────────────────────────────────────────────────────── */
  r = await api("/api/search?q=" + encodeURIComponent(`${P} Pournami`));
  let group = r.json?.groups?.find((g) => g.type === "videos");
  check(r.status === 200 && group && group.items.some((i) => i.title_en === `${P} Pournami Pooja (edited)` && i.url === "/videos?category=poojas" && i.sub_ta === "பூஜைகள்"), "search finds the video by English title and links to its category", JSON.stringify(r.json?.groups?.map((g) => g.type)));
  check(group.label_ta === "காணொளிகள்" && group.label_en === "Videos", "videos search group is labelled in both languages", JSON.stringify(group));
  r = await api("/api/search?q=" + encodeURIComponent("பௌர்ணமி பூஜை (திருத்தம்)"));
  group = r.json?.groups?.find((g) => g.type === "videos");
  check(group && group.items.some((i) => i.title_ta === `${P} பௌர்ணமி பூஜை (திருத்தம்)`), "search finds the video by Tamil title");
  await act({ action: "toggle", id: String(pournami.id) });
  r = await api("/api/search?q=" + encodeURIComponent(`${P} Pournami`));
  check(!r.json?.groups?.find((g) => g.type === "videos")?.items.some((i) => i.title_en === `${P} Pournami Pooja (edited)`), "a hidden video is not searchable");
  await act({ action: "toggle", id: String(pournami.id) });
  r = await api("/api/search?q=videos");
  check(r.json?.groups?.find((g) => g.type === "pages")?.items.some((i) => i.url === "/videos"), "the Videos page itself is a search result");
  r = await api("/sitemap.xml");
  check(r.status === 200 && r.text.includes("/videos</loc>"), "/videos is in the sitemap");

  /* ── delete ─────────────────────────────────────────────────────────── */
  r = await act({ action: "delete", id: String(made[YT.c].id) });
  check(redirected(r) && sql("SELECT COUNT(*) AS n FROM videos WHERE id = ?", [made[YT.c].id]).rows[0].n === 0 && audits("video_deleted", `video:${made[YT.c].id}`) === 1, "delete removes the video and is audited");
  r = await api("/api/videos");
  check(!r.json.videos.some((v) => v.id === made[YT.c].id), "a deleted video leaves the public feed");
  r = await save({ id: "0", youtube: YT.c, title_ta: "த", title_en: `${P} reuse id`, is_active: "1" });
  check(redirected(r) && findVideo(`${P} reuse id`)?.youtube_id === YT.c, "the freed id can be listed again");

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
  r = await sessions.editor.get("/admin/videos.php");
  check(r.status === 200 && r.text.includes(`${P} Pournami Pooja (edited)`), "E2E-013 editor (content.edit) opens the Videos page", `${r.status}`);
  const edCsrf = csrfOf(r.text);
  r = await save({ id: "0", youtube: `E2Ee${RUN}`.padEnd(11, "x").slice(0, 11), title_ta: `${P} ஆசிரியர்`, title_en: `${P} by editor`, is_active: "1" }, sessions.editor, edCsrf);
  const byEditor = findVideo(`${P} by editor`);
  check(redirected(r) && !!byEditor, "E2E-013 editor can add a video");
  for (const role of ["finance", "viewer"]) {
    r = await sessions[role].get("/admin/videos.php");
    check(r.status === 403, `E2E-013 ${role} gets 403 on the Videos page`, `${r.status}`);
    r = await sessions[role].post("/admin/videos.php", { _csrf: "x", action: "toggle", id: String(byEditor.id) });
    check(r.status === 403 && sql("SELECT is_active FROM videos WHERE id = ?", [byEditor.id]).rows[0].is_active === 1, `E2E-046 ${role} POST is refused server-side`, `${r.status}`);
    r = await sessions[role].post("/admin/videos.php", { _csrf: "x", action: "cat_delete", cat_id: String(cat.id) });
    check(r.status === 403 && sql("SELECT COUNT(*) AS n FROM video_categories WHERE id = ?", [cat.id]).rows[0].n === 1, `E2E-046 ${role} cannot touch categories`, `${r.status}`);
  }

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\nvideos: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\nvideos: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  try { fixture("cleanup", { title_prefix: P, actors: [ACTOR] }); } catch (e) { console.error(e.message); }
  sql("DELETE FROM videos WHERE title_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM video_categories WHERE name_en LIKE ?", [`${P}%`]);
  sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2evideo_${RUN}_%`]);
  sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ?", [`%${P}%`, `%${P}%`, `e2evideo_${RUN}_%`]);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
