import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import Modal from "../components/ui/Modal";
import { SkeletonCards } from "../components/ui/Feedback";
import { TEMPLE, SECONDARY_CONTACT, formatPhone } from "../data/temple";
import "./PageCommon.css";
import "./Sevas.css";

const SEVA_ICONS = ["🪔", "🌺", "🔥", "📿", "🍚", "🐘"];

/* ── Seva Booking Modal ─────────────────────────────────────────── */
function BookingModal({ seva, onClose, t, lang }) {
  const toast = useToast();
  const [form, setForm] = useState({
    devotee_name: "",
    phone: "",
    preferred_date: "",
    message: "",
  });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [errMsg, setErrMsg] = useState("");

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((er) => ({ ...er, [name]: undefined }));
  }

  function validate() {
    const next = {};
    if (form.devotee_name.trim().length < 2)
      next.devotee_name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    if (!/^[0-9]{7,15}$/.test(form.phone))
      next.phone = t("சரியான தொலைபேசி எண் தேவை", "Enter a valid phone number");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    setStatus("loading");
    setErrMsg("");
    try {
      await api.post("/seva-bookings", {
        seva_id: seva.id,
        seva_name: lang === "ta" ? seva.name_ta : seva.name_en,
        devotee_name: form.devotee_name,
        phone: form.phone,
        preferred_date: form.preferred_date || null,
        message: form.message,
      });
      setStatus("success");
      toast.success(
        t("உங்கள் சேவை பதிவு பெறப்பட்டது.", "Your seva request has been received."),
        t("பதிவு வெற்றி", "Booking received"),
      );
    } catch (err) {
      setErrMsg(
        err?.response?.data?.error ||
          t(
            "சமர்ப்பிக்க இயலவில்லை. மீண்டும் முயற்சிக்கவும்.",
            "Submission failed. Please try again.",
          ),
      );
      setStatus("error");
    }
  }

  const sevaName = lang === "ta" ? seva.name_ta : seva.name_en;

  return (
    <Modal open onClose={onClose} labelledBy="booking-title">
      {status === "success" ? (
        <div className="booking-modal__success">
          <span className="booking-modal__success-icon" aria-hidden="true">🙏</span>
          <h3 id="booking-title">{t("பதிவு வெற்றி!", "Booking Received!")}</h3>
          <p>
            {t(
              "உங்கள் சேவை பதிவு பெறப்பட்டது. கோயில் அலுவலகம் விரைவில் தொடர்பு கொள்ளும்.",
              "Your seva request has been received. The temple office will contact you shortly.",
            )}
          </p>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t("மூடு", "Close")}
          </button>
        </div>
      ) : (
        <>
          <p className="eyebrow">{t("சேவை பதிவு", "Book Seva")}</p>
          <h3 id="booking-title" className="modal__title">{sevaName}</h3>
          <p className="booking-modal__amount">
            ₹{seva.amount}
            <span>{t("சமர்ப்பணம்", "offering")}</span>
          </p>

          <form className="booking-form" onSubmit={handleSubmit} noValidate>
            <label className={errors.devotee_name ? "field--error" : ""}>
              {t("உங்கள் பெயர்", "Your Name")} *
              <input
                type="text"
                name="devotee_name"
                value={form.devotee_name}
                onChange={handleChange}
                required
                minLength={2}
                maxLength={200}
                autoComplete="name"
                placeholder={t("முழு பெயர்", "Full name")}
                aria-invalid={Boolean(errors.devotee_name)}
                aria-describedby={errors.devotee_name ? "err-name" : undefined}
              />
              {errors.devotee_name && (
                <span id="err-name" className="field__error" role="alert">
                  {errors.devotee_name}
                </span>
              )}
            </label>
            <label className={errors.phone ? "field--error" : ""}>
              {t("தொலைபேசி", "Phone Number")} *
              <input
                type="tel"
                name="phone"
                value={form.phone}
                onChange={handleChange}
                required
                maxLength={15}
                placeholder="9999999999"
                inputMode="numeric"
                autoComplete="tel"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? "err-phone" : undefined}
              />
              {errors.phone && (
                <span id="err-phone" className="field__error" role="alert">
                  {errors.phone}
                </span>
              )}
            </label>
            <label>
              {t("விரும்பும் தேதி", "Preferred Date")}
              <input
                type="date"
                name="preferred_date"
                value={form.preferred_date}
                onChange={handleChange}
                min={new Date().toISOString().slice(0, 10)}
              />
              <span className="field__hint">
                {t("விருப்பத்தேர்வு — அலுவலகம் உறுதி செய்யும்", "Optional — the office will confirm")}
              </span>
            </label>
            <label>
              {t("குறிப்பு", "Note (optional)")}
              <textarea
                name="message"
                value={form.message}
                onChange={handleChange}
                rows={2}
                maxLength={500}
                placeholder={t("சிறப்பு கோரிக்கை எதாவது இருந்தால்…", "Any special request…")}
              />
            </label>

            {errMsg && (
              <p className="form-error" role="alert">
                {errMsg}
              </p>
            )}

            <div className="modal__actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t("ரத்து", "Cancel")}
              </button>
              <button
                type="submit"
                className={`btn btn-primary${status === "loading" ? " btn--loading" : ""}`}
                disabled={status === "loading"}
                aria-busy={status === "loading"}
              >
                {t("பதிவு செய்யுங்கள்", "Submit Booking")}
              </button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}

export default function Sevas() {
  const [sevas, setSevas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedSeva, setSelectedSeva] = useState(null);
  const { lang, t } = useLang();

  useEffect(() => {
    api
      .get("/sevas")
      .then((r) => setSevas(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fallback = [
    {
      id: 1,
      name_ta: "அபிஷேகம்",
      name_en: "Abhishekam",
      amount: 251,
      description_ta: "பாலாபிஷேகம், தேன் மற்றும் ரோஜாநீரால் தெய்வ அபிஷேகம்.",
      description_en:
        "Sacred bathing of the deity with milk, honey, and rose water.",
    },
    {
      id: 2,
      name_ta: "அர்ச்சனை",
      name_en: "Archana",
      amount: 51,
      description_ta: "தெய்வத்தின் நாமங்களை ஓதி மலர் சமர்ப்பணம்.",
      description_en: "Offering of flowers with chanting of the deity's names.",
    },
    {
      id: 3,
      name_ta: "தீபாராதனை",
      name_en: "Deepa Aradhana",
      amount: 101,
      description_ta: "தெய்வத்திற்கு தீபாராதனை செய்தல்.",
      description_en: "Waving of sacred lamps before the deity.",
    },
    {
      id: 4,
      name_ta: "சகஸ்ர நாமம்",
      name_en: "Sahasranama",
      amount: 501,
      description_ta: "தெய்வத்தின் 1000 நாமங்களை சொல்லுதல்.",
      description_en: "Recitation of 1000 names of the deity.",
    },
    {
      id: 5,
      name_ta: "அன்னதானம்",
      name_en: "Annadanam",
      amount: 2001,
      description_ta: "பக்தர்களுக்கும் ஏழைகளுக்கும் இலவச உணவு வழங்குதல்.",
      description_en: "Sponsoring a free meal for devotees and the needy.",
    },
    {
      id: 6,
      name_ta: "வாகன பூஜை",
      name_en: "Vahana Pooja",
      amount: 1001,
      description_ta: "திருவிழா வாகனத்தில் சிறப்பு ஊர்வலம்.",
      description_en: "Ceremonial procession of the festival vehicle.",
    },
  ];

  const items = sevas.length > 0 ? sevas : fallback;

  return (
    <>
      <Helmet>
        <title>
          {t("சேவைகள்", "Sevas")} —{" "}
          {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <div className="page-hero page-hero--sevas">
        <div className="page-hero__content">
          <span className="page-hero__eyebrow">{t("ஆன்லைன் பதிவு", "Online booking")}</span>
          <h1>{t("சேவைகள் & பூஜைகள்", "Sevas & Poojas")}</h1>
          <p>
            {t(
              "உங்கள் பெயரில் அல்லது குடும்பத்தினர் பெயரில் ஒரு பூஜையை நடத்தி ஆசி பெறுங்கள்.",
              "Offer a pooja in your name or your family's name and receive the blessings of the Goddess.",
            )}
          </p>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <h2 className="section-title">
            {t("கிடைக்கும் சேவைகள்", "Available Sevas")}
          </h2>
          <div className="divider" />
          <p className="section-subtitle">
            {t(
              "விரும்பிய சேவையில் 'பதிவு செய்' அழுத்தி ஆன்லைனில் கோரிக்கை அனுப்புங்கள்",
              "Click 'Book' on any seva to submit your request online",
            )}
          </p>

          {loading ? (
            <SkeletonCards count={4} className="seva-list" />
          ) : (
            <div className="seva-list">
              {items.map((s, i) => (
                <article key={s.id} className="seva-row card" style={{ "--i": i }}>
                  <span className="seva-row__icon" aria-hidden="true">
                    {SEVA_ICONS[i % SEVA_ICONS.length]}
                  </span>
                  <div className="seva-row__info">
                    <h3 className="seva-row__name-ta">
                      {lang === "ta" ? s.name_ta : s.name_en}
                    </h3>
                    {s.description_ta || s.description ? (
                      <p className="seva-row__desc">
                        {lang === "ta"
                          ? (s.description_ta ?? s.description)
                          : (s.description_en ?? s.description)}
                      </p>
                    ) : null}
                  </div>
                  <div className="seva-row__right">
                    <div className="seva-row__amount">₹{s.amount}</div>
                    <button
                      type="button"
                      className="btn btn-primary btn--sm seva-row__book-btn"
                      onClick={() => setSelectedSeva(s)}
                      aria-label={`${t("பதிவு செய்", "Book")} — ${lang === "ta" ? s.name_ta : s.name_en}`}
                    >
                      {t("பதிவு செய் →", "Book →")}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="seva-note">
            <span aria-hidden="true">☎️</span>
            <p>
              {t(
                `சேவை பதிவு செய்ய ${SECONDARY_CONTACT.role.ta} ${SECONDARY_CONTACT.name.ta} – ${formatPhone(SECONDARY_CONTACT.phone)} என்ற எண்ணில் அழைக்கவும் அல்லது காலை 8 – 12 மணி, மாலை 4 – 8 மணி நேரத்தில் கோயில் அலுவலகத்தை நேரில் அணுகவும்.`,
                `To book a seva, call ${SECONDARY_CONTACT.role.en} ${SECONDARY_CONTACT.name.en} at ${formatPhone(SECONDARY_CONTACT.phone)} or visit the temple office between 8 AM – 12 PM and 4 PM – 8 PM.`,
              )}
            </p>
          </div>
        </div>
      </section>

      {selectedSeva && (
        <BookingModal
          seva={selectedSeva}
          onClose={() => setSelectedSeva(null)}
          t={t}
          lang={lang}
        />
      )}
    </>
  );
}
