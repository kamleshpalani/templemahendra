import { forwardRef } from "react";
import { Link } from "react-router-dom";

const VARIANTS = {
  default: "",
  primary: "btn-primary",
  gold: "btn-gold",
  outline: "btn-outline",
  "outline-light": "btn-outline--light",
  soft: "btn-soft",
  ghost: "btn-ghost",
  danger: "btn-danger",
  success: "btn-success",
};
const SIZES = { xs: "btn--xs", sm: "btn--sm", md: "", lg: "btn--lg" };

/**
 * Button — the single button primitive for the site.
 *
 *   <Button variant="primary" size="lg" loading={saving}>Save</Button>
 *   <Button to="/sevas" variant="gold" icon={<LuSparkles />}>Book</Button>
 *   <Button href="tel:+91…" variant="outline">Call</Button>
 *
 * Props: variant · size · block · icon (leading) · iconOnly · loading ·
 *        to (router Link) · href (anchor) · everything else forwards.
 */
const Button = forwardRef(function Button(
  {
    variant = "default",
    size = "md",
    block = false,
    icon = null,
    trailingIcon = null,
    iconOnly = false,
    loading = false,
    className = "",
    children,
    to,
    href,
    type,
    disabled,
    ...rest
  },
  ref,
) {
  const cls = [
    "btn",
    VARIANTS[variant] ?? "",
    SIZES[size] ?? "",
    block ? "btn--block" : "",
    iconOnly ? "btn--icon" : "",
    loading ? "btn--loading" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      {icon}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
      {trailingIcon}
    </>
  );

  if (to) {
    return (
      <Link ref={ref} to={to} className={cls} aria-disabled={disabled || loading || undefined} {...rest}>
        {content}
      </Link>
    );
  }
  if (href) {
    return (
      <a ref={ref} href={href} className={cls} aria-disabled={disabled || loading || undefined} {...rest}>
        {content}
      </a>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {content}
    </button>
  );
});

export default Button;
