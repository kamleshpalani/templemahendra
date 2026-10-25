/**
 * Real MySQL + PHP + browser regression for the website enhancement brief.
 * Requires migrated test DB and running PHP (:8000) / Vite (:5173).
 * DB_* must point at the same disposable test database as PHP.
 * ADMIN_USERNAME / TEST_ADMIN_PASSWORD identify the local test owner.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const { chromium, webkit, devices } = createRequire(import.meta.url)("../frontend/node_modules/playwright/index.js");

const API = process.env.TEST_API || "http://127.0.0.1:8000";
const WEB = process.env.TEST_WEB || "http://localhost:5173";
const prefix = `ENHANCE-${Date.now()}`;
const ipPrefix = `10.91.${Math.floor(Math.random() * 255)}`;
let lane = 1;
const usedIps = new Set();
const nextIp = () => {
  const ip = `${ipPrefix}.${lane++}`;
  usedIps.add(ip);
  return ip;
};
let checks = 0;
const ids = { sevas: [], bookings: [], families: [], profiles: [] };
const check = (condition, name) => { assert.ok(condition, name); checks++; console.log(`PASS ${name}`); };
function sql(query, params = []) {
  const result = spawnSync(process.env.PHP_BIN || "php", ["tests/support/notify_fixtures.php", "sql", JSON.stringify({ query, params })],
    { encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  if (answer.error) throw new Error(answer.error);
  return answer;
}
const rows = (q, p) => sql(q, p).rows;
const first = (q, p) => rows(q, p)[0];
async function request(path, body, ip) {
  const address = ip || nextIp();
  usedIps.add(address);
  const response = await fetch(`${API}/api${path}`, { method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": address },
    body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  return { status: response.status, data };
}
let browser;
try {
  const normal = (await request("/sevas")).data.find((s) => s.name_en === "Normal Annadhanam");
  check(Number(normal.amount) === 100000 && Number(normal.is_featured) === 1, "Normal Annadhanam is recommended at ₹1,00,000");
  const pournami = (await request("/sevas")).data.find((s) => s.name_en === "Pournami Pooja Annadhanam");
  check(Number(pournami.amount) === 15000, "Pournami Annadhanam costs ₹15,000");
  for (const [kind, price] of [["archana", 100], ["archana_prasadam", 200], ["archana_pooja", 300]]) {
    sql("INSERT INTO sevas (name_ta,name_en,amount,service_kind,delivery_fee,is_active) VALUES (?,?,?,?,?,1)",
      [`${prefix} அர்ச்சனை`, `${prefix} ${kind}`, price, kind, kind === "archana" ? 0 : 50]);
    ids.sevas.push(Number(first("SELECT id FROM sevas WHERE name_en=?", [`${prefix} ${kind}`]).id));
  }
  const people = [{ name: `${prefix} பக்தர்`, rasi: "மேஷம்", nakshatram: "அசுவினி" },
    { name: `${prefix} Person 2`, rasi: "Rishabam", nakshatram: "Rohini" }];
  const delivery = { address: "12 QA Street", city: "Tenkasi", state: "Tamil Nadu", country: "India", postcode: "627719" };
  const booking = { seva_id: ids.sevas[1], seva_name: "Spoofed price/name", devotee_name: `${prefix} Booking`,
    phone: "919876543210", phoneCountry: "IN", participants: people, delivery_address: delivery, lang: "en" };
  let r = await request("/seva-bookings", { ...booking, participants: [] });
  check(r.status === 422 && r.data.fields.participants, "Archana requires participants");
  r = await request("/seva-bookings", { ...booking, delivery_address: { ...delivery, postcode: "" } });
  check(r.status === 422 && r.data.fields["delivery_address.postcode"], "Prasadam requires complete postal address");
  r = await request("/seva-bookings", { ...booking, preferred_date: "2033-02-30" });
  check(r.status === 422 && r.data.fields.preferred_date, "Invalid request dates are reported, not silently discarded");
  r = await request("/seva-bookings", booking);
  check(r.status === 201 && r.data.booking_number && r.data.payment_status === "UNPAID", "Request booking returns reference and unpaid status");
  ids.bookings.push(r.data.id);
  const saved = first("SELECT * FROM seva_bookings WHERE id=?", [r.data.id]);
  check(Number(saved.amount) === 250 && Number(saved.delivery_fee) === 50, "Stored total is authoritative service charge plus delivery");
  check(JSON.parse(saved.participants)[0].rasi === "மேஷம்" && saved.seva_name !== booking.seva_name, "Tamil participant data persists; posted service name is ignored");
  check(saved.dispatch_status === "pending" && JSON.parse(saved.delivery_address).postcode === "627719", "Delivery details persist for office dispatch");

  const family = { name: `${prefix} Family`, phone: "919876543211", phoneCountry: "IN", email: null,
    dateOfBirth: "1985-01-02", marriageDate: "2010-02-03", rasi: "மேஷம்", nakshatram: "அசுவினி", lang: "en",
    address1: "12 QA Street", address2: "", city: "Tenkasi", state: "TN", country: "IN", postcode: "627719", consent: false,
    members: [{ name: `${prefix} Member`, relationship: "spouse", dateOfBirth: "1987-01-01", marriageDate: "2010-02-03", rasi: "Rishabam", nakshatram: "Rohini" }] };
  r = await request("/registrations", { ...family, marriageDate: "1980-01-01" });
  check(r.status === 422 && r.data.fields.marriageDate, "Marriage cannot precede birth");
  r = await request("/registrations", family);
  check(r.status === 201 && r.data.success, "Expanded family registration accepted");
  const f = first("SELECT * FROM devotees WHERE name=?", [family.name]);
  ids.families.push(Number(f.id));
  check(f.marriage_date === "2010-02-03" && f.rasi === "மேஷம்", "Primary marriage date and Rasi persist");
  const m = first("SELECT * FROM devotee_family_members WHERE devotee_id=?", [f.id]);
  check(m.date_of_birth === "1987-01-01" && m.nakshatram === "Rohini", "Member dates and astrology persist");

  const profile = { name: `${prefix} Private`, dateOfBirth: "1995-01-01", phone: "919876543212",
    phoneCountry: "IN", email: "qa@example.test", city: "Tenkasi", education: "Graduate", occupation: "Engineer",
    introduction: "A test profile", preferences: "A test preference", visibility: "public_summary", consent: true };
  r = await request("/matrimony", { ...profile, dateOfBirth: "2020-01-01" });
  check(r.status === 422 && r.data.fields.dateOfBirth, "Matrimony refuses minors");
  r = await request("/matrimony", { ...profile, consent: false });
  check(r.status === 422 && r.data.fields.consent, "Matrimony requires separate explicit consent");
  r = await request("/matrimony", profile);
  check(r.status === 201 && /^[a-f0-9]{64}$/.test(r.data.management_token), "Matrimony creates pending profile with secret management key");
  const profileId = r.data.id;
  ids.profiles.push(profileId);
  const token = r.data.management_token;
  check(!(await request("/matrimony")).data.some((p) => Number(p.id) === profileId), "Pending profile is not publicly visible");
  check((await request("/matrimony", { action: "load", management_token: "0".repeat(64) })).status === 403, "Invalid management key cannot read private data");
  r = await request("/matrimony", { action: "load", management_token: token });
  check(r.data.profile.name === profile.name && !r.data.profile.management_hash, "Valid management key reads own data without disclosing hash");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: "reduce", extraHTTPHeaders: { "X-Forwarded-For": nextIp() } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("temple:lang")) localStorage.setItem("temple:lang", "en");
  });
  const page = await context.newPage();
  await page.goto(`${API}/admin/login.php`);
  await page.locator('input[name="username"]').fill(process.env.ADMIN_USERNAME || "enhancement-qa");
  await page.locator('input[name="password"]').fill(process.env.TEST_ADMIN_PASSWORD || "Enhancement@Test123");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${API}/admin/`);
  check(true, "Admin sign-in works");
  await page.goto(`${API}/admin/matrimony.php`);
  const profileCard = page.locator("article").filter({ has: page.getByRole("heading", { name: new RegExp(`Profile #${profileId}`) }) });
  await profileCard.locator('select[name="status"]').selectOption("approved");
  await profileCard.getByRole("button", { name: "Save review" }).click();
  const summary = (await request("/matrimony")).data.find((p) => Number(p.id) === profileId);
  check(summary && !("name" in summary) && !("phone" in summary) && !("email" in summary) && !("date_of_birth" in summary), "Moderation publishes only consented, anonymous summary");
  r = await request("/matrimony", { ...profile, action: "update", management_token: token, visibility: "private" });
  check(r.data.status === "pending" && !(await request("/matrimony")).data.some((p) => Number(p.id) === profileId), "Privacy change unpublishes immediately and resets moderation");
  r = await request("/matrimony", { action: "delete", management_token: token });
  check(r.data.success && !first("SELECT id FROM matrimony_profiles WHERE id=?", [profileId]), "Applicant can permanently delete profile with management key");

  await page.goto(`${API}/admin/panchangam.php?date=2033-04-08`);
  for (const [key, value] of Object.entries({ calendar_date: "2033-04-08", tithi_ta: "பௌர்ணமி", tithi_en: "Pournami",
    nakshatram_ta: "ரோகிணி", nakshatram_en: "Rohini", source: `${prefix} local calendar test data`,
    nalla_neram: "07:30-09:00, 16:30-18:00", gulika_kalam: "10:30-12:00", yamagandam: "07:30-09:00",
    rahu_kalam: "12:00-13:30", brahma_muhurtham: "04:30-06:00" })) {
    await page.locator(`form[method="post"] input[name="${key}"]`).fill(value);
  }
  await page.getByRole("button", { name: "Save verified Panchangam" }).click();
  await page.waitForURL(/saved=1/);
  const day = (await request("/calendar?year=2033&month=4")).data.days.find((d) => d.date === "2033-04-08");
  check(day.verified && day.nakshatram_ta === "ரோகிணி" && day.timings.nalla_neram.length === 2 &&
    day.timezone === "Asia/Kolkata" && day.source.includes(prefix), "Admin daily Panchangam save reaches public API with source, Tamil, local timezone");
  check(day.tithi === null && day.tamil_month === null && day.special.every((s) => s.custom),
    "Verified Tithi does not inherit conflicting estimated lunar/solar highlights");
  sql("INSERT INTO calendar_entries (entry_date,entry_type,title_ta,title_en) VALUES (?,'pournami',?,?)",
    ["2033-04-08", `${prefix} பௌர்ணமி`, `${prefix} Pournami`]);
  const highlighted = (await request("/calendar?year=2033&month=4")).data.days.find((d) => d.date === "2033-04-08");
  check(highlighted.special.some((s) => s.type === "pournami" && s.custom), "Committee Pournami highlights remain on verified dates");

  await page.goto(`${API}/admin/seva_bookings.php`);
  const bookingRow = page.locator("tr").filter({ hasText: booking.devotee_name });
  await bookingRow.locator("summary").filter({ hasText: "Prasadam:" }).click();
  await bookingRow.locator('select[name="dispatch_status"]').selectOption("dispatched");
  await bookingRow.locator('input[name="tracking_reference"]').fill(`${prefix}-TRACK`);
  await bookingRow.getByRole("button", { name: "Save delivery" }).click();
  check(first("SELECT dispatch_status FROM seva_bookings WHERE id=?", [ids.bookings[0]]).dispatch_status === "dispatched", "Admin Prasadam dispatch action persists");

  await page.goto(`${API}/admin/devotees.php?edit=${f.id}`);
  check(await page.locator('input[name="marriage_date"]').inputValue() === "2010-02-03", "Admin family edit retains primary marriage date");
  const memberBirth = page.locator('input[name$="[dateOfBirth]"]').first();
  check(await memberBirth.inputValue() === "1987-01-01", "Admin family edit retains member date of birth");
  await page.locator('input[name="marriage_date"]').fill("2011-02-03");
  await memberBirth.fill("1988-01-01");
  await page.getByRole("button", { name: "Save registration", exact: true }).click();
  check(first("SELECT marriage_date FROM devotees WHERE id=?", [f.id]).marriage_date === "2011-02-03" &&
    first("SELECT date_of_birth FROM devotee_family_members WHERE devotee_id=?", [f.id]).date_of_birth === "1988-01-01",
    "Admin saves changed primary and member dates without losing family details");
  const familyCsv = await context.request.get(`${API}/admin/devotees.php?export=csv`);
  const memberCsv = await context.request.get(`${API}/admin/devotees.php?export=members_csv`);
  check((await familyCsv.text()).includes("marriage_date,rasi,nakshatram") &&
    (await memberCsv.text()).includes("date_of_birth,marriage_date,rasi,nakshatram"),
    "Family CSV exports include expanded primary and member fields");
  const bookingCsv = await context.request.get(`${API}/admin/seva_bookings.php?export=csv`);
  check((await bookingCsv.text()).includes("participants,delivery_address,delivery_fee,dispatch_status,tracking_reference"),
    "Booking CSV exports include participants and delivery tracking");

  await page.goto(`${WEB}/sevas?seva=${ids.sevas[1]}`);
  const modal = page.getByRole("dialog");
  await modal.waitFor();
  const payAtTemple = modal.getByText("Send a booking request — pay at the temple", { exact: true });
  if (await payAtTemple.count()) await payAtTemple.click();
  await modal.locator('input[name="devotee_name"]').fill(`${prefix} UI Booking`);
  await modal.getByRole("button", { name: "Add Person (+)", exact: true }).click();
  for (let i = 1; i <= 2; i++) {
    await modal.locator(`#booking-person-${i}-name`).fill(`${prefix} UI ${i}`);
    await modal.locator(`#booking-person-${i}-rasi`).fill("மேஷம்");
    await modal.locator(`#booking-person-${i}-nakshatram`).fill("அசுவினி");
  }
  for (const [key, value] of Object.entries(delivery)) await modal.locator(`#booking-delivery-${key}`).fill(value);
  await modal.locator('input[name="phone"]').fill("9876543210");
  await modal.getByRole("button", { name: /Send.*Request|Send.*request|Submit/i }).click();
  await modal.getByRole("heading", { name: "Booking Received!" }).waitFor();
  const uiBooking = first("SELECT id,participants FROM seva_bookings WHERE devotee_name=?", [`${prefix} UI Booking`]);
  ids.bookings.push(Number(uiBooking.id));
  check(JSON.parse(uiBooking.participants).length === 2, "Public multi-person Archana form saves both people and Prasadam address");

  await page.goto(`${WEB}/matrimony`);
  await page.evaluate((draft) => sessionStorage.setItem("temple:registration-draft", JSON.stringify({ form: draft })),
    { ...family, phone: "9876543211" });
  const copyDraft = page.getByRole("button", { name: "Copy my draft details", exact: true });
  check(await copyDraft.isDisabled() && await page.locator("#matrimony-name").inputValue() === "",
    "Matrimony does not copy family details without permission");
  await page.getByRole("checkbox", { name: /I permit copying/ }).check();
  await copyDraft.click();
  check(await page.locator("#matrimony-name").inputValue() === family.name, "Explicit consent copies own family draft details");
  await page.locator("#matrimony-name").fill(`${prefix} UI Matrimony`);
  await page.getByRole("checkbox", { name: /This is my own profile/ }).check();
  await page.getByRole("button", { name: "Register profile", exact: true }).click();
  await page.getByText("Profile submitted for private review.", { exact: false }).waitFor();
  const uiProfile = first("SELECT id,visibility FROM matrimony_profiles WHERE name=?", [`${prefix} UI Matrimony`]);
  ids.profiles.push(Number(uiProfile.id));
  check(uiProfile.visibility === "private" && (await page.getByLabel("Management key").inputValue()).length === 64,
    "Public Matrimony form defaults to private and returns a management key");
  await page.getByRole("button", { name: "Load my profile", exact: true }).click();
  await page.getByText(`Profile #${uiProfile.id} loaded`, { exact: false }).waitFor();
  check((await page.locator("#matrimony-phone").inputValue()).replace(/\D/g, "") === "9876543211", "Profile management restores national phone correctly");
  await page.getByRole("button", { name: "Delete my profile", exact: true }).click();
  await page.getByRole("button", { name: "Confirm deletion", exact: true }).click();
  await page.getByText("Your profile and personal details have been deleted.", { exact: true }).waitFor();
  check(!first("SELECT id FROM matrimony_profiles WHERE id=?", [uiProfile.id]), "Public management UI permanently deletes own profile");

  await page.route("**/api/sevas", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: JSON.stringify({ error: "QA service unavailable" }),
  }));
  await page.goto(`${WEB}/sevas`);
  await page.getByText("Services could not be loaded", { exact: true }).waitFor();
  check(await page.locator(".seva-card").count() === 0, "Service load failure is explicit and never offers invented fallback bookings");
  await page.unroute("**/api/sevas");
  await page.route("**/api/sevas", (route) => route.fulfill({ contentType: "application/json", body: "[]" }));
  await page.reload();
  await page.getByText("Services will appear here when published by the office.", { exact: true }).waitFor();
  check(await page.locator(".seva-card").count() === 0, "An empty service list has an honest empty state");
  await page.unroute("**/api/sevas");

  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  const routes = ["/", "/about", "/contact", "/events", "/panchangam", "/sevas", "/register", "/matrimony"];
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of routes) {
      await page.goto(`${WEB}${path}`);
      await page.locator("main h1").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => document.fonts.ready);
      check(await page.locator("main h1").count() === 1, `${path} has one page heading at ${width}px`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path} has no document overflow at ${width}px`);
    }
  }
  await page.goto(WEB);
  check(await page.getByRole("heading", { name: "Notice", exact: true }).count() === 1, "Home shows Notice");
  check(await page.locator(".pulse-countdown").count() === 0 && !(await page.locator("main").innerText()).includes("Today's Schedule"), "Removed schedule and countdown are absent from DOM");
  check(await page.locator(".home-hero a").filter({ hasText: "Live Darshan" }).count() === 1, "Hero has prominent Live Darshan link");
  check(consoleErrors.length === 0, `No React runtime exceptions (${consoleErrors.join("; ")})`);
  await page.goto(`${WEB}/panchangam`);
  await page.locator('input[type="date"]').fill("2033-04-08");
  await page.getByRole("button", { name: "Day", exact: true }).click();
  await page.getByText("Committee verified", { exact: true }).waitFor();
  check(await page.getByText("Rohini", { exact: true }).count() === 1, "Date-wise Panchangam renders verified Nakshatram");

  const axe = readFileSync(new URL("../frontend/node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
  for (const path of ["/", "/events", "/panchangam", "/matrimony"]) {
    await page.goto(`${WEB}${path}`);
    await page.locator("main h1").waitFor();
    await page.addScriptTag({ content: axe });
    const violations = await page.evaluate(async () => (await axe.run(document.querySelector("main"))).violations
      .filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`));
    check(violations.length === 0, `${path} has no serious/critical accessibility violations: ${violations.join("; ")}`);
  }
  for (const language of ["en", "ta"]) {
    await page.evaluate((value) => localStorage.setItem("temple:lang", value), language);
    await page.reload();
    await page.locator("main h1").waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const width of [1024, 1060, 1100, 1200, 1280, 1400, 1440, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      const clipped = await page.locator(".navbar__nav").evaluate((nav) => {
        const bounds = nav.getBoundingClientRect();
        return [...nav.querySelectorAll("a")].filter((a) => {
          const rect = a.getBoundingClientRect();
          return rect.width && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
        }).map((a) => a.textContent);
      });
      check(clipped.length === 0, `${language} navigation has no clipped links at ${width}px: ${clipped.join(", ")}`);
    }
  }
  await context.close();
  const android = await browser.newContext({ ...devices["Pixel 7"], reducedMotion: "reduce" });
  const androidPage = await android.newPage();
  for (const path of routes) {
    await androidPage.goto(`${WEB}${path}`);
    await androidPage.locator("main h1").waitFor();
    check(await androidPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Chromium Android emulation ${path} fits viewport`);
  }
  await android.close();
  // Actual WebKit engine with an iPhone viewport, not a claim of physical iOS testing.
  try {
    const safari = await webkit.launch({ headless: true });
    const mobile = await safari.newContext(devices["iPhone 13"]);
    const phonePage = await mobile.newPage();
    for (const path of ["/", "/panchangam", "/register", "/matrimony"]) {
      await phonePage.goto(`${WEB}${path}`);
      await phonePage.locator("main h1").waitFor();
      check(await phonePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `WebKit iPhone ${path} fits viewport`);
    }
    await safari.close();
  } catch (error) {
    if (!String(error).includes("Executable doesn't exist")) throw error;
    console.log("SKIP WebKit: browser binary not installed; physical iOS was not tested.");
  }
  console.log(`\n${checks} enhancement checks passed.`);
} finally {
  await browser?.close();
  for (const id of ids.bookings) sql("DELETE FROM seva_bookings WHERE id=? AND devotee_name LIKE ?", [id, `${prefix}%`]);
  for (const id of ids.families) sql("DELETE FROM devotees WHERE id=? AND name LIKE ?", [id, `${prefix}%`]);
  for (const id of ids.profiles) sql("DELETE FROM matrimony_profiles WHERE id=? AND name LIKE ?", [id, `${prefix}%`]);
  for (const id of ids.sevas) sql("DELETE FROM sevas WHERE id=? AND name_en LIKE ?", [id, `${prefix}%`]);
  sql("DELETE FROM panchangam_days WHERE calendar_date=? AND source=?", ["2033-04-08", `${prefix} local calendar test data`]);
  sql("DELETE FROM calendar_entries WHERE entry_date=? AND title_en=?", ["2033-04-08", `${prefix} Pournami`]);
  for (const ip of usedIps) sql("DELETE FROM rate_limits WHERE bucket LIKE ?", [`%:${ip}`]);
}
