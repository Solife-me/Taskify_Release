import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNTIME = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");
const LATEST_EVENT = readFileSync(path.resolve(import.meta.dirname, "../src/shared/latestEvent.ts"), "utf8");

test("task parser preserves deleted status instead of treating it as open", () => {
  assert.match(RUNTIME, /const statusVal = readStatusTag\(event\.tags, "open"\)/);
  assert.match(RUNTIME, /const deleted = statusVal === "deleted"/);
  assert.match(RUNTIME, /deleted,/);
});

test("cache serialization preserves deleted task state", () => {
  assert.match(RUNTIME, /status: r\.deleted \? "deleted" : r\.completed \? "done" : "open"/);
  assert.match(RUNTIME, /deleted: t\.status === "deleted"/);
});

test("listTasks filters deleted tasks from merged and cached outputs", () => {
  const deletedFilterCount = (RUNTIME.match(/if \(rec\.deleted\) continue;/g) ?? []).length + (RUNTIME.match(/if \(record\.deleted\) continue;/g) ?? []).length;
  assert.ok(deletedFilterCount >= 4, `expected multiple deleted-task filters, got ${deletedFilterCount}`);
});

test("task merge ordering uses relay event created_at rather than payload.createdAt", () => {
  assert.match(RUNTIME, /createdAt: event\.created_at \?\?/);
});

test("calendar list/get pick the latest event version by id", () => {
  assert.match(RUNTIME, /const latestById = new Map<string, FullEventRecord>\(\)/);
  assert.match(RUNTIME, /if \(!existing \|\| \(parsed\.createdAt \?\? 0\) >= \(existing\.createdAt \?\? 0\)\)/);
  assert.match(RUNTIME, /pickLatestParsedEvent\(events, \(evt\) => parseDecryptedCalendarEvent/);
});

test("mutation paths use latest relay event selection helpers", () => {
  assert.match(LATEST_EVENT, /export async function pickLatestParsedEvent/);
  assert.match(LATEST_EVENT, /relayEventCreatedAt\(event\) >= relayEventCreatedAt\(latest\.event\)/);
  const latestUsageCount = (RUNTIME.match(/pickLatestParsedEvent\(events/g) ?? []).length;
  assert.ok(latestUsageCount >= 8, `expected mutation/get paths to use latest event helper, got ${latestUsageCount}`);
  assert.doesNotMatch(RUNTIME, /const \[(event|evt)\] = events/);
  assert.match(RUNTIME, /resolveCalendarEventId\(entry\.id, eventId\)/);
});
