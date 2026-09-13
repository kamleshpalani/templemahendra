import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LuBadgeCheck,
  LuBell,
  LuCalendarCheck,
  LuCalendarDays,
  LuClock,
  LuCreditCard,
  LuFlame,
  LuGift,
  LuHandHeart,
  LuHeartHandshake,
  LuLandmark,
  LuLanguages,
  LuLock,
  LuMail,
  LuMegaphone,
  LuMessageCircle,
  LuMessageSquare,
  LuPartyPopper,
  LuSave,
  LuShieldCheck,
  LuSiren,
  LuSmartphone,
  LuSparkles,
} from "react-icons/lu";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import Alert from "../ui/Alert";
import { Field, Switch } from "../ui/Field";
import { EmptyState, ErrorState, SkeletonText } from "../ui/Feedback";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { useToast } from "../../context/ToastContext";
import usePushSubscription, { useCsrfPost } from "../../hooks/usePushSubscription";
import "./NotificationPreferences.css";

/**
 * NotificationPreferences — the "Notifications" tab of /account
 * (docs/notifications/SPEC.md §7.4). Reads and saves /api/notifications/prefs.
 *
 *   <NotificationPreferences onTab={(tab, { focus }) => …} onDirtyChange={setDirty} />
 *
 * The page edits a draft and saves it in one go, rather than saving every
 * switch as it is flipped: a devotee working through the list should be able to
 * change their mind, and one request means one "saved" message instead of ten.
 * Only what differs from the saved copy is sent, so an untouched field is never
 * re-asserted — that matters for email, where the server treats "email on" as
 * "resume emails I unsubscribed from".
 *
 * Push is the exception. Turning it on for this device asks the browser for
 * permission, which must happen inside the click, so it acts at once.
 */

const CHANNELS = ["inapp", "email", "whatsapp", "sms", "push"];

/** Category icon names from notification_categories.icon (Lucide names). */
const CATEGORY_ICONS = {
  bell: LuBell,
  megaphone: LuMegaphone,
  "party-popper": LuPartyPopper,
  flame: LuFlame,
  "calendar-days": LuCalendarDays,
  sparkles: LuSparkles,
  "calendar-check": LuCalendarCheck,
  "heart-handshake": LuHeartHandshake,
  "credit-card": LuCreditCard,
  "hand-heart": LuHandHeart,
  "badge-check": LuBadgeCheck,
  landmark: LuLandmark,
  siren: LuSiren,
  "shield-check": LuShieldCheck,
  gift: LuGift,
};

/**
 * Time zones most of the temple's devotees live in, following the country map
 * in the service (SPEC §5.1) plus a few large cities in the same countries.
 */
const COMMON_ZONES = [
  "Asia/Kolkata",
  "Asia/Colombo",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Qatar",
  "Asia/Kuwait",
  "Asia/Muscat",
  "Asia/Bahrain",
  "Asia/Hong_Kong",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Africa/Johannesburg",
  "Indian/Mauritius",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "America/Vancouver",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Perth",
  "Pacific/Auckland",
  "Pacific/Fiji",
];

/*
 * Browsers still report some old IANA names (Chrome on Windows says
 * "Asia/Calcutta"). PHP's timezone_identifiers_list(), which the server checks
 * against, only knows the current ones, so the detected zone is translated
 * before it is offered.
 */
const ZONE_ALIASES = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",
  GMT: "UTC",
};

function detectedZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? (ZONE_ALIASES[zone] ?? zone) : null;
  } catch {
    return null;
  }
}

/** "Kolkata (UTC+5:30)", or null for a name this browser does not know. */
function zoneLabel(zone) {
  if (!zone) return null;
  let offset = "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date());
    offset = (parts.find((p) => p.type === "timeZoneName")?.value ?? "").replace(/^GMT/, "UTC");
  } catch {
    return null;
  }
  const city = zone === "UTC" ? "UTC" : zone.split("/").pop().replace(/_/g, " ");
  return offset && offset !== city ? `${city} (${offset})` : city;
}

/** The editable part of the prefs, in a shape two copies can be compared in. */
function toDraft(prefs) {
  return {
    lang: prefs?.lang ?? "ta",
    timezone: prefs?.timezone ?? "",
    channels: CHANNELS.reduce((acc, c) => ({ ...acc, [c]: prefs?.channels?.[c] !== false }), {}),
    muted: [...(prefs?.muted ?? [])].sort(),
    promotional: !!prefs?.promotional,
    unsubscribed: !!prefs?.unsubscribed,
  };
}

const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Where the save bar floats: the phone and tablet layout, which has the bottom navigation. */
const FLOAT_QUERY = "(max-width: 768px)";

/** Only what changed, so nothing untouched is re-asserted on the server. */
function changesBetween(saved, draft) {
  const body = {};
  if (draft.lang !== saved.lang) body.lang = draft.lang;
  if (draft.timezone !== saved.timezone) body.timezone = draft.timezone || null;
  const channels = {};
  for (const c of CHANNELS) if (draft.channels[c] !== saved.channels[c]) channels[c] = draft.channels[c];
  if (Object.keys(channels).length) body.channels = channels;
  if (!sameDraft(draft.muted, saved.muted)) body.muted = draft.muted;
  if (draft.promotional !== saved.promotional) body.promotional = draft.promotional;
  if (draft.unsubscribed !== saved.unsubscribed) body.unsubscribed = draft.unsubscribed;
  return body;
}

export default function NotificationPreferences({ onTab, onDirtyChange }) {
  const { t, lang } = useLang();
  const { get, user } = useAuth();
  const post = useCsrfPost();
  const toast = useToast();
  const ids = useId();

  const [status, setStatus] = useState("loading"); // loading | ready | error | disabled
  const [payload, setPayload] = useState(null);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const formId = `${ids}-form`;
  const formRef = useRef(null);
  const slotRef = useRef(null);
  const barRef = useRef(null);
  const statusRef = useRef(null);
  const barHeight = useRef(64);
  const floatingNow = useRef(false);
  const restoreFocus = useRef(false);
  // null while the bar sits at the end of the form; { left, right, bottom } in px while it floats.
  const [float, setFloat] = useState(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const data = await get("/notifications/prefs");
      const d = toDraft(data.prefs);
      setPayload(data);
      setSaved(d);
      setDraft(d);
      setFieldErrors({});
      setStatus("ready");
    } catch (err) {
      setStatus(err?.status === 503 ? "disabled" : "error");
    }
  }, [get]);

  useEffect(() => {
    load();
  }, [load]);

  /** After a device is added or removed: the counts change, the draft must not. */
  const refreshAvailability = useCallback(async () => {
    try {
      const data = await get("/notifications/prefs");
      setPayload((p) => (p ? { ...p, channels: data.channels, phone: data.phone } : data));
    } catch {
      /* the counts are informational; the next visit shows them */
    }
  }, [get]);

  const dirty = status === "ready" && !!draft && !!saved && !sameDraft(draft, saved);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Closing the tab or reloading with unsaved changes: the browser's own prompt.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /*
   * The save bar floats while there are unsaved changes on a phone or tablet, so
   * Save is never a long scroll away.
   *
   * Not `position: sticky`: base.css gives both <html> and <body> overflow-x:
   * hidden, which turns <body> into a scroll container that never scrolls, and
   * no sticky element on the site can stick. Not a plain `position: fixed`
   * either: the page-transition wrapper keeps a transform after its entrance
   * animation, which makes it the containing block (the same trap Modal.jsx
   * portals around). So the bar is measured against the viewport and, while it
   * floats, rendered into <body> through a portal. An empty slot keeps its height
   * in the form, and the Save button reaches the form through its `form` attribute.
   *
   * It floats only while the form is on screen and its end is not, sits just above
   * the bottom navigation (measured, not assumed), and never moves while focus is
   * inside it — swapping the element under a keyboard user would drop their focus.
   */
  useEffect(() => {
    floatingNow.current = float !== null;
  }, [float]);

  useEffect(() => {
    if (!dirty && !saving) {
      setFloat(null);
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const form = formRef.current;
      const slot = slotRef.current;
      if (!form || !slot) return;
      const bar = barRef.current;
      if (bar?.offsetHeight) barHeight.current = bar.offsetHeight;
      if (floatingNow.current && bar && bar.contains(document.activeElement)) return;

      const small = window.matchMedia?.(FLOAT_QUERY).matches ?? false;
      const vh = window.innerHeight;
      const nav = document.querySelector(".bottom-nav");
      const navRect = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect() : null;
      const inset = navRect && navRect.height > 0 ? Math.max(16, vh - navRect.top + 8) : 16;
      const limit = vh - inset;
      const formRect = form.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      const shouldFloat = small && formRect.top < limit - barHeight.current && slotRect.top + barHeight.current > limit;

      if (!shouldFloat) {
        setFloat(null);
        return;
      }
      const next = {
        left: Math.round(slotRect.left),
        right: Math.round(document.documentElement.clientWidth - slotRect.right),
        bottom: Math.round(inset),
      };
      setFloat((prev) =>
        prev && prev.left === next.left && prev.right === next.right && prev.bottom === next.bottom ? prev : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (formRef.current) observer?.observe(formRef.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [dirty, saving]);

  // After a save from the bar, Save is disabled (nothing left to save) and a
  // floating bar returns to the form, so the focused button disappears. Put
  // focus on the bar's status line, which now reads "All changes saved".
  // Waits for the bar to be back in the form: the save's own render still shows
  // the floating copy, which is removed one render later.
  useEffect(() => {
    if (!restoreFocus.current || saving || float !== null) return;
    restoreFocus.current = false;
    statusRef.current?.focus({ preventScroll: true });
  }, [saving, float]);

  const setChannel = (channel, on) => setDraft((d) => ({ ...d, channels: { ...d.channels, [channel]: on } }));
  const setMuted = (key, muted) =>
    setDraft((d) => {
      const next = new Set(d.muted);
      if (muted) next.add(key);
      else next.delete(key);
      return { ...d, muted: [...next].sort() };
    });

  const categories = payload?.categories ?? [];
  const promotionalKeys = useMemo(
    () => categories.filter((c) => c.kind === "promotional").map((c) => c.key),
    [categories],
  );

  const setPromotional = (on) =>
    setDraft((d) => ({
      ...d,
      promotional: on,
      // Consenting while a promotional topic is switched off would do nothing,
      // and nobody ticks "yes, send me offers" meaning "but not those".
      muted: on ? d.muted.filter((k) => !promotionalKeys.includes(k)) : d.muted,
    }));

  const discard = () => {
    setDraft(saved);
    setFieldErrors({});
  };

  const save = async (e) => {
    e?.preventDefault();
    if (!dirty || saving) return;
    restoreFocus.current = !!barRef.current?.contains(document.activeElement);
    setSaving(true);
    setFieldErrors({});
    try {
      const data = await post("/notifications/prefs", changesBetween(saved, draft));
      const d = toDraft(data.prefs);
      setSaved(d);
      setDraft(d);
      setPayload((p) => ({ ...p, prefs: data.prefs }));
      toast.success(t("உங்கள் அறிவிப்பு அமைப்புகள் சேமிக்கப்பட்டன.", data.message ?? "Your notification settings are saved."));
    } catch (err) {
      // Still unsaved, so the bar and its focused Save button stay where they are.
      restoreFocus.current = false;
      setFieldErrors(err.fields ?? {});
      toast.error(
        err.status === 422
          ? t("சில அமைப்புகளைச் சேமிக்க முடியவில்லை. குறிக்கப்பட்டவற்றைச் சரிபார்க்கவும்.", err.message)
          : err.message,
      );
    } finally {
      setSaving(false);
    }
  };

  /* ── States before the form ─────────────────────────────────────────── */

  if (status === "loading") {
    return (
      <div className="np np--loading" aria-busy="true">
        <span className="sr-only" role="status">
          {t("அறிவிப்பு அமைப்புகள் ஏற்றப்படுகின்றன…", "Loading your notification settings…")}
        </span>
        <div className="np__grid">
          <div className="card card--solid card--static np-section">
            <SkeletonText lines={5} />
          </div>
          <div className="card card--solid card--static np-section">
            <SkeletonText lines={5} />
          </div>
        </div>
      </div>
    );
  }
  if (status === "disabled") {
    return (
      <EmptyState icon={<LuBell />} title={t("அறிவிப்புகள் இன்னும் இல்லை", "Notifications are not switched on yet")}>
        {t(
          "இந்தத் தளத்தில் அறிவிப்புகள் இன்னும் அமைக்கப்படவில்லை. விரைவில் இங்கே உங்கள் விருப்பங்களைத் தேர்வு செய்யலாம்.",
          "The temple has not set up notifications on this site yet. Your choices will appear here once it has.",
        )}
      </EmptyState>
    );
  }
  if (status === "error" || !payload || !draft) {
    return (
      <ErrorState onRetry={load}>
        {t("அறிவிப்பு அமைப்புகளை ஏற்ற முடியவில்லை.", "We could not load your notification settings just now.")}
      </ErrorState>
    );
  }

  /* ── The form ───────────────────────────────────────────────────────── */

  const ch = payload.channels ?? {};
  const phoneNumber = payload.phone?.number ?? null;

  /** Plain words for the API's availability reasons. */
  const reasonText = (reason) => {
    switch (reason) {
      case "no phone":
        return t("இதைப் பெற உங்கள் விவரங்களில் கைபேசி எண்ணைச் சேர்க்கவும்.", "Add a mobile number to your details to use this.");
      case "no email":
        return t("உங்கள் கணக்கில் மின்னஞ்சல் முகவரி இல்லை.", "Your account has no email address.");
      case "not configured":
        return t("இன்னும் கிடைக்கவில்லை. கோயில் இதை இன்னும் அமைக்கவில்லை.", "Not available yet. The temple has not set this up.");
      default:
        return t("இப்போது கிடைக்கவில்லை.", "Not available right now.");
    }
  };

  const channelError = fieldErrors.channels;
  const categoryError = fieldErrors.muted;
  const promoError = fieldErrors.promotional ?? fieldErrors.unsubscribed;

  const phoneAction = (focus, label) => (
    <Button
      variant="soft"
      size="sm"
      className="np-row__action"
      icon={<LuSmartphone aria-hidden="true" />}
      onClick={() => onTab?.("profile", { focus })}
    >
      {label}
    </Button>
  );

  /** One channel row: switch, what it means or why it cannot be used, and a way to fix it. */
  const channelRow = (channel, icon, label, note, extra = {}) => {
    const info = ch[channel] ?? { available: false, reason: "not configured" };
    const available = channel === "inapp" ? true : !!info.available;
    return (
      <li className="np-row" data-channel={channel} key={channel}>
        <span className="np-row__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="np-row__body">
          <Switch
            label={label}
            description={available ? note : reasonText(info.reason)}
            // An unusable channel is shown off, whatever was saved, because
            // nothing would arrive on it — and the saved value is left alone.
            checked={available && draft.channels[channel]}
            disabled={!available || saving}
            onChange={(e) => setChannel(channel, e.target.checked)}
          />
          {extra.children}
        </div>
        {extra.action ?? null}
      </li>
    );
  };

  const whatsappNote = phoneNumber
    ? t(`சேவை பதிவு செய்திகளும் நினைவூட்டல்களும் ${phoneNumber} எண்ணுக்கு WhatsApp-இல்.`, `Booking updates and reminders on WhatsApp to ${phoneNumber}.`)
    : t("சேவை பதிவு செய்திகளும் நினைவூட்டல்களும் WhatsApp-இல்.", "Booking updates and reminders on WhatsApp.");

  const phoneFixAction = (info) => {
    if (!info) return null;
    if (info.reason === "no phone") return phoneAction("phone", t("கைபேசி எண் சேர்க்க", "Add a phone number"));
    if (info.available && !info.verified) return phoneAction("verify", t("எண்ணைச் சரிபார்க்க", "Verify number"));
    return null;
  };
  const unverifiedNote = (info) =>
    info?.available && !info.verified ? (
      <p className="np-row__note np-row__note--warn">
        {t(
          "உங்கள் எண் இன்னும் சரிபார்க்கப்படவில்லை. சரிபார்த்தால் நீங்கள் ஒப்புக்கொண்ட சலுகைச் செய்திகளும் இதில் வரும்.",
          "Your number is not verified yet. Verify it so offers you agree to can reach it too.",
        )}
      </p>
    ) : null;

  const emailInfo = ch.email;
  const emailNote = [
    user?.email ?? "",
    emailInfo?.available && !emailInfo.verified
      ? t("கோயில் அறிவிப்புகளை மின்னஞ்சலில் பெற முகவரியை உறுதிப்படுத்துங்கள்.", "Confirm your address to also get temple announcements by email.")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const zones = (() => {
    const detected = detectedZone();
    const detectedValid = detected && zoneLabel(detected) ? detected : null;
    const common = COMMON_ZONES.filter((z) => z !== detectedValid);
    if (draft.timezone && draft.timezone !== detectedValid && !common.includes(draft.timezone)) common.unshift(draft.timezone);
    return { detected: detectedValid, common };
  })();
  const automaticLabel =
    saved.timezone === "" && payload.prefs?.effectiveTimezone
      ? t(
          `என் நாட்டின்படி தானாக — இப்போது ${zoneLabel(payload.prefs.effectiveTimezone) ?? payload.prefs.effectiveTimezone}`,
          `Automatic from my country — now ${zoneLabel(payload.prefs.effectiveTimezone) ?? payload.prefs.effectiveTimezone}`,
        )
      : t("என் நாட்டின்படி தானாக", "Automatic from my country");

  const lockReason = (kind) => {
    if (kind === "security") return t("உங்கள் கணக்கைப் பாதுகாக்கிறது, அதனால் நிறுத்த முடியாது.", "Keeps your account safe, so it cannot be switched off.");
    if (kind === "critical") return t("அவசர அறிவிப்புகள் அனைவருக்கும் செல்லும்.", "Emergency notices from the temple reach everyone.");
    return t("நீங்கள் கேட்டவற்றின் உறுதிப்படுத்தல்களும் ரசீதுகளும்.", "Confirmations and receipts for things you asked for.");
  };

  return (
    <form ref={formRef} id={formId} className="np" onSubmit={save} noValidate aria-labelledby={`${ids}-heading`}>
      <h2 id={`${ids}-heading`} className="sr-only">
        {t("அறிவிப்பு அமைப்புகள்", "Notification settings")}
      </h2>

      <div className="np__grid">
        {/* ── Channels ───────────────────────────────────────────────── */}
        <section className="card card--solid card--static np-section" aria-labelledby={`${ids}-channels`}>
          <h3 id={`${ids}-channels`} className="np-section__title">
            <LuBell aria-hidden="true" />
            {t("செய்திகள் எப்படி வர வேண்டும்", "How we reach you")}
          </h3>
          <p className="np-section__lead">
            {t(
              "பாதுகாப்பு மற்றும் அவசரச் செய்திகள் இந்த அமைப்புகளைப் பொருட்படுத்தாமல் வரலாம்.",
              "Security and emergency messages can still reach you whatever you choose here.",
            )}
          </p>
          {channelError && (
            <Alert tone="danger" className="np-alert">
              {channelError}
            </Alert>
          )}
          <ul className="np-list">
            {channelRow(
              "inapp",
              <LuBell />,
              t("இணையதளத்தில் (மணி)", "On this website (the bell)"),
              t("தளத்தின் மேலே உள்ள அறிவிப்பு மணியில் செய்திகள் தெரியும்.", "Messages appear under the bell at the top of the site."),
            )}
            {channelRow("email", <LuMail />, t("மின்னஞ்சல்", "Email"), emailNote, {
              children:
                draft.unsubscribed && draft.channels.email && emailInfo?.available ? (
                  <div className="np-inline">
                    <p className="np-row__note np-row__note--warn">
                      {t(
                        "கோயில் அறிவிப்பு மின்னஞ்சல்களிலிருந்து விலகியுள்ளீர்கள். உறுதிப்படுத்தல்களும் ரசீதுகளும் தொடர்ந்து வரும்.",
                        "You unsubscribed from announcement emails. Confirmations and receipts still arrive.",
                      )}
                    </p>
                    <Button variant="soft" size="sm" onClick={() => setDraft((d) => ({ ...d, unsubscribed: false }))}>
                      {t("அறிவிப்பு மின்னஞ்சல்களை மீண்டும் பெற", "Resume announcement emails")}
                    </Button>
                  </div>
                ) : saved.unsubscribed && !draft.unsubscribed ? (
                  <p className="np-row__note">
                    {t("சேமித்தவுடன் அறிவிப்பு மின்னஞ்சல்கள் மீண்டும் வரும்.", "Announcement emails resume when you save.")}
                  </p>
                ) : null,
            })}
            {channelRow("whatsapp", <LuMessageCircle />, "WhatsApp", whatsappNote, {
              children: unverifiedNote(ch.whatsapp),
              action: phoneFixAction(ch.whatsapp),
            })}
            {channelRow(
              "sms",
              <LuMessageSquare />,
              t("குறுஞ்செய்தி (SMS)", "Text message (SMS)"),
              t(
                "முக்கியமானவற்றுக்கு மட்டும், உதாரணமாக ரத்தான சேவை பதிவு.",
                "Kept for important things only, such as a cancelled booking.",
              ),
              { children: unverifiedNote(ch.sms), action: phoneFixAction(ch.sms) },
            )}
            {channelRow(
              "push",
              <LuSmartphone />,
              t("புஷ் அறிவிப்புகள்", "Push notifications"),
              t("கீழே நீங்கள் இயக்கும் சாதனங்களில், தளம் மூடியிருந்தாலும்.", "On the devices you turn on below, even with the site closed."),
              {
                children: ch.push?.available ? (
                  <PushDevice
                    publicKey={ch.push.publicKey}
                    devices={ch.push.devices ?? 0}
                    pushOn={draft.channels.push}
                    onChanged={refreshAvailability}
                  />
                ) : null,
              },
            )}
          </ul>
        </section>

        {/* ── Categories ─────────────────────────────────────────────── */}
        <section className="card card--solid card--static np-section" aria-labelledby={`${ids}-topics`}>
          <h3 id={`${ids}-topics`} className="np-section__title">
            <LuSparkles aria-hidden="true" />
            {t("எதைப் பற்றி", "What about")}
          </h3>
          <p className="np-section__lead">
            {t(
              "ஒரு தலைப்பை நிறுத்தினால் அது எல்லா வழிகளிலும் நிற்கும் — அவசரமானவை தவிர.",
              "Switching a topic off stops it on every channel, except for urgent notices.",
            )}
          </p>
          {categoryError && (
            <Alert tone="danger" className="np-alert">
              {categoryError}
            </Alert>
          )}
          <ul className="np-list">
            {categories.map((c) => {
              const Icon = CATEGORY_ICONS[c.icon] ?? LuBell;
              const label = lang === "ta" ? c.label?.ta || c.label?.en : c.label?.en || c.label?.ta;
              if (!c.mutable) {
                return (
                  <li className="np-row np-row--locked" data-category={c.key} key={c.key}>
                    <span className="np-row__icon" aria-hidden="true">
                      <Icon />
                    </span>
                    <div className="np-row__body">
                      <span className="np-row__label">{label}</span>
                      <span className="np-row__note">{lockReason(c.kind)}</span>
                    </div>
                    <Badge tone="muted" className="np-lock">
                      <LuLock aria-hidden="true" />
                      {t("எப்போதும் இயக்கத்தில்", "Always on")}
                    </Badge>
                  </li>
                );
              }
              const promo = c.kind === "promotional";
              const muted = draft.muted.includes(c.key);
              return (
                <li className="np-row" data-category={c.key} key={c.key}>
                  <span className="np-row__icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <div className="np-row__body">
                    <Switch
                      label={label}
                      description={
                        promo && !draft.promotional
                          ? t("கீழே உங்கள் ஒப்புதல் தேவை.", "Needs your consent below.")
                          : undefined
                      }
                      checked={promo ? draft.promotional && !muted : !muted}
                      disabled={saving || (promo && !draft.promotional)}
                      onChange={(e) => setMuted(c.key, !e.target.checked)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── Language and time zone ─────────────────────────────────── */}
        <section className="card card--solid card--static np-section" aria-labelledby={`${ids}-locale`}>
          <h3 id={`${ids}-locale`} className="np-section__title">
            <LuLanguages aria-hidden="true" />
            {t("மொழியும் நேரமும்", "Language and time")}
          </h3>
          <Field
            label={t("செய்திகளின் மொழி", "Language for your messages")}
            hint={t(
              "மின்னஞ்சல், குறுஞ்செய்தி, மணி எல்லாம் இந்த மொழியில். தளத்தின் மொழி மாற்றி தனி.",
              "Emails, texts and the bell use this language. The site's own language switch is separate.",
            )}
            error={fieldErrors.lang}
          >
            {(a11y) => (
              <select
                {...a11y}
                value={draft.lang}
                disabled={saving}
                onChange={(e) => setDraft((d) => ({ ...d, lang: e.target.value }))}
              >
                {(payload.languages ?? []).map((l) => (
                  <option key={l.code} value={l.code} lang={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label={t("நேர மண்டலம்", "Time zone")}
            hint={t("நினைவூட்டல்கள் இந்த நேரப்படி அனுப்பப்படும்.", "Reminders and scheduled messages are timed for this zone.")}
            error={fieldErrors.timezone}
          >
            {(a11y) => (
              <select
                {...a11y}
                value={draft.timezone}
                disabled={saving}
                onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
              >
                <option value="">{automaticLabel}</option>
                {zones.detected && (
                  <optgroup label={t("இந்தச் சாதனத்தின் நேரம்", "Detected on this device")}>
                    <option value={zones.detected}>{zoneLabel(zones.detected)}</option>
                  </optgroup>
                )}
                <optgroup label={t("பொதுவான நேர மண்டலங்கள்", "Common time zones")}>
                  {zones.common.map((z) => (
                    <option key={z} value={z}>
                      {zoneLabel(z) ?? z}
                    </option>
                  ))}
                </optgroup>
              </select>
            )}
          </Field>
          <p className="np-row__note np-locale-note">
            <LuClock aria-hidden="true" />
            {t("தளத்தில் நேரங்கள் உங்கள் உலாவியின் நேரப்படி காட்டப்படும்.", "Times on this site are shown in your browser's own time.")}
          </p>
        </section>

        {/* ── Promotional consent ────────────────────────────────────── */}
        <section className="card card--solid card--static np-section" aria-labelledby={`${ids}-promo`}>
          <h3 id={`${ids}-promo`} className="np-section__title">
            <LuGift aria-hidden="true" />
            {t("சலுகைகளும் விளம்பரங்களும்", "Offers and promotions")}
          </h3>
          <p className="np-section__lead" id={`${ids}-promo-lead`}>
            {t(
              "நீங்கள் தேர்வு செய்யும் வரை கோயில் உங்களுக்குச் சலுகைச் செய்திகள் அனுப்பாது. எப்போது வேண்டுமானாலும் இதை நிறுத்தலாம்.",
              "The temple sends no offers or promotional messages unless you tick this. You can take it back at any time.",
            )}
          </p>
          {promoError && (
            <Alert tone="danger" className="np-alert">
              {promoError}
            </Alert>
          )}
          <label className="checkbox-label np-consent" htmlFor={`${ids}-promo-box`}>
            <input
              id={`${ids}-promo-box`}
              type="checkbox"
              checked={draft.promotional}
              disabled={saving}
              aria-describedby={`${ids}-promo-lead`}
              onChange={(e) => setPromotional(e.target.checked)}
            />
            <span>
              {t(
                "ஆம், கோயிலின் சலுகைகள், சிறப்பு நிகழ்வுகள், விளம்பரச் செய்திகளை எனக்கு அனுப்புங்கள்.",
                "Yes, send me offers, special events and promotional messages from the temple.",
              )}
            </span>
          </label>
        </section>
      </div>

      {/* ── Save ─────────────────────────────────────────────────────── */}
      <div ref={slotRef} className="np-savebar-slot" style={float ? { "--np-slot-h": `${barHeight.current}px` } : undefined}>
        {float === null && (
          <SaveBar
            barRef={barRef}
            statusRef={statusRef}
            formId={formId}
            dirty={dirty}
            saving={saving}
            onDiscard={discard}
          />
        )}
      </div>
      {float !== null &&
        createPortal(
          <SaveBar
            barRef={barRef}
            statusRef={statusRef}
            formId={formId}
            dirty={dirty}
            saving={saving}
            onDiscard={discard}
            float={float}
          />,
          document.body,
        )}
    </form>
  );
}

/**
 * The save bar: what state the settings are in, Discard and Save. Rendered in
 * the form, or into <body> while it floats (see the effect above), so Save names
 * its form by id instead of relying on being inside it.
 */
function SaveBar({ barRef, statusRef, formId, dirty, saving, onDiscard, float = null }) {
  const { t } = useLang();
  return (
    <div
      ref={barRef}
      className={`np-savebar${dirty ? " np-savebar--dirty" : ""}${float ? " np-savebar--floating" : ""}`}
      role="region"
      aria-label={t("அறிவிப்பு அமைப்புகளைச் சேமி", "Save notification settings")}
      style={
        float
          ? { "--np-bar-left": `${float.left}px`, "--np-bar-right": `${float.right}px`, "--np-bar-bottom": `${float.bottom}px` }
          : undefined
      }
    >
      <p ref={statusRef} className="np-savebar__status" role="status" tabIndex={-1}>
        <span className="np-savebar__dot" aria-hidden="true" />
        {saving
          ? t("சேமிக்கிறது…", "Saving…")
          : dirty
            ? t("சேமிக்கப்படாத மாற்றங்கள்", "Unsaved changes")
            : t("எல்லாம் சேமிக்கப்பட்டது", "All changes saved")}
      </p>
      <div className="np-savebar__actions">
        {dirty && (
          <Button variant="ghost" size="sm" onClick={onDiscard} disabled={saving}>
            {t("நீக்கு", "Discard")}
          </Button>
        )}
        <Button
          type="submit"
          form={formId}
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!dirty}
          icon={<LuSave aria-hidden="true" />}
        >
          {t("சேமி", "Save changes")}
        </Button>
      </div>
    </div>
  );
}

/* ── Push on this device ───────────────────────────────────────────────── */

function PushDevice({ publicKey, devices, pushOn, onChanged }) {
  const { t } = useLang();
  const toast = useToast();
  const push = usePushSubscription(publicKey);

  const turnOn = async () => {
    if (await push.subscribe()) {
      toast.success(t("இந்தச் சாதனத்தில் அறிவிப்புகள் இயக்கப்பட்டன.", "Notifications are on for this device."));
      onChanged?.();
    }
  };
  const turnOff = async () => {
    if (await push.unsubscribe()) {
      toast.info(t("இந்தச் சாதனத்தில் அறிவிப்புகள் நிறுத்தப்பட்டன.", "Notifications are off for this device."));
      onChanged?.();
    }
  };

  const errorText = (err) => {
    if (!err) return null;
    if (err.code === "dismissed") {
      return t(
        "அனுமதி கேட்கும் சாளரம் அனுமதி தராமல் மூடப்பட்டது. தயாரானதும் மீண்டும் முயலுங்கள்.",
        "The permission prompt closed without allowing notifications. Try again when you are ready.",
      );
    }
    if (err.code === "subscribe-failed") {
      return t(
        "இந்த உலாவியில் புஷ் அறிவிப்புகளை அமைக்க முடியவில்லை. மீண்டும் முயலுங்கள்.",
        "This browser could not set up push notifications. Please try again.",
      );
    }
    if (err.code === "unsubscribe-failed") {
      return t("இந்தச் சாதனத்தை நிறுத்த முடியவில்லை. மீண்டும் முயலுங்கள்.", "We could not turn this device off. Please try again.");
    }
    return err.message;
  };

  let body;
  if (push.checking) {
    body = (
      <p className="np-row__note" role="status">
        {t("இந்த உலாவியைச் சரிபார்க்கிறது…", "Checking this browser…")}
      </p>
    );
  } else if (push.reason === "ios-install-required") {
    body = (
      <Alert tone="info" title={t("முதலில் கோயில் செயலியை முகப்புத் திரையில் சேர்க்கவும்", "Add the temple app to your Home Screen first")}>
        {t(
          "iPhone, iPad-இல் நிறுவிய செயலியிலிருந்து மட்டுமே அறிவிப்புகள் வரும்: Safari-இல் பகிர் (Share) பொத்தானைத் தட்டி “Add to Home Screen” தேர்வு செய்யுங்கள், பிறகு முகப்புத் திரையிலிருந்து திறந்து இங்கே இயக்குங்கள்.",
          "On iPhone and iPad, notifications only work from the installed app: in Safari tap Share, choose “Add to Home Screen”, then open the temple app from your Home Screen and turn them on here.",
        )}
      </Alert>
    );
  } else if (push.reason === "unsupported") {
    body = (
      <p className="np-row__note">
        {t(
          "இந்த உலாவியால் புஷ் அறிவிப்புகளைப் பெற முடியாது. Chrome, Edge, Firefox அல்லது Safari-இல் முயலுங்கள்.",
          "This browser cannot receive push notifications. Try Chrome, Edge, Firefox or Safari.",
        )}
      </p>
    );
  } else if (push.reason === "not-configured") {
    body = (
      <p className="np-row__note">
        {t("இன்னும் கிடைக்கவில்லை. கோயில் இதை இன்னும் அமைக்கவில்லை.", "Not available yet. The temple has not set this up.")}
      </p>
    );
  } else if (push.reason === "service-worker-inactive") {
    body = (
      <Alert tone="info" title={t("இந்த அமர்வில் புஷ் செயல்படவில்லை", "Push is not active in this browser session")}>
        {t(
          "புஷ் அறிவிப்புகளுக்கு தளத்தின் service worker தேவை. வெளியிடப்பட்ட தளத்தில் அது இயங்கும்; மேம்பாட்டு சர்வரில் (vite dev) அது அணைக்கப்பட்டிருப்பதால் இங்கே இயக்க முடியாது. நேரடி தளத்தில் இருந்தால், பக்கத்தை ஒருமுறை மீண்டும் ஏற்றி முயலுங்கள்.",
          "Push needs the site's service worker. It runs on the published site, but the development server (vite dev) switches it off, so push cannot be turned on here. If you are on the live site, reload the page once and try again.",
        )}
      </Alert>
    );
  } else if (push.reason === "denied") {
    body = (
      <Alert tone="warning" title={t("இந்தத் தளத்துக்கு அறிவிப்புகள் தடுக்கப்பட்டுள்ளன", "Notifications are blocked for this site")}>
        <span>
          {t(
            "உங்கள் உலாவியில் இந்தத் தளத்தின் அறிவிப்புகள் தடுக்கப்பட்டுள்ளன. மீண்டும் இயக்க: முகவரிப் பட்டியின் அருகிலுள்ள பூட்டு அல்லது தள அமைப்புகள் குறியைத் தட்டி, Notifications-ஐ “Allow” ஆக மாற்றி, பக்கத்தை மீண்டும் ஏற்றுங்கள்.",
            "Your browser has been told to block notifications from this site. To allow them: select the lock or site-settings icon beside the address, set Notifications to “Allow”, then reload this page.",
          )}
        </span>
        <Button variant="soft" size="sm" onClick={push.recheck}>
          {t("மீண்டும் சரிபார்", "Check again")}
        </Button>
      </Alert>
    );
  } else {
    body = (
      <>
        <div className="np-device__head">
          <span className="np-device__state">
            {push.subscribed ? (
              <Badge tone="success">{t("இந்தச் சாதனத்தில் இயக்கத்தில்", "On for this device")}</Badge>
            ) : (
              <Badge tone="muted">{t("இந்தச் சாதனத்தில் நிறுத்தத்தில்", "Off for this device")}</Badge>
            )}
          </span>
          {push.subscribed ? (
            <Button variant="outline" size="sm" onClick={turnOff} loading={push.busy}>
              {t("இந்தச் சாதனத்தில் நிறுத்து", "Turn off for this device")}
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={turnOn} loading={push.busy} icon={<LuSmartphone aria-hidden="true" />}>
              {t("இந்தச் சாதனத்தில் இயக்கு", "Turn on for this device")}
            </Button>
          )}
        </div>
        {push.subscribed && !pushOn && (
          <p className="np-row__note np-row__note--warn">
            {t(
              "மேலே புஷ் அணைக்கப்பட்டுள்ளது; மீண்டும் இயக்கிச் சேமிக்கும் வரை இந்தச் சாதனத்துக்கு எதுவும் வராது.",
              "Push is switched off above, so this device receives nothing until you switch it back on and save.",
            )}
          </p>
        )}
      </>
    );
  }

  return (
    <div className="np-device" data-push-reason={push.checking ? "checking" : (push.reason ?? "ok")}>
      <p className="np-device__title">
        {t("இந்தச் சாதனம்", "This device")}
        <span className="np-row__note">
          {devices === 1
            ? t("உங்கள் கணக்கில் 1 சாதனம் பதிவு", "1 device on your account")
            : t(`உங்கள் கணக்கில் ${devices} சாதனங்கள் பதிவு`, `${devices} devices on your account`)}
        </span>
      </p>
      {body}
      {push.error && (
        <Alert tone="danger" className="np-alert">
          {errorText(push.error)}
        </Alert>
      )}
    </div>
  );
}
