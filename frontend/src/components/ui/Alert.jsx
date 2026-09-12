import { LuCircleAlert, LuCircleCheck, LuInfo, LuTriangleAlert, LuX } from "react-icons/lu";
import { useLang } from "../../context/LangContext";

const ICONS = {
  success: LuCircleCheck,
  error: LuCircleAlert,
  danger: LuCircleAlert,
  warning: LuTriangleAlert,
  info: LuInfo,
};

/**
 * Alert — inline status message with the correct live-region semantics.
 *   <Alert tone="success" title="Thank you">Your donation was recorded.</Alert>
 */
export default function Alert({ tone = "info", title, onClose, className = "", children, ...rest }) {
  const Icon = ICONS[tone] ?? LuInfo;
  const role = tone === "error" || tone === "danger" ? "alert" : "status";
  const { t } = useLang();
  return (
    <div className={`alert alert--${tone} ${className}`.trim()} role={role} {...rest}>
      <span className="alert__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="alert__body">
        {title && <span className="alert__title">{title}</span>}
        {children}
      </div>
      {onClose && (
        <button type="button" className="alert__close" onClick={onClose} aria-label={t("மூடு", "Dismiss")}>
          <LuX aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
