import { useEffect, type MutableRefObject } from "react";
import { reminderPresetToMinutes } from "taskify-core";
import type { PushPreferences } from "../tasks/settingsTypes";
import type { ReminderPreset } from "../dateTime/reminderUtils";
import { reminderRetryDelayMs, syncRemindersToWorker } from "./reminderClient";

export type ReminderSyncItem = {
  taskId: string;
  boardId?: string;
  title: string;
  dueISO: string;
  reminders: ReminderPreset[];
};

/**
 * Keeps the Worker's copy of this device's reminder schedule in line with the app's.
 *
 * `sentPayloadRef` holds the schedule the Worker last accepted (or the one in flight), so an
 * unchanged schedule is not sent again; callers clear it when push is enabled or disabled.
 * Until a save succeeds it keeps retrying — the Worker's `Retry-After` when it gave one,
 * otherwise backing off from 30 seconds — because a failed save (offline, a server error, the
 * daily change budget) would otherwise leave the server's copy stale and reminders added since
 * would never fire.
 */
export function useReminderSync({
  reminderSyncItems,
  pushPrefs,
  workerBaseUrl,
  sentPayloadRef,
  setPushError,
  showToast,
}: {
  reminderSyncItems: ReminderSyncItem[];
  pushPrefs: PushPreferences | undefined;
  workerBaseUrl: string;
  sentPayloadRef: MutableRefObject<string | null>;
  setPushError: (message: string | null) => void;
  showToast: (message: string, durationMs?: number) => void;
}): void {
  useEffect(() => {
    if (!pushPrefs?.enabled || !pushPrefs.deviceId || !pushPrefs.subscriptionId) {
      sentPayloadRef.current = null;
      return;
    }
    if (!workerBaseUrl) {
      return;
    }

    const remindersPayload = reminderSyncItems
      .map((item) => ({
        taskId: item.taskId,
        boardId: item.boardId,
        dueISO: item.dueISO,
        title: item.title,
        minutesBefore: (item.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId));
    const payloadString = JSON.stringify(remindersPayload);
    if (sentPayloadRef.current === payloadString) return;
    sentPayloadRef.current = payloadString;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const attempt = (delayMs: number) => {
      timer = setTimeout(() => {
        syncRemindersToWorker(workerBaseUrl, pushPrefs, reminderSyncItems, { signal: controller.signal })
          .then(() => {
            if (controller.signal.aborted) return;
            sentPayloadRef.current = payloadString;
            if (failures > 0) setPushError(null);
          })
          .catch((err) => {
            if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
            failures += 1;
            // Not accepted: a later run of this effect (or a reload) must send it again.
            if (sentPayloadRef.current === payloadString) sentPayloadRef.current = null;
            console.error("Reminder sync failed", err);
            setPushError(err instanceof Error ? err.message : "Failed to sync reminders");
            if (failures === 1) showToast("Reminders not synced. Retrying automatically.", 4000);
            attempt(reminderRetryDelayMs(err, failures));
          });
      }, delayMs);
    };
    attempt(400);

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [reminderSyncItems, pushPrefs, workerBaseUrl, sentPayloadRef, setPushError, showToast]);
}
