import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Proof } from "@cashu/cashu-ts";
import { createPortal } from "react-dom";
import { finalizeEvent, getPublicKey, generateSecretKey, type EventTemplate, nip19, nip04 } from "nostr-tools";
const CashuWalletModal = lazy(() => import("./components/CashuWalletModal"));
import {
  BibleTracker,
  type BibleTrackerState,
  sanitizeBibleTrackerState,
  cloneBibleProgress,
  cloneBibleVerses,
  cloneBibleVerseCounts,
  cloneBibleCompletedBooks,
  getBibleBookChapterCount,
  getBibleBookTitle,
  getBibleBookOrder,
  MAX_VERSE_COUNT,
} from "./components/BibleTracker";
import { ScriptureMemoryCard, type AddScripturePayload, type ScriptureMemoryListItem } from "./components/ScriptureMemoryCard";
import { getBibleChapterVerseCount } from "./data/bibleVerseCounts";
import { useCashu } from "./context/CashuContext";
import { LS_LIGHTNING_CONTACTS, LS_BTC_USD_PRICE_CACHE } from "./localStorageKeys";
import { LS_NOSTR_RELAYS, LS_NOSTR_SK } from "./nostrKeys";
import { loadStore as loadProofStore, saveStore as saveProofStore, getActiveMint, setActiveMint } from "./wallet/storage";
import {
  getWalletSeedMnemonic,
  getWalletSeedBackupJson,
  getWalletCountersByMint,
  incrementWalletCounter,
  regenerateWalletSeed,
} from "./wallet/seed";
import { encryptToBoard, decryptFromBoard, boardTag } from "./boardCrypto";
import { useToast } from "./context/ToastContext";
import { useP2PK, type P2PKKey } from "./context/P2PKContext";
import { AccentPalette, BackgroundImageError, normalizeAccentPalette, normalizeAccentPaletteList, prepareBackgroundImage } from "./theme/palette";
import { extractFirstUrl, isUrlLike, useUrlPreview, type UrlPreviewData } from "./lib/urlPreview";
import {
  createDocumentAttachment,
  ensureDocumentPreview,
  loadDocumentPreview,
  isSupportedDocumentFile,
  normalizeDocumentList,
  type TaskDocumentPreview,
  type TaskDocument,
} from "./lib/documents";
import { normalizeNostrPubkey } from "./lib/nostr";
import { DEFAULT_NOSTR_RELAYS } from "./lib/relays";

/* ================= Types ================= */
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun
type DayChoice = Weekday | "bounties" | string; // string = custom list columnId
const WD_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WD_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

type Recurrence =
  | { type: "none"; untilISO?: string }
  | { type: "daily"; untilISO?: string }
  | { type: "weekly"; days: Weekday[]; untilISO?: string }
  | { type: "every"; n: number; unit: "day" | "week"; untilISO?: string }
  | { type: "monthlyDay"; day: number; untilISO?: string };

type Subtask = {
  id: string;
  title: string;
  completed?: boolean;
};

type Task = {
  id: string;
  boardId: string;
  createdBy?: string;             // nostr pubkey of task creator
  title: string;
  note?: string;
  images?: string[];              // base64 data URLs for pasted images
  documents?: TaskDocument[];     // supported document attachments
  dueISO: string;                 // for week board day grouping
  completed?: boolean;
  completedAt?: string;
  completedBy?: string;           // nostr pubkey of user who marked complete
  recurrence?: Recurrence;
  // Week board columns:
  column?: "day" | "bounties";
  // Custom boards (multi-list):
  columnId?: string;
  hiddenUntilISO?: string;        // controls visibility (appear at/after this date)
  order?: number;                 // order within the board for manual reordering
  streak?: number;                // consecutive completion count
  longestStreak?: number;         // highest recorded streak for the series
  seriesId?: string;              // identifier for a recurring series
  subtasks?: Subtask[];           // optional list of subtasks
  bounty?: {
    id: string;                   // bounty id (uuid)
    token: string;                // cashu token string (locked or unlocked)
    amount?: number;              // optional, sats
    mint?: string;                // optional hint
    lock?: "p2pk" | "htlc" | "none" | "unknown";
    owner?: string;               // hex pubkey of task creator (who can unlock)
    sender?: string;              // hex pubkey of funder (who can revoke)
    receiver?: string;            // hex pubkey of intended recipient (who can decrypt nip04)
    state: "locked" | "unlocked" | "revoked" | "claimed";
    updatedAt: string;            // iso
    enc?:
      | {                         // optional encrypted form (hidden until funder reveals)
          alg: "aes-gcm-256";
          iv: string;            // base64
          ct: string;            // base64
        }
      | {
          alg: "nip04";         // encrypted to receiver's nostr pubkey (nip04 format)
          data: string;          // ciphertext returned by nip04.encrypt
      }
      | null;
  };
  dueTimeEnabled?: boolean;       // whether a specific due time is set
  reminders?: ReminderPreset[];   // preset reminder offsets before due time
  scriptureMemoryId?: string;     // reference to scripture memory entry when auto-created
  scriptureMemoryStage?: number;  // stage at time of scheduling (for undo)
  scriptureMemoryPrevReviewISO?: string | null; // previous review timestamp snapshot
  scriptureMemoryScheduledAt?: string; // when this memory task was generated
};

function normalizeBounty(bounty?: Task["bounty"] | null): Task["bounty"] | undefined {
  if (!bounty) return undefined;
  const normalized: Task["bounty"] = { ...bounty };
  const owner = ensureXOnlyHex(normalized.owner);
  if (owner) normalized.owner = owner; else delete normalized.owner;
  const sender = ensureXOnlyHex(normalized.sender);
  if (sender) normalized.sender = sender; else delete normalized.sender;
  const receiver = ensureXOnlyHex(normalized.receiver);
  if (receiver) normalized.receiver = receiver; else delete normalized.receiver;
  const token = typeof normalized.token === "string" ? normalized.token : "";
  const hasToken = token.trim().length > 0;
  const hasCipher = normalized.enc !== undefined && normalized.enc !== null;

  if (normalized.state === "claimed" || normalized.state === "revoked") {
    return normalized;
  }

  if (hasToken && !hasCipher) {
    normalized.state = "unlocked";
    if (!normalized.lock || normalized.lock === "unknown") {
      normalized.lock = "none";
    }
  } else if (hasCipher && !hasToken) {
    normalized.state = "locked";
  } else if (hasToken && hasCipher) {
    normalized.state = "unlocked";
  } else {
    normalized.state = "locked";
  }

  return normalized;
}

function normalizeTaskBounty(task: Task): Task {
  if (!Object.prototype.hasOwnProperty.call(task, "bounty")) {
    return task;
  }
  const clone: Task = { ...task };
  const bounty = (clone as any).bounty as Task["bounty"] | undefined;
  if (!bounty) {
    delete (clone as any).bounty;
    return clone;
  }
  const normalized = normalizeBounty(bounty);
  if (!normalized) {
    delete (clone as any).bounty;
    return clone;
  }
  clone.bounty = normalized;
  return clone;
}

function toXOnlyHex(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (/^(02|03)[0-9a-f]{64}$/.test(hex)) {
    return hex.slice(-64);
  }
  if (/^[0-9a-f]{64}$/.test(hex)) {
    return hex;
  }
  return null;
}

function ensureXOnlyHex(value?: string | null): string | undefined {
  const normalized = toXOnlyHex(value);
  return normalized ?? undefined;
}

function pubkeysEqual(a?: string | null, b?: string | null): boolean {
  const ax = toXOnlyHex(a);
  const bx = toXOnlyHex(b);
  return !!(ax && bx && ax === bx);
}

function bountyStateLabel(bounty: Task["bounty"]): string {
  if (
    bounty.state === "locked" &&
    bounty.lock === "p2pk" &&
    bounty.receiver &&
    typeof window !== "undefined" &&
    pubkeysEqual(bounty.receiver, (window as any).nostrPK)
  ) {
    return "ready to redeem";
  }
  return bounty.state;
}

function mergeLongestStreak(task: Task, streak: number | undefined): number | undefined {
  const previous =
    typeof task.longestStreak === "number"
      ? task.longestStreak
      : typeof task.streak === "number"
        ? task.streak
        : undefined;
  if (typeof streak === "number") {
    return previous === undefined ? streak : Math.max(previous, streak);
  }
  return previous;
}

type BuiltinReminderPreset = "5m" | "15m" | "30m" | "1h" | "1d";
type CustomReminderPreset = `custom-${number}`;
type ReminderPreset = BuiltinReminderPreset | CustomReminderPreset;

type PushPlatform = "ios" | "android";

type PushPreferences = {
  enabled: boolean;
  platform: PushPlatform;
  deviceId?: string;
  subscriptionId?: string;
  permission?: NotificationPermission;
};
type PublishTaskFn = (
  task: Task,
  boardOverride?: Board,
  options?: { skipBoardMetadata?: boolean }
) => Promise<void>;
type ScriptureMemoryUpdate = {
  entryId: string;
  completedAt: string;
  stageBefore?: number;
  nextScheduled?: { entryId: string; scheduledAtISO: string };
};
type CompleteTaskResult = {
  scriptureMemory?: ScriptureMemoryUpdate;
} | null;
type CompleteTaskFn = (
  id: string,
  options?: { skipScriptureMemoryUpdate?: boolean }
) => CompleteTaskResult;

function detectPushPlatformFromNavigator(): PushPlatform {
  if (typeof navigator === 'undefined') return 'ios';
  const ua = typeof navigator.userAgent === 'string' ? navigator.userAgent.toLowerCase() : '';
  const vendor = typeof navigator.vendor === 'string' ? navigator.vendor.toLowerCase() : '';
  const platform = typeof navigator.platform === 'string' ? navigator.platform.toLowerCase() : '';
  const isIosDevice = /\b(iphone|ipad|ipod)\b/.test(ua);
  const isStandalonePwa = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const isSafariBrowser = /safari/.test(ua)
    && !/chrome|crios|fxios|edge|edg\//.test(ua)
    && !/android/.test(ua);
  const isAppleWebkit = vendor.includes('apple');
  if (isIosDevice || (isSafariBrowser && (platform.startsWith('mac') || isAppleWebkit)) || (isAppleWebkit && isStandalonePwa)) {
    return 'ios';
  }
  return 'android';
}

const INFERRED_PUSH_PLATFORM: PushPlatform = detectPushPlatformFromNavigator();

const BUILTIN_REMINDER_PRESETS: ReadonlyArray<{ id: BuiltinReminderPreset; label: string; badge: string; minutes: number }> = [
  { id: "5m", label: "5 minutes before", badge: "5m", minutes: 5 },
  { id: "15m", label: "15 minutes before", badge: "15m", minutes: 15 },
  { id: "30m", label: "30 minutes before", badge: "30m", minutes: 30 },
  { id: "1h", label: "1 hour before", badge: "1h", minutes: 60 },
  { id: "1d", label: "1 day before", badge: "1d", minutes: 1440 },
];

const BUILTIN_REMINDER_IDS = new Set<BuiltinReminderPreset>(BUILTIN_REMINDER_PRESETS.map((opt) => opt.id));
const BUILTIN_REMINDER_MINUTES = new Map<BuiltinReminderPreset, number>(BUILTIN_REMINDER_PRESETS.map((opt) => [opt.id, opt.minutes] as const));

const BIBLE_BOARD_ID = "bible-reading";
const LS_SCRIPTURE_MEMORY = "taskify_scripture_memory_v1";
const SCRIPTURE_MEMORY_SERIES_ID = "scripture-memory";

type ScriptureMemoryFrequency = "daily" | "every2d" | "twiceWeek" | "weekly";
type ScriptureMemorySort = "canonical" | "oldest" | "newest" | "needsReview";

type ScriptureMemoryEntry = {
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
};

type ScriptureMemoryState = {
  entries: ScriptureMemoryEntry[];
  lastReviewISO?: string;
};

const MS_PER_DAY = 86400000;

const MAX_SCRIPTURE_STAGE = 8;
const SCRIPTURE_STAGE_GROWTH = 1.8;
const SCRIPTURE_INTERVAL_CAP_DAYS = 180;

const SCRIPTURE_MEMORY_FREQUENCIES: Array<{
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

const SCRIPTURE_MEMORY_SORTS: Array<{ id: ScriptureMemorySort; label: string }> = [
  { id: "canonical", label: "Canonical order" },
  { id: "oldest", label: "Oldest added" },
  { id: "newest", label: "Newest added" },
  { id: "needsReview", label: "Needs review" },
];

const CUSTOM_REMINDER_PATTERN = /^custom-(\d{1,5})$/;
const MIN_CUSTOM_REMINDER_MINUTES = 1;
const MAX_CUSTOM_REMINDER_MINUTES = 7 * 24 * 60; // one week

function clampCustomReminderMinutes(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_CUSTOM_REMINDER_MINUTES, Math.min(MAX_CUSTOM_REMINDER_MINUTES, Math.round(value)));
}

function minutesToReminderId(minutes: number): ReminderPreset {
  const normalized = clampCustomReminderMinutes(minutes);
  for (const [id, builtinMinutes] of BUILTIN_REMINDER_MINUTES) {
    if (builtinMinutes === normalized) return id;
  }
  return `custom-${normalized}`;
}

function reminderPresetToMinutes(id: ReminderPreset): number {
  if (BUILTIN_REMINDER_IDS.has(id as BuiltinReminderPreset)) {
    return BUILTIN_REMINDER_MINUTES.get(id as BuiltinReminderPreset) ?? 0;
  }
  const match = typeof id === 'string' ? id.match(CUSTOM_REMINDER_PATTERN) : null;
  if (!match) return 0;
  return clampCustomReminderMinutes(parseInt(match[1] ?? '0', 10));
}

function formatReminderLabel(minutes: number): { label: string; badge: string } {
  const mins = clampCustomReminderMinutes(minutes);
  if (mins % 1440 === 0) {
    const days = mins / 1440;
    return {
      label: `${days} day${days === 1 ? '' : 's'} before`,
      badge: `${days}d`,
    };
  }
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return {
      label: `${hours} hour${hours === 1 ? '' : 's'} before`,
      badge: `${hours}h`,
    };
  }
  return {
    label: `${mins} minute${mins === 1 ? '' : 's'} before`,
    badge: `${mins}m`,
  };
}

type ReminderOption = { id: ReminderPreset; label: string; badge: string; minutes: number; builtin: boolean };

function buildReminderOptions(extraPresetIds: ReminderPreset[] = []): ReminderOption[] {
  const options = new Map<ReminderPreset, ReminderOption>();
  for (const preset of BUILTIN_REMINDER_PRESETS) {
    options.set(preset.id, { ...preset, builtin: true });
  }
  for (const id of extraPresetIds) {
    if (options.has(id)) continue;
    const minutes = reminderPresetToMinutes(id);
    if (!minutes) continue;
    const { label, badge } = formatReminderLabel(minutes);
    options.set(id, { id, label, badge, minutes, builtin: !String(id).startsWith('custom-') });
  }
  return [...options.values()].sort((a, b) => a.minutes - b.minutes);
}

function sanitizeReminderList(value: unknown): ReminderPreset[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dedup = new Set<ReminderPreset>();
  for (const item of value) {
    if (typeof item === 'string') {
      if (BUILTIN_REMINDER_IDS.has(item as BuiltinReminderPreset)) {
        dedup.add(item as ReminderPreset);
        continue;
      }
      if (CUSTOM_REMINDER_PATTERN.test(item)) {
        const minutes = reminderPresetToMinutes(item as ReminderPreset);
        if (minutes) dedup.add(minutesToReminderId(minutes));
      }
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      const remId = minutesToReminderId(item);
      const minutes = reminderPresetToMinutes(remId);
      if (minutes) dedup.add(remId);
    }
  }
  const sorted = [...dedup].sort((a, b) => reminderPresetToMinutes(a) - reminderPresetToMinutes(b));
  return sorted;
}

function normalizeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function latestScriptureReviewISO(entries: ScriptureMemoryEntry[]): string | undefined {
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

function updateScriptureMemoryState(
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

function markScriptureEntryReviewed(
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

function scheduleScriptureEntry(
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

function sanitizeScriptureMemoryState(raw: any): ScriptureMemoryState {
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
        .filter((entry): entry is ScriptureMemoryEntry => !!entry)
    : [];
  const state = updateScriptureMemoryState({ entries }, entries);
  const persistedLastReview = normalizeIsoTimestamp((raw as any)?.lastReviewISO);
  if (persistedLastReview) {
    state.lastReviewISO = persistedLastReview;
  }
  return state;
}

function formatScriptureReference(entry: ScriptureMemoryEntry): string {
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

function formatDueInLabel(dueInDays: number): string {
  if (!Number.isFinite(dueInDays)) return "Due now";
  if (Math.abs(dueInDays) < 0.5) return "Due now";
  const rounded = Math.round(dueInDays);
  if (rounded === 0) return "Due now";
  const abs = Math.abs(rounded);
  const unit = abs === 1 ? "day" : "days";
  if (rounded > 0) return `Due in ${abs} ${unit}`;
  return `Overdue by ${abs} ${unit}`;
}

function computeScriptureIntervalDays(entry: ScriptureMemoryEntry, baseDays: number, totalEntries: number): number {
  const entryCountFactor = Math.max(1, Math.log2(totalEntries + 1));
  const normalizedBase = Math.max(0.5, baseDays / entryCountFactor);
  const stageFactor = Math.pow(SCRIPTURE_STAGE_GROWTH, Math.max(0, entry.stage || 0));
  const interval = normalizedBase * stageFactor;
  return Math.min(interval, SCRIPTURE_INTERVAL_CAP_DAYS);
}

function computeScriptureStats(
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

function scriptureFrequencyToRecurrence(baseDays: number): Recurrence {
  const normalized = Math.max(1, Math.round(baseDays));
  if (normalized <= 1) return { type: "daily" };
  return { type: "every", n: normalized, unit: "day" };
}

function recurrencesEqual(a: Recurrence | undefined, b: Recurrence | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function chooseNextScriptureEntry(
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

const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: false,
  platform: INFERRED_PUSH_PLATFORM,
  permission: (typeof Notification !== 'undefined' ? Notification.permission : 'default') as NotificationPermission,
};

const RAW_WORKER_BASE = (import.meta as any)?.env?.VITE_WORKER_BASE_URL || "";
const FALLBACK_WORKER_BASE_URL = RAW_WORKER_BASE ? String(RAW_WORKER_BASE).replace(/\/$/, "") : "";
const FALLBACK_VAPID_PUBLIC_KEY = (import.meta as any)?.env?.VITE_VAPID_PUBLIC_KEY || "";
const RAW_SUPPORT_EMAIL = (((import.meta as any)?.env?.VITE_SUPPORT_EMAIL as string | undefined) || "").trim();
const SUPPORT_CONTACT_EMAIL = RAW_SUPPORT_EMAIL || "<SUPPORT_EMAIL>";
const RAW_DONATION_LIGHTNING_ADDRESS =
  (((import.meta as any)?.env?.VITE_DONATION_LIGHTNING_ADDRESS as string | undefined) || "").trim();
const DONATION_LIGHTNING_ADDRESS =
  RAW_DONATION_LIGHTNING_ADDRESS ||
  (SUPPORT_CONTACT_EMAIL.includes("@") ? SUPPORT_CONTACT_EMAIL : "<LIGHTNING_ADDRESS>");
const RAW_FEEDBACK_BOARD_ID =
  (((import.meta as any)?.env?.VITE_FEEDBACK_BOARD_ID as string | undefined) || "").trim();
const FEEDBACK_BOARD_ID = RAW_FEEDBACK_BOARD_ID || "<FEEDBACK_BOARD_ID>";

function taskHasReminders(task: Task): boolean {
  if (task.completed) return false;
  return !!task.dueTimeEnabled && Array.isArray(task.reminders) && task.reminders.length > 0;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  if (!base64String || typeof base64String !== 'string') {
    throw new Error('VAPID public key is missing.');
  }
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decode = typeof atob === 'function'
    ? atob
    : (() => { throw new Error('No base64 decoder available in this environment'); });
  try {
    const rawData = decode(base64);
    if (!rawData) throw new Error('Decoded key was empty');
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    if (outputArray.length < 32) {
      throw new Error('Decoded key is too short');
    }
    return outputArray;
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(`Invalid VAPID public key: ${err.message}`);
    }
    throw new Error('Invalid VAPID public key.');
  }
}

function isPlaceholderValue(value: string): boolean {
  return !value || value.includes("<") || value.includes(">");
}

type ListColumn = { id: string; name: string };
type CompoundIndexGroup = {
  key: string;
  boardId: string;
  boardName: string;
  columns: { id: string; name: string }[];
};

type BoardBase = {
  id: string;
  name: string;
  // Optional Nostr sharing metadata
  nostr?: { boardId: string; relays: string[] };
  archived?: boolean;
  hidden?: boolean;
  clearCompletedDisabled?: boolean;
};

type CompoundChildId = string;

function parseCompoundChildInput(raw: string): { boardId: string; relays: string[] } {
  const trimmed = raw.trim();
  if (!trimmed) return { boardId: "", relays: [] };
  let boardId = trimmed;
  let relaySegment = "";
  const atIndex = trimmed.indexOf("@");
  if (atIndex >= 0) {
    boardId = trimmed.slice(0, atIndex).trim();
    relaySegment = trimmed.slice(atIndex + 1).trim();
  } else {
    const spaceIndex = trimmed.search(/\s/);
    if (spaceIndex >= 0) {
      boardId = trimmed.slice(0, spaceIndex).trim();
      relaySegment = trimmed.slice(spaceIndex + 1).trim();
    }
  }
  const relays = relaySegment
    ? relaySegment.split(/[\s,]+/).map((relay) => relay.trim()).filter(Boolean)
    : [];
  return { boardId, relays };
}

type Board =
  | (BoardBase & { kind: "week" }) // fixed Sun–Sat + Bounties
  | (BoardBase & { kind: "lists"; columns: ListColumn[]; indexCardEnabled?: boolean }) // multiple customizable columns
  | (BoardBase & {
      kind: "compound";
      children: CompoundChildId[];
      indexCardEnabled?: boolean;
      hideChildBoardNames?: boolean;
    })
  | (BoardBase & { kind: "bible" });

type ListLikeBoard = Extract<Board, { kind: "lists" | "compound" }>;

function isListLikeBoard(board: Board | null | undefined): board is ListLikeBoard {
  return !!board && (board.kind === "lists" || board.kind === "compound");
}

function compoundColumnKey(boardId: string, columnId: string): string {
  return `${boardId}::${columnId}`;
}

function boardScopeIds(board: Board, boards: Board[]): string[] {
  const ids = new Set<string>();
  const addId = (value?: string | null) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  const addBoard = (target: Board | undefined) => {
    if (!target) return;
    addId(target.id);
    addId(target.nostr?.boardId);
  };

  addBoard(board);

  if (board.kind === "compound") {
    board.children.forEach((childId) => {
      addId(childId);
      addBoard(findBoardByCompoundChildId(boards, childId));
    });
  }

  return Array.from(ids);
}

function findBoardByCompoundChildId(boards: Board[], childId: string): Board | undefined {
  return boards.find((board) => {
    if (board.id === childId) return true;
    return !!board.nostr?.boardId && board.nostr.boardId === childId;
  });
}

function compoundChildMatchesBoard(childId: string, board: Board): boolean {
  return childId === board.id || (!!board.nostr?.boardId && childId === board.nostr.boardId);
}

function normalizeCompoundChildId(boards: Board[], childId: string): string {
  const match = findBoardByCompoundChildId(boards, childId);
  return match ? match.id : childId;
}

type Settings = {
  weekStart: Weekday; // 0=Sun, 1=Mon, 6=Sat
  newTaskPosition: "top" | "bottom";
  streaksEnabled: boolean;
  completedTab: boolean;
  bibleTrackerEnabled: boolean;
  scriptureMemoryEnabled: boolean;
  scriptureMemoryBoardId?: string | null;
  scriptureMemoryFrequency: ScriptureMemoryFrequency;
  scriptureMemorySort: ScriptureMemorySort;
  showFullWeekRecurring: boolean;
  // Add tasks via per-column boxes instead of global add bar
  inlineAdd: boolean;
  // Allow adding new lists from within the board view
  listAddButtonEnabled: boolean;
  // Base UI font size in pixels; null uses the OS preferred size
  baseFontSize: number | null;
  startBoardByDay: Partial<Record<Weekday, string>>;
  accent: "green" | "blue" | "background";
  backgroundImage?: string | null;
  backgroundAccent?: AccentPalette | null;
  backgroundAccents?: AccentPalette[] | null;
  backgroundAccentIndex?: number | null;
  backgroundBlur: "blurred" | "sharp";
  hideCompletedSubtasks: boolean;
  startupView: "main" | "wallet";
  walletConversionEnabled: boolean;
  walletPrimaryCurrency: "sat" | "usd";
  walletSentStateChecksEnabled: boolean;
  walletPaymentRequestsEnabled: boolean;
  walletPaymentRequestsBackgroundChecksEnabled: boolean;
  npubCashLightningAddressEnabled: boolean;
  npubCashAutoClaim: boolean;
  cloudBackupsEnabled: boolean;
  pushNotifications: PushPreferences;
};

type AccentChoice = {
  id: "blue" | "green";
  label: string;
  fill: string;
  ring: string;
  border: string;
  borderActive: string;
  shadow: string;
  shadowActive: string;
};

const ACCENT_CHOICES: AccentChoice[] = [
  {
    id: "blue",
    label: "iMessage blue",
    fill: "#0a84ff",
    ring: "rgba(64, 156, 255, 0.32)",
    border: "rgba(64, 156, 255, 0.38)",
    borderActive: "rgba(64, 156, 255, 0.88)",
    shadow: "0 12px 26px rgba(10, 132, 255, 0.32)",
    shadowActive: "0 18px 34px rgba(10, 132, 255, 0.42)",
  },
  {
    id: "green",
    label: "Mint green",
    fill: "#34c759",
    ring: "rgba(52, 199, 89, 0.28)",
    border: "rgba(52, 199, 89, 0.36)",
    borderActive: "rgba(52, 199, 89, 0.86)",
    shadow: "0 12px 24px rgba(52, 199, 89, 0.28)",
    shadowActive: "0 18px 32px rgba(52, 199, 89, 0.38)",
  },
];

const CUSTOM_ACCENT_VARIABLES: ReadonlyArray<[string, keyof AccentPalette]> = [
  ["--accent", "fill"],
  ["--accent-hover", "hover"],
  ["--accent-active", "active"],
  ["--accent-soft", "soft"],
  ["--accent-border", "border"],
  ["--accent-on", "on"],
  ["--accent-glow", "glow"],
];

function gradientFromPalette(palette: AccentPalette, hasImage: boolean): string {
  const primary = hexToRgba(palette.fill, 0.24);
  const secondary = hexToRgba(palette.fill, 0.14);
  const baseAlpha = hasImage ? 0.65 : 0.95;
  return `radial-gradient(circle at 18% -10%, ${primary}, transparent 60%),` +
    `radial-gradient(circle at 82% -12%, ${secondary}, transparent 65%),` +
    `rgba(6, 9, 18, ${baseAlpha})`;
}

function hexToRgba(hex: string, alpha: number): string {
  let value = hex.replace(/^#/, "");
  if (value.length === 3) {
    value = value.split("").map(ch => ch + ch).join("");
  }
  const int = parseInt(value.slice(0, 6), 16);
  if (Number.isNaN(int)) {
    return `rgba(52, 199, 89, ${Math.min(1, Math.max(0, alpha))})`;
  }
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  const clampedAlpha = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clampedAlpha})`;
}

function isSameLocalDate(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

const R_NONE: Recurrence = { type: "none" };
const LS_TASKS = "taskify_tasks_v5";
const LS_TASKS_LEGACY = ["taskify_tasks_v4"] as const;
const LS_SETTINGS = "taskify_settings_v2";
const LS_BOARDS = "taskify_boards_v2";
const LS_TUTORIAL_DONE = "taskify_tutorial_done_v1";
const LS_BIBLE_TRACKER = "taskify_bible_tracker_v1";
const LS_LAST_CLOUD_BACKUP = "taskify_cloud_backup_last_v1";
const LS_LAST_MANUAL_CLOUD_BACKUP = "taskify_cloud_backup_manual_last_v1";
const CLOUD_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MANUAL_CLOUD_BACKUP_INTERVAL_MS = 60 * 1000;
const SATS_PER_BTC = 100_000_000;

type TaskifyBackupPayload = {
  tasks: unknown;
  boards: unknown;
  settings: unknown;
  scriptureMemory: unknown;
  bibleTracker: unknown;
  defaultRelays: unknown;
  contacts: unknown;
  nostrSk: string;
  cashu: {
    proofs: unknown;
    activeMint: string | null;
    history: unknown;
  };
};

type WalletHistoryLogEntry = {
  id?: string;
  summary: string;
  type: "lightning" | "ecash";
  direction: "in" | "out";
  amountSat?: number;
  detail?: string;
  detailKind?: "token" | "invoice" | "note";
  mintUrl?: string;
  feeSat?: number;
};

function readWalletConversionsEnabled(fallback?: boolean): boolean {
  if (typeof fallback === "boolean") return fallback;
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed?.walletConversionEnabled !== false;
  } catch {
    return true;
  }
}

function readCachedUsdPrice(): number | null {
  try {
    const raw = localStorage.getItem(LS_BTC_USD_PRICE_CACHE);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const price = Number(parsed?.price);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

function captureHistoryFiatValue(amountSat?: number | null, conversionsEnabled?: boolean): number | undefined {
  if (!conversionsEnabled || amountSat == null || !Number.isFinite(amountSat) || amountSat <= 0) {
    return undefined;
  }
  const cachedPrice = readCachedUsdPrice();
  if (cachedPrice == null || cachedPrice <= 0) return undefined;
  const usdValue = (amountSat / SATS_PER_BTC) * cachedPrice;
  return Number.isFinite(usdValue) ? Number(usdValue.toFixed(2)) : undefined;
}

function appendWalletHistoryEntry(entry: WalletHistoryLogEntry, options?: { conversionsEnabled?: boolean }) {
  try {
    const conversionsEnabled = readWalletConversionsEnabled(options?.conversionsEnabled);
    const raw = localStorage.getItem("cashuHistory");
    const existing = raw ? JSON.parse(raw) : [];
    const createdAt = Date.now();
    const fiatValueUsd = captureHistoryFiatValue(entry.amountSat, conversionsEnabled);
    const normalized = {
      id: entry.id ?? `${entry.type}-${createdAt}`,
      summary: entry.summary,
      type: entry.type,
      direction: entry.direction,
      amountSat: entry.amountSat,
      detail: entry.detail,
      detailKind: entry.detailKind,
      mintUrl: entry.mintUrl,
      feeSat: entry.feeSat,
      createdAt,
      fiatValueUsd,
    };
    const next = Array.isArray(existing) ? [normalized, ...existing] : [normalized];
    localStorage.setItem("cashuHistory", JSON.stringify(next));
  } catch (error) {
    console.warn("Failed to append wallet history entry", error);
  }
}

/* ================= Nostr minimal client ================= */
type NostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

type NostrUnsignedEvent = Omit<NostrEvent, "id" | "sig" | "pubkey"> & {
  pubkey?: string;
};

declare global {
  interface Window {
    nostr?: {
      getPublicKey: () => Promise<string>;
      signEvent: (e: NostrUnsignedEvent) => Promise<NostrEvent>;
    };
  }
}

const NOSTR_MIN_EVENT_INTERVAL_MS = 200;

function loadDefaultRelays(): string[] {
  try {
    const raw = localStorage.getItem(LS_NOSTR_RELAYS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
    }
  } catch {}
  return DEFAULT_NOSTR_RELAYS.slice();
}

function saveDefaultRelays(relays: string[]) {
  localStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(relays));
}

type NostrPool = {
  ensureRelay: (url: string) => void;
  setRelays: (urls: string[]) => void;
  subscribe: (
    relays: string[],
    filters: any[],
    onEvent: (ev: NostrEvent, from: string) => void,
    onEose?: (from: string) => void
  ) => () => void;
  publish: (relays: string[], event: NostrUnsignedEvent) => Promise<void>;
  publishEvent: (relays: string[], event: NostrEvent) => void;
};

function createNostrPool(): NostrPool {
  type Relay = {
    url: string;
    ws: WebSocket | null;
    status: "idle" | "opening" | "open" | "closed";
    queue: any[]; // messages to send when open
  };

  const relays = new Map<string, Relay>();
  const subs = new Map<
    string,
    {
      relays: string[];
      filters: any[];
      onEvent: (ev: NostrEvent, from: string) => void;
      onEose?: (from: string) => void;
    }
  >();

  function getOrCreate(url: string): Relay {
    let r = relays.get(url);
    if (!r) {
      r = { url, ws: null, status: "idle", queue: [] };
      relays.set(url, r);
    }
    if (r.status === "idle" || r.status === "closed") {
      try {
        r.status = "opening";
        r.ws = new WebSocket(url);
        r.ws.onopen = () => {
          r!.status = "open";
          // flush queue
          const q = r!.queue.slice();
          r!.queue.length = 0;
          for (const msg of q) r!.ws?.send(JSON.stringify(msg));
          // re-subscribe existing subscriptions on reconnect
          for (const [subId, sub] of subs) {
            if (sub.relays.includes(url)) {
              try { r!.ws?.send(JSON.stringify(["REQ", subId, ...sub.filters])); }
              catch { r!.queue.push(["REQ", subId, ...sub.filters]); }
            }
          }
        };
        r.ws.onclose = () => {
          r!.status = "closed";
          // try to reopen after a delay
          setTimeout(() => {
            if (relays.has(url)) getOrCreate(url);
          }, 2500);
        };
        r.ws.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (!Array.isArray(data)) return;
            const [type, ...rest] = data;
            if (type === "EVENT") {
              const [subId, ev] = rest as [string, NostrEvent];
              const s = subs.get(subId);
              if (s && ev && typeof ev.kind === "number") s.onEvent(ev, url);
            } else if (type === "EOSE") {
              const [subId] = rest as [string];
              const s = subs.get(subId);
              if (s?.onEose) s.onEose(url);
            }
          } catch {}
        };
      } catch {}
    }
    return r;
  }

  function send(url: string, msg: any, opts?: { ensureOpen?: boolean }) {
    const ensureOpen = opts?.ensureOpen !== false;
    const r = ensureOpen ? getOrCreate(url) : relays.get(url);
    if (!r) return;
    const payload = JSON.stringify(msg);
    if (r.status === "open" && r.ws?.readyState === WebSocket.OPEN) {
      try { r.ws.send(payload); } catch { r.queue.push(msg); }
    } else {
      r.queue.push(msg);
    }
  }

  const api: NostrPool = {
    ensureRelay(url: string) { getOrCreate(url); },
    setRelays(urls: string[]) {
      // open new
      for (const u of urls) getOrCreate(u);
      // close removed
      for (const [u, r] of relays) {
        if (!urls.includes(u)) {
          try { r.ws?.close(); } catch {}
          relays.delete(u);
        }
      }
    },
    subscribe(relayUrls, filters, onEvent, onEose) {
      const subId = `taskify-${Math.random().toString(36).slice(2, 10)}`;
      subs.set(subId, { relays: relayUrls.slice(), filters, onEvent, onEose });
      for (const u of relayUrls) {
        send(u, ["REQ", subId, ...filters]);
      }
      return () => {
        for (const u of relayUrls) send(u, ["CLOSE", subId], { ensureOpen: false });
        subs.delete(subId);
      };
    },
    async publish(relayUrls, unsigned) {
      // This method remains for backward compatibility if needed.
      const now = Math.floor(Date.now() / 1000);
      const toSend: any = { ...unsigned, created_at: unsigned.created_at || now };
      for (const u of relayUrls) send(u, ["EVENT", toSend]);
    },
    publishEvent(relayUrls, event) {
      for (const u of relayUrls) send(u, ["EVENT", event]);
    }
  };
  return api;
}

/* ================== Crypto helpers (AES-GCM via local Nostr key) ================== */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const h = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(h);
}
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function concatBytes(a: Uint8Array, b: Uint8Array) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveAesKeyFromLocalSk(): Promise<CryptoKey> {
  // Derive a stable AES key from local Nostr SK: AES-GCM 256 with SHA-256(sk || label)
  const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
  if (!skHex || !/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  const label = new TextEncoder().encode("taskify-ecash-v1");
  const raw = concatBytes(hexToBytes(skHex), label);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt","decrypt"]);
}
export async function encryptEcashTokenForFunder(plain: string): Promise<{alg:"aes-gcm-256";iv:string;ct:string}> {
  const key = await deriveAesKeyFromLocalSk();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { alg: "aes-gcm-256", iv: b64encode(iv), ct: b64encode(ctBuf) };
}
export async function decryptEcashTokenForFunder(enc: {alg:"aes-gcm-256";iv:string;ct:string}): Promise<string> {
  if (enc.alg !== "aes-gcm-256") throw new Error("Unsupported cipher");
  const key = await deriveAesKeyFromLocalSk();
  const iv = b64decode(enc.iv);
  const ct = b64decode(enc.ct);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

// NIP-04 encryption for recipient
async function encryptEcashTokenForRecipient(recipientHex: string, plain: string): Promise<{ alg: "nip04"; data: string }> {
  const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(recipientHex)) throw new Error("Invalid recipient pubkey");
  const data = await nip04.encrypt(skHex, recipientHex, plain);
  return { alg: "nip04", data };
}

async function decryptEcashTokenForRecipient(senderHex: string, enc: { alg: "nip04"; data: string }): Promise<string> {
  const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
  if (!/^[0-9a-fA-F]{64}$/.test(skHex)) throw new Error("No local Nostr secret key");
  if (!/^[0-9a-fA-F]{64}$/.test(senderHex)) throw new Error("Invalid sender pubkey");
  return await nip04.decrypt(skHex, senderHex, enc.data);
}

const CLOUD_BACKUP_KEY_LABEL = new TextEncoder().encode("taskify-cloud-backup-v1");

async function deriveBackupAesKey(skHex: string): Promise<CryptoKey> {
  const raw = concatBytes(hexToBytes(skHex), CLOUD_BACKUP_KEY_LABEL);
  const digest = await sha256(raw);
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptBackupWithSecretKey(skHex: string, plain: string): Promise<{ iv: string; ciphertext: string }> {
  const key = await deriveBackupAesKey(skHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  return { iv: b64encode(iv), ciphertext: b64encode(ctBuf) };
}

async function decryptBackupWithSecretKey(
  skHex: string,
  payload: { iv: string; ciphertext: string },
): Promise<string> {
  const key = await deriveBackupAesKey(skHex);
  const iv = b64decode(payload.iv);
  const ct = b64decode(payload.ciphertext);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

function deriveNpubFromSecretKeyHex(skHex: string): string | null {
  try {
    const pkHex = getPublicKey(hexToBytes(skHex));
    if (typeof (nip19 as any)?.npubEncode === "function") {
      return (nip19 as any).npubEncode(pkHex);
    }
    return pkHex;
  } catch {
    return null;
  }
}

function normalizeSecretKeyInput(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith("nsec")) {
    try {
      const dec = nip19.decode(value);
      if (dec.type !== "nsec" || typeof dec.data !== "string") return null;
      value = dec.data;
    } catch {
      return null;
    }
  }
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

async function fileToDataURL(file: File): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(fr.result as string);
    fr.readAsDataURL(file);
  });

  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1280;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function readDocumentsFromFiles(list: FileList | File[]): Promise<TaskDocument[]> {
  const files = Array.from(list);
  const attachments: TaskDocument[] = [];
  for (const file of files) {
    if (!isSupportedDocumentFile(file)) {
      throw new Error("Unsupported file type");
    }
    const doc = await createDocumentAttachment(file);
    attachments.push(ensureDocumentPreview(doc));
  }
  return attachments;
}

/* ================= Date helpers ================= */
function startOfDay(d: Date) {
  const nd = new Date(d);
  nd.setHours(0, 0, 0, 0);
  return nd;
}

function isoDatePart(iso: string): string {
  if (typeof iso === 'string' && iso.length >= 10) return iso.slice(0, 10);
  try { return new Date(iso).toISOString().slice(0, 10); } catch { return new Date().toISOString().slice(0, 10); }
}

function isoTimePart(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function isoFromDateTime(dateStr: string, timeStr?: string): string {
  if (dateStr) {
    if (timeStr) {
      const withTime = new Date(`${dateStr}T${timeStr}`);
      if (!Number.isNaN(withTime.getTime())) return withTime.toISOString();
    }
    const midnight = new Date(`${dateStr}T00:00`);
    if (!Number.isNaN(midnight.getTime())) return midnight.toISOString();
  }
  const parsed = new Date(dateStr);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

function formatTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function isoForWeekday(
  target: Weekday,
  options: { base?: Date; weekStart?: Weekday } = {}
): string {
  const { base = new Date(), weekStart = 0 } = options;
  const anchor = startOfWeek(base, weekStart);
  const anchorDay = anchor.getDay() as Weekday;
  const offset = ((target - anchorDay) % 7 + 7) % 7;
  const day = startOfDay(new Date(anchor.getTime() + offset * 86400000));
  return day.toISOString();
}

function isoForToday(base = new Date()): string {
  return startOfDay(base).toISOString();
}
function nextOccurrence(
  currentISO: string,
  rule: Recurrence,
  keepTime = false
): string | null {
  const currentDate = new Date(currentISO);
  const curDay = startOfDay(currentDate);
  const timeOffset = currentDate.getTime() - curDay.getTime();
  const baseTime = keepTime ? isoTimePart(currentISO) : "";
  const applyTime = (day: Date): string => {
    if (keepTime && baseTime) {
      const datePart = isoDatePart(day.toISOString());
      return isoFromDateTime(datePart, baseTime);
    }
    return new Date(day.getTime() + timeOffset).toISOString();
  };
  const addDays = (d: number) => {
    const nextDay = startOfDay(new Date(curDay.getTime() + d * 86400000));
    return applyTime(nextDay);
  };
  let next: string | null = null;
  switch (rule.type) {
    case "none":
      next = null; break;
    case "daily":
      next = addDays(1); break;
    case "weekly": {
      if (!rule.days.length) return null;
      for (let i = 1; i <= 28; i++) {
        const cand = addDays(i);
        const wd = new Date(cand).getDay() as Weekday;
        if (rule.days.includes(wd)) { next = cand; break; }
      }
      break;
    }
    case "every":
      next = addDays(rule.unit === "day" ? rule.n : rule.n * 7); break;
    case "monthlyDay": {
      const y = curDay.getFullYear(), m = curDay.getMonth();
      const n = startOfDay(new Date(y, m + 1, Math.min(rule.day, 28)));
      next = applyTime(n);
      break;
    }
  }
  if (next && rule.untilISO) {
    const limit = startOfDay(new Date(rule.untilISO)).getTime();
    const n = startOfDay(new Date(next)).getTime();
    if (n > limit) return null;
  }
  return next;
}

/* ============= Visibility helpers (hide until X) ============= */
function revealsOnDueDate(rule: Recurrence): boolean {
  if (rule.type === "daily" || rule.type === "weekly") return true;
  if (rule.type === "every") {
    return rule.unit === "day" || rule.unit === "week";
  }
  return false;
}

function isVisibleNow(t: Task, now = new Date()): boolean {
  if (!t.hiddenUntilISO) return true;
  const today = startOfDay(now).getTime();
  if (t.recurrence && revealsOnDueDate(t.recurrence)) {
    const dueReveal = startOfDay(new Date(t.dueISO)).getTime();
    if (!Number.isNaN(dueReveal)) return today >= dueReveal;
  }
  const reveal = startOfDay(new Date(t.hiddenUntilISO)).getTime();
  return today >= reveal;
}

function startOfWeek(d: Date, weekStart: Weekday): Date {
  const sd = startOfDay(d);
  const current = sd.getDay() as Weekday;
  const ws = (weekStart === 1 || weekStart === 6) ? weekStart : 0; // only Mon(1)/Sat(6)/Sun(0)
  let diff = current - ws;
  if (diff < 0) diff += 7;
  return new Date(sd.getTime() - diff * 86400000);
}

/** Decide when the next instance should re-appear (hiddenUntilISO). */
function hiddenUntilForNext(
  nextISO: string,
  rule: Recurrence,
  weekStart: Weekday
): string | undefined {
  const nextMidnight = startOfDay(new Date(nextISO));
  if (revealsOnDueDate(rule)) {
    return nextMidnight.toISOString();
  }
  const sow = startOfWeek(nextMidnight, weekStart);
  return sow.toISOString();
}

function normalizeHiddenForRecurring(task: Task): Task {
  if (!task.hiddenUntilISO || !task.recurrence || !revealsOnDueDate(task.recurrence)) {
    return task;
  }
  const dueMidnight = startOfDay(new Date(task.dueISO));
  const hiddenMidnight = startOfDay(new Date(task.hiddenUntilISO));
  if (Number.isNaN(dueMidnight.getTime()) || Number.isNaN(hiddenMidnight.getTime())) return task;
  const today = startOfDay(new Date());
  if (dueMidnight.getTime() > today.getTime() && hiddenMidnight.getTime() < dueMidnight.getTime()) {
    return { ...task, hiddenUntilISO: dueMidnight.toISOString() };
  }
  return task;
}

/* ================= Storage hooks ================= */
function useSettings() {
  const [settings, setSettingsRaw] = useState<Settings>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}");
      const baseFontSize =
        typeof parsed.baseFontSize === "number" ? parsed.baseFontSize : null;
      const startBoardByDay: Partial<Record<Weekday, string>> = {};
      if (parsed && typeof parsed.startBoardByDay === "object" && parsed.startBoardByDay) {
        for (const [key, value] of Object.entries(parsed.startBoardByDay as Record<string, unknown>)) {
          const day = Number(key);
          if (!Number.isInteger(day) || day < 0 || day > 6) continue;
          if (typeof value !== "string" || !value) continue;
          startBoardByDay[day as Weekday] = value;
        }
      }
      const backgroundImage = typeof parsed?.backgroundImage === "string" ? parsed.backgroundImage : null;
      let backgroundAccents = normalizeAccentPaletteList(parsed?.backgroundAccents) ?? null;
      let backgroundAccentIndex = typeof parsed?.backgroundAccentIndex === "number" ? parsed.backgroundAccentIndex : null;
      let backgroundAccent = normalizeAccentPalette(parsed?.backgroundAccent) ?? null;
      if (!backgroundAccents || backgroundAccents.length === 0) {
        backgroundAccents = null;
        backgroundAccentIndex = null;
      } else {
        if (backgroundAccentIndex == null || backgroundAccentIndex < 0 || backgroundAccentIndex >= backgroundAccents.length) {
          backgroundAccentIndex = 0;
        }
        if (!backgroundAccent) backgroundAccent = backgroundAccents[backgroundAccentIndex];
      }
      if (!backgroundImage) {
        backgroundAccents = null;
        backgroundAccentIndex = null;
        backgroundAccent = null;
      }
      const backgroundBlur = parsed?.backgroundBlur === "blurred" ? "blurred" : "sharp";
      let accent: Settings["accent"] = "blue";
      if (parsed?.accent === "green") accent = "green";
      else if (parsed?.accent === "background" && backgroundImage && backgroundAccent) accent = "background";
      const hideCompletedSubtasks = parsed?.hideCompletedSubtasks === true;
      const listAddButtonEnabled = parsed?.listAddButtonEnabled === true;
      const startupView = parsed?.startupView === "wallet" ? "wallet" : "main";
      const walletConversionEnabled = parsed?.walletConversionEnabled !== false;
      const walletPrimaryCurrency = parsed?.walletPrimaryCurrency === "usd" ? "usd" : "sat";
      const walletSentStateChecksEnabled = parsed?.walletSentStateChecksEnabled !== false;
      const walletPaymentRequestsEnabled = parsed?.walletPaymentRequestsEnabled !== false;
      const walletPaymentRequestsBackgroundChecksEnabled =
        parsed?.walletPaymentRequestsBackgroundChecksEnabled !== false;
      const npubCashLightningAddressEnabled = parsed?.npubCashLightningAddressEnabled !== false;
      const npubCashAutoClaim = npubCashLightningAddressEnabled && parsed?.npubCashAutoClaim !== false;
      const pushRaw = parsed?.pushNotifications;
      const inferredPlatform = detectPushPlatformFromNavigator();
      const storedPlatform = pushRaw?.platform === "android"
        ? "android"
        : pushRaw?.platform === "ios"
          ? "ios"
          : inferredPlatform;
      const pushPreferences: PushPreferences = {
        enabled: pushRaw?.enabled === true,
        platform: storedPlatform,
        deviceId: typeof pushRaw?.deviceId === 'string' ? pushRaw.deviceId : undefined,
        subscriptionId: typeof pushRaw?.subscriptionId === 'string' ? pushRaw.subscriptionId : undefined,
        permission:
          pushRaw?.permission === 'granted' || pushRaw?.permission === 'denied'
            ? pushRaw.permission
            : DEFAULT_PUSH_PREFERENCES.permission,
      };
      const validScriptureFrequencyIds = new Set(SCRIPTURE_MEMORY_FREQUENCIES.map(opt => opt.id));
      const rawScriptureFrequency = typeof parsed?.scriptureMemoryFrequency === 'string'
        ? parsed.scriptureMemoryFrequency
        : '';
      const scriptureMemoryFrequency: ScriptureMemoryFrequency = validScriptureFrequencyIds.has(rawScriptureFrequency as ScriptureMemoryFrequency)
        ? (rawScriptureFrequency as ScriptureMemoryFrequency)
        : 'daily';
      const validScriptureSortIds = new Set(SCRIPTURE_MEMORY_SORTS.map(opt => opt.id));
      const rawScriptureSort = typeof parsed?.scriptureMemorySort === 'string' ? parsed.scriptureMemorySort : '';
      const scriptureMemorySort: ScriptureMemorySort = validScriptureSortIds.has(rawScriptureSort as ScriptureMemorySort)
        ? (rawScriptureSort as ScriptureMemorySort)
        : 'needsReview';
      const scriptureMemoryBoardId = typeof parsed?.scriptureMemoryBoardId === 'string' && parsed.scriptureMemoryBoardId
        ? parsed.scriptureMemoryBoardId
        : null;
      const scriptureMemoryEnabled = parsed?.scriptureMemoryEnabled === true;
      if (parsed && typeof parsed === "object") {
        delete (parsed as Record<string, unknown>).theme;
        delete (parsed as Record<string, unknown>).backgroundAccents;
        delete (parsed as Record<string, unknown>).backgroundAccentIndex;
        delete (parsed as Record<string, unknown>).walletPaymentRequestsAutoClaim;
      }
      return {
        weekStart: 0,
        newTaskPosition: "top",
        streaksEnabled: true,
        completedTab: true,
        showFullWeekRecurring: false,
        inlineAdd: true,
        listAddButtonEnabled: false,
        ...parsed,
        bibleTrackerEnabled: parsed?.bibleTrackerEnabled === true,
        scriptureMemoryEnabled,
        scriptureMemoryBoardId,
        scriptureMemoryFrequency,
        scriptureMemorySort,
        hideCompletedSubtasks,
        listAddButtonEnabled,
        baseFontSize,
        startBoardByDay,
        accent,
        backgroundImage,
        backgroundAccent,
        backgroundAccents,
        backgroundAccentIndex,
        backgroundBlur,
        startupView,
        walletConversionEnabled,
        walletPrimaryCurrency: walletConversionEnabled ? walletPrimaryCurrency : "sat",
        walletSentStateChecksEnabled,
        walletPaymentRequestsEnabled,
        walletPaymentRequestsBackgroundChecksEnabled: walletPaymentRequestsEnabled
          ? walletPaymentRequestsBackgroundChecksEnabled
          : false,
        npubCashLightningAddressEnabled,
        npubCashAutoClaim: npubCashLightningAddressEnabled ? npubCashAutoClaim : false,
        cloudBackupsEnabled: parsed?.cloudBackupsEnabled === true,
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES, ...pushPreferences },
      };
    } catch {
      return {
        weekStart: 0,
        newTaskPosition: "top",
        streaksEnabled: true,
        completedTab: true,
        bibleTrackerEnabled: false,
        showFullWeekRecurring: false,
        inlineAdd: true,
        listAddButtonEnabled: false,
        baseFontSize: null,
        startBoardByDay: {},
        accent: "blue",
        backgroundImage: null,
        backgroundAccent: null,
        backgroundAccents: null,
        backgroundAccentIndex: null,
        backgroundBlur: "sharp",
        hideCompletedSubtasks: false,
        startupView: "main",
        walletConversionEnabled: true,
        walletPrimaryCurrency: "sat",
        walletSentStateChecksEnabled: true,
        walletPaymentRequestsEnabled: true,
        walletPaymentRequestsBackgroundChecksEnabled: true,
        npubCashLightningAddressEnabled: true,
        npubCashAutoClaim: true,
        cloudBackupsEnabled: false,
        scriptureMemoryEnabled: false,
        scriptureMemoryBoardId: null,
        scriptureMemoryFrequency: "daily",
        scriptureMemorySort: "needsReview",
        pushNotifications: { ...DEFAULT_PUSH_PREFERENCES },
      };
    }
  });
  const setSettings = useCallback((s: Partial<Settings>) => {
    setSettingsRaw(prev => {
      const next = { ...prev, ...s };
      if (s.pushNotifications) {
        next.pushNotifications = { ...prev.pushNotifications, ...DEFAULT_PUSH_PREFERENCES, ...s.pushNotifications };
        const detectedPlatform = detectPushPlatformFromNavigator();
        next.pushNotifications.platform = next.pushNotifications.platform === 'android'
          ? 'android'
          : detectedPlatform;
      }
      if (!next.backgroundImage) {
        next.backgroundImage = null;
        next.backgroundAccent = null;
        next.backgroundAccents = null;
        next.backgroundAccentIndex = null;
      } else {
        next.backgroundAccent = normalizeAccentPalette(next.backgroundAccent) ?? next.backgroundAccent ?? null;
        const normalizedList = normalizeAccentPaletteList(next.backgroundAccents);
        next.backgroundAccents = normalizedList && normalizedList.length ? normalizedList : null;
        if (next.backgroundAccents?.length) {
          if (typeof next.backgroundAccentIndex !== "number" || next.backgroundAccentIndex < 0 || next.backgroundAccentIndex >= next.backgroundAccents.length) {
            next.backgroundAccentIndex = 0;
          }
          next.backgroundAccent = next.backgroundAccents[next.backgroundAccentIndex];
        } else {
          next.backgroundAccents = null;
          next.backgroundAccentIndex = null;
          if (next.backgroundAccent) {
            next.backgroundAccents = [next.backgroundAccent];
            next.backgroundAccentIndex = 0;
          }
        }
      }
      if (!next.walletPaymentRequestsEnabled) {
        next.walletPaymentRequestsBackgroundChecksEnabled = false;
      }
      if (next.backgroundBlur !== "sharp" && next.backgroundBlur !== "blurred") {
        next.backgroundBlur = "sharp";
      }
      if (next.accent === "background" && (!next.backgroundImage || !next.backgroundAccent)) {
        next.accent = "blue";
      }
      if (!next.walletConversionEnabled) {
        next.walletPrimaryCurrency = "sat";
      } else if (next.walletPrimaryCurrency !== "usd") {
        next.walletPrimaryCurrency = "sat";
      }
      if (!next.npubCashLightningAddressEnabled) {
        next.npubCashLightningAddressEnabled = false;
        next.npubCashAutoClaim = false;
      } else if (next.npubCashAutoClaim !== true && next.npubCashAutoClaim !== false) {
        next.npubCashAutoClaim = true;
      }
      if (next.cloudBackupsEnabled !== true) {
        next.cloudBackupsEnabled = false;
      }
      if (!next.bibleTrackerEnabled) {
        next.bibleTrackerEnabled = false;
        next.scriptureMemoryEnabled = false;
        next.scriptureMemoryBoardId = null;
      }
      if (typeof next.scriptureMemoryBoardId !== 'string' || !next.scriptureMemoryBoardId) {
        next.scriptureMemoryBoardId = next.scriptureMemoryBoardId ? String(next.scriptureMemoryBoardId) : null;
        if (next.scriptureMemoryBoardId === '') next.scriptureMemoryBoardId = null;
      }
      if (!SCRIPTURE_MEMORY_FREQUENCIES.some(opt => opt.id === next.scriptureMemoryFrequency)) {
        next.scriptureMemoryFrequency = 'daily';
      }
      if (!SCRIPTURE_MEMORY_SORTS.some(opt => opt.id === next.scriptureMemorySort)) {
        next.scriptureMemorySort = 'needsReview';
      }
      if (next.scriptureMemoryEnabled !== true) {
        next.scriptureMemoryEnabled = false;
      }
      if (typeof next.scriptureMemoryBoardId === 'undefined') {
        next.scriptureMemoryBoardId = null;
      }
      if (next.listAddButtonEnabled !== true) {
        next.listAddButtonEnabled = false;
      }
      return next;
    });
  }, []);
  useEffect(() => {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }, [settings]);
  return [settings, setSettings] as const;
}

function pickStartupBoard(boards: Board[], overrides?: Partial<Record<Weekday, string>>): string {
  const visible = boards.filter(b => !b.archived && !b.hidden);
  const today = (new Date().getDay() as Weekday);
  const overrideId = overrides?.[today];
  if (overrideId) {
    const match = visible.find(b => b.id === overrideId) || boards.find(b => !b.archived && b.id === overrideId);
    if (match) return match.id;
  }
  if (visible.length) return visible[0].id;
  const firstUnarchived = boards.find(b => !b.archived);
  if (firstUnarchived) return firstUnarchived.id;
  return boards[0]?.id || "";
}

function migrateBoards(stored: any): Board[] | null {
  try {
    const arr = stored as any[];
    if (!Array.isArray(arr)) return null;
    return arr.map((b) => {
      const archived =
        typeof b?.archived === "boolean"
          ? b.archived
          : typeof b?.hidden === "boolean"
            ? b.hidden
            : false;
      const hidden =
        typeof b?.hidden === "boolean" && typeof b?.archived === "boolean"
          ? b.hidden
          : false;
      const clearCompletedDisabled =
        typeof b?.clearCompletedDisabled === "boolean" ? b.clearCompletedDisabled : false;
      const indexCardEnabled =
        typeof (b as any)?.indexCardEnabled === "boolean" ? Boolean((b as any).indexCardEnabled) : false;
      const hideChildBoardNames =
        typeof (b as any)?.hideChildBoardNames === "boolean"
          ? Boolean((b as any).hideChildBoardNames)
          : false;
      if (b?.kind === "week") {
        return {
          id: b.id,
          name: b.name,
          kind: "week",
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
        } as Board;
      }
      if (b?.kind === "lists" && Array.isArray(b.columns)) {
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: b.columns,
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
        } as Board;
      }
      if (b?.kind === "compound") {
        const rawChildren = Array.isArray((b as any)?.children) ? (b as any).children : [];
        const children = rawChildren
          .filter((child: unknown) => typeof child === "string" && child && child !== b.id) as string[];
        return {
          id: b.id,
          name: b.name,
          kind: "compound",
          children,
          nostr: b.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
          hideChildBoardNames,
        } as Board;
      }
      if (b?.kind === "bible") {
        const name = typeof b?.name === "string" && b.name.trim() ? b.name : "Bible";
        return {
          id: b.id,
          name,
          kind: "bible",
          archived,
          hidden,
          clearCompletedDisabled,
        } as Board;
      }
      if (b?.kind === "list") {
        // old single-column boards -> migrate to lists with one column
        const colId = crypto.randomUUID();
        return {
          id: b.id,
          name: b.name,
          kind: "lists",
          columns: [{ id: colId, name: "Items" }],
          nostr: b?.nostr,
          archived,
          hidden,
          clearCompletedDisabled,
          indexCardEnabled,
        } as Board;
      }
      // unknown -> keep as lists with one column
      const colId = crypto.randomUUID();
      return {
        id: b?.id || crypto.randomUUID(),
        name: b?.name || "Board",
        kind: "lists",
        columns: [{ id: colId, name: "Items" }],
        nostr: b?.nostr,
        archived,
        hidden,
        clearCompletedDisabled,
        indexCardEnabled,
      } as Board;
    });
  } catch { return null; }
}

function useBoards() {
  const [boards, setBoards] = useState<Board[]>(() => {
    const raw = localStorage.getItem(LS_BOARDS);
    if (raw) {
      const migrated = migrateBoards(JSON.parse(raw));
      if (migrated && migrated.length) return migrated;
    }
    // default: one Week board
    return [{ id: "week-default", name: "Week", kind: "week", archived: false, hidden: false, clearCompletedDisabled: false }];
  });
  useEffect(() => {
    localStorage.setItem(LS_BOARDS, JSON.stringify(boards));
  }, [boards]);
  return [boards, setBoards] as const;
}

function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => {
    const loadStored = (): any[] => {
      try {
        const current = localStorage.getItem(LS_TASKS);
        if (current) {
          const parsed = JSON.parse(current);
          if (Array.isArray(parsed)) return parsed;
        }
      } catch {}
      for (const legacy of LS_TASKS_LEGACY) {
        try {
          const raw = localStorage.getItem(legacy);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        } catch {}
      }
      return [];
    };

    const rawTasks = loadStored();
    const orderMap = new Map<string, number>();
    return rawTasks
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const fallbackBoard = typeof (entry as any).boardId === 'string' ? (entry as any).boardId : 'week-default';
        const boardId = fallbackBoard;
        const next = orderMap.get(boardId) ?? 0;
        const explicitOrder = typeof (entry as any).order === 'number' ? (entry as any).order : next;
        orderMap.set(boardId, explicitOrder + 1);
        const dueISO = typeof (entry as any).dueISO === 'string' ? (entry as any).dueISO : new Date().toISOString();
        const dueTimeEnabled = typeof (entry as any).dueTimeEnabled === 'boolean' ? (entry as any).dueTimeEnabled : undefined;
        const reminders = sanitizeReminderList((entry as any).reminders);
        const id = typeof (entry as any).id === 'string' ? (entry as any).id : crypto.randomUUID();
        const scriptureMemoryId = typeof (entry as any).scriptureMemoryId === 'string'
          ? (entry as any).scriptureMemoryId
          : undefined;
        const scriptureMemoryStageRaw = Number((entry as any).scriptureMemoryStage);
        const scriptureMemoryStage = Number.isFinite(scriptureMemoryStageRaw) && scriptureMemoryStageRaw >= 0
          ? Math.floor(scriptureMemoryStageRaw)
          : undefined;
        const prevReviewRaw = (entry as any).scriptureMemoryPrevReviewISO;
        const scriptureMemoryPrevReviewISO =
          typeof prevReviewRaw === 'string'
            ? prevReviewRaw
            : prevReviewRaw === null
              ? null
              : undefined;
        const scriptureMemoryScheduledAt = typeof (entry as any).scriptureMemoryScheduledAt === 'string'
          ? (entry as any).scriptureMemoryScheduledAt
          : undefined;
        const documents = normalizeDocumentList((entry as any).documents);
        const task: Task = {
          ...(entry as Task),
          id,
          boardId,
          order: explicitOrder,
          dueISO,
          ...(typeof dueTimeEnabled === 'boolean' ? { dueTimeEnabled } : {}),
          ...(reminders !== undefined ? { reminders } : {}),
          ...(scriptureMemoryId ? { scriptureMemoryId } : {}),
          ...(scriptureMemoryStage !== undefined ? { scriptureMemoryStage } : {}),
          ...(scriptureMemoryPrevReviewISO !== undefined ? { scriptureMemoryPrevReviewISO } : {}),
          ...(scriptureMemoryScheduledAt ? { scriptureMemoryScheduledAt } : {}),
        } as Task;
        if (documents) {
          task.documents = documents.map(ensureDocumentPreview);
        } else if (Object.prototype.hasOwnProperty.call(entry as any, "documents")) {
          task.documents = undefined;
        }
        return normalizeTaskBounty(normalizeHiddenForRecurring(task));
      })
      .filter((t): t is Task => !!t);
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_TASKS, JSON.stringify(tasks));
      for (const legacy of LS_TASKS_LEGACY) {
        try { localStorage.removeItem(legacy); } catch {}
      }
    } catch (err) {
      console.error('Failed to save tasks', err);
    }
  }, [tasks]);
  return [tasks, setTasks] as const;
}

function useBibleTracker(): [BibleTrackerState, React.Dispatch<React.SetStateAction<BibleTrackerState>>] {
  const [state, setState] = useState<BibleTrackerState>(() => {
    try {
      const raw = localStorage.getItem(LS_BIBLE_TRACKER);
      if (raw) {
        return sanitizeBibleTrackerState(JSON.parse(raw));
      }
    } catch {}
    return sanitizeBibleTrackerState(null);
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(state));
    } catch {}
  }, [state]);
  return [state, setState];
}

function useScriptureMemory(): [ScriptureMemoryState, React.Dispatch<React.SetStateAction<ScriptureMemoryState>>] {
  const [state, setState] = useState<ScriptureMemoryState>(() => {
    try {
      const raw = localStorage.getItem(LS_SCRIPTURE_MEMORY);
      if (raw) {
        return sanitizeScriptureMemoryState(JSON.parse(raw));
      }
    } catch {}
    return sanitizeScriptureMemoryState(null);
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_SCRIPTURE_MEMORY, JSON.stringify(state));
    } catch {}
  }, [state]);
  return [state, setState];
}

/* ================= App ================= */
export default function App() {
  const { show: showToast } = useToast();
  const [workerBaseUrl, setWorkerBaseUrl] = useState<string>(FALLBACK_WORKER_BASE_URL);
  const [vapidPublicKey, setVapidPublicKey] = useState<string>(FALLBACK_VAPID_PUBLIC_KEY);
  if (typeof window !== "undefined") {
    (window as any).__TASKIFY_WORKER_BASE_URL__ = workerBaseUrl;
  }
  useEffect(() => {
    let cancelled = false;
    async function loadRuntimeConfig() {
      try {
        const response = await fetch("/api/config", { method: "GET" });
        if (!response.ok) throw new Error(`Unexpected status ${response.status}`);
        const data = await response.json();
        if (cancelled || !data || typeof data !== "object") return;
        if (typeof data.workerBaseUrl === "string" && data.workerBaseUrl.trim()) {
          setWorkerBaseUrl(data.workerBaseUrl.trim().replace(/\/$/, ""));
        } else if (!FALLBACK_WORKER_BASE_URL && typeof window !== "undefined") {
          setWorkerBaseUrl(window.location.origin);
        }
        if (typeof data.vapidPublicKey === "string" && data.vapidPublicKey.trim()) {
          setVapidPublicKey(data.vapidPublicKey.trim());
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("Failed to load runtime config", err);
          if (!FALLBACK_WORKER_BASE_URL && typeof window !== "undefined") {
            setWorkerBaseUrl(window.location.origin);
          }
        }
      }
    }
    loadRuntimeConfig();
    return () => { cancelled = true; };
  }, []);
  // Show toast on any successful clipboard write across the app
  useEffect(() => {
    const clip: any = (navigator as any).clipboard;
    if (!clip || typeof clip.writeText !== 'function') return;
    const original = clip.writeText.bind(clip);
    const patched = (text: string) => {
      try {
        const p = original(text);
        if (p && typeof p.then === 'function') {
          p.then(() => showToast()).catch(() => {});
        } else {
          showToast();
        }
        return p;
      } catch {
        // swallow, behave like original
        try { return original(text); } catch {}
      }
    };
    try { clip.writeText = patched; } catch {}
    return () => { try { clip.writeText = original; } catch {} };
  }, [showToast]);
  const [boards, setBoards] = useBoards();
  const [settings, setSettings] = useSettings();
  useEffect(() => {
    setBoards(prev => {
      const hasBible = prev.some(b => b.id === BIBLE_BOARD_ID);
      if (settings.bibleTrackerEnabled) {
        if (hasBible) {
          return prev.map(b => {
            if (b.id !== BIBLE_BOARD_ID) return b;
            return {
              id: BIBLE_BOARD_ID,
              name: "Bible",
              kind: "bible",
              archived: false,
              hidden: false,
            } as Board;
          });
        }
        const insertionIndex = prev.findIndex(b => b.archived);
        const bibleBoard: Board = {
          id: BIBLE_BOARD_ID,
          name: "Bible",
          kind: "bible",
          archived: false,
          hidden: false,
        };
        if (insertionIndex === -1) {
          return [...prev, bibleBoard];
        }
        const next = [...prev];
        next.splice(insertionIndex, 0, bibleBoard);
        return next;
      }
      if (!hasBible) return prev;
      return prev.filter(b => b.id !== BIBLE_BOARD_ID);
    });
  }, [settings.bibleTrackerEnabled, setBoards]);
  useEffect(() => {
    const detected = detectPushPlatformFromNavigator();
    if (settings.pushNotifications.platform !== detected) {
      setSettings({ pushNotifications: { ...settings.pushNotifications, platform: detected } });
    }
  }, [settings.pushNotifications, setSettings]);
  const [currentBoardId, setCurrentBoardIdState] = useState(() => pickStartupBoard(boards, settings.startBoardByDay));
  const currentBoard = boards.find(b => b.id === currentBoardId);
  const isListBoard = currentBoard?.kind === "lists";
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);
  const scriptureMemoryFrequencyOption = useMemo(
    () => SCRIPTURE_MEMORY_FREQUENCIES.find((opt) => opt.id === settings.scriptureMemoryFrequency) || SCRIPTURE_MEMORY_FREQUENCIES[0],
    [settings.scriptureMemoryFrequency]
  );
  const scriptureMemorySortLabel = useMemo(
    () => SCRIPTURE_MEMORY_SORTS.find((opt) => opt.id === settings.scriptureMemorySort)?.label || SCRIPTURE_MEMORY_SORTS[0].label,
    [settings.scriptureMemorySort]
  );
  const scriptureMemoryBoard = useMemo(
    () => (settings.scriptureMemoryBoardId ? boards.find((b) => b.id === settings.scriptureMemoryBoardId) || null : null),
    [boards, settings.scriptureMemoryBoardId]
  );
  const availableMemoryBoards = useMemo(
    () => boards.filter((b) => !b.archived && b.kind !== "bible"),
    [boards]
  );

  useEffect(() => {
    if (!settings.bibleTrackerEnabled && currentBoardId === BIBLE_BOARD_ID) {
      const fallbackBoards = boards.filter(b => b.id !== BIBLE_BOARD_ID);
      const next = pickStartupBoard(fallbackBoards, settings.startBoardByDay);
      if (next !== currentBoardId) setCurrentBoardIdState(next);
    }
  }, [settings.bibleTrackerEnabled, currentBoardId, boards, settings.startBoardByDay]);

  useEffect(() => {
    if (!settings.scriptureMemoryEnabled) return;
    if (scriptureMemoryBoard) return;
    const fallbackId = availableMemoryBoards[0]?.id;
    if (fallbackId && fallbackId !== settings.scriptureMemoryBoardId) {
      setSettings({ scriptureMemoryBoardId: fallbackId });
    }
  }, [
    settings.scriptureMemoryEnabled,
    scriptureMemoryBoard,
    availableMemoryBoards,
    setSettings,
    settings.scriptureMemoryBoardId,
  ]);



  useEffect(() => {
    const current = boards.find(b => b.id === currentBoardId);
    if (current && !current.archived && !current.hidden) return;
    const next = pickStartupBoard(boards, settings.startBoardByDay);
    if (next !== currentBoardId) setCurrentBoardIdState(next);
  }, [boards, currentBoardId, settings.startBoardByDay]);

  const [tasks, setTasks] = useTasks();
  const [bibleTracker, setBibleTracker] = useBibleTracker();
  const [scriptureMemory, setScriptureMemory] = useScriptureMemory();
  const [defaultRelays, setDefaultRelays] = useState<string[]>(() => loadDefaultRelays());
  useEffect(() => { saveDefaultRelays(defaultRelays); }, [defaultRelays]);
  const handleAddScriptureMemory = useCallback((payload: AddScripturePayload) => {
    setScriptureMemory((prev) => {
      const entries = prev.entries ? [...prev.entries] : [];
      const chapterCount = getBibleBookChapterCount(payload.bookId) ?? payload.chapter;
      const chapter = Math.min(Math.max(1, Math.floor(payload.chapter)), chapterCount);
      const verseCount = getBibleChapterVerseCount(payload.bookId, chapter) ?? MAX_VERSE_COUNT;
      let startVerse = payload.startVerse != null ? Math.floor(payload.startVerse) : null;
      let endVerse = payload.endVerse != null ? Math.floor(payload.endVerse) : startVerse;
      if (startVerse != null) startVerse = Math.max(1, Math.min(verseCount, startVerse));
      if (endVerse != null) endVerse = Math.max(1, Math.min(verseCount, endVerse));
      if (startVerse != null && endVerse != null && endVerse < startVerse) {
        [startVerse, endVerse] = [endVerse, startVerse];
      }
      const entry: ScriptureMemoryEntry = {
        id: crypto.randomUUID(),
        bookId: payload.bookId,
        chapter,
        startVerse,
        endVerse: endVerse ?? startVerse,
        addedAtISO: new Date().toISOString(),
        lastReviewISO: undefined,
        scheduledAtISO: undefined,
        stage: 0,
        totalReviews: 0,
      };
      return updateScriptureMemoryState(prev, [...entries, entry]);
    });
  }, [setScriptureMemory]);
  const handleRemoveScriptureMemory = useCallback((id: string) => {
    setScriptureMemory((prev) => updateScriptureMemoryState(prev, prev.entries.filter((entry) => entry.id !== id)));
    setTasks((prev) => prev.filter((task) => task.scriptureMemoryId !== id));
  }, [setScriptureMemory, setTasks]);
  const scriptureMemoryItems = useMemo<ScriptureMemoryListItem[]>(() => {
    if (!scriptureMemory.entries.length) return [];
    const baseDays = scriptureMemoryFrequencyOption?.days ?? 1;
    const now = new Date();
    const total = scriptureMemory.entries.length;
    const decorated = scriptureMemory.entries.map((entry) => ({
      entry,
      stats: computeScriptureStats(entry, baseDays, total, now),
    }));
    decorated.sort((a, b) => {
      switch (settings.scriptureMemorySort) {
        case "canonical": {
          const orderA = getBibleBookOrder(a.entry.bookId) ?? 0;
          const orderB = getBibleBookOrder(b.entry.bookId) ?? 0;
          if (orderA !== orderB) return orderA - orderB;
          if (a.entry.chapter !== b.entry.chapter) return a.entry.chapter - b.entry.chapter;
          const startA = a.entry.startVerse ?? 0;
          const startB = b.entry.startVerse ?? 0;
          if (startA !== startB) return startA - startB;
          return (a.entry.endVerse ?? 0) - (b.entry.endVerse ?? 0);
        }
        case "oldest": {
          const timeA = new Date(a.entry.addedAtISO).getTime();
          const timeB = new Date(b.entry.addedAtISO).getTime();
          return timeA - timeB;
        }
        case "newest": {
          const timeA = new Date(a.entry.addedAtISO).getTime();
          const timeB = new Date(b.entry.addedAtISO).getTime();
          return timeB - timeA;
        }
        case "needsReview":
        default: {
          if (a.stats.score === b.stats.score) {
            return a.stats.dueInDays - b.stats.dueInDays;
          }
          return b.stats.score - a.stats.score;
        }
      }
    });
    return decorated.map(({ entry, stats }) => ({
      id: entry.id,
      reference: formatScriptureReference(entry),
      addedAtISO: entry.addedAtISO,
      lastReviewISO: entry.lastReviewISO,
      stage: entry.stage ?? 0,
      totalReviews: entry.totalReviews ?? 0,
      dueLabel: formatDueInLabel(stats.dueInDays),
      dueNow: stats.dueNow,
    }));
  }, [
    scriptureMemory.entries,
    scriptureMemoryFrequencyOption?.days,
    settings.scriptureMemorySort,
  ]);
  const maybePublishTaskRef = useRef<PublishTaskFn | null>(null);
  const completeTaskRef = useRef<CompleteTaskFn | null>(null);
  const scriptureLastReviewRef = useRef<string | null>(null);
  const handleReviewScriptureMemory = useCallback(
    (id: string) => {
      const pending = tasks.find((task) => task.scriptureMemoryId === id && !task.completed);
      if (pending) {
        const update = completeTaskRef.current?.(pending.id, { skipScriptureMemoryUpdate: true });
        const completedAt = update?.scriptureMemory?.completedAt ?? new Date().toISOString();
        scriptureLastReviewRef.current = completedAt;
        const stageBefore = update?.scriptureMemory?.stageBefore ?? (
          typeof pending.scriptureMemoryStage === "number" ? pending.scriptureMemoryStage : undefined
        );
        const nextScheduled = update?.scriptureMemory?.nextScheduled;
        setScriptureMemory((prev) => {
          let nextState = markScriptureEntryReviewed(prev, id, completedAt, stageBefore);
          if (nextScheduled) {
            nextState = scheduleScriptureEntry(nextState, nextScheduled.entryId, nextScheduled.scheduledAtISO);
          }
          return nextState;
        });
        return;
      }
      const completedAt = new Date().toISOString();
      scriptureLastReviewRef.current = completedAt;
      setScriptureMemory((prev) => markScriptureEntryReviewed(prev, id, completedAt));
    },
    [tasks, setScriptureMemory, completeTaskRef]
  );
  useEffect(() => {
    if (!tasks.length) return;
    if (!scriptureMemory.entries.length) return;
    let updatedState: ScriptureMemoryState | null = null;
    let latestReviewISO: string | null = null;
    let latestReviewTime = Number.NEGATIVE_INFINITY;
    for (const task of tasks) {
      if (!task.completed) continue;
      if (!task.scriptureMemoryId) continue;
      const completedAt = normalizeIsoTimestamp(task.completedAt);
      if (!completedAt) continue;
      const baseState = updatedState ?? scriptureMemory;
      const entry = baseState.entries.find((item) => item.id === task.scriptureMemoryId);
      if (!entry) continue;
      const entryLastReview = entry.lastReviewISO ? new Date(entry.lastReviewISO).getTime() : Number.NEGATIVE_INFINITY;
      const completedTime = new Date(completedAt).getTime();
      if (!Number.isFinite(completedTime)) continue;
      if (Number.isFinite(entryLastReview) && entryLastReview >= completedTime) continue;
      const stageBefore = typeof task.scriptureMemoryStage === "number"
        ? task.scriptureMemoryStage
        : entry.stage ?? 0;
      updatedState = markScriptureEntryReviewed(baseState, task.scriptureMemoryId, completedAt, stageBefore);
      if (!Number.isFinite(latestReviewTime) || latestReviewTime < completedTime) {
        latestReviewISO = completedAt;
        latestReviewTime = completedTime;
      }
    }
    if (updatedState && updatedState !== scriptureMemory) {
      if (latestReviewISO) {
        scriptureLastReviewRef.current = latestReviewISO;
      }
      setScriptureMemory(updatedState);
    }
  }, [tasks, scriptureMemory, setScriptureMemory]);

  useEffect(() => {
    const latest = scriptureMemory.lastReviewISO ?? null;
    if (!latest) {
      scriptureLastReviewRef.current = null;
      return;
    }
    const current = scriptureLastReviewRef.current;
    if (!current) {
      scriptureLastReviewRef.current = latest;
      return;
    }
    if (new Date(latest).getTime() > new Date(current).getTime()) {
      scriptureLastReviewRef.current = latest;
    }
  }, [scriptureMemory.lastReviewISO]);

  useEffect(() => {
    if (!settings.scriptureMemoryEnabled) return;
    if (!scriptureMemory.entries.length) return;
    const targetBoard = scriptureMemoryBoard && scriptureMemoryBoard.kind !== "bible"
      ? scriptureMemoryBoard
      : null;
    if (!targetBoard) return;
    if (targetBoard.kind === "lists" && (!targetBoard.columns || targetBoard.columns.length === 0)) return;
    const baseDays = scriptureMemoryFrequencyOption?.days ?? 1;
    const recurrence = scriptureFrequencyToRecurrence(baseDays);
    const selection = chooseNextScriptureEntry(scriptureMemory.entries, baseDays, new Date());
    if (!selection) return;
    const now = new Date();
    const nowISO = now.toISOString();
    const dueDays = Number.isFinite(selection.stats.dueInDays) && selection.stats.dueInDays > 0
      ? Math.ceil(selection.stats.dueInDays)
      : 0;
    const dueDate = startOfDay(new Date(now.getTime() + dueDays * MS_PER_DAY));
    const dueISO = dueDate.toISOString();
    let hiddenUntilISO: string | undefined;
    if (startOfDay(dueDate).getTime() > startOfDay(now).getTime()) {
      const candidate = hiddenUntilForNext(dueISO, recurrence, settings.weekStart);
      const candidateMidnight = startOfDay(new Date(candidate)).getTime();
      const todayMidnight = startOfDay(now).getTime();
      if (candidateMidnight > todayMidnight) hiddenUntilISO = candidate;
    }
    let createdTask: Task | null = null;
    setTasks((prev) => {
      let changed = false;
      const nextTasks = prev.map((task) => {
        const isScriptureTask = task.seriesId === SCRIPTURE_MEMORY_SERIES_ID || task.scriptureMemoryId;
        if (!isScriptureTask) return task;
        let updated = task;
        if (updated.seriesId !== SCRIPTURE_MEMORY_SERIES_ID) {
          updated = { ...updated, seriesId: SCRIPTURE_MEMORY_SERIES_ID };
          changed = true;
        }
        if (!recurrencesEqual(updated.recurrence, recurrence)) {
          updated = { ...updated, recurrence };
          changed = true;
        }
        if (updated.boardId !== targetBoard.id) {
          updated = { ...updated, boardId: targetBoard.id };
          if (targetBoard.kind === "week") {
            updated = { ...updated, column: "day" as const };
          } else if (targetBoard.kind === "lists") {
            const firstColumn = targetBoard.columns?.[0];
            if (firstColumn) {
              updated = { ...updated, columnId: firstColumn.id };
            }
          }
          changed = true;
        } else if (targetBoard.kind === "lists") {
          const firstColumn = targetBoard.columns?.[0];
          if (firstColumn && updated.columnId !== firstColumn.id && !targetBoard.columns?.some((col) => col.id === updated.columnId)) {
            updated = { ...updated, columnId: firstColumn.id };
            changed = true;
          }
        }
        return updated;
      });
      const hasActive = nextTasks.some((task) => !task.completed && task.seriesId === SCRIPTURE_MEMORY_SERIES_ID);
      if (hasActive) {
        return changed ? nextTasks : prev;
      }
      const order = nextOrderForBoard(targetBoard.id, nextTasks, settings.newTaskPosition);
      if (targetBoard.kind === "lists" && (!targetBoard.columns || targetBoard.columns.length === 0)) {
        return changed ? nextTasks : prev;
      }
      const newTask: Task = {
        id: crypto.randomUUID(),
        boardId: targetBoard.id,
        title: `Review ${formatScriptureReference(selection.entry)}`,
        dueISO,
        completed: false,
        order,
        recurrence,
        seriesId: SCRIPTURE_MEMORY_SERIES_ID,
        scriptureMemoryId: selection.entry.id,
        scriptureMemoryStage: selection.entry.stage ?? 0,
        scriptureMemoryPrevReviewISO: selection.entry.lastReviewISO ?? null,
        scriptureMemoryScheduledAt: nowISO,
        ...(hiddenUntilISO ? { hiddenUntilISO } : {}),
      };
      if (targetBoard.kind === "week") {
        newTask.column = "day";
      } else if (targetBoard.kind === "lists") {
        const firstColumn = targetBoard.columns?.[0];
        if (!firstColumn) return changed ? nextTasks : prev;
        newTask.columnId = firstColumn.id;
      }
      createdTask = newTask;
      return [...nextTasks, newTask];
    });
    if (createdTask) {
      const publishPromise = maybePublishTaskRef.current?.(createdTask);
      publishPromise?.catch(() => {});
      setScriptureMemory((prev) => scheduleScriptureEntry(prev, selection.entry.id, nowISO));
    }
  }, [
    settings.scriptureMemoryEnabled,
    scriptureMemory.entries,
    scriptureMemoryBoard,
    scriptureMemoryFrequencyOption?.days,
    settings.weekStart,
    settings.newTaskPosition,
    setTasks,
    maybePublishTaskRef,
    setScriptureMemory,
  ]);

  useEffect(() => {
    if (!settings.showFullWeekRecurring) return;
    setTasks(prev => ensureWeekRecurrences(prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.showFullWeekRecurring, settings.weekStart]);

  useEffect(() => {
    const overrides = settings.startBoardByDay;
    if (!overrides || Object.keys(overrides).length === 0) return;
    const visibleIds = new Set(boards.filter(b => !b.archived && !b.hidden).map(b => b.id));
    let changed = false;
    const next: Partial<Record<Weekday, string>> = {};
    for (const key of Object.keys(overrides)) {
      const dayNum = Number(key);
      const boardId = overrides[key as keyof typeof overrides];
      if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) {
        changed = true;
        continue;
      }
      if (typeof boardId !== "string" || !boardId || !visibleIds.has(boardId)) {
        changed = true;
        continue;
      }
      next[dayNum as Weekday] = boardId;
    }
    if (changed) setSettings({ startBoardByDay: next });
  }, [boards, settings.startBoardByDay, setSettings]);

  // Apply font size setting to root; fall back to default size
  useEffect(() => {
    try {
      const base = settings.baseFontSize;
      if (typeof base === "number" && base >= 12) {
        const px = Math.min(22, base);
        document.documentElement.style.fontSize = `${px}px`;
      } else {
        document.documentElement.style.fontSize = "";
      }
    } catch {}
  }, [settings.baseFontSize]);

  // Ensure the app always renders with the dark theme
  useEffect(() => {
    try {
      const root = document.documentElement;
      root.classList.remove("light");
      if (!root.classList.contains("dark")) root.classList.add("dark");
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", "#0a0a0a");
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.accent === "green") root.setAttribute("data-accent", "green");
      else root.removeAttribute("data-accent");

      const palette = settings.accent === "background" ? settings.backgroundAccent ?? null : null;
      const hasBackgroundImage = Boolean(settings.backgroundImage);
      for (const [cssVar, key] of CUSTOM_ACCENT_VARIABLES) {
        if (palette) style.setProperty(cssVar, palette[key]);
        else style.removeProperty(cssVar);
      }
      if (palette) {
        style.setProperty("--background-gradient", gradientFromPalette(palette, hasBackgroundImage));
      } else {
        style.removeProperty("--background-gradient");
      }
    } catch (err) {
      console.error('Failed to apply accent palette', err);
    }
  }, [settings.accent, settings.backgroundAccent, settings.backgroundImage]);

  useEffect(() => {
    try {
      const root = document.documentElement;
      const style = root.style;
      if (settings.backgroundImage) {
        style.setProperty("--background-image", `url("${settings.backgroundImage}")`);
        style.setProperty("--background-image-opacity", "1");
        const blurMode = settings.backgroundBlur;
        const overlay = blurMode === "sharp" ? "0.1" : "0.18";
        style.setProperty("--background-overlay-opacity", overlay);
        style.setProperty("--background-image-filter", blurMode === "sharp" ? "none" : "blur(36px)");
        style.setProperty("--background-image-scale", blurMode === "sharp" ? "1.02" : "1.08");
      } else {
        style.removeProperty("--background-image");
        style.removeProperty("--background-image-opacity");
        style.removeProperty("--background-overlay-opacity");
        style.removeProperty("--background-image-filter");
        style.removeProperty("--background-image-scale");
      }
    } catch (err) {
      console.error('Failed to apply background image', err);
    }
  }, [settings.backgroundImage, settings.backgroundBlur]);

  // Nostr pool + merge indexes
  const pool = useMemo(() => createNostrPool(), []);
  // In-app Nostr key (secp256k1/Schnorr) for signing
  function bytesToHex(b: Uint8Array): string {
    return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  const [nostrSK, setNostrSK] = useState<Uint8Array>(() => {
    try {
      const existing = localStorage.getItem(LS_NOSTR_SK);
      if (existing && /^[0-9a-fA-F]{64}$/.test(existing)) return hexToBytes(existing);
    } catch {}
    const sk = generateSecretKey();
    try { localStorage.setItem(LS_NOSTR_SK, bytesToHex(sk)); } catch {}
    return sk;
  });
  const [nostrPK, setNostrPK] = useState<string>(() => {
    try { return getPublicKey(nostrSK); } catch { return ""; }
  });
  useEffect(() => { (window as any).nostrPK = nostrPK; }, [nostrPK]);
  // allow manual key rotation later if needed
  const rotateNostrKey = () => {
    const sk = generateSecretKey();
    setNostrSK(sk);
    const pk = getPublicKey(sk);
    setNostrPK(pk);
    try { localStorage.setItem(LS_NOSTR_SK, bytesToHex(sk)); } catch {}
  };

  const setCustomNostrKey = (key: string) => {
    try {
      let hex = key.trim();
      if (hex.startsWith("nsec")) {
        const dec = nip19.decode(hex);
        if (typeof dec.data !== "string") throw new Error();
        hex = dec.data;
      }
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error();
      const sk = hexToBytes(hex);
      setNostrSK(sk);
      const pk = getPublicKey(sk);
      setNostrPK(pk);
      try { localStorage.setItem(LS_NOSTR_SK, hex); } catch {}
    } catch {
      alert("Invalid private key");
    }
  };

  const lastNostrCreated = useRef(0);
  const nostrPublishQueue = useRef<Promise<void>>(Promise.resolve());
  const lastNostrSentMs = useRef(0);
  async function nostrPublish(relays: string[], template: EventTemplate) {
    const run = async () => {
      const nowMs = Date.now();
      const elapsed = nowMs - lastNostrSentMs.current;
      if (elapsed < NOSTR_MIN_EVENT_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, NOSTR_MIN_EVENT_INTERVAL_MS - elapsed));
      }
      const now = Math.floor(Date.now() / 1000);
      let createdAt = typeof template.created_at === "number" ? template.created_at : now;
      if (createdAt <= lastNostrCreated.current) {
        createdAt = lastNostrCreated.current + 1;
      }
      lastNostrCreated.current = createdAt;
      const ev = finalizeEvent({ ...template, created_at: createdAt }, nostrSK);
      pool.publishEvent(relays, ev as unknown as NostrEvent);
      lastNostrSentMs.current = Date.now();
      return createdAt;
    };
    const next = nostrPublishQueue.current.catch(() => {}).then(run);
    nostrPublishQueue.current = next.then(() => {}, () => {});
    return next;
  }
  type NostrIndex = {
    boardMeta: Map<string, number>; // nostrBoardId -> created_at
    taskClock: Map<string, Map<string, number>>; // nostrBoardId -> (taskId -> created_at)
  };
  const nostrIdxRef = useRef<NostrIndex>({ boardMeta: new Map(), taskClock: new Map() });
  const pendingNostrTasksRef = useRef<Set<string>>(new Set());
  const boardsRef = useRef<Board[]>(boards);
  useEffect(() => { boardsRef.current = boards; }, [boards]);
  const [nostrRefresh, setNostrRefresh] = useState(0);

  // header view
  const [view, setView] = useState<"board" | "completed" | "bible">("board");
  useEffect(() => {
    if (currentBoard?.kind === "bible") {
      if (view === "board") setView("bible");
    } else if (view === "bible") {
      setView("board");
    }
  }, [currentBoard?.kind, view]);
  const [showSettings, setShowSettingsState] = useState(false);
  const [showWallet, setShowWalletState] = useState(false);
  const [walletTokenStateResetNonce, setWalletTokenStateResetNonce] = useState(0);
  const [updateToastVisible, setUpdateToastVisible] = useState(false);
  const reloadOnNextNavigationRef = useRef(false);
  const shouldReloadForNavigation = useCallback(() => {
    if (!reloadOnNextNavigationRef.current) return false;
    window.location.reload();
    return true;
  }, []);

  useEffect(() => {
    function handleUpdateAvailable() {
      reloadOnNextNavigationRef.current = true;
      setUpdateToastVisible(true);
    }

    window.addEventListener("taskify:update-available", handleUpdateAvailable);
    return () => {
      window.removeEventListener("taskify:update-available", handleUpdateAvailable);
    };
  }, []);

  const handleReloadNow = useCallback(() => {
    window.location.reload();
  }, []);

  const handleReloadLater = useCallback(() => {
    setUpdateToastVisible(false);
  }, []);
  const handleResetWalletTokenTracking = useCallback(() => {
    setWalletTokenStateResetNonce((value) => value + 1);
    showToast("Background token tracking reset", 3000);
  }, [showToast]);

  const changeBoard = useCallback(
    (id: string) => {
      if (shouldReloadForNavigation()) return;
      setCurrentBoardIdState(id);
    },
    [shouldReloadForNavigation],
  );

  const openSettings = useCallback(() => {
    if (shouldReloadForNavigation()) return;
    setShowSettingsState(true);
  }, [shouldReloadForNavigation]);

  const openWallet = useCallback(() => {
    if (shouldReloadForNavigation()) return;
    setShowWalletState(true);
  }, [shouldReloadForNavigation]);

  const openUpcoming = useCallback(() => {
    if (shouldReloadForNavigation()) return;
    setShowUpcomingState(true);
  }, [shouldReloadForNavigation]);
  const startupViewHandledRef = useRef(false);
  useEffect(() => {
    if (startupViewHandledRef.current) return;
    startupViewHandledRef.current = true;
    if (settings.startupView === "wallet") {
      setShowWalletState(true);
    }
  }, [settings.startupView]);
  const { receiveToken } = useCashu();

  const [tutorialComplete, setTutorialComplete] = useState(() => {
    try {
      return localStorage.getItem(LS_TUTORIAL_DONE) === "done";
    } catch {
      return false;
    }
  });
  const [tutorialStep, setTutorialStep] = useState<number | null>(null);

  const markTutorialDone = useCallback(() => {
    setTutorialStep(null);
    setTutorialComplete(true);
    try {
      localStorage.setItem(LS_TUTORIAL_DONE, "done");
    } catch {}
  }, []);

  const handleCopyNsec = useCallback(async () => {
    try {
      const sk = localStorage.getItem(LS_NOSTR_SK) || "";
      if (!sk) {
        alert("No private key found yet. You can generate one from Settings → Nostr.");
        return;
      }
      let nsec = "";
      try {
        nsec = typeof (nip19 as any)?.nsecEncode === "function" ? (nip19 as any).nsecEncode(sk) : sk;
      } catch {
        nsec = sk;
      }
      await navigator.clipboard?.writeText(nsec);
      showToast("nsec copied");
    } catch {
      alert("Unable to copy your key. You can copy it later from Settings → Nostr.");
    }
  }, [showToast]);

  const tutorialSteps = useMemo(
    () => [
      {
        title: "Welcome to the new Taskify",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">
              Taskify now opens on a glassy Week board with a command center that keeps your essential controls close.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Pick any board from the pill switcher, or drag a task onto it to move work between boards.</li>
              <li>Use the control matrix to jump into your wallet, pop open Settings, review Completed tasks, or peek at Upcoming items.</li>
              <li>The accent-aware surfaces keep lists legible while matching the color palette you choose.</li>
            </ul>
            <p className="text-tertiary">You can skip this tutorial at any time.</p>
          </div>
        ),
      },
      {
        title: "Capture and organize tasks",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">
              Capture ideas instantly and arrange them across days or custom lists.
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Use the New Task bar or enable inline add boxes in Settings → View to create cards exactly where you need them.</li>
              <li>Drag tasks to reorder, drop them between boards, or toss them onto the floating Upcoming button to hide them until you&apos;re ready.</li>
              <li>Open a task to reorder subtasks, paste images, set advanced recurrence, track streaks, and attach optional bounties.</li>
            </ul>
          </div>
        ),
      },
      {
        title: "Shape your workspace",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">Settings are grouped so you can personalize the layout without hunting around.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Adjust font size, accent color, start-of-week, and Completed tab behavior from Settings → View.</li>
              <li>Pick inline add boxes, default task position, and per-day start boards to match how you plan.</li>
              <li>Manage boards from Settings → Boards &amp; Lists: reorder, archive via drag, or join shared boards with an ID.</li>
            </ul>
          </div>
        ),
      },
      {
        title: "Lightning ecash tools",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">The 💰 button opens your upgraded Cashu wallet with Lightning superpowers.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Track balances in sats or USD (toggle conversions in Settings → Wallet) and switch units from the wallet header.</li>
              <li>Scan QR codes to receive eCash, LNURL withdraws, Lightning invoices, or addresses without leaving the app.</li>
              <li>Save Lightning contacts, reuse them when paying, and fund task bounties or NWC withdrawals in a couple taps.</li>
              <li>Receive, Send, and Scan flows let you create shareable tokens, pay invoices, or move sats with Nostr Wallet Connect without leaving the app.</li>
            </ul>
            <p className="text-tertiary">Bounties on tasks reflect any ecash rewards you attach.</p>
          </div>
        ),
      },
      {
        title: "Back up your nsec",
        body: (
          <div className="space-y-3 text-sm text-secondary">
            <p className="text-primary">
              Your Nostr private key (nsec) lives only on this device. It unlocks shared boards, wallet connections, and future recoveries.
            </p>
            <p>Copy it now or later from Settings → Nostr and store it in a secure password manager.</p>
            <div>
              <button
                className="accent-button button-sm pressable"
                onClick={handleCopyNsec}
              >
                Copy my nsec
              </button>
            </div>
            <p className="text-tertiary">Skipping is okay—you can always copy it from Settings when you&apos;re ready.</p>
          </div>
        ),
      },
    ],
    [handleCopyNsec]
  );

  useEffect(() => {
    if (tutorialComplete || tutorialStep !== null) return;
    const hasTasks = tasks.length > 0;
    const hasCustomBoards = boards.some((b) => b.id !== "week-default" || b.kind !== "week");
    let hasHistory = false;
    try {
      const raw = localStorage.getItem("cashuHistory");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) hasHistory = true;
      }
    } catch {}
    if (!hasTasks && !hasCustomBoards && !hasHistory) {
      setTutorialStep(0);
    }
  }, [boards, tasks, tutorialComplete, tutorialStep]);

  const handleSkipTutorial = useCallback(() => {
    markTutorialDone();
  }, [markTutorialDone]);

  const handleNextTutorial = useCallback(() => {
    if (tutorialStep === null) return;
    if (tutorialStep >= tutorialSteps.length - 1) {
      markTutorialDone();
    } else {
      setTutorialStep(tutorialStep + 1);
    }
  }, [markTutorialDone, tutorialStep, tutorialSteps.length]);

  const handlePrevTutorial = useCallback(() => {
    setTutorialStep((prev) => {
      if (prev === null || prev <= 0) return prev;
      return prev - 1;
    });
  }, []);

  const handleRestartTutorial = useCallback(() => {
    try {
      localStorage.removeItem(LS_TUTORIAL_DONE);
    } catch {}
    setTutorialComplete(false);
    setTutorialStep(0);
    setShowSettingsState(false);
  }, []);

  useEffect(() => {
    if (!settings.completedTab) setView("board");
  }, [settings.completedTab]);

  useEffect(() => {
    if (!settings.bibleTrackerEnabled && view === "bible") {
      setView("board");
    }
  }, [settings.bibleTrackerEnabled, view]);

  const handleToggleBibleBook = useCallback((bookId: string) => {
    const normalizedBookId = String(bookId || "");
    if (!normalizedBookId) return;
    setBibleTracker((prev) => {
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
    });
  }, [setBibleTracker]);

  const handleToggleBibleChapter = useCallback((bookId: string, chapter: number) => {
    const normalizedBookId = String(bookId || "");
    const normalizedChapter = Number.isFinite(chapter) ? Math.trunc(chapter) : NaN;
    if (!normalizedBookId || !Number.isFinite(normalizedChapter) || normalizedChapter <= 0) return;
    setBibleTracker((prev) => {
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
    });
  }, [setBibleTracker]);

  const handleUpdateBibleChapterVerses = useCallback((bookId: string, chapter: number, verses: number[], verseCount: number) => {
    const normalizedBookId = String(bookId || "");
    const normalizedChapter = Number.isFinite(chapter) ? Math.trunc(chapter) : NaN;
    if (!normalizedBookId || !Number.isFinite(normalizedChapter) || normalizedChapter <= 0) return;
    setBibleTracker((prev) => {
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
    });
  }, [setBibleTracker]);

  const handleResetBibleTracker = useCallback(() => {
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm("Reset your Bible reading progress? This archives your current progress and clears the tracker.");
    }
    if (!confirmed) return;
    setBibleTracker((prev) => {
      const nowISO = new Date().toISOString();
      const snapshot = {
        id: crypto.randomUUID(),
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
    });
  }, [setBibleTracker]);

  const handleDeleteBibleArchive = useCallback((archiveId: string) => {
    if (!archiveId) return;
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm("Delete this archived progress snapshot?");
    }
    if (!confirmed) return;
    setBibleTracker((prev) => {
      const nextArchive = prev.archive.filter((entry) => entry.id !== archiveId);
      if (nextArchive.length === prev.archive.length) return prev;
      return { ...prev, archive: nextArchive };
    });
  }, [setBibleTracker]);

  const handleRestoreBibleArchive = useCallback((archiveId: string) => {
    if (!archiveId) return;
    let confirmed = true;
    if (typeof window !== "undefined" && typeof window.confirm === "function") {
      confirmed = window.confirm("Restore this archived Bible reading progress? This will replace your current progress.");
    }
    if (!confirmed) return;
    setBibleTracker((prev) => {
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
    });
  }, [setBibleTracker]);

  const handleCompleteBibleBook = useCallback(
    (bookId: string, rect?: DOMRect | null) => {
      const normalizedBookId = String(bookId || "");
      if (!normalizedBookId) return;
      let didComplete = false;
      setBibleTracker((prev) => {
        const totalChapters = getBibleBookChapterCount(normalizedBookId) ?? 0;
        if (totalChapters <= 0) return prev;
        const chaptersRead = prev.progress[normalizedBookId] ?? [];
        if (!Array.isArray(chaptersRead) || chaptersRead.length < totalChapters) {
          return prev;
        }
        if (prev.completedBooks?.[normalizedBookId]) {
          return prev;
        }
        const nextCompletedBooks = {
          ...prev.completedBooks,
          [normalizedBookId]: { completedAtISO: new Date().toISOString() },
        };
        const nextExpanded = { ...prev.expandedBooks };
        if (nextExpanded[normalizedBookId]) {
          delete nextExpanded[normalizedBookId];
        }
        didComplete = true;
        return { ...prev, completedBooks: nextCompletedBooks, expandedBooks: nextExpanded };
      });
      if (didComplete && rect && settings.completedTab) {
        try {
          flyToCompleted(rect);
        } catch {}
      }
    },
    [setBibleTracker, settings.completedTab]
  );

  const handleRestoreBibleBook = useCallback((bookId: string) => {
    const normalizedBookId = String(bookId || "");
    if (!normalizedBookId) return;
    setBibleTracker((prev) => {
      if (!prev.completedBooks?.[normalizedBookId]) return prev;
      const nextCompletedBooks = { ...prev.completedBooks };
      delete nextCompletedBooks[normalizedBookId];
      return { ...prev, completedBooks: nextCompletedBooks };
    });
  }, [setBibleTracker]);

  // add bar
  const newTitleRef = useRef<HTMLInputElement>(null);
  const newDocumentInputRef = useRef<HTMLInputElement>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newImages, setNewImages] = useState<string[]>([]);
  const [newDocuments, setNewDocuments] = useState<TaskDocument[]>([]);
  const [dayChoice, setDayChoiceRaw] = useState<DayChoice>(() => {
    const firstBoard = boards.find(b => !b.archived) ?? boards[0];
    if (firstBoard?.kind === "lists") {
      return (firstBoard as Extract<Board, {kind:"lists"}>).columns[0]?.id || "items";
    }
    return new Date().getDay() as Weekday;
  });
  const dayChoiceRef = useRef<DayChoice>(dayChoice);
  const setDayChoice = useCallback((next: DayChoice) => {
    dayChoiceRef.current = next;
    setDayChoiceRaw(next);
  }, []);
  const lastListViewRef = useRef<Map<string, string>>(new Map());
  const lastBoardScrollRef = useRef<Map<string, number>>(new Map());
  const autoCenteredIndexRef = useRef<Set<string>>(new Set());
  const autoCenteredWeekRef = useRef<Set<string>>(new Set());
  const activeWeekBoardRef = useRef<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState<string>("");
  const [scheduleTime, setScheduleTime] = useState<string>("");
  const [pushWorkState, setPushWorkState] = useState<"idle" | "enabling" | "disabling">("idle");
  const [pushError, setPushError] = useState<string | null>(null);
  const [inlineTitles, setInlineTitles] = useState<Record<string, string>>({});
  const [pendingFocusColumnId, setPendingFocusColumnId] = useState<string | null>(null);
  const [renamingColumnId, setRenamingColumnId] = useState<string | null>(null);
  const [columnDrafts, setColumnDrafts] = useState<Record<string, string>>({});
  const [newColumnIds, setNewColumnIds] = useState<Record<string, boolean>>({});
  const columnNameInputRefs = useRef<Map<string, HTMLInputElement | null>>(new Map());
  const setColumnNameInputRef = useCallback((colId: string, el: HTMLInputElement | null) => {
    columnNameInputRefs.current.set(colId, el);
  }, []);
  useEffect(() => {
    setRenamingColumnId(null);
    setColumnDrafts({});
    setNewColumnIds({});
  }, [currentBoard?.id]);
  useEffect(() => {
    if (!renamingColumnId) return;
    const input = columnNameInputRefs.current.get(renamingColumnId);
    if (!input) return;
    const timeout = window.setTimeout(() => {
      input.focus();
      input.select();
    }, 50);
    return () => window.clearTimeout(timeout);
  }, [renamingColumnId]);
  const [previewDocument, setPreviewDocument] = useState<TaskDocument | null>(null);
  const handleDownloadDocument = useCallback(async (doc: TaskDocument) => {
    if (typeof window === "undefined") return;
    try {
      const response = await fetch(doc.dataUrl);
      const blob = await response.blob();
      const fileName =
        doc.name ||
        `attachment.${doc.kind === "docx" ? "docx" : doc.kind === "xlsx" ? "xlsx" : doc.kind}`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      showToast("Failed to download document. Try opening it in a new tab.");
    }
  }, [showToast]);

  const openDocumentExternally = useCallback((doc: TaskDocument) => {
    if (typeof window === "undefined") return;
    window.location.assign(doc.dataUrl);
  }, []);

  const handleOpenDocument = useCallback((_task: Task, doc: TaskDocument) => {
    if (doc.kind === "pdf") {
      handleDownloadDocument(doc);
      return;
    }
    setPreviewDocument(doc);
  }, [handleDownloadDocument]);

  function handleBoardChanged(boardId: string, options?: { board?: Board; republishTasks?: boolean }) {
    const board = options?.board ?? boards.find((x) => x.id === boardId);
    if (!board) return;
    publishBoardMetadata(board).catch(() => {});
    if (options?.republishTasks) {
      tasks
        .filter((t) => t.boardId === boardId)
        .forEach((t) => {
          maybePublishTask(t, board, { skipBoardMetadata: true }).catch(() => {});
        });
    }
  }

  function addListColumn(boardId: string, name?: string): string | null {
    const board = boards.find((b) => b.id === boardId && b.kind === "lists");
    if (!board) return null;
    const colName = name?.trim() ? name.trim() : `List ${board.columns.length + 1}`;
    const col: ListColumn = { id: crypto.randomUUID(), name: colName };
    const updated: Board = { ...board, columns: [...board.columns, col] };
    setBoards((prev) => prev.map((b) => (b.id === boardId ? updated : b)));
    if (updated.nostr) {
      setTimeout(() => handleBoardChanged(updated.id, { board: updated }), 0);
    }
    return col.id;
  }

  function renameListColumn(boardId: string, columnId: string, name: string): boolean {
    const board = boards.find((b) => b.id === boardId && b.kind === "lists");
    if (!board) return false;
    const trimmed = name.trim() || undefined;
    let didChange = false;
    const updated: Board = {
      ...board,
      columns: board.columns.map((col) => {
        if (col.id !== columnId) return col;
        const nextName = trimmed ?? col.name;
        if (nextName === col.name) return col;
        didChange = true;
        return { ...col, name: nextName };
      }),
    };
    if (!didChange) return true;
    setBoards((prev) => prev.map((b) => (b.id === boardId ? updated : b)));
    if (updated.nostr) {
      setTimeout(() => handleBoardChanged(updated.id, { board: updated }), 0);
    }
    return true;
  }

  const clearColumnEditingState = useCallback((columnId: string) => {
    setRenamingColumnId((prev) => (prev === columnId ? null : prev));
    setColumnDrafts((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
  }, []);

  const removeListColumn = useCallback(
    (boardId: string, columnId: string) => {
      const board = boards.find((b) => b.id === boardId && b.kind === "lists");
      if (!board) return;
      const updatedColumns = board.columns.filter((col) => col.id !== columnId);
      if (updatedColumns.length === board.columns.length) return;
      const updatedBoard: Board = { ...board, columns: updatedColumns };
      setBoards((prev) => prev.map((b) => (b.id === boardId ? updatedBoard : b)));
      setTasks((prev) => prev.filter((task) => !(task.boardId === boardId && task.columnId === columnId)));
      setNewColumnIds((prev) => {
        const next = { ...prev };
        delete next[columnId];
        return next;
      });
      clearColumnEditingState(columnId);
      if (updatedBoard.nostr) {
        setTimeout(() => handleBoardChanged(updatedBoard.id, { board: updatedBoard }), 0);
      }
    },
    [boards, clearColumnEditingState, handleBoardChanged, setBoards, setTasks],
  );

  function handleBoardSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    if (shouldReloadForNavigation()) return;
    const val = e.target.value;
    if (val === BIBLE_BOARD_ID) {
      if (view !== "completed") setView("bible");
    } else if (view === "bible") {
      setView("board");
    }
    changeBoard(val);
  }

  const handleQuickAddList = useCallback(() => {
    if (!currentBoard || currentBoard.kind !== "lists") return;
    const createdId = addListColumn(currentBoard.id, undefined);
    if (createdId) {
      setPendingFocusColumnId(createdId);
      const nextName = `List ${currentBoard.columns.length + 1}`;
      setColumnDrafts((prev) => ({ ...prev, [createdId]: nextName }));
      setNewColumnIds((prev) => ({ ...prev, [createdId]: true }));
      setRenamingColumnId(createdId);
      showToast("List added");
    } else {
      showToast("Failed to add list. Try again.");
    }
  }, [addListColumn, currentBoard, showToast]);

  // recurrence select (with Custom… option)
  const [quickRule, setQuickRule] = useState<
    "none" | "daily" | "weeklyMonFri" | "weeklyWeekends" | "every2d" | "custom"
  >("none");
  const [addCustomRule, setAddCustomRule] = useState<Recurrence>(R_NONE);
  const [showAddAdvanced, setShowAddAdvanced] = useState(false);

  // edit modal
  const [editing, setEditing] = useState<Task | null>(null);

  // undo snackbar
  const [undoTask, setUndoTask] = useState<Task | null>(null);

  // drag-to-delete
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [upcomingHover, setUpcomingHover] = useState(false);
  const [boardDropOpen, setBoardDropOpen] = useState(false);
  const [boardDropPos, setBoardDropPos] = useState<{ top: number; left: number } | null>(null);
  const boardDropTimer = useRef<number>();
  const boardDropCloseTimer = useRef<number>();

  function scheduleBoardDropClose() {
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
    boardDropCloseTimer.current = window.setTimeout(() => {
      setBoardDropOpen(false);
      setBoardDropPos(null);
      boardDropCloseTimer.current = undefined;
    }, 100);
  }

  function cancelBoardDropClose() {
    if (boardDropCloseTimer.current) {
      window.clearTimeout(boardDropCloseTimer.current);
      boardDropCloseTimer.current = undefined;
    }
  }

  function handleDragEnd() {
    setDraggingTaskId(null);
    setTrashHover(false);
    setUpcomingHover(false);
    setBoardDropOpen(false);
    setBoardDropPos(null);
    if (boardDropTimer.current) window.clearTimeout(boardDropTimer.current);
    if (boardDropCloseTimer.current) window.clearTimeout(boardDropCloseTimer.current);
  }

  // upcoming drawer (out-of-the-way FAB)
  const [showUpcoming, setShowUpcomingState] = useState(false);
  useEffect(() => {
    if (view === "bible" && showUpcoming) {
      setShowUpcomingState(false);
    }
  }, [view, showUpcoming]);

  // fly-to-completed overlay + target
  const flyLayerRef = useRef<HTMLDivElement>(null);
  const completedTabRef = useRef<HTMLButtonElement>(null);
  // wallet button target for coin animation
  const boardSelectorRef = useRef<HTMLSelectElement>(null);
  const walletButtonRef = useRef<HTMLButtonElement>(null);
  const boardDropContainerRef = useRef<HTMLDivElement>(null);
  const boardDropListRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const upcomingButtonRef = useRef<HTMLButtonElement>(null);
  const columnRefs = useRef(new Map<string, HTMLDivElement>());
  const inlineInputRefs = useRef(new Map<string, HTMLInputElement>());

  const setColumnRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) columnRefs.current.set(key, el);
    else columnRefs.current.delete(key);
  }, []);

  const setInlineInputRef = useCallback((key: string, el: HTMLInputElement | null) => {
    if (el) inlineInputRefs.current.set(key, el);
    else inlineInputRefs.current.delete(key);
  }, []);

  const scrollColumnIntoView = useCallback((key: string, behavior: ScrollBehavior = "smooth") => {
    const scroller = scrollerRef.current;
    const column = columnRefs.current.get(key);
    if (!scroller || !column) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const columnRect = column.getBoundingClientRect();
    const offset =
      scroller.scrollLeft +
      (columnRect.left - scrollerRect.left) -
      scroller.clientWidth / 2 +
      column.clientWidth / 2;
    const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const target = Math.min(Math.max(offset, 0), maxScroll);
    scroller.scrollTo({ left: target, behavior });
  }, []);

  // Custom list boards (including compound boards aggregating multiple lists)
  const { listColumns, listColumnSources, compoundIndexGroups } = useMemo(() => {
    const sourceMap = new Map<string, { boardId: string; columnId: string; boardName: string }>();
    if (!isListLikeBoard(currentBoard)) {
      return {
        listColumns: [] as ListColumn[],
        listColumnSources: sourceMap,
        compoundIndexGroups: [] as CompoundIndexGroup[],
      };
    }
    if (currentBoard.kind === "lists") {
      currentBoard.columns.forEach((col) => {
        sourceMap.set(col.id, { boardId: currentBoard.id, columnId: col.id, boardName: currentBoard.name });
      });
      return {
        listColumns: currentBoard.columns,
        listColumnSources: sourceMap,
        compoundIndexGroups: [] as CompoundIndexGroup[],
      };
    }
    const hideChildNames = currentBoard.kind === "compound" && currentBoard.hideChildBoardNames;
    const columns: ListColumn[] = [];
    const groups: CompoundIndexGroup[] = [];
    const groupMap = new Map<string, CompoundIndexGroup>();
    const processedChildren = new Set<string>();
    for (const childId of currentBoard.children) {
      const child = findBoardByCompoundChildId(boards, childId);
      if (!child || child.kind !== "lists") continue;
      if (processedChildren.has(child.id)) {
        continue;
      }
      processedChildren.add(child.id);
      let group = groupMap.get(child.id);
      if (!group) {
        group = {
          key: child.id,
          boardId: child.id,
          boardName: child.name,
          columns: [],
        };
        groupMap.set(child.id, group);
        groups.push(group);
      }
      for (const col of child.columns) {
        const title = hideChildNames ? col.name : `${child.name} • ${col.name}`;
        const canonicalKey = compoundColumnKey(child.id, col.id);
        if (!sourceMap.has(canonicalKey)) {
          columns.push({ id: canonicalKey, name: title });
        }
        sourceMap.set(canonicalKey, { boardId: child.id, columnId: col.id, boardName: child.name });
        if (!group.columns.some((entry) => entry.id === canonicalKey)) {
          group.columns.push({ id: canonicalKey, name: col.name });
        }
        const sharedId = child.nostr?.boardId;
        if (sharedId) {
          const aliasKey = compoundColumnKey(sharedId, col.id);
          if (!sourceMap.has(aliasKey)) {
            sourceMap.set(aliasKey, { boardId: child.id, columnId: col.id, boardName: child.name });
          }
        }
      }
    }
    return { listColumns: columns, listColumnSources: sourceMap, compoundIndexGroups: groups };
  }, [boards, currentBoard]);

  const focusListColumn = useCallback(
    (columnId: string, options?: { behavior?: ScrollBehavior }) => {
      if (!currentBoard || !isListLikeBoard(currentBoard)) return;
      if (!listColumnSources.has(columnId)) return;
      setDayChoice(columnId);
      requestAnimationFrame(() => {
        scrollColumnIntoView(`list-${columnId}`, options?.behavior ?? "smooth");
      });
    },
    [currentBoard, listColumnSources, scrollColumnIntoView, setDayChoice],
  );

  const cancelRenameColumn = useCallback((columnId: string) => {
    if (currentBoard?.kind === "lists" && newColumnIds[columnId]) {
      removeListColumn(currentBoard.id, columnId);
      return;
    }
    clearColumnEditingState(columnId);
  }, [clearColumnEditingState, currentBoard, newColumnIds, removeListColumn]);

  const commitRenameColumn = useCallback((columnId: string) => {
    if (!currentBoard || currentBoard.kind !== "lists") return;
    const nextName = columnDrafts[columnId] ?? "";
    renameListColumn(currentBoard.id, columnId, nextName);
    setNewColumnIds((prev) => {
      const next = { ...prev };
      delete next[columnId];
      return next;
    });
    clearColumnEditingState(columnId);
  }, [clearColumnEditingState, columnDrafts, currentBoard, renameListColumn]);

  useEffect(() => {
    if (!pendingFocusColumnId) return;
    if (view !== "board") {
      setPendingFocusColumnId(null);
      return;
    }
    if (!currentBoardId || !isListBoard) {
      setPendingFocusColumnId(null);
      return;
    }
    if (!listColumnSources.has(pendingFocusColumnId)) return;
    focusListColumn(pendingFocusColumnId, { behavior: "smooth" });
    setPendingFocusColumnId(null);
  }, [pendingFocusColumnId, view, currentBoardId, isListBoard, listColumnSources, focusListColumn]);
  function flyToCompleted(from: DOMRect) {
    const layer = flyLayerRef.current;
    const targetEl = completedTabRef.current;
    if (!layer || !targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;

    const rem = (() => {
      try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
    })();
    const dotSize = 1.25 * rem; // 20px @ 16px base
    const dotFont = 0.875 * rem; // 14px @ 16px base

    const rootStyles = getComputedStyle(document.documentElement);
    const accent = rootStyles.getPropertyValue("--accent").trim() || "#34c759";
    const accentSoft = rootStyles.getPropertyValue("--accent-soft").trim() || "rgba(52, 199, 89, 0.28)";
    const accentOn = rootStyles.getPropertyValue("--accent-on").trim() || "#0a1f12";

    const dot = document.createElement('div');
    dot.style.position = 'fixed';
    dot.style.left = `${startX - dotSize / 2}px`;
    dot.style.top = `${startY - dotSize / 2}px`;
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.borderRadius = '9999px';
    dot.style.background = accent;
    dot.style.color = accentOn || '#ffffff';
    dot.style.display = 'grid';
    dot.style.placeItems = 'center';
    dot.style.fontSize = `${dotFont}px`;
    dot.style.lineHeight = `${dotSize}px`;
    dot.style.boxShadow = `0 0 0 2px ${accentSoft || 'rgba(16,185,129,0.3)'}, 0 6px 16px rgba(0,0,0,0.35)`;
    dot.style.zIndex = '1000';
    dot.style.transform = 'translate(0, 0) scale(1)';
    dot.style.transition = 'transform 600ms cubic-bezier(.2,.7,.3,1), opacity 300ms ease 420ms';
    dot.textContent = '✓';
    layer.appendChild(dot);

    requestAnimationFrame(() => {
      const dx = endX - startX;
      const dy = endY - startY;
      dot.style.transform = `translate(${dx}px, ${dy}px) scale(0.5)`;
      dot.style.opacity = '0.6';
      setTimeout(() => {
        try { layer.removeChild(dot); } catch {}
      }, 750);
    });
  }

  function flyCoinsToWallet(from: DOMRect) {
    const layer = flyLayerRef.current;
    const targetEl = walletButtonRef.current;
    if (!layer || !targetEl) return;
    const target = targetEl.getBoundingClientRect();

    const startX = from.left + from.width / 2;
    const startY = from.top + from.height / 2;
    const endX = target.left + target.width / 2;
    const endY = target.top + target.height / 2;

    const rem = (() => {
      try { return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16; } catch { return 16; }
    })();
    const coinSize = 1.25 * rem; // 20px @ 16px base
    const coinFont = 0.875 * rem; // 14px @ 16px base

    const makeCoin = () => {
      const coin = document.createElement('div');
      coin.style.position = 'fixed';
      coin.style.left = `${startX - coinSize / 2}px`;
      coin.style.top = `${startY - coinSize / 2}px`;
      coin.style.width = `${coinSize}px`;
      coin.style.height = `${coinSize}px`;
      coin.style.borderRadius = '9999px';
      coin.style.display = 'grid';
      coin.style.placeItems = 'center';
      coin.style.fontSize = `${coinFont}px`;
      coin.style.lineHeight = `${coinSize}px`;
      coin.style.background = 'radial-gradient(circle at 30% 30%, #fde68a, #f59e0b)';
      coin.style.boxShadow = '0 0 0 1px rgba(245,158,11,0.5), 0 6px 16px rgba(0,0,0,0.35)';
      coin.style.zIndex = '1000';
      coin.style.transform = 'translate(0, 0) scale(1)';
      coin.style.transition = 'transform 700ms cubic-bezier(.2,.7,.3,1), opacity 450ms ease 450ms';
      coin.textContent = '🪙';
      return coin;
    };

    for (let i = 0; i < 3; i++) {
      const coin = makeCoin();
      layer.appendChild(coin);
      const dx = endX - startX;
      const dy = endY - startY;
      // slight horizontal variance per coin
      const wobble = (i - 1) * (0.5 * rem); // -0.5rem, 0, +0.5rem
      setTimeout(() => {
        coin.style.transform = `translate(${dx + wobble}px, ${dy}px) scale(0.6)`;
        coin.style.opacity = '0.35';
        setTimeout(() => {
          try { layer.removeChild(coin); } catch {}
        }, 800);
      }, i * 140);
    }
  }

  function flyNewTask(
    from: DOMRect | null,
    dest:
      | { type: "column"; key: string; label: string }
      | { type: "upcoming"; label: string }
  ) {
    const layer = flyLayerRef.current;
    if (!layer) return;
    if (typeof window === "undefined") return;
    try {
      if (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        return;
      }
    } catch {}

    requestAnimationFrame(() => {
      const targetEl =
        dest.type === "column"
          ? columnRefs.current.get(dest.key) || null
          : upcomingButtonRef.current;
      if (!targetEl) return;

      const targetRect = targetEl.getBoundingClientRect();
      const startRect = from ?? targetRect;
      const startX = startRect.left + startRect.width / 2;
      const startY = startRect.top + startRect.height / 2;
      const endX = targetRect.left + targetRect.width / 2;
      const endY =
        dest.type === "column"
          ? targetRect.top + Math.min(targetRect.height / 2, 56)
          : targetRect.top + targetRect.height / 2;

      const card = document.createElement("div");
      const text = (dest.label || "Task").trim();
      const truncated = text.length > 60 ? `${text.slice(0, 57)}…` : text || "Task";
      const widthSource = from ? from.width : startRect.width;
      const cardWidth = Math.max(Math.min(widthSource * 0.55, 280), 150);
      card.className = `fly-task-card ${
        dest.type === "column" ? "fly-task-card--board" : "fly-task-card--upcoming"
      }`;
      card.style.position = "fixed";
      card.style.left = `${startX}px`;
      card.style.top = `${startY}px`;
      card.style.width = `${cardWidth}px`;
      card.style.transform = "translate(-50%, -50%) scale(0.92)";
      card.style.opacity = "0.98";
      card.style.pointerEvents = "none";
      card.style.zIndex = "1000";
      card.style.boxShadow =
        dest.type === "column"
          ? "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(16,185,129,0.2)"
          : "0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(63,63,70,0.45), 0 12px 26px rgba(59,130,246,0.2)";
      card.style.willChange = "transform, left, top, opacity";

      const body = document.createElement("div");
      body.className = "fly-task-card__body";

      const titleEl = document.createElement("div");
      titleEl.className = "fly-task-card__title";
      titleEl.textContent = truncated;
      body.appendChild(titleEl);

      card.appendChild(body);
      layer.appendChild(card);

      const pulseClass =
        dest.type === "column" ? "fly-target-pulse-board" : "fly-target-pulse-upcoming";
      targetEl.classList.add(pulseClass);
      window.setTimeout(() => {
        try {
          targetEl.classList.remove(pulseClass);
        } catch {}
      }, 650);

      requestAnimationFrame(() => {
        card.style.left = `${endX}px`;
        card.style.top = `${endY}px`;
        card.style.transform = "translate(-50%, -50%) scale(0.75)";
        card.style.opacity = "0";
        window.setTimeout(() => {
          try {
            layer.removeChild(card);
          } catch {}
        }, 700);
      });
    });
  }

  function animateTaskArrival(from: DOMRect | null, task: Task, board: Board) {
    if (!board || task.completed) return;
    const labelSource = task.title || (task.images?.length ? "Image" : task.documents?.[0]?.name || "");
    const label = labelSource.trim() || "Task";
    if (!isVisibleNow(task)) {
      flyNewTask(from, { type: "upcoming", label });
      return;
    }

    if (board.kind === "week") {
      const due = new Date(task.dueISO);
      if (Number.isNaN(due.getTime())) return;
      const key = task.column === "bounties"
        ? "week-bounties"
        : `week-day-${due.getDay()}`;
      flyNewTask(from, { type: "column", key, label });
    } else if (isListLikeBoard(board) && task.columnId) {
      let columnKey: string | null = null;
      if (board.kind === "compound") {
        const source = listColumnSources.get(compoundColumnKey(task.boardId, task.columnId));
        if (source) {
          columnKey = compoundColumnKey(source.boardId, source.columnId);
        }
      } else {
        columnKey = task.columnId;
      }
      if (columnKey) {
        flyNewTask(from, { type: "column", key: `list-${columnKey}`, label });
      }
    }
  }

  /* ---------- Derived: board-scoped lists ---------- */
  const tasksForBoard = useMemo(() => {
    if (!currentBoard) return [] as Task[];
    const scope = new Set(boardScopeIds(currentBoard, boards));
    return tasks
      .filter(t => scope.has(t.boardId))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [boards, tasks, currentBoard]);

  // Week board
  const byDay = useMemo(() => {
    if (!currentBoard || currentBoard.kind !== "week") return new Map<Weekday, Task[]>();
    const visible = tasksForBoard.filter(t => {
      const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed";
      return ((!t.completed || pendingBounty || !settings.completedTab) && t.column !== "bounties" && isVisibleNow(t));
    });
    const m = new Map<Weekday, Task[]>();
    for (const t of visible) {
      const wd = new Date(t.dueISO).getDay() as Weekday;
      if (!m.has(wd)) m.set(wd, []);
      m.get(wd)!.push(t);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.completed === b.completed ? (a.order ?? 0) - (b.order ?? 0) : a.completed ? 1 : -1));
    }
    return m;
  }, [tasksForBoard, currentBoard, settings.completedTab]);

  const bounties = useMemo(
    () => currentBoard?.kind === "week"
      ? tasksForBoard
          .filter(t => {
            const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed";
            return ((!t.completed || pendingBounty || !settings.completedTab) && t.column === "bounties" && isVisibleNow(t));
          })
          .sort((a, b) => (a.completed === b.completed ? (a.order ?? 0) - (b.order ?? 0) : a.completed ? 1 : -1))
      : [],
    [tasksForBoard, currentBoard?.kind, settings.completedTab]
  );

  const itemsByColumn = useMemo(() => {
    if (!currentBoard || !isListLikeBoard(currentBoard)) return new Map<string, Task[]>();
    const m = new Map<string, Task[]>();
    for (const col of listColumns) m.set(col.id, []);
    for (const t of tasksForBoard) {
      const pendingBounty = t.completed && t.bounty && t.bounty.state !== "claimed";
      if (t.completed && !pendingBounty && settings.completedTab) continue;
      if (!t.columnId) continue;
      if (!isVisibleNow(t)) continue;

      let key: string | null = null;
      if (currentBoard.kind === "compound") {
        const source = listColumnSources.get(compoundColumnKey(t.boardId, t.columnId));
        if (!source) continue;
        key = compoundColumnKey(source.boardId, source.columnId);
      } else {
        if (!listColumnSources.has(t.columnId)) continue;
        key = t.columnId;
      }

      if (!key) continue;
      const arr = m.get(key);
      if (arr) arr.push(t);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.completed === b.completed ? (a.order ?? 0) - (b.order ?? 0) : a.completed ? 1 : -1));
    }
    return m;
  }, [currentBoard, listColumns, listColumnSources, settings.completedTab, tasksForBoard]);

  const resolveListPlacement = useCallback(
    (columnKey?: string | null) => {
      if (!currentBoard || !isListLikeBoard(currentBoard)) return null;
      if (currentBoard.kind === "lists") {
        const key = columnKey && listColumnSources.has(columnKey)
          ? columnKey
          : currentBoard.columns[0]?.id;
        if (!key) return null;
        return { boardId: currentBoard.id, columnId: key };
      }
      const key = columnKey && listColumnSources.has(columnKey)
        ? columnKey
        : listColumns[0]?.id;
      if (!key) return null;
      const source = listColumnSources.get(key);
      if (!source) return null;
      return { boardId: source.boardId, columnId: source.columnId };
    },
    [currentBoard, listColumnSources, listColumns],
  );

  const completed = useMemo(
    () =>
      tasksForBoard
        .filter((t) => t.completed && (!t.bounty || t.bounty.state === "claimed"))
        .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")),
    [tasksForBoard]
  );

  const completedBibleBooks = useMemo(() => {
    const entries = Object.entries(bibleTracker.completedBooks || {});
    return entries
      .map(([bookId, info]) => ({
        id: bookId,
        name: getBibleBookTitle(bookId) ?? bookId,
        completedAtISO: typeof info?.completedAtISO === "string" ? info.completedAtISO : "",
      }))
      .sort((a, b) => {
        const orderA = getBibleBookOrder(a.id);
        const orderB = getBibleBookOrder(b.id);
        if (orderA != null && orderB != null) {
          return orderA - orderB;
        }
        if (orderA != null) return -1;
        if (orderB != null) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [bibleTracker.completedBooks]);

  const upcoming = useMemo(
    () =>
      tasksForBoard
        .filter((t) => !t.completed && t.hiddenUntilISO && !isVisibleNow(t))
        .sort((a, b) => (a.hiddenUntilISO || "").localeCompare(b.hiddenUntilISO || "")),
    [tasksForBoard]
  );

  const editingBoard = useMemo(
    () => (editing ? boards.find((b) => b.id === editing.boardId) ?? null : null),
    [boards, editing]
  );

  const reminderTasks = useMemo(() => tasks.filter(taskHasReminders), [tasks]);
  const reminderPayloadRef = useRef<string | null>(null);

  useEffect(() => {
    const pushPrefs = settings.pushNotifications;
    if (!pushPrefs?.enabled || !pushPrefs.deviceId || !pushPrefs.subscriptionId) {
      reminderPayloadRef.current = null;
      return;
    }
    if (!workerBaseUrl) {
      return;
    }

    const remindersPayload = reminderTasks
      .map((task) => ({
        taskId: task.id,
        boardId: task.boardId,
        dueISO: task.dueISO,
        title: task.title,
        minutesBefore: (task.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    const payloadString = JSON.stringify(remindersPayload);
    if (reminderPayloadRef.current === payloadString) return;
    reminderPayloadRef.current = payloadString;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      syncRemindersToWorker(workerBaseUrl, pushPrefs, reminderTasks, { signal: controller.signal }).catch((err) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.error('Reminder sync failed', err);
        setPushError(err instanceof Error ? err.message : 'Failed to sync reminders');
      });
    }, 400);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [reminderTasks, settings.pushNotifications, workerBaseUrl]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const pushPrefs = settings.pushNotifications ?? DEFAULT_PUSH_PREFERENCES;
    const permission = typeof Notification !== 'undefined' ? Notification.permission : pushPrefs.permission;

    const applyUpdates = (patch: Partial<PushPreferences>): boolean => {
      const keys = Object.keys(patch) as (keyof PushPreferences)[];
      if (!keys.length) return false;
      let changed = false;
      for (const key of keys) {
        if (patch[key] !== (pushPrefs as any)[key]) {
          changed = true;
          break;
        }
      }
      if (!changed) return false;
      setSettings({ pushNotifications: { ...pushPrefs, ...patch } });
      return true;
    };

    const ensureDisabled = () => {
      const patch: Partial<PushPreferences> = {};
      if (pushPrefs.enabled) patch.enabled = false;
      if (pushPrefs.subscriptionId !== undefined) patch.subscriptionId = undefined;
      if (permission !== pushPrefs.permission) patch.permission = permission;
      const changed = applyUpdates(patch);
      if (changed) {
        reminderPayloadRef.current = null;
      }
    };

    if (!pushPrefs.enabled) {
      if (permission !== pushPrefs.permission) {
        applyUpdates({ permission });
      }
      return;
    }

    const pushApiSupported = 'serviceWorker' in navigator && 'PushManager' in window;
    if (!pushApiSupported) {
      ensureDisabled();
      return;
    }

    let cancelled = false;
    (async () => {
      let registration: ServiceWorkerRegistration | null | undefined;
      try {
        registration = typeof navigator.serviceWorker.getRegistration === 'function'
          ? await navigator.serviceWorker.getRegistration()
          : undefined;
      } catch {}
      if (!registration) {
        try {
          registration = await navigator.serviceWorker.ready;
        } catch {}
      }
      if (cancelled) return;
      if (!registration) {
        ensureDisabled();
        return;
      }

      let subscription: PushSubscription | null = null;
      try {
        subscription = await registration.pushManager.getSubscription();
      } catch {}
      if (cancelled) return;
      if (!subscription || permission !== 'granted') {
        ensureDisabled();
        return;
      }

      if (permission !== pushPrefs.permission) {
        applyUpdates({ permission });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [setSettings, settings.pushNotifications]);

  /* ---------- Helpers ---------- */
  function resolveQuickRule(): Recurrence {
    switch (quickRule) {
      case "none": return R_NONE;
      case "daily": return { type: "daily" };
      case "weeklyMonFri": return { type: "weekly", days: [1,2,3,4,5] };
      case "weeklyWeekends": return { type: "weekly", days: [0,6] };
      case "every2d": return { type: "every", n: 2, unit: "day" };
      case "custom": return addCustomRule;
    }
  }

  // --------- Nostr helpers
  const tagValue = useCallback((ev: NostrEvent, name: string): string | undefined => {
    const t = ev.tags.find((x) => x[0] === name);
    return t ? t[1] : undefined;
  }, []);
  const isShared = (board: Board) => !!board.nostr?.boardId;
  const getBoardRelays = useCallback((board: Board): string[] => {
    return (board.nostr?.relays?.length ? board.nostr!.relays : defaultRelays).filter(Boolean);
  }, [defaultRelays]);
  async function publishBoardMetadata(board: Board) {
    if (!board.nostr?.boardId) return;
    const relays = getBoardRelays(board);
    const idTag = boardTag(board.nostr.boardId);
    const tags: string[][] = [["d", idTag],["b", idTag],["k", board.kind],["name", board.name]];
    const payload: any = { clearCompletedDisabled: !!board.clearCompletedDisabled };
    if (board.kind === "lists") {
      payload.columns = board.columns;
      payload.listIndex = !!board.indexCardEnabled;
    } else if (board.kind === "compound") {
      const childBoardIds = board.children
        .map((childId) => {
          const child = findBoardByCompoundChildId(boardsRef.current, childId);
          const canonicalId = child?.nostr?.boardId || child?.id || childId;
          return typeof canonicalId === "string" ? canonicalId : "";
        })
        .filter((childId) => !!childId);
      payload.children = childBoardIds;
      payload.listIndex = !!board.indexCardEnabled;
      payload.hideBoardNames = !!board.hideChildBoardNames;
    }
    const raw = JSON.stringify(payload);
    const content = await encryptToBoard(board.nostr.boardId, raw);
    const createdAt = await nostrPublish(relays, {
      kind: 30300,
      tags,
      content,
      created_at: Math.floor(Date.now() / 1000),
    });
    nostrIdxRef.current.boardMeta.set(idTag, createdAt);
  }
  async function publishTaskDeleted(t: Task) {
    const b = boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${t.id}`;
    pendingNostrTasksRef.current.add(pendingKey);
    try {
      await publishBoardMetadata(b);
      const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
      const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status","deleted"]];
      const raw = JSON.stringify({
        title: t.title,
        note: t.note || "",
        dueISO: t.dueISO,
        completedAt: t.completedAt,
        recurrence: t.recurrence,
        hiddenUntilISO: t.hiddenUntilISO,
        streak: t.streak,
        longestStreak: t.longestStreak,
        subtasks: t.subtasks,
        seriesId: t.seriesId,
        documents: t.documents,
      });
      const content = await encryptToBoard(boardId, raw);
      const createdAt = await nostrPublish(relays, {
        kind: 30301,
        tags,
        content,
        created_at: Math.floor(Date.now() / 1000),
      });
      if (!nostrIdxRef.current.taskClock.has(bTag)) {
        nostrIdxRef.current.taskClock.set(bTag, new Map());
      }
      nostrIdxRef.current.taskClock.get(bTag)!.set(t.id, createdAt);
    } finally {
      pendingNostrTasksRef.current.delete(pendingKey);
    }
  }
  async function maybePublishTask(
    t: Task,
    boardOverride?: Board,
    options?: { skipBoardMetadata?: boolean }
  ) {
    const b = boardOverride || boards.find((x) => x.id === t.boardId);
    if (!b || !isShared(b) || !b.nostr) return;
    const relays = getBoardRelays(b);
    const boardId = b.nostr.boardId;
    const bTag = boardTag(boardId);
    const pendingKey = `${bTag}::${t.id}`;
    pendingNostrTasksRef.current.add(pendingKey);
    const status = t.completed ? "done" : "open";
    const colTag = (b.kind === "week") ? (t.column === "bounties" ? "bounties" : "day") : (t.columnId || "");
    const tags: string[][] = [["d", t.id],["b", bTag],["col", String(colTag)],["status", status]];
    const normalizedBounty = normalizeBounty(t.bounty);
    const body: any = { title: t.title, note: t.note || "", dueISO: t.dueISO, completedAt: t.completedAt, completedBy: t.completedBy, recurrence: t.recurrence, hiddenUntilISO: t.hiddenUntilISO, createdBy: t.createdBy, order: t.order, streak: t.streak, longestStreak: t.longestStreak, seriesId: t.seriesId };
    body.dueTimeEnabled = typeof t.dueTimeEnabled === 'boolean' ? t.dueTimeEnabled : null;
    // Reminders are device-specific and should not be published to shared boards.
    // Include explicit nulls to signal removals when undefined
    body.images = (typeof t.images === 'undefined') ? null : t.images;
    body.documents = (typeof t.documents === 'undefined') ? null : t.documents;
    body.bounty = (typeof t.bounty === 'undefined') ? null : (normalizedBounty ?? null);
    body.subtasks = (typeof t.subtasks === 'undefined') ? null : t.subtasks;
    try {
      if (!options?.skipBoardMetadata) {
        await publishBoardMetadata(b);
      }
      const raw = JSON.stringify(body);
      const content = await encryptToBoard(boardId, raw);
      const createdAt = await nostrPublish(relays, {
        kind: 30301,
        tags,
        content,
        created_at: Math.floor(Date.now() / 1000),
      });
      // Update local task clock so immediate refreshes don't revert state
      if (!nostrIdxRef.current.taskClock.has(bTag)) {
        nostrIdxRef.current.taskClock.set(bTag, new Map());
      }
      nostrIdxRef.current.taskClock.get(bTag)!.set(t.id, createdAt);
    } finally {
      pendingNostrTasksRef.current.delete(pendingKey);
    }
  }

  maybePublishTaskRef.current = maybePublishTask;

  function regenerateBoardId(id: string) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== id || !b.nostr) return b;
      const nb: Board = { ...b, nostr: { ...b.nostr, boardId: crypto.randomUUID() } };
      updated = nb;
      return nb;
    }));
    if (updated) {
      setTimeout(() => {
        publishBoardMetadata(updated!).catch(() => {});
        tasks
          .filter(t => t.boardId === updated!.id)
          .forEach(t => { maybePublishTask(t, updated!, { skipBoardMetadata: true }).catch(() => {}); });
      }, 0);
    }
  }
  const applyBoardEvent = useCallback(async (ev: NostrEvent) => {
    const d = tagValue(ev, "d");
    if (!d) return;
    const last = nostrIdxRef.current.boardMeta.get(d) || 0;
    if (ev.created_at < last) return;
    // Accept events with the same timestamp to avoid missing updates
    nostrIdxRef.current.boardMeta.set(d, ev.created_at);
    const board = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === d);
    if (!board || !board.nostr) return;
    const boardId = board.nostr.boardId;
    const kindTag = tagValue(ev, "k");
    const name = tagValue(ev, "name");
    let payload: any = {};
    try {
      const dec = await decryptFromBoard(boardId, ev.content);
      payload = dec ? JSON.parse(dec) : {};
    } catch {
      try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    }
    setBoards((prev) => {
      const boardIndex = prev.findIndex((item) => item.id === board.id);
      if (boardIndex === -1) return prev;

      let working = prev.slice();
      const current = working[boardIndex];
      const nm = name || current.name;
      const clearCompletedDisabled =
        typeof payload?.clearCompletedDisabled === "boolean"
          ? payload.clearCompletedDisabled
          : !!current.clearCompletedDisabled;
      const listIndexEnabled =
        typeof payload?.listIndex === "boolean"
          ? payload.listIndex
          : (current.kind === "lists" || current.kind === "compound" ? !!current.indexCardEnabled : false);

      const parentRelays = (() => {
        const relays = current.nostr?.relays?.length
          ? current.nostr!.relays
          : board.nostr?.relays?.length
            ? board.nostr.relays
            : defaultRelays;
        return Array.from(new Set(relays.filter(Boolean)));
      })();

      const ensureChildStub = (state: Board[], child: string): { id: string; boards: Board[] } => {
        const trimmed = child.trim();
        if (!trimmed) return { id: "", boards: state };
        const existing = findBoardByCompoundChildId(state, trimmed);
        if (existing) {
          return { id: existing.id, boards: state };
        }
        const stub: Board = {
          id: trimmed,
          name: "Linked board",
          kind: "lists",
          columns: [{ id: crypto.randomUUID(), name: "Items" }],
          nostr: { boardId: trimmed, relays: parentRelays },
          archived: true,
          hidden: true,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
        };
        return { id: stub.id, boards: [...state, stub] };
      };

      const buildNext = (): { board: Board; boards: Board[] } => {
        if (kindTag === "week") {
          const next: Board = {
            id: current.id,
            name: nm,
            nostr: current.nostr,
            kind: "week",
            archived: current.archived,
            hidden: current.hidden,
            clearCompletedDisabled,
          };
          return { board: next, boards: working };
        }
        if (kindTag === "lists") {
          const cols: ListColumn[] = Array.isArray(payload?.columns)
            ? payload.columns
            : current.kind === "lists"
              ? current.columns
              : [{ id: crypto.randomUUID(), name: "Items" }];
          const next: Board = {
            id: current.id,
            name: nm,
            nostr: current.nostr,
            kind: "lists",
            columns: cols,
            archived: current.archived,
            hidden: current.hidden,
            clearCompletedDisabled,
            indexCardEnabled: listIndexEnabled,
          };
          return { board: next, boards: working };
        }
        if (kindTag === "compound") {
          const rawChildren: string[] = Array.isArray(payload?.children)
            ? payload.children.filter((child: unknown): child is string => typeof child === "string")
            : current.kind === "compound"
              ? current.children
              : [];
          const hideBoardNames =
            typeof payload?.hideBoardNames === "boolean"
              ? payload.hideBoardNames
              : current.kind === "compound"
                ? !!current.hideChildBoardNames
                : false;
          const seen = new Set<string>();
          let boardsState = working;
          const children = rawChildren.reduce<string[]>((acc, child) => {
            const result = ensureChildStub(boardsState, child);
            boardsState = result.boards;
            const canonical = result.id;
            if (!canonical || seen.has(canonical)) return acc;
            seen.add(canonical);
            acc.push(canonical);
            return acc;
          }, []);
          const next: Board = {
            id: current.id,
            name: nm,
            nostr: current.nostr,
            kind: "compound",
            children,
            archived: current.archived,
            hidden: current.hidden,
            clearCompletedDisabled,
            indexCardEnabled: listIndexEnabled,
            hideChildBoardNames: hideBoardNames,
          };
          return { board: next, boards: boardsState };
        }
        const next: Board = {
          ...current,
          name: nm,
          clearCompletedDisabled,
          ...(current.kind === "lists" || current.kind === "compound"
            ? {
                indexCardEnabled: listIndexEnabled,
                ...(current.kind === "compound"
                  ? { hideChildBoardNames: current.hideChildBoardNames }
                  : {}),
              }
            : {}),
        } as Board;
        return { board: next, boards: working };
      };

      const { board: updatedBoard, boards: updatedBoards } = buildNext();
      if (updatedBoards !== working) {
        working = updatedBoards;
      }
      const targetIndex = working.findIndex((item) => item.id === current.id);
      if (targetIndex === -1) {
        return working;
      }
      working[targetIndex] = updatedBoard;
      return working;
    });
  }, [setBoards, tagValue, defaultRelays]);
  const applyTaskEvent = useCallback(async (ev: NostrEvent) => {
    const bTag = tagValue(ev, "b");
    const taskId = tagValue(ev, "d");
    if (!bTag || !taskId) return;
    if (!nostrIdxRef.current.taskClock.has(bTag)) nostrIdxRef.current.taskClock.set(bTag, new Map());
    const m = nostrIdxRef.current.taskClock.get(bTag)!;
    const last = m.get(taskId) || 0;
    const pendingKey = `${bTag}::${taskId}`;
    const isPending = pendingNostrTasksRef.current.has(pendingKey);
    if (ev.created_at < last) return;
    if (ev.created_at === last && isPending) return;
    // Accept equal timestamps so rapid consecutive updates still apply
    m.set(taskId, ev.created_at);

    const lb = boardsRef.current.find((b) => b.nostr?.boardId && boardTag(b.nostr.boardId) === bTag);
    if (!lb || !lb.nostr) return;
    const boardId = lb.nostr.boardId;
    let payload: any = {};
    try {
      const dec = await decryptFromBoard(boardId, ev.content);
      payload = dec ? JSON.parse(dec) : {};
    } catch {
      try { payload = ev.content ? JSON.parse(ev.content) : {}; } catch {}
    }
    const status = tagValue(ev, "status");
    const col = tagValue(ev, "col");
    const hasDueTimeField = Object.prototype.hasOwnProperty.call(payload, 'dueTimeEnabled');
    const incomingDueTime = hasDueTimeField
      ? (payload.dueTimeEnabled === null ? undefined : typeof payload.dueTimeEnabled === 'boolean' ? payload.dueTimeEnabled : undefined)
      : undefined;
    // Reminders remain device-local, so ignore any reminder payloads from shared updates.
      const base: Task = {
        id: taskId,
        boardId: lb.id,
        createdBy: payload.createdBy,
        title: payload.title || "Untitled",
        note: payload.note || "",
      dueISO: payload.dueISO || isoForToday(),
      completed: status === "done",
      completedAt: payload.completedAt,
      completedBy: payload.completedBy,
      recurrence: payload.recurrence,
      hiddenUntilISO: payload.hiddenUntilISO,
      order: typeof payload.order === 'number' ? payload.order : undefined,
      streak: typeof payload.streak === 'number' ? payload.streak : undefined,
      longestStreak: typeof payload.longestStreak === 'number' ? payload.longestStreak : undefined,
      seriesId: payload.seriesId,
      subtasks: Array.isArray(payload.subtasks) ? payload.subtasks : undefined,
    };
    if (hasDueTimeField) base.dueTimeEnabled = incomingDueTime;
    if (lb.kind === "week") base.column = col === "bounties" ? "bounties" : "day";
    else if (lb.kind === "lists") base.columnId = col || (lb.columns[0]?.id || "");
    setTasks(prev => {
      const idx = prev.findIndex(x => x.id === taskId && x.boardId === lb.id);
      if (status === "deleted") {
        return idx >= 0 ? prev.filter((_,i)=>i!==idx) : prev;
      }
      // Improved bounty merge with clocks and auth; incoming may be null (explicit removal)
      const mergeBounty = (oldB?: Task["bounty"], incoming?: Task["bounty"] | null) => {
        if (incoming === null) return undefined; // explicit removal
        const normalizedIncoming = normalizeBounty(incoming);
        const normalizedOld = oldB ? normalizeBounty(oldB) : undefined;
        if (!normalizedIncoming) return normalizedOld;
        if (!normalizedOld) return normalizedIncoming;
        // Prefer the bounty with the latest updatedAt; fallback to event created_at
        const oldT = Date.parse(normalizedOld.updatedAt || '') || 0;
        const incT = Date.parse(normalizedIncoming.updatedAt || '') || 0;
        const incNewer = incT > oldT || (incT === oldT && ev.created_at > (nostrIdxRef.current.taskClock.get(bTag)?.get(taskId) || 0));

        // Different ids: pick the newer one
        if (normalizedOld.id !== normalizedIncoming.id) return incNewer ? normalizedIncoming : normalizedOld;

        const next = { ...normalizedOld } as Task["bounty"];
        // accept token/content updates if incoming is newer
        if (incNewer) {
          if (typeof normalizedIncoming.amount === 'number') next.amount = normalizedIncoming.amount;
          next.mint = normalizedIncoming.mint ?? next.mint;
          next.lock = normalizedIncoming.lock ?? next.lock;
          // Only overwrite token if sender/owner published or token becomes visible
          if (normalizedIncoming.token) next.token = normalizedIncoming.token;
          const hasEncField = Object.prototype.hasOwnProperty.call(incoming, 'enc');
          if (hasEncField) {
            next.enc = (incoming as any).enc ?? undefined;
          } else if (normalizedIncoming.token && !normalizedIncoming.enc) {
            next.enc = undefined;
          }
          if (normalizedIncoming.receiver) next.receiver = normalizedIncoming.receiver;
          next.updatedAt = normalizedIncoming.updatedAt || next.updatedAt;
        }
        // Auth for state transitions (allow owner or sender to unlock; owner or sender to revoke; anyone to mark claimed)
        if (normalizedIncoming.state && normalizedIncoming.state !== normalizedOld.state) {
          const isOwner = !!(normalizedOld.owner && ev.pubkey === normalizedOld.owner);
          const isSender = !!(normalizedOld.sender && ev.pubkey === normalizedOld.sender);
          const isReceiver = !!(normalizedOld.receiver && ev.pubkey === normalizedOld.receiver);
          if (normalizedIncoming.state === 'unlocked' && (isOwner || isSender || isReceiver)) next.state = 'unlocked';
          if (normalizedIncoming.state === 'revoked' && (isOwner || isSender)) next.state = 'revoked';
          if (normalizedIncoming.state === 'claimed') next.state = 'claimed';
        }
        return normalizeBounty(next);
      };

      if (idx >= 0) {
        const copy = prev.slice();
        const current = prev[idx];
        // Determine incoming bounty raw (preserve explicit null removal)
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        // Determine incoming images raw (allow explicit null removal)
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const mergedImages = incomingImgs === undefined ? current.images : incomingImgs === null ? undefined : incomingImgs;
        let mergedDocuments: TaskDocument[] | undefined = current.documents;
        if (Object.prototype.hasOwnProperty.call(payload, 'documents')) {
          const rawDocs = (payload as any).documents;
          if (rawDocs === null) {
            mergedDocuments = undefined;
          } else {
            const normalizedDocs = normalizeDocumentList(rawDocs);
            mergedDocuments = normalizedDocs ? normalizedDocs.map(ensureDocumentPreview) : undefined;
          }
        }
        const newOrder = typeof base.order === 'number' ? base.order : current.order;
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const newStreak = incomingStreak === undefined ? current.streak : incomingStreak === null ? undefined : incomingStreak;
        const incomingLongest: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'longestStreak') ? payload.longestStreak : undefined;
        const newLongest = incomingLongest === undefined
          ? current.longestStreak
          : incomingLongest === null
            ? undefined
            : incomingLongest;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const mergedSubs = incomingSubs === undefined ? current.subtasks : incomingSubs === null ? undefined : incomingSubs;
        copy[idx] = { ...current, ...base, order: newOrder, images: mergedImages, documents: mergedDocuments, bounty: mergeBounty(current.bounty, incomingB as any), streak: newStreak, longestStreak: newLongest, subtasks: mergedSubs };
        return copy;
      } else {
        const incomingB: Task["bounty"] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'bounty') ? payload.bounty : undefined;
        const incomingImgs: string[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'images') ? payload.images : undefined;
        const imgs = incomingImgs === null ? undefined : Array.isArray(incomingImgs) ? incomingImgs : undefined;
        let docs: TaskDocument[] | undefined;
        if (Object.prototype.hasOwnProperty.call(payload, 'documents')) {
          const rawDocs = (payload as any).documents;
          if (rawDocs === null) {
            docs = undefined;
          } else {
            const normalizedDocs = normalizeDocumentList(rawDocs);
            docs = normalizedDocs ? normalizedDocs.map(ensureDocumentPreview) : undefined;
          }
        }
        const incomingStreak: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'streak') ? payload.streak : undefined;
        const st = incomingStreak === null ? undefined : typeof incomingStreak === 'number' ? incomingStreak : undefined;
        const incomingLongest: number | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'longestStreak') ? payload.longestStreak : undefined;
        const longest = incomingLongest === null ? undefined : typeof incomingLongest === 'number' ? incomingLongest : undefined;
        const incomingSubs: Subtask[] | null | undefined = Object.prototype.hasOwnProperty.call(payload, 'subtasks') ? payload.subtasks : undefined;
        const subs = incomingSubs === null ? undefined : Array.isArray(incomingSubs) ? incomingSubs : undefined;
        const newOrder = typeof base.order === 'number' ? base.order : 0;
        const normalizedIncoming = incomingB === null ? undefined : normalizeBounty(incomingB);
        return [...prev, { ...base, order: newOrder, images: imgs, documents: docs, bounty: normalizedIncoming, streak: st, longestStreak: longest, subtasks: subs }];
      }
    });
  }, [setTasks, tagValue]);

  function normalizePushError(err: unknown): string {
    if (!(err instanceof Error)) return 'Failed to enable push notifications.';
    const message = err.message || 'Failed to enable push notifications.';
    const lower = message.toLowerCase();
    if (lower.includes('push service error')) {
      return 'The browser\'s push service rejected the registration. Check that notifications are allowed for this site (Safari → Settings → Websites → Notifications on macOS) and try again.';
    }
    if (lower.includes('not allowed')) {
      return 'The browser blocked the subscription request. Grant notification permission and try again.';
    }
    if (lower.includes('secure context')) {
      return 'Push notifications require HTTPS (or localhost during development). Reload the app over a secure origin and try again.';
    }
    if (lower.includes('invalid vapid public key')) {
      return 'The configured VAPID public key appears to be invalid. Update both the Worker and the app with matching VAPID keys.';
    }
    return message;
  }

  function isRecoverablePushError(err: unknown): boolean {
    if (!err) return false;
    const message = typeof (err as any)?.message === 'string' ? (err as any).message.toLowerCase() : '';
    if (!message) return false;
    return message.includes('push service error')
      || message.includes('not allowed')
      || message.includes('denied')
      || message.includes('aborted');
  }

  async function purgeExistingPushSubscriptions(): Promise<void> {
    if (!navigator.serviceWorker) return;
    const hasGetRegistrations = typeof navigator.serviceWorker.getRegistrations === 'function';
    const registrations: ServiceWorkerRegistration[] = [];
    try {
      if (hasGetRegistrations) {
        registrations.push(...await navigator.serviceWorker.getRegistrations());
      } else if (typeof navigator.serviceWorker.getRegistration === 'function') {
        const single = await navigator.serviceWorker.getRegistration();
        if (single) registrations.push(single);
      }
    } catch {
      return;
    }
    await Promise.all(registrations.map(async (registration) => {
      try {
        const sub = await registration.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch {}
    }));
  }

  async function subscribeWithRecovery(
    registration: ServiceWorkerRegistration,
    applicationServerKey: Uint8Array,
  ): Promise<PushSubscription> {
    try {
      return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch (err) {
      if (!isRecoverablePushError(err)) throw err;
      await purgeExistingPushSubscriptions();
      return await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
  }

  async function enablePushNotifications(platform: PushPlatform): Promise<void> {
    if (pushWorkState === 'enabling') return;
    setPushWorkState('enabling');
    setPushError(null);
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        throw new Error('Push notifications are not supported on this device.');
      }
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new Error('Push notifications require HTTPS (or localhost).');
      }
      if (!vapidPublicKey) {
        throw new Error('Missing VAPID public key.');
      }
      if (!workerBaseUrl) {
        throw new Error('Missing worker base URL.');
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        throw new Error('Notifications permission was not granted.');
      }

      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey.trim());
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await subscribeWithRecovery(registration, applicationServerKey);
      }

      const deviceId = settings.pushNotifications.deviceId || crypto.randomUUID();
      const subscriptionJson = subscription.toJSON();
      const normalizedPlatform: PushPlatform = platform === 'android' ? 'android' : 'ios';

      const res = await fetch(`${workerBaseUrl}/api/devices`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          platform: normalizedPlatform,
          subscription: subscriptionJson,
        }),
      });
      if (!res.ok) {
        throw new Error(`Failed to register device (${res.status})`);
      }
      let subscriptionId: string | undefined;
      let resolvedDeviceId = deviceId;
      try {
        const data = await res.json();
        if (data && typeof data.subscriptionId === 'string') subscriptionId = data.subscriptionId;
        if (data && typeof data.deviceId === 'string' && data.deviceId) resolvedDeviceId = data.deviceId;
      } catch {}

      const updated: PushPreferences = {
        ...settings.pushNotifications,
        enabled: true,
        platform: normalizedPlatform,
        deviceId: resolvedDeviceId,
        subscriptionId,
        permission,
      };

      const reminderTasks = tasks.filter(taskHasReminders);
      const remindersPayloadString = JSON.stringify(
        reminderTasks
          .map((task) => ({
            taskId: task.id,
            boardId: task.boardId,
            dueISO: task.dueISO,
            title: task.title,
            minutesBefore: (task.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
          }))
          .sort((a, b) => a.taskId.localeCompare(b.taskId)),
      );
      reminderPayloadRef.current = remindersPayloadString;
      await syncRemindersToWorker(workerBaseUrl, updated, reminderTasks);

      setSettings({ pushNotifications: updated });
    } catch (err) {
      const message = normalizePushError(err);
      setPushError(message);
      if (typeof Notification !== 'undefined') {
        setSettings({ pushNotifications: { ...settings.pushNotifications, permission: Notification.permission } });
      }
      throw err;
    } finally {
      setPushWorkState('idle');
    }
  }

  async function disablePushNotifications(): Promise<void> {
    if (pushWorkState === 'disabling') return;
    setPushWorkState('disabling');
    setPushError(null);
    try {
      if ('serviceWorker' in navigator) {
        try {
          let registration: ServiceWorkerRegistration | null | undefined = undefined;
          if (typeof navigator.serviceWorker.getRegistration === 'function') {
            try {
              registration = await navigator.serviceWorker.getRegistration();
            } catch {}
          }
          if (!registration) {
            try {
              registration = await navigator.serviceWorker.ready;
            } catch {}
          }
          if (registration) {
            try {
              const subscription = await registration.pushManager.getSubscription();
              if (subscription) await subscription.unsubscribe();
            } catch {}
          }
        } catch {}
      }

      if (workerBaseUrl && settings.pushNotifications.deviceId) {
        try {
          await fetch(`${workerBaseUrl}/api/devices/${settings.pushNotifications.deviceId}`, {
            method: 'DELETE',
          });
        } catch {}
      }

      const permission = typeof Notification !== 'undefined'
        ? Notification.permission
        : settings.pushNotifications.permission;

      setSettings({
        pushNotifications: {
          ...settings.pushNotifications,
          enabled: false,
          subscriptionId: undefined,
          permission,
        },
      });
      reminderPayloadRef.current = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to disable push notifications';
      setPushError(message);
      if (typeof Notification !== 'undefined') {
        setSettings({ pushNotifications: { ...settings.pushNotifications, permission: Notification.permission } });
      }
      throw err;
    } finally {
      setPushWorkState('idle');
    }
  }

  async function handleAddPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs = Array.from(items).filter(it => it.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      const datas: string[] = [];
      for (const it of imgs) {
        const file = it.getAsFile();
        if (file) datas.push(await fileToDataURL(file));
      }
      setNewImages(prev => [...prev, ...datas]);
    }
  }

  async function handleNewDocumentSelection(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || !files.length) return;
    try {
      const docs = await readDocumentsFromFiles(files);
      setNewDocuments((prev) => [...prev, ...docs]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.toLowerCase().includes("unsupported")) {
        showToast("Unsupported file. Attach PDF, DOC/DOCX, or XLS/XLSX files.");
      } else {
        showToast("Failed to attach document. Please try a different file.");
      }
    } finally {
      e.target.value = "";
    }
  }

  function sameSeries(a: Task, b: Task): boolean {
    if (a.seriesId && b.seriesId) return a.seriesId === b.seriesId;
    return (
      a.boardId === b.boardId &&
      a.title === b.title &&
      a.note === b.note &&
      a.recurrence && b.recurrence &&
      JSON.stringify(a.recurrence) === JSON.stringify(b.recurrence)
    );
  }

  function ensureWeekRecurrences(arr: Task[], sources?: Task[]): Task[] {
    const sow = startOfWeek(new Date(), settings.weekStart).getTime();
    const out = [...arr];
    let changed = false;
    const src = sources ?? arr;
    for (const t of src) {
      if (!t.recurrence) continue;
      const seriesId = t.seriesId || t.id;
      if (!t.seriesId) {
        const idx = out.findIndex(x => x.id === t.id);
        if (idx >= 0 && out[idx].seriesId !== seriesId) {
          out[idx] = { ...out[idx], seriesId };
          changed = true;
        }
      }
      let nextISO = nextOccurrence(t.dueISO, t.recurrence, !!t.dueTimeEnabled);
      while (nextISO) {
        const nextDate = new Date(nextISO);
        const nsow = startOfWeek(nextDate, settings.weekStart).getTime();
        if (nsow > sow) break;
        if (nsow === sow) {
          const exists = out.some(x =>
            sameSeries(x, { ...t, seriesId }) &&
            startOfDay(new Date(x.dueISO)).getTime() === startOfDay(nextDate).getTime()
          );
          if (!exists) {
            const clone: Task = {
              ...t,
              id: crypto.randomUUID(),
              seriesId,
              completed: false,
              completedAt: undefined,
              completedBy: undefined,
              dueISO: nextISO,
              hiddenUntilISO: undefined,
              order: nextOrderForBoard(t.boardId, out, settings.newTaskPosition),
              subtasks: t.subtasks?.map(s => ({ ...s, completed: false })),
              dueTimeEnabled: typeof t.dueTimeEnabled === 'boolean' ? t.dueTimeEnabled : undefined,
              reminders: Array.isArray(t.reminders) ? [...t.reminders] : undefined,
            };
            maybePublishTask(clone).catch(() => {});
            out.push(clone);
            changed = true;
          }
        }
        nextISO = nextOccurrence(nextISO, t.recurrence, !!t.dueTimeEnabled);
      }
    }
    return changed ? out : arr;
  }
  function buildImportedTask(raw: string, overrides: Partial<Task> = {}): Task | null {
    if (!currentBoard) return null;
    try {
      const parsed: any = JSON.parse(raw);
      if (!(parsed && typeof parsed === "object" && parsed.title && parsed.dueISO)) return null;
      const baseBoardId = typeof overrides.boardId === "string" ? overrides.boardId : currentBoard.id;
      const nextOrder = nextOrderForBoard(baseBoardId, tasks, settings.newTaskPosition);
      const id = crypto.randomUUID();
      const dueISO = typeof parsed.dueISO === 'string' ? parsed.dueISO : isoForToday();
      const dueTimeEnabled = typeof parsed.dueTimeEnabled === 'boolean' ? parsed.dueTimeEnabled : undefined;
      const reminders = sanitizeReminderList(parsed.reminders);
      const documents = normalizeDocumentList(parsed.documents);
      const imported: Task = {
        ...parsed,
        id,
        boardId: baseBoardId,
        order: typeof parsed.order === "number" ? parsed.order : nextOrder,
        dueISO,
        ...(typeof dueTimeEnabled === 'boolean' ? { dueTimeEnabled } : {}),
        ...(reminders !== undefined ? { reminders } : {}),
        ...(documents ? { documents: documents.map(ensureDocumentPreview) } : {}),
        ...overrides,
      };
      imported.boardId = typeof imported.boardId === "string" ? imported.boardId : baseBoardId;
      if (imported.recurrence) imported.seriesId = imported.seriesId || id;
      else imported.seriesId = undefined;
      return imported;
    } catch {
      return null;
    }
  }
  function addTask(keepKeyboard = false) {
    if (!currentBoard) return;

    const originRect = newTitleRef.current?.getBoundingClientRect() || null;

    const raw = newTitle.trim();
    const listPlacement = isListLikeBoard(currentBoard)
      ? resolveListPlacement(typeof dayChoice === "string" ? dayChoice : undefined)
      : null;
    if (isListLikeBoard(currentBoard) && !listPlacement) {
      showToast("Add a list to this board first.");
      return;
    }
    if (raw) {
      const imported = buildImportedTask(raw, listPlacement ? { boardId: listPlacement.boardId, columnId: listPlacement.columnId } : {});
      if (imported) {
        applyHiddenForFuture(imported, settings.weekStart, currentBoard.kind);
        animateTaskArrival(originRect, imported, currentBoard);
        setTasks(prev => {
          const out = [...prev, imported];
          return settings.showFullWeekRecurring && imported.recurrence ? ensureWeekRecurrences(out, [imported]) : out;
        });
        maybePublishTask(imported).catch(() => {});
        setNewTitle("");
        setNewImages([]);
        setNewDocuments([]);
        setQuickRule("none");
        setAddCustomRule(R_NONE);
        setScheduleDate("");
        setScheduleTime("");
        if (keepKeyboard) newTitleRef.current?.focus();
        else newTitleRef.current?.blur();
        return;
      }
    }

    const firstDocName = newDocuments[0]?.name || "";
    const attachmentFallback = newDocuments.length
      ? (firstDocName.replace(/\.[^/.]+$/, "") || "Attachment")
      : "";
    const title = raw || attachmentFallback || (newImages.length ? "Image" : "");
    if ((!title && !newImages.length && !newDocuments.length)) return;

    const candidate = resolveQuickRule();
    const recurrence = candidate.type === "none" ? undefined : candidate;
    const currentDayChoice = dayChoiceRef.current;
    let dueISO = isoForToday();
    let dueTimeFlag = false;
    if (scheduleDate) {
      const hasTime = !!scheduleTime;
      dueTimeFlag = hasTime;
      dueISO = isoFromDateTime(scheduleDate, hasTime ? scheduleTime : undefined);
    } else if (currentBoard?.kind === "week" && currentDayChoice !== "bounties") {
      dueISO = isoForWeekday(currentDayChoice as Weekday, {
        weekStart: settings.weekStart,
      });
    }

    const targetBoardId = listPlacement ? listPlacement.boardId : currentBoard.id;
    const nextOrder = nextOrderForBoard(targetBoardId, tasks, settings.newTaskPosition);
    const id = crypto.randomUUID();
    const t: Task = {
      id,
      seriesId: recurrence ? id : undefined,
      boardId: targetBoardId,
      createdBy: nostrPK || undefined,
      title,
      dueISO,
      completed: false,
      recurrence,
      order: nextOrder,
      streak: recurrence && (recurrence.type === "daily" || recurrence.type === "weekly") ? 0 : undefined,
      longestStreak: recurrence && (recurrence.type === "daily" || recurrence.type === "weekly") ? 0 : undefined,
    };
    if (dueTimeFlag) t.dueTimeEnabled = true;
    if (newImages.length) t.images = newImages;
    if (newDocuments.length) t.documents = newDocuments;
    if (currentBoard?.kind === "week") {
      t.column = currentDayChoice === "bounties" ? "bounties" : "day";
    } else {
      t.column = undefined;
      t.columnId = listPlacement?.columnId;
    }
    applyHiddenForFuture(t, settings.weekStart, currentBoard.kind);
    animateTaskArrival(originRect, t, currentBoard);
    setTasks(prev => {
      const out = [...prev, t];
      return settings.showFullWeekRecurring && recurrence ? ensureWeekRecurrences(out, [t]) : out;
    });
    // Publish to Nostr if board is shared
    maybePublishTask(t).catch(() => {});
    setNewTitle("");
    setNewImages([]);
    setNewDocuments([]);
    setQuickRule("none");
    setAddCustomRule(R_NONE);
    setScheduleDate("");
    setScheduleTime("");
    if (keepKeyboard) newTitleRef.current?.focus();
    else newTitleRef.current?.blur();
  }

  function addInlineTask(key: string) {
    if (!currentBoard) return;
    const raw = (inlineTitles[key] || "").trim();
    if (!raw) return;

    const originRect = inlineInputRefs.current.get(key)?.getBoundingClientRect() || null;
    const inlineOverrides: Partial<Task> = { createdBy: nostrPK || undefined };

    if (currentBoard?.kind === "week") {
      if (key === "bounties") {
        inlineOverrides.column = "bounties";
        inlineOverrides.columnId = undefined;
      } else {
        inlineOverrides.column = "day";
        inlineOverrides.columnId = undefined;
        inlineOverrides.dueISO = isoForWeekday(Number(key) as Weekday, {
          weekStart: settings.weekStart,
        });
      }
    } else {
      const placement = resolveListPlacement(key);
      if (!placement) {
        showToast("Add a list to this board first.");
        return;
      }
      inlineOverrides.boardId = placement.boardId;
      inlineOverrides.columnId = placement.columnId;
      inlineOverrides.column = undefined;
    }

    const imported = buildImportedTask(raw, inlineOverrides);
    if (imported) {
      applyHiddenForFuture(imported, settings.weekStart, currentBoard.kind);
      animateTaskArrival(originRect, imported, currentBoard);
      setTasks(prev => {
        const out = [...prev, imported];
        return settings.showFullWeekRecurring && imported.recurrence ? ensureWeekRecurrences(out, [imported]) : out;
      });
      maybePublishTask(imported).catch(() => {});
      setInlineTitles(prev => ({ ...prev, [key]: "" }));
      return;
    }

    let dueISO = isoForToday();
    const targetBoardId = inlineOverrides.boardId || currentBoard.id;
    const nextOrder = nextOrderForBoard(targetBoardId, tasks, settings.newTaskPosition);
    const id = crypto.randomUUID();
    const t: Task = {
      id,
      boardId: targetBoardId,
      createdBy: nostrPK || undefined,
      title: raw,
      dueISO,
      completed: false,
      order: nextOrder,
    };
    if (currentBoard?.kind === "week") {
      if (key === "bounties") t.column = "bounties";
      else {
        t.column = "day";
        dueISO = isoForWeekday(Number(key) as Weekday, {
          weekStart: settings.weekStart,
        });
        t.dueISO = dueISO;
      }
    } else {
      t.column = undefined;
      t.columnId = inlineOverrides.columnId;
    }
    applyHiddenForFuture(t, settings.weekStart, currentBoard.kind);
    animateTaskArrival(originRect, t, currentBoard);
    setTasks(prev => [...prev, t]);
    maybePublishTask(t).catch(() => {});
    setInlineTitles(prev => ({ ...prev, [key]: "" }));
  }

  function completeTask(
    id: string,
    options?: { skipScriptureMemoryUpdate?: boolean }
  ): CompleteTaskResult {
    let memoryUpdate: ScriptureMemoryUpdate | null = null;
    let scheduledUpdate: { entryId: string; scheduledAtISO: string } | null = null;
    const scriptureStateSnapshot = scriptureMemory;
    const scriptureBaseDays = scriptureMemoryFrequencyOption?.days ?? 1;
    setTasks(prev => {
      const cur = prev.find(t => t.id === id);
      if (!cur) return prev;
      const now = new Date().toISOString();
      let newStreak = typeof cur.streak === "number" ? cur.streak : 0;
      if (
        settings.streaksEnabled &&
        cur.recurrence &&
        (cur.recurrence.type === "daily" || cur.recurrence.type === "weekly")
      ) {
        // Previously the streak only incremented when completing a task on the
        // same day it was due. This prevented users from keeping their streak
        // if they forgot to check the app and completed the task a day later.
        // Now the streak simply increments whenever the task is completed,
        // regardless of the current timestamp.
        newStreak = newStreak + 1;
      }
      const nextLongest = mergeLongestStreak(cur, newStreak);
      const toPublish: Task[] = [];
      let nextId: string | null = null;
      if (
        settings.showFullWeekRecurring &&
        settings.streaksEnabled &&
        cur.recurrence &&
        (cur.recurrence.type === "daily" || cur.recurrence.type === "weekly")
      ) {
        nextId =
          prev
            .filter(
              t =>
                t.id !== id &&
                !t.completed &&
                t.recurrence &&
                sameSeries(t, cur) &&
                new Date(t.dueISO) > new Date(cur.dueISO)
            )
            .sort(
              (a, b) =>
                new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime()
            )[0]?.id || null;
      }
      const updated = prev.map(t => {
        if (t.id === id) {
          const done = {
            ...t,
            seriesId: t.seriesId || t.id,
            completed: true,
            completedAt: now,
            completedBy: (window as any).nostrPK || undefined,
            streak: newStreak,
            longestStreak: nextLongest,
          };
          if (cur.scriptureMemoryId) {
            memoryUpdate = {
              entryId: cur.scriptureMemoryId,
              completedAt: now,
              stageBefore: typeof cur.scriptureMemoryStage === "number" ? cur.scriptureMemoryStage : cur.stage ?? 0,
            };
          }
          toPublish.push(done);
          return done;
        }
        if (t.id === nextId) {
          const upd = {
            ...t,
            seriesId: t.seriesId || t.id,
            streak: newStreak,
            longestStreak: mergeLongestStreak(t, newStreak),
          };
          toPublish.push(upd);
          return upd;
        }
        return t;
      });
      toPublish.forEach(t => {
        maybePublishTask(t).catch(() => {});
      });
      const scriptureRecurrence =
        (cur.seriesId === SCRIPTURE_MEMORY_SERIES_ID || cur.scriptureMemoryId)
          ? cur.recurrence ?? scriptureFrequencyToRecurrence(scriptureBaseDays)
          : cur.recurrence;
      const nextISO = scriptureRecurrence
        ? nextOccurrence(cur.dueISO, scriptureRecurrence, !!cur.dueTimeEnabled)
        : null;
      if (nextISO && scriptureRecurrence) {
        let shouldClone = true;
        if (settings.showFullWeekRecurring) {
          const nextDate = new Date(nextISO);
          const nsow = startOfWeek(nextDate, settings.weekStart).getTime();
          const csow = startOfWeek(new Date(), settings.weekStart).getTime();
          if (nsow === csow) {
            const exists = updated.some(x =>
              sameSeries(x, cur) &&
              startOfDay(new Date(x.dueISO)).getTime() === startOfDay(nextDate).getTime()
            );
            if (exists) shouldClone = false;
          }
        }
        if (shouldClone) {
          const nextOrder = nextOrderForBoard(cur.boardId, updated, settings.newTaskPosition);
          let clone: Task = {
            ...cur,
            id: crypto.randomUUID(),
            seriesId: cur.seriesId || cur.id,
            completed: false,
            completedAt: undefined,
            completedBy: undefined,
            dueISO: nextISO,
            hiddenUntilISO: hiddenUntilForNext(nextISO, scriptureRecurrence, settings.weekStart),
            order: nextOrder,
            streak: newStreak,
            longestStreak: nextLongest,
            subtasks: cur.subtasks?.map(s => ({ ...s, completed: false })),
            dueTimeEnabled: typeof cur.dueTimeEnabled === 'boolean' ? cur.dueTimeEnabled : undefined,
            reminders: Array.isArray(cur.reminders) ? [...cur.reminders] : undefined,
          };
          if (!clone.recurrence || !recurrencesEqual(clone.recurrence, scriptureRecurrence)) {
            clone = { ...clone, recurrence: scriptureRecurrence };
          }
          if (cur.seriesId === SCRIPTURE_MEMORY_SERIES_ID) {
            const previewState = memoryUpdate
              ? markScriptureEntryReviewed(
                  scriptureStateSnapshot,
                  memoryUpdate.entryId,
                  memoryUpdate.completedAt,
                  memoryUpdate.stageBefore
                )
              : scriptureStateSnapshot;
            const selection = chooseNextScriptureEntry(
              previewState.entries,
              scriptureBaseDays,
              new Date(nextISO)
            );
            if (!selection) {
              shouldClone = false;
            } else {
              clone = {
                ...clone,
                title: `Review ${formatScriptureReference(selection.entry)}`,
                scriptureMemoryId: selection.entry.id,
                scriptureMemoryStage: selection.entry.stage ?? 0,
                scriptureMemoryPrevReviewISO: selection.entry.lastReviewISO ?? null,
                scriptureMemoryScheduledAt: now,
              };
              scheduledUpdate = { entryId: selection.entry.id, scheduledAtISO: now };
            }
          }
          if (shouldClone) {
            maybePublishTask(clone).catch(() => {});
            return [...updated, clone];
          }
        }
      }
      return updated;
    });
    if (scheduledUpdate && memoryUpdate) {
      memoryUpdate = { ...memoryUpdate, nextScheduled: scheduledUpdate };
    }
    if (memoryUpdate && !options?.skipScriptureMemoryUpdate) {
      scriptureLastReviewRef.current = memoryUpdate.completedAt;
      setScriptureMemory((prev) => {
        let nextState = markScriptureEntryReviewed(
          prev,
          memoryUpdate!.entryId,
          memoryUpdate!.completedAt,
          memoryUpdate!.stageBefore
        );
        if (memoryUpdate!.nextScheduled) {
          nextState = scheduleScriptureEntry(
            nextState,
            memoryUpdate!.nextScheduled.entryId,
            memoryUpdate!.nextScheduled.scheduledAtISO
          );
        }
        return nextState;
      });
    }
    return memoryUpdate ? { scriptureMemory: memoryUpdate } : null;
  }

  function toggleSubtask(taskId: string, subId: string) {
    setTasks(prev =>
      prev.map((t) => {
        if (t.id !== taskId) return t;
        const subs = (t.subtasks || []).map((s) =>
          s.id === subId ? { ...s, completed: !s.completed } : s
        );
        const updated: Task = { ...t, subtasks: subs };
        maybePublishTask(updated).catch(() => {});
        return updated;
      })
    );
  }

  completeTaskRef.current = completeTask;

  function deleteTask(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    // Require confirmation if the task has a bounty that is not claimed yet
    if (t.bounty && t.bounty.state !== 'claimed') {
      const ok = confirm('This task has an ecash bounty that is not marked as claimed. Delete anyway?');
      if (!ok) return;
    }
    setUndoTask(t);
    setTasks(prev => {
      const arr = prev.filter(x => x.id !== id);
      const toPublish: Task[] = [];
      if (
        settings.showFullWeekRecurring &&
        settings.streaksEnabled &&
        t.recurrence &&
        (t.recurrence.type === "daily" || t.recurrence.type === "weekly")
      ) {
        const next = arr
          .filter(x => !x.completed && x.recurrence && sameSeries(x, t) && new Date(x.dueISO) > new Date(t.dueISO))
          .sort((a, b) => new Date(a.dueISO).getTime() - new Date(b.dueISO).getTime())[0];
        if (next) {
          const idx = arr.findIndex(x => x.id === next.id);
          arr[idx] = {
            ...next,
            seriesId: next.seriesId || next.id,
            streak: 0,
            longestStreak: mergeLongestStreak(next, 0),
          };
          toPublish.push(arr[idx]);
        }
      }
      toPublish.forEach(x => maybePublishTask(x).catch(() => {}));
      return arr;
    });
    if (t.scriptureMemoryId) {
      setScriptureMemory((prev) =>
        updateScriptureMemoryState(
          prev,
          prev.entries.map((entry) =>
            entry.id === t.scriptureMemoryId
              ? { ...entry, scheduledAtISO: t.scriptureMemoryScheduledAt || entry.scheduledAtISO }
              : entry
          ),
          prev.lastReviewISO
        )
      );
    }
    publishTaskDeleted(t).catch(() => {});
    setTimeout(() => setUndoTask(null), 5000); // undo duration
  }
  function undoDelete() {
    if (undoTask) { setTasks(prev => [...prev, undoTask]); setUndoTask(null); }
  }

  function restoreTask(id: string) {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const toPublish: Task[] = [];
    const recurringStreak =
      settings.streaksEnabled &&
      t.recurrence &&
      (t.recurrence.type === "daily" || t.recurrence.type === "weekly") &&
      typeof t.streak === "number";
    const newStreak = recurringStreak ? Math.max(0, t.streak! - 1) : t.streak;
    setTasks(prev => {
      const bottomOrder =
        prev.reduce((max, task) => {
          if (task.id === id) return max;
          if (task.boardId !== t.boardId) return max;
          const order = typeof task.order === "number" ? task.order : -1;
          return Math.max(max, order);
        }, -1) + 1;
      const arr = prev.map(x => {
        if (x.id !== id) return x;
        const upd: Task = {
          ...x,
          completed: false,
          completedAt: undefined,
          completedBy: undefined,
          hiddenUntilISO: undefined,
          streak: newStreak,
          longestStreak: mergeLongestStreak(x, newStreak),
          order: bottomOrder,
        };
        toPublish.push(upd);
        return upd;
      });
      if (recurringStreak) {
        const future = arr.filter(
          x =>
            x.id !== id &&
            !x.completed &&
            x.recurrence &&
            sameSeries(x, t) &&
            new Date(x.dueISO) > new Date(t.dueISO)
        );
        future.forEach(f => {
          const idx = arr.findIndex(x => x.id === f.id);
          const upd = {
            ...f,
            seriesId: f.seriesId || f.id,
            streak: newStreak,
            longestStreak: mergeLongestStreak(f, newStreak),
          };
          arr[idx] = upd;
          toPublish.push(upd);
        });
      }
      return arr;
    });
    if (t.scriptureMemoryId) {
      setScriptureMemory((prev) =>
        updateScriptureMemoryState(
          prev,
          prev.entries.map((entry) => {
            if (entry.id !== t.scriptureMemoryId) return entry;
            const previousStage = typeof t.scriptureMemoryStage === "number" ? t.scriptureMemoryStage : entry.stage ?? 0;
            const totalReviews = Math.max(0, (entry.totalReviews ?? 0) - 1);
            return {
              ...entry,
              stage: Math.max(0, previousStage),
              totalReviews,
              lastReviewISO: t.scriptureMemoryPrevReviewISO || undefined,
              scheduledAtISO: t.scriptureMemoryScheduledAt || entry.scheduledAtISO,
            };
          })
        )
      );
    }
    toPublish.forEach(x => maybePublishTask(x).catch(() => {}));
  }
  function clearCompleted() {
    if (currentBoard?.kind === "bible" || currentBoard?.clearCompletedDisabled) {
      return;
    }
    const scope = currentBoard ? new Set(boardScopeIds(currentBoard, boards)) : null;
    for (const t of tasksForBoard)
      if (t.completed && (!t.bounty || t.bounty.state === 'claimed'))
        publishTaskDeleted(t).catch(() => {});
    setTasks(prev =>
      prev.filter(t =>
        !(
          scope?.has(t.boardId) &&
          t.completed &&
          (!t.bounty || t.bounty.state === 'claimed')
        )
      )
    );
  }

  function postponeTaskOneWeek(id: string) {
    let updated: Task | undefined;
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t;
      const nextDue = startOfDay(new Date(t.dueISO));
      nextDue.setDate(nextDue.getDate() + 7);
      updated = {
        ...t,
        dueISO: nextDue.toISOString(),
        hiddenUntilISO: startOfWeek(nextDue, settings.weekStart).toISOString(),
      };
      return updated!;
    }));
    if (updated) {
      maybePublishTask(updated).catch(() => {});
      showToast('Task moved to next week');
    }
  }

  async function revealBounty(id: string) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'locked' || !t.bounty.enc) return;
    try {
      let pt = "";
      const enc = t.bounty.enc as any;
      const me = (window as any).nostrPK as string | undefined;
      if (enc.alg === 'aes-gcm-256') {
        if (!me || t.bounty.sender !== me) throw new Error('Only the funder can reveal this token.');
        pt = await decryptEcashTokenForFunder(enc);
      } else if (enc.alg === 'nip04') {
        const receiverRaw = ensureXOnlyHex(t.bounty.receiver);
        const meRaw = ensureXOnlyHex(me);
        if (!receiverRaw || !meRaw || receiverRaw !== meRaw) {
          throw new Error('Only the intended recipient can decrypt this token.');
        }
        const senderRaw = ensureXOnlyHex(t.bounty.sender);
        if (!senderRaw) throw new Error('Missing sender pubkey');
        pt = await decryptEcashTokenForRecipient(senderRaw, enc);
      } else {
        throw new Error('Unsupported cipher');
      }
      const nextBounty = normalizeBounty({ ...t.bounty, token: pt, enc: null, state: 'unlocked', updatedAt: new Date().toISOString() });
      if (!nextBounty) return;
      const updated = normalizeTaskBounty({ ...t, bounty: nextBounty });
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      setEditing(prev => (prev && prev.id === id ? updated : prev));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Decrypt failed: ' + (e as Error).message);
    }
  }

  async function transferBounty(id: string, recipientHex: string) {
    let recipientRaw = ensureXOnlyHex(recipientHex);
    if (!recipientRaw) {
      const normalized = normalizeNostrPubkey(recipientHex);
      recipientRaw = ensureXOnlyHex(normalized);
    }
    if (!recipientRaw) throw new Error('Invalid recipient pubkey.');
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty) throw new Error('No bounty to transfer.');
    if (t.bounty.state === 'revoked' || t.bounty.state === 'claimed') {
      throw new Error('This bounty can no longer be reassigned.');
    }
    const me = (window as any).nostrPK as string | undefined;
    if (!me) throw new Error('Missing local Nostr key.');
    const authorized = (
      (t.bounty.sender && pubkeysEqual(t.bounty.sender, me)) ||
      (t.bounty.owner && pubkeysEqual(t.bounty.owner, me)) ||
      pubkeysEqual(t.createdBy, me)
    );
    if (!authorized) {
      throw new Error('Only the funder or owner can sign this bounty.');
    }
    if (pubkeysEqual(t.bounty.receiver, recipientRaw)) {
      throw new Error('Bounty is already locked to that recipient.');
    }

    let plainToken = t.bounty.token;
    if (!plainToken) {
      if (!t.bounty.enc) throw new Error('No token available to sign over.');
      if (t.bounty.enc.alg === 'aes-gcm-256') {
        plainToken = await decryptEcashTokenForFunder(t.bounty.enc);
      } else if (t.bounty.enc.alg === 'nip04') {
        const senderRaw = ensureXOnlyHex(t.bounty.sender);
        if (!senderRaw) throw new Error('Missing sender pubkey.');
        if (!pubkeysEqual(t.bounty.receiver, me)) {
          throw new Error('Only the current recipient can reassign this bounty.');
        }
        plainToken = await decryptEcashTokenForRecipient(senderRaw, t.bounty.enc);
      } else {
        throw new Error('Unsupported bounty cipher.');
      }
    }

    if (!plainToken?.trim()) {
      throw new Error('Token was empty after decryption.');
    }

    const enc = await encryptEcashTokenForRecipient(recipientRaw, plainToken);
    const nextBounty = normalizeBounty({
      ...t.bounty,
      token: '',
      enc,
      receiver: recipientRaw,
      lock: 'p2pk',
      state: 'locked',
      updatedAt: new Date().toISOString(),
    });
    if (!nextBounty) return;
    const updated = normalizeTaskBounty({ ...t, bounty: nextBounty });
    setTasks(prev => prev.map(x => x.id === id ? updated : x));
    setEditing(prev => (prev && prev.id === id ? updated : prev));
    maybePublishTask(updated).catch(() => {});
  }

  async function claimBounty(id: string, from?: DOMRect) {
    const t = tasks.find(x => x.id === id);
    if (!t || !t.bounty || t.bounty.state !== 'unlocked' || !t.bounty.token) return;
    try {
      const bountyToken = t.bounty.token;
      const res = await receiveToken(bountyToken);
      if (res.savedForLater) {
        alert('Token saved for later redemption. We\'ll redeem it when your connection returns.');
        return;
      }
      if (res.crossMint) {
        alert(`Redeemed to a different mint: ${res.usedMintUrl}. Switch to that mint to view the balance.`);
      }
      const redeemedAmount = res.proofs.reduce((sum, proof) => sum + (proof?.amount || 0), 0);
      appendWalletHistoryEntry({
        id: `redeem-bounty-${Date.now()}`,
        summary: `Redeemed bounty • ${redeemedAmount} sats${res.crossMint ? ` at ${res.usedMintUrl}` : ''}`,
        detail: bountyToken,
        detailKind: "token",
        type: "ecash",
        direction: "in",
        amountSat: redeemedAmount,
        mintUrl: res.usedMintUrl ?? t.bounty.mint ?? undefined,
      });
      try { if (from) flyCoinsToWallet(from); } catch {}
      const nextBounty = normalizeBounty({ ...t.bounty, token: '', state: 'claimed', updatedAt: new Date().toISOString() });
      if (!nextBounty) return;
      const updated = normalizeTaskBounty({ ...t, bounty: nextBounty });
      setTasks(prev => prev.map(x => x.id === id ? updated : x));
      setEditing(prev => (prev && prev.id === id ? updated : prev));
      maybePublishTask(updated).catch(() => {});
    } catch (e) {
      alert('Redeem failed: ' + (e as Error).message);
    }
  }

  function saveEdit(updated: Task) {
    setTasks(prev => {
      let edited: Task | null = null;
      const arr = prev.map(t => {
        if (t.id !== updated.id) return t;
        let next = updated;
        if (
          settings.streaksEnabled &&
          t.recurrence &&
          (t.recurrence.type === "daily" || t.recurrence.type === "weekly") &&
          !t.completed
        ) {
          const prevDue = startOfDay(new Date(t.dueISO));
          const newDue = startOfDay(new Date(updated.dueISO));
          if (newDue.getTime() > prevDue.getTime()) {
            next = { ...updated, streak: 0 };
          }
        }
        if (next.recurrence) next = { ...next, seriesId: next.seriesId || next.id };
        else next = { ...next, seriesId: undefined };
        const normalizedNext = normalizeTaskBounty(next);
        maybePublishTask(normalizedNext).catch(() => {});
        edited = normalizedNext;
        return normalizedNext;
      });
      return settings.showFullWeekRecurring && edited?.recurrence
        ? ensureWeekRecurrences(arr, [edited])
        : arr;
    });
    setEditing(null);
  }

  /* ---------- Drag & Drop: move or reorder ---------- */
  function moveTask(
    id: string,
    target:
      | { type: "day"; day: Weekday }
      | { type: "bounties" }
      | { type: "list"; columnId: string },
    beforeId?: string
  ) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      if (beforeId && beforeId === task.id) return prev;

      const updated: Task = { ...task };
      const prevDue = startOfDay(new Date(task.dueISO));
      const originalTime = task.dueTimeEnabled ? isoTimePart(task.dueISO) : "";
      const baseWeekday = Number.isNaN(prevDue.getTime()) ? undefined : prevDue;
      const sourceBoardId = task.boardId;
      let targetBoardId = sourceBoardId;
      if (target.type === "day") {
        updated.column = "day";
        updated.columnId = undefined;
        updated.dueISO = isoForWeekday(target.day, {
          base: baseWeekday,
          weekStart: settings.weekStart,
        });
      } else if (target.type === "bounties") {
        updated.column = "bounties";
        updated.columnId = undefined;
        updated.dueISO = isoForWeekday(0, {
          base: baseWeekday,
          weekStart: settings.weekStart,
        });
      } else {
        if (!isListLikeBoard(currentBoard)) return prev;
        const source = listColumnSources.get(target.columnId);
        if (!source) return prev;
        updated.column = undefined;
        updated.columnId = source.columnId;
        updated.boardId = source.boardId;
        targetBoardId = source.boardId;
        updated.dueISO = isoForWeekday(0);
      }
      if (originalTime) {
        const nextDatePart = isoDatePart(updated.dueISO);
        const withTime = isoFromDateTime(nextDatePart, originalTime);
        if (withTime) updated.dueISO = withTime;
      }
      const newDue = startOfDay(new Date(updated.dueISO));
      if (
        settings.streaksEnabled &&
        task.recurrence &&
        (task.recurrence.type === "daily" || task.recurrence.type === "weekly") &&
        !task.completed &&
        newDue.getTime() > prevDue.getTime()
      ) {
        updated.streak = 0;
      }
      // reveal if user manually places it
      updated.hiddenUntilISO = undefined;

      // un-complete only if it doesn't have a pending bounty
      if (updated.completed && (!updated.bounty || updated.bounty.state === "claimed")) {
        updated.completed = false;
        updated.completedAt = undefined;
        updated.completedBy = undefined;
      }

      // remove original
      arr.splice(fromIdx, 1);

      const sourceTasks: Task[] = [];
      if (sourceBoardId !== targetBoardId) {
        let order = 0;
        for (let i = 0; i < arr.length; i++) {
          const t = arr[i];
          if (t.boardId === sourceBoardId) {
            if ((t.order ?? 0) !== order) {
              arr[i] = { ...t, order };
            }
            sourceTasks.push(arr[i]);
            order++;
          }
        }
      }

      // compute insert index relative to new array
      let insertIdx = typeof beforeId === "string" ? arr.findIndex(t => t.id === beforeId) : -1;
      if (insertIdx < 0) insertIdx = arr.length;
      arr.splice(insertIdx, 0, updated);

      // recompute order for all tasks on the target board
      const boardTasks: Task[] = [];
      let order = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t.boardId === targetBoardId) {
          if (t === updated) {
            updated.order = order;
          } else {
            arr[i] = { ...t, order };
          }
          boardTasks.push(arr[i]);
          order++;
        }
      }
      const publishSet = new Set<Task>(boardTasks);
      sourceTasks.forEach((t) => publishSet.add(t));
      try {
        publishSet.forEach((t) => { maybePublishTask(t).catch(() => {}); });
      } catch {}

      return arr;
    });
  }

  function moveTaskToBoard(id: string, boardId: string) {
    setTasks(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(t => t.id === id);
      if (fromIdx < 0) return prev;
      const task = arr[fromIdx];
      const targetBoard = boards.find(b => b.id === boardId);
      if (!targetBoard || targetBoard.kind === "bible") return prev;

      // remove from source
      arr.splice(fromIdx, 1);

      // recompute order for source board
      const sourceTasks: Task[] = [];
      let order = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t.boardId === task.boardId) {
          arr[i] = { ...t, order };
          sourceTasks.push(arr[i]);
          order++;
        }
      }

      let destinationBoardId = boardId;
      const updated: Task = { ...task, boardId };
      if (targetBoard.kind === "week") {
        updated.column = "day";
        updated.columnId = undefined;
      } else if (targetBoard.kind === "compound") {
        const childBoard = targetBoard.children
          .map((childId) => boards.find((b) => b.id === childId))
          .find((b): b is Extract<Board, { kind: "lists" }> => !!b && b.kind === "lists");
        if (!childBoard || !childBoard.columns.length) return prev;
        destinationBoardId = childBoard.id;
        updated.boardId = childBoard.id;
        updated.column = undefined;
        updated.columnId = childBoard.columns[0]?.id;
        updated.dueISO = isoForWeekday(0);
      } else {
        updated.column = undefined;
        updated.columnId = targetBoard.columns[0]?.id;
        updated.dueISO = isoForWeekday(0);
      }

      arr.push(updated);

      const targetTasks: Task[] = [];
      order = 0;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i];
        if (t.boardId === (targetBoard.kind === "compound" ? destinationBoardId : boardId)) {
          if (t === updated) {
            updated.order = order;
          } else {
            arr[i] = { ...t, order };
          }
          targetTasks.push(arr[i]);
          order++;
        }
      }

      try {
        for (const t of [...sourceTasks, ...targetTasks]) maybePublishTask(t).catch(() => {});
      } catch {}

      return arr;
    });
  }

  // Subscribe to Nostr for all shared boards
  const nostrBoardsKey = useMemo(() => {
    const items = boards
      .filter(b => b.nostr?.boardId)
      .map(b => ({ id: boardTag(b.nostr!.boardId), relays: getBoardRelays(b).join(",") }))
      .sort((a,b) => (a.id + a.relays).localeCompare(b.id + b.relays));
    return JSON.stringify(items);
  }, [boards, getBoardRelays]);

  useEffect(() => {
    if (!currentBoard?.nostr?.boardId) return;
    setNostrRefresh((n) => n + 1);
  }, [currentBoard?.nostr?.boardId]);

  useEffect(() => {
    let parsed: Array<{id:string; relays:string}> = [];
    try { parsed = JSON.parse(nostrBoardsKey || "[]"); } catch {}
    const unsubs: Array<() => void> = [];
    for (const it of parsed) {
      const rls = it.relays.split(",").filter(Boolean);
      if (!rls.length) continue;
      pool.setRelays(rls);
      const filters = [
        { kinds: [30300, 30301], "#b": [it.id], limit: 500 },
        { kinds: [30300], "#d": [it.id], limit: 1 },
      ];
      const unsub = pool.subscribe(rls, filters, (ev) => {
        if (ev.kind === 30300) applyBoardEvent(ev).catch(() => {});
        else if (ev.kind === 30301) applyTaskEvent(ev).catch(() => {});
      });
      unsubs.push(unsub);
    }
    return () => { unsubs.forEach(u => u()); };
  }, [nostrBoardsKey, pool, applyBoardEvent, applyTaskEvent, nostrRefresh]);

  // horizontal scroller ref to enable iOS momentum scrolling
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bibleScrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const autoCenteredSet = autoCenteredWeekRef.current;
    const prevActive = activeWeekBoardRef.current;

    if (view !== "board") {
      if (prevActive) {
        autoCenteredSet.delete(prevActive);
        activeWeekBoardRef.current = null;
      }
      return;
    }

    if (!currentBoardId || currentBoard?.kind !== "week") {
      if (prevActive) {
        autoCenteredSet.delete(prevActive);
        activeWeekBoardRef.current = null;
      }
      return;
    }

    if (prevActive && prevActive !== currentBoardId) {
      autoCenteredSet.delete(prevActive);
    }

    activeWeekBoardRef.current = currentBoardId;
  }, [currentBoardId, currentBoard?.kind, view]);

  // reset dayChoice when board/view changes and center current day for week boards
  useEffect(() => {
    if (!currentBoard || view !== "board") return;
    if (currentBoard.kind === "bible") {
      return;
    }
    if (isListLikeBoard(currentBoard)) {
      const valid = typeof dayChoice === "string" && listColumnSources.has(dayChoice);
      if (valid) {
        lastListViewRef.current.set(currentBoard.id, dayChoice);
        return;
      }

      const stored = lastListViewRef.current.get(currentBoard.id);
      const storedValid = stored ? listColumnSources.has(stored) : false;
      const nextChoice =
        (storedValid && stored) ||
        listColumns[0]?.id ||
        (typeof dayChoice === "string" ? dayChoice : undefined);

      if (nextChoice && nextChoice !== dayChoice) {
        setDayChoice(nextChoice);
        lastListViewRef.current.set(currentBoard.id, nextChoice);
      }
    } else {
      const today = new Date().getDay() as Weekday;
      const boardId = currentBoard.id;
      const autoCenteredSet = autoCenteredWeekRef.current;
      const hasCentered = autoCenteredSet.has(boardId);
      const isValidDayChoice = typeof dayChoice === "number" && dayChoice >= 0 && dayChoice <= 6;

      if ((!hasCentered || !isValidDayChoice) && dayChoice !== today) {
        setDayChoice(today);
      }

      if (!hasCentered) {
        requestAnimationFrame(() => {
          const scroller = scrollerRef.current;
          if (!scroller) return;
          const el = scroller.querySelector(`[data-day='${today}']`) as HTMLElement | null;
          if (!el) return;
          const offset = el.offsetLeft - scroller.clientWidth / 2 + el.clientWidth / 2;
          scroller.scrollTo({ left: offset, behavior: "smooth" });
          autoCenteredSet.add(boardId);
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBoardId, currentBoard?.id, currentBoard?.kind, dayChoice, listColumnSources, listColumns, view]);

  useEffect(() => {
    const board = currentBoard;
    if (view !== "board") return;
    if (!isListLikeBoard(board)) return;
    if (typeof dayChoice !== "string") return;
    if (!listColumnSources.has(dayChoice)) return;
    const prev = lastListViewRef.current.get(board.id);
    if (prev !== dayChoice) {
      lastListViewRef.current.set(board.id, dayChoice);
    }
  }, [currentBoard, dayChoice, listColumnSources, view]);

  useEffect(() => {
    const board = currentBoard;
    if (view !== "board") return;
    if (!isListLikeBoard(board)) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const boardId = board.id;
    const scrollStore = lastBoardScrollRef.current;
    const stored = scrollStore.has(boardId) ? scrollStore.get(boardId)! : null;
    const shouldCenterIndex = !!board.indexCardEnabled;
    const autoCenteredIndexSet = autoCenteredIndexRef.current;

    const applyInitialScroll = () => {
      const latest = scrollerRef.current;
      if (!latest) return;
      const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
      if (shouldCenterIndex && !autoCenteredIndexSet.has(boardId)) {
        scrollColumnIntoView("list-index", "auto");
        autoCenteredIndexSet.add(boardId);
        requestAnimationFrame(() => {
          const latest = scrollerRef.current;
          if (!latest) return;
          const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
          const clamped = Math.min(Math.max(latest.scrollLeft, 0), maxScroll);
          scrollStore.set(boardId, clamped);
        });
        return;
      }
      const target = stored == null ? 0 : Math.min(Math.max(stored, 0), maxScroll);
      if (Math.abs(latest.scrollLeft - target) > 1) {
        latest.scrollTo({ left: target, behavior: "auto" });
      } else {
        latest.scrollLeft = target;
      }
    };

    applyInitialScroll();
    const raf = requestAnimationFrame(applyInitialScroll);
    let timeout: number | undefined;
    if (typeof window !== "undefined") {
      timeout = window.setTimeout(applyInitialScroll, 150);
    }

    const handleScroll = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (typeof timeout === "number") {
        window.clearTimeout(timeout);
      }
      cancelAnimationFrame(raf);
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
      if (!board.indexCardEnabled) {
        autoCenteredIndexSet.delete(boardId);
      }
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [currentBoard, scrollColumnIntoView, view]);

  useLayoutEffect(() => {
    if (currentBoard?.kind !== "bible") return;
    if (view === "completed") return;
    const scroller = bibleScrollerRef.current;
    if (!scroller) return;

    const boardId = currentBoard.id;
    const scrollStore = lastBoardScrollRef.current;
    const stored = scrollStore.get(boardId) ?? 0;

    const applyStoredScroll = () => {
      const latest = bibleScrollerRef.current;
      if (!latest) return;
      const maxScroll = Math.max(0, latest.scrollWidth - latest.clientWidth);
      const target = Math.min(Math.max(stored, 0), maxScroll);
      if (Math.abs(latest.scrollLeft - target) > 1) {
        latest.scrollTo({ left: target, behavior: "auto" });
      } else {
        latest.scrollLeft = target;
      }
    };

    applyStoredScroll();
    const raf = requestAnimationFrame(applyStoredScroll);
    let timeout: number | undefined;
    if (typeof window !== "undefined") {
      timeout = window.setTimeout(applyStoredScroll, 150);
    }

    const handleScroll = () => {
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      if (typeof timeout === "number") {
        window.clearTimeout(timeout);
      }
      cancelAnimationFrame(raf);
      const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const clamped = Math.min(Math.max(scroller.scrollLeft, 0), maxScroll);
      scrollStore.set(boardId, clamped);
      scroller.removeEventListener("scroll", handleScroll);
    };
  }, [currentBoard?.id, currentBoard?.kind, view]);

  const currentTutorial = tutorialStep != null ? tutorialSteps[tutorialStep] : null;
  const totalTutorialSteps = tutorialSteps.length;
  const activeView = !settings.completedTab && view === "completed" ? "board" : view;

  return (
    <div className="min-h-screen px-4 py-4 sm:px-6 lg:px-8 text-primary">
      <div className="mx-auto max-w-7xl space-y-5">
        {/* Header */}
        <header className="relative space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1 justify-end -translate-y-[2px]">
              <h1 className="text-3xl font-semibold tracking-tight">
                Taskify
              </h1>
              <div
                ref={boardDropContainerRef}
                className="relative min-w-0 sm:min-w-[12rem]"
                style={{ maxWidth: 'min(28rem, calc(100vw - 7.5rem))' }}
                onDragOver={e => {
                  if (!draggingTaskId) return;
                  e.preventDefault();
                  cancelBoardDropClose();
                  if (!boardDropOpen && !boardDropTimer.current) {
                    boardDropTimer.current = window.setTimeout(() => {
                      const rect = boardDropContainerRef.current?.getBoundingClientRect();
                      if (rect) {
                        setBoardDropPos({ top: rect.top, left: rect.right });
                      }
                      setBoardDropOpen(true);
                      boardDropTimer.current = undefined;
                    }, 500);
                  }
                }}
                onDragLeave={() => {
                  if (!draggingTaskId) return;
                  if (boardDropTimer.current) {
                    window.clearTimeout(boardDropTimer.current);
                    boardDropTimer.current = undefined;
                  }
                  scheduleBoardDropClose();
                }}
              >
                <select
                  ref={boardSelectorRef}
                  value={currentBoardId}
                  onChange={handleBoardSelect}
                  className="pill-select w-full min-w-0 truncate sm:w-auto sm:min-w-[12rem]"
                  style={{ textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title="Boards"
                >
                  {visibleBoards.length === 0 ? (
                    <option value="">No boards</option>
                  ) : (
                    visibleBoards.map(b => <option key={b.id} value={b.id}>{b.name}</option>)
                  )}
                </select>
                {boardDropOpen && boardDropPos &&
                  createPortal(
                    <div
                      ref={boardDropListRef}
                      className="glass-panel fixed z-50 w-56 p-2"
                      style={{ top: boardDropPos.top, left: boardDropPos.left }}
                      onDragOver={e => {
                        if (!draggingTaskId) return;
                        e.preventDefault();
                        cancelBoardDropClose();
                      }}
                      onDragLeave={() => {
                        if (!draggingTaskId) return;
                        scheduleBoardDropClose();
                      }}
                    >
                      {visibleBoards.filter(b => b.kind !== "bible").length === 0 ? (
                        <div className="rounded-xl px-3 py-2 text-sm text-secondary">
                          No boards
                        </div>
                      ) : (
                        visibleBoards
                          .filter(b => b.kind !== "bible")
                          .map(b => (
                            <div
                              key={b.id}
                              className="rounded-xl px-3 py-2 text-primary hover:bg-surface-muted"
                              onDragOver={e => { if (draggingTaskId) e.preventDefault(); }}
                              onDrop={e => {
                                if (!draggingTaskId) return;
                                e.preventDefault();
                                moveTaskToBoard(draggingTaskId, b.id);
                                handleDragEnd();
                              }}
                            >
                              {b.name}
                            </div>
                          ))
                      )}
                    </div>,
                    document.body
                  )}
              </div>
            </div>
            <div className="ml-auto">
              <div className="control-matrix glass-panel">
                <button
                  ref={walletButtonRef}
                  className="control-matrix__btn pressable"
                  onClick={openWallet}
                  title="Wallet"
                  aria-label="Open Cashu wallet"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="#fff"
                    strokeWidth={2.4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="4" x2="12" y2="20" />
                    <line x1="8" y1="8" x2="16" y2="8" />
                    <line x1="7" y1="12" x2="17" y2="12" />
                    <line x1="8" y1="16" x2="16" y2="16" />
                    <line x1="12" y1="2.75" x2="12" y2="5.25" />
                    <line x1="12" y1="18.75" x2="12" y2="21.25" />
                  </svg>
                </button>
                <button
                  className="control-matrix__btn pressable"
                  onClick={openSettings}
                  title="Settings"
                  aria-label="Open settings"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="#fff"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2h-.34a2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2h.34a2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </button>
                {settings.completedTab ? (
                  <button
                    ref={completedTabRef}
                    className="control-matrix__btn pressable"
                    data-active={view === "completed"}
                    onClick={() => setView((prev) => (prev === "completed" ? "board" : "completed"))}
                    aria-pressed={view === "completed"}
                    aria-label={view === "completed" ? "Show board" : "Show completed tasks"}
                    title={view === "completed" ? "Show board" : "Show completed tasks"}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="#fff"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 12.5l3.75 3.75L18 8.5" />
                    </svg>
                  </button>
                ) : currentBoard?.kind !== "bible" && !currentBoard?.clearCompletedDisabled ? (
                  <button
                    ref={completedTabRef}
                    className="control-matrix__btn pressable"
                    onClick={clearCompleted}
                    disabled={completed.length === 0}
                    aria-label="Clear completed tasks"
                    title="Clear completed tasks"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      className="h-[18px] w-[18px]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M4 6h16" />
                      <path d="M6 6v12a1 1 0 001 1h10a1 1 0 001-1V6" />
                      <path d="M9 6V4h6v2" />
                      <path d="M10 11l4 4" />
                      <path d="M14 11l-4 4" />
                    </svg>
                  </button>
                ) : null}
                <button
                  ref={upcomingButtonRef}
                  className="control-matrix__btn pressable"
                  onClick={openUpcoming}
                  title={`Upcoming tasks${upcoming.length ? ` (${upcoming.length})` : ""}`}
                  aria-label={`Open upcoming tasks (${upcoming.length})`}
                  data-hovered={upcomingHover}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setUpcomingHover(true);
                  }}
                  onDragLeave={() => setUpcomingHover(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/task-id");
                    if (id) postponeTaskOneWeek(id);
                    setUpcomingHover(false);
                    handleDragEnd();
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-[18px] w-[18px]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="#fff"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="4" y="5" width="16" height="15" rx="2" />
                    <path d="M8 3v4" />
                    <path d="M16 3v4" />
                    <path d="M4 11h16" />
                    <path d="M12 14v3l2 1" />
                  </svg>
                  <span className="sr-only">Upcoming tasks</span>
                </button>
              </div>
              {!settings.completedTab && currentBoard?.kind !== "bible" && !currentBoard?.clearCompletedDisabled && (
                <button
                  className="ghost-button button-sm pressable mt-2 w-full disabled:opacity-50"
                  onClick={clearCompleted}
                  disabled={completed.length === 0}
                >
                  Clear completed
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Animation overlay for fly effects (coins, etc.) */}
        <div ref={flyLayerRef} className="pointer-events-none fixed inset-0 z-[9999]" />

        {/* Add bar */}
        {activeView === "board" && currentBoard && !settings.inlineAdd && (
          <div className="glass-panel flex flex-wrap gap-2 items-center w-full p-3 mb-4">
            <input
              ref={newTitleRef}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onPaste={handleAddPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTask(true);
                }
              }}
              placeholder="New task…"
              className="pill-input pill-input--compact flex-1 min-w-0"
            />
            <input
              ref={newDocumentInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              multiple
              className="hidden"
              onChange={handleNewDocumentSelection}
            />
            <button
              type="button"
              className="ghost-button button-sm pressable shrink-0"
              onClick={() => newDocumentInputRef.current?.click()}
              aria-label="Attach document"
            >
              📎
            </button>
            <button
              ref={addButtonRef}
              onClick={() => addTask()}
              className="accent-button accent-button--circle pressable shrink-0"
              type="button"
              aria-label="Add task"
            >
              <span aria-hidden="true">+</span>
              <span className="sr-only">Add task</span>
            </button>
            {newImages.length > 0 && (
              <div className="w-full flex gap-2 mt-2">
                {newImages.map((img, i) => (
                  <img key={i} src={img} className="h-16 rounded-lg" />
                ))}
              </div>
            )}
            {newDocuments.length > 0 && (
              <div className="w-full flex flex-wrap gap-1">
                {newDocuments.map((doc, index) => (
                  <span key={doc.id} className="doc-chip">
                    <span className="doc-chip__label">{doc.name}</span>
                    <button
                      type="button"
                      className="doc-chip__remove"
                      onClick={() =>
                        setNewDocuments((prev) => prev.filter((_, idx) => idx !== index))
                      }
                      aria-label={`Remove ${doc.name}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Column picker and recurrence */}
            <div className="w-full flex gap-2 items-center">
              {currentBoard?.kind === "week" ? (
                <select
                  value={dayChoice === "bounties" ? "bounties" : String(dayChoice)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDayChoice(v === "bounties" ? "bounties" : (Number(v) as Weekday));
                    setScheduleDate("");
                    setScheduleTime("");
                  }}
                  className="pill-select flex-1 min-w-0 truncate"
                >
                  {WD_SHORT.map((d,i)=>(<option key={i} value={i}>{d}</option>))}
                  <option value="bounties">Bounties</option>
                </select>
              ) : (
                <select
                  value={String(dayChoice)}
                  onChange={(e)=>focusListColumn(e.target.value)}
                  className="pill-select flex-1 min-w-0 truncate"
                >
                  {listColumns.map(c => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              )}

              {/* Recurrence select with Custom… */}
              <select
                value={quickRule}
                onChange={(e) => {
                  const v = e.target.value as typeof quickRule;
                  setQuickRule(v);
                  if (v === "custom") setShowAddAdvanced(true);
                }}
                className="pill-select shrink-0 w-fit"
                title="Recurrence"
              >
                <option value="none">No recurrence</option>
                <option value="daily">Daily</option>
                <option value="weeklyMonFri">Mon–Fri</option>
                <option value="weeklyWeekends">Weekends</option>
                <option value="every2d">Every 2 days</option>
                <option value="custom">Custom…</option>
              </select>

              {quickRule === "custom" && addCustomRule.type !== "none" && (
                <span className="flex-shrink-0 text-xs text-secondary">({labelOf(addCustomRule)})</span>
              )}
            </div>
          </div>
        )}

        {/* Board/Completed */}
        <div className="relative">
          {activeView === "bible" ? (
            settings.bibleTrackerEnabled ? (
              <div
                ref={bibleScrollerRef}
                className="overflow-x-auto pb-4 w-full"
                style={{ WebkitOverflowScrolling: "touch" }}
              >
                <div className="flex min-w-max items-start gap-4">
                  <div className="surface-panel board-column w-[360px] shrink-0 overflow-hidden">
                    <div className="p-4">
                      <BibleTracker
                        state={bibleTracker}
                        onToggleBook={handleToggleBibleBook}
                        onToggleChapter={handleToggleBibleChapter}
                        onUpdateChapterVerses={handleUpdateBibleChapterVerses}
                        onReset={handleResetBibleTracker}
                        onDeleteArchive={handleDeleteBibleArchive}
                        onRestoreArchive={handleRestoreBibleArchive}
                        onCompleteBook={handleCompleteBibleBook}
                      />
                    </div>
                  </div>
                  {settings.scriptureMemoryEnabled ? (
                    <ScriptureMemoryCard
                      items={scriptureMemoryItems}
                      onAdd={handleAddScriptureMemory}
                      onRemove={handleRemoveScriptureMemory}
                      onReview={handleReviewScriptureMemory}
                      boardName={scriptureMemoryBoard?.name || undefined}
                      frequencyLabel={scriptureMemoryFrequencyOption?.label ?? "Daily"}
                      sortLabel={scriptureMemorySortLabel}
                    />
                  ) : (
                    <div className="surface-panel board-column w-[360px] shrink-0 p-4 text-sm text-secondary">
                      Enable scripture memory from Settings to start adding passages you want to review.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="surface-panel p-6 text-center text-sm text-secondary">
                Enable the Bible tracker from Settings to start tracking your reading.
              </div>
            )
          ) : activeView === "board" ? (
            !currentBoard ? (
              <div className="surface-panel p-6 text-center text-sm text-secondary">No boards. Open Settings to create one.</div>
            ) : currentBoard?.kind === "week" ? (
              <>
              {/* HORIZONTAL board: single row, side-scroll */}
              <div
                ref={scrollerRef}
                className="overflow-x-auto pb-4 w-full"
                style={{ WebkitOverflowScrolling: "touch" }} // fluid momentum scroll on iOS
              >
                <div className="flex gap-4 min-w-max">
                  {Array.from({ length: 7 }, (_, i) => i as Weekday).map((day) => (
                    <DroppableColumn
                      ref={el => setColumnRef(`week-day-${day}`, el)}
                      key={day}
                      title={WD_SHORT[day]}
                      onTitleClick={() => { setDayChoice(day); setScheduleDate(""); setScheduleTime(""); }}
                      onDropCard={(payload) => moveTask(payload.id, { type: "day", day }, payload.beforeId)}
                      onDropEnd={handleDragEnd}
                      data-day={day}
                      scrollable={settings.inlineAdd}
                      footer={settings.inlineAdd ? (
                        <form
                          className="mt-2 flex gap-1"
                          onSubmit={(e) => { e.preventDefault(); addInlineTask(String(day)); }}
                        >
                          <input
                            ref={el => setInlineInputRef(String(day), el)}
                            value={inlineTitles[String(day)] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, [String(day)]: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="Add task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
                        </form>
                      ) : undefined}
                    >
                        {(byDay.get(day) || []).map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing(t)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "day", day }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                          onOpenDocument={handleOpenDocument}
                        />
                      ))}
                    </DroppableColumn>
                  ))}

                  {/* Bounties */}
                  <DroppableColumn
                    ref={el => setColumnRef("week-bounties", el)}
                    title="Bounties"
                    onTitleClick={() => { setDayChoice("bounties"); setScheduleDate(""); setScheduleTime(""); }}
                    onDropCard={(payload) => moveTask(payload.id, { type: "bounties" }, payload.beforeId)}
                    onDropEnd={handleDragEnd}
                    scrollable={settings.inlineAdd}
                    footer={settings.inlineAdd ? (
                      <form
                        className="mt-2 flex gap-1"
                        onSubmit={(e) => { e.preventDefault(); addInlineTask("bounties"); }}
                      >
                          <input
                            ref={el => setInlineInputRef("bounties", el)}
                            value={inlineTitles["bounties"] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, bounties: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="Add task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
                      </form>
                    ) : undefined}
                  >
                      {bounties.map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing(t)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "bounties" }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                          onOpenDocument={handleOpenDocument}
                        />
                    ))}
                  </DroppableColumn>
                </div>
              </div>
            </>
            ) : currentBoard?.kind === "bible" ? (
            <div
              ref={bibleScrollerRef}
              className="overflow-x-auto pb-4 w-full"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex min-w-max items-start gap-4">
                <div className="surface-panel board-column w-[360px] shrink-0 overflow-hidden">
                  <div className="p-4">
                    <BibleTracker
                      state={bibleTracker}
                      onToggleBook={handleToggleBibleBook}
                      onToggleChapter={handleToggleBibleChapter}
                      onUpdateChapterVerses={handleUpdateBibleChapterVerses}
                      onReset={handleResetBibleTracker}
                      onDeleteArchive={handleDeleteBibleArchive}
                      onRestoreArchive={handleRestoreBibleArchive}
                      onCompleteBook={handleCompleteBibleBook}
                    />
                  </div>
                </div>
                {settings.scriptureMemoryEnabled ? (
                  <ScriptureMemoryCard
                    items={scriptureMemoryItems}
                    onAdd={handleAddScriptureMemory}
                    onRemove={handleRemoveScriptureMemory}
                    onReview={handleReviewScriptureMemory}
                    boardName={scriptureMemoryBoard?.name || undefined}
                    frequencyLabel={scriptureMemoryFrequencyOption?.label ?? "Daily"}
                    sortLabel={scriptureMemorySortLabel}
                  />
                ) : (
                  <div className="surface-panel board-column w-[360px] shrink-0 p-4 text-sm text-secondary">
                    Enable scripture memory from Settings to start adding passages you want to review.
                  </div>
                )}
              </div>
            </div>
            ) : (
              // LISTS board (multiple custom columns) — still a horizontal row
              <div
                ref={scrollerRef}
                className="overflow-x-auto pb-4 w-full"
                style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className="flex gap-4 min-w-max">
                {currentBoard.indexCardEnabled && (
                  <div
                    ref={el => setColumnRef("list-index", el)}
                    className="board-column surface-panel w-[325px] shrink-0 p-3"
                  >
                    <div className="mb-3 text-sm font-semibold tracking-wide text-secondary">Index</div>
                    <div className="flex flex-col gap-1.5 max-h-[calc(100vh-15rem)] overflow-y-auto pr-1">
                      {listColumns.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-surface bg-surface-muted px-3 py-6 text-center text-sm text-secondary">
                          No lists yet.
                        </div>
                      ) : currentBoard.kind === "compound" ? (
                        (() => {
                          let indexCounter = 0;
                          const hideNames = currentBoard.hideChildBoardNames;
                          return compoundIndexGroups.map((group, groupIndex) => (
                            <div key={group.key} className="space-y-1.5" data-group-index={groupIndex}>
                              {!hideNames && (
                                <div className={`px-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-secondary/70 ${groupIndex > 0 ? "mt-2" : ""}`}>
                                  {group.boardName}
                                </div>
                              )}
                              {group.columns.map((col) => {
                                const order = ++indexCounter;
                                const active = dayChoice === col.id;
                                const baseClass =
                                  "pressable flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition";
                                const stateClass = active
                                  ? "border-accent/60 bg-accent/15 text-primary"
                                  : "border-surface bg-surface-muted text-secondary hover:bg-surface hover:text-primary";
                                const source = listColumnSources.get(col.id);
                                const title = source ? `${source.boardName} • ${col.name}` : col.name;
                                return (
                                  <button
                                    key={col.id}
                                    type="button"
                                    className={`${baseClass} ${stateClass}`}
                                    onClick={() => focusListColumn(col.id)}
                                    aria-current={active ? "true" : undefined}
                                    title={title}
                                  >
                                    <span className="truncate">{col.name}</span>
                                    <span className={active ? "text-xs text-primary/80" : "text-xs text-secondary"}>{order}</span>
                                  </button>
                                );
                              })}
                            </div>
                          ));
                        })()
                      ) : (
                        listColumns.map((col, idx) => {
                          const active = dayChoice === col.id;
                          const baseClass =
                            "pressable flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition";
                          const stateClass = active
                            ? "border-accent/60 bg-accent/15 text-primary"
                            : "border-surface bg-surface-muted text-secondary hover:bg-surface hover:text-primary";
                          return (
                            <button
                              key={col.id}
                              type="button"
                              className={`${baseClass} ${stateClass}`}
                              onClick={() => focusListColumn(col.id)}
                              aria-current={active ? "true" : undefined}
                              title={col.name}
                            >
                              <span className="truncate">{col.name}</span>
                              <span className={active ? "text-xs text-primary/80" : "text-xs text-secondary"}>{idx + 1}</span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
                {listColumns.map(col => {
                  const isRenaming = renamingColumnId === col.id;
                  const draftName = columnDrafts[col.id] ?? col.name;
                  const header = isRenaming ? (
                    <form
                      className="mb-3 flex items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        commitRenameColumn(col.id);
                      }}
                    >
                      <input
                        ref={(el) => setColumnNameInputRef(col.id, el)}
                        value={draftName}
                        onChange={(e) =>
                          setColumnDrafts((prev) => ({ ...prev, [col.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRenameColumn(col.id);
                          }
                        }}
                        className="w-[190px] max-w-full bg-transparent text-sm font-semibold tracking-wide text-primary focus:outline-none border-b border-white/10 focus:border-white/30 pb-1"
                        placeholder="List name"
                      />
                      <button
                        type="submit"
                        className="h-9 w-9 rounded-full border border-white/20 bg-white/15 text-lg font-semibold text-primary flex items-center justify-center hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent"
                        aria-label="Save list name"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="ml-auto text-[11px] font-medium text-secondary hover:text-primary"
                        onClick={() => cancelRenameColumn(col.id)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : undefined;
                  return (
                    <DroppableColumn
                      ref={el => setColumnRef(`list-${col.id}`, el)}
                      key={col.id}
                      title={draftName}
                      header={header}
                      onTitleClick={() => focusListColumn(col.id)}
                      onDropCard={(payload) => moveTask(payload.id, { type: "list", columnId: col.id }, payload.beforeId)}
                      onDropEnd={handleDragEnd}
                      scrollable={settings.inlineAdd}
                      footer={settings.inlineAdd ? (
                        <form
                          className="mt-2 flex gap-1"
                          onSubmit={(e) => { e.preventDefault(); addInlineTask(col.id); }}
                        >
                          <input
                            ref={el => setInlineInputRef(col.id, el)}
                            value={inlineTitles[col.id] || ""}
                            onChange={(e) => setInlineTitles(prev => ({ ...prev, [col.id]: e.target.value }))}
                            className="pill-input pill-input--compact flex-1 min-w-0"
                            placeholder="Add task"
                          />
                          <button
                            type="submit"
                            className="accent-button accent-button--circle pressable shrink-0"
                            aria-label="Add task"
                          >
                            <span aria-hidden="true">+</span>
                            <span className="sr-only">Add task</span>
                          </button>
                        </form>
                      ) : undefined}
                    >
                      {(itemsByColumn.get(col.id) || []).map((t) => (
                        <Card
                          key={t.id}
                          task={t}
                          onFlyToCompleted={(rect) => { if (settings.completedTab) flyToCompleted(rect); }}
                          onComplete={(from) => {
                            if (!t.completed) completeTask(t.id);
                            else if (t.bounty && t.bounty.state === 'locked') revealBounty(t.id);
                            else if (t.bounty && t.bounty.state === 'unlocked' && t.bounty.token) claimBounty(t.id, from);
                            else restoreTask(t.id);
                          }}
                          onEdit={() => setEditing(t)}
                          onDropBefore={(dragId) => moveTask(dragId, { type: "list", columnId: col.id }, t.id)}
                          showStreaks={settings.streaksEnabled}
                          onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                          onDragStart={(id) => setDraggingTaskId(id)}
                          onDragEnd={handleDragEnd}
                          hideCompletedSubtasks={settings.hideCompletedSubtasks}
                          onOpenDocument={handleOpenDocument}
                        />
                      ))}
                    </DroppableColumn>
                  );
                })}
                {settings.listAddButtonEnabled && currentBoard.kind === "lists" && (
                  <div className="board-column surface-panel w-[325px] shrink-0 p-4 flex flex-col gap-4">
                    <div className="flex-1 rounded-3xl border border-white/5 bg-white/5 backdrop-blur-sm shadow-inner flex flex-col items-center justify-center gap-3 text-center p-6">
                      <div className="text-base font-semibold">Add list</div>
                      <button
                        type="button"
                        className="w-16 h-16 rounded-full border border-white/20 bg-white/15 backdrop-blur-lg shadow-lg flex items-center justify-center text-2xl text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent"
                        onClick={handleQuickAddList}
                        aria-label="Add list"
                      >
                        +
                      </button>
                      <div className="text-sm text-secondary max-w-[240px]">
                        Build an empty board and drop your first tasks here.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        ) : (
          // Completed view
          <div className="surface-panel board-column p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="text-lg font-semibold">Completed</div>
              {currentBoard?.kind !== "bible" && !currentBoard?.clearCompletedDisabled && (
                <div className="ml-auto">
                  <button
                    className="ghost-button button-sm pressable text-rose-400"
                    onClick={clearCompleted}
                  >
                    Clear completed
                  </button>
                </div>
              )}
            </div>
            {currentBoard?.kind === "bible" ? (
              completedBibleBooks.length === 0 ? (
                <div className="text-secondary text-sm">No completed books yet.</div>
              ) : (
                <ul className="space-y-1.5">
                  {completedBibleBooks.map((book) => (
                    <li
                      key={book.id}
                      className="task-card space-y-2"
                      data-state="completed"
                      data-form="pill"
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <div className="text-sm font-medium leading-[1.15]">{book.name}</div>
                          <div className="text-xs text-secondary">
                            {book.completedAtISO
                              ? `Completed ${new Date(book.completedAtISO).toLocaleString()}`
                              : "Completed book"}
                          </div>
                        </div>
                        <IconButton label="Restore" onClick={() => handleRestoreBibleBook(book.id)} intent="success">
                          ↩︎
                        </IconButton>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            ) : completed.length === 0 ? (
              <div className="text-secondary text-sm">No completed tasks yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {completed.map((t) => {
                  const hasDetail =
                    !!t.note?.trim() ||
                    (t.images && t.images.length > 0) ||
                    (t.documents && t.documents.length > 0) ||
                    (t.subtasks && t.subtasks.length > 0) ||
                    !!t.bounty;
                  const bountyLabel = t.bounty ? bountyStateLabel(t.bounty) : "";
                  return (
                    <li key={t.id} className="task-card space-y-2" data-state="completed" data-form={hasDetail ? 'stacked' : 'pill'}>
                      <div className="flex items-start gap-2">
                        <div className="flex-1">
                          <div className="text-sm font-medium leading-[1.15]">
                            <TaskTitle task={t} />
                          </div>
                          <div className="text-xs text-secondary">
                            {currentBoard?.kind === "week"
                              ? `Scheduled ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}${t.dueTimeEnabled ? ` at ${formatTimeLabel(t.dueISO)}` : ""}`
                              : "Completed item"}
                            {t.completedAt ? ` • Completed ${new Date(t.completedAt).toLocaleString()}` : ""}
                            {settings.streaksEnabled &&
                              t.recurrence &&
                              (t.recurrence.type === "daily" || t.recurrence.type === "weekly") &&
                              typeof t.streak === "number" && t.streak > 0
                                ? ` • 🔥 ${t.streak}`
                                : ""}
                          </div>
                          <TaskMedia task={t} onOpenDocument={handleOpenDocument} />
                          {t.subtasks?.length ? (
                            <ul className="mt-1 space-y-1 text-xs">
                              {t.subtasks.map(st => (
                                <li key={st.id} className="subtask-row">
                                  <input type="checkbox" checked={!!st.completed} disabled className="subtask-row__checkbox" />
                                  <span className={`subtask-row__text ${st.completed ? 'line-through text-secondary' : ''}`}>{st.title}</span>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                          {t.bounty && (
                            <div className="mt-1">
                              <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${t.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : t.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : t.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-surface-muted border-surface'}`}>
                                Bounty {typeof t.bounty.amount==='number' ? `• ${t.bounty.amount} sats` : ''} • {bountyLabel}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <IconButton label="Restore" onClick={() => restoreTask(t.id)} intent="success">↩︎</IconButton>
                          <IconButton label="Delete" onClick={() => deleteTask(t.id)} intent="danger">✕</IconButton>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Upcoming Drawer */}
      {activeView === "board" && currentBoard?.kind !== "bible" && showUpcoming && (
      <SideDrawer title="Upcoming" onClose={() => setShowUpcomingState(false)}>
          {upcoming.length === 0 ? (
            <div className="text-sm text-secondary">No upcoming tasks.</div>
          ) : (
            <ul className="space-y-1.5">
              {upcoming.map((t) => {
                const visibleSubtasks = settings.hideCompletedSubtasks
                  ? (t.subtasks?.filter((st) => !st.completed) ?? [])
                  : (t.subtasks ?? []);
                const bountyLabel = t.bounty ? bountyStateLabel(t.bounty) : "";
                return (
                  <li key={t.id} className="task-card space-y-2" data-form="stacked">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <div className="text-sm font-medium leading-[1.15]"><TaskTitle task={t} /></div>
                        <div className="text-xs text-secondary">
                          {currentBoard?.kind === "week"
                            ? `Scheduled ${WD_SHORT[new Date(t.dueISO).getDay() as Weekday]}${t.dueTimeEnabled ? ` at ${formatTimeLabel(t.dueISO)}` : ""}`
                            : "Hidden item"}
                          {t.hiddenUntilISO ? ` • Reveals ${new Date(t.hiddenUntilISO).toLocaleDateString()}` : ""}
                        </div>
                        <TaskMedia task={t} onOpenDocument={handleOpenDocument} />
                        {visibleSubtasks.length ? (
                          <ul className="mt-1 space-y-1 text-xs">
                            {visibleSubtasks.map((st) => (
                              <li key={st.id} className="subtask-row">
                                <input type="checkbox" checked={!!st.completed} disabled className="subtask-row__checkbox" />
                                <span className={`subtask-row__text ${st.completed ? 'line-through text-secondary' : ''}`}>{st.title}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {t.bounty && (
                          <div className="mt-1">
                            <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${t.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : t.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : t.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-surface-muted border-surface'}`}>
                              Bounty {typeof t.bounty.amount==='number' ? `• ${t.bounty.amount} sats` : ''} • {bountyLabel}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <IconButton label="Restore" onClick={() => restoreTask(t.id)} intent="success">↩︎</IconButton>
                        <IconButton label="Delete" onClick={() => deleteTask(t.id)} intent="danger">✕</IconButton>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        className="accent-button button-sm pressable"
                        onClick={() =>
                          setTasks((prev) =>
                            prev.map((x) =>
                              x.id === t.id ? { ...x, hiddenUntilISO: undefined } : x
                            )
                          )
                        }
                      >
                        Reveal now
                      </button>
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={() => { setEditing(t); setShowUpcomingState(false); }}
                      >
                        Edit
                      </button>
                      <button
                        className="ghost-button button-sm pressable text-rose-400"
                        onClick={() => deleteTask(t.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </SideDrawer>
      )}

      {/* Drag trash can */}
      {draggingTaskId && (
        <div
          className="fixed bottom-4 left-4 z-50"
          onDragOver={(e) => {
            e.preventDefault();
            setTrashHover(true);
          }}
          onDragLeave={() => setTrashHover(false)}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/task-id");
            if (id) deleteTask(id);
            handleDragEnd();
          }}
        >
          <div
            className={`w-14 h-14 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-secondary transition-transform ${trashHover ? 'scale-110' : ''}`}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="pointer-events-none"
            >
              <path d="M9 3h6l1 1h5v2H3V4h5l1-1z" />
              <path d="M5 7h14l-1.5 13h-11L5 7z" />
            </svg>
          </div>
        </div>
      )}

      {/* Undo Snackbar */}
      {undoTask && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-surface-muted border border-surface text-sm px-4 py-2 rounded-xl shadow-lg flex items-center gap-3">
          Task deleted
          <button onClick={undoDelete} className="accent-button button-sm pressable">Undo</button>
        </div>
      )}

      {updateToastVisible && (
        <div className="fixed bottom-4 left-1/2 z-[10001] w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
          <div className="rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 text-sm text-white shadow-lg">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-base font-semibold">Update available</div>
                <div className="text-xs text-neutral-300">
                  Reload to get the latest Taskify features.
                </div>
              </div>
              <div className="flex gap-2 sm:shrink-0">
                <button
                  className="ghost-button button-sm pressable"
                  onClick={handleReloadLater}
                >
                  Later
                </button>
                <button
                  className="accent-button button-sm pressable"
                  onClick={handleReloadNow}
                >
                  Reload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal (with Advanced recurrence) */}
      {editing && (
        <EditModal
          task={editing}
          onCancel={() => setEditing(null)}
          onDelete={() => { deleteTask(editing.id); setEditing(null); }}
          onSave={saveEdit}
          weekStart={settings.weekStart}
          boardKind={editingBoard?.kind ?? currentBoard?.kind ?? "week"}
          onRedeemCoins={(rect)=>flyCoinsToWallet(rect)}
          onRevealBounty={revealBounty}
          onTransferBounty={transferBounty}
          onPreviewDocument={handleOpenDocument}
        />
      )}

      {previewDocument && (
        <DocumentPreviewModal
          document={previewDocument}
          onClose={() => setPreviewDocument(null)}
          onDownloadDocument={handleDownloadDocument}
          onOpenExternal={openDocumentExternally}
        />
      )}

      {/* Add bar Advanced recurrence modal */}
      {showAddAdvanced && (
        <RecurrenceModal
          initial={addCustomRule}
          initialSchedule={scheduleDate}
          onClose={() => setShowAddAdvanced(false)}
          onApply={(r, sched) => {
            setAddCustomRule(r);
            setScheduleDate(sched || "");
            if (sched && currentBoard?.kind === "week" && dayChoice !== "bounties") {
              setDayChoice(new Date(sched).getDay() as Weekday);
            }
            setShowAddAdvanced(false);
          }}
        />
      )}

      {tutorialStep !== null && currentTutorial && (
        <Modal
          onClose={handleSkipTutorial}
          title={currentTutorial.title}
          showClose={false}
        >
          <div className="space-y-4">
            <div className="text-xs uppercase tracking-wide text-secondary">
              Step {tutorialStep + 1} of {totalTutorialSteps}
            </div>
            {currentTutorial.body}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <button
                className="ghost-button button-sm pressable"
                onClick={handleSkipTutorial}
              >
                Skip tutorial
              </button>
              <div className="flex gap-2">
                {tutorialStep > 0 && (
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={handlePrevTutorial}
                  >
                    Back
                  </button>
                )}
                <button
                  className="accent-button button-sm pressable"
                  onClick={handleNextTutorial}
                >
                  {tutorialStep === totalTutorialSteps - 1 ? "Finish" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* Settings (Week start + Manage Boards & Columns) */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          boards={boards}
          currentBoardId={currentBoardId}
          setSettings={setSettings}
          setBoards={setBoards}
          shouldReloadForNavigation={shouldReloadForNavigation}
          defaultRelays={defaultRelays}
          setDefaultRelays={setDefaultRelays}
          pubkeyHex={nostrPK}
          onGenerateKey={rotateNostrKey}
          onSetKey={setCustomNostrKey}
          onRestartTutorial={handleRestartTutorial}
          pushWorkState={pushWorkState}
          pushError={pushError}
          onEnablePush={enablePushNotifications}
          onDisablePush={disablePushNotifications}
          workerBaseUrl={workerBaseUrl}
          vapidPublicKey={vapidPublicKey}
          onResetWalletTokenTracking={handleResetWalletTokenTracking}
          onShareBoard={(boardId, relayCsv) => {
            const r = (relayCsv || "").split(",").map(s=>s.trim()).filter(Boolean);
            const relays = r.length ? r : defaultRelays;
            setBoards(prev => prev.map(b => {
              if (b.id !== boardId) return b;
              const nostrId = b.nostr?.boardId || (/^[0-9a-f-]{8}-[0-9a-f-]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id) ? b.id : crypto.randomUUID());
              let nb: Board;
              if (b.kind === "week") {
                nb = { ...b, nostr: { boardId: nostrId, relays } };
              } else if (b.kind === "compound") {
                nb = { ...b, nostr: { boardId: nostrId, relays } } as Board;
              } else {
                nb = { ...b, nostr: { boardId: nostrId, relays } } as Board;
              }
              setTimeout(() => {
                publishBoardMetadata(nb).catch(() => {});
                tasks.filter(t => t.boardId === nb.id).forEach(t => {
                  maybePublishTask(t, nb, { skipBoardMetadata: true }).catch(() => {});
                });
              }, 0);
              return nb;
            }));
          }}
          onJoinBoard={(nostrId, name, relayCsv) => {
            if (shouldReloadForNavigation()) return;
            const relays = (relayCsv || "").split(",").map(s=>s.trim()).filter(Boolean);
            const id = nostrId.trim();
            if (!id) return;
            const defaultCols: ListColumn[] = [{ id: crypto.randomUUID(), name: "Items" }];
            const newBoard: Board = {
              id,
              name: name || "Shared Board",
              kind: "lists",
              columns: defaultCols,
              nostr: { boardId: id, relays: relays.length ? relays : defaultRelays },
              archived: false,
              hidden: false,
              clearCompletedDisabled: false,
              indexCardEnabled: false,
            };
            setBoards(prev => {
              const existingIndex = prev.findIndex((b) => b.id === id || b.nostr?.boardId === id);
              if (existingIndex >= 0) {
                const existing = prev[existingIndex];
                const columns = existing.kind === "lists" ? existing.columns : newBoard.columns;
                const indexCardEnabled = existing.kind === "lists"
                  ? (typeof existing.indexCardEnabled === "boolean" ? existing.indexCardEnabled : newBoard.indexCardEnabled)
                  : newBoard.indexCardEnabled;
                const merged: Board = {
                  ...newBoard,
                  id: existing.id,
                  name: name || existing.name || newBoard.name,
                  columns,
                  archived: false,
                  hidden: false,
                  clearCompletedDisabled: existing.clearCompletedDisabled ?? newBoard.clearCompletedDisabled,
                  indexCardEnabled,
                };
                const copy = prev.slice();
                copy[existingIndex] = merged;
                return copy;
              }
              return [...prev, newBoard];
            });
            changeBoard(id);
          }}
          onRegenerateBoardId={regenerateBoardId}
          onBoardChanged={handleBoardChanged}
          onClose={() => setShowSettingsState(false)}
        />
      )}

      {/* Cashu Wallet */}
      <Suspense fallback={null}>
        {showWallet && (
          <CashuWalletModal
            open={showWallet}
            onClose={() => setShowWalletState(false)}
            walletConversionEnabled={settings.walletConversionEnabled}
            walletPrimaryCurrency={settings.walletPrimaryCurrency}
            setWalletPrimaryCurrency={(currency) => setSettings({ walletPrimaryCurrency: currency })}
            npubCashLightningAddressEnabled={settings.npubCashLightningAddressEnabled}
            npubCashAutoClaim={settings.npubCashLightningAddressEnabled && settings.npubCashAutoClaim}
            sentTokenStateChecksEnabled={settings.walletSentStateChecksEnabled}
            paymentRequestsEnabled={settings.walletPaymentRequestsEnabled}
            paymentRequestsBackgroundChecksEnabled={
              settings.walletPaymentRequestsEnabled && settings.walletPaymentRequestsBackgroundChecksEnabled
            }
            tokenStateResetNonce={walletTokenStateResetNonce}
          />
        )}
      </Suspense>
    </div>
  );
}

function hiddenUntilForBoard(dueISO: string, boardKind: Board["kind"], weekStart: Weekday): string | undefined {
  const dueDate = startOfDay(new Date(dueISO));
  if (Number.isNaN(dueDate.getTime())) return undefined;
  const today = startOfDay(new Date());
  if (boardKind === "lists" || boardKind === "compound") {
    return dueDate.getTime() > today.getTime() ? dueDate.toISOString() : undefined;
  }
  const nowSow = startOfWeek(new Date(), weekStart);
  const dueSow = startOfWeek(dueDate, weekStart);
  return dueSow.getTime() > nowSow.getTime() ? dueSow.toISOString() : undefined;
}

function applyHiddenForFuture(task: Task, weekStart: Weekday, boardKind: Board["kind"]): void {
  task.hiddenUntilISO = hiddenUntilForBoard(task.dueISO, boardKind, weekStart);
}

function nextOrderForBoard(
  boardId: string,
  tasks: Task[],
  newTaskPosition: Settings["newTaskPosition"]
): number {
  const boardTasks = tasks.filter(task => task.boardId === boardId);
  if (newTaskPosition === "top") {
    const minOrder = boardTasks.reduce((min, task) => Math.min(min, task.order ?? 0), 0);
    return minOrder - 1;
  }
  return boardTasks.reduce((max, task) => Math.max(max, task.order ?? -1), -1) + 1;
}

async function syncRemindersToWorker(
  workerBaseUrl: string,
  push: PushPreferences,
  reminderTasks: Task[],
  options?: { signal?: AbortSignal }
): Promise<void> {
  if (!workerBaseUrl) throw new Error("Worker base URL is not configured");
  if (!push.deviceId || !push.subscriptionId) return;
  const remindersPayload = reminderTasks
    .map((task) => ({
      taskId: task.id,
      boardId: task.boardId,
      dueISO: task.dueISO,
      title: task.title,
      minutesBefore: (task.reminders ?? [])
        .map(reminderPresetToMinutes)
        .sort((a, b) => a - b),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  const res = await fetch(`${workerBaseUrl}/api/reminders`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: push.deviceId,
      subscriptionId: push.subscriptionId,
      reminders: remindersPayload,
    }),
    signal: options?.signal,
  });
  if (!res.ok) {
    throw new Error(`Failed to sync reminders (${res.status})`);
  }
}

/* ================= Subcomponents ================= */

function autolink(text: string) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/gi);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//i.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="link-accent break-words">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
      )
    )}
  </>
  );
}

const URL_IN_TEXT_GLOBAL = /https?:\/\/[^\s)]+/gi;

function stripUrlsFromText(text: string | undefined): string {
  if (!text) return "";
  return text.replace(URL_IN_TEXT_GLOBAL, "").trim();
}

function fallbackTitleFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./i, "");
    const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    const pathPart = segments.length ? ` / ${segments.join(" / ")}` : "";
    return (host || parsed.hostname || rawUrl) + pathPart;
  } catch {
    return rawUrl;
  }
}

function useTaskPreview(task: Task): UrlPreviewData | null {
  const previewSource = useMemo(() => `${task.title} ${task.note || ""}`, [task.title, task.note]);
  return useUrlPreview(previewSource);
}

function TaskTitle({ task }: { task: Task }) {
  const derivedPreview = useTaskPreview(task);
  const isTitleUrl = isUrlLike(task.title);
  const urlFromTitle = isTitleUrl ? task.title.trim() : null;
  const urlFromNote = extractFirstUrl(task.note || "");
  const canonicalUrl = derivedPreview?.finalUrl || derivedPreview?.url || urlFromTitle || urlFromNote;

  if (isTitleUrl) {
    const titleTarget = urlFromTitle || canonicalUrl || task.title.trim();
    const displayTitle = derivedPreview?.title || derivedPreview?.displayUrl || fallbackTitleFromUrl(titleTarget);
    if (canonicalUrl) {
      return <span className="link-accent">{displayTitle}</span>;
    }
    return <>{displayTitle}</>;
  }

  if (canonicalUrl) {
    return <span className="link-accent">{task.title}</span>;
  }

  return <>{task.title}</>;
}

function UrlPreviewCard({ preview }: { preview: UrlPreviewData; indent?: boolean }) {
  const [imageFailed, setImageFailed] = useState(false);
  const hasImage = Boolean(preview.image && !imageFailed);
  const hasIcon = Boolean(!hasImage && preview.icon);
  const siteLabel = preview.siteName || preview.displayUrl;
  const mediaClass = hasImage ? "h-40 w-full" : "flex min-h-[3.25rem] w-full items-center justify-center bg-surface";

  const textContent = (
    <>
      <div className="truncate font-medium text-primary">{preview.title || preview.displayUrl}</div>
      {preview.description && (
        <div
          className="text-tertiary overflow-hidden text-ellipsis"
          style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
        >
          {preview.description}
        </div>
      )}
      <div className="text-tertiary text-[10px] uppercase tracking-wide">{siteLabel}</div>
    </>
  );

  const card = (
    <a
      href={preview.finalUrl || preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block w-full max-w-full overflow-hidden rounded-2xl border border-surface bg-surface-muted"
    >
      {hasImage ? (
        <>
          <div className={mediaClass}>
            <img
              src={preview.image!}
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="space-y-1 p-3 text-xs text-secondary">{textContent}</div>
        </>
      ) : hasIcon ? (
        <div className="flex items-start gap-3 p-3 text-xs text-secondary">
          <img src={preview.icon!} className="h-10 w-10 flex-shrink-0 rounded-lg border border-surface object-contain bg-surface" />
          <div className="space-y-1 flex-1 min-w-0">{textContent}</div>
        </div>
      ) : (
        <div className="space-y-1 p-3 text-xs text-secondary">{textContent}</div>
      )}
    </a>
  );

  return card;
}

function TaskMedia({
  task,
  indent = false,
  onOpenDocument,
}: {
  task: Task;
  indent?: boolean;
  onOpenDocument?: (task: Task, doc: TaskDocument) => void;
}) {
  const noteText = useMemo(() => stripUrlsFromText(task.note), [task.note]);
  const hasImages = Boolean(task.images && task.images.length);
  const hasDocuments = Boolean(task.documents && task.documents.length);
  const derivedPreview = useTaskPreview(task);
  const hasPreview = Boolean(derivedPreview);

  if (!noteText && !hasImages && !hasDocuments && !hasPreview) return null;

  const wrapperClasses = "mt-2 space-y-1.5";
  const noteDetailClass = indent ? "task-card__details " : "";

  return (
    <div className={wrapperClasses}>
      {noteText && (
        <div
          className={`${noteDetailClass}text-xs text-secondary break-words`}
          style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
        >
          {autolink(noteText)}
        </div>
      )}
      {hasImages ? (
        <div className="space-y-2">
          {task.images!.map((img, i) => (
            <img key={i} src={img} className="max-h-40 w-full rounded-2xl object-contain" />
          ))}
        </div>
      ) : null}
      {hasDocuments ? (
        <div className="space-y-2">
          {task.documents!.map((doc) => (
            <DocumentThumbnail
              key={doc.id}
              document={doc}
              onClick={() => onOpenDocument?.(task, doc)}
            />
          ))}
        </div>
      ) : null}
      {derivedPreview && <UrlPreviewCard preview={derivedPreview} />}
    </div>
  );
}

function DocumentThumbnail({ document: doc, onClick }: { document: TaskDocument; onClick: () => void }) {
  const [derivedPreview, setDerivedPreview] = useState<TaskDocumentPreview | null>(doc.preview ?? null);

  useEffect(() => {
    let cancelled = false;
    if (doc.preview) {
      setDerivedPreview(doc.preview);
      return () => {
        cancelled = true;
      };
    }
    setDerivedPreview(null);
    loadDocumentPreview(doc).then((next) => {
      if (!cancelled) {
        setDerivedPreview(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const preview = derivedPreview ?? doc.preview ?? null;
  const label = doc.name || "Document";
  let previewNode: React.ReactNode;
  if (preview?.type === "image") {
    previewNode = <img src={preview.data} alt="" className="doc-thumb__image" />;
  } else if (preview?.type === "html") {
    previewNode = <div className="doc-thumb__html" dangerouslySetInnerHTML={{ __html: preview.data }} />;
  } else if (preview?.type === "text") {
    const snippet = preview.data.split(/\n+/).slice(0, 6).join("\n");
    previewNode = <pre className="doc-thumb__text">{snippet}</pre>;
  } else if (preview) {
    previewNode = <div className="doc-thumb__placeholder">Preview unavailable</div>;
  } else {
    return (
      <button type="button" className="doc-thumb doc-thumb--compact" onClick={onClick}>
        <span className="doc-thumb__name" title={label}>
          {label}
        </span>
        <span className="doc-thumb__kind">{doc.kind.toUpperCase()}</span>
      </button>
    );
  }

  return (
    <button type="button" className="doc-thumb" onClick={onClick}>
      <div className="doc-thumb__preview">
        {previewNode}
      </div>
      <div className="doc-thumb__footer">
        <span className="doc-thumb__name" title={label}>{label}</span>
        <span className="doc-thumb__kind">{doc.kind.toUpperCase()}</span>
      </div>
    </button>
  );
}

function DocumentPreviewModal({
  document,
  onClose,
  onDownloadDocument,
  onOpenExternal,
}: {
  document: TaskDocument;
  onClose: () => void;
  onDownloadDocument?: (doc: TaskDocument) => void;
  onOpenExternal?: (doc: TaskDocument) => void;
}) {
  const full = document.full;
  const label = document.name || "Document";

  let content: React.ReactNode;
  if (document.kind === "pdf") {
    content = (
      <div className="doc-modal__content">
        <div className="doc-modal__placeholder">
          <div>PDF previews open in a new tab for the best experience.</div>
          <button
            type="button"
            className="ghost-button button-sm pressable"
            style={{ marginTop: "0.75rem" }}
            onClick={() => onOpenExternal?.(document)}
          >
            Open full screen
          </button>
        </div>
      </div>
    );
  } else if (full?.type === "html") {
    content = (
      <div className="doc-modal__content">
        <div
          className="doc-modal__markup"
          dangerouslySetInnerHTML={{ __html: full.data }}
        />
      </div>
    );
  } else if (full?.type === "text") {
    content = (
      <div className="doc-modal__content">
        <pre className="doc-modal__text">{full.data}</pre>
      </div>
    );
  } else {
    content = (
      <div className="doc-modal__content">
        <div className="doc-modal__placeholder">
          Preview unavailable. Click download to open the original file.
        </div>
      </div>
    );
  }

  const actions = (
    <div className="doc-modal__action-buttons">
      <button
        type="button"
        className="ghost-button button-sm pressable"
        onClick={() => onDownloadDocument?.(document)}
      >
        Download
      </button>
    </div>
  );

  return (
    <Modal onClose={onClose} title={label} actions={actions}>
      {content}
    </Modal>
  );
}

// Column container (fixed width for consistent horizontal scroll)
const DroppableColumn = React.forwardRef<HTMLDivElement, {
  title: string;
  header?: React.ReactNode;
  onDropCard: (payload: { id: string; beforeId?: string }) => void;
  onDropEnd?: () => void;
  onTitleClick?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  scrollable?: boolean;
} & React.HTMLAttributes<HTMLDivElement>>((
  {
    title,
    header,
    onDropCard,
    onDropEnd,
    onTitleClick,
    children,
    footer,
    scrollable,
    className,
    ...props
  },
  forwardedRef
) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (!forwardedRef) return;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
  }, [forwardedRef]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const isTaskDrag = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      if (!types) return false;
      return Array.from(types).includes("text/task-id");
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const id = e.dataTransfer?.getData("text/task-id");
      if (id) {
        let beforeId: string | undefined;
        const columnEl = innerRef.current;
        if (columnEl) {
          const cards = Array.from(
            columnEl.querySelectorAll<HTMLElement>("[data-task-id]")
          );
          const pointerY = e.clientY;
          for (const card of cards) {
            const rect = card.getBoundingClientRect();
            if (pointerY < rect.top + rect.height / 2) {
              beforeId = card.dataset.taskId || undefined;
              break;
            }
          }
        }
        onDropCard({ id, beforeId });
      }
      if (onDropEnd) onDropEnd();
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    const onDragEnter = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current += 1;
      setIsDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isTaskDrag(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragOver(false);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragleave", onDragLeave);
    const resetDragState = () => {
      dragDepthRef.current = 0;
      setIsDragOver(false);
    };
    document.addEventListener("dragend", resetDragState);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("dragenter", onDragEnter);
      el.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("dragend", resetDragState);
    };
  }, [onDropCard, onDropEnd]);

  return (
    <div
      ref={setRef}
      data-column-title={title}
      data-drop-over={isDragOver || undefined}
      className={`board-column surface-panel w-[325px] shrink-0 p-2 ${scrollable ? 'flex h-[calc(100vh-15rem)] flex-col overflow-hidden' : 'min-h-[320px]'} ${isDragOver ? 'board-column--active' : ''} ${className ?? ''}`}
      // No touchAction lock so horizontal scrolling stays fluid
      {...props}
    >
      {header ?? (
        <div
          className={`mb-3 text-sm font-semibold tracking-wide text-secondary ${onTitleClick ? 'cursor-pointer hover:text-primary transition-colors' : ''}`}
          onClick={onTitleClick}
          role={onTitleClick ? 'button' : undefined}
          tabIndex={onTitleClick ? 0 : undefined}
          onKeyDown={(e) => {
            if (!onTitleClick) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onTitleClick();
            }
          }}
          title={onTitleClick ? 'Set as add target' : undefined}
        >
          {title}
        </div>
      )}
      <div className={scrollable ? 'flex-1 min-h-0 overflow-y-auto pr-1' : ''}>
        <div className="space-y-.25">{children}</div>
      </div>
      {scrollable && footer ? <div className="mt-auto flex-shrink-0 pt-2">{footer}</div> : null}
      {!scrollable && footer}
    </div>
  );
});

function Card({
  task,
  onComplete,
  onEdit,
  onDropBefore,
  showStreaks,
  onToggleSubtask,
  onFlyToCompleted,
  onDragStart,
  onDragEnd,
  hideCompletedSubtasks,
  onOpenDocument,
}: {
  task: Task;
  onComplete: (from?: DOMRect) => void;
  onEdit: () => void;
  onDropBefore: (dragId: string) => void;
  showStreaks: boolean;
  onToggleSubtask: (subId: string) => void;
  onFlyToCompleted: (rect: DOMRect) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  hideCompletedSubtasks: boolean;
  onOpenDocument: (task: Task, doc: TaskDocument) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const [overBefore, setOverBefore] = useState(false);
  const [isStacked, setIsStacked] = useState(false);
  const iconSizeStyle = useMemo(() => ({ '--icon-size': '1.85rem' } as React.CSSProperties), []);
  const visibleSubtasks = useMemo(() => (
    hideCompletedSubtasks
      ? (task.subtasks?.filter((st) => !st.completed) ?? [])
      : (task.subtasks ?? [])
  ), [hideCompletedSubtasks, task.subtasks]);
  const preview = useTaskPreview(task);
  const hasDetail =
    !!task.note?.trim() ||
    (task.images && task.images.length > 0) ||
    (task.documents && task.documents.length > 0) ||
    (visibleSubtasks.length > 0) ||
    !!task.bounty ||
    Boolean(preview);

  useEffect(() => {
    const el = titleRef.current;
    if (!el) return;

    let raf = 0;
    const compute = () => {
      const styles = window.getComputedStyle(el);
      const lineHeight = parseFloat(styles.lineHeight || '0');
      if (!lineHeight) {
        setIsStacked(false);
        return;
      }
      const lines = Math.round(el.scrollHeight / lineHeight);
      setIsStacked(lines > 1);
    };

    compute();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(compute);
      });
      observer.observe(el);
    }

    window.addEventListener('resize', compute);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', compute);
      cancelAnimationFrame(raf);
    };
  }, [task.title, task.note, task.images?.length, task.documents?.length, visibleSubtasks.length]);

  function handleDragStart(e: React.DragEvent) {
    e.dataTransfer.setData('text/task-id', task.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setDragImage(e.currentTarget as HTMLElement, 0, 0);
    onDragStart(task.id);
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    setOverBefore(e.clientY < midpoint);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const dragId = e.dataTransfer.getData('text/task-id');
    if (dragId && dragId !== task.id) onDropBefore(dragId);
    setOverBefore(false);
    onDragEnd();
  }
  function handleDragLeave() {
    setOverBefore(false);
  }
  function handleDragEnd() {
    onDragEnd();
  }

  function handleCompleteClick(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    if (!task.completed) {
      try { onFlyToCompleted(rect); } catch {}
    }
    onComplete(rect);
  }

  const bountyClass = task.bounty
    ? task.bounty.state === 'unlocked'
      ? 'chip chip-accent'
      : task.bounty.state === 'revoked'
        ? 'chip chip-danger'
        : task.bounty.state === 'claimed'
          ? 'chip chip-warn'
          : 'chip'
    : '';
  const bountyLabel = task.bounty ? bountyStateLabel(task.bounty) : "";

  const stackedForm = isStacked || hasDetail;

  return (
    <div
      ref={cardRef}
      className="task-card group relative select-none"
      data-task-id={task.id}
      data-state={task.completed ? 'completed' : undefined}
      data-form={stackedForm ? 'stacked' : 'pill'}
      style={{ touchAction: 'auto' }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {overBefore && (
        <div
          className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full"
          style={{ background: 'var(--accent)' }}
        />
      )}

      <div className="flex items-start gap-3">
        <button
          onClick={handleCompleteClick}
          aria-label={task.completed ? 'Mark incomplete' : 'Complete task'}
          title={task.completed ? 'Mark incomplete' : 'Mark complete'}
          className="icon-button pressable flex-shrink-0"
          style={iconSizeStyle}
          data-active={task.completed}
        >
          {task.completed && (
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
          )}
        </button>

        <div className="flex-1 min-w-0 cursor-pointer space-y-1" onClick={onEdit}>
          <div
            ref={titleRef}
            className={`task-card__title ${task.completed ? 'task-card__title--done' : ''}`}
          >
            <TaskTitle task={task} />
          </div>
          {showStreaks &&
            task.recurrence &&
            (task.recurrence.type === 'daily' || task.recurrence.type === 'weekly') &&
            typeof task.streak === 'number' && task.streak > 0 && (
              <div className="flex items-center gap-1 text-xs text-secondary">
                <span role="img" aria-hidden>
                  🔥
                </span>
                <span>{task.streak}</span>
              </div>
            )}
          {task.dueTimeEnabled && (
            <div className="text-xs text-secondary">
              Due at {formatTimeLabel(task.dueISO)}
            </div>
          )}
        </div>
      </div>

      <TaskMedia task={task} indent onOpenDocument={onOpenDocument} />

      {visibleSubtasks.length ? (
        <ul className="task-card__details mt-2 space-y-1.5 text-xs text-secondary">
          {visibleSubtasks.map((st) => (
            <li key={st.id} className="subtask-row">
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => onToggleSubtask(st.id)}
                className="subtask-row__checkbox"
              />
              <span className={`subtask-row__text ${st.completed ? 'line-through text-tertiary' : 'text-secondary'}`}>{st.title}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {task.completed && task.bounty && task.bounty.state !== 'claimed' && (
        <div className="task-card__details mt-2 text-xs text-secondary">
          {task.bounty.state === 'unlocked' ? 'Bounty unlocked!' : 'Complete! - Unlock bounty'}
        </div>
      )}

      {task.bounty && (
        <div className="task-card__details mt-2">
          <span className={bountyClass}>
            Bounty {typeof task.bounty.amount === 'number' ? `• ${task.bounty.amount} sats` : ''} • {bountyLabel}
          </span>
        </div>
      )}
    </div>
  );
}

/* Small circular icon button */
function IconButton({
  children, onClick, label, intent, buttonRef
}: React.PropsWithChildren<{ onClick: ()=>void; label: string; intent?: "danger"|"success"; buttonRef?: React.Ref<HTMLButtonElement> }>) {
  const cls = `icon-button pressable ${intent === 'danger' ? 'icon-button--danger' : intent === 'success' ? 'icon-button--success' : ''}`;
  const style = { '--icon-size': '2.35rem' } as React.CSSProperties;
  return (
    <button
      ref={buttonRef}
      aria-label={label}
      title={label}
      className={cls}
      style={style}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ---------- Recurrence helpers & UI ---------- */
function labelOf(r: Recurrence): string {
  switch (r.type) {
    case "none": return "None";
    case "daily": return "Daily";
    case "weekly": return `Weekly on ${r.days.map((d) => WD_SHORT[d]).join(", ") || "(none)"}`;
    case "every": return `Every ${r.n} ${r.unit === "day" ? "day(s)" : "week(s)"}`;
    case "monthlyDay": return `Monthly on day ${r.day}`;
  }
}

/* Edit modal with Advanced recurrence */
function EditModal({ task, onCancel, onDelete, onSave, weekStart, boardKind, onRedeemCoins, onRevealBounty, onTransferBounty, onPreviewDocument }: {
  task: Task;
  onCancel: ()=>void;
  onDelete: ()=>void;
  onSave: (t: Task)=>void;
  weekStart: Weekday;
  boardKind: Board["kind"];
  onRedeemCoins?: (from: DOMRect)=>void;
  onRevealBounty?: (taskId: string)=>Promise<void>;
  onTransferBounty?: (taskId: string, recipientHex: string)=>Promise<void>;
  onPreviewDocument?: (task: Task, doc: TaskDocument) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [note, setNote] = useState(task.note || "");
  const [images, setImages] = useState<string[]>(task.images || []);
  const [documents, setDocuments] = useState<TaskDocument[]>(task.documents || []);
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks || []);
  const [newSubtask, setNewSubtask] = useState("");
  const newSubtaskRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const dragSubtaskIdRef = useRef<string | null>(null);
  const [rule, setRule] = useState<Recurrence>(task.recurrence ?? R_NONE);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const initialDate = isoDatePart(task.dueISO);
  const initialTime = isoTimePart(task.dueISO);
  const defaultHasTime = task.dueTimeEnabled ?? false;
  const [scheduledDate, setScheduledDate] = useState(initialDate);
  const [scheduledTime, setScheduledTime] = useState<string>(defaultHasTime ? initialTime : '');
  const hasDueTime = scheduledTime.trim().length > 0;
  const [reminderSelection, setReminderSelection] = useState<ReminderPreset[]>(task.reminders ?? []);
  const [bountyAmount, setBountyAmount] = useState<number | "">(task.bounty?.amount ?? "");
  const [, setBountyState] = useState<Task["bounty"]["state"]>(task.bounty?.state || "locked");
  const [encryptWhenAttach, setEncryptWhenAttach] = useState(true);
  const { createSendToken, receiveToken, mintUrl } = useCashu();
  const [lockToRecipient, setLockToRecipient] = useState(false);
  const [recipientInput, setRecipientInput] = useState("");
  const [signRecipientInput, setSignRecipientInput] = useState("");
  const [signingBounty, setSigningBounty] = useState(false);
  const { show: showToast } = useToast();
  const streakEligible = rule.type === "daily" || rule.type === "weekly";
  const currentStreak = typeof task.streak === "number" ? task.streak : 0;
  const bestStreak = Math.max(
    currentStreak,
    typeof task.longestStreak === "number" ? task.longestStreak : currentStreak,
  );

  const reminderOptions = useMemo(() => buildReminderOptions(reminderSelection), [reminderSelection]);

  const reminderPresetMap = useMemo(() => {
    const map = new Map<ReminderPreset, ReminderOption>();
    for (const opt of reminderOptions) map.set(opt.id, opt);
    return map;
  }, [reminderOptions]);

  const reminderSummary = useMemo(() => {
    if (!reminderSelection.length) return "";
    return reminderSelection
      .map((id) => {
        const preset = reminderPresetMap.get(id);
        if (preset) return preset.badge;
        const minutes = reminderPresetToMinutes(id);
        if (!minutes) return String(id);
        return formatReminderLabel(minutes).badge;
      })
      .join(', ');
  }, [reminderPresetMap, reminderSelection]);

  useEffect(() => {
    if (!hasDueTime && reminderSelection.length) {
      setReminderSelection([]);
    }
  }, [hasDueTime, reminderSelection]);

  useEffect(() => {
    setSignRecipientInput("");
    setSigningBounty(false);
  }, [task.id]);

  const me = (window as any).nostrPK as string | undefined;

  function compressedToRawHex(value: string): string {
    if (typeof value !== "string") return value;
    if (/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return value.slice(-64);
    return value;
  }

  function toNpubKey(value: string): string {
    const raw = compressedToRawHex(value);
    try {
      if (typeof (nip19 as any)?.npubEncode === "function") {
        return (nip19 as any).npubEncode(raw);
      }
      return raw;
    } catch {
      return raw;
    }
  }

  function shortenPubkey(value: string): string {
    if (value.length <= 18) return value;
    return `${value.slice(0, 10)}…${value.slice(-6)}`;
  }

  const normalizedCompletedBy = useMemo(
    () => normalizeNostrPubkey(task.completedBy || ""),
    [task.completedBy],
  );

  const normalizedCompletedByRaw = useMemo(
    () => ensureXOnlyHex(normalizedCompletedBy) || null,
    [normalizedCompletedBy],
  );

  const completedNpub = useMemo(
    () => (normalizedCompletedBy ? toNpubKey(normalizedCompletedBy) : null),
    [normalizedCompletedBy],
  );

  const completedDisplay = useMemo(
    () => (completedNpub ? shortenPubkey(completedNpub) : null),
    [completedNpub],
  );

  const currentReceiverDisplay = useMemo(() => {
    const receiver = task.bounty?.receiver;
    if (!receiver) return null;
    return shortenPubkey(toNpubKey(receiver));
  }, [task.bounty?.receiver]);

  const canTransferBounty = useMemo(() => {
    const bounty = task.bounty;
    if (!bounty || !me) return false;
    if (bounty.state === "revoked" || bounty.state === "claimed") return false;
    return (
      (!!bounty.sender && pubkeysEqual(bounty.sender, me)) ||
      (!!bounty.owner && pubkeysEqual(bounty.owner, me)) ||
      pubkeysEqual(task.createdBy, me)
    );
  }, [me, task.bounty, task.createdBy]);

  const canSignToCompleter = useMemo(() => {
    if (!normalizedCompletedByRaw) return false;
    const receiver = task.bounty?.receiver;
    if (!receiver) return true;
    return !pubkeysEqual(receiver, normalizedCompletedByRaw);
  }, [normalizedCompletedByRaw, task.bounty?.receiver]);

  const hasTransferableBounty = !!(task.bounty && (task.bounty.token || task.bounty.enc));
  const showSignOver = Boolean(
    onTransferBounty &&
    task.completed &&
    canTransferBounty &&
    hasTransferableBounty,
  );

  const manualSignDisabled = signingBounty || !signRecipientInput.trim();

  async function handleSignOver(recipientHex: string, displayHint?: string) {
    if (!onTransferBounty || signingBounty) return;
    setSigningBounty(true);
    try {
      await onTransferBounty(task.id, recipientHex);
      setBountyState("locked");
      setSignRecipientInput("");
      const label = displayHint || shortenPubkey(toNpubKey(recipientHex));
      if (label) {
        showToast(`Bounty locked to ${label}`, 2500);
      } else {
        showToast("Bounty locked to recipient", 2500);
      }
    } catch (error) {
      const message = (error as Error)?.message || String(error) || "Unknown error";
      alert(`Unable to sign bounty: ${message}`);
    } finally {
      setSigningBounty(false);
    }
  }

  async function handleSignToCompleter() {
    if (!normalizedCompletedBy) return;
    await handleSignOver(normalizedCompletedBy, completedDisplay || undefined);
  }

  async function handleManualSign() {
    if (!onTransferBounty) return;
    const trimmed = signRecipientInput.trim();
    if (!trimmed) {
      alert("Enter a recipient npub or hex.");
      return;
    }
    const normalized = normalizeNostrPubkey(trimmed);
    if (!normalized) {
      alert("Enter a valid recipient npub or hex.");
      return;
    }
    if (task.bounty?.receiver && pubkeysEqual(task.bounty.receiver, normalized)) {
      alert("Bounty is already locked to that recipient.");
      return;
    }
    await handleSignOver(normalized);
  }


  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs = Array.from(items).filter(it => it.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      const datas: string[] = [];
      for (const it of imgs) {
        const file = it.getAsFile();
        if (file) datas.push(await fileToDataURL(file));
      }
      setImages(prev => [...prev, ...datas]);
    }
  }

  async function handleDocumentAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || !files.length) return;
    try {
      const docs = await readDocumentsFromFiles(files);
      setDocuments((prev) => [...prev, ...docs]);
    } catch (err) {
      console.error("Failed to attach document", err);
      alert("Failed to attach document. Please use PDF, DOC/DOCX, or XLS/XLSX files.");
    } finally {
      e.target.value = "";
    }
  }

  function addSubtask(keepKeyboard = false) {
    const title = newSubtask.trim();
    if (!title) return;
    setSubtasks(prev => [...prev, { id: crypto.randomUUID(), title, completed: false }]);
    setNewSubtask("");
    if (keepKeyboard) newSubtaskRef.current?.focus();
    else newSubtaskRef.current?.blur();
  }

  const reorderSubtasks = useCallback((sourceId: string, targetId: string | null, position: 'before' | 'after' = 'before') => {
    if (!sourceId || sourceId === targetId) return;
    setSubtasks(prev => {
      const sourceIndex = prev.findIndex(s => s.id === sourceId);
      if (sourceIndex === -1) return prev;
      const sourceItem = prev[sourceIndex];
      const remaining = prev.filter(s => s.id !== sourceId);
      if (!targetId) {
        return [...remaining, sourceItem];
      }
      const rawTargetIndex = prev.findIndex(s => s.id === targetId);
      if (rawTargetIndex === -1) return prev;
      let insertIndex = rawTargetIndex;
      if (sourceIndex < rawTargetIndex) insertIndex -= 1;
      if (position === 'after') insertIndex += 1;
      if (insertIndex < 0) insertIndex = 0;
      if (insertIndex > remaining.length) insertIndex = remaining.length;
      const next = [...remaining];
      next.splice(insertIndex, 0, sourceItem);
      return next;
    });
  }, [setSubtasks]);

  const handleSubtaskDragStart = useCallback((id: string) => (e: React.DragEvent<HTMLElement>) => {
    dragSubtaskIdRef.current = id;
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/subtask-id', id);
    } catch {}
  }, []);

  const handleSubtaskDragEnd = useCallback(() => {
    dragSubtaskIdRef.current = null;
  }, []);

  const handleSubtaskDragOver = useCallback((id: string | null) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSubtaskIdRef.current) return;
    void id;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleSubtaskDrop = useCallback((id: string | null) => (e: React.DragEvent<HTMLDivElement>) => {
    const sourceHint = dragSubtaskIdRef.current || e.dataTransfer.getData('text/subtask-id');
    if (!sourceHint) return;
    e.preventDefault();
    e.stopPropagation();
    dragSubtaskIdRef.current = null;
    let position: 'before' | 'after' = 'before';
    if (id) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) position = 'after';
    } else {
      position = 'after';
    }
    reorderSubtasks(sourceHint, id, position);
  }, [reorderSubtasks]);

  function toggleReminder(id: ReminderPreset) {
    setReminderSelection((prev) => {
      const exists = prev.includes(id);
      const next = exists ? prev.filter((item) => item !== id) : [...prev, id];
      return [...next].sort((a, b) => reminderPresetToMinutes(a) - reminderPresetToMinutes(b));
    });
  }

  const handleAddCustomReminder = useCallback(() => {
    if (!hasDueTime) return;
    const response = window.prompt('Remind me how many minutes before the due time?', '30');
    if (response == null) return;
    const trimmed = response.trim();
    if (!trimmed) return;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) {
      alert('Enter a valid number of minutes (whole number).');
      return;
    }
    if (parsed < MIN_CUSTOM_REMINDER_MINUTES || parsed > MAX_CUSTOM_REMINDER_MINUTES) {
      alert(`Pick a value between ${MIN_CUSTOM_REMINDER_MINUTES} and ${MAX_CUSTOM_REMINDER_MINUTES} minutes (up to one week).`);
      return;
    }
    const normalized = clampCustomReminderMinutes(parsed);
    const id = minutesToReminderId(normalized);
    setReminderSelection((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      return next.sort((a, b) => reminderPresetToMinutes(a) - reminderPresetToMinutes(b));
    });
  }, [hasDueTime]);

  function buildTask(overrides: Partial<Task> = {}): Task {
    const baseDate = scheduledDate || isoDatePart(task.dueISO);
    const hasTime = hasDueTime;
    const dueISO = isoFromDateTime(baseDate, hasTime ? scheduledTime : undefined);
    const hiddenUntilISO = hiddenUntilForBoard(dueISO, boardKind, weekStart);
    const reminderValues = hasTime ? [...reminderSelection] : [];
    return {
      ...task,
      title,
      note: note || undefined,
      images: images.length ? images : undefined,
      documents: documents.length ? documents : undefined,
      subtasks: subtasks.length ? subtasks : undefined,
      recurrence: rule.type === "none" ? undefined : rule,
      dueISO,
      hiddenUntilISO,
      dueTimeEnabled: hasTime ? true : undefined,
      reminders: reminderValues,
      ...overrides,
    };
  }

  function save(overrides: Partial<Task> = {}) {
    onSave(normalizeTaskBounty(buildTask(overrides)));
  }

  async function copyCurrent() {
    const base = buildTask();
    try { await navigator.clipboard?.writeText(JSON.stringify(base)); } catch {}
  }

  return (
    <Modal
      onClose={onCancel}
      title="Edit task"
      actions={
        <button
          className="accent-button button-sm pressable"
          onClick={() => save()}
        >
          Save
        </button>
      }
    >
      <div className="space-y-4">
        <input value={title} onChange={e=>setTitle(e.target.value)}
               className="pill-input w-full" placeholder="Title"/>
        <textarea value={note} onChange={e=>setNote(e.target.value)} onPaste={handlePaste}
                  className="pill-textarea w-full" rows={3}
                  placeholder="Notes (optional)"/>
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {images.map((img, i) => (
              <div key={i} className="relative">
                <img src={img} className="max-h-40 rounded-lg" />
                <button type="button" className="absolute top-1 right-1 bg-black/70 rounded-full px-1 text-xs" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium">Attachments</label>
            <input
              ref={documentInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              multiple
              onChange={handleDocumentAttach}
            />
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => documentInputRef.current?.click()}
            >
              Add document
            </button>
          </div>
          {documents.length > 0 && (
            <ul className="space-y-1">
              {documents.map((doc) => (
                <li key={doc.id} className="doc-edit-row">
                  <div className="doc-edit-row__info">
                    <div className="doc-edit-row__name" title={doc.name}>{doc.name}</div>
                    <div className="doc-edit-row__meta">{doc.kind.toUpperCase()}</div>
                  </div>
                  <div className="doc-edit-row__actions">
                    <button
                      type="button"
                      className="ghost-button button-sm pressable"
                      onClick={() => onPreviewDocument?.(task, doc)}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className="ghost-button button-sm pressable text-rose-500"
                      onClick={() => setDocuments((prev) => prev.filter((item) => item.id !== doc.id))}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          onDragOver={handleSubtaskDragOver(null)}
          onDrop={handleSubtaskDrop(null)}
        >
          <div className="flex items-center mb-2">
            <label className="text-sm font-medium">Subtasks</label>
          </div>
          {subtasks.map((st) => (
            <div
              key={st.id}
              className="flex items-center gap-2 mb-1 cursor-grab active:cursor-grabbing"
              style={{ touchAction: 'auto' }}
              draggable
              onDragStart={handleSubtaskDragStart(st.id)}
              onDragEnd={handleSubtaskDragEnd}
              onDragOver={handleSubtaskDragOver(st.id)}
              onDrop={handleSubtaskDrop(st.id)}
            >
              <input
                type="checkbox"
                checked={!!st.completed}
                onChange={() => setSubtasks(prev => prev.map(s => s.id === st.id ? { ...s, completed: !s.completed } : s))}
               
              />
              <input
                className="pill-input flex-1 text-sm"
                value={st.title}
                onChange={(e) => setSubtasks(prev => prev.map(s => s.id === st.id ? { ...s, title: e.target.value } : s))}
                placeholder="Subtask"
              />
              <button
                type="button"
                className="text-sm text-rose-500"
                onClick={() => setSubtasks(prev => prev.filter(s => s.id !== st.id))}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 mt-2">
            <input
              ref={newSubtaskRef}
              value={newSubtask}
              onChange={e=>setNewSubtask(e.target.value)}
              onKeyDown={e=>{ if (e.key === "Enter") { e.preventDefault(); addSubtask(true); } }}
              placeholder="New subtask…"
              className="pill-input flex-1 text-sm"
            />
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => addSubtask()}
            >
              Add
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="edit-schedule" className="block mb-1 text-sm font-medium">Scheduled for</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="edit-schedule"
              type="date"
              value={scheduledDate}
              onChange={e=>setScheduledDate(e.target.value)}
              className="pill-input flex-1 min-w-[10rem] sm:max-w-[13rem]"
              title="Scheduled date"
            />
            <input
              type="time"
              value={scheduledTime}
              onChange={(e) => setScheduledTime(e.target.value)}
              className="pill-input flex-none min-w-[8rem] sm:min-w-[8.5rem]"
              title="Scheduled time"
            />
          </div>
          <div className="mt-1 text-xs text-secondary">Leave the time blank if the task has no due time.</div>
        </div>

        <div className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Notifications</div>
            {reminderSelection.length > 0 && (
              <div className="ml-auto text-xs text-secondary">
                {reminderSummary}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {reminderOptions.map((opt) => {
              const active = reminderSelection.includes(opt.id);
              const cls = active ? 'accent-button button-sm pressable' : 'ghost-button button-sm pressable';
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={cls}
                  onClick={() => toggleReminder(opt.id)}
                  disabled={!hasDueTime}
                  title={opt.label}
                >
                  {opt.badge}
                </button>
              );
            })}
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={handleAddCustomReminder}
              disabled={!hasDueTime}
              title="Add a custom reminder"
            >
              Custom…
            </button>
          </div>
          {!hasDueTime && (
            <div className="text-xs text-secondary">Set a due time to enable reminders.</div>
          )}
        </div>

        {/* Recurrence section */}
        <div className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Recurrence</div>
            <div className="ml-auto text-xs text-secondary">{labelOf(rule)}</div>
          </div>
          <div className="mt-2 flex gap-2 flex-wrap">
            <button className="ghost-button button-sm pressable" onClick={() => setRule(R_NONE)}>None</button>
            <button className="ghost-button button-sm pressable" onClick={() => setRule({ type: "daily" })}>Daily</button>
            <button className="ghost-button button-sm pressable" onClick={() => setRule({ type: "weekly", days: [1,2,3,4,5] })}>Mon–Fri</button>
            <button className="ghost-button button-sm pressable" onClick={() => setRule({ type: "weekly", days: [0,6] })}>Weekends</button>
            <button className="ghost-button button-sm pressable ml-auto" onClick={() => setShowAdvanced(true)} title="Advanced recurrence…">Advanced…</button>
          </div>
        </div>

        {streakEligible && (
          <div className="wallet-section space-y-2">
            <div className="text-sm font-medium">Streaks</div>
            <div className="text-xs text-secondary">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  Current streak: <span className="font-semibold text-primary">{currentStreak}</span>
                </span>
                <span>
                  Longest streak: <span className="font-semibold text-primary">{bestStreak}</span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Bounty (ecash) */}
        <div className="wallet-section space-y-3">
          <div className="flex items-center gap-2">
            <div className="text-sm font-medium">Bounty (ecash)</div>
            {task.bounty && (
              <div className="ml-auto flex items-center gap-2 text-[0.6875rem]">
                <span className={`px-2 py-0.5 rounded-full border ${task.bounty.state==='unlocked' ? 'bg-emerald-700/30 border-emerald-700' : task.bounty.state==='locked' ? 'bg-neutral-700/40 border-neutral-600' : task.bounty.state==='revoked' ? 'bg-rose-700/30 border-rose-700' : 'bg-surface-muted border-surface'}`}>{bountyStateLabel(task.bounty)}</span>
                {task.createdBy && pubkeysEqual(task.createdBy, (window as any).nostrPK) && <span className="px-2 py-0.5 rounded-full bg-surface-muted border border-surface" title="You created the task">owner: you</span>}
                {task.bounty.sender && pubkeysEqual(task.bounty.sender, (window as any).nostrPK) && <span className="px-2 py-0.5 rounded-full bg-surface-muted border border-surface" title="You funded the bounty">funder: you</span>}
                {task.bounty.receiver && pubkeysEqual(task.bounty.receiver, (window as any).nostrPK) && <span className="px-2 py-0.5 rounded-full bg-surface-muted border border-surface" title="You are the recipient">recipient: you</span>}
              </div>
            )}
          </div>
          {!task.bounty ? (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2">
                <input type="number" min={1} value={bountyAmount as number || ""}
                       onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                       placeholder="Amount (sats)"
                       className="pill-input w-40"/>
                <button className="accent-button button-sm pressable"
                        onClick={async () => {
                          if (typeof bountyAmount !== 'number' || bountyAmount <= 0) return;
                          const recipientHex = lockToRecipient
                            ? normalizeNostrPubkey(recipientInput) || normalizeNostrPubkey(task.createdBy || "")
                            : null;
                          if (lockToRecipient && !recipientHex) {
                            alert("Enter a valid recipient npub/hex or ensure the task has an owner.");
                            return;
                          }
                          try {
                            const { token: tok, lockInfo } = await createSendToken(
                              bountyAmount,
                              recipientHex ? { p2pk: { pubkey: recipientHex } } : undefined,
                            );
                            const lockType: Task["bounty"]["lock"] = lockInfo?.type === "p2pk"
                              ? "p2pk"
                              : encryptWhenAttach
                                ? "unknown"
                                : "none";
                            const b: Task["bounty"] = {
                              id: crypto.randomUUID(),
                              token: lockToRecipient || encryptWhenAttach ? "" : tok,
                              amount: bountyAmount,
                              mint: mintUrl,
                              state: lockToRecipient || encryptWhenAttach ? "locked" : "unlocked",
                              owner: task.createdBy || (window as any).nostrPK || "",
                              sender: (window as any).nostrPK || "",
                              receiver: recipientHex || undefined,
                              updatedAt: new Date().toISOString(),
                              lock: lockType,
                            };
                            if (lockToRecipient && recipientHex) {
                              try {
                                const enc = await encryptEcashTokenForRecipient(recipientHex, tok);
                                b.enc = enc;
                                b.token = "";
                                b.lock = "p2pk";
                              } catch (e) {
                                alert("Recipient encryption failed: " + (e as Error).message);
                                return;
                              }
                            } else if (encryptWhenAttach) {
                              try {
                                const enc = await encryptEcashTokenForFunder(tok);
                                b.enc = enc;
                                b.token = "";
                              } catch (e) {
                                alert("Encryption failed: "+ (e as Error).message);
                                return;
                              }
                            }
                            appendWalletHistoryEntry({
                              id: `bounty-${Date.now()}`,
                              summary: `Attached bounty • ${bountyAmount} sats`,
                              detail: tok,
                              detailKind: "token",
                              type: "ecash",
                              direction: "out",
                              amountSat: bountyAmount,
                              mintUrl: mintUrl || undefined,
                            });
                            const normalized = normalizeBounty(b);
                            if (!normalized) return;
                            save({ bounty: normalized });
                          } catch (e) {
                            alert("Failed to create token: "+ (e as Error).message);
                          }
                        }}
                >Attach</button>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs text-secondary">
                  <input
                    type="checkbox"
                    checked={encryptWhenAttach && !lockToRecipient}
                    onChange={(e)=> setEncryptWhenAttach(e.target.checked)}
                    disabled={lockToRecipient}
                  />
                  Hide/encrypt token until I reveal (uses your local key)
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-secondary">
                    <input
                      type="checkbox"
                      checked={lockToRecipient}
                      onChange={(e)=>{ setLockToRecipient(e.target.checked); if (e.target.checked) setEncryptWhenAttach(false); }}
                    />
                    Lock to recipient (Nostr npub/hex)
                  </label>
                  {task.createdBy && (
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={()=>{ setRecipientInput(task.createdBy!); setLockToRecipient(true); setEncryptWhenAttach(false);} }
                      title="Use task owner"
                    >Use owner</button>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="npub1... or 64-hex pubkey"
                  value={recipientInput}
                  onChange={(e)=> setRecipientInput(e.target.value)}
                  className="pill-input w-full text-xs"
                  disabled={!lockToRecipient}
                />
              </div>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="text-xs text-secondary">Amount</div>
              <input type="number" min={1} value={(bountyAmount as number) || task.bounty?.amount || ""}
                     onChange={(e)=>setBountyAmount(e.target.value ? parseInt(e.target.value,10) : "")}
                     className="pill-input w-40"/>
              <div className="text-xs text-secondary">Token</div>
              {task.bounty.enc && !task.bounty.token ? (
                <div className="bg-surface-muted border border-surface rounded-2xl p-3 text-xs text-secondary">
                  {((task.bounty.enc as any).alg === 'aes-gcm-256')
                    ? 'Hidden (encrypted by funder). Only the funder can reveal.'
                    : 'Locked to recipient\'s Nostr key (nip04). Only the recipient can decrypt.'}
                </div>
              ) : (
                <textarea readOnly value={task.bounty.token || ""}
                          className="pill-textarea w-full" rows={3}/>
              )}
              <div className="flex gap-2 flex-wrap">
                {task.bounty.token && (
                  task.bounty.state === 'unlocked' ? (
                        <button
                          className="accent-button button-sm pressable"
                          onClick={async (e) => {
                            const fromRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                            try {
                              const bountyToken = task.bounty!.token!;
                              const res = await receiveToken(bountyToken);
                              if (res.savedForLater) {
                                alert('Token saved for later redemption. We\'ll redeem it when your connection returns.');
                                return;
                              }
                              if (res.crossMint) {
                            alert(`Redeemed to a different mint: ${res.usedMintUrl}. Switch to that mint to view the balance.`);
                          }
                          const amt = res.proofs.reduce((a, p) => a + (p?.amount || 0), 0);
                              appendWalletHistoryEntry({
                                id: `redeem-bounty-${Date.now()}`,
                                summary: `Redeemed bounty • ${amt} sats${res.crossMint ? ` at ${res.usedMintUrl}` : ''}`,
                                detail: bountyToken,
                                detailKind: "token",
                                type: "ecash",
                                direction: "in",
                                amountSat: amt,
                                mintUrl: res.usedMintUrl ?? mintUrl ?? undefined,
                              });
                          // Coins fly from the button to the selector target
                          try { onRedeemCoins?.(fromRect); } catch {}
                          setBountyState('claimed');
                          const claimed = normalizeBounty({ ...task.bounty!, token: '', state: 'claimed', updatedAt: new Date().toISOString() });
                          if (claimed) save({ bounty: claimed });
                        } catch (e) {
                          alert('Redeem failed: ' + (e as Error).message);
                        }
                      }}
                    >
                      Redeem
                    </button>
                  ) : (
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={async () => { try { await navigator.clipboard?.writeText(task.bounty!.token!); } catch {} }}
                    >
                      Copy token
                    </button>
                  )
                )}
                {task.bounty.enc && !task.bounty.token && (window as any).nostrPK && (
                  ((task.bounty.enc as any).alg === 'aes-gcm-256' && pubkeysEqual(task.bounty.sender, (window as any).nostrPK)) ||
                  ((task.bounty.enc as any).alg === 'nip04' && pubkeysEqual(task.bounty.receiver, (window as any).nostrPK))
                ) && (
                  <button className="accent-button button-sm pressable"
                          onClick={async () => {
                            try {
                              if (onRevealBounty) await onRevealBounty(task.id);
                            } catch {}
                          }}>Reveal (decrypt)</button>
                )}
                <button
                  className={`ghost-button button-sm pressable ${task.bounty.token ? '' : 'opacity-50 cursor-not-allowed'}`}
                  disabled={!task.bounty.token}
                  onClick={() => {
                    if (!task.bounty.token) return;
                    setBountyState('claimed');
                    const claimed = normalizeBounty({ ...task.bounty!, state: 'claimed', updatedAt: new Date().toISOString() });
                    if (claimed) save({ bounty: claimed });
                  }}
                >
                  Mark claimed
                </button>
                {showSignOver && (
                  <div className="basis-full rounded-xl border border-surface bg-surface-muted/60 px-3 py-3 text-[0.75rem] text-secondary space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-primary">Sign bounty to recipient</span>
                      {currentReceiverDisplay && (
                        <span className="ml-auto text-[0.6875rem] text-secondary">Current lock: {currentReceiverDisplay}</span>
                      )}
                    </div>
                    <div className="text-[0.6875rem] text-secondary">
                      Quickly re-encrypt the token so only the intended npub can redeem it.
                    </div>
                    {canSignToCompleter && (
                      <button
                        className={`accent-button button-sm pressable ${signingBounty ? 'opacity-70 cursor-wait' : ''}`}
                        title={completedNpub || undefined}
                        disabled={signingBounty}
                        onClick={() => { void handleSignToCompleter(); }}
                      >
                        {signingBounty ? 'Signing…' : `Sign to completer${completedDisplay ? ` (${completedDisplay})` : ''}`}
                      </button>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={signRecipientInput}
                        onChange={(e) => setSignRecipientInput(e.target.value)}
                        placeholder="npub1... or 64-hex pubkey"
                        className="pill-input flex-1 min-w-[11rem] text-xs"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={signingBounty}
                      />
                      <button
                        className={`accent-button button-sm pressable ${manualSignDisabled ? 'opacity-70 cursor-not-allowed' : ''}`}
                        disabled={manualSignDisabled}
                        onClick={() => { void handleManualSign(); }}
                      >
                        {signingBounty ? 'Signing…' : 'Sign to recipient'}
                      </button>
                    </div>
                  </div>
                )}
                {task.bounty.state === 'locked' && (
                  <>
                    <button className="accent-button button-sm pressable"
                            onClick={() => {
                              // Placeholder unlock: trust user has reissued unlocked token externally
                              const newTok = prompt('Paste unlocked token (after you reissued in your wallet):');
                              if (!newTok) return;
                              const unlocked = normalizeBounty({ ...task.bounty!, token: newTok, state: 'unlocked', updatedAt: new Date().toISOString() });
                              if (unlocked) save({ bounty: unlocked });
                            }}>Unlock…</button>
                    <button
                      className={`px-3 py-2 rounded-xl ${((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK)) ? 'bg-rose-600/80 hover:bg-rose-600' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                      disabled={!((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK))}
                      onClick={() => {
                        if (!((window as any).nostrPK && (task.bounty!.sender === (window as any).nostrPK || task.createdBy === (window as any).nostrPK))) return;
                        const revoked = normalizeBounty({ ...task.bounty!, state: 'revoked', updatedAt: new Date().toISOString() });
                        if (revoked) save({ bounty: revoked });
                      }}
                    >
                      Revoke
                    </button>
                  </>
                )}
                <button
                  className={`ml-auto px-3 py-2 rounded-xl ${task.bounty.state==='claimed' ? 'bg-neutral-800' : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'}`}
                  disabled={task.bounty.state !== 'claimed'}
                  onClick={() => {
                    if (task.bounty.state !== 'claimed') return;
                    save({ bounty: undefined });
                  }}
                >
                  Remove bounty
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Creator info */}
        <div className="pt-2">
          {(() => {
            const raw = task.createdBy || "";
            let display = raw;
            try {
              if (raw.startsWith("npub")) {
                const dec = nip19.decode(raw);
                if (typeof dec.data === 'string') display = dec.data;
                else if (dec.data && (dec.data as any).length) {
                  const arr = dec.data as unknown as ArrayLike<number>;
                  display = Array.from(arr).map((x)=>x.toString(16).padStart(2,'0')).join('');
                }
              }
            } catch {}
            const short = display
              ? display.length > 16
                ? display.slice(0, 10) + "…" + display.slice(-6)
                : display
              : "(not set)";
            const canCopy = !!display;
            return (
              <div className="flex items-center justify-between text-[0.6875rem] text-secondary">
                <div>
                  Created by: <span className="font-mono text-secondary">{short}</span>
                </div>
                <button
                  className={`ghost-button button-sm pressable ${canCopy ? '' : 'opacity-50 cursor-not-allowed'}`}
                  title={canCopy ? 'Copy creator key (hex)' : 'No key to copy'}
                  onClick={async () => { if (canCopy) { try { await navigator.clipboard?.writeText(display); } catch {} } }}
                  disabled={!canCopy}
                >
                  Copy
                </button>
              </div>
            );
          })()}
        </div>

        {/* Completed by info (only when completed) */}
        {task.completed && (
          <div className="pt-1">
            {(() => {
              const raw = task.completedBy || "";
              let display = raw;
              try {
                if (raw.startsWith("npub")) {
                  const dec = nip19.decode(raw);
                  if (typeof dec.data === 'string') display = dec.data;
                  else if (dec.data && (dec.data as any).length) {
                    const arr = dec.data as unknown as ArrayLike<number>;
                    display = Array.from(arr).map((x)=>x.toString(16).padStart(2,'0')).join('');
                  }
                }
              } catch {}
              const short = display
                ? display.length > 16
                  ? display.slice(0, 10) + "…" + display.slice(-6)
                  : display
                : "(not set)";
              const canCopy = !!display;
              return (
                <div className="flex items-center justify-between text-[0.6875rem] text-secondary">
                  <div>
                    Completed by: <span className="font-mono text-secondary">{short}</span>
                  </div>
                  <button
                    className={`ghost-button button-sm pressable ${canCopy ? '' : 'opacity-50 cursor-not-allowed'}`}
                    title={canCopy ? 'Copy completer key (hex)' : 'No key to copy'}
                    onClick={async () => { if (canCopy) { try { await navigator.clipboard?.writeText(display); } catch {} } }}
                    disabled={!canCopy}
                  >
                    Copy
                  </button>
                </div>
              );
            })()}
          </div>
        )}

        <div className="pt-2 flex justify-between">
          <button className="pressable px-4 py-2 rounded-full bg-rose-600/80 hover:bg-rose-600" onClick={onDelete}>Delete</button>
          <div className="flex gap-2">
            <button className="ghost-button button-sm pressable" onClick={copyCurrent}>Copy</button>
            <button className="ghost-button button-sm pressable" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>

      {showAdvanced && (
        <RecurrenceModal
          initial={rule}
          onClose={() => setShowAdvanced(false)}
          onApply={(r) => { setRule(r); setShowAdvanced(false); }}
        />
      )}
    </Modal>
  );
}

/* Advanced recurrence modal & picker */
function RecurrenceModal({
  initial,
  onClose,
  onApply,
  initialSchedule,
}: {
  initial: Recurrence;
  onClose: () => void;
  onApply: (r: Recurrence, scheduleISO?: string) => void;
  initialSchedule?: string;
}) {
  const [value, setValue] = useState<Recurrence>(initial);
  const [schedule, setSchedule] = useState(initialSchedule ?? "");

  return (
    <Modal
      onClose={onClose}
      title="Advanced recurrence"
      showClose={false}
      actions={
        <>
          <button
            className="ghost-button button-sm pressable"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="accent-button button-sm pressable"
            onClick={() =>
              onApply(
                value,
                initialSchedule !== undefined ? schedule : undefined
              )
            }
          >
            Apply
          </button>
        </>
      }
    >
      {initialSchedule !== undefined && (
        <div className="mb-4">
          <label htmlFor="advanced-schedule" className="block mb-1 text-sm font-medium">Scheduled for</label>
          <input
            id="advanced-schedule"
            type="date"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
            className="pill-input w-full"
            title="Scheduled date"
          />
        </div>
      )}
      <RecurrencePicker value={value} onChange={setValue} />
    </Modal>
  );
}

function RecurrencePicker({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence)=>void }) {
  const [weekly, setWeekly] = useState<Set<Weekday>>(new Set());
  const [everyN, setEveryN] = useState(2);
  const [unit, setUnit] = useState<"day"|"week">("day");
  const [monthDay, setMonthDay] = useState(15);
  const [end, setEnd] = useState(value.untilISO ? value.untilISO.slice(0,10) : "");

  useEffect(()=>{
    switch (value.type) {
      case "weekly": setWeekly(new Set(value.days)); break;
      case "every": setEveryN(value.n); setUnit(value.unit); break;
      case "monthlyDay": setMonthDay(value.day); break;
      default: setWeekly(new Set());
    }
    setEnd(value.untilISO ? value.untilISO.slice(0,10) : "");
  }, [value]);

  const withEnd = (r: Recurrence): Recurrence => ({ ...r, untilISO: end ? new Date(end).toISOString() : undefined });
  function setNone() { onChange(withEnd({ type: "none" })); }
  function setDaily() { onChange(withEnd({ type: "daily" })); }
    function toggleDay(d: Weekday) {
      const next = new Set(weekly);
      if (next.has(d)) {
        next.delete(d);
      } else {
        next.add(d);
      }
      setWeekly(next);
      const sorted = Array.from(next).sort((a,b)=>a-b);
      onChange(withEnd(sorted.length ? { type: "weekly", days: sorted } : { type: "none" }));
    }
  function applyEvery() { onChange(withEnd({ type:"every", n: Math.max(1, everyN || 1), unit })); }
  function applyMonthly() { onChange(withEnd({ type:"monthlyDay", day: Math.min(28, Math.max(1, monthDay)) })); }

  return (
    <div className="space-y-4">
      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Preset</div>
        <div className="flex flex-wrap gap-2">
          <button className="ghost-button button-sm pressable" onClick={setNone}>None</button>
          <button className="ghost-button button-sm pressable" onClick={setDaily}>Daily</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Weekly</div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-7">
          {Array.from({length:7},(_,i)=>i as Weekday).map(d=>{
            const on = weekly.has(d);
            const cls = on ? 'accent-button button-sm pressable w-full justify-center' : 'ghost-button button-sm pressable w-full justify-center';
            return (
              <button key={d} onClick={()=>toggleDay(d)} className={cls}>
                {WD_SHORT[d]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Every N</div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            min={1}
            max={30}
            value={everyN}
            onChange={e=>setEveryN(parseInt(e.target.value || "1",10))}
            className="pill-input w-24 text-center"
          />
          <select value={unit} onChange={e=>setUnit(e.target.value as "day"|"week")}
                  className="pill-select w-28">
            <option value="day">Days</option>
            <option value="week">Weeks</option>
          </select>
          <button className="accent-button button-sm pressable" onClick={applyEvery}>Apply</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">Monthly</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={28}
            value={monthDay}
            onChange={e=>setMonthDay(parseInt(e.target.value || '1',10))}
            className="pill-input w-24 text-center"
          />
          <button className="accent-button button-sm pressable" onClick={applyMonthly}>Apply</button>
        </div>
      </div>

      <div className="wallet-section space-y-3">
        <div className="text-sm font-medium">End date</div>
        <input
          type="date"
          value={end}
          onChange={e=>{ const v = e.target.value; setEnd(v); onChange({ ...value, untilISO: v ? new Date(v).toISOString() : undefined }); }}
          className="pill-input w-full"
        />
      </div>
    </div>
  );
}

/* Generic modal */
function Modal({ children, onClose, title, actions, showClose = true }: React.PropsWithChildren<{ onClose: ()=>void; title?: React.ReactNode; actions?: React.ReactNode; showClose?: boolean }>) {
  return (
    <div className="modal-backdrop">
      <div className="modal-panel">
        {(title || actions || showClose) && (
          <div className="modal-panel__header">
            {title && <div className="text-lg font-semibold text-primary">{title}</div>}
            {(actions || showClose) && (
              <div className="ml-auto flex items-center gap-2">
                {actions}
                {showClose && (
                  <button className="ghost-button button-sm pressable" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="modal-panel__body">{children}</div>
      </div>
    </div>
  );
}

/* Side drawer (right) */
function SideDrawer({ title, onClose, children }: React.PropsWithChildren<{ title?: string; onClose: ()=>void }>) {
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-panel__header">
          {title && <div className="text-lg font-semibold text-primary">{title}</div>}
          <button className="ghost-button button-sm pressable ml-auto" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* Settings modal incl. Week start + Manage Boards & Columns */
function SettingsModal({
  settings,
  boards,
  currentBoardId,
  setSettings,
  setBoards,
  shouldReloadForNavigation,
  defaultRelays,
  setDefaultRelays,
  pubkeyHex,
  onGenerateKey,
  onSetKey,
  onShareBoard,
  onJoinBoard,
  onRegenerateBoardId,
  onBoardChanged,
  onRestartTutorial,
  onClose,
  pushWorkState,
  pushError,
  onEnablePush,
  onDisablePush,
  workerBaseUrl,
  vapidPublicKey,
  onResetWalletTokenTracking,
}: {
  settings: Settings;
  boards: Board[];
  currentBoardId: string;
  setSettings: (s: Partial<Settings>) => void;
  setBoards: React.Dispatch<React.SetStateAction<Board[]>>;
  shouldReloadForNavigation: () => boolean;
  defaultRelays: string[];
  setDefaultRelays: (rls: string[]) => void;
  pubkeyHex: string;
  onGenerateKey: () => void;
  onSetKey: (hex: string) => void;
  onShareBoard: (boardId: string, relaysCsv?: string) => void;
  onJoinBoard: (nostrId: string, name?: string, relaysCsv?: string) => void;
  onRegenerateBoardId: (boardId: string) => void;
  onBoardChanged: (
    boardId: string,
    options?: { republishTasks?: boolean; board?: Board },
  ) => void;
  onRestartTutorial: () => void;
  onClose: () => void;
  pushWorkState: "idle" | "enabling" | "disabling";
  pushError: string | null;
  onEnablePush: (platform: PushPlatform) => Promise<void>;
  onDisablePush: () => Promise<void>;
  workerBaseUrl: string;
  vapidPublicKey: string;
  onResetWalletTokenTracking: () => void;
}) {
  const [newBoardName, setNewBoardName] = useState("");
  const [manageBoardId, setManageBoardId] = useState<string | null>(null);
  const manageBoard = boards.find(b => b.id === manageBoardId);
  const [relaysCsv, setRelaysCsv] = useState("");
  const [customSk, setCustomSk] = useState("");
  const [viewExpanded, setViewExpanded] = useState(false);
  const [walletExpanded, setWalletExpanded] = useState(false);
  const [walletSeedVisible, setWalletSeedVisible] = useState(false);
  const [walletSeedWords, setWalletSeedWords] = useState<string | null>(null);
  const [walletSeedError, setWalletSeedError] = useState<string | null>(null);
  const [bibleExpanded, setBibleExpanded] = useState(false);
  const [backupExpanded, setBackupExpanded] = useState(false);
  const [showPushAdvanced, setShowPushAdvanced] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [walletCounters, setWalletCounters] = useState<Record<string, Record<string, number>>>(() => getWalletCountersByMint());
  const [keysetCounterBusy, setKeysetCounterBusy] = useState<string | null>(null);
  const [walletAdvancedVisible, setWalletAdvancedVisible] = useState(false);
  const [showNewSeedConfirm, setShowNewSeedConfirm] = useState(false);
  const [removeSpentBusy, setRemoveSpentBusy] = useState(false);
  const [removeSpentStatus, setRemoveSpentStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [debugConsoleState, setDebugConsoleState] = useState<"inactive" | "loading" | "active">("inactive");
  const [debugConsoleMessage, setDebugConsoleMessage] = useState<string | null>(null);
  const debugConsoleScriptRef = useRef<HTMLScriptElement | null>(null);

  const [newDefaultRelay, setNewDefaultRelay] = useState("");
  const [newBoardRelay, setNewBoardRelay] = useState("");
  const [newOverrideRelay, setNewOverrideRelay] = useState("");
  const [newCompoundChildId, setNewCompoundChildId] = useState("");
  const [newBoardType, setNewBoardType] = useState<"lists" | "compound">("lists");
  const [showArchivedBoards, setShowArchivedBoards] = useState(false);
  const [archiveDropActive, setArchiveDropActive] = useState(false);
  const boardListRef = useRef<HTMLUListElement>(null);
  const [boardListMaxHeight, setBoardListMaxHeight] = useState<number | null>(null);
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);
  const unarchivedBoards = useMemo(() => boards.filter(b => !b.archived), [boards]);
  const archivedBoards = useMemo(() => boards.filter(b => b.archived), [boards]);
  const currentBoard = useMemo(
    () => boards.find((board) => board.id === currentBoardId) || null,
    [boards, currentBoardId],
  );
  const availableMemoryBoards = useMemo(
    () => boards.filter((board) => !board.archived && board.kind !== "bible"),
    [boards],
  );
  const defaultScriptureMemoryBoardId = useMemo(
    () => availableMemoryBoards[0]?.id ?? null,
    [availableMemoryBoards],
  );
  const availableCompoundBoards = useMemo(() => {
    if (!manageBoard || manageBoard.kind !== "compound") return [] as Board[];
    return boards.filter((board) => {
      if (board.id === manageBoard.id) return false;
      if (board.kind !== "lists") return false;
      if (board.archived) return false;
      return !manageBoard.children.some((childId) => compoundChildMatchesBoard(childId, board));
    });
  }, [boards, manageBoard]);
  // Mint selector moved to Wallet modal; no need to read here.
  const { show: showToast } = useToast();
  const { mintUrl, payInvoice, checkProofStates } = useCashu();
  const [donateAmt, setDonateAmt] = useState("");
  const [donateComment, setDonateComment] = useState("");
  const [donateState, setDonateState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [donateMsg, setDonateMsg] = useState("");
  const [cloudRestoreKey, setCloudRestoreKey] = useState("");
  const [cloudRestoreState, setCloudRestoreState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [cloudRestoreMessage, setCloudRestoreMessage] = useState("");
  const [cloudBackupState, setCloudBackupState] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [cloudBackupMessage, setCloudBackupMessage] = useState("");
  const pillButtonClass = useCallback((active: boolean) => `${active ? "accent-button" : "ghost-button"} pressable`, []);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundAccentHex = settings.backgroundAccent ? settings.backgroundAccent.fill.toUpperCase() : null;
  const pushPrefs = settings.pushNotifications ?? DEFAULT_PUSH_PREFERENCES;
  const secureContext = typeof window !== 'undefined' ? window.isSecureContext : false;
  const pushSupported = typeof window !== 'undefined'
    && secureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window;
  const workerConfigured = !!workerBaseUrl;
  const vapidConfigured = !!vapidPublicKey;
  const pushBusy = pushWorkState !== 'idle';
  const permissionLabel = pushPrefs.permission ?? (typeof Notification !== 'undefined' ? Notification.permission : 'default');
  const pushSupportHint = !secureContext
    ? 'Push notifications require HTTPS (or localhost during development).'
    : 'Push notifications need a browser with Service Worker and Push API support.';
  const renderBackupButtons = (containerClassName = "") => (
    <div className={`flex flex-col gap-2 sm:flex-row ${containerClassName}`.trim()}>
      <button
        className={`${settings.cloudBackupsEnabled ? "ghost-button" : "accent-button"} button-sm pressable shrink-0`}
        onClick={() => setSettings({ cloudBackupsEnabled: !settings.cloudBackupsEnabled })}
      >
        {settings.cloudBackupsEnabled ? "Disable daily cloud backups" : "Enable daily cloud backups"}
      </button>
      <button
        className="accent-button button-sm pressable shrink-0"
        onClick={handleManualCloudBackup}
        disabled={!workerBaseUrl || cloudBackupState === "uploading"}
      >
        {cloudBackupState === "uploading" ? "Saving…" : "Save backup to cloud"}
      </button>
    </div>
  );
  const {
    keys: p2pkKeys,
    primaryKey: primaryP2pkKey,
    generateKeypair: generateP2pkKeypair,
    importFromNsec: importP2pkFromNsec,
    removeKey: removeP2pkKey,
    setPrimaryKey: setPrimaryP2pkKey,
  } = useP2PK();
  const [p2pkImportVisible, setP2pkImportVisible] = useState(false);
  const [p2pkImportValue, setP2pkImportValue] = useState("");
  const [p2pkImportLabel, setP2pkImportLabel] = useState("");
  const [p2pkImportError, setP2pkImportError] = useState("");
  const [p2pkKeysExpanded, setP2pkKeysExpanded] = useState(false);
  const walletCounterEntries = useMemo(
    () => Object.entries(walletCounters).sort(([a], [b]) => a.localeCompare(b)),
    [walletCounters],
  );
  const walletCounterDisplayEntries = useMemo(
    () => walletCounterEntries.filter(([, counters]) => Object.keys(counters).length > 0),
    [walletCounterEntries],
  );
  const normalizeMint = useCallback((url: string) => (url || "").trim().replace(/\/+$/, ""), []);
  const shortMintLabel = useCallback((url: string) => {
    if (!url) return "";
    try {
      const target = url.includes("://") ? url : `https://${url}`;
      const parsed = new URL(target);
      return parsed.host || url;
    } catch {
      return url;
    }
  }, []);
  const refreshWalletCounters = useCallback(() => {
    setWalletCounters(getWalletCountersByMint());
  }, []);
  useEffect(() => {
    if (walletExpanded) {
      refreshWalletCounters();
    }
  }, [walletExpanded, refreshWalletCounters]);
  const collectSpentSecrets = useCallback(
    async (mintUrl: string, proofs: Proof[]) => {
      const normalized = normalizeMint(mintUrl);
      if (!normalized) {
        throw new Error("Mint unavailable");
      }
      const spent = new Set<string>();
      const chunkSize = 50;
      for (let start = 0; start < proofs.length; start += chunkSize) {
        const chunk = proofs.slice(start, start + chunkSize);
        const states = await checkProofStates(normalized, chunk);
        states.forEach((state, index) => {
          const stateValue = typeof state?.state === "string" ? state.state.toUpperCase() : "";
          if (stateValue === "SPENT") {
            const secret = chunk[index]?.secret;
            if (secret) {
              spent.add(secret);
            }
          }
        });
      }
      return spent;
    },
    [checkProofStates, normalizeMint],
  );
  const handleRegenerateWalletSeed = useCallback(() => {
    try {
      const record = regenerateWalletSeed();
      setWalletSeedWords(record.mnemonic);
      setWalletSeedVisible(true);
      setWalletSeedError(null);
      refreshWalletCounters();
      setReloadNeeded(true);
      setShowNewSeedConfirm(false);
      showToast("New seed phrase generated. Close Settings to reload your wallet.", 3500);
    } catch (error: any) {
      const message = error?.message || "Failed to generate a new seed phrase.";
      setWalletSeedError(message);
      showToast(message, 3500);
    }
  }, [refreshWalletCounters, setReloadNeeded, setWalletSeedError, setWalletSeedVisible, setWalletSeedWords, showToast]);
  const handleRemoveSpentProofs = useCallback(async () => {
    setRemoveSpentBusy(true);
    setRemoveSpentStatus(null);
    try {
      const store = loadProofStore();
      const entries = Object.entries(store);
      if (!entries.length) {
        setRemoveSpentStatus({ type: "success", message: "No proofs stored for any mint." });
        return;
      }
      let totalRemoved = 0;
      const mintErrors: string[] = [];
      for (const [mintKey, proofList] of entries) {
        if (!Array.isArray(proofList) || proofList.length === 0) continue;
        const proofsWithSecret = proofList.filter(
          (proof): proof is Proof => !!proof?.secret && typeof proof.secret === "string" && proof.secret.trim() !== "",
        );
        if (!proofsWithSecret.length) continue;
        try {
          const spentSecrets = await collectSpentSecrets(mintKey, proofsWithSecret);
          if (!spentSecrets.size) continue;
          store[mintKey] = proofList.filter((proof) => {
            if (!proof || typeof proof.secret !== "string") return true;
            return !spentSecrets.has(proof.secret);
          });
          totalRemoved += spentSecrets.size;
        } catch (error: any) {
          mintErrors.push(`${shortMintLabel(mintKey)}: ${error?.message || "check failed"}`);
        }
      }
      if (totalRemoved > 0) {
        saveProofStore(store);
        setReloadNeeded(true);
        showToast("Removed spent proofs. Close Settings to reload your wallet.", 3500);
      }
      const parts: string[] = [];
      if (totalRemoved > 0) {
        parts.push(`Removed ${totalRemoved} spent note${totalRemoved === 1 ? "" : "s"}.`);
      } else {
        parts.push("No spent proofs detected.");
      }
      if (mintErrors.length) {
        parts.push(`Skipped ${mintErrors.length} mint${mintErrors.length === 1 ? "" : "s"} (${mintErrors.join("; ")}).`);
      }
      setRemoveSpentStatus({
        type: mintErrors.length ? "error" : "success",
        message: parts.join(" "),
      });
    } catch (error: any) {
      setRemoveSpentStatus({ type: "error", message: error?.message || "Unable to remove spent proofs." });
    } finally {
      setRemoveSpentBusy(false);
    }
  }, [collectSpentSecrets, setReloadNeeded, setRemoveSpentBusy, setRemoveSpentStatus, shortMintLabel, showToast]);
  const handleIncrementKeysetCounter = useCallback(
    (mintUrl: string, keysetId: string) => {
      const normalizedMint = normalizeMint(mintUrl);
      if (!normalizedMint || !keysetId) return;
      const busyKey = `${normalizedMint}|${keysetId}`;
      setKeysetCounterBusy(busyKey);
      try {
        const nextValue = incrementWalletCounter(normalizedMint, keysetId, 1);
        setWalletCounters((prev) => {
          const next = { ...prev };
          const mintCounters = { ...(next[normalizedMint] ?? {}) };
          mintCounters[keysetId] = nextValue;
          next[normalizedMint] = mintCounters;
          return next;
        });
        setReloadNeeded(true);
        showToast("Counter incremented. Close Settings to reload your wallet.", 3500);
      } catch (error: any) {
        showToast(error?.message || "Failed to increment counter.", 3500);
      } finally {
        setKeysetCounterBusy(null);
      }
    },
    [normalizeMint, setKeysetCounterBusy, setReloadNeeded, setWalletCounters, showToast],
  );
  const enableDebugConsole = useCallback(() => {
    if (debugConsoleState === "loading") return;
    setDebugConsoleMessage(null);
    if (typeof document === "undefined") {
      setDebugConsoleMessage("Debug console unavailable in this environment.");
      return;
    }
    if (document.querySelector("#eruda")) {
      setDebugConsoleState("active");
      showToast("Debug console already enabled.", 2500);
      return;
    }
    setDebugConsoleState("loading");
    try {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/eruda";
      script.async = true;
      script.setAttribute("data-taskify-eruda", "true");
      script.onload = () => {
        try {
          (window as any)?.eruda?.init?.();
          setDebugConsoleState("active");
          showToast("Debug console enabled.", 2500);
        } catch (error: any) {
          setDebugConsoleState("inactive");
          setDebugConsoleMessage(error?.message || "Failed to start the debug console.");
        }
      };
      script.onerror = () => {
        setDebugConsoleState("inactive");
        setDebugConsoleMessage("Failed to load the debug console script.");
      };
      document.body.appendChild(script);
      debugConsoleScriptRef.current = script;
    } catch (error: any) {
      setDebugConsoleState("inactive");
      setDebugConsoleMessage(error?.message || "Failed to load the debug console.");
    }
  }, [debugConsoleScriptRef, debugConsoleState, setDebugConsoleMessage, setDebugConsoleState, showToast]);
  const disableDebugConsole = useCallback(() => {
    setDebugConsoleMessage(null);
    if (typeof document !== "undefined") {
      const erudaRoot = document.querySelector("#eruda");
      if (erudaRoot) erudaRoot.remove();
      const script = debugConsoleScriptRef.current;
      if (script?.parentNode) {
        script.parentNode.removeChild(script);
      }
      debugConsoleScriptRef.current = null;
    }
    if (typeof window !== "undefined") {
      try {
        const eruda = (window as any)?.eruda;
        eruda?.destroy?.();
      } catch {}
    }
    setDebugConsoleState("inactive");
    showToast("Debug console disabled.", 2000);
  }, [debugConsoleScriptRef, setDebugConsoleMessage, setDebugConsoleState, showToast]);
  const handleToggleDebugConsole = useCallback(() => {
    if (debugConsoleState === "loading") return;
    if (debugConsoleState === "active") {
      disableDebugConsole();
    } else {
      enableDebugConsole();
    }
  }, [debugConsoleState, disableDebugConsole, enableDebugConsole]);
  useEffect(() => {
    if (typeof document !== "undefined" && document.querySelector("#eruda")) {
      setDebugConsoleState("active");
    }
  }, []);
  const sortedP2pkKeys = useMemo(() => {
    return [...p2pkKeys].sort((a, b) => {
      const labelA = (a.label || "").toLowerCase();
      const labelB = (b.label || "").toLowerCase();
      if (labelA && labelB && labelA !== labelB) return labelA.localeCompare(labelB);
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return a.publicKey.localeCompare(b.publicKey);
    });
  }, [p2pkKeys]);
  const handleGenerateP2pkKey = useCallback((): P2PKKey | null => {
    try {
      const key = generateP2pkKeypair();
      setPrimaryP2pkKey(key.id);
      setP2pkKeysExpanded(true);
      showToast("Generated new P2PK key", 2500);
      return key;
    } catch (err: any) {
      showToast(err?.message || "Unable to generate key");
      return null;
    }
  }, [generateP2pkKeypair, setPrimaryP2pkKey, setP2pkKeysExpanded, showToast]);
  const handleImportP2pkKey = useCallback((): P2PKKey | null => {
    setP2pkImportError("");
    try {
      const key = importP2pkFromNsec(p2pkImportValue, {
        label: p2pkImportLabel.trim() || undefined,
      });
      setPrimaryP2pkKey(key.id);
      setP2pkImportValue("");
      setP2pkImportLabel("");
      setP2pkImportVisible(false);
      setP2pkKeysExpanded(true);
      showToast("Key imported", 2500);
      return key;
    } catch (err: any) {
      setP2pkImportError(err?.message || "Unable to import key");
      return null;
    }
  }, [importP2pkFromNsec, p2pkImportLabel, p2pkImportValue, setPrimaryP2pkKey, showToast]);
  const handleRemoveP2pkKey = useCallback(
    (key: P2PKKey) => {
      if (!window.confirm("Remove this P2PK key? Tokens locked to it will no longer be spendable here.")) return;
      removeP2pkKey(key.id);
      showToast("Key removed", 2000);
    },
    [removeP2pkKey, showToast],
  );
  const handleSetPrimaryP2pkKey = useCallback(
    (key: P2PKKey) => {
      setPrimaryP2pkKey(key.id);
      showToast("Primary P2PK key updated", 2000);
    },
    [setPrimaryP2pkKey, showToast],
  );
  const handleCopyP2pkKey = useCallback(
    async (pubkey: string) => {
      try {
        await navigator.clipboard?.writeText(pubkey);
        showToast("Copied P2PK public key", 2000);
      } catch {
        showToast("Unable to copy key", 2000);
      }
    },
    [showToast],
  );

  const ensureWalletSeedLoaded = useCallback((): string => {
    if (walletSeedWords) return walletSeedWords;
    try {
      const mnemonic = getWalletSeedMnemonic();
      setWalletSeedWords(mnemonic);
      setWalletSeedError(null);
      return mnemonic;
    } catch (error) {
      console.error("[wallet] Unable to load seed", error);
      const message = "Unable to access wallet seed.";
      setWalletSeedError(message);
      throw error instanceof Error ? error : new Error(message);
    }
  }, [walletSeedWords]);

  const handleToggleWalletSeed = useCallback(() => {
    try {
      const seed = ensureWalletSeedLoaded();
      if (!seed) {
        setWalletSeedError("Wallet seed unavailable.");
        return;
      }
      setWalletSeedVisible((prev) => !prev);
    } catch {
      // error state already handled in ensureWalletSeedLoaded
    }
  }, [ensureWalletSeedLoaded]);

  const handleCopyWalletSeed = useCallback(async () => {
    try {
      const mnemonic = ensureWalletSeedLoaded();
      if (!mnemonic) {
        setWalletSeedError("Wallet seed unavailable.");
        return;
      }
      await navigator.clipboard?.writeText(mnemonic);
      setWalletSeedError(null);
      showToast("Wallet seed copied", 2000);
    } catch (error) {
      console.error("[wallet] Failed to copy wallet seed", error);
      setWalletSeedError("Unable to copy wallet seed.");
      showToast("Unable to copy wallet seed", 2000);
    }
  }, [ensureWalletSeedLoaded, showToast]);

  const handleDownloadWalletSeed = useCallback(() => {
    try {
      const mnemonic = ensureWalletSeedLoaded();
      if (!mnemonic) {
        setWalletSeedError("Wallet seed unavailable.");
        return;
      }
      const backup = getWalletSeedBackupJson();
      const blob = new Blob([backup], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `taskify-wallet-seed-${timestamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setWalletSeedError(null);
      showToast("Wallet seed saved", 2000);
    } catch (error) {
      console.error("[wallet] Failed to save wallet seed", error);
      setWalletSeedError("Unable to save wallet seed.");
      showToast("Unable to save wallet seed", 2000);
    }
  }, [ensureWalletSeedLoaded, showToast]);

  const handleBackgroundImageSelection = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast("Image too large. Please pick something under 8 MB.");
      return;
    }
    try {
      const { dataUrl, palettes } = await prepareBackgroundImage(file);
      const primary = palettes[0] ?? null;
      setSettings({
        backgroundImage: dataUrl,
        backgroundAccents: palettes,
        backgroundAccentIndex: primary ? 0 : null,
        backgroundAccent: primary,
        accent: primary ? "background" : "blue",
      });
      showToast("Background updated");
    } catch (err) {
      if (err instanceof BackgroundImageError) {
        showToast(err.message);
      } else {
        console.error("Failed to process background image", err);
        showToast("Could not load that image");
      }
    }
  }, [setSettings, showToast]);

  const handleEnablePush = useCallback(async () => {
    try {
      await onEnablePush(pushPrefs.platform);
    } catch {}
  }, [onEnablePush, pushPrefs.platform]);

  const handleDisablePush = useCallback(async () => {
    try {
      await onDisablePush();
    } catch {}
  }, [onDisablePush]);

  const clearBackgroundImage = useCallback(() => {
    setSettings({
      backgroundImage: null,
      backgroundAccent: null,
      backgroundAccents: null,
      backgroundAccentIndex: null,
      accent: "blue",
    });
    showToast("Background cleared");
  }, [setSettings, showToast]);
  const photoAccents = settings.backgroundAccents ?? [];
  const handleSelectPhotoAccent = useCallback((index: number) => {
    const palette = settings.backgroundAccents?.[index];
    if (!palette) return;
    setSettings({
      backgroundAccent: palette,
      backgroundAccentIndex: index,
      accent: "background",
    });
  }, [setSettings, settings.backgroundAccents]);

  useEffect(() => {
    const listEl = boardListRef.current;
    if (!listEl) return;

    function computeHeight() {
      const currentList = boardListRef.current;
      if (!currentList) return;
      const items = Array.from(currentList.children) as HTMLElement[];
      if (items.length === 0) {
        setBoardListMaxHeight(null);
        return;
      }
      const firstRect = items[0].getBoundingClientRect();
      if (firstRect.height === 0) {
        setBoardListMaxHeight(null);
        return;
      }
      let step = firstRect.height;
      if (items.length > 1) {
        const secondRect = items[1].getBoundingClientRect();
        const diff = secondRect.top - firstRect.top;
        if (diff > 0) step = diff;
      }
      const lastRect = items[items.length - 1].getBoundingClientRect();
      const totalHeight = lastRect.bottom - firstRect.top;
      const limit = step * 5.5;
      if (totalHeight <= limit) {
        setBoardListMaxHeight(null);
        return;
      }
      setBoardListMaxHeight(limit);
    }

    computeHeight();

    const handleResize = () => computeHeight();
    window.addEventListener("resize", handleResize);

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => computeHeight());
      resizeObserver.observe(listEl);
      Array.from(listEl.children).forEach((child) => resizeObserver!.observe(child));
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
    };
  }, [unarchivedBoards]);

  function parseCsv(csv: string): string[] {
    return csv.split(",").map(s => s.trim()).filter(Boolean);
  }

  function addRelayToCsv(csv: string, relay: string): string {
    const list = parseCsv(csv);
    const val = relay.trim();
    if (!val) return csv;
    if (list.includes(val)) return csv;
    return [...list, val].join(",");
  }

  function removeRelayFromCsv(csv: string, relay: string): string {
    const list = parseCsv(csv);
    return list.filter(r => r !== relay).join(",");
  }

  function handleDailyStartBoardChange(day: Weekday, boardId: string) {
    const prev = settings.startBoardByDay;
    const next: Partial<Record<Weekday, string>> = { ...prev };
    if (!boardId) {
      if (prev[day] === undefined) return;
      delete next[day];
    } else {
      if (prev[day] === boardId) return;
      next[day] = boardId;
    }
    setSettings({ startBoardByDay: next });
  }

  const collectBackupData = useCallback((): TaskifyBackupPayload => {
    const bibleTrackerRaw = localStorage.getItem(LS_BIBLE_TRACKER);
    let cashuHistory: unknown = [];
    try {
      const historyRaw = localStorage.getItem("cashuHistory");
      const parsed = historyRaw ? JSON.parse(historyRaw) : [];
      cashuHistory = Array.isArray(parsed) ? parsed : [];
    } catch {
      cashuHistory = [];
    }
    return {
      tasks: JSON.parse(localStorage.getItem(LS_TASKS) || "[]"),
      boards: JSON.parse(localStorage.getItem(LS_BOARDS) || "[]"),
      settings: JSON.parse(localStorage.getItem(LS_SETTINGS) || "{}"),
      scriptureMemory: JSON.parse(localStorage.getItem(LS_SCRIPTURE_MEMORY) || "{}"),
      bibleTracker: bibleTrackerRaw ? JSON.parse(bibleTrackerRaw) : null,
      defaultRelays: JSON.parse(localStorage.getItem(LS_NOSTR_RELAYS) || "[]"),
      contacts: JSON.parse(localStorage.getItem(LS_LIGHTNING_CONTACTS) || "[]"),
      nostrSk: localStorage.getItem(LS_NOSTR_SK) || "",
      cashu: {
        proofs: loadProofStore(),
        activeMint: getActiveMint(),
        history: cashuHistory,
      },
    };
  }, []);

  function backupData() {
    const data = collectBackupData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "taskify-backup.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  const uploadCloudBackup = useCallback(async (skHex: string): Promise<number> => {
    if (!workerBaseUrl) {
      throw new Error("Cloud backup service is unavailable.");
    }
    const backupPayload = collectBackupData();
    const encrypted = await encryptBackupWithSecretKey(skHex, JSON.stringify(backupPayload));
    const npub = deriveNpubFromSecretKeyHex(skHex);
    if (!npub) {
      throw new Error("Unable to derive npub from the provided key.");
    }
    const res = await fetch(`${workerBaseUrl}/api/backups`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        npub,
        version: 1,
        createdAt: new Date().toISOString(),
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
      }),
    });
    if (!res.ok) {
      let message = `Backup upload failed (${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson && typeof errJson === "object" && typeof errJson.error === "string" && errJson.error) {
          message = errJson.error;
        }
      } catch {}
      throw new Error(message);
    }
    const now = Date.now();
    localStorage.setItem(LS_LAST_CLOUD_BACKUP, String(now));
    return now;
  }, [collectBackupData, workerBaseUrl]);

  const applyBackupData = useCallback((data: Partial<TaskifyBackupPayload>) => {
    if (!data || typeof data !== "object") {
      throw new Error("Invalid backup data");
    }
    if ("tasks" in data && data.tasks !== undefined) {
      localStorage.setItem(LS_TASKS, JSON.stringify(data.tasks));
    }
    if ("boards" in data && data.boards !== undefined) {
      localStorage.setItem(LS_BOARDS, JSON.stringify(data.boards));
    }
    if ("settings" in data && data.settings !== undefined) {
      localStorage.setItem(LS_SETTINGS, JSON.stringify(data.settings));
    }
    if ("scriptureMemory" in data && data.scriptureMemory !== undefined) {
      localStorage.setItem(LS_SCRIPTURE_MEMORY, JSON.stringify(data.scriptureMemory));
    }
    if ("bibleTracker" in data && data.bibleTracker !== undefined) {
      localStorage.setItem(LS_BIBLE_TRACKER, JSON.stringify(data.bibleTracker));
    }
    if ("defaultRelays" in data && data.defaultRelays !== undefined) {
      localStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(data.defaultRelays));
    }
    if ("contacts" in data && data.contacts !== undefined) {
      localStorage.setItem(LS_LIGHTNING_CONTACTS, JSON.stringify(data.contacts));
    }
    if (typeof data.nostrSk === "string" && data.nostrSk) {
      localStorage.setItem(LS_NOSTR_SK, data.nostrSk);
    }
    const cashuData: any = (data as any)?.cashu;
    if (cashuData && typeof cashuData === "object") {
      if ("proofs" in cashuData && cashuData.proofs !== undefined) {
        saveProofStore(cashuData.proofs);
      }
      if ("activeMint" in cashuData) {
        setActiveMint(cashuData.activeMint || null);
      }
      if ("history" in cashuData) {
        try {
          const history = Array.isArray(cashuData.history) ? cashuData.history : [];
          localStorage.setItem("cashuHistory", JSON.stringify(history));
        } catch {
          localStorage.removeItem("cashuHistory");
        }
      }
    }
    setReloadNeeded(true);
  }, [setReloadNeeded]);

  function restoreFromBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        const data = JSON.parse(txt);
        applyBackupData(data);
        alert("Backup restored. Press close to reload.");
      } catch {
        alert("Invalid backup file");
      }
    });
    e.target.value = "";
  }

  useEffect(() => {
    if (!workerBaseUrl) return;
    if (typeof window === "undefined") return;
    if (!settings.cloudBackupsEnabled) return;

    const attemptBackup = async () => {
      try {
        if (typeof crypto === "undefined" || !crypto.subtle) return;
        const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
        if (!/^[0-9a-fA-F]{64}$/.test(skHex)) return;
        const lastRaw = localStorage.getItem(LS_LAST_CLOUD_BACKUP);
        const lastMs = lastRaw ? Number.parseInt(lastRaw, 10) : 0;
        const now = Date.now();
        if (Number.isFinite(lastMs)) {
          if (isSameLocalDate(lastMs, now)) return;
          if (now - lastMs < CLOUD_BACKUP_MIN_INTERVAL_MS) return;
        }

        await uploadCloudBackup(skHex);
      } catch (err) {
        console.warn("Cloud backup upload failed", err);
      }
    };

    attemptBackup();
  }, [settings.cloudBackupsEnabled, uploadCloudBackup, workerBaseUrl]);

  const handleManualCloudBackup = useCallback(async () => {
    if (!workerBaseUrl) {
      setCloudBackupState("error");
      setCloudBackupMessage("Cloud backup service is unavailable.");
      return;
    }
    if (typeof crypto === "undefined" || !crypto.subtle) {
      setCloudBackupState("error");
      setCloudBackupMessage("Browser crypto APIs are unavailable.");
      return;
    }
    const skHex = localStorage.getItem(LS_NOSTR_SK) || "";
    if (!/^[0-9a-fA-F]{64}$/.test(skHex)) {
      setCloudBackupState("error");
      setCloudBackupMessage("Add your Nostr secret key in Keys to use cloud backups.");
      return;
    }
    const now = Date.now();
    const lastManualRaw = localStorage.getItem(LS_LAST_MANUAL_CLOUD_BACKUP);
    const lastManualMs = lastManualRaw ? Number.parseInt(lastManualRaw, 10) : 0;
    if (Number.isFinite(lastManualMs) && now - lastManualMs < MANUAL_CLOUD_BACKUP_INTERVAL_MS) {
      const waitSeconds = Math.ceil((MANUAL_CLOUD_BACKUP_INTERVAL_MS - (now - lastManualMs)) / 1000);
      setCloudBackupState("error");
      setCloudBackupMessage(`Please wait ${waitSeconds} more second${waitSeconds === 1 ? "" : "s"} before saving another backup.`);
      return;
    }
    setCloudBackupState("uploading");
    setCloudBackupMessage("");
    try {
      const timestamp = await uploadCloudBackup(skHex);
      localStorage.setItem(LS_LAST_MANUAL_CLOUD_BACKUP, String(timestamp));
      setCloudBackupState("success");
      setCloudBackupMessage("Backup saved to cloud.");
    } catch (err: any) {
      const message = err?.message || String(err);
      setCloudBackupState("error");
      setCloudBackupMessage(message);
    }
  }, [uploadCloudBackup, workerBaseUrl]);

  const handleRestoreFromCloud = useCallback(async () => {
    if (!workerBaseUrl) {
      setCloudRestoreState("error");
      setCloudRestoreMessage("Cloud backup service is unavailable.");
      return;
    }
    const normalized = normalizeSecretKeyInput(cloudRestoreKey);
    if (!normalized) {
      setCloudRestoreState("error");
      setCloudRestoreMessage("Enter a valid nsec or 64-hex private key.");
      return;
    }
    if (typeof crypto === "undefined" || !crypto.subtle) {
      setCloudRestoreState("error");
      setCloudRestoreMessage("Browser crypto APIs are unavailable.");
      return;
    }
    setCloudRestoreState("loading");
    setCloudRestoreMessage("");
    try {
      const npub = deriveNpubFromSecretKeyHex(normalized);
      if (!npub) {
        throw new Error("Unable to derive npub from the provided key.");
      }
      const res = await fetch(`${workerBaseUrl}/api/backups?npub=${encodeURIComponent(npub)}`);
      if (res.status === 404) {
        throw new Error("No cloud backup found for that key.");
      }
      if (!res.ok) {
        throw new Error(`Backup request failed (${res.status})`);
      }
      const body = await res.json();
      const backup = body?.backup;
      if (!backup || typeof backup !== "object" || typeof backup.ciphertext !== "string" || typeof backup.iv !== "string") {
        throw new Error("Invalid backup payload received.");
      }
      const decrypted = await decryptBackupWithSecretKey(normalized, {
        ciphertext: backup.ciphertext,
        iv: backup.iv,
      });
      let parsed: Partial<TaskifyBackupPayload>;
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        throw new Error("Cloud backup could not be decoded.");
      }
      applyBackupData(parsed);
      alert("Backup restored. Press close to reload.");
      setCloudRestoreState("success");
      setCloudRestoreMessage("Cloud backup restored. Press close to reload.");
      setCloudRestoreKey("");
    } catch (err: any) {
      const message = err?.message || String(err);
      setCloudRestoreState("error");
      setCloudRestoreMessage(message);
    }
  }, [applyBackupData, cloudRestoreKey, workerBaseUrl]);

  async function handleDonate() {
    setDonateState("sending");
    setDonateMsg("");
    try {
      const amtSat = Math.max(0, Math.floor(Number(donateAmt) || 0));
      if (!amtSat) throw new Error("Enter amount in sats");
      if (!mintUrl) throw new Error("Set a Cashu mint in Wallet first");

      const lnAddress = DONATION_LIGHTNING_ADDRESS;
      if (isPlaceholderValue(lnAddress) || !lnAddress.includes("@")) {
        throw new Error("Donation address is not configured.");
      }
      const [name, domain] = lnAddress.split("@");
      if (!name || !domain) {
        throw new Error("Donation address is invalid.");
      }
      const infoRes = await fetch(`https://${domain}/.well-known/lnurlp/${name}`);
      if (!infoRes.ok) throw new Error("Unable to fetch LNURL pay info");
      const info = await infoRes.json();

      const minSat = Math.ceil((info?.minSendable || 0) / 1000);
      const maxSat = Math.floor((info?.maxSendable || Infinity) / 1000);
      if (amtSat < minSat) throw new Error(`Minimum is ${minSat} sats`);
      if (amtSat > maxSat) throw new Error(`Maximum is ${maxSat} sats`);

      const commentAllowed: number = Number(info?.commentAllowed || 0) || 0;
      const comment = (donateComment || "").trim();
      if (comment && commentAllowed > 0 && comment.length > commentAllowed) {
        throw new Error(`Comment too long (max ${commentAllowed} chars)`);
      }

      const params = new URLSearchParams({ amount: String(amtSat * 1000) });
      if (comment) params.set("comment", comment);
      const invRes = await fetch(`${info.callback}?${params.toString()}`);
      if (!invRes.ok) throw new Error("Failed to get invoice");
      const inv = await invRes.json();
      if (inv?.status === "ERROR") throw new Error(inv?.reason || "Invoice error");

      const invoice = inv.pr;
      const paymentResult = await payInvoice(invoice);
      const donationSummary = comment
        ? `Donated ${amtSat} sats to ${lnAddress} • ${comment}`
        : `Donated ${amtSat} sats to ${lnAddress}`;

      appendWalletHistoryEntry({
        id: `donate-${Date.now()}`,
        summary: donationSummary,
        detail: invoice,
        detailKind: "invoice",
        type: "lightning",
        direction: "out",
        amountSat: amtSat,
        feeSat: paymentResult?.feeReserveSat ?? undefined,
        mintUrl: paymentResult?.mintUrl ?? mintUrl ?? undefined,
      });

      setDonateState("done");
      setDonateMsg("Thank you for your support! - The Solife team");
      setDonateAmt("");
      setDonateComment("");
    } catch (e: any) {
      setDonateState("error");
      setDonateMsg(e?.message || String(e));
    }
  }

  const handleClose = useCallback(() => {
    onClose();
    if (reloadNeeded) window.location.reload();
  }, [onClose, reloadNeeded]);

  function addBoard() {
    if (shouldReloadForNavigation()) return;
    const name = newBoardName.trim();
    if (!name) return;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(name)) {
      onJoinBoard(name);
      setNewBoardName("");
      return;
    }
    const id = crypto.randomUUID();
    let board: Board;
    if (newBoardType === "compound") {
      board = {
        id,
        name,
        kind: "compound",
        children: [],
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
        hideChildBoardNames: false,
      };
    } else {
      board = {
        id,
        name,
        kind: "lists",
        columns: [{ id: crypto.randomUUID(), name: "List 1" }],
        archived: false,
        hidden: false,
        clearCompletedDisabled: false,
        indexCardEnabled: false,
      };
    }
    setBoards(prev => [...prev, board]);
    setNewBoardName("");
    changeBoard(id);
    setNewBoardType("lists");
  }

  function renameBoard(id: string, name: string) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(x => {
      if (x.id !== id) return x;
      const nb = { ...x, name };
      if (nb.nostr) setTimeout(() => onBoardChanged(id, { board: nb }), 0);
      return nb;
    }));
  }

  function archiveBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const board = boards.find(x => x.id === id);
    if (!board || board.archived) return;
    const remainingUnarchived = boards.filter(b => b.id !== id && !b.archived);
    if (remainingUnarchived.length === 0) {
      alert("At least one board must remain unarchived.");
      return;
    }
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: true } : b));
    if (currentBoardId === id) {
      const nextVisible = boards.find(b => b.id !== id && !b.archived && !b.hidden);
      const fallback = remainingUnarchived[0];
      changeBoard((nextVisible ?? fallback)?.id || "");
    }
    if (manageBoardId === id) setManageBoardId(null);
  }

  function setBoardHidden(id: string, hidden: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => (b.id === id ? { ...b, hidden } : b)));
  }

  function setBoardClearCompletedDisabled(id: string, disabled: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => {
      if (b.id !== id) return b;
      const nb = { ...b, clearCompletedDisabled: disabled };
      if (nb.nostr) setTimeout(() => onBoardChanged(id, { board: nb }), 0);
      return nb;
    }));
  }

  function setBoardIndexCardEnabled(id: string, enabled: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== id) return b;
      if (!isListLikeBoard(b)) return b;
      const nb = { ...b, indexCardEnabled: enabled } as Board;
      updated = nb;
      return nb;
    }));
    if (updated?.nostr) setTimeout(() => onBoardChanged(id, { board: updated! }), 0);
  }

  function setCompoundBoardHideChildNames(id: string, hidden: boolean) {
    if (id === BIBLE_BOARD_ID) return;
    let updated: Board | null = null;
    setBoards((prev) =>
      prev.map((b) => {
        if (b.id !== id || b.kind !== "compound") return b;
        const nb: Board = { ...b, hideChildBoardNames: hidden };
        updated = nb;
        return nb;
      }),
    );
    if (updated?.nostr) setTimeout(() => onBoardChanged(id, { board: updated! }), 0);
  }

  function openHiddenBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const board = boards.find(x => x.id === id && !x.archived && x.hidden);
    if (!board) return;
    changeBoard(id);
    setManageBoardId(null);
    handleClose();
  }

  function openArchivedBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const board = boards.find(x => x.id === id && x.archived);
    if (!board) return;
    changeBoard(id);
    setShowArchivedBoards(false);
    handleClose();
  }

  function unarchiveBoard(id: string) {
    if (id === BIBLE_BOARD_ID) return;
    setBoards(prev => prev.map(b => b.id === id ? { ...b, archived: false } : b));
  }

  function deleteBoard(id: string) {
    if (shouldReloadForNavigation()) return;
    if (id === BIBLE_BOARD_ID) return;
    const b = boards.find(x => x.id === id);
    if (!b) return;
    if (!confirm(`Delete board “${b.name}”? This will also remove its tasks.`)) return;
    const updatedCompounds: Board[] = [];
    setBoards(prev => {
      const filtered = prev.filter(x => x.id !== id);
      const cleaned = filtered.map((board) => {
        if (board.kind !== "compound" || !b) return board;
        const remainingChildren = board.children.filter((child) => !compoundChildMatchesBoard(child, b));
        if (remainingChildren.length === board.children.length) return board;
        const nb: Board = { ...board, children: remainingChildren };
        if (nb.nostr) updatedCompounds.push(nb);
        return nb;
      });
      if (currentBoardId === id) {
        const newId = cleaned[0]?.id || "";
        changeBoard(newId);
      }
      return cleaned;
    });
    updatedCompounds.forEach((board) => {
      setTimeout(() => onBoardChanged(board.id, { board }), 0);
    });
    setTasks(prev => prev.filter(t => t.boardId !== id));
    if (manageBoardId === id) setManageBoardId(null);
  }

  function reorderBoards(dragId: string, targetId: string, before: boolean) {
    setBoards(prev => {
      const list = [...prev];
      const fromIndex = list.findIndex(b => b.id === dragId);
      if (fromIndex === -1) return prev;
      const [item] = list.splice(fromIndex, 1);
      let targetIndex = list.findIndex(b => b.id === targetId);
      if (targetIndex === -1) return prev;
      if (!before) targetIndex++;
      list.splice(targetIndex, 0, item);
      return list;
    });
  }

  function addColumn(boardId: string, name?: string): string | null {
    const requestedName = typeof name === "string" ? name.trim() : "";
    let createdId: string | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const colName = requestedName || `List ${b.columns.length + 1}`;
      const col: ListColumn = { id: crypto.randomUUID(), name: colName };
      createdId = col.id;
      const nb = { ...b, columns: [...b.columns, col] } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
    return createdId;
  }

  function renameColumn(boardId: string, colId: string) {
    const name = prompt("Rename list");
    if (name == null) return;
    const nn = name.trim();
    if (!nn) return;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const nb = { ...b, columns: b.columns.map(c => c.id === colId ? { ...c, name: nn } : c) } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
  }

  function deleteColumn(boardId: string, colId: string) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const nb = { ...b, columns: b.columns.filter(c => c.id !== colId) } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
  }

  function reorderColumn(boardId: string, dragId: string, targetId: string, before: boolean) {
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "lists") return b;
      const cols = [...b.columns];
      const fromIndex = cols.findIndex(c => c.id === dragId);
      if (fromIndex === -1) return b;
      const [col] = cols.splice(fromIndex, 1);
      let targetIndex = cols.findIndex(c => c.id === targetId);
      if (targetIndex === -1) return b;
      if (!before) targetIndex++;
      cols.splice(targetIndex, 0, col);
      const nb = { ...b, columns: cols } as Board;
      setTimeout(() => { if (nb.nostr) onBoardChanged(boardId, { board: nb }); }, 0);
      return nb;
    }));
  }

  function addCompoundChild(boardId: string, childIdRaw: string) {
    const { boardId: rawChildId, relays } = parseCompoundChildInput(childIdRaw);
    const childId = rawChildId.trim();
    if (!childId) return;
    let updated: Board | null = null;
    let blocked: "self" | "duplicate" | "unsupported" | null = null;
    let addedStub = false;
    setBoards(prev => {
      const parentBoard = prev.find((board) => board.id === boardId && board.kind === "compound");
      if (!parentBoard) return prev;

      const parentCanonical = normalizeCompoundChildId(prev, boardId);
      const resolvedChildId = normalizeCompoundChildId(prev, childId);
      if (resolvedChildId === parentCanonical) {
        blocked = "self";
        return prev;
      }

      let working = prev;
      let targetBoard = findBoardByCompoundChildId(prev, resolvedChildId);

      if (targetBoard && targetBoard.kind !== "lists") {
        blocked = "unsupported";
        return prev;
      }

      if (!targetBoard) {
        const relayList = relays.length
          ? Array.from(new Set(relays))
          : Array.from(new Set(defaultRelays));
        const stub: Board = {
          id: resolvedChildId,
          name: "Linked board",
          kind: "lists",
          columns: [{ id: crypto.randomUUID(), name: "Items" }],
          nostr: { boardId: resolvedChildId, relays: relayList },
          archived: true,
          hidden: true,
          clearCompletedDisabled: false,
          indexCardEnabled: false,
        };
        working = [...prev, stub];
        targetBoard = stub;
        addedStub = true;
      } else if (relays.length && targetBoard.nostr) {
        const relayList = Array.from(new Set(relays));
        const existingRelays = targetBoard.nostr.relays || [];
        const sameRelays = relayList.length === existingRelays.length
          && relayList.every((relay, idx) => relay === existingRelays[idx]);
        if (!sameRelays) {
          const updatedBoard: Board = {
            ...targetBoard,
            nostr: { ...targetBoard.nostr, relays: relayList },
          } as Board;
          working = prev.map((board) => (board.id === targetBoard!.id ? updatedBoard : board));
          targetBoard = updatedBoard;
        }
      }

      const latestParent = working.find((board) => board.id === boardId && board.kind === "compound");
      if (!latestParent) return working;

      const alreadyAdded = latestParent.children.some((existingId) => {
        const normalizedExisting = normalizeCompoundChildId(working, existingId);
        return normalizedExisting === resolvedChildId;
      });
      if (alreadyAdded) {
        blocked = "duplicate";
        return working;
      }

      const nb: Board = { ...latestParent, children: [...latestParent.children, resolvedChildId] };
      updated = nb;
      return working.map((board) => {
        if (board.id === boardId && board.kind === "compound") return nb;
        return board;
      });
    });
    if (blocked === "self") {
      showToast("Cannot include a board within itself.");
    } else if (blocked === "duplicate") {
      showToast("Board already added.");
    } else if (blocked === "unsupported") {
      showToast("Only list boards can be added to a compound board.");
    } else if (addedStub) {
      showToast("Linked shared board. Columns will load automatically.");
    }
    if (updated?.nostr) setTimeout(() => onBoardChanged(boardId, { board: updated! }), 0);
  }

  function removeCompoundChild(boardId: string, childId: string) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "compound") return b;
      const targetId = normalizeCompoundChildId(prev, childId);
      const remaining = b.children.filter((id) => normalizeCompoundChildId(prev, id) !== targetId);
      if (remaining.length === b.children.length) return b;
      const nb: Board = { ...b, children: remaining };
      updated = nb;
      return nb;
    }));
    if (updated?.nostr) setTimeout(() => onBoardChanged(boardId, { board: updated! }), 0);
  }

  function reorderCompoundChild(boardId: string, dragId: string, targetId: string, before: boolean) {
    let updated: Board | null = null;
    setBoards(prev => prev.map(b => {
      if (b.id !== boardId || b.kind !== "compound") return b;
      if (dragId === targetId) return b;
      const children = [...b.children];
      const fromIndex = children.indexOf(dragId);
      const targetIndex = children.indexOf(targetId);
      if (fromIndex === -1 || targetIndex === -1) return b;
      const [item] = children.splice(fromIndex, 1);
      const insertIndex = before ? targetIndex : targetIndex + 1;
      children.splice(insertIndex, 0, item);
      const nb: Board = { ...b, children };
      updated = nb;
      return nb;
    }));
    if (updated?.nostr) setTimeout(() => onBoardChanged(boardId, { board: updated! }), 0);
  }

  function HiddenBoardIcon() {
    return (
      <svg
        className="w-4 h-4 text-secondary"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z" />
        <path d="M3 3l18 18" />
      </svg>
    );
  }

  function BoardListItem({
    board,
    hidden,
    onPrimaryAction,
    onDrop,
    onEdit,
  }: {
    board: Board;
    hidden: boolean;
    onPrimaryAction: () => void;
    onDrop: (dragId: string, before: boolean) => void;
    onEdit?: () => void;
  }) {
    const [overBefore, setOverBefore] = useState(false);
    const [dragging, setDragging] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/board-id", board.id);
      e.dataTransfer.effectAllowed = "move";
      setDragging(true);
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/board-id");
      if (dragId) onDrop(dragId, overBefore);
      setOverBefore(false);
      setDragging(false);
    }
    function handleDragLeave() {
      setOverBefore(false);
    }
    function handleDragEnd() {
      setDragging(false);
      setOverBefore(false);
    }
    function handleClick() {
      if (dragging) return;
      onPrimaryAction();
    }
    const buttonClasses = hidden
      ? "flex-1 text-left min-w-0 text-secondary hover:text-primary transition-colors"
      : "flex-1 text-left min-w-0";
    return (
      <li
        className="board-list-item"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
        onDragEnd={handleDragEnd}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <button type="button" className={buttonClasses} onClick={handleClick}>
          <span className="flex items-center gap-2">
            {hidden && (
              <span className="shrink-0" aria-hidden="true">
                <HiddenBoardIcon />
              </span>
            )}
            <span className="truncate">{board.name}</span>
            {hidden && <span className="sr-only">Hidden board</span>}
          </span>
        </button>
        {hidden && onEdit && (
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragging) return;
              onEdit();
            }}
          >
            Edit
          </button>
        )}
      </li>
    );
  }

  function ColumnItem({ boardId, column }: { boardId: string; column: ListColumn }) {
    const [overBefore, setOverBefore] = useState(false);
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/column-id", column.id);
      e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const dragId = e.dataTransfer.getData("text/column-id");
      if (dragId) reorderColumn(boardId, dragId, column.id, overBefore);
      setOverBefore(false);
    }
    function handleDragLeave() { setOverBefore(false); }
    return (
      <li
        className="relative p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <div className="flex-1">{column.name}</div>
        <div className="flex gap-1">
          <button className="ghost-button button-sm pressable" onClick={()=>renameColumn(boardId, column.id)}>Rename</button>
          <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>deleteColumn(boardId, column.id)}>Delete</button>
        </div>
      </li>
    );
  }

  function CompoundChildItem({ parentId, childId }: { parentId: string; childId: string }) {
    const [overBefore, setOverBefore] = useState(false);
    const childBoard = findBoardByCompoundChildId(boards, childId) || null;
    function handleDragStart(e: React.DragEvent) {
      e.dataTransfer.setData("text/compound-child", JSON.stringify({ boardId: parentId, childId }));
      e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLLIElement).getBoundingClientRect();
      const midpoint = rect.top + rect.height / 2;
      setOverBefore(e.clientY < midpoint);
    }
    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      const raw = e.dataTransfer.getData("text/compound-child");
      try {
        const payload = JSON.parse(raw);
        if (payload?.boardId === parentId && typeof payload?.childId === "string") {
          reorderCompoundChild(parentId, payload.childId, childId, overBefore);
        }
      } catch {}
      setOverBefore(false);
    }
    function handleDragLeave() { setOverBefore(false); }
    const name = childBoard ? childBoard.name : "Unknown board";
    const idLabel = childBoard?.nostr?.boardId || childBoard?.id || childId;
    return (
      <li
        className="relative p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2"
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {overBefore && (
          <div className="absolute -top-[0.125rem] left-0 right-0 h-[0.1875rem] rounded-full" style={{ background: "var(--accent)" }} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-primary truncate">{name}</div>
          <div className="text-xs text-secondary break-all">{idLabel}</div>
        </div>
        <div className="flex gap-1">
          <button
            className="ghost-button button-sm pressable"
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(idLabel);
                showToast("Copied board ID");
              } catch {
                showToast("Unable to copy board ID");
              }
            }}
            title="Copy board ID"
            aria-label="Copy board ID"
          >
            Copy ID
          </button>
          <button className="ghost-button button-sm pressable text-rose-400" onClick={() => removeCompoundChild(parentId, childId)}>Remove</button>
        </div>
      </li>
    );
  }

  function isBoardDrag(event: React.DragEvent) {
    return Array.from(event.dataTransfer.types).includes("text/board-id");
  }

  function handleArchiveButtonDragEnter(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    setArchiveDropActive(true);
  }

  function handleArchiveButtonDragOver(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setArchiveDropActive(true);
  }

  function handleArchiveButtonDragLeave() {
    setArchiveDropActive(false);
  }

  function handleArchiveButtonDrop(e: React.DragEvent<HTMLButtonElement>) {
    if (!isBoardDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setArchiveDropActive(false);
    const id = e.dataTransfer.getData("text/board-id");
    if (id) archiveBoard(id);
  }

  return (
    <>
    <Modal onClose={handleClose} title="Settings">
      <div className="space-y-2">

        {/* Boards & Columns */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Boards & Lists</div>
          </div>
          <ul
            ref={boardListRef}
            className="space-y-2 mb-3 overflow-y-auto pr-1"
            style={boardListMaxHeight != null ? { maxHeight: `${boardListMaxHeight}px` } : undefined}
          >
            {unarchivedBoards.map((b) => (
              <BoardListItem
                key={b.id}
                board={b}
                hidden={!!b.hidden}
                onPrimaryAction={
                  b.kind === "bible"
                    ? () => {}
                    : b.hidden
                      ? () => openHiddenBoard(b.id)
                      : () => setManageBoardId(b.id)
                }
                onEdit={b.hidden && b.kind !== "bible" ? () => setManageBoardId(b.id) : undefined}
                onDrop={(dragId, before) => reorderBoards(dragId, b.id, before)}
              />
            ))}
          </ul>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <input
              value={newBoardName}
              onChange={e=>setNewBoardName(e.target.value)}
              placeholder="Board name or ID"
              className="pill-input flex-1 min-w-0"
            />
            <button
              className="accent-button pressable shrink-0 sm:self-stretch"
              onClick={addBoard}
            >
              Create/Join
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <button
              className={`pressable px-3 py-2 rounded-xl bg-surface-muted transition ${archiveDropActive ? "ring-2 ring-emerald-500" : ""}`}
              onClick={() => setShowArchivedBoards(true)}
              onDragEnter={handleArchiveButtonDragEnter}
              onDragOver={handleArchiveButtonDragOver}
              onDragLeave={handleArchiveButtonDragLeave}
              onDrop={handleArchiveButtonDrop}
            >
              Archived
            </button>
            <label className="flex items-center gap-2 text-xs text-secondary">
              <input
                type="checkbox"
                checked={newBoardType === "compound"}
                onChange={(e) => setNewBoardType(e.target.checked ? "compound" : "lists")}
                className="h-4 w-4"
              />
              Create as compound board
            </label>
          </div>
        </section>

        {/* View */}
        <section className="wallet-section space-y-3">
          <button
            className="flex w-full items-center gap-2 mb-3 text-left"
            onClick={() => setViewExpanded((prev) => !prev)}
            aria-expanded={viewExpanded}
          >
            <div className="text-sm font-medium flex-1">View</div>
            <span className="text-xs text-tertiary">{viewExpanded ? "Hide" : "Show"}</span>
            <span className="text-tertiary">{viewExpanded ? "−" : "+"}</span>
          </button>
          {viewExpanded && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium mb-2">Add new tasks to</div>
                <div className="flex gap-2">
                  <button className={pillButtonClass(settings.newTaskPosition === 'top')} onClick={() => setSettings({ newTaskPosition: 'top' })}>Top</button>
                  <button className={pillButtonClass(settings.newTaskPosition === 'bottom')} onClick={() => setSettings({ newTaskPosition: 'bottom' })}>Bottom</button>
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Background</div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    className="accent-button button-sm pressable"
                    onClick={() => backgroundInputRef.current?.click()}
                  >
                    Upload image
                  </button>
                  {settings.backgroundImage && (
                    <button
                      className="ghost-button button-sm pressable"
                      onClick={clearBackgroundImage}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={backgroundInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
                    handleBackgroundImageSelection(file);
                    event.currentTarget.value = "";
                  }}
                />
                <div className="text-xs text-secondary mt-2">Upload a photo to replace the gradient background. Taskify blurs it and matches the accent color automatically.</div>
                {settings.backgroundImage && (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative w-16 h-12 overflow-hidden rounded-xl border border-surface bg-surface-muted">
                        <div
                          className="absolute inset-0"
                          style={{
                            backgroundImage: `url(${settings.backgroundImage})`,
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                          }}
                        />
                      </div>
                      {settings.backgroundAccent && backgroundAccentHex && (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">
                          <span className="inline-flex items-center gap-1 rounded-full border border-surface bg-surface-muted px-2 py-1">
                            <span
                              className="w-3 h-3 rounded-full"
                              style={{
                                background: settings.backgroundAccent.fill,
                                border: '1px solid rgba(255, 255, 255, 0.35)',
                              }}
                            />
                            <span>{backgroundAccentHex}</span>
                          </span>
                          <span>{settings.accent === 'background' ? 'Accent follows the photo color you picked.' : 'Pick a photo accent below to sync buttons and badges.'}</span>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-secondary mb-1">Background clarity</div>
                      <div className="flex gap-2">
                        <button
                          className={pillButtonClass(settings.backgroundBlur !== 'sharp')}
                          onClick={() => setSettings({ backgroundBlur: 'blurred' })}
                        >
                          Blurred
                        </button>
                        <button
                          className={pillButtonClass(settings.backgroundBlur === 'sharp')}
                          onClick={() => setSettings({ backgroundBlur: 'sharp' })}
                        >
                          Sharp
                        </button>
                      </div>
                      <div className="text-xs text-secondary mt-2">Blur softens distractions; Sharp keeps the photo crisp behind your boards.</div>
                    </div>
                  </div>
                )}
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Accent color</div>
                <div className="flex flex-wrap gap-3">
                  {ACCENT_CHOICES.map((choice) => {
                    const active = settings.accent === choice.id;
                    return (
                      <button
                        key={choice.id}
                        type="button"
                        className={`accent-swatch pressable ${active ? 'accent-swatch--active' : ''}`}
                        style={{
                          "--swatch-color": choice.fill,
                          "--swatch-ring": choice.ring,
                          "--swatch-border": choice.border,
                          "--swatch-border-active": choice.borderActive,
                          "--swatch-shadow": choice.shadow,
                          "--swatch-active-shadow": choice.shadowActive,
                        } as React.CSSProperties}
                        aria-label={choice.label}
                        aria-pressed={active}
                        onClick={() => setSettings({ accent: choice.id })}
                      >
                        <span className="sr-only">{choice.label}</span>
                      </button>
                    );
                  })}
                </div>
                {photoAccents.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-secondary uppercase tracking-[0.12em]">Photo accents</div>
                    <div className="flex flex-wrap gap-3">
                      {photoAccents.map((palette, index) => {
                        const active = settings.accent === 'background' && settings.backgroundAccentIndex === index;
                        return (
                          <button
                            key={`photo-accent-${index}`}
                            type="button"
                            className={`accent-swatch pressable ${active ? 'accent-swatch--active' : ''}`}
                            style={{
                              "--swatch-color": palette.fill,
                              "--swatch-ring": palette.ring,
                              "--swatch-border": palette.border,
                              "--swatch-border-active": palette.borderActive,
                              "--swatch-shadow": palette.shadow,
                              "--swatch-active-shadow": palette.shadowActive,
                            } as React.CSSProperties}
                            aria-label={`Photo accent ${index + 1}`}
                            aria-pressed={active}
                            onClick={() => handleSelectPhotoAccent(index)}
                          >
                            <span className="sr-only">Photo accent {index + 1}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="text-xs text-secondary mt-2">
                  {photoAccents.length > 0
                    ? settings.accent === 'background'
                      ? 'Buttons, badges, and focus states now use the photo accent you chose.'
                      : 'Choose one of your photo accents above or stick with the presets.'
                    : 'Switch the highlight color used across buttons, badges, and focus states.'}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Open app to</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.startupView === "main")}
                    onClick={() => setSettings({ startupView: "main" })}
                  >
                    Main view
                  </button>
                  <button
                    className={pillButtonClass(settings.startupView === "wallet")}
                    onClick={() => setSettings({ startupView: "wallet" })}
                  >
                    Wallet
                  </button>
                </div>
                <div className="text-xs text-secondary mt-2">Choose whether Taskify launches to your boards or directly into the wallet.</div>
              </div>
              <div className="space-y-4 pt-4 border-t border-neutral-800">
                <div>
                  <div className="text-sm font-medium mb-2">Font size</div>
                  <div className="flex flex-wrap gap-1">
                    <button className={`${pillButtonClass(settings.baseFontSize == null)} button-xs`} onClick={() => setSettings({ baseFontSize: null })}>System</button>
                    <button className={`${pillButtonClass(settings.baseFontSize === 14)} button-xs`} onClick={() => setSettings({baseFontSize: 14 })}>Sm</button>
                    <button className={`${pillButtonClass(settings.baseFontSize === 20)} button-xs`} onClick={() => setSettings({baseFontSize: 20 })}>Lg</button>
                    <button className={`${pillButtonClass(settings.baseFontSize === 22)} button-xs`} onClick={() => setSettings({baseFontSize: 22 })}>X-Lg</button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Scales the entire UI. Defaults to a compact size.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Hide completed subtasks</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.hideCompletedSubtasks)}
                      onClick={() => setSettings({ hideCompletedSubtasks: !settings.hideCompletedSubtasks })}
                    >
                      {settings.hideCompletedSubtasks ? "On" : "Off"}
                    </button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Keep finished subtasks out of cards. Open Edit to review them later.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Add tasks within lists</div>
                  <div className="flex gap-2">
                    <button className={pillButtonClass(settings.inlineAdd)} onClick={() => setSettings({ inlineAdd: true })}>Inline</button>
                    <button className={pillButtonClass(!settings.inlineAdd)} onClick={() => setSettings({ inlineAdd: false })}>Top bar</button>
                  </div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Add lists from task view</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.listAddButtonEnabled)}
                      onClick={() => setSettings({ listAddButtonEnabled: true })}
                    >
                      Show
                    </button>
                    <button
                      className={pillButtonClass(!settings.listAddButtonEnabled)}
                      onClick={() => setSettings({ listAddButtonEnabled: false })}
                    >
                      Hide
                    </button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Place an Add list button beside your board columns.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Week starts on</div>
                  <div className="flex gap-2">
                    <button className={pillButtonClass(settings.weekStart === 6)} onClick={() => setSettings({ weekStart: 6 })}>Saturday</button>
                    <button className={pillButtonClass(settings.weekStart === 0)} onClick={() => setSettings({ weekStart: 0 })}>Sunday</button>
                    <button className={pillButtonClass(settings.weekStart === 1)} onClick={() => setSettings({ weekStart: 1 })}>Monday</button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Affects when weekly recurring tasks re-appear.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Show full week for recurring tasks</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.showFullWeekRecurring)}
                      onClick={() => setSettings({ showFullWeekRecurring: !settings.showFullWeekRecurring })}
                    >
                      {settings.showFullWeekRecurring ? "On" : "Off"}
                    </button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Display all occurrences for the current week at once.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Completed tab</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.completedTab)}
                      onClick={() => setSettings({ completedTab: !settings.completedTab })}
                    >
                      {settings.completedTab ? "On" : "Off"}
                    </button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Hide the completed tab and show a Clear completed button instead.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Streaks</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.streaksEnabled)}
                      onClick={() => setSettings({ streaksEnabled: !settings.streaksEnabled })}
                    >
                      {settings.streaksEnabled ? "On" : "Off"}
                    </button>
                  </div>
                  <div className="text-xs text-secondary mt-2">Track consecutive completions on recurring tasks.</div>
                </div>
                <div>
                  <div className="text-sm font-medium mb-2">Board on app start</div>
                  <div className="space-y-2">
                    {WD_FULL.map((label, idx) => (
                      <div key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                        <div className="text-xs uppercase tracking-wide text-secondary sm:w-28">{label}</div>
                        <select
                          className="pill-input flex-1"
                          value={settings.startBoardByDay[idx as Weekday] ?? ""}
                          onChange={(e) => handleDailyStartBoardChange(idx as Weekday, e.target.value)}
                        >
                          <option value="">Default (first visible)</option>
                          {visibleBoards.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                  <div className="text-xs text-secondary mt-2">
                    Choose which board opens first for each day. Perfect for work boards on weekdays and personal lists on weekends.
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Wallet */}
        <section className="wallet-section space-y-3">
          <button
            className="flex w-full items-center gap-2 mb-3 text-left"
            onClick={() => setWalletExpanded((prev) => !prev)}
            aria-expanded={walletExpanded}
          >
            <div className="text-sm font-medium flex-1">Wallet</div>
            <span className="text-xs text-tertiary">{walletExpanded ? "Hide" : "Show"}</span>
            <span className="text-tertiary">{walletExpanded ? "−" : "+"}</span>
          </button>
          {walletExpanded && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium mb-2">Currency conversion</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletConversionEnabled)}
                    onClick={() => setSettings({ walletConversionEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletConversionEnabled)}
                    onClick={() => setSettings({ walletConversionEnabled: false, walletPrimaryCurrency: "sat" })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">Show USD equivalents by fetching spot BTC prices from Coinbase.</div>
              </div>
              {settings.walletConversionEnabled && (
                <div>
                  <div className="text-sm font-medium mb-2">Primary display</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.walletPrimaryCurrency === "sat")}
                      onClick={() => setSettings({ walletPrimaryCurrency: "sat" })}
                    >Sats</button>
                    <button
                      className={pillButtonClass(settings.walletPrimaryCurrency === "usd")}
                      onClick={() => setSettings({ walletPrimaryCurrency: "usd" })}
                    >USD</button>
                  </div>
                  <div className="text-xs text-secondary mt-2">You can also tap the unit label in the wallet header to toggle.</div>
                </div>
              )}
              <div>
                <div className="text-sm font-medium mb-2">npub.cash lightning address</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.npubCashLightningAddressEnabled)}
                    onClick={() => setSettings({ npubCashLightningAddressEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.npubCashLightningAddressEnabled)}
                    onClick={() => setSettings({ npubCashLightningAddressEnabled: false, npubCashAutoClaim: false })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  Share a lightning address powered by npub.cash using your Taskify Nostr keys.
                </div>
              </div>
              {settings.npubCashLightningAddressEnabled && (
                <div>
                  <div className="text-sm font-medium mb-2">Auto-claim npub.cash eCash</div>
                  <div className="flex gap-2">
                    <button
                      className={pillButtonClass(settings.npubCashAutoClaim)}
                      onClick={() => setSettings({ npubCashAutoClaim: true })}
                    >On</button>
                    <button
                      className={pillButtonClass(!settings.npubCashAutoClaim)}
                      onClick={() => setSettings({ npubCashAutoClaim: false })}
                    >Off</button>
                  </div>
                  <div className="text-xs text-secondary mt-2">
                    Automatically claim pending npub.cash tokens each time the wallet opens.
                  </div>
                </div>
              )}
              <div>
                <div className="text-sm font-medium mb-2">Wallet seed backup (NUT-13)</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={`${walletSeedVisible ? "ghost-button" : "accent-button"} button-sm pressable`}
                    onClick={handleToggleWalletSeed}
                  >
                    {walletSeedVisible ? "Hide words" : "Show words"}
                  </button>
                  <button className="ghost-button button-sm pressable" onClick={handleCopyWalletSeed}>
                    Copy seed
                  </button>
                  <button className="ghost-button button-sm pressable" onClick={handleDownloadWalletSeed}>
                    Save backup file
                  </button>
                </div>
                {walletSeedVisible && walletSeedWords && (
                  <div className="mt-2 p-3 rounded-lg border border-surface bg-surface-muted text-xs font-mono leading-relaxed break-words select-text">
                    {walletSeedWords}
                  </div>
                )}
                {walletSeedError && <div className="text-xs text-rose-400 mt-2">{walletSeedError}</div>}
                <div className="text-xs text-secondary mt-2">
                  Save these 12 words in a secure place. The exported file also includes deterministic counters for each mint so you can restore your Cashu wallet elsewhere.
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Background token state checks</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletSentStateChecksEnabled)}
                    onClick={() => setSettings({ walletSentStateChecksEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletSentStateChecksEnabled)}
                    onClick={() => setSettings({ walletSentStateChecksEnabled: false })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  Periodically check supported mints for the status of sent eCash proofs and alert when a payment is received.
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Reset sent token tracking</div>
                <div className="flex gap-2">
                  <button
                    className="ghost-button button-sm pressable text-rose-400"
                    onClick={() => {
                      const confirmed = window.confirm(
                        "Reset background tracking for sent tokens? This clears stored proof subscriptions so Taskify stops retrying old requests.",
                      );
                      if (!confirmed) return;
                      onResetWalletTokenTracking();
                    }}
                  >Reset tracking</button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  Clears stored proof subscriptions so old eCash tokens stop retrying status updates.
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Payment requests (NUT-18)</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.walletPaymentRequestsEnabled)}
                    onClick={() => setSettings({ walletPaymentRequestsEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.walletPaymentRequestsEnabled)}
                    onClick={() => setSettings({
                      walletPaymentRequestsEnabled: false,
                      walletPaymentRequestsBackgroundChecksEnabled: false,
                    })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  Create Cashu payment requests and share them over Nostr for others to fund.
                </div>
              </div>
              {settings.walletPaymentRequestsEnabled && (
                <>
                  <div>
                    <div className="text-sm font-medium mb-2">Background Nostr checks</div>
                    <div className="flex gap-2">
                      <button
                        className={pillButtonClass(settings.walletPaymentRequestsBackgroundChecksEnabled)}
                        onClick={() => setSettings({ walletPaymentRequestsBackgroundChecksEnabled: true })}
                      >On</button>
                      <button
                        className={pillButtonClass(!settings.walletPaymentRequestsBackgroundChecksEnabled)}
                        onClick={() => setSettings({ walletPaymentRequestsBackgroundChecksEnabled: false })}
                      >Off</button>
                    </div>
                    <div className="text-xs text-secondary mt-2">
                      Poll every minute for paid requests even when the wallet is closed.
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-2">Recipients (P2PK)</div>
                    <div className="text-xs text-secondary">Add lock keys to require recipients to prove control before spending.</div>
                    <div className="flex flex-wrap gap-2 text-xs mt-2">
                      <button
                        className="accent-button button-sm pressable"
                        onClick={() => {
                          handleGenerateP2pkKey();
                        }}
                      >
                        Generate key
                      </button>
                      <button
                        className="ghost-button button-sm pressable"
                        onClick={() => {
                          setP2pkImportVisible((prev) => !prev);
                          setP2pkImportError("");
                        }}
                        aria-expanded={p2pkImportVisible}
                      >
                        {p2pkImportVisible ? "Hide import" : "Import nsec"}
                      </button>
                    </div>
                    {p2pkImportVisible && (
                      <div className="mt-2 space-y-2">
                        <input
                          className="pill-input text-xs"
                          placeholder="nsec1... or 64-hex secret key"
                          value={p2pkImportValue}
                          onChange={(e) => setP2pkImportValue(e.target.value)}
                        />
                        <input
                          className="pill-input text-xs"
                          placeholder="Label (optional)"
                          value={p2pkImportLabel}
                          onChange={(e) => setP2pkImportLabel(e.target.value)}
                        />
                        {p2pkImportError && <div className="text-[11px] text-rose-500">{p2pkImportError}</div>}
                        <div className="flex flex-wrap gap-2 text-xs">
                          <button
                            className="accent-button button-sm pressable"
                            onClick={() => {
                              handleImportP2pkKey();
                            }}
                            disabled={!p2pkImportValue.trim()}
                          >
                            Import
                          </button>
                          <button
                            className="ghost-button button-sm pressable"
                            onClick={() => {
                              setP2pkImportVisible(false);
                              setP2pkImportValue("");
                              setP2pkImportLabel("");
                              setP2pkImportError("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    {sortedP2pkKeys.length ? (
                      <div className="mt-3 space-y-2">
                        <button
                          className="ghost-button button-sm pressable w-full justify-between"
                          onClick={() => setP2pkKeysExpanded((prev) => !prev)}
                          aria-expanded={p2pkKeysExpanded}
                        >
                          <span>
                            Browse {sortedP2pkKeys.length} key{sortedP2pkKeys.length === 1 ? "" : "s"}
                          </span>
                          <span className="text-tertiary">{p2pkKeysExpanded ? "−" : "+"}</span>
                        </button>
                        {p2pkKeysExpanded && (
                          <div className="space-y-2 max-h-60 overflow-auto pr-1">
                            {sortedP2pkKeys.map((key) => (
                              <div key={key.id} className="rounded-2xl border border-surface px-3 py-2 text-xs space-y-1">
                                <div className="flex items-center gap-2">
                                  <div className="font-medium text-primary flex-1">
                                    {key.label?.trim() || key.publicKey.slice(0, 12)}
                                  </div>
                                  {primaryP2pkKey?.id === key.id && <span className="text-[10px] text-accent">Default</span>}
                                </div>
                                <div className="break-all text-tertiary text-[11px]">{key.publicKey}</div>
                                <div className="text-[11px] text-secondary">
                                  Used {key.usedCount}×{key.lastUsedAt ? ` • Last ${new Date(key.lastUsedAt).toLocaleDateString()}` : ""}
                                </div>
                                <div className="flex flex-wrap gap-2 text-[11px] mt-1">
                                  <button
                                    className="ghost-button button-sm pressable"
                                    onClick={() => handleCopyP2pkKey(key.publicKey)}
                                  >
                                    Copy
                                  </button>
                                  {primaryP2pkKey?.id !== key.id && (
                                    <button
                                      className="ghost-button button-sm pressable"
                                      onClick={() => handleSetPrimaryP2pkKey(key)}
                                    >
                                      Set default
                                    </button>
                                  )}
                                  <button
                                    className="ghost-button button-sm pressable"
                                    onClick={() => handleRemoveP2pkKey(key)}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-secondary">
                        No P2PK keys yet. Generate or import one to lock tokens.
                      </div>
                    )}
                  </div>
                </>
              )}
              <div className="pt-3 border-t border-surface/30">
                <div className="flex items-center gap-2 mb-2">
                  <div className="text-sm font-medium flex-1">Advanced tools</div>
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={() => setWalletAdvancedVisible((prev) => !prev)}
                  >
                    {walletAdvancedVisible ? "Hide" : "Show"}
                  </button>
                </div>
                {walletAdvancedVisible && (
                  <div className="space-y-4">
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Generate new seed phrase</div>
                          <div className="text-xs text-secondary mt-1">
                            Replace your NUT-13 seed and reset keyset counters. Existing proofs stay untouched.
                          </div>
                        </div>
                        <button
                          className="ghost-button button-sm pressable shrink-0"
                          onClick={() => setShowNewSeedConfirm((prev) => !prev)}
                          aria-expanded={showNewSeedConfirm}
                        >
                          {showNewSeedConfirm ? "Cancel" : "Generate"}
                        </button>
                      </div>
                      {showNewSeedConfirm && (
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <div className="text-secondary flex-1 min-w-[200px]">
                            This immediately creates a completely new wallet seed. Save the words before reloading.
                          </div>
                          <button
                            className="ghost-button button-sm pressable"
                            onClick={() => setShowNewSeedConfirm(false)}
                          >
                            Never mind
                          </button>
                          <button
                            className="accent-button button-sm pressable"
                            onClick={handleRegenerateWalletSeed}
                          >
                            Confirm
                          </button>
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Remove spent proofs</div>
                          <div className="text-xs text-secondary mt-1">
                            Ask each mint which notes were already spent and remove them from local storage.
                          </div>
                        </div>
                        <button
                          className={`${removeSpentBusy ? "ghost-button" : "accent-button"} button-sm pressable shrink-0`}
                          onClick={handleRemoveSpentProofs}
                          disabled={removeSpentBusy}
                        >
                          {removeSpentBusy ? "Checking…" : "Scan"}
                        </button>
                      </div>
                      {removeSpentStatus && (
                        <div
                          className={`text-xs mt-2 ${
                            removeSpentStatus.type === "error" ? "text-rose-400" : "text-secondary"
                          }`}
                        >
                          {removeSpentStatus.message}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <div className="flex-1">
                          <div className="text-sm font-medium">Debug console</div>
                          <div className="text-xs text-secondary mt-1">
                            Load the in-app eruda console for troubleshooting on mobile browsers.
                          </div>
                        </div>
                        <button
                          className="ghost-button button-sm pressable shrink-0"
                          onClick={handleToggleDebugConsole}
                          disabled={debugConsoleState === "loading"}
                        >
                          {debugConsoleState === "active"
                            ? "Hide"
                            : debugConsoleState === "loading"
                              ? "Loading…"
                              : "Show"}
                        </button>
                      </div>
                      {debugConsoleMessage && (
                        <div className="text-xs text-rose-400 mt-2">{debugConsoleMessage}</div>
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-medium mb-1">Increment keyset counters</div>
                      <div className="text-xs text-secondary">
                        Tap a keyset ID to advance the derivation counter if you hit "outputs already signed".
                      </div>
                      {walletCounterDisplayEntries.length ? (
                        <div className="mt-2 space-y-3">
                          {walletCounterDisplayEntries.map(([mint, counters]) => (
                            <div key={mint} className="rounded-2xl border border-surface px-3 py-2 space-y-2">
                              <div className="text-xs font-medium text-tertiary">{shortMintLabel(mint)}</div>
                              <div className="flex flex-wrap gap-2">
                                {Object.entries(counters)
                                  .sort(([a], [b]) => a.localeCompare(b))
                                  .map(([keysetId, count]) => {
                                    const busyKey = `${mint}|${keysetId}`;
                                    return (
                                      <button
                                        key={`${mint}-${keysetId}`}
                                        className="ghost-button button-sm pressable text-xs"
                                        onClick={() => handleIncrementKeysetCounter(mint, keysetId)}
                                        disabled={keysetCounterBusy === busyKey}
                                      >
                                        {keysetId} • #{count}
                                      </button>
                                    );
                                  })}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs text-secondary mt-2">
                          Counters appear after you mint eCash with your Taskify seed.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* Bible */}
        <section className="wallet-section space-y-3">
          <button
            className="flex w-full items-center gap-2 mb-3 text-left"
            onClick={() => setBibleExpanded((prev) => !prev)}
            aria-expanded={bibleExpanded}
          >
            <div className="text-sm font-medium flex-1">Bible</div>
            <span className="text-xs text-tertiary">{bibleExpanded ? "Hide" : "Show"}</span>
            <span className="text-tertiary">{bibleExpanded ? "−" : "+"}</span>
          </button>
          {bibleExpanded && (
            <div className="space-y-4">
              <div>
                <div className="text-sm font-medium mb-2">Bible tracker</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.bibleTrackerEnabled)}
                    onClick={() => setSettings({ bibleTrackerEnabled: true })}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.bibleTrackerEnabled)}
                    onClick={() => setSettings({ bibleTrackerEnabled: false })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">Track your Bible reading, reset progress, and review archived snapshots.</div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Scripture memory</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.scriptureMemoryEnabled)}
                    onClick={() => {
                      const preferredBoardId =
                        settings.scriptureMemoryBoardId
                          || (currentBoard && currentBoard.kind !== "bible" ? currentBoard.id : defaultScriptureMemoryBoardId)
                          || null;
                      setSettings({
                        bibleTrackerEnabled: true,
                        scriptureMemoryEnabled: true,
                        scriptureMemoryBoardId: preferredBoardId,
                      });
                    }}
                  >On</button>
                  <button
                    className={pillButtonClass(!settings.scriptureMemoryEnabled)}
                    onClick={() => setSettings({ scriptureMemoryEnabled: false })}
                  >Off</button>
                </div>
                <div className="text-xs text-secondary mt-2">
                  Keep passages you&apos;re memorizing and let Taskify schedule gentle review reminders.
                </div>
              </div>
              {settings.scriptureMemoryEnabled && (
                <>
                  <div>
                    <div className="text-sm font-medium mb-2">Review board</div>
                    <select
                      value={settings.scriptureMemoryBoardId || ""}
                      onChange={(event) => setSettings({ scriptureMemoryBoardId: event.target.value || null })}
                      className="pill-select w-full"
                    >
                      <option value="">Select a board…</option>
                      {availableMemoryBoards.map((board) => (
                        <option key={board.id} value={board.id}>{board.name}</option>
                      ))}
                    </select>
                    <div className="text-xs text-secondary mt-2">
                      Scripture memory tasks will appear on this board.
                    </div>
                    {availableMemoryBoards.length === 0 && (
                      <div className="text-xs text-secondary mt-1">
                        Create a board (besides the Bible board) to receive scripture memory tasks.
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-2">Review frequency</div>
                    <select
                      value={settings.scriptureMemoryFrequency}
                      onChange={(event) =>
                        setSettings({ scriptureMemoryFrequency: event.target.value as ScriptureMemoryFrequency })
                      }
                      className="pill-select w-full"
                    >
                      {SCRIPTURE_MEMORY_FREQUENCIES.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                    <div className="text-xs text-secondary mt-2">
                      {SCRIPTURE_MEMORY_FREQUENCIES.find((opt) => opt.id === settings.scriptureMemoryFrequency)?.description}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm font-medium mb-2">Sort scriptures by</div>
                    <select
                      value={settings.scriptureMemorySort}
                      onChange={(event) =>
                        setSettings({ scriptureMemorySort: event.target.value as ScriptureMemorySort })
                      }
                      className="pill-select w-full"
                    >
                      {SCRIPTURE_MEMORY_SORTS.map((opt) => (
                        <option key={opt.id} value={opt.id}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {/* Push notifications */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Push notifications</div>
            <div className="ml-auto flex items-center gap-2">
              <span className={`text-xs ${pushPrefs.enabled ? 'text-emerald-400' : 'text-secondary'}`}>
                {pushPrefs.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <button
                className="ghost-button button-sm pressable"
                onClick={() => setShowPushAdvanced((v) => !v)}
              >
                {showPushAdvanced ? 'Hide advanced' : 'Advanced'}
              </button>
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                className={`${pushPrefs.enabled ? 'ghost-button' : 'accent-button'} button-sm pressable w-full sm:w-auto`}
                onClick={pushPrefs.enabled ? handleDisablePush : handleEnablePush}
                disabled={pushBusy || !pushSupported || !workerConfigured || !vapidConfigured}
              >
                {pushBusy ? 'Working…' : pushPrefs.enabled ? 'Disable push' : 'Enable push'}
              </button>
              {showPushAdvanced && (
                <div className="text-xs text-secondary sm:ml-auto">
                  Permission: {permissionLabel}
                </div>
              )}
            </div>
            {showPushAdvanced && (
              <>
                <div>
                  <div className="text-sm font-medium mb-2">Detected platform</div>
                  <div className="text-xs text-secondary">
                    {pushPrefs.platform === 'ios'
                      ? 'Using Apple Push Notification service (Safari / iOS / macOS).'
                      : 'Using the standard Web Push service (FCM-compatible browsers).'}
                  </div>
                </div>
                {!pushSupported && (
                  <div className="text-xs text-secondary">
                    {pushSupportHint}
                  </div>
                )}
                {(!workerConfigured || !vapidConfigured) && (
                  <div className="text-xs text-secondary">
                    Configure the Worker runtime (or set VITE_WORKER_BASE_URL and VITE_VAPID_PUBLIC_KEY) to enable push registration.
                  </div>
                )}
                {pushError && (
                  <div className="text-xs text-rose-400 break-words">{pushError}</div>
                )}
                {pushPrefs.enabled && pushPrefs.deviceId && (
                  <div className="text-xs text-secondary break-words">
                    Device ID: {pushPrefs.deviceId}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* Nostr */}
        <section className="wallet-section space-y-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-medium">Nostr</div>
            <div className="ml-auto" />
            <button
              className="ghost-button button-sm pressable"
              onClick={()=>setShowAdvanced(a=>!a)}
            >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
          </div>
          {/* Quick actions available outside Advanced */}
          <div className="mb-3 flex gap-2">
            <button
              className="ghost-button button-sm pressable"
              onClick={async ()=>{
                try {
                  const sk = localStorage.getItem(LS_NOSTR_SK) || "";
                  if (!sk) return;
                  let nsec = "";
                  try {
                    // Prefer nip19.nsecEncode when available
                    // @ts-expect-error - guard at runtime below
                    nsec = typeof (nip19 as any)?.nsecEncode === 'function' ? (nip19 as any).nsecEncode(sk) : sk;
                  } catch {
                    nsec = sk;
                  }
                  await navigator.clipboard?.writeText(nsec);
                } catch {}
              }}
            >Copy nsec</button>
            <button
              className="ghost-button button-sm pressable"
              onClick={()=>setDefaultRelays(DEFAULT_NOSTR_RELAYS.slice())}
            >Reload default relays</button>
          </div>
          {showAdvanced && (
            <>
              {/* Public key */}
              <div className="mb-3">
                <div className="text-xs text-secondary mb-1">Your Nostr public key (hex)</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={pubkeyHex || "(generating…)"}
                         className="pill-input flex-1"/>
                  <button className="ghost-button button-sm pressable" onClick={async ()=>{ if(pubkeyHex) { try { await navigator.clipboard?.writeText(pubkeyHex); } catch {} } }}>Copy</button>
                </div>
              </div>

              {/* Private key options */}
              <div className="mb-3 space-y-2">
                <div className="text-xs text-secondary mb-1">Custom Nostr private key (hex or nsec)</div>
                <div className="flex gap-2 items-center">
                  <input value={customSk} onChange={e=>setCustomSk(e.target.value)}
                         className="pill-input flex-1" placeholder="nsec or hex"/>
                  <button className="ghost-button button-sm pressable" onClick={()=>{onSetKey(customSk); setCustomSk('');}}>Use</button>
                </div>
                <div className="flex gap-2">
                  <button className="ghost-button button-sm pressable" onClick={onGenerateKey}>Generate new key</button>
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={async ()=>{
                      try {
                        const sk = localStorage.getItem(LS_NOSTR_SK) || "";
                        if (!sk) return;
                        let nsec = "";
                        try {
                          // Prefer nip19.nsecEncode when available
                          // @ts-expect-error - guard at runtime below
                          nsec = typeof (nip19 as any)?.nsecEncode === 'function' ? (nip19 as any).nsecEncode(sk) : sk;
                        } catch {
                          nsec = sk;
                        }
                        await navigator.clipboard?.writeText(nsec);
                      } catch {}
                    }}
                  >Copy private key (nsec)</button>
                </div>
              </div>

              {/* Default relays */}
              <div className="mb-3">
                <div className="text-xs text-secondary mb-1">Default relays</div>
                <div className="flex gap-2 mb-2">
                  <input
                    value={newDefaultRelay}
                    onChange={(e)=>setNewDefaultRelay(e.target.value)}
                    onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newDefaultRelay.trim(); if (v && !defaultRelays.includes(v)) { setDefaultRelays([...defaultRelays, v]); setNewDefaultRelay(""); } } }}
                    className="pill-input flex-1"
                    placeholder="wss://relay.example"
                  />
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={()=>{ const v = newDefaultRelay.trim(); if (v && !defaultRelays.includes(v)) { setDefaultRelays([...defaultRelays, v]); setNewDefaultRelay(""); } }}
                  >Add</button>
                </div>
                <ul className="space-y-2">
                  {defaultRelays.map((r) => (
                    <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                      <div className="flex-1 truncate">{r}</div>
                      <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>setDefaultRelays(defaultRelays.filter(x => x !== r))}>Delete</button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={()=>setDefaultRelays(DEFAULT_NOSTR_RELAYS.slice())}
                  >Reload defaults</button>
                </div>
              </div>
            </>
          )}
        </section>

        {/* Cashu mint: moved into Wallet → Mint balances */}

        {/* Backup & Restore */}
        <section className="wallet-section space-y-3">
          <button
            className="flex w-full items-center gap-2 mb-3 text-left"
            onClick={() => setBackupExpanded((prev) => !prev)}
            aria-expanded={backupExpanded}
          >
            <div className="text-sm font-medium flex-1">Backup</div>
            <span className="text-xs text-tertiary">{backupExpanded ? "Hide" : "Show"}</span>
            <span className="text-tertiary">{backupExpanded ? "−" : "+"}</span>
          </button>
          {backupExpanded ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button className="accent-button button-sm pressable flex-1" onClick={backupData}>Download backup</button>
                <label className="ghost-button button-sm pressable flex-1 justify-center cursor-pointer">
                  Restore from backup
                  <input type="file" accept="application/json" className="hidden" onChange={restoreFromBackup} />
                </label>
              </div>
              <div className="space-y-2">
                <div className="text-xs text-secondary">
                  Cloud backups sync daily when Taskify opens while automatic backups are enabled. You can also save a manual backup once per minute. Restore using your Nostr private key (nsec).
                </div>
                <div className="text-xs text-secondary">
                  Automatic daily cloud backups are currently {settings.cloudBackupsEnabled ? "enabled." : "disabled."}
                </div>
                {renderBackupButtons()}
                {cloudBackupState === "uploading" && (
                  <div className="text-xs text-secondary">Saving backup…</div>
                )}
                {cloudBackupState === "error" && cloudBackupMessage && (
                  <div className="text-xs text-rose-400">{cloudBackupMessage}</div>
                )}
                {cloudBackupState === "success" && cloudBackupMessage && (
                  <div className="text-xs text-accent">{cloudBackupMessage}</div>
                )}
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    className="pill-input flex-1"
                    placeholder="nsec or 64-hex private key"
                    value={cloudRestoreKey}
                    onChange={(e)=>{
                      setCloudRestoreKey(e.target.value);
                      setCloudRestoreState("idle");
                      setCloudRestoreMessage("");
                    }}
                  />
                  <button
                    className="accent-button button-sm pressable shrink-0"
                    onClick={handleRestoreFromCloud}
                    disabled={!workerBaseUrl || cloudRestoreState === "loading"}
                  >
                    {cloudRestoreState === "loading" ? "Restoring…" : "Restore from cloud"}
                  </button>
                </div>
                {cloudRestoreState === "loading" && (
                  <div className="text-xs text-secondary">Checking for backup…</div>
                )}
                {cloudRestoreState === "error" && cloudRestoreMessage && (
                  <div className="text-xs text-rose-400">{cloudRestoreMessage}</div>
                )}
                {cloudRestoreState === "success" && cloudRestoreMessage && (
                  <div className="text-xs text-accent">{cloudRestoreMessage}</div>
                )}
              </div>
            </div>
          ) : (
            renderBackupButtons()
          )}
        </section>

        {/* Tutorial */}
        <section className="wallet-section space-y-3">
          <div className="text-sm font-medium mb-2">Tutorial</div>
          <button className="accent-button button-sm pressable" onClick={onRestartTutorial}>View tutorial again</button>
        </section>

        {/* Development donation */}
        <section className="wallet-section space-y-3">
          <div className="text-sm font-medium mb-2">Support development</div>
          <div className="text-xs text-secondary mb-3">
            {(!isPlaceholderValue(DONATION_LIGHTNING_ADDRESS) && DONATION_LIGHTNING_ADDRESS.includes("@"))
              ? `Donate from your internal wallet to ${DONATION_LIGHTNING_ADDRESS}`
              : "Configure a Lightning address to accept donations from your internal wallet."}
          </div>
          <div className="flex gap-2 mb-2 w-full">
            <input
              className="pill-input flex-1 min-w-[7rem]"
              placeholder="Amount (sats)"
              value={donateAmt}
              onChange={(e)=>setDonateAmt(e.target.value)}
              inputMode="numeric"
            />
            <button
              className="accent-button button-sm pressable shrink-0 whitespace-nowrap"
              onClick={handleDonate}
              disabled={!mintUrl || donateState === 'sending'}
            >Donate now</button>
          </div>
          <input
            className="pill-input w-full"
            placeholder="Comment (optional)"
            value={donateComment}
            onChange={(e)=>setDonateComment(e.target.value)}
          />
          <div className="mt-2 text-xs text-secondary">
            {donateState === 'sending' && <span>Sending…</span>}
            {donateState === 'done' && <span className="text-accent">{donateMsg}</span>}
            {donateState === 'error' && <span className="text-rose-400">{donateMsg}</span>}
          </div>
        </section>

        {/* Feedback / Feature requests */}
        <section className="wallet-section space-y-2 text-xs text-secondary">
          <div>
            Please submit feedback or feature requests to{' '}
            {isPlaceholderValue(SUPPORT_CONTACT_EMAIL) ? (
              <span className="text-secondary">configure a support email</span>
            ) : (
              <button
                className="link-accent"
                onClick={async ()=>{ try { await navigator.clipboard?.writeText(SUPPORT_CONTACT_EMAIL); showToast(`Copied ${SUPPORT_CONTACT_EMAIL}`); } catch {} }}
              >{SUPPORT_CONTACT_EMAIL}</button>
            )}{' '}or share Board ID{' '}
            {isPlaceholderValue(FEEDBACK_BOARD_ID) ? (
              <span className="text-secondary">configure a board ID</span>
            ) : (
              <button
                className="link-accent"
                onClick={async ()=>{ try { await navigator.clipboard?.writeText(FEEDBACK_BOARD_ID); showToast('Copied Board ID'); } catch {} }}
              >{FEEDBACK_BOARD_ID}</button>
            )}
          </div>
        </section>

        <div className="flex justify-end">
          <button className="ghost-button button-sm pressable" onClick={handleClose}>Close</button>
        </div>
      </div>
    </Modal>
    {showArchivedBoards && (
      <Modal onClose={() => setShowArchivedBoards(false)} title="Archived boards">
        {archivedBoards.length === 0 ? (
          <div className="text-sm text-secondary">No archived boards.</div>
        ) : (
          <ul className="space-y-2">
            {archivedBoards.map((b) => (
              <li
                key={b.id}
                className="bg-surface-muted border border-surface rounded-2xl p-3 flex items-center gap-2 cursor-pointer transition hover:bg-surface-highlight"
                role="button"
                tabIndex={0}
                onClick={() => openArchivedBoard(b.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openArchivedBoard(b.id);
                  }
                }}
              >
                <div className="flex-1 truncate">{b.name}</div>
                <div className="flex gap-2">
                  <button
                    className="accent-button button-sm pressable"
                    onClick={(e) => {
                      e.stopPropagation();
                      unarchiveBoard(b.id);
                    }}
                  >
                    Unarchive
                  </button>
                  <button
                    className="ghost-button button-sm pressable text-rose-400"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteBoard(b.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    )}
    {manageBoard && (
      <Modal
        onClose={() => setManageBoardId(null)}
        title="Manage board"
        actions={(
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="icon-button pressable"
              style={{ '--icon-size': '2.2rem' } as React.CSSProperties}
              data-active={manageBoard.hidden}
              aria-pressed={manageBoard.hidden}
              aria-label={manageBoard.hidden ? 'Unhide board' : 'Hide board'}
              title={manageBoard.hidden ? 'Unhide board' : 'Hide board'}
              onClick={() => setBoardHidden(manageBoard.id, !manageBoard.hidden)}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-[16px] w-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4 12.5c2.4-3 5.4-4.5 8-4.5s5.6 1.5 8 4.5" />
                <path d="M6.5 15l1.6-1.6" />
                <path d="M12 15.5v-2.1" />
                <path d="M17.5 15l-1.6-1.6" />
              </svg>
            </button>
            <button
              type="button"
              className="icon-button pressable"
              style={{ '--icon-size': '2.2rem' } as React.CSSProperties}
              data-active={manageBoard.archived}
              aria-pressed={manageBoard.archived}
              aria-label={manageBoard.archived ? 'Unarchive board' : 'Archive board'}
              title={manageBoard.archived ? 'Unarchive board' : 'Archive board'}
              onClick={() => {
                if (manageBoard.archived) unarchiveBoard(manageBoard.id);
                else archiveBoard(manageBoard.id);
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-[16px] w-[16px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M4.5 7h15" />
                <rect x="5" y="7" width="14" height="12" rx="2" />
                <path d="M12 11v4" />
                <path d="M10.5 13.5L12 15l1.5-1.5" />
              </svg>
            </button>
          </div>
        )}
      >
        <input
          value={manageBoard.name}
          onChange={e => renameBoard(manageBoard.id, e.target.value)}
          className="pill-input w-full mb-4"
        />
        {manageBoard.kind === "lists" ? (
          <>
            <ul className="space-y-2">
              {manageBoard.columns.map(col => (
                <ColumnItem key={col.id} boardId={manageBoard.id} column={col} />
              ))}
            </ul>
            <div className="mt-2">
              <button className="accent-button button-sm pressable" onClick={()=>addColumn(manageBoard.id)}>Add list</button>
            </div>
            <div className="text-xs text-secondary mt-2">Tasks can be dragged between lists directly on the board.</div>
            <div className="mt-4">
              <div className="text-sm font-medium mb-2">List index card</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(!!manageBoard.indexCardEnabled)}
                  onClick={() => setBoardIndexCardEnabled(manageBoard.id, true)}
                >Show</button>
                <button
                  className={pillButtonClass(!manageBoard.indexCardEnabled)}
                  onClick={() => setBoardIndexCardEnabled(manageBoard.id, false)}
                >Hide</button>
              </div>
              <div className="text-xs text-secondary mt-2">
                Add a quick navigation card to jump to any list and keep it centered when opening the board.
              </div>
            </div>
          </>
        ) : manageBoard.kind === "compound" ? (
          <>
            <div className="space-y-2">
              {manageBoard.children.length ? (
                <ul className="space-y-2">
                  {manageBoard.children.map((childId) => (
                    <CompoundChildItem key={childId} parentId={manageBoard.id} childId={childId} />
                  ))}
                </ul>
              ) : (
                <div className="rounded-lg border border-dashed border-surface bg-surface-muted px-3 py-6 text-center text-sm text-secondary">
                  Add boards to combine their lists into one view.
                </div>
              )}
            </div>
            <div className="mt-3 space-y-2">
              <div className="text-xs text-secondary">Add board ID</div>
              <div className="flex gap-2">
                <input
                  value={newCompoundChildId}
                  onChange={(e) => setNewCompoundChildId(e.target.value)}
                  className="pill-input flex-1 min-w-0"
                  placeholder="Shared board ID"
                />
                <button
                  className="accent-button button-sm pressable"
                  onClick={() => {
                    addCompoundChild(manageBoard.id, newCompoundChildId);
                    setNewCompoundChildId("");
                  }}
                >Add</button>
              </div>
              {availableCompoundBoards.length > 0 && (
                <div className="flex flex-wrap gap-1.5 text-xs">
                  {availableCompoundBoards.map((board) => (
                    <button
                      key={board.id}
                      className="ghost-button button-sm pressable"
                      onClick={() => addCompoundChild(manageBoard.id, board.id)}
                    >{board.name}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="mt-4">
              <div className="text-sm font-medium mb-2">List index card</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(!!manageBoard.indexCardEnabled)}
                  onClick={() => setBoardIndexCardEnabled(manageBoard.id, true)}
                >Show</button>
                <button
                  className={pillButtonClass(!manageBoard.indexCardEnabled)}
                  onClick={() => setBoardIndexCardEnabled(manageBoard.id, false)}
                >Hide</button>
              </div>
              <div className="text-xs text-secondary mt-2">
                Quickly jump between lists across all linked boards.
              </div>
            </div>
            <div className="mt-4">
              <div className="text-sm font-medium mb-2">Board name labels</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(!manageBoard.hideChildBoardNames)}
                  onClick={() => setCompoundBoardHideChildNames(manageBoard.id, false)}
                >Show</button>
                <button
                  className={pillButtonClass(!!manageBoard.hideChildBoardNames)}
                  onClick={() => setCompoundBoardHideChildNames(manageBoard.id, true)}
                >Hide</button>
              </div>
              <div className="text-xs text-secondary mt-2">
                Hide the originating board names from list titles while viewing this compound board.
              </div>
            </div>
          </>
        ) : (
          <div className="text-xs text-secondary">The Week board has fixed columns (Sun–Sat, Bounties).</div>
        )}

        <div className="mt-6">
          <div className="text-sm font-medium mb-2">Clear completed button</div>
          <div className="flex gap-2">
            <button
              className={pillButtonClass(!manageBoard.clearCompletedDisabled)}
              onClick={() => setBoardClearCompletedDisabled(manageBoard.id, false)}
            >Show</button>
            <button
              className={pillButtonClass(!!manageBoard.clearCompletedDisabled)}
              onClick={() => setBoardClearCompletedDisabled(manageBoard.id, true)}
            >Hide</button>
          </div>
          <div className="text-xs text-secondary mt-2">
            Hide the clear completed actions for this board. Completed tasks remain available in the Completed view.
          </div>
        </div>

        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm font-medium">Sharing</div>
            <div className="ml-auto" />
            <button
              className="ghost-button button-sm pressable"
              onClick={()=>setShowAdvanced(a=>!a)}
            >{showAdvanced ? "Hide advanced" : "Advanced"}</button>
          </div>
          <div className="space-y-2">
            {manageBoard.nostr ? (
              <>
                <div className="text-xs text-secondary">Board ID</div>
                <div className="flex gap-2 items-center">
                  <input readOnly value={manageBoard.nostr.boardId}
                         className="pill-input flex-1 min-w-0"/>
                  <button className="ghost-button button-sm pressable" onClick={async ()=>{ try { await navigator.clipboard?.writeText(manageBoard.nostr!.boardId); } catch {} }}>Copy</button>
                </div>
                  {showAdvanced && (
                    <>
                      <div className="text-xs text-secondary">Relays</div>
                      <div className="flex gap-2 mb-2">
                        <input
                          value={newBoardRelay}
                          onChange={(e)=>setNewBoardRelay(e.target.value)}
                          onKeyDown={(e)=>{ if (e.key === 'Enter' && manageBoard?.nostr) { const v = newBoardRelay.trim(); if (v && !(manageBoard.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays: [...(manageBoard.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } } }}
                          className="pill-input flex-1"
                          placeholder="wss://relay.example"
                        />
                        <button
                          className="ghost-button button-sm pressable"
                          onClick={()=>{ if (!manageBoard?.nostr) return; const v = newBoardRelay.trim(); if (v && !(manageBoard.nostr.relays || []).includes(v)) { setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays: [...(manageBoard.nostr!.relays || []), v] } }) : b)); setNewBoardRelay(""); } }}
                        >Add</button>
                      </div>
                      <ul className="space-y-2 mb-2">
                        {(manageBoard.nostr.relays || []).map((r) => (
                          <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                            <div className="flex-1 truncate">{r}</div>
                            <button
                              className="ghost-button button-sm pressable text-rose-400"
                              onClick={()=>{
                                if (!manageBoard?.nostr) return;
                                const relays = (manageBoard.nostr.relays || []).filter(x => x !== r);
                                setBoards(prev => prev.map(b => b.id === manageBoard.id ? ({...b, nostr: { boardId: manageBoard.nostr!.boardId, relays } }) : b));
                              }}
                            >Delete</button>
                          </li>
                        ))}
                      </ul>
                      <button className="ghost-button button-sm pressable" onClick={()=>onRegenerateBoardId(manageBoard.id)}>Generate new board ID</button>
                    </>
                  )}
                  <div className="flex gap-2">
                  <button
                    className="ghost-button button-sm pressable"
                    onClick={()=>onBoardChanged(manageBoard.id, { republishTasks: true, board: manageBoard })}
                  >Republish metadata</button>
                  <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>{
                  if (!manageBoard?.nostr) return;
                  const impactedCompoundIds = boards
                    .filter(
                      (board) =>
                        board.kind === "compound" &&
                        !!board.nostr &&
                        board.children.some((childId) => compoundChildMatchesBoard(childId, manageBoard))
                    )
                    .map((board) => board.id);
                  setBoards(prev => prev.map(b => {
                    if (b.id !== manageBoard.id) return b;
                    const clone = { ...b } as Board;
                    delete (clone as any).nostr;
                    return clone;
                  }));
                  if (impactedCompoundIds.length) {
                    setTimeout(() => {
                      impactedCompoundIds.forEach((boardId) => onBoardChanged(boardId));
                    }, 0);
                  }
                  }}>Stop sharing</button>
                </div>
              </>
            ) : (
              <>
                {showAdvanced && (
                  <>
                    <div className="text-xs text-secondary">Relays override (optional)</div>
                    <div className="flex gap-2 mb-2">
                      <input
                        value={newOverrideRelay}
                        onChange={(e)=>setNewOverrideRelay(e.target.value)}
                        onKeyDown={(e)=>{ if (e.key === 'Enter') { const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } } }}
                        className="pill-input flex-1"
                        placeholder="wss://relay.example"
                      />
                      <button className="ghost-button button-sm pressable" onClick={()=>{ const v = newOverrideRelay.trim(); if (v) { setRelaysCsv(addRelayToCsv(relaysCsv, v)); setNewOverrideRelay(""); } }}>Add</button>
                    </div>
                    <ul className="space-y-2 mb-2">
                      {parseCsv(relaysCsv).map((r) => (
                        <li key={r} className="p-2 rounded-lg bg-surface-muted border border-surface flex items-center gap-2">
                          <div className="flex-1 truncate">{r}</div>
                          <button className="ghost-button button-sm pressable text-rose-400" onClick={()=>setRelaysCsv(removeRelayFromCsv(relaysCsv, r))}>Delete</button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button className="accent-button button-sm pressable w-full justify-center" onClick={()=>{onShareBoard(manageBoard.id, showAdvanced ? relaysCsv : ""); setRelaysCsv('');}}>Share this board</button>
              </>
            )}
            <button className="ghost-button button-sm pressable text-rose-400 mt-2 w-full justify-center" onClick={()=>deleteBoard(manageBoard.id)}>Delete board</button>
          </div>
        </div>
      </Modal>
    )}
    </>
  );
}
