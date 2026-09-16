import Badge from "../ui/Badge";
import { useLang } from "../../context/LangContext";
import { statusMeta } from "../../lib/live";

/**
 * LiveStatusBadge — a broadcast status as a Badge (SPEC-PHASE1 §5.2).
 *
 *   <LiveStatusBadge status="LIVE" size="lg" />          // on ivory
 *   <LiveStatusBadge status="LIVE" onDark />             // on ink / a photo
 *
 * The tone and the pulsing dot come from STREAM_STATUS (lib/live.js). On a
 * dark surface the on-ivory tints disappear, so `onDark` swaps to the
 * `on-dark` badge with a deeper fill of the same status colour (Live.css).
 * The visually hidden "Status:" prefix keeps the pill meaningful when a
 * screen reader meets it out of context.
 */
export default function LiveStatusBadge({ status, size, onDark = false, className = "" }) {
  const { t } = useLang();
  const meta = statusMeta(status);
  const cls = onDark ? `live-badge live-badge--on-dark live-badge--${meta.tone} ${className}` : `live-badge ${className}`;
  return (
    <Badge tone={onDark ? "on-dark" : meta.tone} live={Boolean(meta.live)} size={size} className={cls.trim()}>
      <span className="sr-only">{t("நிலை: ", "Status: ")}</span>
      {t(meta.ta, meta.en)}
    </Badge>
  );
}
