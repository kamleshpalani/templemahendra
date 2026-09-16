import Alert from "../ui/Alert";
import { useLang } from "../../context/LangContext";

/**
 * SimulatorBanner — says plainly that no real money is involved
 * (docs/payments/SPEC.md §4.7, §7.2).
 *
 * The simulator exists for development and the automated tests; the test mode
 * is CCAvenue's own sandbox. Both look exactly like the real thing to a donor,
 * so every page that can show a payment says which one it is. Nothing is shown
 * in production mode.
 *
 * Before a payment (the Donate page) test mode reads "use CCAvenue test cards
 * only"; on a result or receipt page (`outcome`) it says what matters about
 * that payment: no real money was taken, and the receipt is not a real one.
 */
export default function SimulatorBanner({ simulator = false, testMode = false, outcome = false, className = "" }) {
  const { t } = useLang();
  if (!simulator && !testMode) return null;
  let text;
  if (simulator) {
    text = t("இது உருவகப்படுத்தப்பட்ட கட்டண முறை — உண்மையான பணம் எதுவும் எடுக்கப்படாது.", "Simulator — no real money is taken.");
  } else if (outcome) {
    text = t(
      "சோதனைப் பயன்முறை — உண்மையான பணம் எதுவும் எடுக்கப்படவில்லை. இது உண்மையான நன்கொடைக்கான ரசீது அல்ல.",
      "Test mode — no real money was taken. This is not a receipt for a real donation.",
    );
  } else {
    text = t("சோதனைப் பயன்முறை — CCAvenue சோதனை கார்டுகளை மட்டும் பயன்படுத்தவும்.", "Test mode — use CCAvenue test cards only.");
  }
  return (
    <Alert
      tone={simulator ? "danger" : "warning"}
      className={`pay-banner ${className}`.trim()}
      title={simulator ? t("சோதனை முறை", "Simulator") : t("சோதனைப் பயன்முறை", "Test mode")}
    >
      {text}
    </Alert>
  );
}
