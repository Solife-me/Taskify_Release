/**
 * Whether the user has saved their key, for the backup reminder and the Settings notice. The
 * rules live in `firstRunRules`; this module keeps the stored state and the actions that change
 * it. Every way of saving the key (copying the nsec, downloading a backup) goes through here.
 */
import { useSyncExternalStore } from "react";
import { toNsec } from "../domains/nostr/nostrKeyUtils";
import { revealLocalSecretKey } from "../identity/identity";
import {
  acknowledgeBackupNotice,
  isBackupNoticePending,
} from "../lib/nostrSkStore";
import { createStateStore, type StateStore } from "../state/stateStore";
import { kvStorage } from "../storage/kvStorage";
import {
  KEY_BACKUP_SNOOZE_MS,
  LS_KEY_BACKUP_STATE,
  parseKeyBackupState,
  type KeyBackupState,
} from "./firstRunRules";

type StoredBackup = KeyBackupState & { migrationNoticePending: boolean };

let store: StateStore<StoredBackup> | null = null;

function keyBackupStore(): StateStore<StoredBackup> {
  if (!store) {
    let saved: KeyBackupState = {};
    try {
      saved = parseKeyBackupState(kvStorage.getItem(LS_KEY_BACKUP_STATE));
    } catch {}
    store = createStateStore<StoredBackup>({ ...saved, migrationNoticePending: isBackupNoticePending() });
  }
  return store;
}

function update(next: KeyBackupState, options?: { acknowledgeMigration?: boolean }): void {
  if (options?.acknowledgeMigration) acknowledgeBackupNotice();
  const { createdHereAt, savedAt, snoozedUntil } = next;
  const persisted: KeyBackupState = {
    ...(createdHereAt ? { createdHereAt } : {}),
    ...(savedAt ? { savedAt } : {}),
    ...(snoozedUntil ? { snoozedUntil } : {}),
  };
  try {
    kvStorage.setItem(LS_KEY_BACKUP_STATE, JSON.stringify(persisted));
  } catch {}
  const migrationNoticePending = options?.acknowledgeMigration ? false : keyBackupStore().get().migrationNoticePending;
  keyBackupStore().set({ ...persisted, migrationNoticePending });
}

export function useKeyBackupState(): StoredBackup {
  const backupState = keyBackupStore();
  return useSyncExternalStore(backupState.subscribe, backupState.get, backupState.get);
}

/** Taskify just made a key on this device; only this copy of it exists. */
export function markKeyCreatedHere(now = Date.now()): void {
  update({ createdHereAt: now });
}

/** The user signed in with, or restored, a key they already hold. */
export function markKeyBroughtByUser(): void {
  update({}, { acknowledgeMigration: true });
}

export function markKeySaved(now = Date.now()): void {
  update({ ...keyBackupStore().get(), savedAt: now }, { acknowledgeMigration: true });
}

/** "Not now": ask again later. The one-time migration notice is simply dismissed. */
export function snoozeKeyBackup(now = Date.now()): void {
  const current = keyBackupStore().get();
  update({ ...current, snoozedUntil: now + KEY_BACKUP_SNOOZE_MS }, { acknowledgeMigration: current.migrationNoticePending });
}

/** Copies the user's nsec and records that it is saved. False when there is no local key or no clipboard. */
export async function copyNsecToClipboard(): Promise<boolean> {
  const secretKeyHex = revealLocalSecretKey();
  if (!secretKeyHex || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(toNsec(secretKeyHex));
  } catch {
    return false;
  }
  markKeySaved();
  return true;
}

/** Drops the loaded state so the next use reads storage again. Tests only. */
export function resetKeyBackupForTests(): void {
  store = null;
}
