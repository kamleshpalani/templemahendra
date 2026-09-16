import SegmentedControl from "../ui/Tabs";
import { SCHEDULE_FILTERS } from "../../lib/live";
import "./Live.css";

/**
 * ScheduleFilters — Today · Tomorrow · This week · Festivals · All, each with
 * its count from the API (SPEC-PHASE2 §2.2). A SegmentedControl, so the arrow
 * keys move between them.
 */
export default function ScheduleFilters({ value, counts, onChange, t, className = "" }) {
  return (
    <SegmentedControl
      label={t("அட்டவணையை வடிகட்ட", "Filter the schedule")}
      value={value}
      onChange={onChange}
      className={`live-filters ${className}`.trim()}
      items={SCHEDULE_FILTERS.map((f) => {
        const n = Number(counts?.[f.value]);
        return { value: f.value, label: t(f.ta, f.en), count: counts && Number.isFinite(n) ? n : undefined };
      })}
    />
  );
}
