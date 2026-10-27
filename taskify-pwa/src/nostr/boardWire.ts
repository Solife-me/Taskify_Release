/**
 * The wire format of shared boards: what this client writes for board metadata (kind 30300) and
 * tasks (kind 30301), before encryption. iOS, macOS and the CLI read these exact shapes, so
 * changes here are protocol changes. Pure: no keys, relays or network.
 */
import { findBoardByCompoundChildId } from "taskify-core";
import { normalizeAgentPubkey } from "../domains/tasks/assignmentUtils";
import type { TaskDocument } from "taskify-core";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { normalizeBounty } from "../domains/tasks/taskUtils";

export const BOARD_METADATA_KIND = 30300;
export const TASK_EVENT_KIND = 30301;

/** Board metadata: the plaintext payload and its tags, for `boardTagValue = boardTag(nostrBoardId)`. */
export function boardMetadataEvent(
  board: Board,
  boards: Board[],
  boardTagValue: string,
): { tags: string[][]; payload: Record<string, unknown> } {
  const tags: string[][] = [["d", boardTagValue], ["b", boardTagValue], ["k", board.kind], ["name", board.name]];
  const payload: Record<string, unknown> = { clearCompletedDisabled: !!board.clearCompletedDisabled };
  if (board.kind === "lists") {
    payload.columns = board.columns;
    payload.listIndex = !!board.indexCardEnabled;
  } else if (board.kind === "compound") {
    // Children are named by their shared board id, which every member's device knows.
    payload.children = board.children
      .map((childId) => {
        const child = findBoardByCompoundChildId(boards, childId);
        const canonicalId = child?.nostr?.boardId || child?.id || childId;
        return typeof canonicalId === "string" ? canonicalId : "";
      })
      .filter((childId) => !!childId);
    payload.listIndex = !!board.indexCardEnabled;
    payload.hideBoardNames = !!board.hideChildBoardNames;
  }
  return { tags, payload };
}

/** Week boards file every task under the `day` column; list boards use the task's list. */
export function taskEventTags(
  task: Pick<Task, "id" | "columnId">,
  board: Pick<Board, "kind">,
  boardTagValue: string,
  status: "open" | "done" | "deleted",
): string[][] {
  const column = board.kind === "week" ? "day" : task.columnId || "";
  return [["d", task.id], ["b", boardTagValue], ["col", String(column)], ["status", status]];
}

export type PreparedAttachments = { images: string[] | null; documents: unknown[] | null };

/**
 * A task's published payload. Absent optional fields go out as explicit nulls so other devices
 * clear them. Reminders are per device and never published (another client's published reminders
 * travel in `syncExtras`).
 */
export function taskEventBody(
  task: Task,
  options: { actorPubkey?: string | null; attachments: PreparedAttachments },
): Record<string, unknown> {
  const createdBy = normalizeAgentPubkey(task.createdBy) ?? undefined;
  const lastEditedBy = normalizeAgentPubkey(task.lastEditedBy || options.actorPubkey || task.createdBy) ?? createdBy;
  const normalizedBounty = normalizeBounty(task.bounty);
  return {
    // Fields other clients wrote that this client does not use go back out unchanged (C7-3);
    // everything below takes precedence over them.
    ...(task.syncExtras ?? {}),
    title: task.title,
    priority: task.priority ?? null,
    note: task.note || "",
    dueISO: task.dueISO,
    completedAt: task.completedAt,
    completedBy: task.completedBy,
    recurrence: task.recurrence,
    hiddenUntilISO: task.hiddenUntilISO,
    createdBy,
    lastEditedBy,
    createdAt: task.createdAt ?? null,
    streak: task.streak,
    longestStreak: task.longestStreak,
    seriesId: task.seriesId,
    dueDateEnabled: typeof task.dueDateEnabled === "boolean" ? task.dueDateEnabled : null,
    dueTimeEnabled: typeof task.dueTimeEnabled === "boolean" ? task.dueTimeEnabled : null,
    dueTimeZone: typeof task.dueTimeZone === "string" ? task.dueTimeZone : null,
    images: options.attachments.images,
    documents: options.attachments.documents,
    bounty: typeof task.bounty === "undefined" ? null : (normalizedBounty ?? null),
    subtasks: typeof task.subtasks === "undefined" ? null : task.subtasks,
    assignees: typeof task.assignees === "undefined" ? null : task.assignees,
    inboxItem: typeof task.inboxItem === "undefined" ? null : task.inboxItem ?? null,
    ...scriptureMemoryFields(task),
  };
}

/**
 * A Scripture Memory review's link to its passage, as iOS writes it. Only review tasks carry
 * these; the fields are left out otherwise.
 */
function scriptureMemoryFields(task: Task): Record<string, unknown> {
  if (!task.scriptureMemoryId) return {};
  return {
    scriptureMemoryId: task.scriptureMemoryId,
    ...(typeof task.scriptureMemoryStage === "number" ? { scriptureMemoryStage: task.scriptureMemoryStage } : {}),
    ...(task.scriptureMemoryPrevReviewISO ? { scriptureMemoryPrevReviewISO: task.scriptureMemoryPrevReviewISO } : {}),
    ...(task.scriptureMemoryScheduledAt ? { scriptureMemoryScheduledAt: task.scriptureMemoryScheduledAt } : {}),
  };
}

/**
 * A deletion is the task's last version with status `deleted` (a tombstone at its address), not
 * a NIP-09 deletion, which strfry refused when it arrived first. Matches native.
 */
export function taskTombstoneBody(task: Task): Record<string, unknown> {
  return {
    title: task.title,
    priority: task.priority ?? null,
    note: task.note || "",
    dueISO: task.dueISO,
    dueDateEnabled: task.dueDateEnabled,
    dueTimeEnabled: task.dueTimeEnabled,
    dueTimeZone: task.dueTimeZone,
    completedAt: task.completedAt,
    recurrence: task.recurrence,
    hiddenUntilISO: task.hiddenUntilISO,
    streak: task.streak,
    longestStreak: task.longestStreak,
    subtasks: task.subtasks,
    assignees: task.assignees,
    seriesId: task.seriesId,
    documents: task.documents,
    inboxItem: task.inboxItem ?? null,
  };
}

export function sameStringList(a?: string[], b?: string[]): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
}

export function sameDocumentList(a?: TaskDocument[], b?: TaskDocument[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** The task as published: uploaded attachments replace local copies; `null` means unchanged. */
export function taskWithPreparedAttachments(task: Task, prepared: PreparedAttachments): Task {
  return {
    ...task,
    ...(prepared.images === null ? {} : { images: prepared.images.length ? prepared.images : undefined }),
    ...(prepared.documents === null
      ? {}
      : { documents: prepared.documents.length ? (prepared.documents as TaskDocument[]) : undefined }),
  };
}
