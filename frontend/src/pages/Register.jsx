import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { LuMail, LuMailCheck, LuPhone, LuTriangleAlert, LuUser, LuUserPlus } from "react-icons/lu";
import AuthShell from "../components/Auth/AuthShell";
import PasswordRules, { passwordProblem } from "../components/Auth/PasswordRules";
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

  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
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
    const digits = form.phone.replace(/\D+/g, "");
    if (digits && !/^\d{7,15}$/.test(digits)) {
      next.phone = t("7 முதல் 15 இலக்கங்கள்", "Use 7 to 15 digits, or leave it blank");
    }
    const pp = passwordProblem(form.password, form.email.trim());
    if (pp) next.password = pp;
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setProblem(null);
    try {
      const data = await register({
        name: form.name.trim(),
        email: form.email.trim(),
        phone: digits,
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
        "பெயர், மின்னஞ்சல், கடவுச்சொல் — அதுமட்டும் போதும்.",
        "Your name, an email address and a password. That is all we keep.",
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

        <Field label={t("தொலைபேசி", "Phone")} optional error={errors.phone}>
          {(a11y) => (
            <span className="input-affix input-affix--leading">
              <span className="input-affix__icon" aria-hidden="true">
                <LuPhone />
              </span>
              <input
                {...a11y}
                type="tel"
                name="phone"
                value={form.phone}
                onChange={change}
                inputMode="numeric"
                autoComplete="tel"
                placeholder="9999999999"
              />
            </span>
          )}
        </Field>

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

        <p className="authx__privacy">
          <LuTriangleAlert aria-hidden="true" />
          <span>
            {t(
              "கோயில் குழு உங்கள் பெயர், மின்னஞ்சல், தொலைபேசி மட்டும் வைத்திருக்கும். கடவுச்சொல் என்றும் படிக்க முடியாதவாறு சேமிக்கப்படுகிறது.",
              "The committee keeps only your name, email and phone. Your password is stored so that nobody, including us, can read it.",
            )}
          </span>
        </p>

        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={<LuUserPlus aria-hidden="true" />}>
          {t("கணக்கு உருவாக்கு", "Create account")}
        </Button>
      </form>
    </AuthShell>
  );
}
