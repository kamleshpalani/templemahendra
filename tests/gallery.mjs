#!/usr/bin/env node
/**
 * tests/gallery.mjs — Photo gallery (brief §6 Gallery, §19, §22 alt text,
 * §34 image loading): /admin/gallery.php, GET /api/gallery and
 * GET /api/gallery/albums.
 *
 *   migration 021: gallery_albums (utf8mb4 InnoDB, unique slug, seeded with
 *   the brief's albums), the new gallery columns, FKs album → albums,
 *   album.cover → gallery, album.event → events, all ON DELETE SET NULL
 *   admin page needs a session (E2E-045) and content.edit: editor 200,
 *   finance/viewer 403 (E2E-013/046); forged CSRF writes nothing (E2E-049)
 *   album create (slug from the English title, Tamil intact) / edit / hide /
 *   reorder / delete (refused while photos remain) / event link / cover pick
 *   upload of a real PNG and JPEG: random stored name from the decoded type,
 *   a ~480 px thumb and a ~1280 px medium WebP on disk with the right
 *   dimensions, never upscaled; disguised PHP and GIF still refused (E2E-023)
 *   per-photo edit of caption / alt text (ta, en) / album / shown; move
 *   between albums; hide/show; delete removes all three files
 *   /api/gallery: flat list with the new keys, ?album=<slug|id>, ?limit=,
 *   hidden photos and hidden albums left out, junk parameters a clean 422;
 *   /api/gallery/albums: shown albums with a photo, counts and cover thumb
 *   SQL and script payloads are stored as data and escaped (E2E-047/048)
 *   gallery_* audit rows for every write
 *
 *   node tests/gallery.mjs
 *
 * Starts its own PHP server (TRUSTED_PROXIES=127.0.0.1). Needs the DB_*
 * environment, migrations 015 and 021, PHP with GD, and the admin account
 * admin/Admin@Test123 (ADMIN_USERNAME / ADMIN_PASSWORD override). Everything
 * it writes carries the prefix "E2E-GAL-<run>" and is deleted in `finally`,
 * files included.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-GAL-${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const SQLI = `${P}'); DROP TABLE gallery;-- ' OR '1'='1`;
const XSS = `${P}"><script>alert(1)</script><img src=x onerror=alert(2)>`;
const ACCOUNTS = {
  editor:  { user: `e2egal_${RUN}_ed`, issued: "Kolam99Deep",  pw: "Vilakku42Raja" },
  finance: { user: `e2egal_${RUN}_fi`, issued: "Deepam55Fin",  pw: "Prasadam63Fx" },
  viewer:  { user: `e2egal_${RUN}_vw`, issued: "ViewOnly123X", pw: "QuietWatch42B" },
};
const PHOTO_KEYS = ["id", "filename", "caption", "created_at", "album_id", "album_slug", "alt_ta", "alt_en", "url", "thumb_url", "medium_url", "width", "height", "thumb_width", "medium_width"];
const ALBUM_KEYS = ["id", "slug", "title_ta", "title_en", "description_ta", "description_en", "event_id", "count", "cover"];
const uploads = resolve(root, "backend/uploads");

let checks = 0;
let log = "";
let server;
let base;
let xffN = 0;
const xff = () => `10.93.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
const check = (ok, label, detail = "") => { assert.ok(ok, detail ? `${label} — ${detail}` : label); checks++; };

function sql(query, params = []) {
  const result = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

/* Test pictures are drawn with GD so they are real, decodable images of a known size. */
const tmp = mkdtempSync(join(tmpdir(), "e2e-gallery-"));
function picture(name, w, h) {
  const file = join(tmp, name);
  const code = '$w=(int)$argv[1];$h=(int)$argv[2];$f=$argv[3];$im=imagecreatetruecolor($w,$h);'
    + 'imagefill($im,0,0,imagecolorallocate($im,200,80,40));'
    + 'imagefilledellipse($im,intdiv($w,2),intdiv($h,2),intdiv($w,2),intdiv($h,2),imagecolorallocate($im,255,220,120));'
    + 'str_ends_with($f,".jpg") ? imagejpeg($im,$f,85) : imagepng($im,$f);';
  const r = spawnSync(php, ["-r", code, String(w), String(h), file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return readFileSync(file);
}
/** [width, height, mime] of a file on disk, as PHP sees it. */
function sizeOf(file) {
  const r = spawnSync(php, ["-r", 'echo json_encode(@getimagesize($argv[1]) ?: null);', file], { encoding: "utf8" });
  const s = JSON.parse(r.stdout.trim() || "null");
  return s ? [s[0], s[1], s.mime] : null;
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
const findPhoto = (caption) => sql("SELECT * FROM gallery WHERE caption = ? ORDER BY id DESC LIMIT 1", [caption]).rows[0];
const photoById = (id) => sql("SELECT * FROM gallery WHERE id = ?", [id]).rows[0];
const findAlbum = (en) => sql("SELECT * FROM gallery_albums WHERE title_en = ? ORDER BY id DESC LIMIT 1", [en]).rows[0];
const albumById = (id) => sql("SELECT * FROM gallery_albums WHERE id = ?", [id]).rows[0];
const audits = (action, subject) => sql("SELECT COUNT(*) AS n FROM admin_activity WHERE action = ? AND subject = ?", [action, subject]).rows[0].n;
const onDisk = (name) => Boolean(name) && existsSync(resolve(uploads, name));
/* The photo grid alone: the album cover pickers at the foot of the page list every album's captions. */
const grid = (html) => { const s = html.indexOf('class="gallery-admin-grid"'); const e = html.indexOf('id="albums"'); return s >= 0 ? html.slice(s, e > s ? e : undefined) : ""; };
const createdEventIds = [];

try {
  /* ── schema (brief §25/§33) ─────────────────────────────────────────── */
  let rows = sql("SELECT TABLE_NAME AS t, TABLE_COLLATION AS c, ENGINE AS e FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('gallery','gallery_albums')").rows;
  check(rows.length === 2 && rows.every((r) => /^utf8mb4/.test(r.c) && r.e === "InnoDB"), "migration 021: gallery and gallery_albums are utf8mb4 InnoDB", JSON.stringify(rows));
  rows = sql("SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery'").rows.map((r) => r.c);
  for (const col of ["album_id", "alt_ta", "alt_en", "thumb_filename", "medium_filename", "width", "height", "updated_at", "caption", "filename"]) {
    check(rows.includes(col), `gallery has ${col}`, rows.join());
  }
  rows = sql("SELECT INDEX_NAME AS i, NON_UNIQUE AS nu, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gallery_albums' GROUP BY INDEX_NAME, NON_UNIQUE").rows;
  check(rows.some((r) => r.cols === "slug" && Number(r.nu) === 0), "album slug is unique", JSON.stringify(rows));
  rows = sql("SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('gallery','gallery_albums') AND REFERENCED_TABLE_NAME IS NOT NULL").rows;
  check(rows.some((r) => r.t === "gallery" && r.c === "album_id" && r.rt === "gallery_albums"), "FK gallery.album_id → gallery_albums", JSON.stringify(rows));
  check(rows.some((r) => r.t === "gallery_albums" && r.c === "cover_image_id" && r.rt === "gallery"), "FK gallery_albums.cover_image_id → gallery", JSON.stringify(rows));
  check(rows.some((r) => r.t === "gallery_albums" && r.c === "event_id" && r.rt === "events"), "FK gallery_albums.event_id → events", JSON.stringify(rows));
  rows = sql("SELECT DELETE_RULE AS d FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME IN ('fk_gallery_album','fk_gallery_album_cover','fk_gallery_album_event')").rows;
  check(rows.length === 3 && rows.every((r) => r.d === "SET NULL"), "all three FKs are ON DELETE SET NULL", JSON.stringify(rows));
  const seeded = sql("SELECT * FROM gallery_albums WHERE slug = 'pournami-pooja'").rows[0];
  check(seeded && seeded.title_ta === "பௌர்ணமி பூஜை" && seeded.title_en === "Pournami Pooja" && seeded.is_active === 1, "seeded Pournami Pooja album keeps its Tamil title", JSON.stringify(seeded));
  check(sql("SELECT COUNT(*) AS n FROM gallery_albums WHERE slug IN ('pournami-pooja','navaratri','temple-festival','kumbabhishekam','annadhanam')").rows[0].n === 5, "the brief's five albums are seeded");

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
    try { ready = (await fetch(`${base}/api/gallery`)).ok; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  check(ready, "PHP server started");

  /* ── public baseline ────────────────────────────────────────────────── */
  let r = await api("/api/gallery");
  check(r.status === 200 && Array.isArray(r.json), "GET /api/gallery answers a flat array", `${r.status} ${r.text.slice(0, 80)}`);
  check(/charset=utf-8/i.test(r.headers.get("content-type") ?? ""), "feed is UTF-8 JSON");
  r = await api("/api/gallery/albums");
  check(r.status === 200 && Array.isArray(r.json), "GET /api/gallery/albums answers a flat array", `${r.status} ${r.text.slice(0, 80)}`);
  const seededBefore = r.json.find((a) => a.slug === "pournami-pooja");
  r = await api("/api/gallery?album=" + encodeURIComponent("' OR 1=1 --"));
  check(r.status === 422 && r.json && typeof r.json.error === "string" && !/SQLSTATE/.test(r.text), "E2E-047 a junk album parameter gets a clean 422", `${r.status} ${r.text.slice(0, 80)}`);
  r = await api("/api/gallery?limit=0");
  check(r.status === 422, "limit=0 is refused");
  r = await api("/api/gallery?limit=201");
  check(r.status === 422, "limit above 200 is refused");
  r = await api("/api/gallery?album=no-such-album-" + RUN);
  check(r.status === 200 && r.json.length === 0, "an unknown album slug answers an empty list, not an error");
  r = await api("/api/gallery/albums?limit=abc");
  check(r.status === 422, "the albums route validates the same parameters");

  /* ── E2E-045: no session ────────────────────────────────────────────── */
  const anon = jar();
  r = await anon.get("/admin/gallery.php");
  check(redirected(r) && /login\.php/.test(r.headers.get("location") ?? ""), "E2E-045 admin gallery page redirects to sign-in", `${r.status}`);
  r = await anon.post("/admin/gallery.php", { action: "album_save", album_id: "0", album_title_ta: `${P} அனாமதேய`, album_title_en: `${P} anonymous` });
  check(!findAlbum(`${P} anonymous`), "E2E-045 an anonymous POST writes nothing");

  /* ── owner signs in ─────────────────────────────────────────────────── */
  const owner = jar();
  r = await owner.login(ADMIN.username, ADMIN.password);
  check(redirected(r) && !/login\.php/.test(r.headers.get("location") ?? ""), "E2E-011 owner signed in", `${r.status} ${flashOf(r.text)}`);
  r = await owner.get("/admin/gallery.php");
  check(r.status === 200 && !FATAL.test(r.text), "gallery page renders for the owner", `${r.status}`);
  check(/name="image"/.test(r.text) && /name="caption"/.test(r.text) && /name="alt_ta"/.test(r.text) && /name="alt_en"/.test(r.text) && /name="album_id"/.test(r.text), "upload form has photo, caption, Tamil/English alt text and an album picker");
  check(/name="album_title_ta"/.test(r.text) && /name="album_title_en"/.test(r.text) && /name="album_event_id"/.test(r.text) && /name="album_cover_id"/.test(r.text), "album editor with Tamil/English titles, event and cover pickers is on the page");
  check(r.text.includes("Pournami Pooja") && r.text.includes("பௌர்ணமி பூஜை"), "seeded albums are listed in both languages");
  let csrf = csrfOf(r.text);
  check(csrf.length >= 32, "CSRF token issued");
  const act = (fields, s = owner, token = csrf) => s.post("/admin/gallery.php", { _csrf: token, ...fields });
  const albumPost = (fields, s = owner, token = csrf) => s.post("/admin/gallery.php", { _csrf: token, action: "album_save", ...fields });
  const upload = (bytes, filename, fields, s = owner, token = csrf, mime = "image/png") => {
    const form = new FormData();
    form.set("_csrf", token); form.set("action", "upload");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    form.set("image", new Blob([bytes], { type: mime }), filename);
    return s.post("/admin/gallery.php", form);
  };

  /* ── E2E-049: CSRF ──────────────────────────────────────────────────── */
  const galleryBefore = sql("SELECT COUNT(*) AS n FROM gallery").rows[0].n;
  r = await albumPost({ album_id: "0", album_title_ta: `${P} போலி`, album_title_en: `${P} forged` }, owner, "forged-" + csrf.slice(0, 20));
  check(r.status === 200 && /tampered with/.test(r.text) && !findAlbum(`${P} forged`), "E2E-049 forged token is refused with a message", `${r.status}`);
  r = await owner.post("/admin/gallery.php", { action: "album_save", album_id: "0", album_title_ta: `${P} போலி`, album_title_en: `${P} no token` });
  const smallPng = picture("small.png", 200, 100);
  r = await upload(smallPng, "photo.png", { caption: `${P} no token upload` }, owner, "x".repeat(40));
  check(!findAlbum(`${P} no token`) && !findPhoto(`${P} no token upload`) && sql("SELECT COUNT(*) AS n FROM gallery").rows[0].n === galleryBefore, "E2E-049 forged and missing tokens wrote nothing");

  /* ── albums ─────────────────────────────────────────────────────────── */
  r = await albumPost({ album_id: "0", album_title_ta: "", album_title_en: `${P} no tamil` });
  check(redirected(r) && !findAlbum(`${P} no tamil`), "an album without a Tamil title is refused");
  r = await albumPost({ album_id: "0", album_title_ta: `${P} த`, album_title_en: `${P} bad order`, album_sort_order: "abc" });
  check(redirected(r) && !findAlbum(`${P} bad order`), "a non-numeric order is refused");
  r = await albumPost({ album_id: "0", album_title_ta: `${P} த`, album_title_en: `${P} bad event`, album_event_id: "999999999" });
  check(redirected(r) && !findAlbum(`${P} bad event`), "an unknown event is refused");

  sql("INSERT INTO events (title_ta, title_en, event_date, is_active) VALUES (?, ?, ?, 1)", [`${P} நவராத்திரி`, `${P} Navaratri 2026`, "2026-10-12"]);
  const event = sql("SELECT id FROM events WHERE title_en = ?", [`${P} Navaratri 2026`]).rows[0];
  createdEventIds.push(event.id);
  const TA_DESC = "நவராத்திரி ஒன்பது நாள் கொலு மற்றும் அம்மன் அலங்காரம்.";
  r = await albumPost({ album_id: "0", album_title_ta: `${P} நவராத்திரி`, album_title_en: `${P} Navaratri`, album_description_ta: TA_DESC, album_description_en: "Nine nights of kolu and alankaram.", album_event_id: String(event.id), album_sort_order: "70" });
  const nav = findAlbum(`${P} Navaratri`);
  check(redirected(r) && nav && nav.title_ta === `${P} நவராத்திரி` && nav.description_ta === TA_DESC && nav.event_id === event.id && nav.sort_order === 70 && nav.is_active === 1 && /^e2e-gal-[a-z0-9]+-navaratri$/.test(nav.slug), "E2E-003 album created with Tamil title and description, event link, order and a slug from the English title", JSON.stringify(nav));
  check(audits("gallery_album_created", `gallery_album:${nav.id}`) === 1, "album creation is audited");
  r = await albumPost({ album_id: "0", album_title_ta: `${P} நவராத்திரி 2`, album_title_en: `${P} Navaratri` });
  const twin = sql("SELECT * FROM gallery_albums WHERE title_en = ? AND id <> ?", [`${P} Navaratri`, nav.id]).rows[0];
  check(redirected(r) && twin && twin.slug !== nav.slug && twin.slug.startsWith(nav.slug), "same English title → distinct slug", JSON.stringify(twin));
  r = await albumPost({ album_id: "0", album_title_ta: `${P} அன்னதானம்`, album_title_en: `${P} Annadhanam`, album_sort_order: "80" });
  const anna = findAlbum(`${P} Annadhanam`);
  check(redirected(r) && anna, "a second album exists");
  r = await albumPost({ album_id: String(nav.id), album_title_ta: `${P} நவராத்திரி (திருத்தம்)`, album_title_en: `${P} Navaratri (edited)`, album_description_ta: TA_DESC, album_description_en: "edited", album_event_id: String(event.id), album_sort_order: "71" });
  let edited = albumById(nav.id);
  check(redirected(r) && edited.title_en === `${P} Navaratri (edited)` && edited.title_ta === `${P} நவராத்திரி (திருத்தம்)` && edited.sort_order === 71 && edited.slug === nav.slug && audits("gallery_album_updated", `gallery_album:${nav.id}`) === 1, "album edit persisted; slug unchanged; audited", JSON.stringify(edited));
  r = await albumPost({ album_id: String(nav.id), album_title_ta: "த", album_title_en: `${P} Navaratri (edited)`, album_cover_id: "999999999" });
  check(redirected(r) && albumById(nav.id).cover_image_id === null && albumById(nav.id).title_ta !== "த", "a cover that is not one of the album's photos is refused and nothing changes");
  r = await api("/api/gallery/albums");
  check(!r.json.some((a) => a.id === nav.id), "an album without photos is not listed publicly");

  /* ── E2E-021/022/023: uploads ───────────────────────────────────────── */
  r = await upload(new Uint8Array(Buffer.from("<?php echo 'owned'; ?>")), "shell.php.jpg", { caption: `${P} disguised` }, owner, csrf, "image/jpeg");
  check(r.status === 200 && /Only JPEG, PNG and WebP/.test(r.text) && !findPhoto(`${P} disguised`), "E2E-023 a PHP file with an image name and MIME is refused", `${r.status}`);
  r = await upload(new Uint8Array(Buffer.from("GIF89a not really")), "photo.gif", { caption: `${P} gif` }, owner, csrf, "image/gif");
  check(/Only JPEG, PNG and WebP/.test(r.text) && !findPhoto(`${P} gif`), "E2E-023 an unsupported image type is refused");
  r = await upload(smallPng, "photo.png", { caption: `${P} bad album`, album_id: "999999999" });
  check(r.status === 200 && /listed albums/.test(r.text) && !findPhoto(`${P} bad album`), "an unknown album on upload is refused and re-fills the form", `${r.status}`);
  check(r.text.includes(`value="${P} bad album"`), "…keeping the caption typed");

  const bigPng = picture("big.png", 1600, 1000);
  const ALT_TA = "மலர் அலங்காரத்தில் அம்மன் — நவராத்திரி முதல் நாள்";
  r = await upload(bigPng, "../../evil.php", { caption: `${P} big png`, alt_ta: ALT_TA, alt_en: "The Amman in floral alankaram on the first night", album_id: String(nav.id) });
  const big = findPhoto(`${P} big png`);
  check(redirected(r) && big && /^[a-f0-9]{24}\.png$/.test(big.filename), "E2E-021 stored under a random name with the decoded type's extension", JSON.stringify(big));
  check(big.alt_ta === ALT_TA && big.alt_en === "The Amman in floral alankaram on the first night" && big.album_id === nav.id && big.is_active === 1, "E2E-003 alt text (Tamil intact) and album stored", JSON.stringify(big));
  check(big.width === 1600 && big.height === 1000, "original dimensions recorded", `${big.width}×${big.height}`);
  check(/^[a-f0-9]{24}-thumb\.(webp|jpg)$/.test(big.thumb_filename) && /^[a-f0-9]{24}-medium\.(webp|jpg)$/.test(big.medium_filename), "thumb and medium file names derive from the original's random stem", `${big.thumb_filename} ${big.medium_filename}`);
  check(onDisk(big.filename) && onDisk(big.thumb_filename) && onDisk(big.medium_filename), "E2E-021 original, thumb and medium are on disk");
  let size = sizeOf(resolve(uploads, big.thumb_filename));
  check(size && size[0] === 480 && size[1] === 300 && /^image\/(webp|jpeg)$/.test(size[2]), "thumb is 480 px wide with the aspect kept", JSON.stringify(size));
  size = sizeOf(resolve(uploads, big.medium_filename));
  check(size && size[0] === 1280 && size[1] === 800, "medium is 1280 px wide with the aspect kept", JSON.stringify(size));
  check(audits("gallery_uploaded", `gallery:${big.id}`) === 1, "upload is audited");
  r = await owner.get(`/uploads/${big.thumb_filename}`);
  check(r.status === 200 && /^image\/(webp|jpeg)/.test(r.headers.get("content-type") ?? ""), "E2E-022 the thumb is served as an image", r.headers.get("content-type") ?? "");
  r = await owner.get(`/uploads/${big.filename}`);
  check(r.status === 200 && /^image\/png/.test(r.headers.get("content-type") ?? ""), "E2E-022 the original is still served as an image");

  const jpg = picture("photo.jpg", 900, 600);
  r = await upload(jpg, "IMG_0001.JPG", { caption: `${P} jpeg`, alt_en: "Deepam row at dusk", album_id: String(nav.id) }, owner, csrf, "application/octet-stream");
  const jpeg = findPhoto(`${P} jpeg`);
  check(redirected(r) && jpeg && /\.jpg$/.test(jpeg.filename) && jpeg.width === 900 && onDisk(jpeg.thumb_filename) && onDisk(jpeg.medium_filename), "a JPEG sent as octet-stream is typed from its bytes and gets variants", JSON.stringify(jpeg));
  size = sizeOf(resolve(uploads, jpeg.medium_filename));
  check(size && size[0] === 900 && size[1] === 600, "a 900 px source is never upscaled: medium stays 900 px", JSON.stringify(size));
  size = sizeOf(resolve(uploads, jpeg.thumb_filename));
  check(size && size[0] === 480 && size[1] === 320, "…while its thumb is 480 px", JSON.stringify(size));

  r = await upload(smallPng, "tiny.png", { caption: `${P} small`, album_id: String(anna.id) });
  const small = findPhoto(`${P} small`);
  check(redirected(r) && small && small.album_id === anna.id && small.alt_ta === null && small.alt_en === null, "a small photo without alt text is stored with NULL alt", JSON.stringify(small));
  size = sizeOf(resolve(uploads, small.thumb_filename));
  check(size && size[0] === 200 && size[1] === 100, "a 200 px source keeps 200 px for its thumb", JSON.stringify(size));
  r = await upload(smallPng, "unfiled.png", { caption: `${P} unfiled` });
  const unfiled = findPhoto(`${P} unfiled`);
  check(redirected(r) && unfiled && unfiled.album_id === null, "a photo can be uploaded without an album", JSON.stringify(unfiled));
  r = await owner.get("/admin/gallery.php");
  check(r.text.includes(`${P} big png`) && r.text.includes(big.thumb_filename) && /No alt text/.test(r.text), "admin grid uses the thumb and flags photos without alt text");
  r = await owner.get(`/admin/gallery.php?a=${nav.id}`);
  check(grid(r.text).includes(`${P} big png`) && grid(r.text).includes(`${P} jpeg`) && !grid(r.text).includes(`${P} small`), "album filter narrows the admin list");
  r = await owner.get("/admin/gallery.php?a=none");
  check(grid(r.text).includes(`${P} unfiled`) && !grid(r.text).includes(`${P} big png`), "Unfiled filter lists photos without an album");
  r = await owner.get("/admin/gallery.php?q=" + encodeURIComponent("மலர் அலங்காரத்தில்"));
  check(grid(r.text).includes(`${P} big png`) && !grid(r.text).includes(`${P} jpeg`), "search by Tamil alt text finds the photo");

  /* ── public feed ────────────────────────────────────────────────────── */
  r = await api("/api/gallery");
  const pub = r.json.find((g) => g.id === big.id);
  check(pub && Object.keys(pub).sort().join() === [...PHOTO_KEYS].sort().join(), "a public photo exposes exactly the documented keys", Object.keys(pub ?? {}).join());
  check(pub.caption === `${P} big png` && pub.filename === big.filename && pub.alt_ta === ALT_TA && pub.album_id === nav.id && pub.album_slug === nav.slug, "public photo carries caption, alt text with Tamil intact, album id and slug", JSON.stringify(pub));
  check(pub.url === `/uploads/${big.filename}` && pub.thumb_url === `/uploads/${big.thumb_filename}` && pub.medium_url === `/uploads/${big.medium_filename}` && pub.width === 1600 && pub.height === 1000 && pub.thumb_width === 480 && pub.medium_width === 1280, "public photo carries url, thumb_url, medium_url and the widths for srcset", JSON.stringify(pub));
  check(r.json[0].id === unfiled.id, "newest first");
  const sm = r.json.find((g) => g.id === small.id);
  check(sm && sm.thumb_width === 200 && sm.medium_width === 200, "a small photo reports its own width for both variants");
  r = await api("/api/gallery?album=" + nav.slug);
  check(r.status === 200 && r.json.length === 2 && r.json.every((g) => g.album_id === nav.id), "?album=<slug> lists only that album");
  r = await api("/api/gallery?album=" + nav.id);
  check(r.status === 200 && r.json.length === 2 && r.json.every((g) => g.album_slug === nav.slug), "?album=<id> works too");
  r = await api("/api/gallery?limit=2");
  check(r.status === 200 && r.json.length === 2 && r.json[0].id === unfiled.id, "?limit=2 answers the two newest (the homepage strip)");
  r = await api("/api/gallery/albums");
  const pubAlbum = r.json.find((a) => a.id === nav.id);
  check(pubAlbum && Object.keys(pubAlbum).sort().join() === [...ALBUM_KEYS].sort().join(), "a public album exposes exactly the documented keys", Object.keys(pubAlbum ?? {}).join());
  check(pubAlbum.slug === nav.slug && pubAlbum.title_ta === `${P} நவராத்திரி (திருத்தம்)` && pubAlbum.description_ta === TA_DESC && pubAlbum.event_id === event.id && pubAlbum.count === 2, "album has Tamil title and description, event and photo count", JSON.stringify(pubAlbum));
  check(pubAlbum.cover && pubAlbum.cover.id === jpeg.id && pubAlbum.cover.thumb_url === `/uploads/${jpeg.thumb_filename}` && pubAlbum.cover.alt_en === "Deepam row at dusk", "with no cover chosen, the newest photo is the cover", JSON.stringify(pubAlbum.cover));
  const annaPub = r.json.find((a) => a.id === anna.id);
  check(annaPub && annaPub.count === 1 && annaPub.cover?.id === small.id, "the second album counts its one photo");
  check(r.json.findIndex((a) => a.id === nav.id) < r.json.findIndex((a) => a.id === anna.id), "albums follow sort_order");
  check(!r.json.some((a) => a.id === twin.id), "an empty album is still left out");
  check(JSON.stringify(r.json.find((a) => a.slug === "pournami-pooja") ?? null) === JSON.stringify(seededBefore ?? null), "the seeded albums are unchanged by this run");

  /* ── cover pick, hide / show ────────────────────────────────────────── */
  r = await act({ action: "cover", id: String(big.id) });
  check(redirected(r) && albumById(nav.id).cover_image_id === big.id && audits("gallery_album_cover", `gallery_album:${nav.id}`) === 1, "“Use as album cover” sets the cover and is audited");
  r = await api("/api/gallery/albums");
  check(r.json.find((a) => a.id === nav.id)?.cover?.id === big.id, "the chosen cover is published");
  r = await act({ action: "cover", id: String(unfiled.id) });
  check(redirected(r) && albumById(nav.id).cover_image_id === big.id, "an unfiled photo cannot become a cover");
  r = await act({ action: "toggle", id: String(big.id) });
  check(redirected(r) && photoById(big.id).is_active === 0 && audits("gallery_toggled", `gallery:${big.id}`) === 1, "toggle hides the photo and is audited");
  r = await api("/api/gallery");
  check(!r.json.some((g) => g.id === big.id), "a hidden photo leaves the public feed");
  r = await api("/api/gallery/albums");
  const hiddenCover = r.json.find((a) => a.id === nav.id);
  check(hiddenCover.count === 1 && hiddenCover.cover?.id === jpeg.id, "a hidden cover falls back to the newest shown photo and the count drops");
  r = await owner.get("/admin/gallery.php?f=hidden");
  check(grid(r.text).includes(`${P} big png`) && !grid(r.text).includes(`${P} jpeg`), "Hidden filter lists only hidden photos");
  await act({ action: "toggle", id: String(big.id) });
  r = await api("/api/gallery");
  check(r.json.some((g) => g.id === big.id), "toggle shows it again");
  r = await act({ action: "toggle", id: "987654321" });
  check(redirected(r) && audits("gallery_toggled", "gallery:987654321") === 0, "toggling a missing id is a no-op");

  /* ── per-photo edit and move ────────────────────────────────────────── */
  r = await act({ action: "update", id: String(small.id), caption: `${P} small (edited)`, alt_ta: `${P} அன்னதானம் வரிசை`, alt_en: `${P} annadhanam queue`, album_id: String(nav.id), is_active: "1" });
  edited = photoById(small.id);
  check(redirected(r) && edited.caption === `${P} small (edited)` && edited.alt_ta === `${P} அன்னதானம் வரிசை` && edited.alt_en === `${P} annadhanam queue` && edited.album_id === nav.id && edited.is_active === 1, "edit persisted caption, Tamil/English alt text and the move to another album", JSON.stringify(edited));
  check(audits("gallery_updated", `gallery:${small.id}`) === 1, "update is audited");
  check(/moved .* → /.test(sql("SELECT detail FROM admin_activity WHERE action = 'gallery_updated' AND subject = ?", [`gallery:${small.id}`]).rows[0].detail), "the audit row names the move");
  r = await owner.get(`/admin/gallery.php?edit=${small.id}`);
  check(r.status === 200 && r.text.includes(`value="${P} அன்னதானம் வரிசை"`) && r.text.includes(`<option value="${nav.id}" selected`), "edit form is pre-filled with the Tamil alt text and the album");
  r = await api("/api/gallery/albums");
  check(r.json.find((a) => a.id === nav.id)?.count === 3 && !r.json.some((a) => a.id === anna.id), "counts follow the move; the emptied album leaves the list");
  r = await act({ action: "update", id: String(small.id), caption: `${P} small (edited)`, album_id: "999999999", is_active: "1" });
  check(r.status === 200 && /highlighted/.test(r.text) && photoById(small.id).album_id === nav.id, "editing onto an unknown album is refused and changes nothing");
  r = await act({ action: "update", id: "987654321", caption: `${P} ghost`, album_id: "0", is_active: "1" });
  check(r.status === 200 && /no longer exists/.test(r.text) && !findPhoto(`${P} ghost`), "editing a deleted id is refused");
  r = await act({ action: "update", id: String(small.id), caption: `${P} small (unfiled)`, alt_ta: "", alt_en: "", album_id: "0" });
  edited = photoById(small.id);
  check(redirected(r) && edited.album_id === null && edited.alt_ta === null && edited.is_active === 0, "clearing the album and alt text stores NULL; an unchecked Shown hides the photo", JSON.stringify(edited));
  await act({ action: "update", id: String(small.id), caption: `${P} small (unfiled)`, album_id: "0", is_active: "1" });

  /* ── album hide, delete refusal, event and cover FKs ────────────────── */
  r = await act({ action: "album_toggle", album_id: String(nav.id) });
  check(redirected(r) && albumById(nav.id).is_active === 0 && audits("gallery_album_toggled", `gallery_album:${nav.id}`) === 1, "album toggle hides it and is audited");
  r = await api("/api/gallery");
  check(!r.json.some((g) => g.id === big.id || g.id === jpeg.id) && r.json.some((g) => g.id === small.id), "a hidden album hides its photos from the feed, not the others");
  r = await api("/api/gallery/albums");
  check(!r.json.some((a) => a.id === nav.id), "…and the album itself");
  r = await api("/api/gallery?album=" + nav.slug);
  check(r.json.length === 0, "filtering by a hidden album answers nothing");
  await act({ action: "album_toggle", album_id: String(nav.id) });
  r = await api("/api/gallery");
  check(r.json.some((g) => g.id === big.id), "showing the album brings its photos back");
  r = await act({ action: "album_delete", album_id: String(nav.id) });
  check(redirected(r) && albumById(nav.id) && photoById(big.id), "an album with photos is not deleted");
  r = await owner.get("/admin/gallery.php");
  check(/cannot be deleted\. Hide it, or move its photos first/.test(r.text), "…and the admin is told to hide it or move the photos");
  r = await act({ action: "album_delete", album_id: String(twin.id) });
  check(redirected(r) && !albumById(twin.id) && audits("gallery_album_deleted", `gallery_album:${twin.id}`) === 1, "an empty album is deleted and audited");
  sql("DELETE FROM events WHERE id = ?", [event.id]);
  check(albumById(nav.id).event_id === null, "deleting the event keeps the album and clears the link (FK SET NULL)");
  r = await api("/api/gallery/albums");
  check(r.json.find((a) => a.id === nav.id)?.event_id === null, "public album reports no event afterwards");

  /* ── E2E-047/048: hostile payloads are data ─────────────────────────── */
  r = await albumPost({ album_id: "0", album_title_ta: XSS, album_title_en: SQLI, album_description_en: XSS });
  const hostileAlbum = sql("SELECT * FROM gallery_albums WHERE title_en = ?", [SQLI]).rows[0];
  check(redirected(r) && hostileAlbum && !/<script|onerror/.test(hostileAlbum.title_ta + hostileAlbum.description_en) && /^[a-z0-9][a-z0-9-]{1,59}$/.test(hostileAlbum.slug), "E2E-047 the SQL payload is stored verbatim (table still exists); tags stripped; slug stays clean", JSON.stringify(hostileAlbum));
  r = await upload(smallPng, "hostile.png", { caption: SQLI, alt_ta: XSS, alt_en: XSS, album_id: String(hostileAlbum.id) });
  const hostile = findPhoto(SQLI);
  check(redirected(r) && hostile && hostile.caption === SQLI && !/<script|onerror/.test(hostile.alt_ta + hostile.alt_en), "E2E-047 hostile caption stored as text; script tags stripped from alt text", JSON.stringify(hostile));
  r = await owner.get("/admin/gallery.php");
  check(!r.text.includes("<script>alert(1)</script>") && !r.text.includes("onerror=alert(2)>") && r.text.includes("&#039;); DROP TABLE"), "E2E-048 admin grid shows the payload escaped, never as markup");
  r = await owner.get(`/admin/gallery.php?edit=${hostile.id}`);
  check(!r.text.includes("<script>alert(1)</script>") && !/<img src=x onerror/.test(r.text), "E2E-048 edit form escapes the payload");
  r = await api("/api/gallery");
  check(r.json.some((g) => g.id === hostile.id && g.caption === SQLI) && !/<script/.test(r.text), "E2E-048 API returns the stored text as a JSON string; no script tag anywhere");
  r = await api("/api/gallery/albums");
  check(r.json.some((a) => a.id === hostileAlbum.id && a.title_en === SQLI) && !/<script/.test(r.text), "E2E-048 albums API is clean too");
  r = await owner.get("/admin/gallery.php?q=" + encodeURIComponent(SQLI) + "&a=" + encodeURIComponent(SQLI) + "&f=" + encodeURIComponent(XSS) + "&edit=" + encodeURIComponent(XSS));
  check(r.status === 200 && !FATAL.test(r.text) && !r.text.includes("<script>alert(1)</script>"), "E2E-047 hostile filter parameters are harmless");
  r = await api("/api/search?q=" + encodeURIComponent(`${P} jpeg`));
  check(r.status === 200 && r.json?.groups?.find((g) => g.type === "gallery")?.items.some((i) => i.title_en === `${P} jpeg`), "site search still finds a photo by caption");

  /* ── delete removes all three files and clears the cover ────────────── */
  const bigFiles = [big.filename, big.thumb_filename, big.medium_filename];
  r = await act({ action: "delete", id: String(big.id) });
  check(redirected(r) && !photoById(big.id) && audits("gallery_deleted", `gallery:${big.id}`) === 1, "delete removes the row and is audited");
  check(bigFiles.every((f) => !onDisk(f)), "original, thumb and medium are all gone from disk", bigFiles.filter(onDisk).join());
  check(albumById(nav.id).cover_image_id === null, "deleting the cover photo clears the album's cover (FK SET NULL)");
  r = await api("/api/gallery");
  check(!r.json.some((g) => g.id === big.id), "a deleted photo leaves the public feed");
  r = await act({ action: "delete", id: "987654321" });
  check(redirected(r) && audits("gallery_deleted", "gallery:987654321") === 0, "deleting a missing id is a no-op");

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
  r = await sessions.editor.get("/admin/gallery.php");
  check(r.status === 200 && r.text.includes(`${P} jpeg`), "E2E-013 editor (content.edit) opens the Gallery page", `${r.status}`);
  const edCsrf = csrfOf(r.text);
  r = await albumPost({ album_id: "0", album_title_ta: `${P} ஆசிரியர்`, album_title_en: `${P} by editor` }, sessions.editor, edCsrf);
  const byEditor = findAlbum(`${P} by editor`);
  check(redirected(r) && !!byEditor, "E2E-013 editor can add an album");
  r = await upload(smallPng, "editor.png", { caption: `${P} by editor photo`, album_id: String(byEditor.id) }, sessions.editor, edCsrf);
  check(redirected(r) && !!findPhoto(`${P} by editor photo`), "E2E-013 editor can upload a photo");
  for (const role of ["finance", "viewer"]) {
    r = await sessions[role].get("/admin/gallery.php");
    check(r.status === 403, `E2E-013 ${role} gets 403 on the Gallery page`, `${r.status}`);
    r = await sessions[role].post("/admin/gallery.php", { _csrf: "x", action: "toggle", id: String(jpeg.id) });
    check(r.status === 403 && photoById(jpeg.id).is_active === 1, `E2E-046 ${role} POST is refused server-side`, `${r.status}`);
    r = await sessions[role].post("/admin/gallery.php", { _csrf: "x", action: "album_delete", album_id: String(byEditor.id) });
    check(r.status === 403 && !!albumById(byEditor.id), `E2E-046 ${role} cannot touch albums`, `${r.status}`);
  }

  check(!FATAL.test(log), "no PHP warnings, notices or fatals in the server log", log.slice(-600));
  console.log(`\ngallery: ${checks} passed, 0 failed`);
} catch (e) {
  console.error(`\ngallery: ${checks} passed, 1 failed\n${e.message}`);
  if (log.trim()) console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  try {
    for (const row of sql("SELECT filename, thumb_filename, medium_filename FROM gallery WHERE caption LIKE ?", [`${P}%`]).rows) {
      for (const f of [row.filename, row.thumb_filename, row.medium_filename]) {
        if (f && existsSync(resolve(uploads, f))) unlinkSync(resolve(uploads, f));
      }
    }
    sql("DELETE FROM gallery WHERE caption LIKE ?", [`${P}%`]);
    sql("DELETE FROM gallery_albums WHERE title_en LIKE ?", [`${P}%`]);
    if (createdEventIds.length) sql(`DELETE FROM events WHERE id IN (${createdEventIds.map(() => "?").join(",")})`, createdEventIds);
    sql("DELETE FROM admin_users WHERE username LIKE ?", [`e2egal_${RUN}_%`]);
    sql("DELETE FROM admin_activity WHERE detail LIKE ? OR subject LIKE ? OR actor LIKE ?", [`%${P}%`, `%${P}%`, `e2egal_${RUN}_%`]);
  } catch (e) { console.error(e.message); }
  rmSync(tmp, { recursive: true, force: true });
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
}
