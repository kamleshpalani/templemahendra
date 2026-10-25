import { NavLink } from "react-router-dom";
import { LuArrowUp, LuClock, LuMail, LuMapPin, LuPhone, LuShieldCheck } from "react-icons/lu";
import { FaWhatsapp } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import {
  TEMPLE,
  ADDRESS,
  TRUST,
  TEMPLE_PHONE,
  TEMPLE_EMAIL,
  MAPS_URL,
} from "../../data/temple";
import "./Footer.css";

/*
 * The four policy pages a payment gateway requires to be reachable from every
 * page (docs/payments/SPEC.md §7.8). Paths and titles match data/policies.js;
 * they are repeated here rather than imported so the footer, which is on every
 * page, does not pull the full policy texts into the main bundle.
 */
const LEGAL_LINKS = [
  { to: "/privacy-policy", ta: "தனியுரிமைக் கொள்கை", en: "Privacy Policy" },
  { to: "/terms-and-conditions", ta: "விதிமுறைகள் & நிபந்தனைகள்", en: "Terms & Conditions" },
  { to: "/refund-cancellation-policy", ta: "பணம் திருப்பி அளித்தல் & ரத்து", en: "Refund & Cancellation" },
  { to: "/shipping-delivery-policy", ta: "அனுப்புதல் & விநியோகம்", en: "Shipping & Delivery" },
];

export default function Footer() {
  // No language switch here: the status strip at the top of every page (and the
  // mobile drawer) carries it, and a second copy was repetition, not reach.
  const { t } = useLang();

  const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__col footer__col--brand">
          <div className="footer__brand">
            <span className="footer__logo-ring" aria-hidden="true">
              <img src="/logo.svg" alt="" width="44" height="44" />
            </span>
            <h2 className="footer__title">{t(TEMPLE.name.ta, `${TEMPLE.brand.line1.en} ${TEMPLE.brand.line2.en}`)}</h2>
          </div>
          <NavLink to="/trust-committee#trust" className="footer__trust">
            <LuShieldCheck aria-hidden="true" />
            <span>
              {t(
                `தர்ம அறக்கட்டளை பதிவு எண் ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · பான் ${TRUST.bank.pan} · ${TRUST.taxExemption.short.ta}`,
                `Dharma Trust Reg. No. ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · PAN ${TRUST.bank.pan} · ${TRUST.taxExemption.short.en}`,
              )}
            </span>
          </NavLink>
        </div>

        <div className="footer__col">
          <h3 className="footer__heading">{t("முகவரி", "Address")}</h3>
          <ul className="footer__contact" role="list">
            <li>
              <LuMapPin aria-hidden="true" />
              <address className="footer__address">
                {t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en)}
                <a href={MAPS_URL} target="_blank" rel="noopener noreferrer" className="footer__map">
                  {t("வழி அறிய ↗", "Get directions ↗")}
                </a>
              </address>
            </li>
            <li>
              <LuClock aria-hidden="true" />
              <span>
                {t("காலை 6:00 – மதியம் 12:30", "6:00 AM – 12:30 PM")}
                <br />
                {t("மாலை 4:00 – இரவு 9:00", "4:00 PM – 9:00 PM")}
              </span>
            </li>
          </ul>
        </div>

        <div className="footer__col">
          <h3 className="footer__heading">{t("தொடர்பு", "Contact")}</h3>
          <ul className="footer__contact" role="list">
              <li>
                <LuPhone aria-hidden="true" />
                <span>
                  <a
                    href={TEMPLE_PHONE.href}
                    aria-label={`${t("கோயில் அலுவலகம்", "Temple Office")} — ${TEMPLE_PHONE.display}`}
                  >
                    {TEMPLE_PHONE.display}
                  </a>
                  <span className="footer__contact-role">
                    {t("கோயில் அலுவலகம்", "Temple Office")}
                  </span>
                </span>
              </li>
            <li>
              <FaWhatsapp aria-hidden="true" />
              <a href={`https://wa.me/91${TEMPLE_PHONE.digits}`} target="_blank" rel="noopener noreferrer">
                {t("வாட்ஸ்அப்பில் பேசுங்கள்", "Chat on WhatsApp")}
              </a>
            </li>
            <li>
              <LuMail aria-hidden="true" />
              <a href={`mailto:${TEMPLE_EMAIL}`}>{TEMPLE_EMAIL}</a>
            </li>
          </ul>
        </div>
      </div>

      <div className="footer__bottom">
        <div className="container footer__bottom-inner">
          <nav className="footer__legal" aria-label={t("கொள்கைகள்", "Policies")}>
            <ul className="footer__legal-list" role="list">
              {LEGAL_LINKS.map(({ to, ta, en }) => (
                <li key={to}>
                  <NavLink to={to}>{t(ta, en)}</NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <p>
            © {new Date().getFullYear()}{" "}
            {t(
              `${TRUST.name.ta} (பதிவு எண் ${TRUST.bank.regNo}). அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை.`,
              `${TRUST.name.en} (Reg. No. ${TRUST.bank.regNo}). All rights reserved.`,
            )}
          </p>
          <div className="footer__bottom-actions">
            <button type="button" className="footer__top" onClick={scrollTop} aria-label={t("மேலே செல்", "Back to top")}>
              <LuArrowUp aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
