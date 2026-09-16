import { Fragment } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LuArrowRight,
  LuCalendarCheck,
  LuCircleCheck,
  LuMail,
  LuMapPin,
  LuPhone,
  LuScrollText,
  LuShieldCheck,
  LuTruck,
  LuUndo2,
} from "react-icons/lu";
import { useLang } from "../context/LangContext";
import {
  TRUST,
  ADDRESS,
  PRIMARY_CONTACT,
  SECONDARY_CONTACT,
  TEMPLE_EMAIL,
  formatPhone,
  telHref,
} from "../data/temple";
import { POLICIES, POLICY_ORDER } from "../data/policies";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Seo from "../components/Seo";
import NotFound from "./NotFound";
import "./PageCommon.css";
import "./Policy.css";

/**
 * Policy — the four legal pages (docs/payments/SPEC.md §7.1, §7.8):
 *   /privacy-policy              <Policy slug="privacy" />
 *   /terms-and-conditions        <Policy slug="terms" />
 *   /refund-cancellation-policy  <Policy slug="refunds" />
 *   /shipping-delivery-policy    <Policy slug="shipping" />
 *
 * The words live in data/policies.js; every fact about the Trust comes from
 * data/temple.js. The <Seo> title and description are the policy's title and
 * lead, copied into backend/includes/site_pages.php for link previews.
 *
 * Sections are rendered as flat h2 + content inside .page-prose (no wrapper
 * per section), so the prose rhythm and `h2:first-child` rule apply as on About.
 */

const ICONS = {
  privacy: LuShieldCheck,
  terms: LuScrollText,
  refunds: LuUndo2,
  shipping: LuTruck,
};

const CONTACTS = [PRIMARY_CONTACT, SECONDARY_CONTACT];

/** One block of policy text: a paragraph, a list, or links to other policies. */
function Block({ block, t }) {
  if (block.type === "ul" || block.type === "ol") {
    const List = block.type;
    return (
      <List>
        {block.items.map((item) => (
          <li key={item.en}>{t(item.ta, item.en)}</li>
        ))}
      </List>
    );
  }
  if (block.type === "links") {
    return (
      <div className="policy-links">
        {block.items.map((link) => (
          <Button
            key={link.to}
            variant="soft"
            size="sm"
            to={link.to}
            trailingIcon={<LuArrowRight aria-hidden="true" />}
          >
            {t(link.ta, link.en)}
          </Button>
        ))}
      </div>
    );
  }
  return <p>{t(block.ta, block.en)}</p>;
}

export default function Policy({ slug }) {
  const { lang, t } = useLang();
  const { hash } = useLocation();
  const policy = POLICIES[slug];
  if (!policy) return <NotFound />;

  const title = t(policy.title.ta, policy.title.en);
  const lead = t(policy.lead.ta, policy.lead.en);
  const updated = new Intl.DateTimeFormat(lang === "ta" ? "ta-IN" : "en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${policy.updated}T00:00:00Z`));

  const toc = [
    ...policy.sections.map(({ id, nav }) => ({ id, nav })),
    { id: "contact", nav: { ta: "தொடர்புக்கு", en: "Contact us" } },
  ];
  const others = POLICY_ORDER.filter((key) => key !== slug);

  return (
    <>
      <Seo title={title} description={lead} type="article" />

      <PageHero
        className="policy-hero"
        eyebrow={t(`தர்ம அறக்கட்டளை · பதிவு எண் ${TRUST.bank.regNo}`, `Dharma Trust · Reg. No. ${TRUST.bank.regNo}`)}
        title={title}
        lead={lead}
        crumbs={[{ label: title }]}
      >
        <p className="page-hero__lead policy-hero__updated">
          <LuCalendarCheck aria-hidden="true" />
          <span>
            {t("கடைசியாகப் புதுப்பிக்கப்பட்டது", "Last updated")}{" "}
            <time dateTime={policy.updated}>{updated}</time>
          </span>
        </p>
      </PageHero>

      <section className="section section--tight policy">
        <div className="container container--narrow page-prose">
          {/* ── Table of contents ─────────────────────────────────── */}
          <nav className="policy-toc" aria-labelledby="policy-toc-title">
            <p id="policy-toc-title" className="policy-toc__title">
              {t("இந்தப் பக்கத்தில்", "On this page")}
            </p>
            <ul className="policy-toc__list" role="list">
              {toc.map(({ id, nav }) => (
                <li key={id}>
                  <Link
                    to={`#${id}`}
                    className="chip policy-toc__chip"
                    aria-current={hash === `#${id}` ? "location" : undefined}
                  >
                    {t(nav.ta, nav.en)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* ── In short ──────────────────────────────────────────── */}
          <div className="card card--solid card--static policy-glance">
            <h2 className="policy-glance__title">{t("சுருக்கமாக", "In short")}</h2>
            <ul className="policy-glance__list" role="list">
              {policy.glance.map((item) => (
                <li key={item.en} className="policy-glance__item">
                  <LuCircleCheck aria-hidden="true" />
                  <span>{t(item.ta, item.en)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ── Sections ──────────────────────────────────────────── */}
          {policy.sections.map((section) => (
            <Fragment key={section.id}>
              <h2 id={section.id}>{t(section.heading.ta, section.heading.en)}</h2>
              {section.blocks.map((block, i) => (
                <Block key={`${section.id}-${i}`} block={block} t={t} />
              ))}
            </Fragment>
          ))}

          {/* ── Contact (same card on every policy) ───────────────── */}
          <h2 id="contact">{t("தொடர்புக்கு", "Contact us")}</h2>
          <p>{t(policy.contactIntro.ta, policy.contactIntro.en)}</p>
          <address className="card card--solid card--static policy-contact">
            <span className="policy-contact__name">{t(TRUST.name.ta, TRUST.name.en)}</span>
            <span className="policy-contact__meta">
              {t(
                `பதிவு எண் ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · பான் ${TRUST.bank.pan}`,
                `Reg. No. ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · PAN ${TRUST.bank.pan}`,
              )}
            </span>
            <ul className="policy-contact__list" role="list">
              <li className="policy-contact__row">
                <LuMapPin aria-hidden="true" />
                <span>{t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en)}</span>
              </li>
              {CONTACTS.map((c) => (
                <li key={c.phone} className="policy-contact__row">
                  <LuPhone aria-hidden="true" />
                  <span>
                    <a href={telHref(c.phone)} className="policy-contact__tel">
                      {formatPhone(c.phone)}
                    </a>
                    <span className="policy-contact__role">
                      {t(c.role.ta, c.role.en)} – {t(c.name.ta, c.name.en)}
                    </span>
                  </span>
                </li>
              ))}
              <li className="policy-contact__row">
                <LuMail aria-hidden="true" />
                <a href={`mailto:${TEMPLE_EMAIL}`}>{TEMPLE_EMAIL}</a>
              </li>
            </ul>
          </address>

          {/* ── The other three policies ──────────────────────────── */}
          <nav className="policy-related" aria-labelledby="policy-related-title">
            <p id="policy-related-title" className="policy-related__title">
              {t("மற்ற கொள்கைகள்", "Other policies")}
            </p>
            <ul className="policy-related__list" role="list">
              {others.map((key) => {
                const Icon = ICONS[key];
                const other = POLICIES[key];
                return (
                  <li key={key}>
                    <Button variant="soft" size="sm" to={other.path} icon={<Icon aria-hidden="true" />}>
                      {t(other.title.ta, other.title.en)}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </div>
      </section>
    </>
  );
}
