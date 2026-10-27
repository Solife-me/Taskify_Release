import test from "node:test";
import assert from "node:assert/strict";
import { nextRecurringTaskPayload } from "../src/shared/recurringCompletion.ts";

// The wire payload a client publishes for a task (completion state is the status tag).
const completedDaily = {
  title: "Standup",
  note: "",
  dueISO: "2026-10-15T05:00:00.000Z",
  dueDateEnabled: true,
  dueTimeEnabled: null,
  dueTimeZone: "America/Chicago",
  completedAt: "2026-10-15T14:00:00.000Z",
  completedBy: "abc",
  recurrence: { type: "daily" },
  seriesId: null,
  subtasks: [{ id: "s1", title: "Notes", completed: true }],
  reminders: ["15m"],
  createdBy: "creator",
  lastEditedBy: "abc",
  createdAt: 1,
};

test("completing a recurring task yields the next occurrence with the id PWA and iOS use", () => {
  const next = nextRecurringTaskPayload("task-1", completedDaily, { now: 5_000 });
  assert.ok(next);
  assert.equal(next.taskId, "recurrence:task-1:2026-10-16");
  assert.equal(next.dueISO, "2026-10-16T05:00:00.000Z");
  assert.equal(next.payload.dueISO, "2026-10-16T05:00:00.000Z");
  assert.equal(next.payload.seriesId, "task-1");
  assert.equal(next.payload.completedAt, null);
  assert.equal(next.payload.completedBy, null);
  assert.equal(next.payload.createdAt, 5_000);
  assert.deepEqual(next.payload.subtasks, [{ id: "s1", title: "Notes", completed: false }]);
  assert.deepEqual(next.payload.recurrence, { type: "daily" });
  assert.equal(next.payload.title, "Standup");
  assert.equal(next.payload.createdBy, "creator");
  assert.equal("id" in next.payload, false, "the id travels in the d tag, not the payload");
  assert.equal("completed" in next.payload, false, "completion travels in the status tag");
  assert.ok(typeof next.payload.hiddenUntilISO === "string");
});

test("instances keep their original series id", () => {
  const next = nextRecurringTaskPayload("recurrence:task-1:2026-10-16", {
    ...completedDaily,
    dueISO: "2026-10-16T05:00:00.000Z",
    seriesId: "task-1",
  });
  assert.equal(next?.taskId, "recurrence:task-1:2026-10-17");
});

test("non-recurring and ended series produce nothing", () => {
  assert.equal(nextRecurringTaskPayload("t", { ...completedDaily, recurrence: null }), null);
  assert.equal(nextRecurringTaskPayload("t", { ...completedDaily, recurrence: { type: "none" } }), null);
  assert.equal(
    nextRecurringTaskPayload("t", {
      ...completedDaily,
      recurrence: { type: "daily", untilISO: "2026-10-15T05:00:00.000Z" },
    }),
    null,
  );
  assert.equal(nextRecurringTaskPayload("t", { ...completedDaily, dueISO: "" }), null);
});
