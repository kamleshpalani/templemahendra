import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { LuLogIn, LuMail } from "react-icons/lu";
import AuthShell from "../components/Auth/AuthShell";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field, PasswordInput } from "../components/ui/Field";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";

export default function Login() {
  const { t } = useLang();
  const { login, user, ready, accountsEnabled } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);

  // Where a guarded route sent them from, so they land back on it.
  const target = location.state?.from ?? "/account";

  useEffect(() => {
    if (ready && user) navigate(target, { replace: true });
  }, [ready, user, target, navigate]);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((x) => ({ ...x, [name]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    if (!form.email.trim()) next.email = t("மின்னஞ்சலை உள்ளிடவும்", "Enter your email address");
    if (!form.password) next.password = t("கடவுச்சொல்லை உள்ளிடவும்", "Enter your password");
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setProblem(null);
    try {
      const data = await login(form.email.trim(), form.password);
      toast.success(
        t(`வணக்கம், ${data.user.name}`, `Welcome back, ${data.user.name}`),
        t("உள்நுழைந்தீர்கள்", "Signed in"),
      );
      navigate(target, { replace: true });
    } catch (err) {
      setProblem(err.message);
      setErrors(err.fields ?? {});
    } finally {
      setBusy(false);
    }
  };

  if (!accountsEnabled) return <AccountsOff />;

  return (
    <AuthShell
      eyebrow={t("கணக்கு", "Account")}
      title={t("மீண்டும் வரவேற்கிறோம்", "Welcome back")}
      lead={t(
        "உங்கள் சேவை பதிவுகளையும் நன்கொடைகளையும் காண உள்நுழையுங்கள்.",
        "Sign in to see your seva bookings and offerings.",
      )}
      docTitle={t("உள்நுழைவு", "Sign in")}
      foot={
        <>
          <div className="authx__foot-row">
            <span>
              {t("கணக்கு இல்லையா?", "No account yet?")} <Link to="/register">{t("பதிவு செய்யுங்கள்", "Create one")}</Link>
            </span>
            <Link to="/forgot-password">{t("கடவுச்சொல்லை மறந்தீர்களா?", "Forgot your password?")}</Link>
          </div>
          <span>
            {t("கணக்கு இல்லாமலும் ", "You can also ")}
            <Link to="/sevas">{t("சேவை பதிவு செய்யலாம்", "book a seva without an account")}</Link>.
          </span>
        </>
      }
    >
      {problem && (
        <Alert tone="error" onClose={() => setProblem(null)}>
          {problem}
        </Alert>
      )}

      <form onSubmit={submit} noValidate>
        <Field label={t("மின்னஞ்சல்", "Email address")} required error={errors.email}>
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

        <Field label={t("கடவுச்சொல்", "Password")} required error={errors.password}>
          {(a11y) => (
            <PasswordInput
              {...a11y}
              required
              name="password"
              value={form.password}
              onChange={change}
              autoComplete="current-password"
            />
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={busy} icon={<LuLogIn aria-hidden="true" />}>
          {t("உள்நுழை", "Sign in")}
        </Button>
      </form>
    </AuthShell>
  );
}

/** Shown when the devotee-account tables have not been migrated in yet. */
export function AccountsOff() {
  const { t } = useLang();
  return (
    <AuthShell
      eyebrow={t("கணக்கு", "Account")}
      title={t("கணக்குகள் இன்னும் இயக்கப்படவில்லை", "Accounts are not switched on yet")}
      docTitle={t("கணக்கு", "Account")}
      foot={
        <span>
          <Link to="/sevas">{t("சேவை பதிவு", "Book a seva")}</Link> ·{" "}
          <Link to="/contact">{t("தொடர்பு", "Contact the temple")}</Link>
        </span>
      }
    >
      <Alert tone="info">
        {t(
          "கோயில் கணக்கு வசதி விரைவில் வரும். அதுவரை கணக்கு இல்லாமல் சேவை பதிவு செய்யலாம்.",
          "Temple accounts are coming soon. Until then you can book a seva without one.",
        )}
      </Alert>
    </AuthShell>
  );
}
