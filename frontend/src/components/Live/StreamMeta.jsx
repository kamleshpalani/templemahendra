import { Link } from "react-router-dom";
import { LuCalendarDays, LuClock, LuFlame, LuFlower2, LuHeart, LuLandmark, LuLink, LuRadio } from "react-icons/lu";
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
 * (SPEC-PHASE1 §5.2): temple, deity, programme, the pooja or event it is part
 * of (brief §12, migration 022) with the pooja's sponsor when the family
 * agreed to be named (§6), date, time in the stream's own zone and status.
 * Share moved to the action row under the player (StreamActions, Phase 4).
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

const pick = (lang, ta, en) => (lang === "ta" ? String(ta ?? "").trim() || String(en ?? "").trim() : String(en ?? "").trim() || String(ta ?? "").trim());

/** "15 September 2026" / "15 செப்டம்பர் 2026" for a plain calendar date (YYYY-MM-DD), no zone shift. */
function plainDate(ymd, lang) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ""))) return "";
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(d);
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
  const pooja = stream.pooja && typeof stream.pooja === "object" ? stream.pooja : null;
  const event = stream.event && typeof stream.event === "object" ? stream.event : null;
  const sponsor = stream.sponsor && typeof stream.sponsor === "object" && String(stream.sponsor.name ?? "").trim() ? stream.sponsor : null;
  const poojaName = pooja ? pick(lang, pooja.name_ta, pooja.name_en) : "";
  const eventTitle = event ? pick(lang, event.title_ta, event.title_en) : "";
  const poojaDate = pooja ? plainDate(pooja.date, lang) : "";
  const eventDate = event ? plainDate(event.date, lang) : "";

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
        {(poojaName || eventTitle) && (
          <Row icon={<LuLink aria-hidden="true" />} label={t("இதன் பகுதி", "Part of")}>
            {poojaName && (
              <span className="live-meta__link-line" data-part-of="pooja">
                <Link to="/sevas" className="live-meta__link">{poojaName}</Link>
                {(poojaDate || pooja.time) && (
                  <span className="live-meta__sub">{[poojaDate, pooja.time].filter(Boolean).join(" · ")}</span>
                )}
              </span>
            )}
            {eventTitle && (
              <span className="live-meta__link-line" data-part-of="event">
                <Link to={event && event.id ? `/events/${event.id}` : "/events"} className="live-meta__link">{eventTitle}</Link>
                {eventDate && <span className="live-meta__sub">{eventDate}</span>}
              </span>
            )}
          </Row>
        )}
        {sponsor && (
          <Row icon={<LuHeart aria-hidden="true" />} label={t("உபயம்", "Sponsored by")}>
            <span data-sponsor>{String(sponsor.name).trim()}</span>
            {sponsor.note && String(sponsor.note).trim() && <span className="live-meta__sub">{String(sponsor.note).trim()}</span>}
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
