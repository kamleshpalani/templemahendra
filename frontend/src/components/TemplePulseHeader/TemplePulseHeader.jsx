import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useLang } from "../../context/LangContext";
import "./TemplePulseHeader.css";

/* ── Temple schedule config ──────────────────────────────── */
const POOJA_SCHEDULE = [
  { name: "திருவனந்தல்", nameEn: "Thiruvanandal", h: 6, m: 0 },
  { name: "காலசந்தி", nameEn: "Kalasanthi", h: 8, m: 0 },
  { name: "உச்சிக்கால பூஜை", nameEn: "Uchikala Pooja", h: 12, m: 0 },
  { name: "சாயரட்சை", nameEn: "Sayaratchai", h: 16, m: 30 },
  { name: "இரண்டாம்கால", nameEn: "Irandamkaalai", h: 18, m: 30 },
  { name: "அர்த்த ஜாமம்", nameEn: "Ardha Jamam", h: 20, m: 30 },
];

// Morning: 6:00–12:30 | Evening: 16:00–21:00
const isOpen = (h, m) => {
  const t = h * 60 + m;
  return (t >= 360 && t < 750) || (t >= 960 && t < 1260);
};

/* ── Today's special alankaram (rotates by weekday) ──────── */
const DAILY_SPECIAL = [
  ["ஆதிமூலம் அலங்காரம்", "Spl Alankaram Sunday"],
  ["வெள்ளி அலங்காரம்", "Silver Alankaram Monday"],
  ["பால் அபிஷேகம்", "Milk Abhishekam Tuesday"],
  ["குங்குமார்ச்சனை", "Kumkum Archana Wednesday"],
  ["பன்னீர் அபிஷேகம்", "Rosewater Abhishekam Thursday"],
  ["நவதானிய அர்ப்பணம்", "Navadhanya Offering Friday"],
  ["விளக்கு பூஜை", "Deepa Pooja Saturday"],
];

function fmt2(n) {
  return String(n).padStart(2, "0");
}

function getNextPooja(now) {
  const h = now.getHours(),
    m = now.getMinutes(),
    s = now.getSeconds();
  const nowMins = h * 60 + m;
  const today = POOJA_SCHEDULE.find((p) => p.h * 60 + p.m > nowMins);
  if (today) {
    const diffSec = (today.h * 60 + today.m) * 60 - (h * 3600 + m * 60 + s);
    return { pooja: today, diffSec };
  }
  // First pooja tomorrow
  const first = POOJA_SCHEDULE[0];
  const minsUntilMidnight = (24 * 60 - nowMins) * 60 - s;
  const diffSec = minsUntilMidnight + first.h * 3600 + first.m * 60;
  return { pooja: first, diffSec };
}

function secToHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${fmt2(h)}:${fmt2(m)}:${fmt2(s)}`;
}

export default function TemplePulseHeader() {
  const { t } = useLang();
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(true);
  const [lastScroll, setLastScroll] = useState(0);

  // Re-render every second for countdown
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Hide pulse bar when scrolling down, show on scroll up
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setVisible(y <= lastScroll || y < 80);
      setLastScroll(y);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [lastScroll]);

  const now = new Date();
  const open = isOpen(now.getHours(), now.getMinutes());
  const { pooja, diffSec } = getNextPooja(now);
  const weekday = now.getDay(); // 0=Sun
  const [special, specialEn] = DAILY_SPECIAL[weekday];

  return (
    <div
      className={`pulse-bar${visible ? "" : " pulse-bar--hidden"}`}
      role="status"
      aria-label="Temple status"
    >
      <div className="pulse-bar__inner">
        {/* Status pill */}
        <span
          className={`pulse-pill ${open ? "pulse-pill--open" : "pulse-pill--closed"}`}
        >
          <span className="pulse-pill__dot" />
          {open
            ? t("கோயில் திறந்தது", "Temple Open")
            : t("கோயில் மூடியது", "Temple Closed")}
        </span>

        <span className="pulse-bar__sep">·</span>

        {/* Next pooja countdown */}
        <span className="pulse-bar__item">
          <span className="pulse-bar__label">
            {t("அடுத்த பூஜை", "Next Pooja")}
          </span>
          <span className="pulse-bar__value">
            {t(pooja.name, pooja.nameEn)}
            <span className="pulse-countdown"> {secToHMS(diffSec)}</span>
          </span>
        </span>

        <span className="pulse-bar__sep pulse-bar__sep--hide-sm">·</span>

        {/* Today's special */}
        <span className="pulse-bar__item pulse-bar__item--special">
          <span className="pulse-bar__label">
            {t("இன்றைய சிறப்பு", "Today")}
          </span>
          <span className="pulse-bar__value">{t(special, specialEn)}</span>
        </span>

        {/* CTA */}
        <Link to="/sevas" className="pulse-bar__cta">
          {t("சேவை பதிவு →", "Book Seva →")}
        </Link>
      </div>
    </div>
  );
}
