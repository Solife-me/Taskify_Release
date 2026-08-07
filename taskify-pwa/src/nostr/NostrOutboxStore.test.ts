import { describe, expect, it, vi } from "vitest";
import type { NostrOutboxMutation } from "taskify-runtime-nostr";

const mocks = vi.hoisted(() => {
  const backingRows = new Map<string, NostrOutboxMutation>();
  return {
    backingRows,
    getAll: vi.fn(async () => Array.from(backingRows.values())),
    get: vi.fn(async (_db: unknown, _store: string, id: IDBValidKey) => backingRows.get(String(id))),
    put: vi.fn(async (_db: unknown, _store: string, row: NostrOutboxMutation) => {
      backingRows.set(row.id, row);
    }),
    delete: vi.fn(async (_db: unknown, _store: string, id: IDBValidKey) => {
      backingRows.delete(String(id));
    }),
  };
});

vi.mock("../storage/taskifyDb", () => ({
  getTaskifyDb: vi.fn(async () => ({ name: "fake-db" })),
  TASKIFY_STORE_MUTATIONS: "mutations",
}));

vi.mock("../storage/idbStorage", () => ({
  idbStorage: mocks,
}));

import { nostrOutboxStore } from "./NostrOutboxStore";

function mutation(id: string, intentAt: number): NostrOutboxMutation {
  return {
    id,
    kind: "nostr.publish",
    payload: {
      event: {
        id: `event-${id}`.padEnd(64, "0").slice(0, 64),
        pubkey: "1".repeat(64),
        created_at: 1_700_000_000,
        kind: 1,
        tags: [],
        content: id,
        sig: "2".repeat(128),
      },
      relayUrls: ["wss://relay.example"],
      replaceableKey: null,
    },
    intentAt,
    attempts: 0,
    lastError: null,
    ackedRelays: [],
    pendingRelays: ["wss://relay.example"],
    nextAttemptAt: null,
    updatedAt: intentAt,
  };
}

describe("nostrOutboxStore cache", () => {
  it("loads once, updates incrementally, and notifies without rescanning IndexedDB", async () => {
    mocks.backingRows.clear();
    mocks.backingRows.set("initial", mutation("initial", 20));

    expect((await nostrOutboxStore.getPendingRows()).map((row) => row.id)).toEqual(["initial"]);
    expect(mocks.getAll).toHaveBeenCalledTimes(1);

    let latestRows: NostrOutboxMutation[] = [];
    const unsubscribe = nostrOutboxStore.subscribeRows((rows) => {
      latestRows = rows;
    });

    await nostrOutboxStore.put(mutation("earlier", 10));
    await nostrOutboxStore.put(mutation("later", 30));
    await vi.waitFor(() => expect(latestRows.map((row) => row.id)).toEqual(["earlier", "initial", "later"]));
    expect(mocks.getAll).toHaveBeenCalledTimes(1);

    await nostrOutboxStore.delete("initial");
    await vi.waitFor(() => expect(latestRows.map((row) => row.id)).toEqual(["earlier", "later"]));
    expect(mocks.getAll).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
