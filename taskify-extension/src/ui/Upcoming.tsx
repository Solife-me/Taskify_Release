/**
 * The Upcoming tab: the account's tasks by the day they are due.
 *
 * This is the PWA's Upcoming view in a narrow column: open tasks grouped by day, then the
 * overdue ones, so nothing due gets lost.
 */
import React, { useMemo, useState } from "react";
import type { Task } from "taskify-core";
import { useApp } from "./state";
import { formatDueLabel, isOverdue } from "./format";

/** The local day key a task falls on. */
function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayTitle(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  const date = new Date(year, month - 1, day);
  const today = new Date();
  const startOf = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOf(date) - startOf(today)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function UpcomingRow({ task, boardLabel }: { task: Task; boardLabel: string }) {
  const overdue = isOverdue(task);
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
          <span className="pill">{boardLabel}</span>
          {overdue ? <span className="pill pill--overdue">Overdue</span> : null}
          {task.priority === 3 ? <span className="pill">High</span> : null}
        </div>
      </div>
    </div>
  );
}

export function Upcoming() {
  const { tasks, boards, loading } = useApp();
  const [showDone, setShowDone] = useState(false);

  const boardLabel = (boardId: string) => boards.find((board) => board.id === boardId)?.name ?? "No board";

  const { overdue, groups } = useMemo(() => {
    const dated = tasks.filter(
      (task) => !task.completed && !!task.dueISO && task.dueISO.length > 0,
    );
    const overdueTasks = dated.filter((task) => isOverdue(task)).sort((a, b) => a.dueISO!.localeCompare(b.dueISO!));
    const byDay = new Map<string, Task[]>();
    for (const task of dated) {
      if (isOverdue(task)) continue;
      const key = dayKey(task.dueISO!);
      if (!key) continue;
      const list = byDay.get(key) ?? [];
      list.push(task);
      byDay.set(key, list);
    }
    const sorted = Array.from(byDay.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, items]) => ({ key, items }));
    return { overdue: overdueTasks, groups: sorted };
  }, [tasks]);

  const completed = useMemo(
    () => tasks.filter((task) => task.completed && !!task.dueISO),
    [tasks],
  );

  if (loading && !tasks.length) {
    return <div className="empty">Loading your tasks…</div>;
  }

  if (!tasks.length) {
    return (
      <div className="empty">
        <div className="empty__title">Nothing scheduled</div>
        <p className="hint">Tasks with a due date will appear here, grouped by day.</p>
      </div>
    );
  }

  return (
    <div className="pad">
      {overdue.length > 0 ? (
        <div>
          <div className="sectionhead">
            Overdue
            <span className="pill pill--overdue">{overdue.length}</span>
          </div>
          <div className="tasklist">
            {overdue.map((task) => (
              <UpcomingRow key={task.id} task={task} boardLabel={boardLabel(task.boardId)} />
            ))}
          </div>
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.key}>
          <div className="sectionhead">
            {dayTitle(group.key)}
            <span className="pill">{group.items.length}</span>
          </div>
          <div className="tasklist">
            {group.items.map((task) => (
              <UpcomingRow key={task.id} task={task} boardLabel={boardLabel(task.boardId)} />
            ))}
          </div>
        </div>
      ))}

      {completed.length > 0 ? (
        <div>
          <div className="sectionhead">
            <button
              type="button"
              className="btn"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={() => setShowDone((value) => !value)}
            >
              {showDone ? "Hide" : "Show"} completed ({completed.length})
            </button>
          </div>
          {showDone ? (
            <div className="tasklist">
              {completed.map((task) => (
                <UpcomingRow key={task.id} task={task} boardLabel={boardLabel(task.boardId)} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {!overdue.length && !groups.length && !completed.length ? (
        <div className="empty">
          <div className="empty__title">Nothing scheduled</div>
          <p className="hint">Tasks with a due date will appear here, grouped by day.</p>
        </div>
      ) : null}
    </div>
  );
}
