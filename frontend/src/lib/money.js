/**
 * money.js — money on the public site (docs/payments/SPEC.md §7.2).
 *
 * Before online payments the site printed `₹{amount}` by hand, which cannot
 * show a second currency and cannot group Indian digits. Every amount a donor
 * sees now goes through `formatMoney`, so the Donate page, the result page and
 * the receipt can never disagree about what is being paid.
 *
 * `parseAmountInput` is the browser's copy of the server's rule
 * (`payAmountParse`, backend/includes/payments/money.php): the same regex, so a
 * number this accepts is a number the server accepts. Never send a parsed float
 * to the API — the amount the gateway is given always comes from the server.
 */

/** Decimal places a currency is written with. JPY has none (SPEC §4.3). */
export const currencyDecimals = (currency) => (String(currency).toUpperCase() === "JPY" ? 0 : 2);

/**
 * "₹5,000", "₹501.50", "$25.00", "¥3,000".
 *
 * Whole amounts lose the ".00": a donor who gives ₹5,000 should read ₹5,000.
 * Intl throws on a code it does not know, so an unknown currency falls back to
 * "CODE 1,234.00" rather than taking the page down.
 */
export function formatMoney(amount, currency = "INR", lang = "ta") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  const code = String(currency || "INR").toUpperCase();
  const decimals = currencyDecimals(code) === 0 ? 0 : Number.isInteger(n) ? 0 : 2;
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n);
  } catch {
    return `${code} ${new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(n)}`;
  }
}

/** The symbol a currency's own formatting uses, for an input's leading icon. */
export function currencySymbol(currency = "INR", lang = "ta") {
  const code = String(currency || "INR").toUpperCase();
  const formatted = formatMoney(1, code, lang);
  const symbol = formatted.replace(/[\d\s.,  ]+/g, "");
  return symbol || code;
}

/**
 * The server's rule, exactly: up to ten digits, at most two decimals, no sign,
 * no exponent, no grouping. Returns the cleaned string, or null.
 */
export function parseAmountInput(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) return null;
  return raw;
}

/** True when the amount has no paise — JPY and whole-rupee checks. */
export const isWholeAmount = (value) => {
  const parsed = parseAmountInput(value);
  return parsed !== null && Number(parsed) % 1 === 0;
};

/* ── Amount in words (Indian system), for the printed receipt ────────────── */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0–999 in words; "" for 0, so a caller can skip an empty group. */
function underThousand(n) {
  if (n === 0) return "";
  if (n < 20) return ONES[n];
  if (n < 100) return (TENS[Math.floor(n / 10)] + " " + ONES[n % 10]).trim();
  return (ONES[Math.floor(n / 100)] + " Hundred " + underThousand(n % 100)).trim();
}

/**
 * "Rupees Five Thousand and Fifty Paise Only" — the wording an auditor expects
 * on a receipt, in the Indian system (thousand, lakh, crore). English only: it
 * is a legal formula, not site copy, and the Tamil receipt prints the figures.
 */
export function amountInWordsINR(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return "";
  const rupees = Math.floor(n + 1e-9);
  const paise = Math.round((n - rupees) * 100);

  const groups = [
    [Math.floor(rupees / 10000000), "Crore"],
    [Math.floor((rupees % 10000000) / 100000), "Lakh"],
    [Math.floor((rupees % 100000) / 1000), "Thousand"],
    [rupees % 1000, ""],
  ];
  const words = groups
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${underThousand(value)}${unit ? ` ${unit}` : ""}`)
    .join(" ")
    .trim();

  const rupeeWords = words || "Zero";
  if (paise > 0) return `Rupees ${rupeeWords} and ${underThousand(paise)} Paise Only`;
  return `Rupees ${rupeeWords} Only`;
}
