import { NavLink } from "react-router-dom";
import { FaPhone, FaEnvelope, FaMapMarkerAlt } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import "./Footer.css";

export default function Footer() {
  const { t } = useLang();

  const quickLinks = [
    { to: "/sevas", ta: "சேவைகள் & பூஜைகள்", en: "Sevas & Poojas" },
    { to: "/events", ta: "நிகழ்வுகள் & திருவிழா", en: "Events & Festivals" },
    { to: "/gallery", ta: "தொகுப்பு", en: "Gallery" },
    { to: "/donations", ta: "நன்கொடை", en: "Donate" },
    { to: "/contact", ta: "தொடர்பு கொள்ளுங்கள்", en: "Contact Us" },
  ];

  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__col">
          <h3 className="footer__title">
            {t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}
          </h3>
          <p className="footer__desc">
            {t(
              "பக்தி, பாரம்பரியம் மற்றும் சமூக சேவையின் புனிதத் தலம்.",
              "A sacred place of worship, peace, and community service.",
            )}
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
              <FaMapMarkerAlt />{" "}
              <span>
                {t(
                  "கோயில் தெரு, நகரம், தமிழ்நாடு",
                  "Temple Street, City, Tamil Nadu",
                )}
              </span>
            </li>
            <li>
              <FaPhone /> <a href="tel:+910000000000">+91 00000 00000</a>
            </li>
            <li>
              <FaEnvelope />{" "}
              <a href="mailto:info@templemahendra.in">info@templemahendra.in</a>
            </li>
          </ul>
        </div>
      </div>

      <div className="footer__bottom">
        <p>
          © {new Date().getFullYear()}{" "}
          {t(
            "ஸ்ரீ மகேந்திர ஆலயம். அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை.",
            "Sri Mahendra Temple. All rights reserved.",
          )}
        </p>
      </div>
    </footer>
  );
}
