import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";
import { AuthError, useAuth } from "./AuthContext";
import { useLang } from "./LangContext";
import { useToast } from "./ToastContext";
import { NOTIFICATION_CHANNEL } from "../lib/notifications";

/**
 * NotificationContext — the signed-in devotee's bell (SPEC §7.1).
 *
 * WHY A POLL. The site runs on shared hosting: no WebSocket server, and a
 * Server-Sent Events stream would hold one PHP worker per open tab. So the bell
 * asks GET /notifications/unread (one indexed COUNT) every 30 seconds while the
 * tab is visible, and again the moment the tab comes back into view, the window
 * regains focus or the connection returns. A Web Push arriving through the
 * service worker, or a change made in another tab, refreshes at once.
 *
 * WHAT IS HELD HERE. The unread count and the newest ten notifications — what
 * the panel shows. The /notifications page keeps its own longer list and calls
 * the mutations below, so the badge and every open tab stay in step with it.
 *
 * `revision` goes up whenever something changed that this tab did not do
 * itself (a new message, another tab, another device). The page watches it to
 * merge fresh rows into its list without a reload.
 */
const NotificationContext = createContext(null);

const POLL_MS = 30_000;
const PANEL_LIMIT = 10;
const MAX_IDS_PER_REQUEST = 200; // the API's cap per bulk action

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function uniqueIds(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** The same error shape AuthContext's calls throw, so callers read one kind of failure. */
function asAuthError(err) {
  if (err instanceof AuthError) return err;
  const res = err?.response;
  if (!res) {
    return new AuthError("Could not reach the temple server. Check your connection and try again.", { code: "network" });
  }
  const data = res.data ?? {};
  return new AuthError(data.error || data.message || "Something went wrong. Please try again.", {
    fields: data.fields ?? {},
    code: data.code ?? null,
    status: res.status,
  });
}

export function NotificationProvider({ children }) {
  const { user, ready, accountsEnabled, get, refresh: refreshAuth } = useAuth();

  /**
   * POST with the devotee's CSRF token. AuthContext keeps its token private and
   * offers no general post(), so the bell reads the same token from /auth/me. The
   * server creates that token once per session and returns the one value every
   * time, so reading it never invalidates AuthContext's copy. A 419 means the
   * session changed under the tab (it expired, or signed in elsewhere): read the
   * token again and try once more.
   */
  const csrfRef = useRef({ owner: null, token: "" });
  const sessionOwner = user?.id ?? null;
  const post = useCallback(
    async (path, body = {}, retry = true) => {
      if (!csrfRef.current.token || csrfRef.current.owner !== sessionOwner) {
        const me = await get("/auth/me");
        csrfRef.current = { owner: sessionOwner, token: me?.csrf ?? "" };
      }
      try {
        const { data } = await api.post(path, body, { headers: { "X-CSRF-Token": csrfRef.current.token } });
        return data;
      } catch (err) {
        if (retry && err?.response?.status === 419) {
          csrfRef.current = { owner: null, token: "" };
          return post(path, body, false);
        }
        throw asAuthError(err);
      }
    },
    [get, sessionOwner],
  );
  const { t } = useLang();
  const toast = useToast();

  const [disabled, setDisabled] = useState(false);
  const [unread, setUnread] = useState(0);
  const [latest, setLatest] = useState([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);

  const userId = user?.id ?? null;
  const enabled = Boolean(ready && accountsEnabled && userId && !disabled);

  // Refs mirror the state the async code reads, so a poll that resolves after a
  // re-render compares against what is on screen now, not what was there when it
  // started.
  const enabledRef = useRef(enabled);
  const unreadRef = useRef(0);
  const latestRef = useRef([]);
  const latestIdRef = useRef(null);
  const loadedRef = useRef(false);
  const sessionRef = useRef(0);
  const inflightRef = useRef(null);
  const againRef = useRef(false);
  const pollingRef = useRef(false);
  const channelRef = useRef(null);
  const tRef = useRef(t);
  const authRetryRef = useRef(0);

  useEffect(() => {
    enabledRef.current = enabled;
    tRef.current = t;
  });

  const commitUnread = useCallback((value) => {
    const n = Math.max(0, Number(value) || 0);
    unreadRef.current = n;
    setUnread(n);
  }, []);

  const commitLatest = useCallback((next) => {
    const value = typeof next === "function" ? next(latestRef.current) : next;
    latestRef.current = value;
    setLatest(value);
  }, []);

  // A different devotee (or none) means a clean slate: nothing of the previous
  // account may linger in the bell, and answers still in flight are discarded.
  useEffect(() => {
    sessionRef.current += 1;
    loadedRef.current = false;
    latestIdRef.current = null;
    inflightRef.current = null;
    againRef.current = false;
    commitUnread(0);
    commitLatest([]);
    setStatus("idle");
    setError(null);
    setDisabled(false);
  }, [userId, commitUnread, commitLatest]);

  /**
   * What a failed call means for the bell as a whole. 503 notifications_disabled:
   * the tables are not migrated, so the bell disappears rather than showing an
   * error forever. 401: the session ended while the tab was open — ask
   * AuthContext, which signs the tab out, and the provider then stops.
   */
  const noteFailure = useCallback(
    (err) => {
      if (err?.status === 503 && err?.code === "notifications_disabled") {
        setDisabled(true);
        return;
      }
      if (err?.status === 401 && Date.now() - authRetryRef.current > 10_000) {
        authRetryRef.current = Date.now();
        refreshAuth();
      }
    },
    [refreshAuth],
  );

  const fetchOnce = useCallback(async () => {
    const session = sessionRef.current;
    if (!loadedRef.current) setStatus("loading");
    try {
      const [count, list] = await Promise.all([
        get("/notifications/unread"),
        get(`/notifications/list?limit=${PANEL_LIMIT}`),
      ]);
      if (session !== sessionRef.current) return;
      latestIdRef.current = count?.latestId ?? null;
      commitUnread(count?.unread ?? list?.unread ?? 0);
      commitLatest(Array.isArray(list?.items) ? list.items : []);
      loadedRef.current = true;
      setStatus("ready");
      setError(null);
    } catch (err) {
      if (session !== sessionRef.current) return;
      noteFailure(err);
      setError(err);
      // A background refresh that fails keeps what is already on screen; only a
      // bell that has never loaded shows the error state.
      if (!loadedRef.current) setStatus("error");
    }
  }, [get, commitUnread, commitLatest, noteFailure]);

  /**
   * Unread count + newest ten. Calls that arrive while one is in flight join it,
   * and it runs once more at the end, so a change made mid-request is never
   * missed and two refreshes never race each other onto the screen.
   */
  const refresh = useCallback(() => {
    if (!enabledRef.current) return Promise.resolve();
    if (inflightRef.current) {
      againRef.current = true;
      return inflightRef.current;
    }
    const run = (async () => {
      do {
        againRef.current = false;
        await fetchOnce();
      } while (againRef.current && enabledRef.current);
    })().finally(() => {
      inflightRef.current = null;
    });
    inflightRef.current = run;
    return run;
  }, [fetchOnce]);

  /** The cheap check. Only when something moved is the list fetched. */
  const poll = useCallback(async () => {
    if (!enabledRef.current || document.visibilityState !== "visible") return;
    if (pollingRef.current || inflightRef.current) return;
    if (!loadedRef.current) {
      // The bell's first load failed. Now that it has worked, whatever else on
      // screen was loaded meanwhile (the page's list) may be out of date too.
      await refresh();
      if (loadedRef.current) setRevision((r) => r + 1);
      return;
    }
    pollingRef.current = true;
    const session = sessionRef.current;
    try {
      const count = await get("/notifications/unread");
      if (session !== sessionRef.current) return;
      // The count as well as the newest id: a message read on another device
      // changes the count without anything new arriving.
      if ((count?.latestId ?? null) !== latestIdRef.current || (count?.unread ?? 0) !== unreadRef.current) {
        await refresh();
        setRevision((r) => r + 1);
      }
    } catch (err) {
      noteFailure(err);
    } finally {
      pollingRef.current = false;
    }
  }, [get, refresh, noteFailure]);

  const broadcast = useCallback(() => {
    try {
      channelRef.current?.postMessage({ type: "changed" });
    } catch {
      /* a closed channel only means no other tab is listening */
    }
  }, []);

  // Lifecycle: first load, the 30-second poll, and every "look again" signal.
  useEffect(() => {
    if (!enabled) return undefined;
    refresh();

    const timer = window.setInterval(poll, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    const external = () => {
      refresh();
      setRevision((r) => r + 1);
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", poll);
    window.addEventListener("online", poll);

    let channel = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(NOTIFICATION_CHANNEL);
      channel.onmessage = (e) => {
        if (e?.data?.type === "changed") external();
      };
      channelRef.current = channel;
    }

    // push-sw.js tells every open client when a push arrives (SPEC §7.4).
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : null;
    const onSwMessage = (e) => {
      if (e?.data?.type === "notification-received") external();
    };
    sw?.addEventListener?.("message", onSwMessage);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", poll);
      window.removeEventListener("online", poll);
      sw?.removeEventListener?.("message", onSwMessage);
      if (channel) {
        channel.close();
        if (channelRef.current === channel) channelRef.current = null;
      }
    };
  }, [enabled, refresh, poll]);

  /** A failure message the devotee can act on, in their language. */
  const failureMessage = useCallback((err) => {
    const tr = tRef.current;
    if (err?.code === "network") {
      return tr(
        "கோயில் சேவையகத்தை அடைய முடியவில்லை. இணைப்பை சரிபார்த்து மீண்டும் முயற்சிக்கவும்.",
        "Could not reach the temple server. Check your connection and try again.",
      );
    }
    if (err?.status === 429) {
      return tr(
        "குறுகிய நேரத்தில் பல மாற்றங்கள். ஒரு நிமிடம் கழித்து முயற்சிக்கவும்.",
        "That was a lot of changes in a short time. Please wait a minute and try again.",
      );
    }
    return tr(
      "அறிவிப்புகளை மாற்ற முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",
      "Your notifications could not be updated. Please try again.",
    );
  }, []);

  /**
   * Every change goes through here: apply it on screen first, send it, take the
   * server's unread count as the truth, tell the other tabs. On failure, put the
   * bell back exactly as it was, say so, and rethrow so a caller holding its
   * own copy (the page) can roll that back too.
   */
  const mutate = useCallback(
    async (action, ids, optimistic) => {
      const snapshot = { latest: latestRef.current, unread: unreadRef.current };
      optimistic?.();
      try {
        let data = null;
        if (ids === null) {
          data = await post(`/notifications/${action}`, {});
        } else {
          for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
            data = await post(`/notifications/${action}`, { ids: ids.slice(i, i + MAX_IDS_PER_REQUEST) });
          }
        }
        if (data && typeof data.unread === "number") commitUnread(data.unread);
        broadcast();
        return data;
      } catch (err) {
        commitLatest(snapshot.latest);
        commitUnread(snapshot.unread);
        noteFailure(err);
        toast.error(failureMessage(err));
        throw err;
      }
    },
    [post, broadcast, commitLatest, commitUnread, noteFailure, failureMessage, toast],
  );

  /** How many of `ids` currently count towards the badge, from the bell's list and any rows the caller knows. */
  const countWhere = (ids, known, predicate) => {
    const byId = new Map();
    for (const item of known ?? []) byId.set(item.id, item);
    for (const item of latestRef.current) byId.set(item.id, item);
    return ids.reduce((n, id) => (byId.has(id) && predicate(byId.get(id)) ? n + 1 : n), 0);
  };
  const countsTowardBadge = (item) => !item.isRead && !item.isArchived;

  const markRead = useCallback(
    (ids, known) => {
      const list = uniqueIds(ids);
      if (!list.length) return Promise.resolve(null);
      const set = new Set(list);
      return mutate("read", list, () => {
        const delta = countWhere(list, known, countsTowardBadge);
        const at = nowIso();
        commitLatest((items) => items.map((i) => (set.has(i.id) && !i.isRead ? { ...i, isRead: true, readAt: at } : i)));
        commitUnread(unreadRef.current - delta);
      });
    },
    [mutate, commitLatest, commitUnread],
  );

  const markUnread = useCallback(
    (ids, known) => {
      const list = uniqueIds(ids);
      if (!list.length) return Promise.resolve(null);
      const set = new Set(list);
      return mutate("unread", list, () => {
        const delta = countWhere(list, known, (i) => i.isRead && !i.isArchived);
        commitLatest((items) => items.map((i) => (set.has(i.id) && i.isRead ? { ...i, isRead: false, readAt: null } : i)));
        commitUnread(unreadRef.current + delta);
      });
    },
    [mutate, commitLatest, commitUnread],
  );

  const markAllRead = useCallback(() => {
    const at = nowIso();
    return mutate("read-all", null, () => {
      commitLatest((items) => items.map((i) => (i.isRead ? i : { ...i, isRead: true, readAt: at })));
      commitUnread(0);
    });
  }, [mutate, commitLatest, commitUnread]);

  // After rows leave the bell's list, read the newest ten again in the
  // background, so the panel fills back up instead of shrinking row by row.
  const refill = useCallback(
    (data) => {
      refresh();
      return data;
    },
    [refresh],
  );

  // Archived and deleted rows leave the bell's list (it shows the inbox only).
  const archive = useCallback(
    (ids, known) => {
      const list = uniqueIds(ids);
      if (!list.length) return Promise.resolve(null);
      const set = new Set(list);
      return mutate("archive", list, () => {
        const delta = countWhere(list, known, countsTowardBadge);
        commitLatest((items) => items.filter((i) => !set.has(i.id)));
        commitUnread(unreadRef.current - delta);
      }).then(refill);
    },
    [mutate, commitLatest, commitUnread, refill],
  );

  const unarchive = useCallback(
    async (ids) => {
      const list = uniqueIds(ids);
      if (!list.length) return null;
      const data = await mutate("unarchive", list);
      // Restored rows may belong among the newest ten; only the server knows where.
      refresh();
      return data;
    },
    [mutate, refresh],
  );

  const remove = useCallback(
    (ids, known) => {
      const list = uniqueIds(ids);
      if (!list.length) return Promise.resolve(null);
      const set = new Set(list);
      return mutate("delete", list, () => {
        const delta = countWhere(list, known, countsTowardBadge);
        commitLatest((items) => items.filter((i) => !set.has(i.id)));
        commitUnread(unreadRef.current - delta);
      }).then(refill);
    },
    [mutate, commitLatest, commitUnread, refill],
  );

  /**
   * Opening a notification: mark it read and record the click (POST click), then
   * hand back the link for the caller to follow. If the click cannot be recorded
   * the devotee still gets where they were going — the stored link is the same
   * one the server would return.
   */
  const open = useCallback(
    async (item) => {
      const id = Number(item?.id);
      if (!Number.isInteger(id) || id < 1) return null;
      const snapshot = { latest: latestRef.current, unread: unreadRef.current };
      if (!item.isRead) {
        const at = nowIso();
        commitLatest((items) => items.map((i) => (i.id === id ? { ...i, isRead: true, readAt: at } : i)));
        if (!item.isArchived) commitUnread(unreadRef.current - 1);
      }
      try {
        const data = await post("/notifications/click", { id });
        if (typeof data?.unread === "number") commitUnread(data.unread);
        broadcast();
        return data?.url ?? null;
      } catch (err) {
        if (err?.status === 404) {
          // Deleted in another tab, or never visible: take it off the list.
          commitLatest((items) => items.filter((i) => i.id !== id));
          commitUnread(snapshot.unread - (item.isRead || item.isArchived ? 0 : 1));
          toast.info(tRef.current("இந்த அறிவிப்பு இப்போது இல்லை.", "That notification is no longer available."));
          return null;
        }
        commitLatest(snapshot.latest);
        commitUnread(snapshot.unread);
        noteFailure(err);
        return item.ctaUrl ?? null;
      }
    },
    [post, broadcast, commitLatest, commitUnread, noteFailure, toast],
  );

  const value = useMemo(
    () => ({
      enabled,
      unread,
      latest,
      status,
      error,
      revision,
      refresh,
      markRead,
      markUnread,
      markAllRead,
      archive,
      unarchive,
      remove,
      open,
    }),
    [enabled, unread, latest, status, error, revision, refresh, markRead, markUnread, markAllRead, archive, unarchive, remove, open],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationProvider>");
  return ctx;
}
