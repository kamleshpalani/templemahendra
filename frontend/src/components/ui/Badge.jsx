/**
 * Badge — status / category pill.
 *   <Badge tone="success" live>Temple Open</Badge>
 * tones: default · gold · success · warning · danger · info · moon · sage · muted · on-dark
 */
export default function Badge({ tone = "default", live = false, size, className = "", children, ...rest }) {
  const cls = [
    "badge",
    tone !== "default" ? `badge--${tone}` : "",
    live ? "badge--live" : "",
    size === "lg" ? "badge--lg" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
