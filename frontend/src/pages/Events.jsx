import { useEffect, useState, useMemo } from "react";
import { Helmet } from "react-helmet-async";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import "./PageCommon.css";
import "./Events.css";

// Badge colours per calendar event type
const BADGE_META = {
  pournami: { ta: "பௌர்ணமி", en: "Pournami", color: "#7c3aed" },
  amavasai: { ta: "அமாவாசை", en: "Amavasai", color: "#1d4ed8" },
  ekadasi: { ta: "ஏகாதசி", en: "Ekadasi", color: "#0891b2" },
  sashti: { ta: "சஷ்டி", en: "Sashti", color: "#be185d" },
  pradosham: { ta: "பிரதோஷம்", en: "Pradosham", color: "#b45309" },
  chaturthi: { ta: "சதுர்த்தி", en: "Chaturthi", color: "#15803d" },
  festival: { ta: "திருவிழா", en: "Festival", color: "#b91c1c" },
  temple: { ta: "கோயில்", en: "Temple", color: "#92400e" },
};

function calendarEventsFromMonth(data, todayStr) {
  const items = [];
  (data.days ?? []).forEach((day) => {
    if (day.date < todayStr) return;
    (day.special ?? []).forEach((sp) => {
      const isPournami = sp.type === "pournami";
      const tamMonthTa = day.tamil_month?.ta ?? "";
      const tamMonthEn = day.tamil_month?.en ?? "";
      const pournamiTitleTa = tamMonthTa
        ? "பௌர்ணமி பூஜை — " + tamMonthTa
        : "பௌர்ணமி பூஜை";
      const pournamiTitleEn = tamMonthEn
        ? "Pournami Poojai — " + tamMonthEn
        : "Pournami Poojai";
      items.push({
        id: `cal-${day.date}-${sp.type}`,
        title_ta: isPournami ? pournamiTitleTa : sp.ta,
        title_en: isPournami ? pournamiTitleEn : sp.en,
        event_date: day.date,
        description_ta: isPournami
          ? `${day.weekday_ta} | திதி: ${day.tithi_ta} | தமிழ் மாதம்: ${tamMonthTa}`
          : `${day.tithi_ta} | ${day.weekday_ta}`,
        description_en: isPournami
          ? `${day.weekday_en} | Tithi: ${day.tithi_en} | Tamil Month: ${tamMonthEn}`
          : `${day.tithi_en} | ${day.weekday_en}`,
        time: isPournami ? "4:00 PM – 9:00 PM" : null,
        badge: sp.type,
        isCalendar: true,
      });
    });
  });
  return items;
}

export default function Events() {
  const [templeEvents, setTempleEvents] = useState([]);
  const [calItems, setCalItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all"); // all | temple | calendar
  const { lang, t } = useLang();

  useEffect(() => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Build list of year-month pairs: current + next 23 months (2 full years)
    const months = Array.from({ length: 24 }, (_, offset) => {
      const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    });

    const eventsReq = api
      .get("/events")
      .then((r) => setTempleEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});

    const calReqs = Promise.all(
      months.map((m) =>
        api
          .get(`/calendar?year=${m.year}&month=${m.month}`)
          .then((r) => calendarEventsFromMonth(r.data, todayStr))
          .catch(() => []),
      ),
    ).then((results) => setCalItems(results.flat()));

    Promise.all([eventsReq, calReqs]).finally(() => setLoading(false));
  }, []);

  const todayStr = new Date().toISOString().slice(0, 10);

  // Static fallback for temple events (used when API returns nothing)
  const fallbackTemple = [
    {
      id: 1,
      title_ta: "தைப்பூசம்",
      title_en: "Thai Poosam",
      event_date: "2026-01-24",
      description_ta: "முருகன் திருவிழா — கவாடி ஊர்வலம்.",
      description_en:
        "Grand festival celebrating Murugan with kavadi procession.",
      badge: "temple",
    },
    {
      id: 2,
      title_ta: "மகா சிவராத்திரி",
      title_en: "Maha Shivaratri",
      event_date: "2026-02-26",
      description_ta:
        "சிவபெருமானுக்கு இரவு முழுவதும் விழிப்பு மற்றும் அபிஷேகம்.",
      description_en: "All night vigil and abhishekam for Lord Shiva.",
      badge: "temple",
    },
    {
      id: 3,
      title_ta: "பங்குனி உத்திரம்",
      title_en: "Panguni Uthiram",
      event_date: "2026-03-31",
      description_ta: "தெய்வீக திருமண திருவிழா.",
      description_en:
        "Sacred festival of divine weddings and celestial unions.",
      badge: "temple",
    },
  ];

  const templeSource =
    templeEvents.length > 0
      ? templeEvents.map((e) => ({ ...e, badge: "temple", isCalendar: false }))
      : fallbackTemple;

  // Merged + sorted list, today onwards only
  const merged = useMemo(() => {
    const all = [
      ...templeSource.filter((e) => e.event_date >= todayStr),
      ...calItems,
    ];
    // Deduplicate calendar items with same date+type
    const seen = new Set();
    return all
      .filter((e) => {
        const key = `${e.event_date}-${e.badge}-${e.title_en}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.event_date.localeCompare(b.event_date));
  }, [templeSource, calItems, todayStr]);

  const filtered = useMemo(() => {
    if (filter === "temple") return merged.filter((e) => !e.isCalendar);
    if (filter === "calendar") return merged.filter((e) => e.isCalendar);
    if (filter === "pournami")
      return merged.filter((e) => e.badge === "pournami");
    return merged;
  }, [merged, filter]);

  return (
    <>
      <Helmet>
        <title>
          {t("நிகழ்வுகள்", "Events")} —{" "}
          {t(
            "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
            "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
          )}
        </title>
      </Helmet>

      <div className="page-hero page-hero--events">
        <div className="page-hero__content">
          <h1>{t("நிகழ்வுகள் & திருவிழாக்கள்", "Events & Festivals")}</h1>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <h2 className="section-title">
            {t("வரவிருக்கும் நிகழ்வுகள்", "Upcoming Events")}
          </h2>
          <div className="divider" />

          {/* Filter tabs */}
          <div className="events-filter">
            {[
              { key: "all", ta: "அனைத்தும்", en: "All" },
              { key: "pournami", ta: "பௌர்ணமி பூஜை", en: "Pournami Poojai" },
              { key: "temple", ta: "கோயில் நிகழ்வு", en: "Temple Events" },
              { key: "calendar", ta: "பஞ்சாங்கம்", en: "Panchangam" },
            ].map((tab) => (
              <button
                key={tab.key}
                className={`events-filter__btn${filter === tab.key ? " events-filter__btn--active" : ""}`}
                onClick={() => setFilter(tab.key)}
              >
                {t(tab.ta, tab.en)}
              </button>
            ))}
          </div>

          {loading ? (
            <p className="loading-text">{t("ஏற்றுகிறது…", "Loading…")}</p>
          ) : (
            <>
              {filtered.length === 0 && (
                <p className="loading-text">
                  {t("நிகழ்வுகள் இல்லை.", "No upcoming events.")}
                </p>
              )}
              {filtered.length > 0 && (
                <div className="events-list">
                  {filtered.map((ev) => {
                    const d = new Date(ev.event_date + "T00:00:00");
                    const day = String(d.getDate()).padStart(2, "0");
                    const month = d.toLocaleDateString("en-IN", {
                      month: "short",
                    });
                    const year = d.getFullYear();
                    const title = lang === "ta" ? ev.title_ta : ev.title_en;
                    const desc =
                      lang === "ta"
                        ? (ev.description_ta ?? ev.description)
                        : (ev.description_en ?? ev.description);
                    const badgeMeta = BADGE_META[ev.badge] ?? BADGE_META.temple;
                    return (
                      <div key={ev.id} className="event-row card">
                        <div className="event-row__cal">
                          <span className="event-row__day">{day}</span>
                          <span className="event-row__month">{month}</span>
                          <span className="event-row__year">{year}</span>
                        </div>
                        <div className="event-row__info">
                          <div className="event-row__header">
                            <h3>{title}</h3>
                            <span
                              className="event-row__badge"
                              style={{ background: badgeMeta.color }}
                            >
                              {t(badgeMeta.ta, badgeMeta.en)}
                            </span>
                          </div>
                          {desc && <p className="event-row__desc">{desc}</p>}
                          {ev.time && (
                            <p className="event-row__time">🕓 {ev.time}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
