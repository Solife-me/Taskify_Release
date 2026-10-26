import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const RUNTIME = readFileSync(path.resolve(import.meta.dirname, "../src/nostrRuntime.ts"), "utf8");
const LATEST_EVENT = readFileSync(path.resolve(import.meta.dirname, "../src/shared/latestEvent.ts"), "utf8");

test("calendar list/get pick the latest event version by id", () => {
  assert.match(RUNTIME, /const latestById = await pickLatestParsedEventsByKey\(/);
  assert.match(RUNTIME, /pickLatestParsedEvent\(events, \(evt\) => parseDecryptedCalendarEvent/);
});

test("calendar mutation paths use latest relay event selection helpers", () => {
  assert.match(LATEST_EVENT, /export async function pickLatestParsedEvent/);
  assert.match(LATEST_EVENT, /sort\(\(a, b\) => compareReplaceableEvents\(b, a\)\)/);
  assert.doesNotMatch(RUNTIME, /const \[(event|evt)\] = events/);
  assert.match(RUNTIME, /resolveCalendarEventId\(entry\.id, eventId\)/);
});
