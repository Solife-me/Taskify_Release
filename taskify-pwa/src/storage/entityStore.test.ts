// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// In-memory fake of the per-store IDB primitives. Only models the operations
// that EntityStore actually uses: getAll for load, transaction for the
// readwrite path with put/delete/clear, plus the transaction wrapper that
// runs an inline function.
type StoredRow = { id: string; [key: string]: unknown };
const stores: Record<string, Map<string, StoredRow>> = {};
let transactionFailuresRemaining = 0;

function getStore(name: string): Map<string, StoredRow> {
  if (!stores[name]) stores[name] = new Map();
  return stores[name];
}

vi.mock("./idbStorage", () => ({
  idbStorage: {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(async (_db: unknown, name: string) => Array.from(getStore(name).values())),
    transaction: vi.fn(async (_db: unknown, name: string, _mode: unknown, fn: (tx: unknown) => unknown) => {
      if (transactionFailuresRemaining > 0) {
        transactionFailuresRemaining -= 1;
        throw new Error("transient IndexedDB failure");
      }
      const store = getStore(name);
      const tx = {
        objectStore: () => ({
          put: (entity: StoredRow) => store.set(entity.id, entity),
          delete: (id: string) => store.delete(id),
          clear: () => store.clear(),
        }),
      };
      await fn(tx);
    }),
  },
}));
vi.mock("./taskifyDb", async () => {
  const actual = await vi.importActual<typeof import("./taskifyDb")>("./taskifyDb");
  return { ...actual, getTaskifyDb: vi.fn(async () => ({} as IDBDatabase)) };
});

import { EntityStore, STORE_TASKS_V2 } from "./entityStore";

type Row = { id: string; n: number };
let s: EntityStore<Row>;

beforeEach(() => {
  transactionFailuresRemaining = 0;
  for (const name of Object.keys(stores)) stores[name].clear();
  s = new EntityStore<Row>(STORE_TASKS_V2);
});
afterEach(() => {
  for (const name of Object.keys(stores)) stores[name].clear();
});

describe("EntityStore", () => {
  test("load populates cache from IDB", async () => {
    const idbStore = getStore(STORE_TASKS_V2);
    idbStore.set("a", { id: "a", n: 1 });
    idbStore.set("b", { id: "b", n: 2 });

    await s.load();
    expect(s.size()).toBe(2);
    expect(s.getById("a")).toEqual({ id: "a", n: 1 });
    expect(s.getById("b")).toEqual({ id: "b", n: 2 });
  });

  test("syncWith writes only changed rows (reference equality)", async () => {
    const a1: Row = { id: "a", n: 1 };
    const b1: Row = { id: "b", n: 1 };
    s.syncWith([a1, b1]);
    await s.flush();

    const idbStore = getStore(STORE_TASKS_V2);
    expect(idbStore.size).toBe(2);

    // Same references → no write.
    s.syncWith([a1, b1]);
    await s.flush();
    expect(idbStore.size).toBe(2);

    // New reference for one row → only that row is rewritten.
    const a2: Row = { id: "a", n: 2 };
    s.syncWith([a2, b1]);
    await s.flush();
    expect(idbStore.get("a")).toEqual(a2);
    expect(idbStore.get("b")).toEqual(b1);
  });

  test("syncWith deletes rows removed from the next array", async () => {
    const a: Row = { id: "a", n: 1 };
    const b: Row = { id: "b", n: 2 };
    s.syncWith([a, b]);
    await s.flush();

    s.syncWith([a]); // dropped b
    await s.flush();

    const idbStore = getStore(STORE_TASKS_V2);
    expect(idbStore.has("a")).toBe(true);
    expect(idbStore.has("b")).toBe(false);
  });

  test("syncWith retries transient write failures before reporting success", async () => {
    transactionFailuresRemaining = 1;
    const row: Row = { id: "a", n: 1 };
    s.syncWith([row]);

    await expect(s.flush()).resolves.toBeUndefined();
    expect(getStore(STORE_TASKS_V2).get("a")).toEqual(row);
  });

  test("flush rejects after repeated write failures", async () => {
    transactionFailuresRemaining = 3;
    s.syncWith([{ id: "a", n: 1 }]);

    await expect(s.flush()).rejects.toThrow("transient IndexedDB failure");
    expect(getStore(STORE_TASKS_V2).has("a")).toBe(false);
  });

  test("getAll returns the in-memory cache after sync", async () => {
    const rows: Row[] = [
      { id: "a", n: 1 },
      { id: "b", n: 2 },
      { id: "c", n: 3 },
    ];
    s.syncWith(rows);
    expect(s.getAll()).toHaveLength(3);
    expect(new Set(s.getAll().map((r) => r.id))).toEqual(new Set(["a", "b", "c"]));
  });

  test("migrateFromBlob populates an empty store from a JSON-array string", async () => {
    await s.load();
    expect(s.size()).toBe(0);

    const blob = JSON.stringify([
      { id: "a", n: 10 },
      { id: "b", n: 20 },
    ]);
    const inserted = await s.migrateFromBlob(blob);
    expect(inserted).toBe(2);
    expect(s.size()).toBe(2);
    expect(getStore(STORE_TASKS_V2).size).toBe(2);
  });

  test("migrateFromBlob is idempotent — does not run when store has rows", async () => {
    getStore(STORE_TASKS_V2).set("a", { id: "a", n: 1 });
    await s.load();
    expect(s.size()).toBe(1);

    const inserted = await s.migrateFromBlob(JSON.stringify([{ id: "x", n: 99 }]));
    expect(inserted).toBe(0);
    expect(s.size()).toBe(1); // unchanged
    expect(s.getById("x")).toBeUndefined();
  });

  test("migrateFromBlob handles malformed input gracefully", async () => {
    await s.load();
    expect(await s.migrateFromBlob(null)).toBe(0);
    expect(await s.migrateFromBlob("")).toBe(0);
    expect(await s.migrateFromBlob("not json")).toBe(0);
    expect(await s.migrateFromBlob('{"not":"an array"}')).toBe(0);
    expect(await s.migrateFromBlob('[1,2,3]')).toBe(0); // no `id` fields
    expect(s.size()).toBe(0);
  });

  test("replaceAll clears existing rows before writing the new set", async () => {
    s.syncWith([{ id: "a", n: 1 }, { id: "b", n: 2 }]);
    await s.flush();
    expect(getStore(STORE_TASKS_V2).size).toBe(2);

    s.replaceAll([{ id: "c", n: 3 }]);
    await s.flush();

    const idb = getStore(STORE_TASKS_V2);
    expect(idb.has("a")).toBe(false);
    expect(idb.has("b")).toBe(false);
    expect(idb.get("c")).toEqual({ id: "c", n: 3 });
    expect(s.getAll()).toEqual([{ id: "c", n: 3 }]);
  });

  test("entries without a string id are silently dropped", async () => {
    const invalidRows: unknown[] = [
      { id: "a", n: 1 },
      { id: 42, n: 2 },
      null,
    ];
    s.syncWith(invalidRows as Row[]);
    await s.flush();
    expect(s.size()).toBe(1);
    expect(s.getById("a")).toEqual({ id: "a", n: 1 });
  });
});
