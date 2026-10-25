import { readFileSync } from "node:fs";

function integer(value, fallback, name, min, max) {
  const text = value ?? String(fallback);
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(text);
}

export function loadConfig(env = process.env) {
  if (env.NODE_BACKEND_STAGE !== "staging") {
    throw new Error("NODE_BACKEND_STAGE must be staging; this backend is not ready for production.");
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !databaseUrl.hostname ||
    !databaseUrl.username ||
    !databaseUrl.password ||
    databaseUrl.pathname.length < 2
  ) {
    throw new Error("DATABASE_URL must include a PostgreSQL host, user, password, and database.");
  }

  // pg connection-string SSL options can override the verified TLS object.
  if (databaseUrl.search) {
    throw new Error("Use a DATABASE_URL without query parameters; configure TLS with DATABASE_TLS and DATABASE_CA_FILE.");
  }
  const tls = env.DATABASE_TLS ?? "verify-full";
  if (!["verify-full", "disable"].includes(tls)) {
    throw new Error("DATABASE_TLS must be verify-full or disable.");
  }
  if (tls === "disable" && !["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
    throw new Error("Unencrypted database connections are only allowed on loopback hosts.");
  }

  return {
    host: env.HOST || "0.0.0.0",
    port: integer(env.PORT, 3000, "PORT", 1, 65535),
    databaseHost: databaseUrl.hostname,
    migrationConfirmHost: env.MIGRATION_CONFIRM_HOST,
    pool: {
      connectionString: databaseUrl.href,
      ssl: tls === "disable" ? false : {
        rejectUnauthorized: true,
        ...(env.DATABASE_CA_FILE ? { ca: readFileSync(env.DATABASE_CA_FILE, "utf8") } : {}),
      },
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      options: "-c timezone=Asia/Kolkata",
    },
  };
}
