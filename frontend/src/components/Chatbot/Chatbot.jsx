import { useState, useRef, useEffect, useCallback } from "react";
import { LuBot, LuChevronDown, LuSend, LuSparkles, LuX } from "react-icons/lu";
import { useLang } from "../../context/LangContext";
import { PRIMARY_CONTACT, SECONDARY_CONTACT, formatPhone } from "../../data/temple";
import "./Chatbot.css";

const WELCOME_TA =
  "வணக்கம்! 🙏 நான் ஆலய உதவியாளர்.\nபூஜை நேரம், சேவைகள், நிகழ்வுகள் அல்லது நன்கொடை பற்றி கேட்கலாம்.";
const WELCOME_EN =
  "Namaskar! 🙏 I'm your Temple Assistant.\nAsk me about pooja timings, sevas, festivals, or donations.";

const CHIPS = [
  { ta: "கோயில் நேரம் என்ன?", en: "Temple timings?" },
  { ta: "என்ன சேவைகள் உள்ளன?", en: "What sevas are offered?" },
  { ta: "நன்கொடை எப்படி?", en: "How can I donate?" },
  { ta: "அடுத்த பௌர்ணமி எப்போது?", en: "When is the next Pournami?" },
];

export default function Chatbot() {
  const { lang, t } = useLang();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const triggerRef = useRef(null);

  // Initialise welcome message when chat opens
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([{ role: "assistant", text: lang === "ta" ? WELCOME_TA : WELCOME_EN }]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  // Focus input when chat opens; Escape closes and returns focus to the trigger
  useEffect(() => {
    if (!open) return undefined;
    const id = setTimeout(() => inputRef.current?.focus(), 120);
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const send = useCallback(
    async (preset) => {
      const text = (preset ?? input).trim();
      if (!text || loading) return;

      setInput("");
      const updated = [...messages, { role: "user", text }];
      setMessages(updated);
      setLoading(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            history: updated.slice(-8).map((m) => ({
              role: m.role === "assistant" ? "assistant" : "user",
              text: m.text,
            })),
          }),
        });
        if (!res.ok) throw new Error("Server error");
        const data = await res.json();
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: data.reply ?? t("மன்னிக்கவும், பதில் கிடைக்கவில்லை.", "Sorry, no response received."),
          },
        ]);
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            error: true,
            text: t(
              `மன்னிக்கவும். சேவை தற்போது இல்லை. நேரடியாக அழைக்கவும்:\n${PRIMARY_CONTACT.role.ta} ${PRIMARY_CONTACT.name.ta} – ${formatPhone(PRIMARY_CONTACT.phone)}\n${SECONDARY_CONTACT.role.ta} ${SECONDARY_CONTACT.name.ta} – ${formatPhone(SECONDARY_CONTACT.phone)}`,
              `Sorry, the assistant is unavailable right now. Please call us directly:\n${PRIMARY_CONTACT.role.en} ${PRIMARY_CONTACT.name.en} – ${formatPhone(PRIMARY_CONTACT.phone)}\n${SECONDARY_CONTACT.role.en} ${SECONDARY_CONTACT.name.en} – ${formatPhone(SECONDARY_CONTACT.phone)}`,
            ),
          },
        ]);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, messages, t],
  );

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div>
      {open && (
        <section
          className="chatbot__window"
          role="dialog"
          aria-label={t("ஆலய உதவியாளர்", "Temple Assistant")}
        >
          <header className="chatbot__header">
            <div className="chatbot__header-info">
              <div className="chatbot__avatar" aria-hidden="true">
                <LuBot />
              </div>
              <div>
                <span className="chatbot__header-title">{t("ஆலய உதவியாளர்", "Temple Assistant")}</span>
                <span className="chatbot__header-sub">
                  <span className="chatbot__online" aria-hidden="true" />
                  {t("AI உதவியாளர் · உடனடி பதில்", "AI assistant · instant answers")}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="chatbot__btn-icon"
              onClick={() => setOpen(false)}
              aria-label={t("மூடு", "Close chat")}
            >
              <LuChevronDown aria-hidden="true" />
            </button>
          </header>

          <div className="chatbot__body" aria-live="polite">
            {messages.map((m, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className={`chatbot__bubble chatbot__bubble--${m.role}${m.error ? " chatbot__bubble--error" : ""}`}>
                {m.role === "assistant" && (
                  <span className="chatbot__bot-icon" aria-hidden="true">
                    <LuSparkles />
                  </span>
                )}
                <p className="chatbot__text">{m.text}</p>
              </div>
            ))}

            {loading && (
              <div className="chatbot__bubble chatbot__bubble--assistant">
                <span className="chatbot__bot-icon" aria-hidden="true">
                  <LuSparkles />
                </span>
                <div className="chatbot__typing" role="status" aria-label={t("தட்டச்சு செய்கிறது", "Typing")}>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {messages.length <= 1 && (
            <div className="chatbot__chips" aria-label={t("பரிந்துரைகள்", "Suggested questions")}>
              {CHIPS.map((chip) => (
                <button key={chip.en} type="button" className="chip" onClick={() => send(t(chip.ta, chip.en))}>
                  {t(chip.ta, chip.en)}
                </button>
              ))}
            </div>
          )}

          <form
            className="chatbot__footer"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="chatbot__input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("கேள்வி கேளுங்கள்…", "Ask a question…")}
              maxLength={400}
              disabled={loading}
              aria-label={t("செய்தி உள்ளிடவும்", "Type your message")}
              autoComplete="off"
            />
            <button
              type="submit"
              className="chatbot__send"
              disabled={!input.trim() || loading}
              aria-label={t("அனுப்பு", "Send")}
            >
              <LuSend aria-hidden="true" />
            </button>
          </form>
        </section>
      )}

      <button
        ref={triggerRef}
        type="button"
        className={`chatbot__trigger${open ? " chatbot__trigger--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? t("உதவியாளரை மூடு", "Close assistant") : t("உதவியாளரிடம் பேசுங்கள்", "Open temple assistant")}
        aria-expanded={open}
      >
        {open ? <LuX aria-hidden="true" /> : <LuBot aria-hidden="true" />}
        {!open && <span className="chatbot__pulse" aria-hidden="true" />}
      </button>
    </div>
  );
}
