import { useEffect, useId, useState } from "react";
import { LuBadgeCheck, LuCheck, LuCopy, LuInfo } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { TRUST, DONATION_NOTE } from "../../data/temple";
import Button from "../ui/Button";
import Badge from "../ui/Badge";
import "./TrustDetails.css";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clipboard is only offered when the browser exposes it (secure context). */
const canCopy = () =>
  typeof navigator !== "undefined" && !!navigator.clipboard;

/** Registration entries whose value gets a copy button. */
const COPYABLE_KEYS = new Set(["account", "ifsc"]);

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ value, fieldLabel }) {
  const { t } = useLang();
  // Timestamp of the last successful copy (0 = idle). Each click restarts
  // the 2s "Copied" window; the effect cleanup also clears it on unmount.
  const [copiedAt, setCopiedAt] = useState(0);
  const copied = copiedAt > 0;

  useEffect(() => {
    if (!copiedAt) return undefined;
    const id = setTimeout(() => setCopiedAt(0), 2000);
    return () => clearTimeout(id);
  }, [copiedAt]);

  if (!canCopy()) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAt(Date.now());
    } catch {
      /* clipboard refused (permissions / insecure context) — stay silent */
    }
  };

  return (
    <Button
      variant="soft"
      size="xs"
      className={`trust__copy${copied ? " trust__copy--copied" : ""}`}
      onClick={handleCopy}
      icon={copied ? <LuCheck aria-hidden="true" /> : <LuCopy aria-hidden="true" />}
      aria-label={
        copied
          ? t(`${fieldLabel} நகலெடுக்கப்பட்டது`, `${fieldLabel} copied`)
          : t(`${fieldLabel} நகலெடு`, `Copy ${fieldLabel}`)
      }
    >
      <span aria-live="polite">
        {copied ? t("நகலெடுக்கப்பட்டது ✓", "Copied ✓") : t("நகலெடு", "Copy")}
      </span>
    </Button>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

/**
 * One label:value pair. `code` marks a verbatim code/number (never translated,
 * tabular figures, wraps anywhere on narrow screens).
 */
function TrustRow({ label, value, code = false, copyable = false }) {
  return (
    <div className="trust__row">
      <dt className="trust__label">{label}</dt>
      <dd className="trust__value">
        <span
          className={`trust__text${code ? " trust__text--code" : ""}`}
          translate={code ? "no" : undefined}
          lang={code ? "en" : undefined}
        >
          {value}
        </span>
        {copyable && <CopyButton value={value} fieldLabel={label} />}
      </dd>
    </div>
  );
}

// ── 80G badge ─────────────────────────────────────────────────────────────────

function TaxBadge() {
  const { t } = useLang();
  return (
    <Badge tone="gold" className="trust__badge">
      <LuBadgeCheck aria-hidden="true" />
      {t(TRUST.taxExemption.short.ta, TRUST.taxExemption.short.en)}
    </Badge>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * TrustDetails — Dharma Trust registration / bank details.
 *
 * Props:
 *   variant      "full" (About page, inside .page-prose) | "bank" (Donations panel)
 *   showNote     append the DONATION_NOTE callout (methods + receipt policy)
 *   showHeading  full variant only — render the registration <h3>
 *   id           applied to the root so pages can deep-link (#trust, #bank-details)
 */
export default function TrustDetails({
  variant = "full",
  showNote = false,
  showHeading = true,
  id,
}) {
  const { lang, t } = useLang();
  const uid = useId();
  const isBank = variant === "bank";
  const ownsHeading = !isBank && showHeading;
  // Collision-free ids for aria-labelledby (React's useId when no id is passed)
  const baseId = id || uid;
  const headingId = `${baseId}-heading`;
  const noteId = `${baseId}-note`;
  // Full variant owns its heading → a labelled <section>; otherwise a plain <div>
  const Root = ownsHeading ? "section" : "div";
  // Bank variant is a solid glass card (Donations panel); full variant sits in prose
  const rootClass = isBank
    ? "trust trust--bank card card--solid card--static"
    : "trust trust--full";

  return (
    <Root
      className={rootClass}
      id={id}
      lang={lang}
      aria-labelledby={ownsHeading ? headingId : undefined}
    >
      {ownsHeading && (
        <h3 id={headingId} className="trust__heading">
          {t(TRUST.registrationHeading.ta, TRUST.registrationHeading.en)}
        </h3>
      )}

      {isBank ? (
        <dl className="trust__list trust__list--bank">
          {/* The beneficiary name is what a donor types into a bank form, so the
              registered English form is always primary; Tamil shown beneath. */}
          <TrustRow
            label={t("கணக்கு பெயர்", "Account Name")}
            value={
              <>
                {TRUST.name.en}
                <span className="trust__text-sub" lang="ta">
                  {TRUST.name.ta}
                </span>
              </>
            }
            code
          />
          <TrustRow
            label={t("வங்கி", "Bank")}
            value={`${t(TRUST.bank.name.ta, TRUST.bank.name.en)}, ${t(
              TRUST.bank.branch.ta,
              TRUST.bank.branch.en,
            )}`}
          />
          <TrustRow
            label={t("கணக்கு எண்", "Account No.")}
            value={TRUST.bank.accountNo}
            code
            copyable
          />
          <TrustRow
            label={t("IFSC", "IFSC")}
            value={TRUST.bank.ifsc}
            code
            copyable
          />
        </dl>
      ) : (
        <dl className="trust__list">
          {TRUST.registration.map((entry) => {
            const isText = typeof entry.value === "object";
            return (
              <TrustRow
                key={entry.key}
                label={t(entry.label.ta, entry.label.en)}
                value={isText ? t(entry.value.ta, entry.value.en) : entry.value}
                code={!isText}
                copyable={COPYABLE_KEYS.has(entry.key)}
              />
            );
          })}
        </dl>
      )}

      <div className="trust__footer">
        <TaxBadge />
        {isBank ? (
          <p className="trust__meta">
            {t("பதிவு எண்", "Reg. No.")}{" "}
            <span translate="no" lang="en">
              {TRUST.bank.regNo}
            </span>
            {" · "}
            {t("பான்", "PAN")}{" "}
            <span translate="no" lang="en">
              {TRUST.bank.pan}
            </span>
          </p>
        ) : (
          <p className="trust__tax">
            {t(TRUST.taxExemption.long.ta, TRUST.taxExemption.long.en)}
          </p>
        )}
      </div>

      {showNote && (
        <aside className="trust__note callout callout--maroon" aria-labelledby={noteId}>
          <LuInfo aria-hidden="true" />
          <div className="trust__note-body">
            <h4 id={noteId} className="trust__note-title">
              {t(DONATION_NOTE.heading.ta, DONATION_NOTE.heading.en)}
            </h4>
            <p className="trust__note-text">
              {t(DONATION_NOTE.methods.ta, DONATION_NOTE.methods.en)}
            </p>
            <p className="trust__note-text">
              {t(DONATION_NOTE.receipt.ta, DONATION_NOTE.receipt.en)}
            </p>
          </div>
        </aside>
      )}
    </Root>
  );
}
