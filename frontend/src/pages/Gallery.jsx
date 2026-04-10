import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import api from "../services/api";
import { useLang } from "../context/LangContext";
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
          {t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}
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
            <p className="loading-text" style={{ textAlign: "center" }}>
              {t(
                "புகைப்படங்கள் விரைவில் வரும்!",
                "Photos coming soon. Check back after the next festival!",
              )}
            </p>
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
                    src={`/api/uploads/${img.filename}`}
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
            src={`/api/uploads/${lightbox.filename}`}
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
