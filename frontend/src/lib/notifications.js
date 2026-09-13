import {
  LuBadgeCheck,
  LuBell,
  LuCalendarCheck,
  LuCalendarDays,
  LuCreditCard,
  LuFlame,
  LuGift,
  LuHandHeart,
  LuHeartHandshake,
  LuLandmark,
  LuMegaphone,
  LuPartyPopper,
  LuShieldCheck,
  LuSiren,
  LuSparkles,
} from "react-icons/lu";

/**
 * Helpers shared by the bell, the panel and the /notifications page
 * (docs/notifications/SPEC.md §7.2). Plain functions, no React state, so the
 * same grouping and the same "2 hours ago" appear wherever a notification does.
 */

/** The BroadcastChannel every open tab of the site listens on. */
export const NOTIFICATION_CHANNEL = "temple-notifications";

/**
 * Icons by the names the committee stores in notification_categories.icon.
 * The admin can relabel a category and pick another icon from this set; a name
 * this build does not know falls back to the category key, then to the bell.
 */
export const ICONS_BY_NAME = {
  bell: LuBell,
  megaphone: LuMegaphone,
  "party-popper": LuPartyPopper,
  flame: LuFlame,
  "calendar-days": LuCalendarDays,
  sparkles: LuSparkles,
  "calendar-check": LuCalendarCheck,
  "heart-handshake": LuHeartHandshake,
  "credit-card": LuCreditCard,
  "hand-heart": LuHandHeart,
  "badge-check": LuBadgeCheck,
  landmark: LuLandmark,
  siren: LuSiren,
  "shield-check": LuShieldCheck,
  gift: LuGift,
};

/** Category key → icon, for the built-in categories of migration 007. */
export const CATEGORY_ICONS = {
  general: LuBell,
  announcement: LuMegaphone,
  festival: LuPartyPopper,
  pooja: LuFlame,
  event: LuCalendarDays,
  special_darshan: LuSparkles,
  booking: LuCalendarCheck,
  donation: LuHeartHandshake,
  payment: LuCreditCard,
  volunteer: LuHandHeart,
  membership: LuBadgeCheck,
  administrative: LuLandmark,
  emergency: LuSiren,
  security: LuShieldCheck,
  promotional: LuGift,
};

/**
 * The colour family of a category's icon tile. Four families rather than
 * fifteen colours: the tile should say "this is about money / worship / your
 * account / urgent" at a glance, and the palette stays the temple's own.
 */
const TONE_BY_CATEGORY = {
  emergency: "danger",
  security: "ink",
  booking: "maroon",
  donation: "maroon",
  payment: "maroon",
  membership: "maroon",
  festival: "gold",
  pooja: "gold",
  special_darshan: "gold",
  event: "gold",
  promotional: "gold",
};

export function iconFor(item) {
  return ICONS_BY_NAME[item?.icon] ?? CATEGORY_ICONS[item?.category] ?? LuBell;
}

export function toneFor(item) {
  if (item?.priority === "emergency") return "danger";
  return TONE_BY_CATEGORY[item?.category] ?? "neutral";
}

/** A `{ ta, en }` label in the reader's language, falling back to whichever exists. */
export function pickLabel(label, lang) {
  if (!label) return "";
  if (typeof label === "string") return label;
  return label[lang] || label.en || label.ta || "";
}

/** Priorities worth a badge. Normal messages carry none, so a badge still means something. */
export const PRIORITY_BADGE = {
  important: { tone: "gold", ta: "முக்கியம்", en: "Important" },
  urgent: { tone: "warning", ta: "உடனடி", en: "Urgent" },
  emergency: { tone: "danger", ta: "அவசரம்", en: "Emergency" },
};

/** What the bell's badge shows: the number, or "9+" once it stops fitting. */
export function formatCount(n) {
  const v = Number(n) || 0;
  return v > 9 ? "9+" : String(v);
}

/** '/…' but never '//' (protocol-relative) or '/\' (which some browsers treat the same way). */
export function isInternalPath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\");
}

/** The only external links the API lets through are https (notifySafeCtaUrl). */
export function isExternalUrl(url) {
  return typeof url === "string" && /^https:\/\/[^/\s]/i.test(url);
}

function toDate(iso) {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local midnight `days` away from `date`. Built from parts so a DST change never shifts it by an hour. */
function startOfDay(date, days = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export const GROUP_ORDER = ["today", "yesterday", "week", "earlier"];

export const GROUP_LABELS = {
  today: { ta: "இன்று", en: "Today" },
  yesterday: { ta: "நேற்று", en: "Yesterday" },
  week: { ta: "இந்த வாரம்", en: "This week" },
  earlier: { ta: "முன்பு", en: "Earlier" },
};

/**
 * Split a newest-first list into Today / Yesterday / This week / Earlier, by the
 * reader's own calendar (the browser's time zone, SPEC §3). "This week" is the
 * five days before yesterday, so the four groups never overlap. Order inside a
 * group is kept; empty groups are left out. A time slightly in the future — the
 * server's clock a few seconds ahead of the device — counts as today.
 */
export function groupByTime(items, now = new Date()) {
  const today = startOfDay(now);
  const yesterday = startOfDay(now, -1);
  const week = startOfDay(now, -6);
  const buckets = { today: [], yesterday: [], week: [], earlier: [] };
  for (const item of items ?? []) {
    const d = toDate(item?.createdAt);
    let key = "today";
    if (d && d < today) key = d >= yesterday ? "yesterday" : d >= week ? "week" : "earlier";
    buckets[key].push(item);
  }
  return GROUP_ORDER.filter((key) => buckets[key].length > 0).map((key) => ({ key, items: buckets[key] }));
}

/** 'ta' → 'ta-IN' and 'en' → 'en-IN'; any other code is handed to Intl as it is. */
export function localeFor(lang) {
  if (lang === "ta") return "ta-IN";
  if (lang === "en") return "en-IN";
  return lang || "en-IN";
}

const rtfCache = new Map();
function relativeFormatter(lang) {
  const locale = localeFor(lang);
  if (!rtfCache.has(locale)) {
    let fmt;
    try {
      fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "long" });
    } catch {
      fmt = new Intl.RelativeTimeFormat("en-IN", { numeric: "auto", style: "long" });
    }
    rtfCache.set(locale, fmt);
  }
  return rtfCache.get(locale);
}

/**
 * "just now", "12 minutes ago", "yesterday", "3 weeks ago" — in Tamil or English.
 *
 * Days are counted by the calendar, not in 24-hour blocks, so a message from
 * 23:00 read at 01:00 says "yesterday" and sits under the Yesterday heading.
 * Within today, minutes then hours.
 */
export function relativeTime(iso, lang, now = new Date()) {
  const d = toDate(iso);
  if (!d) return "";
  const rtf = relativeFormatter(lang);
  const seconds = Math.round((now.getTime() - d.getTime()) / 1000);

  if (seconds < 45) return rtf.format(0, "second");
  if (seconds < 45 * 60) return rtf.format(-Math.max(1, Math.round(seconds / 60)), "minute");

  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return rtf.format(-Math.max(1, Math.round(seconds / 3600)), "hour");
  if (days < 7) return rtf.format(-days, "day");
  if (days < 35) return rtf.format(-Math.floor(days / 7), "week");

  const months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (months < 12) return rtf.format(-Math.max(1, months), "month");
  return rtf.format(-Math.max(1, Math.floor(months / 12)), "year");
}

const dtfCache = new Map();
/** The full date and time for a tooltip: "Sunday, 13 September 2026 at 9:35 am". */
export function formatDateTime(iso, lang) {
  const d = toDate(iso);
  if (!d) return "";
  const locale = localeFor(lang);
  if (!dtfCache.has(locale)) {
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" });
    } catch {
      fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "full", timeStyle: "short" });
    }
    dtfCache.set(locale, fmt);
  }
  return dtfCache.get(locale).format(d);
}

/** Today's date in the browser's zone as YYYY-MM-DD, the shape a date input and the API both use. */
export function localIsoDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/**
 * Newest-first order, the API's: by time, then by id. Returns true when `a`
 * sorts after `b` (is older). ISO strings in the same "…Z" form compare as text.
 */
export function isOlder(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt;
  return a.id < b.id;
}
