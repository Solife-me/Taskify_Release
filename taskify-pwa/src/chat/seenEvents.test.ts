import { describe, expect, test } from "vitest";
import { PersistedIdSet } from "./seenEvents";

function memory(initial: string | null = null) {
  let value = initial;
  let saves = 0;
  return {
    storage: { load: () => value, save: (next: string) => { value = next; saves += 1; } },
    saves: () => saves,
  };
}

describe("PersistedIdSet", () => {
  test("ids survive a reload", () => {
    const store = memory();
    const first = new PersistedIdSet(store.storage, { schedule: (run) => run() });
    first.add("wrap-1").add("wrap-2");
    const second = new PersistedIdSet(store.storage);
    expect([...second]).toEqual(["wrap-1", "wrap-2"]);
  });

  test("saves are coalesced", () => {
    const store = memory();
    const queued: Array<() => void> = [];
    const set = new PersistedIdSet(store.storage, { schedule: (run) => queued.push(run) });
    set.add("a");
    set.add("b");
    set.add("a");
    expect(queued).toHaveLength(1);
    queued[0]();
    expect(store.saves()).toBe(1);
    expect(new PersistedIdSet(store.storage).has("b")).toBe(true);
  });

  test("keeps the newest ids within its limit", () => {
    const store = memory();
    const set = new PersistedIdSet(store.storage, { limit: 3, schedule: (run) => run() });
    ["1", "2", "3", "4"].forEach((id) => set.add(id));
    expect([...set]).toEqual(["2", "3", "4"]);
    expect([...new PersistedIdSet(store.storage, { limit: 3 })]).toEqual(["2", "3", "4"]);
  });

  test("unreadable storage starts empty; loading does not write", () => {
    const store = memory("not json");
    expect(new PersistedIdSet(store.storage).size).toBe(0);
    const loaded = memory(JSON.stringify(["x"]));
    new PersistedIdSet(loaded.storage);
    expect(loaded.saves()).toBe(0);
  });
});
