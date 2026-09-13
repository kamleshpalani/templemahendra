import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { LuChevronLeft, LuChevronRight, LuImages, LuMaximize2, LuX } from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import PageHero from "../components/ui/PageHero";
import Seo from "../components/Seo";
import ShareButton from "../components/Share/ShareButton";
import SectionHeader from "../components/ui/SectionHeader";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
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

/** Where a photo's file actually lives. One definition, used by the tile, the lightbox and the share preview. */
const photoSrc = (img) => (img ? `/uploads/${img.filename}` : undefined);

export default function Gallery() {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(null); // index into `images`, or null
  const { t } = useLang();
  const [params, setParams] = useSearchParams();

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

  /*
   * ?photo=<id> makes one photograph a link someone can send. Two effects, one
   * each way, and they must not fight.
   *
   * The id is captured at the first render, before either effect can touch the
   * URL: the photos arrive from the API a moment later, and reading the
   * parameter only then would race the write that keeps the address bar in step.
   */
  const wantedPhoto = useRef(params.get("photo"));
  const deepLinkDone = useRef(false);

  // URL → lightbox, once the photos are in. Matched on the id rather than a
  // position, so the link survives new uploads reordering the grid.
  useEffect(() => {
    if (deepLinkDone.current || images.length === 0) return;
    deepLinkDone.current = true;
    const i = images.findIndex((img) => String(img.id) === wantedPhoto.current);
    if (i >= 0) setLightbox(i);
  }, [images]);

  /*
   * lightbox → URL, so the address bar always names what is on screen and can be
   * copied straight out of it. Skipped on the first run, where the URL is the
   * truth. `images` and setParams are read through refs: photos arriving must
   * not trigger a write, and react-router hands back a new setParams whenever
   * the location changes, which as a dependency would make this effect undo its
   * own work.
   */
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const id = lightbox != null ? imagesRef.current[lightbox]?.id : null;
    setParamsRef.current(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("photo", String(id));
        else next.delete("photo");
        return next;
      },
      // replace, not push: opening three photos in a row should not leave three
      // entries for the Back button to walk through.
      { replace: true },
    );
  }, [lightbox]);

  const current = open ? images[lightbox] : null;
  const total = images.length;
  const photoLabel = (img) => img?.caption || t("கோயில் புகைப்படம்", "Temple photo");
  const heading = t("புகைப்பட தொகுப்பு", "Photo Gallery");
  const lead = t(
    "திருவிழாக்கள், பூஜைகள் மற்றும் கோயில் நிகழ்வுகளின் தருணங்கள்.",
    "Moments from festivals, poojas and temple gatherings.",
  );

  return (
    <>
      {/* Whichever photograph is open is the one a shared link previews; with
          none open, the newest upload stands for the gallery. */}
      <Seo
        title={current ? photoLabel(current) : t("தொகுப்பு", "Gallery")}
        description={current?.caption || lead}
        image={photoSrc(current || images[0])}
        imageAlt={current ? photoLabel(current) : undefined}
      />

      <PageHero
        variant="gallery"
        eyebrow={t("தொகுப்பு", "Gallery")}
        title={heading}
        lead={lead}
        crumbs={[{ label: t("தொகுப்பு", "Gallery") }]}
        actions={<ShareButton variant="outline-light" title={heading} text={lead} to="/gallery" />}
        aside={
          !loading && total > 0 ? (
            <Badge tone="on-dark" size="lg">
              <LuImages aria-hidden="true" />
              {t(`${total} புகைப்படங்கள்`, `${total} photos`)}
            </Badge>
          ) : null
        }
      />

      <section className="section">
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
                    <img src={photoSrc(img)} alt={img.caption || ""} loading="lazy" decoding="async" />
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

      {current &&
        createPortal(
          // Portalled: this page sits inside the transform-animated page wrapper,
          // which would otherwise become the containing block for this fixed
          // overlay and drop the lightbox somewhere off-screen.
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
              {/* Shares this photograph, not the gallery: ?photo=<id> reopens it
                  on whatever device the link is sent to. */}
              <ShareButton
                variant="outline-light"
                className="gallery-lightbox__share"
                title={photoLabel(current)}
                text={current.caption || lead}
                to={`/gallery?photo=${current.id}`}
              />
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
                  src={photoSrc(current)}
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
          </div>,
          document.body,
        )}
    </>
  );
}
