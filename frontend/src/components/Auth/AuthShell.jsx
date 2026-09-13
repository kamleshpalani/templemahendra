import { useId } from "react";
import { Link } from "react-router-dom";
import { LuHeartHandshake, LuReceipt, LuSparkles } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import Seo from "../Seo";
import { TEMPLE } from "../../data/temple";
import "./AuthShell.css";

/**
 * AuthShell — the frame every account page shares: a dark-glass welcome panel
 * on the left and the form card on the right, stacking to one column on phones.
 *
 *   <AuthShell eyebrow="Sign in" title="Welcome back" lead="…" foot={<…/>}>
 *     <form>…</form>
 *   </AuthShell>
 */
export default function AuthShell({ eyebrow, title, lead, children, foot, docTitle, wide = false }) {
  const { t } = useLang();
  const titleId = useId();

  const reasons = [
    {
      Icon: LuSparkles,
      ta: "சேவை பதிவு வேகமாக — பெயரும் எண்ணும் தானாக நிரம்பும்",
      en: "Book a seva in a couple of taps, with your details already filled in",
    },
    {
      Icon: LuReceipt,
      ta: "உங்கள் பதிவுகளும் நன்கொடைகளும் ஒரே இடத்தில்",
      en: "Every booking and offering you have made, in one place",
    },
    {
      Icon: LuHeartHandshake,
      ta: "பௌர்ணமி பூஜை, திருவிழா அறிவிப்புகள் மின்னஞ்சலில்",
      en: "Pournami pooja and festival notices by email",
    },
  ];

  return (
    <>
      {/* Account pages are per-person; keep them out of search results. */}
      <Seo title={docTitle ?? title} robots="noindex, nofollow" />

      <div className={`authx${wide ? " authx--wide" : ""}`}>
        <div className="authx__grid">
          <aside className="authx__panel" aria-labelledby="authx-panel-title">
            <Link to="/" className="authx__brand">
              <img src="/logo.svg" alt="" width="48" height="48" />
              <span>
                <strong>{t(TEMPLE.brand.line1.ta, TEMPLE.brand.line1.en)}</strong>
                <small>{t(TEMPLE.brand.line2.ta, TEMPLE.brand.line2.en)}</small>
              </span>
            </Link>

            <h2 id="authx-panel-title" className="authx__panel-title">
              {t("உங்கள் கோயில் கணக்கு", "Your temple account")}
            </h2>
            <ul className="authx__reasons" role="list">
              {reasons.map(({ Icon, ta, en }, i) => (
                <li key={en} style={{ "--i": i }}>
                  <span className="authx__reason-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <span>{t(ta, en)}</span>
                </li>
              ))}
            </ul>

            <p className="authx__note">
              {t(
                "கணக்கு இல்லாமலும் சேவை பதிவு செய்யலாம் — கணக்கு வரலாற்றை மட்டும் சேர்க்கிறது.",
                "You can still book without an account. An account only adds your history.",
              )}
            </p>
          </aside>

          {/* A section, not a main: Layout already provides the page's single
              main landmark, and a second one makes both ambiguous. */}
          <section className="authx__card card card--solid card--static" aria-labelledby={`authx-title-${titleId}`}>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h1 id={`authx-title-${titleId}`} className="authx__title">
              {title}
            </h1>
            {lead && <p className="authx__lead">{lead}</p>}
            {children}
            {foot && <div className="authx__foot">{foot}</div>}
          </section>
        </div>
      </div>
    </>
  );
}
