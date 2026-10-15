import { describe, expect, it } from "vitest";
import { SCRIPTURE_MEMORY_SERIES_ID } from "taskify-core";
import { planCompleteTask, type CompleteTaskContext } from "./taskCommands";
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
