import { useCallback, useEffect, useRef, useState } from "react";
import { LuPause, LuPlay, LuSquare, LuVolume2 } from "react-icons/lu";
import { useLang } from "../context/LangContext";
import Button from "./ui/Button";

const PRAYER = "ஓம் சக்தி. பராசக்தி. நம் பிரார்த்தனைகள் அமைதியையும் கருணையையும் மனவலிமையையும் தரட்டும்.";

export default function HeroPrayer() {
  const { t } = useLang();
  const utterance = useRef(null);
  const startTimer = useRef(null);
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState("idle");
  const [failed, setFailed] = useState(false);
  const start = useCallback(() => {
    setFailed(false);
    const speech = new SpeechSynthesisUtterance(PRAYER);
    speech.lang = "ta-IN";
    speech.rate = 0.8;
    speech.onstart = () => {
      clearTimeout(startTimer.current);
      setState("playing");
    };
    speech.onend = () => {
      clearTimeout(startTimer.current);
      utterance.current = null;
      setState("idle");
    };
    speech.onerror = () => {
      clearTimeout(startTimer.current);
      utterance.current = null;
      setState("idle");
      setFailed(true);
    };
    utterance.current = speech;
    setState("starting");
    startTimer.current = setTimeout(() => {
      speech.onstart = null;
      speech.onend = null;
      speech.onerror = null;
      utterance.current = null;
      window.speechSynthesis.cancel();
      setState("idle");
      setFailed(true);
    }, 4000);
    window.speechSynthesis.speak(speech);
  }, []);

  useEffect(() => {
    const available = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
    setSupported(available);
    if (available) start();
    return () => {
      clearTimeout(startTimer.current);
      if (utterance.current) {
        utterance.current.onstart = null;
        utterance.current.onend = null;
        utterance.current.onerror = null;
        window.speechSynthesis.cancel();
        utterance.current = null;
      }
    };
  }, [start]);

  const stop = () => {
    clearTimeout(startTimer.current);
    if (utterance.current) {
      utterance.current.onstart = null;
      utterance.current.onend = null;
      utterance.current.onerror = null;
      utterance.current = null;
      window.speechSynthesis.cancel();
    }
    setState("idle");
  };

  const play = () => {
    const synth = window.speechSynthesis;
    if (state === "playing") {
      synth.pause();
      setState("paused");
      return;
    }
    if (state === "paused") {
      synth.resume();
      setState("playing");
      return;
    }
    start();
  };

  return (
    <div className="hero-prayer">
      <div className="hero-prayer__heading">
        <LuVolume2 aria-hidden="true" />
        <strong>{t("பக்திப் பிரார்த்தனை", "A moment of prayer")}</strong>
      </div>
      <p className="hero-prayer__text" lang="ta">{PRAYER}</p>
      <div className="hero-prayer__controls">
        <Button variant="outline-light" size="sm" disabled={!supported || state === "starting"} onClick={play}
          icon={state === "playing" ? <LuPause aria-hidden="true" /> : <LuPlay aria-hidden="true" />}>
          {state === "starting" ? t("தொடங்குகிறது", "Starting prayer") : state === "playing" ? t("இடைநிறுத்து", "Pause prayer") : state === "paused"
            ? t("தொடர்க", "Resume prayer") : t("கேளுங்கள்", "Play prayer")}
        </Button>
        {state !== "idle" && <Button variant="outline-light" size="sm" onClick={stop}
          icon={<LuSquare aria-hidden="true" />}>{t("நிறுத்து", "Stop")}</Button>}
        <small>{t("சாதனக் குரலில் பிரார்த்தனை", "Spoken prayer · device voice")}</small>
      </div>
      {!supported && <p role="status">{t("இந்த உலாவியில் குரல் வசதி இல்லை.", "Spoken audio is unavailable in this browser.")}</p>}
      {failed && <p role="alert">{t("பிரார்த்தனையை ஒலிக்க இயலவில்லை. கேளுங்கள் பொத்தானை அழுத்தவும்; தேவைப்பட்டால் சாதனத்தின் தமிழ் குரல் அமைப்பைச் சரிபார்க்கவும்.", "Audio could not start. Press Play prayer; if needed, check your device’s Tamil speech voice. Your browser may block autoplay.")}</p>}
    </div>
  );
}
