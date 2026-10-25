import { Field } from "../ui/Field";
import { earliestBirthDate, templeToday } from "../../lib/familyRegistration";

export default function PersonDetails({ person, prefix, errors, onChange, t, includeBirth = true, includeMarriage = true, birthLast = false }) {
  const fields = [
    ...(includeBirth && !birthLast ? [["dateOfBirth", "பிறந்த தேதி", "Date of birth", "date"]] : []),
    ...(includeMarriage ? [["marriageDate", "திருமண தேதி", "Marriage date", "date"]] : []),
    ["rasi", "ராசி", "Rasi", "text"],
    ["nakshatram", "நட்சத்திரம்", "Nakshatram", "text"],
    ...(includeBirth && birthLast ? [["dateOfBirth", "பிறந்த தேதி", "Date of birth", "date"]] : []),
  ];
  return fields.map(([key, ta, en, type]) => <Field key={key} id={`${prefix}-${key}`} optional
    label={t(ta, en)} error={errors[key]} announce={false}>
    {(a11y) => <input {...a11y} type={type} value={person[key] ?? ""} onChange={(e) => onChange(key, e.target.value)}
      min={type === "date" ? earliestBirthDate() : undefined} max={type === "date" ? templeToday() : undefined}
      maxLength={type === "text" ? 100 : undefined} />}
  </Field>);
}
