import pg from "pg";
import { loadConfig } from "../src/config.mjs";
import { applyMigrations, MigrationError, readMigrations } from "../src/migrations.mjs";

let pool;
let client;
try {
  const config = loadConfig();
  if (config.migrationConfirmHost !== config.databaseHost) {
    throw new Error("MIGRATION_CONFIRM_HOST must exactly match the staging DATABASE_URL host.");
  }
  pool = new pg.Pool(config.pool);
  client = await pool.connect();
  const applied = await applyMigrations(client, await readMigrations());
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Staging schema is up to date.");
} catch (error) {
  console.error("Staging migration failed.", { code: error.code ?? error.name });
  // Driver messages can contain database values. Only our configuration errors are safe to print.
  if (!pool || error instanceof MigrationError) console.error(error.message);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
