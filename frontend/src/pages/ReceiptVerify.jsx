import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LuCircleCheck, LuHouse, LuShieldCheck, LuTriangleAlert } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import { SkeletonText } from "../components/ui/Feedback";
import StatusBadge from "../components/Payments/StatusBadge";
import { useLang } from "../context/LangContext";
import { PRIMARY_CONTACT, TRUST, formatPhone, telHref } from "../data/temple";
import { formatMoney } from "../lib/money";
import { formatPlainDate, getJson } from "../lib/payments";
import "../components/Payments/Payments.css";
import "./PaymentResult.css";

/**
 * /payment/verify — the QR code on a printed receipt leads here
 * (docs/payments/SPEC.md §7.7).
 *
 * Anyone holding the paper can check that the Trust really issued it. The
 * answer carries only what a stranger may see: the receipt number, the date,
 * the amount, the purpose and a masked donor name — or "Anonymous devotee"
 * where the donor did not agree to be named. The server answers the same shape
 * for a forged token as for an unknown receipt, so nothing can be learned by
 * probing.
 */
export default function ReceiptVerify() {
  const { lang, t } = useLang();
  const [params] = useSearchParams();
  const receipt = params.get("r");
  const token = params.get("v");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const headingRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (!receipt || !token) {
      setLoading(false);
      return () => {
        alive = false;
      };
    }
    getJson(`/api/payments/verify?r=${encodeURIComponent(receipt)}&v=${encodeURIComponent(token)}`).then((res) => {
      if (!alive) return;
      setData(res.ok && res.body?.valid ? res.body : null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [receipt, token]);

  useEffect(() => {
    if (loading) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [loading]);

  const title = t("ரசீது சரிபார்ப்பு", "Receipt check");
  const purpose = data?.purpose ?? data?.seva ?? null;

  return (
    <>
      <Seo title={title} description={t(TRUST.name.ta, TRUST.name.en)} robots="noindex, nofollow" />
      <PageHero
        variant="donations"
        eyebrow={t("அறக்கட்டளை ரசீது", "Trust receipt")}
        title={title}
        crumbs={[{ label: title }]}
      />

      <section className="section pay-result-section">
        <div className="container container--narrow">
          <div className="card card--solid card--static pay-result">
            {loading ? (
              <>
                <p className="sr-only" role="status">
                  {t("சரிபார்க்கிறோம்…", "Checking…")}
                </p>
                <SkeletonText lines={4} />
              </>
            ) : data ? (
              <>
                <span className="pay-result__icon pay-result__icon--success" aria-hidden="true">
                  <LuCircleCheck />
                </span>
                <h2 ref={headingRef} tabIndex={-1} className="pay-result__title">
                  {t("இந்த ரசீது உண்மையானது", "This receipt is genuine")}
                </h2>
                <p className="pay-result__lead">
                  {t(
                    `இந்த ரசீதை ${TRUST.name.ta} வழங்கியுள்ளது.`,
                    `This receipt was issued by the ${TRUST.name.en}.`,
                  )}
                </p>
                <dl className="pay-result__facts">
                  <div className="pay-result__row">
                    <dt>{t("ரசீது எண்", "Receipt number")}</dt>
                    <dd>{data.receiptNumber}</dd>
                  </div>
                  {data.date && (
                    <div className="pay-result__row">
                      <dt>{t("தேதி", "Date")}</dt>
                      <dd>{formatPlainDate(data.date, lang)}</dd>
                    </div>
                  )}
                  <div className="pay-result__row">
                    <dt>{t("தொகை", "Amount")}</dt>
                    <dd>
                      {formatMoney(data.amount, data.currency, lang)} ({data.currency})
                    </dd>
                  </div>
                  {purpose && (
                    <div className="pay-result__row">
                      <dt>{data.seva ? t("சேவை", "Seva") : t("நோக்கம்", "Purpose")}</dt>
                      <dd>{t(purpose.ta, purpose.en)}</dd>
                    </div>
                  )}
                  <div className="pay-result__row">
                    <dt>{t("நன்கொடையாளர்", "Donor")}</dt>
                    <dd>{data.donor === "Anonymous devotee" ? t("பெயர் வெளியிட விரும்பாத பக்தர்", "Anonymous devotee") : data.donor}</dd>
                  </div>
                  <div className="pay-result__row">
                    <dt>{t("நிலை", "Status")}</dt>
                    <dd>
                      <StatusBadge status={data.status} />
                    </dd>
                  </div>
                </dl>
                <p className="pay-result__note">
                  <LuShieldCheck aria-hidden="true" />{" "}
                  {t(
                    "தொகையும் நோக்கமும் மட்டுமே காட்டப்படுகின்றன; தொலைபேசி எண், முகவரி போன்ற விவரங்கள் காட்டப்படுவதில்லை.",
                    "Only the amount and purpose are shown — never the donor's phone number or address.",
                  )}
                </p>
              </>
            ) : (
              <>
                <span className="pay-result__icon pay-result__icon--warning" aria-hidden="true">
                  <LuTriangleAlert />
                </span>
                <h2 ref={headingRef} tabIndex={-1} className="pay-result__title">
                  {t("இந்த ரசீதைச் சரிபார்க்க இயலவில்லை", "We could not verify this receipt")}
                </h2>
                <p className="pay-result__lead">
                  {t(
                    "இணைப்பு முழுமையாக இல்லாமல் இருக்கலாம். ரசீதில் அச்சிடப்பட்ட முகவரியை முழுமையாக உள்ளிடவும், அல்லது கோயில் அலுவலகத்தை அழைத்துச் சரிபார்க்கவும்.",
                    "The link may be incomplete. Type the address printed on the receipt in full, or call the temple office to check.",
                  )}
                </p>
                <p className="pay-result__office">
                  <span>
                    {t("கோயில் அலுவலகம்: ", "Temple office: ")}
                    <a href={telHref(PRIMARY_CONTACT.phone)}>{formatPhone(PRIMARY_CONTACT.phone)}</a>
                  </span>
                </p>
              </>
            )}
            <Button to="/" variant="ghost" icon={<LuHouse aria-hidden="true" />}>
              {t("முகப்பு", "Home")}
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
