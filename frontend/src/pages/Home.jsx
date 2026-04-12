import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import Reviews from "../components/Reviews/Reviews";
import HomepageWidgets from "../components/HomepageWidgets/HomepageWidgets";
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
  { id: "volunteer", icon: "🤝", ta: "தன்னார்வலர்", en: "Volunteer" },
  { id: "sponsor", icon: "💛", ta: "ஸ்பான்சர்", en: "Seva Sponsor" },
];

/* ─── Mode content blocks ─────────────────────────────────── */
function DevoteeContent({ t, pulseData, nallaTime, pournami }) {
  // Use live pulse data if available, else sensible fallbacks
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
        {pournami && (
          <div className="darshan-highlight card">
            <span className="darshan-highlight__icon">🌕</span>
            <div>
              <p className="darshan-highlight__label">
                {t("பௌர்ணமி பூஜை", "Pournami Poojai")}
              </p>
              <p className="darshan-highlight__value">
                {new Date(pournami.date + "T00:00:00").toLocaleDateString(
                  t("ta", "en") === "ta" ? "ta-IN" : "en-IN",
                  {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  },
                )}
              </p>
              {pournami.daysLeft === 0 ? (
                <p
                  className="darshan-highlight__value"
                  style={{ fontSize: "0.78rem", color: "#d97706" }}
                >
                  {t("இன்று!", "Today!")}
                </p>
              ) : pournami.daysLeft === 1 ? (
                <p
                  className="darshan-highlight__value"
                  style={{ fontSize: "0.78rem", opacity: 0.75 }}
                >
                  {t("நாளை", "Tomorrow")}
                </p>
              ) : (
                <p
                  className="darshan-highlight__value"
                  style={{ fontSize: "0.78rem", opacity: 0.75 }}
                >
                  {t(
                    `${pournami.daysLeft} நாட்களில்`,
                    `In ${pournami.daysLeft} days`,
                  )}
                </p>
              )}
            </div>
          </div>
        )}
        {!nextEvent && !pournami && (
          <div className="darshan-highlight card">
            <span className="darshan-highlight__icon">🌕</span>
            <div>
              <p className="darshan-highlight__label">
                {t("விரைவில்", "Upcoming")}
              </p>
              <p className="darshan-highlight__value">
                {t("பௌர்ணமி பூஜை", "Pournami Poojai")}
              </p>
            </div>
          </div>
        )}
        <div className="darshan-highlight card">
          <span className="darshan-highlight__icon">📿</span>
          <div>
            <p className="darshan-highlight__label">
              {t("தினசரி ஆசி", "Daily Blessings")}
            </p>
            <p className="darshan-highlight__value">
              {t(
                "காலை 6 மணிக்கு கோவிலில் வாருங்கள்",
                "Visit at 6 AM for morning aarti",
              )}
            </p>
          </div>
        </div>
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
            <h4>{t("உடை விதிமுறை", "Dress Code")}</h4>
            <p>
              {t(
                "பாரம்பரிய உடை அணியவும். குறுகிய ஆடை அணிவது தவிர்க்கவும்.",
                "Wear traditional attire. Avoid short or casual clothing inside the temple.",
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
        <div className="darshan-nri-card card">
          <span className="darshan-nri-card__icon">📸</span>
          <h4>{t("படத் தொகுப்பு", "Temple Gallery")}</h4>
          <p>
            {t(
              "திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகளின் படங்களை பாருங்கள்.",
              "Relive temple festivals and events through our photo gallery.",
            )}
          </p>
          <Link to="/gallery" className="btn btn-outline btn--sm">
            {t("படங்கள் காண →", "View Gallery →")}
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
          <span className="darshan-highlight__icon"></span>
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
        <div className="darshan-highlight darshan-highlight--elder card">
          <span className="darshan-highlight__icon">⏰</span>
          <div>
            <p className="darshan-highlight__label">
              {t("கோயில் நேரம்", "Temple Hours")}
            </p>
            <p className="darshan-highlight__value">6:00 AM – 12:30 PM</p>
            <p className="darshan-highlight__value">4:00 PM – 9:00 PM</p>
          </div>
        </div>
        <div className="darshan-highlight darshan-highlight--elder card">
          <span className="darshan-highlight__icon">♿</span>
          <div>
            <p className="darshan-highlight__label">
              {t("வசதிகள்", "Accessibility")}
            </p>
            <p className="darshan-highlight__value">
              {t("சக்கர நாற்காலி வசதி உள்ளது", "Wheelchair access available")}
            </p>
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

function VolunteerContent({ t }) {
  return (
    <div className="darshan-mode-block">
      <div className="darshan-volunteer-grid">
        <div className="darshan-volunteer-card card darshan-volunteer-card--1">
          <span className="darshan-volunteer-card__icon">🌸</span>
          <h4>{t("பூ அலங்காரம்", "Flower Decoration")}</h4>
          <p>
            {t(
              "திருவிழா நாட்களில் கோவில் அலங்கரிக்க உதவுங்கள்.",
              "Help decorate the temple on festival days.",
            )}
          </p>
        </div>
        <div className="darshan-volunteer-card card darshan-volunteer-card--2">
          <span className="darshan-volunteer-card__icon">🍚</span>
          <h4>{t("அன்னதானம்", "Annadanam")}</h4>
          <p>
            {t(
              "பக்தர்களுக்கு இலவச உணவு வழங்குவதில் பங்கேற்கலாம்.",
              "Participate in serving free food to devotees.",
            )}
          </p>
        </div>
        <div className="darshan-volunteer-card card darshan-volunteer-card--3">
          <span className="darshan-volunteer-card__icon">🧹</span>
          <h4>{t("சுத்தம் & பராமரிப்பு", "Cleaning & Upkeep")}</h4>
          <p>
            {t(
              "கோவில் வளாகத்தை சுத்தமாக வைக்க உதவுங்கள்.",
              "Help keep the temple premises clean and tidy.",
            )}
          </p>
        </div>
        <div className="darshan-volunteer-card card darshan-volunteer-card--4">
          <span className="darshan-volunteer-card__icon">📣</span>
          <h4>{t("நிகழ்வு ஒருங்கிணைப்பு", "Event Coordination")}</h4>
          <p>
            {t(
              "திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகளை ஒருங்கிணைக்க.",
              "Coordinate festivals and special poojas.",
            )}
          </p>
        </div>
        <div className="darshan-volunteer-card card darshan-volunteer-card--5">
          <span className="darshan-volunteer-card__icon">📷</span>
          <h4>{t("படம் & பதிவு", "Photography & Docs")}</h4>
          <p>
            {t(
              "கோவில் நிகழ்வுகளை படம் எடுத்து பதிவு செய்யுங்கள்.",
              "Help document and photograph temple events for memory.",
            )}
          </p>
        </div>
      </div>
      <div className="darshan-mode-block__cta">
        <Link to="/contact" className="btn btn-primary">
          {t("தொடர்பு கொள்ள →", "Get in Touch →")}
        </Link>
      </div>
    </div>
  );
}

function SponsorContent({ t }) {
  return (
    <div className="darshan-mode-block">
      <div className="darshan-sponsor-hero">
        <div className="darshan-sponsor-hero__icon">💛</div>
        <div className="darshan-sponsor-hero__body">
          <h3 className="darshan-sponsor-hero__title">
            {t("சேவையை தானம் செய்யுங்கள்", "Sponsor a Sacred Seva")}
          </h3>
          <p className="darshan-sponsor-hero__sub">
            {t(
              "உங்கள் பெயரில் அல்லது குடும்பத்தினர் பெயரில் ஒரு பூஜையை நடத்தி ஆசி பெறுங்கள்.",
              "Offer a pooja in your name or your family's name and receive the blessings of the Goddess.",
            )}
          </p>
        </div>
      </div>
      <div className="darshan-sponsor-options">
        <div className="darshan-sponsor-option card">
          <span className="darshan-sponsor-option__icon">🛕</span>
          <div>
            <p className="darshan-sponsor-option__name">
              {t("அபிஷேகம்", "Abhishekam")}
            </p>
            <p className="darshan-sponsor-option__desc">
              {t("திருமேனி அலங்காரத்துடன்", "With divine adornment")}
            </p>
          </div>
          <Link to="/sevas" className="btn btn-outline btn--sm">
            {t("பதிவு →", "Book →")}
          </Link>
        </div>
        <div className="darshan-sponsor-option card">
          <span className="darshan-sponsor-option__icon">🌺</span>
          <div>
            <p className="darshan-sponsor-option__name">
              {t("அர்ச்சனை", "Archana")}
            </p>
            <p className="darshan-sponsor-option__desc">
              {t("108 நாம ஸ்துதி", "108-name worship")}
            </p>
          </div>
          <Link to="/sevas" className="btn btn-outline btn--sm">
            {t("பதிவு →", "Book →")}
          </Link>
        </div>
        <div className="darshan-sponsor-option card">
          <span className="darshan-sponsor-option__icon">🍚</span>
          <div>
            <p className="darshan-sponsor-option__name">
              {t("அன்னதானம்", "Annadanam")}
            </p>
            <p className="darshan-sponsor-option__desc">
              {t("பக்தர்களுக்கு உணவு", "Meal for devotees")}
            </p>
          </div>
          <Link to="/sevas" className="btn btn-outline btn--sm">
            {t("பதிவு →", "Book →")}
          </Link>
        </div>
      </div>
      <div className="darshan-mode-block__cta">
        <Link to="/donations" className="btn btn-primary">
          {t("நன்கொடை →", "Donate →")}
        </Link>
        <Link to="/sevas" className="btn btn-outline">
          {t("அனைத்து சேவைகள் →", "All Sevas →")}
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
  const [widgets, setWidgets] = useState([]);
  const [widgetsLoading, setWidgetsLoading] = useState(true);
  const [pournami, setPournami] = useState(null);
  const [pournamis, setPournamis] = useState([]);
  const [donors, setDonors] = useState([]);
  const [nallaTime, setNallaTime] = useState(null); // [[start,end],[start,end]]
  const [nowIST, setNowIST] = useState(() => new Date());
  const [siteSettings, setSiteSettings] = useState({
    show_pournami_section: true,
    show_nalla_strip: true,
    show_donor_ticker: true,
  });
  const { lang, t } = useLang();
  const [mode, setMode] = useState(() => detectInitialMode(lang));

  // Live IST clock — ticks every second
  useEffect(() => {
    const id = setInterval(() => setNowIST(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

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
    api
      .get("/homepage_widgets")
      .then((r) => setWidgets(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setWidgetsLoading(false));
    api
      .get("/donors")
      .then((r) => setDonors(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    api
      .get("/settings")
      .then((r) => {
        if (r.data && typeof r.data === "object")
          setSiteSettings((prev) => ({ ...prev, ...r.data }));
      })
      .catch(() => {});

    // Today's Nalla Neram from calendar
    const nowD = new Date();
    api
      .get(`/calendar?year=${nowD.getFullYear()}&month=${nowD.getMonth() + 1}`)
      .then((r) => {
        const slots = r.data?.today?.timings?.nalla_neram;
        if (Array.isArray(slots) && slots.length) setNallaTime(slots);
      })
      .catch(() => {});

    // Find next 3 Pournami dates across 3 months from calendar
    const todayStr = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const monthsToFetch = [0, 1, 2].map((offset) => {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      return { year: d.getFullYear(), month: d.getMonth() + 1 };
    });
    Promise.all(
      monthsToFetch.map(({ year, month }) =>
        api
          .get(`/calendar?year=${year}&month=${month}`)
          .then((r) => {
            const found = (r.data?.days ?? []).find(
              (d) =>
                d.date >= todayStr &&
                d.special?.some((s) => s.type === "pournami"),
            );
            if (!found) return null;
            const daysLeft = Math.round(
              (new Date(found.date + "T00:00:00") -
                new Date(todayStr + "T00:00:00")) /
                86400000,
            );
            return { ...found, daysLeft };
          })
          .catch(() => null),
      ),
    ).then((results) => {
      const found = results.filter(Boolean).slice(0, 3);
      setPournamis(found);
      if (found.length > 0) setPournami(found[0]); // keep legacy prop for other callers
    });
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

      {/* Announcements ticker */}
      {announcements.length > 0 && (
        <div className="ticker-bar">
          <span className="ticker-label">📢 {t("அறிவிப்பு", "Notice")}:</span>
          <div className="ticker-track">
            {/* eslint-disable-next-line react/no-array-index-key */}
            <div className="ticker-scroll">
              {[...announcements, ...announcements].map((a, i) => (
                <span key={i} className="ticker-item">
                  {a.title}
                  <span className="ticker-sep">✦</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Donor / Sponsor scroll ticker ── */}
      {siteSettings.show_donor_ticker && donors.length > 0 && (
        <div className="donor-ticker">
          <span className="donor-ticker__label">
            🙏 {t("நன்கொடையாளர்கள்", "Our Donors")}
          </span>
          <div className="donor-ticker__track">
            <div className="donor-ticker__inner">
              {/* eslint-disable-next-line react/no-array-index-key */}
              {[...donors, ...donors].map((d, i) => (
                <span key={i} className="donor-ticker__item">
                  <span className="donor-ticker__name">
                    {d.type === "sponsor" ? "💛 " : "🌸 "}
                    {d.name}
                  </span>
                  {d.label && (
                    <span className="donor-ticker__sub"> — {d.label}</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Daily Nalla Neram strip ── */}
      {siteSettings.show_nalla_strip &&
        nallaTime &&
        (() => {
          const locale = lang === "ta" ? "ta-IN" : "en-IN";
          const istOpts = { timeZone: "Asia/Kolkata" };
          const dateStr = nowIST.toLocaleDateString(locale, {
            ...istOpts,
            weekday: "short",
            day: "numeric",
            month: "short",
            year: "numeric",
          });
          const timeStr = nowIST.toLocaleTimeString(locale, {
            ...istOpts,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          return (
            <div className="nalla-strip">
              <span className="nalla-strip__date">
                📅 {dateStr} &nbsp;🕐 {timeStr}
              </span>
              <span className="nalla-strip__divider">|</span>
              <span className="nalla-strip__icon">✨</span>
              <span className="nalla-strip__label">
                {t("இன்றைய நல்ல நேரம்", "Today's Nalla Neram")}
              </span>
              <span className="nalla-strip__divider">|</span>
              {nallaTime.map((slot, i) => (
                <span key={i} className="nalla-strip__slot">
                  {slot[0]} – {slot[1]}
                  {i < nallaTime.length - 1 && (
                    <span className="nalla-strip__sep">&nbsp;&amp;&nbsp;</span>
                  )}
                </span>
              ))}
              <span className="nalla-strip__suffix">
                {t("(இட்ட நேரம் நல்லது)", "(Auspicious Time)")}
              </span>
            </div>
          );
        })()}

      {/* ── Upcoming Events & Pournami (merged) ── */}
      {(widgetsLoading || widgets.length > 0 || pournamis.length > 0) && (
        <section className="section" style={{ paddingBottom: 0 }}>
          <div className="container">
            <h2 className="section-title">
              {t("அடுத்த நிகழ்வுகள்", "Upcoming Events & Announcements")}
            </h2>
            <div className="divider" />
            <HomepageWidgets
              widgets={widgets}
              loading={widgetsLoading}
              pournami={pournami}
              pournamis={pournamis}
              lang={lang}
            />
          </div>
        </section>
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
              <DevoteeContent
                t={t}
                pulseData={pulseData}
                nallaTime={nallaTime}
                pournami={pournami}
              />
            )}
            {mode === "first-visit" && <FirstVisitContent t={t} />}
            {mode === "nri" && <NriContent t={t} />}
            {mode === "elder" && <ElderContent t={t} pulseData={pulseData} />}
            {mode === "volunteer" && <VolunteerContent t={t} />}
            {mode === "sponsor" && <SponsorContent t={t} />}
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
                    </div>
                  </div>
                ))
              : [
                  ["அபிஷேகம்", "Abhishekam"],
                  ["அர்ச்சனை", "Archana"],
                  ["தீபாராதனை", "Deepa Aradhana"],
                  ["அன்னதானம்", "Annadanam"],
                ].map(([ta, en]) => (
                  <div key={ta} className="seva-card card">
                    <div className="seva-card__body">
                      <h3>{t(ta, en)}</h3>
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
              <h3>{t("படத் தொகுப்பு", "Gallery")}</h3>
              <p>
                {t(
                  "கோயிலையும் திருவிழாகளின் நினைவுமிக துணிப்படங்களைக் காணுங்கள்",
                  "Browse photos of the temple and its festivals",
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

      {/* Google Reviews */}
      <Reviews t={t} />
    </>
  );
}
