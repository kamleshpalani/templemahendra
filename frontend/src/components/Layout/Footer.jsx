import { NavLink } from "react-router-dom";
import { FaPhone, FaEnvelope, FaMapMarkerAlt } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import {
  TEMPLE,
  ADDRESS,
  TRUST,
  PRIMARY_CONTACT,
  SECONDARY_CONTACT,
  formatPhone,
  telHref,
} from "../../data/temple";
import "./Footer.css";

export default function Footer() {
  const { t } = useLang();

  const quickLinks = [
    { to: "/about#history", ta: "கோவில் வரலாறு", en: "History" },
    { to: "/about#trust", ta: "தர்ம அறக்கட்டளை", en: "Dharma Trust" },
    { to: "/about#committee", ta: "திருக்கோவில் கமிட்டி", en: "Committee" },
    { to: "/sevas", ta: "சேவைகள் & பூஜைகள்", en: "Sevas & Poojas" },
    { to: "/events", ta: "நிகழ்வுகள் & திருவிழா", en: "Events & Festivals" },
    { to: "/donations", ta: "நன்கொடை", en: "Donate" },
    { to: "/contact", ta: "தொடர்பு கொள்ளுங்கள்", en: "Contact Us" },
  ];

  const contacts = [PRIMARY_CONTACT, SECONDARY_CONTACT];

  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__col">
          <h3 className="footer__title">{t(TEMPLE.name.ta, TEMPLE.name.en)}</h3>
          <p className="footer__desc">
            {t(TEMPLE.descriptor.ta, TEMPLE.descriptor.en)}
          </p>
          <p className="footer__desc footer__invocation">
            <em>{t(TEMPLE.invocation.ta, TEMPLE.invocation.en)}</em>
          </p>
          <p className="footer__trust">
            <NavLink to="/about#trust">
              {t(
                `தர்ம அறக்கட்டளை பதிவு எண் ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · PAN ${TRUST.bank.pan} · ${TRUST.taxExemption.short.ta}`,
                `Dharma Trust Reg. No. ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · PAN ${TRUST.bank.pan} · ${TRUST.taxExemption.short.en}`,
              )}
            </NavLink>
          </p>
        </div>

        <div className="footer__col">
          <h4 className="footer__heading">{t("இணைப்புகள்", "Quick Links")}</h4>
          <ul className="footer__links">
            {quickLinks.map(({ to, ta, en }) => (
              <li key={to}>
                <NavLink to={to}>{t(ta, en)}</NavLink>
              </li>
            ))}
          </ul>
        </div>

        <div className="footer__col">
          <h4 className="footer__heading">{t("தொடர்பு", "Contact")}</h4>
          <ul className="footer__contact">
            <li>
              <FaMapMarkerAlt aria-hidden="true" />{" "}
              <address className="footer__address">
                {t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en)}
              </address>
            </li>
            {contacts.map((c) => (
              <li key={c.phone}>
                <FaPhone aria-hidden="true" />{" "}
                <span>
                  <a
                    href={telHref(c.phone)}
                    aria-label={`${t(c.name.ta, c.name.en)}, ${t(c.role.ta, c.role.en)}`}
                  >
                    {formatPhone(c.phone)}
                  </a>{" "}
                  <span className="footer__contact-role">
                    ({t(c.role.ta, c.role.en)} – {t(c.name.ta, c.name.en)})
                  </span>
                </span>
              </li>
            ))}
            <li>
              <FaEnvelope aria-hidden="true" />{" "}
              <a href="mailto:info@dhabbalavaartemple.in">
                info@dhabbalavaartemple.in
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="footer__bottom">
        <p>
          © {new Date().getFullYear()}{" "}
          {t(
            `${TRUST.name.ta} (பதிவு எண் ${TRUST.bank.regNo}). அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை.`,
            `${TRUST.name.en} (Reg. No. ${TRUST.bank.regNo}). All rights reserved.`,
          )}
        </p>
      </div>
    </footer>
  );
}
