import { forwardRef } from "react";
import { LuChevronDown } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import CountryPicker from "./CountryPicker";
import { countryOf, flagOf } from "../../lib/phone";

/**
 * CountrySelect — where the devotee lives, as a searchable field.
 *
 * A native <select> with 245 options is a poor thing to operate on a phone and
 * cannot be searched by typing more than one letter, so this reuses the same
 * CountryPicker as the phone field. It presents as a form control, with the
 * flag and the country's name.
 *
 *   <CountrySelect value={form.country} onChange={(iso2) => …} {...a11y} />
 *
 * `value` may be empty, which shows the placeholder — useful for a field the
 * devotee must consciously choose rather than accept a default for.
 */
const CountrySelect = forwardRef(function CountrySelect(
  { value = "", onChange, disabled = false, placeholder, className = "", id, ...rest },
  ref,
) {
  const { t } = useLang();
  const chosen = value ? countryOf(value) : null;

  return (
    <CountryPicker
      value={chosen?.iso2 ?? ""}
      disabled={disabled}
      onChange={onChange}
      trigger={({ ref: triggerRef, toggle, props }) => (
        <button
          {...rest}
          id={id}
          ref={(node) => {
            triggerRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          type="button"
          className={`country-select${chosen ? "" : " country-select--empty"} ${className}`.trim()}
          onClick={toggle}
          {...props}
        >
          {chosen ? (
            <>
              <span className="country-flag" aria-hidden="true">
                {flagOf(chosen.iso2)}
              </span>
              <span className="country-select__name">{chosen.name}</span>
            </>
          ) : (
            <span className="country-select__name">
              {placeholder ?? t("நாட்டைத் தேர்ந்தெடு", "Select country")}
            </span>
          )}
          <LuChevronDown className="country-select__caret" aria-hidden="true" />
        </button>
      )}
    />
  );
});

export default CountrySelect;
