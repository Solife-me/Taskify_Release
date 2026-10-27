/**
 * Runs a `MergedDocumentSync` for one piece of app state inside React: identity changes, the
 * pull when sync turns on, publishing local changes, and applying live events.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { MutableRefObject } from "react";
import type { NostrEvent } from "nostr-tools";
import { loadNostrSyncState } from "../domains/nostr/nostrPool";
import { decryptNostrSyncPayload, encryptNostrSyncPayload } from "../nostrAppState";
import { kvStorage } from "../storage/kvStorage";
import { MergedDocumentSync, type MergedDocumentConfig, type SyncEvent, type SyncState } from "./mergedDocumentSync";
import type { NostrPublishFn } from "./useNostrIdentity";

export type UseMergedDocumentSyncOptions<T> = {
  config: MergedDocumentConfig<T>;
  stateStorageKey: string;
  baseStorageKey: string;
  local: T;
  setLocal: (update: (prev: T) => T) => void;
  /** Sync is on. Incoming events are applied whenever it is. */
  enabled: boolean;
  /** Something (an open settings screen) holds pulling and publishing back. */
  blocked: boolean;
  nostrPK: string;
  nostrSK: Uint8Array;
  relays: string[];
  fetchEvents: (relays: string[], filters: Array<Record<string, unknown>>) => Promise<NostrEvent[]>;
  nostrPublishRef: MutableRefObject<NostrPublishFn>;
  /** Serializes applies across documents, as before. */
  enqueueApply: (fn: () => Promise<void>) => Promise<void>;
  onPublishError: (error: unknown) => void;
};

export function useMergedDocumentSync<T>(options: UseMergedDocumentSyncOptions<T>) {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const localRef = useRef(options.local);
  localRef.current = options.local;

  const engine = useMemo(() => {
    const { config, stateStorageKey, baseStorageKey } = latest.current;
    return new MergedDocumentSync<T>(config, {
      storage: {
        loadState: () => loadNostrSyncState(stateStorageKey),
        saveState: (state: SyncState) => {
          try { kvStorage.setItem(stateStorageKey, JSON.stringify(state)); } catch { /* storage full */ }
        },
        loadBase: () => {
          try {
            const raw = kvStorage.getItem(baseStorageKey);
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        },
        saveBase: (base) => {
          try {
            if (base == null) kvStorage.removeItem(baseStorageKey);
            else kvStorage.setItem(baseStorageKey, JSON.stringify(base));
          } catch { /* storage full */ }
        },
      },
      getLocal: () => localRef.current,
      updateLocal: (update) => {
        localRef.current = update(localRef.current);
        latest.current.setLocal(update);
      },
      encrypt: (payload) => {
        const { nostrPK, nostrSK } = latest.current;
        return encryptNostrSyncPayload(payload, bytesToHex(nostrSK), nostrPK);
      },
      decrypt: (content) => {
        const { nostrPK, nostrSK } = latest.current;
        return decryptNostrSyncPayload(content, bytesToHex(nostrSK), nostrPK);
      },
      publish: async (template) => {
        const { relays, nostrSK, nostrPublishRef } = latest.current;
        const result = (await nostrPublishRef.current(relays, template, { sk: nostrSK, returnEvent: true })) as {
          event?: { id?: string };
          createdAt?: number;
        } | undefined;
        return { eventId: result?.event?.id ?? null, createdAt: result?.createdAt ?? template.created_at };
      },
      fetchLatest: async () => {
        const { relays, nostrPK, fetchEvents, config: current } = latest.current;
        if (!relays.length || !nostrPK) return null;
        const events = await fetchEvents(relays, [{ kinds: [current.kind], authors: [nostrPK], "#d": [current.dTag], limit: 5 }]);
        return (events.reduce<NostrEvent | null>(
          (newest, event) => (!newest || (event.created_at || 0) > (newest.created_at || 0) ? event : newest),
          null,
        ) as SyncEvent | null);
      },
      nowSeconds: () => Math.floor(Date.now() / 1000),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (timer) => window.clearTimeout(timer as number),
      onPublishError: (error) => latest.current.onPublishError(error),
    });
  }, []);

  const { enabled, blocked, nostrPK, local } = options;
  const active = enabled && !blocked;

  useEffect(() => {
    engine.setIdentity(nostrPK || null);
  }, [engine, nostrPK]);

  // Pull when sync turns on (or the key changes); then the first publish may follow.
  useEffect(() => {
    if (!active || !nostrPK) {
      engine.markPullFinished();
      return;
    }
    let cancelled = false;
    void latest.current.enqueueApply(async () => {
      await engine.pull();
    }).then(() => {
      if (!cancelled) engine.noteLocalChange();
    });
    return () => {
      cancelled = true;
    };
  }, [active, engine, nostrPK]);

  useEffect(() => {
    if (active && nostrPK) engine.noteLocalChange();
  }, [active, engine, local, nostrPK]);

  useEffect(() => () => engine.cancelPending(), [engine]);

  const handleEvent = useCallback(
    (event: NostrEvent) =>
      latest.current.enqueueApply(async () => {
        if (!latest.current.enabled || !latest.current.nostrPK) return;
        await engine.applyEvent(event as unknown as SyncEvent);
      }),
    [engine],
  );

  /** For the live subscription: the newest version seen, as a ref. */
  const stateRef = useMemo(
    () =>
      ({
        get current() {
          return engine.state;
        },
        set current(_value) {
          // read-only view of the engine's state
        },
      }) as MutableRefObject<SyncState>,
    [engine],
  );

  return { handleEvent, stateRef };
}
