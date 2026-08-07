/**
 * `entityStore`
 * -------------
 * Per-entity IDB storage for tasks/boards/calendar events. Replaces the old
 * pattern of serializing the entire array as a single JSON blob in
 * `idbKeyValue` (which produced 1000-row writes on every state change and was
 * crash-unsafe — a half-written blob would lose everything).
 *
 * Each entity type has its own object store, keyed by `id`. The store is
 * loaded into memory once at boot (in `storageBootstrap`) so the existing
 * synchronous `useState` initializers in App.tsx keep working without
 * becoming async. Subsequent writes are diff-based: `syncWith(next)` compares
 * against the in-memory cache by reference and writes only the changed rows
 * (plus deletes ones that are gone). Reference equality is the right
 * granularity — React state updates produce new object references for the
 * specific items that changed.
 *
 * The diff strategy means a single task edit triggers a single tiny IDB
 * write, regardless of how many tasks the user has.
 */

import { idbStorage } from "./idbStorage";
import { getTaskifyDb } from "./taskifyDb";

/** Object store names. Suffixed `_v2` to disambiguate from the legacy
 *  blob storage which lives under string keys in the `tasks` store. */
export const STORE_TASKS_V2 = "tasks_v2";
export const STORE_BOARDS_V2 = "boards_v2";
export const STORE_CALENDAR_EVENTS_V2 = "calendarEvents_v2";
export const STORE_EXTERNAL_CALENDAR_EVENTS_V2 = "externalCalendarEvents_v2";

export const ENTITY_STORE_NAMES = [
  STORE_TASKS_V2,
  STORE_BOARDS_V2,
  STORE_CALENDAR_EVENTS_V2,
  STORE_EXTERNAL_CALENDAR_EVENTS_V2,
] as const;

type WithId = { id: string };

export class EntityStore<T extends WithId> {
  readonly storeName: string;
  /** Latest state requested by the UI. */
  private cache = new Map<string, T>();
  /** Last snapshot known to have committed to IndexedDB. */
  private persistedCache = new Map<string, T>();
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(storeName: string) {
    this.storeName = storeName;
  }

  /** Populate the in-memory cache from IDB. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const db = await getTaskifyDb();
      const all = await idbStorage.getAll<T>(db, this.storeName);
      this.cache.clear();
      for (const entity of all) {
        if (entity && typeof entity.id === "string") {
          this.cache.set(entity.id, entity);
        }
      }
      this.persistedCache = new Map(this.cache);
    } catch (err) {
      console.warn(`[entityStore:${this.storeName}] load failed`, err);
      throw err;
    }
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  size(): number {
    return this.cache.size;
  }

  /** Synchronous read after `load()`. Order is insertion order from IDB,
   *  which is not guaranteed by the spec; callers that need deterministic
   *  ordering should sort by their own field. */
  getAll(): T[] {
    return Array.from(this.cache.values());
  }

  getById(id: string): T | undefined {
    return this.cache.get(id);
  }

  private queueSnapshot(nextMap: Map<string, T>, replaceAll = false): void {
    // A failed operation must not poison later writes. Each queued snapshot
    // diffs against the last *committed* state, never the optimistic UI cache.
    const operation = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        const upserts: T[] = [];
        const deletions: string[] = [];
        if (!replaceAll) {
          for (const [id, entity] of nextMap) {
            if (this.persistedCache.get(id) !== entity) upserts.push(entity);
          }
          for (const id of this.persistedCache.keys()) {
            if (!nextMap.has(id)) deletions.push(id);
          }
          if (upserts.length === 0 && deletions.length === 0) return;
        }

        const persist = async () => {
          const db = await getTaskifyDb();
          await idbStorage.transaction(db, this.storeName, "readwrite", (tx) => {
            const store = tx.objectStore(this.storeName);
            if (replaceAll) store.clear();
            for (const entity of replaceAll ? nextMap.values() : upserts) store.put(entity);
            for (const id of deletions) store.delete(id);
          });
        };

        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await persist();
            this.persistedCache = new Map(nextMap);
            return;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError;
      });
    this.writeChain = operation;
    void operation.catch((err) => {
      console.warn(`[entityStore:${this.storeName}] write failed after retries`, err);
    });
  }

  /**
   * Reconcile the on-disk store with `next`. The UI cache updates immediately,
   * while the durable diff is computed against the last committed snapshot.
   */
  syncWith(next: readonly T[]): void {
    const nextMap = new Map<string, T>();
    for (const entity of next) {
      if (!entity || typeof entity.id !== "string") continue;
      nextMap.set(entity.id, entity);
    }
    this.cache = nextMap;
    this.queueSnapshot(nextMap);
  }

  /** Wait for the most-recently-queued write to settle. Useful for backup
   *  restore which reloads the page right after writing. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Wholesale replace: clear the store and write `next` in one transaction.
   *  Used by backup restore where we want to drop existing rows entirely
   *  rather than diff-merge them against the incoming backup. The cache is
   *  updated synchronously and the IDB write is queued; await `flush()`
   *  before triggering a page reload. */
  replaceAll(next: readonly T[]): void {
    const nextMap = new Map<string, T>();
    for (const entity of next) {
      if (entity && typeof entity.id === "string") nextMap.set(entity.id, entity);
    }
    this.cache = nextMap;
    this.queueSnapshot(nextMap, true);
  }

  /** One-time migration from a legacy JSON-array blob. Idempotent: only runs
   *  when the on-disk store is empty. Returns the count actually inserted. */
  async migrateFromBlob(legacyBlob: string | null | undefined): Promise<number> {
    if (!this.loaded) await this.load();
    if (this.cache.size > 0) return 0;
    if (!legacyBlob) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacyBlob);
    } catch {
      return 0;
    }
    if (!Array.isArray(parsed)) return 0;
    const valid: T[] = [];
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as WithId).id === "string") {
        valid.push(item as T);
      }
    }
    if (valid.length === 0) return 0;
    try {
      const db = await getTaskifyDb();
      await idbStorage.transaction(db, this.storeName, "readwrite", (tx) => {
        const store = tx.objectStore(this.storeName);
        for (const entity of valid) store.put(entity);
      });
      for (const entity of valid) this.cache.set(entity.id, entity);
      this.persistedCache = new Map(this.cache);
      return valid.length;
    } catch (err) {
      console.warn(`[entityStore:${this.storeName}] migration failed`, err);
      throw err;
    }
  }

  /** Test-only: clear in-memory cache + reset loaded flag. Does not touch IDB. */
  __resetForTests(): void {
    this.cache.clear();
    this.persistedCache.clear();
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }
}

// Singleton instances — the App owns these directly. Type parameters are
// supplied at the call site since the entity types live in different domain
// files (taskify-core, lib/documents, etc.).
export const taskEntityStore = new EntityStore<WithId>(STORE_TASKS_V2);
export const boardEntityStore = new EntityStore<WithId>(STORE_BOARDS_V2);
export const calendarEventEntityStore = new EntityStore<WithId>(STORE_CALENDAR_EVENTS_V2);
export const externalCalendarEventEntityStore = new EntityStore<WithId>(STORE_EXTERNAL_CALENDAR_EVENTS_V2);
