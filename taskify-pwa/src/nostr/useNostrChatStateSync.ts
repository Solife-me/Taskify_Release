import { bytesToHex } from "@noble/hashes/utils.js";
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  APP_STATE_SYNC_CLIENT_TAG,
  APP_STATE_SYNC_KIND,
  CHAT_STATE_SYNC_D_TAG,
  chatSyncStateCovers,
  emptyChatSyncState,
  mergeChatSyncStates,
  pruneChatSyncState,
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
import { loadNostrSyncState, type NostrBackupState, type NostrEvent } from "../domains/nostr/nostrPool";
import { chatStateSyncBus } from "./chatStateSyncBus";
import { normalizeNostrRelayList } from "./useNostrAppBackupSync";
import { useNostrSubscriptions } from "./useNostrSubscriptions";
import type { NostrPublishFn } from "./useNostrIdentity";

// Read markers move every time a conversation is viewed, so publishes are coalesced: one
// replaceable event per quiet period rather than one per message, flushed early when the tab is
// hidden so the next device picked up already sees it.
const CHAT_STATE_PUBLISH_DEBOUNCE_MS = 15_000;

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

function loadKnownRemote(): ChatSyncState {
  try {
    const raw = kvStorage.getItem(LS_NOSTR_CHAT_STATE_SYNC_DATA);
    return raw ? sanitizeChatSyncState(JSON.parse(raw)) : emptyChatSyncState();
  } catch {
    return emptyChatSyncState();
  }
}

export function useNostrChatStateSync({
  enabled,
  defaultRelays,
  nostrPK,
  nostrPublishRef,
  nostrSK,
  pool,
  tagValue,
  localInboxResponses,
  pendingInboxEventIds,
  applyRemoteInboxResponses,
}: UseNostrChatStateSyncParams) {
  const syncStateRef = useRef<NostrBackupState>(loadNostrSyncState(LS_NOSTR_CHAT_STATE_SYNC_STATE));
  /** The newest chat state known to be on the relays (what we last published or received). */
  const knownRemoteRef = useRef<ChatSyncState>(loadKnownRemote());
  const localReadThroughRef = useRef<Record<string, number>>(readStoredReadThrough());
  const localInboxResponsesRef = useRef(localInboxResponses);
  localInboxResponsesRef.current = localInboxResponses;
  const applyRemoteInboxResponsesRef = useRef(applyRemoteInboxResponses);
  applyRemoteInboxResponsesRef.current = applyRemoteInboxResponses;
  const publishTimerRef = useRef<number | null>(null);
  const publishInFlightRef = useRef<Promise<void> | null>(null);
  const settingsRef = useRef({ enabled, defaultRelays, nostrPK, nostrSK });
  settingsRef.current = { enabled, defaultRelays, nostrPK, nostrSK };

  const persistSyncState = useCallback((next: NostrBackupState) => {
    syncStateRef.current = next;
    try { kvStorage.setItem(LS_NOSTR_CHAT_STATE_SYNC_STATE, JSON.stringify(next)); } catch {}
  }, []);
  const persistKnownRemote = useCallback((next: ChatSyncState) => {
    knownRemoteRef.current = next;
    try { kvStorage.setItem(LS_NOSTR_CHAT_STATE_SYNC_DATA, JSON.stringify(next)); } catch {}
  }, []);

  useEffect(() => {
    if (!nostrPK || syncStateRef.current.pubkey === nostrPK) return;
    const hadAccount = !!syncStateRef.current.pubkey;
    persistSyncState({ lastEventId: null, lastTimestamp: 0, pubkey: nostrPK });
    if (hadAccount) {
      persistKnownRemote(emptyChatSyncState());
      localReadThroughRef.current = readStoredReadThrough();
    }
  }, [nostrPK, persistKnownRemote, persistSyncState]);

  const localState = useCallback(
    (): ChatSyncState => ({
      readThrough: localReadThroughRef.current,
      inboxResponses: localInboxResponsesRef.current,
    }),
    [],
  );

  const publish = useCallback(async () => {
    const { enabled: isEnabled, defaultRelays: relaysSetting, nostrPK: pk, nostrSK: sk } = settingsRef.current;
    if (!isEnabled || !pk) return;
    const known = knownRemoteRef.current;
    const local = localState();
    if (chatSyncStateCovers(known, local)) return;
    const relays = normalizeNostrRelayList(relaysSetting.length ? relaysSetting : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const next = pruneChatSyncState(mergeChatSyncStates(known, local), { nowSeconds });
    const timestamp = Math.max(nowSeconds, (syncStateRef.current.lastTimestamp || 0) + 1);
    const content = await encryptNostrSyncPayload({ version: 1, timestamp, ...next }, bytesToHex(sk), pk);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: APP_STATE_SYNC_KIND,
        content,
        tags: [
          ["d", CHAT_STATE_SYNC_D_TAG],
          ["client", APP_STATE_SYNC_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk, returnEvent: true },
    );
    persistKnownRemote(next);
    persistSyncState({
      lastEventId: (result as any)?.event?.id || null,
      lastTimestamp: (result as any)?.createdAt ?? timestamp,
      pubkey: pk,
    });
  }, [localState, nostrPublishRef, persistKnownRemote, persistSyncState]);

  const flush = useCallback(() => {
    if (publishTimerRef.current != null) {
      window.clearTimeout(publishTimerRef.current);
      publishTimerRef.current = null;
    }
    if (publishInFlightRef.current) return;
    const task = publish()
      .catch((error) => console.warn("Failed to publish chat state sync", error))
      .finally(() => { publishInFlightRef.current = null; });
    publishInFlightRef.current = task;
  }, [publish]);

  const schedulePublish = useCallback(() => {
    if (!settingsRef.current.enabled || !settingsRef.current.nostrPK) return;
    if (chatSyncStateCovers(knownRemoteRef.current, localState())) return;
    if (publishTimerRef.current != null) return;
    publishTimerRef.current = window.setTimeout(() => {
      publishTimerRef.current = null;
      flush();
    }, CHAT_STATE_PUBLISH_DEBOUNCE_MS);
  }, [flush, localState]);

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
    schedulePublish();
  }), [schedulePublish]);

  useEffect(() => {
    schedulePublish();
  }, [localInboxResponses, schedulePublish]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && publishTimerRef.current != null) flush();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [flush]);

  useEffect(() => () => {
    if (publishTimerRef.current != null) window.clearTimeout(publishTimerRef.current);
  }, []);

  // A shared item can arrive here after another device already answered it.
  const pendingKey = pendingInboxEventIds.join(",");
  useEffect(() => {
    if (!pendingInboxEventIds.length) return;
    const known = knownRemoteRef.current.inboxResponses;
    const matches: Record<string, ChatInboxResponse> = {};
    for (const id of pendingInboxEventIds) {
      const response = known[id.toLowerCase()];
      if (response) matches[id.toLowerCase()] = response;
    }
    if (Object.keys(matches).length) applyRemoteInboxResponsesRef.current(matches);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  const handleEvent = useCallback(async (ev: NostrEvent) => {
    const { enabled: isEnabled, nostrPK: pk, nostrSK: sk } = settingsRef.current;
    if (!isEnabled || !pk || !ev || ev.kind !== APP_STATE_SYNC_KIND) return;
    if (tagValue(ev, "d") !== CHAT_STATE_SYNC_D_TAG) return;
    const state = syncStateRef.current;
    if (ev.id && ev.id === state.lastEventId) return;
    if ((ev.created_at || 0) < (state.lastTimestamp || 0)) return;
    let parsed: any;
    try {
      parsed = await decryptNostrSyncPayload(ev.content, bytesToHex(sk), pk);
    } catch (error) {
      console.warn("Failed to decrypt chat state sync payload", error);
      return;
    }
    if (!parsed || parsed.version !== 1) return;
    const incoming = sanitizeChatSyncState(parsed);
    persistKnownRemote(mergeChatSyncStates(knownRemoteRef.current, incoming));
    persistSyncState({
      lastEventId: ev.id || null,
      lastTimestamp: Math.max(Number(parsed.timestamp) || 0, ev.created_at || 0),
      pubkey: pk,
    });

    const localRead = localReadThroughRef.current;
    const advanced: Record<string, number> = {};
    for (const [key, seconds] of Object.entries(incoming.readThrough)) {
      if (seconds > (localRead[key] ?? 0)) advanced[key] = seconds;
    }
    if (Object.keys(advanced).length) {
      const nextRead = { ...localRead, ...advanced };
      localReadThroughRef.current = nextRead;
      writeStoredReadThrough({ ...readStoredReadThrough(), ...advanced });
      chatStateSyncBus.applyRemoteReadThrough(advanced);
    }
    if (Object.keys(incoming.inboxResponses).length) {
      applyRemoteInboxResponsesRef.current(incoming.inboxResponses);
    }
    // This device may hold markers or responses the other device has not seen yet.
    schedulePublish();
  }, [persistKnownRemote, persistSyncState, schedulePublish, tagValue]);

  const stateRef = useRef<{ lastTimestamp?: number }>({});
  stateRef.current = { lastTimestamp: syncStateRef.current.lastTimestamp };

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
