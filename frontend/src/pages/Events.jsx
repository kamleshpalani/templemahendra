import { useEffect, useState } from "react";
import { LuCalendarDays, LuFlame, LuFlower2, LuMoon, LuMegaphone } from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import SectionHeader from "../components/ui/SectionHeader";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import HomepageWidgets from "../components/HomepageWidgets/HomepageWidgets";
import { SkeletonCards } from "../components/ui/Feedback";
import { to12h } from "../lib/templeTime";
import "./Events.css";

// Shared with EventDetail so a linked card and its detail page agree.
export const EVENT_TYPE_META = {
  festival: { ta: "திருவிழா", en: "Festival", tone: "gold" },
  pooja: { ta: "பூஜை", en: "Pooja", tone: "info" },
  special: { ta: "சிறப்பு நிகழ்வு", en: "Special", tone: "warning" },
  temple: { ta: "கோயில்", en: "Temple", tone: "gold" },
};

export function eventTypeKey(ev) {
  const type = ev?.event_type;
  return type === "festival" || type === "pooja" || type === "special" ? type : "temple";
}

export function eventText(ev, field, lang) {
  if (!ev) return "";
  const ta = ev[`${field}_ta`];
  const en = ev[`${field}_en`];
  return (lang === "ta" ? ta || en : en || ta) || ev[field] || "";
}

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

export function eventTimeLabel(ev) {
  if (!ev?.start_time && !ev?.end_time) return "";
  if (ev.start_time && ev.end_time) return `${to12h(ev.start_time)} – ${to12h(ev.end_time)}`;
  return to12h(ev.start_time || ev.end_time);
}

export const poojaCard = (p) => ({
  id: `pooja-${p.id}`, content_type: (p.pooja_type || p.type) === "pournami" ? "calendar_pooja" : "upcoming_pooja",
  title_ta: p.name_ta, title_en: p.name_en, description_ta: p.description_ta, description_en: p.description_en,
  pooja: {
    id: p.id, date: p.pooja_date || p.date, time: p.pooja_time || p.time, type: p.pooja_type || p.type,
    sponsorship_amount: p.sponsorship_amount, sponsorship_available: p.sponsorship_available,
  },
  image_url: p.banner_url,
  sponsor: p.sponsor,
});

export default function Events() {
  const { t, lang } = useLang();
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    setData(null);
    Promise.all([api.get("/events?upcoming=1&limit=100"), api.get("/pooja-schedule"), api.get("/announcements?limit=50")])
      .then(([events, poojas, notices]) => {
        if (active) setData({
          events: Array.isArray(events.data) ? events.data : [],
          poojas: Array.isArray(poojas.data) ? poojas.data : [],
          notices: Array.isArray(notices.data) ? notices.data : [],
        });
      })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [retry]);
  const poojas = (data?.poojas ?? []).filter((p) => (p.pooja_type || p.type) !== "amavasai");
  const pournami = poojas.filter((p) => (p.pooja_type || p.type) === "pournami");
  const other = poojas.filter((p) => (p.pooja_type || p.type) !== "pournami");
  const eventCards = (data?.events ?? []).map((e) => ({
    id: `event-${e.id}`, content_type: "upcoming_event", title_ta: e.title_ta, title_en: e.title_en,
    description_ta: eventText(e, "description", "ta"), description_en: eventText(e, "description", "en"), event_date: e.event_date,
    event: {
      id: e.id, date: e.event_date, time: eventTimeLabel(e),
      date_label: eventDateLabel(e.event_date, e.end_date, lang),
      venue_ta: e.venue_ta, venue_en: e.venue_en,
    },
    image_url: e.image_url,
  }));
  const sections = [
    { id: "next-scheduled-pooja", Icon: LuFlame, title: t("அடுத்த திட்டமிட்ட பூஜை", "Next Scheduled Pooja"),
      cards: other.map(poojaCard), empty: t("புதிய சிறப்பு பூஜைகள் விரைவில் அறிவிக்கப்படும்.", "New special poojas will be listed when announced.") },
    { id: "pournami-schedule", Icon: LuMoon, title: t("பௌர்ணமி பூஜை அட்டவணை", "Pournami Pooja Schedule"),
      cards: pournami.map(poojaCard), empty: t("உறுதி செய்யப்பட்ட தேதிகள் விரைவில்.", "Confirmed Pournami pooja dates will be announced here.") },
    { id: "temple-events", Icon: LuCalendarDays, title: t("கோயில் நிகழ்வுகள்", "Temple Events"),
      cards: eventCards, empty: t("புதிய நிகழ்வுகள் விரைவில்.", "Upcoming temple activities will be announced here.") },
    { id: "temple-notices", Icon: LuMegaphone, title: t("அறிவிப்புகள்", "Temple Notices"),
      cards: (data?.notices ?? []).map((notice) => ({
        id: `notice-${notice.id}`, content_type: "announcement",
        title_ta: notice.title_ta || notice.title || notice.title_en,
        title_en: notice.title_en || notice.title || notice.title_ta,
        description_ta: notice.body_ta || notice.body || notice.body_en,
        description_en: notice.body_en || notice.body || notice.body_ta,
      })), empty: t("புதிய அறிவிப்புகள் விரைவில்.", "New notices will appear here when published.") },
  ];
  return <div className="events-page">
    <Seo title={t("நிகழ்வுகள் & பூஜை அட்டவணை", "Events & Pooja Schedule")}
      description={t("கமிட்டியால் அறிவிக்கப்பட்ட பூஜைகள், திருவிழாக்கள் மற்றும் நிகழ்வுகள்.", "Poojas, celebrations and activities announced by the temple committee.")} />
    <PageHero variant="events" eyebrow={t("இறையருளுடன் இணைவோம்", "Gather in devotion")}
      title={t("நிகழ்வுகள் & பூஜை அட்டவணை", "Events & Pooja Schedule")}
      lead={t("கமிட்டியால் அறிவிக்கப்பட்ட பூஜைகள், திருவிழாக்கள் மற்றும் நிகழ்வுகள்.", "Poojas, celebrations and activities announced by the temple committee.")}
      crumbs={[{ label: t("நிகழ்வுகள்", "Events") }]}
      actions={<><Button to="/sevas" variant="gold" icon={<LuFlower2 aria-hidden="true" />}>{t("சேவை பதிவு", "Book a Seva")}</Button>
        <Button to="/panchangam" variant="outline-light">{t("பஞ்சாங்கம் காண்க", "View Panchangam")}</Button></>}
      aside={<div className="events-hero-note">
        <LuFlower2 aria-hidden="true" /><p>{t("வழிபாடு · கொண்டாட்டம் · சமூகம்", "Worship · Celebration · Community")}</p>
        <h2>{t("ஒன்றிணைந்து அம்மனை வழிபடுவோம்", "Sacred occasions. Shared blessings.")}</h2>
        <span>{t("ஆலயத்தால் அறிவிக்கப்பட்ட நிகழ்வுகள் மட்டும்", "Temple-announced occasions, all in one place")}</span>
      </div>} />
    <section className="section"><div className="container events-content">
      <nav className="events-navigation" aria-label={t("நிகழ்வுப் பிரிவுகள்", "Event sections")}>
        {sections.map(({ id, Icon, title }) => <a key={id} href={`#${id}`}><Icon aria-hidden="true" />{title}</a>)}
      </nav>
      {error && <Alert tone="error">{t("அட்டவணையை ஏற்ற இயலவில்லை.", "The schedule could not be loaded.")}
        <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</Button></Alert>}
      {!data && !error && <SkeletonCards count={3} />}
      {data && sections.map(({ id, Icon, title, cards, empty }, index) => <section className="events-section" aria-labelledby={id} key={id}>
        <div className="events-section__heading"><span className="events-section__icon"><Icon aria-hidden="true" /></span>
          <SectionHeader id={id} align="left" eyebrow={`${String(index + 1).padStart(2, "0")} · ${t("ஆலயத் தகவல்கள்", "Temple updates")}`} title={title} />
        </div>
        {cards.length ? <HomepageWidgets widgets={cards} lang={lang} limit={100} showEventLinks={false} /> :
          <div className="events-empty"><Icon aria-hidden="true" /><div>
            <strong>{t("அறிவிப்புக்காகக் காத்திருங்கள்", "Watch this space")}</strong><p>{empty}</p>
          </div><Button to="/contact" variant="outline" size="sm">{t("ஆலயத்தைத் தொடர்பு கொள்ள", "Contact the temple")}</Button></div>}
      </section>)}
    </div></section>
  </div>;
}
