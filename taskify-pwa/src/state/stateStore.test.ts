import { describe, expect, it, vi } from "vitest";
import { createStateStore } from "./stateStore";

describe("createStateStore", () => {
  it("applies updaters immediately and exactly once", () => {
    const store = createStateStore([1]);
    const updater = vi.fn((prev: number[]) => [...prev, 2]);
    store.set(updater);
    expect(updater).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual([1, 2]);
    store.set((prev) => [...prev, 3]);
    expect(store.get()).toEqual([1, 2, 3]);
  });

  it("notifies only on a new value", () => {
    const store = createStateStore({ n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((prev) => prev);
    expect(listener).not.toHaveBeenCalled();
    store.set({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tolerates listeners unsubscribing while being notified", () => {
    const store = createStateStore(0);
    const second = vi.fn();
    const unsubscribeSecond = store.subscribe(second);
    store.subscribe(() => unsubscribeSecond());
    store.set(1);
    store.set(2);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
