import { bytesToHex } from "@noble/hashes/utils.js";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  bibleTrackerSyncContent,
  bibleTrackerSyncKey,
  mergeBibleTrackerStates,
  mergeScriptureMemoryStates,
  normalizeRelayListSorted,
  scriptureMemorySyncKey,
  type Board,
  type NostrBackupContent,
  updateRemoteNostrBackup,
} from "taskify-core";
import {
  sanitizeBibleTrackerState,
  type BibleTrackerState,
} from "../domains/scripture/bibleTrackerModel";
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
  NOSTR_APP_STATE_CLIENT_TAG,
  NOSTR_APP_STATE_KIND,
  NOSTR_BIBLE_TRACKER_D_TAG,
  NOSTR_SCRIPTURE_MEMORY_D_TAG,
} from "../nostrAppState";
import { kvStorage } from "../storage/kvStorage";
import {
  LS_NOSTR_BACKUP_STATE,
  LS_NOSTR_BIBLE_TRACKER_SYNC_BASE,
  LS_NOSTR_BIBLE_TRACKER_SYNC_STATE,
  LS_NOSTR_SCRIPTURE_MEMORY_SYNC_BASE,
  LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE,
} from "../nostrKeys";
import {
  loadNostrBackupState,
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
import { restoreWalletSeedFromBackup, walletSeedForBackup } from "../wallet/walletSeedBackup";
import { NostrSession } from "./NostrSession";
import { useNostrSubscriptions } from "./useNostrSubscriptions";
import type { NostrPublishFn } from "./useNostrIdentity";
import type { MergedDocumentConfig } from "./mergedDocumentSync";
import { useMergedDocumentSync } from "./useMergedDocumentSync";

const NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS = 1500;
const NOSTR_BACKUP_RETRY_MS = 60_000;
const LS_NOSTR_BACKUP_MANAGED_BOARDS = "taskify_nostr_backup_managed_boards_v1";

/** The boards this device has put in the account backup (so it removes them when they go). */
function loadManagedBackupBoardIds(pubkey: string): string[] {
  try {
    const parsed = JSON.parse(kvStorage.getItem(LS_NOSTR_BACKUP_MANAGED_BOARDS) || "null");
    return parsed && parsed.pubkey === pubkey && Array.isArray(parsed.ids) ? parsed.ids.filter((id: unknown) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveManagedBackupBoardIds(pubkey: string, ids: string[]): void {
  try {
    kvStorage.setItem(LS_NOSTR_BACKUP_MANAGED_BOARDS, JSON.stringify({ pubkey, ids }));
  } catch {
    // storage full: the next publish keeps these boards, which only errs on the safe side
  }
}

const BIBLE_TRACKER_SYNC: MergedDocumentConfig<BibleTrackerState> = {
  dTag: NOSTR_BIBLE_TRACKER_D_TAG,
  kind: NOSTR_APP_STATE_KIND,
  payloadKey: "bibleTracker",
  sanitize: sanitizeBibleTrackerState,
  merge: mergeBibleTrackerStates,
  syncKey: bibleTrackerSyncKey,
  toPayload: bibleTrackerSyncContent,
  debounceMs: NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS,
  extraTags: [["client", NOSTR_APP_STATE_CLIENT_TAG]],
};

const SCRIPTURE_MEMORY_SYNC: MergedDocumentConfig<ScriptureMemoryState> = {
  dTag: NOSTR_SCRIPTURE_MEMORY_D_TAG,
  kind: NOSTR_APP_STATE_KIND,
  payloadKey: "scriptureMemory",
  sanitize: sanitizeScriptureMemoryState,
  merge: mergeScriptureMemoryStates,
  syncKey: scriptureMemorySyncKey,
  debounceMs: NOSTR_BACKUP_PUBLISH_DEBOUNCE_MS,
  extraTags: [["client", NOSTR_APP_STATE_CLIENT_TAG]],
};

type NostrBackupSnapshot = {
  boards: NostrAppBackupBoard[];
  settings: Partial<Settings>;
  defaultRelays: string[];
  walletSeed?: ReturnType<typeof walletSeedForBackup>;
};

type UseNostrAppBackupSyncParams = {
  bibleTracker: BibleTrackerState;
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
  // The latest backup on the relays, once read (null inside: the relays confirmed there is none).
  // Several devices write this backup, so this device publishes only an update of it
  // (taskify-core's updateRemoteNostrBackup), never its own snapshot over it.
  const remoteBackupRef = useRef<{ content: NostrBackupContent | null; timestamp: number } | null>(null);
  const nostrBackupRetryTimerRef = useRef<number | null>(null);
  const [nostrBackupHold, setNostrBackupHold] = useState(false);
  const nostrBackupHoldRef = useRef(nostrBackupHold);
  useEffect(() => { nostrBackupHoldRef.current = nostrBackupHold; }, [nostrBackupHold]);

  useEffect(() => {
    setNostrBackupState((prev) => {
      if (prev.pubkey === nostrPK) return prev;
      nostrBackupInitialPublishRef.current = false;
      nostrBackupPullFinishedRef.current = false;
      remoteBackupRef.current = null;
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
        walletSeed: walletSeedForBackup(),
      }),
    [boards, defaultRelays, sanitizeSettingsForBackup, settings],
  );

  const serializeNostrBackupSnapshot = useCallback(
    () => JSON.stringify(buildNostrBackupSnapshot()),
    [buildNostrBackupSnapshot],
  );
  const serializeNostrBackupSnapshotRef = useRef(serializeNostrBackupSnapshot);
  serializeNostrBackupSnapshotRef.current = serializeNostrBackupSnapshot;

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
          await restoreWalletSeedFromBackup(payload.walletSeed);
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
      if (!remoteBackupRef.current || payloadTs >= remoteBackupRef.current.timestamp) {
        remoteBackupRef.current = { content: payload, timestamp: payloadTs };
      }
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

  const pullNostrBackupOnceRef = useRef<() => Promise<boolean>>(async () => false);
  const publishLatestNostrBackupRef = useRef<() => Promise<void>>(async () => {});
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
      // Nothing found. Trust that only for an account that has never backed up from here: one that
      // has is more likely looking at relays that do not have it.
      if (!remoteBackupRef.current && (nostrBackupStateRef.current.lastTimestamp || 0) === 0) {
        remoteBackupRef.current = { content: null, timestamp: 0 };
      }
      return false;
    } catch (error) {
      console.warn("Failed to fetch Nostr backup", error);
      return false;
    }
  }, [defaultRelays, handleIncomingNostrBackupEvent, nostrList, nostrPK, settings.nostrBackupEnabled]);
  pullNostrBackupOnceRef.current = pullNostrBackupOnce;

  const publishNostrBackup = useCallback(async () => {
    if (!settings.nostrBackupEnabled) return;
    if (!nostrPK) return;
    const relays = normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS));
    if (!relays.length) return;
    if (!remoteBackupRef.current) await pullNostrBackupOnceRef.current();
    const remote = remoteBackupRef.current;
    if (!remote) {
      // The remote backup could not be read: publishing now could drop what other devices put
      // there (their boards, the wallet seed). Try again shortly.
      if (nostrBackupRetryTimerRef.current == null) {
        nostrBackupRetryTimerRef.current = window.setTimeout(() => {
          nostrBackupRetryTimerRef.current = null;
          void publishLatestNostrBackupRef.current();
        }, NOSTR_BACKUP_RETRY_MS);
      }
      return;
    }
    const snapshot = buildNostrBackupSnapshot();
    const snapshotString = serializeNostrBackupSnapshotRef.current();
    const updated = updateRemoteNostrBackup(
      remote.content,
      {
        boards: snapshot.boards,
        settings: snapshot.settings as Record<string, unknown>,
        walletSeed: snapshot.walletSeed,
        defaultRelays: snapshot.defaultRelays,
      },
      { managedNostrIds: loadManagedBackupBoardIds(nostrPK), includeMetadata: settings.nostrBackupEnabled },
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const timestamp = Math.max(
      nowSeconds,
      (nostrBackupStateRef.current.lastTimestamp || 0) + 1,
      remote.timestamp + 1,
    );
    const payload: NostrAppBackupPayload = {
      version: 1,
      timestamp,
      boards: updated.boards,
      settings: updated.settings,
      walletSeed: updated.walletSeed,
      defaultRelays: updated.defaultRelays,
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
    // The backup is a replaceable event: relays already discard the previous version, so no
    // kind-5 deletion is needed (it only doubled every backup write).
    const nextState = {
      lastEventId: eventId || prevEventId,
      lastTimestamp: publishedTs,
      pubkey: nostrPK || null,
    };
    nostrBackupStateRef.current = nextState;
    setNostrBackupState(nextState);
    nostrBackupPublishedSnapshotRef.current = snapshotString;
    remoteBackupRef.current = { content: payload, timestamp: publishedTs };
    saveManagedBackupBoardIds(nostrPK, updated.managedNostrIds);
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

  publishLatestNostrBackupRef.current = publishLatestNostrBackup;
  const nostrBackupPublishedSnapshotRef = useRef<string | null>(null);
  useEffect(() => () => {
    if (nostrBackupRetryTimerRef.current != null) window.clearTimeout(nostrBackupRetryTimerRef.current);
  }, []);
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
    if (!settings.nostrBackupEnabled) return;
    if (showSettings || nostrBackupHold || !nostrBackupPullFinishedRef.current) return;
    if (nostrBackupInitialPublishRef.current) return;
    if ((nostrBackupStateRef.current.lastTimestamp || 0) > 0) return;
    if (!nostrPK) return;
    nostrBackupInitialPublishRef.current = true;
    enqueueNostrBackupPublish();
  }, [enqueueNostrBackupPublish, nostrBackupHold, nostrPK, settings.nostrBackupEnabled, showSettings]);

  // The Bible tracker and scripture memory: one encrypted document each, merged across devices.
  const syncRelays = useMemo(
    () => normalizeNostrRelayList(defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS)),
    [defaultRelays],
  );
  const syncErrorToastAtRef = useRef<Record<string, number>>({});
  const toastSyncError = useCallback((label: string) => (error: unknown) => {
    console.warn(`Failed to publish ${label} sync`, error);
    const now = Date.now();
    if (now - (syncErrorToastAtRef.current[label] ?? 0) > 60_000) {
      syncErrorToastAtRef.current[label] = now;
      showToast(label === "Bible tracker" ? "Unable to sync Bible progress" : "Unable to sync scripture memory", 2600);
    }
  }, [showToast]);
  const sharedDocumentOptions = {
    enabled: !!settings.nostrBackupEnabled,
    blocked: showSettings,
    nostrPK,
    nostrSK,
    relays: syncRelays,
    fetchEvents: nostrList,
    nostrPublishRef,
    enqueueApply: enqueueNostrApply,
  };
  const bibleTrackerSync = useMergedDocumentSync<BibleTrackerState>({
    ...sharedDocumentOptions,
    config: BIBLE_TRACKER_SYNC,
    stateStorageKey: LS_NOSTR_BIBLE_TRACKER_SYNC_STATE,
    baseStorageKey: LS_NOSTR_BIBLE_TRACKER_SYNC_BASE,
    local: bibleTracker,
    setLocal: setBibleTracker,
    onPublishError: toastSyncError("Bible tracker"),
  });
  const scriptureMemorySync = useMergedDocumentSync<ScriptureMemoryState>({
    ...sharedDocumentOptions,
    config: SCRIPTURE_MEMORY_SYNC,
    stateStorageKey: LS_NOSTR_SCRIPTURE_MEMORY_SYNC_STATE,
    baseStorageKey: LS_NOSTR_SCRIPTURE_MEMORY_SYNC_BASE,
    local: scriptureMemory,
    setLocal: setScriptureMemory,
    onPublishError: toastSyncError("scripture memory"),
  });

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
      onEvent: bibleTrackerSync.handleEvent,
      pool,
      stateRef: bibleTrackerSync.stateRef,
    },
    scriptureMemory: {
      enabled: settings.nostrBackupEnabled,
      blocked: showSettings,
      author: nostrPK,
      defaultRelays,
      dTag: NOSTR_SCRIPTURE_MEMORY_D_TAG,
      kind: NOSTR_APP_STATE_KIND,
      normalizeRelayList: normalizeNostrRelayList,
      onEvent: scriptureMemorySync.handleEvent,
      pool,
      stateRef: scriptureMemorySync.stateRef,
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

}
