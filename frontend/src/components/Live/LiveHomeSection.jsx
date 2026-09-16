import { LuCalendarDays } from "react-icons/lu";
import Button from "../ui/Button";
import SectionHeader from "../ui/SectionHeader";
import LiveNowCard from "./LiveNowCard";
import NextDarshanCard from "./NextDarshanCard";
import { useLang } from "../../context/LangContext";
import "./Live.css";

/**
 * LiveHomeSection — the homepage's live darshan block (SPEC-PHASE2 §2.3):
 * the LIVE NOW card while a broadcast is on, the next darshan with its
 * countdown while one is scheduled, and nothing at all otherwise — never an
 * empty band. The page owns the overview (one request, one poller) and
 * hands `now` / `next` down.
 */
export default function LiveHomeSection({ now = null, next = null, serverOffset = 0 }) {
  const { lang, t } = useLang();
  if (!now && !next) return null;
  const live = Boolean(now);

  return (
    <section className="section home-section home-live reveal" aria-labelledby="home-live-title">
      <div className="container">
        <SectionHeader
          id="home-live-title"
          align="split"
          eyebrow={live ? t("இப்போது நேரலை", "Live now") : t("விரைவில்", "Coming up")}
          title={t("நேரடி தரிசனம்", "Live darshan")}
          subtitle={
            live
              ? t("கோயிலின் பூஜை இப்போது நேரலையில் — எங்கிருந்தும் தரிசனம் செய்யுங்கள்.", "The temple's pooja is on air now — watch from wherever you are.")
              : t("அடுத்த ஒளிபரப்பு — கோயிலின் நேரத்தில்.", "The next broadcast, in the temple's own time.")
          }
          actions={
            <Button to="/live-darshan/schedule" variant="outline" size="sm" icon={<LuCalendarDays aria-hidden="true" />}>
              {t("அட்டவணை", "Schedule")}
            </Button>
          }
        />
        {live ? (
          <LiveNowCard stream={now} t={t} lang={lang} />
        ) : (
          <NextDarshanCard stream={next} serverOffset={serverOffset} t={t} lang={lang} compact />
        )}
      </div>
    </section>
  );
}
