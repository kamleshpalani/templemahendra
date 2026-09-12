import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { PageLoader } from "../ui/Feedback";

/**
 * Route guard for the account area.
 *
 * It waits for the first /auth/me answer before deciding. Redirecting while
 * that is still in flight would bounce a signed-in devotee to the login page
 * every time they reloaded the page.
 */
export default function RequireAuth() {
  const { user, ready } = useAuth();
  const { t } = useLang();
  const location = useLocation();

  if (!ready) return <PageLoader label={t("ஏற்றுகிறது…", "Loading…")} />;

  if (!user) {
    // Remember where they were headed so sign-in can finish the journey.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
