import { useRef } from "react";

/**
 * SegmentedControl — a keyboard-navigable tablist used for filters and
 * view switchers. Arrow keys move between tabs; Home/End jump.
 *
 *   <SegmentedControl
 *     label="Filter events"
 *     value={filter}
 *     onChange={setFilter}
 *     items={[{ value: "all", label: "All", count: 12 }, …]}
 *   />
 *
 * `listRef` hands the caller the tablist element itself — for a strip that
 * scrolls, so the selected tab can be brought into view (ScheduleFilters).
 */
export default function SegmentedControl({
  items,
  value,
  onChange,
  label,
  variant = "pill",
  className = "",
  listRef = null,
}) {
  const refs = useRef([]);

  const onKeyDown = (e, idx) => {
    const last = items.length - 1;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = idx === last ? 0 : idx + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = idx === 0 ? last : idx - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next == null) return;
    e.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      className={`tabs${variant === "underline" ? " tabs--underline" : ""} ${className}`.trim()}
      role="tablist"
      aria-label={label}
    >
      {items.map((item, idx) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => (refs.current[idx] = el)}
            type="button"
            role="tab"
            className="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.count != null && <span className="tab__count">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
