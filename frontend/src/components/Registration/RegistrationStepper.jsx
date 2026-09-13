import { LuCheck } from "react-icons/lu";
import { STEPS } from "../../lib/familyRegistration";

/**
 * RegistrationStepper — where the family is in the four-step registration, and
 * the way back to any step they have already reached.
 *
 * An ordered list, so a screen reader hears the count and each position. The
 * current step carries aria-current="step". A step whose earlier steps are not
 * finished is a disabled button: it cannot be opened out of order and Tab skips
 * it. Each button's name says its state ("Step 2, Family, completed"), because
 * the tick and the colour alone would say it only to people who can see them.
 *
 * Below 640 px the labels give way to a "Step 2 of 4 · Family" line above the
 * dots (pages/Register.css); the buttons keep their full names.
 */
export default function RegistrationStepper({ currentIndex, isDone, isReachable, onJump, t }) {
  const total = STEPS.length;
  const current = STEPS[currentIndex];

  return (
    <nav className="reg-stepper" aria-label={t("பதிவுப் படிகள்", "Registration steps")}>
      <p className="reg-stepper__compact" aria-hidden="true">
        <span className="reg-stepper__count">
          {t(`படி ${currentIndex + 1} / ${total}`, `Step ${currentIndex + 1} of ${total}`)}
        </span>
        <span className="reg-stepper__compact-label">{t(...current.label)}</span>
      </p>
      <ol className="reg-stepper__list" style={{ "--reg-progress": currentIndex / (total - 1) }}>
        {STEPS.map((step, i) => {
          const isCurrent = i === currentIndex;
          const reachable = isCurrent || isReachable(i);
          const state = isCurrent ? "current" : isDone(i) ? "done" : reachable ? "open" : "locked";
          const label = t(...step.label);
          const stateWord = {
            current: t("இப்போதைய படி", "current step"),
            done: t("முடிந்தது", "completed"),
            open: "",
            locked: t("இன்னும் திறக்கப்படவில்லை", "not available yet"),
          }[state];
          return (
            <li key={step.key} className={`reg-stepper__item reg-stepper__item--${state}`}>
              <button
                type="button"
                className="reg-stepper__btn"
                disabled={!reachable}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={[t(`படி ${i + 1}`, `Step ${i + 1}`), label, stateWord].filter(Boolean).join(", ")}
                onClick={() => {
                  if (!isCurrent) onJump(step.key);
                }}
              >
                <span className="reg-stepper__dot" aria-hidden="true">
                  {state === "done" ? <LuCheck /> : i + 1}
                </span>
                <span className="reg-stepper__label" aria-hidden="true">
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
