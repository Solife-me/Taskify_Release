/**
 * What task and event cards can do, and what they need to know, wherever they appear (boards,
 * Upcoming, a board's upcoming section). `App` owns the behaviour and provides it here, so pages
 * render cards without threading a dozen callbacks through every component.
 *
 * Two parts, because they change at different rates:
 * - `TaskActions`: a stable object; each method calls `App`'s latest handler. Its identity never
 *   changes, so it never re-renders anything.
 * - `TaskView`: selection, sync and display state, which does change as the user works. It is
 *   held in a store, and each card selects only what it shows, so selecting one card re-renders
 *   that card and not the rest of the board (tested in `boardRenderIsolation.test.tsx`).
 */
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { isListLikeBoard } from "taskify-core";
import { isUsHolidayCalendarEvent } from "../../domains/calendar/holidayUtils";
import { isCalendarEventVisibleOnListBoard, SPECIAL_CALENDAR_US_HOLIDAYS_LABEL } from "../../domains/calendar/calendarUtils";
import type { MoveTarget } from "../../domains/tasks/taskCommands";
import { isVisibleNow } from "../../domains/tasks/boardUtils";
import { createStateStore, type StateStore } from "../../state/stateStore";
import type { TaskDocument } from "../../lib/documents";
import type { Board, CalendarEvent, Task, Weekday } from "../../domains/tasks/taskTypes";
import { EventCard } from "../calendar/EventCard";
import { Card } from "./Card";

export type TaskActions = {
  completeTask: (id: string, options?: { inboxAction?: "dismiss" }) => unknown;
  restoreTask: (id: string) => void;
  revealBounty: (id: string) => unknown;
  claimBounty: (id: string, from?: DOMRect) => unknown;
  editTask: (task: Task) => void;
  editEvent: (event: CalendarEvent) => void;
  toggleSubtask: (taskId: string, subtaskId: string) => void;
  moveTask: (id: string, target: MoveTarget, beforeId?: string) => void;
  /** Shows a task hidden until later (a "reveal now" action). */
  revealTaskNow: (id: string) => void;
  revealEventNow: (id: string) => void;
  openDocument: (task: Task, doc: TaskDocument) => void;
  openEventDocument: (doc: TaskDocument, boardId?: string) => void;
  openNote: (taskId: string) => void;
  startTaskDrag: (id: string) => void;
  startEventDrag: (id: string) => void;
  endDrag: () => void;
  flyToCompleted: (from: DOMRect) => void;
  toggleItemSelection: (id: string) => void;
};

export type TaskView = {
  isSelectionMode: boolean;
  selectedItemIds: string[];
  pendingTaskIds: ReadonlySet<string>;
  pendingEventIds: ReadonlySet<string>;
  runningStreakFor: (task: Task) => number | undefined;
  showStreaks: boolean;
  hideCompletedSubtasks: boolean;
  /** Completing a task flies it to the Completed button when that tab exists. */
  completedTab: boolean;
  boardsById: Map<string, Board>;
  weekStart: Weekday;
};

const TaskActionsContext = createContext<TaskActions | null>(null);
const TaskViewContext = createContext<StateStore<TaskView> | null>(null);

/** A stable object whose methods always call the latest `handlers` (set before the browser paints). */
function useStableActions(handlers: TaskActions): TaskActions {
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  return useMemo(() => {
    const stable = {} as Record<string, (...args: unknown[]) => unknown>;
    for (const key of Object.keys(handlers)) {
      stable[key] = (...args: unknown[]) => (latest.current as unknown as Record<string, (...a: unknown[]) => unknown>)[key](...args);
    }
    return stable as unknown as TaskActions;
    // The set of actions is fixed; only their implementations change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function TaskActionsProvider({ actions, view, children }: { actions: TaskActions; view: TaskView; children: ReactNode }) {
  const stableActions = useStableActions(actions);
  const [viewStore] = useState(() => createStateStore(view));
  // Published before paint; only cards whose selected values changed re-render.
  useLayoutEffect(() => {
    viewStore.set(view);
  }, [view, viewStore]);
  return (
    <TaskActionsContext.Provider value={stableActions}>
      <TaskViewContext.Provider value={viewStore}>{children}</TaskViewContext.Provider>
    </TaskActionsContext.Provider>
  );
}

function useTaskViewStore(): StateStore<TaskView> {
  const store = useContext(TaskViewContext);
  if (!store) throw new Error("useTaskView needs a TaskActionsProvider");
  return store;
}

export function useTaskActions(): TaskActions {
  const actions = useContext(TaskActionsContext);
  if (!actions) throw new Error("useTaskActions needs a TaskActionsProvider");
  return actions;
}

/** The whole view state; re-renders on any change. Cards use `useTaskViewSelector` instead. */
export function useTaskView(): TaskView {
  const store = useTaskViewStore();
  return useSyncExternalStore(store.subscribe, store.get);
}

/**
 * One value from the view state; re-renders only when it changes (`Object.is`), so `select`
 * must return a primitive or an object that keeps its identity.
 */
export function useTaskViewSelector<T>(select: (view: TaskView) => T): T {
  const store = useTaskViewStore();
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** Reads the view state at event time (a click or a drag), without subscribing. */
function useTaskViewGetter(): () => TaskView {
  return useTaskViewStore().get;
}

function sameMoveTarget(a: MoveTarget | undefined, b: MoveTarget | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.type === "day") return b.type === "day" && a.day === b.day;
  return b.type === "list" && a.columnId === b.columnId;
}

/**
 * The checkbox does what the task's state calls for: complete it, reveal or claim a bounty,
 * or restore a completed task.
 */
function completeOrUndo(task: Task, actions: TaskActions, from?: DOMRect) {
  if (!task.completed) actions.completeTask(task.id);
  else if (task.bounty?.state === "locked") actions.revealBounty(task.id);
  else if (task.bounty?.state === "unlocked" && task.bounty.token) actions.claimBounty(task.id, from);
  else actions.restoreTask(task.id);
}

type BoardTaskCardProps = {
  task: Task;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Where a task dropped onto this card goes (just before it); omit where order is not manual. */
  dropTarget?: MoveTarget;
};

export const BoardTaskCard = memo(function BoardTaskCard({ task, meta, trailing, dropTarget }: BoardTaskCardProps) {
  const actions = useTaskActions();
  const getView = useTaskViewGetter();
  const isSelectionMode = useTaskViewSelector((view) => view.isSelectionMode);
  const isSelected = useTaskViewSelector((view) => view.selectedItemIds.includes(task.id));
  const syncPending = useTaskViewSelector((view) => view.pendingTaskIds.has(task.id));
  const displayStreak = useTaskViewSelector((view) => view.runningStreakFor(task));
  const showStreaks = useTaskViewSelector((view) => view.showStreaks);
  const hideCompletedSubtasks = useTaskViewSelector((view) => view.hideCompletedSubtasks);

  const taskId = task.id;
  const dropDay = dropTarget?.type === "day" ? dropTarget.day : undefined;
  const dropColumnId = dropTarget?.type === "list" ? dropTarget.columnId : undefined;
  const onDropBefore = useCallback((dragId: string) => {
    if (dropDay !== undefined) actions.moveTask(dragId, { type: "day", day: dropDay }, taskId);
    else if (dropColumnId !== undefined) actions.moveTask(dragId, { type: "list", columnId: dropColumnId }, taskId);
  }, [actions, dropColumnId, dropDay, taskId]);
  const onFlyToCompleted = useCallback((rect: DOMRect) => {
    if (getView().completedTab) actions.flyToCompleted(rect);
  }, [actions, getView]);
  const onComplete = useCallback((from?: DOMRect) => completeOrUndo(task, actions, from), [actions, task]);
  const onEdit = useCallback(() => actions.editTask(task), [actions, task]);
  const onToggleSubtask = useCallback((subtaskId: string) => actions.toggleSubtask(taskId, subtaskId), [actions, taskId]);
  const onOpenNote = useCallback(() => actions.openNote(taskId), [actions, taskId]);
  const onDismissInbox = useCallback(() => actions.completeTask(taskId, { inboxAction: "dismiss" }), [actions, taskId]);
  const getSelectedTaskIds = useCallback(() => getView().selectedItemIds, [getView]);

  return (
    <Card
      task={task}
      meta={meta}
      trailing={trailing}
      displayStreak={displayStreak}
      isSelectionMode={isSelectionMode}
      isSelected={isSelected}
      onToggleSelect={actions.toggleItemSelection}
      getSelectedTaskIds={getSelectedTaskIds}
      syncPending={syncPending}
      onFlyToCompleted={onFlyToCompleted}
      onComplete={onComplete}
      onEdit={onEdit}
      onDropBefore={onDropBefore}
      showStreaks={showStreaks}
      onToggleSubtask={onToggleSubtask}
      onDragStart={actions.startTaskDrag}
      onDragEnd={actions.endDrag}
      hideCompletedSubtasks={hideCompletedSubtasks}
      onOpenDocument={actions.openDocument}
      onOpenNote={onOpenNote}
      onDismissInbox={task.inboxItem ? onDismissInbox : undefined}
    />
  );
}, (prev, next) =>
  prev.task === next.task
  && prev.meta === next.meta
  && prev.trailing === next.trailing
  && sameMoveTarget(prev.dropTarget, next.dropTarget));

type BoardEventCardProps = {
  event: CalendarEvent;
  showDate?: boolean;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Generated events (US holidays) can't be edited or moved. */
  readOnly?: boolean;
};

export const BoardEventCard = memo(function BoardEventCard({ event, showDate, meta, trailing, readOnly = false }: BoardEventCardProps) {
  const actions = useTaskActions();
  const isSelectionMode = useTaskViewSelector((view) => view.isSelectionMode);
  const isSelected = useTaskViewSelector((view) => view.selectedItemIds.includes(event.id));
  const syncPending = useTaskViewSelector((view) => view.pendingEventIds.has(event.id));
  const onOpenDocument = useCallback(
    (ev: CalendarEvent, doc: TaskDocument) => actions.openEventDocument(doc, ev.boardId),
    [actions],
  );
  const onEdit = useCallback(() => actions.editEvent(event), [actions, event]);
  return (
    <EventCard
      event={event}
      syncPending={syncPending}
      showDate={showDate}
      meta={meta}
      trailing={trailing}
      onOpenDocument={onOpenDocument}
      onEdit={readOnly ? undefined : onEdit}
      onDragStart={readOnly ? undefined : actions.startEventDrag}
      onDragEnd={actions.endDrag}
      isSelectionMode={isSelectionMode}
      isSelected={isSelected}
      onToggleSelect={actions.toggleItemSelection}
    />
  );
});

function RevealNowButton({ onReveal }: { onReveal: () => void }) {
  return (
    <button type="button" className="icon-button icon-button--accent pressable" aria-label="Reveal now" title="Reveal now" onClick={onReveal}>
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

function placement(board: Board | undefined, columnId: string | undefined, fallback: string): string {
  const boardLabel = board?.name || fallback;
  const listLabel = board?.kind === "lists" ? board.columns.find((column) => column.id === columnId)?.name || "" : "";
  return listLabel ? `${boardLabel} • ${listLabel}` : boardLabel;
}

/** A task in Upcoming: labeled with its board and list, with "reveal now" if it is hidden until later. */
export function UpcomingTaskCard({ task }: { task: Task }) {
  const actions = useTaskActions();
  const { boardsById } = useTaskView();
  const canReveal = !!task.hiddenUntilISO && !isVisibleNow(task);
  return (
    <div className="space-y-2">
      <BoardTaskCard
        task={task}
        meta={placement(boardsById.get(task.boardId), task.columnId, "Board")}
        trailing={canReveal ? <RevealNowButton onReveal={() => actions.revealTaskNow(task.id)} /> : null}
      />
    </div>
  );
}

/** An event in Upcoming: labeled with its board, list and first location. */
export function UpcomingEventCard({ event }: { event: CalendarEvent }) {
  const actions = useTaskActions();
  const { boardsById, weekStart } = useTaskView();
  const holiday = isUsHolidayCalendarEvent(event);
  const board = boardsById.get(event.boardId);
  const place = holiday ? SPECIAL_CALENDAR_US_HOLIDAYS_LABEL : placement(board, event.columnId, "Board");
  const location = (event.locations || []).find((value) => typeof value === "string" && value.trim())?.trim() || "";
  const canReveal = !!event.hiddenUntilISO && !!board && isListLikeBoard(board)
    && !isCalendarEventVisibleOnListBoard(event, weekStart, new Date());
  return (
    <div className="space-y-2">
      <BoardEventCard
        event={event}
        showDate={false}
        meta={location ? `${place} • ${location}` : place}
        trailing={canReveal ? <RevealNowButton onReveal={() => actions.revealEventNow(event.id)} /> : null}
        readOnly={holiday}
      />
    </div>
  );
}
