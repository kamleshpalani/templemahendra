import { useEffect, useRef } from "react";
import SegmentedControl from "../ui/Tabs";
import { SCHEDULE_FILTERS } from "../../lib/live";
import "./Live.css";

/**
 * ScheduleFilters — Today · Tomorrow · This week · Festivals · All, each with
 * its count from the API (SPEC-PHASE2 §2.2). A SegmentedControl, so the arrow
 * keys move between them.
 *
 * Five filters do not fit one phone row, so below 640 px the strip wraps into
 * two rows (Live.css) rather than scrolling a chip out of sight. Where it
 * does scroll — a wide Tamil label on a narrow tablet — the selected filter
 * is brought into view, on mount and whenever it or the counts change: the
 * chip that says what the visitor is looking at is never off the edge
 * (review fix F1).
 */
export default function ScheduleFilters({ value, counts, onChange, t, className = "" }) {
  const list = useRef(null);

  useEffect(() => {
    const box = list.current;
    if (!box) return;
    const tab = box.querySelector('[role="tab"][aria-selected="true"]');
    // Nothing to scroll when the strip has wrapped or everything fits.
    if (!tab || box.scrollWidth <= box.clientWidth + 1) return;
    const left = tab.offsetLeft - (box.clientWidth - tab.offsetWidth) / 2;
    // No smooth scrolling: a reduced-motion preference has nothing to still.
    box.scrollTo({ left: Math.max(0, left), behavior: "auto" });
  }, [value, counts]);

  return (
    <SegmentedControl
      label={t("அட்டவணையை வடிகட்ட", "Filter the schedule")}
      value={value}
      onChange={onChange}
      listRef={list}
      className={`live-filters ${className}`.trim()}
      items={SCHEDULE_FILTERS.map((f) => {
        const n = Number(counts?.[f.value]);
        return { value: f.value, label: t(f.ta, f.en), count: counts && Number.isFinite(n) ? n : undefined };
      })}
    />
  );
}
