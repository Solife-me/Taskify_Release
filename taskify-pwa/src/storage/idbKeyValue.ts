import { idbStorage } from "./idbStorage.ts";
import { getTaskifyDb } from "./taskifyDb.ts";

type StoreState = {
  loaded: Set<string>;
  values: Map<string, string>;
  writeChain: Promise<void>;
  failureCount: number;
  acknowledgedFailureCount: number;
  lastWriteError: unknown;
};

const stores = new Map<string, StoreState>();

function getStoreState(storeName: string): StoreState {
  const existing = stores.get(storeName);
  if (existing) return existing;
  const created: StoreState = {
    loaded: new Set(),
    values: new Map(),
    writeChain: Promise.resolve(),
    failureCount: 0,
    acknowledgedFailureCount: 0,
    lastWriteError: null,
  };
  stores.set(storeName, created);
  return created;
}

function queueWrite(storeName: string, fn: () => Promise<void>): void {
  const state = getStoreState(storeName);
  state.writeChain = state.writeChain
    .then(async () => {
      await fn();
    })
    .catch((err) => {
      state.failureCount += 1;
      state.lastWriteError = err;
      console.warn(`[idbKeyValue] Write failed for store "${storeName}":`, err);
    });
}

function assertNoUnacknowledgedWriteFailure(state: StoreState): void {
  if (state.failureCount <= state.acknowledgedFailureCount) return;
  state.acknowledgedFailureCount = state.failureCount;
  throw state.lastWriteError instanceof Error
    ? state.lastWriteError
    : new Error("IndexedDB write failed");
}

export const idbKeyValue = {
  async initStore(storeName: string, keys: string[]): Promise<void> {
    const state = getStoreState(storeName);
    const uniqueKeys = Array.from(
      new Set(
        (Array.isArray(keys) ? keys : [])
          .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
          .map((key) => key.trim()),
      ),
    );

    const keysToLoad = uniqueKeys.filter((key) => !state.loaded.has(key));
    if (keysToLoad.length === 0) return;

    let values: Array<string | undefined>;
    try {
      const db = await getTaskifyDb();
      values = await idbStorage.getMany<string>(db, storeName, keysToLoad);
    } catch {
      values = keysToLoad.map(() => undefined);
    }

    keysToLoad.forEach((key, index) => {
      const raw = values[index];
      if (typeof raw === "string") {
        state.values.set(key, raw);
      } else {
        state.values.delete(key);
      }
      state.loaded.add(key);
    });
  },

  getItem(storeName: string, key: string): string | null {
    const state = getStoreState(storeName);
    if (!state.loaded.has(key)) return null;
    return state.values.get(key) ?? null;
  },

  setItem(storeName: string, key: string, value: string): void {
    const state = getStoreState(storeName);
    state.loaded.add(key);
    state.values.set(key, value);
    queueWrite(storeName, async () => {
      const db = await getTaskifyDb();
      await idbStorage.put<string>(db, storeName, value, key);
    });
  },

  removeItem(storeName: string, key: string): void {
    const state = getStoreState(storeName);
    state.loaded.add(key);
    state.values.delete(key);
    queueWrite(storeName, async () => {
      const db = await getTaskifyDb();
      await idbStorage.delete(db, storeName, key);
    });
  },

  async flushStore(storeName: string): Promise<void> {
    const state = getStoreState(storeName);
    await state.writeChain;
    assertNoUnacknowledgedWriteFailure(state);
  },

  async flushAll(): Promise<void> {
    await Promise.all(Array.from(stores.values()).map((state) => state.writeChain));
    for (const state of stores.values()) {
      assertNoUnacknowledgedWriteFailure(state);
    }
  },
};
