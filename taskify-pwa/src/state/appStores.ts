import { useSyncExternalStore } from "react";
import { loadStoredCalendarEvents } from "../domains/calendar/storedCalendarEvents";
import { withBoardOrder } from "../domains/tasks/boardUtils";
import { loadStoredBoards, loadStoredTasks } from "../domains/tasks/storedTasks";
import type { Board, CalendarEvent, Task } from "../domains/tasks/taskTypes";
import {
  boardEntityStore,
  calendarEventEntityStore,
  externalCalendarEventEntityStore,
  taskEntityStore,
} from "../storage/entityStore";
import { createStateStore, type StateStore, type StateUpdater } from "./stateStore";

/**
 * The app's entity lists: one store each for tasks, boards and calendar events. Each is created on
 * first use (after storage bootstrap has loaded the entity stores), and each change is written to
 * IndexedDB by its own subscriber, which only writes the rows that changed.
 */
let tasks: StateStore<Task[]> | null = null;
let boards: StateStore<Board[]> | null = null;
let calendarEvents: StateStore<CalendarEvent[]> | null = null;

function persistOnChange<T>(store: StateStore<T>, label: string, save: (value: T) => void): StateStore<T> {
  store.subscribe(() => {
    try {
      save(store.get());
    } catch (err) {
      console.error(`Failed to save ${label}`, err);
    }
  });
  return store;
}

export function tasksStore(): StateStore<Task[]> {
  tasks ??= persistOnChange(createStateStore(loadStoredTasks()), "tasks", (next) => taskEntityStore.syncWith(next));
  return tasks;
}

export function boardsStore(): StateStore<Board[]> {
  if (!boards) {
    const store = createStateStore(loadStoredBoards());
    // Boards saved before `order` was persisted get it written once, without waiting for an edit.
    const ordered = withBoardOrder(store.get());
    if (shouldBackfillPersistedBoardOrder(ordered)) boardEntityStore.syncWith(ordered);
    boards = persistOnChange(store, "boards", (next) => boardEntityStore.syncWith(withBoardOrder(next)));
  }
  return boards;
}

export function calendarEventsStore(): StateStore<CalendarEvent[]> {
  calendarEvents ??= persistOnChange(createStateStore(loadStoredCalendarEvents()), "calendar events", (next) => {
    calendarEventEntityStore.syncWith(next.filter((event) => !event.external));
    externalCalendarEventEntityStore.syncWith(next.filter((event) => event.external));
  });
  return calendarEvents;
}

function useStore<T>(store: StateStore<T>): readonly [T, (update: StateUpdater<T>) => void] {
  return [useSyncExternalStore(store.subscribe, store.get), store.set] as const;
}

/** `[tasks, setTasks]`; `setTasks` applies immediately, so callers can read the result with `tasksStore().get()`. */
export function useTasks() {
  return useStore(tasksStore());
}

export function useBoards() {
  return useStore(boardsStore());
}

export function useCalendarEvents() {
  return useStore(calendarEventsStore());
}

function shouldBackfillPersistedBoardOrder(next: Board[]): boolean {
  if (boardEntityStore.size() === 0) return false;
  const stored = boardEntityStore.getAll() as Board[];
  if (stored.length !== next.length) return false;
  const storedById = new Map(stored.map((board) => [board.id, board]));
  return next.some((board) => {
    const persisted = storedById.get(board.id);
    return !!persisted && persisted.order !== board.order;
  });
}

/** Drops the stores so the next use reloads from storage. Tests only. */
export function resetAppStoresForTests(): void {
  tasks = null;
  boards = null;
  calendarEvents = null;
}
