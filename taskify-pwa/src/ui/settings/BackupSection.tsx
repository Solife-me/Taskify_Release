import React, { useCallback, useState } from "react";
import { kvStorage } from "../../storage/kvStorage";
import { idbKeyValue } from "../../storage/idbKeyValue";
import { TASKIFY_STORE_NOSTR, TASKIFY_STORE_TASKS, TASKIFY_STORE_WALLET } from "../../storage/taskifyDb";
import { LS_LIGHTNING_CONTACTS, LS_CONTACTS_SYNC_META } from "../../localStorageKeys";
import { LS_NOSTR_RELAYS } from "../../nostrKeys";
import { getSkSync as nostrSkSync } from "../../lib/nostrSkStore";
import {
  taskEntityStore,
  boardEntityStore,
  calendarEventEntityStore,
  externalCalendarEventEntityStore,
} from "../../storage/entityStore";
import {
  loadStore as loadProofStore,
  getActiveMint,
  getMintList,
  listPendingTokens,
} from "../../wallet/storage";
import { getWalletSeedBackup } from "../../wallet/seed";
import {
  parseBackupJsonPayload,
  applyBackupDataToStorage,
} from "../../domains/backup/backupUtils";
import type { TaskifyBackupPayload } from "../../domains/backup/backupTypes";
import {
  LS_TASKS,
  LS_CALENDAR_EVENTS,
  LS_EXTERNAL_CALENDAR_EVENTS,
  LS_SETTINGS,
  LS_BOARDS,
  LS_BIBLE_TRACKER,
  LS_SCRIPTURE_MEMORY,
  LS_BACKGROUND_IMAGE,
} from "../../domains/storageKeys";

export function BackupSection({
  onReloadNeeded,
}: {
  onReloadNeeded: () => void;
}) {
  const [backupExpanded, setBackupExpanded] = useState(false);

  const collectBackupData = useCallback((): TaskifyBackupPayload => {
    const bibleTrackerRaw = kvStorage.getItem(LS_BIBLE_TRACKER);
    let cashuHistory: unknown = [];
    try {
      const historyRaw = idbKeyValue.getItem(TASKIFY_STORE_WALLET, "cashuHistory");
      const parsed = historyRaw ? JSON.parse(historyRaw) : [];
      cashuHistory = Array.isArray(parsed) ? parsed : [];
    } catch {
      cashuHistory = [];
    }
    // Merge backgroundImage from IndexedDB back into settings for backup
    // (it's stored separately from the settings JSON in localStorage)
    const settingsData = JSON.parse(kvStorage.getItem(LS_SETTINGS) || "{}");
    const bgImage = idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_BACKGROUND_IMAGE);
    if (bgImage) settingsData.backgroundImage = bgImage;
    // Pull tasks/boards/calendar events from the v3 per-entity stores (the
    // post-migration source of truth). Fall back to the legacy blobs only if
    // the entity store is empty (pre-migration boot or fresh install).
    const tasksFromEntity = taskEntityStore.size() > 0
      ? taskEntityStore.getAll()
      : JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_TASKS) || "[]");
    const calendarFromEntity = calendarEventEntityStore.size() > 0
      ? calendarEventEntityStore.getAll()
      : JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_CALENDAR_EVENTS) || "[]");
    const externalCalendarFromEntity = externalCalendarEventEntityStore.size() > 0
      ? externalCalendarEventEntityStore.getAll()
      : JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_EXTERNAL_CALENDAR_EVENTS) || "[]");
    const boardsFromEntity = boardEntityStore.size() > 0
      ? boardEntityStore.getAll()
      : JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_TASKS, LS_BOARDS) || "[]");
    return {
      tasks: tasksFromEntity,
      calendarEvents: calendarFromEntity,
      externalCalendarEvents: externalCalendarFromEntity,
      boards: boardsFromEntity,
      settings: settingsData,
      scriptureMemory: JSON.parse(kvStorage.getItem(LS_SCRIPTURE_MEMORY) || "{}"),
      bibleTracker: bibleTrackerRaw ? JSON.parse(bibleTrackerRaw) : null,
      defaultRelays: JSON.parse(kvStorage.getItem(LS_NOSTR_RELAYS) || "[]"),
      contacts: JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_LIGHTNING_CONTACTS) || "[]"),
      contactsSyncMeta: JSON.parse(idbKeyValue.getItem(TASKIFY_STORE_NOSTR, LS_CONTACTS_SYNC_META) || "{}"),
      nostrSk: nostrSkSync(),
      cashu: {
        proofs: loadProofStore(),
        activeMint: getActiveMint(),
        history: cashuHistory,
        trackedMints: getMintList(),
        pendingTokens: listPendingTokens(),
        walletSeed: getWalletSeedBackup(),
      },
    };
  }, []);

  function backupData() {
    const data = collectBackupData();
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "taskify-backup.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  const applyBackupData = useCallback(async (data: Partial<TaskifyBackupPayload>) => {
    applyBackupDataToStorage(data);
    // Wait for v3 entity-store writes to durably land before reload.
    await Promise.all([
      taskEntityStore.flush(),
      boardEntityStore.flush(),
      calendarEventEntityStore.flush(),
      externalCalendarEventEntityStore.flush(),
    ]);
    onReloadNeeded();
  }, [onReloadNeeded]);

  async function restoreFromBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      await applyBackupData(parseBackupJsonPayload(text));
      alert("Backup restored. Press close to reload.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid backup file.";
      alert(message);
    } finally {
      e.target.value = "";
    }
  }

  const renderBackupButtons = (containerClassName = "") => (
    <div className={`flex flex-col gap-2 sm:flex-row ${containerClassName}`.trim()}>
      <button className="accent-button button-sm pressable flex-1" onClick={backupData}>Download backup</button>
      <label className="ghost-button button-sm pressable flex-1 justify-center cursor-pointer">
        Restore from backup
        <input type="file" accept="application/json" className="hidden" onChange={restoreFromBackup} />
      </label>
    </div>
  );

  return (
    <section className="wallet-section space-y-3">
      <button
        className="flex w-full items-center gap-2 mb-3 text-left"
        onClick={() => setBackupExpanded((prev) => !prev)}
        aria-expanded={backupExpanded}
      >
        <div className="text-sm font-medium flex-1">Backup</div>
        <span className="text-xs text-tertiary">{backupExpanded ? "Hide" : "Show"}</span>
        <span className="text-tertiary">{backupExpanded ? "−" : "+"}</span>
      </button>
      {backupExpanded ? (
        <div className="space-y-3">
          <div className="text-xs text-secondary">
            Shared app data continues to be backed up through encrypted Nostr events. Use a file backup for an additional offline copy or a manual restore.
          </div>
          {renderBackupButtons()}
        </div>
      ) : (
        renderBackupButtons()
      )}
    </section>
  );
}
