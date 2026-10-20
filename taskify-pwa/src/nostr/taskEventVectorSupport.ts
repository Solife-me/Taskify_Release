/**
 * Shared by the task event vector check (taskEventVectors.test.ts) and its generator
 * (scripts/generate-task-event-vectors.test.ts). See taskify-core/fixtures/task-event-vectors-*.json.
 */
import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";
import type { Board, Task } from "../domains/tasks/taskTypes";
import { deriveBoardNostrKeys } from "../domains/nostr/nostrKeyUtils";
import { boardTag, decryptFromBoard, encryptToBoard } from "../boardCrypto";
import { TASK_EVENT_KIND, taskEventBody, taskEventTags, taskTombstoneBody } from "./boardWire";
import { mergeIncomingTask, parseTaskEvent } from "./taskEventMerge";

export const VECTOR_BOARDS = {
  lists: { id: "lists", name: "Lists", kind: "lists", columns: [{ id: "c1", name: "Todo" }], nostr: { boardId: "taskify-vector-lists-board", relays: [] } },
  week: { id: "week", name: "Week", kind: "week", nostr: { boardId: "taskify-vector-week-board", relays: [] } },
} as unknown as Record<"lists" | "week", Board>;

/** What both clients compare after decoding (dates as epoch seconds). */
export type Expected = {
  id: string;
  title: string;
  note: string;
  dueAt: number | null;
  status: "open" | "done" | "deleted";
  columnId: string | null;
  priority: number | null;
  recurrence: unknown;
  seriesId: string | null;
  scriptureMemoryId: string | null;
  scriptureMemoryStage: number | null;
  /**
   * Payload fields a republish of the decoded task must carry unchanged, whether or not this
   * client uses them (iOS reminders on the PWA, for example).
   */
  republishKeeps: Record<string, unknown>;
};

export type Vector = { name: string; board: "lists" | "week"; event: Event; expected: Expected };

const seconds = (iso?: string | null) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

export async function decodeWithPwa(event: Event, board: Board): Promise<Expected> {
  const boardId = board.nostr!.boardId;
  const keys = await deriveBoardNostrKeys(boardId);
  const tag = (name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
  if (event.pubkey !== keys.pk) throw new Error("not signed by the board key");
  if (tag("b") !== boardTag(boardId)) throw new Error("wrong board tag");
  if (!verifyEvent({ ...event })) throw new Error("bad signature");
  const { plaintext } = await decryptFromBoard(boardId, event.content);
  const payload = JSON.parse(plaintext);
  const status = (tag("status") ?? "open") as Expected["status"];
  const read = parseTaskEvent(payload, { taskId: tag("d")!, status, column: tag("col"), createdAt: event.created_at }, board, new Date(0));
  const task = mergeIncomingTask(undefined, read, { nostrAt: event.created_at, order: 0, now: 0, eventPubkey: event.pubkey, incomingIsNewerOnTie: true });
  return {
    id: task.id,
    title: task.title,
    note: task.note ?? "",
    dueAt: payload.dueISO ? seconds(task.dueISO) : null,
    status,
    columnId: board.kind === "lists" ? task.columnId ?? null : null,
    priority: task.priority ?? null,
    recurrence: task.recurrence ?? null,
    seriesId: task.seriesId ?? null,
    scriptureMemoryId: task.scriptureMemoryId ?? null,
    scriptureMemoryStage: task.scriptureMemoryStage ?? null,
    republishKeeps: keptOnRepublish(task, payload),
  };
}

/** The payload fields (beyond this client's own) that republishing the decoded task carries. */
function keptOnRepublish(task: Task, received: Record<string, unknown>): Record<string, unknown> {
  const republished = taskEventBody(task, { attachments: { images: null, documents: null } });
  const kept: Record<string, unknown> = {};
  for (const key of ["reminders", "reminderTime"]) {
    if (key in received && JSON.stringify(republished[key]) === JSON.stringify(received[key])) kept[key] = republished[key];
  }
  return kept;
}

export async function pwaEvent(task: Task, board: Board, status: Expected["status"], createdAt: number): Promise<Event> {
  const boardId = board.nostr!.boardId;
  const keys = await deriveBoardNostrKeys(boardId);
  const body = status === "deleted" ? taskTombstoneBody(task) : taskEventBody(task, { attachments: { images: null, documents: null } });
  const content = await encryptToBoard(boardId, JSON.stringify(body));
  return finalizeEvent({ kind: TASK_EVENT_KIND, created_at: createdAt, tags: taskEventTags(task, board, boardTag(boardId), status), content }, keys.sk);
}

export const CASES: Array<{ name: string; board: "lists" | "week"; task: Task; status: Expected["status"]; expected: Omit<Expected, "id" | "status"> }> = [
  {
    name: "open task with a note, priority and a timed due date",
    board: "lists",
    task: { id: "v-open", boardId: "lists", columnId: "c1", title: "Call the plumber", note: "Ask about Tuesday", priority: 2, dueISO: "2026-10-20T15:30:00.000Z", dueDateEnabled: true, dueTimeEnabled: true } as Task,
    status: "open",
    expected: { title: "Call the plumber", note: "Ask about Tuesday", dueAt: 1792510200, columnId: "c1", priority: 2, recurrence: null, seriesId: null, scriptureMemoryId: null, scriptureMemoryStage: null, republishKeeps: {} },
  },
  {
    name: "completed task",
    board: "lists",
    task: { id: "v-done", boardId: "lists", columnId: "c1", title: "File taxes", dueISO: "2026-10-19T05:00:00.000Z", completed: true, completedAt: "2026-10-19T12:00:00.000Z" } as Task,
    status: "done",
    expected: { title: "File taxes", note: "", dueAt: 1792386000, columnId: "c1", priority: null, recurrence: null, seriesId: null, scriptureMemoryId: null, scriptureMemoryStage: null, republishKeeps: {} },
  },
  {
    name: "daily recurring task on a week board",
    board: "week",
    task: { id: "v-daily", boardId: "week", column: "day", title: "Stretch", dueISO: "2026-10-19T05:00:00.000Z", recurrence: { type: "daily" }, seriesId: "series-stretch" } as Task,
    status: "open",
    expected: { title: "Stretch", note: "", dueAt: 1792386000, columnId: null, priority: null, recurrence: { type: "daily" }, seriesId: "series-stretch", scriptureMemoryId: null, scriptureMemoryStage: null, republishKeeps: {} },
  },
  {
    name: "Scripture Memory review keeps its passage link",
    board: "lists",
    task: { id: "recurrence:scripture-memory:2026-10-19", boardId: "lists", columnId: "c1", title: "Review John 3:16", dueISO: "2026-10-19T05:00:00.000Z", recurrence: { type: "daily" }, seriesId: "scripture-memory", scriptureMemoryId: "entry-1", scriptureMemoryStage: 2 } as Task,
    status: "open",
    expected: { title: "Review John 3:16", note: "", dueAt: 1792386000, columnId: "c1", priority: null, recurrence: { type: "daily" }, seriesId: "scripture-memory", scriptureMemoryId: "entry-1", scriptureMemoryStage: 2, republishKeeps: {} },
  },
  {
    name: "fields another client wrote survive this client's republish",
    board: "lists",
    task: { id: "v-extras", boardId: "lists", columnId: "c1", title: "Dentist", dueISO: "2026-10-21T14:00:00.000Z", syncExtras: { reminders: ["15m"], reminderTime: "09:00" } } as Task,
    status: "open",
    expected: { title: "Dentist", note: "", dueAt: 1792591200, columnId: "c1", priority: null, recurrence: null, seriesId: null, scriptureMemoryId: null, scriptureMemoryStage: null, republishKeeps: { reminders: ["15m"], reminderTime: "09:00" } },
  },
  {
    name: "deleted task (tombstone)",
    board: "lists",
    task: { id: "v-deleted", boardId: "lists", columnId: "c1", title: "Old idea", dueISO: "2026-10-01T05:00:00.000Z" } as Task,
    status: "deleted",
    expected: { title: "Old idea", note: "", dueAt: 1790830800, columnId: "c1", priority: null, recurrence: null, seriesId: null, scriptureMemoryId: null, scriptureMemoryStage: null, republishKeeps: {} },
  },
];

