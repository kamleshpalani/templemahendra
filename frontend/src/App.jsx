import { Routes, Route, Navigate, useLocation, Outlet } from "react-router-dom";
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
const Gallery = lazy(() => import("./pages/Gallery"));
const Donations = lazy(() => import("./pages/Donations"));
const Contact = lazy(() => import("./pages/Contact"));
const PanchangCalendar = lazy(() => import("./pages/PanchangCalendar"));
const Search = lazy(() => import("./pages/Search"));
const Register = lazy(() => import("./pages/Register"));
const Policy = lazy(() => import("./pages/Policy"));
const Donate = lazy(() => import("./pages/Donate"));
const PaymentResult = lazy(() => import("./pages/PaymentResult"));
const PaymentReceipt = lazy(() => import("./pages/PaymentReceipt"));
const ReceiptVerify = lazy(() => import("./pages/ReceiptVerify"));
const LiveDarshan = lazy(() => import("./pages/LiveDarshan"));
const LiveSchedule = lazy(() => import("./pages/LiveSchedule"));
const LiveArchive = lazy(() => import("./pages/LiveArchive"));
const NotFound = lazy(() => import("./pages/NotFound"));

/*
 * Devotee sign-in was removed (docs/registration/SPEC.md §7). These addresses
 * still sit in old emails, bookmarks and forwarded WhatsApp messages, so each
 * one lands on the family registration form instead of the 404 page. `replace`
 * keeps the retired address out of the history, so Back does not bounce the
 * visitor straight into the redirect again.
 */
const RETIRED_ACCOUNT_PATHS = ["login", "account", "notifications", "forgot-password", "reset-password", "verify-email"];

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
  const { pathname, hash, key, state } = useLocation();
  // A navigation that moves within a page and places the view itself (the
  // registration form's ?step= changes) says so in its history state. The
  // state travels with the history entry, so browser Back and Forward between
  // those steps are left alone too.
  const preserveScroll = Boolean(state?.preserveScroll);
  useEffect(() => {
    if (preserveScroll) return;
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
  }, [pathname, hash, key, preserveScroll]);
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
            <Route path="gallery" element={<Gallery />} />
            <Route path="donations" element={<Donations />} />
            <Route path="contact" element={<Contact />} />
            <Route path="panchangam" element={<PanchangCalendar />} />
            <Route path="search" element={<Search />} />
            <Route path="register" element={<Register />} />

            {/* The legal pages the payment gateway requires (docs/payments/SPEC.md §7.1). */}
            <Route path="privacy-policy" element={<Policy slug="privacy" />} />
            <Route path="terms-and-conditions" element={<Policy slug="terms" />} />
            <Route path="refund-cancellation-policy" element={<Policy slug="refunds" />} />
            <Route path="shipping-delivery-policy" element={<Policy slug="shipping" />} />

            {/* Online payments (docs/payments/SPEC.md §7.1). /donate is a public
                page; the three /payment/* addresses belong to one donor's own
                payment, carry a signed token, and are noindex. */}
            <Route path="donate" element={<Donate />} />
            <Route path="payment/result" element={<PaymentResult />} />
            <Route path="payment/receipt" element={<PaymentReceipt />} />
            <Route path="payment/verify" element={<ReceiptVerify />} />

            {/* Live darshan (docs/live/SPEC-PHASE1.md §5.3): the broadcast that
                matters right now, or one broadcast by its slug. */}
            <Route path="live-darshan" element={<LiveDarshan />} />
            {/* The schedule (docs/live/SPEC-PHASE2.md §2.3); `schedule` is a reserved slug, so it never collides. */}
            <Route path="live-darshan/schedule" element={<LiveSchedule />} />
            <Route path="live-darshan/archive" element={<LiveArchive />} />
            <Route path="live-darshan/:slug" element={<LiveDarshan />} />

            {RETIRED_ACCOUNT_PATHS.map((path) => (
              <Route key={path} path={path} element={<Navigate to="/register" replace />} />
            ))}

            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </>
  );
}

export default App;
