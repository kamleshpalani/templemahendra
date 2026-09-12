import { LuPhone } from "react-icons/lu";
import { FaWhatsapp } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import { TEMPLE, PRIMARY_CONTACT, formatPhone } from "../../data/temple";
import "./FloatingActions.css";

// President's number (first on the committee's printed list).
// tel: needs the E.164 "+"; WhatsApp's wa.me wants country code + digits, no "+".
const PHONE_NUMBER = `+91${PRIMARY_CONTACT.phone}`;
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

      <a
        href={`tel:${PHONE_NUMBER}`}
        className="fab fab--phone"
        aria-label={`${t("அழைக்கவும்", "Call us")} — ${formatPhone(PRIMARY_CONTACT.phone)}`}
        data-tip={formatPhone(PRIMARY_CONTACT.phone)}
      >
        <LuPhone aria-hidden="true" />
        <span className="fab__label">{t("அழைக்கவும்", "Call")}</span>
      </a>
    </div>
  );
}
