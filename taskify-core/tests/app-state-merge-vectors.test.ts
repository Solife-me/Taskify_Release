/**
 * App-state merge vectors shared with iOS (C7-3): Bible tracker, Scripture Memory and chat state
 * cases (base / local / remote) and the merge both clients must produce. The fixture is written
 * from these merges (WRITE_APP_STATE_VECTORS=1) and checked here and by Swift
 * `AppStateMergeVectorTests`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import {
  mergeBibleTrackerStates,
  mergeChatSyncStates,
  mergeScriptureMemoryStates,
} from "../dist/appStateSync.js";

const FIXTURE = new URL("../fixtures/app-state-merge-vectors.json", import.meta.url);

type Bible = {
  lastResetISO: string;
  progress: Record<string, number[]>;
  verses: Record<string, Record<string, number[]>>;
  verseCounts: Record<string, Record<string, number>>;
  completedBooks: Record<string, { completedAtISO: string }>;
  archive: Array<Omit<Bible, "archive"> & { id: string; savedAtISO: string }>;
};

const CYCLE = "2026-09-01T00:00:00.000Z";
const bible = (overrides: Partial<Bible> = {}): Bible => ({
  lastResetISO: CYCLE,
  progress: {},
  verses: {},
  verseCounts: {},
  completedBooks: {},
  archive: [],
  ...overrides,
});
const archiveEntry = (id: string, savedAtISO: string, progress: Record<string, number[]> = {}) => ({
  id,
  savedAtISO,
  lastResetISO: "2026-01-01T00:00:00.000Z",
  progress,
  verses: {},
  verseCounts: {},
  completedBooks: {},
});

const bibleCases: Array<{ name: string; base: Bible | null; local: Bible; remote: Bible }> = [
  {
    name: "chapters read on each device are both kept",
    base: bible({ progress: { gen: [1] } }),
    local: bible({ progress: { gen: [1, 2] } }),
    remote: bible({ progress: { gen: [1], exo: [5] } }),
  },
  {
    name: "a chapter unmarked on one device is removed",
    base: bible({ progress: { gen: [1, 2, 3] } }),
    local: bible({ progress: { gen: [1, 3] } }),
    remote: bible({ progress: { gen: [1, 2, 3] } }),
  },
  {
    name: "without a base nothing is read as removed",
    base: null,
    local: bible({ progress: { gen: [3] } }),
    remote: bible({ progress: { gen: [1, 2] } }),
  },
  {
    name: "a base from another reading cycle says nothing about removals",
    base: bible({ lastResetISO: "2026-01-01T00:00:00.000Z", progress: { gen: [1, 2] } }),
    local: bible({ progress: { gen: [1] } }),
    remote: bible({ progress: { gen: [2] } }),
  },
  {
    name: "verses merge per chapter and verse counts keep the larger value",
    base: bible({ verses: { psa: { "23": [1] } }, verseCounts: { psa: { "23": 6 } } }),
    local: bible({ verses: { psa: { "23": [1, 2] } }, verseCounts: { psa: { "23": 6, "1": 6 } } }),
    remote: bible({ verses: { psa: { "23": [1, 4], "1": [1] } }, verseCounts: { psa: { "23": 6, "1": 7 } } }),
  },
  {
    name: "a book completed on both devices keeps the earlier completion",
    base: bible(),
    local: bible({ completedBooks: { jud: { completedAtISO: "2026-09-10T12:00:00.000Z" } } }),
    remote: bible({ completedBooks: { jud: { completedAtISO: "2026-09-09T08:00:00.000Z" } } }),
  },
  {
    name: "a completion removed on one device is removed",
    base: bible({ completedBooks: { jud: { completedAtISO: "2026-09-09T08:00:00.000Z" } } }),
    local: bible({ completedBooks: { jud: { completedAtISO: "2026-09-09T08:00:00.000Z" } } }),
    remote: bible(),
  },
  {
    name: "the newer reading cycle wins outright and archives merge newest first",
    base: bible({ progress: { gen: [1] }, archive: [archiveEntry("a1", "2026-01-01T00:00:00.000Z")] }),
    local: bible({ progress: { gen: [1, 2] }, archive: [archiveEntry("a1", "2026-01-01T00:00:00.000Z")] }),
    remote: bible({
      lastResetISO: "2026-10-01T00:00:00.000Z",
      progress: { mat: [1] },
      archive: [
        archiveEntry("a2", "2026-10-01T00:00:00.000Z", { gen: [1] }),
        archiveEntry("a1", "2026-01-01T00:00:00.000Z"),
      ],
    }),
  },
  {
    name: "resets at the same instant break the tie on the timestamp text",
    base: null,
    local: bible({ lastResetISO: "2026-10-01T00:00:00Z", progress: { gen: [1] } }),
    remote: bible({ lastResetISO: "2026-10-01T00:00:00.000Z", progress: { exo: [1] } }),
  },
  {
    name: "an archive entry edited differently on both devices resolves the same way everywhere",
    base: bible({ archive: [archiveEntry("a1", "2026-01-01T00:00:00.000Z")] }),
    local: bible({ archive: [archiveEntry("a1", "2026-01-01T00:00:00.000Z", { gen: [1] })] }),
    remote: bible({ archive: [archiveEntry("a1", "2026-01-01T00:00:00.000Z", { exo: [2] })] }),
  },
];

type Entry = {
  id: string;
  bookId: string;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
  addedAtISO: string;
  lastReviewISO?: string;
  scheduledAtISO?: string;
  stage: number;
  totalReviews: number;
};
type Scripture = { entries: Entry[]; lastReviewISO?: string };

const entry = (id: string, overrides: Partial<Entry> = {}): Entry => ({
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

const scriptureCases: Array<{ name: string; base: Scripture | null; local: Scripture; remote: Scripture }> = [
  {
    name: "passages added on each device are both kept, this device's first",
    base: { entries: [entry("e1")] },
    local: { entries: [entry("e1"), entry("e2", { bookId: "psa", chapter: 23, startVerse: 1, endVerse: 3 })] },
    remote: { entries: [entry("e3", { bookId: "rom", chapter: 8, startVerse: null, endVerse: null }), entry("e1")] },
  },
  {
    name: "a passage removed on one device is removed",
    base: { entries: [entry("e1"), entry("e2")] },
    local: { entries: [entry("e1")] },
    remote: { entries: [entry("e1"), entry("e2")] },
  },
  {
    name: "a passage reviewed on one device and removed on the other is kept",
    base: { entries: [entry("e1")] },
    local: { entries: [] },
    remote: {
      entries: [entry("e1", { totalReviews: 1, stage: 1, lastReviewISO: "2026-09-05T10:00:00.000Z" })],
      lastReviewISO: "2026-09-05T10:00:00.000Z",
    },
  },
  {
    name: "the further-reviewed copy wins",
    base: { entries: [entry("e1")] },
    local: { entries: [entry("e1", { totalReviews: 2, stage: 1, lastReviewISO: "2026-09-04T10:00:00.000Z" })] },
    remote: { entries: [entry("e1", { totalReviews: 3, stage: 0, lastReviewISO: "2026-09-03T10:00:00.000Z" })] },
  },
  {
    name: "equal review counts fall to the later review",
    base: null,
    local: { entries: [entry("e1", { totalReviews: 2, lastReviewISO: "2026-09-04T10:00:00Z" })] },
    remote: { entries: [entry("e1", { totalReviews: 2, lastReviewISO: "2026-09-04T11:00:00.000Z" })] },
  },
  {
    name: "then to the higher stage",
    base: null,
    local: { entries: [entry("e1", { totalReviews: 2, stage: 3, lastReviewISO: "2026-09-04T10:00:00.000Z" })] },
    remote: { entries: [entry("e1", { totalReviews: 2, stage: 2, lastReviewISO: "2026-09-04T10:00:00.000Z" })] },
  },
  {
    name: "then to the later schedule",
    base: null,
    local: { entries: [entry("e1", { scheduledAtISO: "2026-09-08T00:00:00.000Z" })] },
    remote: { entries: [entry("e1", { scheduledAtISO: "2026-09-09T00:00:00.000Z" })] },
  },
  {
    name: "a full tie resolves the same way everywhere",
    base: null,
    local: { entries: [entry("e1", { endVerse: 17 })] },
    remote: { entries: [entry("e1", { endVerse: null, startVerse: null })] },
  },
  {
    name: "the latest review time is kept",
    base: { entries: [entry("e1")], lastReviewISO: "2026-09-01T09:00:00.000Z" },
    local: { entries: [entry("e1")], lastReviewISO: "2026-09-02T09:00:00.000Z" },
    remote: {
      entries: [entry("e1"), entry("e2", { lastReviewISO: "2026-09-06T09:00:00.000Z", totalReviews: 1 })],
      lastReviewISO: "2026-09-01T09:00:00.000Z",
    },
  },
];

type Chat = {
  readThrough: Record<string, number>;
  inboxResponses: Record<string, { status: "accepted" | "declined" | "tentative" | "deleted"; at: number }>;
};

const chatCases: Array<{ name: string; a: Chat; b: Chat }> = [
  {
    name: "read markers only move forward",
    a: { readThrough: { alice: 100, group1: 50 }, inboxResponses: {} },
    b: { readThrough: { alice: 90, bob: 70 }, inboxResponses: {} },
  },
  {
    name: "the later response wins",
    a: { readThrough: {}, inboxResponses: { wrap1: { status: "accepted", at: 10 }, wrap2: { status: "declined", at: 30 } } },
    b: { readThrough: {}, inboxResponses: { wrap1: { status: "declined", at: 20 }, wrap2: { status: "accepted", at: 25 } } },
  },
  {
    name: "responses at the same second break the tie on the status name",
    a: { readThrough: {}, inboxResponses: { wrap1: { status: "accepted", at: 10 }, wrap2: { status: "tentative", at: 5 } } },
    b: { readThrough: {}, inboxResponses: { wrap1: { status: "deleted", at: 10 }, wrap2: { status: "declined", at: 5 } } },
  },
];

function buildVectors() {
  return {
    description:
      "App-state merges (Bible tracker, Scripture Memory, chat state) that every client must produce. Written by taskify-core tests/app-state-merge-vectors.test.ts (WRITE_APP_STATE_VECTORS=1); checked there and by Swift AppStateMergeVectorTests.",
    bibleTracker: bibleCases.map((c) => ({ ...c, expected: mergeBibleTrackerStates(c.base, c.local, c.remote) })),
    scriptureMemory: scriptureCases.map((c) => ({ ...c, expected: mergeScriptureMemoryStates(c.base, c.local, c.remote) })),
    chatState: chatCases.map((c) => ({ ...c, expected: mergeChatSyncStates(c.a, c.b) })),
  };
}

test("app-state merge vectors match the core merges", () => {
  const built = JSON.parse(JSON.stringify(buildVectors()));
  if (process.env.WRITE_APP_STATE_VECTORS === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(built, null, 2)}\n`);
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(fixture, built);
});

test("chat-state merges agree whichever device merges", () => {
  for (const c of chatCases) {
    assert.deepEqual(mergeChatSyncStates(c.b, c.a), mergeChatSyncStates(c.a, c.b), c.name);
  }
});
