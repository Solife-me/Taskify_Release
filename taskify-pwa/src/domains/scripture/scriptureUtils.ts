import type { ScriptureMemoryEntry, ScriptureMemoryState, ScriptureMemoryFrequency, ScriptureMemorySort } from "./scriptureTypes";
import type { Recurrence } from "../tasks/taskTypes";
import { getBibleChapterVerseCount } from "../../data/bibleVerseCounts";
import {
  getBibleBookChapterCount,
  getBibleBookTitle,
} from "../../components/BibleTracker";

export const MAX_SCRIPTURE_STAGE = 8;
export const SCRIPTURE_STAGE_GROWTH = 1.8;
export const SCRIPTURE_INTERVAL_CAP_DAYS = 180;

export const SCRIPTURE_MEMORY_FREQUENCIES: Array<{
  id: ScriptureMemoryFrequency;
  label: string;
  days: number;
  description: string;
}> = [
  { id: "daily", label: "Daily", days: 1, description: "Creates a review task every day." },
  { id: "every2d", label: "Every 2 days", days: 2, description: "Review roughly three to four times per week." },
  { id: "twiceWeek", label: "Twice per week", days: 3, description: "Focus on scripture memory a couple times per week." },
  { id: "weekly", label: "Weekly", days: 7, description: "Schedule one scripture memory task each week." },
];

export const SCRIPTURE_MEMORY_SORTS: Array<{ id: ScriptureMemorySort; label: string }> = [
  { id: "canonical", label: "Canonical order" },
  { id: "oldest", label: "Oldest added" },
  { id: "newest", label: "Newest added" },
  { id: "needsReview", label: "Needs review" },
];

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function latestScriptureReviewISO(entries: ScriptureMemoryEntry[]): string | undefined {
  let latestTime = Number.NEGATIVE_INFINITY;
  let latestISO: string | undefined;
  for (const entry of entries) {
    if (!entry.lastReviewISO) continue;
    const time = new Date(entry.lastReviewISO).getTime();
    if (!Number.isFinite(time)) continue;
    if (time > latestTime) {
      latestTime = time;
      latestISO = new Date(time).toISOString();
    }
  }
  return Number.isFinite(latestTime) && latestTime > Number.NEGATIVE_INFINITY ? latestISO : undefined;
}

export function updateScriptureMemoryState(
  prev: ScriptureMemoryState,
  entries: ScriptureMemoryEntry[],
  overrideLastReview?: string
): ScriptureMemoryState {
  const next: ScriptureMemoryState = { ...prev, entries };
  const normalizedOverride = normalizeIsoTimestamp(overrideLastReview);
  if (normalizedOverride) {
    next.lastReviewISO = normalizedOverride;
  } else {
    next.lastReviewISO = latestScriptureReviewISO(entries);
  }
  if (!next.lastReviewISO) {
    delete (next as { lastReviewISO?: string }).lastReviewISO;
  }
  return next;
}

export function markScriptureEntryReviewed(
  prev: ScriptureMemoryState,
  entryId: string,
  completedAtISO: string,
  stageBefore?: number | null,
): ScriptureMemoryState {
  let changed = false;
  const entries = prev.entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    changed = true;
    const baseStage = typeof stageBefore === "number" ? stageBefore : entry.stage ?? 0;
    const nextStage = Math.min(MAX_SCRIPTURE_STAGE, Math.max(0, baseStage + 1));
    return {
      ...entry,
      stage: nextStage,
      totalReviews: (entry.totalReviews ?? 0) + 1,
      lastReviewISO: completedAtISO,
      scheduledAtISO: undefined,
    };
  });
  if (!changed) return prev;
  return updateScriptureMemoryState(prev, entries, completedAtISO);
}

export function scheduleScriptureEntry(
  prev: ScriptureMemoryState,
  entryId: string,
  scheduledAtISO: string
): ScriptureMemoryState {
  let changed = false;
  const entries = prev.entries.map((entry) => {
    if (entry.id !== entryId) return entry;
    changed = true;
    return { ...entry, scheduledAtISO };
  });
  if (!changed) return prev;
  return updateScriptureMemoryState(prev, entries, prev.lastReviewISO);
}

export function sanitizeScriptureMemoryState(raw: any): ScriptureMemoryState {
  const now = new Date().toISOString();
  if (!raw || typeof raw !== "object") {
    return { entries: [] };
  }
  const entries: ScriptureMemoryEntry[] = Array.isArray((raw as any).entries)
    ? (raw as any).entries
        .map((entry: any) => {
          const bookId = typeof entry?.bookId === "string" ? entry.bookId : "";
          const chapter = Number(entry?.chapter);
          if (!bookId || Number.isNaN(chapter) || chapter <= 0) return null;
          const chapterCount = getBibleBookChapterCount(bookId);
          if (!chapterCount || chapter > chapterCount) return null;
          const verseCount = getBibleChapterVerseCount(bookId, chapter);
          if (!verseCount) return null;
          let startVerse = Number(entry?.startVerse);
          if (!Number.isFinite(startVerse) || startVerse <= 0) startVerse = 1;
          let endVerse = Number(entry?.endVerse);
          if (!Number.isFinite(endVerse) || endVerse <= 0) endVerse = startVerse;
          startVerse = Math.max(1, Math.min(verseCount, Math.floor(startVerse)));
          endVerse = Math.max(startVerse, Math.min(verseCount, Math.floor(endVerse)));
          const addedAtISO = typeof entry?.addedAtISO === "string" && entry.addedAtISO ? entry.addedAtISO : now;
          const lastReviewISO = typeof entry?.lastReviewISO === "string" && entry.lastReviewISO ? entry.lastReviewISO : undefined;
          const scheduledAtISO = typeof entry?.scheduledAtISO === "string" && entry.scheduledAtISO
            ? entry.scheduledAtISO
            : undefined;
          const stageRaw = Number(entry?.stage);
          const stage = Number.isFinite(stageRaw) && stageRaw >= 0 ? Math.min(Math.floor(stageRaw), MAX_SCRIPTURE_STAGE) : 0;
          const totalReviewsRaw = Number(entry?.totalReviews);
          const totalReviews = Number.isFinite(totalReviewsRaw) && totalReviewsRaw > 0 ? Math.floor(totalReviewsRaw) : 0;
          const id = typeof entry?.id === "string" && entry.id ? entry.id : crypto.randomUUID();
          return {
            id,
            bookId,
            chapter,
            startVerse,
            endVerse,
            addedAtISO,
            lastReviewISO,
            scheduledAtISO,
            stage,
            totalReviews,
          } as ScriptureMemoryEntry;
        })
        .filter((entry: ScriptureMemoryEntry | null): entry is ScriptureMemoryEntry => !!entry)
    : [];
  const state = updateScriptureMemoryState({ entries }, entries);
  const persistedLastReview = normalizeIsoTimestamp((raw as any)?.lastReviewISO);
  if (persistedLastReview) {
    state.lastReviewISO = persistedLastReview;
  }
  return state;
}

export function formatScriptureReference(entry: ScriptureMemoryEntry): string {
  const book = getBibleBookTitle(entry.bookId) ?? entry.bookId;
  const verseStart = entry.startVerse ?? null;
  const verseEnd = entry.endVerse ?? null;
  if (verseStart && verseEnd && verseStart !== verseEnd) {
    return `${book} ${entry.chapter}:${verseStart}-${verseEnd}`;
  }
  if (verseStart) {
    return `${book} ${entry.chapter}:${verseStart}`;
  }
  return `${book} ${entry.chapter}`;
}

export function formatDueInLabel(dueInDays: number): string {
  if (!Number.isFinite(dueInDays)) return "Due now";
  if (Math.abs(dueInDays) < 0.5) return "Due now";
  const rounded = Math.round(dueInDays);
  if (rounded === 0) return "Due now";
  const abs = Math.abs(rounded);
  const unit = abs === 1 ? "day" : "days";
  if (rounded > 0) return `Due in ${abs} ${unit}`;
  return `Overdue by ${abs} ${unit}`;
}

export function computeScriptureIntervalDays(entry: ScriptureMemoryEntry, baseDays: number, totalEntries: number): number {
  const entryCountFactor = Math.max(1, Math.log2(totalEntries + 1));
  const normalizedBase = Math.max(0.5, baseDays / entryCountFactor);
  const stageFactor = Math.pow(SCRIPTURE_STAGE_GROWTH, Math.max(0, entry.stage || 0));
  const interval = normalizedBase * stageFactor;
  return Math.min(interval, SCRIPTURE_INTERVAL_CAP_DAYS);
}

export function computeScriptureStats(
  entry: ScriptureMemoryEntry,
  baseDays: number,
  totalEntries: number,
  now: Date
): {
  intervalDays: number;
  daysSinceReview: number;
  score: number;
  dueInDays: number;
  dueNow: boolean;
} {
  const intervalDays = computeScriptureIntervalDays(entry, baseDays, totalEntries);
  const lastReview = entry.lastReviewISO ? new Date(entry.lastReviewISO) : null;
  let daysSinceReview = lastReview ? (now.getTime() - lastReview.getTime()) / 86400000 : Infinity;
  if (!Number.isFinite(daysSinceReview)) daysSinceReview = Infinity;
  const score = !lastReview ? Number.POSITIVE_INFINITY : daysSinceReview / Math.max(intervalDays, 0.5);
  const dueInDays = !lastReview ? 0 : intervalDays - daysSinceReview;
  const dueNow = !lastReview || daysSinceReview >= intervalDays * 0.95;
  return { intervalDays, daysSinceReview, score, dueInDays, dueNow };
}

export function scriptureFrequencyToRecurrence(baseDays: number): Recurrence {
  const normalized = Math.max(1, Math.round(baseDays));
  if (normalized <= 1) return { type: "daily" };
  return { type: "every", n: normalized, unit: "day" };
}

export function recurrencesEqual(a: Recurrence | undefined, b: Recurrence | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function chooseNextScriptureEntry(
  entries: ScriptureMemoryEntry[],
  baseDays: number,
  now: Date
): { entry: ScriptureMemoryEntry; stats: ReturnType<typeof computeScriptureStats> } | null {
  if (!entries.length) return null;
  const total = entries.length;
  let best: { entry: ScriptureMemoryEntry; stats: ReturnType<typeof computeScriptureStats> } | null = null;
  for (const entry of entries) {
    const stats = computeScriptureStats(entry, baseDays, total, now);
    if (!entry.lastReviewISO) {
      return { entry, stats };
    }
    if (!best || stats.score > best.stats.score) {
      best = { entry, stats };
    }
  }
  if (!best) return null;
  return best;
}
