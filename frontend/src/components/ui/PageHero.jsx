import { Link } from "react-router-dom";
import { useLang } from "../../context/LangContext";

/**
 * PageHero — the unified dark-glass banner for inner pages.
 *
 *   <PageHero
 *     variant="sevas"
 *     eyebrow="Online booking"
 *     title="Sevas & Poojas"
 *     lead="Offer a pooja in your name…"
 *     crumbs={[{ label: "Sevas" }]}
 *     actions={<Button variant="gold">Book</Button>}
 *     aside={<LiveStatusCard />}
 *   />
 */
export default function PageHero({
  variant,
  eyebrow,
  title,
  lead,
  children,
  crumbs,
  actions,
  aside,
  className = "",
}) {
  const { t } = useLang();
  return (
    <header className={`page-hero${variant ? ` page-hero--${variant}` : ""} ${className}`.trim()}>
      <div className="page-hero__content">
        <div className="page-hero__text">
          {crumbs && (
            <nav className="crumbs" aria-label={t("பாதை", "Breadcrumb")}>
              <Link to="/">{t("முகப்பு", "Home")}</Link>
              {crumbs.map((c, i) => (
                <span key={c.to ?? c.label} className="crumbs__item">
                  <span className="crumbs__sep" aria-hidden="true">
                    /
                  </span>{" "}
                  {c.to && i < crumbs.length - 1 ? (
                    <Link to={c.to}>{c.label}</Link>
                  ) : (
                    <span aria-current="page">{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
          )}
          {eyebrow && <span className="page-hero__eyebrow">{eyebrow}</span>}
          <h1 className="page-hero__title">{title}</h1>
          {lead && <p className="page-hero__lead">{lead}</p>}
          {children}
          {actions && <div className="page-hero__actions">{actions}</div>}
        </div>
        {aside && <div className="page-hero__aside">{aside}</div>}
      </div>
    </header>
  );
}
