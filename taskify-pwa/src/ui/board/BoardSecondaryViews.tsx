import type { CSSProperties, ReactNode } from "react";
import type { Board, CalendarEvent, Task, Weekday } from "taskify-core";
import { WD_SHORT } from "../../domains/appTypes";
import { formatTimeLabel, taskWeekday } from "../../domains/dateTime/dateUtils";
import { isFrequentRecurrence } from "../../domains/tasks/boardUtils";
import {
  bountyStateLabel,
  isRecoverableBountyTask,
} from "../../domains/tasks/taskUtils";
import type { TaskDocument } from "../../lib/documents";
import { TaskMedia } from "../task/TaskMedia";
import { TaskTitle } from "../task/TaskTitle";

type BoardUpcomingGroup = {
  dateKey: string;
  label: string;
  events: CalendarEvent[];
  tasks: Task[];
};

type CompletedBibleBook = {
  id: string;
  name: string;
  completedAtISO: string;
};

type BoardUpcomingViewProps = {
  boardUpcomingCount: number;
  boardUpcomingGroups: BoardUpcomingGroup[];
  renderUpcomingEventCard: (event: CalendarEvent) => ReactNode;
  renderUpcomingTaskCard: (task: Task) => ReactNode;
};

type CompletedBoardViewProps = {
  clearCompleted: () => void;
  completed: Task[];
  completedBibleBooks: CompletedBibleBook[];
  currentBoard: Board | null | undefined;
  deleteTask: (taskId: string) => void;
  handleOpenDocument: (task: Task, doc: TaskDocument) => void;
  handleRestoreBibleBook: (bookId: string) => void;
  restoreTask: (taskId: string) => void;
  streaksEnabled: boolean;
};

function CompletedIconButton({
  children,
  intent,
  label,
  onClick,
}: {
  children: ReactNode;
  intent?: "danger" | "success";
  label: string;
  onClick: () => void;
}) {
  const cls = `icon-button pressable ${intent === "danger" ? "icon-button--danger" : intent === "success" ? "icon-button--success" : ""}`;
  return (
    <button
      aria-label={label}
      title={label}
      className={cls}
      style={{ "--icon-size": "2.35rem" } as CSSProperties}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function BoardUpcomingView({
  boardUpcomingCount,
  boardUpcomingGroups,
  renderUpcomingEventCard,
  renderUpcomingTaskCard,
}: BoardUpcomingViewProps) {
  return (
    <div className="surface-panel board-column p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-lg font-semibold">Upcoming</div>
      </div>
      {boardUpcomingCount === 0 ? (
        <div className="text-secondary text-sm">No upcoming items on this board.</div>
      ) : (
        <div className="upcoming-list space-y-4">
          {boardUpcomingGroups.map((group) => (
            <div key={group.dateKey} className="upcoming-day" data-upcoming-date={group.dateKey}>
              <div className="upcoming-day__label">{group.label}</div>
              <div className="space-y-2">
                {group.events.map((event) => renderUpcomingEventCard(event))}
                {group.tasks.map((task) => renderUpcomingTaskCard(task))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CompletedBoardView({
  clearCompleted,
  completed,
  completedBibleBooks,
  currentBoard,
  deleteTask,
  handleOpenDocument,
  handleRestoreBibleBook,
  restoreTask,
  streaksEnabled,
}: CompletedBoardViewProps) {
  return (
    <div className="surface-panel board-column p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-lg font-semibold">Completed</div>
        {currentBoard?.kind !== "bible" && !currentBoard?.clearCompletedDisabled && (
          <div className="ml-auto">
            <button
              className="ghost-button button-sm pressable text-rose-400"
              onClick={clearCompleted}
            >
              Clear completed
            </button>
          </div>
        )}
      </div>
      {currentBoard?.kind === "bible" ? (
        completedBibleBooks.length === 0 ? (
          <div className="text-secondary text-sm">No completed books yet.</div>
        ) : (
          <ul className="space-y-1.5">
            {completedBibleBooks.map((book) => (
              <li
                key={book.id}
                className="task-card space-y-2"
                data-state="completed"
                data-form="pill"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="text-sm font-medium leading-[1.15]">{book.name}</div>
                    <div className="text-xs text-secondary">
                      {book.completedAtISO
                        ? `Completed ${new Date(book.completedAtISO).toLocaleString()}`
                        : "Completed book"}
                    </div>
                  </div>
                  <CompletedIconButton label="Restore" onClick={() => handleRestoreBibleBook(book.id)} intent="success">
                    {"\u21a9\ufe0e"}
                  </CompletedIconButton>
                </div>
              </li>
            ))}
          </ul>
        )
      ) : completed.length === 0 ? (
        <div className="text-secondary text-sm">No completed tasks yet.</div>
      ) : (
        <ul className="space-y-1.5">
          {completed.map((task) => {
            const recoverableBounty = isRecoverableBountyTask(task);
            const hasDetail =
              !!task.note?.trim() ||
              (task.images && task.images.length > 0) ||
              (task.documents && task.documents.length > 0) ||
              (task.subtasks && task.subtasks.length > 0) ||
              !!task.bounty;
            const scheduledWeekday = taskWeekday(task) ?? (new Date().getDay() as Weekday);
            const scheduledDayLabel = WD_SHORT[scheduledWeekday];
            const scheduledTimeLabel = task.dueTimeEnabled
              ? ` at ${formatTimeLabel(task.dueISO, task.dueTimeZone)}`
              : "";
            const bountyLabel = task.bounty ? bountyStateLabel(task.bounty) : "";
            return (
              <li
                key={task.id}
                className="task-card space-y-2"
                data-state="completed"
                data-form={hasDetail ? "stacked" : "pill"}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="text-sm font-medium leading-[1.15]">
                      <TaskTitle key={`${task.id}:${task.priority ?? "none"}`} task={task} />
                    </div>
                    <div className="text-xs text-secondary">
                      {currentBoard?.kind === "week"
                        ? `Scheduled ${scheduledDayLabel}${scheduledTimeLabel}`
                        : "Completed item"}
                      {task.completedAt ? ` \u2022 Completed ${new Date(task.completedAt).toLocaleString()}` : ""}
                      {streaksEnabled &&
                        task.recurrence &&
                        isFrequentRecurrence(task.recurrence) &&
                        typeof task.streak === "number" &&
                        task.streak > 0
                          ? ` \u2022 \u{1F525} ${task.streak}`
                          : ""}
                      {recoverableBounty ? " \u2022 Recoverable bounty task" : ""}
                    </div>
                    <TaskMedia task={task} onOpenDocument={handleOpenDocument} />
                    {task.inboxItem && (
                      <div className="mt-1 text-xs text-secondary">
                        Shared {task.inboxItem.type === "board" ? "board" : task.inboxItem.type === "contact" ? "contact" : "task"}{" "}
                        {"\u2022"}{" "}
                        {task.inboxItem.status === "accepted"
                          ? "Added"
                          : task.inboxItem.status === "tentative"
                            ? "Maybe"
                            : task.inboxItem.status === "declined"
                              ? "Declined"
                              : task.inboxItem.status === "deleted"
                                ? "Dismissed"
                                : "Pending"}
                      </div>
                    )}
                    {task.subtasks?.length ? (
                      <ul className="mt-1 space-y-1 text-xs">
                        {task.subtasks.map((subtask) => (
                          <li key={subtask.id} className="subtask-row">
                            <input type="checkbox" checked={!!subtask.completed} disabled className="subtask-row__checkbox" />
                            <span className={`subtask-row__text ${subtask.completed ? "line-through text-secondary" : ""}`}>
                              {subtask.title}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {task.bounty && (
                      <div className="mt-1">
                        <span className={`text-[0.6875rem] px-2 py-0.5 rounded-full border ${task.bounty.state === "unlocked" ? "bg-emerald-700/30 border-emerald-700" : task.bounty.state === "locked" ? "bg-neutral-700/40 border-neutral-600" : task.bounty.state === "revoked" ? "bg-rose-700/30 border-rose-700" : "bg-surface-muted border-surface"}`}>
                          Bounty {typeof task.bounty.amount === "number" ? `\u2022 ${task.bounty.amount} sats` : ""} {"\u2022"} {bountyLabel}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1">
                    <CompletedIconButton label={recoverableBounty ? "Recover" : "Restore"} onClick={() => restoreTask(task.id)} intent="success">
                      {"\u21a9\ufe0e"}
                    </CompletedIconButton>
                    {!recoverableBounty && (
                      <CompletedIconButton label="Delete" onClick={() => deleteTask(task.id)} intent="danger">
                        {"\u2715"}
                      </CompletedIconButton>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
