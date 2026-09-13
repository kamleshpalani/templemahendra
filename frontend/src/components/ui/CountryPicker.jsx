import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { LuCheck, LuSearch, LuX } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { flagOf, searchCountries } from "../../lib/phone";

/**
 * CountryPicker — the searchable country list, shared by the phone field and
 * the country-of-residence field so there is one combobox to get right.
 *
 * The caller supplies the trigger, because the two uses look nothing alike: one
 * is a flag and a dial code welded to the left of a phone field, the other is a
 * full-width control that reads as a select. Everything behind the trigger —
 * the panel, the search, the keyboard model, the focus handling — lives here.
 *
 * It is a combobox, not a menu: focus stays in the search field while the arrow
 * keys move a highlight, and aria-activedescendant names the current row. That
 * is what people already know from every other searchable picker.
 *
 *   <CountryPicker value={iso2} onChange={(c) => …}
 *     trigger={({ ref, open, toggle, props }) => <button …/>} />
 */
export default function CountryPicker({ value, onChange, disabled = false, trigger, onPicked }) {
  const { t } = useLang();
  const auto = useId();
  const listId = `country-list-${auto}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const matches = useMemo(() => searchCountries(query), [query]);

  // Opening starts from a clean search, with the current country highlighted.
  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    const i = searchCountries("").findIndex((c) => c.iso2 === value);
    setActive(i < 0 ? 0 : i);
    const raf = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [open, value]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view as the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const pick = (next) => {
    setOpen(false);
    onChange?.(next.iso2);
    onPicked?.(next);
  };

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!matches.length) return;
      e.preventDefault();
      setActive((i) => {
        const last = matches.length - 1;
        if (e.key === "ArrowDown") return i >= last ? 0 : i + 1;
        return i <= 0 ? last : i - 1;
      });
    } else if (e.key === "Home" || e.key === "End") {
      if (!matches.length) return;
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : matches.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = matches[active];
      if (hit) pick(hit);
    } else if (e.key === "Tab") {
      setOpen(false); // tabbing out of a picker leaves it as it was
    }
  };

  return (
    <div className="country-picker" ref={wrapRef}>
      {trigger({
        ref: triggerRef,
        open,
        listId,
        toggle: () => !disabled && setOpen((o) => !o),
        props: {
          // A combobox, not a plain button. <Field> passes aria-required to
          // whatever control it wraps, and that attribute is not allowed on a
          // bare button — axe reports it as a critical violation. The role is
          // also the honest description of what this control is.
          role: "combobox",
          "aria-haspopup": "listbox",
          "aria-expanded": open,
          "aria-controls": open ? listId : undefined,
          disabled,
        },
      })}

      {open && (
        <div className="country-pop" role="presentation">
          <div className="country-pop__search">
            <LuSearch aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder={t("நாடு அல்லது குறியீடு…", "Country or code…")}
              aria-label={t("நாட்டைத் தேடு", "Search countries")}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={matches.length ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
            />
            <button
              type="button"
              className="country-pop__close"
              onClick={() => close()}
              aria-label={t("மூடு", "Close country list")}
            >
              <LuX aria-hidden="true" />
            </button>
          </div>

          <div
            className="country-pop__list"
            id={listId}
            role="listbox"
            ref={listRef}
            aria-label={t("நாடுகள்", "Countries")}
          >
            {matches.length === 0 && (
              <p className="country-pop__empty">{t("அந்தப் பெயரில் நாடு இல்லை.", "No country matches that.")}</p>
            )}
            {matches.map((c, i) => {
              const isSelected = c.iso2 === value;
              return (
                <button
                  key={c.iso2}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={i === active ? "true" : "false"}
                  className="country-pop__opt"
                  tabIndex={-1}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(c)}
                >
                  <span className="country-flag" aria-hidden="true">
                    {flagOf(c.iso2)}
                  </span>
                  <span className="country-pop__name">{c.name}</span>
                  <span className="country-pop__code">+{c.dial}</span>
                  {isSelected && <LuCheck className="country-pop__tick" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
