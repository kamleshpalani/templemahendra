import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import { EmptyState } from "../components/ui/Feedback";
import { TEMPLE } from "../data/temple";
import "./PageCommon.css";
import "./Gallery.css";

export default function Gallery() {
  const [images, setImages] = useState([]);
  const [lightbox, setLightbox] = useState(null);
  const { t } = useLang();

  useEffect(() => {
    api
      .get("/gallery")
      .then((r) => setImages(Array.isArray(r.data) ? r.data : []))
      .catch(() => {});
  }, []);

  const handleKey = (e) => {
    if (e.key === "Escape") setLightbox(null);
  };

  return (
    <>
      <Helmet>
        <title>
          {t("தொகுப்பு", "Gallery")} —{" "}
          {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <div className="page-hero page-hero--gallery">
        <div className="page-hero__content">
          <h1>{t("புகைப்பட தொகுப்பு", "Photo Gallery")}</h1>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <h2 className="section-title">{t("தொகுப்பு", "Gallery")}</h2>
          <div className="divider" />

          {images.length === 0 ? (
            <EmptyState icon="🖼️" title={t("புகைப்படங்கள் விரைவில் வரும்!", "Photos coming soon")}>
              {t(
                "அடுத்த திருவிழாவுக்குப் பிறகு மீண்டும் பார்க்கவும்.",
                "Check back after the next festival!",
              )}
            </EmptyState>
          ) : (
            <div className="gallery-grid">
              {images.map((img) => (
                <button
                  key={img.id}
                  className="gallery-item"
                  onClick={() => setLightbox(img)}
                  aria-label={
                    img.caption || t("கோயில் புகைப்படம்", "Temple photo")
                  }
                >
                  <img
                    src={`/uploads/${img.filename}`}
                    alt={img.caption || ""}
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
          onKeyDown={handleKey}
        >
          <button className="lightbox__close" aria-label="Close">
            ✕
          </button>
          <img
            src={`/uploads/${lightbox.filename}`}
            alt={lightbox.caption || ""}
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.caption && (
            <p className="lightbox__caption">{lightbox.caption}</p>
          )}
        </div>
      )}
    </>
  );
}
