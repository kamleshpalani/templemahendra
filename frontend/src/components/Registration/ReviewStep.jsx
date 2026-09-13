import { LuHouse, LuPencil, LuUser, LuUsers } from "react-icons/lu";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import { rateLimitMessage } from "../../context/LangContext";
import { formatInternational, subdivisionsOf } from "../../lib/phone";
import { ageFrom, countryName, formatBirthDate, isBlankMember, relationshipLabel } from "../../lib/familyRegistration";

/** One summary card with its heading and an Edit button that opens its step. */
function ReviewSection({ id, icon, title, editName, onEdit, t, children }) {
  return (
    <section className="reg-review" aria-labelledby={id}>
      <div className="reg-review__head">
        <h3 id={id} className="reg-review__title">
          <span className="reg-review__icon" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h3>
        {/* The name starts with the visible word, so voice control users can
            say "Edit" and still reach the right one. */}
        <Button variant="ghost" size="sm" icon={<LuPencil aria-hidden="true" />} onClick={onEdit} aria-label={editName}>
          {t("திருத்து", "Edit")}
        </Button>
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="reg-review__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Step 4 — everything the family entered, laid out to be checked, with a way
 * back to each part; then the consent tick box and Submit (the action bar in
 * pages/Register.jsx).
 */
export default function ReviewStep({ form, onEdit, setField, status, retryAfter, t, lang }) {
  const notGiven = <span className="reg-review__muted">{t("குறிப்பிடப்படவில்லை", "Not given")}</span>;
  const members = form.members.filter((m) => !isBlankMember(m));
  const age = ageFrom(form.dateOfBirth);
  const state = subdivisionsOf(form.country).find((s) => s.code === form.state)?.name ?? form.state.trim();
  const postcode = form.country === "IN" ? form.postcode.replace(/\s+/g, "") : form.postcode.trim();

  return (
    <div className="reg-review-list">
      <ReviewSection
        id="reg-review-personal"
        icon={<LuUser />}
        title={t("தனிப்பட்ட விவரங்கள்", "Personal details")}
        editName={t("திருத்து: தனிப்பட்ட விவரங்கள்", "Edit personal details")}
        onEdit={() => onEdit("personal")}
        t={t}
      >
        <dl className="reg-review__list">
          <Row label={t("முழுப் பெயர்", "Full name")}>{form.name.trim()}</Row>
          <Row label={t("தொலைபேசி", "Phone")}>{formatInternational(form.phone, form.phoneCountry)}</Row>
          <Row label={t("மின்னஞ்சல்", "Email")}>{form.email.trim() || notGiven}</Row>
          <Row label={t("பிறந்த தேதி", "Date of birth")}>
            {form.dateOfBirth ? (
              <>
                {formatBirthDate(form.dateOfBirth, lang)}
                {age !== null && <span className="reg-review__muted"> · {t(`வயது ${age}`, `Age ${age}`)}</span>}
              </>
            ) : (
              notGiven
            )}
          </Row>
          <Row label={t("விருப்ப மொழி", "Preferred language")}>
            <span lang={form.lang}>{form.lang === "ta" ? "தமிழ்" : "English"}</span>
          </Row>
        </dl>
      </ReviewSection>

      <ReviewSection
        id="reg-review-family"
        icon={<LuUsers />}
        title={t("குடும்ப உறுப்பினர்கள்", "Family members")}
        editName={t("திருத்து: குடும்ப உறுப்பினர்கள்", "Edit family members")}
        onEdit={() => onEdit("family")}
        t={t}
      >
        {members.length ? (
          <ul className="reg-review__members">
            {members.map((m) => {
              const memberAge = String(m.age).trim();
              return (
                <li key={m.key} className="reg-review__member">
                  <span className="reg-review__member-name">{m.name.trim()}</span>
                  <span className="reg-review__member-meta">
                    {relationshipLabel(m.relationship, t)}
                    {memberAge !== "" && ` · ${t(`வயது ${Number(memberAge)}`, `Age ${Number(memberAge)}`)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="reg-review__none">
            {t("குடும்ப உறுப்பினர்கள் சேர்க்கப்படவில்லை.", "No family members added.")}{" "}
            <button type="button" className="reg-link" onClick={() => onEdit("family")}>
              {t("உறுப்பினர்களைச் சேர்", "Add members")}
            </button>
          </p>
        )}
      </ReviewSection>

      <ReviewSection
        id="reg-review-address"
        icon={<LuHouse />}
        title={t("வீட்டு முகவரி", "Home address")}
        editName={t("திருத்து: வீட்டு முகவரி", "Edit home address")}
        onEdit={() => onEdit("address")}
        t={t}
      >
        <address className="reg-review__address">
          <span>{form.address1.trim()}</span>
          {form.address2.trim() && <span>{form.address2.trim()}</span>}
          <span>{[form.city.trim(), state].filter(Boolean).join(", ")}</span>
          <span>
            {countryName(form.country)}
            {postcode && ` – ${postcode}`}
          </span>
        </address>
      </ReviewSection>

      <div className="reg-consent">
        <label className="checkbox-label" htmlFor="reg-consent">
          <input
            id="reg-consent"
            type="checkbox"
            checked={form.consent}
            onChange={(e) => setField("consent", e.target.checked)}
            aria-describedby="reg-consent-hint"
          />
          <span>
            {t(
              "திருவிழா, பூஜை மற்றும் கோயில் அறிவிப்புகளை வாட்ஸ்அப், குறுஞ்செய்தி அல்லது மின்னஞ்சல் மூலம் எனக்கு அனுப்பவும்",
              "Send me festival, pooja and temple updates by WhatsApp, SMS or email",
            )}
          </span>
        </label>
        <span id="reg-consent-hint" className="field__hint reg-consent__hint">
          {t(
            "விருப்பம். ஒவ்வொரு செய்தியிலும் நிறுத்துவதற்கான இணைப்பு இருக்கும்.",
            "Optional. Every update has a link to stop them.",
          )}
        </span>
      </div>

      {status === "limited" && (
        <Alert tone="warning" className="reg-status">
          {rateLimitMessage(t, retryAfter)}
        </Alert>
      )}
      {status === "error" && (
        <Alert tone="error" className="reg-status">
          {t(
            "பதிவைச் சேமிக்க இயலவில்லை. மீண்டும் முயற்சிக்கவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
            "We could not save the registration. Please try again, or call the temple office.",
          )}
        </Alert>
      )}
      {status === "unavailable" && (
        <Alert tone="error" className="reg-status">
          {t(
            "பதிவு இப்போது கிடைக்கவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
            "Registration is not available right now. Please try again later, or call the temple office.",
          )}
        </Alert>
      )}
      {status === "network" && (
        <Alert tone="error" className="reg-status">
          {t(
            "கோயில் சேவையகத்தை அடைய முடியவில்லை. இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.",
            "Could not reach the temple server. Check your connection and try again.",
          )}
        </Alert>
      )}
    </div>
  );
}
