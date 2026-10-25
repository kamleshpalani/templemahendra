import { Field } from "../ui/Field";
import Button from "../ui/Button";

export default function BookingDetails({ seva, services, onService, people, setPeople, address, setAddress, errors, t }) {
  const archana = seva.service_kind?.startsWith("archana");
  const delivery = ["archana_prasadam", "archana_pooja"].includes(seva.service_kind);
  return <>
    {people.map((person, i) => <fieldset key={person.key} className="booking-person">
      <legend className={i === 0 ? "sr-only" : undefined}>{t(`நபர் ${i + 1}`, `Person ${i + 1}`)}</legend>
      <div className="booking-person__fields">
      {[
        ...(i > 0 ? [["name", "பெயர்", "Name"]] : []), ["rasi", "ராசி", "Rasi"], ["nakshatram", "நட்சத்திரம்", "Nakshatram"],
      ].map(([key, ta, en]) => <Field key={key} id={`booking-person-${person.key}-${key}`} required
        label={t(ta, en)} error={errors[`participants.${i}.${key}`]}>
        {(a11y) => <input {...a11y} value={person[key]} maxLength={100}
          onChange={(e) => setPeople(people.map((p) => p.key === person.key ? { ...p, [key]: e.target.value } : p))} />}
      </Field>)}
      </div>
      {i > 0 && <Button variant="ghost" onClick={() => setPeople(people.filter((p) => p.key !== person.key))}>
        {t("நீக்கு", "Remove person")}
      </Button>}
    </fieldset>)}
    <Button variant="outline" size="sm" disabled={people.length >= 20} onClick={() =>
      setPeople([...people, { key: Math.max(...people.map((p) => p.key)) + 1, name: "", rasi: "", nakshatram: "" }])}>
      {t("நபரைச் சேர் (+)", "Add Person (+)")}
    </Button>
    {errors.participants && <p role="alert">{errors.participants}</p>}
    {archana && <Field label={t("அர்ச்சனை வகை", "Archana option")}>
      {(a11y) => <select {...a11y} value={seva.id} onChange={(e) => onService(Number(e.target.value))}>
        {services.filter((s) => s.service_kind?.startsWith("archana")).map((s) =>
          <option value={s.id} key={s.id}>{t(s.name_ta, s.name_en)}</option>)}
      </select>}
    </Field>}
    {delivery && <fieldset className="booking-delivery">
      <legend>{t("பிரசாதம் அனுப்பும் முகவரி", "Prasadam delivery address")}</legend>
      <p>{t("மேலே உள்ள தொடர்பு எண்ணிற்கு விநியோக தகவல்கள் அனுப்பப்படும்.", "The contact number above will be used for delivery updates.")}</p>
      {[
        ["address", "வீட்டு எண் மற்றும் தெரு", "House number, street and area", 500],
        ["city", "நகரம்", "City", 120], ["state", "மாநிலம்", "State / province", 120],
        ["country", "நாடு", "Country", 100], ["postcode", "அஞ்சல் குறியீடு", "Postal code", 20],
      ].map(([key, ta, en, max]) => <Field key={key} id={`booking-delivery-${key}`} required
        label={t(ta, en)} error={errors[`delivery_address.${key}`]}>
        {(a11y) => <input {...a11y} value={address[key]} maxLength={max} autoComplete={key === "postcode" ? "postal-code" : undefined}
          onChange={(e) => setAddress({ ...address, [key]: e.target.value })} />}
      </Field>)}
    </fieldset>}
  </>;
}
