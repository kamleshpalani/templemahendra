import { createRequire } from "node:module";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { Observer, SearchRiseSet, MoonPhase, SearchMoonPhase } = require("astronomy-engine");
const config = JSON.parse(readFileSync(new URL("../../backend/config/panchangam_location.json", import.meta.url)));
if (config.timezone !== "Asia/Kolkata" || !Number.isFinite(config.latitude) || !Number.isFinite(config.longitude)
    || Math.abs(config.latitude) > 90 || Math.abs(config.longitude) > 180) {
  throw new Error("Invalid Panchangam location configuration");
}
const observer = new Observer(config.latitude, config.longitude, config.elevation);
const directory = new URL("../../backend/data/panchangam/", import.meta.url);
mkdirSync(directory, { recursive: true });
const clock = (date) => new Date(Math.round(date.getTime() / 60000) * 60000 + 19800000).toISOString().slice(11, 16);
for (let year = 2020; year <= 2035; year++) {
  const days = {};
  for (let cursor = new Date(`${year}-01-01T00:00:00Z`); cursor.getUTCFullYear() === year; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    const midnight = new Date(`${date}T00:00:00+05:30`);
    const rise = SearchRiseSet("Sun", observer, 1, midnight, 1);
    const set = SearchRiseSet("Sun", observer, -1, midnight, 1);
    if (!rise || !set || set.date <= rise.date) throw new Error(`Missing solar events for ${date}`);
    const phase = MoonPhase(rise);
    const tithi = Math.floor(phase / 12);
    const end = SearchMoonPhase(((tithi + 1) * 12) % 360, rise, 2);
    if (!end) throw new Error(`Missing tithi transition for ${date}`);
    const segment = (number) => {
      const duration = (set.date.getTime() - rise.date.getTime()) / 8;
      return [clock(new Date(rise.date.getTime() + (number - 1) * duration)), clock(new Date(rise.date.getTime() + number * duration))];
    };
    const weekday = cursor.getUTCDay();
    days[date] = {
      tithi,
      tithi_end: end.date.toISOString(),
      sunrise: clock(rise.date),
      sunset: clock(set.date),
      timings: {
        rahu_kalam: segment([8, 2, 7, 5, 6, 4, 3][weekday]),
        yamagandam: segment([5, 4, 3, 2, 1, 7, 6][weekday]),
        gulika_kalam: segment([7, 6, 5, 4, 3, 2, 1][weekday]),
        brahma_muhurtham: [clock(new Date(rise.date.getTime() - 96 * 60000)), clock(new Date(rise.date.getTime() - 48 * 60000))],
        nalla_neram: [],
      },
    };
  }
  writeFileSync(new URL(`${year}.json`, directory), JSON.stringify({
    engine: "Astronomy Engine 2.1.19 (MIT)",
    convention: "Geocentric tropical Sun-Moon elongation at local sunrise; apparent upper-limb solar rise/set; daylight divided into eight parts",
    location: config,
    days,
  }) + "\n");
}
console.log(`Generated 2020–2035 offline calendar in ${fileURLToPath(directory)}`);
