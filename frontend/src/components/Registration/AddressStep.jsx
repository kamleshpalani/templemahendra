import CountrySelect from "../ui/CountrySelect";
import StateSelect from "../ui/StateSelect";
import { Field } from "../ui/Field";
import { hasSubdivisions, subdivisionLabel } from "../../lib/phone";
import { LIMITS } from "../../lib/familyRegistration";

/**
 * Step 3 — the house address the temple posts letters and receipts to.
 *
 * State and city, then PIN and country: the order the committee asked for on
 * every address form on the site. The state list depends on the country, so
 * changing the country clears the state (pages/Register.jsx does that, together
 * with keeping the phone's country in step until a number is typed).
 */
export default function AddressStep({ form, errors, setField, onCountryChange, t }) {
  const india = form.country === "IN";
  const listed = hasSubdivisions(form.country);

  return (
    <div className="reg-fields">
      <Field
        id="reg-address1"
        label={t("வீட்டு எண், தெரு", "House number and street")}
        required
        error={errors.address1}
        announce={false}
      >
        {(a11y) => (
          <input
            {...a11y}
            name="address1"
            value={form.address1}
            onChange={(e) => setField("address1", e.target.value)}
            autoComplete="address-line1"
            maxLength={LIMITS.address1[1]}
          />
        )}
      </Field>

      <Field id="reg-address2" label={t("பகுதி / அடையாளம்", "Area or landmark")} optional error={errors.address2} announce={false}>
        {(a11y) => (
          <input
            {...a11y}
            name="address2"
            value={form.address2}
            onChange={(e) => setField("address2", e.target.value)}
            autoComplete="address-line2"
            maxLength={LIMITS.address2[1]}
          />
        )}
      </Field>

      <div className="field-row">
        <Field
          id="reg-state"
          label={subdivisionLabel(form.country, t)}
          required={listed}
          optional={!listed}
          error={errors.state}
          announce={false}
        >
          {(a11y) => (
            <StateSelect {...a11y} country={form.country} value={form.state} onChange={(next) => setField("state", next)} />
          )}
        </Field>

        <Field id="reg-city" label={t("நகரம் / ஊர்", "City or town")} required error={errors.city} announce={false}>
          {(a11y) => (
            <input
              {...a11y}
              name="city"
              value={form.city}
              onChange={(e) => setField("city", e.target.value)}
              autoComplete="address-level2"
              maxLength={LIMITS.city[1]}
            />
          )}
        </Field>
      </div>

      <div className="field-row">
        <Field
          id="reg-postcode"
          label={india ? t("PIN குறியீடு", "PIN code") : t("அஞ்சல் குறியீடு", "Postal code")}
          required={india}
          optional={!india}
          error={errors.postcode}
          announce={false}
          hint={india ? t("6 இலக்கங்கள்", "6 digits") : undefined}
        >
          {(a11y) => (
            <input
              {...a11y}
              name="postcode"
              value={form.postcode}
              onChange={(e) => setField("postcode", e.target.value)}
              autoComplete="postal-code"
              inputMode={india ? "numeric" : "text"}
              maxLength={india ? 7 : LIMITS.postcode[1]}
            />
          )}
        </Field>

        <Field id="reg-country" label={t("நாடு", "Country")} required error={errors.country} announce={false}>
          {(a11y) => <CountrySelect {...a11y} value={form.country} onChange={onCountryChange} />}
        </Field>
      </div>
    </div>
  );
}
