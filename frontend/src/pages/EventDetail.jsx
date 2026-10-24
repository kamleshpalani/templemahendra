import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { LuArrowLeft, LuCalendar, LuCalendarDays, LuClock, LuMapPin, LuStar } from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import PageHero from "../components/ui/PageHero";
import Seo, { templePlace } from "../components/Seo";
import ShareButton from "../components/Share/ShareButton";
import { EmptyState, ErrorState, SkeletonText } from "../components/ui/Feedback";
import { absoluteUrl, siteOrigin } from "../lib/share";
import { useSiteSettings } from "../lib/siteSettings";
import { EVENT_TYPE_META, eventDateLabel, eventText, eventTimeLabel, eventTypeKey } from "./Events";
import "./EventDetail.css";

/**
 * /events/:id — one temple event on its own page (brief §6): its title and
 * programme in the reading language, when and where it takes place, its
 * picture when it has one, and a share button whose link comes back here.
 *
 * The server answers this address honestly too: api/spa.php says 404 once the
 * event is hidden or gone, and api/og.php previews it for WhatsApp with the
 * same words and the same schema.org Event record, so the page and its
 * preview cannot disagree.
 */

/** The temple's clock: every event date and time on the site is IST. */
const IST_OFFSET = "+05:30";

/** ISO 8601 for a day, with the time of day when the committee gave one. */
function eventInstant(date, time) {
  if (!date) return null;
  return time ? `${date}T${time}:00${IST_OFFSET}` : date;
}

/**
 * The schema.org Event record for one event (brief §22): the words the page
 * shows, the dates the row holds, the temple as the place. `endDate` is the
 * last day (with its time when given), or the same day's end time, and is
 * left out when the committee gave neither. api/og.php writes the same.
 */
export function eventJsonLd(event, { name, description, site, lang, url }) {
  const startDate = eventInstant(event.event_date, event.start_time);
  const endDate = eventInstant(event.end_date || (event.end_time ? event.event_date : null), event.end_time);
  const record = { "@context": "https://schema.org", "@type": "Event", name };
  if (description) record.description = description;
  if (startDate) record.startDate = startDate;
  if (endDate) record.endDate = endDate;
  record.eventStatus = "https://schema.org/EventScheduled";
  record.eventAttendanceMode = "https://schema.org/OfflineEventAttendanceMode";
  record.location = templePlace(site, lang);
  if (event.image_url) record.image = absoluteUrl(event.image_url);
  record.url = url;
  return record;
}

export default function EventDetail() {
  const { id } = useParams();
  const { lang, t } = useLang();
  const { site } = useSiteSettings();
  const wanted = /^[0-9]{1,10}$/.test(id ?? "") ? id : null;
  const [state, setState] = useState({ event: null, loading: Boolean(wanted), error: false, notFound: !wanted });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!wanted) {
      setState({ event: null, loading: false, error: false, notFound: true });
      return undefined;
    }
    let alive = true;
    setState({ event: null, loading: true, error: false, notFound: false });
    api
      .get(`/events/${wanted}`)
      .then((r) => {
        if (!alive) return;
        const ok = r.data && typeof r.data === "object" && typeof r.data.id === "number";
        setState({ event: ok ? r.data : null, loading: false, error: !ok, notFound: false });
      })
      .catch((err) => {
        if (!alive) return;
        const gone = err?.response?.status === 404;
        setState({ event: null, loading: false, error: !gone, notFound: gone });
      });
    return () => {
      alive = false;
    };
  }, [wanted, attempt]);

  const { event, loading, error, notFound } = state;
  const pageTitle = t("நிகழ்வுகள்", "Events");
  const title = event ? eventText(event, "title", lang) : "";
  const description = event ? eventText(event, "description", lang) : "";
  const venue = event ? eventText(event, "venue", lang) : "";
  const when = event ? eventDateLabel(event.event_date, event.end_date, lang) : "";
  const time = event ? eventTimeLabel(event) : "";
  const meta = event ? EVENT_TYPE_META[eventTypeKey(event)] : null;
  const todayStr = new Date().toISOString().slice(0, 10);
  const isPast = Boolean(event) && (event.end_date || event.event_date) < todayStr;

  // The preview says what the page says: the date first, then the programme.
  const seoTitle = notFound ? t("நிகழ்வு கிடைக்கவில்லை", "Event not found") : title || pageTitle;
  const seoDescription = notFound || !event ? "" : [when, description].filter(Boolean).join(" · ");
  const shareText = [when, venue, description].filter(Boolean).join(" · ");
  const jsonLd = event
    ? eventJsonLd(event, { name: title, description, site, lang, url: `${siteOrigin()}/events/${event.id}` })
    : null;

  return (
    <>
      <Seo
        title={seoTitle}
        description={seoDescription}
        image={event?.image_url || undefined}
        imageAlt={event ? title : undefined}
        type={event ? "article" : "website"}
        canonicalPath={`/events/${wanted ?? ""}`}
        robots={notFound || error ? "noindex, nofollow" : undefined}
        jsonLd={jsonLd}
      />

      <PageHero
        variant="events"
        eyebrow={meta ? t(meta.ta, meta.en) : t("கோயில் நிகழ்வு", "Temple event")}
        title={event ? title : notFound ? t("நிகழ்வு கிடைக்கவில்லை", "Event not found") : pageTitle}
        lead={event ? [when, venue].filter(Boolean).join(" · ") : undefined}
        crumbs={[{ label: pageTitle, to: "/events" }, { label: event ? title : t("நிகழ்வு", "Event") }]}
        actions={
          <>
            {event && <ShareButton variant="outline-light" title={title} text={shareText} to={`/events/${event.id}`} />}
            <Button to="/events" variant="outline-light" icon={<LuArrowLeft aria-hidden="true" />}>
              {t("அனைத்து நிகழ்வுகளும்", "All events")}
            </Button>
          </>
        }
      />

      <section className="section">
        <div className="container container--narrow">
          {loading && (
            <div className="card card--static event-detail" aria-busy="true">
              <p className="sr-only" role="status">
                {t("ஏற்றுகிறது…", "Loading…")}
              </p>
              <SkeletonText lines={4} />
            </div>
          )}

          {!loading && error && (
            <ErrorState onRetry={() => setAttempt((n) => n + 1)} title={t("நிகழ்வை ஏற்ற முடியவில்லை", "Couldn't load this event")} />
          )}

          {!loading && !error && notFound && (
            <EmptyState
              icon={<LuCalendar />}
              title={t("அந்த நிகழ்வு கிடைக்கவில்லை", "That event was not found")}
              action={
                <Button to="/events" variant="primary" size="sm" icon={<LuCalendarDays aria-hidden="true" />}>
                  {t("நிகழ்வுகளுக்குச் செல்ல", "Go to Events")}
                </Button>
              }
            >
              {t(
                "இந்த இணைப்பு பழையதாக இருக்கலாம், அல்லது நிகழ்வு நீக்கப்பட்டிருக்கலாம்.",
                "The link may be old, or the event was removed.",
              )}
            </EmptyState>
          )}

          {!loading && !error && event && (
            <article className="card card--static event-detail rise" aria-labelledby="event-detail-title">
              {event.image_url && (
                <figure className="event-detail__media">
                  <img src={event.image_url} alt={title} loading="eager" decoding="async" />
                </figure>
              )}
              <div className="event-detail__body">
                <div className="event-detail__badges">
                  {event.is_featured && !isPast && (
                    <Badge tone="gold">
                      <LuStar aria-hidden="true" /> {t("சிறப்பு நிகழ்வு", "Featured")}
                    </Badge>
                  )}
                  {meta && <Badge tone={meta.tone}>{t(meta.ta, meta.en)}</Badge>}
                  {isPast && <Badge tone="muted">{t("முடிந்தது", "Past event")}</Badge>}
                </div>
                <h2 id="event-detail-title" className="event-detail__title">
                  {title}
                </h2>

                <dl className="event-detail__facts">
                  <div className="event-detail__fact">
                    <dt>
                      <LuCalendarDays aria-hidden="true" /> {t("தேதி", "Date")}
                    </dt>
                    <dd>
                      <time dateTime={event.event_date}>{when}</time>
                    </dd>
                  </div>
                  {time && (
                    <div className="event-detail__fact">
                      <dt>
                        <LuClock aria-hidden="true" /> {t("நேரம்", "Time")}
                      </dt>
                      <dd>{time}</dd>
                    </div>
                  )}
                  {venue && (
                    <div className="event-detail__fact">
                      <dt>
                        <LuMapPin aria-hidden="true" /> {t("இடம்", "Venue")}
                      </dt>
                      <dd>{venue}</dd>
                    </div>
                  )}
                </dl>

                {description ? (
                  <div className="event-detail__desc">
                    {description.split(/\n+/).map((para, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <p key={i}>{para}</p>
                    ))}
                  </div>
                ) : (
                  <p className="event-detail__desc event-detail__desc--muted">
                    {t("இந்த நிகழ்வுக்கான விவரங்கள் விரைவில் சேர்க்கப்படும்.", "Details for this event will be added soon.")}
                  </p>
                )}

                <div className="event-detail__actions">
                  <ShareButton variant="outline" title={title} text={shareText} to={`/events/${event.id}`} />
                  <Button to="/events" variant="ghost" icon={<LuArrowLeft aria-hidden="true" />}>
                    {t("நிகழ்வுகளுக்குத் திரும்ப", "Back to events")}
                  </Button>
                </div>
              </div>
            </article>
          )}
        </div>
      </section>
    </>
  );
}
