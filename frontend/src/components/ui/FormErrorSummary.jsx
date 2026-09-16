import { forwardRef, useId } from "react";
import { LuCircleAlert } from "react-icons/lu";

/** Move to a field named in the summary: focus it, then bring it into view. */
export function focusField(id) {
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  el.focus({ preventScroll: true });
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
}

/**
 * FormErrorSummary — everything to fix on this step, in one place, each item a
 * link to its field (docs/payments/SPEC.md §7.2).
 *
 * The registration flow's summary with its own id, so more than one form can
 * use it. The step moves focus here when Next finds problems, so a screen
 * reader reads the whole list once. That is why the fields themselves render
 * their errors with announce={false}: a dozen alerts firing at the same moment
 * would talk over the summary. Not role="alert" either, for the same reason:
 * the focus move is the announcement.
 */
const FormErrorSummary = forwardRef(function FormErrorSummary({ entries, t, titleId, className = "" }, ref) {
  const auto = useId();
  const headingId = titleId ?? `form-summary-${auto}`;
  if (!entries.length) return null;
  const n = entries.length;
  return (
    <div
      ref={ref}
      className={`alert alert--error form-summary ${className}`.trim()}
      tabIndex={-1}
      aria-labelledby={headingId}
    >
      <span className="alert__icon" aria-hidden="true">
        <LuCircleAlert />
      </span>
      <div className="alert__body">
        <h3 id={headingId} className="form-summary__title">
          {n === 1
            ? t("தொடர்வதற்கு முன் இதைச் சரிசெய்யவும்", "Please fix this to continue")
            : t(`தொடர்வதற்கு முன் இந்த ${n} விவரங்களைச் சரிசெய்யவும்`, `Please fix these ${n} things to continue`)}
        </h3>
        <ul className="form-summary__list">
          {entries.map((entry) => (
            <li key={entry.key}>
              <a
                href={entry.id ? `#${entry.id}` : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  focusField(entry.id);
                }}
              >
                {entry.label}: {entry.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
});

export default FormErrorSummary;
