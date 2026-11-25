export type ScriptureMemoryFrequency = "daily" | "every2d" | "twiceWeek" | "weekly";
export type ScriptureMemorySort = "canonical" | "oldest" | "newest" | "needsReview";

export type ScriptureMemoryEntry = {
  id: string;
  bookId: string;
  chapter: number;
  startVerse: number | null;
  endVerse: number | null;
  addedAtISO: string;
  lastReviewISO?: string;
  scheduledAtISO?: string;
  stage: number;
  totalReviews: number;
  verseText?: { text: string; updatedAtISO: string };
};

export type ScriptureMemoryState = {
  entries: ScriptureMemoryEntry[];
  lastReviewISO?: string;
};
