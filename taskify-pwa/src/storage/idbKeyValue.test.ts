import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTaskifyDb: vi.fn(async () => ({ name: "fake-db" })),
  getMany: vi.fn(async (_db: unknown, _storeName: string, keys: readonly IDBValidKey[]) =>
    keys.map((key) => `value:${String(key)}`),
  ),
}));

vi.mock("./taskifyDb.ts", () => ({
  getTaskifyDb: mocks.getTaskifyDb,
}));

vi.mock("./idbStorage.ts", () => ({
  idbStorage: {
    getMany: mocks.getMany,
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  },
}));

import { idbKeyValue } from "./idbKeyValue";

describe("idbKeyValue startup loading", () => {
  beforeEach(() => {
    mocks.getTaskifyDb.mockClear();
    mocks.getMany.mockClear();
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
});
