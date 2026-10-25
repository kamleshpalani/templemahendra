import express from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { assertSchemaReady } from "./migrations.mjs";

const pagePaths = new Set([
  "/", "/about", "/sevas", "/events", "/gallery", "/videos", "/donations",
  "/contact", "/panchangam", "/search", "/register", "/privacy-policy",
  "/terms-and-conditions", "/refund-cancellation-policy", "/shipping-delivery-policy",
  "/donate", "/payment/result", "/payment/receipt", "/payment/verify",
  "/live-darshan", "/live-darshan/schedule", "/live-darshan/archive",
  "/login", "/account", "/notifications", "/forgot-password", "/reset-password", "/verify-email",
]);
const pending = {
  error: "This backend feature has not been migrated. Use the existing PHP application.",
  code: "MIGRATION_PENDING",
};

function invalidParameter(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function limitParam(query, defaultValue, maximum) {
  if (query.limit === undefined) return defaultValue;
  if (typeof query.limit !== "string" || !/^\d+$/.test(query.limit)) {
    throw invalidParameter("limit must be a non-negative integer.");
  }
  return Math.min(Number(query.limit), maximum);
}

function boolParam(query, key) {
  const value = query[key];
  if (value === undefined) return false;
  if (typeof value !== "string") throw invalidParameter(`${key} must have one string value.`);
  return value !== "0" && value !== "false";
}

function withNumericIds(rows) {
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export function createApp({ db, migrations, frontendDir, logger = console }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
      "X-Migration-Stage": "staging-foundation",
    });
    next();
  });
  app.get("/api/health/live", (req, res) => {
    res.json({ status: "ok", stage: "staging-foundation", productionReady: false });
  });
  app.get("/api/health/ready", async (req, res, next) => {
    try {
      await assertSchemaReady(db, migrations);
      res.json({ status: "ok", stage: "staging-foundation", productionReady: false });
    } catch (error) {
      error.status = 503;
      next(error);
    }
  });

  const routes = {
    "/announcements": async (query) => {
      const { rows } = await db.query(
        `SELECT id, title, body, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
         FROM temple_node_staging.announcements WHERE is_active = 1 ORDER BY created_at DESC LIMIT $1`,
        [limitParam(query, 10, 50)],
      );
      return withNumericIds(rows);
    },
    "/sevas": async (query) => {
      const { rows } = await db.query(
        `SELECT id, name_ta, name_en, description, amount::text AS amount, is_featured
         FROM temple_node_staging.sevas WHERE is_active = 1
         ${boolParam(query, "featured") ? "AND is_featured = 1" : ""}
         ORDER BY sort_order ASC LIMIT $1`,
        [limitParam(query, 50, 100)],
      );
      return withNumericIds(rows);
    },
    "/events": async (query) => {
      const { rows } = await db.query(
        `SELECT id, title_ta, title_en, description, to_char(event_date, 'YYYY-MM-DD') AS event_date
         FROM temple_node_staging.events WHERE is_active = 1
         ${boolParam(query, "upcoming") ? "AND event_date >= CURRENT_DATE" : ""}
         ORDER BY event_date ASC LIMIT $1`,
        [limitParam(query, 20, 100)],
      );
      return withNumericIds(rows);
    },
    "/gallery": async () => {
      const { rows } = await db.query(
        `SELECT id, filename, caption, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
         FROM temple_node_staging.gallery WHERE is_active = 1 ORDER BY created_at DESC`,
      );
      return withNumericIds(rows);
    },
    "/settings": async () => {
      const { rows } = await db.query("SELECT key_name, val FROM temple_node_staging.homepage_settings");
      return Object.fromEntries(rows.map(({ key_name, val }) => [key_name, Boolean(Number.parseInt(val, 10))]));
    },
  };
  for (const [path, handler] of Object.entries(routes)) {
    app.all(`/api${path}`, async (req, res) => {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.set("Allow", "GET, HEAD");
        return res.status(405).json({ error: "Method not allowed" });
      }
      res.json(await handler(req.query));
    });
  }
  app.use(["/api", "/admin", "/uploads"], (req, res) => res.status(501).json(pending));
  app.get("/robots.txt", (req, res) => res.type("text").send("User-agent: *\nDisallow: /\n"));
  app.all("/sitemap.xml", (req, res) => res.status(501).json(pending));
  if (frontendDir) {
    app.use(express.static(frontendDir, { index: false, dotfiles: "deny", redirect: false }));
    app.use(async (req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method)) return next();
      const path = req.path.replace(/\/+$/, "") || "/";
      const known = pagePaths.has(path) || /^\/live-darshan\/[a-z0-9][a-z0-9-]{1,118}$/.test(path);
      res.status(known ? 200 : 404).sendFile(resolve(frontendDir, "index.html"));
    });
  }
  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.status === 400) return res.status(400).json({ error: error.message });
    const reference = randomUUID();
    logger.error("Node staging request failed.", { reference, code: error.code ?? error.name });
    res.status(error.status === 503 ? 503 : 500).json({
      error: error.status === 503 ? "Staging database is not ready." : "The server could not complete that request.",
      reference,
    });
  });
  return app;
}
