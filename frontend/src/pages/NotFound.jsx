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
      <div style={{ textAlign: "center", padding: "5rem 1rem" }}>
        <h1 style={{ fontSize: "5rem", color: "var(--maroon)" }}>404</h1>
        <p style={{ fontSize: "1.2rem", marginBottom: "1.5rem" }}>
          {t("இந்தப் பக்கம் இல்லை.", "This page does not exist.")}
        </p>
        <Link to="/" className="btn btn-primary">
          {t("← முகப்பு பக்கம்", "← Back to Home")}
        </Link>
      </div>
    </>
  );
}
