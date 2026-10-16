/**
 * What this device knows about the latest version of every board item on the relays: the
 * `created_at` of the newest event seen or published for each board, task and calendar event,
 * which items have a local publish in flight, and which tasks were deleted here.
 *
 * Both directions use it. A publish reserves a timestamp newer than anything seen and marks the
 * item pending; an incoming event is applied only if it is newer, or as new and nothing local is
 * in flight. Deletions are kept across reloads as tombstones, so a slow relay replaying an old
 * version cannot bring a deleted task back.
 *
 * Board ids here are board tags (`boardTag(nostrBoardId)`), as the events carry them.
 */
import { reserveTaskMutationTimestamp } from "../domains/tasks/taskMovePersistence";

type Clock = Map<string, Map<string, number>>;

export type TombstoneStorage = {
  load: () => string | null;
  save: (serialized: string) => void;
};

const key = (boardTag: string, id: string) => `${boardTag}::${id}`;

function clockAt(clock: Clock, boardTag: string, id: string): number {
  return clock.get(boardTag)?.get(id) ?? 0;
}

function raise(clock: Clock, boardTag: string, id: string, at: number): number {
  let entries = clock.get(boardTag);
  if (!entries) {
    entries = new Map();
    clock.set(boardTag, entries);
  }
  const next = Math.max(entries.get(id) ?? 0, at);
  entries.set(id, next);
  return next;
}

function parseTombstones(raw: string | null): Clock {
  const out: Clock = new Map();
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    if (!parsed || typeof parsed !== "object") return out;
    for (const [boardTag, entries] of Object.entries(parsed)) {
      if (!entries || typeof entries !== "object") continue;
      const map = new Map<string, number>();
      for (const [taskId, at] of Object.entries(entries)) {
        if (typeof at === "number" && at > 0) map.set(taskId, at);
      }
      if (map.size) out.set(boardTag, map);
    }
  } catch {
    // Unreadable tombstones only weaken protection after a reload; in-session state still holds.
  }
  return out;
}

export class BoardSyncLedger {
  private readonly boardMeta = new Map<string, number>();
  private readonly tasks: Clock = new Map();
  private readonly events: Clock = new Map();
  private readonly pendingTasks = new Set<string>();
  private readonly pendingEvents = new Set<string>();
  private readonly tombstones: Clock;
  private persistScheduled = false;

  constructor(
    private readonly storage: TombstoneStorage,
    private readonly tombstonesPerBoard = 500,
  ) {
    this.tombstones = parseTombstones(storage.load());
    // A deleted task's clock starts at its deletion, so older versions are rejected after a reload.
    for (const [boardTag, entries] of this.tombstones) {
      for (const [taskId, at] of entries) raise(this.tasks, boardTag, taskId, at);
    }
  }

  // ---- Tasks ----

  taskAt(boardTag: string, taskId: string): number {
    return clockAt(this.tasks, boardTag, taskId);
  }

  /** Records a version of the task (published or seen); the clock never moves back. */
  noteTask(boardTag: string, taskId: string, at: number): number {
    return raise(this.tasks, boardTag, taskId, at);
  }

  /**
   * Starts a local publish: picks a `created_at` newer than every version known (including the
   * one stored with the task) and marks the task pending until `settleTask`.
   */
  reserveTaskPublish(boardTag: string, taskId: string, storedAt: number, nowSeconds: number): number {
    const current = Math.max(this.taskAt(boardTag, taskId), storedAt);
    const at = reserveTaskMutationTimestamp(nowSeconds, current);
    raise(this.tasks, boardTag, taskId, at);
    this.pendingTasks.add(key(boardTag, taskId));
    return at;
  }

  isTaskPending(boardTag: string, taskId: string): boolean {
    return this.pendingTasks.has(key(boardTag, taskId));
  }

  settleTask(boardTag: string, taskId: string): void {
    this.pendingTasks.delete(key(boardTag, taskId));
  }

  /** Whether an incoming task event is current: newer, or as new while nothing local is pending. */
  isTaskEventCurrent(boardTag: string, taskId: string, createdAt: number): boolean {
    const last = this.taskAt(boardTag, taskId);
    if (createdAt < last) return false;
    return !(createdAt === last && this.isTaskPending(boardTag, taskId));
  }

  /** Applies the acceptance rule and, when the event is current, records it. */
  acceptTaskEvent(boardTag: string, taskId: string, createdAt: number): boolean {
    if (!this.isTaskEventCurrent(boardTag, taskId, createdAt)) return false;
    raise(this.tasks, boardTag, taskId, createdAt);
    return true;
  }

  /** How many tasks on a board have a known version (sync progress heuristics). */
  taskCount(boardTag: string): number {
    return this.tasks.get(boardTag)?.size ?? 0;
  }

  // ---- Calendar events ----

  eventAt(boardTag: string, eventId: string): number {
    return clockAt(this.events, boardTag, eventId);
  }

  noteEvent(boardTag: string, eventId: string, at: number): number {
    return raise(this.events, boardTag, eventId, at);
  }

  markEventPending(boardTag: string, eventId: string): void {
    this.pendingEvents.add(key(boardTag, eventId));
  }

  settleEvent(boardTag: string, eventId: string): void {
    this.pendingEvents.delete(key(boardTag, eventId));
  }

  acceptCalendarEvent(boardTag: string, eventId: string, createdAt: number): boolean {
    const last = this.eventAt(boardTag, eventId);
    if (createdAt < last) return false;
    if (createdAt === last && this.pendingEvents.has(key(boardTag, eventId))) return false;
    raise(this.events, boardTag, eventId, createdAt);
    return true;
  }

  // ---- Board metadata ----

  noteBoardMeta(boardTag: string, at: number): void {
    this.boardMeta.set(boardTag, Math.max(this.boardMeta.get(boardTag) ?? 0, at));
  }

  /** Board metadata is replaceable: an event as new as the last one still applies. */
  acceptBoardMeta(boardTag: string, createdAt: number): boolean {
    if (createdAt < (this.boardMeta.get(boardTag) ?? 0)) return false;
    this.boardMeta.set(boardTag, createdAt);
    return true;
  }

  // ---- Tombstones ----

  isTombstoned(boardTag: string, taskId: string): boolean {
    return !!this.tombstones.get(boardTag)?.has(taskId);
  }

  /** Remembers a deletion across reloads (newest kept); saved once per tick. */
  recordTombstone(boardTag: string, taskId: string, at: number): void {
    if (!boardTag || !taskId || !Number.isFinite(at) || at <= 0) return;
    let entries = this.tombstones.get(boardTag);
    if (!entries) {
      entries = new Map();
      this.tombstones.set(boardTag, entries);
    }
    if ((entries.get(taskId) ?? 0) >= at) return;
    entries.set(taskId, at);
    // Trimmed in steps: deletions from other devices arrive by the thousand on a first sync.
    if (entries.size > this.tombstonesPerBoard + 100) {
      this.tombstones.set(
        boardTag,
        new Map([...entries].sort((a, b) => b[1] - a[1]).slice(0, this.tombstonesPerBoard)),
      );
    }
    this.schedulePersist();
  }

  /** Forgets a deletion (the task was restored) and saves at once. */
  clearTombstone(boardTag: string, taskId: string): void {
    const entries = this.tombstones.get(boardTag);
    if (!entries?.delete(taskId)) return;
    if (!entries.size) this.tombstones.delete(boardTag);
    this.persist();
  }

  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      this.persist();
    });
  }

  private persist(): void {
    const out: Record<string, Record<string, number>> = {};
    for (const [boardTag, entries] of this.tombstones) {
      if (entries.size) out[boardTag] = Object.fromEntries(entries);
    }
    try {
      this.storage.save(JSON.stringify(out));
    } catch (err) {
      console.warn("[tombstones] failed to persist", err);
    }
  }
}
