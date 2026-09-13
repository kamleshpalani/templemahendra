import { useEffect, useId, useRef, useState } from "react";
import { LuCheck, LuCircleHelp, LuDot, LuX } from "react-icons/lu";
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

/** The four rules, each with its live state. */
function rulesFor(value, identity, t) {
  const lower = value.toLowerCase();
  const stem = String(identity).split("@")[0];
  return [
    { met: value.length >= 10, label: t("குறைந்தது 10 எழுத்துகள்", "At least 10 characters") },
    {
      met: /[a-z]/.test(value) && /[A-Z]/.test(value),
      label: t("சிறிய மற்றும் பெரிய எழுத்து", "A lowercase and an uppercase letter"),
    },
    { met: /\d/.test(value), label: t("குறைந்தது ஒரு எண்", "At least one number") },
    {
      met:
        value.length > 0 &&
        !WEAK_WORDS.some((w) => lower.includes(w)) &&
        !(stem.length >= 3 && lower.includes(stem.toLowerCase())),
      label: t("பெயர், மின்னஞ்சல் அல்லது எளிய சொல் இல்லை", "Not your name, email, or a common word"),
    },
  ];
}

/**
 * PasswordRules — one line, not five.
 *
 * The four rules used to sit permanently under the field as a checklist, which
 * took more vertical space than the rest of the form put together. What a
 * person needs while typing is "am I there yet"; the wording of each rule is
 * only wanted when something is still missing. So the line shows a four-segment
 * meter and a count, and the full list lives behind the help button beside it.
 *
 * The count is also announced politely, so the progress is not purely visual.
 */
export default function PasswordRules({ value = "", identity = "" }) {
  const { t } = useLang();
  const rules = rulesFor(value, identity, t);
  const met = rules.filter((r) => r.met).length;

  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const auto = useId();
  const popId = `pw-help-${auto}`;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Once every rule is met the line has nothing left to say, so it steps back
  // to a single confirmation instead of a meter the devotee has finished with.
  const done = met === rules.length;

  return (
    <div className="pw-meter" ref={wrapRef}>
      <span className="pw-meter__track" aria-hidden="true">
        {rules.map((r, i) => (
          <span key={i} className="pw-meter__seg" data-met={r.met ? "true" : "false"} />
        ))}
      </span>

      <span className={`pw-meter__count${done ? " pw-meter__count--done" : ""}`} role="status">
        {value === ""
          ? t("கடவுச்சொல் விதிகள்", "Password rules")
          : done
            ? t("நல்ல கடவுச்சொல்", "Strong enough")
            : t(`${rules.length} இல் ${met} நிறைவு`, `${met} of ${rules.length} met`)}
      </span>

      <button
        ref={buttonRef}
        type="button"
        className="pw-meter__help"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={popId}
        aria-label={t("கடவுச்சொல் விதிகளைக் காட்டு", "Show password rules")}
      >
        <LuCircleHelp aria-hidden="true" />
      </button>

      {open && (
        <div className="pw-meter__pop" id={popId}>
          <div className="pw-meter__pop-head">
            <strong>{t("கடவுச்சொல் விதிகள்", "Password rules")}</strong>
            <button
              type="button"
              className="pw-meter__pop-close"
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              aria-label={t("மூடு", "Close")}
            >
              <LuX aria-hidden="true" />
            </button>
          </div>
          <ul className="pw-meter__list">
            {rules.map((r, i) => (
              <li key={i} data-met={r.met ? "true" : "false"}>
                {r.met ? <LuCheck aria-hidden="true" /> : <LuDot aria-hidden="true" />}
                <span>{r.label}</span>
                <span className="sr-only">{r.met ? t("— நிறைவு", "— met") : t("— இன்னும் இல்லை", "— not yet")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
