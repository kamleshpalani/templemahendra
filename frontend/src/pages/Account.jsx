import { useCallback, useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useNavigate } from "react-router-dom";
import {
  LuBanknote,
  LuCalendarCheck,
  LuCalendarClock,
  LuCircleCheck,
  LuFlame,
  LuHeartHandshake,
  LuKeyRound,
  LuLogOut,
  LuMailWarning,
  LuReceipt,
  LuSave,
  LuUser,
} from "react-icons/lu";
import SegmentedControl from "../components/ui/Tabs";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Alert from "../components/ui/Alert";
import { Field, PasswordInput } from "../components/ui/Field";
import { EmptyState, ErrorState, SkeletonText } from "../components/ui/Feedback";
import PasswordRules, { passwordProblem } from "../components/Auth/PasswordRules";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import { TEMPLE } from "../data/temple";
import "./Account.css";

const STATUS_TONE = { confirmed: "success", completed: "success", pending: "warning", cancelled: "danger" };

function initialsOf(name = "") {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "·"
  );
}

/** ₹ with thousands separators, no trailing paise when the amount is whole. */
function money(value) {
  const n = Number(value) || 0;
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: n % 1 === 0 ? 0 : 2 })}`;
}

function formatDate(value, lang) {
  if (!value) return "—";
  const d = new Date(String(value).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function Account() {
  const { t } = useLang();
  const { user, get, logout, resend } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [tab, setTab] = useState("overview");
  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setSummary(await get("/account/summary"));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [get]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const tabs = useMemo(
    () => [
      { value: "overview", label: t("சுருக்கம்", "Overview"), icon: <LuFlame aria-hidden="true" /> },
      { value: "bookings", label: t("சேவை பதிவுகள்", "Bookings"), icon: <LuCalendarCheck aria-hidden="true" /> },
      { value: "donations", label: t("நன்கொடைகள்", "Offerings"), icon: <LuHeartHandshake aria-hidden="true" /> },
      { value: "profile", label: t("என் விவரங்கள்", "My details"), icon: <LuUser aria-hidden="true" /> },
    ],
    [t],
  );

  const signOut = async () => {
    await logout();
    toast.info(t("வெளியேறிவிட்டீர்கள்.", "You are signed out."));
    navigate("/", { replace: true });
  };

  return (
    <>
      <Helmet>
        <title>
          {t("என் கணக்கு", "My account")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="acct-head">
        <div className="container acct-head__inner">
          <span className="avatar avatar--lg acct-head__avatar" aria-hidden="true">
            {initialsOf(user?.name)}
          </span>
          <div className="acct-head__text">
            <span className="page-hero__eyebrow">{t("என் கணக்கு", "My account")}</span>
            <h1 className="acct-head__name">{user?.name}</h1>
            <p className="acct-head__meta">
              <span>{user?.email}</span>
              {user?.verified ? (
                <Badge tone="sage">
                  <LuCircleCheck aria-hidden="true" /> {t("உறுதிப்படுத்தப்பட்டது", "Confirmed")}
                </Badge>
              ) : (
                <Badge tone="warning">
                  <LuMailWarning aria-hidden="true" /> {t("உறுதிப்படுத்தப்படவில்லை", "Not confirmed")}
                </Badge>
              )}
            </p>
          </div>
          <div className="acct-head__actions">
            <Button to="/sevas" variant="gold" icon={<LuFlame aria-hidden="true" />}>
              {t("சேவை பதிவு", "Book a seva")}
            </Button>
            <Button variant="outline-light" onClick={signOut} icon={<LuLogOut aria-hidden="true" />}>
              {t("வெளியேறு", "Sign out")}
            </Button>
          </div>
        </div>
      </header>

      <section className="section section--tight">
        <div className="container">
          {!user?.verified && <VerifyBanner resend={resend} />}

          {/* ── KPIs ─────────────────────────────────────────────── */}
          {failed ? (
            <ErrorState onRetry={loadSummary}>
              {t(
                "உங்கள் விவரங்களை ஏற்ற முடியவில்லை.",
                "We could not load your account just now.",
              )}
            </ErrorState>
          ) : (
            <div className="grid-4 acct-kpis">
              <Kpi
                icon={<LuCalendarCheck />}
                value={loading ? null : summary?.bookings ?? 0}
                label={t("சேவை பதிவுகள்", "Seva bookings")}
              />
              <Kpi
                icon={<LuCalendarClock />}
                value={loading ? null : summary?.pending ?? 0}
                label={t("உறுதிப்படுத்தல் காத்திருப்பு", "Awaiting confirmation")}
              />
              <Kpi
                icon={<LuReceipt />}
                value={loading ? null : summary?.donations ?? 0}
                label={t("நன்கொடைகள்", "Offerings made")}
              />
              <Kpi
                icon={<LuBanknote />}
                value={loading ? null : money(summary?.donated)}
                label={t("மொத்தம் அளித்தது", "Total offered")}
              />
            </div>
          )}

          <SegmentedControl
            items={tabs}
            value={tab}
            onChange={setTab}
            label={t("கணக்கு பிரிவுகள்", "Account sections")}
            className="acct-tabs"
          />

          <div className="acct-panel">
            {tab === "overview" && <Overview summary={summary} loading={loading} onTab={setTab} />}
            {tab === "bookings" && <Bookings />}
            {tab === "donations" && <Donations />}
            {tab === "profile" && <Profile onSaved={loadSummary} />}
          </div>
        </div>
      </section>
    </>
  );
}

/* ── Pieces ─────────────────────────────────────────────────────────── */

function Kpi({ icon, value, label }) {
  return (
    <div className="card card--static stat">
      <span className="stat__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="stat__body">
        <span className="stat__val">{value === null ? <span className="skeleton skeleton--title" /> : value}</span>
        <span className="stat__label">{label}</span>
      </div>
    </div>
  );
}

/** Nudge to confirm the email address, with a resend that says what happened. */
function VerifyBanner({ resend }) {
  const { t } = useLang();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const send = async () => {
    setBusy(true);
    try {
      const data = await resend();
      setSent(true);
      toast.success(data.message ?? t("மீண்டும் அனுப்பப்பட்டது.", "Sent again."));
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert tone="warning" title={t("மின்னஞ்சலை உறுதிப்படுத்துங்கள்", "Confirm your email address")} className="acct-verify">
      <span>
        {t(
          "உறுதிப்படுத்தினால் பதிவு உறுதிப்படுத்தல்களும் ரசீதுகளும் மின்னஞ்சலில் வரும்.",
          "Once confirmed, booking confirmations and receipts can reach you by email.",
        )}
      </span>
      <Button variant="soft" size="sm" onClick={send} loading={busy} disabled={sent}>
        {sent ? t("அனுப்பப்பட்டது", "Sent") : t("இணைப்பை மீண்டும் அனுப்பு", "Resend the link")}
      </Button>
    </Alert>
  );
}

function Overview({ summary, loading, onTab }) {
  const { t, lang } = useLang();
  if (loading) return <SkeletonText lines={4} />;

  const next = summary?.nextBooking;
  const nothing = !summary?.bookings && !summary?.donations;

  if (nothing) {
    return (
      <EmptyState
        icon={<LuFlame />}
        title={t("இன்னும் எதுவும் இல்லை", "Nothing here yet")}
        action={
          <>
            <Button to="/sevas" variant="primary" icon={<LuFlame aria-hidden="true" />}>
              {t("சேவை பதிவு செய்ய", "Book a seva")}
            </Button>
            <Button to="/donations" variant="outline">
              {t("நன்கொடை விவரங்கள்", "Donation details")}
            </Button>
          </>
        }
      >
        {t(
          "நீங்கள் செய்யும் சேவை பதிவுகளும் நன்கொடைகளும் இங்கே சேரும்.",
          "The sevas you book and the offerings you make will collect here.",
        )}
      </EmptyState>
    );
  }

  return (
    <div className="acct-overview">
      {next ? (
        <article className="card card--gold acct-next">
          <span className="eyebrow">{t("அடுத்த சேவை", "Your next seva")}</span>
          <h2 className="acct-next__title">{next.seva_name}</h2>
          <p className="acct-next__when">
            <LuCalendarClock aria-hidden="true" />
            {formatDate(next.preferred_date, lang)}
            <Badge tone={STATUS_TONE[next.status] ?? "muted"}>{next.status}</Badge>
          </p>
          <p className="acct-next__note">
            {next.status === "pending"
              ? t(
                  "கோயில் குழு உறுதிப்படுத்திய பிறகு தொடர்பு கொள்வார்கள்.",
                  "The committee will confirm this and get in touch.",
                )
              : t("உறுதிப்படுத்தப்பட்டுவிட்டது. கோயிலில் சந்திக்கலாம்.", "Confirmed. We will see you at the temple.")}
          </p>
          <Button variant="outline" size="sm" onClick={() => onTab("bookings")}>
            {t("எல்லா பதிவுகளும்", "All bookings")}
          </Button>
        </article>
      ) : (
        <article className="card card--static acct-next">
          <span className="eyebrow">{t("வரவிருப்பது", "Coming up")}</span>
          <h2 className="acct-next__title">{t("திட்டமிட்ட சேவை இல்லை", "No seva scheduled")}</h2>
          <p className="acct-next__note">
            {t(
              "பௌர்ணமி அன்று சிறப்பு பூஜையும் அன்னதானமும் நடக்கும்.",
              "There is a special pooja and annadanam every Pournami.",
            )}
          </p>
          <Button to="/sevas" variant="primary" size="sm" icon={<LuFlame aria-hidden="true" />}>
            {t("சேவை பதிவு", "Book a seva")}
          </Button>
        </article>
      )}

      <div className="acct-overview__links">
        <button type="button" className="card card--interactive acct-link" onClick={() => onTab("bookings")}>
          <span className="card__icon" aria-hidden="true">
            <LuCalendarCheck />
          </span>
          <span>
            <strong>{t("சேவை பதிவுகள்", "Seva bookings")}</strong>
            <small>
              {summary?.bookings ?? 0} {t("பதிவு", "in total")}
            </small>
          </span>
        </button>
        <button type="button" className="card card--interactive acct-link" onClick={() => onTab("donations")}>
          <span className="card__icon" aria-hidden="true">
            <LuHeartHandshake />
          </span>
          <span>
            <strong>{t("நன்கொடைகள்", "Offerings")}</strong>
            <small>
              {money(summary?.donated)} {t("மொத்தம்", "given")}
            </small>
          </span>
        </button>
        <Link to="/panchangam" className="card card--interactive acct-link">
          <span className="card__icon" aria-hidden="true">
            <LuCalendarClock />
          </span>
          <span>
            <strong>{t("பஞ்சாங்கம்", "Panchangam")}</strong>
            <small>{t("நல்ல நேரம், பௌர்ணமி", "Auspicious days and Pournami")}</small>
          </span>
        </Link>
      </div>
    </div>
  );
}

/** Shared fetch-and-render for the two history tabs. */
function useList(path) {
  const { get } = useAuth();
  const [rows, setRows] = useState(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setRows(null);
    try {
      const data = await get(path);
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setFailed(true);
    }
  }, [get, path]);

  useEffect(() => {
    load();
  }, [load]);

  return { rows, failed, reload: load };
}

function Bookings() {
  const { t, lang } = useLang();
  const { rows, failed, reload } = useList("/account/bookings");

  if (failed) return <ErrorState onRetry={reload} />;
  if (rows === null) return <SkeletonText lines={5} />;
  if (!rows.length) {
    return (
      <EmptyState
        icon={<LuCalendarCheck />}
        title={t("சேவை பதிவு இல்லை", "No bookings yet")}
        action={
          <Button to="/sevas" variant="primary" icon={<LuFlame aria-hidden="true" />}>
            {t("சேவை பதிவு செய்ய", "Book a seva")}
          </Button>
        }
      >
        {t(
          "கணக்கில் உள்நுழைந்து பதிவு செய்தால் அது இங்கே தெரியும்.",
          "Bookings you make while signed in will show up here.",
        )}
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table table--zebra">
        <caption className="sr-only">{t("என் சேவை பதிவுகள்", "My seva bookings")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("சேவை", "Seva")}</th>
            <th scope="col">{t("விருப்ப தேதி", "Preferred date")}</th>
            <th scope="col">{t("நிலை", "Status")}</th>
            <th scope="col">{t("பதிவு செய்த நாள்", "Requested")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">
                {r.seva_name}
                {r.message && <small className="acct-cell-note">{r.message}</small>}
              </th>
              <td>{formatDate(r.preferred_date, lang)}</td>
              <td>
                <Badge tone={STATUS_TONE[r.status] ?? "muted"}>{r.status}</Badge>
              </td>
              <td>{formatDate(r.created_at, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Donations() {
  const { t, lang } = useLang();
  const { rows, failed, reload } = useList("/account/donations");

  if (failed) return <ErrorState onRetry={reload} />;
  if (rows === null) return <SkeletonText lines={5} />;
  if (!rows.length) {
    return (
      <EmptyState
        icon={<LuHeartHandshake />}
        title={t("நன்கொடை பதிவு இல்லை", "No offerings recorded")}
        action={
          <Button to="/donations" variant="primary">
            {t("நன்கொடை விவரங்கள்", "How to give")}
          </Button>
        }
      >
        {t(
          "வங்கி வழியாக அளித்தால், ரசீது கேட்டு கோயில் அலுவலகத்தை தொடர்பு கொள்ளுங்கள்.",
          "If you gave by bank transfer, contact the office and they will record it against your account.",
        )}
      </EmptyState>
    );
  }

  const total = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

  return (
    <div className="table-wrap">
      <table className="table table--zebra">
        <caption className="sr-only">{t("என் நன்கொடைகள்", "My offerings")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("நாள்", "Date")}</th>
            <th scope="col">{t("நோக்கம்", "Purpose")}</th>
            <th scope="col" className="acct-num">
              {t("தொகை", "Amount")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{formatDate(r.created_at, lang)}</th>
              <td>
                {r.purpose || t("பொது நன்கொடை", "General donation")}
                {r.message && <small className="acct-cell-note">{r.message}</small>}
              </td>
              <td className="acct-num">{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={2}>
              {t("மொத்தம்", "Total")}
            </th>
            <td className="acct-num">{money(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Profile({ onSaved }) {
  const { t } = useLang();
  const { user, updateProfile, changePassword } = useAuth();
  const toast = useToast();

  const [details, setDetails] = useState({ name: user?.name ?? "", phone: user?.phone ?? "" });
  const [detailErrors, setDetailErrors] = useState({});
  const [savingDetails, setSavingDetails] = useState(false);

  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState({});
  const [savingPw, setSavingPw] = useState(false);

  const saveDetails = async (e) => {
    e.preventDefault();
    const next = {};
    if (details.name.trim().length < 2) next.name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    const digits = details.phone.replace(/\D+/g, "");
    if (digits && !/^\d{7,15}$/.test(digits)) {
      next.phone = t("7 முதல் 15 இலக்கங்கள்", "Use 7 to 15 digits, or leave it blank");
    }
    setDetailErrors(next);
    if (Object.keys(next).length) return;

    setSavingDetails(true);
    try {
      const data = await updateProfile({ name: details.name.trim(), phone: digits });
      toast.success(data.message ?? t("சேமிக்கப்பட்டது.", "Saved."));
      onSaved?.();
    } catch (err) {
      setDetailErrors(err.fields ?? {});
      toast.error(err.message);
    } finally {
      setSavingDetails(false);
    }
  };

  const savePassword = async (e) => {
    e.preventDefault();
    const next = {};
    if (!pw.currentPassword) next.currentPassword = t("தற்போதைய கடவுச்சொல்", "Enter your current password");
    const pp = passwordProblem(pw.newPassword, user?.email ?? "");
    if (pp) next.newPassword = pp;
    if (pw.confirm !== pw.newPassword) {
      next.confirm = t("இரண்டு கடவுச்சொற்களும் ஒன்றாக இல்லை", "The two passwords do not match");
    }
    setPwErrors(next);
    if (Object.keys(next).length) return;

    setSavingPw(true);
    try {
      const data = await changePassword(pw.currentPassword, pw.newPassword);
      toast.success(data.message ?? t("கடவுச்சொல் மாற்றப்பட்டது.", "Password changed."));
      setPw({ currentPassword: "", newPassword: "", confirm: "" });
    } catch (err) {
      setPwErrors(err.fields ?? {});
      toast.error(err.message);
    } finally {
      setSavingPw(false);
    }
  };

  return (
    <div className="acct-forms">
      <section className="card card--solid card--static acct-form" aria-labelledby="acct-details-title">
        <h2 id="acct-details-title" className="acct-form__title">
          {t("என் விவரங்கள்", "My details")}
        </h2>
        <p className="acct-form__lead">
          {t(
            "சேவை பதிவு படிவங்களில் இவை தானாக நிரம்பும்.",
            "These prefill the seva booking form so you do not retype them.",
          )}
        </p>
        <form onSubmit={saveDetails} noValidate>
          <Field label={t("பெயர்", "Full name")} required error={detailErrors.name}>
            {(a11y) => (
              <input
                {...a11y}
                required
                value={details.name}
                onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
                autoComplete="name"
              />
            )}
          </Field>
          <Field label={t("தொலைபேசி", "Phone")} optional error={detailErrors.phone}>
            {(a11y) => (
              <input
                {...a11y}
                type="tel"
                value={details.phone}
                onChange={(e) => setDetails((d) => ({ ...d, phone: e.target.value }))}
                inputMode="numeric"
                autoComplete="tel"
                placeholder="9999999999"
              />
            )}
          </Field>
          <Field label={t("மின்னஞ்சல்", "Email address")} hint={t("மாற்ற கோயிலை தொடர்பு கொள்ளுங்கள்", "Contact the temple office to change this")}>
            {(a11y) => <input {...a11y} type="email" value={user?.email ?? ""} readOnly disabled />}
          </Field>
          <Button type="submit" variant="primary" loading={savingDetails} icon={<LuSave aria-hidden="true" />}>
            {t("விவரங்களை சேமி", "Save details")}
          </Button>
        </form>
      </section>

      <section className="card card--solid card--static acct-form" aria-labelledby="acct-pw-title">
        <h2 id="acct-pw-title" className="acct-form__title">
          {t("கடவுச்சொல்லை மாற்று", "Change password")}
        </h2>
        <p className="acct-form__lead">
          {t(
            "மாற்றியபின் நிலுவையில் உள்ள மீட்பு இணைப்புகள் செல்லாது.",
            "Any outstanding reset links stop working once you change it.",
          )}
        </p>
        <form onSubmit={savePassword} noValidate>
          <Field label={t("தற்போதைய கடவுச்சொல்", "Current password")} required error={pwErrors.currentPassword}>
            {(a11y) => (
              <PasswordInput
                {...a11y}
                required
                value={pw.currentPassword}
                onChange={(e) => setPw((p) => ({ ...p, currentPassword: e.target.value }))}
                autoComplete="current-password"
              />
            )}
          </Field>
          <Field label={t("புதிய கடவுச்சொல்", "New password")} required error={pwErrors.newPassword}>
            {(a11y) => (
              <PasswordInput
                {...a11y}
                required
                value={pw.newPassword}
                onChange={(e) => setPw((p) => ({ ...p, newPassword: e.target.value }))}
                autoComplete="new-password"
              />
            )}
          </Field>
          <PasswordRules value={pw.newPassword} identity={user?.email ?? ""} />
          <Field label={t("மீண்டும் உள்ளிடவும்", "Repeat the new password")} required error={pwErrors.confirm}>
            {(a11y) => (
              <PasswordInput
                {...a11y}
                required
                value={pw.confirm}
                onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))}
                autoComplete="new-password"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" loading={savingPw} icon={<LuKeyRound aria-hidden="true" />}>
            {t("கடவுச்சொல்லை மாற்று", "Change password")}
          </Button>
        </form>
      </section>
    </div>
  );
}
