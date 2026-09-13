#!/usr/bin/env node
/**
 * tests/registration-api.mjs — POST /api/registrations, the one request the
 * multi-step family registration form sends, end to end against the real
 * PHP + MySQL stack (docs/registration/SPEC.md §5).
 *
 *   PHP_BIN=/path/to/php.sh node tests/registration-api.mjs [http://127.0.0.1:8050]
 *
 * The server must trust 127.0.0.1 as a proxy (TRUSTED_PROXIES=127.0.0.1,::1) so
 * each scenario can send its own X-Forwarded-For from 10.80.0.1–99 and keep its
 * own rate-limit buckets. Set NOTIFY_READY_FILE to a hand-off marker path to
 * skip the confirmation-message checks until that file exists.
 *
 * What it proves:
 *   1. every rule answers 422 with the key the frontend maps to a step, for
 *      hostile types (arrays, numbers, objects, null) and at every boundary
 *      (lengths in Tamil characters, 0/1/20/21 members, ages, dates of birth,
 *      the Indian PIN), and a gender key is ignored;
 *   2. what a registration stores: language, date of birth, consent time, NULL
 *      email, E.164 phone, members in order;
 *   3. a phone number already registered (E.164 or a legacy ten-digit row) is
 *      saved and flagged, and answered exactly like a new family;
 *   4. the honeypot answers the same, saves nothing and sends nothing;
 *   5. attempt and save limits answer 429 with Retry-After, per address;
 *   6. 405 for other methods, and no response ever sets a cookie;
 *   7. a consenting registration queues registration.received with the family
 *      count, and a non-consenting one queues nothing.
 *
 * Creates registrations named "E2E-REG-API-<run> …" and deletes them (members
 * and notifications cascade) and its rate_limits buckets at the end.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = (process.argv[2] || "http://127.0.0.1:8050").replace(/\/$/, "");
const PHP_BIN = process.env.PHP_BIN || "php";
const REPO = fileURLToPath(new URL("..", import.meta.url));
const RUN = Date.now().toString(36);
const PREFIX = `E2E-REG-API-${RUN}`;
const SUCCESS = '{"success":true}';
const FIELDS_ERROR = "Please correct the highlighted fields.";
// Our own addresses only: 10.80.0.1 to 10.80.0.99.
const BUCKETS_REGEXP = ":10[.]80[.]0[.]([1-9]|[1-9][0-9])$";

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (cond, name, detail = "") => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && detail ? `\n    ${String(detail).slice(0, 600)}` : ""}`);
  return cond;
};
const section = (t) => console.log(`\n── ${t}`);

/* ── PHP and SQL ───────────────────────────────────────────────────────── */
function php(args) {
  const viaBash = PHP_BIN.endsWith(".sh");
  const r = spawnSync(viaBash ? "bash" : PHP_BIN, viaBash ? [PHP_BIN, ...args] : args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
function sql(query, params = []) {
  // No backslashes in statements: Git Bash strips them on the way to php.sh.
  const out = php(["tests/support/notify_fixtures.php", "sql", JSON.stringify({ query, params })]);
  const data = JSON.parse(out.trim().split("\n").pop());
  if (data.error) throw new Error(`sql: ${data.error} — ${query}`);
  return data;
}
const rows = (query, params = []) => sql(query, params).rows;
const one = (query, params = []) => rows(query, params)[0] ?? null;

/* ── HTTP ──────────────────────────────────────────────────────────────── */
// A pool of addresses for the validation matrix: each takes at most 12 attempts
// and 8 saves, well inside the 15/10 limits, before the next one is used.
let laneN = 0;
let laneAttempts = 0;
let laneSaves = 0;
function laneIp() {
  if (laneN === 0 || laneAttempts >= 12 || laneSaves >= 8) {
    laneN += 1;
    laneAttempts = 0;
    laneSaves = 0;
    if (laneN > 89) throw new Error("the validation matrix ran out of test addresses");
  }
  laneAttempts += 1;
  return `10.80.0.${laneN}`;
}
const cookies = [];
const serverErrors = [];
async function send(method, body, { ip, raw = false } = {}) {
  const fromLane = !ip;
  const xff = ip || laneIp();
  const headers = { "X-Forwarded-For": xff };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = raw ? body : JSON.stringify(body);
  }
  const res = await fetch(`${BASE}/api/registrations`, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported by the caller */ }
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookies.push(`${method} → ${res.status}: ${setCookie}`);
  if (res.status >= 500) serverErrors.push(`${res.status} ${text.slice(0, 200)}`);
  if (fromLane && res.status === 201) laneSaves += 1;
  return { status: res.status, text, json, headers: res.headers, ip: xff };
}

/* ── Registrations ─────────────────────────────────────────────────────── */
const PHONE_BASE = String(Math.floor(Math.random() * 9000) + 1000);
let phoneN = 0;
const nextPhone = () => `+91 9${PHONE_BASE}${String(phoneN++).padStart(5, "0")}`;
const digitsOf = (p) => p.replace(/[^0-9]/g, "");
let nameN = 0;
const uniqueName = (label) => `${PREFIX} ${label} ${nameN++}`;

const valid = (over = {}) => ({
  name: uniqueName("Kumar"),
  dateOfBirth: "",
  phone: nextPhone(),
  phoneCountry: "IN",
  email: "",
  lang: "ta",
  members: [],
  address1: "12 North Street",
  address2: "",
  city: "Pudupatti",
  state: "TN",
  country: "IN",
  postcode: "627719",
  consent: false,
  hp_token: "",
  ...over,
});
const without = (obj, ...keys) => {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
};
const member = (over = {}) => ({ name: "K. Meena", relationship: "spouse", age: 41, ...over });

async function expectField(label, body, key) {
  const r = await send("POST", body);
  const ok = r.status === 422
    && r.json?.error === FIELDS_ERROR
    && r.json?.fields && Object.prototype.hasOwnProperty.call(r.json.fields, key)
    && typeof r.json.fields[key] === "string" && r.json.fields[key].length > 0;
  check(ok, `${label} → 422 with "${key}"`, `${r.status} ${r.text.slice(0, 400)}`);
  return r;
}
async function expectSaved(label, body) {
  const r = await send("POST", body);
  check(r.status === 201 && r.text === SUCCESS, `${label} → 201 {"success":true}`, `${r.status} ${r.text.slice(0, 400)}`);
  return r;
}
const stored = (name) => one("SELECT * FROM devotees WHERE name = ?", [name]);
const storedMembers = (id) => rows("SELECT name, relationship, age, sort_order FROM devotee_family_members WHERE devotee_id = ? ORDER BY sort_order, id", [id]);

// Dates the rules are measured against: the temple's today, in India.
const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
const ymd = (d) => d.toISOString().slice(0, 10);
const todayIst = ymd(istNow);
const tomorrowIst = ymd(new Date(istNow.getTime() + 86400 * 1000));
const yearsAgo = (n) => `${String(istNow.getUTCFullYear() - n).padStart(4, "0")}${todayIst.slice(4)}`;
const TA = "த"; // one Tamil character, one code point

function cleanup() {
  sql("DELETE FROM devotees WHERE name LIKE ?", ["E2E-REG-API-%"]);
  sql("DELETE FROM rate_limits WHERE bucket REGEXP ?", [BUCKETS_REGEXP]);
}

const probe = await fetch(`${BASE}/api/pulse`).catch(() => null);
if (!probe || !probe.ok) {
  console.log(`✗ no backend at ${BASE}. Start one with serve.sh 8050.`);
  process.exit(1);
}
cleanup();

try {
  /* ── 1. Validation ───────────────────────────────────────────────────── */
  section("1a. the registrant's name");
  await expectField("name missing", without(valid(), "name"), "name");
  await expectField("name blank", valid({ name: "   " }), "name");
  await expectField("name one character", valid({ name: "அ" }), "name");
  await expectField("name as an array", valid({ name: ["E2E-REG-API name"] }), "name");
  await expectField("name as a number", valid({ name: 12345 }), "name");
  await expectField("name as a nested object", valid({ name: { first: { second: "x" } } }), "name");
  await expectField("name null", valid({ name: null }), "name");
  await expectField("name that is only a tag", valid({ name: "<b></b>x" }), "name");
  const name200 = `E2E-REG-API-${RUN}`.padEnd(200, TA);
  await expectSaved("name of exactly 200 Tamil characters", valid({ name: name200 }));
  const row200 = stored(name200);
  check(row200 && Array.from(row200.name).length === 200, "the 200-character name is stored whole", row200?.name?.length);
  await expectField("name of 201 characters", valid({ name: name200 + TA }), "name");
  const tagged = uniqueName("Tagged");
  await expectSaved("a name carrying HTML tags", valid({ name: `${tagged}<script>alert(1)</script>` }));
  check(Boolean(stored(`${tagged}alert(1)`)), "tags are stripped before the name is stored");

  section("1b. date of birth (optional)");
  for (const [label, value] of [["missing", undefined], ["null", null], ["blank", ""]]) {
    const n = uniqueName(`dob ${label}`);
    const body = valid({ name: n });
    if (value === undefined) delete body.dateOfBirth; else body.dateOfBirth = value;
    await expectSaved(`date of birth ${label}`, body);
    check(stored(n)?.date_of_birth === null, `date of birth ${label} stores NULL`, JSON.stringify(stored(n)?.date_of_birth));
  }
  const dobToday = uniqueName("dob today");
  await expectSaved("date of birth today (IST)", valid({ name: dobToday, dateOfBirth: todayIst }));
  check(stored(dobToday)?.date_of_birth === todayIst, "today's date of birth is stored", stored(dobToday)?.date_of_birth);
  const dob120 = uniqueName("dob 120 years");
  await expectSaved("date of birth exactly 120 years ago", valid({ name: dob120, dateOfBirth: yearsAgo(120) }));
  await expectField("date of birth tomorrow", valid({ dateOfBirth: tomorrowIst }), "dateOfBirth");
  await expectField("date of birth 121 years ago", valid({ dateOfBirth: yearsAgo(121) }), "dateOfBirth");
  await expectField("date of birth 2023-02-30", valid({ dateOfBirth: "2023-02-30" }), "dateOfBirth");
  await expectField("date of birth written 21-04-1978", valid({ dateOfBirth: "21-04-1978" }), "dateOfBirth");
  await expectField("date of birth as a number", valid({ dateOfBirth: 19780421 }), "dateOfBirth");
  await expectField("date of birth as an array", valid({ dateOfBirth: ["1978-04-21"] }), "dateOfBirth");

  section("1c. phone");
  await expectField("phone missing", without(valid(), "phone"), "phone");
  await expectField("phone blank", valid({ phone: "" }), "phone");
  await expectField("phone of two digits", valid({ phone: "12" }), "phone");
  await expectField("phone of 16 digits", valid({ phone: "9".repeat(16) }), "phone");
  await expectField("phone as an array", valid({ phone: ["9876543210"] }), "phone");
  await expectField("phone as an object", valid({ phone: { number: "9876543210" } }), "phone");
  await expectField("phone null", valid({ phone: null }), "phone");
  const numericPhone = uniqueName("numeric phone");
  const numericDigits = digitsOf(nextPhone());
  await expectSaved("phone sent as a JSON number", valid({ name: numericPhone, phone: Number(numericDigits) }));
  check(stored(numericPhone)?.phone === numericDigits, "a numeric phone is stored as its digits", stored(numericPhone)?.phone);
  const hostileCountry = uniqueName("phone country array");
  await expectSaved("phoneCountry as an array is ignored, not a 500", valid({ name: hostileCountry, phoneCountry: ["IN"] }));
  check(stored(hostileCountry)?.phone_country === null, "and no phone country is stored", stored(hostileCountry)?.phone_country);

  section("1d. email (optional)");
  const emailBlank = uniqueName("email blank");
  await expectSaved("email blank", valid({ name: emailBlank, email: "" }));
  check(stored(emailBlank)?.email === null, "a blank email is stored as NULL");
  const emailMissing = uniqueName("email missing");
  await expectSaved("email missing", without(valid({ name: emailMissing }), "email"));
  check(stored(emailMissing)?.email === null, "a missing email is stored as NULL");
  const emailCase = uniqueName("email case");
  await expectSaved("email in capitals", valid({ name: emailCase, email: `E2E-Reg-${RUN}@Example.TEST` }));
  check(stored(emailCase)?.email === `e2e-reg-${RUN}@example.test`, "the email is stored lowercase", stored(emailCase)?.email);
  await expectField("email invalid", valid({ email: "not-an-email" }), "email");
  await expectField("email as an array", valid({ email: ["a@example.test"] }), "email");
  await expectField("email as a number", valid({ email: 42 }), "email");
  // 64 + 1 + 63 + 1 + 61 = 190 characters: every part within the address rules.
  const email190 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(61)}`;
  const emailLong = uniqueName("email 190");
  await expectSaved("email of exactly 190 characters", valid({ name: emailLong, email: email190 }));
  await expectField("email of 191 characters", valid({ email: `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(62)}` }), "email");

  section("1e. language");
  await expectField("lang missing", without(valid(), "lang"), "lang");
  await expectField("lang fr", valid({ lang: "fr" }), "lang");
  await expectField("lang EN in capitals", valid({ lang: "EN" }), "lang");
  await expectField("lang as an array", valid({ lang: ["en"] }), "lang");

  section("1f. family members (optional, 0–20)");
  for (const [label, value] of [["missing", undefined], ["null", null], ["an empty list", []]]) {
    const n = uniqueName(`members ${label}`);
    const body = valid({ name: n });
    if (value === undefined) delete body.members; else body.members = value;
    await expectSaved(`members ${label}`, body);
    const row = stored(n);
    check(row && storedMembers(row.id).length === 0, `members ${label} saves a family of one`);
  }
  const oneMember = uniqueName("one member");
  await expectSaved("one member", valid({ name: oneMember, members: [member()] }));
  check(storedMembers(stored(oneMember)?.id ?? 0).length === 1, "one member is stored");
  const twenty = uniqueName("twenty members");
  const twentyList = Array.from({ length: 20 }, (_, i) => member({ name: `Member ${String(i + 1).padStart(2, "0")}`, relationship: i === 0 ? "spouse" : "son", age: i }));
  await expectSaved("twenty members", valid({ name: twenty, members: twentyList }));
  const twentyStored = storedMembers(stored(twenty)?.id ?? 0);
  check(twentyStored.length === 20 && twentyStored.every((m, i) => Number(m.sort_order) === i && m.name === `Member ${String(i + 1).padStart(2, "0")}`),
    "twenty members are stored in the order sent", JSON.stringify(twentyStored.slice(0, 3)));
  await expectField("twenty-one members", valid({ members: [...twentyList, member({ name: "One too many" })] }), "members");
  await expectField("members as a string", valid({ members: "K. Meena" }), "members");
  await expectField("members as a number", valid({ members: 3 }), "members");
  await expectField("members as a single object", valid({ members: member() }), "members");
  await expectField("a member that is a string", valid({ members: ["K. Meena"] }), "members.0.name");
  await expectField("a member that is a string (relationship)", valid({ members: ["K. Meena"] }), "members.0.relationship");
  await expectField("member name blank", valid({ members: [member({ name: "" })] }), "members.0.name");
  await expectField("member name missing", valid({ members: [without(member(), "name")] }), "members.0.name");
  await expectField("member name one character", valid({ members: [member({ name: "அ" })] }), "members.0.name");
  await expectField("member name as an array", valid({ members: [member({ name: ["K. Meena"] })] }), "members.0.name");
  const member120 = uniqueName("member name 120");
  await expectSaved("member name of 120 Tamil characters", valid({ name: member120, members: [member({ name: TA.repeat(120) })] }));
  check(Array.from(storedMembers(stored(member120)?.id ?? 0)[0]?.name ?? "").length === 120, "the 120-character member name is stored whole");
  await expectField("member name of 121 Tamil characters", valid({ members: [member({ name: TA.repeat(121) })] }), "members.0.name");
  await expectField("the second member's name", valid({ members: [member(), member({ name: "x" })] }), "members.1.name");
  await expectField("relationship missing", valid({ members: [without(member(), "relationship")] }), "members.0.relationship");
  await expectField("relationship wife (not a key)", valid({ members: [member({ relationship: "wife" })] }), "members.0.relationship");
  await expectField("relationship husband (not a key)", valid({ members: [member({ relationship: "husband" })] }), "members.0.relationship");
  await expectField("relationship SON in capitals", valid({ members: [member({ relationship: "SON" })] }), "members.0.relationship");
  await expectField("relationship as an array", valid({ members: [member({ relationship: ["son"] })] }), "members.0.relationship");
  const everyKey = ["spouse", "son", "daughter", "father", "mother", "brother", "sister", "grandfather", "grandmother", "grandson",
    "granddaughter", "son_in_law", "daughter_in_law", "father_in_law", "mother_in_law", "other_relative", "other"];
  const keysName = uniqueName("every relationship");
  await expectSaved("every relationship key on the list", valid({ name: keysName, members: everyKey.map((k, i) => member({ name: `Relative ${i + 1}`, relationship: k, age: null })) }));
  check(storedMembers(stored(keysName)?.id ?? 0).map((m) => m.relationship).join(",") === everyKey.join(","), "all seventeen relationship keys are stored as sent");

  section("1g. member age");
  for (const [label, age, expected] of [["0", 0, "0"], ["120", 120, "120"], ['"12"', "12", "12"], ["null", null, null], ['""', "", null]]) {
    const n = uniqueName(`age ${label}`);
    await expectSaved(`age ${label}`, valid({ name: n, members: [member({ age })] }));
    const got = storedMembers(stored(n)?.id ?? 0)[0]?.age;
    check((got === null ? null : String(got)) === expected, `age ${label} is stored as ${expected}`, JSON.stringify(got));
  }
  const noAge = uniqueName("age missing");
  await expectSaved("age missing", valid({ name: noAge, members: [without(member(), "age")] }));
  for (const [label, age] of [["-1", -1], ["121", 121], ['"abc"', "abc"], ["12.5", 12.5], ["true", true], ["[12]", [12]], ['"-3"', "-3"]]) {
    await expectField(`age ${label}`, valid({ members: [member({ age })] }), "members.0.age");
  }

  section("1h. gender is not a field");
  const genderName = uniqueName("gender ignored");
  await expectSaved("a gender key on the registrant and a member is ignored", valid({ name: genderName, gender: "female", members: [member({ gender: "male" })] }));
  const genderColumns = one("SELECT COUNT(*) AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('devotees', 'devotee_family_members') AND COLUMN_NAME = 'gender'");
  check(Number(genderColumns.c) === 0 && Boolean(stored(genderName)), "nothing stores a gender");

  section("1i. address");
  await expectField("address1 missing", without(valid(), "address1"), "address1");
  await expectField("address1 one character", valid({ address1: "1" }), "address1");
  await expectField("address1 as an array", valid({ address1: ["12 North Street"] }), "address1");
  await expectSaved("address1 of 180 Tamil characters", valid({ address1: TA.repeat(180) }));
  await expectField("address1 of 181 characters", valid({ address1: TA.repeat(181) }), "address1");
  await expectSaved("address2 of 180 characters", valid({ address2: TA.repeat(180) }));
  await expectField("address2 of 181 characters", valid({ address2: TA.repeat(181) }), "address2");
  await expectField("address2 as an object", valid({ address2: { area: "x" } }), "address2");
  await expectField("city missing", without(valid(), "city"), "city");
  await expectField("city one character", valid({ city: "அ" }), "city");
  await expectSaved("city of 120 Tamil characters", valid({ city: TA.repeat(120) }));
  await expectField("city of 121 characters", valid({ city: TA.repeat(121) }), "city");
  await expectField("country missing", without(valid(), "country"), "country");
  await expectField("country written India", valid({ country: "India" }), "country");
  await expectField("country as an array", valid({ country: ["IN"] }), "country");
  const lowerCountry = uniqueName("country lowercase");
  await expectSaved("country in lowercase", valid({ name: lowerCountry, country: "in" }));
  check(stored(lowerCountry)?.country === "IN", "the country is stored as its uppercase code");

  section("1j. state: required where the form has a list");
  await expectField("India with no state", valid({ state: "" }), "state");
  await expectField("the United Kingdom (listed) with no state", valid({ country: "GB", state: "", postcode: "" }), "state");
  const singapore = uniqueName("state unlisted blank");
  await expectSaved("Singapore (no list) with no state", valid({ name: singapore, country: "SG", state: "", postcode: "", phone: "+65 6123 4567", phoneCountry: "SG" }));
  check(stored(singapore)?.state === null, "an unlisted country with no state stores NULL");
  const freeText = uniqueName("state free text");
  await expectSaved("Singapore with a free-text region", valid({ name: freeText, country: "SG", state: "Central Region", postcode: "" }));
  check(stored(freeText)?.state === "Central Region", "free text is stored for an unlisted country");
  await expectField("state of 121 characters", valid({ country: "SG", state: TA.repeat(121), postcode: "" }), "state");
  await expectField("state as an array", valid({ state: ["TN"] }), "state");

  section("1k. postal code: a 6-digit PIN for India, optional elsewhere");
  await expectField("India with no PIN", without(valid(), "postcode"), "postcode");
  await expectField("India with a blank PIN", valid({ postcode: "" }), "postcode");
  await expectField("India with five digits", valid({ postcode: "62771" }), "postcode");
  await expectField("India with seven digits", valid({ postcode: "6277190" }), "postcode");
  await expectField("India with a PIN starting 0", valid({ postcode: "027719" }), "postcode");
  await expectField("India with a letter in the PIN", valid({ postcode: "62771a" }), "postcode");
  await expectField("India with the PIN as an array", valid({ postcode: ["627719"] }), "postcode");
  const spacedPin = uniqueName("pin with space");
  await expectSaved("India with the PIN typed 627 719", valid({ name: spacedPin, postcode: "627 719" }));
  check(stored(spacedPin)?.postcode === "627719", "the PIN is stored without its space", stored(spacedPin)?.postcode);
  const abroadNoCode = uniqueName("abroad no postcode");
  await expectSaved("Singapore with no postal code", without(valid({ name: abroadNoCode, country: "SG", state: "" }), "postcode"));
  check(stored(abroadNoCode)?.postcode === null, "no postal code abroad stores NULL");
  const ukCode = uniqueName("uk postcode");
  await expectSaved("the United Kingdom with SW1A 1AA", valid({ name: ukCode, country: "GB", state: "ENG", postcode: "SW1A 1AA" }));
  check(stored(ukCode)?.postcode === "SW1A 1AA", "a foreign postcode is stored as typed", stored(ukCode)?.postcode);
  await expectField("a foreign postcode of 21 characters", valid({ country: "SG", state: "", postcode: "1".repeat(21) }), "postcode");
  await expectField("a foreign postcode starting with a hyphen", valid({ country: "SG", state: "", postcode: "-12345" }), "postcode");
  await expectField("a foreign postcode with a #", valid({ country: "SG", state: "", postcode: "12#45" }), "postcode");

  section("1l. bodies that are not a registration");
  for (const [label, raw] of [["a JSON array", "[1,2,3]"], ["not JSON", "name=E2E"], ["null", "null"], ["a JSON string", '"hello"']]) {
    const r = await send("POST", raw, { raw: true });
    check(r.status === 422 && r.json?.fields?.name && r.json?.fields?.phone && r.json?.fields?.address1, `a body that is ${label} → 422 naming every required field`, `${r.status} ${r.text.slice(0, 200)}`);
  }

  /* ── 2. What a registration stores ───────────────────────────────────── */
  section("2. stored values");
  const full = uniqueName("Full");
  const fullPhone = nextPhone();
  const before = one("SELECT UTC_TIMESTAMP() AS now").now;
  await expectSaved("a complete registration", valid({
    name: full, dateOfBirth: "1978-04-21", phone: fullPhone, lang: "en", consent: true,
    members: [member({ name: "K. Meena", relationship: "spouse", age: 41 }), member({ name: "K. Arun", relationship: "son", age: null })],
    address2: "Near the temple tank",
  }));
  const f = stored(full);
  check(f?.lang === "en", "lang is stored", f?.lang);
  check(f?.date_of_birth === "1978-04-21", "date_of_birth is stored", f?.date_of_birth);
  check(f?.phone === digitsOf(fullPhone) && f?.phone_country === "IN", "the phone is stored as E.164 digits with its country", `${f?.phone} ${f?.phone_country}`);
  check(f?.email === null && f?.pass_hash === null, "email and pass_hash are NULL");
  check(f?.updates_consent_at !== null && f.updates_consent_at >= before && f?.updates_consent_by === null, "consent is timestamped in UTC, recorded as the form's", `${f?.updates_consent_at} by ${f?.updates_consent_by} (before ${before})`);
  check(f?.unsubscribed_at === null && Number(f?.is_active) === 1 && f?.duplicate_of === null, "a new family is active, subscribed and not a duplicate");
  check(f?.address2 === "Near the temple tank" && f?.state === "TN" && f?.country === "IN" && f?.postcode === "627719", "the address is stored");
  const fm = storedMembers(f?.id ?? 0);
  check(fm.length === 2 && fm[0].name === "K. Meena" && fm[0].relationship === "spouse" && Number(fm[0].age) === 41 && Number(fm[0].sort_order) === 0
    && fm[1].name === "K. Arun" && fm[1].age === null && Number(fm[1].sort_order) === 1, "members are stored with relationship, age and sort_order", JSON.stringify(fm));
  for (const [label, consent, expected] of [["false", false, false], ['"yes"', "yes", false], ['"1"', "1", true], ["1", 1, true], ['"true"', "true", true], ["[true]", [true], false]]) {
    const n = uniqueName(`consent ${label}`);
    await expectSaved(`consent ${label}`, valid({ name: n, consent }));
    check((stored(n)?.updates_consent_at !== null) === expected, `consent ${label} ${expected ? "records" : "does not record"} consent`);
  }

  /* ── 3. Duplicates ───────────────────────────────────────────────────── */
  section("3. a phone number already registered");
  const dupPhone = nextPhone();
  const first = uniqueName("dup first");
  const newReply = await send("POST", valid({ name: first, phone: dupPhone }));
  const second = uniqueName("dup second");
  const dupReply = await send("POST", valid({ name: second, phone: dupPhone }));
  const third = uniqueName("dup third national");
  await send("POST", valid({ name: third, phone: digitsOf(dupPhone).slice(2) }));
  const [a, b, c] = [stored(first), stored(second), stored(third)];
  check(newReply.status === 201 && dupReply.status === 201 && newReply.text === SUCCESS && dupReply.text === SUCCESS, "the duplicate answers exactly like the new family", `${newReply.text} | ${dupReply.text}`);
  check(newReply.headers.get("content-type") === dupReply.headers.get("content-type"), "with the same content type");
  check(a && b && b.duplicate_of === a.id && a.duplicate_of === null, "the second registration is saved and flagged as a duplicate of the first", `${a?.id} ${b?.duplicate_of}`);
  check(c && c.duplicate_of === a.id, "the same number typed without +91 is flagged against the earliest", `${c?.duplicate_of}`);
  const legacyDigits = digitsOf(nextPhone()).slice(2);
  const legacyName = uniqueName("legacy ten digits");
  sql("INSERT INTO devotees (name, phone, phone_country, country, city, is_active) VALUES (?, ?, NULL, 'IN', 'Pudupatti', 1)", [legacyName, legacyDigits]);
  const legacy = stored(legacyName);
  const afterLegacy = uniqueName("after legacy");
  await expectSaved("a registration matching a legacy ten-digit row", valid({ name: afterLegacy, phone: `+91${legacyDigits}` }));
  check(stored(afterLegacy)?.duplicate_of === legacy?.id, "it is flagged against the legacy row", `${stored(afterLegacy)?.duplicate_of} vs ${legacy?.id}`);

  /* ── 4. Honeypot ─────────────────────────────────────────────────────── */
  section("4. the honeypot");
  const honeyIp = "10.80.0.95";
  const honeyName = uniqueName("honeypot");
  const honeyEmail = `e2e-reg-honey-${RUN}@example.test`;
  const honeyPhone = nextPhone();
  const honey = await send("POST", valid({ name: honeyName, email: honeyEmail, phone: honeyPhone, consent: true, members: [member()], hp_token: "http://spam.example" }), { ip: honeyIp });
  check(honey.status === 201 && honey.text === SUCCESS && honey.text === newReply.text, "a honeypot hit answers exactly like a real registration", `${honey.status} ${honey.text}`);
  check(honey.headers.get("content-type") === newReply.headers.get("content-type"), "with the same content type");
  check(!stored(honeyName), "and saves nothing");
  const honeyMessages = one("SELECT COUNT(*) AS c FROM notifications WHERE to_email = ? OR to_phone = ?", [honeyEmail, digitsOf(honeyPhone)]);
  check(Number(honeyMessages.c) === 0, "and sends nothing");
  const honeyBuckets = rows("SELECT bucket, hits FROM rate_limits WHERE bucket IN (?, ?)", [`registration-attempt:${honeyIp}`, `registration-saved:${honeyIp}`]);
  check(honeyBuckets.length === 1 && honeyBuckets[0].bucket.startsWith("registration-attempt") && Number(honeyBuckets[0].hits) === 1,
    "and counts as an attempt, not a save", JSON.stringify(honeyBuckets));
  const blankHoney = uniqueName("honeypot whitespace");
  await send("POST", valid({ name: blankHoney, hp_token: "   " }), { ip: honeyIp });
  check(Boolean(stored(blankHoney)), "a whitespace-only honeypot is a person, and is saved");

  /* ── 5. Limits ───────────────────────────────────────────────────────── */
  const is429 = (res) => {
    const ra = Number(res.headers.get("retry-after"));
    return res.status === 429 && Number.isInteger(ra) && ra > 0
      && res.json?.error === "Too many requests. Please try again later." && res.json?.code === "rate_limited" && res.json?.retryAfter === ra;
  };
  section("5a. attempts: 15 an hour per address");
  const attemptIp = "10.80.0.90";
  let codes = [];
  for (let i = 0; i < 15; i++) codes.push((await send("POST", valid({ name: "" }), { ip: attemptIp })).status);
  check(codes.every((s) => s === 422), "15 invalid posts are answered 422", codes.join(","));
  let r = await send("POST", valid({ name: "" }), { ip: attemptIp });
  check(is429(r), "the 16th is refused with 429, Retry-After and the standard body", `${r.status} ${r.headers.get("retry-after")} ${r.text}`);
  const overAttempt = uniqueName("over attempts");
  r = await send("POST", valid({ name: overAttempt }), { ip: attemptIp });
  check(is429(r) && !stored(overAttempt), "a valid registration from that address is refused too, and not saved");
  r = await send("POST", valid({ hp_token: "bot" }), { ip: attemptIp });
  check(is429(r), "a honeypot hit is limited as well: the attempt is counted before the honeypot is read");

  section("5b. saves: 10 an hour per address");
  const saveIp = "10.80.0.91";
  codes = [];
  for (let i = 0; i < 10; i++) codes.push((await send("POST", valid({ name: uniqueName("limit save") }), { ip: saveIp })).status);
  check(codes.every((s) => s === 201), "10 valid registrations from one address are saved", codes.join(","));
  const overSave = uniqueName("over saves");
  r = await send("POST", valid({ name: overSave }), { ip: saveIp });
  check(is429(r), "the 11th is refused with 429", `${r.status} ${r.text}`);
  check(!stored(overSave), "and is not saved");
  r = await send("POST", valid({ name: "" }), { ip: saveIp });
  check(r.status === 422, "an invalid post from that address still gets its field errors (attempts remain)", `${r.status}`);

  section("5c. invalid posts count as attempts, not saves");
  const countIp = "10.80.0.92";
  for (let i = 0; i < 3; i++) await send("POST", valid({ city: "" }), { ip: countIp });
  const att = one("SELECT hits FROM rate_limits WHERE bucket = ?", [`registration-attempt:${countIp}`])?.hits;
  const sav = one("SELECT hits FROM rate_limits WHERE bucket = ?", [`registration-saved:${countIp}`])?.hits;
  check(Number(att) === 3 && sav === undefined, "three invalid posts: three attempts, no saves", `attempts ${att} saved ${sav}`);
  await send("POST", valid({ name: uniqueName("after invalid") }), { ip: countIp });
  const sav2 = one("SELECT hits FROM rate_limits WHERE bucket = ?", [`registration-saved:${countIp}`])?.hits;
  check(Number(sav2) === 1, "the next valid one counts one save", `saved ${sav2}`);

  section("5d. one address's limit is not another's");
  const otherIp = "10.80.0.93";
  const isolated = uniqueName("other address");
  r = await send("POST", valid({ name: isolated }), { ip: otherIp });
  check(r.status === 201 && Boolean(stored(isolated)), "a different address registers while two others are limited", `${r.status} ${r.text}`);

  /* ── 6. Methods and cookies ──────────────────────────────────────────── */
  section("6. methods, content type and cookies");
  const methodIp = "10.80.0.94";
  for (const m of ["GET", "PUT", "DELETE", "PATCH"]) {
    r = await send(m, m === "GET" ? undefined : {}, { ip: methodIp });
    check(r.status === 405 && r.json?.error === "Method not allowed", `${m} → 405 Method not allowed`, `${r.status} ${r.text}`);
  }
  const noSpend = one("SELECT hits FROM rate_limits WHERE bucket = ?", [`registration-attempt:${methodIp}`]);
  check(noSpend === null, "a wrong method spends no attempt");
  check(/^application\/json/.test(newReply.headers.get("content-type") || ""), "answers are JSON", newReply.headers.get("content-type"));
  check(cookies.length === 0, "no response set a cookie", cookies.slice(0, 3).join(" | "));

  /* ── 7. Confirmation message ─────────────────────────────────────────── */
  // The message is the notification service's to send, and the registration
  // must never depend on it: whatever state that service is in (not installed,
  // failing to load, or working), a consenting family is registered all the
  // same. Whether the message itself was queued is asserted only when asked
  // (NOTIFY_ASSERT_MESSAGES=1) and the service reports itself ready, and — when
  // NOTIFY_READY_FILE is set — once that hand-off marker exists.
  section("7. registration.received");
  const serviceReady = (() => {
    try {
      const out = php(["-r", "require 'backend/includes/devotee_notify.php'; echo devoteeNotifyReady() ? 'ready' : 'unavailable';"]);
      return out.trim().split("\n").pop() === "ready";
    } catch {
      return false;
    }
  })();
  console.log(`  the notification service is ${serviceReady ? "ready" : "unavailable"}`);

  const consenting = uniqueName("consent message");
  const cr = await send("POST", valid({ name: consenting, email: `e2e-reg-yes-${RUN}@example.test`, consent: true, members: [member(), member({ name: "K. Arun", relationship: "son" })] }));
  const cRow = stored(consenting);
  check(cr.status === 201 && cr.text === SUCCESS && cRow && cRow.updates_consent_at !== null && storedMembers(cRow.id).length === 2,
    `a consenting family of three is registered with the service ${serviceReady ? "ready" : "unavailable"}`, `${cr.status} ${cr.text}`);
  const alone = uniqueName("consent alone");
  const ar = await send("POST", valid({ name: alone, consent: true }));
  check(ar.status === 201 && ar.text === SUCCESS && Boolean(stored(alone)), "a consenting registrant with no members is registered too", `${ar.status} ${ar.text}`);
  const declining = uniqueName("no consent message");
  const dr = await send("POST", valid({ name: declining, email: `e2e-reg-no-${RUN}@example.test`, members: [member()] }));
  check(dr.status === 201 && dr.text === SUCCESS && Boolean(stored(declining)), "a family that did not tick consent is registered", `${dr.status} ${dr.text}`);

  const readyFile = process.env.NOTIFY_READY_FILE;
  const assertMessages = process.env.NOTIFY_ASSERT_MESSAGES === "1" && serviceReady && !(readyFile && !existsSync(readyFile));
  if (!assertMessages) {
    skipped += 3;
    console.log("- skipped 3 checks on the queued registration.received notification (set NOTIFY_ASSERT_MESSAGES=1 once the notification service loads)");
  } else {
    const messagesFor = (id) => rows("SELECT event, template_key, JSON_UNQUOTE(JSON_EXTRACT(vars, '$.familyCount')) AS family_count FROM notifications WHERE devotee_id = ?", [id]);
    const cm = messagesFor(cRow?.id ?? 0);
    check(cm.length === 1 && cm[0].event === "registration.received" && cm[0].template_key === "registration_received" && Number(cm[0].family_count) === 3,
      "the consenting family of three has one registration.received notification with familyCount 3", JSON.stringify(cm));
    const am = messagesFor(stored(alone)?.id ?? 0);
    check(am.length === 1 && Number(am[0].family_count) === 1, "the registrant alone has it with familyCount 1", JSON.stringify(am));
    check(messagesFor(stored(declining)?.id ?? 0).length === 0, "the family without consent has none");
  }

  check(serverErrors.length === 0, "no request answered 5xx", serverErrors.slice(0, 3).join(" | "));
} catch (e) {
  check(false, "the suite ran to the end", e.stack || String(e));
} finally {
  try {
    cleanup();
    const left = one("SELECT (SELECT COUNT(*) FROM devotees WHERE name LIKE ?) + (SELECT COUNT(*) FROM rate_limits WHERE bucket REGEXP ?) AS c", ["E2E-REG-API-%", BUCKETS_REGEXP]).c;
    check(Number(left) === 0, "cleanup removed every registration and bucket this suite created", `${left} left`);
  } catch (e) {
    check(false, "cleanup ran", e.message);
  }
}

console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail ? 1 : 0);
