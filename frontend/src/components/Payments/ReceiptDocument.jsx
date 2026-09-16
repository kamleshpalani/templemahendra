import { QRCodeSVG } from "qrcode.react";
import { useLang } from "../../context/LangContext";
import { ADDRESS, PRIMARY_CONTACT, TEMPLE, TEMPLE_EMAIL, TRUST, formatPhone } from "../../data/temple";
import { countryName } from "../../lib/familyRegistration";
import { amountInWordsINR, formatMoney } from "../../lib/money";
import { formatIstDate, formatIstDateTime, formatPlainDate } from "../../lib/payments";
import StatusBadge from "./StatusBadge";

/**
 * ReceiptDocument — the receipt itself (docs/payments/SPEC.md §7.6).
 *
 * Pure presentation: everything comes from GET /api/payments/receipt and from
 * data/temple.js. It is the same markup on screen and on paper — the print
 * rules in pages/PaymentReceipt.css hide the site's chrome around it, so
 * "Save as PDF" in the browser's print window produces the A4 receipt with
 * correct Tamil, which a server-generated PDF would struggle to do.
 *
 * The PAN is printed masked. The QR code carries the verification link, and the
 * link is printed under it as text so it can be typed by hand.
 */

/** One labelled fact. Blank values are skipped by the caller, never shown empty. */
function Row({ label, children, wide = false }) {
  return (
    <div className={`pay-receipt__row${wide ? " pay-receipt__row--wide" : ""}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function ReceiptDocument({ data }) {
  const { lang, t } = useLang();
  const isDonation = data.kind === "donation";
  const purpose = isDonation ? data.purpose : data.seva;
  const purposeLabel = purpose ? t(purpose.ta, purpose.en) : null;
  const address = data.address ?? {};
  const addressLine = [address.line, address.city, address.state, address.postcode]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");
  const country = address.country ? countryName(address.country) : "";
  const refunded = Number(data.amountRefunded ?? 0);

  return (
    <article className="card card--solid card--static pay-receipt" aria-labelledby="pay-receipt-title">
      {/* ── Who issued it ─────────────────────────────────────────── */}
      <header className="pay-receipt__head">
        <img className="pay-receipt__logo" src="/logo.svg" alt="" width="64" height="64" />
        <div className="pay-receipt__identity">
          <p className="pay-receipt__temple" lang="ta">
            {TEMPLE.name.ta}
          </p>
          <p className="pay-receipt__temple-en" lang="en">
            {TEMPLE.name.en}
          </p>
          <p className="pay-receipt__trust">{t(TRUST.name.ta, TRUST.name.en)}</p>
          <p className="pay-receipt__meta">
            {t(ADDRESS.printed.ta, ADDRESS.printed.en)}
            {" · "}
            {formatPhone(PRIMARY_CONTACT.phone)}
            {" · "}
            {TEMPLE_EMAIL}
          </p>
          <p className="pay-receipt__meta">
            {t(
              `பதிவு எண் ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · பான் ${TRUST.bank.pan} · ${TRUST.taxExemption.short.ta}`,
              `Reg. No. ${TRUST.bank.regNo} (${TRUST.bank.regDate}) · PAN ${TRUST.bank.pan} · ${TRUST.taxExemption.short.en}`,
            )}
          </p>
        </div>
      </header>

      {/* The receipt is what this page is, so its title is the page's only h1. */}
      <h1 id="pay-receipt-title" className="pay-receipt__title">
        {isDonation ? t("நன்கொடை ரசீது", "Donation receipt") : t("சேவை கட்டண ரசீது", "Seva payment receipt")}
      </h1>

      {/* ── The amount, large ─────────────────────────────────────── */}
      <div className="pay-receipt__amount">
        <span className="pay-receipt__amount-value">{formatMoney(data.amount, data.currency, lang)}</span>
        <span className="pay-receipt__amount-code">{data.currency}</span>
        {data.currency === "INR" && <span className="pay-receipt__amount-words">{amountInWordsINR(data.amount)}</span>}
      </div>

      {/* ── The facts ─────────────────────────────────────────────── */}
      <dl className="pay-receipt__list">
        <Row label={t("ரசீது எண்", "Receipt number")}>
          <strong>{data.receiptNumber}</strong>
        </Row>
        <Row label={t("ரசீது தேதி", "Receipt date")}>{formatIstDate(data.paidAt, lang)}</Row>
        <Row label={isDonation ? t("நன்கொடை எண்", "Donation ID") : t("பதிவு எண்", "Booking ID")}>{data.number}</Row>
        {data.trackingId && <Row label={t("CCAvenue குறிப்பு", "CCAvenue reference")}>{data.trackingId}</Row>}
        {data.bankRefNo && <Row label={t("வங்கிக் குறிப்பு", "Bank reference")}>{data.bankRefNo}</Row>}
        <Row label={t("நன்கொடையாளர்", "Donor")}>{data.donorName}</Row>
        {addressLine && (
          <Row label={t("முகவரி", "Address")} wide>
            {addressLine}
            {country ? `, ${country}` : ""}
          </Row>
        )}
        {data.pan && <Row label={t("PAN", "PAN")}>{data.pan}</Row>}
        {purposeLabel && (
          <Row label={isDonation ? t("நோக்கம்", "Purpose") : t("சேவை", "Seva")}>
            {purposeLabel}
            {!isDonation && data.preferredDate ? ` · ${formatPlainDate(data.preferredDate, lang)}` : ""}
          </Row>
        )}
        <Row label={t("தொகை", "Amount")}>
          {formatMoney(data.amount, data.currency, lang)} ({data.currency})
        </Row>
        {data.paymentMode && <Row label={t("கட்டண முறை", "Payment mode")}>{data.paymentMode}</Row>}
        <Row label={t("செலுத்திய நேரம்", "Payment date and time")}>{formatIstDateTime(data.paidAt, lang)}</Row>
        <Row label={t("நிலை", "Payment status")}>
          <StatusBadge status={data.status} />
        </Row>
        {refunded > 0 && (
          <Row label={t("திரும்பப் பெற்ற தொகை", "Refunded")}>{formatMoney(refunded, data.currency, lang)}</Row>
        )}
        {data.message && (
          <Row label={t("செய்தி", "Message")} wide>
            {data.message}
          </Row>
        )}
      </dl>

      {/* ── Footer: signature note and the verification QR ────────── */}
      <footer className="pay-receipt__foot">
        <div className="pay-receipt__notes">
          <p>{t(TRUST.taxExemption.long.ta, TRUST.taxExemption.long.en)}</p>
          <p className="pay-receipt__generated">
            {t(
              "இது கணினியால் உருவாக்கப்பட்ட ரசீது; கையொப்பம் தேவையில்லை.",
              "This is a computer-generated receipt and does not need a signature.",
            )}
          </p>
        </div>
        {data.verifyUrl && (
          <div className="pay-receipt__verify">
            <QRCodeSVG value={data.verifyUrl} size={96} level="M" marginSize={1} title={t("ரசீதைச் சரிபார்க்க", "Verify this receipt")} />
            <span className="pay-receipt__verify-label">{t("ரசீதைச் சரிபார்க்க", "Verify this receipt")}</span>
            <span className="pay-receipt__verify-url">{data.verifyUrl}</span>
          </div>
        )}
      </footer>
    </article>
  );
}
