import { describe, expect, it } from "vitest";
import { sanitizeScriptureMemoryState } from "./scriptureUtils";

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
});

describe("scripture review task ids", () => {
  it("uses the local calendar day, matching the native bootstrapTaskID", async () => {
    const { recurringInstanceId } = await import("../tasks/taskUtils");
    const previousTZ = process.env.TZ;
    process.env.TZ = "America/Chicago";
    try {
      // 2026-09-24 21:06 in Chicago, already 09-25 in UTC.
      const dueISO = new Date(1_790_302_000_000).toISOString();
      expect(recurringInstanceId("scripture-memory", dueISO)).toBe("recurrence:scripture-memory:2026-09-24");
    } finally {
      process.env.TZ = previousTZ;
    }
  });
});
