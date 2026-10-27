import { describe, expect, it } from "vitest";
import { parseCalendarCanonicalPayload } from "taskify-core";
import type { Board, CalendarEvent } from "../domains/tasks/taskTypes";
import { calendarEventPayload } from "./calendarWire";
import { mergeIncomingCalendarEvent, parseCalendarEvent, type CanonicalCalendarPayload, upsertIncomingCalendarEvent } from "./calendarEventMerge";

const lists = { id: "b1", name: "Team", kind: "lists", columns: [{ id: "c1", name: "Todo" }] } as Board;
const OWNER = "a".repeat(64);
const addresses = { canonicalAddress: "30310:pk:e1", viewAddress: "30311:pk:e1" };

const written: CalendarEvent = {
  id: "e1",
  boardId: "b1",
  title: "Offsite",
  kind: "time",
  startISO: "2026-10-20T15:00:00.000Z",
  endISO: "2026-10-20T17:00:00.000Z",
  startTzid: "America/Chicago",
  description: "Agenda",
  eventKey: "k1",
  participants: [{ pubkey: "c".repeat(64) }],
  inviteTokens: { ["c".repeat(64)]: "tok" },
  createdBy: OWNER,
} as CalendarEvent;

function roundTrip(event: CalendarEvent) {
  const payload = parseCalendarCanonicalPayload(JSON.parse(JSON.stringify(calendarEventPayload(event, { audience: "board", actorPubkey: OWNER }))));
  return parseCalendarEvent(payload!, { eventId: event.id, column: "c1", order: "4", ...addresses }, lists);
}

describe("calendar event reading", () => {
  it("reads back the board copy this client writes", () => {
    expect(roundTrip(written)).toMatchObject({
      id: "e1",
      boardId: "b1",
      columnId: "c1",
      order: 4,
      title: "Offsite",
      kind: "time",
      startISO: "2026-10-20T15:00:00.000Z",
      endISO: "2026-10-20T17:00:00.000Z",
      startTzid: "America/Chicago",
      description: "Agenda",
      eventKey: "k1",
      participants: [{ pubkey: "c".repeat(64) }],
      inviteTokens: { ["c".repeat(64)]: "tok" },
      createdBy: OWNER,
      ...addresses,
    });
  });

  it("rejects invalid dates and drops an end before the start", () => {
    const payload = (fields: Record<string, unknown>) => ({ v: 1, eventId: "e1", title: "x", ...fields }) as unknown as CanonicalCalendarPayload;
    const date = parseCalendarEvent(payload({ kind: "date", startDate: "2026-10-20", endDate: "2026-10-01" }), { eventId: "e1", ...addresses }, lists);
    expect(date).toMatchObject({ kind: "date", startDate: "2026-10-20" });
    expect(date).not.toHaveProperty("endDate");
    expect(parseCalendarEvent(payload({ kind: "date", startDate: "20 Oct" }), { eventId: "e1", ...addresses }, lists)).toBeNull();
    const timed = parseCalendarEvent(payload({ kind: "time", startISO: "2026-10-20T15:00:00.000Z", endISO: "2026-10-20T14:00:00.000Z" }), { eventId: "e1", ...addresses }, lists);
    expect(timed).not.toHaveProperty("endISO");
    expect(parseCalendarEvent(payload({ kind: "time", startISO: "soon" }), { eventId: "e1", ...addresses }, lists)).toBeNull();
  });

  it("keeps device-local fields and local order when the incoming version has none", () => {
    const local = { ...written, reminders: ["15m"], hiddenUntilISO: "h", order: 9 } as CalendarEvent;
    const incoming = { ...roundTrip(written)!, order: undefined } as CalendarEvent;
    expect(mergeIncomingCalendarEvent(local, incoming, { weekStart: 0, boardKind: "lists" })).toMatchObject({
      reminders: ["15m"],
      hiddenUntilISO: "h",
      order: 9,
    });
  });
});

describe("upsertIncomingCalendarEvent", () => {
  const timed = (fields: Record<string, unknown> = {}) =>
    ({
      id: "e1",
      boardId: "b1",
      kind: "time",
      title: "Standup",
      startISO: "2026-10-20T14:00:00.000Z",
      endISO: "2026-10-20T14:15:00.000Z",
      ...fields,
    }) as unknown as CalendarEvent;
  const context = { weekStart: 0 as const, boardKind: "lists" as const };

  it("adds an event new to this device and replaces a known one", () => {
    const added = upsertIncomingCalendarEvent([], timed(), {}, context);
    expect(added.map((event) => event.id)).toEqual(["e1"]);
    const replaced = upsertIncomingCalendarEvent(added, timed({ title: "Renamed" }), {}, context);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].title).toBe("Renamed");
  });

  it("an occurrence after the series was ended here is removed, not re-added", () => {
    const occurrence = timed({ id: "e2", seriesId: "s1", recurrence: { type: "daily" }, startISO: "2026-10-25T14:00:00.000Z" });
    const cutoffs = { b1: { s1: "2026-10-21T00:00:00.000Z" } };
    const events = [occurrence];
    expect(upsertIncomingCalendarEvent(events, occurrence, cutoffs, context)).toEqual([]);
    const none: CalendarEvent[] = [];
    expect(upsertIncomingCalendarEvent(none, occurrence, cutoffs, context)).toBe(none);
  });
});
