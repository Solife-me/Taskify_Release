/**
 * What task and event cards can do, and what they need to know, wherever they appear (boards,
 * Upcoming, a board's upcoming section). `App` owns the behaviour and provides it here, so pages
 * render cards without threading a dozen callbacks through every component.
 *
 * Two contexts, because they change at different rates:
 * - `TaskActions`: a stable object; each method calls `App`'s latest handler. Its identity never
 *   changes, so it never re-renders anything.
 * - `TaskView`: selection, sync and display state, which does change as the user works.
 */
import { createContext, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { isListLikeBoard } from "taskify-core";
import { isUsHolidayCalendarEvent } from "../../domains/calendar/holidayUtils";
import { isCalendarEventVisibleOnListBoard, SPECIAL_CALENDAR_US_HOLIDAYS_LABEL } from "../../domains/calendar/calendarUtils";
import type { MoveTarget } from "../../domains/tasks/taskCommands";
import { isVisibleNow } from "../../domains/tasks/boardUtils";
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
const TaskViewContext = createContext<TaskView | null>(null);

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
  return (
    <TaskActionsContext.Provider value={stableActions}>
      <TaskViewContext.Provider value={view}>{children}</TaskViewContext.Provider>
    </TaskActionsContext.Provider>
  );
}

export function useTaskActions(): TaskActions {
  const actions = useContext(TaskActionsContext);
  if (!actions) throw new Error("useTaskActions needs a TaskActionsProvider");
  return actions;
}

export function useTaskView(): TaskView {
  const view = useContext(TaskViewContext);
  if (!view) throw new Error("useTaskView needs a TaskActionsProvider");
  return view;
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

export function BoardTaskCard({
  task,
  meta,
  trailing,
  onDropBefore,
}: {
  task: Task;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** A task dropped onto this card goes just before it; omit where order is not manual. */
  onDropBefore?: (dragId: string) => void;
}) {
  const actions = useTaskActions();
  const view = useTaskView();
  return (
    <Card
      task={task}
      meta={meta}
      trailing={trailing}
      displayStreak={view.runningStreakFor(task)}
      isSelectionMode={view.isSelectionMode}
      isSelected={view.selectedItemIds.includes(task.id)}
      onToggleSelect={actions.toggleItemSelection}
      selectedTaskIds={view.isSelectionMode ? view.selectedItemIds : undefined}
      syncPending={view.pendingTaskIds.has(task.id)}
      onFlyToCompleted={(rect) => {
        if (view.completedTab) actions.flyToCompleted(rect);
      }}
      onComplete={(from) => completeOrUndo(task, actions, from)}
      onEdit={() => actions.editTask(task)}
      onDropBefore={onDropBefore ?? (() => {})}
      showStreaks={view.showStreaks}
      onToggleSubtask={(subtaskId) => actions.toggleSubtask(task.id, subtaskId)}
      onDragStart={actions.startTaskDrag}
      onDragEnd={actions.endDrag}
      hideCompletedSubtasks={view.hideCompletedSubtasks}
      onOpenDocument={actions.openDocument}
      onOpenNote={() => actions.openNote(task.id)}
      onDismissInbox={task.inboxItem ? () => actions.completeTask(task.id, { inboxAction: "dismiss" }) : undefined}
    />
  );
}

export function BoardEventCard({
  event,
  showDate,
  meta,
  trailing,
  readOnly = false,
}: {
  event: CalendarEvent;
  showDate?: boolean;
  meta?: ReactNode;
  trailing?: ReactNode;
  /** Generated events (US holidays) can't be edited or moved. */
  readOnly?: boolean;
}) {
  const actions = useTaskActions();
  const view = useTaskView();
  return (
    <EventCard
      event={event}
      syncPending={view.pendingEventIds.has(event.id)}
      showDate={showDate}
      meta={meta}
      trailing={trailing}
      onOpenDocument={(ev, doc) => actions.openEventDocument(doc, ev.boardId)}
      onEdit={readOnly ? undefined : () => actions.editEvent(event)}
      onDragStart={readOnly ? undefined : actions.startEventDrag}
      onDragEnd={actions.endDrag}
      isSelectionMode={view.isSelectionMode}
      isSelected={view.selectedItemIds.includes(event.id)}
      onToggleSelect={actions.toggleItemSelection}
    />
  );
}

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
