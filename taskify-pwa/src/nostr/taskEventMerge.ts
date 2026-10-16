/**
 * Reading a shared task event (kind 30301) into the local task list: parsing the decrypted payload
 * and merging it over the local copy. Pure, so every path that applies relay events (the initial
 * sync batch and live updates) uses the same rules.
 *
 * Field convention (matches what `boardWire.taskEventBody` writes): a field absent from the
 * payload keeps the local value, `null` clears it, and a value replaces it. Reminders are per
 * device and never read from the wire.
 */
import { normalizeTaskRecurrence, type TaskDocument } from "taskify-core";
import { normalizeTimeZone } from "../domains/dateTime/dateUtils";
import { normalizeAgentPubkey, normalizeTaskAssignees } from "../domains/tasks/assignmentUtils";
import type { Board, Recurrence, Subtask, Task, TaskAssignee } from "../domains/tasks/taskTypes";
import { PINNED_BOUNTY_LIST_KEY, normalizeBounty, normalizeTaskCreatedAt, normalizeTaskPriority } from "../domains/tasks/taskUtils";
import { ensureDocumentPreview, normalizeDocumentList } from "../lib/documents";

type Bounty = NonNullable<Task["bounty"]>;

/** `undefined`: not in the payload (keep local); `null`: cleared; otherwise the new value. */
export type IncomingTaskFields = {
  bounty?: Bounty | null;
  images?: string[] | null;
  documents?: TaskDocument[] | null;
  streak?: number | null;
  longestStreak?: number | null;
  subtasks?: Subtask[] | null;
  assignees?: TaskAssignee[] | null;
};

export type IncomingTask = {
  status: string | undefined;
  /** The fields every version carries, already normalized. */
  base: Task;
  fields: IncomingTaskFields;
};

const has = (payload: object, key: string) => Object.prototype.hasOwnProperty.call(payload, key);

function optionalField<T>(payload: Record<string, unknown>, key: string, read: (value: unknown) => T | undefined): T | null | undefined {
  if (!has(payload, key)) return undefined;
  const value = payload[key];
  if (value === null) return null;
  return read(value);
}

/**
 * The task a decrypted event describes on local board `board`. `now` fills a missing due date
 * and creation time.
 */
export function parseTaskEvent(
  payload: Record<string, unknown>,
  event: { taskId: string; status?: string; column?: string; createdAt?: number },
  board: Board,
  now: Date,
): IncomingTask {
  const eventCreatedAtMs = typeof event.createdAt === "number" ? event.createdAt * 1000 : undefined;
  const createdBy = normalizeAgentPubkey(payload.createdBy as string | undefined);
  const lastEditedBy = normalizeAgentPubkey(payload.lastEditedBy as string | undefined) ?? createdBy;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const base: Task = {
    id: event.taskId,
    boardId: board.id,
    ...(createdBy ? { createdBy } : {}),
    ...(lastEditedBy ? { lastEditedBy } : {}),
    createdAt: normalizeTaskCreatedAt(payload.createdAt) ?? eventCreatedAtMs,
    title: (payload.title as string) || "Untitled",
    note: (payload.note as string) || "",
    dueISO: (payload.dueISO as string) || today.toISOString(),
    completed: event.status === "done",
    completedAt: payload.completedAt as string | undefined,
    completedBy: payload.completedBy as string | undefined,
    recurrence: normalizeTaskRecurrence(payload.recurrence) as Recurrence | undefined,
    hiddenUntilISO: payload.hiddenUntilISO as string | undefined,
    streak: typeof payload.streak === "number" ? payload.streak : undefined,
    longestStreak: typeof payload.longestStreak === "number" ? payload.longestStreak : undefined,
    seriesId: payload.seriesId as string | undefined,
    subtasks: Array.isArray(payload.subtasks) ? (payload.subtasks as Subtask[]) : undefined,
  };
  const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined);
  if (has(payload, "priority")) base.priority = payload.priority === null ? undefined : normalizeTaskPriority(payload.priority);
  if (has(payload, "dueDateEnabled")) base.dueDateEnabled = bool(payload.dueDateEnabled);
  if (has(payload, "dueTimeEnabled")) base.dueTimeEnabled = bool(payload.dueTimeEnabled);
  if (has(payload, "dueTimeZone")) {
    base.dueTimeZone = typeof payload.dueTimeZone === "string" ? normalizeTimeZone(payload.dueTimeZone) ?? undefined : undefined;
  }
  if (board.kind === "week") {
    base.column = "day";
    if (event.column === "bounties") base.bountyLists = [PINNED_BOUNTY_LIST_KEY];
  } else if (board.kind === "lists") {
    base.columnId = event.column || board.columns[0]?.id || "";
  }

  const fields: IncomingTaskFields = {
    bounty: optionalField(payload, "bounty", (value) => normalizeBounty(value as Bounty) ?? undefined),
    images: optionalField(payload, "images", (value) => (Array.isArray(value) ? (value as string[]) : undefined)),
    documents: optionalField(payload, "documents", (value) => normalizeDocumentList(value)?.map(ensureDocumentPreview) ?? undefined),
    streak: optionalField(payload, "streak", (value) => (typeof value === "number" ? value : undefined)),
    longestStreak: optionalField(payload, "longestStreak", (value) => (typeof value === "number" ? value : undefined)),
    subtasks: optionalField(payload, "subtasks", (value) => (Array.isArray(value) ? (value as Subtask[]) : undefined)),
    assignees: optionalField(payload, "assignees", (value) => normalizeTaskAssignees(value) ?? undefined),
  };
  return { status: event.status, base, fields };
}

/**
 * Bounty updates are authorized: content follows the newer version, but only the owner or sender
 * may revoke, the owner, sender or receiver may unlock, and anyone may mark it claimed.
 */
export function mergeIncomingBounty(
  current: Task["bounty"] | undefined,
  incoming: Bounty | null | undefined,
  context: { eventPubkey: string; incomingIsNewerOnTie: boolean },
): Task["bounty"] | undefined {
  if (incoming === null) return undefined;
  const next = incoming ? normalizeBounty(incoming) : undefined;
  const old = current ? normalizeBounty(current) : undefined;
  if (!next) return old;
  if (!old) return next;
  const oldT = Date.parse(old.updatedAt || "") || 0;
  const incT = Date.parse(next.updatedAt || "") || 0;
  const newer = incT > oldT || (incT === oldT && context.incomingIsNewerOnTie);
  if (old.id !== next.id) return newer ? next : old;

  const merged = { ...old } as Bounty;
  if (newer) {
    if (typeof next.amount === "number") merged.amount = next.amount;
    merged.mint = next.mint ?? merged.mint;
    merged.lock = next.lock ?? merged.lock;
    if (next.token) merged.token = next.token;
    if (has(incoming as object, "enc")) merged.enc = (incoming as Bounty).enc ?? undefined;
    else if (next.token && !next.enc) merged.enc = undefined;
    if (next.receiver) merged.receiver = next.receiver;
    merged.updatedAt = next.updatedAt || merged.updatedAt;
  }
  if (next.state && next.state !== old.state) {
    const isOwner = !!(old.owner && context.eventPubkey === old.owner);
    const isSender = !!(old.sender && context.eventPubkey === old.sender);
    const isReceiver = !!(old.receiver && context.eventPubkey === old.receiver);
    if (next.state === "unlocked" && (isOwner || isSender || isReceiver)) merged.state = "unlocked";
    if (next.state === "revoked" && (isOwner || isSender)) merged.state = "revoked";
    if (next.state === "claimed") merged.state = "claimed";
  }
  return normalizeBounty(merged);
}

function pick<T>(incoming: T | null | undefined, current: T | undefined): T | undefined {
  if (incoming === undefined) return current;
  return incoming === null ? undefined : incoming;
}

/**
 * The local task after applying an incoming version over `current` (undefined for a task new to
 * this device). Order is device-local, so the caller supplies it.
 */
export function mergeIncomingTask(
  current: Task | undefined,
  incoming: IncomingTask,
  context: { nostrAt: number; order: number; now: number; eventPubkey: string; incomingIsNewerOnTie: boolean },
): Task {
  const { base, fields } = incoming;
  return {
    ...(current ?? {}),
    ...base,
    order: context.order,
    createdAt: typeof current?.createdAt === "number" ? current.createdAt : base.createdAt ?? context.now,
    images: pick(fields.images, current?.images),
    documents: pick(fields.documents, current?.documents),
    bounty: mergeIncomingBounty(current?.bounty, fields.bounty, context),
    streak: pick(fields.streak, current?.streak),
    longestStreak: pick(fields.longestStreak, current?.longestStreak),
    subtasks: pick(fields.subtasks, current?.subtasks),
    assignees: pick(fields.assignees, current?.assignees),
    _nostrAt: context.nostrAt,
  };
}
