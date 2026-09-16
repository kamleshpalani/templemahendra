/**
 * payments.js — what every payment screen shares (docs/payments/SPEC.md §7.2).
 *
 * The gateway settings (is online giving on, which currencies, which purposes,
 * what a donation may be) live on the server and are read once per page load
 * through `usePaymentsConfig`. Nothing here decides anything about money: the
 * amount, the order id and the status always come from the API.
 *
 * Calls go through `fetch`, not the axios client in services/api.js: that one
 * logs every non-2xx to the console, and an expected 404 (a stranger's link) or
 * 422 (a field to fix) is not an error the browser should shout about.
 */

import { useEffect, useState } from "react";

const CONFIG_URL = "/api/payments/config";
const LAST_KEY = "temple:payment-last";

/** What the page shows when the server cannot be reached at all. */
export const PAYMENTS_OFF = {
  enabled: false,
  ready: false,
  simulator: false,
  testMode: false,
  currencies: [{ code: "INR", decimals: 2 }],
  defaultCurrency: "INR",
  international: false,
  min: 1,
  max: 500000,
  maxForeign: 10000,
  presets: [],
  categories: [],
  sevaOnline: false,
  holdMinutes: 30,
};

/** Online giving is offered only when the gateway is both switched on and able to run. */
export const paymentsUsable = (config) => Boolean(config?.enabled && config?.ready);

/* ── The public configuration ────────────────────────────────────────────── */

// One request per page load, shared by /donate, /donations, /sevas and Home.
// The promise (not the value) is cached, so four components mounting together
// make one call between them.
let configPromise = null;

function loadConfig() {
  if (!configPromise) {
    configPromise = fetch(CONFIG_URL, { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body) => (body && typeof body === "object" ? { ...PAYMENTS_OFF, ...body } : PAYMENTS_OFF))
      .catch(() => {
        // Let the next mount try again: the server may simply have been busy.
        configPromise = null;
        return null;
      });
  }
  return configPromise;
}

/** `{ config, loading, error }`. `config` is never null once loading is false. */
export function usePaymentsConfig() {
  const [state, setState] = useState({ config: PAYMENTS_OFF, loading: true, error: false });

  useEffect(() => {
    let alive = true;
    loadConfig().then((config) => {
      if (!alive) return;
      setState({ config: config ?? PAYMENTS_OFF, loading: false, error: config === null });
    });
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/* ── Talking to the payments API ─────────────────────────────────────────── */

/** POST JSON without throwing: `{ ok, status, body, retryAfterHeader }`. */
export async function postJson(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: parsed, retryAfterHeader: res.headers.get("Retry-After") };
  } catch {
    return { ok: false, status: 0, body: null, retryAfterHeader: null };
  }
}

/** GET JSON without throwing: `{ ok, status, body }`. status 0 means the network failed. */
export async function getJson(path) {
  try {
    const res = await fetch(path, { headers: { Accept: "application/json" } });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/* ── The hand-off to CCAvenue ────────────────────────────────────────────── */

/**
 * CCAvenue's checkout is a full-page form POST — the browser has to leave the
 * site carrying `encRequest` and `access_code`, which is why this builds a real
 * form instead of fetching. The fields are exactly what the server issued; the
 * browser adds nothing of its own.
 */
export function submitToGateway(gateway) {
  if (!gateway?.url || !gateway.fields) return false;
  const form = document.createElement("form");
  form.method = "post";
  form.action = gateway.url;
  form.style.display = "none";
  for (const [name, value] of Object.entries(gateway.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = String(value ?? "");
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  return true;
}

/* ── The payment this visit is about ─────────────────────────────────────── */

/*
 * The number and its access token are kept for the length of the visit so that
 * a donor who comes back from CCAvenue on a page with no `ref` (an aborted
 * payment, a stale bookmark) can still be offered "Try again". sessionStorage,
 * never localStorage: on a shared phone the next person must not inherit it.
 */

export function readLastPayment() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(LAST_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return null;
    if (typeof saved.number !== "string" || typeof saved.token !== "string") return null;
    return { number: saved.number, token: saved.token, kind: saved.kind === "seva_booking" ? "seva_booking" : "donation" };
  } catch {
    return null;
  }
}

export function writeLastPayment(value) {
  try {
    sessionStorage.setItem(LAST_KEY, JSON.stringify(value));
  } catch {
    /* the result page still works, it just cannot offer "Try again" */
  }
}

export function clearLastPayment() {
  try {
    sessionStorage.removeItem(LAST_KEY);
  } catch {
    /* nothing was kept */
  }
}

/* ── Statuses ────────────────────────────────────────────────────────────── */

/**
 * The eight payable statuses (SPEC §2.1) as a label and a Badge tone. Never
 * `moon` or `sage`: the design system reserves those for lunar and auspicious
 * content (styles/README.md).
 */
export const STATUS_META = {
  INITIATED: { label: ["தொடங்கப்பட்டது", "Started"], tone: "warning" },
  PENDING: { label: ["உறுதி செய்யப்படுகிறது", "Confirming"], tone: "warning" },
  SUCCESS: { label: ["வெற்றி", "Paid"], tone: "success" },
  FAILED: { label: ["தோல்வி", "Failed"], tone: "danger" },
  CANCELLED: { label: ["ரத்து செய்யப்பட்டது", "Cancelled"], tone: "muted" },
  REFUND_INITIATED: { label: ["பணம் திரும்ப தொடங்கப்பட்டது", "Refund started"], tone: "info" },
  PARTIALLY_REFUNDED: { label: ["பகுதி பணம் திரும்பியது", "Partly refunded"], tone: "gold" },
  REFUNDED: { label: ["பணம் திரும்பியது", "Refunded"], tone: "muted" },
};

/** SUCCESS and the refund states: the payment itself went through. */
export const PAID_STATUSES = ["SUCCESS", "REFUND_INITIATED", "PARTIALLY_REFUNDED", "REFUNDED"];
export const isPaidStatus = (status) => PAID_STATUSES.includes(String(status));
export const isOpenStatus = (status) => status === "INITIATED" || status === "PENDING";

/* ── Times ───────────────────────────────────────────────────────────────── */

/*
 * Every timestamp the API returns is UTC (ISO-8601, "…Z"). A payment is a
 * temple record, so it is read back in the temple's own time — a donation made
 * at 00:20 IST belongs to that day, not to the previous one in UTC.
 */
const IST = "Asia/Kolkata";

/** "14 செப்டம்பர் 2026" / "14 September 2026", in India's time zone. */
export function formatIstDate(iso, lang = "ta") {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: IST,
  }).format(date);
}

/** The same with the clock time, for "payment date and time". */
export function formatIstDateTime(iso, lang = "ta") {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  }).format(date);
}

/** A plain YYYY-MM-DD (a seva's preferred date) written out, with no time zone shift. */
export function formatPlainDate(ymd, lang = "ta") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ""))) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** The donor's own links, with the access token that proves they came from us. */
export const resultPath = (number, token) =>
  `/payment/result?ref=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}`;
export const receiptPath = (number, token, print = false) =>
  `/payment/receipt?ref=${encodeURIComponent(number)}&t=${encodeURIComponent(token)}${print ? "&print=1" : ""}`;
