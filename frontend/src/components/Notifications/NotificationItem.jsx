import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuArchive,
  LuArchiveRestore,
  LuEllipsisVertical,
  LuExternalLink,
  LuMail,
  LuMailOpen,
  LuTrash2,
} from "react-icons/lu";
import Badge from "../ui/Badge";
import { useLang } from "../../context/LangContext";
import {
  PRIORITY_BADGE,
  formatDateTime,
  iconFor,
  isExternalUrl,
  isInternalPath,
  pickLabel,
  relativeTime,
  toneFor,
} from "../../lib/notifications";

/**
 * The current time, re-read once a minute, so "just now" becomes "2 minutes
 * ago" on its own while a list stays open.
 */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const MENU_HEIGHT = 170; // three rows and a divider; enough to decide up or down

/**
 * NotificationItem — one notification, shared by the bell's panel and the
 * /notifications page (SPEC §7.3).
 *
 * The row is a link when the notification leads somewhere and a button when it
 * does not, with the actions menu beside it rather than inside it: an
 * interactive control nested in a link is announced as one blurred control and
 * a click on it would also follow the link.
 *
 * Opening calls `onOpen(item)` (POST click: marks it read, records the click)
 * and then navigates — site paths with the router, https links in a new tab.
 * The new-tab case never waits for the request, or the browser would treat the
 * delayed window.open as a pop-up and block it.
 */
export default function NotificationItem({
  item,
  now,
  variant = "panel",
  onOpen,
  onAction,
  onNavigated,
  selectable = false,
  selected = false,
  onSelect,
}) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const rowRef = useRef(null);
  const menuWrapRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuUp, setMenuUp] = useState(false);

  const Icon = iconFor(item);
  const tone = toneFor(item);
  const target = item.ctaUrl;
  const internal = isInternalPath(target);
  const external = !internal && isExternalUrl(target);
  const priority = PRIORITY_BADGE[item.priority];
  const categoryLabel = pickLabel(item.categoryLabel, lang) || item.category;
  const when = relativeTime(item.createdAt, lang, now);
  const fullWhen = formatDateTime(item.createdAt, lang);

  const closeMenu = useCallback((returnFocus) => {
    setMenuOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  // While the menu is open: a click anywhere else closes it; focus moves to its
  // first entry so the arrow keys work straight away.
  useEffect(() => {
    if (!menuOpen) return undefined;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
    const onDown = (e) => {
      if (!menuWrapRef.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const toggleMenu = () => {
    if (menuOpen) {
      closeMenu(false);
      return;
    }
    // Open upwards when the list would cut the menu off below: inside the
    // panel's scrolling body the boundary is that body, elsewhere the viewport.
    const btn = triggerRef.current?.getBoundingClientRect();
    const scroller = triggerRef.current?.closest("[data-notif-scroll]")?.getBoundingClientRect();
    const bottom = Math.min(window.innerHeight, scroller?.bottom ?? window.innerHeight);
    const top = Math.max(0, scroller?.top ?? 0);
    setMenuUp(Boolean(btn && btn.bottom + MENU_HEIGHT > bottom && btn.top - MENU_HEIGHT > top));
    setMenuOpen(true);
  };

  const onMenuKey = (e) => {
    if (e.key === "Escape") {
      // Stop here: the panel around this row closes on Escape too, and one
      // press should close one thing.
      e.stopPropagation();
      e.preventDefault();
      closeMenu(true);
      return;
    }
    if (e.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    const entries = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') ?? []);
    if (!entries.length) return;
    const at = entries.indexOf(document.activeElement);
    let next = null;
    if (e.key === "ArrowDown") next = at < 0 || at === entries.length - 1 ? 0 : at + 1;
    else if (e.key === "ArrowUp") next = at <= 0 ? entries.length - 1 : at - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = entries.length - 1;
    if (next === null) return;
    e.preventDefault();
    entries[next].focus();
  };

  /**
   * Run an action from the menu. A row about to leave the list (archive,
   * delete) first hands focus to its neighbour, so a keyboard user is not
   * dropped back at the top of the document.
   */
  const runAction = (action) => {
    setMenuOpen(false);
    const leaving =
      action === "delete" ||
      (action === "archive" && !item.isArchived) ||
      (action === "unarchive" && variant === "page" && item.isArchived);
    if (leaving) {
      const row = rowRef.current;
      const neighbour =
        row?.nextElementSibling?.querySelector(".notif-item__main") ??
        row?.previousElementSibling?.querySelector(".notif-item__main") ??
        row?.closest("[data-notif-focus]");
      neighbour?.focus({ preventScroll: true });
    } else {
      triggerRef.current?.focus({ preventScroll: true });
    }
    onAction?.(action, item);
  };

  const handleClick = async (e) => {
    if (external) {
      // The browser opens the tab itself (target=_blank); record it alongside.
      onOpen?.(item);
      onNavigated?.();
      return;
    }
    if (internal) {
      // Ctrl/Cmd/Shift-click: the visitor asked for a new tab or window. Let the
      // link do that and record the open without holding it up.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        onOpen?.(item);
        return;
      }
      e.preventDefault();
      const url = await onOpen?.(item);
      onNavigated?.();
      navigate(isInternalPath(url) ? url : target);
      return;
    }
    onOpen?.(item);
  };

  const onAuxClick = (e) => {
    // Middle-click opens a background tab without a click event.
    if (e.button === 1 && (internal || external)) onOpen?.(item);
  };

  const content = (
    <>
      <span className="notif-item__icon" data-tone={tone} aria-hidden="true">
        <Icon />
        {!item.isRead && <span className="notif-item__dot" />}
      </span>
      <span className="notif-item__content">
        <span className="notif-item__title">
          {!item.isRead && <span className="sr-only">{t("படிக்காதது: ", "Unread: ")}</span>}
          {item.title}
        </span>
        {item.body && <span className="notif-item__body">{item.body}</span>}
        <span className="notif-item__meta">
          <time dateTime={item.createdAt ?? undefined} title={fullWhen}>
            {when}
          </time>
          <span className="notif-item__cat">{categoryLabel}</span>
          {priority && (
            <Badge tone={priority.tone} className="notif-item__badge">
              {t(priority.ta, priority.en)}
            </Badge>
          )}
          {external && (
            <span className="notif-item__ext">
              <LuExternalLink aria-hidden="true" />
              <span className="sr-only">{t("(புதிய தாவலில் திறக்கும்)", "(opens in a new tab)")}</span>
            </span>
          )}
        </span>
      </span>
    </>
  );

  const cls = [
    "notif-item",
    `notif-item--${variant}`,
    item.isRead ? "" : "notif-item--unread",
    selected ? "notif-item--selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <li
      ref={rowRef}
      className={cls}
      data-id={item.id}
      data-category={item.category}
      data-read={item.isRead ? "true" : "false"}
    >
      {selectable && (
        <label className="notif-item__select">
          <input
            type="checkbox"
            className="notif-check"
            checked={selected}
            onChange={(e) => onSelect?.(item, e.target.checked)}
            aria-label={`${t("தேர்ந்தெடு", "Select")}: ${item.title}`}
          />
        </label>
      )}

      {internal || external ? (
        <a
          href={target}
          className="notif-item__main"
          onClick={handleClick}
          onAuxClick={onAuxClick}
          target={external ? "_blank" : undefined}
          rel={external ? "noopener noreferrer" : undefined}
        >
          {content}
        </a>
      ) : (
        <button type="button" className="notif-item__main" onClick={handleClick}>
          {content}
        </button>
      )}

      <div className="notif-item__actions" ref={menuWrapRef} onKeyDown={menuOpen ? onMenuKey : undefined}>
        <button
          ref={triggerRef}
          type="button"
          className="notif-item__more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-label={`${t("மேலும் செயல்கள்", "More actions")}: ${item.title}`}
          onClick={toggleMenu}
        >
          <LuEllipsisVertical aria-hidden="true" />
        </button>
        {menuOpen && (
          <div
            ref={menuRef}
            id={menuId}
            className={`menu notif-menu${menuUp ? " menu--up" : ""}`}
            role="menu"
            aria-label={t("அறிவிப்பு செயல்கள்", "Notification actions")}
          >
            {item.isRead ? (
              <button type="button" role="menuitem" tabIndex={-1} className="menu__item" onClick={() => runAction("unread")}>
                <LuMail aria-hidden="true" />
                {t("படிக்காததாகக் குறி", "Mark as unread")}
              </button>
            ) : (
              <button type="button" role="menuitem" tabIndex={-1} className="menu__item" onClick={() => runAction("read")}>
                <LuMailOpen aria-hidden="true" />
                {t("படித்ததாகக் குறி", "Mark as read")}
              </button>
            )}
            {item.isArchived ? (
              <button type="button" role="menuitem" tabIndex={-1} className="menu__item" onClick={() => runAction("unarchive")}>
                <LuArchiveRestore aria-hidden="true" />
                {t("உள்பெட்டிக்கு மீட்டெடு", "Move back to inbox")}
              </button>
            ) : (
              <button type="button" role="menuitem" tabIndex={-1} className="menu__item" onClick={() => runAction("archive")}>
                <LuArchive aria-hidden="true" />
                {t("காப்பகத்தில் வை", "Archive")}
              </button>
            )}
            <span className="menu__divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu__item menu__item--danger"
              onClick={() => runAction("delete")}
            >
              <LuTrash2 aria-hidden="true" />
              {t("நீக்கு", "Delete")}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Placeholder rows while the first answer is on its way. */
export function NotificationSkeleton({ count = 3, variant = "panel" }) {
  return (
    <div className={`notif-skel-list notif-skel-list--${variant}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="notif-skel">
          <span className="skeleton notif-skel__icon" />
          <span className="notif-skel__lines">
            <span className="skeleton skeleton--text notif-skel__line notif-skel__line--title" />
            <span className="skeleton skeleton--text notif-skel__line" />
            <span className="skeleton skeleton--text notif-skel__line notif-skel__line--short" />
          </span>
        </div>
      ))}
    </div>
  );
}
