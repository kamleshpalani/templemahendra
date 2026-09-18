import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { LuCalendarDays, LuTv, LuYoutube } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import SectionHeader from "../components/ui/SectionHeader";
import Button from "../components/ui/Button";
import ShareButton from "../components/Share/ShareButton";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import LiveHeader from "../components/Live/LiveHeader";
import LivePlayer from "../components/Live/LivePlayer";
import LiveStatusBadge from "../components/Live/LiveStatusBadge";
import NextDarshanCard from "../components/Live/NextDarshanCard";
import StreamActions from "../components/Live/StreamActions";
import StreamCard from "../components/Live/StreamCard";
import StreamMeta from "../components/Live/StreamMeta";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import {
  formatStreamDate,
  formatStreamTime,
  isLiveStatus,
  pickStream,
  startHasPassed,
  streamDescription,
  streamInstant,
  streamTitle,
  useLiveOverview,
  useStartPassed,
  useStream,
} from "../lib/live";
import "../components/Live/Live.css";
import "./LiveDarshan.css";

/**
 * /live-darshan and /live-darshan/:slug — the temple's broadcasts
 * (docs/live/SPEC-PHASE1.md §5.3).
 *
 * The list route shows whichever broadcast matters most right now: the live
 * one, else the one starting, else the next scheduled one as a poster, else
 * a quiet "nothing scheduled" card with the YouTube channel as the way in.
 * The slug route shows that one broadcast in any public status. Both keep
 * asking the API (lib/live.js) so a devotee who opened the page early sees
 * it begin without reloading; only that change of state is spoken aloud.
 *
 * No login: the public site has none, and darshan is for everyone.
 */

// The single channel constant (SPEC Decision 5) lives in data/temple.js.
const CHANNEL_URL = TEMPLE.youtube.channelUrl;

/** The upcoming grid shows this many at most; the schedule page has the rest (SPEC-PHASE4 §2.5). */
const UPCOMING_MAX = 6;

/** The §4.6 strings, exactly as backend/includes/site_pages.php carries them. */
const PAGE_TITLE = ["நேரடி தரிசனம்", "Live Darshan"];
const PAGE_DESCRIPTION = [
  "கோயிலின் தினசரி பூஜைகள், அபிஷேகம், தீபாராதனை மற்றும் திருவிழாக்களை உலகின் எந்த இடத்திலிருந்தும் நேரடியாகக் காணுங்கள்.",
  "Watch the temple's daily poojas, abhishekam, deeparadhana and festivals live from anywhere in the world.",
];

/** What the live region says when a broadcast changes state under the visitor. */
const TRANSITIONS = {
  LIVE: ["நேரடி தரிசனம் தொடங்கிவிட்டது", "Live darshan has started"],
  STARTING: ["நேரடி தரிசனம் விரைவில் தொடங்கும்", "Live darshan is starting soon"],
  COMPLETED: ["இந்த தரிசனம் நிறைவடைந்தது", "This darshan has ended"],
  OFFLINE: ["ஒளிபரப்பு தற்காலிகமாக நிறுத்தப்பட்டுள்ளது", "The broadcast is temporarily offline"],
  ERROR: ["நேரடி தரிசனம் தற்காலிகமாகக் கிடைக்கவில்லை", "Live darshan is temporarily unavailable"],
  CANCELLED: ["இந்த தரிசனம் ரத்து செய்யப்பட்டது", "This darshan was cancelled"],
  SCHEDULED: ["நேரடி தரிசனம் மீண்டும் திட்டமிடப்பட்டது", "Live darshan has been rescheduled"],
};

/** The hero's aside: the status pill with the one time that matters. */
function HeroStatus({ stream, lang, t, started = false }) {
  const tz = stream.timezone || "Asia/Kolkata";
  let line = "";
  if (isLiveStatus(stream.status) && stream.actual_start_at) {
    const at = formatStreamTime(stream.actual_start_at, lang, tz);
    line = t(`தொடங்கியது ${at}`, `Started ${at}`);
  } else if (stream.status === "SCHEDULED" && stream.scheduled_start_at) {
    // Once the start has passed the hero stops announcing a time that has gone
    // by, at the same instant as the poster and the countdown (review fix F4).
    line = started
      ? t("விரைவில் தொடங்கும்", "Starting shortly")
      : `${formatStreamDate(stream.scheduled_start_at, lang, tz)} · ${formatStreamTime(stream.scheduled_start_at, lang, tz)}`;
  } else if (stream.status === "COMPLETED" && (stream.actual_end_at || streamInstant(stream))) {
    line = formatStreamDate(stream.actual_end_at || streamInstant(stream), lang, tz);
  }
  return (
    <div className="live-hero__status" role="group" aria-label={t("ஒளிபரப்பு நிலை", "Broadcast status")}>
      <span className="live-hero__status-label">
        <LuTv aria-hidden="true" />
        {t("ஒளிபரப்பு", "Broadcast")}
      </span>
      <LiveStatusBadge status={stream.status} size="lg" onDark />
      {line && <span className="live-hero__status-line">{line}</span>}
    </div>
  );
}

export default function LiveDarshan() {
  const { slug } = useParams();
  const { lang, t } = useLang();

  // The overview feeds the list route and the "upcoming" grid on both routes;
  // on the slug route it is fetched once and the stream's own hook polls.
  const overview = useLiveOverview({ poll: !slug });
  const single = useStream(slug ?? null);

  // The list route features `now` (live), else `next` (the first upcoming
  // one, with its countdown), as the index route names them (SPEC-PHASE2
  // §1.1); the two lists stand in for an answer without them.
  const stream = slug ? single.stream : (overview.now ?? overview.next ?? pickStream(overview.live, overview.upcoming));
  const serverOffset = slug ? single.serverOffset : overview.serverOffset;
  const loading = slug ? single.loading : overview.loading;
  const error = slug ? single.error : overview.error;
  const notFound = Boolean(slug) && single.notFound;
  const retry = slug ? single.refresh : overview.refresh;

  /*
   * The instant a scheduled broadcast was due: when it passes with the page
   * open, the poster and the hero flip to "Starting shortly" with the card's
   * countdown, driven by one timeout rather than the 60 s poll (review fix
   * F4). Any other status has no such instant.
   */
  const startPassed = useStartPassed(stream?.status === "SCHEDULED" ? stream?.scheduled_start_at : null, serverOffset);

  const others = useMemo(() => {
    const seen = new Set();
    return [...overview.live, ...overview.upcoming]
      .filter((s) => {
        if (!s?.slug || s.slug === stream?.slug || seen.has(s.slug)) return false;
        seen.add(s.slug);
        return true;
      })
      .slice(0, UPCOMING_MAX);
  }, [overview.live, overview.upcoming, stream]);

  /*
   * The live region announces only a change of state between two polls —
   * never the state the page opened in, which the badge already shows. A
   * broadcast that ends on the list route is replaced by the next one; that
   * ending is announced too, since it is the one the visitor was watching.
   */
  const [announcement, setAnnouncement] = useState("");
  const last = useRef(null);
  useEffect(() => {
    if (loading) return;
    const prev = last.current;
    const next = stream ? { key: stream.slug ?? String(stream.id), status: stream.status } : null;
    let said = null;
    if (prev && next && prev.key === next.key && prev.status !== next.status) said = TRANSITIONS[next.status];
    else if (prev && isLiveStatus(prev.status) && (!next || prev.key !== next.key) && !(next && isLiveStatus(next.status))) {
      said = TRANSITIONS.COMPLETED;
    }
    last.current = next;
    if (said) setAnnouncement(lang === "ta" ? said[0] : said[1]);
  }, [stream, loading, lang]);

  const title = t(...PAGE_TITLE);
  const lead = t(...PAGE_DESCRIPTION);
  const streamName = stream ? streamTitle(stream, lang) : "";
  const streamText = stream ? streamDescription(stream, lang) : "";
  const seoTitle = stream ? streamName : title;
  const seoDescription = streamText || lead;
  const sharePath = slug && stream ? `/live-darshan/${stream.slug}` : "/live-darshan";
  const crumbs = slug && stream ? [{ label: title, to: "/live-darshan" }, { label: streamName }] : [{ label: title }];

  return (
    <>
      <Seo
        title={seoTitle}
        description={seoDescription}
        image={stream?.thumbnail_url || undefined}
        imageAlt={stream ? streamName : undefined}
        type={stream ? "video.other" : "website"}
      />

      <PageHero
        variant="live"
        eyebrow={t(TEMPLE.name.ta, TEMPLE.name.en)}
        title={title}
        lead={lead}
        crumbs={crumbs}
        actions={<ShareButton variant="outline-light" title={seoTitle} text={seoDescription} to={sharePath} />}
        aside={stream && <HeroStatus stream={stream} lang={lang} t={t} started={startPassed || startHasPassed(stream, serverOffset)} />}
      />

      <section className="section live-page">
        <div className="container">
          {loading && (
            <>
              <p className="sr-only" role="status">
                {t("ஏற்றுகிறது…", "Loading…")}
              </p>
              <SkeletonCards count={1} className="live-skeleton" />
            </>
          )}

          {!loading && error && (
            <ErrorState onRetry={retry} title={t("நேரடி தரிசனத்தை ஏற்ற முடியவில்லை", "Couldn't load live darshan")} />
          )}

          {!loading && !error && notFound && (
            <EmptyState
              icon={<LuTv />}
              className="live-empty"
              title={t("அந்த தரிசனம் கிடைக்கவில்லை", "That darshan was not found")}
              action={
                <Button to="/live-darshan" variant="primary" size="sm" icon={<LuTv aria-hidden="true" />}>
                  {t("நேரடி தரிசனத்திற்குச் செல்ல", "Go to Live Darshan")}
                </Button>
              }
            >
              {t(
                "இந்த இணைப்பு பழையதாக இருக்கலாம், அல்லது ஒளிபரப்பு நீக்கப்பட்டிருக்கலாம்.",
                "The link may be old, or the broadcast was removed.",
              )}
            </EmptyState>
          )}

          {!loading && !error && !notFound && !stream && (
            <EmptyState
              icon={<LuTv />}
              className="live-empty"
              title={t("இப்போது நேரடி தரிசனம் எதுவும் திட்டமிடப்படவில்லை", "No live darshan is scheduled right now")}
              action={
                <>
                  <Button
                    href={CHANNEL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    variant="primary"
                    size="sm"
                    icon={<LuYoutube aria-hidden="true" />}
                  >
                    {t("YouTube சேனல்", "YouTube channel")}
                  </Button>
                  <Button to="/events" variant="outline" size="sm" icon={<LuCalendarDays aria-hidden="true" />}>
                    {t("நிகழ்வுகள் & திருவிழாக்கள்", "Events & festivals")}
                  </Button>
                </>
              }
            >
              {t(
                "கமிட்டி ஒரு ஒளிபரப்பைத் திட்டமிட்டதும் அது இங்கே தோன்றும். அதுவரை கோயிலின் YouTube சேனலைப் பார்க்கலாம்.",
                "When the committee schedules a broadcast it will appear here. Until then, visit the temple's YouTube channel.",
              )}
            </EmptyState>
          )}

          {!loading && !error && stream && (
            <div className="split live-stage">
              <div className="live-stage__main">
                <LivePlayer stream={stream} lang={lang} t={t} serverOffset={serverOffset} started={startPassed} onRetry={retry} />
                {!slug && stream.status === "SCHEDULED" ? (
                  // Nothing is live: the poster above, and under it the next
                  // darshan with its countdown (SPEC-PHASE2 §2.3). The card
                  // carries the title as the page's h2; the description
                  // lives in "About this pooja" beside it (Phase 4).
                  <NextDarshanCard stream={stream} serverOffset={serverOffset} t={t} lang={lang} heading="h2" className="live-stage__next" />
                ) : (
                  <LiveHeader stream={stream} lang={lang} t={t} />
                )}
                <StreamActions stream={stream} lang={lang} t={t} />
              </div>
              <aside className="split__sticky live-stage__aside" aria-label={t("ஒளிபரப்பு விவரங்கள்", "Broadcast details")}>
                <section className="live-about" aria-labelledby="live-about-title">
                  <h3 id="live-about-title" className="live-about__title">
                    {t("இந்த பூஜை பற்றி", "About this pooja")}
                  </h3>
                  <p className="live-stream__desc">
                    {streamText || t("இந்த ஒளிபரப்பிற்கு விளக்கம் எதுவும் இல்லை.", "No description has been given for this broadcast.")}
                  </p>
                </section>
                <StreamMeta stream={stream} lang={lang} t={t} />
              </aside>
            </div>
          )}

          {!loading && !error && others.length > 0 && (
            <div className="live-upcoming">
              <SectionHeader
                align="split"
                eyebrow={t("அட்டவணை", "Schedule")}
                title={t("வரவிருக்கும் நேரடி தரிசனங்கள்", "Upcoming live darshans")}
                subtitle={t(
                  "திட்டமிடப்பட்ட ஒளிபரப்புகள் — கோயிலின் நேரத்தில்.",
                  "Scheduled broadcasts, in the temple's own time.",
                )}
                actions={
                  <Button to="/live-darshan/schedule" variant="outline" size="sm" icon={<LuCalendarDays aria-hidden="true" />}>
                    {t("முழு அட்டவணை", "Full schedule")}
                  </Button>
                }
              />
              <div className="grid-3">
                {others.map((s, i) => (
                  <StreamCard key={s.slug} stream={s} lang={lang} index={i} serverOffset={serverOffset} />
                ))}
              </div>
            </div>
          )}

          <p className="sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </div>
      </section>
    </>
  );
}
