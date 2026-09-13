import PhoneInput from "../ui/PhoneInput";
import { Field } from "../ui/Field";
import { LIMITS, ageFrom, earliestBirthDate, templeToday } from "../../lib/familyRegistration";

/** The two languages the temple writes in, each named in its own script. */
const LANG_CHOICES = [
  { value: "ta", text: "தமிழ்" },
  { value: "en", text: "English" },
];

/**
 * Step 1 — the person registering: name, phone, and the optional email and
 * date of birth, plus the language the temple should write to them in. Gender
 * is deliberately not asked.
 */
export default function PersonalStep({ form, errors, setField, onPhoneChange, t }) {
  const today = templeToday();
  const age = form.dateOfBirth && !errors.dateOfBirth ? ageFrom(form.dateOfBirth, today) : null;

  return (
    <div className="reg-fields">
      <Field id="reg-name" label={t("முழுப் பெயர்", "Full name")} required error={errors.name} announce={false}>
        {(a11y) => (
          <input
            {...a11y}
            name="name"
            value={form.name}
            onChange={(e) => setField("name", e.target.value)}
            autoComplete="name"
            maxLength={LIMITS.name[1]}
          />
        )}
      </Field>

      <div className="field-row">
        <Field
          id="reg-phone"
          label={t("தொலைபேசி", "Phone")}
          required
          error={errors.phone}
          announce={false}
          hint={t(
            "நாட்டைத் தேர்ந்தெடுத்து, முன்னால் உள்ள 0 இல்லாமல் எண்ணை உள்ளிடவும்",
            "Pick the country, then type the number without its leading 0",
          )}
        >
          {(a11y) => (
            <PhoneInput {...a11y} name="phone" country={form.phoneCountry} national={form.phone} onChange={onPhoneChange} />
          )}
        </Field>

        <Field
          id="reg-email"
          label={t("மின்னஞ்சல்", "Email")}
          optional
          error={errors.email}
          announce={false}
          hint={t(
            "ரசீதுகள் அல்லது அறிவிப்புகளை மின்னஞ்சலில் பெற விரும்பினால் மட்டும்",
            "Only if you would like receipts or notices by email",
          )}
        >
          {(a11y) => (
            <input
              {...a11y}
              type="email"
              name="email"
              value={form.email}
              onChange={(e) => setField("email", e.target.value)}
              autoComplete="email"
              autoCapitalize="none"
              spellCheck="false"
              inputMode="email"
              maxLength={LIMITS.email[1]}
            />
          )}
        </Field>
      </div>

      <Field
        id="reg-dob"
        label={t("பிறந்த தேதி", "Date of birth")}
        optional
        error={errors.dateOfBirth}
        announce={false}
        hint={age !== null ? t(`வயது ${age}`, `Age ${age}`) : t("நாள், மாதம், ஆண்டு", "Day, month and year")}
      >
        {(a11y) => (
          <input
            {...a11y}
            type="date"
            name="dateOfBirth"
            className="reg-date"
            value={form.dateOfBirth}
            onChange={(e) => setField("dateOfBirth", e.target.value)}
            min={earliestBirthDate(today)}
            max={today}
            autoComplete="bday"
          />
        )}
      </Field>

      <fieldset className="field reg-choice" aria-describedby={errors.lang ? "reg-lang-err" : "reg-lang-hint"}>
        <legend className="field__label">{t("விருப்ப மொழி", "Preferred language")}</legend>
        <span id="reg-lang-hint" className="field__hint">
          {t("கோயில் உங்களுடன் தொடர்பு கொள்ளும் மொழி", "The language the temple will use to contact you")}
        </span>
        <div className="reg-choice__options">
          {LANG_CHOICES.map((choice) => (
            <label key={choice.value} className="reg-choice__option" htmlFor={`reg-lang-${choice.value}`}>
              <input
                type="radio"
                id={`reg-lang-${choice.value}`}
                name="lang"
                value={choice.value}
                checked={form.lang === choice.value}
                onChange={() => setField("lang", choice.value)}
              />
              <span className="reg-choice__text" lang={choice.value}>
                {choice.text}
              </span>
            </label>
          ))}
        </div>
        {errors.lang && (
          <span id="reg-lang-err" className="field__error">
            {errors.lang}
          </span>
        )}
      </fieldset>
    </div>
  );
}
