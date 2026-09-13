import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  LuBookOpen,
  LuCircleCheck,
  LuCircleDot,
  LuDroplets,
  LuFlame,
  LuFlower2,
  LuPhone,
  LuSend,
  LuSun,
  LuTruck,
  LuUtensils,
} from "react-icons/lu";
import api from "../services/api";
import { useLang, rateLimitInfo, rateLimitMessage } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import { useAuth } from "../context/AuthContext";
import PhoneInput from "../components/ui/PhoneInput";
import { parseInternational, phoneProblem, toE164 } from "../lib/phone";
import { DEFAULT_COUNTRY } from "../data/countries";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Alert from "../components/ui/Alert";
import { Field } from "../components/ui/Field";
import PageHero from "../components/ui/PageHero";
import Seo from "../components/Seo";
import ShareButton from "../components/Share/ShareButton";
import SectionHeader from "../components/ui/SectionHeader";
import Modal from "../components/ui/Modal";
import { SkeletonCards } from "../components/ui/Feedback";
import { SECONDARY_CONTACT, formatPhone, telHref } from "../data/temple";
import { todayIST } from "../lib/templeTime";
import "./Sevas.css";

/* ── Icons ───────────────────────────────────────────────────────────
   Known sevas get a matching glyph (matched on the English or Tamil
   name); anything else rotates through the cycle so a long API list
   still reads as varied. UI chrome only — no facts are derived here. */
const SEVA_ICON_CYCLE = [LuFlame, LuFlower2, LuSun, LuBookOpen, LuUtensils, LuTruck];
const SEVA_ICON_RULES = [
  [/abhishek|abishek|அபிஷேக/i, LuDroplets],
  [/archan|flower|pushp|அர்ச்சனை/i, LuFlower2],
  [/deepa|lamp|arathi|aarti|aradhana|தீப/i, LuFlame],
  [/sahasra|nama|chant|recit|parayan|homa|சகஸ்ர|நாம|ஹோம/i, LuBookOpen],
  [/annadan|meal|food|prasad|அன்னதான/i, LuUtensils],
  [/vahana|procession|vehicle|வாகன/i, LuTruck],
];
function sevaIcon(seva, index) {
  const key = `${seva.name_en ?? ""} ${seva.name_ta ?? ""} ${seva.name ?? ""}`;
  const hit = SEVA_ICON_RULES.find(([re]) => re.test(key));
  return hit ? hit[1] : SEVA_ICON_CYCLE[index % SEVA_ICON_CYCLE.length];
}

/*
 * A seva's name and note in the reading language. Defined once: the card, the
 * page's own <Seo> and the share sheet all have to say the same thing about the
 * same offering.
 */
const sevaName = (seva, lang) => (lang === "ta" ? seva.name_ta : seva.name_en) || seva.name_en || seva.name_ta || "";
const sevaDescription = (seva, lang) => {
  if (!seva.description_ta && !seva.description_en && !seva.description) return null;
  return (lang === "ta" ? (seva.description_ta ?? seva.description) : (seva.description_en ?? seva.description)) || null;
};

/* Standard list shown whenever the API returns nothing (or fails). */
const FALLBACK_SEVAS = [
  {
    id: 1,
    name_ta: "அபிஷேகம்",
    name_en: "Abhishekam",
    amount: 251,
    description_ta: "பாலாபிஷேகம், தேன் மற்றும் ரோஜாநீரால் தெய்வ அபிஷேகம்.",
    description_en: "Sacred bathing of the deity with milk, honey, and rose water.",
  },
  {
    id: 2,
    name_ta: "அர்ச்சனை",
    name_en: "Archana",
    amount: 51,
    description_ta: "தெய்வத்தின் நாமங்களை ஓதி மலர் சமர்ப்பணம்.",
    description_en: "Offering of flowers with chanting of the deity's names.",
  },
  {
    id: 3,
    name_ta: "தீபாராதனை",
    name_en: "Deepa Aradhana",
    amount: 101,
    description_ta: "தெய்வத்திற்கு தீபாராதனை செய்தல்.",
    description_en: "Waving of sacred lamps before the deity.",
  },
  {
    id: 4,
    name_ta: "சகஸ்ர நாமம்",
    name_en: "Sahasranama",
    amount: 501,
    description_ta: "தெய்வத்தின் 1000 நாமங்களை சொல்லுதல்.",
    description_en: "Recitation of 1000 names of the deity.",
  },
  {
    id: 5,
    name_ta: "அன்னதானம்",
    name_en: "Annadanam",
    amount: 2001,
    description_ta: "பக்தர்களுக்கும் ஏழைகளுக்கும் இலவச உணவு வழங்குதல்.",
    description_en: "Sponsoring a free meal for devotees and the needy.",
  },
  {
    id: 6,
    name_ta: "வாகன பூஜை",
    name_en: "Vahana Pooja",
    amount: 1001,
    description_ta: "திருவிழா வாகனத்தில் சிறப்பு ஊர்வலம்.",
    description_en: "Ceremonial procession of the festival vehicle.",
  },
];

/* ── Seva Booking Modal ─────────────────────────────────────────── */
function BookingModal({ seva, onClose, t, lang }) {
  const toast = useToast();
  // A signed-in devotee should not retype what the temple already holds. The
  // server stamps the booking with their account id either way.
  const { user } = useAuth();
  const saved = parseInternational(user?.phone ?? "", user?.phoneCountry) ?? {
    country: user?.phoneCountry || DEFAULT_COUNTRY,
    national: "",
  };
  const [form, setForm] = useState({
    devotee_name: user?.name ?? "",
    phone: saved.national,
    phoneCountry: saved.country,
    preferred_date: "",
    message: "",
    hp_token: "",
  });
  const [errors, setErrors] = useState({});
  const [status, setStatus] = useState("idle"); // idle | loading | success | error | limited
  const [errMsg, setErrMsg] = useState("");
  // Kept as seconds, not as a sentence, so the notice follows a language switch.
  const [retryAfter, setRetryAfter] = useState(null);
  const closeRef = useRef(null);

  // The form unmounts on success; move focus to the Close button so the
  // focus trap does not fall back to the document behind the dialog.
  useEffect(() => {
    if (status === "success") closeRef.current?.focus({ preventScroll: true });
  }, [status]);

  function handleChange(e) {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
    if (errors[name]) setErrors((er) => ({ ...er, [name]: undefined }));
  }

  function validate() {
    const next = {};
    if (form.devotee_name.trim().length < 2)
      next.devotee_name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    const pe = phoneProblem(form.phone, form.phoneCountry, { required: true });
    if (pe) next.phone = pe;
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    setStatus("loading");
    setErrMsg("");
    try {
      await api.post("/seva-bookings", {
        seva_id: seva.id,
        seva_name: sevaName(seva, lang),
        devotee_name: form.devotee_name,
        phone: toE164(form.phone, form.phoneCountry),
        phoneCountry: form.phoneCountry,
        preferred_date: form.preferred_date || null,
        message: form.message,
        hp_token: form.hp_token,
      });
      setStatus("success");
      toast.success(
        t("உங்கள் சேவை பதிவு பெறப்பட்டது.", "Your seva request has been received."),
        t("பதிவு வெற்றி", "Booking received"),
      );
    } catch (err) {
      const limited = rateLimitInfo(
        err?.response?.status,
        err?.response?.data,
        err?.response?.headers?.["retry-after"],
      );
      if (limited) {
        setRetryAfter(limited.retryAfter);
        setStatus("limited");
        return;
      }
      setErrMsg(
        err?.response?.data?.error ||
          t(
            "சமர்ப்பிக்க இயலவில்லை. மீண்டும் முயற்சிக்கவும்.",
            "Submission failed. Please try again.",
          ),
      );
      setStatus("error");
    }
  }

  // The same helper the cards use, so the dialog cannot disagree with the tile
  // it was opened from.
  const name = sevaName(seva, lang);
  const busy = status === "loading";

  if (status === "success") {
    return (
      <Modal open onClose={onClose} size="md" labelledBy="booking-success-title">
        <div className="booking-success">
          <span className="booking-success__icon" aria-hidden="true">
            <LuCircleCheck />
          </span>
          <h2 id="booking-success-title" className="booking-success__title">
            {t("பதிவு வெற்றி!", "Booking Received!")}
          </h2>
          <p className="booking-success__text">
            {t(
              "உங்கள் சேவை பதிவு பெறப்பட்டது. கோயில் அலுவலகம் விரைவில் தொடர்பு கொள்ளும்.",
              "Your seva request has been received. The temple office will contact you shortly.",
            )}
          </p>
          <div className="booking-success__meta">
            <Badge tone="gold">{name}</Badge>
            <Badge tone="muted">₹{seva.amount}</Badge>
          </div>
          <Button ref={closeRef} variant="primary" onClick={onClose}>
            {t("மூடு", "Close")}
          </Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      eyebrow={t("சேவை பதிவு", "Book Seva")}
      title={name}
      description={t(
        "விவரங்களை நிரப்பவும் — கோயில் அலுவலகம் தொலைபேசியில் உறுதி செய்யும்.",
        "Fill in your details — the temple office will confirm by phone.",
      )}
     
    >
      <p className="booking-modal__amount">
        <span className="booking-modal__value text-gradient">₹{seva.amount}</span>
        <span className="booking-modal__unit">{t("சமர்ப்பணம்", "offering")}</span>
      </p>

      <form className="booking-form" onSubmit={handleSubmit} noValidate>
        <Field label={t("உங்கள் பெயர்", "Your Name")} required error={errors.devotee_name}>
          {(a11y) => (
            <input
              type="text"
              name="devotee_name"
              value={form.devotee_name}
              onChange={handleChange}
              required
              minLength={2}
              maxLength={200}
              autoComplete="name"
              placeholder={t("முழு பெயர்", "Full name")}
              {...a11y}
            />
          )}
        </Field>

        {/* Honeypot. People never see it and cannot Tab to it; form-filling bots
            do fill it, and the server then quietly saves nothing. It must not be
            the first or last input: the dialog's focus trap counts every input,
            so either end would steal the initial focus or break Tab wrapping. */}
        <div className="visually-hidden" aria-hidden="true">
          <label htmlFor="booking-hp-token">
            {t("இந்தப் புலத்தை காலியாக விடவும்", "Leave this field empty")}
          </label>
          <input
            id="booking-hp-token"
            type="text"
            name="hp_token"
            value={form.hp_token}
            onChange={handleChange}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        <div className="field-row">
          <Field
            label={t("தொலைபேசி", "Phone Number")}
            required
            error={errors.phone}
            hint={t("நாட்டைத் தேர்ந்தெடுத்து, முன்னால் உள்ள 0 இல்லாமல் எண்ணை உள்ளிடவும்", "Pick your country, then type the number without its leading 0")}
          >
            {(a11y) => (
              <PhoneInput
                {...a11y}
                name="phone"
                country={form.phoneCountry}
                national={form.phone}
                onChange={({ country, national }) => {
                  setForm((f) => ({ ...f, phoneCountry: country, phone: national }));
                  if (errors.phone) setErrors((er) => ({ ...er, phone: undefined }));
                }}
              />
            )}
          </Field>

          <Field
            label={t("விரும்பும் தேதி", "Preferred Date")}
            hint={t("விருப்பத்தேர்வு — அலுவலகம் உறுதி செய்யும்", "Optional — the office will confirm")}
          >
            {(a11y) => (
              <input
                type="date"
                name="preferred_date"
                value={form.preferred_date}
                onChange={handleChange}
                min={todayIST()}
                {...a11y}
              />
            )}
          </Field>
        </div>

        <Field label={t("குறிப்பு", "Note (optional)")}>
          {(a11y) => (
            <textarea
              name="message"
              value={form.message}
              onChange={handleChange}
              rows={2}
              maxLength={500}
              placeholder={t("சிறப்பு கோரிக்கை எதாவது இருந்தால்…", "Any special request…")}
              {...a11y}
            />
          )}
        </Field>

        {status === "limited" && <Alert tone="warning">{rateLimitMessage(t, retryAfter)}</Alert>}
        {status === "error" && errMsg && <Alert tone="error">{errMsg}</Alert>}

        <div className="modal__actions booking-form__actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("ரத்து", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" loading={busy} icon={<LuSend aria-hidden="true" />}>
            {t("பதிவு செய்யுங்கள்", "Submit Booking")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── "How it works" — hero aside ────────────────────────────────── */
function HowItWorks({ t }) {
  const steps = [
    {
      Icon: LuCircleDot,
      title: t("சேவையைத் தேர்ந்தெடுங்கள்", "Choose a seva"),
      desc: t("கீழே உள்ள பட்டியலில் இருந்து", "From the list below"),
    },
    {
      Icon: LuSend,
      title: t("கோரிக்கையை அனுப்புங்கள்", "Submit your request"),
      desc: t("பெயர், தொலைபேசி எண், விரும்பும் தேதி", "Name, phone number and preferred date"),
    },
    {
      Icon: LuPhone,
      title: t("அலுவலகம் தொலைபேசியில் உறுதி செய்யும்", "Office confirms by phone"),
      desc: t("கோயில் அலுவலகம் உங்களை அழைத்து உறுதி செய்யும்", "The temple office will call you to confirm"),
    },
  ];
  return (
    <aside className="card card--ink card--static sevas-how rise" aria-labelledby="sevas-how-title">
      {/* <span>, not <p>: `.page-hero p` (layout.css) would out-specify
          `.eyebrow` and render this as a full-size muted paragraph. */}
      <span className="eyebrow eyebrow--on-dark">{t("3 எளிய படிகள்", "3 simple steps")}</span>
      <h2 id="sevas-how-title" className="sevas-how__title">
        {t("இது எப்படி செயல்படுகிறது", "How it works")}
      </h2>
      <ol className="sevas-how__steps" role="list">
        {steps.map(({ Icon, title, desc }, i) => (
          <li key={title} className="sevas-how__step">
            <span className="sevas-how__icon" aria-hidden="true">
              <Icon />
              <span className="sevas-how__num">{i + 1}</span>
            </span>
            <span className="sevas-how__text">
              <strong>{title}</strong>
              <small>{desc}</small>
            </span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

/* ── Page ───────────────────────────────────────────────────────── */
export default function Sevas() {
  const [sevas, setSevas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selectedSeva, setSelectedSeva] = useState(null);
  const { lang, t } = useLang();
  const [params, setParams] = useSearchParams();

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    api
      .get("/sevas")
      .then((r) => setSevas(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const closeBooking = useCallback(() => setSelectedSeva(null), []);

  /*
   * ?seva=<id> opens that offering's booking form, so a shared seva arrives
   * ready to book instead of dropping the visitor at the top of the list.
   *
   * The id is captured at the first render, before either effect below can
   * touch the URL: the list arrives from the API a moment later, and reading the
   * parameter only then would race the write that keeps the address bar in step.
   */
  const wantedSeva = useRef(params.get("seva"));
  const deepLinkDone = useRef(false);

  // Matched against the live list only. The standard fallback list has ids of
  // its own, and honouring the link against those could open a different
  // offering than the one that was sent.
  useEffect(() => {
    if (deepLinkDone.current || sevas.length === 0) return;
    deepLinkDone.current = true;
    const match = sevas.find((s) => String(s.id) === wantedSeva.current);
    if (match) setSelectedSeva(match);
  }, [sevas]);

  /*
   * The other direction, so the address bar always names the open form and can
   * be copied out of it. Skipped on the first run, where the URL is the truth.
   *
   * setParams is read through a ref because react-router hands back a new
   * function whenever the location changes — as a dependency it would re-run
   * this effect on its own writes and clear the parameter it had just set.
   */
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setParamsRef.current(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (selectedSeva) next.set("seva", String(selectedSeva.id));
        else next.delete("seva");
        return next;
      },
      { replace: true },
    );
  }, [selectedSeva]);

  // Whole card is a pointer convenience; the Book button is the accessible
  // control. Skip when the visitor is selecting text to copy a name/price.
  // Focus that card's Book button first so the dialog has a real opener to
  // return focus to on close (a click on the <li> leaves focus on <body>).
  function openFromCard(seva, e) {
    if (typeof window !== "undefined" && window.getSelection?.()?.toString()) return;
    e?.currentTarget?.querySelector?.(".seva-card__book")?.focus?.({ preventScroll: true });
    setSelectedSeva(seva);
  }

  const items = sevas.length > 0 ? sevas : FALLBACK_SEVAS;
  const callLabel = t("அழைத்து பதிவு செய்ய", "Book by phone");
  const heading = t("சேவைகள் & பூஜைகள்", "Sevas & Poojas");
  const lead = t(
    "உங்கள் பெயரில் அல்லது குடும்பத்தினர் பெயரில் ஒரு பூஜையை நடத்தி ஆசி பெறுங்கள்.",
    "Offer a pooja in your name or your family's name and receive the blessings of the Goddess.",
  );

  return (
    <>
      {/* With ?seva= in the URL the page is about that one offering, and that is
          what a preview should say. */}
      <Seo
        title={selectedSeva ? sevaName(selectedSeva, lang) : t("சேவைகள்", "Sevas")}
        description={selectedSeva ? sevaDescription(selectedSeva, lang) || lead : lead}
      />

      <PageHero
        variant="sevas"
        eyebrow={t("ஆன்லைன் பதிவு", "Online booking")}
        title={heading}
        lead={lead}
        crumbs={[{ label: t("சேவைகள்", "Sevas") }]}
        actions={<ShareButton variant="outline-light" title={heading} text={lead} to="/sevas" />}
        aside={<HowItWorks t={t} />}
      />

      <section className="section">
        <div className="container">
          <SectionHeader
            align="split"
            eyebrow={t("சேவைப் பட்டியல்", "Seva list")}
            title={t("கிடைக்கும் சேவைகள்", "Available Sevas")}
            subtitle={t(
              "விரும்பிய சேவையில் 'பதிவு செய்' அழுத்தி ஆன்லைனில் கோரிக்கை அனுப்புங்கள்",
              "Click 'Book' on any seva to submit your request online",
            )}
            actions={
              <Button
                href={telHref(SECONDARY_CONTACT.phone)}
                variant="outline"
                icon={<LuPhone aria-hidden="true" />}
                aria-label={`${callLabel} — ${formatPhone(SECONDARY_CONTACT.phone)}`}
              >
                {callLabel}
              </Button>
            }
          />

          {failed && !loading && (
            <Alert
              tone="warning"
              className="sevas-alert"
              title={t("நிலையான சேவைப் பட்டியல் காட்டப்படுகிறது", "Showing the standard seva list")}
            >
              {t(
                "நேரடி சேவைப் பட்டியலை ஏற்ற முடியவில்லை. கீழே உள்ள நிலையான பட்டியலில் இருந்து பதிவு செய்யலாம்.",
                "The live seva list couldn't be loaded. You can still book from the standard list below.",
              )}
              <div className="sevas-alert__actions">
                <Button variant="outline" size="sm" onClick={load}>
                  {t("மீண்டும் முயற்சி", "Try again")}
                </Button>
              </div>
            </Alert>
          )}

          {loading ? (
            <>
              <p className="sr-only" role="status">
                {t("சேவைகள் ஏற்றப்படுகின்றன…", "Loading sevas…")}
              </p>
              <SkeletonCards count={6} className="grid-auto sevas-grid" />
            </>
          ) : (
            <ul className="grid-auto sevas-grid" role="list">
              {items.map((s, i) => {
                const Icon = sevaIcon(s, i);
                const primaryName = sevaName(s, lang);
                const altName = lang === "ta" ? s.name_en : s.name_ta;
                const description = sevaDescription(s, lang);
                return (
                  <li
                    key={s.id}
                    className="card card--interactive seva-card rise"
                    style={{ "--i": i }}
                    onClick={(e) => openFromCard(s, e)}
                  >
                    <div className="seva-card__head">
                      <span className="card__icon" aria-hidden="true">
                        <Icon />
                      </span>
                      <div className="seva-card__names">
                        <h3 className="seva-card__name">{primaryName}</h3>
                        {altName && altName !== primaryName && (
                          <p className="seva-card__alt" lang={lang === "ta" ? "en" : "ta"}>
                            {altName}
                          </p>
                        )}
                      </div>
                    </div>

                    {description ? <p className="seva-card__desc">{description}</p> : null}

                    <div className="seva-card__foot">
                      <p className="seva-card__price">
                        <span className="seva-card__amount text-gradient">₹{s.amount}</span>
                        <span className="seva-card__unit">{t("சமர்ப்பணம்", "offering")}</span>
                      </p>
                      <Button
                        type="button"
                        variant="primary"
                        className="seva-card__book"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedSeva(s);
                        }}
                        aria-label={`${t("பதிவு செய்", "Book")} — ${primaryName}`}
                      >
                        {t("பதிவு செய் →", "Book →")}
                      </Button>
                      {/* Icon-only: the price and the Book button own this row.
                          ?seva= reopens this offering's form for whoever
                          receives the link. */}
                      <ShareButton
                        iconOnly
                        variant="ghost"
                        className="seva-card__share"
                        title={primaryName}
                        text={description || lead}
                        to={`/sevas?seva=${s.id}`}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="callout sevas-note rise" style={{ "--i": loading ? 0 : items.length }}>
            <LuPhone aria-hidden="true" />
            <p>
              {t(
                `சேவை பதிவு செய்ய ${SECONDARY_CONTACT.role.ta} ${SECONDARY_CONTACT.name.ta} – ${formatPhone(SECONDARY_CONTACT.phone)} என்ற எண்ணில் அழைக்கவும் அல்லது காலை 8 – 12 மணி, மாலை 4 – 8 மணி நேரத்தில் கோயில் அலுவலகத்தை நேரில் அணுகவும்.`,
                `To book a seva, call ${SECONDARY_CONTACT.role.en} ${SECONDARY_CONTACT.name.en} at ${formatPhone(SECONDARY_CONTACT.phone)} or visit the temple office between 8 AM – 12 PM and 4 PM – 8 PM.`,
              )}
            </p>
          </div>
        </div>
      </section>

      {selectedSeva && (
        <BookingModal
          seva={selectedSeva}
          onClose={closeBooking}
          t={t}
          lang={lang}
        />
      )}
    </>
  );
}
