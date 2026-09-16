import { countdownShort, countdownText, useCountdown } from "../../lib/live";
import "./Live.css";

/**
 * StreamCountdown — "Live darshan starts in HH : MM : SS" for a broadcast
 * that has not begun (SPEC-PHASE2 §2.2).
 *
 * The clock is driven by the server's time (the offset each API answer
 * gives), never the phone's clock alone. The digits are decoration for
 * sighted visitors (`aria-hidden`); what a screen reader gets is one plain
 * sentence at minute precision, so it changes once a minute rather than sixty
 * times. Once the instant has passed the clock gives way to "Starting
 * shortly" — the committee is about to press Go live. Nothing pulses: the
 * `soon` phase is only a warmer colour, and a reduced-motion preference has
 * nothing to still.
 *
 *   <StreamCountdown startsAt={stream.scheduled_start_at} serverOffset={offset} t={t} lang={lang} />
 *   <StreamCountdown compact … />   // "in 1 h 35 min" for a card
 */
export default function StreamCountdown({ startsAt, serverOffset = 0, t, lang = "ta", compact = false, className = "" }) {
  const { seconds, parts, phase, valid } = useCountdown(startsAt, serverOffset);
  if (!valid) return null;
  const started = phase === "started";
  const label = t("தொடங்க மீதமுள்ள நேரம்", "Time until it starts");

  if (compact) {
    return (
      <span className={`live-countdown live-countdown--compact${phase === "soon" ? " live-countdown--soon" : ""}${started ? " live-countdown--started" : ""} ${className}`.trim()}>
        <span className="sr-only">{label}: </span>
        {started ? t("விரைவில் தொடங்கும்", "Starting shortly") : countdownShort(seconds, lang)}
      </span>
    );
  }

  return (
    <div
      className={`live-countdown${phase === "soon" ? " live-countdown--soon" : ""}${started ? " live-countdown--started" : ""} ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {started ? (
        <p className="live-countdown__started">{t("விரைவில் தொடங்கும்", "Starting shortly")}</p>
      ) : (
        <>
          <p className="live-countdown__caption" aria-hidden="true">
            {t("நேரடி தரிசனம் தொடங்க", "Live darshan starts in")}
          </p>
          <div className="live-countdown__clock" aria-hidden="true">
            <span className="live-countdown__unit">
              <span className="live-countdown__digits">{parts.hh}</span>
              <span className="live-countdown__label">{t("மணி", "hrs")}</span>
            </span>
            <span className="live-countdown__sep">:</span>
            <span className="live-countdown__unit">
              <span className="live-countdown__digits">{parts.mm}</span>
              <span className="live-countdown__label">{t("நிமி", "min")}</span>
            </span>
            <span className="live-countdown__sep">:</span>
            <span className="live-countdown__unit">
              <span className="live-countdown__digits">{parts.ss}</span>
              <span className="live-countdown__label">{t("வினா", "sec")}</span>
            </span>
          </div>
          <p className="sr-only">{countdownText(seconds, lang)}</p>
        </>
      )}
    </div>
  );
}
