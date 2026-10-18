import { describe, expect, test } from "vitest";
import {
  applyBibleScan,
  completeBibleBook,
  deleteBibleArchive,
  resetBibleTracker,
  restoreBibleArchive,
  restoreBibleBook,
  setBibleChapterVerses,
  toggleBibleBook,
  toggleBibleChapter,
} from "./bibleTrackerCommands";
import { getBibleBookChapterCount, sanitizeBibleTrackerState, type BibleTrackerState } from "./bibleTrackerModel";

const empty = (): BibleTrackerState => sanitizeBibleTrackerState(null);
const NOW = "2026-10-18T12:00:00.000Z";

describe("Bible tracker commands", () => {
  test("toggling a book opens and closes it", () => {
    const opened = toggleBibleBook(empty(), "jhn");
    expect(opened.expandedBooks).toEqual({ jhn: true });
    expect(toggleBibleBook(opened, "jhn").expandedBooks).toEqual({});
  });

  test("toggling a chapter marks it read, sorted, and unread again", () => {
    let state = toggleBibleChapter(empty(), "jhn", 3);
    state = toggleBibleChapter(state, "jhn", 1);
    expect(state.progress.jhn).toEqual([1, 3]);
    state = toggleBibleChapter(state, "jhn", 3);
    expect(state.progress.jhn).toEqual([1]);
    state = toggleBibleChapter(state, "jhn", 1);
    expect(state.progress.jhn).toBeUndefined();
  });

  test("invalid input changes nothing", () => {
    const state = empty();
    expect(toggleBibleChapter(state, "", 1)).toBe(state);
    expect(toggleBibleChapter(state, "jhn", 0)).toBe(state);
    expect(toggleBibleBook(state, "")).toBe(state);
  });

  test("reading every verse marks the chapter read; partial reading keeps the verses", () => {
    const partial = setBibleChapterVerses(empty(), "jud", 1, [1, 2], 25);
    expect(partial.verses.jud?.[1]).toEqual([1, 2]);
    expect(partial.progress.jud).toBeUndefined();
    const all = Array.from({ length: 25 }, (_, i) => i + 1);
    const done = setBibleChapterVerses(partial, "jud", 1, all, 25);
    expect(done.progress.jud).toEqual([1]);
    expect(done.verses.jud).toBeUndefined();
  });

  test("a scan adds only new chapters and counts them", () => {
    const start = toggleBibleChapter(empty(), "jhn", 1);
    const { state, addedChapters } = applyBibleScan(start, { jhn: [1, 2, 3, 99], xyz: [1] });
    expect(state.progress.jhn).toEqual([1, 2, 3]);
    expect(addedChapters).toBe(2);
    expect(applyBibleScan(state, { jhn: [2] })).toEqual({ state, addedChapters: 0 });
  });

  test("a book completes once, only when every chapter is read, and can be restored", () => {
    const chapters = getBibleBookChapterCount("jud") ?? 0;
    let state = empty();
    expect(completeBibleBook(state, "jud", NOW).completed).toBe(false);
    for (let chapter = 1; chapter <= chapters; chapter += 1) state = toggleBibleChapter(state, "jud", chapter);
    const first = completeBibleBook(state, "jud", NOW);
    expect(first.completed).toBe(true);
    expect(first.state.completedBooks.jud).toEqual({ completedAtISO: NOW });
    expect(completeBibleBook(first.state, "jud", NOW).completed).toBe(false);
    expect(restoreBibleBook(first.state, "jud").completedBooks.jud).toBeUndefined();
  });

  test("reset archives the progress; an archive can be restored or deleted", () => {
    const read = toggleBibleChapter(empty(), "jhn", 1);
    const reset = resetBibleTracker(read, "snap-1", NOW);
    expect(reset.progress).toEqual({});
    expect(reset.lastResetISO).toBe(NOW);
    expect(reset.archive[0]).toMatchObject({ id: "snap-1", savedAtISO: NOW, progress: { jhn: [1] } });
    expect(restoreBibleArchive(reset, "snap-1").progress).toEqual({ jhn: [1] });
    expect(deleteBibleArchive(reset, "snap-1").archive).toEqual([]);
    expect(deleteBibleArchive(reset, "missing")).toBe(reset);
  });
});
