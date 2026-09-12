import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import {
  LuArrowRight,
  LuCalendarDays,
  LuCamera,
  LuChevronDown,
  LuCircleUser,
  LuClock,
  LuConstruction,
  LuCreditCard,
  LuDoorClosed,
  LuDoorOpen,
  LuFlame,
  LuFlower2,
  LuGlobe,
  LuHandHeart,
  LuHeart,
  LuHeartHandshake,
  LuImages,
  LuMapPin,
  LuMegaphone,
  LuMoon,
  LuPaintbrush,
  LuPartyPopper,
  LuPhone,
  LuScrollText,
  LuShieldCheck,
  LuSparkles,
  LuSun,
  LuTv,
  LuUserPlus,
  LuUsers,
  LuUtensils,
  LuX,
} from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import { useAuth } from "../context/AuthContext";
import {
  TEMPLE,
  ADDRESS,
  TRUST,
  HISTORY,
  OBSERVANCES,
  FACILITIES,
  PRIMARY_CONTACT,
  formatPhone,
  telHref,
} from "../data/temple";
import {
  NALLA_NERAM,
  TEMPLE_HOURS,
  getISTNow,
  getNextPooja,
  isTempleOpen,
  to12h,
  todayIST,
} from "../lib/templeTime";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import SectionHeader from "../components/ui/SectionHeader";
import SegmentedControl from "../components/ui/Tabs";
import { SkeletonCards } from "../components/ui/Feedback";
import Reviews from "../components/Reviews/Reviews";
import HomepageWidgets from "../components/HomepageWidgets/HomepageWidgets";
import "./Home.css";

/* ─── Derived temple facts (never invented — see data/temple.js, lib/templeTime.js) ─── */
/** "6:00 AM – 12:30 PM", "4:00 PM – 9:00 PM" from the shared TEMPLE_HOURS table. */
const HOURS = TEMPLE_HOURS.map(
  ({ open, close }) => `${to12h(`${open[0]}:${open[1]}`)} – ${to12h(`${close[0]}:${close[1]}`)}`,
);

/** Tiny proof chips under the hero actions — every line is a booklet fact. */
const PROOF = [
  { Icon: LuFlame, ta: "2012 முதல் தினசரி பூஜை", en: "Daily pooja since 2012" },
  { Icon: LuShieldCheck, ta: TRUST.taxExemption.short.ta, en: TRUST.taxExemption.short.en },
  { Icon: LuMoon, ta: OBSERVANCES.pournami.label.ta, en: OBSERVANCES.pournami.label.en },
];

const SEVA_ICONS = [LuFlame, LuFlower2, LuSun, LuUtensils];
const FALLBACK_SEVAS = [
  ["அபிஷேகம்", "Abhishekam"],
  ["அர்ச்சனை", "Archana"],
  ["தீபாராதனை", "Deepa Aradhana"],
  ["அன்னதானம்", "Annadanam"],
];

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
  { id: "devotee", Icon: LuHandHeart, ta: "பக்தர்", en: "Devotee" },
  { id: "first-visit", Icon: LuSparkles, ta: "புதிய வருகை", en: "First Visit" },
  { id: "nri", Icon: LuGlobe, ta: "வெளிநாட்டினர்", en: "NRI / Online" },
  { id: "elder", Icon: LuSun, ta: "மூத்தோர்", en: "Elder View" },
  { id: "volunteer", Icon: LuUsers, ta: "தன்னார்வலர்", en: "Volunteer" },
  { id: "sponsor", Icon: LuHeartHandshake, ta: "ஸ்பான்சர்", en: "Seva Sponsor" },
];

/* ─── Shared tile for the visit-planner modes ─────────────── */
function Tile({ icon, tone, label, index = 0, className = "", children, ...rest }) {
  return (
    <div className={`home-tile card card--static rise ${className}`.trim()} style={{ "--i": index }} {...rest}>
      <span className={`card__icon home-tile__icon${tone ? ` home-tile__icon--${tone}` : ""}`} aria-hidden="true">
        {icon}
      </span>
      <div className="home-tile__body">
        {label && <p className="home-tile__label">{label}</p>}
        {children}
      </div>
    </div>
  );
}

/* ─── Mode content blocks ─────────────────────────────────── */
const BLESSING_KEY = "temple_blessing_hidden";

function DevoteeContent({ t, pulseData, nallaTime, pournami }) {
  const [blessingHidden, setBlessingHidden] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    return localStorage.getItem(BLESSING_KEY) === today;
  });

  const hideBlessing = () => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem(BLESSING_KEY, today);
    setBlessingHidden(true);
  };

  // Use live pulse data if available, else sensible fallbacks
  const nextPoojaName = pulseData?.nextPooja
    ? t(pulseData.nextPooja.name_ta, pulseData.nextPooja.name_en) +
      " · " +
      pulseData.nextPooja.time
    : "—";
  const nextEvent = pulseData?.events?.[0];

  return (
    <div className="home-visit__block">
      <div className="home-visit__grid">
        <Tile index={0} icon={<LuFlame />} label={t("அடுத்த பூஜை", "Next Pooja")}>
          <p className="home-tile__value">{nextPoojaName}</p>
        </Tile>
        <Tile index={1} icon={<LuClock />} label={t("கோயில் நேரம்", "Temple Hours")}>
          <p className="home-tile__value">{HOURS[0]}</p>
          <p className="home-tile__value">{HOURS[1]}</p>
        </Tile>
        {nextEvent && (
          <Tile index={2} icon={<LuPartyPopper />} label={t("அடுத்த திருவிழா", "Next Festival")}>
            <p className="home-tile__value">{t(nextEvent.title_ta, nextEvent.title_en)}</p>
            <p className="home-tile__note">{nextEvent.event_date}</p>
          </Tile>
        )}
        {pournami && (
          <Tile index={3} tone="moon" icon={<LuMoon />} label={t("பௌர்ணமி பூஜை", "Pournami Poojai")}>
            <p className="home-tile__value">
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
              <p className="home-tile__note home-tile__note--accent">{t("இன்று!", "Today!")}</p>
            ) : pournami.daysLeft === 1 ? (
              <p className="home-tile__note">{t("நாளை", "Tomorrow")}</p>
            ) : (
              <p className="home-tile__note">
                {t(`${pournami.daysLeft} நாட்களில்`, `In ${pournami.daysLeft} days`)}
              </p>
            )}
          </Tile>
        )}
        {!nextEvent && !pournami && (
          <Tile index={2} tone="moon" icon={<LuMoon />} label={t("விரைவில்", "Upcoming")}>
            <p className="home-tile__value">{t("பௌர்ணமி பூஜை", "Pournami Poojai")}</p>
          </Tile>
        )}
        {!blessingHidden && (
          <div className="home-tile home-tile--wide card card--static rise" style={{ "--i": 4 }}>
            <span className="card__icon home-tile__icon" aria-hidden="true">
              <LuScrollText />
            </span>
            <div className="home-tile__body">
              <p className="home-tile__label">{t("மஹா சிவராத்திரி", "Maha Shivaratri")}</p>
              <p className="home-tile__text">{t(OBSERVANCES.shivaratri.desc.ta, OBSERVANCES.shivaratri.desc.en)}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="home-tile__dismiss"
              icon={<LuX aria-hidden="true" />}
              onClick={hideBlessing}
              aria-label={t("மறைக்க", "Hide this")}
              title={t("மறைக்க", "Hide this")}
            >
              {t("மறை", "Hide")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function FirstVisitContent({ t }) {
  const steps = [
    { num: "01", title: t("கோயிலை பற்றி", "About the Temple"), body: t(HISTORY.summary.ta, HISTORY.summary.en) },
    {
      num: "02",
      title: t("நடத்தை விதிகள்", "Temple Etiquette"),
      body: t(
        "சுத்தமான உடை அணியவும். செல்போனை அமைதிப்படுத்தவும். காலணி வெளியே வைக்கவும்.",
        "Wear clean attire. Silence your phone. Remove footwear at the entrance.",
      ),
    },
    { num: "03", title: t("வருகை நேரம்", "Visiting Hours"), body: `${HOURS[0]}  |  ${HOURS[1]}` },
    {
      num: "04",
      title: t("உடை விதிமுறை", "Dress Code"),
      body: t(
        "பாரம்பரிய உடை அணியவும். குறுகிய ஆடை அணிவது தவிர்க்கவும்.",
        "Wear traditional attire. Avoid short or casual clothing inside the temple.",
      ),
    },
  ];
  return (
    <div className="home-visit__block">
      <div className="home-steps">
        {steps.map((s, i) => (
          <div key={s.num} className="home-step card card--static rise" style={{ "--i": i }}>
            <span className="home-step__num text-gradient" aria-hidden="true">
              {s.num}
            </span>
            <div>
              <h3 className="home-step__title">{s.title}</h3>
              <p className="home-step__body">{s.body}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="home-visit__cta">
        <Button to="/about" variant="primary">
          {t("மேலும் அறிய →", "Learn More →")}
        </Button>
        <Button to="/contact" variant="outline">
          {t("வழி அறிய →", "Get Directions →")}
        </Button>
      </div>
    </div>
  );
}

function NriContent({ t }) {
  return (
    <div className="home-visit__block">
      <div className="home-visit__grid">
        <Tile index={0} className="home-tile--stack" icon={<LuTv />}>
          <h3 className="home-tile__title">{t("நேரடி ஒளிபரப்பு", "Live Stream")}</h3>
          <p className="home-tile__text">
            {t("தினசரி பூஜைகளை நேரடியாக கண்டுகளிக்கவும்.", "Watch daily poojas live from anywhere in the world.")}
          </p>
          <Button
            href="https://youtube.com/@TempleMahendra"
            target="_blank"
            rel="noopener noreferrer"
            variant="primary"
            size="sm"
          >
            {t("YouTube-ல் பார்க்க", "Watch on YouTube")}
          </Button>
        </Tile>
        <Tile index={1} className="home-tile--stack" icon={<LuCreditCard />}>
          <h3 className="home-tile__title">{t("ஆன்லைன் நன்கொடை", "Online Donation")}</h3>
          <p className="home-tile__text">
            {t(
              `அறக்கட்டளை வங்கிக் கணக்கிற்கு நேரடி பரிமாற்றம் · ${TRUST.taxExemption.short.ta} · ரசீதுக்கு முழு முகவரி தேவை`,
              `Direct transfer to the Trust's bank account · ${TRUST.taxExemption.short.en} · full address required for a receipt`,
            )}
          </p>
          <Button to="/donations#bank-details" variant="primary" size="sm">
            {t("நன்கொடை →", "Donate Online →")}
          </Button>
        </Tile>
        <Tile index={2} className="home-tile--stack" icon={<LuFlame />}>
          <h3 className="home-tile__title">{t("சேவை பதிவு", "Remote Seva Booking")}</h3>
          <p className="home-tile__text">
            {t("நீங்கள் இல்லாமலேயே உங்கள் பெயரில் சேவை நடத்தலாம்.", "Perform a seva on your behalf remotely.")}
          </p>
          <Button to="/sevas" variant="outline" size="sm">
            {t("சேவை பார்க்க", "View Sevas")}
          </Button>
        </Tile>
        <Tile index={3} className="home-tile--stack" icon={<LuImages />}>
          <h3 className="home-tile__title">{t("படத் தொகுப்பு", "Temple Gallery")}</h3>
          <p className="home-tile__text">
            {t(
              "திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகளின் படங்களை பாருங்கள்.",
              "Relive temple festivals and events through our photo gallery.",
            )}
          </p>
          <Button to="/gallery" variant="outline" size="sm">
            {t("படங்கள் காண →", "View Gallery →")}
          </Button>
        </Tile>
      </div>
    </div>
  );
}

function ElderContent({ t, pulseData }) {
  const isOpen = pulseData?.open ?? null;
  return (
    <div className="home-visit__block">
      <div className="home-visit__grid">
        {isOpen !== null && (
          <Tile
            index={0}
            className={isOpen ? "home-tile--open" : "home-tile--closed"}
            icon={isOpen ? <LuDoorOpen /> : <LuDoorClosed />}
            label={t("இப்போது நிலை", "Current Status")}
          >
            <p className="home-tile__value">
              {isOpen ? t("கோயில் திறந்தது", "Temple Open") : t("கோயில் மூடியது", "Temple Closed")}
            </p>
          </Tile>
        )}
        <Tile
          index={1}
          icon={<LuPhone />}
          label={`${t("தொடர்பு கொள்ள", "Call Temple")} — ${t(PRIMARY_CONTACT.role.ta, PRIMARY_CONTACT.role.en)}`}
        >
          <a
            href={telHref(PRIMARY_CONTACT.phone)}
            className="home-tile__value home-tile__value--link"
            aria-label={`${formatPhone(PRIMARY_CONTACT.phone)} — ${t(PRIMARY_CONTACT.name.ta, PRIMARY_CONTACT.name.en)}, ${t(PRIMARY_CONTACT.role.ta, PRIMARY_CONTACT.role.en)}`}
          >
            {formatPhone(PRIMARY_CONTACT.phone)}
          </a>
        </Tile>
        <Tile index={2} icon={<LuClock />} label={t("கோயில் நேரம்", "Temple Hours")}>
          <p className="home-tile__value">{HOURS[0]}</p>
          <p className="home-tile__value">{HOURS[1]}</p>
        </Tile>
        <Tile index={3} icon={<LuConstruction />} label={t(FACILITIES.label.ta, FACILITIES.label.en)}>
          <p className="home-tile__value">{t(FACILITIES.status.ta, FACILITIES.status.en)}</p>
        </Tile>
      </div>
      <div className="home-visit__cta">
        <Button to="/sevas" variant="primary" size="lg">
          {t("சேவை பதிவு →", "Book a Seva →")}
        </Button>
        <Button to="/contact" variant="outline" size="lg">
          {t("வழி அறிய →", "Get Directions →")}
        </Button>
      </div>
    </div>
  );
}

function VolunteerContent({ t }) {
  const roles = [
    { Icon: LuFlower2, title: t("பூ அலங்காரம்", "Flower Decoration"), body: t("திருவிழா நாட்களில் கோவில் அலங்கரிக்க உதவுங்கள்.", "Help decorate the temple on festival days.") },
    { Icon: LuUtensils, title: t("அன்னதானம்", "Annadanam"), body: t("பக்தர்களுக்கு இலவச உணவு வழங்குவதில் பங்கேற்கலாம்.", "Participate in serving free food to devotees.") },
    { Icon: LuPaintbrush, title: t("சுத்தம் & பராமரிப்பு", "Cleaning & Upkeep"), body: t("கோவில் வளாகத்தை சுத்தமாக வைக்க உதவுங்கள்.", "Help keep the temple premises clean and tidy.") },
    { Icon: LuMegaphone, title: t("நிகழ்வு ஒருங்கிணைப்பு", "Event Coordination"), body: t("திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகளை ஒருங்கிணைக்க.", "Coordinate festivals and special poojas.") },
    { Icon: LuCamera, title: t("படம் & பதிவு", "Photography & Docs"), body: t("கோவில் நிகழ்வுகளை படம் எடுத்து பதிவு செய்யுங்கள்.", "Help document and photograph temple events for memory.") },
  ];
  return (
    <div className="home-visit__block">
      <div className="home-visit__grid home-visit__grid--dense">
        {roles.map(({ Icon, title, body }, i) => (
          <Tile key={title} index={i} className="home-tile--stack home-tile--accent" icon={<Icon />}>
            <h3 className="home-tile__title">{title}</h3>
            <p className="home-tile__text">{body}</p>
          </Tile>
        ))}
      </div>
      <div className="home-visit__cta">
        <Button to="/contact" variant="primary">
          {t("தொடர்பு கொள்ள →", "Get in Touch →")}
        </Button>
      </div>
    </div>
  );
}

function SponsorContent({ t }) {
  const options = [
    { Icon: LuFlame, name: t("அபிஷேகம்", "Abhishekam"), desc: t("திருமேனி அலங்காரத்துடன்", "With divine adornment") },
    { Icon: LuFlower2, name: t("அர்ச்சனை", "Archana"), desc: t("108 நாம ஸ்துதி", "108-name worship") },
    { Icon: LuUtensils, name: t("அன்னதானம்", "Annadanam"), desc: t("பக்தர்களுக்கு உணவு", "Meal for devotees") },
  ];
  return (
    <div className="home-visit__block">
      <div className="home-sponsor card card--gold card--static rise" style={{ "--i": 0 }}>
        <span className="card__icon home-sponsor__icon" aria-hidden="true">
          <LuHeartHandshake />
        </span>
        <div className="home-sponsor__body">
          <h3 className="home-sponsor__title">{t("சேவையை தானம் செய்யுங்கள்", "Sponsor a Sacred Seva")}</h3>
          <p className="home-sponsor__sub">
            {t(
              "உங்கள் பெயரில் அல்லது குடும்பத்தினர் பெயரில் ஒரு பூஜையை நடத்தி ஆசி பெறுங்கள்.",
              "Offer a pooja in your name or your family's name and receive the blessings of the Goddess.",
            )}
          </p>
        </div>
      </div>
      <div className="home-sponsor__list">
        {options.map(({ Icon, name, desc }, i) => (
          <div key={name} className="home-sponsor__option card card--static rise" style={{ "--i": i + 1 }}>
            <span className="card__icon" aria-hidden="true">
              <Icon />
            </span>
            <div className="home-sponsor__option-body">
              <p className="home-sponsor__option-name">{name}</p>
              <p className="home-sponsor__option-desc">{desc}</p>
            </div>
            <Button to="/sevas" variant="outline" size="sm">
              {t("பதிவு →", "Book →")}
            </Button>
          </div>
        ))}
      </div>
      <div className="home-visit__cta">
        <Button to="/donations" variant="primary">
          {t("நன்கொடை →", "Donate →")}
        </Button>
        <Button to="/sevas" variant="outline">
          {t("அனைத்து சேவைகள் →", "All Sevas →")}
        </Button>
      </div>
    </div>
  );
}

export default function Home() {
  const [announcements, setAnnouncements] = useState([]);
  const [events, setEvents] = useState([]);
  const [sevas, setSevas] = useState([]);
  const [sevasLoading, setSevasLoading] = useState(true);
  const [pulseData, setPulseData] = useState(null);
  const [widgets, setWidgets] = useState([]);
  const [widgetsLoading, setWidgetsLoading] = useState(true);
  const [pournami, setPournami] = useState(null);
  const [pournamis, setPournamis] = useState([]);
  const [donors, setDonors] = useState([]);
  // Nalla Neram by IST weekday (0=Sun … 6=Sat) — same table as backend (lib/templeTime)
  const istWeekday = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  ).getDay();
  const [nallaTime, setNallaTime] = useState(NALLA_NERAM[istWeekday]);
  const [nowIST, setNowIST] = useState(() => new Date());
  const [siteSettings, setSiteSettings] = useState({
    show_pournami_section: true,
    show_nalla_strip: true,
    show_donor_ticker: true,
  });
  const { lang, t } = useLang();
  const { user, accountsEnabled } = useAuth();
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
      .get("/events?limit=4&upcoming=1")
      .then((r) => setEvents(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
    api
      .get("/sevas?limit=4&featured=1")
      .then((r) => setSevas(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setSevasLoading(false));
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

  /* ── Live derivations (re-run every tick) ── */
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  const istOpts = { timeZone: "Asia/Kolkata" };
  const istNow = getISTNow();
  const open = pulseData?.open ?? isTempleOpen(istNow);
  const fallbackPooja = getNextPooja(istNow).pooja;
  const nextPoojaLabel = pulseData?.nextPooja
    ? `${t(pulseData.nextPooja.name_ta, pulseData.nextPooja.name_en)} · ${pulseData.nextPooja.time}`
    : `${t(fallbackPooja.ta, fallbackPooja.en)} · ${to12h(`${fallbackPooja.h}:${fallbackPooja.m}`)}`;
  const heroDate = nowIST.toLocaleDateString(locale, {
    ...istOpts,
    weekday: "short",
    day: "numeric",
    month: "short",
  });
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

  const showNotices = announcements.length > 0;
  const showNalla = Boolean(siteSettings.show_nalla_strip && nallaTime);
  const showDonors = Boolean(siteSettings.show_donor_ticker && donors.length > 0);

  return (
    <>
      <Helmet>
        <title>
          {t("முகப்பு", "Home")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      {/* ── Hero ── */}
      <section className="home-hero" aria-labelledby="home-hero-title">
        <div className="home-hero__lattice" aria-hidden="true" />
        <div className="container home-hero__content">
          <div className="home-hero__copy rise" style={{ "--i": 0 }}>
            <p className="home-hero__eyebrow">
              <LuSparkles aria-hidden="true" />
              <span>{t(TEMPLE.invocation.ta, TEMPLE.invocation.en)}</span>
            </p>
            <h1 id="home-hero-title" className="home-hero__title">
              {t(TEMPLE.name.ta, TEMPLE.name.en)}
            </h1>
            <p className="home-hero__meta">
              {t(TEMPLE.descriptor.ta, TEMPLE.descriptor.en)} · {t(ADDRESS.printed.ta, ADDRESS.printed.en)}
            </p>
            <p className="home-hero__lead">
              {t(
                "பக்தி, பாரம்பரியம் மற்றும் சமூகம் — ஒரு புனிதத் தலம்",
                "A sacred place of devotion, tradition, and community",
              )}
            </p>
            <div className="home-hero__actions">
              <Button to="/sevas" variant="gold" size="lg" icon={<LuSparkles aria-hidden="true" />}>
                {t("சேவை பதிவு செய்ய", "Book a Seva")}
              </Button>
              {/* Shown to a guest only, and only once accounts are switched on.
                  A signed-in devotee gets the route to their own records. */}
              {accountsEnabled && !user && (
                <Button to="/register" variant="primary" size="lg" icon={<LuUserPlus aria-hidden="true" />}>
                  {t("கணக்கு தொடங்க", "Get Started")}
                </Button>
              )}
              {user && (
                <Button to="/account" variant="primary" size="lg" icon={<LuCircleUser aria-hidden="true" />}>
                  {t("என் கணக்கு", "My Account")}
                </Button>
              )}
              <Button to="/contact" variant="outline-light" size="lg" icon={<LuMapPin aria-hidden="true" />}>
                {t("வழி அறிய", "Get Directions")}
              </Button>
            </div>
            {accountsEnabled && !user && (
              <p className="home-hero__signin">
                {t("ஏற்கனவே கணக்கு உள்ளதா?", "Already have an account?")}{" "}
                <Link to="/login">{t("உள்நுழையுங்கள்", "Sign in")}</Link>
              </p>
            )}
            <ul className="home-hero__proof" aria-label={t("கோயில் சிறப்புகள்", "Temple highlights")}>
              {PROOF.map(({ Icon, ta, en }) => (
                <li key={en} className="home-hero__chip">
                  <Icon aria-hidden="true" />
                  {t(ta, en)}
                </li>
              ))}
            </ul>
          </div>

          {/* Live glass status panel */}
          <aside
            className="home-hero__panel card card--ink card--static rise"
            style={{ "--i": 2 }}
            aria-label={t("இன்றைய நிலை", "Today at the temple")}
          >
            <div className="home-hero__head">
              <Badge tone="on-dark" live className={`home-hero__live home-hero__live--${open ? "open" : "closed"}`}>
                <span className="sr-only">{t("நேரலை", "Live")}: </span>
                {open ? t("கோயில் திறந்துள்ளது", "Temple Open") : t("கோயில் மூடியுள்ளது", "Temple Closed")}
              </Badge>
              <time className="home-hero__date" dateTime={todayIST()}>
                {heroDate} <span>IST</span>
              </time>
            </div>
            <dl className="home-hero__list">
              <div>
                <dt>{t("அடுத்த பூஜை", "Next Pooja")}</dt>
                <dd>
                  {nextPoojaLabel}
                  {!pulseData?.nextPooja && <small>{t("தினசரி பூஜை", "Daily Pooja")}</small>}
                </dd>
              </div>
              <div>
                <dt>{t("கோயில் நேரம்", "Temple Hours")}</dt>
                <dd>{HOURS.join(" · ")}</dd>
              </div>
              {pournami && (
                <div className="home-hero__row--moon">
                  <dt>{t("அடுத்த பௌர்ணமி", "Next Pournami")}</dt>
                  <dd>
                    {new Date(pournami.date + "T00:00:00").toLocaleDateString(locale, {
                      day: "numeric",
                      month: "short",
                    })}
                    {pournami.daysLeft === 0
                      ? ` · ${t("இன்று", "Today")}`
                      : ` · ${t(`${pournami.daysLeft} நாட்களில்`, `in ${pournami.daysLeft} days`)}`}
                  </dd>
                </div>
              )}
            </dl>
            <a
              href={telHref(PRIMARY_CONTACT.phone)}
              className="home-hero__call"
              aria-label={`${t("கோயிலை அழைக்க", "Call Temple")} — ${formatPhone(PRIMARY_CONTACT.phone)}, ${t(PRIMARY_CONTACT.role.ta, PRIMARY_CONTACT.role.en)}`}
            >
              <LuPhone aria-hidden="true" />
              <span>{formatPhone(PRIMARY_CONTACT.phone)}</span>
              <small>{t(PRIMARY_CONTACT.role.ta, PRIMARY_CONTACT.role.en)}</small>
            </a>
          </aside>
        </div>
        <div className="home-hero__scroll" aria-hidden="true">
          <LuChevronDown />
        </div>
      </section>

      {/* ── Live band: notices · nalla neram · donors ── */}
      {(showNotices || showNalla || showDonors) && (
        <div className="live-band" role="region" aria-label={t("நேரலை தகவல்", "Live updates")}>
          <div className="container live-band__inner">
            {showNotices && (
              <div className="live-band__seg live-band__seg--notices">
                <span className="live-band__label">
                  <LuMegaphone aria-hidden="true" />
                  {t("அறிவிப்பு", "Notice")}
                </span>
                <div
                  className="live-band__marquee"
                  role="marquee"
                  tabIndex={0}
                  aria-label={t("அறிவிப்புகள்", "Announcements")}
                >
                  <div className="live-band__track">
                    {[...announcements, ...announcements].map((a, i) => {
                      const dup = i >= announcements.length;
                      return (
                        // eslint-disable-next-line react/no-array-index-key
                        <span
                          key={i}
                          className={`live-band__item${dup ? " live-band__item--dup" : ""}`}
                          aria-hidden={dup || undefined}
                        >
                          {a.title}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {showNalla && (
              <div className="live-band__seg live-band__seg--nalla">
                <span className="live-band__label live-band__label--sage">
                  <LuClock aria-hidden="true" />
                  {t("இன்றைய நல்ல நேரம்", "Today's Nalla Neram")}
                </span>
                <time className="live-band__clock" dateTime={todayIST()}>
                  {dateStr} · {timeStr}
                </time>
                <span className="live-band__slots">
                  {nallaTime.map((slot, i) => (
                    // eslint-disable-next-line react/no-array-index-key
                    <Badge key={i} tone="sage">
                      {slot[0]} – {slot[1]}
                    </Badge>
                  ))}
                </span>
                <span className="live-band__suffix">{t("(இட்ட நேரம் நல்லது)", "(Auspicious Time)")}</span>
              </div>
            )}

            {showDonors && (
              <div className="live-band__seg live-band__seg--donors">
                <span className="live-band__label">
                  <LuHeartHandshake aria-hidden="true" />
                  {t("நன்கொடையாளர்கள்", "Our Donors")}
                </span>
                <div
                  className="live-band__marquee"
                  role="marquee"
                  tabIndex={0}
                  aria-label={t("நன்கொடையாளர்கள்", "Our Donors")}
                >
                  <div className="live-band__track live-band__track--slow">
                    {[...donors, ...donors].map((d, i) => {
                      const dup = i >= donors.length;
                      return (
                        // eslint-disable-next-line react/no-array-index-key
                        <span
                          key={i}
                          className={`live-band__item${dup ? " live-band__item--dup" : ""}`}
                          aria-hidden={dup || undefined}
                        >
                          {d.type === "sponsor" ? <LuHeart aria-hidden="true" /> : <LuFlower2 aria-hidden="true" />}
                          <span className="live-band__name">{d.name}</span>
                          {d.label && <span className="live-band__sub"> — {d.label}</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Upcoming Events & Pournami (merged) ── */}
      {(widgetsLoading ||
        widgets.length > 0 ||
        (siteSettings.show_pournami_section && pournamis.length > 0)) && (
        <section className="section section--flush-bottom reveal" aria-labelledby="home-upcoming-title">
          <div className="container">
            <SectionHeader
              id="home-upcoming-title"
              align="split"
              eyebrow={t("இன்று & விரைவில்", "Now & next")}
              title={t("அடுத்த நிகழ்வுகள்", "Upcoming Events & Announcements")}
              actions={
                <Button to="/events" variant="outline" size="sm">
                  {t("அனைத்து நிகழ்வுகள் →", "All Events →")}
                </Button>
              }
            />
            <HomepageWidgets
              widgets={widgets}
              loading={widgetsLoading}
              pournami={siteSettings.show_pournami_section ? pournami : null}
              pournamis={siteSettings.show_pournami_section ? pournamis : []}
              lang={lang}
            />
          </div>
        </section>
      )}

      {/* ── Digital Darshan Flow: Mode Switcher ── */}
      <section className="section home-visit reveal" aria-labelledby="home-visit-title">
        <div className="container">
          <SectionHeader
            id="home-visit-title"
            align="split"
            eyebrow={t("டிஜிட்டல் தரிசனம்", "Digital darshan")}
            title={t("உங்கள் வருகையைத் திட்டமிடுங்கள்", "Plan your visit")}
            subtitle={t(
              "உங்கள் வருகை வகையைத் தேர்ந்தெடுங்கள் — தகவல்கள் அதற்கேற்ப மாறும்.",
              "Choose how you're visiting and the details adapt to you.",
            )}
            actions={
              <SegmentedControl
                label={t("உங்கள் வருகை வகை:", "Your Visit Type:")}
                value={mode}
                onChange={setMode}
                className="home-visit__tabs"
                items={MODES.map(({ id, Icon, ta, en }) => ({
                  value: id,
                  label: t(ta, en),
                  icon: <Icon aria-hidden="true" />,
                }))}
              />
            }
          />

          {/* Mode-specific content */}
          <div className={`home-visit__content${mode === "elder" ? " home-visit__content--elder" : ""}`}>
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

      {/* ── Featured Sevas ── */}
      <section className="section reveal" aria-labelledby="home-sevas-title">
        <div className="container">
          <SectionHeader
            id="home-sevas-title"
            eyebrow={t("ஆன்லைன் பதிவு", "Online booking")}
            title={t("சேவைகள்", "Sevas")}
            subtitle={t(
              "கோயிலில் தினசரி மற்றும் சிறப்பு பூஜைகளை பதிவு செய்யுங்கள்",
              "Book daily and special poojas at the temple",
            )}
          />
          {sevasLoading ? (
            <SkeletonCards count={4} />
          ) : (
            <div className="grid-4">
              {sevas.length > 0
                ? sevas.map((s, i) => {
                    const Icon = SEVA_ICONS[i % SEVA_ICONS.length];
                    return (
                      <Link to="/sevas" key={s.id} className="home-seva card card--interactive rise" style={{ "--i": i }}>
                        <span className="card__icon" aria-hidden="true">
                          <Icon />
                        </span>
                        <h3 className="home-seva__name">{lang === "ta" ? s.name_ta : s.name_en}</h3>
                        {s.amount != null && <p className="home-seva__price text-gradient">₹{s.amount}</p>}
                        <span className="home-seva__cta">
                          {t("பதிவு", "Book")}
                          <LuArrowRight aria-hidden="true" />
                        </span>
                      </Link>
                    );
                  })
                : FALLBACK_SEVAS.map(([ta, en], i) => {
                    const Icon = SEVA_ICONS[i % SEVA_ICONS.length];
                    return (
                      <Link to="/sevas" key={ta} className="home-seva card card--interactive rise" style={{ "--i": i }}>
                        <span className="card__icon" aria-hidden="true">
                          <Icon />
                        </span>
                        <h3 className="home-seva__name">{t(ta, en)}</h3>
                        <span className="home-seva__cta">
                          {t("பதிவு", "Book")}
                          <LuArrowRight aria-hidden="true" />
                        </span>
                      </Link>
                    );
                  })}
            </div>
          )}
          <div className="section-cta">
            <Button to="/sevas" variant="outline">
              {t("அனைத்து சேவைகளும் →", "View All Sevas →")}
            </Button>
          </div>
        </div>
      </section>

      {/* ── Upcoming Events ── */}
      <section className="section section--alt reveal" aria-labelledby="home-events-title">
        <div className="container">
          <SectionHeader
            id="home-events-title"
            eyebrow={t("திருவிழாக்கள்", "Festivals")}
            title={t("நிகழ்வுகள்", "Events")}
            subtitle={t(
              "வரவிருக்கும் திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகள்",
              "Upcoming festivals and special occasions",
            )}
          />
          <div className="grid-4">
            {events.length > 0
              ? events.map((e, i) => {
                  const d = new Date(e.event_date + "T00:00:00");
                  return (
                    <article key={e.id} className="home-event card card--static rise" style={{ "--i": i }}>
                      <time className="home-event__date" dateTime={e.event_date}>
                        <span className="home-event__day">{d.toLocaleDateString(locale, { day: "numeric" })}</span>
                        <span className="home-event__month">
                          {d.toLocaleDateString(locale, { month: "short", year: "numeric" })}
                        </span>
                      </time>
                      <div className="home-event__body">
                        <h3>{lang === "ta" ? e.title_ta : e.title_en}</h3>
                        {e.description && <p>{e.description}</p>}
                      </div>
                    </article>
                  );
                })
              : [
                  { ...OBSERVANCES.pournami, tone: "moon" },
                  { ...OBSERVANCES.shivaratri, tone: "" },
                ].map(({ label, when, tone }, i) => (
                  <article key={label.en} className="home-event card card--static rise" style={{ "--i": i }}>
                    <span className={`home-event__date home-event__date--recurring${tone ? ` home-event__date--${tone}` : ""}`}>
                      {tone === "moon" ? <LuMoon aria-hidden="true" /> : <LuCalendarDays aria-hidden="true" />}
                      <span className="home-event__month">{t(when.ta, when.en)}</span>
                    </span>
                    <div className="home-event__body">
                      <h3>{t(label.ta, label.en)}</h3>
                    </div>
                  </article>
                ))}
          </div>
          <div className="section-cta">
            <Button to="/events" variant="outline">
              {t("அனைத்து நிகழ்வுகளும் →", "View All Events →")}
            </Button>
          </div>
        </div>
      </section>

      {/* ── Quick actions ── */}
      <section className="section reveal" aria-label={t("விரைவு இணைப்புகள்", "Quick links")}>
        <div className="container">
          <div className="grid-3">
            <Link to="/donations" className="home-quick__card card card--interactive rise" style={{ "--i": 0 }}>
              <span className="card__icon" aria-hidden="true">
                <LuHeartHandshake />
              </span>
              <h3>{t("நன்கொடை", "Donate")}</h3>
              <p>
                {t(
                  `கும்பாபிஷேகம் & அன்னதான கூடத்திற்கு நன்கொடை · அறக்கட்டளை பெயரில் வங்கி / காசோலை · ${TRUST.taxExemption.short.ta}`,
                  `Donate for the Kumbabhishekam & annadanam hall · Bank transfer or cheque in the Trust's name · ${TRUST.taxExemption.short.en}`,
                )}
              </p>
            </Link>
            <Link to="/gallery" className="home-quick__card card card--interactive rise" style={{ "--i": 1 }}>
              <span className="card__icon" aria-hidden="true">
                <LuImages />
              </span>
              <h3>{t("படத் தொகுப்பு", "Gallery")}</h3>
              <p>
                {t(
                  "கோயிலையும் திருவிழாகளின் நினைவுமிக துணிப்படங்களைக் காணுங்கள்",
                  "Browse photos of the temple and its festivals",
                )}
              </p>
            </Link>
            <Link to="/contact" className="home-quick__card card card--interactive rise" style={{ "--i": 2 }}>
              <span className="card__icon" aria-hidden="true">
                <LuMapPin />
              </span>
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

      {/* ── Google Reviews ── */}
      <Reviews t={t} />
    </>
  );
}
