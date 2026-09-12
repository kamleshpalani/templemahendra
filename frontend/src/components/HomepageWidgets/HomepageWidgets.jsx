import { LuCalendarDays, LuClock, LuFlame, LuHeart, LuHourglass, LuMegaphone, LuMoon, LuPartyPopper, LuPin } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { SkeletonCards } from "../ui/Feedback";
import "./HomepageWidgets.css";

// ── Icon · badge tone · label per content_type ────────────────────────────────
// Accent tone drives the left stripe (.hw-card--tone-*) and the Badge tone.
// moon = lunar/panchangam content only · sage = auspicious-time content only.
const TYPE_META = {
  announcement: { Icon: LuMegaphone, tone: "gold", ta: "அறிவிப்பு", en: "Announcement" },
  upcoming_event: { Icon: LuPartyPopper, tone: "default", ta: "நிகழ்வு", en: "Upcoming Event" },
  coming_soon: { Icon: LuHourglass, tone: "sage", ta: "விரைவில்", en: "Coming Soon" },
  upcoming_pooja: { Icon: LuFlame, tone: "moon", ta: "அடுத்த பூஜை", en: "Upcoming Pooja" },
  calendar_pooja: { Icon: LuMoon, tone: "moon", ta: "பௌர்ணமி பூஜை", en: "Pournami Pooja" },
  nalla_neram: { Icon: LuClock, tone: "sage", ta: "நல்ல நேரம்", en: "Nalla Neram" },
  sponsor: { Icon: LuHeart, tone: "gold", ta: "ஸ்பான்சர்", en: "Sponsor" },
};
const STRIPE_TONE = { default: "maroon", gold: "gold", sage: "sage", moon: "moon" };

// ── Individual card ───────────────────────────────────────────────────────────
function WidgetCard({ widget, pournami, lang, index }) {
  const { t } = useLang();
  const meta = TYPE_META[widget.content_type] ?? TYPE_META.announcement;
  const { Icon } = meta;
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

  const ctaVariant = isFeatured ? "outline-light" : "outline";

  return (
    <article
      className={[
        "card",
        "hw-card",
        `hw-card--${widget.content_type}`,
        `hw-card--tone-${STRIPE_TONE[meta.tone] ?? "maroon"}`,
        isFeatured ? "card--ink hw-card--featured span-6" : "span-3",
        widget.is_pinned ? "hw-card--pinned" : "",
        "rise",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--i": index ?? 0 }}
    >
      {isFeatured && (
        <span className="hw-card__glyph" aria-hidden="true">
          <Icon />
        </span>
      )}

      {/* Type badge */}
      <Badge tone={meta.tone} className="hw-card__badge">
        <Icon aria-hidden="true" />
        {t(meta.ta, meta.en)}
        {widget.is_pinned && (
          <>
            <LuPin aria-hidden="true" />
            <span className="sr-only">{t("பின் செய்யப்பட்டது", "Pinned")}</span>
          </>
        )}
      </Badge>

      {/* Event-like rich display: upcoming_event, upcoming_pooja, coming_soon */}
      {isEventLike ? (
        <div className="hw-event">
          <h3 className="hw-card__title">{title}</h3>
          {displayDateStr && (
            <p className="hw-card__date">
              <LuCalendarDays aria-hidden="true" />
              {displayDateStr}
            </p>
          )}
          {desc && <p className="hw-card__desc">{desc}</p>}
          <div className="hw-card__cta">
            {isUpcomingPooja ? (
              <Button to="/sevas" variant={ctaVariant} size="sm">
                {t("சேவைகள் →", "View Sevas →")}
              </Button>
            ) : (
              <Button to="/events" variant={ctaVariant} size="sm">
                {t("அனைத்து நிகழ்வுகள் →", "All Events →")}
              </Button>
            )}
          </div>
        </div>
      ) : richP ? (
        /* Calendar Pooja: rich panchangam display */
        <div className="hw-pournami">
          <h3 className="hw-card__title">{title}</h3>
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
          <Badge tone={richP.daysLeft === 0 ? "gold" : "moon"} className="hw-pournami__badge">
            {richP.daysLeft === 0
              ? t("இன்று!", "Today!")
              : richP.daysLeft === 1
                ? t("நாளை", "Tomorrow")
                : t(`${richP.daysLeft} நாட்களில்`, `In ${richP.daysLeft} days`)}
          </Badge>
          <p className="hw-pournami__timing">
            <LuClock aria-hidden="true" />
            {t("நேரம்", "Timings")}: 04:00 PM – 09:00 PM
          </p>
        </div>
      ) : (
        /* Standard title for all other types */
        <h3 className="hw-card__title">{title}</h3>
      )}

      {/* Description (only for non-event-like types — event renders desc inline) */}
      {!isEventLike && desc && <p className="hw-card__desc">{desc}</p>}

      {/* Sponsor */}
      {widget.sponsor?.name && (
        <div className="hw-sponsor">
          <span className="hw-sponsor__icon" aria-hidden="true">
            <LuHeart />
          </span>
          <div className="hw-sponsor__body">
            <p className="hw-sponsor__label">{t("நன்கொடையாளர்", "Sponsored by")}</p>
            <p className="hw-sponsor__name">{widget.sponsor.name}</p>
            {widget.sponsor.note && <p className="hw-sponsor__note">{widget.sponsor.note}</p>}
          </div>
        </div>
      )}

      {/* Nalla Neram slots */}
      {widget.nalla_neram && (
        <div className="hw-nalla">
          <p className="hw-nalla__label">{t("இன்றைய நல்ல நேரம்", "Today's Nalla Neram")}</p>
          <div className="hw-nalla__slots">
            {widget.nalla_neram.map((slot, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <Badge key={i} tone="sage">
                <LuClock aria-hidden="true" />
                {slot[0]} – {slot[1]}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Panchangam CTA for calendar_pooja */}
      {isCalPooja && (
        <div className="hw-card__cta">
          <Button to="/panchangam" variant={ctaVariant} size="sm">
            {t("பஞ்சாங்கம் காண்க →", "View Panchangam →")}
          </Button>
        </div>
      )}
    </article>
  );
}

// ── Main exported component ───────────────────────────────────────────────────
/**
 * HomepageWidgets
 * Props:
 *   widgets   — array of widget objects from /api/homepage_widgets
 *   loading   — boolean
 *   pournami  — nearest pournami (legacy single prop)
 *   pournamis — next pournamis from the panchangam calendar
 *   lang      — "ta" | "en"
 */
export default function HomepageWidgets({
  widgets,
  loading,
  pournami,
  pournamis,
  lang,
}) {
  if (loading) return <SkeletonCards count={4} />;

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
    <div className={`bento hw-bento hw-bento--${allWidgets.length}`}>
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
  );
}
