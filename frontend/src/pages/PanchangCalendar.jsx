import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import {
  LuCalendarDays,
  LuCalendarX,
  LuChevronLeft,
  LuChevronRight,
  LuClock,
  LuMoon,
  LuSparkles,
  LuSunrise,
  LuTriangleAlert,
} from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import { NALLA_NERAM as NALLA, to12h } from "../lib/templeTime";
import PageHero from "../components/ui/PageHero";
import SectionHeader from "../components/ui/SectionHeader";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { EmptyState, SkeletonText } from "../components/ui/Feedback";
import "./PanchangCalendar.css";

// ── Helpers ────────────────────────────────────────────────────────────────────

const MONTH_TA = [
  "",
  "ஜனவரி",
  "பிப்ரவரி",
  "மார்ச்",
  "ஏப்ரல்",
  "மே",
  "ஜூன்",
  "ஜூலை",
  "ஆகஸ்ட்",
  "செப்டம்பர்",
  "அக்டோபர்",
  "நவம்பர்",
  "டிசம்பர்",
];

const WDAY_SHORT_TA = ["ஞா", "திங்", "செவ்", "புத", "வியா", "வெள்", "சனி"];
const WDAY_SHORT_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* Cultural glyphs for each observance (content, not UI chrome) */
const TYPE_ICONS = {
  pournami: "🌕",
  amavasai: "🌑",
  ekadasi: "🍃",
  sashti: "🪔",
  pradosham: "🔥",
  festival: "🎊",
  chaturthi: "🐘",
  pratipada: "🌙",
};

/* Badge tone per observance — lunar → moon, auspicious → sage, status tones otherwise */
const TYPE_TONE = {
  pournami: "moon",
  amavasai: "default",
  ekadasi: "sage",
  sashti: "gold",
  pradosham: "warning",
  festival: "danger",
  chaturthi: "info",
  pratipada: "moon",
};

// Fallback calendar data computed client-side (for offline / API down)
function clientTithi(year, month, day) {
  const REF_JDE = 2451549.26; // 2000-01-06 new moon
  const SYNODIC = 29.530588853;
  // Julian Day Number at noon
  let y = year,
    m = month;
  if (m <= 2) {
    y--;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const jd =
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    B -
    1524.5 +
    0.25;
  let phase = ((jd - REF_JDE) / SYNODIC) % 1;
  if (phase < 0) phase += 1;
  return Math.floor(phase * 30) % 30;
}

const TITHI_TA = [
  "பிரதிபதை",
  "துவிதியை",
  "திருதியை",
  "சதுர்த்தி",
  "பஞ்சமி",
  "சஷ்டி",
  "சப்தமி",
  "அஷ்டமி",
  "நவமி",
  "தசமி",
  "ஏகாதசி",
  "துவாதசி",
  "திரயோதசி",
  "சதுர்தசி",
  "பௌர்ணமி",
  "பிரதிபதை",
  "துவிதியை",
  "திருதியை",
  "சதுர்த்தி",
  "பஞ்சமி",
  "சஷ்டி",
  "சப்தமி",
  "அஷ்டமி",
  "நவமி",
  "தசமி",
  "ஏகாதசி",
  "துவாதசி",
  "திரயோதசி",
  "சதுர்தசி",
  "அமாவாசை",
];
const TITHI_EN = [
  "Pratipada",
  "Dvitiya",
  "Tritiya",
  "Chaturthi",
  "Panchami",
  "Sashti",
  "Saptami",
  "Ashtami",
  "Navami",
  "Dasami",
  "Ekadasi",
  "Dvadasi",
  "Trayodasi",
  "Chaturdasi",
  "Pournami",
  "Pratipada",
  "Dvitiya",
  "Tritiya",
  "Chaturthi",
  "Panchami",
  "Sashti",
  "Saptami",
  "Ashtami",
  "Navami",
  "Dasami",
  "Ekadasi",
  "Dvadasi",
  "Trayodasi",
  "Chaturdasi",
  "Amavasai",
];

const RAHU = [
  ["16:30", "18:00"],
  ["07:30", "09:00"],
  ["15:00", "16:30"],
  ["12:00", "13:30"],
  ["13:30", "15:00"],
  ["10:30", "12:00"],
  ["09:00", "10:30"],
];
const YAMA = [
  ["12:00", "13:30"],
  ["10:30", "12:00"],
  ["09:00", "10:30"],
  ["07:30", "09:00"],
  ["06:00", "07:30"],
  ["15:00", "16:30"],
  ["13:30", "15:00"],
];
const GULI = [
  ["15:00", "16:30"],
  ["13:30", "15:00"],
  ["12:00", "13:30"],
  ["10:30", "12:00"],
  ["09:00", "10:30"],
  ["07:30", "09:00"],
  ["06:00", "07:30"],
];
// NALLA (nalla neram by weekday) is imported from lib/templeTime.js — same table.
const FIXED_FESTIVALS = {
  "01-14": "Pongal",
  "01-15": "Mattu Pongal",
  "01-16": "Kaanum Pongal",
  "04-14": "Tamil New Year",
  "04-15": "Vishu",
  "10-02": "Navratri Begin",
  "11-01": "Deepavali",
};

function buildFallback(year, month) {
  const days = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  const today = new Date();
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    const wd = dt.getDay();
    const tithi = clientTithi(year, month, d);
    const mm = String(month).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    const md = `${mm}-${dd}`;
    const special = [];
    if (tithi === 14)
      special.push({ type: "pournami", ta: "பௌர்ணமி", en: "Pournami" });
    if (tithi === 29)
      special.push({ type: "amavasai", ta: "அமாவாசை", en: "Amavasai" });
    if (tithi === 10 || tithi === 25)
      special.push({ type: "ekadasi", ta: "ஏகாதசி", en: "Ekadasi" });
    if (tithi === 5 || tithi === 20)
      special.push({ type: "sashti", ta: "சஷ்டி", en: "Sashti" });
    if (tithi === 12 || tithi === 27)
      special.push({ type: "pradosham", ta: "பிரதோஷம்", en: "Pradosham" });
    if (tithi === 3)
      special.push({ type: "chaturthi", ta: "சதுர்த்தி", en: "Chaturthi" });
    if (FIXED_FESTIVALS[md])
      special.push({
        type: "festival",
        ta: FIXED_FESTIVALS[md],
        en: FIXED_FESTIVALS[md],
      });
    days.push({
      date: `${year}-${mm}-${dd}`,
      day: d,
      weekday: wd,
      weekday_ta: [
        "ஞாயிறு",
        "திங்கள்",
        "செவ்வாய்",
        "புதன்",
        "வியாழன்",
        "வெள்ளி",
        "சனி",
      ][wd],
      weekday_en: [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ][wd],
      tithi,
      tithi_ta: TITHI_TA[tithi],
      tithi_en: TITHI_EN[tithi],
      special,
      timings: {
        brahma_muhurtham: ["04:30", "06:00"],
        nalla_neram: NALLA[wd],
        rahu_kalam: RAHU[wd],
        yamagandam: YAMA[wd],
        gulika_kalam: GULI[wd],
      },
    });
  }
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const todayData = days.find((d) => d.date === todayStr) ?? null;
  const upcoming = days.filter(
    (d) => d.date >= todayStr && d.special.length > 0,
  );
  return { year, month, days, today: todayData, upcoming };
}

/* "07:30","09:00" → "7:30 AM – 9:00 AM" */
const fmtRange = (pair) => `${to12h(pair[0])} – ${to12h(pair[1])}`;
/* Accepts a single [from,to] pair or a list of pairs */
const fmtTimes = (times) =>
  Array.isArray(times[0]) ? times.map(fmtRange).join(" · ") : fmtRange(times);

const localeOf = (lang) => (lang === "ta" ? "ta-IN" : "en-IN");
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ── Sub-components ─────────────────────────────────────────────────────────────

/** Observance pill — tone by type (lunar → moon, ekadasi → sage, …). */
function SpecialBadge({ s, t, onDark = false }) {
  const tone = onDark ? "on-dark" : TYPE_TONE[s.type] ?? "default";
  const cls = !onDark && s.type === "amavasai" ? "panchang-badge--ink" : "";
  return (
    <Badge tone={tone} className={cls}>
      <span className="panchang-badge__glyph" aria-hidden="true">
        {TYPE_ICONS[s.type] ?? "✦"}
      </span>
      {t(s.ta, s.en)}
    </Badge>
  );
}

/** Hero aside: today's tithi, weekday and nalla neram (from API/fallback `today`). */
function TodayCard({ today, loading, lang, t, onView }) {
  if (!today) {
    return (
      <div className="card card--ink panchang-today" aria-busy={loading || undefined}>
        <span className="panchang-today__eyebrow">
          <LuCalendarDays aria-hidden="true" /> {t("இன்று", "Today")}
        </span>
        {loading ? (
          <SkeletonText lines={3} />
        ) : (
          <p className="panchang-today__empty">
            {t("இன்றைய பஞ்சாங்கம் கிடைக்கவில்லை", "Today's panchangam is unavailable")}
          </p>
        )}
      </div>
    );
  }

  const dateLabel = new Date(today.date + "T00:00:00").toLocaleDateString(localeOf(lang), {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const main = today.special?.[0];
  const glyph = main ? TYPE_ICONS[main.type] ?? "✦" : "🌙";
  const nalla = today.timings?.nalla_neram ?? [];

  return (
    <div className="card card--ink panchang-today">
      <div className="panchang-today__head">
        <span className="panchang-today__eyebrow">
          <LuCalendarDays aria-hidden="true" /> {t("இன்று", "Today")}
        </span>
        <span className="panchang-today__date">{dateLabel}</span>
      </div>

      <div className="panchang-today__tithi">
        <span className="panchang-today__glyph" aria-hidden="true">
          {glyph}
        </span>
        <div className="panchang-today__text">
          <strong>{t(today.tithi_ta, today.tithi_en)}</strong>
          <small>
            {t(today.weekday_ta, today.weekday_en)}
            {today.tamil_month && ` · ${t(today.tamil_month.ta, today.tamil_month.en)}`}
          </small>
        </div>
      </div>

      {today.special?.length > 0 && (
        <div className="panchang-today__special">
          {today.special.map((s) => (
            <SpecialBadge key={s.type} s={s} t={t} onDark />
          ))}
        </div>
      )}

      <div className="panchang-today__nalla">
        <span className="panchang-today__label">
          <LuSparkles aria-hidden="true" /> {t("நல்ல நேரம்", "Nalla Neram")}
        </span>
        <div className="panchang-today__pills">
          {nalla.map((slot) => (
            <Badge key={slot[0]} tone="sage">
              {fmtRange(slot)}
            </Badge>
          ))}
        </div>
      </div>

      <Button
        variant="outline-light"
        className="panchang-today__cta"
        icon={<LuMoon aria-hidden="true" />}
        onClick={onView}
      >
        {t("இன்றைய விவரம்", "Today's details")}
      </Button>
    </div>
  );
}

function TimingCard({ label, times, variant, icon }) {
  const timeStr = fmtTimes(times);
  return (
    <div className={`panchang-timing panchang-timing--${variant}`}>
      <dt className="panchang-timing__label">
        {icon}
        {label}
      </dt>
      <dd className="panchang-timing__time">{timeStr}</dd>
    </div>
  );
}

function DayDetail({ day, lang, t, panelRef }) {
  if (!day) {
    return (
      <div ref={panelRef} id="panchang-detail" className="panchang-detail">
        <EmptyState compact icon={<LuCalendarX />} title={t("ஒரு நாளை தேர்ந்தெடுக்கவும்", "Select a day")}>
          {t(
            "விவரங்களைக் காண நாட்காட்டியில் ஒரு நாளை தேர்ந்தெடுக்கவும்.",
            "Pick a day in the calendar to see its tithi and timings.",
          )}
        </EmptyState>
      </div>
    );
  }
  const dateObj = new Date(day.date + "T00:00:00");
  const dateLabel = dateObj.toLocaleDateString(
    lang === "ta" ? "ta-IN" : "en-IN",
    {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    },
  );

  return (
    <div ref={panelRef} id="panchang-detail" className="card card--static panchang-detail">
      <div key={day.date} className="panchang-detail__body">
        <span className="eyebrow">{t("தேர்ந்தெடுத்த நாள்", "Selected day")}</span>
        <h2 className="panchang-detail__title">{dateLabel}</h2>

        <div className="panchang-detail__meta">
          <Badge tone="moon">
            <LuMoon aria-hidden="true" />
            {t("திதி", "Tithi")}: <strong>{t(day.tithi_ta, day.tithi_en)}</strong>
          </Badge>
          <Badge tone="muted">{t(day.weekday_ta, day.weekday_en)}</Badge>
          {day.tamil_month && (
            <Badge tone="gold">
              {t("தமிழ் மாதம்", "Tamil Month")}:{" "}
              <strong>{t(day.tamil_month.ta, day.tamil_month.en)}</strong>
            </Badge>
          )}
        </div>

        {day.special.length > 0 && (
          <div className="panchang-detail__special">
            {day.special.map((s) => (
              <SpecialBadge key={s.type} s={s} t={t} />
            ))}
          </div>
        )}

        <p className="panchang-detail__section">
          <LuClock aria-hidden="true" /> {t("நேரங்கள்", "Timings")}
        </p>
        <dl className="panchang-timings">
          <TimingCard
            label={t("நல்ல நேரம்", "Nalla Neram")}
            times={day.timings.nalla_neram}
            variant="good"
            icon={<LuSparkles aria-hidden="true" />}
          />
          <TimingCard
            label={t("பிரம்ம முகூர்த்தம்", "Brahma Muhurtham")}
            times={day.timings.brahma_muhurtham}
            variant="good"
            icon={<LuSunrise aria-hidden="true" />}
          />
          <TimingCard
            label={t("ராகு காலம்", "Rahu Kalam")}
            times={day.timings.rahu_kalam}
            variant="bad"
            icon={<LuTriangleAlert aria-hidden="true" />}
          />
          <TimingCard
            label={t("யமகண்டம்", "Yamagandam")}
            times={day.timings.yamagandam}
            variant="bad"
            icon={<LuTriangleAlert aria-hidden="true" />}
          />
          <TimingCard
            label={t("குளிகை காலம்", "Gulika Kalam")}
            times={day.timings.gulika_kalam}
            variant="bad"
            icon={<LuTriangleAlert aria-hidden="true" />}
          />
        </dl>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function PanchangCalendar() {
  const { lang, t } = useLang();
  const today = new Date();

  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  // Today's panchangam for the hero card — remembered across month navigation
  const [todayInfo, setTodayInfo] = useState(null);
  // Roving tabindex target inside the day grid
  const [focusDate, setFocusDate] = useState(null);
  const cellRefs = useRef([]);
  const detailRef = useRef(null);

  const fetchMonth = useCallback((y, m) => {
    setLoading(true);
    api
      .get("/calendar", { params: { year: y, month: m } })
      .then((r) => {
        setData(r.data);
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const todayDay =
          r.data.days.find((d) => d.date === todayStr) ?? r.data.days[0];
        setSelected(todayDay ?? null);
      })
      .catch(() => {
        const fb = buildFallback(y, m);
        setData(fb);
        setSelected(fb.today ?? fb.days[0]);
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchMonth(year, month);
  }, [year, month, fetchMonth]);

  // Keep today's card populated even when browsing other months
  useEffect(() => {
    if (data?.today) setTodayInfo(data.today);
  }, [data]);

  function prevMonth() {
    if (month === 1) {
      setYear((y) => y - 1);
      setMonth(12);
    } else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 12) {
      setYear((y) => y + 1);
      setMonth(1);
    } else setMonth((m) => m + 1);
  }

  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const isCurrentMonth =
    year === today.getFullYear() && month === today.getMonth() + 1;
  const todaySelected = isCurrentMonth && selected?.date === todayStr;

  function scrollToDetail() {
    if (!detailRef.current) return;
    if (window.matchMedia?.("(max-width: 1023px)").matches) {
      detailRef.current.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  /** "Today" — jump back to the current month (fetch selects today) or re-select today. */
  function goToday() {
    if (!isCurrentMonth) {
      setYear(today.getFullYear());
      setMonth(today.getMonth() + 1);
    } else {
      const td = data?.days.find((d) => d.date === todayStr);
      if (td) setSelected(td);
    }
    scrollToDetail();
  }

  function selectFromList(day) {
    setSelected(day);
    scrollToDetail();
  }

  // Roving tabindex: arrow keys move focus between day cells
  function onCellKey(e, idx) {
    const days = data?.days ?? [];
    const last = days.length - 1;
    let next = null;
    switch (e.key) {
      case "ArrowRight":
        next = Math.min(idx + 1, last);
        break;
      case "ArrowLeft":
        next = Math.max(idx - 1, 0);
        break;
      case "ArrowDown":
        if (idx + 7 <= last) next = idx + 7;
        break;
      case "ArrowUp":
        if (idx - 7 >= 0) next = idx - 7;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next == null || next === idx) return;
    setFocusDate(days[next].date);
    cellRefs.current[next]?.focus();
  }

  // Build blank cells for the start of month (+ trailing blanks to complete the last row)
  const blanks = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const trailing = (7 - ((blanks + daysInMonth) % 7)) % 7;

  const rovingDate =
    focusDate && data?.days?.some((d) => d.date === focusDate)
      ? focusDate
      : selected?.date ?? data?.days?.[0]?.date;

  const monthLabel =
    lang === "ta"
      ? `${MONTH_TA[month]} ${year}`
      : `${new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long" })} ${year}`;

  const legend = [
    ["pournami", "🌕", t("பௌர்ணமி", "Pournami")],
    ["amavasai", "🌑", t("அமாவாசை", "Amavasai")],
    ["ekadasi", "🍃", t("ஏகாதசி", "Ekadasi")],
    ["sashti", "🪔", t("சஷ்டி", "Sashti")],
    ["pradosham", "🔥", t("பிரதோஷம்", "Pradosham")],
    ["chaturthi", "🐘", t("சதுர்த்தி", "Chaturthi")],
    ["festival", "🎊", t("திருவிழா", "Festival")],
  ];

  cellRefs.current = [];

  return (
    <div className="panchang-page">
      <Helmet>
        <title>
          {t("பஞ்சாங்கம்", "Panchangam")} —{" "}
          {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <PageHero
        variant="panchangam"
        eyebrow={t("பஞ்சாங்கம்", "Panchangam")}
        title={t("பஞ்சாங்க நாட்காட்டி", "Panchangam Calendar")}
        lead={t(
          "அமாவாசை · பௌர்ணமி · ஏகாதசி · நல்ல நேரம் · ராகு காலம்",
          "Amavasai · Pournami · Ekadasi · Good Timings · Rahu Kalam",
        )}
        crumbs={[{ label: t("பஞ்சாங்கம்", "Panchangam") }]}
        aside={
          <TodayCard
            today={todayInfo}
            loading={loading && !todayInfo}
            lang={lang}
            t={t}
            onView={goToday}
          />
        }
      />

      <section className="section section--tight">
        <div className="container">
          {/* Month navigator */}
          <div className="card card--static panchang-nav">
            <div className="panchang-nav__month">
              <Button
                variant="soft"
                iconOnly
                icon={<LuChevronLeft aria-hidden="true" />}
                onClick={prevMonth}
              >
                {t("முந்தைய மாதம்", "Previous month")}
              </Button>
              <h2 className="panchang-nav__label" aria-live="polite">
                <LuCalendarDays aria-hidden="true" />
                <span>{monthLabel}</span>
              </h2>
              <Button
                variant="soft"
                iconOnly
                icon={<LuChevronRight aria-hidden="true" />}
                onClick={nextMonth}
              >
                {t("அடுத்த மாதம்", "Next month")}
              </Button>
            </div>
            <Button
              variant="soft"
              className="panchang-nav__today"
              onClick={goToday}
              disabled={todaySelected}
              icon={<LuMoon aria-hidden="true" />}
            >
              {t("இன்று", "Today")}
            </Button>
          </div>

          {/* Legend */}
          <ul className="panchang-legend" aria-label={t("குறியீடு", "Legend")}>
            {legend.map(([type, icon, label]) => (
              <li key={type} className="panchang-legend__item" data-type={type}>
                <span className="panchang-legend__dot" aria-hidden="true" />
                <span className="panchang-legend__glyph" aria-hidden="true">
                  {icon}
                </span>
                {label}
              </li>
            ))}
          </ul>

          <div className="panchang-layout">
            {/* Calendar grid */}
            <div className="card card--solid card--static panchang-grid">
              <div className="panchang-grid__wdays" aria-hidden="true">
                {(lang === "ta" ? WDAY_SHORT_TA : WDAY_SHORT_EN).map((w, i) => (
                  <div
                    key={w}
                    className={`panchang-grid__wday${i === 0 || i === 6 ? " panchang-grid__wday--weekend" : ""}`}
                  >
                    {w}
                  </div>
                ))}
              </div>

              <div
                className="panchang-grid__cells"
                role="group"
                aria-label={`${monthLabel} — ${t("நாட்காட்டி", "calendar")}`}
                aria-busy={loading || undefined}
              >
                {/* Blank leading cells */}
                {Array.from({ length: blanks }).map((_, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={`blank-${i}`} className="panchang-cell panchang-cell--empty" aria-hidden="true" />
                ))}

                {/* Day cells */}
                {loading
                  ? Array.from({ length: daysInMonth }).map((_, i) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <div
                        key={`loading-${i}`}
                        className="panchang-cell panchang-cell--skeleton skeleton"
                        aria-hidden="true"
                      />
                    ))
                  : data?.days.map((day, idx) => {
                      const isToday = day.date === todayStr;
                      const isSelected = selected?.date === day.date;
                      const isWeekend = day.weekday === 0 || day.weekday === 6;
                      const dayLabel = new Date(day.date + "T00:00:00").toLocaleDateString(
                        localeOf(lang),
                        { weekday: "long", day: "numeric", month: "long" },
                      );
                      const specials = day.special.length
                        ? " — " + day.special.map((s) => t(s.ta, s.en)).join(", ")
                        : "";
                      return (
                        <button
                          key={day.date}
                          ref={(el) => (cellRefs.current[idx] = el)}
                          type="button"
                          className={[
                            "panchang-cell",
                            "rise",
                            isToday && "panchang-cell--today",
                            isSelected && "panchang-cell--selected",
                            isWeekend && "panchang-cell--weekend",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{ "--i": idx }}
                          tabIndex={day.date === rovingDate ? 0 : -1}
                          onClick={() => setSelected(day)}
                          onFocus={() => setFocusDate(day.date)}
                          onKeyDown={(e) => onCellKey(e, idx)}
                          aria-pressed={isSelected}
                          aria-current={isToday ? "date" : undefined}
                          aria-label={`${dayLabel}, ${t(day.tithi_ta, day.tithi_en)}${specials}${isToday ? ` (${t("இன்று", "Today")})` : ""}`}
                        >
                          <span className="panchang-cell__day">{day.day}</span>
                          <span className="panchang-cell__tithi">
                            {lang === "ta" ? day.tithi_ta : day.tithi_en}
                          </span>
                          <span className="panchang-cell__marks" aria-hidden="true">
                            {day.special.map((s) => (
                              <span
                                key={s.type}
                                className="panchang-cell__mark"
                                data-type={s.type}
                                title={s.en}
                              >
                                <span className="panchang-cell__dot" />
                                <span className="panchang-cell__mark-label">{t(s.ta, s.en)}</span>
                              </span>
                            ))}
                          </span>
                        </button>
                      );
                    })}

                {/* Trailing blanks complete the final row */}
                {Array.from({ length: trailing }).map((_, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div key={`trail-${i}`} className="panchang-cell panchang-cell--empty" aria-hidden="true" />
                ))}
              </div>

              <p className="panchang-grid__hint">
                <kbd>←</kbd>
                <kbd>→</kbd>
                <kbd>↑</kbd>
                <kbd>↓</kbd>
                {t("நாட்களுக்கு இடையே நகர; Enter — தேர்ந்தெடுக்க", "move between days · Enter to select")}
              </p>
            </div>

            {/* Day detail */}
            <DayDetail day={selected} lang={lang} t={t} panelRef={detailRef} />
          </div>

          {/* Upcoming special days */}
          <div className="panchang-upcoming">
            <SectionHeader
              align="split"
              eyebrow={monthLabel}
              title={t("வரும் விசேஷ நாட்கள்", "Upcoming Special Days")}
              subtitle={t(
                "தேர்ந்தெடுத்த மாதத்தில் வரும் விசேஷ நாட்கள் — ஒரு நாளை தொட்டு விவரங்களைக் காணலாம்.",
                "Special observances coming up in the selected month — tap a day to see its timings.",
              )}
            />
            {data?.upcoming?.length > 0 ? (
              <div className="card card--static">
                <ul className="panchang-upcoming__list">
                  {data.upcoming.slice(0, 10).map((day, i) => {
                    const dt = new Date(day.date + "T00:00:00");
                    const isSelected = selected?.date === day.date;
                    return (
                      <li key={day.date} className="rise" style={{ "--i": i }}>
                        <button
                          type="button"
                          className="panchang-upcoming__row"
                          onClick={() => selectFromList(day)}
                          aria-pressed={isSelected}
                        >
                          <span className="panchang-upcoming__date" aria-hidden="true">
                            <span className="panchang-upcoming__date-day">{day.day}</span>
                            <span className="panchang-upcoming__date-mon">
                              {dt.toLocaleDateString(localeOf(lang), { month: "short" })}
                            </span>
                          </span>
                          <span className="panchang-upcoming__body">
                            <span className="panchang-upcoming__badges">
                              {day.special.map((s) => (
                                <SpecialBadge key={s.type} s={s} t={t} />
                              ))}
                            </span>
                            <span className="panchang-upcoming__when">
                              {dt.toLocaleDateString(localeOf(lang), {
                                weekday: "long",
                                day: "numeric",
                                month: "short",
                              })}
                            </span>
                          </span>
                          <span className="panchang-upcoming__tithi">
                            <LuMoon aria-hidden="true" />
                            {t(day.tithi_ta, day.tithi_en)}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              !loading && (
                <EmptyState
                  compact
                  icon={<LuCalendarX />}
                  title={t("விசேஷ நாட்கள் இல்லை", "No special days ahead")}
                >
                  {t(
                    "இந்த மாதத்தில் இன்று முதல் விசேஷ நாட்கள் எதுவும் இல்லை. அடுத்த மாதத்தைப் பார்க்கவும்.",
                    "There are no special days remaining in this month. Try the next month.",
                  )}
                </EmptyState>
              )
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
