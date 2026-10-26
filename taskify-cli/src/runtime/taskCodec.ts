import { type NDKEvent } from "@nostr-dev-kit/ndk";
import { deriveBoardKeyPair } from "taskify-runtime-nostr";
import { readStatusTag, readTagValue } from "taskify-core";
import { sanitizeRemote } from "../shared/displaySafe.js";
import type { AgentTaskCreateInput } from "../shared/agentRuntime.js";
import type { ReminderPreset, Recurrence, Subtask, TaskAssignee } from "../shared/taskTypes.js";
import type { CachedTask } from "../taskCache.js";
import { decryptContent, type DecryptedPayload } from "./context.js";

/** Task records: how a kind 30301 event and a cached task become a `FullTaskRecord`, and back. */

export type FullTaskRecord = {
  order?: number;
  id: string;              // UUID from the "d" tag
  boardId: string;         // raw board UUID
  boardName?: string;
  title: string;
  note?: string;
  dueISO: string;
  dueDateEnabled?: boolean;
  dueTimeEnabled?: boolean;
  dueTimeZone?: string;
  priority?: 1 | 2 | 3;
  completed: boolean;
  completedAt?: string;
  completedBy?: string;
  createdAt?: number;      // Unix seconds (for render compat)
  updatedAt?: string;
  createdBy?: string;      // hex pubkey
  lastEditedBy?: string;   // hex pubkey
  recurrence?: Recurrence;
  subtasks?: Subtask[];
  bounty?: object;
  reminders?: ReminderPreset[];
  column?: string;         // col tag value (column ID)
  sourceBoardId?: string;
  inboxItem?: boolean;
  assignees?: TaskAssignee[];
  documents?: Record<string, unknown>[];
  hiddenUntilISO?: string;
  streak?: number;
  longestStreak?: number;
  seriesId?: string;
  images?: string[];
  deleted?: boolean;
  /** Signed relay event id for deterministic equal-timestamp replacement. */
  nostrEventId?: string;
  /** Set by `setTaskStatus` when completing a recurring task opened its next occurrence. */
  nextOccurrence?: { id: string; dueISO: string };
};

export type ExtendedCreateInput = AgentTaskCreateInput & {
  subtasks?: Subtask[];
  inboxItem?: boolean;
  dueTimeEnabled?: boolean;
  dueTimeZone?: string;
  hiddenUntilISO?: string;
};

export function validateEventCompat(event: NDKEvent): boolean {
  if (event.kind !== 30301) return false;
  const hasD = event.tags.some((t) => t[0] === "d");
  const hasB = event.tags.some((t) => t[0] === "b");
  if (!hasD || !hasB) return false;
  if (!event.content) return false;
  return true;
}

// ---- Cache conversion helpers ----

export function recordToCache(r: FullTaskRecord): CachedTask {
  return {
    id: r.id,
    title: r.title,
    order: r.order,
    boardId: r.boardId,
    boardName: r.boardName,
    status: r.deleted ? "deleted" : r.completed ? "done" : "open",
    updatedAt: r.createdAt,
    note: r.note,
    dueISO: r.dueISO,
    dueDateEnabled: r.dueDateEnabled,
    dueTimeEnabled: r.dueTimeEnabled,
    dueTimeZone: r.dueTimeZone,
    priority: r.priority,
    completed: r.completed,
    completedAt: r.completedAt,
    completedBy: r.completedBy,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    lastEditedBy: r.lastEditedBy,
    column: r.column,
    subtasks: r.subtasks,
    recurrence: r.recurrence,
    bounty: r.bounty,
    reminders: r.reminders,
    inboxItem: r.inboxItem,
    assignees: r.assignees,
    documents: r.documents,
    hiddenUntilISO: r.hiddenUntilISO,
    streak: r.streak,
    longestStreak: r.longestStreak,
    seriesId: r.seriesId,
    images: r.images,
    nostrEventId: r.nostrEventId,
    deleted: r.deleted,
  };
}

export function cacheToRecord(t: CachedTask, boardName?: string): FullTaskRecord {
  // The cache may hold text written before records were cleaned.
  return sanitizeRemote({
    id: t.id,
    boardId: t.boardId,
    boardName: t.boardName ?? boardName,
    title: t.title,
    order: t.order,
    note: t.note,
    dueISO: t.dueISO ?? "",
    dueDateEnabled: t.dueDateEnabled,
    dueTimeEnabled: t.dueTimeEnabled,
    dueTimeZone: t.dueTimeZone,
    priority: t.priority,
    completed: t.status === "done",
    completedAt: t.completedAt,
    completedBy: t.completedBy,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt
      ? new Date(t.updatedAt * 1000).toISOString()
      : undefined,
    createdBy: t.createdBy,
    lastEditedBy: t.lastEditedBy,
    column: t.column,
    subtasks: t.subtasks,
    recurrence: t.recurrence as Recurrence | undefined,
    bounty: t.bounty,
    reminders: t.reminders,
    inboxItem: t.inboxItem,
    assignees: t.assignees as TaskAssignee[] | undefined,
    documents: t.documents as Record<string, unknown>[] | undefined,
    hiddenUntilISO: t.hiddenUntilISO,
    streak: t.streak,
    longestStreak: t.longestStreak,
    seriesId: t.seriesId,
    images: t.images,
    nostrEventId: t.nostrEventId,
    deleted: t.status === "deleted",
  });
}

export async function decryptTaskEventPayload(event: NDKEvent, boardId: string): Promise<DecryptedPayload> {
  const plaintext = await decryptContent(boardId, event.content);
  return JSON.parse(plaintext) as DecryptedPayload;
}

/** Parsed records are for display: other people's text is cleaned (see displaySafe). */
export async function parseDecryptedEvent(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullTaskRecord | null> {
  return sanitizeRemote(await parseDecryptedEventUnsafe(event, boardId, boardName));
}

async function parseDecryptedEventUnsafe(
  event: NDKEvent,
  boardId: string,
  boardName?: string,
): Promise<FullTaskRecord | null> {
  if (!validateEventCompat(event)) return null;
  if (event.pubkey !== deriveBoardKeyPair(boardId).pk) return null;
  try {
    const payload = await decryptTaskEventPayload(event, boardId);
    const taskId = readTagValue(event.tags, "d") ?? "";
    if (!taskId) return null;
    const statusVal = readStatusTag(event.tags, "open");
    const completed = statusVal === "done";
    const deleted = statusVal === "deleted";
    const column = readTagValue(event.tags, "col") || undefined;
    return {
      id: taskId,
      boardId,
      boardName,
      title: payload.title ?? "",
      order: typeof payload.order === "number" && Number.isFinite(payload.order) ? payload.order : undefined,
      note: payload.note || undefined,
      dueISO: payload.dueISO ?? "",
      dueDateEnabled: payload.dueDateEnabled ?? undefined,
      dueTimeEnabled: payload.dueTimeEnabled ?? undefined,
      priority: payload.priority ?? undefined,
      completed,
      completedAt: payload.completedAt ?? undefined,
      // payload.createdAt is ms; convert to seconds for render compat
      // Use relay event timestamp for merge ordering/version selection.
      // payload.createdAt is the original task creation time and does NOT change
      // on edits/completions, so using it causes stale open versions to beat
      // newer done/updated versions during incremental sync merges.
      createdAt: event.created_at ?? (payload.createdAt ? Math.floor(payload.createdAt / 1000) : undefined),
      updatedAt: event.created_at
        ? new Date(event.created_at * 1000).toISOString()
        : undefined,
      createdBy: payload.createdBy,
      lastEditedBy: payload.lastEditedBy,
      recurrence: payload.recurrence ?? undefined,
      subtasks: payload.subtasks ?? undefined,
      bounty: payload.bounty ?? undefined,
      column,
      inboxItem: payload.inboxItem === true ? true : undefined,
      assignees: Array.isArray(payload.assignees) && payload.assignees.length > 0
        ? (payload.assignees as Array<unknown>)
          .map((a) => {
            if (typeof a === "string") return { pubkey: a };
            if (!a || typeof a !== "object") return null;
            const obj = a as Record<string, unknown>;
            const pubkey = typeof obj.pubkey === "string" ? obj.pubkey : "";
            if (!pubkey) return null;
            return {
              pubkey,
              relay: typeof obj.relay === "string" ? obj.relay : undefined,
              status: obj.status === "pending" || obj.status === "accepted" || obj.status === "declined" || obj.status === "tentative"
                ? obj.status
                : undefined,
              respondedAt: typeof obj.respondedAt === "number" ? Math.round(obj.respondedAt) : undefined,
            };
          })
          .filter((a): a is TaskAssignee => !!a)
        : undefined,
      documents: Array.isArray(payload.documents) ? (payload.documents as Record<string, unknown>[]) : undefined,
      dueTimeZone: payload.dueTimeZone ?? undefined,
      hiddenUntilISO: payload.hiddenUntilISO ?? undefined,
      streak: typeof payload.streak === "number" ? payload.streak : undefined,
      longestStreak: typeof payload.longestStreak === "number" ? payload.longestStreak : undefined,
      seriesId: typeof payload.seriesId === "string" ? payload.seriesId : undefined,
      completedBy: payload.completedBy ?? undefined,
      images: Array.isArray(payload.images) ? payload.images as string[] : undefined,
      deleted,
      nostrEventId: event.id,
    };
  } catch {
    return null;
  }
}
