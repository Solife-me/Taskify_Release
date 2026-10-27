import test from "node:test";
import assert from "node:assert/strict";
import { startOfWeekLocal, isoForWeekdayLocal } from "../dist/weekDate.js";
import { isoDatePart, todayDateKey } from "../dist/dateTime.js";

test("startOfWeekLocal defaults unsupported weekStart to Sunday", () => {
  const d = new Date("2026-03-12T12:00:00.000Z");
  const sow = startOfWeekLocal(d, 3 as 0);
  assert.equal(sow.getUTCDay(), 0);
});

test("isoForWeekdayLocal returns target weekday in same week", () => {
  const base = new Date("2026-03-12T12:00:00.000Z"); // Thu
  const iso = isoForWeekdayLocal(1, { base, weekStart: 1 }); // Monday
  const d = new Date(iso);
  assert.equal(d.getUTCDay(), 1);
});

test("todayDateKey is the local calendar date, not the UTC one", () => {
  // 20:30 on October 18 in Chicago is already October 19 in UTC.
  const evening = new Date(2026, 9, 18, 20, 30);
  assert.equal(todayDateKey(evening), "2026-10-18");
  assert.equal(todayDateKey(evening), isoDatePart(evening.toISOString()));
});
