import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { LuChevronLeft, LuChevronRight, LuImages, LuMaximize2, LuX } from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import PageHero from "../components/ui/PageHero";
import SectionHeader from "../components/ui/SectionHeader";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import { TEMPLE } from "../data/temple";
import useDialogBehaviour from "../hooks/useDialogBehaviour";
import "./Gallery.css";

/** Bento rhythm for the masonry-ish grid: every 8th tile is a 2×2 feature, with a tall and a wide accent between. */
const tileShape = (i) => {
  const k = i % 8;
  if (k === 0) return "gallery-tile--feature";
  if (k === 3) return "gallery-tile--tall";
  if (k === 5) return "gallery-tile--wide";
  return "";
};

export default function Gallery() {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(null); // index into `images`, or null
  const { t } = useLang();

  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const countRef = useRef(0);
  countRef.current = images.length;

  // Same request as before; a rejection is now surfaced as an error state
  // instead of being swallowed into a misleading "no photos yet".
  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    api
      .get("/gallery")
      .then((r) => setImages(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const open = lightbox != null;
  const close = useCallback(() => setLightbox(null), []);
  const prev = useCallback(() => setLightbox((i) => (i == null ? i : (i - 1 + countRef.current) % countRef.current)), []);
  const next = useCallback(() => setLightbox((i) => (i == null ? i : (i + 1) % countRef.current)), []);

  // Lightbox-only keys; scroll lock, Escape, Tab trap and focus return come from the shared dialog hook.
  const onLightboxKey = useCallback(
    (e) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        next();
      }
    },
    [prev, next],
  );
  useDialogBehaviour({ open, onClose: close, panelRef: dialogRef, initialFocusRef: closeRef, onKey: onLightboxKey });

  const current = open ? images[lightbox] : null;
  const total = images.length;
  const photoLabel = (img) => img?.caption || t("கோயில் புகைப்படம்", "Temple photo");

  return (
    <>
      <Helmet>
        <title>
          {t("தொகுப்பு", "Gallery")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <PageHero
        variant="gallery"
        eyebrow={t("தொகுப்பு", "Gallery")}
        title={t("புகைப்பட தொகுப்பு", "Photo Gallery")}
        lead={t(
          "திருவிழாக்கள், பூஜைகள் மற்றும் கோயில் நிகழ்வுகளின் தருணங்கள்.",
          "Moments from festivals, poojas and temple gatherings.",
        )}
        crumbs={[{ label: t("தொகுப்பு", "Gallery") }]}
        aside={
          !loading && total > 0 ? (
            <Badge tone="on-dark" size="lg">
              <LuImages aria-hidden="true" />
              {t(`${total} புகைப்படங்கள்`, `${total} photos`)}
            </Badge>
          ) : null
        }
      />

      <section className="section gallery">
        <div className="container">
          <SectionHeader
            eyebrow={t("தொகுப்பு", "Gallery")}
            title={t("கோயில் புகைப்படங்கள்", "Temple photographs")}
            subtitle={
              total > 0
                ? t("பெரிதாக்கிப் பார்க்க ஒரு புகைப்படத்தைத் தட்டவும்.", "Tap any photo to view it full size.")
                : undefined
            }
          />

          {loading ? (
            <>
              <span className="sr-only" role="status" aria-live="polite">
                {t("புகைப்படங்கள் ஏற்றப்படுகிறது…", "Loading photos…")}
              </span>
              <SkeletonCards count={8} className="grid-auto gallery-grid gallery-grid--skeleton" />
            </>
          ) : failed ? (
            <ErrorState
              title={t("புகைப்படங்களை ஏற்ற முடியவில்லை", "Couldn't load the gallery")}
              onRetry={load}
            >
              {t(
                "இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.",
                "Check your connection and try again.",
              )}
            </ErrorState>
          ) : total === 0 ? (
            <EmptyState icon={<LuImages />} title={t("புகைப்படங்கள் விரைவில் வரும்!", "Photos coming soon")}>
              {t("அடுத்த திருவிழாவுக்குப் பிறகு மீண்டும் பார்க்கவும்.", "Check back after the next festival!")}
            </EmptyState>
          ) : (
            <div className="grid-auto gallery-grid" role="list">
              {images.map((img, i) => (
                <div
                  key={img.id}
                  role="listitem"
                  className={`gallery-cell rise ${tileShape(i)}`.trim()}
                  style={{ "--i": Math.min(i, 11) }}
                >
                  <button
                    type="button"
                    className="card gallery-tile"
                    onClick={() => setLightbox(i)}
                    aria-label={`${photoLabel(img)} — ${t("பெரிதாக்கு", "Enlarge")}`}
                  >
                    <img src={`/uploads/${img.filename}`} alt={img.caption || ""} loading="lazy" decoding="async" />
                    <span className="gallery-tile__overlay" aria-hidden="true">
                      <span className="gallery-tile__zoom">
                        <LuMaximize2 />
                      </span>
                      {img.caption && <span className="gallery-tile__caption">{img.caption}</span>}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {current && (
        <div
          className="gallery-lightbox"
          data-surface="dark"
          onMouseDown={(e) => e.target === e.currentTarget && close()}
        >
          <div
            ref={dialogRef}
            className="gallery-lightbox__dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${photoLabel(current)} — ${t(`${lightbox + 1} / ${total}`, `${lightbox + 1} of ${total}`)}`}
            onMouseDown={(e) => e.target === e.currentTarget && close()}
          >
            <div className="gallery-lightbox__bar">
              <Badge tone="on-dark" className="gallery-lightbox__count">
                <LuImages aria-hidden="true" />
                {lightbox + 1} / {total}
              </Badge>
              <Button
                ref={closeRef}
                variant="outline-light"
                iconOnly
                className="gallery-lightbox__close"
                icon={<LuX aria-hidden="true" />}
                onClick={close}
              >
                {t("மூடு", "Close")}
              </Button>
            </div>

            <div className="gallery-lightbox__stage" onMouseDown={(e) => e.target === e.currentTarget && close()}>
              {total > 1 && (
                <Button
                  variant="outline-light"
                  iconOnly
                  className="gallery-lightbox__nav gallery-lightbox__nav--prev"
                  icon={<LuChevronLeft aria-hidden="true" />}
                  onClick={prev}
                >
                  {t("முந்தைய புகைப்படம்", "Previous photo")}
                </Button>
              )}

              <figure className="gallery-lightbox__figure" key={current.id}>
                <img
                  className="gallery-lightbox__img"
                  src={`/uploads/${current.filename}`}
                  alt={current.caption || ""}
                  decoding="async"
                />
                {current.caption && <figcaption className="gallery-lightbox__caption">{current.caption}</figcaption>}
              </figure>

              {total > 1 && (
                <Button
                  variant="outline-light"
                  iconOnly
                  className="gallery-lightbox__nav gallery-lightbox__nav--next"
                  icon={<LuChevronRight aria-hidden="true" />}
                  onClick={next}
                >
                  {t("அடுத்த புகைப்படம்", "Next photo")}
                </Button>
              )}
            </div>

            <span className="sr-only" role="status" aria-live="polite">
              {t(`புகைப்படம் ${lightbox + 1} / ${total}`, `Photo ${lightbox + 1} of ${total}`)}
              {current.caption ? ` — ${current.caption}` : ""}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
