import type { Task, Recurrence } from "./taskTypes";
import type { TaskPriority } from "./taskTypes";
import { isoDatePart, isoTimePartUtc, startOfDay } from "../dateTime/dateUtils";
import { revealsOnDueDate, isFrequentRecurrence } from "./boardUtils";

// ---- Priority normalization ----

export function normalizeTaskPriority(value: unknown): TaskPriority | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    if (rounded === 1 || rounded === 2 || rounded === 3) return rounded as TaskPriority;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "!" || trimmed === "!!" || trimmed === "!!!") {
      return trimmed.length as TaskPriority;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed === 1 || parsed === 2 || parsed === 3) return parsed as TaskPriority;
  }
  return undefined;
}

// ---- Board sort state ----

export type BoardSortMode = "manual" | "due" | "priority" | "created" | "alpha";
export type BoardSortDirection = "asc" | "desc";

export const DEFAULT_BOARD_SORT_DIRECTION: Record<BoardSortMode, BoardSortDirection> = {
  manual: "asc",
  due: "asc",
  priority: "desc",
  created: "desc",
  alpha: "asc",
};

export const BOARD_SORT_MODE_IDS = new Set<BoardSortMode>(["manual", "due", "priority", "created", "alpha"]);

export function normalizeBoardSortState(value: unknown): { mode: BoardSortMode; direction: BoardSortDirection } | null {
  const modeRaw = typeof (value as any)?.mode === "string" ? (value as any).mode : "";
  if (!BOARD_SORT_MODE_IDS.has(modeRaw as BoardSortMode)) return null;
  const mode = modeRaw as BoardSortMode;
  const directionRaw = typeof (value as any)?.direction === "string" ? (value as any).direction : "";
  const direction: BoardSortDirection =
    directionRaw === "asc" || directionRaw === "desc" ? (directionRaw as BoardSortDirection) : DEFAULT_BOARD_SORT_DIRECTION[mode];
  return { mode, direction };
}

// ---- Bounty list helpers ----

export function taskHasBountyList(task: Task, key: string | null | undefined): boolean {
  if (!key) return false;
  if (!Array.isArray(task.bountyLists)) return false;
  return task.bountyLists.includes(key);
}

export function withTaskAddedToBountyList(task: Task, key: string | null): Task {
  if (!key) return task;
  if (taskHasBountyList(task, key)) return task;
  const nextLists = Array.isArray(task.bountyLists) ? [...task.bountyLists, key] : [key];
  return { ...task, bountyLists: nextLists };
}

export function withTaskRemovedFromBountyList(task: Task, key: string | null): Task {
  if (!key || !Array.isArray(task.bountyLists)) return task;
  if (!task.bountyLists.includes(key)) return task;
  const filtered = task.bountyLists.filter((value) => value !== key);
  if (filtered.length === 0) {
    const clone = { ...task };
    delete clone.bountyLists;
    return clone;
  }
  return { ...task, bountyLists: filtered };
}

export function isRecoverableBountyTask(task: Task): boolean {
  return !!task.bounty && typeof task.bountyDeletedAt === "string" && task.bountyDeletedAt.trim().length > 0;
}

// ---- Nostr pubkey helpers ----

export function toXOnlyHex(value?: string | null): string | null {
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

export function ensureXOnlyHex(value?: string | null): string | undefined {
  const normalized = toXOnlyHex(value);
  return normalized ?? undefined;
}

export function pubkeysEqual(a?: string | null, b?: string | null): boolean {
  const ax = toXOnlyHex(a);
  const bx = toXOnlyHex(b);
  return !!(ax && bx && ax === bx);
}

// ---- Bounty normalization ----

export function normalizeBounty(bounty?: Task["bounty"] | null): Task["bounty"] | undefined {
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

export function normalizeTaskBounty(task: Task): Task {
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

// ---- Bounty state label ----

export function bountyStateLabel(bounty: Task["bounty"]): string {
  if (!bounty) return "";
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

// ---- Streak helpers ----

export function mergeLongestStreak(task: Task, streak: number | undefined): number | undefined {
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

// ---- Recurrence normalization ----

export function normalizeHiddenForRecurring(task: Task): Task {
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

export function recurrenceSeriesKey(task: Task): string | null {
  if (!task.recurrence) return null;
  if (task.seriesId) return `series:${task.boardId}:${task.seriesId}`;
  const recurrence = JSON.stringify(task.recurrence);
  return `sig:${task.boardId}::${task.title}::${task.note || ""}::${recurrence}`;
}

export function recurringInstanceId(seriesId: string, dueISO: string, rule?: Recurrence, timeZone?: string): string {
  const datePart = isoDatePart(dueISO, timeZone);
  const timePart =
    rule && rule.type === "every" && rule.unit === "hour"
      ? isoTimePartUtc(dueISO)
      : "";
  const suffix = timePart ? `${datePart}T${timePart}` : datePart;
  return `recurrence:${seriesId}:${suffix}`;
}

export function recurringOccurrenceKey(task: Task): string | null {
  if (!task.recurrence || !isFrequentRecurrence(task.recurrence)) return null;
  const seriesKey = recurrenceSeriesKey(task);
  if (!seriesKey) return null;
  const datePart = isoDatePart(task.dueISO, task.dueTimeZone);
  return `${seriesKey}::${datePart}`;
}

export function pickRecurringDuplicate(a: Task, b: Task): Task {
  const aCompleted = !!a.completed;
  const bCompleted = !!b.completed;
  if (aCompleted !== bCompleted) return aCompleted ? a : b;
  const aCompletedAt = a.completedAt ? Date.parse(a.completedAt) : 0;
  const bCompletedAt = b.completedAt ? Date.parse(b.completedAt) : 0;
  if (aCompletedAt !== bCompletedAt) return aCompletedAt >= bCompletedAt ? a : b;
  const aIsBase = !!(a.seriesId && a.id === a.seriesId);
  const bIsBase = !!(b.seriesId && b.id === b.seriesId);
  if (aIsBase !== bIsBase) return aIsBase ? a : b;
  const aOrder = typeof a.order === "number" ? a.order : Number.POSITIVE_INFINITY;
  const bOrder = typeof b.order === "number" ? b.order : Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder < bOrder ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

export function dedupeRecurringInstances(tasks: Task[]): Task[] {
  const out: Task[] = [];
  const indexByKey = new Map<string, number>();
  let changed = false;
  for (const task of tasks) {
    const key = recurringOccurrenceKey(task);
    if (!key) {
      out.push(task);
      continue;
    }
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, out.length);
      out.push(task);
      continue;
    }
    const existing = out[existingIndex];
    const winner = pickRecurringDuplicate(existing, task);
    if (winner !== existing) {
      out[existingIndex] = winner;
    }
    changed = true;
  }
  return changed ? out : tasks;
}

// ---- Task created-at normalization ----

export function normalizeTaskCreatedAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

// ---- Bounty list key ----

export const PINNED_BOUNTY_LIST_KEY = "taskify::pinned";
