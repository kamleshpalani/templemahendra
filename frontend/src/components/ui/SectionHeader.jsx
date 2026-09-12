/**
 * SectionHeader — eyebrow · title · subtitle, centred by default.
 *   <SectionHeader eyebrow="Sevas" title="Available Sevas" subtitle="…" align="split" actions={…} />
 */
export default function SectionHeader({
  eyebrow,
  title,
  subtitle,
  align = "center",
  actions,
  as: Heading = "h2",
  id,
  className = "",
}) {
  const cls = [
    "section-head",
    align === "left" ? "section-head--left" : "",
    align === "split" ? "section-head--split" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const text = (
    <>
      {eyebrow && <span className={`eyebrow${align === "center" ? " eyebrow--center" : ""}`}>{eyebrow}</span>}
      <Heading className="section-title" id={id}>
        {title}
      </Heading>
      {subtitle && <p className="section-subtitle">{subtitle}</p>}
    </>
  );
  if (align === "split") {
    return (
      <div className={cls}>
        <div className="section-head__text">{text}</div>
        {actions && <div className="section-head__actions">{actions}</div>}
      </div>
    );
  }
  return (
    <div className={cls}>
      {text}
      {actions && <div className="section-head__actions">{actions}</div>}
    </div>
  );
}
