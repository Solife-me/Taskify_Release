/**
 * The Boards tab: the account's boards, and the tasks of the selected one.
 *
 * A board is either a week (tasks filed under a day) or lists (tasks filed under a column), so
 * the task list is grouped the same way the PWA groups it.
 */
import React, { useMemo, useState } from "react";
import type { Board, Task } from "taskify-core";
import { useApp } from "./state";
import { formatDueLabel, isOverdue } from "./format";

/** The week days, in order. */
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function boardTaskGroups(board: Board, tasks: Task[]): { label: string; tasks: Task[] }[] {
  const boardTasks = tasks.filter((task) => task.boardId === board.id);
  if (board.kind === "week") {
    return WEEKDAYS.map((day) => ({
      label: day,
      tasks: boardTasks.filter((task) => (task.columnId || "").toLowerCase() === day.toLowerCase()),
    })).filter((group) => group.tasks.length > 0);
  }
  if (board.kind === "lists" || board.kind === "compound") {
    const columns = board.kind === "lists" ? board.columns : [];
    const groups = columns.map((column) => ({
      label: column.name,
      tasks: boardTasks.filter((task) => task.columnId === column.id),
    }));
    const unlisted = boardTasks.filter(
      (task) => !columns.some((column) => column.id === task.columnId),
    );
    if (unlisted.length) groups.push({ label: "Other", tasks: unlisted });
    return groups;
  }
  return [{ label: "Tasks", tasks: boardTasks }];
}

function TaskRow({ task }: { task: Task }) {
  const overdue = isOverdue(task);
  const due = formatDueLabel(task.dueISO);
  return (
    <div className="taskrow">
      <span
        className={`taskrow__check${task.completed ? " taskrow__check--done" : ""}`}
        role="img"
        aria-label={task.completed ? "Completed" : "Not completed"}
      >
        ✓
      </span>
      <div className="taskrow__body">
        <div className={`taskrow__title${task.completed ? " taskrow__title--done" : ""}`}>
          {task.title || "Untitled task"}
        </div>
        <div className="card__meta">
          {due ? <span className={`pill ${overdue ? "pill--overdue" : "pill--due"}`}>{due}</span> : null}
          {task.priority === 3 ? <span className="pill">High</span> : null}
          {task.priority === 2 ? <span className="pill">Medium</span> : null}
          {task.note ? <span className="pill">Note</span> : null}
        </div>
      </div>
    </div>
  );
}

export function Boards() {
  const { boards, tasks, currentBoardId, selectBoard, loading } = useApp();
  const [showAllBoards, setShowAllBoards] = useState(false);

  const current = boards.find((board) => board.id === currentBoardId) ?? null;

  const groups = useMemo(
    () => (current ? boardTaskGroups(current, tasks) : []),
    [current, tasks],
  );

  if (!boards.length) {
    return (
      <div className="empty">
        <div className="empty__title">{loading ? "Loading your boards…" : "No boards yet"}</div>
        {!loading && (
          <p className="hint">
            Boards appear here once the account backup has been published. Open the Taskify web app
            and create or share a board, then refresh.
          </p>
        )}
      </div>
    );
  }

  if (showAllBoards || !current) {
    return (
      <div className="pad">
        <div className="sectionhead">Your boards</div>
        <div className="boardgrid">
          {boards.map((board) => {
            const count = tasks.filter((task) => task.boardId === board.id && !task.completed).length;
            return (
              <button
                key={board.id}
                type="button"
                className="boardtile"
                onClick={() => {
                  selectBoard(board.id);
                  setShowAllBoards(false);
                }}
              >
                <div className="boardtile__name">{board.name}</div>
                <div className="boardtile__meta">
                  {board.kind} · {count} open
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const open = groups.reduce((total, group) => total + group.tasks.filter((task) => !task.completed).length, 0);
  const done = groups.reduce((total, group) => total + group.tasks.filter((task) => task.completed).length, 0);

  return (
    <div className="pad">
      <div className="row" style={{ marginBottom: 10 }}>
        <button type="button" className="btn" onClick={() => setShowAllBoards(true)}>
          ← Boards
        </button>
        <div style={{ flex: 1, minWidth: 0, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current.name}
        </div>
        <span className="pill">{open} open</span>
        {done > 0 ? <span className="pill pill--done">{done} done</span> : null}
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <div className="empty__title">Nothing here yet</div>
          <p className="hint">Add tasks in the Taskify app and they will show up here.</p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.label}>
            <div className="sectionhead">
              {group.label}
              <span className="pill">{group.tasks.length}</span>
            </div>
            <div className="tasklist">
              {group.tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
