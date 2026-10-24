#!/usr/bin/env node
/**
 * tests/admin-bulk-import.mjs — Admin → Bulk Upload end to end, against the
 * real PHP + MySQL stack: upload (CSV and a hand-built .xlsx) → column mapping
 * → validation preview → chunked import → results → error report.
 *
 *   node tests/admin-bulk-import.mjs                        starts its own PHP server
 *   node tests/admin-bulk-import.mjs http://127.0.0.1:8000  runs against that server
 *                                                            (the legacy-schema part is skipped)
 *
 * Sponsors: a CSV with deliberately mismatched headers and an .xlsx of the
 * same shape go through every step and land in the database.
 *
 * Events, sevas and poojas accept every column their admin forms do
 * (migrations 020 and 024), under the same rules (backend/admin/events.php,
 * sevas.php, poojas.php):
 *   the downloadable templates list the new columns, with a Tamil sample row,
 *   and the upload screen explains them;
 *   a file whose headers are the column names maps itself;
 *   Tamil round-trips intact file → preview → MySQL → public API;
 *   events: type, last day, programme times ("7 PM", "6.30 pm", Excel time
 *   cells and DD/MM/YYYY are understood), venue and description in both
 *   languages, picture, featured; the old `description` fills both languages;
 *   sevas: description and timing in both languages, is_bookable (no → the
 *   public search links to the list, not the form), sort order clamped;
 *   poojas: typed times (the display time written from them), sponsorship
 *   amount ("₹2,500") and availability, banner, featured, live stream;
 *   invalid values are refused row by row with the admin form's reason
 *   (unknown type, last day before the first, 25:00, a programme ending
 *   before it starts, javascript: / http: pictures, 30 February, negative
 *   money, "maybe" for yes/no …), listed in the downloadable error report and
 *   never written; a repeated row is a duplicate and skipped;
 *   every import leaves one audit row with its counts;
 *   a database without migrations 020 / 024 still imports: a scratch schema
 *   with the first-release tables is created, served and dropped — its
 *   templates carry the old columns only and the new columns are ignored.
 *
 * Needs the DB_* environment (PHP_BIN optional), migrations 020 and 024, and
 * the admin account admin/Admin@Test123 (ADMIN_USERNAME / ADMIN_PASSWORD /
 * ADMIN_PASS_HASH override). Everything it writes carries the prefix
 * "E2E-BULK-<run>" and is deleted in `finally`; the scratch database
 * e2e_bulk_<run> is dropped there. Requests carry X-Forwarded-For 10.81.x.y.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { deflateRawSync } from "node:zlib";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
const RUN = Date.now().toString(36);
const P = `E2E-BULK-${RUN}`;
const SCRATCH_DB = `e2e_bulk_${RUN}`;
const ADMIN = { username: process.env.ADMIN_USERNAME || "admin", password: process.env.ADMIN_PASSWORD || "Admin@Test123" };
const FATAL = /(<b>Fatal error<\/b>|Uncaught|Stack trace|SQLSTATE|<b>Warning<\/b>|<b>Notice<\/b>|<b>Deprecated<\/b>)/;
const EXTERNAL = (process.argv[2] || "").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const ok = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 500)}` : ""}`);
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
const one = (query, params = []) => sql(query, params).rows[0];

// ── servers ────────────────────────────────────────────────────────────────
async function freePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  return port;
}
const passHash = process.env.ADMIN_PASS_HASH
  || spawnSync(php, ["-r", "echo password_hash($argv[1], PASSWORD_DEFAULT);", ADMIN.password], { encoding: "utf8" }).stdout.trim();
async function startServer(env = {}, backendDir = resolve(root, "backend")) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const server = spawn(php, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: backendDir,
    env: { ...process.env, TRUSTED_PROXIES: "127.0.0.1", ADMIN_USERNAME: ADMIN.username, ADMIN_PASS_HASH: passHash, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { ready = (await fetch(`${base}/admin/login.php`)).status === 200; } catch { /* starting */ }
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

// ── an admin session (cookie jar) ──────────────────────────────────────────
let xffN = 0;
const csrfOf = (h) => /name="_csrf" value="([^"]+)"/.exec(h)?.[1] ?? "";
function session(base) {
  let cookie = "";
  const xff = `10.81.${Math.floor(xffN / 200)}.${(xffN++ % 200) + 10}`;
  const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
  const send = async (path, init) => {
    const r = await fetch(base + path, { redirect: "manual", ...init, headers: { cookie, "X-Forwarded-For": xff, ...(init.headers ?? {}) } });
    grab(r);
    return { status: r.status, headers: r.headers, text: await r.text() };
  };
  const s = {
    base,
    /** The response body as bytes (Response.text() drops a leading BOM). */
    async bytes(path) {
      const r = await fetch(base + path, { redirect: "manual", headers: { cookie, "X-Forwarded-For": xff } });
      grab(r);
      return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
    },
    get: (path) => send(path, { method: "GET" }),
    post: (path, body) => send(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }),
    postForm: (path, fd) => send(path, { method: "POST", body: fd }),
    async login() {
      const page = await s.get("/admin/login.php");
      return s.post("/admin/login.php", { _csrf: csrfOf(page.text), username: ADMIN.username, password: ADMIN.password, next: "" });
    },
  };
  return s;
}
const followed = async (s, r, entity) => (r.status >= 300 && r.status < 400 ? (await s.get(`/admin/bulk_upload.php?entity=${entity}`)).text : r.text);

// ── files ──────────────────────────────────────────────────────────────────
/** The byte-order mark Excel writes at the start of a "CSV UTF-8" file. */
const BOM = String.fromCharCode(0xfeff);
const BOM_START = new RegExp("^" + BOM);
/** RFC 4180 CSV with a UTF-8 BOM, as Excel's "CSV UTF-8" writes it. */
const csv = (rows) => BOM + rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\r\n") + "\r\n";

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0 ^ -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}
function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, "utf8");
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const lf = Buffer.alloc(30);
    lf.writeUInt32LE(0x04034b50, 0); lf.writeUInt16LE(20, 4); lf.writeUInt16LE(0, 6);
    lf.writeUInt16LE(8, 8); lf.writeUInt16LE(0, 10); lf.writeUInt16LE(0, 12);
    lf.writeUInt32LE(crc32(data), 14); lf.writeUInt32LE(comp.length, 18); lf.writeUInt32LE(data.length, 22);
    lf.writeUInt16LE(nameBuf.length, 26); lf.writeUInt16LE(0, 28);
    chunks.push(lf, nameBuf, comp);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += lf.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}
/** A one-sheet .xlsx: strings go to the shared-string table, numbers stay numeric cells (dates and times as Excel serials). */
function xlsx(rows) {
  const strings = [...new Set(rows.flat().filter((c) => typeof c === "string"))];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const si = strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("");
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (c, ref) => (typeof c === "number" ? `<c r="${ref}"><v>${c}</v></c>` : `<c r="${ref}" t="s"><v>${strings.indexOf(c)}</v></c>`);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => cell(c, `${col(ci)}${ri + 1}`)).join("") + "</row>").join("");
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${si}</sst>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ]);
}
/** The Excel serial of a calendar day (1970-01-01 is 25569). */
const excelDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000) + 25569;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ── reading the wizard's pages ─────────────────────────────────────────────
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The column each file column is mapped to, as the page pre-selected it. */
const selectedMap = (html) => {
  const out = {};
  for (const [, idx, opts] of html.matchAll(/<select[^>]*name="map\[(\d+)\][^>]*>([\s\S]*?)<\/select>/g)) {
    out[`map[${idx}]`] = /<option value="([^"]*)"[^>]*selected/.exec(opts)?.[1] ?? "";
  }
  return out;
};
/** Ready / duplicate / invalid counts of the preview. */
const countsOf = (html) => {
  const v = [...html.matchAll(/import-summary__val">(\d+)</g)].map((m) => Number(m[1]));
  return { ready: v[0], dup: v[1], invalid: v[2] };
};
/** Preview rows by file line: status and problems. */
const previewRows = (html) => {
  const body = html.split('<h2 class="subhead">Row preview</h2>')[1] ?? "";
  const rows = {};
  for (const [, cls, tr] of body.matchAll(/<tr class="([^"]*)">([\s\S]*?)<\/tr>/g)) {
    const line = Number(/<td class="num">(\d+)<\/td>/.exec(tr)?.[1] ?? 0);
    const errors = [...(/<div class="row-errors">([\s\S]*?)<\/div>/.exec(tr)?.[1] ?? "").matchAll(/<span>([^<]*)<\/span>/g)].map((m) => decode(m[1]));
    rows[line] = { status: cls.includes("row--invalid") ? "invalid" : cls.includes("row--duplicate") ? "duplicate" : "ok", errors, html: tr };
  }
  return rows;
};

/**
 * Run one file through every step. `mapping` is "auto" (keep what the page
 * pre-selected) or a list of wanted targets by file-column position.
 */
async function runImport(s, entity, filename, body, mime, mapping = "auto") {
  const res = { mapped: false, preview: "", auto: {}, counts: {}, rows: {}, total: 0, imported: 0, done: "", errorsCsv: "" };
  let html = (await s.get(`/admin/bulk_upload.php?entity=${entity}`)).text;
  const fd = new FormData();
  fd.set("_csrf", csrfOf(html)); fd.set("entity", entity); fd.set("action", "upload");
  fd.set("file", new Blob([body], { type: mime }), filename);
  let r = await s.postForm("/admin/bulk_upload.php", fd);
  html = await followed(s, r, entity);
  res.mapped = /name="map\[\d+\]"/.test(html);
  res.mapHtml = html;
  if (!res.mapped) {
    res.problem = html.match(/alert--error[^>]*>([\s\S]{0,200})/)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? html.slice(0, 200);
    return res;
  }
  res.auto = selectedMap(html);
  let map = res.auto;
  if (Array.isArray(mapping)) {
    map = {};
    const selects = [...html.matchAll(/<select[^>]*name="map\[(\d+)\][^>]*>([\s\S]*?)<\/select>/g)];
    selects.forEach(([, idx, opts], i) => { if (mapping[i] && opts.includes(`value="${mapping[i]}"`)) map[`map[${idx}]`] = mapping[i]; });
  }
  res.mapCount = Object.values(map).filter(Boolean).length;
  r = await s.post("/admin/bulk_upload.php", { _csrf: csrfOf(html), entity, action: "map", ...map });
  html = await followed(s, r, entity);
  res.preview = html;
  res.counts = countsOf(html);
  res.rows = previewRows(html);
  if (!/import-summary/.test(html) || !res.counts.ready && !res.counts.dup) return res;

  r = await s.post("/admin/bulk_upload.php", { _csrf: csrfOf(html), entity, action: "confirm", skip_duplicates: "1" });
  html = await followed(s, r, entity);
  res.runner = /data-import-runner/.test(html);
  res.total = Number(/data-total="(\d+)"/.exec(html)?.[1] ?? 0);
  const token = /data-csrf="([^"]+)"/.exec(html)?.[1] ?? csrfOf(html);
  let offset = 0;
  let guard = 0;
  while (offset < res.total && guard++ < 40) {
    const chunk = await s.post("/admin/bulk_upload.php", { _csrf: token, entity, action: "import_chunk", offset: String(offset), limit: "100", skip_duplicates: "1" });
    let j;
    try { j = JSON.parse(chunk.text); } catch { res.chunkError = chunk.text.slice(0, 200); break; }
    if (j.error) { res.chunkError = j.error; break; }
    res.imported += Number(j.ok || 0);
    offset += Number(j.processed || 0) || res.total;
  }
  res.done = (await s.get(`/admin/bulk_upload.php?entity=${entity}&done=1`)).text;
  res.errorsCsv = (await s.get(`/admin/bulk_upload.php?entity=${entity}&errors=1`)).text;
  return res;
}
const hasError = (row, re) => Boolean(row?.errors?.some((e) => re.test(e)));
const errorsOf = (row) => JSON.stringify(row?.errors ?? null);

let own = null;
let legacy = null;
let legacyDb = false;
let legacyTree = "";
let BASE = EXTERNAL;

try {
  if (EXTERNAL) {
    const probe = await fetch(`${EXTERNAL}/admin/login.php`).catch(() => null);
    if (!probe || probe.status !== 200) {
      console.log(`✗ no backend at ${EXTERNAL}.`);
      process.exit(1);
    }
  } else {
    own = await startServer();
    BASE = own.base;
    ok(own.ready, "PHP server started", own.log());
  }
  const admin = session(BASE);
  const signedIn = await admin.login();
  ok(signedIn.status === 302 || signedIn.status === 303, "the admin signs in", `status ${signedIn.status}`);

  /* ── sponsors: mismatched headers, CSV and .xlsx (the original flow) ── */
  section("sponsors: CSV with mismatched headers, then the same shape as .xlsx");
  for (const [label, filename, body, mime] of [
    ["CSV", `${P}-sponsors.csv`, `${BOM}Sponsor Name,Mobile Number,Remark\n${P} Alpha,9000000001,Annadanam sponsor\n${P} Beta,9000000002,Lamp sponsor\n`, "text/csv"],
    ["XLSX", `${P}-sponsors.xlsx`, xlsx([["Sponsor Name", "Mobile Number", "Remark"], [`${P} Gamma`, "9000000003", "Flower sponsor"]]), XLSX_MIME],
  ]) {
    const res = await runImport(admin, "sponsors", filename, body, mime, ["name", "phone", "note"]);
    ok(res.mapped, `${label}: upload reaches the column-mapping step`, res.problem);
    if (!res.mapped) continue;
    ok(res.mapCount >= 1, `${label}: mapping selects offered for the file's columns`);
    ok(/import-summary/.test(res.preview), `${label}: mapping produces a validation preview`);
    ok(res.runner, `${label}: confirm shows the live progress runner`);
    ok(res.imported > 0 && !res.chunkError, `${label}: rows imported`, `${res.imported} of ${res.total} ${res.chunkError ?? ""}`);
    ok(/Import complete|Imported/i.test(res.done), `${label}: results page renders`);
  }
  ok(Number(one("SELECT COUNT(*) AS n FROM sponsors WHERE name LIKE ?", [`${P}%`]).n) === 3, "the three sponsors are in the database");

  /* ── templates and column help (migrations 020 / 024) ──────────────── */
  section("templates and column notes list the new columns");
  const EXPECT = {
    events: "title_ta,title_en,event_type,event_date,end_date,start_time,end_time,venue_ta,venue_en,description_ta,description_en,description,image_url,is_featured,is_active",
    sevas: "name_ta,name_en,description_ta,description_en,description,timing_ta,timing_en,amount,sort_order,is_featured,is_bookable,is_active",
    poojas: "name_ta,name_en,pooja_date,pooja_time,start_time,end_time,pooja_type,description_ta,description_en,sponsorship_amount,sponsorship_available,banner_url,is_featured,live_stream_enabled,is_active",
  };
  const SAMPLE_TA = { events: "தைப்பூசம்", sevas: "அபிஷேகம்", poojas: "பௌர்ணமி பூஜை" };
  for (const entity of Object.keys(EXPECT)) {
    const t = await admin.bytes(`/admin/bulk_upload.php?entity=${entity}&template=1`);
    const lines = t.buf.toString("utf8").replace(BOM_START, "").split(/\r?\n/);
    const bomBytes = t.buf.subarray(0, 3).toString("hex");
    ok(t.status === 200 && /text\/csv/.test(t.headers.get("content-type") ?? "") && bomBytes === "efbbbf", `${entity}: the template is a UTF-8 CSV with a BOM (Excel then opens the Tamil correctly)`, `${t.status} ${t.headers.get("content-type")} ${bomBytes}`);
    ok(lines[0] === EXPECT[entity], `${entity}: the template header lists every column the admin form has`, lines[0]);
    const sample = lines[1] ?? "";
    ok(sample.includes(SAMPLE_TA[entity]) && sample.split(",").length === EXPECT[entity].split(",").length, `${entity}: the sample row is complete and its Tamil is intact`, sample);
  }
  let page = (await admin.get("/admin/bulk_upload.php?entity=events")).text;
  ok(/data-column-help/.test(page) && /<code>event_type<\/code>/.test(page) && /<code>image_url<\/code>/.test(page) && /Old single-language column/.test(page), "events: the upload screen explains the new columns and the old description", page.match(/data-column-help[\s\S]{0,300}/)?.[0]);
  page = (await admin.get("/admin/bulk_upload.php?entity=sevas")).text;
  ok(/<code>is_bookable<\/code>/.test(page) && /<code>timing_ta \/ timing_en<\/code>/.test(page), "sevas: the upload screen explains is_bookable and the timings");
  page = (await admin.get("/admin/bulk_upload.php?entity=poojas")).text;
  ok(/<code>live_stream_enabled<\/code>/.test(page) && /<code>sponsorship_amount<\/code>/.test(page) && /<code>banner_url<\/code>/.test(page), "poojas: the upload screen explains the sponsorship, banner and live-stream columns");
  page = (await admin.get("/admin/bulk_upload.php")).text;
  ok(/15 columns · 3 required/.test(page) && /12 columns · 3 required/.test(page), "the chooser counts the new columns", page.match(/entity-card[\s\S]{0,200}/)?.[0]);

  /* ── events ─────────────────────────────────────────────────────────── */
  section("events: every column of the admin form, the same rules");
  const EV = {
    ta: `${P} தைப்பூசம் விழா`, venueTa: `முருகன் கோயில் மண்டபம் ${P}`, descTa: `காவடி ஊர்வலம் மற்றும் அன்னதானம் ${P}`,
  };
  const evHead = EXPECT.events.split(",");
  const evRows = [
    /* 2 */ [EV.ta, `${P} Thai Poosam`, "Festival", "2035-01-24", "2035-01-25", "06:00", "21:00", EV.venueTa, `Temple mandapam ${P}`, EV.descTa, `Kavadi procession and annadanam ${P}`, "", `/uploads/${P.toLowerCase()}.webp`, "yes", "yes"],
    /* 3 */ [`${P} பழைய விழா`, `${P} Legacy festival`, "", "2035-02-01", "", "7 PM", "", "", "", "", "", `Old programme ${P}`, "", "", ""],
    /* 4 */ [`${P} பங்குனி உத்திரம்`, `${P} Panguni Uthiram`, "pooja", "15/03/2035", "", "6.30 pm", "20:00", "", "", "", "", "", "https://images.example.org/uthiram.jpg", "no", "no"],
    /* 5 */ [`${P} விருந்து`, `${P} Party`, "party", "2035-04-01", "", "", "", "", "", "", "", "", "", "", ""],
    /* 6 */ [`${P} பின்னோக்கி`, `${P} Backwards`, "festival", "2035-04-10", "2035-04-09", "", "", "", "", "", "", "", "", "", ""],
    /* 7 */ [`${P} நேரம் தவறு`, `${P} Bad clock`, "", "2035-04-11", "", "25:00", "", "", "", "", "", "", "", "", ""],
    /* 8 */ [`${P} முன்னதாக முடிவு`, `${P} Ends early`, "", "2035-04-12", "", "18:00", "09:00", "", "", "", "", "", "", "", ""],
    /* 9 */ [`${P} படம் தவறு`, `${P} Script picture`, "", "2035-04-13", "", "", "", "", "", "", "", "", "javascript:alert(1)", "", ""],
    /* 10 */ [`${P} சிறப்பு`, `${P} Maybe featured`, "", "2035-04-14", "", "", "", "", "", "", "", "", "", "maybe", ""],
    /* 11 */ [`${P} பிப்ரவரி`, `${P} February thirtieth`, "", "2035-02-30", "", "", "", "", "", "", "", "", "", "", ""],
    /* 12 */ [`${P} மூன்று நாள்`, `${P} Three nights`, "special", "2035-05-01", "2035-05-03", "20:00", "06:00", "", "", "", "", "", "", "", ""],
    /* 13 */ [`${P} http படம்`, `${P} Plain http picture`, "", "2035-05-10", "", "", "", "", "", "", "", "", "http://images.example.org/x.jpg", "", ""],
    /* 14 */ [`${P} தைப்பூசம் மீண்டும்`, `${P} Thai Poosam`, "festival", "2035-01-24", "", "", "", "", "", "", "", "", "", "", ""],
  ];
  const evFile = `${P}-events.csv`;
  let res = await runImport(admin, "events", evFile, csv([evHead, ...evRows]), "text/csv");
  ok(res.mapped, "the events file reaches the mapping step", res.problem);
  ok(Object.values(res.auto).join(",") === EXPECT.events, "headers that are the column names map themselves", Object.values(res.auto).join(","));
  ok(res.counts.ready === 4 && res.counts.dup === 1 && res.counts.invalid === 8, "the preview: 4 ready, 1 duplicate, 8 invalid", JSON.stringify(res.counts));
  let rows = res.rows;
  ok(rows[2]?.status === "ok", "a complete bilingual row is ready", errorsOf(rows[2]));
  ok(res.preview.includes(`${P} தைப்பூசம்`), "the preview shows the Tamil title intact");
  ok(rows[3]?.status === "ok" && rows[3].html.includes("19:00"), "\"7 PM\" is read as 19:00", errorsOf(rows[3]));
  ok(rows[4]?.status === "ok" && rows[4].html.includes("2035-03-15") && rows[4].html.includes("18:30"), "DD/MM/YYYY and \"6.30 pm\" are understood", errorsOf(rows[4]));
  ok(hasError(rows[5], /^event_type must be festival, pooja, special or other$/), "an unknown event type is refused", errorsOf(rows[5]));
  ok(hasError(rows[6], /^end_date must be on or after event_date$/), "a last day before the first is refused", errorsOf(rows[6]));
  ok(hasError(rows[7], /^start_time must be a time as HH:MM/), "25:00 is refused", errorsOf(rows[7]));
  ok(hasError(rows[8], /^end_time must not be before start_time on a one-day event$/), "a one-day programme that ends before it starts is refused", errorsOf(rows[8]));
  ok(hasError(rows[9], /^image_url must be an https address/), "a javascript: picture is refused", errorsOf(rows[9]));
  ok(hasError(rows[10], /^is_featured must be yes\/no$/), "\"maybe\" is not a yes/no", errorsOf(rows[10]));
  ok(hasError(rows[11], /^event_date must be YYYY-MM-DD$/), "30 February is not a date", errorsOf(rows[11]));
  ok(rows[12]?.status === "ok", "a multi-day event may end its last day earlier than it started the first", errorsOf(rows[12]));
  ok(hasError(rows[13], /^image_url must be an https address/), "a plain http picture is refused", errorsOf(rows[13]));
  ok(rows[14]?.status === "duplicate" && hasError(rows[14], /^Duplicate of row 2$/), "the same title and date twice in one file is a duplicate", errorsOf(rows[14]));
  ok(res.runner && res.total === 13, "confirm starts the chunked import of the whole file", `${res.total}`);
  ok(res.imported === 4 && !res.chunkError, "the four valid rows are written", `${res.imported} ${res.chunkError ?? ""}`);
  ok(/Import complete/.test(res.done) && /<div class="import-summary__val">4<\/div><div class="import-summary__label">Imported/.test(res.done), "the results page reports four imported", res.done.match(/import-summary[\s\S]{0,300}/)?.[0]);
  const evCsvLines = res.errorsCsv.replace(BOM_START, "").split(/\r?\n/);
  ok(evCsvLines[0] === `row,status,problems,${EXPECT.events}` && res.errorsCsv.includes("event_type must be festival, pooja, special or other") && res.errorsCsv.includes(`${P} விருந்து`),
    "the error report lists each refused row with its reason and its Tamil intact", evCsvLines.slice(0, 3).join(" / "));
  ok(evCsvLines.filter((l) => /^\d+,(invalid|duplicate),/.test(l)).length === 9, "…all nine of them, and no row that was imported", `${evCsvLines.length} lines`);

  const evRow = (en) => one("SELECT * FROM events WHERE title_en = ? ORDER BY id LIMIT 1", [en]);
  const thai = evRow(`${P} Thai Poosam`);
  ok(thai && thai.title_ta === EV.ta && thai.venue_ta === EV.venueTa && thai.description_ta === EV.descTa, "Tamil title, venue and description land in MySQL intact", JSON.stringify(thai));
  ok(thai && thai.event_type === "festival" && thai.end_date === "2035-01-25" && thai.start_time === "06:00:00" && thai.end_time === "21:00:00"
    && thai.venue_en === `Temple mandapam ${P}` && thai.description_en === `Kavadi procession and annadanam ${P}` && thai.description === `Kavadi procession and annadanam ${P}`
    && thai.image_url === `/uploads/${P.toLowerCase()}.webp` && Number(thai.is_featured) === 1 && Number(thai.is_active) === 1,
    "every new column is stored (type lower-cased, the old description = English)", JSON.stringify(thai));
  ok(Number(one("SELECT COUNT(*) AS n FROM events WHERE title_en = ?", [`${P} Thai Poosam`]).n) === 1, "the duplicate row was skipped");
  const oldEv = evRow(`${P} Legacy festival`);
  ok(oldEv && oldEv.description_ta === `Old programme ${P}` && oldEv.description_en === `Old programme ${P}` && oldEv.description === `Old programme ${P}`,
    "the old description column fills both languages, as migration 020 backfilled", JSON.stringify(oldEv));
  ok(oldEv && oldEv.event_type === "other" && oldEv.start_time === "19:00:00" && oldEv.end_date === null && Number(oldEv.is_featured) === 0 && Number(oldEv.is_active) === 1,
    "blank type is other, blank featured is no, blank active is yes", JSON.stringify(oldEv));
  const uth = evRow(`${P} Panguni Uthiram`);
  ok(uth && uth.event_date === "2035-03-15" && uth.start_time === "18:30:00" && uth.end_time === "20:00:00" && uth.image_url === "https://images.example.org/uthiram.jpg" && Number(uth.is_active) === 0,
    "the normalised date and time, the https picture and is_active = no are stored", JSON.stringify(uth));
  const three = evRow(`${P} Three nights`);
  ok(three && three.end_date === "2035-05-03" && three.start_time === "20:00:00" && three.end_time === "06:00:00", "the multi-day event keeps its evening-to-morning times", JSON.stringify(three));
  for (const refused of ["Party", "Backwards", "Bad clock", "Ends early", "Script picture", "Maybe featured", "February thirtieth", "Plain http picture"]) {
    if (evRow(`${P} ${refused}`)) ok(false, `the refused row "${refused}" was not written`);
  }
  ok(Number(one("SELECT COUNT(*) AS n FROM events WHERE title_en LIKE ?", [`${P}%`]).n) === 4, "no refused row was written");
  const evAudit = one("SELECT COUNT(*) AS n, MAX(detail) AS detail FROM admin_activity WHERE action = 'bulk_import' AND subject = 'bulk:events' AND detail LIKE ?", [`${evFile} ·%`]);
  ok(Number(evAudit.n) === 1 && /4 inserted, 0 failed, 1 duplicates skipped, 8 invalid skipped/.test(evAudit.detail ?? ""), "one audit row records the import and its counts", JSON.stringify(evAudit));

  // Admin import → MySQL → public API, in both languages.
  let api = await fetch(`${BASE}/api/events/${thai?.id}`).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const apiEv = api.json?.data ?? api.json;
  ok(api.status === 200 && apiEv?.title_ta === EV.ta && apiEv?.venue_ta === EV.venueTa && apiEv?.start_time === "06:00" && apiEv?.event_type === "festival" && apiEv?.is_featured === true,
    "GET /api/events/<id> serves the imported event with its Tamil intact", JSON.stringify(apiEv)?.slice(0, 300));
  api = await fetch(`${BASE}/api/search?q=${encodeURIComponent(`மண்டபம் ${P}`)}`).then((r) => r.json());
  const evHit = api.groups?.find((g) => g.type === "events")?.items.find((i) => i.title_en === `${P} Thai Poosam`);
  ok(evHit?.url === `/events/${thai?.id}` && evHit?.title_ta === EV.ta, "site search finds it by its Tamil venue and links to /events/<id>", JSON.stringify(evHit));

  /* events from an .xlsx: Excel date serials and time cells */
  const xlsxFile = `${P}-events.xlsx`;
  res = await runImport(admin, "events", xlsxFile, xlsx([
    ["title_ta", "title_en", "event_date", "start_time", "end_time", "venue_ta"],
    [`${P} கார்த்திகை தீபம்`, `${P} Karthigai Deepam`, excelDay("2035-06-01"), 0.75, 0.875, `மலை உச்சி ${P}`],
  ]), XLSX_MIME);
  ok(res.mapped && res.counts.ready === 1 && res.counts.invalid === 0, "an .xlsx with real date and time cells validates", `${JSON.stringify(res.counts)} ${res.problem ?? ""} ${JSON.stringify(Object.values(res.rows)[0]?.errors ?? [])}`);
  const deepam = evRow(`${P} Karthigai Deepam`);
  ok(deepam && deepam.event_date === "2035-06-01" && deepam.start_time === "18:00:00" && deepam.end_time === "21:00:00" && deepam.venue_ta === `மலை உச்சி ${P}`,
    "Excel serials become the date and 18:00 – 21:00, Tamil intact", JSON.stringify(deepam));

  /* ── sevas ──────────────────────────────────────────────────────────── */
  section("sevas: description and timing in both languages, is_bookable, the same rules");
  const SV = { ta: `${P} அபிஷேகம்`, descTa: `சுவாமிக்கு புனித நீராட்டு ${P}`, timingTa: "தினமும் காலை 7–9" };
  const svRows = [
    /* 2 */ [SV.ta, `${P} Abhishekam`, SV.descTa, `Sacred bathing of the deity ${P}`, "", SV.timingTa, "Daily 7–9 am", "₹1,001", "9001", "yes", "yes", "yes"],
    /* 3 */ [`${P} அன்னதானம்`, `${P} Annadanam`, "", "", `Feeding devotees ${P}`, "", "", "5000", "", "", "no", ""],
    /* 4 */ [`${P} விளக்கு`, `${P} Lamp`, "", `<script>alert(1)</script>Lamp offering ${P}`, "", "", "", "51", "99999999999", "", "", ""],
    /* 5 */ [`${P} எதிர்மறை`, `${P} Negative`, "", "", "", "", "", "-5", "", "", "", ""],
    /* 6 */ [`${P} ஒருவேளை`, `${P} Perhaps bookable`, "", "", "", "", "", "10", "", "", "perhaps", ""],
    /* 7 */ [`${P} விலை இல்லை`, `${P} No price`, "", "", "", "", "", "", "", "", "", ""],
  ];
  const svFile = `${P}-sevas.csv`;
  res = await runImport(admin, "sevas", svFile, csv([EXPECT.sevas.split(","), ...svRows]), "text/csv");
  ok(Object.values(res.auto).join(",") === EXPECT.sevas, "the seva headers map themselves", Object.values(res.auto).join(","));
  ok(res.counts.ready === 3 && res.counts.invalid === 3, "the preview: 3 ready, 3 invalid", JSON.stringify(res.counts));
  rows = res.rows;
  ok(hasError(rows[5], /^amount must be between 0 and 99,999,999\.99$/), "a negative price is refused", errorsOf(rows[5]));
  ok(hasError(rows[6], /^is_bookable must be yes\/no$/), "\"perhaps\" is not a yes/no for is_bookable", errorsOf(rows[6]));
  ok(hasError(rows[7], /^amount is required$/), "a seva without a price is refused", errorsOf(rows[7]));
  ok(res.imported === 3 && !res.chunkError, "the three valid sevas are written", `${res.imported} ${res.chunkError ?? ""}`);
  const svRow = (en) => one("SELECT * FROM sevas WHERE name_en = ? ORDER BY id LIMIT 1", [en]);
  const abh = svRow(`${P} Abhishekam`);
  ok(abh && abh.name_ta === SV.ta && abh.description_ta === SV.descTa && abh.timing_ta === SV.timingTa && abh.timing_en === "Daily 7–9 am"
    && abh.description_en === `Sacred bathing of the deity ${P}` && abh.description === `Sacred bathing of the deity ${P}`
    && abh.amount === "1001.00" && Number(abh.sort_order) === 9001 && Number(abh.is_featured) === 1 && Number(abh.is_bookable) === 1 && Number(abh.is_active) === 1,
    "Tamil name, description and timing intact; \"₹1,001\" is 1001.00; every flag stored", JSON.stringify(abh));
  const anna = svRow(`${P} Annadanam`);
  ok(anna && anna.description_ta === `Feeding devotees ${P}` && anna.description_en === `Feeding devotees ${P}` && Number(anna.is_bookable) === 0 && Number(anna.is_featured) === 0 && Number(anna.is_active) === 1 && Number(anna.sort_order) === 0,
    "the old description fills both languages; is_bookable = no is stored as 0", JSON.stringify(anna));
  const lamp = svRow(`${P} Lamp`);
  ok(lamp && Number(lamp.is_bookable) === 1 && Number(lamp.sort_order) === 2147483647 && !/<script/i.test(lamp.description_en ?? ""),
    "blank is_bookable means bookable, a huge sort order is clamped to the INT range, markup is stripped", JSON.stringify(lamp));
  ok(Number(one("SELECT COUNT(*) AS n FROM sevas WHERE name_en LIKE ?", [`${P}%`]).n) === 3, "no refused seva was written");
  api = await fetch(`${BASE}/api/search?q=${encodeURIComponent(`${P} Abhishekam`)}`).then((r) => r.json());
  const abhHit = api.groups?.find((g) => g.type === "sevas")?.items.find((i) => i.title_en === `${P} Abhishekam`);
  ok(abhHit?.url === `/sevas?seva=${abh?.id}` && abhHit?.title_ta === SV.ta, "site search links the bookable seva to its booking form", JSON.stringify(abhHit));
  api = await fetch(`${BASE}/api/search?q=${encodeURIComponent(`${P} Annadanam`)}`).then((r) => r.json());
  const annaHit = api.groups?.find((g) => g.type === "sevas")?.items.find((i) => i.title_en === `${P} Annadanam`);
  ok(annaHit?.url === "/sevas", "…and the seva imported as not bookable to the list", JSON.stringify(annaHit));

  /* ── poojas ─────────────────────────────────────────────────────────── */
  section("poojas: typed times, sponsorship, banner, featured, live stream, the same rules");
  const PJ = { ta: `${P} பிரதோஷ பூஜை`, descTa: `நந்திக்கு சிறப்பு அபிஷேகம் ${P}` };
  const pjRows = [
    /* 2 */ [PJ.ta, `${P} Pradosham`, "2035-05-10", "", "4:30 pm", "18:00", "Pradosham", PJ.descTa, `Special abhishekam for Nandi ${P}`, "₹2,500", "no", `/uploads/${P.toLowerCase()}-banner.webp`, "yes", "yes", "yes"],
    /* 3 */ [`${P} தினசரி பூஜை`, `${P} Daily`, "2035-05-11", "07:00 AM", "", "", "DAILY", "", "", "", "", "", "", "", ""],
    /* 4 */ [`${P} நேர முரண்`, `${P} Equal times`, "2035-05-12", "", "18:00", "18:00", "", "", "", "", "", "", "", "", ""],
    /* 5 */ [`${P} ftp படம்`, `${P} Ftp banner`, "2035-05-13", "", "", "", "", "", "", "", "", "ftp://example.org/b.png", "", "", ""],
    /* 6 */ [`${P} கடன்`, `${P} Negative sponsorship`, "2035-05-14", "", "", "", "", "", "", "-1", "", "", "", "", ""],
    /* 7 */ [`${P} நேரலை`, `${P} Live x`, "2035-05-15", "", "", "", "", "", "", "", "", "", "", "x", ""],
    /* 8 */ [`${P} பிறந்தநாள்`, `${P} Birthday`, "2035-05-16", "", "", "", "birthday", "", "", "", "", "", "", "", ""],
    /* 9 */ [`${P} பதின்மூன்றாம் மாதம்`, `${P} Month thirteen`, "2035-13-01", "", "", "", "", "", "", "", "", "", "", "", ""],
    /* 10 */ [`${P} சேர்ப்பு மிகை`, `${P} Huge sponsorship`, "2035-05-17", "", "", "", "", "", "", "100000000", "", "", "", "", ""],
  ];
  const pjFile = `${P}-poojas.csv`;
  res = await runImport(admin, "poojas", pjFile, csv([EXPECT.poojas.split(","), ...pjRows]), "text/csv");
  ok(Object.values(res.auto).join(",") === EXPECT.poojas, "the pooja headers map themselves", Object.values(res.auto).join(","));
  ok(res.counts.ready === 2 && res.counts.invalid === 7, "the preview: 2 ready, 7 invalid", JSON.stringify(res.counts));
  rows = res.rows;
  ok(hasError(rows[4], /^end_time must be after start_time$/), "an end time that is not after the start is refused", errorsOf(rows[4]));
  ok(hasError(rows[5], /^banner_url must be a site path/), "an ftp: banner is refused", errorsOf(rows[5]));
  ok(hasError(rows[6], /^sponsorship_amount must be the sponsorship amount in rupees, 0 or more$/), "a negative sponsorship is refused", errorsOf(rows[6]));
  ok(hasError(rows[7], /^live_stream_enabled must be yes\/no$/), "\"x\" is not a yes/no for live_stream_enabled", errorsOf(rows[7]));
  ok(hasError(rows[8], /^pooja_type must be one of pournami, amavasai, ekadasi, sashti, pradosham, chaturthi, abhishekam, archana, festival, special, monthly, daily$/), "an unknown pooja type is refused, with the list of types", errorsOf(rows[8]));
  ok(hasError(rows[9], /^pooja_date must be YYYY-MM-DD$/), "month 13 is not a date", errorsOf(rows[9]));
  ok(hasError(rows[10], /^sponsorship_amount must be/), "a sponsorship above the column's range is refused", errorsOf(rows[10]));
  ok(res.imported === 2 && !res.chunkError, "the two valid poojas are written", `${res.imported} ${res.chunkError ?? ""}`);
  const pjRow = (en) => one("SELECT * FROM poojas WHERE name_en = ? ORDER BY id LIMIT 1", [en]);
  const prad = pjRow(`${P} Pradosham`);
  ok(prad && prad.name_ta === PJ.ta && prad.description_ta === PJ.descTa && prad.pooja_type === "pradosham" && prad.start_time === "16:30:00" && prad.end_time === "18:00:00"
    && prad.pooja_time === "4:30 PM – 6:00 PM" && prad.sponsorship_amount === "2500.00" && Number(prad.sponsorship_available) === 0
    && prad.banner_url === `/uploads/${P.toLowerCase()}-banner.webp` && Number(prad.is_featured) === 1 && Number(prad.live_stream_enabled) === 1 && Number(prad.is_active) === 1,
    "Tamil intact; typed times, the display time written from them, \"₹2,500\", availability, banner and both flags stored", JSON.stringify(prad));
  const daily = pjRow(`${P} Daily`);
  ok(daily && daily.pooja_type === "daily" && daily.pooja_time === "07:00 AM" && daily.start_time === null && daily.sponsorship_amount === null
    && Number(daily.sponsorship_available) === 1 && Number(daily.is_featured) === 0 && Number(daily.live_stream_enabled) === 0 && Number(daily.is_active) === 1,
    "the old free-text time is kept; blank availability is yes, blank featured / live stream are no", JSON.stringify(daily));
  ok(Number(one("SELECT COUNT(*) AS n FROM poojas WHERE name_en LIKE ?", [`${P}%`]).n) === 2, "no refused pooja was written");
  api = await fetch(`${BASE}/api/poojas?all=1&limit=100&type=pradosham`).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const pjList = Array.isArray(api.json) ? api.json : (api.json?.data ?? api.json?.poojas ?? api.json?.items ?? []);
  const pjApi = (Array.isArray(pjList) ? pjList : []).find((p) => p.name_en === `${P} Pradosham`);
  ok(api.status === 200 && pjApi?.name_ta === PJ.ta && pjApi?.sponsorship_amount === 2500 && pjApi?.live_stream_enabled === true && pjApi?.banner_url === prad?.banner_url,
    "GET /api/poojas serves the imported pooja with its sponsorship, banner and live-stream flag", JSON.stringify(pjApi ?? api.json)?.slice(0, 300));

  /* ── a database without migrations 020 / 024 ────────────────────────── */
  section("a database without migrations 020 / 024 still imports (scratch first-release schema)");
  if (EXTERNAL) {
    console.log("  (skipped: runs only when this suite starts its own server)");
  } else {
    try {
      sql(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      legacyDb = true;
    } catch (e) {
      console.log(`  (skipped: this account cannot create a scratch database — ${String(e.message).slice(0, 160)})`);
    }
  }
  if (legacyDb) {
    const S = (q, p = []) => sqlIn(SCRATCH_DB, q, p);
    // The three tables as database/schema.sql first created them.
    S("CREATE TABLE sevas (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name_ta VARCHAR(200) NOT NULL, name_en VARCHAR(200) NOT NULL, description TEXT NULL, amount DECIMAL(10,2) NOT NULL DEFAULT 0.00, sort_order INT NOT NULL DEFAULT 0, is_featured TINYINT(1) NOT NULL DEFAULT 0, is_active TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    S("CREATE TABLE events (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, title_ta VARCHAR(300) NOT NULL, title_en VARCHAR(300) NOT NULL, description TEXT NULL, event_date DATE NOT NULL, is_active TINYINT(1) NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    S("CREATE TABLE poojas (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name_ta VARCHAR(200) NOT NULL, name_en VARCHAR(200) NOT NULL, description_ta TEXT NULL, description_en TEXT NULL, pooja_date DATE NOT NULL, pooja_time VARCHAR(20) NULL, pooja_type ENUM('pournami','amavasai','ekadasi','sashti','special','monthly','daily') NOT NULL DEFAULT 'special', is_active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    // Served from a copy of backend/ outside the checkout: auth.php loads the
    // repository's .env.local over the environment, which would point the
    // admin pages back at the real database (see the suite's report).
    legacyTree = mkdtempSync(join(tmpdir(), "e2e-bulk-"));
    const skip = new Set(["uploads", "logs"].map((d) => resolve(root, "backend", d)));
    cpSync(resolve(root, "backend"), join(legacyTree, "backend"), { recursive: true, filter: (src) => !skip.has(resolve(src)) });
    legacy = await startServer({ DB_NAME: SCRATCH_DB }, join(legacyTree, "backend"));
    ok(legacy.ready, "a server on the first-release schema answers", legacy.log());
    const old = session(legacy.base);
    const oldIn = await old.login();
    ok(oldIn.status === 302 || oldIn.status === 303, "the admin signs in there", `status ${oldIn.status}`);
    const OLD = {
      events: "title_ta,title_en,event_date,description,is_active",
      sevas: "name_ta,name_en,description,amount,sort_order,is_featured,is_active",
      poojas: "name_ta,name_en,pooja_date,pooja_time,pooja_type,description_ta,description_en,is_active",
    };
    for (const entity of Object.keys(OLD)) {
      const t = await old.get(`/admin/bulk_upload.php?entity=${entity}&template=1`);
      ok(t.status === 200 && t.text.replace(BOM_START, "").split(/\r?\n/)[0] === OLD[entity], `${entity}: the template offers the first-release columns only`, t.text.slice(0, 160));
    }
    // A file written for the new columns: the old ones import, the new ones are ignored.
    res = await runImport(old, "events", `${P}-old-events.csv`, csv([
      ["title_ta", "title_en", "event_date", "description", "venue_en", "event_type"],
      [`${P} பழைய தளம்`, `${P} Old site event`, "2035-07-01", `Old site programme ${P}`, "Mandapam", "festival"],
    ]), "text/csv");
    ok(res.mapped && !/value="venue_en"/.test(res.mapHtml) && !/value="event_type"/.test(res.mapHtml), "the mapping step offers no column the database lacks", res.problem);
    ok(res.counts.ready === 1 && /Ignored file column\(s\): <strong>venue_en, event_type<\/strong>/.test(res.preview), "the new columns are listed as ignored", `${JSON.stringify(res.counts)} ${res.preview.match(/Ignored file column[^<]*<strong>[^<]*/)?.[0]}`);
    ok(res.imported === 1 && !res.chunkError, "the event is written", `${res.imported} ${res.chunkError ?? ""}`);
    const oldRow = S("SELECT title_ta, description, event_date FROM events WHERE title_en = ?", [`${P} Old site event`]).rows[0];
    ok(oldRow?.title_ta === `${P} பழைய தளம்` && oldRow?.description === `Old site programme ${P}` && oldRow?.event_date === "2035-07-01", "…with its Tamil title and the single description", JSON.stringify(oldRow));
    res = await runImport(old, "sevas", `${P}-old-sevas.csv`, csv([OLD.sevas.split(","), [`${P} பழைய சேவை`, `${P} Old seva`, `Old seva text ${P}`, "101", "", "", ""]]), "text/csv");
    ok(res.imported === 1 && Number(S("SELECT COUNT(*) AS n FROM sevas WHERE name_en = ?", [`${P} Old seva`]).rows[0].n) === 1, "a seva imports into the old table", `${res.imported} ${JSON.stringify(res.counts)} ${res.chunkError ?? ""}`);
    res = await runImport(old, "poojas", `${P}-old-poojas.csv`, csv([OLD.poojas.split(","),
      [`${P} பழைய பூஜை`, `${P} Old pooja`, "2035-07-02", "06:00 AM", "pournami", "", "", ""],
      [`${P} பிரதோஷம்`, `${P} Old pradosham`, "2035-07-03", "", "pradosham", "", "", ""]]), "text/csv");
    ok(res.counts.ready === 1 && hasError(res.rows[3], /^pooja_type must be one of pournami, amavasai, ekadasi, sashti, special, monthly, daily$/),
      "a type the old ENUM does not have is refused before MySQL sees it", `${JSON.stringify(res.counts)} ${errorsOf(res.rows[3])}`);
    ok(res.imported === 1 && S("SELECT pooja_time FROM poojas WHERE name_en = ?", [`${P} Old pooja`]).rows[0]?.pooja_time === "06:00 AM", "the valid pooja imports with its time", `${res.imported} ${res.chunkError ?? ""}`);
    const legacyLog = legacy.log();
    ok(!FATAL.test(legacyLog) && !/PHP (?:Warning|Fatal|Notice|Deprecated)/.test(legacyLog), "no PHP error in the legacy server log", legacyLog.slice(-400));
  }

  if (own) {
    const log = own.log();
    ok(!FATAL.test(log) && !/PHP (?:Warning|Fatal|Notice|Deprecated)/.test(log), "no PHP or MySQL errors in the server log", log.slice(-400));
  }
} catch (e) {
  ok(false, "the suite ran to the end", e.stack || String(e));
} finally {
  const cleanup = [
    ["DELETE FROM sponsors WHERE name LIKE ?", [`${P}%`]],
    ["DELETE FROM events WHERE title_en LIKE ?", [`${P}%`]],
    ["DELETE FROM sevas WHERE name_en LIKE ?", [`${P}%`]],
    ["DELETE FROM poojas WHERE name_en LIKE ?", [`${P}%`]],
    ["DELETE FROM admin_activity WHERE action = 'bulk_import' AND detail LIKE ?", [`${P}%`]],
  ];
  if (legacyDb) cleanup.push([`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``, []]);
  for (const [q, p] of cleanup) {
    try { sql(q, p); } catch (e) { console.error(`cleanup failed: ${q} — ${e.message}`); }
  }
  await stopServer(legacy);
  if (legacyTree) {
    try { rmSync(legacyTree, { recursive: true, force: true }); } catch (e) { console.error(`cleanup failed: ${legacyTree} — ${e.message}`); }
  }
  await stopServer(own);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
