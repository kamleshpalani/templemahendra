import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useLocation } from "react-router-dom";
import {
  LuCalendarDays,
  LuClock,
  LuFileBadge,
  LuHeartHandshake,
  LuLandmark,
  LuMapPin,
  LuScrollText,
  LuSparkles,
  LuUsers,
} from "react-icons/lu";
import { useLang } from "../context/LangContext";
import {
  TEMPLE,
  ADDRESS,
  TRUST,
  COMMITTEE,
  HISTORY,
  LAND_DONATION,
  KUMBABHISHEKAM_APPEAL,
} from "../data/temple";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import HistoryTimeline from "../components/HistoryTimeline/HistoryTimeline";
import TrustDetails from "../components/TrustDetails/TrustDetails";
import CommitteeGrid from "../components/CommitteeGrid/CommitteeGrid";
import "./PageCommon.css";
import "./About.css";

/* Existing daily pooja schedule (also used by the live "Next Pooja" widget). */
const DAILY_POOJAS = [
  ["Thiruvanandal", "திருவனந்தல்", "6:00 AM"],
  ["Kaalaasanthi", "காலசந்தி", "8:00 AM"],
  ["Uchikalam", "உச்சிகால பூஜை", "12:00 PM"],
  ["Sayarakshai", "சாயரக்‍ஷை", "6:00 PM"],
  ["Arthajama Pooja", "அர்த்தஜாம பூஜை", "8:30 PM"],
];

/* In-page section nav — ids match the h2 anchors below (deep-linked from
   the navbar live pill (#timings), Donations (#trust) and Contact). */
const SECTIONS = [
  { id: "history", ta: "வரலாறு", en: "History", Icon: LuScrollText },
  { id: "deities", ta: "குலதெய்வங்கள்", en: "Deities", Icon: LuSparkles },
  { id: "land-donation", ta: "இட நன்கொடை", en: "Land donation", Icon: LuLandmark },
  { id: "trust", ta: "அறக்கட்டளை", en: "Trust", Icon: LuFileBadge },
  { id: "committee", ta: "கமிட்டி", en: "Committee", Icon: LuUsers },
  { id: "timings", ta: "நேரங்கள்", en: "Timings", Icon: LuClock },
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

  const facts = HERO_FACTS.map((f) => {
    const m = HISTORY.timeline.find((x) => x.key === f.key);
    if (!m) return null;
    return { ...f, year: m.date ? m.date.slice(0, 4) : t(m.year.ta, m.year.en), date: m.date };
  }).filter(Boolean);

  return (
    <>
      <Helmet>
        <title>
          {t("பற்றி", "About")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <PageHero
        variant="about"
        eyebrow={t("வரலாறு · அறக்கட்டளை · கமிட்டி", "History · Trust · Committee")}
        title={t("ஆலயம் பற்றி", "About the Temple")}
        lead={t(TEMPLE.fullName.ta, TEMPLE.fullName.en)}
        crumbs={[{ label: t("பற்றி", "About") }]}
        actions={
          <>
            <Button variant="gold" to="/sevas" icon={<LuSparkles aria-hidden="true" />}>
              {t("சேவை பதிவு", "Book Seva")}
            </Button>
            <Button variant="outline-light" to="/contact" icon={<LuMapPin aria-hidden="true" />}>
              {t("வழி & தொடர்பு", "Directions & Contact")}
            </Button>
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

          {/* ── History ─────────────────────────────────────────── */}
          <h2 id="history">{t("வரலாறு", "History")}</h2>
          <HistoryTimeline />

          {/* ── Deities ─────────────────────────────────────────── */}
          <h2 id="deities">{t("குலதெய்வங்கள்", "Our Clan Deities")}</h2>
          <ul className="about-deities" role="list">
            {TEMPLE.deities.map((d, i) => (
              <li key={d.en} className="about-deities__item card card--static rise" style={{ "--i": i }}>
                <span className="about-deities__glyph" aria-hidden="true">
                  ✦
                </span>
                <span className="about-deities__ta" lang="ta">
                  {d.ta}
                </span>
                <span className="about-deities__en" lang="en">
                  {d.en}
                </span>
              </li>
            ))}
          </ul>
          <p className="about-link">
            <Button variant="soft" size="sm" to="/events" icon={<LuCalendarDays aria-hidden="true" />}>
              {t("பௌர்ணமி தேதிகள் →", "Pournami dates →")}
            </Button>
          </p>

          {/* ── Land donation & buildings ───────────────────────── */}
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

          {/* ── Dharma Trust ────────────────────────────────────── */}
          <h2 id="trust">{t("தர்ம அறக்கட்டளை", "Dharma Trust")}</h2>
          <p>{t(TRUST.narrative.ta, TRUST.narrative.en)}</p>
          <TrustDetails variant="full" id="trust-details" />

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

          {/* ── Committee ───────────────────────────────────────── */}
          <h2 id="committee">{t(COMMITTEE.heading.ta, COMMITTEE.heading.en)}</h2>
          <p>
            <em>{t(COMMITTEE.invite.ta, COMMITTEE.invite.en)}</em>
          </p>
          {/* Page owns the h2, so cards render as h3 (headingLevel 2, heading hidden) */}
          <CommitteeGrid showHeading={false} showInvite={false} headingLevel={2} />

          {/* ── Daily timings (existing schedule) ───────────────── */}
          <h2 id="timings">{t("வழிபாட்டு நேரங்கள்", "Timings")}</h2>
          <div className="about-timings">
            <table className="timings-table">
              <caption className="visually-hidden">{t("தினசரி பூஜை நேரங்கள்", "Daily pooja timings")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("பூஜை", "Pooja")}</th>
                  <th scope="col">{t("ஆங்கிலம்", "Tamil")}</th>
                  <th scope="col">{t("நேரம்", "Time")}</th>
                </tr>
              </thead>
              <tbody>
                {/* Column 1 follows the active language; column 2 shows the other,
                    so neither mode repeats the same text in both columns. */}
                {DAILY_POOJAS.map(([en, ta, time]) => (
                  <tr key={en}>
                    <td lang={lang}>{t(ta, en)}</td>
                    <td lang={lang === "ta" ? "en" : "ta"}>{lang === "ta" ? en : ta}</td>
                    <td>{time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}
