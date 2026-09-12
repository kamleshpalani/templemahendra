import { useEffect, useRef } from "react";

/** Every element a dialog's Tab trap cycles through (shared by <Modal> and the Gallery lightbox). */
export const DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * useDialogBehaviour — the one copy of the a11y-critical dialog lifecycle
 * behind <Modal> and the Gallery lightbox. While `open` is true it:
 *
 *   • remembers the opener and returns focus to it on close
 *   • locks body scroll (and restores the previous inline value)
 *   • moves focus into the panel: `initialFocusRef` if given, otherwise the
 *     first focusable control not marked `data-dialog-close`, then the first
 *     focusable, then the panel itself (give the panel tabIndex={-1})
 *   • Escape → stopPropagation + onClose()
 *   • Tab / Shift+Tab wrap inside `panelRef`
 *   • hands every other key to `onKey(e)` (e.g. arrow navigation)
 *
 *   useDialogBehaviour({ open, onClose, panelRef, initialFocusRef, onKey });
 *
 * `onKey` is read through a ref, so passing an inline arrow will not re-run
 * the open / lock / focus effect. `onClose` is a dependency (as in <Modal>),
 * so keep it stable with useCallback.
 */
export default function useDialogBehaviour({ open, onClose, panelRef, initialFocusRef, onKey }) {
  const openerRef = useRef(null);
  const onKeyRef = useRef(onKey);
  useEffect(() => {
    onKeyRef.current = onKey;
  });

  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    const focusables = () => (panel ? Array.from(panel.querySelectorAll(DIALOG_FOCUSABLE)) : []);

    const first =
      initialFocusRef?.current ||
      focusables().find((el) => !el.hasAttribute("data-dialog-close")) ||
      focusables()[0] ||
      panel;
    first?.focus?.({ preventScroll: true });

    const handleKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") {
        onKeyRef.current?.(e);
        return;
      }
      const items = focusables();
      if (items.length === 0) return;
      const start = items[0];
      const end = items[items.length - 1];
      if (e.shiftKey && document.activeElement === start) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        start.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = overflow;
      openerRef.current?.focus?.({ preventScroll: true });
    };
  }, [open, onClose, panelRef, initialFocusRef]);
}
