import { describe, expect, it } from "vitest";
import type { Board, CalendarEvent } from "../tasks/taskTypes";
import {
  findReusableAcceptedInvite,
  planAdvanceCalendarSeriesSeed,
  planAddAcceptedInviteToCalendar,
  planDeleteCalendarEvent,
  planMoveCalendarEvents,
  planSaveCalendarEvent,
  selectAcceptedInviteDestination,
  type AcceptedCalendarInvite,
  type AcceptedInviteContext,
  type SaveCalendarEventContext,
} from "./calendarCommands";

const ACTOR = "a".repeat(64);
const NOW = new Date("2026-10-15T14:00:00.000Z");

function saveContext(overrides: Partial<SaveCalendarEventContext> = {}): SaveCalendarEventContext {
  return {
    now: NOW,
    actorPubkey: ACTOR,
    boards: [{ id: "board-1", name: "Week", kind: "week" }],
    settings: { newTaskPosition: "bottom", weekStart: 0 },
    ...overrides,
  };
}

function invite(overrides: Partial<AcceptedCalendarInvite> = {}): AcceptedCalendarInvite {
  return {
    eventId: "event-1",
    canonical: `31922:${"b".repeat(64)}:event-1`,
    view: `31923:${"b".repeat(64)}:event-1`,
    eventKey: "event-key",
    inviteToken: "invite-token",
    title: "Invited event",
    start: "2026-10-15",
    sender: { pubkey: "c".repeat(64) },
    ...overrides,
  };
}

function inviteContext(overrides: Partial<AcceptedInviteContext> = {}): AcceptedInviteContext {
  return {
    now: NOW,
    boards: [{ id: "board-1", name: "Week", kind: "week" }],
    destinationBoardId: "board-1",
    settings: { newTaskPosition: "bottom", weekStart: 0 },
    status: "accepted",
    viewEventId: "event-1",
    originBoardId: null,
    boardPubkey: "b".repeat(64),
    viewPayload: null,
    ...overrides,
  };
}

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

describe("planSaveCalendarEvent", () => {
  it("adds a normalized event with board order and authorship", () => {
    const existing = event({ id: "existing", order: 4 });
    const draft = event({
      id: "new",
      order: undefined,
      recurrence: { type: "none" },
      seriesId: "old-series",
    });

    const plan = planSaveCalendarEvent([existing], draft, saveContext());

    expect(plan.saved).toMatchObject({
      id: "new",
      order: 5,
      createdBy: ACTOR,
      lastEditedBy: ACTOR,
    });
    expect(plan.saved.recurrence).toBeUndefined();
    expect(plan.saved.seriesId).toBeUndefined();
    expect(plan.events).toEqual([existing, plan.saved]);
    expect(plan.publish).toEqual([plan.saved]);
    expect(plan.publishDeleted).toEqual([]);
    expect(plan.previousParticipants).toEqual([]);
    expect(plan.forceInviteAll).toBe(false);
    expect(plan.publishBoardId).toBe("board-1");
    expect(plan.shouldSendInvites).toBe(false);
  });

  it("turns an edited generated occurrence into a published exception", () => {
    const creator = "b".repeat(64);
    const existing = event({ generated: true, createdBy: creator, order: 2 });
    const updated = { ...existing, title: "Edited", lastEditedBy: undefined };

    const plan = planSaveCalendarEvent([existing], updated, saveContext());

    expect(plan.saved).toMatchObject({
      title: "Edited",
      order: 2,
      createdBy: creator,
      lastEditedBy: ACTOR,
    });
    expect(plan.saved.generated).toBeUndefined();
    expect(plan.publish).toEqual([plan.saved]);
  });

  it("places a moved event at the destination end and resends invites", () => {
    const participants = [{ pubkey: "c".repeat(64) }];
    const existing = event({ participants, originBoardId: "board-1", order: 1 });
    const destination = event({ id: "destination", boardId: "board-2", order: 7 });
    const boards: Board[] = [
      { id: "board-1", name: "One", kind: "week" },
      { id: "board-2", name: "Two", kind: "week" },
    ];

    const plan = planSaveCalendarEvent(
      [existing, destination],
      { ...existing, boardId: "board-2", originBoardId: undefined },
      saveContext({ boards }),
    );

    expect(plan.saved).toMatchObject({ boardId: "board-2", order: 8 });
    expect(plan.previousParticipants).toBe(participants);
    expect(plan.forceInviteAll).toBe(true);
    expect(plan.publishBoardId).toBe("board-2");
    expect(plan.shouldSendInvites).toBe(true);
  });

  it("prunes occurrences past a shortened end and fills the seed window", () => {
    const rule = { type: "daily" as const, untilISO: "2026-10-17T00:00:00.000Z" };
    const seed = event({
      id: "series",
      seriesId: "series",
      startDate: "2026-10-15",
      endDate: "2026-10-16",
      recurrence: rule,
      eventKey: "secret",
      inviteToken: "token",
      inviteTokens: { [ACTOR]: "token" },
    });
    const stale = event({
      id: "stale",
      seriesId: "series",
      startDate: "2026-10-18",
      recurrence: { type: "daily" },
    });

    const plan = planSaveCalendarEvent([seed, stale], seed, saveContext());

    expect(plan.events.map((item) => item.id)).toEqual([
      "series",
      "recurrence_series_2026-10-16",
      "recurrence_series_2026-10-17",
    ]);
    expect(plan.publishDeleted).toEqual([stale]);
    expect(plan.publish.map((item) => item.id)).toEqual(plan.events.map((item) => item.id));
    expect(plan.events[1]).toMatchObject({
      startDate: "2026-10-16",
      endDate: "2026-10-17",
      generated: true,
      eventKey: undefined,
      inviteToken: undefined,
      inviteTokens: undefined,
    });
    expect(plan.events[2]).toMatchObject({
      startDate: "2026-10-17",
      endDate: "2026-10-18",
      generated: true,
    });
  });

  it("does not generate a window from an edited series occurrence", () => {
    const occurrence = event({
      id: "occurrence",
      seriesId: "series",
      recurrence: { type: "daily" },
      generated: true,
    });

    const plan = planSaveCalendarEvent([occurrence], occurrence, saveContext());

    expect(plan.events).toEqual([plan.saved]);
    expect(plan.publish).toEqual([plan.saved]);
    expect(plan.saved.generated).toBeUndefined();
  });
});

describe("accepted calendar invite commands", () => {
  it("chooses the default week board ahead of other visible boards", () => {
    const boards: Board[] = [
      { id: "lists", name: "Lists", kind: "lists", columns: [] },
      { id: "week-other", name: "Other week", kind: "week" },
      { id: "week-default", name: "This week", kind: "week" },
    ];
    expect(selectAcceptedInviteDestination(boards)?.id).toBe("week-default");
  });

  it("reuses an existing copy when its secrets and relay metadata are current", () => {
    const incoming = invite({ relays: ["wss://relay.example"] });
    const existing = event({
      eventKey: incoming.eventKey,
      inviteToken: incoming.inviteToken,
      inviteRelays: incoming.relays,
      viewAddress: incoming.view,
    });
    expect(findReusableAcceptedInvite([existing], incoming)).toBe(existing);
    expect(findReusableAcceptedInvite([existing], { ...incoming, eventKey: "new-key" })).toBeNull();
  });

  it("materializes a decoded external date invite on the first list column", () => {
    const creator = "d".repeat(64);
    const boards: Board[] = [
      { id: "board-1", name: "Lists", kind: "lists", columns: [{ id: "inbox", name: "Inbox" }] },
    ];
    const prior = event({ id: "prior", order: 4 });
    const incoming = invite({ relays: ["wss://relay.example"] });
    const plan = planAddAcceptedInviteToCalendar(
      [prior],
      incoming,
      inviteContext({
        boards,
        viewPayload: {
          v: 1,
          eventId: "event-1",
          kind: "date",
          title: "Decoded title",
          description: "Details",
          startDate: "2026-10-20",
          endDate: "2026-10-21",
          createdBy: creator,
        },
      }),
    );
    if (plan.kind !== "applied") throw new Error(plan.kind);

    expect(plan.events).toHaveLength(2);
    expect(plan.event).toMatchObject({
      id: "event-1",
      boardId: "board-1",
      columnId: "inbox",
      order: 5,
      kind: "date",
      title: "Decoded title",
      description: "Details",
      startDate: "2026-10-20",
      endDate: "2026-10-21",
      createdBy: creator,
      lastEditedBy: creator,
      external: true,
      readOnly: true,
      boardPubkey: "b".repeat(64),
      rsvpStatus: "accepted",
      eventKey: incoming.eventKey,
      inviteToken: incoming.inviteToken,
      inviteRelays: incoming.relays,
    });
  });

  it("materializes an internal timed invite without external read-only flags", () => {
    const plan = planAddAcceptedInviteToCalendar(
      [],
      invite(),
      inviteContext({
        originBoardId: "shared-board",
        boardPubkey: undefined,
        status: "tentative",
        viewPayload: {
          v: 1,
          eventId: "event-1",
          kind: "time",
          startISO: "2026-10-15T14:00:00.000Z",
          endISO: "2026-10-15T15:00:00.000Z",
          startTzid: "America/Chicago",
        },
      }),
    );
    if (plan.kind !== "applied") throw new Error(plan.kind);

    expect(plan.event).toMatchObject({
      kind: "time",
      startISO: "2026-10-15T14:00:00.000Z",
      endISO: "2026-10-15T15:00:00.000Z",
      startTzid: "America/Chicago",
      originBoardId: "shared-board",
    });
    expect(plan.event.external).toBeUndefined();
    expect(plan.event.readOnly).toBeUndefined();
    expect(plan.event.rsvpStatus).toBeUndefined();
  });

  it("refreshes tokens on an existing fallback copy without replacing local fields", () => {
    const incoming = invite({ eventKey: "new-key", inviteToken: "new-token", relays: ["wss://new"] });
    const existing = event({
      viewAddress: incoming.view,
      eventKey: "old-key",
      inviteToken: "old-token",
      reminders: ["0h"],
      reminderTime: "09:00",
      external: true,
      readOnly: true,
      boardPubkey: "b".repeat(64),
    });

    const plan = planAddAcceptedInviteToCalendar([existing], incoming, inviteContext());
    if (plan.kind !== "applied") throw new Error(plan.kind);

    expect(plan.event).toBe(existing);
    expect(plan.events[0]).toMatchObject({
      eventKey: "new-key",
      inviteToken: "new-token",
      inviteRelays: ["wss://new"],
      reminders: ["0h"],
      reminderTime: "09:00",
      readOnly: true,
    });
  });

  it("rejects a view payload for a different event", () => {
    const plan = planAddAcceptedInviteToCalendar(
      [],
      invite(),
      inviteContext({
        viewPayload: {
          v: 1,
          eventId: "different",
          kind: "date",
          startDate: "2026-10-15",
        },
      }),
    );
    expect(plan).toMatchObject({ kind: "invalid", reason: "mismatched-view" });
  });
});
