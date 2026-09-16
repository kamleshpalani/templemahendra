import { useState } from "react";
import { LuLandmark, LuPlay } from "react-icons/lu";
import Badge from "../ui/Badge";
import Button from "../ui/Button";
import { deityName, eventTypeLabel, formatStreamTime, streamTitle, templeShortName } from "../../lib/live";
import "./Live.css";

/**
 * LiveNowCard — "🔴 LIVE NOW · Morning Abhishekam · [Watch live]" for the
 * homepage while a broadcast is on (SPEC-PHASE2 §2.2). The thumbnail sits in
 * a 16:9 box beside the words (above them on a phone); the one action opens
 * the broadcast's own page, where the player is.
 */
export default function LiveNowCard({ stream, t, lang = "ta", className = "" }) {
  const thumb = stream.thumbnail_url || stream.banner_url || null;
  const [broken, setBroken] = useState(false);
  const tz = stream.timezone || "Asia/Kolkata";
  const started = stream.actual_start_at ? formatStreamTime(stream.actual_start_at, lang, tz) : "";
  const deity = deityName(stream, lang);
  const kind = eventTypeLabel(stream, lang);

  return (
    <div className={`card card--ink card--static live-now ${className}`.trim()}>
      <div className="live-now__thumb">
        {thumb && !broken ? (
          <img className="live-now__thumb-img" src={thumb} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <img className="live-now__emblem" src="/logo.svg" alt="" width="120" height="120" />
        )}
        <div className="live-now__veil" aria-hidden="true" />
        <Badge tone="danger" live size="lg" className="live-now__badge">
          <span className="sr-only">{t("நிலை: ", "Status: ")}</span>
          {t("இப்போது நேரலை", "LIVE NOW")}
        </Badge>
      </div>
      <div className="live-now__body">
        <span className="live-now__eyebrow">
          {t("நேரடி தரிசனம்", "Live darshan")}
          {started ? ` · ${t(`தொடங்கியது ${started}`, `started ${started}`)}` : ""}
        </span>
        <h3 className="live-now__title">{streamTitle(stream, lang)}</h3>
        <p className="live-now__line">
          <LuLandmark aria-hidden="true" />
          <span>{[templeShortName(stream, lang), deity, kind].filter(Boolean).join(" · ")}</span>
        </p>
        <div className="live-now__actions">
          <Button to={`/live-darshan/${stream.slug}`} variant="primary" icon={<LuPlay aria-hidden="true" />}>
            {t("நேரலையைப் பார்க்க", "Watch live")}
          </Button>
        </div>
      </div>
    </div>
  );
}
