// End-to-end test of the bulk import: CSV with deliberately mismatched
// headers -> column mapping -> validation preview -> chunked import -> results.
// Also builds a minimal .xlsx by hand (no npm deps) to exercise that reader.
import { deflateRawSync } from "node:zlib";

const base = process.argv[2] || "http://127.0.0.1:8000";
let pass = 0, fail = 0;
const ok = (c, n, d = "") => { c ? pass++ : fail++; console.log(`${c ? "✓" : "✗"} ${n}${d ? " — " + d : ""}`); };

let cookie = "";
const grab = (r) => { for (const c of r.headers.getSetCookie?.() ?? []) { const m = /^(PHPSESSID=[^;]+)/.exec(c); if (m) cookie = m[1]; } };
const get = async (p) => { const r = await fetch(base + p, { headers: { cookie }, redirect: "manual" }); grab(r); return r; };
const post = async (p, b) => { const r = await fetch(base + p, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(b), redirect: "manual" }); grab(r); return r; };
const postForm = async (p, fd) => { const r = await fetch(base + p, { method: "POST", headers: { cookie }, body: fd, redirect: "manual" }); grab(r); return r; };
const csrfOf = (h) => /name="_csrf" value="([^"]+)"/.exec(h)?.[1];

// ── minimal .xlsx writer ────────────────────────────────────────────────────
function crc32(buf) {
  let c, table = [];
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
function xlsx(rows) {
  const strings = [...new Set(rows.flat())];
  const si = strings.map((s) => `<si><t>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("");
  const col = (i) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) =>
    `<row r="${ri + 1}">` + r.map((c, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${strings.indexOf(c)}</v></c>`).join("") + "</row>").join("");
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${si}</sst>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ]);
}

// ── sign in ─────────────────────────────────────────────────────────────────
const lg = await get("/admin/login.php");
await post("/admin/login.php", { _csrf: csrfOf(await lg.text()), username: "admin", password: "Admin@Test123" });

async function runImport(label, filename, body, mime) {
  // step 2: upload
  let html = await (await get("/admin/bulk_upload.php?entity=sponsors")).text();
  let csrf = csrfOf(html);
  const fd = new FormData();
  fd.set("_csrf", csrf); fd.set("entity", "sponsors"); fd.set("action", "upload");
  fd.set("csv", new Blob([body], { type: mime }), filename);
  let r = await postForm("/admin/bulk_upload.php", fd);
  html = r.status === 303 || r.status === 302 ? await (await get("/admin/bulk_upload.php?entity=sponsors")).text() : await r.text();
  const mapped = /Map columns|Maps to|map\[/.test(html);
  ok(mapped, `${label}: upload reaches the column-mapping step`, mapped ? "" : html.match(/alert--error[^>]*>([\s\S]{0,120})/)?.[1]?.replace(/<[^>]+>/g, " ").trim());
  if (!mapped) return;

  // step 3: map columns — pick the select options the page offers
  csrf = csrfOf(html);
  const selects = [...html.matchAll(/<select[^>]*name="map\[(\d+)\][^>]*>([\s\S]*?)<\/select>/g)];
  const mapping = {};
  const want = ["name", "phone", "note"];
  selects.forEach(([, idx, opts], i) => { if (want[i] && opts.includes(`value="${want[i]}"`)) mapping[`map[${idx}]`] = want[i]; });
  ok(Object.keys(mapping).length >= 1, `${label}: mapping selects offered for ${selects.length} file column(s)`);
  r = await post("/admin/bulk_upload.php", { _csrf: csrf, entity: "sponsors", action: "map", ...mapping });
  html = r.status >= 300 ? await (await get("/admin/bulk_upload.php?entity=sponsors")).text() : await r.text();
  const preview = /Ready|Validate|import-summary/.test(html);
  ok(preview, `${label}: mapping produces a validation preview`);
  if (!preview) return;

  // step 4/5: confirm -> chunked import
  csrf = csrfOf(html);
  r = await post("/admin/bulk_upload.php", { _csrf: csrf, entity: "sponsors", action: "confirm", skip_duplicates: "1" });
  html = r.status >= 300 ? await (await get("/admin/bulk_upload.php?entity=sponsors")).text() : await r.text();
  const runner = /data-import-runner/.test(html);
  ok(runner, `${label}: confirm shows the live progress runner`);
  const total = Number(/data-total="(\d+)"/.exec(html)?.[1] ?? 0);
  const token = /data-csrf="([^"]+)"/.exec(html)?.[1] ?? csrf;
  let offset = 0, imported = 0, guard = 0;
  while (offset < total && guard++ < 40) {
    const res = await post("/admin/bulk_upload.php", { _csrf: token, entity: "sponsors", action: "import_chunk", offset: String(offset), limit: "100", skip_duplicates: "1" });
    const txt = await res.text();
    let j; try { j = JSON.parse(txt); } catch { ok(false, `${label}: import_chunk returns JSON`, txt.slice(0, 120)); return; }
    if (j.error) { ok(false, `${label}: import_chunk error`, j.error); return; }
    imported += Number(j.ok || 0); offset += Number(j.processed || 0) || total;
  }
  ok(imported > 0, `${label}: rows imported`, `${imported} of ${total}`);
  const done = await (await get("/admin/bulk_upload.php?entity=sponsors&done=1")).text();
  ok(/Import complete|Imported/i.test(done), `${label}: results page renders`);
}

// CSV with deliberately non-matching headers (exercises the mapping step)
await runImport("CSV", "sponsors.csv",
  "﻿Sponsor Name,Mobile Number,Remark\nBULKTEST Alpha,9000000001,Annadanam sponsor\nBULKTEST Beta,9000000002,Lamp sponsor\n",
  "text/csv");

// XLSX with the same shape
await runImport("XLSX", "sponsors.xlsx",
  xlsx([["Sponsor Name", "Mobile Number", "Remark"], ["BULKTEST Gamma", "9000000003", "Flower sponsor"]]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

console.log(`\n${pass} passed, ${fail} failed`);
console.log("CLEANUP: DELETE FROM sponsors WHERE name LIKE 'BULKTEST%'");
process.exit(fail ? 1 : 0);
