import { useState } from "react";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import { Field } from "../ui/Field";
import { postJson } from "../../lib/payments";
import { rateLimitInfo, rateLimitMessage } from "../../context/LangContext";

export default function NotifyForm({ stream, lang, t }) {
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError("");
    const res = await postJson("/api/live-subscriptions", {
      slug: stream.slug, email: email.trim(), lang, consent, hp_token: honeypot,
    });
    setSending(false);
    if (res.ok && res.body?.success) {
      setSaved(true);
      setEmail("");
      return;
    }
    const limited = rateLimitInfo(res.status, res.body, res.retryAfterHeader);
    setError(limited
      ? rateLimitMessage(t, limited.retryAfter)
      : res.status === 404
        ? t("இந்த ஒளிபரப்பிற்கு நினைவூட்டல் கிடைக்கவில்லை.", "Reminders are no longer available for this broadcast.")
        : t("நினைவூட்டலைச் சேமிக்க முடியவில்லை. பின்னர் முயற்சிக்கவும்.", "Could not save your reminder. Please try again later."));
  };

  if (saved) return (
    <Alert tone="success">
      {t(
        "கோரிக்கை பெறப்பட்டது. இந்த ஒளிபரப்பிற்கு முன்பு விலகவில்லை என்றால், தொடங்குவதற்கு முன் மின்னஞ்சல் நினைவூட்டல் வரும்.",
        "Request received. Unless you previously unsubscribed from this broadcast, we’ll email a reminder near its scheduled start.",
      )}
    </Alert>
  );

  return (
    <form className="live-notify" onSubmit={submit}>
      {error && <Alert tone="error" role="alert">{error}</Alert>}
      <Field label={t("மின்னஞ்சல்", "Email")} required>
        {(a11y) => <input {...a11y} type="email" name="email" autoComplete="email" required maxLength={190} value={email} onChange={(event) => setEmail(event.target.value)} />}
      </Field>
      <div className="visually-hidden" aria-hidden="true">
        <label>
          Leave this field empty
          <input name="hp_token" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(event) => setHoneypot(event.target.value)} />
        </label>
      </div>
      <label className="live-notify__consent">
        <input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>{t("இந்த ஒளிபரப்பிற்கான மின்னஞ்சல் நினைவூட்டலுக்கு ஒப்புக்கொள்கிறேன்.", "I agree to an email reminder for this broadcast.")}</span>
      </label>
      <p>{t("மின்னஞ்சலில் உள்ள இணைப்பில் விலகலாம். கணக்கு தேவையில்லை.", "Unsubscribe using the link in the email. No account is needed.")}</p>
      <Button type="submit" variant="primary" loading={sending}>
        {t("நினைவூட்டலைச் சேமி", "Save reminder")}
      </Button>
    </form>
  );
}
