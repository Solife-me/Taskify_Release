import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getBibleChapterVerseCount, MAX_VERSES_IN_ANY_CHAPTER } from "../data/bibleVerseCounts";

export const BIBLE_BOOKS: Array<{ id: string; name: string; chapters: number }> = [
  { id: "gen", name: "Genesis", chapters: 50 },
  { id: "exo", name: "Exodus", chapters: 40 },
  { id: "lev", name: "Leviticus", chapters: 27 },
  { id: "num", name: "Numbers", chapters: 36 },
  { id: "deu", name: "Deuteronomy", chapters: 34 },
  { id: "jos", name: "Joshua", chapters: 24 },
  { id: "jdg", name: "Judges", chapters: 21 },
  { id: "rut", name: "Ruth", chapters: 4 },
  { id: "1sa", name: "1 Samuel", chapters: 31 },
  { id: "2sa", name: "2 Samuel", chapters: 24 },
  { id: "1ki", name: "1 Kings", chapters: 22 },
  { id: "2ki", name: "2 Kings", chapters: 25 },
  { id: "1ch", name: "1 Chronicles", chapters: 29 },
  { id: "2ch", name: "2 Chronicles", chapters: 36 },
  { id: "ezr", name: "Ezra", chapters: 10 },
  { id: "neh", name: "Nehemiah", chapters: 13 },
  { id: "est", name: "Esther", chapters: 10 },
  { id: "job", name: "Job", chapters: 42 },
  { id: "psa", name: "Psalms", chapters: 150 },
  { id: "pro", name: "Proverbs", chapters: 31 },
  { id: "ecc", name: "Ecclesiastes", chapters: 12 },
  { id: "sng", name: "Song of Songs", chapters: 8 },
  { id: "isa", name: "Isaiah", chapters: 66 },
  { id: "jer", name: "Jeremiah", chapters: 52 },
  { id: "lam", name: "Lamentations", chapters: 5 },
  { id: "eze", name: "Ezekiel", chapters: 48 },
  { id: "dan", name: "Daniel", chapters: 12 },
  { id: "hos", name: "Hosea", chapters: 14 },
  { id: "joe", name: "Joel", chapters: 3 },
  { id: "amo", name: "Amos", chapters: 9 },
  { id: "oba", name: "Obadiah", chapters: 1 },
  { id: "jon", name: "Jonah", chapters: 4 },
  { id: "mic", name: "Micah", chapters: 7 },
  { id: "nah", name: "Nahum", chapters: 3 },
  { id: "hab", name: "Habakkuk", chapters: 3 },
  { id: "zep", name: "Zephaniah", chapters: 3 },
  { id: "hag", name: "Haggai", chapters: 2 },
  { id: "zec", name: "Zechariah", chapters: 14 },
  { id: "mal", name: "Malachi", chapters: 4 },
  { id: "mat", name: "Matthew", chapters: 28 },
  { id: "mar", name: "Mark", chapters: 16 },
  { id: "luk", name: "Luke", chapters: 24 },
  { id: "jhn", name: "John", chapters: 21 },
  { id: "act", name: "Acts", chapters: 28 },
  { id: "rom", name: "Romans", chapters: 16 },
  { id: "1co", name: "1 Corinthians", chapters: 16 },
  { id: "2co", name: "2 Corinthians", chapters: 13 },
  { id: "gal", name: "Galatians", chapters: 6 },
  { id: "eph", name: "Ephesians", chapters: 6 },
  { id: "php", name: "Philippians", chapters: 4 },
  { id: "col", name: "Colossians", chapters: 4 },
  { id: "1th", name: "1 Thessalonians", chapters: 5 },
  { id: "2th", name: "2 Thessalonians", chapters: 3 },
  { id: "1ti", name: "1 Timothy", chapters: 6 },
  { id: "2ti", name: "2 Timothy", chapters: 4 },
  { id: "tit", name: "Titus", chapters: 3 },
  { id: "phm", name: "Philemon", chapters: 1 },
  { id: "heb", name: "Hebrews", chapters: 13 },
  { id: "jas", name: "James", chapters: 5 },
  { id: "1pe", name: "1 Peter", chapters: 5 },
  { id: "2pe", name: "2 Peter", chapters: 3 },
  { id: "1jn", name: "1 John", chapters: 5 },
  { id: "2jn", name: "2 John", chapters: 1 },
  { id: "3jn", name: "3 John", chapters: 1 },
  { id: "jud", name: "Jude", chapters: 1 },
  { id: "rev", name: "Revelation", chapters: 22 },
];

const OLD_TESTAMENT_BOOKS = BIBLE_BOOKS.slice(0, 39);
const NEW_TESTAMENT_BOOKS = BIBLE_BOOKS.slice(39);

const BOOK_INDEX = new Map(BIBLE_BOOKS.map((book) => [book.id, book] as const));
const BOOK_ORDER = new Map(BIBLE_BOOKS.map((book, index) => [book.id, index] as const));
const VALID_BOOK_IDS = new Set(BIBLE_BOOKS.map((book) => book.id));

export const TOTAL_BIBLE_CHAPTERS = BIBLE_BOOKS.reduce((sum, book) => sum + book.chapters, 0);

export type BibleTrackerProgress = Record<string, number[]>;
export type BibleTrackerVerses = Record<string, Record<number, number[]>>;
export type BibleTrackerVerseCounts = Record<string, Record<number, number>>;

export type BibleTrackerCompletedBooks = Record<string, { completedAtISO: string }>;

export type BibleTrackerArchiveEntry = {
  id: string;
  savedAtISO: string;
  lastResetISO: string;
  progress: BibleTrackerProgress;
  verses: BibleTrackerVerses;
  verseCounts: BibleTrackerVerseCounts;
  completedBooks: BibleTrackerCompletedBooks;
};

export type BibleTrackerState = {
  lastResetISO: string;
  progress: BibleTrackerProgress;
  archive: BibleTrackerArchiveEntry[];
  expandedBooks: Record<string, boolean>;
  verses: BibleTrackerVerses;
  verseCounts: BibleTrackerVerseCounts;
  completedBooks: BibleTrackerCompletedBooks;
};

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

const DEFAULT_VERSE_COUNT = 50;
export const MAX_VERSE_COUNT = MAX_VERSES_IN_ANY_CHAPTER;
const LONG_PRESS_DURATION_MS = 450;

export function getBibleBookChapterCount(bookId: string): number | undefined {
  return BOOK_INDEX.get(bookId)?.chapters;
}

export function getBibleBookTitle(bookId: string): string | undefined {
  return BOOK_INDEX.get(bookId)?.name;
}

export function getBibleBookOrder(bookId: string): number | undefined {
  return BOOK_ORDER.get(bookId);
}

export function BibleTracker({
  state,
  onToggleBook,
  onToggleChapter,
  onReset,
  onDeleteArchive,
  onRestoreArchive,
  onUpdateChapterVerses,
  onCompleteBook,
}: {
  state: BibleTrackerState;
  onToggleBook: (bookId: string) => void;
  onToggleChapter: (bookId: string, chapter: number) => void;
  onReset: () => void;
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
          <div className="ml-auto flex items-center gap-2 text-sm whitespace-nowrap">
            <div className="text-secondary">{formatPercent(percentComplete)} complete</div>
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

export function cloneBibleProgress(progress: BibleTrackerProgress): BibleTrackerProgress {
  const next: BibleTrackerProgress = {};
  for (const [bookId, chapters] of Object.entries(progress)) {
    if (!Array.isArray(chapters) || chapters.length === 0) continue;
    next[bookId] = [...chapters];
  }
  return next;
}

export function cloneBibleCompletedBooks(completed: BibleTrackerCompletedBooks): BibleTrackerCompletedBooks {
  const next: BibleTrackerCompletedBooks = {};
  for (const [bookId, info] of Object.entries(completed || {})) {
    if (!info || typeof info.completedAtISO !== "string") continue;
    next[bookId] = { completedAtISO: info.completedAtISO };
  }
  return next;
}

export function cloneBibleVerses(verses: BibleTrackerVerses): BibleTrackerVerses {
  const next: BibleTrackerVerses = {};
  for (const [bookId, chapterMap] of Object.entries(verses || {})) {
    if (!chapterMap || typeof chapterMap !== "object") continue;
    const clonedChapters: Record<number, number[]> = {};
    for (const [chapterKey, verseList] of Object.entries(chapterMap)) {
      const numericChapter = Number(chapterKey);
      if (!Number.isFinite(numericChapter)) continue;
      if (!Array.isArray(verseList) || verseList.length === 0) continue;
      clonedChapters[numericChapter] = [...verseList];
    }
    if (Object.keys(clonedChapters).length > 0) {
      next[bookId] = clonedChapters;
    }
  }
  return next;
}

export function cloneBibleVerseCounts(verseCounts: BibleTrackerVerseCounts): BibleTrackerVerseCounts {
  const next: BibleTrackerVerseCounts = {};
  for (const [bookId, chapterMap] of Object.entries(verseCounts || {})) {
    if (!chapterMap || typeof chapterMap !== "object") continue;
    const cloned: Record<number, number> = {};
    for (const [chapterKey, count] of Object.entries(chapterMap)) {
      const numericChapter = Number(chapterKey);
      const numericCount = typeof count === "number" ? count : NaN;
      if (!Number.isFinite(numericChapter) || !Number.isFinite(numericCount)) continue;
      cloned[numericChapter] = numericCount;
    }
    if (Object.keys(cloned).length > 0) {
      next[bookId] = cloned;
    }
  }
  return next;
}

export function sanitizeBibleTrackerState(raw: any): BibleTrackerState {
  const fallback: BibleTrackerState = {
    lastResetISO: new Date().toISOString(),
    progress: {},
    archive: [],
    expandedBooks: {},
    verses: {},
    verseCounts: {},
    completedBooks: {},
  };

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const lastResetISO = typeof raw.lastResetISO === "string" ? raw.lastResetISO : fallback.lastResetISO;
  const progress: BibleTrackerProgress = {};
  if (raw.progress && typeof raw.progress === "object") {
    for (const [bookId, chapters] of Object.entries(raw.progress as Record<string, unknown>)) {
      if (!Array.isArray(chapters)) continue;
      const filtered = chapters
        .map((chapter) => (typeof chapter === "number" ? Math.floor(chapter) : NaN))
        .filter((chapter) => Number.isFinite(chapter) && chapter > 0)
        .sort((a, b) => a - b);
      if (filtered.length > 0) {
        progress[bookId] = Array.from(new Set(filtered));
      }
    }
  }

  const archive: BibleTrackerArchiveEntry[] = Array.isArray(raw.archive)
    ? (raw.archive as unknown[])
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const id = typeof (entry as any).id === "string" ? (entry as any).id : crypto.randomUUID();
          const savedAtISO = typeof (entry as any).savedAtISO === "string"
            ? (entry as any).savedAtISO
            : new Date().toISOString();
          const snapshotResetISO = typeof (entry as any).lastResetISO === "string"
            ? (entry as any).lastResetISO
            : savedAtISO;
          const snapshotState = sanitizeBibleTrackerState({
            lastResetISO: snapshotResetISO,
            progress: (entry as any).progress,
            verses: (entry as any).verses,
            verseCounts: (entry as any).verseCounts,
            archive: [],
            expandedBooks: {},
            completedBooks: (entry as any).completedBooks,
          });
          return {
            id,
            savedAtISO,
            lastResetISO: snapshotResetISO,
            progress: snapshotState.progress,
            verses: snapshotState.verses,
            verseCounts: snapshotState.verseCounts,
            completedBooks: snapshotState.completedBooks,
          };
        })
        .filter((entry): entry is BibleTrackerArchiveEntry => !!entry)
    : [];

  const expandedBooks: Record<string, boolean> = {};
  if (raw.expandedBooks && typeof raw.expandedBooks === "object") {
    for (const [bookId, value] of Object.entries(raw.expandedBooks as Record<string, unknown>)) {
      if (typeof bookId !== "string") continue;
      if (!VALID_BOOK_IDS.has(bookId)) continue;
      if (value) {
        expandedBooks[bookId] = true;
      }
    }
  }

  const verses: BibleTrackerVerses = {};
  if (raw.verses && typeof raw.verses === "object") {
    for (const [bookId, chapterMap] of Object.entries(raw.verses as Record<string, unknown>)) {
      if (typeof bookId !== "string" || !VALID_BOOK_IDS.has(bookId)) continue;
      if (!chapterMap || typeof chapterMap !== "object") continue;
      const normalizedChapters: Record<number, number[]> = {};
      for (const [chapterKey, verseList] of Object.entries(chapterMap as Record<string, unknown>)) {
        const chapterNumber = Number(chapterKey);
        if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) continue;
        if (!Array.isArray(verseList)) continue;
        const maxAllowed = Math.min(
          Math.max(getBibleChapterVerseCount(bookId, chapterNumber) ?? DEFAULT_VERSE_COUNT, 1),
          MAX_VERSE_COUNT
        );
        const normalized = Array.from(
          new Set(
            verseList
              .map((verse) => (typeof verse === "number" ? Math.floor(verse) : NaN))
              .filter((verse) => Number.isFinite(verse) && verse > 0 && verse <= maxAllowed)
          )
        ).sort((a, b) => a - b);
        if (normalized.length > 0) {
          normalizedChapters[chapterNumber] = normalized;
        }
      }
      if (Object.keys(normalizedChapters).length > 0) {
        verses[bookId] = normalizedChapters;
      }
    }
  }

  const verseCounts: BibleTrackerVerseCounts = {};
  const completedBooks: BibleTrackerCompletedBooks = {};
  if (raw.verseCounts && typeof raw.verseCounts === "object") {
    for (const [bookId, chapterMap] of Object.entries(raw.verseCounts as Record<string, unknown>)) {
      if (typeof bookId !== "string" || !VALID_BOOK_IDS.has(bookId)) continue;
      if (!chapterMap || typeof chapterMap !== "object") continue;
      const normalizedCounts: Record<number, number> = {};
      for (const [chapterKey, value] of Object.entries(chapterMap as Record<string, unknown>)) {
        const chapterNumber = Number(chapterKey);
        const numericValue = typeof value === "number" ? Math.floor(value) : NaN;
        if (!Number.isFinite(chapterNumber) || chapterNumber <= 0) continue;
        if (!Number.isFinite(numericValue) || numericValue <= 0) continue;
        const limit = Math.min(
          Math.max(getBibleChapterVerseCount(bookId, chapterNumber) ?? DEFAULT_VERSE_COUNT, 1),
          MAX_VERSE_COUNT
        );
        normalizedCounts[chapterNumber] = Math.min(numericValue, limit);
      }
      if (Object.keys(normalizedCounts).length > 0) {
        verseCounts[bookId] = normalizedCounts;
      }
    }
  }

  if (raw.completedBooks && typeof raw.completedBooks === "object") {
    for (const [bookId, value] of Object.entries(raw.completedBooks as Record<string, unknown>)) {
      if (typeof bookId !== "string" || !VALID_BOOK_IDS.has(bookId)) continue;
      if (!value || typeof value !== "object") continue;
      const completedAtISO = typeof (value as any).completedAtISO === "string" ? (value as any).completedAtISO : null;
      if (!completedAtISO) continue;
      completedBooks[bookId] = { completedAtISO };
    }
  }

  return {
    lastResetISO,
    progress,
    archive,
    expandedBooks,
    verses,
    verseCounts,
    completedBooks,
  };
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
