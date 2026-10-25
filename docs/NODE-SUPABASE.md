# Node.js + Supabase staging foundation

**Not a production replacement.** The live application remains PHP + MySQL.
The Node backend is an isolated first migration slice, not a completed port.
Do not switch the live domain, payment callbacks, database, or workers to it.
No production data has been imported or changed by this work.

## Implemented scope

- Root Node package with `build`, `start`, `test`, and `db:migrate` scripts.
- Express server serving the existing React build and five read-only APIs:
  `GET /api/announcements`, `/api/sevas`, `/api/events`, `/api/gallery`, and
  `/api/settings`. GET routes also accept HEAD.
- PostgreSQL schema `temple_node_staging` with those five content tables,
  indexes, identity columns, and the three original homepage visibility defaults.
  It does **not** contain the other MySQL tables or production content.
- Migrations run explicitly, in a transaction, with an exclusive metadata-table
  lock and recorded SHA-256 checksums. Already-applied migrations are skipped;
  edited or unknown applied migrations are refused. Server startup never
  creates tables or imports data.
- Parameterized queries, active/featured/upcoming filters, numeric IDs/flags,
  decimal strings, date-only event dates, and formatted legacy timestamps.
  Invalid or negative limits now receive HTTP 400 instead of relying on PHP's
  loose integer conversion; valid limits retain the existing defaults/caps.
- `/api/health/live` tests the process; `/api/health/ready` checks the migration
  ledger against this release. Both explicitly return `productionReady: false`.
- Unported `/api`, `/admin`, `/uploads`, and sitemap requests return HTTP 501
  with `MIGRATION_PENDING`, not fake success or the React shell.
- All responses carry staging/noindex headers; robots.txt disallows crawling.
  This is not access control: protect the staging hostname in the hosting panel,
  and do not put private production records in this first-slice database.

Homepage widgets, registration, contact submission, search, payments, admin
authentication/roles/pages, notifications/providers, live streaming, uploads,
SEO rendering, and cron jobs are **not ported yet**. The React preview therefore
shows errors or unavailable states for those features. Do not interpret a
successful build or health check as full application readiness.

## Local validation without Supabase credentials

From the repository root, using Node.js **22.12 or newer** (24.x is also supported):

```powershell
npm ci
npm test
npm run build
```

Tests run SQL against an ephemeral PostgreSQL engine (PGlite) and exercise real
HTTP requests. They cover migrations/checksums/rollback, table access, Tamil,
legacy IDs, exact decimals, response shapes, limit thresholds, filtering,
unported endpoints, static routing, and error redaction. They require no
production database and do not read the existing PHP environment file.
This does not replace staging tests against hosted Supabase, its TLS
certificate, permissions, or pooler.

The frontend dependency override keeps `serialize-javascript` at 7.0.3 or
newer. Removing it without updating the frontend lockfile breaks `npm ci`;
regenerating without the override can reintroduce the vulnerable transitive
dependency.

## Create an isolated Supabase staging target

1. Create a **separate staging Supabase project**, not the production target.
2. Under **Connect**, copy a PostgreSQL connection string. Use a direct
   connection if the hosting network supports it, otherwise the session pooler.
   Do not substitute a Supabase HTTPS URL or an anon/service-role API key.
3. Use a database role able to create the staging schema/tables for the
   migration. The API's connection role must be able to read these tables;
   no browser database access is needed.
4. Copy [.env.node.example](../.env.node.example) to `.env.node.local` at the
   repository root for local work, or set the variables in Hostinger. The file
   is ignored by Git. The Node backend never loads the PHP `.env.local`.
5. Set `NODE_BACKEND_STAGE=staging`, `DATABASE_URL`, and
   `DATABASE_TLS=verify-full`. URL-encode the password. Remove connection URL
   query parameters: the backend deliberately controls its TLS configuration.
   If the certificate requires the project's downloaded CA, set
   `DATABASE_CA_FILE` to its path. Never turn off verification for Supabase.
   `DATABASE_TLS=disable` is allowed only for local loopback databases.
6. Set `MIGRATION_CONFIRM_HOST` to exactly the hostname in `DATABASE_URL`.
   This is an operator confirmation, not proof that a database is staging:
   verify the project/host yourself before running the command.
7. Run `npm run db:migrate` from a trusted environment with those variables.
   It only targets `temple_node_staging`; it does not create or alter MySQL
   tables, `public` tables, or Supabase `auth`/`storage` schemas.
8. Run `npm start`, then check both `/api/health/live` and
   `/api/health/ready`. Startup fails if the frontend is not built, the
   database is unreachable, or migrations are missing/mismatched.

RLS is enabled on all five content tables with no browser policies, schema
access is revoked from PUBLIC, and explicit grants to Supabase `anon` and
`authenticated` roles are revoked when those roles exist. Do not expose this
schema through Supabase's Data API or add frontend database credentials.
Use the Node API. An owner connection bypasses RLS; before production cutover,
separate migration ownership from least-privilege runtime access and test it.

## Hostinger Web Apps staging settings

| Setting | Value |
| --- | --- |
| Root directory | Repository root, not `frontend` |
| Node version | 22.12+ or 24.x |
| Install | `npm ci` (include development dependencies if running tests) |
| Build | `npm run build` |
| Start | `npm start` |
| Listen host | `0.0.0.0` |
| Port | Use the port provided/configured by Hostinger via `PORT` |
| Frontend API URL | `VITE_API_URL=/api`, or leave unset |
| Backend environment | `NODE_BACKEND_STAGE`, `DATABASE_URL`, `DATABASE_TLS`, optional CA path |

`npm run build` installs frontend build dependencies and builds React; it
does not migrate a database. Apply migrations explicitly before starting the
staging application. No PHP process is launched by this Node package.

Environment variables must be **server-side**; never create
`VITE_DATABASE_URL` or `VITE_SUPABASE_SERVICE_ROLE_KEY`. The existing
`VITE_API_URL` is just a public URL, not a database credential.

## Production-data migration gates (not implemented yet)

Before any real data transfer:

1. Back up MySQL consistently, uploaded files, and encryption keys/settings
   separately. Keep them out of Git and public web directories. Verify a
   restoration, not just the existence of a dump.
2. Inventory the **actual** production schema/version, MySQL collation and
   time zone, row counts, foreign keys, status values, nullable values, and
   binary/encrypted fields. The documented schema has 47 tables after MySQL
   migration 019; do not assume the deployed database matches it.
3. Port the remaining schema and all dependent code. MySQL enums, unsigned
   integers, case-insensitive uniqueness, auto-updated timestamps, JSON, upserts,
   date functions, and advisory locks need explicit PostgreSQL equivalents.
   These semantics are not established for the remaining tables.
4. Build a repeatable, validated importer for a restored copy. Preserve IDs,
   foreign keys, exact money, receipt counters, password hashes, and encrypted
   values plus their original encryption keys/algorithms. Reset identity
   sequences after explicit-ID imports. No importer is provided in this slice.
5. Compare per-table counts, canonical field checksums, relationship integrity,
   financial totals by currency/status, receipt numbers, and Tamil text.
   Verify upload references and timezone behavior.
6. Run full API, admin-role, notification, payment callback/retry/refund,
   concurrent receipt-allocation, and worker tests against staged data.
   Existing PHP/MySQL suites are not replaced by the Node foundation tests.
7. Rehearse a maintenance window: pause writes and workers, drain in-flight
   callbacks, export/import the final snapshot or validated delta, verify,
   change routing/callback URLs, and only then resume. Do not run old and new
   payment/notification workers on the same events.
8. Define a rollback before cutover. Keep the old deployment and verified
   backup; switching DNS back alone is insufficient after new writes occur.
   Reconcile post-cutover writes before returning to MySQL.

Until these gates pass, keep all registrations, payments, admin changes, and
notification processing on the existing PHP/MySQL production application.
