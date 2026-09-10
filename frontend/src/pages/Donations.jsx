import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import { TEMPLE, TRUST, KUMBABHISHEKAM_APPEAL } from "../data/temple";
import TrustDetails from "../components/TrustDetails/TrustDetails";
import "./PageCommon.css";
import "./Donations.css";

const QUICK_AMOUNTS = [501, 1001, 2001, 5001];

export default function Donations() {
  const { t } = useLang();
  const toast = useToast();
  const [form, setForm] = useState({
    name: "",
    phone: "",
    amount: "",
    purpose: "",
    message: "",
  });
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
    if (!(Number(form.amount) >= 1))
      next.amount = t("தொகையை உள்ளிடவும்", "Enter a donation amount");
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/donations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error();
      setStatus("success");
      setForm({ name: "", phone: "", amount: "", purpose: "", message: "" });
      toast.success(
        t("உங்கள் நன்கொடை பதிவு செய்யப்பட்டது.", "Your donation has been recorded."),
        t("நன்றி!", "Thank you!"),
      );
    } catch {
      setStatus("error");
      toast.error(t("பிழை ஏற்பட்டது. நேரடியாக அழைக்கவும்.", "Something went wrong. Please call us to confirm."));
    }
  };

  return (
    <>
      <Helmet>
        <title>
          {t("நன்கொடை", "Donations")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <div className="page-hero page-hero--donations">
        <div className="page-hero__content">
          <span className="page-hero__eyebrow">{TRUST.taxExemption ? t(TRUST.taxExemption.short.ta, TRUST.taxExemption.short.en) : t("நன்கொடை", "Donate")}</span>
          <h1>{t("நன்கொடை", "Donations")}</h1>
          <p>{t(TRUST.name.ta, TRUST.name.en)}</p>
        </div>
      </div>

      <section className="section">
        <div className="container donations-layout">
          <div className="donations-info">
            <p className="eyebrow">{t("ஆதரவு", "Support")}</p>
            <h2>{t("உங்கள் ஆதரவு", "Your Support")}</h2>
            <p>
              {t(
                "உங்கள் நன்கொடை கோயிலை பராமரிக்கவும், அன்னதானம் மற்றும் திருவிழாக்களை நடத்தவும் பெரிதும் உதவுகிறது. ஒவ்வொரு பங்களிப்பும் ஒரு புனித செயல்.",
                "Your donations help maintain the temple, conduct daily rituals, fund festivals, and support the Annadanam (free meal) programme. Every contribution, however small, is a sacred act of devotion.",
              )}
            </p>

            {/* Kumbabhishekam + buildings appeal (committee letter, §5i) */}
            <aside
              className="donations-appeal"
              id="kumbabhishekam"
              aria-labelledby="donations-appeal-title"
            >
              <h3 id="donations-appeal-title" className="donations-appeal__title">
                <span aria-hidden="true">🛕</span>{" "}
                {t(KUMBABHISHEKAM_APPEAL.heading.ta, KUMBABHISHEKAM_APPEAL.heading.en)}
              </h3>
              <p className="donations-appeal__text">
                {t(KUMBABHISHEKAM_APPEAL.ta, KUMBABHISHEKAM_APPEAL.en)}
              </p>
            </aside>

            <h3>{t("வங்கி பரிமாற்றம் / காசோலை", "Bank Transfer / Cheque")}</h3>
            <TrustDetails variant="bank" showNote id="bank-details" />

            <p className="donations-info__more">
              <Link to="/about#trust">
                {t(
                  "அறக்கட்டளை பதிவு விவரங்கள் முழுமையாக →",
                  "Full Trust registration details →",
                )}
              </Link>
            </p>
          </div>

          <div className="donations-form card card--static">
            <p className="eyebrow">{t("பதிவு", "Pledge")}</p>
            <h3>{t("நன்கொடை பதிவு", "Register Your Donation")}</h3>
            <p className="donations-form__hint">
              {t(
                "ரசீது அனுப்ப உங்கள் முழு முகவரியை செய்தியில் குறிப்பிடவும்.",
                "Please include your full postal address in the message so a receipt can be sent.",
              )}
            </p>
            {status === "success" && (
              <p className="form-success" role="status" aria-live="polite">
                <span aria-hidden="true">🙏</span>{" "}
                {t(
                  "நன்றி! உங்கள் நன்கொடை பதிவு செய்யப்பட்டது.",
                  "Thank you! Your donation has been recorded.",
                )}
              </p>
            )}
            {status === "error" && (
              <p className="form-error" role="alert">
                {t(
                  "பிழை ஏற்பட்டது. நேரடியாக அழைக்கவும்.",
                  "Something went wrong. Please call us to confirm.",
                )}
              </p>
            )}
            <form onSubmit={handleSubmit} noValidate>
              <label className={errors.name ? "field--error" : ""}>
                {t("முழு பெயர் *", "Full Name *")}
                <input
                  required
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                  autoComplete="name"
                  aria-invalid={Boolean(errors.name)}
                  aria-describedby={errors.name ? "d-err-name" : undefined}
                />
                {errors.name && <span id="d-err-name" className="field__error" role="alert">{errors.name}</span>}
              </label>
              <label className={errors.phone ? "field--error" : ""}>
                {t("தொலைபேசி எண் *", "Phone Number *")}
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
                  aria-describedby={errors.phone ? "d-err-phone" : undefined}
                />
                {errors.phone && <span id="d-err-phone" className="field__error" role="alert">{errors.phone}</span>}
              </label>
              <label className={errors.amount ? "field--error" : ""}>
                {t("தொகை (₹) *", "Amount (₹) *")}
                <input
                  required
                  type="number"
                  min="1"
                  name="amount"
                  value={form.amount}
                  onChange={handleChange}
                  inputMode="numeric"
                  aria-invalid={Boolean(errors.amount)}
                  aria-describedby={errors.amount ? "d-err-amount" : undefined}
                />
                <span className="donations-form__chips" role="group" aria-label={t("விரைவு தொகை", "Quick amounts")}>
                  {QUICK_AMOUNTS.map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      className={`donations-form__chip${Number(form.amount) === amt ? " donations-form__chip--active" : ""}`}
                      onClick={() => handleChange({ target: { name: "amount", value: String(amt) } })}
                      aria-pressed={Number(form.amount) === amt}
                    >
                      ₹{amt}
                    </button>
                  ))}
                </span>
                {errors.amount && <span id="d-err-amount" className="field__error" role="alert">{errors.amount}</span>}
              </label>
              <label>
                {t("நோக்கம்", "Purpose")}
                <select
                  name="purpose"
                  value={form.purpose}
                  onChange={handleChange}
                >
                  <option value="">
                    {t("— தேர்ந்தெடுக்க —", "— Select —")}
                  </option>
                  <option value="kumbabhishekam">
                    {t("கும்பாபிஷேகம்", "Kumbabhishekam")}
                  </option>
                  <option value="annadanam_hall">
                    {t("அன்னதான கூடம் கட்டுமானம்", "Annadanam Hall construction")}
                  </option>
                  <option value="annadanam">
                    {t("அன்னதானம்", "Annadanam")}
                  </option>
                  <option value="abhishekam">
                    {t("அபிஷேகம்", "Abhishekam")}
                  </option>
                  <option value="festival">
                    {t("திருவிழா நிதி", "Festival Fund")}
                  </option>
                  <option value="maintenance">
                    {t("கோயில் பராமரிப்பு", "Temple Maintenance")}
                  </option>
                  <option value="other">{t("மற்றவை", "Other")}</option>
                </select>
              </label>
              <label>
                {t("செய்தி / முகவரி (ரசீதுக்கு)", "Message / Address (for receipt)")}
                <textarea
                  name="message"
                  rows="3"
                  value={form.message}
                  onChange={handleChange}
                />
              </label>
              <button
                type="submit"
                className={`btn btn-primary btn--block${status === "sending" ? " btn--loading" : ""}`}
                disabled={status === "sending"}
                aria-busy={status === "sending"}
              >
                {t("சமர்ப்பி", "Submit")}
              </button>
            </form>
          </div>
        </div>
      </section>
    </>
  );
}
