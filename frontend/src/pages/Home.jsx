import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LuArrowRight, LuBell, LuFlame, LuFlower2, LuHeartHandshake, LuImages, LuMapPin, LuPhone, LuPlay, LuTv, LuUserPlus } from "react-icons/lu";
import api from "../services/api";
import { useLang } from "../context/LangContext";
import { ADDRESS, MAPS_URL, PRIMARY_CONTACT, TEMPLE, TRUST, formatPhone, telHref } from "../data/temple";
import { streamTitle, useLiveOverview } from "../lib/live";
import { getISTNow, isTempleOpen, TEMPLE_HOURS, to12h } from "../lib/templeTime";
import ShareButton from "../components/Share/ShareButton";
import Button from "../components/ui/Button";
import Seo from "../components/Seo";
import Alert from "../components/ui/Alert";
import SectionHeader from "../components/ui/SectionHeader";
import { SkeletonCards } from "../components/ui/Feedback";
import HomepageWidgets from "../components/HomepageWidgets/HomepageWidgets";
import SegmentedControl from "../components/ui/Tabs";
import "./Home.css";

export default function Home() {
  const { t, lang } = useLang();
  const live = useLiveOverview();
  const [content, setContent] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(getISTNow);
  const [pournamis, setPournamis] = useState([]);
  const pournami = pournamis[0];
  const [calendarFailed, setCalendarFailed] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [dailyPanchangam, setDailyPanchangam] = useState(null);
  const [panchangamPaused, setPanchangamPaused] = useState(false);
  const [noticePaused, setNoticePaused] = useState(false);
  const [visitMode, setVisitMode] = useState("first-visit");
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const locale = lang === "ta" ? "ta-IN" : "en-IN";
  const open = isTempleOpen(now);
  const hours = TEMPLE_HOURS.map(({ open, close }) =>
    [open, close].map(([h, m]) => to12h(`${h}:${String(m).padStart(2, "0")}`)).join(" – ")).join(" · ");
  const visitModes = [
    { value: "devotee", label: t("பக்தர்", "Devotee"), icon: <LuFlower2 aria-hidden="true" /> },
    { value: "first-visit", label: t("புதிய வருகை", "First Visit"), icon: <LuMapPin aria-hidden="true" /> },
    { value: "nri", label: t("வெளிநாட்டினர்", "NRI / Online"), icon: <LuTv aria-hidden="true" /> },
    { value: "elder", label: t("மூத்தோர்", "Elder View"), icon: <LuHeartHandshake aria-hidden="true" /> },
    { value: "volunteer", label: t("தன்னார்வலர்", "Volunteer"), icon: <LuUserPlus aria-hidden="true" /> },
    { value: "sponsor", label: t("ஸ்பான்சர்", "Seva Sponsor"), icon: <LuFlame aria-hidden="true" /> },
  ];
  const visitCards = {
    "first-visit": [
      { title: t("கோயில் பற்றி", "About the temple"), body: t(TEMPLE.name.ta, TEMPLE.name.en), to: "/about" },
      { title: t("வழி அறிய", "Getting here"), body: t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en), to: "/contact#location" },
      { title: t("வருகை நேரம்", "Visiting Hours"), body: hours },
      { title: t("உடை விதிமுறை", "Dress Code"), body: t("பாரம்பரிய உடை அணியவும்.", "Please wear traditional attire inside the temple.") },
    ],
    devotee: [
      { title: t("கோயில் நேரம்", "Temple Hours"), body: hours },
      { title: t("பூஜை சேவைகள்", "Pooja Services"), body: t("தினசரி மற்றும் சிறப்பு பூஜைகள்", "Daily and special poojas"), to: "/sevas" },
      { title: t("நிகழ்வுகள்", "Events"), body: t("திருவிழாக்கள் மற்றும் சிறப்பு நிகழ்வுகள்", "Festivals and special occasions"), to: "/events" },
      { title: t("பஞ்சாங்கம்", "Panchangam"), body: t("தினசரி பஞ்சாங்க விவரங்கள்", "Daily calendar and auspicious timings"), to: "/panchangam" },
    ],
    nri: [
      { title: t("நேரடி ஒளிபரப்பு", "Live Stream"), body: t("எங்கிருந்தாலும் தரிசனம் காணுங்கள்.", "Join temple worship from wherever you are."), to: "/live-darshan" },
      { title: t("நன்கொடை", "Donations"), body: t("அறக்கட்டளைக்கு நன்கொடை அளிக்கவும்.", "View the Trust's donation options."), to: "/donations" },
      { title: t("சேவை பதிவு", "Remote Seva Booking"), body: t("உங்கள் பெயரில் சேவையை பதிவு செய்யுங்கள்.", "Book a seva in your name or your family's name."), to: "/sevas" },
      { title: t("படத் தொகுப்பு", "Temple Gallery"), body: t("கோயில் திருவிழாக்களின் படங்கள்", "Photographs of temple festivals and celebrations"), to: "/gallery" },
    ],
    elder: [
      { title: t("இப்போது நிலை", "Current Status"), body: open ? t("கோயில் திறந்துள்ளது", "Temple Open") : t("கோயில் மூடியுள்ளது", "Temple Closed") },
      { title: t("கோயில் நேரம்", "Temple Hours"), body: hours },
      { title: t("தொடர்பு கொள்ள", "Call Temple"), body: formatPhone(PRIMARY_CONTACT.phone), href: telHref(PRIMARY_CONTACT.phone) },
      { title: t("வழி அறிய", "Get Directions"), body: t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en), to: "/contact#location" },
    ],
    volunteer: [
      { title: t("பூ அலங்காரம்", "Flower Decoration"), body: t("திருவிழா நாட்களில் கோவில் அலங்கரிக்க உதவுங்கள்.", "Help decorate the temple on festival days.") },
      { title: t("அன்னதானம்", "Annadanam"), body: t("பக்தர்களுக்கு உணவு வழங்க உதவுங்கள்.", "Help serve meals to devotees.") },
      { title: t("சுத்தம் & பராமரிப்பு", "Cleaning & Upkeep"), body: t("கோவில் வளாகத்தை சுத்தமாக வைக்க உதவுங்கள்.", "Help keep the temple premises clean.") },
      { title: t("நிகழ்வு ஒருங்கிணைப்பு", "Event Coordination"), body: t("திருவிழாக்களை ஒருங்கிணைக்க உதவுங்கள்.", "Help coordinate festivals and special poojas.") },
      { title: t("படம் & பதிவு", "Photography & Documentation"), body: t("கோவில் நிகழ்வுகளை படம் எடுத்து பதிவு செய்யுங்கள்.", "Help photograph and document temple events.") },
    ],
    sponsor: [
      { title: t("அபிஷேகம்", "Abhishekam"), body: t("அபிஷேக சேவையை ஆதரிக்கவும்.", "Sponsor an Abhishekam service."), to: "/sevas" },
      { title: t("அர்ச்சனை", "Archana"), body: t("உங்கள் குடும்பத்தினர் பெயரில் அர்ச்சனை.", "Offer Archana in your family's name."), to: "/sevas" },
      { title: t("அன்னதானம்", "Annadanam"), body: t("பக்தர்களுக்கு உணவு வழங்க ஆதரிக்கவும்.", "Sponsor meals for devotees."), to: "/sevas" },
    ],
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(getISTNow()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    setCalendarFailed(false);
    setCalendarLoading(true);
    setPournamis([]);
    setDailyPanchangam(null);
    const [year, month] = today.split("-").map(Number);
    Promise.all([0, 1, 2].map((offset) => {
      const date = new Date(Date.UTC(year, month - 1 + offset, 1));
      return api.get("/calendar", { params: { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 } });
    })).then((responses) => {
      if (active) setDailyPanchangam(responses[0].data.days.find((day) => day.date === today) ?? null);
      if (active) setPournamis(responses.flatMap((r) => r.data.days).filter((day) =>
        day.date >= today && day.special?.some((special) => special.type === "pournami")).slice(0, 3));
    }).catch(() => { if (active) setCalendarFailed(true); })
      .finally(() => { if (active) setCalendarLoading(false); });
    return () => { active = false; };
  }, [today, attempt]);

  useEffect(() => {
    let active = true;
    setFailed(false);
    Promise.all([
      api.get("/announcements?limit=4"),
      api.get("/homepage_widgets"),
      api.get("/sevas?limit=4&featured=1"),
      api.get("/events?limit=4&upcoming=1"),
      api.get("/settings"),
    ]).then(([notices, widgets, sevas, events, settings]) => {
      if (active) setContent({
        notices: notices.data, widgets: widgets.data, sevas: sevas.data, events: events.data,
        settings: settings.data,
      });
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [attempt]);

  const panchangamItems = [];
  if (dailyPanchangam) {
    const day = dailyPanchangam;
    const windows = (value) => {
      return (Array.isArray(value[0]) ? value : [value])
        .map(([start, end]) => `${to12h(start)} – ${to12h(end)}`).join(" / ");
    };
    panchangamItems.push(
      new Date(`${day.date}T12:00:00+05:30`).toLocaleDateString(locale, { timeZone: "Asia/Kolkata", dateStyle: "full" }),
      day.verified ? t("கமிட்டியால் சரிபார்க்கப்பட்டது", "Committee verified") : t("கணக்கிடப்பட்டது · ஆலய உறுதி இல்லை", "Calculated · not temple verified"),
    );
    if (t(day.tithi_ta, day.tithi_en)?.trim()) panchangamItems.push(`${t("திதி", "Tithi")}: ${t(day.tithi_ta, day.tithi_en)}`);
    if (t(day.nakshatram_ta, day.nakshatram_en)?.trim()) panchangamItems.push(`${t("நட்சத்திரம்", "Nakshatram")}: ${t(day.nakshatram_ta, day.nakshatram_en)}`);
    if (day.paksha) panchangamItems.push(day.paksha === "shukla" ? t("வளர்பிறை", "Shukla Paksha") : t("தேய்பிறை", "Krishna Paksha"));
    if (day.tithi_end) panchangamItems.push(`${t("திதி முடிவு", "Tithi ends")}: ${new Date(day.tithi_end).toLocaleString(locale, {
      timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    })} IST`);
    if (day.sunrise) panchangamItems.push(`${t("சூரிய உதயம்", "Sunrise")}: ${to12h(day.sunrise)}`);
    if (day.sunset) panchangamItems.push(`${t("சூரிய அஸ்தமனம்", "Sunset")}: ${to12h(day.sunset)}`);
    if (!day.verified && day.gowri_periods?.length) {
      for (const period of day.gowri_periods) panchangamItems.push(
        `${t("கௌரி நல்ல நேரம்", "Gowri Nalla Neram")} · ${t(period.name_ta, period.name_en)}: ${to12h(period.start)} – ${to12h(period.end)}`);
      panchangamItems.push(t("கௌரி நேரங்கள் வழக்கமான நாள்காட்டி நல்ல நேரம் அல்ல; ராகு காலம் / எமகண்டத்தையும் பார்க்கவும்.",
        "Gowri periods are not regular-calendar Nalla Neram; check Rahu Kalam / Yamagandam for overlaps."));
    } else if (day.timings.nalla_neram?.length) panchangamItems.push(`${t("நல்ல நேரம்", "Nalla Neram")}: ${windows(day.timings.nalla_neram)}`);
    for (const [key, ta, en] of [
      ["rahu_kalam", "ராகு காலம்", "Rahu Kalam"], ["yamagandam", "எமகண்டம்", "Yamagandam"],
      ["gulika_kalam", "குளிகை", "Gulikai"], ["brahma_muhurtham", "பிரம்ம முகூர்த்தம்", "Brahma Muhurtham"],
    ]) {
      if (day.timings[key]?.length) panchangamItems.push(`${t(ta, en)}: ${windows(day.timings[key])}`);
    }
    for (const special of day.special) {
      const text = [t(special.ta, special.en), t(special.description_ta, special.description_en)].filter((value) => value?.trim()).join(" — ");
      if (text) panchangamItems.push(text);
    }
    panchangamItems.push([day.location, "IST (Asia/Kolkata)"].filter(Boolean).join(" · "));
    if (day.source?.trim()) panchangamItems.push(`${t("ஆதாரம்", "Source")}: ${day.source}`);
  }

  const scheduled = content?.widgets.filter((w) =>
    ["upcoming_pooja", "calendar_pooja"].includes(w.content_type) &&
      (w.content_type !== "calendar_pooja" || content.settings.show_pournami_section)) ?? [];
  const noticeTitles = new Set(content?.notices.map((notice) => notice.title.trim().toLocaleLowerCase()) ?? []);
  const updates = content?.widgets.filter((w) =>
    !["upcoming_pooja", "calendar_pooja", "nalla_neram"].includes(w.content_type) &&
    ![w.title_ta, w.title_en].some((title) => title && noticeTitles.has(title.trim().toLocaleLowerCase()))) ?? [];
  const linkedEventIds = new Set(updates.map((w) => w.linked_event_id).filter(Boolean).map(String));
  const events = (content?.events ?? []).filter((event) =>
    !linkedEventIds.has(String(event.id)) && !updates.some((widget) =>
      widget.content_type === "upcoming_event" && widget.event_date === event.event_date &&
      [widget.title_ta, widget.title_en].some((title) => title &&
        [event.title_ta, event.title_en].some((eventTitle) => eventTitle &&
          title.trim().toLocaleLowerCase() === eventTitle.trim().toLocaleLowerCase()))));
  const upcomingWidgets = [
    ...(content?.widgets.filter((widget) => scheduled.includes(widget) || updates.includes(widget)) ?? []),
    ...events.map((event) => ({
      id: `event-${event.id}`,
      content_type: "upcoming_event",
      title_ta: event.title_ta,
      title_en: event.title_en,
      description_ta: event.description,
      description_en: event.description,
      event_date: event.event_date,
    })),
  ];
  const visiblePournamis = content?.settings.show_pournami_section === false ? [] : pournamis;
  const noticeItems = [
    ...(content?.notices ?? []).map((notice) => ({
      id: `notice-${notice.id}`, title: notice.title, body: notice.body,
      category: t("அறிவிப்பு", "Announcement"), to: "/events#temple-notices",
    })),
    ...upcomingWidgets.filter((widget) => ["announcement", "upcoming_event", "coming_soon", "upcoming_pooja", "calendar_pooja"].includes(widget.content_type)).map((widget) => ({
      id: `update-${widget.id}`, title: t(widget.title_ta, widget.title_en) ||
        (widget.content_type === "calendar_pooja" ? t("பௌர்ணமி பூஜை", "Pournami Pooja") : t("ஆலயத் தகவல்", "Temple update")),
      body: t(widget.description_ta, widget.description_en),
      date: widget.event_date ?? widget.pooja?.date,
      time: widget.pooja?.time,
      category: ["upcoming_pooja", "calendar_pooja"].includes(widget.content_type)
        ? t("பூஜை", "Pooja") : t("நிகழ்வு / தகவல்", "Event / Update"),
      to: "#home-events-title",
    })),
  ].filter((item) => item.title?.trim());
  const noticeDuration = Math.max(45, noticeItems.reduce((length, item) =>
    length + item.title.length + (item.body?.length ?? 0) + 35, 0) / 8);

  return (
    <>
      <Seo description={t(TEMPLE.name.ta, TEMPLE.name.en)} />
      <section className="home-hero" aria-labelledby="home-title">
        <div className="container home-hero__content">
          <div className="home-hero__welcome">
            <div className="home-hero__ornament" aria-hidden="true"><LuFlower2 /><LuFlame /><LuFlower2 /></div>
            <p className="home-hero__eyebrow">{t("அருளும் ஆசிகளும்", "Devotion & blessings")}</p>
            <p className="home-hero__invocation">{t(TEMPLE.invocation.ta, TEMPLE.invocation.en)}</p>
            <h1 id="home-title">{t(TEMPLE.name.ta, TEMPLE.name.en)}</h1>
            <div className="home-hero__actions">
              <Button to="/sevas" variant="gold" size="lg" icon={<LuFlower2 aria-hidden="true" />}>
                {t("சேவை பதிவு", "Book a Seva")}
              </Button>
              <Button to="/register" variant="outline-light" size="lg" icon={<LuUserPlus aria-hidden="true" />}>
                {t("குடும்பப் பதிவு", "Register your family")}
              </Button>
            </div>
            <div className="home-hero__utilities">
              <Button to="/contact#location" variant="outline-light" size="lg" icon={<LuMapPin aria-hidden="true" />}>
                {t("முகவரி", "Address")}
              </Button>
              <a href={MAPS_URL} target="_blank" rel="noopener noreferrer" className="home-hero__family">
                <LuMapPin aria-hidden="true" /> {t("வழி அறிய", "Get directions")}
              </a>
              <ShareButton variant="outline-light" size="lg" />
            </div>
            <address className="home-hero__address">{t(ADDRESS.oneLine.ta, ADDRESS.oneLine.en)}</address>
          </div>
          <div className="home-hero__side">
            <aside className="home-hero__panel" aria-label={t("கோயில் தகவல்", "Temple information")}>
            <div className="home-hero__status">
              <strong className={`home-hero__state${open ? " home-hero__state--open" : ""}`}>{open ? t("கோயில் திறந்துள்ளது", "Temple Open") : t("கோயில் மூடியுள்ளது", "Temple Closed")}</strong>
              <time dateTime={today}>{now.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })} IST</time>
            </div>
            <section className="hero-darshan" aria-labelledby="hero-darshan-title">
              <div className="hero-darshan__top">
                <LuTv aria-hidden="true" />
                <span className={`hero-darshan__badge${live.now ? " hero-darshan__badge--live" : ""}`}>
                  {live.loading ? t("சரிபார்க்கிறது", "Checking status") : live.error
                    ? t("நிலையை அறிய இயலவில்லை", "Status unavailable") : live.now
                      ? t("இப்போது நேரலை", "Live now") : t("கோயில் ஒளிபரப்புகள்", "Temple broadcasts")}
                </span>
              </div>
              <h2 id="hero-darshan-title">{t("நேரடி தரிசனம்", "Live Darshan")}</h2>
              <p>{live.now ? streamTitle(live.now, lang) : t(
                "எங்கிருந்தாலும் இறையருளுடன் இணைந்திருங்கள்.",
                "A sacred connection, wherever you are.",
              )}</p>
              <Button to={live.now ? `/live-darshan/${live.now.slug}` : "/live-darshan"}
                variant="gold" size="lg" className="hero-darshan__cta" icon={<LuPlay aria-hidden="true" />}>
                {live.now ? t("நேரலையைக் காணுங்கள்", "Watch live now") : t("தரிசனத்தைக் காணுங்கள்", "Explore Darshan")}
                <LuArrowRight aria-hidden="true" />
              </Button>
              {live.error && <button type="button" className="hero-darshan__retry" onClick={live.refresh}>
                {t("மீண்டும் முயற்சி", "Retry status")}
              </button>}
            </section>
            <dl className="home-hero__details">
              <div><dt>{t("கோயில் நேரம்", "Temple Hours")}</dt><dd>{hours}</dd></div>
              {content?.settings.show_pournami_section !== false && <div>
                <dt>{t("அடுத்த பௌர்ணமி", "Next Pournami")}</dt>
                <dd>{calendarFailed ? t("தேதியை ஏற்ற இயலவில்லை.", "Date could not be loaded.") : pournami
                  ? <Link to="/panchangam">{new Date(`${pournami.date}T12:00:00+05:30`).toLocaleDateString(locale, {
                    timeZone: "Asia/Kolkata", day: "numeric", month: "short",
                  })}{pournami.date === today && ` · ${t("இன்று", "Today")}`}</Link>
                  : t("நாட்காட்டியைப் பார்க்கவும்", "See calendar")}</dd>
              </div>}
            </dl>
            {calendarFailed && <Button variant="outline-light" onClick={() => setAttempt((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</Button>}
            <a className="home-hero__call" href={telHref(PRIMARY_CONTACT.phone)}>
              <LuPhone aria-hidden="true" />
              <span>{formatPhone(PRIMARY_CONTACT.phone)}</span>
              <small>{t(PRIMARY_CONTACT.role.ta, PRIMARY_CONTACT.role.en)}</small>
            </a>
            </aside>
          </div>
        </div>
      </section>

      <section className={`home-panchangam${panchangamPaused ? " home-panchangam--paused" : ""}`}
        aria-label={t("இன்றைய பஞ்சாங்க அறிவிப்பு", "Today's Panchangam notice")}>
        <div className="home-panchangam__heading"><LuFlower2 aria-hidden="true" />
          <strong>{t("இன்றைய பஞ்சாங்கம்", "Today's Panchangam")}</strong>
        </div>
        {calendarLoading ? <p role="status">{t("பஞ்சாங்கம் ஏற்றப்படுகிறது…", "Loading Panchangam…")}</p>
          : calendarFailed || !dailyPanchangam ? <div className="home-panchangam__error">
            <span role="status">{t("பஞ்சாங்கத்தை ஏற்ற இயலவில்லை.", "Panchangam could not be loaded.")}</span>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</button>
          </div> : <>
            <div className="home-panchangam__viewport" tabIndex={0}
              aria-label={t("பஞ்சாங்க நேரங்கள் · நகர்வை நிறுத்த சுட்டியை வைக்கவும்", "Panchangam timings · hover or focus to pause")}>
              <div className="home-panchangam__track" style={{ "--ticker-duration": `${Math.max(90, panchangamItems.join("").length / 9)}s` }}>
                {[0, 1].map((copy) => <ul key={copy} aria-hidden={copy === 1 ? true : undefined}>
                  {panchangamItems.map((item, index) => <li key={index}>{item}</li>)}
                </ul>)}
              </div>
            </div>
            <button type="button" className="home-panchangam__toggle" aria-pressed={panchangamPaused}
              onClick={() => setPanchangamPaused((paused) => !paused)}>
              {panchangamPaused ? t("நகர்வைத் தொடர", "Resume") : t("நகர்வை நிறுத்த", "Pause")}
            </button>
          </>}
        <Link to="/panchangam" className="home-panchangam__link">{t("முழு பஞ்சாங்கம்", "Full calendar")} <LuArrowRight aria-hidden="true" /></Link>
      </section>

      {failed && <div className="container section">
        <Alert tone="error">{t("தகவல்களை ஏற்ற இயலவில்லை.", "Temple updates could not be loaded.")}</Alert>
        <Button onClick={() => setAttempt((n) => n + 1)} variant="outline">{t("மீண்டும் முயற்சி", "Try again")}</Button>
      </div>}
      {!content && !failed && <div className="container section"><SkeletonCards count={3} /></div>}

      <section className="section" aria-labelledby="home-events-title">
        <div className="container">
      <section className={`home-panchangam home-notice-ticker home-notice-panel${noticePaused ? " home-panchangam--paused" : ""}`}
        aria-labelledby="home-notice-ticker-title">
        <div className="home-panchangam__heading">
          <span className="home-notice-ticker__icon"><LuBell aria-hidden="true" /></span>
          <div><small>{t("ஆலயத் தகவல்கள்", "Temple updates")}</small>
            <h2 id="home-notice-ticker-title">{t("அறிவிப்புகள்", "Notice Board")}</h2></div>
        </div>
        {failed ? <div className="home-panchangam__error">
          <span role="status">{t("அறிவிப்புகளை ஏற்ற இயலவில்லை.", "Notices could not be loaded.")}</span>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</button>
        </div> : !content ? <p role="status">{t("அறிவிப்புகள் ஏற்றப்படுகின்றன…", "Loading temple notices…")}</p>
          : noticeItems.length ? <>
            <div className="home-panchangam__viewport" tabIndex={0}
              aria-label={t("நிகழ்வுகள் மற்றும் முக்கிய அறிவிப்புகள்", "Events and important announcements")}>
              <div className="home-panchangam__track" style={{ "--ticker-duration": `${noticeDuration}s` }}>
                {[0, 1].map((copy) => <ul key={copy} aria-hidden={copy === 1 ? true : undefined}>
                  {noticeItems.map((item) => {
                    const notice = <>
                      <span className="home-notice-ticker__category">{item.category}</span>
                      {item.date && <time dateTime={item.date}>{new Date(`${item.date}T12:00:00+05:30`).toLocaleDateString(locale, {
                        timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
                      })}</time>}
                      <strong>{item.title}</strong>
                      {item.time && <span>{item.time} IST</span>}
                      {item.body && <span>{item.body}</span>}
                    </>;
                    return <li key={item.id}>{copy === 0
                      ? <a href={item.to}>{notice}</a>
                      : <span className="home-notice-ticker__copy">{notice}</span>}</li>;
                  })}
                </ul>)}
              </div>
            </div>
            <button type="button" className="home-panchangam__toggle" aria-pressed={noticePaused}
              onClick={() => setNoticePaused((paused) => !paused)}>
              {noticePaused ? t("நகர்வைத் தொடர", "Resume") : t("நகர்வை நிறுத்த", "Pause")}
            </button>
          </> : <p>{t("புதிய அறிவிப்புகள் வெளியானதும் இங்கே காணலாம்.", "New notices will appear here when published.")}</p>}
        <Link to="/events" className="home-panchangam__link">{t("நிகழ்வுகள்", "All events")} <LuArrowRight aria-hidden="true" /></Link>
      </section>

          <SectionHeader id="home-events-title" align="split" eyebrow={t("இன்று & விரைவில்", "Now & next")}
            title={t("அடுத்த நிகழ்வுகள்", "Upcoming Events & Announcements")}
            actions={<Button to="/events" variant="outline" size="sm">{t("அனைத்து நிகழ்வுகள் →", "All Events →")}</Button>} />
          <HomepageWidgets widgets={upcomingWidgets} pournamis={visiblePournamis} lang={lang}
            limit={upcomingWidgets.length + visiblePournamis.length} />
          {(!content && !failed || calendarLoading) && <SkeletonCards count={3} />}
          {(failed || calendarFailed) && <>
            <Alert tone="error">{t("நிகழ்வுகள் மற்றும் அறிவிப்புகளை ஏற்ற இயலவில்லை.", "Events and announcements could not be loaded.")}</Alert>
            <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</Button>
          </>}
          {content && !failed && !calendarFailed && !calendarLoading && upcomingWidgets.length === 0 && visiblePournamis.length === 0 &&
            <p>{t("புதிய நிகழ்வுகள் மற்றும் அறிவிப்புகள் விரைவில்.", "Upcoming events and announcements will appear here when published.")}</p>}
        </div>
      </section>

      <section className="section home-visit" aria-labelledby="home-visit-title">
        <div className="container">
          <div className="home-visit__intro">
          <span className="home-visit__emblem" aria-hidden="true"><LuFlower2 /></span>
          <SectionHeader id="home-visit-title" align="left" eyebrow={t("பக்தியுடன் ஒரு பயணம்", "A journey of devotion")}
            title={t("உங்கள் வருகையைத் திட்டமிடுங்கள்", "Plan your visit")}
            subtitle={t("அம்மன் தரிசனம், குடும்ப வழிபாடு, இறைச் சேவை — உங்கள் வருகைக்கான வழிகாட்டி.", "For darshan, family worship or sacred service — find the guidance for your visit.")} />
          </div>
          <SegmentedControl label={t("உங்கள் வருகை வகை", "Your Visit Type")} value={visitMode}
            onChange={setVisitMode} items={visitModes} className="home-visit__tabs" />
          <div className={`home-visit__grid${visitMode === "elder" ? " home-visit__grid--elder" : ""}`}>
            {visitCards[visitMode].map((card, index) => <article key={`${visitMode}-${index}`} className="home-visit__card card card--static">
              <span className="home-visit__number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{card.title}</h3><p>{card.body}</p>
                {card.to && <Link to={card.to}>{t("மேலும் அறிய →", "Learn more →")}</Link>}
                {card.href && <a href={card.href}>{t("அழைக்கவும் →", "Call now →")}</a>}
              </div>
            </article>)}
          </div>
          <div className="home-visit__actions">
            <Button to={visitMode === "volunteer" ? "/contact" : "/sevas"} variant="gold" icon={<LuFlower2 aria-hidden="true" />}>
              {visitMode === "volunteer" ? t("தொடர்பு கொள்ள →", "Get in Touch →") : t("சேவை பதிவு →", "Book a Seva →")}
            </Button>
            <Button to="/contact#location" variant="outline-light" icon={<LuMapPin aria-hidden="true" />}>{t("வழி அறிய →", "Get Directions →")}</Button>
          </div>
        </div>
      </section>

      <section className="section home-sevas" aria-labelledby="home-sevas-title">
        <div className="container">
          <SectionHeader id="home-sevas-title" align="split" eyebrow={t("பக்தியுடன் சமர்ப்பணம்", "An offering of devotion")}
            title={t("சேவைகள்", "Sevas")}
            subtitle={t("கோயிலில் தினசரி மற்றும் சிறப்பு பூஜைகளை பதிவு செய்யுங்கள்", "Book daily and special poojas at the temple")}
            actions={<Button to="/sevas" variant="outline" size="sm">{t("அனைத்து சேவைகளும் →", "View All Sevas →")}</Button>} />
          {!content && !failed && <SkeletonCards count={4} />}
          {failed && <>
            <Alert tone="error">{t("சேவைகளை ஏற்ற இயலவில்லை.", "Sevas could not be loaded.")}</Alert>
            <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>{t("மீண்டும் முயற்சி", "Try again")}</Button>
          </>}
          <div className="grid-4 home-seva-grid">
            {content?.sevas.map((seva) => <Link key={seva.id} to={`/sevas?seva=${seva.id}`} className="home-seva card card--interactive">
              <span className="card__icon"><LuFlower2 aria-hidden="true" /></span>
              <h3 className="home-seva__name">{t(seva.name_ta, seva.name_en)}</h3>
              <p className="home-seva__price text-gradient">{Number(seva.amount) > 0
                ? `₹${Number(seva.amount).toLocaleString("en-IN")}` : t("அலுவலகத்தை அணுகவும்", "Contact office for charges")}</p>
              <span className="home-seva__cta">{t("சேவை பதிவு", "Book this Seva")} <LuArrowRight aria-hidden="true" /></span>
            </Link>)}
          </div>
          {content && content.sevas.length === 0 && <p>{t("சேவை விவரங்களுக்கு அலுவலகத்தை அணுகவும்.", "Contact the temple office for available sevas.")}</p>}
        </div>
      </section>

      <section className="section" aria-label={t("விரைவு இணைப்புகள்", "Quick links")}>
        <div className="container">
          <div className="grid-3 home-quick">
            <Link to="/donations" className="home-quick__card card card--interactive">
              <span className="card__icon" aria-hidden="true"><LuHeartHandshake /></span>
              <h3>{t("நன்கொடை", "Donate")}</h3>
              <p>{t(
                `பூஜைகள், அன்னதானம் & கோவில் பராமரிப்பிற்கு நன்கொடை · அறக்கட்டளை பெயரில் வங்கி / காசோலை · ${TRUST.taxExemption.short.ta}`,
                `Support poojas, annadanam & temple maintenance · Bank transfer or cheque in the Trust's name · ${TRUST.taxExemption.short.en}`,
              )}</p>
            </Link>
            <Link to="/gallery" className="home-quick__card card card--interactive">
              <span className="card__icon" aria-hidden="true"><LuImages /></span>
              <h3>{t("படத் தொகுப்பு", "Gallery")}</h3>
              <p>{t("கோயில் மற்றும் திருவிழாக்களின் புகைப்படங்களைக் காணுங்கள்", "Browse photos of the temple and its festivals")}</p>
            </Link>
            <Link to="/contact" className="home-quick__card card card--interactive">
              <span className="card__icon" aria-hidden="true"><LuMapPin /></span>
              <h3>{t("தொடர்பு கொள்ளுங்கள்", "Contact")}</h3>
              <p>{t("வழி மற்றும் வருகை நேரங்களை அறிந்துகொள்ளுங்கள்", "Get directions and visiting hours")}</p>
            </Link>
          </div>
        </div>
      </section>

    </>
  );
}
