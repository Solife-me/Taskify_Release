import { describe, expect, it } from "vitest";
import {
  KEY_BACKUP_AGE_THRESHOLD_MS,
  KEY_BACKUP_SNOOZE_MS,
  keyBackupPrompt,
  parseKeyBackupState,
  shouldOfferReminderNotifications,
  shouldShowFirstRun,
} from "./firstRunRules";

const NOW = 1_800_000_000_000;

describe("shouldShowFirstRun", () => {
  it("shows only on a device without an identity that has not finished it", () => {
    expect(shouldShowFirstRun({ hasIdentity: false, onboardingDone: false })).toBe(true);
    expect(shouldShowFirstRun({ hasIdentity: true, onboardingDone: false })).toBe(false);
    expect(shouldShowFirstRun({ hasIdentity: false, onboardingDone: true })).toBe(false);
  });
});

describe("keyBackupPrompt", () => {
  const fresh = { createdHereAt: NOW - 1000 };
  const ctx = { now: NOW, taskCount: 0, migrationNoticePending: false };

  it("waits until a key made here has something to protect", () => {
    expect(keyBackupPrompt(fresh, ctx)).toBeNull();
    expect(keyBackupPrompt(fresh, { ...ctx, taskCount: 3 })).toBe("new-key");
    expect(keyBackupPrompt({ createdHereAt: NOW - KEY_BACKUP_AGE_THRESHOLD_MS }, ctx)).toBe("new-key");
  });

  it("never asks about a key the user brought, or one already saved", () => {
    expect(keyBackupPrompt({}, { ...ctx, taskCount: 50 })).toBeNull();
    expect(keyBackupPrompt({ ...fresh, savedAt: NOW }, { ...ctx, taskCount: 50 })).toBeNull();
  });

  it("respects a snooze, then asks again", () => {
    const snoozed = { ...fresh, snoozedUntil: NOW + KEY_BACKUP_SNOOZE_MS };
    expect(keyBackupPrompt(snoozed, { ...ctx, taskCount: 5 })).toBeNull();
    expect(keyBackupPrompt(snoozed, { ...ctx, now: NOW + KEY_BACKUP_SNOOZE_MS, taskCount: 5 })).toBe("new-key");
  });

  it("shows the migration notice whenever it is pending and the key is not saved", () => {
    expect(keyBackupPrompt({}, { ...ctx, migrationNoticePending: true })).toBe("migrated");
    expect(keyBackupPrompt({ savedAt: NOW }, { ...ctx, migrationNoticePending: true })).toBeNull();
  });

  it("reads stored state defensively", () => {
    expect(parseKeyBackupState('{"createdHereAt":5,"savedAt":"x","snoozedUntil":-1}')).toEqual({ createdHereAt: 5 });
    expect(parseKeyBackupState("nope")).toEqual({});
    expect(parseKeyBackupState(null)).toEqual({});
  });
});

describe("shouldOfferReminderNotifications", () => {
  const base = { hadReminders: false, hasReminders: true, pushEnabled: false, pushAvailable: true, declined: false };
  it("offers once, on the first reminder, when notifications could work and are off", () => {
    expect(shouldOfferReminderNotifications(base)).toBe(true);
    expect(shouldOfferReminderNotifications({ ...base, hadReminders: true })).toBe(false);
    expect(shouldOfferReminderNotifications({ ...base, hasReminders: false })).toBe(false);
    expect(shouldOfferReminderNotifications({ ...base, pushEnabled: true })).toBe(false);
    expect(shouldOfferReminderNotifications({ ...base, pushAvailable: false })).toBe(false);
    expect(shouldOfferReminderNotifications({ ...base, declined: true })).toBe(false);
  });
});