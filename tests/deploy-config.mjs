#!/usr/bin/env node
/**
 * tests/deploy-config.mjs — the production configuration that no local server
 * exercises (brief §27, §39): the three Apache files in deploy/, the logs
 * folder's guard, and how PHP behaves under APP_ENV.
 *
 *   deploy/htaccess_public_html  HTTPS redirect (not on localhost, not when a
 *                                proxy already terminated TLS), HSTS only over
 *                                TLS, nosniff / frame / referrer / permissions
 *                                headers, a strict CSP for the SPA (no inline
 *                                script) and a relaxed one only for /admin and
 *                                og.php, the SPA fallback that never swallows
 *                                /api /admin /uploads, the private folders and
 *                                file types denied, hashed assets cached a year
 *   deploy/htaccess_api          the HTTPS rules run before any routing rule
 *                                can end the pass; a 308 keeps a POST a POST;
 *                                the /api/v1 alias; no directory listing
 *   deploy/htaccess_uploads      PHP never executes, scripts denied, HTTPS
 *   backend/logs/.htaccess       denies everything; .gitignore keeps logs out
 *   frontend/dist/index.html     (when built) carries no inline script, so the
 *                                strict CSP does not break the app
 *   APP_ENV                      production is the default and hides errors,
 *                                development shows them, an unknown value is
 *                                production; APP_DEBUG cannot switch detail on
 *                                outside development
 *
 *   node tests/deploy-config.mjs
 *
 * Needs php (PHP_BIN). Reads files only; starts no server, touches no database.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const php = process.env.PHP_BIN || "php";
let passed = 0;
let failed = 0;
const check = (ok, label, detail = "") => {
  if (ok) { passed++; console.log(`✓ ${label}`); } else { failed++; console.log(`✗ ${label}${detail ? `\n    ${detail}` : ""}`); }
};
const read = (p) => readFileSync(resolve(root, p), "utf8").replace(/\r\n/g, "\n");
/** The file without comment lines, so a rule mentioned in prose never counts. */
const rules = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/* ── public_html/.htaccess ─────────────────────────────────────────────── */
const pub = rules(read("deploy/htaccess_public_html"));
const httpsBlock = /RewriteCond %\{HTTPS\} !=on\s*\n\s*RewriteCond %\{HTTP:X-Forwarded-Proto\} !=https\s*\n\s*RewriteCond %\{HTTP_HOST\} !\^\$\s*\n\s*RewriteCond %\{HTTP_HOST\} !\^\(localhost\|127\\\.0\\\.0\\\.1\)\(:\[0-9\]\+\)\?\$ \[NC\]\s*\n\s*RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\} \[R=(301|308),L\]/;
check(httpsBlock.test(pub), "root: http → https redirect, skipped on localhost/127.0.0.1 and behind a TLS-terminating proxy");
check(/RewriteRule \^ - \[E=TM_HTTPS:1\]/.test(pub), "root: secure requests are marked TM_HTTPS");
check(/Strict-Transport-Security "max-age=31536000; includeSubDomains" env=TM_HTTPS/.test(pub) && /env=REDIRECT_TM_HTTPS/.test(pub), "root: HSTS for a year, only on a response that went over TLS (also after an internal rewrite)");
check(!/Strict-Transport-Security[^\n]*preload/.test(pub), "root: HSTS has no preload (it cannot be undone quickly)");
for (const [name, value] of [["X-Content-Type-Options", /"nosniff"/], ["X-Frame-Options", /"(SAMEORIGIN|DENY)"/], ["Referrer-Policy", /"(strict-origin-when-cross-origin|no-referrer|same-origin)"/], ["Permissions-Policy", /camera=\(\)/]]) {
  const line = pub.split("\n").find((l) => l.includes(`set ${name}`)) ?? "";
  check(value.test(line), `root: ${name} header`, line.trim());
}
check(/Header (always )?unset X-Powered-By/.test(pub), "root: the X-Powered-By banner is removed");
const csp = pub.split("\n").filter((l) => /set Content-Security-Policy/.test(l));
check(csp.length === 2, "root: two Content-Security-Policy lines (strict and relaxed)", `${csp.length}`);
const strict = csp.find((l) => /env=!TM_CSP_RELAXED/.test(l)) ?? csp.find((l) => /test\.ccavenue\.com/.test(l)) ?? "";
const relaxed = csp.find((l) => l !== strict) ?? "";
const scriptSrc = (l) => /script-src ([^;"]+)/.exec(l)?.[1] ?? "";
check(strict && !/'unsafe-inline'|'unsafe-eval'/.test(scriptSrc(strict)), "root: the strict policy allows no inline or eval script", scriptSrc(strict));
check(/form-action[^;]*https:\/\/secure\.ccavenue\.com[^;]*https:\/\/test\.ccavenue\.com/.test(strict), "root: the strict policy lets the donation form post to CCAvenue (live and test)");
check(/frame-src[^;]*youtube(-nocookie)?\.com/.test(strict) && /frame-src[^;]*google\.com/.test(strict), "root: YouTube and Google Maps may be framed");
check(/object-src 'none'/.test(strict) && /base-uri 'self'/.test(strict) && /frame-ancestors 'self'/.test(strict), "root: object-src none, base-uri self, frame-ancestors self");
check(/SetEnvIf Request_URI "\^\/\(admin\(\/\|\$\)\|api\/og\\\.php\$\)" TM_CSP_RELAXED=1/.test(pub), "root: only /admin and api/og.php get the relaxed policy");
check(/'unsafe-inline'/.test(scriptSrc(relaxed)) && !/ccavenue/.test(relaxed), "root: the relaxed policy allows inline script but no CCAvenue form target", relaxed.slice(0, 160));
check(/RewriteRule \^\(includes\|config\|bin\|logs\|database\|tests\|vendor\|node_modules\)\(\/\|\$\) - \[F,L\]/.test(pub), "root: includes/ config/ bin/ logs/ database/ tests/ vendor/ node_modules/ are forbidden");
check(/<FilesMatch "\(\^\\\.\|\\\.\(sql\|log\|sh\|bak\|ini\|lock\|env\|md\)\$\|\^router\\\.php\$\)">\s*\n\s*<IfModule mod_authz_core\.c>\s*\n\s*Require all denied/.test(pub), "root: dotfiles, dumps, logs, scripts, backups, env and the dev router are never served");
check(/RewriteRule \^\(api\|admin\|uploads\)\(\/\.\*\)\?\$ - \[L\]/.test(pub), "root: /api, /admin and /uploads pass straight through (never the SPA fallback)");
check(/RewriteRule \^\(\.\*\)\$ api\/spa\.php\?path=\/\$1 \[QSA,L\]/.test(pub), "root: unknown addresses go to spa.php (honest 404s)");
check(pub.indexOf("E=TM_HTTPS") < pub.indexOf("api/spa.php"), "root: the HTTPS rules come before the SPA fallback");
check(/"-\[A-Za-z0-9_-\]\{8\}\\\.\(js\|css[^"]*"[\s\S]{0,120}max-age=31536000, immutable/.test(pub), "root: content-hashed assets are cached for a year");
check(/\^\(index\\\.html\|sw\\\.js\|registerSW\\\.js\|manifest\\\.webmanifest\)\$[\s\S]{0,200}no-cache/.test(pub), "root: index.html, sw.js, registerSW.js and the manifest are always revalidated");

/* ── api/.htaccess ─────────────────────────────────────────────────────── */
const api = rules(read("deploy/htaccess_api"));
check(/Options -Indexes/.test(api), "api: no directory listing");
const apiRedirect = api.search(/RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\} \[R=308,L\]/);
check(apiRedirect > -1, "api: an HTTPS redirect with 308 (a POST stays a POST)");
check(apiRedirect > -1 && apiRedirect < api.indexOf("index.php"), "api: the HTTPS rules run before any routing rule can end the pass");
check(/RewriteRule \^ - \[E=TM_HTTPS:1\]/.test(api), "api: secure requests are marked TM_HTTPS for HSTS");
check(/RewriteRule \^v1\(\/\.\*\)\?\$ index\.php \[QSA,L\]/.test(api), "api: /api/v1 goes to the front controller");

/* ── uploads/.htaccess ─────────────────────────────────────────────────── */
const up = rules(read("deploy/htaccess_uploads"));
check(/php_flag engine off/.test(up) && /RemoveHandler \.php/.test(up), "uploads: PHP never executes");
check(/<FilesMatch "\\\.\(php\|phar\|phtml[^"]*"[\s\S]{0,120}Require all denied/.test(up), "uploads: script files are denied outright");
check(/Options -Indexes -ExecCGI/.test(up), "uploads: no listing, no CGI");
check(/Content-Security-Policy "default-src 'none'; sandbox"/.test(up) && /nosniff/.test(up), "uploads: served files are sandboxed and never sniffed");
check(/R=301,L\]/.test(up) && /E=TM_HTTPS:1/.test(up), "uploads: HTTPS redirect and TM_HTTPS mark repeated");

/* ── logs ──────────────────────────────────────────────────────────────── */
const logs = rules(read("backend/logs/.htaccess"));
check(/Require all denied/.test(logs) && /Deny from all/.test(logs), "backend/logs/.htaccess denies everything (Apache 2.2 and 2.4)");
const ignore = read(".gitignore");
check(/^backend\/logs\/\*$/m.test(ignore) && /^!backend\/logs\/\.htaccess$/m.test(ignore), ".gitignore keeps every log out of the repository but the guard file");
const tracked = spawnSync("git", ["ls-files", "backend/logs", "backend/.env", ".env", ".env.local"], { cwd: root, encoding: "utf8" });
check(tracked.status !== 0 || tracked.stdout.trim().split("\n").filter(Boolean).every((f) => f === "backend/logs/.htaccess"), "no log, .env or .env.local file is tracked by git", tracked.stdout.trim());

/* ── the built SPA works under the strict CSP ─────────────────────────── */
const dist = resolve(root, "frontend/dist/index.html");
if (existsSync(dist)) {
  const html = readFileSync(dist, "utf8");
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter((m) => m[1].trim() !== "" && !/type="application\/ld\+json"/.test(m[0]));
  check(inline.length === 0, "frontend/dist/index.html has no inline script (the strict CSP holds)", inline.map((m) => m[0].slice(0, 80)).join(" | "));
  check(!/\son[a-z]+="/i.test(html), "frontend/dist/index.html has no inline event handler");
} else {
  console.log("- frontend/dist is not built: the inline-script check was skipped (npm run build)");
}

/* ── APP_ENV ───────────────────────────────────────────────────────────── */
function phpIni(env, code) {
  const r = spawnSync(php, ["-d", "display_errors=1", "-r", code], { cwd: root, encoding: "utf8", env: { ...process.env, APP_ENV: "", APP_DEBUG: "", ...env } });
  return (r.stdout || "").trim() + (r.status !== 0 ? ` [exit ${r.status}] ${(r.stderr || "").trim()}` : "");
}
const cfg = `require 'backend/config/config.php'; echo APP_ENV, '|', ini_get('display_errors'), '|', ini_get('log_errors');`;
check(phpIni({}, cfg) === "production|0|1", "APP_ENV unset → production, errors hidden and logged", phpIni({}, cfg));
check(phpIni({ APP_ENV: "staging" }, cfg) === "staging|0|1", "APP_ENV=staging hides errors", phpIni({ APP_ENV: "staging" }, cfg));
check(phpIni({ APP_ENV: "development" }, cfg) === "development|1|1", "APP_ENV=development leaves them visible", phpIni({ APP_ENV: "development" }, cfg));
check(phpIni({ APP_ENV: "Debug-Everything" }, cfg) === "production|0|1", "an unknown APP_ENV is treated as production", phpIni({ APP_ENV: "Debug-Everything" }, cfg));
const dbg = `require 'backend/config/config.php'; require 'backend/includes/errors.php'; echo appDebug() ? 'debug' : 'quiet', '|', ini_get('display_errors');`;
check(phpIni({ APP_DEBUG: "1" }, dbg) === "quiet|0", "APP_DEBUG=1 cannot show error detail in production", phpIni({ APP_DEBUG: "1" }, dbg));
check(phpIni({ APP_ENV: "development", APP_DEBUG: "1" }, dbg) === "debug|1", "APP_DEBUG=1 shows detail in development", phpIni({ APP_ENV: "development", APP_DEBUG: "1" }, dbg));
const env = read("backend/.env.example");
check(/^APP_ENV=production$/m.test(env), "backend/.env.example documents APP_ENV=production");

console.log(`\ndeploy-config: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
