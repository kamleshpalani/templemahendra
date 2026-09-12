import { LuCircleAlert, LuFlame } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import Button from "./Button";

/**
 * EmptyState — "nothing here yet" with an optional action.
 *   <EmptyState icon={<LuCalendar />} title="No upcoming events">…</EmptyState>
 */
export function EmptyState({ icon, title, children, action, compact = false, tone, className = "" }) {
  return (
    <div
      className={`empty-state${compact ? " empty-state--compact" : ""}${tone === "error" ? " empty-state--error" : ""} ${className}`.trim()}
      role="status"
    >
      <span className="empty-state__icon" aria-hidden="true">
        {icon ?? <LuFlame />}
      </span>
      {title && <h3 className="empty-state__title">{title}</h3>}
      {children && <p>{children}</p>}
      {action && <div className="empty-state__actions">{action}</div>}
    </div>
  );
}

/** ErrorState — a failed fetch with a retry affordance. */
export function ErrorState({ title, children, onRetry, className = "" }) {
  const { t } = useLang();
  return (
    <EmptyState
      tone="error"
      icon={<LuCircleAlert />}
      title={title ?? t("ஏற்ற முடியவில்லை", "Couldn't load this section")}
      className={className}
      action={
        onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t("மீண்டும் முயற்சி", "Try again")}
          </Button>
        )
      }
    >
      {children ?? t("இணைப்பை சரிபார்த்து மீண்டும் முயற்சிக்கவும்.", "Check your connection and try again.")}
    </EmptyState>
  );
}

export function PageLoader({ label = "Loading…" }) {
  return (
    <div className="page-loader" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** Skeleton grid used while lists are fetching. */
export function SkeletonCards({ count = 4, className = "grid-4", height }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton skeleton--card" style={height ? { height } : undefined} />
      ))}
    </div>
  );
}

/** Inline skeleton lines (title + n text lines). */
export function SkeletonText({ lines = 3, title = true }) {
  return (
    <div aria-hidden="true">
      {title && <div className="skeleton skeleton--title" />}
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton skeleton--text" style={{ width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}
