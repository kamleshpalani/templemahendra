import { LuTrash2, LuUserPlus, LuUsers } from "react-icons/lu";
import Button from "../ui/Button";
import { Field } from "../ui/Field";
import { LIMITS, RELATIONSHIPS } from "../../lib/familyRegistration";

/**
 * Step 2 — the family, if the registrant wants to add them. Optional: a family
 * of one registers by pressing "Skip for now".
 *
 * Each member is a card with a stable key, so removing the second of four never
 * moves what was typed in the third into the second's fields. The page moves
 * focus after an add or a remove and announces it (pages/Register.jsx owns both,
 * because it knows which card comes next).
 */
export default function FamilyStep({ members, errors, onAdd, onRemove, onMemberChange, t }) {
  const count = members.length;
  const atCap = count >= LIMITS.maxMembers;

  if (count === 0) {
    return (
      <div className="reg-empty">
        <span className="reg-empty__icon" aria-hidden="true">
          <LuUsers />
        </span>
        <p className="reg-empty__text">
          {t(
            "இன்னும் யாரையும் சேர்க்கவில்லை. வாழ்க்கைத் துணை, பிள்ளைகள், பெற்றோர் — உங்கள் குடும்பத்தில் யாரை வேண்டுமானாலும் சேர்க்கலாம்.",
            "No one added yet. Add your spouse, children, parents — anyone in your family.",
          )}
        </p>
        <Button id="reg-add-member" variant="outline" icon={<LuUserPlus aria-hidden="true" />} onClick={onAdd}>
          {t("குடும்ப உறுப்பினரைச் சேர்", "Add family member")}
        </Button>
        {errors.members && <p className="field__error reg-family__error">{errors.members}</p>}
      </div>
    );
  }

  return (
    <div className="reg-family">
      <p className="reg-family__count">
        {count === 1 ? t("1 உறுப்பினர்", "1 member") : t(`${count} உறுப்பினர்கள்`, `${count} members`)}
      </p>

      <ul className="reg-members">
        {members.map((m, i) => {
          const n = i + 1;
          const who = m.name.trim();
          return (
            <li key={m.key} className="reg-member">
              <fieldset className="reg-member__set">
                <legend className="reg-member__legend">
                  <span className="reg-member__badge" aria-hidden="true">
                    {n}
                  </span>
                  {t(`உறுப்பினர் ${n}`, `Member ${n}`)}
                </legend>

                <div className="reg-member__fields">
                  <Field
                    id={`reg-member-${m.key}-name`}
                    label={t("பெயர்", "Name")}
                    required
                    error={errors[`members.${m.key}.name`]}
                    announce={false}
                  >
                    {(a11y) => (
                      <input
                        {...a11y}
                        value={m.name}
                        onChange={(e) => onMemberChange(m.key, "name", e.target.value)}
                        autoComplete="off"
                        maxLength={LIMITS.memberName[1]}
                      />
                    )}
                  </Field>

                  <Field
                    id={`reg-member-${m.key}-relationship`}
                    label={t("உறவு முறை", "Relationship")}
                    required
                    error={errors[`members.${m.key}.relationship`]}
                    announce={false}
                  >
                    {(a11y) => (
                      <select
                        {...a11y}
                        value={m.relationship}
                        onChange={(e) => onMemberChange(m.key, "relationship", e.target.value)}
                      >
                        <option value="">{t("தேர்ந்தெடுக்கவும்…", "Choose…")}</option>
                        {RELATIONSHIPS.map((r) => (
                          <option key={r.value} value={r.value}>
                            {t(r.ta, r.en)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>

                  <Field
                    id={`reg-member-${m.key}-age`}
                    label={t("வயது", "Age")}
                    optional
                    error={errors[`members.${m.key}.age`]}
                    announce={false}
                  >
                    {(a11y) => (
                      <input
                        {...a11y}
                        value={m.age}
                        onChange={(e) => onMemberChange(m.key, "age", e.target.value)}
                        inputMode="numeric"
                        maxLength={3}
                        autoComplete="off"
                      />
                    )}
                  </Field>
                </div>

                <div className="reg-member__foot">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="reg-member__remove"
                    icon={<LuTrash2 aria-hidden="true" />}
                    onClick={() => onRemove(m.key)}
                    aria-label={t(
                      `நீக்கு: உறுப்பினர் ${n}${who ? ` — ${who}` : ""}`,
                      `Remove member ${n}${who ? ` — ${who}` : ""}`,
                    )}
                  >
                    {t("நீக்கு", "Remove")}
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ul>

      {atCap ? (
        <p className="reg-family__cap">
          {t(
            `ஒரு பதிவில் அதிகபட்சம் ${LIMITS.maxMembers} உறுப்பினர்கள். மேலும் இருந்தால் கோயில் அலுவலகத்தைத் தொடர்பு கொள்ளுங்கள்.`,
            `Up to ${LIMITS.maxMembers} members in one registration. For more, contact the temple office.`,
          )}
        </p>
      ) : (
        <Button
          id="reg-add-member"
          variant="soft"
          className="reg-family__add"
          icon={<LuUserPlus aria-hidden="true" />}
          onClick={onAdd}
        >
          {t("மற்றொரு குடும்ப உறுப்பினரைச் சேர்", "Add another family member")}
        </Button>
      )}
      {errors.members && <p className="field__error reg-family__error">{errors.members}</p>}
    </div>
  );
}
