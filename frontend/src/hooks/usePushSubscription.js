import { useCallback, useEffect, useRef, useState } from "react";
import api from "../services/api";
import { AuthError } from "../context/AuthContext";

/**
 * usePushSubscription(publicKey) — Web Push on THIS browser, for the signed-in
 * devotee (docs/notifications/SPEC.md §7.4).
 *
 *   const push = usePushSubscription(prefs.channels.push.publicKey);
 *   push.supported   the browser can take a subscription here, now
 *   push.reason      why not, or why it will not work:
 *                      'ios-install-required'     iPhone/iPad Safari outside a home-screen app
 *                      'unsupported'              no Push API in this browser
 *                      'not-configured'           the site has no application server key
 *                      'service-worker-inactive'  no active service worker (always so under `vite dev`)
 *                      'denied'                   the devotee blocked notifications for this site
 *   push.permission  'default' | 'granted' | 'denied'
 *   push.subscribed  this browser holds a subscription made with the current key
 *   push.checking    true while the first look at the browser is under way
 *   push.busy        a subscribe or unsubscribe is running
 *   push.error       the last failure (Error with a `code`, or an AuthError from the API)
 *   push.subscribe() / push.unsubscribe()   resolve to true on success
 *
 * NEVER PROMPT ON LOAD. Browsers now quietly block sites that ask for
 * notification permission before the visitor has done anything, and a devotee
 * who clicks "Block" on a surprise prompt has to dig through settings to undo
 * it. So the permission request lives only inside subscribe(), which must be
 * called straight from a click — before any other await, or Safari discards the
 * user gesture and the prompt never shows.
 */

/* ── POST with the devotee CSRF token ─────────────────────────────────────── */

/*
 * AuthContext keeps its CSRF token private and does not hand out its `post`, so
 * the notification screens fetch the same session token from /auth/csrf and
 * send it the way every other devotee form does. One token per session: it is
 * cached here and refetched once when the server says it is stale (419), which
 * happens after signing out and in again in another tab.
 */
let csrfToken = "";

async function fetchCsrf() {
  const { data } = await api.get("/auth/csrf");
  csrfToken = data?.csrf ?? "";
  return csrfToken;
}

/** The AuthError every devotee screen already knows how to show, plus the raw body (attemptsLeft, retryAfter…). */
function asAuthError(err) {
  const res = err?.response;
  if (!res) {
    return new AuthError("Could not reach the temple server. Check your connection and try again.", { code: "network" });
  }
  const data = res.data ?? {};
  const out = new AuthError(data.error || data.message || "Something went wrong. Please try again.", {
    fields: data.fields ?? {},
    code: data.code ?? null,
    status: res.status,
  });
  out.data = data;
  return out;
}

/** A stable `post(path, body)` that sends X-CSRF-Token and throws AuthError (with `.data`). */
export function useCsrfPost() {
  return useCallback(async (path, body = {}) => {
    const send = async () => {
      if (!csrfToken) await fetchCsrf();
      const { data } = await api.post(path, body, { headers: { "X-CSRF-Token": csrfToken } });
      if (data?.csrf) csrfToken = data.csrf;
      return data;
    };
    try {
      return await send();
    } catch (err) {
      if (err?.response?.status === 419) {
        csrfToken = "";
        try {
          return await send();
        } catch (again) {
          throw asAuthError(again);
        }
      }
      throw err instanceof AuthError ? err : asAuthError(err);
    }
  }, []);
}

/* ── Browser capability checks ────────────────────────────────────────────── */

/** iPhone, iPod, or an iPad (which reports itself as a Mac with a touch screen). */
function isIos() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Opened from the home screen as an installed app, where iOS 16.4+ allows Web Push. */
function isStandalone() {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    /* very old engines */
  }
  return navigator.standalone === true;
}

function hasPushApis() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function currentPermission() {
  try {
    return window.Notification?.permission ?? "default";
  } catch {
    return "default";
  }
}

/** The VAPID public key (base64url, no padding) as the bytes pushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64Url) {
  const padded = String(base64Url).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * True when a subscription was made with this key. A rotated VAPID key makes
 * every old subscription useless (the push service refuses our signature), so
 * such a subscription must be replaced, not reported as "on".
 */
function madeWithKey(subscription, publicKey) {
  const key = subscription?.options?.applicationServerKey;
  if (!key || !publicKey) return true; // browsers that do not expose it: trust the subscription
  const a = new Uint8Array(key);
  const b = urlBase64ToUint8Array(publicKey);
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const settle = (promise, ms) =>
  Promise.race([Promise.resolve(promise).catch(() => undefined), new Promise((r) => setTimeout(() => r(undefined), ms))]);

/**
 * The service worker registration that controls this page, once active.
 *
 * getRegistration() rather than `serviceWorker.ready`: under `vite dev` there is
 * no worker at all and `ready` never settles, which would leave the settings
 * page spinning forever. A worker still installing gets a few seconds to finish.
 */
async function activeRegistration() {
  const sw = navigator.serviceWorker;
  let reg = await settle(sw.getRegistration(), 3000);
  if (!reg) return null;
  if (!reg.active) reg = await settle(sw.ready, 5000);
  return reg?.active && reg.pushManager ? reg : null;
}

/** Notification.requestPermission in both its promise and its older callback form (Safari < 15). */
function requestPermission() {
  return new Promise((resolve) => {
    try {
      const maybe = window.Notification.requestPermission((result) => resolve(result));
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, () => resolve(currentPermission()));
    } catch {
      resolve(currentPermission());
    }
  });
}

function pushError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ── The hook ─────────────────────────────────────────────────────────────── */

export default function usePushSubscription(publicKey) {
  const post = useCsrfPost();
  const [state, setState] = useState({
    checking: true,
    supported: false,
    reason: null,
    permission: "default",
    subscribed: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const mounted = useRef(true);
  const synced = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const update = useCallback((patch) => {
    if (mounted.current) setState((s) => ({ ...s, ...patch }));
  }, []);

  /** Look at the browser as it is now. Never prompts, never subscribes. */
  const inspect = useCallback(async () => {
    // Order matters: each reason is the first thing the devotee would have to fix.
    if (isIos() && !isStandalone()) {
      update({ checking: false, supported: false, reason: "ios-install-required", subscribed: false });
      return;
    }
    if (!hasPushApis()) {
      update({ checking: false, supported: false, reason: "unsupported", subscribed: false });
      return;
    }
    const permission = currentPermission();
    if (!publicKey) {
      update({ checking: false, supported: false, reason: "not-configured", permission, subscribed: false });
      return;
    }
    const reg = await activeRegistration();
    if (!reg) {
      update({ checking: false, supported: false, reason: "service-worker-inactive", permission, subscribed: false });
      return;
    }

    let subscription = null;
    try {
      subscription = await reg.pushManager.getSubscription();
    } catch {
      subscription = null;
    }
    if (subscription && !madeWithKey(subscription, publicKey)) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }

    if (permission === "denied") {
      update({ checking: false, supported: true, reason: "denied", permission, subscribed: false });
      return;
    }

    update({ checking: false, supported: true, reason: null, permission, subscribed: !!subscription });

    // A browser shared by two devotees keeps one subscription. Re-registering it
    // (an idempotent upsert) hands it to whoever is signed in now, and restores a
    // device the server retired while this browser still holds a live endpoint.
    // Silent and at most once per visit; a failure changes nothing on screen.
    if (subscription && permission === "granted" && !synced.current) {
      synced.current = true;
      post("/notifications/devices", { subscription: subscription.toJSON(), platform: "web" }).catch(() => {});
    }
  }, [publicKey, post, update]);

  useEffect(() => {
    inspect();
  }, [inspect]);

  // The devotee may change the permission in the browser's site settings while
  // this page is open; follow it where the Permissions API can tell us.
  useEffect(() => {
    let status = null;
    const onChange = () => inspect();
    try {
      navigator.permissions
        ?.query({ name: "notifications" })
        .then((s) => {
          status = s;
          s.addEventListener?.("change", onChange);
        })
        .catch(() => {});
    } catch {
      /* no Permissions API */
    }
    return () => status?.removeEventListener?.("change", onChange);
  }, [inspect]);

  const subscribe = useCallback(async () => {
    setError(null);
    if (!publicKey) {
      update({ reason: "not-configured" });
      return false;
    }
    if (!hasPushApis()) {
      update({ supported: false, reason: isIos() && !isStandalone() ? "ios-install-required" : "unsupported" });
      return false;
    }
    setBusy(true);
    try {
      // First await of the click handler: the prompt still counts as user-initiated.
      let permission = currentPermission();
      if (permission !== "granted") permission = await requestPermission();
      update({ permission });
      if (permission === "denied") {
        update({ reason: "denied", subscribed: false });
        return false;
      }
      if (permission !== "granted") {
        throw pushError("dismissed", "Notification permission was not given.");
      }

      const reg = await activeRegistration();
      if (!reg) {
        update({ supported: false, reason: "service-worker-inactive" });
        return false;
      }

      let subscription = await reg.pushManager.getSubscription().catch(() => null);
      if (subscription && !madeWithKey(subscription, publicKey)) {
        await subscription.unsubscribe().catch(() => false);
        subscription = null;
      }
      if (!subscription) {
        try {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        } catch (err) {
          if (err?.name === "NotAllowedError") {
            update({ permission: currentPermission(), reason: currentPermission() === "denied" ? "denied" : null });
          }
          throw pushError("subscribe-failed", err?.message || "The browser could not create a push subscription.");
        }
      }

      try {
        await post("/notifications/devices", { subscription: subscription.toJSON(), platform: "web" });
      } catch (err) {
        // The server does not know this endpoint, so nothing would ever arrive.
        // Leaving the browser subscribed would show "on" for a device that is off.
        await subscription.unsubscribe().catch(() => false);
        throw err;
      }
      synced.current = true;
      update({ supported: true, reason: null, subscribed: true });
      return true;
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err : pushError("subscribe-failed", String(err)));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [publicKey, post, update]);

  const unsubscribe = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const reg = hasPushApis() ? await activeRegistration() : null;
      const subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
      if (!subscription) {
        update({ subscribed: false });
        return true;
      }
      const { endpoint } = subscription;
      // The browser first: once its subscription is gone the endpoint is dead,
      // and the push service answers 410 to anything still sent to it — so the
      // device goes quiet even if telling our server fails below.
      await subscription.unsubscribe().catch(() => false);
      update({ subscribed: false });
      await post("/notifications/devices-remove", { endpoint });
      return true;
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err : pushError("unsubscribe-failed", String(err)));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [post, update]);

  return { ...state, busy, error, subscribe, unsubscribe, recheck: inspect };
}
