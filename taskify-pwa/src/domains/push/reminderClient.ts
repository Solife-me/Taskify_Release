import { reminderPresetToMinutes } from "taskify-core";
import type { PushPreferences } from "../tasks/settingsTypes";
import type { ReminderPreset } from "../dateTime/reminderUtils";
import { withTimeout } from "../../lib/withTimeout";

export const PUSH_OPERATION_TIMEOUT_MS = 15000;

/** A reminder save the Worker refused, with the status and any `Retry-After` it sent. */
export class ReminderSyncError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, retryAfterSeconds: number | null) {
    super(
      status === 429
        ? "Too many reminder changes for now. Reminders will sync again later."
        : `Failed to sync reminders (${status})`,
    );
    this.name = "ReminderSyncError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const REMINDER_RETRY_BASE_MS = 30_000;
const REMINDER_RETRY_MAX_MS = 15 * 60_000;

/**
 * How long to wait before retrying a failed reminder save: the server's `Retry-After` when it
 * sent one, otherwise 30 s doubling to 15 minutes.
 */
export function reminderRetryDelayMs(error: unknown, failures: number): number {
  const retryAfter = error instanceof ReminderSyncError ? error.retryAfterSeconds : null;
  if (retryAfter != null && retryAfter > 0) return Math.max(REMINDER_RETRY_BASE_MS, retryAfter * 1000);
  const exponent = Math.max(0, Math.min(failures - 1, 10));
  return Math.min(REMINDER_RETRY_MAX_MS, REMINDER_RETRY_BASE_MS * 2 ** exponent);
}

export async function syncRemindersToWorker(
  workerBaseUrl: string,
  push: PushPreferences,
  reminderItems: Array<{
    taskId: string;
    boardId?: string;
    title: string;
    dueISO: string;
    reminders: ReminderPreset[];
  }>,
  options?: { signal?: AbortSignal }
): Promise<void> {
  if (!workerBaseUrl) throw new Error("Worker base URL is not configured");
  if (!push.deviceId || !push.subscriptionId) return;
  const remindersPayload = reminderItems
    .map((item) => ({
      taskId: item.taskId,
      boardId: item.boardId,
      dueISO: item.dueISO,
      title: item.title,
      minutesBefore: (item.reminders ?? []).map(reminderPresetToMinutes).sort((a, b) => a - b),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  let res: Response;
  try {
    res = await withTimeout(
      fetch(`${workerBaseUrl}/api/reminders`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: push.deviceId,
          subscriptionId: push.subscriptionId,
          reminders: remindersPayload,
        }),
        signal: options?.signal,
      }),
      PUSH_OPERATION_TIMEOUT_MS,
      "Timed out while syncing reminders to the notification worker.",
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    throw err;
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers?.get?.("Retry-After"));
    throw new ReminderSyncError(res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }
}
