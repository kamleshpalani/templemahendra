import { useSearchParams } from "react-router-dom";
import { LuCalendarDays, LuVideo, LuTv } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import { Field } from "../components/ui/Field";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import StreamCard from "../components/Live/StreamCard";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import { EVENT_TYPE_LABELS, useArchive } from "../lib/live";
import "../components/Live/Live.css";
import "./LiveArchive.css";

export default function LiveArchive() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();
  const eventType = params.get("event_type") || "";
  const month = params.get("month") || "";
  const rawPage = params.get("page") || "1";
  const page = /^[1-9][0-9]{0,4}$/.test(rawPage) && Number(rawPage) <= 10000 ? Number(rawPage) : 1;
  const { streams, hasMore, timezone, loading, error, refresh } = useArchive(eventType, month, page);
  const title = t("தரிசனப் பதிவுகள்", "Darshan recordings");
  const lead = t("நிறைவடைந்த பூஜைகள், அபிஷேகங்கள் மற்றும் திருவிழாக்களின் பதிவுகளைக் காணுங்கள்.", "Watch recordings of completed poojas, abhishekams and festivals.");
  const change = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, String(value));
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { state: { preserveScroll: true } });
  };

  return (
    <>
      <Seo title={title} description={lead} />
      <PageHero
        variant="live"
        eyebrow={t(TEMPLE.name.ta, TEMPLE.name.en)}
        title={title}
        lead={lead}
        crumbs={[{ label: t("நேரடி தரிசனம்", "Live Darshan"), to: "/live-darshan" }, { label: title }]}
        actions={<>
          <Button to="/live-darshan" variant="outline-light" icon={<LuTv aria-hidden="true" />}>{t("நேரடி தரிசனம்", "Live darshan")}</Button>
          <Button to="/live-darshan/schedule" variant="outline-light" icon={<LuCalendarDays aria-hidden="true" />}>{t("அட்டவணை", "Schedule")}</Button>
        </>}
      />
      <section className="section">
        <div className="container live-archive">
          <div className="live-archive__filters" role="group" aria-label={t("பதிவு வடிகட்டிகள்", "Recording filters")}>
            <Field label={t("நிகழ்வு வகை", "Event type")}>
              {(a11y) => <select {...a11y} value={eventType} onChange={(e) => change("event_type", e.target.value)} aria-controls="archive-results">
                <option value="">{t("அனைத்து நிகழ்வுகள்", "All events")}</option>
                {Object.entries(EVENT_TYPE_LABELS).map(([key, label]) => <option key={key} value={key}>{label[lang] || label.en}</option>)}
              </select>}
            </Field>
            <Field label={t("நிறைவடைந்த மாதம்", "Completion month")} hint={t(`கோயில் நேர மண்டலம்: ${timezone}`, `Temple timezone: ${timezone}`)}>
              {(a11y) => <input {...a11y} type="month" min="1900-01" max="9998-12" value={month} onChange={(e) => change("month", e.target.value)} aria-controls="archive-results" />}
            </Field>
            <Button type="button" variant="outline" onClick={() => setParams({}, { state: { preserveScroll: true } })}>
              {t("வடிகட்டிகளை நீக்கு", "Clear filters")}
            </Button>
          </div>
          <p role="status" aria-live="polite">
            {loading ? t("ஏற்றுகிறது…", "Loading…")
              : error ? t("பதிவுகளை ஏற்ற முடியவில்லை.", "Couldn't load recordings.")
                : t(`பக்கம் ${page} · ${streams.length} ${streams.length === 1 ? "பதிவு" : "பதிவுகள்"}`, `Page ${page} · ${streams.length} ${streams.length === 1 ? "recording" : "recordings"}`)}
          </p>
          <div id="archive-results" aria-busy={loading}>
            {loading && <SkeletonCards count={3} className="grid-3" />}
            {!loading && error && <ErrorState title={t("பதிவுகளை ஏற்ற முடியவில்லை", "Couldn't load recordings")} onRetry={refresh} />}
            {!loading && !error && streams.length === 0 && <EmptyState
              icon={<LuVideo />}
              title={t("பதிவுகள் இல்லை", "No recordings found")}
            >{t("வேறு மாதம் அல்லது நிகழ்வு வகையைத் தேர்ந்தெடுக்கவும்.", "Try another month or event type.")}</EmptyState>}
            {!loading && !error && streams.length > 0 && <div className="grid-3">
              {streams.map((stream, index) => <StreamCard key={stream.id} stream={stream} lang={lang} index={index} recording />)}
            </div>}
          </div>
          <nav className="live-archive__pages" aria-label={t("பதிவுப் பக்கங்கள்", "Recording pages")}>
            <Button type="button" variant="outline" disabled={loading || page === 1} onClick={() => change("page", page - 1)}>
              {t("முந்தைய பக்கம்", "Previous page")}
            </Button>
            <Button type="button" variant="outline" disabled={loading || error || !hasMore} onClick={() => change("page", page + 1)}>
              {t("அடுத்த பக்கம்", "Next page")}
            </Button>
          </nav>
        </div>
      </section>
    </>
  );
}
