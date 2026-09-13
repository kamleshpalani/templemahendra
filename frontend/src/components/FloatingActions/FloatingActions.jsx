import { FaWhatsapp } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import { TEMPLE, PRIMARY_CONTACT } from "../../data/temple";
import "./FloatingActions.css";

// President's number (first on the committee's printed list).
// WhatsApp's wa.me wants country code + digits, no "+".
// The call button that used to sit here now lives in the sticky header, where it
// is visible without covering the page.
const WHATSAPP_NUMBER = `91${PRIMARY_CONTACT.phone}`;
const WHATSAPP_MSG = encodeURIComponent(
  `வணக்கம் 🙏 ${TEMPLE.name.ta} பற்றி மேலும் அறிய விரும்புகிறேன்.\nNamaskar 🙏 I would like to know more about ${TEMPLE.name.en}.`,
);

export default function FloatingActions() {
  const { t } = useLang();

  return (
    <div className="fab-group" aria-label={t("விரைவு தொடர்பு", "Quick contact actions")}>
      <a
        href={`https://wa.me/${WHATSAPP_NUMBER}?text=${WHATSAPP_MSG}`}
        target="_blank"
        rel="noopener noreferrer"
        className="fab fab--whatsapp"
        aria-label={t("வாட்ஸ்அப்பில் பேசுங்கள்", "Chat on WhatsApp")}
        data-tip={t("வாட்ஸ்அப்", "WhatsApp")}
      >
        <FaWhatsapp aria-hidden="true" />
        <span className="fab__label">{t("வாட்ஸ்அப்", "WhatsApp")}</span>
      </a>
    </div>
  );
}
