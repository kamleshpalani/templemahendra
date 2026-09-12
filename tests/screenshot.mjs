// Screenshot + console-error probe.
//   node shot.mjs <url> <out.png> [width] [height] [--login] [--full] [--wait ms] [--click selector]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [url, out, w = "1440", h = "900", ...flags] = process.argv.slice(2);
const has = (f) => flags.includes(f);
const val = (f) => (flags.includes(f) ? flags[flags.indexOf(f) + 1] : null);
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1, locale: "en-IN" });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("requestfailed", (r) => { if (!/fonts\.gstatic|googleapis|google\.com|wa\.me/.test(r.url())) errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });

if (has("--login")) {
  const origin = new URL(url).origin;
  await page.goto(origin + "/admin/login.php", { waitUntil: "networkidle" });
  await page.fill("#username", "admin");
  await page.fill("#password", "Admin@Test123");
  await page.click('button[type="submit"]');
  await page.waitForLoadState("networkidle");
}
await page.goto(url, { waitUntil: "networkidle" });
const wait = val("--wait");
if (wait) await page.waitForTimeout(Number(wait));
const click = val("--click");
if (click) { await page.click(click); await page.waitForTimeout(500); }
await page.screenshot({ path: out, fullPage: has("--full") });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
console.log(`saved ${out}${overflow ? "  ⚠ HORIZONTAL OVERFLOW" : ""}`);
if (errors.length) console.log("console/page errors:\n  " + [...new Set(errors)].slice(0, 15).join("\n  "));
else console.log("no console errors");
await browser.close();
