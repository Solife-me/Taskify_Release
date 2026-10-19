import { bytesToHex } from "@noble/hashes/utils.js";
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import {
  APP_STATE_SYNC_CLIENT_TAG,
  APP_STATE_SYNC_KIND,
  CHAT_STATE_SYNC_D_TAG,
  chatSyncStateToPublish,
  emptyChatSyncState,
  mergeChatSyncStates,
  sanitizeChatSyncState,
  type ChatInboxResponse,
  type ChatSyncState,
} from "taskify-core";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import { decryptNostrSyncPayload, encryptNostrSyncPayload } from "../nostrAppState";
import { LS_NOSTR_CHAT_STATE_SYNC_DATA, LS_NOSTR_CHAT_STATE_SYNC_STATE } from "../nostrKeys";
import { LS_DM_THREAD_READ_STATE } from "../localStorageKeys";
import { kvStorage } from "../storage/kvStorage";
import { idbKeyValue } from "../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR } from "../storage/taskifyDb";
import { loadNostrSyncState, type NostrEvent } from "../domains/nostr/nostrPool";
import { chatStateSyncBus } from "./chatStateSyncBus";
import { MergedDocumentSync, type MergedDocumentConfig, type SyncEvent, type SyncState } from "./mergedDocumentSync";
import { normalizeNostrRelayList } from "./useNostrAppBackupSync";
import { useNostrSubscriptions } from "./useNostrSubscriptions";
import type { NostrPublishFn } from "./useNostrIdentity";

const stateKey = (state: ChatSyncState) =>
  JSON.stringify([
    Object.entries(state.readThrough).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(state.inboxResponses).sort(([a], [b]) => a.localeCompare(b)),
  ]);

/**
 * Chat state (read markers and shared-item responses), synced through the document engine. Read
 * markers move every time a conversation is viewed, so publishes are coalesced: one replaceable
 * event per 15-second window rather than one per message, flushed early when the tab is hidden
 * so the next device picked up already sees it. The payload keeps its top-level layout, which
 * iOS reads.
 */
export const CHAT_STATE_SYNC: MergedDocumentConfig<ChatSyncState> = {
  dTag: CHAT_STATE_SYNC_D_TAG,
  kind: APP_STATE_SYNC_KIND,
  codec: {
    encode: (state) => ({ readThrough: state.readThrough, inboxResponses: state.inboxResponses }),
    decode: (payload) => payload,
  },
  sanitize: sanitizeChatSyncState,
  // Read markers only advance and responses keep the latest, so no base is needed.
  merge: (_base, local, incoming) => mergeChatSyncStates(local, incoming),
  syncKey: stateKey,
  // A pruned merge with what the relays hold, and only when it adds something.
  toPublish: (known, local, nowSeconds) => chatSyncStateToPublish(known ?? emptyChatSyncState(), local, nowSeconds),
  debounceMs: 15_000,
  debounceMode: "window",
  extraTags: [["client", APP_STATE_SYNC_CLIENT_TAG]],
};

type UseNostrChatStateSyncParams = {
  enabled: boolean;
  defaultRelays: string[];
  nostrPK: string;
  nostrPublishRef: MutableRefObject<NostrPublishFn>;
  nostrSK: Uint8Array;
  pool: any;
  tagValue: (event: NostrEvent, name: string) => string | undefined;
  /** Shared-item responses made on this device, keyed by the item's gift-wrap event id. */
  localInboxResponses: Record<string, ChatInboxResponse>;
  /** Wrap event ids of shared items still waiting for a response here. */
  pendingInboxEventIds: string[];
  /** Marks shared items as answered because another device answered them. */
  applyRemoteInboxResponses: (responses: Record<string, ChatInboxResponse>) => void;
};

function readStoredReadThrough(): Record<string, number> {
  try {
    const raw = idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_DM_THREAD_READ_STATE);
    return raw ? sanitizeChatSyncState({ readThrough: JSON.parse(raw) }).readThrough : {};
  } catch {
    return {};
  }
}

function writeStoredReadThrough(readThrough: Record<string, number>) {
  try {
    idbKeyValue.setItem(TASKIFY_STORE_NOSTR, LS_DM_THREAD_READ_STATE, JSON.stringify(readThrough));
  } catch {}
}

export function useNostrChatStateSync(params: UseNostrChatStateSyncParams) {
  const { enabled, defaultRelays, nostrPK, pool, tagValue, localInboxResponses, pendingInboxEventIds } = params;
  const latest = useRef(params);
  latest.current = params;
  const localReadThroughRef = useRef<Record<string, number>>(readStoredReadThrough());
  const localInboxResponsesRef = useRef(localInboxResponses);
  localInboxResponsesRef.current = localInboxResponses;

  const engine = useMemo(
    () =>
      new MergedDocumentSync<ChatSyncState>(CHAT_STATE_SYNC, {
        storage: {
          loadState: () => loadNostrSyncState(LS_NOSTR_CHAT_STATE_SYNC_STATE),
          saveState: (state: SyncState) => {
            try { kvStorage.setItem(LS_NOSTR_CHAT_STATE_SYNC_STATE, JSON.stringify(state)); } catch {}
          },
          loadBase: () => {
            try {
              const raw = kvStorage.getItem(LS_NOSTR_CHAT_STATE_SYNC_DATA);
              return raw ? JSON.parse(raw) : null;
            } catch {
              return null;
            }
          },
          saveBase: (base) => {
            try {
              if (base == null) kvStorage.removeItem(LS_NOSTR_CHAT_STATE_SYNC_DATA);
              else kvStorage.setItem(LS_NOSTR_CHAT_STATE_SYNC_DATA, JSON.stringify(base));
            } catch {}
          },
        },
        getLocal: () => ({ readThrough: localReadThroughRef.current, inboxResponses: localInboxResponsesRef.current }),
        // Another device's markers and responses: applied here, not published back.
        updateLocal: (update) => {
          const prev = { readThrough: localReadThroughRef.current, inboxResponses: localInboxResponsesRef.current };
          const next = update(prev);
          const advanced: Record<string, number> = {};
          for (const [key, seconds] of Object.entries(next.readThrough)) {
            if (seconds > (prev.readThrough[key] ?? 0)) advanced[key] = seconds;
          }
          if (Object.keys(advanced).length) {
            localReadThroughRef.current = { ...prev.readThrough, ...advanced };
            writeStoredReadThrough({ ...readStoredReadThrough(), ...advanced });
            chatStateSyncBus.applyRemoteReadThrough(advanced);
          }
          const answered: Record<string, ChatInboxResponse> = {};
          for (const [key, response] of Object.entries(next.inboxResponses)) {
            const current = prev.inboxResponses[key];
            if (!current || current.status !== response.status || current.at !== response.at) answered[key] = response;
          }
          if (Object.keys(answered).length) latest.current.applyRemoteInboxResponses(answered);
        },
        encrypt: (payload) => {
          const { nostrPK: pk, nostrSK: sk } = latest.current;
          return encryptNostrSyncPayload(payload, bytesToHex(sk), pk);
        },
        decrypt: (content) => {
          const { nostrPK: pk, nostrSK: sk } = latest.current;
          return decryptNostrSyncPayload(content, bytesToHex(sk), pk);
        },
        publish: async (template) => {
          const { defaultRelays: configured, nostrSK: sk, nostrPublishRef } = latest.current;
          const relays = normalizeNostrRelayList(configured.length ? configured : Array.from(DEFAULT_NOSTR_RELAYS));
          if (!relays.length) throw new Error("No relays for chat state sync.");
          const result = (await nostrPublishRef.current(relays, template, { sk, returnEvent: true })) as {
            event?: { id?: string };
            createdAt?: number;
          } | undefined;
          return { eventId: result?.event?.id ?? null, createdAt: result?.createdAt ?? template.created_at };
        },
        // The live subscription delivers the newest copy; there is no separate pull.
        fetchLatest: async () => null,
        nowSeconds: () => Math.floor(Date.now() / 1000),
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (timer) => window.clearTimeout(timer as number),
        onPublishError: (error) => console.warn("Failed to publish chat state sync", error),
      }),
    [],
  );

  useEffect(() => {
    if (!nostrPK) return;
    const hadAccount = !!engine.state.pubkey && engine.state.pubkey !== nostrPK;
    engine.setIdentity(nostrPK);
    if (hadAccount) localReadThroughRef.current = readStoredReadThrough();
  }, [engine, nostrPK]);

  useEffect(() => {
    if (!enabled) {
      engine.cancelPending();
      return;
    }
    engine.markPullFinished();
    engine.noteLocalChange();
  }, [enabled, engine]);

  const noteLocalChange = useCallback(() => {
    if (latest.current.enabled && latest.current.nostrPK) engine.noteLocalChange();
  }, [engine]);

  useEffect(() => chatStateSyncBus.onLocalReadThrough((readThrough) => {
    let changed = false;
    const next = { ...localReadThroughRef.current };
    for (const [rawKey, seconds] of Object.entries(readThrough)) {
      const key = rawKey.trim().toLowerCase();
      if (!key || !(seconds > (next[key] ?? 0))) continue;
      next[key] = seconds;
      changed = true;
    }
    if (!changed) return;
    localReadThroughRef.current = next;
    noteLocalChange();
  }), [noteLocalChange]);

  useEffect(() => {
    noteLocalChange();
  }, [localInboxResponses, noteLocalChange]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") engine.flushPending();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [engine]);

  useEffect(() => () => engine.cancelPending(), [engine]);

  // A shared item can arrive here after another device already answered it.
  const pendingKey = pendingInboxEventIds.join(",");
  useEffect(() => {
    if (!pendingInboxEventIds.length) return;
    const known = engine.known?.inboxResponses ?? {};
    const matches: Record<string, ChatInboxResponse> = {};
    for (const id of pendingInboxEventIds) {
      const response = known[id.toLowerCase()];
      if (response) matches[id.toLowerCase()] = response;
    }
    if (Object.keys(matches).length) latest.current.applyRemoteInboxResponses(matches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const handleEvent = useCallback(async (event: NostrEvent) => {
    if (!latest.current.enabled || !latest.current.nostrPK) return;
    if (event?.kind !== APP_STATE_SYNC_KIND || tagValue(event, "d") !== CHAT_STATE_SYNC_D_TAG) return;
    await engine.applyEvent(event as unknown as SyncEvent);
    // This device may hold markers or responses the other device has not seen yet.
    noteLocalChange();
  }, [engine, noteLocalChange, tagValue]);

  const stateRef = useMemo(
    () =>
      ({
        get current() {
          return { lastTimestamp: engine.state.lastTimestamp };
        },
        set current(_value) {
          // read-only view of the engine's state
        },
      }) as MutableRefObject<{ lastTimestamp?: number }>,
    [engine],
  );

  useNostrSubscriptions({
    chatState: {
      enabled,
      author: nostrPK,
      defaultRelays,
      dTag: CHAT_STATE_SYNC_D_TAG,
      kind: APP_STATE_SYNC_KIND,
      normalizeRelayList: normalizeNostrRelayList,
      onEvent: handleEvent,
      pool,
      stateRef,
    },
  });
}
