import { useEffect, useState } from "react";
import { LuClock, LuSparkles } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { DAILY_SPECIAL, getISTNow, getNextPooja, isTempleOpen, secToHMS } from "../../lib/templeTime";
import "./TemplePulseHeader.css";

/**
 * TemplePulseHeader — slim live status strip that sits above the floating
 * navbar and scrolls away with the page (the navbar keeps a compact live
 * pill once this is out of view). Ticks once a second for the countdown.
 */
export default function TemplePulseHeader() {
  const { t } = useLang();
  const [now, setNow] = useState(getISTNow);

  useEffect(() => {
    const id = setInterval(() => setNow(getISTNow()), 1000);
    return () => clearInterval(id);
  }, []);

  const open = isTempleOpen(now);
  const { pooja, diffSec } = getNextPooja(now);
  const special = DAILY_SPECIAL[now.getDay()];

  return (
    <div className="pulse-strip" role="status" aria-label={t("கோயில் நிலை", "Temple status")}>
      <div className="container pulse-strip__inner">
        <span className={`pulse-pill ${open ? "pulse-pill--open" : "pulse-pill--closed"}`}>
          <span className="pulse-pill__dot" aria-hidden="true" />
          {open ? t("கோயில் திறந்துள்ளது", "Temple Open") : t("கோயில் மூடியுள்ளது", "Temple Closed")}
        </span>

        <span className="pulse-strip__item">
          <LuClock aria-hidden="true" />
          <span className="pulse-strip__label">{t("அடுத்த பூஜை", "Next Pooja")}</span>
          <span className="pulse-strip__value">
            {t(pooja.ta, pooja.en)}
            <time className="pulse-countdown" dateTime={`PT${diffSec}S`}>
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
      </div>
    </div>
  );
}
