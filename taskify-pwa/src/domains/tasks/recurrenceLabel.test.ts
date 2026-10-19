import { expect, test } from "vitest";
import { endRepeatLabel, recurrenceLabel } from "./recurrenceLabel";

test("repeat labels use the picker's preset names", () => {
  expect(recurrenceLabel({ type: "none" })).toBe("Never");
  expect(recurrenceLabel(undefined)).toBe("Never");
  expect(recurrenceLabel({ type: "daily" })).toBe("Daily");
  expect(recurrenceLabel({ type: "every", n: 1, unit: "hour" })).toBe("Hourly");
  expect(recurrenceLabel({ type: "every", n: 2, unit: "week" })).toBe("Biweekly");
  expect(recurrenceLabel({ type: "every", n: 3, unit: "day" })).toBe("Every 3 days");
  expect(recurrenceLabel({ type: "every", n: 1, unit: "day" })).toBe("Every day");
  expect(recurrenceLabel({ type: "weekly", days: [5, 1, 2, 3, 4] })).toBe("Weekdays");
  expect(recurrenceLabel({ type: "weekly", days: [6, 0] })).toBe("Weekends");
  expect(recurrenceLabel({ type: "weekly", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day");
  expect(recurrenceLabel({ type: "weekly", days: [2] })).toBe("Weekly on Tue");
  expect(recurrenceLabel({ type: "weekly", days: [3, 1] })).toBe("Mon, Wed");
  expect(recurrenceLabel({ type: "monthlyDay", day: 5 })).toBe("Monthly (day 5)");
  expect(recurrenceLabel({ type: "monthlyDay", day: 5, interval: 3 })).toBe("Every 3 months (day 5)");
  expect(recurrenceLabel({ type: "monthlyDay", day: 5, interval: 12 })).toBe("Yearly (day 5)");
});

test("end repeat label", () => {
  expect(endRepeatLabel({ type: "daily" })).toBe("Never");
  expect(endRepeatLabel({ type: "daily", untilISO: "nope" })).toBe("Custom date");
  expect(endRepeatLabel({ type: "daily", untilISO: "2026-12-31T12:00:00.000Z" }, "UTC")).toMatch(/Dec 31, 2026/);
  // 03:00 UTC on Jan 1 is still Dec 31 in Chicago: the end date is read in the item's zone.
  expect(endRepeatLabel({ type: "daily", untilISO: "2027-01-01T03:00:00.000Z" }, "America/Chicago")).toMatch(/Dec 31, 2026/);
  expect(endRepeatLabel({ type: "daily", untilISO: "2027-01-01T03:00:00.000Z" }, "UTC")).toMatch(/Jan 1, 2027/);
});
