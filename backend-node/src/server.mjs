import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { assertSchemaReady, MigrationError, readMigrations } from "./migrations.mjs";

let pool;
try {
  const config = loadConfig();
  const migrations = await readMigrations();
  const frontendDir = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
  await access(new URL("../../frontend/dist/index.html", import.meta.url));
  pool = new pg.Pool(config.pool);
  pool.on("error", (error) => console.error("Idle database connection failed.", { code: error.code ?? error.name }));
  await assertSchemaReady(pool, migrations);
  const app = createApp({ db: pool, migrations, frontendDir });
  const server = app.listen(config.port, config.host, () => {
    console.log(`Node staging foundation listening on port ${config.port}; not ready for production.`);
  });
  server.on("error", async (error) => {
    console.error("Node staging listener failed.", { code: error.code });
    await pool.end();
    process.exitCode = 1;
  });
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const timer = setTimeout(() => {
        console.error("Node staging shutdown timed out.");
        process.exit(1);
      }, 10000).unref();
      server.close(async () => {
        await pool.end();
        clearTimeout(timer);
      });
    });
  }
} catch (error) {
  console.error("Node staging startup failed.", { code: error.code ?? error.name });
  if (!pool || error instanceof MigrationError) console.error(error.message);
  await pool?.end();
  process.exitCode = 1;
}
