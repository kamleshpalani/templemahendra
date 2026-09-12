import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { LuKeyRound } from "react-icons/lu";
import AuthShell from "../components/Auth/AuthShell";
import PasswordRules, { passwordProblem } from "../components/Auth/PasswordRules";
import { AccountsOff } from "./Login";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field, PasswordInput } from "../components/ui/Field";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";

export default function ResetPassword() {
  const { t } = useLang();
  const { reset, accountsEnabled } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [form, setForm] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [problem, setProblem] = useState(null);
  const [spent, setSpent] = useState(false); // the link itself is no longer usable
  const [busy, setBusy] = useState(false);

  const change = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((x) => ({ ...x, [name]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    const next = {};
    const pp = passwordProblem(form.password);
    if (pp) next.password = pp;
    if (form.confirm !== form.password) {
      next.confirm = t("இரண்டு கடவுச்சொற்களும் ஒன்றாக இல்லை", "The two passwords do not match");
    }
    setErrors(next);
    if (Object.keys(next).length) return;

    setBusy(true);
    setProblem(null);
    try {
      await reset(token, form.password);
      toast.success(
        t("புதிய கடவுச்சொல் சேமிக்கப்பட்டது.", "Your new password is saved."),
        t("முடிந்தது", "Done"),
      );
      navigate("/account", { replace: true });
    } catch (err) {
      setProblem(err.message);
      setErrors(err.fields ?? {});
      // The server spends the token even when the new password is rejected, so
      // say so rather than let someone retype into a link that cannot work.
      if (err.code === "token_invalid" || err.code === "weak_password") setSpent(true);
    } finally {
      setBusy(false);
    }
  };

  if (!accountsEnabled) return <AccountsOff />;

  const noToken = !/^[a-f0-9]{64}$/.test(token);

  if (noToken) {
    return (
      <AuthShell
        eyebrow={t("கடவுச்சொல் மீட்பு", "Password reset")}
        title={t("இந்த இணைப்பு முழுமையாக இல்லை", "That link is incomplete")}
        docTitle={t("கடவுச்சொல் மீட்பு", "Reset password")}
        foot={
          <span>
            <Link to="/forgot-password">{t("புதிய இணைப்பு கேட்க", "Request a new link")}</Link> ·{" "}
            <Link to="/login">{t("உள்நுழைக", "Sign in")}</Link>
          </span>
        }
      >
        <Alert tone="warning">
          {t(
            "மின்னஞ்சலில் உள்ள முழு இணைப்பையும் திறக்கவும். சில மின்னஞ்சல் செயலிகள் நீண்ட இணைப்பை உடைத்துவிடும்.",
            "Open the whole link from the email. Some mail apps break long links across lines.",
          )}
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow={t("கடவுச்சொல் மீட்பு", "Password reset")}
      title={t("புதிய கடவுச்சொல் அமைக்கவும்", "Set a new password")}
      lead={t(
        "அமைத்த உடன் உள்நுழைந்துவிடுவீர்கள்.",
        "You will be signed in as soon as it is saved.",
      )}
      docTitle={t("புதிய கடவுச்சொல்", "Set a new password")}
      foot={
        <span>
          {t("இணைப்பு காலாவதியாகிவிட்டதா?", "Link expired?")}{" "}
          <Link to="/forgot-password">{t("புதியது கேட்கவும்", "Request a new one")}</Link>
        </span>
      }
    >
      {problem && (
        <Alert tone={spent ? "warning" : "error"} onClose={spent ? undefined : () => setProblem(null)}>
          {problem}
        </Alert>
      )}

      {spent ? (
        <Button to="/forgot-password" variant="primary" size="lg" block icon={<LuKeyRound aria-hidden="true" />}>
          {t("புதிய இணைப்பு கேட்க", "Request a new link")}
        </Button>
      ) : (
        <form onSubmit={submit} noValidate>
          <Field label={t("புதிய கடவுச்சொல்", "New password")} required error={errors.password}>
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
          <PasswordRules value={form.password} />

          <Field label={t("மீண்டும் உள்ளிடவும்", "Repeat the password")} required error={errors.confirm}>
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

          <Button type="submit" variant="primary" size="lg" block loading={busy} icon={<LuKeyRound aria-hidden="true" />}>
            {t("கடவுச்சொல்லை சேமி", "Save new password")}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
