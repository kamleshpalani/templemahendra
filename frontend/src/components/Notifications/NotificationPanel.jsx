import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LuArrowRight, LuBellRing, LuCheckCheck, LuCircleAlert, LuSettings } from "react-icons/lu";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import { EmptyState } from "../ui/Feedback";
import { DIALOG_FOCUSABLE } from "../../hooks/useDialogBehaviour";
import { useLang } from "../../context/LangContext";
import { useNotifications } from "../../context/NotificationContext";
import NotificationItem, { NotificationSkeleton, useNow } from "./NotificationItem";

const SHEET_QUERY = "(max-width: 639px)";

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * NotificationPanel — what the bell opens (SPEC §7.3).
 *
 * From 640px up it is a popover anchored under the bell: a non-modal dialog, so
 * the page behind stays scrollable and a click anywhere else simply closes it.
 * Below 640px there is no room to anchor anything, so the same content is a
 * bottom sheet built on the site's <Modal> — its focus trap, scroll lock and
 * focus return rather than a second copy of them.
 *
 * `onClose(reason)` tells the bell how it closed, because that decides where
 * focus goes: back to the bell after Escape or an outside click, nowhere after
 * a navigation or a click on another control.
 */
export default function NotificationPanel({ open, onClose, bellRef, id }) {
  const { t } = useLang();
  const { refresh } = useNotifications();
  const asSheet = useMediaQuery(SHEET_QUERY);

  // Every opening shows the current state, not whatever the last poll saw.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const closeSheet = useCallback(() => onClose("sheet"), [onClose]);
  const navigated = useCallback(() => onClose("navigate"), [onClose]);

  if (!open) return null;

  if (asSheet) {
    return (
      <Modal
        open
        onClose={closeSheet}
        size="sm"
        className="notif-sheet"
        title={t("அறிவிப்புகள்", "Notifications")}
      >
        <PanelBody onNavigate={navigated} />
      </Modal>
    );
  }

  return (
    <Popover id={id} onClose={onClose} bellRef={bellRef} label={t("அறிவிப்புகள்", "Notifications")}>
      <PanelBody onNavigate={navigated} showTitle />
    </Popover>
  );
}

function Popover({ id, onClose, bellRef, label, children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    const panel = panelRef.current;
    // The dialog itself takes focus, so a screen reader announces "Notifications,
    // dialog" before the first row; Tab then walks the rows.
    panel?.focus({ preventScroll: true });

    const onDown = (e) => {
      if (panel?.contains(e.target) || bellRef.current?.contains(e.target)) return;
      // A click on another control keeps that control's focus; a click on
      // nothing in particular returns focus to the bell.
      onClose(e.target.closest?.(DIALOG_FOCUSABLE) ? "away" : "outside");
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose("escape");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, bellRef]);

  // Tabbing out of the popover closes it: a non-modal panel left open behind the
  // focus would cover the page the visitor has moved on to.
  const onBlur = (e) => {
    const next = e.relatedTarget;
    if (!next) return;
    if (panelRef.current?.contains(next) || bellRef.current?.contains(next)) return;
    onClose("away");
  };

  return (
    <div
      ref={panelRef}
      id={id}
      className="notif-pop"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onBlur={onBlur}
    >
      {children}
    </div>
  );
}

function PanelBody({ onNavigate, showTitle = false }) {
  const { t } = useLang();
  const titleId = useId();
  const now = useNow();
  const { unread, latest, status, refresh, markAllRead, open, markRead, markUnread, archive, unarchive, remove } =
    useNotifications();
  const [marking, setMarking] = useState(false);

  const markAll = async () => {
    setMarking(true);
    try {
      await markAllRead();
    } catch {
      /* the context has already rolled back and said why */
    } finally {
      setMarking(false);
    }
  };

  const onAction = (action, item) => {
    const run = { read: markRead, unread: markUnread, archive, unarchive, delete: remove }[action];
    run?.([item.id], [item]).catch(() => {});
  };

  const countText =
    unread > 0
      ? t(`${unread} படிக்கவில்லை`, `${unread} unread`)
      : t("அனைத்தும் படிக்கப்பட்டன", "All read");

  return (
    <>
      <div className="notif-panel__head">
        {showTitle && (
          <h2 id={titleId} className="notif-panel__title">
            {t("அறிவிப்புகள்", "Notifications")}
          </h2>
        )}
        <span className="notif-panel__count" role="status">
          {countText}
        </span>
        <div className="notif-panel__tools">
          <Button
            variant="ghost"
            size="xs"
            className="notif-panel__markall"
            icon={<LuCheckCheck aria-hidden="true" />}
            onClick={markAll}
            disabled={unread === 0}
            loading={marking}
          >
            {t("அனைத்தையும் படித்ததாகக் குறி", "Mark all as read")}
          </Button>
          <Link
            to="/account?tab=notifications"
            className="notif-panel__icon-link"
            aria-label={t("அறிவிப்பு அமைப்புகள்", "Notification settings")}
            title={t("அறிவிப்பு அமைப்புகள்", "Notification settings")}
            onClick={onNavigate}
          >
            <LuSettings aria-hidden="true" />
          </Link>
        </div>
      </div>

      <div className="notif-panel__body" data-notif-scroll="" data-notif-focus="" tabIndex={-1}>
        {latest.length === 0 && status !== "ready" && status !== "error" && (
          <>
            <span className="sr-only" role="status">
              {t("அறிவிப்புகள் ஏற்றப்படுகின்றன…", "Loading notifications…")}
            </span>
            <NotificationSkeleton count={3} />
          </>
        )}

        {latest.length === 0 && status === "error" && (
          <EmptyState
            compact
            tone="error"
            className="notif-panel__state"
            icon={<LuCircleAlert />}
            title={t("அறிவிப்புகளை ஏற்ற முடியவில்லை", "Couldn't load your notifications")}
            action={
              <Button variant="outline" size="sm" onClick={() => refresh()}>
                {t("மீண்டும் முயற்சி", "Try again")}
              </Button>
            }
          >
            {t("இணைப்பை சரிபார்த்து மீண்டும் முயற்சிக்கவும்.", "Check your connection and try again.")}
          </EmptyState>
        )}

        {latest.length === 0 && status === "ready" && (
          <EmptyState
            compact
            className="notif-panel__state"
            icon={<LuBellRing />}
            title={t("எல்லாம் பார்த்துவிட்டீர்கள்", "You're all caught up")}
          >
            {t(
              "சேவை உறுதிப்படுத்தல்கள், ரசீதுகள் மற்றும் கோயில் அறிவிப்புகள் இங்கே தோன்றும்.",
              "Booking confirmations, receipts and temple announcements will appear here.",
            )}
          </EmptyState>
        )}

        {latest.length > 0 && (
          <ul className="notif-list notif-list--panel" aria-label={t("சமீபத்திய அறிவிப்புகள்", "Latest notifications")}>
            {latest.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                now={now}
                variant="panel"
                onOpen={open}
                onAction={onAction}
                onNavigated={onNavigate}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="notif-panel__foot">
        <Link to="/notifications" className="btn btn-soft btn--sm btn--block notif-panel__all" onClick={onNavigate}>
          {t("அனைத்து அறிவிப்புகளையும் காண்க", "View all notifications")}
          <LuArrowRight aria-hidden="true" />
        </Link>
      </div>
    </>
  );
}
