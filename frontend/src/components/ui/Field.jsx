import { forwardRef, useId, useState } from "react";
import { LuCircleAlert, LuEye, LuEyeOff } from "react-icons/lu";
import { useLang } from "../../context/LangContext";

/**
 * Field — label + control + hint/error wiring in one place so every form on
 * the site announces errors the same way (aria-invalid + aria-describedby).
 *
 *   <Field label="Phone" required error={errors.phone} hint="10 digits">
 *     {(a11y) => <input name="phone" {...a11y} />}
 *   </Field>
 *
 * `children` may be a render function receiving { id, "aria-invalid",
 * "aria-describedby" } or a plain element (the id is then applied via
 * htmlFor only when you pass `id` yourself).
 */
export function Field({
  label,
  required = false,
  optional = false,
  hint,
  error,
  success = false,
  inline = false,
  id: idProp,
  className = "",
  children,
}) {
  const auto = useId();
  const id = idProp ?? `f-${auto}`;
  // The hint is swapped out for the error message while one is showing, so its
  // id must leave aria-describedby too — otherwise it points at a missing node.
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const { t } = useLang();

  const a11y = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": [errId, hintId].filter(Boolean).join(" ") || undefined,
    "aria-required": required || undefined,
  };

  const cls = [
    "field",
    inline ? "field--inline" : "",
    error ? "field--error" : "",
    success ? "field--success" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {label && (
        <label htmlFor={id} className="field__label">
          {label}
          {required && (
            <span className="field__required" aria-hidden="true">
              *
            </span>
          )}
          {optional && !required && (
            <span className="field__optional">({t("விருப்பம்", "optional")})</span>
          )}
        </label>
      )}
      <div className="field__control">
        {typeof children === "function" ? children(a11y) : children}
      </div>
      {error ? (
        <span id={errId} className="field__error" role="alert">
          <LuCircleAlert aria-hidden="true" />
          {error}
        </span>
      ) : (
        hint && (
          <span id={hintId} className="field__hint">
            {hint}
          </span>
        )
      )}
    </div>
  );
}

/** Password input with visibility toggle, using the shared affix pattern. */
export const PasswordInput = forwardRef(function PasswordInput({ className = "", ...rest }, ref) {
  const [show, setShow] = useState(false);
  const { t } = useLang();
  return (
    <span className="input-affix">
      <input ref={ref} type={show ? "text" : "password"} className={className} {...rest} />
      <button
        type="button"
        className="input-affix__btn"
        onClick={() => setShow((s) => !s)}
        aria-pressed={show}
        aria-label={show ? t("கடவுச்சொல்லை மறை", "Hide password") : t("கடவுச்சொல்லை காட்டு", "Show password")}
      >
        {show ? <LuEyeOff aria-hidden="true" /> : <LuEye aria-hidden="true" />}
      </button>
    </span>
  );
});

/** Input with a leading icon. */
export const IconInput = forwardRef(function IconInput({ icon, className = "", ...rest }, ref) {
  return (
    <span className="input-affix input-affix--leading">
      <span className="input-affix__icon" aria-hidden="true">
        {icon}
      </span>
      <input ref={ref} className={className} {...rest} />
    </span>
  );
});

/** Accessible toggle switch (checkbox under the hood). */
export function Switch({ label, description, id: idProp, className = "", ...rest }) {
  const auto = useId();
  const id = idProp ?? `sw-${auto}`;
  return (
    <label htmlFor={id} className={`switch ${className}`.trim()}>
      <input id={id} type="checkbox" role="switch" {...rest} />
      <span className="switch__track" aria-hidden="true" />
      <span className="switch__label">
        <span>{label}</span>
        {description && <span className="switch__desc">{description}</span>}
      </span>
    </label>
  );
}

/** Pressable filter / quick-pick chip. */
export function Chip({ active = false, count, className = "", children, ...rest }) {
  return (
    <button type="button" className={`chip ${className}`.trim()} aria-pressed={active} {...rest}>
      {children}
      {count != null && <span className="chip__count">{count}</span>}
    </button>
  );
}
