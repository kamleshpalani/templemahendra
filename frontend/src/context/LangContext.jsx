import { createContext, useCallback, useContext, useEffect, useState } from "react";

const LangContext = createContext();

// Namespaced like the other stored preferences (see SearchDialog's
// "temple:recent-searches").
const LANG_KEY = "temple:lang";
const LANGS = ["ta", "en"];

/*
 * Storage THROWS in a private window and wherever site data is blocked, rather
 * than returning null. The language then simply is not remembered: the site
 * still opens in Tamil and the toggle still works for the visit.
 */
function readStoredLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    return LANGS.includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

function storeLang(lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* nothing to do: the choice lasts for this visit only */
  }
}

export function LangProvider({ children }) {
  // Read synchronously so a returning English reader never sees a flash of
  // Tamil on reload. Anything other than "ta" or "en" falls back to Tamil.
  const [lang, setLangState] = useState(() => readStoredLang() ?? "ta"); // 'ta' = Tamil, 'en' = English

  // Only an explicit choice is stored; a visitor who never touches the toggle
  // keeps following the default.
  const setLang = useCallback((next) => {
    if (!LANGS.includes(next)) return;
    setLangState(next);
    storeLang(next);
  }, []);

  // Keep <html lang> in step with the toggle so screen readers switch voice
  // for the whole document, not just components that set lang themselves.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // A choice made in another tab applies here too. The storage event only fires
  // in the other tabs, so this never loops back into the tab that wrote it.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== LANG_KEY) return;
      if (LANGS.includes(e.newValue)) setLangState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      {children}
    </LangContext.Provider>
  );
}

/**
 * useLang — returns { lang, setLang, t }
 * t(taString, enString) returns the correct string for the active language.
 */
export function useLang() {
  const { lang, setLang } = useContext(LangContext);
  const t = (ta, en) => (lang === "ta" ? ta : en);
  return { lang, setLang, t };
}

/**
 * The public forms and the chatbot are flood-limited per connection. The server
 * answers HTTP 429 with { code: "rate_limited", retryAfter: <seconds> } and a
 * Retry-After header. Returns { retryAfter } (seconds, or null when unknown)
 * when a response is that answer, otherwise null.
 */
export function rateLimitInfo(status, body, retryHeader) {
  if (status !== 429 && body?.code !== "rate_limited") return null;
  const seconds = Number(body?.retryAfter ?? retryHeader);
  return { retryAfter: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
}

/**
 * The friendly bilingual wording for a rate-limited request, saying roughly how
 * long to wait. Rounded up so "try again in 1 minute" is never too early.
 */
export function rateLimitMessage(t, retryAfter) {
  let ta = "சில நிமிடங்களில்";
  let en = "in a few minutes";
  if (retryAfter) {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    if (minutes >= 60) {
      const hours = Math.ceil(minutes / 60);
      ta = `சுமார் ${hours} மணி நேரத்தில்`;
      en = `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;
    } else {
      ta = `சுமார் ${minutes} நிமிடத்தில்`;
      en = `in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    }
  }
  return t(
    `இந்த இணைப்பிலிருந்து அதிகமான கோரிக்கைகள் வந்துள்ளன. ${ta} மீண்டும் முயற்சிக்கவும், அல்லது கோயில் அலுவலகத்தை அழைக்கவும்.`,
    `Too many requests from this connection. Please try again ${en}, or call the temple office.`,
  );
}
