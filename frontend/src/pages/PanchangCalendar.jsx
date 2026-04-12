import { useEffect, useState, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { FaChevronLeft, FaChevronRight } from "react-icons/fa";
import api from "../services/api";
import { useLang } from "../context/LangContext";
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
const NALLA = [
  [
    ["07:30", "09:00"],
    ["22:30", "24:00"],
  ],
  [
    ["06:00", "07:30"],
    ["15:00", "16:30"],
  ],
  [
    ["07:30", "09:00"],
    ["22:30", "24:00"],
  ],
  [
    ["07:30", "09:00"],
    ["12:00", "13:30"],
  ],
  [
    ["10:30", "12:00"],
    ["19:30", "21:00"],
  ],
  [
    ["10:30", "12:00"],
    ["16:30", "18:00"],
  ],
  [
    ["06:00", "07:30"],
    ["19:30", "21:00"],
  ],
];
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

// ── Sub-components ─────────────────────────────────────────────────────────────

function TimingCard({ label, times, variant }) {
  const timeStr = Array.isArray(times[0])
    ? times.map((t) => `${t[0]}–${t[1]}`).join(", ")
    : `${times[0]}–${times[1]}`;
  return (
    <div className={`timing-card timing-card--${variant}`}>
      <span className="timing-card__label">{label}</span>
      <span className="timing-card__time">{timeStr}</span>
    </div>
  );
}

function DayDetail({ day, lang, t }) {
  if (!day) return null;
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
    <div className="panchang__detail">
      <div className="panchang__detail-title">{dateLabel}</div>
      <div className="panchang__detail-tithi">
        {t("திதி", "Tithi")}: <strong>{t(day.tithi_ta, day.tithi_en)}</strong>
        {" · "}
        {t(day.weekday_ta, day.weekday_en)}
        {day.tamil_month && (
          <>
            {" "}
            · {t("தமிழ் மாதம்", "Tamil Month")}:{" "}
            <strong>{t(day.tamil_month.ta, day.tamil_month.en)}</strong>
          </>
        )}
      </div>

      {day.special.length > 0 && (
        <div className="panchang__detail-badges">
          {day.special.map((s) => (
            <span
              key={s.type}
              className={`panchang__badge panchang__badge--${s.type}`}
            >
              {TYPE_ICONS[s.type] ?? "✦"} {t(s.ta, s.en)}
            </span>
          ))}
        </div>
      )}

      <div className="panchang__timings">
        <TimingCard
          label={t("நல்ல நேரம்", "Nalla Neram")}
          times={day.timings.nalla_neram}
          variant="good"
        />
        <TimingCard
          label={t("பிரம்ம முகூர்த்தம்", "Brahma Muhurtham")}
          times={day.timings.brahma_muhurtham}
          variant="good"
        />
        <TimingCard
          label={t("ராகு காலம்", "Rahu Kalam")}
          times={day.timings.rahu_kalam}
          variant="bad"
        />
        <TimingCard
          label={t("யமகண்டம்", "Yamagandam")}
          times={day.timings.yamagandam}
          variant="bad"
        />
        <TimingCard
          label={t("குளிகை காலம்", "Gulika Kalam")}
          times={day.timings.gulika_kalam}
          variant="bad"
        />
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

  // Build blank cells for the start of month
  const blanks = data ? new Date(year, month - 1, 1).getDay() : 0;
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <>
      <Helmet>
        <title>
          {t("பஞ்சாங்கம்", "Panchangam")} —{" "}
          {t(
            "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
            "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
          )}
        </title>
      </Helmet>

      <main className="panchang">
        <h1 className="panchang__title">
          {t("பஞ்சாங்க நாட்காட்டி", "Panchangam Calendar")}
        </h1>
        <p className="panchang__subtitle">
          {t(
            "அமாவாசை · பௌர்ணமி · ஏகாதசி · நல்ல நேரம் · ராகு காலம்",
            "Amavasai · Pournami · Ekadasi · Good Timings · Rahu Kalam",
          )}
        </p>

        {/* Month navigator */}
        <div className="panchang__nav">
          <button
            className="panchang__nav-btn"
            onClick={prevMonth}
            aria-label="Previous month"
          >
            <FaChevronLeft />
          </button>
          <span className="panchang__nav-label">
            {lang === "ta"
              ? `${MONTH_TA[month]} ${year}`
              : `${new Date(year, month - 1, 1).toLocaleString("en-IN", { month: "long" })} ${year}`}
          </span>
          <button
            className="panchang__nav-btn"
            onClick={nextMonth}
            aria-label="Next month"
          >
            <FaChevronRight />
          </button>
        </div>

        {/* Legend */}
        <div className="panchang__legend">
          {[
            ["pournami", "🌕", t("பௌர்ணமி", "Pournami")],
            ["amavasai", "🌑", t("அமாவாசை", "Amavasai")],
            ["ekadasi", "🍃", t("ஏகாதசி", "Ekadasi")],
            ["sashti", "🪔", t("சஷ்டி", "Sashti")],
            ["pradosham", "🔥", t("பிரதோஷம்", "Pradosham")],
            ["festival", "🎊", t("திருவிழா", "Festival")],
          ].map(([type, icon, label]) => (
            <span key={type} className="legend-item">
              <span className={`legend-dot legend-dot--${type}`} />
              {icon} {label}
            </span>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="panchang__grid">
          <div className="panchang__wdays">
            {(lang === "ta" ? WDAY_SHORT_TA : WDAY_SHORT_EN).map((w, i) => (
              <div
                key={w}
                className={`panchang__wday${i === 0 || i === 6 ? " panchang__wday--sun" : ""}`}
              >
                {w}
              </div>
            ))}
          </div>

          <div className="panchang__cells">
            {/* Blank leading cells */}
            {Array.from({ length: blanks }).map((_, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div
                key={`blank-${i}`}
                className="panchang__cell panchang__cell--empty"
              />
            ))}

            {/* Day cells */}
            {loading
              ? Array.from({ length: 31 }).map((_, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <div
                    key={`loading-${i}`}
                    className="panchang__cell panchang__cell--empty"
                  />
                ))
              : data?.days.map((day) => {
                  const isToday = day.date === todayStr;
                  const isSelected = selected?.date === day.date;
                  const isWeekend = day.weekday === 0 || day.weekday === 6;
                  return (
                    <button
                      key={day.date}
                      type="button"
                      className={[
                        "panchang__cell",
                        isToday && "panchang__cell--today",
                        isSelected && "panchang__cell--selected",
                        isWeekend && "panchang__cell--weekend",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => setSelected(day)}
                      aria-label={`${day.date}${day.special.length ? " — " + day.special.map((s) => s.en).join(", ") : ""}`}
                    >
                      <div className="panchang__cell-day">{day.day}</div>
                      <div className="panchang__cell-tithi">
                        {lang === "ta" ? day.tithi_ta : day.tithi_en}
                      </div>
                      <div className="panchang__cell-dots">
                        {day.special.map((s) => (
                          <span
                            key={s.type}
                            className={`panchang__dot panchang__dot--${s.type}`}
                            title={s.en}
                          />
                        ))}
                      </div>
                    </button>
                  );
                })}
          </div>
        </div>

        {/* Day detail */}
        <DayDetail day={selected} lang={lang} t={t} />

        {/* Upcoming special days */}
        {data?.upcoming?.length > 0 && (
          <section className="panchang__upcoming">
            <h2 className="panchang__upcoming-title">
              {t("வரும் விசேஷ நாட்கள்", "Upcoming Special Days")}
            </h2>
            <div className="upcoming-list">
              {data.upcoming.slice(0, 10).map((day) => (
                <button
                  key={day.date}
                  type="button"
                  className="upcoming-item"
                  onClick={() => setSelected(day)}
                >
                  <span className="upcoming-item__date">
                    {new Date(day.date + "T00:00:00").toLocaleDateString(
                      lang === "ta" ? "ta-IN" : "en-IN",
                      { day: "numeric", month: "short" },
                    )}
                  </span>
                  <div className="upcoming-item__special">
                    {day.special.map((s) => (
                      <span
                        key={s.type}
                        className={`panchang__badge panchang__badge--${s.type}`}
                      >
                        {TYPE_ICONS[s.type] ?? "✦"} {t(s.ta, s.en)}
                      </span>
                    ))}
                  </div>
                  <span className="upcoming-item__tithi">
                    {t(day.tithi_ta, day.tithi_en)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  );
}
