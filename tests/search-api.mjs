#!/usr/bin/env node
/**
 * tests/search-api.mjs — GET /api/search, the one search box over the whole
 * public site, against the real PHP + MySQL stack.
 *
 *   node tests/search-api.mjs                        starts its own PHP server
 *   node tests/search-api.mjs http://127.0.0.1:8050  runs against that server
 *
 * The basics, hostile queries and the curated pages (family registration,
 * online donation and the policy pages, live darshan and its schedule) are
 * carried over from the retired devotee account suite. Since migrations 020,
 * 021 and 025 it also proves, on rows it creates itself:
 *
 *   announcements match title and body in both languages, keep their real
 *   title_ta / title_en, and honour is_active and the publish window exactly
 *   as /api/announcements does (future, expired and hidden notices stay out,
 *   a one-day window is current all day, the two list the same notices; a
 *   row an old client wrote keeps its title);
 *   events match description and venue in both languages and link to
 *   /events/<id>; sevas match description and timing and link to
 *   /sevas?seva=<id> only when bookable; gallery photos match alt text, link
 *   to /gallery?photo=<id>, and a hidden photo or album never matches;
 *   CMS pages match title and body (hidden and bodiless pages stay out) and
 *   link to /about, the About anchors for "mission" and "history";
 *   every result carries snippet_ta / snippet_en (an excerpt around the term)
 *   next to the old `snippet`;
 *   a database without those migrations still answers: a scratch schema with
 *   the first-release columns only is created, served and dropped.
 *
 * Needs the DB_* environment (PHP_BIN optional) and migrations 020, 021 and
 * 025. Everything it writes carries the prefix "E2E-SRCH-<run>" and is
 * deleted in `finally`; the scratch database e2e_srch_<run> is dropped there.
 * Requests carry X-Forwarded-For 10.80.0.200.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-SRCH-${RUN}`;
const SLUG = `e2e-srch-${RUN}`;
const SCRATCH_DB = `e2e_srch_${RUN}`;
const XFF = "10.80.0.200";
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const EXTERNAL = (process.argv[2] || "").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 400)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);

/** One SQL statement through tests/support/live_fixtures.php, against DB_NAME or the database named. */
function sqlIn(dbName, query, params = []) {
  const r = spawnSync(php, [resolve(root, "tests/support/live_fixtures.php"), "sql", "-"], {
    cwd: root, input: JSON.stringify({ query, params }), encoding: "utf8",
    env: dbName ? { ...process.env, DB_NAME: dbName } : process.env,
  });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-600));
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}
const sql = (query, params = []) => sqlIn(null, query, params);
/** Temple-time (Asia/Kolkata) calendar day, offset in days — the clock the publish window uses. */
const istDay = (offset = 0) => new Date(Date.now() + (5.5 * 3600 + offset * 86400) * 1000).toISOString().slice(0, 10);

async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}
async function startServer(env = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: resolve(root, "backend"),
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/api/search?q=ab`)).status === 200; } catch { /* starting */ }
    if (ready) break;
    await delay(100);
  }
  return { server, base, ready, log: () => log };
}
async function stopServer(s) {
  if (s?.server && s.server.exitCode === null) {
    s.server.kill("SIGTERM");
    await once(s.server, "exit");
  }
}

let own = null;
let BASE = EXTERNAL;
let legacyDb = false;

async function request(method, path, base = BASE) {
  const res = await fetch(base + path, { method, headers: { "X-Forwarded-For": XFF, Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
  return { status: res.status, json, text };
}
const search = (q, extra = "", base = BASE) => request("GET", `/api/search?q=${encodeURIComponent(q)}${extra}`, base);
const urlsOf = (r) => (r.json?.groups ?? []).flatMap((g) => g.items.map((i) => i.url));
const group = (r, type) => (r.json?.groups ?? []).find((g) => g.type === type)?.items ?? [];
const pageItem = (r, url) => group(r, "pages").find((i) => i.url === url);
const byTitle = (r, type, en) => group(r, type).find((i) => i.title_en === en);
const fixtureId = (table, col, value) => Number(sql(`SELECT id FROM ${table} WHERE ${col} = ? ORDER BY id DESC LIMIT 1`, [value]).rows[0]?.id ?? 0);

try {
  if (EXTERNAL) {
    const probe = await fetch(`${EXTERNAL}/api/pulse`).catch(() => null);
    if (!probe || !probe.ok) {
      console.log(`✗ no backend at ${EXTERNAL}.`);
      process.exit(1);
    }
  } else {
    own = await startServer();
    BASE = own.base;
    check(own.ready, "PHP server started", own.log());
  }

  section("the basics");
  let r = await search("a");
  check(r.status === 200 && r.json?.total === 0, "a one-character query returns nothing, politely", `status ${r.status}`);
  check(Boolean(r.json?.message), "…with a message saying why");

  r = await search("abhishekam");
  check(r.status === 200 && r.json?.total > 0, "a real word finds results", `total ${r.json?.total}`);
  check(Array.isArray(r.json?.groups) && r.json.groups.every((g) => g.label_ta && g.label_en), "every group is labelled in both languages");
  check(r.json?.groups?.every((g) => g.items.every((i) => typeof i.url === "string" && i.url.startsWith("/"))), "every result points at an in-site path");

  r = await search("80G");
  check(urlsOf(r).includes("/about#trust"), "a keyword that never appears on screen still finds its page (80G → Trust)", urlsOf(r).join(","));

  r = await search("பௌர்ணமி");
  check(r.status === 200 && r.json?.total > 0, "a Tamil query finds results", `total ${r.json?.total}`);

  r = await search("zzqq-nothing-matches-this");
  check(r.status === 200 && r.json?.total === 0 && Array.isArray(r.json.groups) && r.json.groups.length === 0, "no matches returns an empty group list, not an error");

  section("hostile queries");
  r = await search("100%");
  check(r.status === 200, "a query containing % does not break the LIKE", `status ${r.status}`);
  r = await search("a_b");
  check(r.status === 200, "nor does one containing _", `status ${r.status}`);
  r = await search("' OR 1=1 --");
  check(r.status === 200 && !/Fatal|PDOException|SQLSTATE/i.test(r.text), "an injection attempt is just a search term");
  r = await request("GET", "/api/search?q[]=abhishekam");
  check(r.status === 200 && !/Fatal|Warning|Stack trace/i.test(r.text), "a query sent as an array is not a 500", `status ${r.status} ${r.text.slice(0, 120)}`);
  r = await search("pooja", "&limit=9999");
  const largest = Math.max(0, ...(r.json?.groups ?? []).map((g) => g.items.length));
  check(largest <= 50, "the limit is capped server-side", `largest group ${largest}`);
  r = await request("POST", "/api/search");
  check(r.status === 405 || r.status === 404, "search is GET-only", `status ${r.status}`);

  section("the family registration page");
  for (const term of ["register", "registration", "Family", "members", "sign up", "பதிவு", "குடும்பம்", "உறுப்பினர்"]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes("/register"), `"${term}" finds /register`, urlsOf(r).join(","));
  }
  r = await search("Family registration");
  const item = pageItem(r, "/register");
  check(item?.title_en === "Family registration" && item?.title_ta === "குடும்பப் பதிவு", "the entry is titled in both languages, as the page's own SEO title", JSON.stringify(item));
  check(item?.score === 100, "an exact title match ranks first", JSON.stringify(item));
  r = await search("குடும்பப் பதிவு");
  check(pageItem(r, "/register")?.score === 100, "the Tamil title matches exactly too", JSON.stringify(pageItem(r, "/register")));
  for (const retired of ["/login", "/account", "/notifications"]) {
    r = await search(retired.slice(1));
    check(!urlsOf(r).includes(retired), `nothing points at the retired ${retired} page`, urlsOf(r).join(","));
  }

  section("online donation and the policy pages (docs/payments/SPEC.md §7.8)");
  for (const [term, url] of [
    ["donate online", "/donate"],
    ["UPI", "/donate"],
    ["net banking", "/donate"],
    ["ccavenue", "/donate"],
    ["இணையவழி", "/donate"],
    ["privacy", "/privacy-policy"],
    ["தனியுரிமை", "/privacy-policy"],
    ["terms", "/terms-and-conditions"],
    ["refund", "/refund-cancellation-policy"],
    ["ரத்து", "/refund-cancellation-policy"],
    ["shipping", "/shipping-delivery-policy"],
    ["delivery", "/shipping-delivery-policy"],
  ]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes(url), `"${term}" finds ${url}`, urlsOf(r).join(","));
  }
  r = await search("Donate online");
  const donate = pageItem(r, "/donate");
  check(donate?.title_en === "Donate online" && donate?.title_ta === "இணையவழி நன்கொடை", "/donate is titled in both languages, as the page's own SEO title", JSON.stringify(donate));
  r = await search("donate");
  check(urlsOf(r).includes("/donations") && urlsOf(r).includes("/donate"), "\"donate\" offers both the bank-details page and the online page", urlsOf(r).join(","));

  section("the live darshan page (docs/live/SPEC-PHASE1.md §4.6)");
  for (const term of ["live darshan", "live", "stream", "youtube", "watch online", "நேரடி தரிசனம்", "நேரலை", "ஒளிபரப்பு"]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes("/live-darshan"), `"${term}" finds /live-darshan`, urlsOf(r).join(","));
  }
  r = await search("Live Darshan");
  const liveDarshan = pageItem(r, "/live-darshan");
  check(liveDarshan?.title_en === "Live Darshan" && liveDarshan?.title_ta === "நேரடி தரிசனம்", "/live-darshan is titled in both languages, as the page's own SEO title", JSON.stringify(liveDarshan));
  check(liveDarshan?.score === 100, "an exact English title match scores 100", JSON.stringify(liveDarshan));
  r = await search("நேரடி தரிசனம்");
  check(pageItem(r, "/live-darshan")?.score === 100, "the exact Tamil title scores 100 too", JSON.stringify(pageItem(r, "/live-darshan")));

  section("the live darshan schedule page (docs/live/SPEC-PHASE2.md §1.3)");
  for (const term of ["schedule", "timetable", "அட்டவணை", "live darshan schedule"]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes("/live-darshan/schedule"), `"${term}" finds /live-darshan/schedule`, urlsOf(r).join(","));
  }
  r = await search("Live Darshan schedule");
  const schedule = pageItem(r, "/live-darshan/schedule");
  check(schedule?.title_en === "Live Darshan schedule" && schedule?.title_ta === "நேரடி தரிசன அட்டவணை", "/live-darshan/schedule is titled in both languages, as the page's own SEO title", JSON.stringify(schedule));
  check(schedule?.score === 100, "the exact English title scores 100", JSON.stringify(schedule));

  /* ── Fixtures for the bilingual rows (migrations 020, 021, 025) ──────── */
  section("fixtures");
  const TA_NOTICE = `${P} நடப்பு அறிவிப்பு`;
  const TA_BODY = `கும்பாபிஷேக ஒத்திகை ${P} ஞாயிறு`;
  const EN_BODY = `Kumbabhishekam rehearsal on Sunday ${P}`;
  const ann = (title, body, ta, en, bodyTa, bodyEn, start, end, active) =>
    sql("INSERT INTO announcements (title, body, title_ta, title_en, body_ta, body_en, start_date, end_date, is_active) VALUES (?,?,?,?,?,?,?,?,?)",
      [title, body, ta, en, bodyTa, bodyEn, start, end, active]);
  ann(`${P} current notice`, `Legacy body ${P}`, TA_NOTICE, `${P} current notice`, TA_BODY, EN_BODY, istDay(-2), istDay(2), 1);
  ann(`${P} open notice`, null, `${P} திறந்த அறிவிப்பு`, `${P} open notice`, null, null, istDay(-1), null, 1);
  ann(`${P} future notice`, null, `${P} எதிர்கால அறிவிப்பு`, `${P} future notice`, null, null, istDay(3), null, 1);
  ann(`${P} expired notice`, null, `${P} காலாவதி அறிவிப்பு`, `${P} expired notice`, null, null, null, istDay(-3), 1);
  ann(`${P} hidden notice`, null, `${P} மறைந்த அறிவிப்பு`, `${P} hidden notice`, null, null, null, null, 0);
  // The window is inclusive at both ends: a one-day notice is current all day.
  ann(`${P} one-day notice`, null, `${P} ஒரு நாள் அறிவிப்பு`, `${P} one-day notice`, null, null, istDay(0), istDay(0), 1);
  // A row written by an older client: only the old columns are filled.
  ann(`${P} legacy notice`, `Old client body ${P}`, "", "", null, null, null, null, 1);

  const TA_EVENT = `${P} தைப்பூசம்`;
  const TA_VENUE = `கோயில் மண்டபம் ${P}`;
  sql(`INSERT INTO events (title_ta, title_en, event_type, description, description_ta, description_en, event_date, end_date, start_time, end_time, venue_ta, venue_en, is_featured, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [TA_EVENT, `${P} Thai Poosam`, "festival", `Grand kavadi ${P}`, `காவடி ஊர்வலம் ${P}`, `Kavadi procession ${P}`, istDay(10), istDay(11), "06:00:00", "21:00:00", TA_VENUE, `Temple mandapam ${P}`, 1, 1]);
  sql("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?,?,?,?,?)", [`${P} மறைந்த நிகழ்வு`, `${P} hidden event`, null, istDay(12), 0]);
  sql("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?,?,?,?,?)", [`${P} பழைய நிகழ்வு`, `${P} legacy event`, `Old description ${P} varalaru`, istDay(13), 1]);
  const evId = fixtureId("events", "title_en", `${P} Thai Poosam`);
  const legacyEvId = fixtureId("events", "title_en", `${P} legacy event`);

  sql(`INSERT INTO sevas (name_ta, name_en, description, description_ta, description_en, timing_ta, timing_en, amount, sort_order, is_featured, is_bookable, is_active)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [`${P} அபிஷேகம்`, `${P} Abhishekam`, `Sacred bathing ${P}`, `சுவாமிக்கு புனித நீராட்டு ${P}`, `Sacred bathing of the deity ${P}`, `தினமும் காலை ${P}`, `Daily 7-9 am ${P}`, 251, 900, 0, 1, 1]);
  sql(`INSERT INTO sevas (name_ta, name_en, description_ta, description_en, amount, sort_order, is_bookable, is_active) VALUES (?,?,?,?,?,?,?,?)`,
    [`${P} அன்னதானம்`, `${P} Annadanam`, `பக்தர்களுக்கு உணவு ${P}`, `Feeding devotees ${P}`, 5000, 901, 0, 1]);
  sql(`INSERT INTO sevas (name_ta, name_en, amount, sort_order, is_active) VALUES (?,?,?,?,?)`, [`${P} மறைந்த சேவை`, `${P} hidden seva`, 10, 902, 0]);
  const sevaId = fixtureId("sevas", "name_en", `${P} Abhishekam`);
  const annaId = fixtureId("sevas", "name_en", `${P} Annadanam`);

  const CAPTION = `${P} kumbabhishekam crowd`;
  const TA_ALT = `கும்பாபிஷேக நாள் கூட்டம் ${P}`;
  const EN_ALT = `Devotees at the kumbabhishekam ${P}`;
  sql("INSERT INTO gallery (filename, caption, alt_ta, alt_en, is_active) VALUES (?,?,?,?,?)", [`${SLUG}-a.jpg`, CAPTION, TA_ALT, EN_ALT, 1]);
  sql("INSERT INTO gallery (filename, caption, is_active) VALUES (?,?,?)", [`${SLUG}-b.jpg`, `${P} hidden photo`, 0]);
  sql("INSERT INTO gallery_albums (slug, title_ta, title_en, is_active) VALUES (?,?,?,?)", [SLUG, `${P} மறைந்த தொகுப்பு`, `${P} hidden album`, 0]);
  const albumId = fixtureId("gallery_albums", "slug", SLUG);
  sql("INSERT INTO gallery (album_id, filename, caption, is_active) VALUES (?,?,?,?)", [albumId, `${SLUG}-c.jpg`, `${P} album photo`, 1]);
  const photoId = fixtureId("gallery", "caption", CAPTION);

  const TA_PAGE_BODY = `பக்தர்கள் காலணிகளை வாயிலில் விட்டுவிட வேண்டும் ${P}.`;
  const EN_PAGE_BODY = `Footwear is left at the gate. ${"Devotees are welcome from dawn to dusk. ".repeat(6)}The office answers questions ${P}.`;
  sql("INSERT INTO pages (slug, title_ta, title_en, body_ta, body_en, sort_order, is_active) VALUES (?,?,?,?,?,?,?)",
    [SLUG, `${P} கோயில் விதிமுறைகள்`, `${P} Temple rules`, TA_PAGE_BODY, EN_PAGE_BODY, 90, 1]);
  sql("INSERT INTO pages (slug, title_ta, title_en, body_ta, body_en, sort_order, is_active) VALUES (?,?,?,?,?,?,?)",
    [`${SLUG}-h`, `${P} மறைந்த பக்கம்`, `${P} hidden page`, `x ${P}`, `hidden body ${P}`, 91, 0]);
  sql("INSERT INTO pages (slug, title_ta, title_en, body_ta, body_en, sort_order, is_active) VALUES (?,?,?,?,?,?,?)",
    [`${SLUG}-b`, `${P} வெற்றுப் பக்கம்`, `${P} empty page`, null, null, 92, 1]);
  check(evId > 0 && legacyEvId > 0 && sevaId > 0 && annaId > 0 && albumId > 0 && photoId > 0, "fixture rows created", JSON.stringify({ evId, legacyEvId, sevaId, annaId, albumId, photoId }));

  /* ── Announcements (migration 020) ───────────────────────────────────── */
  section("announcements: both languages, is_active and the publish window (as /api/announcements)");
  r = await search(P); // every fixture notice carries the run prefix in its title
  let items = group(r, "announcements");
  const titles = items.map((i) => i.title_en);
  check(r.status === 200 && titles.includes(`${P} current notice`), "a notice inside its window is found by its English title", titles.join(" | "));
  check(titles.includes(`${P} open notice`), "a notice with a start date and no end date is current", titles.join(" | "));
  check(!titles.includes(`${P} future notice`), "a notice whose window has not opened stays out", titles.join(" | "));
  check(!titles.includes(`${P} expired notice`), "a notice whose window has closed stays out", titles.join(" | "));
  check(!titles.includes(`${P} hidden notice`), "a hidden notice stays out", titles.join(" | "));
  check(titles.includes(`${P} one-day notice`), "a notice whose window opens and closes today is current (both ends inclusive)", titles.join(" | "));
  const listed = await request("GET", "/api/announcements?limit=50");
  const listedTitles = (Array.isArray(listed.json) ? listed.json : []).map((a) => a.title_en).filter((t) => t.startsWith(P)).sort();
  check(listed.status === 200 && JSON.stringify(listedTitles) === JSON.stringify([...titles].sort()), "search finds exactly the notices /api/announcements serves", `api: ${listedTitles.join(" | ")} · search: ${[...titles].sort().join(" | ")}`);
  check(items.every((i) => i.url === "/"), "every notice links to the homepage", JSON.stringify(items.map((i) => i.url)));
  const current = byTitle(r, "announcements", `${P} current notice`);
  check(current?.title_ta === TA_NOTICE, "the Tamil title is the real title_ta, intact", JSON.stringify(current));
  check(current?.snippet_ta === TA_BODY && current?.snippet_en === EN_BODY, "snippet_ta / snippet_en carry the body in each language", JSON.stringify(current));
  check(current?.snippet === EN_BODY, "the old `snippet` key is the English body (kept for one release)", JSON.stringify(current));
  const legacy = byTitle(r, "announcements", `${P} legacy notice`);
  check(legacy?.title_ta === `${P} legacy notice` && legacy?.title_en === `${P} legacy notice`, "a row an old client wrote (empty title_ta / title_en) keeps its title in both languages", JSON.stringify(legacy));
  check(legacy?.snippet_ta === `Old client body ${P}` && legacy?.snippet === `Old client body ${P}`, "…and its old body stands in for both languages", JSON.stringify(legacy));
  r = await search(`ஒத்திகை ${P}`);
  check(byTitle(r, "announcements", `${P} current notice`) !== undefined, "a Tamil word from body_ta finds the notice", JSON.stringify(group(r, "announcements").map((i) => i.title_en)));
  r = await search(`${P} நடப்பு`);
  const byTa = byTitle(r, "announcements", `${P} current notice`);
  check(byTa !== undefined && byTa.score >= 80, "the Tamil title matches and a title that starts with the term outranks a body match", JSON.stringify(byTa));
  r = await search(`Legacy body ${P}`);
  check(byTitle(r, "announcements", `${P} current notice`) !== undefined, "the old `body` column still matches", JSON.stringify(group(r, "announcements").map((i) => i.title_en)));

  /* ── Events (migration 020) ──────────────────────────────────────────── */
  section("events: description and venue in both languages, /events/<id>");
  r = await search(`mandapam ${P}`);
  let hit = byTitle(r, "events", `${P} Thai Poosam`);
  check(hit !== undefined, "the English venue finds the event", JSON.stringify(group(r, "events").map((i) => i.title_en)));
  check(hit?.url === `/events/${evId}`, "the event links to its own page /events/<id>", JSON.stringify(hit));
  check(hit?.title_ta === TA_EVENT, "the Tamil title is intact", JSON.stringify(hit));
  check(hit?.sub_en?.startsWith(istDay(10)) && hit?.sub_en?.includes(istDay(11)) && hit?.sub_en?.includes(`Temple mandapam ${P}`), "sub_en shows the date span and the English venue", JSON.stringify(hit));
  check(hit?.sub_ta?.includes(TA_VENUE), "sub_ta shows the Tamil venue", JSON.stringify(hit));
  check(hit?.snippet_ta === `காவடி ஊர்வலம் ${P}` && hit?.snippet_en === `Kavadi procession ${P}` && hit?.snippet === `Kavadi procession ${P}`, "snippets are the description in each language", JSON.stringify(hit));
  r = await search(`ஊர்வலம் ${P}`);
  check(byTitle(r, "events", `${P} Thai Poosam`) !== undefined, "a Tamil word from description_ta finds the event", JSON.stringify(group(r, "events").map((i) => i.title_en)));
  check(byTitle(r, "events", `${P} Thai Poosam`)?.score === 40, "a match in the description alone scores 40, below any title match", JSON.stringify(byTitle(r, "events", `${P} Thai Poosam`)));
  r = await search(`மண்டபம் ${P}`);
  check(byTitle(r, "events", `${P} Thai Poosam`) !== undefined, "the Tamil venue finds the event", JSON.stringify(group(r, "events").map((i) => i.title_en)));
  r = await search(`${P} varalaru`);
  hit = byTitle(r, "events", `${P} legacy event`);
  check(hit !== undefined && hit.url === `/events/${legacyEvId}`, "the old single-language description still matches", JSON.stringify(group(r, "events").map((i) => i.title_en)));
  check(hit?.snippet_en === `Old description ${P} varalaru` && hit?.snippet_ta === `Old description ${P} varalaru`, "…and stands in for both languages", JSON.stringify(hit));
  r = await search(`${P} hidden event`);
  check(byTitle(r, "events", `${P} hidden event`) === undefined, "a hidden event never matches", JSON.stringify(group(r, "events").map((i) => i.title_en)));

  /* ── Sevas (migration 020) ───────────────────────────────────────────── */
  section("sevas: description and timing in both languages, /sevas?seva=<id> only when bookable");
  r = await search(`${P} Abhishekam`);
  hit = byTitle(r, "sevas", `${P} Abhishekam`);
  check(hit?.url === `/sevas?seva=${sevaId}`, "a bookable seva links straight to its booking form", JSON.stringify(hit));
  check(hit?.title_ta === `${P} அபிஷேகம்` && hit?.sub_en === "₹251", "Tamil name and price intact", JSON.stringify(hit));
  check(hit?.snippet_ta === `சுவாமிக்கு புனித நீராட்டு ${P}` && hit?.snippet_en === `Sacred bathing of the deity ${P}`, "snippets are the description in each language", JSON.stringify(hit));
  r = await search(`${P} Annadanam`);
  hit = byTitle(r, "sevas", `${P} Annadanam`);
  check(hit?.url === "/sevas", "a seva that cannot be booked online links to the list, not a form", JSON.stringify(hit));
  r = await search(`Daily 7-9 am ${P}`);
  check(byTitle(r, "sevas", `${P} Abhishekam`) !== undefined, "the English timing finds the seva", JSON.stringify(group(r, "sevas").map((i) => i.title_en)));
  r = await search(`தினமும் காலை ${P}`);
  check(byTitle(r, "sevas", `${P} Abhishekam`) !== undefined, "the Tamil timing finds the seva", JSON.stringify(group(r, "sevas").map((i) => i.title_en)));
  r = await search(`நீராட்டு ${P}`);
  check(byTitle(r, "sevas", `${P} Abhishekam`) !== undefined, "a Tamil word from description_ta finds the seva", JSON.stringify(group(r, "sevas").map((i) => i.title_en)));
  r = await search(`Feeding devotees ${P}`);
  check(byTitle(r, "sevas", `${P} Annadanam`) !== undefined, "description_en finds the seva", JSON.stringify(group(r, "sevas").map((i) => i.title_en)));
  r = await search(`${P} hidden seva`);
  check(byTitle(r, "sevas", `${P} hidden seva`) === undefined, "a hidden seva never matches", JSON.stringify(group(r, "sevas").map((i) => i.title_en)));

  /* ── Gallery (migration 021) ─────────────────────────────────────────── */
  section("gallery: alt text in both languages, /gallery?photo=<id>, hidden albums");
  r = await search(`Devotees at the kumbabhishekam ${P}`);
  hit = byTitle(r, "gallery", CAPTION);
  check(hit !== undefined, "the English alt text finds the photo", JSON.stringify(group(r, "gallery").map((i) => i.title_en)));
  check(hit?.url === `/gallery?photo=${photoId}`, "the photo links to /gallery?photo=<id>, which opens it", JSON.stringify(hit));
  check(hit?.title_ta === CAPTION && hit?.title_en === CAPTION, "the caption stays the visible label in both languages", JSON.stringify(hit));
  check(hit?.snippet_ta === TA_ALT && hit?.snippet_en === EN_ALT, "snippets carry the alt text in each language", JSON.stringify(hit));
  r = await search(`கூட்டம் ${P}`);
  check(byTitle(r, "gallery", CAPTION) !== undefined, "the Tamil alt text finds the photo", JSON.stringify(group(r, "gallery").map((i) => i.title_en)));
  r = await search(`${P} kumbabhishekam crowd`);
  check(byTitle(r, "gallery", CAPTION)?.score === 100, "the caption still matches, exactly", JSON.stringify(byTitle(r, "gallery", CAPTION)));
  r = await search(`${P} hidden photo`);
  check(byTitle(r, "gallery", `${P} hidden photo`) === undefined, "a hidden photo never matches", JSON.stringify(group(r, "gallery").map((i) => i.title_en)));
  r = await search(`${P} album photo`);
  check(byTitle(r, "gallery", `${P} album photo`) === undefined, "a photo in a hidden album never matches", JSON.stringify(group(r, "gallery").map((i) => i.title_en)));

  /* ── CMS pages (migration 025) ───────────────────────────────────────── */
  section("CMS pages: title and body of shown pages, the About anchors");
  r = await search(`${P} Temple rules`);
  hit = byTitle(r, "pages", `${P} Temple rules`);
  check(hit !== undefined && hit.url === "/about" && hit.sub_en === "About" && hit.sub_ta === "பற்றி", "a page the committee wrote is found by title and links to /about", JSON.stringify(hit));
  check(hit?.title_ta === `${P} கோயில் விதிமுறைகள்` && hit?.score === 100, "its Tamil title is intact and an exact title scores 100", JSON.stringify(hit));
  check(hit?.snippet_ta === TA_PAGE_BODY, "a short Tamil body is the whole snippet_ta", JSON.stringify(hit));
  check(typeof hit?.snippet_en === "string" && hit.snippet_en.startsWith("Footwear") && hit.snippet_en.endsWith("…") && hit.snippet_en.length <= 165, "a long English body is excerpted, not sent whole", JSON.stringify(hit?.snippet_en));
  check(hit?.snippet === hit?.snippet_en, "`snippet` is the English excerpt", JSON.stringify(hit));
  r = await search(`office answers questions ${P}`);
  hit = byTitle(r, "pages", `${P} Temple rules`);
  check(hit !== undefined && hit.score === 40, "a phrase found only in the body matches, ranked below title matches", JSON.stringify(hit));
  check(typeof hit?.snippet_en === "string" && hit.snippet_en.startsWith("…") && hit.snippet_en.includes("office answers questions"), "the excerpt is centred on the matching phrase", JSON.stringify(hit?.snippet_en));
  r = await search(`காலணிகளை வாயிலில் விட்டுவிட வேண்டும் ${P}`);
  check(byTitle(r, "pages", `${P} Temple rules`) !== undefined, "a Tamil word from body_ta finds the page", JSON.stringify(group(r, "pages").map((i) => i.title_en)));
  r = await search(`${P} hidden page`);
  check(byTitle(r, "pages", `${P} hidden page`) === undefined, "a hidden page never matches", JSON.stringify(group(r, "pages").map((i) => i.title_en)));
  r = await search(`hidden body ${P}`);
  check(group(r, "pages").length === 0, "…not even by its body", JSON.stringify(group(r, "pages").map((i) => i.title_en)));
  r = await search(`${P} empty page`);
  check(byTitle(r, "pages", `${P} empty page`) === undefined, "a page without a body (nothing to show) never matches", JSON.stringify(group(r, "pages").map((i) => i.title_en)));
  // The About page's own sections, when the committee has written them.
  const seeded = sql("SELECT slug, title_en, is_active, body_ta, body_en FROM pages WHERE slug IN ('mission', 'history')").rows;
  for (const pg of seeded) {
    const anchor = `/about#${pg.slug}`;
    r = await search(pg.title_en);
    const hits = group(r, "pages").filter((i) => i.url === anchor);
    if (Number(pg.is_active) === 1 && `${pg.body_ta ?? ""}${pg.body_en ?? ""}`.trim() !== "") {
      check(hits.length === 1 && hits[0].title_en === pg.title_en, `the CMS "${pg.slug}" page links to ${anchor}, listed once`, JSON.stringify(hits));
    } else {
      check(hits.length <= 1, `"${pg.slug}" has no body yet: ${anchor} appears at most once (the curated entry)`, JSON.stringify(hits));
    }
  }
  r = await search("Temple history");
  const historyUrls = group(r, "pages").map((i) => i.url);
  check(historyUrls.filter((u) => u === "/about#history").length === 1, "the history anchor is never listed twice", historyUrls.join(","));

  /* ── The shape every result shares ───────────────────────────────────── */
  section("every result carries both snippets");
  r = await search(P);
  const all = (r.json?.groups ?? []).flatMap((g) => g.items);
  check(all.length >= 8 && (r.json?.groups ?? []).length >= 5, "the run prefix finds rows across the groups", `${all.length} items in ${(r.json?.groups ?? []).length} groups`);
  check(all.every((i) => "snippet_ta" in i && "snippet_en" in i && "snippet" in i), "every item has snippet_ta, snippet_en and the old snippet", JSON.stringify(all.find((i) => !("snippet_ta" in i))));
  check(all.every((i) => typeof i.title_ta === "string" && typeof i.title_en === "string" && typeof i.url === "string" && "sub_ta" in i && "sub_en" in i && typeof i.score === "number"), "…and the keys the search page reads (title_ta/en, sub_ta/en, url, score)", JSON.stringify(all[0]));
  check(all.every((i) => i.snippet === (i.snippet_en ?? i.snippet_ta ?? null)), "`snippet` is always English, else Tamil", JSON.stringify(all.find((i) => i.snippet !== (i.snippet_en ?? i.snippet_ta ?? null))));
  check(r.json?.total === all.length, "total counts the items returned", `${r.json?.total} vs ${all.length}`);
  check(!/<script/i.test(r.text), "the answer is JSON data, never markup");

  /* ── A database without migrations 020 / 021 / 025 ───────────────────── */
  section("a database without migrations 020 / 021 / 025 still answers (scratch first-release schema)");
  try {
    sql(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    legacyDb = true;
  } catch (e) {
    console.log(`  (skipped: this account cannot create a scratch database — ${String(e.message).slice(0, 160)})`);
  }
  if (legacyDb) {
    const S = (q, p = []) => sqlIn(SCRATCH_DB, q, p);
    S("CREATE TABLE announcements (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, title VARCHAR(300) NOT NULL, body TEXT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    S("CREATE TABLE events (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, title_ta VARCHAR(300) NOT NULL, title_en VARCHAR(300) NOT NULL, description TEXT NULL, event_date DATE NOT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    S("CREATE TABLE sevas (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name_ta VARCHAR(200) NOT NULL, name_en VARCHAR(200) NOT NULL, description TEXT NULL, amount DECIMAL(10,2) NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0, is_featured TINYINT(1) NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    S("CREATE TABLE poojas (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name_ta VARCHAR(200) NOT NULL, name_en VARCHAR(200) NOT NULL, description_ta TEXT NULL, description_en TEXT NULL, pooja_date DATE NOT NULL, pooja_time VARCHAR(20) NULL, pooja_type VARCHAR(20) NOT NULL DEFAULT 'special', is_active TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    S("CREATE TABLE gallery (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, filename VARCHAR(255) NOT NULL, caption VARCHAR(500) NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    S("INSERT INTO announcements (title, body, is_active) VALUES (?,?,1)", [`${P} old notice`, `Old body ${P} old`]);
    S("INSERT INTO events (title_ta, title_en, description, event_date, is_active) VALUES (?,?,?,?,1)", [`${P} பழைய நிகழ்வு`, `${P} old event`, `Old programme ${P} old`, istDay(5)]);
    S("INSERT INTO sevas (name_ta, name_en, description, amount) VALUES (?,?,?,?)", [`${P} பழைய சேவை`, `${P} old seva`, `Old seva text ${P} old`, 101]);
    S("INSERT INTO poojas (name_ta, name_en, pooja_date, pooja_type) VALUES (?,?,?,?)", [`${P} பழைய பூஜை`, `${P} old pooja`, istDay(6), "special"]);
    S("INSERT INTO gallery (filename, caption) VALUES (?,?)", [`${SLUG}-old.jpg`, `${P} old photo`]);
    const ids = {
      ev: Number(S("SELECT id FROM events LIMIT 1").rows[0].id), seva: Number(S("SELECT id FROM sevas LIMIT 1").rows[0].id), photo: Number(S("SELECT id FROM gallery LIMIT 1").rows[0].id),
    };
    const legacyServer = await startServer({ DB_NAME: SCRATCH_DB });
    try {
      check(legacyServer.ready, "a server on the first-release schema answers", legacyServer.log());
      r = await search(`${P} old`, "", legacyServer.base);
      check(r.status === 200 && !FATAL.test(r.text) && Array.isArray(r.json?.groups), "search is 200 JSON without the new columns", `${r.status} ${r.text.slice(0, 200)}`);
      const oldNotice = byTitle(r, "announcements", `${P} old notice`);
      check(oldNotice?.title_ta === `${P} old notice` && oldNotice?.snippet === `Old body ${P} old` && oldNotice?.snippet_ta === `Old body ${P} old`, "an announcement is served from the old title / body", JSON.stringify(oldNotice));
      const oldEvent = byTitle(r, "events", `${P} old event`);
      check(oldEvent?.url === `/events/${ids.ev}` && oldEvent?.snippet_en === `Old programme ${P} old`, "an event links to /events/<id> with the old description as its snippet", JSON.stringify(oldEvent));
      const oldSeva = byTitle(r, "sevas", `${P} old seva`);
      check(oldSeva?.url === `/sevas?seva=${ids.seva}` && oldSeva?.snippet === `Old seva text ${P} old`, "a seva counts as bookable (no is_bookable column) and links to its form", JSON.stringify(oldSeva));
      check(byTitle(r, "poojas", `${P} old pooja`)?.url === "/panchangam", "a pooja is found", JSON.stringify(group(r, "poojas")));
      const oldPhoto = byTitle(r, "gallery", `${P} old photo`);
      check(oldPhoto?.url === `/gallery?photo=${ids.photo}` && oldPhoto?.snippet_ta === null, "a photo is found by caption with no alt text", JSON.stringify(oldPhoto));
      check(group(r, "pages").length === 0, "no CMS page appears (no pages table)", JSON.stringify(group(r, "pages")));
      const legacyItems = (r.json?.groups ?? []).flatMap((g) => g.items);
      check(legacyItems.length === 5 && legacyItems.every((i) => "snippet_ta" in i && "snippet_en" in i), "all five rows are found and every item has both snippet keys", `${legacyItems.length}`);
      r = await search("Temple history", "", legacyServer.base);
      check(urlsOf(r).includes("/about#history"), "the curated pages still answer", urlsOf(r).join(","));
      const legacyLog = legacyServer.log();
      check(!FATAL.test(legacyLog) && !/PHP (?:Warning|Fatal|Notice|Deprecated)/.test(legacyLog) && !/\[search\]/.test(legacyLog), "no PHP error and no skipped query in the legacy server log", legacyLog.slice(-400));
    } finally {
      await stopServer(legacyServer);
    }
  }

  if (own) {
    const log = own.log();
    check(!FATAL.test(log) && !/PHP (?:Warning|Fatal|Notice|Deprecated)/.test(log), "no PHP or MySQL errors in the server log", log.slice(-400));
  }
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  const cleanup = [
    ["DELETE FROM announcements WHERE title LIKE ?", [`${P}%`]],
    ["DELETE FROM events WHERE title_en LIKE ?", [`${P}%`]],
    ["DELETE FROM sevas WHERE name_en LIKE ?", [`${P}%`]],
    ["DELETE FROM gallery WHERE caption LIKE ?", [`${P}%`]],
    ["DELETE FROM gallery_albums WHERE slug LIKE ?", [`${SLUG}%`]],
    ["DELETE FROM pages WHERE slug LIKE ?", [`${SLUG}%`]],
  ];
  if (legacyDb) cleanup.push([`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``, []]);
  for (const [q, p] of cleanup) {
    try { sql(q, p); } catch (e) { console.error(`cleanup failed: ${q} — ${e.message}`); }
  }
  await stopServer(own);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
