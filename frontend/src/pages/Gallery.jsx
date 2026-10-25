import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { LuChevronLeft, LuChevronRight, LuImages, LuMaximize2, LuVideo, LuX } from "react-icons/lu";
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

/**
 * The grid's image sources (brief §34). The API answers a ~480 px `thumb_url`
 * and a ~1280 px `medium_url` for every photo uploaded since migration 021;
 * older rows carry the original in both, in which case there is one candidate
 * and no srcset. The `sizes` hint follows the tile: a feature or wide tile is
 * two columns, everything else one, and on a phone the grid is two across.
 */
const SIZES_WIDE = "(max-width: 640px) 100vw, (max-width: 1024px) 60vw, 520px";
const SIZES_TILE = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 260px";
const srcSetOf = (img) =>
  img.thumb_url && img.medium_url && img.thumb_url !== img.medium_url && img.thumb_width && img.medium_width
    ? `${img.thumb_url} ${img.thumb_width}w, ${img.medium_url} ${img.medium_width}w`
    : undefined;
const scaledHeight = (img, width) => (img.width && img.height && width ? Math.round((img.height * width) / img.width) : undefined);

/** Where a photo's file actually lives. The original, for a first-release row without variants. */
const photoSrc = (img) => (img ? img.url || `/uploads/${img.filename}` : undefined);
const thumbSrc = (img) => (img ? img.thumb_url || photoSrc(img) : undefined);
const mediumSrc = (img) => (img ? img.medium_url || photoSrc(img) : undefined);

const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export default function Gallery() {
  const [images, setImages] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [lightbox, setLightbox] = useState(null); // index into `shown`, or null
  const { t } = useLang();
  const [params, setParams] = useSearchParams();

  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const countRef = useRef(0);

  // Photos and albums in one go; a rejection is surfaced as an error state
  // instead of being swallowed into a misleading "no photos yet". The album
  // list is optional: a server without migration 021 answers 404 and the
  // page simply shows no chips.
  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    Promise.all([api.get("/gallery"), api.get("/gallery/albums").catch(() => ({ data: [] }))])
      .then(([g, a]) => {
        setImages(Array.isArray(g.data) ? g.data.filter(isObject) : []);
        setAlbums(Array.isArray(a.data) ? a.data.filter((x) => isObject(x) && SLUG.test(x.slug || "")) : []);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * ?album=<slug> opens one album — a link the committee can send after a
   * festival. An unknown slug shows everything rather than an empty page.
   */
  const rawAlbum = params.get("album") || "";
  const album = useMemo(() => (SLUG.test(rawAlbum) ? albums.find((a) => a.slug === rawAlbum) || null : null), [albums, rawAlbum]);
  const shown = useMemo(() => (album ? images.filter((img) => img.album_id === album.id) : images), [images, album]);
  countRef.current = shown.length;

  const pickAlbum = (slug) => {
    const next = new URLSearchParams(params);
    if (slug) next.set("album", slug);
    else next.delete("album");
    // A photo open in another album has no place in this one.
    next.delete("photo");
    setLightbox(null);
    setParams(next, { state: { preserveScroll: true } });
  };

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
    if (deepLinkDone.current || shown.length === 0) return;
    deepLinkDone.current = true;
    const i = shown.findIndex((img) => String(img.id) === wantedPhoto.current);
    if (i >= 0) setLightbox(i);
  }, [shown]);

  /*
   * lightbox → URL, so the address bar always names what is on screen and can be
   * copied straight out of it. Skipped on the first run, where the URL is the
   * truth. `shown` and setParams are read through refs: photos arriving must
   * not trigger a write, and react-router hands back a new setParams whenever
   * the location changes, which as a dependency would make this effect undo its
   * own work.
   */
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // A new ?photo= while the gallery is already open (a search result for a
  // photo, a shared link followed from the same tab) opens that photo too;
  // the address the lightbox itself writes is recognised and left alone.
  const photoParam = params.get("photo");
  const lightboxRef = useRef(lightbox);
  lightboxRef.current = lightbox;
  useEffect(() => {
    if (!deepLinkDone.current || !photoParam) return;
    const open = lightboxRef.current != null ? String(shownRef.current[lightboxRef.current]?.id ?? "") : "";
    if (open === photoParam) return;
    const i = shownRef.current.findIndex((img) => String(img.id) === photoParam);
    if (i >= 0) setLightbox(i);
  }, [photoParam]);
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const id = lightbox != null ? shownRef.current[lightbox]?.id : null;
    setParamsRef.current(
      (prevParams) => {
        const nextParams = new URLSearchParams(prevParams);
        if (id) nextParams.set("photo", String(id));
        else nextParams.delete("photo");
        return nextParams;
      },
      // replace, not push: opening three photos in a row should not leave three
      // entries for the Back button to walk through.
      { replace: true },
    );
  }, [lightbox]);

  const current = open ? shown[lightbox] : null;
  const total = shown.length;
  const allCount = images.length;
  // Alternative text (brief §22): the committee's description in the visitor's
  // language, else the other language's, else the caption. Never the file name.
  const altOf = (img) => (img ? t(img.alt_ta, img.alt_en) || img.alt_en || img.alt_ta || img.caption || "" : "");
  const photoLabel = (img) => img?.caption || altOf(img) || t("கோயில் புகைப்படம்", "Temple photo");
  const albumTitle = (a) => (a ? t(a.title_ta, a.title_en) || a.title_en || a.title_ta : "");
  const heading = t("புகைப்பட தொகுப்பு", "Photo Gallery");
  const lead = t(
    "திருவிழாக்கள், பூஜைகள் மற்றும் கோயில் நிகழ்வுகளின் தருணங்கள்.",
    "Moments from festivals, poojas and temple gatherings.",
  );
  const albumLead = album ? t(album.description_ta, album.description_en) || album.description_en || album.description_ta || "" : "";
  const shareTo = album ? `/gallery?album=${encodeURIComponent(album.slug)}` : "/gallery";

  return (
    <>
      {/* Whichever photograph is open is the one a shared link previews; with
          none open, the album's cover or the newest upload stands for the page. */}
      <Seo
        title={current ? photoLabel(current) : album ? albumTitle(album) : t("தொகுப்பு", "Gallery")}
        description={current?.caption || albumLead || lead}
        image={mediumSrc(current || shown[0])}
        imageAlt={current ? altOf(current) || photoLabel(current) : undefined}
      />

      <PageHero
        variant="gallery"
        eyebrow={t("தொகுப்பு", "Gallery")}
        title={heading}
        lead={lead}
        crumbs={[{ label: t("தொகுப்பு", "Gallery") }]}
        actions={<>
          <ShareButton variant="outline-light" title={album ? albumTitle(album) : heading} text={albumLead || lead} to={shareTo} />
          <Button to="/videos" variant="outline-light" icon={<LuVideo aria-hidden="true" />}>{t("காணொளிகள்", "Videos")}</Button>
        </>}
        aside={
          !loading && allCount > 0 ? (
            <Badge tone="on-dark" size="lg">
              <LuImages aria-hidden="true" />
              {t(`${allCount} புகைப்படங்கள்`, `${allCount} photos`)}
            </Badge>
          ) : null
        }
      />

      <section className="section">
        <div className="container">
          <SectionHeader
            eyebrow={album ? t("தொகுப்பு", "Album") : t("தொகுப்பு", "Gallery")}
            title={album ? albumTitle(album) : t("கோயில் புகைப்படங்கள்", "Temple photographs")}
            subtitle={
              albumLead
                || (total > 0
                  ? t("பெரிதாக்கிப் பார்க்க ஒரு புகைப்படத்தைத் தட்டவும்.", "Tap any photo to view it full size.")
                  : undefined)
            }
          />

          {!loading && !failed && albums.length > 0 && (
            <nav className="chip-row gallery-albums" aria-label={t("தொகுப்புகள்", "Albums")}>
              <button type="button" className="chip" aria-pressed={!album} onClick={() => pickAlbum("")}>
                {t("அனைத்தும்", "All")}
                <span className="chip__count">{allCount}</span>
              </button>
              {albums.map((a) => (
                <button key={a.slug} type="button" className="chip" aria-pressed={album?.id === a.id} onClick={() => pickAlbum(a.slug)}>
                  {albumTitle(a)}
                  {typeof a.count === "number" && <span className="chip__count">{a.count}</span>}
                </button>
              ))}
            </nav>
          )}

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
            <EmptyState icon={<LuImages />} title={album ? t("இந்தத் தொகுப்பில் புகைப்படங்கள் இல்லை", "No photos in this album yet") : t("புகைப்படங்கள் விரைவில் வரும்!", "Photos coming soon")}>
              {album
                ? t("வேறு தொகுப்பைத் தேர்ந்தெடுக்கவும்.", "Choose another album.")
                : t("அடுத்த திருவிழாவுக்குப் பிறகு மீண்டும் பார்க்கவும்.", "Check back after the next festival!")}
            </EmptyState>
          ) : (
            <div className="grid-auto gallery-grid" role="list">
              {shown.map((img, i) => {
                const shape = tileShape(i);
                const wide = shape === "gallery-tile--feature" || shape === "gallery-tile--wide";
                return (
                  <div
                    key={img.id}
                    role="listitem"
                    className={`gallery-cell rise ${shape}`.trim()}
                    style={{ "--i": Math.min(i, 11) }}
                  >
                    <button
                      type="button"
                      className="card gallery-tile"
                      onClick={() => setLightbox(i)}
                      aria-label={`${photoLabel(img)} — ${t("பெரிதாக்கு", "Enlarge")}`}
                    >
                      <img
                        src={thumbSrc(img)}
                        srcSet={srcSetOf(img)}
                        sizes={srcSetOf(img) ? (wide ? SIZES_WIDE : SIZES_TILE) : undefined}
                        width={img.thumb_width || undefined}
                        height={scaledHeight(img, img.thumb_width)}
                        alt={altOf(img)}
                        loading="lazy"
                        decoding="async"
                      />
                      <span className="gallery-tile__overlay" aria-hidden="true">
                        <span className="gallery-tile__zoom">
                          <LuMaximize2 />
                        </span>
                        {img.caption && <span className="gallery-tile__caption">{img.caption}</span>}
                      </span>
                    </button>
                  </div>
                );
              })}
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
                text={current.caption || altOf(current) || lead}
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
                  src={mediumSrc(current)}
                  width={current.medium_width || undefined}
                  height={scaledHeight(current, current.medium_width)}
                  alt={altOf(current)}
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
