import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../tasks/taskTypes";
import {
  planAdvanceCalendarSeriesSeed,
  planDeleteCalendarEvent,
  planMoveCalendarEvents,
} from "./calendarCommands";

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

describe("planDeleteCalendarEvent", () => {
  it("returns no work for an unknown id", () => {
    expect(planDeleteCalendarEvent([event()], "missing")).toEqual({ kind: "none" });
  });

  it("asks for a scope before deleting a recurring event", () => {
    const recurring = event({ recurrence: { type: "daily" } });
    expect(planDeleteCalendarEvent([recurring], recurring.id)).toEqual({
      kind: "ask-scope",
      event: recurring,
    });
  });

  it("deletes one occurrence as a published exception", () => {
    const occurrence = event({
      id: "occurrence",
      seriesId: "series",
      recurrence: { type: "daily" },
      generated: true,
    });
    const plan = planDeleteCalendarEvent([occurrence], occurrence.id, { skipPrompt: true });
    if (plan.kind !== "applied") throw new Error(plan.kind);

    expect(plan.events).toEqual([]);
    expect(plan.deletedOccurrenceIds).toEqual(["occurrence"]);
    expect(plan.publish).toEqual([]);
    expect(plan.publishDeleted).toEqual([{ ...occurrence, generated: undefined }]);
  });

  it("ends a seeded series from the selected occurrence and only republishes its seed", () => {
    const seed = event({
      id: "series",
      seriesId: "series",
      startDate: "2026-10-14",
      recurrence: { type: "daily" },
    });
    const selected = event({
      id: "selected",
      seriesId: "series",
      startDate: "2026-10-15",
      recurrence: { type: "daily" },
      generated: true,
    });
    const publishedLater = event({
      id: "published-later",
      seriesId: "series",
      startDate: "2026-10-16",
      recurrence: { type: "daily" },
    });
    const unrelated = event({ id: "other", boardId: "board-2" });

    const plan = planDeleteCalendarEvent(
      [seed, selected, publishedLater, unrelated],
      selected.id,
      { skipPrompt: true, scope: "future" },
    );
    if (plan.kind !== "applied") throw new Error(plan.kind);
    const expectedUntil = new Date(
      new Date("2026-10-15T00:00:00").getTime() - 86_400_000,
    ).toISOString();

    expect(plan.cutoff).toEqual({
      boardId: "board-1",
      seriesId: "series",
      untilISO: expectedUntil,
    });
    expect(plan.events.map((item) => item.id)).toEqual(["series", "other"]);
    expect(plan.events[0].recurrence?.untilISO).toBe(expectedUntil);
    expect(plan.publish).toEqual([plan.events[0]]);
    expect(plan.publishDeleted).toEqual([
      {
        ...publishedLater,
        recurrence: { type: "daily", untilISO: expectedUntil },
      },
    ]);
    expect(plan.deletedOccurrenceIds).toEqual(["selected", "published-later"]);
  });
});

describe("planAdvanceCalendarSeriesSeed", () => {
  it("moves a multi-day date seed and consumes its generated next occurrence", () => {
    const seed = event({
      id: "series",
      seriesId: "series",
      startDate: "2026-10-15",
      endDate: "2026-10-17",
      recurrence: { type: "daily" },
    });
    const nextId = "recurrence_series_2026-10-16";
    const stood = event({
      id: nextId,
      seriesId: "series",
      startDate: "2026-10-16",
      recurrence: { type: "daily" },
      generated: true,
    });

    const plan = planAdvanceCalendarSeriesSeed([seed, stood], seed);

    expect(plan.events).toHaveLength(1);
    expect(plan.events[0]).toMatchObject({
      id: "series",
      startDate: "2026-10-16",
      endDate: "2026-10-18",
    });
    expect(plan.publish).toEqual([plan.events[0]]);
    expect(plan.publishDeleted).toEqual([]);
    expect(plan.deletedOccurrenceIds).toEqual([nextId]);
  });

  it("preserves a timed duration and tombstones a published next occurrence", () => {
    const seed = event({
      id: "series",
      seriesId: "series",
      kind: "time",
      startDate: undefined,
      startISO: "2026-10-15T14:00:00.000Z",
      endISO: "2026-10-15T15:30:00.000Z",
      startTzid: "UTC",
      recurrence: { type: "daily" },
    } as Partial<CalendarEvent>);
    const nextId = "recurrence_series_2026-10-16";
    const stood = event({
      id: nextId,
      seriesId: "series",
      kind: "time",
      startDate: undefined,
      startISO: "2026-10-16T14:00:00.000Z",
      recurrence: { type: "daily" },
    } as Partial<CalendarEvent>);

    const plan = planAdvanceCalendarSeriesSeed([seed, stood], seed);

    expect(plan.events[0]).toMatchObject({
      startISO: "2026-10-16T14:00:00.000Z",
      endISO: "2026-10-16T15:30:00.000Z",
    });
    expect(plan.publishDeleted).toEqual([stood]);
    expect(plan.deletedOccurrenceIds).toEqual([nextId]);
  });

  it("tombstones a seed with no later occurrence and drops generated children", () => {
    const seed = event({
      id: "series",
      seriesId: "series",
      recurrence: { type: "none" },
    });
    const generated = event({ id: "child", seriesId: "series", generated: true });

    const plan = planAdvanceCalendarSeriesSeed([seed, generated], seed);

    expect(plan.events).toEqual([]);
    expect(plan.publish).toEqual([]);
    expect(plan.publishDeleted).toEqual([seed]);
    expect(plan.deletedOccurrenceIds).toEqual([]);
  });
});
