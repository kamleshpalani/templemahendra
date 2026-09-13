/**
 * familyRegistration.js — the rules and shapes behind the multi-step family
 * registration (pages/Register.jsx). docs/registration/SPEC.md §4, §5 and §7.1.
 *
 * backend/includes/registration.php applies the same rules again when the form
 * is posted. This copy exists so a family learns what to fix on the step they
 * are on, not after pressing Submit on the last one, and its messages match the
 * server's so both read the same. Lengths are counted in characters the way
 * PHP's mb_strlen counts them (code points), so a Tamil name that fits here
 * fits there.
 */

import { COUNTRIES, DEFAULT_COUNTRY } from "../data/countries";
import { countryOf, hasSubdivisions, phoneProblem, subdivisionLabel, toE164 } from "./phone";

/** The four steps, in order. Labels and headings are [Tamil, English]. */
export const STEPS = [
  { key: "personal", label: ["தனிப்பட்ட விவரம்", "Personal"], heading: ["உங்கள் விவரங்கள்", "Your details"] },
  { key: "family", label: ["குடும்பம்", "Family"], heading: ["குடும்ப உறுப்பினர்கள்", "Family members"] },
  { key: "address", label: ["முகவரி", "Address"], heading: ["வீட்டு முகவரி", "Home address"] },
  { key: "review", label: ["சரிபார்த்தல்", "Review"], heading: ["சரிபார்த்துச் சமர்ப்பிக்கவும்", "Review and submit"] },
];
export const STEP_KEYS = STEPS.map((s) => s.key);

/** The steps that hold fields. Review only shows what they hold. */
export const FORM_STEPS = ["personal", "family", "address"];

/**
 * Relationship to the registrant, in the order of the <select>. Must match
 * REG_RELATIONSHIPS in backend/includes/registration.php exactly (SPEC §4).
 * One "spouse" rather than wife and husband: the form asks no gender.
 */
export const RELATIONSHIPS = [
  { value: "spouse", ta: "வாழ்க்கைத் துணை (மனைவி / கணவர்)", en: "Spouse (wife / husband)" },
  { value: "son", ta: "மகன்", en: "Son" },
  { value: "daughter", ta: "மகள்", en: "Daughter" },
  { value: "father", ta: "தந்தை", en: "Father" },
  { value: "mother", ta: "தாய்", en: "Mother" },
  { value: "brother", ta: "சகோதரர்", en: "Brother" },
  { value: "sister", ta: "சகோதரி", en: "Sister" },
  { value: "grandfather", ta: "தாத்தா", en: "Grandfather" },
  { value: "grandmother", ta: "பாட்டி", en: "Grandmother" },
  { value: "grandson", ta: "பேரன்", en: "Grandson" },
  { value: "granddaughter", ta: "பேத்தி", en: "Granddaughter" },
  { value: "son_in_law", ta: "மருமகன்", en: "Son-in-law" },
  { value: "daughter_in_law", ta: "மருமகள்", en: "Daughter-in-law" },
  { value: "father_in_law", ta: "மாமனார்", en: "Father-in-law" },
  { value: "mother_in_law", ta: "மாமியார்", en: "Mother-in-law" },
  { value: "other_relative", ta: "பிற உறவினர்", en: "Other relative" },
  { value: "other", ta: "மற்றவர்", en: "Other" },
];

/** [min, max] characters per text field (min 0 = optional). Mirrors REG_LENGTHS. */
export const LIMITS = {
  name: [2, 200],
  email: [0, 190],
  address1: [2, 180],
  address2: [0, 180],
  city: [2, 120],
  state: [0, 120],
  postcode: [0, 20],
  memberName: [2, 120],
  maxMembers: 20,
  maxAge: 120,
};

const RELATIONSHIP_BY_VALUE = new Map(RELATIONSHIPS.map((r) => [r.value, r]));
const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.iso2));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PERSONAL_KEYS = new Set(["name", "phone", "email", "dateOfBirth", "lang"]);
const ADDRESS_KEYS = new Set(["address1", "address2", "city", "state", "country", "postcode"]);
const MEMBER_ERROR_RE = /^members\.(\d+)\.(name|relationship|age)$/;

/** Characters as the server counts them: code points, after trimming. */
export const charCount = (value) => Array.from(String(value ?? "").trim()).length;

/** Which step a top-level form field lives on, or null for consent and the honeypot. */
export function stepOfField(name) {
  if (PERSONAL_KEYS.has(name)) return "personal";
  if (ADDRESS_KEYS.has(name)) return "address";
  return null;
}

/* ── Dates ──────────────────────────────────────────────────────────────── */

/**
 * Today where the temple is, as YYYY-MM-DD. The server compares a date of birth
 * with the temple's today, so a family registering just after midnight in India
 * is judged on the same day here.
 */
export function templeToday(now = new Date()) {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** True for a real calendar date written YYYY-MM-DD ("2023-02-30" is not one). */
export function isRealDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The earliest date of birth accepted: LIMITS.maxAge years before today. */
export function earliestBirthDate(today = templeToday()) {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y - LIMITS.maxAge, m - 1, d)).toISOString().slice(0, 10);
}

/** Age in whole years on the temple's today, or null when there is no usable date. */
export function ageFrom(dateOfBirth, today = templeToday()) {
  if (!isRealDate(dateOfBirth) || dateOfBirth > today) return null;
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** "21 ஏப்ரல் 1978" / "21 April 1978". */
export function formatBirthDate(ymd, lang) {
  if (!isRealDate(ymd)) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/* ── Shapes ─────────────────────────────────────────────────────────────── */

/** A blank family member card. `key` is stable for the card's life, never an index. */
export const emptyMember = (key) => ({ key, name: "", relationship: "", age: "" });

/** A card the family added and then left completely empty. */
export const isBlankMember = (m) => !String(m.name ?? "").trim() && !m.relationship && !String(m.age ?? "").trim();

export function relationshipLabel(value, t) {
  const r = RELATIONSHIP_BY_VALUE.get(value);
  return r ? t(r.ta, r.en) : value;
}

/** A fresh form. India by default: where the temple is and most devotees live. */
export function initialForm(lang) {
  return {
    name: "",
    phone: "",
    phoneCountry: DEFAULT_COUNTRY,
    email: "",
    dateOfBirth: "",
    lang: lang === "en" ? "en" : "ta",
    members: [],
    address1: "",
    address2: "",
    city: "",
    state: "",
    country: DEFAULT_COUNTRY,
    postcode: "",
    consent: false,
    hp_token: "",
  };
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/** The length problem with a text value, or "". `what` is {ta, en} naming the field in a sentence. */
function lengthProblem(value, [min, max], t, missing, what) {
  const n = charCount(value);
  if (n === 0) return min > 0 ? missing : "";
  if (n < min) return t(`${what.ta} குறைந்தது ${min} எழுத்துகள் இருக்க வேண்டும்.`, `${what.en} must be at least ${min} characters.`);
  if (n > max) return t(`${what.ta} அதிகபட்சம் ${max} எழுத்துகள் மட்டுமே இருக்கலாம்.`, `${what.en} must be at most ${max} characters.`);
  return "";
}

function validatePersonal(form, t) {
  const e = {};
  const name = lengthProblem(
    form.name,
    LIMITS.name,
    t,
    t("உங்கள் பெயரை உள்ளிடவும்.", "Please enter your name."),
    { ta: "பெயரில்", en: "The name" },
  );
  if (name) e.name = name;

  // Judged by the chosen country's own number length, not one country's rule.
  const phone = phoneProblem(form.phone, form.phoneCountry, { required: true, t });
  if (phone) e.phone = phone;

  const email = String(form.email ?? "").trim();
  if (email) {
    if (charCount(email) > LIMITS.email[1]) {
      e.email = t(
        `மின்னஞ்சல் முகவரியில் அதிகபட்சம் ${LIMITS.email[1]} எழுத்துகள் மட்டுமே இருக்கலாம்.`,
        `The email address must be at most ${LIMITS.email[1]} characters.`,
      );
    } else if (!EMAIL_RE.test(email)) {
      e.email = t(
        "சரியான மின்னஞ்சல் முகவரியை உள்ளிடவும், அல்லது காலியாக விடவும்.",
        "Enter a valid email address, or leave it blank.",
      );
    }
  }

  const dob = String(form.dateOfBirth ?? "").trim();
  if (dob) {
    const today = templeToday();
    if (!isRealDate(dob)) {
      e.dateOfBirth = t("சரியான பிறந்த தேதியை உள்ளிடவும், அல்லது காலியாக விடவும்.", "Enter a real date of birth, or leave it blank.");
    } else if (dob > today) {
      e.dateOfBirth = t("பிறந்த தேதி எதிர்காலத்தில் இருக்க முடியாது.", "The date of birth cannot be in the future.");
    } else if (dob < earliestBirthDate(today)) {
      e.dateOfBirth = t(
        `பிறந்த தேதி ${LIMITS.maxAge} ஆண்டுகளுக்கு முந்தையதாக இருக்க முடியாது.`,
        `The date of birth cannot be more than ${LIMITS.maxAge} years ago.`,
      );
    }
  }

  if (form.lang !== "ta" && form.lang !== "en") {
    e.lang = t("தமிழ் அல்லது ஆங்கிலத்தைத் தேர்ந்தெடுக்கவும்.", "Choose Tamil or English.");
  }
  return e;
}

function validateFamily(form, t) {
  const e = {};
  const members = form.members.filter((m) => !isBlankMember(m));
  if (members.length > LIMITS.maxMembers) {
    e.members = t(
      `ஒரு பதிவில் அதிகபட்சம் ${LIMITS.maxMembers} உறுப்பினர்களைச் சேர்க்கலாம்.`,
      `A registration can list at most ${LIMITS.maxMembers} family members.`,
    );
  }
  for (const m of members) {
    const name = lengthProblem(
      m.name,
      LIMITS.memberName,
      t,
      t("இந்த உறுப்பினரின் பெயரை உள்ளிடவும்.", "Please enter this family member's name."),
      { ta: "உறுப்பினர் பெயரில்", en: "The member's name" },
    );
    if (name) e[`members.${m.key}.name`] = name;
    if (!RELATIONSHIP_BY_VALUE.has(m.relationship)) {
      e[`members.${m.key}.relationship`] = t(
        "இவர் உங்களுக்கு என்ன உறவு என்பதைத் தேர்ந்தெடுக்கவும்.",
        "Choose how this person is related to you.",
      );
    }
    const age = String(m.age ?? "").trim();
    if (age && (!/^\d{1,3}$/.test(age) || Number(age) > LIMITS.maxAge)) {
      e[`members.${m.key}.age`] = t(
        `வயதை 0 முதல் ${LIMITS.maxAge} வரையிலான முழு எண்ணாக உள்ளிடவும், அல்லது காலியாக விடவும்.`,
        `Enter the age as a whole number from 0 to ${LIMITS.maxAge}, or leave it blank.`,
      );
    }
  }
  return e;
}

function validateAddress(form, t) {
  const e = {};
  const address1 = lengthProblem(
    form.address1,
    LIMITS.address1,
    t,
    t("வீட்டு எண் மற்றும் தெருவை உள்ளிடவும்.", "Please enter the house number and street."),
    { ta: "முகவரியில்", en: "Address line 1" },
  );
  if (address1) e.address1 = address1;

  const address2 = lengthProblem(form.address2, LIMITS.address2, t, "", { ta: "பகுதி / அடையாளத்தில்", en: "The area or landmark" });
  if (address2) e.address2 = address2;

  const city = lengthProblem(
    form.city,
    LIMITS.city,
    t,
    t("நகரம் அல்லது ஊரை உள்ளிடவும்.", "Please enter the city or town."),
    { ta: "நகரப் பெயரில்", en: "The city or town" },
  );
  if (city) e.city = city;

  if (!COUNTRY_CODES.has(form.country)) e.country = t("நாட்டைத் தேர்ந்தெடுக்கவும்.", "Please choose a country.");

  const state = String(form.state ?? "").trim();
  if (hasSubdivisions(form.country) && !state) {
    e.state = t(
      "பட்டியலிலிருந்து தேர்ந்தெடுக்கவும்.",
      `Please choose your ${subdivisionLabel(form.country, (ta, en) => en).toLowerCase()}.`,
    );
  } else {
    const stateLength = lengthProblem(state, LIMITS.state, t, "", { ta: "மாநிலப் பெயரில்", en: "The state or province" });
    if (stateLength) e.state = stateLength;
  }

  // India Post delivers by PIN, so an Indian address needs one; many countries
  // have no postal code at all, so elsewhere only its shape is checked.
  if (form.country === "IN") {
    const pin = String(form.postcode ?? "").replace(/\s+/g, "");
    if (!pin) {
      e.postcode = t("6 இலக்க PIN குறியீட்டை உள்ளிடவும்.", "Please enter the 6-digit PIN code.");
    } else if (!/^[1-9]\d{5}$/.test(pin)) {
      e.postcode = t("PIN குறியீடு 6 இலக்கங்கள் கொண்டது; 0-வில் தொடங்காது.", "A PIN code is 6 digits and does not start with 0.");
    }
  } else {
    const postcode = String(form.postcode ?? "").trim();
    if (charCount(postcode) > LIMITS.postcode[1]) {
      e.postcode = t(
        `அஞ்சல் குறியீட்டில் அதிகபட்சம் ${LIMITS.postcode[1]} எழுத்துகள் மட்டுமே இருக்கலாம்.`,
        `The postal code must be at most ${LIMITS.postcode[1]} characters.`,
      );
    } else if (postcode && !/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(postcode)) {
      e.postcode = t(
        "அஞ்சல் குறியீட்டில் எழுத்துகள், எண்கள், இடைவெளி, இணைப்புக்குறி மட்டுமே இருக்கலாம்.",
        "The postal code can contain only letters, digits, spaces and hyphens.",
      );
    }
  }
  return e;
}

/** Problems on one step as { errorKey: message }. Review has none of its own. */
export function validateStep(step, form, t) {
  if (step === "personal") return validatePersonal(form, t);
  if (step === "family") return validateFamily(form, t);
  if (step === "address") return validateAddress(form, t);
  return {};
}

/** Problems on every form step: { personal, family, address }. */
export function validateAll(form, t) {
  return Object.fromEntries(FORM_STEPS.map((step) => [step, validateStep(step, form, t)]));
}

/* ── Error summary ──────────────────────────────────────────────────────── */

/** The id of the control an error belongs to, for the summary's links. */
export function fieldIdFor(errorKey) {
  const member = MEMBER_ERROR_RE.exec(errorKey);
  if (member) return `reg-member-${member[1]}-${member[2]}`;
  return (
    {
      name: "reg-name",
      phone: "reg-phone",
      email: "reg-email",
      dateOfBirth: "reg-dob",
      lang: "reg-lang-ta",
      members: "reg-add-member",
      address1: "reg-address1",
      address2: "reg-address2",
      city: "reg-city",
      state: "reg-state",
      country: "reg-country",
      postcode: "reg-postcode",
    }[errorKey] ?? null
  );
}

/** How the summary names the field an error belongs to. */
export function fieldLabel(errorKey, form, t) {
  const member = MEMBER_ERROR_RE.exec(errorKey);
  if (member) {
    const n = form.members.findIndex((m) => String(m.key) === member[1]) + 1;
    const part = { name: t("பெயர்", "Name"), relationship: t("உறவு முறை", "Relationship"), age: t("வயது", "Age") }[member[2]];
    return `${t(`உறுப்பினர் ${n}`, `Member ${n}`)} — ${part}`;
  }
  switch (errorKey) {
    case "name":
      return t("முழுப் பெயர்", "Full name");
    case "phone":
      return t("தொலைபேசி", "Phone");
    case "email":
      return t("மின்னஞ்சல்", "Email");
    case "dateOfBirth":
      return t("பிறந்த தேதி", "Date of birth");
    case "lang":
      return t("விருப்ப மொழி", "Preferred language");
    case "members":
      return t("குடும்ப உறுப்பினர்கள்", "Family members");
    case "address1":
      return t("வீட்டு எண், தெரு", "House number and street");
    case "address2":
      return t("பகுதி / அடையாளம்", "Area or landmark");
    case "city":
      return t("நகரம் / ஊர்", "City or town");
    case "state":
      return subdivisionLabel(form.country, t);
    case "country":
      return t("நாடு", "Country");
    case "postcode":
      return form.country === "IN" ? t("PIN குறியீடு", "PIN code") : t("அஞ்சல் குறியீடு", "Postal code");
    default:
      return errorKey;
  }
}

/* ── Talking to the server ──────────────────────────────────────────────── */

/** The keys of the member cards that will be sent, in the order they are sent. */
export const payloadMemberKeys = (form) => form.members.filter((m) => !isBlankMember(m)).map((m) => m.key);

/** The JSON body for POST /api/registrations (SPEC §5). */
export function toPayload(form) {
  const members = form.members.filter((m) => !isBlankMember(m));
  const email = String(form.email ?? "").trim();
  const postcode = form.country === "IN" ? String(form.postcode ?? "").replace(/\s+/g, "") : String(form.postcode ?? "").trim();
  return {
    name: form.name.trim(),
    phone: toE164(form.phone, form.phoneCountry),
    phoneCountry: form.phoneCountry,
    email: email ? email.toLowerCase() : null,
    dateOfBirth: String(form.dateOfBirth ?? "").trim() || null,
    lang: form.lang,
    members: members.map((m) => {
      const age = String(m.age ?? "").trim();
      return { name: m.name.trim(), relationship: m.relationship, age: age === "" ? null : Number(age) };
    }),
    address1: form.address1.trim(),
    address2: form.address2.trim(),
    city: form.city.trim(),
    state: String(form.state ?? "").trim(),
    country: form.country,
    postcode,
    consent: form.consent === true,
    hp_token: form.hp_token,
  };
}

/**
 * A 422's `fields` as errors grouped by step, keyed the way the form keys them
 * (the server numbers members by position in the request; the form by card).
 * Where the form's own rules also object, their wording is used, so the family
 * reads it in their language; otherwise the server's sentence is shown.
 */
export function mapServerFields(fields, memberKeys, form, t, lang) {
  const client = validateAll(form, t);
  const out = { personal: {}, family: {}, address: {} };
  for (const [key, message] of Object.entries(fields ?? {})) {
    let step = null;
    let formKey = key;
    const member = /^members\.(\d+)\.(name|relationship|age)$/.exec(key);
    if (member) {
      step = "family";
      const cardKey = memberKeys[Number(member[1])];
      formKey = cardKey === undefined ? "members" : `members.${cardKey}.${member[2]}`;
    } else if (key === "members") {
      step = "family";
    } else {
      step = stepOfField(key);
    }
    if (!step) continue;
    out[step][formKey] =
      client[step][formKey] || (lang === "ta" ? "இந்த விவரத்தைச் சரிபார்க்கவும்." : String(message || "Please check this detail."));
  }
  return out;
}

/** The country's name as the country list shows it. */
export const countryName = (iso2) => countryOf(iso2).name;
