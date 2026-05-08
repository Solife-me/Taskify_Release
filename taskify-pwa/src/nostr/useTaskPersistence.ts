import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, CalendarEvent, Task } from "../domains/tasks/taskTypes";
import { DEFAULT_NOSTR_RELAYS } from "../lib/relays";
import {
  boardEntityStore,
  calendarEventEntityStore,
  externalCalendarEventEntityStore,
  taskEntityStore,
} from "../storage/entityStore";
import { NostrSession } from "./NostrSession";
import { nostrOutboxStore } from "./NostrOutboxStore";

type UseTaskPersistenceParams = {
  boards: Board[];
  calendarEvents: CalendarEvent[];
  defaultRelays: string[];
  tasks: Task[];
};

export function useTaskPersistence({
  boards,
  calendarEvents,
  defaultRelays,
  tasks,
}: UseTaskPersistenceParams) {
  const boardsFirstRun = useRef(true);
  useEffect(() => {
    if (boardsFirstRun.current) {
      boardsFirstRun.current = false;
      return;
    }
    boardEntityStore.syncWith(boards);
  }, [boards]);

  const tasksFirstRun = useRef(true);
  useEffect(() => {
    if (tasksFirstRun.current) {
      tasksFirstRun.current = false;
      return;
    }
    try {
      taskEntityStore.syncWith(tasks);
    } catch (err) {
      console.error("Failed to save tasks", err);
    }
  }, [tasks]);

  const eventsFirstRun = useRef(true);
  useEffect(() => {
    if (eventsFirstRun.current) {
      eventsFirstRun.current = false;
      return;
    }
    try {
      const boardEvents = calendarEvents.filter((event) => !event.external);
      const externalEvents = calendarEvents.filter((event) => event.external);
      calendarEventEntityStore.syncWith(boardEvents);
      externalCalendarEventEntityStore.syncWith(externalEvents);
    } catch (err) {
      console.error("Failed to save calendar events", err);
    }
  }, [calendarEvents]);

  const [pendingNostrOutboxCount, setPendingNostrOutboxCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    nostrOutboxStore.getPendingCount().then((count) => {
      if (!cancelled) setPendingNostrOutboxCount(count);
    });
    const unsubscribe = nostrOutboxStore.subscribe((count) => {
      if (!cancelled) setPendingNostrOutboxCount(count);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const retryNostrOutbox = useCallback(() => {
    const relays = defaultRelays.length ? defaultRelays : Array.from(DEFAULT_NOSTR_RELAYS);
    NostrSession.init(relays)
      .then((session) => session.publisher.drainOutbox({ force: true }))
      .catch((err) => {
        console.warn("Failed to retry pending Nostr sync", err);
      });
  }, [defaultRelays]);

  return { pendingNostrOutboxCount, retryNostrOutbox };
}
