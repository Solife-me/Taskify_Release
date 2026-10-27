import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getBibleChapterVerseCount } from "../data/bibleVerseCounts";
import {
  BIBLE_BOOKS,
  DEFAULT_VERSE_COUNT,
  MAX_VERSE_COUNT,
  TOTAL_BIBLE_CHAPTERS,
  type BibleTrackerProgress,
  type BibleTrackerState,
} from "../domains/scripture/bibleTrackerModel";

const OLD_TESTAMENT_BOOKS = BIBLE_BOOKS.slice(0, 39);
const NEW_TESTAMENT_BOOKS = BIBLE_BOOKS.slice(39);


const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const PERCENT_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

function countChapters(progress: BibleTrackerProgress): number {
  let total = 0;
  for (const chapters of Object.values(progress)) {
    if (!Array.isArray(chapters)) continue;
    total += chapters.length;
  }
  return total;
}

function formatDate(iso: string): string {
  try {
    return DATE_FORMATTER.format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return PERCENT_FORMATTER.format(0);
  }
  return PERCENT_FORMATTER.format(Math.min(1, Math.max(0, value)));
}

const LONG_PRESS_DURATION_MS = 450;

export function BibleTracker({
  state,
  onToggleBook,
  onToggleChapter,
  onReset,
  onOpenPrint,
  onOpenScan,
  onDeleteArchive,
  onRestoreArchive,
  onUpdateChapterVerses,
  onCompleteBook,
}: {
  state: BibleTrackerState;
  onToggleBook: (bookId: string) => void;
  onToggleChapter: (bookId: string, chapter: number) => void;
  onReset: () => void;
  onOpenPrint: () => void;
  onOpenScan: () => void;
  onDeleteArchive: (id: string) => void;
  onRestoreArchive: (id: string) => void;
  onUpdateChapterVerses: (
    bookId: string,
    chapter: number,
    verses: number[],
    verseCount: number
  ) => void;
  onCompleteBook: (bookId: string, rect?: DOMRect | null) => void;
}) {
  const totalRead = useMemo(() => countChapters(state.progress), [state.progress]);
  const percentComplete = totalRead / TOTAL_BIBLE_CHAPTERS;
  const expandedBooks = state.expandedBooks || {};
  const completedBooks = state.completedBooks || {};
  const [expandedArchiveEntries, setExpandedArchiveEntries] = useState<Record<string, boolean>>({});
  const [verseEditor, setVerseEditor] = useState<{ bookId: string; chapter: number } | null>(null);
  const holdStateRef = useRef<
    | {
        bookId: string;
        chapter: number;
        timer: number | null;
        pointerId: number | null;
      }
    | null
  >(null);
  const preventClickRef = useRef(false);

  const clearHoldState = useCallback((shouldResetPreventClick = false) => {
    const state = holdStateRef.current;
    if (state?.timer != null) {
      window.clearTimeout(state.timer);
    }
    holdStateRef.current = null;
    if (shouldResetPreventClick) {
      preventClickRef.current = false;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearHoldState(true);
    };
  }, [clearHoldState]);

  useEffect(() => {
    setExpandedArchiveEntries((prev) => {
      const validIds = new Set(state.archive.map((entry) => entry.id));
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, value] of Object.entries(prev)) {
        if (value && validIds.has(id)) {
          next[id] = true;
        } else if (value) {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state.archive]);

  const toggleArchiveEntry = (id: string) => {
    setExpandedArchiveEntries((prev) => {
      const next = { ...prev };
      const wasExpanded = !!next[id];
      if (wasExpanded) {
        delete next[id];
      } else {
        next[id] = true;
      }
      return next;
    });
  };

  const openVerseEditor = useCallback((bookId: string, chapter: number) => {
    if (typeof window !== "undefined") {
      const selection = window.getSelection?.();
      if (selection) {
        if (typeof selection.removeAllRanges === "function") {
          selection.removeAllRanges();
        } else if (typeof (selection as { empty?: () => void }).empty === "function") {
          (selection as { empty?: () => void }).empty?.();
        }
      }
    }
    if (typeof document !== "undefined") {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && typeof activeElement.blur === "function") {
        activeElement.blur();
      }
    }
    setVerseEditor({ bookId, chapter });
  }, []);

  const handleChapterPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, bookId: string, chapter: number) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      preventClickRef.current = false;
      const previous = holdStateRef.current;
      if (previous?.timer != null) {
        window.clearTimeout(previous.timer);
      }
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : null;
      const timer = window.setTimeout(() => {
        openVerseEditor(bookId, chapter);
        holdStateRef.current = {
          bookId,
          chapter,
          timer: null,
          pointerId,
        };
        preventClickRef.current = true;
      }, LONG_PRESS_DURATION_MS);
      holdStateRef.current = {
        bookId,
        chapter,
        timer,
        pointerId,
      };
    },
    [openVerseEditor]
  );

  const handleChapterPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, bookId: string, chapter: number) => {
      const state = holdStateRef.current;
      if (!state) return;
      if (state.bookId !== bookId || state.chapter !== chapter) return;
      if (state.pointerId != null && state.pointerId !== event.pointerId) return;
      clearHoldState();
    },
    [clearHoldState]
  );

  const handleChapterPointerLeave = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, bookId: string, chapter: number) => {
      const state = holdStateRef.current;
      if (!state) return;
      if (state.bookId !== bookId || state.chapter !== chapter) return;
      if (state.pointerId != null && state.pointerId !== event.pointerId) return;
      clearHoldState(true);
    },
    [clearHoldState]
  );

  const handleChapterPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const state = holdStateRef.current;
      if (!state) return;
      if (state.pointerId != null && state.pointerId !== event.pointerId) return;
      clearHoldState(true);
    },
    [clearHoldState]
  );

  const handleChapterClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>, bookId: string, chapter: number) => {
      if (preventClickRef.current) {
        preventClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onToggleChapter(bookId, chapter);
    },
    [onToggleChapter]
  );

  const dismissVerseEditor = useCallback(() => {
    setVerseEditor(null);
  }, []);

  const currentEditorBook = verseEditor
    ? BIBLE_BOOKS.find((book) => book.id === verseEditor.bookId)
    : undefined;

  const currentEditorVerses = verseEditor
    ? state.verses?.[verseEditor.bookId]?.[verseEditor.chapter] || []
    : [];
  const currentEditorVerseCount = verseEditor
    ? state.verseCounts?.[verseEditor.bookId]?.[verseEditor.chapter]
    : undefined;
  const chapterVerseCount = verseEditor
    ? getBibleChapterVerseCount(verseEditor.bookId, verseEditor.chapter) || undefined
    : undefined;
  const editorChapterIsComplete = verseEditor
    ? (state.progress[verseEditor.bookId] || []).includes(verseEditor.chapter)
    : false;
  const inferredVerseCount = (() => {
    if (!verseEditor) return DEFAULT_VERSE_COUNT;
    const fallbackCount = chapterVerseCount && chapterVerseCount > 0 ? chapterVerseCount : DEFAULT_VERSE_COUNT;
    const stored = currentEditorVerseCount;
    if (stored && stored > 0) return stored;
    if (currentEditorVerses.length > 0) {
      return Math.max(fallbackCount, currentEditorVerses[currentEditorVerses.length - 1]);
    }
    return fallbackCount;
  })();

  const canRenderPortal = typeof document !== "undefined";
  const maxVerseCountForEditor = Math.min(
    Math.max(chapterVerseCount ?? DEFAULT_VERSE_COUNT, 1),
    MAX_VERSE_COUNT
  );
  const defaultFullSelectionLength = currentEditorVerseCount && currentEditorVerseCount > 0
    ? currentEditorVerseCount
    : chapterVerseCount && chapterVerseCount > 0
      ? chapterVerseCount
      : maxVerseCountForEditor;

  return (
    <div className="space-y-6">
      <section className="glass-panel p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold leading-tight">Bible reading tracker</h2>
            <p className="text-sm text-secondary leading-snug">
              {totalRead} of {TOTAL_BIBLE_CHAPTERS} chapters read · since {formatDate(state.lastResetISO)}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
            <div className="text-secondary">{formatPercent(percentComplete)} complete</div>
            <button className="ghost-button button-sm pressable" onClick={onOpenPrint}>
              Print sheet
            </button>
            <button className="ghost-button button-sm pressable" onClick={onOpenScan}>
              Scan sheet
            </button>
            <button className="ghost-button button-sm pressable" onClick={onReset}>
              Reset progress
            </button>
          </div>
        </div>
      </section>

      <section className="flex flex-wrap gap-4">
        {[
          { id: "old", title: "Old Testament", books: OLD_TESTAMENT_BOOKS },
          { id: "new", title: "New Testament", books: NEW_TESTAMENT_BOOKS },
        ].map((column) => (
          <div key={column.id} className="flex w-[320px] max-w-full shrink-0 flex-col">
            <div className="px-1 pb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary">
                {column.title}
              </h3>
            </div>
            <div className="space-y-[0.3rem]">
              {column.books.map((book) => {
                const chaptersRead = state.progress[book.id] || [];
                const readSet = new Set(chaptersRead);
                const expanded = !!expandedBooks[book.id];
                const isBookCompleted = !!completedBooks[book.id];
                if (isBookCompleted) {
                  return null;
                }
                const readyForCompletion = chaptersRead.length === book.chapters;
                return (
                  <article key={book.id} className="surface-panel overflow-hidden">
                    <button
                      type="button"
                      className="bible-book-toggle pressable min-w-0"
                      data-expanded={expanded ? "true" : undefined}
                      aria-expanded={expanded}
                      onClick={() => onToggleBook(book.id)}
                    >
                      <span className="flex-1 min-w-0 break-words text-base font-semibold leading-tight">
                        {book.name}
                      </span>
                      <span className="text-xs uppercase tracking-wide text-secondary">
                        {chaptersRead.length}/{book.chapters} read
                      </span>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="bible-book-toggle__chevron h-4 w-4 text-secondary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {expanded && (
                      <div className="border-t border-[color:var(--surface-border)] px-4 py-3">
                        {readyForCompletion && (
                          <div className="mb-3 flex justify-end">
                            <button
                              type="button"
                              className="accent-button button-sm pressable"
                              onClick={(event) => {
                                const rect = (event.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                onCompleteBook(book.id, rect);
                              }}
                            >
                              Complete book
                            </button>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {Array.from({ length: book.chapters }, (_, idx) => {
                            const chapter = idx + 1;
                            const checked = readSet.has(chapter);
                            const verseSelection = state.verses?.[book.id]?.[chapter] || [];
                            const verseCount = state.verseCounts?.[book.id]?.[chapter];
                            const hasPartialVerses = verseSelection.length > 0 && !checked;
                            const unmatchedCompletedVerses =
                              checked && verseSelection.length > 0 && verseCount != null && verseSelection.length < verseCount;
                            return (
                              <button
                                key={chapter}
                                type="button"
                                className="bible-chapter-button"
                                data-active={checked ? "true" : undefined}
                                data-partial={hasPartialVerses || unmatchedCompletedVerses ? "true" : undefined}
                                aria-pressed={checked}
                                onPointerDown={(event) => handleChapterPointerDown(event, book.id, chapter)}
                                onPointerUp={(event) => handleChapterPointerUp(event, book.id, chapter)}
                                onPointerLeave={(event) => handleChapterPointerLeave(event, book.id, chapter)}
                                onPointerCancel={handleChapterPointerCancel}
                                onClick={(event) => handleChapterClick(event, book.id, chapter)}
                              >
                                {chapter}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="surface-panel overflow-hidden">
        <div className="px-4 py-3">
          <h3 className="text-lg font-semibold">Archive</h3>
        </div>
        {state.archive.length === 0 ? (
          <div className="border-t border-[color:var(--surface-border)] px-4 py-3 text-sm text-secondary">
            Progress snapshots will appear here after you reset.
          </div>
        ) : (
          <ul className="space-y-3 px-4 pb-4">
            {state.archive.map((entry) => {
              const chapters = countChapters(entry.progress);
              const percent = chapters / TOTAL_BIBLE_CHAPTERS;
              const isExpanded = !!expandedArchiveEntries[entry.id];
              const booksWithReading = BIBLE_BOOKS.map((book) => ({
                book,
                chapters: entry.progress[book.id] || [],
              })).filter((item) => item.chapters.length > 0);
              return (
                <li
                  key={entry.id}
                  className="rounded-2xl border border-[color:var(--surface-border)] bg-[color:var(--surface-muted)]"
                >
                  <div className="overflow-hidden">
                    <button
                      type="button"
                      className="bible-archive-toggle pressable"
                      data-expanded={isExpanded ? "true" : undefined}
                      aria-expanded={isExpanded}
                      onClick={() => toggleArchiveEntry(entry.id)}
                    >
                      <div className="min-w-0 flex-1 text-left">
                        <div className="text-sm font-medium">
                          Reset on {formatDate(entry.savedAtISO)} · {chapters} chapters · {formatPercent(percent)}
                        </div>
                        <div className="text-xs text-secondary">
                          Previously tracking since {formatDate(entry.lastResetISO)}
                        </div>
                      </div>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="bible-archive-toggle__chevron h-4 w-4 text-secondary"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    <div className="flex flex-wrap gap-2 border-t border-[color:var(--surface-border)] px-4 py-3">
                      <button
                        type="button"
                        className="ghost-button button-sm pressable"
                        onClick={() => onRestoreArchive(entry.id)}
                      >
                        Restore progress
                      </button>
                      <button
                        type="button"
                        className="ghost-button button-sm pressable text-rose-400"
                        onClick={() => onDeleteArchive(entry.id)}
                      >
                        Delete
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="border-t border-[color:var(--surface-border)] px-4 py-3">
                        {booksWithReading.length === 0 ? (
                          <p className="text-sm text-secondary">No chapters were recorded in this snapshot.</p>
                        ) : (
                          <div className="space-y-4">
                            {booksWithReading.map(({ book, chapters: snapshotChapters }) => (
                              <div key={book.id} className="space-y-2">
                                <div className="flex items-center gap-3">
                                  <div className="text-sm font-medium">{book.name}</div>
                                  <div className="ml-auto text-xs uppercase tracking-wide text-secondary">
                                    {snapshotChapters.length}/{book.chapters} read
                                  </div>
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {snapshotChapters.map((chapter) => (
                                    <span key={chapter} className="bible-chapter-pill">
                                      {chapter}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {verseEditor && currentEditorBook && canRenderPortal &&
        createPortal(
          <VerseSelectionDialog
            key={`${verseEditor.bookId}:${verseEditor.chapter}`}
            open
            bookName={currentEditorBook.name}
            chapter={verseEditor.chapter}
            initialVerses={editorChapterIsComplete && currentEditorVerses.length === 0
              ? Array.from({ length: defaultFullSelectionLength }, (_, index) => index + 1)
              : currentEditorVerses}
            initialVerseCount={Math.min(Math.max(inferredVerseCount, 1), maxVerseCountForEditor)}
            maxVerseCount={maxVerseCountForEditor}
            onClose={dismissVerseEditor}
            onSave={(verses, verseCount) => {
              onUpdateChapterVerses(verseEditor.bookId, verseEditor.chapter, verses, verseCount);
              dismissVerseEditor();
            }}
          />,
          document.body
        )}
    </div>
  );
}

type VerseSelectionDialogProps = {
  open: boolean;
  bookName: string;
  chapter: number;
  initialVerses: number[];
  initialVerseCount: number;
  maxVerseCount: number;
  onClose: () => void;
  onSave: (verses: number[], verseCount: number) => void;
};

function VerseSelectionDialog({
  open,
  bookName,
  chapter,
  initialVerses,
  initialVerseCount,
  maxVerseCount,
  onClose,
  onSave,
}: VerseSelectionDialogProps) {
  const verseCount = useMemo(
    () => Math.max(1, Math.min(initialVerseCount, maxVerseCount)),
    [initialVerseCount, maxVerseCount]
  );
  const [selectedVerses, setSelectedVerses] = useState<number[]>(() =>
    initialVerses ? [...initialVerses].filter((verse) => verse <= verseCount).sort((a, b) => a - b) : []
  );
  const [rangeAnchor, setRangeAnchor] = useState<number | null>(null);

  useEffect(() => {
    setSelectedVerses(
      initialVerses ? [...initialVerses].filter((verse) => verse <= verseCount).sort((a, b) => a - b) : []
    );
    setRangeAnchor(null);
  }, [initialVerses, verseCount]);

  useEffect(() => {
    if (!open) return;
    if (typeof document === "undefined") return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose]);

  const selectedSet = useMemo(() => new Set(selectedVerses), [selectedVerses]);

  if (!open) return null;

  const toggleSingleVerse = (verse: number) => {
    setSelectedVerses((prev) => {
      const set = new Set(prev);
      if (set.has(verse)) {
        set.delete(verse);
      } else {
        set.add(verse);
      }
      return Array.from(set).sort((a, b) => a - b);
    });
  };

  const applyRange = (start: number, end: number) => {
    const low = Math.max(1, Math.min(start, end));
    const high = Math.min(verseCount, Math.max(start, end));
    const range: number[] = [];
    for (let verse = low; verse <= high; verse += 1) {
      range.push(verse);
    }
    setSelectedVerses((prev) => {
      const set = new Set(prev);
      const shouldSelect = range.some((verse) => !set.has(verse));
      range.forEach((verse) => {
        if (shouldSelect) {
          set.add(verse);
        } else {
          set.delete(verse);
        }
      });
      return Array.from(set).sort((a, b) => a - b);
    });
  };

  const handleVerseClick = (verse: number) => {
    if (rangeAnchor == null) {
      toggleSingleVerse(verse);
      setRangeAnchor(verse);
      return;
    }
    if (rangeAnchor === verse) {
      toggleSingleVerse(verse);
      return;
    }
    applyRange(rangeAnchor, verse);
    setRangeAnchor(verse);
  };

  const handleSave = () => {
    const limitedVerses = selectedVerses.filter((verse) => verse >= 1 && verse <= maxVerseCount);
    onSave(limitedVerses.filter((verse) => verse <= verseCount), Math.min(verseCount, maxVerseCount));
  };

  return (
    <div className="verse-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="verse-dialog glass-panel">
        <div className="verse-dialog__header">
          <div className="verse-dialog__title">
            Select verses · {bookName} {chapter}
          </div>
          <button type="button" className="ghost-button button-sm pressable" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="verse-dialog__controls">
          <div className="verse-dialog__actions">
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setSelectedVerses([]);
                setRangeAnchor(null);
              }}
            >
              Clear selection
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                const verses = Array.from({ length: verseCount }, (_, index) => index + 1);
                setSelectedVerses(verses);
                setRangeAnchor(verseCount);
              }}
            >
              Select entire chapter
            </button>
          </div>
        </div>
        <p className="verse-dialog__hint">
          Tap to toggle individual verses. Tap a starting verse and then an ending verse to quickly fill the range in between.
        </p>
        <div className="verse-dialog__grid">
          {Array.from({ length: verseCount }, (_, index) => index + 1).map((verse) => {
            const active = selectedSet.has(verse);
            const isAnchor = rangeAnchor === verse;
            return (
              <button
                key={verse}
                type="button"
                className="verse-button"
                data-active={active ? "true" : undefined}
                data-anchor={isAnchor ? "true" : undefined}
                onClick={() => handleVerseClick(verse)}
              >
                {verse}
              </button>
            );
          })}
        </div>
        <div className="verse-dialog__footer">
          <button type="button" className="ghost-button button-sm pressable" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="pressable button-sm accent-button" onClick={handleSave}>
            Save selection
          </button>
        </div>
      </div>
    </div>
  );
}
