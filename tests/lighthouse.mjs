// Lighthouse (brief §34) against a production build of the public site.
//   node tests/lighthouse.mjs [baseUrl]        (default http://127.0.0.1:4173)
//
// What it does, end to end:
//   1. builds the frontend into <repo>/.lighthouse-dist (never the shared
//      frontend/dist, which the main session builds and :5173 serves);
//   2. serves that folder with `vite preview` on :4173 (127.0.0.1) — the preview
//      inherits the dev server's proxy, so /api reaches PHP on :8000. That is
//      asserted, not assumed: /api/settings must come back as JSON through it;
//   3. runs Lighthouse (Performance, Accessibility, Best Practices, SEO) for
//      the routes below at the mobile and the desktop presets, with the Chrome
//      that Playwright installed (CHROME_PATH), and prints the four scores and
//      the top opportunities / failed diagnostics for every run;
//   4. saves every report as JSON under tests/reports/lighthouse/ (git-ignored:
//      1–3 MB each), plus scores.json and summary.md, which are kept — the next
//      run shows the difference against the previous scores.
//
// Gates (the "N passed, M failed" line): the preview's /api proxy, every run
// completing with all four categories scored, Accessibility ≥ LH_MIN_A11Y (90),
// SEO ≥ LH_MIN_SEO (90), Best Practices ≥ LH_MIN_BP (80). Performance is
// reported, and gated only when LH_MIN_PERF is set: on this machine's network
// its number moves ±10 between two identical runs, so a fixed floor would fail
// on noise rather than on a change to the site.
//
// Env: LH_ROUTES (comma list), LH_PRESETS (mobile,desktop), LH_BUILD=0 to reuse
// the existing .lighthouse-dist, LH_PORT (4173), CHROME_PATH (a Chrome to use
// instead of Playwright's), LH_API (the PHP origin the proxy should reach —
// only for the message when the proxy check fails).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FRONTEND = resolve(REPO, "frontend");
const DIST = resolve(REPO, ".lighthouse-dist");
const REPORTS = resolve(REPO, "tests/reports/lighthouse");
const PORT = Number(process.env.LH_PORT || 4173);
const base = (process.argv[2] || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");

const ROUTES = (process.env.LH_ROUTES || "/,/sevas,/events,/donations,/live-darshan,/gallery").split(",").map((s) => s.trim()).filter(Boolean);
const PRESETS = (process.env.LH_PRESETS || "mobile,desktop").split(",").map((s) => s.trim()).filter(Boolean);
const MIN = {
  accessibility: Number(process.env.LH_MIN_A11Y ?? 90),
  seo: Number(process.env.LH_MIN_SEO ?? 90),
  "best-practices": Number(process.env.LH_MIN_BP ?? 80),
  performance: process.env.LH_MIN_PERF === undefined ? null : Number(process.env.LH_MIN_PERF),
};

// lighthouse, chrome-launcher and playwright are devDependencies of frontend/;
// this file lives in tests/, so they are resolved from there explicitly.
const req = createRequire(pathToFileURL(resolve(FRONTEND, "package.json")).href);
const fileImport = (spec) => import(pathToFileURL(req.resolve(spec)).href);
const { default: lighthouse } = await fileImport("lighthouse");
const { default: desktopConfig } = await fileImport("lighthouse/core/config/desktop-config.js");
const chromeLauncher = await fileImport("chrome-launcher");
const { chromium } = req("playwright");
// vite/bin is not in the package's exports map, so it is a plain path.
const viteBin = resolve(FRONTEND, "node_modules/vite/bin/vite.js");

const results = [];
const pass = (name, detail = "") => results.push({ ok: true, name, detail });
const fail = (name, detail = "") => results.push({ ok: false, name, detail });
const check = (cond, name, detail = "") => (cond ? pass(name, detail) : fail(name, detail));

const slug = (route) => (route === "/" ? "home" : route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-"));
const pct = (cat) => (cat && typeof cat.score === "number" ? Math.round(cat.score * 100) : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiThroughPreview() {
  try {
    const res = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(20000) });
    const type = res.headers.get("content-type") || "";
    if (res.status !== 200 || !/json/.test(type)) return { ok: false, why: `HTTP ${res.status} ${type}` };
    const body = await res.json();
    return { ok: body && typeof body === "object" && "site" in body, why: Object.keys(body || {}).slice(0, 5).join(",") };
  } catch (e) {
    return { ok: false, why: String(e.message || e).split("\n")[0] };
  }
}

/* ── 1. Build ─────────────────────────────────────────────────────────────── */
if (process.env.LH_BUILD !== "0" || !existsSync(resolve(DIST, "index.html"))) {
  console.log(`▶ vite build → ${DIST}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [viteBin, "build", "--outDir", DIST, "--emptyOutDir"], { cwd: FRONTEND, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  const built = r.status === 0 && existsSync(resolve(DIST, "index.html"));
  check(built, `production build written to .lighthouse-dist`, built ? `${Math.round((Date.now() - t0) / 1000)} s` : (r.stderr || r.stdout || "").slice(-400));
  if (!built) { report(); process.exit(1); }
} else {
  pass("production build reused from .lighthouse-dist (LH_BUILD=0)");
}

/* ── 2. Serve ─────────────────────────────────────────────────────────────── */
let preview = null;
let chrome = null;
try {
  let probe = await apiThroughPreview();
  if (probe.ok) {
    pass(`a preview already answers on ${base} — reusing it`, "it proxies /api/settings as JSON");
  } else {
    preview = spawn(process.execPath, [viteBin, "preview", "--outDir", DIST, "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { cwd: FRONTEND, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    preview.stdout.on("data", (d) => (log += d));
    preview.stderr.on("data", (d) => (log += d));
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && preview.exitCode === null) {
      probe = await apiThroughPreview();
      if (probe.ok) break;
      await sleep(500);
    }
    check(probe.ok, `vite preview on :${PORT} serves .lighthouse-dist and proxies /api to ${process.env.LH_API || "http://localhost:8000"}`, probe.ok ? `/api/settings is JSON with keys ${probe.why}` : `${probe.why} — ${log.slice(-300)}`);
    if (!probe.ok) throw new Error("preview did not come up");
  }
  const html = await (await fetch(base + "/")).text();
  check(/<div id="root">/.test(html) && /\/assets\/index-[\w-]+\.js/.test(html), "the preview serves the built index.html (hashed assets, not the dev entry)");

  /* ── 3. Lighthouse ──────────────────────────────────────────────────────── */
  process.env.CHROME_PATH ||= chromium.executablePath();
  chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME_PATH,
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--disable-dev-shm-usage"],
  });
  console.log(`▶ Chrome ${process.env.CHROME_PATH} on port ${chrome.port}`);
  console.log(`▶ routes ${ROUTES.join(" ")} · presets ${PRESETS.join(", ")} · base ${base}`);
  mkdirSync(REPORTS, { recursive: true });

  const previous = existsSync(resolve(REPORTS, "scores.json")) ? JSON.parse(readFileSync(resolve(REPORTS, "scores.json"), "utf8")) : null;
  const runs = [];
  for (const route of ROUTES) {
    for (const preset of PRESETS) {
      const url = base + route;
      const label = `${route} [${preset}]`;
      const t0 = Date.now();
      let lhr;
      try {
        const flags = { port: chrome.port, output: "json", logLevel: "error", onlyCategories: ["performance", "accessibility", "best-practices", "seo"] };
        const out = await lighthouse(url, flags, preset === "desktop" ? desktopConfig : undefined);
        lhr = out?.lhr;
      } catch (e) {
        fail(`${label}: Lighthouse completed`, String(e.message || e).split("\n")[0].slice(0, 200));
        continue;
      }
      const scores = {
        performance: pct(lhr.categories.performance),
        accessibility: pct(lhr.categories.accessibility),
        "best-practices": pct(lhr.categories["best-practices"]),
        seo: pct(lhr.categories.seo),
      };
      const complete = Object.values(scores).every((v) => v !== null) && !lhr.runtimeError;
      check(complete, `${label}: Lighthouse completed with all four categories scored`, complete ? `${Math.round((Date.now() - t0) / 1000)} s` : lhr.runtimeError?.message || JSON.stringify(scores));
      const file = resolve(REPORTS, `${slug(route)}-${preset}.json`);
      writeFileSync(file, JSON.stringify(lhr));

      // Opportunities (estimated savings) and failed diagnostics, most costly first.
      const audits = Object.values(lhr.audits);
      const opportunities = audits
        .filter((a) => a.details?.type === "opportunity" && typeof a.score === "number" && a.score < 1)
        .map((a) => ({ id: a.id, title: a.title, ms: Math.round(a.details.overallSavingsMs || 0), kb: Math.round((a.details.overallSavingsBytes || 0) / 1024), score: a.score }))
        .sort((x, y) => y.ms - x.ms || y.kb - x.kb);
      const failed = audits
        .filter((a) => typeof a.score === "number" && a.score < 0.5 && a.scoreDisplayMode !== "informative" && a.details?.type !== "opportunity")
        .map((a) => ({ id: a.id, title: a.title, display: a.displayValue || "" }));
      const metrics = {
        fcp: lhr.audits["first-contentful-paint"]?.displayValue,
        lcp: lhr.audits["largest-contentful-paint"]?.displayValue,
        tbt: lhr.audits["total-blocking-time"]?.displayValue,
        cls: lhr.audits["cumulative-layout-shift"]?.displayValue,
        si: lhr.audits["speed-index"]?.displayValue,
      };
      runs.push({ route, preset, scores, metrics, opportunities, failed, file });

      const prev = previous?.runs?.find((r) => r.route === route && r.preset === preset)?.scores;
      const delta = (k) => (prev && prev[k] !== null && scores[k] !== null ? ` (${scores[k] - prev[k] >= 0 ? "+" : ""}${scores[k] - prev[k]})` : "");
      console.log(`\n${label}  Performance ${scores.performance}${delta("performance")} · Accessibility ${scores.accessibility}${delta("accessibility")} · Best Practices ${scores["best-practices"]}${delta("best-practices")} · SEO ${scores.seo}${delta("seo")}`);
      console.log(`   FCP ${metrics.fcp} · LCP ${metrics.lcp} · TBT ${metrics.tbt} · CLS ${metrics.cls} · SI ${metrics.si}`);
      for (const o of opportunities.slice(0, 5)) console.log(`   ↓ ${o.id}: ${o.title} — ${o.ms} ms${o.kb ? `, ${o.kb} KB` : ""}`);
      for (const f of failed.slice(0, 6)) console.log(`   ✗ ${f.id}: ${f.title}${f.display ? ` — ${f.display}` : ""}`);

      for (const [k, min] of Object.entries(MIN)) {
        if (min === null) continue;
        const name = { performance: "Performance", accessibility: "Accessibility", "best-practices": "Best Practices", seo: "SEO" }[k];
        check(scores[k] !== null && scores[k] >= min, `${label}: ${name} ≥ ${min}`, `${scores[k]}${k === "accessibility" ? " — " + audits.filter((a) => a.score === 0 && lhr.categories.accessibility.auditRefs.some((r) => r.id === a.id)).map((a) => a.id).join(", ") : ""}`);
      }
    }
  }

  /* ── 4. summary.md + scores.json ───────────────────────────────────────── */
  const stamp = new Date().toISOString();
  const findings = new Map();
  for (const r of runs) {
    for (const o of r.opportunities) findings.set(o.id, { ...(findings.get(o.id) || { id: o.id, title: o.title, runs: 0, ms: 0, kb: 0 }), runs: (findings.get(o.id)?.runs || 0) + 1, ms: (findings.get(o.id)?.ms || 0) + o.ms, kb: (findings.get(o.id)?.kb || 0) + o.kb });
    for (const f of r.failed) findings.set(f.id, { ...(findings.get(f.id) || { id: f.id, title: f.title, runs: 0, ms: 0, kb: 0 }), runs: (findings.get(f.id)?.runs || 0) + 1 });
  }
  const lines = [];
  lines.push(`# Lighthouse summary`, ``, `Generated by \`node tests/lighthouse.mjs\` on ${stamp} — Lighthouse ${runs.length ? JSON.parse(readFileSync(runs[0].file, "utf8")).lighthouseVersion : "?"}, Chrome ${process.env.CHROME_PATH}, base ${base}.`, ``);
  lines.push(`The JSON reports beside this file are git-ignored (1–3 MB each); \`scores.json\` and this summary are kept, and the next run prints its scores against them.`, ``);
  lines.push(`| Route | Preset | Performance | Accessibility | Best Practices | SEO | FCP | LCP | TBT | CLS |`, `| --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |`);
  for (const r of runs) {
    const prev = previous?.runs?.find((p) => p.route === r.route && p.preset === r.preset)?.scores;
    const cell = (k) => (prev && prev[k] !== null ? `${r.scores[k]} (${r.scores[k] - prev[k] >= 0 ? "+" : ""}${r.scores[k] - prev[k]})` : String(r.scores[k]));
    lines.push(`| \`${r.route}\` | ${r.preset} | ${cell("performance")} | ${cell("accessibility")} | ${cell("best-practices")} | ${cell("seo")} | ${r.metrics.fcp ?? ""} | ${r.metrics.lcp ?? ""} | ${r.metrics.tbt ?? ""} | ${r.metrics.cls ?? ""} |`);
  }
  if (previous?.generated) lines.push(``, `Deltas in brackets are against the previous run (${previous.generated}).`);
  lines.push(``, `## Findings across all runs`, ``, `| Audit | Runs | Est. savings (sum) | Title |`, `| --- | ---: | --- | --- |`);
  for (const f of [...findings.values()].sort((a, b) => b.runs - a.runs || b.ms - a.ms)) lines.push(`| \`${f.id}\` | ${f.runs} | ${f.ms ? `${f.ms} ms` : ""}${f.kb ? ` / ${f.kb} KB` : ""} | ${f.title.replace(/\|/g, "\\|")} |`);
  lines.push(``, `## Per run`, ``);
  for (const r of runs) {
    lines.push(`### \`${r.route}\` — ${r.preset}`, ``);
    for (const o of r.opportunities.slice(0, 6)) lines.push(`- opportunity \`${o.id}\`: ${o.title} — ${o.ms} ms${o.kb ? `, ${o.kb} KB` : ""}`);
    for (const f of r.failed.slice(0, 8)) lines.push(`- failed \`${f.id}\`: ${f.title}${f.display ? ` — ${f.display}` : ""}`);
    if (!r.opportunities.length && !r.failed.length) lines.push(`- nothing flagged`);
    lines.push(``);
  }
  writeFileSync(resolve(REPORTS, "summary.md"), lines.join("\n") + "\n");
  writeFileSync(resolve(REPORTS, "scores.json"), JSON.stringify({ generated: stamp, base, routes: ROUTES, presets: PRESETS, runs: runs.map((r) => ({ route: r.route, preset: r.preset, scores: r.scores, metrics: r.metrics })) }, null, 2) + "\n");
  pass(`reports written to tests/reports/lighthouse/ (${runs.length} JSON, scores.json, summary.md)`);
} catch (e) {
  fail("lighthouse (suite threw)", String(e.stack || e).split("\n").slice(0, 3).join(" | ").slice(0, 300));
} finally {
  if (chrome) await chrome.kill().catch(() => {});
  if (preview) {
    preview.kill();
    await sleep(300);
  }
}

report();
function report() {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
}
