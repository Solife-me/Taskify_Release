import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { getBibleChapterVerseCount } from "../data/bibleVerseCounts";
import { BIBLE_BOOKS } from "./BibleTracker";

export type ScriptureMemoryListItem = {
  id: string;
  reference: string;
  addedAtISO: string;
  lastReviewISO?: string;
  stage: number;
  totalReviews: number;
  dueLabel: string;
  dueNow: boolean;
};

export type AddScripturePayload = {
  bookId: string;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
};

type ScriptureMemoryCardProps = {
  items: ScriptureMemoryListItem[];
  onAdd: (payload: AddScripturePayload) => void;
  onRemove: (id: string) => void;
  onReview: (id: string) => void;
  boardName?: string;
  frequencyLabel: string;
  sortLabel: string;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type PickerState =
  | { open: false }
  | { open: true; step: "book" }
  | { open: true; step: "chapter"; bookId: string }
  | {
      open: true;
      step: "verses";
      bookId: string;
      chapter: number;
      startVerse: number | null;
      endVerse: number | null;
    };

const DEFAULT_VERSE_COUNT = 50;
const BOOK_GROUPS: Array<{ id: string; label: string; start: number; end: number }> = [
  { id: "ot", label: "Old Testament", start: 0, end: 39 },
  { id: "nt", label: "New Testament", start: 39, end: BIBLE_BOOKS.length },
];

function formatDateLabel(value?: string): string {
  if (!value) return "Not reviewed yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not reviewed yet";
  return `Reviewed ${TIME_FORMATTER.format(date)}`;
}

export function ScriptureMemoryCard({
  items,
  onAdd,
  onRemove,
  onReview,
  boardName,
  frequencyLabel,
  sortLabel,
}: ScriptureMemoryCardProps) {
  const [picker, setPicker] = useState<PickerState>({ open: false });

  const openPicker = useCallback(() => setPicker({ open: true, step: "book" }), []);

  const closePicker = useCallback(() => {
    setPicker({ open: false });
  }, []);

  useEffect(() => {
    if (!picker.open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [picker.open, closePicker]);

  const handleSelectBook = useCallback((bookId: string) => {
    setPicker({ open: true, step: "chapter", bookId });
  }, []);

  const handleSelectChapter = useCallback((chapter: number) => {
    setPicker((prev) => {
      if (!prev.open || prev.step !== "chapter") return prev;
      return { open: true, step: "verses", bookId: prev.bookId, chapter, startVerse: null, endVerse: null };
    });
  }, []);

  const handleBack = useCallback(() => {
    setPicker((prev) => {
      if (!prev.open) return prev;
      if (prev.step === "book") {
        return { open: false };
      }
      if (prev.step === "chapter") {
        return { open: true, step: "book" };
      }
      if (prev.step === "verses") {
        return { open: true, step: "chapter", bookId: prev.bookId };
      }
      return prev;
    });
  }, []);

  const handleSelectVerse = useCallback((verse: number) => {
    setPicker((prev) => {
      if (!prev.open || prev.step !== "verses") return prev;
      const { startVerse, endVerse } = prev;
      if (startVerse == null) {
        return { ...prev, startVerse: verse, endVerse: verse };
      }
      if (startVerse != null && endVerse != null && startVerse !== endVerse) {
        return { ...prev, startVerse: verse, endVerse: verse };
      }
      if (verse === startVerse) {
        return { ...prev, startVerse: null, endVerse: null };
      }
      const low = Math.min(startVerse, verse);
      const high = Math.max(startVerse, verse);
      return { ...prev, startVerse: low, endVerse: high };
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setPicker((prev) => {
      if (!prev.open || prev.step !== "verses") return prev;
      return { ...prev, startVerse: null, endVerse: null };
    });
  }, []);

  const handleSelectChapterRange = useCallback(() => {
    setPicker((prev) => {
      if (!prev.open || prev.step !== "verses") return prev;
      const verseCount = getBibleChapterVerseCount(prev.bookId, prev.chapter) ?? DEFAULT_VERSE_COUNT;
      return { ...prev, startVerse: 1, endVerse: verseCount };
    });
  }, []);

  const handleConfirmSelection = useCallback(() => {
    if (!picker.open || picker.step !== "verses" || picker.startVerse == null) {
      return;
    }
    onAdd({
      bookId: picker.bookId,
      chapter: picker.chapter,
      startVerse: picker.startVerse,
      endVerse: picker.endVerse,
    });
    closePicker();
  }, [onAdd, picker, closePicker]);

  const pickerBook = useMemo(() => {
    if (!picker.open || (picker.step !== "chapter" && picker.step !== "verses")) return null;
    return BIBLE_BOOKS.find((book) => book.id === picker.bookId) ?? null;
  }, [picker]);

  const pickerVerseCount = useMemo(() => {
    if (!picker.open || picker.step !== "verses") return 0;
    const count = getBibleChapterVerseCount(picker.bookId, picker.chapter);
    if (count && count > 0) return count;
    return DEFAULT_VERSE_COUNT;
  }, [picker]);

  const selectionLabel = useMemo(() => {
    if (!picker.open || picker.step !== "verses") return "";
    const bookName = pickerBook?.name ?? picker.bookId;
    if (picker.startVerse == null) {
      return `${bookName} ${picker.chapter}`;
    }
    if (picker.endVerse == null || picker.endVerse === picker.startVerse) {
      return `${bookName} ${picker.chapter}:${picker.startVerse}`;
    }
    return `${bookName} ${picker.chapter}:${picker.startVerse}-${picker.endVerse}`;
  }, [picker, pickerBook]);

  return (
    <div className="surface-panel board-column w-[360px] shrink-0 p-4 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <div>
          <div className="text-lg font-semibold leading-tight">Scripture memory</div>
          <div className="text-xs text-secondary mt-1">
            Tasks appear on {boardName || "your selected board"}. Frequency: {frequencyLabel}. Sorted by {sortLabel}.
          </div>
        </div>
        <button type="button" className="accent-button button-sm pressable" onClick={openPicker}>
          Add
        </button>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-secondary">
          Add scriptures you want to memorize. Taskify will schedule review tasks based on your settings.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => {
            const statusLabel = item.dueNow ? "Needs review" : "Reviewed";
            const statusClass = item.dueNow ? "text-orange-300" : "text-emerald-300";
            return (
              <li key={item.id} className="task-card group relative" data-form="stacked">
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    className="icon-button pressable flex-shrink-0"
                    data-active={item.dueNow ? undefined : "true"}
                    onClick={() => onReview(item.id)}
                    aria-label={`Mark ${item.reference} reviewed`}
                    title={item.dueNow ? "Mark reviewed" : "Reviewed"}
                  >
                    {!item.dueNow ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" className="pointer-events-none">
                        <path
                          d="M20.285 6.707l-10.09 10.09-4.48-4.48"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2.2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    ) : null}
                  </button>
                  <div className="flex-1 min-w-0 space-y-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="task-card__title">{item.reference}</div>
                        <div className={`text-xs font-semibold uppercase tracking-wide ${statusClass}`}>
                          {statusLabel}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="icon-button icon-button--danger pressable flex-shrink-0"
                        onClick={() => onRemove(item.id)}
                        aria-label={`Remove ${item.reference}`}
                        title="Remove"
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-hidden="true"
                        >
                          <path
                            d="M5 7h14M10 7V5h4v2m-6 3l1 9h6l1-9"
                            stroke="currentColor"
                            strokeWidth={1.8}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                    <div className="space-y-1.5 break-words text-xs leading-snug text-secondary">
                      <div>Added {DATE_FORMATTER.format(new Date(item.addedAtISO))}</div>
                      <div>{formatDateLabel(item.lastReviewISO)}</div>
                      <div>{item.dueLabel}</div>
                      <div>
                        Stage {item.stage} • {item.totalReviews} review{item.totalReviews === 1 ? "" : "s"}
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ScripturePickerOverlay
        picker={picker}
        onClose={closePicker}
        onBack={handleBack}
        onSelectBook={handleSelectBook}
        onSelectChapter={handleSelectChapter}
        onSelectVerse={handleSelectVerse}
        onClearSelection={handleClearSelection}
        onSelectFullChapter={handleSelectChapterRange}
        onConfirm={handleConfirmSelection}
        selectionLabel={selectionLabel}
        verseCount={pickerVerseCount}
      />
    </div>
  );
}

type ScripturePickerOverlayProps = {
  picker: PickerState;
  onClose: () => void;
  onBack: () => void;
  onSelectBook: (bookId: string) => void;
  onSelectChapter: (chapter: number) => void;
  onSelectVerse: (verse: number) => void;
  onClearSelection: () => void;
  onSelectFullChapter: () => void;
  onConfirm: () => void;
  selectionLabel: string;
  verseCount: number;
};

function ScripturePickerOverlay({
  picker,
  onClose,
  onBack,
  onSelectBook,
  onSelectChapter,
  onSelectVerse,
  onClearSelection,
  onSelectFullChapter,
  onConfirm,
  selectionLabel,
  verseCount,
}: ScripturePickerOverlayProps) {
  if (!picker.open) return null;
  if (typeof document === "undefined") return null;

  const bookId = picker.step !== "book" ? picker.bookId : null;
  const book = bookId ? BIBLE_BOOKS.find((item) => item.id === bookId) ?? null : null;
  const bookName = book?.name ?? (bookId ?? "");

  let title = "Select book";
  let subtitle = "Choose the book that contains your passage.";
  if (picker.step === "chapter") {
    title = bookName || "Select chapter";
    subtitle = "Pick the chapter you want to memorize.";
  } else if (picker.step === "verses") {
    title = `${bookName} ${picker.chapter}`.trim();
    subtitle = "Select the first and last verse for this passage.";
  }

  const showBackButton = picker.step !== "book";

  return createPortal(
    <div className="verse-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="scripture-picker glass-panel" onClick={(event) => event.stopPropagation()}>
        <div className="scripture-picker__header">
          {showBackButton ? (
            <button type="button" className="ghost-button button-sm pressable" onClick={onBack}>
              Back
            </button>
          ) : (
            <span className="scripture-picker__header-spacer" />
          )}
          <div className="scripture-picker__heading">
            <div className="scripture-picker__title">{title}</div>
            <div className="scripture-picker__subtitle">{subtitle}</div>
          </div>
          <button type="button" className="ghost-button button-sm pressable" onClick={onClose}>
            Close
          </button>
        </div>

        {picker.step === "book" ? (
          <div className="scripture-picker__body">
            {BOOK_GROUPS.map((group) => {
              const books = BIBLE_BOOKS.slice(group.start, group.end);
              return (
                <div key={group.id} className="space-y-2">
                  <div className="scripture-picker__section-label">{group.label}</div>
                  <div className="scripture-picker__list">
                    {books.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="scripture-picker__list-button pressable"
                        onClick={() => onSelectBook(item.id)}
                      >
                        {item.name}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        {picker.step === "chapter" ? (
          <div className="scripture-picker__body">
            <div className="scripture-picker__grid">
              {Array.from({ length: book?.chapters ?? 0 }, (_, index) => index + 1).map((chapter) => (
                <button
                  key={chapter}
                  type="button"
                  className="scripture-picker__grid-button pressable"
                  onClick={() => onSelectChapter(chapter)}
                >
                  {chapter}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {picker.step === "verses" ? (
          <div className="scripture-picker__body scripture-picker__body--verses space-y-4">
            <div className="scripture-picker__verse-scroll">
              <div className="scripture-picker__grid">
                {Array.from({ length: Math.max(verseCount, 1) }, (_, index) => index + 1).map((verse) => {
                  const active = picker.startVerse != null && picker.endVerse != null && verse >= picker.startVerse && verse <= picker.endVerse;
                  const isEdge = active && (verse === picker.startVerse || verse === picker.endVerse);
                  return (
                    <button
                      key={verse}
                      type="button"
                      className="scripture-picker__grid-button pressable"
                      data-active={active ? "true" : undefined}
                      data-edge={isEdge ? "true" : undefined}
                      onClick={() => onSelectVerse(verse)}
                    >
                      {verse}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="scripture-picker__actions">
              <button type="button" className="ghost-button button-sm pressable" onClick={onClearSelection}>
                Clear selected
              </button>
              <button type="button" className="ghost-button button-sm pressable" onClick={onSelectFullChapter}>
                Select entire chapter
              </button>
            </div>
            <button
              type="button"
              className="accent-button pressable w-full"
              onClick={onConfirm}
              disabled={picker.startVerse == null}
            >
              Add {selectionLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

export default ScriptureMemoryCard;
