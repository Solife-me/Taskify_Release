import test from "node:test";
import assert from "node:assert/strict";
import {
  compareReplaceableEvents,
  pickLatestParsedEventsByKey,
} from "../src/shared/latestEvent.ts";

type FakeTaskEvent = {
  id: string;
  created_at: number;
  taskId: string;
  completed: boolean;
};

test("latest replaceable task state protects a newer reopened task from clear-completed", async () => {
  const staleCompleted: FakeTaskEvent = {
    id: "f".repeat(64),
    created_at: 100,
    taskId: "task-1",
    completed: true,
  };
  const reopened: FakeTaskEvent = {
    id: "e".repeat(64),
    created_at: 200,
    taskId: "task-1",
    completed: false,
  };

  // Relays may return duplicate and out-of-order revisions.
  const latest = await pickLatestParsedEventsByKey(
    [reopened, staleCompleted, { ...staleCompleted }],
    (event) => event.taskId,
    async (event) => ({ completed: event.completed }),
  );

  assert.equal(latest.size, 1);
  assert.equal(latest.get("task-1")?.event.id, reopened.id);
  assert.equal(latest.get("task-1")?.parsed.completed, false);
});

test("equal-timestamp replaceable events use the lower event id deterministically", () => {
  const lower = { id: "a".repeat(64), created_at: 100 };
  const higher = { id: "b".repeat(64), created_at: 100 };
  assert.ok(compareReplaceableEvents(lower, higher) > 0);
  assert.ok(compareReplaceableEvents(higher, lower) < 0);
});

test("latest-per-key parsing avoids decrypting stale valid revisions", async () => {
  const events: FakeTaskEvent[] = [
    { id: "a".repeat(64), created_at: 100, taskId: "task-1", completed: true },
    { id: "b".repeat(64), created_at: 200, taskId: "task-1", completed: false },
  ];
  let parseCount = 0;
  const latest = await pickLatestParsedEventsByKey(
    events,
    (event) => event.taskId,
    async (event) => {
      parseCount += 1;
      return { completed: event.completed };
    },
  );
  assert.equal(latest.get("task-1")?.event.created_at, 200);
  assert.equal(parseCount, 1);
});
