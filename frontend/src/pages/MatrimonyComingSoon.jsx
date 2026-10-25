import { LuArrowRight, LuFlower2, LuHeartHandshake, LuHouse, LuSparkles } from "react-icons/lu";
import { useLang } from "../context/LangContext";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import "./MatrimonyComingSoon.css";

export default function MatrimonyComingSoon() {
  const { t } = useLang();
  const title = t("திருமணத் தகவல்", "Matrimony");
  return <>
    <Seo title={title} description={t("திருமணத் தகவல் சேவை விரைவில்.", "Our community matrimony service is coming soon.")} />
    <PageHero variant="matrimony" title={title} crumbs={[{ label: title }]}
      lead={t("நம் சமூகத்தின் புதிய தொடக்கங்களுக்கு.", "Celebrating new beginnings in our community.")} />
    <section className="matrimony-soon" aria-labelledby="matrimony-coming-title">
      <div className="container">
        <div className="matrimony-soon__card">
          <div className="matrimony-soon__ceremony" aria-hidden="true">
            <div className="matrimony-soon__arch">
              <LuFlower2 className="matrimony-soon__flower" />
              <div className="matrimony-soon__rings"><span /><span /></div>
              <LuHeartHandshake className="matrimony-soon__heart" />
              <div className="matrimony-soon__flourish"><span /><LuFlower2 /><span /></div>
            </div>
          </div>
          <div className="matrimony-soon__message">
          <p className="matrimony-soon__badge"><LuSparkles aria-hidden="true" />{t("விரைவில்", "Coming Soon")}</p>
          <p className="matrimony-soon__eyebrow">{t("இறையருளுடன் இனிய தொடக்கம்", "New beginnings, with divine blessings")}</p>
          <h2 id="matrimony-coming-title">{t("இனிய உறவுகளுக்கான ஒரு புதிய தொடக்கம்", "A new chapter for meaningful connections")}</h2>
          <p className="matrimony-soon__description">{t("நம் சமூகத்திற்கான திருமணத் தகவல் சேவையைத் தயாரித்து வருகிறோம். பதிவு இன்னும் தொடங்கவில்லை.",
            "We’re preparing our community matrimony service. Registration is not open yet.")}</p>
          <div className="matrimony-soon__actions">
            <Button to="/contact" variant="gold" trailingIcon={<LuArrowRight aria-hidden="true" />}>{t("தொடர்பு கொள்ளுங்கள்", "Contact the temple")}</Button>
            <Button to="/" variant="outline-light" icon={<LuHouse aria-hidden="true" />}>{t("முகப்பு", "Back to home")}</Button>
          </div>
          <p className="matrimony-soon__note"><LuFlower2 aria-hidden="true" />{t("குடும்பங்கள் இணையும் இனிய பயணம்", "A thoughtful beginning. A bond between families.")}</p>
          </div>
        </div>
      </div>
    </section>
  </>;
}
