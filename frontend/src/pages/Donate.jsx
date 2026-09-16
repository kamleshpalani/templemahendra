import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import {
  LuArrowLeft,
  LuArrowRight,
  LuBadgeCheck,
  LuHeartHandshake,
  LuLandmark,
  LuLock,
  LuPencil,
  LuShieldCheck,
  LuUser,
} from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { Field, IconInput } from "../components/ui/Field";
import PhoneInput from "../components/ui/PhoneInput";
import CountrySelect from "../components/ui/CountrySelect";
import StateSelect from "../components/ui/StateSelect";
import FormStepper from "../components/ui/FormStepper";
import FormErrorSummary from "../components/ui/FormErrorSummary";
import { SkeletonText } from "../components/ui/Feedback";
import PaymentRedirect from "../components/Payments/PaymentRedirect";
import SimulatorBanner from "../components/Payments/SimulatorBanner";
import { useLang, rateLimitInfo, rateLimitMessage } from "../context/LangContext";
import { TRUST } from "../data/temple";
import { countryName } from "../lib/familyRegistration";
import { formatInternational, subdivisionLabel, subdivisionsOf } from "../lib/phone";
import { currencySymbol, formatMoney, parseAmountInput } from "../lib/money";
import { paymentsUsable, postJson, usePaymentsConfig, writeLastPayment } from "../lib/payments";
import {
  DONATE_FORM_STEPS,
  DONATE_STEPS,
  DONATE_STEP_KEYS,
  DONATION_DRAFT_KEY,
  DONATION_LIMITS,
  fieldIdFor,
  fieldLabel,
  initialDonationForm,
  mapServerFields,
  stepOfDonationField,
  toDonationPayload,
  validateDonationAll,
  validateDonationStep,
} from "../lib/donation";
import "../components/Payments/Payments.css";
import "./Donate.css";

/**
 * /donate — giving online, in three steps (docs/payments/SPEC.md §7.3).
 *
 * The same engine as the family registration form: the step lives in the URL so
 * the phone's Back button works, a step is only reachable once the ones before
 * it pass, focus and a live region announce each move, and everything typed is
 * kept in sessionStorage in case the page is reloaded. The draft is deliberately
 * kept after the hand-off to CCAvenue: a donor who cancels and comes back
 * should not have to type it all again. It is cleared by the result page once a
 * payment has actually succeeded.
 *
 * No amount decided here is trusted. The server validates it again, stores it,
 * and it is the stored amount that is encrypted into the CCAvenue request.
 */

/* The policy routes are repeated rather than imported: data/policies.js carries
   the full bilingual text of all four pages, and pulling that into this page's
   chunk to read two paths would make the donation form slower to open. The
   footer repeats them for the same reason. */
const TERMS_PATH = "/terms-and-conditions";
const REFUNDS_PATH = "/refund-cancellation-policy";

const NO_ERRORS = { purpose: {}, details: {}, review: {} };

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function readDraft() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(DONATION_DRAFT_KEY) ?? "null");
    return saved && typeof saved === "object" && saved.form && typeof saved.form === "object" ? saved : null;
  } catch {
    return null;
  }
}

function writeDraft(value) {
  try {
    sessionStorage.setItem(DONATION_DRAFT_KEY, JSON.stringify(value));
  } catch {
    /* not kept across a reload; the form still works */
  }
}

/** A saved draft laid over a fresh form, keeping only values of the right type. */
function restoreForm(saved, lang, config) {
  const form = initialDonationForm(lang, config);
  for (const key of Object.keys(form)) {
    // The PAN and the honeypot are never restored: a tax number should not
    // outlive the page it was typed on (it is not written to the draft either).
    if (key === "pan" || key === "hp_token") continue;
    if (typeof saved[key] === typeof form[key]) form[key] = saved[key];
  }
  return form;
}

/** One review card with its heading and an Edit button that opens its step. */
function ReviewSection({ id, icon, title, editName, onEdit, t, children }) {
  return (
    <section className="don-review" aria-labelledby={id}>
      <div className="don-review__head">
        <h3 id={id} className="don-review__title">
          <span className="don-review__icon" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h3>
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
    <div className="don-review__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function Donate() {
  const { lang, t } = useLang();
  const { config, loading } = usePaymentsConfig();
  const [params, setParams] = useSearchParams();

  const [draft] = useState(readDraft);
  const [form, setForm] = useState(() => (draft ? restoreForm(draft.form, lang, null) : initialDonationForm(lang, null)));
  const [furthest, setFurthest] = useState(() => {
    const n = Number(draft?.furthest);
    return Number.isInteger(n) ? Math.min(Math.max(n, 0), DONATE_STEPS.length - 1) : 0;
  });
  const [errors, setErrors] = useState(NO_ERRORS);
  const [returnToReview, setReturnToReview] = useState(false);
  const [status, setStatus] = useState(null); // null | sending | limited | error | unavailable | network
  const [retryAfter, setRetryAfter] = useState(null);
  const [gateway, setGateway] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const [direction, setDirection] = useState("forward");
  const [summaryTick, setSummaryTick] = useState(0);

  const headingRef = useRef(null);
  const summaryRef = useRef(null);
  const stepperRef = useRef(null);
  // Set before React re-renders, so a second press while the first POST is in
  // flight is ignored even though `status` has not been applied yet.
  const sending = useRef(false);
  const configApplied = useRef(false);

  const requested = params.get("step");
  const stepKey = DONATE_STEP_KEYS.includes(requested) ? requested : "purpose";
  const stepIndex = DONATE_STEP_KEYS.indexOf(stepKey);
  const shownStep = useRef(stepKey);

  const usable = paymentsUsable(config);
  const currency = String(form.currency || config.defaultCurrency || "INR").toUpperCase();
  const category = config.categories.find((c) => c.slug === form.category) ?? null;
  const amountValue = parseAmountInput(form.amount);
  const showCurrency = config.international && config.currencies.length > 1;
  const showPresets = currency === "INR" && config.presets.length > 0;

  // The default currency is only known once the server has answered, so a form
  // built before that gets it applied here — without touching a donor's choice.
  useEffect(() => {
    if (loading || configApplied.current) return;
    configApplied.current = true;
    const codes = config.currencies.map((c) => c.code);
    setForm((f) => (codes.includes(f.currency) ? f : { ...f, currency: config.defaultCurrency || "INR" }));
  }, [loading, config]);

  const validSteps = useMemo(
    () => DONATE_FORM_STEPS.map((key) => Object.keys(validateDonationStep(key, form, (ta, en) => en, config)).length === 0),
    [form, config],
  );
  const isReachable = useCallback(
    (i) => i === 0 || (i <= furthest && validSteps.slice(0, i).every(Boolean)),
    [furthest, validSteps],
  );
  const isDone = useCallback(
    (i) => i < DONATE_FORM_STEPS.length && i < furthest && validSteps[i],
    [furthest, validSteps],
  );

  const announce = useCallback((text) => {
    setAnnouncement("");
    requestAnimationFrame(() => setAnnouncement(text));
  }, []);

  const goTo = useCallback(
    (key, { replace = false } = {}) => {
      setDirection(DONATE_STEP_KEYS.indexOf(key) >= stepIndex ? "forward" : "back");
      setParams({ step: key }, { replace });
    },
    [setParams, stepIndex],
  );

  // A step whose earlier steps are unfinished is never shown: a shared
  // ?step=review, or the browser's forward button past an edit that broke an
  // earlier step, lands on the furthest step that can be opened. Not before the
  // configuration has arrived, though: until then no purpose is known, so every
  // step would look unreachable and a reload on the review step would be
  // thrown back to the start.
  useEffect(() => {
    if (gateway || loading) return;
    if (requested !== null && !DONATE_STEP_KEYS.includes(requested)) {
      setParams({}, { replace: true });
      return;
    }
    if (!isReachable(stepIndex)) {
      let allowed = stepIndex;
      while (allowed > 0 && !isReachable(allowed)) allowed -= 1;
      setParams(allowed === 0 ? {} : { step: DONATE_STEP_KEYS[allowed] }, { replace: true });
    }
  }, [gateway, loading, requested, stepIndex, isReachable, setParams]);

  useEffect(() => {
    if (shownStep.current === stepKey || gateway) return;
    shownStep.current = stepKey;
    const step = DONATE_STEPS[stepIndex];
    announce(
      t(
        `படி ${stepIndex + 1} / ${DONATE_STEPS.length}: ${step.heading[0]}`,
        `Step ${stepIndex + 1} of ${DONATE_STEPS.length}: ${step.heading[1]}`,
      ),
    );
    headingRef.current?.focus({ preventScroll: true });
    stepperRef.current?.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    if (stepKey === "review") setReturnToReview(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs for step changes only
  }, [stepKey, gateway]);

  // Declared after the effect above so, when both run together, the summary wins.
  useEffect(() => {
    if (!summaryTick || !summaryRef.current) return;
    summaryRef.current.focus({ preventScroll: true });
    summaryRef.current.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [summaryTick]);

  useEffect(() => {
    writeDraft({ v: 1, furthest, form: { ...form, pan: "", hp_token: "" } });
  }, [form, furthest]);

  /*
   * Coming back from CCAvenue with the browser's Back button restores this page
   * from the back-forward cache exactly as it was left — showing "Redirecting
   * securely…" forever. `pageshow` with persisted=true is the only signal that
   * this happened, so the form is put back the way it was.
   */
  useEffect(() => {
    const onShow = (event) => {
      if (!event.persisted) return;
      sending.current = false;
      setGateway(null);
      setStatus(null);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

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
      dropError(stepOfDonationField(name), name);
    },
    [dropError],
  );

  /**
   * Picking a purpose fills its suggested amount, unless the donor set one. An
   * amount error is cleared only when a suggestion actually filled the field:
   * otherwise a wrong amount would look accepted until the next press of Next.
   */
  const chooseCategory = (slug) => {
    const picked = config.categories.find((c) => c.slug === slug);
    const untouched = form.amount === "" || form.amountChoice === "suggested";
    const fills = picked?.suggestedAmount != null && untouched && currency === "INR";
    setForm((f) => ({
      ...f,
      category: slug,
      ...(fills ? { amount: String(picked.suggestedAmount), amountChoice: "suggested" } : {}),
    }));
    dropError("purpose", "category");
    if (fills) dropError("purpose", "amount");
  };

  const choosePreset = (value) => {
    setForm((f) => ({ ...f, amountChoice: String(value), amount: String(value) }));
    dropError("purpose", "amount");
  };

  const typeAmount = (value) => {
    setForm((f) => ({ ...f, amount: value, amountChoice: "other" }));
    dropError("purpose", "amount");
  };

  const changeCurrency = (code) => {
    setForm((f) => ({
      ...f,
      currency: code,
      // The preset chips are rupee amounts; they mean nothing in another currency.
      amountChoice: code === "INR" ? f.amountChoice : "other",
    }));
    dropError("purpose", "currency");
    dropError("purpose", "amount");
  };

  const onCountryChange = (iso2) => {
    setForm((f) => ({
      ...f,
      country: iso2,
      state: "",
      // Until a number is typed, the phone's country follows where they live.
      phoneCountry: f.phone ? f.phoneCountry : iso2,
    }));
    ["country", "state", "postcode"].forEach((key) => dropError("details", key));
  };

  /* ── Moving between steps ────────────────────────────────────────────── */

  const next = () => {
    const stepErrors = validateDonationStep(stepKey, form, t, config);
    if (Object.keys(stepErrors).length) {
      setErrors((prev) => ({ ...prev, [stepKey]: stepErrors }));
      setSummaryTick((n) => n + 1);
      return;
    }
    setErrors((prev) => ({ ...prev, [stepKey]: {} }));
    const target = returnToReview ? "review" : DONATE_STEP_KEYS[stepIndex + 1];
    setFurthest((f) => Math.max(f, DONATE_STEP_KEYS.indexOf(target)));
    goTo(target);
  };

  const back = () => {
    if (stepIndex > 0) goTo(DONATE_STEP_KEYS[stepIndex - 1]);
  };

  const editFromReview = (key) => {
    setReturnToReview(true);
    goTo(key);
  };

  const submit = async () => {
    if (sending.current) return;
    const all = validateDonationAll(form, t, config);
    const firstBad = DONATE_STEP_KEYS.find((key) => Object.keys(all[key]).length);
    if (firstBad) {
      setErrors(all);
      if (firstBad !== stepKey) goTo(firstBad);
      setSummaryTick((n) => n + 1);
      return;
    }

    sending.current = true;
    setStatus("sending");
    const res = await postJson("/api/payments/donations", toDonationPayload(form));

    if (res.ok && res.body?.success && res.body.gateway) {
      writeLastPayment({ number: res.body.number, token: res.body.token, kind: "donation" });
      // The draft stays: a cancelled payment must not cost the donor the form.
      setGateway(res.body.gateway);
      return;
    }
    sending.current = false;

    const limited = rateLimitInfo(res.status, res.body, res.retryAfterHeader);
    if (limited) {
      setRetryAfter(limited.retryAfter);
      setStatus("limited");
      return;
    }
    if (res.status === 422 && res.body?.fields) {
      const mapped = mapServerFields(res.body.fields, form, t, lang, config);
      const bad = DONATE_STEP_KEYS.find((key) => Object.keys(mapped[key]).length);
      if (bad) {
        setStatus(null);
        setErrors(mapped);
        if (bad !== stepKey) goTo(bad);
        setSummaryTick((n) => n + 1);
        return;
      }
    }
    if (res.status === 0) setStatus("network");
    else setStatus(res.status === 503 ? "unavailable" : "error");
  };

  const primary = () => {
    if (sending.current) return;
    if (stepKey === "review") submit();
    else next();
  };

  /* ── Rendering ───────────────────────────────────────────────────────── */

  const heroLead = t(
    "UPI, கார்டு அல்லது நெட் பேங்கிங் மூலம் CCAvenue பாதுகாப்பான பக்கத்தில் திருக்கோவில் தர்ம அறக்கட்டளைக்கு நன்கொடை வழங்கி, மின்னணு ரசீது பெறுங்கள்.",
    "Give to the Temple Dharma Trust by UPI, card or net banking on CCAvenue's secure page, and receive an electronic receipt.",
  );
  const hero = (
    <>
      <Seo title={t("இணையவழி நன்கொடை", "Donate online")} description={heroLead} />
      <PageHero
        variant="donations"
        eyebrow={t(TRUST.taxExemption.short.ta, TRUST.taxExemption.short.en)}
        title={t("இணையவழி நன்கொடை", "Donate online")}
        lead={heroLead}
        crumbs={[
          { label: t("நன்கொடை", "Donations"), to: "/donations" },
          { label: t("இணையவழி நன்கொடை", "Donate online") },
        ]}
      />
    </>
  );

  const amountLabel = amountValue !== null ? formatMoney(amountValue, currency, lang) : "";
  const purposeLabel = category ? t(category.name.ta, category.name.en) : "";

  if (gateway) {
    return (
      <>
        {hero}
        <section className="section don-section">
          <div className="container container--narrow">
            <PaymentRedirect gateway={gateway} amountLabel={amountLabel} purposeLabel={purposeLabel} />
          </div>
        </section>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {hero}
        <section className="section don-section">
          <div className="container container--narrow">
            <div className="card card--solid card--static don-card">
              <p className="sr-only" role="status">
                {t("ஏற்றுகிறது…", "Loading…")}
              </p>
              <SkeletonText lines={5} />
            </div>
          </div>
        </section>
      </>
    );
  }

  if (!usable) {
    return (
      <>
        {hero}
        <section className="section don-section">
          <div className="container container--narrow">
            <div className="card card--solid card--static don-card don-closed">
              <span className="don-closed__icon" aria-hidden="true">
                <LuHeartHandshake />
              </span>
              <h2 className="don-closed__title">
                {t("இணையவழி நன்கொடை விரைவில் தொடங்கும்", "Online donations will open soon")}
              </h2>
              <p className="don-closed__text">
                {t(
                  "இப்போதைக்கு வங்கிப் பரிமாற்றம் அல்லது காசோலை மூலம் நன்கொடை வழங்கலாம். நீங்கள் நன்கொடை வழங்க உள்ளதைப் பதிவு செய்தால், கோயில் அலுவலகம் தொடர்பு கொள்ளும்.",
                  "For now you can give by bank transfer or cheque. Tell us you will donate and the temple office will follow up.",
                )}
              </p>
              <div className="don-closed__actions">
                <Button to="/donations#bank-details" variant="primary" icon={<LuLandmark aria-hidden="true" />}>
                  {t("வங்கி விவரங்கள்", "Bank transfer details")}
                </Button>
                <Button to="/donations#pledge" variant="outline" icon={<LuHeartHandshake aria-hidden="true" />}>
                  {t("நன்கொடை பதிவு", "Tell us you will donate")}
                </Button>
              </div>
            </div>
          </div>
        </section>
      </>
    );
  }

  const step = DONATE_STEPS[stepIndex];
  const busy = status === "sending";
  const summaryEntries = Object.entries(errors[stepKey] ?? {}).map(([key, message]) => ({
    key,
    message,
    id: fieldIdFor(key),
    label: fieldLabel(key, form, t),
  }));

  const description = {
    purpose: t(
      "உங்கள் நன்கொடை எதற்கு, எவ்வளவு என்பதைத் தேர்ந்தெடுக்கவும்.",
      "Choose what your donation is for, and how much you would like to give.",
    ),
    details: t(
      "ரசீதுக்கும் தொடர்புக்கும் தேவையான விவரங்கள். * குறியிட்டவை கட்டாயம்.",
      "The details needed for your receipt. Fields marked * are required.",
    ),
    review: t(
      "பணம் செலுத்தும் முன் எல்லாவற்றையும் சரிபார்க்கவும். எந்தப் பகுதியையும் திருத்தலாம்.",
      "Check everything before you pay. You can edit any section.",
    ),
  }[stepKey];

  let primaryLabel = t("அடுத்து", "Next");
  if (stepKey === "review") primaryLabel = t("பணம் செலுத்தத் தொடரவும்", "Proceed to payment");
  else if (returnToReview) primaryLabel = t("சேமித்துச் சரிபார்ப்புக்குத் திரும்பு", "Save and return to review");

  const state = subdivisionsOf(form.country).find((s) => s.code === form.state)?.name ?? String(form.state ?? "").trim();
  const notGiven = <span className="don-review__muted">{t("குறிப்பிடப்படவில்லை", "Not given")}</span>;

  // One set of controls, shown inline in the card on wide screens and docked
  // above the bottom navigation on phones. The dock is portalled to <body>
  // because the page transition leaves a transform on its wrapper, and a
  // transformed ancestor would pin a fixed bar to the page instead of the screen.
  const actions = (where) => (
    <div className={`don-actions don-actions--${where}`}>
      {where === "dock" && amountLabel && (
        <p className="don-actions__summary" aria-hidden="true">
          {amountLabel}
          {purposeLabel ? ` · ${purposeLabel}` : ""}
        </p>
      )}
      <div className="don-actions__row">
        {stepIndex > 0 && (
          <Button variant="outline" className="don-actions__back" icon={<LuArrowLeft aria-hidden="true" />} onClick={back}>
            {t("பின்செல்", "Back")}
          </Button>
        )}
        <Button
          type={where === "inline" ? "submit" : "button"}
          onClick={where === "dock" ? primary : undefined}
          variant="primary"
          className="don-actions__next"
          loading={busy}
          icon={stepKey === "review" ? <LuLock aria-hidden="true" /> : null}
          trailingIcon={stepKey === "review" ? null : <LuArrowRight aria-hidden="true" />}
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <>
      {hero}
      <section className="section don-section">
        <div className="container container--narrow don">
          <SimulatorBanner simulator={config.simulator} testMode={config.testMode} />

          <div ref={stepperRef} className="don__stepper">
            <FormStepper
              steps={DONATE_STEPS}
              currentIndex={stepIndex}
              isDone={isDone}
              isReachable={isReachable}
              onJump={(key) => goTo(key)}
              t={t}
              ariaLabel={t("நன்கொடைப் படிகள்", "Donation steps")}
            />
          </div>

          <form
            className="don-form"
            noValidate
            aria-labelledby="don-step-title"
            onSubmit={(e) => {
              e.preventDefault();
              primary();
            }}
          >
            <div key={stepKey} className="card card--solid card--static don-card" data-direction={direction}>
              <header className="don-card__head">
                <span className="don-card__eyebrow">
                  {t(`படி ${stepIndex + 1} / ${DONATE_STEPS.length}`, `Step ${stepIndex + 1} of ${DONATE_STEPS.length}`)}
                </span>
                <h2 id="don-step-title" ref={headingRef} tabIndex={-1} className="don-card__title">
                  {t(...step.heading)}
                </h2>
                <p className="don-card__desc">{description}</p>
              </header>

              <FormErrorSummary ref={summaryRef} entries={summaryEntries} t={t} titleId="don-summary-title" />

              <div className="don-card__body">
                {/* ── Step 1: purpose and amount ──────────────────────── */}
                {stepKey === "purpose" && (
                  <div className="don-fields">
                    <fieldset className="pay-choice">
                      <legend className="field__label">
                        {t("நன்கொடை எதற்கு?", "What is your donation for?")}
                        <span className="field__required" aria-hidden="true">
                          *
                        </span>
                      </legend>
                      {errors.purpose.category && (
                        <span className="field__error pay-choice__error">{errors.purpose.category}</span>
                      )}
                      <div className="pay-choice__options">
                        {config.categories.map((c, i) => (
                          <label key={c.slug} className="pay-choice__option">
                            {/* The first radio carries the id the error summary
                                links to: a fieldset cannot take focus. */}
                            <input
                              id={i === 0 ? "don-category" : undefined}
                              type="radio"
                              name="category"
                              value={c.slug}
                              checked={form.category === c.slug}
                              onChange={() => chooseCategory(c.slug)}
                            />
                            <span className="pay-choice__text">
                              <span className="pay-choice__name">{t(c.name.ta, c.name.en)}</span>
                              {(c.description?.ta || c.description?.en) && (
                                <span className="pay-choice__desc">{t(c.description.ta, c.description.en)}</span>
                              )}
                              {c.suggestedAmount != null && currency === "INR" && (
                                <span className="pay-choice__hint">
                                  {t(
                                    `பரிந்துரை ${formatMoney(c.suggestedAmount, "INR", "ta")}`,
                                    `Suggested ${formatMoney(c.suggestedAmount, "INR", "en")}`,
                                  )}
                                </span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    {showCurrency && (
                      <Field
                        id="don-currency"
                        label={t("நாணயம்", "Currency")}
                        error={errors.purpose.currency}
                        announce={false}
                        hint={currency !== "INR" ? t(`தொகை ${currency} நாணயத்தில்.`, `Amounts are in ${currency}.`) : undefined}
                      >
                        {(a11y) => (
                          <select
                            {...a11y}
                            name="currency"
                            value={currency}
                            onChange={(e) => changeCurrency(e.target.value)}
                            className="don-currency"
                          >
                            {config.currencies.map((c) => (
                              <option key={c.code} value={c.code}>
                                {c.code}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    )}

                    {showPresets && (
                      <fieldset className="pay-choice don-amounts">
                        <legend className="field__label">{t("விரைவுத் தொகை", "Quick amounts")}</legend>
                        <div className="don-amounts__row">
                          {config.presets.map((preset) => (
                            <label key={preset} className="don-amounts__chip">
                              <input
                                type="radio"
                                name="amountChoice"
                                value={String(preset)}
                                checked={form.amountChoice === String(preset)}
                                onChange={() => choosePreset(preset)}
                              />
                              <span>{formatMoney(preset, "INR", lang)}</span>
                            </label>
                          ))}
                          <label className="don-amounts__chip don-amounts__chip--other">
                            <input
                              type="radio"
                              name="amountChoice"
                              value="other"
                              checked={form.amountChoice === "other"}
                              onChange={() => setForm((f) => ({ ...f, amountChoice: "other" }))}
                            />
                            <span>{t("வேறு தொகை", "Other amount")}</span>
                          </label>
                        </div>
                      </fieldset>
                    )}

                    <Field
                      id="don-amount"
                      label={t(`தொகை (${currency})`, `Amount (${currency})`)}
                      required
                      error={errors.purpose.amount}
                      announce={false}
                      className="don-amount"
                    >
                      {(a11y) => (
                        <IconInput
                          {...a11y}
                          icon={<span aria-hidden="true">{currencySymbol(currency, lang)}</span>}
                          name="amount"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          maxLength={13}
                          value={form.amount}
                          onChange={(e) => typeAmount(e.target.value)}
                        />
                      )}
                    </Field>

                    <p className="don-summary" role="status" aria-live="polite">
                      {amountValue !== null && category
                        ? t(
                            `நீங்கள் ${purposeLabel} நோக்கத்திற்கு ${amountLabel} (${currency}) வழங்குகிறீர்கள்.`,
                            `You are giving ${amountLabel} (${currency}) for ${purposeLabel}.`,
                          )
                        : ""}
                    </p>
                  </div>
                )}

                {/* ── Step 2: the donor ───────────────────────────────── */}
                {stepKey === "details" && (
                  <div className="don-fields">
                    <Field id="don-name" label={t("முழுப் பெயர்", "Full name")} required error={errors.details.name} announce={false}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          name="name"
                          value={form.name}
                          onChange={(e) => setField("name", e.target.value)}
                          autoComplete="name"
                          maxLength={DONATION_LIMITS.name[1]}
                        />
                      )}
                    </Field>

                    {/* Honeypot. People never see it and cannot Tab to it;
                        form-filling bots do fill it, and the server then quietly
                        saves nothing. It sits between two real fields, never
                        first or last, so no "focus the first input" logic lands
                        on it. */}
                    <div className="visually-hidden" aria-hidden="true">
                      <label htmlFor="don-hp-token">{t("இந்தப் புலத்தை காலியாக விடவும்", "Leave this field empty")}</label>
                      <input
                        id="don-hp-token"
                        type="text"
                        name="hp_token"
                        value={form.hp_token}
                        onChange={(e) => setForm((f) => ({ ...f, hp_token: e.target.value }))}
                        tabIndex={-1}
                        autoComplete="off"
                      />
                    </div>

                    <Field
                      id="don-phone"
                      label={t("கைபேசி எண்", "Mobile number")}
                      required
                      error={errors.details.phone}
                      announce={false}
                      hint={t(
                        "நாட்டைத் தேர்ந்தெடுத்து, முன்னால் உள்ள 0 இல்லாமல் எண்ணை உள்ளிடவும்",
                        "Pick your country, then type the number without its leading 0",
                      )}
                    >
                      {(a11y) => (
                        <PhoneInput
                          {...a11y}
                          name="phone"
                          country={form.phoneCountry}
                          national={form.phone}
                          onChange={({ country, national }) => {
                            setForm((f) => ({ ...f, phoneCountry: country, phone: national }));
                            dropError("details", "phone");
                          }}
                        />
                      )}
                    </Field>

                    <div className="field-row">
                      <Field id="don-country" label={t("நாடு", "Country")} required error={errors.details.country} announce={false}>
                        {(a11y) => <CountrySelect {...a11y} value={form.country} onChange={onCountryChange} />}
                      </Field>

                      <Field
                        id="don-email"
                        label={t("மின்னஞ்சல்", "Email")}
                        optional
                        error={errors.details.email}
                        announce={false}
                        hint={t("ரசீதை அனுப்ப", "For your receipt")}
                      >
                        {(a11y) => (
                          <input
                            {...a11y}
                            type="email"
                            name="email"
                            value={form.email}
                            onChange={(e) => setField("email", e.target.value)}
                            autoComplete="email"
                            maxLength={DONATION_LIMITS.email[1]}
                          />
                        )}
                      </Field>
                    </div>

                    <Field id="don-address" label={t("முகவரி", "Address")} optional error={errors.details.address} announce={false}>
                      {(a11y) => (
                        <input
                          {...a11y}
                          name="address"
                          value={form.address}
                          onChange={(e) => setField("address", e.target.value)}
                          autoComplete="street-address"
                          maxLength={DONATION_LIMITS.address[1]}
                        />
                      )}
                    </Field>

                    <div className="field-row">
                      <Field
                        id="don-state"
                        label={subdivisionLabel(form.country, t)}
                        optional
                        error={errors.details.state}
                        announce={false}
                      >
                        {(a11y) => (
                          <StateSelect {...a11y} country={form.country} value={form.state} onChange={(v) => setField("state", v)} />
                        )}
                      </Field>

                      <Field id="don-city" label={t("நகரம் / ஊர்", "City or town")} optional error={errors.details.city} announce={false}>
                        {(a11y) => (
                          <input
                            {...a11y}
                            name="city"
                            value={form.city}
                            onChange={(e) => setField("city", e.target.value)}
                            autoComplete="address-level2"
                            maxLength={DONATION_LIMITS.city[1]}
                          />
                        )}
                      </Field>
                    </div>

                    <div className="field-row">
                      <Field
                        id="don-postcode"
                        label={form.country === "IN" ? t("PIN குறியீடு", "PIN code") : t("அஞ்சல் குறியீடு", "Postal code")}
                        optional
                        error={errors.details.postcode}
                        announce={false}
                        hint={form.country === "IN" ? t("6 இலக்கங்கள்", "6 digits") : undefined}
                      >
                        {(a11y) => (
                          <input
                            {...a11y}
                            name="postcode"
                            value={form.postcode}
                            onChange={(e) => setField("postcode", e.target.value)}
                            autoComplete="postal-code"
                            inputMode={form.country === "IN" ? "numeric" : "text"}
                            maxLength={form.country === "IN" ? 7 : DONATION_LIMITS.postcode[1]}
                          />
                        )}
                      </Field>

                      <Field
                        id="don-pan"
                        label={t("PAN எண்", "PAN")}
                        optional
                        error={errors.details.pan}
                        announce={false}
                        hint={t("80G வரிச்சலுகை ரசீதுக்கு மட்டும் தேவை", "Needed only for an 80G tax receipt")}
                      >
                        {(a11y) => (
                          <input
                            {...a11y}
                            name="pan"
                            value={form.pan}
                            onChange={(e) => setField("pan", e.target.value.toUpperCase())}
                            autoComplete="off"
                            maxLength={10}
                            placeholder="ABCDE1234F"
                          />
                        )}
                      </Field>
                    </div>

                    <Field
                      id="don-message"
                      label={t("செய்தி", "Message")}
                      optional
                      error={errors.details.message}
                      announce={false}
                      hint={t("கோயில் அலுவலகம் பார்க்கும்", "Shown to the temple office")}
                    >
                      {(a11y) => (
                        <textarea
                          {...a11y}
                          name="message"
                          rows="2"
                          value={form.message}
                          onChange={(e) => setField("message", e.target.value)}
                          maxLength={DONATION_LIMITS.message[1]}
                        />
                      )}
                    </Field>

                    <Field
                      id="don-notes"
                      label={t("தனிப்பட்ட குறிப்பு", "Private note")}
                      optional
                      error={errors.details.notes}
                      announce={false}
                      hint={t("அலுவலகத்திற்கு மட்டும்", "For the office only")}
                    >
                      {(a11y) => (
                        <textarea
                          {...a11y}
                          name="notes"
                          rows="2"
                          value={form.notes}
                          onChange={(e) => setField("notes", e.target.value)}
                          maxLength={DONATION_LIMITS.notes[1]}
                        />
                      )}
                    </Field>

                    {/* Opt-in only, and unticked every time: a donor's name goes
                        on the public thank-you list only when they say so. */}
                    <div className="field don-consent">
                      <label className="checkbox-label" htmlFor="don-show-name">
                        <input
                          id="don-show-name"
                          type="checkbox"
                          name="showNamePublicly"
                          checked={form.showNamePublicly}
                          onChange={(e) => setField("showNamePublicly", e.target.checked)}
                          aria-describedby="don-show-name-hint"
                        />
                        <span>
                          {t("கோயிலின் நன்றிப் பட்டியலில் என் பெயரைக் காட்டவும்", "Show my name on the temple's thank-you list")}
                        </span>
                      </label>
                      <span id="don-show-name-hint" className="field__hint don-consent__hint">
                        {t(
                          "தேர்வு செய்யாவிட்டால் உங்கள் நன்கொடை பெயரில்லாமல் இருக்கும். உங்கள் பெயரும் நோக்கமும் மட்டுமே காட்டப்படும்; தொகையோ தொலைபேசி எண்ணோ ஒருபோதும் காட்டப்படாது.",
                          "Leave it unticked to donate anonymously. Only your name and purpose are shown — never the amount or your phone.",
                        )}
                      </span>
                    </div>
                  </div>
                )}

                {/* ── Step 3: review and pay ──────────────────────────── */}
                {stepKey === "review" && (
                  <div className="don-review-list">
                    <div className="don-total">
                      <span className="don-total__value">{amountLabel}</span>
                      <span className="don-total__code">{currency}</span>
                      {purposeLabel && <span className="don-total__purpose">{purposeLabel}</span>}
                    </div>

                    <ReviewSection
                      id="don-review-purpose"
                      icon={<LuHeartHandshake />}
                      title={t("நோக்கமும் தொகையும்", "Purpose and amount")}
                      editName={t("திருத்து: நோக்கமும் தொகையும்", "Edit purpose and amount")}
                      onEdit={() => editFromReview("purpose")}
                      t={t}
                    >
                      <dl className="don-review__list">
                        <Row label={t("நோக்கம்", "Purpose")}>{purposeLabel || notGiven}</Row>
                        <Row label={t("தொகை", "Amount")}>
                          {amountLabel} ({currency})
                        </Row>
                      </dl>
                    </ReviewSection>

                    <ReviewSection
                      id="don-review-details"
                      icon={<LuUser />}
                      title={t("உங்கள் விவரங்கள்", "Your details")}
                      editName={t("திருத்து: உங்கள் விவரங்கள்", "Edit your details")}
                      onEdit={() => editFromReview("details")}
                      t={t}
                    >
                      <dl className="don-review__list">
                        <Row label={t("முழுப் பெயர்", "Full name")}>{form.name.trim()}</Row>
                        <Row label={t("கைபேசி எண்", "Mobile number")}>
                          {formatInternational(form.phone, form.phoneCountry)}
                        </Row>
                        <Row label={t("மின்னஞ்சல்", "Email")}>{form.email.trim() || notGiven}</Row>
                        <Row label={t("நாடு", "Country")}>{countryName(form.country)}</Row>
                        <Row label={t("முகவரி", "Address")}>
                          {[form.address.trim(), form.city.trim(), state, form.postcode.trim()].filter(Boolean).join(", ") ||
                            notGiven}
                        </Row>
                        <Row label={t("PAN எண்", "PAN")}>{form.pan.trim() || notGiven}</Row>
                        <Row label={t("நன்றிப் பட்டியல்", "Thank-you list")}>
                          {form.showNamePublicly
                            ? t("என் பெயரைக் காட்டவும்", "Show my name")
                            : t("பெயரில்லாமல்", "Anonymous")}
                        </Row>
                      </dl>
                    </ReviewSection>

                    <div className="don-terms">
                      <label className="checkbox-label" htmlFor="don-accept-terms">
                        <input
                          id="don-accept-terms"
                          type="checkbox"
                          name="acceptTerms"
                          checked={form.acceptTerms}
                          onChange={(e) => setField("acceptTerms", e.target.checked)}
                          aria-invalid={errors.review.acceptTerms ? true : undefined}
                          aria-describedby={errors.review.acceptTerms ? "don-accept-terms-err" : undefined}
                        />
                        <span>
                          {t("நான் ", "I have read the ")}
                          <Link to={TERMS_PATH} target="_blank" rel="noopener">
                            {t("விதிமுறைகளையும்", "Terms & Conditions")}
                          </Link>
                          {t(" ", " and the ")}
                          <Link to={REFUNDS_PATH} target="_blank" rel="noopener">
                            {t("பணத்திரும்பக் கொள்கையையும்", "Refund & Cancellation Policy")}
                          </Link>
                          {t(" படித்து ஏற்கிறேன்.", ".")}
                        </span>
                      </label>
                      {errors.review.acceptTerms && (
                        <span id="don-accept-terms-err" className="field__error">
                          {errors.review.acceptTerms}
                        </span>
                      )}
                    </div>

                    <p className="don-secure">
                      <LuShieldCheck aria-hidden="true" />
                      <span>
                        {t(
                          "CCAvenue-இன் பாதுகாப்பான பக்கத்தில் UPI, கார்டு, நெட் பேங்கிங் அல்லது வாலட் மூலம் பணம் செலுத்துவீர்கள். உங்கள் கார்டு விவரங்கள் கோயிலுக்கு வருவதில்லை.",
                          "You will pay on CCAvenue's secure page by UPI, card, net banking or wallet. We never see your card details.",
                        )}
                      </span>
                    </p>
                    <p className="don-secure don-secure--80g">
                      <LuBadgeCheck aria-hidden="true" />
                      <span>{t(TRUST.taxExemption.long.ta, TRUST.taxExemption.long.en)}</span>
                    </p>

                    {status === "limited" && <Alert tone="warning">{rateLimitMessage(t, retryAfter)}</Alert>}
                    {status === "unavailable" && (
                      <Alert tone="error">
                        {t(
                          "இணையவழிக் கட்டணம் இப்போது இடைநிறுத்தப்பட்டுள்ளது. வங்கிப் பரிமாற்றம் மூலம் வழங்கலாம், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
                          "Online donations are paused right now. You can give by bank transfer, or call the temple office.",
                        )}
                      </Alert>
                    )}
                    {status === "error" && (
                      <Alert tone="error">
                        {t(
                          "கட்டணத்தைத் தொடங்க இயலவில்லை. மீண்டும் முயற்சிக்கவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
                          "We could not start the payment. Please try again, or call the temple office.",
                        )}
                      </Alert>
                    )}
                    {status === "network" && (
                      <Alert tone="error">
                        {t(
                          "கோயில் சேவையகத்தை அடைய முடியவில்லை. இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.",
                          "Could not reach the temple server. Check your connection and try again.",
                        )}
                      </Alert>
                    )}
                  </div>
                )}
              </div>

              {actions("inline")}
            </div>
          </form>

          <p className="don-offline">
            <Link to="/donations#bank-details">{t("வங்கிப் பரிமாற்ற விவரங்கள்", "Prefer a bank transfer?")}</Link>
          </p>

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </section>
      {createPortal(actions("dock"), document.body)}
    </>
  );
}
