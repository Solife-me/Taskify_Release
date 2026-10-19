import { describe, expect, test } from "vitest";
import type { Board, CalendarEvent } from "../tasks/taskTypes";
import { buildEventFromEditor, eventEditorStart, type EventEditorDraft } from "./eventEditorModel";

const CHICAGO = "America/Chicago";
const board = { id: "l", name: "Projects", kind: "lists", columns: [{ id: "c1", name: "Inbox" }] } as unknown as Board;

const timed = {
  id: "e1",
  boardId: "l",
  columnId: "c1",
  kind: "time",
  title: "Standup",
  startISO: "2026-10-20T14:00:30.000Z", // 9:00:30 in Chicago
  endISO: "2026-10-20T14:15:30.000Z",
  startTzid: CHICAGO,
  endTzid: CHICAGO,
} as unknown as Extract<CalendarEvent, { kind: "time" }>;

function draftFor(event: CalendarEvent, changes: Partial<EventEditorDraft> = {}): EventEditorDraft {
  const start = eventEditorStart(event, CHICAGO);
  return {
    title: event.title,
    description: "",
    documents: [],
    image: "",
    locations: [""],
    geohash: "",
    participants: [],
    hashtagsText: "",
    referencesText: "",
    reminders: [],
    reminderTime: start.reminderTime,
    rule: { type: "none" },
    boardId: event.boardId,
    board,
    columnId: event.columnId ?? "",
    allDay: start.allDay,
    startDate: start.startDate,
    endDate: start.endDate,
    startTime: start.startTime,
    endTime: start.endTime,
    startTzid: start.startTzid,
    endTzid: start.endTzid,
    ...changes,
  };
}

describe("event editor model", () => {
  test("starts from the event's dates, times and zones", () => {
    expect(eventEditorStart(timed, "UTC")).toMatchObject({
      allDay: false,
      startDate: "2026-10-20",
      endDate: "2026-10-20",
      startTime: "09:00",
      endTime: "09:15",
      startTzid: CHICAGO,
      endTzid: CHICAGO,
    });
  });

  test("an event without an end lasts an hour", () => {
    const start = eventEditorStart({ ...timed, endISO: undefined } as CalendarEvent, CHICAGO);
    expect(start.endTime).toBe("10:00");
  });

  test("saving untouched times keeps the exact instants", () => {
    const saved = buildEventFromEditor(timed, eventEditorStart(timed, CHICAGO), draftFor(timed), CHICAGO);
    expect(saved).toMatchObject({ kind: "time", startISO: timed.startISO, endISO: timed.endISO, columnId: "c1" });
  });

  test("a changed end time is set in its zone; the start stays", () => {
    const saved = buildEventFromEditor(timed, eventEditorStart(timed, CHICAGO), draftFor(timed, { endTime: "10:00" }), CHICAGO);
    expect(saved.kind === "time" && saved.startISO).toBe(timed.startISO);
    expect(saved.kind === "time" && saved.endISO).toBe("2026-10-20T15:00:00.000Z");
  });

  test("all-day events keep dates and a reminder time", () => {
    const saved = buildEventFromEditor(timed, eventEditorStart(timed, CHICAGO), draftFor(timed, { allDay: true, endDate: "2026-10-21" }), CHICAGO);
    expect(saved).toMatchObject({ kind: "date", startDate: "2026-10-20", reminderTime: "09:00" });
  });

  test("text fields are cleaned: untitled, hashtags, references, locations", () => {
    const saved = buildEventFromEditor(
      timed,
      eventEditorStart(timed, CHICAGO),
      draftFor(timed, { title: "  ", hashtagsText: "#team, ops", referencesText: "https://a.example\n\nhttps://b.example", locations: [" Room 1 ", ""] }),
      CHICAGO,
    );
    expect(saved).toMatchObject({
      title: "Untitled",
      hashtags: ["team", "ops"],
      references: ["https://a.example", "https://b.example"],
      locations: ["Room 1"],
    });
  });

  test("a repeating event gets a series id", () => {
    const saved = buildEventFromEditor(timed, eventEditorStart(timed, CHICAGO), draftFor(timed, { rule: { type: "daily" } }), CHICAGO);
    expect(saved).toMatchObject({ recurrence: { type: "daily" }, seriesId: "e1" });
  });
});
