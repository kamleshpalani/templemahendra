import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useLang } from "../context/LangContext";
import {
  TEMPLE,
  ADDRESS,
  TRUST,
  COMMITTEE,
  LAND_DONATION,
  KUMBABHISHEKAM_APPEAL,
} from "../data/temple";
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

export default function About() {
  const { t } = useLang();
  // The sanctum photograph is supplied separately (see public/images/README.md);
  // hide the figure rather than show a broken image until the file exists.
  const [photoOk, setPhotoOk] = useState(true);

  return (
    <>
      <Helmet>
        <title>
          {t("பற்றி", "About")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <div className="page-hero page-hero--about">
        <div className="page-hero__content">
          <span className="page-hero__eyebrow">{t("வரலாறு · அறக்கட்டளை · கமிட்டி", "History · Trust · Committee")}</span>
          <h1>{t("ஆலயம் பற்றி", "About the Temple")}</h1>
          <p>{t(TEMPLE.fullName.ta, TEMPLE.fullName.en)}</p>
          <p>{t(ADDRESS.printed.ta, ADDRESS.printed.en)}</p>
        </div>
      </div>

      <section className="section">
        <div className="container page-prose">
          {photoOk && (
            <figure className="page-figure">
              <img
                src={TEMPLE.photoSrc}
                alt={t(TEMPLE.photoAlt.ta, TEMPLE.photoAlt.en)}
                loading="lazy"
                onError={() => setPhotoOk(false)}
              />
              <figcaption>
                <em>{t(TEMPLE.invocation.ta, TEMPLE.invocation.en)}</em>
              </figcaption>
            </figure>
          )}

          {/* ── History ─────────────────────────────────────────── */}
          <h2 id="history">{t("வரலாறு", "History")}</h2>
          <HistoryTimeline />

          {/* ── Deities ─────────────────────────────────────────── */}
          <h2 id="deities">{t("குலதெய்வங்கள்", "Our Clan Deities")}</h2>
          <p>
            {t(
              "நமது குலதெய்வங்கள் மூவர். ஒவ்வொரு மஹா சிவராத்திரி அன்றும் குலமக்கள் தரிசனம் செய்கின்றனர்; ஒவ்வொரு மாதம் பௌர்ணமி அன்றும் சிறப்பு பூஜையும் அன்னதானமும் நடைபெறுகின்றன.",
              "Our clan deities are three. Clan members gather for darshan every Maha Shivaratri, and special pooja and annadanam are held every month on Pournami.",
            )}
          </p>
          <ul className="about-deities">
            {TEMPLE.deities.map((d) => (
              <li key={d.en} className="about-deities__item">
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
            <Link to="/events">
              {t("பௌர்ணமி தேதிகள் →", "Pournami dates →")}
            </Link>
          </p>

          {/* ── Land donation & buildings ───────────────────────── */}
          <h2 id="land-donation">
            {t(LAND_DONATION.heading.ta, LAND_DONATION.heading.en)}
          </h2>
          <p>{t(LAND_DONATION.ta, LAND_DONATION.en)}</p>
          <div className="about-donor card about-donor--static">
            <p className="about-donor__label">
              {t("இட நன்கொடையாளர்கள்", "Land donors")}
            </p>
            <p className="about-donor__name">
              {t(LAND_DONATION.donors.family.ta, LAND_DONATION.donors.family.en)}
            </p>
            <p className="about-donor__detail">
              {t(LAND_DONATION.donors.detail.ta, LAND_DONATION.donors.detail.en)}
            </p>
            <p className="about-donor__names">
              {t(LAND_DONATION.donors.names.ta, LAND_DONATION.donors.names.en)}
            </p>
          </div>

          {/* ── Dharma Trust ────────────────────────────────────── */}
          <h2 id="trust">{t("தர்ம அறக்கட்டளை", "Dharma Trust")}</h2>
          <p>{t(TRUST.narrative.ta, TRUST.narrative.en)}</p>
          <TrustDetails variant="full" id="trust-details" />

          <aside
            className="about-appeal"
            aria-labelledby="about-appeal-title"
          >
            <h3 id="about-appeal-title" className="about-appeal__title">
              {t(KUMBABHISHEKAM_APPEAL.heading.ta, KUMBABHISHEKAM_APPEAL.heading.en)}
            </h3>
            <p className="about-appeal__text">
              {t(KUMBABHISHEKAM_APPEAL.ta, KUMBABHISHEKAM_APPEAL.en)}
            </p>
            <Link to="/donations#bank-details" className="btn btn-primary">
              {t("நன்கொடை வழங்க →", "Donate →")}
            </Link>
          </aside>

          {/* ── Committee ───────────────────────────────────────── */}
          <h2 id="committee">
            {t("திருக்கோவில் கமிட்டியார்", "Temple Committee")}
          </h2>
          <p>
            <em>{t(COMMITTEE.invite.ta, COMMITTEE.invite.en)}</em>
          </p>
          {/* Page owns the h2, so cards render as h3 (headingLevel 2, heading hidden) */}
          <CommitteeGrid showHeading={false} showInvite={false} headingLevel={2} />

          {/* ── Daily timings (existing schedule) ───────────────── */}
          <h2 id="timings">{t("வழிபாட்டு நேரங்கள்", "Timings")}</h2>
          <div className="table-scroll">
            <table className="timings-table">
              <caption className="visually-hidden">
                {t("தினசரி பூஜை நேரங்கள்", "Daily pooja timings")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("பூஜை", "Pooja")}</th>
                  <th scope="col">{t("தமிழ்", "Tamil")}</th>
                  <th scope="col">{t("நேரம்", "Time")}</th>
                </tr>
              </thead>
              <tbody>
                {DAILY_POOJAS.map(([en, ta, time]) => (
                  <tr key={en}>
                    <td lang="en">{en}</td>
                    <td lang="ta">{ta}</td>
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
