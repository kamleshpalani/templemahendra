import { forwardRef, useRef } from "react";
import { LuChevronDown } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import CountryPicker from "./CountryPicker";
import {
  countryOf,
  digitsOf,
  flagOf,
  formatNational,
  maxDigitsFor,
  parseInternational,
  placeholderFor,
} from "../../lib/phone";

/**
 * PhoneInput — a country selector and a national number, for devotees anywhere.
 *
 *   <PhoneInput
 *     country={form.phoneCountry}
 *     national={form.phone}
 *     onChange={({ country, national }) => …}
 *     {...a11y}
 *   />
 *
 * Controlled on two values rather than one string, because the country is a
 * real choice and not something to infer from digits. The parent keeps both,
 * and lib/phone.js turns them into the single E.164 string the API stores.
 *
 * The searchable list behind the flag is CountryPicker, shared with the
 * country-of-residence field.
 */
const PhoneInput = forwardRef(function PhoneInput(
  {
    country = "IN",
    national = "",
    onChange,
    disabled = false,
    autoComplete = "tel-national",
    className = "",
    id,
    ...rest
  },
  ref,
) {
  const { t } = useLang();
  const selected = countryOf(country);
  const numberRef = useRef(null);

  const onNumberChange = (e) => {
    const capped = digitsOf(e.target.value).slice(0, maxDigitsFor(selected));
    onChange?.({ country: selected.iso2, national: capped });
  };

  /**
   * A pasted number may carry its own country code. Let lib/phone.js decide, so
   * pasting "+44 7700 900123" into an India-selected field switches the country
   * rather than silently truncating to ten digits.
   */
  const onPaste = (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/^\s*(\+|00)/.test(text)) return; // plain digits: let the browser handle it
    e.preventDefault();
    const parsed = parseInternational(text, selected.iso2);
    onChange?.(parsed ?? { country: selected.iso2, national: digitsOf(text).slice(0, maxDigitsFor(selected)) });
  };

  return (
    <div className={`phone-input ${className}`.trim()}>
      <CountryPicker
        value={selected.iso2}
        disabled={disabled}
        onChange={(iso2) => onChange?.({ country: iso2, national: digitsOf(national) })}
        // The number is the next thing anyone wants to type.
        onPicked={() => requestAnimationFrame(() => numberRef.current?.focus({ preventScroll: true }))}
        trigger={({ ref: triggerRef, toggle, props }) => (
          <button
            ref={triggerRef}
            type="button"
            className="phone-input__country"
            onClick={toggle}
            aria-label={`${t("நாடு", "Country")}: ${selected.name} +${selected.dial}. ${t("மாற்ற", "Change")}`}
            {...props}
          >
            <span className="country-flag" aria-hidden="true">
              {flagOf(selected.iso2)}
            </span>
            <span className="phone-input__dial">+{selected.dial}</span>
            <LuChevronDown className="phone-input__caret" aria-hidden="true" />
          </button>
        )}
      />

      <input
        {...rest}
        id={id}
        ref={(node) => {
          numberRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="tel"
        inputMode="tel"
        autoComplete={autoComplete}
        className="phone-input__num"
        value={formatNational(national, selected)}
        onChange={onNumberChange}
        onPaste={onPaste}
        disabled={disabled}
        placeholder={placeholderFor(selected)}
      />
    </div>
  );
});

export default PhoneInput;
