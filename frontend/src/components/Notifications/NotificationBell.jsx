import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { LuBell } from "react-icons/lu";
import { DIALOG_FOCUSABLE } from "../../hooks/useDialogBehaviour";
import { useLang } from "../../context/LangContext";
import { useNotifications } from "../../context/NotificationContext";
import { formatCount } from "../../lib/notifications";
import NotificationPanel from "./NotificationPanel";
import "./Notifications.css";

/**
 * NotificationBell — the header's bell, for signed-in devotees only (SPEC §7.3).
 *
 * The count is drawn as a badge but spoken as part of the button's name
 * ("Notifications, 3 unread"), so a screen reader hears it exactly once and
 * hears it again whenever focus returns to the bell. The badge itself is
 * aria-hidden: announcing "9+" would be less true than the number.
 *
 * A small ring plays when the count goes up while the page is open — never on
 * the first load, when nothing has "arrived", and never under reduced motion.
 */
export default function NotificationBell() {
  const { t } = useLang();
  const { enabled, unread, status } = useNotifications();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(0);
  const btnRef = useRef(null);
  const seenRef = useRef(null);
  const panelId = useId();

  useEffect(() => {
    if (!enabled) {
      seenRef.current = null;
      setOpen(false);
      return;
    }
    if (status !== "ready") return;
    if (seenRef.current !== null && unread > seenRef.current) setRing((r) => r + 1);
    seenRef.current = unread;
  }, [enabled, status, unread]);

  // A route change closes the panel (the item that caused it, or the back button).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const close = useCallback((reason) => {
    setOpen(false);
    if (reason === "escape" || reason === "toggle") {
      btnRef.current?.focus({ preventScroll: true });
    } else if (reason === "outside") {
      // After the mousedown has finished moving focus: if it landed on nothing a
      // keyboard could reach — <body>, or a container such as <main
      // tabindex="-1"> — bring it back to the bell instead of stranding it there.
      window.setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.matches(DIALOG_FOCUSABLE)) {
          btnRef.current?.focus({ preventScroll: true });
        }
      }, 0);
    }
  }, []);

  if (!enabled) return null;

  const label =
    unread > 0
      ? t(`அறிவிப்புகள், ${unread} படிக்கவில்லை`, `Notifications, ${unread} unread`)
      : t("அறிவிப்புகள்", "Notifications");
  const shown = formatCount(unread);

  return (
    <div className="notif-bell-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`notif-bell${unread > 0 ? " notif-bell--unread" : ""}${open ? " notif-bell--open" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={t("அறிவிப்புகள்", "Notifications")}
        onClick={() => (open ? close("toggle") : setOpen(true))}
      >
        <span key={ring} className={`notif-bell__icon${ring > 0 ? " notif-bell__icon--ring" : ""}`} aria-hidden="true">
          <LuBell />
        </span>
        {unread > 0 && (
          <span key={shown} className="notif-bell__count" aria-hidden="true">
            {shown}
          </span>
        )}
      </button>
      <NotificationPanel open={open} onClose={close} bellRef={btnRef} id={panelId} />
    </div>
  );
}
