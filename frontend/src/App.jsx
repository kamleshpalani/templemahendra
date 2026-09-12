import { Routes, Route, useLocation, Outlet } from "react-router-dom";
import { Suspense, lazy, useEffect } from "react";
import Layout from "./components/Layout/Layout";
import Home from "./pages/Home";
import { PageLoader } from "./components/ui/Feedback";
import { useLang } from "./context/LangContext";
import useReveal from "./hooks/useReveal";

// Home stays eager for LCP; every other route is code-split.
const About = lazy(() => import("./pages/About"));
const Sevas = lazy(() => import("./pages/Sevas"));
const Events = lazy(() => import("./pages/Events"));
const Donations = lazy(() => import("./pages/Donations"));
const Contact = lazy(() => import("./pages/Contact"));
const PanchangCalendar = lazy(() => import("./pages/PanchangCalendar"));
const NotFound = lazy(() => import("./pages/NotFound"));

/** Re-mounts on every path change so CSS `page-in` plays; Suspense shows the glass loader. */
function PageTransition() {
  const { pathname } = useLocation();
  const { t } = useLang();
  // Scroll-reveal for any `.reveal` blocks rendered by the current page.
  useReveal([pathname]);
  return (
    <div key={pathname} className="page-enter">
      <Suspense fallback={<PageLoader label={t("ஏற்றுகிறது…", "Loading…")} />}>
        <Outlet />
      </Suspense>
    </div>
  );
}

function ScrollToTop() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    // In-page anchors (/about#trust, /donations#bank-details): scroll to the
    // target once it has rendered. Each anchored section sets its own
    // scroll-margin-top (About.css, Contact.css, Donations.css, TrustDetails.css)
    // so the sticky 70px navbar never covers it. Keying on `key` (not just
    // pathname+hash) means re-clicking the same anchor link scrolls again.
    if (hash) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname, hash, key]);
  return null;
}

function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route element={<PageTransition />}>
            <Route index element={<Home />} />
            <Route path="about" element={<About />} />
            <Route path="sevas" element={<Sevas />} />
            <Route path="events" element={<Events />} />
            {/* Gallery hidden: <Route path="gallery" element={<Gallery />} /> */}
            <Route path="donations" element={<Donations />} />
            <Route path="contact" element={<Contact />} />
            <Route path="panchangam" element={<PanchangCalendar />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}

export default App;
