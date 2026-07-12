import { cloneNostrEvent, type NostrOutboxMutation, type NostrOutboxStore } from "taskify-runtime-nostr";
import { idbStorage } from "../storage/idbStorage";
import { getTaskifyDb, TASKIFY_STORE_MUTATIONS } from "../storage/taskifyDb";

type OutboxListener = (pendingCount: number) => void;
type OutboxRowsListener = (rows: NostrOutboxMutation[]) => void;

const listeners = new Set<OutboxListener>();
const rowListeners = new Set<OutboxRowsListener>();
let notificationQueued = false;
let notificationRefresh: Promise<void> | null = null;
let notificationRequested = false;
let rowsCache: Map<string, NostrOutboxMutation> | null = null;
let rowsLoad: Promise<Map<string, NostrOutboxMutation>> | null = null;
let rowsRevision = 0;

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

function cloneMutation(mutation: NostrOutboxMutation): NostrOutboxMutation {
  return {
    ...mutation,
    payload: {
      ...mutation.payload,
      event: cloneNostrEvent(mutation.payload.event),
      relayUrls: [...mutation.payload.relayUrls],
    },
    ackedRelays: [...mutation.ackedRelays],
    pendingRelays: [...mutation.pendingRelays],
  };
}

async function ensureRowsCache(): Promise<Map<string, NostrOutboxMutation>> {
  if (rowsCache) return rowsCache;
  if (rowsLoad) return rowsLoad;

  const load = (async () => {
    // If a put/delete commits while the initial snapshot is being read, repeat
    // once rather than installing a stale cache over that newer mutation.
    while (true) {
      const revisionAtStart = rowsRevision;
      const db = await getTaskifyDb();
      const rows = await idbStorage.getAll<unknown>(db, TASKIFY_STORE_MUTATIONS);
      const next = new Map<string, NostrOutboxMutation>();
      rows.filter(isOutboxMutation).forEach((row) => next.set(row.id, cloneMutation(row)));
      if (revisionAtStart !== rowsRevision) continue;
      rowsCache = next;
      return next;
    }
  })();
  rowsLoad = load;
  try {
    return await load;
  } finally {
    if (rowsLoad === load) rowsLoad = null;
  }
}

async function listPendingRows(): Promise<NostrOutboxMutation[]> {
  try {
    const rows = await ensureRowsCache();
    return sortPending(Array.from(rows.values(), cloneMutation));
  } catch {
    return [];
  }
}

async function pendingCount(): Promise<number> {
  try {
    return (await ensureRowsCache()).size;
  } catch {
    return 0;
  }
}

async function refreshListeners(): Promise<void> {
  notificationRequested = false;
  const rows = await listPendingRows();
  // Subscriptions may have been removed while IndexedDB was being read.
  if (listeners.size === 0 && rowListeners.size === 0) return;

  const count = rows.length;
  listeners.forEach((listener) => {
    try {
      listener(count);
    } catch {
      // ignore listener errors
    }
  });
  rowListeners.forEach((listener) => {
    try {
      listener(rows);
    } catch {
      // ignore listener errors
    }
  });
}

function queueListenerRefresh(): void {
  // Outbox writes are common even when no UI is displaying its status. Avoid
  // the former full-store getAll/sort entirely in that case.
  if (listeners.size === 0 && rowListeners.size === 0) return;

  notificationRequested = true;
  if (notificationQueued || notificationRefresh) return;
  notificationQueued = true;

  queueMicrotask(() => {
    notificationQueued = false;
    notificationRefresh = refreshListeners().finally(() => {
      notificationRefresh = null;
      // A put/delete that landed while the read was in flight needs one more
      // refresh. Multiple mutations in that window are coalesced together.
      if (notificationRequested) queueListenerRefresh();
    });
  });
}

export const nostrOutboxStore: NostrOutboxStore & {
  getPendingCount: () => Promise<number>;
  getPendingRows: () => Promise<NostrOutboxMutation[]>;
  subscribe: (listener: OutboxListener) => () => void;
  subscribeRows: (listener: OutboxRowsListener) => () => void;
} = {
  async get(id) {
    if (rowsCache) return rowsCache.has(id) ? cloneMutation(rowsCache.get(id)!) : undefined;
    try {
      const db = await getTaskifyDb();
      const value = await idbStorage.get<unknown>(db, TASKIFY_STORE_MUTATIONS, id);
      return isOutboxMutation(value) ? cloneMutation(value) : undefined;
    } catch {
      return undefined;
    }
  },

  async put(mutation) {
    const db = await getTaskifyDb();
    await idbStorage.put<NostrOutboxMutation>(db, TASKIFY_STORE_MUTATIONS, mutation);
    rowsRevision += 1;
    rowsCache?.set(mutation.id, cloneMutation(mutation));
    queueListenerRefresh();
  },

  async delete(id) {
    const db = await getTaskifyDb();
    await idbStorage.delete(db, TASKIFY_STORE_MUTATIONS, id);
    rowsRevision += 1;
    rowsCache?.delete(id);
    queueListenerRefresh();
  },

  async listPending() {
    return await listPendingRows();
  },

  async getPendingCount() {
    return await pendingCount();
  },

  async getPendingRows() {
    return await listPendingRows();
  },

  subscribe(listener) {
    listeners.add(listener);
    queueListenerRefresh();
    return () => {
      listeners.delete(listener);
    };
  },

  subscribeRows(listener) {
    rowListeners.add(listener);
    queueListenerRefresh();
    return () => {
      rowListeners.delete(listener);
    };
  },
};
