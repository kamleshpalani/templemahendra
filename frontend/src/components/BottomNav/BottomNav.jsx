import { NavLink } from "react-router-dom";
import {
  FaHome,
  FaHandsHelping,
  FaCalendarAlt,
  FaHeart,
  FaPhoneAlt,
} from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import "./BottomNav.css";

const tabs = [
  { to: "/", Icon: FaHome, ta: "முகப்பு", en: "Home" },
  { to: "/sevas", Icon: FaHandsHelping, ta: "சேவைகள்", en: "Sevas" },
  { to: "/events", Icon: FaCalendarAlt, ta: "நிகழ்வுகள்", en: "Events" },
  { to: "/donations", Icon: FaHeart, ta: "நன்கொடை", en: "Donate" },
  { to: "/contact", Icon: FaPhoneAlt, ta: "தொடர்பு", en: "Contact" },
];

export default function BottomNav() {
  const { t } = useLang();

  return (
    <nav
      className="bottom-nav"
      aria-label={t("கீழ் வழிசெலுத்தல்", "Bottom navigation")}
    >
      {tabs.map(({ to, Icon, ta, en }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            "bottom-nav__item" + (isActive ? " bottom-nav__item--active" : "")
          }
        >
          <Icon className="bottom-nav__icon" aria-hidden="true" />
          <span className="bottom-nav__label">{t(ta, en)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
