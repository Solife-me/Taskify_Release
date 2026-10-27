/**
 * The message events this device has already opened and applied (chat messages, reactions,
 * shares handed to the inbox), kept across reloads so a launch decrypts only what is new. With
 * a remote signer every decryption is a round trip, so this is what keeps sign-in cost bounded.
 *
 * A Set that saves itself: the newest `limit` ids are kept (older ones, if a relay sends them
 * again, are simply opened again and applied idempotently). Saves are coalesced.
 */
export type SeenEventsStorage = { load: () => string | null; save: (value: string) => void };

export const SEEN_EVENTS_LIMIT = 10_000;

export class PersistedIdSet extends Set<string> {
  private readonly storage: SeenEventsStorage;
  private readonly limit: number;
  private readonly schedule: (run: () => void) => void;
  private saveQueued = false;
  private loading = true;

  constructor(
    storage: SeenEventsStorage,
    options: { limit?: number; schedule?: (run: () => void) => void } = {},
  ) {
    super();
    this.storage = storage;
    this.limit = options.limit ?? SEEN_EVENTS_LIMIT;
    this.schedule = options.schedule ?? ((run) => { setTimeout(run, 500); });
    try {
      const parsed = JSON.parse(storage.load() ?? "[]");
      if (Array.isArray(parsed)) {
        for (const id of parsed.slice(-this.limit)) if (typeof id === "string" && id) super.add(id);
      }
    } catch {
      // unreadable: start empty
    }
    this.loading = false;
  }

  override add(id: string): this {
    if (super.has(id)) return this;
    super.add(id);
    if (this.loading) return this;
    // Sets iterate in insertion order, so the first entries are the oldest.
    while (this.size > this.limit) {
      const oldest = this.values().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    this.queueSave();
    return this;
  }

  override delete(id: string): boolean {
    const removed = super.delete(id);
    if (removed) this.queueSave();
    return removed;
  }

  override clear(): void {
    super.clear();
    this.queueSave();
  }

  /** Writes now (also what the coalesced save runs). */
  flush(): void {
    this.saveQueued = false;
    try {
      this.storage.save(JSON.stringify(Array.from(this)));
    } catch {
      // storage full: ids are re-learned by opening the messages again
    }
  }

  private queueSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.schedule(() => this.flush());
  }
}
