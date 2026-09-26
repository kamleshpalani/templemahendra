import { useEffect, useState } from "react";
import api from "../services/api";

/**
 * The committee's site settings (Admin → System → Settings, Languages, SEO;
 * migration 025), read once from GET /api/settings and shared by every
 * component that asks. Nothing here is invented: when the committee has not
 * typed a value the key is null and the caller keeps its built-in words
 * (data/temple.js), so a database without migration 025 changes nothing.
 *
 *   const { site, seo, languages, loaded } = useSiteSettings();
 *   const name = siteText(site, "temple_name", lang) || t(TEMPLE.name.ta, TEMPLE.name.en);
 */

const EMPTY = { site: {}, seo: {}, languages: { enabled: ["ta", "en"], default: "ta" }, loaded: false };
let cache = null;
let inflight = null;
const listeners = new Set();

function shape(data) {
  const languages = data?.languages && Array.isArray(data.languages.enabled) && data.languages.enabled.length
    ? { enabled: data.languages.enabled.filter((c) => c === "ta" || c === "en"), default: data.languages.default === "en" ? "en" : "ta" }
    : EMPTY.languages;
  if (!languages.enabled.length) languages.enabled = ["ta", "en"];
  if (!languages.enabled.includes(languages.default)) languages.default = languages.enabled[0];
  return {
    site: data?.site && typeof data.site === "object" ? data.site : {},
    seo: data?.seo && typeof data.seo === "object" ? data.seo : {},
    languages,
    homepage: {
      show_pournami_section: data?.show_pournami_section !== false,
      show_nalla_strip: data?.show_nalla_strip !== false,
      show_donor_ticker: data?.show_donor_ticker !== false,
    },
    loaded: true,
  };
}

/** One request per page load; a failure leaves the built-in words in place. */
export function loadSiteSettings() {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api
      .get("/settings")
      .then((r) => shape(r.data))
      .catch(() => ({ ...EMPTY, loaded: true }))
      .then((s) => {
        cache = s;
        listeners.forEach((fn) => fn(s));
        return s;
      });
  }
  return inflight;
}

export function useSiteSettings() {
  const [state, setState] = useState(() => cache ?? EMPTY);
  useEffect(() => {
    if (cache) { setState(cache); return undefined; }
    listeners.add(setState);
    loadSiteSettings();
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}

/** A bilingual setting in `lang`, the other language when that one is empty, "" when neither is set. */
export function siteText(site, key, lang) {
  const v = site?.[key];
  if (!v || typeof v !== "object") return typeof v === "string" ? v : "";
  const first = lang === "ta" ? v.ta : v.en;
  const other = lang === "ta" ? v.en : v.ta;
  return (first && String(first).trim()) || (other && String(other).trim()) || "";
}

/** A plain (single-value) setting, or "" when unset. */
export function siteValue(site, key) {
  const v = site?.[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/**
 * The office phone as ten national digits, from the committee's setting when it
 * reads as an Indian number however it was typed (+91 94430 02296, 094430…,
 * 9443002296), else `fallback`. What telHref()/formatPhone() expect.
 */
export function siteOfficeDigits(site, fallback) {
  const digits = siteValue(site, "phone_primary").replace(/\D/g, "");
  const national =
    digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits;
  return /^[1-9]\d{9}$/.test(national) ? national : fallback;
}

/** Paragraphs from a textarea setting or a CMS page body: blank lines separate them. */
export function paragraphs(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** [{open:"06:00", close:"12:30"}, …] from the committee's hours, or null when unset or malformed. */
export function siteHours(site) {
  const v = site?.temple_hours;
  if (!Array.isArray(v) || !v.length) return null;
  const ok = v.every((w) => w && /^\d{2}:\d{2}$/.test(w.open) && /^\d{2}:\d{2}$/.test(w.close));
  return ok ? v : null;
}

/** The two windows for an IST weekday (0 = Sunday) from the committee's Nalla Neram table, or null. */
export function siteNallaNeram(site, weekday) {
  const v = site?.nalla_neram;
  if (!Array.isArray(v) || v.length !== 7) return null;
  const day = v[weekday];
  if (!Array.isArray(day) || day.length !== 2) return null;
  return day.every((w) => Array.isArray(w) && w.length === 2) ? day : null;
}

/** The active SEO override for a pathname, if the committee wrote one. */
export function seoOverrideFor(seo, pathname) {
  const o = seo?.[pathname];
  return o && typeof o === "object" ? o : null;
}
