import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskifyDb: vi.fn(async () => ({ name: "fake-db" })),
  getMany: vi.fn(async (_db: unknown, _storeName: string, keys: readonly IDBValidKey[]) =>
    keys.map((key) => `value:${String(key)}`),
  ),
  put: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
}));

vi.mock("./taskifyDb.ts", () => ({
  getTaskifyDb: mocks.getTaskifyDb,
}));

vi.mock("./idbStorage.ts", () => ({
  idbStorage: {
    getMany: mocks.getMany,
    put: mocks.put,
    delete: mocks.delete,
  },
}));

import { getLatestIndexedDbFailure, idbKeyValue, subscribeToIndexedDbFailures } from "./idbKeyValue";

describe("idbKeyValue startup loading", () => {
  beforeEach(() => {
    mocks.getTaskifyDb.mockClear();
    mocks.getMany.mockClear();
    mocks.put.mockClear();
    mocks.put.mockResolvedValue(undefined);
    mocks.delete.mockClear();
    mocks.delete.mockResolvedValue(undefined);
  });

  it("loads all uncached keys for a store in one batched transaction", async () => {
    const storeName = `batch-${crypto.randomUUID()}`;

    await idbKeyValue.initStore(storeName, ["alpha", "beta", "alpha"]);

    expect(mocks.getTaskifyDb).toHaveBeenCalledTimes(1);
    expect(mocks.getMany).toHaveBeenCalledTimes(1);
    expect(mocks.getMany.mock.calls[0]?.[2]).toEqual(["alpha", "beta"]);
    expect(idbKeyValue.getItem(storeName, "alpha")).toBe("value:alpha");
    expect(idbKeyValue.getItem(storeName, "beta")).toBe("value:beta");

    // Already-loaded keys do not create another IndexedDB transaction.
    await idbKeyValue.initStore(storeName, ["alpha", "beta"]);
    expect(mocks.getMany).toHaveBeenCalledTimes(1);

    // A later uncached key is loaded in one additional batch by itself.
    await idbKeyValue.initStore(storeName, ["beta", "gamma"]);
    expect(mocks.getMany).toHaveBeenCalledTimes(2);
    expect(mocks.getMany.mock.calls[1]?.[2]).toEqual(["gamma"]);
  });

  it("reports a failed write to the UI and still rejects the next flush", async () => {
    const storeName = `write-failure-${crypto.randomUUID()}`;
    const listener = vi.fn();
    const unsubscribe = subscribeToIndexedDbFailures(listener);
    mocks.put.mockRejectedValueOnce(new Error("quota exceeded"));

    idbKeyValue.setItem(storeName, "key", "value");
    await expect(idbKeyValue.flushStore(storeName)).rejects.toThrow("quota exceeded");

    expect(listener).toHaveBeenCalled();
    expect(getLatestIndexedDbFailure()).toMatchObject({ operation: "write", storeName });
    unsubscribe();
  });
});
