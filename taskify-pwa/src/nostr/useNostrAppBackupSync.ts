import { bytesToHex } from "@noble/hashes/utils";
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  normalizeRelayListSorted,
  type Board,
} from "taskify-core";
import {
  sanitizeBibleTrackerState,
  type BibleTrackerState,
} from "../components/BibleTracker";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import {
  decryptNostrBackupPayload,
  encryptNostrBackupPayload,
  NOSTR_APP_BACKUP_CLIENT_TAG,
  NOSTR_APP_BACKUP_D_TAG,
  NOSTR_APP_BACKUP_KIND,
  type NostrAppBackupBoard,
  type NostrAppBackupPayload,
} from "../nostrBackup";
import {
  decryptNostrSyncPayload,
  encryptNostrSyncPayload,
  NOSTR_APP_STATE_CLIENT_TAG,
  NOSTR_APP_STATE_KIND,
  NOSTR_BIBLE_TRACKER_D_TAG,
  NOSTR_SCRIPTURE_MEMORY_D_TAG,
} from "../nostrAppState";
import { kvStorage } from "../storage/kvStorage";
import {
  LS_NOSTR_BACKUP_STATE,
  LS_NOSTR_BIBLE_TRACKER_SYNC_STATE,
  LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE,
} from "../nostrKeys";
import {
  loadNostrBackupState,
  loadNostrSyncState,
  type NostrBackupState,
  type NostrEvent,
} from "../domains/nostr/nostrPool";
import { DEFAULT_PUSH_PREFERENCES, type SetSettingsFn } from "../domains/tasks/settingsHook";
import type { Settings } from "../domains/tasks/settingsTypes";
import type { ScriptureMemoryState } from "../domains/scripture/scriptureTypes";
import { sanitizeScriptureMemoryState } from "../domains/scripture/scriptureUtils";
import {
  buildNostrBackupSnapshot as buildNostrBackupSnapshotDomain,
  mergeBackupBoards,
  sanitizeSettingsForNostrBackup,
} from "../lib/app/nostrBackupDomain";
import { getWalletSeedBackup, restoreWalletSeedBackup } from "../wallet/seed";
import { NostrSession } from "./NostrSession";
import { useNostrSubscriptions } from "./useNostrSubscriptions";
import type { NostrPublishFn } from "./useNostrIdentity";

const NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS = 1500;

type NostrBackupSnapshot = {
  boards: NostrAppBackupBoard[];
  settings: Partial<Settings>;
  defaultRelays: string[];
  walletSeed: ReturnType<typeof getWalletSeedBackup>;
};

type UseNostrAppBackupSyncParams = {
  bibleTracker: BibleTrackerState;
  bibleTrackerRef: MutableRefObject<BibleTrackerState>;
  boards: Board[];
  defaultRelays: string[];
  nostrPK: string;
  nostrPublishRef: MutableRefObject<NostrPublishFn>;
  nostrSK: Uint8Array;
  pool: any;
  scriptureMemory: ScriptureMemoryState;
  setBibleTracker: Dispatch<SetStateAction<BibleTrackerState>>;
  setBoards: Dispatch<SetStateAction<Board[]>>;
  setDefaultRelays: Dispatch<SetStateAction<string[]>>;
  setScriptureMemory: Dispatch<SetStateAction<ScriptureMemoryState>>;
  setSettings: SetSettingsFn;
  settings: Settings;
  showSettings: boolean;
  showToast: (message?: string, durationMs?: number) => void;
  tagValue: (event: NostrEvent, name: string) => string | undefined;
};

export function normalizeNostrRelayList(relays: string[] | null | undefined): string[] {
  return normalizeRelayListSorted(relays) ?? [];
}

export function useNostrAppBackupSync({
  bibleTracker,
  bibleTrackerRef,
  boards,
  defaultRelays,
  nostrPK,
  nostrPublishRef,
  nostrSK,
  pool,
  scriptureMemory,
  setBibleTracker,
  setBoards,
  setDefaultRelays,
  setScriptureMemory,
  setSettings,
  settings,
  showSettings,
  showToast,
  tagValue,
}: UseNostrAppBackupSyncParams) {
  const [nostrBackupState, setNostrBackupState] = useState<NostrBackupState>(() => loadNostrBackupState());
  const nostrBackupStateRef = useRef<NostrBackupState>(nostrBackupState);
  useEffect(() => { nostrBackupStateRef.current = nostrBackupState; }, [nostrBackupState]);
  useEffect(() => {
    try { kvStorage.setItem(LS_NOSTR_BACKUP_STATE, JSON.stringify(nostrBackupState)); } catch {}
  }, [nostrBackupState]);

  const nostrBackupBaselineRef = useRef<string | null>(null);
  const nostrBackupSettingsDirtyRef = useRef(false);
  const nostrBackupPullFinishedRef = useRef(false);
  const nostrBackupInitialPublishRef = useRef(false);
  const nostrBackupPublishRef = useRef<Promise<void> | null>(null);
  const [nostrBackupHold, setNostrBackupHold] = useState(false);
  const nostrBackupHoldRef = useRef(nostrBackupHold);
  useEffect(() => { nostrBackupHoldRef.current = nostrBackupHold; }, [nostrBackupHold]);

  useEffect(() => {
    setNostrBackupState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrBackupInitialPublishRef.current = false;
      nostrBackupPullFinishedRef.current = false;
      return { lastEventId: null, lastTimestamp: 0, pubkey: nostrPK || null };
    });
  }, [nostrPK]);

  const [nostrBibleTrackerState, setNostrBibleTrackerState] = useState<NostrBackupState>(() =>
    loadNostrSyncState(LS_NOSTR_BIBLE_TRACKER_SYNC_STATE),
  );
  const nostrBibleTrackerStateRef = useRef<NostrBackupState>(nostrBibleTrackerState);
  useEffect(() => { nostrBibleTrackerStateRef.current = nostrBibleTrackerState; }, [nostrBibleTrackerState]);
  useEffect(() => {
    try { kvStorage.setItem(LS_NOSTR_BIBLE_TRACKER_SYNC_STATE, JSON.stringify(nostrBibleTrackerState)); } catch {}
  }, [nostrBibleTrackerState]);
  const nostrBibleTrackerPublishedSnapshotRef = useRef<string | null>(null);
  const nostrBibleTrackerPullFinishedRef = useRef(false);
  const nostrBibleTrackerInitialPublishRef = useRef(false);
  const nostrBibleTrackerPublishRef = useRef<Promise<void> | null>(null);
  const nostrBibleTrackerQueuedPublishRef = useRef(false);
  const nostrBibleTrackerDebounceTimerRef = useRef<number | null>(null);
  const nostrBibleTrackerErrorToastAtRef = useRef(0);
  useEffect(() => {
    setNostrBibleTrackerState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrBibleTrackerInitialPublishRef.current = false;
      nostrBibleTrackerPullFinishedRef.current = false;
      nostrBibleTrackerPublishedSnapshotRef.current = null;
      nostrBibleTrackerQueuedPublishRef.current = false;
      return { lastEventId: null, lastTimestamp: 0, pubkey: nostrPK || null };
    });
  }, [nostrPK]);

  const [nostrScriptureMemoryState, setNostrScriptureMemoryState] = useState<NostrBackupState>(() =>
    loadNostrSyncState(LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE),
  );
  const nostrScriptureMemoryStateRef = useRef<NostrBackupState>(nostrScriptureMemoryState);
  useEffect(() => { nostrScriptureMemoryStateRef.current = nostrScriptureMemoryState; }, [nostrScriptureMemoryState]);
  useEffect(() => {
    try { kvStorage.setItem(LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE, JSON.stringify(nostrScriptureMemoryState)); } catch {}
  }, [nostrScriptureMemoryState]);
  const nostrScriptureMemoryPublishedSnapshotRef = useRef<string | null>(null);
  const nostrScriptureMemoryPullFinishedRef = useRef(false);
  const nostrScriptureMemoryInitialPublishRef = useRef(false);
  const nostrScriptureMemoryPublishRef = useRef<Promise<void> | null>(null);
  const nostrScriptureMemoryDebounceTimerRef = useRef<number | null>(null);
  const nostrScriptureMemoryErrorToastAtRef = useRef(0);
  useEffect(() => {
    setNostrScriptureMemoryState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrScriptureMemoryInitialPublishRef.current = false;
      nostrScriptureMemoryPullFinishedRef.current = false;
      nostrScriptureMemoryPublishedSnapshotRef.current = null;
      return { lastEventId: null, lastTimestamp: 0, pubkey: nostrPK || null };
    });
  }, [nostrPK]);

  const nostrApplyQueue = useRef<Promise<void>>(Promise.resolve());
  const enqueueNostrApply = useCallback((fn: () => Promise<void>) => {
    const next = nostrApplyQueue.current.catch(() => {}).then(() => fn());
    nostrApplyQueue.current = next.then(() => {}, () => {});
    return next;
  }, []);

  const sanitizeSettingsForBackup = useCallback(
    (raw: Settings | Record<string, unknown>): Partial<Settings> =>
      sanitizeSettingsForNostrBackup(raw, DEFAULT_PUSH_PREFERENCES),
    [],
  );

  const buildNostrBackupSnapshot = useCallback(
    (): NostrBackupSnapshot =>
      buildNostrBackupSnapshotDomain({
        boards,
        settings,
        includeMetadata: settings.nostrBackupEnabled,
        defaultRelays,
        fallbackRelays: Array.from(DEFAULT_NOSTR_RELAYS),
        normalizeRelayList: normalizeNostrRelayList,
        sanitizeSettingsForBackup,
        walletSeed: getWalletSeedBackup(),
      }),
    [boards, defaultRelays, sanitizeSettingsForBackup, settings],
  );

  const serializeNostrBackupSnapshot = useCallback(
    () => JSON.stringify(buildNostrBackupSnapshot()),
    [buildNostrBackupSnapshot],
  );
  const serializeNostrBackupSnapshotRef = useRef(serializeNostrBackupSnapshot);
  serializeNostrBackupSnapshotRef.current = serializeNostrBackupSnapshot;

  const applyNostrBibleTrackerSyncEvent = useCallback(async (ev: NostrEvent) => {
    if (!settings.nostrBackupEnabled) return;
    if (!ev || ev.kind !== NOSTR_APP_STATE_KIND) return;
    const dTag = tagValue(ev, "d");
    if (dTag !== NOSTR_BIBLE_TRACKER_D_TAG) return;
    if (!nostrPK) return;
    const skHex = bytesToHex(nostrSK);
    let parsed: any;
    try {
      parsed = await decryptNostrSyncPayload(ev.content, skHex, nostrPK);
    } catch (error) {
      console.warn("Failed to decrypt Bible tracker sync payload", error);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.version !== 1) return;
    const payloadTs = Math.max(Number(parsed.timestamp) || 0, ev.created_at || 0);
    const lastTs = nostrBibleTrackerStateRef.current.lastTimestamp || 0;
    if (payloadTs <= lastTs) {
      if (!nostrBibleTrackerStateRef.current.lastEventId && ev.id) {
        setNostrBibleTrackerState((prev) => ({ ...prev, lastEventId: ev.id }));
      }
      return;
    }
    const incoming = sanitizeBibleTrackerState(parsed.bibleTracker);
    setBibleTracker(incoming);
    nostrBibleTrackerPublishedSnapshotRef.current = JSON.stringify(incoming);
    nostrBibleTrackerQueuedPublishRef.current = false;
    const nextState = { lastEventId: ev.id || null, lastTimestamp: payloadTs, pubkey: nostrPK || null };
    nostrBibleTrackerStateRef.current = nextState;
    setNostrBibleTrackerState(nextState);
  }, [nostrPK, nostrSK, setBibleTracker, settings.nostrBackupEnabled, tagValue]);

  const applyNostrScriptureMemorySyncEvent = useCallback(async (ev: NostrEvent) => {
    if (!settings.nostrBackupEnabled) return;
    if (!ev || ev.kind !== NOSTR_APP_STATE_KIND) return;
    const dTag = tagValue(ev, "d");
    if (dTag !== NOSTR_SCRIPTURE_MEMORY_D_TAG) return;
    if (!nostrPK) return;
    const skHex = bytesToHex(nostrSK);
    let parsed: any;
    try {
      parsed = await decryptNostrSyncPayload(ev.content, skHex, nostrPK);
    } catch (error) {
      console.warn("Failed to decrypt scripture memory sync payload", error);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.version !== 1) return;
    const payloadTs = Math.max(Number(parsed.timestamp) || 0, ev.created_at || 0);
    const lastTs = nostrScriptureMemoryStateRef.current.lastTimestamp || 0;
    if (payloadTs <= lastTs) {
      if (!nostrScriptureMemoryStateRef.current.lastEventId && ev.id) {
        setNostrScriptureMemoryState((prev) => ({ ...prev, lastEventId: ev.id }));
      }
      return;
    }
    const incoming = sanitizeScriptureMemoryState(parsed.scriptureMemory);
    setScriptureMemory(incoming);
    nostrScriptureMemoryPublishedSnapshotRef.current = JSON.stringify(incoming);
    const nextState = { lastEventId: ev.id || null, lastTimestamp: payloadTs, pubkey: nostrPK || null };
    nostrScriptureMemoryStateRef.current = nextState;
    setNostrScriptureMemoryState(nextState);
  }, [nostrPK, nostrSK, setScriptureMemory, settings.nostrBackupEnabled, tagValue]);

  const nostrList = useCallback(
    async (relays: string[], filters: any[]): Promise<NostrEvent[]> => {
      const relayList = normalizeNostrRelayList(relays);
      const session = await NostrSession.init(relayList);
      return session.fetchEvents(filters as any, relayList);
    },
    [],
  );

  const applyNostrBackupPayload = useCallback(
    async (payload: NostrAppBackupPayload, source: "remote" | "local" = "remote") => {
      if (!payload || typeof payload !== "object") return;
      const includeMetadata = settings.nostrBackupEnabled;
      const baseRelays = normalizeNostrRelayList(
        payload.defaultRelays && payload.defaultRelays.length
          ? payload.defaultRelays
          : defaultRelays.length
            ? defaultRelays
            : Array.from(DEFAULT_NOSTR_RELAYS),
      );
      if (includeMetadata && payload.settings && typeof payload.settings === "object") {
        const incoming = sanitizeSettingsForBackup(payload.settings as Record<string, unknown>);
        setSettings(incoming);
      }
      if (includeMetadata && Array.isArray(payload.defaultRelays) && payload.defaultRelays.some((r) => typeof r === "string" && r.trim())) {
        setDefaultRelays(normalizeNostrRelayList(payload.defaultRelays));
      }
      if (payload.walletSeed) {
        try {
          restoreWalletSeedBackup(payload.walletSeed);
        } catch (error) {
          console.warn("Failed to restore wallet seed from Nostr backup", error);
        }
      }
      if (includeMetadata && Array.isArray(payload.boards)) {
        setBoards((prev) =>
          mergeBackupBoards({
            currentBoards: prev,
            incomingBoards: payload.boards,
            baseRelays,
            normalizeRelayList: normalizeNostrRelayList,
            createId: () => crypto.randomUUID(),
          }),
        );
      }
      if (source === "remote") {
        const message = includeMetadata ? "Synced boards and settings from Nostr" : "Synced wallet backup from Nostr";
        showToast(message, 2600);
      }
    },
    [defaultRelays, sanitizeSettingsForBackup, setBoards, setDefaultRelays, setSettings, settings.nostrBackupEnabled, showToast],
  );

  const handleIncomingNostrBackupEvent = useCallback(
    async (ev: NostrEvent) => {
      if (!settings.nostrBackupEnabled) return;
      if (nostrBackupHoldRef.current) return;
      if (!ev || ev.kind !== NOSTR_APP_BACKUP_KIND) return;
      const dTag = tagValue(ev, "d");
      if (dTag !== NOSTR_APP_BACKUP_D_TAG) return;
      if (!nostrPK) return;
      const skHex = bytesToHex(nostrSK);
      let payload: NostrAppBackupPayload;
      try {
        payload = await decryptNostrBackupPayload(ev.content, skHex, nostrPK);
      } catch (error) {
        console.warn("Failed to decrypt Nostr backup payload", error);
        return;
      }
      if (!payload || payload.version !== 1) return;
      const payloadTs = Math.max(Number(payload.timestamp) || 0, ev.created_at || 0);
      const lastTs = nostrBackupStateRef.current.lastTimestamp || 0;
      if (payloadTs <= lastTs) {
        if (!nostrBackupStateRef.current.lastEventId && ev.id) {
          setNostrBackupState((prev) => ({ ...prev, lastEventId: ev.id }));
        }
        return;
      }
      await applyNostrBackupPayload(payload, "remote");
      nostrBackupPublishedSnapshotRef.current = serializeNostrBackupSnapshotRef.current();
      setNostrBackupState({
        lastEventId: ev.id || null,
        lastTimestamp: payloadTs,
        pubkey: nostrPK || null,
      });
    },
    [applyNostrBackupPayload, nostrPK, nostrSK, settings.nostrBackupEnabled, tagValue],
  );

  const pullNostrBackupOnce = useCallback(async (): Promise<boolean> => {
    if (!settings.nostrBackupEnabled) return false;
    if (!nostrPK) return false;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return false;
    try {
      const events = await nostrList(relays, [
        { kinds: [NOSTR_APP_BACKUP_KIND], authors: [nostrPK], "#d": [NOSTR_APP_BACKUP_D_TAG], limit: 5 },
      ]);
      const latest = events.reduce<null | (typeof events)[number]>((current, event) => {
        if (!event) return current;
        if (!current || (event.created_at || 0) > (current.created_at || 0)) return event;
        return current;
      }, null);
      if (latest) {
        await handleIncomingNostrBackupEvent(latest as unknown as NostrEvent);
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch Nostr backup", error);
      return false;
    }
  }, [defaultRelays, handleIncomingNostrBackupEvent, nostrList, nostrPK, settings.nostrBackupEnabled]);

  const pullNostrBibleTrackerOnce = useCallback(async (): Promise<boolean> => {
    if (!settings.nostrBackupEnabled) return false;
    if (!nostrPK) return false;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return false;
    try {
      const events = await nostrList(relays, [
        { kinds: [NOSTR_APP_STATE_KIND], authors: [nostrPK], "#d": [NOSTR_BIBLE_TRACKER_D_TAG], limit: 5 },
      ]);
      const latest = events.reduce<null | (typeof events)[number]>((current, event) => {
        if (!event) return current;
        if (!current || (event.created_at || 0) > (current.created_at || 0)) return event;
        return current;
      }, null);
      if (latest) {
        await enqueueNostrApply(() => applyNostrBibleTrackerSyncEvent(latest as unknown as NostrEvent));
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch Bible tracker sync from Nostr", error);
      return false;
    }
  }, [applyNostrBibleTrackerSyncEvent, defaultRelays, enqueueNostrApply, nostrList, nostrPK, settings.nostrBackupEnabled]);

  const pullNostrScriptureMemoryOnce = useCallback(async (): Promise<boolean> => {
    if (!settings.nostrBackupEnabled) return false;
    if (!nostrPK) return false;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return false;
    try {
      const events = await nostrList(relays, [
        { kinds: [NOSTR_APP_STATE_KIND], authors: [nostrPK], "#d": [NOSTR_SCRIPTURE_MEMORY_D_TAG], limit: 5 },
      ]);
      const latest = events.reduce<null | (typeof events)[number]>((current, event) => {
        if (!event) return current;
        if (!current || (event.created_at || 0) > (current.created_at || 0)) return event;
        return current;
      }, null);
      if (latest) {
        await enqueueNostrApply(() => applyNostrScriptureMemorySyncEvent(latest as unknown as NostrEvent));
        return true;
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch scripture memory sync from Nostr", error);
      return false;
    }
  }, [applyNostrScriptureMemorySyncEvent, defaultRelays, enqueueNostrApply, nostrList, nostrPK, settings.nostrBackupEnabled]);

  const publishNostrBibleTracker = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const tracker = bibleTrackerRef.current;
    const snapshotString = JSON.stringify(tracker);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(nowSeconds, (nostrBibleTrackerStateRef.current.lastTimestamp || 0) + 1);
    const payload = { version: 1, timestamp, bibleTracker: tracker } as const;
    const skHex = bytesToHex(nostrSK);
    const content = await encryptNostrSyncPayload(payload, skHex, nostrPK);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: NOSTR_APP_STATE_KIND,
        content,
        tags: [
          ["d", NOSTR_BIBLE_TRACKER_D_TAG],
          ["client", NOSTR_APP_STATE_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk: nostrSK, returnEvent: true },
    );
    const eventId = (result as any)?.event?.id || null;
    const publishedTs = (result as any)?.createdAt ?? timestamp;
    const nextState = {
      lastEventId: eventId || null,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrBibleTrackerStateRef.current = nextState;
    setNostrBibleTrackerState(nextState);
    nostrBibleTrackerPublishedSnapshotRef.current = snapshotString;
  }, [defaultRelays, nostrPK, nostrPublishRef, nostrSK, settings.nostrBackupEnabled, bibleTrackerRef]);

  const publishNostrScriptureMemory = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const snapshotString = JSON.stringify(scriptureMemory);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(nowSeconds, (nostrScriptureMemoryStateRef.current.lastTimestamp || 0) + 1);
    const payload = { version: 1, timestamp, scriptureMemory } as const;
    const skHex = bytesToHex(nostrSK);
    const content = await encryptNostrSyncPayload(payload, skHex, nostrPK);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: NOSTR_APP_STATE_KIND,
        content,
        tags: [
          ["d", NOSTR_SCRIPTURE_MEMORY_D_TAG],
          ["client", NOSTR_APP_STATE_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk: nostrSK, returnEvent: true },
    );
    const eventId = (result as any)?.event?.id || null;
    const publishedTs = (result as any)?.createdAt ?? timestamp;
    const nextState = {
      lastEventId: eventId || null,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrScriptureMemoryStateRef.current = nextState;
    setNostrScriptureMemoryState(nextState);
    nostrScriptureMemoryPublishedSnapshotRef.current = snapshotString;
  }, [defaultRelays, nostrPK, nostrPublishRef, nostrSK, scriptureMemory, settings.nostrBackupEnabled]);

  const enqueueNostrBibleTrackerPublish = useCallback(() => {
    if (nostrBibleTrackerPublishRef.current) {
      nostrBibleTrackerQueuedPublishRef.current = true;
      return nostrBibleTrackerPublishRef.current;
    }
    const task = publishNostrBibleTracker()
      .catch((error) => {
        console.warn("Failed to publish Bible tracker sync", error);
        const now = Date.now();
        if (now - nostrBibleTrackerErrorToastAtRef.current > 60_000) {
          nostrBibleTrackerErrorToastAtRef.current = now;
          showToast("Unable to sync Bible progress", 2600);
        }
      })
      .finally(() => {
        nostrBibleTrackerPublishRef.current = null;
        if (!nostrBibleTrackerQueuedPublishRef.current) return;
        nostrBibleTrackerQueuedPublishRef.current = false;
        const currentSnapshot = JSON.stringify(bibleTrackerRef.current);
        if (nostrBibleTrackerPublishedSnapshotRef.current === currentSnapshot) return;
        enqueueNostrBibleTrackerPublish().catch(() => {});
      });
    nostrBibleTrackerPublishRef.current = task;
    return task;
  }, [bibleTrackerRef, publishNostrBibleTracker, showToast]);

  const enqueueNostrScriptureMemoryPublish = useCallback(() => {
    if (nostrScriptureMemoryPublishRef.current) return nostrScriptureMemoryPublishRef.current;
    const task = publishNostrScriptureMemory()
      .catch((error) => {
        console.warn("Failed to publish scripture memory sync", error);
        const now = Date.now();
        if (now - nostrScriptureMemoryErrorToastAtRef.current > 60_000) {
          nostrScriptureMemoryErrorToastAtRef.current = now;
          showToast("Unable to sync scripture memory list", 2600);
        }
      })
      .finally(() => {
        nostrScriptureMemoryPublishRef.current = null;
      });
    nostrScriptureMemoryPublishRef.current = task;
    return task;
  }, [publishNostrScriptureMemory, showToast]);

  const publishNostrBackup = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    const snapshot = buildNostrBackupSnapshot();
    const snapshotString = serializeNostrBackupSnapshotRef.current();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(nowSeconds, (nostrBackupStateRef.current.lastTimestamp || 0) + 1);
    const payload: NostrAppBackupPayload = {
      version: 1,
      timestamp,
      boards: snapshot.boards,
      settings: snapshot.settings as Record<string, unknown>,
      walletSeed: snapshot.walletSeed,
      defaultRelays: snapshot.defaultRelays,
    };
    const skHex = bytesToHex(nostrSK);
    const content = await encryptNostrBackupPayload(payload, skHex, nostrPK);
    const result = await nostrPublishRef.current(
      relays,
      {
        kind: NOSTR_APP_BACKUP_KIND,
        content,
        tags: [
          ["d", NOSTR_APP_BACKUP_D_TAG],
          ["client", NOSTR_APP_BACKUP_CLIENT_TAG],
        ],
        created_at: timestamp,
      },
      { sk: nostrSK, returnEvent: true },
    );
    const eventId = (result as any)?.event?.id || null;
    const prev = nostrBackupStateRef.current;
    const prevEventId = prev.pubkey === nostrPK ? prev.lastEventId : null;
    const publishedTs = (result as any)?.createdAt ?? timestamp;
    if (prevEventId && eventId && prevEventId !== eventId) {
      try {
        await nostrPublishRef.current(
          relays,
          {
            kind: 5,
            tags: [
              ["e", prevEventId],
              ["a", `${NOSTR_APP_BACKUP_KIND}:${nostrPK}:${NOSTR_APP_BACKUP_D_TAG}`],
            ],
            content: "Delete previous Taskify backup",
            created_at: publishedTs + 1,
          },
          { sk: nostrSK },
        );
      } catch (error) {
        console.warn("Failed to publish Nostr backup deletion", error);
      }
    }
    const nextState = {
      lastEventId: eventId || prevEventId,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrBackupStateRef.current = nextState;
    setNostrBackupState(nextState);
    nostrBackupPublishedSnapshotRef.current = snapshotString;
  }, [buildNostrBackupSnapshot, defaultRelays, nostrPK, nostrPublishRef, nostrSK, settings.nostrBackupEnabled]);

  const enqueueNostrBackupPublish = useCallback(() => {
    if (nostrBackupPublishRef.current) return nostrBackupPublishRef.current;
    const task = publishNostrBackup()
      .catch((error) => {
        console.warn("Failed to publish Nostr backup", error);
        showToast("Unable to sync backup to Nostr", 2600);
      })
      .finally(() => {
        nostrBackupPublishRef.current = null;
      });
    nostrBackupPublishRef.current = task;
    return task;
  }, [publishNostrBackup, showToast]);

  const publishLatestNostrBackup = useCallback(async () => {
    if (!settings.nostrBackupEnabled || !nostrPK) return;
    const initialSnapshot = serializeNostrBackupSnapshot();
    if (initialSnapshot === nostrBackupPublishedSnapshotRef.current) return;
    if (nostrBackupPublishRef.current) {
      try {
        await nostrBackupPublishRef.current;
      } catch {}
    }
    const latestSnapshot = serializeNostrBackupSnapshot();
    if (latestSnapshot === nostrBackupPublishedSnapshotRef.current) return;
    try {
      await enqueueNostrBackupPublish();
    } catch {}
  }, [enqueueNostrBackupPublish, nostrPK, serializeNostrBackupSnapshot, settings.nostrBackupEnabled]);

  const nostrBackupPublishedSnapshotRef = useRef<string | null>(null);
  const nostrBackupDebounceTimerRef = useRef<number | null>(null);
  useEffect(() => {
    nostrBackupPullFinishedRef.current = false;
    let cancelled = false;
    if (!settings.nostrBackupEnabled || !nostrPK || showSettings || nostrBackupHold) {
      if (!nostrBackupHold) nostrBackupPullFinishedRef.current = true;
      return () => {};
    }
    (async () => {
      try {
        await pullNostrBackupOnce();
      } finally {
        if (!cancelled) nostrBackupPullFinishedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [nostrBackupHold, nostrPK, pullNostrBackupOnce, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    nostrBibleTrackerPullFinishedRef.current = false;
    let cancelled = false;
    if (!settings.nostrBackupEnabled || !nostrPK || showSettings) {
      nostrBibleTrackerPullFinishedRef.current = true;
      return () => {};
    }
    (async () => {
      try {
        await pullNostrBibleTrackerOnce();
      } finally {
        if (!cancelled) nostrBibleTrackerPullFinishedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [nostrPK, pullNostrBibleTrackerOnce, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    nostrScriptureMemoryPullFinishedRef.current = false;
    let cancelled = false;
    if (!settings.nostrBackupEnabled || !nostrPK || showSettings) {
      nostrScriptureMemoryPullFinishedRef.current = true;
      return () => {};
    }
    (async () => {
      try {
        await pullNostrScriptureMemoryOnce();
      } finally {
        if (!cancelled) nostrScriptureMemoryPullFinishedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [nostrPK, pullNostrScriptureMemoryOnce, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || nostrBackupHold || !nostrBackupPullFinishedRef.current) return;
    if (nostrBackupInitialPublishRef.current) return;
    if ((nostrBackupStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrBackupInitialPublishRef.current = true;
    enqueueNostrBackupPublish();
  }, [enqueueNostrBackupPublish, nostrBackupHold, nostrPK, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrBibleTrackerPullFinishedRef.current) return;
    if (nostrBibleTrackerInitialPublishRef.current) return;
    if ((nostrBibleTrackerStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrBibleTrackerInitialPublishRef.current = true;
    enqueueNostrBibleTrackerPublish().catch(() => {});
  }, [enqueueNostrBibleTrackerPublish, nostrPK, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrScriptureMemoryPullFinishedRef.current) return;
    if (nostrScriptureMemoryInitialPublishRef.current) return;
    if ((nostrScriptureMemoryStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrScriptureMemoryInitialPublishRef.current = true;
    enqueueNostrScriptureMemoryPublish().catch(() => {});
  }, [enqueueNostrScriptureMemoryPublish, nostrPK, settings.nostrBackupEnabled, showSettings]);

  const handleNostrBibleTrackerSubscriptionEvent = useCallback(
    (event: NostrEvent) => enqueueNostrApply(() => applyNostrBibleTrackerSyncEvent(event)),
    [applyNostrBibleTrackerSyncEvent, enqueueNostrApply],
  );

  const handleNostrScriptureMemorySubscriptionEvent = useCallback(
    (event: NostrEvent) => enqueueNostrApply(() => applyNostrScriptureMemorySyncEvent(event)),
    [applyNostrScriptureMemorySyncEvent, enqueueNostrApply],
  );

  useNostrSubscriptions({
    appBackup: {
      enabled: settings.nostrBackupEnabled,
      blocked: showSettings || nostrBackupHold,
      author: nostrPK,
      defaultRelays,
      dTag: NOSTR_APP_BACKUP_D_TAG,
      errorLogPrefix: "[nostr] backup event handling failed",
      kind: NOSTR_APP_BACKUP_KIND,
      normalizeRelayList: normalizeNostrRelayList,
      onEvent: handleIncomingNostrBackupEvent,
      pool,
      stateRef: nostrBackupStateRef,
    },
    bibleTracker: {
      enabled: settings.nostrBackupEnabled,
      blocked: showSettings,
      author: nostrPK,
      defaultRelays,
      dTag: NOSTR_BIBLE_TRACKER_D_TAG,
      kind: NOSTR_APP_STATE_KIND,
      normalizeRelayList: normalizeNostrRelayList,
      onEvent: handleNostrBibleTrackerSubscriptionEvent,
      pool,
      stateRef: nostrBibleTrackerStateRef,
    },
    scriptureMemory: {
      enabled: settings.nostrBackupEnabled,
      blocked: showSettings,
      author: nostrPK,
      defaultRelays,
      dTag: NOSTR_SCRIPTURE_MEMORY_D_TAG,
      kind: NOSTR_APP_STATE_KIND,
      normalizeRelayList: normalizeNostrRelayList,
      onEvent: handleNostrScriptureMemorySubscriptionEvent,
      pool,
      stateRef: nostrScriptureMemoryStateRef,
    },
  });

  useEffect(() => {
    if (showSettings) {
      if (nostrBackupBaselineRef.current == null) {
        nostrBackupBaselineRef.current = serializeNostrBackupSnapshot();
        nostrBackupSettingsDirtyRef.current = false;
      } else {
        const currentSnapshot = serializeNostrBackupSnapshot();
        nostrBackupSettingsDirtyRef.current = currentSnapshot !== nostrBackupBaselineRef.current;
      }
      return;
    }
    if (nostrBackupBaselineRef.current == null) return;
    const baseline = nostrBackupBaselineRef.current;
    nostrBackupBaselineRef.current = null;
    const currentSnapshot = serializeNostrBackupSnapshot();
    const changedDuringSettings =
      nostrBackupSettingsDirtyRef.current || baseline !== currentSnapshot;
    nostrBackupSettingsDirtyRef.current = false;
    if (!settings.nostrBackupEnabled || !changedDuringSettings) return;
    let cancelled = false;
    setNostrBackupHold(true);
    (async () => {
      try {
        await publishLatestNostrBackup();
      } finally {
        if (!cancelled) setNostrBackupHold(false);
      }
    })();
    return () => { cancelled = true; };
  }, [publishLatestNostrBackup, serializeNostrBackupSnapshot, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || nostrBackupHold) return;
    const currentSnapshot = serializeNostrBackupSnapshot();
    if (nostrBackupPublishedSnapshotRef.current === null) {
      nostrBackupPublishedSnapshotRef.current = currentSnapshot;
      return;
    }
    if (currentSnapshot === nostrBackupPublishedSnapshotRef.current) return;
    if (nostrBackupDebounceTimerRef.current) {
      window.clearTimeout(nostrBackupDebounceTimerRef.current);
    }
    nostrBackupDebounceTimerRef.current = window.setTimeout(() => {
      nostrBackupDebounceTimerRef.current = null;
      enqueueNostrBackupPublish().catch(() => {});
    }, NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS);
    return () => {
      if (nostrBackupDebounceTimerRef.current) {
        window.clearTimeout(nostrBackupDebounceTimerRef.current);
        nostrBackupDebounceTimerRef.current = null;
      }
    };
  }, [enqueueNostrBackupPublish, nostrBackupHold, serializeNostrBackupSnapshot, settings.nostrBackupEnabled, showSettings]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrPK || !nostrBibleTrackerPullFinishedRef.current) return;
    const currentSnapshot = JSON.stringify(bibleTracker);
    if (nostrBibleTrackerPublishedSnapshotRef.current === null) {
      nostrBibleTrackerPublishedSnapshotRef.current = currentSnapshot;
      return;
    }
    if (currentSnapshot === nostrBibleTrackerPublishedSnapshotRef.current) return;
    if (nostrBibleTrackerDebounceTimerRef.current) {
      window.clearTimeout(nostrBibleTrackerDebounceTimerRef.current);
    }
    nostrBibleTrackerDebounceTimerRef.current = window.setTimeout(() => {
      nostrBibleTrackerDebounceTimerRef.current = null;
      enqueueNostrBibleTrackerPublish().catch(() => {});
    }, NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS);
    return () => {
      if (nostrBibleTrackerDebounceTimerRef.current) {
        window.clearTimeout(nostrBibleTrackerDebounceTimerRef.current);
        nostrBibleTrackerDebounceTimerRef.current = null;
      }
    };
  }, [
    bibleTracker,
    enqueueNostrBibleTrackerPublish,
    nostrPK,
    settings.nostrBackupEnabled,
    showSettings,
  ]);

  useEffect(() => {
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || !nostrPK || !nostrScriptureMemoryPullFinishedRef.current) return;
    const currentSnapshot = JSON.stringify(scriptureMemory);
    if (nostrScriptureMemoryPublishedSnapshotRef.current === null) {
      nostrScriptureMemoryPublishedSnapshotRef.current = currentSnapshot;
      return;
    }
    if (currentSnapshot === nostrScriptureMemoryPublishedSnapshotRef.current) return;
    if (nostrScriptureMemoryDebounceTimerRef.current) {
      window.clearTimeout(nostrScriptureMemoryDebounceTimerRef.current);
    }
    nostrScriptureMemoryDebounceTimerRef.current = window.setTimeout(() => {
      nostrScriptureMemoryDebounceTimerRef.current = null;
      enqueueNostrScriptureMemoryPublish().catch(() => {});
    }, NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS);
    return () => {
      if (nostrScriptureMemoryDebounceTimerRef.current) {
        window.clearTimeout(nostrScriptureMemoryDebounceTimerRef.current);
        nostrScriptureMemoryDebounceTimerRef.current = null;
      }
    };
  }, [
    enqueueNostrScriptureMemoryPublish,
    nostrPK,
    scriptureMemory,
    settings.nostrBackupEnabled,
    showSettings,
  ]);
}
