import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

const directory = new URL("../../database/postgres/", import.meta.url);

export class MigrationError extends Error {}

export async function readMigrations() {
  const files = (await readdir(directory)).filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length === 0) throw new MigrationError("No PostgreSQL migrations found.");
  return Promise.all(files.map(async (name) => {
    const sql = await readFile(new URL(name, directory), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

function validateApplied(rows, migrations) {
  for (const [index, row] of rows.entries()) {
    const migration = migrations[index];
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new MigrationError("Database migration history does not match this release.");
    }
  }
}

export async function assertSchemaReady(db, migrations) {
  const { rows } = await db.query("SELECT name, checksum FROM temple_node_staging.schema_migrations ORDER BY name");
  validateApplied(rows, migrations);
  if (rows.length !== migrations.length) throw new MigrationError("Pending PostgreSQL migrations; run db:migrate on staging.");
}

export async function applyMigrations(db, migrations) {
  await db.query("BEGIN");
  try {
    await db.query("CREATE SCHEMA IF NOT EXISTS temple_node_staging");
    await db.query("REVOKE ALL ON SCHEMA temple_node_staging FROM PUBLIC");
    await db.query(`CREATE TABLE IF NOT EXISTS temple_node_staging.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query("LOCK TABLE temple_node_staging.schema_migrations IN EXCLUSIVE MODE");
    const { rows } = await db.query("SELECT name, checksum FROM temple_node_staging.schema_migrations ORDER BY name");
    validateApplied(rows, migrations);
    const applied = [];
    for (const migration of migrations) {
      if (rows.some((row) => row.name === migration.name)) continue;
      await db.query(migration.sql);
      await db.query(
        "INSERT INTO temple_node_staging.schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum],
      );
      applied.push(migration.name);
    }
    await db.query("COMMIT");
    return applied;
  } catch (error) {
    try {
      await db.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Migration and rollback both failed.");
    }
    throw error;
  }
}
