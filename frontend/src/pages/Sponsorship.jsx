import { useCallback, useEffect, useState } from "react";
import { LuCalendarDays, LuClock, LuHeart, LuHeartHandshake, LuInfo, LuMail, LuPhone, LuSparkles } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import SectionHeader from "../components/ui/SectionHeader";
import ShareButton from "../components/Share/ShareButton";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import { useLang } from "../context/LangContext";
import { PRIMARY_CONTACT, TEMPLE, TEMPLE_EMAIL, formatPhone, telHref } from "../data/temple";
import { formatMoney } from "../lib/money";
import { formatPlainDate, getJson, paymentsUsable, usePaymentsConfig } from "../lib/payments";
import { siteValue, useSiteSettings } from "../lib/siteSettings";
import "./Sponsorship.css";

/*
 * Sponsorship (brief §6 Sponsorship, §11): the poojas the committee has opened
 * for sponsorship — GET /api/poojas?upcoming=1&sponsorship=1 — each with its
 * amount, date, time, type and status, and below them the sponsors who agreed
 * to be named (GET /api/donors, type "sponsor"). Both feeds are gated on the
 * server (sponsorPublicSql): a name reaches this page only with the sponsor's
 * publish consent, and nothing private ever does. "Sponsor" goes to the online
 * flow (/donate?pooja=<id>) when the gateway is usable, else to the office.
 */

/* Brief §9 pooja types. Moon is the lunar accent; gold marks a festival. */
const TYPE_META = {
  pournami: { ta: "பௌர்ணமி", en: "Pournami", tone: "moon" },
  amavasai: { ta: "அமாவாசை", en: "Amavasai", tone: "moon" },
  ekadasi: { ta: "ஏகாதசி", en: "Ekadasi", tone: "moon" },
  sashti: { ta: "சஷ்டி", en: "Sashti", tone: "moon" },
  pradosham: { ta: "பிரதோஷம்", en: "Pradosham", tone: "moon" },
  chaturthi: { ta: "சங்கடஹர சதுர்த்தி", en: "Sankatahara Chaturthi", tone: "moon" },
  abhishekam: { ta: "அபிஷேகம்", en: "Abhishekam", tone: "info" },
  archana: { ta: "அர்ச்சனை", en: "Archana", tone: "info" },
  festival: { ta: "திருவிழா", en: "Festival", tone: "gold" },
  special: { ta: "சிறப்பு பூஜை", en: "Special pooja", tone: "warning" },
  monthly: { ta: "மாதாந்திர பூஜை", en: "Monthly pooja", tone: "default" },
  daily: { ta: "தினசரி பூஜை", en: "Daily pooja", tone: "default" },
};

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const safePooja = (p) => isObject(p) && Number.isInteger(p.id) && p.id > 0 && (typeof p.name_en === "string" || typeof p.name_ta === "string");
const safeSponsor = (d) => isObject(d) && d.type === "sponsor" && typeof d.name === "string" && d.name.trim() !== "";

/** A bilingual field in the reading language, the other one when it is empty. */
const text = (row, field, lang) => {
  const first = row[`${field}_${lang}`];
  const other = row[`${field}_${lang === "ta" ? "en" : "ta"}`];
  return (typeof first === "string" && first.trim()) || (typeof other === "string" && other.trim()) || "";
};

function useSponsorships() {
  const [state, setState] = useState({ poojas: [], sponsors: [], loading: true, error: false });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    Promise.all([getJson("/api/poojas?upcoming=1&sponsorship=1&limit=100"), getJson("/api/donors")]).then(([poojas, donors]) => {
      if (cancelled) return;
      if (!poojas.ok || !Array.isArray(poojas.body)) {
        setState({ poojas: [], sponsors: [], loading: false, error: true });
        return;
      }
      // The thank-you list is worth less than the sponsorships: when it cannot
      // be read the poojas still show and the list is simply empty.
      const sponsors = donors.ok && Array.isArray(donors.body) ? donors.body.filter(safeSponsor) : [];
      setState({ poojas: poojas.body.filter(safePooja), sponsors, loading: false, error: false });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  return { ...state, refresh };
}

function SponsorshipCard({ pooja, lang, t, index, payReady, canPayOnline, officePhone }) {
  const other = lang === "ta" ? "en" : "ta";
  const name = text(pooja, "name", lang);
  const altName = typeof pooja[`name_${other}`] === "string" && pooja[`name_${other}`].trim() !== name ? pooja[`name_${other}`].trim() : "";
  const desc = text(pooja, "description", lang);
  // A type this page does not know gets no label rather than a guessed one.
  const meta = TYPE_META[pooja.type] ?? null;
  const sponsorName = isObject(pooja.sponsor) && typeof pooja.sponsor.name === "string" ? pooja.sponsor.name.trim() : "";
  const amount =
    pooja.sponsorship_amount !== null && pooja.sponsorship_amount !== undefined && Number.isFinite(Number(pooja.sponsorship_amount))
      ? formatMoney(pooja.sponsorship_amount, "INR", lang)
      : "";
  const date = formatPlainDate(pooja.date, lang) || String(pooja.date ?? "");
  const sponsorWord = t("உபயம் அளிக்க", "Sponsor");

  return (
    <li className="card card--static sponsorship-card rise" style={{ "--i": Math.min(index, 10) }} data-testid="sponsorship-item" data-pooja-id={pooja.id}>
      <div className="sponsorship-card__head">
        {meta && <Badge tone={meta.tone}>{t(meta.ta, meta.en)}</Badge>}
        {sponsorName ? (
          <Badge tone="gold" className="sponsorship-card__status" data-status="sponsored">
            <LuHeart aria-hidden="true" /> {t(`உபயம்: ${sponsorName}`, `Sponsored by ${sponsorName}`)}
          </Badge>
        ) : (
          <Badge tone="success" className="sponsorship-card__status" data-status="open">
            {t("உபயத்திற்குத் திறந்துள்ளது", "Open")}
          </Badge>
        )}
      </div>
      <h3 className="sponsorship-card__title">{name}</h3>
      {altName && (
        <p className="sponsorship-card__alt" lang={other}>
          {altName}
        </p>
      )}
      <ul className="sponsorship-card__meta" role="list">
        <li>
          <LuCalendarDays aria-hidden="true" /> <time dateTime={pooja.date}>{date}</time>
        </li>
        {pooja.time && (
          <li>
            <LuClock aria-hidden="true" /> {pooja.time}
          </li>
        )}
      </ul>
      {desc && <p className="sponsorship-card__desc">{desc}</p>}
      <p className="sponsorship-card__amount">
        <span className="sponsorship-card__amount-label">{t("உபயத் தொகை", "Sponsorship amount")}</span>
        <strong>{amount || t("அலுவலகத்தில் கேட்கவும்", "Ask the temple office")}</strong>
      </p>
      {/* Nothing is offered until the gateway has said whether online giving is
          on: a button that changes its destination a moment later is worse
          than one that appears a moment later. */}
      {/* Each control names its pooja after the visible words (WCAG 2.5.3), so a
          list of "Sponsor" links is not a list of identical names. */}
      {payReady && (
        <div className="sponsorship-card__actions">
          {canPayOnline ? (
            <Button
              to={`/donate?pooja=${pooja.id}`}
              variant="primary"
              size="sm"
              icon={<LuHeartHandshake aria-hidden="true" />}
              aria-label={`${sponsorWord} — ${name}`}
              data-testid="sponsor-cta"
            >
              {sponsorWord}
            </Button>
          ) : (
            <>
              <Button
                href={telHref(officePhone)}
                variant="primary"
                size="sm"
                icon={<LuPhone aria-hidden="true" />}
                aria-label={`${t(`உபயம் அளிக்க அழைக்கவும்: ${formatPhone(officePhone)}`, `To sponsor, call ${formatPhone(officePhone)}`)} — ${name}`}
                data-testid="sponsor-cta"
              >
                {t(`உபயம் அளிக்க அழைக்கவும்: ${formatPhone(officePhone)}`, `To sponsor, call ${formatPhone(officePhone)}`)}
              </Button>
              <Button to="/contact" variant="ghost" size="sm" aria-label={`${t("தொடர்பு விவரங்கள்", "Contact details")} — ${name}`}>
                {t("தொடர்பு விவரங்கள்", "Contact details")}
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export default function Sponsorship() {
  const { lang, t } = useLang();
  const { poojas, sponsors, loading, error, refresh } = useSponsorships();
  const { config, loading: payLoading } = usePaymentsConfig();
  const canPayOnline = paymentsUsable(config);
  // The committee's office details (Admin → System → Settings), else the
  // booklet's — the same rule Contact and Home apply.
  const { site } = useSiteSettings();
  const officePhone = siteValue(site, "phone_primary").replace(/^\+91/, "") || PRIMARY_CONTACT.phone;
  const officeEmail = siteValue(site, "email") || TEMPLE_EMAIL;

  // Named once: the hero shows them, <Seo> puts them in the head and the
  // preview card (site_pages.php carries the same strings), and the share
  // sheet passes them on.
  const title = t("பூஜை உபயம்", "Sponsorship");
  const lead = t(
    "வரவிருக்கும் பூஜைகளில் உபயம் அளித்து ஆசி பெறுங்கள்; பெயர் வெளியிட அனுமதி அளித்த உபயதாரர்களுக்கு இங்கே நன்றி.",
    "Sponsor an upcoming pooja and receive the blessings; sponsors who agreed to be named are thanked here.",
  );
  const count = poojas.length;

  return (
    <>
      <Seo title={title} description={lead} />
      <PageHero
        variant="donations"
        eyebrow={t(TEMPLE.name.ta, TEMPLE.name.en)}
        title={title}
        lead={lead}
        crumbs={[{ label: title }]}
        actions={
          <>
            <ShareButton variant="outline-light" title={title} text={lead} to="/sponsorship" />
            <Button to="/sevas" variant="outline-light" icon={<LuSparkles aria-hidden="true" />}>
              {t("சேவை பதிவு", "Book a seva")}
            </Button>
            <Button to="/donations" variant="outline-light" icon={<LuHeartHandshake aria-hidden="true" />}>
              {t("நன்கொடை", "Donate")}
            </Button>
          </>
        }
        aside={
          <div className="sponsorship-hero__office" role="group" aria-label={t("கோயில் அலுவலகம்", "Temple office")}>
            <span className="sponsorship-hero__office-label">{t("உபயம் பற்றி கேட்க", "To ask about a sponsorship")}</span>
            <a href={telHref(officePhone)} data-testid="office-phone">
              <LuPhone aria-hidden="true" /> {formatPhone(officePhone)}
            </a>
            <a href={`mailto:${officeEmail}`}>
              <LuMail aria-hidden="true" /> {officeEmail}
            </a>
          </div>
        }
      />

      <section className="section" aria-labelledby="sponsorship-open-title">
        <div className="container">
          <SectionHeader
            align="left"
            id="sponsorship-open-title"
            eyebrow={t("வரவிருக்கும் பூஜைகள்", "Upcoming poojas")}
            title={t("உபயத்திற்குத் திறந்த பூஜைகள்", "Available sponsorships")}
            subtitle={t(
              "ஒவ்வொரு பூஜையின் தேதி, நேரம், உபயத் தொகை மற்றும் நிலை — கமிட்டி பதிவு செய்தபடி.",
              "Each pooja's date, time, sponsorship amount and status, as the committee has recorded them.",
            )}
          />
          <p role="status" aria-live="polite" className="sponsorship__status">
            {loading
              ? t("ஏற்றுகிறது…", "Loading…")
              : error
                ? t("உபயப் பட்டியலை ஏற்ற முடியவில்லை.", "Couldn't load the sponsorships.")
                : t(
                    count === 1 ? "1 பூஜை உபயத்திற்குத் திறந்துள்ளது" : `${count} பூஜைகள் உபயத்திற்குத் திறந்துள்ளன`,
                    `${count} ${count === 1 ? "pooja" : "poojas"} open for sponsorship`,
                  )}
          </p>
          <div aria-busy={loading}>
            {loading && <SkeletonCards count={3} className="grid-auto sponsorship__grid" />}
            {!loading && error && (
              <ErrorState title={t("உபயப் பட்டியலை ஏற்ற முடியவில்லை", "Couldn't load the sponsorships")} onRetry={refresh} />
            )}
            {!loading && !error && count === 0 && (
              <EmptyState
                icon={<LuHeartHandshake />}
                title={t("தற்போது உபயத்திற்குத் திறந்த பூஜைகள் இல்லை", "No sponsorships are open right now")}
                action={
                  <Button to="/donations" variant="outline" size="sm">
                    {t("நன்கொடை வழிகள்", "Ways to give")}
                  </Button>
                }
              >
                {t(
                  "கமிட்டி ஒரு பூஜையை உபயத்திற்குத் திறக்கும் போது அது இங்கே காண்பிக்கப்படும்.",
                  "When the committee opens a pooja for sponsorship it will be listed here.",
                )}
              </EmptyState>
            )}
            {!loading && !error && count > 0 && (
              <ul className="grid-auto sponsorship__grid" role="list" data-testid="sponsorship-list">
                {poojas.map((pooja, index) => (
                  <SponsorshipCard
                    key={pooja.id}
                    pooja={pooja}
                    lang={lang}
                    t={t}
                    index={index}
                    payReady={!payLoading}
                    canPayOnline={canPayOnline}
                    officePhone={officePhone}
                  />
                ))}
              </ul>
            )}
          </div>
          <p className="sponsorship__note">
            <LuInfo aria-hidden="true" />
            <span>
              {t(
                "உபயதாரரின் பெயர், அவர் அனுமதி அளித்தால் மட்டுமே இணையதளத்தில் வெளியிடப்படும்.",
                "A sponsor's name is published on the website only with their permission.",
              )}
            </span>
          </p>
        </div>
      </section>

      <section className="section section--alt" aria-labelledby="sponsorship-thanks-title">
        <div className="container">
          <SectionHeader
            align="left"
            id="sponsorship-thanks-title"
            eyebrow={t("நன்றி", "With gratitude")}
            title={t("உபயதாரர்கள்", "Our sponsors")}
            subtitle={t("பெயர் வெளியிட அனுமதி அளித்த உபயதாரர்கள் மட்டும்.", "Only sponsors who agreed to be named.")}
          />
          {loading && <SkeletonCards count={2} className="grid-auto sponsorship-thanks__grid" />}
          {!loading && sponsors.length === 0 && (
            <EmptyState compact icon={<LuHeart />} title={t("இன்னும் பெயர்கள் இல்லை", "No names to show yet")}>
              {t(
                "பெயர் வெளியிட அனுமதி அளிக்கும் உபயதாரர்கள் இங்கே நன்றியுடன் குறிப்பிடப்படுவார்கள்.",
                "Sponsors who agree to be named will be thanked here.",
              )}
            </EmptyState>
          )}
          {!loading && sponsors.length > 0 && (
            <ul className="sponsorship-thanks__list" role="list" data-testid="sponsorship-thanks">
              {sponsors.map((s, i) => {
                const poojaTa = isObject(s.pooja) && typeof s.pooja.ta === "string" ? s.pooja.ta.trim() : "";
                const poojaEn = isObject(s.pooja) && typeof s.pooja.en === "string" ? s.pooja.en.trim() : "";
                const pooja = lang === "ta" ? poojaTa || poojaEn : poojaEn || poojaTa;
                // /api/donors sends the committee's public note as `label`, or
                // the pooja's Tamil name when there is no note: only a note is
                // worth a second line.
                const label = typeof s.label === "string" ? s.label.trim() : "";
                const note = label && label !== poojaTa && label !== poojaEn ? label : "";
                return (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={`${s.name}-${i}`} className="card card--static sponsorship-thanks__item rise" style={{ "--i": Math.min(i, 10) }} data-testid="sponsor-thanks-item">
                    <span className="sponsorship-thanks__icon" aria-hidden="true">
                      <LuHeart />
                    </span>
                    <span>
                      <span className="sponsorship-thanks__name">{s.name}</span>
                      {pooja && <span className="sponsorship-thanks__pooja">{pooja}</span>}
                      {note && <span className="sponsorship-thanks__pooja">{note}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}
