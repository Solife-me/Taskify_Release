/**
 * Keeps one piece of app state (the Bible tracker, scripture memory) in step across the user's
 * devices through a single encrypted, replaceable Nostr event (NIP-78 app data, one `d` tag).
 *
 * Each device remembers the last version it synced (the base). An incoming copy is three-way
 * merged with the base and the local state, so changes made on both devices since then survive.
 * A sender that never synced says so (`baseTimestamp: 0`); its gaps are then not read as
 * deletions. Local changes are published after a pause (debounced); publishes never overlap,
 * and a change made during one is sent once it finishes. On first use, after the first pull, a
 * device with nothing published yet publishes what it has.
 *
 * Framework-free, so the rules are tested directly (`mergedDocumentSync.test.ts`).
 */

export type SyncState = { lastEventId: string | null; lastTimestamp: number; pubkey: string | null };

export type SyncEvent = { id?: string; kind: number; created_at?: number; content: string; tags: string[][] };

export type MergedDocumentConfig<T> = {
  /** Event `d` tag. */
  dTag: string;
  kind: number;
  /** The payload field holding the document. */
  payloadKey: string;
  sanitize: (raw: unknown) => T;
  /** Three-way merge; `base` is null when either side never synced. */
  merge: (base: T | null, local: T, incoming: T) => T;
  /** A stable string for change detection. */
  syncKey: (state: T) => string;
  /** What goes in the payload (defaults to the state itself). */
  toPayload?: (state: T) => unknown;
  debounceMs?: number;
  /** Tags added after the `d` tag (a client tag). */
  extraTags?: string[][];
};

export type MergedDocumentDeps<T> = {
  /** Persisted sync state and base, per document. */
  storage: {
    loadState: () => SyncState | null;
    saveState: (state: SyncState) => void;
    loadBase: () => unknown;
    saveBase: (base: T | null) => void;
  };
  getLocal: () => T;
  /** Applies a merge to the live state (the updater gets the latest local value). */
  updateLocal: (update: (prev: T) => T) => void;
  encrypt: (payload: Record<string, unknown>) => Promise<string>;
  decrypt: (content: string) => Promise<unknown>;
  /** Publishes and resolves to the event's id and the `created_at` relays hold. */
  publish: (template: { kind: number; content: string; tags: string[][]; created_at: number }) => Promise<{
    eventId: string | null;
    createdAt: number;
  }>;
  /** The newest copy on the relays, or null. */
  fetchLatest: () => Promise<SyncEvent | null>;
  nowSeconds: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  onPublishError?: (error: unknown) => void;
};

const EMPTY_STATE: SyncState = { lastEventId: null, lastTimestamp: 0, pubkey: null };

export class MergedDocumentSync<T> {
  private syncState: SyncState;
  private base: T | null;
  private publishedKey: string | null = null;
  private pullFinished = false;
  private initialPublishDone = false;
  private publishing: Promise<void> | null = null;
  private publishQueued = false;
  private debounceTimer: unknown = null;

  constructor(
    private readonly config: MergedDocumentConfig<T>,
    private readonly deps: MergedDocumentDeps<T>,
  ) {
    this.syncState = deps.storage.loadState() ?? EMPTY_STATE;
    const storedBase = deps.storage.loadBase();
    this.base = storedBase == null ? null : config.sanitize(storedBase);
  }

  get state(): SyncState {
    return this.syncState;
  }

  /** The signed-in key changed: everything synced so far belonged to the previous one. */
  setIdentity(pubkey: string | null): void {
    if (this.syncState.pubkey === pubkey) return;
    const hadIdentity = !!this.syncState.pubkey;
    this.initialPublishDone = false;
    this.pullFinished = false;
    this.publishedKey = null;
    this.publishQueued = false;
    if (hadIdentity) this.setBase(null);
    this.setSyncState({ ...EMPTY_STATE, pubkey });
  }

  /** Fetches and applies the newest copy, then allows publishing. Resolves to whether one existed. */
  async pull(): Promise<boolean> {
    this.pullFinished = false;
    try {
      const latest = await this.deps.fetchLatest();
      if (latest) await this.applyEvent(latest);
      return !!latest;
    } catch {
      return false;
    } finally {
      this.pullFinished = true;
    }
  }

  /** Skips the pull (sync off or blocked) but lets later steps proceed as before. */
  markPullFinished(): void {
    this.pullFinished = true;
  }

  async applyEvent(event: SyncEvent): Promise<void> {
    if (event.kind !== this.config.kind) return;
    if (event.tags.find((tag) => tag[0] === "d")?.[1] !== this.config.dTag) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = (await this.deps.decrypt(event.content)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) return;
    const payloadTs = Math.max(Number(parsed.timestamp) || 0, event.created_at || 0);
    // Our own echo, or older than what this device already has.
    if (event.id && event.id === this.syncState.lastEventId) return;
    if (payloadTs < (this.syncState.lastTimestamp || 0)) return;
    const incoming = this.config.sanitize(parsed[this.config.payloadKey]);
    const base = parsed.baseTimestamp === 0 ? null : this.base;
    this.deps.updateLocal((prev) => this.config.merge(base, prev, incoming));
    this.setBase(incoming);
    // What the relays hold now: if the merge differs, the next local check publishes it.
    this.publishedKey = this.config.syncKey(incoming);
    this.setSyncState({ lastEventId: event.id || null, lastTimestamp: payloadTs, pubkey: this.syncState.pubkey });
  }

  /**
   * Call when the local state may have changed. The first call records the current state as
   * published; later changes publish after the debounce. Also performs the first publish when
   * nothing has been published from this key yet.
   */
  noteLocalChange(): void {
    if (!this.pullFinished || !this.syncState.pubkey) return;
    if (!this.initialPublishDone && (this.syncState.lastTimestamp || 0) === 0) {
      this.initialPublishDone = true;
      this.publishedKey = this.config.syncKey(this.deps.getLocal());
      void this.publishNow();
      return;
    }
    const key = this.config.syncKey(this.deps.getLocal());
    if (this.publishedKey === null) {
      this.publishedKey = key;
      return;
    }
    if (key === this.publishedKey) return;
    if (this.debounceTimer != null) this.deps.clearTimer(this.debounceTimer);
    this.debounceTimer = this.deps.setTimer(() => {
      this.debounceTimer = null;
      void this.publishNow();
    }, this.config.debounceMs ?? 1500);
  }

  /** Cancels a pending debounced publish (the hook unmounting or sync turning off). */
  cancelPending(): void {
    if (this.debounceTimer != null) this.deps.clearTimer(this.debounceTimer);
    this.debounceTimer = null;
  }

  /** Publishes now, or once the publish in progress finishes. */
  publishNow(): Promise<void> {
    if (this.publishing) {
      this.publishQueued = true;
      return this.publishing;
    }
    const run = this.publishOnce()
      .catch((error) => this.deps.onPublishError?.(error))
      .finally(() => {
        this.publishing = null;
        if (!this.publishQueued) return;
        this.publishQueued = false;
        if (this.publishedKey === this.config.syncKey(this.deps.getLocal())) return;
        void this.publishNow();
      });
    this.publishing = run;
    return run;
  }

  private async publishOnce(): Promise<void> {
    if (!this.syncState.pubkey) return;
    const local = this.deps.getLocal();
    const key = this.config.syncKey(local);
    const timestamp = Math.max(this.deps.nowSeconds(), (this.syncState.lastTimestamp || 0) + 1);
    const payload = {
      version: 1,
      timestamp,
      // 0 tells receivers this device never synced, so its gaps are not deletions.
      baseTimestamp: this.base ? this.syncState.lastTimestamp || 0 : 0,
      [this.config.payloadKey]: this.config.toPayload ? this.config.toPayload(local) : local,
    };
    const content = await this.deps.encrypt(payload);
    const { eventId, createdAt } = await this.deps.publish({
      kind: this.config.kind,
      content,
      tags: [["d", this.config.dTag], ...(this.config.extraTags ?? [])],
      created_at: timestamp,
    });
    this.setSyncState({ lastEventId: eventId, lastTimestamp: createdAt || timestamp, pubkey: this.syncState.pubkey });
    this.publishedKey = key;
    this.setBase(local);
  }

  private setBase(next: T | null): void {
    this.base = next;
    this.deps.storage.saveBase(next);
  }

  private setSyncState(next: SyncState): void {
    this.syncState = next;
    this.deps.storage.saveState(next);
  }
}
