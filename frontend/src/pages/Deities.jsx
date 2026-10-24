import { useCallback, useEffect, useState } from "react";
import { LuLandmark, LuSparkles } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import ShareButton from "../components/Share/ShareButton";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import { getJson } from "../lib/payments";
import "./Deities.css";

/*
 * Deities (brief §6 Deities): every deity the committee shows — Admin → Temple
 * → Deities, GET /api/deities — in the committee's display order, each with its
 * Tamil and English name, the description in the reading language and its
 * image. The server already orders the list and leaves hidden deities out;
 * nothing is invented here, so a temple with no deity records yet gets an
 * empty state rather than a built-in list.
 */

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const safeDeity = (d) => isObject(d) && Number.isInteger(d.id) && d.id > 0 && (typeof d.name_ta === "string" || typeof d.name_en === "string");

/** A bilingual field in the reading language, the other one when it is empty. */
const text = (row, field, lang) => {
  const first = row[`${field}_${lang}`];
  const other = row[`${field}_${lang === "ta" ? "en" : "ta"}`];
  return (typeof first === "string" && first.trim()) || (typeof other === "string" && other.trim()) || "";
};

function useDeities() {
  const [state, setState] = useState({ deities: [], loading: true, error: false });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    getJson("/api/deities").then((res) => {
      if (cancelled) return;
      if (res.ok && Array.isArray(res.body)) setState({ deities: res.body.filter(safeDeity), loading: false, error: false });
      else setState({ deities: [], loading: false, error: true });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  return { ...state, refresh };
}

function DeityCard({ deity, lang, index }) {
  const other = lang === "ta" ? "en" : "ta";
  const name = text(deity, "name", lang);
  const altName = typeof deity[`name_${other}`] === "string" && deity[`name_${other}`].trim() !== name ? deity[`name_${other}`].trim() : "";
  const desc = text(deity, "description", lang);
  // A picture the committee named but that cannot be loaded leaves the card
  // (the same rule About.jsx applies), so a broken image never sits above a name.
  const [broken, setBroken] = useState(false);
  const image = typeof deity.image_url === "string" && deity.image_url.trim() !== "" && !broken ? deity.image_url : null;

  return (
    <li className="card card--static deity-card rise" style={{ "--i": Math.min(index, 10) }} data-testid="deity-card" data-deity-id={deity.id}>
      {image ? (
        <figure className="deity-card__media">
          <img src={image} alt={name} loading="lazy" decoding="async" onError={() => setBroken(true)} />
        </figure>
      ) : (
        <span className="deity-card__glyph" aria-hidden="true">
          <LuSparkles />
        </span>
      )}
      <h2 className="deity-card__name">{name}</h2>
      {altName && (
        <p className="deity-card__alt" lang={other}>
          {altName}
        </p>
      )}
      {desc && <p className="deity-card__desc">{desc}</p>}
    </li>
  );
}

export default function Deities() {
  const { lang, t } = useLang();
  const { deities, loading, error, refresh } = useDeities();

  // Named once: the hero shows them, <Seo> puts them in the head and the
  // preview card (site_pages.php carries the same strings), and the share
  // sheet passes them on.
  const title = t("குலதெய்வங்கள்", "Deities");
  const lead = t(
    "கோயிலில் அருள்பாலிக்கும் தெய்வங்கள் — ஒவ்வொருவரின் பெயர், விவரம் மற்றும் திருவுருவப் படம்.",
    "The deities worshipped at the temple — the name, description and image of each.",
  );
  const count = deities.length;

  return (
    <>
      <Seo title={title} description={lead} />
      <PageHero
        variant="about"
        eyebrow={t(TEMPLE.name.ta, TEMPLE.name.en)}
        title={title}
        lead={lead}
        crumbs={[{ label: title }]}
        actions={
          <>
            <ShareButton variant="outline-light" title={title} text={lead} to="/deities" />
            <Button to="/about#history" variant="outline-light" icon={<LuLandmark aria-hidden="true" />}>
              {t("கோயில் வரலாறு", "Temple history")}
            </Button>
            <Button to="/sevas" variant="outline-light" icon={<LuSparkles aria-hidden="true" />}>
              {t("சேவை பதிவு", "Book a seva")}
            </Button>
          </>
        }
      />

      <section className="section">
        <div className="container">
          <p role="status" aria-live="polite" className="deities__status">
            {loading
              ? t("ஏற்றுகிறது…", "Loading…")
              : error
                ? t("தெய்வ விவரங்களை ஏற்ற முடியவில்லை.", "Couldn't load the deities.")
                : t(`${count} ${count === 1 ? "தெய்வம்" : "தெய்வங்கள்"}`, `${count} ${count === 1 ? "deity" : "deities"}`)}
          </p>
          <div aria-busy={loading}>
            {loading && <SkeletonCards count={3} className="grid-auto deities__grid" />}
            {!loading && error && <ErrorState title={t("தெய்வ விவரங்களை ஏற்ற முடியவில்லை", "Couldn't load the deities")} onRetry={refresh} />}
            {!loading && !error && count === 0 && (
              <EmptyState icon={<LuSparkles />} title={t("தெய்வ விவரங்கள் இன்னும் இல்லை", "No deities listed yet")}>
                {t(
                  "கமிட்டி தெய்வ விவரங்களைச் சேர்த்ததும் அவை இங்கே காண்பிக்கப்படும்.",
                  "The deities will appear here once the committee has added their records.",
                )}
              </EmptyState>
            )}
            {!loading && !error && count > 0 && (
              <ol className="grid-auto deities__grid" role="list" data-testid="deities-list">
                {deities.map((deity, index) => (
                  <DeityCard key={deity.id} deity={deity} lang={lang} index={index} />
                ))}
              </ol>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
