import { describe, expect, it } from "vitest";
import { calendarRecurrenceInstanceId, planCalendarRecurrenceWindow, type CalendarWindowInput } from "./calendarRecurrenceWindow";
import type { Board, CalendarEvent } from "../tasks/taskTypes";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const boards = [{ id: "b1", name: "Week", kind: "week" } as Board];
const input: CalendarWindowInput = {
  boards,
  now: NOW,
  settings: { weekStart: 0, newTaskPosition: "bottom" },
  deletedOccurrenceIds: new Set(),
  canGenerateForBoard: () => true,
};

const seed: CalendarEvent = {
  id: "s1",
  boardId: "b1",
  title: "Standup",
  kind: "time",
  startISO: "2026-10-15T14:00:00.000Z",
  endISO: "2026-10-15T14:15:00.000Z",
  startTzid: "America/Chicago",
  recurrence: { type: "daily" },
  seriesId: "s1",
};

describe("planCalendarRecurrenceWindow", () => {
  it("generates the daily window locally and is stable on rerun", () => {
    const next = planCalendarRecurrenceWindow([seed], input)!;
    const generated = next.filter((event) => event.generated);
    expect(generated).toHaveLength(23);
    expect(generated.every((event) => event.seriesId === "s1" && event.title === "Standup")).toBe(true);
    expect(generated[0].id).toBe(calendarRecurrenceInstanceId("s1", "2026-10-16T14:00:00.000Z", { type: "daily" }, "America/Chicago"));
    expect(planCalendarRecurrenceWindow(next, input)).toBeNull();
  });

  it("never trims an edited occurrence beyond the window", () => {
    const farException: CalendarEvent = {
      ...seed,
      id: calendarRecurrenceInstanceId("s1", "2026-11-24T14:00:00.000Z", { type: "daily" }, "America/Chicago"),
      title: "Standup (moved)",
      startISO: "2026-11-24T15:00:00.000Z",
      endISO: "2026-11-24T15:15:00.000Z",
    };
    // The window is already full (seed + 23 generated), so the far exception is the 25th future
    // occurrence: the farthest, which the old trim deleted and tombstoned.
    const full = planCalendarRecurrenceWindow([seed], input)!;
    const after = planCalendarRecurrenceWindow([...full, farException], input) ?? [...full, farException];
    expect(after.some((event) => event.id === farException.id && event.title === "Standup (moved)")).toBe(true);
    expect(after.filter((event) => event.generated)).toHaveLength(23);
  });

  it("drops generated occurrences whose seed is gone", () => {
    const next = planCalendarRecurrenceWindow([seed], input)!;
    const orphans = next.filter((event) => event.id !== "s1");
    expect(planCalendarRecurrenceWindow(orphans, input)).toEqual([]);
  });

  it("skips deleted occurrences and waits for a board that hasn't synced", () => {
    const deletedId = calendarRecurrenceInstanceId("s1", "2026-10-16T14:00:00.000Z", { type: "daily" }, "America/Chicago");
    const next = planCalendarRecurrenceWindow([seed], { ...input, deletedOccurrenceIds: new Set([deletedId]) })!;
    expect(next.some((event) => event.id === deletedId)).toBe(false);
    expect(planCalendarRecurrenceWindow([seed], { ...input, canGenerateForBoard: () => false })).toBeNull();
  });
});
