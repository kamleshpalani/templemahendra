import { useId, useRef } from "react";
import { createPortal } from "react-dom";
import { LuX } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import useDialogBehaviour from "../../hooks/useDialogBehaviour";

/**
 * Accessible glass modal: focus trap, Escape to close, body scroll lock,
 * restores focus to the opener. Renders as a bottom sheet on small screens.
 *
 *   <Modal open onClose={…} title="Book Seva" eyebrow="Abhishekam" description="…" size="md">
 *     …body…
 *   </Modal>
 *
 * Pass `labelledBy` if you render your own heading inside.
 */
export default function Modal({
  open,
  onClose,
  title,
  eyebrow,
  description,
  size = "md",
  labelledBy,
  children,
  className = "",
}) {
  const panelRef = useRef(null);
  const auto = useId();
  const titleId = labelledBy ?? `modal-title-${auto}`;
  const descId = description ? `modal-desc-${auto}` : undefined;
  const { t } = useLang();

  // Scroll lock, Escape, Tab trap and focus return live in the shared dialog hook.
  // Initial focus: first form control (the close button is marked data-dialog-close), then close, then the panel.
  useDialogBehaviour({ open, onClose, panelRef });

  if (!open) return null;

  /**
 * Dialogs render into document.body through a portal.
 *
 * A `position: fixed` overlay is positioned against the viewport only while no
 * ancestor establishes a containing block for it. The page-transition wrapper
 * in App.jsx animates a transform, which does exactly that — so a modal opened
 * from any page was positioned against that wrapper instead. On a phone, deep
 * in a long page, the booking dialog landed more than a thousand pixels below
 * the fold: the visitor tapped Book and saw nothing happen.
 *
 * Portalling puts the overlay outside every page wrapper, where fixed means
 * fixed. React keeps the component in its original tree for state, context and
 * events, so nothing else about the caller changes.
 */
  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`modal${size !== "md" ? ` modal--${size}` : ""} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal__close"
          data-dialog-close=""
          onClick={onClose}
          aria-label={t("மூடு", "Close dialog")}
        >
          <LuX aria-hidden="true" />
        </button>
        {eyebrow && <p className="eyebrow modal__eyebrow">{eyebrow}</p>}
        {title && (
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
        )}
        {description && (
          <p id={descId} className="modal__desc">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
