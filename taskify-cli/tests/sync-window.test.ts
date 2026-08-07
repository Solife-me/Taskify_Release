import test from "node:test";
import assert from "node:assert/strict";
import { incrementalSyncSince, type BoardCache } from "../src/taskCache.ts";

const cache: BoardCache = {
  fetchedAt: Date.now(),
  lastSyncAt: 10_000,
  tasks: [{ id: "task-1", title: "Task", boardId: "board-1", status: "open" }],
};

test("incremental sync uses a clock-skew lookback only with a complete cache base", () => {
  assert.equal(incrementalSyncSince(cache), 9_700);
  assert.equal(incrementalSyncSince({ ...cache, tasks: [] }), undefined);
  assert.equal(incrementalSyncSince({ ...cache, lastSyncAt: undefined }), undefined);
});

test("cold, refresh, and no-cache syncs never reuse a stale cursor", () => {
  assert.equal(incrementalSyncSince(undefined), undefined);
  assert.equal(incrementalSyncSince(cache, { refresh: true }), undefined);
  assert.equal(incrementalSyncSince(cache, { noCache: true }), undefined);
});
