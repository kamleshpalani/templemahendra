import { LuCompass } from "react-icons/lu";
import Button from "../components/ui/Button";
import Seo from "../components/Seo";
import { useLang } from "../context/LangContext";
import "./NotFound.css";

export default function NotFound() {
  const { t } = useLang();
  return (
    <>
      {/* A wrong address should never be indexed or previewed as content. */}
      <Seo title={t("பக்கம் கிடைக்கவில்லை", "Page Not Found")} robots="noindex, nofollow" />
      <section className="section notfound">
        <div className="container container--narrow">
          <div className="card card--solid card--static notfound__card rise">
            <span className="empty-state__icon notfound__icon" aria-hidden="true">
              <LuCompass />
            </span>
            <p className="notfound__code">
              <span className="text-gradient">404</span>
            </p>
            <h1 className="notfound__title">{t("இந்தப் பக்கம் இல்லை", "This page does not exist")}</h1>
            <p className="notfound__lead">
              {t(
                "நீங்கள் தேடும் பக்கம் நகர்த்தப்பட்டிருக்கலாம் அல்லது நீக்கப்பட்டிருக்கலாம்.",
                "The page you're looking for may have been moved or removed.",
              )}
            </p>
            <div className="notfound__actions">
              <Button to="/" variant="primary">
                {t("← முகப்பு பக்கம்", "← Back to Home")}
              </Button>
              <Button to="/contact" variant="outline">
                {t("தொடர்பு", "Contact")}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
