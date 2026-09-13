import { forwardRef } from "react";
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
 * ErrorSummary — everything to fix on this step, in one place, each item a link
 * to its field.
 *
 * The step moves focus here when Next finds problems, so a screen reader reads
 * the whole list once. That is why the fields themselves render their errors
 * with announce={false}: a dozen alerts firing at the same moment would talk over
 * the summary. Not role="alert" either, for the same reason: the focus move is
 * the announcement.
 */
const ErrorSummary = forwardRef(function ErrorSummary({ entries, t }, ref) {
  if (!entries.length) return null;
  const n = entries.length;
  return (
    <div ref={ref} className="alert alert--error reg-summary" tabIndex={-1} aria-labelledby="reg-summary-title">
      <span className="alert__icon" aria-hidden="true">
        <LuCircleAlert />
      </span>
      <div className="alert__body">
        <h3 id="reg-summary-title" className="reg-summary__title">
          {n === 1
            ? t("தொடர்வதற்கு முன் இதைச் சரிசெய்யவும்", "Please fix this to continue")
            : t(`தொடர்வதற்கு முன் இந்த ${n} விவரங்களைச் சரிசெய்யவும்`, `Please fix these ${n} things to continue`)}
        </h3>
        <ul className="reg-summary__list">
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

export default ErrorSummary;
