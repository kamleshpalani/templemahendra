import { useState } from "react";
import { LuBellRing, LuCalendarDays, LuHeartHandshake } from "react-icons/lu";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import ShareButton from "../Share/ShareButton";
import { usePaymentsConfig, paymentsUsable } from "../../lib/payments";
import { streamDescription, streamTitle } from "../../lib/live";
import "./Live.css";

/**
 * StreamActions — the row of things a devotee can do about one broadcast
 * (SPEC-PHASE4 §2.2): Donate, Notify Me and Share. Each is gated by the
 * committee's per-stream flag, and:
 *
 *   • Donate also waits for /api/payments/config (the same cached answer the
 *     donation page uses) and appears only when the gateway is enabled and
 *     ready — never while that answer is loading or after it failed;
 *   • Notify Me appears only before the broadcast (SCHEDULED, STARTING) and,
 *     until Phase 6 brings reminders, opens a small note saying so with the
 *     schedule as the way to plan ahead;
 *   • Share reuses the site's ShareButton with the broadcast's own address.
 *
 * When nothing applies the row is not rendered at all.
 */
export default function StreamActions({ stream, lang, t }) {
  const payments = usePaymentsConfig();
  const [notify, setNotify] = useState(false);
  const flags = stream?.flags ?? {};
  const slug = stream?.slug ?? "";
  const title = streamTitle(stream, lang);

  const donate = Boolean(flags.donations) && Boolean(slug) && !payments.loading && !payments.error && paymentsUsable(payments.config);
  const remind = Boolean(flags.notifications) && (stream?.status === "SCHEDULED" || stream?.status === "STARTING");
  const share = Boolean(flags.sharing) && Boolean(slug);

  if (!donate && !remind && !share) return null;

  return (
    <div className="live-actions" role="group" aria-label={t("இந்த ஒளிபரப்பிற்கு", "For this broadcast")}>
      {donate && (
        <Button to={`/donate?stream=${encodeURIComponent(slug)}`} variant="gold" size="sm" icon={<LuHeartHandshake aria-hidden="true" />}>
          {t("நன்கொடை", "Donate")}
        </Button>
      )}
      {remind && (
        <Button type="button" variant="outline" size="sm" icon={<LuBellRing aria-hidden="true" />} onClick={() => setNotify(true)}>
          {t("எனக்கு நினைவூட்டு", "Notify me")}
        </Button>
      )}
      {share && (
        <ShareButton
          to={`/live-darshan/${slug}`}
          title={title}
          text={streamDescription(stream, lang) || t("கோயிலின் நேரடி தரிசனம்", "Live darshan from the temple")}
        />
      )}

      {remind && (
        <Modal
          open={notify}
          onClose={() => setNotify(false)}
          size="sm"
          eyebrow={title}
          title={t("நினைவூட்டல்கள் விரைவில்", "Reminders are coming soon")}
          description={t(
            "இந்த தரிசனம் தொடங்கும் முன் ஒரு நினைவூட்டல் அனுப்பும் வசதி விரைவில் வரும். அதுவரை அட்டவணையில் நேரத்தைப் பார்த்துக்கொள்ளலாம்.",
            "We will soon be able to send you a reminder before this darshan begins. Until then, the schedule has every upcoming time.",
          )}
        >
          <div className="live-notify__actions">
            <Button to="/live-darshan/schedule" variant="primary" size="sm" icon={<LuCalendarDays aria-hidden="true" />}>
              {t("முழு அட்டவணை", "Full schedule")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setNotify(false)}>
              {t("மூடு", "Close")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
