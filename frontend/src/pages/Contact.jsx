import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import {
  TEMPLE,
  ADDRESS,
  MAPS_EMBED_URL,
  PRIMARY_CONTACT,
  SECONDARY_CONTACT,
  formatPhone,
  telHref,
} from "../data/temple";
import CommitteeGrid from "../components/CommitteeGrid/CommitteeGrid";
import "./PageCommon.css";
import "./Contact.css";

export default function Contact() {
  const { t } = useLang();
  const toast = useToast();
  const [form, setForm] = useState({ name: "", phone: "", message: "" });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState(null);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((er) => ({ ...er, [name]: undefined }));
  };

  const validate = () => {
    const next = {};
    if (form.name.trim().length < 2) next.name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    if (!/^[0-9]{10}$/.test(form.phone))
      next.phone = t("10 இலக்க தொலைபேசி எண் தேவை", "Enter a 10-digit phone number");
    if (form.message.trim().length < 5)
      next.message = t("செய்தியை உள்ளிடவும்", "Please write a short message");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
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
      toast.success(
        t("செய்தி அனுப்பப்பட்டது. விரைவில் தொடர்பு கொள்வோம்.", "Message sent. We'll reach out soon."),
        t("நன்றி", "Thank you"),
      );
    } catch {
      setStatus("error");
      toast.error(t("அனுப்ப இயலவில்லை. நேரடியாக அழைக்கவும்.", "Could not send. Please call directly."));
    }
  };

  const phoneContacts = [PRIMARY_CONTACT, SECONDARY_CONTACT];

  return (
    <>
      <Helmet>
        <title>
          {t("தொடர்பு", "Contact")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <div className="page-hero page-hero--contact">
        <div className="page-hero__content">
          <span className="page-hero__eyebrow">{t("வரவேற்கிறோம்", "We'd love to hear from you")}</span>
          <h1>{t("தொடர்பு கொள்ளுங்கள்", "Contact Us")}</h1>
          <p>{t(ADDRESS.printed.ta, ADDRESS.printed.en)}</p>
        </div>
      </div>

      <section className="section">
        <div className="container contact-layout">
          <div className="contact-details">
            <p className="eyebrow">{t("இருப்பிடம்", "Location")}</p>
            <h2>{t("எங்களை சந்திக்கவும்", "Visit Us")}</h2>
            <address>
              <p>{t(TEMPLE.fullName.ta, TEMPLE.fullName.en)}</p>
              <p>
                {t(ADDRESS.street.ta, ADDRESS.street.en)},{" "}
                {t(ADDRESS.village.ta, ADDRESS.village.en)}
              </p>
              <p>
                {t(ADDRESS.taluk.ta, ADDRESS.taluk.en)},{" "}
                {t(ADDRESS.district.ta, ADDRESS.district.en)} – {ADDRESS.pin}
              </p>
            </address>

            <h3>{t("தொலைபேசி", "Phone")}</h3>
            <ul className="contact-details__tel-list">
              {phoneContacts.map((c) => (
                <li key={c.phone}>
                  <a
                    className="contact-details__tel"
                    href={telHref(c.phone)}
                    aria-label={`${t(c.name.ta, c.name.en)}, ${t(c.role.ta, c.role.en)}`}
                  >
                    {formatPhone(c.phone)}
                  </a>{" "}
                  <span className="contact-details__tel-role">
                    {t(c.role.ta, c.role.en)} – {t(c.name.ta, c.name.en)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="contact-details__more">
              <a href="#committee">
                {t(
                  "முழு கமிட்டி விவரங்கள் கீழே ↓",
                  "Full committee contacts below ↓",
                )}
              </a>
            </p>

            <h3>{t("மின்னஞ்சல்", "Email")}</h3>
            <a href="mailto:info@dhabbalavaartemple.in">
              info@dhabbalavaartemple.in
            </a>

            <h3>{t("கோயில் நேரம்", "Temple Timings")}</h3>
            <p>{t("காலை 6:00 – மதியம் 12:30", "6:00 AM – 12:30 PM")}</p>
            <p>{t("மாலை 4:00 – இரவு 9:00", "4:00 PM – 9:00 PM")}</p>
            <p className="contact-details__observance">
              {t(
                "ஒவ்வொரு மாதம் பௌர்ணமி அன்று சிறப்பு பூஜையும் அன்னதானமும்.",
                "Special pooja and annadanam every Pournami (full moon).",
              )}{" "}
              <Link to="/events">{t("தேதிகள் →", "Dates →")}</Link>
            </p>

            {/* Google Maps embed */}
            <div className="map-embed">
              <iframe
                title={t("கோயில் இருப்பிடம்", "Temple Location")}
                src={MAPS_EMBED_URL}
                width="100%"
                height="260"
                style={{ border: 0, borderRadius: "10px" }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          </div>

          <div className="contact-form card card--static">
            <p className="eyebrow">{t("செய்தி", "Message")}</p>
            <h3>{t("செய்தி அனுப்பவும்", "Send a Message")}</h3>
            {status === "success" && (
              <p className="form-success" role="status" aria-live="polite">
                <span aria-hidden="true">🙏</span>{" "}
                {t(
                  "செய்தி அனுப்பப்பட்டது. விரைவில் தொடர்பு கொள்வோம்.",
                  "Message sent. We'll reach out soon.",
                )}
              </p>
            )}
            {status === "error" && (
              <p className="form-error" role="alert">
                {t(
                  "அனுப்ப இயலவில்லை. நேரடியாக அழைக்கவும்.",
                  "Could not send. Please call directly.",
                )}
              </p>
            )}
            <form onSubmit={handleSubmit} noValidate>
              <label className={errors.name ? "field--error" : ""}>
                {t("பெயர் *", "Name *")}
                <input
                  required
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  autoComplete="name"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "c-err-name" : undefined}
                />
                {errors.name && (
                  <span id="c-err-name" className="field__error" role="alert">{errors.name}</span>
                )}
              </label>
              <label className={errors.phone ? "field--error" : ""}>
                {t("தொலைபேசி *", "Phone *")}
                <input
                  required
                  type="tel"
                  name="phone"
                  value={form.phone}
                  onChange={handleChange}
                  inputMode="numeric"
                  autoComplete="tel"
                  placeholder="9999999999"
                  aria-invalid={Boolean(errors.phone)}
                  aria-describedby={errors.phone ? "c-err-phone" : undefined}
                />
                {errors.phone && (
                  <span id="c-err-phone" className="field__error" role="alert">{errors.phone}</span>
                )}
              </label>
              <label className={errors.message ? "field--error" : ""}>
                {t("செய்தி *", "Message *")}
                <textarea
                  required
                  name="message"
                  rows="5"
                  value={form.message}
                  onChange={handleChange}
                  aria-invalid={Boolean(errors.message)}
                  aria-describedby={errors.message ? "c-err-msg" : undefined}
                />
                {errors.message && (
                  <span id="c-err-msg" className="field__error" role="alert">{errors.message}</span>
                )}
              </label>
              <button
                type="submit"
                className={`btn btn-primary btn--block${status === "sending" ? " btn--loading" : ""}`}
                disabled={status === "sending"}
                aria-busy={status === "sending"}
              >
                {t("செய்தி அனுப்பு", "Send Message")}
              </button>
            </form>
          </div>
        </div>
      </section>

      {/* Temple committee — the committee's printed office-bearer list */}
      <section className="section section--alt">
        <div className="container">
          <CommitteeGrid id="committee" />
          <div className="section-cta">
            <Link to="/donations" className="btn btn-outline">
              {t("நன்கொடை விவரங்கள் →", "Donation details →")}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
