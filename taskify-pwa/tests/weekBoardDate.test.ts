import { test, expect } from "vitest";
import { isoForWeekdayLocal } from "../src/lib/app/weekBoardDate.ts";

process.env.TZ = "America/Chicago";

type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

function weekdayFromISO(iso: string): Weekday {
  const d = new Date(iso);
  const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() as Weekday;
}

test("DST week: isoForWeekdayLocal round-trips to same weekday (weekStart Sunday)", () => {
  const base = new Date("2026-03-10T12:00:00-05:00"); // week that crosses DST in Chicago
  for (let target = 0 as Weekday; target <= 6; target = (target + 1) as Weekday) {
    const iso = isoForWeekdayLocal(target, { base, weekStart: 0 });
    expect(weekdayFromISO(iso)).toBe(target);
  }
});

test("DST week: isoForWeekdayLocal round-trips to same weekday (weekStart Monday)", () => {
  const base = new Date("2026-03-10T12:00:00-05:00");
  for (let target = 0 as Weekday; target <= 6; target = (target + 1) as Weekday) {
    const iso = isoForWeekdayLocal(target, { base, weekStart: 1 });
    expect(weekdayFromISO(iso)).toBe(target);
  }
});
