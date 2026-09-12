/**
 * src/lib/templeTime.js — shared temple-clock helpers (IST) used by the
 * status strip, navbar live pill, home hero panel and panchangam fallback.
 * The backend mirrors the same tables in api/pulse.php and api/homepage_widgets.php.
 */

/** Daily pooja schedule (IST). */
export const POOJA_SCHEDULE = [
  { ta: "திருவனந்தல்", en: "Thiruvanandal", h: 6, m: 0 },
  { ta: "காலசந்தி", en: "Kalasanthi", h: 8, m: 0 },
  { ta: "உச்சிக்கால பூஜை", en: "Uchikala Pooja", h: 12, m: 0 },
  { ta: "சாயரட்சை", en: "Sayaratchai", h: 16, m: 30 },
  { ta: "இரண்டாம்கால", en: "Irandamkaalai", h: 18, m: 30 },
  { ta: "அர்த்த ஜாமம்", en: "Ardha Jamam", h: 20, m: 30 },
];

/** Temple hours: morning 6:00–12:30 · evening 16:00–21:00 (IST). */
export const TEMPLE_HOURS = [
  { open: [6, 0], close: [12, 30] },
  { open: [16, 0], close: [21, 0] },
];

/** Today's special alankaram by weekday (0 = Sunday). */
export const DAILY_SPECIAL = [
  { ta: "ஆதிமூலம் அலங்காரம்", en: "Spl Alankaram" },
  { ta: "வெள்ளி அலங்காரம்", en: "Silver Alankaram" },
  { ta: "பால் அபிஷேகம்", en: "Milk Abhishekam" },
  { ta: "குங்குமார்ச்சனை", en: "Kumkum Archana" },
  { ta: "பன்னீர் அபிஷேகம்", en: "Rosewater Abhishekam" },
  { ta: "நவதானிய அர்ப்பணம்", en: "Navadhanya Offering" },
  { ta: "விளக்கு பூஜை", en: "Deepa Pooja" },
];

/** Nalla Neram slots by IST weekday (0 = Sunday). */
export const NALLA_NERAM = [
  [["07:30", "09:00"], ["22:30", "24:00"]],
  [["06:00", "07:30"], ["15:00", "16:30"]],
  [["07:30", "09:00"], ["22:30", "24:00"]],
  [["07:30", "09:00"], ["12:00", "13:30"]],
  [["10:30", "12:00"], ["19:30", "21:00"]],
  [["10:30", "12:00"], ["16:30", "18:00"]],
  [["06:00", "07:30"], ["19:30", "21:00"]],
];

/** Current wall-clock time in Asia/Kolkata regardless of the visitor's zone. */
export function getISTNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

export function isTempleOpen(now = getISTNow()) {
  const mins = now.getHours() * 60 + now.getMinutes();
  return TEMPLE_HOURS.some(({ open, close }) => mins >= open[0] * 60 + open[1] && mins < close[0] * 60 + close[1]);
}

/** Next pooja after `now`, with seconds remaining (rolls over to tomorrow's first pooja). */
export function getNextPooja(now = getISTNow()) {
  const h = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();
  const nowMins = h * 60 + m;
  const today = POOJA_SCHEDULE.find((p) => p.h * 60 + p.m > nowMins);
  if (today) {
    return { pooja: today, diffSec: (today.h * 60 + today.m) * 60 - (h * 3600 + m * 60 + s) };
  }
  const first = POOJA_SCHEDULE[0];
  const untilMidnight = (24 * 60 - nowMins) * 60 - s;
  return { pooja: first, diffSec: untilMidnight + first.h * 3600 + first.m * 60 };
}

const pad = (n) => String(n).padStart(2, "0");

export function secToHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** "07:30" → "7:30 AM" */
export function to12h(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const hr = h % 24;
  const suffix = hr >= 12 ? "PM" : "AM";
  const h12 = hr % 12 === 0 ? 12 : hr % 12;
  return `${h12}:${pad(m)} ${suffix}`;
}

/** Today's IST date as YYYY-MM-DD (avoids the UTC shift of toISOString()). */
export function todayIST() {
  const d = getISTNow();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
