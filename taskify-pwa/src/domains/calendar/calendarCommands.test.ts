import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../tasks/taskTypes";
import { planMoveCalendarEvents } from "./calendarCommands";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "event-1",
    boardId: "board-1",
    kind: "date",
    startDate: "2026-10-15",
    title: "Event",
    ...overrides,
  } as CalendarEvent;
}

describe("planMoveCalendarEvents", () => {
  it("moves selected events to a board and clears their origin and column", () => {
    const selected = event({ originBoardId: "origin", columnId: "column-1" });
    const untouched = event({ id: "event-2" });

    const plan = planMoveCalendarEvents([selected, untouched], [selected.id], "board-2");

    expect(plan.events[0]).toEqual({
      ...selected,
      boardId: "board-2",
      originBoardId: undefined,
      columnId: undefined,
    });
    expect(plan.events[1]).toBe(untouched);
    expect(plan.publish).toEqual([plan.events[0]]);
    expect(plan.publishDeleted).toEqual([selected]);
  });

  it("moves selected events into a column without deleting from the same board", () => {
    const selected = event({ originBoardId: "origin", columnId: "old-column" });

    const plan = planMoveCalendarEvents([selected], [selected.id], "board-1", "new-column");

    expect(plan.events[0]).toEqual({
      ...selected,
      originBoardId: undefined,
      columnId: "new-column",
    });
    expect(plan.publish).toEqual([plan.events[0]]);
    expect(plan.publishDeleted).toEqual([]);
  });

  it("returns the original list when no ids match", () => {
    const events = [event()];
    const plan = planMoveCalendarEvents(events, ["missing"], "board-2");

    expect(plan.events).toBe(events);
    expect(plan.publish).toEqual([]);
    expect(plan.publishDeleted).toEqual([]);
  });
});
