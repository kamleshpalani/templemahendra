import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  LuArchive,
  LuArchiveRestore,
  LuBellRing,
  LuCheckCheck,
  LuMailOpen,
  LuSearch,
  LuSettings,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import SegmentedControl from "../components/ui/Tabs";
import { Chip, Field } from "../components/ui/Field";
import { EmptyState, ErrorState } from "../components/ui/Feedback";
import NotificationItem, { NotificationSkeleton, useNow } from "../components/Notifications/NotificationItem";
import "../components/Notifications/Notifications.css";
import { useAuth } from "../context/AuthContext";
import { useLang } from "../context/LangContext";
import { useNotifications } from "../context/NotificationContext";
import { GROUP_LABELS, groupByTime, isOlder, localIsoDate, pickLabel } from "../lib/notifications";
import "./Notifications.css";

const STATUSES = ["all", "unread", "read", "archived"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_RE = /^[a-z0-9_]{1,32}$/;
const PAGE_SIZE = 20;
const MERGE_MAX = 50; // the API's largest page

/**
 * The filters live in the address bar (SPEC §7.3), so a filtered view survives a
 * reload, the back button undoes a filter, and a devotee can bookmark "unread
 * bookings". Anything malformed in the URL is dropped here rather than sent on
 * to earn a 422.
 */
function readFilters(params) {
  const rawStatus = params.get("status");
  const status = STATUSES.includes(rawStatus) ? rawStatus : "all";
  const categories = [
    ...new Set(
      (params.get("category") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((k) => CATEGORY_RE.test(k)),
    ),
  ].slice(0, 30);
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  let from = DATE_RE.test(params.get("from") ?? "") ? params.get("from") : "";
  let to = DATE_RE.test(params.get("to") ?? "") ? params.get("to") : "";
  if (from && to && from > to) [from, to] = [to, from];
  return { status, categories, q, from, to };
}

/** The filters as URL parameters, leaving out every default so a clean view has a clean address. */
function filterParams(f) {
  const p = new URLSearchParams();
  if (f.status !== "all") p.set("status", f.status);
  if (f.categories.length) p.set("category", f.categories.join(","));
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p;
}

function listQuery(f, { limit = PAGE_SIZE, cursor } = {}) {
  const p = filterParams(f);
  p.set("limit", String(limit));
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

/** The same change on this page's own copy of the list, before the server answers. */
function applyLocal(list, action, ids, status) {
  const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  switch (action) {
    case "read":
      return list.map((i) => (ids.has(i.id) && !i.isRead ? { ...i, isRead: true, readAt: at } : i));
    case "unread":
      return list.map((i) => (ids.has(i.id) && i.isRead ? { ...i, isRead: false, readAt: null } : i));
    case "archive":
      return status === "archived" ? list : list.filter((i) => !ids.has(i.id));
    case "unarchive":
      return status === "archived"
        ? list.filter((i) => !ids.has(i.id))
        : list.map((i) => (ids.has(i.id) ? { ...i, isArchived: false, archivedAt: null } : i));
    case "delete":
      return list.filter((i) => !ids.has(i.id));
    default:
      return list;
  }
}

export default function Notifications() {
  const { t, lang } = useLang();
  const { get } = useAuth();
  const { unread, revision, refresh, open, markRead, markUnread, markAllRead, archive, unarchive, remove } =
    useNotifications();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const query = listQuery(filters);
  const now = useNow();

  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [more, setMore] = useState("idle"); // idle | loading | error
  const [selected, setSelected] = useState(() => new Set());
  const [categories, setCategories] = useState([]);
  const [draft, setDraft] = useState(filters.q);
  const [dates, setDates] = useState({ from: filters.from, to: filters.to });
  const [dateError, setDateError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [announce, setAnnounce] = useState("");

  const itemsRef = useRef(items);
  const filtersRef = useRef(filters);
  const reqRef = useRef(0);
  const moreBusyRef = useRef(false);
  const sentinelRef = useRef(null);
  const selectAllRef = useRef(null);
  const seenRevision = useRef(revision);

  useEffect(() => {
    itemsRef.current = items;
    filtersRef.current = filters;
  });

  const applyFilters = useCallback(
    (patch, { replace = false } = {}) => {
      setParams(filterParams({ ...filtersRef.current, ...patch }), { replace });
    },
    [setParams],
  );

  // What each notification can be about, for the category chips. Without it the
  // page still works; the chips simply do not appear.
  useEffect(() => {
    let alive = true;
    get("/notifications/categories")
      .then((data) => {
        if (alive) setCategories(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [get]);

  /** The first page for the current filters. Every newer request supersedes an older one. */
  const loadFirst = useCallback(async () => {
    const req = ++reqRef.current;
    moreBusyRef.current = false;
    setPhase("loading");
    setMore("idle");
    setSelected(new Set());
    try {
      const data = await get(`/notifications/list?${query}`);
      if (req !== reqRef.current) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setCursor(data?.nextCursor ?? null);
      setPhase("ready");
    } catch {
      if (req !== reqRef.current) return;
      setItems([]);
      setCursor(null);
      setPhase("error");
    }
  }, [get, query]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  /**
   * The next page. Keyset paging means a notification arriving meanwhile cannot
   * shift the page, but ids are still de-duplicated: a row merged in from the
   * top by another tab's change must not appear twice.
   */
  const loadMore = useCallback(async () => {
    if (!cursor || moreBusyRef.current) return;
    moreBusyRef.current = true;
    const req = reqRef.current;
    setMore("loading");
    try {
      const data = await get(`/notifications/list?${listQuery(filtersRef.current, { cursor })}`);
      if (req !== reqRef.current) return;
      const incoming = Array.isArray(data?.items) ? data.items : [];
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...incoming.filter((i) => !seen.has(i.id))];
      });
      setCursor(data?.nextCursor ?? null);
      setMore("idle");
    } catch {
      if (req === reqRef.current) setMore("error");
    } finally {
      if (req === reqRef.current) moreBusyRef.current = false;
    }
  }, [cursor, get]);

  // Infinite scroll. The observer is rebuilt after every page, so if the new rows
  // still leave the sentinel in view (a tall screen) the next page follows on
  // its own. The "Load more" button stays as the path for everything else.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !cursor || more !== "idle" || phase !== "ready" || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, more, phase, loadMore]);

  // Archiving or deleting the last rows on screen should not strand the devotee
  // on an empty page while more wait on the server.
  useEffect(() => {
    if (phase === "ready" && items.length === 0 && cursor) loadFirst();
  }, [phase, items.length, cursor, loadFirst]);

  /**
   * Something changed that this tab did not do: a new message, or another tab.
   * Re-read the top of the list and merge it in without resetting the scroll:
   * rows the fresh page covers are replaced by it, and older rows already
   * loaded below it stay where they are.
   */
  const mergeFresh = useCallback(async () => {
    const req = reqRef.current;
    const loaded = itemsRef.current.length;
    const size = Math.min(MERGE_MAX, Math.max(PAGE_SIZE, loaded));
    try {
      const data = await get(`/notifications/list?${listQuery(filtersRef.current, { limit: size })}`);
      if (req !== reqRef.current) return;
      const head = Array.isArray(data?.items) ? data.items : [];
      const hasMore = Boolean(data?.nextCursor);
      let next = head;
      if (hasMore && head.length > 0) {
        const headIds = new Set(head.map((i) => i.id));
        const last = head[head.length - 1];
        next = [...head, ...itemsRef.current.filter((i) => !headIds.has(i.id) && isOlder(i, last))];
      }
      setItems(next);
      if (!hasMore) setCursor(null);
      else if (loaded <= size) setCursor(data.nextCursor);
      const present = new Set(next.map((i) => i.id));
      setSelected((s) => new Set([...s].filter((id) => present.has(id))));
    } catch {
      /* the list on screen stays as it is; the next change will try again */
    }
  }, [get]);

  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    if (phase === "ready") mergeFresh();
  }, [revision, phase, mergeFresh]);

  // The search box follows the URL when it changes from outside (back button),
  // without fighting a devotee who is still typing.
  useEffect(() => {
    setDraft((d) => (d.trim() === filters.q ? d : filters.q));
  }, [filters.q]);

  useEffect(() => {
    setDates({ from: filters.from, to: filters.to });
    setDateError("");
  }, [filters.from, filters.to]);

  // Debounced search: 300 ms after the last keystroke.
  useEffect(() => {
    const next = draft.trim().slice(0, 100);
    if (next === filtersRef.current.q) return undefined;
    const id = window.setTimeout(() => applyFilters({ q: next }, { replace: true }), 300);
    return () => window.clearTimeout(id);
  }, [draft, applyFilters]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && selected.size < items.length;
    }
  }, [selected, items.length]);

  const actions = useMemo(
    () => ({ read: markRead, unread: markUnread, archive, unarchive, delete: remove }),
    [markRead, markUnread, archive, unarchive, remove],
  );

  const doneMessage = useCallback(
    (action, n) => {
      const messages = {
        read: [`${n} படித்ததாகக் குறிக்கப்பட்டது.`, `${n} marked as read.`],
        unread: [`${n} படிக்காததாகக் குறிக்கப்பட்டது.`, `${n} marked as unread.`],
        archive: [`${n} காப்பகத்தில் வைக்கப்பட்டது.`, `${n} archived.`],
        unarchive: [`${n} உள்பெட்டிக்கு மீட்டெடுக்கப்பட்டது.`, `${n} moved back to your inbox.`],
        delete: [`${n} நீக்கப்பட்டது.`, `${n} deleted.`],
      }[action];
      return messages ? t(messages[0], messages[1]) : "";
    },
    [t],
  );

  /**
   * One change to one or many rows: this page's list first, then the context
   * (which updates the badge, tells other tabs, and toasts on failure). If the
   * server refuses, the page's list goes back exactly as it was.
   */
  const runAction = useCallback(
    async (action, targets) => {
      const run = actions[action];
      if (!run || !targets.length) return false;
      const ids = new Set(targets.map((i) => i.id));
      const snapshot = itemsRef.current;
      setItems((list) => applyLocal(list, action, ids, filtersRef.current.status));
      if (action === "archive" || action === "unarchive" || action === "delete") {
        setSelected((s) => new Set([...s].filter((id) => !ids.has(id))));
      }
      try {
        await run([...ids], targets);
        setAnnounce(doneMessage(action, ids.size));
        return true;
      } catch {
        setItems(snapshot);
        return false;
      }
    },
    [actions, doneMessage],
  );

  const openItem = useCallback(
    (item) => {
      if (!item.isRead) setItems((list) => list.map((i) => (i.id === item.id ? { ...i, isRead: true } : i)));
      return open(item);
    },
    [open],
  );

  const onItemAction = useCallback((action, item) => runAction(action, [item]), [runAction]);

  const toggleOne = useCallback((item, checked) => {
    setSelected((s) => {
      const next = new Set(s);
      if (checked) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  }, []);

  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)));

  const bulk = async (action) => {
    const targets = itemsRef.current.filter((i) => selected.has(i.id));
    setBulkBusy(action);
    const ok = await runAction(action, targets);
    setBulkBusy(null);
    if (ok) setSelected(new Set());
  };

  const closeConfirm = useCallback(() => setConfirmOpen(false), []);
  const confirmDelete = () => {
    setConfirmOpen(false);
    bulk("delete");
  };

  const onMarkAll = async () => {
    setMarkingAll(true);
    const snapshot = itemsRef.current;
    setItems((list) => list.map((i) => (i.isRead ? i : { ...i, isRead: true })));
    try {
      await markAllRead();
      setAnnounce(t("அனைத்து அறிவிப்புகளும் படித்ததாகக் குறிக்கப்பட்டன.", "All notifications marked as read."));
    } catch {
      setItems(snapshot);
    } finally {
      setMarkingAll(false);
    }
  };

  const onDate = (key, value) => {
    const next = { ...dates, [key]: value };
    setDates(next);
    if (value && !DATE_RE.test(value)) return;
    if (next.from && next.to && next.from > next.to) {
      setDateError(t("முடிவுத் தேதி தொடக்கத் தேதிக்கு முன் உள்ளது.", "The end date is before the start date."));
      return;
    }
    setDateError("");
    applyFilters({ from: next.from, to: next.to }, { replace: true });
  };

  const hasFilters = filters.categories.length > 0 || Boolean(filters.q) || Boolean(filters.from) || Boolean(filters.to);

  const clearFilters = () => {
    setDraft("");
    setDates({ from: "", to: "" });
    setDateError("");
    applyFilters({ status: "all", categories: [], q: "", from: "", to: "" });
  };

  const toggleCategory = (key) => {
    const set = new Set(filters.categories);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    applyFilters({ categories: [...set] });
  };

  const groups = useMemo(() => groupByTime(items, now), [items, now]);
  const today = localIsoDate(now);
  const selectedCount = selected.size;

  const statusItems = [
    { value: "all", label: t("அனைத்தும்", "All") },
    { value: "unread", label: t("படிக்காதவை", "Unread") },
    { value: "read", label: t("படித்தவை", "Read") },
    { value: "archived", label: t("காப்பகம்", "Archived") },
  ];

  const lead =
    unread > 0
      ? t(`${unread} அறிவிப்புகள் இன்னும் படிக்கப்படவில்லை.`, `You have ${unread} unread ${unread === 1 ? "notification" : "notifications"}.`)
      : t("எல்லாவற்றையும் படித்துவிட்டீர்கள்.", "You're all caught up.");

  let emptyView = null;
  if (hasFilters) {
    emptyView = (
      <EmptyState
        className="notif-empty notif-empty--filtered"
        icon={<LuSearch />}
        title={t("இந்த வடிகட்டிகளுக்கு அறிவிப்புகள் இல்லை", "No notifications match these filters")}
        action={
          <Button variant="outline" icon={<LuX aria-hidden="true" />} onClick={clearFilters}>
            {t("வடிகட்டிகளை அழி", "Clear filters")}
          </Button>
        }
      >
        {t(
          "வேறு சொல், வேறு வகை அல்லது பரந்த தேதி வரம்பை முயற்சிக்கவும்.",
          "Try another word, a different category or a wider date range.",
        )}
      </EmptyState>
    );
  } else if (filters.status === "unread") {
    emptyView = (
      <EmptyState className="notif-empty" icon={<LuCheckCheck />} title={t("படிக்காத அறிவிப்புகள் இல்லை", "No unread notifications")}>
        {t("எல்லாவற்றையும் படித்துவிட்டீர்கள். புதிய செய்திகள் இங்கே தோன்றும்.", "You have read everything. New messages will appear here.")}
      </EmptyState>
    );
  } else if (filters.status === "read") {
    emptyView = (
      <EmptyState className="notif-empty" icon={<LuMailOpen />} title={t("இன்னும் எதுவும் படிக்கப்படவில்லை", "Nothing read yet")}>
        {t("நீங்கள் திறக்கும் அறிவிப்புகள் இங்கே இருக்கும்.", "Notifications you open will be kept here.")}
      </EmptyState>
    );
  } else if (filters.status === "archived") {
    emptyView = (
      <EmptyState className="notif-empty" icon={<LuArchive />} title={t("காப்பகத்தில் எதுவும் இல்லை", "Nothing archived")}>
        {t(
          "ஒரு அறிவிப்பை நீக்காமல் உள்பெட்டியிலிருந்து அகற்ற, அதைக் காப்பகத்தில் வைக்கவும்.",
          "Archive a notification to keep it out of your inbox without deleting it.",
        )}
      </EmptyState>
    );
  } else {
    emptyView = (
      <EmptyState
        className="notif-empty"
        icon={<LuBellRing />}
        title={t("எல்லாம் பார்த்துவிட்டீர்கள்", "You're all caught up")}
        action={
          <Button to="/account?tab=notifications" variant="outline" icon={<LuSettings aria-hidden="true" />}>
            {t("அறிவிப்பு அமைப்புகள்", "Notification settings")}
          </Button>
        }
      >
        {t(
          "சேவை உறுதிப்படுத்தல்கள், ரசீதுகள் மற்றும் கோயில் அறிவிப்புகள் இங்கே தோன்றும்.",
          "Booking confirmations, receipts and temple announcements will appear here.",
        )}
      </EmptyState>
    );
  }

  return (
    <>
      <Seo title={t("அறிவிப்புகள்", "Notifications")} robots="noindex, nofollow" />

      <PageHero
        className="notif-head"
        eyebrow={t("என் கணக்கு", "My account")}
        title={t("அறிவிப்புகள்", "Notifications")}
        lead={lead}
        crumbs={[{ label: t("என் கணக்கு", "My account"), to: "/account" }, { label: t("அறிவிப்புகள்", "Notifications") }]}
        actions={
          <>
            <Button
              variant="gold"
              data-action="mark-all"
              icon={<LuCheckCheck aria-hidden="true" />}
              onClick={onMarkAll}
              disabled={unread === 0}
              loading={markingAll}
            >
              {t("அனைத்தையும் படித்ததாகக் குறி", "Mark all as read")}
            </Button>
            <Button to="/account?tab=notifications" variant="outline-light" icon={<LuSettings aria-hidden="true" />}>
              {t("அமைப்புகள்", "Settings")}
            </Button>
          </>
        }
      />

      <section className="section section--tight notif-page">
        <div className="container container--narrow">
          {/* ── Filters ─────────────────────────────────────────────── */}
          <div className="card card--static notif-toolbar">
            <div className="notif-toolbar__top">
              <form
                role="search"
                className="notif-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  applyFilters({ q: draft.trim().slice(0, 100) }, { replace: true });
                }}
              >
                <span className="input-affix input-affix--leading notif-search__field">
                  <span className="input-affix__icon" aria-hidden="true">
                    <LuSearch />
                  </span>
                  <input
                    type="search"
                    value={draft}
                    maxLength={100}
                    onChange={(e) => setDraft(e.target.value)}
                    aria-label={t("அறிவிப்புகளில் தேடு", "Search notifications")}
                    placeholder={t("தலைப்பு அல்லது செய்தியில் தேடு…", "Search titles and messages…")}
                    autoComplete="off"
                    spellCheck="false"
                  />
                </span>
              </form>
              <SegmentedControl
                className="notif-status"
                label={t("எவற்றைக் காட்ட வேண்டும்", "Show")}
                value={filters.status}
                onChange={(value) => applyFilters({ status: value })}
                items={statusItems}
              />
            </div>

            {categories.length > 0 && (
              <div className="notif-cats" role="group" aria-label={t("வகைகள்", "Categories")}>
                {categories.map((c) => (
                  <Chip
                    key={c.key}
                    data-category={c.key}
                    active={filters.categories.includes(c.key)}
                    onClick={() => toggleCategory(c.key)}
                  >
                    {pickLabel(c.label, lang)}
                  </Chip>
                ))}
              </div>
            )}

            <div className="notif-dates">
              <Field label={t("இதிலிருந்து", "From")} className="notif-date">
                {(a11y) => (
                  <input
                    type="date"
                    name="from"
                    value={dates.from}
                    max={dates.to || today}
                    onChange={(e) => onDate("from", e.target.value)}
                    {...a11y}
                  />
                )}
              </Field>
              <Field label={t("இதுவரை", "To")} className="notif-date" error={dateError || undefined}>
                {(a11y) => (
                  <input
                    type="date"
                    name="to"
                    value={dates.to}
                    min={dates.from || undefined}
                    max={today}
                    onChange={(e) => onDate("to", e.target.value)}
                    {...a11y}
                  />
                )}
              </Field>
              {hasFilters && (
                <Button variant="ghost" size="sm" className="notif-dates__clear" icon={<LuX aria-hidden="true" />} onClick={clearFilters}>
                  {t("வடிகட்டிகளை அழி", "Clear filters")}
                </Button>
              )}
            </div>
          </div>

          <p className="sr-only" role="status" aria-live="polite">
            {announce}
          </p>

          {/* ── The list ────────────────────────────────────────────── */}
          {phase === "loading" && (
            <>
              <p className="sr-only" role="status">
                {t("அறிவிப்புகள் ஏற்றப்படுகின்றன…", "Loading notifications…")}
              </p>
              <NotificationSkeleton count={5} variant="page" />
            </>
          )}

          {phase === "error" && (
            <ErrorState
              className="notif-error"
              title={t("அறிவிப்புகளை ஏற்ற முடியவில்லை", "Couldn't load your notifications")}
              onRetry={() => {
                // The bell failed with the list; bring both back.
                refresh();
                loadFirst();
              }}
            >
              {t("இணைப்பை சரிபார்த்து மீண்டும் முயற்சிக்கவும்.", "Check your connection and try again.")}
            </ErrorState>
          )}

          {phase === "ready" && items.length === 0 && !cursor && emptyView}

          {phase === "ready" && items.length > 0 && (
            <>
              <div className="notif-listbar">
                <label className="notif-selectall">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="notif-check"
                    checked={allSelected}
                    onChange={toggleAll}
                  />
                  <span>{t("காட்டப்படும் அனைத்தையும் தேர்ந்தெடு", "Select all shown")}</span>
                </label>
                <span className="notif-listbar__count">
                  {t(`${items.length}${cursor ? "+" : ""} அறிவிப்புகள்`, `${items.length}${cursor ? "+" : ""} notifications`)}
                </span>
              </div>

              {selectedCount > 0 && (
                <div className="notif-bulk" role="region" aria-label={t("தேர்ந்தெடுத்தவற்றுக்கான செயல்கள்", "Actions for selected notifications")}>
                  <span className="notif-bulk__count">{t(`${selectedCount} தேர்ந்தெடுக்கப்பட்டன`, `${selectedCount} selected`)}</span>
                  <div className="notif-bulk__actions">
                    <Button
                      size="sm"
                      variant="soft"
                      data-action="read"
                      icon={<LuMailOpen aria-hidden="true" />}
                      onClick={() => bulk("read")}
                      loading={bulkBusy === "read"}
                      disabled={Boolean(bulkBusy)}
                    >
                      {t("படித்ததாகக் குறி", "Mark read")}
                    </Button>
                    {filters.status === "archived" ? (
                      <Button
                        size="sm"
                        variant="soft"
                        data-action="unarchive"
                        icon={<LuArchiveRestore aria-hidden="true" />}
                        onClick={() => bulk("unarchive")}
                        loading={bulkBusy === "unarchive"}
                        disabled={Boolean(bulkBusy)}
                      >
                        {t("உள்பெட்டிக்கு மீட்டெடு", "Move to inbox")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="soft"
                        data-action="archive"
                        icon={<LuArchive aria-hidden="true" />}
                        onClick={() => bulk("archive")}
                        loading={bulkBusy === "archive"}
                        disabled={Boolean(bulkBusy)}
                      >
                        {t("காப்பகத்தில் வை", "Archive")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger"
                      data-action="delete"
                      icon={<LuTrash2 aria-hidden="true" />}
                      onClick={() => setConfirmOpen(true)}
                      loading={bulkBusy === "delete"}
                      disabled={Boolean(bulkBusy)}
                    >
                      {t("நீக்கு", "Delete")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                      {t("தேர்வை அழி", "Clear selection")}
                    </Button>
                  </div>
                </div>
              )}

              {groups.map((group) => (
                <section key={group.key} className="notif-group" aria-labelledby={`notif-group-${group.key}`}>
                  <h2 id={`notif-group-${group.key}`} className="notif-group__title" data-group={group.key}>
                    {t(GROUP_LABELS[group.key].ta, GROUP_LABELS[group.key].en)}
                    <span className="notif-group__count">{group.items.length}</span>
                  </h2>
                  <ul className="notif-list notif-list--page" data-notif-focus="" tabIndex={-1}>
                    {group.items.map((item) => (
                      <NotificationItem
                        key={item.id}
                        item={item}
                        now={now}
                        variant="page"
                        onOpen={openItem}
                        onAction={onItemAction}
                        selectable
                        selected={selected.has(item.id)}
                        onSelect={toggleOne}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}

          {phase === "ready" && cursor && (
            <div className="notif-more">
              <div ref={sentinelRef} className="notif-more__sentinel" aria-hidden="true" />
              {more === "loading" && (
                <>
                  <p className="sr-only" role="status">
                    {t("மேலும் ஏற்றப்படுகிறது…", "Loading more…")}
                  </p>
                  <NotificationSkeleton count={2} variant="page" />
                </>
              )}
              {more === "error" && (
                <p className="notif-more__error" role="alert">
                  {t("மேலும் ஏற்ற முடியவில்லை.", "Couldn't load more.")}
                  <Button size="sm" variant="outline" onClick={loadMore}>
                    {t("மீண்டும் முயற்சி", "Try again")}
                  </Button>
                </p>
              )}
              {more === "idle" && (
                <Button variant="outline" className="notif-more__btn" onClick={loadMore}>
                  {t("மேலும் காட்டு", "Load more")}
                </Button>
              )}
            </div>
          )}

          {phase === "ready" && !cursor && items.length > PAGE_SIZE && (
            <p className="notif-end">{t("அவ்வளவுதான் — எல்லாவற்றையும் பார்த்துவிட்டீர்கள்.", "That's everything.")}</p>
          )}
        </div>
      </section>

      <Modal
        open={confirmOpen}
        onClose={closeConfirm}
        size="sm"
        className="notif-confirm"
        title={t(
          `${selectedCount} அறிவிப்புகளை நீக்கவா?`,
          `Delete ${selectedCount} ${selectedCount === 1 ? "notification" : "notifications"}?`,
        )}
        description={t(
          "நீக்கிய அறிவிப்புகளை மீட்டெடுக்க முடியாது. பின்னர் தேவைப்படலாம் என்றால் காப்பகத்தில் வைக்கவும்.",
          "Deleted notifications cannot be restored. Archive them instead if you may want them later.",
        )}
      >
        <div className="modal__actions">
          <Button variant="ghost" onClick={closeConfirm}>
            {t("ரத்து", "Cancel")}
          </Button>
          <Button variant="danger" data-action="confirm-delete" icon={<LuTrash2 aria-hidden="true" />} onClick={confirmDelete}>
            {t("நீக்கு", "Delete")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
