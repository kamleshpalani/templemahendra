import { useState, useRef, useEffect, useCallback } from "react";
import { FaRobot, FaTimes, FaPaperPlane, FaChevronDown } from "react-icons/fa";
import { useLang } from "../../context/LangContext";
import "./Chatbot.css";

const WELCOME_TA =
  "வணக்கம்! 🙏 நான் ஆலய உதவியாளர்.\nபூஜை நேரம், சேவைகள், நிகழ்வுகள் அல்லது நன்கொடை பற்றி கேட்கலாம்.";
const WELCOME_EN =
  "Namaskar! 🙏 I'm your Temple Assistant.\nAsk me about pooja timings, sevas, festivals, or donations.";

export default function Chatbot() {
  const { lang, t } = useLang();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Initialise welcome message when chat opens
  useEffect(() => {
    if (open && messages.length === 0) {
      setMessages([
        { role: "assistant", text: lang === "ta" ? WELCOME_TA : WELCOME_EN },
      ]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to newest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Focus input when chat opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  const send = useCallback(async () => {
    const text = input.trim();
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
          // send last 8 turns for context
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
          text:
            data.reply ??
            t(
              "மன்னிக்கவும், பதில் கிடைக்கவில்லை.",
              "Sorry, no response received.",
            ),
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: t(
            "மன்னிக்கவும். சேவை தற்போது இல்லை. நேரடியாக அழைக்கவும்:\n+91 00000 00000",
            "Sorry, service unavailable. Please call us directly:\n+91 00000 00000",
          ),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, t]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="chatbot">
      {/* Chat window */}
      {open && (
        <div
          className="chatbot__window"
          role="dialog"
          aria-label={t("ஆலய உதவியாளர்", "Temple Assistant")}
        >
          {/* Header */}
          <div className="chatbot__header">
            <div className="chatbot__header-info">
              <div className="chatbot__avatar">
                <FaRobot />
              </div>
              <div>
                <span className="chatbot__header-title">
                  {t("ஆலய உதவியாளர்", "Temple Assistant")}
                </span>
                <span className="chatbot__header-sub">
                  {t("AI இயங்கும்", "AI Powered")}
                </span>
              </div>
            </div>
            <button
              className="chatbot__btn-icon"
              onClick={() => setOpen(false)}
              aria-label={t("மூடு", "Close chat")}
            >
              <FaChevronDown />
            </button>
          </div>

          {/* Message list */}
          <div className="chatbot__body">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`chatbot__bubble chatbot__bubble--${m.role}`}
              >
                {m.role === "assistant" && (
                  <span className="chatbot__bot-icon" aria-hidden="true">
                    🙏
                  </span>
                )}
                <p className="chatbot__text">{m.text}</p>
              </div>
            ))}

            {loading && (
              <div className="chatbot__bubble chatbot__bubble--assistant">
                <span className="chatbot__bot-icon" aria-hidden="true">
                  🙏
                </span>
                <div
                  className="chatbot__typing"
                  aria-label={t("தட்டச்சு செய்கிறது", "Typing")}
                >
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Quick suggestion chips */}
          {messages.length <= 1 && (
            <div className="chatbot__chips">
              {[
                { ta: "நேரம் என்ன?", en: "Temple timings?" },
                { ta: "சேவைகள் என்ன?", en: "What sevas?" },
                { ta: "நன்கொடை?", en: "How to donate?" },
              ].map((chip) => (
                <button
                  key={chip.en}
                  className="chatbot__chip"
                  onClick={() => {
                    setInput(t(chip.ta, chip.en));
                    setTimeout(() => inputRef.current?.focus(), 50);
                  }}
                >
                  {t(chip.ta, chip.en)}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="chatbot__footer">
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
            />
            <button
              className="chatbot__send"
              onClick={send}
              disabled={!input.trim() || loading}
              aria-label={t("அனுப்பு", "Send")}
            >
              <FaPaperPlane />
            </button>
          </div>
        </div>
      )}

      {/* Trigger button */}
      <button
        className={`chatbot__trigger${open ? " chatbot__trigger--open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={
          open
            ? t("மூடு", "Close chatbot")
            : t("உதவியாளரிடம் பேசுங்கள்", "Open chatbot")
        }
        aria-expanded={open}
      >
        {open ? <FaTimes /> : <FaRobot />}
        {!open && <span className="chatbot__pulse" aria-hidden="true" />}
      </button>
    </div>
  );
}
