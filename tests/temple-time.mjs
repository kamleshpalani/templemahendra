import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  POOJA_SCHEDULE,
  getDailySchedule,
  getISTNow,
  getNextPooja,
  isTempleOpen,
  to12h,
} from "../frontend/src/lib/templeTime.js";

const wallClock = (h, m, s = 0) => new Date(2026, 9, 5, h, m, s);

test("the daily table contains all six bilingual start times without mutating the source", () => {
  const before = structuredClone(POOJA_SCHEDULE);
  const rows = getDailySchedule(wallClock(5, 0));
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((row) => row.time), ["06:00", "08:00", "12:00", "16:30", "18:30", "20:30"]);
  assert.deepEqual(rows.map((row) => to12h(row.time)), ["6:00 AM", "8:00 AM", "12:00 PM", "4:30 PM", "6:30 PM", "8:30 PM"]);
  assert.ok(rows.every((row) => row.ta && row.en));
  assert.deepEqual(POOJA_SCHEDULE, before);
});

for (const [h, m, nextIndex] of [[0, 0, 0], [5, 59, 0], [6, 0, 1], [8, 0, 2], [12, 0, 3], [16, 29, 3], [16, 30, 4], [18, 30, 5], [20, 29, 5]]) {
  test(`at ${h}:${m} IST the table and next-pooja clock agree`, () => {
    const now = wallClock(h, m, 30);
    const rows = getDailySchedule(now);
    assert.equal(rows.filter((row) => row.status === "next").length, 1);
    assert.equal(rows[nextIndex].status, "next");
    assert.equal(rows[nextIndex].en, getNextPooja(now).pooja.en);
    assert.ok(rows.slice(0, nextIndex).every((row) => row.status === "earlier"));
    assert.ok(rows.slice(nextIndex + 1).every((row) => row.status === "upcoming"));
  });
}

for (const [h, m] of [[20, 30], [21, 0], [23, 59]]) {
  test(`at ${h}:${m} IST no row in today's table highlights tomorrow's pooja`, () => {
    const now = wallClock(h, m);
    assert.ok(getDailySchedule(now).every((row) => row.status === "earlier"));
    assert.equal(getNextPooja(now).pooja.en, POOJA_SCHEDULE[0].en);
    assert.ok(getNextPooja(now).diffSec > 0);
  });
}

test("IST date rolls over at 18:30 UTC, regardless of the browser/server timezone", () => {
  for (const [instant, day, h, m] of [
    ["2026-10-04T18:29:59Z", 4, 23, 59],
    ["2026-10-04T18:30:00Z", 5, 0, 0],
    ["2026-12-31T18:30:00Z", 1, 0, 0],
  ]) {
    const now = getISTNow(new Date(instant));
    assert.equal(now.getDate(), day);
    assert.equal(now.getHours(), h);
    assert.equal(now.getMinutes(), m);
  }
});

test("temple opening-hour boundaries remain unchanged", () => {
  for (const [h, m, open] of [[5, 59, false], [6, 0, true], [12, 29, true], [12, 30, false], [15, 59, false], [16, 0, true], [20, 59, true], [21, 0, false]]) {
    assert.equal(isTempleOpen(wallClock(h, m)), open, `${h}:${m}`);
  }
});

test("frontend regular pooja timings and bilingual names match the PHP pulse schedule", () => {
  const php = readFileSync(new URL("../backend/api/pulse.php", import.meta.url), "utf8");
  const schedule = php.match(/\$schedule = \[([\s\S]*?)\n\];/)[1];
  const rows = [...schedule.matchAll(/'name_ta'\s*=>\s*'([^']+)'\s*,\s*'name_en'\s*=>\s*'([^']+)'\s*,\s*'h'\s*=>\s*(\d+)\s*,\s*'m'\s*=>\s*(\d+)/g)]
    .map(([, ta, en, h, m]) => ({ ta, en, h: Number(h), m: Number(m) }));
  assert.deepEqual(rows, POOJA_SCHEDULE);
});
