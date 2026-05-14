// @ts-nocheck
import React, { useState, useCallback, useEffect } from "react";
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
  encryptBackupWithSecretKey,
  parseBackupJsonPayload,
  applyBackupDataToStorage,
  loadCloudBackupPayload,
  CLOUD_BACKUP_MIN_INTERVAL_MS,
  MANUAL_CLOUD_BACKUP_INTERVAL_MS,
} from "../../domains/backup/backupUtils";
import type { TaskifyBackupPayload } from "../../domains/backup/backupTypes";
import { deriveNpubFromSecretKeyHex } from "../../domains/nostr/nostrKeyUtils";
import type { Settings } from "../../domains/tasks/settingsTypes";
import {
  LS_TASKS,
  LS_CALENDAR_EVENTS,
  LS_EXTERNAL_CALENDAR_EVENTS,
  LS_SETTINGS,
  LS_BOARDS,
  LS_BIBLE_TRACKER,
  LS_SCRIPTURE_MEMORY,
  LS_LAST_CLOUD_BACKUP,
  LS_LAST_MANUAL_CLOUD_BACKUP,
  LS_BACKGROUND_IMAGE,
} from "../../domains/storageKeys";
import { isSameLocalDate } from "./settingsConstants";

export function BackupSection({
  settings,
  setSettings,
  workerBaseUrl,
  onReloadNeeded,
}: {
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
  workerBaseUrl: string;
  onReloadNeeded: () => void;
}) {
  const [backupExpanded, setBackupExpanded] = useState(false);
  const [cloudRestoreKey, setCloudRestoreKey] = useState("");
  const [cloudRestoreState, setCloudRestoreState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [cloudRestoreMessage, setCloudRestoreMessage] = useState("");
  const [cloudBackupState, setCloudBackupState] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [cloudBackupMessage, setCloudBackupMessage] = useState("");

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

  const uploadCloudBackup = useCallback(async (skHex: string): Promise<number> => {
    if (!workerBaseUrl) {
      throw new Error("Cloud backup service is unavailable.");
    }
    const backupPayload = collectBackupData();
    const encrypted = await encryptBackupWithSecretKey(skHex, JSON.stringify(backupPayload));
    const npub = deriveNpubFromSecretKeyHex(skHex);
    if (!npub) {
      throw new Error("Unable to derive npub from the provided key.");
    }
    const res = await fetch(`${workerBaseUrl}/api/backups`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        npub,
        version: 1,
        createdAt: new Date().toISOString(),
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
      }),
    });
    if (!res.ok) {
      let message = `Backup upload failed (${res.status})`;
      try {
        const errJson = await res.json();
        if (errJson && typeof errJson === "object" && typeof errJson.error === "string" && errJson.error) {
          message = errJson.error;
        }
      } catch {}
      throw new Error(message);
    }
    const now = Date.now();
    kvStorage.setItem(LS_LAST_CLOUD_BACKUP, String(now));
    return now;
  }, [collectBackupData, workerBaseUrl]);

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

  function restoreFromBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((txt) => {
      try {
        applyBackupData(parseBackupJsonPayload(txt));
        alert("Backup restored. Press close to reload.");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid backup file.";
        alert(message);
      }
    });
    e.target.value = "";
  }

  useEffect(() => {
    if (!workerBaseUrl) return;
    if (typeof window === "undefined") return;
    if (!settings.cloudBackupsEnabled) return;

    const attemptBackup = async () => {
      try {
        if (typeof crypto === "undefined" || !crypto.subtle) return;
        const skHex = nostrSkSync();
        if (!/^[0-9a-fA-F]{64}$/.test(skHex)) return;
        const lastRaw = kvStorage.getItem(LS_LAST_CLOUD_BACKUP);
        const lastMs = lastRaw ? Number.parseInt(lastRaw, 10) : 0;
        const now = Date.now();
        if (Number.isFinite(lastMs)) {
          if (isSameLocalDate(lastMs, now)) return;
          if (now - lastMs < CLOUD_BACKUP_MIN_INTERVAL_MS) return;
        }

        await uploadCloudBackup(skHex);
      } catch (err) {
        console.warn("Cloud backup upload failed", err);
      }
    };

    attemptBackup();
  }, [settings.cloudBackupsEnabled, uploadCloudBackup, workerBaseUrl]);

  const handleManualCloudBackup = useCallback(async () => {
    if (!workerBaseUrl) {
      setCloudBackupState("error");
      setCloudBackupMessage("Cloud backup service is unavailable.");
      return;
    }
    if (typeof crypto === "undefined" || !crypto.subtle) {
      setCloudBackupState("error");
      setCloudBackupMessage("Browser crypto APIs are unavailable.");
      return;
    }
    const skHex = nostrSkSync();
    if (!/^[0-9a-fA-F]{64}$/.test(skHex)) {
      setCloudBackupState("error");
      setCloudBackupMessage("Add your Nostr secret key in Keys to use cloud backups.");
      return;
    }
    const now = Date.now();
    const lastManualRaw = kvStorage.getItem(LS_LAST_MANUAL_CLOUD_BACKUP);
    const lastManualMs = lastManualRaw ? Number.parseInt(lastManualRaw, 10) : 0;
    if (Number.isFinite(lastManualMs) && now - lastManualMs < MANUAL_CLOUD_BACKUP_INTERVAL_MS) {
      const waitSeconds = Math.ceil((MANUAL_CLOUD_BACKUP_INTERVAL_MS - (now - lastManualMs)) / 1000);
      setCloudBackupState("error");
      setCloudBackupMessage(`Please wait ${waitSeconds} more second${waitSeconds === 1 ? "" : "s"} before saving another backup.`);
      return;
    }
    setCloudBackupState("uploading");
    setCloudBackupMessage("");
    try {
      const timestamp = await uploadCloudBackup(skHex);
      kvStorage.setItem(LS_LAST_MANUAL_CLOUD_BACKUP, String(timestamp));
      setCloudBackupState("success");
      setCloudBackupMessage("Backup saved to cloud.");
    } catch (err: any) {
      const message = err?.message || String(err);
      setCloudBackupState("error");
      setCloudBackupMessage(message);
    }
  }, [uploadCloudBackup, workerBaseUrl]);

  const handleRestoreFromCloud = useCallback(async () => {
    setCloudRestoreState("loading");
    setCloudRestoreMessage("");
    try {
      const parsed = await loadCloudBackupPayload(workerBaseUrl, cloudRestoreKey);
      applyBackupData(parsed);
      alert("Backup restored. Press close to reload.");
      setCloudRestoreState("success");
      setCloudRestoreMessage("Cloud backup restored. Press close to reload.");
      setCloudRestoreKey("");
    } catch (err: any) {
      const message = err?.message || String(err);
      setCloudRestoreState("error");
      setCloudRestoreMessage(message);
    }
  }, [applyBackupData, cloudRestoreKey, workerBaseUrl]);

  const renderBackupButtons = (containerClassName = "") => (
    <div className={`flex flex-col gap-2 sm:flex-row ${containerClassName}`.trim()}>
      <button
        className={`${settings.cloudBackupsEnabled ? "ghost-button" : "accent-button"} button-sm pressable shrink-0`}
        onClick={() => setSettings({ cloudBackupsEnabled: !settings.cloudBackupsEnabled })}
      >
        {settings.cloudBackupsEnabled ? "Disable daily cloud backups" : "Enable daily cloud backups"}
      </button>
      <button
        className="accent-button button-sm pressable shrink-0"
        onClick={handleManualCloudBackup}
        disabled={!workerBaseUrl || cloudBackupState === "uploading"}
      >
        {cloudBackupState === "uploading" ? "Saving…" : "Save backup to cloud"}
      </button>
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
          <div className="flex flex-wrap gap-2">
            <button className="accent-button button-sm pressable flex-1" onClick={backupData}>Download backup</button>
            <label className="ghost-button button-sm pressable flex-1 justify-center cursor-pointer">
              Restore from backup
              <input type="file" accept="application/json" className="hidden" onChange={restoreFromBackup} />
            </label>
          </div>
          <div className="space-y-2">
            <div className="text-xs text-secondary">
              Cloud backups sync daily when Taskify opens while automatic backups are enabled. You can also save a manual backup once per minute. Restore using your Nostr private key (nsec).
            </div>
            <div className="text-xs text-secondary">
              Automatic daily cloud backups are currently {settings.cloudBackupsEnabled ? "enabled." : "disabled."}
            </div>
            {renderBackupButtons()}
            {cloudBackupState === "uploading" && (
              <div className="text-xs text-secondary">Saving backup…</div>
            )}
            {cloudBackupState === "error" && cloudBackupMessage && (
              <div className="text-xs text-rose-400">{cloudBackupMessage}</div>
            )}
            {cloudBackupState === "success" && cloudBackupMessage && (
              <div className="text-xs text-accent">{cloudBackupMessage}</div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                className="pill-input flex-1"
                placeholder="nsec or 64-hex private key"
                value={cloudRestoreKey}
                onChange={(e)=>{
                  setCloudRestoreKey(e.target.value);
                  setCloudRestoreState("idle");
                  setCloudRestoreMessage("");
                }}
              />
              <button
                className="accent-button button-sm pressable shrink-0"
                onClick={handleRestoreFromCloud}
                disabled={!workerBaseUrl || cloudRestoreState === "loading"}
              >
                {cloudRestoreState === "loading" ? "Restoring…" : "Restore from cloud"}
              </button>
            </div>
            {cloudRestoreState === "loading" && (
              <div className="text-xs text-secondary">Checking for backup…</div>
            )}
            {cloudRestoreState === "error" && cloudRestoreMessage && (
              <div className="text-xs text-rose-400">{cloudRestoreMessage}</div>
            )}
            {cloudRestoreState === "success" && cloudRestoreMessage && (
              <div className="text-xs text-accent">{cloudRestoreMessage}</div>
            )}
          </div>
        </div>
      ) : (
        renderBackupButtons()
      )}
    </section>
  );
}
