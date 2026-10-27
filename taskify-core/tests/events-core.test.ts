import test from "node:test";
import assert from "node:assert/strict";
import { buildCalendarEventDraft } from "../dist/events.js";

test("buildCalendarEventDraft defaults timed events to 09:00 start and 10:00 end when only time mode selected", () => {
  const draft = buildCalendarEventDraft({
    boardId: "board-1",
    title: "Focus block",
    date: "2026-03-15",
    timeZone: "America/Chicago",
    time: "09:00",
  });

  assert.equal(draft.kind, "time");
  assert.equal(typeof draft.startISO, "string");
  assert.equal(draft.startTzid, "America/Chicago");
});

test("buildCalendarEventDraft omits endISO when end is not after start", () => {
  const draft = buildCalendarEventDraft({
    boardId: "board-1",
    title: "Invalid range",
    date: "2026-03-15",
    timeZone: "UTC",
    time: "10:00",
    endTime: "09:00",
  });

  assert.equal(draft.kind, "time");
  assert.equal(draft.endISO, undefined);
});

test("buildCalendarEventDraft keeps date event shape for all-day event", () => {
  const draft = buildCalendarEventDraft({
    boardId: "board-1",
    title: "Conference",
    date: "2026-03-15",
    endDate: "2026-03-17",
  });

  assert.equal(draft.kind, "date");
  assert.equal(draft.startDate, "2026-03-15");
  assert.equal(draft.endDate, "2026-03-17");
});
