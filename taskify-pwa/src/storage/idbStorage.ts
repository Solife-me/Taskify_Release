/**
 * `idbStorage`
 * ------------
 * Durable, async storage primitives backed by IndexedDB.
 *
 * This module is intentionally domain-agnostic (no wallet/task/nostr knowledge).
 * It is responsible only for:
 * - Opening databases (with optional upgrade hooks)
 * - Running transactions
 * - Basic CRUD helpers for object stores
 *
 * IMPORTANT: This is the only module in the codebase that may touch `indexedDB`.
 */

export type IdbOpenOptions = {
  name: string;
  version?: number;
  /**
   * Optional upgrade hook invoked during `onupgradeneeded`.
   * Use this to create object stores and indexes.
   */
  upgrade?: (
    db: IDBDatabase,
    oldVersion: number,
    newVersion: number | null,
    transaction: IDBTransaction,
    event: IDBVersionChangeEvent,
  ) => void;
  /**
   * Fired if the open request is blocked by another open connection.
   */
  blocked?: (event: IDBVersionChangeEvent) => void;
};

function ensureIndexedDb(): IDBFactory {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment");
  }
  return indexedDB;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

export const idbStorage = {
  /**
   * Opens (or creates) an IndexedDB database.
   */
  async openDatabase(options: IdbOpenOptions): Promise<IDBDatabase> {
    const factory = ensureIndexedDb();
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request =
        options.version === undefined
          ? factory.open(options.name)
          : factory.open(options.name, options.version);

      request.onupgradeneeded = (event) => {
        try {
          options.upgrade?.(request.result, event.oldVersion, event.newVersion, request.transaction!, event);
        } catch (error) {
          reject(error);
        }
      };

      request.onblocked = (event) => {
        try {
          options.blocked?.(event);
        } catch {
          // ignore user handler errors for blocked events
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB database"));
    });
  },

  /**
   * Deletes an IndexedDB database by name.
   */
  async deleteDatabase(name: string): Promise<void> {
    const factory = ensureIndexedDb();
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Failed to delete IndexedDB database"));
      request.onblocked = () => resolve();
    });
  },

  /**
   * Runs a transaction and resolves once it fully commits (or rejects on abort/error).
   *
   * Note: Do not `await` unrelated work inside `fn` before enqueuing IDB requests,
   * otherwise the transaction may auto-close before additional requests are created.
   */
  async transaction<T>(
    db: IDBDatabase,
    storeNames: string | string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const tx = db.transaction(storeNames, mode);
    const done = transactionDone(tx);
    try {
      const result = await fn(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // ignore abort errors
      }
      await done.catch(() => undefined);
      throw error;
    }
  },

  /**
   * Reads a single value by key from an object store.
   */
  async get<T = unknown>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
    return await idbStorage.transaction(db, storeName, "readonly", async (tx) => {
      const store = tx.objectStore(storeName);
      return await requestToPromise<T | undefined>(store.get(key) as IDBRequest<T | undefined>);
    });
  },

  /**
   * Reads several values from one object store in a single transaction.
   * Keeping all requests in the same transaction substantially reduces
   * startup overhead compared with opening one readonly transaction per key.
   * Results preserve the order of `keys`.
   */
  async getMany<T = unknown>(
    db: IDBDatabase,
    storeName: string,
    keys: readonly IDBValidKey[],
  ): Promise<Array<T | undefined>> {
    if (keys.length === 0) return [];
    return await idbStorage.transaction(db, storeName, "readonly", (tx) => {
      const store = tx.objectStore(storeName);
      // Enqueue every request synchronously so the transaction cannot become
      // inactive between individual reads.
      const requests = keys.map((key) =>
        requestToPromise<T | undefined>(store.get(key) as IDBRequest<T | undefined>),
      );
      return Promise.all(requests);
    });
  },

  /**
   * Writes a value to an object store (insert or update).
   */
  async put<T = unknown>(
    db: IDBDatabase,
    storeName: string,
    value: T,
    key?: IDBValidKey,
  ): Promise<IDBValidKey> {
    return await idbStorage.transaction(db, storeName, "readwrite", async (tx) => {
      const store = tx.objectStore(storeName);
      return await requestToPromise<IDBValidKey>(key === undefined ? store.put(value as any) : store.put(value as any, key));
    });
  },

  /**
   * Adds a value to an object store (fails if key already exists).
   */
  async add<T = unknown>(
    db: IDBDatabase,
    storeName: string,
    value: T,
    key?: IDBValidKey,
  ): Promise<IDBValidKey> {
    return await idbStorage.transaction(db, storeName, "readwrite", async (tx) => {
      const store = tx.objectStore(storeName);
      return await requestToPromise<IDBValidKey>(key === undefined ? store.add(value as any) : store.add(value as any, key));
    });
  },

  /**
   * Deletes a single key from an object store.
   */
  async delete(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<void> {
    await idbStorage.transaction(db, storeName, "readwrite", async (tx) => {
      const store = tx.objectStore(storeName);
      await requestToPromise<void>(store.delete(key) as unknown as IDBRequest<void>);
    });
  },

  /**
   * Clears all records from an object store.
   */
  async clear(db: IDBDatabase, storeName: string): Promise<void> {
    await idbStorage.transaction(db, storeName, "readwrite", async (tx) => {
      const store = tx.objectStore(storeName);
      await requestToPromise<void>(store.clear() as unknown as IDBRequest<void>);
    });
  },

  /**
   * Reads all values from an object store (optionally filtered by a query).
   */
  async getAll<T = unknown>(
    db: IDBDatabase,
    storeName: string,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<T[]> {
    return await idbStorage.transaction(db, storeName, "readonly", async (tx) => {
      const store = tx.objectStore(storeName);
      return await requestToPromise<T[]>(
        store.getAll(query === undefined ? null : query, count) as unknown as IDBRequest<T[]>,
      );
    });
  },
};
