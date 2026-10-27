import { getBibleChapterVerseCount, MAX_VERSES_IN_ANY_CHAPTER } from "../../data/bibleVerseCounts";

/** The Bible reading tracker's data: books, the stored state and its clean-up. The UI is in components/BibleTracker. */

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

export const DEFAULT_VERSE_COUNT = 50;
export const MAX_VERSE_COUNT = MAX_VERSES_IN_ANY_CHAPTER;

export function getBibleBookChapterCount(bookId: string): number | undefined {
  return BOOK_INDEX.get(bookId)?.chapters;
}

export function getBibleBookTitle(bookId: string): string | undefined {
  return BOOK_INDEX.get(bookId)?.name;
}

export function getBibleBookOrder(bookId: string): number | undefined {
  return BOOK_ORDER.get(bookId);
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
