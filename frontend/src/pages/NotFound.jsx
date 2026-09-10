import { Link } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import { useLang } from "../context/LangContext";

export default function NotFound() {
  const { t } = useLang();
  return (
    <>
      <Helmet>
        <title>{t("பக்கம் கிடைக்கவில்லை", "Page Not Found")}</title>
      </Helmet>
      <section className="section">
        <div className="container container--narrow">
          <div className="empty-state card card--static" style={{ padding: "var(--space-16) var(--space-6)" }}>
            <span className="empty-state__icon" aria-hidden="true">🪔</span>
            <p className="eyebrow" style={{ justifyContent: "center" }}>404</p>
            <h1 className="empty-state__title" style={{ fontSize: "var(--text-2xl)" }}>
              {t("இந்தப் பக்கம் இல்லை", "This page does not exist")}
            </h1>
            <p>
              {t(
                "நீங்கள் தேடும் பக்கம் நகர்த்தப்பட்டிருக்கலாம் அல்லது நீக்கப்பட்டிருக்கலாம்.",
                "The page you're looking for may have been moved or removed.",
              )}
            </p>
            <div className="cluster" style={{ justifyContent: "center" }}>
              <Link to="/" className="btn btn-primary">
                {t("← முகப்பு பக்கம்", "← Back to Home")}
              </Link>
              <Link to="/contact" className="btn btn-outline">
                {t("தொடர்பு", "Contact")}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
