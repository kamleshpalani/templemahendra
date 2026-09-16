#!/usr/bin/env node
/**
 * tests/search-api.mjs — GET /api/search, the one search box over the whole
 * public site, against the real PHP + MySQL stack.
 *
 *   node tests/search-api.mjs [http://127.0.0.1:8050]
 *
 * Carried over from the retired devotee account suite, plus the family
 * registration page: a visitor who types "register", "family" or பதிவு is taken
 * to /register (docs/registration/SPEC.md §7, entry points).
 *
 * Read-only: it creates no rows. Requests carry X-Forwarded-For 10.80.0.200.
 */

const BASE = (process.argv[2] || "http://127.0.0.1:8050").replace(/\/$/, "");
const XFF = "10.80.0.200";

let pass = 0;
let fail = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 400)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);

async function request(method, path) {
  const res = await fetch(BASE + path, { method, headers: { "X-Forwarded-For": XFF, Accept: "application/json" } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* asserted by the caller */ }
  return { status: res.status, json, text };
}
const search = (q, extra = "") => request("GET", `/api/search?q=${encodeURIComponent(q)}${extra}`);
const urlsOf = (r) => (r.json?.groups ?? []).flatMap((g) => g.items.map((i) => i.url));
const pageItem = (r, url) => (r.json?.groups ?? []).find((g) => g.type === "pages")?.items.find((i) => i.url === url);

const probe = await fetch(`${BASE}/api/pulse`).catch(() => null);
if (!probe || !probe.ok) {
  console.log(`✗ no backend at ${BASE}. Start one with serve.sh 8050.`);
  process.exit(1);
}

try {
  section("the basics");
  let r = await search("a");
  check(r.status === 200 && r.json?.total === 0, "a one-character query returns nothing, politely", `status ${r.status}`);
  check(Boolean(r.json?.message), "…with a message saying why");

  r = await search("abhishekam");
  check(r.status === 200 && r.json?.total > 0, "a real word finds results", `total ${r.json?.total}`);
  check(Array.isArray(r.json?.groups) && r.json.groups.every((g) => g.label_ta && g.label_en), "every group is labelled in both languages");
  check(r.json?.groups?.every((g) => g.items.every((i) => typeof i.url === "string" && i.url.startsWith("/"))), "every result points at an in-site path");

  r = await search("80G");
  check(urlsOf(r).includes("/about#trust"), "a keyword that never appears on screen still finds its page (80G → Trust)", urlsOf(r).join(","));

  r = await search("பௌர்ணமி");
  check(r.status === 200 && r.json?.total > 0, "a Tamil query finds results", `total ${r.json?.total}`);

  r = await search("zzqq-nothing-matches-this");
  check(r.status === 200 && r.json?.total === 0 && Array.isArray(r.json.groups) && r.json.groups.length === 0, "no matches returns an empty group list, not an error");

  section("hostile queries");
  r = await search("100%");
  check(r.status === 200, "a query containing % does not break the LIKE", `status ${r.status}`);
  r = await search("a_b");
  check(r.status === 200, "nor does one containing _", `status ${r.status}`);
  r = await search("' OR 1=1 --");
  check(r.status === 200 && !/Fatal|PDOException|SQLSTATE/i.test(r.text), "an injection attempt is just a search term");
  r = await request("GET", "/api/search?q[]=abhishekam");
  check(r.status === 200 && !/Fatal|Warning|Stack trace/i.test(r.text), "a query sent as an array is not a 500", `status ${r.status} ${r.text.slice(0, 120)}`);
  r = await search("pooja", "&limit=9999");
  const largest = Math.max(0, ...(r.json?.groups ?? []).map((g) => g.items.length));
  check(largest <= 50, "the limit is capped server-side", `largest group ${largest}`);
  r = await request("POST", "/api/search");
  check(r.status === 405 || r.status === 404, "search is GET-only", `status ${r.status}`);

  section("the family registration page");
  for (const term of ["register", "registration", "Family", "members", "sign up", "பதிவு", "குடும்பம்", "உறுப்பினர்"]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes("/register"), `"${term}" finds /register`, urlsOf(r).join(","));
  }
  r = await search("Family registration");
  const item = pageItem(r, "/register");
  check(item?.title_en === "Family registration" && item?.title_ta === "குடும்பப் பதிவு", "the entry is titled in both languages, as the page's own SEO title", JSON.stringify(item));
  check(item?.score === 100, "an exact title match ranks first", JSON.stringify(item));
  r = await search("குடும்பப் பதிவு");
  check(pageItem(r, "/register")?.score === 100, "the Tamil title matches exactly too", JSON.stringify(pageItem(r, "/register")));
  for (const retired of ["/login", "/account", "/notifications"]) {
    r = await search(retired.slice(1));
    check(!urlsOf(r).includes(retired), `nothing points at the retired ${retired} page`, urlsOf(r).join(","));
  }

  section("online donation and the policy pages (docs/payments/SPEC.md §7.8)");
  for (const [term, url] of [
    ["donate online", "/donate"],
    ["UPI", "/donate"],
    ["net banking", "/donate"],
    ["ccavenue", "/donate"],
    ["இணையவழி", "/donate"],
    ["privacy", "/privacy-policy"],
    ["தனியுரிமை", "/privacy-policy"],
    ["terms", "/terms-and-conditions"],
    ["refund", "/refund-cancellation-policy"],
    ["ரத்து", "/refund-cancellation-policy"],
    ["shipping", "/shipping-delivery-policy"],
    ["delivery", "/shipping-delivery-policy"],
  ]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes(url), `"${term}" finds ${url}`, urlsOf(r).join(","));
  }
  r = await search("Donate online");
  const donate = pageItem(r, "/donate");
  check(donate?.title_en === "Donate online" && donate?.title_ta === "இணையவழி நன்கொடை", "/donate is titled in both languages, as the page's own SEO title", JSON.stringify(donate));
  r = await search("donate");
  check(urlsOf(r).includes("/donations") && urlsOf(r).includes("/donate"), "\"donate\" offers both the bank-details page and the online page", urlsOf(r).join(","));

  section("the live darshan page (docs/live/SPEC-PHASE1.md §4.6)");
  for (const term of ["live darshan", "live", "stream", "youtube", "watch online", "நேரடி தரிசனம்", "நேரலை", "ஒளிபரப்பு"]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes("/live-darshan"), `"${term}" finds /live-darshan`, urlsOf(r).join(","));
  }
  r = await search("Live Darshan");
  const liveDarshan = pageItem(r, "/live-darshan");
  check(liveDarshan?.title_en === "Live Darshan" && liveDarshan?.title_ta === "நேரடி தரிசனம்", "/live-darshan is titled in both languages, as the page's own SEO title", JSON.stringify(liveDarshan));
  check(liveDarshan?.score === 100, "an exact English title match scores 100", JSON.stringify(liveDarshan));
  r = await search("நேரடி தரிசனம்");
  check(pageItem(r, "/live-darshan")?.score === 100, "the exact Tamil title scores 100 too", JSON.stringify(pageItem(r, "/live-darshan")));

  section("the live darshan schedule page (docs/live/SPEC-PHASE2.md §1.3)");
  for (const term of ["schedule", "timetable", "அட்டவணை", "live darshan schedule"]) {
    r = await search(term);
    check(r.status === 200 && urlsOf(r).includes("/live-darshan/schedule"), `"${term}" finds /live-darshan/schedule`, urlsOf(r).join(","));
  }
  r = await search("Live Darshan schedule");
  const schedule = pageItem(r, "/live-darshan/schedule");
  check(schedule?.title_en === "Live Darshan schedule" && schedule?.title_ta === "நேரடி தரிசன அட்டவணை", "/live-darshan/schedule is titled in both languages, as the page's own SEO title", JSON.stringify(schedule));
  check(schedule?.score === 100, "the exact English title scores 100", JSON.stringify(schedule));
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
