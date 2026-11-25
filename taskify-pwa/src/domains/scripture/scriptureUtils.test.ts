import { describe, expect, it } from "vitest";
import { sanitizeScriptureMemoryState, updateScriptureMemoryVerseText } from "./scriptureUtils";

// Vitest runs under Node; the app's type config has no Node types.
const testEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;

describe("sanitizeScriptureMemoryState", () => {
  it("keeps a whole-chapter passage (no verses) as a whole chapter", () => {
    // Native clients store "John 3" with null verses; turning it into 3:1 would round-trip
    // back through sync as a different passage.
    const state = sanitizeScriptureMemoryState({
      entries: [{ id: "a", bookId: "jhn", chapter: 3, startVerse: null, endVerse: null, addedAtISO: "2026-09-01T00:00:00.000Z", stage: 0, totalReviews: 0 }],
    });
    expect(state.entries[0].startVerse).toBeNull();
    expect(state.entries[0].endVerse).toBeNull();
  });

  it("still repairs a missing end verse on a verse passage", () => {
    const state = sanitizeScriptureMemoryState({
      entries: [{ id: "a", bookId: "jhn", chapter: 3, startVerse: 16, addedAtISO: "2026-09-01T00:00:00.000Z" }],
    });
    expect(state.entries[0].startVerse).toBe(16);
    expect(state.entries[0].endVerse).toBe(16);
  });

  it("preserves native verse text and explicit clears when normalizing synced entries", () => {
    const updatedAtISO = "2026-09-04T10:00:00.000Z";
    const first = { id: "a", bookId: "jhn", chapter: 3, startVerse: 16 };
    const state = sanitizeScriptureMemoryState({ entries: [
      { ...first, verseText: { text: "First line.\nSecond line.", updatedAtISO } },
      { ...first, id: "b", verseText: { text: "", updatedAtISO } },
      { ...first, id: "c" },
    ] });
    expect(state.entries.map((entry) => entry.verseText)).toEqual([
      { text: "First line.\nSecond line.", updatedAtISO },
      { text: "", updatedAtISO },
      undefined,
    ]);
  });

  it("stores verse text with a monotonic edit timestamp and keeps review history", () => {
    const state = sanitizeScriptureMemoryState({
      lastReviewISO: "2026-09-05T10:00:00.000Z",
      entries: [{
        id: "a", bookId: "jhn", chapter: 3, startVerse: 16,
        addedAtISO: "2026-09-01T00:00:00.000Z", stage: 2, totalReviews: 3,
        lastReviewISO: "2026-09-05T10:00:00.000Z",
        verseText: { text: "Old", updatedAtISO: "2026-09-06T10:00:00.000Z" },
      }],
    });
    const updated = updateScriptureMemoryVerseText(
      state, "a", "  First line.\nSecond line.  ", "2026-09-05T09:00:00.000Z",
    );
    expect(updated.entries[0]).toMatchObject({ stage: 2, totalReviews: 3, lastReviewISO: "2026-09-05T10:00:00.000Z" });
    expect(updated.entries[0].verseText).toEqual({
      text: "First line.\nSecond line.",
      updatedAtISO: "2026-09-06T10:00:00.001Z",
    });
    expect(updated.lastReviewISO).toBe("2026-09-05T10:00:00.000Z");
    expect(updateScriptureMemoryVerseText(updated, "a", "First line.\nSecond line.")).toBe(updated);
  });
});

describe("scripture review task ids", () => {
  it("uses the local calendar day, matching the native bootstrapTaskID", async () => {
    const { recurringInstanceId } = await import("../tasks/taskUtils");
    const previousTZ = testEnv.TZ;
    testEnv.TZ = "America/Chicago";
    try {
      // 2026-09-24 21:06 in Chicago, already 09-25 in UTC.
      const dueISO = new Date(1_790_302_000_000).toISOString();
      expect(recurringInstanceId("scripture-memory", dueISO)).toBe("recurrence:scripture-memory:2026-09-24");
    } finally {
      testEnv.TZ = previousTZ;
    }
  });
});
