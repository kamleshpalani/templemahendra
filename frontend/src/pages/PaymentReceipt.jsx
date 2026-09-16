import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LuDownload, LuHouse, LuPrinter, LuTriangleAlert } from "react-icons/lu";
import Seo from "../components/Seo";
import Button from "../components/ui/Button";
import { SkeletonText } from "../components/ui/Feedback";
import ReceiptDocument from "../components/Payments/ReceiptDocument";
import EmailReceiptForm from "../components/Payments/EmailReceiptForm";
import SimulatorBanner from "../components/Payments/SimulatorBanner";
import { useLang } from "../context/LangContext";
import { PRIMARY_CONTACT, formatPhone, telHref } from "../data/temple";
import { getJson } from "../lib/payments";
import "../components/Payments/Payments.css";
import "./PaymentReceipt.css";

/**
 * /payment/receipt — the printable receipt (docs/payments/SPEC.md §7.6).
 *
 * There is no server-generated PDF on purpose: the browser's own "Save as PDF"
 * renders Tamil correctly with the fonts the page already loads, which a PHP
 * PDF library does not. So "Download" and "Print" are the same action, and the
 * print stylesheet (PaymentReceipt.css) takes the site's chrome away so what
 * comes out of the printer is the receipt alone, on one A4 page.
 *
 * The page carries no <h1> of its own beyond the receipt's title: it is not a
 * destination on the site, it is a document, and it is noindex.
 */
export default function PaymentReceipt() {
  const { t } = useLang();
  const [params] = useSearchParams();
  const ref = params.get("ref");
  const token = params.get("t");
  const wantsPrint = params.get("print") === "1";

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const printed = useRef(false);
  const headingRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (!ref || !token) {
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    getJson(`/api/payments/receipt?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`).then((res) => {
      if (!alive) return;
      setData(res.ok && res.body?.receiptNumber ? res.body : null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [ref, token]);

  // A link that says "print" prints — once, after the document is on screen, so
  // the print dialog never opens over an empty page.
  useEffect(() => {
    if (!data || !wantsPrint || printed.current) return;
    printed.current = true;
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [data, wantsPrint]);

  useEffect(() => {
    if (data || loading) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [data, loading]);

  const seo = (
    <Seo
      title={t("ரசீது", "Receipt")}
      description={t("கோயில் நன்கொடை ரசீது", "Temple donation receipt")}
      robots="noindex, nofollow"
    />
  );

  if (loading) {
    return (
      <>
        {seo}
        <section className="section pay-receipt-page">
          <div className="container container--narrow">
            <div className="card card--solid card--static">
              <p className="sr-only" role="status">
                {t("ரசீது ஏற்றப்படுகிறது…", "Loading the receipt…")}
              </p>
              <SkeletonText lines={6} />
            </div>
          </div>
        </section>
      </>
    );
  }

  if (!data) {
    return (
      <>
        {seo}
        <section className="section pay-receipt-page">
          <div className="container container--narrow">
            <div className="card card--solid card--static pay-receipt-missing">
              <span className="pay-receipt-missing__icon" aria-hidden="true">
                <LuTriangleAlert />
              </span>
              <h1 ref={headingRef} tabIndex={-1} className="pay-receipt-missing__title">
                {t("இந்த ரசீதைக் காட்ட இயலவில்லை", "We could not open this receipt")}
              </h1>
              <p className="pay-receipt-missing__text">
                {t(
                  "இணைப்பு முழுமையாக இல்லாமலோ காலாவதியாகவோ இருக்கலாம். உங்களுக்கு அனுப்பப்பட்ட செய்தியில் உள்ள இணைப்பைப் பயன்படுத்தவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.",
                  "The link may be incomplete or no longer valid. Please use the link in the message we sent you, or call the temple office.",
                )}
              </p>
              <p className="pay-receipt-missing__text">
                <a href={telHref(PRIMARY_CONTACT.phone)}>{formatPhone(PRIMARY_CONTACT.phone)}</a>
              </p>
              <Button to="/" variant="outline" icon={<LuHouse aria-hidden="true" />}>
                {t("முகப்பு", "Home")}
              </Button>
            </div>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      {seo}
      <section className="section pay-receipt-page">
        <div className="container container--narrow">
          <SimulatorBanner simulator={Boolean(data.simulator)} testMode={Boolean(data.testMode)} outcome className="pay-receipt-page__banner" />

          <div className="pay-receipt-toolbar">
            <Button variant="primary" icon={<LuDownload aria-hidden="true" />} onClick={() => window.print()}>
              {t("PDF ஆகச் சேமி", "Download PDF")}
            </Button>
            <Button variant="outline" icon={<LuPrinter aria-hidden="true" />} onClick={() => window.print()}>
              {t("அச்சிடு", "Print")}
            </Button>
            <Button to="/" variant="ghost" icon={<LuHouse aria-hidden="true" />}>
              {t("முகப்பு", "Home")}
            </Button>
            <p className="pay-receipt-toolbar__hint">
              {t(
                "அச்சு சாளரத்தில் 'PDF ஆகச் சேமி' என்பதைத் தேர்ந்தெடுக்கவும்.",
                "Choose “Save as PDF” in the print window.",
              )}
            </p>
          </div>

          <ReceiptDocument data={data} />

          <div className="pay-receipt-page__email">
            <EmailReceiptForm number={data.number} token={token} email={data.email} />
          </div>
        </div>
      </section>
    </>
  );
}
