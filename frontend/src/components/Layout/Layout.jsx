import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  LuCalendarDays,
  LuFlame,
  LuHeartHandshake,
  LuHouse,
  LuLandmark,
  LuMapPin,
  LuMenu,
  LuMoon,
  LuPhone,
  LuSearch,
  LuSparkles,
  LuTv,
  LuUserPlus,
  LuX,
} from "react-icons/lu";
import Footer from "./Footer";
import FloatingActions from "../FloatingActions/FloatingActions";
import BottomNav from "../BottomNav/BottomNav";
import Chatbot from "../Chatbot/Chatbot";
import TemplePulseHeader from "../TemplePulseHeader/TemplePulseHeader";
import { useLang } from "../../context/LangContext";
import { TEMPLE, PRIMARY_CONTACT, telHref, formatPhone } from "../../data/temple";
import { getISTNow, getNextPooja, isTempleOpen } from "../../lib/templeTime";
import "./Layout.css";

// The palette is only needed once someone reaches for it.
const SearchDialog = lazy(() => import("../Search/SearchDialog"));

export const NAV_LINKS = [
  { to: "/", ta: "முகப்பு", en: "Home", Icon: LuHouse },
  { to: "/about", ta: "பற்றி", en: "About", Icon: LuLandmark },
  { to: "/sevas", ta: "சேவைகள்", en: "Sevas", Icon: LuFlame },
  { to: "/events", ta: "நிகழ்வுகள்", en: "Events", Icon: LuCalendarDays },
  // `optional`: the header gives this entry up first when the row is short of
  // width (Layout.css hides it between 1024 and 1059 px, where the eight Tamil
  // labels clip); the drawer, the footer and the Home tile always carry it.
  { to: "/live-darshan", ta: "நேரடி தரிசனம்", en: "Live Darshan", Icon: LuTv, optional: true },
  { to: "/panchangam", ta: "பஞ்சாங்கம்", en: "Panchangam", Icon: LuMoon },
  { to: "/donations", ta: "நன்கொடை", en: "Donate", Icon: LuHeartHandshake },
  { to: "/contact", ta: "தொடர்பு", en: "Contact", Icon: LuMapPin },
];

export default function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { lang, setLang, t } = useLang();
  const { pathname } = useLocation();
  const toggleRef = useRef(null);
  const drawerRef = useRef(null);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Ctrl/Cmd+K anywhere, and "/" when the visitor is not already typing.
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      if (typing) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Floating "island" header once the page scrolls
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        setScrolled(window.scrollY > 24);
        raf = 0;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
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
    drawerRef.current?.querySelector("a, button")?.focus({ preventScroll: true });
    const onKey = (e) => e.key === "Escape" && closeMenu();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      toggleRef.current?.focus({ preventScroll: true });
    };
  }, [menuOpen, closeMenu]);

  // Accessible name starts with the visible brand text (WCAG 2.5.3 Label in Name)
  const brandLabel = `${t(TEMPLE.brand.line1.ta, TEMPLE.brand.line1.en)} ${t(TEMPLE.brand.line2.ta, TEMPLE.brand.line2.en)} — ${t(TEMPLE.fullName.ta, TEMPLE.fullName.en)} — ${t("முகப்பு", "Home")}`;
  const registerWord = t("குடும்பப் பதிவு", "Register family");

  return (
    <>
      <a href="#main-content" className="skip-link">
        {t("முக்கிய உள்ளடக்கத்திற்கு செல்ல", "Skip to main content")}
      </a>

      <TemplePulseHeader />

      <header className={`navbar${scrolled ? " navbar--scrolled" : ""}`}>
        <div className="navbar__bar">
          <div className="navbar__inner">
            <NavLink to="/" className="navbar__brand" aria-label={brandLabel}>
              <span className="navbar__logo-ring" aria-hidden="true">
                <img src="/logo.svg" alt="" className="navbar__logo" width="44" height="44" />
              </span>
              <span className="navbar__brand-text" aria-hidden="true">
                <span className="navbar__brand-line1">{t(TEMPLE.brand.line1.ta, TEMPLE.brand.line1.en)}</span>
                <span className="navbar__brand-line2">{t(TEMPLE.brand.line2.ta, TEMPLE.brand.line2.en)}</span>
              </span>
            </NavLink>

            <nav className="navbar__nav" aria-label={t("முதன்மை வழிசெலுத்தல்", "Primary")}>
              {NAV_LINKS.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.to === "/"}
                  className={({ isActive }) =>
                    "navbar__link" + (link.optional ? " navbar__link--optional" : "") + (isActive ? " navbar__link--active" : "")
                  }
                >
                  {t(link.ta, link.en)}
                </NavLink>
              ))}
            </nav>

            {/* Right cluster. The open/closed pill that used to sit here was a
                duplicate of TemplePulseHeader directly above, and the width it
                took was the reason the row overflowed its container and was
                clipped on the right. The strip still carries that information,
                and the timings link lives in the footer and in About. */}
            <div className="navbar__right">
              {/* Calling the temple is the action people most often want, and it
                  used to be a floating button that covered the page's left edge.
                  Here it is in the sticky header, so it is reachable from every
                  page at every scroll position. */}
              <a
                href={telHref(PRIMARY_CONTACT.phone)}
                className="navbar__icon-btn navbar__call"
                aria-label={`${t("கோயிலை அழைக்கவும்", "Call the temple")} — ${formatPhone(PRIMARY_CONTACT.phone)}`}
                title={formatPhone(PRIMARY_CONTACT.phone)}
              >
                <LuPhone aria-hidden="true" />
                <span className="navbar__call-num">{formatPhone(PRIMARY_CONTACT.phone)}</span>
              </a>

              <button
                type="button"
                className="navbar__icon-btn navbar__search"
                onClick={() => setSearchOpen(true)}
                aria-label={t("தளத்தில் தேடு", "Search the site")}
                title={t("தேடு (Ctrl+K)", "Search (Ctrl+K)")}
              >
                <LuSearch aria-hidden="true" />
              </button>

              {/* The language toggle used to sit here. It now lives in the
                  status strip above, which frees the width this row needs. */}
              {/* One way in for a family that has not registered yet. It took
                  the place of Login, Sign Up, the account menu and the bell when
                  devotee sign-in was removed (docs/registration/SPEC.md §7).
                  Where the row is short of width the words are hidden visually
                  but stay in the accessibility tree (Layout.css), so the button
                  keeps the same accessible name, "Register family", at every
                  width, and an icon on its own is never left unnamed. */}
              <NavLink to="/register" className="btn btn-primary btn--sm navbar__register" title={registerWord}>
                <LuUserPlus aria-hidden="true" />
                <span className="navbar__register-word">{registerWord}</span>
              </NavLink>

              <NavLink to="/sevas" className="btn btn-primary btn--sm navbar__cta">
                <LuSparkles aria-hidden="true" />
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
                {menuOpen ? <LuX aria-hidden="true" /> : <LuMenu aria-hidden="true" />}
              </button>
            </div>
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
          <button
            type="button"
            className="drawer__close"
            onClick={closeMenu}
            aria-label={t("மூடு", "Close")}
            tabIndex={menuOpen ? 0 : -1}
          >
            <LuX aria-hidden="true" />
          </button>
        </div>

        <DrawerStatus t={t} />

        <button
          type="button"
          className="drawer__search"
          tabIndex={menuOpen ? 0 : -1}
          onClick={() => {
            closeMenu();
            setSearchOpen(true);
          }}
        >
          <LuSearch aria-hidden="true" />
          <span>{t("தளத்தில் தேடு", "Search the site")}</span>
        </button>

        <nav className="drawer__nav" aria-label={t("மொபைல் வழிசெலுத்தல்", "Mobile")}>
          {NAV_LINKS.map(({ to, ta, en, Icon }, i) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              tabIndex={menuOpen ? 0 : -1}
              style={{ "--i": i }}
              onClick={closeMenu}
              className={({ isActive }) => "drawer__link" + (isActive ? " drawer__link--active" : "")}
            >
              <span className="drawer__icon" aria-hidden="true">
                <Icon />
              </span>
              {t(ta, en)}
            </NavLink>
          ))}
        </nav>

        <div className="drawer__foot">
          {/* The same way in as the header button, as a full row with a word on
              what it involves. Closing on click covers the visitor who is
              already on /register, where the route does not change. */}
          <NavLink
            to="/register"
            className={({ isActive }) => "drawer__register" + (isActive ? " drawer__register--active" : "")}
            tabIndex={menuOpen ? 0 : -1}
            onClick={closeMenu}
          >
            <span className="drawer__icon" aria-hidden="true">
              <LuUserPlus />
            </span>
            <span className="drawer__register-text">
              <span className="drawer__register-label">{t("குடும்பத்தைப் பதிவு செய்ய", "Register your family")}</span>
              <span className="drawer__register-hint">
                {t("ஒரு முறை மட்டும் · கடவுச்சொல் தேவையில்லை", "Once only · no password needed")}
              </span>
            </span>
          </NavLink>

          <div className="drawer__lang" role="group" aria-label={t("மொழி", "Language")}>
            <button
              type="button"
              className={`chip${lang === "ta" ? " chip--active" : ""}`}
              onClick={() => setLang("ta")}
              aria-pressed={lang === "ta"}
              tabIndex={menuOpen ? 0 : -1}
              lang="ta"
            >
              தமிழ்
            </button>
            <button
              type="button"
              className={`chip${lang === "en" ? " chip--active" : ""}`}
              onClick={() => setLang("en")}
              aria-pressed={lang === "en"}
              tabIndex={menuOpen ? 0 : -1}
              lang="en"
            >
              English
            </button>
          </div>
          <a
            href={telHref(PRIMARY_CONTACT.phone)}
            className="btn btn-outline btn--block"
            tabIndex={menuOpen ? 0 : -1}
            aria-label={`${t("கோயிலை அழைக்க", "Call Temple")} — ${formatPhone(PRIMARY_CONTACT.phone)}`}
          >
            <LuPhone aria-hidden="true" /> {t("கோயிலை அழைக்க", "Call Temple")}
          </a>
          <NavLink to="/sevas" className="btn btn-primary btn--block" tabIndex={menuOpen ? 0 : -1} onClick={closeMenu}>
            <LuSparkles aria-hidden="true" /> {t("சேவை பதிவு", "Book a Seva")}
          </NavLink>
        </div>
      </aside>

      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>

      {/* Nothing to show while the palette chunk loads — it opens a moment later. */}
      <Suspense fallback={null}>{searchOpen && <SearchDialog open onClose={closeSearch} />}</Suspense>

      <Footer />
      <FloatingActions />
      <Chatbot />
      <BottomNav />
    </>
  );
}

/** Small open/closed + next pooja card at the top of the mobile drawer. */
function DrawerStatus({ t }) {
  const now = getISTNow();
  const open = isTempleOpen(now);
  const { pooja } = getNextPooja(now);
  return (
    <div className={`drawer__status${open ? " drawer__status--open" : ""}`}>
      <span className="drawer__status-dot" aria-hidden="true" />
      <div>
        <strong>{open ? t("கோயில் திறந்துள்ளது", "Temple is open") : t("கோயில் மூடியுள்ளது", "Temple is closed")}</strong>
        <small>
          {t("அடுத்த பூஜை", "Next pooja")}: {t(pooja.ta, pooja.en)} · {String(pooja.h).padStart(2, "0")}:
          {String(pooja.m).padStart(2, "0")}
        </small>
      </div>
    </div>
  );
}
