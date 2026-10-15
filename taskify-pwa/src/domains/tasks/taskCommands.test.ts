import { describe, expect, it } from "vitest";
import { SCRIPTURE_MEMORY_SERIES_ID } from "taskify-core";
import {
  planAssignmentResponse,
  planClearCompleted,
  planCompleteTask,
  planDeleteTask,
  planMoveTask,
  planMoveTaskToBoard,
  planMoveTasksToColumn,
  planPostponeTask,
  planRestoreTask,
  planSaveTask,
  planToggleSubtask,
  planUpdateTaskNote,
  type CompleteTaskContext,
} from "./taskCommands";
import type { Task } from "./taskTypes";

const ACTOR = "a".repeat(64);
const NOW = new Date("2026-10-15T14:00:00.000Z");

function ctx(overrides: Partial<CompleteTaskContext> = {}): CompleteTaskContext {
  return {
    now: NOW,
    actorPubkey: ACTOR,
    settings: { streaksEnabled: true, weekStart: 0, newTaskPosition: "bottom" },
    scripture: { state: { entries: [] }, baseDays: 1 },
    ...overrides,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    boardId: "b1",
    title: "Task",
    dueISO: "2026-10-15T05:00:00.000Z",
    dueTimeZone: "America/Chicago",
    order: 0,
    ...overrides,
  } as Task;
}

describe("planCompleteTask", () => {
  it("completes a one-off task and publishes it once", () => {
    const plan = planCompleteTask([task({})], "t1", ctx());
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]).toMatchObject({
      completed: true,
      completedAt: NOW.toISOString(),
      completedBy: ACTOR,
      lastEditedBy: ACTOR,
      seriesId: "t1",
    });
    expect(plan.publish).toEqual([plan.tasks[0]]);
    expect(plan.inboxAction).toBeNull();
    expect(plan.scriptureReview).toBeNull();
  });

  it("leaves the list untouched for an unknown id", () => {
    const tasks = [task({})];
    const plan = planCompleteTask(tasks, "missing", ctx());
    expect(plan.tasks).toBe(tasks);
    expect(plan.publish).toEqual([]);
  });

  it("opens the next occurrence of a daily series with the shared id and a growing streak", () => {
    const plan = planCompleteTask([task({ recurrence: { type: "daily" }, streak: 2 })], "t1", ctx());
    expect(plan.tasks).toHaveLength(2);
    const [done, next] = plan.tasks;
    expect(done.streak).toBe(3);
    expect(next).toMatchObject({
      id: "recurrence:t1:2026-10-16",
      seriesId: "t1",
      dueISO: "2026-10-16T05:00:00.000Z",
      completed: false,
      streak: 3,
      order: 1,
    });
    expect(plan.publish.map((t) => t.id)).toEqual(["t1", "recurrence:t1:2026-10-16"]);
  });

  it("does not add a second copy of an occurrence that already exists", () => {
    const existing = task({ id: "recurrence:t1:2026-10-16", seriesId: "t1", dueISO: "2026-10-16T05:00:00.000Z", recurrence: { type: "daily" } });
    const plan = planCompleteTask([task({ recurrence: { type: "daily" }, seriesId: "t1" }), existing], "t1", ctx());
    expect(plan.tasks).toHaveLength(2);
    expect(plan.publish).toHaveLength(1);
  });

  it("keeps the streak unchanged when streaks are off", () => {
    const plan = planCompleteTask(
      [task({ recurrence: { type: "daily" } })],
      "t1",
      ctx({ settings: { streaksEnabled: false, weekStart: 0, newTaskPosition: "bottom" } }),
    );
    expect(plan.tasks[0].streak).toBe(0);
  });

  it("answers a pending inbox item and notes the action", () => {
    const inboxItem = { type: "board", boardId: "shared", status: "pending" } as unknown as Task["inboxItem"];
    const plan = planCompleteTask([task({ note: "From Bob", inboxItem })], "t1", ctx({ inboxAction: "maybe" }));
    expect(plan.inboxAction?.action).toBe("maybe");
    expect(plan.tasks[0].inboxItem?.status).toBe("tentative");
    expect(plan.tasks[0].note).toBe("From Bob\nAction: Maybe");
  });

  it("turns dismissing an assignment into a decline the sender is told about", () => {
    const inboxItem = {
      type: "task",
      status: "pending",
      task: { type: "task", title: "Review PR", assignment: true, sourceTaskId: "src-1" },
    } as unknown as Task["inboxItem"];
    const plan = planCompleteTask([task({ inboxItem })], "t1", ctx({ inboxAction: "dismiss" }));
    expect(plan.inboxAction?.action).toBe("decline");
    expect(plan.assignmentReply?.status).toBe("declined");
  });

  it("schedules the next Scripture Memory passage after a review", () => {
    const entries = [
      { id: "e1", bookId: "JHN", chapter: 3, startVerse: 16, endVerse: 16, addedAtISO: "2026-09-01T00:00:00.000Z", stage: 1, totalReviews: 1 },
      { id: "e2", bookId: "ROM", chapter: 8, startVerse: 28, endVerse: 28, addedAtISO: "2026-09-02T00:00:00.000Z", stage: 0, totalReviews: 0 },
    ];
    const review = task({
      seriesId: SCRIPTURE_MEMORY_SERIES_ID,
      scriptureMemoryId: "e1",
      scriptureMemoryStage: 1,
      recurrence: { type: "daily" },
    });
    const plan = planCompleteTask([review], "t1", ctx({ scripture: { state: { entries }, baseDays: 1 } }));
    expect(plan.scriptureReview).toMatchObject({ entryId: "e1", completedAt: NOW.toISOString(), stageBefore: 1 });
    expect(plan.scriptureReview?.nextScheduled?.entryId).toBeDefined();
    const next = plan.tasks[1];
    expect(next.scriptureMemoryId).toBe(plan.scriptureReview?.nextScheduled?.entryId);
    expect(next.title).toMatch(/^Review /);
  });
});

describe("planDeleteTask", () => {
  const settings = { showFullWeekRecurring: false, streaksEnabled: true };
  const base = { now: NOW, actorPubkey: ACTOR, settings };

  it("asks which occurrences to delete for a recurring task", () => {
    const t = task({ recurrence: { type: "daily" } });
    expect(planDeleteTask([t], {}, "t1", base)).toEqual({ kind: "ask-scope", task: t });
  });

  it("removes a one-off task, tombstones it and offers undo", () => {
    const t = task({});
    const plan = planDeleteTask([t, task({ id: "t2" })], {}, "t1", base);
    expect(plan.kind).toBe("applied");
    if (plan.kind !== "applied") return;
    expect(plan.tasks.map((x) => x.id)).toEqual(["t2"]);
    expect(plan.publishDeleted).toEqual([t]);
    expect(plan.removed).toBe(t);
  });

  it("archives a bounty to Completed instead of deleting it", () => {
    const bounty = { id: "b", token: "cashuA", state: "locked", updatedAt: NOW.toISOString() } as Task["bounty"];
    const plan = planDeleteTask([task({ bounty })], {}, "t1", base);
    if (plan.kind !== "applied") throw new Error(plan.kind);
    expect(plan.tasks[0]).toMatchObject({ completed: true, bountyDeletedAt: NOW.toISOString() });
    expect(plan.publishDeleted).toEqual([]);
    expect(plan.archivedBounties).toBe(true);
    expect(plan.removed).toBeNull();
  });

  it("ends a series from an occurrence on, records the cutoff and keeps earlier ones", () => {
    const series = { recurrence: { type: "daily" as const }, seriesId: "s1" };
    const earlier = task({ id: "a", dueISO: "2026-10-14T05:00:00.000Z", completed: true, ...series });
    const current = task({ id: "b", dueISO: "2026-10-15T05:00:00.000Z", ...series });
    const later = task({ id: "c", dueISO: "2026-10-16T05:00:00.000Z", ...series });
    const plan = planDeleteTask([earlier, current, later], {}, "b", { ...base, scope: "future", skipPrompt: true });
    if (plan.kind !== "applied") throw new Error(plan.kind);
    expect(plan.tasks.map((x) => x.id)).toEqual(["a"]);
    expect(plan.publishDeleted.map((x) => x.id)).toEqual(["b", "c"]);
    expect(Object.keys(plan.cutoffs).length).toBeGreaterThan(0);
    expect(plan.tasks[0].recurrence?.untilISO).toBeDefined();
  });

  it("restarts the next occurrence's streak in full-week mode", () => {
    const series = { recurrence: { type: "daily" as const }, seriesId: "s1" };
    const plan = planDeleteTask(
      [task({ id: "a", ...series, streak: 4 }), task({ id: "b", dueISO: "2026-10-16T05:00:00.000Z", ...series, streak: 4 })],
      {},
      "a",
      { ...base, skipPrompt: true, settings: { showFullWeekRecurring: true, streaksEnabled: true } },
    );
    if (plan.kind !== "applied") throw new Error(plan.kind);
    expect(plan.tasks[0]).toMatchObject({ id: "b", streak: 0 });
    expect(plan.publish.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("planRestoreTask", () => {
  it("reopens at the bottom of its board and takes back one from the streak", () => {
    const series = { recurrence: { type: "daily" as const }, seriesId: "s1" };
    const done = task({ id: "a", completed: true, completedAt: "x", completedBy: ACTOR, streak: 3, order: 0, ...series });
    const next = task({ id: "b", dueISO: "2026-10-16T05:00:00.000Z", streak: 3, order: 5, ...series });
    const plan = planRestoreTask([done, next], {}, "a", { now: NOW, actorPubkey: ACTOR, settings: { streaksEnabled: true } });
    expect(plan?.tasks[0]).toMatchObject({ completed: false, completedAt: undefined, streak: 2, order: 6 });
    expect(plan?.tasks[1].streak).toBe(2);
    expect(plan?.publish.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("returns null for an unknown id", () => {
    expect(planRestoreTask([], {}, "x", { now: NOW, settings: { streaksEnabled: true } })).toBeNull();
  });
});

describe("planClearCompleted", () => {
  it("removes and tombstones completed tasks in scope only, keeping unclaimed bounties", () => {
    const bounty = { id: "b", token: "cashuA", state: "locked", updatedAt: NOW.toISOString() } as Task["bounty"];
    const tasks = [
      task({ id: "done", completed: true }),
      task({ id: "open" }),
      task({ id: "other", boardId: "b2", completed: true }),
      task({ id: "bounty", completed: true, bounty }),
    ];
    const plan = planClearCompleted(tasks, new Set(["b1"]));
    expect(plan.tasks.map((x) => x.id)).toEqual(["open", "other", "bounty"]);
    expect(plan.publishDeleted.map((x) => x.id)).toEqual(["done"]);
  });

  it("returns the same list when nothing is cleared", () => {
    const tasks = [task({})];
    expect(planClearCompleted(tasks, new Set(["b1"])).tasks).toBe(tasks);
  });
});

describe("planSaveTask", () => {
  const ctx = { now: NOW, actorPubkey: ACTOR, settings: { newTaskPosition: "bottom" as const, streaksEnabled: true } };

  it("adds a new task at the end of its board with authors and a timestamp", () => {
    const plan = planSaveTask([task({ id: "a", order: 3 })], task({ id: "new", order: undefined }), ctx);
    expect(plan.tasks.map((t) => t.id)).toEqual(["a", "new"]);
    expect(plan.saved).toMatchObject({ order: 4, createdBy: ACTOR, lastEditedBy: ACTOR, updatedAt: NOW.toISOString() });
    expect(plan.previousAssignees).toBeNull();
  });

  it("keeps the original author and returns the previous assignees", () => {
    const assignees = [{ pubkey: "b".repeat(64), status: "pending" as const }];
    const before = task({ createdBy: "c".repeat(64), assignees });
    const plan = planSaveTask([before], { ...before, title: "Renamed", createdBy: undefined }, ctx);
    expect(plan.saved).toMatchObject({ title: "Renamed", createdBy: "c".repeat(64), lastEditedBy: ACTOR });
    expect(plan.previousAssignees).toBe(assignees);
  });

  it("keeps the new board's order when a moved series occurrence also restarts its streak", () => {
    const before = task({ recurrence: { type: "daily" }, streak: 5, order: 0 });
    const plan = planSaveTask(
      [before, task({ id: "x", boardId: "b2", order: 7 })],
      { ...before, boardId: "b2", dueISO: "2026-10-20T05:00:00.000Z" },
      ctx,
    );
    expect(plan.saved).toMatchObject({ boardId: "b2", order: 8, streak: 0, seriesId: "t1" });
  });

  it("drops the series id when recurrence is removed", () => {
    const before = task({ recurrence: { type: "daily" }, seriesId: "t1" });
    const plan = planSaveTask([before], { ...before, recurrence: undefined }, ctx);
    expect(plan.saved.seriesId).toBeUndefined();
  });
});

describe("planPostponeTask and planToggleSubtask", () => {
  it("moves the due date a week later and hides the task until then", () => {
    const plan = planPostponeTask([task({ dueISO: "2026-10-15T05:00:00.000Z" })], [{ id: "b1", name: "L", kind: "lists", columns: [] } as never], "t1", {
      now: NOW,
      actorPubkey: ACTOR,
      settings: { weekStart: 0 },
    });
    const due = new Date(plan!.updated.dueISO);
    const original = new Date("2026-10-15T05:00:00.000Z");
    expect(Math.round((due.getTime() - new Date(original.getFullYear(), original.getMonth(), original.getDate()).getTime()) / 86_400_000)).toBe(7);
    expect(plan!.updated.dueDateEnabled).toBe(true);
    expect(plan!.updated.hiddenUntilISO).toBe(plan!.updated.dueISO);
  });

  it("toggles one subtask and records the editor", () => {
    const plan = planToggleSubtask(
      [task({ subtasks: [{ id: "s1", title: "A" }, { id: "s2", title: "B", completed: true }] })],
      "t1",
      "s1",
      { now: NOW, actorPubkey: ACTOR },
    );
    expect(plan!.updated.subtasks).toEqual([{ id: "s1", title: "A", completed: true }, { id: "s2", title: "B", completed: true }]);
    expect(plan!.updated.lastEditedBy).toBe(ACTOR);
    expect(planToggleSubtask([], "x", "s", { now: NOW })).toBeNull();
  });
});

describe("planMoveTask", () => {
  const lists = { id: "b1", name: "Lists", kind: "lists", columns: [{ id: "c1", name: "A" }, { id: "c2", name: "B" }] } as never;
  const sources = new Map([
    ["c1", { boardId: "b1", columnId: "c1" }],
    ["c2", { boardId: "b1", columnId: "c2" }],
    ["x1", { boardId: "b2", columnId: "x1" }],
  ]);
  const ctx = {
    now: NOW,
    actorPubkey: ACTOR,
    settings: { weekStart: 0 as const, streaksEnabled: true },
    currentBoard: lists,
    listColumnSources: sources,
  };

  it("reorders within a list without publishing", () => {
    const tasks = [
      task({ id: "a", columnId: "c1", order: 0 }),
      task({ id: "b", columnId: "c1", order: 1 }),
      task({ id: "c", columnId: "c1", order: 2 }),
    ];
    const plan = planMoveTask(tasks, "c", { type: "list", columnId: "c1" }, "a", ctx)!;
    const order = Object.fromEntries(plan.tasks.map((t) => [t.id, t.order]));
    expect(order).toEqual({ c: 0, a: 1, b: 2 });
    expect(plan.publish).toEqual([]);
    expect(plan.publishDeleted).toEqual([]);
  });

  it("publishes a column change and reopens a completed task", () => {
    const plan = planMoveTask(
      [task({ id: "a", columnId: "c1", completed: true, completedAt: "x", hiddenUntilISO: "y" })],
      "a",
      { type: "list", columnId: "c2" },
      undefined,
      ctx,
    )!;
    expect(plan.tasks[0]).toMatchObject({ columnId: "c2", completed: false, completedAt: undefined, hiddenUntilISO: undefined });
    expect(plan.publish.map((t) => t.id)).toEqual(["a"]);
  });

  it("moving to another board of a compound board deletes the old board's copy", () => {
    const plan = planMoveTask([task({ id: "a", columnId: "c1" })], "a", { type: "list", columnId: "x1" }, undefined, ctx)!;
    expect(plan.tasks[0]).toMatchObject({ boardId: "b2", columnId: "x1", order: 0 });
    expect(plan.publishDeleted.map((t) => t.boardId)).toEqual(["b1"]);
    expect(plan.publish.map((t) => t.boardId)).toEqual(["b2"]);
  });

  it("keeps the time of day when dropped on another weekday", () => {
    const timed = task({ id: "a", dueISO: "2026-10-15T14:30:00.000Z", dueTimeEnabled: true, dueTimeZone: "America/Chicago" });
    const plan = planMoveTask([timed], "a", { type: "day", day: 5 }, undefined, { ...ctx, currentBoard: undefined })!;
    const moved = plan.tasks[0];
    expect(new Date(moved.dueISO).toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit" })).toBe("09:30 AM");
    expect(moved.column).toBe("day");
  });

  it("ignores a drop onto itself and list targets off list boards", () => {
    expect(planMoveTask([task({})], "t1", { type: "list", columnId: "c1" }, "t1", ctx)).toBeNull();
    expect(planMoveTask([task({})], "t1", { type: "list", columnId: "c1" }, undefined, { ...ctx, currentBoard: undefined })).toBeNull();
  });
});

describe("planMoveTaskToBoard", () => {
  const boards = [
    { id: "b1", name: "Week", kind: "week" },
    { id: "b2", name: "Lists", kind: "lists", columns: [{ id: "c1", name: "A" }] },
  ] as never[];

  it("lands at the bottom or top of the target board per the setting", () => {
    const tasks = [task({ id: "a", boardId: "b1", order: 0 }), task({ id: "x", boardId: "b2", columnId: "c1", order: 0 }), task({ id: "y", boardId: "b2", columnId: "c1", order: 1 })];
    const bottom = planMoveTaskToBoard(tasks, boards, "a", "b2", { now: NOW, settings: { newTaskPosition: "bottom" } })!;
    expect(bottom.tasks.find((t) => t.id === "a")).toMatchObject({ boardId: "b2", columnId: "c1", order: 2 });
    const top = planMoveTaskToBoard(tasks, boards, "a", "b2", { now: NOW, settings: { newTaskPosition: "top" } })!;
    expect(top.tasks.find((t) => t.id === "a")?.order).toBe(0);
    expect(top.tasks.find((t) => t.id === "x")?.order).toBe(1);
    expect(top.publishDeleted.map((t) => t.boardId)).toEqual(["b1"]);
  });
});

describe("planMoveTasksToColumn", () => {
  it("moves the selection into one column in order and publishes each once", () => {
    const tasks = [
      task({ id: "a", boardId: "b1", order: 0 }),
      task({ id: "b", boardId: "b1", order: 1 }),
      task({ id: "z", boardId: "b2", columnId: "c1", order: 0 }),
    ];
    const plan = planMoveTasksToColumn(tasks, ["a", "b"], "b2", "c1", { now: NOW, settings: { newTaskPosition: "bottom" } });
    const target = plan.tasks.filter((t) => t.boardId === "b2").sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    expect(target.map((t) => t.id)).toEqual(["z", "a", "b"]);
    expect(plan.publish.map((t) => t.id).sort()).toEqual(["a", "b"]);
    expect(plan.publishDeleted.map((t) => t.id).sort()).toEqual(["a", "b"]);
    const topPlan = planMoveTasksToColumn(tasks, ["a", "b"], "b2", "c1", { now: NOW, settings: { newTaskPosition: "top" } });
    const topOrder = topPlan.tasks.filter((t) => t.boardId === "b2").sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    expect(topOrder.map((t) => t.id)).toEqual(["a", "b", "z"]);
  });
});

describe("planUpdateTaskNote and planAssignmentResponse", () => {
  it("saves a trimmed note with new subtasks, and skips no-op edits", () => {
    const plan = planUpdateTaskNote([task({ note: "old" })], "t1", "  new  ", [{ id: "s", title: "Step" }], { now: NOW, actorPubkey: ACTOR });
    expect(plan!.updated).toMatchObject({ note: "new", subtasks: [{ id: "s", title: "Step" }], lastEditedBy: ACTOR });
    expect(planUpdateTaskNote([task({ note: "same" })], "t1", "same ", [], { now: NOW })).toBeNull();
  });

  it("records an assignee's answer attributed to them, once", () => {
    const responder = "d".repeat(64);
    const t = task({ assignees: [{ pubkey: responder, status: "pending" }] });
    const plan = planAssignmentResponse([t], "t1", responder, "accepted", 1000);
    expect(plan!.updated.assignees?.[0].status).toBe("accepted");
    expect(plan!.updated.lastEditedBy).toBe(responder);
    expect(planAssignmentResponse(plan!.tasks, "t1", responder, "accepted", 1000)).toBeNull();
  });
});
