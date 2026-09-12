import { LuCalendarClock, LuHammer } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { HISTORY } from "../../data/temple";
import Badge from "../ui/Badge";
import "./HistoryTimeline.css";

// ── Milestone status → BEM modifier + badge tone + pill label ─────────────────
// Keys match the `status` values used in data/temple.js HISTORY.timeline.
// Tones: in-progress → sage (work under way), planned → warning (still to come).
const STATUS_META = {
  inProgress: {
    mod: "in-progress",
    tone: "sage",
    Icon: LuHammer,
    ta: "கட்டப்பட்டு வருகிறது",
    en: "Under construction",
  },
  planned: {
    mod: "planned",
    tone: "warning",
    Icon: LuCalendarClock,
    ta: "திட்டமிடப்பட்டுள்ளது",
    en: "Planned",
  },
};

// ── Main exported component ───────────────────────────────────────────────────
/**
 * HistoryTimeline
 * Renders inside an existing .page-prose container (the page supplies the h2).
 * Props:
 *   id             — optional anchor id for the root element
 *   showParagraphs — render the salutation + narrative paragraphs (default true)
 *   showTimeline   — render the milestone timeline (default true)
 */
export default function HistoryTimeline({
  id,
  showParagraphs = true,
  showTimeline = true,
}) {
  const { lang, t } = useLang();

  return (
    <div className="history" id={id} lang={lang}>
      {showParagraphs && (
        <>
          <p className="history__salutation">
            {t(HISTORY.salutation.ta, HISTORY.salutation.en)}
          </p>
          {HISTORY.paragraphs.map((p) => (
            <p key={p.key}>
              {t(p.ta, p.en)}
            </p>
          ))}
        </>
      )}

      {/* role="list" restores the list semantics Safari/VoiceOver drop when
          list-style is none (see .timeline in the CSS). */}
      {showTimeline && (
        <ol
          className="timeline"
          role="list"
          aria-label={t("கால வரிசை", "Timeline")}
        >
          {HISTORY.timeline.map((m, i) => {
            const status = m.status ? STATUS_META[m.status] : null;
            const year = t(m.year.ta, m.year.en);
            const itemClass = [
              "timeline__item",
              status ? `timeline__item--${status.mod}` : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <li key={m.key} className={itemClass}>
                <div className="timeline__card card card--static rise" style={{ "--i": i }}>
                  <div className="timeline__head">
                    <p className="timeline__year">
                      {m.date ? <time dateTime={m.date}>{year}</time> : year}
                    </p>

                    {m.tamilDate && (
                      <Badge tone="gold" className="timeline__pill timeline__pill--tamil-date">
                        {t(m.tamilDate.ta, m.tamilDate.en)}
                      </Badge>
                    )}

                    {status && (
                      <Badge tone={status.tone} className={`timeline__pill timeline__pill--${status.mod}`}>
                        <status.Icon aria-hidden="true" />
                        {t(status.ta, status.en)}
                      </Badge>
                    )}
                  </div>

                  <h3 className="timeline__title">{t(m.title.ta, m.title.en)}</h3>
                  <p className="timeline__desc">{t(m.desc.ta, m.desc.en)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
