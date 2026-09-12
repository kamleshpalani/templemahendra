import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import {
  LuClock,
  LuMail,
  LuMapPin,
  LuMoon,
  LuNavigation,
  LuPhone,
  LuPhoneCall,
  LuSend,
  LuSunrise,
  LuSunset,
} from "react-icons/lu";
import { FaWhatsapp } from "react-icons/fa";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import {
  TEMPLE,
  ADDRESS,
  MAPS_URL,
  MAPS_EMBED_URL,
  PRIMARY_CONTACT,
  SECONDARY_CONTACT,
  formatPhone,
  telHref,
} from "../data/temple";
import CommitteeGrid from "../components/CommitteeGrid/CommitteeGrid";
import PageHero from "../components/ui/PageHero";
import SectionHeader from "../components/ui/SectionHeader";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import Badge from "../components/ui/Badge";
import { Field } from "../components/ui/Field";
import "./Contact.css";

// WhatsApp: wa.me wants country code + digits, no "+" (same convention as
// FloatingActions / Footer). Pre-filled bilingual greeting.
const WHATSAPP_HREF = `https://wa.me/91${PRIMARY_CONTACT.phone}?text=${encodeURIComponent(
  `வணக்கம் 🙏 ${TEMPLE.name.ta} பற்றி மேலும் அறிய விரும்புகிறேன்.\nNamaskar 🙏 I would like to know more about ${TEMPLE.name.en}.`,
)}`;

const EMAIL = "info@dhabbalavaartemple.in";

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
      next.phone = t("10 இலக்க தொலைபேசி எண் தேவை", "Enter a 10-digit phone number");
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
        t("செய்தி அனுப்பப்பட்டது. விரைவில் தொடர்பு கொள்வோம்.", "Message sent. We'll reach out soon."),
        t("நன்றி", "Thank you"),
      );
    } catch {
      setStatus("error");
      toast.error(t("அனுப்ப இயலவில்லை. நேரடியாக அழைக்கவும்.", "Could not send. Please call directly."));
    }
  };

  const phoneContacts = [PRIMARY_CONTACT, SECONDARY_CONTACT];
  const sending = status === "sending";

  return (
    <>
      <Helmet>
        <title>
          {t("தொடர்பு", "Contact")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <PageHero
        variant="contact"
        eyebrow={t("வரவேற்கிறோம்", "We'd love to hear from you")}
        title={t("தொடர்பு கொள்ளுங்கள்", "Contact Us")}
        lead={t(ADDRESS.printed.ta, ADDRESS.printed.en)}
        crumbs={[{ label: t("தொடர்பு", "Contact") }]}
        actions={
          <>
            <Button
              href={telHref(PRIMARY_CONTACT.phone)}
              variant="primary"
              className="contact-hero__btn"
              icon={<LuPhone aria-hidden="true" />}
              aria-label={`${t("அழைக்கவும்", "Call")} — ${formatPhone(PRIMARY_CONTACT.phone)}`}
            >
              {t("அழைக்கவும்", "Call")}
            </Button>
            <Button
              href={WHATSAPP_HREF}
              target="_blank"
              rel="noopener noreferrer"
              variant="outline-light"
              className="contact-hero__btn"
              icon={<FaWhatsapp aria-hidden="true" />}
            >
              {t("வாட்ஸ்அப்", "WhatsApp")}
            </Button>
            <Button
              href={MAPS_URL}
              target="_blank"
              rel="noopener noreferrer"
              variant="outline-light"
              className="contact-hero__btn"
              icon={<LuNavigation aria-hidden="true" />}
            >
              {t("வழிகாட்டி", "Directions")}
            </Button>
          </>
        }
      />

      <section className="section contact">
        <div className="container split contact-split">
          {/* ── Visit us ─────────────────────────────────────────── */}
          <div className="contact-visit">
            <SectionHeader
              align="left"
              eyebrow={t("இருப்பிடம்", "Location")}
              title={t("எங்களை சந்திக்கவும்", "Visit Us")}
            />

            <div className="contact-visit__stack">
              {/* Address */}
              <article className="card card--static contact-card rise" style={{ "--i": 0 }}>
                <span className="card__icon" aria-hidden="true">
                  <LuMapPin />
                </span>
                <div className="contact-card__body">
                  <h3 className="contact-card__title">{t("முகவரி", "Address")}</h3>
                  <address className="contact-address">
                    <span className="contact-address__name">{t(TEMPLE.fullName.ta, TEMPLE.fullName.en)}</span>
                    <span>
                      {t(ADDRESS.street.ta, ADDRESS.street.en)},{" "}
                      {t(ADDRESS.village.ta, ADDRESS.village.en)}
                    </span>
                    <span>
                      {t(ADDRESS.taluk.ta, ADDRESS.taluk.en)},{" "}
                      {t(ADDRESS.district.ta, ADDRESS.district.en)},{" "}
                      {t(ADDRESS.state.ta, ADDRESS.state.en)}
                      {t(" - ", " – ")}
                      {ADDRESS.pin}
                    </span>
                  </address>
                </div>
              </article>

              {/* Phone — tap-to-call rows */}
              <article className="card card--static contact-card rise" style={{ "--i": 1 }}>
                <span className="card__icon" aria-hidden="true">
                  <LuPhone />
                </span>
                <div className="contact-card__body">
                  <h3 className="contact-card__title">{t("தொலைபேசி", "Phone")}</h3>
                  <ul className="contact-tel" role="list">
                    {phoneContacts.map((c) => (
                      <li key={c.phone}>
                        <a
                          className="contact-tel__row"
                          href={telHref(c.phone)}
                          aria-label={`${formatPhone(c.phone)} — ${t(c.name.ta, c.name.en)}, ${t(c.role.ta, c.role.en)}`}
                        >
                          <span className="contact-tel__body">
                            <span className="contact-tel__num">{formatPhone(c.phone)}</span>
                            <span className="contact-tel__meta">
                              <Badge tone="gold">{t(c.role.ta, c.role.en)}</Badge>
                              <span className="contact-tel__name">{t(c.name.ta, c.name.en)}</span>
                            </span>
                          </span>
                          <span className="contact-tel__cta" aria-hidden="true">
                            <LuPhoneCall />
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                  <p className="contact-card__more">
                    <a href="#committee">
                      {t(
                        "முழு கமிட்டி விவரங்கள் கீழே ↓",
                        "Full committee contacts below ↓",
                      )}
                    </a>
                  </p>
                </div>
              </article>

              {/* Email */}
              <article className="card card--static contact-card rise" style={{ "--i": 2 }}>
                <span className="card__icon" aria-hidden="true">
                  <LuMail />
                </span>
                <div className="contact-card__body">
                  <h3 className="contact-card__title">{t("மின்னஞ்சல்", "Email")}</h3>
                  <a className="contact-card__link" href={`mailto:${EMAIL}`}>
                    {EMAIL}
                  </a>
                </div>
              </article>

              {/* Timings */}
              <article className="card card--static contact-card rise" style={{ "--i": 3 }}>
                <span className="card__icon" aria-hidden="true">
                  <LuClock />
                </span>
                <div className="contact-card__body">
                  <h3 className="contact-card__title">{t("கோயில் நேரம்", "Temple Timings")}</h3>
                  <dl className="contact-hours">
                    <dt>
                      <LuSunrise aria-hidden="true" />
                      <span className="sr-only">{t("காலை", "Morning")}</span>
                    </dt>
                    <dd>{t("காலை 6:00 – மதியம் 12:30", "6:00 AM – 12:30 PM")}</dd>
                    <dt>
                      <LuSunset aria-hidden="true" />
                      <span className="sr-only">{t("மாலை", "Evening")}</span>
                    </dt>
                    <dd>{t("மாலை 4:00 – இரவு 9:00", "4:00 PM – 9:00 PM")}</dd>
                  </dl>
                  <p className="contact-card__hint">{t("இந்திய நேரம் (IST)", "All times IST")}</p>
                  <p className="contact-observance">
                    <LuMoon aria-hidden="true" />
                    <span>
                      {t(
                        "ஒவ்வொரு மாதம் பௌர்ணமி அன்று சிறப்பு பூஜையும் அன்னதானமும்.",
                        "Special pooja and annadanam every Pournami (full moon).",
                      )}{" "}
                      <Link to="/events">{t("தேதிகள் →", "Dates →")}</Link>
                    </span>
                  </p>
                </div>
              </article>

              {/* Google Maps embed */}
              <div className="card card--static contact-map rise" style={{ "--i": 4 }}>
                <iframe
                  className="contact-map__frame"
                  title={t("கோயில் இருப்பிடம்", "Temple Location")}
                  src={MAPS_EMBED_URL}
                  width="100%"
                  height="260"
                  allowFullScreen
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                />
                <div className="contact-map__foot">
                  <span className="contact-map__addr">
                    <LuMapPin aria-hidden="true" />
                    {t(ADDRESS.printed.ta, ADDRESS.printed.en)}
                  </span>
                  <Button
                    href={MAPS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="outline"
                    icon={<LuNavigation aria-hidden="true" />}
                  >
                    {t("வழிகாட்டி", "Directions")}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* ── Message form ─────────────────────────────────────── */}
          <div className="split__sticky contact-form-col">
            <div className="card card--solid card--static contact-form rise" style={{ "--i": 1 }}>
              <div className="contact-form__head">
                <span className="eyebrow">{t("செய்தி", "Message")}</span>
                <h2 className="contact-form__title">{t("செய்தி அனுப்பவும்", "Send a Message")}</h2>
                <p className="contact-form__lead">
                  {t(
                    "சேவை, நன்கொடை அல்லது தரிசனம் குறித்த கேள்விகளை இங்கே எழுதுங்கள்.",
                    "Questions about sevas, donations or your visit — write to us here.",
                  )}
                </p>
              </div>

              {status === "success" && (
                <Alert tone="success" title={t("நன்றி", "Thank you")} onClose={() => setStatus(null)}>
                  <span aria-hidden="true">🙏</span>{" "}
                  {t(
                    "செய்தி அனுப்பப்பட்டது. விரைவில் தொடர்பு கொள்வோம்.",
                    "Message sent. We'll reach out soon.",
                  )}
                </Alert>
              )}
              {status === "error" && (
                <Alert tone="error" onClose={() => setStatus(null)}>
                  {t(
                    "அனுப்ப இயலவில்லை. நேரடியாக அழைக்கவும்.",
                    "Could not send. Please call directly.",
                  )}
                </Alert>
              )}

              <form onSubmit={handleSubmit} noValidate>
                <Field label={t("பெயர்", "Name")} required error={errors.name}>
                  {(a11y) => (
                    <input
                      {...a11y}
                      required
                      name="name"
                      value={form.name}
                      onChange={handleChange}
                      autoComplete="name"
                    />
                  )}
                </Field>
                <Field
                  label={t("தொலைபேசி", "Phone")}
                  required
                  error={errors.phone}
                  hint={t("10 இலக்க மொபைல் எண்", "10-digit mobile number")}
                >
                  {(a11y) => (
                    <input
                      {...a11y}
                      required
                      type="tel"
                      name="phone"
                      value={form.phone}
                      onChange={handleChange}
                      inputMode="numeric"
                      autoComplete="tel"
                      placeholder="9999999999"
                    />
                  )}
                </Field>
                <Field label={t("செய்தி", "Message")} required error={errors.message}>
                  {(a11y) => (
                    <textarea
                      {...a11y}
                      required
                      name="message"
                      rows="5"
                      value={form.message}
                      onChange={handleChange}
                    />
                  )}
                </Field>
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  block
                  loading={sending}
                  icon={<LuSend aria-hidden="true" />}
                >
                  {t("செய்தி அனுப்பு", "Send Message")}
                </Button>
              </form>

              <div className="contact-form__alt">
                <span>{t("அவசரமா?", "In a hurry?")}</span>
                <Button href={telHref(PRIMARY_CONTACT.phone)} variant="ghost" icon={<LuPhone aria-hidden="true" />}>
                  {t("அழைக்கவும்", "Call")} {formatPhone(PRIMARY_CONTACT.phone)}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Temple committee — the committee's printed office-bearer list */}
      <section className="section section--alt contact-committee">
        <div className="container">
          <CommitteeGrid id="committee" />
          <div className="section-cta">
            <Button to="/donations" variant="outline">
              {t("நன்கொடை விவரங்கள் →", "Donation details →")}
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
