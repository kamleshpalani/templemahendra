import { useEffect, useRef, useState } from "react";
import { LuChevronLeft, LuChevronRight, LuFlower2, LuMapPin, LuMoon, LuSun, LuSunset } from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import { ADDRESS } from "../data/temple";
import { todayIST, to12h } from "../lib/templeTime";
import Seo from "../components/Seo";
import PageHero from "../components/ui/PageHero";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import Alert from "../components/ui/Alert";
import { SkeletonCards } from "../components/ui/Feedback";
import "./PanchangCalendar.css";

const TIME_FIELDS = [
  ["gulika_kalam", "குளிகை", "Gulikai"],
  ["yamagandam", "எமகண்டம்", "Yamagandam"],
  ["rahu_kalam", "ராகு காலம்", "Rahu Kalam"],
  ["brahma_muhurtham", "பிரம்ம முகூர்த்தம்", "Brahma Muhurtham"],
];
function timeLabel(value) {
  if (!Array.isArray(value) || !value.length) return "—";
  const pairs = Array.isArray(value[0]) ? value : [value];
  return pairs.map(([start, end]) => `${to12h(start)} – ${to12h(end)}`).join(" · ");
}

const CALENDAR_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function regularCalendarUrl(date) {
  const [year, month, day] = date.split("-").map(Number);
  return `https://calendar.goldenchennai.com/tamil-daily-calendar/${day}-${CALENDAR_MONTHS[month - 1]}-${year}/`;
}

function nallaNeramPeriods(value) {
  const morning = [];
  const evening = [];
  if (!Array.isArray(value) || !value.length) return { morning, evening };
  const pairs = Array.isArray(value[0]) ? value : [value];
  for (const [start, end] of pairs) {
    if (start < "12:00") morning.push([start, end > "12:00" ? "12:00" : end]);
    if (end > "12:00") evening.push([start < "12:00" ? "12:00" : start, end]);
  }
  return { morning, evening };
}

export default function PanchangCalendar() {
  const { t, lang } = useLang();
  const today = todayIST();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [date, setDate] = useState(today);
  const [view, setView] = useState("month");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const cells = useRef([]);
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  const label = (value, options) => new Date(`${value}T12:00:00+05:30`).toLocaleDateString(locale, {
    timeZone: "Asia/Kolkata", ...options,
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    const [year, number] = month.split("-").map(Number);
    api.get("/calendar", { params: { year, month: number } }).then((r) => {
      if (active) setData(r.data);
    }).catch(() => { if (active) { setError(true); setData(null); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [month, retry]);

  const selected = data?.days.find((d) => d.date === date) ?? data?.days[0];
  const useGowri = !selected?.verified && Boolean(selected?.gowri_periods?.length);
  const nallaNeram = nallaNeramPeriods(useGowri
    ? selected.gowri_periods.map((period) => [period.start, period.end])
    : selected?.timings.nalla_neram);
  const changeDate = (value) => {
    if (!value) return;
    setDate(value);
    setMonth(value.slice(0, 7));
  };
  const moveMonth = (offset) => {
    const [y, m] = month.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
    if (next < "2020-01" || next > "2035-12") return;
    setMonth(next);
    setDate(`${next}-01`);
  };
  const keyMove = (event, index) => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(data.days.length - 1, index + offsets[event.key]));
    setDate(data.days[next].date);
    cells.current[next]?.focus();
  };

  const dailyPanel = !loading && selected && <article className="panchang-daily card" aria-live="polite">
    <div className="panchang-daily__emblem" aria-hidden="true"><LuMoon /></div>
    <p className="panchang-daily__eyebrow">{t("தினசரி பஞ்சாங்கம்", "Daily Panchangam")}</p>
    <h2>{label(selected.date, { dateStyle: "full" })}</h2>
    <Badge tone={selected.verified ? "success" : "warning"}>
      {selected.verified ? t("கமிட்டியால் சரிபார்க்கப்பட்டது", "Committee verified") : t("கணக்கிடப்பட்டது — ஆலய உறுதி இல்லை", "Calculated — not temple verified")}
    </Badge>
    {!selected.verified && <p className="panchang-daily__warning">{t("சடங்குகளுக்கு முன் கோயில் அலுவலகத்தில் நேரங்களை உறுதி செய்யவும்.",
      "Confirm dates and timings with the temple office before planning rituals.")}</p>}
    <section className="panchang-nalla" aria-labelledby="panchang-nalla-title">
      <h3 id="panchang-nalla-title">{useGowri ? t("கௌரி நல்ல நேரம் · கணக்கிடப்பட்டது", "Gowri Nalla Neram · Calculated") : t("நல்ல நேரம்", "Nalla Neram")}</h3>
      <div className="panchang-nalla__grid">
        {[
          { key: "morning", Icon: LuSun, ta: "காலை · நண்பகல் 12 மணிக்கு முன்", en: "Morning · before noon" },
          { key: "evening", Icon: LuSunset, ta: "பிற்பகல் / மாலை · நண்பகல் 12 மணிக்குப் பின்", en: "Afternoon / Evening · after noon" },
        ].map(({ key, Icon, ta, en }) => <div className="panchang-nalla__card" key={key}>
          <Icon aria-hidden="true" />
          <h4>{t(ta, en)}</h4>
          <p>{nallaNeram[key].length ? timeLabel(nallaNeram[key]) : selected.verified
            ? t("இந்த நேரப்பகுதிக்கு பதிவு இல்லை", "No window entered for this period")
            : t("ஆலய உறுதிக்காகக் காத்திருக்கிறது", "Awaiting temple confirmation")}</p>
          <small>{nallaNeram[key].length ? "IST · Asia/Kolkata" : t("நேரம் ஊகிக்கப்படவில்லை", "No estimated timing substituted")}</small>
        </div>)}
      </div>
      {useGowri && <div className="panchang-gowri">
        <p>{t("சூரிய உதயம் முதல் அஸ்தமனம் வரையிலான கௌரி காலங்கள். இவை வழக்கமான நாள்காட்டி நல்ல நேரமோ ஆலய உறுதி செய்யப்பட்ட முகூர்த்தமோ அல்ல. ராகு காலம் மற்றும் எமகண்ட நேரங்களையும் தனியே பார்க்கவும்.",
          "Daytime Gowri periods, scaled to local sunrise and sunset. These are not regular-calendar Nalla Neram or temple-approved muhurthams. Check Rahu Kalam and Yamagandam separately; overlaps are not removed.")}</p>
        <ul>{selected.gowri_periods.map((period) => <li key={period.start}>
          <strong>{t(period.name_ta, period.name_en)}</strong>
          <span>{to12h(period.start)} – {to12h(period.end)} IST</span>
        </li>)}</ul>
        <small>{t("கௌரி வரிசை ஆதாரம்", "Gowri ordering source")}: <a href="https://github.com/ag-sanjjeev/nalla-neram-js" target="_blank" rel="noopener noreferrer">nalla-neram-js (MIT)</a></small>
      </div>}
      <div className="panchang-reference">
        <Button href={regularCalendarUrl(selected.date)} target="_blank" rel="noopener noreferrer"
          variant="gold" icon={<LuFlower2 aria-hidden="true" />}>
          {t("தமிழ் நாட்காட்டியில் நல்ல நேரம் பார்க்க ↗", "View Nalla Neram in the Tamil calendar ↗")}
        </Button>
        <p>{t("தேர்ந்தெடுத்த தேதிக்கான காலை / மாலை நல்ல நேரம் மற்றும் கௌரி நல்ல நேரத்தை Golden Chennai தளத்தில் பார்க்கலாம். வெளித் தள நேரங்கள் ஆலய இடத்திற்காகச் சரிபார்க்கப்படவில்லை; சில தேதிகள் கிடைக்காமல் இருக்கலாம்.",
          "Opens Golden Chennai for the selected date’s morning/evening Nalla Neram and Gowri Nalla Neram. External timings are not verified for the temple location; some dates may be unavailable.")}</p>
      </div>
    </section>
    <dl className="panchang-primary">
      {selected.sunrise && <div><dt>{t("சூரிய உதயம் / அஸ்தமனம்", "Sunrise / Sunset")}</dt><dd>{to12h(selected.sunrise)} / {to12h(selected.sunset)} IST</dd></div>}
      {(selected.tithi_ta || selected.tithi_en) && <div><dt>{t("திதி", "Tithi")}</dt><dd>{t(selected.tithi_ta, selected.tithi_en)}</dd></div>}
      {selected.tithi_end && <div><dt>{t("திதி முடிவு", "Tithi ends")}</dt><dd>{new Date(selected.tithi_end).toLocaleString(locale, { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} IST</dd></div>}
      <div><dt>{t("நட்சத்திரம்", "Nakshatram")}</dt><dd>{t(selected.nakshatram_ta, selected.nakshatram_en) || t("சரிபார்க்கப்பட்ட தகவல் இல்லை", "Verified data unavailable")}</dd></div>
      {TIME_FIELDS.map(([key, ta, en]) => <div key={key}><dt>{t(ta, en)}</dt><dd>{selected.timings[key]?.length ? timeLabel(selected.timings[key]) : t("ஆலய உறுதி தேவை", "Awaiting temple-approved data")}</dd></div>)}
    </dl>
    {selected.special.map((s, i) => <p key={s.id ?? `${s.type}-${i}`}><strong>{t(s.ta, s.en)}</strong>
      {(s.description_ta || s.description_en) && ` — ${t(s.description_ta, s.description_en)}`}</p>)}
    <p className="panchang-source">{t("ஆதாரம்", "Source")}: {selected.source}<br />
      {selected.location} · {selected.timezone}
      {!selected.verified && selected.coordinates && <><br />{selected.coordinates.join(", ")} · {t("கடல் மட்டம்; உள்ளூர் மலை மறைவு கணக்கில் இல்லை", "Sea-level horizon; local terrain obstruction excluded")}</>}
    </p>
  </article>;

  return (
    <div className="panchang-page">
      <Seo title={t("பஞ்சாங்கம்", "Panchangam")}
        description={t("பௌர்ணமி · ஏகாதசி · நல்ல நேரம் · ராகு காலம்", "Pournami · Ekadasi · Good Timings · Rahu Kalam")} />
      <PageHero variant="panchangam" title={t("பஞ்சாங்க நாட்காட்டி", "Panchangam Calendar")}
        eyebrow={t("வழிபாட்டிற்கான தினசரி வழிகாட்டி", "Your daily guide to worship")}
        lead={`${t(ADDRESS.printed.ta, ADDRESS.printed.en)} · Asia/Kolkata (IST)`}
        crumbs={[{ label: t("பஞ்சாங்கம்", "Panchangam") }]}
        aside={<div className="panchang-hero-note"><LuFlower2 aria-hidden="true" />
          <h2>{t("காலமும் வழிபாடும்", "Sacred days. Meaningful moments.")}</h2>
          <p>{t("தினசரி நேரங்கள், சந்திர நாட்கள், ஆலய நிகழ்வுகள் — ஒரே இடத்தில்.", "Daily timings, lunar observances and temple occasions in one place.")}</p>
          <span><LuMapPin aria-hidden="true" />{t("தென்காசி பகுதி · இந்திய நேரம்", "Tenkasi region · Indian Standard Time")}</span>
        </div>} />
      <section className="section">
        <div className="container">
          {loading ? <SkeletonCards count={2} /> : dailyPanel}
          <div className="panchang-integrity" role="note">
            <strong>{t("பஞ்சாங்க ஆதாரம் பற்றிய குறிப்பு", "A note on accuracy")}</strong>
            <p>{t("இலவச வானியல் கணக்கீடுகள் வழங்கப்பட்ட ஆலய Google Maps இடத்தைப் பயன்படுத்துகின்றன. திதி சூரிய உதய நேரத்திற்கானது. பகல் கௌரி நல்ல நேரம் தனியாகக் கணக்கிடப்படுகிறது; வழக்கமான நல்ல நேரம், நட்சத்திரம் மற்றும் திருவிழா நாட்களுக்கு ஆலய ஆதாரம் தேவை.",
              "Free offline astronomical calculations use the supplied temple Google Maps coordinates. Tithi is measured at sunrise. Daytime Gowri Nalla Neram is calculated separately; regular-calendar Nalla Neram, Nakshatram and festival observances need the temple’s approved reference.")}</p>
          </div>
          <div className="panchang-controls card">
            <Button variant="soft" iconOnly icon={<LuChevronLeft />} onClick={() => moveMonth(-1)} disabled={month === "2020-01"}>
              {t("முந்தைய மாதம்", "Previous month")}
            </Button>
            <h2>{label(`${month}-01`, { month: "long", year: "numeric" })}</h2>
            <Button variant="soft" iconOnly icon={<LuChevronRight />} onClick={() => moveMonth(1)} disabled={month === "2035-12"}>
              {t("அடுத்த மாதம்", "Next month")}
            </Button>
            <label className="field">{t("தேதி", "Date")}
              <input type="date" min="2020-01-01" max="2035-12-31" value={date} onChange={(e) => changeDate(e.target.value)} />
            </label>
            <Button variant="outline" onClick={() => changeDate(today)}>{t("இன்று", "Today")}</Button>
            <div className="cluster" role="group" aria-label={t("காட்சி", "Calendar view")}>
              {["month", "day"].map((mode) => <Button key={mode} variant={view === mode ? "primary" : "outline"}
                aria-pressed={view === mode} onClick={() => setView(mode)}>
                {mode === "month" ? t("மாதம்", "Month") : t("நாள்", "Day")}
              </Button>)}
            </div>
          </div>
          {error && <Alert tone="error">
            {t("பஞ்சாங்கத்தை ஏற்ற இயலவில்லை.", "Panchangam could not be loaded.")}
            <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</Button>
          </Alert>}
          {!loading && data && <div className={`panchang-layout panchang-layout--${view}`}>
            {view === "month" && <div className="panchang-month card">
              <div className="panchang-week" aria-hidden="true">
                {Array.from({ length: 7 }, (_, i) => <span key={i}>
                  {new Date(Date.UTC(2026, 0, 4 + i)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" })}
                </span>)}
              </div>
              <div className="panchang-days" role="group" aria-label={t("தேதியைத் தேர்ந்தெடுக்கவும்", "Choose a date")}>
                {Array.from({ length: data.days[0].weekday }, (_, i) => <span key={`blank-${i}`} />)}
                {data.days.map((day, i) => <button type="button" key={day.date} ref={(el) => { cells.current[i] = el; }}
                  className={`panchang-day${day.special.length ? " panchang-day--special" : ""}`}
                  aria-pressed={selected?.date === day.date} aria-current={day.date === today ? "date" : undefined}
                  aria-label={`${label(day.date, { dateStyle: "full" })} ${day.special.map((s) => t(s.ta, s.en)).join(", ")}`}
                  tabIndex={selected?.date === day.date ? 0 : -1} onKeyDown={(e) => keyMove(e, i)} onClick={() => setDate(day.date)}>
                  <strong>{day.day}</strong>
                  {day.special.slice(0, 2).map((s, j) => <small key={s.id ?? `${s.type}-${j}`}>{t(s.ta, s.en)}</small>)}
                </button>)}
              </div>
              <p>{t("குறியீடுகள்: சூரிய உதயத் திதிகள் மற்றும் ஆலயப் பதிவுகள். திதி ஒரு நாளுக்குள் மாறலாம்; பூஜை மற்றும் விரத நாட்களை ஆலயத்தில் உறுதி செய்யவும்.",
                "Highlights combine sunrise lunar-day markers and temple entries. Tithi can change during the day; festival, fasting and pooja dates require temple confirmation.")}</p>
            </div>}
          </div>}
        </div>
      </section>
    </div>
  );
}
