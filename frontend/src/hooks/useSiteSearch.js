import { useCallback, useEffect, useRef, useState } from "react";
import api from "../services/api";

/**
 * useSiteSearch — debounced calls to /api/search, shared by the Ctrl+K palette
 * and the /search page so both rank and group results identically.
 *
 * Returns { groups, total, status, flat } where status is
 * "idle" | "short" | "loading" | "ready" | "error", and `flat` is every item in
 * display order so a caller can move a highlight through the whole list.
 *
 * An in-flight request is aborted when the query changes, so a slow answer for
 * "abh" can never overwrite the answer for "abhishekam".
 */
const DEBOUNCE_MS = 220;
const MIN_CHARS = 2;

export default function useSiteSearch(query, { enabled = true, limit = 8 } = {}) {
  const [state, setState] = useState({ groups: [], total: 0, status: "idle" });
  const controller = useRef(null);
  const cache = useRef(new Map());

  const run = useCallback(
    async (q) => {
      const key = `${q}|${limit}`;
      if (cache.current.has(key)) {
        setState({ ...cache.current.get(key), status: "ready" });
        return;
      }
      controller.current?.abort();
      controller.current = new AbortController();
      setState((s) => ({ ...s, status: "loading" }));
      try {
        const { data } = await api.get("/search", {
          params: { q, limit },
          signal: controller.current.signal,
        });
        const next = { groups: data.groups ?? [], total: data.total ?? 0 };
        // A handful of recent queries, so backspacing feels instant.
        if (cache.current.size > 24) cache.current.clear();
        cache.current.set(key, next);
        setState({ ...next, status: "ready" });
      } catch (err) {
        // Aborting is the normal path when the query moved on.
        if (err?.name === "CanceledError" || err?.code === "ERR_CANCELED") return;
        setState({ groups: [], total: 0, status: "error" });
      }
    },
    [limit],
  );

  useEffect(() => {
    if (!enabled) return undefined;
    const q = query.trim();
    if (q.length === 0) {
      controller.current?.abort();
      setState({ groups: [], total: 0, status: "idle" });
      return undefined;
    }
    if (q.length < MIN_CHARS) {
      controller.current?.abort();
      setState({ groups: [], total: 0, status: "short" });
      return undefined;
    }
    const id = setTimeout(() => run(q), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, enabled, run]);

  // Abort whatever is in flight when the caller unmounts.
  useEffect(() => () => controller.current?.abort(), []);

  const flat = state.groups.flatMap((g) => g.items.map((item) => ({ ...item, type: g.type })));
  return { ...state, flat, minChars: MIN_CHARS };
}
