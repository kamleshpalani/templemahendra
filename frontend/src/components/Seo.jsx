import { Helmet } from "react-helmet-async";
import { useLocation } from "react-router-dom";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import { absoluteUrl, siteOrigin } from "../lib/share";

/**
 * Seo — the one place the site's document head is written.
 *
 *   <Seo
 *     title={t("நிகழ்வுகள்", "Events")}
 *     description={lead}
 *     image={nextFestival?.image}
 *     type="article"
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
 * One caveat worth knowing: WhatsApp, Facebook and LinkedIn read the HTML the
 * server returns and never run JavaScript, so these tags are for browsers,
 * search engines and anything that does. What those crawlers see is rendered by
 * backend/api/og.php, which is fed from the same database as the page.
 */

/**
 * What a preview falls back to when the page has no image of its own: the
 * sanctum photograph if the committee has uploaded it, otherwise the app icon,
 * which ships with the build and is therefore always there.
 */
export const SHARE_IMAGE_FALLBACK = TEMPLE.photoSrc;
export const SHARE_IMAGE_LAST_RESORT = "/icons/icon-512x512.png";

export default function Seo({
  title,
  description,
  image,
  imageAlt,
  type = "website",
  /**
   * A robots directive, when this page needs one. Account pages are per-person
   * ("noindex, nofollow"); a results list is not a destination but its links are
   * worth following ("noindex, follow"). Left unset, the site-wide default
   * applies and nothing is emitted.
   */
  robots,
  children,
}) {
  const { lang, t } = useLang();
  const { pathname, search } = useLocation();

  const siteName = t(TEMPLE.name.ta, TEMPLE.name.en);
  // The site name is the title on the home page and the suffix everywhere else.
  const docTitle = title ? `${title} — ${siteName}` : siteName;
  // The query string stays in: on /search it is what is on screen, and it is
  // what the visitor expects the link they share to reopen.
  const url = siteOrigin() + pathname + (search || "");
  const preview = absoluteUrl(image || SHARE_IMAGE_FALLBACK || SHARE_IMAGE_LAST_RESORT);

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

      {children}
    </Helmet>
  );
}
