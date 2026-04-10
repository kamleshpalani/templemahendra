import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { useLang } from "../context/LangContext";
import "./PageCommon.css";
import "./Donations.css";

export default function Donations() {
  const { t } = useLang();
  const [form, setForm] = useState({
    name: "",
    phone: "",
    amount: "",
    purpose: "",
    message: "",
  });
  const [status, setStatus] = useState(null);

  const handleChange = (e) =>
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
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
    } catch {
      setStatus("error");
    }
  };

  return (
    <>
      <Helmet>
        <title>
          {t("நன்கொடை", "Donations")} —{" "}
          {t("ஸ்ரீ மகேந்திர ஆலயம்", "Sri Mahendra Temple")}
        </title>
      </Helmet>

      <div className="page-hero page-hero--donations">
        <div className="page-hero__content">
          <h1>{t("நன்கொடை", "Donations")}</h1>
        </div>
      </div>

      <section className="section">
        <div className="container donations-layout">
          <div className="donations-info">
            <h2>{t("உங்கள் ஆதரவு", "Your Support")}</h2>
            <p>
              {t(
                "உங்கள் நன்கொடை கோயிலை பராமரிக்கவும், அன்னதானம் மற்றும் திருவிழாக்களை நடத்தவும் பெரிதும் உதவுகிறது. ஒவ்வொரு பங்களிப்பும் ஒரு புனித செயல்.",
                "Your donations help maintain the temple, conduct daily rituals, fund festivals, and support the Annadanam (free meal) programme. Every contribution, however small, is a sacred act of devotion.",
              )}
            </p>
            <h3>{t("வங்கி பரிமாற்றம்", "Bank Transfer")}</h3>
            <div className="bank-details">
              <div>
                <strong>Account Name:</strong> Sri Mahendra Temple Trust
              </div>
              <div>
                <strong>Account No:</strong> XXXX XXXX XXXX
              </div>
              <div>
                <strong>IFSC:</strong> XXXXXXXXX
              </div>
              <div>
                <strong>Bank:</strong> State Bank of India
              </div>
            </div>
            <h3>UPI</h3>
            <p>
              {t("UPI ஐடி:", "UPI ID:")} <strong>templemahendra@upi</strong>
            </p>
          </div>

          <div className="donations-form card">
            <h3>{t("நன்கொடை பதிவு", "Register Your Donation")}</h3>
            {status === "success" && (
              <p className="form-success">
                🙏{" "}
                {t(
                  "நன்றி! உங்கள் நன்கொடை பதிவு செய்யப்பட்டது.",
                  "Thank you! Your donation has been recorded.",
                )}
              </p>
            )}
            {status === "error" && (
              <p className="form-error">
                {t(
                  "பிழை ஏற்பட்டது. நேரடியாக அழைக்கவும்.",
                  "Something went wrong. Please call us to confirm.",
                )}
              </p>
            )}
            <form onSubmit={handleSubmit} noValidate>
              <label>
                {t("முழு பெயர் *", "Full Name *")}
                <input
                  required
                  name="name"
                  value={form.name}
                  onChange={handleChange}
                />
              </label>
              <label>
                {t("தொலைபேசி எண் *", "Phone Number *")}
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
                {t("தொகை (₹) *", "Amount (₹) *")}
                <input
                  required
                  type="number"
                  min="1"
                  name="amount"
                  value={form.amount}
                  onChange={handleChange}
                />
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
                {t("செய்தி (விருப்பமானால்)", "Message (optional)")}
                <textarea
                  name="message"
                  rows="3"
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
                  ? t("சமர்ப்பிக்கிறது…", "Submitting…")
                  : t("சமர்ப்பி", "Submit")}
              </button>
            </form>
          </div>
        </div>
      </section>
    </>
  );
}
