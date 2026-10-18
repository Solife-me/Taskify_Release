/**
 * Changes to the Bible reading tracker, as pure functions of its state. Each returns the same
 * state object when nothing changes, so callers (and React) can skip work.
 */
import { getBibleChapterVerseCount } from "../../data/bibleVerseCounts";
import {
  cloneBibleCompletedBooks,
  cloneBibleProgress,
  cloneBibleVerseCounts,
  cloneBibleVerses,
  getBibleBookChapterCount,
  MAX_VERSE_COUNT,
  type BibleTrackerProgress,
  type BibleTrackerState,
} from "./bibleTrackerModel";

/** Opens or closes a book's chapter list. */
export function toggleBibleBook(prev: BibleTrackerState, bookId: string): BibleTrackerState {
  const normalizedBookId = String(bookId || "");
  if (!normalizedBookId) return prev;
  const current = prev.expandedBooks || {};
  const nextExpanded = { ...current };
  const wasExpanded = !!nextExpanded[normalizedBookId];
  if (wasExpanded) {
    delete nextExpanded[normalizedBookId];
  } else {
    nextExpanded[normalizedBookId] = true;
  }
  if (wasExpanded === !!nextExpanded[normalizedBookId]) {
    return prev;
  }
  return { ...prev, expandedBooks: nextExpanded };
}

/** Marks a chapter read, or unread (clearing its partial verses and the book's completion). */
export function toggleBibleChapter(prev: BibleTrackerState, bookId: string, chapter: number): BibleTrackerState {
  const normalizedBookId = String(bookId || "");
  const normalizedChapter = Number.isFinite(chapter) ? Math.trunc(chapter) : NaN;
  if (!normalizedBookId || !Number.isFinite(normalizedChapter) || normalizedChapter <= 0) return prev;
  const previousChapters = prev.progress[normalizedBookId] ?? [];
  const alreadyChecked = previousChapters.includes(normalizedChapter);
  let nextChapters: number[];

  if (alreadyChecked) {
    nextChapters = previousChapters.filter((value) => value !== normalizedChapter);
  } else {
    nextChapters = [...previousChapters, normalizedChapter];
  }

  if (nextChapters.length === previousChapters.length) {
    return prev;
  }

  if (nextChapters.length > 1) {
    nextChapters.sort((a, b) => a - b);
  }

  const nextProgress = { ...prev.progress };
  if (nextChapters.length === 0) {
    delete nextProgress[normalizedBookId];
  } else {
    nextProgress[normalizedBookId] = nextChapters;
  }

  let nextVerses = prev.verses;
  const existingChapterVerses = prev.verses?.[normalizedBookId]?.[normalizedChapter];
  if (existingChapterVerses || alreadyChecked) {
    const updatedVerses = { ...prev.verses } as typeof prev.verses;
    const chapterMap = { ...(updatedVerses[normalizedBookId] || {}) };
    if (chapterMap[normalizedChapter]) {
      delete chapterMap[normalizedChapter];
    }
    if (Object.keys(chapterMap).length === 0) {
      delete updatedVerses[normalizedBookId];
    } else {
      updatedVerses[normalizedBookId] = chapterMap;
    }
    nextVerses = updatedVerses;
  }

  const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
  let nextCompletedBooks = prev.completedBooks;
  if (totalChapters <= 0 || nextChapters.length < totalChapters) {
    if (prev.completedBooks?.[normalizedBookId]) {
      const updated = { ...prev.completedBooks };
      delete updated[normalizedBookId];
      nextCompletedBooks = updated;
    }
  }

  const didChangeProgress = nextProgress !== prev.progress;
  const didChangeVerses = nextVerses !== prev.verses;
  const didChangeCompleted = nextCompletedBooks !== prev.completedBooks;

  if (!didChangeProgress && !didChangeVerses && !didChangeCompleted) {
    return prev;
  }

  const base = { ...prev };
  if (didChangeProgress) base.progress = nextProgress;
  if (didChangeVerses) base.verses = nextVerses;
  if (didChangeCompleted) base.completedBooks = nextCompletedBooks;
  return base;
}

/** Records the verses read in a chapter; reading every verse marks the chapter read. */
export function setBibleChapterVerses(
  prev: BibleTrackerState,
  bookId: string,
  chapter: number,
  verses: number[],
  verseCount: number,
): BibleTrackerState {
  const normalizedBookId = String(bookId || "");
  const normalizedChapter = Number.isFinite(chapter) ? Math.trunc(chapter) : NaN;
  if (!normalizedBookId || !Number.isFinite(normalizedChapter) || normalizedChapter <= 0) return prev;
  const chapterLimit = Math.min(
    Math.max(getBibleChapterVerseCount(normalizedBookId, normalizedChapter) ?? MAX_VERSE_COUNT, 1),
    MAX_VERSE_COUNT
  );
  const normalizedVerses = Array.from(
    new Set(
      (Array.isArray(verses) ? verses : [])
        .map((value) => (typeof value === "number" ? Math.trunc(value) : NaN))
        .filter((value) => Number.isFinite(value) && value > 0 && value <= chapterLimit)
    )
  ).sort((a, b) => a - b);

  const normalizedCount = Number.isFinite(verseCount)
    ? Math.min(Math.max(Math.trunc(verseCount), 0), chapterLimit)
    : 0;
  const effectiveCount = normalizedCount > 0 ? normalizedCount : 0;
  const filteredVerses = effectiveCount > 0 ? normalizedVerses.filter((value) => value <= effectiveCount) : normalizedVerses;

  let nextVerses = prev.verses;
  const prevBookVerses = prev.verses?.[normalizedBookId];
  const prevChapterVerses = prevBookVerses?.[normalizedChapter] ?? [];
  if (filteredVerses.length > 0) {
    const updatedBookVerses = { ...(prevBookVerses || {}) };
    updatedBookVerses[normalizedChapter] = filteredVerses;
    const updatedVerses = { ...prev.verses, [normalizedBookId]: updatedBookVerses };
    nextVerses = updatedVerses;
  } else if (prevChapterVerses.length > 0 || prevBookVerses) {
    const updatedBookVerses = { ...(prevBookVerses || {}) };
    if (updatedBookVerses[normalizedChapter]) {
      delete updatedBookVerses[normalizedChapter];
    }
    const updatedVerses = { ...prev.verses } as typeof prev.verses;
    if (Object.keys(updatedBookVerses).length === 0) {
      delete updatedVerses[normalizedBookId];
    } else {
      updatedVerses[normalizedBookId] = updatedBookVerses;
    }
    nextVerses = updatedVerses;
  }

  let nextVerseCounts = prev.verseCounts;
  const prevBookCounts = prev.verseCounts?.[normalizedBookId];
  const prevChapterCount = prevBookCounts?.[normalizedChapter];
  if (effectiveCount > 0) {
    const updatedBookCounts = { ...(prevBookCounts || {}) };
    updatedBookCounts[normalizedChapter] = effectiveCount;
    nextVerseCounts = { ...prev.verseCounts, [normalizedBookId]: updatedBookCounts };
  } else if (prevChapterCount) {
    const updatedBookCounts = { ...(prevBookCounts || {}) };
    delete updatedBookCounts[normalizedChapter];
    const updatedCounts = { ...prev.verseCounts } as typeof prev.verseCounts;
    if (Object.keys(updatedBookCounts).length === 0) {
      delete updatedCounts[normalizedBookId];
    } else {
      updatedCounts[normalizedBookId] = updatedBookCounts;
    }
    nextVerseCounts = updatedCounts;
  }

  let nextProgress = prev.progress;
  const previousChapters = prev.progress[normalizedBookId] ?? [];
  const hasChapter = previousChapters.includes(normalizedChapter);

  const shouldComplete = effectiveCount > 0 && filteredVerses.length === effectiveCount && effectiveCount > 0;
  if (shouldComplete) {
    if (!hasChapter) {
      const updatedChapters = [...previousChapters, normalizedChapter].sort((a, b) => a - b);
      nextProgress = { ...prev.progress, [normalizedBookId]: updatedChapters };
    }
    const bookVerses = nextVerses?.[normalizedBookId];
    if (bookVerses?.[normalizedChapter]) {
      const updatedBookVerses = { ...bookVerses };
      delete updatedBookVerses[normalizedChapter];
      const updatedVerses = { ...nextVerses } as typeof nextVerses;
      if (Object.keys(updatedBookVerses).length === 0) {
        delete updatedVerses[normalizedBookId];
      } else {
        updatedVerses[normalizedBookId] = updatedBookVerses;
      }
      nextVerses = updatedVerses;
    }
  } else if (hasChapter) {
    const updatedChapters = previousChapters.filter((value) => value !== normalizedChapter);
    const updatedProgress = { ...prev.progress };
    if (updatedChapters.length === 0) {
      delete updatedProgress[normalizedBookId];
    } else {
      updatedProgress[normalizedBookId] = updatedChapters;
    }
    nextProgress = updatedProgress;
  }

  const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
  let nextCompletedBooks = prev.completedBooks;
  const chapterTotal = Array.isArray(nextProgress[normalizedBookId])
    ? nextProgress[normalizedBookId].length
    : 0;
  if (totalChapters <= 0 || chapterTotal < totalChapters) {
    if (prev.completedBooks?.[normalizedBookId]) {
      const updated = { ...prev.completedBooks };
      delete updated[normalizedBookId];
      nextCompletedBooks = updated;
    }
  }

  const didChangeVerses = nextVerses !== prev.verses;
  const didChangeCounts = nextVerseCounts !== prev.verseCounts;
  const didChangeProgress = nextProgress !== prev.progress;
  const didChangeCompleted = nextCompletedBooks !== prev.completedBooks;

  if (!didChangeVerses && !didChangeCounts && !didChangeProgress && !didChangeCompleted) {
    return prev;
  }

  return {
    ...prev,
    ...(didChangeProgress ? { progress: nextProgress } : {}),
    ...(didChangeVerses ? { verses: nextVerses } : {}),
    ...(didChangeCounts ? { verseCounts: nextVerseCounts } : {}),
    ...(didChangeCompleted ? { completedBooks: nextCompletedBooks } : {}),
  };
}

/** Adds the chapters found on a scanned printout; reports how many were new. */
export function applyBibleScan(
  prev: BibleTrackerState,
  scanProgress: BibleTrackerProgress,
): { state: BibleTrackerState; addedChapters: number } {
  let addedCount = 0;
  let nextProgress = prev.progress;
  let nextVerses = prev.verses;
  let progressChanged = false;
  let versesChanged = false;

  for (const [bookIdRaw, chaptersRaw] of Object.entries(scanProgress)) {
    const normalizedBookId = String(bookIdRaw || "");
    const chapterTotal = getBibleBookChapterCount(normalizedBookId) ?? 0;
    if (!chapterTotal || !Array.isArray(chaptersRaw)) continue;
    const cleaned = Array.from(
      new Set(
        chaptersRaw
          .map((value) => (typeof value === "number" ? Math.trunc(value) : NaN))
          .filter((value) => Number.isFinite(value) && value > 0 && value <= chapterTotal)
      )
    ).sort((a, b) => a - b);
    if (cleaned.length === 0) continue;

    const existing = prev.progress[normalizedBookId] ?? [];
    const existingSet = new Set(existing);
    const merged = [...existing];
    const newlyAdded: number[] = [];

    for (const chapter of cleaned) {
      if (!existingSet.has(chapter)) {
        existingSet.add(chapter);
        merged.push(chapter);
        newlyAdded.push(chapter);
      }
    }

    if (newlyAdded.length === 0) continue;
    merged.sort((a, b) => a - b);

    if (nextProgress === prev.progress) {
      nextProgress = { ...prev.progress };
    }
    nextProgress[normalizedBookId] = merged;
    progressChanged = true;
    addedCount += newlyAdded.length;

    if (newlyAdded.length > 0) {
      const bookVerses = nextVerses?.[normalizedBookId];
      if (bookVerses) {
        const updatedBookVerses = { ...bookVerses };
        let bookChanged = false;
        for (const chapter of newlyAdded) {
          if (updatedBookVerses[chapter]) {
            delete updatedBookVerses[chapter];
            bookChanged = true;
          }
        }
        if (bookChanged) {
          if (!versesChanged) {
            nextVerses = { ...prev.verses };
            versesChanged = true;
          }
          if (Object.keys(updatedBookVerses).length === 0) {
            delete nextVerses[normalizedBookId];
          } else {
            nextVerses[normalizedBookId] = updatedBookVerses;
          }
        }
      }
    }
  }

  if (!progressChanged && !versesChanged) {
    return { state: prev, addedChapters: 0 };
  }
  return {
    state: {
      ...prev,
      ...(progressChanged ? { progress: nextProgress } : {}),
      ...(versesChanged ? { verses: nextVerses } : {}),
    },
    addedChapters: addedCount,
  };
}

/** Archives the current progress and starts over. */
export function resetBibleTracker(prev: BibleTrackerState, snapshotId: string, nowISO: string): BibleTrackerState {
  const snapshot = {
    id: snapshotId,
    savedAtISO: nowISO,
    lastResetISO: prev.lastResetISO,
    progress: cloneBibleProgress(prev.progress),
    verses: cloneBibleVerses(prev.verses),
    verseCounts: cloneBibleVerseCounts(prev.verseCounts),
    completedBooks: cloneBibleCompletedBooks(prev.completedBooks),
  };
  return {
    ...prev,
    lastResetISO: nowISO,
    progress: {},
    verses: {},
    verseCounts: {},
    completedBooks: {},
    archive: [snapshot, ...prev.archive],
    expandedBooks: {},
  };
}

export function deleteBibleArchive(prev: BibleTrackerState, archiveId: string): BibleTrackerState {
  if (!archiveId) return prev;
  const nextArchive = prev.archive.filter((entry) => entry.id !== archiveId);
  if (nextArchive.length === prev.archive.length) return prev;
  return { ...prev, archive: nextArchive };
}

/** Replaces the current progress with an archived snapshot. */
export function restoreBibleArchive(prev: BibleTrackerState, archiveId: string): BibleTrackerState {
  if (!archiveId) return prev;
  const entry = prev.archive.find((item) => item.id === archiveId);
  if (!entry) return prev;
  return {
    ...prev,
    lastResetISO: entry.lastResetISO,
    progress: cloneBibleProgress(entry.progress),
    verses: cloneBibleVerses(entry.verses),
    verseCounts: cloneBibleVerseCounts(entry.verseCounts),
    completedBooks: cloneBibleCompletedBooks(entry.completedBooks),
    expandedBooks: {},
  };
}

/** Marks a fully read book complete (once); reports whether it changed. */
export function completeBibleBook(
  prev: BibleTrackerState,
  bookId: string,
  nowISO: string,
): { state: BibleTrackerState; completed: boolean } {
  const normalizedBookId = String(bookId || "");
  if (!normalizedBookId) return { state: prev, completed: false };
  const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
  if (totalChapters <= 0) return { state: prev, completed: false };
  const chaptersRead = prev.progress[normalizedBookId] ?? [];
  if (!Array.isArray(chaptersRead) || chaptersRead.length < totalChapters) return { state: prev, completed: false };
  if (prev.completedBooks?.[normalizedBookId]) return { state: prev, completed: false };
  const nextCompletedBooks = {
    ...prev.completedBooks,
    [normalizedBookId]: { completedAtISO: nowISO },
  };
  const nextExpanded = { ...prev.expandedBooks };
  if (nextExpanded[normalizedBookId]) {
    delete nextExpanded[normalizedBookId];
  }
  return { state: { ...prev, completedBooks: nextCompletedBooks, expandedBooks: nextExpanded }, completed: true };
}

/** Moves a completed book back into the tracker. */
export function restoreBibleBook(prev: BibleTrackerState, bookId: string): BibleTrackerState {
  const normalizedBookId = String(bookId || "");
  if (!normalizedBookId) return prev;
  if (!prev.completedBooks?.[normalizedBookId]) return prev;
  const nextCompletedBooks = { ...prev.completedBooks };
  delete nextCompletedBooks[normalizedBookId];
  return { ...prev, completedBooks: nextCompletedBooks };
}
