import { describe, expect, test } from "vitest";
import {
  addCustomReminderSelection,
  reminderSelectionSummary,
  sortReminderSelection,
  toggleReminderSelection,
} from "./reminderSelection";

describe("reminder selection", () => {
  test("timed reminders sort soonest first; all-day ones earliest day first", () => {
    expect(sortReminderSelection(["1h", "5m", "1d"], "timed")).toEqual(["5m", "1h", "1d"]);
    expect(sortReminderSelection(["0d", "1w", "1d"], "date")).toEqual(["1w", "1d", "0d"]);
  });

  test("toggling adds and removes, keeping the order", () => {
    const added = toggleReminderSelection(["1h"], "15m", "timed");
    expect(added).toEqual(["15m", "1h"]);
    expect(toggleReminderSelection(added, "1h", "timed")).toEqual(["15m"]);
  });

  test("one reminder per offset: a custom one replaces a preset at the same time", () => {
    // 60 minutes before is the "1h" preset in timed mode, so nothing is duplicated.
    expect(addCustomReminderSelection(["1h"], 60, "timed")).toEqual(["1h"]);
    const custom = addCustomReminderSelection(["1h"], 90, "timed");
    expect(custom).toHaveLength(2);
    expect(custom[0]).toBe("1h");
  });

  test("summary lists badges, empty for none", () => {
    expect(reminderSelectionSummary([], "timed")).toBe("");
    expect(reminderSelectionSummary(["5m", "1h"], "timed")).toBe("5m, 1h");
    expect(reminderSelectionSummary(["0d"], "date")).toBe("day of");
  });
});
