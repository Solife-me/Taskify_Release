/**
 * When first run, the key-backup reminder and the notification offer appear. Pure decisions over
 * small stored states, so the rules are tested directly; the hooks and components only read
 * storage and render.
 */

export const LS_FIRST_RUN_ONBOARDING_DONE = "taskify_onboarding_done_v1";
export const LS_KEY_BACKUP_STATE = "taskify_key_backup_v1";
export const LS_REMINDER_NOTIFICATIONS_OFFER = "taskify_reminder_notifications_offer_v1";

const DAY_MS = 24 * 60 * 60 * 1000;
/** "Not now" on the backup reminder waits this long before asking again. */
export const KEY_BACKUP_SNOOZE_MS = 3 * DAY_MS;
/** A key made here is worth backing up once the user has this many tasks, or after a day. */
export const KEY_BACKUP_TASK_THRESHOLD = 3;
export const KEY_BACKUP_AGE_THRESHOLD_MS = DAY_MS;

/** First run shows only on a device with no identity that has not finished it before. */
export function shouldShowFirstRun(input: { hasIdentity: boolean; onboardingDone: boolean }): boolean {
  return !input.hasIdentity && !input.onboardingDone;
}

export type KeyBackupState = {
  /** When "Start using Taskify" made the key on this device. A key the user brought is theirs already. */
  createdHereAt?: number;
  /** When the user copied or exported the key. */
  savedAt?: number;
  snoozedUntil?: number;
};

export type KeyBackupPrompt = "new-key" | "migrated" | null;

/**
 * Whether to ask the user to save their key, and why:
 * - `migrated`: the key was just moved to encrypted storage (the one-time migration notice);
 * - `new-key`: Taskify made the key here and the user now has something to lose.
 */
export function keyBackupPrompt(
  state: KeyBackupState,
  context: { now: number; taskCount: number; migrationNoticePending: boolean },
): KeyBackupPrompt {
  if (state.savedAt) return null;
  if (context.migrationNoticePending) return "migrated";
  if (!state.createdHereAt) return null;
  if (state.snoozedUntil && context.now < state.snoozedUntil) return null;
  const hasSomethingToLose =
    context.taskCount >= KEY_BACKUP_TASK_THRESHOLD || context.now - state.createdHereAt >= KEY_BACKUP_AGE_THRESHOLD_MS;
  return hasSomethingToLose ? "new-key" : null;
}

export function parseKeyBackupState(raw: string | null): KeyBackupState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const time = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
    return { createdHereAt: time(parsed.createdHereAt), savedAt: time(parsed.savedAt), snoozedUntil: time(parsed.snoozedUntil) };
  } catch {
    return {};
  }
}

/**
 * Offer notifications the first time the user sets a reminder, if they could work here and are
 * off. Declining is remembered; Settings can still turn them on.
 */
export function shouldOfferReminderNotifications(input: {
  hadReminders: boolean;
  hasReminders: boolean;
  pushEnabled: boolean;
  pushAvailable: boolean;
  declined: boolean;
}): boolean {
  return input.hasReminders && !input.hadReminders && !input.pushEnabled && input.pushAvailable && !input.declined;
}
