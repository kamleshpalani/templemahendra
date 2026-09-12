import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  LuCalendarDays,
  LuCircleUser,
  LuFlame,
  LuHeartHandshake,
  LuHouse,
  LuLandmark,
  LuLogIn,
  LuLogOut,
  LuMapPin,
  LuMenu,
  LuMoon,
  LuPhone,
  LuSearch,
  LuSparkles,
  LuUserPlus,
  LuX,
} from "react-icons/lu";
import Footer from "./Footer";
import FloatingActions from "../FloatingActions/FloatingActions";
import BottomNav from "../BottomNav/BottomNav";
import Chatbot from "../Chatbot/Chatbot";
import TemplePulseHeader from "../TemplePulseHeader/TemplePulseHeader";
import { useLang } from "../../context/LangContext";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
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
                  className={({ isActive }) => "navbar__link" + (isActive ? " navbar__link--active" : "")}
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
              <button
                type="button"
                className="navbar__icon-btn navbar__search"
                onClick={() => setSearchOpen(true)}
                aria-label={t("தளத்தில் தேடு", "Search the site")}
                title={t("தேடு (Ctrl+K)", "Search (Ctrl+K)")}
              >
                <LuSearch aria-hidden="true" />
              </button>

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

              <AccountControl />

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
          <DrawerAccount menuOpen={menuOpen} onNavigate={closeMenu} />

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
          <NavLink to="/sevas" className="btn btn-primary btn--block" tabIndex={menuOpen ? 0 : -1}>
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

/**
 * The account control in the navbar: a sign-in link for a guest, and for a
 * signed-in devotee an initials button opening a small menu. Hidden entirely
 * when the devotee tables have not been migrated in.
 */
function AccountControl() {
  const { t } = useLang();
  const { user, ready, accountsEnabled, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);

  // Close on outside click, on Escape, and whenever the route changes.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => setOpen(false), [pathname]);

  // While the first /auth/me is in flight, hold the space rather than letting
  // the row reflow under the visitor's cursor a moment after paint.
  if (!ready) return <span className="navbar__auth-hold" aria-hidden="true" />;
  if (!accountsEnabled) return null;

  if (!user) {
    return (
      <div className="navbar__auth">
        {/* The words are hidden below 1280px, so each link carries its own
            accessible name — an icon alone would leave it unnamed. */}
        <NavLink to="/login" className="btn btn-outline btn--sm navbar__login" aria-label={t("உள்நுழை", "Login")}>
          <LuLogIn aria-hidden="true" />
          <span className="navbar__auth-word">{t("உள்நுழை", "Login")}</span>
        </NavLink>
        <NavLink
          to="/register"
          className="btn btn-gold btn--sm navbar__signup"
          aria-label={t("பதிவு செய்யுங்கள்", "Sign Up")}
        >
          <LuUserPlus aria-hidden="true" />
          <span className="navbar__auth-word">{t("பதிவு", "Sign Up")}</span>
        </NavLink>
      </div>
    );
  }

  const initials =
    user.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "·";

  const signOut = async () => {
    setOpen(false);
    await logout();
    toast.info(t("வெளியேறிவிட்டீர்கள்.", "You are signed out."));
    navigate("/", { replace: true });
  };

  return (
    <div className="dropdown" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="navbar__acct-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`${t("என் கணக்கு", "My account")} — ${user.name}`}
      >
        <span className="avatar" aria-hidden="true">
          {initials}
        </span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <span className="menu__label">{user.name}</span>
          <NavLink to="/account" className="menu__item" role="menuitem">
            <LuCircleUser aria-hidden="true" />
            {t("என் கணக்கு", "My account")}
          </NavLink>
          <NavLink to="/sevas" className="menu__item" role="menuitem">
            <LuFlame aria-hidden="true" />
            {t("சேவை பதிவு", "Book a seva")}
          </NavLink>
          <span className="menu__divider" role="separator" />
          <button type="button" className="menu__item menu__item--danger" role="menuitem" onClick={signOut}>
            <LuLogOut aria-hidden="true" />
            {t("வெளியேறு", "Sign out")}
          </button>
        </div>
      )}
    </div>
  );
}

/** The same account entry points, as full-width rows in the mobile drawer. */
function DrawerAccount({ menuOpen, onNavigate }) {
  const { t } = useLang();
  const { user, ready, accountsEnabled, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const tab = menuOpen ? 0 : -1;

  if (!ready || !accountsEnabled) return null;

  if (!user) {
    return (
      <div className="drawer__acct">
        <NavLink to="/login" className="btn btn-soft btn--block" tabIndex={tab} onClick={onNavigate}>
          <LuLogIn aria-hidden="true" /> {t("உள்நுழை", "Sign in")}
        </NavLink>
        <NavLink to="/register" className="btn btn-ghost btn--block" tabIndex={tab} onClick={onNavigate}>
          <LuUserPlus aria-hidden="true" /> {t("புதிய கணக்கு", "Create account")}
        </NavLink>
      </div>
    );
  }

  const signOut = async () => {
    onNavigate();
    await logout();
    toast.info(t("வெளியேறிவிட்டீர்கள்.", "You are signed out."));
    navigate("/", { replace: true });
  };

  return (
    <div className="drawer__acct">
      <NavLink to="/account" className="btn btn-soft btn--block" tabIndex={tab} onClick={onNavigate}>
        <LuCircleUser aria-hidden="true" /> {t("என் கணக்கு", "My account")}
      </NavLink>
      <button type="button" className="btn btn-ghost btn--block" tabIndex={tab} onClick={signOut}>
        <LuLogOut aria-hidden="true" /> {t("வெளியேறு", "Sign out")}
      </button>
    </div>
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
