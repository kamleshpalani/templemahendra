export function EmptyState({ icon = "🪔", title, children, action }) {
  return (
    <div className="empty-state" role="status">
      <span className="empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      {title && <h3 className="empty-state__title">{title}</h3>}
      {children && <p>{children}</p>}
      {action}
    </div>
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
export function SkeletonCards({ count = 4, className = "grid-4" }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton skeleton--card" />
      ))}
    </div>
  );
}
