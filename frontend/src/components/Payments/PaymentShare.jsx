import { FaWhatsapp } from "react-icons/fa";
import { LuMail } from "react-icons/lu";
import Button from "../ui/Button";
import { useLang } from "../../context/LangContext";
import { TEMPLE, TEMPLE_EMAIL, TEMPLE_PHONE } from "../../data/temple";
import "./PaymentShare.css";

export default function PaymentShare({ path, receipt = false, reference, amountLabel, purposeLabel, testMode = false }) {
  const { t } = useLang();
  const url = new URL(path, window.location.origin).href;
  const subject = receipt ? t("கட்டண ரசீது", "Payment receipt") : t("நன்கொடை / சேவைப் பக்கம்", "Donation / seva page");
  const body = [
    testMode ? t("சோதனை மட்டும் — உண்மையான கட்டணம் அல்ல", "TEST ONLY — not a real payment") : null,
    t(TEMPLE.name.ta, TEMPLE.name.en), subject,
    reference && `${t("குறிப்பு", "Reference")}: ${reference}`,
    purposeLabel, amountLabel,
    receipt ? t("ரசீதைப் பார்க்க:", "View receipt:") : t("பதிவை நிரப்பி கட்டணம் செலுத்த இந்தப் பக்கத்தைத் திறக்கவும். இது நிர்ணயிக்கப்பட்ட கட்டண ஆணை அல்ல.",
      "Open this page to complete the form and pay. This is not a fixed-amount payment order."),
    url,
  ].filter(Boolean).join("\n");
  const email = (recipient) => `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return <section className="payment-share" aria-label={t("கட்டண விவரங்களைப் பகிர", "Share payment details")}>
    <h3>{receipt ? t("ரசீதைப் பகிர", "Share receipt") : t("கட்டணப் பக்கத்தைப் பகிர", "Share payment page")}</h3>
    <p>{t("இவை செய்தி வரைவைத் திறக்கும். பெறுநரைத் தேர்ந்தெடுத்து அனுப்பு என்பதை அழுத்தவும். தானாக அனுப்பப்படாது.",
      "These buttons open a message draft. Choose the recipient and press Send. Nothing is sent automatically.")}</p>
    {receipt && <p>{t("தனிப்பட்ட ரசீது இணைப்பு — பகிர்ந்தால் பெறுநர் ரசீது விவரங்களைப் பார்க்க முடியும்.",
      "Private receipt link — anyone you share it with can view the receipt details.")}</p>}
    <div className="payment-share__actions">
      <Button href={`https://wa.me/?text=${encodeURIComponent(body)}`} target="_blank" rel="noopener noreferrer" variant="outline" size="sm" icon={<FaWhatsapp aria-hidden="true" />}>
        {t("பக்தருக்கு · WhatsApp", "Devotee · WhatsApp")}
      </Button>
      <Button href={email("")} variant="outline" size="sm" icon={<LuMail aria-hidden="true" />}>
        {t("பக்தருக்கு · மின்னஞ்சல்", "Devotee · Email")}
      </Button>
      <Button href={`https://wa.me/91${TEMPLE_PHONE.digits}?text=${encodeURIComponent(body)}`} target="_blank" rel="noopener noreferrer" variant="gold" size="sm" icon={<FaWhatsapp aria-hidden="true" />}>
        {t("ஆலயத்திற்கு · WhatsApp", "Office · WhatsApp")}
      </Button>
      <Button href={email(TEMPLE_EMAIL)} variant="gold" size="sm" icon={<LuMail aria-hidden="true" />}>
        {t("ஆலயத்திற்கு · மின்னஞ்சல்", "Office · Email")}
      </Button>
    </div>
  </section>;
}
