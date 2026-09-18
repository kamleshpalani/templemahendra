/**
 * live.js — what the Live Darshan screens share (docs/live/SPEC-PHASE1.md §5.1).
 *
 * The public API (`GET /api/live-streams…`) is the only source of truth: it
 * says which broadcast is live, when the next one starts and how to play it
 * (a normalised `playback` descriptor). Nothing here parses YouTube URLs or
 * decides a status; the browser only reads, formats and polls.
 *
 * Calls go through `fetch`, not the axios client in services/api.js: that one
 * logs every non-2xx to the console, and a 404 for an unknown slug is an
 * expected answer, not an error the browser should shout about.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const INDEX_URL = "/api/live-streams";

/** How often the page asks again, in milliseconds. */
export const POLL_LIVE_MS = 30_000;
export const POLL_IDLE_MS = 60_000;

/**
 * A mount within this window reuses the overview the previous mount fetched
 * (the page transition remounts /live-darshan → /live-darshan/<slug>), so a
 * back-and-forth does not fire a request each time. Longer than this and the
 * answer may be out of date, so it is fetched afresh.
 */
const OVERVIEW_REUSE_MS = 10_000;

/* ── Statuses ────────────────────────────────────────────────────────────── */

/**
 * The seven public statuses as a bilingual label and a Badge tone. Never
 * `moon` or `sage`: the design system reserves those for lunar and auspicious
 * content (styles/README.md). `live` adds the pulsing dot.
 */
export const STREAM_STATUS = {
  LIVE: { ta: "நேரலை", en: "Live now", tone: "danger", live: true },
  STARTING: { ta: "தொடங்குகிறது", en: "Starting soon", tone: "warning", live: true },
  SCHEDULED: { ta: "திட்டமிடப்பட்டது", en: "Scheduled", tone: "info" },
  COMPLETED: { ta: "முடிந்தது", en: "Ended", tone: "muted" },
  OFFLINE: { ta: "தற்காலிகமாக நிறுத்தம்", en: "Temporarily offline", tone: "warning" },
  CANCELLED: { ta: "ரத்து", en: "Cancelled", tone: "muted" },
  ERROR: { ta: "கிடைக்கவில்லை", en: "Unavailable", tone: "danger" },
};

/** Anything the API might send that the table above does not know. */
const UNKNOWN_STATUS = { ta: "கிடைக்கவில்லை", en: "Unavailable", tone: "muted" };

export const LIVE_STATUSES = ["LIVE", "STARTING"];
export const isLiveStatus = (status) => LIVE_STATUSES.includes(String(status));
export const statusMeta = (status) => STREAM_STATUS[String(status)] ?? UNKNOWN_STATUS;

/**
 * Mirror of `LIVE_EVENT_TYPES` (backend/includes/live/config.php). The API
 * sends `event_type_label` with every item and that is what the screens use;
 * this table only fills in when an answer lacks it.
 */
export const EVENT_TYPE_LABELS = {
  live_darshan: { ta: "நேரடி தரிசனம்", en: "Live darshan" },
  daily_pooja: { ta: "தினசரி பூஜை", en: "Daily pooja" },
  abhishekam: { ta: "அபிஷேகம்", en: "Abhishekam" },
  deeparadhana: { ta: "தீபாராதனை", en: "Deeparadhana" },
  festival: { ta: "திருவிழா", en: "Festival" },
  bhajan: { ta: "பஜனை", en: "Bhajan" },
  discourse: { ta: "சொற்பொழிவு", en: "Discourse" },
  procession: { ta: "திருவீதி உலா", en: "Procession" },
  special_event: { ta: "சிறப்பு நிகழ்வு", en: "Special event" },
  other: { ta: "மற்றவை", en: "Other" },
};

/* ── Reading a stream ────────────────────────────────────────────────────── */

const pick = (lang, ta, en) => {
  const a = lang === "ta" ? ta : en;
  const b = lang === "ta" ? en : ta;
  return String(a ?? "").trim() || String(b ?? "").trim();
};

/** The title in the visitor's language, falling back to the other one. */
export const streamTitle = (stream, lang) => pick(lang, stream?.title_ta, stream?.title_en);
export const streamDescription = (stream, lang) => pick(lang, stream?.description_ta, stream?.description_en);
export const templeName = (stream, lang) => pick(lang, stream?.temple?.name_ta, stream?.temple?.name_en);
export const templeShortName = (stream, lang) =>
  pick(lang, stream?.temple?.short_name_ta, stream?.temple?.short_name_en) || templeName(stream, lang);
export const deityName = (stream, lang) => pick(lang, stream?.deity?.name_ta, stream?.deity?.name_en);

export function eventTypeLabel(stream, lang) {
  const fromApi = stream?.event_type_label;
  if (fromApi && (fromApi.ta || fromApi.en)) return pick(lang, fromApi.ta, fromApi.en);
  const known = EVENT_TYPE_LABELS[String(stream?.event_type ?? "")];
  return known ? pick(lang, known.ta, known.en) : "";
}

/**
 * The iframe address: the API's embed URL plus the player language. Only an
 * `iframe` playback has one; a `link` or `none` playback returns null.
 */
export function embedSrc(stream, lang) {
  const playback = stream?.playback;
  if (!playback || playback.kind !== "iframe" || typeof playback.embedUrl !== "string" || !playback.embedUrl) return null;
  const sep = playback.embedUrl.includes("?") ? "&" : "?";
  return `${playback.embedUrl}${sep}hl=${lang === "ta" ? "ta" : "en"}`;
}

/** The provider's own page for this broadcast, when there is one. */
export function watchUrl(stream) {
  const url = stream?.playback?.watchUrl;
  return typeof url === "string" && /^https:\/\//i.test(url) ? url : null;
}

/**
 * Which broadcast the list page shows: the first LIVE one, else the first
 * STARTING one, else the next upcoming one (as a poster), else nothing.
 */
export function pickStream(live, upcoming) {
  const liveList = Array.isArray(live) ? live : [];
  const upcomingList = Array.isArray(upcoming) ? upcoming : [];
  return (
    liveList.find((s) => s?.status === "LIVE") ??
    liveList.find((s) => s?.status === "STARTING") ??
    liveList[0] ??
    upcomingList[0] ??
    null
  );
}

/* ── Times ───────────────────────────────────────────────────────────────── */

/*
 * Every instant the API returns is UTC (ISO-8601, "…Z"). A broadcast is shown
 * in the zone it was scheduled in (`stream.timezone`, Asia/Kolkata unless the
 * committee chose otherwise) and the zone is named after the time, so a
 * devotee abroad knows the clock they are reading.
 */
const IST = "Asia/Kolkata";
const ZONE_LABELS = { "Asia/Kolkata": "IST", "Asia/Calcutta": "IST", UTC: "UTC", "Etc/UTC": "UTC" };

/** "IST" for India; otherwise the city part of the IANA name ("New York"). */
export function zoneLabel(tz) {
  const name = String(tz || IST);
  if (ZONE_LABELS[name]) return ZONE_LABELS[name];
  const city = name.split("/").pop() ?? name;
  return city.replace(/_/g, " ");
}

const locale = (lang) => (lang === "ta" ? "ta-IN" : "en-IN");

function formatIn(iso, lang, tz, options) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale(lang), { ...options, timeZone: tz || IST }).format(date);
  } catch {
    // An unknown zone name throws a RangeError; India's clock is the sane default.
    return new Intl.DateTimeFormat(locale(lang), { ...options, timeZone: IST }).format(date);
  }
}

/** "14 செப்டம்பர் 2026" / "Sunday, 14 September 2026" in the stream's zone. */
export function formatStreamDate(iso, lang = "ta", tz = IST) {
  return formatIn(iso, lang, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** The named pieces of a formatted date ({ weekday, day, month, … }), empty when the instant is unusable. */
function partsIn(iso, lang, tz, options) {
  if (!iso) return {};
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return {};
  const format = (zone) => new Intl.DateTimeFormat(locale(lang), { ...options, timeZone: zone }).formatToParts(date);
  let parts;
  try {
    parts = format(tz || IST);
  } catch {
    parts = format(IST);
  }
  const out = {};
  for (const part of parts) if (part.type !== "literal") out[part.type] = part.value;
  return out;
}

// A time is one word: "6:00 pm IST" is joined with no-break spaces (Intl's
// own am/pm separator is a plain space) so neither "pm" nor "IST" wraps onto
// a line of its own.
const NBSP = " ";

/** "6:00 PM IST" (the zone label appended unless `zone` is false). */
export function formatStreamTime(iso, lang = "ta", tz = IST, { zone = true } = {}) {
  const text = formatIn(iso, lang, tz, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, NBSP);
  if (!text) return "";
  return zone ? `${text}${NBSP}${zoneLabel(tz)}` : text;
}

/** "6:00 PM – 7:30 PM IST", or just the start when there is no end. */
export function formatStreamRange(startIso, endIso, lang = "ta", tz = IST) {
  const start = formatStreamTime(startIso, lang, tz, { zone: false });
  if (!start) return "";
  const end = formatStreamTime(endIso, lang, tz, { zone: false });
  return `${start}${end ? ` – ${end}` : ""}${NBSP}${zoneLabel(tz)}`;
}

/** The instant a broadcast is "about": when it started, else when it should. */
export function streamInstant(stream) {
  if (!stream) return null;
  if (isLiveStatus(stream.status) && stream.actual_start_at) return stream.actual_start_at;
  return stream.scheduled_start_at ?? stream.actual_start_at ?? null;
}

/**
 * True once the scheduled start lies in the past — by the server's clock when
 * the page knows the offset to it. A SCHEDULED broadcast past its start is
 * one the committee is late pressing "Go live" on: the poster says so instead
 * of announcing a time that has gone by.
 */
export function startHasPassed(stream, serverOffset = 0) {
  const at = Date.parse(String(stream?.scheduled_start_at ?? ""));
  if (!Number.isFinite(at)) return false;
  return at <= Date.now() + (Number.isFinite(serverOffset) ? serverOffset : 0);
}

/* ── The schedule and the countdown (docs/live/SPEC-PHASE2.md §2.1) ────── */

/** Mirror of LIVE_SCHEDULE_FILTERS (backend/includes/live/config.php), in the page's order. */
export const SCHEDULE_FILTERS = [
  { value: "today", ta: "இன்று", en: "Today" },
  { value: "tomorrow", ta: "நாளை", en: "Tomorrow" },
  { value: "week", ta: "இந்த வாரம்", en: "This week" },
  { value: "festivals", ta: "திருவிழாக்கள்", en: "Festivals" },
  { value: "all", ta: "அனைத்தும்", en: "All" },
];
export const isScheduleFilter = (value) => SCHEDULE_FILTERS.some((f) => f.value === value);
/** The filter a URL names, or "all" (the API treats anything else the same way). */
export const normaliseFilter = (value) => (isScheduleFilter(value) ? value : "all");

/**
 * True when "this week" covers a single day — a Sunday, since the week runs
 * through the coming Sunday inclusive (SPEC-PHASE2 §0). On such a day the
 * Today and Tomorrow empty states cannot send a devotee to "this week": it is
 * the same one-day window, and it cannot contain tomorrow (review fix O11).
 * Read from the window the API returns (`today`, on the temple's clock).
 */
export function weekIsOneDay(win) {
  const ymd = String(win?.today ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const day = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.getUTCDay() === 0;
}

/** Under five minutes the countdown is "soon" (a warmer accent, nothing more). */
export const COUNTDOWN_SOON_SECONDS = 5 * 60;

/** 'YYYY-MM-DD' of an instant on the wall clock of a zone (en-CA prints ISO order). */
function localYmd(iso, tz) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }
}

/**
 * The day a broadcast falls on: the API's `day_bucket` when the item carries
 * one (the schedule route, and `now`/`next` on the index), else worked out
 * from the stream's own local date against today in its zone, by the server's
 * clock when the offset is known.
 */
export function dayBucket(stream, serverOffset = 0) {
  const given = stream?.day_bucket;
  if (given === "today" || given === "tomorrow" || given === "later" || given === "past") return given;
  if (isLiveStatus(stream?.status)) return "today";
  const tz = stream?.timezone || IST;
  const date = stream?.local?.date || localYmd(stream?.scheduled_start_at, tz);
  if (!date) return "later";
  const now = Date.now() + (Number.isFinite(serverOffset) ? serverOffset : 0);
  const today = localYmd(new Date(now).toISOString(), tz);
  const tomorrow = localYmd(new Date(now + 86_400_000).toISOString(), tz);
  if (date < today) return "past";
  if (date === today) return "today";
  if (date === tomorrow) return "tomorrow";
  return "later";
}

/**
 * "Today" / "Tomorrow" / "Saturday, 20 September" ("இன்று" / "நாளை" / …) for
 * a broadcast, in the stream's zone. A broadcast without a start has no day
 * yet.
 */
export function dayLabel(stream, lang = "ta", serverOffset = 0) {
  const bucket = dayBucket(stream, serverOffset);
  if (bucket === "today") return lang === "ta" ? "இன்று" : "Today";
  if (bucket === "tomorrow") return lang === "ta" ? "நாளை" : "Tomorrow";
  const when = stream?.scheduled_start_at;
  if (!when) return lang === "ta" ? "தேதி விரைவில் அறிவிக்கப்படும்" : "Date to be announced";
  const tz = stream?.timezone || IST;
  const options = { weekday: "long", day: "numeric", month: "long" };
  if (lang === "ta") {
    // ICU's Tamil pattern without a year puts the weekday last ("செப்டம்பர் 24,
    // வியாழன்"), which reads against the day heading above it ("வியாழன், 24
    // செப்டம்பர், 2026"). The pieces are reassembled in the heading's order.
    const p = partsIn(when, lang, tz, options);
    if (p.weekday && p.day && p.month) return `${p.weekday}, ${p.day} ${p.month}`;
  }
  return formatIn(when, lang, tz, options);
}

/**
 * Seconds until a broadcast starts by the server's clock: the API's
 * `starts_in_seconds` when the item carries it, else from its start and the
 * offset. Null without a start, or once it is live.
 */
export function startsInSeconds(stream, serverOffset = 0) {
  if (isLiveStatus(stream?.status)) return null;
  const given = Number(stream?.starts_in_seconds);
  if (stream?.starts_in_seconds !== null && stream?.starts_in_seconds !== undefined && Number.isFinite(given)) return given;
  const at = Date.parse(String(stream?.scheduled_start_at ?? ""));
  if (!Number.isFinite(at)) return null;
  return Math.round((at - (Date.now() + (Number.isFinite(serverOffset) ? serverOffset : 0))) / 1000);
}

/**
 * The count as the clock shows it: `{ dd, hh, mm, ss }`, each as two digits
 * ("01", "35", "07"). A count of a day or more keeps whole days in `dd` and
 * the hours within the day in `hh`, so a broadcast eight days away reads
 * "08 : 07 : 38 : 52" and never "191 : 38 : 52" (review fix F2); under a day
 * `dd` is null and the clock is the plain HH : MM : SS.
 */
export function countdownParts(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const two = (n) => String(n).padStart(2, "0");
  const days = Math.floor(s / 86_400);
  return {
    dd: days > 0 ? two(days) : null,
    hh: two(Math.floor((s % 86_400) / 3600)),
    mm: two(Math.floor((s % 3600) / 60)),
    ss: two(s % 60),
  };
}

/**
 * The plain sentence behind the clock, at minute precision so a screen
 * reader hears it change once a minute, not once a second:
 * "Starts in about 1 hour 35 minutes" / "சுமார் 1 மணி 35 நிமிடங்களில் தொடங்கும்".
 */
export function countdownText(seconds, lang = "ta") {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const ta = lang === "ta";
  if (s < 60) return ta ? "ஒரு நிமிடத்திற்குள் தொடங்கும்" : "Starts in under a minute";
  const minutes = Math.round(s / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (ta) {
    // The last unit takes the locative ("…இல்"): 35 நிமிடங்களில், 2 மணி நேரத்தில், 2 நாட்களில்.
    if (days) {
      const d = days === 1 ? "1 நாள்" : `${days} நாட்கள்`;
      return hours ? `சுமார் ${d} ${hours} மணி நேரத்தில் தொடங்கும்` : `சுமார் ${days === 1 ? "1 நாளில்" : `${days} நாட்களில்`} தொடங்கும்`;
    }
    if (hours) {
      return mins
        ? `சுமார் ${hours} மணி ${mins === 1 ? "1 நிமிடத்தில்" : `${mins} நிமிடங்களில்`} தொடங்கும்`
        : `சுமார் ${hours} மணி நேரத்தில் தொடங்கும்`;
    }
    return `சுமார் ${mins === 1 ? "1 நிமிடத்தில்" : `${mins} நிமிடங்களில்`} தொடங்கும்`;
  }
  const parts = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (mins && !days) parts.push(`${mins} ${mins === 1 ? "minute" : "minutes"}`);
  return `Starts in about ${parts.join(" ")}`;
}

/** The short form for a card: "in 1 h 35 min" / "1 மணி 35 நிமி." */
export function countdownShort(seconds, lang = "ta") {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const ta = lang === "ta";
  if (s < 60) return ta ? "ஒரு நிமிடத்திற்குள்" : "in under a minute";
  const minutes = Math.round(s / 60);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const span = [hours ? (ta ? `${hours} மணி` : `${hours} h`) : "", mins ? (ta ? `${mins} நிமி.` : `${mins} min`) : ""].filter(Boolean).join(" ");
  return ta ? `${span} கழித்து` : `in ${span}`;
}

/* ── Talking to the API ──────────────────────────────────────────────────── */

/**
 * GET JSON without throwing: `{ ok, status, body }`. status 0 means the network
 * failed. `cache: "no-store"` because the single-stream route answers with
 * `public, max-age=60` (fine for crawlers and a CDN) while this page polls it
 * every 30 s to notice the broadcast begin — a poll served from the browser's
 * own cache would hide that for a minute.
 */
export async function getJson(path) {
  try {
    const res = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
    const parsed = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: parsed };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** `Date.parse(server_time) - Date.now()`, or null when the answer carries no usable time. */
function offsetFrom(body) {
  const stamp = Date.parse(String(body?.server_time ?? ""));
  return Number.isFinite(stamp) ? stamp - Date.now() : null;
}

function shapeOverview(body) {
  const live = Array.isArray(body?.live) ? body.live.filter(isObject) : [];
  const upcoming = Array.isArray(body?.upcoming) ? body.upcoming.filter(isObject) : [];
  // `now` and `next` (SPEC-PHASE2 §1.1) carry day_bucket and starts_in_seconds;
  // an answer without them (an older server) falls back to the two lists.
  const now = isObject(body?.now) ? body.now : (live.find((s) => s.status === "LIVE") ?? live.find((s) => s.status === "STARTING") ?? null);
  const next = isObject(body?.next) ? body.next : (upcoming[0] ?? null);
  return { live, upcoming, now, next };
}

// One request per page load, shared by every component mounting together;
// the promise (not the value) is cached, so two hooks make one call between
// them. It is reused for a few seconds and then let go (see OVERVIEW_REUSE_MS).
let overviewPromise = null;
let overviewAt = 0;

function loadOverview(fresh = false) {
  const now = Date.now();
  if (!fresh && overviewPromise && now - overviewAt < OVERVIEW_REUSE_MS) return overviewPromise;
  overviewAt = now;
  overviewPromise = getJson(INDEX_URL).then((res) => {
    // A failed answer is not worth sharing: let the next mount try again.
    if (!res.ok || !isObject(res.body)) overviewPromise = null;
    return res;
  });
  return overviewPromise;
}

const pageVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Keeps calling `tick` every `intervalOf()` ms while the page is visible;
 * a hidden tab stops the clock and a tab shown again asks at once. Returns
 * the stop function.
 */
function schedulePolling(tick, intervalOf) {
  let timer = null;
  let stopped = false;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    if (stopped || !pageVisible()) return;
    const ms = intervalOf();
    if (!ms) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped || !pageVisible()) return;
      await tick();
      arm();
    }, ms);
  };
  const onVisibility = () => {
    if (stopped) return;
    if (pageVisible()) {
      tick().then(arm);
    } else {
      clear();
    }
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  arm();
  return () => {
    stopped = true;
    clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * `{ live, upcoming, now, next, serverOffset, loading, error, refresh }` from
 * the index route — `now` the featured live broadcast and `next` the first
 * upcoming one (or null). Polls every 30 s while any broadcast is live, 60 s
 * otherwise, pausing while the tab is hidden. A poll that fails keeps the
 * last good answer on screen; `error` is only set when there is nothing to
 * show.
 *
 * Options: `enabled: false` leaves the hook idle (a page that does not need
 * the overview); `poll: false` fetches once and stops.
 */
export function useLiveOverview({ enabled = true, poll = true } = {}) {
  const [state, setState] = useState({ live: [], upcoming: [], now: null, next: null, serverOffset: 0, loading: enabled, error: false });
  const alive = useRef(true);
  const anyLive = useRef(false);

  const apply = useCallback((res) => {
    if (!alive.current) return false;
    if (res.ok && isObject(res.body)) {
      const shaped = shapeOverview(res.body);
      anyLive.current = shaped.live.some((s) => isLiveStatus(s.status));
      const offset = offsetFrom(res.body);
      setState((prev) => ({
        ...shaped,
        serverOffset: offset ?? prev.serverOffset,
        loading: false,
        error: false,
      }));
      return true;
    }
    setState((prev) => (prev.loading ? { ...prev, loading: false, error: true } : prev));
    return false;
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return Promise.resolve(false);
    setState((prev) => ({ ...prev, loading: true, error: false }));
    return loadOverview(true).then(apply);
  }, [enabled, apply]);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    // Each run of this effect owns its poller. React runs an effect twice in
    // development (StrictMode) and again when a dependency changes, so a run
    // that was cleaned up before its first answer arrived must not arm a
    // poller nobody can stop: the cancelled flag and the stop handle belong
    // to the run, not to a ref the next run would reset. The first poll is
    // armed after the first answer, so its cadence already knows whether
    // anything is live.
    let cancelled = false;
    let stop = null;
    loadOverview().then((res) => {
      if (cancelled) return;
      apply(res);
      if (!poll) return;
      stop = schedulePolling(
        () => loadOverview(true).then((r) => (cancelled ? false : apply(r))),
        () => (anyLive.current ? POLL_LIVE_MS : POLL_IDLE_MS),
      );
    });
    return () => {
      cancelled = true;
      alive.current = false;
      if (stop) stop();
    };
  }, [enabled, poll, apply]);

  return { ...state, refresh };
}

/** What the public API accepts after `/api/live-streams/`: an id or a slug. */
const SLUG_RE = /^(?:[0-9]{1,10}|[a-z0-9][a-z0-9-]{1,118})$/;

/**
 * `{ stream, serverOffset, loading, error, notFound }` for one broadcast.
 * Polls every 30 s while it is LIVE or STARTING, and — so a devotee waiting
 * on a scheduled or interrupted broadcast sees it begin without reloading —
 * every 60 s while it is SCHEDULED, OFFLINE or ERROR. Ended and cancelled
 * broadcasts are not polled. A null or invalid slug is "not found" at once,
 * without a request. `refresh()` starts over (the "Try again" button).
 */
export function useStream(slug) {
  const wanted = typeof slug === "string" && SLUG_RE.test(slug) ? slug : null;
  const [state, setState] = useState({
    stream: null,
    serverOffset: 0,
    loading: Boolean(wanted),
    error: false,
    notFound: Boolean(slug) && !wanted,
  });
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);
  const status = useRef(null);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    status.current = null;
    if (!wanted) {
      setState({ stream: null, serverOffset: 0, loading: false, error: false, notFound: Boolean(slug) });
      return undefined;
    }
    setState({ stream: null, serverOffset: 0, loading: true, error: false, notFound: false });

    // Per run, as in useLiveOverview: a run cleaned up during its first fetch
    // (StrictMode, or the slug changed) neither applies that answer nor arms
    // a poller its own cleanup can no longer reach.
    let cancelled = false;
    let stop = null;
    const fetchOnce = async () => {
      const res = await getJson(`${INDEX_URL}/${encodeURIComponent(wanted)}`);
      if (cancelled || !alive.current) return;
      if (res.ok && isObject(res.body) && isObject(res.body.stream)) {
        status.current = res.body.stream.status;
        const offset = offsetFrom(res.body);
        setState((prev) => ({
          stream: res.body.stream,
          serverOffset: offset ?? prev.serverOffset,
          loading: false,
          error: false,
          notFound: false,
        }));
        return;
      }
      if (res.status === 404) {
        status.current = null;
        setState({ stream: null, serverOffset: 0, loading: false, error: false, notFound: true });
        return;
      }
      // A failed poll keeps what is on screen; a failed first load is an error.
      setState((prev) => (prev.stream ? prev : { ...prev, loading: false, error: true }));
    };

    // Polling is armed only once the first answer is in: the cadence depends
    // on the status, and before the answer there is none (0 = do not poll).
    fetchOnce().then(() => {
      if (cancelled) return;
      stop = schedulePolling(fetchOnce, () => {
        const s = status.current;
        if (isLiveStatus(s)) return POLL_LIVE_MS;
        if (s === "SCHEDULED" || s === "OFFLINE" || s === "ERROR") return POLL_IDLE_MS;
        return 0;
      });
    });
    return () => {
      cancelled = true;
      alive.current = false;
      if (stop) stop();
    };
  }, [wanted, slug, attempt]);

  return { ...state, refresh };
}

/**
 * How near a start has to be for the schedule page to keep asking: a row
 * within a quarter of an hour either side of its start is one whose pill is
 * about to change ("Starting shortly" → "Live now"), so the page polls while
 * one is listed (review fix O7). Further off, the poller sleeps until the
 * nearest row enters that window, and at most this long.
 */
const SCHEDULE_WATCH_MS = 15 * 60_000;
const SCHEDULE_SLEEP_MAX_MS = 30 * 60_000;

export function useArchive(eventType, month, page) {
  const query = new URLSearchParams({ event_type: eventType, month, page: String(page) }).toString();
  const [state, setState] = useState({ streams: [], hasMore: false, timezone: "Asia/Kolkata", loading: true, error: false });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    getJson(`${INDEX_URL}/archive?${query}`).then((res) => {
      if (cancelled) return;
      if (res.ok && Array.isArray(res.body?.streams)) {
        setState({ streams: res.body.streams.filter(isObject), hasMore: res.body.has_more === true, timezone: res.body.timezone, loading: false, error: false });
      } else {
        setState((prev) => ({ ...prev, streams: [], hasMore: false, loading: false, error: true }));
      }
    });
    return () => { cancelled = true; };
  }, [query, attempt]);
  return { ...state, refresh };
}

/**
 * `{ streams, counts, window, filter, serverOffset, loading, error, refresh }`
 * for one schedule filter from `/api/live-streams/schedule?filter=`
 * (SPEC-PHASE2 §2.1). Fetched again whenever the filter changes — `streams`
 * keeps the previous answer while `loading` is true, so the page can dim the
 * list it has instead of blanking it (review fix F6); only a failed load
 * empties it, so the retry starts from skeletons again.
 *
 * Polled every 30 s while a listed broadcast is on air and every 60 s while
 * one is within a quarter of an hour of its start (so a pill turns into the
 * Live now group without a reload); otherwise the poller sleeps until the
 * nearest start comes into that window. A hidden tab pauses it and a tab
 * shown again asks at once.
 */
export function useSchedule(filter) {
  const key = normaliseFilter(filter);
  const [state, setState] = useState({ streams: [], counts: null, window: null, filter: key, serverOffset: 0, loading: true, error: false });
  const [attempt, setAttempt] = useState(0);
  const anyLive = useRef(false);
  // The listed starts (ms) and the offset to the server's clock, as the last
  // answer left them: the cadence is worked out when the poller re-arms, not
  // from the `starts_in_seconds` of an answer that is already a minute old.
  const starts = useRef([]);
  const offsetRef = useRef(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let stop = null;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    const fetchOnce = async () => {
      const res = await getJson(`${INDEX_URL}/schedule?filter=${encodeURIComponent(key)}`);
      if (cancelled) return false;
      if (res.ok && isObject(res.body)) {
        const streams = Array.isArray(res.body.streams) ? res.body.streams.filter(isObject) : [];
        anyLive.current = streams.some((s) => isLiveStatus(s.status));
        starts.current = streams.map((s) => Date.parse(String(s.scheduled_start_at ?? ""))).filter((n) => Number.isFinite(n));
        const offset = offsetFrom(res.body);
        if (offset !== null) offsetRef.current = offset;
        setState((prev) => ({
          streams,
          counts: isObject(res.body.counts) ? res.body.counts : null,
          window: isObject(res.body.window) ? res.body.window : null,
          filter: key,
          serverOffset: offset ?? prev.serverOffset,
          loading: false,
          error: false,
        }));
        return true;
      }
      // A failed poll keeps what is on screen; a failed load is an error, and
      // leaves nothing behind — the retry is a first load again.
      setState((prev) => (prev.loading ? { ...prev, streams: [], loading: false, error: true } : prev));
      return false;
    };
    const cadence = () => {
      if (anyLive.current) return POLL_LIVE_MS;
      const now = Date.now() + offsetRef.current;
      let sleep = 0;
      for (const at of starts.current) {
        const left = at - now;
        if (Math.abs(left) <= SCHEDULE_WATCH_MS) return POLL_IDLE_MS;
        if (left > SCHEDULE_WATCH_MS) sleep = sleep ? Math.min(sleep, left - SCHEDULE_WATCH_MS) : left - SCHEDULE_WATCH_MS;
      }
      return sleep ? Math.min(sleep, SCHEDULE_SLEEP_MAX_MS) : 0;
    };
    fetchOnce().then(() => {
      if (cancelled) return;
      stop = schedulePolling(fetchOnce, cadence);
    });
    return () => {
      cancelled = true;
      if (stop) stop();
    };
  }, [key, attempt]);

  return { ...state, refresh };
}

/**
 * `{ seconds, parts: { hh, mm, ss }, phase, valid }` counting down to an
 * instant by the server's clock (`Date.now() + serverOffset`), never the
 * device clock alone (SPEC-PHASE2 §2.1). One interval, cleared on unmount;
 * a hidden tab freezes it (nothing to see) and a tab shown again is
 * corrected at once. `phase` is "waiting", "soon" (under five minutes) or
 * "started" (the instant has passed); `valid` is false without an instant.
 */
export function useCountdown(startsAtIso, serverOffset = 0) {
  const target = Date.parse(String(startsAtIso ?? ""));
  const valid = Number.isFinite(target);
  const offset = Number.isFinite(serverOffset) ? serverOffset : 0;
  const remaining = () => (valid ? Math.max(0, Math.round((target - (Date.now() + offset)) / 1000)) : 0);
  const [seconds, setSeconds] = useState(remaining);

  useEffect(() => {
    if (!valid) {
      setSeconds(0);
      return undefined;
    }
    let timer = null;
    const clear = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const tick = () => {
      const left = Math.max(0, Math.round((target - (Date.now() + offset)) / 1000));
      setSeconds(left);
      if (left <= 0) clear();
      return left;
    };
    const run = () => {
      clear();
      if (tick() > 0) timer = setInterval(tick, 1000);
    };
    const onVisibility = () => (pageVisible() ? run() : clear());
    if (pageVisible()) run();
    else tick();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [target, offset, valid]);

  const phase = !valid || seconds <= 0 ? "started" : seconds < COUNTDOWN_SOON_SECONDS ? "soon" : "waiting";
  return { seconds, parts: countdownParts(seconds), phase, valid };
}

/**
 * True once an instant has passed by the server's clock, flipped by a timeout
 * at the instant itself rather than by the next poll (review fix F4): the
 * poster, the hero and the countdown all say "Starting shortly" together, not
 * up to a minute apart. False without a usable instant. The wait is re-armed
 * at most a minute at a time (a long wait, a device that slept, a tab shown
 * again), and a tab shown again re-checks at once.
 */
export function useStartPassed(startsAtIso, serverOffset = 0) {
  const target = Date.parse(String(startsAtIso ?? ""));
  const valid = Number.isFinite(target);
  const offset = Number.isFinite(serverOffset) ? serverOffset : 0;
  const [started, setStarted] = useState(() => valid && target <= Date.now() + offset);

  useEffect(() => {
    if (!valid) {
      setStarted(false);
      return undefined;
    }
    let timer = null;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      const left = target - (Date.now() + offset);
      setStarted(left <= 0);
      // A quarter of a second past the instant, so the flip is never a tick early.
      if (left > 0) timer = setTimeout(arm, Math.min(left + 250, 60_000));
    };
    const onVisibility = () => {
      if (pageVisible()) arm();
    };
    arm();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [target, offset, valid]);

  return valid && started;
}
