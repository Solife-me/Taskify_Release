/**
 * Makes publishing durable from the moment of the change, not from the moment of signing.
 *
 * The runtime outbox keeps *signed* events until relays acknowledge them, but everything before
 * signing (attachment upload, key derivation, encryption) used to run in memory: a failure
 * there (an upload while offline) or a closed tab lost the change for every other device, while
 * this device kept it and showed it as synced.
 *
 * Each publish first records an intent (what to publish: kind, id, board) in storage. A failed
 * attempt keeps the intent and retries with backoff, on `retryNow` (the connection returned) and
 * on `start` (the next launch). A retry publishes the item as it is *now*, so the latest edit
 * goes out; an intent clears only when an attempt for its latest version succeeds, by which
 * point the signed event is in the runtime outbox. Items with an intent stay marked pending.
 *
 * Deletions keep a light snapshot (the item is gone from state), without attachment data.
 * Publishing to a board that is not stored (a share template) is passed straight through, since
 * there is nothing to retry it against later.
 */
import type { Board, CalendarEvent, Task } from "../domains/tasks/taskTypes";

export type PublishOptions = { skipBoardMetadata?: boolean; republish?: boolean };

/** The publisher being made durable (`BoardPublisher`). */
export type PublishTarget = {
  publishTask: (task: Task, board?: Board, options?: PublishOptions) => Promise<void>;
  publishTaskDeleted: (task: Task) => Promise<void>;
  publishCalendarEvent: (event: CalendarEvent, board?: Board, options?: PublishOptions) => Promise<void>;
  publishCalendarEventDeleted: (event: CalendarEvent) => Promise<void>;
};

type IntentKind = "task" | "taskDelete" | "event" | "eventDelete";

type Intent = {
  kind: IntentKind;
  id: string;
  /** A board other than the item's own, when the publish named one. */
  boardId?: string;
  options?: PublishOptions;
  /** Deletions only: the item as it was, without attachments. */
  snapshot?: Task | CalendarEvent;
  queuedAt: number;
  attempts: number;
  nextAt: number;
  lastError?: string;
  /** Bumped by every new publish of the item; only the latest one may clear the intent. */
  gen: number;
};

export type DurablePublisherDeps = {
  target: PublishTarget;
  storage: { load: () => string | null; save: (serialized: string) => void };
  boards: () => Board[];
  task: (id: string) => Task | undefined;
  event: (id: string) => CalendarEvent | undefined;
  now: () => number;
  setTimer: (run: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
  /** An item has (or no longer has) a change waiting to reach the relays. */
  onPending: (kind: "task" | "event", id: string, pending: boolean) => void;
  log?: (message: string, error?: unknown) => void;
};

/** Delays before the 1st, 2nd, 3rd and later retries. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

const keyOf = (kind: IntentKind, id: string) => `${kind}:${id}`;
const itemKind = (kind: IntentKind): "task" | "event" => (kind === "task" || kind === "taskDelete" ? "task" : "event");
const OPPOSITE: Record<IntentKind, IntentKind> = {
  task: "taskDelete",
  taskDelete: "task",
  event: "eventDelete",
  eventDelete: "event",
};

/** A deleted item as a deletion needs it: everything but attachment data. */
function lightSnapshot<T extends Task | CalendarEvent>(item: T): T {
  const { images: _images, documents: _documents, image: _image, ...rest } = item as T & {
    images?: unknown;
    documents?: unknown;
    image?: unknown;
  };
  return rest as T;
}

function parseIntents(raw: string | null): Intent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is Intent =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as Intent).id === "string" &&
        ["task", "taskDelete", "event", "eventDelete"].includes((entry as Intent).kind),
    );
  } catch {
    return [];
  }
}

export class DurablePublisher {
  private readonly intents = new Map<string, Intent>();
  private timer: unknown = null;

  constructor(private readonly deps: DurablePublisherDeps) {
    for (const intent of parseIntents(deps.storage.load())) this.intents.set(keyOf(intent.kind, intent.id), intent);
  }

  /** Marks stored intents pending and sends them (call once the publisher is ready). */
  async start(): Promise<void> {
    for (const intent of this.intents.values()) this.deps.onPending(itemKind(intent.kind), intent.id, true);
    await this.retryNow();
  }

  /** Tries every waiting intent now (for example when the connection returns). */
  async retryNow(): Promise<void> {
    for (const key of Array.from(this.intents.keys())) await this.attempt(key);
    this.schedule();
  }

  intentCount(): number {
    return this.intents.size;
  }

  publishTask(task: Task, board?: Board, options?: PublishOptions): Promise<void> {
    return this.publish("task", task, board, options);
  }

  /**
   * Persists a task change for background publication and returns without waiting for a relay
   * attempt. Editors can close as soon as the intent is accepted by local storage; the task stays
   * visibly pending until the latest version is sent or remains queued for retry.
   */
  queueTask(task: Task, board?: Board, options?: PublishOptions): void {
    const key = keyOf("task", task.id);
    const oppositeKey = keyOf(OPPOSITE.task, task.id);
    const previous = this.intents.get(key);
    const previousOpposite = this.intents.get(oppositeKey);
    const now = this.deps.now();
    this.intents.delete(oppositeKey);
    this.intents.set(key, {
      kind: "task",
      id: task.id,
      ...(board ? { boardId: board.id } : {}),
      ...(options ? { options } : {}),
      queuedAt: previous?.queuedAt ?? now,
      attempts: 0,
      nextAt: now,
      gen: (previous?.gen ?? 0) + 1,
    });
    try {
      this.save(true);
    } catch (error) {
      if (previous) this.intents.set(key, previous);
      else this.intents.delete(key);
      if (previousOpposite) this.intents.set(oppositeKey, previousOpposite);
      throw error;
    }
    this.deps.onPending("task", task.id, true);
    void this.attempt(key, task).finally(() => this.schedule());
  }

  publishTaskDeleted(task: Task): Promise<void> {
    return this.publish("taskDelete", task);
  }

  publishCalendarEvent(event: CalendarEvent, board?: Board, options?: PublishOptions): Promise<void> {
    return this.publish("event", event, board, options);
  }

  publishCalendarEventDeleted(event: CalendarEvent): Promise<void> {
    return this.publish("eventDelete", event);
  }

  private async publish(
    kind: IntentKind,
    item: Task | CalendarEvent,
    board?: Board,
    options?: PublishOptions,
  ): Promise<void> {
    if (board && !this.deps.boards().some((stored) => stored.id === board.id)) {
      // Nothing to retry against later: report the outcome to the caller as before.
      await this.send(kind, item, board, options);
      return;
    }
    const key = keyOf(kind, item.id);
    const opposite = this.intents.get(keyOf(OPPOSITE[kind], item.id));
    if (opposite) this.intents.delete(keyOf(OPPOSITE[kind], item.id));
    const previous = this.intents.get(key);
    const now = this.deps.now();
    this.intents.set(key, {
      kind,
      id: item.id,
      ...(board ? { boardId: board.id } : {}),
      ...(options ? { options } : {}),
      ...(kind === "taskDelete" || kind === "eventDelete" ? { snapshot: lightSnapshot(item) } : {}),
      queuedAt: previous?.queuedAt ?? now,
      attempts: 0,
      nextAt: now,
      gen: (previous?.gen ?? 0) + 1,
    });
    this.save();
    this.deps.onPending(itemKind(kind), item.id, true);
    await this.attempt(key, item);
    this.schedule();
  }

  private send(kind: IntentKind, item: Task | CalendarEvent, board?: Board, options?: PublishOptions): Promise<void> {
    const { target } = this.deps;
    switch (kind) {
      case "task":
        return target.publishTask(item as Task, board, options);
      case "taskDelete":
        return target.publishTaskDeleted(item as Task);
      case "event":
        return target.publishCalendarEvent(item as CalendarEvent, board, options);
      case "eventDelete":
        return target.publishCalendarEventDeleted(item as CalendarEvent);
    }
  }

  private drop(key: string, intent: Intent): void {
    this.intents.delete(key);
    this.save();
    this.deps.onPending(itemKind(intent.kind), intent.id, false);
  }

  private async attempt(key: string, given?: Task | CalendarEvent): Promise<void> {
    const intent = this.intents.get(key);
    if (!intent) return;
    const { gen } = intent;
    const item =
      given ??
      (intent.snapshot ||
        (intent.kind === "task" ? this.deps.task(intent.id) : intent.kind === "event" ? this.deps.event(intent.id) : undefined));
    const board = intent.boardId ? this.deps.boards().find((stored) => stored.id === intent.boardId) : undefined;
    // The item (or the board it was published to) is gone: nothing left to send.
    if (!item || (intent.boardId && !board)) {
      this.drop(key, intent);
      return;
    }
    try {
      await this.send(intent.kind, item, board, intent.options);
      const current = this.intents.get(key);
      if (current && current.gen === gen) this.drop(key, current);
    } catch (error) {
      const current = this.intents.get(key);
      if (!current || current.gen !== gen) return;
      current.attempts += 1;
      current.nextAt = this.deps.now() + BACKOFF_MS[Math.min(current.attempts, BACKOFF_MS.length) - 1];
      current.lastError = error instanceof Error ? error.message : String(error);
      this.save();
      // The publisher clears its own pending mark when an attempt ends; the change still waits.
      this.deps.onPending(itemKind(current.kind), current.id, true);
      this.deps.log?.(`[sync] ${current.kind} ${current.id} not sent yet; retrying`, error);
    }
  }

  private schedule(): void {
    if (this.timer != null) this.deps.clearTimer(this.timer);
    this.timer = null;
    let next = Infinity;
    for (const intent of this.intents.values()) if (intent.attempts > 0) next = Math.min(next, intent.nextAt);
    if (next === Infinity) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.runDue();
    }, Math.max(0, next - this.deps.now()));
  }

  private async runDue(): Promise<void> {
    const now = this.deps.now();
    for (const [key, intent] of Array.from(this.intents)) {
      if (intent.nextAt <= now) await this.attempt(key);
    }
    this.schedule();
  }

  private save(throwOnError = false): void {
    try {
      this.deps.storage.save(JSON.stringify(Array.from(this.intents.values())));
    } catch (error) {
      this.deps.log?.("[sync] could not store publish intents", error);
      if (throwOnError) throw error;
    }
  }
}
