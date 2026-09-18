import { LuEye } from "react-icons/lu";
import LiveStatusBadge from "./LiveStatusBadge";
import { deityName, eventTypeLabel, streamTitle } from "../../lib/live";
import "./Live.css";

/**
 * LiveHeader — the strip under the player (SPEC-PHASE4 §2.1): the status
 * badge, the broadcast's title as the page's h2, the deity and programme as
 * muted metadata, and — only while the API hands one over — the viewer count.
 *
 * `stream.viewers` is a number only while LIVE and while YouTube reported it
 * within the last five minutes; anything else is null and the pill is not
 * rendered, so a stale or missing figure never shows as "0". The pill is
 * plain text, not a live region: a count that changes every poll would
 * otherwise be read aloud each time.
 */
export default function LiveHeader({ stream, lang, t }) {
  const title = streamTitle(stream, lang);
  const deity = deityName(stream, lang);
  const kind = eventTypeLabel(stream, lang);
  const meta = [deity, kind].filter(Boolean);
  const viewers = typeof stream?.viewers === "number" && Number.isFinite(stream.viewers) ? stream.viewers : null;
  const count = viewers === null ? "" : new Intl.NumberFormat(lang === "ta" ? "ta-IN" : "en-IN").format(viewers);

  return (
    <header className="live-stream__head">
      <div className="live-header__row">
        <LiveStatusBadge status={stream.status} />
        {viewers !== null && (
          <span className="live-header__viewers" data-viewers={viewers}>
            <LuEye aria-hidden="true" />
            <span aria-hidden="true">{count}</span>
            <span className="sr-only">{t(`${count} பேர் பார்க்கிறார்கள்`, `${count} watching now`)}</span>
          </span>
        )}
      </div>
      <h2 className="live-stream__title">{title}</h2>
      {meta.length > 0 && (
        <p className="live-header__meta">
          {meta.map((m, i) => (
            <span key={m}>
              {i > 0 && <span className="live-header__dot" aria-hidden="true">·</span>}
              {m}
            </span>
          ))}
        </p>
      )}
    </header>
  );
}
