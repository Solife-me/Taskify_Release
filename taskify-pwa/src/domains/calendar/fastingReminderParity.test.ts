import { describe, expect, it } from "vitest";
import { fastingReminderDueTimesForMonth } from "./holidayUtils";

// Native (FastingReminders.dueDates) must pick the same days for the same seed, or two devices
// with random-mode reminders would keep deleting each other's. FastingReminderParityTests.swift
// pins the same values.
describe("fasting reminder random days", () => {
  const days = (year: number, monthIndex: number, perMonth: number) =>
    fastingReminderDueTimesForMonth(year, monthIndex, { mode: "random", weekday: 1, perMonth, seed: "parity-seed" })
      .map((time) => new Date(time).getDate());

  it("are stable for a given seed and month", () => {
    expect(days(2026, 9, 5)).toEqual([4, 10, 25, 26, 31]);
    expect(days(2027, 1, 3)).toEqual([4, 11, 27]);
  });
});

describe("fasting reminder task ids", () => {
  it("are derived from the local due date, in native's format", async () => {
    const { fastingReminderTaskId } = await import("./holidayUtils");
    expect(fastingReminderTaskId("fasting-reminder", new Date(2026, 9, 4).getTime())).toBe("fasting-reminder:2026-10-04");
  });
});
