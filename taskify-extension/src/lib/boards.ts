/**
 * Reading boards and their tasks from the relays.
 *
 * A shared board is a pair of replaceable Nostr events per item:
 *   - kind 30300: the board's metadata (its name, kind, list columns)
 *   - kind 30301: one task, with its column and status in the tags
 *
 * Both are encrypted to a key derived from the board id, so a relay only ever sees ciphertext.
 * The board's id is the public tag: the SHA-256 of the shared board id.
 */
import {
  decryptFromBoard,
  type Board,
  type ListColumn,
  type NostrAppBackupBoard,
  type Task,
} from "taskify-core";
import { boardTagHash } from "taskify-runtime-nostr";
import type { NDKKind } from "@nostr-dev-kit/ndk";
import { getSession } from "./session";

export const BOARD_METADATA_KIND = 30300;
export const TASK_EVENT_KIND = 30301;

/** The public tag a board's events carry. */
export function boardTag(nostrBoardId: string): string {
  return boardTagHash(nostrBoardId);
}

function tagValue(tags: string[][], name: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] === name && typeof tag[1] === "string" && tag[1]) return tag[1];
  }
  return undefined;
}

/** The board a `NostrAppBackupBoard` describes, as Taskify's `Board` shape. */
export function toBoard(entry: NostrAppBackupBoard, accountRelays: string[]): Board | null {
  const nostrId = entry.nostrId?.trim();
  if (!nostrId) return null;
  const relays = entry.relays?.length ? entry.relays : accountRelays;
  const base = {
    id: entry.id || nostrId,
    name: entry.name || "Shared Board",
    nostr: { boardId: nostrId, relays },
    ...(entry.archived ? { archived: true } : {}),
    ...(entry.hidden ? { hidden: true } : {}),
    ...(typeof entry.order === "number" ? { order: entry.order } : {}),
    ...(entry.clearCompletedDisabled ? { clearCompletedDisabled: true } : {}),
  };
  switch (entry.kind) {
    case "lists":
      return {
        ...base,
        kind: "lists",
        columns: entry.columns?.length ? entry.columns : [{ id: "default", name: "Tasks" }],
        ...(entry.indexCardEnabled ? { indexCardEnabled: true } : {}),
      };
    case "compound":
      return {
        ...base,
        kind: "compound",
        children: entry.children ?? [],
        ...(entry.indexCardEnabled ? { indexCardEnabled: true } : {}),
        ...(entry.hideChildBoardNames ? { hideChildBoardNames: true } : {}),
      };
    case "bible":
      return { ...base, kind: "bible" };
    case "week":
    default:
      return { ...base, kind: "week" };
  }
}

export type BoardSyncResult = {
  board: Board;
  tasks: Task[];
};

/** The task shape the panel works with, built from a decrypted task event. */
function taskFromPayload(
  payload: Record<string, unknown>,
  options: { taskId: string; boardId: string; status: string; column: string; createdAt: number },
): Task {
  const now = Date.now();
  const dueISO = typeof payload.dueISO === "string" ? payload.dueISO : "";
  const completedAt = typeof payload.completedAt === "string" ? payload.completedAt : undefined;
  const priority = payload.priority === 1 || payload.priority === 2 || payload.priority === 3 ? payload.priority : undefined;

  return {
    id: options.taskId,
    boardId: options.boardId,
    title: typeof payload.title === "string" ? payload.title : "",
    note: typeof payload.note === "string" ? payload.note : "",
    columnId: options.column,
    completed: options.status === "done",
    dueISO,
    ...(completedAt ? { completedAt } : {}),
    ...(priority ? { priority } : {}),
    ...(payload.recurrence ? { recurrence: payload.recurrence as Task["recurrence"] } : {}),
    ...(typeof payload.seriesId === "string" ? { seriesId: payload.seriesId } : {}),
    ...(typeof payload.hiddenUntilISO === "string" ? { hiddenUntilISO: payload.hiddenUntilISO } : {}),
    ...(Array.isArray(payload.subtasks) ? { subtasks: payload.subtasks as Task["subtasks"] } : {}),
    ...(Array.isArray(payload.assignees) ? { assignees: payload.assignees as Task["assignees"] } : {}),
    ...(Array.isArray(payload.documents) ? { documents: payload.documents as Task["documents"] } : {}),
    createdAt: typeof payload.createdAt === "number" ? payload.createdAt : now,
    updatedAt: new Date(options.createdAt * 1000).toISOString(),
  };
}

/**
 * Reads one board: its metadata and its tasks.
 *
 * The newest version of each task wins. A task is keyed by its `d` tag, which is its id, and
 * deleted tasks are kept as tombstones so a task deleted on another device does not come back.
 */
export async function syncBoard(board: Board): Promise<BoardSyncResult> {
  if (!board.nostr?.boardId) return { board, tasks: [] };
  const nostrBoardId = board.nostr.boardId;
  const relays = board.nostr.relays.length ? board.nostr.relays : [];
  const tag = boardTag(nostrBoardId);
  const session = await getSession(relays.length ? relays : undefined);

  const events = await session.fetchEvents(
    [
      { kinds: [BOARD_METADATA_KIND, TASK_EVENT_KIND] as unknown as NDKKind[], "#b": [tag] },
      { kinds: [BOARD_METADATA_KIND] as unknown as NDKKind[], "#d": [tag], limit: 1 },
    ],
    relays.length ? relays : undefined,
    9000,
  );

  // The newest metadata event wins.
  let metadataEvent: { content: string; created_at: number; tags: string[][] } | null = null;
  const taskEvents = new Map<string, { event: (typeof events)[number]; created_at: number }>();

  for (const event of events) {
    if (event.kind === BOARD_METADATA_KIND) {
      if (!metadataEvent || event.created_at > metadataEvent.created_at) {
        metadataEvent = { content: event.content, created_at: event.created_at, tags: event.tags };
      }
      continue;
    }
    if (event.kind !== TASK_EVENT_KIND) continue;
    const taskId = tagValue(event.tags, "d");
    if (!taskId) continue;
    const existing = taskEvents.get(taskId);
    if (!existing || event.created_at > existing.created_at) {
      taskEvents.set(taskId, { event, created_at: event.created_at });
    }
  }

  let nextBoard = board;
  if (metadataEvent) {
    try {
      const { plaintext } = await decryptFromBoard(nostrBoardId, metadataEvent.content);
      const payload = JSON.parse(plaintext) as Record<string, unknown>;
      nextBoard = applyMetadata(board, payload, tagValue(metadataEvent.tags, "k"));
    } catch (err) {
      console.warn("[taskify] could not read the board metadata", err);
    }
  }

  const tasks: Task[] = [];
  for (const [, { event }] of taskEvents) {
    const taskId = tagValue(event.tags, "d");
    if (!taskId) continue;
    const status = tagValue(event.tags, "status") ?? "open";
    // A deletion is a tombstone: the task's last version, marked deleted. It is not shown, but
    // it stops a task deleted on another device from coming back.
    if (status === "deleted") continue;
    try {
      const { plaintext } = await decryptFromBoard(nostrBoardId, event.content);
      const payload = JSON.parse(plaintext) as Record<string, unknown>;
      tasks.push(
        taskFromPayload(payload, {
          taskId,
          boardId: board.id,
          status,
          column: tagValue(event.tags, "col") ?? "",
          createdAt: event.created_at,
        }),
      );
    } catch {
      // A task encrypted for another board key is not ours to read.
    }
  }

  return { board: nextBoard, tasks };
}

/** The board's metadata event payload applied to the board. */
function applyMetadata(board: Board, payload: Record<string, unknown>, kindTag: string | undefined): Board {
  const name = typeof payload.name === "string" ? payload.name : board.name;
  const kind = kindTag === "lists" || kindTag === "compound" || kindTag === "bible" ? kindTag : board.kind;
  if (kind === "lists") {
    const columns = Array.isArray(payload.columns)
      ? (payload.columns as ListColumn[])
      : board.kind === "lists"
        ? board.columns
        : [];
    return { ...board, name, kind: "lists", columns, indexCardEnabled: payload.listIndex === true };
  }
  if (kind === "compound") {
    return {
      ...board,
      name,
      kind: "compound",
      children: Array.isArray(payload.children) ? (payload.children as string[]) : board.kind === "compound" ? board.children : [],
      indexCardEnabled: payload.listIndex === true,
      hideChildBoardNames: payload.hideBoardNames === true,
    };
  }
  if (kind === "bible") return { ...board, name, kind: "bible" };
  return { ...board, name, kind: "week" };
}
