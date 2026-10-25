import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import {
  LuCalendarDays,
  LuFlower2,
  LuHeartHandshake,
  LuLandmark,
  LuMapPin,
  LuScrollText,
  LuSparkles,
} from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import {
  TEMPLE,
  ADDRESS,
  HISTORY,
  LAND_DONATION,
  KUMBABHISHEKAM_APPEAL,
} from "../data/temple";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Seo from "../components/Seo";
import ShareButton from "../components/Share/ShareButton";
import HistoryTimeline from "../components/HistoryTimeline/HistoryTimeline";
import "./PageCommon.css";
import "./About.css";

/* In-page navigation follows the story sections below. */
const SECTIONS = [
  { id: "history", ta: "வரலாறு", en: "History", Icon: LuScrollText },
  { id: "deities", ta: "குலதெய்வங்கள்", en: "Deities", Icon: LuSparkles },
  { id: "land-donation", ta: "இட நன்கொடை", en: "Land donation", Icon: LuLandmark },
];

/* Hero fact tiles — years come straight from HISTORY.timeline (no new facts). */
const HERO_FACTS = [
  { key: "idols", ta: "சிலை பிரதிஷ்டை", en: "Idols consecrated" },
  { key: "kumbabhishekam2012", ta: "மஹா கும்பாபிஷேகம்", en: "Maha Kumbabhishekam" },
  { key: "trust2023", ta: "அறக்கட்டளை பதிவு", en: "Trust registered" },
];

export default function About() {
  const { lang, t } = useLang();
  const { hash } = useLocation();
  // The sanctum photograph is supplied separately (see public/images/README.md).
  // Hide the figure on error, and show the caption only once the image has
  // actually loaded so a missing file never reserves space above the anchors.
  const [photoOk, setPhotoOk] = useState(true);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  // Deities come from the CMS (/api/deities, admin → Worship → Deities); the
  // built-in three stand in until the answer arrives or if it is empty.
  const [deities, setDeities] = useState(null);
  const [brokenImages, setBrokenImages] = useState({});
  useEffect(() => {
    let alive = true;
    api
      .get("/deities")
      .then((r) => {
        if (alive && Array.isArray(r.data) && r.data.length) setDeities(r.data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const deityList = deities ?? TEMPLE.deities.map((d) => ({ name_ta: d.ta, name_en: d.en }));

  const facts = HERO_FACTS.map((f) => {
    const m = HISTORY.timeline.find((x) => x.key === f.key);
    if (!m) return null;
    return { ...f, year: m.date ? m.date.slice(0, 4) : t(m.year.ta, m.year.en), date: m.date };
  }).filter(Boolean);

  // One string, read by the visitor in the hero and by anyone the page is
  // shared with. See <Seo>.
  const title = t("ஆலயம் பற்றி", "About the Temple");
  const lead = t(TEMPLE.fullName.ta, TEMPLE.fullName.en);
  if (hash === "#committee" || hash === "#trust" || hash === "#trust-details") {
    return <Navigate to={`/trust-committee${hash}`} replace />;
  }

  return (
    <>
      <Seo title={t("பற்றி", "About")} description={lead} type="article" />

      <PageHero
        variant="about"
        className="about-hero"
        eyebrow={t("வரலாறு · குலதெய்வங்கள்", "History · Deities")}
        title={title}
        lead={lead}
        crumbs={[{ label: t("பற்றி", "About") }]}
        actions={
          <>
            <Button variant="gold" to="/sevas" icon={<LuSparkles aria-hidden="true" />}>
              {t("சேவை பதிவு", "Book Seva")}
            </Button>
            <Button variant="outline-light" to="/contact" icon={<LuMapPin aria-hidden="true" />}>
              {t("வழி & தொடர்பு", "Directions & Contact")}
            </Button>
            <ShareButton variant="outline-light" title={title} text={lead} />
          </>
        }
        aside={
          <dl className="about-hero__facts" aria-label={t("முக்கிய ஆண்டுகள்", "Key years")}>
            {facts.map((f, i) => (
              <div key={f.key} className="about-hero__fact rise" style={{ "--i": i }}>
                <dt className="about-hero__fact-label">{t(f.ta, f.en)}</dt>
                <dd className="about-hero__fact-year">
                  {f.date ? <time dateTime={f.date}>{f.year}</time> : f.year}
                </dd>
              </div>
            ))}
          </dl>
        }
      >
        <p className="page-hero__lead about-hero__address">
          <LuMapPin aria-hidden="true" />
          {t(ADDRESS.printed.ta, ADDRESS.printed.en)}
        </p>
      </PageHero>

      {/* ── Sticky in-page section nav ─────────────────────────── */}
      <nav className="about-nav" aria-label={t("இந்தப் பக்கத்தில்", "On this page")}>
        <div className="container">
          <ul className="about-nav__list" role="list">
            {SECTIONS.map(({ id, ta, en, Icon }) => (
              <li key={id} className="about-nav__item">
                <Link
                  to={`#${id}`}
                  className="chip about-nav__chip"
                  aria-current={hash === `#${id}` ? "location" : undefined}
                >
                  <Icon aria-hidden="true" />
                  {t(ta, en)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <section className="section section--tight about">
        <div className="container page-prose about-prose">
          <div className="about-introduction">
            <div className="about-introduction__text">
              <span className="about-introduction__emblem" aria-hidden="true"><LuFlower2 /></span>
              <p className="eyebrow">{t("நம் ஆலயம் · நம் பாரம்பரியம்", "Our temple · Our heritage")}</p>
              <h2>{t("தலைமுறைகளை இணைக்கும் இறைநம்பிக்கை", "A sacred bond across generations")}</h2>
              <p>{t(
                "நம் குலதெய்வங்களின் அருளுடன், வழிபாடும் பாரம்பரியமும் குடும்பங்களை இணைக்கின்றன. நம் ஆலயத்தின் வரலாற்றையும் இறைச் சேவையையும் அறிந்திடுங்கள்.",
                "In devotion to our clan deities, worship and tradition bring families together. Discover the story of our temple and the community that cares for it.",
              )}</p>
              <Button to="/trust-committee" variant="outline" icon={<LuHeartHandshake aria-hidden="true" />}>
                {t("அறக்கட்டளை & கமிட்டி", "Meet the Trust & Committee")}
              </Button>
            </div>
          {photoOk && (
            <figure className={`about-figure card card--static${photoLoaded ? " rise" : " about-figure--pending"}`}>
              <img
                src={TEMPLE.photoSrc}
                alt={t(TEMPLE.photoAlt.ta, TEMPLE.photoAlt.en)}
                loading="lazy"
                onLoad={() => setPhotoLoaded(true)}
                onError={() => setPhotoOk(false)}
              />
              {photoLoaded && (
                <figcaption className="about-figure__caption">
                  <em>{t(TEMPLE.invocation.ta, TEMPLE.invocation.en)}</em>
                </figcaption>
              )}
            </figure>
          )}
          </div>

          {/* ── History ─────────────────────────────────────────── */}
          <section className="about-story" aria-labelledby="history">
          <p className="about-story__eyebrow">{t("01 · நம் வேர்கள்", "01 · Our roots")}</p>
          <h2 id="history">{t("வரலாறு", "History")}</h2>
          <HistoryTimeline />
          </section>

          {/* ── Deities ─────────────────────────────────────────── */}
          <section className="about-story about-story--deities" aria-labelledby="deities">
          <p className="about-story__eyebrow">{t("02 · இறையருள்", "02 · Divine grace")}</p>
          <h2 id="deities">{t("குலதெய்வங்கள்", "Our Clan Deities")}</h2>
          <p>
            {t(
              "நமது குலதெய்வங்கள் மூவர். ஒவ்வொரு மஹா சிவராத்திரி அன்றும் குலமக்கள் தரிசனம் செய்கின்றனர்; ஒவ்வொரு மாதம் பௌர்ணமி அன்றும் சிறப்பு பூஜையும் அன்னதானமும் நடைபெறுகின்றன.",
              "Our clan deities are three. Clan members gather for darshan every Maha Shivaratri, and special pooja and annadanam are held every month on Pournami.",
            )}
          </p>
          <ul className={`about-deities${deityList.length !== 3 ? " about-deities--flow" : ""}`} role="list" data-source={deities ? "cms" : "builtin"}>
            {deityList.map((d, i) => {
              const desc = lang === "ta" ? d.description_ta || d.description_en : d.description_en || d.description_ta;
              return (
                <li key={d.id ?? d.name_en} className="about-deities__item card card--static rise" style={{ "--i": i }}>
                  {d.image_url && !brokenImages[d.id] ? (
                    <img
                      className="about-deities__image"
                      src={d.image_url}
                      alt={lang === "ta" ? d.name_ta : d.name_en}
                      loading="lazy"
                      onError={() => setBrokenImages((b) => ({ ...b, [d.id]: true }))}
                    />
                  ) : (
                    <span className="about-deities__glyph" aria-hidden="true">
                      <LuFlower2 />
                    </span>
                  )}
                  <span className="about-deities__ta" lang="ta">
                    {d.name_ta}
                  </span>
                  <span className="about-deities__en" lang="en">
                    {d.name_en}
                  </span>
                  {desc && <p className="about-deities__desc">{desc}</p>}
                </li>
              );
            })}
          </ul>
          <p className="about-link">
            <Button variant="soft" size="sm" to="/events" icon={<LuCalendarDays aria-hidden="true" />}>
              {t("பௌர்ணமி தேதிகள் →", "Pournami dates →")}
            </Button>
          </p>
          </section>

          {/* ── Land donation & buildings ───────────────────────── */}
          <section className="about-story" aria-labelledby="land-donation">
          <p className="about-story__eyebrow">{t("03 · இறைச் சேவை", "03 · A legacy of giving")}</p>
          <h2 id="land-donation">{t(LAND_DONATION.heading.ta, LAND_DONATION.heading.en)}</h2>
          <p>{t(LAND_DONATION.ta, LAND_DONATION.en)}</p>
          <div className="about-donor card card--gold card--static rise">
            <span className="card__icon about-donor__icon" aria-hidden="true">
              <LuLandmark />
            </span>
            <div className="about-donor__body">
              <p className="about-donor__label">{t("இட நன்கொடையாளர்கள்", "Land donors")}</p>
              <p className="about-donor__name">{t(LAND_DONATION.donors.family.ta, LAND_DONATION.donors.family.en)}</p>
              <p className="about-donor__detail">{t(LAND_DONATION.donors.detail.ta, LAND_DONATION.donors.detail.en)}</p>
              <p className="about-donor__names">{t(LAND_DONATION.donors.names.ta, LAND_DONATION.donors.names.en)}</p>
            </div>
          </div>

          <aside className="about-appeal card card--ink card--static rise" aria-labelledby="about-appeal-title">
            <div className="about-appeal__body">
              <p className="eyebrow eyebrow--on-dark about-appeal__eyebrow">
                {t("வேண்டுகோள்", "Appeal")}
              </p>
              <h3 id="about-appeal-title" className="about-appeal__title">
                {t(KUMBABHISHEKAM_APPEAL.heading.ta, KUMBABHISHEKAM_APPEAL.heading.en)}
              </h3>
              <p className="about-appeal__text">{t(KUMBABHISHEKAM_APPEAL.ta, KUMBABHISHEKAM_APPEAL.en)}</p>
              <div className="about-appeal__actions">
                <Button variant="gold" to="/donations#bank-details" icon={<LuHeartHandshake aria-hidden="true" />}>
                  {t("நன்கொடை வழங்க →", "Donate →")}
                </Button>
              </div>
            </div>
          </aside>
          </section>

        </div>
      </section>
    </>
  );
}
