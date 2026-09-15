import { reminderPresetToMinutes } from "taskify-core";
import type { PushPreferences } from "../tasks/settingsTypes";
import type { ReminderPreset } from "../dateTime/reminderUtils";
import { withTimeout } from "../../lib/withTimeout";

export const PUSH_OPERATION_TIMEOUT_MS = 15000;

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
    throw new Error(`Failed to sync reminders (${res.status})`);
  }
}
