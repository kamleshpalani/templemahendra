import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { LuArrowLeft, LuArrowRight, LuCircleCheck, LuHouse, LuSend, LuSparkles, LuUserPlus } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import RegistrationStepper from "../components/Registration/RegistrationStepper";
import ErrorSummary from "../components/Registration/ErrorSummary";
import PersonalStep from "../components/Registration/PersonalStep";
import FamilyStep from "../components/Registration/FamilyStep";
import AddressStep from "../components/Registration/AddressStep";
import ReviewStep from "../components/Registration/ReviewStep";
import { useLang, rateLimitInfo } from "../context/LangContext";
import {
  FORM_STEPS,
  LIMITS,
  STEPS,
  STEP_KEYS,
  emptyMember,
  fieldIdFor,
  fieldLabel,
  initialForm,
  isBlankMember,
  mapServerFields,
  payloadMemberKeys,
  stepOfField,
  toPayload,
  validateAll,
  validateStep,
} from "../lib/familyRegistration";
import "./Register.css";

/*
 * The draft lives in sessionStorage: it survives an accidental reload but not
 * closing the tab, so a family's details never outlive the visit on a shared
 * phone. Storage throws in a private window or where site data is blocked; the
 * form then simply is not kept across a reload.
 */
const DRAFT_KEY = "temple:registration-draft";
const NO_ERRORS = { personal: {}, family: {}, address: {} };

function readDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null");
    return saved && typeof saved === "object" && saved.form && typeof saved.form === "object" ? saved : null;
  } catch {
    return null;
  }
}

function writeDraft(value) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(value));
  } catch {
    /* not kept across a reload; the form still works */
  }
}

function clearDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing was kept */
  }
}

/** A saved draft laid over a fresh form, keeping only values of the right type. */
function restoreForm(saved, lang) {
  const form = initialForm(lang);
  for (const key of Object.keys(form)) {
    if (key !== "members" && key !== "hp_token" && typeof saved[key] === typeof form[key]) form[key] = saved[key];
  }
  if (Array.isArray(saved.members)) {
    form.members = saved.members
      .filter((m) => m && Number.isInteger(m.key) && m.key > 0)
      .slice(0, LIMITS.maxMembers)
      .map((m) => ({ key: m.key, name: String(m.name ?? ""), relationship: String(m.relationship ?? ""), age: String(m.age ?? "") }));
  }
  return form;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export default function Register() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();

  const [draft] = useState(readDraft);
  const [form, setForm] = useState(() => (draft ? restoreForm(draft.form, lang) : initialForm(lang)));
  // The furthest step the family has reached with Next. Later steps stay locked
  // until then, even when their fields happen to be valid already.
  const [furthest, setFurthest] = useState(() => {
    const n = Number(draft?.furthest);
    return Number.isInteger(n) ? Math.min(Math.max(n, 0), STEPS.length - 1) : 0;
  });
  const [errors, setErrors] = useState(NO_ERRORS);
  const [returnToReview, setReturnToReview] = useState(false);
  const [status, setStatus] = useState(null); // null | sending | limited | error | unavailable | network
  const [retryAfter, setRetryAfter] = useState(null);
  const [done, setDone] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const [direction, setDirection] = useState("forward");
  const [summaryTick, setSummaryTick] = useState(0);

  const nextMemberKey = useRef(form.members.reduce((max, m) => Math.max(max, m.key), 0) + 1);
  const headingRef = useRef(null);
  const summaryRef = useRef(null);
  const stepperRef = useRef(null);
  const doneRef = useRef(null);
  const pendingFocus = useRef(null);

  const requested = params.get("step");
  const stepKey = STEP_KEYS.includes(requested) ? requested : "personal";
  const stepIndex = STEP_KEYS.indexOf(stepKey);
  const shownStep = useRef(stepKey);

  // Which form steps pass right now. An edit on one step can close the steps
  // after it, so this follows every change.
  const validSteps = useMemo(
    () => FORM_STEPS.map((key) => Object.keys(validateStep(key, form, (ta, en) => en)).length === 0),
    [form],
  );
  const isReachable = useCallback(
    (i) => i === 0 || (i <= furthest && validSteps.slice(0, i).every(Boolean)),
    [furthest, validSteps],
  );
  const isDone = useCallback((i) => i < FORM_STEPS.length && i < furthest && validSteps[i], [furthest, validSteps]);

  const announce = useCallback((text) => {
    // Cleared first and set on the next frame, so the same words twice are read twice.
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const goTo = useCallback(
    (key, { replace = false } = {}) => {
      setDirection(STEP_KEYS.indexOf(key) >= stepIndex ? "forward" : "back");
      setParams({ step: key }, { replace });
    },
    [setParams, stepIndex],
  );

  // A step whose earlier steps are unfinished is never shown: a bookmarked or
  // shared ?step=review, or the browser's forward button past an edit that broke
  // an earlier step, lands on the furthest step that can be opened.
  useEffect(() => {
    if (done) return;
    if (requested !== null && !STEP_KEYS.includes(requested)) {
      setParams({}, { replace: true });
      return;
    }
    if (!isReachable(stepIndex)) {
      let allowed = stepIndex;
      while (allowed > 0 && !isReachable(allowed)) allowed -= 1;
      setParams(allowed === 0 ? {} : { step: STEP_KEYS[allowed] }, { replace: true });
    }
  }, [done, requested, stepIndex, isReachable, setParams]);

  // On every step change — Next, Back, the stepper, or the browser's own Back —
  // move focus to the new heading and say where the family now is. Not on first
  // load: arriving at the page should not jump focus past the header.
  useEffect(() => {
    if (shownStep.current === stepKey || done) return;
    shownStep.current = stepKey;
    const step = STEPS[stepIndex];
    announce(
      t(
        `படி ${stepIndex + 1} / ${STEPS.length}: ${step.heading[0]}`,
        `Step ${stepIndex + 1} of ${STEPS.length}: ${step.heading[1]}`,
      ),
    );
    headingRef.current?.focus({ preventScroll: true });
    stepperRef.current?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    if (stepKey === "review") setReturnToReview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs for step changes only
  }, [stepKey, done]);

  // A failed Next or Submit puts focus on the summary of what to fix. Declared
  // after the effect above so, when both run together, the summary wins.
  useEffect(() => {
    if (!summaryTick || !summaryRef.current) return;
    summaryRef.current.focus({ preventScroll: true });
    summaryRef.current.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [summaryTick]);

  // After adding or removing a member, focus goes where the family will want it.
  useEffect(() => {
    if (!pendingFocus.current) return;
    const id = pendingFocus.current;
    pendingFocus.current = null;
    document.getElementById(id)?.focus();
  });

  useEffect(() => {
    if (!done) return;
    doneRef.current?.focus({ preventScroll: true });
    doneRef.current?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [done]);

  useEffect(() => {
    if (!done) writeDraft({ v: 1, furthest, form: { ...form, hp_token: "" } });
  }, [done, form, furthest]);

  /* ── Editing ─────────────────────────────────────────────────────────── */

  const dropError = useCallback((step, key) => {
    setErrors((prev) => {
      if (!step || !prev[step] || !(key in prev[step])) return prev;
      const rest = { ...prev[step] };
      delete rest[key];
      return { ...prev, [step]: rest };
    });
  }, []);

  const setField = useCallback(
    (name, value) => {
      setForm((f) => ({ ...f, [name]: value }));
      dropError(stepOfField(name), name);
    },
    [dropError],
  );

  const onPhoneChange = useCallback(
    ({ country, national }) => {
      setForm((f) => ({ ...f, phoneCountry: country, phone: national }));
      dropError("personal", "phone");
    },
    [dropError],
  );

  const onCountryChange = useCallback(
    (iso2) => {
      setForm((f) => ({
        ...f,
        country: iso2,
        // The old state belongs to the old country's list.
        state: "",
        // Until a number is typed, the phone's country follows where they live.
        phoneCountry: f.phone ? f.phoneCountry : iso2,
      }));
      ["country", "state", "postcode"].forEach((key) => dropError("address", key));
    },
    [dropError],
  );

  const addMember = () => {
    if (form.members.length >= LIMITS.maxMembers) return;
    const key = nextMemberKey.current++;
    const n = form.members.length + 1;
    setForm((f) => ({ ...f, members: [...f.members, emptyMember(key)] }));
    dropError("family", "members");
    pendingFocus.current = `reg-member-${key}-name`;
    announce(t(`உறுப்பினர் ${n} சேர்க்கப்பட்டார்.`, `Member ${n} added.`));
  };

  const removeMember = (key) => {
    const index = form.members.findIndex((m) => m.key === key);
    if (index < 0) return;
    const removed = form.members[index];
    const rest = form.members.filter((m) => m.key !== key);
    const who = removed.name.trim() || t(`உறுப்பினர் ${index + 1}`, `Member ${index + 1}`);
    setForm((f) => ({ ...f, members: f.members.filter((m) => m.key !== key) }));
    setErrors((prev) => ({
      ...prev,
      family: Object.fromEntries(Object.entries(prev.family).filter(([k]) => !k.startsWith(`members.${key}.`))),
    }));
    const neighbour = rest[index] ?? rest[index - 1];
    pendingFocus.current = neighbour ? `reg-member-${neighbour.key}-name` : "reg-add-member";
    if (rest.length === 0) {
      announce(t(`${who} நீக்கப்பட்டார். உறுப்பினர்கள் யாரும் இல்லை.`, `${who} removed. No members left.`));
    } else {
      announce(
        rest.length === 1
          ? t(`${who} நீக்கப்பட்டார். இப்போது 1 உறுப்பினர் உள்ளார்.`, `${who} removed. 1 member left.`)
          : t(`${who} நீக்கப்பட்டார். இப்போது ${rest.length} உறுப்பினர்கள் உள்ளனர்.`, `${who} removed. ${rest.length} members left.`),
      );
    }
  };

  const changeMember = (key, field, value) => {
    setForm((f) => ({ ...f, members: f.members.map((m) => (m.key === key ? { ...m, [field]: value } : m)) }));
    dropError("family", `members.${key}.${field}`);
  };

  /* ── Moving between steps ────────────────────────────────────────────── */

  const next = () => {
    let current = form;
    if (stepKey === "family") {
      // A card added and left empty is dropped rather than refused.
      const kept = form.members.filter((m) => !isBlankMember(m));
      if (kept.length !== form.members.length) {
        current = { ...form, members: kept };
        setForm(current);
      }
    }
    const stepErrors = validateStep(stepKey, current, t);
    if (Object.keys(stepErrors).length) {
      setErrors((prev) => ({ ...prev, [stepKey]: stepErrors }));
      setSummaryTick((n) => n + 1);
      return;
    }
    setErrors((prev) => ({ ...prev, [stepKey]: {} }));
    const target = returnToReview ? "review" : STEP_KEYS[stepIndex + 1];
    setFurthest((f) => Math.max(f, STEP_KEYS.indexOf(target)));
    goTo(target);
  };

  const back = () => {
    if (stepIndex > 0) goTo(STEP_KEYS[stepIndex - 1]);
  };

  const editFromReview = (key) => {
    setReturnToReview(true);
    goTo(key);
  };

  const submit = async () => {
    const all = validateAll(form, t);
    const firstBad = FORM_STEPS.find((key) => Object.keys(all[key]).length);
    if (firstBad) {
      setErrors(all);
      goTo(firstBad);
      setSummaryTick((n) => n + 1);
      return;
    }

    setStatus("sending");
    const payload = toPayload(form);
    const memberKeys = payloadMemberKeys(form);
    try {
      const res = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);

      if (res.ok && body?.success) {
        clearDraft();
        setStatus(null);
        setDone({ name: payload.name, members: payload.members.length, consent: payload.consent });
        return;
      }
      const limited = rateLimitInfo(res.status, body, res.headers.get("Retry-After"));
      if (limited) {
        setRetryAfter(limited.retryAfter);
        setStatus("limited");
        return;
      }
      if (res.status === 422 && body?.fields) {
        const mapped = mapServerFields(body.fields, memberKeys, form, t, lang);
        const bad = FORM_STEPS.find((key) => Object.keys(mapped[key]).length);
        if (bad) {
          setStatus(null);
          setErrors(mapped);
          goTo(bad);
          setSummaryTick((n) => n + 1);
          return;
        }
      }
      setStatus(res.status === 503 ? "unavailable" : "error");
    } catch {
      setStatus("network");
    }
  };

  const primary = () => {
    if (status === "sending") return;
    if (stepKey === "review") submit();
    else next();
  };

  const registerAnother = () => {
    clearDraft();
    nextMemberKey.current = 1;
    setForm(initialForm(lang));
    setFurthest(0);
    setErrors(NO_ERRORS);
    setReturnToReview(false);
    setStatus(null);
    setRetryAfter(null);
    setDirection("forward");
    setDone(null);
    setParams({ step: "personal" });
  };

  /* ── Rendering ───────────────────────────────────────────────────────── */

  const heroTitle = t("உங்கள் குடும்பத்தைப் பதிவு செய்யுங்கள்", "Register your family");
  const lead = t(
    "கோயில் உங்கள் குடும்பத்தை அறிந்து கொள்ள, ஒரு முறை மட்டும் இந்தப் படிவத்தை நிரப்புங்கள். கணக்கோ கடவுச்சொல்லோ தேவையில்லை.",
    "Fill this in once so the temple knows your family. No account or password is needed.",
  );
  const hero = (
    <>
      <Seo title={t("குடும்பப் பதிவு", "Family registration")} description={lead} />
      <PageHero
        eyebrow={t("ஒரு முறை பதிவு", "One-time registration")}
        title={heroTitle}
        lead={lead}
        crumbs={[{ label: t("குடும்பப் பதிவு", "Family registration") }]}
      />
    </>
  );

  if (done) {
    return (
      <>
        {hero}
        <section className="section reg-section">
          <div className="container container--narrow reg">
            <div className="card card--solid card--static reg-done">
              <span className="reg-done__icon" aria-hidden="true">
                <LuCircleCheck />
              </span>
              <h2 ref={doneRef} tabIndex={-1} className="reg-done__title">
                {t("நன்றி! உங்கள் குடும்பம் பதிவு செய்யப்பட்டது", "Thank you — your family is registered")}
              </h2>
              <p className="reg-done__lead">
                {done.members === 0
                  ? t(`${done.name} கோயில் பதிவேட்டில் சேர்க்கப்பட்டார்.`, `${done.name} has been added to the temple register.`)
                  : t(
                      `${done.name} மற்றும் ${done.members === 1 ? "ஒரு குடும்ப உறுப்பினர்" : `${done.members} குடும்ப உறுப்பினர்கள்`} கோயில் பதிவேட்டில் சேர்க்கப்பட்டனர்.`,
                      `${done.name} and ${done.members} family ${done.members === 1 ? "member have" : "members have"} been added to the temple register.`,
                    )}
              </p>
              {done.consent && (
                <p className="reg-done__note">
                  {t("கோயில் செய்திகளை உங்களுக்கு அனுப்புவோம்.", "We will send you temple updates.")}
                </p>
              )}
              <p className="reg-done__note">
                {t("இந்த விவரங்களை பின்னர் மாற்ற, ", "To change these details later, ")}
                <Link to="/contact">{t("கோயில் அலுவலகத்தைத் தொடர்பு கொள்ளுங்கள்", "contact the temple office")}</Link>.
              </p>
              <div className="reg-done__actions">
                <Button to="/" variant="outline" icon={<LuHouse aria-hidden="true" />}>
                  {t("முகப்பு", "Home")}
                </Button>
                <Button to="/sevas" variant="gold" icon={<LuSparkles aria-hidden="true" />}>
                  {t("சேவை பதிவு", "Book a seva")}
                </Button>
                <Button variant="primary" icon={<LuUserPlus aria-hidden="true" />} onClick={registerAnother}>
                  {t("மற்றொரு குடும்பத்தைப் பதிவு செய்", "Register another family")}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  const step = STEPS[stepIndex];
  const filledMembers = form.members.filter((m) => !isBlankMember(m)).length;
  const sending = status === "sending";

  let primaryLabel = t("அடுத்து", "Next");
  if (stepKey === "review") primaryLabel = t("பதிவைச் சமர்ப்பி", "Submit registration");
  else if (returnToReview) primaryLabel = t("சேமித்துச் சரிபார்ப்புக்குத் திரும்பு", "Save and return to review");
  else if (stepKey === "family" && filledMembers === 0) primaryLabel = t("இப்போதைக்குத் தவிர்", "Skip for now");

  const description = {
    personal: t("உங்களைப் பற்றிய சில விவரங்கள். * குறியிட்டவை கட்டாயம்.", "A few details about you. Fields marked * are required."),
    family: t(
      "உங்கள் குடும்ப உறுப்பினர்களைச் சேர்க்கவும். இந்தப் படியைத் தவிர்க்கலாம்.",
      "Add the members of your family. You can skip this step.",
    ),
    address: t("கோயில் கடிதங்களும் ரசீதுகளும் அனுப்ப வேண்டிய வீட்டு முகவரி.", "Where the temple can post letters and receipts."),
    review: t(
      "சமர்ப்பிக்கும் முன் எல்லாவற்றையும் சரிபார்க்கவும். எந்தப் பகுதியையும் திருத்தலாம்.",
      "Check everything before you submit. You can edit any section.",
    ),
  }[stepKey];

  const summaryEntries = Object.entries(errors[stepKey] ?? {}).map(([key, message]) => ({
    key,
    message,
    id: fieldIdFor(key),
    label: fieldLabel(key, form, t),
  }));

  // One set of controls, shown inline in the card on wide screens and docked
  // above the bottom navigation on phones. The dock is portalled to <body>
  // because the page transition leaves a transform on its wrapper, and a
  // transformed ancestor would pin a fixed bar to the page instead of the screen.
  const actions = (where) => (
    <div className={`reg-actions reg-actions--${where}`}>
      {stepIndex > 0 && (
        <Button variant="outline" className="reg-actions__back" icon={<LuArrowLeft aria-hidden="true" />} onClick={back}>
          {t("பின்செல்", "Back")}
        </Button>
      )}
      <Button
        type={where === "inline" ? "submit" : "button"}
        onClick={where === "dock" ? primary : undefined}
        variant="primary"
        className="reg-actions__next"
        loading={sending}
        icon={stepKey === "review" ? <LuSend aria-hidden="true" /> : null}
        trailingIcon={stepKey === "review" ? null : <LuArrowRight aria-hidden="true" />}
      >
        {primaryLabel}
      </Button>
    </div>
  );

  return (
    <>
      {hero}
      <section className="section reg-section">
        <div className="container container--narrow reg">
          <div ref={stepperRef} className="reg__stepper">
            <RegistrationStepper
              currentIndex={stepIndex}
              isDone={isDone}
              isReachable={isReachable}
              onJump={(key) => goTo(key)}
              t={t}
            />
          </div>

          <form
            className="reg-form"
            noValidate
            aria-labelledby="reg-step-title"
            onSubmit={(e) => {
              e.preventDefault();
              primary();
            }}
          >
            <div key={stepKey} className="card card--solid card--static reg-card" data-direction={direction}>
              <header className="reg-card__head">
                <span className="reg-card__eyebrow">
                  {t(`படி ${stepIndex + 1} / ${STEPS.length}`, `Step ${stepIndex + 1} of ${STEPS.length}`)}
                </span>
                <h2 id="reg-step-title" ref={headingRef} tabIndex={-1} className="reg-card__title">
                  {t(...step.heading)}
                </h2>
                <p className="reg-card__desc">{description}</p>
              </header>

              <ErrorSummary ref={summaryRef} entries={summaryEntries} t={t} />

              <div className="reg-card__body">
                {stepKey === "personal" && (
                  <PersonalStep form={form} errors={errors.personal} setField={setField} onPhoneChange={onPhoneChange} t={t} />
                )}
                {stepKey === "family" && (
                  <FamilyStep
                    members={form.members}
                    errors={errors.family}
                    onAdd={addMember}
                    onRemove={removeMember}
                    onMemberChange={changeMember}
                    t={t}
                  />
                )}
                {stepKey === "address" && (
                  <AddressStep
                    form={form}
                    errors={errors.address}
                    setField={setField}
                    onCountryChange={onCountryChange}
                    t={t}
                  />
                )}
                {stepKey === "review" && (
                  <ReviewStep
                    form={form}
                    onEdit={editFromReview}
                    setField={setField}
                    status={status}
                    retryAfter={retryAfter}
                    t={t}
                    lang={lang}
                  />
                )}
              </div>

              {/* Honeypot. People never see it and cannot Tab to it; form-filling
                  bots do fill it, and the server then quietly saves nothing. */}
              <div className="visually-hidden" aria-hidden="true">
                <label htmlFor="reg-hp-token">{t("இந்தப் புலத்தை காலியாக விடவும்", "Leave this field empty")}</label>
                <input
                  id="reg-hp-token"
                  type="text"
                  name="hp_token"
                  value={form.hp_token}
                  onChange={(e) => setForm((f) => ({ ...f, hp_token: e.target.value }))}
                  tabIndex={-1}
                  autoComplete="off"
                />
              </div>

              {actions("inline")}
            </div>
          </form>

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </section>
      {createPortal(actions("dock"), document.body)}
    </>
  );
}
