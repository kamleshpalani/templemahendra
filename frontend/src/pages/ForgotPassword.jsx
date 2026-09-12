import { useState } from "react";
import { Link } from "react-router-dom";
import { LuKeyRound, LuMail } from "react-icons/lu";
import AuthShell from "../components/Auth/AuthShell";
import { AccountsOff } from "./Login";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field } from "../components/ui/Field";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";

export default function ForgotPassword() {
  const { t } = useLang();
  const { forgot, accountsEnabled } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setError(t("சரியான மின்னஞ்சலை உள்ளிடவும்", "Enter a valid email address"));
      return;
    }
    setError(null);
    setProblem(null);
    setBusy(true);
    try {
      setSent(await forgot(email.trim()));
    } catch (err) {
      setProblem(err.message);
      if (err.fields?.email) setError(err.fields.email);
    } finally {
      setBusy(false);
    }
  };

  if (!accountsEnabled) return <AccountsOff />;

  if (sent) {
    return (
      <AuthShell
        eyebrow={t("கடவுச்சொல் மீட்பு", "Password reset")}
        title={t("உங்கள் மின்னஞ்சலை சரிபார்க்கவும்", "Check your email")}
        docTitle={t("கடவுச்சொல் மீட்பு", "Password reset")}
        foot={
          <span>
            {t("நினைவுக்கு வந்துவிட்டதா?", "Remembered it?")}{" "}
            <Link to="/login">{t("உள்நுழைக", "Sign in")}</Link>
          </span>
        }
      >
        <Alert tone="success">
          {t(
            "அந்த மின்னஞ்சலுக்கு கணக்கு இருந்தால், மீட்பு இணைப்பு அனுப்பப்பட்டுள்ளது. ஸ்பேம் கோப்புறையையும் பாருங்கள்.",
            "If that address has an account, a reset link is on its way. Do check your spam folder.",
          )}
        </Alert>
        <p className="authx__aside-note">
          {t(
            "இணைப்பு ஒரு மணி நேரம் வேலை செய்யும், ஒரு முறை மட்டும்.",
            "The link works for one hour and can be used once.",
          )}
          {sent.emailDelivery === "unavailable" && (
            <>
              {" "}
              {t(
                "சேவையகத்தில் மின்னஞ்சல் தற்போது செயல்படவில்லை என்றால், கோயில் அலுவலகத்தை தொடர்பு கொள்ளுங்கள்.",
                "If nothing arrives, email on the server may not be configured — please contact the temple office.",
              )}
            </>
          )}
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow={t("கடவுச்சொல் மீட்பு", "Password reset")}
      title={t("கடவுச்சொல்லை மீட்டமைக்க", "Reset your password")}
      lead={t(
        "கணக்கின் மின்னஞ்சலை உள்ளிடுங்கள். புதிய கடவுச்சொல் அமைக்க ஒரு இணைப்பு அனுப்புவோம்.",
        "Give us the email address on your account and we will send a link to set a new password.",
      )}
      docTitle={t("கடவுச்சொல் மீட்பு", "Forgot password")}
      foot={
        <div className="authx__foot-row">
          <span>
            {t("நினைவுக்கு வந்ததா?", "Remembered it?")} <Link to="/login">{t("உள்நுழைக", "Sign in")}</Link>
          </span>
          <Link to="/register">{t("புதிய கணக்கு", "Create an account")}</Link>
        </div>
      }
    >
      {problem && !error && (
        <Alert tone="error" onClose={() => setProblem(null)}>
          {problem}
        </Alert>
      )}

      <form onSubmit={submit} noValidate>
        <Field label={t("மின்னஞ்சல்", "Email address")} required error={error}>
          {(a11y) => (
            <span className="input-affix input-affix--leading">
              <span className="input-affix__icon" aria-hidden="true">
                <LuMail />
              </span>
              <input
                {...a11y}
                required
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck="false"
                placeholder="you@example.com"
              />
            </span>
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={<LuKeyRound aria-hidden="true" />}>
          {t("மீட்பு இணைப்பு அனுப்பு", "Send reset link")}
        </Button>
      </form>
    </AuthShell>
  );
}
