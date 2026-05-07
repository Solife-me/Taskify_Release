import type { NostrOutboxMutation, NostrOutboxStore } from "taskify-runtime-nostr";
import { idbStorage } from "../storage/idbStorage";
import { getTaskifyDb, TASKIFY_STORE_MUTATIONS } from "../storage/taskifyDb";

type OutboxListener = (pendingCount: number) => void;

const listeners = new Set<OutboxListener>();

function isOutboxMutation(value: unknown): value is NostrOutboxMutation {
  const candidate = value as NostrOutboxMutation | undefined;
  return (
    !!candidate &&
    typeof candidate.id === "string" &&
    candidate.kind === "nostr.publish" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
}

function sortPending(rows: NostrOutboxMutation[]): NostrOutboxMutation[] {
  return rows.sort((a, b) => (a.intentAt || 0) - (b.intentAt || 0));
}

async function listPendingRows(): Promise<NostrOutboxMutation[]> {
  try {
    const db = await getTaskifyDb();
    const rows = await idbStorage.getAll<unknown>(db, TASKIFY_STORE_MUTATIONS);
    return sortPending(rows.filter(isOutboxMutation));
  } catch {
    return [];
  }
}

async function pendingCount(): Promise<number> {
  return (await listPendingRows()).length;
}

function notifyListeners(): void {
  void pendingCount().then((count) => {
    listeners.forEach((listener) => {
      try {
        listener(count);
      } catch {
        // ignore listener errors
      }
    });
  });
}

export const nostrOutboxStore: NostrOutboxStore & {
  getPendingCount: () => Promise<number>;
  subscribe: (listener: OutboxListener) => () => void;
} = {
  async get(id) {
    try {
      const db = await getTaskifyDb();
      const value = await idbStorage.get<unknown>(db, TASKIFY_STORE_MUTATIONS, id);
      return isOutboxMutation(value) ? value : undefined;
    } catch {
      return undefined;
    }
  },

  async put(mutation) {
    const db = await getTaskifyDb();
    await idbStorage.put<NostrOutboxMutation>(db, TASKIFY_STORE_MUTATIONS, mutation);
    notifyListeners();
  },

  async delete(id) {
    const db = await getTaskifyDb();
    await idbStorage.delete(db, TASKIFY_STORE_MUTATIONS, id);
    notifyListeners();
  },

  async listPending() {
    return await listPendingRows();
  },

  async getPendingCount() {
    return await pendingCount();
  },

  subscribe(listener) {
    listeners.add(listener);
    void pendingCount().then(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
