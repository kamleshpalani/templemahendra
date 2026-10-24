import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../src/app.mjs";
import { loadConfig } from "../src/config.mjs";
import { applyMigrations, assertSchemaReady, readMigrations } from "../src/migrations.mjs";

const env = {
  NODE_BACKEND_STAGE: "staging",
  DATABASE_URL: "postgresql://fixture:fixture@localhost/staging",
  DATABASE_TLS: "disable",
};
let database;
let db;
let migrations;
let server;
let origin;
let frontendDir;
const failures = [];

before(async () => {
  database = await PGlite.create();
  // PGlite exec supports multi-statement SQL, like pg's simple-query protocol.
  db = { query: async (sql, params) => {
    if (params !== undefined) return database.query(sql, params);
    const results = await database.exec(sql);
    return results.at(-1) ?? { rows: [] };
  } };
  migrations = await readMigrations();
  await db.query("CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA temple_node_staging");
  await db.query("GRANT USAGE ON SCHEMA temple_node_staging TO anon, authenticated");
  await db.query("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon, authenticated");
  await applyMigrations(db, migrations);
  await db.query("SET TIME ZONE 'Asia/Kolkata'");
  frontendDir = await mkdtemp(join(tmpdir(), "temple-node-test-"));
  await writeFile(join(frontendDir, "index.html"), "<!doctype html><title>Staging fixture</title>");
  await writeFile(join(frontendDir, "fixture.js"), "export default 1;");
  server = createApp({ db, migrations, frontendDir, logger: { error: (...args) => failures.push(args) } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await database?.close();
  if (frontendDir) await rm(frontendDir, { recursive: true });
});

async function get(path, options) {
  const response = await fetch(`${origin}${path}`, options);
  return { response, body: await response.json() };
}

test("configuration is staging-only and never allows remote unverified TLS", () => {
  assert.throws(() => loadConfig({ ...env, NODE_BACKEND_STAGE: "production" }), /not ready for production/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: undefined }), /PostgreSQL connection URL/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: "mysql://fixture:fixture@localhost/staging" }), /PostgreSQL host/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: "postgresql://fixture:fixture@staging.example.test/postgres" }), /loopback/);
  assert.throws(() => loadConfig({ ...env, DATABASE_TLS: "require" }), /verify-full/);
  assert.throws(() => loadConfig({ ...env, PORT: "3000oops" }), /PORT/);
  assert.throws(() => loadConfig({ ...env, PORT: "0" }), /PORT/);
  assert.throws(() => loadConfig({ ...env, DATABASE_URL: `${env.DATABASE_URL}?sslmode=no-verify` }), /without query parameters/);
  assert.equal(loadConfig(env).pool.ssl, false);
  const secure = loadConfig({ ...env, DATABASE_TLS: "verify-full", DATABASE_URL: "postgresql://fixture:fixture@staging.example.test/postgres" });
  assert.equal(secure.pool.ssl.rejectUnauthorized, true);
  assert.equal(secure.pool.max, 5);
});

test("CLI refuses production startup and unconfirmed migrations without connecting", () => {
  const startup = spawnSync(process.execPath, ["backend-node/src/server.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, NODE_BACKEND_STAGE: "production", DATABASE_URL: env.DATABASE_URL },
    encoding: "utf8",
  });
  assert.equal(startup.status, 1);
  assert.match(startup.stderr, /not ready for production/);
  const migration = spawnSync(process.execPath, ["backend-node/scripts/migrate.mjs"], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, ...env, MIGRATION_CONFIRM_HOST: "wrong-host" },
    encoding: "utf8",
  });
  assert.equal(migration.status, 1);
  assert.match(migration.stderr, /MIGRATION_CONFIRM_HOST/);
  assert.equal(migration.stderr.includes(env.DATABASE_URL), false);
});

test("migrations apply only once, record checksums, and refuse edited history", async () => {
  assert.deepEqual(await applyMigrations(db, migrations), []);
  await assertSchemaReady(db, migrations);
  const changed = migrations.map((migration) => ({ ...migration, checksum: "edited" }));
  await assert.rejects(applyMigrations(db, changed), /history does not match/);
  await assertSchemaReady(db, migrations);
  await assert.rejects(assertSchemaReady(db, [...migrations, { name: "002_future.sql" }]), /Pending PostgreSQL/);
});

test("failed migrations roll back schema and metadata changes together", async () => {
  const broken = {
    name: "002_broken.sql",
    checksum: "fixture",
    sql: "CREATE TABLE temple_node_staging.rollback_fixture (id integer); SELECT nonexistent_column;",
  };
  await assert.rejects(applyMigrations(db, [...migrations, broken]));
  const { rows } = await db.query("SELECT to_regclass('temple_node_staging.rollback_fixture') AS name");
  assert.equal(rows[0].name, null);
  await assertSchemaReady(db, migrations);
});

test("five content tables have RLS and anonymous roles cannot access the schema", async () => {
  const { rows } = await db.query(`SELECT relname FROM pg_class
    WHERE relnamespace = 'temple_node_staging'::regnamespace AND relrowsecurity = true ORDER BY relname`);
  assert.deepEqual(rows.map((row) => row.relname), ["announcements", "events", "gallery", "homepage_settings", "sevas"]);
  await db.query("CREATE ROLE fixture_browser");
  for (const role of ["fixture_browser", "anon", "authenticated"]) {
    await db.query(`SET ROLE ${role}`);
    try {
      await assert.rejects(db.query("SELECT * FROM temple_node_staging.announcements"), /permission denied/);
    } finally {
      await db.query("RESET ROLE");
    }
  }
});

test("health checks test the schema and explicitly deny production readiness", async () => {
  for (const path of ["/api/health/live", "/api/health/ready"]) {
    const { response, body } = await get(path);
    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: "ok", stage: "staging-foundation", productionReady: false });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  }
});

test("announcements preserve Tamil, numeric legacy IDs, timestamps, limits, and active filtering", async () => {
  await db.query(`INSERT INTO temple_node_staging.announcements (id, title, body, created_at)
    VALUES (4294967295, $1, $2, '2026-01-01 12:34:56')`, ["திருக்கோவில்", "தமிழ்"]);
  await db.query("INSERT INTO temple_node_staging.announcements (title, is_active) VALUES ('hidden', 0)");
  const { body } = await get("/api/announcements");
  assert.deepEqual(body, [{ id: 4294967295, title: "திருக்கோவில்", body: "தமிழ்", created_at: "2026-01-01 12:34:56" }]);
  await db.query(`INSERT INTO temple_node_staging.announcements (title) SELECT 'fixture-' || n FROM generate_series(1, 60) n`);
  assert.equal((await get("/api/announcements")).body.length, 10);
  assert.equal((await get("/api/announcements?limit=999")).body.length, 50);
  assert.deepEqual((await get("/api/announcements?limit=0")).body, []);
  for (const value of ["-1", "abc", "1%3BSELECT", "1&limit=2"]) {
    assert.equal((await get(`/api/announcements?limit=${value}`)).response.status, 400);
  }
});

test("sevas preserve exact decimal strings and numeric flags and filter featured rows", async () => {
  await db.query(`INSERT INTO temple_node_staging.sevas (name_ta, name_en, amount, is_featured, sort_order)
    VALUES ($1, 'Fixture seva', 12345678.90, 1, -2)`, ["அபிஷேகம்"]);
  await db.query(`INSERT INTO temple_node_staging.sevas (name_ta, name_en, amount)
    SELECT 'fixture', 'Fixture ' || n, 0.10 FROM generate_series(1, 110) n`);
  await db.query("INSERT INTO temple_node_staging.sevas (name_ta, name_en, is_featured, is_active) VALUES ('hidden', 'hidden', 1, 0)");
  const { body } = await get("/api/sevas?featured=1");
  assert.equal(body.length, 1);
  assert.deepEqual(body[0], { id: 1, name_ta: "அபிஷேகம்", name_en: "Fixture seva", description: null, amount: "12345678.90", is_featured: 1 });
  assert.equal((await get("/api/sevas?featured=false")).body.length, 50);
  assert.equal((await get("/api/sevas?featured=0&limit=999")).body.length, 100);
  assert.equal((await get("/api/sevas?featured=1&featured=0")).response.status, 400);
});

test("events use date-only output and upcoming filtering", async () => {
  await db.query(`INSERT INTO temple_node_staging.events (title_ta, title_en, event_date)
    VALUES ('fixture', 'Past', CURRENT_DATE - 1), ('fixture', 'Today', CURRENT_DATE), ('fixture', 'Future', CURRENT_DATE + 1)`);
  await db.query("INSERT INTO temple_node_staging.events (title_ta, title_en, event_date, is_active) VALUES ('hidden', 'Hidden', CURRENT_DATE, 0)");
  const { body } = await get("/api/events?upcoming=1");
  assert.deepEqual(body.map((row) => row.title_en), ["Today", "Future"]);
  assert.match(body[0].event_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await get("/api/events?upcoming=0")).body.length, 3);
  await db.query(`INSERT INTO temple_node_staging.events (title_ta, title_en, event_date)
    SELECT 'fixture', 'Fixture ' || n, CURRENT_DATE FROM generate_series(1, 110) n`);
  assert.equal((await get("/api/events")).body.length, 20);
  assert.equal((await get("/api/events?limit=999")).body.length, 100);
});

test("gallery and settings keep existing output shapes without runtime DDL", async () => {
  await db.query("INSERT INTO temple_node_staging.gallery (filename, caption, created_at) VALUES ('fixture.jpg', 'Fixture', '2026-01-01 10:00:00')");
  await db.query("INSERT INTO temple_node_staging.gallery (filename, is_active) VALUES ('hidden.jpg', 0)");
  assert.deepEqual((await get("/api/gallery")).body, [{ id: 1, filename: "fixture.jpg", caption: "Fixture", created_at: "2026-01-01 10:00:00" }]);
  assert.deepEqual((await get("/api/settings")).body, { show_pournami_section: true, show_nalla_strip: true, show_donor_ticker: true });
  await db.query("UPDATE temple_node_staging.homepage_settings SET val = '0' WHERE key_name = 'show_donor_ticker'");
  assert.equal((await get("/api/settings")).body.show_donor_ticker, false);
});

test("mutations and unported PHP surfaces never return success or the SPA shell", async () => {
  for (const path of ["/api/announcements", "/api/sevas", "/api/events", "/api/gallery", "/api/settings"]) {
    const { response } = await get(path, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  for (const path of ["/api/payments/config", "/api/registrations", "/api/unknown", "/admin", "/admin/login.php", "/uploads/fixture.jpg", "/sitemap.xml"]) {
    const { response, body } = await get(path);
    assert.equal(response.status, 501);
    assert.equal(body.code, "MIGRATION_PENDING");
  }
  const head = await fetch(`${origin}/api/gallery`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("staging static serving supports refreshes and 404s but never serves repository files", async () => {
  for (const [path, expected] of [["/", 200], ["/events", 200], ["/payment/receipt", 200], ["/live-darshan/fixture", 200], ["/missing-page", 404], ["/.env.node.local", 404], ["/backend/config/database.php", 404]]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, expected);
    assert.match(await response.text(), /Staging fixture/);
  }
  assert.equal(await (await fetch(`${origin}/fixture.js`)).text(), "export default 1;");
  assert.equal(await (await fetch(`${origin}/robots.txt`)).text(), "User-agent: *\nDisallow: /\n");
});

test("database failures are explicit, logged, and do not expose driver messages", async () => {
  const failureServer = createApp({
    db: { query: async () => { throw Object.assign(new Error("PRIVATE_VALUE"), { code: "08006" }); } },
    migrations,
    logger: { error: (...args) => failures.push(args) },
  }).listen(0, "127.0.0.1");
  await once(failureServer, "listening");
  try {
    for (const [path, status] of [["/api/health/ready", 503], ["/api/announcements", 500]]) {
      const response = await fetch(`http://127.0.0.1:${failureServer.address().port}${path}`);
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(JSON.stringify(body).includes("PRIVATE_VALUE"), false);
      assert.match(body.reference, /^[a-f0-9-]{36}$/);
    }
    assert.equal(JSON.stringify(failures).includes("PRIVATE_VALUE"), false);
    assert.equal(failures.at(-1)[1].code, "08006");
  } finally {
    await new Promise((resolve, reject) => failureServer.close((error) => error ? reject(error) : resolve()));
  }
});
