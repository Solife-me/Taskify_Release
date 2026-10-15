import { useEffect } from "react";
import type { AppOverlayRoute } from "./appRoute";
import type { AppHistoryRouter } from "./appRouter";

/** Sent by `public/sw.js` when a reminder is tapped while the app is already open. */
export const OPEN_REMINDER_MESSAGE = "TASKIFY_OPEN_REMINDER";
const EVENT_PREFIX = "event:";

/** A reminder's item id as the service worker sends it: event reminders carry `event:<id>`. */
export function reminderOverlay(itemId: string): AppOverlayRoute | null {
  const id = itemId.trim();
  if (id.startsWith(EVENT_PREFIX)) {
    const eventId = id.slice(EVENT_PREFIX.length).trim();
    return eventId ? { kind: "event", id: eventId } : null;
  }
  return id ? { kind: "task", id } : null;
}

/**
 * A reminder tapped while Taskify is open becomes a history entry for its task or event, which
 * `useRouteOverlayOpener` opens like any link. A tap that launches the app arrives as the
 * notification's URL (`?task=`), which the router reads directly.
 */
export function useReminderTaps(router: AppHistoryRouter): void {
  useEffect(() => {
    const container = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!container) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type !== OPEN_REMINDER_MESSAGE || typeof data.taskId !== "string") return;
      const overlay = reminderOverlay(data.taskId);
      if (overlay) router.openOverlay(overlay);
    };
    container.addEventListener("message", onMessage);
    return () => container.removeEventListener("message", onMessage);
  }, [router]);
}
