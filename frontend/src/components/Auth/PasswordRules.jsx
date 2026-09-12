import { LuCheck, LuDot } from "react-icons/lu";
import { useLang } from "../../context/LangContext";

/**
 * The server's password policy, shown live as the devotee types.
 *
 * It mirrors passwordProblem() in backend/includes/helpers.php. The server is
 * still the authority — this only means the rules are visible before submitting
 * rather than discovered by being rejected. Keep the two in step.
 */
export const WEAK_WORDS = ["password", "temple", "12345678", "qwerty", "admin123", "letmein", "welcome"];

/** Mirrors the server. Returns '' when the password is acceptable. */
export function passwordProblem(password, identity = "") {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That password is too long.";
  if (!/[a-z]/.test(password)) return "Include at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Include at least one uppercase letter.";
  if (!/\d/.test(password)) return "Include at least one number.";
  const stem = String(identity).split("@")[0];
  if (stem.length >= 3 && password.toLowerCase().includes(stem.toLowerCase())) {
    return "Do not put your name or email in the password.";
  }
  if (WEAK_WORDS.some((w) => password.toLowerCase().includes(w))) return "That password is too easy to guess.";
  return "";
}

export default function PasswordRules({ value = "", identity = "" }) {
  const { t } = useLang();
  const lower = value.toLowerCase();
  const stem = String(identity).split("@")[0];

  const rules = [
    { met: value.length >= 10, ta: "குறைந்தது 10 எழுத்துகள்", en: "At least 10 characters" },
    {
      met: /[a-z]/.test(value) && /[A-Z]/.test(value),
      ta: "சிறிய மற்றும் பெரிய எழுத்து",
      en: "A lowercase and an uppercase letter",
    },
    { met: /\d/.test(value), ta: "குறைந்தது ஒரு எண்", en: "At least one number" },
    {
      met:
        value.length > 0 &&
        !WEAK_WORDS.some((w) => lower.includes(w)) &&
        !(stem.length >= 3 && lower.includes(stem.toLowerCase())),
      ta: "பெயர், மின்னஞ்சல் அல்லது எளிய சொல் இல்லை",
      en: "Not your name, email, or a common word",
    },
  ];

  return (
    <ul className="authx__rules" aria-label={t("கடவுச்சொல் விதிகள்", "Password requirements")}>
      {rules.map((r) => (
        <li key={r.en} data-met={r.met ? "true" : "false"}>
          {r.met ? <LuCheck aria-hidden="true" /> : <LuDot aria-hidden="true" />}
          <span>{t(r.ta, r.en)}</span>
          <span className="sr-only">{r.met ? t("— நிறைவு", "— met") : ""}</span>
        </li>
      ))}
    </ul>
  );
}
