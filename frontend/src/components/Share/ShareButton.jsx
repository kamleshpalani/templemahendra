import { lazy, Suspense, useState } from "react";
import { LuShare2 } from "react-icons/lu";
import Button from "../ui/Button";
import { useLang } from "../../context/LangContext";
import { absoluteUrl, currentUrl } from "../../lib/share";

// The sheet pulls in five brand icons and the clipboard plumbing. Nothing about
// it is needed until someone actually decides to share, so it is fetched then.
const ShareSheet = lazy(() => import("./ShareSheet"));

/**
 * ShareButton — the one share control on the site. Drop it anywhere.
 *
 *   <ShareButton />                                   // shares the page it is on
 *   <ShareButton title={seva.name} text={seva.note} to={`/sevas?seva=${seva.id}`} />
 *   <ShareButton iconOnly variant="ghost" size="sm" /> // inside a card header
 *
 * Props
 *   title    what is being shared. Defaults to the document title, which <Seo>
 *            has already set from the same content, so a page-level button needs
 *            no props at all.
 *   text     one sentence of context — used as the body of an email and as the
 *            description the device's own share sheet shows.
 *   to       a site path when sharing one item rather than the whole page. Made
 *            absolute against the configured origin.
 *   url      an already-absolute URL, for the rare case that is not this site.
 *   label    trigger text. Defaults to "Share".
 *
 * Everything else (variant, size, iconOnly, className) goes to <Button>, so the
 * control can be a hero action, a card affordance or a toolbar icon without a
 * second component.
 */
export default function ShareButton({
  title,
  text,
  to,
  url,
  label,
  variant = "outline",
  size = "sm",
  iconOnly = false,
  className = "",
  ...rest
}) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);

  // Resolved at click time, not at render: the document title is written by
  // <Seo> through Helmet, which lands after the first paint, and the path can
  // change under a button that is never unmounted (the footer's, for one).
  const [payload, setPayload] = useState(null);

  const openSheet = (e) => {
    // Share buttons sit inside clickable cards (a seva tile opens its booking
    // form). Opening the sheet must not also fire the card underneath.
    e?.stopPropagation?.();
    const resolvedUrl = url || (to ? absoluteUrl(to) : currentUrl());
    setPayload({
      title: title || (typeof document === "undefined" ? "" : document.title),
      text,
      url: resolvedUrl,
    });
    setOpen(true);
  };

  const shareLabel = label ?? t("பங்கிடு", "Share");

  return (
    <>
      {/* rest comes first so the props this component owns cannot be replaced
          from outside and leave a share button that does not share. */}
      <Button
        {...rest}
        variant={variant}
        size={size}
        iconOnly={iconOnly}
        className={`share-btn ${className}`.trim()}
        icon={<LuShare2 aria-hidden="true" />}
        onClick={openSheet}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {iconOnly && title
          ? /* An icon-only trigger has no visible text, so its accessible name
               has to say what it shares — "Share" five times over on one page
               tells a screen-reader user nothing. */
            t(`${title} — பங்கிடு`, `Share: ${title}`)
          : shareLabel}
      </Button>

      {/* Mounted only once opened, so the lazy chunk is never fetched on a page
          nobody shares from. Suspense has no fallback on purpose: the sheet is
          the only thing waiting, and a spinner behind a modal that is about to
          appear reads as a glitch. */}
      {open && payload && (
        <Suspense fallback={null}>
          <ShareSheet
            open={open}
            onClose={() => setOpen(false)}
            title={payload.title}
            text={payload.text}
            url={payload.url}
          />
        </Suspense>
      )}
    </>
  );
}
