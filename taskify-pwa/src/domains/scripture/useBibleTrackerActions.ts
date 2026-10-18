/**
 * What the Bible tracker's buttons do: each applies a command from `bibleTrackerCommands` to the
 * tracker store, asking first where the change is hard to undo.
 */
import { useMemo } from "react";
import type { BibleTrackerProgress } from "./bibleTrackerModel";
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
import { bibleTrackerStore } from "./scriptureHook";

function confirmAction(message: string): boolean {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(message);
}

export function useBibleTrackerActions({
  showToast,
  onBookCompleted,
}: {
  showToast: (message: string, durationMs?: number) => void;
  /** A book was marked complete from the element at `rect` (for the fly-to-Completed effect). */
  onBookCompleted?: (rect: DOMRect) => void;
}) {
  return useMemo(() => {
    const store = bibleTrackerStore();
    return {
      toggleBook: (bookId: string) => store.set((prev) => toggleBibleBook(prev, bookId)),
      toggleChapter: (bookId: string, chapter: number) => store.set((prev) => toggleBibleChapter(prev, bookId, chapter)),
      updateChapterVerses: (bookId: string, chapter: number, verses: number[], verseCount: number) =>
        store.set((prev) => setBibleChapterVerses(prev, bookId, chapter, verses, verseCount)),
      applyScan: (scanProgress: BibleTrackerProgress) => {
        if (!scanProgress || Object.keys(scanProgress).length === 0) {
          showToast("No chapters detected in the scan.", 2500);
          return;
        }
        const { state, addedChapters } = applyBibleScan(store.get(), scanProgress);
        store.set(state);
        showToast(
          addedChapters > 0
            ? `Added ${addedChapters} chapter${addedChapters === 1 ? "" : "s"} from scan.`
            : "No new chapters detected.",
          2500,
        );
      },
      reset: () => {
        if (!confirmAction("Reset your Bible reading progress? This archives your current progress and clears the tracker.")) return;
        store.set((prev) => resetBibleTracker(prev, crypto.randomUUID(), new Date().toISOString()));
      },
      deleteArchive: (archiveId: string) => {
        if (!archiveId || !confirmAction("Delete this archived progress snapshot?")) return;
        store.set((prev) => deleteBibleArchive(prev, archiveId));
      },
      restoreArchive: (archiveId: string) => {
        if (!archiveId) return;
        if (!confirmAction("Restore this archived Bible reading progress? This will replace your current progress.")) return;
        store.set((prev) => restoreBibleArchive(prev, archiveId));
      },
      completeBook: (bookId: string, rect?: DOMRect | null) => {
        const { state, completed } = completeBibleBook(store.get(), bookId, new Date().toISOString());
        if (!completed) return;
        store.set(state);
        if (rect) onBookCompleted?.(rect);
      },
      restoreBook: (bookId: string) => store.set((prev) => restoreBibleBook(prev, bookId)),
    };
  }, [onBookCompleted, showToast]);
}
