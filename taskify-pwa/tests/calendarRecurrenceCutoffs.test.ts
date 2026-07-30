import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "taskify-core";
import {
  applyCalendarSeriesCutoff,
  updateCalendarSeriesCutoff,
} from "../src/domains/calendar/recurrenceCutoffs";

describe("calendar recurrence cutoffs", () => {
  it("rejects a later stale occurrence after a series tombstone", () => {
    const event: CalendarEvent = {
      id: "recurrence_series_2026-07-30",
      boardId: "week-default",
      title: "Daily event",
      kind: "date",
      startDate: "2026-07-30",
      recurrence: { type: "daily" },
      seriesId: "series",
    };
    const cutoffs = updateCalendarSeriesCutoff(
      {},
      event.boardId,
      event.seriesId!,
      "2026-07-28T00:00:00.000Z",
    );

    expect(applyCalendarSeriesCutoff(event, cutoffs)).toBeNull();
  });

  it("caps an earlier occurrence and never extends an existing cutoff", () => {
    const event: CalendarEvent = {
      id: "series",
      boardId: "week-default",
      title: "Daily event",
      kind: "date",
      startDate: "2026-07-27",
      recurrence: { type: "daily" },
      seriesId: "series",
    };
    const first = updateCalendarSeriesCutoff(
      {},
      event.boardId,
      event.seriesId!,
      "2026-07-28T00:00:00.000Z",
    );
    const later = updateCalendarSeriesCutoff(
      first,
      event.boardId,
      event.seriesId!,
      "2026-08-20T00:00:00.000Z",
    );

    expect(later).toBe(first);
    expect(applyCalendarSeriesCutoff(event, first)?.recurrence?.untilISO)
      .toBe("2026-07-28T00:00:00.000Z");
  });
});
