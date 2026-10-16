import { describe, expect, it } from "vitest";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { PINNED_BOUNTY_LIST_KEY } from "../domains/tasks/taskUtils";
import { taskEventBody } from "./boardWire";
import { mergeIncomingBounty, mergeIncomingTask, parseTaskEvent } from "./taskEventMerge";

const lists = { id: "b1", name: "Team", kind: "lists", columns: [{ id: "c1", name: "Todo" }] } as Board;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const OWNER = "a".repeat(64);
const STRANGER = "f".repeat(64);
const ctx = { nostrAt: 200, order: 3, now: NOW.getTime(), eventPubkey: OWNER, incomingIsNewerOnTie: false };

describe("parseTaskEvent", () => {
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
