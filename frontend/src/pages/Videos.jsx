import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LuImages, LuPlay, LuStar, LuTv, LuVideo } from "react-icons/lu";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import ShareButton from "../components/Share/ShareButton";
import { EmptyState, ErrorState, SkeletonCards } from "../components/ui/Feedback";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import { getJson } from "../lib/live";
import "./Videos.css";

// YouTube's own embed snippet asks for these; `autoplay` only lets the
// visitor's press of Play work inside a cross-origin frame.
const ALLOW = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

// Only ever embed a URL built from a validated id, never one from the wire.
const embedUrl = (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&playsinline=1&autoplay=1`;
const watchUrl = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const thumbUrl = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;

function useVideos(category, page) {
  const query = new URLSearchParams({ category, page: String(page) }).toString();
  const [state, setState] = useState({ categories: [], videos: [], featured: null, hasMore: false, loading: true, error: false });
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: false }));
    getJson(`/api/videos?${query}`).then((res) => {
      if (cancelled) return;
      const body = res.body;
      if (res.ok && isObject(body) && Array.isArray(body.videos)) {
        const safe = (v) => isObject(v) && YT_ID.test(v.youtube_id || "");
        setState({
          categories: Array.isArray(body.categories) ? body.categories.filter((c) => isObject(c) && SLUG.test(c.slug || "")) : [],
          videos: body.videos.filter(safe),
          featured: safe(body.featured) ? body.featured : null,
          hasMore: body.has_more === true,
          loading: false,
          error: false,
        });
      } else {
        setState((prev) => ({ ...prev, videos: [], featured: null, hasMore: false, loading: false, error: true }));
      }
    });
    return () => { cancelled = true; };
  }, [query, attempt]);
  return { ...state, refresh };
}

function formatDate(iso, lang) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(lang === "ta" ? "ta-IN" : "en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function VideoCard({ video, lang, t, index = 0, featured = false }) {
  const [playing, setPlaying] = useState(false);
  const [thumbBroken, setThumbBroken] = useState(false);
  const title = (lang === "ta" ? video.title_ta : video.title_en) || video.title_en || video.title_ta;
  const description = (lang === "ta" ? video.description_ta : video.description_en) || null;
  const category = video.category ? (lang === "ta" ? video.category.name_ta : video.category.name_en) : null;
  const date = formatDate(video.published_on, lang);
  const id = video.youtube_id;

  return (
    <article className={`card card--static video-card${featured ? " video-card--featured" : ""} rise`} style={{ "--i": index }}>
      <div className="video-card__frame">
        {playing ? (
          <iframe
            className="video-card__iframe"
            src={embedUrl(id)}
            title={title}
            allow={ALLOW}
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button type="button" className="video-card__poster" onClick={() => setPlaying(true)} aria-label={t(`${title} – இயக்கு`, `Play ${title}`)}>
            {!thumbBroken ? (
              <img src={thumbUrl(id)} alt="" loading="lazy" decoding="async" onError={() => setThumbBroken(true)} />
            ) : (
              <span className="video-card__emblem" aria-hidden="true"><LuVideo /></span>
            )}
            <span className="video-card__play" aria-hidden="true"><LuPlay /></span>
          </button>
        )}
      </div>
      <div className="video-card__body">
        <div className="video-card__meta">
          {featured && <span className="badge badge--gold video-card__badge"><LuStar aria-hidden="true" /> {t("சிறப்பு", "Featured")}</span>}
          {category && <span className="badge video-card__badge">{category}</span>}
          {date && <time dateTime={video.published_on} className="video-card__date">{date}</time>}
        </div>
        {featured ? <h2 className="video-card__title">{title}</h2> : <h3 className="video-card__title">{title}</h3>}
        {description && <p className="video-card__desc">{description}</p>}
        <div className="video-card__actions">
          {video.live_stream_slug && (
            <Button to={`/live-darshan/${video.live_stream_slug}`} variant="outline" size="sm" icon={<LuTv aria-hidden="true" />}>
              {t("ஒளிபரப்புப் பக்கம்", "Broadcast page")}
            </Button>
          )}
          <Button href={watchUrl(id)} variant="ghost" size="sm" target="_blank" rel="noopener noreferrer">
            {t("YouTube-இல் காண ↗", "Watch on YouTube ↗")}
          </Button>
        </div>
      </div>
    </article>
  );
}

export default function Videos() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();
  const rawCategory = params.get("category") || "";
  const category = SLUG.test(rawCategory) ? rawCategory : "";
  const rawPage = params.get("page") || "1";
  const page = /^[1-9][0-9]{0,4}$/.test(rawPage) && Number(rawPage) <= 10000 ? Number(rawPage) : 1;
  const { categories, videos, featured, hasMore, loading, error, refresh } = useVideos(category, page);
  const title = t("காணொளிகள்", "Videos");
  const lead = t(
    "பூஜைகள், திருவிழாக்கள், தரிசனப் பதிவுகள் மற்றும் சொற்பொழிவுகளின் காணொளிகள்.",
    "Videos of poojas, festivals, darshan recordings and discourses.",
  );
  const change = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, String(value));
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { state: { preserveScroll: true } });
  };
  const listed = featured ? videos.filter((v) => v.id !== featured.id) : videos;
  const count = videos.length;

  return (
    <>
      <Seo title={title} description={lead} />
      <PageHero
        variant="gallery"
        eyebrow={t(TEMPLE.name.ta, TEMPLE.name.en)}
        title={title}
        lead={lead}
        crumbs={[{ label: title }]}
        actions={<>
          <ShareButton variant="outline-light" title={title} text={lead} to="/videos" />
          <Button to="/gallery" variant="outline-light" icon={<LuImages aria-hidden="true" />}>{t("படத் தொகுப்பு", "Photo gallery")}</Button>
          <Button to="/live-darshan/archive" variant="outline-light" icon={<LuTv aria-hidden="true" />}>{t("தரிசனப் பதிவுகள்", "Darshan recordings")}</Button>
        </>}
      />
      <section className="section">
        <div className="container videos">
          {categories.length > 0 && (
            <nav className="videos__filters" aria-label={t("காணொளி வகைகள்", "Video categories")}>
              <Button type="button" variant={category === "" ? "primary" : "outline"} size="sm" aria-pressed={category === ""} onClick={() => change("category", "")}>
                {t("அனைத்தும்", "All")}
              </Button>
              {categories.map((c) => (
                <Button key={c.slug} type="button" variant={category === c.slug ? "primary" : "outline"} size="sm" aria-pressed={category === c.slug} onClick={() => change("category", c.slug)}>
                  {lang === "ta" ? c.name_ta : c.name_en}{typeof c.count === "number" ? ` (${c.count})` : ""}
                </Button>
              ))}
            </nav>
          )}
          <p role="status" aria-live="polite" className="videos__status">
            {loading ? t("ஏற்றுகிறது…", "Loading…")
              : error ? t("காணொளிகளை ஏற்ற முடியவில்லை.", "Couldn't load videos.")
                : t(`பக்கம் ${page} · ${count} ${count === 1 ? "காணொளி" : "காணொளிகள்"}`, `Page ${page} · ${count} ${count === 1 ? "video" : "videos"}`)}
          </p>
          <div id="video-results" aria-busy={loading}>
            {loading && <SkeletonCards count={3} className="grid-3" />}
            {!loading && error && <ErrorState title={t("காணொளிகளை ஏற்ற முடியவில்லை", "Couldn't load videos")} onRetry={refresh} />}
            {!loading && !error && count === 0 && (
              <EmptyState icon={<LuVideo />} title={t("காணொளிகள் இல்லை", "No videos yet")}>
                {category
                  ? t("வேறு வகையைத் தேர்ந்தெடுக்கவும்.", "Try another category.")
                  : t("கோயில் காணொளிகள் விரைவில் இங்கே வெளியிடப்படும்.", "Temple videos will be published here soon.")}
              </EmptyState>
            )}
            {!loading && !error && featured && <VideoCard video={featured} lang={lang} t={t} featured />}
            {!loading && !error && listed.length > 0 && (
              <div className="grid-3 videos__grid">
                {listed.map((video, index) => <VideoCard key={video.id} video={video} lang={lang} t={t} index={index} />)}
              </div>
            )}
          </div>
          {(page > 1 || hasMore) && (
            <nav className="videos__pages" aria-label={t("காணொளிப் பக்கங்கள்", "Video pages")}>
              <Button type="button" variant="outline" disabled={loading || page === 1} onClick={() => change("page", page - 1)}>
                {t("முந்தைய பக்கம்", "Previous page")}
              </Button>
              <Button type="button" variant="outline" disabled={loading || error || !hasMore} onClick={() => change("page", page + 1)}>
                {t("அடுத்த பக்கம்", "Next page")}
              </Button>
            </nav>
          )}
        </div>
      </section>
    </>
  );
}
