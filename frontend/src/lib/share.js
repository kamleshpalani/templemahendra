/**
 * src/lib/share.js — everything <ShareButton> needs that is not markup.
 *
 * One table of channels, one clipboard helper, one URL builder. Nothing here
 * knows the site's address or any page's title: callers pass what they are
 * sharing, and the origin comes from VITE_SITE_URL or from the page itself, so
 * a link shared from the staging host points at the staging host.
 *
 * No third-party script is loaded and no network request is made. Each channel
 * is a plain link to that network's own composer, opened only when the visitor
 * picks it.
 */
// Brand marks come from the Font Awesome set the rest of the site already uses
// (Footer, FloatingActions, Contact). X's mark only exists in the 6.x set, so
// that one icon is taken from there.
import { FaFacebookF, FaLinkedinIn, FaWhatsapp } from "react-icons/fa";
import { FaXTwitter } from "react-icons/fa6";
import { LuMail } from "react-icons/lu";

/**
 * The public origin. Set VITE_SITE_URL for builds served from a domain the
 * browser cannot see (behind a proxy, or a preview build meant to advertise the
 * real address); otherwise whatever origin the page is being served from is the
 * right answer, dev servers included.
 */
const CONFIGURED_ORIGIN = String(import.meta.env.VITE_SITE_URL || "")
  .trim()
  .replace(/\/+$/, "");

export function siteOrigin() {
  if (CONFIGURED_ORIGIN) return CONFIGURED_ORIGIN;
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** A site path ("/sevas", "uploads/x.jpg") or an already-absolute URL → absolute. */
export function absoluteUrl(target = "") {
  const s = String(target).trim();
  if (!s) return siteOrigin();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) return s;
  return siteOrigin() + (s.startsWith("/") ? s : `/${s}`);
}

/** The page being viewed, as a URL a stranger can open. Query kept: it selects what is on screen. */
export function currentUrl() {
  if (typeof window === "undefined") return siteOrigin();
  const { pathname, search } = window.location;
  return siteOrigin() + pathname + search;
}

/**
 * The channels offered, in order. `href` receives { url, title, text } already
 * resolved and absolute.
 *
 * `newTab: false` marks a scheme the browser hands to another application —
 * opening those in a tab leaves an empty one behind.
 */
export const SHARE_CHANNELS = [
  {
    id: "whatsapp",
    label: ["வாட்ஸ்அப்", "WhatsApp"],
    icon: FaWhatsapp,
    newTab: true,
    // wa.me hands off to the installed app on a phone and to web.whatsapp.com
    // on a desktop, so one link covers both.
    href: ({ url, title }) => `https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`,
  },
  {
    id: "facebook",
    label: ["பேஸ்புக்", "Facebook"],
    icon: FaFacebookF,
    newTab: true,
    // Facebook builds the post from the page's own Open Graph tags and ignores
    // any text handed to the sharer — which is why api/og.php exists.
    href: ({ url }) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    id: "linkedin",
    label: ["லிங்க்ட்இன்", "LinkedIn"],
    icon: FaLinkedinIn,
    newTab: true,
    href: ({ url }) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    id: "x",
    label: ["X", "X"],
    icon: FaXTwitter,
    newTab: true,
    href: ({ url, title }) =>
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`,
  },
  {
    id: "email",
    label: ["மின்னஞ்சல்", "Email"],
    icon: LuMail,
    newTab: false,
    href: ({ url, title, text }) =>
      `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(
        text ? `${text}\n\n${url}` : url,
      )}`,
  },
];

/**
 * Put `text` on the clipboard by whichever route the browser allows. Returns
 * false when every route was refused, so the caller can show the link to copy
 * by hand instead of claiming success.
 */
export async function copyText(text) {
  const value = String(text ?? "");
  if (!value) return false;

  // The async API needs a secure context and permission; both can be absent.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* refused — try the older route */
    }
  }

  // execCommand has left the spec but is still the only route on plain http and
  // in older Safari. The textarea has to be rendered to be selectable, so it is
  // moved off-screen rather than hidden.
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Whether this browser can hand `data` to the operating system's own share sheet. */
export function canNativeShare(data) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  if (typeof navigator.canShare === "function" && data) {
    try {
      return navigator.canShare(data);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Open the operating system's share sheet.
 * "dismissed" is the visitor closing it and is not a failure — saying "could
 * not share" then would be a lie.
 */
export async function nativeShare(data) {
  try {
    await navigator.share(data);
    return "shared";
  } catch (err) {
    return err?.name === "AbortError" ? "dismissed" : "failed";
  }
}
