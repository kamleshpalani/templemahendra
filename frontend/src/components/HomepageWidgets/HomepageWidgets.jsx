import { Link } from "react-router-dom";
import { useLang } from "../../context/LangContext";
import "./HomepageWidgets.css";

// ── Icon + label map ──────────────────────────────────────────────────────────
const TYPE_META = {
  announcement: { icon: "📢", ta: "அறிவிப்பு", en: "Announcement" },
  upcoming_event: { icon: "🎉", ta: "நிகழ்வு", en: "Upcoming Event" },
  coming_soon: { icon: "⏳", ta: "விரைவில்", en: "Coming Soon" },
  upcoming_pooja: { icon: "🛕", ta: "அடுத்த பூஜை", en: "Upcoming Pooja" },
  calendar_pooja: { icon: "🌕", ta: "பௌர்ணமி பூஜை", en: "Pournami Pooja" },
  nalla_neram: { icon: "⏰", ta: "நல்ல நேரம்", en: "Nalla Neram" },
  sponsor: { icon: "💛", ta: "ஸ்பான்சர்", en: "Sponsor" },
};

// ── Individual card ───────────────────────────────────────────────────────────
function WidgetCard({ widget, pournami, lang, index }) {
  const { t } = useLang();
  const meta = TYPE_META[widget.content_type] ?? TYPE_META.announcement;
  const isCalPooja = widget.content_type === "calendar_pooja";
  const isUpcomingEvent = widget.content_type === "upcoming_event";
  const isUpcomingPooja =
    widget.content_type === "upcoming_pooja" ||
    widget.content_type === "coming_soon";
  const isEventLike = isUpcomingEvent || isUpcomingPooja;
  const isFeatured = index === 0; // first card always gets featured treatment
  // Use panchangam pournami data to enrich calendar_pooja cards
  const richP = isCalPooja && pournami ? pournami : null;

  const title = t(widget.title_ta, widget.title_en) || t(meta.ta, meta.en);
  const desc = t(widget.description_ta, widget.description_en);

  // Resolve the display date: upcoming_event uses event_date; upcoming_pooja/coming_soon uses pooja.date
  const rawDate = widget.event_date ?? widget.pooja?.date ?? null;
  const displayDateStr =
    isEventLike && rawDate
      ? new Date(rawDate + "T00:00:00").toLocaleDateString(
          lang === "ta" ? "ta-IN" : "en-IN",
          { weekday: "long", day: "numeric", month: "long", year: "numeric" },
        )
      : null;

  return (
    <div
      className={[
        "hw-card",
        `hw-card--${widget.content_type}`,
        `hw-card--pos-${(index ?? 0) + 1}`,
        widget.is_pinned ? "hw-card--pinned" : "",
        isFeatured ? "hw-card--featured" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Type badge — hidden for event-like, calendar, and upcoming_pooja types
          (they render their own badge inside the rich layout) */}
      {!isEventLike && widget.content_type !== "calendar_pooja" && (
        <span className={`hw-badge hw-badge--${widget.content_type}`}>
          {meta.icon} {t(meta.ta, meta.en)}
          {widget.is_pinned && " 📌"}
        </span>
      )}

      {/* Event-like rich display: upcoming_event, upcoming_pooja, coming_soon */}
      {isEventLike ? (
        <div className="hw-event">
          <div className="hw-event__icon">{meta.icon}</div>
          <div className="hw-event__body">
            <span className={`hw-badge hw-badge--${widget.content_type}`}>
              {t(meta.ta, meta.en)}
              {widget.is_pinned && " 📌"}
            </span>
            <p className="hw-event__title">{title}</p>
            {displayDateStr && (
              <p className="hw-event__date">📅 {displayDateStr}</p>
            )}
            {desc && <p className="hw-event__desc">{desc}</p>}
            <div className="hw-card__cta">
              {isUpcomingPooja ? (
                <Link to="/sevas" className="btn btn-outline btn--sm">
                  {t("சேவைகள் →", "View Sevas →")}
                </Link>
              ) : (
                <Link to="/events" className="btn btn-outline btn--sm">
                  {t("அனைத்து நிகழ்வுகள் →", "All Events →")}
                </Link>
              )}
            </div>
          </div>
        </div>
      ) : richP ? (
        /* Calendar Pooja: rich panchangam display */
        <div className="hw-pournami">
          <div className="hw-pournami__moon">🌕</div>
          <div className="hw-pournami__body">
            <p className="hw-pournami__name">{title}</p>
            <p className="hw-pournami__date">
              {new Date(richP.date + "T00:00:00").toLocaleDateString(
                lang === "ta" ? "ta-IN" : "en-IN",
                {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                },
              )}
            </p>
            {richP.tamil_month && (
              <p className="hw-pournami__meta">
                {t(richP.tamil_month.ta, richP.tamil_month.en)}
                {richP.tithi_ta && <> – {t(richP.tithi_ta, richP.tithi_en)}</>}
              </p>
            )}
            <span
              className={`hw-pournami__badge${richP.daysLeft === 0 ? " hw-pournami__badge--today" : ""}`}
            >
              {richP.daysLeft === 0
                ? t("இன்று!", "Today!")
                : richP.daysLeft === 1
                  ? t("நாளை", "Tomorrow")
                  : t(
                      `${richP.daysLeft} நாட்களில்`,
                      `In ${richP.daysLeft} days`,
                    )}
            </span>
            <p className="hw-pournami__timing">
              ⏰ {t("நேரம்", "Timings")}: 04:00 PM – 09:00 PM
            </p>
          </div>
        </div>
      ) : (
        /* Standard title for all other types */
        <div className="hw-card__header">
          <span className="hw-card__icon" aria-hidden="true">
            {meta.icon}
          </span>
          <div>
            <p className="hw-card__title">{title}</p>
          </div>
        </div>
      )}

      {/* Description (only for non-event-like types — event renders desc inline) */}
      {!isEventLike && desc && <p className="hw-card__desc">{desc}</p>}

      {/* Sponsor */}
      {widget.sponsor?.name && (
        <div className="hw-sponsor">
          <span className="hw-sponsor__icon">💛</span>
          <div>
            <p className="hw-sponsor__label">
              {t("நன்கொடையாளர்", "Sponsored by")}
            </p>
            <p className="hw-sponsor__name">{widget.sponsor.name}</p>
            {widget.sponsor.note && (
              <p className="hw-sponsor__note">{widget.sponsor.note}</p>
            )}
          </div>
        </div>
      )}

      {/* Nalla Neram slots */}
      {widget.nalla_neram && (
        <div>
          <p
            style={{
              fontSize: "0.72rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "#065f46",
              marginBottom: "0.3rem",
            }}
          >
            {t("இன்றைய நல்ல நேரம்", "Today's Nalla Neram")}
          </p>
          <div className="hw-nalla">
            {widget.nalla_neram.map((slot, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={i} className="hw-nalla__slot">
                ⏰ {slot[0]} – {slot[1]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Panchangam CTA for calendar_pooja */}
      {isCalPooja && (
        <div className="hw-card__cta">
          <Link to="/panchangam" className="btn btn-outline btn--sm">
            {t("பஞ்சாங்கம் காண்க →", "View Panchangam →")}
          </Link>
        </div>
      )}
    </div>
  );
}

// ── Skeleton placeholder ──────────────────────────────────────────────────────
function WidgetSkeleton() {
  return (
    <div className="hw-grid">
      <div className="hw-skeleton" />
      <div className="hw-skeleton" />
    </div>
  );
}

// ── Main exported component ───────────────────────────────────────────────────
/**
 * HomepageWidgets
 * Props:
 *   widgets  — array of widget objects from /api/homepage_widgets
 *   loading  — boolean
 */
export default function HomepageWidgets({
  widgets,
  loading,
  pournami,
  pournamis,
  lang,
}) {
  if (loading) return <WidgetSkeleton />;

  const dbWidgets = widgets && widgets.length > 0 ? widgets : [];
  const calPournamis =
    pournamis && pournamis.length > 0 ? pournamis : pournami ? [pournami] : [];

  // Synthesise one calendar_pooja card per pournami that isn't already
  // covered by any DB widget that has the same pooja date (any type)
  const dbPoojaDates = new Set(
    dbWidgets.filter((w) => w.pooja?.date).map((w) => w.pooja.date),
  );
  const synthCards = calPournamis
    .filter((p) => !dbPoojaDates.has(p.date))
    .map((p, i) => ({
      id: `pournami-synth-${p.date}`,
      content_type: "calendar_pooja",
      title_ta: "பௌர்ணமி பூஜை",
      title_en: "Pournami Poojai",
      description_ta: null,
      description_en: null,
      is_pinned: i === 0, // pin the nearest one
      priority: i + 1,
      _pournami: p, // carry the panchangam data
    }));

  const allWidgets = [...dbWidgets, ...synthCards].slice(0, 4);
  if (allWidgets.length === 0) return null;

  return (
    <div className="hw-section">
      <div className="hw-grid">
        {allWidgets.map((w, idx) => {
          // Resolve which pournami object to pass for enrichment:
          // synth cards carry _pournami; DB calendar_pooja cards match by date
          const cardPournami =
            w._pournami ??
            calPournamis.find(
              (p) =>
                w.content_type === "calendar_pooja" && w.pooja?.date === p.date,
            ) ??
            (w.content_type === "calendar_pooja" ? calPournamis[0] : null);
          return (
            <WidgetCard
              key={w.id ? String(w.id) : `${w.content_type}-${idx}`}
              widget={w}
              pournami={cardPournami}
              lang={lang}
              index={idx}
            />
          );
        })}
      </div>
    </div>
  );
}
