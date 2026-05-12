import { NostrSession } from "../../nostr/NostrSession";
import { SessionPool } from "../../nostr/SessionPool";
import { kvStorage } from "../../storage/kvStorage";
import { LS_NOSTR_RELAYS, LS_NOSTR_BACKUP_STATE } from "../../nostrKeys";
import { DEFAULT_NOSTR_RELAYS } from "../../lib/relays";

/* ================= Nostr minimal client types ================= */

export type NostrEvent = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type NostrUnsignedEvent = Omit<NostrEvent, "id" | "sig" | "pubkey"> & {
  pubkey?: string;
};

export type NostrPool = {
  ensureRelay: (url: string) => void;
  setRelays: (urls: string[]) => void;
  subscribe: (
    relays: string[],
    filters: any[],
    onEvent: (ev: NostrEvent, from: string) => void,
    onEose?: (from: string) => void
  ) => () => void;
  subscribeMany: (
    relays: string[],
    filter: any,
    opts?: { onevent?: (ev: NostrEvent) => void; oneose?: (relay?: string) => void; closeOnEose?: boolean },
  ) => { close: (...args: any[]) => void };
  publish: (relays: string[], event: NostrUnsignedEvent) => Promise<void>;
  publishEvent: (relays: string[], event: NostrEvent) => void;
  list?: (relays: string[], filters: any[]) => Promise<NostrEvent[]>;
  get?: (relays: string[], filter: any) => Promise<NostrEvent | null>;
};

export type NostrBackupState = {
  lastEventId: string | null;
  lastTimestamp: number;
  pubkey: string | null;
};

export const NOSTR_MIN_EVENT_INTERVAL_MS = 200;

export function loadDefaultRelays(): string[] {
  try {
    const raw = kvStorage.getItem(LS_NOSTR_RELAYS);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
    }
  } catch {}
  return DEFAULT_NOSTR_RELAYS.slice();
}

export function saveDefaultRelays(relays: string[]) {
  kvStorage.setItem(LS_NOSTR_RELAYS, JSON.stringify(relays));
}

export function loadNostrBackupState(): NostrBackupState {
  try {
    const raw = kvStorage.getItem(LS_NOSTR_BACKUP_STATE);
    if (!raw) return { lastEventId: null, lastTimestamp: 0, pubkey: null };
    const parsed = JSON.parse(raw);
    const lastEventId = typeof parsed?.lastEventId === "string" ? parsed.lastEventId : null;
    const lastTimestamp = Number(parsed?.lastTimestamp) || 0;
    const pubkey = typeof parsed?.pubkey === "string" ? parsed.pubkey : null;
    return { lastEventId, lastTimestamp, pubkey };
  } catch {
    return { lastEventId: null, lastTimestamp: 0, pubkey: null };
  }
}

export function loadNostrSyncState(storageKey: string): NostrBackupState {
  try {
    const raw = kvStorage.getItem(storageKey);
    if (!raw) return { lastEventId: null, lastTimestamp: 0, pubkey: null };
    const parsed = JSON.parse(raw);
    const lastEventId = typeof parsed?.lastEventId === "string" ? parsed.lastEventId : null;
    const lastTimestamp = Number(parsed?.lastTimestamp) || 0;
    const pubkey = typeof parsed?.pubkey === "string" ? parsed.pubkey : null;
    return { lastEventId, lastTimestamp, pubkey };
  } catch {
    return { lastEventId: null, lastTimestamp: 0, pubkey: null };
  }
}

export function createNostrPool(): NostrPool {
  const pool = new SessionPool();
  return {
    ensureRelay(url: string) {
      if (url) void NostrSession.init([url]);
    },
    setRelays(urls: string[]) {
      if (Array.isArray(urls) && urls.length) void NostrSession.init(urls);
    },
    subscribe(relayUrls, filters, onEvent, onEose) {
      return pool.subscribe(
        relayUrls,
        filters,
        (event, relay) => onEvent(event, relay ?? ""),
        onEose ? (relay) => onEose(relay ?? "") : undefined,
      );
    },
    subscribeMany(relayUrls, filter, opts) {
      return pool.subscribeMany(relayUrls, filter, opts);
    },
    async publish(relayUrls, event) {
      await pool.publish(relayUrls, event as unknown as NostrEvent);
    },
    publishEvent(relayUrls, event) {
      void pool.publishEvent(relayUrls, event as unknown as NostrEvent);
    },
    list: pool.list.bind(pool),
    get: pool.get.bind(pool),
  };
}
