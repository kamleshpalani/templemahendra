import { NavLink } from "react-router-dom";
import { LuFlame, LuHeartHandshake, LuHouse, LuMapPin, LuMoon } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import "./BottomNav.css";

const tabs = [
  { to: "/", Icon: LuHouse, ta: "முகப்பு", en: "Home" },
  { to: "/sevas", Icon: LuFlame, ta: "சேவைகள்", en: "Sevas" },
  { to: "/panchangam", Icon: LuMoon, ta: "பஞ்சாங்கம்", en: "Panchangam" },
  { to: "/donations", Icon: LuHeartHandshake, ta: "நன்கொடை", en: "Donate" },
  { to: "/contact", Icon: LuMapPin, ta: "தொடர்பு", en: "Contact" },
];

/** Mobile-only floating glass tab bar (hidden ≥ 769px via CSS). */
export default function BottomNav() {
  const { t } = useLang();
  return (
    <nav className="bottom-nav" aria-label={t("கீழ் வழிசெலுத்தல்", "Bottom navigation")}>
      {tabs.map(({ to, Icon, ta, en }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) => "bottom-nav__item" + (isActive ? " bottom-nav__item--active" : "")}
        >
          <span className="bottom-nav__icon" aria-hidden="true">
            <Icon />
          </span>
          <span className="bottom-nav__label">{t(ta, en)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
