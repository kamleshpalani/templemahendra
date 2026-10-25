import { useEffect, useState } from "react";
import { LuLanguages, LuPhone } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { getISTNow, isTempleOpen } from "../../lib/templeTime";
import { TEMPLE_PHONE } from "../../data/temple";
import "./TemplePulseHeader.css";

/**
 * TemplePulseHeader — slim live status strip above the navbar, carrying the
 * temple's open/closed state and language toggle. Refreshes every 30 seconds.
 *
 * The daily hours are not repeated here: the footer, the Contact page and the
 * visit information already gives them, and the open/closed pill says
 * what a visitor needs in the moment.
 *
 * The language toggle lives here rather than in the navbar: it is a
 * once-per-visit choice, and the navbar's row is already at its width budget
 * with the brand, seven Tamil nav labels, call, search and Register family.
 * It is the site's one language switch on wide screens (the mobile drawer
 * carries the other), so it is not repeated in the footer.
 *
 * The labelled region is deliberately not live, avoiding repeated announcements.
 */
export default function TemplePulseHeader() {
  const { lang, setLang, t } = useLang();
  const [now, setNow] = useState(getISTNow);

  useEffect(() => {
    const id = setInterval(() => setNow(getISTNow()), 30000);
    return () => clearInterval(id);
  }, []);

  const open = isTempleOpen(now);

  return (
    <section className="pulse-strip" aria-label={t("கோயில் நிலை", "Temple status")}>
      <div className="pulse-strip__inner">
        <span className={`pulse-pill ${open ? "pulse-pill--open" : "pulse-pill--closed"}`}>
          <span className="pulse-pill__dot" aria-hidden="true" />
          {open ? t("கோயில் திறந்துள்ளது", "Temple Open") : t("கோயில் மூடியுள்ளது", "Temple Closed")}
        </span>

        <a className="pulse-strip__phone" href={TEMPLE_PHONE.href}
          aria-label={`${t("கோயிலை அழைக்கவும்", "Call the temple")} — ${TEMPLE_PHONE.display}`}>
          <LuPhone aria-hidden="true" />
          {TEMPLE_PHONE.display}
        </a>

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
