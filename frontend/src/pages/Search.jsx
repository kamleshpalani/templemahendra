import { useEffect, useMemo, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useSearchParams } from "react-router-dom";
import { LuArrowRight, LuFileText, LuSearch } from "react-icons/lu";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import { Chip } from "../components/ui/Field";
import { EmptyState, ErrorState, SkeletonText } from "../components/ui/Feedback";
import { GROUP_ICONS } from "../components/Search/SearchDialog";
import useSiteSearch from "../hooks/useSiteSearch";
import { useLang } from "../context/LangContext";
import { TEMPLE } from "../data/temple";
import "./Search.css";

/**
 * /search?q=… — the full results page, for when the palette's six-per-group
 * preview is not enough. The URL is the state, so a result list can be shared
 * and the back button behaves.
 */
export default function Search() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";

  const [draft, setDraft] = useState(q);
  const [only, setOnly] = useState("all");

  // The URL wins: arriving from the palette, or going back, resets the box.
  useEffect(() => {
    setDraft(q);
    setOnly("all");
  }, [q]);

  const { groups, total, status, minChars } = useSiteSearch(q, { limit: 24 });

  const submit = (e) => {
    e.preventDefault();
    const next = draft.trim();
    setParams(next ? { q: next } : {}, { replace: false });
  };

  const shown = useMemo(() => (only === "all" ? groups : groups.filter((g) => g.type === only)), [groups, only]);

  const label = (item) => (lang === "ta" ? item.title_ta || item.title_en : item.title_en || item.title_ta);
  const sub = (item) => (lang === "ta" ? item.sub_ta || item.sub_en : item.sub_en || item.sub_ta);

  return (
    <>
      <Helmet>
        <title>
          {q ? `${t("தேடல்", "Search")}: ${q}` : t("தேடல்", "Search")} — {t(TEMPLE.name.ta, TEMPLE.name.en)}
        </title>
        {/* A results page is not a destination for a search engine. */}
        <meta name="robots" content="noindex, follow" />
      </Helmet>

      <PageHero
        variant="search"
        eyebrow={t("தளத் தேடல்", "Search the site")}
        title={q ? `“${q}”` : t("என்ன தேடுகிறீர்கள்?", "What are you looking for?")}
        lead={
          q
            ? undefined
            : t(
                "சேவைகள், நிகழ்வுகள், பஞ்சாங்கம், அறிவிப்புகள், பக்கங்கள் — எல்லாவற்றிலும் தேடுங்கள்.",
                "Sevas, events, panchangam, notices and pages, all in one place.",
              )
        }
        crumbs={[{ label: t("தேடல்", "Search") }]}
      >
        <form className="srch__form" onSubmit={submit} role="search">
          <span className="input-affix input-affix--leading srch__field">
            <span className="input-affix__icon" aria-hidden="true">
              <LuSearch />
            </span>
            <input
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={t("தேடு", "Search")}
              placeholder={t("சேவை, நிகழ்வு, பக்கம்…", "Seva, event, page…")}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck="false"
            />
          </span>
          <Button type="submit" variant="gold" size="lg">
            {t("தேடு", "Search")}
          </Button>
        </form>
      </PageHero>

      <section className="section section--tight">
        <div className="container">
          {status === "idle" && (
            <EmptyState
              icon={<LuSearch />}
              title={t("மேலே ஒரு சொல்லை உள்ளிடுங்கள்", "Type something above")}
              action={
                <>
                  <Button to="/sevas" variant="primary">
                    {t("சேவைகள்", "Sevas")}
                  </Button>
                  <Button to="/panchangam" variant="outline">
                    {t("பஞ்சாங்கம்", "Panchangam")}
                  </Button>
                </>
              }
            >
              {t(
                "இணைப்பை நகலெடுத்து பங்கிடலாம் — தேடல் முடிவுகள் முகவரியில் சேமிக்கப்படுகின்றன.",
                "Results live in the address bar, so you can share a search as a link.",
              )}
            </EmptyState>
          )}

          {status === "short" && (
            <EmptyState icon={<LuSearch />} title={t("இன்னும் சில எழுத்துகள்", "A couple more letters")}>
              {t(`குறைந்தது ${minChars} எழுத்துகள் தேவை.`, `Search needs at least ${minChars} characters.`)}
            </EmptyState>
          )}

          {status === "loading" && <SkeletonText lines={6} />}

          {status === "error" && (
            <ErrorState onRetry={() => setParams({ q }, { replace: true })}>
              {t("தேடல் இப்போது வேலை செய்யவில்லை.", "Search is unavailable right now.")}
            </ErrorState>
          )}

          {status === "ready" && total === 0 && (
            <EmptyState
              icon={<LuSearch />}
              title={t("எதுவும் கிடைக்கவில்லை", "Nothing matched that")}
              action={
                <>
                  <Button to="/contact" variant="primary">
                    {t("கோயிலை தொடர்பு கொள்ள", "Ask the temple")}
                  </Button>
                  <Button to="/" variant="outline">
                    {t("முகப்பு", "Home")}
                  </Button>
                </>
              }
            >
              {t(
                "வேறு சொல்லில் முயற்சிக்கவும். தமிழிலும் ஆங்கிலத்திலும் தேடலாம்.",
                "Try a different word. Both Tamil and English work.",
              )}
            </EmptyState>
          )}

          {status === "ready" && total > 0 && (
            <>
              <div className="srch__bar">
                <p className="srch__count" role="status">
                  {total}{" "}
                  {total === 1 ? t("முடிவு", "result") : t("முடிவுகள்", "results")}{" "}
                  {t("கிடைத்தது", "found")}
                </p>
                <div className="chip-row srch__filters">
                  <Chip active={only === "all"} onClick={() => setOnly("all")}>
                    {t("அனைத்தும்", "All")}
                  </Chip>
                  {groups.map((g) => (
                    <Chip
                      key={g.type}
                      active={only === g.type}
                      count={g.items.length}
                      onClick={() => setOnly(only === g.type ? "all" : g.type)}
                    >
                      {t(g.label_ta, g.label_en)}
                    </Chip>
                  ))}
                </div>
              </div>

              {shown.map((g) => {
                const Icon = GROUP_ICONS[g.type] ?? LuFileText;
                return (
                  <section key={g.type} className="srch__group" aria-labelledby={`srch-${g.type}`}>
                    <h2 id={`srch-${g.type}`} className="srch__group-title">
                      <span className="srch__group-icon" aria-hidden="true">
                        <Icon />
                      </span>
                      {t(g.label_ta, g.label_en)}
                      <span className="srch__group-n">{g.items.length}</span>
                    </h2>
                    <ul className="srch__list" role="list">
                      {g.items.map((item, i) => (
                        <li key={`${g.type}-${i}`}>
                          <Link to={item.url} className="card card--interactive srch__hit" style={{ "--i": i }}>
                            <span className="srch__hit-text">
                              <span className="srch__hit-title">{label(item)}</span>
                              {sub(item) && <span className="srch__hit-sub">{sub(item)}</span>}
                              {item.snippet && <span className="srch__hit-snip">{item.snippet}</span>}
                            </span>
                            <span className="srch__hit-go" aria-hidden="true">
                              <LuArrowRight />
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </div>
      </section>
    </>
  );
}
