import Badge from "../ui/Badge";
import { useLang } from "../../context/LangContext";
import { STATUS_META } from "../../lib/payments";

/**
 * StatusBadge — one payment status, in words and in a colour
 * (docs/payments/SPEC.md §2.1, §7.2).
 *
 * The colour is never the only signal: the badge always carries the word too,
 * so the status reads the same to someone who cannot tell the tones apart. An
 * unknown status (a newer server than this build) shows itself rather than
 * disappearing.
 */
export default function StatusBadge({ status, size, className = "" }) {
  const { t } = useLang();
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta?.tone ?? "muted"} size={size} className={className}>
      {meta ? t(...meta.label) : String(status ?? "—")}
    </Badge>
  );
}
