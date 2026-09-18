import { useEffect, useState } from "react";
import { LuExternalLink, LuPlay, LuRefreshCw } from "react-icons/lu";
import Button from "../ui/Button";
import LiveStatusBadge from "./LiveStatusBadge";
import {
  embedSrc,
  formatStreamDate,
  formatStreamTime,
  isLiveStatus,
  startHasPassed,
  streamTitle,
  watchUrl as watchUrlOf,
} from "../../lib/live";
import "./Live.css";

/**
 * LivePlayer — the 16:9 stage for one broadcast (SPEC-PHASE1 §5.2).
 *
 * While the broadcast is LIVE or STARTING and the API says it can be framed,
 * the provider's player is mounted at once — with the player's own play
 * control, never an autoplay parameter, which respects the phone's autoplay
 * policy and a visitor who asked for reduced motion. Every other status
 * shows a poster (banner → thumbnail → the temple emblem on maroon) with a
 * sentence saying what is happening. A poster that fails to load falls back
 * to the emblem: a thumbnail URL is a guess about the provider's CDN, not a
 * promise.
 *
 * Phase 4 (SPEC-PHASE4 §2.3): a COMPLETED broadcast the committee chose to
 * archive keeps its poster until the visitor presses "Watch the recording",
 * which mounts the same iframe in the same 16:9 box; OFFLINE and ERROR offer
 * "Try again", which asks the page to fetch the broadcast afresh.
 */

// The permissions YouTube's own embed snippet asks for. `autoplay` is not a
// request to start playing; it lets the visitor's press of Play work inside
// a cross-origin frame on Chrome.
const ALLOW = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";

/** The sentence under the badge on the poster, per status. */
function stateText(stream, lang, t, serverOffset, started) {
  const tz = stream.timezone || "Asia/Kolkata";
  switch (stream.status) {
    case "SCHEDULED": {
      if (!stream.scheduled_start_at) {
        return t("நேரம் விரைவில் அறிவிக்கப்படும்.", "The time will be announced shortly.");
      }
      // Past its start but not yet live: the committee is about to press Go
      // live, and a time that has gone by would only puzzle the visitor. The
      // page says when that instant passes (`started`, review fix F4); on its
      // own the poster works it out from the last answer it was given.
      if (started || startHasPassed(stream, serverOffset)) return t("விரைவில் தொடங்கும்", "Starting shortly");
      const date = formatStreamDate(stream.scheduled_start_at, lang, tz);
      const time = formatStreamTime(stream.scheduled_start_at, lang, tz);
      // The time token already ends in am/pm and the zone ("6:00 pm IST"), so
      // no "மணிக்கு" follows it in Tamil.
      return t(`${date} அன்று ${time} தொடங்கும்`, `Starts ${date} at ${time}`);
    }
    case "OFFLINE":
      return t(
        "ஒளிபரப்பு தற்காலிகமாக நிறுத்தப்பட்டுள்ளது. சிறிது நேரம் கழித்து மீண்டும் பார்க்கவும்.",
        "The broadcast is temporarily offline. Please check again shortly.",
      );
    case "ERROR":
      return t("நேரடி தரிசனம் தற்காலிகமாகக் கிடைக்கவில்லை.", "Live darshan is temporarily unavailable.");
    case "COMPLETED":
      return t("இந்த தரிசனம் நிறைவடைந்தது.", "This darshan has ended.");
    case "CANCELLED":
      return t("இந்த தரிசனம் ரத்து செய்யப்பட்டது.", "This darshan was cancelled.");
    case "LIVE":
    case "STARTING":
      // Live, but not something this page can frame (a provider that only
      // offers a link, or none at all).
      return stream.playback?.kind === "link"
        ? t("ஒளிபரப்பு வழங்குநரின் தளத்தில் நடைபெறுகிறது.", "The broadcast is playing on the provider's site.")
        : t("நேரடி தரிசனம் தற்காலிகமாகக் கிடைக்கவில்லை.", "Live darshan is temporarily unavailable.");
    default:
      return t("நேரடி தரிசனம் தற்காலிகமாகக் கிடைக்கவில்லை.", "Live darshan is temporarily unavailable.");
  }
}

export default function LivePlayer({ stream, lang, t, serverOffset = 0, started = false, onRetry = null }) {
  const title = streamTitle(stream, lang);
  const live = isLiveStatus(stream?.status);
  const recording = stream?.status === "COMPLETED" && Boolean(stream?.flags?.archive) && stream?.playback?.kind === "iframe"
    ? stream.playback.embedUrl : null;
  const [playRecording, setPlayRecording] = useState(false);
  const src = live || (playRecording && recording) ? embedSrc(stream, lang) : null;
  const retry = (stream?.status === "OFFLINE" || stream?.status === "ERROR") && typeof onRetry === "function";
  const poster = stream?.banner_url || stream?.thumbnail_url || null;
  const [posterBroken, setPosterBroken] = useState(false);
  const url = watchUrlOf(stream);
  const youtube = stream?.provider === "youtube";

  // A new poster gets a fresh chance to load.
  useEffect(() => {
    setPosterBroken(false);
  }, [poster]);
  // Another broadcast, or one that is no longer an archived recording, starts on its poster.
  useEffect(() => {
    setPlayRecording(false);
  }, [stream?.slug, recording]);

  const showPoster = Boolean(poster) && !posterBroken;

  return (
    <div className="card card--ink card--static live-player">
      {src ? (
        <div className="live-player__frame">
          <iframe
            className="live-player__iframe"
            src={src}
            title={(live ? t("நேரடி தரிசனம் – ", "Live darshan – ") : t("பதிவு – ", "Recording – ")) + title}
            allow={ALLOW}
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      ) : (
        <div className="live-player__frame live-player__poster">
          {showPoster ? (
            <img
              className="live-player__poster-img"
              src={poster}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setPosterBroken(true)}
            />
          ) : (
            <img className="live-player__emblem" src="/logo.svg" alt="" width="160" height="160" />
          )}
          <div className="live-player__poster-veil" aria-hidden="true" />
          <div className="live-player__state">
            <LiveStatusBadge status={stream.status} size="lg" onDark />
            <p className="live-player__state-text">{stateText(stream, lang, t, serverOffset, started)}</p>
            {stream.status === "SCHEDULED" && (
              <p className="live-player__state-sub">
                {t("ஒளிபரப்பு தொடங்கியதும் இங்கே காணலாம்.", "The broadcast will appear here when it begins.")}
              </p>
            )}
            {recording && (
              <Button
                type="button"
                variant="gold"
                size="sm"
                className="live-player__action"
                icon={<LuPlay aria-hidden="true" />}
                onClick={() => setPlayRecording(true)}
              >
                {t("பதிவைப் பார்க்க", "Watch the recording")}
              </Button>
            )}
            {retry && (
              <Button
                type="button"
                variant="outline-light"
                size="sm"
                className="live-player__action"
                icon={<LuRefreshCw aria-hidden="true" />}
                onClick={() => onRetry()}
              >
                {t("மீண்டும் முயற்சி", "Try again")}
              </Button>
            )}
          </div>
        </div>
      )}

      {url && (
        <div className="live-player__foot">
          <p className="live-player__foot-text">
            {youtube
              ? t("ஒளிபரப்பு ஏற்றாவிட்டால் YouTube-ல் நேரடியாகப் பார்க்கலாம்.", "If the player does not load, watch it on YouTube.")
              : t("ஒளிபரப்பு வழங்குநரின் தளத்திலும் பார்க்கலாம்.", "You can also watch on the provider's site.")}
          </p>
          <Button
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            variant="outline-light"
            size="sm"
            icon={<LuExternalLink aria-hidden="true" />}
          >
            {youtube ? t("YouTube-ல் பார்க்க", "Watch on YouTube") : t("ஒளிபரப்பைத் திறக்க", "Open the broadcast")}
          </Button>
        </div>
      )}
    </div>
  );
}
