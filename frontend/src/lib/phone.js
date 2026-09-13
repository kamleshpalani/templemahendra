/**
 * phone.js — international phone numbers, without a dependency.
 *
 * The temple's devotees live in many countries, so a phone field cannot assume
 * ten digits. This module carries the small amount of logic a registration form
 * actually needs: pick a country, type a national number, see it grouped the way
 * that country writes it, and store one canonical E.164 string.
 *
 * It is deliberately not a full libphonenumber. That library is right when you
 * must know whether a number is a mobile, a premium line or a real assignment.
 * Here the only question is "could this be someone's number", and getting that
 * wrong in the strict direction turns a devotee away. So the rules are:
 * digits only, a length within the country's published range, and a total
 * within E.164's fifteen digits. Everything else is formatting.
 *
 * The stored value is always E.164 without the plus: dial code followed by the
 * national significant number, digits only. That is what the API receives and
 * what the database keeps, so a number is comparable however it was typed.
 */

import { COUNTRIES, DEFAULT_COUNTRY } from "../data/countries";
import { SUBDIVISIONS } from "../data/subdivisions";

const BY_ISO = new Map(COUNTRIES.map((c) => [c.iso2, c]));

/** Countries sharing a dial code, longest code first, for parsing pasted numbers. */
const BY_DIAL_DESC = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

export function countryOf(iso2) {
  return BY_ISO.get(String(iso2 || "").toUpperCase()) ?? BY_ISO.get(DEFAULT_COUNTRY) ?? COUNTRIES[0];
}

/**
 * The flag as a regional-indicator pair. No image assets, no requests.
 *
 * Windows renders these as the two letters in a rounded box rather than a flag,
 * which still identifies the country, so nothing is lost where the glyph is
 * missing. The dial code and the country name sit beside it either way.
 */
export function flagOf(iso2) {
  const code = String(iso2 || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "\u{1F3F3}"; // white flag
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export const digitsOf = (value) => String(value ?? "").replace(/\D+/g, "");

/**
 * Group a national number the way its country writes it.
 * Extra digits beyond the mask are appended rather than dropped, so a person
 * mid-typing never sees a character vanish.
 */
export function formatNational(digits, country) {
  const d = digitsOf(digits);
  const mask = country?.format ?? "";
  if (!d) return "";
  if (!mask.includes("#")) return d;

  let out = "";
  let i = 0;
  for (const ch of mask) {
    if (i >= d.length) break;
    if (ch === "#") {
      out += d[i];
      i += 1;
    } else {
      out += ch;
    }
  }
  return i < d.length ? out + d.slice(i) : out;
}

/** How many digits the mask can hold, so an input can cap its own length. */
export const maxDigitsFor = (country) => country?.max ?? 15;

/**
 * A placeholder built from the country's own mask, so the field shows the shape
 * expected rather than one country's convention imposed on every other.
 */
export function placeholderFor(country) {
  const mask = country?.format ?? "";
  return mask ? mask.replace(/#/g, "0") : "0".repeat(country?.max ?? 10);
}

/**
 * Validate a national number for a country.
 * Returns a sentence explaining the problem, or '' when acceptable.
 * `required` false lets an empty value pass, which is what optional fields want.
 */
export function phoneProblem(national, iso2, { required = false } = {}) {
  const country = countryOf(iso2);
  const d = digitsOf(national);

  if (!d) return required ? "Enter your phone number." : "";
  if (/^0/.test(d)) {
    // A trunk prefix is how the number is dialled inside the country, not part
    // of it. Saying so is more useful than rejecting the length that results.
    return "Leave off the leading 0 — the country code replaces it.";
  }
  if (d.length < country.min) {
    return country.min === country.max
      ? `A ${country.name} number has ${country.min} digits.`
      : `A ${country.name} number has at least ${country.min} digits.`;
  }
  if (d.length > country.max) {
    return country.min === country.max
      ? `A ${country.name} number has ${country.max} digits.`
      : `A ${country.name} number has at most ${country.max} digits.`;
  }
  // E.164 caps the whole international number, dial code included.
  if (country.dial.length + d.length > 15) return "That number is too long to dial internationally.";
  return "";
}

/** The canonical stored form: dial code + national number, digits only. */
export function toE164(national, iso2) {
  const d = digitsOf(national);
  if (!d) return "";
  return countryOf(iso2).dial + d;
}

/** How the number is shown back to a person, e.g. "+91 98765 43210". */
export function formatInternational(national, iso2) {
  const country = countryOf(iso2);
  const d = digitsOf(national);
  if (!d) return "";
  return `+${country.dial} ${formatNational(d, country)}`.trim();
}

/**
 * Split a stored or pasted international number into a country and a national
 * part. Used when prefilling a form from a saved profile, and when someone
 * pastes a number that already carries its country code.
 *
 * `hint` is the country to prefer when several share a dial code (+1 covers the
 * United States, Canada and much of the Caribbean), so a Canadian devotee's own
 * saved number does not come back labelled as American.
 */
export function parseInternational(input, hint) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // 00 is the international prefix in much of the world; + is the written form.
  let d = digitsOf(raw.replace(/^00/, "+"));
  const explicit = /^\s*(\+|00)/.test(raw);
  if (!d) return null;

  const hinted = hint ? BY_ISO.get(String(hint).toUpperCase()) : null;

  // Longest dial code first, so +1 does not swallow a number meant for +1876.
  for (const country of BY_DIAL_DESC) {
    if (!d.startsWith(country.dial)) continue;
    const national = d.slice(country.dial.length);
    if (national.length < country.min || national.length > country.max) continue;

    // Prefer the hinted country when it shares this dial code and also fits.
    if (hinted && hinted.dial === country.dial) {
      const hintedNational = d.slice(hinted.dial.length);
      if (hintedNational.length >= hinted.min && hintedNational.length <= hinted.max) {
        return { country: hinted.iso2, national: hintedNational };
      }
    }
    return { country: country.iso2, national };
  }

  // No dial code matched. If the caller did not write one, treat the digits as a
  // national number in the hinted (or default) country.
  if (!explicit) {
    const fallback = hinted ?? countryOf(DEFAULT_COUNTRY);
    return { country: fallback.iso2, national: d };
  }
  return null;
}

/* ── Subdivisions ─────────────────────────────────────────────────────────
   The first-level administrative unit a person writes on their address. The
   site carries lists for the countries this temple's devotees actually live
   in; everywhere else the field is free text, which is better than a partial
   list that forces most of the world to pick "Other".
   ───────────────────────────────────────────────────────────────────────── */

/** The states/provinces of a country, or an empty array when there is no list. */
export function subdivisionsOf(iso2) {
  return SUBDIVISIONS[String(iso2 || "").toUpperCase()] ?? [];
}

/** True when the site can offer a list rather than a text box. */
export const hasSubdivisions = (iso2) => subdivisionsOf(iso2).length > 0;

/**
 * What that level is called where the devotee lives. "State" is wrong in most
 * of the world, and a form that insists on it reads as written for somewhere
 * else. Anything not named here gets the neutral wording.
 */
const SUBDIVISION_WORD = {
  IN: ["மாநிலம்", "State"],
  US: ["மாநிலம்", "State"],
  AU: ["மாநிலம்", "State"],
  MY: ["மாநிலம்", "State"],
  BR: ["மாநிலம்", "State"],
  MX: ["மாநிலம்", "State"],
  NG: ["மாநிலம்", "State"],
  DE: ["மாநிலம்", "State"],
  AT: ["மாநிலம்", "State"],
  CA: ["மாகாணம்", "Province"],
  LK: ["மாகாணம்", "Province"],
  ZA: ["மாகாணம்", "Province"],
  NL: ["மாகாணம்", "Province"],
  PK: ["மாகாணம்", "Province"],
  NP: ["மாகாணம்", "Province"],
  KE: ["மாவட்டம்", "County"],
  IE: ["மாவட்டம்", "County"],
  MU: ["மாவட்டம்", "District"],
  BT: ["மாவட்டம்", "District"],
  BD: ["கோட்டம்", "Division"],
  FJ: ["கோட்டம்", "Division"],
  AE: ["எமிரேட்", "Emirate"],
  SA: ["பகுதி", "Region"],
  NZ: ["பகுதி", "Region"],
  FR: ["பகுதி", "Region"],
  IT: ["பகுதி", "Region"],
  DK: ["பகுதி", "Region"],
  TZ: ["பகுதி", "Region"],
  MM: ["பகுதி", "State or region"],
  CH: ["கன்டன்", "Canton"],
  GB: ["நாடு", "Nation"],
  QA: ["ஆளுநரகம்", "Municipality"],
  KW: ["ஆளுநரகம்", "Governorate"],
  OM: ["ஆளுநரகம்", "Governorate"],
  BH: ["ஆளுநரகம்", "Governorate"],
  JO: ["ஆளுநரகம்", "Governorate"],
  IL: ["மாவட்டம்", "District"],
  TH: ["மாகாணம்", "Province"],
  PH: ["மாகாணம்", "Province"],
  VN: ["மாகாணம்", "Province"],
  ID: ["மாகாணம்", "Province"],
  ES: ["தன்னாட்சிப் பகுதி", "Autonomous community"],
  SE: ["கவுண்டி", "County"],
  NO: ["கவுண்டி", "County"],
  BE: ["பகுதி", "Region"],
  PT: ["மாவட்டம்", "District"],
  PL: ["வோய்வோடெஷிப்", "Voivodeship"],
  TT: ["பகுதி", "Region"],
  MV: ["அட்டோல்", "Atoll"],
};

/** The field's label for a country, e.g. "State" for India, "Canton" for Switzerland. */
export function subdivisionLabel(iso2, t) {
  const pair = SUBDIVISION_WORD[String(iso2 || "").toUpperCase()];
  return pair ? t(pair[0], pair[1]) : t("மாநிலம் / பகுதி", "State or region");
}

/**
 * Which country a shared calling code should offer first.
 *
 * Several codes cover more than one place: +1 is the whole North American
 * Numbering Plan, +44 covers the UK and the crown dependencies, +7 Russia and
 * Kazakhstan. Without this, searching "+44" sorted the equal matches by name
 * and offered Guernsey ahead of the United Kingdom.
 */
const PRIMARY_FOR_DIAL = {
  1: "US",
  7: "RU",
  39: "IT",
  44: "GB",
  47: "NO",
  61: "AU",
  212: "MA",
  262: "RE",
  290: "SH",
  358: "FI",
  590: "GP",
  596: "MQ",
  599: "CW",
  672: "NF",
  687: "NC",
};

/**
 * Rank countries for the search box. Matches the country name, the ISO code and
 * the dial code, and puts names that START with the query first, so typing
 * "ind" offers India before Indonesia and long before "British Indian Ocean".
 */
export function searchCountries(query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return COUNTRIES;

  // "+44" and "44" should both find the United Kingdom.
  const digitQuery = q.replace(/^\+/, "");
  const isDigits = /^\d+$/.test(digitQuery);

  const scored = [];
  for (const c of COUNTRIES) {
    const name = c.name.toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (c.iso2.toLowerCase() === q) score = 75;
    else if (isDigits && c.dial === digitQuery) score = 70;
    else if (name.includes(` ${q}`)) score = 55;
    else if (isDigits && c.dial.startsWith(digitQuery)) score = 45;
    else if (name.includes(q)) score = 40;
    // Among countries sharing a calling code, the main one comes first.
    if (score > 0 && isDigits && PRIMARY_FOR_DIAL[c.dial] === c.iso2) score += 3;
    if (score > 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.map((s) => s.c);
}
