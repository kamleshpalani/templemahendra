import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";
import { useLang } from "../context/LangContext";
import { ADDRESS, PRIMARY_CONTACT, TEMPLE, TEMPLE_EMAIL } from "../data/temple";
import { absoluteUrl, siteOrigin } from "../lib/share";
import { seoOverrideFor, siteHours, siteText, siteValue, useSiteSettings } from "../lib/siteSettings";
import { TEMPLE_HOURS } from "../lib/templeTime";

/**
 * Seo — the one place the site's document head is written.
 *
 *   <Seo
 *     title={t("நிகழ்வுகள்", "Events")}
 *     description={lead}
 *     image={nextFestival?.image}
 *     type="article"
 *     jsonLd={eventRecord}
 *   />
 *
 * It sets the title, the description, the canonical link, Open Graph and the
 * Twitter/X card from one set of values, so a page cannot end up with a title
 * that disagrees with its preview. Every value comes from the caller or from
 * TEMPLE; no address and no copy is written here.
 *
 * Pages pass their own visible lead text as `description` — the same sentence
 * the visitor reads is the sentence a shared link shows.
 *
 * Structured data (brief §22): `jsonLd` — one schema.org record or a list of
 * them — is written as <script type="application/ld+json">. The front page
 * needs nothing passed: with no `jsonLd` it carries the temple's own
 * HinduTemple record (templeJsonLd), built from the committee's settings and
 * data/temple.js and nothing else.
 *
 * One caveat worth knowing: WhatsApp, Facebook and LinkedIn read the HTML the
 * server returns and never run JavaScript, so these tags are for browsers,
 * search engines and anything that does. What those crawlers see is rendered by
 * backend/api/og.php, which is fed from the same database as the page and
 * writes the same records.
 */

/**
 * What a preview falls back to when the page has no image of its own: the
 * sanctum photograph if the committee has uploaded it, otherwise the app icon,
 * which ships with the build and is therefore always there.
 */
export const SHARE_IMAGE_FALLBACK = TEMPLE.photoSrc;
export const SHARE_IMAGE_LAST_RESORT = "/icons/temple-share-20261025.png";

/* ── Structured data ─────────────────────────────────────────────────────── */

/**
 * JSON for the inside of a <script type="application/ld+json">. Helmet writes
 * it as raw markup, so the browser's HTML parser sees it before any JSON
 * parser does — and that parser ends a script at the first "</script" no
 * matter what quotes surround it. A stored title such as
 * `Pooja</script><script>alert(1)</script>` would otherwise close the block
 * and run. "</" and "<!--" are therefore written as JSON escapes, which every
 * JSON reader turns back into the same characters.
 */
export function jsonLdText(data) {
  return JSON.stringify(data)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\u0021--");
}

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const clock = ([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** The name the committee gave the temple in `lang`, else the printed one. */
export function templeName(site, lang) {
  return siteText(site, "temple_name", lang) || (lang === "ta" ? TEMPLE.name.ta : TEMPLE.name.en);
}

/**
 * The temple's postal address as schema.org takes it: the committee's own
 * text when they typed one (Admin → System → Settings), else the printed
 * address from data/temple.js as a PostalAddress in the reading language.
 */
export function templeAddress(site, lang) {
  const typed = siteText(site, "temple_address", lang);
  if (typed) return typed.replace(/\s*\n+\s*/g, ", ");
  const L = (v) => (lang === "ta" ? v.ta : v.en);
  return {
    "@type": "PostalAddress",
    streetAddress: L(ADDRESS.street),
    addressLocality: `${L(ADDRESS.village)}, ${L(ADDRESS.taluk)}, ${L(ADDRESS.district)}`,
    addressRegion: L(ADDRESS.state),
    postalCode: ADDRESS.pin,
    addressCountry: "IN",
  };
}

/** The temple as a place — where every event and broadcast happens. */
export function templePlace(site, lang) {
  return { "@type": "HinduTemple", name: templeName(site, lang), address: templeAddress(site, lang) };
}

/**
 * The front page's record: the temple as a schema.org HinduTemple. Name,
 * address, telephone, e-mail, opening hours and social links are the
 * committee's settings, else the constants the site already prints; nothing
 * is stated here that the site does not state somewhere visible.
 */
export function templeJsonLd(site, lang, { url, image, description } = {}) {
  const other = lang === "ta" ? "en" : "ta";
  const name = templeName(site, lang);
  const alternateName = templeName(site, other);
  const windows = siteHours(site) || TEMPLE_HOURS.map((w) => ({ open: clock(w.open), close: clock(w.close) }));
  const sameAs = ["social_youtube", "social_facebook", "social_instagram", "social_whatsapp"]
    .map((key) => siteValue(site, key).trim())
    .filter((v) => /^https:\/\//i.test(v));
  const record = {
    "@context": "https://schema.org",
    "@type": "HinduTemple",
    name,
  };
  if (alternateName && alternateName !== name) record.alternateName = alternateName;
  if (description) record.description = description;
  if (url) record.url = url;
  if (image) record.image = image;
  record.telephone = siteValue(site, "phone_primary") || `+91${PRIMARY_CONTACT.phone}`;
  record.email = siteValue(site, "email") || TEMPLE_EMAIL;
  record.address = templeAddress(site, lang);
  record.openingHoursSpecification = windows.map((w) => ({
    "@type": "OpeningHoursSpecification",
    dayOfWeek: WEEK,
    opens: w.open,
    closes: w.close,
  }));
  if (sameAs.length) record.sameAs = sameAs;
  return record;
}

/* ── The component ───────────────────────────────────────────────────────── */

function usePreviewImage(image) {
  const preferred = image || SHARE_IMAGE_FALLBACK || SHARE_IMAGE_LAST_RESORT;
  const remote = /^https:\/\//i.test(preferred);
  const [resolved, setResolved] = useState(null);
  useEffect(() => {
    if (remote) return;
    let active = true;
    const candidates = [...new Set([preferred, SHARE_IMAGE_FALLBACK, SHARE_IMAGE_LAST_RESORT].filter(Boolean))];
    const probe = new Image();
    const next = () => {
      const candidate = candidates.shift();
      if (!active || !candidate) return;
      probe.onload = () => { if (active) setResolved({ preferred, url: candidate }); };
      probe.onerror = next;
      probe.src = absoluteUrl(candidate);
    };
    next();
    return () => { active = false; probe.onload = null; probe.onerror = null; };
  }, [preferred, remote]);
  return absoluteUrl(remote ? preferred : resolved?.preferred === preferred ? resolved.url : SHARE_IMAGE_LAST_RESORT);
}

export default function Seo({
  title: pageTitle,
  description: pageDescription,
  image: pageImage,
  imageAlt,
  type = "website",
  /**
   * A robots directive, when this page needs one. A results list is not a
   * destination but its links are worth following ("noindex, follow"). Left
   * unset, the site-wide default applies and nothing is emitted — which is what
   * every public page wants, the family registration form included, since the
   * committee shares that link.
   */
  robots: pageRobots,
  canonicalPath,
  /**
   * schema.org record(s) for this page, or null for none. Left undefined, the
   * front page gets the temple's HinduTemple record and every other page
   * gets nothing.
   */
  jsonLd,
  children,
}) {
  const { lang, t } = useLang();
  const { pathname, search } = useLocation();

  // Admin → System → SEO: the committee's title, description, preview image
  // and "keep out of search engines" for this exact address win over the
  // page's own values, field by field. The same table feeds api/og.php, so
  // a crawler and a browser read the same words.
  const { site, seo } = useSiteSettings();
  const override = seoOverrideFor(seo, pathname);
  const other = lang === "ta" ? "en" : "ta";
  const ovTitle = override ? override[`title_${lang}`] || override[`title_${other}`] || "" : "";
  const ovDescription = override ? override[`description_${lang}`] || override[`description_${other}`] || "" : "";
  const title = ovTitle || pageTitle;
  const description = ovDescription || pageDescription;
  const image = (override && override.og_image) || pageImage;
  const robots = override && override.noindex ? "noindex, nofollow" : pageRobots;

  const siteName = siteText(site, "temple_name", lang) || t(TEMPLE.name.ta, TEMPLE.name.en);
  // The site name is the title on the home page and the suffix everywhere else.
  const docTitle = title ? `${title} — ${siteName}` : siteName;
  // The query string stays in: on /search it is what is on screen, and it is
  // what the visitor expects the link they share to reopen.
  const url = siteOrigin() + (canonicalPath ?? pathname + (search || ""));
  const preview = usePreviewImage(image);

  const structured = jsonLd !== undefined
    ? jsonLd
    : pathname === "/" ? templeJsonLd(site, lang, { url, image: preview, description }) : null;
  const records = (Array.isArray(structured) ? structured : [structured]).filter((r) => r && typeof r === "object");

  return (
    <Helmet>
      <title>{docTitle}</title>
      {description && <meta name="description" content={description} />}
      <link rel="canonical" href={url} />
      {robots && <meta name="robots" content={robots} />}

      {/* Open Graph — WhatsApp, Facebook, LinkedIn, Telegram, Slack, Discord */}
      <meta property="og:type" content={type} />
      <meta property="og:site_name" content={siteName} />
      <meta property="og:locale" content={lang === "en" ? "en_IN" : "ta_IN"} />
      <meta property="og:title" content={title || siteName} />
      {description && <meta property="og:description" content={description} />}
      <meta property="og:url" content={url} />
      <meta property="og:image" content={preview} />
      <meta property="og:image:alt" content={imageAlt || t(TEMPLE.photoAlt.ta, TEMPLE.photoAlt.en)} />

      {/* Twitter/X. summary_large_image is the wide card; X falls back to a
          small one on its own when the image is too small for it. */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title || siteName} />
      {description && <meta name="twitter:description" content={description} />}
      <meta name="twitter:image" content={preview} />
      <meta name="twitter:image:alt" content={imageAlt || t(TEMPLE.photoAlt.ta, TEMPLE.photoAlt.en)} />

      {/* Structured data (brief §22) — see jsonLdText for why it is escaped. */}
      {records.map((record, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <script key={`ld-${i}`} type="application/ld+json">{jsonLdText(record)}</script>
      ))}

      {children}
    </Helmet>
  );
}
