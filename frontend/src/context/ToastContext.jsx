import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { LuCircleAlert, LuCircleCheck, LuInfo, LuTriangleAlert, LuX } from "react-icons/lu";

const ToastContext = createContext(null);

const ICONS = {
  success: LuCircleCheck,
  error: LuCircleAlert,
  warning: LuTriangleAlert,
  info: LuInfo,
};
const AUTO_DISMISS_MS = 5000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 260);
  }, []);

  const notify = useCallback(
    ({ type = "info", title, message, duration = AUTO_DISMISS_MS }) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((list) => [...list.slice(-3), { id, type, title, message }]);
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      notify,
      dismiss,
      success: (message, title) => notify({ type: "success", message, title }),
      error: (message, title) => notify({ type: "error", message, title, duration: 7000 }),
      warning: (message, title) => notify({ type: "warning", message, title, duration: 6000 }),
      info: (message, title) => notify({ type: "info", message, title }),
    }),
    [notify, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => {
          const Icon = ICONS[t.type] ?? LuInfo;
          return (
            <div
              key={t.id}
              className={`toast toast--${t.type}${t.leaving ? " toast--leaving" : ""}`}
              role={t.type === "error" ? "alert" : "status"}
            >
              <span className="toast__icon" aria-hidden="true">
                <Icon />
              </span>
              <div className="toast__body">
                {t.title && <span className="toast__title">{t.title}</span>}
                <span>{t.message}</span>
              </div>
              <button
                type="button"
                className="toast__close"
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
              >
                <LuX aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
