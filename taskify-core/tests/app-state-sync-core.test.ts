import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeBibleTrackerStates,
  mergeChatSyncStates,
  mergeScriptureMemoryStates,
  mergeSetThreeWay,
  pruneChatSyncState,
  sanitizeChatSyncState,
  chatSyncStatesEqual,
} from "../dist/appStateSync.js";

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  bookId: "jhn",
  chapter: 3,
  startVerse: 16,
  endVerse: 16,
  addedAtISO: "2026-09-01T00:00:00.000Z",
  stage: 0,
  totalReviews: 0,
  ...overrides,
});

const tracker = (overrides: Record<string, unknown> = {}) => ({
  lastResetISO: "2026-01-01T00:00:00.000Z",
  progress: {},
  verses: {},
  verseCounts: {},
  completedBooks: {},
  archive: [],
  ...overrides,
});

test("mergeSetThreeWay keeps additions from both sides and honors removals", () => {
  assert.deepEqual(mergeSetThreeWay([1, 2, 3], [1, 2, 4], [2, 3, 5]), [2, 4, 5]);
  assert.deepEqual(mergeSetThreeWay(undefined, [1], [2]), [1, 2]);
});

test("scripture merge keeps passages added on each device", () => {
  const base = { entries: [entry("a")] };
  const local = { entries: [entry("a"), entry("b")] };
  const remote = { entries: [entry("a"), entry("c")] };
  const merged = mergeScriptureMemoryStates(base, local, remote);
  assert.deepEqual(merged.entries.map((e) => e.id), ["a", "b", "c"]);
});

test("scripture merge honors a removal made on the other device", () => {
  const base = { entries: [entry("a"), entry("b")] };
  const local = { entries: [entry("a"), entry("b")] };
  const remote = { entries: [entry("a")] };
  assert.deepEqual(mergeScriptureMemoryStates(base, local, remote).entries.map((e) => e.id), ["a"]);
});

test("scripture merge keeps a review made on a device the other side deleted concurrently", () => {
  const base = { entries: [entry("a")] };
  const local = { entries: [entry("a", { totalReviews: 1, stage: 1, lastReviewISO: "2026-09-02T00:00:00.000Z" })] };
  const remote = { entries: [] };
  assert.equal(mergeScriptureMemoryStates(base, local, remote).entries.length, 1);
});

test("scripture merge takes the further-reviewed copy and converges symmetrically", () => {
  const base = { entries: [entry("a")] };
  const reviewed = entry("a", { totalReviews: 1, stage: 1, lastReviewISO: "2026-09-02T10:00:00.123Z" });
  const rescheduled = entry("a", { scheduledAtISO: "2026-09-02T11:00:00.000Z" });
  const ab = mergeScriptureMemoryStates(base, { entries: [reviewed] }, { entries: [rescheduled] });
  const ba = mergeScriptureMemoryStates(base, { entries: [rescheduled] }, { entries: [reviewed] });
  assert.deepEqual(ab.entries, [reviewed]);
  assert.deepEqual(ba.entries, [reviewed]);
  assert.equal(ab.lastReviewISO, "2026-09-02T10:00:00.123Z");
});

test("scripture merge without a base unions both lists (first sync of a second device)", () => {
  const merged = mergeScriptureMemoryStates(null, { entries: [entry("a")] }, { entries: [entry("b")] });
  assert.deepEqual(merged.entries.map((e) => e.id).sort(), ["a", "b"]);
});

test("bible merge keeps chapters read on each device and honors un-reads", () => {
  const base = tracker({ progress: { gen: [1, 2] } });
  const local = tracker({ progress: { gen: [1, 2, 3] } });
  const remote = tracker({ progress: { gen: [1], exo: [1] } });
  const merged = mergeBibleTrackerStates(base, local, remote);
  assert.deepEqual(merged.progress, { gen: [1, 3], exo: [1] });
});

test("bible merge combines partial verse selections per chapter", () => {
  const base = tracker({ verses: { gen: { "1": [1] } }, verseCounts: { gen: { "1": 31 } } });
  const local = tracker({ verses: { gen: { "1": [1, 2] } }, verseCounts: { gen: { "1": 31 } } });
  const remote = tracker({ verses: { gen: { "1": [1, 5] } }, verseCounts: { gen: { "1": 31 } } });
  const merged = mergeBibleTrackerStates(base, local, remote);
  assert.deepEqual(merged.verses, { gen: { "1": [1, 2, 5] } });
  assert.deepEqual(merged.verseCounts, { gen: { "1": 31 } });
});

test("bible merge lets the newer reset win and keeps both archives", () => {
  const archived = { id: "arch", savedAtISO: "2026-06-01T00:00:00.000Z", lastResetISO: "2026-01-01T00:00:00.000Z", progress: { gen: [1] }, verses: {}, verseCounts: {}, completedBooks: {} };
  const base = tracker({ progress: { gen: [1] } });
  const local = tracker({ progress: { gen: [1, 2] } });
  const remote = tracker({ lastResetISO: "2026-06-01T00:00:00.000Z", progress: {}, archive: [archived] });
  const merged = mergeBibleTrackerStates(base, local, remote);
  assert.equal(merged.lastResetISO, "2026-06-01T00:00:00.000Z");
  assert.deepEqual(merged.progress, {});
  assert.deepEqual(merged.archive.map((a) => a.id), ["arch"]);
});

test("bible merge preserves client-only fields from the local state", () => {
  const local = { ...tracker(), expandedBooks: { gen: true } };
  const merged = mergeBibleTrackerStates(null, local, tracker({ progress: { gen: [1] } }));
  assert.deepEqual(merged.expandedBooks, { gen: true });
  assert.deepEqual(merged.progress, { gen: [1] });
});

test("chat merge advances read markers and answers pending shares", () => {
  const a = { readThrough: { peer1: 100, peer2: 50 }, inboxResponses: { w1: { status: "accepted" as const, at: 10 } } };
  const b = { readThrough: { peer1: 90, peer3: 5 }, inboxResponses: { w2: { status: "deleted" as const, at: 20 } } };
  const merged = mergeChatSyncStates(a, b);
  assert.deepEqual(merged.readThrough, { peer1: 100, peer2: 50, peer3: 5 });
  assert.deepEqual(Object.keys(merged.inboxResponses).sort(), ["w1", "w2"]);
  assert.ok(chatSyncStatesEqual(mergeChatSyncStates(a, b), mergeChatSyncStates(b, a)));
});

test("sanitizeChatSyncState lowercases keys and drops invalid statuses", () => {
  const state = sanitizeChatSyncState({
    readThrough: { ABC: 5, bad: "x" },
    inboxResponses: { W1: { status: "accepted", at: 3 }, w2: { status: "read", at: 3 } },
  });
  assert.deepEqual(state, { readThrough: { abc: 5 }, inboxResponses: { w1: { status: "accepted", at: 3 } } });
});

test("pruneChatSyncState bounds age and size", () => {
  const pruned = pruneChatSyncState(
    { readThrough: { old: 1, a: 1000, b: 999 }, inboxResponses: { old: { status: "deleted", at: 1 }, n: { status: "accepted", at: 1000 } } },
    { nowSeconds: 1000, maxAgeSeconds: 100, maxEntries: 1 },
  );
  assert.deepEqual(pruned.readThrough, { a: 1000 });
  assert.deepEqual(Object.keys(pruned.inboxResponses), ["n"]);
});

test("sync keys ignore key order and device-only UI fields", async () => {
  const { bibleTrackerSyncKey, scriptureMemorySyncKey } = await import("../dist/appStateSync.js");
  const a = { ...tracker({ progress: { gen: [1], exo: [2] } }), expandedBooks: { gen: true } };
  const b = { ...tracker({ progress: { exo: [2], gen: [1] } }), expandedBooks: {} };
  assert.equal(bibleTrackerSyncKey(a), bibleTrackerSyncKey(b));
  assert.notEqual(bibleTrackerSyncKey(a), bibleTrackerSyncKey(tracker({ progress: { gen: [1] } })));
  assert.equal(
    scriptureMemorySyncKey({ entries: [entry("b"), entry("a")] }),
    scriptureMemorySyncKey({ entries: [entry("a"), entry("b")] }),
  );
});

test("chatSyncStateCovers reports whether local has anything new", async () => {
  const { chatSyncStateCovers } = await import("../dist/appStateSync.js");
  const remote = { readThrough: { p: 100 }, inboxResponses: { w: { status: "accepted" as const, at: 10 } } };
  assert.equal(chatSyncStateCovers(remote, { readThrough: { p: 90 }, inboxResponses: { w: { status: "accepted", at: 10 } } }), true);
  assert.equal(chatSyncStateCovers(remote, { readThrough: { p: 101 }, inboxResponses: {} }), false);
  assert.equal(chatSyncStateCovers(remote, { readThrough: {}, inboxResponses: { x: { status: "deleted", at: 1 } } }), false);
});

test("bibleTrackerSyncContent drops device-only UI state", async () => {
  const { bibleTrackerSyncContent } = await import("../dist/appStateSync.js");
  const content = bibleTrackerSyncContent({ ...tracker({ progress: { gen: [1] } }), expandedBooks: { gen: true } } as any);
  assert.equal("expandedBooks" in content, false);
  assert.deepEqual(content.progress, { gen: [1] });
});

test("pruneChatSyncState keeps the published payload under the relay size budget", async () => {
  const { pruneChatSyncState, CHAT_SYNC_MAX_PLAINTEXT_BYTES } = await import("../dist/appStateSync.js");
  const key = (i: number) => i.toString(16).padStart(64, "0");
  const readThrough: Record<string, number> = {};
  const inboxResponses: Record<string, any> = {};
  for (let i = 1; i <= 1000; i += 1) {
    readThrough[key(i)] = 1_790_000_000 + i;
    inboxResponses[key(i + 5000)] = { status: "accepted", at: 1_790_000_000 + i };
  }
  const pruned = pruneChatSyncState({ readThrough, inboxResponses }, { nowSeconds: 1_790_001_000 });
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, timestamp: 1_790_001_000, ...pruned })).length;
  assert.ok(bytes <= CHAT_SYNC_MAX_PLAINTEXT_BYTES, `payload was ${bytes} bytes`);
  // The newest entries survive.
  assert.equal(pruned.readThrough[key(1000)], 1_790_001_000);
  assert.equal(pruned.readThrough[key(1)], undefined);
});

test("chatSyncStateToPublish ignores local entries that pruning would drop anyway", async () => {
  const { chatSyncStateToPublish } = await import("../dist/appStateSync.js");
  const now = 1_790_000_000;
  const known = { readThrough: { recent: now - 10 }, inboxResponses: {} };
  // An ancient marker the published state has already pruned must not cause a republish loop.
  const local = { readThrough: { recent: now - 10, ancient: 1_000 }, inboxResponses: {} };
  assert.equal(chatSyncStateToPublish(known, local, now), null);
  const next = chatSyncStateToPublish(known, { ...local, readThrough: { ...local.readThrough, fresh: now } }, now);
  assert.deepEqual(next?.readThrough, { recent: now - 10, fresh: now });
});
