import { LuCheck } from "react-icons/lu";

/**
 * FormStepper — where someone is in a multi-step form, and the way back to any
 * step they have already reached (docs/payments/SPEC.md §7.2).
 *
 * The registration flow's stepper with the steps passed in rather than imported,
 * so the donation flow (three steps) and any later form can use it. The CSS
 * takes the count from a `--steps` custom property, so the rail and its gold
 * fill line up whatever the number.
 *
 * An ordered list, so a screen reader hears the count and each position. The
 * current step carries aria-current="step". A step whose earlier steps are not
 * finished is a disabled button: it cannot be opened out of order and Tab skips
 * it. Each button's name says its state ("Step 2, Your details, completed"),
 * because the tick and the colour alone would say it only to people who can see
 * them.
 *
 *   <FormStepper steps={DONATE_STEPS} currentIndex={i} isDone={fn}
 *                isReachable={fn} onJump={key => …} t={t}
 *                ariaLabel={t("நன்கொடைப் படிகள்", "Donation steps")} />
 */
export default function FormStepper({ steps, currentIndex, isDone, isReachable, onJump, t, ariaLabel }) {
  const total = steps.length;
  const current = steps[currentIndex];
  if (!current) return null;

  return (
    <nav className="form-stepper" aria-label={ariaLabel}>
      <p className="form-stepper__compact" aria-hidden="true">
        <span className="form-stepper__count">
          {t(`படி ${currentIndex + 1} / ${total}`, `Step ${currentIndex + 1} of ${total}`)}
        </span>
        <span className="form-stepper__compact-label">{t(...current.label)}</span>
      </p>
      <ol
        className="form-stepper__list"
        style={{ "--steps": total, "--form-progress": total > 1 ? currentIndex / (total - 1) : 0 }}
      >
        {steps.map((step, i) => {
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
            <li key={step.key} className={`form-stepper__item form-stepper__item--${state}`}>
              <button
                type="button"
                className="form-stepper__btn"
                disabled={!reachable}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={[t(`படி ${i + 1}`, `Step ${i + 1}`), label, stateWord].filter(Boolean).join(", ")}
                onClick={() => {
                  if (!isCurrent) onJump(step.key);
                }}
              >
                <span className="form-stepper__dot" aria-hidden="true">
                  {state === "done" ? <LuCheck /> : i + 1}
                </span>
                <span className="form-stepper__label" aria-hidden="true">
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
