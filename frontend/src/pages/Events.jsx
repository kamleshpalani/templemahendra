import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import "./PageCommon.css";

export default function Events() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const { lang, t } = useLang();

  useEffect(() => {
    api
      .get("/events")
      .then((r) => setEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fallback = [
    {
      id: 1,
      title_ta: "தைப்பூசம்",
      title_en: "Thai Poosam",
      event_date: "2026-01-24",
      description_ta: "முருகன் திருவிழா — கவாடி ஊர்வலம்.",
      description_en:
        "Grand festival celebrating Murugan with kavadi procession.",
    },
    {
      id: 2,
      title_ta: "மகா சிவராத்திரி",
      title_en: "Maha Shivaratri",
      event_date: "2026-02-26",
      description_ta:
        "சிவபெருமானுக்கு இரவு முழுவதும் விழிப்பு மற்றும் அபிஷேகம்.",
      description_en: "All night vigil and abhishekam for Lord Shiva.",
    },
    {
      id: 3,
      title_ta: "பங்குனி உத்திரம்",
      title_en: "Panguni Uthiram",
      event_date: "2026-03-31",
      description_ta: "தெய்வீக திருமண திருவிழா.",
      description_en:
        "Sacred festival of divine weddings and celestial unions.",
    },
    {
      id: 4,
      title_ta: "ஆடி பூரம்",
      title_en: "Aadi Pooram",
      event_date: "2026-07-28",
      description_ta: "ஆண்டாள் திருவிழா — மலர் அலங்காரம்.",
      description_en: "Celebration of Goddess Andal with flower decorations.",
    },
    {
      id: 5,
      title_ta: "கார்த்திகை",
      title_en: "Karthigai Deepam",
      event_date: "2026-11-27",
      description_ta:
        "கார்த்திகை தீபத் திருவிழா — கோயில் முழுவதும் விளக்கேற்றல்.",
      description_en: "Festival of lights — lamps lit throughout the temple.",
    },
  ];

  const items = events.length > 0 ? events : fallback;

  return (
    <>
      <Helmet>
        <title>
          {t("நிகழ்வுகள்", "Events")} —{" "}
          {t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}
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

          {loading ? (
            <p className="loading-text">{t("ஏற்றுகிறது…", "Loading…")}</p>
          ) : (
            <div className="events-list">
              {items.map((ev) => {
                const d = new Date(ev.event_date);
                const day = d.toLocaleDateString("en-IN", { day: "2-digit" });
                const month = d.toLocaleDateString("en-IN", { month: "short" });
                const year = d.getFullYear();
                const title = lang === "ta" ? ev.title_ta : ev.title_en;
                const desc =
                  lang === "ta"
                    ? (ev.description_ta ?? ev.description)
                    : (ev.description_en ?? ev.description);
                return (
                  <div key={ev.id} className="event-row card">
                    <div className="event-row__cal">
                      <span className="event-row__day">{day}</span>
                      <span className="event-row__month">{month}</span>
                      <span className="event-row__year">{year}</span>
                    </div>
                    <div className="event-row__info">
                      <h3>{title}</h3>
                      {desc && <p className="event-row__desc">{desc}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
