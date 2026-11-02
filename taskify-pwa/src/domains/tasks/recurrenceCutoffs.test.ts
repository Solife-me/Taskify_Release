import { describe, expect, it } from "vitest";
import { SCRIPTURE_MEMORY_SERIES_ID } from "taskify-core";
import {
  applyRecurringSeriesCutoffs,
  parseRecurringSeriesCutoffs,
  updateRecurringSeriesCutoff,
} from "./recurrenceCutoffs";
import type { Task } from "./taskTypes";

const CUTOFF = "2026-08-13T05:00:00.000Z";

function review(overrides: Partial<Task> = {}): Task {
  return {
    id: "recurrence:scripture-memory:2026-11-02",
    boardId: "b1",
    title: "Review John 3:16",
    dueISO: "2026-11-02T06:00:00.000Z",
    order: 0,
    recurrence: { type: "daily" },
    seriesId: SCRIPTURE_MEMORY_SERIES_ID,
    ...overrides,
  } as Task;
}

describe("series cutoffs and the Scripture Memory review series", () => {
  it("never records a cutoff for the review series", () => {
    expect(updateRecurringSeriesCutoff({}, review(), CUTOFF)).toEqual({});
  });

  it("keeps reviews a stored cutoff would have dropped", () => {
    const tasks = [review()];
    expect(applyRecurringSeriesCutoffs(tasks, { b1: { [SCRIPTURE_MEMORY_SERIES_ID]: CUTOFF } })).toBe(tasks);
  });

  it("drops cutoffs older builds stored for the review series, keeping the rest", () => {
    const stored = JSON.stringify({ b1: { [SCRIPTURE_MEMORY_SERIES_ID]: CUTOFF, other: CUTOFF }, b2: { "scripture-memory-series": CUTOFF } });
    expect(parseRecurringSeriesCutoffs(stored)).toEqual({ b1: { other: CUTOFF } });
  });

  it("still ends other series", () => {
    const task = review({ id: "t1", seriesId: "s1", title: "Water plants" });
    expect(applyRecurringSeriesCutoffs([task], { b1: { s1: CUTOFF } })).toEqual([]);
  });
});
