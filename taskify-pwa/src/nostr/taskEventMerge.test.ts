import { describe, expect, it } from "vitest";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { PINNED_BOUNTY_LIST_KEY } from "../domains/tasks/taskUtils";
import { taskEventBody } from "./boardWire";
import { KNOWN_TASK_PAYLOAD_FIELDS, mergeIncomingBounty, mergeIncomingTask, parseTaskEvent } from "./taskEventMerge";

const lists = { id: "b1", name: "Team", kind: "lists", columns: [{ id: "c1", name: "Todo" }] } as Board;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const OWNER = "a".repeat(64);
const STRANGER = "f".repeat(64);
const ctx = { nostrAt: 200, order: 3, now: NOW.getTime(), eventPubkey: OWNER, incomingIsNewerOnTie: false };

describe("parseTaskEvent", () => {
  it("keeps fields another client wrote and writes them back, so editing here never erases them", () => {
    // As iOS publishes it: reminders and a field from a newer client this one does not know.
    const fromIos = {
      title: "Dentist",
      dueISO: "2026-10-20T14:00:00.000Z",
      reminders: [{ id: "r1", minutesBefore: 30 }],
      reminderTime: "09:00",
      futureField: { x: 1 },
    };
    const read = parseTaskEvent(fromIos, { taskId: "t1", status: "open", column: "c1", createdAt: 200 }, lists, NOW);
    const local = mergeIncomingTask(undefined, read, ctx);
    expect(local.syncExtras).toEqual({ reminders: [{ id: "r1", minutesBefore: 30 }], reminderTime: "09:00", futureField: { x: 1 } });
    expect(local.reminders).toBeUndefined(); // this client's reminders stay per device

    const edited = { ...local, title: "Dentist (moved)" } as Task;
    const republished = taskEventBody(edited, { actorPubkey: OWNER, attachments: { images: null, documents: null } });
    expect(republished).toMatchObject({ title: "Dentist (moved)", reminders: [{ id: "r1", minutesBefore: 30 }], reminderTime: "09:00", futureField: { x: 1 } });

    // The other client removed its reminders: they go here too.
    const later = parseTaskEvent({ title: "Dentist (moved)", dueISO: fromIos.dueISO }, { taskId: "t1", status: "open", column: "c1", createdAt: 300 }, lists, NOW);
    expect(mergeIncomingTask(local, later, { ...ctx, nostrAt: 300 }).syncExtras).toBeUndefined();
  });

  it("every field this client writes is one it reads, so none lands in syncExtras", () => {
    const full = {
      id: "t", boardId: "b1", columnId: "c1", title: "x", note: "n", dueISO: NOW.toISOString(), priority: 1,
      recurrence: { type: "daily" }, seriesId: "s", subtasks: [], assignees: [], streak: 1, longestStreak: 2,
      createdBy: OWNER, createdAt: 1, completedAt: "2026-10-15T00:00:00.000Z", completedBy: OWNER, hiddenUntilISO: NOW.toISOString(),
      dueDateEnabled: true, dueTimeEnabled: true, dueTimeZone: "UTC", scriptureMemoryId: "e", scriptureMemoryStage: 1,
      scriptureMemoryPrevReviewISO: NOW.toISOString(), scriptureMemoryScheduledAt: NOW.toISOString(),
    } as Task;
    const body = taskEventBody(full, { actorPubkey: OWNER, attachments: { images: null, documents: null } });
    expect(Object.keys(body).filter((key) => !KNOWN_TASK_PAYLOAD_FIELDS.has(key))).toEqual([]);
  });

  it("carries a Scripture Memory review's link to its passage, under the field names iOS uses", () => {
    const review = {
      id: "recurrence:scripture-memory:2026-10-19",
      boardId: "b1",
      columnId: "c1",
      title: "Review John 3:16",
      dueISO: "2026-10-19T05:00:00.000Z",
      seriesId: "scripture-memory",
      recurrence: { type: "daily" },
      scriptureMemoryId: "entry-1",
      scriptureMemoryStage: 2,
      scriptureMemoryPrevReviewISO: "2026-10-12T05:00:00.000Z",
      scriptureMemoryScheduledAt: "2026-10-19T11:00:00.000Z",
    } as Task;
    const payload = JSON.parse(JSON.stringify(taskEventBody(review, { actorPubkey: OWNER, attachments: { images: null, documents: null } })));
    expect(payload).toMatchObject({
      scriptureMemoryId: "entry-1",
      scriptureMemoryStage: 2,
      scriptureMemoryPrevReviewISO: "2026-10-12T05:00:00.000Z",
      scriptureMemoryScheduledAt: "2026-10-19T11:00:00.000Z",
    });
    const read = parseTaskEvent(payload, { taskId: review.id, status: "open", column: "c1", createdAt: 200 }, lists, NOW);
    expect(mergeIncomingTask(undefined, read, ctx)).toMatchObject({
      scriptureMemoryId: "entry-1",
      scriptureMemoryStage: 2,
      scriptureMemoryPrevReviewISO: "2026-10-12T05:00:00.000Z",
      scriptureMemoryScheduledAt: "2026-10-19T11:00:00.000Z",
    });
  });

  it("an ordinary task's payload has no Scripture Memory fields", () => {
    const payload = taskEventBody({ id: "t", boardId: "b1", title: "x", dueISO: NOW.toISOString() } as Task, { attachments: { images: null, documents: null } });
    expect(Object.keys(payload).filter((key) => key.startsWith("scripture"))).toEqual([]);
  });

  it("reads back what this client writes", () => {
    const written: Task = {
      id: "t1",
      boardId: "b1",
      columnId: "c1",
      title: "Ship",
      note: "Notes",
      dueISO: "2026-10-16T05:00:00.000Z",
      dueDateEnabled: true,
      dueTimeEnabled: false,
      dueTimeZone: "America/Chicago",
      priority: 2,
      recurrence: { type: "daily" },
      seriesId: "s1",
      streak: 4,
      subtasks: [{ id: "s", title: "Step", completed: true }],
      createdBy: OWNER,
      createdAt: 123,
    } as Task;
    const payload = JSON.parse(JSON.stringify(taskEventBody(written, {
      actorPubkey: OWNER,
      attachments: { images: null, documents: null },
    })));
    const read = parseTaskEvent(payload, { taskId: "t1", status: "open", column: "c1", createdAt: 200 }, lists, NOW);
    expect(mergeIncomingTask(undefined, read, ctx)).toMatchObject({
      id: "t1",
      boardId: "b1",
      columnId: "c1",
      title: "Ship",
      note: "Notes",
      dueISO: "2026-10-16T05:00:00.000Z",
      dueDateEnabled: true,
      dueTimeEnabled: false,
      dueTimeZone: "America/Chicago",
      priority: 2,
      recurrence: { type: "daily" },
      seriesId: "s1",
      streak: 4,
      subtasks: [{ id: "s", title: "Step", completed: true }],
      createdBy: OWNER,
      createdAt: 123,
      completed: false,
      _nostrAt: 200,
      order: 3,
    });
  });

  it("files week-board tasks under day and lists tasks under their list or the first one", () => {
    const week = { id: "w", name: "Week", kind: "week" } as Board;
    expect(parseTaskEvent({}, { taskId: "t", column: "bounties" }, week, NOW).base).toMatchObject({ column: "day", bountyLists: [PINNED_BOUNTY_LIST_KEY] });
    expect(parseTaskEvent({}, { taskId: "t" }, lists, NOW).base.columnId).toBe("c1");
    expect(parseTaskEvent({}, { taskId: "t", status: "done" }, lists, NOW).base).toMatchObject({ completed: true, title: "Untitled" });
  });
});

describe("mergeIncomingTask", () => {
  const local = { id: "t1", boardId: "b1", title: "Old", dueISO: "x", images: ["img"], streak: 2, subtasks: [{ id: "s", title: "A" }], order: 7, createdAt: 50 } as Task;

  it("keeps absent fields, clears null ones and replaces the rest", () => {
    const incoming = parseTaskEvent({ title: "New", images: null, streak: 5 }, { taskId: "t1" }, lists, NOW);
    const merged = mergeIncomingTask(local, incoming, { ...ctx, order: local.order! });
    expect(merged).toMatchObject({ title: "New", streak: 5, subtasks: [{ id: "s", title: "A" }], order: 7, createdAt: 50 });
    expect(merged.images).toBeUndefined();
  });

  it("ignores malformed optional fields", () => {
    const incoming = parseTaskEvent({ images: "not-a-list", streak: "9", subtasks: {} }, { taskId: "t1" }, lists, NOW);
    const merged = mergeIncomingTask(local, incoming, ctx);
    expect(merged).toMatchObject({ images: ["img"], streak: 2, subtasks: [{ id: "s", title: "A" }] });
  });
});

describe("mergeIncomingBounty", () => {
  const bounty = { id: "b", token: "", state: "locked", owner: OWNER, updatedAt: "2026-10-01T00:00:00.000Z" } as NonNullable<Task["bounty"]>;

  it("only lets the owner or sender revoke, and anyone mark it claimed", () => {
    const revoke = { ...bounty, state: "revoked" as const, updatedAt: "2026-10-02T00:00:00.000Z" };
    expect(mergeIncomingBounty(bounty, revoke, { eventPubkey: STRANGER, incomingIsNewerOnTie: false })?.state).toBe("locked");
    expect(mergeIncomingBounty(bounty, revoke, { eventPubkey: OWNER, incomingIsNewerOnTie: false })?.state).toBe("revoked");
    const claim = { ...bounty, state: "claimed" as const };
    expect(mergeIncomingBounty(bounty, claim, { eventPubkey: STRANGER, incomingIsNewerOnTie: false })?.state).toBe("claimed");
  });

  it("clears on null and keeps the local bounty when the incoming one is unreadable", () => {
    expect(mergeIncomingBounty(bounty, null, { eventPubkey: OWNER, incomingIsNewerOnTie: false })).toBeUndefined();
    expect(mergeIncomingBounty(bounty, undefined, { eventPubkey: OWNER, incomingIsNewerOnTie: false })?.id).toBe("b");
  });
});
