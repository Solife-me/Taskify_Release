import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureWeekRecurrencesForCurrentWeek,
  recurringSeriesId,
  tasksInSameSeries,
  type SeriesTaskLike,
} from "../dist/weekRecurrence.js";

test("tasksInSameSeries matches by seriesId", () => {
  const a = { id: "1", boardId: "b", title: "t", dueISO: "2026-03-12T00:00:00.000Z", seriesId: "s1" } as SeriesTaskLike;
  const b = { ...a, id: "2", seriesId: "s1" };
  assert.equal(tasksInSameSeries(a, b), true);
});

test("tasksInSameSeries treats untilISO as series end metadata", () => {
  const a = {
    id: "1",
    boardId: "b",
    title: "t",
    note: "",
    dueISO: "2026-03-12T00:00:00.000Z",
    recurrence: { type: "daily", untilISO: "2026-03-12T00:00:00.000Z" },
  } as SeriesTaskLike;
  const b = {
    ...a,
    id: "2",
    dueISO: "2026-03-13T00:00:00.000Z",
    recurrence: { type: "daily" },
  } as SeriesTaskLike;

  assert.equal(tasksInSameSeries(a, b), true);
});

test("tasksInSameSeries matches generated instance to seed id", () => {
  const seed = {
    id: "seed",
    boardId: "b",
    title: "t",
    dueISO: "2026-03-12T00:00:00.000Z",
    recurrence: { type: "daily" },
  } as SeriesTaskLike;
  const instance = {
    ...seed,
    id: "recurrence:seed:2026-03-13",
    seriesId: "seed",
    dueISO: "2026-03-13T00:00:00.000Z",
  } as SeriesTaskLike;

  assert.equal(tasksInSameSeries(seed, instance), true);
});

test("recurringSeriesId recovers a legacy generated instance without seriesId", () => {
  assert.equal(
    recurringSeriesId({
      id: "recurrence:seed-task:2026-03-13",
      boardId: "b",
      title: "Renamed occurrence",
      dueISO: "2026-03-13T00:00:00.000Z",
    }),
    "seed-task",
  );
});

test("recurringSeriesId repairs a legacy generated id stored as seriesId", () => {
  assert.equal(
    recurringSeriesId({
      id: "recurrence:recurrence:seed-task:2026-03-13:2026-03-14",
      seriesId: "recurrence:seed-task:2026-03-13",
      boardId: "b",
      title: "Legacy chain",
      dueISO: "2026-03-14T00:00:00.000Z",
    }),
    "seed-task",
  );
});

test("tasksInSameSeries uses the generated instance id even when occurrence details changed", () => {
  const seed = {
    id: "seed-task",
    boardId: "b",
    title: "Original title",
    note: undefined,
    dueISO: "2026-03-12T00:00:00.000Z",
    recurrence: { type: "daily" },
  } as SeriesTaskLike;
  const legacyInstance = {
    ...seed,
    id: "recurrence:seed-task:2026-03-13",
    title: "Edited title",
    note: "",
    dueISO: "2026-03-13T00:00:00.000Z",
  } as SeriesTaskLike;

  assert.equal(tasksInSameSeries(seed, legacyInstance), true);
});

test("ensureWeekRecurrencesForCurrentWeek creates clone for current week", () => {
  const task = {
    id: "t1",
    boardId: "b1",
    title: "Recurring",
    dueISO: "2026-03-05T00:00:00.000Z",
    recurrence: { type: "weekly" },
  } as SeriesTaskLike;

  const out = ensureWeekRecurrencesForCurrentWeek({
    tasks: [task],
    weekStart: 0,
    newTaskPosition: "bottom",
    dedupeRecurringInstances: (tasks) => tasks,
    isFrequentRecurrence: () => true,
    nextOccurrence: (dueISO) => (dueISO.startsWith("2026-03-05") ? "2026-03-12T00:00:00.000Z" : null),
    startOfWeek: () => new Date("2026-03-08T00:00:00.000Z"),
    recurringInstanceId: (seriesId, dueISO) => `${seriesId}:${dueISO}`,
    isoDatePart: (iso) => iso.slice(0, 10),
    taskDateKey: (t) => t.dueISO.slice(0, 10),
    nextOrderForBoard: () => 10,
    maybePublishTask: () => {},
    now: () => 123,
  });

  assert.equal(out.length, 2);
  assert.equal(out[1].seriesId, "t1");
  assert.equal(out[1].createdAt, 123);
});

test("ensureWeekRecurrencesForCurrentWeek never recreates an occurrence deleted on the board", () => {
  const task = {
    id: "t1",
    boardId: "b1",
    title: "Recurring",
    dueISO: "2026-03-05T00:00:00.000Z",
    recurrence: { type: "weekly" },
  } as SeriesTaskLike;
  const published: string[] = [];
  const options = {
    weekStart: 0,
    newTaskPosition: "bottom" as const,
    dedupeRecurringInstances: (tasks: SeriesTaskLike[]) => tasks,
    isFrequentRecurrence: () => true,
    nextOccurrence: (dueISO: string) => (dueISO.startsWith("2026-03-05") ? "2026-03-12T00:00:00.000Z" : null),
    startOfWeek: () => new Date("2026-03-08T00:00:00.000Z"),
    recurringInstanceId: (seriesId: string, dueISO: string) => `${seriesId}:${dueISO}`,
    isoDatePart: (iso: string) => iso.slice(0, 10),
    taskDateKey: (t: SeriesTaskLike) => t.dueISO.slice(0, 10),
    nextOrderForBoard: () => 10,
    maybePublishTask: (clone: SeriesTaskLike) => { published.push(clone.id); },
  };

  // The deleted occurrence is no longer in the list; only the board's deletion record knows it.
  const deleted = ensureWeekRecurrencesForCurrentWeek({
    ...options,
    tasks: [task],
    isDeletedOccurrence: (boardId, taskId) => boardId === "b1" && taskId === "t1:2026-03-12T00:00:00.000Z",
  });
  assert.equal(deleted.length, 1);
  assert.deepEqual(published, []);

  const kept = ensureWeekRecurrencesForCurrentWeek({ ...options, tasks: [task] });
  assert.equal(kept.length, 2, "Without a deletion the occurrence is created as before");
});

test("ensureWeekRecurrencesForCurrentWeek stops when recurrence does not advance", () => {
  const task = {
    id: "t1",
    boardId: "b1",
    title: "Broken recurrence",
    dueISO: "2026-03-05T00:00:00.000Z",
    recurrence: { type: "every", n: 0, unit: "day" },
  } as SeriesTaskLike;
  let calls = 0;

  const out = ensureWeekRecurrencesForCurrentWeek({
    tasks: [task],
    weekStart: 0,
    newTaskPosition: "bottom",
    dedupeRecurringInstances: (tasks) => tasks,
    isFrequentRecurrence: () => true,
    nextOccurrence: (dueISO) => {
      calls += 1;
      return dueISO;
    },
    startOfWeek: () => new Date("2026-03-08T00:00:00.000Z"),
    recurringInstanceId: (seriesId, dueISO) => `${seriesId}:${dueISO}`,
    isoDatePart: (iso) => iso.slice(0, 10),
    taskDateKey: (t) => t.dueISO.slice(0, 10),
    nextOrderForBoard: () => 10,
    maybePublishTask: () => {},
  });

  assert.equal(out.length, 1);
  assert.equal(calls, 1);
});

test("ensureWeekRecurrencesForCurrentWeek waits for a board that hasn't synced yet", () => {
  // Generating before the relays deliver the week's instances would republish a clone another
  // device already completed, with the same id and a newer timestamp, reopening it.
  const task = {
    id: "t1",
    boardId: "b1",
    title: "Recurring",
    dueISO: "2026-03-05T00:00:00.000Z",
    recurrence: { type: "weekly" },
  } as SeriesTaskLike;
  const published: string[] = [];
  const options = {
    tasks: [task],
    weekStart: 0,
    newTaskPosition: "bottom" as const,
    dedupeRecurringInstances: (tasks: SeriesTaskLike[]) => tasks,
    isFrequentRecurrence: () => true,
    nextOccurrence: (dueISO: string) => (dueISO.startsWith("2026-03-05") ? "2026-03-12T00:00:00.000Z" : null),
    startOfWeek: () => new Date("2026-03-08T00:00:00.000Z"),
    recurringInstanceId: (seriesId: string, dueISO: string) => `${seriesId}:${dueISO}`,
    isoDatePart: (iso: string) => iso.slice(0, 10),
    taskDateKey: (t: SeriesTaskLike) => t.dueISO.slice(0, 10),
    nextOrderForBoard: () => 10,
    maybePublishTask: (t: SeriesTaskLike) => { published.push(t.id); },
    now: () => 123,
  };
  const waiting = ensureWeekRecurrencesForCurrentWeek({ ...options, canGenerateForBoard: () => false });
  assert.equal(waiting.length, 1);
  assert.deepEqual(published, []);
  const ready = ensureWeekRecurrencesForCurrentWeek({ ...options, canGenerateForBoard: (id: string) => id === "b1" });
  assert.equal(ready.length, 2);
  assert.equal(published.length, 1);
});

test("runningSeriesStreak reads an open instance's streak from the latest completed earlier one", async () => {
  const { buildRunningStreakLookup } = await import("../dist/weekRecurrence.js");
  const tasks = [
    { id: "mon", seriesId: "s", dueISO: "2026-03-09T00:00:00.000Z", completed: true, streak: 5 },
    { id: "sun", seriesId: "s", dueISO: "2026-03-08T00:00:00.000Z", completed: true, streak: 4 },
    // Pre-generated for the week with the streak the series had then.
    { id: "tue", seriesId: "s", dueISO: "2026-03-10T00:00:00.000Z", completed: false, streak: 2 },
    { id: "other", seriesId: "x", dueISO: "2026-03-10T00:00:00.000Z", completed: false, streak: 1 },
  ] as any[];
  const running = buildRunningStreakLookup(tasks);
  assert.equal(running(tasks[2]), 5);
  assert.equal(running(tasks[0]), 5, "a completed instance keeps its own streak");
  assert.equal(running(tasks[3]), 1);
  // An instance earlier than every completion only has its own.
  assert.equal(running({ id: "sat", seriesId: "s", dueISO: "2026-03-07T00:00:00.000Z", completed: false, streak: 0 } as any), 0);
});
