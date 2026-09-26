import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  LuCalendar,
  LuCalendarDays,
  LuChevronLeft,
  LuChevronRight,
  LuClock,
  LuHistory,
  LuLandmark,
  LuMapPin,
  LuMoon,
  LuMoveHorizontal,
  LuSparkles,
  LuStar,
} from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import PageHero from "../components/ui/PageHero";
import Seo from "../components/Seo";
import ShareButton from "../components/Share/ShareButton";
import SectionHeader from "../components/ui/SectionHeader";
import SegmentedControl from "../components/ui/Tabs";
import { EmptyState, SkeletonCards, SkeletonText } from "../components/ui/Feedback";
import { OBSERVANCES } from "../data/temple";
import { to12h, todayIST } from "../lib/templeTime";
import "./Events.css";

// Badge tone per event kind (Badge primitive tones — no raw colours). The
// database kinds (migration 020: festival / pooja / special / other) sit next
// to the computed lunar observances; `temple` is the plain temple event.
const BADGE_META = {
  pournami: { ta: "பௌர்ணமி", en: "Pournami", tone: "moon" },
  amavasai: { ta: "அமாவாசை", en: "Amavasai", tone: "default" },
  ekadasi: { ta: "ஏகாதசி", en: "Ekadasi", tone: "default" },
  sashti: { ta: "சஷ்டி", en: "Sashti", tone: "default" },
  pradosham: { ta: "பிரதோஷம்", en: "Pradosham", tone: "default" },
  chaturthi: { ta: "சதுர்த்தி", en: "Chaturthi", tone: "default" },
  festival: { ta: "திருவிழா", en: "Festival", tone: "gold" },
  pooja: { ta: "பூஜை", en: "Pooja", tone: "info" },
  special: { ta: "சிறப்பு நிகழ்வு", en: "Special", tone: "warning" },
  temple: { ta: "கோயில்", en: "Temple", tone: "gold" },
};
export const EVENT_TYPE_META = BADGE_META;

/** The badge key for one /api/events row: its type, or the plain temple badge. */
export function eventTypeKey(ev) {
  const type = ev?.event_type;
  return type === "festival" || type === "pooja" || type === "special" ? type : "temple";
}

/** A bilingual field in the reading language, falling back to the other one. */
export function eventText(ev, field, lang) {
  if (!ev) return "";
  const ta = ev[`${field}_ta`];
  const en = ev[`${field}_en`];
  return (lang === "ta" ? ta || en : en || ta) || ev[field] || "";
}

/**
 * "24 Jan 2026", "24–26 Jan 2026" or "30 Jan – 2 Feb 2026", in the reading
 * language, for an event's first day and optional last day.
 */
export function eventDateLabel(from, until, lang) {
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  const a = new Date(`${from}T00:00:00`);
  if (Number.isNaN(a.getTime())) return from ?? "";
  const full = (d) => d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  if (!until || until === from) return full(a);
  const b = new Date(`${until}T00:00:00`);
  if (Number.isNaN(b.getTime())) return full(a);
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${b.toLocaleDateString(locale, { month: "short", year: "numeric" })}`;
  }
  return `${full(a)} – ${full(b)}`;
}

/** "7:00 AM – 9:00 PM" from the API's HH:MM times, or "" when there are none. */
export function eventTimeLabel(ev) {
  if (!ev?.start_time && !ev?.end_time) return "";
  const clock = (t) => (t ? to12h(t) : "");
  if (ev.start_time && ev.end_time) return `${clock(ev.start_time)} – ${clock(ev.end_time)}`;
  return clock(ev.start_time || ev.end_time);
}

/** Evening slot shown on every Pournami tile when the API omits `time`. */
const POURNAMI_TIME = "4:00 PM – 9:00 PM";

/** How many past events the archive segment asks for. */
const PAST_LIMIT = 24;

/** Locale-aware view model for one /pournamis row (keeps the computed fields). */
function pournamiView(p, lang) {
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  const d = new Date(p.date + "T00:00:00");
  return {
    dayNum: d.getDate(),
    monthStr: d.toLocaleDateString(locale, { month: "short" }),
    yearNum: d.getFullYear(),
    longDate: d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }),
    tamMonth: lang === "ta" ? p.tamil_month?.ta : p.tamil_month?.en,
    weekday: lang === "ta" ? p.weekday_ta : p.weekday_en,
    time: p.time || POURNAMI_TIME,
  };
}

// ── Hero aside: the next Pournami at a glance ────────────────────────────────
function NextPournami({ pournami, loading, lang, t }) {
  if (loading) {
    return (
      <div className="events-hero__next events-hero__next--skeleton" aria-hidden="true">
        <SkeletonText lines={2} />
      </div>
    );
  }
  if (!pournami) return null;
  const v = pournamiView(pournami, lang);
  const label = t("அடுத்த பௌர்ணமி பூஜை", "Next Pournami Poojai");
  return (
    <div className="events-hero__next" role="group" aria-label={label}>
      <span className="events-hero__next-label">
        <LuMoon aria-hidden="true" /> {label}
      </span>
      <time className="events-hero__next-date" dateTime={pournami.date}>
        {v.longDate}
      </time>
      {(v.weekday || v.tamMonth) && (
        <span className="events-hero__next-meta">{[v.weekday, v.tamMonth].filter(Boolean).join(" · ")}</span>
      )}
      <span className="events-hero__next-time">
        <LuClock aria-hidden="true" /> {v.time}
      </span>
    </div>
  );
}

// ── Pournami dates strip (dark ink panel, lunar accent) ─────────────────────
function PournamiStrip({ pournamis, lang, t, todayStr, nextDate }) {
  const rowRef = useRef(null);
  if (!pournamis || pournamis.length === 0) return null;

  const scrollRow = (dir) => {
    const el = rowRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * Math.max(220, el.clientWidth * 0.8), behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <section
      className="card card--ink card--static events-moon on-dark"
      aria-labelledby="events-moon-title"
      data-surface="dark"
    >
      <div className="events-moon__head">
        <span className="events-moon__glyph" aria-hidden="true">
          <LuMoon />
        </span>
        <div className="events-moon__text">
          <Badge tone="moon">{t("பஞ்சாங்கம்", "Panchangam")}</Badge>
          <h2 id="events-moon-title" className="events-moon__title">
            {t("பௌர்ணமி பூஜை — அடுத்த திகதிகள்", "Pournami Poojai — Upcoming Dates")}
          </h2>
          <p className="events-moon__meta">
            {t(
              "பஞ்சாங்கம் படி கணக்கிடப்பட்டது · மாலை 4:00 – 9:00 மணி",
              "Computed from Panchangam · Evening 4:00 PM – 9:00 PM",
            )}
          </p>
          <p className="events-moon__desc">{t(OBSERVANCES.pournami.desc.ta, OBSERVANCES.pournami.desc.en)}</p>
        </div>
        <div className="events-moon__tools">
          <span className="events-moon__hint">
            <LuMoveHorizontal aria-hidden="true" /> {t("பக்கவாட்டில் உருட்டவும்", "Scroll sideways")}
          </span>
          <div className="events-moon__arrows">
            <Button
              variant="outline-light"
              iconOnly
              icon={<LuChevronLeft aria-hidden="true" />}
              onClick={() => scrollRow(-1)}
            >
              {t("முந்தைய தேதிகள்", "Previous dates")}
            </Button>
            <Button
              variant="outline-light"
              iconOnly
              icon={<LuChevronRight aria-hidden="true" />}
              onClick={() => scrollRow(1)}
            >
              {t("அடுத்த தேதிகள்", "Next dates")}
            </Button>
          </div>
        </div>
      </div>

      <ol
        ref={rowRef}
        className="events-moon__row"
        role="list"
        tabIndex={0}
        aria-label={t("பௌர்ணமி தேதிகள்", "Pournami dates")}
      >
        {pournamis.map((p, i) => {
          const v = pournamiView(p, lang);
          const isToday = p.date === todayStr;
          const isNext = !isToday && p.date === nextDate;
          return (
            <li
              key={p.date}
              className={`events-moon__tile rise${isToday || isNext ? " events-moon__tile--next" : ""}`}
              style={{ "--i": Math.min(i, 10) }}
              aria-current={isToday ? "date" : undefined}
            >
              <time className="events-moon__date" dateTime={p.date}>
                <span className="events-moon__day">{v.dayNum}</span>
                <span className="events-moon__month">{v.monthStr}</span>
                <span className="events-moon__year">{v.yearNum}</span>
              </time>
              <div className="events-moon__info">
                {(isToday || isNext) && (
                  <Badge tone="moon" className="events-moon__flag">
                    {isToday ? t("இன்று", "Today") : t("அடுத்தது", "Next")}
                  </Badge>
                )}
                {v.tamMonth && <p className="events-moon__tmonth">🪔 {v.tamMonth}</p>}
                {v.weekday && <p className="events-moon__weekday">{v.weekday}</p>}
                <p className="events-moon__time">
                  <LuClock aria-hidden="true" /> {v.time}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ── Featured event: the soonest featured upcoming event, led large ──────────
function FeaturedEvent({ event, lang, t }) {
  const title = eventText(event, "title", lang);
  const desc = eventText(event, "description", lang);
  const venue = eventText(event, "venue", lang);
  const time = eventTimeLabel(event);
  const meta = BADGE_META[eventTypeKey(event)];
  return (
    <article
      className={`card card--static events-featured rise${event.image_url ? " events-featured--with-image" : ""}`}
      aria-labelledby="events-featured-title"
    >
      {event.image_url && (
        <div className="events-featured__media">
          <img src={event.image_url} alt="" loading="lazy" decoding="async" />
        </div>
      )}
      <div className="events-featured__body">
        <div className="events-featured__badges">
          <Badge tone="gold">
            <LuStar aria-hidden="true" /> {t("சிறப்பு நிகழ்வு", "Featured")}
          </Badge>
          <Badge tone={meta.tone}>{t(meta.ta, meta.en)}</Badge>
        </div>
        <h3 id="events-featured-title" className="events-featured__title">
          <Link to={`/events/${event.id}`}>{title}</Link>
        </h3>
        <ul className="events-featured__meta" role="list">
          <li>
            <LuCalendarDays aria-hidden="true" />
            <time dateTime={event.event_date}>{eventDateLabel(event.event_date, event.end_date, lang)}</time>
          </li>
          {time && (
            <li>
              <LuClock aria-hidden="true" /> {time}
            </li>
          )}
          {venue && (
            <li>
              <LuMapPin aria-hidden="true" /> {venue}
            </li>
          )}
        </ul>
        {desc && <p className="events-featured__desc">{desc}</p>}
        <div className="events-featured__actions">
          <Button to={`/events/${event.id}`} variant="primary" size="sm">
            {t("விவரங்கள் →", "Details →")}
          </Button>
          <ShareButton
            variant="ghost"
            size="sm"
            title={title}
            text={desc || eventDateLabel(event.event_date, event.end_date, lang)}
            to={`/events/${event.id}`}
          />
        </div>
      </div>
    </article>
  );
}

export default function Events() {
  const [templeEvents, setTempleEvents] = useState([]);
  const [pastEvents, setPastEvents] = useState(null); // null until the archive is asked for
  const [pastLoading, setPastLoading] = useState(false);
  const [pournamis, setPournamis] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // all | pournami | temple | festival | past
  const { lang, t } = useLang();

  useEffect(() => {
    // Upcoming (today onwards, multi-day events included while they run); the
    // archive is fetched separately, only when the visitor asks for it.
    const eventsReq = api
      .get("/events?upcoming=1&limit=100")
      .then((r) => setTempleEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});

    // Single call for all pournami dates (replaces 24 separate /calendar calls)
    const pournamiReq = api
      .get("/pournamis?months=13")
      .then((r) => setPournamis(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});

    Promise.all([eventsReq, pournamiReq]).finally(() => setLoading(false));
  }, []);

  // The archive, newest first, loaded the first time the segment is chosen.
  useEffect(() => {
    if (filter !== "past" || pastEvents !== null || pastLoading) return;
    setPastLoading(true);
    api
      .get(`/events?past=1&limit=${PAST_LIMIT}`)
      .then((r) => setPastEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => setPastEvents([]))
      .finally(() => setPastLoading(false));
  }, [filter, pastEvents, pastLoading]);

  // The temple's own day (IST), not the UTC date: between midnight and 05:30
  // IST toISOString() still names yesterday, which kept an expired Pournami
  // as "next" and flagged the wrong tile "Today" (D-026).
  const todayStr = todayIST();

  // The Pournamis still ahead of the temple's day. The server already answers
  // from its own IST today, but a page left open past midnight (or a cached
  // answer) must not keep offering a full moon that has gone (brief §10).
  const upcomingPournamis = useMemo(() => pournamis.filter((p) => p.date >= todayStr), [pournamis, todayStr]);

  // Static fallback for temple events (used when API returns nothing). These
  // have no row behind them, so they never link to an event page.
  const fallbackTemple = [
    {
      id: 1,
      title_ta: "தைப்பூசம்",
      title_en: "Thai Poosam",
      event_date: "2026-01-24",
      description_ta: "முருகன் திருவிழா — கவாடி ஊர்வலம்.",
      description_en:
        "Grand festival celebrating Murugan with kavadi procession.",
      badge: "temple",
      isFallback: true,
    },
    {
      id: 2,
      title_ta: "மகா சிவராத்திரி",
      title_en: "Maha Shivaratri",
      event_date: "2026-02-26",
      description_ta:
        "ஒவ்வொரு மஹா சிவராத்திரி அன்று நமது குல மக்கள் வந்து தரிசனம் செய்து வருகின்றார்கள். அன்று அன்னதானமும் நடைபெற்று வருகின்றது.",
      description_en:
        "Every Maha Shivaratri, our clan members gather for darshan, and annadanam is offered on that day.",
      badge: "temple",
      isFallback: true,
    },
    {
      id: 3,
      title_ta: "பங்குனி உத்திரம்",
      title_en: "Panguni Uthiram",
      event_date: "2026-03-31",
      description_ta: "தெய்வீக திருமண திருவிழா.",
      description_en:
        "Sacred festival of divine weddings and celestial unions.",
      badge: "temple",
      isFallback: true,
    },
  ];

  const templeSource =
    templeEvents.length > 0
      ? templeEvents.map((e) => ({ ...e, badge: eventTypeKey(e), isCalendar: false }))
      : fallbackTemple;

  // Convert pournamis API data to event-row format for the merged list
  const pournamiEvents = useMemo(
    () =>
      upcomingPournamis.map((p) => ({
        id: `pournami-${p.date}`,
        title_ta: p.title_ta,
        title_en: p.title_en,
        event_date: p.date,
        description_ta: p.desc_ta,
        description_en: p.desc_en,
        time: p.time,
        badge: "pournami",
        isCalendar: true,
      })),
    [upcomingPournamis],
  );

  // Merged + sorted list, today onwards only (an event still running counts).
  // The committee's featured events lead (brief §6 Events: "featured event"),
  // then everything in date order.
  const merged = useMemo(() => {
    const all = [
      ...templeSource.filter((e) => (e.end_date || e.event_date) >= todayStr),
      ...pournamiEvents,
    ];
    const seen = new Set();
    const lead = (e) => (!e.isCalendar && e.is_featured ? 0 : 1);
    return all
      .filter((e) => {
        const key = `${e.event_date}-${e.badge}-${e.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => lead(a) - lead(b) || a.event_date.localeCompare(b.event_date));
  }, [templeSource, pournamiEvents, todayStr]);

  // The archive rows carry the same shape as the merged list.
  const archive = useMemo(
    () => (pastEvents ?? []).map((e) => ({ ...e, badge: eventTypeKey(e), isCalendar: false, isPast: true })),
    [pastEvents],
  );

  const filtered = useMemo(() => {
    if (filter === "past") return archive;
    if (filter === "temple") return merged.filter((e) => !e.isCalendar);
    if (filter === "festival") return merged.filter((e) => e.badge === "festival");
    if (filter === "pournami")
      return merged.filter((e) => e.badge === "pournami");
    return merged;
  }, [merged, archive, filter]);

  // Counts for the filter pills (mirror the filter predicates above)
  const counts = useMemo(
    () => ({
      all: merged.length,
      pournami: merged.filter((e) => e.badge === "pournami").length,
      temple: merged.filter((e) => !e.isCalendar).length,
      festival: merged.filter((e) => e.badge === "festival").length,
      past: pastEvents === null ? undefined : archive.length,
    }),
    [merged, archive, pastEvents],
  );

  // The soonest featured upcoming event, led large above the timeline.
  const featured = useMemo(
    () => (templeEvents.length > 0 ? merged.find((e) => !e.isCalendar && e.is_featured) ?? null : null),
    [templeEvents, merged],
  );

  // First Pournami on/after today — drives the hero aside and the "Next" tile flag
  const nextPournami = useMemo(() => {
    if (upcomingPournamis.length === 0) return null;
    return upcomingPournamis.reduce((a, b) => (b.date < a.date ? b : a));
  }, [upcomingPournamis]);

  // Named once: the hero shows them, <Seo> puts them in the page's description
  // and its preview card, and the share sheet passes them to WhatsApp.
  const heading = t("நிகழ்வுகள் & திருவிழாக்கள்", "Events & Festivals");
  const lead = t(
    "பவுர்ணமி பூஜைகள், திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகள் — ஒரே இடத்தில்.",
    "Pournami poojas, festivals and special occasions — all in one place.",
  );

  const filterItems = [
    {
      value: "all",
      label: t("அனைத்தும்", "All"),
      count: loading ? undefined : counts.all,
      icon: <LuCalendarDays aria-hidden="true" />,
    },
    {
      value: "pournami",
      label: t("பௌர்ணமி பூஜை", "Pournami Poojai"),
      count: loading ? undefined : counts.pournami,
      icon: <LuMoon aria-hidden="true" />,
    },
    {
      value: "temple",
      label: t("கோயில் நிகழ்வு", "Temple Events"),
      count: loading ? undefined : counts.temple,
      icon: <LuLandmark aria-hidden="true" />,
    },
    {
      value: "festival",
      label: t("திருவிழாக்கள்", "Festivals"),
      count: loading ? undefined : counts.festival,
      icon: <LuSparkles aria-hidden="true" />,
    },
    {
      value: "past",
      label: t("முடிந்த நிகழ்வுகள்", "Past events"),
      count: counts.past,
      icon: <LuHistory aria-hidden="true" />,
    },
  ];

  const showingPast = filter === "past";
  const listLoading = loading || (showingPast && (pastLoading || pastEvents === null));

  return (
    <>
      <Seo title={t("நிகழ்வுகள்", "Events")} description={lead} />

      <PageHero
        variant="events"
        eyebrow={t("பஞ்சாங்க அடிப்படையில்", "Panchangam-based calendar")}
        title={heading}
        lead={lead}
        crumbs={[{ label: t("நிகழ்வுகள்", "Events") }]}
        actions={<ShareButton variant="outline-light" title={heading} text={lead} />}
        aside={<NextPournami pournami={nextPournami} loading={loading} lang={lang} t={t} />}
      />

      <section className="section events-page">
        <div className="container">
          {/* Pournami dates from Panchangam — always visible at top */}
          {loading ? (
            <SkeletonCards count={1} className="events-moon-skeleton" />
          ) : (
            <PournamiStrip
              pournamis={upcomingPournamis}
              lang={lang}
              t={t}
              todayStr={todayStr}
              nextDate={nextPournami?.date}
            />
          )}

          {!loading && featured && !showingPast && <FeaturedEvent event={featured} lang={lang} t={t} />}

          <SectionHeader
            align="split"
            eyebrow={showingPast ? t("பதிவேடு", "Archive") : t("நாட்காட்டி", "Calendar")}
            title={showingPast ? t("முடிந்த நிகழ்வுகள்", "Past events") : t("வரவிருக்கும் நிகழ்வுகள்", "Upcoming Events")}
            subtitle={
              showingPast
                ? t("சமீபத்தில் நடந்த கோயில் நிகழ்வுகள் — புதியது முதலில்.", "Recent temple events, newest first.")
                : t(
                    "பௌர்ணமி பூஜைகளும் கோயில் திருவிழாக்களும் — சிறப்பு நிகழ்வுகள் முதலில், பிறகு தேதி வரிசையில்.",
                    "Pournami poojas and temple festivals — featured events first, then in date order.",
                  )
            }
            actions={
              <SegmentedControl
                className="events-filter"
                label={t("நிகழ்வுகளை வடிகட்டு", "Filter events")}
                items={filterItems}
                value={filter}
                onChange={setFilter}
              />
            }
          />

          {listLoading ? (
            <SkeletonCards count={4} className="events-timeline events-timeline--skeleton" />
          ) : (
            <>
              <p className="sr-only" role="status" aria-live="polite">
                {t(`${filtered.length} நிகழ்வுகள் காட்டப்படுகின்றன`, `Showing ${filtered.length} events`)}
              </p>

              {filtered.length === 0 && (
                <EmptyState
                  icon={showingPast ? <LuHistory /> : <LuCalendar />}
                  title={showingPast ? t("முடிந்த நிகழ்வுகள் இல்லை", "No past events yet") : t("நிகழ்வுகள் இல்லை", "No upcoming events")}
                  action={
                    filter !== "all" && (
                      <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
                        {t("அனைத்து நிகழ்வுகளையும் காட்டு", "Show all events")}
                      </Button>
                    )
                  }
                >
                  {showingPast
                    ? t(
                        "நடந்து முடிந்த நிகழ்வுகள் இங்கே பதிவேடாகக் காட்டப்படும்.",
                        "Events that have taken place will be kept here as an archive.",
                      )
                    : t(
                        "புதிய நிகழ்வுகள் அறிவிக்கப்படும் போது இங்கே காண்பிக்கப்படும்.",
                        "New events will appear here as soon as they are announced.",
                      )}
                </EmptyState>
              )}

              {filtered.length > 0 && (
                <ol className={`events-timeline${showingPast ? " events-timeline--past" : ""}`} role="list">
                  {filtered.map((ev, i) => {
                    const d = new Date(ev.event_date + "T00:00:00");
                    const day = String(d.getDate()).padStart(2, "0");
                    // The month in the reading language, as every other date on
                    // the page is (it was always English, even in Tamil).
                    const month = d.toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN", {
                      month: "short",
                    });
                    const year = d.getFullYear();
                    // Either language when the reading one is blank, so a
                    // card is never an empty heading.
                    const title = eventText(ev, "title", lang);
                    const desc = eventText(ev, "description", lang);
                    const venue = ev.isCalendar ? "" : eventText(ev, "venue", lang);
                    const time = ev.time || (ev.isCalendar ? "" : eventTimeLabel(ev));
                    const span = ev.end_date && ev.end_date !== ev.event_date ? eventDateLabel(ev.event_date, ev.end_date, lang) : "";
                    const linked = !ev.isCalendar && !ev.isFallback;
                    const badgeMeta = BADGE_META[ev.badge] ?? BADGE_META.temple;
                    return (
                      <li
                        key={ev.id}
                        className="events-timeline__node rise"
                        style={{ "--i": Math.min(i, 10) }}
                        data-kind={ev.badge}
                      >
                        <article className={`card card--static events-item${linked ? " events-item--linked" : ""}`}>
                          <time className="events-item__date" dateTime={ev.event_date}>
                            <span className="events-item__day">{day}</span>
                            <span className="events-item__month">{month}</span>
                            <span className="events-item__year">{year}</span>
                          </time>
                          <div className="events-item__body">
                            <div className="events-item__head">
                              <h3 className="events-item__title">
                                {linked ? <Link to={`/events/${ev.id}`}>{title}</Link> : title}
                              </h3>
                              <span className="events-item__badges">
                                {ev.is_featured && !ev.isPast && (
                                  <Badge tone="gold">
                                    <LuStar aria-hidden="true" /> {t("சிறப்பு", "Featured")}
                                  </Badge>
                                )}
                                <Badge tone={badgeMeta.tone}>{t(badgeMeta.ta, badgeMeta.en)}</Badge>
                              </span>
                            </div>
                            {desc && <p className="events-item__desc">{desc}</p>}
                            {(span || time || venue) && (
                              <p className="events-item__time">
                                {span && (
                                  <span className="events-item__meta">
                                    <LuCalendarDays aria-hidden="true" /> {span}
                                  </span>
                                )}
                                {time && (
                                  <span className="events-item__meta">
                                    <LuClock aria-hidden="true" /> {time}
                                  </span>
                                )}
                                {venue && (
                                  <span className="events-item__meta">
                                    <LuMapPin aria-hidden="true" /> {venue}
                                  </span>
                                )}
                              </p>
                            )}
                          </div>
                        </article>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
