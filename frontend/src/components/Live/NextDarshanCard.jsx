import { LuArrowRight, LuCalendarClock, LuCalendarDays, LuTv } from "react-icons/lu";
import Button from "../ui/Button";
import StreamCountdown from "./StreamCountdown";
import {
  dayLabel,
  deityName,
  eventTypeLabel,
  formatStreamTime,
  streamDescription,
  streamTitle,
  templeShortName,
} from "../../lib/live";
import "./Live.css";

/**
 * NextDarshanCard — "Next Live Darshan · Evening Deeparadhana · Today • 6:30 PM
 * IST · [countdown] · [View schedule] [Details]" (SPEC-PHASE2 §2.2).
 *
 * Used on /live-darshan when nothing is live (the poster above it, this card
 * carrying the title as the page's h2) and on the homepage (compact, an h3
 * under the section's own heading). The countdown counts from the server's
 * clock; the day says "Today" / "Tomorrow" / the weekday and date.
 */
export default function NextDarshanCard({
  stream,
  serverOffset = 0,
  t,
  lang = "ta",
  heading = "h3",
  compact = false,
  showDescription = false,
  className = "",
}) {
  const Heading = heading;
  const tz = stream.timezone || "Asia/Kolkata";
  const when = stream.scheduled_start_at || null;
  const day = dayLabel(stream, lang, serverOffset);
  const time = when ? formatStreamTime(when, lang, tz) : "";
  const kind = eventTypeLabel(stream, lang);
  const deity = deityName(stream, lang);
  const description = showDescription ? streamDescription(stream, lang) : "";

  return (
    <div className={`card card--solid card--static live-next${compact ? " live-next--compact" : ""} ${className}`.trim()}>
      <div className="live-next__body">
        <span className="live-next__eyebrow">
          <LuTv aria-hidden="true" />
          {t("அடுத்த நேரடி தரிசனம்", "Next Live Darshan")}
        </span>
        <Heading className="live-next__title">{streamTitle(stream, lang)}</Heading>
        <p className="live-next__when">
          <LuCalendarClock aria-hidden="true" />
          <time dateTime={when ?? undefined}>
            {day}
            {time ? ` • ${time}` : ""}
          </time>
        </p>
        <p className="live-next__line">{[kind, templeShortName(stream, lang), deity].filter(Boolean).join(" · ")}</p>
        {description && <p className="live-next__desc">{description}</p>}
      </div>
      <StreamCountdown startsAt={when} serverOffset={serverOffset} t={t} lang={lang} className="live-next__countdown" />
      <div className="live-next__actions">
        <Button to="/live-darshan/schedule" variant="primary" size="sm" icon={<LuCalendarDays aria-hidden="true" />}>
          {t("அட்டவணையைப் பார்க்க", "View schedule")}
        </Button>
        <Button to={`/live-darshan/${stream.slug}`} variant="outline" size="sm" trailingIcon={<LuArrowRight aria-hidden="true" />}>
          {t("விவரங்கள்", "Details")}
        </Button>
      </div>
    </div>
  );
}
