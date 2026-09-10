import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { FaBars, FaTimes, FaPhoneAlt } from "react-icons/fa";
import Footer from "./Footer";
import FloatingActions from "../FloatingActions/FloatingActions";
import BottomNav from "../BottomNav/BottomNav";
import Chatbot from "../Chatbot/Chatbot";
import { useLang } from "../../context/LangContext";
import { TEMPLE, PRIMARY_CONTACT, telHref } from "../../data/temple";
import TemplePulseHeader from "../TemplePulseHeader/TemplePulseHeader";
import "./Layout.css";

const navLinks = [
  { to: "/", label: "முகப்பு", labelEn: "Home", icon: "🏠" },
  { to: "/about", label: "பற்றி", labelEn: "About", icon: "🛕" },
  { to: "/sevas", label: "சேவைகள்", labelEn: "Sevas", icon: "🙏" },
  { to: "/events", label: "நிகழ்வுகள்", labelEn: "Events", icon: "🎉" },
  { to: "/donations", label: "நன்கொடை", labelEn: "Donate", icon: "💛" },
  { to: "/contact", label: "தொடர்பு", labelEn: "Contact", icon: "📍" },
  { to: "/panchangam", label: "பஞ்சாங்கம்", labelEn: "Panchangam", icon: "🌕" },
];

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { lang, setLang, t } = useLang();
  const { pathname } = useLocation();
  const toggleRef = useRef(null);
  const drawerRef = useRef(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // Compact glass header once the page scrolls
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Close drawer on navigation
  useEffect(() => {
    closeMenu();
  }, [pathname, closeMenu]);

  // Drawer: lock scroll, Escape closes, focus moves in and back out
  useEffect(() => {
    if (!menuOpen) return undefined;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector("a")?.focus({ preventScroll: true });
    const onKey = (e) => e.key === "Escape" && closeMenu();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      toggleRef.current?.focus({ preventScroll: true });
    };
  }, [menuOpen, closeMenu]);

  const brandLabel = `${t(TEMPLE.fullName.ta, TEMPLE.fullName.en)} — ${t("முகப்பு", "Home")}`;

  return (
    <>
      <a href="#main-content" className="skip-link">
        {t("முக்கிய உள்ளடக்கத்திற்கு செல்ல", "Skip to main content")}
      </a>

      <TemplePulseHeader />

      <header className={`navbar${scrolled ? " navbar--scrolled" : ""}`}>
        <div className="container navbar__inner">
          <NavLink to="/" className="navbar__brand" aria-label={brandLabel}>
            <span className="navbar__logo-ring" aria-hidden="true">
              <img src="/logo.svg" alt="" className="navbar__logo" width="44" height="44" />
            </span>
            <span className="navbar__brand-text" aria-hidden="true">
              <span className="navbar__brand-line1">
                {t(TEMPLE.brand.line1.ta, TEMPLE.brand.line1.en)}
              </span>
              <span className="navbar__brand-line2">
                {t(TEMPLE.brand.line2.ta, TEMPLE.brand.line2.en)}
              </span>
            </span>
          </NavLink>

          <nav className="navbar__nav" aria-label={t("முதன்மை வழிசெலுத்தல்", "Primary")}>
            {navLinks.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === "/"}
                className={({ isActive }) =>
                  "navbar__link" + (isActive ? " navbar__link--active" : "")
                }
              >
                {t(link.label, link.labelEn)}
              </NavLink>
            ))}
          </nav>

          <div className="navbar__right">
            <div className="lang-toggle" role="group" aria-label={t("மொழி", "Language")}>
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

            <NavLink to="/sevas" className="btn btn-primary btn--sm navbar__cta">
              {t("சேவை பதிவு", "Book Seva")}
            </NavLink>

            <button
              ref={toggleRef}
              type="button"
              className="navbar__toggle"
              aria-label={menuOpen ? t("மெனுவை மூடு", "Close menu") : t("மெனுவை திற", "Open menu")}
              aria-expanded={menuOpen}
              aria-controls="mobile-drawer"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <FaTimes /> : <FaBars />}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile drawer */}
      <div
        className={`drawer-backdrop${menuOpen ? " drawer-backdrop--open" : ""}`}
        onClick={closeMenu}
        aria-hidden="true"
      />
      <aside
        id="mobile-drawer"
        ref={drawerRef}
        className={`drawer${menuOpen ? " drawer--open" : ""}`}
        aria-label={t("மெனு", "Menu")}
        aria-hidden={!menuOpen}
      >
        <div className="drawer__head">
          <span className="drawer__title">{t(TEMPLE.brand.line1.ta, TEMPLE.brand.line1.en)}</span>
          <button type="button" className="drawer__close" onClick={closeMenu} aria-label={t("மூடு", "Close")}>
            <FaTimes />
          </button>
        </div>
        <nav className="drawer__nav" aria-label={t("மொபைல் வழிசெலுத்தல்", "Mobile")}>
          {navLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === "/"}
              tabIndex={menuOpen ? 0 : -1}
              className={({ isActive }) => "drawer__link" + (isActive ? " drawer__link--active" : "")}
            >
              <span className="drawer__icon" aria-hidden="true">{link.icon}</span>
              {t(link.label, link.labelEn)}
            </NavLink>
          ))}
        </nav>
        <div className="drawer__foot">
          <a href={telHref(PRIMARY_CONTACT.phone)} className="btn btn-outline btn--block" tabIndex={menuOpen ? 0 : -1}>
            <FaPhoneAlt aria-hidden="true" /> {t("கோயிலை அழைக்க", "Call Temple")}
          </a>
          <NavLink to="/sevas" className="btn btn-primary btn--block" tabIndex={menuOpen ? 0 : -1}>
            {t("சேவை பதிவு", "Book a Seva")}
          </NavLink>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>

      <Footer />
      <FloatingActions />
      <Chatbot />
      <BottomNav />
    </>
  );
}
