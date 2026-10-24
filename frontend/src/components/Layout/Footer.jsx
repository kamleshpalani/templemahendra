import { NavLink } from "react-router-dom";
import { LuArrowUp, LuClock, LuGlobe, LuMail, LuMapPin, LuPhone, LuShieldCheck } from "react-icons/lu";
import { FaWhatsapp } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import { siteHours, siteText, siteValue, useSiteSettings } from "../../lib/siteSettings";
import { to12h } from "../../lib/templeTime";
import {
  TEMPLE,
  ADDRESS,
  TRUST,
  PRIMARY_CONTACT,
  SECONDARY_CONTACT,
  TEMPLE_EMAIL,
  MAPS_URL,
  formatPhone,
  telHref,
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
  const { lang, t } = useLang();

  const quickLinks = [
    { to: "/about#history", ta: "கோவில் வரலாறு", en: "History" },
    { to: "/about#trust", ta: "தர்ம அறக்கட்டளை", en: "Dharma Trust" },
    { to: "/about#committee", ta: "திருக்கோவில் கமிட்டி", en: "Committee" },
    { to: "/deities", ta: "குலதெய்வங்கள்", en: "Deities" },
    { to: "/sevas", ta: "சேவைகள் & பூஜைகள்", en: "Sevas & Poojas" },
    { to: "/sponsorship", ta: "பூஜை உபயம்", en: "Pooja sponsorship" },
    { to: "/events", ta: "நிகழ்வுகள் & திருவிழா", en: "Events & Festivals" },
    { to: "/live-darshan", ta: "நேரடி தரிசனம்", en: "Live Darshan" },
    { to: "/gallery", ta: "படத் தொகுப்பு", en: "Gallery" },
    { to: "/videos", ta: "காணொளிகள்", en: "Videos" },
    { to: "/panchangam", ta: "பஞ்சாங்கம்", en: "Panchangam" },
    { to: "/donations", ta: "நன்கொடை", en: "Donate" },
    { to: "/register", ta: "குடும்பப் பதிவு", en: "Family registration" },
    { to: "/contact", ta: "தொடர்பு கொள்ளுங்கள்", en: "Contact Us" },
  ];

  const contacts = [PRIMARY_CONTACT, SECONDARY_CONTACT];
  const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
  // The committee's details (Admin → System → Settings) where typed; the
  // booklet facts in data/temple.js otherwise.
  const { site } = useSiteSettings();
  const templeName = siteText(site, "temple_name", lang) || t(TEMPLE.name.ta, TEMPLE.name.en);
  const templeDescriptor = siteText(site, "temple_descriptor", lang) || t(TEMPLE.descriptor.ta, TEMPLE.descriptor.en);
  const addressLine = siteText(site, "temple_address", lang) || t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en);
  const mapsQuery = siteValue(site, "maps_query");
  const mapsUrl = mapsQuery ? `https://maps.google.com/maps?q=${encodeURIComponent(mapsQuery)}` : MAPS_URL;
  const email = siteValue(site, "email") || TEMPLE_EMAIL;
  const hours = siteHours(site);
  const whatsapp = siteValue(site, "social_whatsapp") || `https://wa.me/91${PRIMARY_CONTACT.phone}`;
  const social = [
    ["youtube", siteValue(site, "social_youtube") || TEMPLE.youtube.channelUrl, "YouTube"],
    ["facebook", siteValue(site, "social_facebook"), "Facebook"],
    ["instagram", siteValue(site, "social_instagram"), "Instagram"],
  ].filter(([, href]) => href);

  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__col footer__col--brand">
          <div className="footer__brand">
            <span className="footer__logo-ring" aria-hidden="true">
              <img src="/logo.svg" alt="" width="44" height="44" />
            </span>
            <h2 className="footer__title">{templeName}</h2>
          </div>
          <p className="footer__desc">{templeDescriptor}</p>
          <p className="footer__invocation">
            <em>{t(TEMPLE.invocation.ta, TEMPLE.invocation.en)}</em>
          </p>
          <NavLink to="/about#trust" className="footer__trust">
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
          <h3 className="footer__heading">{t("இணைப்புகள்", "Explore")}</h3>
          <ul className="footer__links" role="list">
            {quickLinks.map(({ to, ta, en }) => (
              <li key={to}>
                <NavLink to={to}>{t(ta, en)}</NavLink>
              </li>
            ))}
          </ul>
        </div>

        <div className="footer__col">
          <h3 className="footer__heading">{t("வருகை", "Visit")}</h3>
          <ul className="footer__contact" role="list">
            <li>
              <LuMapPin aria-hidden="true" />
              <address className="footer__address">
                {addressLine}
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="footer__map">
                  {t("வழி அறிய ↗", "Get directions ↗")}
                </a>
              </address>
            </li>
            <li>
              <LuClock aria-hidden="true" />
              <span>
                {hours ? (
                  hours.map((w, i) => (
                    <span key={w.open}>
                      {i > 0 && <br />}
                      {to12h(w.open)} – {to12h(w.close)}
                    </span>
                  ))
                ) : (
                  <>
                    {t("காலை 6:00 – மதியம் 12:30", "6:00 AM – 12:30 PM")}
                    <br />
                    {t("மாலை 4:00 – இரவு 9:00", "4:00 PM – 9:00 PM")}
                  </>
                )}
              </span>
            </li>
          </ul>
        </div>

        <div className="footer__col">
          <h3 className="footer__heading">{t("தொடர்பு", "Contact")}</h3>
          <ul className="footer__contact" role="list">
            {contacts.map((c) => (
              <li key={c.phone}>
                <LuPhone aria-hidden="true" />
                <span>
                  <a
                    href={telHref(c.phone)}
                    aria-label={`${formatPhone(c.phone)} — ${t(c.name.ta, c.name.en)}, ${t(c.role.ta, c.role.en)}`}
                  >
                    {formatPhone(c.phone)}
                  </a>
                  <span className="footer__contact-role">
                    {t(c.role.ta, c.role.en)} – {t(c.name.ta, c.name.en)}
                  </span>
                </span>
              </li>
            ))}
            <li>
              <FaWhatsapp aria-hidden="true" />
              <a href={whatsapp} target="_blank" rel="noopener noreferrer">
                {t("வாட்ஸ்அப்பில் பேசுங்கள்", "Chat on WhatsApp")}
              </a>
            </li>
            <li>
              <LuMail aria-hidden="true" />
              <a href={`mailto:${email}`}>{email}</a>
            </li>
            {social.length > 0 && (
              <li className="footer__social" data-testid="footer-social">
                <LuGlobe aria-hidden="true" />
                <span>
                  {social.map(([key, href, label], i) => (
                    <span key={key}>
                      {i > 0 && " · "}
                      <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
                    </span>
                  ))}
                </span>
              </li>
            )}
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
            <a href="/admin/" className="footer__admin" rel="nofollow">
              {t("கமிட்டி உள்நுழைவு", "Committee sign-in")}
            </a>
            <button type="button" className="footer__top" onClick={scrollTop} aria-label={t("மேலே செல்", "Back to top")}>
              <LuArrowUp aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}
