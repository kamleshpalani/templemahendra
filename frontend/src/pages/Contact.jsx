import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { useLang } from "../context/LangContext";
import "./PageCommon.css";
import "./Contact.css";

export default function Contact() {
  const { t } = useLang();
  const [form, setForm] = useState({ name: "", phone: "", message: "" });
  const [status, setStatus] = useState(null);

  const handleChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus("sending");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error();
      setStatus("success");
      setForm({ name: "", phone: "", message: "" });
    } catch {
      setStatus("error");
    }
  };

  return (
    <>
      <Helmet>
        <title>
          {t("தொடர்பு", "Contact")} —{" "}
          {t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}
        </title>
      </Helmet>

      <div className="page-hero page-hero--contact">
        <div className="page-hero__content">
          <h1>{t("தொடர்பு கொள்ளுங்கள்", "Contact Us")}</h1>
        </div>
      </div>

      <section className="section">
        <div className="container contact-layout">
          <div className="contact-details">
            <h2>{t("எங்களை சந்திக்கவும்", "Visit Us")}</h2>
            <address>
              <p>{t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}</p>
              <p>{t("கோயில் தெரு, நகரம்", "Temple Street, City")}</p>
              <p>Tamil Nadu – 600 000</p>
            </address>
            <h3>{t("தொலைபேசி", "Phone")}</h3>
            <a href="tel:+910000000000">+91 00000 00000</a>
            <h3>{t("மின்னஞ்சல்", "Email")}</h3>
            <a href="mailto:info@templemahendra.in">info@templemahendra.in</a>
            <h3>{t("கோயில் நேரம்", "Temple Timings")}</h3>
            <p>{t("காலை 6:00 – மதியம் 12:30", "6:00 AM – 12:30 PM")}</p>
            <p>{t("மாலை 4:00 – இரவு 9:00", "4:00 PM – 9:00 PM")}</p>

            {/* Google Maps embed placeholder */}
            <div className="map-placeholder">
              <p>📍 {t("வரைபடம் விரைவில் வரும்", "Map coming soon")}</p>
              <small>
                {t(
                  "Google Maps இணைக்கவும்",
                  "Replace with actual Google Maps embed",
                )}
              </small>
            </div>
          </div>

          <div className="contact-form card">
            <h3>{t("செய்தி அனுப்பவும்", "Send a Message")}</h3>
            {status === "success" && (
              <p className="form-success">
                🙏{" "}
                {t(
                  "செய்தி அனுப்பப்பட்டது. விரைவில் தொடர்பு கொள்வோம்.",
                  "Message sent. We'll reach out soon.",
                )}
              </p>
            )}
            {status === "error" && (
              <p className="form-error">
                {t(
                  "அனுப்ப இயலவில்லை. நேரடியாக அழைக்கவும்.",
                  "Could not send. Please call directly.",
                )}
              </p>
            )}
            <form onSubmit={handleSubmit} noValidate>
              <label>
                {t("பெயர் *", "Name *")}
                <input
                  required
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                />
              </label>
              <label>
                {t("தொலைபேசி *", "Phone *")}
                <input
                  required
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  pattern="[0-9]{10}"
                />
              </label>
              <label>
                {t("செய்தி *", "Message *")}
                <textarea
                  required
                  name="message"
                  rows="5"
                  value={form.message}
                  onChange={handleChange}
                />
              </label>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={status === "sending"}
              >
                {status === "sending"
                  ? t("அனுப்புகிறது…", "Sending…")
                  : t("செய்தி அனுப்பு", "Send Message")}
              </button>
            </form>
          </div>
        </div>
      </section>
    </>
  );
}
