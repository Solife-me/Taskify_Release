/**
 * How incoming task events from relays meet the tasks already on this device. Pure, so the rules
 * are tested directly (`taskSyncMerge.test.ts`):
 *
 * - During a board's first sync, each relay's events collect in a batch; when the relay says it
 *   has sent everything (EOSE), its batch merges into the task list.
 * - A merge never lets relay data regress what this device holds: an entry older than the task's
 *   stored version (`_nostrAt`) or than the ledger's clock (in-flight edits, deletion
 *   tombstones) is skipped. Equal versions apply, so a re-sync is idempotent.
 * - After the first sync, live events are applied as they come, rechecked against the ledger at
 *   apply time and coalesced so a burst renders once.
 */
import type { Task } from "../domains/tasks/taskTypes";
import { mergeIncomingTask, type IncomingTask } from "./taskEventMerge";

export type SyncedTask = Task & { _nostrAt?: number };
export type RelayBatchEntry = SyncedTask | { _deleted: true; _nostrAt: number };

/** The version an entry carries (-1 for none). */
export function relayBatchEventAt(entry: RelayBatchEntry | undefined): number {
  if (!entry) return -1;
  return "_deleted" in entry ? entry._nostrAt : entry._nostrAt ?? 0;
}

/**
 * Combines several relays' batches into one, keeping the newest entry per task. With
 * `replaceOnEqual`, a later relay's entry replaces an equal one (used when all relays are done).
 */
export function mergeRelayBatches(
  batches: Map<string, Map<string, RelayBatchEntry>>,
  replaceOnEqual: boolean,
): Map<string, RelayBatchEntry> {
  const combined = new Map<string, RelayBatchEntry>();
  for (const relayBatch of batches.values()) {
    for (const [key, entry] of relayBatch) {
      const existing = combined.get(key);
      const incomingAt = relayBatchEventAt(entry);
      const existingAt = relayBatchEventAt(existing);
      if (!existing || incomingAt > existingAt || (replaceOnEqual && incomingAt >= existingAt)) {
        combined.set(key, entry);
      }
    }
  }
  return combined;
}

/**
 * Merges a relay batch (keyed `boardId::taskId`) into the task list. `clockAt` is the ledger's
 * version for a task: in-flight local edits and deletion tombstones raise it.
 */
export function mergeRelayBatchIntoTasks(
  tasks: SyncedTask[],
  relayBatch: Map<string, RelayBatchEntry>,
  clockAt: (taskId: string) => number,
): SyncedTask[] {
  const merged = new Map<string, SyncedTask>(tasks.map((task) => [`${task.boardId}::${task.id}`, task]));
  for (const [key, entry] of relayBatch) {
    const taskId = key.split("::")[1] ?? "";
    const incomingAt = "_deleted" in entry ? entry._nostrAt : entry._nostrAt ?? clockAt(taskId);
    const existingAt = Math.max(merged.get(key)?._nostrAt ?? 0, clockAt(taskId));
    if (incomingAt < existingAt) continue;
    if ("_deleted" in entry) merged.delete(key);
    else merged.set(key, entry);
  }
  return Array.from(merged.values());
}

export type IncomingTaskUpdate =
  | { deleted: true; at: number }
  | {
      deleted: false;
      at: number;
      incoming: IncomingTask;
      eventPubkey: string;
      /** The event is newer than anything the ledger had for the task. */
      incomingIsNewerOnTie: boolean;
      now: number;
    };

/** Adds an event to a relay's batch, merged over what that relay already sent for the task. */
export function addToRelayBatch(batch: Map<string, RelayBatchEntry>, key: string, update: IncomingTaskUpdate): void {
  if (update.deleted) {
    batch.set(key, { _deleted: true, _nostrAt: update.at });
    return;
  }
  const existing = batch.get(key);
  const current = existing && !("_deleted" in existing) ? existing : undefined;
  batch.set(
    key,
    mergeIncomingTask(current, update.incoming, {
      nostrAt: update.at,
      order: current?.order ?? 0,
      now: update.now,
      eventPubkey: update.eventPubkey,
      incomingIsNewerOnTie: update.incomingIsNewerOnTie,
    }),
  );
}

/**
 * Applies a live event to the task list. `isCurrent` rechecks the ledger at apply time (a local
 * edit may have happened since the event arrived); `nextOrder` places a task new to this device.
 */
export function applyIncomingTask(
  tasks: Task[],
  target: { boardId: string; taskId: string },
  update: IncomingTaskUpdate,
  isCurrent: () => boolean,
  nextOrder: (tasks: Task[]) => number,
): Task[] {
  if (!isCurrent()) return tasks;
  const index = tasks.findIndex((task) => task.id === target.taskId && task.boardId === target.boardId);
  if (update.deleted) {
    return index < 0 ? tasks : tasks.filter((_, i) => i !== index);
  }
  const current = index >= 0 ? tasks[index] : undefined;
  const merged = mergeIncomingTask(current, update.incoming, {
    nostrAt: update.at,
    order: typeof current?.order === "number" ? current.order : nextOrder(tasks),
    now: update.now,
    eventPubkey: update.eventPubkey,
    incomingIsNewerOnTie: update.incomingIsNewerOnTie,
  });
  if (index < 0) return [...tasks, merged];
  const copy = tasks.slice();
  copy[index] = merged;
  return copy;
}

/**
 * Coalesces updates per group (a board) that arrive within `delayMs` of each other into one
 * `commit`, applied in arrival order.
 */
export class LiveUpdateBatcher<T> {
  private readonly batches = new Map<string, { updaters: Array<(prev: T) => T>; timer: unknown }>();

  constructor(
    private readonly commit: (apply: (prev: T) => T) => void,
    private readonly delayMs: number,
    private readonly timers: { set: (run: () => void, ms: number) => unknown; clear: (timer: unknown) => void } = {
      set: (run, ms) => setTimeout(run, ms),
      clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    },
  ) {}

  enqueue(group: string, updater: (prev: T) => T): void {
    let batch = this.batches.get(group);
    if (!batch) {
      batch = { updaters: [], timer: null };
      this.batches.set(group, batch);
    }
    batch.updaters.push(updater);
    if (batch.timer != null) this.timers.clear(batch.timer);
    batch.timer = this.timers.set(() => {
      const due = this.batches.get(group);
      if (!due) return;
      this.batches.delete(group);
      this.commit((prev) => due.updaters.reduce((result, apply) => apply(result), prev));
    }, this.delayMs);
  }
}
