import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LuCircleCheck, LuMailCheck } from "react-icons/lu";
import AuthShell from "../components/Auth/AuthShell";
import { AccountsOff } from "./Login";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { PageLoader } from "../components/ui/Feedback";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";

/**
 * /verify-email?token=… — consumes the confirmation token from the email.
 *
 * The token is single-use, so this must fire exactly once. React 18 StrictMode
 * runs effects twice in development, which would spend the token on the first
 * pass and then report failure on the second; the ref guards against that.
 */
export default function VerifyEmail() {
  const { t } = useLang();
  const { verify, accountsEnabled, ready } = useAuth();
  const [state, setState] = useState("working"); // working | done | failed | no-token
  const [message, setMessage] = useState("");
  const fired = useRef(false);

  useEffect(() => {
    if (!ready || fired.current) return;
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setState("no-token");
      return;
    }
    fired.current = true;
    verify(token)
      .then((data) => {
        setState("done");
        setMessage(data.message ?? "");
      })
      .catch((err) => {
        setState("failed");
        setMessage(err.message);
      });
  }, [ready, verify]);

  if (!accountsEnabled) return <AccountsOff />;

  const shell = {
    eyebrow: t("மின்னஞ்சல் உறுதிப்படுத்தல்", "Email confirmation"),
    docTitle: t("மின்னஞ்சல் உறுதி", "Confirm email"),
  };

  if (state === "working") {
    return (
      <AuthShell {...shell} title={t("சரிபார்க்கிறோம்…", "Confirming your address…")}>
        <PageLoader label={t("ஒரு நொடி…", "One moment…")} />
      </AuthShell>
    );
  }

  if (state === "done") {
    return (
      <AuthShell
        {...shell}
        title={t("மின்னஞ்சல் உறுதியாகிவிட்டது", "Your email is confirmed")}
        lead={t(
          "இப்போது உங்கள் கணக்கு முழுமையாக தயார். பதிவுகளும் நன்கொடைகளும் இங்கே தெரியும்.",
          "Your account is ready. Your bookings and offerings will appear here.",
        )}
      >
        <Alert tone="success" title={t("நன்றி", "Thank you")}>
          {message || t("மின்னஞ்சல் முகவரி உறுதிப்படுத்தப்பட்டது.", "Your email address has been confirmed.")}
        </Alert>
        <div className="authx__next">
          <Button to="/account" variant="primary" size="lg" block icon={<LuCircleCheck aria-hidden="true" />}>
            {t("என் கணக்கு", "Open my account")}
          </Button>
          <Button to="/sevas" variant="outline" block>
            {t("சேவை பதிவு செய்ய", "Book a seva")}
          </Button>
        </div>
      </AuthShell>
    );
  }

  if (state === "no-token") {
    return (
      <AuthShell {...shell} title={t("இந்த இணைப்பு முழுமையாக இல்லை", "That link is incomplete")}>
        <Alert tone="warning">
          {t(
            "மின்னஞ்சலில் உள்ள முழு இணைப்பையும் திறக்கவும். சில மின்னஞ்சல் செயலிகள் நீண்ட இணைப்பை உடைத்துவிடும்.",
            "Open the whole link from the email. Some mail apps break long links across lines.",
          )}
        </Alert>
        <div className="authx__next">
          <Button to="/login" variant="primary" block icon={<LuMailCheck aria-hidden="true" />}>
            {t("உள்நுழைந்து மீண்டும் அனுப்ப", "Sign in and resend it")}
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      {...shell}
      title={t("இந்த இணைப்பு வேலை செய்யவில்லை", "That link did not work")}
      foot={
        <span>
          {t("உதவி தேவையா?", "Need a hand?")} <Link to="/contact">{t("கோயிலை தொடர்பு கொள்ளுங்கள்", "Contact the temple")}</Link>
        </span>
      }
    >
      <Alert tone="error">{message}</Alert>
      <div className="authx__next">
        <Button to="/login" variant="primary" block icon={<LuMailCheck aria-hidden="true" />}>
          {t("உள்நுழைந்து மீண்டும் அனுப்ப", "Sign in and resend it")}
        </Button>
      </div>
    </AuthShell>
  );
}
