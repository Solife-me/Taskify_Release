import { describe, expect, it } from "vitest";
import { FASTING_REMINDER_SERIES_ID, SCRIPTURE_MEMORY_SERIES_ID } from "taskify-core";
import { mergeRelayBatchIntoTasks, type RelayBatchEntry, type SyncedTask } from "../../nostr/taskSyncMerge";
import {
  normalizeScriptureReviewTasks,
  planFastingReminders,
  planScriptureReviewTask,
  scriptureReviewPlacement,
  type FastingReminderSettings,
} from "./generatedTasks";
import type { Board, Task } from "./taskTypes";

const NOW = new Date(2026, 9, 15, 10, 0, 0);
const week = { id: "w", name: "Week", kind: "week" } as Board;
const lists = { id: "l", name: "Lists", kind: "lists", columns: [{ id: "c1", name: "A" }] } as Board;

const fasting: FastingReminderSettings = {
  fastingRemindersEnabled: true,
  fastingRemindersMode: "weekday",
  fastingRemindersWeekday: 3,
  fastingRemindersPerMonth: 2,
  fastingRemindersRandomSeed: "seed",
  weekStart: 0,
  newTaskPosition: "bottom",
};

describe("planFastingReminders", () => {
  it("creates this month's and next month's future reminders on the board, then is stable", () => {
    const plan = planFastingReminders([], { targetBoard: lists, now: NOW, settings: fasting })!;
    expect(plan.publish.length).toBeGreaterThan(0);
    for (const reminder of plan.tasks) {
      expect(reminder).toMatchObject({ boardId: "l", columnId: "c1", seriesId: FASTING_REMINDER_SERIES_ID, title: "Fasting" });
      expect(new Date(reminder.dueISO).getTime()).toBeGreaterThanOrEqual(new Date(2026, 9, 15).getTime());
      expect(reminder.id.startsWith(`${FASTING_REMINDER_SERIES_ID}:`)).toBe(true);
    }
    expect(planFastingReminders(plan.tasks, { targetBoard: lists, now: NOW, settings: fasting })).toBeNull();
  });

  it("deletes open reminders everywhere when turned off, keeping completed ones", () => {
    const created = planFastingReminders([], { targetBoard: week, now: NOW, settings: fasting })!.tasks;
    const done = { ...created[0], completed: true };
    const plan = planFastingReminders([done, ...created.slice(1)], {
      targetBoard: week,
      now: NOW,
      settings: { ...fasting, fastingRemindersEnabled: false },
    })!;
    expect(plan.tasks).toEqual([done]);
    expect(plan.publishDeleted).toHaveLength(created.length - 1);
  });

  it("deletes a future reminder no longer wanted and moves the rest to the reminder board", () => {
    const created = planFastingReminders([], { targetBoard: week, now: NOW, settings: fasting })!.tasks;
    const stray = { ...created[0], id: "fasting-reminder:stray", dueISO: new Date(2026, 9, 30).toISOString() } as Task;
    const plan = planFastingReminders([...created, stray], { targetBoard: lists, now: NOW, settings: fasting })!;
    expect(plan.publishDeleted.map((t) => t.id)).toEqual(["fasting-reminder:stray"]);
    expect(plan.tasks.every((t) => t.boardId === "l" && t.columnId === "c1")).toBe(true);
    expect(plan.publish).toHaveLength(created.length);
  });
});

describe("planScriptureReviewTask", () => {
  const entries = [
    { id: "e1", bookId: "JHN", chapter: 3, startVerse: 16, endVerse: 16, addedAtISO: "2026-09-01T00:00:00.000Z", stage: 0, totalReviews: 0 },
  ];
  const input = { targetBoard: lists, entries, baseDays: 1, now: NOW, settings: { weekStart: 0 as const, newTaskPosition: "bottom" as const } };

  it("creates one review task with a date-derived id when none is open", () => {
    const plan = planScriptureReviewTask([], {}, input)!;
    expect(plan.created).toMatchObject({
      boardId: "l",
      columnId: "c1",
      seriesId: SCRIPTURE_MEMORY_SERIES_ID,
      scriptureMemoryId: "e1",
      recurrence: { type: "daily" },
    });
    expect(plan.created!.id.startsWith(`recurrence:${SCRIPTURE_MEMORY_SERIES_ID}:`)).toBe(true);
    expect(plan.scheduledEntryId).toBe("e1");
    expect(planScriptureReviewTask(plan.tasks, {}, input)).toBeNull();
  });

  it("moves existing review tasks to the chosen board without creating another", () => {
    const open = { id: "r", boardId: "w", title: "Review", dueISO: NOW.toISOString(), seriesId: SCRIPTURE_MEMORY_SERIES_ID, recurrence: { type: "daily" } } as Task;
    const plan = planScriptureReviewTask([open], {}, input)!;
    expect(plan.created).toBeNull();
    expect(plan.tasks[0]).toMatchObject({ boardId: "l", columnId: "c1" });
  });

  it("does nothing without passages or on a list board without lists", () => {
    expect(planScriptureReviewTask([], {}, { ...input, entries: [] })).toBeNull();
    expect(planScriptureReviewTask([], {}, { ...input, targetBoard: { ...lists, columns: [] } as Board })).toBeNull();
  });
});

describe("normalizeScriptureReviewTasks", () => {
  const placement = scriptureReviewPlacement(lists, 7)!;
  const review = (fields: Partial<SyncedTask> = {}) =>
    ({ id: "r1", boardId: "w", title: "Review John 3:16", dueISO: NOW.toISOString(), seriesId: SCRIPTURE_MEMORY_SERIES_ID, recurrence: { type: "daily" }, ...fields }) as SyncedTask;

  it("moves open and completed reviews to the board and frequency, leaving other tasks alone", () => {
    const other = { id: "x", boardId: "w", title: "Other", dueISO: NOW.toISOString() } as Task;
    const done = review({ id: "r0", completed: true });
    const result = normalizeScriptureReviewTasks([other, done, review()], placement);
    expect(result[0]).toBe(other);
    for (const task of result.slice(1)) {
      expect(task).toMatchObject({ boardId: "l", columnId: "c1", recurrence: placement.recurrence });
    }
  });

  it("returns the same list when everything already follows the settings", () => {
    const normalized = normalizeScriptureReviewTasks([review()], placement);
    expect(normalizeScriptureReviewTasks(normalized, placement)).toBe(normalized);
  });

  it("keeps one copy per review: a completion outlasts an open copy, then the newer version wins", () => {
    const open = review({ _nostrAt: 300 });
    const completed = review({ boardId: "l", columnId: "c1", completed: true, _nostrAt: 200 });
    expect(normalizeScriptureReviewTasks([open, completed], placement)).toEqual([expect.objectContaining({ completed: true })]);
    const older = review({ title: "Older", _nostrAt: 100 });
    const newer = review({ boardId: "l", title: "Newer", _nostrAt: 200 });
    expect(normalizeScriptureReviewTasks([older, newer], placement).map((t) => t.title)).toEqual(["Newer"]);
  });

  it("has no placement on a Bible board or a lists board without lists", () => {
    expect(scriptureReviewPlacement({ id: "b", name: "Bible", kind: "bible" } as Board, 1)).toBeNull();
    expect(scriptureReviewPlacement({ ...lists, columns: [] } as Board, 1)).toBeNull();
  });
});

describe("Scripture review normalization across two devices", () => {
  // A shared board, so review tasks travel through relays.
  const shared = { id: "s", name: "Shared", kind: "lists", columns: [{ id: "sc", name: "Todo" }] } as Board;
  const entries = [
    { id: "e1", bookId: "JHN", chapter: 3, startVerse: 16, endVerse: 16, addedAtISO: "2026-09-01T00:00:00.000Z", stage: 0, totalReviews: 0 },
  ];
  const settings = { weekStart: 0 as const, newTaskPosition: "bottom" as const };

  /** Each device: its tasks, and what it published. Relays keep the newest copy per board and id. */
  function world() {
    const relay = new Map<string, SyncedTask>();
    const device = () => ({ tasks: [] as SyncedTask[], published: [] as SyncedTask[] });
    const publish = (from: { published: SyncedTask[] }, task: SyncedTask, at: number) => {
      const sent = { ...task, _nostrAt: at };
      from.published.push(sent);
      relay.set(`${task.boardId}::${task.id}`, sent);
    };
    /** A relay sync as App runs it: merge the batch, then the on-read bookkeeping. */
    const resync = (on: { tasks: SyncedTask[] }, board: Board, baseDays: number) => {
      const batch = new Map<string, RelayBatchEntry>(relay);
      const merged = mergeRelayBatchIntoTasks(on.tasks, batch, () => 0);
      on.tasks = normalizeScriptureReviewTasks(merged, scriptureReviewPlacement(board, baseDays)!);
    };
    /** The planner effect, as App runs it when settings change. */
    const plan = (on: { tasks: SyncedTask[]; published: SyncedTask[] }, board: Board, baseDays: number, at: number) => {
      const result = planScriptureReviewTask(on.tasks, {}, { targetBoard: board, entries, baseDays, now: NOW, settings });
      if (!result) return;
      on.tasks = result.tasks as SyncedTask[];
      if (result.created) publish(on, result.created as SyncedTask, at);
    };
    return { relay, a: device(), b: device(), publish, resync, plan };
  }

  it("a board or frequency change is applied on both devices, survives re-syncs, and publishes nothing", () => {
    const w = world();
    // Device A creates the review on the shared board; device B receives it.
    w.plan(w.a, shared, 1, 100);
    expect(w.a.published).toHaveLength(1);
    w.resync(w.b, shared, 1);
    expect(w.b.tasks).toHaveLength(1);

    // The user moves reviews to another board and makes them weekly (settings sync to both).
    w.plan(w.a, lists, 7, 200);
    w.plan(w.b, lists, 7, 200);
    expect(w.a.published).toHaveLength(1); // still only the creation
    expect(w.b.published).toHaveLength(0);
    for (const device of [w.a, w.b]) {
      expect(device.tasks).toEqual([expect.objectContaining({ boardId: "l", columnId: "c1", recurrence: { type: "every", n: 7, unit: "day" } })]);
    }

    // A reload re-delivers the relay copy from before the move: it is normalized, not duplicated.
    w.resync(w.a, lists, 7);
    w.resync(w.b, lists, 7);
    expect(w.a.tasks).toEqual(w.b.tasks);
    expect(w.a.tasks).toHaveLength(1);
    expect(w.a.tasks[0]).toMatchObject({ boardId: "l", recurrence: { type: "every", n: 7, unit: "day" } });
  });

  it("completing the moved review on one device closes it on the other, despite the stale open copy", () => {
    const w = world();
    w.plan(w.a, shared, 1, 100);
    w.resync(w.b, shared, 1);
    w.plan(w.a, lists, 1, 200);
    w.plan(w.b, lists, 1, 200);

    // A completes it: a real change, published on the board it now lives on.
    const completed = { ...w.a.tasks[0], completed: true, completedAt: NOW.toISOString() };
    w.a.tasks = [completed];
    w.publish(w.a, completed, 300);

    // Relays now hold the stale open copy (shared board) and the completion (new board).
    expect(w.relay.size).toBe(2);
    w.resync(w.b, lists, 1);
    expect(w.b.tasks).toEqual([expect.objectContaining({ id: completed.id, completed: true })]);
  });
});
