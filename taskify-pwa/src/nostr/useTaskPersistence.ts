import { useCallback, useEffect, useRef, useState } from "react";
import type { NostrOutboxMutation } from "taskify-runtime-nostr";
import type { Board, CalendarEvent, Task } from "../domains/tasks/taskTypes";
import {
  TASKIFY_CALENDAR_EVENT_KIND,
  TASKIFY_CALENDAR_VIEW_KIND,
} from "../lib/privateCalendar";
import {
  boardEntityStore,
  calendarEventEntityStore,
  externalCalendarEventEntityStore,
  taskEntityStore,
} from "../storage/entityStore";
import { withBoardOrder } from "../domains/tasks/boardUtils";
import { nostrOutboxStore } from "./NostrOutboxStore";

const TASKIFY_TASK_EVENT_KIND = 30301;

type PendingNostrItemSync = {
  taskIds: Set<string>;
  calendarEventIds: Set<string>;
};

type OutboxItemSyncSnapshot = PendingNostrItemSync & {
  ackedTaskIds: Set<string>;
  ackedCalendarEventIds: Set<string>;
  rowTaskIds: Set<string>;
  rowCalendarEventIds: Set<string>;
};

const emptyPendingNostrItemSync = (): PendingNostrItemSync => ({
  taskIds: new Set<string>(),
  calendarEventIds: new Set<string>(),
});

const emptyOutboxItemSyncSnapshot = (): OutboxItemSyncSnapshot => ({
  ...emptyPendingNostrItemSync(),
  ackedTaskIds: new Set<string>(),
  ackedCalendarEventIds: new Set<string>(),
  rowTaskIds: new Set<string>(),
  rowCalendarEventIds: new Set<string>(),
});

type UseTaskPersistenceParams = {
  boards: Board[];
  calendarEvents: CalendarEvent[];
  tasks: Task[];
};

export function useTaskPersistence({
  boards,
  calendarEvents,
  tasks,
}: UseTaskPersistenceParams) {
  const boardsFirstRun = useRef(true);
  useEffect(() => {
    const orderedBoards = withBoardOrder(boards);
    if (boardsFirstRun.current) {
      boardsFirstRun.current = false;
      if (shouldBackfillPersistedBoardOrder(orderedBoards)) {
        boardEntityStore.syncWith(orderedBoards);
      }
      return;
    }
    boardEntityStore.syncWith(orderedBoards);
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

  const [pendingNostrItemSync, setPendingNostrItemSync] = useState<PendingNostrItemSync>(() => emptyPendingNostrItemSync());
  const optimisticTaskIdsRef = useRef<Set<string>>(new Set());
  const optimisticCalendarEventIdsRef = useRef<Set<string>>(new Set());
  const seenTaskRowsRef = useRef<Set<string>>(new Set());
  const seenCalendarEventRowsRef = useRef<Set<string>>(new Set());
  const outboxPendingTaskIdsRef = useRef<Set<string>>(new Set());
  const outboxPendingCalendarEventIdsRef = useRef<Set<string>>(new Set());
  const applyPendingRows = useCallback((rows: NostrOutboxMutation[]) => {
    const snapshot = buildPendingNostrItemSync(rows);
    outboxPendingTaskIdsRef.current = snapshot.taskIds;
    outboxPendingCalendarEventIdsRef.current = snapshot.calendarEventIds;

    snapshot.rowTaskIds.forEach((id) => seenTaskRowsRef.current.add(id));
    snapshot.rowCalendarEventIds.forEach((id) => seenCalendarEventRowsRef.current.add(id));

    snapshot.ackedTaskIds.forEach((id) => {
      optimisticTaskIdsRef.current.delete(id);
      seenTaskRowsRef.current.delete(id);
    });
    snapshot.ackedCalendarEventIds.forEach((id) => {
      optimisticCalendarEventIdsRef.current.delete(id);
      seenCalendarEventRowsRef.current.delete(id);
    });

    optimisticTaskIdsRef.current.forEach((id) => {
      if (seenTaskRowsRef.current.has(id) && !snapshot.rowTaskIds.has(id)) {
        optimisticTaskIdsRef.current.delete(id);
        seenTaskRowsRef.current.delete(id);
      }
    });
    optimisticCalendarEventIdsRef.current.forEach((id) => {
      if (seenCalendarEventRowsRef.current.has(id) && !snapshot.rowCalendarEventIds.has(id)) {
        optimisticCalendarEventIdsRef.current.delete(id);
        seenCalendarEventRowsRef.current.delete(id);
      }
    });

    setPendingNostrItemSync({
      taskIds: new Set([...snapshot.taskIds, ...optimisticTaskIdsRef.current]),
      calendarEventIds: new Set([...snapshot.calendarEventIds, ...optimisticCalendarEventIdsRef.current]),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    nostrOutboxStore.getPendingRows().then((rows) => {
      if (!cancelled) applyPendingRows(rows);
    });
    const unsubscribe = nostrOutboxStore.subscribeRows((rows) => {
      if (!cancelled) applyPendingRows(rows);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyPendingRows]);

  const markNostrTaskSyncPending = useCallback((id: string) => {
    if (!id) return;
    optimisticTaskIdsRef.current.add(id);
    setPendingNostrItemSync((prev) => {
      if (prev.taskIds.has(id)) return prev;
      const taskIds = new Set(prev.taskIds);
      taskIds.add(id);
      return { ...prev, taskIds };
    });
  }, []);

  const markNostrCalendarEventSyncPending = useCallback((id: string) => {
    if (!id) return;
    optimisticCalendarEventIdsRef.current.add(id);
    setPendingNostrItemSync((prev) => {
      if (prev.calendarEventIds.has(id)) return prev;
      const calendarEventIds = new Set(prev.calendarEventIds);
      calendarEventIds.add(id);
      return { ...prev, calendarEventIds };
    });
  }, []);

  const clearOptimisticNostrTaskSyncPending = useCallback((id: string) => {
    if (!id) return;
    optimisticTaskIdsRef.current.delete(id);
    seenTaskRowsRef.current.delete(id);
    if (outboxPendingTaskIdsRef.current.has(id)) return;
    setPendingNostrItemSync((prev) => {
      if (!prev.taskIds.has(id)) return prev;
      const taskIds = new Set(prev.taskIds);
      taskIds.delete(id);
      return { ...prev, taskIds };
    });
  }, []);

  const clearOptimisticNostrCalendarEventSyncPending = useCallback((id: string) => {
    if (!id) return;
    optimisticCalendarEventIdsRef.current.delete(id);
    seenCalendarEventRowsRef.current.delete(id);
    if (outboxPendingCalendarEventIdsRef.current.has(id)) return;
    setPendingNostrItemSync((prev) => {
      if (!prev.calendarEventIds.has(id)) return prev;
      const calendarEventIds = new Set(prev.calendarEventIds);
      calendarEventIds.delete(id);
      return { ...prev, calendarEventIds };
    });
  }, []);

  return {
    clearOptimisticNostrCalendarEventSyncPending,
    clearOptimisticNostrTaskSyncPending,
    markNostrCalendarEventSyncPending,
    markNostrTaskSyncPending,
    pendingNostrCalendarEventIds: pendingNostrItemSync.calendarEventIds,
    pendingNostrTaskIds: pendingNostrItemSync.taskIds,
  };
}

function buildPendingNostrItemSync(rows: NostrOutboxMutation[]): OutboxItemSyncSnapshot {
  const next = emptyOutboxItemSyncSnapshot();
  rows.forEach((row) => {
    const ackedRelays = Array.isArray(row.ackedRelays) ? row.ackedRelays : [];
    const event = row.payload.event;
    const id = tagValue(Array.isArray(event.tags) ? event.tags : [], "d");
    if (!id) return;
    if (event.kind === TASKIFY_TASK_EVENT_KIND) {
      next.rowTaskIds.add(id);
      if (ackedRelays.length > 0) next.ackedTaskIds.add(id);
      else next.taskIds.add(id);
      return;
    }
    if (event.kind === TASKIFY_CALENDAR_EVENT_KIND || event.kind === TASKIFY_CALENDAR_VIEW_KIND) {
      next.rowCalendarEventIds.add(id);
      if (ackedRelays.length > 0) next.ackedCalendarEventIds.add(id);
      else next.calendarEventIds.add(id);
    }
  });
  return next;
}

function tagValue(tags: string[][], name: string): string | null {
  const value = tags.find((tag) => tag[0] === name)?.[1];
  return typeof value === "string" && value.trim() ? value : null;
}

function shouldBackfillPersistedBoardOrder(boards: Board[]): boolean {
  if (boardEntityStore.size() === 0) return false;
  const stored = boardEntityStore.getAll() as Board[];
  if (stored.length !== boards.length) return false;
  const storedById = new Map(stored.map((board) => [board.id, board]));
  return boards.some((board) => {
    const persisted = storedById.get(board.id);
    return !!persisted && persisted.order !== board.order;
  });
}
