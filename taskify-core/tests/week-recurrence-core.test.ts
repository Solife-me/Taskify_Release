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
