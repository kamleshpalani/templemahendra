import { LuCalendarDays, LuClock, LuFlame, LuFlower2, LuLandmark, LuRadio } from "react-icons/lu";
import LiveStatusBadge from "./LiveStatusBadge";
import {
  deityName,
  eventTypeLabel,
  formatStreamDate,
  formatStreamRange,
  formatStreamTime,
  isLiveStatus,
  templeName,
} from "../../lib/live";
import "./Live.css";

/**
 * StreamMeta — the facts about one broadcast as a definition list
 * (SPEC-PHASE1 §5.2): temple, deity, programme, date, time in the stream's
 * own zone and status. Share moved to the action row under the player
 * (StreamActions, Phase 4).
 */

function Row({ icon, label, children }) {
  return (
    <div className="live-meta__row">
      <dt>
        {icon}
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function StreamMeta({ stream, lang, t }) {
  const tz = stream.timezone || "Asia/Kolkata";
  // Date and Time are both the schedule (one instant, so they never disagree
  // across midnight); when the broadcast actually started is the sub-line.
  const when = stream.scheduled_start_at ?? stream.actual_start_at ?? null;
  const date = formatStreamDate(when, lang, tz);
  const range = formatStreamRange(stream.scheduled_start_at, stream.scheduled_end_at, lang, tz) || formatStreamTime(when, lang, tz);
  const started = isLiveStatus(stream.status) && stream.actual_start_at ? formatStreamTime(stream.actual_start_at, lang, tz) : "";
  const ended = stream.status === "COMPLETED" && stream.actual_end_at ? formatStreamTime(stream.actual_end_at, lang, tz) : "";
  const deity = deityName(stream, lang);
  const kind = eventTypeLabel(stream, lang);

  return (
    <div className="card card--solid card--static live-meta-card">
      <span className="live-meta-card__eyebrow">{t("ஒளிபரப்பு விவரங்கள்", "Broadcast details")}</span>
      <dl className="live-meta">
        <Row icon={<LuLandmark aria-hidden="true" />} label={t("கோயில்", "Temple")}>
          {templeName(stream, lang)}
        </Row>
        {deity && (
          <Row icon={<LuFlower2 aria-hidden="true" />} label={t("தெய்வம்", "Deity")}>
            {deity}
          </Row>
        )}
        {kind && (
          <Row icon={<LuFlame aria-hidden="true" />} label={t("நிகழ்ச்சி", "Programme")}>
            {kind}
          </Row>
        )}
        {date && (
          <Row icon={<LuCalendarDays aria-hidden="true" />} label={t("தேதி", "Date")}>
            <time dateTime={when}>{date}</time>
          </Row>
        )}
        {range && (
          <Row icon={<LuClock aria-hidden="true" />} label={t("நேரம்", "Time")}>
            {range}
            {started && <span className="live-meta__sub">{t(`தொடங்கியது ${started}`, `Started ${started}`)}</span>}
            {ended && <span className="live-meta__sub">{t(`முடிந்தது ${ended}`, `Ended ${ended}`)}</span>}
          </Row>
        )}
        <Row icon={<LuRadio aria-hidden="true" />} label={t("நிலை", "Status")}>
          <LiveStatusBadge status={stream.status} />
        </Row>
      </dl>
    </div>
  );
}
