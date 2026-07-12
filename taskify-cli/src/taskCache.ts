// Task cache for fast completions and repeated list calls.
// Cache file: ~/.config/taskify/cache.json

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ReminderPreset, Subtask, TaskAssignee } from "./shared/taskTypes.js";

export const CACHE_DIR = join(homedir(), ".config", "taskify");
export const CACHE_PATH = join(CACHE_DIR, "cache.json");
export const CACHE_TTL_MS = 300_000; // 5 minutes

export type CachedTask = {
  id: string;
  title: string;
  boardId: string;
  boardName?: string;
  status: string; // "open" | "done" | "deleted"
  updatedAt?: number; // unix seconds
  // Extended fields (mirrors FullTaskRecord for round-trip fidelity)
  note?: string;
  dueISO?: string;
  dueDateEnabled?: boolean;
  dueTimeEnabled?: boolean;
  dueTimeZone?: string;
  priority?: 1 | 2 | 3;
  completed?: boolean;
  completedAt?: string;
  completedBy?: string;
  createdAt?: number;
  createdBy?: string;
  lastEditedBy?: string;
  column?: string;
  subtasks?: Subtask[];
  recurrence?: unknown;
  bounty?: object;
  reminders?: ReminderPreset[];
  inboxItem?: boolean;
  assignees?: TaskAssignee[];
  documents?: Record<string, unknown>[];
  hiddenUntilISO?: string;
  streak?: number;
  longestStreak?: number;
  seriesId?: string;
  images?: string[];
  deleted?: boolean;
  nostrEventId?: string;
};

export type BoardCache = {
  tasks: CachedTask[];
  fetchedAt: number;
  /** Unix seconds: highest created_at seen from relays. Used as `since` on next incremental fetch. */
  lastSyncAt?: number;
};

export type TaskCache = {
  boards: Record<string, BoardCache>;
};

export function readCache(): TaskCache {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    return JSON.parse(raw) as TaskCache;
  } catch {
    return { boards: {} };
  }
}

export function writeCache(cache: TaskCache): void {
  const tempPath = `${CACHE_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    chmodSync(CACHE_DIR, 0o700);
    writeFileSync(tempPath, JSON.stringify(cache, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tempPath, CACHE_PATH);
    chmodSync(CACHE_PATH, 0o600);
  } catch {
    try { unlinkSync(tempPath); } catch { /* already absent */ }
    // Non-fatal: cache writes are best-effort
  }
}

export function clearCache(): void {
  try {
    unlinkSync(CACHE_PATH);
  } catch {
    // Non-fatal if already missing
  }
}

export function isCacheFresh(boardCache: BoardCache): boolean {
  return Date.now() - boardCache.fetchedAt < CACHE_TTL_MS;
}

export function incrementalSyncSince(
  boardCache: BoardCache | undefined,
  options: { refresh?: boolean; noCache?: boolean; lookbackSeconds?: number } = {},
): number | undefined {
  if (options.refresh === true || options.noCache === true) return undefined;
  if (!boardCache?.lastSyncAt || boardCache.tasks.length === 0) return undefined;
  return Math.max(0, boardCache.lastSyncAt - (options.lookbackSeconds ?? 300));
}

/** Read open task IDs from cache synchronously for shell completions. */
export function readCachedOpenTaskIds(): Array<{ id: string; title: string }> {
  try {
    const raw = readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as TaskCache;
    const now = Date.now();
    const results: Array<{ id: string; title: string }> = [];
    for (const boardCache of Object.values(cache.boards ?? {})) {
      if (now - boardCache.fetchedAt > CACHE_TTL_MS) continue;
      for (const task of boardCache.tasks ?? []) {
        if (task.status === "open") {
          results.push({ id: task.id.slice(0, 8), title: task.title });
        }
      }
    }
    return results;
  } catch {
    return [];
  }
}
