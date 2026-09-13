import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  LuBadgeCheck,
  LuBanknote,
  LuBell,
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
  LuSmartphone,
  LuUser,
} from "react-icons/lu";
import SegmentedControl from "../components/ui/Tabs";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Alert from "../components/ui/Alert";
import Modal from "../components/ui/Modal";
import { Field, PasswordInput } from "../components/ui/Field";
import { EmptyState, ErrorState, SkeletonText } from "../components/ui/Feedback";
import PasswordRules, { passwordProblem } from "../components/Auth/PasswordRules";
import PhoneInput from "../components/ui/PhoneInput";
import CountrySelect from "../components/ui/CountrySelect";
import StateSelect from "../components/ui/StateSelect";
import NotificationPreferences from "../components/Notifications/NotificationPreferences";
import { hasSubdivisions, parseInternational, phoneProblem, subdivisionLabel, toE164 } from "../lib/phone";
import { DEFAULT_COUNTRY } from "../data/countries";
import Seo from "../components/Seo";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";
import { useToast } from "../context/ToastContext";
import { useCsrfPost } from "../hooks/usePushSubscription";
import "./Account.css";

const STATUS_TONE = { confirmed: "success", completed: "success", pending: "warning", cancelled: "danger" };

/** The database enum is English; a Tamil table should not show it raw. */
const STATUS_LABEL = {
  pending: ["உறுதிப்படுத்தல் காத்திருப்பு", "Pending"],
  confirmed: ["உறுதியானது", "Confirmed"],
  completed: ["முடிந்தது", "Completed"],
  cancelled: ["ரத்து செய்யப்பட்டது", "Cancelled"],
};

/**
 * The tabs, in order, as they appear in ?tab=. The URL is the only record of
 * which tab is open, so a link from an email ("/account?tab=notifications"),
 * a reload and the bell all land on the same place. Overview is the default
 * and is written as a bare /account.
 */
const TABS = ["overview", "bookings", "donations", "profile", "notifications"];

/** How long "Resend code" waits after a code is sent, when the server names no wait of its own. */
const RESEND_AFTER_SECONDS = 30;

/**
 * Split a saved E.164 number back into the country and national parts the
 * phone field is controlled on. Rows written before migration 004 carry no
 * country; those were all Indian, which is what the default resolves to.
 */
function parseSaved(user) {
  const stored = user?.phone ?? "";
  if (!stored) return { country: user?.phoneCountry || DEFAULT_COUNTRY, national: "" };
  const parsed = parseInternational(stored, user?.phoneCountry || DEFAULT_COUNTRY);
  return parsed ?? { country: user?.phoneCountry || DEFAULT_COUNTRY, national: String(stored).replace(/\D+/g, "") };
}

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

const digitsOnly = (value) => String(value ?? "").replace(/\D+/g, "");

/** "0:25" or "12:04" — a countdown that reads the same in both languages. */
function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Account() {
  const { t } = useLang();
  const { user, get, logout, resend } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab = TABS.includes(requested) ? requested : "overview";

  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  // Unsaved notification settings, and the tab switch waiting on the devotee's
  // answer to "leave without saving?".
  const [prefsDirty, setPrefsDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState(null);
  // Where the Profile tab should put the cursor when another tab sends the
  // devotee there ("Add a phone number", "Verify number").
  const [profileFocus, setProfileFocus] = useState(null);
  const clearProfileFocus = useCallback(() => setProfileFocus(null), []);

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

  // A tab name the page does not have is dropped from the address rather than
  // left there to mislead; the page shows the overview either way.
  useEffect(() => {
    if (requested !== null && !TABS.includes(requested)) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("tab");
          return next;
        },
        { replace: true },
      );
    }
  }, [requested, setSearchParams]);

  /**
   * Switching tabs rewrites ?tab= in place (history replace). Tabs are views of
   * one page, not places: Back should leave the account page, not step through
   * every tab the devotee glanced at.
   */
  const goToTab = useCallback(
    (next, { focus = null } = {}) => {
      setProfileFocus(next === "profile" ? focus : null);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "overview") params.delete("tab");
          else params.set("tab", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const changeTab = useCallback(
    (next, opts = {}) => {
      if (!TABS.includes(next)) return;
      if (next === tab) {
        if (opts.focus) setProfileFocus(opts.focus);
        return;
      }
      if (tab === "notifications" && prefsDirty) {
        setPendingTab({ next, opts });
        return;
      }
      goToTab(next, opts);
    },
    [tab, prefsDirty, goToTab],
  );

  const leaveWithoutSaving = () => {
    const pending = pendingTab;
    setPendingTab(null);
    setPrefsDirty(false);
    if (pending) goToTab(pending.next, pending.opts);
  };

  const tabs = useMemo(
    () => [
      { value: "overview", label: t("சுருக்கம்", "Overview"), icon: <LuFlame aria-hidden="true" /> },
      { value: "bookings", label: t("சேவை பதிவுகள்", "Bookings"), icon: <LuCalendarCheck aria-hidden="true" /> },
      { value: "donations", label: t("நன்கொடைகள்", "Offerings"), icon: <LuHeartHandshake aria-hidden="true" /> },
      { value: "profile", label: t("என் விவரங்கள்", "My details"), icon: <LuUser aria-hidden="true" /> },
      { value: "notifications", label: t("அறிவிப்புகள்", "Notifications"), icon: <LuBell aria-hidden="true" /> },
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
      <Seo title={t("என் கணக்கு", "My account")} robots="noindex, nofollow" />

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
            onChange={changeTab}
            label={t("கணக்கு பிரிவுகள்", "Account sections")}
            className="acct-tabs"
          />

          <div className="acct-panel">
            {tab === "overview" && <Overview summary={summary} loading={loading} onTab={changeTab} />}
            {tab === "bookings" && <Bookings />}
            {tab === "donations" && <Donations />}
            {tab === "profile" && <Profile onSaved={loadSummary} focus={profileFocus} onFocused={clearProfileFocus} />}
            {tab === "notifications" && <NotificationPreferences onTab={changeTab} onDirtyChange={setPrefsDirty} />}
          </div>
        </div>
      </section>

      <Modal
        open={pendingTab !== null}
        onClose={() => setPendingTab(null)}
        size="sm"
        title={t("சேமிக்காமல் வெளியேறவா?", "Leave without saving?")}
        description={t(
          "உங்கள் அறிவிப்பு அமைப்புகளில் சேமிக்கப்படாத மாற்றங்கள் உள்ளன.",
          "Your notification settings have changes that are not saved yet.",
        )}
      >
        <div className="modal__actions">
          <Button variant="ghost" onClick={() => setPendingTab(null)}>
            {t("திருத்தத் தொடர்", "Keep editing")}
          </Button>
          <Button variant="danger" onClick={leaveWithoutSaving}>
            {t("மாற்றங்களை நீக்கு", "Discard changes")}
          </Button>
        </div>
      </Modal>
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
            <Badge tone={STATUS_TONE[next.status] ?? "muted"}>{t(...(STATUS_LABEL[next.status] ?? [next.status, next.status]))}</Badge>
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
                <Badge tone={STATUS_TONE[r.status] ?? "muted"}>{t(...(STATUS_LABEL[r.status] ?? [r.status, r.status]))}</Badge>
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

function Profile({ onSaved, focus, onFocused }) {
  const { t } = useLang();
  const { user, updateProfile, changePassword } = useAuth();
  const toast = useToast();
  const phoneRef = useRef(null);
  const verifyRef = useRef(null);

  // The saved number is E.164; split it back into a country and a national part
  // so the field opens showing what the devotee actually entered.
  const saved = parseSaved(user);
  const [details, setDetails] = useState({
    name: user?.name ?? "",
    phone: saved.national,
    phoneCountry: saved.country,
    address1: user?.address1 ?? "",
    address2: user?.address2 ?? "",
    // Country is required, so an account created before it was asked for opens
    // on the same default registration uses rather than on an empty picker.
    country: user?.country || DEFAULT_COUNTRY,
    state: user?.state ?? "",
    city: user?.city ?? "",
    postcode: user?.postcode ?? "",
  });
  const [detailErrors, setDetailErrors] = useState({});
  const [savingDetails, setSavingDetails] = useState(false);

  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState({});
  const [savingPw, setSavingPw] = useState(false);

  // Sent here from the notification settings: put the cursor where the fix is.
  useEffect(() => {
    if (!focus) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = (focus === "verify" && verifyRef.current) || phoneRef.current;
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
      }
      onFocused?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, onFocused]);

  const saveDetails = async (e) => {
    e.preventDefault();
    const next = {};
    if (details.name.trim().length < 2) next.name = t("பெயரை உள்ளிடவும்", "Please enter your name");
    const pe = phoneProblem(details.phone, details.phoneCountry);
    if (pe) next.phone = pe;
    // Where the devotee lives is required, the same as at registration, so a
    // receipt has somewhere to go. The state is only demanded where the site
    // has a list to offer; elsewhere it is a free-text line and often unused.
    if (hasSubdivisions(details.country) && !details.state.trim()) {
      next.state = t("தேர்ந்தெடுக்கவும்", `Choose your ${subdivisionLabel(details.country, (ta, en) => en).toLowerCase()}`);
    }
    if (details.city.trim().length < 2) next.city = t("நகரத்தை உள்ளிடவும்", "Please enter your city or town");
    if (!details.country) next.country = t("நாட்டைத் தேர்ந்தெடுக்கவும்", "Choose your country");
    setDetailErrors(next);
    if (Object.keys(next).length) return;

    setSavingDetails(true);
    try {
      const data = await updateProfile({
        name: details.name.trim(),
        phone: toE164(details.phone, details.phoneCountry),
        phoneCountry: details.phoneCountry,
        address1: details.address1.trim(),
        address2: details.address2.trim(),
        country: details.country,
        state: details.state.trim(),
        city: details.city.trim(),
        postcode: details.postcode.trim(),
      });
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
            "சேவை பதிவு படிவங்களில் இவை தானாக நிரம்பும். ரசீது அனுப்ப முகவரி தேவை.",
            "These prefill the seva booking form so you do not retype them. The address is where a receipt is posted.",
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
              <PhoneInput
                {...a11y}
                ref={phoneRef}
                country={details.phoneCountry}
                national={details.phone}
                onChange={({ country, national }) =>
                  setDetails((d) => ({ ...d, phoneCountry: country, phone: national }))
                }
              />
            )}
          </Field>
          <PhoneVerify
            savedPhone={user?.phone}
            verified={!!user?.phoneVerified}
            formPhone={toE164(details.phone, details.phoneCountry)}
            focusRef={verifyRef}
          />
          {/* Where a receipt is posted. The street lines and the PIN stay
              optional — the temple only needs them when there is something to
              send — but state, city and country are required, matching what
              registration asks for. */}
          <p className="acct-form__section">{t("முகவரி", "Postal address")}</p>
          <Field label={t("வீடு / தெரு", "House and street")} optional>
            {(a11y) => (
              <input
                {...a11y}
                value={details.address1}
                onChange={(e) => setDetails((d) => ({ ...d, address1: e.target.value }))}
                autoComplete="address-line1"
                maxLength={180}
              />
            )}
          </Field>
          <Field label={t("பகுதி / அடையாளம்", "Area or landmark")} optional>
            {(a11y) => (
              <input
                {...a11y}
                value={details.address2}
                onChange={(e) => setDetails((d) => ({ ...d, address2: e.target.value }))}
                autoComplete="address-line2"
                maxLength={180}
              />
            )}
          </Field>

          {/* State, city, PIN, then country — the order an Indian address is
              written and read. The state list depends on the country, so
              changing the country below clears a state chosen above. */}
          <div className="field-row">
            <Field
              label={subdivisionLabel(details.country, t)}
              required={hasSubdivisions(details.country)}
              optional={!hasSubdivisions(details.country)}
              error={detailErrors.state}
            >
              {(a11y) => (
                <StateSelect
                  {...a11y}
                  country={details.country}
                  value={details.state}
                  onChange={(next) => setDetails((d) => ({ ...d, state: next }))}
                />
              )}
            </Field>
            <Field label={t("நகரம்", "City or town")} required error={detailErrors.city}>
              {(a11y) => (
                <input
                  {...a11y}
                  required
                  value={details.city}
                  onChange={(e) => setDetails((d) => ({ ...d, city: e.target.value }))}
                  autoComplete="address-level2"
                  maxLength={120}
                />
              )}
            </Field>
          </div>

          <div className="field-row">
            <Field label={t("அஞ்சல் குறியீடு", "PIN or postal code")} optional>
              {(a11y) => (
                <input
                  {...a11y}
                  value={details.postcode}
                  onChange={(e) => setDetails((d) => ({ ...d, postcode: e.target.value }))}
                  autoComplete="postal-code"
                  maxLength={20}
                />
              )}
            </Field>
            <Field label={t("நாடு", "Country")} required error={detailErrors.country}>
              {(a11y) => (
                <CountrySelect
                  {...a11y}
                  value={details.country}
                  onChange={(iso2) => setDetails((d) => ({ ...d, country: iso2, state: "" }))}
                />
              )}
            </Field>
          </div>

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

/**
 * PhoneVerify — prove the saved mobile number belongs to this devotee
 * (SPEC §6.5). A 6-digit code goes to the number; typing it back sets
 * phoneVerified, which lets WhatsApp and SMS carry offers the devotee has
 * agreed to, and tells the committee the number is real.
 *
 * It verifies the SAVED number only. While the field above holds an unsaved
 * edit, it asks for a save first: a code for the old number would prove
 * nothing about the new one, and the server clears the proof when the number
 * changes anyway.
 *
 * It lives inside the details <form>, so every button is type="button" and
 * Enter in the code field confirms the code instead of saving the profile.
 */
function PhoneVerify({ savedPhone, verified, formPhone, focusRef }) {
  const { t } = useLang();
  const { refresh } = useAuth();
  const post = useCsrfPost();
  const toast = useToast();
  const titleId = useId();
  const codeRef = useRef(null);

  const [stage, setStage] = useState("idle"); // idle | code
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const savedDigits = digitsOnly(savedPhone);
  const formDigits = digitsOnly(formPhone);
  const edited = formDigits !== savedDigits;

  // A different saved number starts over: any code on screen was for the old one.
  useEffect(() => {
    setStage("idle");
    setCode("");
    setError("");
    setNotice("");
  }, [savedDigits]);

  useEffect(() => {
    if (!cooldownUntil) return undefined;
    let timer;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      if (n >= cooldownUntil) clearInterval(timer);
    };
    timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [cooldownUntil]);
  const waitSeconds = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0;

  // Focus moves to the code field once it exists and is enabled again: after
  // "Verify number" the field is only rendered on the next commit, and after a
  // wrong code it is disabled until the request settles. A requestAnimationFrame
  // can run before either happens, so this waits for the render itself.
  const pendingFocus = useRef(null);
  useEffect(() => {
    const input = codeRef.current;
    if (!pendingFocus.current || !input || input.disabled) return;
    if (pendingFocus.current === "select") input.select();
    else input.focus();
    pendingFocus.current = null;
  });

  if (!savedDigits && !formDigits) return null;

  const lastFour = savedDigits.slice(-4);

  const start = async () => {
    setSending(true);
    setError("");
    try {
      const data = await post("/account/phone-verify-start", {});
      if (data?.alreadyVerified) {
        await refresh();
        toast.success(t("உங்கள் கைபேசி எண் ஏற்கெனவே சரிபார்க்கப்பட்டது.", "Your mobile number is already verified."));
        setStage("idle");
        return;
      }
      const minutes = Math.max(1, Math.round((Number(data?.expiresIn) || 600) / 60));
      const viaWhatsApp = data?.channel === "whatsapp";
      setNotice(
        t(
          `${lastFour} இல் முடியும் எண்ணுக்கு ${viaWhatsApp ? "WhatsApp-இல்" : "குறுஞ்செய்தியாக"} 6 இலக்கக் குறியீடு அனுப்பியுள்ளோம். அது ${minutes} நிமிடங்கள் செல்லும்.`,
          `We sent a 6-digit code ${viaWhatsApp ? "on WhatsApp" : "by text message"} to the number ending ${lastFour}. It works for ${minutes} minutes.`,
        ),
      );
      setCode("");
      setStage("code");
      setCooldownUntil(Date.now() + RESEND_AFTER_SECONDS * 1000);
      pendingFocus.current = "focus";
    } catch (err) {
      if (err.status === 429) {
        const wait = Number(err.data?.retryAfter) || 60;
        setCooldownUntil(Date.now() + wait * 1000);
        setError(t(`பல குறியீடுகள் கேட்கப்பட்டன. ${clock(wait)} பிறகு மீண்டும் முயலுங்கள்.`, err.message));
      } else {
        setError(err.fields?.phone || err.message);
      }
    } finally {
      setSending(false);
    }
  };

  const confirm = async () => {
    if (!/^\d{6}$/.test(code)) {
      setError(t("குறியீட்டின் 6 இலக்கங்களையும் உள்ளிடவும்.", "Enter all 6 digits of the code."));
      codeRef.current?.focus();
      return;
    }
    setConfirming(true);
    setError("");
    try {
      const data = await post("/account/phone-verify-confirm", { code });
      await refresh();
      toast.success(t("உங்கள் கைபேசி எண் சரிபார்க்கப்பட்டது.", data?.message ?? "Your mobile number is verified."));
      setStage("idle");
      setCode("");
      setNotice("");
      setCooldownUntil(0);
    } catch (err) {
      const left = err.data?.attemptsLeft;
      let message = err.fields?.code || err.message;
      if (typeof left === "number" && left > 0) {
        message = t(
          `குறியீடு சரியில்லை. இன்னும் ${left} முயற்சி மீதம்.`,
          `${message} ${left} ${left === 1 ? "attempt" : "attempts"} left.`,
        );
      } else if (left === 0) {
        message = t("பல தவறான முயற்சிகள். புதிய குறியீட்டைக் கேளுங்கள்.", message);
        setCooldownUntil(0);
      }
      setError(message);
      pendingFocus.current = "select";
    } finally {
      setConfirming(false);
    }
  };

  let content;
  if (edited) {
    content = (
      <p className="acct-phone__note">
        {savedDigits && formDigits.endsWith(savedDigits)
          ? t(
              "நாட்டுக் குறியீட்டுடன் எண் சேமிக்கப்பட, விவரங்களை ஒருமுறை சேமியுங்கள்; பிறகு சரிபார்க்கலாம்.",
              "Save your details once so the number is stored with its country code, then verify it.",
            )
          : t(
              "புதிய எண்ணைச் சரிபார்க்க, முதலில் விவரங்களைச் சேமியுங்கள்.",
              "Save your details first, then verify the new number.",
            )}
      </p>
    );
  } else if (verified) {
    content = (
      <p className="acct-phone__note">
        {t(
          "சேவை பதிவு செய்திகளும் நினைவூட்டல்களும் இந்த எண்ணுக்கு குறுஞ்செய்தி, WhatsApp வழியாக வரலாம்.",
          "Booking updates and reminders can reach this number by text message and WhatsApp.",
        )}
      </p>
    );
  } else if (stage === "idle") {
    content = (
      <>
        <p className="acct-phone__note">
          {t(
            "இந்த எண் உங்களுடையது என உறுதிசெய்ய, அதற்கு ஒரு 6 இலக்கக் குறியீடு அனுப்புவோம்.",
            "Confirm this number is yours with a 6-digit code we send to it.",
          )}
        </p>
        <Button
          ref={focusRef}
          variant="soft"
          size="sm"
          onClick={start}
          loading={sending}
          disabled={waitSeconds > 0}
          icon={<LuSmartphone aria-hidden="true" />}
        >
          {waitSeconds > 0
            ? t(`எண்ணைச் சரிபார்க்க (${clock(waitSeconds)})`, `Verify number (${clock(waitSeconds)})`)
            : t("எண்ணைச் சரிபார்க்க", "Verify number")}
        </Button>
        {error && (
          <p className="acct-phone__error" role="alert">
            {error}
          </p>
        )}
      </>
    );
  } else {
    content = (
      <>
        <p className="acct-phone__note" role="status">
          {notice}
        </p>
        <Field label={t("6 இலக்கக் குறியீடு", "6-digit code")} required error={error}>
          {(a11y) => (
            <input
              {...a11y}
              ref={(node) => {
                codeRef.current = node;
                if (focusRef) focusRef.current = node;
              }}
              className="acct-phone__code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D+/g, "").slice(0, 6))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirm();
                }
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              disabled={confirming}
            />
          )}
        </Field>
        <div className="acct-phone__actions">
          <Button variant="primary" size="sm" onClick={confirm} loading={confirming} icon={<LuBadgeCheck aria-hidden="true" />}>
            {t("உறுதிசெய்", "Confirm code")}
          </Button>
          <Button variant="ghost" size="sm" onClick={start} loading={sending} disabled={waitSeconds > 0 || confirming}>
            {waitSeconds > 0
              ? t(`${clock(waitSeconds)} பிறகு மீண்டும் அனுப்பலாம்`, `Resend code in ${clock(waitSeconds)}`)
              : t("குறியீட்டை மீண்டும் அனுப்பு", "Resend code")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="acct-phone" role="group" aria-labelledby={titleId}>
      <div className="acct-phone__head">
        <span id={titleId} className="acct-phone__title">
          {t("கைபேசி எண் சரிபார்ப்பு", "Mobile number verification")}
        </span>
        {!edited &&
          (verified ? (
            <Badge tone="sage" className="acct-phone__badge">
              <LuBadgeCheck aria-hidden="true" /> {t("சரிபார்க்கப்பட்டது", "Verified")}
            </Badge>
          ) : (
            <Badge tone="warning" className="acct-phone__badge">
              {t("சரிபார்க்கப்படவில்லை", "Not verified")}
            </Badge>
          ))}
      </div>
      {content}
    </div>
  );
}
