import { forwardRef, useEffect, useId, useMemo, useRef, useState } from "react";
import { LuChevronDown, LuSearch, LuX } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { subdivisionsOf, subdivisionLabel } from "../../lib/phone";

/**
 * StateSelect — the state, province or region, for the country already chosen.
 *
 * Two behaviours, decided by whether the site has a list for that country:
 *
 *   • It does (India, the United States, Malaysia and the rest of the places
 *     this temple's devotees live): a searchable list, the same pattern as the
 *     country field, so typing "tam" finds Tamil Nadu.
 *   • It does not: a plain text box. Shipping a partial list and forcing every
 *     other devotee to pick "Other" would be worse than simply letting them
 *     write what they write on their own post.
 *
 * The label also follows the country, because "state" is wrong in most of the
 * world — see subdivisionLabel in lib/phone.js.
 *
 *   <StateSelect country={form.country} value={form.state} onChange={…} />
 */
const StateSelect = forwardRef(function StateSelect(
  { country, value = "", onChange, disabled = false, className = "", id, ...rest },
  ref,
) {
  const { t } = useLang();
  const list = useMemo(() => subdivisionsOf(country), [country]);
  const auto = useId();
  const listId = `state-list-${auto}`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    const starts = list.filter((s) => s.name.toLowerCase().startsWith(q) || s.code.toLowerCase() === q);
    const rest = list.filter((s) => !starts.includes(s) && s.name.toLowerCase().includes(q));
    return [...starts, ...rest];
  }, [list, query]);

  const chosen = list.find((s) => s.code === value || s.name === value) ?? null;

  useEffect(() => {
    if (!open) return undefined;
    setQuery("");
    const i = list.findIndex((s) => s.code === chosen?.code);
    setActive(i < 0 ? 0 : i);
    const raf = requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // No list for this country: a text box is the honest control.
  if (!list.length) {
    return (
      <input
        {...rest}
        id={id}
        ref={ref}
        className={className}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        autoComplete="address-level1"
        maxLength={120}
        placeholder={subdivisionLabel(country, t)}
      />
    );
  }

  const pick = (s) => {
    setOpen(false);
    onChange?.(s.code);
    buttonRef.current?.focus({ preventScroll: true });
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
      setOpen(false);
    }
  };

  return (
    <div className="country-picker" ref={wrapRef}>
      <button
        {...rest}
        id={id}
        ref={(node) => {
          buttonRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        className={`country-select${chosen ? "" : " country-select--empty"} ${className}`.trim()}
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        // See CountryPicker: aria-required arrives from <Field>, and it is only
        // a permitted attribute on a combobox, not on a bare button.
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        <span className="country-select__name">{chosen ? chosen.name : subdivisionLabel(country, t)}</span>
        <LuChevronDown className="country-select__caret" aria-hidden="true" />
      </button>

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
              placeholder={subdivisionLabel(country, t)}
              aria-label={subdivisionLabel(country, t)}
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
              onClick={() => {
                setOpen(false);
                buttonRef.current?.focus();
              }}
              aria-label={t("மூடு", "Close list")}
            >
              <LuX aria-hidden="true" />
            </button>
          </div>

          <div
            className="country-pop__list"
            id={listId}
            role="listbox"
            ref={listRef}
            aria-label={subdivisionLabel(country, t)}
          >
            {matches.length === 0 && (
              <p className="country-pop__empty">{t("பொருத்தம் இல்லை.", "Nothing matches that.")}</p>
            )}
            {matches.map((s, i) => (
              <button
                key={s.code}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={s.code === chosen?.code}
                data-active={i === active ? "true" : "false"}
                className="country-pop__opt country-pop__opt--plain"
                tabIndex={-1}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(s)}
              >
                <span className="country-pop__name">{s.name}</span>
                <span className="country-pop__code">{s.code}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default StateSelect;
