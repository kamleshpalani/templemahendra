import { useState } from "react";
import { Link } from "react-router-dom";
import { LuCalendarDays, LuLandmark } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import LiveStatusBadge from "./LiveStatusBadge";
import StreamCountdown from "./StreamCountdown";
import {
  dayLabel,
  deityName,
  eventTypeLabel,
  formatStreamDate,
  formatStreamTime,
  startsInSeconds,
  streamInstant,
  streamTitle,
  templeShortName,
} from "../../lib/live";
import "./Live.css";

/** A card counts down only inside the last day before its start (SPEC-PHASE2 §2.2). */
const COUNTDOWN_WINDOW_SECONDS = 24 * 3600;

/**
 * StreamCard — one broadcast in a grid: the upcoming ones under the player
 * and every row of the schedule (SPEC-PHASE1 §5.2, SPEC-PHASE2 §2.2). The
 * whole card is the link to its page. It carries the status badge, the day
 * ("Today", "Tomorrow", or the weekday and date) with the time, and — for a
 * scheduled broadcast within the next day — a short countdown in minutes.
 */
export default function StreamCard({ stream, lang, index = 0, serverOffset = 0, recording = false }) {
  const { t } = useLang();
  const thumb = stream.thumbnail_url || stream.banner_url || null;
  const [broken, setBroken] = useState(false);
  const tz = stream.timezone || "Asia/Kolkata";
  const when = recording ? stream.actual_end_at || stream.scheduled_start_at : streamInstant(stream);
  const day = when ? (recording ? formatStreamDate(when, lang, tz) : dayLabel(stream, lang, serverOffset)) : "";
  const time = formatStreamTime(when, lang, tz);
  const deity = deityName(stream, lang);
  const kind = eventTypeLabel(stream, lang);
  const left = stream.status === "SCHEDULED" ? startsInSeconds(stream, serverOffset) : null;
  const soon = left !== null && left < COUNTDOWN_WINDOW_SECONDS;

  return (
    <Link to={`/live-darshan/${stream.slug}`} className="card card--interactive live-card rise" style={{ "--i": Math.min(index, 8) }}>
      <div className="live-card__thumb">
        {thumb && !broken ? (
          <img className="live-card__thumb-img" src={thumb} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <img className="live-card__emblem" src="/logo.svg" alt="" width="120" height="120" />
        )}
        <LiveStatusBadge status={stream.status} onDark className="live-card__badge" />
      </div>
      <div className="live-card__body">
        {kind && <span className="live-card__kind">{kind}</span>}
        <h3 className="live-card__title">{streamTitle(stream, lang)}</h3>
        <p className="live-card__line">
          <LuLandmark aria-hidden="true" />
          <span>
            {templeShortName(stream, lang)}
            {deity ? ` · ${deity}` : ""}
          </span>
        </p>
        {day && (
          <p className="live-card__line live-card__when">
            <LuCalendarDays aria-hidden="true" />
            <time dateTime={when}>
              {day}
              {time ? ` · ${time}` : ""}
            </time>
          </p>
        )}
        {soon && (
          <StreamCountdown compact startsAt={stream.scheduled_start_at} serverOffset={serverOffset} t={t} lang={lang} className="live-card__soon" />
        )}
        {recording
          ? <span className="live-card__kind">{t("பதிவைப் பார்க்க", "Watch the recording")}</span>
          : <span className="sr-only">{t("விவரங்களைப் பார்க்க", "View details")}</span>}
      </div>
    </Link>
  );
}
