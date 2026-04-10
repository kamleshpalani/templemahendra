import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import "./Home.css";

/* ─── Darshan mode detection ─────────────────────────────── */
function detectInitialMode(lang) {
  if (!localStorage.getItem("templeVisited")) {
    localStorage.setItem("templeVisited", "1");
    return "first-visit";
  }
  const tz = new Date().getTimezoneOffset(); // IST = -330
  if (tz !== -330 && lang === "en") return "nri";
  return "devotee";
}

const MODES = [
  { id: "devotee", icon: "🙏", ta: "பக்தர்", en: "Devotee" },
  { id: "first-visit", icon: "✨", ta: "புதிய வருகை", en: "First Visit" },
  { id: "nri", icon: "🌏", ta: "வெளிநாட்டினர்", en: "NRI / Online" },
  { id: "elder", icon: "🔆", ta: "மூத்தோர்", en: "Elder View" },
];

/* ─── Mode content blocks ─────────────────────────────────── */
function DevoteeContent({ t, pulseData }) {
  // Use live pulse data if available, else sensible fallbacks
  const specialTa = pulseData?.todaySpecial?.ta ?? "சிவ அபிஷேகம்";
  const specialEn = pulseData?.todaySpecial?.en ?? "Shiva Abhishekam";
  const nextPoojaName = pulseData?.nextPooja
    ? t(pulseData.nextPooja.name_ta, pulseData.nextPooja.name_en) +
      " · " +
      pulseData.nextPooja.time
    : "—";
  const nextEvent = pulseData?.events?.[0];

  return (
    <div className="darshan-mode-block">
      <div className="darshan-mode-block__grid">
        <div className="darshan-highlight card">
          <span className="darshan-highlight__icon">🕉️</span>
          <div>
            <p className="darshan-highlight__label">
              {t("இன்றைய விசேஷம்", "Today's Special")}
            </p>
            <p className="darshan-highlight__value">
              {t(specialTa, specialEn)}
            </p>
          </div>
        </div>
        <div className="darshan-highlight card">
          <span className="darshan-highlight__icon">🛕</span>
          <div>
            <p className="darshan-highlight__label">
              {t("அடுத்த பூஜை", "Next Pooja")}
            </p>
            <p className="darshan-highlight__value">{nextPoojaName}</p>
          </div>
        </div>
        <div className="darshan-highlight card">
          <span className="darshan-highlight__icon">⏰</span>
          <div>
            <p className="darshan-highlight__label">
              {t("கோயில் நேரம்", "Temple Hours")}
            </p>
            <p className="darshan-highlight__value">6:00 AM – 12:30 PM</p>
            <p className="darshan-highlight__value">4:00 PM – 9:00 PM</p>
          </div>
        </div>
        {nextEvent && (
          <div className="darshan-highlight card">
            <span className="darshan-highlight__icon">🎉</span>
            <div>
              <p className="darshan-highlight__label">
                {t("அடுத்த திருவிழா", "Next Festival")}
              </p>
              <p className="darshan-highlight__value">
                {t(nextEvent.title_ta, nextEvent.title_en)}
              </p>
              <p
                className="darshan-highlight__value"
                style={{ fontSize: "0.78rem", opacity: 0.75 }}
              >
                {nextEvent.event_date}
              </p>
            </div>
          </div>
        )}
        {!nextEvent && (
          <div className="darshan-highlight card">
            <span className="darshan-highlight__icon">💛</span>
            <div>
              <p className="darshan-highlight__label">
                {t("விரைவில்", "Upcoming")}
              </p>
              <p className="darshan-highlight__value">
                {t("கார்த்திகை தீபம்", "Karthigai Deepam")}
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="darshan-mode-block__cta">
        <Link to="/sevas" className="btn btn-primary">
          {t("சேவை பதிவு →", "Book a Seva →")}
        </Link>
        <Link to="/donations" className="btn btn-outline">
          {t("நன்கொடை →", "Donate Now →")}
        </Link>
      </div>
    </div>
  );
}

function FirstVisitContent({ t }) {
  return (
    <div className="darshan-mode-block">
      <div className="darshan-info-list">
        <div className="darshan-info-item card">
          <span className="darshan-info-item__num">01</span>
          <div>
            <h4>{t("கோயிலை பற்றி", "About the Temple")}</h4>
            <p>
              {t(
                "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில் — பக்தி, பாரம்பரியம் மற்றும் கம்மவார் நாயுடு சமூகத்தின் புனிதத் தலம்.",
                "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple — a sacred centre of devotion and Kammavar Naidu community tradition.",
              )}
            </p>
          </div>
        </div>
        <div className="darshan-info-item card">
          <span className="darshan-info-item__num">02</span>
          <div>
            <h4>{t("நடத்தை விதிகள்", "Temple Etiquette")}</h4>
            <p>
              {t(
                "சுத்தமான உடை அணியவும். செல்போனை அமைதிப்படுத்தவும். காலணி வெளியே வைக்கவும்.",
                "Wear clean attire. Silence your phone. Remove footwear at the entrance.",
              )}
            </p>
          </div>
        </div>
        <div className="darshan-info-item card">
          <span className="darshan-info-item__num">03</span>
          <div>
            <h4>{t("வருகை நேரம்", "Visiting Hours")}</h4>
            <p>6:00 AM – 12:30 PM &nbsp;|&nbsp; 4:00 PM – 9:00 PM</p>
          </div>
        </div>
        <div className="darshan-info-item card">
          <span className="darshan-info-item__num">04</span>
          <div>
            <h4>{t("சேவை பதிவு", "Book a Seva")}</h4>
            <p>
              {t(
                "முன்கூட்டியே சேவை பதிவு செய்வது சிறந்தது.",
                "Pre-booking a seva ensures a smooth experience.",
              )}
            </p>
          </div>
        </div>
      </div>
      <div className="darshan-mode-block__cta">
        <Link to="/about" className="btn btn-primary">
          {t("மேலும் அறிய →", "Learn More →")}
        </Link>
        <Link to="/contact" className="btn btn-outline">
          {t("வழி அறிய →", "Get Directions →")}
        </Link>
      </div>
    </div>
  );
}

function NriContent({ t }) {
  return (
    <div className="darshan-mode-block">
      <div className="darshan-nri-grid">
        <div className="darshan-nri-card card">
          <span className="darshan-nri-card__icon">📺</span>
          <h4>{t("நேரடி ஒளிபரப்பு", "Live Stream")}</h4>
          <p>
            {t(
              "தினசரி பூஜைகளை நேரடியாக கண்டுகளிக்கவும்.",
              "Watch daily poojas live from anywhere in the world.",
            )}
          </p>
          <a
            href="https://youtube.com/@TempleMahendra"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary btn--sm"
          >
            {t("YouTube-ல் பார்க்க", "Watch on YouTube")}
          </a>
        </div>
        <div className="darshan-nri-card card">
          <span className="darshan-nri-card__icon">💳</span>
          <h4>{t("ஆன்லைன் நன்கொடை", "Online Donation")}</h4>
          <p>
            {t(
              "உலகின் எங்கிருந்தும் பணம் அனுப்பலாம்.",
              "Support the temple via online transfer from anywhere.",
            )}
          </p>
          <Link to="/donations" className="btn btn-primary btn--sm">
            {t("நன்கொடை →", "Donate Online →")}
          </Link>
        </div>
        <div className="darshan-nri-card card">
          <span className="darshan-nri-card__icon">🛕</span>
          <h4>{t("சேவை பதிவு", "Remote Seva Booking")}</h4>
          <p>
            {t(
              "நீங்கள் இல்லாமலேயே உங்கள் பெயரில் சேவை நடத்தலாம்.",
              "Perform a seva on your behalf remotely.",
            )}
          </p>
          <Link to="/sevas" className="btn btn-outline btn--sm">
            {t("சேவை பார்க்க", "View Sevas")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function ElderContent({ t, pulseData }) {
  const isOpen = pulseData?.open ?? null;
  return (
    <div className="darshan-mode-block darshan-mode-block--elder">
      <div className="darshan-mode-block__grid">
        {isOpen !== null && (
          <div
            className={`darshan-highlight darshan-highlight--elder card darshan-status-card--${isOpen ? "open" : "closed"}`}
          >
            <span className="darshan-highlight__icon">
              {isOpen ? "🟢" : "🔴"}
            </span>
            <div>
              <p className="darshan-highlight__label">
                {t("இப்போது நிலை", "Current Status")}
              </p>
              <p className="darshan-highlight__value">
                {isOpen
                  ? t("கோயில் திறந்தது", "Temple Open")
                  : t("கோயில் மூடியது", "Temple Closed")}
              </p>
            </div>
          </div>
        )}
        <div className="darshan-highlight darshan-highlight--elder card">
          <span className="darshan-highlight__icon">🕉️</span>
          <div>
            <p className="darshan-highlight__label">
              {t("இன்றைய விசேஷம்", "Today's Special")}
            </p>
            <p className="darshan-highlight__value">
              {t("சிவ அபிஷேகம்", "Shiva Abhishekam")}
            </p>
          </div>
        </div>
        <div className="darshan-highlight darshan-highlight--elder card">
          <span className="darshan-highlight__icon">📞</span>
          <div>
            <p className="darshan-highlight__label">
              {t("தொடர்பு கொள்ள", "Call Temple")}
            </p>
            <a
              href="tel:+919999999999"
              className="darshan-highlight__value darshan-highlight__value--link"
            >
              +91 99999 99999
            </a>
          </div>
        </div>
      </div>
      <div className="darshan-mode-block__cta">
        <Link to="/sevas" className="btn btn-primary btn--lg">
          {t("சேவை பதிவு →", "Book a Seva →")}
        </Link>
        <Link to="/contact" className="btn btn-outline btn--lg">
          {t("வழி அறிய →", "Get Directions →")}
        </Link>
      </div>
    </div>
  );
}

export default function Home() {
  const [announcements, setAnnouncements] = useState([]);
  const [events, setEvents] = useState([]);
  const [sevas, setSevas] = useState([]);
  const [pulseData, setPulseData] = useState(null);
  const { lang, t } = useLang();
  const [mode, setMode] = useState(() => detectInitialMode(lang));

  useEffect(() => {
    api
      .get("/announcements?limit=3")
      .then((r) => setAnnouncements(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    api
      .get("/events?limit=3&upcoming=1")
      .then((r) => setEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    api
      .get("/sevas?limit=4&featured=1")
      .then((r) => setSevas(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    api
      .get("/pulse")
      .then((r) =>
        setPulseData(r.data && typeof r.data === "object" ? r.data : null),
      )
      .catch(() => {});
  }, []);

  return (
    <>
      <Helmet>
        <title>
          {t("முகப்பு", "Home")} —{" "}
          {t(
            "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
            "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
          )}
        </title>
      </Helmet>

      {/* Hero */}
      <section className="hero">
        <div className="hero__overlay" />
        <div className="container hero__content">
          <p className="hero__tagline">
            ஓம் சக்தி ஓம் · ஸ்ரீ ரேணுகாம்பிகை சரணம்
          </p>
          <h1 className="hero__title">
            {t(
              "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
              "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
            )}
          </h1>
          <h2 className="hero__subtitle">
            {t(
              "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
              "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
            )}
          </h2>
          <p className="hero__desc">
            {t(
              "பக்தி, பாரம்பரியம் மற்றும் சமூகம் — ஒரு புனிதத் தலம்",
              "A sacred place of devotion, tradition, and community",
            )}
          </p>
          <div className="hero__actions">
            <Link to="/sevas" className="btn btn-primary">
              {t("சேவைகள் பார்க்க", "View Sevas")}
            </Link>
            <Link to="/contact" className="btn btn-outline">
              {t("வழி அறிய", "Get Directions")}
            </Link>
          </div>
        </div>
      </section>

      {/* Announcements */}
      {announcements.length > 0 && (
        <div className="ticker-bar">
          <span className="ticker-label">📢 அறிவிப்பு:</span>
          <div className="ticker-scroll">
            {announcements.map((a) => (
              <span key={a.id} className="ticker-item">
                {a.title}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── Digital Darshan Flow: Mode Switcher ── */}
      <section className="section section--darshan">
        <div className="container">
          <div className="darshan-modes">
            <p className="darshan-modes__label">
              {t("உங்கள் வருகை வகை:", "Your Visit Type:")}
            </p>
            <div className="darshan-modes__tabs" role="tablist">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  role="tab"
                  aria-selected={mode === m.id}
                  className={`darshan-modes__tab${mode === m.id ? " darshan-modes__tab--active" : ""}`}
                  onClick={() => setMode(m.id)}
                >
                  <span className="darshan-modes__tab-icon">{m.icon}</span>
                  <span>{t(m.ta, m.en)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Mode-specific content */}
          <div
            className={`darshan-content${mode === "elder" ? " darshan-content--elder" : ""}`}
          >
            {mode === "devotee" && (
              <DevoteeContent t={t} pulseData={pulseData} />
            )}
            {mode === "first-visit" && <FirstVisitContent t={t} />}
            {mode === "nri" && <NriContent t={t} />}
            {mode === "elder" && <ElderContent t={t} pulseData={pulseData} />}
          </div>
        </div>
      </section>

      {/* Featured Sevas */}
      <section className="section">
        <div className="container">
          <h2 className="section-title">{t("சேவைகள்", "Sevas")}</h2>
          <div className="divider" />
          <p className="section-subtitle">
            {t(
              "கோயிலில் தினசரி மற்றும் சிறப்பு பூஜைகளை பதிவு செய்யுங்கள்",
              "Book daily and special poojas at the temple",
            )}
          </p>
          <div className="grid-4">
            {sevas.length > 0
              ? sevas.map((s) => (
                  <div key={s.id} className="seva-card card">
                    <div className="seva-card__body">
                      <h3>{lang === "ta" ? s.name_ta : s.name_en}</h3>
                      <div className="seva-card__price">₹{s.amount}</div>
                    </div>
                  </div>
                ))
              : [
                  ["அபிஷேகம்", "Abhishekam", "₹251"],
                  ["அர்ச்சனை", "Archana", "₹51"],
                  ["தீபாராதனை", "Deepa Aradhana", "₹101"],
                  ["அன்னதானம்", "Annadanam", "₹501"],
                ].map(([ta, en, price]) => (
                  <div key={ta} className="seva-card card">
                    <div className="seva-card__body">
                      <h3>{t(ta, en)}</h3>
                      <div className="seva-card__price">{price}</div>
                    </div>
                  </div>
                ))}
          </div>
          <div className="section-cta">
            <Link to="/sevas" className="btn btn-outline">
              {t("அனைத்து சேவைகளும் →", "View All Sevas →")}
            </Link>
          </div>
        </div>
      </section>

      {/* Upcoming Events */}
      <section className="section section--alt">
        <div className="container">
          <h2 className="section-title">{t("நிகழ்வுகள்", "Events")}</h2>
          <div className="divider" />
          <p className="section-subtitle">
            {t(
              "வரவிருக்கும் திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகள்",
              "Upcoming festivals and special occasions",
            )}
          </p>
          <div className="grid-3">
            {events.length > 0
              ? events.map((e) => (
                  <div key={e.id} className="event-card card">
                    <div className="event-card__date">{e.event_date}</div>
                    <div className="event-card__body">
                      <h3>{lang === "ta" ? e.title_ta : e.title_en}</h3>
                    </div>
                  </div>
                ))
              : [
                  ["பங்குனி உத்திரம்", "Panguni Uthiram", "Mar 2026"],
                  ["திருவிழா", "Annual Festival", "Apr 2026"],
                  ["கார்த்திகை", "Karthigai Deepam", "Nov 2026"],
                ].map(([ta, en, date]) => (
                  <div key={ta} className="event-card card">
                    <div className="event-card__date">{date}</div>
                    <div className="event-card__body">
                      <h3>{t(ta, en)}</h3>
                    </div>
                  </div>
                ))}
          </div>
          <div className="section-cta">
            <Link to="/events" className="btn btn-outline">
              {t("அனைத்து நிகழ்வுகளும் →", "View All Events →")}
            </Link>
          </div>
        </div>
      </section>

      {/* Quick actions */}
      <section className="section">
        <div className="container">
          <div className="quick-links grid-3">
            <Link to="/donations" className="quick-link-card card">
              <span className="quick-link-card__icon">🙏</span>
              <h3>{t("நன்கொடை", "Donate")}</h3>
              <p>
                {t(
                  "உங்கள் தாராளமான பங்களிப்பால் கோயிலை ஆதரியுங்கள்",
                  "Support the temple through your generous contribution",
                )}
              </p>
            </Link>
            <Link to="/gallery" className="quick-link-card card">
              <span className="quick-link-card__icon">🖼️</span>
              <h3>{t("தொகுப்பு", "Gallery")}</h3>
              <p>
                {t(
                  "திருவிழாக்கள் மற்றும் நாளாந்த வழிபாட்டின் படங்களைப் பாருங்கள்",
                  "View photos from festivals and daily rituals",
                )}
              </p>
            </Link>
            <Link to="/contact" className="quick-link-card card">
              <span className="quick-link-card__icon">📍</span>
              <h3>{t("தொடர்பு கொள்ளுங்கள்", "Contact")}</h3>
              <p>
                {t(
                  "வழி மற்றும் வருகை நேரங்களை அறிந்துகொள்ளுங்கள்",
                  "Get directions and visiting hours",
                )}
              </p>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
