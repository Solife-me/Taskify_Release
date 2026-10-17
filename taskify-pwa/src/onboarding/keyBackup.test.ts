// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { LS_NOSTR_SK_BACKUP_PENDING } from "../lib/nostrSkStore";
import { kvStorage } from "../storage/kvStorage";
import { keyBackupPrompt, LS_KEY_BACKUP_STATE } from "./firstRunRules";
import {
  markKeyBroughtByUser,
  markKeyCreatedHere,
  markKeySaved,
  resetKeyBackupForTests,
  snoozeKeyBackup,
} from "./keyBackup";

const NOW = 1_800_000_000_000;

function stored() {
  resetKeyBackupForTests();
  return JSON.parse(kvStorage.getItem(LS_KEY_BACKUP_STATE) || "{}");
}

afterEach(() => {
  kvStorage.removeItem(LS_KEY_BACKUP_STATE);
  kvStorage.removeItem(LS_NOSTR_SK_BACKUP_PENDING);
  resetKeyBackupForTests();
});

describe("key backup state", () => {
  it("tracks a key made here until it is saved", () => {
    markKeyCreatedHere(NOW);
    snoozeKeyBackup(NOW);
    expect(stored()).toEqual({ createdHereAt: NOW, snoozedUntil: expect.any(Number) });
    markKeySaved(NOW + 1);
    expect(stored()).toMatchObject({ createdHereAt: NOW, savedAt: NOW + 1 });
  });

  it("starts over when the user brings their own key", () => {
    markKeyCreatedHere(NOW);
    markKeyBroughtByUser();
    expect(stored()).toEqual({});
  });

  it("dismisses the migration notice on snooze or save", () => {
    kvStorage.setItem(LS_NOSTR_SK_BACKUP_PENDING, "1");
    resetKeyBackupForTests();
    snoozeKeyBackup(NOW);
    expect(kvStorage.getItem(LS_NOSTR_SK_BACKUP_PENDING)).toBeNull();
    const state = stored();
    expect(keyBackupPrompt(state, { now: NOW, taskCount: 0, migrationNoticePending: false })).toBeNull();
  });
});
