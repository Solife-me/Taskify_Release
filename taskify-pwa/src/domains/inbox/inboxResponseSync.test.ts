import { describe, expect, it } from "vitest";
import type { Task } from "../tasks/taskTypes";
import {
  applyInboxResponsesToCalendarInvites,
  applyInboxResponsesToTasks,
  collectCalendarInviteResponses,
  collectInboxResponses,
  pendingCalendarInviteEventIds,
  pendingInboxEventIds,
} from "./inboxResponseSync";

const sender = { pubkey: "a".repeat(64) };
const inboxTask = (id: string, dmEventId: string, extra: Partial<Task> = {}, status?: string): Task => ({
  id,
  boardId: "inbox",
  title: "Shared",
  createdAt: 0,
  dueISO: "2026-09-24T00:00:00.000Z",
  completed: false,
  inboxItem: {
    type: "task",
    task: { type: "task", title: "Shared" } as any,
    sender,
    receivedAt: "2026-09-24T00:00:00.000Z",
    dmEventId,
    ...(status ? { status: status as any } : {}),
  },
  ...extra,
} as Task);

describe("inbox response sync", () => {
  it("collects responses made on this device keyed by wrap event id", () => {
    const tasks = [
      inboxTask("t1", "WRAP1", { completed: true, completedAt: "2026-09-24T10:00:00.500Z" }, "accepted"),
      inboxTask("t2", "wrap2", {}, "pending"),
      inboxTask("t3", "wrap3", {}, "read"),
    ];
    expect(collectInboxResponses(tasks)).toEqual({ wrap1: { status: "accepted", at: 1790244000 } });
    expect(pendingInboxEventIds(tasks)).toEqual(["wrap2", "wrap3"]);
  });

  it("answers a pending item that another device dismissed, without re-running its effects", () => {
    const tasks = [inboxTask("t1", "wrap1"), inboxTask("t2", "wrap2")];
    const next = applyInboxResponsesToTasks(tasks, { wrap1: { status: "deleted", at: 1790244000 } });
    expect(next[0].inboxItem?.status).toBe("deleted");
    expect(next[0].completed).toBe(true);
    expect(next[0].completedAt).toBe("2026-09-24T10:00:00.000Z");
    expect(next[0].note).toContain("Action: Dismissed");
    expect(next[1]).toBe(tasks[1]);
    // Re-deriving must reproduce the remote timestamp, or the device would republish it.
    expect(collectInboxResponses(next)).toEqual({ wrap1: { status: "deleted", at: 1790244000 } });
  });

  it("leaves an item already answered here alone and returns the same array when nothing applies", () => {
    const tasks = [inboxTask("t1", "wrap1", { completed: true }, "accepted")];
    expect(applyInboxResponsesToTasks(tasks, { wrap1: { status: "deleted", at: 5 } })).toBe(tasks);
  });
});

describe("calendar invite response sync", () => {
  const invite = (overrides: Record<string, unknown> = {}) => ({
    id: "30310:pk:ev",
    source: "dm",
    eventId: "ev",
    canonical: "30310:pk:ev",
    view: "30311:pk:ev",
    eventKey: "k",
    inviteToken: "t",
    receivedAt: "2026-09-24T00:00:00.000Z",
    status: "pending",
    dmEventIds: ["WRAP-A", "wrap-b"],
    ...overrides,
  }) as any;

  it("reports a response under every wrap id the invite arrived in", () => {
    const answered = invite({ status: "dismissed", respondedAt: "2026-09-24T10:00:00.000Z" });
    expect(collectCalendarInviteResponses([answered, invite({ canonical: "x", dmEventIds: ["wrap-c"] })])).toEqual({
      "wrap-a": { status: "deleted", at: 1790244000 },
      "wrap-b": { status: "deleted", at: 1790244000 },
    });
    expect(pendingCalendarInviteEventIds([invite()])).toEqual(["wrap-a", "wrap-b"]);
  });

  it("applies a response keyed by any of the invite's wrap ids and reports accepted ones", () => {
    const invites = [invite(), invite({ canonical: "other", dmEventIds: ["wrap-z"] })];
    const result = applyInboxResponsesToCalendarInvites(invites, { "wrap-b": { status: "accepted", at: 1790244000 } });
    expect(result.invites[0]).toMatchObject({ status: "accepted", respondedAt: "2026-09-24T10:00:00.000Z" });
    expect(result.invites[1]).toBe(invites[1]);
    expect(result.accepted.map((entry) => entry.status)).toEqual(["accepted"]);
    expect(collectCalendarInviteResponses(result.invites)["wrap-a"]).toEqual({ status: "accepted", at: 1790244000 });
  });

  it("returns the same array when nothing applies and never reopens an answered invite", () => {
    const invites = [invite({ status: "declined", respondedAt: "2026-09-24T09:00:00.000Z" })];
    const result = applyInboxResponsesToCalendarInvites(invites, { "wrap-a": { status: "accepted", at: 1790244000 } });
    expect(result.invites).toBe(invites);
    expect(result.accepted).toEqual([]);
  });
});
