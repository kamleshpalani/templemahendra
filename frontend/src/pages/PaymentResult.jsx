import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  LuCircleCheck,
  LuCircleX,
  LuClock,
  LuDownload,
  LuHouse,
  LuPhone,
  LuPrinter,
  LuRotateCcw,
  LuTriangleAlert,
  LuWallet,
} from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Alert from "../components/ui/Alert";
import { SkeletonText } from "../components/ui/Feedback";
import StatusBadge from "../components/Payments/StatusBadge";
import PaymentRedirect from "../components/Payments/PaymentRedirect";
import SimulatorBanner from "../components/Payments/SimulatorBanner";
import EmailReceiptForm from "../components/Payments/EmailReceiptForm";
import { useLang, rateLimitInfo, rateLimitMessage } from "../context/LangContext";
import { PRIMARY_CONTACT, formatPhone, telHref } from "../data/temple";
import { clearDonationDraft } from "../lib/donation";
import { formatMoney } from "../lib/money";
import {
  clearLastPayment,
  formatIstDateTime,
  formatPlainDate,
  getJson,
  isOpenStatus,
  isPaidStatus,
  postJson,
  readLastPayment,
  receiptPath,
} from "../lib/payments";
import "../components/Payments/Payments.css";
import "./PaymentResult.css";

/**
 * /payment/result — where CCAvenue sends the donor back to
 * (docs/payments/SPEC.md §7.4).
 *
 * The gateway returns to a PHP endpoint, which decides the truth from the
 * decrypted response and then redirects here with the payable number and its
 * access token. Nothing on this page is taken from the address bar except those
 * two: the status, the amount and the receipt number are read from the API, so
 * an edited URL cannot make a failed payment look successful.
 *
 * A payment that is still being confirmed is polled — every 3 seconds for the
 * first half minute, then every 10 up to three minutes — because a UPI
 * collect request can take that long, and a donor watching a spinner needs the
 * page to change by itself when the money lands.
 */

const POLL_FAST_MS = 3000;
const POLL_SLOW_MS = 10000;
const POLL_FAST_UNTIL = 30000;
const POLL_STOP = 180000;

export default function PaymentResult() {
  const { lang, t } = useLang();
  const [params] = useSearchParams();
  const ref = params.get("ref");
  const token = params.get("t");
  const urlState = params.get("state");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(ref && token));
  const [notFound, setNotFound] = useState(false);
  const [gateway, setGateway] = useState(null);
  const [retryStatus, setRetryStatus] = useState(null); // null | sending | limited | error | network | not_retryable
  const [retryAfter, setRetryAfter] = useState(null);
  const [announcement, setAnnouncement] = useState("");

  const headingRef = useRef(null);
  const startedAt = useRef(Date.now());
  const lastStatus = useRef(null);
  const retrying = useRef(false);
  const last = readLastPayment();

  const load = useCallback(async () => {
    if (!ref || !token) return null;
    const res = await getJson(`/api/payments/status?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`);
    if (res.ok && res.body?.number) {
      setData(res.body);
      setNotFound(false);
      setLoading(false);
      return res.body;
    }
    // A network blip must not turn a real payment into "we could not read it".
    if (res.status !== 0) setNotFound(true);
    setLoading(false);
    return null;
  }, [ref, token]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while the gateway has not made up its mind.
  useEffect(() => {
    if (!data || !isOpenStatus(data.status) || gateway) return undefined;
    const elapsed = Date.now() - startedAt.current;
    if (elapsed > POLL_STOP) return undefined;
    const wait = elapsed < POLL_FAST_UNTIL ? POLL_FAST_MS : POLL_SLOW_MS;
    const timer = setTimeout(load, wait);
    return () => clearTimeout(timer);
  }, [data, gateway, load]);

  // The status is the page's headline, so a change is announced and takes focus.
  useEffect(() => {
    if (!data || data.status === lastStatus.current) return;
    const first = lastStatus.current === null;
    lastStatus.current = data.status;
    if (isPaidStatus(data.status)) {
      clearDonationDraft();
      clearLastPayment();
    }
    headingRef.current?.focus({ preventScroll: true });
    if (!first) {
      setAnnouncement("");
      requestAnimationFrame(() =>
        setAnnouncement(
          isPaidStatus(data.status)
            ? t("கட்டணம் உறுதி செய்யப்பட்டது.", "Your payment is confirmed.")
            : t("கட்டண நிலை மாறியது.", "The payment status has changed."),
        ),
      );
    }
  }, [data, t]);

  const retry = async () => {
    if (retrying.current) return;
    const number = data?.number ?? last?.number;
    const proof = data ? token : last?.token;
    if (!number || !proof) return;
    retrying.current = true;
    setRetryStatus("sending");
    const res = await postJson("/api/payments/retry", { number, token: proof });

    if (res.ok && res.body?.success && res.body.gateway) {
      setGateway(res.body.gateway);
      return;
    }
    retrying.current = false;
    const limited = rateLimitInfo(res.status, res.body, res.retryAfterHeader);
    if (limited) {
      setRetryAfter(limited.retryAfter);
      setRetryStatus("limited");
      return;
    }
    if (res.body?.code === "not_retryable") {
      setRetryStatus("not_retryable");
      load();
      return;
    }
    setRetryStatus(res.status === 0 ? "network" : "error");
  };

  /* ── Framing ─────────────────────────────────────────────────────── */

  const hero = (title) => (
    <>
      <Seo title={title} description={t("கட்டண நிலை", "Payment status")} robots="noindex, nofollow" />
      <PageHero
        variant="donations"
        eyebrow={t("இணையவழிக் கட்டணம்", "Online payment")}
        title={title}
        crumbs={[{ label: t("நன்கொடை", "Donations"), to: "/donations" }, { label: title }]}
      />
    </>
  );

  const page = (title, children) => (
    <>
      {hero(title)}
      <section className="section pay-result-section">
        <div className="container container--narrow">
          <SimulatorBanner simulator={Boolean(data?.simulator)} testMode={Boolean(data?.testMode)} outcome />
          {children}
          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </section>
    </>
  );

  const office = (
    <p className="pay-result__office">
      <LuPhone aria-hidden="true" />
      <span>
        {t("கோயில் அலுவலகம்: ", "Temple office: ")}
        <a href={telHref(PRIMARY_CONTACT.phone)}>{formatPhone(PRIMARY_CONTACT.phone)}</a>
      </span>
    </p>
  );

  if (gateway) {
    return page(
      t("மீண்டும் முயற்சிக்கிறோம்", "Trying again"),
      <PaymentRedirect
        gateway={gateway}
        amountLabel={data ? formatMoney(data.amount, data.currency, lang) : ""}
      />,
    );
  }

  /* ── No usable reference ─────────────────────────────────────────── */

  if (!ref || !token || notFound) {
    const cancelled = urlState === "cancelled";
    const title = cancelled ? t("கட்டணம் ரத்து செய்யப்பட்டது", "Payment cancelled") : t("கட்டண நிலை", "Payment status");
    return page(
      title,
      <div className="card card--solid card--static pay-result">
        <span className={`pay-result__icon pay-result__icon--${cancelled ? "muted" : "warning"}`} aria-hidden="true">
          {cancelled ? <LuCircleX /> : <LuTriangleAlert />}
        </span>
        <h2 ref={headingRef} tabIndex={-1} className="pay-result__title">
          {cancelled ? t("கட்டணம் ரத்து செய்யப்பட்டது", "Payment cancelled") : t("கட்டண முடிவைப் படிக்க இயலவில்லை", "We could not read the payment result")}
        </h2>
        <p className="pay-result__lead">
          {cancelled
            ? t("நீங்கள் கட்டணத்தை ரத்து செய்தீர்கள். எந்தப் பணமும் எடுக்கப்படவில்லை.", "You cancelled the payment. No money was taken.")
            : t(
                "உங்கள் வங்கியிலிருந்து பணம் எடுக்கப்பட்டிருந்தால், அது தானாகவே உறுதி செய்யப்படும் அல்லது திரும்ப வழங்கப்படும். உதவி தேவைப்பட்டால் கோயில் அலுவலகத்தை அழைக்கவும்.",
                "If money was taken from your bank, it will be confirmed or returned automatically. Call the temple office if you need help.",
              )}
        </p>
        <div className="pay-result__actions">
          {last && (
            <Button variant="primary" icon={<LuRotateCcw aria-hidden="true" />} loading={retryStatus === "sending"} onClick={retry}>
              {t("மீண்டும் முயற்சி", "Try again")}
            </Button>
          )}
          <Button to="/donate?step=review" variant="outline">
            {t("நன்கொடைப் பக்கத்திற்குத் திரும்பு", "Return to the donation page")}
          </Button>
          <Button to="/contact" variant="ghost">
            {t("தொடர்பு கொள்ள", "Contact us")}
          </Button>
        </div>
        {retryStatus === "limited" && <Alert tone="warning">{rateLimitMessage(t, retryAfter)}</Alert>}
        {office}
      </div>,
    );
  }

  if (loading || !data) {
    return page(
      t("கட்டண நிலை", "Payment status"),
      <div className="card card--solid card--static pay-result">
        <p className="sr-only" role="status">
          {t("கட்டண நிலை ஏற்றப்படுகிறது…", "Checking the payment…")}
        </p>
        <SkeletonText lines={4} />
      </div>,
    );
  }

  /* ── A real payable ──────────────────────────────────────────────── */

  const isDonation = data.kind === "donation";
  const purpose = isDonation ? data.purpose : data.seva;
  const purposeLabel = purpose ? t(purpose.ta, purpose.en) : null;
  const paid = isPaidStatus(data.status);
  const open = isOpenStatus(data.status);
  const amountLabel = formatMoney(data.amount, data.currency, lang);

  const title = paid
    ? isDonation
      ? t("உங்கள் நன்கொடைக்கு நன்றி", "Thank you for your contribution")
      : t("உங்கள் சேவைக்கான கட்டணம் பெறப்பட்டது", "Payment received for your seva")
    : data.status === "FAILED"
      ? t("கட்டணம் நிறைவேறவில்லை", "Payment unsuccessful")
      : data.status === "CANCELLED"
        ? t("கட்டணம் ரத்து செய்யப்பட்டது", "Payment cancelled")
        : t("கட்டணம் உறுதி செய்யப்படுகிறது…", "Confirming your payment…");

  const icon = paid ? (
    <LuCircleCheck />
  ) : data.status === "FAILED" ? (
    <LuTriangleAlert />
  ) : data.status === "CANCELLED" ? (
    <LuCircleX />
  ) : (
    <LuClock />
  );
  const tone = paid ? "success" : data.status === "FAILED" ? "danger" : data.status === "CANCELLED" ? "muted" : "warning";

  const facts = [
    [isDonation ? t("நன்கொடை எண்", "Donation ID") : t("பதிவு எண்", "Booking ID"), data.number],
    [t("தொகை", "Amount"), `${amountLabel} (${data.currency})`],
    purposeLabel && [isDonation ? t("நோக்கம்", "Purpose") : t("சேவை", "Seva"), purposeLabel],
    !isDonation && data.preferredDate && [t("விரும்பிய தேதி", "Preferred date"), formatPlainDate(data.preferredDate, lang)],
    data.donorName && [t("பெயர்", "Name"), data.donorName],
    data.paidAt && [t("செலுத்திய நேரம்", "Payment date"), formatIstDateTime(data.paidAt, lang)],
    data.trackingId && [t("CCAvenue குறிப்பு", "CCAvenue reference"), data.trackingId],
    data.paymentMode && [t("கட்டண முறை", "Payment mode"), data.paymentMode],
    data.receiptNumber && [t("ரசீது எண்", "Receipt number"), data.receiptNumber],
  ].filter(Boolean);

  return page(
    title,
    <div className="card card--solid card--static pay-result">
      <span className={`pay-result__icon pay-result__icon--${tone}`} aria-hidden="true">
        {icon}
      </span>
      <h2 ref={headingRef} tabIndex={-1} className="pay-result__title">
        {title}
      </h2>
      <p className="pay-result__lead">
        {paid
          ? isDonation
            ? t("உங்கள் நன்கொடை வெற்றிகரமாகப் பெறப்பட்டது.", "Your donation has been successfully received.")
            : t(
                "உங்கள் கட்டணம் பெறப்பட்டது. தேதியை உறுதி செய்ய கோயில் அலுவலகம் உங்களை அழைக்கும்.",
                "Your payment has been received. The temple office will call you to confirm the date.",
              )
          : data.status === "FAILED"
            ? t("உங்கள் கட்டணத்தை நிறைவு செய்ய இயலவில்லை.", "We were unable to complete your payment.")
            : data.status === "CANCELLED"
              ? t("நீங்கள் கட்டணத்தை ரத்து செய்தீர்கள். எந்தப் பணமும் எடுக்கப்படவில்லை.", "You cancelled the payment. No money was taken.")
              : t(
                  "வங்கியிடமிருந்து உறுதிப்படுத்தலுக்காகக் காத்திருக்கிறோம். இந்தப் பக்கம் தானாகவே புதுப்பிக்கும்.",
                  "We are waiting for the bank to confirm. This page updates by itself.",
                )}
      </p>
      {data.failureMessage && data.status === "FAILED" && <p className="pay-result__reason">{data.failureMessage}</p>}
      {open && <span className="pay-result__spinner spinner" aria-hidden="true" />}
      {open && Date.now() - startedAt.current > POLL_STOP && (
        <Alert tone="info">
          {t(
            "வழக்கத்தை விட நேரம் எடுக்கிறது. CCAvenue உறுதி செய்தவுடன் உங்களுக்குச் செய்தி அனுப்புவோம். இந்தப் பக்கத்தை மூடிவிடலாம்.",
            "This is taking longer than usual. We will send you a message as soon as CCAvenue confirms. You can safely close this page.",
          )}
        </Alert>
      )}

      <dl className="pay-result__facts">
        {facts.map(([label, value]) => (
          <div key={label} className="pay-result__row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="pay-result__row">
          <dt>{t("நிலை", "Payment status")}</dt>
          <dd>
            <StatusBadge status={data.status} />
          </dd>
        </div>
      </dl>

      {paid && (
        <>
          <div className="pay-result__actions">
            <Button to={receiptPath(data.number, token)} variant="primary" icon={<LuDownload aria-hidden="true" />}>
              {t("ரசீதைப் பெறு", "Download receipt")}
            </Button>
            <Button to={receiptPath(data.number, token, true)} variant="outline" icon={<LuPrinter aria-hidden="true" />}>
              {t("ரசீதை அச்சிடு", "Print receipt")}
            </Button>
            <Button to="/" variant="ghost" icon={<LuHouse aria-hidden="true" />}>
              {t("முகப்புக்குத் திரும்பு", "Return home")}
            </Button>
          </div>
          <EmailReceiptForm number={data.number} token={token} email={data.email} className="pay-result__email" />
        </>
      )}

      {!paid && (data.status === "FAILED" || data.status === "CANCELLED" || (open && data.canRetry)) && (
        <div className="pay-result__actions">
          {data.canRetry && (
            <Button variant="primary" icon={<LuRotateCcw aria-hidden="true" />} loading={retryStatus === "sending"} onClick={retry}>
              {t("மீண்டும் முயற்சி", "Try again")}
            </Button>
          )}
          {data.canRetry && data.status === "FAILED" && (
            <Button variant="outline" icon={<LuWallet aria-hidden="true" />} loading={retryStatus === "sending"} onClick={retry}>
              {t("வேறு கட்டண முறையைத் தேர்வு செய்", "Choose another payment method")}
            </Button>
          )}
          <Button to={isDonation ? "/donate?step=review" : "/sevas"} variant="ghost">
            {isDonation ? t("நன்கொடைப் பக்கத்திற்குத் திரும்பு", "Return to the donation page") : t("சேவைகளுக்குத் திரும்பு", "Back to sevas")}
          </Button>
          <Button to="/contact" variant="ghost">
            {t("உதவிக்குத் தொடர்பு கொள்ள", "Contact support")}
          </Button>
        </div>
      )}

      {data.status === "FAILED" && (
        <p className="pay-result__note">
          {t(
            "CCAvenue பக்கத்தில் UPI, கார்டு அல்லது நெட் பேங்கிங் ஆகியவற்றில் எதையும் தேர்ந்தெடுக்கலாம். உங்கள் வங்கியில் பணம் எடுக்கப்பட்டிருந்தால், அது தானாகவே திரும்பக் கிடைக்கும்.",
            "CCAvenue's page lets you pick UPI, card or net banking. If your bank shows a debit, it is returned automatically.",
          )}
        </p>
      )}

      {retryStatus === "limited" && <Alert tone="warning">{rateLimitMessage(t, retryAfter)}</Alert>}
      {retryStatus === "not_retryable" && (
        <Alert tone="info">
          {t("இந்தக் கட்டணத்தை மீண்டும் முயற்சிக்க முடியாது. புதிய நன்கொடையாகத் தொடங்கவும்.", "This payment cannot be tried again. Please start a new donation.")}
        </Alert>
      )}
      {retryStatus === "error" && (
        <Alert tone="error">
          {t("மீண்டும் தொடங்க இயலவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும்.", "We could not start it again. Please try again in a moment.")}
        </Alert>
      )}
      {retryStatus === "network" && (
        <Alert tone="error">
          {t("இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.", "Check your connection and try again.")}
        </Alert>
      )}

      <p className="pay-result__note">
        <Link to="/donations">{t("நன்கொடைப் பக்கம்", "Donations page")}</Link>
      </p>
      {office}
    </div>,
  );
}
