import { useEffect, useState } from "react";
import { LuClock, LuLanguages, LuSparkles } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { DAILY_SPECIAL, getISTNow, getNextPooja, isTempleOpen, secToHMS } from "../../lib/templeTime";
import "./TemplePulseHeader.css";

/**
 * TemplePulseHeader — slim live status strip above the navbar, carrying the
 * temple's open/closed state, the next pooja with a countdown, today's special,
 * the daily hours, and the language toggle. Ticks once a second.
 *
 * The language toggle lives here rather than in the navbar: it is a
 * once-per-visit choice, and the navbar's row is already at its width budget
 * with the brand, seven Tamil nav labels, search, Login and Sign Up.
 *
 * Accessibility note. This used to be one `role="status"` region wrapping the
 * whole strip, which made it a polite live region containing a countdown that
 * changes every second — a screen reader would announce it endlessly. The strip
 * is now a labelled region that is not live, and the ticking numerals are
 * hidden from the accessibility tree; the pooja's name and time still read.
 */
export default function TemplePulseHeader() {
  const { lang, setLang, t } = useLang();
  const [now, setNow] = useState(getISTNow);

  useEffect(() => {
    const id = setInterval(() => setNow(getISTNow()), 1000);
    return () => clearInterval(id);
  }, []);

  const open = isTempleOpen(now);
  const { pooja, diffSec } = getNextPooja(now);
  const special = DAILY_SPECIAL[now.getDay()];

  return (
    <section className="pulse-strip" aria-label={t("கோயில் நிலை", "Temple status")}>
      <div className="pulse-strip__inner">
        <span className={`pulse-pill ${open ? "pulse-pill--open" : "pulse-pill--closed"}`}>
          <span className="pulse-pill__dot" aria-hidden="true" />
          {open ? t("கோயில் திறந்துள்ளது", "Temple Open") : t("கோயில் மூடியுள்ளது", "Temple Closed")}
        </span>

        <span className="pulse-strip__item">
          <LuClock aria-hidden="true" />
          <span className="pulse-strip__label">{t("அடுத்த பூஜை", "Next Pooja")}</span>
          <span className="pulse-strip__value">
            {/* The name is its own element so it can ellipsis on a narrow phone
                while the countdown, which is the glanceable part, stays whole. */}
            <span className="pulse-strip__name">{t(pooja.ta, pooja.en)}</span>
            <time className="pulse-countdown" dateTime={`PT${diffSec}S`} aria-hidden="true">
              {secToHMS(diffSec)}
            </time>
          </span>
        </span>

        <span className="pulse-strip__item pulse-strip__item--special">
          <LuSparkles aria-hidden="true" />
          <span className="pulse-strip__label">{t("இன்றைய சிறப்பு", "Today")}</span>
          <span className="pulse-strip__value">{t(special.ta, special.en)}</span>
        </span>

        <span className="pulse-strip__hours">
          {t("காலை 6:00 – 12:30 · மாலை 4:00 – 9:00", "6:00 AM – 12:30 PM · 4:00 PM – 9:00 PM")}
        </span>

        <div className="lang-toggle" role="group" aria-label={t("மொழி", "Language")}>
          <LuLanguages className="lang-toggle__icon" aria-hidden="true" />
          <button
            type="button"
            className={`lang-toggle__btn${lang === "ta" ? " lang-toggle__btn--active" : ""}`}
            onClick={() => setLang("ta")}
            aria-pressed={lang === "ta"}
            lang="ta"
          >
            தமிழ்
          </button>
          <button
            type="button"
            className={`lang-toggle__btn${lang === "en" ? " lang-toggle__btn--active" : ""}`}
            onClick={() => setLang("en")}
            aria-pressed={lang === "en"}
            lang="en"
          >
            EN
          </button>
        </div>
      </div>
    </section>
  );
}
