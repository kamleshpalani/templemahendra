import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import {
  LuArrowRight,
  LuBadgeCheck,
  LuHeartHandshake,
  LuIndianRupee,
  LuLandmark,
  LuListChecks,
  LuMailCheck,
  LuSend,
} from "react-icons/lu";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import { TEMPLE, TRUST, KUMBABHISHEKAM_APPEAL, DONATION_NOTE } from "../data/temple";
import TrustDetails from "../components/TrustDetails/TrustDetails";
import PageHero from "../components/ui/PageHero";
import SectionHeader from "../components/ui/SectionHeader";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field, IconInput, Chip } from "../components/ui/Field";
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

  /** Quick-amount chips route through handleChange so error clearing stays identical. */
  const setAmount = (value) => handleChange({ target: { name: "amount", value: String(value) } });

  const validate = () => {
    const next = {};
    if (form.name.trim().length < 2) next.name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    if (!/^[0-9]{10}$/.test(form.phone))
      next.phone = t("10 இலக்க தொலைபேசி எண் தேவை", "Enter a 10-digit phone number");
    if (!(Number(form.amount) >= 1))
      next.amount = t("தொகையை உள்ளிடவும்", "Enter a donation amount");
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
        t("உங்கள் நன்கொடை பதிவு செய்யப்பட்டது.", "Your donation has been recorded."),
        t("நன்றி!", "Thank you!"),
      );
    } catch {
      setStatus("error");
      toast.error(t("பிழை ஏற்பட்டது. நேரடியாக அழைக்கவும்.", "Something went wrong. Please call us to confirm."));
    }
  };

  const sending = status === "sending";

  /* "What happens next" — every fact comes from data/temple.js (DONATION_NOTE + TRUST.taxExemption). */
  const NEXT_STEPS = [
    {
      key: "transfer",
      Icon: LuLandmark,
      title: t("வங்கி பரிமாற்றம் / காசோலை", "Transfer or cheque"),
      desc: t(DONATION_NOTE.methods.ta, DONATION_NOTE.methods.en),
    },
    {
      key: "pledge",
      Icon: LuHeartHandshake,
      title: t("இங்கே பதிவு செய்யுங்கள்", "Pledge here"),
      desc: t(
        "ரசீது அனுப்ப உங்கள் முழு முகவரியை செய்தியில் குறிப்பிடவும்.",
        "Please include your full postal address in the message so a receipt can be sent.",
      ),
    },
    {
      key: "receipt",
      Icon: LuMailCheck,
      title: t("ரசீது உங்கள் முகவரிக்கு", "Receipt posted to your address"),
      desc: t(DONATION_NOTE.receipt.ta, DONATION_NOTE.receipt.en),
    },
    {
      key: "80g",
      Icon: LuBadgeCheck,
      title: t(TRUST.taxExemption.short.ta, TRUST.taxExemption.short.en),
      desc: t(TRUST.taxExemption.long.ta, TRUST.taxExemption.long.en),
    },
  ];

  return (
    <>
      <Helmet>
        <title>
          {t("நன்கொடை", "Donations")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
      </Helmet>

      <PageHero
        variant="donations"
        eyebrow={
          TRUST.taxExemption
            ? t(TRUST.taxExemption.short.ta, TRUST.taxExemption.short.en)
            : t("நன்கொடை", "Donate")
        }
        title={t("நன்கொடை", "Donations")}
        lead={t(TRUST.name.ta, TRUST.name.en)}
        crumbs={[{ label: t("நன்கொடை", "Donations") }]}
        actions={
          <>
            <Button href="#bank-details" variant="outline-light" icon={<LuLandmark aria-hidden="true" />}>
              {t("வங்கி விவரங்கள்", "Bank details")}
            </Button>
            <Button href="#pledge" variant="gold" icon={<LuHeartHandshake aria-hidden="true" />}>
              {t("நன்கொடை பதிவு", "Pledge")}
            </Button>
          </>
        }
      />

      <section className="section donations">
        <div className="container split donations__split">
          {/* ── Left: intro · appeal · bank details ─────────────────── */}
          <div className="donations__info rise" style={{ "--i": 0 }}>
            <SectionHeader
              align="left"
              eyebrow={t("ஆதரவு", "Support")}
              title={t("உங்கள் ஆதரவு", "Your Support")}
              subtitle={t(
                "உங்கள் நன்கொடை கோயிலை பராமரிக்கவும், அன்னதானம் மற்றும் திருவிழாக்களை நடத்தவும் பெரிதும் உதவுகிறது. ஒவ்வொரு பங்களிப்பும் ஒரு புனித செயல்.",
                "Your donations help maintain the temple, conduct daily rituals, fund festivals, and support the Annadanam (free meal) programme. Every contribution, however small, is a sacred act of devotion.",
              )}
              className="donations__head"
            />

            {/* Kumbabhishekam + buildings appeal (committee letter, §5i) */}
            <aside
              className="card card--ink card--static card--stripe donations-appeal"
              id="kumbabhishekam"
              aria-labelledby="donations-appeal-title"
            >
              <div className="card__body donations-appeal__body">
                <span className="donations-appeal__glyph" aria-hidden="true">
                  🛕
                </span>
                <div className="donations-appeal__text-wrap">
                  <h3 id="donations-appeal-title" className="donations-appeal__title">
                    {t(KUMBABHISHEKAM_APPEAL.heading.ta, KUMBABHISHEKAM_APPEAL.heading.en)}
                  </h3>
                  <p className="donations-appeal__text">{t(KUMBABHISHEKAM_APPEAL.ta, KUMBABHISHEKAM_APPEAL.en)}</p>
                  <Button
                    href="#pledge"
                    variant="outline-light"
                    trailingIcon={<LuArrowRight aria-hidden="true" />}
                    className="donations-appeal__cta"
                  >
                    {t("நன்கொடை பதிவு", "Pledge")}
                  </Button>
                </div>
              </div>
            </aside>

            <h3 className="donations__sub">{t("வங்கி பரிமாற்றம் / காசோலை", "Bank Transfer / Cheque")}</h3>
            <TrustDetails variant="bank" showNote id="bank-details" />

            <p className="donations__more">
              <Link to="/about#trust" className="donations__more-link">
                {t("அறக்கட்டளை பதிவு விவரங்கள் முழுமையாக →", "Full Trust registration details →")}
              </Link>
            </p>
          </div>

          {/* ── Right: pledge form (sticky on desktop) ──────────────── */}
          <div className="split__sticky donations__aside">
            <div className="card card--solid card--static donations-pledge rise" id="pledge" style={{ "--i": 1 }}>
              <SectionHeader
                as="h2"
                align="left"
                eyebrow={t("பதிவு", "Pledge")}
                title={t("நன்கொடை பதிவு", "Register Your Donation")}
                subtitle={t(
                  "ரசீது அனுப்ப உங்கள் முழு முகவரியை செய்தியில் குறிப்பிடவும்.",
                  "Please include your full postal address in the message so a receipt can be sent.",
                )}
                className="donations-pledge__head"
              />

              {status === "success" && (
                <Alert tone="success" onClose={() => setStatus(null)}>
                  <span aria-hidden="true">🙏</span>{" "}
                  {t(
                    "நன்றி! உங்கள் நன்கொடை பதிவு செய்யப்பட்டது.",
                    "Thank you! Your donation has been recorded.",
                  )}
                </Alert>
              )}
              {status === "error" && (
                <Alert tone="error" onClose={() => setStatus(null)}>
                  {t(
                    "பிழை ஏற்பட்டது. நேரடியாக அழைக்கவும்.",
                    "Something went wrong. Please call us to confirm.",
                  )}
                </Alert>
              )}

              <form onSubmit={handleSubmit} noValidate aria-busy={sending} className="donations-pledge__form">
                <Field label={t("முழு பெயர்", "Full Name")} required error={errors.name}>
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
                  label={t("தொலைபேசி எண்", "Phone Number")}
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

                <Field label={t("தொகை (₹)", "Amount (₹)")} required error={errors.amount}>
                  {(a11y) => (
                    <>
                      <IconInput
                        {...a11y}
                        icon={<LuIndianRupee />}
                        required
                        type="number"
                        min="1"
                        name="amount"
                        value={form.amount}
                        onChange={handleChange}
                        inputMode="numeric"
                      />
                      <div
                        className="chip-row donations-pledge__chips"
                        role="group"
                        aria-label={t("விரைவு தொகை", "Quick amounts")}
                      >
                        {QUICK_AMOUNTS.map((amt) => (
                          <Chip
                            key={amt}
                            active={Number(form.amount) === amt}
                            onClick={() => setAmount(amt)}
                            className="donations-pledge__chip"
                          >
                            ₹{amt}
                          </Chip>
                        ))}
                      </div>
                    </>
                  )}
                </Field>

                <Field label={t("நோக்கம்", "Purpose")} optional>
                  {(a11y) => (
                    <select {...a11y} name="purpose" value={form.purpose} onChange={handleChange}>
                      <option value="">{t("— தேர்ந்தெடுக்க —", "— Select —")}</option>
                      <option value="kumbabhishekam">{t("கும்பாபிஷேகம்", "Kumbabhishekam")}</option>
                      <option value="annadanam_hall">
                        {t("அன்னதான கூடம் கட்டுமானம்", "Annadanam Hall construction")}
                      </option>
                      <option value="annadanam">{t("அன்னதானம்", "Annadanam")}</option>
                      <option value="abhishekam">{t("அபிஷேகம்", "Abhishekam")}</option>
                      <option value="festival">{t("திருவிழா நிதி", "Festival Fund")}</option>
                      <option value="maintenance">{t("கோயில் பராமரிப்பு", "Temple Maintenance")}</option>
                      <option value="other">{t("மற்றவை", "Other")}</option>
                    </select>
                  )}
                </Field>

                <Field label={t("செய்தி / முகவரி (ரசீதுக்கு)", "Message / Address (for receipt)")} optional>
                  {(a11y) => (
                    <textarea
                      {...a11y}
                      name="message"
                      rows="3"
                      value={form.message}
                      onChange={handleChange}
                    />
                  )}
                </Field>

                <Button
                  type="submit"
                  variant="primary"
                  block
                  loading={sending}
                  icon={<LuSend aria-hidden="true" />}
                  className="donations-pledge__submit"
                >
                  {t("சமர்ப்பி", "Submit")}
                </Button>
              </form>
            </div>

            {/* ── What happens next ───────────────────────────────── */}
            <aside className="callout donations-next rise" style={{ "--i": 2 }} aria-labelledby="donations-next-title">
              <LuListChecks aria-hidden="true" />
              <div className="donations-next__body">
                <h3 id="donations-next-title" className="donations-next__title">
                  {t("அடுத்து என்ன?", "What happens next")}
                </h3>
                <ol className="donations-next__steps">
                  {NEXT_STEPS.map(({ key, Icon, title, desc }, i) => (
                    <li key={key} className="donations-next__step">
                      <span className="donations-next__num" aria-hidden="true">
                        {i + 1}
                      </span>
                      <div className="donations-next__copy">
                        <strong className="donations-next__step-title">
                          <Icon aria-hidden="true" />
                          {title}
                        </strong>
                        <span className="donations-next__step-desc">{desc}</span>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </aside>
          </div>
        </div>
      </section>
    </>
  );
}
