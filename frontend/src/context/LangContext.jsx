import { createContext, useContext, useEffect, useState } from "react";

const LangContext = createContext();

export function LangProvider({ children }) {
  const [lang, setLang] = useState("ta"); // 'ta' = Tamil, 'en' = English

  // Keep <html lang> in step with the toggle so screen readers switch voice
  // for the whole document, not just components that set lang themselves.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

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
