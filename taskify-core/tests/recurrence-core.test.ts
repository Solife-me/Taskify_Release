import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildNextRecurringTask,
  hiddenUntilForNext,
  nextOccurrence,
  recurringInstanceId,
} from "../dist/index.js";

const { vectors } = JSON.parse(
  readFileSync(new URL("../fixtures/recurrence-vectors.json", import.meta.url), "utf8"),
);

// The same file drives TaskifyCoreTests/RecurrenceVectorTests.swift, so both clients agree.
for (const vector of vectors) {
  test(`recurrence vector: ${vector.name}`, () => {
    const next = nextOccurrence(vector.currentISO, vector.rule, vector.dueTimeEnabled, vector.timeZone);
    assert.equal(next, vector.expectedNextISO);
    if (next) {
      assert.equal(recurringInstanceId(vector.seriesId, next, vector.rule, vector.timeZone), vector.expectedInstanceId);
    }
  });
}

test("buildNextRecurringTask opens the next occurrence with the shared id", () => {
  const completed = {
    id: "task-1",
    boardId: "board-1",
    title: "Standup",
    dueISO: "2026-10-15T05:00:00.000Z",
    dueTimeZone: "America/Chicago",
    recurrence: { type: "daily" as const },
    completed: true,
    completedAt: "2026-10-15T14:00:00.000Z",
    completedBy: "abc",
    subtasks: [{ id: "s1", title: "Notes", completed: true }],
    reminders: ["15m" as const],
    order: 4,
  };
  const next = buildNextRecurringTask(completed, { weekStart: 0, now: 1_000 });
  assert.ok(next);
  assert.equal(next.id, "recurrence:task-1:2026-10-16");
  assert.equal(next.seriesId, "task-1");
  assert.equal(next.dueISO, "2026-10-16T05:00:00.000Z");
  assert.equal(next.completed, false);
  assert.equal(next.completedAt, undefined);
  assert.equal(next.completedBy, undefined);
  assert.equal(next.createdAt, 1_000);
  assert.deepEqual(next.subtasks, [{ id: "s1", title: "Notes", completed: false }]);
  assert.deepEqual(next.reminders, ["15m"]);
  assert.notEqual(next.reminders, completed.reminders);
  assert.equal(next.title, "Standup");
  assert.equal(next.order, 4, "board-specific fields are left for the caller");
  assert.equal(next.hiddenUntilISO, hiddenUntilForNext(next.dueISO, completed.recurrence, 0));
  // An existing series id is kept, so later occurrences stay in the same series.
  const later = buildNextRecurringTask(next, { weekStart: 0 });
  assert.equal(later?.id, "recurrence:task-1:2026-10-17");
});

test("buildNextRecurringTask returns null when the series has ended or never recurs", () => {
  const base = { id: "t", dueISO: "2026-10-15T05:00:00.000Z", dueTimeZone: "America/Chicago" };
  assert.equal(buildNextRecurringTask(base, { weekStart: 0 }), null);
  assert.equal(
    buildNextRecurringTask(
      { ...base, recurrence: { type: "daily", untilISO: "2026-10-15T05:00:00.000Z" } },
      { weekStart: 0 },
    ),
    null,
  );
  assert.equal(buildNextRecurringTask({ ...base, dueISO: "", recurrence: { type: "daily" } }, { weekStart: 0 }), null);
});

test("buildNextRecurringTask schedules from an override instant and rule", () => {
  const task = { id: "t", dueISO: "2026-07-01T05:00:00.000Z", dueTimeZone: "America/Chicago", recurrence: { type: "daily" as const } };
  const next = buildNextRecurringTask(task, {
    weekStart: 1,
    scheduledFromISO: "2026-10-15T05:00:00.000Z",
    recurrence: { type: "every", n: 3, unit: "day" },
  });
  assert.equal(next?.dueISO, "2026-10-18T05:00:00.000Z");
  assert.deepEqual(next?.recurrence, { type: "every", n: 3, unit: "day" });
});

test("hiddenUntilForNext reveals frequent series on the due day and others at the start of the week", () => {
  const prevTz = process.env.TZ;
  process.env.TZ = "America/Chicago";
  try {
    // Monday, the week after US clocks went forward on Sunday March 8, 2026.
    const due = "2026-03-09T05:00:00.000Z";
    assert.equal(hiddenUntilForNext(due, { type: "daily" }, 0), "2026-03-09T05:00:00.000Z");
    // Sunday-start week: Sunday March 8 at local midnight (still CST, so 06:00Z), not 23:00 Saturday.
    assert.equal(hiddenUntilForNext(due, { type: "monthlyDay", day: 9 }, 0), "2026-03-08T06:00:00.000Z");
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test("addDaysToDateKey moves by calendar days and rejects invalid keys", async () => {
  const { addDaysToDateKey } = await import("../dist/index.js");
  assert.equal(addDaysToDateKey("2026-03-07", 2), "2026-03-09");
  assert.equal(addDaysToDateKey("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysToDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysToDateKey("not-a-date", 1), null);
});
