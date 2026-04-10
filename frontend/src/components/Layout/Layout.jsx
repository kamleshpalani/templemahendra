import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { FaBars, FaTimes } from "react-icons/fa";
import Footer from "./Footer";
import FloatingActions from "../FloatingActions/FloatingActions";
import BottomNav from "../BottomNav/BottomNav";
import Chatbot from "../Chatbot/Chatbot";
import { useLang } from "../../context/LangContext";
import TemplePulseHeader from "../TemplePulseHeader/TemplePulseHeader";
import "./Layout.css";

const navLinks = [
  { to: "/", label: "முகப்பு", labelEn: "Home" },
  { to: "/about", label: "பற்றி", labelEn: "About" },
  { to: "/sevas", label: "சேவைகள்", labelEn: "Sevas" },
  { to: "/events", label: "நிகழ்வுகள்", labelEn: "Events" },
  { to: "/gallery", label: "தொகுப்பு", labelEn: "Gallery" },
  { to: "/donations", label: "நன்கொடை", labelEn: "Donate" },
  { to: "/contact", label: "தொடர்பு", labelEn: "Contact" },
];

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { lang, setLang, t } = useLang();

  return (
    <>
      <TemplePulseHeader />
      <header className="navbar">
        <div className="container navbar__inner">
          <NavLink to="/" className="navbar__brand">
            <span className="navbar__brand-main">
              {t(
                "தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில்",
                "Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple",
              )}
            </span>
          </NavLink>

          <nav className={`navbar__nav ${menuOpen ? "navbar__nav--open" : ""}`}>
            {navLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === "/"}
                className={({ isActive }) =>
                  "navbar__link" + (isActive ? " navbar__link--active" : "")
                }
                onClick={() => setMenuOpen(false)}
              >
                {t(link.label, link.labelEn)}
              </NavLink>
            ))}
          </nav>

          <div className="navbar__right">
            {/* Language toggle */}
            <div
              className="lang-toggle"
              role="group"
              aria-label="Select language"
            >
              <button
                className={`lang-toggle__btn${lang === "ta" ? " lang-toggle__btn--active" : ""}`}
                onClick={() => setLang("ta")}
                aria-pressed={lang === "ta"}
              >
                தமிழ்
              </button>
              <button
                className={`lang-toggle__btn${lang === "en" ? " lang-toggle__btn--active" : ""}`}
                onClick={() => setLang("en")}
                aria-pressed={lang === "en"}
              >
                EN
              </button>
            </div>

            {/* Mobile hamburger */}
            <button
              className="navbar__toggle"
              aria-label="Toggle menu"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <FaTimes /> : <FaBars />}
            </button>
          </div>
        </div>
      </header>

      <main>
        <Outlet />
      </main>

      <Footer />

      {/* Floating WhatsApp + Phone */}
      <FloatingActions />

      {/* AI Chatbot widget */}
      <Chatbot />

      {/* Mobile bottom navigation bar */}
      <BottomNav />
    </>
  );
}
