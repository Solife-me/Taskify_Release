import { useEffect, useState } from "react";
import type { CalendarEvent, EditingState, Task } from "taskify-core";

/** Sent by `public/sw.js` when a reminder is tapped while the app is already open. */
export const OPEN_REMINDER_MESSAGE = "TASKIFY_OPEN_REMINDER";
const EVENT_PREFIX = "event:";

/** Takes `?task=<id>` off the address, so a reload does not reopen it. */
function takeReminderIdFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const id = url.searchParams.get("task");
    if (id === null) return null;
    url.searchParams.delete("task");
    window.history.replaceState(window.history.state, "", url.toString());
    return id.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Opens the task or event a reminder notification was for: from `?task=` when the tap
 * launched the app, or from the service worker's message when the app was already open.
 * Event reminders carry `event:<id>`, as `reminderSyncItems` sends them. Only items that
 * already exist locally are opened.
 */
export function useReminderDeepLink(options: {
  tasks: Task[];
  calendarEvents: CalendarEvent[];
  openEditor: (state: EditingState) => void;
}) {
  const { tasks, calendarEvents, openEditor } = options;
  const [pendingId, setPendingId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : takeReminderIdFromUrl(),
  );

  useEffect(() => {
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== OPEN_REMINDER_MESSAGE || typeof data.taskId !== "string") return;
      setPendingId(data.taskId);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!pendingId) return;
    if (pendingId.startsWith(EVENT_PREFIX)) {
      const eventId = pendingId.slice(EVENT_PREFIX.length);
      const ev = calendarEvents.find((candidate) => candidate.id === eventId);
      if (!ev) return;
      openEditor({ type: "event", originalType: "event", originalId: ev.id, event: ev });
    } else {
      const task = tasks.find((candidate) => candidate.id === pendingId);
      if (!task) return;
      openEditor({ type: "task", originalType: "task", originalId: task.id, task });
    }
    setPendingId(null);
  }, [calendarEvents, openEditor, pendingId, tasks]);
}
