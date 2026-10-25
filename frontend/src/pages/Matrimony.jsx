import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLang } from "../context/LangContext";
import api from "../services/api";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field } from "../components/ui/Field";
import PhoneInput from "../components/ui/PhoneInput";
import { countryOf, phoneProblem, toE164 } from "../lib/phone";
import { ageFrom, isRealDate, templeToday } from "../lib/familyRegistration";
import "./PageCommon.css";
import "./Matrimony.css";

const blank = () => ({
  name: "", dateOfBirth: "", phone: "", phoneCountry: "IN", email: "", city: "", education: "",
  occupation: "", rasi: "", nakshatram: "", introduction: "", preferences: "",
  visibility: "private", consent: false, reuseConsent: false, hp_token: "",
});

export default function Matrimony() {
  const { t } = useLang();
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const [profiles, setProfiles] = useState([]);
  const [token, setToken] = useState("");
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [summaryError, setSummaryError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (key, value) => setForm((old) => ({ ...old, [key]: value }));

  const loadSummaries = () => api.get("/matrimony").then((r) => {
    setProfiles(r.data); setSummaryError(false);
  }).catch(() => setSummaryError(true));
  useEffect(() => { loadSummaries(); }, []);

  function importDraft() {
    if (!form.reuseConsent) return;
    try {
      const draft = JSON.parse(sessionStorage.getItem("temple:registration-draft") ?? "null")?.form;
      if (!draft) {
        setNotice({ tone: "warning", text: t("இந்த உலாவித் தாவலில் குடும்ப வரைவு இல்லை. தனிப்பட்ட விவரங்களை உள்ளிடவும்.", "There is no family draft in this tab. Enter your details below.") });
        return;
      }
      setForm((old) => ({ ...old, ...Object.fromEntries(["name", "dateOfBirth", "phone", "phoneCountry", "email", "city", "rasi", "nakshatram"]
        .filter((key) => typeof draft[key] === "string").map((key) => [key, draft[key]])) }));
      setNotice({ tone: "info", text: t("உங்கள் வரைவு நகலெடுக்கப்பட்டது. உங்கள் சொந்த விவரங்கள் மட்டுமே என்பதைச் சரிபார்க்கவும்.", "Draft details copied with your permission. Check that these are your own details.") });
    } catch {
      setNotice({ tone: "error", text: t("குடும்ப வரைவைப் படிக்க இயலவில்லை.", "The family draft could not be read. Please enter your details.") });
    }
  }
  async function manage(action) {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const r = await api.post("/matrimony", { action, management_token: token.trim() });
      if (action === "load") {
        const p = r.data.profile;
        setEditing(p.id);
        // Stored phone is international; PhoneInput accepts the national part.
        const country = p.phone_country || "IN";
        const dial = countryOf(country).dial;
        setForm({ ...blank(), ...Object.fromEntries(Object.keys(blank()).filter((k) => typeof p[k] === "string").map((k) => [k, p[k]])),
          dateOfBirth: p.date_of_birth, phone: p.phone.startsWith(dial) ? p.phone.slice(dial.length) : p.phone,
          phoneCountry: country, reuseConsent: Boolean(p.reuse_consent_at), consent: false });
        setNotice({ tone: "info", text: t("சுயவிவரம் திறக்கப்பட்டது. மாற்றங்கள் மீண்டும் பரிசீலிக்கப்படும்.", `Profile #${p.id} loaded (${p.status}). Edits require a new review.`) });
      } else {
        setEditing(null); setToken(""); setForm(blank()); setConfirmDelete(false);
        setNotice({ tone: "success", text: t("சுயவிவரம் நீக்கப்பட்டது.", "Your profile and personal details have been deleted.") });
        await loadSummaries();
      }
    } catch (error) {
      setNotice({ tone: "error", text: error.response?.data?.error || t("கோரிக்கை தோல்வி.", "The request failed. Please try again.") });
    } finally { setBusy(false); }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const next = {};
    if (form.name.trim().length < 2) next.name = t("பெயரை உள்ளிடவும்.", "Enter your full name.");
    if (!isRealDate(form.dateOfBirth) || ageFrom(form.dateOfBirth) < 18) next.dateOfBirth = t("18 வயது நிறைந்தவர்கள் மட்டுமே பதிவு செய்யலாம்.", "You must be at least 18.");
    const phoneError = phoneProblem(form.phone, form.phoneCountry, { required: true, t });
    if (phoneError) next.phone = phoneError;
    if (form.city.trim().length < 2) next.city = t("நகரத்தை உள்ளிடவும்.", "Enter your city.");
    if (!form.consent) next.consent = t("உங்கள் ஒப்புதல் தேவை.", "Your consent is required.");
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true); setNotice(null);
    try {
      const r = await api.post("/matrimony", {
        ...form, phone: toE164(form.phone, form.phoneCountry),
        action: editing ? "update" : "create", management_token: editing ? token.trim() : undefined,
      });
      if (!r.data.id) throw new Error("The server did not confirm a profile.");
      setEditing(r.data.id);
      if (r.data.management_token) setToken(r.data.management_token);
      setNotice({ tone: "success", text: t("சுயவிவரம் தனிப்பட்ட பரிசீலனைக்கு அனுப்பப்பட்டது. நிர்வாகச் சாவியைப் பாதுகாப்பாகச் சேமிக்கவும்.", "Profile submitted for private review. Save your management key securely to edit or delete it later.") });
      set("consent", false);
      await loadSummaries();
    } catch (error) {
      if (error.response?.data?.fields) setErrors(error.response.data.fields);
      setNotice({ tone: "error", text: error.response?.data?.error || t("சுயவிவரத்தைச் சேமிக்க இயலவில்லை.", "The profile could not be saved.") });
    } finally { setBusy(false); }
  }

  return <>
    <Seo title={t("திருமணத் தகவல்", "Matrimony")}
      description={t("உங்கள் ஒப்புதலுடன், உங்கள் தனியுரிமையுடன்.", "Your consent. Your privacy.")} />
    <PageHero title={t("திருமணத் தகவல்", "Matrimony")} lead={t("உங்கள் ஒப்புதலுடன், உங்கள் தனியுரிமையுடன்.", "Your consent. Your privacy.")}
      crumbs={[{ label: t("திருமணத் தகவல்", "Matrimony") }]} />
    <section className="section"><div className="container page-prose">
      <h2>{t("சுயவிவரப் பதிவு", "Register your profile")}</h2>
      <p>{t("18 வயதுக்கு மேற்பட்டவர்கள் தங்கள் சொந்த சுயவிவரத்தை மட்டும் பதிவு செய்யலாம். குடும்பப் பதிவு தானாகப் பகிரப்படாது.",
        "Adults aged 18 or over may register their own profile. Family registrations are never automatically shared or looked up by phone number.")}</p>
      <div className="card stack">
        <label className="checkbox-label"><input type="checkbox" checked={form.reuseConsent} onChange={(e) => set("reuseConsent", e.target.checked)} />
          {t("இந்தத் தாவலில் உள்ள குடும்பப் பதிவு வரைவிலிருந்து எனது விவரங்களை மட்டும் நகலெடுக்க அனுமதிக்கிறேன்.",
            "I permit copying my own details from the family registration draft in this tab.")}</label>
        <Button variant="outline" disabled={!form.reuseConsent} onClick={importDraft}>{t("எனது விவரங்களை நகலெடு", "Copy my draft details")}</Button>
      </div>
      <form onSubmit={submit} className="card stack" noValidate>
        <div className="form-grid">
          {[
            ["name", "முழுப் பெயர்", "Full name", 200], ["city", "நகரம்", "City", 120],
            ["education", "கல்வி", "Education", 200], ["occupation", "தொழில்", "Occupation", 200],
            ["rasi", "ராசி", "Rasi", 100], ["nakshatram", "நட்சத்திரம்", "Nakshatram", 100],
            ["email", "மின்னஞ்சல்", "Email", 190],
          ].map(([key, ta, en, max]) => <Field key={key} id={`matrimony-${key}`} label={t(ta, en)}
            required={["name", "city"].includes(key)} optional={!["name", "city"].includes(key)} error={errors[key]}>
            {(a11y) => <input {...a11y} value={form[key]} type={key === "email" ? "email" : "text"} maxLength={max}
              onChange={(e) => set(key, e.target.value)} />}
          </Field>)}
          <Field id="matrimony-dob" label={t("பிறந்த தேதி", "Date of birth")} required error={errors.dateOfBirth}>
            {(a11y) => <input {...a11y} type="date" value={form.dateOfBirth} max={templeToday()} onChange={(e) => set("dateOfBirth", e.target.value)} />}
          </Field>
          <Field id="matrimony-phone" label={t("தொலைபேசி", "Phone")} required error={errors.phone}>
            {(a11y) => <PhoneInput {...a11y} country={form.phoneCountry} national={form.phone} onChange={({ country, national }) => {
              set("phoneCountry", country); set("phone", national);
            }} />}
          </Field>
        </div>
        {[
          ["introduction", "அறிமுகம்", "Introduction"], ["preferences", "விருப்பங்கள்", "Partner preferences"],
        ].map(([key, ta, en]) => <Field key={key} label={t(ta, en)} optional error={errors[key]}>
          {(a11y) => <textarea {...a11y} maxLength={1000} rows={3} value={form[key]} onChange={(e) => set(key, e.target.value)} />}
        </Field>)}
        <p>{t("அறிமுகம் மற்றும் விருப்பங்களில் தொலைபேசி, மின்னஞ்சல் அல்லது பிற தனிப்பட்ட அடையாளங்களைச் சேர்க்க வேண்டாம்.",
          "Do not include phone numbers, email addresses or identifying personal details in your introduction or preferences.")}</p>
        <Field label={t("தனியுரிமை", "Privacy")} error={errors.visibility}>
          {(a11y) => <select {...a11y} value={form.visibility} onChange={(e) => set("visibility", e.target.value)}>
            <option value="private">{t("கமிட்டிக்கு மட்டும்", "Private — committee only")}</option>
            <option value="public_summary">{t("ஒப்புதலுக்குப் பின் பெயரில்லா சுருக்கம்", "Publish anonymous summary after approval")}</option>
          </select>}
        </Field>
        <p>{t("பெயர், பிறந்த தேதி மற்றும் தொடர்பு விவரங்கள் பொதுவில் காட்டப்படாது. சுருக்கத்தில் வயது, நகரம், கல்வி, தொழில், அறிமுகம் மற்றும் விருப்பங்கள் இருக்கும்.",
          "Name, exact birth date and contact details are never published. A public summary includes age, city, education, occupation, introduction and preferences.")}</p>
        <label className="checkbox-label"><input type="checkbox" checked={form.consent} onChange={(e) => set("consent", e.target.checked)} />
          {t("இது எனது சுயவிவரம். தனிப்பட்ட கமிட்டி பரிசீலனைக்கும், தேர்ந்தெடுத்த தனியுரிமை அமைப்புக்கும் ஒப்புக்கொள்கிறேன்.",
            "This is my own profile. I consent to private committee review and the privacy setting selected above.")}</label>
        {errors.consent && <p role="alert" className="field__error">{errors.consent}</p>}
        <div className="matrimony-hp" aria-hidden="true"><input name="hp_token" tabIndex={-1} autoComplete="off" value={form.hp_token} onChange={(e) => set("hp_token", e.target.value)} /></div>
        <Link to="/privacy-policy">{t("தனியுரிமைக் கொள்கை", "Privacy policy")}</Link>
        <Button type="submit" loading={busy}>{editing ? t("மீண்டும் பரிசீலனைக்கு அனுப்பு", "Save and submit for review") : t("பதிவு செய்", "Register profile")}</Button>
      </form>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <section className="card stack">
        <h2>{t("எனது சுயவிவரத்தை நிர்வகி", "Manage my profile")}</h2>
        <p>{t("இந்தச் சாவியை ரகசியமாக வைத்திருங்கள். இதை வைத்திருப்பவர் உங்கள் சுயவிவரத்தைத் திருத்தலாம் அல்லது நீக்கலாம்.",
          "Keep this key secret and save it securely. Anyone with it can edit or delete your profile. It is not sent by email.")}</p>
        <Field label={t("நிர்வாகச் சாவி", "Management key")}>
          {(a11y) => <input {...a11y} type="password" value={token} autoComplete="off" onChange={(e) => { setToken(e.target.value); setEditing(null); setConfirmDelete(false); }} />}
        </Field>
        {editing && <details><summary>{t("சாவியைக் காட்டவும் / நகலெடுக்கவும்", "Show / copy your management key")}</summary><p className="matrimony-key">{token}</p></details>}
        <Button variant="outline" disabled={!token.trim() || busy} onClick={() => manage("load")}>{t("சுயவிவரத்தைத் திற", "Load my profile")}</Button>
        {editing && <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t("சுயவிவரத்தை நீக்கு", "Delete my profile")}</Button>}
        {confirmDelete && <Alert tone="warning">{t("சுயவிவரமும் தனிப்பட்ட தகவல்களும் நிரந்தரமாக நீக்கப்படும்.", "Your profile and personal details will be permanently deleted.")}
          <div className="cluster"><Button variant="danger" loading={busy} onClick={() => manage("delete")}>{t("நீக்குவதை உறுதி செய்", "Confirm deletion")}</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>{t("ரத்து", "Cancel")}</Button></div>
        </Alert>}
      </section>
      <h2>{t("ஒப்புதல் பெற்ற சுயவிவரங்கள்", "Approved profile summaries")}</h2>
      {summaryError ? <Alert tone="error">{t("சுயவிவரங்களை ஏற்ற இயலவில்லை.", "Profile summaries could not be loaded.")}
        <Button variant="outline" onClick={loadSummaries}>{t("மீண்டும் முயற்சி", "Try again")}</Button></Alert> : profiles.length === 0 ?
        <p>{t("இப்போது பொதுச் சுருக்கங்கள் இல்லை.", "No public summaries are available right now.")}</p> :
        <div className="grid-2">{profiles.map((p) => <article className="card" key={p.id}>
          <h3>{t("சுயவிவரம்", "Profile")} #{p.id}</h3>
          <p>{t("வயது", "Age")} {p.age} · {p.city}</p><p>{[p.education, p.occupation].filter(Boolean).join(" · ")}</p>
          <p>{p.introduction}</p><p>{p.preferences}</p>
          <Button to="/contact" variant="outline">{t("கமிட்டியைத் தொடர்பு கொள்ளவும்", "Contact committee with profile number")}</Button>
        </article>)}</div>}
    </div></section>
  </>;
}
