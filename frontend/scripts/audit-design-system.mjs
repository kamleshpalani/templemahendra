// Static design-system audit for the temple site.
//   npm run audit            (or: node scripts/audit-design-system.mjs)
//   npm run audit -- --colours
// Checks, across the React app and the PHP admin:
//   1. every var(--x) resolves to a definition
//   2. every literal className has a CSS rule somewhere (interpolated
//      fragments and PHP expressions are skipped, not guessed at)
//   3. opaque raw colours in page/component CSS outside data: URIs
//      (alpha tints are reported separately as informational)
//   4. inline style= attributes that are not dynamic custom properties
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const only = process.argv.find((a) => a.startsWith("--"))?.slice(2);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p) => relative(REPO, p).replace(/\\/g, "/");
const files = [...walk(join(REPO, "frontend/src")), ...walk(join(REPO, "backend/admin"))];
const css = files.filter((f) => f.endsWith(".css"));
const code = files.filter((f) => /\.(jsx?|php)$/.test(f));
const read = (f) => readFileSync(f, "utf8");
const stripData = (s) => s.replace(/url\((['"]?)data:[^)]*\1\)/g, "url(data)");
const out = { vars: [], orphans: [], colours: [], tints: [], inline: [] };

/* 1. CSS custom properties ------------------------------------------------ */
const defined = new Set();
for (const f of css) for (const m of read(f).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
for (const f of code) {
  for (const m of read(f).matchAll(/["'`](--[\w-]+)["'`]?\s*:/g)) defined.add(m[1]);
  for (const m of read(f).matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
}
const usedVars = new Map();
for (const f of css) {
  for (const m of read(f).matchAll(/var\(\s*(--[\w-]+)/g)) {
    (usedVars.get(m[1]) ?? usedVars.set(m[1], new Set()).get(m[1])).add(rel(f));
  }
}
for (const [v, where] of usedVars) {
  if (!defined.has(v)) out.vars.push(`${v} — used in ${[...where].join(", ")}`);
}

/* 2. class names ---------------------------------------------------------- */
const cssClasses = new Set();
for (const f of css) for (const m of read(f).matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)) cssClasses.add(m[1]);
const VALID = /^-?[a-zA-Z_][\w-]*$/;
const RUNTIME_OK = /^(is-|has-|js-|sr-only$|visually-hidden$)/;
const usedClasses = new Map();
const addClass = (c, f) => {
  c = c.trim();
  // Only judge complete literal class names: fragments left behind by
  // ${…} / <?= … ?> interpolation are not claims about a stylesheet.
  if (!c || !VALID.test(c) || c.endsWith("--") || c.endsWith("__") || RUNTIME_OK.test(c)) return;
  (usedClasses.get(c) ?? usedClasses.set(c, new Set()).get(c)).add(rel(f));
};
for (const f of code) {
  const src = read(f);
  const isPhp = f.endsWith(".php");
  for (const m of src.matchAll(/class(?:Name)?=["']([^"'{}]*)["']/g)) {
    // drop any segment adjacent to an interpolation marker
    m[1].split(/\s+/).forEach((c) => addClass(c, f));
  }
  for (const m of src.matchAll(/class(?:Name)?=\{`([^`]*)`\}/g)) {
    // split on interpolations, keep only whitespace-delimited whole tokens
    m[1].split(/\$\{[^}]*\}/).forEach((chunk, i, arr) => {
      const parts = chunk.split(/\s+/);
      // a chunk boundary that is not whitespace-delimited is a partial token
      if (i > 0) parts.shift();
      if (i < arr.length - 1) parts.pop();
      parts.forEach((c) => addClass(c, f));
    });
  }
  if (isPhp) {
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      m[1].split(/<\?=[\s\S]*?\?>/).forEach((chunk, i, arr) => {
        const parts = chunk.split(/\s+/);
        if (i > 0) parts.shift();
        if (i < arr.length - 1) parts.pop();
        parts.forEach((c) => addClass(c, f));
      });
    }
    // PHP strings that build class lists: 'badge badge--gold'
    for (const m of src.matchAll(/'((?:[a-z][\w-]*\s+)*[a-z][\w-]*)'/g)) {
      if (/--|__/.test(m[1])) m[1].split(/\s+/).forEach((c) => addClass(c, f));
    }
  }
}
for (const [c, where] of usedClasses) {
  if (!cssClasses.has(c)) out.orphans.push(`.${c} — used in ${[...where].slice(0, 3).join(", ")}`);
}

/* 3. colours -------------------------------------------------------------- */
for (const f of css) {
  if (/styles[\\/](tokens|base|components|layout|utilities)\.css$/.test(f)) continue;
  if (/assets[\\/]ds[\\/]/.test(f)) continue;
  const src = stripData(read(f));
  const opaque = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b|rgb\([^)]*\)|hsl\([^)]*\)/g)].map((m) => m[0]);
  const alpha = [...src.matchAll(/rgba\([^)]*\)|hsla\([^)]*\)/g)].map((m) => m[0]);
  if (opaque.length) out.colours.push(`×${opaque.length} in ${rel(f)} — ${[...new Set(opaque)].slice(0, 6).join(" ")}`);
  if (alpha.length) out.tints.push(`×${alpha.length} in ${rel(f)}`);
}

/* 4. inline styles -------------------------------------------------------- */
for (const f of code) {
  const src = read(f);
  for (const m of src.matchAll(/style=\{\{([^}]*(?:\}[^}]*)??)\}\}/g)) {
    const body = m[1];
    // Allowed: custom properties (--i stagger), spreads, and values computed
    // from JS (a template literal or an expression) — those cannot live in CSS.
    const dynamic = /--[\w-]+/.test(body) || /^\s*\.\.\./.test(body) || /\$\{|\bprops\.|\w+\s*\?/.test(body);
    if (!dynamic) out.inline.push(`${rel(f)} — style={{${body.trim().slice(0, 70)}}}`);
  }
  for (const m of src.matchAll(/style="([^"]*)"/g)) {
    if (!m[1].includes("--")) out.inline.push(`${rel(f)} — style="${m[1].slice(0, 70)}"`);
  }
}

const LABEL = {
  vars: "UNDEFINED CSS VARIABLE",
  orphans: "ORPHAN CLASS (no CSS rule)",
  colours: "OPAQUE RAW COLOUR",
  tints: "alpha tint (informational)",
  inline: "INLINE STYLE",
};
let total = 0;
for (const [k, list] of Object.entries(out)) {
  if (only && only !== k) continue;
  if (!list.length) continue;
  if (k !== "tints") total += list.length;
  console.log(`\n── ${LABEL[k]} (${list.length})`);
  list.slice(0, 50).forEach((p) => console.log("  " + p));
  if (list.length > 50) console.log(`  … and ${list.length - 50} more`);
}
console.log(`\n${total} actionable finding(s) across ${css.length} stylesheets and ${code.length} source files.`);
