import { FaWhatsapp, FaPhone } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import "./FloatingActions.css";

// Replace these with the actual temple numbers before going live
const PHONE_NUMBER = "+910000000000";
const WHATSAPP_MSG = encodeURIComponent(
  "வணக்கம் 🙏 தபலவார் ரேணுகா தேவி லிங்கம்மா சின்னம்மாள் கோவில் பற்றி மேலும் அறிய விரும்புகிறேன்.\nNamaskar 🙏 I would like to know more about Dhabbalavaar Renuka Devi Lingamma Sinnammal Temple.",
);

export default function FloatingActions() {
  const { t } = useLang();

  return (
    <div className="fab-group" aria-label="Quick contact actions">
      <a
        href={`https://wa.me/${PHONE_NUMBER}?text=${WHATSAPP_MSG}`}
        target="_blank"
        rel="noopener noreferrer"
        className="fab fab--whatsapp"
        aria-label={t("வாட்ஸ்அப்பில் பேசுங்கள்", "Chat on WhatsApp")}
        title={t("வாட்ஸ்அப்பில் பேசுங்கள்", "Chat on WhatsApp")}
      >
        <FaWhatsapp />
        <span className="fab__label">{t("வாட்ஸ்அப்", "WhatsApp")}</span>
      </a>

      <a
        href={`tel:${PHONE_NUMBER}`}
        className="fab fab--phone"
        aria-label={t("அழைக்கவும்", "Call Us")}
        title={t("அழைக்கவும்", "Call Us")}
      >
        <FaPhone />
        <span className="fab__label">{t("அழைக்கவும்", "Call")}</span>
      </a>
    </div>
  );
}
