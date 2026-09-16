/**
 * donation.js — the rules and shapes behind /donate (docs/payments/SPEC.md
 * §7.3), the way lib/familyRegistration.js sits behind /register.
 *
 * backend/includes/payments/validate.php applies every one of these rules again
 * when the form is posted; this copy exists so a donor learns what to fix on the
 * step they are on, and so the two read the same. Lengths are counted in code
 * points, as PHP's mb_strlen counts them.
 *
 * The amount is checked here only to keep a donor out of an obvious mistake.
 * What is actually charged is the amount the server stored and signed into the
 * CCAvenue request — never a number this file produced.
 */

import { COUNTRIES } from "../data/countries";
import { charCount } from "./familyRegistration";
import { phoneProblem, toE164 } from "./phone";
import { currencyDecimals, formatMoney, parseAmountInput } from "./money";

/** The three steps, in order. Labels and headings are [Tamil, English]. */
export const DONATE_STEPS = [
  { key: "purpose", label: ["நோக்கம்", "Purpose"], heading: ["நோக்கமும் தொகையும்", "Purpose and amount"] },
  { key: "details", label: ["உங்கள் விவரம்", "Your details"], heading: ["உங்கள் விவரங்கள்", "Your details"] },
  { key: "review", label: ["சரிபார்த்தல்", "Review"], heading: ["சரிபார்த்துப் பணம் செலுத்தவும்", "Review and pay"] },
];
export const DONATE_STEP_KEYS = DONATE_STEPS.map((s) => s.key);

/** The steps that hold fields the donor can get wrong before the last one. */
export const DONATE_FORM_STEPS = ["purpose", "details"];

/*
 * The half-filled form, kept for the length of the visit. It lives here rather
 * than in the page because the result page clears it: the draft survives a
 * cancelled or failed payment on purpose, so the donor can try again without
 * typing everything twice, and only a payment that actually succeeded ends it.
 */
export const DONATION_DRAFT_KEY = "temple:donation-draft";

export function clearDonationDraft() {
  try {
    sessionStorage.removeItem(DONATION_DRAFT_KEY);
  } catch {
    /* nothing was kept */
  }
}

/** [min, max] characters, mirroring the columns and payValidateDonation(). */
export const DONATION_LIMITS = {
  name: [2, 100],
  email: [0, 190],
  address: [0, 250],
  city: [0, 120],
  state: [0, 120],
  postcode: [0, 15],
  message: [0, 500],
  notes: [0, 500],
};

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.iso2));

const PURPOSE_KEYS = new Set(["category", "amount", "currency"]);
const DETAILS_KEYS = new Set([
  "name",
  "phone",
  "phoneCountry",
  "country",
  "email",
  "address",
  "city",
  "state",
  "postcode",
  "pan",
  "message",
  "notes",
  "showNamePublicly",
]);

/** Which step a field belongs to, so an edit clears its own error. */
export function stepOfDonationField(name) {
  if (PURPOSE_KEYS.has(name)) return "purpose";
  if (DETAILS_KEYS.has(name)) return "details";
  if (name === "acceptTerms") return "review";
  return null;
}

/** A fresh form. India and the gateway's default currency; nothing pre-chosen. */
export function initialDonationForm(lang, config) {
  return {
    category: "",
    amount: "",
    // "" = nothing picked yet, a number = that preset chip, "other" = typed in.
    amountChoice: "",
    currency: config?.defaultCurrency || "INR",
    name: "",
    phone: "",
    phoneCountry: "IN",
    country: "IN",
    email: "",
    address: "",
    city: "",
    state: "",
    postcode: "",
    pan: "",
    message: "",
    notes: "",
    showNamePublicly: false,
    acceptTerms: false,
    lang: lang === "en" ? "en" : "ta",
    hp_token: "",
  };
}

/* ── Validation ─────────────────────────────────────────────────────────── */

function lengthProblem(value, [min, max], t, missing, what) {
  const n = charCount(value);
  if (n === 0) return min > 0 ? missing : "";
  if (n < min) return t(`${what.ta} குறைந்தது ${min} எழுத்துகள் இருக்க வேண்டும்.`, `${what.en} must be at least ${min} characters.`);
  if (n > max) return t(`${what.ta} அதிகபட்சம் ${max} எழுத்துகள் மட்டுமே இருக்கலாம்.`, `${what.en} must be at most ${max} characters.`);
  return "";
}

/** The amount limits for the chosen currency, as numbers (SPEC §5.2). */
export function amountBounds(currency, config) {
  const inr = String(currency).toUpperCase() === "INR";
  return {
    min: inr ? Number(config?.min ?? 1) : 1,
    max: inr ? Number(config?.max ?? 500000) : Number(config?.maxForeign ?? 10000),
  };
}

function validatePurpose(form, t, config) {
  const e = {};
  const categories = config?.categories ?? [];
  if (!form.category || !categories.some((c) => c.slug === form.category)) {
    e.category = t("நன்கொடையின் நோக்கத்தைத் தேர்ந்தெடுக்கவும்.", "Please choose what your donation is for.");
  }

  const codes = (config?.currencies ?? []).map((c) => c.code);
  const currency = String(form.currency || "INR").toUpperCase();
  if (!codes.includes(currency) || (currency !== "INR" && !config?.international)) {
    e.currency = t("இந்த நாணயத்தில் இப்போது பெற முடியாது.", "That currency is not being accepted right now.");
  }

  const { min, max } = amountBounds(currency, config);
  const amount = parseAmountInput(form.amount);
  if (amount === null) {
    e.amount = t(
      "தொகையை எண்ணாக உள்ளிடவும் — எடுத்துக்காட்டாக 1000 அல்லது 1000.50.",
      "Enter the amount in figures — for example 1000 or 1000.50.",
    );
  } else if (Number(amount) < min) {
    e.amount = t(
      `குறைந்தபட்சத் தொகை ${formatMoney(min, currency, "ta")}.`,
      `Enter an amount of at least ${formatMoney(min, currency, "en")}.`,
    );
  } else if (Number(amount) > max) {
    e.amount = t(
      `இணையவழியில் ஒரு முறையில் அதிகபட்சம் ${formatMoney(max, currency, "ta")} வரை வழங்கலாம். பெரிய தொகைக்கு கோயில் அலுவலகத்தை அழைக்கவும்.`,
      `The most you can give online at once is ${formatMoney(max, currency, "en")}. Please call the temple office for a larger amount.`,
    );
  } else if (currencyDecimals(currency) === 0 && Number(amount) % 1 !== 0) {
    e.amount = t("இந்த நாணயத்தில் முழு எண்ணை மட்டுமே உள்ளிட முடியும்.", "This currency takes whole amounts only.");
  }
  return e;
}

function validateDetails(form, t) {
  const e = {};
  const name = lengthProblem(
    form.name,
    DONATION_LIMITS.name,
    t,
    t("உங்கள் பெயரை உள்ளிடவும்.", "Please enter your name."),
    { ta: "பெயரில்", en: "The name" },
  );
  if (name) e.name = name;

  const phone = phoneProblem(form.phone, form.phoneCountry, { required: true, t });
  if (phone) e.phone = phone;

  if (!COUNTRY_CODES.has(form.country)) e.country = t("நாட்டைத் தேர்ந்தெடுக்கவும்.", "Please choose a country.");

  const email = String(form.email ?? "").trim();
  if (email) {
    if (charCount(email) > DONATION_LIMITS.email[1]) {
      e.email = t(
        `மின்னஞ்சல் முகவரியில் அதிகபட்சம் ${DONATION_LIMITS.email[1]} எழுத்துகள் மட்டுமே இருக்கலாம்.`,
        `The email address must be at most ${DONATION_LIMITS.email[1]} characters.`,
      );
    } else if (!EMAIL_RE.test(email)) {
      e.email = t(
        "சரியான மின்னஞ்சல் முகவரியை உள்ளிடவும், அல்லது காலியாக விடவும்.",
        "Enter a valid email address, or leave it blank.",
      );
    }
  }

  for (const [key, what] of [
    ["address", { ta: "முகவரியில்", en: "The address" }],
    ["city", { ta: "நகரப் பெயரில்", en: "The city or town" }],
    ["state", { ta: "மாநிலப் பெயரில்", en: "The state or region" }],
    ["message", { ta: "செய்தியில்", en: "The message" }],
    ["notes", { ta: "குறிப்பில்", en: "The note" }],
  ]) {
    const problem = lengthProblem(form[key], DONATION_LIMITS[key], t, "", what);
    if (problem) e[key] = problem;
  }

  const postcode = String(form.postcode ?? "").trim();
  if (form.country === "IN" && postcode) {
    if (!/^[1-9]\d{5}$/.test(postcode.replace(/\s+/g, ""))) {
      e.postcode = t("PIN குறியீடு 6 இலக்கங்கள் கொண்டது; 0-வில் தொடங்காது.", "A PIN code is 6 digits and does not start with 0.");
    }
  } else if (charCount(postcode) > DONATION_LIMITS.postcode[1]) {
    e.postcode = t(
      `அஞ்சல் குறியீட்டில் அதிகபட்சம் ${DONATION_LIMITS.postcode[1]} எழுத்துகள் மட்டுமே இருக்கலாம்.`,
      `The postal code must be at most ${DONATION_LIMITS.postcode[1]} characters.`,
    );
  }

  const pan = String(form.pan ?? "").trim().toUpperCase();
  if (pan && !PAN_RE.test(pan)) {
    e.pan = t("PAN எண் ABCDE1234F வடிவில் இருக்க வேண்டும்.", "A PAN looks like ABCDE1234F.");
  }
  return e;
}

function validateReview(form, t) {
  const e = {};
  if (form.acceptTerms !== true) {
    e.acceptTerms = t(
      "விதிமுறைகளையும் பணத்திரும்பக் கொள்கையையும் ஏற்கவும்.",
      "Please accept the terms and the refund policy.",
    );
  }
  return e;
}

/** Problems on one step as `{ errorKey: message }`. */
export function validateDonationStep(step, form, t, config) {
  if (step === "purpose") return validatePurpose(form, t, config);
  if (step === "details") return validateDetails(form, t);
  if (step === "review") return validateReview(form, t);
  return {};
}

/** Problems on every step: `{ purpose, details, review }`. */
export function validateDonationAll(form, t, config) {
  return Object.fromEntries(DONATE_STEP_KEYS.map((step) => [step, validateDonationStep(step, form, t, config)]));
}

/* ── Error summary ──────────────────────────────────────────────────────── */

/** The id of the control an error belongs to, for the summary's links. */
export function fieldIdFor(errorKey) {
  return (
    {
      category: "don-category",
      amount: "don-amount",
      currency: "don-currency",
      name: "don-name",
      phone: "don-phone",
      country: "don-country",
      email: "don-email",
      address: "don-address",
      city: "don-city",
      state: "don-state",
      postcode: "don-postcode",
      pan: "don-pan",
      message: "don-message",
      notes: "don-notes",
      acceptTerms: "don-accept-terms",
    }[errorKey] ?? null
  );
}

/** How the summary names the field an error belongs to. */
export function fieldLabel(errorKey, form, t) {
  switch (errorKey) {
    case "category":
      return t("நோக்கம்", "Purpose");
    case "amount":
      return t("தொகை", "Amount");
    case "currency":
      return t("நாணயம்", "Currency");
    case "name":
      return t("முழுப் பெயர்", "Full name");
    case "phone":
      return t("கைபேசி எண்", "Mobile number");
    case "country":
      return t("நாடு", "Country");
    case "email":
      return t("மின்னஞ்சல்", "Email");
    case "address":
      return t("முகவரி", "Address");
    case "city":
      return t("நகரம் / ஊர்", "City or town");
    case "state":
      return t("மாநிலம் / பகுதி", "State or region");
    case "postcode":
      return form?.country === "IN" ? t("PIN குறியீடு", "PIN code") : t("அஞ்சல் குறியீடு", "Postal code");
    case "pan":
      return t("PAN எண்", "PAN");
    case "message":
      return t("செய்தி", "Message");
    case "notes":
      return t("குறிப்பு", "Note");
    case "acceptTerms":
      return t("விதிமுறைகள்", "Terms");
    default:
      return errorKey;
  }
}

/* ── Talking to the server ──────────────────────────────────────────────── */

/** The JSON body for POST /api/payments/donations (SPEC §5.2). */
export function toDonationPayload(form) {
  const email = String(form.email ?? "").trim();
  const postcode =
    form.country === "IN" ? String(form.postcode ?? "").replace(/\s+/g, "") : String(form.postcode ?? "").trim();
  return {
    category: form.category,
    currency: String(form.currency || "INR").toUpperCase(),
    amount: parseAmountInput(form.amount) ?? String(form.amount ?? "").trim(),
    name: form.name.trim(),
    phone: toE164(form.phone, form.phoneCountry),
    phoneCountry: form.phoneCountry,
    country: form.country,
    email: email ? email.toLowerCase() : "",
    address: form.address.trim(),
    city: form.city.trim(),
    state: String(form.state ?? "").trim(),
    postcode,
    pan: String(form.pan ?? "").trim().toUpperCase(),
    message: form.message.trim(),
    notes: form.notes.trim(),
    showNamePublicly: form.showNamePublicly === true,
    acceptTerms: form.acceptTerms === true,
    lang: form.lang,
    hp_token: form.hp_token,
  };
}

/**
 * A 422's `fields` grouped by step. Where this file's own rules also object,
 * its wording wins so the donor reads it in their language; otherwise the
 * server's sentence is shown (in Tamil, a neutral "please check this").
 */
export function mapServerFields(fields, form, t, lang, config) {
  const client = validateDonationAll(form, t, config);
  const out = { purpose: {}, details: {}, review: {} };
  for (const [key, message] of Object.entries(fields ?? {})) {
    const step = stepOfDonationField(key === "phoneCountry" ? "phone" : key);
    if (!step) continue;
    const formKey = key === "phoneCountry" ? "phone" : key;
    out[step][formKey] =
      client[step][formKey] || (lang === "ta" ? "இந்த விவரத்தைச் சரிபார்க்கவும்." : String(message || "Please check this detail."));
  }
  return out;
}
