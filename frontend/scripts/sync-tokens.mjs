// Copies the shared design-system stylesheets to the PHP admin so both
// surfaces render from ONE component library. Runs automatically before
// `npm run dev` / `npm run build` (see package.json) and can be run by hand:
//   npm run sync-tokens
//
//   frontend/src/styles/{tokens,base,layout,components,utilities}.css
//     → backend/admin/assets/ds/*.css   (loaded by admin_layout.php in this order)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../src/styles");
const destDir = resolve(here, "../../backend/admin/assets/ds");
const FILES = ["tokens.css", "base.css", "layout.css", "components.css", "utilities.css"];

mkdirSync(destDir, { recursive: true });
for (const name of FILES) {
  const banner = `/* GENERATED FILE — do not edit. Source: frontend/src/styles/${name} (npm run sync-tokens) */\n`;
  writeFileSync(resolve(destDir, name), banner + readFileSync(resolve(srcDir, name), "utf8"));
}
console.log(`[sync-tokens] ${FILES.length} stylesheet(s) → ${destDir}`);
