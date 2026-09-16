import { useState } from "react";
import { LuMail } from "react-icons/lu";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import { Field } from "../ui/Field";
import { useLang, rateLimitInfo, rateLimitMessage } from "../../context/LangContext";
import { postJson } from "../../lib/payments";

/**
 * EmailReceiptForm — "send me the receipt" (docs/payments/SPEC.md §5.5, §7.4).
 *
 * When the donation already carries an email address the server shows it back
 * masked, and one button is enough. When it does not, the address is asked for
 * here and the server saves it with the donation, so a later resend needs no
 * asking. Either way the address is never guessed and never shown in full.
 */
export default function EmailReceiptForm({ number, token, email, className = "" }) {
  const { t } = useLang();
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState(null); // null | sending | sent | error | limited | off | invalid
  const [sentTo, setSentTo] = useState(email ?? null);
  const [fieldError, setFieldError] = useState("");
  const [retryAfter, setRetryAfter] = useState(null);

  const send = async () => {
    if (status === "sending") return;
    setStatus("sending");
    setFieldError("");
    const body = { ref: number, t: token };
    if (!email) body.email = address.trim();
    const res = await postJson("/api/payments/receipt-email", body);

    if (res.ok && res.body?.success) {
      setSentTo(res.body.email ?? email ?? address.trim());
      setStatus("sent");
      return;
    }
    const limited = rateLimitInfo(res.status, res.body, res.retryAfterHeader);
    if (limited) {
      setRetryAfter(limited.retryAfter);
      setStatus("limited");
      return;
    }
    if (res.status === 422 && res.body?.fields?.email) {
      setFieldError(t("சரியான மின்னஞ்சல் முகவரியை உள்ளிடவும்.", "Enter a valid email address."));
      setStatus("invalid");
      return;
    }
    setStatus(res.body?.code === "email_off" ? "off" : "error");
  };

  if (status === "sent") {
    return (
      <Alert tone="success" className={`pay-email ${className}`.trim()}>
        {t(`ரசீது ${sentTo} முகவரிக்கு அனுப்பப்படுகிறது.`, `The receipt is on its way to ${sentTo}.`)}
      </Alert>
    );
  }

  return (
    <div className={`pay-email ${className}`.trim()}>
      {email ? (
        <Button
          variant="outline"
          icon={<LuMail aria-hidden="true" />}
          loading={status === "sending"}
          onClick={send}
        >
          {t(`${email} முகவரிக்கு அனுப்பு`, `Email it to ${email}`)}
        </Button>
      ) : (
        <form
          className="pay-email__form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Field
            id="pay-receipt-email"
            label={t("ரசீதை மின்னஞ்சலில் பெற", "Email me the receipt")}
            error={fieldError || undefined}
            hint={t("உங்கள் மின்னஞ்சல் ரசீதுடன் சேமிக்கப்படும்.", "Your address is saved with the receipt.")}
          >
            {(a11y) => (
              <input
                {...a11y}
                type="email"
                name="email"
                value={address}
                autoComplete="email"
                maxLength={190}
                onChange={(e) => {
                  setAddress(e.target.value);
                  if (fieldError) setFieldError("");
                }}
              />
            )}
          </Field>
          <Button type="submit" variant="outline" icon={<LuMail aria-hidden="true" />} loading={status === "sending"}>
            {t("அனுப்பு", "Send")}
          </Button>
        </form>
      )}

      {status === "limited" && <Alert tone="warning">{rateLimitMessage(t, retryAfter)}</Alert>}
      {status === "off" && (
        <Alert tone="info">
          {t(
            "மின்னஞ்சல் ரசீதுகள் இப்போது இயக்கத்தில் இல்லை. இந்தப் பக்கத்தை அச்சிட்டு வைத்துக்கொள்ளலாம்.",
            "Email receipts are switched off right now. You can print this page instead.",
          )}
        </Alert>
      )}
      {status === "error" && (
        <Alert tone="error">
          {t(
            "ரசீதை அனுப்ப இயலவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
            "We could not send the receipt. Please try again later, or call the temple office.",
          )}
        </Alert>
      )}
    </div>
  );
}
