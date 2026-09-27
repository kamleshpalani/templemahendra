#!/usr/bin/env node
/**
 * tests/backup-restore.mjs — the backup and restore rehearsal (brief §33 "backup
 * and restore", §40), automated.
 *
 *   1. deploy/backup.sh dumps the database (mysqldump, single transaction,
 *      utf8mb4) and archives uploads/ into a timestamped folder with a
 *      MANIFEST.sha256
 *   2. a copy with one flipped byte is refused by deploy/restore.sh
 *      (checksum mismatch, nothing restored)
 *   3. deploy/restore.sh --db-only --yes restores the dump into a scratch
 *      database templemahendra_restore_<run>, and --uploads-only into a
 *      scratch site root
 *   4. the scratch database has exactly the source's tables, the same row
 *      count in every table, the same foreign keys, and Tamil text byte-for-byte
 *      (a seeded E2E row round-trips); the uploads come back with the same
 *      files and checksums
 *   5. the scratch database, site root and backup folder are removed
 *
 *   node tests/backup-restore.mjs
 *
 * Needs bash with mysqldump, mysql, tar, gzip and sha256sum on PATH (Git Bash
 * on Windows, any Linux host) and the DB_* environment of a database the user
 * may CREATE DATABASE on. Skips with a clear message when mysqldump is missing.
 * Writes one E2E-BACKUP-<run> announcement to the source database while it
 * runs and removes it afterwards.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const RUN = Date.now().toString(36);
const P = `E2E-BACKUP-${RUN}`;
const SCRATCH_DB = `templemahendra_restore_${RUN}`;
const { DB_HOST = "127.0.0.1", DB_PORT = "3306", DB_NAME, DB_USER, DB_PASS = "" } = process.env;
let passed = 0;
let failed = 0;
const check = (ok, label, detail = "") => {
  if (ok) { passed++; console.log(`✓ ${label}`); } else { failed++; console.log(`✗ ${label}${detail ? `\n    ${detail}` : ""}`); }
};
const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function bash(script, env = {}) {
  return spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
}
function mysql(query, db = DB_NAME) {
  const r = spawnSync("mysql", ["-h", DB_HOST, "-P", String(DB_PORT), "-u", DB_USER, `-p${DB_PASS}`, "--default-character-set=utf8mb4", "-N", "-B", ...(db ? [db] : []), "-e", query], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mysql: ${(r.stderr || "").replace(/.*Using a password.*\n?/, "").trim()}`);
  return r.stdout.replace(/\r/g, "").split("\n").filter(Boolean).map((l) => l.split("\t"));
}
const lit = (s) => `'${String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
function tableCounts(db) {
  const tables = mysql(`SELECT table_name FROM information_schema.tables WHERE table_schema = ${lit(db)} AND table_type = 'BASE TABLE' ORDER BY table_name`, null).map((r) => r[0]);
  const out = {};
  for (const t of tables) out[t] = Number(mysql(`SELECT COUNT(*) FROM \`${t}\``, db)[0][0]);
  return out;
}
const fks = (db) => mysql(`SELECT CONCAT(table_name, '.', constraint_name, '→', referenced_table_name) FROM information_schema.referential_constraints WHERE constraint_schema = ${lit(db)} ORDER BY 1`, null).map((r) => r[0]);
function filesUnder(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).replace(/\\/g, "/")] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

const work = mkdtempSync(join(tmpdir(), "tm-backup-"));
let seeded = false;
try {
  if (!DB_NAME || !DB_USER) throw new Error("DB_NAME and DB_USER must be set (source the environment first)");
  const tools = bash("for t in mysqldump mysql tar gzip sha256sum; do command -v $t >/dev/null || echo \"missing $t\"; done");
  if (/missing mysqldump/.test(tools.stdout)) {
    console.log("- mysqldump is not on PATH: the rehearsal was skipped (install the MySQL client tools)");
    console.log(`\nbackup-restore: 0 passed, 0 failed (skipped)`);
    process.exit(0);
  }
  check(tools.status === 0 && tools.stdout.trim() === "", "bash, mysqldump, mysql, tar, gzip and sha256sum are available", tools.stdout.trim());

  /* ── a Tamil row to follow through the round trip ─────────────────── */
  const tamil = `${P} பௌர்ணமி அன்னதானம் — நன்றி`;
  mysql(`INSERT INTO announcements (title, title_ta, title_en, body, is_active) VALUES (${lit(tamil)}, ${lit(tamil)}, ${lit(`${P} Pournami annadanam`)}, 'backup rehearsal', 0)`);
  seeded = true;

  /* ── 1. backup ─────────────────────────────────────────────────────── */
  const out = join(work, "backups");
  const b = bash(`bash deploy/backup.sh --site-root "${posix(resolve(root, "backend"))}" --out "${posix(out)}"`, { DB_HOST, DB_PORT: String(DB_PORT), DB_NAME, DB_USER, DB_PASS });
  check(b.status === 0, "deploy/backup.sh finishes", (b.stderr || b.stdout).slice(-400));
  const stamp = existsSync(out) ? readdirSync(out)[0] : null;
  const dir = stamp ? join(out, stamp) : "";
  check(Boolean(stamp) && /^\d{8}-\d{6}$/.test(stamp), "it writes one timestamped folder", stamp ?? "none");
  for (const f of ["db.sql.gz", "MANIFEST.sha256"]) check(existsSync(join(dir, f)), `…holding ${f}`);
  const hasUploads = existsSync(resolve(root, "backend/uploads"));
  if (hasUploads) check(existsSync(join(dir, "uploads.tar.gz")), "…and uploads.tar.gz");
  const verify = bash(`cd "${posix(dir)}" && sha256sum -c --quiet MANIFEST.sha256`);
  check(verify.status === 0, "every file matches MANIFEST.sha256", (verify.stderr || verify.stdout).slice(-200));
  const dump = bash(`gzip -dc "${posix(join(dir, "db.sql.gz"))}"`).stdout;
  check(dump.includes(tamil), "the dump holds the Tamil row intact (utf8mb4 end to end)");
  check(!/CREATE DATABASE/i.test(dump), "the dump is database-agnostic (no CREATE DATABASE / USE), so it can be restored under another name");

  /* ── 2. a damaged backup is refused ───────────────────────────────── */
  const broken = join(work, "broken");
  cpSync(dir, broken, { recursive: true });
  const gz = readFileSync(join(broken, "db.sql.gz"));
  gz[gz.length - 20] ^= 0xff;
  writeFileSync(join(broken, "db.sql.gz"), gz);
  mysql(`CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`, null);
  const bad = bash(`bash deploy/restore.sh "${posix(broken)}" --db-only --yes`, { DB_HOST, DB_PORT: String(DB_PORT), DB_NAME: SCRATCH_DB, DB_USER, DB_PASS });
  check(bad.status === 3 && /checksum mismatch/.test(bad.stderr + bad.stdout), "restore.sh refuses a backup whose checksum does not match (exit 3)", `exit ${bad.status}: ${(bad.stderr || bad.stdout).slice(-200)}`);
  check(mysql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ${lit(SCRATCH_DB)}`, null)[0][0] === "0", "…and restores nothing");

  /* ── 3. restore into a scratch database and site root ─────────────── */
  const r = bash(`bash deploy/restore.sh "${posix(dir)}" --db-only --yes`, { DB_HOST, DB_PORT: String(DB_PORT), DB_NAME: SCRATCH_DB, DB_USER, DB_PASS });
  check(r.status === 0 && /tables present/.test(r.stdout), "deploy/restore.sh --db-only restores into the scratch database", (r.stderr || r.stdout).slice(-300));

  /* ── 4. compare ────────────────────────────────────────────────────── */
  const src = tableCounts(DB_NAME);
  const dst = tableCounts(SCRATCH_DB);
  check(Object.keys(dst).join() === Object.keys(src).join(), `the same ${Object.keys(src).length} tables`, `missing: ${Object.keys(src).filter((t) => !(t in dst)).join(",")} extra: ${Object.keys(dst).filter((t) => !(t in src)).join(",")}`);
  const diff = Object.keys(src).filter((t) => src[t] !== dst[t]);
  check(diff.length === 0, "the same number of rows in every table", diff.map((t) => `${t} ${src[t]}→${dst[t]}`).join(", "));
  check(fks(SCRATCH_DB).join() === fks(DB_NAME).join(), `the same ${fks(DB_NAME).length} foreign keys`);
  const back = mysql(`SELECT title_ta FROM announcements WHERE title_en = ${lit(`${P} Pournami annadanam`)}`, SCRATCH_DB)[0]?.[0];
  check(back === tamil, "the Tamil text comes back byte for byte", back);
  const charset = mysql(`SELECT DEFAULT_CHARACTER_SET_NAME FROM information_schema.schemata WHERE schema_name = ${lit(SCRATCH_DB)}`, null)[0][0];
  check(charset === "utf8mb4", "the restored database is utf8mb4", charset);

  if (hasUploads) {
    const siteRoot = join(work, "site");
    const u = bash(`bash deploy/restore.sh "${posix(dir)}" --uploads-only --yes --site-root "${posix(siteRoot)}"`);
    check(u.status === 0, "deploy/restore.sh --uploads-only restores the uploads into a scratch site root", (u.stderr || u.stdout).slice(-300));
    const want = filesUnder(resolve(root, "backend/uploads"));
    const got = filesUnder(join(siteRoot, "uploads"));
    const missing = Object.keys(want).filter((f) => got[f] !== want[f]);
    check(Object.keys(want).length > 0 && missing.length === 0, `every upload comes back with the same checksum (${Object.keys(want).length} files)`, missing.slice(0, 5).join(", "));
  }
} catch (e) {
  failed++;
  console.log(`✗ rehearsal stopped: ${e.message}`);
} finally {
  try { if (seeded) mysql(`DELETE FROM announcements WHERE title_en LIKE ${lit(`${P}%`)}`); } catch (e) { console.log(`cleanup (source row): ${e.message}`); }
  try { mysql(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``, null); } catch (e) { console.log(`cleanup (scratch database): ${e.message}`); }
  rmSync(work, { recursive: true, force: true });
  check(!mysql(`SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${lit(SCRATCH_DB)}`, null).length, "the scratch database, site root and backup folder are removed");
}
console.log(`\nbackup-restore: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
