import { useEffect, useRef, useState } from "react";
import { LuLock } from "react-icons/lu";
import Button from "../ui/Button";
import { useLang } from "../../context/LangContext";
import { submitToGateway } from "../../lib/payments";

/**
 * PaymentRedirect — the moment between "Proceed to payment" and CCAvenue's own
 * page (docs/payments/SPEC.md §7.2, §4.3).
 *
 * CCAvenue's checkout is a full-page form POST, so the browser must leave the
 * site carrying the encrypted request the server issued. That is invisible, and
 * a screen that goes blank for a second reads as a site that has broken — so
 * this says what is happening, out loud (role="status") as well as on screen.
 *
 * The submit is guarded by a ref: React's StrictMode runs effects twice in
 * development, and a payment must be started once. If the browser is slow, or
 * something blocked the automatic post, a real button appears after four
 * seconds, and <noscript> covers the case where none of this ran at all.
 */
export default function PaymentRedirect({ gateway, amountLabel, purposeLabel }) {
  const { t } = useLang();
  const [slow, setSlow] = useState(false);
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    submitToGateway(gateway);
  }, [gateway]);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="card card--solid card--static pay-redirect" role="status" aria-live="polite">
      <span className="pay-redirect__spinner spinner" aria-hidden="true" />
      <h2 className="pay-redirect__title">
        {t("CCAvenue பாதுகாப்பான பக்கத்திற்கு அழைத்துச் செல்கிறோம்…", "Redirecting securely to CCAvenue…")}
      </h2>
      {(amountLabel || purposeLabel) && (
        <p className="pay-redirect__amount">
          {amountLabel}
          {amountLabel && purposeLabel ? " · " : ""}
          {purposeLabel}
        </p>
      )}
      <p className="pay-redirect__note">
        <LuLock aria-hidden="true" />
        {t(
          "இந்தப் பக்கத்தை மூடவோ புதுப்பிக்கவோ வேண்டாம். உங்கள் கார்டு விவரங்கள் CCAvenue-இல் மட்டுமே உள்ளிடப்படும்; அவை கோயிலுக்கு வருவதில்லை.",
          "Please do not close or refresh this page. Your card details are entered only on CCAvenue and never reach the temple.",
        )}
      </p>
      {slow && (
        <Button variant="primary" icon={<LuLock aria-hidden="true" />} onClick={() => submitToGateway(gateway)}>
          {t("CCAvenue பக்கத்திற்குச் செல்", "Continue to CCAvenue")}
        </Button>
      )}
      <noscript>
        <p className="pay-redirect__note">
          {t(
            "தொடர ஜாவாஸ்கிரிப்ட் தேவை. அதை இயக்கிவிட்டு மீண்டும் முயற்சிக்கவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
            "JavaScript is needed to continue. Please turn it on and try again, or call the temple office.",
          )}
        </p>
      </noscript>
    </div>
  );
}
