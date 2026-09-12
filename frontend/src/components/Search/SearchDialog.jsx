import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LuArrowRight,
  LuCalendarDays,
  LuFileText,
  LuFlame,
  LuImage,
  LuMegaphone,
  LuMoon,
  LuSearch,
  LuX,
} from "react-icons/lu";
import useDialogBehaviour from "../../hooks/useDialogBehaviour";
import useSiteSearch from "../../hooks/useSiteSearch";
import { useLang } from "../../context/LangContext";
import "./SearchDialog.css";

export const GROUP_ICONS = {
  pages: LuFileText,
  sevas: LuFlame,
  events: LuCalendarDays,
  poojas: LuMoon,
  announcements: LuMegaphone,
  gallery: LuImage,
};

const RECENTS_KEY = "temple:recent-searches";
const SUGGESTIONS = [
  { ta: "அபிஷேகம்", en: "Abhishekam" },
  { ta: "பௌர்ணமி", en: "Pournami" },
  { ta: "அன்னதானம்", en: "Annadanam" },
  { ta: "80G ரசீது", en: "80G receipt" },
  { ta: "கோயில் நேரம்", en: "Temple timings" },
  { ta: "வழிகாட்டி", en: "Directions" },
];

/** Recent searches live only in this browser; nothing is sent anywhere. */
function readRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((s) => typeof s === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}
function pushRecent(q) {
  try {
    const next = [q, ...readRecents().filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* private browsing, or storage disabled — recents are a convenience only */
  }
}

/**
 * SearchDialog — the Ctrl+K palette over everything a visitor can read.
 *
 * A combobox, not a list of links: focus stays in the input, the arrows move
 * `active`, and Enter opens the highlighted row. `aria-activedescendant` tells
 * a screen reader which row that is.
 */
export default function SearchDialog({ open, onClose }) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState([]);

  const { groups, total, status, flat, minChars } = useSiteSearch(query, { enabled: open, limit: 6 });

  // A fresh dialog each time: last search cleared, recents re-read.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setRecents(readRecents());
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [total, status]);

  const go = useCallback(
    (url, q) => {
      if (q) pushRecent(q);
      onClose();
      navigate(url);
    },
    [navigate, onClose],
  );

  const openAll = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    pushRecent(q);
    onClose();
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }, [query, navigate, onClose]);

  const onKey = useCallback(
    (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!flat.length) return;
        e.preventDefault();
        setActive((i) => {
          const last = flat.length - 1;
          if (e.key === "ArrowDown") return i >= last ? 0 : i + 1;
          return i <= 0 ? last : i - 1;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flat[active];
        if (item) go(item.url, query.trim());
        else openAll();
      }
    },
    [flat, active, go, query, openAll],
  );

  useDialogBehaviour({ open, onClose, panelRef, initialFocusRef: inputRef, onKey });

  // Keep the highlighted row in view when the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const label = useMemo(
    () => (item) => (lang === "ta" ? item.title_ta || item.title_en : item.title_en || item.title_ta),
    [lang],
  );
  const sub = useMemo(
    () => (item) => (lang === "ta" ? item.sub_ta || item.sub_en : item.sub_en || item.sub_ta),
    [lang],
  );

  if (!open) return null;

  let cursor = -1; // running index across groups, to match `flat`

  return (
    <div className="modal-overlay cmdk-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label={t("தளத்தில் தேடு", "Search the site")}
        tabIndex={-1}
      >
        <div className="cmdk__bar">
          <span className="cmdk__bar-icon" aria-hidden="true">
            <LuSearch />
          </span>
          <input
            ref={inputRef}
            type="text"
            className="cmdk__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("சேவை, நிகழ்வு, பஞ்சாங்கம், பக்கம்…", "Sevas, events, panchangam, pages…")}
            aria-label={t("தேடு", "Search")}
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls="cmdk-list"
            aria-activedescendant={flat.length ? `cmdk-opt-${active}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck="false"
          />
          <button type="button" className="cmdk__close" data-dialog-close="" onClick={onClose} aria-label={t("மூடு", "Close search")}>
            <LuX aria-hidden="true" />
          </button>
        </div>

        <div className="cmdk__body" ref={listRef}>
          {/* Nothing typed yet: recents, then a few things worth searching for */}
          {status === "idle" && (
            <>
              {recents.length > 0 && (
                <section className="cmdk__group">
                  <h2 className="cmdk__group-title">{t("சமீபத்தில் தேடியவை", "Recent searches")}</h2>
                  <div className="cmdk__chips">
                    {recents.map((r) => (
                      <button key={r} type="button" className="chip" onClick={() => setQuery(r)}>
                        {r}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              <section className="cmdk__group">
                <h2 className="cmdk__group-title">{t("இவற்றை முயற்சிக்கவும்", "Try searching for")}</h2>
                <div className="cmdk__chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.en} type="button" className="chip" onClick={() => setQuery(t(s.ta, s.en))}>
                      {t(s.ta, s.en)}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {status === "short" && (
            <p className="cmdk__hint">
              {t(`குறைந்தது ${minChars} எழுத்துகள் தேவை.`, `Type at least ${minChars} characters.`)}
            </p>
          )}

          {status === "loading" && flat.length === 0 && (
            <p className="cmdk__hint" role="status">
              {t("தேடுகிறோம்…", "Searching…")}
            </p>
          )}

          {status === "error" && (
            <p className="cmdk__hint cmdk__hint--error" role="alert">
              {t("தேடல் இப்போது வேலை செய்யவில்லை. மீண்டும் முயற்சிக்கவும்.", "Search is unavailable right now. Please try again.")}
            </p>
          )}

          {status === "ready" && total === 0 && (
            <div className="cmdk__empty">
              <p>
                {t("எதுவும் கிடைக்கவில்லை", "Nothing matched")} “<strong>{query.trim()}</strong>”
              </p>
              <p className="cmdk__hint">
                {t(
                  "வேறு சொல்லில் முயற்சிக்கவும், அல்லது கோயிலை நேரடியாக தொடர்பு கொள்ளுங்கள்.",
                  "Try another word, or ask the temple directly.",
                )}
              </p>
            </div>
          )}

          {total > 0 && (
            <div id="cmdk-list" role="listbox" aria-label={t("தேடல் முடிவுகள்", "Search results")}>
              {groups.map((g) => {
                const Icon = GROUP_ICONS[g.type] ?? LuFileText;
                return (
                  <section key={g.type} className="cmdk__group">
                    <h2 className="cmdk__group-title">{t(g.label_ta, g.label_en)}</h2>
                    {g.items.map((item) => {
                      cursor += 1;
                      const idx = cursor;
                      return (
                        <button
                          key={`${g.type}-${idx}`}
                          id={`cmdk-opt-${idx}`}
                          type="button"
                          role="option"
                          aria-selected={idx === active}
                          data-active={idx === active ? "true" : "false"}
                          className="cmdk__row"
                          tabIndex={-1}
                          onMouseMove={() => setActive(idx)}
                          onClick={() => go(item.url, query.trim())}
                        >
                          <span className="cmdk__row-icon" aria-hidden="true">
                            <Icon />
                          </span>
                          <span className="cmdk__row-text">
                            <span className="cmdk__row-title">{label(item)}</span>
                            {sub(item) && <span className="cmdk__row-sub">{sub(item)}</span>}
                          </span>
                          <span className="cmdk__row-go" aria-hidden="true">
                            <LuArrowRight />
                          </span>
                        </button>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="cmdk__foot">
          <span className="cmdk__keys" aria-hidden="true">
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd>
            <span>{t("நகர்த்த", "to move")}</span>
            <kbd className="kbd">↵</kbd>
            <span>{t("திறக்க", "to open")}</span>
            <kbd className="kbd">Esc</kbd>
            <span>{t("மூட", "to close")}</span>
          </span>
          {query.trim().length >= minChars && (
            <button type="button" className="cmdk__all" onClick={openAll}>
              {t("எல்லா முடிவுகளும்", "See all results")} <LuArrowRight aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
