import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LuCalendarDays, LuCalendarX, LuTv, LuYoutube } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import ShareButton from "../components/Share/ShareButton";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import ScheduleFilters from "../components/Live/ScheduleFilters";
import StreamCard from "../components/Live/StreamCard";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import { dayBucket, formatStreamDate, isLiveStatus, normaliseFilter, useSchedule, weekIsOneDay, zoneLabel } from "../lib/live";
import "../components/Live/Live.css";
import "./LiveSchedule.css";

/**
 * /live-darshan/schedule — every broadcast the temple has planned, by day
 * (docs/live/SPEC-PHASE2.md §2.3).
 *
 * Five filters — Today · Tomorrow · This week · Festivals · All — each a
 * window the server computes on the temple's own clock, so a devotee in
 * Leicester and one in Pudupatti see the same "today". The chosen filter is
 * in the address (`?filter=`), so a link to "this week's schedule" can be
 * shared. Broadcasts that are on air lead the list; the rest are grouped
 * under their day, and a scheduled one within the next day counts down.
 */

/** The §1.3 strings, exactly as backend/includes/site_pages.php carries them. */
const PAGE_TITLE = ["நேரடி தரிசன அட்டவணை", "Live Darshan schedule"];
const PAGE_DESCRIPTION = [
  "இன்று, நாளை மற்றும் இந்த வாரத்தின் நேரடி பூஜைகள், அபிஷேகங்கள் மற்றும் திருவிழா ஒளிபரப்புகளின் அட்டவணை.",
  "The schedule of live poojas, abhishekams and festival broadcasts for today, tomorrow and this week.",
];

/** What an empty filter says, and where its button takes the visitor. */
const EMPTY = {
  today: {
    title: ["இன்று நேரடி தரிசனம் இல்லை", "No live darshan today"],
    text: ["இந்த வாரத்தின் அட்டவணையைப் பாருங்கள்.", "See this week's schedule."],
    to: "week",
    cta: ["இந்த வார அட்டவணை", "This week's schedule"],
  },
  tomorrow: {
    title: ["நாளை நேரடி தரிசனம் இல்லை", "No live darshan tomorrow"],
    text: ["இந்த வாரத்தின் அட்டவணையைப் பாருங்கள்.", "See this week's schedule."],
    to: "week",
    cta: ["இந்த வார அட்டவணை", "This week's schedule"],
  },
  week: {
    title: ["இந்த வாரம் நேரடி தரிசனம் இல்லை", "No live darshan this week"],
    text: ["வரவிருக்கும் அனைத்து ஒளிபரப்புகளையும் பாருங்கள்.", "See every upcoming broadcast."],
    to: "all",
    cta: ["அனைத்தையும் காண", "See all"],
  },
  festivals: {
    title: ["திருவிழா ஒளிபரப்பு எதுவும் திட்டமிடப்படவில்லை", "No festival broadcast is scheduled"],
    text: ["வரவிருக்கும் அனைத்து ஒளிபரப்புகளையும் பாருங்கள்.", "See every upcoming broadcast."],
    to: "all",
    cta: ["அனைத்தையும் காண", "See all"],
  },
  all: {
    title: ["அடுத்த 90 நாட்களில் நேரடி தரிசனம் எதுவும் திட்டமிடப்படவில்லை", "No live darshan is scheduled in the next 90 days"],
    text: [
      "கமிட்டி ஒரு ஒளிபரப்பைத் திட்டமிட்டதும் அது இங்கே தோன்றும். அதுவரை கோயிலின் YouTube சேனலைப் பார்க்கலாம்.",
      "When the committee schedules a broadcast it will appear here. Until then, visit the temple's YouTube channel.",
    ],
    to: null,
  },
};

/** "Tuesday, 15 September 2026 · IST" or "15 September – 13 December 2026 · IST" for the filter's window. */
function windowText(win, lang) {
  if (!win?.from || !win?.to) return "";
  const tz = win.timezone || "Asia/Kolkata";
  const from = new Date(win.from);
  const last = new Date(Date.parse(win.to) - 1); // `to` is exclusive: the last instant inside is a millisecond before it
  if (Number.isNaN(from.getTime()) || Number.isNaN(last.getTime())) return "";
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  const fmt = (d, options) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZone: tz, ...options }).format(d);
    } catch {
      return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Kolkata", ...options }).format(d);
    }
  };
  const ymd = { year: "numeric", month: "2-digit", day: "2-digit" };
  const text =
    fmt(from, ymd) === fmt(last, ymd)
      ? fmt(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : `${fmt(from, { day: "numeric", month: "long" })} – ${fmt(last, { day: "numeric", month: "long", year: "numeric" })}`;
  return `${text} · ${zoneLabel(tz)}`;
}

/**
 * The list as the page shows it: broadcasts on air first under "Live now",
 * then one group per local day (the API already orders the rows), and any
 * without a date last.
 */
function groupByDay(streams, lang, serverOffset, t) {
  const groups = [];
  const byKey = new Map();
  for (const s of streams) {
    const live = isLiveStatus(s.status);
    const key = live ? "live" : s.local?.date || "undated";
    let group = byKey.get(key);
    if (!group) {
      let title;
      let tone = "";
      if (live) {
        title = t("இப்போது நேரலை", "Live now");
        tone = "live";
      } else if (key === "undated") {
        title = t("தேதி விரைவில் அறிவிக்கப்படும்", "Date to be announced");
      } else {
        const date = formatStreamDate(s.scheduled_start_at, lang, s.timezone || "Asia/Kolkata");
        const bucket = dayBucket(s, serverOffset);
        title = bucket === "today" ? `${t("இன்று", "Today")} · ${date}` : bucket === "tomorrow" ? `${t("நாளை", "Tomorrow")} · ${date}` : date;
      }
      group = { key, title, tone, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(s);
  }
  return groups;
}

export default function LiveSchedule() {
  const { lang, t } = useLang();
  const [params, setParams] = useSearchParams();
  const filter = normaliseFilter(params.get("filter"));
  const { streams, counts, window: win, serverOffset, loading, error, refresh } = useSchedule(filter);

  // The filter lives in the address (replace, so Back leaves the page, not the filter).
  const setFilter = (next) => {
    const p = new URLSearchParams(params);
    p.set("filter", normaliseFilter(next));
    setParams(p, { replace: true });
  };

  const groups = useMemo(() => groupByDay(streams, lang, serverOffset, t), [streams, lang, serverOffset, t]);

  // Spoken once per answer: how many programmes the chosen filter shows.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (loading || error) return;
    const n = streams.length;
    setAnnouncement(n === 1 ? t("1 நிகழ்ச்சி காட்டப்படுகிறது", "Showing 1 programme") : t(`${n} நிகழ்ச்சிகள் காட்டப்படுகின்றன`, `Showing ${n} programmes`));
  }, [streams, loading, error, t]);

  const title = t(...PAGE_TITLE);
  const lead = t(...PAGE_DESCRIPTION);
  const range = windowText(win, lang);

  /*
   * The empty state's way out. On a Sunday "this week" is today alone, so
   * Today's and Tomorrow's offer of "this week" would be the same one-day
   * window (and could never hold tomorrow): both send the visitor to every
   * upcoming broadcast instead (review fix O11).
   */
  const base = EMPTY[filter] ?? EMPTY.all;
  const empty = base.to === "week" && weekIsOneDay(win) ? { ...base, to: EMPTY.week.to, text: EMPTY.week.text, cta: EMPTY.week.cta } : base;

  /*
   * A filter that is fetching keeps the list it has, dimmed and marked busy;
   * skeletons belong to the first load and to a retry after an error
   * (review fix F6).
   */
  const firstLoad = loading && streams.length === 0;
  const refreshing = loading && streams.length > 0;

  return (
    <>
      <Seo title={title} description={lead} />

      <PageHero
        variant="live"
        eyebrow={t(TEMPLE.name.ta, TEMPLE.name.en)}
        title={title}
        lead={lead}
        crumbs={[{ label: t("நேரடி தரிசனம்", "Live Darshan"), to: "/live-darshan" }, { label: t("அட்டவணை", "Schedule") }]}
        actions={
          <>
            <Button to="/live-darshan" variant="outline-light" size="sm" icon={<LuTv aria-hidden="true" />}>
              {t("நேரடி தரிசனம்", "Live darshan")}
            </Button>
            {/* What is shared is what is on screen: the chosen filter travels with the link (review fix O13). */}
            <ShareButton
              variant="outline-light"
              title={title}
              text={lead}
              to={filter === "all" ? "/live-darshan/schedule" : `/live-darshan/schedule?filter=${filter}`}
            />
          </>
        }
      />

      <section className="section live-schedule">
        <div className="container">
          <div className="live-schedule__bar">
            <ScheduleFilters value={filter} counts={counts} onChange={setFilter} t={t} />
            {range && <p className="live-schedule__window">{range}</p>}
          </div>

          {loading && (
            <p className="sr-only" role="status">
              {t("ஏற்றுகிறது…", "Loading…")}
            </p>
          )}
          {firstLoad && <SkeletonCards count={3} className="grid-3 live-schedule__skeleton" />}

          {!loading && error && (
            <ErrorState onRetry={refresh} title={t("அட்டவணையை ஏற்ற முடியவில்லை", "Couldn't load the schedule")} />
          )}

          {!loading && !error && streams.length === 0 && (
            <EmptyState
              icon={<LuCalendarX />}
              className="live-schedule__empty"
              title={t(...empty.title)}
              action={
                empty.to ? (
                  <Button variant="primary" size="sm" icon={<LuCalendarDays aria-hidden="true" />} onClick={() => setFilter(empty.to)}>
                    {t(...empty.cta)}
                  </Button>
                ) : (
                  <>
                    <Button to="/live-darshan" variant="primary" size="sm" icon={<LuTv aria-hidden="true" />}>
                      {t("நேரடி தரிசனம்", "Live darshan")}
                    </Button>
                    <Button
                      href={TEMPLE.youtube.channelUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="outline"
                      size="sm"
                      icon={<LuYoutube aria-hidden="true" />}
                    >
                      {t("YouTube சேனல்", "YouTube channel")}
                    </Button>
                  </>
                )
              }
            >
              {t(...empty.text)}
            </EmptyState>
          )}

          {!error && groups.length > 0 && (
            <div className={`live-schedule__list${refreshing ? " live-schedule__list--busy" : ""}`} aria-busy={refreshing ? "true" : undefined}>
              {groups.map((g) => (
                <section key={g.key} className="live-schedule__day" aria-labelledby={`live-day-${g.key}`}>
                  <h2 id={`live-day-${g.key}`} className={`live-schedule__day-title${g.tone === "live" ? " live-schedule__day-title--live" : ""}`}>
                    <span>{g.title}</span>
                    <span className="live-schedule__day-count">
                      {g.items.length === 1 ? t("1 நிகழ்ச்சி", "1 programme") : t(`${g.items.length} நிகழ்ச்சிகள்`, `${g.items.length} programmes`)}
                    </span>
                  </h2>
                  <div className="grid-3">
                    {g.items.map((s, i) => (
                      <StreamCard key={s.slug} stream={s} lang={lang} index={i} serverOffset={serverOffset} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </section>
    </>
  );
}
