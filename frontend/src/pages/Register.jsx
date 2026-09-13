import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LuBuilding2, LuMail, LuMailCheck, LuUser, LuUserPlus } from "react-icons/lu";
import AuthShell from "../components/Auth/AuthShell";
import PasswordRules, { passwordProblem } from "../components/Auth/PasswordRules";
import PhoneInput from "../components/ui/PhoneInput";
import CountrySelect from "../components/ui/CountrySelect";
import StateSelect from "../components/ui/StateSelect";
import { hasSubdivisions, phoneProblem, subdivisionLabel, toE164 } from "../lib/phone";
import { DEFAULT_COUNTRY } from "../data/countries";
import { AccountsOff } from "./Login";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field, PasswordInput } from "../components/ui/Field";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";

export default function Register() {
  const { t } = useLang();
  const { register, user, ready, accountsEnabled } = useAuth();
  const navigate = useNavigate();

  // The country is part of the phone value, not a guess made from the digits.
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    phoneCountry: DEFAULT_COUNTRY,
    // India by default: that is where the temple is and where most devotees
    // are. Anyone elsewhere changes it in one click, and the phone country
    // follows along until they start typing a number.
    country: DEFAULT_COUNTRY,
    state: "",
    city: "",
    password: "",
    confirm: "",
  });
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null); // the server's reply once registered

  useEffect(() => {
    if (ready && user) navigate("/account", { replace: true });
  }, [ready, user, navigate]);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((x) => ({ ...x, [name]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (form.name.trim().length < 2) next.name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) {
      next.email = t("சரியான மின்னஞ்சலை உள்ளிடவும்", "Enter a valid email address");
    }
    // Required, and judged by the selected country's own length rather than one
    // country's rule imposed on everyone.
    const pe = phoneProblem(form.phone, form.phoneCountry, { required: true });
    if (pe) next.phone = pe;
    if (!form.country) next.country = t("நாட்டைத் தேர்ந்தெடுக்கவும்", "Choose your country");
    // The state is only asked for where the site has a list to offer; elsewhere
    // it is a free-text line people may reasonably leave blank.
    if (hasSubdivisions(form.country) && !form.state) {
      next.state = t("தேர்ந்தெடுக்கவும்", `Choose your ${subdivisionLabel(form.country, (ta, en) => en).toLowerCase()}`);
    }
    if (form.city.trim().length < 2) next.city = t("நகரத்தை உள்ளிடவும்", "Please enter your city or town");
    const pp = passwordProblem(form.password, form.email.trim());
    if (pp) next.password = pp;
    if (form.confirm !== form.password) {
      next.confirm = t("இரண்டு கடவுச்சொற்களும் ஒன்றாக இல்லை", "The two passwords do not match");
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setProblem(null);
    try {
      const data = await register({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: toE164(form.phone, form.phoneCountry),
        phoneCountry: form.phoneCountry,
        country: form.country,
        state: form.state.trim(),
        city: form.city.trim(),
        password: form.password,
      });
      setDone(data);
    } catch (err) {
      setProblem(err.message);
      setErrors(err.fields ?? {});
    } finally {
      setBusy(false);
    }
  };

  if (!accountsEnabled) return <AccountsOff />;

  /* ── After registering ─────────────────────────────────────────── */
  if (done) {
    const mailWorked = done.emailDelivery === "sent";
    return (
      <AuthShell
        eyebrow={t("கணக்கு உருவாக்கப்பட்டது", "Account created")}
        title={t("உங்கள் மின்னஞ்சலை சரிபார்க்கவும்", "Check your email")}
        docTitle={t("பதிவு முடிந்தது", "Registered")}
        foot={
          <span>
            {t("மின்னஞ்சல் வரவில்லையா?", "Email not arrived?")}{" "}
            <Link to="/login">{t("நேரடியாக உள்நுழையுங்கள்", "Sign in anyway")}</Link>{" "}
            {t("— பின்னர் மீண்டும் அனுப்பலாம்.", "— you can resend it from your account.")}
          </span>
        }
      >
        <Alert tone={mailWorked ? "success" : "warning"} title={mailWorked ? undefined : t("கவனம்", "One thing")}>
          {mailWorked ? (
            <>
              {t("உறுதிப்படுத்தும் இணைப்பை ", "We sent a confirmation link to ")}
              <strong>{form.email.trim()}</strong>
              {t(" க்கு அனுப்பியுள்ளோம். ஸ்பேம் கோப்புறையையும் பாருங்கள்.", ". Do check your spam folder too.")}
            </>
          ) : (
            t(
              "கோயில் சேவையகத்தில் மின்னஞ்சல் இப்போது அனுப்ப முடியவில்லை. கணக்கு உருவாக்கப்பட்டுவிட்டது — நேரடியாக உள்நுழையலாம்.",
              "The server could not send email just now. Your account exists, so sign in directly and confirm your address later.",
            )
          )}
        </Alert>

        {/* The address is shown whatever happened to the email, and called out
            as the one to sign in with. A mistyped address is otherwise a dead
            end: sign-in and password reset both answer vaguely on purpose, so
            nothing downstream can tell the devotee they typed it wrong. */}
        <p className="authx__whoami">
          {t("உள்நுழையும்போது இதைப் பயன்படுத்துங்கள்:", "Sign in with this address:")}{" "}
          <strong>{form.email.trim()}</strong>
          <br />
          <span className="authx__whoami-note">
            {t(
              "தவறாக இருந்தால், சரியான முகவரியுடன் மீண்டும் பதிவு செய்யுங்கள்.",
              "If that is not right, register again with the correct address.",
            )}
          </span>
        </p>

        <div className="authx__next">
          <Button to="/login" variant="primary" size="lg" block icon={<LuMailCheck aria-hidden="true" />}>
            {t("உள்நுழைவு பக்கம்", "Go to sign in")}
          </Button>
          <Button to="/sevas" variant="outline" block>
            {t("சேவைகளை பார்க்க", "Browse sevas")}
          </Button>
        </div>
      </AuthShell>
    );
  }

  /* ── The form ──────────────────────────────────────────────────── */
  return (
    <AuthShell
      eyebrow={t("புதிய கணக்கு", "New account")}
      title={t("கோயில் கணக்கு தொடங்குங்கள்", "Create your temple account")}
      lead={t(
        "பெயர், மின்னஞ்சல், தொலைபேசி, ஊர் — அதுமட்டும் போதும்.",
        "Your name, how to reach you, and where you are. That is all we keep.",
      )}
      docTitle={t("பதிவு", "Register")}
      foot={
        <div className="authx__foot-row">
          <span>
            {t("ஏற்கனவே கணக்கு உள்ளதா?", "Already have an account?")}{" "}
            <Link to="/login">{t("உள்நுழைக", "Sign in")}</Link>
          </span>
        </div>
      }
    >
      {problem && (
        <Alert tone="error" onClose={() => setProblem(null)}>
          {problem}
        </Alert>
      )}

      <form onSubmit={submit} noValidate>
        <Field label={t("பெயர்", "Full name")} required error={errors.name}>
          {(a11y) => (
            <span className="input-affix input-affix--leading">
              <span className="input-affix__icon" aria-hidden="true">
                <LuUser />
              </span>
              <input {...a11y} required name="name" value={form.name} onChange={change} autoComplete="name" />
            </span>
          )}
        </Field>

        <Field
          label={t("மின்னஞ்சல்", "Email address")}
          required
          error={errors.email}
          hint={t("உறுதிப்படுத்தல் இங்கே வரும்", "Your confirmation and receipts come here")}
        >
          {(a11y) => (
            <span className="input-affix input-affix--leading">
              <span className="input-affix__icon" aria-hidden="true">
                <LuMail />
              </span>
              <input
                {...a11y}
                required
                type="email"
                name="email"
                value={form.email}
                onChange={change}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck="false"
                placeholder="you@example.com"
              />
            </span>
          )}
        </Field>

        {/* Credentials sit directly under the address they belong to, before the
            contact details, so the account itself is settled in one pass. */}
        <Field label={t("கடவுச்சொல்", "Password")} required error={errors.password}>
          {(a11y) => (
            <PasswordInput
              {...a11y}
              required
              name="password"
              value={form.password}
              onChange={change}
              autoComplete="new-password"
            />
          )}
        </Field>
        <PasswordRules value={form.password} identity={form.email} />

        <Field label={t("கடவுச்சொல்லை உறுதிப்படுத்தவும்", "Confirm password")} required error={errors.confirm}>
          {(a11y) => (
            <PasswordInput
              {...a11y}
              required
              name="confirm"
              value={form.confirm}
              onChange={change}
              autoComplete="new-password"
            />
          )}
        </Field>

        <Field
          label={t("தொலைபேசி", "Phone")}
          required
          error={errors.phone}
          hint={t(
            "நாட்டைத் தேர்ந்தெடுத்து, முன்னால் உள்ள 0 இல்லாமல் எண்ணை உள்ளிடவும்",
            "Pick the country, then type the number without its leading 0",
          )}
        >
          {(a11y) => (
            <PhoneInput
              {...a11y}
              required
              name="phone"
              country={form.phoneCountry}
              national={form.phone}
              onChange={({ country, national }) => {
                setForm((f) => ({ ...f, phoneCountry: country, phone: national }));
                if (errors.phone) setErrors((x) => ({ ...x, phone: undefined }));
              }}
            />
          )}
        </Field>

        {/* State, city, then country — the order an address is written. The
            state list depends on the country, so changing the country clears a
            state chosen above it; the default below covers most devotees. */}
        <div className="field-row">
          <Field
            label={subdivisionLabel(form.country, t)}
            required={hasSubdivisions(form.country)}
            optional={!hasSubdivisions(form.country)}
            error={errors.state}
          >
            {(a11y) => (
              <StateSelect
                {...a11y}
                country={form.country}
                value={form.state}
                onChange={(next) => {
                  setForm((f) => ({ ...f, state: next }));
                  if (errors.state) setErrors((x) => ({ ...x, state: undefined }));
                }}
              />
            )}
          </Field>

          <Field label={t("நகரம்", "City or town")} required error={errors.city}>
            {(a11y) => (
              <span className="input-affix input-affix--leading">
                <span className="input-affix__icon" aria-hidden="true">
                  <LuBuilding2 />
                </span>
                <input
                  {...a11y}
                  required
                  name="city"
                  value={form.city}
                  onChange={change}
                  autoComplete="address-level2"
                  maxLength={120}
                />
              </span>
            )}
          </Field>

          <Field label={t("நாடு", "Country")} required error={errors.country}>
            {(a11y) => (
              <CountrySelect
                {...a11y}
                value={form.country}
                onChange={(iso2) =>
                  setForm((f) => ({
                    ...f,
                    country: iso2,
                    // The old state belongs to the old country's list, so it
                    // cannot carry over.
                    state: "",
                    // Until the devotee types a number, keep its country in step
                    // with where they live — right far more often than not, and
                    // still theirs to change.
                    phoneCountry: f.phone ? f.phoneCountry : iso2,
                  }))
                }
              />
            )}
          </Field>
        </div>

        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={<LuUserPlus aria-hidden="true" />}>
          {t("கணக்கு உருவாக்கு", "Create account")}
        </Button>
      </form>
    </AuthShell>
  );
}
